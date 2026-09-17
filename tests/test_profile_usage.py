"""画像注入快照（profile_usage）：后端把「本次实际注入了什么」随回答下发。

角标据此展示，前端不再按缓存重算一遍同构分节。真实 HTTP 路由 + MockTransport
截获上游，不触网；数据全在临时目录。
Run: python3 -m pytest tests/test_profile_usage.py -q
"""

import json

import httpx
import pytest
from unittest import mock

from test_routes import RouteTestBase
import main as main_mod
from server import profile as profile_mod


def seed_profile(device_id="dev-usage", enabled=True, facts=None):
    """学段/目标一条即固化；其余类别按约定同批两次陈述才固化。"""
    profile_mod.update_profile(device_id, {"enabled": enabled})
    ops = []
    for fact, category in (facts or []):
        hits = 2 if category not in ("stage", "goal") else 1
        ops.extend([{"op": "new", "fact": fact, "category": category}] * hits)
    if ops:
        profile_mod.apply_profile_ops(device_id, ops, source="test")
    return profile_mod.get_profile(device_id)


# ---------- 契约：sections 与正文同源 ----------

def test_sections_match_injected_text(tmp_path):
    profile_mod.PROFILES_DIR = tmp_path
    seed_profile(facts=[("我是高二学生", "stage"), ("目标：高考物理90分", "goal")])
    ctx = profile_mod.profile_context("dev-usage")
    assert ctx["sections"], "有内容时必须给出分节快照"
    labels = [s["label"] for s in ctx["sections"]]
    assert "学段" in labels and "目标" in labels, f"标签不应带书名号：{labels}"
    for section in ctx["sections"]:
        assert section["text"] and f"【{section['label']}】{section['text']}" in ctx["text"]


def test_sections_empty_when_disabled_or_empty(tmp_path):
    profile_mod.PROFILES_DIR = tmp_path
    seed_profile(facts=[("我是高二学生", "stage")])
    profile_mod.update_profile("dev-usage", {"enabled": False})
    ctx = profile_mod.profile_context("dev-usage")
    assert ctx["text"] == "" and ctx["sections"] == [] and ctx["factIds"] == []


def test_sections_only_contain_budget_survivors(tmp_path):
    profile_mod.PROFILES_DIR = tmp_path
    seed_profile(facts=[(f"薄弱点{i}：" + "x" * 30, "weakness") for i in range(8)])
    ctx = profile_mod.profile_context("dev-usage")
    assert ctx["text"], "precondition: 有预算内内容"
    for section in ctx["sections"]:
        for item in section["text"].split("；"):
            assert item[:60] in ctx["text"], "分节不能包含被预算裁掉的条目"


# ---------- 路由：随响应下发 ----------

class ProfileUsageRouteTest(RouteTestBase):
    def _post_chat(self, payload, upstream_body=None, stream=False):
        """默认走前端实际使用的 prompt 格式（messages 旧格式不注入画像）。"""
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content.decode())
            if upstream_body is not None:
                return upstream_body
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(main_mod, "get_http_client", return_value=client):
            base = {
                "prompt": "什么是电磁感应",
                "level": "university",
                "provider": "deepseek",
                "api_key": "sk-test",
                "model": "test-model",
                "stream": stream,
            }
            base.update(payload)
            resp = self.client.post("/api/models/chat", json=base)
        return resp, seen

    def _stream_frames(self, resp):
        frames = []
        for part in resp.text.split("\n\n"):
            for line in part.split("\n"):
                if line.startswith("data: "):
                    data = line[6:].strip()
                    if data and data != "[DONE]":
                        frames.append(json.loads(data))
        return frames

    def _seed(self):
        seed_profile(facts=[("我是高二学生", "stage"), ("目标：高考物理90分", "goal")])

    def test_streaming_first_frame_carries_usage(self):
        self._seed()
        resp, _ = self._post_chat(
            {"device_id": "dev-usage"},
            upstream_body=httpx.Response(
                200, content=b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
            stream=True,
        )
        self.assertEqual(resp.status_code, 200)
        frames = self._stream_frames(resp)
        self.assertTrue(frames and "profile_usage" in frames[0],
                        f"快照必须是第一帧（角标先于正文拿到）：{frames[:2]}")
        usage = frames[0]["profile_usage"]
        labels = [s["label"] for s in usage["sections"]]
        self.assertIn("学段", labels)
        self.assertGreaterEqual(usage["factCount"], 1)
        # 正文仍按原协议下发
        self.assertTrue(any(f.get("choices") for f in frames))

    def test_streaming_usage_empty_when_profile_disabled(self):
        self._seed()
        profile_mod.update_profile("dev-usage", {"enabled": False})
        resp, _ = self._post_chat(
            {"device_id": "dev-usage"},
            upstream_body=httpx.Response(
                200, content=b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
            stream=True,
        )
        frames = self._stream_frames(resp)
        self.assertEqual(frames[0]["profile_usage"], {"sections": [], "factCount": 0},
                         "停用时也要明确说「本次没注入」，角标据此不显示")

    def test_quick_path_carries_no_usage(self):
        self._seed()
        resp, seen = self._post_chat(
            {"device_id": "dev-usage", "quick": True},
            upstream_body=httpx.Response(
                200, content=b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
            stream=True,
        )
        frames = self._stream_frames(resp)
        self.assertFalse(any("profile_usage" in f for f in frames),
                         "quick 路径不注入画像，也不该发快照")
        self.assertNotIn("user_profile", json.dumps(seen["body"], ensure_ascii=False))

    def test_legacy_messages_format_carries_no_usage(self):
        # messages 旧格式本就不注入画像（注入在 prompt 分支内），因此也没有快照
        self._seed()
        resp, seen = self._post_chat(
            {"device_id": "dev-usage", "prompt": None, "messages": [{"role": "user", "content": "hi"}]},
            upstream_body=httpx.Response(
                200, content=b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
            stream=True,
        )
        frames = self._stream_frames(resp)
        self.assertFalse(any("profile_usage" in f for f in frames))
        self.assertNotIn("user_profile", json.dumps(seen["body"], ensure_ascii=False))

    def test_no_device_id_carries_no_usage(self):
        self._seed()
        resp, _ = self._post_chat(
            {},
            upstream_body=httpx.Response(
                200, content=b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'),
            stream=True,
        )
        frames = self._stream_frames(resp)
        self.assertFalse(any("profile_usage" in f for f in frames))

    def test_non_streaming_json_carries_usage(self):
        self._seed()
        resp, _ = self._post_chat({"device_id": "dev-usage"})
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertIn("profile_usage", body)
        self.assertIn("学段", [s["label"] for s in body["profile_usage"]["sections"]])
        self.assertEqual(body["choices"][0]["message"]["content"], "ok", "原响应字段不变")
