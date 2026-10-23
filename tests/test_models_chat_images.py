"""api_models_chat 取材附图（payload.images → user 消息 image_url 部件）的单元回归。

2026-10-23 素材篮附图通道：前端把上游图片素材压成 dataURL 随 images 送来，
服务端消毒后转成 image_url 部件附在最后一条 user 消息上。**全程不联网**：
出网 client 桩替（capture build_request 的 json），断言上游收到的消息形状。
"""

import asyncio
import json
import os
import sys
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from server import models_routes  # noqa: E402


class _FakeChatResponse:
    status_code = 200

    async def aiter_bytes(self):
        yield b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        yield b"data: [DONE]\n\n"

    async def aread(self):
        return b""

    async def aclose(self):
        return None


class _FakeChatClient:
    """http_client 桩：capture build_request 的 json（上游收到的请求体）。"""

    def __init__(self):
        self.requests = []

    def build_request(self, method, url, json=None, headers=None, timeout=None):
        self.requests.append({"url": url, "json": json})
        return {"method": method, "url": url}

    async def send(self, request, stream=False):
        return _FakeChatResponse()


class _FakeRequest:
    """最小 Request 桩：_parse_json_object 读 body()，_account_id 读 headers。"""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")
        self.query_params = {}
        self.headers = {}

    async def body(self):
        return self._body


_IMG = "data:image/png;base64," + "A" * 100
_BAD_PREFIX = "data:text/html;base64,AAAA"
_OVERSIZE = "data:image/png;base64," + "A" * (models_routes.CHAT_IMAGE_B64_MAX_CHARS + 1)


def _payload(**over):
    base = {
        "prompt": "讲讲牛顿第二定律",
        "provider": "deepseek",
        "api_key": "key",
        "model": "test-model",
        "base_url": "https://api.example.com",
        "session_id": "",
        "workflow_context": {"target": {"module": "physics", "kind": "module"}},
    }
    base.update(over)
    return base


def _chat(payload):
    fake = _FakeChatClient()
    with mock.patch.object(models_routes.http_client, "get_http_client", return_value=fake):
        asyncio.run(models_routes.api_models_chat(_FakeRequest(payload)))
    assert fake.requests, "上游请求必须已发出"
    return fake.requests[0]["json"]


def test_images_attached_as_parts():
    body = _chat(_payload(images=[_IMG, _IMG]))
    last = body["messages"][-1]
    assert last["role"] == "user"
    assert isinstance(last["content"], list), "带图时最后一条 user 消息转多部件数组"
    assert "牛顿" in last["content"][0]["text"], "文字部件在前且含原提示词"
    parts = [p for p in last["content"] if p["type"] == "image_url"]
    assert len(parts) == 2
    assert parts[0]["image_url"]["url"] == _IMG


def test_no_images_keeps_string_content():
    body = _chat(_payload())
    last = body["messages"][-1]
    assert isinstance(last["content"], str), "不带图必须维持纯字符串 content（回归锚）"


def test_bad_images_dropped_silently():
    body = _chat(_payload(images=[_BAD_PREFIX, _OVERSIZE, 42, None, _IMG]))
    last = body["messages"][-1]
    parts = [p for p in last["content"] if p["type"] == "image_url"]
    assert len(parts) == 1, "形状/前缀/体积不合的图逐张丢弃，好的保留"


def test_images_capped():
    body = _chat(_payload(images=[_IMG] * 9))
    parts = [p for p in body["messages"][-1]["content"] if p["type"] == "image_url"]
    assert len(parts) == models_routes.CHAT_IMAGES_MAX


def test_non_list_images_ignored():
    body = _chat(_payload(images="data:image/png;base64,AAAA"))
    assert isinstance(body["messages"][-1]["content"], str)


def test_message_text_for_log_no_base64_leak():
    msg = {"content": [{"type": "text", "text": "题目"},
                       {"type": "image_url", "image_url": {"url": _IMG}}]}
    text = models_routes._message_text_for_log(msg)
    assert "题目" in text
    assert "base64" not in text, "日志/token 估算只取文字部件，base64 不进日志"
    assert models_routes._message_text_for_log({"content": "纯串"}) == "纯串"
