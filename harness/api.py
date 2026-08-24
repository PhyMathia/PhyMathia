"""FastAPI router for the independent harness."""

from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Request

from .core import build_next_snapshot, normalize_snapshot
from .review import HarnessError, resolve_focus, review_graph


router = APIRouter()


# ===== 阶段 0：真实使用日志与反馈收集 =====
_LOG_DIR = Path(__file__).resolve().parent.parent / "logs"
_USAGE_LOG = _LOG_DIR / "harness_usage.jsonl"


def _log_usage(entry: dict) -> None:
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        with open(_USAGE_LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def _usage_entry(payload: dict, result: dict, t0: float, endpoint: str) -> dict:
    try:
        snap = payload.get("snapshot") or {}
        nodes = len(snap.get("nodes") or [])
        edges = len(snap.get("edges") or [])
    except Exception:
        nodes = edges = 0
    errors = result.get("errors") or []
    first_error = str(errors[0].get("reason") or "")[:200] if errors else ""
    return {
        "ts": round(time.time(), 3),
        "endpoint": endpoint,
        "phase": str(result.get("phase") or payload.get("phase") or ""),
        "status": str(result.get("status") or ""),
        "instruction": str(payload.get("instruction") or "")[:200],
        "model": str((payload.get("model") or {}).get("model") or ""),
        "nodes": nodes,
        "edges": edges,
        "focus_count": len(payload.get("focus_node_ids") or []),
        "ops_count": len(result.get("operations") or []),
        "warnings_count": len(result.get("warnings") or []),
        "error": first_error,
        "latency_ms": round((time.time() - t0) * 1000),
        "model_calls": int(result.get("model_calls") or 0),
        "est_tokens": int((result.get("context_metrics") or {}).get("est_tokens") or 0),
    }


@router.get("/health")
async def health():
    return {"status": "ok", "service": "graph-harness"}


@router.post("/graph/review")
async def graph_review(request: Request):
    t0 = time.time()
    payload = {}
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
        snap_nodes = len((payload.get("snapshot") or {}).get("nodes") or [])
        if snap_nodes == 0 and not payload.get("pure_chat"):
            # 空快照防御：模型无法评价/修改不存在的图。纯问答聊天仍放行，
            # 其余情况直接返回结构化提示，省一次注定无效的模型调用。
            empty_hint = {
                "status": "no_ops",
                "summary": "我没有收到画布内容（快照为空），所以没法评价或修改。请确认：① 画布上确实有节点且当前会话正确；② 若此前用过「撤销/不保留」，点 Φ 面板右上角「↺」恢复被标记删除的节点后重试。",
                "operations": [],
                "next_snapshot": {"version": 1, "nodes": [], "edges": []},
                "diff": [],
                "errors": [],
                "warnings": [{"index": "snapshot", "op": "empty", "reason": "empty snapshot"}],
                "raw_has_ops": False,
                "model_calls": 0,
            }
            _log_usage(_usage_entry(payload, empty_hint, t0, "review"))
            return empty_hint
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
        _log_usage(_usage_entry(payload, result, t0, "review"))
        return result
    except HarnessError as exc:
        err = {"status": "error", "errors": [{"reason": str(exc)}]}
        _log_usage(_usage_entry(payload, err, t0, "review"))
        return err
    except Exception as exc:
        err = {"status": "error", "errors": [{"reason": f"harness 内部错误: {exc}"}]}
        _log_usage(_usage_entry(payload, err, t0, "review"))
        return err


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
    t0 = time.time()
    payload = {}
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
        _log_usage(_usage_entry(payload, result, t0, "resolve"))
        return result
    except HarnessError as exc:
        err = {"status": "error", "errors": [{"reason": str(exc)}]}
        _log_usage(_usage_entry(payload, err, t0, "resolve"))
        return err
    except Exception as exc:
        err = {"status": "error", "errors": [{"reason": f"目标解析失败: {exc}"}]}
        _log_usage(_usage_entry(payload, err, t0, "resolve"))
        return err

@router.post("/graph/feedback")
async def graph_feedback(request: Request):
    """收集用户对 harness 回答的反馈（阶段 0）：存到 data/harness_feedback.json。"""
    try:
        payload = await request.json()
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]}
    try:
        from src.server.config import DATA_DIR
        entry = {
            "ts": round(time.time(), 3),
            "kind": str(payload.get("kind") or "bad")[:10],
            "instruction": str(payload.get("instruction") or "")[:500],
            "summary": str(payload.get("summary") or "")[:1000],
            "ops_count": int(payload.get("ops_count") or 0),
            "phase": str(payload.get("phase") or "")[:20],
            "note": str(payload.get("note") or "")[:500],
            "session_id": str(payload.get("session_id") or "")[:100],
        }
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        path = DATA_DIR / "harness_feedback.json"
        items = []
        if path.exists():
            try:
                items = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                items = []
        if not isinstance(items, list):
            items = []
        items.append(entry)
        items = items[-2000:]
        path.write_text(json.dumps(items, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"status": "ok", "count": len(items)}
    except Exception as exc:
        return {"status": "error", "errors": [{"reason": str(exc)}]}