"""节点工坊 C1：`/workshop/step` 的模型调用薄层（2026-10-25）。

只做三件事：①剔除客户端上送的 system 消息、把服务端固定的工坊系统提示词顶到
最前；②解析/清洗模型配置；③带固定工具表调 `_call_model`（非流式、
tool_choice=auto、max_tokens 有上限），把 `{content, tool_calls}` 原样还给前端。

**不执行任何工具**——配方库在 localStorage、画布在内存，执行器在浏览器的
`_rwAgentExecTool`（graph-workshop.js）。想改成服务端执行，先回答 localStorage
与画布状态怎么落到服务端（C1 拍板：不做）。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from .prompts import HARNESS_WORKSHOP_AGENT_SYSTEM_PROMPT
from .review import HarnessError, _apply_thinking_default, _call_model, _resolve_model
from .workshop_tools import build_workshop_tools

logger = logging.getLogger(__name__)

# 单步输出上限：工具循环每步只要「下一步动作＋一句话」，2000 封顶防客户端灌大预算
WORKSHOP_STEP_MAX_TOKENS = 1500
WORKSHOP_STEP_TOKENS_CEILING = 2000
# 消息条数上限：10 步 ×（1 assistant＋若干 tool 回灌）远用不到 60，超了＝客户端异常
WORKSHOP_STEP_MAX_MESSAGES = 60
# 单条 content 上限（字符）：工具回灌里最大的是配方快照/输出节选（<8KB），留足余量
WORKSHOP_STEP_CONTENT_MAX_CHARS = 20000

# 每种 role 允许透传的键：其余一律剥掉（客户端塞 name/prefix/metadata 之类的
# 非标准键，上游多半 400，白烧一次重试）
_ALLOWED_MESSAGE_KEYS = {
    "user": ("role", "content"),
    "assistant": ("role", "content", "tool_calls"),
    "tool": ("role", "content", "tool_call_id", "name"),
}


def sanitize_workshop_messages(raw: Any) -> Optional[List[Dict[str, Any]]]:
    """客户端消息表消毒：剔 system、剥多余键、截超长 content；不合法返回 None。

    系统提示词是服务端人格（角色/规矩/枚举），客户端上送的 system 一律不认——
    剔除而不是拒绝，前端不需要为此先过滤一遍。
    """
    if not isinstance(raw, list) or not raw:
        return None
    out: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        role = str(item.get("role") or "")
        if role == "system":
            continue
        allowed = _ALLOWED_MESSAGE_KEYS.get(role)
        if allowed is None:
            return None
        clean: Dict[str, Any] = {"role": role}
        content = item.get("content")
        if content is not None:
            content = str(content)[:WORKSHOP_STEP_CONTENT_MAX_CHARS]
        clean["content"] = content
        if role == "assistant":
            tool_calls = item.get("tool_calls")
            clean["tool_calls"] = tool_calls if isinstance(tool_calls, list) else []
        if role == "tool":
            clean["tool_call_id"] = str(item.get("tool_call_id") or "")[:120]
            if item.get("name") is not None:
                clean["name"] = str(item.get("name"))[:64]
        out.append(clean)
        if len(out) >= WORKSHOP_STEP_MAX_MESSAGES:
            break
    # 全被剔成空（客户端只送了 system）＝没有可续的对话
    return out or None


async def workshop_step_call(
    messages: Any,
    model: Any = None,
    thinking: str = "",
    max_tokens: Any = None,
) -> Dict[str, Any]:
    """一步工坊工具循环的模型调用：返回 {status, content, tool_calls}（OpenAI 原样形状）。"""
    clean = sanitize_workshop_messages(messages)
    if clean is None:
        raise HarnessError("messages 不合法：需要至少一条 user/assistant/tool 消息（system 会被剔除）")
    resolved = _resolve_model(model)
    _apply_thinking_default(resolved, str(thinking or ""), "preset")
    try:
        tokens = int(max_tokens or WORKSHOP_STEP_MAX_TOKENS)
    except (TypeError, ValueError):
        tokens = WORKSHOP_STEP_MAX_TOKENS
    tokens = max(256, min(tokens, WORKSHOP_STEP_TOKENS_CEILING))
    tools = build_workshop_tools()
    full = [{"role": "system", "content": HARNESS_WORKSHOP_AGENT_SYSTEM_PROMPT}] + clean
    reply = await _call_model(
        full,
        resolved,
        tokens,
        tools=tools,
        tool_choice="auto",
    )
    logger.info(
        "workshop agent step: tools=%d msgs=%d content_chars=%d tool_calls=%d",
        len(tools), len(full),
        len(str(reply.get("content") or "")), len(reply.get("tool_calls") or []),
    )
    return {
        "status": "ok",
        "content": reply.get("content") or "",
        "tool_calls": reply.get("tool_calls") or [],
    }
