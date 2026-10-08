"""知识点与公式：提取、归一化、去重、描述。"""

import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from .http_client import get_http_client
from .llm_common import opencode_gateway_headers
from . import usage_stats  # 共享层：token 用量与缓存命中计量落盘

from .config import (
    AI_PROVIDERS,
    LEVEL_PROMPTS,
    OPENCODE_DEFAULT_API_KEY,
    resolve_api_key,
    validate_model_target,
)
from . import accounts
from .accounts import DEFAULT_ACCOUNT
from .context import _is_socratic_followup
from .prompts import DESCRIBE_PROMPT, EXTRACT_PROMPT
from .storage import _mutate_json

logger = logging.getLogger(__name__)

def _normalize_knowledge(data) -> dict:
    """将 knowledge 数据归一化为 id->item 映射。

    兼容三种历史格式：
    - {"items": [...]} 包装（POST 直写 payload 的历史残留）
    - {"items": {...}} 包装
    - 纯数组 [item, ...]
    以及垃圾数据 {"items": null} -> {}
    """
    if not isinstance(data, dict):
        return {}
    if "items" in data:
        items = data.get("items")
        if isinstance(items, dict):
            return items
        if isinstance(items, list):
            return {it.get("id") or ("k_" + uuid.uuid4().hex[:12]): it
                    for it in items if isinstance(it, dict)}
        return {}
    return data



def _normalize_formula(latex: str) -> str:
    r"""标准化公式：\$→$、去首尾 $、统一包 $..$；无效返回空串"""
    s = (latex or "").strip()
    s = s.replace("\\$", "$").strip()
    s = re.sub(r"^\$+|\$+$", "", s).strip()
    # 内部残留的 $ 会在包上 $..$ 后形成畸形嵌套定界符（KaTeX 扫描时提前截断），移除
    s = s.replace("$", "")
    # 清洗 PowerShell 转义等产生的无效 LaTeX 命令（\= 等）
    s = re.sub(r"\\([=,;:])", r"\1", s)
    if not s:
        return ""
    return f"${s}$"


def _formula_key(latex: str) -> str:
    """生成用于跨来源去重的公式键，忽略定界符和常见空白差异。"""
    s = _normalize_formula(latex).strip("$").strip()
    s = s.replace("\\qquad", " ").replace("\\quad", " ").replace("\\,", " ")
    s = s.replace("\\;", " ").replace(";", " ")
    s = s.replace("\\cdot", " ")
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*([=,+\-*/])\s*", r"\1", s)
    return s.strip()


def _looks_like_formula(latex: str) -> bool:
    """判断提取的文本是否像真正的公式（排除单字符、纯命令、纯单位、短字母串）。

    KaTeX 等解析工具只能校验语法合法性（单字符 m、纯命令 \\omega 都是合法 LaTeX），
    是否"算公式"是语义判断，需结构启发式：保留含运算符/函数/数字/上下标的结构。
    """
    s = (latex or "").strip().strip("$").strip()
    if not s:
        return False
    # 单个字符（字母/数字/符号）不算公式：m、k、ω
    if len(s) == 1:
        return False
    # 纯短字母串（≤3 个字母，无结构）：rad、kg、Hz
    if re.fullmatch(r"[A-Za-z]{1,3}", s):
        return False
    # 纯符号命令：\omega、\pi、\theta
    if re.fullmatch(r"\\[A-Za-z]+", s):
        return False
    # 纯 \text{...}（单位/文字）：\text{rad/s}
    if re.fullmatch(r"\\text\{[^{}]*\}", s):
        return False
    # 纯短字母+斜杠（单位）：rad/s、m/s
    if re.fullmatch(r"[A-Za-z]{1,4}(/[A-Za-z]{1,4})+", s):
        return False
    # 纯中文（含中文标点/全角字符）：是概念名不是公式——能量守恒、动量定理
    if re.fullmatch(r"[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+", s):
        return False
    # 含中文散文但没有任何 LaTeX 结构（\ ^ _ { } = <> 与数字）：是回显的提示词/正文
    # 片段，不是公式。实测踩过：推理泄漏的正文被 AI 提取成
    # 「$标签包裹。物理直觉里"尽量少公式"。$」这样的条目公式，全是中文标点散文。
    if re.search(r"[\u4e00-\u9fff]", s) and not re.search(r"[\\^_={}<>±≤≥→\d]", s):
        return False
    # 其余视为公式（含 = + - ( ) { } 数字、函数结构等）
    return True


def _dedupe_formula_map(data: dict) -> dict:
    """按规范化公式全局去重（T146 起不再按会话分区），保留较优记录。

    同一公式在多个画布出现只留一条：meaningSource=model 优先、createdAt 新者
    优先。跨会话合并把全部归属写进 sessionIds（含保留条自身的 sessionId）——
    按会话删除与大陆公式亲缘据此不丢信号。无法归一 latex 的条目原样保留。
    """
    groups = {}
    passthrough = {}
    for fid, item in data.items():
        if not isinstance(item, dict):
            continue
        key = _formula_key(item.get("latex") or "")
        if not key:
            passthrough[fid] = item
            continue
        groups.setdefault(key, []).append((fid, item))
    result = passthrough
    merge_fields = ("concept", "meaning", "meaningSource", "topic", "related", "messageId", "moduleKey")
    for entries in groups.values():
        entries.sort(key=lambda kv: (
            0 if (kv[1].get("meaningSource") or "") == "model" else 1,
            -(kv[1].get("createdAt", 0) or 0),
        ))
        keep_id, keep = entries[0]
        for _, other in entries[1:]:
            for field in merge_fields:
                if not keep.get(field) and other.get(field):
                    keep[field] = other[field]
        sids = _merge_session_ids(entries)
        if len(sids) > 1:
            keep["sessionIds"] = sids
        if not str(keep.get("sessionId") or "") and sids:
            keep["sessionId"] = sids[0]
        result[keep_id] = keep
    return result


def _merge_session_ids(entries) -> list:
    """T146：一组待合并条目的全部归属会话（保序去重，保留条自身的 sessionId
    恒在首位——调用方先排好保优序再进来）。"""
    sids, seen = [], set()
    for _, it in entries:
        for sid in [it.get("sessionId"), *(it.get("sessionIds") or [])]:
            s = str(sid or "")
            if s and s not in seen:
                seen.add(s)
                sids.append(s)
    return sids



def _parse_extract_json(text: str) -> list:
    """容错解析模型输出的 JSON"""
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return []
    items = data.get("items", []) if isinstance(data, dict) else []
    result = []
    for it in items:
        if not isinstance(it, dict):
            continue
        title = _clean_knowledge_title(str(it.get("title", "")))
        if not title:
            continue
        # 非知识内容的标题（指令句回显「用户要求：…」/ 整句）整条丢弃：模型从推理泄漏的
        # 正文里"提取"出来的不是知识点，收进来只会污染知识库、概念地基与大陆投影
        if _is_junk_knowledge_title(title):
            continue
        category = it.get("category")
        if category not in ("physics", "math", "other"):
            category = "other"
        formulas = []
        for f in (it.get("formulas") or []):
            fs = str(f).strip()
            if fs and _looks_like_formula(fs):
                formulas.append(fs)
        tags = [str(t).strip() for t in (it.get("tags") or []) if str(t).strip()][:6]
        module_key = str(it.get("moduleKey") or "")
        if not module_key:
            if "数学" in tags:
                module_key = "math"
            elif "物理" in tags:
                module_key = "physics"
            elif category == "math":
                module_key = "math"
            elif category == "physics":
                module_key = "physics"
            else:
                module_key = "answer"
        result.append({
            "title": title[:80],
            "category": category,
            "tags": tags,
            # AI 增强路径的逐条摘要：summarySource 标记为 model（≤60 字由
            # EXTRACT_PROMPT 约束，此处 200 仅作防御性截断兜底）
            "summary": str(it.get("summary", ""))[:200],
            "summarySource": "model",
            "formulas": formulas[:8],
            "moduleKey": module_key,
        })
    return result[:6]


# ===== 标题卫生（大陆共享概念 / 提取闸门 / 入库闸门共用的唯一一把尺子）=====
# 章节号（「1. 定义与坐标表达」「二、从微元立方体导出直角坐标表达式」）、指令句回显
# （「用户要求：…」）、整句（带句号 / 超长）都不是概念名。大陆的共享概念检测是在标题上
# 找公共子串，所以这类标题会立刻长出「表达」「坐标」这种语法碎片——实测一条 40 字的
# 推理泄漏标题就贡献了 4 条虚假共享概念（大陆 v4 修复）。这里定义，knowledge 之外的
# 模块只准引用，不准各写一份（尺子分叉就会出现「人眼相同、集合不同」）。
_SECTION_PREFIX_RE = re.compile(
    r"^\s*(?:\d+\s*[、.．)）]|[一二三四五六七八九十百]+[、.．)）]"
    r"|第\s*[一二三四五六七八九十百\d]+\s*[节章讲部])")
_INSTRUCTION_PREFIX_RE = re.compile(
    r"^\s*(?:用户要求|用户|请|注意|当前|根据|我们|这里|这是|如上|下面|以上|要求|本题|本节|本章)")
# 叙述/过程口吻：「从微元立方体导出直角坐标表达式」是步骤，不是概念名
_VERBAL_PREFIX_RE = re.compile(
    r"^\s*(?:从|在|由|用|对|把|将|通过|利用|导出|推导|说明|解释|计算|求解|证明|分析|讨论|介绍|给出|如何|怎么|为什么|怎样)")
_CONTINUATION_RE = re.compile(r"[（(]\s*续\s*[)）]|续\s*$")
_SENTENCE_PUNCT = ("。", "！", "？")
# 概念名的长度上限：超过就不像名字而像句子（实测库内真实标题最长 31 字）
CONCEPT_TITLE_MAX_CHARS = 32


def _strip_knowledge_section(title: str) -> str:
    """去掉章节号与「（续）」尾巴：标题该是概念名，不该带回答的小节编号。"""
    s = _SECTION_PREFIX_RE.sub("", str(title or "").strip()).strip()
    return _CONTINUATION_RE.sub("", s).strip()


def _is_junk_knowledge_title(title: str) -> bool:
    """非知识内容的标题：指令句回显 / 整句。这类条目不许入库（提取与入库两侧同判）。

    只认「不是知识」的硬证据，不碰口吻问题——「从微元立方体导出直角坐标表达式」
    虽不是概念名，但它是一张真卡片，过滤器不许越权删它。
    """
    s = _strip_knowledge_section(title)
    if not s:
        return True
    if _INSTRUCTION_PREFIX_RE.match(s):
        return True
    return any(p in s for p in _SENTENCE_PUNCT)


# ===== 推理泄漏闸门（提取入口）=====
# 模型把思维链当正文输出时（首行是「用户要求：…」这类转述），正文里还夹着系统提示词的
# 回显。从这种正文里"提取"出来的知识点是假的——实测一条泄漏正文污染了知识库、知识面板
# 摘要、概念地基与大陆投影四处（40 字假标题 + 2 条中文散文"公式"）。命中即整轮不提取：
# 宁可这一轮什么都没有，也不往库里塞垃圾。
_REASONING_LEAK_MARKERS = (
    "用户要求", "当前分支类型", "注意上下文", "必须只输出", "分支标签是",
    "我认为这里应该", "规则说", "这属于",
)
_REASONING_ECHO_MARKERS = (
    "标签包裹", "尽量少公式", "探索回答簇", "苏格拉底追问", "分支类型", "局部节点",
)


def _looks_like_reasoning_leak(content: str) -> bool:
    """正文首 300 字内命中 ≥2 个推理特征 → 判定为思维链泄漏（保守：单命中不算）。"""
    head = str(content or "")[:300]
    if not head.strip():
        return False
    hits = sum(1 for m in _REASONING_LEAK_MARKERS if m in head)
    hits += sum(1 for m in _REASONING_ECHO_MARKERS if m in head)
    return hits >= 2


def _is_concept_like_title(title: str, limit: int = CONCEPT_TITLE_MAX_CHARS) -> bool:
    """标题是否「像概念名」——大陆共享概念只认它（宁可漏报不可误报）。

    比 _is_junk_knowledge_title 更严：章节号、叙述口吻、超长句一律不参与子串匹配，
    但**不删除条目**（条目照旧是知识卡片，只是不当共享概念的证据来源）。
    """
    s = _strip_knowledge_section(title)
    if _is_junk_knowledge_title(s) or not s:
        return False
    if _SECTION_PREFIX_RE.match(str(title or "")) or _VERBAL_PREFIX_RE.match(s):
        return False
    return len(_clean_knowledge_title(s)) <= limit


def _is_acceptable_knowledge_item(item) -> bool:
    """入库闸门（POST /api/knowledge）：非知识条目拒收；手动条目永不拦。

    浏览器 localStorage 会把本地独有的知识点并集推回服务端，所以删掉的垃圾条目
    随时可能被再推一次——入口拒收才是「删得掉」的保证（实测踩过：清库后又被
    另一个标签页推回来）。
    """
    if not isinstance(item, dict):
        return False
    if str(item.get("source") or "") == "manual":
        return True
    return not _is_junk_knowledge_title(item.get("title"))


def _clean_knowledge_title(title: str) -> str:
    """把学习卡片标题规范成具体知识点名，过滤视角/图谱/追问等模块标题。"""
    title = str(title or "").strip()
    title = re.sub(r"^#+\s*", "", title).splitlines()[0].strip() if title else ""
    title = _strip_knowledge_section(title)
    title = re.sub(r"^.*?PhyMathia\s*学习卡片\s*[:：]\s*", "", title).strip()
    for _ in range(2):
        title = re.sub(r"的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习(?:方向)?|苏格拉底追问|学习方向|相关公式)$", "", title).strip()
    title = re.sub(r"的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$", "", title).strip()
    title = re.sub(r"^[🔬📐🧠💡🗺️]+\s*", "", title).strip()
    return title



def _normalize_knowledge_key(title: str) -> str:
    s = _clean_knowledge_title(title)
    s = re.sub(r"^[#*\-•·>\s]+", "", s)
    s = re.sub(r"[，。；、：:()（）\[\]【】\s]+", "", s)
    return s.lower().strip()


def _summary_source_rank(item: dict) -> int:
    """摘要来源保优等级：manual(0) > model(1) > local/缺失(2)，数值越小越优。

    旧数据无 summarySource 字段一律视为 'local'。
    """
    src = str((item or {}).get("summarySource") or "local")
    if src == "manual":
        return 0
    if src == "model":
        return 1
    return 2


def _dedupe_knowledge(data) -> dict:
    """按规范化标题合并重复知识点（T146 起跨会话全局合并，不再按会话硬分区——
    实测 86 条同名概念重复跨 15 会话，知识面板时间线越积越重复）。

    保优排序：summarySource 等级优先（manual > model > local），长度仅在
    同源时作为 tie-break——避免「手动摘要被更长的 AI 摘要覆盖」以及本地
    整卡摘要把模型逐条摘要又拉回去的来回覆盖。

    跨会话合并保留多会话归属：保留条写 sessionIds（全部归属会话，含自身）。
    大陆投影与按会话删除据此把这张卡算进每一个出现它的画布——去重不能把
    「跨画布共享概念」的信号一起压掉（城市/亲缘全靠跨会话条目活着）。
    """
    data = _normalize_knowledge(data)
    groups = {}
    for item_id, item in data.items():
        if not isinstance(item, dict):
            continue
        title_key = _normalize_knowledge_key(item.get("title", ""))
        if not title_key:
            continue
        groups.setdefault(title_key, []).append((item_id, item))

    remove_ids = []
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda kv: (
            -_summary_source_rank(kv[1]),
            len(str(kv[1].get("summary") or "")),
            len(kv[1].get("formulas") or []),
            kv[1].get("createdAt") or 0,
        ))
        keep_id, keep = group[-1]
        formulas = []
        seen = set()
        # 锚点/摘要继承从最高保优等级成员向下找（reversed：升序排列的组尾是保留条），
        # 与前端 dedupeKnowledgeItems 的 ranked（最优在前）同方向，保证前后端同口径
        for _, it in reversed(group):
            if not keep.get("anchorSummary") and it.get("anchorSummary"):
                keep["anchorSummary"] = it["anchorSummary"]
            for formula in it.get("formulas") or []:
                normalized = _normalize_formula(str(formula))
                if normalized and normalized not in seen:
                    seen.add(normalized)
                    formulas.append(normalized)
        keep["formulas"] = formulas
        # 保留条目摘要为空时不丢整组摘要：从组内非空成员继承摘要文本与锚点；
        # summarySource 保留保留条自身的标记（降级会让 manual 条目在下轮去重中被误删）
        if not str(keep.get("summary") or "").strip():
            for _, other in reversed(group):
                if str(other.get("summary") or "").strip():
                    keep["summary"] = other["summary"]
                    break
        # T146：跨会话归属合并——sessionIds 记录这张概念卡属于哪些画布
        sids = _merge_session_ids(group)
        if len(sids) > 1:
            keep["sessionIds"] = sids
        if not str(keep.get("sessionId") or "") and sids:
            keep["sessionId"] = sids[0]
        for item_id, _ in group:
            if item_id != keep_id:
                remove_ids.append(item_id)

    for item_id in remove_ids:
        data.pop(item_id, None)
    return data


def _dedupe_knowledge_file(account: str = DEFAULT_ACCOUNT) -> None:
    def updater(data):
        return _dedupe_knowledge(data)

    _mutate_json(accounts.resolve_paths(account).knowledge_path, updater)


def _pick_knowledge_title(titles: list, content: str) -> str:
    """优先取学习卡片标题，其次取第一个非模块标题。"""
    module_keywords = (
        "物理直觉", "数学本质", "物理视角", "数学视角",
        "知识图谱", "延伸思考", "进阶学习", "学习方向",
        "苏格拉底追问",
    )
    card_title = next((t for t in titles if "PhyMathia" in t and "学习卡片" in t), None)
    if card_title:
        cleaned = _clean_knowledge_title(card_title)
        if cleaned:
            return cleaned
    for t in titles:
        if any(k in t for k in module_keywords):
            continue
        cleaned = _clean_knowledge_title(t)
        if cleaned:
            return cleaned
    return ""


def _formula_tags_from_content(content: str, formulas: list) -> dict:
    """按公式所在的 <physics>/<math> 区块给公式打标签。"""
    def _section(tag: str) -> str:
        m = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", content, re.I)
        return m.group(1) if m else ""

    physics_content = _section("physics")
    math_content = _section("math")
    result = {}
    for formula in formulas:
        stripped = formula.strip("$").strip()
        tags = []
        if stripped and stripped in physics_content:
            tags.append("物理")
        if stripped and stripped in math_content:
            tags.append("数学")
        if tags:
            result[formula] = tags
    return result


def _local_formula_meaning(latex: str, summary: str, concept: str) -> str:
    """没有描述模型时，为单个公式生成一句具体、简短的含义。"""
    s = _normalize_formula(latex).strip("$").strip()
    s = re.sub(r"\s+", " ", s)
    rules = [
        (r"(\\sum|\\int).*e\^", "傅里叶级数/变换：用指数基元把信号分解为频率成分"),
        (r"\\sum", "傅里叶级数：用离散频率谐波叠加表示周期信号"),
        (r"\\int", "傅里叶变换：把信号分解为连续频率分量的积分表示"),
        (r"^F\s*=\s*-?\s*k\s*x", "胡克定律：回复力与位移大小成正比、方向相反"),
        (r"^T\s*=\s*2\\pi\\sqrt\{\\frac\{m\}\{k\}\}", "简谐运动周期由质量与劲度系数决定"),
        (r"^f\s*=\s*1\s*/\s*T", "频率是周期的倒数"),
        (r"\\omega\s*=\s*\\sqrt\{\\frac\{k\}\{m\}\}", "角频率由劲度系数与质量共同决定"),
        (r"E\s*=\s*\\frac\{1\}\{2\}kA\^2", "简谐运动总机械能与振幅平方成正比"),
        (r"v\(t\).*\\sin", "速度随时间呈正弦变化，相位落后于位移"),
        (r"a\(t\).*\\omega\^2.*x", "加速度与位移反向且成正比"),
        (r"x\(t\).*\\cos", "位移随时间余弦变化，A 为振幅"),
        (r"\\frac\{d\^2x\}\{dt\^2\}.*\\omega\^2.*x", "二阶线性微分方程：加速度与位移成正比且反向"),
    ]
    for pattern, description in rules:
        if re.search(pattern, s):
            return description
    if concept and concept != "相关公式":
        clean_concept = re.sub(r"的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$", "", concept).strip()
        return f"{clean_concept}相关公式：用于描述{clean_concept}的定量关系"
    return "该公式用于描述物理量之间的定量关系"


def _local_knowledge_summary(title: str, formulas: list, category: str) -> str:
    """本地兜底的展示用摘要模板（P4 方案 C，离线确定性）。

    口径：「{标题}」：{首个公式含义（_local_formula_meaning 规则表）}（{分类}）；
    无公式退化为「{标题}」：{分类}知识点。标题与公式含义随条目变化，
    保证不同公式/概念的本地摘要至少文案不同（不再共用同一句整卡摘要）。
    与前端 _buildLocalKnowledgeSummary（chat-features.js）逐字同口径，
    合并保优按 summarySource 等级天然兼容。

    超长（>120）时按预算压缩标题保结构（「」/含义/分类括注保持完整），
    概念回退含义以标题为原料（≈2×标题长），收紧时先用 24 字标题上限压含义；
    末位 120 硬截断仅作兜底——不改变原本就适配的短标题输出（审查修复）。
    """
    t = str(title or "").strip()
    label = "物理" if category == "physics" else "数学" if category == "math" else "其他"
    first_formula = next((str(f).strip() for f in (formulas or []) if str(f or "").strip()), "")
    meaning = _local_formula_meaning(first_formula, "", t).strip() if first_formula else ""
    if meaning:
        s = f"「{t}」：{meaning}（{label}）"
        if len(s) > 120:
            m2 = _local_formula_meaning(first_formula, "", t[:24]).strip() or meaning
            budget = max(120 - len(m2) - len(label) - 5, 1)  # 固定开销：「」：（）共 5 字
            s = f"「{t[:budget]}」：{m2}（{label}）"
        return s[:120]
    s = f"「{t}」：{label}知识点"
    if len(s) > 120:
        budget = max(120 - len(label) - 6, 1)  # 固定开销：「」：知识点共 6 字
        s = f"「{t[:budget]}」：{label}知识点"
    return s[:120]


def _local_extract_knowledge(messages: list) -> list:
    """本地正则兜底提取：从最近的 assistant 消息提取公式与标题"""
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content") or ""
        if not content.strip():
            continue
        if msg.get("branchType") in ("followup", "confused", "socratic"):
            return []
        if _is_socratic_followup(content):
            return []

        formulas = []
        # 优先提取 AI 按规范标注的 <formula>...</formula> 标签（精准公式）
        tagged = re.findall(r"<formula>([\s\S]*?)</formula>", content, re.I)
        if tagged:
            for expr in tagged:
                normalized = _normalize_formula(expr)
                if normalized and _looks_like_formula(normalized) and normalized not in formulas:
                    formulas.append(normalized)
                if len(formulas) >= 8:
                    break
        # 无标注时回退：同时匹配 $$..$$、\(..\)（AI 实际输出格式）、\[..\]、$..$
        if not formulas:
            for m in re.finditer(r"\$\$([^$\n]+)\$\$|\\\((.+?)\\\)|\\\[(.+?)\\\]|\$([^$\n]+)\$", content):
                expr = next((g for g in m.groups() if g), "")
                normalized = _normalize_formula(expr)
                # 过滤单字符/纯命令/纯单位等非公式（如 \(m\)、\(\omega\)、\text{rad/s}）
                if normalized and _looks_like_formula(normalized) and normalized not in formulas:
                    formulas.append(normalized)
                if len(formulas) >= 8:
                    break

        titles = [t.strip() for t in re.findall(r"^#{1,3}\s+(.+?)\s*$", content, re.M) if t.strip()]
        title = _pick_knowledge_title(titles, content)
        if not title:
            text = re.sub(r"<[^>]+>", " ", content)
            text = re.sub(
                r"^\s*#{1,3}\s*(?:[🔬📐🧠💡🗺️]+\s*)?(?:物理视角|数学视角|物理直觉|数学本质|知识图谱|延伸思考)\s*",
                "",
                text,
            )
            text = re.sub(r"\s+", " ", text).strip()
            concept_match = re.match(r"^([^，。；、]{2,24})是", text)
            title = concept_match.group(1) if concept_match else (text[:40] + ("..." if len(text) > 40 else ""))
        # 本地兜底的 title 可能是整段正文的前 40 字（模型推理泄漏时尤其如此）——
        # 与 AI 路径同一把尺子：不像知识点的整条不建，宁缺勿滥
        if _is_junk_knowledge_title(title):
            continue
        c = content[:2000]
        has_math_kw = any(k in c for k in ("方程", "函数", "导数", "积分", "矩阵", "几何", "代数", "微分", "定理", "证明", "数学"))
        has_phy_kw = any(k in c for k in ("物理", "力学", "电磁", "光学", "热", "振动", "波", "场", "力", "能量", "实验"))
        if has_phy_kw and not has_math_kw:
            category = "physics"
        elif has_math_kw and not has_phy_kw:
            category = "math"
        elif has_phy_kw and has_math_kw:
            category = "math" if ("数学本质" in c or "数学视角" in c) else "physics"
        else:
            category = "other"

        formula_tags = _formula_tags_from_content(content, formulas)
        # 整卡摘要原文（正文头 120 字）仅作画布定位锚点（P2 anchorSummary 契约）；
        # 有 <summary> 标签时 main.py 会用其内容覆盖锚点（_extract_summary 口径）
        anchor = re.sub(r"\s+", " ", content)[:120]
        # 展示用摘要（P4 模板化）：「{title}」+ 首个公式含义（本地规则表）+ 分类，
        # 不同公式/概念文案不同；无模型/弱网时不再千篇一律
        summary = _local_knowledge_summary(title, formulas, category)
        tags = ["物理" if category == "physics" else "数学" if category == "math" else "其他"]
        module_key = ""
        for formula in formulas:
            module_key = _formula_module_key(
                {"formula_tags": formula_tags, "tags": tags, "category": category},
                formula,
            )
            if module_key:
                break
        if not module_key:
            module_key = "math" if category == "math" else "physics" if category == "physics" else "answer"
        return [{
            "title": title[:80],
            "category": category,
            "tags": tags,
            "summary": summary,
            # 整卡摘要原文仅作定位锚点（P4 起展示摘要为模板文案，两者分离）
            "anchorSummary": anchor,
            "summarySource": "local",
            "formulas": formulas,
            "formula_tags": formula_tags,
            "moduleKey": module_key,
        }]
    return []



_PROFILE_OP_KINDS = ("new", "confirm", "update", "remove")


def _extract_json_array(text: str, key: str):
    r"""从容错文本中提取 "key": [...] 的数组片段（含方括号），失败返回 None。

    用括号深度扫描而非懒惰正则：fact 文本本身含 `]`（如「物理[选修]」）时，
    `(\[[\s\S]*?\])` 停在第一个 `]` 上，截出的片段 JSON 非法 → 整轮画像
    ops 被静默丢弃（09-20 修复）。扫描跳过字符串字面量内部的括号。"""
    m = re.search(r'"' + re.escape(key) + r'"\s*:\s*\[', text)
    if not m:
        return None
    start = m.end() - 1
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def _parse_profile_facts(text: str) -> list:
    """从提取模型输出中容错解析 profile_facts 候选（旧格式，失败返回空列表）。"""
    if not text:
        return []
    fragment = _extract_json_array(text, "profile_facts")
    if not fragment:
        return []
    try:
        data = json.loads(fragment)
    except (json.JSONDecodeError, ValueError):
        return []
    result = []
    for it in data if isinstance(data, list) else []:
        if isinstance(it, dict) and str(it.get("fact") or "").strip():
            result.append({
                "fact": str(it["fact"]).strip()[:120],
                "category": str(it.get("category") or "other")[:20],
            })
    return result


def _parse_profile_ops(text: str) -> list:
    """从提取模型输出中容错解析 profile_ops 合并操作（失败返回空列表）。"""
    if not text:
        return []
    fragment = _extract_json_array(text, "profile_ops")
    if not fragment:
        return []
    try:
        data = json.loads(fragment)
    except (json.JSONDecodeError, ValueError):
        return []
    result = []
    for it in data if isinstance(data, list) else []:
        if not isinstance(it, dict):
            continue
        kind = str(it.get("op") or "").strip().lower()
        if kind not in _PROFILE_OP_KINDS:
            continue
        result.append({
            "op": kind,
            "id": str(it.get("id") or "").strip()[:32],
            "fact": str(it.get("fact") or "").strip()[:120],
            "category": str(it.get("category") or "other").strip()[:20],
        })
    return result


async def _ai_extract_knowledge(messages: list, provider: str, api_key: str, model: str, base_url: str,
                                level: str = "university", profile_digest: str = "",
                                env_key_used: bool = False) -> tuple:
    """调用 AI 模型提取知识点（非流式），返回 (items, profile_facts, profile_ops) 三元组。"""
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return [], [], []
    # env_key_used 由路由层（resolve_api_key）传入：key 已解析时这里原样返回、
    # 标志沿用入参；直接以空 key 调用（测试/旧调用方）时在本地兜底并计算标志。
    # deepseek 的 env 密钥若不带头衔标志，validate_model_target 会放行任意
    # https 域名，密钥即外发（09-20 SSRF 修复）
    api_key, env_fallback = resolve_api_key(provider, api_key)
    env_key_used = env_key_used or env_fallback
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError:
        # 目标非法（SSRF 防护）：放弃 AI 提取，回退本地规则提取
        return [], [], []

    # 取最近一轮对话（最后一条 user 消息及之后）
    level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
    system_prompt = EXTRACT_PROMPT.replace("{profile_digest}", profile_digest.strip() or "（暂无，首次记录可全部用 new）")
    msgs = [{"role": "system", "content": system_prompt + "\n\n难度要求：" + level_suffix}]
    last_user_idx = -1
    for i, m in enumerate(messages):
        if m.get("role") == "user":
            last_user_idx = i
    if last_user_idx >= 0:
        recent = messages[last_user_idx:]
    else:
        recent = messages[-4:]
    msgs.extend({"role": m.get("role", "user"), "content": (m.get("content") or "")[:4000]} for m in recent)

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    # 网关会话头（opencode 官方要求，缺失会被列 problematic clients）：提取
    # 固定桶，同功能调用落在同一缓存桶，不与对话链路（分支/工作流）互相挤占
    headers.update(opencode_gateway_headers(base_url, "phymathia-extract"))
    body = {"model": model, "messages": msgs, "stream": False, "temperature": 0.3}
    client = get_http_client()
    resp = await client.post(url, json=body, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    if data.get("usage"):
        usage_stats.record_usage(provider, model, "extract", "", data["usage"])
    content = data["choices"][0]["message"]["content"]
    items = _parse_extract_json(content)
    profile_facts = _parse_profile_facts(content)
    profile_ops = _parse_profile_ops(content)
    return items, profile_facts, profile_ops



def _formula_module_key(item: dict, formula: str) -> str:
    module_key = item.get("moduleKey")
    if module_key in ("physics", "math"):
        return module_key
    tags = (item.get("formula_tags") or {}).get(formula) or item.get("tags") or []
    if "数学" in tags:
        return "math"
    if "物理" in tags:
        return "physics"
    category = item.get("category")
    if category == "math":
        return "math"
    if category == "physics":
        return "physics"
    return ""



def _add_formulas_from_items(items: list, session_id: str, descriptions: dict = None, message_id: str = "",
                             account: str = DEFAULT_ACCOUNT) -> int:
    """将提取出的公式自动写入公式库，返回新增数量；descriptions 为 {latex: 简要描述}"""
    if not items:
        return 0
    descriptions = descriptions or {}
    now = int(time.time() * 1000)
    count = 0
    changed = False

    def updater(data):
        nonlocal count, changed
        for it in items:
            title = it.get("title", "")
            summary = it.get("summary", "")
            tags = it.get("tags", [])
            formula_tags = it.get("formula_tags") or {}
            for f in (it.get("formulas") or []):
                latex = _normalize_formula(str(f).strip())
                # 过滤单字符/纯命令/纯单位（双保险：提取层已过滤，入库层再拦一道）
                if not latex or not _looks_like_formula(latex):
                    continue
                existing = next((v for v in data.values()
                                 if _formula_key(v.get("latex")) == _formula_key(latex)), None)
                if existing:
                    # 快速本地提取可能先写入摘要，后续描述模型返回时只更新说明。
                    # T146：同公式跨会话不再各建一条——归属并入 sessionIds。
                    model_description = (descriptions.get(latex) or "").strip()
                    meaning_source = "model" if model_description else "local"
                    description = model_description or _local_formula_meaning(latex, summary, title)
                    old_meaning = (existing.get("meaning") or "").strip()
                    old_source = str(existing.get("meaningSource") or "local")
                    module_key = _formula_module_key(it, latex)
                    if session_id and session_id not in (existing.get("sessionIds") or []) \
                            and session_id != existing.get("sessionId"):
                        existing["sessionIds"] = _merge_session_ids([("keep", existing), ("new", {"sessionId": session_id})])
                        changed = True
                    if message_id and not existing.get("messageId"):
                        existing["messageId"] = message_id
                        changed = True
                    if module_key and not existing.get("moduleKey"):
                        existing["moduleKey"] = module_key
                        changed = True
                    if description and old_meaning != description[:200]:
                        can_update = meaning_source == "model" or old_source != "model"
                        if can_update and (
                            not old_meaning
                            or old_meaning == summary
                            or old_meaning.startswith("该公式")
                            or meaning_source == "model"
                        ):
                            existing["meaning"] = description[:200]
                            existing["meaningSource"] = meaning_source
                            changed = True
                    continue
                fid = "f_" + uuid.uuid4().hex[:12]
                # 描述模型生成的简要描述优先，否则为单个公式生成具体说明
                model_description = (descriptions.get(latex) or "").strip()
                meaning_source = "model" if model_description else "local"
                meaning = model_description or _local_formula_meaning(latex, summary, title)
                data[fid] = {
                    "id": fid,
                    "latex": latex,
                    "concept": title[:80],
                    "meaning": meaning[:200],
                    "meaningSource": meaning_source,
                    "topic": "",
                    "related": formula_tags.get(latex) or tags[:8],
                    "sessionId": session_id,
                    "messageId": message_id,
                    "moduleKey": _formula_module_key(it, latex),
                    "createdAt": now,
                }
                count += 1
        # T146：写入路径顺手做一次全局去重（跨会话旧重复在第一次新写入时收敛）
        return _dedupe_formula_map(data) if count or changed else None

    _mutate_json(accounts.resolve_paths(account).formulas_path, updater)
    return count


def _delete_items_by_session(path: Path, session_id: str) -> int:
    """sessionIds 感知的按会话删除（T146）：条目从该会话的归属里摘除，
    还有别的归属就把主 sessionId 改到剩余归属（孤儿闸门要求 sessionId 指向
    活会话），一个归属都不剩才整条删除。返回受影响条数。"""
    affected = []

    def updater(data):
        nonlocal affected
        if not isinstance(data, dict):
            return None
        changed = False
        for key, item in list(data.items()):
            if not isinstance(item, dict):
                continue
            sids, seen = [], set()
            for sid in [item.get("sessionId"), *(item.get("sessionIds") or [])]:
                s = str(sid or "")
                if s and s not in seen:
                    seen.add(s)
                    sids.append(s)
            if session_id not in sids:
                continue
            rest = [s for s in sids if s != session_id]
            if rest:
                item["sessionId"] = rest[0]
                if len(rest) > 1:
                    item["sessionIds"] = rest
                else:
                    item.pop("sessionIds", None)
            else:
                data.pop(key, None)
            affected.append(key)
            changed = True
        return data if changed else None

    _mutate_json(path, updater)
    return len(affected)



def _extract_summary(messages: list) -> str:
    """从最近 assistant 消息提取 <summary> 标签内容（主模型输出的一句话摘要）"""
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        m = re.search(r"<summary>([\s\S]*?)</summary>", msg.get("content") or "", re.I)
        if m:
            return m.group(1).strip()[:200]
    return ""




async def _describe_formulas(summary: str, formulas: list, knowledge_items: list, provider: str, api_key: str, model: str, base_url: str, level: str = "university", env_key_used: bool = False) -> tuple:
    """调用描述模型，一次返回公式描述与知识点摘要两块（不增加请求数）。

    返回 (descriptions, summaries) 二元组：
    - descriptions: {latex: 公式描述}
    - summaries: {知识点名: 该知识点本身的摘要（≤60字，含公式含义）}
    失败返回 ({}, {})。
    """
    # env_key_used 语义同 _ai_extract_knowledge：路由层已解析则沿用标志，
    # 空 key 直接调用时本地兜底（09-20 SSRF 修复）
    api_key, env_fallback = resolve_api_key(provider, api_key)
    env_key_used = env_key_used or env_fallback
    knowledge_lines = []
    for it in (knowledge_items or []):
        if not isinstance(it, dict):
            continue
        title = str(it.get("title") or "").strip()
        if not title:
            continue
        fs = "、".join(str(f) for f in (it.get("formulas") or []) if str(f).strip())
        knowledge_lines.append(f"- {title}" + (f"（公式：{fs}）" if fs else ""))
    if (not formulas and not knowledge_lines) or not model:
        return {}, {}
    # 以下三条拒绝路径也必须返回二元组：main.py 对返回值做元组解包，
    # 漏改成裸 {} 会让 /api/extract_knowledge 整个 500
    if not api_key and provider not in ("opencode", "opencode-go"):
        return {}, {}
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return {}, {}
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError:
        return {}, {}
    user_parts = [f"对话摘要：{summary[:300]}"]
    if formulas:
        user_parts.append("公式列表：\n" + "\n".join(f"- {f}" for f in formulas))
    if knowledge_lines:
        user_parts.append("知识点列表：\n" + "\n".join(knowledge_lines))
    msgs = [
        {"role": "system", "content": DESCRIBE_PROMPT + "\n\n难度要求：" + LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])},
        {"role": "user", "content": "\n".join(user_parts)},
    ]
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(opencode_gateway_headers(base_url, "phymathia-describe"))
    body = {"model": model, "messages": msgs, "stream": False, "temperature": 0.2}
    try:
        client = get_http_client()
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        if data.get("usage"):
            usage_stats.record_usage(provider, model, "describe", "", data["usage"])
        content = data["choices"][0]["message"]["content"]
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            return {}, {}
        parsed = json.loads(m.group(0))
        descs = parsed.get("descriptions", {}) if isinstance(parsed, dict) else {}
        result = {}
        for k, v in descs.items():
            if isinstance(v, str) and v.strip():
                normalized_key = _normalize_formula(k)
                if normalized_key:
                    result[normalized_key] = v.strip()[:80]
        summaries = {}
        raw_summaries = parsed.get("summaries", {}) if isinstance(parsed, dict) else {}
        if isinstance(raw_summaries, dict):
            for k, v in raw_summaries.items():
                if isinstance(v, str) and v.strip():
                    summaries[str(k).strip()[:80]] = v.strip()[:200]
        return result, summaries
    except Exception as e:
        logger.warning(f"Describe formulas failed: {e}")
        return {}, {}



def _normalize_formula_map(data) -> dict:
    if isinstance(data, dict):
        if "items" in data:
            items = data["items"]
            if isinstance(items, dict):
                return items
            if isinstance(items, list):
                return {it.get("id") or ("f_" + uuid.uuid4().hex[:12]): it
                        for it in items if isinstance(it, dict)}
            return {}
        return data
    if isinstance(data, list):
        return {it.get("id") or ("f_" + uuid.uuid4().hex[:12]): it
                for it in data if isinstance(it, dict)}
    return {}



__all__ = [
    "_normalize_knowledge", "_normalize_formula", "_formula_key",
    "_looks_like_formula", "_dedupe_formula_map", "_normalize_formula_map",
    "_parse_extract_json", "_parse_profile_facts", "_parse_profile_ops", "_clean_knowledge_title", "_normalize_knowledge_key",
    "_strip_knowledge_section", "_is_junk_knowledge_title", "_is_concept_like_title",
    "_looks_like_reasoning_leak", "_is_acceptable_knowledge_item",
    "_summary_source_rank", "_dedupe_knowledge", "_dedupe_knowledge_file", "_pick_knowledge_title",
    "_formula_tags_from_content", "_local_formula_meaning", "_local_knowledge_summary",
    "_local_extract_knowledge",
    "_ai_extract_knowledge", "_formula_module_key", "_add_formulas_from_items",
    "_extract_summary", "_describe_formulas", "_delete_items_by_session",
]
