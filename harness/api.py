"""FastAPI router for the independent harness."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .core import build_next_snapshot, normalize_snapshot
from .review import HarnessError, resolve_focus, review_graph

logger = logging.getLogger(__name__)


router = APIRouter()

# 错误协议（2026-09-20 起）：业务结果（ok/undo/clarify/no_ops/parse_error/
# invalid）一律 HTTP 200 + 结构化 body，battery 与前端按 body.status 打分/分流；
# 传输层故障才用真实状态码——坏 JSON 400、请求前提缺失/撤销与解析失败 400、
# 模型侧失败(HarnessError) 502、本地内部异常 500。body 形状一字不变，只看
# body 的旧客户端零影响。SSE 流一旦开始，错误只能作为 result 事件带内下发。


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
        # 推理模型观测：输出长度与思考剥离事件（deepseek-v4-flash 等排障用）
        "out_chars": int(result.get("out_chars") or 0),
        "think_stripped": bool(result.get("reasoning_stripped")),
    }


@router.get("/health")
async def health():
    return {"status": "ok", "service": "graph-harness"}


def _profile_digest_for(payload: dict) -> str:
    """Φ 的画像一行摘要（记忆第二步「用起来」）：与 profile_context 同一份画像数据。

    digest 由服务端计算（与回答角标同一教训：前端缓存会漂移，服务端是唯一
    事实源）。server 包不可用（battery 测试桩/独立部署）或画像关闭/为空时
    静默降级为空串——Φ 无画像可提，行为与从前逐字节一致。
    """
    device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if not device_id:
        return ""
    try:
        from server import profile as server_profile
        return str(server_profile.profile_review_digest(device_id) or "")
    except Exception:
        logger.exception("harness profile digest failed")
        return ""


def _review_kwargs(payload: dict, context: str) -> dict:
    """review_graph 的入参装配：流式与非流式两条路径共用，避免漂移。"""
    snapshot = payload.get("snapshot")
    # 画像摘要随快照注入（quiz_weak 同款通道）：服务端注入后端自己的拷贝，
    # 不改 payload 原对象——usage 日志与 undo 前态快照保持请求原样。
    digest = _profile_digest_for(payload)
    if digest and isinstance(snapshot, dict):
        snapshot = dict(snapshot)
        snapshot["user_profile"] = digest
    return {
        "snapshot": snapshot,
        "instruction": payload.get("instruction", ""),
        "model": payload.get("model"),
        "max_tokens": int(payload.get("max_tokens") or 4000),
        "phase": str(payload.get("phase") or "normal"),
        "context": context,
        "level": str(payload.get("level") or ""),
        "focus_node_ids": payload.get("focus_node_ids") or [],
        "retries": int(payload.get("retries") or 2),
        "mode": str(payload.get("mode") or "auto"),
        "self_check": str(payload.get("self_check") or "auto"),
        "history": payload.get("harness_history") or payload.get("history"),
        "previous_ops": payload.get("previous_ops") or payload.get("last_ops"),
        "previous_snapshot": payload.get("previous_snapshot") or payload.get("before_snapshot"),
        "all_previous_ops": payload.get("all_previous_ops"),
        "initial_snapshot": payload.get("initial_snapshot"),
    }


async def _review_event_stream(payload: dict, kwargs: dict):
    """SSE 流式评审：stage/delta 事件边跑边发，最终以 result 事件下发与
    非流式完全一致的结果 JSON。断连时取消后台任务，避免模型调用继续空烧。"""
    t0 = time.time()
    queue: asyncio.Queue = asyncio.Queue()

    def progress(event: dict) -> None:
        queue.put_nowait(event)

    async def _run():
        try:
            result = await review_graph(progress=progress, **kwargs)
            result["snapshot_node_count"] = len(normalize_snapshot(payload.get("snapshot"))["nodes"])
            _log_usage(_usage_entry(payload, result, t0, "review"))
            queue.put_nowait({"type": "result", "data": result})
        except HarnessError as exc:
            err = {"status": "error", "errors": [{"reason": str(exc)}]}
            _log_usage(_usage_entry(payload, err, t0, "review"))
            queue.put_nowait({"type": "result", "data": err})
        except Exception as exc:
            logger.exception("harness internal error (review stream)")
            err = {"status": "error", "errors": [{"reason": f"harness 内部错误: {exc}"}]}
            _log_usage(_usage_entry(payload, err, t0, "review"))
            queue.put_nowait({"type": "result", "data": err})
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(_run())
    try:
        while True:
            item = await queue.get()
            if item is None:
                break
            yield "data: " + json.dumps(item, ensure_ascii=False) + "\n\n"
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass


@router.post("/graph/review")
async def graph_review(request: Request):
    t0 = time.time()
    payload = {}
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})

    try:
        context = payload.get("context") or getattr(request.app.state, "harness_context", "") or ""
        snap_nodes = len((payload.get("snapshot") or {}).get("nodes") or [])
        if snap_nodes == 0 and not payload.get("pure_chat") and payload.get("phase") not in ("preset", "chat"):
            # 空快照防御：模型无法评价/修改不存在的图。纯问答聊天仍放行，
            # 创造模式（preset）也放行——从空画布从零创作正是它的本职；
            # 答疑模式（chat）放行——问问题不需要图上有内容。
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
        kwargs = _review_kwargs(payload, context)
        if payload.get("stream"):
            # 流式通道（前端显式传 stream:true 启用）：SSE 下发进度与最终结果。
            # 旧非流式协议原样保留，battery 与既有客户端零影响。
            return StreamingResponse(
                _review_event_stream(payload, kwargs),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        result = await review_graph(**kwargs)
        result["snapshot_node_count"] = len(normalize_snapshot(payload.get("snapshot"))["nodes"])
        _log_usage(_usage_entry(payload, result, t0, "review"))
        return result
    except HarnessError as exc:
        err = {"status": "error", "errors": [{"reason": str(exc)}]}
        _log_usage(_usage_entry(payload, err, t0, "review"))
        return JSONResponse(status_code=502, content=err)
    except Exception as exc:
        logger.exception("harness internal error (review)")
        err = {"status": "error", "errors": [{"reason": f"harness 内部错误: {exc}"}]}
        _log_usage(_usage_entry(payload, err, t0, "review"))
        return JSONResponse(status_code=500, content=err)


@router.post("/graph/apply")
async def graph_apply(request: Request):
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
    return build_next_snapshot(payload.get("snapshot"), payload.get("operations") or [])




@router.post("/graph/undo")
async def graph_undo(request: Request):
    """Deterministic undo: compute inverse ops from a before-snapshot + the ops
    that were applied, then apply them to the current (after) snapshot."""
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
    try:
        from .core import build_inverse_ops, build_next_snapshot, normalize_snapshot

        current = normalize_snapshot(payload.get("snapshot") or payload.get("after_snapshot"))
        before = payload.get("before_snapshot")
        if not isinstance(before, dict):
            # 缺无损前态时不能用当前态兜底冒充前态——恢复出的就是现状，图零变化
            # 却报「已撤销成功」（与 review_graph 内部口径一致：明确拒绝）
            return JSONResponse(status_code=400, content={
                "status": "error",
                "errors": [{"reason": "缺少撤销前态（before_snapshot），无法安全恢复；请使用画布的「撤销本次」按钮回退"}],
            })
        inverse_ops = build_inverse_ops(before, payload.get("operations") or [], current)
        result = build_next_snapshot(current, inverse_ops)
        result["status"] = "undo"
        result["phase"] = "undo"
        result["summary"] = "已撤销上一步修改"
        result["undo_ops"] = inverse_ops
        return result
    except Exception as exc:
        logger.exception("harness /graph/undo failed")
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"撤销失败: {exc}"}]})


@router.post("/graph/health")
async def graph_health(request: Request):
    """Structural health check for a snapshot: broken edges, orphan nodes,
    duplicate knowledge labels / modules. Uses the raw snapshot so broken
    edges are reported instead of silently dropped."""
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
    try:
        from .selfcheck import check_snapshot_consistency

        result = check_snapshot_consistency(payload.get("snapshot"))
        result["status"] = "ok"
        return result
    except Exception as exc:
        return JSONResponse(status_code=500, content={"status": "error", "errors": [{"reason": f"体检失败: {exc}"}]})


@router.post("/graph/resolve")
async def graph_resolve(request: Request):
    t0 = time.time()
    payload = {}
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
    try:
        context = payload.get("context") or getattr(request.app.state, "harness_context", "") or ""
        level = str(payload.get("level") or "")
        retries = int(payload.get("retries") or 2)
        result = await resolve_focus(
            snapshot=payload.get("snapshot"),
            instruction=payload.get("instruction", ""),
            model=payload.get("model"),
            max_tokens=int(payload.get("max_tokens") or 900),
            context=context,
            level=level,
            retries=retries,
        )
        _log_usage(_usage_entry(payload, result, t0, "resolve"))
        return result
    except HarnessError as exc:
        err = {"status": "error", "errors": [{"reason": str(exc)}]}
        _log_usage(_usage_entry(payload, err, t0, "resolve"))
        return JSONResponse(status_code=502, content=err)
    except Exception as exc:
        logger.exception("harness internal error (resolve)")
        err = {"status": "error", "errors": [{"reason": f"目标解析失败: {exc}"}]}
        _log_usage(_usage_entry(payload, err, t0, "resolve"))
        return JSONResponse(status_code=400, content=err)

@router.post("/graph/feedback")
async def graph_feedback(request: Request):
    """收集用户对 harness 回答的反馈（阶段 0）：存到 data/harness_feedback.json。"""
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
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
        return JSONResponse(status_code=500, content={"status": "error", "errors": [{"reason": str(exc)}]})