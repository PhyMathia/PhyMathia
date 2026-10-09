"""T206 销账：/api/models/chat 的苏格拉底状态更新必须落在请求的账号域。

流式出口（proxy_stream）一直传 account；非流式出口此前漏传，
_update_socratic_state_from_content 落到 DEFAULT_ACCOUNT——非 default 账号的
苏格拉底闭环状态（socratic:<ref>）会串写进 default 账号的 kv_store.json。
真实 HTTP 路由 + MockTransport 截获上游，不触网；数据全在临时目录。

触发面备注（2026-10-09 核实）：当前前端所有 stream:false 调用（知识/大陆/quiz）
只带 session_bucket 不带 session_id，socratic_ref 为空函数早退，尚无真实误写
流；本测试钉的是后端正确性——未来任何带 session_id 的非流式调用不再踩雷。
Run: python3 -m pytest tests/test_socratic_account_route.py -q
"""

import json
from pathlib import Path
from unittest import mock

import httpx

from test_routes import RouteTestBase
from server import accounts as accounts_mod
from server import http_client as http_client_mod
from server import storage as storage_mod


_SOCRATIC_CONTENT = "追问回答。<socratic_meta correct='correct' done='false'/>"


def _register_account(account: str) -> None:
    """RouteTestBase 已把 DATA_DIR 重定向到临时目录，注册表落在里面。"""
    accounts_mod._ENSURED.clear()
    accounts_mod._REGISTRY_CACHE["key"] = None
    accounts_mod._REGISTRY_CACHE["entries"] = {}
    accounts_mod.register_account(account)
    accounts_mod.ensure_account(account)


def _kv_keys(account: str) -> dict:
    # T214：socratic:<ref> 状态落在 socratic 族拆分文件（data/kv/meta/socratic.json）
    path = Path(storage_mod._kv_meta_path("socratic", account))
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


class SocraticStateAccountRouteTest(RouteTestBase):
    SESSION_ID = "sess_socraticacct000001"

    def _post_chat(self, payload, upstream_response):
        def handler(request):
            return upstream_response

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client):
            base = {
                "provider": "deepseek",
                "api_key": "sk-test",
                "model": "test-model",
                "messages": [{"role": "user", "content": "继续追问"}],
                "session_id": self.SESSION_ID,
            }
            base.update(payload)
            return self.client.post("/api/models/chat", json=base)

    def test_nonstream_writes_state_under_request_account(self):
        _register_account("alice")
        resp = self._post_chat(
            {"stream": False, "account_id": "alice"},
            httpx.Response(200, json={"choices": [{"message": {"content": _SOCRATIC_CONTENT}}]}),
        )
        self.assertEqual(resp.status_code, 200)
        alice_keys = _kv_keys("alice")
        state = alice_keys.get(f"socratic:{self.SESSION_ID}")
        self.assertIsInstance(state, dict, f"alice 域必须写到状态：{list(alice_keys)}")
        self.assertTrue(state.get("active"))
        self.assertEqual(state.get("correctStreak"), 1)
        default_keys = _kv_keys("default")
        self.assertFalse(
            [k for k in default_keys if k.startswith("socratic:")],
            f"default 域不得出现串写：{list(default_keys)}",
        )

    def test_streaming_writes_state_under_request_account(self):
        _register_account("alice")
        frame = json.dumps({"choices": [{"delta": {"content": _SOCRATIC_CONTENT}}]})
        body = f"data: {frame}\n\ndata: [DONE]\n\n".encode("utf-8")
        resp = self._post_chat(
            {"stream": True, "account_id": "alice"},
            httpx.Response(200, content=body),
        )
        self.assertEqual(resp.status_code, 200)
        alice_keys = _kv_keys("alice")
        self.assertIn(f"socratic:{self.SESSION_ID}", alice_keys)
        default_keys = _kv_keys("default")
        self.assertFalse([k for k in default_keys if k.startswith("socratic:")])
