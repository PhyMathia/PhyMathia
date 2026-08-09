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
            retries=retries,
            mode=mode,
            self_check=self_check,
            history=payload.get("harness_history") or payload.get("history"),
            previous_ops=payload.get("previous_ops") or payload.get("last_ops"),
            previous_snapshot=payload.get("previous_snapshot") or payload.get("before_snapshot"),
            all_previous_ops=payload.get("all_previous_ops"),
            initial_snapshot=payload.get("initial_snapshot"),
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




@router.post("/graph/undo")
async def graph_undo(request: Request):
    """Deterministic undo: compute inverse ops from a before-snapshot + the ops
    that were applied, then apply them to the current (after) snapshot."""
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}
    try:
        from .core import build_inverse_ops, build_next_snapshot, normalize_snapshot

        current = normalize_snapshot(payload.get("snapshot") or payload.get("after_snapshot"))
        inverse_ops = build_inverse_ops(payload.get("before_snapshot") or current, payload.get("operations") or [], current)
        result = build_next_snapshot(current, inverse_ops)
        result["status"] = "undo"
        result["phase"] = "undo"
        result["summary"] = "已撤销上一步修改"
        result["undo_ops"] = inverse_ops
        return result
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"撤销失败: {exc}"}]}


@router.post("/graph/health")
async def graph_health(request: Request):
    """Structural health check for a snapshot: broken edges, orphan nodes,
    duplicate knowledge labels / modules. Uses the raw snapshot so broken
    edges are reported instead of silently dropped."""
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}
    try:
        from .selfcheck import check_snapshot_consistency

        result = check_snapshot_consistency(payload.get("snapshot"))
        result["status"] = "ok"
        return result
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"体检失败: {exc}"}]}


@router.post("/graph/resolve")
async def graph_resolve(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}
    try:
        context = payload.get("context") or getattr(request.app.state, "harness_context", "") or ""
        level = str(payload.get("level") or "")
        retries = int(payload.get("retries") or 2)
        mode = str(payload.get("mode") or "auto")
        result = await resolve_focus(
            snapshot=payload.get("snapshot"),
            instruction=payload.get("instruction", ""),
            model=payload.get("model"),
            max_tokens=int(payload.get("max_tokens") or 900),
            context=context,
            level=level,
            retries=retries,
            mode=mode,
        )
        return result
    except HarnessError as exc:
        return {"status": "error", "errors": [{"reason": str(exc)}]}
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"目标解析失败: {exc}"}]}
