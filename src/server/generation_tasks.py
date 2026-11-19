# ===== 生成任务注册表：服务端持任务＋重接流（484 生成断点续跑，2026-11-19）=====
# 拍板口径（用户 2026-11-19）：生成转服务端后台继续跑完，刷新页面凭 task id 无缝
# 重接流；约 GRACE_CANCEL_SECONDS 无人订阅自动掐上游省 token，帧缓冲保留供迟到
# 重放/结算。与 2026-11-17「不偷偷跑完让你以为在看」不冲突：回来时画布如实显示
# 「后台续跑中」，不是假装在看。
#
# 职责边界：本模块只管「任务的持有、订阅、探活、取消、回收」；上游怎么调、帧怎么
# 记账（usage/苏格拉底状态/wf 统计）全在 models_routes 的 reader 里——本模块不反向
# import models_routes（避免循环），也不认得 OpenAI 帧的语义，缓冲里存的就是逐字
# 原样 SSE 行（透传口径与旧路径一致，前端 _sseContentFrames 的解析零改动）。
import asyncio
import json
import logging
import os
import re
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from server.request_ctx import _account_id

logger = logging.getLogger("phymathia.generations")

router = APIRouter()

# 前端 crypto.randomUUID() 的形状（hex＋连字符）。消毒失败的 id 不入册——那类请求
# 自动退回旧透传路径，行为与 484 之前逐字节一致。
_GEN_TASK_ID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE)

# 宽限自动停（拍板：约 10 分钟没人回来就停）。env 覆盖给真机回归档用
# （verify_generation_resume.mjs 设秒级），生产默认 600。
GRACE_CANCEL_SECONDS = float(os.environ.get("PHYMATHIA_GEN_GRACE_SECONDS", "600"))
# 清扫循环间隔：宽限的判定与 TTL 回收都靠它兜底触发，env 只给真机档调快用
_SWEEP_INTERVAL_SECONDS = float(os.environ.get("PHYMATHIA_GEN_SWEEP_SECONDS", "15"))

# 任务回收：已完成的留 60 分钟（迟到取件），已停/出错的留 30 分钟（够一次
# 「回来发现断了」的探活），注册表总量 64 个（LRU 淘汰最老的已结束任务）。
_DONE_TTL_SECONDS = 3600.0
_DEAD_TTL_SECONDS = 1800.0
_TASK_MAX = 64
# 单任务帧缓冲软上限（字符）：正文 20 万封顶＋SSE 包裹开销，超限按出错收尾防失控
# 上游把内存吃穿（正常模块生成远达不到）。
_BUFFER_CHAR_LIMIT = 2_000_000

_tasks = {}  # f"{account}:{task_id}" -> GenerationTask（dict 按插入序，LRU 依此淘汰）
_sweeper_task = None


def normalize_gen_task_id(value) -> str:
    """POST body / URL 路径里的 gen_task_id 消毒：uuid 形状原样返回，其余空串。"""
    if not isinstance(value, str):
        return ""
    value = value.strip()
    return value if _GEN_TASK_ID_RE.fullmatch(value) else ""


class GenerationTask:
    """一次生成在服务端的持有态：帧缓冲＋订阅游标＋状态机。

    帧 = 逐字原样的 SSE 行（含行尾空行）。订阅者从游标 0 起重放再转实时——重放与
    实时走同一份缓冲，原客户端与重接客户端消费同一把尺子，游标制不可能丢帧。
    """

    def __init__(self, task_id: str, account: str):
        self.id = task_id
        self.account = account
        self.state = "running"  # running | done | error | interrupted
        self.frames = []
        self.chars = 0
        self.created_at = time.time()
        self.ended_at = None
        self.error_detail = None
        self.buffer_truncated = False
        self.upstream_task = None  # models_routes 的 reader 任务对象，cancel 的刀口
        self._cond = asyncio.Condition()
        self._subscribers = 0
        self._unwatched_since = None  # monotonic；None＝有人订阅（宽限不计时）

    # ---- 生命周期（models_routes 的 reader / 端点调用） ----

    def attach_upstream(self, task) -> None:
        self.upstream_task = task

    def cancel_upstream(self) -> None:
        task = self.upstream_task
        if task is not None and not task.done():
            task.cancel()

    async def append_frame(self, line: str) -> None:
        async with self._cond:
            if self.state != "running":
                return
            if self.chars + len(line) > _BUFFER_CHAR_LIMIT:
                # 直接收尾：终帧在 finish 里补，reader 的 finally 照样关上游
                self.state = "error"
                self.error_detail = "帧缓冲超限"
                self.ended_at = time.time()
                self.buffer_truncated = True
                self._cond.notify_all()
                return
            self.frames.append(line)
            self.chars += len(line)
            self._cond.notify_all()

    async def finish(self, state: str, error_detail=None) -> None:
        async with self._cond:
            if self.state != "running":
                return
            self.state = state
            self.ended_at = time.time()
            self.error_detail = error_detail
            if state == "interrupted":
                detail = error_detail or "生成已停止（后台任务被取消）"
                self.frames.append("data: " + json.dumps(
                    {"error": 499, "detail": detail}, ensure_ascii=False) + "\n\n")
            if not self.frames or self.frames[-1].strip() != "data: [DONE]":
                # 上游没吐 [DONE] 就断（错误/取消的正常断法）：补终帧，订阅端才有明确收口
                self.frames.append("data: [DONE]\n\n")
            self.chars = sum(len(f) for f in self.frames)
            self._cond.notify_all()

    def status(self) -> dict:
        return {
            "id": self.id,
            "state": self.state,
            "chars": self.chars,
            "truncated": self.buffer_truncated,
            "createdAt": self.created_at,
            "endedAt": self.ended_at,
            "error": self.error_detail,
        }

    # ---- 订阅 ----

    async def subscribe(self):
        """从缓冲 0 号帧起重放再转实时；running 期间逐帧跟随，终态后收尾。

        订阅计数是宽限自动停的依据：归零即开始计时（_unwatched_since），重新
        有人订阅即撤销。生成器被断连取消时 finally 保证计数归位。
        """
        cursor = 0
        self._subscribers += 1
        self._unwatched_since = None
        try:
            while True:
                async with self._cond:
                    while cursor >= len(self.frames) and self.state == "running":
                        await self._cond.wait()
                    batch = self.frames[cursor:]
                    cursor = len(self.frames)
                    state = self.state
                for line in batch:
                    yield line
                if state != "running" and cursor >= len(self.frames):
                    break
        finally:
            self._subscribers = max(0, self._subscribers - 1)
            if self._subscribers == 0 and self.state == "running":
                self._unwatched_since = time.monotonic()


def register_generation_task(task_id: str, account: str):
    """登记新任务；返回 None 表示「别转任务路」——id 非法或同 id 活任务已存在，
    调用方（models_routes）自动退回旧透传路径。已结束的同 id 请求顶掉旧壳。"""
    global _sweeper_task
    if not task_id:
        return None
    key = f"{account}:{task_id}"
    existing = _tasks.get(key)
    if existing is not None:
        if existing.state == "running":
            return None
        del _tasks[key]
    task = GenerationTask(task_id, account)
    _tasks[key] = task
    if _sweeper_task is None or _sweeper_task.done():
        async def _sweep_loop():
            while True:
                await asyncio.sleep(_SWEEP_INTERVAL_SECONDS)
                try:
                    _sweep_once()
                except Exception as e:  # 清扫只是兜底，别让它把循环带死
                    logger.warning(f"generation sweep error: {e}")
        _sweeper_task = asyncio.create_task(_sweep_loop())
    _sweep_once()
    return task


def get_generation_task(account: str, task_id: str):
    if not task_id:
        return None
    return _tasks.get(f"{account}:{task_id}")


def _sweep_once() -> None:
    """宽限掐上游＋TTL 回收＋LRU 限容。懒触发（注册/清扫循环），不动 lifespan。"""
    now_mono = time.monotonic()
    now = time.time()
    for key, task in list(_tasks.items()):
        if task.state == "running":
            if task._subscribers <= 0 and task._unwatched_since is None:
                # 没有订阅者却从没记过「无人」时刻（reader 起飞后从未有人接上，
                # 或订阅计数被异常路径漏清）：从现在起算宽限
                task._unwatched_since = now_mono
            if (task._subscribers <= 0 and task._unwatched_since is not None
                    and now_mono - task._unwatched_since >= GRACE_CANCEL_SECONDS):
                logger.info(f"generation task {task.id}: 宽限到点无人回来，掐上游（缓冲保留）")
                task.cancel_upstream()  # reader 捕 CancelledError → finish("interrupted")
        elif task.ended_at is not None:
            ttl = _DONE_TTL_SECONDS if task.state == "done" else _DEAD_TTL_SECONDS
            if now - task.ended_at > ttl:
                del _tasks[key]
    finished = [k for k, t in _tasks.items() if t.state != "running"]
    while len(_tasks) > _TASK_MAX and finished:
        del _tasks[finished.pop(0)]


# ===== 端点：探活 / 重接流 / 取消 =====

@router.get("/api/generations/{task_id}")
async def api_generation_status(task_id: str, request: Request):
    account = _account_id(request)
    task = get_generation_task(account, normalize_gen_task_id(task_id))
    if task is None:
        raise HTTPException(status_code=404, detail="generation not found")
    return task.status()


@router.get("/api/generations/{task_id}/stream")
async def api_generation_stream(task_id: str, request: Request):
    """重接流：先逐帧重放缓冲（原客户端已见过的内容也在内），再转实时跟随。
    线上形状与 /api/models/chat 的 SSE 完全一致，前端 _sseContentFrames 零改动。"""
    account = _account_id(request)
    task = get_generation_task(account, normalize_gen_task_id(task_id))
    if task is None:
        raise HTTPException(status_code=404, detail="generation not found")
    return StreamingResponse(task.subscribe(), media_type="text/event-stream")


@router.delete("/api/generations/{task_id}")
async def api_generation_cancel(task_id: str, request: Request):
    """取消后台任务（停止生成必须补的这刀：订阅断开≠取消）。fire-and-forget，
    任务不在了回 missing 而不是 404——前端不停留、不看结果。"""
    account = _account_id(request)
    task = get_generation_task(account, normalize_gen_task_id(task_id))
    if task is None:
        return {"state": "missing"}
    if task.state == "running":
        task.cancel_upstream()
        return {"state": "cancelling"}
    return {"state": task.state}
