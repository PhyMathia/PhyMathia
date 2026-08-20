"""知识点与公式：提取、归一化、去重、描述。"""

import json
import logging
import os
import re
import time
import uuid

from http_client import get_http_client

from .config import (
    AI_PROVIDERS,
    FORMULAS_PATH,
    KNOWLEDGE_PATH,
    LEVEL_PROMPTS,
    OPENCODE_DEFAULT_API_KEY,
)
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
    """标准化公式：\$→$、去首尾 $、统一包 $..$；无效返回空串"""
    s = (latex or "").strip()
    s = s.replace("\\$", "$").strip()
    s = re.sub(r"^\$+|\$+$", "", s).strip()
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
    # 其余视为公式（含 = + - ( ) { } 数字、函数结构等）
    return True


def _dedupe_formula_map(data: dict) -> dict:
    """按会话+规范化公式去重，保留较新的记录。"""
    groups = {}
    for fid, item in data.items():
        if not isinstance(item, dict):
            continue
        key = (_formula_key(item.get("latex") or ""), item.get("sessionId"))
        groups.setdefault(key, []).append((fid, item))
    result = {}
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
        result[keep_id] = keep
    return result



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
            "summary": str(it.get("summary", ""))[:200],
            "formulas": formulas[:8],
            "moduleKey": module_key,
        })
    return result[:6]


def _clean_knowledge_title(title: str) -> str:
    """把学习卡片标题规范成具体知识点名，过滤视角/图谱/追问等模块标题。"""
    title = str(title or "").strip()
    title = re.sub(r"^#+\s*", "", title).splitlines()[0].strip() if title else ""
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


def _dedupe_knowledge(data) -> dict:
    """按 sessionId + 规范化标题合并同一会话内的重复知识点。"""
    data = _normalize_knowledge(data)
    groups = {}
    for item_id, item in data.items():
        if not isinstance(item, dict):
            continue
        session_id = item.get("sessionId", "")
        title_key = _normalize_knowledge_key(item.get("title", ""))
        if not session_id or not title_key:
            continue
        groups.setdefault((session_id, title_key), []).append((item_id, item))

    remove_ids = []
    for group in groups.values():
        if len(group) < 2:
            continue
        group.sort(key=lambda kv: (
            len(str(kv[1].get("summary") or "")),
            len(kv[1].get("formulas") or []),
            kv[1].get("createdAt") or 0,
        ))
        keep_id, keep = group[-1]
        formulas = []
        seen = set()
        for _, it in group:
            for formula in it.get("formulas") or []:
                normalized = _normalize_formula(str(formula))
                if normalized and normalized not in seen:
                    seen.add(normalized)
                    formulas.append(normalized)
        keep["formulas"] = formulas
        for item_id, _ in group:
            if item_id != keep_id:
                remove_ids.append(item_id)

    for item_id in remove_ids:
        data.pop(item_id, None)
    return data


def _dedupe_knowledge_file() -> None:
    def updater(data):
        return _dedupe_knowledge(data)

    _mutate_json(KNOWLEDGE_PATH, updater)


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
        summary = re.sub(r"\s+", " ", content)[:120]
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
            "formulas": formulas,
            "formula_tags": formula_tags,
            "moduleKey": module_key,
        }]
    return []



_PROFILE_FACTS_RE = re.compile(r'"profile_facts"\s*:\s*(\[[\s\S]*?\])')


def _parse_profile_facts(text: str) -> list:
    """从提取模型输出中容错解析 profile_facts 候选（失败返回空列表）。"""
    if not text:
        return []
    m = _PROFILE_FACTS_RE.search(text)
    if not m:
        return []
    try:
        data = json.loads(m.group(1))
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


async def _ai_extract_knowledge(messages: list, provider: str, api_key: str, model: str, base_url: str, level: str = "university") -> tuple:
    """调用 AI 模型提取知识点（非流式），返回 (items, profile_facts) 二元组。"""
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return [], []
    if not api_key and provider == "opencode-go":
        api_key = os.getenv("OPENCODE_GO_API_KEY", "") or os.getenv("OPENCODE_API_KEY", "")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY

    # 取最近一轮对话（最后一条 user 消息及之后）
    level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
    msgs = [{"role": "system", "content": EXTRACT_PROMPT + "\n\n难度要求：" + level_suffix}]
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
    body = {"model": model, "messages": msgs, "stream": False, "temperature": 0.3}
    client = get_http_client()
    resp = await client.post(url, json=body, headers=headers)
    resp.raise_for_status()
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    items = _parse_extract_json(content)
    profile_facts = _parse_profile_facts(content)
    return items, profile_facts



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



def _add_formulas_from_items(items: list, session_id: str, descriptions: dict = None, message_id: str = "") -> int:
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
                                 if _formula_key(v.get("latex")) == _formula_key(latex)
                                 and v.get("sessionId") == session_id), None)
                if existing:
                    # 快速本地提取可能先写入摘要，后续描述模型返回时只更新说明。
                    model_description = (descriptions.get(latex) or "").strip()
                    meaning_source = "model" if model_description else "local"
                    description = model_description or _local_formula_meaning(latex, summary, title)
                    old_meaning = (existing.get("meaning") or "").strip()
                    old_source = str(existing.get("meaningSource") or "local")
                    module_key = _formula_module_key(it, latex)
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
        return data if count or changed else None

    _mutate_json(FORMULAS_PATH, updater)
    return count



def _extract_summary(messages: list) -> str:
    """从最近 assistant 消息提取 <summary> 标签内容（主模型输出的一句话摘要）"""
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        m = re.search(r"<summary>([\s\S]*?)</summary>", msg.get("content") or "", re.I)
        if m:
            return m.group(1).strip()[:200]
    return ""




async def _describe_formulas(summary: str, formulas: list, provider: str, api_key: str, model: str, base_url: str, level: str = "university") -> dict:
    """调用描述模型为公式生成简要描述，返回 {latex: 描述}；失败返回空 dict"""
    if not api_key and provider == "opencode-go":
        api_key = os.getenv("OPENCODE_GO_API_KEY", "") or os.getenv("OPENCODE_API_KEY", "")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY
    if not formulas or not model:
        return {}
    if not api_key and provider not in ("opencode", "opencode-go"):
        return {}
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return {}
    msgs = [
        {"role": "system", "content": DESCRIBE_PROMPT + "\n\n难度要求：" + LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])},
        {"role": "user", "content": f"对话摘要：{summary[:300]}\n公式列表：\n" + "\n".join(f"- {f}" for f in formulas)},
    ]
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    body = {"model": model, "messages": msgs, "stream": False, "temperature": 0.2}
    try:
        client = get_http_client()
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            return {}
        parsed = json.loads(m.group(0))
        descs = parsed.get("descriptions", {}) if isinstance(parsed, dict) else {}
        result = {}
        for k, v in descs.items():
            if isinstance(v, str) and v.strip():
                normalized_key = _normalize_formula(k)
                if normalized_key:
                    result[normalized_key] = v.strip()[:80]
        return result
    except Exception as e:
        logger.warning(f"Describe formulas failed: {e}")
        return {}



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
    "_parse_extract_json", "_parse_profile_facts", "_clean_knowledge_title", "_normalize_knowledge_key",
    "_dedupe_knowledge", "_dedupe_knowledge_file", "_pick_knowledge_title",
    "_formula_tags_from_content", "_local_formula_meaning", "_local_extract_knowledge",
    "_ai_extract_knowledge", "_formula_module_key", "_add_formulas_from_items",
    "_extract_summary", "_describe_formulas",
]
