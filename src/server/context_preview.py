"""上下文体检工具（开发调试用）。

正式版删除方法：删除本文件，并移除 main.py 中的两行挂载代码即可。
"""
import json

from fastapi import APIRouter

from . import concept as concept_mod
from . import context as context_mod
from . import profile as profile_mod
from .config import LEVEL_PROMPTS
from .prompts import MODULE_SYSTEM_PROMPT, QUICK_SYSTEM_PROMPT, get_system_prompt

router = APIRouter(prefix="/api/context", tags=["context-preview"])


@router.get("/preview")
async def preview_context(
    session_id: str = "",
    prompt: str = "",
    level: str = "university",
    quick: int = 0,
    branch_id: str = "",
    source_module: str = "",
    parent_id: str = "",
    graph_path: str = "",
    workflow: int = 0,
    model_name: str = "",
    device_id: str = "",
):
    """返回该请求实际会发给模型的消息列表与 token 估算，不发起真实调用。"""
    try:
        graph_path_list = json.loads(graph_path) if graph_path else []
    except Exception:
        graph_path_list = []
    is_quick = bool(quick)
    if is_quick:
        system_content = QUICK_SYSTEM_PROMPT
    elif workflow:
        system_content = MODULE_SYSTEM_PROMPT
    else:
        system_content = get_system_prompt()
    budget = context_mod.resolve_context_budget(model_name)
    # 概念地基（M4）：体检工具必须与真实 chat 路径同构，否则「预览里没有」会被当成没生效。
    # 记忆第二步：画像薄弱词加权也与 chat 同构——带 device_id 才有权重（不传 = 无画像）。
    if not is_quick and not workflow and not branch_id:
        concept_text = concept_mod.concept_context_text(
            prompt, session_id=session_id,
            weak_terms=(profile_mod.profile_weak_terms(device_id) if device_id else None),
        )
        if concept_text:
            system_content += "\n\n" + concept_text
    messages = [{"role": "system", "content": system_content}]
    if session_id:
        messages.extend(
            context_mod._load_session_context(
                session_id,
                include_socratic=False,
                branch_id=branch_id,
                source_module=source_module,
                parent_id=parent_id,
                graph_path=graph_path_list,
                current_prompt=prompt,
                budget_tokens=budget,
            )
        )
    tail_parts = []
    if session_id and graph_path_list:
        # 与 chat 路径同构（2026-09-24 树路径拍板）：当前聚焦节点全文在末条
        # user 消息的上下文块里，不再出现在历史区。
        active_block = context_mod.tree_active_content_block(
            session_id, graph_path_list, source_module=source_module, branch_id=branch_id)
        if active_block:
            tail_parts.append(active_block)
    user_content = prompt
    if tail_parts:
        user_content = "<上下文>\n" + "\n\n".join(tail_parts) + "\n</上下文>\n\n" + prompt
    if not is_quick:
        suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
        messages.append({"role": "user", "content": user_content + suffix})
    else:
        messages.append({"role": "user", "content": user_content})
    total_chars = sum(len(str(m.get("content") or "")) for m in messages)
    total_tokens = context_mod.estimate_tokens("".join(str(m.get("content") or "") for m in messages))
    return {
        "messages": messages,
        "count": len(messages),
        "total_chars": total_chars,
        "est_tokens": total_tokens,
        "budget_tokens": budget,
        "over_budget": total_tokens > budget,
    }
