"""strict module（socratic/learn）生成请求压地板档思考（T510，2026-11-21 二改）。

齿轮啮合会话实测：分支槽空回落主模型（书生 Sage）＋主槽思考 max，strict module 的
STRICT_MODULE_MAX_TOKENS=1000 上限被思考预算整段吃光——每发恰 1000 tok、正文空、
画布卡全败；同 run 非 strict 的 physics 6111 tok 成功。一改（剥参）实测否决：书生
默认思考关不掉，剥参后 8000 tok 上限推理仍烧满正文仍空。二改：压「floor」地板档——
effort 族 low（书生实测 170 tok 正文完整；none/minimal 该端点 400）、布尔开关族 off。
"""

import json
import os
import sys
from unittest import mock

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from server import http_client as http_client_mod  # noqa: E402  出网口补丁单点（T163）
from server.config import STRICT_MODULE_MAX_TOKENS  # noqa: E402
from route_test_base import RouteTestBase  # noqa: E402


class StrictModuleThinkingTest(RouteTestBase):
    """strict module 思考压地板档、保留上限；非 strict 行为一字不变。"""

    def _post(self, module_key, thinking):
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content.decode("utf-8"))
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        payload = {
            "messages": [{"role": "user", "content": "hello"}],
            "provider": "书生",
            "base_url": "https://discovery-api.intern-ai.org.cn/v1",
            "api_key": "stage0-fake-key",
            "model": "Sage-S2.1-Flash",
            "stream": False,
            "thinking": thinking,
            "workflow_context": {"target": {"kind": "module", "module": module_key, "label": "测试"}},
        }
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client):
            resp = self.client.post("/api/models/chat", json=payload)
        self.assertEqual(resp.status_code, 200)
        return seen["body"]

    def test_strict_module_clamps_thinking_to_floor_and_keeps_cap(self):
        body = self._post("socratic", "max")
        self.assertEqual(body.get("reasoning_effort"), "low")
        self.assertEqual(body.get("max_tokens"), STRICT_MODULE_MAX_TOKENS)

    def test_non_strict_module_keeps_thinking_and_no_cap(self):
        body = self._post("physics", "max")
        self.assertEqual(body.get("reasoning_effort"), "max")
        self.assertNotIn("max_tokens", body)

    def test_strict_module_without_thinking_untouched(self):
        body = self._post("learn", "")
        self.assertNotIn("reasoning_effort", body)
        self.assertEqual(body.get("max_tokens"), STRICT_MODULE_MAX_TOKENS)
