"""大陆投影（大陆计划 v1 只读投影 + v2 主图簇间边）：跨会话概念聚簇与用户连线。

分层不变量（docs/大陆计划.md）：
1. **归属分层**：子图（各会话探索网）拥有簇内边，主图只拥有簇间关系。本模块
   对簇内零写路径；v2 起主图拥有自己的簇间边（KV `continent_edges`），但那也是
   **调用方喂参**——本函数只做校验与合入，仍然无 IO、无模型调用、不改入参；
2. **投影可重算**：聚簇与共享概念只读 knowledge + sessions 推导，可随时重建。
   用户边是主图自有的少量数据，端点失效即降级为 danglingEdges（断桥），由
   前端清理——投影层永远不会因为边悬空而报错。

与 concept.py 的分工与复用：
- concept 管「这个话题的地基是什么」（喂 prompt），本模块管「跨会话的知识版图」（喂画布）；
- 同源检测直接复用其检测器：`_normalize_title` + 标题公共子串（极大公共子串，
  不是整串包含）、`_formula_tokens`（公式 token，经 `knowledge._formula_key`
  归一化——公式键只有一把，前端 `_normalizeFormulaLatex` 不做这层归一化）；
- 功能字过滤沿用 `_STOP_CHARS`（「的定义」这类碎片不是领域词）。

**查空是正常路径**：空库 / 单会话 / 零跨会话重叠时 `shared` 为空、聚簇照常返回，
调用方（前端）渲染「只有一个区域的大陆」而不是报错。宁可漏报不可误报：只报
出现在 ≥2 个会话里的共享概念，同会话内的词面重叠不算。

v4 证据卫生（一条 40 字的推理泄漏标题曾炸出 4 条虚假共享概念，见 docs 大陆计划）：
- **标题来源闸门**：只有 `knowledge._is_concept_like_title` 认的「像概念名」的标题
  才参与子串切分——章节号标题、指令句回显、叙述句、超长句一律不当证据来源；
- **公式 token 黑名单**：`dx`/`dt`/`oint` 这类通用符号不算结构共享（只在本模块剔，
  不动喂 prompt 的 `concept._formula_tokens`）；
- **强弱分级** `strength`：strong 才画到地图上，weak（2 字弱证据与泛后缀）只进清单。

v5.1 边界城市：`links` 与 `owners` 两个字段分工不同、都要有——`links` 给每会话
**一张代表卡**（前端画辐条用），`owners` 给**全部命中卡**（前端「重逢清单」按岛
列出，同岛多卡也照列）。地图怎么画（城市上限 / 每对区域上限 / 无位可放）全在前端
纯函数里，本模块只负责如实报出证据。

v5.3 问 Φ：折叠清单行可把两边条目的「标题+摘要」打包给模型出一句人话判断——
条目行因此携带 `summary`，但只认 model/manual 的真摘要（local 是模板文案，
喂给模型反而误导判断；旧数据无 summarySource 视为 local）。

v5.5 汇聚口径修正（两条都是实测出来的）：
- **广度是加分不是减分**：旧分数 `(60 + 12×字数) / 命中条目数` 里的稀有度惩罚把
  「8 座岛共享的骨干概念」压到「2 座岛的冷门重叠」之下（构造实测：能量守恒定律
  16.5 分 < 角动量守恒定律 72 分），配合 24 条上限，被截掉的往往正是覆盖面最大的
  那条联系。改为**广度乘子** `1 + log2(岛数)`；冷门重叠靠前端既有的「每对区域 3
  座城」配额收敛，不需要全局降权。
- **被更具体标签完全覆盖的标签不单独成城**（`covered` 字段）：8 座岛共享「能量
  守恒定律」+ 2 座岛共享「角动量守恒定律」时，还会长出一个 10 座岛的「量守恒定律」
  ——它是两条长名中间的截断（能|量守恒定律、角动量|守恒定律），不是任何一张卡的
  名字，画成城市没人读得懂。判据只用已有证据、不做语义猜测：某标签的**每一条**命中
  条目，标题里都含有另一个更长的已保留标签 → 这条短标签没带来任何新证据。
  **只标记不删除**：它照旧进折叠清单（原因「已被更具体的城市覆盖」）、照旧算摆位
  亲缘，证据不静默消失。
"""

import itertools
import math
import re
import time

from .concept import (
    _GENERIC_TERMS,
    _STOP_CHARS,
    _TITLE_RUN_MIN_CJK,
    _TITLE_RUN_MIN_LATIN,
    _TITLE_STRONG_MIN,
    _formula_tokens,
    _normalize_title,
)
from .family import (
    BUILTIN_FAMILIES,
    families_from_payload,
    match_families,
    match_family_terms,
    merge_families,
    prepare_families,
)
from .knowledge import _is_concept_like_title, _clean_knowledge_title
from .embedding import cosine as _vec_cosine

__all__ = ["build_continent", "normalize_user_edge_payload"]

# 主图最多画多少条簇间连线：多了是毛线球，按强度取前 N
SHARED_CONCEPT_LIMIT = 24
# 通用符号不算共享证据：任何含微分/积分的公式都带 dx、dt、∂，拿它当「结构共享」会把
# 两张毫不相干的画布连起来（实测 dx 把「梯度的定义与坐标表达」连到「从微元立方体导出
# 直角坐标表达式」）。黑名单只放本模块：concept._formula_tokens 是喂 prompt 的检索器，
# 改它会连带改概念地基的口径。
_GENERIC_FORMULA_TOKENS = {
    "dx", "dy", "dz", "dt", "ds", "dv", "du", "dw", "df", "dg", "dh",
    "oint", "partial", "nabla", "infty", "cdot", "times", "frac", "sqrt",
    "vec", "hat", "bar", "dot", "left", "right", "text", "mathrm", "mathbf",
}
# v5.6 结构证据卫生（两条都不靠不断加长的词表）：
# ① `\text{…}` 装的是**散文**（`\text{const}`、`\text{总}`、`\text{常量}`），剥掉内容再
#    切 token——真机实测它漏出英文填充词 `const`，把「梯度」岛与「能量守恒」岛连成一条
#    虚假的 ∑ 结构共享（用户地图上那条 ∑ const 城市）；顺带解决「同一个意思中英两写法
#    （const vs 常量）永远对不上」的不对称。
_TEXT_GROUP_RE = re.compile(r"\\text\s*\{[^{}]*\}")
_TEX_COMMAND_RE = re.compile(r"\\([A-Za-z]+)")
# ② 公式里出现过的 `\命令名` 一律不作 token：它们绝大多数是**语法**（关系符 `\iff`/
#    `\equiv`/`\implies`、定界符 `\langle`/`\rangle`、逻辑 `\forall`/`\in`、排版
#    `\dfrac`/`\binom`）——concept._TEX_COMMANDS 只列了一部分，实测这批全漏了出来，
#    而任意两条含 `\iff` 的公式都会变成「同源概念」。
#    默认丢弃（fail-safe：新命令默认是噪声），**只放行有区分度的算子命令**——两条都用
#    外积 `\wedge`、都用升指算子 `\sharp` 的公式确实相关，这类是真结构证据，
#    宁可保留少数，也别把语法词当证据。
_KEEP_TEX_OPERATORS = {
    "sharp", "flat", "wedge", "vee", "otimes", "oplus", "odot", "star", "ast",
    "dagger", "pm", "mp", "div", "bigcup", "bigcap", "oint", "nabla", "partial",
}
# 泛后缀（单独立不住的词）：concept._GENERIC_TERMS 之外，本模块再补几个够长但同性质的
# ——「表达式」「坐标系」够 3 字，按长度本该是强证据，其实和「表达」一样立不住
# （真机上「坐标表达」「表达式」正是从章节标题里长出来的碎片）。
_GENERIC_TITLE_TERMS = _GENERIC_TERMS | {"表达式", "坐标系", "示意图"}
# 投影节点字段上限（与 concept.py 的裁剪口径一致）
TITLE_MAX_CHARS = 40
FORMULA_PREVIEW_CHARS = 48
FORMULA_MAX_CHARS = 200   # 供 KaTeX 渲染的原始 TeX，宽松截断只防脏数据
SUMMARY_MAX_CHARS = 80    # v5.3「问 Φ」携带的真摘要上限：判断够用，不撑 payload
# v5.1 每条共享概念带上全部命中条目 id（前端「重逢清单」要按岛列出同岛多卡）；
# 上限只防脏数据撑爆 payload，不影响地图与折叠清单
SHARED_OWNERS_LIMIT = 40
# v2 用户簇间边：字段上限与总量护栏（防脏数据无限生长）
EDGE_LABEL_MAX_CHARS = 40
USER_EDGE_LIMIT = 120

_WEAK_RUN_SCORE = 8.0     # 2 字弱证据（「振动」级）：能当边界证据，排位靠后
_STRONG_RUN_SCORE = 60.0  # ≥3 字实质重叠
_TITLE_LEN_BONUS = 12.0   # 同强度下，字更长 = 更具体
_FORMULA_SCORE = 30.0     # 结构证据：跨会话共享公式 token
_FAMILY_SCORE = 90.0      # v6 概念族：领域知识（内置表或用户/Φ 确认），基分高于窄标题重叠
_FALLBACK_TITLE = "未命名画布"
_DELETED_TITLE = "已删除的画布"

# ===== v7 海域层与 MoE 门控：领域评分核心（softmax 软路由，纯本地现算）=====
# 「专家名单」就是 v6 的概念族表（canonical = 领域名）。评分核心按动工前优化①一次性
# 落地：v7.1a 只有三路**本地**证据（岛名 / 标题术语 / 公式指纹），v7.1b 往同一核心加
# 第四路（模型打标，读 gate KV 产物）——聚合层只建一次，不建「投票」再推翻。
# 铁律「门控只路由不证明」：这里的输出只进 cluster 的 domain* 字段（分区/配色/摆位
# 用），**绝不进 shared**（城市与线仍只由强字面/公式/族表断言）。
GATE_W_ISLAND = 2.0   # 岛名命中：用户/AI 起的短名最能代表主题，且不受标题闸门限制
GATE_W_TITLE = 1.0    # 标题术语命中（×特异度×IDF×独占度）
GATE_W_FORMULA = 0.5  # 公式指纹：弱证据，只在打平时起作用
GATE_W_MODEL = 2.5    # 模型打标（gate KV，×conf）
# v9 向量证据：卡片向量与族中心的余弦超过下限的剩余部分**平方**×倍数换算 logit。
# 下限挡掉「谁都沾点边」的底噪（短中文标题与族中心的余弦普遍 0.4-0.8，全量参与
# 会把 softmax 摊平——实测泊松岛 conf 掉到 0.20 的教训）；平方强调领先者，语义上
# 「明显更亲近」才有票。倍数量级：明显语义拉动 ≈ 一条强标题术语命中——它是补
# 词面盲区的，不许盖过词面/模型/用户证据。
GATE_W_EMBED = 12.0
GATE_EMBED_FLOOR = 0.45
GATE_EMBED_TOPK = 3    # 一张卡的向量证据最多支持几个族：第 4 近之后的族不是证据，
                       # 留着只会给 softmax 灌长尾水（实测 25 族全投，卡方岛 conf 0.06）
GATE_TOP_K = 2        # 一张卡/一座岛最多带几个领域标签
GATE_MIN_P = 0.25     # 概率低于此的次要领域不带（避免「人人都有第二标签」）
GATE_PRIOR_WIDE = 0.8  # 宽领域先验：logit 加 log(0.8)——「宁可选窄的」从 prompt 叮嘱变算法
GATE_WIDE_DOMAINS = frozenset({"微积分", "数学物理方法", "概率统计"})
DOMAIN_LIST_MAX = 32  # 前端「归到哪个领域」菜单的名单上限（防脏数据撑爆 payload）
# 公式指纹表（特征算子 → 领域）。**故意这么小**：token 必须先活着穿过 _structural_tokens
# 的三道卫生（\text 散文、语法命令名、通用符号），能稳定存活的特征算子就这几个
# （grad/curl/div 经 \operatorname 或 \div、wedge/otimes/oplus/oint/sharp 是保留算子、
# ψ 是 _GREEK 真符号）。指纹是打平器不是主证据，宁可少而准，也不写一张「看起来全、
# 命中全是噪声」的大表（默认丢弃是 fail-safe 的同一条纪律）。
_DOMAIN_OPERATOR_HINTS = {
    "矢量分析": frozenset({"grad", "curl", "div", "wedge"}),
    "量子力学": frozenset({"ψ", "sharp"}),
    "复变函数": frozenset({"oint"}),
    "线性代数": frozenset({"oplus", "otimes"}),
}
# 视觉三档的阈值（前端消费，后端如实报概率）：p≥0.7 实色 / 0.4–0.7 淡色+「?」/
# <0.4 中性灰进「待确认」——「不确定也要可见」。
GATE_CONF_SOLID = 0.7
GATE_CONF_LIGHT = 0.4


def gate_version(families: list, weights: dict = None) -> str:
    """门控产物的版本指纹：专家名单或权重表变了，整批 KV 打标作废重打。

    这是 v7.1b 缓存三层里「version 失效比 hash 更重要」的那一环——名单加了领域、
    权重调了参数而缓存不失效的话，地图上会新旧口径混着显示还看不出来。
    """
    import hashlib
    import json
    names = sorted(str(f.get("canonical") or "") for f in (families or []))
    w = dict(weights or {})
    digest = hashlib.md5(
        (json.dumps(names, ensure_ascii=False) + "|" +
         json.dumps(w, sort_keys=True, ensure_ascii=False)).encode("utf-8")
    ).hexdigest()
    return digest[:10]


def _gate_weights() -> dict:
    """评分核心的权重快照（进 gateVersion；调权重必须让缓存失效，见 gate_version）。"""
    return {"island": GATE_W_ISLAND, "title": GATE_W_TITLE, "formula": GATE_W_FORMULA,
            "model": GATE_W_MODEL, "prior_wide": GATE_PRIOR_WIDE,
            "embed": GATE_W_EMBED, "embed_floor": GATE_EMBED_FLOOR,
            "embed_topk": GATE_EMBED_TOPK,
            "wide": sorted(GATE_WIDE_DOMAINS)}


def current_gate_version(families_payload=None) -> str:
    """当前口径的 gateVersion（build_continent 与测试共用这一把——两处各算一份必然漂）。"""
    accepted = merge_families(BUILTIN_FAMILIES, families_from_payload(families_payload))
    return gate_version(accepted, _gate_weights())


def _breadth(island_count: int) -> float:
    """广度乘子：跨岛越多，这条联系越重要（v5.5）。

    v5.5 之前 title 路线用 `/ 命中条目数` 做稀有度惩罚，结果是**骨干概念被冷门重叠
    压下去**（实测：8 座岛共享的「能量守恒定律」16.5 分 < 2 座岛共享的「角动量守恒
    定律」72 分）。稀有度惩罚的初衷是「别让『运动』这种人人共用的泛词靠长度取胜」，
    但泛词已经由 `_GENERIC_TITLE_TERMS` 与 weak 分级挡掉了，不需要再叠一层降权。
    冷门重叠由前端「每对区域最多 3 座城」的局部配额收敛——这是配额该干的事。
    """
    return 1.0 + math.log2(max(1, int(island_count or 1)))


def _title_score(label: str, strength: str, island_count: int) -> float:
    """title 路线的证据分：强度与字数定基分，广度定倍数（两条路线都以广度为先）。"""
    base = (_STRONG_RUN_SCORE + _TITLE_LEN_BONUS * len(label)) if strength == "strong" \
        else _WEAK_RUN_SCORE
    return round(base * _breadth(island_count), 2)


def _session_title_index(sessions: dict) -> dict:
    """`sess_xxx` 与 `phymathia_xxx` 两种标识都能查到会话记录（knowledge 条目的
    sessionId 是 sess_xxx，与会话文件键同形，两种都收只是兜底）。"""
    index = {}
    for key, sess in (sessions or {}).items():
        if not isinstance(sess, dict):
            continue
        index[str(key)] = sess
        sid = str(sess.get("sessionId") or "")
        if sid:
            index[sid] = sess
    return index


def _clip(text: str, limit: int) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[:limit] + "…"


def _item_row(item_id: str, item: dict) -> dict:
    formulas = item.get("formulas") or []
    preview = ""
    for f in formulas:
        if str(f or "").strip():
            preview = str(f)
            break
    # v5.3「问 Φ」的判断素材：只带 model/manual 的真摘要——local 是模板文案
    # （与概念地基「摘要只认 model/manual」同一口径），喂给模型反而误导判断；
    # 旧数据无 summarySource 字段视为 local。
    summary = str(item.get("summary") or "").strip()
    if (item.get("summarySource") or "local") not in ("manual", "model"):
        summary = ""
    return {
        "itemId": str(item_id),
        "title": _clip(item.get("title"), TITLE_MAX_CHARS),
        # formula 供 KaTeX 渲染（宽松截断防脏数据撑爆 payload，不带省略号——
        # 截断的 TeX 渲染失败会走前端纯文本回退）；formulaPreview 是文本兜底展示
        "formula": str(preview)[:FORMULA_MAX_CHARS],
        "formulaPreview": _clip(preview, FORMULA_PREVIEW_CHARS),
        "formulaCount": len(formulas),
        "category": str(item.get("category") or ""),
        "createdAt": item.get("createdAt") or 0,
        "summary": _clip(summary, SUMMARY_MAX_CHARS),
    }


def _cluster_title(sid: str, title_index: dict, has_sessions: bool) -> str:
    sess = title_index.get(sid) or {}
    title = str(sess.get("title") or "").strip()
    if title:
        return title
    if sid and has_sessions and sid not in title_index:
        return _DELETED_TITLE
    return _FALLBACK_TITLE


def _cross_session_owners(owner_map: dict, item_session: dict) -> list:
    """owner_map 的值（条目集合）里挑出跨 ≥2 个会话的，返回 [(key, owners)]。"""
    out = []
    for key, owners in owner_map.items():
        sids = {item_session[iid] for iid in owners if iid in item_session}
        if len(sids) >= 2:
            out.append((key, owners, sids))
    return out


def _collapse_fragments(entries: list) -> list:
    """标题串收敛到极大公共子串：短串若被更长的串包含、且覆盖条目是其子集，
    就是碎片（「谐运动」⊂「简谐运动」），丢弃。"""
    entries = sorted(entries, key=lambda e: -len(e[0]))
    kept = []
    for label, owners, sids in entries:
        if any(label != other[0] and label in other[0] and owners <= other[1]
               for other in kept):
            continue
        kept.append((label, owners, sids))
    return kept


def _mark_covered_labels(entries: list) -> set:
    """哪些标签的证据已被「更具体的标签」完全覆盖（v5.5，重复城市修复）。

    现场：8 座岛共享「能量守恒定律」、2 座岛共享「角动量守恒定律」时，还会多出一个
    10 座岛的标签「量守恒定律」——它是两条长名中间的截断（能|量守恒定律、角动量|
    守恒定律），不是任何一张卡的名字，画成城市没人读得懂；而它命中的 10 张卡**每一张**
    都已被更具体的标签覆盖，等于没带来任何新证据。

    判据只用已有证据、不做语义猜测：某标签的每一条命中条目，其标题里都含有另一个更长
    的已保留标签 → 标记为 covered。**标记不是删除**：条目照旧返回（前端把它折叠进清单、
    照旧算摆位亲缘），只是不单独占一座城市——证据不静默消失。

    反例保护（为什么不能只看「被包含」）：只有「阻尼振动」与「受迫振动」跨会话共享时，
    「振动」也是它们的子串，但「阻尼振动」「受迫振动」本身**不是**跨会话共享概念
    （各只在一座岛出现），进不了 kept → 「振动」不算 covered，照旧作为跨岛家族证据
    参与摆位。同理，「拉普拉斯」被「拉普拉斯算子」覆盖时，只要还有一条命中条目的标题
    不含更具体标签（如「拉普拉斯方程」），它就必须照旧独立成城。

    实现：条目 M 的 `owners` 定义就是「标题里含 M 的条目」——所以「某条目的标题含某个
    更长的已保留标签」等价于「该条目 ∈ 某个更长标签的 owners」。按长度降序扫一遍、
    把已处理标签的 owners 并进 `covered_items` 集合，判定退化成集合包含（O(命中数)，
    不是标签×命中×已保留的三重循环——大库上那会慢得没法用）。
    """
    covered = set()
    covered_items = set()
    for label, owners, _sids in sorted(entries, key=lambda e: -len(e[0])):
        if owners and set(owners) <= covered_items:
            covered.add(label)
        covered_items |= set(owners)
    return covered


def _structural_tokens(item: dict) -> set:
    """条目的**结构 token**（大陆专用，比喂 prompt 的口径更严）：拿公式当结构证据前，
    先剥散文、再剔语法命令名。两条见 `_TEXT_GROUP_RE` / `_KEEP_TEX_OPERATORS` 的注释。

    只在本模块收紧——concept._formula_tokens 是喂 prompt 的检索器（宁可多召回），
    本模块决定「够不够在地图上画一条结构共享」，标准只会更严不会更松。
    """
    formulas = [str(f or "") for f in (item.get("formulas") or [])]
    if not formulas:
        return set()
    commands = set()
    prose_free = []
    for latex in formulas:
        commands |= {c.lower() for c in _TEX_COMMAND_RE.findall(latex)}
        prose_free.append(_TEXT_GROUP_RE.sub("", latex))
    try:
        tokens = _formula_tokens({"formulas": prose_free})
    except Exception:
        # 切 token 失败不该把整条投影打成 500：退回原公式（宁可有噪声，也不丢岛屿）
        tokens = _formula_tokens(item)
    return {t for t in tokens
            if t not in commands or t in _KEEP_TEX_OPERATORS}


def _links_for(owners: set, item_session: dict, session_rank: dict) -> list:
    """共享概念在簇间怎么连线：每个会话取排序最前的条目作端点；会话对 ≤4 个时
    全连接，否则连成链（防一处共享炸出毛线球）。"""
    by_session = {}
    for iid in owners:
        by_session.setdefault(item_session[iid], []).append(iid)
    for sid in by_session:
        by_session[sid].sort(key=lambda iid: session_rank.get(iid, 0))
    # 会话间按「各自最早一张卡」排：上两行刚把每会话的卡按学习序排好，取 [0]
    # 即代表卡（此前误用 min() 取字典序最小 id，与学习序脱节——09-20 修复）
    sids = sorted(by_session, key=lambda s: session_rank.get(by_session[s][0], 0))
    pairs = (itertools.combinations(sids, 2) if len(sids) <= 4
             else zip(sids, sids[1:]))
    return [{"from": by_session[a][0], "to": by_session[b][0],
             "fromSession": a, "toSession": b} for a, b in pairs]


def _num_or_zero(raw) -> float:
    """任意时间戳/数值字段的数值兜底：真机存量数据里混有字符串时间戳与坏值。

    排序键一旦混用 int/str 就抛 TypeError，会把整条 /api/continent 打成 500——
    投影层对脏数据的立场是「照常返回，别报错」（createdAt/updatedAt 都用它）。"""
    try:
        return float(raw or 0)
    except (TypeError, ValueError):
        return 0.0


def _created_rank(item) -> float:
    return _num_or_zero((item or {}).get("createdAt"))


def _owner_ids(owners: set, items: dict) -> list:
    """v5.1：命中的**全部**条目 id，按学习顺序（createdAt 升序，同刻按 id 稳定）排。

    links 只给每会话一张代表卡（画图用），owners 给全部命中卡——前端「重逢清单」
    要按岛分组、把同岛的多张卡也列出来（词面命中是事实，不该被代表卡口径吞掉）。
    簇内条目本就按 createdAt 排，所以这个全局序在**每个会话内部**就是学习顺序。
    """
    return sorted(owners, key=lambda iid: (_created_rank(items.get(iid)), iid))[
        :SHARED_OWNERS_LIMIT]


def _shared_strength(kind: str, label: str) -> str:
    """证据分级：strong 才画到地图上，weak 只进清单（弹层里照报）。

    与 concept.py 的 `_TITLE_STRONG_MIN` / `_GENERIC_TERMS` 同一把尺子，但标准只会更严
    不会更松：那边判「够不够当检索理由」，这边判「够不够占地图视觉」。2 字串（「表达」
    「坐标」）与泛后缀（「表达」「定义」）单独立不住，只能折叠进清单。
    """
    if kind == "formula":
        return "strong"
    if len(label) >= _TITLE_STRONG_MIN and label not in _GENERIC_TITLE_TERMS:
        return "strong"
    return "weak"


def normalize_user_edge_payload(raw) -> list:
    """KV `continent_edges` 里存的原始值可能是裸数组或 {edges:[...]} 包装，两种都收；
    返回原始 dict 列表（不做端点校验——校验要投影数据，见 _split_user_edges）。"""
    if isinstance(raw, dict):
        raw = raw.get("edges")
    if not isinstance(raw, list):
        return []
    return [e for e in raw if isinstance(e, dict)]


# v7.2 航线样式的白名单（旧边无 style 走前端默认；未知键丢弃，防脏数据撑爆 KV）
_EDGE_STYLE_KEYS = ("dash", "color", "width", "route", "hidden", "noLabel")


def _norm_edge_style(raw) -> dict:
    """边上的可选样式（v7.2 单条可调）：只收白名单键，值裁剪成短字符串/布尔。"""
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key in _EDGE_STYLE_KEYS:
        if key not in raw:
            continue
        val = raw[key]
        if key in ("hidden", "noLabel"):
            if val:
                out[key] = True
        else:
            s = str(val or "").strip()
            if s and len(s) <= 12:
                out[key] = s
    return out


def _split_user_edges(raw_edges: list, item_session: dict):
    """用户簇间边按当前投影校验：两端条目都在、且分属不同会话 → userEdges；
    任一端已不在投影（会话清空/条目删除）→ danglingEdges（断桥，missing 标注
    哪端悬空，供前端渲染与清理）。端点会话以 item_session 现算为准——条目搬家
    （换会话）后旧值不作数。同端点对去重，保留 createdAt 最新一条。"""
    def _norm(edge):
        return {
            "id": str(edge.get("id") or "").strip(),
            "fromItem": str(edge.get("fromItem") or "").strip(),
            "toItem": str(edge.get("toItem") or "").strip(),
            # 原会话串只作悬空边的展示/残线定位参考；有效边的会话一律以
            # item_session 现算覆盖（条目搬家后旧值不作数）
            "fromSession": str(edge.get("fromSession") or "").strip(),
            "toSession": str(edge.get("toSession") or "").strip(),
            "label": _clip(edge.get("label"), EDGE_LABEL_MAX_CHARS),
            # v7.2：单条样式（线型/颜色/粗细/走线/隐藏/无标签）随边存取——
            # 白名单清洗，旧边无此字段就是默认样式，零迁移
            "style": _norm_edge_style(edge.get("style")),
            "createdAt": edge.get("createdAt") or 0,
        }

    seen_pair = {}
    for edge in sorted(raw_edges, key=lambda e: -_created_rank(e)):
        e = _norm(edge)
        if not e["id"] or not e["fromItem"] or not e["toItem"]:
            continue
        if e["fromItem"] == e["toItem"]:
            continue  # 自环不是簇间边
        pair = frozenset((e["fromItem"], e["toItem"]))
        if pair in seen_pair:
            continue  # 同端点对只留 createdAt 最新的一条
        from_ok = e["fromItem"] in item_session
        to_ok = e["toItem"] in item_session
        if from_ok and to_ok and item_session[e["fromItem"]] != item_session[e["toItem"]]:
            row = dict(e)
            row["fromSession"] = item_session[e["fromItem"]]
            row["toSession"] = item_session[e["toItem"]]
            seen_pair[pair] = ("valid", row)
        else:
            # missing=from/to/both：端点条目已不在投影；same_session：两端都在但
            # 同会话（不是簇间边）——都走断桥通道，前端只渲染 from/to/both 的残线
            if not from_ok and not to_ok:
                missing = "both"
            elif not from_ok:
                missing = "from"
            elif not to_ok:
                missing = "to"
            else:
                missing = "same_session"
            row = dict(e)
            row["missing"] = missing
            seen_pair[pair] = ("dangling", row)

    valid, dangling = [], []
    for kind, row in seen_pair.values():
        (valid if kind == "valid" else dangling).append(row)
    valid = valid[:USER_EDGE_LIMIT]
    return valid, dangling


def _session_pairs(sids) -> set:
    """会话集合 → 无序对集合（判断「族是否只是精确标签的重复」用）。"""
    ordered = sorted({str(x) for x in (sids or []) if str(x)})
    return {frozenset(pair) for pair in itertools.combinations(ordered, 2)}


def _mark_families_covered(family_entries: list, specific_entries: list) -> None:
    """族条目是否「已被更精确的共享概念完全覆盖」（就地改 covered 字段）。

    判据：族连接的**每一对岛**都已经被某个 strong 的精确条目（title/formula）连上——
    此时族没带来任何新联系，画上去就是同一件事的第二座城。weak 条目不算覆盖
    （它们本来就不上图）。只标记不删除：族照旧进折叠清单、照旧参与摆位亲缘。
    """
    covered_pairs = set()
    for entry in (specific_entries or []):
        if entry.get("kind") == "family" or entry.get("strength") != "strong":
            continue
        covered_pairs |= _session_pairs(entry.get("sessions"))
    for entry in (family_entries or []):
        pairs = _session_pairs(entry.get("sessions"))
        entry["covered"] = bool(pairs) and pairs <= covered_pairs


def _item_families(items: dict, prepared: list) -> tuple:
    """每张卡片 → 它属于哪些族（**每张卡只匹配一次**，返回明细给评分核心用）。

    这里是性能红线：投影每次打开大陆都会跑一遍全库，把匹配放进「族 × 卡」双层循环里
    就是 25 倍冗余，实测 600 条从几十毫秒涨到 1.7 秒（cProfile 抓到 420 万次
    `str.lower`）。所以「哪张卡属于哪些族」在这里一次性算好，后面按族分组只是查集合。

    卡片标题先过概念名闸门（与共享概念同一把尺子）：章节号标题、指令句回显、叙述句不当
    族证据——推理泄漏卡曾靠长句把整座岛拖进族里（v4 的老账）。

    v7 起返回三元组 `(mapping, term_df, n_scored)`：mapping[iid] = {族名: [命中术语]}
    （`_family_entries` 的 `canonical in mapping[iid]` 仍是键判断，行为不变）；
    term_df 是「术语 → 命中卡数」（IDF 用）；n_scored 是过了闸门的卡数（IDF 的分母）。
    """
    mapping, term_df, n_scored = {}, {}, 0
    for item_id, item in items.items():
        if not isinstance(item, dict):
            continue
        if not _is_concept_like_title(item.get("title")):
            continue
        n_scored += 1
        iid = str(item_id)  # 与投影行 itemId 同形（脏数据里可能有非字符串键）
        hits = match_family_terms(_normalize_title(item.get("title")), prepared)
        if hits:
            mapping[iid] = hits
            for terms in hits.values():
                for t in terms:
                    term_df[t] = term_df.get(t, 0) + 1
    return mapping, term_df, n_scored


def _term_family_counts(prepared: list) -> dict:
    """术语 → 同属几个族（独占度用：「中心极限」只属概率统计＝1，「极限」跨族→衰减）。"""
    counts = {}
    for fam in (prepared or []):
        for t in list(fam["cjk"]) + list(fam["ascii"]):
            counts[t] = counts.get(t, 0) + 1
    return counts


# ===== v10 语义找亲（第一期·补词）：向量给族表查漏，用户确认落笔 =====
# 泊松岛那类事故的病根不是「卡没归对」，是**族表漏词**：卡对「概率统计」的余弦很高、
# 标题里却没有一个族术语 → 词面永远接不上。这里把这类卡找出来，建议用户把标题词条
# 收进族表 KV（continent_families）——机器只建议不落笔（铁律），收下后词条命中是
# 本地证据，下次投影自动把同类卡拉进正确海域，汇聚从此积累。

FAMILY_SUGGEST_MARGIN = 0.05   # 与次高族的余弦差至少这么大：双族暧昧的卡不配当证据
FAMILY_SUGGEST_MAX = 12        # 一轮最多给用户看几条（再多就是刷屏，先修证据多的）
FAMILY_SUGGEST_REGROW = 2      # 被拒过的建议，证据再长出这么多张卡才重新开口


def _suggest_term_from_title(title, prepared, existing_terms, canon_names, target_domain):
    """从卡片标题提炼「值得进族表的词条」；提炼不出返回 None（宁可漏报不可误报）。

    口径与 `_item_families` 同一把尺子：清洗（剥模块尾巴）→ 取「主题：副题」的
    主题段 → 归一（含译名）→ 必须像概念名 → 不与任何现有术语/族名撞车 →
    词面上不许误伤其他族（「概率积分变换」含「积分」会把未来的卡拉向微积分，
    正是均匀分布岛那次误伤的配方——这种词永远不进表）。
    """
    s = _clean_knowledge_title(str(title or ""))
    # 分隔符在归一化之前切（_normalize_title 会剥全部标点，切不出主题段了）
    head = re.split(r"[：:|｜—－]+", s, maxsplit=1)[0].strip()
    if len(head) < 2:
        head = s.strip()
    term = _normalize_title(head)
    if len(term) < 2:
        return None
    if not _is_concept_like_title(term):
        return None
    # 建议词条比内置表更严一道：内置表是人工写好、pytest 逐条扫过的；机器提议的
    # 词条没有人把关，功能字碎片（「动的」「与线」）与裸泛词（「变换」）必须挡住——
    # 真术语（泊松分布/测量误差）里不会有这些字
    if any(ch in _STOP_CHARS for ch in term) or term in _GENERIC_TERMS:
        return None
    if term in existing_terms or term in canon_names:
        return None
    hit_domains = set(match_families(term, prepared))
    if hit_domains - {target_domain}:
        return None
    return term[:24]


def family_term_suggestions(items, families, card_sims, rejected=None) -> list:
    """补词建议（v10 第一期，纯函数）：词面零命中、气味却明确指向某族的卡 →
    建议把它的标题词条收进该族。

    判据三条（都是几何/词面，不调模型）：① 词面零命中（`_item_families` 认不出它）；
    ② 对某族的余弦过 GATE_EMBED_FLOOR 且与次高族差 ≥ FAMILY_SUGGEST_MARGIN；
    ③ 标题能提炼出过卫生闸门的词条（`_suggest_term_from_title`）。
    `rejected` 是 KV 里的拒绝记录 {族: {词条: {cards, at}}}：证据没长出来就闭嘴
    （防骚扰），长出 FAMILY_SUGGEST_REGROW 张新卡才重新开口（regrown=True）。
    调用方喂参（items/families/card_sims 与投影同一份），本函数无 IO、无模型调用。
    """
    prepared = prepare_families(families or [])
    if not prepared:
        return []
    existing_terms, canon_names = set(), set()
    for f in prepared:
        canon_names.add(f["canonical"])
        existing_terms.update(f["cjk"])
        existing_terms.update(f["ascii"])
    # 每张卡只跑一次词面匹配（v6 性能红线同款纪律，O(卡) 不是 O(卡×族)）
    lex_map, _, _ = _item_families(items, prepared)
    groups = {}
    for item_id, item in (items or {}).items():
        if not isinstance(item, dict) or lex_map.get(str(item_id)):
            continue
        ranked = sorted(
            ((d, s) for d, s in ((card_sims or {}).get(str(item_id)) or {}).items()
             if s > 0 and d in canon_names),
            key=lambda kv: (-kv[1], kv[0]))
        if not ranked:
            continue
        top_domain, top_sim = ranked[0]
        if top_sim < GATE_EMBED_FLOOR:
            continue
        if len(ranked) > 1 and top_sim - ranked[1][1] < FAMILY_SUGGEST_MARGIN:
            continue
        term = _suggest_term_from_title(item.get("title"), prepared,
                                        existing_terms, canon_names, top_domain)
        if not term:
            continue
        key = (top_domain, term)
        entry = groups.setdefault(
            key, {"family": top_domain, "term": term, "sim": 0.0, "cards": []})
        entry["cards"].append({"id": str(item_id), "title": str(item.get("title") or "")[:48]})
        entry["sim"] = max(entry["sim"], round(float(top_sim), 3))
    results = []
    rej = rejected if isinstance(rejected, dict) else {}
    # 排序：证据多的在前（收下一词救一片卡），再按相似度、词条稳定排序；
    # 压制判断在截断**之前**——被拒的建议不占名额，长出来的新证据才顶得上来
    for g in sorted(groups.values(),
                    key=lambda g: (-len(g["cards"]), -g["sim"], g["term"])):
        if len(results) >= FAMILY_SUGGEST_MAX:
            break
        old = rej.get(g["family"])
        old = old.get(g["term"]) if isinstance(old, dict) else None
        if old and len(g["cards"]) <= int(old.get("cards") or 0) + FAMILY_SUGGEST_REGROW:
            continue
        out = dict(g)
        out["regrown"] = bool(old)
        results.append(out)
    return results


def _term_specificity(term: str) -> float:
    """术语特异度：min(1, 权重字数/4)——中文 1 字记 1、ASCII 2 字符记 1（`nabla`≈2.5）。
    「振动」这类 2 字领域词是中文数理术语的主力形态，0.5 的特异度让它能参与评分，
    但压不过「简谐运动」这种 4 字实质术语。"""
    units = 0.0
    for ch in str(term or ""):
        units += 1.0 if ord(ch) > 127 else 0.5
    return min(1.0, units / 4.0)


def _normalize_gate_payload(raw, accepted_names: set, version: str) -> dict:
    """KV `continent_gate` 的原始值 → {itemId: {name: conf}}。

    只认名单内的领域名（铁律②：模型不许自由发明领域——`new` 建议走折叠清单，不进
    产物）；conf 夹在 [0,1]；**version 对不上整批作废**（名单/权重变了旧口径不能混着
    显示）。脏数据照常返回空，不报错。
    """
    if not isinstance(raw, dict):
        return {}
    if version and str(raw.get("version") or "") != version:
        return {}
    entries = raw.get("entries")
    if not isinstance(entries, dict):
        return {}
    out = {}
    for iid, row in entries.items():
        if not isinstance(row, dict):
            continue
        labels = row.get("domains")
        if not isinstance(labels, list):
            continue
        labels_out = {}
        for lab in labels[:GATE_TOP_K]:
            if not isinstance(lab, dict):
                continue
            name = str(lab.get("name") or "").strip()
            if name not in accepted_names:
                continue
            try:
                conf = min(1.0, max(0.0, float(lab.get("conf"))))
            except (TypeError, ValueError):
                conf = 0.0
            if conf > 0:
                labels_out[name] = conf
        if labels_out:
            out[str(iid)] = labels_out
    return out


def _embed_pull(sims):
    """{领域: 余弦} → {领域: logit 拉动}（v9 向量证据的换算尺子）。

    线性换算：下限挡掉「谁都沾点边」的底噪，超过下限的剩余部分 ×倍数；再取
    top-K——一张卡只可能「明显亲近」两三个族，第 4 名开外的余弦不是证据，
    全量参与只会给 softmax 灌长尾水。倍数取「明显语义拉动 ≈ 一条强标题术语
    命中」的量级——它是补词面盲区的，不许盖过词面/模型/用户证据。试过的弃案：
    平方强调领先者（拉动小到被宽领域先验 -0.22 压成负数、被公式指纹 0.5 翻盘，
    卡方岛实测翻成矢量分析）。
    """
    above = sorted(((s, d) for d, s in (sims or {}).items() if s > GATE_EMBED_FLOOR),
                   reverse=True)
    return {d: GATE_W_EMBED * (s - GATE_EMBED_FLOOR)
            for s, d in above[:GATE_EMBED_TOPK]}


def _gate_card_scores(hits, struct_tokens, gate_labels, term_df, n_scored, term_k,
                      embed_sims=None):
    """一张卡的领域 logits（六路证据：五路里三路本地 + 模型 + v9 向量；用户覆盖在前端短路）。

    标题术语：Σ 特异度×IDF×独占度（IDF＝log(1 + 卡数/含该术语的卡数)——「振动」
    出现在 30% 的卡上时就该贬值；独占度＝1/k，术语同属 k 个族即衰减）。公式指纹：
    特征算子命中即 +0.5（打平器）。模型打标：+2.5×conf。向量（v9）：卡片向量与族
    中心的余弦超过下限的剩余部分 ×倍数——词面认不出的卡（「泊松分布」不在族术语
    表、标题是「测量误差：平方和的统计本性」的卡方岛）也能被路由进正确海域；低于
    下限一律不投（宁可无证据也不投噪声票）。宽领域先验：+log(0.8)。
    """
    scores = {}
    for domain, terms in (hits or {}).items():
        s = 0.0
        for t in terms:
            idf = math.log(1.0 + n_scored / max(1, term_df.get(t, 1)))
            s += _term_specificity(t) * idf * (1.0 / max(1, term_k.get(t, 1)))
        if s > 0:
            scores[domain] = scores.get(domain, 0.0) + GATE_W_TITLE * s
    for name, conf in (gate_labels or {}).items():
        scores[name] = scores.get(name, 0.0) + GATE_W_MODEL * conf
    # 宽领域先验只压**词面/模型**证据：那是「枚举式命中天然偏爱宽族」的校正；
    # 向量证据的特异性已经由「与全部族中心的对比」编码，再罚一次宽族会把
    # 微弱但正确的语义证据压成负数（实测卡方岛唯一证据 0.116 被 -0.22 压死，
    # 翻成公式指纹都碰不到的矢量分析——比不归类更糟）
    lexical_model = dict(scores)
    # 向量证据与标题/模型同是"主动证据"：可以单独撑起一张卡的 logits（这正是
    # 它存在的意义——词面零命中的卡）
    for domain, pull in _embed_pull(embed_sims).items():
        scores[domain] = scores.get(domain, 0.0) + pull
    # 公式指纹是**打平器**：只有这张卡已有词面/模型证据时才参与（0.5 的弱证据
    # 单独定归属，会让一座岛凭一个 ∇ 就上实色——比「不归类」更糟；向量剩一小截
    # +一个 ∇ 定归属是同一个错误，基底同样不含向量证据）
    if lexical_model and struct_tokens:
        for domain, ops in _DOMAIN_OPERATOR_HINTS.items():
            if ops & struct_tokens:
                scores[domain] = scores.get(domain, 0.0) + GATE_W_FORMULA
    for domain in GATE_WIDE_DOMAINS:
        if domain in lexical_model:
            scores[domain] += math.log(GATE_PRIOR_WIDE)
    return scores


def _softmax(scores: dict) -> dict:
    """softmax(logit/T)，T=1。空表返回空（不参与，而不是均匀分给所有领域）。"""
    if not scores:
        return {}
    mx = max(scores.values())
    exps = {d: math.exp(v - mx) for d, v in scores.items()}
    total = sum(exps.values()) or 1.0
    return {d: e / total for d, e in exps.items()}


def _cluster_domain_row(iids, items, card_probs, card_probs_local, island_fams):
    """岛级归属＝卡级概率聚合（不是数票）：raw_d = Σ_c 信息量(c)·p_d(c) + 2.0·岛名命中。
    信息量用 1 + min(3, 公式数)——带公式的卡内容更多，说话更算数；章节号标题的卡
    没有本地证据，贡献为零（岛名兜底）。归一化后输出 top-K 概率与「谁说了算」。

    domainSource 归属（图例据此标「按概念族推断 / Φ 归类 / 你指定」）：对有打标的卡
    另算一份**只含本地证据**的概率（card_probs_local），对比主导领域的岛级质量——
    没有模型证据时它连主导领域都撑不起（质量不到一半、或根本为零）→ 'gate'；
    否则岛名贡献 ＞ 卡片贡献 → 'island'，其余 → 'vote'。直接比「conf 与 p」不行：
    模型是唯一证据时 p≡1.0 恒大于 conf，永远判不成 gate。
    """
    raw, raw_local = {}, {}
    vote_contrib, island_contrib = {}, {}
    for iid in iids:
        formulas = (items.get(iid) or {}).get("formulas") or []
        info = 1.0 + min(3, len(formulas))
        probs = card_probs.get(iid)
        if probs:
            for d, p in probs.items():
                raw[d] = raw.get(d, 0.0) + info * p
                vote_contrib[d] = vote_contrib.get(d, 0.0) + info * p
        probs_local = card_probs_local.get(iid)
        if probs_local:
            for d, p in probs_local.items():
                raw_local[d] = raw_local.get(d, 0.0) + info * p
    for d in (island_fams or []):
        raw[d] = raw.get(d, 0.0) + GATE_W_ISLAND
        raw_local[d] = raw_local.get(d, 0.0) + GATE_W_ISLAND
        island_contrib[d] = island_contrib.get(d, 0.0) + GATE_W_ISLAND
    if not raw:
        return {"domain": None, "domains": [], "domainConf": 0.0, "domainSource": None}
    total = sum(raw.values()) or 1.0
    ranked = sorted(raw.items(), key=lambda kv: (-kv[1], kv[0]))
    top_name = ranked[0][0]
    if raw_local.get(top_name, 0.0) < 0.5 * raw[top_name]:
        src = "gate"
    elif island_contrib.get(top_name, 0.0) > vote_contrib.get(top_name, 0.0):
        src = "island"
    else:
        src = "vote"
    domains = [{"name": d, "p": round(v / total, 3)}
               for d, v in ranked[:GATE_TOP_K] if v / total >= GATE_MIN_P]
    return {"domain": top_name, "domains": domains,
            "domainConf": round(ranked[0][1] / total, 3), "domainSource": src}


def _family_entries(items: dict, clusters: list, item_session: dict, session_rank: dict,
                    families: list, prepared: list, item_families: dict,
                    session_fams: dict) -> list:
    """概念族 → 跨岛汇聚条目（kind=family，v6）。

    与「字面撞车」的本质区别：族是**领域知识**（内置表 / 用户确认 / Φ 归并），所以
    `梯度`+`散度`+`旋度` 这类只共享 2 字的关系能作为一族被画出来，而不会退化成
    「弱证据」躺在折叠清单里。

    证据两个来源，都只看**标题**（卡片名 + 岛名）：卡片标题命中 → 该卡入族；岛名命中
    （如岛叫「散度」而卡名是章节号）→ 整座岛以**岛内最早学的卡**为代表入族。两处都
    要求跨 ≥2 座岛才成条目——单岛命中只是这座岛的主题，不是跨画布联系。
    **岛名不受概念名闸门**：那是用户/AI 起的短名（「散度」），不是自动生成的卡片标题。
    session_fams 由调用方算好传入（v7 海域层同用一份，不重复匹配）。
    """
    if not families:
        return []
    entries = []
    for fam in families:
        canonical = fam["canonical"]
        reps = []            # 每座岛一张代表卡（画辐条用）
        owners = []          # 全部按标题命中的卡（重逢清单列全）
        for cluster in clusters:
            sid = cluster["sessionId"]
            iids = [row["itemId"] for row in cluster["items"]]
            hit = [iid for iid in iids if canonical in item_families.get(iid, ())]
            if hit:
                owners.extend(hit)
                reps.append((sid, hit[0]))          # 岛内最早学的命中卡
            elif canonical in session_fams.get(sid, ()):
                if iids:
                    reps.append((sid, iids[0]))     # 岛名命中：以岛内最早学的卡为代表
                    owners.append(iids[0])
        sids = {sid for sid, _iid in reps}
        if len(sids) < 2:
            continue
        rep_ids = {iid for _sid, iid in reps}
        entries.append({
            "kind": "family", "label": canonical,
            "score": round(_FAMILY_SCORE * _breadth(len(sids)), 2),
            "strength": "strong",
            "covered": False,
            "source": fam.get("source") or "builtin",
            "sessions": sorted(sids),
            "owners": _owner_ids(owners or rep_ids, items),
            "links": _links_for(rep_ids, item_session, session_rank),
        })
    return entries


def build_continent(items: dict, sessions: dict = None, user_edges=None,
                    families=None, gate=None, card_sims=None) -> dict:
    """从知识条目推导大陆投影。纯函数：无 IO、无模型调用、不修改入参。

    card_sims（v9 向量证据，调用方喂参）：{itemId: {领域名: 余弦相似度}}——
    卡片向量与概念族向量中心的余弦，由路由层用本地模型算好（有缓存）传入；
    本函数不加载模型、不读缓存文件。缺省/空表 = 向量证据关闭，投影与 v8 逐字一致。

    返回 {generatedAt, clusterCount, itemCount, orphans, clusters, shared,
    userEdges, danglingEdges, domainList}：
    - clusters: 每个有知识条目的会话一个簇，按会话最近更新排序；簇内条目按
      createdAt 升序（学习顺序）；v7 起每簇带 domain / domains / domainConf /
      domainSource（海域层归属，见 _cluster_domain_row——查空是正常路径，无归属为 null）；
    - shared: 跨会话共享概念（kind=title 公共子串 / kind=formula 公式 token），
      分数以**广度**为先（跨岛越多越靠前，v5.5），取前 SHARED_CONCEPT_LIMIT 条；
      每条带 links（每会话一张代表卡的端点，画图用）、owners（全部命中条目 id，
      v5.1 重逢清单列同岛多卡用）与 covered（v5.5：证据被更具体的标签完全覆盖，
      前端折叠它、不单独成城——条目仍照报，不静默消失）；
    - userEdges / danglingEdges（v2）：用户在主图上画的簇间边，经当前投影校验；
      悬空边（端点条目已不在）单列，前端渲染断桥并提供清理入口；
    - families（v6）：概念族条目（kind=family）与标题/公式共享**同一条 shared 通道**——
      族是领域知识（内置表 + KV 扩展），所以「只共享 2 字领域词」的真关系（梯度/散度/
      旋度）也能成城；已被更精确标签连上的岛对会把族城折进清单（_mark_families_covered，
      同一件事不画两座城）；
    - domainList（v7）：全部领域名（族表 canonical，含 KV 扩展）——前端「归到哪个
      领域」菜单的名单来源；gate 是 KV `continent_gate` 的原始值（v7.1b Φ 打标产物，
      版本不符整批忽略）。
    """
    title_index = _session_title_index(sessions)

    # ===== 聚簇：按条目 sessionId 分组（sessionId 为空的孤儿条目不入大陆） =====
    by_session = {}
    item_session = {}
    orphans = 0
    for item_id, item in (items or {}).items():
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        sid = str(item.get("sessionId") or "")
        if not title or not sid:
            orphans += 1
            continue
        iid = str(item_id)
        by_session.setdefault(sid, []).append(iid)
        item_session[iid] = sid

    # 簇排序：会话最近更新在前；条目排序：学习顺序（createdAt 升序）
    def _cluster_sort_key(sid):
        sess = title_index.get(sid) or {}
        # updatedAt 同样要数值兜底：POST /api/sessions / 备份导入会把客户端
        # 传的值原样落盘，字符串时间戳一行就让整条 /api/continent 500（09-20）
        return -_num_or_zero(sess.get("updatedAt"))

    clusters = []
    session_rank = {}  # itemId → 簇内序（共享连线端点取「每会话最前」用）
    for sid in sorted(by_session, key=_cluster_sort_key):
        iids = sorted(by_session[sid], key=lambda i: (_created_rank(items[i]), i))
        for rank, iid in enumerate(iids):
            session_rank[iid] = rank
        clusters.append({
            "sessionId": sid,
            "title": _cluster_title(sid, title_index, bool(sessions)),
            "itemCount": len(iids),
            "items": [_item_row(iid, items[iid]) for iid in iids],
        })

    # ===== 共享概念：倒排索引 → 只留跨 ≥2 会话的 =====
    all_items = [(iid, items[iid]) for sid in by_session for iid in by_session[sid]]

    run_owners = {}
    for iid, item in all_items:
        # 只有「像概念名」的标题才参与子串切分：章节号标题（「1. 定义与坐标表达」
        # 「二、从微元立方体导出直角坐标表达式」）、指令句回显（「用户要求：…」）、
        # 叙述句与超长句都不是概念名，从它们身上切出来的只会是「表达」「坐标」这类
        # 语法碎片——实测一条 40 字假标题炸出 4 条虚假共享概念（大陆 v4 修复）。
        # 尺子复用 knowledge._is_concept_like_title，模块内不许各写一份。
        if not _is_concept_like_title(item.get("title")):
            continue
        # 译名归一已收口在 _normalize_title 里（v6）：「傅立叶变换」与「傅里叶变换」
        # 不归一的话共享串只剩词中间的「叶变换」（真机实测的城市名就是这个碎片）
        t = _normalize_title(item.get("title"))
        for size in range(_TITLE_RUN_MIN_CJK, len(t) + 1):
            for i in range(0, len(t) - size + 1):
                piece = t[i:i + size]
                if piece.isascii() and size < _TITLE_RUN_MIN_LATIN:
                    continue
                if any(ch in _STOP_CHARS for ch in piece):
                    continue
                run_owners.setdefault(piece, set()).add(iid)

    # 结构 token 每条只算一次：公式共享与 v7 公式指纹共用（热路径不许算两遍）
    struct_tokens = {iid: _structural_tokens(item) for iid, item in all_items}
    token_owners = {}
    for iid, item in all_items:
        # 公式是结构证据，不受标题闸门限制（标题不像概念名的条目，它的公式照样是
        # 真公式）；但先要过两道卫生（v5.6）——剥 `\text{…}` 散文、剔语法命令名，
        # 再剔通用符号（dx/dt/∂…），见 _structural_tokens / _GENERIC_FORMULA_TOKENS
        for token in struct_tokens[iid] - _GENERIC_FORMULA_TOKENS:
            token_owners.setdefault(token, set()).add(iid)

    # ===== v6 概念族：领域知识层（内置表 + KV 扩展）=====
    accepted_families = merge_families(BUILTIN_FAMILIES, families_from_payload(families))
    prepared_families = prepare_families(accepted_families)
    # 版本指纹在这算一次，两处消费（gate 校验 / 响应回传）共用——此前
    # current_gate_version 各算一遍，families_from_payload+merge+md5 白跑 3 次
    gate_ver = gate_version(accepted_families, _gate_weights())
    item_families, term_df, n_scored = _item_families(items, prepared_families)
    # 岛名 → 族（v7 海域层与 v6 族条目共用一份，只匹配一次）
    session_fams = {c["sessionId"]:
                    set(match_families(_normalize_title(c.get("title")), prepared_families))
                    for c in clusters}

    shared = []
    title_entries = _collapse_fragments(_cross_session_owners(run_owners, item_session))
    covered = _mark_covered_labels(title_entries)
    for label, owners, sids in title_entries:
        strength = _shared_strength("title", label)
        shared.append({"kind": "title", "label": label,
                       "score": _title_score(label, strength, len(sids)),
                       "strength": strength,
                       # v5.5：证据被更具体的标签完全覆盖 → 前端折叠（不单独成城）
                       "covered": label in covered,
                       "sessions": sorted(sids),
                       "owners": _owner_ids(owners, items),
                       "links": _links_for(owners, item_session, session_rank)})
    for token, owners, _sids in _cross_session_owners(token_owners, item_session):
        sids = {item_session[iid] for iid in owners}
        score = _FORMULA_SCORE * len(sids) + min(len(owners), 6)
        shared.append({"kind": "formula", "label": token, "score": round(score, 2),
                       "strength": _shared_strength("formula", token),
                       # 公式 token 是结构证据：不存在「被更长的 token 覆盖」这回事
                       "covered": False,
                       "sessions": sorted(sids),
                       "owners": _owner_ids(owners, items),
                       "links": _links_for(owners, item_session, session_rank)})

    family_entries = _family_entries(items, clusters, item_session, session_rank,
                                     accepted_families, prepared_families, item_families,
                                     session_fams)
    # 精确优先、族补缺口：族连接的每一对岛都已被更精确的强共享概念连上时，这座族城
    # 只是同一件事的第二座城（「简谐运动」两座岛 + 「振动与波动」族 = 重叠的两座城），
    # 折进折叠清单（原因 covered）而不是画上去。族只要多连上一座岛就照画（真机：
    # 「矢量分析」连了 4 座岛，其中「散度」岛没有任何精确标签覆盖 → 必须画）。
    _mark_families_covered(family_entries, shared)
    shared.extend(family_entries)

    # 广度优先（分数里已含广度乘子）；同分按标签稳定排序。covered 条目不删——
    # 前端在分配城市名额之前就把它折进清单，所以它不会挤掉任何一座能画的城。
    shared.sort(key=lambda s: (-s["score"], s["label"]))
    shared = shared[:SHARED_CONCEPT_LIMIT]

    # ===== v7 海域层：softmax 评分核心（本地证据 + gate KV 模型证据，纯现算）=====
    accepted_names = {f["canonical"] for f in accepted_families}
    gate_entries = _normalize_gate_payload(gate, accepted_names, gate_ver)
    term_k = _term_family_counts(prepared_families)
    # 每张卡的领域概率只算一次；**不只扫有标题命中的卡**——章节号标题的卡没有词面
    # 证据，但可能有 gate 打标/公式指纹（v7.1b 的主救场正是这类卡）。有打标的卡
    # 另算一份「只含本地证据」的概率（domainSource 归属基线，见 _cluster_domain_row）
    card_probs, card_probs_local = {}, {}
    embed_used = False
    for iid in item_session:
        hits = item_families.get(iid) or {}
        gate_labels = gate_entries.get(iid)
        struct = struct_tokens.get(iid) or set()
        # v9 向量证据：只留正拉动且领域在专家名单内（与 gate KV 打标同口径——
        # 名单外的领域名一律丢弃）；向量关闭时是空表，行为与 v8 一致
        sims = {d: s for d, s in ((card_sims or {}).get(iid) or {}).items()
                if s > 0 and d in accepted_names} or None
        if sims:
            embed_used = True
        local = _softmax(_gate_card_scores(hits, struct, None, term_df, n_scored, term_k, sims))
        full = (_softmax(_gate_card_scores(hits, struct, gate_labels, term_df, n_scored, term_k, sims))
                if gate_labels else local)
        if local:
            card_probs_local[iid] = local
        if full:
            card_probs[iid] = full
    for cluster in clusters:
        cluster.update(_cluster_domain_row(
            [row["itemId"] for row in cluster["items"]],
            items, card_probs, card_probs_local,
            session_fams.get(cluster["sessionId"]) or ()))

    # ===== v2 用户簇间边：主图自有数据（KV continent_edges，调用方喂参）=====
    valid_edges, dangling_edges = _split_user_edges(
        normalize_user_edge_payload(user_edges), item_session)

    return {
        "generatedAt": int(time.time() * 1000),
        "clusterCount": len(clusters),
        "itemCount": sum(c["itemCount"] for c in clusters),
        "orphans": orphans,
        "clusters": clusters,
        "shared": shared,
        "userEdges": valid_edges,
        "danglingEdges": dangling_edges,
        "domainList": [f["canonical"] for f in accepted_families][:DOMAIN_LIST_MAX],
        # v7.1b：当前评分口径的版本指纹——前端写 gate KV 时带上它，名单/权重变了
        # 整批作废重打（版本单一来源在此，不许前端自己算）
        "gateVersion": gate_ver,
        # v9：本次投影是否真用上了向量证据（缺模型/相似度全被滤空时 False，
        # 海域层自动退回词面口径）
        "embedEnabled": embed_used,
    }
