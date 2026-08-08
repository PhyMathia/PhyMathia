"""Model-backed review flow for the independent harness."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, Optional

import httpx

from .core import build_next_snapshot, diff_snapshots, normalize_snapshot
from .json_utils import extract_json
from .prompts import (
    build_apply_messages,
    build_evaluate_messages,
    build_resolve_messages,
    build_review_messages,
)


DEFAULT_PROVIDER_URLS = {
    "deepseek": "https://api.deepseek.com",
    "openai": "https://api.openai.com/v1",
}

EVALUATE_HINTS = ("评价", "建议", "反馈", "点评", "指出", "哪里需要改进", "如何完善", "帮我完善", "改进")
APPLY_HINTS = ("应用建议", "采纳建议", "按建议", "执行建议")


class HarnessError(RuntimeError):
    pass


def _detect_phase(phase: str, instruction: str, snapshot: dict) -> str:
    """Choose the intended harness phase from explicit phase or instruction hints."""
    text = str(instruction or "")
    has_eval = any(hint in text for hint in EVALUATE_HINTS)
    has_apply = any(hint in text for hint in APPLY_HINTS)
    has_eval_nodes = any(node.get("kind") == "ai_eval" for node in snapshot.get("nodes", []))
    if phase == "apply" or (phase in ("", "auto", "normal") and has_apply and has_eval_nodes):
        return "apply"
    if phase == "evaluate" or (phase in ("", "auto", "normal") and has_eval):
        return "evaluate"
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


async def _call_model(messages: list, model: Dict[str, Any], max_tokens: int) -> str:
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
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise HarnessError("模型响应缺少有效内容") from exc


def _summarize_errors(errors) -> str:
    lines = []
    for item in errors or []:
        op = item.get("op") or "?"
        reason = item.get("reason") or "?"
        lines.append(f"- operation {item.get('index', '?')} ({op}): {reason}")
    return "\n".join(lines)


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
) -> Dict[str, Any]:
    current = normalize_snapshot(snapshot)
    instruction = str(instruction or "").strip() or "请审阅并优化这个知识网络"
    phase = _detect_phase(str(phase or "normal"), instruction, current)
    full_context = "\n\n".join([part for part in (context, conversation_context) if part])
    resolved_model = _resolve_model(model)
    last_raw = ""
    last_errors = []

    def messages_for_attempt(retry_errors: str = "") -> list:
        if phase == "evaluate":
            return build_evaluate_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        if phase == "apply":
            return build_apply_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        return build_review_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)

    for attempt in range(retries + 1):
        messages = messages_for_attempt(_summarize_errors(last_errors) if attempt > 0 else "")
        raw = await _call_model(messages, resolved_model, max_tokens)
        last_raw = raw
        payload = extract_json(raw)
        if payload is None:
            last_errors = [{"index": "parse", "op": "json", "reason": "模型输出不是合法 JSON"}]
            continue
        raw_ops = payload.get("operations") or payload.get("ops") or []
        if not isinstance(raw_ops, list):
            last_errors = [{"index": "schema", "op": "operations", "reason": "operations 必须是数组"}]
            continue
        if phase == "evaluate":
            raw_ops = [
                op for op in raw_ops
                if isinstance(op, dict) and op.get("op") == "create_eval_node"
            ]
        result = build_next_snapshot(current, raw_ops)
        result["summary"] = str(payload.get("summary") or "").strip()
        result["raw_has_ops"] = bool(raw_ops)
        if phase == "apply":
            result = _cleanup_remaining_eval_nodes(result, current)
        if result["errors"] and attempt < retries:
            last_errors = result["errors"]
            continue
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
) -> Dict[str, Any]:
    current = normalize_snapshot(snapshot)
    node_ids = {node["id"] for node in current["nodes"]}
    full_context = "\n\n".join([part for part in (context, conversation_context) if part])
    resolved_model = _resolve_model(model)
    last_errors = []
    for attempt in range(retries + 1):
        messages = build_resolve_messages(
            current,
            str(instruction or ""),
            full_context,
            level,
            _summarize_errors(last_errors) if attempt else "",
        )
        raw = await _call_model(messages, resolved_model, max_tokens)
        payload = extract_json(raw)
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
