"""Model-backed review flow for the independent harness.

Supports two operation submission modes:
- tools (function calling): preferred, more stable; the model emits tool_calls
  which are converted into the internal operation contract;
- json (free-form JSON): fallback for providers without function-calling
  support, or when tools requests fail.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any, Dict, Optional

import httpx

from .core import (
    MAX_SNAPSHOT_CHARS,
    MAX_SNAPSHOT_HARD_CHARS,
    NON_FOCUS_CONTENT_CHARS,
    build_inverse_ops,
    build_next_snapshot,
    diff_snapshots,
    normalize_snapshot,
)
from .selfcheck import (
    SELFCHECK_TOOL,
    build_selfcheck_messages,
    parse_selfcheck,
    parse_selfcheck_tool,
)
from .semantics import find_isolated_created_nodes, find_missing_expansion_chains, rule_selfcheck
from .json_utils import extract_json
from .prompts import (
    build_apply_messages,
    build_evaluate_messages,
    build_expand_messages,
    build_resolve_messages,
    build_review_messages,
)
from .tools import build_tools, parse_tool_calls

logger = logging.getLogger("harness.review")

DEFAULT_PROVIDER_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com/v1",
}

EVALUATE_HINTS = (
    "评价", "建议", "反馈", "点评", "指出", "哪里需要改进",
    "挑错", "有问题吗", "对不对", "哪里不对", "帮我看看",
)
APPLY_HINTS = ("应用建议", "采纳建议", "按建议", "执行建议", "应用评价", "按评价")
MODIFY_HINTS = (
    "修改", "改成", "更正", "纠正", "重写", "更新", "删掉", "删除",
    "补充", "新增", "创建", "连接", "加上", "加一个", "补一个", "改进", "完善",
)
EXPAND_HINTS = ("拓展", "进阶", "延伸学习", "深入学习", "深化")

TOOLS_USER_HINT = (
    "\n\n（本次请求支持工具调用：请优先使用提供的工具提交 operations，"
    "不要在文本里重复输出 JSON；文本内容只写一句话 summary。若工具不可用，再按上面的 JSON 结构输出。）"
)
TOOLS_AUTO_HINT = (
    "\n\n（本次支持两种回答方式：如果用户只是提问/讨论，请直接用文字回答，不需要调用工具；"
    "如果用户要求修改图，请使用工具提交 operations，文本只写一句话 summary。）"
)



UNDO_HINTS = (
    "撤销", "回退", "恢复", "还原", "撤回", "不要刚才", "重来",
    "改回去", "改回", "退回", "退回去", "撤掉", "撤了", "不要了",
    "刚加的", "删掉刚才", "undo", "rollback",
)


def _detect_undo_intent(instruction: str) -> bool:
    text = str(instruction or "")
    return any(hint in text.lower() for hint in UNDO_HINTS)


def _filter_inverse_by_targets(inverse_ops: list, targets, snapshot=None) -> list:
    targets = {str(item) for item in (targets or []) if str(item)}
    if not targets:
        return inverse_ops
    edge_ends = {}
    if snapshot is not None:
        try:
            norm = normalize_snapshot(snapshot)
            for e in norm["edges"]:
                key = str(e.get("key") or "")
                if key:
                    edge_ends[key] = {str(e.get("from") or ""), str(e.get("to") or "")}
        except Exception:
            edge_ends = {}
    kept = []
    for op in inverse_ops:
        ids = [op.get("id"), op.get("from"), op.get("to"), op.get("temp_id"), op.get("force_id")]
        if any(str(item) in targets for item in ids if item):
            kept.append(op)
            continue
        ek = str(op.get("edge_key") or op.get("key") or "")
        ends = edge_ends.get(ek)
        if ends and ends & targets:
            kept.append(op)
    return kept


def _undo_scope(instruction: str, focus_node_ids) -> str:
    """Decide how much history an undo request should revert.

    - 'full': 撤销全部/所有修改（回到最初快照）
    - 'targeted': 指定了目标节点，且表达“恢复原样/改回去/撤掉”等上下文反悔
      —— 撤销该目标相关的全部历史改动，保留其它改动
    - 'last': 只撤销上一步修改
    """
    text = str(instruction or "")
    if "全部" in text or "所有" in text:
        return "full"
    if focus_node_ids and any(k in text for k in (
        "恢复", "还原", "原样", "改回", "退回", "撤掉", "撤了", "不要了", "刚加的", "那边",
    )):
        return "targeted"
    return "last"


def _history_block(history) -> str:
    if not history:
        return ""
    lines = ["\n\n此前多轮编辑历史（最新在后）："]
    for i, item in enumerate(history):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        if role == "user":
            lines.append(f"{i + 1}. 用户：{str(item.get('instruction') or '')[:200]}")
        else:
            ops = item.get("operations") or []
            op_desc = "；".join(
                f"{o.get('op')}({o.get('id') or o.get('temp_id') or o.get('label') or ''})"
                for o in ops[:20]
            )
            lines.append(f"{i + 1}. 助手：{str(item.get('summary') or '')[:120]}" + (f"；操作：{op_desc[:300]}" if op_desc else ""))
    return "\n".join(lines)


class HarnessError(RuntimeError):
    pass


def _supports_required_tool_choice(provider: str) -> bool:
    """Providers that accept tool_choice="required" (some free/open proxies do not)."""
    return str(provider or "").strip().lower() in ("deepseek", "openai")


def _supports_json_mode(provider: str) -> bool:
    """Providers that accept response_format={"type":"json_object"}."""
    return str(provider or "").strip().lower() in ("deepseek", "openai")



def _has_edit_intent(text: str) -> bool:
    """True when the instruction contains explicit graph-edit verbs."""
    return any(hint in str(text or "") for hint in MODIFY_HINTS)


def _detect_phase(phase: str, instruction: str, snapshot: dict, focus_node_ids=None) -> str:
    """Choose the intended harness phase from explicit phase or instruction hints."""
    text = str(instruction or "")
    has_eval = any(hint in text for hint in EVALUATE_HINTS)
    has_modify = any(hint in text for hint in MODIFY_HINTS)
    has_expand = any(hint in text for hint in EXPAND_HINTS)
    has_apply = any(hint in text for hint in APPLY_HINTS)
    focus_ids = [str(item) for item in (focus_node_ids or []) if str(item)]
    has_eval_nodes = any(node.get("kind") == "ai_eval" for node in snapshot.get("nodes", []))
    auto_phases = ("", "auto", "normal", "expand")
    if phase == "apply" or (phase in auto_phases and has_apply and has_eval_nodes):
        return "apply"
    if phase in auto_phases and has_expand and focus_ids:
        return "expand"
    if phase == "evaluate" or (phase in auto_phases and has_eval):
        return "evaluate"
    if phase in auto_phases and has_modify and not has_eval:
        return "normal"
    return "normal"


def _resolve_model(model: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    model = model or {}
    provider = str(model.get("provider") or "deepseek").strip()
    model_name = str(model.get("model") or model.get("model_name") or "deepseek-chat").strip()
    base_url = str(model.get("base_url") or model.get("baseUrl") or "").strip()
    api_key = str(model.get("api_key") or model.get("apiKey") or os.getenv("DEEPSEEK_API_KEY", "")).strip()
    if not base_url:
        base_url = DEFAULT_PROVIDER_URLS.get(provider, "")
    if not model_name:
        raise HarnessError("模型名称不能为空")
    if not base_url:
        raise HarnessError("模型 API 地址不能为空")
    return {
        "provider": provider,
        "model": model_name,
        "base_url": base_url,
        "api_key": api_key,
    }


async def _call_model(
    messages: list,
    model: Dict[str, Any],
    max_tokens: int,
    tools: Optional[list] = None,
    tool_choice: Optional[str] = None,
    json_mode: bool = False,
) -> Dict[str, Any]:
    """Call the chat completions endpoint and return content + tool_calls."""
    url = f"{model['base_url'].rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if model["api_key"] and model["provider"] != "opencode":
        headers["Authorization"] = f"Bearer {model['api_key']}"
    body = {
        "model": model["model"],
        "messages": messages,
        "stream": False,
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    if tools:
        body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
    elif json_mode:
        body["response_format"] = {"type": "json_object"}
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as exc:
        raise HarnessError(f"模型请求失败: {exc}") from exc
    if resp.status_code != 200:
        detail = resp.text[:500]
        raise HarnessError(f"模型返回 {resp.status_code}: {detail}")
    try:
        data = resp.json()
        message = data["choices"][0].get("message") or {}
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise HarnessError("模型响应缺少有效内容") from exc
    logger.info(
        "harness model call: %s/%s tools=%s tool_choice=%s json_mode=%s",
        model["provider"], model["model"], bool(tools), tool_choice or "-", json_mode,
    )
    return {
        "content": str(message.get("content") or ""),
        "tool_calls": message.get("tool_calls") or [],
    }





def _complete_expand_chains(current: Dict[str, Any], result: Dict[str, Any], focus_node_ids) -> Dict[str, Any]:
    """Deterministic safety net for expand phase: when the model created answer
    nodes but forgot the corresponding learn module, auto-create one and connect
    it (answer -> learn). Only applies to created answers."""
    ops = list(result.get("operations") or [])
    answers = []
    learn_ids = set()
    edges = []
    for op in ops:
        name = str(op.get("op") or "")
        node_id = str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")
        if name == "create_node":
            if str(op.get("kind") or "") == "answer":
                answers.append(op)
            elif str(op.get("kind") or "") == "module" and str(op.get("module_key") or "") == "learn":
                if node_id:
                    learn_ids.add(node_id)
        elif name == "add_edge":
            edges.append((str(op.get("from") or ""), str(op.get("to") or "")))
    edge_pairs = set(edges)
    missing = [
        op for op in answers
        if not any((str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or ""), learn) in edge_pairs for learn in learn_ids)
    ]
    if not missing:
        return result
    extra_ops = []
    for op in missing:
        answer_id = str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")
        if not answer_id:
            continue
        extra_ops.append({
            "op": "create_node",
            "temp_id": "auto_learn_" + answer_id,
            "kind": "module",
            "module_key": "learn",
            "label": "进阶学习",
            "content": str(op.get("content") or "")[:300] or "进阶学习内容",
            "reason": "自动补全进阶学习模块（模型遗漏）",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": answer_id,
            "to": "auto_learn_" + answer_id,
            "relation": "模块",
            "label": "进入进阶内容",
            "reason": "自动补全进阶学习链",
        })
    merged = build_next_snapshot(result.get("next_snapshot") or current, extra_ops)
    result["operations"] = ops + list(merged.get("operations") or [])
    result["next_snapshot"] = merged["next_snapshot"]
    result["diff"] = diff_snapshots(current, merged["next_snapshot"])
    for err in merged.get("errors") or []:
        result.setdefault("errors", []).append(err)
    result.setdefault("warnings", []).append({
        "index": "auto-learn",
        "op": "create_node",
        "reason": "为 " + str(len(missing)) + " 个 AI 回答节点自动补全进阶学习模块",
    })
    return result


def _auto_connect_isolated(current: Dict[str, Any], result: Dict[str, Any], focus_node_ids, instruction: str = "") -> Dict[str, Any]:
    """Deterministic safety net: connect created nodes that ended up isolated
    (no add_edge referencing them) to the focus node, or to the first existing
    node when there is no focus. Never runs for evaluate/apply phases."""
    text = str(instruction or "")
    if any(word in text for word in ("独立", "单独", "不要连接", "不连接")):
        return result
    ops = list(result.get("operations") or [])
    created = [op for op in ops if str(op.get("op")) == "create_node"]
    if not created:
        return result
    edge_endpoints = set()
    for op in ops:
        if str(op.get("op")) == "add_edge":
            if op.get("from"):
                edge_endpoints.add(str(op.get("from")))
            if op.get("to"):
                edge_endpoints.add(str(op.get("to")))
    isolated = [
        op for op in created
        if str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "") not in edge_endpoints
    ]
    if not isolated:
        return result
    existing_ids = [str(node.get("id")) for node in current.get("nodes", [])]
    anchors = [str(item) for item in (focus_node_ids or []) if str(item) in existing_ids]
    anchor = anchors[0] if anchors else (existing_ids[0] if existing_ids else None)
    if not anchor:
        return result
    extra_ops = [
        {
            "op": "add_edge",
            "from": anchor,
            "to": str(op.get("assigned_id") or op.get("id") or op.get("temp_id")),
            "relation": "关联",
            "label": "自动连接（避免孤立节点）",
            "reason": "自动连接（避免孤立节点）",
        }
        for op in isolated
    ]
    merged = build_next_snapshot(result.get("next_snapshot") or current, extra_ops)
    result["operations"] = ops + list(merged.get("operations") or [])
    result["next_snapshot"] = merged["next_snapshot"]
    result["diff"] = diff_snapshots(current, merged["next_snapshot"])
    for err in merged.get("errors") or []:
        result.setdefault("errors", []).append(err)
    result.setdefault("warnings", []).append({
        "index": "auto-connect",
        "op": "add_edge",
        "reason": "为 " + str(len(extra_ops)) + " 个孤立新节点自动连接到「" + anchor + "」",
    })
    return result


def _fallback_summary(ops: list) -> str:
    """Build a compact Chinese summary from validated operations when the model
    returned no text (common with tool-calling where content is empty)."""
    parts = []
    for op in ops or []:
        name = str(op.get("op") or op.get("type") or "")
        label = str(op.get("label") or op.get("title") or op.get("id") or "")
        target = str(op.get("target_label") or op.get("target") or op.get("target_node_id") or op.get("from") or "")
        if name == "create_node":
            parts.append("新增「" + (label or "节点") + "」")
        elif name == "create_eval_node":
            parts.append("为「" + (target or label or "目标节点") + "」生成评价")
        elif name == "update_node":
            parts.append("修改「" + (label or op.get("id") or "节点") + "」")
        elif name == "delete_node":
            parts.append("删除「" + (label or op.get("id") or "节点") + "」")
        elif name == "add_edge":
            parts.append("新增连线 " + str(op.get("from") or "") + "→" + str(op.get("to") or ""))
        elif name == "remove_edge":
            parts.append("删除连线 " + str(op.get("edge_key") or ""))
        elif name == "update_edge":
            parts.append("修改连线 " + str(op.get("edge_key") or ""))
    if not parts:
        return ""
    head = "已生成 " + str(len(ops or [])) + " 条图修改：" + "；".join(parts)
    return head[:200]


def _summarize_errors(errors) -> str:
    lines = []
    for item in errors or []:
        op = item.get("op") or "?"
        reason = item.get("reason") or "?"
        lines.append(f"- operation {item.get('index', '?')} ({op}): {reason}")
    return "\n".join(lines)




def _compact_snapshot(snapshot: Dict[str, Any], focus_node_ids) -> Dict[str, Any]:
    """Trim non-focus node content for large snapshots; raise when still too big."""
    if len(json.dumps(snapshot, ensure_ascii=False)) <= MAX_SNAPSHOT_CHARS:
        return snapshot
    focus = {str(item) for item in (focus_node_ids or [])}
    for node in snapshot.get("nodes", []):
        if node.get("id") in focus or node.get("kind") == "ai_eval":
            continue
        node["content"] = str(node.get("content") or "")[:NON_FOCUS_CONTENT_CHARS]
        node["formula"] = ""
    if len(json.dumps(snapshot, ensure_ascii=False)) > MAX_SNAPSHOT_HARD_CHARS:
        count = len(snapshot.get("nodes") or [])
        raise HarnessError(f"快照过大（{count} 个节点），请先选中局部节点或缩小范围后再让 AI 修改")
    return snapshot


async def _selfcheck_ops(snapshot: Dict[str, Any], instruction: str, ops: list, model: Dict[str, Any]) -> Dict[str, Any]:
    """One lightweight critic call checking instruction coverage. Never blocks on failure."""
    messages = build_selfcheck_messages(str(instruction or ""), snapshot, ops)
    try:
        raw = await _call_model(messages, model, 600, tools=[SELFCHECK_TOOL], tool_choice="required")
        parsed = parse_selfcheck_tool(raw["tool_calls"])
        if parsed is not None:
            return parsed
        return parse_selfcheck(raw["content"])
    except HarnessError:
        try:
            raw = await _call_model(messages, model, 600, json_mode=_supports_json_mode(model["provider"]))
            return parse_selfcheck(raw["content"])
        except HarnessError:
            return {"ok": True, "issues": [], "missing": [], "error": "自检调用失败，已跳过"}


async def review_graph(
    snapshot: Any,
    instruction: str,
    model: Optional[Dict[str, Any]] = None,
    max_tokens: int = 4000,
    retries: int = 1,
    phase: str = "normal",
    context: str = "",
    level: str = "",
    focus_node_ids=None,
    conversation_context: str = "",
    mode: str = "auto",
    self_check: str = "auto",
    history=None,
    previous_ops=None,
    previous_snapshot=None,
    all_previous_ops=None,
    initial_snapshot=None,
) -> Dict[str, Any]:
    """Review the snapshot and return validated graph operations.

    mode: "tools" (force function calling), "json" (force free-form JSON),
    or "auto" (try tools, fall back to JSON when the provider rejects them).
    """
    current = normalize_snapshot(snapshot)
    current = _compact_snapshot(current, focus_node_ids)
    instruction = str(instruction or "").strip() or "请审阅并优化这个知识网络"
    phase = _detect_phase(str(phase or "normal"), instruction, current, focus_node_ids)
    full_context = "\n\n".join([part for part in (context, conversation_context) if part])
    resolved_model = _resolve_model(model)
    provider = resolved_model["provider"]

    mode = str(mode or "auto").strip().lower()
    # ---- 确定性撤销：指令含撤销意图且有上一步操作时，不调用模型 ----
    undo_intent = _detect_undo_intent(instruction)
    text_lower = str(instruction or "").lower()
    scope = _undo_scope(instruction, focus_node_ids)
    use_full = scope in ("full", "targeted") and (all_previous_ops or [])
    prev_ops = list(all_previous_ops or []) if use_full else list(previous_ops or [])
    prev_before = initial_snapshot if use_full else previous_snapshot
    if undo_intent and prev_ops:
        current = normalize_snapshot(snapshot)
        inverse_ops = build_inverse_ops(prev_before or current, prev_ops, current)
        inverse_ops = _filter_inverse_by_targets(inverse_ops, focus_node_ids, current)
        if inverse_ops:
            undo_result = build_next_snapshot(current, inverse_ops)
            undo_result["summary"] = "已撤销上一步修改" + (
                "（仅撤销指定节点相关改动）" if focus_node_ids else ""
            )
            undo_result["status"] = "undo"
            undo_result["phase"] = "undo"
            undo_result["raw_has_ops"] = bool(inverse_ops)
            undo_result["undo_ops"] = inverse_ops
            return undo_result
    tools = build_tools(phase) if mode in ("auto", "tools") else None
    can_require = _supports_required_tool_choice(provider)
    if not tools:
        tool_choice = None
    elif phase in ("expand", "evaluate", "apply"):
        tool_choice = "required" if can_require else "auto"
    else:
        tool_choice = "required" if (_has_edit_intent(instruction) and can_require) else "auto"
    json_mode = _supports_json_mode(provider) if mode != "tools" else False
    self_check_mode = str(self_check or "auto").strip().lower()
    self_check_enabled = (
        self_check_mode == "on"
        or (self_check_mode == "auto" and phase in ("normal", "apply"))
    )

    last_raw = ""
    last_errors = []

    def messages_for_attempt(retry_errors: str = "") -> list:
        if phase == "evaluate":
            return build_evaluate_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        if phase == "apply":
            return build_apply_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        if phase == "expand":
            return build_expand_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        return build_review_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)

    for attempt in range(retries + 1):
        messages = messages_for_attempt(_summarize_errors(last_errors) if attempt > 0 else "")
        current_tools = list(tools) if tools else None
        current_choice = tool_choice if current_tools else None
        current_json = json_mode if not current_tools else False
        if current_tools:
            messages[-1]["content"] += (TOOLS_AUTO_HINT if tool_choice == "auto" else TOOLS_USER_HINT)
        history_text = _history_block(history)
        if history_text:
            messages[-1]["content"] += history_text

        try:
            raw = await _call_model(
                messages,
                resolved_model,
                max_tokens,
                tools=current_tools,
                tool_choice=current_choice,
                json_mode=current_json,
            )
        except HarnessError as exc:
            if current_tools and mode == "auto":
                if tool_choice == "required":
                    # 部分 provider（如 opencode 免费模型）不支持 required，先降级为 auto
                    logger.warning("tool_choice=required 失败，降级为 auto: %s", exc)
                    tool_choice = "auto"
                    raw = await _call_model(
                        messages,
                        resolved_model,
                        max_tokens,
                        tools=current_tools,
                        tool_choice="auto",
                    )
                else:
                    logger.warning("工具调用失败，降级为自由 JSON: %s", exc)
                    tools = None
                    tool_choice = None
                    messages[-1]["content"] = messages[-1]["content"].replace(TOOLS_USER_HINT, "").replace(TOOLS_AUTO_HINT, "")
                    raw = await _call_model(
                        messages,
                        resolved_model,
                        max_tokens,
                        json_mode=_supports_json_mode(provider),
                    )
            else:
                raise

        last_raw = raw["content"] or ""
        if raw.get("tool_calls"):
            raw_ops, tool_errors = parse_tool_calls(raw["tool_calls"])
            if tool_errors:
                last_errors = tool_errors
                logger.warning("tool_calls 解析失败: %s", tool_errors)
                continue
            summary = str(raw.get("content") or "").strip()
        else:
            payload = extract_json(last_raw)
            if payload is None and current_tools is not None:
                # 模型选择纯文字回答（未调用工具），视为对话，不强制图操作
                summary = last_raw.strip()
                raw_ops = []
            elif payload is None:
                last_errors = [{"index": "parse", "op": "json", "reason": "模型输出不是合法 JSON"}]
                logger.warning("模型输出不是合法 JSON: %s", last_raw[:300])
                continue
            elif isinstance(payload, list):
                # 模型直接输出了顶层操作数组
                raw_ops = payload
                summary = ""
            else:
                raw_ops = payload.get("operations") or payload.get("ops") or []
                if not isinstance(raw_ops, list):
                    last_errors = [{"index": "schema", "op": "operations", "reason": "operations 必须是数组"}]
                    continue
                summary = str(payload.get("summary") or "").strip()
                if isinstance(payload.get("clarify"), dict):
                    return {
                        "status": "clarify",
                        "summary": summary or "需要向你确认一下",
                        "clarify": payload["clarify"],
                        "operations": [],
                        "next_snapshot": current,
                        "diff": [],
                        "errors": [],
                        "warnings": [],
                        "raw_has_ops": False,
                    }

        # 归一化操作名与字段别名：action/operation/type -> op；node_id -> id
        normalized_ops = []
        for op in raw_ops:
            if not isinstance(op, dict):
                normalized_ops.append(op)
                continue
            op = dict(op)
            op["op"] = str(op.get("op") or op.get("action") or op.get("operation") or op.get("type") or "")
            if not op.get("id") and op.get("node_id"):
                op["id"] = op.get("node_id")
            normalized_ops.append(op)
        raw_ops = normalized_ops

        if phase == "evaluate":
            raw_ops = [
                op for op in raw_ops
                if isinstance(op, dict) and op.get("op") == "create_eval_node"
            ]
        elif phase in ("normal", "apply"):
            eval_ops = [
                op for op in raw_ops
                if isinstance(op, dict) and op.get("op") == "create_eval_node"
            ]
            if eval_ops:
                reason = "正常审阅不能创建 AI 评价节点，请改用“评价/建议”类指令" if phase == "normal" else "应用阶段不能创建 AI 评价节点，请根据已有评价节点执行真实修改"
                last_errors = [{
                    "index": "phase",
                    "op": "create_eval_node",
                    "reason": reason,
                }]
                continue

        if phase == "evaluate" and not raw_ops:
            if attempt < retries:
                last_errors = [{
                    "index": "evaluate",
                    "op": "create_eval_node",
                    "reason": "评价阶段必须生成 create_eval_node 操作，不要只返回文字或空操作",
                }]
                continue

        if phase == "normal" and not raw_ops and _has_edit_intent(instruction) and not _detect_undo_intent(instruction):
            if attempt < retries:
                last_errors = [{
                    "index": "normal",
                    "op": "operation",
                    "reason": "指令包含明确的修改意图（新增/删除/修改/补充等），请输出真实图操作，不要只返回文字",
                }]
                continue

        if phase == "apply" and not raw_ops:
            if attempt < retries:
                last_errors = [{
                    "index": "apply",
                    "op": "update_node",
                    "reason": "应用阶段必须根据 ai_eval 节点输出真实修改操作（update/delete/add_edge/remove_edge/update_edge），不要只返回文字",
                }]
                continue

        result = build_next_snapshot(current, raw_ops)
        ops_for_summary = result.get("operations") or []
        result["summary"] = summary or _fallback_summary(ops_for_summary) or ("本次未提出图修改建议" if not ops_for_summary else "")
        result["raw_has_ops"] = bool(raw_ops)
        if phase == "apply":
            result = _cleanup_remaining_eval_nodes(result, current)

        # ---- 语义自检：规则（零成本） ----
        result["self_check"] = {
            "rules": rule_selfcheck(current, instruction, focus_node_ids, raw_ops),
        }
        for issue in result["self_check"]["rules"].get("issues", []):
            result["warnings"].append({"index": "rules", "op": "selfcheck", "reason": issue})

        # ---- 语义自检：新建节点必须连线（软重试） ----
        isolated = find_isolated_created_nodes(current, result.get("operations") or [])
        if isolated:
            labels = "、".join(item.get("label") or item.get("id") for item in isolated)
            if attempt < retries:
                last_errors = [{
                    "index": "isolated",
                    "op": "create_node",
                    "reason": f"新节点未连接到已有节点：{labels}。请补充 add_edge（若用户明确要独立节点，请在 summary 中说明）",
                }]
                continue
            result["warnings"].append({
                "index": "isolated",
                "op": "create_node",
                "reason": f"新节点未连接到已有节点：{labels}",
            })

        # ---- 拓展阶段：每个目标知识点必须生成完整进阶链（软重试） ----
        if phase == "expand":
            missing_chains = find_missing_expansion_chains(current, result.get("operations") or [], focus_node_ids)
            if missing_chains:
                detail = "；".join(
                    f"节点 {item.get('id')}: {item.get('reason')}"
                    for item in missing_chains
                )
                if attempt < retries:
                    last_errors = [{
                        "index": "expand",
                        "op": "create_node",
                        "reason": "进阶链不完整：" + detail,
                    }]
                    continue
                result["warnings"].append({
                    "index": "expand",
                    "op": "create_node",
                    "reason": "进阶链不完整：" + detail,
                })

        # ---- 语义自检：模型批判（一次轻量调用，仅在首次尝试） ----
        if self_check_enabled and raw_ops and attempt == 0:
            critic = await _selfcheck_ops(current, instruction, raw_ops, resolved_model)
            result["self_check"]["critic"] = critic
            if not critic.get("ok", True) and attempt < retries:
                critic_errors = [
                    {"index": "selfcheck", "op": "critic", "reason": reason}
                    for reason in critic.get("issues", [])
                ] + [
                    {"index": "selfcheck", "op": "critic", "reason": "缺少：" + reason}
                    for reason in critic.get("missing", [])
                ]
                last_errors = critic_errors
                continue
            if not critic.get("ok", True):
                for reason in critic.get("issues", []):
                    result["warnings"].append({"index": "selfcheck", "op": "critic", "reason": reason})
                for reason in critic.get("missing", []):
                    result["warnings"].append({"index": "selfcheck", "op": "critic", "reason": "缺少：" + reason})

        if result["errors"] and attempt < retries:
            last_errors = result["errors"]
            continue
        if phase in ("normal", "expand"):
            result = _auto_connect_isolated(current, result, focus_node_ids, instruction)
        if phase == "expand":
            result = _complete_expand_chains(current, result, focus_node_ids)
        result["phase"] = phase
        return result

    return {
        "status": "parse_error",
        "summary": "",
        "operations": [],
        "next_snapshot": current,
        "diff": [],
        "errors": last_errors or [{"reason": "模型输出解析失败"}],
        "warnings": [],
        "raw_has_ops": bool(last_raw.strip()),
    }


async def resolve_focus(
    snapshot: Any,
    instruction: str,
    model: Optional[Dict[str, Any]] = None,
    max_tokens: int = 900,
    retries: int = 1,
    context: str = "",
    level: str = "",
    conversation_context: str = "",
    mode: str = "auto",
) -> Dict[str, Any]:
    current = normalize_snapshot(snapshot)
    node_ids = {node["id"] for node in current["nodes"]}
    full_context = "\n\n".join([part for part in (context, conversation_context) if part])
    resolved_model = _resolve_model(model)
    json_mode = _supports_json_mode(resolved_model["provider"])
    last_errors = []
    for attempt in range(retries + 1):
        messages = build_resolve_messages(
            current,
            str(instruction or ""),
            full_context,
            level,
            _summarize_errors(last_errors) if attempt else "",
        )
        raw = await _call_model(messages, resolved_model, max_tokens, json_mode=json_mode)
        payload = extract_json(raw["content"])
        if payload is None:
            last_errors = [{"index": "parse", "op": "resolve", "reason": "目标解析输出不是合法 JSON"}]
            continue
        focus_ids = [
            str(item) for item in (payload.get("focus_node_ids") or [])
            if str(item) in node_ids
        ]
        candidates = payload.get("candidates") or []
        normalized_candidates = []
        for item in candidates:
            if not isinstance(item, dict):
                continue
            candidate_id = str(item.get("id") or "")
            if candidate_id in node_ids:
                normalized_candidates.append({
                    "id": candidate_id,
                    "label": str(item.get("label") or candidate_id),
                    "hint": str(item.get("hint") or ""),
                })
        return {
            "status": "ok",
            "focus_node_ids": list(dict.fromkeys(focus_ids)),
            "ambiguous": bool(payload.get("ambiguous")),
            "question": str(payload.get("question") or "").strip(),
            "candidates": normalized_candidates,
        }
    return {
        "status": "error",
        "focus_node_ids": [],
        "ambiguous": False,
        "question": "",
        "candidates": [],
        "errors": last_errors,
    }


def _cleanup_remaining_eval_nodes(result: Dict[str, Any], original_snapshot: Dict[str, Any]) -> Dict[str, Any]:
    remaining = [
        node for node in result.get("next_snapshot", {}).get("nodes", [])
        if node.get("kind") == "ai_eval"
    ]
    if not remaining:
        return result
    cleanup_ops = [
        {"op": "delete_node", "id": node["id"], "reason": "应用建议后自动清理 AI 评价节点"}
        for node in remaining
    ]
    cleanup = build_next_snapshot(result.get("next_snapshot"), cleanup_ops)
    result["operations"] = list(result.get("operations") or []) + list(cleanup.get("operations") or [])
    result["next_snapshot"] = cleanup["next_snapshot"]
    result["diff"] = diff_snapshots(
        original_snapshot,
        cleanup["next_snapshot"],
    )
    if cleanup.get("errors"):
        result["errors"] = list(result.get("errors") or []) + cleanup["errors"]
    return result
