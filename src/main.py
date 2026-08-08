"""
PhyMathia Web Application - 物理数学双域解释与可视化助手 (离线测试版)

使用固定 mock 回答代替 AI API，方便前端功能测试。
数据持久化使用 JSON 文件存储，无需 Supabase 或任何外部服务。
"""

import argparse
import asyncio
import base64
import io
import json
import logging
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ====== .env 加载（无第三方依赖）======
def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file(Path(__file__).resolve().parent.parent / ".env")

# ====== 数据持久化目录 ======
BASE_DIR = Path(__file__).resolve().parent
ROOT_DIR = BASE_DIR.parent
DATA_DIR = BASE_DIR.parent / "data"
MESSAGES_DIR = DATA_DIR / "messages"
DATA_DIR.mkdir(parents=True, exist_ok=True)
MESSAGES_DIR.mkdir(parents=True, exist_ok=True)

SESSIONS_PATH = DATA_DIR / "sessions.json"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.json"
KV_PATH = DATA_DIR / "kv_store.json"
FORMULAS_PATH = DATA_DIR / "formulas.json"
UPLOAD_DIR = DATA_DIR / "uploads"
UPLOADS_META_PATH = DATA_DIR / "uploads.json"
UPLOAD_MAX_BYTES = 20 * 1024 * 1024
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

# ====== FastAPI 应用 ======
app = FastAPI(title="PhyMathia", description="物理数学双域解释与可视化助手 (离线测试版)")

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from harness.api import router as harness_router

app.include_router(harness_router, prefix="/api/harness")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ====== 静态文件配置 ======
STATIC_DIR = BASE_DIR / "static"
STATIC_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".svg", ".gif", ".ico", ".html", ".md",
    ".webp", ".css", ".js", ".woff", ".woff2", ".ttf",
}


# ====== JSON 文件持久化工具 ======
_JSON_LOCK = threading.RLock()


def _read_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return default if default is not None else {}


def _write_json(path: Path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with _JSON_LOCK:
        try:
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(tmp_path, path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


def _mutate_json(path: Path, updater, default=None):
    """串行执行 JSON 文件的读-改-写，避免并发请求互相覆盖。"""
    with _JSON_LOCK:
        data = _read_json(path, default)
        result = updater(data)
        if result is not None:
            _write_json(path, result)
            return result
        return data


def _delete_by_session(path: Path, session_id: str) -> int:
    """删除数据中属于指定会话的条目，返回删除数量。"""
    removed = []

    def updater(data):
        nonlocal removed
        removed = [k for k, v in data.items() if v.get("sessionId") == session_id]
        for k in removed:
            data.pop(k, None)
        return data if removed else None

    _mutate_json(path, updater)
    return len(removed)


def _get_messages_path(session_id: str) -> Path:
    return MESSAGES_DIR / f"{session_id}.json"


def _resolve_messages_path(session_id: str) -> Path:
    """兼容两种会话标识：local key 直接找消息文件，server sessionId 反向查 sessions.json。"""
    direct = _get_messages_path(session_id)
    if direct.exists():
        return direct
    sessions = _read_json(SESSIONS_PATH, {})
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId") == session_id:
            return _get_messages_path(sid)
    return direct


# ====== System Prompt & Level Prompts ======
def _load_system_prompt() -> str:
    """从 system prompt.md 加载系统提示词，失败时使用默认提示词"""
    prompt_path = BASE_DIR / "system prompt.md"
    if prompt_path.exists():
        content = prompt_path.read_text(encoding="utf-8").strip()
        logger.info(f"Loaded system prompt from {prompt_path} ({len(content)} chars)")
        return content
    logger.warning(f"System prompt file not found: {prompt_path}, using default")
    return """你是一个物理数学双域解释与可视化助手 PhyMathia。
请按以下格式组织回答，用 XML 标签包裹各部分，不要省略任何部分：

<physics>
物理视角的内容...
</physics>

<math>
数学视角的内容...
</math>

<graph>
知识图谱 Mermaid 代码，只放 Mermaid，不要放 HTML...
</graph>

<viz>
HTML 可视化代码（可选，用 ```html ... ``` 包裹）
</viz>

<extend>
进阶学习与引导，包含苏格拉底追问与进阶学习方向...
</extend>

规则：
- 物理视角：侧重物理直觉、实验现象、能量角度，少量公式
- 数学视角：侧重数学推导、微分方程、对称性，可深入公式
- 知识图谱：输出 Mermaid 代码，用 ```mermaid ... ``` 包裹；<graph> 内不要放 HTML
- 可视化：如果适合，在 <viz> 标签内输出完整 HTML，用 ```html ... ``` 包裹
- 延伸思考：2-3个引导性问题，可带难度标注
- 如果问题只偏一方，两个标题都要保留，内容可简短
- 可视化 HTML 用 ```html ... ``` 包裹（必要时可单独输出）
"""

SYSTEM_PROMPT = _load_system_prompt()
app.state.harness_context = SYSTEM_PROMPT

LEVEL_PROMPTS = {
    "middle": "（用户是初高中学生，请用最通俗易懂的语言讲解，避免使用大学水平的术语，多用生活中的类比，公式尽量简化，数学推导步骤详细不跳步）",
    "university": "（用户是大学生，请用标准大学物理/数学的教学深度讲解，可以使用专业术语但需要解释，推导步骤完整）",
    "research": "（用户是科研人员，请用学术深度讲解，可以使用高级数学工具和前沿研究视角，推导可以简略关键步骤，关注物理本质和数学结构的深层联系）",
}

STRICT_MODULE_MAX_TOKENS = 1000


def _is_socratic_message(msg) -> bool:
    """识别苏格拉底支线消息，兼容新 branch 字段和历史内容标记。"""
    if not isinstance(msg, dict):
        return False
    if msg.get("branch") == "socratic" or msg.get("branchType") == "socratic":
        return True
    content = str(msg.get("content") or "")
    if content.lstrip().startswith("[苏格拉底回答]"):
        return True
    if content.lstrip().startswith("我的回答："):
        return True
    if re.search(r"<socratic_meta\b", content, re.I) and not re.search(
        r"<physics>|<math>|<graph>|<extend>|PhyMathia\s*学习卡片", content, re.I
    ):
        return True
    return False


def _recent_context_messages(all_messages: list, max_rounds: int = 3, include_socratic: bool = False) -> list:
    """按最近用户轮次截取上下文，保留消息内容但剥离分支元数据。"""
    messages = all_messages
    if not include_socratic:
        messages = [msg for msg in all_messages if not _is_socratic_message(msg)]
    result = []
    rounds = 0
    for msg in reversed(messages):
        result.insert(0, {"role": msg.get("role", "user"), "content": msg.get("content", "")})
        if msg.get("role") == "user":
            rounds += 1
            if rounds >= max_rounds:
                break
    return result


def _extract_section(content: str, tag: str) -> str:
    match = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", content or "", re.I)
    return match.group(1).strip() if match else ""


def _branch_source_content(content: str, source_module: str) -> str:
    """从父回答中只取出当前分支聚焦的模块内容。"""
    if source_module in ("physics", "math", "graph", "extend"):
        return _extract_section(content, source_module)
    if source_module in ("viz", "visualization"):
        viz = _extract_section(content, "viz")
        if viz:
            return viz
        graph = _extract_section(content, "graph")
        html_match = re.search(r"```html\s*([\s\S]*?)```", graph, re.I)
        if html_match:
            return f"```html\n{html_match.group(1)}\n```"
        return graph
    return content or ""


def _load_session_context(
    session_id: str,
    max_rounds: int = 3,
    include_socratic: bool = False,
    branch_id: str = "",
    branch_type: str = "",
    source_module: str = "",
    parent_id: str = "",
    graph_path: list = None,
) -> list:
    """加载会话上下文消息，支持探索网分支隔离。

    普通问答默认过滤苏格拉底支线；当传入 branch_id 时，保留主线最近内容、
    父回答中聚焦模块的内容，以及该分支自己的消息链。
    """
    messages_path = _resolve_messages_path(session_id)
    all_messages = _read_json(messages_path, [])
    if not all_messages:
        return []
    if graph_path:
        return _load_session_context_from_path(
            session_id,
            graph_path,
            branch_id=branch_id,
            source_module=source_module,
            max_rounds=max_rounds,
        )
    if not branch_id:
        return _recent_context_messages(all_messages, max_rounds, include_socratic)

    branch_messages = [msg for msg in all_messages if msg.get("branchId") == branch_id]
    main_messages = [msg for msg in all_messages if not msg.get("branchId") and not _is_socratic_message(msg)]
    result = _recent_context_messages(main_messages, min(2, max_rounds), False)
    seen = {item["content"] for item in result}

    target_parent = parent_id or (branch_messages[0].get("parentId") if branch_messages else "")
    if target_parent:
        for msg in all_messages:
            if msg.get("role") == "assistant" and str(msg.get("timestamp")) == str(target_parent):
                source = _branch_source_content(msg.get("content", ""), source_module)
                if source and source not in seen:
                    result.append({"role": "assistant", "content": source})
                    seen.add(source)
                break

    for item in _recent_context_messages(branch_messages, max_rounds, True):
        if item["content"] not in seen:
            result.append(item)
            seen.add(item["content"])
    return result


def _branch_context_instruction(
    branch_type: str = "",
    source_module: str = "",
    branch_label: str = "",
    parent_id: str = "",
) -> str:
    """为 AI 提供当前探索网分支的显式上下文。"""
    labels = {
        "followup": "追问",
        "confused": "没看懂",
        "socratic": "苏格拉底追问",
        "learn": "进阶学习",
        "continue": "自由续问",
        "blank": "空白节点",
    }
    module_labels = {
        "physics": "物理视角",
        "math": "数学视角",
        "graph": "知识图谱",
        "viz": "交互可视化",
        "socratic": "苏格拉底追问",
        "learn": "进阶学习",
    }
    lines = ["\n\n# 探索网分支上下文"]
    lines.append(f"- 当前分支类型：{labels.get(branch_type, branch_type or '主线')}")
    if source_module:
        lines.append(f"- 当前聚焦气泡：{module_labels.get(source_module, source_module)}")
    if branch_label:
        lines.append(f"- 分支标签：{branch_label}")
    if parent_id:
        lines.append(f"- 父回答消息 ID：{parent_id}")
    if branch_type == "confused":
        lines.append("- 用户没有看懂当前聚焦气泡，请换更简单、更生活化的方式只重讲这个模块，不要重复其他模块。")
    elif branch_type == "followup":
        lines.append("- 用户希望对当前聚焦气泡继续深入，只围绕该模块增量讲解，不重新生成完整学习卡片。")
    elif branch_type == "socratic":
        lines.append("- 用户正在回答苏格拉底追问，请按闭环规则只推进一层，不直接给出完整答案。")
    elif branch_type == "learn":
        lines.append("- 用户选择了进阶学习方向，请以该方向为目标，基于父回答生成新的完整探索回答簇。")
    elif branch_type == "continue":
        lines.append("- 用户在当前节点自由续问；若问题与当前气泡无关，可以作为新主线回答。")
    elif branch_type == "blank":
        lines.append("- 用户通过空白画布节点要求生成该模块的正文；只输出该模块内容，不要输出完整学习卡片的 XML 标签。")
        strict_instruction = _module_output_instruction(source_module)
        if strict_instruction:
            lines.append(strict_instruction)
    return "\n".join(lines)


def _module_output_instruction(module_key: str) -> str:
    if module_key == "socratic":
        return (
            "严格输出苏格拉底追问小节，格式如下，不得增加任何前言、答案、解释或无关小节：\n"
            "### 苏格拉底追问\n"
            "1. [基础] 只写一个基础引导问题\n"
            "2. [进阶] 只写一个进阶引导问题\n"
            "3. [拓展] 只写一个拓展引导问题\n"
            "禁止输出 XML 标签，禁止输出“进阶学习方向”，禁止展开问题背景或写“想一想”等引导语。"
        )
    if module_key == "learn":
        return (
            "严格输出进阶学习方向小节，格式如下，不得增加任何前言、公式段、步骤讲解或无关小节：\n"
            "### 进阶学习方向\n"
            "1. 方向1\n"
            "2. 方向2\n"
            "3. 方向3\n"
            "禁止输出 XML 标签，禁止输出“苏格拉底追问”，每条方向只保留一个短句。"
        )
    return ""


def _graph_message_summary(message: dict, module_key: str = "") -> str:
    content = str(message.get("content") or "")
    if module_key:
        content = _branch_source_content(content, module_key)
    match = re.search(r"<summary>([\s\S]*?)</summary>", content, re.I)
    if match:
        return match.group(1).strip()[:200]
    text = re.sub(r"<[^>]+>", " ", content)
    text = re.sub(r"\s+", " ", text).strip()
    return text[:180]


def _graph_path_instruction(graph_path: list, source_module: str = "") -> str:
    if not graph_path:
        return ""
    labels = {
        "user": "问题",
        "answer": "AI 回答簇",
        "module": "模块",
    }
    module_labels = {
        "physics": "物理视角",
        "math": "数学视角",
        "graph": "知识图谱",
        "viz": "交互可视化",
        "socratic": "苏格拉底追问",
        "learn": "进阶学习",
    }
    lines = ["\n\n# 当前探索路径"]
    for index, item in enumerate(graph_path):
        kind = item.get("kind") or ""
        module_key = item.get("module") or ""
        branch_type = item.get("branchType") or item.get("branch_type") or ""
        if kind == "module":
            label = module_labels.get(module_key, module_key or "模块")
        elif kind == "answer":
            label = labels.get("answer", "AI 回答簇")
        elif kind == "user":
            label = "延伸追问" if branch_type else labels.get("user", "问题")
        else:
            label = kind or "节点"
        lines.append(f"{index + 1}. {label}（消息 ID：{item.get('timestamp') or ''}）")
    if source_module:
        lines.append(f"- 当前聚焦气泡：{module_labels.get(source_module, source_module)}")
    lines.append("- 上下文只围绕当前探索路径展开；上游节点以摘要形式提供，当前节点可提供该模块正文。")
    if source_module in ("socratic", "learn"):
        lines.append("- 当前节点为 socratic/learn 局部节点，必须只输出三行列表，不要展开为完整讲解。")
    lines.append("- 不要重新展开无关分支，也不要重复其他模块的完整内容。")
    return "\n".join(lines)


def _workflow_context_instruction(workflow_context) -> str:
    if not isinstance(workflow_context, dict):
        return ""
    mode = workflow_context.get("mode") or ""
    target = workflow_context.get("target") or {}
    question = str(workflow_context.get("question") or "").strip()
    analysis = str(workflow_context.get("analysis") or "").strip()
    requirements = str(workflow_context.get("requirements") or "").strip()
    upstream = workflow_context.get("upstream") or []
    lines = ["\n\n# 工作流节点上下文"]
    if mode == "analysis":
        lines.append("- 当前为隐藏问题分析模式：只输出简洁问题概要，不生成任何模块内容，不输出 XML 标签，不生成完整回答。")
    if target:
        target_label = target.get("label") or target.get("module") or target.get("kind") or "目标节点"
        lines.append(f"- 当前生成目标：{target_label}")
        if target.get("module"):
            lines.append(f"- 当前模块：{target['module']}")
        if target.get("kind") == "module":
            lines.append("- 当前为局部节点生成模式：只生成该模块正文，不要输出完整学习卡片，不要输出其他模块。")
            strict_instruction = _module_output_instruction(target.get("module", ""))
            if strict_instruction:
                lines.append(strict_instruction)
        elif target.get("kind") == "answer":
            lines.append("- AI 回答节点是分发节点，不生成正文内容。")
        elif target.get("kind") == "summary":
            lines.append("- 当前为 AI 总结节点：根据上游内容生成简明总结正文。")
            lines.append("- 只输出总结正文，可使用 Markdown/LaTeX；不要输出完整学习卡片 XML，不要输出 physics/math/graph/viz/extend/summary 标签，不要输出 socratic_meta。")
            lines.append("- 总结中如出现公式，仍按全局 <formula> 规范标注，不标注单个符号或单位。")
        elif target.get("kind") == "hub":
            lines.append("- 汇聚节点只负责收集上游内容，不生成正文。")
        elif target.get("kind") == "note":
            lines.append("- 人工总结节点由用户手动填写，AI 不生成正文。")
    if question:
        lines.append(f"- 原始问题：{question[:1200]}")
    if analysis:
        lines.append(f"- 隐藏问题分析（用于保持一致）：{analysis[:1200]}")
    for item in upstream[:8]:
        label = item.get("label") or item.get("kind") or "上游节点"
        content = str(item.get("summary") or item.get("content") or "").strip()
        if content:
            lines.append(f"- {label}：{content[:800]}")
    if requirements:
        lines.append(f"- 用户额外要求：{requirements[:600]}")
    lines.append("- 只生成当前目标节点内容，不重新生成完整回答；上游内容以摘要形式提供，不要重复无关模块。")
    return "\n".join(lines)


def _load_session_context_from_path(
    session_id: str,
    graph_path: list,
    branch_id: str = "",
    source_module: str = "",
    max_rounds: int = 3,
) -> list:
    messages_path = _resolve_messages_path(session_id)
    all_messages = _read_json(messages_path, [])
    if not all_messages or not graph_path:
        return []
    by_ts = {str(msg.get("timestamp") or ""): msg for msg in all_messages}
    result = []
    seen = set()
    active_index = len(graph_path) - 1

    for index, item in enumerate(graph_path):
        msg = by_ts.get(str(item.get("timestamp") or ""))
        if not msg:
            continue
        is_active = index == active_index
        role = msg.get("role") or "assistant"
        module_key = item.get("module") or item.get("moduleKey") or ""
        if role == "user":
            content = str(msg.get("content") or "")
        elif is_active:
            content = str(msg.get("content") or "")
            if module_key:
                content = _branch_source_content(content, module_key)
        else:
            content = _graph_message_summary(msg, module_key if not is_active else "")
        if not content or content in seen:
            continue
        result.append({"role": role, "content": content})
        seen.add(content)

    if branch_id:
        branch_messages = [
            msg for msg in all_messages
            if str(msg.get("branchId") or "") == str(branch_id)
        ]
        for item in _recent_context_messages(branch_messages, max_rounds, True):
            if item["content"] not in seen:
                result.append(item)
                seen.add(item["content"])
    return result


# ====== 苏格拉底追问状态 ======
SOCRATIC_STATE_PREFIX = "socratic:"


def _socratic_key(ref: str) -> str:
    return f"{SOCRATIC_STATE_PREFIX}{ref}"


def _read_socratic_state(ref: str):
    data = _read_json(KV_PATH, {})
    state = data.get(_socratic_key(ref))
    if isinstance(state, dict) and state.get("active"):
        return state
    return None


def _write_socratic_state(ref: str, state) -> None:
    def updater(data):
        if state is None:
            data.pop(_socratic_key(ref), None)
        else:
            state["updatedAt"] = int(time.time() * 1000)
            data[_socratic_key(ref)] = state
        return data

    _mutate_json(KV_PATH, updater)


def _delete_socratic_state(ref: str) -> None:
    def updater(data):
        if not ref:
            return data
        remove_keys = [key for key in data if key.startswith(SOCRATIC_STATE_PREFIX) and ref in key]
        for key in remove_keys:
            data.pop(key, None)
        return data

    _mutate_json(KV_PATH, updater)


def _socratic_state_instruction(ref: str) -> str:
    state = _read_socratic_state(ref)
    if not state:
        return ""
    level = state.get("level", "") or "basic"
    streak = int(state.get("correctStreak", 0) or 0)
    question = state.get("question", "") or ""
    return (
        f"当前会话处于苏格拉底追问闭环：问题等级={level}，当前问题={question}，已连续答对 {streak} 次。"
        "用户会以 [苏格拉底回答] 开头携带追问问题与自己的回答；请结合最近一条 AI 讲解、当前问题和用户回答继续，"
        "按系统提示词中的闭环规则只推进一层，并在回复末尾输出 <socratic_meta .../>。"
    )


def _update_socratic_state_from_content(content: str, ref: str) -> None:
    """解析模型输出的 <socratic_meta>，更新或结束分支级追问状态。"""
    if not content or not ref:
        return
    if not _is_socratic_followup(content):
        return
    match = re.search(r"<socratic_meta\b([^>]*?)/?>", content, re.I)
    if not match:
        return

    attrs = match.group(1)
    def attr(name: str, default: str = "") -> str:
        found = re.search(rf'\b{name}\s*=\s*["\']([^"\']*)["\']', attrs, re.I)
        return found.group(1) if found else default

    correct = attr("correct", "").strip().lower()
    done = attr("done", "").strip().lower() in ("1", "true", "yes")
    state = _read_socratic_state(ref) or {
        "active": True,
        "level": "",
        "question": "",
        "correctStreak": 0,
        "answeredCount": 0,
    }
    state["active"] = True
    if correct == "correct":
        state["correctStreak"] = int(state.get("correctStreak", 0) or 0) + 1
    elif correct in ("partial", "wrong"):
        state["correctStreak"] = 0
    state["answeredCount"] = int(state.get("answeredCount", 0) or 0) + 1

    if done or int(state.get("correctStreak", 0) or 0) >= 2:
        _delete_socratic_state(ref)
    else:
        _write_socratic_state(ref, state)


# ====== 固定 Mock 回答 ======
MOCK_ANSWER = r"""<physics>
## 🔬 物理视角

简谐运动是物体在回复力 <formula>F=-kx</formula> 作用下的周期性运动。想象一个弹簧振子：当你拉长弹簧后松手，物体会在平衡位置附近来回振荡。

关键物理量：
- **振幅 A**：最大偏离距离
- **周期 T**：完成一次完整振动的时间，<formula>T = 2\pi\sqrt{\frac{m}{k}}</formula>
- **频率 f**：单位时间内振动次数，<formula>f = 1/T</formula>

在振动过程中，动能和势能不断相互转换，但总机械能守恒：
<formula>E_{\text{total}} = \frac{1}{2}kA^2</formula>

</physics>
<math>
## 📐 数学视角

简谐运动的位移随时间变化满足正弦函数：
<formula>x(t) = A\cos(\omega t + \varphi_0)</formula>

其中角频率 <formula>\omega = \sqrt{\frac{k}{m}}</formula>，φ₀ 是初相位。

速度与加速度：
<formula>v(t) = -A\omega\sin(\omega t + \varphi_0)</formula>
<formula>a(t) = -A\omega^2\cos(\omega t + \varphi_0) = -\omega^2 x(t)</formula>

可见加速度始终与位移方向相反、大小成正比，这正是简谐运动的数学本质——二阶线性微分方程：
<formula>\frac{d^2x}{dt^2} + \omega^2 x = 0</formula>

</math>
<graph>
## 🧠 知识图谱

```mermaid
graph TD
    A[简谐运动] --> B[物理特征]
    A --> C[数学描述]
    B --> D[回复力 F=-kx]
    B --> E[能量守恒]
    B --> F[周期 T=2π√(m/k)]
    C --> G[正弦/余弦函数]
    C --> H[微分方程]
    C --> I[相空间椭圆]
    G --> J[x=Acos(ωt+φ₀)]
    H --> K[ẍ+ω²x=0]
```

</graph>
<viz>
## 🎮 交互探索
```html
__PHYMATHIA_VISUALIZATION__
```
</viz>
<extend>
## 💡 延伸思考

### 苏格拉底追问
1. [基础] 为什么阻尼振动中的能量会逐渐耗散？可以从哪个物理机制解释？
2. [进阶] 如果加入线性阻尼项 c(dx/dt)，简谐运动的微分方程会变成什么形式？
3. [拓展] 复数和相量如何简化简谐运动的叠加分析？

### 进阶学习方向
1. 阻尼振荡器与品质因数
2. 受迫振动与共振曲线
3. 傅里叶分析在振动分解中的应用
</extend>

<summary>简谐运动是回复力与位移成正比的周期运动，能量在动能与势能间周期转换</summary>"""


MOCK_SOCRATIC_ANSWER_1 = r"""你的推理方向是对的。阻尼会持续消耗机械能，所以振幅会衰减。

那如果加入线性阻尼项 <formula>c\dot{x}</formula>，微分方程会变成什么形式？

<socratic_meta correct="correct" done="false" />"""


MOCK_SOCRATIC_ANSWER_2 = r"""你已经连续答对两次，这段追问就到这里。

小结：阻尼振动通过耗散机械能降低振幅，数学上用含 <formula>c\dot{x}</formula> 的二阶常系数线性微分方程描述。

<summary>阻尼振动通过耗散机械能降低振幅，由含阻尼项的常微分方程描述</summary>
<socratic_meta correct="correct" done="true" />"""


MOCK_HTML_VISUALIZATION = r"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{margin:16px;background:#0f142d;color:#f0f4f8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center}
h2{color:#4a9eff;margin:0 0 10px;font-size:18px}
canvas{border:1px solid rgba(74,158,255,0.3);border-radius:8px;background:rgba(10,14,30,0.5);max-width:100%}
.controls{display:flex;gap:16px;margin:12px 0;flex-wrap:wrap;justify-content:center}
.slider-group{display:flex;flex-direction:column;align-items:center;gap:2px}
.slider-group label{font-size:12px;color:#a0b0d0}
.slider-group input{width:100px}
.info{font-size:13px;color:#a0b0d0;margin-top:8px;text-align:center}
</style></head>
<body>
<h2>&#x1f52c; 简谐运动可视化</h2>
<canvas id="c" width="560" height="160"></canvas>
<div class="controls">
<div class="slider-group"><label>振幅 A</label><input type="range" id="aA" min="20" max="80" value="60"></div>
<div class="slider-group"><label>角频率 &#x3c9;</label><input type="range" id="aW" min="1" max="5" value="2" step="0.1"></div>
<div class="slider-group"><label>速度</label><input type="range" id="aSp" min="0.5" max="3" value="1" step="0.1"></div>
</div>
<div class="info" id="info">x = 60 cos(2.0 t)</div>
<script>
(function(){function r(){
var c=document.getElementById('c'),ctx=c.getContext('2d');
var A=parseFloat(document.getElementById('aA').value)||60;
var w=parseFloat(document.getElementById('aW').value)||2;
var sp=parseFloat(document.getElementById('aSp').value)||1;
t=(t||0)+0.02*sp;var x=A*Math.cos(w*t);var cx=280+x;
ctx.clearRect(0,0,560,160);
ctx.fillStyle='rgba(74,158,255,0.05)';ctx.fillRect(0,0,560,160);
ctx.strokeStyle='rgba(74,158,255,0.15)';ctx.setLineDash([4,4]);
ctx.beginPath();ctx.moveTo(280,30);ctx.lineTo(280,130);ctx.stroke();
ctx.setLineDash([]);
ctx.fillStyle='#4a9eff';ctx.beginPath();ctx.arc(cx,80,8,0,Math.PI*2);ctx.fill();
ctx.fillStyle='rgba(74,158,255,0.25)';ctx.beginPath();ctx.arc(cx,80,14,0,Math.PI*2);ctx.fill();
ctx.strokeStyle='#4a9eff';ctx.beginPath();ctx.moveTo(280,80);ctx.lineTo(cx,80);ctx.stroke();
var v=-A*w*Math.sin(w*t);
document.getElementById('info').textContent='x='+x.toFixed(1)+'  '+'v='+v.toFixed(1);
requestAnimationFrame(r)}
document.getElementById('aA').addEventListener('input',r);
document.getElementById('aW').addEventListener('input',r);
document.getElementById('aSp').addEventListener('input',r);
var t=0;r()})();
</script>
</body></html>"""


async def _mock_stream_openai(content: str = MOCK_ANSWER, include_html: bool = True):
    """生成 OpenAI 格式的 mock SSE 流，模拟逐字输出"""
    # 首个空 chunk（触发前端进度显示）
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "progress": 2,
        "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": None}],
    }
    await asyncio.sleep(0.3)

    if include_html and "__PHYMATHIA_VISUALIZATION__" in content:
        content = content.replace("__PHYMATHIA_VISUALIZATION__", MOCK_HTML_VISUALIZATION)

    # 逐 chunk 发送 markdown 内容
    chunk_size = 4
    total_chunks = max(1, (len(content) + chunk_size - 1) // chunk_size)
    for index, i in enumerate(range(0, len(content), chunk_size)):
        chunk = content[i : i + chunk_size]
        yield {
            "id": "phymathia-chat",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "phymathia-mock",
            "progress": min(85, 3 + round((index + 1) / total_chunks * 72)),
            "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
        }
        await asyncio.sleep(0.015)

    await asyncio.sleep(0.2)

    # 结束标记
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }


# ====== 页面路由 ======
@app.get("/")
async def root():
    index_html = STATIC_DIR / "index.html"
    if index_html.exists():
        return HTMLResponse(content=index_html.read_text(encoding="utf-8"), status_code=200)
    raise HTTPException(status_code=404, detail="Index page not found")


@app.get("/chat")
async def chat_ui():
    return await root()


@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "PhyMathia offline test mode", "mock": True}


# ====== Mock 流式接口 (OpenAI 格式，前端实际调用) ======
@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    try:
        payload = await request.json()
        stream = payload.get("stream", False)
        logger.info(f"OpenAI mock request: prompt={payload.get('prompt', '')[:50]}, level={payload.get('level', 'university')}, stream={stream}")

        session_id = payload.get("session_id", "")
        branch_id = payload.get("branch_id", "")
        socratic_ref = branch_id or session_id
        socratic_state = _read_socratic_state(socratic_ref) if socratic_ref else None
        is_socratic_prompt = str(payload.get("prompt") or "").lstrip().startswith("[苏格拉底回答]")
        if socratic_state and not is_socratic_prompt:
            _delete_socratic_state(socratic_ref)
            socratic_state = None
        reply_content = MOCK_ANSWER
        if socratic_state:
            reply_content = (
                MOCK_SOCRATIC_ANSWER_2
                if int(socratic_state.get("correctStreak", 0) or 0) >= 1
                else MOCK_SOCRATIC_ANSWER_1
            )
            _update_socratic_state_from_content(reply_content, socratic_ref)

        if stream:
            async def generate():
                async for chunk in _mock_stream_openai(reply_content, include_html=reply_content is MOCK_ANSWER):
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(generate(), media_type="text/event-stream")
        else:
            return {
                "id": "phymathia-chat",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "phymathia-mock",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": reply_content},
                    "finish_reason": "stop",
                }],
            }
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format")
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ====== Mock 流式接口 (内部 SSE 格式，兼容保留) ======
@app.post("/stream_run")
async def stream_run(request: Request):
    try:
        payload = await request.json()
        message = payload.get("text", payload.get("message", ""))
        logger.info(f"Stream run mock: {message[:50]}")

        async def generate_sse():
            async for chunk in _mock_stream_openai():
                choices = chunk.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    content = delta.get("content", "")
                    done = choices[0].get("finish_reason") == "stop"
                    if content:
                        yield f"event: message\ndata: {json.dumps({'type': 'content', 'content': content, 'done': False}, ensure_ascii=False)}\n\n"
            yield f"event: message\ndata: {json.dumps({'type': 'content', 'content': '', 'done': True}, ensure_ascii=False)}\n\n"

        return StreamingResponse(generate_sse(), media_type="text/event-stream")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format")
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ====== AI 模型代理 API ======
AI_PROVIDERS = {
    "deepseek": {"base_url": "https://api.deepseek.com"},
    "openai": {"base_url": "https://api.openai.com/v1"},
    "opencode": {"base_url": "https://opencode.ai/zen/v1"},
}

OPENCODE_DEFAULT_API_KEY = ""

@app.post("/api/models/chat")
async def api_models_chat(request: Request):
    """代理请求到 AI API，流式返回 OpenAI 格式 SSE。
    支持两种调用格式：
    1. 新格式：{prompt, level, session_id, provider, api_key, model, base_url}
       → 后端构建消息（系统提示词 + 会话上下文 + 难度后缀）
    2. 旧格式：{messages, provider, api_key, model, base_url}
       → 直接使用传入的 messages
    """
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    model_name = payload.get("model", "")
    if not model_name and provider == "deepseek":
        model_name = "deepseek-chat"
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)

    if not api_key and provider != "opencode":
        raise HTTPException(
            status_code=400,
            detail=f"未配置 {provider} API Key：请在项目根目录 .env 中设置 DEEPSEEK_API_KEY，或在模型配置中填写密钥",
        )

    # 构建消息列表
    prompt = payload.get("prompt", "")
    session_id = payload.get("session_id", "")
    branch_id = payload.get("branch_id", "")
    branch_type = payload.get("branch_type", "")
    source_module = payload.get("source_module", "")
    parent_id = payload.get("parent_id", "")
    graph_path = payload.get("graph_path") or payload.get("graphPath") or []
    workflow_context = payload.get("workflow_context") or payload.get("workflowContext") or {}
    socratic_ref = branch_id or session_id
    if prompt:
        # 新格式：后端构建消息
        is_socratic_prompt = prompt.lstrip().startswith("[苏格拉底回答]")
        socratic_state = _read_socratic_state(socratic_ref) if socratic_ref else None
        if socratic_state and not is_socratic_prompt:
            # 用户开始新的普通问答时，结束当前苏格拉底支线
            _delete_socratic_state(socratic_ref)
            socratic_state = None
        include_socratic = bool(socratic_state) or is_socratic_prompt

        system_content = SYSTEM_PROMPT
        state_instruction = _socratic_state_instruction(socratic_ref) if socratic_ref and is_socratic_prompt else ""
        if state_instruction:
            system_content += "\n\n" + state_instruction
        if branch_id:
            system_content += _branch_context_instruction(branch_type, source_module, payload.get("branch_label", ""), parent_id)
        if graph_path:
            system_content += _graph_path_instruction(graph_path, source_module)
        if workflow_context:
            system_content += _workflow_context_instruction(workflow_context)
        messages = [{"role": "system", "content": system_content}]

        if session_id:
            context = _load_session_context(
                session_id,
                include_socratic=include_socratic,
                branch_id=branch_id,
                branch_type=branch_type,
                source_module=source_module,
                parent_id=parent_id,
                graph_path=graph_path,
            )
            messages.extend(context)

        level = payload.get("level", "university")
        level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
        messages.append({"role": "user", "content": prompt + level_suffix})

        logger.info(f"AI proxy (built msgs): {provider}/{model_name}, level={level}, ctx_rounds={len([m for m in messages if m['role'] != 'system'])}")
    else:
        # 旧格式：直接使用传入的 messages（兼容向后）
        messages = payload.get("messages", [])
        logger.info(f"AI proxy (raw msgs): {provider}/{model_name}, msg_count={len(messages)}")

    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if provider_info:
            base_url = provider_info["base_url"]
        else:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
    }
    if api_key and provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    target = workflow_context.get("target") or {} if isinstance(workflow_context, dict) else {}
    module_key = target.get("module") or source_module
    is_strict_module = module_key in ("socratic", "learn") and (
        target.get("kind") == "module" or branch_type == "blank"
    )
    max_tokens = payload.get("max_tokens")
    if is_strict_module and not max_tokens:
        max_tokens = STRICT_MODULE_MAX_TOKENS
    body = {
        "model": model_name,
        "messages": messages,
        "stream": stream,
    }
    if max_tokens:
        body["max_tokens"] = int(max_tokens)

    logger.info(f"AI proxy: {provider}/{model_name} -> POST {url}")

    async def proxy_stream():
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    logger.info(f"AI proxy response: {resp.status_code} from {url}")
                    if resp.status_code != 200:
                        error_body = await resp.aread()
                        error_text = error_body.decode(errors='replace')[:500]
                        yield f"data: {json.dumps({'error': resp.status_code, 'detail': error_text})}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    if not stream:
                        raw = await resp.aread()
                        text = raw.decode(errors="replace")
                        try:
                            data = json.loads(text)
                            content = data["choices"][0]["message"]["content"]
                            _update_socratic_state_from_content(content, socratic_ref)
                        except Exception:
                            pass
                        yield text
                        return
                    streamed_content = []
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            data_str = line[6:].strip()
                            if data_str != "[DONE]":
                                try:
                                    data = json.loads(data_str)
                                    delta = data.get("choices", [{}])[0].get("delta", {})
                                    if delta.get("content"):
                                        streamed_content.append(delta["content"])
                                except Exception:
                                    pass
                            yield line + "\n\n"
                    _update_socratic_state_from_content("".join(streamed_content), socratic_ref)
        except Exception as e:
            logger.error(f"AI proxy error: {e}")
            yield f"data: {json.dumps({'error': 500, 'detail': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(proxy_stream(), media_type="text/event-stream")


# ====== 会话管理 API ======
@app.get("/api/sessions")
async def api_get_sessions():
    return _read_json(SESSIONS_PATH, {})


@app.post("/api/sessions")
async def api_save_sessions(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    def updater(data):
        if isinstance(payload, list):
            for sdata in payload:
                if not isinstance(sdata, dict) or not sdata.get("id"):
                    continue
                sid = sdata["id"]
                data[sid] = {
                    "id": sid,
                    "title": sdata.get("title", "新对话"),
                    "icon": sdata.get("icon", ""),
                    "sessionId": sdata.get("sessionId", ""),
                    "createdAt": sdata.get("createdAt", int(time.time() * 1000)),
                    "updatedAt": sdata.get("updatedAt", int(time.time() * 1000)),
                }
        elif isinstance(payload, dict) and "id" in payload:
            data[payload["id"]] = {
                "id": payload["id"],
                "title": payload.get("title", "新对话"),
                "icon": payload.get("icon", ""),
                "sessionId": payload.get("sessionId", ""),
                "createdAt": payload.get("createdAt", int(time.time() * 1000)),
                "updatedAt": payload.get("updatedAt", int(time.time() * 1000)),
            }
        elif isinstance(payload, dict):
            for sid, sdata in payload.items():
                data[sid] = {
                    "id": sdata.get("id", sid),
                    "title": sdata.get("title", "新对话"),
                    "icon": sdata.get("icon", ""),
                    "sessionId": sdata.get("sessionId", ""),
                    "createdAt": sdata.get("createdAt", int(time.time() * 1000)),
                    "updatedAt": sdata.get("updatedAt", int(time.time() * 1000)),
                }
        return data

    _mutate_json(SESSIONS_PATH, updater)
    return {"ok": True, "count": len(payload) if isinstance(payload, (dict, list)) else 1}


@app.put("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    def updater(data):
        now = int(time.time() * 1000)
        if session_id not in data:
            data[session_id] = {
                "id": session_id,
                "title": "新对话",
                "icon": "",
                "sessionId": "",
                "createdAt": now,
                "updatedAt": now,
            }
        if "title" in payload:
            data[session_id]["title"] = payload["title"]
        if "icon" in payload:
            data[session_id]["icon"] = payload["icon"]
        if "sessionId" in payload:
            data[session_id]["sessionId"] = payload["sessionId"]
        data[session_id]["updatedAt"] = now
        return data

    _mutate_json(SESSIONS_PATH, updater)
    return {"ok": True}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    def updater(data):
        data.pop(session_id, None)
        return data

    _mutate_json(SESSIONS_PATH, updater)
    msgs_path = _get_messages_path(session_id)
    if msgs_path.exists():
        msgs_path.unlink()
    _delete_by_session(KNOWLEDGE_PATH, session_id)
    _delete_by_session(FORMULAS_PATH, session_id)
    _delete_socratic_state(session_id)
    return {"ok": True}


@app.delete("/api/sessions")
async def api_clear_all_sessions():
    _write_json(SESSIONS_PATH, {})
    for f in MESSAGES_DIR.glob("*.json"):
        f.unlink()
    _write_json(KNOWLEDGE_PATH, {})
    _write_json(FORMULAS_PATH, {})
    _write_json(KV_PATH, {})
    return {"ok": True}


# ====== 消息管理 API ======
@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    return _read_json(_get_messages_path(session_id), [])


@app.post("/api/sessions/{session_id}/messages")
async def api_save_messages(session_id: str, request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    messages = payload if isinstance(payload, list) else payload.get("messages", [])
    _write_json(_get_messages_path(session_id), messages)
    return {"ok": True, "count": len(messages)}


@app.delete("/api/sessions/{session_id}/messages")
async def api_clear_messages(session_id: str):
    msgs_path = _get_messages_path(session_id)
    if msgs_path.exists():
        msgs_path.unlink()
    _write_json(msgs_path, [])
    _delete_by_session(KNOWLEDGE_PATH, session_id)
    _delete_by_session(FORMULAS_PATH, session_id)
    _delete_socratic_state(session_id)
    return {"ok": True}


# ====== 知识条目 API ======
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


@app.get("/api/knowledge")
async def api_get_knowledge():
    return _dedupe_knowledge(_read_json(KNOWLEDGE_PATH, {}))


@app.post("/api/knowledge")
async def api_save_knowledge(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    incoming = _normalize_knowledge(payload)

    def updater(data):
        data = _normalize_knowledge(data)
        # 合并：同 id 以新数据为准；全量上传时等价于覆盖
        data.update(incoming)
        return _dedupe_knowledge(data)

    data = _mutate_json(KNOWLEDGE_PATH, updater)
    return {"ok": True, "count": len(data)}


@app.delete("/api/knowledge/{item_id}")
async def api_delete_knowledge(item_id: str):
    def updater(data):
        data = _normalize_knowledge(data)
        data.pop(item_id, None)
        return data

    _mutate_json(KNOWLEDGE_PATH, updater)
    return {"ok": True}


# ====== 公式库 API ======
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


@app.get("/api/formulas")
async def api_get_formulas(q: str = ""):
    raw = _read_json(FORMULAS_PATH, {})
    data = _dedupe_formula_map(raw)
    if len(data) != len(raw):
        _write_json(FORMULAS_PATH, data)
    items = list(data.values())
    if q:
        ql = q.lower()
        items = [it for it in items if
                 ql in (it.get("concept") or "").lower() or
                 ql in (it.get("meaning") or "").lower() or
                 ql in (it.get("topic") or "").lower() or
                 ql in (it.get("latex") or "").lower() or
                 any(ql in (t or "").lower() for t in (it.get("related") or []))]
    items.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
    return {"items": items, "count": len(items)}


@app.post("/api/formulas")
async def api_save_formulas(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    items = payload if isinstance(payload, list) else payload.get("items", [])
    count = 0

    def updater(data):
        nonlocal count
        for it in items:
            latex = _normalize_formula(it.get("latex") or "")
            if not latex:
                continue
            # 去重：同会话同公式不重复入库
            existing = next((v for v in data.values()
                             if _formula_key(v.get("latex")) == _formula_key(latex)
                             and v.get("sessionId") == it.get("sessionId")), None)
            if existing:
                # 本地快速提取先入库，后续 AI 结果可以补充更完整的说明。
                changed = False
                incoming_source = str(it.get("meaningSource") or "local")
                existing_source = str(existing.get("meaningSource") or "local")
                incoming_meaning = (it.get("meaning") or "").strip()
                if incoming_meaning and (
                    incoming_source == "model" or existing_source != "model"
                ):
                    existing["meaning"] = incoming_meaning[:200]
                    existing["meaningSource"] = incoming_source
                    changed = True
                for key in ("concept", "topic", "related", "messageId", "moduleKey"):
                    value = it.get(key)
                    if value and not existing.get(key):
                        existing[key] = value
                        changed = True
                if changed:
                    count += 1
                continue
            fid = str(it.get("id") or "") or ("f_" + uuid.uuid4().hex[:12])
            data[fid] = {
                "id": fid,
                "latex": latex,
                "concept": (it.get("concept") or "")[:80],
                "meaning": (it.get("meaning") or "")[:200],
                "meaningSource": it.get("meaningSource") or "local",
                "topic": (it.get("topic") or "")[:60],
                "related": [str(t) for t in (it.get("related") or [])][:8],
                "sessionId": it.get("sessionId", ""),
                "messageId": it.get("messageId", ""),
                "moduleKey": it.get("moduleKey", ""),
                "createdAt": it.get("createdAt") or int(time.time() * 1000),
            }
            count += 1
        return data if count else None

    _mutate_json(FORMULAS_PATH, updater)
    return {"ok": True, "count": count}


@app.delete("/api/formulas")
async def api_delete_formulas_by_session(session_id: str = ""):
    """按会话删除公式（session_id 为空时删除全部）"""
    removed = 0

    def updater(data):
        nonlocal removed
        if session_id:
            removed = [k for k, v in data.items() if v.get("sessionId") == session_id]
            for k in removed:
                data.pop(k, None)
        else:
            removed = list(data.keys())
            data.clear()
        return data if removed else None

    _mutate_json(FORMULAS_PATH, updater)
    return {"ok": True, "count": len(removed)}


@app.delete("/api/formulas/{formula_id}")
async def api_delete_formula(formula_id: str):
    def updater(data):
        data.pop(formula_id, None)
        return data

    _mutate_json(FORMULAS_PATH, updater)
    return {"ok": True}


# ====== 知识提取 API ======
EXTRACT_PROMPT = """你是知识提取助手。请从下面这段对话中提取关键知识点（1-5 个），
只输出 JSON，不要输出任何其他内容或解释：
{"items": [{"title": "知识点名称", "category": "physics|math|other", "tags": ["标签1", "标签2"], "summary": "一句话摘要", "formulas": ["$F=ma$"]}]}
要求：
- title 是具体概念名，如"简谐运动"
- category 三选一：physics（物理现象/定律）、math（数学结构/定理）、other
- formulas 中公式用 $...$ 或 $$...$$ 包裹，没有公式则为空数组
- 不要编造对话中不存在的知识点"""


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
    title = re.sub(r"的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向)$", "", title).strip()
    title = re.sub(r"的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$", "", title).strip()
    title = re.sub(r"^[🔬📐🧠💡🗺️]+\s*", "", title).strip()
    return title


def _is_socratic_followup(content: str) -> bool:
    content = content or ""
    if not re.search(r"<socratic_meta\b", content, re.I):
        return False
    return not re.search(r"<physics>|<math>|<graph>|<extend>|PhyMathia\s*学习卡片", content, re.I)


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
        "知识图谱", "延伸思考", "进阶学习方向", "学习方向",
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


async def _ai_extract_knowledge(messages: list, provider: str, api_key: str, model: str, base_url: str, level: str = "university") -> list:
    """调用 AI 模型提取知识点（非流式）"""
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return []
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
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return _parse_extract_json(content)


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


DESCRIBE_PROMPT = """你是公式解说助手。针对下面的每个公式，分别生成一句只解释该公式本身的简短中文描述（不超过30字）。
不要给所有公式复用同一句对话摘要；例如 F=-kx 应写"胡克定律：回复力与位移成正比"。
只输出 JSON，不要输出任何其他内容：
{"descriptions": {"<公式原文>": "描述"}}
要求：
- 公式原文作为键，保持原样
- 描述要具体，例如"胡克定律：弹簧弹力与形变量成正比"
- 每个公式必须单独描述，禁止所有公式共用同一句话
- 无法确定含义的公式，描述用空字符串
- 不要编造摘要中不存在的概念"""


async def _describe_formulas(summary: str, formulas: list, provider: str, api_key: str, model: str, base_url: str, level: str = "university") -> dict:
    """调用描述模型为公式生成简要描述，返回 {latex: 描述}；失败返回空 dict"""
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY
    if not formulas or not model:
        return {}
    if not api_key and provider != "opencode":
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
        async with httpx.AsyncClient(timeout=60.0) as client:
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


@app.post("/api/extract_knowledge")
async def api_extract_knowledge(request: Request):
    """从对话中提取知识点（优先 AI，失败或无模型时本地正则兜底），并自动入库公式"""
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    messages = payload.get("messages", [])
    session_id = payload.get("sessionId", "")
    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    model = payload.get("model", "")
    base_url = payload.get("base_url", "")
    level = payload.get("level", "university")
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY

    latest_assistant = next((m for m in reversed(messages) if m.get("role") == "assistant"), None)
    if latest_assistant and (
        _is_socratic_followup(latest_assistant.get("content", ""))
        or latest_assistant.get("branchType") in ("followup", "confused", "socratic")
    ):
        return {"items": []}
    # 公式描述模型（前端传入，可选；未配置时回退默认摘要）
    desc_provider = payload.get("descriptor_provider", "")
    desc_api_key = payload.get("descriptor_api_key", "")
    desc_model = payload.get("descriptor_model", "")
    desc_base_url = payload.get("descriptor_base_url", "")
    if not desc_api_key and desc_provider == "deepseek":
        desc_api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if not desc_api_key and desc_provider == "opencode":
        desc_api_key = OPENCODE_DEFAULT_API_KEY

    items = []
    if (api_key or provider == "opencode") and model:
        try:
            items = await _ai_extract_knowledge(messages, provider, api_key, model, base_url, level)
            if items:
                logger.info(f"AI extract: {len(items)} items for session {session_id}")
        except Exception as e:
            logger.warning(f"AI extract failed, fallback to local: {e}")
    if not items:
        items = _local_extract_knowledge(messages)
        if items:
            logger.info(f"Local extract: {len(items)} items for session {session_id}")

    # 摘要双重用途：主模型 <summary> 标签 → 知识条目 summary（替代内容截断）
    summary_text = _extract_summary(messages)
    if summary_text:
        for it in items:
            it["summary"] = summary_text[:200]

    # 公式描述：配置了描述模型且有公式时，为新增公式生成简要描述
    descriptions = {}
    all_formulas = []
    for it in items:
        for f in (it.get("formulas") or []):
            latex = _normalize_formula(str(f).strip())
            if latex and _looks_like_formula(latex) and latex not in all_formulas:
                all_formulas.append(latex)
    if all_formulas and desc_model and (desc_api_key or desc_provider == "opencode"):
        descriptions = await _describe_formulas(summary_text, all_formulas, desc_provider, desc_api_key, desc_model, desc_base_url, level)
        if descriptions:
            logger.info(f"Generated {len(descriptions)} formula descriptions for session {session_id}")

    message_id = str(latest_assistant.get("timestamp") or "") if latest_assistant else ""
    added = _add_formulas_from_items(items, session_id, descriptions, message_id)
    if added:
        logger.info(f"Auto added {added} formulas to library")

    return {"items": items, "descriptions": descriptions}


# ====== 文件解析 API ======
def _sanitize_filename(filename: str) -> str:
    name = Path(str(filename or "upload")).name
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip()[:120] or "upload"
    return name


def _read_upload(file_id: str):
    meta = _read_json(UPLOADS_META_PATH, {})
    entry = meta.get(file_id)
    if not entry:
        return None
    path = UPLOAD_DIR / f"{file_id}.bin"
    if not path.exists():
        return None
    return entry, path.read_bytes()


def _save_upload(file_id: str, filename: str, content: bytes) -> None:
    meta = _read_json(UPLOADS_META_PATH, {})
    meta[file_id] = {
        "id": file_id,
        "filename": filename,
        "savedAt": int(time.time() * 1000),
    }
    _write_json(UPLOADS_META_PATH, meta)
    (UPLOAD_DIR / f"{file_id}.bin").write_bytes(content)


def _extract_image_text(content: bytes) -> str:
    try:
        from rapidocr_onnxruntime import RapidOCR
    except ImportError:
        return ""
    try:
        tmp_path = UPLOAD_DIR / "ocr_tmp.png"
        tmp_path.write_bytes(content)
        result, _ = RapidOCR()(str(tmp_path))
        if result:
            return "\n".join(str(item[1]) for item in result if len(item) > 1)
    except Exception as e:
        logger.warning(f"Image OCR failed: {e}")
    return ""


def _extract_document_text(filename: str, content: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext in {".txt", ".md", ".markdown", ".csv", ".json", ".log", ".tex"}:
        for enc in ("utf-8", "utf-8-sig", "gbk"):
            try:
                return content.decode(enc)
            except (UnicodeDecodeError, ValueError):
                continue
        return content.decode("utf-8", "ignore")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            return ""
        try:
            reader = PdfReader(io.BytesIO(content))
            return "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception as e:
            logger.warning(f"PDF extraction failed: {e}")
            return ""
    if ext == ".docx":
        try:
            import docx
        except ImportError:
            return ""
        try:
            doc = docx.Document(io.BytesIO(content))
            parts = [p.text for p in doc.paragraphs]
            for table in doc.tables:
                for row in table.rows:
                    parts.append(" | ".join(cell.text for cell in row.cells))
            return "\n".join(parts)
        except Exception as e:
            logger.warning(f"DOCX extraction failed: {e}")
            return ""
    if ext in {".pptx", ".ppt"}:
        try:
            from pptx import Presentation
        except ImportError:
            return ""
        try:
            prs = Presentation(io.BytesIO(content))
            parts = []
            for slide in prs.slides:
                for shape in slide.shapes:
                    if hasattr(shape, "text") and shape.text:
                        parts.append(shape.text)
                    if hasattr(shape, "has_table") and shape.has_table:
                        for row in shape.table.rows:
                            parts.append(" | ".join(cell.text for cell in row.cells))
            return "\n".join(parts)
        except Exception as e:
            logger.warning(f"PPTX extraction failed: {e}")
            return ""
    if ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}:
        return _extract_image_text(content)
    return ""


def _parse_document_extract_json(text: str, max_items: int):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text or "")
    if m:
        text = m.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start:end + 1]
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return [], [], []
    if not isinstance(data, dict):
        return [], [], []
    nodes = data.get("nodes") or data.get("items") or []
    edges = data.get("edges") or []
    raw_relations = data.get("relations") or []
    normalized = []
    for it in nodes if isinstance(nodes, list) else []:
        if not isinstance(it, dict):
            continue
        title = _clean_knowledge_title(str(it.get("title") or ""))
        if not title:
            continue
        category = it.get("category")
        if category not in ("physics", "math", "other"):
            category = "other"
        formulas = []
        for f in (it.get("formulas") or []):
            fs = _normalize_formula(str(f).strip())
            if fs and _looks_like_formula(fs):
                formulas.append(fs)
        normalized.append({
            "id": str(it.get("id") or it.get("key") or title),
            "title": title[:80],
            "category": category,
            "tags": [str(t).strip() for t in (it.get("tags") or []) if str(t).strip()][:6],
            "summary": str(it.get("summary") or "")[:240],
            "formulas": formulas[:8],
        })
        for rel in (it.get("relations") or []):
            if not isinstance(rel, dict):
                continue
            edges.append({
                "from": str(it.get("id") or it.get("key") or title),
                "to": str(rel.get("target") or rel.get("to") or ""),
                "type": str(rel.get("type") or "related"),
                "label": str(rel.get("label") or rel.get("type") or "相关"),
                "score": rel.get("score"),
            })

    by_key = {}
    result_nodes = []
    for index, item in enumerate(normalized[:max_items]):
        raw_id = str(item["id"])
        node_id = f"n{index + 1}"
        by_key[raw_id] = node_id
        result_nodes.append({**item, "id": node_id})

    result_edges = []
    for edge in edges if isinstance(edges, list) else []:
        if not isinstance(edge, dict):
            continue
        from_key = str(edge.get("from") or edge.get("source") or "")
        to_key = str(edge.get("to") or edge.get("target") or "")
        from_id = by_key.get(from_key)
        to_id = by_key.get(to_key)
        if not from_id or not to_id or from_id == to_id:
            continue
        edge_type = str(edge.get("type") or "related")[:40]
        result_edges.append({
            "from": from_id,
            "to": to_id,
            "type": edge_type,
            "label": str(edge.get("label") or edge_type)[:120],
            "score": _safe_score(edge.get("score")),
        })

    result_relations = []
    for rel in raw_relations if isinstance(raw_relations, list) else []:
        if not isinstance(rel, dict):
            continue
        node_keys = rel.get("nodes") or rel.get("nodeIds") or []
        if not node_keys and rel.get("from") and rel.get("to"):
            node_keys = [rel.get("from"), rel.get("to")]
        mapped = []
        for key in node_keys if isinstance(node_keys, list) else []:
            mapped_id = by_key.get(str(key))
            if mapped_id and mapped_id not in mapped:
                mapped.append(mapped_id)
        if len(mapped) < 2:
            continue
        label = str(rel.get("label") or rel.get("meaning") or rel.get("type") or "")
        result_relations.append({
            "nodes": mapped[:4],
            "label": label[:200],
            "type": str(rel.get("type") or "本质联系")[:40],
            "score": _safe_score(rel.get("score"), 0.75),
        })
    result_relations.sort(key=lambda item: item["score"], reverse=True)
    return result_nodes, result_edges[:max_items * 4], result_relations[:3]


def _safe_score(value, default: float = 0.7) -> float:
    try:
        score = float(value)
        if 0 <= score <= 1:
            return score
    except (TypeError, ValueError):
        pass
    return default


def _extract_text_formulas(text: str) -> list:
    formulas = []
    if not text:
        return formulas
    for m in re.finditer(r"\$\$([^$\n]+)\$\$|\\\((.+?)\\\)|\\\[(.+?)\\\]|\$([^$\n]+)\$", text):
        expr = next((g for g in m.groups() if g), "")
        normalized = _normalize_formula(expr)
        if normalized and _looks_like_formula(normalized) and normalized not in formulas:
            formulas.append(normalized)
        if len(formulas) >= 8:
            break
    return formulas


def _local_extract_document_knowledge(text: str, filename: str, max_items: int):
    if not text or not text.strip():
        return [], [], []
    headings = list(re.finditer(r"^#{1,6}\s+(.+?)\s*$", text, re.M))
    if headings:
        nodes = []
        stack = []
        for idx, match in enumerate(headings):
            title = _clean_knowledge_title(match.group(1))
            level = len(match.group(0)) - len(match.group(0).lstrip("#"))
            start = match.end()
            end = headings[idx + 1].start() if idx + 1 < len(headings) else len(text)
            section = text[start:end]
            summary = re.sub(r"\s+", " ", section).strip()[:200]
            if not summary:
                summary = title
            category = "other"
            if any(k in section for k in ("物理", "力学", "电磁", "光学", "热", "振动", "波", "场", "力", "能量")):
                category = "physics"
            elif any(k in section for k in ("方程", "函数", "导数", "积分", "矩阵", "几何", "代数", "微分", "定理", "证明", "数学")):
                category = "math"
            node = {
                "id": f"local_{idx + 1}",
                "title": title[:80],
                "category": category,
                "tags": ["物理" if category == "physics" else "数学" if category == "math" else "其他"],
                "summary": summary,
                "formulas": _extract_text_formulas(section),
            }
            nodes.append(node)
            while stack and stack[-1]["level"] >= level:
                stack.pop()
            if stack:
                edge_label = "包含"
                if not any(e["from"] == stack[-1]["id"] and e["to"] == node["id"] for e in nodes[-1].get("_edges", [])):
                    node.setdefault("_edges", []).append({"from": stack[-1]["id"], "to": node["id"], "type": "包含", "label": edge_label})
            stack.append({"id": node["id"], "level": level})
        edges = []
        for node in nodes:
            edges.extend(node.get("_edges", []))
            node.pop("_edges", None)
        return nodes[:max_items], edges[:max_items * 4], []

    paragraphs = [re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", text) if len(p.strip()) >= 10]
    if not paragraphs:
        paragraphs = [re.sub(r"\s+", " ", text).strip()[:1000]]
    nodes = []
    for index, paragraph in enumerate(paragraphs[:max_items]):
        title = paragraph[:40] or f"{Path(filename).stem} 知识点 {index + 1}"
        category = "other"
        if any(k in paragraph for k in ("物理", "力学", "电磁", "光学", "热", "振动", "波", "场", "力", "能量")):
            category = "physics"
        elif any(k in paragraph for k in ("方程", "函数", "导数", "积分", "矩阵", "几何", "代数", "微分", "定理", "证明", "数学")):
            category = "math"
        nodes.append({
            "id": f"para_{index + 1}",
            "title": title[:80],
            "category": category,
            "tags": ["物理" if category == "physics" else "数学" if category == "math" else "其他"],
            "summary": paragraph[:200],
            "formulas": _extract_text_formulas(paragraph),
        })
    return nodes, [], []


async def _ai_extract_document_knowledge(
    text: str,
    filename: str,
    is_image: bool,
    image_b64: str,
    provider: str,
    api_key: str,
    model: str,
    base_url: str,
    level: str,
    max_items: int,
):
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return [], [], []
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY
    if not api_key and provider != "opencode":
        return [], [], []

    prompt = (
        "你是 PhyMathia 的文件知识抽取助手。请从用户上传的文件中抽取最重要的知识点及其联系。\n"
        f"要求：最多输出 {max_items} 个知识点；每个知识点给出具体名称、分类、简短摘要和公式；"
        "只输出最重要的本质联系，最多 3 条；不要输出‘相关’‘有联系’‘关联’这类空泛关系；"
        "每条 relations 的 nodes 至少包含 2 个知识点，label 必须用一句具体的话说明知识点之间为什么存在本质联系；"
        "score 是 0 到 1 的置信度，低于 0.6 不要输出。\n"
        '只输出 JSON，不要输出其他内容：\n'
        '{"nodes":[{"id":"n1","title":"知识点名称","category":"physics|math|other","tags":["标签"],"summary":"一句话摘要","formulas":["$F=ma$"]}],"relations":[{"nodes":["n1","n2"],"label":"一句话说明本质联系","type":"推导出","score":0.9}]}'
    )
    level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
    user_content = f"文件名：{filename}\n\n{text[:12000]}" if text else f"文件名：{filename}"
    if is_image and image_b64 and not text:
        ext = Path(filename).suffix.lower()
        mime = {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
            ".tiff": "image/tiff",
        }.get(ext, "image/png")
        message_content = [
            {"type": "text", "text": user_content},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{image_b64}"}},
        ]
    else:
        message_content = user_content
    messages = [
        {"role": "system", "content": prompt + "\n\n难度要求：" + level_suffix},
        {"role": "user", "content": message_content},
    ]
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    body = {"model": model, "messages": messages, "stream": False, "temperature": 0.2}
    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return _parse_document_extract_json(content, max_items)


@app.post("/api/documents/parse")
async def api_parse_document(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    filename = _sanitize_filename(payload.get("fileName") or "")
    try:
        max_items = min(max(int(payload.get("maxItems") or 5), 1), 50)
    except (TypeError, ValueError):
        max_items = 5
    content = None
    file_id = str(payload.get("fileId") or "")
    if file_id:
        loaded = _read_upload(file_id)
        if not loaded:
            raise HTTPException(status_code=404, detail="文件不存在，请重新上传")
        entry, content = loaded
        filename = _sanitize_filename(entry.get("filename") or filename)
    else:
        try:
            content = base64.b64decode(str(payload.get("contentBase64") or ""))
        except Exception:
            raise HTTPException(status_code=400, detail="文件内容格式错误")
        if not content:
            raise HTTPException(status_code=400, detail="缺少文件内容")
        if len(content) > UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 20MB 限制")
        file_id = "doc_" + uuid.uuid4().hex[:12]
        _save_upload(file_id, filename, content)

    text = _extract_document_text(filename, content)
    ext = Path(filename).suffix.lower()
    is_image = ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}
    image_b64 = base64.b64encode(content).decode("ascii") if is_image else ""

    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    level = str(payload.get("level") or "university")
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY

    nodes, edges, relations = [], [], []
    if model and (api_key or provider == "opencode"):
        try:
            nodes, edges, relations = await _ai_extract_document_knowledge(
                text, filename, is_image, image_b64, provider, api_key, model, base_url, level, max_items
            )
        except Exception as e:
            logger.warning(f"AI document extraction failed: {e}")
    if not nodes:
        nodes, edges, relations = _local_extract_document_knowledge(text, filename, max_items)
    if not nodes:
        raise HTTPException(status_code=422, detail="无法从文件中提取知识点。请使用文本/PDF/DOCX，或为图片配置视觉模型/OCR。")

    return {
        "ok": True,
        "fileId": file_id,
        "fileName": filename,
        "maxItems": max_items,
        "textLength": len(text),
        "nodes": nodes,
        "edges": edges,
        "relations": relations,
        "extractedTextPreview": text[:500],
    }


# ====== 键值存储 API ======
@app.get("/api/kv/{key}")
async def api_get_kv(key: str):
    data = _read_json(KV_PATH, {})
    return {"key": key, "value": data.get(key)}


@app.post("/api/kv/{key}")
async def api_set_kv(key: str, request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    def updater(data):
        data[key] = payload.get("value", "")
        return data

    _mutate_json(KV_PATH, updater)
    return {"ok": True}


@app.delete("/api/kv/{key}")
async def api_delete_kv(key: str):
    def updater(data):
        data.pop(key, None)
        return data

    _mutate_json(KV_PATH, updater)
    return {"ok": True}


# ====== 数据备份导出/导入 API ======
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


def _build_backup_payload() -> dict:
    sessions = _read_json(SESSIONS_PATH, {})
    messages = {}
    for sid in sessions:
        if not isinstance(sessions[sid], dict):
            continue
        path = _get_messages_path(sid)
        value = _read_json(path, [])
        messages[sid] = value if isinstance(value, list) else []
    for path in sorted(MESSAGES_DIR.glob("*.json")):
        sid = path.stem
        if sid in messages:
            continue
        value = _read_json(path, [])
        messages[sid] = value if isinstance(value, list) else []
    return {
        "version": 2,
        "exportedAt": time.time(),
        "sessions": sessions,
        "messages": messages,
        "knowledge": _read_json(KNOWLEDGE_PATH, {}),
        "formulas": _read_json(FORMULAS_PATH, {}),
        "kv": _read_json(KV_PATH, {}),
    }


def _restore_sessions(data: dict, replace: bool) -> int:
    sessions = _read_json(SESSIONS_PATH, {})
    if replace:
        sessions = {}
    if not isinstance(data, (dict, list)):
        return 0
    count = 0
    entries = data.items() if isinstance(data, dict) else [(None, item) for item in data]
    for raw_key, sdata in entries:
        if not isinstance(sdata, dict):
            continue
        sid = str(sdata.get("id") or raw_key or "")
        if not sid:
            continue
        now = int(time.time() * 1000)
        sessions[sid] = {
            "id": sid,
            "title": sdata.get("title", "新对话"),
            "icon": sdata.get("icon", ""),
            "sessionId": sdata.get("sessionId", ""),
            "createdAt": sdata.get("createdAt", now),
            "updatedAt": sdata.get("updatedAt", now),
        }
        count += 1
    _write_json(SESSIONS_PATH, sessions)
    return count


def _restore_messages(data: dict, sessions: dict, replace: bool) -> int:
    if replace:
        for path in MESSAGES_DIR.glob("*.json"):
            path.unlink(missing_ok=True)
    if not isinstance(data, dict):
        return 0
    alias_to_sid = {}
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId"):
            alias_to_sid[sdata["sessionId"]] = sid
    count = 0
    for raw_sid, msgs in data.items():
        sid = alias_to_sid.get(raw_sid, raw_sid)
        if not isinstance(msgs, list):
            continue
        _write_json(_get_messages_path(sid), msgs)
        count += len(msgs)
    return count


def _restore_backup(backup: dict, replace: bool) -> dict:
    sessions = backup.get("sessions") or {}
    session_count = _restore_sessions(sessions, replace)
    saved_sessions = _read_json(SESSIONS_PATH, {})
    message_count = _restore_messages(backup.get("messages") or {}, saved_sessions, replace)

    knowledge = _normalize_knowledge(backup.get("knowledge") or {})
    if replace:
        _write_json(KNOWLEDGE_PATH, {})
        _write_json(FORMULAS_PATH, {})
        _write_json(KV_PATH, {})
    if knowledge:
        existing_knowledge = _read_json(KNOWLEDGE_PATH, {})
        _write_json(KNOWLEDGE_PATH, _dedupe_knowledge({**existing_knowledge, **knowledge}))

    formulas = _normalize_formula_map(backup.get("formulas") or {})
    if formulas:
        existing_formulas = _read_json(FORMULAS_PATH, {})
        _write_json(FORMULAS_PATH, _dedupe_formula_map({**existing_formulas, **formulas}))

    kv_data = backup.get("kv") or {}
    if isinstance(kv_data, dict):
        existing_kv = {} if replace else _read_json(KV_PATH, {})
        _write_json(KV_PATH, {**existing_kv, **kv_data})

    return {
        "ok": True,
        "sessions": session_count,
        "messages": message_count,
        "knowledge": len(knowledge),
        "formulas": len(formulas),
        "kv": len(kv_data) if isinstance(kv_data, dict) else 0,
    }


@app.get("/api/backup/export")
async def api_backup_export():
    return _build_backup_payload()


@app.post("/api/backup/import")
async def api_backup_import(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    backup = payload.get("backup") if isinstance(payload.get("backup"), dict) else payload
    if not isinstance(backup, dict):
        raise HTTPException(status_code=400, detail="Backup payload must be an object")
    mode = str(payload.get("mode") or "merge").lower()
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="mode must be merge or replace")
    return _restore_backup(backup, mode == "replace")


# ====== 静态文件 catch-all（必须放在所有 API 路由之后）======
@app.get("/{filename:path}")
async def serve_static_file(filename: str):
    if not filename:
        return await root()
    path = Path(filename)
    if path.suffix.lower() in STATIC_EXTENSIONS:
        file_path = STATIC_DIR / filename
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
    raise HTTPException(status_code=404, detail="Not found")


# 启动前清理历史重复知识点
_dedupe_knowledge_file()


# ====== 启动 ======
def parse_args():
    parser = argparse.ArgumentParser(description="Start PhyMathia (offline test mode)")
    parser.add_argument("-p", "--port", type=int, default=5050, help="Server port")
    parser.add_argument("--reload", action="store_true", help="Enable auto reload")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    logger.info("=" * 50)
    logger.info("PhyMathia (Offline Test Mode)")
    logger.info(f"  - Port: {args.port}")
    logger.info(f"  - Mock: Enabled (no AI API required)")
    logger.info("=" * 50)
    logger.info(f"访问地址: http://localhost:{args.port}")
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=args.port,
        reload=args.reload,
        workers=1,
    )
