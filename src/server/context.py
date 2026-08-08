"""会话上下文构建与苏格拉底追问状态管理。"""

import re
import time

from .config import KV_PATH
from .storage import _mutate_json, _read_json, _resolve_messages_path

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



def _is_socratic_followup(content: str) -> bool:
    content = content or ""
    if not re.search(r"<socratic_meta\b", content, re.I):
        return False
    return not re.search(r"<physics>|<math>|<graph>|<extend>|PhyMathia\s*学习卡片", content, re.I)


__all__ = [
    "_is_socratic_message", "_recent_context_messages", "_extract_section",
    "_branch_source_content", "_load_session_context", "_branch_context_instruction",
    "_module_output_instruction", "_graph_message_summary", "_graph_path_instruction",
    "_workflow_context_instruction", "_load_session_context_from_path",
    "SOCRATIC_STATE_PREFIX", "_socratic_key", "_read_socratic_state",
    "_write_socratic_state", "_delete_socratic_state", "_socratic_state_instruction",
    "_update_socratic_state_from_content", "_is_socratic_followup",
]
