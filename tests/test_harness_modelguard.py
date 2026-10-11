"""T98（harness 模型目标域名守卫）+ T97（Φ 推理档位）回归。

两条评审路线（docs/Φ智能体成熟度评审与改进路线-2026-09-30.md）的落点：
- T98：_resolve_model 与主应用同口径调 validate_model_target（唯一实现已下沉
  llm_common），env 兜底密钥（含 deepseek 末位回退）不得发往非官方域名；
- T97：thinking 档位经 model dict 透传到 _call_model，按相位给默认档，上游
  400 整请求拒收时剥参降级重发（非流式与流式两条路径）。
"""

import asyncio
import copy
import os
import sys
import unittest.mock

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server import llm_common
from harness import api as api_mod
from harness import review as review_mod
from harness.review import PHASE_THINKING, HarnessError


# ====== T98：_resolve_model 的模型目标校验 ======


class ResolveModelTargetGuardTest(unittest.TestCase):
    """env 兜底密钥只许发官方域名；显式密钥/本地地址照常放行。"""

    def test_env_fallback_key_rejected_for_foreign_domain(self):
        # provider=openai 但没填密钥：resolve_api_key 末位回退 DEEPSEEK_API_KEY，
        # 该 key 是 env 密钥，绝不允许发往任意 https 域名（T98 修的真漏洞）
        with unittest.mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env-secret"}):
            with self.assertRaises(HarnessError) as ctx:
                review_mod._resolve_model({
                    "provider": "openai",
                    "model": "gpt-x",
                    "base_url": "https://evil.example.com/v1",
                })
        self.assertIn("Env fallback", str(ctx.exception))

    def test_opencode_go_last_resort_key_locked_to_official(self):
        # opencode-go 的 env 兜底也没有时末位退 DEEPSEEK_API_KEY——同一把 env
        # 密钥，同样不许发往第三方域名（含本机 http 地址）
        env = {"DEEPSEEK_API_KEY": "sk-env-secret"}
        with unittest.mock.patch.dict(os.environ, env, clear=False):
            os.environ.pop("OPENCODE_GO_API_KEY", None)
            os.environ.pop("OPENCODE_API_KEY", None)
            for base_url in ("https://evil.example.com/v1", "http://127.0.0.1:9999/v1"):
                with self.assertRaises(HarnessError):
                    review_mod._resolve_model({
                        "provider": "opencode-go", "model": "m", "base_url": base_url,
                    })

    def test_explicit_key_allows_foreign_https_domain(self):
        resolved = review_mod._resolve_model({
            "provider": "openai", "model": "gpt-x",
            "base_url": "https://my-gateway.example.com/v1", "api_key": "sk-user",
        })
        self.assertEqual(resolved["base_url"], "https://my-gateway.example.com/v1")

    def test_local_http_address_allowed_with_explicit_key(self):
        # scripts/verify_phi_sessions.mjs 的 mock 上游形态：显式 apiKey + 127.0.0.1
        resolved = review_mod._resolve_model({
            "provider": "custom", "model": "mock",
            "base_url": "http://127.0.0.1:9999/v1", "api_key": "mock",
        })
        self.assertEqual(resolved["base_url"], "http://127.0.0.1:9999/v1")

    def test_foreign_http_remote_rejected(self):
        with self.assertRaises(HarnessError):
            review_mod._resolve_model({
                "provider": "custom", "model": "m",
                "base_url": "http://example.com/v1", "api_key": "k",
            })

    def test_empty_base_url_backfills_official(self):
        resolved = review_mod._resolve_model({"provider": "deepseek", "model": "deepseek-chat"})
        self.assertEqual(resolved["base_url"], llm_common.PROVIDER_BASE_URLS["deepseek"])
        self.assertEqual(resolved["thinking"], "")


class ResolveApiKeyLastResortTest(unittest.TestCase):
    """resolve_api_key 末位回退的 env_key_used 语义（安全收紧，T98）。"""

    def test_last_resort_flags_env_key(self):
        with unittest.mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env"}):
            key, used = llm_common.resolve_api_key(
                "openai", "", "", wide_go=True, deepseek_last_resort=True)
        self.assertEqual(key, "sk-env")
        self.assertTrue(used)

    def test_last_resort_empty_env_not_flagged(self):
        with unittest.mock.patch.dict(os.environ, {}, clear=True):
            key, used = llm_common.resolve_api_key(
                "openai", "", "", wide_go=True, deepseek_last_resort=True)
        self.assertEqual(key, "")
        self.assertFalse(used)


# ====== T97：档位映射（llm_common 层）======


class ThinkingRequestParamsSharedTest(unittest.TestCase):
    """映射函数唯一实现在 llm_common（main.py 只留同名薄包装）。"""

    def test_reasoning_effort_stretch(self):
        f = llm_common.thinking_request_params
        self.assertEqual(f("openai", "low"), {"reasoning_effort": "low"})
        self.assertEqual(f("openai", "high"), {"reasoning_effort": "medium"})
        self.assertEqual(f("deepseek", "max"), {"reasoning_effort": "high"})
        self.assertEqual(f("custom-gw", "high"), {"reasoning_effort": "medium"})

    def test_boolean_switch_on_off(self):
        # 布尔开关族：on/off 正式两档（2026-10-11 配置界面改开/关），low/high/max 兼容＝开
        f = llm_common.thinking_request_params
        self.assertEqual(f("qwen", "on"), {"enable_thinking": True})
        self.assertEqual(f("qwen", "off"), {"enable_thinking": False})
        self.assertEqual(f("zhipu", "on"), {"thinking": {"type": "enabled"}})
        self.assertEqual(f("zhipu", "off"), {"thinking": {"type": "disabled"}})
        self.assertEqual(f("mimo", "on"), {"thinking": {"type": "enabled"}})
        self.assertEqual(f("mimo", "off"), {"thinking": {"type": "disabled"}})
        self.assertEqual(f("ollama", "on"), {"think": True})
        self.assertEqual(f("ollama", "off"), {"think": False})

    def test_default_and_unknown_send_nothing(self):
        f = llm_common.thinking_request_params
        for level in ("", "default", "medium", "turbo"):
            for provider in ("deepseek", "qwen", "zhipu", "ollama", "openai", ""):
                self.assertEqual(f(provider, level), {})
        # 'off' 只在布尔开关族发关闭参数；reasoning_effort 族表达不了「关」→ 不发
        for provider in ("deepseek", "openai", "custom-gw", ""):
            self.assertEqual(f(provider, "off"), {})


# ====== T97：_call_model 的注入与 400 剥参降级 ======


class _FakeResponse:
    def __init__(self, status_code, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text

    def json(self):
        return self._payload


class _FakeStreamResponse:
    def __init__(self, status_code, body_text="", lines=None):
        self.status_code = status_code
        self._body = body_text.encode("utf-8")
        self._lines = list(lines or [])
        self.headers = {"content-type": "text/event-stream"}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def aread(self):
        return self._body

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeClient:
    """记录每次请求体（深拷贝——_call_model 会在重发前原地剥参）。"""

    def __init__(self, responses):
        self.requests = []
        self._responses = list(responses)

    async def post(self, url, json=None, headers=None, timeout=None):
        self.requests.append({"url": url, "body": copy.deepcopy(json)})
        return self._responses.pop(0)

    def stream(self, method, url, json=None, headers=None, timeout=None):
        self.requests.append({"url": url, "body": copy.deepcopy(json)})
        return self._responses.pop(0)


def _ok_payload(content="ok"):
    return {"choices": [{"message": {"content": content}}]}


def _openai_model(thinking=""):
    return {
        "provider": "openai", "model": "gpt-x",
        "base_url": "https://api.openai.com/v1", "api_key": "sk-user",
        "thinking": thinking,
    }


def test_call_model_injects_thinking_params(monkeypatch):
    fake = _FakeClient([_FakeResponse(200, _ok_payload())])
    monkeypatch.setattr(review_mod, "get_http_client", lambda: fake)
    raw = asyncio.run(review_mod._call_model(
        [{"role": "user", "content": "hi"}], _openai_model("high"), 100))
    assert fake.requests[0]["body"]["reasoning_effort"] == "medium"  # high → medium 拉伸
    assert raw["content"] == "ok"


def test_call_model_without_thinking_sends_no_param(monkeypatch):
    fake = _FakeClient([_FakeResponse(200, _ok_payload())])
    monkeypatch.setattr(review_mod, "get_http_client", lambda: fake)
    asyncio.run(review_mod._call_model(
        [{"role": "user", "content": "hi"}], _openai_model(""), 100))
    assert "reasoning_effort" not in fake.requests[0]["body"]
    assert len(fake.requests) == 1


def test_call_model_strips_thinking_on_400(monkeypatch):
    fake = _FakeClient([
        _FakeResponse(400, text="Unrecognized request argument"),
        _FakeResponse(200, _ok_payload("recovered")),
    ])
    monkeypatch.setattr(review_mod, "get_http_client", lambda: fake)
    raw = asyncio.run(review_mod._call_model(
        [{"role": "user", "content": "hi"}], _openai_model("high"), 100))
    assert len(fake.requests) == 2
    assert "reasoning_effort" in fake.requests[0]["body"]
    assert "reasoning_effort" not in fake.requests[1]["body"]
    assert raw["content"] == "recovered"


def test_call_model_stream_strips_stream_options_then_thinking(monkeypatch):
    sse = [
        'data: {"choices":[{"delta":{"content":"he"}}]}',
        'data: {"choices":[{"delta":{"content":"llo"}}]}',
        "data: [DONE]",
    ]
    fake = _FakeClient([
        _FakeStreamResponse(400, body_text="bad stream_options"),
        _FakeStreamResponse(400, body_text="bad reasoning_effort"),
        _FakeStreamResponse(200, lines=sse),
    ])
    monkeypatch.setattr(review_mod, "get_http_client", lambda: fake)
    deltas = []
    raw = asyncio.run(review_mod._call_model(
        [{"role": "user", "content": "hi"}], _openai_model("high"), 100,
        on_delta=deltas.append))
    assert len(fake.requests) == 3
    assert "stream_options" in fake.requests[0]["body"]
    assert "reasoning_effort" in fake.requests[0]["body"]
    assert "stream_options" not in fake.requests[1]["body"]  # 第一级：只剥计量帧
    assert "reasoning_effort" in fake.requests[1]["body"]
    assert "reasoning_effort" not in fake.requests[2]["body"]  # 第二级：再剥思考参数
    assert raw["content"] == "hello"
    assert deltas == ["he", "llo"]


# ====== T97：相位默认档（review_graph 装配）======


def _run_phase(monkeypatch, phase, instruction, thinking_kwarg=None, model_thinking=None):
    captured = {}

    async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None,
                        json_mode=False):
        captured["model"] = dict(model)
        return {"content": '{"summary": "已处理", "operations": []}', "tool_calls": []}

    monkeypatch.setattr(review_mod, "_call_model", fake_call)
    model = {"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""}
    if model_thinking is not None:
        model["thinking"] = model_thinking
    kwargs = {"thinking": thinking_kwarg} if thinking_kwarg is not None else {}
    asyncio.run(review_mod.review_graph(
        {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
        instruction,
        model=model, mode="json", self_check="off", retries=0, phase=phase,
        **kwargs))
    return captured["model"]


@pytest.mark.parametrize("phase,instruction,expected", [
    ("evaluate", "评价一下这张图", PHASE_THINKING["evaluate"]),
    ("apply", "应用建议", PHASE_THINKING["apply"]),
    ("preset", "做一个新配方试试", PHASE_THINKING["preset"]),
    ("chat", "这个公式是什么意思", PHASE_THINKING["chat"]),
    ("normal", "讲讲这个概念", ""),          # normal/expand 无默认＝不发参数
])
def test_phase_default_thinking(monkeypatch, phase, instruction, expected):
    model = _run_phase(monkeypatch, phase, instruction)
    assert model["thinking"] == expected


def test_explicit_thinking_overrides_phase_default(monkeypatch):
    model = _run_phase(monkeypatch, "evaluate", "评价一下这张图", thinking_kwarg="low")
    assert model["thinking"] == "low"


def test_model_entry_thinking_beats_phase_default(monkeypatch):
    model = _run_phase(monkeypatch, "chat", "这个公式是什么意思", model_thinking="max")
    assert model["thinking"] == "max"


def test_expand_phase_has_no_default(monkeypatch):
    # expand 相位不在 PHASE_THINKING 表里（改图主路径零延迟变化）
    assert "expand" not in PHASE_THINKING
    assert "normal" not in PHASE_THINKING


# ====== T97：api 层入参装配 ======


def test_review_kwargs_passes_thinking():
    assert api_mod._review_kwargs({"thinking": "high"}, "")["thinking"] == "high"
    assert api_mod._review_kwargs({}, "")["thinking"] == ""
