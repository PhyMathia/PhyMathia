"""会话上下文构建与苏格拉底追问状态管理。"""

import re
import time

from .config import KV_PATH
from .storage import _mutate_json, _read_json, _read_json_cached, _resolve_messages_path
# ====== 普通聊天上下文瘦身 ======
_CONTEXT_MAX_USER_CHARS = 4000
_CONTEXT_RECENT_FULL_MAX = 8000
_VIZ_DIGEST_MAX = 1200
VIZ_PLACEHOLDER = "[交互可视化内容已省略]"
_VIZ_WANT_RE = re.compile(r"可视化|交互|动画|没看懂|看不懂|HTML|html|演示|3D|这个图|那张图|图里|图上的|画面", re.I)

def estimate_tokens(text: str) -> int:
    """Cheap token estimate mirroring the frontend: CJK chars count 1, ASCII ~4/1."""
    s = str(text or "")
    cjk = sum(1 for ch in s if "\u4e00" <= ch <= "\u9fff" or "\u3000" <= ch <= "\u303f" or "\uff00" <= ch <= "\uffef")
    return (4 * cjk + (len(s) - cjk) + 3) // 4

# ====== 上下文 token 预算 ======
MODEL_CONTEXT_WINDOWS = {
    "deepseek-chat": 65536,
    "deepseek-reasoner": 65536,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
}
DEFAULT_CONTEXT_WINDOW = 128000
CONTEXT_OUTPUT_RESERVE_TOKENS = 8192
MAX_CONTEXT_BUDGET_TOKENS = 16000
MIN_CONTEXT_BUDGET_TOKENS = 2048


def resolve_context_budget(model_name: str = "") -> int:
    """按模型上下文窗口计算本次请求的输入 token 预算。

    预算 = min(全局上限, 窗口 - 输出预留)，至少 MIN_CONTEXT_BUDGET_TOKENS；
    未知模型按 DEFAULT_CONTEXT_WINDOW 处理。
    """
    key = str(model_name or "").strip().lower()
    window = MODEL_CONTEXT_WINDOWS.get(key, DEFAULT_CONTEXT_WINDOW)
    return max(MIN_CONTEXT_BUDGET_TOKENS, min(MAX_CONTEXT_BUDGET_TOKENS, window - CONTEXT_OUTPUT_RESERVE_TOKENS))


def _content_timestamp_map(messages: list) -> dict:
    """content -> 首次出现的 timestamp，用于跨消息按 (timestamp, content) 去重。"""
    mapping = {}
    for msg in messages or []:
        content = str(msg.get("content") or "")
        if content and content not in mapping:
            mapping[content] = str(msg.get("timestamp") or "")
    return mapping


def _shrink_history_to_budget(messages: list, budget_tokens: int, protected: set = None) -> list:
    """按 token 预算收缩历史消息，保持消息顺序。

    策略（从低优先到高优先逐级压缩）：
    1. 把较早的 assistant 消息替换为摘要（受保护内容与最后一条消息除外）；
    2. 从最早开始丢弃非受保护、非最后一条消息；
    3. 最后一条 assistant 兜底截断为摘要；
    4. 极端情况把最早的消息截短。
    """
    if not messages or not budget_tokens or budget_tokens <= 0:
        return messages
    protected = protected or set()
    total = sum(estimate_tokens(str(m.get("content") or "")) for m in messages)
    if total <= budget_tokens:
        return messages

    last_idx = len(messages) - 1
    # 阶段1：较早 assistant -> 摘要
    for i, m in enumerate(messages):
        if total <= budget_tokens:
            break
        if i >= last_idx:
            break
        if m.get("role") != "assistant":
            continue
        content = str(m.get("content") or "")
        if content in protected:
            continue
        summary = _graph_message_summary(m)[:200]
        if not summary or summary == content:
            continue
        delta = estimate_tokens(content) - estimate_tokens(summary)
        if delta <= 0:
            continue
        m["content"] = summary
        total -= delta

    # 阶段2：从最早开始丢弃非受保护、非最后一条消息
    i = 0
    while total > budget_tokens and i < last_idx:
        m = messages[i]
        content = str(m.get("content") or "")
        if content in protected:
            i += 1
            continue
        total -= estimate_tokens(content)
        messages.pop(i)
        last_idx = len(messages) - 1

    # 阶段3：最后一条 assistant 兜底截断
    if total > budget_tokens and messages and messages[-1].get("role") == "assistant":
        content = str(messages[-1].get("content") or "")
        if content not in protected:
            summary = _graph_message_summary(messages[-1])[:160]
            if summary and summary != content:
                total -= estimate_tokens(content) - estimate_tokens(summary)
                messages[-1]["content"] = summary

    # 阶段4：极端情况把最早的消息截短（保留最后一条）
    i = 0
    while total > budget_tokens and i < len(messages) - 1:
        m = messages[i]
        content = str(m.get("content") or "")
        if content in protected:
            i += 1
            continue
        truncated = content[:200] + "…（已截断）"
        delta = estimate_tokens(content) - estimate_tokens(truncated)
        if delta > 0:
            m["content"] = truncated
            total -= delta
            i += 1
        else:
            total -= estimate_tokens(content)
            messages.pop(i)
    return messages


def _prompt_wants_viz(prompt: str) -> bool:
    """判断当前提问是否与可视化相关（决定是否在上下文中保留整段 HTML）。"""
    if not prompt:
        return False
    return bool(_VIZ_WANT_RE.search(prompt))


def _trim_context_content(content: str, keep_viz: bool = False) -> str:
    """压缩大段 assistant 消息：保留 <summary> 摘要标签；<viz>/```html``` 大块
    HTML 默认替换为占位符（keep_viz=True 时替换为可视化摘要）；超出上限再截断。"""
    if not content:
        return ""
    if len(content) <= _CONTEXT_RECENT_FULL_MAX:
        return content
    summary = ""
    match = re.search(r"<summary>([\s\S]*?)</summary>", content, re.I)
    if match:
        summary = match.group(1).strip()[:200]

    def _viz_repl(match_obj):
        if keep_viz:
            return "[交互可视化摘要]" + "\n" + _viz_digest(match_obj.group(0))
        return VIZ_PLACEHOLDER

    text = re.sub(r"<viz>[\s\S]*?</viz>", _viz_repl, content, flags=re.I)
    text = re.sub(r"```html```\s*[\s\S]*?```html```", _viz_repl, text, flags=re.I)
    if len(text) <= _CONTEXT_RECENT_FULL_MAX:
        return text
    head = text[:_CONTEXT_RECENT_FULL_MAX]
    if summary:
        head += "\n\n<summary>" + summary + "</summary>"
    return head + "\n…（上下文已截断）"


def _viz_digest(content: str, max_chars: int = _VIZ_DIGEST_MAX) -> str:
    """从可视化 HTML 中提取模型可用的精简信息：可见文字 + 脚本片段。

    追问可视化时不再发送整段 HTML，避免占用大量 token。
    """
    if not content:
        return ""
    html = content
    viz = _extract_section(content, "viz")
    if viz:
        html = viz
    else:
        m = re.search(r"```html```\s*([\s\S]*?)```html```", content, re.I)
        if m:
            html = m.group(1)
    scripts = re.findall(r"<script[^>]*>([\s\S]*?)</script>", html, re.I)
    script_snippet = ""
    if scripts:
        joined = " ".join(scripts)
        script_snippet = re.sub(r"\s+", " ", joined).strip()[:_VIZ_DIGEST_MAX // 2]
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    lines = []
    if text:
        lines.append("页面文字：" + text[:800])
    if script_snippet:
        lines.append("脚本片段：" + script_snippet)
    return "\n".join(lines)[:max_chars]

_SOCRATIC_PROMPT_PREFIXES = ("[苏格拉底回答]", "[苏格拉底提示]", "[苏格拉底讲解]")


def _is_socratic_prompt_text(prompt: str) -> bool:
    """判断消息是否属于苏格拉底闭环（回答/提示/讲解三种前缀）。"""
    return bool(prompt and prompt.lstrip().startswith(_SOCRATIC_PROMPT_PREFIXES))


def _is_socratic_message(msg) -> bool:
    """识别苏格拉底支线消息，兼容新 branch 字段和历史内容标记。"""
    if not isinstance(msg, dict):
        return False
    if msg.get("branch") == "socratic" or msg.get("branchType") == "socratic":
        return True
    content = str(msg.get("content") or "")
    if content.lstrip().startswith("[苏格拉底回答]") or content.lstrip().startswith("[苏格拉底提示]") or content.lstrip().startswith("[苏格拉底讲解]"):
        return True
    if content.lstrip().startswith("我的回答："):
        return True
    if re.search(r"<socratic_meta\b", content, re.I) and not re.search(
        r"<physics>|<math>|<graph>|<extend>|PhyMathia\s*学习卡片", content, re.I
    ):
        return True
    return False


def _recent_context_messages(
    all_messages: list,
    max_rounds: int = 3,
    include_socratic: bool = False,
    current_prompt: str = "",
    summary_rounds: int = 7,
    budget_tokens: int = 0,
) -> list:
    """按最近用户轮次截取上下文，保留消息内容但剥离分支元数据。

    上下文瘦身策略（普通聊天/无 graph_path 路径）：
    - 最近 max_rounds 轮：用户消息完整保留（超长时截断到上限）；最近一条
      assistant 消息完整保留（<viz>/```html``` 大段 HTML 默认替换为占位符，
      仅当当前提问涉及可视化时才保留）；更早的 assistant 只保留摘要。
    - 更早的 summary_rounds 轮：每轮拆成「用户一行 + AI 一行」的摘要对，
      帮助长会话里理解"之前说过/继续"类指代，成本极低。
    - budget_tokens > 0 时，最后按 token 预算收缩，避免上下文溢出。
    """
    messages = all_messages
    if not include_socratic:
        messages = [msg for msg in all_messages if not _is_socratic_message(msg)]
    keep_viz = _prompt_wants_viz(current_prompt)
    full = []
    digest = []
    rounds = 0
    assistant_count = 0
    summary_rounds_seen = 0
    pending_ai = ""
    for msg in reversed(messages):
        role = msg.get("role", "user")
        content = str(msg.get("content") or "")
        if role == "user":
            if rounds < max_rounds:
                if len(content) > _CONTEXT_MAX_USER_CHARS:
                    content = content[:_CONTEXT_MAX_USER_CHARS] + "\n…（已截断）"
                full.insert(0, {"role": "user", "content": content})
                rounds += 1
            elif summary_rounds_seen < summary_rounds:
                digest.insert(0, {"role": "user", "content": "（更早对话）用户：" + content[:80]})
                if pending_ai:
                    digest.insert(1, {"role": "assistant", "content": "（更早对话）AI：" + pending_ai})
                pending_ai = ""
                summary_rounds_seen += 1
            else:
                break
        else:
            if rounds < max_rounds:
                if assistant_count == 0:
                    content = _trim_context_content(content, keep_viz=keep_viz)
                else:
                    content = _graph_message_summary(msg)
                full.insert(0, {"role": "assistant", "content": content})
                assistant_count += 1
            elif summary_rounds_seen < summary_rounds:
                pending_ai = _graph_message_summary(msg)[:120]
            else:
                break
    if pending_ai and summary_rounds_seen < summary_rounds:
        digest.insert(0, {"role": "assistant", "content": "（更早对话）AI：" + pending_ai})
    result = digest + full
    if budget_tokens and budget_tokens > 0:
        result = _shrink_history_to_budget(result, budget_tokens)
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


def _extract_parent_source(all_messages: list, parent_id: str, source_module: str) -> str:
    """从父消息中提取当前分支聚焦模块的正文；找不到时返回空串。"""
    for msg in all_messages:
        if msg.get("role") == "assistant" and str(msg.get("timestamp")) == str(parent_id):
            return _branch_source_content(str(msg.get("content") or ""), source_module)
    return ""


def _load_messages(session_id: str) -> list:
    """读取会话消息；真实路径走缓存，字符串/测试兼容路径回退普通读取。"""
    messages_path = _resolve_messages_path(session_id)
    if hasattr(messages_path, "stat"):
        return _read_json_cached(messages_path, [])
    return _read_json(messages_path, [])


def _load_session_context(
    session_id: str,
    max_rounds: int = 3,
    include_socratic: bool = False,
    branch_id: str = "",
    branch_type: str = "",
    source_module: str = "",
    parent_id: str = "",
    graph_path: list = None,
    current_prompt: str = "",
    workflow_context: dict = None,
    budget_tokens: int = 0,
) -> list:
    """加载会话上下文消息，支持探索网分支隔离。

    普通问答默认过滤苏格拉底支线；当传入 branch_id 时，保留主线最近内容、
    父回答中聚焦模块的内容，以及该分支自己的消息链。
    budget_tokens > 0 时按 token 预算收缩（保留最后一条消息）。
    """
    all_messages = _load_messages(session_id)
    if not all_messages:
        return []
    if graph_path:
        return _load_session_context_from_path(
            session_id,
            graph_path,
            branch_id=branch_id,
            source_module=source_module,
            max_rounds=max_rounds,
            current_prompt=current_prompt,
            workflow_context=workflow_context,
            budget_tokens=budget_tokens,
        )
    if not branch_id:
        return _recent_context_messages(
            all_messages, max_rounds, include_socratic, current_prompt,
            budget_tokens=budget_tokens,
        )

    branch_messages = [msg for msg in all_messages if msg.get("branchId") == branch_id]
    main_messages = [msg for msg in all_messages if not msg.get("branchId") and not _is_socratic_message(msg)]
    result = _recent_context_messages(main_messages, min(2, max_rounds), False, current_prompt)
    seen = {}
    main_ts = _content_timestamp_map(main_messages)
    for item in result:
        seen.setdefault((main_ts.get(item["content"], ""), item["content"]), True)

    target_parent = parent_id or (branch_messages[0].get("parentId") if branch_messages else "")
    source_ts = target_parent
    if target_parent:
        source = _extract_parent_source(all_messages, target_parent, source_module)
        if not source and branch_messages:
            fallback_parent = branch_messages[0].get("parentId") or ""
            if fallback_parent and str(fallback_parent) != str(target_parent):
                source = _extract_parent_source(all_messages, fallback_parent, source_module)
                source_ts = fallback_parent
        if source and (str(source_ts), source) not in seen:
            result.append({"role": "assistant", "content": source})
            seen[(str(source_ts), source)] = True

    branch_ts = _content_timestamp_map(branch_messages)
    for item in _recent_context_messages(branch_messages, max_rounds, True, current_prompt):
        key = (branch_ts.get(item["content"], ""), item["content"])
        if key not in seen:
            result.append(item)
            seen[key] = True

    if budget_tokens and budget_tokens > 0:
        result = _shrink_history_to_budget(result, budget_tokens)
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
    if module_key == "graph":
        return (
            "严格输出知识图谱 Mermaid 代码，不要输出其他模块、不要输出 XML 标签：\n"
            "用 ```mermaid ... ``` 代码块包裹；至少 3 个上游 + 3 个下游概念，中文标注，箭头表示关系，节点文字避免括号（可用下划线替代）。"
        )
    if module_key == "viz":
        return (
            "严格输出 ```html ... ``` 完整 HTML 交互可视化页面，禁止只输出文字描述而不输出 HTML：\n"
            "页面内顶部必须包含图说四段（用页面内可见标题/提示框呈现，缺一不可）：\n"
            "**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n"
            "**怎么看这张图**：1. 2. 3. 编号观察步骤，每步“操作 → 会看到什么”；\n"
            "**和公式的联系**：图中现象与公式如何互相印证；\n"
            "**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n"
            "每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n"
            "不要输出 XML 标签，不要输出其他模块内容。"
        )
    return ""


def _graph_message_summary(message: dict, module_key: str = "") -> str:
    content = str(message.get("content") or "")
    if not module_key:
        cached = str(message.get("summary") or "").strip()
        if cached:
            return cached[:200]
    if module_key:
        content = _branch_source_content(content, module_key)
    match = re.search(r"<summary>([\s\S]*?)</summary>", content, re.I)
    if match:
        return match.group(1).strip()[:200]
    text = re.sub(r"<[^>]+>", " ", content)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= 180:
        return text
    # 按句子边界截断，避免切在公式/半句话中间
    head = text[:180]
    for sep in ("。", "！", "？", ". ", "! ", "? "):
        idx = head.rfind(sep)
        if idx > 40:
            return head[:idx + len(sep)].strip() + "…"
    return head + "…"

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
        lines.append("- 概要末尾单独一行列出建议生成的知识网络模块方向，格式：建议模块：物理视角、数学视角（候选：物理视角/数学视角/知识图谱/交互可视化/苏格拉底追问/进阶学习；追问等场景按实际需要选择，不必全部列出，也不要超出候选）。")
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
    current_prompt: str = "",
    workflow_context: dict = None,
    budget_tokens: int = 0,
) -> list:
    all_messages = _load_messages(session_id)
    if not all_messages or not graph_path:
        return []
    by_ts = {str(msg.get("timestamp") or ""): msg for msg in all_messages}
    result = []
    seen = {}
    active_parent_missing = False
    active_content = ""
    active_index = len(graph_path) - 1
    skip_upstream = bool(workflow_context and workflow_context.get("upstream"))

    for index, item in enumerate(graph_path):
        msg = by_ts.get(str(item.get("timestamp") or ""))
        if not msg:
            continue
        is_active = index == active_index
        role = msg.get("role") or "assistant"
        module_key = item.get("module") or item.get("moduleKey") or ""
        ts = str(item.get("timestamp") or "")
        if role == "user":
            content = str(msg.get("content") or "")
        elif is_active:
            content = str(msg.get("content") or "")
            if module_key:
                content = _branch_source_content(content, module_key)
                if not content:
                    active_parent_missing = True
            active_content = content
        elif skip_upstream:
            continue
        else:
            content = _graph_message_summary(msg, module_key if not is_active else "")
        if not content:
            continue
        key = (ts, content)
        if key in seen:
            continue
        result.append({"role": role, "content": content})
        seen[key] = True

    if active_parent_missing and branch_id:
        branch_messages = [
            msg for msg in all_messages
            if str(msg.get("branchId") or "") == str(branch_id)
        ]
        fallback_parent = branch_messages[0].get("parentId") if branch_messages else ""
        if fallback_parent:
            source = _extract_parent_source(all_messages, fallback_parent, source_module)
            if source:
                key = (str(fallback_parent), source)
                if key not in seen:
                    result.append({"role": "assistant", "content": source})
                    seen[key] = True
                    if not active_content:
                        active_content = source

    if branch_id:
        branch_messages = [
            msg for msg in all_messages
            if str(msg.get("branchId") or "") == str(branch_id)
        ]
        branch_ts = _content_timestamp_map(branch_messages)
        for item in _recent_context_messages(branch_messages, max_rounds, True, current_prompt):
            key = (branch_ts.get(item["content"], ""), item["content"])
            if key not in seen:
                result.append(item)
                seen[key] = True

    if budget_tokens and budget_tokens > 0:
        protected = {active_content} if active_content else set()
        result = _shrink_history_to_budget(result, budget_tokens, protected)
    return result


SOCRATIC_STATE_PREFIX = "socratic:"

SOCRATIC_STATE_TTL_SECONDS = 24 * 60 * 60
# 低于该值的时间戳视为旧版占位值（非真实 epoch），不做 TTL 清理
SOCRATIC_STATE_TS_SANITY = 100_000_000


def _socratic_state_expired(state, now: int = None) -> bool:
    """苏格拉底状态超过 TTL 未更新视为过期；无 updatedAt 或旧版占位时间戳不主动清理。"""
    if not isinstance(state, dict):
        return False
    updated = int(state.get("updatedAt") or 0)
    if not updated or updated < SOCRATIC_STATE_TS_SANITY:
        return False
    now = now if now is not None else int(time.time())
    return now - updated > SOCRATIC_STATE_TTL_SECONDS


def _socratic_key(ref: str) -> str:
    return f"{SOCRATIC_STATE_PREFIX}{ref}"


def _read_socratic_state(ref: str):
    data = _read_json(KV_PATH, {})
    state = data.get(_socratic_key(ref))
    if isinstance(state, dict) and state.get("active"):
        if _socratic_state_expired(state):
            _delete_socratic_state(ref)
            return None
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
    """删除指定会话/分支的苏格拉底状态。

    兼容三种 key：
    - 精确 key：socratic:{ref}（手动输入路径 / 会话级状态）
    - 分支链前缀：socratic:br_{会话id前18字符}_{uuid}（“我来回答”弹窗路径）
    - 旧逻辑子串匹配兜底
    """
    def updater(data):
        if not ref:
            return data
        remove_keys = []
        exact = f"{SOCRATIC_STATE_PREFIX}{ref}"
        if exact in data:
            remove_keys.append(exact)
        session_part = re.sub(r"[^A-Za-z0-9_-]", "", ref)[:18]
        if session_part:
            prefix = f"{SOCRATIC_STATE_PREFIX}br_{session_part}_"
            remove_keys.extend(k for k in data if k.startswith(prefix) and k not in remove_keys)
        # 兼容旧逻辑：子串匹配（如短会话 id / 手动输入路径）
        for key in list(data):
            if key.startswith(SOCRATIC_STATE_PREFIX) and ref in key and key not in remove_keys:
                remove_keys.append(key)
        for key in remove_keys:
            data.pop(key, None)
        return data

    _mutate_json(KV_PATH, updater)


def _resolve_socratic_branch(session_id: str) -> str:
    """手动输入 [苏格拉底回答] 且未带分支时，定位最近仍在进行的苏格拉底分支。

    优先使用 KV 中该会话最新的活动分支状态；没有活动状态时，回退到消息里
    最近一条苏格拉底消息所在的分支（用于上下文隔离）。过期状态会被清理。
    """
    if not session_id:
        return ""
    data = _read_json(KV_PATH, {})
    session_part = re.sub(r"[^A-Za-z0-9_-]", "", session_id)[:18]
    prefix = f"{SOCRATIC_STATE_PREFIX}br_{session_part}_"
    best_ref = ""
    best_ts = -1
    expired_keys = []
    for key, state in data.items():
        if key.startswith(prefix) and isinstance(state, dict) and state.get("active"):
            if _socratic_state_expired(state):
                expired_keys.append(key)
                continue
            ts = int(state.get("updatedAt") or 0)
            if ts > best_ts:
                best_ts = ts
                best_ref = key[len(SOCRATIC_STATE_PREFIX):]
    if expired_keys:
        def updater(d):
            for k in expired_keys:
                d.pop(k, None)
            return d
        _mutate_json(KV_PATH, updater)
    if best_ref:
        return best_ref
    messages = _load_messages(session_id)
    for msg in reversed(messages):
        if msg.get("role") == "user" and _is_socratic_message(msg):
            bid = str(msg.get("branchId") or "")
            if bid:
                return bid
    return ""


def _socratic_state_instruction(ref: str, mode: str = "answer") -> str:
    state = _read_socratic_state(ref)
    if not state:
        return ""
    level = state.get("level", "") or "basic"
    streak = int(state.get("correctStreak", 0) or 0)
    answered = int(state.get("answeredCount", 0) or 0)
    question = state.get("question", "") or ""
    last_correct = state.get("lastCorrect", "") or ""
    last_confidence = state.get("lastConfidence", "") or ""
    lines = [
        f"当前会话处于苏格拉底追问闭环：问题等级={level}，当前问题={question}，"
        f"已连续答对 {streak} 次，本轮闭环已问答 {answered} 轮。"
    ]
    if last_correct:
        lines.append(
            f"上一轮判定：{last_correct}（正确→下一题可升一级加深角度；部分正确→同级换类比再问；有误→降一级并用更生活化的类比）。"
        )
    if last_confidence:
        lines.append(
            f"用户上次自评把握：{last_confidence}（答对但没把握→请其再解释一遍；答错但很有把握→制造认知冲突重点纠偏）。"
        )
    if mode == "hint":
        lines.append(
            "用户请求【提示】：只给出最小提示，不要展开完整讲解、不要直接给答案；"
            "然后再次用带难度前缀的问题请其重试（本次回复不输出 <socratic_meta>）。"
        )
    elif mode == "explain":
        lines.append(
            "用户请求【讲解】：直接给出完整讲解与小结，末尾输出 <socratic_meta ... done=\"true\" /> 结束闭环。"
        )
    else:
        lines.append(
            "用户会以 [苏格拉底回答] 开头携带追问问题、把握程度与自己的回答；请结合最近一条 AI 讲解、当前问题和用户回答继续，"
            "按系统提示词中的闭环规则只推进一层，并在回复末尾输出 <socratic_meta .../>。"
        )
    lines.append("若本轮闭环已问答 4 轮仍未连续答对 2 次，请直接给出小结并结束闭环（done=\"true\"）。")
    return " ".join(lines)


def _sync_socratic_state_from_prompt(state: dict, prompt: str) -> None:
    """延续中的闭环：用 [苏格拉底回答] 消息里的问题/等级刷新状态，保留连对次数与已答轮数。"""
    if not state or not prompt:
        return
    level_match = re.search(r"追问等级[：:]\s*(基础|进阶|拓展)", prompt)
    if level_match:
        level_map = {"基础": "basic", "进阶": "advanced", "拓展": "expand"}
        state["level"] = level_map.get(level_match.group(1), state.get("level", ""))
    question_match = re.search(r"追问问题[：:]\s*([^\n]+)", prompt)
    if question_match and question_match.group(1).strip():
        state["question"] = question_match.group(1).strip()
    confidence_match = re.search(r"把握程度[：:]\s*(很有把握|一般|猜的)", prompt)
    if confidence_match:
        state["lastConfidence"] = confidence_match.group(1)


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
    state["lastCorrect"] = correct
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
    "_is_socratic_message", "_is_socratic_prompt_text", "_recent_context_messages", "_extract_section",
    "_branch_source_content", "_extract_parent_source", "_load_session_context", "_branch_context_instruction",
    "_module_output_instruction", "_graph_message_summary", "_graph_path_instruction",
    "_workflow_context_instruction", "_load_session_context_from_path",
    "_prompt_wants_viz", "_trim_context_content", "VIZ_PLACEHOLDER",
    "SOCRATIC_STATE_PREFIX", "SOCRATIC_STATE_TTL_SECONDS", "estimate_tokens", "resolve_context_budget", "_shrink_history_to_budget", "_content_timestamp_map", "_socratic_state_expired", "_viz_digest", "_socratic_key", "_read_socratic_state",
    "_write_socratic_state", "_delete_socratic_state", "_resolve_socratic_branch", "_socratic_state_instruction",
    "_sync_socratic_state_from_prompt", "_update_socratic_state_from_content", "_is_socratic_followup",
]
