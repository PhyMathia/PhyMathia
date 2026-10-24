"""T222 代码卫生三件回归。

① http_client.post_chat_completion 收口 knowledge（extract/describe）与
   documents（docs）三处出网样板：URL/鉴权头/网关头构造、失败与 usage 记账、
   timeout 口径（缺省走共享 client，docs 显式 120）。
② harness api._safe_int：payload 坏输入落默认值，不再顺着裸 int() 的
   ValueError 落 500（graph_review 的兜底 except 历史上是 500）。
③ 死代码删除（storage._delete_by_session / profile.profile_context_text）
   不在本文件断言——无行为可测，删除本身即验证。
"""

import asyncio
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for _p in (ROOT, SRC):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import httpx

from server import http_client as http_client_mod
from server.http_client import post_chat_completion


class _FakeResp:
    def __init__(self, data):
        self._data = data

    def raise_for_status(self):
        pass

    def json(self):
        return self._data


class _FakeClient:
    def __init__(self, resp=None, exc=None):
        self.resp = resp
        self.exc = exc
        self.calls = []

    async def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if self.exc:
            raise self.exc
        return self.resp


class PostChatCompletionTest(unittest.TestCase):
    def _run(self, client, **overrides):
        kwargs = dict(
            provider="deepseek", model="m1", base_url="https://api.deepseek.com/",
            api_key="sk-x", messages=[{"role": "user", "content": "hi"}],
            temperature=0.2, usage_kind="extract", gateway_bucket="phymathia-extract",
        )
        kwargs.update(overrides)
        return asyncio.run(post_chat_completion(client, **kwargs))

    def test_success_shape_and_usage(self):
        usage = {"prompt_tokens": 1, "completion_tokens": 2}
        client = _FakeClient(_FakeResp({"choices": [], "usage": usage}))
        with mock.patch.object(http_client_mod.usage_stats, "record_usage") as ru, \
                mock.patch.object(http_client_mod.usage_stats, "record_failure") as rf:
            data = self._run(client)
        self.assertEqual(data["usage"], usage)
        ru.assert_called_once()
        rf.assert_not_called()
        url, post_kwargs = client.calls[0]
        self.assertEqual(url, "https://api.deepseek.com/chat/completions")
        self.assertEqual(post_kwargs["headers"]["Authorization"], "Bearer sk-x")
        self.assertEqual(post_kwargs["json"]["temperature"], 0.2)
        self.assertFalse(post_kwargs["json"]["stream"])

    def test_opencode_no_bearer_header(self):
        client = _FakeClient(_FakeResp({"choices": []}))
        with mock.patch.object(http_client_mod.usage_stats, "record_usage"), \
                mock.patch.object(http_client_mod.usage_stats, "record_failure"):
            self._run(client, provider="opencode", base_url="https://opencode.ai/zen/v1")
        _, post_kwargs = client.calls[0]
        self.assertNotIn("Authorization", post_kwargs["headers"])

    def test_failure_recorded_then_raised(self):
        boom = httpx.ConnectError("down")
        client = _FakeClient(exc=boom)
        with mock.patch.object(http_client_mod.usage_stats, "record_usage") as ru, \
                mock.patch.object(http_client_mod.usage_stats, "record_failure") as rf:
            with self.assertRaises(httpx.ConnectError):
                self._run(client)
        rf.assert_called_once()
        ru.assert_not_called()

    def test_timeout_passthrough(self):
        client = _FakeClient(_FakeResp({"choices": []}))
        with mock.patch.object(http_client_mod.usage_stats, "record_usage"), \
                mock.patch.object(http_client_mod.usage_stats, "record_failure"):
            self._run(client, timeout=120.0)
        _, post_kwargs = client.calls[0]
        self.assertEqual(post_kwargs["timeout"], 120.0)

    def test_timeout_default_not_passed(self):
        client = _FakeClient(_FakeResp({"choices": []}))
        with mock.patch.object(http_client_mod.usage_stats, "record_usage"), \
                mock.patch.object(http_client_mod.usage_stats, "record_failure"):
            self._run(client)
        _, post_kwargs = client.calls[0]
        self.assertNotIn("timeout", post_kwargs)


class SafeIntTest(unittest.TestCase):
    def test_legitimate_values(self):
        from harness.api import _safe_int
        self.assertEqual(_safe_int("12", 7), 12)
        self.assertEqual(_safe_int(12, 7), 12)
        self.assertEqual(_safe_int(12.7, 7), 12)  # 截断与裸 int() 同款
        self.assertEqual(_safe_int(True, 7), 1)

    def test_bad_values_fall_back(self):
        from harness.api import _safe_int
        for bad in (None, "", "abc", {"n": 1}, [1], object()):
            self.assertEqual(_safe_int(bad, 7), 7, bad)

    def test_review_kwargs_bad_input_no_500(self):
        """graph_review 的兜底 except 是 500：max_tokens/retries 坏输入必须在这里
        就被吞成默认值（T222 登记的 500 来源）。"""
        from harness.api import _review_kwargs
        kwargs = _review_kwargs({"max_tokens": "abc", "retries": "x"}, "", None)
        self.assertEqual(kwargs["max_tokens"], 4000)
        self.assertEqual(kwargs["retries"], 2)


if __name__ == "__main__":
    unittest.main()
