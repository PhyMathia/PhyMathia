"""T95 上游容错回归：_call_model 退避重试 + review_graph 失败自动换备用模型。

覆盖：
- 429/429/200 退避重试成功、429 耗尽、401/400 不重试、Retry-After 解析与封顶、
  超时重试、非流式 HarnessError 带 status_code（既有缺陷修复）；
- 流式已吐增量不重试、未吐增量可整次重来；
- review_graph 备用模型链：503 换模型成功、400 不换、非法候选跳过、journal 条目、
  SSE status 事件、fallback_used 结果字段；
- _sanitize_fallback_models 清洗、api._review_kwargs 装配、事件落盘 fallback_used。

重试延迟与 Retry-After 封顶全部 monkeypatch（_RETRY_DELAYS=(0, 0) 等），
测试绝不真睡；模型调用桩照既有形态（固定签名 test double）。
"""

from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import httpx

from harness import api as api_mod
from harness import events as events_mod
from harness import review as review_mod

MODEL = {"provider": "opencode", "model": "primary", "base_url": "https://x", "api_key": ""}
BACKUP = {"provider": "opencode", "model": "backup", "base_url": "https://x", "api_key": ""}
SNAPSHOT = {
    "version": 1,
    "nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "瞬时变化率"}],
    "edges": [],
}
SID = "phi_test_resilience"


class FakeResponse:
    """最小 httpx.Response 替身（_call_model 只用 status_code/text/json/headers）。"""

    def __init__(self, status_code, payload=None, headers=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.headers = dict(headers or {})
        self.text = text or (json.dumps(payload, ensure_ascii=False) if payload is not None else "")

    def json(self):
        if self._payload is None:
            raise ValueError("no payload")
        return self._payload


def _ok(content="done"):
    return FakeResponse(200, {"choices": [{"message": {"content": content}}], "usage": {"prompt_tokens": 1}})


def _err(status, headers=None, text="upstream busy"):
    return FakeResponse(status, {"error": "x"}, headers=headers, text=text)


class FakePostClient:
    """按序返回预先排好的响应/异常；超出预期调用次数直接断言失败。"""

    def __init__(self, sequence):
        self.sequence = list(sequence)
        self.calls = 0

    async def post(self, url, json=None, headers=None, timeout=None):
        if self.calls >= len(self.sequence):
            raise AssertionError("unexpected extra HTTP post (#%d)" % (self.calls + 1))
        item = self.sequence[self.calls]
        self.calls += 1
        if isinstance(item, BaseException):
            raise item
        return item


def _call_with_sequence(sequence, *, model=None, on_delta=None, delays=(0, 0), cap=None):
    """跑一次 _call_model（假 client + 零延迟重试），返回 (client, result)。"""
    client = FakePostClient(sequence)
    with mock.patch.object(review_mod, "get_http_client", lambda: client), \
            mock.patch.object(review_mod, "_RETRY_DELAYS", delays):
        if cap is None:
            return client, asyncio.run(review_mod._call_model(
                [{"role": "user", "content": "hi"}], dict(model or MODEL), 100, on_delta=on_delta))
        with mock.patch.object(review_mod, "_RETRY_AFTER_CAP", cap):
            return client, asyncio.run(review_mod._call_model(
                [{"role": "user", "content": "hi"}], dict(model or MODEL), 100, on_delta=on_delta))


class CallModelRetryTest(unittest.TestCase):
    def test_429_retry_then_success(self):
        client, result = _call_with_sequence([_err(429), _err(429), _ok("恢复")])
        self.assertEqual(result["content"], "恢复")
        self.assertEqual(client.calls, 3)

    def test_429_exhausts_two_retries(self):
        client = FakePostClient([_err(429)] * 3)
        with mock.patch.object(review_mod, "get_http_client", lambda: client), \
                mock.patch.object(review_mod, "_RETRY_DELAYS", (0, 0)):
            with self.assertRaises(review_mod.HarnessError) as ctx:
                asyncio.run(review_mod._call_model(
                    [{"role": "user", "content": "hi"}], dict(MODEL), 100))
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(client.calls, 3)

    def test_401_not_retried(self):
        client = FakePostClient([_err(401, text="invalid api key")])
        with mock.patch.object(review_mod, "get_http_client", lambda: client), \
                mock.patch.object(review_mod, "_RETRY_DELAYS", (0, 0)):
            with self.assertRaises(review_mod.HarnessError) as ctx:
                asyncio.run(review_mod._call_model(
                    [{"role": "user", "content": "hi"}], dict(MODEL), 100))
        self.assertEqual(ctx.exception.status_code, 401)
        self.assertEqual(client.calls, 1)

    def test_retry_after_header_respected_and_capped(self):
        slept = []

        async def fake_sleep(seconds):
            slept.append(seconds)

        client = FakePostClient([_err(429, headers={"Retry-After": "17"}), _ok("恢复")])
        with mock.patch.object(review_mod, "get_http_client", lambda: client), \
                mock.patch.object(review_mod, "_RETRY_DELAYS", (0, 0)), \
                mock.patch.object(review_mod, "_RETRY_AFTER_CAP", 0.5), \
                mock.patch.object(review_mod.asyncio, "sleep", fake_sleep):
            result = asyncio.run(review_mod._call_model(
                [{"role": "user", "content": "hi"}], dict(MODEL), 100))
        # Retry-After=17 被读到并封顶到 0.5；若走了退避序列会是 0（patch 成 (0,0)）
        self.assertEqual(slept, [0.5])
        self.assertEqual(client.calls, 2)
        self.assertEqual(result["content"], "恢复")

    def test_parse_retry_after_defaults(self):
        self.assertEqual(
            review_mod._parse_retry_after(FakeResponse(429, headers={"Retry-After": "999"})), 30.0)
        self.assertEqual(
            review_mod._parse_retry_after(FakeResponse(429, headers={"Retry-After": "2.5"})), 2.5)
        self.assertIsNone(review_mod._parse_retry_after(FakeResponse(429, headers={"Retry-After": "soon"})))
        self.assertIsNone(review_mod._parse_retry_after(FakeResponse(429)))

    def test_timeout_retried_then_success(self):
        client, result = _call_with_sequence([httpx.TimeoutException("read timeout"), _ok("恢复")])
        self.assertEqual(result["content"], "恢复")
        self.assertEqual(client.calls, 2)

    def test_non_streaming_error_carries_status_code(self):
        client = FakePostClient([_err(503, text="overloaded")] * 3)
        with mock.patch.object(review_mod, "get_http_client", lambda: client), \
                mock.patch.object(review_mod, "_RETRY_DELAYS", (0, 0)):
            with self.assertRaises(review_mod.HarnessError) as ctx:
                asyncio.run(review_mod._call_model(
                    [{"role": "user", "content": "hi"}], dict(MODEL), 100))
        # 既有缺陷修复：非流式路径也要带 status_code（否则 429/503 判不出来）
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(client.calls, 3)

    def test_stream_without_delta_retries(self):
        calls = {"n": 0}

        async def fake_stream(client_, url, headers, body, on_delta):
            calls["n"] += 1
            if calls["n"] == 1:
                err = review_mod.HarnessError("模型返回 503: busy")
                err.status_code = 503
                raise err
            return {"content": "恢复"}, None

        with mock.patch.object(review_mod, "_stream_chat_completions", fake_stream), \
                mock.patch.object(review_mod, "get_http_client", lambda: object()), \
                mock.patch.object(review_mod, "_RETRY_DELAYS", (0, 0)):
            result = asyncio.run(review_mod._call_model(
                [{"role": "user", "content": "hi"}], dict(MODEL), 100, on_delta=lambda c: None))
        self.assertEqual(result["content"], "恢复")
        self.assertEqual(calls["n"], 2)

    def test_stream_after_delta_never_retries(self):
        calls = {"n": 0}

        async def fake_stream(client_, url, headers, body, on_delta):
            calls["n"] += 1
            on_delta("已经发出的半句")
            err = review_mod.HarnessError("模型返回 429: busy")
            err.status_code = 429
            raise err

        with mock.patch.object(review_mod, "_stream_chat_completions", fake_stream), \
                mock.patch.object(review_mod, "get_http_client", lambda: object()), \
                mock.patch.object(review_mod, "_RETRY_DELAYS", (0, 0)):
            with self.assertRaises(review_mod.HarnessError) as ctx:
                asyncio.run(review_mod._call_model(
                    [{"role": "user", "content": "hi"}], dict(MODEL), 100, on_delta=lambda c: None))
        # 已吐增量再重试会把同一段文字重复发给前端，必须直接抛
        self.assertEqual(ctx.exception.status_code, 429)
        self.assertEqual(calls["n"], 1)


def _create_node_result():
    """备用模型返回的合法 tool_calls（create_node）。"""
    return {
        "content": "",
        "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "create_node",
                "arguments": json.dumps({"temp_id": "t1", "kind": "knowledge",
                                         "label": "新节点", "reason": "补充"}),
            },
        }],
    }


def _switchable_fake(primary_error, seen, backup_result=None):
    async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                   json_mode=False, on_delta=None):
        seen.append(model["model"])
        if model["model"] == "primary":
            raise primary_error()
        return backup_result if backup_result is not None else _create_node_result()
    return fake


def _run_review(fake, *, fallbacks, progress=None, journal=None):
    with mock.patch.object(review_mod, "_call_model", new=fake):
        return asyncio.run(review_mod.review_graph(
            dict(SNAPSHOT),
            "添加一个知识点",
            model=dict(MODEL),
            retries=0,
            self_check="off",
            fallback_models=fallbacks,
            progress=progress,
            journal=journal,
        ))


def _http_error(status):
    def _make():
        err = review_mod.HarnessError(f"模型返回 {status}: upstream busy")
        err.status_code = status
        return err
    return _make


class FallbackModelTest(unittest.TestCase):
    def test_503_switches_to_backup_model(self):
        seen = []
        result = _run_review(_switchable_fake(_http_error(503), seen), fallbacks=[dict(BACKUP)])
        # 主模型的工具调用失败后还会走一次既有 tools→json 降级（同为 primary），
        # 但拿到 503 后必然切到备用模型并成功
        self.assertEqual(set(seen), {"primary", "backup"})
        self.assertEqual(seen[-1], "backup")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["fallback_used"], {"provider": "opencode", "model": "backup"})

    def test_400_never_switches_model(self):
        seen = []
        with self.assertRaises(review_mod.HarnessError) as ctx:
            _run_review(_switchable_fake(_http_error(400), seen), fallbacks=[dict(BACKUP)])
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertEqual(set(seen), {"primary"})

    def test_network_error_switches_model(self):
        seen = []

        def _net():
            return review_mod.HarnessError("模型请求失败: connection reset")

        result = _run_review(_switchable_fake(_net, seen), fallbacks=[dict(BACKUP)])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["fallback_used"]["model"], "backup")

    def test_invalid_candidate_skipped_to_next(self):
        seen = []
        bad = {"provider": "unknown-provider-x", "model": "bad", "api_key": ""}  # 无 base_url
        events = []
        result = _run_review(
            _switchable_fake(_http_error(503), seen),
            fallbacks=[bad, dict(BACKUP)],
            progress=events.append,
        )
        self.assertEqual(set(seen), {"primary", "backup"})
        self.assertEqual(seen[-1], "backup")
        self.assertEqual(result["fallback_used"]["model"], "backup")
        skip = [e for e in events if e.get("stage") == "fallback" and "跳过" in str(e.get("message") or "")]
        self.assertEqual(len(skip), 1)

    def test_journal_records_fallback_entry(self):
        journal = []
        seen = []
        _run_review(_switchable_fake(_http_error(503), seen), fallbacks=[dict(BACKUP)], journal=journal)
        entries = [e for e in journal if e.get("stage") == "fallback"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["from"], "opencode/primary")
        self.assertEqual(entries[0]["to"], "opencode/backup")
        self.assertIn("503", entries[0]["error"])

    def test_sse_status_event_for_fallback(self):
        events = []
        seen = []
        _run_review(_switchable_fake(_http_error(503), seen), fallbacks=[dict(BACKUP)], progress=events.append)
        fallback_events = [e for e in events if e.get("type") == "status" and e.get("stage") == "fallback"]
        self.assertEqual(len(fallback_events), 1)
        self.assertIn("backup", fallback_events[0]["message"])
        self.assertEqual(fallback_events[0]["attempt"], 0)

    def test_all_candidates_exhausted_raises_last_error(self):
        seen = []

        async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                       json_mode=False, on_delta=None):
            seen.append(model["model"])
            raise _http_error(503)()

        with self.assertRaises(review_mod.HarnessError) as ctx:
            _run_review(fake, fallbacks=[dict(BACKUP)])
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(set(seen), {"primary", "backup"})
        self.assertEqual(seen[-1], "backup")

    def test_no_fallback_models_keeps_old_behavior(self):
        seen = []
        with self.assertRaises(review_mod.HarnessError) as ctx:
            _run_review(_switchable_fake(_http_error(503), seen), fallbacks=None)
        self.assertEqual(ctx.exception.status_code, 503)
        self.assertEqual(set(seen), {"primary"})


class SanitizeFallbackModelsTest(unittest.TestCase):
    def test_non_list_returns_none(self):
        self.assertIsNone(review_mod._sanitize_fallback_models("nope"))
        self.assertIsNone(review_mod._sanitize_fallback_models({"provider": "p"}))
        self.assertIsNone(review_mod._sanitize_fallback_models(None))

    def test_drops_items_without_model(self):
        self.assertIsNone(review_mod._sanitize_fallback_models([{"provider": "p"}, 1, None]))
        cleaned = review_mod._sanitize_fallback_models([{"provider": "p", "model": "m"}])
        self.assertEqual(cleaned, [{"provider": "p", "api_key": "", "model": "m", "base_url": ""}])

    def test_truncates_to_two_and_strips_unknown_fields(self):
        raw = [
            {"provider": "p1", "model": "m1", "thinking": "high", "extra": 1},
            {"provider": "p2", "model": "m2", "base_url": "https://x"},
            {"provider": "p3", "model": "m3"},
        ]
        cleaned = review_mod._sanitize_fallback_models(raw)
        self.assertEqual([item["model"] for item in cleaned], ["m1", "m2"])
        self.assertEqual(set(cleaned[0].keys()), {"provider", "api_key", "model", "base_url"})


class FallbackWorthyTest(unittest.TestCase):
    def test_status_code_classification(self):
        for status in (401, 408, 429, 500, 502, 503, 504):
            err = review_mod.HarnessError("x")
            err.status_code = status
            self.assertTrue(review_mod._fallback_worthy(err), status)
        for status in (400, 403, 404, 422):
            err = review_mod.HarnessError("x")
            err.status_code = status
            self.assertFalse(review_mod._fallback_worthy(err), status)
        # 无 status_code＝网络类，值得换模型
        self.assertTrue(review_mod._fallback_worthy(review_mod.HarnessError("connection reset")))


class ReviewKwargsTest(unittest.TestCase):
    def test_api_layer_passes_sanitized_fallback_models(self):
        kwargs = api_mod._review_kwargs(
            {"model": MODEL, "fallback_models": [dict(BACKUP), dict(BACKUP), dict(BACKUP)]}, "")
        self.assertEqual(len(kwargs["fallback_models"]), 2)
        self.assertEqual(kwargs["fallback_models"][0]["model"], "backup")
        self.assertIsNone(api_mod._review_kwargs({"model": MODEL}, "")["fallback_models"])
        self.assertIsNone(api_mod._review_kwargs({"model": MODEL, "fallback_models": "x"}, "")["fallback_models"])


class EventLogTest(unittest.TestCase):
    def test_review_event_carries_fallback_used(self):
        original = events_mod._EVENTS_DIR
        with tempfile.TemporaryDirectory() as tmp:
            events_mod.set_events_dir(tmp)
            try:
                result = {
                    "status": "ok",
                    "phase": "normal",
                    "fallback_used": {"provider": "opencode", "model": "backup"},
                }
                payload = {"instruction": "改一下", "session_id": SID, "model": MODEL}
                evt_id = api_mod._log_review_event(payload, result, 0.0, "review", [])
                self.assertTrue(evt_id)
                lines = (Path(tmp) / f"{SID}.jsonl").read_text(encoding="utf-8").strip().split("\n")
                event = json.loads(lines[-1])
                self.assertEqual(event["fallback_used"], {"provider": "opencode", "model": "backup"})
            finally:
                events_mod.set_events_dir(original)


if __name__ == "__main__":
    unittest.main()
