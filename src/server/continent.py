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
from .knowledge import _is_concept_like_title

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
_FALLBACK_TITLE = "未命名画布"
_DELETED_TITLE = "已删除的画布"


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
    sids = sorted(by_session, key=lambda s: session_rank.get(min(by_session[s]), 0))
    pairs = (itertools.combinations(sids, 2) if len(sids) <= 4
             else zip(sids, sids[1:]))
    return [{"from": by_session[a][0], "to": by_session[b][0],
             "fromSession": a, "toSession": b} for a, b in pairs]


def _created_rank(item) -> float:
    """createdAt 的数值兜底：真机存量数据里有字符串时间戳（实测 3 条）与坏值。

    排序键一旦混用 int/str 就抛 TypeError，会把整条 /api/continent 打成 500——
    投影层对脏数据的立场是「照常返回，别报错」。
    """
    raw = (item or {}).get("createdAt") or 0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


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
            "createdAt": edge.get("createdAt") or 0,
        }

    seen_pair = {}
    for edge in sorted(raw_edges, key=lambda e: -(e.get("createdAt") or 0)):
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


def build_continent(items: dict, sessions: dict = None, user_edges=None) -> dict:
    """从知识条目推导大陆投影。纯函数：无 IO、无模型调用、不修改入参。

    返回 {generatedAt, clusterCount, itemCount, orphans, clusters, shared,
    userEdges, danglingEdges}：
    - clusters: 每个有知识条目的会话一个簇，按会话最近更新排序；簇内条目按
      createdAt 升序（学习顺序）；
    - shared: 跨会话共享概念（kind=title 公共子串 / kind=formula 公式 token），
      分数以**广度**为先（跨岛越多越靠前，v5.5），取前 SHARED_CONCEPT_LIMIT 条；
      每条带 links（每会话一张代表卡的端点，画图用）、owners（全部命中条目 id，
      v5.1 重逢清单列同岛多卡用）与 covered（v5.5：证据被更具体的标签完全覆盖，
      前端折叠它、不单独成城——条目仍照报，不静默消失）；
    - userEdges / danglingEdges（v2）：用户在主图上画的簇间边，经当前投影校验；
      悬空边（端点条目已不在）单列，前端渲染断桥并提供清理入口。
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
        return -(sess.get("updatedAt") or 0)

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
        t = _normalize_title(item.get("title"))
        for size in range(_TITLE_RUN_MIN_CJK, len(t) + 1):
            for i in range(0, len(t) - size + 1):
                piece = t[i:i + size]
                if piece.isascii() and size < _TITLE_RUN_MIN_LATIN:
                    continue
                if any(ch in _STOP_CHARS for ch in piece):
                    continue
                run_owners.setdefault(piece, set()).add(iid)

    token_owners = {}
    for iid, item in all_items:
        # 公式是结构证据，不受标题闸门限制（标题不像概念名的条目，它的公式照样是
        # 真公式）；但先要过两道卫生（v5.6）——剥 `\text{…}` 散文、剔语法命令名，
        # 再剔通用符号（dx/dt/∂…），见 _structural_tokens / _GENERIC_FORMULA_TOKENS
        for token in _structural_tokens(item) - _GENERIC_FORMULA_TOKENS:
            token_owners.setdefault(token, set()).add(iid)

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

    # 广度优先（分数里已含广度乘子）；同分按标签稳定排序。covered 条目不删——
    # 前端在分配城市名额之前就把它折进清单，所以它不会挤掉任何一座能画的城。
    shared.sort(key=lambda s: (-s["score"], s["label"]))
    shared = shared[:SHARED_CONCEPT_LIMIT]

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
    }
