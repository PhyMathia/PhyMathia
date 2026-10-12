"""fix-formula 公式修复小路由契约（2026-10-12）。

核心契约：上下文最小化——请求体只有 latex＋error＋槽位四件（描述槽/主模型由前端
解析传入，同知识提取的 descriptor 口径），不带任何节点/对话/上游内容；模型输出剥
思考块/代码围栏/包裹定界符后原样返回，渲染性由前端本地 KaTeX 验证（后端不重复）。
出网口打 server.http_client 单点补丁（T163 拍板的测试口径）。
"""
import asyncio
import json
from unittest import mock

import pytest
from fastapi import HTTPException

from server import models_routes


class _FakeFixResponse:
    def __init__(self, payload):
        self._payload = payload
        self.status_code = 200

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class _FakeFixClient:
    """http_client 桩：记录请求并返回固定补全响应（同 test_server 的 describe 桩形状）。"""

    def __init__(self, payload):
        self._payload = payload
        self.calls = []

    async def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return _FakeFixResponse(self._payload)


class _FakeRequest:
    """最小 Request 桩：_parse_json_object 读 body()，_account_id 读 query_params。"""

    def __init__(self, payload):
        self._body = json.dumps(payload).encode("utf-8")
        self.query_params = {}
        self.headers = {}

    async def body(self):
        return self._body


def _payload(**over):
    base = {
        "latex": "f'(x_0)&gt;0",
        "error": "KaTeX parse error: Expected 'EOF', got '&' at position 8",
        "provider": "deepseek",
        "api_key": "key",
        "model": "test-model",
        "base_url": "https://api.example.com",
    }
    base.update(over)
    return base


def test_fix_formula_returns_stripped_latex_and_minimal_context():
    payload = {"choices": [{"message": {"content": "```latex\nf'(x_0)>0\n```"}}]}
    fake = _FakeFixClient(payload)
    with mock.patch.object(models_routes.http_client, "get_http_client", return_value=fake):
        result = asyncio.run(models_routes.api_fix_formula(_FakeRequest(_payload())))
    assert result == {"latex": "f'(x_0)>0"}
    # 上下文最小化：一次调用、两条消息（系统提示词＋公式/报错），无任何对话历史
    assert len(fake.calls) == 1
    msgs = fake.calls[0]["json"]["messages"]
    assert len(msgs) == 2
    assert msgs[0]["role"] == "system" and "LaTeX" in msgs[0]["content"]
    assert "f'(x_0)&gt;0" in msgs[1]["content"]
    assert "Expected 'EOF', got '&'" in msgs[1]["content"]
    assert fake.calls[0]["json"]["stream"] is False


def test_fix_formula_requires_latex():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(models_routes.api_fix_formula(_FakeRequest(_payload(latex=""))))
    assert ei.value.status_code == 400


def test_fix_formula_without_model_returns_409():
    with pytest.raises(HTTPException) as ei:
        asyncio.run(models_routes.api_fix_formula(_FakeRequest(_payload(model="", api_key=""))))
    assert ei.value.status_code == 409


def test_fix_formula_upstream_error_returns_502():
    class _BoomClient:
        async def post(self, url, json=None, headers=None):
            raise models_routes.httpx.ConnectError("boom")

    with mock.patch.object(models_routes.http_client, "get_http_client", return_value=_BoomClient()):
        with pytest.raises(HTTPException) as ei:
            asyncio.run(models_routes.api_fix_formula(_FakeRequest(_payload())))
    assert ei.value.status_code == 502


def test_strip_fix_formula_reply_variants():
    f = models_routes._strip_fix_formula_reply
    assert f("f'(x_0)>0") == "f'(x_0)>0"
    assert f("```latex\na \\& b\n```") == "a \\& b"
    assert f("$$x^2$$") == "x^2"
    assert f("\\(x^2\\)") == "x^2"
    assert f("<think>推理过程</think>\ny=z^2") == "y=z^2"
    assert f("   ") == ""
    # 语义保护：正文里的合法命令与花括号不动
    assert f("\\frac{1}{2}") == "\\frac{1}{2}"
