"""FastAPI router for the independent harness."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .core import build_next_snapshot, normalize_snapshot
from .events import append_event, new_event_id, read_events, valid_session_id
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
        # T96：会话与事件关联——挖矿脚本可把用量行 join 到事件日志的完整往返
        "session_id": _payload_session(payload),
        "event_id": str(result.get("event_id") or ""),
    }


def _payload_session(payload: dict) -> str:
    """请求所属 Φ 会话 id（前端主路径 2026-09-30 起随 payload 上送）。

    空串＝匿名/旧客户端：usage 照记，但不落会话事件文件（见 _log_review_event）。
    """
    return str(payload.get("session_id") or payload.get("phi_session_id") or "").strip()[:80]


def _log_review_event(payload: dict, result: dict, t0: float, endpoint: str, journal: list) -> str:
    """T96 会话事件日志：一次 review/resolve 请求记一条完整往返。

    无论会话 id 是否合法都先给 result 挂 event_id（前端反馈要用它归因）；
    会话 id 合法才落盘 logs/harness_events/<sid>.jsonl。落盘 best-effort，
    失败不影响业务响应。
    """
    evt_id = new_event_id()
    result["event_id"] = evt_id
    session_id = _payload_session(payload)
    if not valid_session_id(session_id):
        return evt_id
    try:
        snap = payload.get("snapshot") or {}
        nodes = len(snap.get("nodes") or [])
        edges = len(snap.get("edges") or [])
    except Exception:
        nodes = edges = 0
    model_info = payload.get("model") if isinstance(payload.get("model"), dict) else {}
    errors = result.get("errors") or []
    append_event(session_id, {
        "id": evt_id,
        "type": "review",
        "endpoint": endpoint,
        "session_id": session_id,
        "phase": str(result.get("phase") or payload.get("phase") or ""),
        "status": str(result.get("status") or ""),
        "model": {k: model_info.get(k) for k in ("provider", "model", "base_url")},
        "instruction": str(payload.get("instruction") or "")[:4000],
        "level": str(payload.get("level") or ""),
        "focus_node_ids": list(payload.get("focus_node_ids") or [])[:40],
        "stream": bool(payload.get("stream")),
        "snapshot_meta": {
            "nodes": nodes,
            "edges": edges,
            "est_tokens": int((result.get("context_metrics") or {}).get("est_tokens") or 0),
        },
        "history_count": len(payload.get("harness_history") or payload.get("history") or []),
        "summary": str(result.get("summary") or "")[:1000],
        "operations": result.get("operations") or [],
        "errors": errors[:20],
        "warnings_count": len(result.get("warnings") or []),
        "model_calls": int(result.get("model_calls") or 0),
        "latency_ms": round((time.time() - t0) * 1000),
        "roundtrips": journal or [],
    })
    return evt_id


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


def _review_kwargs(payload: dict, context: str, journal: Optional[list] = None) -> dict:
    """review_graph 的入参装配：流式与非流式两条路径共用，避免漂移。

    journal（T96）由调用方创建并传入，review_graph 把模型往返填进去，
    请求结束后随事件日志落盘。缺省 None＝不捕获（直调/旧测试路径）。"""
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
        "journal": journal if journal is not None else [],
    }


async def _review_event_stream(payload: dict, kwargs: dict, journal: list):
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
            _log_review_event(payload, result, t0, "review", journal)
            _log_usage(_usage_entry(payload, result, t0, "review"))
            queue.put_nowait({"type": "result", "data": result})
        except HarnessError as exc:
            err = {"status": "error", "errors": [{"reason": str(exc)}]}
            _log_review_event(payload, err, t0, "review", journal)
            _log_usage(_usage_entry(payload, err, t0, "review"))
            queue.put_nowait({"type": "result", "data": err})
        except Exception as exc:
            logger.exception("harness internal error (review stream)")
            err = {"status": "error", "errors": [{"reason": f"harness 内部错误: {exc}"}]}
            _log_review_event(payload, err, t0, "review", journal)
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
            _log_review_event(payload, empty_hint, t0, "review", [])
            _log_usage(_usage_entry(payload, empty_hint, t0, "review"))
            return empty_hint
        journal: list = []
        kwargs = _review_kwargs(payload, context, journal)
        if payload.get("stream"):
            # 流式通道（前端显式传 stream:true 启用）：SSE 下发进度与最终结果。
            # 旧非流式协议原样保留，battery 与既有客户端零影响。
            return StreamingResponse(
                _review_event_stream(payload, kwargs, journal),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
            )
        result = await review_graph(**kwargs)
        result["snapshot_node_count"] = len(normalize_snapshot(payload.get("snapshot"))["nodes"])
        _log_review_event(payload, result, t0, "review", journal)
        _log_usage(_usage_entry(payload, result, t0, "review"))
        return result
    except HarnessError as exc:
        err = {"status": "error", "errors": [{"reason": str(exc)}]}
        _log_review_event(payload, err, t0, "review", [])
        _log_usage(_usage_entry(payload, err, t0, "review"))
        return JSONResponse(status_code=502, content=err)
    except Exception as exc:
        logger.exception("harness internal error (review)")
        err = {"status": "error", "errors": [{"reason": f"harness 内部错误: {exc}"}]}
        _log_review_event(payload, err, t0, "review", [])
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


@router.post("/graph/apply_report")
async def graph_apply_report(request: Request):
    """前端应用一批 Φ 建议后的上报（T96 会话事件日志）。

    记录本批实际应用的操作与无损前态（before_snapshot＝应用前的完整画布深拷
    贝），是撤销时间线「撤回到任意批次之前」的恢复数据源，也是事后重放「当时
    图上是什么」的依据。best-effort：失败只影响日志，不影响前端应用结果。"""
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
    session_id = _payload_session(payload)
    if not valid_session_id(session_id):
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": "缺少有效的 Φ 会话 id（session_id），无法记录应用事件"}]})
    ops = payload.get("applied_ops") if isinstance(payload.get("applied_ops"), list) else payload.get("operations")
    if not isinstance(ops, list):
        ops = []
    event = {
        "id": new_event_id(),
        "type": "applied",
        "session_id": session_id,
        # 关联到产出这批建议的 review 事件（反馈归因链条的一环）
        "event_id": str(payload.get("event_id") or "")[:48],
        "mode": str(payload.get("mode") or "all")[:16],
        "summary": str(payload.get("summary") or "")[:500],
        "ops_count": len(ops),
        "applied_ops": ops,
    }
    before = payload.get("before_snapshot")
    if isinstance(before, dict):
        event["before_snapshot"] = before
    append_event(session_id, event)
    return {"status": "ok", "event_id": event["id"]}


@router.post("/graph/undo_report")
async def graph_undo_report(request: Request):
    """撤销上报（T96）：undone_from_seq＝被回滚的第一条 applied 事件的 seq。

    时间线渲染按序折叠：某条 undo 事件把 seq >= undone_from_seq 且早于它自己的
    applied 批次全部视为已撤销；之后新应用的批次 seq 更大，自然回到有效集。"""
    try:
        payload = await request.json()
    except Exception as exc:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": f"请求不是合法 JSON: {exc}"}]})
    session_id = _payload_session(payload)
    if not valid_session_id(session_id):
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": "缺少有效的 Φ 会话 id（session_id），无法记录撤销事件"}]})
    try:
        undone_from = int(payload.get("undone_from_seq") or 0)
    except (TypeError, ValueError):
        undone_from = 0
    if undone_from <= 0:
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": "缺少有效的 undone_from_seq（被回滚批次的 seq）"}]})
    event = {
        "id": new_event_id(),
        "type": "undo",
        "session_id": session_id,
        "undone_from_seq": undone_from,
        "note": str(payload.get("note") or "")[:200],
    }
    append_event(session_id, event)
    return {"status": "ok", "event_id": event["id"]}


@router.get("/graph/events")
async def graph_events(request: Request):
    """读 Φ 会话事件（T96）：撤销时间线与排障重放的数据源。

    查询参数：session_id 必填；types=applied,undo 按 type 过滤；event_id 精确取
    一条（隐含含 before_snapshot——回滚取快照走这条）；limit 取最近 N 条（默认
    100）；include_snapshot=1 才在列表里带 before_snapshot（默认剥掉，列表只要
    元信息）。seq＝文件行号，单调且稳定。"""
    session_id = str(request.query_params.get("session_id") or "").strip()
    if not valid_session_id(session_id):
        return JSONResponse(status_code=400, content={"status": "error", "errors": [{"reason": "缺少有效的 Φ 会话 id（session_id）"}]})
    types = [t.strip() for t in str(request.query_params.get("types") or "").split(",") if t.strip()]
    event_id = str(request.query_params.get("event_id") or "").strip()
    try:
        limit = max(1, min(int(request.query_params.get("limit") or 100), 500))
    except (TypeError, ValueError):
        limit = 100
    include_snapshot = str(request.query_params.get("include_snapshot") or "").lower() in ("1", "true", "yes")
    events = read_events(
        session_id,
        types=types or None,
        event_id=event_id or None,
        limit=limit,
        include_snapshot=include_snapshot or bool(event_id),
    )
    return {"status": "ok", "session_id": session_id, "events": events}


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
        _log_review_event(payload, result, t0, "resolve", [])
        _log_usage(_usage_entry(payload, result, t0, "resolve"))
        return result
    except HarnessError as exc:
        err = {"status": "error", "errors": [{"reason": str(exc)}]}
        _log_review_event(payload, err, t0, "resolve", [])
        _log_usage(_usage_entry(payload, err, t0, "resolve"))
        return JSONResponse(status_code=502, content=err)
    except Exception as exc:
        logger.exception("harness internal error (resolve)")
        err = {"status": "error", "errors": [{"reason": f"目标解析失败: {exc}"}]}
        _log_review_event(payload, err, t0, "resolve", [])
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
            # T96 反馈归因：挂上事件 id 与 Φ 会话 id，挖矿/排障时可 join 事件日志
            # 拿到模型名、提示词与操作明细（不再是孤儿数据）
            "event_id": str(payload.get("event_id") or "")[:48],
            "phi_session_id": str(payload.get("phi_session_id") or "")[:80],
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
        # 同步在 Φ 会话事件日志里落一条 feedback 事件（关联 review 事件 id），
        # 会话文件里就能看到「请求→应用→反馈」的完整链条
        phi_sid = str(payload.get("phi_session_id") or "")[:80]
        if valid_session_id(phi_sid):
            append_event(phi_sid, {
                "id": new_event_id(),
                "type": "feedback",
                "session_id": phi_sid,
                "event_id": str(payload.get("event_id") or "")[:48],
                "kind": entry["kind"],
                "note": entry["note"],
            })
        return {"status": "ok", "count": len(items)}
    except Exception as exc:
        return JSONResponse(status_code=500, content={"status": "error", "errors": [{"reason": str(exc)}]})