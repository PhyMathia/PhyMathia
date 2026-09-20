"""概念先导链上下文（P1-A / M4）：把 knowledge 条目当检索基底，按领域结构推导「先导概念」。

与既有上下文层次的分工：
- 消息层（context.py 的 graph_path 梯度）管「我们聊到哪」；
- 用户画像（profile.py）管「你是谁」；
- 本模块管「这个话题的地基是什么」——knowledge.json 此前只做浏览与定位，从不参与 prompt 检索。

三条硬约束（对应计划里的立场）：
1. **查空是正常路径**：没命中概念就不产出文本，调用方追加空串，输出与不带本模块逐字一致；
2. **不新增模型调用**：纯本地匹配与推导（公式 token / 标题包含 / 画布显式连线）；
3. **公式键只有一把**：必须走 knowledge._formula_key（忽略定界符与空白差异）；
   前端 _normalizeFormulaLatex 不做这层归一化，用它求交集会出现「人眼相同、集合为空」。
"""

import re

from llm_common import estimate_tokens
from .config import KNOWLEDGE_PATH, KV_PATH
from .family import apply_aliases
from .knowledge import _formula_key
from .storage import _read_json_cached

# ====== 预算 ======
CONCEPT_BLOCK_MAX_TOKENS = 800
ONESHOT_LIMIT = 6          # 先导概念最多几条
TWOSHOT_LIMIT = 8          # 同源概念最多几条
SUMMARY_MAX_CHARS = 60     # 先导概念摘要上限（计划口径）
TITLE_MAX_CHARS = 40
RELATION_MAX_CHARS = 24

# TeX 命令不参与匹配，只留有区分度的符号与标识符
_TEX_COMMANDS = {
    "frac", "sqrt", "partial", "mathbf", "mathrm", "mathcal", "vec", "hat", "bar",
    "dot", "ddot", "tilde", "text", "left", "right", "cdot", "times", "infty",
    "int", "sum", "prod", "lim", "max", "min", "arg", "sin", "cos", "tan", "log",
    "ln", "exp", "over", "begin", "end", "matrix", "cases", "delta", "nabla",
    "quad", "qquad", "displaystyle", "operatorname", "boldsymbol", "limits",
    # 希腊字母命令名：真正的符号走 _GREEK 表（`\omega` → ω），命令名本身不是 token
    "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta",
    "theta", "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi",
    "rho", "sigma", "tau", "upsilon", "phi", "varphi", "chi", "psi", "omega",
    "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Phi", "Psi", "Omega",
    # 箭头/装饰类命令：`rightarrow`、`circ` 这类不是物理量
    "rightarrow", "Rightarrow", "leftarrow", "leftrightarrow", "circ", "to",
}

_GREEK = set("αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ")
_IDENT_RE = re.compile(r"\\?[A-Za-z]{1,24}")
# 自动标题的编号前缀与无信息量尾巴（「1. 定义与坐标表达」这类）
_TITLE_NUMBER_PREFIX_RE = re.compile(r"^\d+[.、)]")
_TITLE_NOISE_RE = re.compile(r"(的定义与坐标表达|的定义|的概述|简介|概述|小结|总结)$")
_MD_NOISE_RE = re.compile(r"[`*_>#\[\]（）()【】「」“”\"'，。；：,.;:!?！？、\s]+")

# 概念名里的泛后缀：这些词单独立不住（「运动」「定理」人人都用），只能作兜底证据。
# 有结构证据（共享公式）时它们是真信号；没有时只能当弱候选，且不与强候选抢位。
_GENERIC_TERMS = {
    "运动", "定理", "定律", "方程", "公式", "函数", "算子", "意义", "定义", "性质",
    "应用", "方法", "模型", "系统", "问题", "理论", "关系", "变换", "分析", "表达",
}
# 标题重叠判定用的最小共享串：中文 2 字（「振动」）、拉丁 4 字符
_TITLE_RUN_MIN_CJK = 2
_TITLE_RUN_MIN_LATIN = 4
# 达到这个长度才算「实质重叠」；2 字串只作弱证据
_TITLE_STRONG_MIN = 3

# 证据权重：问题里直接出现公式符号（且符号有区分度）> 概念名实质重叠 > 泛后缀重叠。
# 标题重叠的计分带**稀有度惩罚**（除以该串在知识库标题里出现的条目数）：
# 「运动」这类人人共用的词不能靠长度压过真正的结构证据。
_W_FORMULA_HIT = 100
_W_TITLE_RUN = 60
_W_GENERIC_RUN = 8
_W_FORMULA_SHARED = 30
# 功能字：含这些字的共享串不是领域术语（「动的」「和线」「是有」…），一律丢弃。
# 不能用整串相等判定——「动的」这样的碎片必须先认出里面的「的」。
_STOP_CHARS = set("的地得和与跟及或在是有为对把被让使则即也都还很更最又再就才只不没了着过")
# 问题里命中的公式符号至少要有这么长才计分：单字母（`f`/`x`/`t`/`E`）在数学与物理里
# 到处都是，拿它当检索键会把「解释梯度」连到「简谐运动」上（实测踩过）。
_SYMBOL_HIT_MIN = 2

def _normalize_title(title: str) -> str:
    """标题归一化：去编号前缀、markdown 噪声、空白与无信息量尾巴，转小写，再过译名归一。

    v6 起把**译名/写法变体归一**（`傅立叶`→`傅里叶`）收进这一把尺子：概念地基的检索、
    大陆的共享子串切分、概念族匹配三处都走它，谁也不必各写一份——两处各写一份正是
    「人眼相同、集合为空」那类事故的温床（与公式键只有一把同一条纪律）。
    """
    s = _MD_NOISE_RE.sub("", str(title or ""))
    s = _TITLE_NUMBER_PREFIX_RE.sub("", s)
    prev = None
    while prev != s:
        prev = s
        s = _TITLE_NOISE_RE.sub("", s)
    return apply_aliases(s.lower())


def _has_cjk(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def _shared_runs(text: str, title: str, min_cjk: int, min_latin: int) -> list:
    """text 与 title 的极大公共子串（只认中文 ≥min_cjk 字、拉丁 ≥min_latin 字符的连续串）。

    用最长公共子串而不是整串包含：「非线性振动」与概念名「阻尼振动」共享的正是「振动」，
    按整串包含判定会全部落空（这正是 M4 首个设计版本查空的根因）。

    每个起点都试（不能只在无命中时才 +1）：否则「请解释…」与「简谐运动」在起点 0
    因「请解」不存在而中断后，会直接跳过起点 1 的「解释」，把后面的「振动」一起漏掉。
    """
    out, n = [], len(text)
    for i in range(n):
        j = i + 1
        while j <= n and text[i:j] in title:
            j += 1
        best = text[i:j - 1]
        if best and (len(best) >= min_latin if best.isascii() else len(best) >= min_cjk):
            out.append(best)
    # 保序去重：同一串在问题文本里重复提及不该被重复计分（weak/generic 串同样
    # 会被放大，是疏漏不是加权——09-20 修复）
    return list(dict.fromkeys(out))


def _formula_tokens(item: dict) -> set:
    r"""条目公式 → 可比较的 token 集合（先导检索与结构边的唯一入口）。

    先用 knowledge._formula_key 归一化（与公式去重链路同一把尺子），再切出有区分度的
    符号/标识符。三道过滤都是实测踩出来的：
-      单字母符号（x/f/t/E）在数学与物理里到处都是，留着会把「解释梯度」连到「简谐运动」；
    - TeX **命令名**（`frac`/`partial`/`int`/`sum`…）经反斜杠切分后也是个「词」，
      留着会让任意两条含积分的公式互相成为「同源概念」（实测把拉普拉斯算子连到阻尼振动）；
    - 希腊字母只认 `_GREEK` 表里的真符号，`\delta`/`\nabla`/`\omega` 这类命令名不算。
    """
    tokens = set()
    for latex in item.get("formulas") or []:
        key = _formula_key(str(latex or ""))
        if not key:
            continue
        for ch in key:
            if ch in _GREEK:
                tokens.add(ch)
        for word in _IDENT_RE.findall(key):
            # 命令名先剥反斜杠：`\omega` 是真符号（归到 ω），`\frac` 是排版命令（丢弃）
            name = word.lstrip("\\")
            if name in _GREEK:
                tokens.add(name)
                continue
            low = name.lower()
            if len(low) >= _SYMBOL_HIT_MIN and low not in _TEX_COMMANDS:
                tokens.add(low)
    return tokens


def match_concepts(prompt: str, items: dict, limit: int = 2, session_id: str = "",
                   allow_cross_session: bool = True) -> list:
    """问题 → 概念识别（本地，无模型调用），返回命中的条目 id（按证据分降序）。

    无命中返回 []，调用方静默跳过（查空是正常路径）；需要命中理由用 match_concept_details。
    """
    return [
        row["id"] for row in match_concept_details(
            prompt, items, limit=limit, session_id=session_id,
            allow_cross_session=allow_cross_session,
        )
    ]


def match_concept_details(prompt: str, items: dict, limit: int = 2, session_id: str = "",
                          allow_cross_session: bool = True) -> list:
    """问题 → 概念识别详情（`{"id", "hits", "runs", "score"}`），便于排查与单测。

    四类证据（权重见 _W_*）：
    1. **问题里直接出现公式符号**（`kx`/`omega`…，是条目公式里的标识符）——最具体；
    2. **概念名实质重叠**：与问题的最长公共子串达阈值，且不是「运动/定理」这类泛后缀词。
       整串包含判定会全部落空（「非线性振动」与「阻尼振动」共享的正是「振动」），
       这是 M4 首版设计查空的根因；
    3. **概念名泛后缀重叠**：单独立不住，排在强证据之后；
    4. **条目与其他概念共享公式**（结构分）：同分时把「有地基的概念」排前面——否则
       「非线性振动」会选中同一答簇里的兄弟条目「简谐运动的能量」，而不是真正的
       「简谐运动」/「胡克定律」。
    """
    text = _normalize_title(prompt)
    if not text or not isinstance(items, dict):
        return []
    # 公式符号判定用去反斜杠的文本：用户既可能写 `\omega` 也可能写 `omega`、`ω`
    symbol_text = text.replace("\\", "")
    index = _entry_formula_index(items, allow_cross_session, session_id)
    title_index = _title_run_index(items, allow_cross_session, session_id)
    scored = []
    for item_id, item in items.items():
        if not isinstance(item, dict):
            continue
        if not allow_cross_session and str(item.get("sessionId") or "") not in ("", str(session_id)):
            continue
        title = _normalize_title(item.get("title"))
        if not title:
            continue
        tokens = _formula_tokens(item)
        hits = [t for t in tokens if len(t) >= _SYMBOL_HIT_MIN and _prompt_has_symbol(symbol_text, t)]
        runs = _shared_runs(text, title, _TITLE_RUN_MIN_CJK, _TITLE_RUN_MIN_LATIN)
        runs = [r for r in runs if not (_STOP_CHARS & set(r))]
        # 分级：长串（≥3 字/按拉丁阈值）算实质证据；2 字领域词（「振动」）算弱证据，
        # 需另有支撑；泛后缀词（「运动」「定理」）最弱。
        strong = [r for r in runs if len(r) >= _TITLE_STRONG_MIN and r not in _GENERIC_TERMS]
        weak = [r for r in runs if len(r) < _TITLE_STRONG_MIN and r not in _GENERIC_TERMS]
        generic = [r for r in runs if r in _GENERIC_TERMS]
        shared = sum(
            1.0 / (len(index.get(t, ())) - 1)
            for t in tokens
            if len(t) >= _SYMBOL_HIT_MIN and len(index.get(t, ())) > 1
        )
        # 检索闸门：条目必须与本问题有真实交集，且弱证据要有支撑。
        # 「支持」有两种：问题里出现该条目的公式符号；或这是**跨概念的领域词**
        # （同一串出现在 ≥2 个条目标题里，如「振动」——它不是某个条目的私有词）。
        # 只靠「与其他概念共享公式」不能入选：那是排序信号不是检索信号，
        # 否则问「今天天气」也会把整簇知识点（它们互相共享公式）带出来（实测踩过）。
        # 领域词判定要求串里真有中文字：「度的」这种（2 字但字形是「度」+「的」）
        # 只是字面碎片，不能当跨概念领域词（实测把梯度条目漏进了振动问题）
        domain_terms = [
            r for r in weak
            if len(title_index.get(r, ())) >= 2 and any("\u4e00" <= ch <= "\u9fff" for ch in r)
        ]
        supported = bool(hits) or bool(domain_terms)
        # 放行条件（按证据强弱）：公式符号命中 ＞ 实质标题重叠 ＞ 弱串/泛词且带支撑。
        # 只靠泛词（「度的」「运动」）连支撑都没有时必须拒绝——否则「F=-kx 的 k」会把
        # 一堆含「梯度…的定义」的条目全带出来（实测）。
        admitted = bool(hits) or bool(strong) or (supported and bool(weak or generic))
        if not admitted:
            continue
        score = (
            _W_FORMULA_HIT * sum(len(t) for t in hits)
            + _W_TITLE_RUN * sum(_run_weight(r, title_index) for r in strong)
            + _W_GENERIC_RUN * sum(_run_weight(r, title_index) for r in weak + generic)
            # 结构分只在已入选的候选中起排序作用：把「有地基的概念」排在兄弟条目之前
            + _W_FORMULA_SHARED * shared
        )
        if score <= 0:
            continue
        scored.append((-score, -len(hits), str(item_id), {
            "id": str(item_id), "hits": sorted(hits), "runs": runs,
            "score": round(score, 2),
        }))
    scored.sort(key=lambda row: (row[0], row[1], row[2]))
    return [row[3] for row in scored[: max(0, limit)]]


def _title_run_index(items: dict, allow_cross_session: bool, session_id: str) -> dict:
    """共享串 → 出现在多少个条目标题里（稀有度分母）。"""
    index = {}
    for item_id, item in items.items():
        if not isinstance(item, dict):
            continue
        if not allow_cross_session and str(item.get("sessionId") or "") not in ("", str(session_id)):
            continue
        title = _normalize_title(item.get("title"))
        for size in range(_TITLE_RUN_MIN_CJK, len(title) + 1):
            for i in range(0, len(title) - size + 1):
                piece = title[i:i + size]
                if piece.isascii() and size < _TITLE_RUN_MIN_LATIN:
                    continue
                index.setdefault(piece, set()).add(str(item_id))
    return index


def _run_weight(run: str, title_index: dict) -> float:
    """串越长越具体，同时在越多标题里出现越不可靠（长串天然稀有，因此只按 df 收敛不放大）。"""
    df = len(title_index.get(run, ())) or 1
    return len(run) / df


def _entry_formula_index(items: dict, allow_cross_session: bool, session_id: str) -> dict:
    """公式 token → 拥有该 token 的条目集合（用于「与其他概念共享公式」的结构分）。"""
    index = {}
    for item_id, item in items.items():
        if not isinstance(item, dict):
            continue
        if not allow_cross_session and str(item.get("sessionId") or "") not in ("", str(session_id)):
            continue
        for token in _formula_tokens(item):
            index.setdefault(token, set()).add(str(item_id))
    return index


def _match_ids(refs) -> list:
    """兼容两种 refs 形态：id 列表（计划口径）与 match_concept_details 的详情列表。"""
    out = []
    for ref in refs or []:
        item_id = ref.get("id") if isinstance(ref, dict) else ref
        if item_id is not None:
            out.append(str(item_id))
    return out


def _prompt_has_symbol(text: str, token: str) -> bool:
    r"""问题里是否真的出现了这个公式符号（避免 `kx` 命中 `box` 这类子串误判）。

    `\` 视为合法前导：用户写 LaTeX（`F=-kx`、`\omega`）时前缀就是反斜杠。
    """
    return re.search(r"(?<![0-9a-z\\])" + re.escape(token), text) is not None


def _graph_state_keys(session_id: str) -> list:
    """兼容两种会话标识与两种 KV 键命名（服务端 `graph:{id}` / 前端导出 `phymathia_graph_{id}`）。"""
    sid = str(session_id or "").strip()
    if not sid:
        return []
    keys = [f"graph:{sid}"]
    if sid.startswith("phymathia_"):
        keys.append(f"graph:sess_{sid[len('phymathia_'):]}")
    keys.append(f"phymathia_graph_{sid}")
    return keys


def explicit_pairs(session_id: str, kv_path=None) -> list:
    """画布显式边：两端都是知识点节点、且用户手工连了联系线的 (item_id, item_id, relation)。

    知识点条目的 nodeId 多数挂在模块气泡上（模块↔知识点不是「先导」关系），
    因此只有 `knowledgeKey`/`knowledge-custom-*` 这类真正的知识点节点才参与判定。
    """
    kv = _read_json_cached(kv_path or KV_PATH, {}) or {}
    state = None
    for key in _graph_state_keys(session_id):
        candidate = kv.get(key)
        if isinstance(candidate, dict):
            state = candidate
            break
    if not state:
        return []
    node_to_knowledge = {}
    for node in state.get("customNodes") or []:
        if not isinstance(node, dict):
            continue
        node_id = str(node.get("id") or "")
        if not node_id:
            continue
        key_ref = str(node.get("knowledgeKey") or "")
        if key_ref or node_id.startswith("knowledge-custom-"):
            node_to_knowledge[node_id] = key_ref or node_id
    pairs = []
    for conn in state.get("connections") or []:
        if not isinstance(conn, dict):
            continue
        src = node_to_knowledge.get(str(conn.get("from") or ""))
        dst = node_to_knowledge.get(str(conn.get("to") or ""))
        if not src or not dst or src == dst:
            continue
        relation = str(conn.get("relation") or conn.get("label") or "").strip()
        pairs.append((src, dst, relation[:RELATION_MAX_CHARS]))
    return pairs


def _clip(text: str, limit: int) -> str:
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(s) <= limit:
        return s
    return s[:limit].rstrip() + "…"


def _summary_of(item: dict) -> str:
    """条目摘要：只认模型/人工摘要（local 兜底是模板文案，当「地基」会误导）。"""
    source = str(item.get("summarySource") or "local")
    summary = str(item.get("summary") or "").strip()
    if source == "local" or not summary:
        return ""
    return _clip(summary, SUMMARY_MAX_CHARS)


def _concept_row(item_id: str, item: dict, level: str, relation: str, session_id: str) -> dict:
    title = _clip(str(item.get("title") or ""), TITLE_MAX_CHARS) or str(item_id)
    formulas = [str(f) for f in (item.get("formulas") or []) if str(f or "").strip()]
    return {
        "id": str(item_id),
        "title": title,
        "summary": _summary_of(item) if level == "one" else "",
        "formula": formulas[0] if formulas else "",
        "relation": relation,
        "level": level,
        "cross_session": bool(session_id) and str(item.get("sessionId") or "") not in ("", str(session_id)),
    }


def _shared_formula_neighbors(ref: str, items: dict, by_token: dict) -> list:
    """结构边：与本条目共享公式 token 的知识点（按共享 token 数降序、id 稳定排序）。"""
    counts = {}
    for token in _formula_tokens(items[ref]):
        for other in by_token.get(token, ()):
            if other != ref:
                counts[other] = counts.get(other, 0) + 1
    return [other for other, _n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]


def build_grounding(items: dict, refs: list, session_id: str = "", pairs: list = None,
                    allow_cross_session: bool = True) -> dict:
    """三级推导先导集：① 画布显式边 → ② 共享公式结构边 → ③ 都没有则只带自身。

    返回 {"one": [...], "two": [...], "refs": [...]}；refs 全部查不到条目时返回 {}。
    """
    if not isinstance(items, dict) or not refs:
        return {}
    pairs = pairs or []
    refs = [r for r in _match_ids(refs) if r in items]
    if not refs:
        return {}

    def allowed(item_id: str) -> bool:
        if allow_cross_session:
            return True
        return str(items[item_id].get("sessionId") or "") in ("", str(session_id))

    explicit = {}
    for src, dst, relation in pairs:
        if src in items and dst in items:
            explicit.setdefault(src, []).append((dst, relation or "联系"))
            explicit.setdefault(dst, []).append((src, relation or "联系"))

    by_token = {}
    for item_id, item in items.items():
        if not isinstance(item, dict) or not allowed(str(item_id)):
            continue
        for token in _formula_tokens(item):
            by_token.setdefault(token, set()).add(str(item_id))

    one, two = [], []
    used = {str(r) for r in refs}
    for ref in refs:
        item = items[ref]
        anchor = str(item.get("title") or ref)
        one_added = []
        for related, relation in explicit.get(ref, []):
            if related in used:
                continue
            used.add(related)
            row = _concept_row(related, items[related], "one", relation, session_id)
            row.update({"anchor": anchor, "via": "explicit"})
            one.append(row)
            one_added.append(related)
        for other in _shared_formula_neighbors(ref, items, by_token):
            if other in used:
                continue
            used.add(other)
            row = _concept_row(other, items[other], "one", "", session_id)
            row.update({"anchor": anchor, "via": "formula"})
            one.append(row)
            one_added.append(other)
        if not one_added:
            # 第 3 级：没有先导可推，至少把概念自身的定义与公式作为地基给出
            row = _concept_row(ref, item, "one", "", session_id)
            row.update({"anchor": "", "via": "self"})
            one.append(row)
            continue
        # 两跳：先导概念的同源概念（它们与当前概念共享同一批公式，是这题更远的参照系）
        for first in one_added:
            for other in _shared_formula_neighbors(first, items, by_token):
                if other in used:
                    continue
                used.add(other)
                row = _concept_row(other, items[other], "two", "", session_id)
                row.update({"anchor": str(items[first].get("title") or first), "via": "formula-shot"})
                two.append(row)

    one = _dedupe_rows(one)[:ONESHOT_LIMIT]
    chosen = {row["id"] for row in one}
    two = _dedupe_rows([row for row in two if row["id"] not in chosen])[:TWOSHOT_LIMIT]
    return {"one": one, "two": two, "refs": [str(r) for r in refs]}


def _dedupe_rows(rows: list) -> list:
    seen, out = set(), []
    for row in rows:
        if row["id"] in seen:
            continue
        seen.add(row["id"])
        out.append(row)
    return out


def render_concept_grounding(data: dict) -> str:
    """渲染 system prompt 末段【概念地基】（用户已学）。无内容返回空串。"""
    if not data or not (data.get("one") or data.get("two")):
        return ""
    lines = [
        "【概念地基】（用户已学，供你决定从哪讲起；不是本次提问的内容）",
        "规则：1. 涉及这些概念时可直接引用其结论、公式与记号，不必从零重讲；"
        "2. 它是背景不是任务——不要复述整段，也不要假设用户还记得全部细节；"
        "3. 用户明确表示没学过时，以用户为准。",
    ]
    one = data.get("one") or []
    if one:
        lines.append("先导概念：")
        for row in one:
            parts = [row["title"]]
            if row.get("cross_session"):
                parts.append("（其他会话已学）")
            if row.get("summary"):
                parts.append("：" + row["summary"])
            if row.get("formula"):
                parts.append("｜" + row["formula"])
            if row.get("via") == "explicit":
                parts.append("（与「" + str(row.get("anchor") or "") + "」的联系：" + (row.get("relation") or "联系") + "）")
            lines.append("- " + "".join(parts))
    two = data.get("two") or []
    if two:
        lines.append("同源概念（用了同一批公式，可作参照）：")
        for row in two:
            text = row["title"]
            if row.get("formula"):
                text += "（" + row["formula"] + "）"
            lines.append("- " + text)
    return "\n".join(lines)


def _trim_to_budget(text: str) -> str:
    if estimate_tokens(text) <= CONCEPT_BLOCK_MAX_TOKENS:
        return text
    # 预算兜底：先砍掉「同源概念」整段（两跳是最弱信号），再逐行回退
    lines = text.split("\n")
    for index, line in enumerate(lines):
        if line.startswith("同源概念"):
            lines = lines[:index]
            break
    text = "\n".join(lines)
    while estimate_tokens(text) > CONCEPT_BLOCK_MAX_TOKENS and len(lines) > 3:
        lines = lines[:-1]
        text = "\n".join(lines)
    return text


def concept_context_text(prompt: str, session_id: str = "", items: dict = None,
                         kv_path=None, allow_cross_session: bool = True) -> str:
    """主入口：问题 → 概念地基段。无命中返回空串（调用方追加空串即零回归）。

    `.env` 的 PHYMATHIA_CONCEPT_SCOPE=same_session 可把检索范围收窄到当前会话
    （默认跨会话：先导概念的真实形态就是「上个会话学过的那个」）。
    """
    if not str(prompt or "").strip():
        return ""
    if allow_cross_session and not _env_scope_allows_cross():
        allow_cross_session = False
    store = _read_json_cached(KNOWLEDGE_PATH, {}) if items is None else items
    if not isinstance(store, dict) or not store:
        return ""
    refs = match_concepts(
        prompt, store, session_id=session_id, allow_cross_session=allow_cross_session,
    )
    if not refs:
        return ""
    data = build_grounding(
        store, refs, session_id=session_id,
        pairs=explicit_pairs(session_id, kv_path=kv_path),
        allow_cross_session=allow_cross_session,
    )
    return _trim_to_budget(render_concept_grounding(data))


def _env_scope_allows_cross() -> bool:
    import os
    return str(os.environ.get("PHYMATHIA_CONCEPT_SCOPE") or "").strip().lower() != "same_session"


__all__ = [
    "CONCEPT_BLOCK_MAX_TOKENS", "match_concepts", "explicit_pairs", "build_grounding",
    "render_concept_grounding", "concept_context_text",
]
