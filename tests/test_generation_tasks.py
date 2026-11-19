"""484 生成断点续跑：generation_tasks 注册表单测 + chat 路由任务化路径集成。

打桩口径（T163 拍板）：出网口打 server.http_client 单点（与 test_fix_formula
同款 _FakeRequest/_FakeClient 形状）；上游假响应按行吐 SSE。注册表是模块级
单例：autouse fixture 每例清空，清扫循环任务在场景尾部就地取消防告警。
"""
import asyncio
import json
import time
from unittest import mock

import pytest
from fastapi import HTTPException

from server import generation_tasks, models_routes


class _FakeRequest:
    """最小 Request 桩：_parse_json_object 读 body()，_account_id 读 query_params。"""

    def __init__(self, payload=None):
        self._body = json.dumps(payload or {}).encode("utf-8")
        self.query_params = {}
        self.headers = {}

    async def body(self):
        return self._body


@pytest.fixture(autouse=True)
def _clean_registry():
    generation_tasks._tasks.clear()
    generation_tasks._sweeper_task = None
    yield
    generation_tasks._tasks.clear()
    generation_tasks._sweeper_task = None


async def _stop_sweeper():
    task = generation_tasks._sweeper_task
    if task is not None:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        generation_tasks._sweeper_task = None


# ===== id 消毒 =====

def test_normalize_gen_task_id():
    ok = "11111111-2222-3333-4444-555555555555"
    assert generation_tasks.normalize_gen_task_id(ok) == ok
    assert generation_tasks.normalize_gen_task_id(ok.upper()) == ok.upper()
    assert generation_tasks.normalize_gen_task_id("junk") == ""
    assert generation_tasks.normalize_gen_task_id(None) == ""
    assert generation_tasks.normalize_gen_task_id(ok + "-extra") == ""


# ===== 注册表 =====

def test_register_duplicate_running_returns_none():
    tid = "11111111-2222-3333-4444-555555555555"

    async def scenario():
        task = generation_tasks.register_generation_task(tid, "default")
        assert task is not None and task.state == "running"
        # 同 id 活任务撞车：返回 None，调用方退回旧透传路径
        assert generation_tasks.register_generation_task(tid, "default") is None
        status = await generation_tasks.api_generation_status(tid, _FakeRequest(None))
        assert status["state"] == "running"
        await _stop_sweeper()

    asyncio.run(scenario())


def test_subscribe_live_then_replay():
    lines = ["data: " + json.dumps({"choices": [{"delta": {"content": c}}]}) + "\n\n"
             for c in ["A", "B", "C"]]

    async def scenario():
        task = generation_tasks.GenerationTask("t", "default")

        async def reader():
            await asyncio.sleep(0.01)
            for line in lines:
                await task.append_frame(line)
            await task.finish("done")

        async def sub():
            return [frame async for frame in task.subscribe()]

        got, _ = await asyncio.gather(sub(), reader())
        # 实时订阅收到全部数据帧＋补发的 [DONE]，顺序不丢
        assert got == lines + ["data: [DONE]\n\n"]
        # 迟到订阅：重放同一份缓冲后收尾
        replay = [frame async for frame in task.subscribe()]
        assert replay == got

    asyncio.run(scenario())


def test_error_finish_appends_terminal_frames():
    async def scenario():
        task = generation_tasks.GenerationTask("t", "default")
        await task.append_frame("data: x\n\n")
        await task.finish("error", "boom")
        assert task.state == "error" and task.error_detail == "boom"
        assert task.frames[-1].strip() == "data: [DONE]"
        # 终态后 append 被忽略
        await task.append_frame("data: late\n\n")
        assert task.frames[-1].strip() == "data: [DONE]"

    asyncio.run(scenario())


def test_grace_cancel_after_unwatched():
    tid = "22222222-2222-2222-2222-222222222222"

    async def scenario():
        task = generation_tasks.register_generation_task(tid, "default")

        async def fake_reader():
            try:
                await asyncio.sleep(30)
            except asyncio.CancelledError:
                # 与 models_routes 的 reader 同款：取消 → interrupted → 缓冲保留
                await task.finish("interrupted")

        upstream = asyncio.create_task(fake_reader())
        task.attach_upstream(upstream)
        with mock.patch.object(generation_tasks, "GRACE_CANCEL_SECONDS", 0.05):
            generation_tasks._sweep_once()  # 无人订阅：记下宽限起点
            assert task._unwatched_since is not None
            await asyncio.sleep(0.08)
            generation_tasks._sweep_once()  # 宽限到点：掐上游
            await asyncio.sleep(0.05)
        assert task.state == "interrupted"
        assert upstream.done()
        # 取消任务的缓冲保留（迟到重放还有内容）且带终帧
        assert task.frames[-1].strip() == "data: [DONE]"
        assert any('"error": 499' in frame for frame in task.frames)
        await _stop_sweeper()

    asyncio.run(scenario())


def test_ttl_gc_and_lru_cap():
    async def scenario():
        # TTL：完成的任务过 60 分钟回收
        tid = "33333333-3333-3333-3333-333333333333"
        task = generation_tasks.register_generation_task(tid, "default")
        await task.finish("done")
        task.ended_at = time.time() - (generation_tasks._DONE_TTL_SECONDS + 10)
        generation_tasks._sweep_once()
        assert generation_tasks.get_generation_task("default", tid) is None
        # LRU：总量超限时淘汰最老的已结束任务，running 任务不动
        for i in range(generation_tasks._TASK_MAX + 5):
            t = generation_tasks.GenerationTask(f"44444444-4444-4444-4444-{i:012d}", "default")
            t.state = "done"
            t.ended_at = time.time()
            generation_tasks._tasks[f"default:{t.id}"] = t
        runner = generation_tasks.GenerationTask("55555555-5555-5555-5555-555555555555", "default")
        generation_tasks._tasks["default:" + runner.id] = runner  # running 不在淘汰名单
        generation_tasks._sweep_once()
        assert len(generation_tasks._tasks) <= generation_tasks._TASK_MAX
        assert generation_tasks.get_generation_task("default", runner.id) is runner
        await _stop_sweeper()

    asyncio.run(scenario())


# ===== chat 路由任务化路径（集成） =====

class _FakeSSEUpstream:
    def __init__(self, lines):
        self._lines = lines
        self.closed = False
        self.status_code = 200

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aclose(self):
        self.closed = True


class _FakeStreamClient:
    def __init__(self, lines):
        self._lines = lines

    def build_request(self, method, url, json=None, headers=None, timeout=None):
        return object()

    async def send(self, request, stream=False):
        return _FakeSSEUpstream(self._lines)


def _stream_payload(gen_task_id=None):
    payload = {
        "messages": [{"role": "user", "content": "你好"}],
        "provider": "deepseek",
        "api_key": "key",
        "model": "test-model",
        "base_url": "https://api.example.com",
        "stream": True,
    }
    if gen_task_id:
        payload["gen_task_id"] = gen_task_id
    return payload


def _upstream_lines(texts):
    lines = ["data: " + json.dumps({"choices": [{"delta": {"content": t}}]}, ensure_ascii=False)
             for t in texts]
    lines.append("data: [DONE]")
    return lines


async def _drain_sse(resp):
    got = ""
    async for chunk in resp.body_iterator:
        got += chunk if isinstance(chunk, str) else chunk.decode("utf-8")
    return got


def test_chat_task_mode_stream_status_reattach():
    tid = "99999999-8888-7777-6666-555555555555"

    async def scenario():
        fake = _FakeStreamClient(_upstream_lines(["你好", "世界"]))
        with mock.patch.object(models_routes.http_client, "get_http_client", return_value=fake):
            resp = await models_routes.api_models_chat(_FakeRequest(_stream_payload(tid)))
            got = await _drain_sse(resp)
            # 原客户端拿到的线材与旧透传路径同形状（数据帧＋[DONE]）
            assert "你好" in got and "世界" in got and "[DONE]" in got
            # 任务收尾：状态 done，上游连接关闭
            status = await generation_tasks.api_generation_status(tid, _FakeRequest(None))
            assert status["state"] == "done" and status["chars"] > 0
            assert fake._lines is not None
            # 重接流：重放全部缓冲，终帧收口
            replay_resp = await generation_tasks.api_generation_stream(tid, _FakeRequest(None))
            replay = await _drain_sse(replay_resp)
            assert "你好" in replay and "世界" in replay
            assert replay.strip().endswith("data: [DONE]")
            # 已结束任务 DELETE：回终态、不报错
            result = await generation_tasks.api_generation_cancel(tid, _FakeRequest(None))
            assert result == {"state": "done"}
            await _stop_sweeper()

    asyncio.run(scenario())


def test_chat_task_mode_survives_without_subscriber():
    """核心场景：客户端拿完响应头就断连（不消费流），任务照样跑完。"""
    tid = "aaaa1111-2222-3333-4444-555555555555"

    async def scenario():
        fake = _FakeStreamClient(_upstream_lines(["后台", "跑完"]))
        with mock.patch.object(models_routes.http_client, "get_http_client", return_value=fake):
            await models_routes.api_models_chat(_FakeRequest(_stream_payload(tid)))
            await asyncio.sleep(0.2)  # reader 无订阅者独立跑完
            status = await generation_tasks.api_generation_status(tid, _FakeRequest(None))
            assert status["state"] == "done"
            await _stop_sweeper()

    asyncio.run(scenario())


def test_chat_without_gen_task_id_keeps_legacy_path():
    """回归锚：不带 gen_task_id 的流式请求走旧透传路径，注册表不进任务。"""

    async def scenario():
        fake = _FakeStreamClient(_upstream_lines(["旧路", "透传"]))
        with mock.patch.object(models_routes.http_client, "get_http_client", return_value=fake):
            resp = await models_routes.api_models_chat(_FakeRequest(_stream_payload(None)))
            got = await _drain_sse(resp)
            assert "旧路" in got and "透传" in got and "[DONE]" in got
            assert generation_tasks._tasks == {}
            # 非法 id 同样退回旧路
            resp2 = await models_routes.api_models_chat(_FakeRequest(_stream_payload("junk-id")))
            got2 = await _drain_sse(resp2)
            assert "旧路" in got2 and generation_tasks._tasks == {}
            await _stop_sweeper()

    asyncio.run(scenario())


def test_chat_cancel_running_task_interrupts():
    tid = "bbbb1111-2222-3333-4444-555555555555"

    async def scenario():
        class _SlowUpstream(_FakeSSEUpstream):
            async def aiter_lines(self):
                yield self._lines[0]
                await asyncio.sleep(30)  # 挂住：模拟长生成

        fake_upstream = _SlowUpstream(_upstream_lines(["第一片"]))

        class _SlowClient(_FakeStreamClient):
            async def send(self, request, stream=False):
                return fake_upstream

        client = _SlowClient([])
        with mock.patch.object(models_routes.http_client, "get_http_client", return_value=client):
            await models_routes.api_models_chat(_FakeRequest(_stream_payload(tid)))
            await asyncio.sleep(0.05)  # reader 起飞、吐完第一片
            result = await generation_tasks.api_generation_cancel(tid, _FakeRequest(None))
            assert result == {"state": "cancelling"}
            await asyncio.sleep(0.05)  # reader 处理取消
            status = await generation_tasks.api_generation_status(tid, _FakeRequest(None))
            assert status["state"] == "interrupted"
            assert fake_upstream.closed  # 上游连接被关
            await _stop_sweeper()

    asyncio.run(scenario())


def test_status_unknown_task_returns_404():
    async def scenario():
        with pytest.raises(HTTPException) as ei:
            await generation_tasks.api_generation_status(
                "cccc1111-2222-3333-4444-555555555555", _FakeRequest(None))
        assert ei.value.status_code == 404

    asyncio.run(scenario())
