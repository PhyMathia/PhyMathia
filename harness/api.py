"""FastAPI router for the independent harness."""

from __future__ import annotations

from fastapi import APIRouter, Request

from .core import build_next_snapshot, normalize_snapshot
from .review import HarnessError, resolve_focus, review_graph


router = APIRouter()


@router.get("/health")
async def health():
    return {"status": "ok", "service": "graph-harness"}


@router.post("/graph/review")
async def graph_review(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}

    try:
        context = payload.get("context") or getattr(request.app.state, "harness_context", "") or ""
        level = str(payload.get("level") or "")
        focus_node_ids = payload.get("focus_node_ids") or []
        conversation_context = str(payload.get("conversation_context") or "")
        retries = int(payload.get("retries") or 2)
        mode = str(payload.get("mode") or "auto")
        self_check = str(payload.get("self_check") or "auto")
        result = await review_graph(
            snapshot=payload.get("snapshot"),
            instruction=payload.get("instruction", ""),
            model=payload.get("model"),
            max_tokens=int(payload.get("max_tokens") or 4000),
            phase=str(payload.get("phase") or "normal"),
            context=context,
            level=level,
            focus_node_ids=focus_node_ids,
            conversation_context=conversation_context,
            retries=retries,
            mode=mode,
            self_check=self_check,
        )
        result["snapshot_node_count"] = len(normalize_snapshot(payload.get("snapshot"))["nodes"])
        return result
    except HarnessError as exc:
        return {"status": "error", "errors": [{"reason": str(exc)}]}
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"harness 内部错误: {exc}"}]}


@router.post("/graph/apply")
async def graph_apply(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}
    return build_next_snapshot(payload.get("snapshot"), payload.get("operations") or [])


@router.post("/graph/resolve")
async def graph_resolve(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}
    try:
        context = payload.get("context") or getattr(request.app.state, "harness_context", "") or ""
        level = str(payload.get("level") or "")
        conversation_context = str(payload.get("conversation_context") or "")
        retries = int(payload.get("retries") or 2)
        mode = str(payload.get("mode") or "auto")
        result = await resolve_focus(
            snapshot=payload.get("snapshot"),
            instruction=payload.get("instruction", ""),
            model=payload.get("model"),
            max_tokens=int(payload.get("max_tokens") or 900),
            context=context,
            level=level,
            conversation_context=conversation_context,
            retries=retries,
            mode=mode,
        )
        return result
    except HarnessError as exc:
        return {"status": "error", "errors": [{"reason": str(exc)}]}
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"目标解析失败: {exc}"}]}
