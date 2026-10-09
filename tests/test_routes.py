"""Route-level tests for src/main.py (P0 安全修复验收).

覆盖三类请求级缺陷（纯函数层测试覆盖不到）：
1. 会话 id 路径穿越（Windows 反斜杠）→ 必须返回 400 而非读/写 data 外文件
2. 损坏数据文件（GBK 字节）→ 相关 API 优雅降级而非 500
3. SSRF 外发链：provider=deepseek（触发 .env 兜底 key）+ 任意 base_url → 403

运行前会把 main/storage 两个模块命名空间里的数据路径指向临时目录，
避免污染真实 data/。
"""

import json
import time
import os
import sys
import tempfile
import unittest

import httpx
from pathlib import Path
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import accounts as accounts_mod  # noqa: E402
from server import http_client as http_client_mod  # noqa: E402  出网口补丁单点（T163）
from server import models_routes as models_routes_mod  # noqa: E402  _log_cache_hit_rate 属主
from server import usage_stats as usage_stats_mod  # noqa: E402  record_usage 属主
from server import knowledge as knowledge_mod  # noqa: E402  _describe_formulas 属主
from server import backup as backup_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


_MISSING = object()


def _patched_paths(td):
    """多账号 P1 夹具：patch config.DATA_DIR 一处（accounts.resolve_paths 调用期
    读取它），路径值改为账号域布局下的真实路径（data/users/default/…），保证
    「夹具写入的目标」与「路由经 resolve_paths 读到的目标」是同一份文件。
    返回的 main/storage/backup/profile 常量补丁只是兼容既有夹具写法——路由
    本体已不读这些常量。本函数必须无副作用（setUp 靠先后顺序捕获原值）。"""
    td = Path(td)
    root = td / "users" / "default"
    return {
        "DATA_DIR": td,
        "MESSAGES_DIR": root / "messages",
        "SESSIONS_PATH": root / "sessions.json",
        "KNOWLEDGE_PATH": root / "knowledge.json",
        "FORMULAS_PATH": root / "formulas.json",
        "KV_PATH": root / "kv_store.json",
        "KV_DIR": root / "kv",
        "PROFILES_DIR": td / "profiles",
    }


class RouteTestBase(unittest.TestCase):
    """把数据路径重定向到临时目录，测试后恢复。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        paths = _patched_paths(self._td.name)
        accounts_mod._ENSURED.clear()
        paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
        # 画像写入走 storage 的临时文件落盘，父目录必须先存在
        paths["PROFILES_DIR"].mkdir(parents=True, exist_ok=True)
        # backup/profile 模块是 from-import，命名空间里有自己的路径引用，需一并补丁
        self._orig_extra = {}
        for mod in (backup_mod, profile_mod):
            for name, value in paths.items():
                self._orig_extra[(id(mod), name)] = getattr(mod, name, _MISSING)
                setattr(mod, name, value)
        self._orig = {}
        for mod in (main_mod, storage_mod):
            for name, value in paths.items():
                self._orig[(id(mod), name)] = getattr(mod, name, None)
                setattr(mod, name, value)
        self._orig_config = {}
        for name, value in paths.items():
            self._orig_config[name] = getattr(config_mod, name, None)
            setattr(config_mod, name, value)
        storage_mod._JSON_READ_CACHE.clear()
        self.client = TestClient(main_mod.app)

    def tearDown(self):
        for mod in (backup_mod, profile_mod):
            for (mid, name), value in self._orig_extra.items():
                if id(mod) == mid:
                    if value is _MISSING:
                        if hasattr(mod, name):
                            delattr(mod, name)
                    else:
                        setattr(mod, name, value)
        for mod in (main_mod, storage_mod):
            for (mid, name), value in self._orig.items():
                if id(mod) == mid:
                    setattr(mod, name, value)
        for name, value in self._orig_config.items():
            setattr(config_mod, name, value)
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()


class PathTraversalTest(RouteTestBase):
    def test_backslash_traversal_get_messages_returns_400(self):
        # ..%5C 解码为反斜杠：Windows 下可穿越到 data/ 之外
        resp = self.client.get("/api/sessions/..%5C..%5Csecret/messages")
        self.assertIn(resp.status_code, (400, 404))
        self.assertNotEqual(resp.status_code, 500)
        self.assertFalse((Path(self._td.name).parent / "secret.json").exists())

    def test_backslash_traversal_delete_session_returns_400(self):
        resp = self.client.delete("/api/sessions/..%5C..%5Csecret")
        self.assertIn(resp.status_code, (400, 404))
        self.assertFalse((Path(self._td.name).parent / "secret.json").exists())

    def test_backslash_traversal_post_messages_returns_400(self):
        resp = self.client.post(
            "/api/sessions/..%5C..%5Csecret/messages",
            json={"messages": []},
        )
        self.assertIn(resp.status_code, (400, 404))

    def test_valid_session_id_still_works(self):
        resp = self.client.get("/api/sessions/sess_abc123/messages")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])


class CorruptFileTest(RouteTestBase):
    def test_gbk_messages_file_degrades_gracefully(self):
        # 模拟外部程序以 GBK 写入损坏字节：此前 UnicodeDecodeError 会穿透为 500
        target = Path(self._td.name) / "users" / "default" / "messages" / "sess_corrupt.json"
        target.write_bytes(b'{"k": "\xd6\xd0\xce\xc4"}')  # GBK "中文"
        resp = self.client.get("/api/sessions/sess_corrupt/messages")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), [])

    def test_gbk_sessions_file_degrades_gracefully(self):
        main_mod.SESSIONS_PATH.write_bytes(b'{"k": "\xd6\xd0\xce\xc4"}')
        resp = self.client.get("/api/sessions")
        self.assertEqual(resp.status_code, 200)


class ModelTargetValidationTest(RouteTestBase):
    def _deepseek_env_key_active(self):
        return bool(os.getenv("DEEPSEEK_API_KEY"))

    def test_env_key_with_foreign_base_url_rejected(self):
        # .env 存在 DEEPSEEK_API_KEY 时：provider=deepseek 触发兜底注入，
        # 携带该 key 发往任意域名必须被 403 拦截（密钥外发链）
        if not self._deepseek_env_key_active():
            self.skipTest("DEEPSEEK_API_KEY not set; env-fallback path inactive")
        resp = self.client.post(
            "/api/models/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "provider": "deepseek",
                "base_url": "https://attacker.example.com",
                "model": "deepseek-chat",
            },
        )
        self.assertEqual(resp.status_code, 403)

    def test_remote_http_base_url_rejected(self):
        resp = self.client.post(
            "/api/models/chat",
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "provider": "deepseek",
                "api_key": "sk-user-supplied",
                "base_url": "http://attacker.example.com",
                "model": "deepseek-chat",
            },
        )
        self.assertEqual(resp.status_code, 403)


class ModelsListEndpointTest(RouteTestBase):
    """添加模型弹窗「获取模型列表」的后端代理契约（不触网：上游交互走 mock）。"""

    def test_unknown_provider_without_base_url_returns_400(self):
        resp = self.client.post("/api/models/list", json={"provider": "no-such-provider"})
        self.assertEqual(resp.status_code, 400)

    def test_remote_http_base_url_rejected(self):
        # 与 /api/models/chat 同一把 SSRF 尺子：远端必须 https
        resp = self.client.post(
            "/api/models/list",
            json={"provider": "custom", "api_key": "sk-x", "base_url": "http://attacker.example.com"},
        )
        self.assertEqual(resp.status_code, 403)

    def test_local_http_allowed_and_models_parsed(self):
        # 本机 http 端点放行；OpenAI 兼容 {data:[{id}]} 与裸数组两种形态都解析成排序去重的 id 列表
        def fake_get(url, headers=None, timeout=None):
            class R:
                status_code = 200

                def json(self):
                    return {"data": [{"id": "b-model"}, {"id": "a-model"}, {"id": "a-model"}, {"id": "c"}]}

            return R()

        with mock.patch.object(http_client_mod.get_http_client(), "get", side_effect=fake_get):
            resp = self.client.post(
                "/api/models/list",
                json={"provider": "ollama", "api_key": "", "base_url": "http://localhost:11434/v1"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"models": ["a-model", "b-model", "c"], "meta": {}})

    def test_bare_array_response_parsed(self):
        def fake_get(url, headers=None, timeout=None):
            class R:
                status_code = 200

                def json(self):
                    return [{"id": "z"}, {"id": "a"}]

            return R()

        with mock.patch.object(http_client_mod.get_http_client(), "get", side_effect=fake_get):
            resp = self.client.post(
                "/api/models/list",
                json={"provider": "lmstudio", "api_key": "", "base_url": "http://localhost:1234/v1"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"models": ["a", "z"], "meta": {}})

    def test_opencode_gateway_list_sends_no_bearer(self):
        # opencode 网关（zen 免费与 zen/go）的 /models 清单公开可读，反而带无效
        # Bearer 会 401 Invalid credential——2026-09-25 真机定位后清单请求一律不附带密钥
        captured = {}

        def fake_get(url, headers=None, timeout=None):
            captured["url"] = url
            captured["headers"] = headers

            class R:
                status_code = 200

                def json(self):
                    return {"data": [{"id": "glm-5.3"}]}

            return R()

        with mock.patch.object(http_client_mod.get_http_client(), "get", side_effect=fake_get):
            resp = self.client.post(
                "/api/models/list",
                json={"provider": "opencode-go", "api_key": "sk-stale", "base_url": "https://opencode.ai/zen/go/v1"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("Authorization", captured["headers"])

    def test_other_providers_list_carries_bearer(self):
        # 非 opencode 网关（如 DeepSeek）清单需要认证：密钥必须随请求发出
        captured = {}

        def fake_get(url, headers=None, timeout=None):
            captured["headers"] = headers

            class R:
                status_code = 200

                def json(self):
                    return {"data": [{"id": "deepseek-chat"}]}

            return R()

        with mock.patch.object(http_client_mod.get_http_client(), "get", side_effect=fake_get):
            resp = self.client.post(
                "/api/models/list",
                json={"provider": "deepseek", "api_key": "sk-ds-live", "base_url": "https://api.deepseek.com"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(captured["headers"].get("Authorization"), "Bearer sk-ds-live")


class ThinkingRequestParamsUnitTest(unittest.TestCase):
    """思考程度 → 请求参数映射的纯函数用例（不触网）。"""

    def test_default_and_unknown_sends_nothing(self):
        # ''/default = 跟随模型默认：现状行为零变化；旧值与乱值一律不发参数
        for level in ("", "default", "off", "medium", "turbo"):
            for provider in ("deepseek", "qwen", "zhipu", "openai", ""):
                self.assertEqual(main_mod._thinking_request_params(provider, level), {})

    def test_reasoning_effort_stretches_three_tiers(self):
        # low/high/max 按序拉伸到 reasoning_effort 的 low/medium/high 三档，
        # 每个 reasoning_effort 供应商（含自定义网关）上三档都有区分度
        f = main_mod._thinking_request_params
        self.assertEqual(f("openai", "low"), {"reasoning_effort": "low"})
        self.assertEqual(f("openai", "high"), {"reasoning_effort": "medium"})
        self.assertEqual(f("openai", "max"), {"reasoning_effort": "high"})
        self.assertEqual(f("deepseek", "low"), {"reasoning_effort": "low"})
        self.assertEqual(f("custom-gw", "max"), {"reasoning_effort": "high"})

    def test_qwen_zhipu_ollama_boolean_switch(self):
        # 布尔开关族只有开/关：low/high/max 三档同为「开启」
        f = main_mod._thinking_request_params
        self.assertEqual(f("qwen", "low"), {"enable_thinking": True})
        self.assertEqual(f("qwen", "max"), {"enable_thinking": True})
        self.assertEqual(f("zhipu", "high"), {"thinking": {"type": "enabled"}})
        self.assertEqual(f("ollama", "max"), {"think": True})


class ThinkingEffortProxyTest(RouteTestBase):
    """/api/models/chat 的思考参数注入与 400 降级重试（上游交互走 MockTransport）。"""

    def _post_chat(self, thinking_value, reject_first=False):
        captured = []

        def handler(request: httpx.Request) -> httpx.Response:
            captured.append(json.loads(request.content))
            if len(captured) == 1 and reject_first:
                return httpx.Response(400, json={"error": {"message": "Unrecognized request argument"}})
            return httpx.Response(200, json={"choices": [{"message": {"content": "pong"}}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client):
            resp = self.client.post(
                "/api/models/chat",
                json={
                    "messages": [{"role": "user", "content": "hi"}],
                    "provider": "deepseek",
                    "api_key": "sk-test",
                    "base_url": "https://api.deepseek.com",
                    "model": "deepseek-chat",
                    "stream": False,
                    "thinking": thinking_value,
                },
            )
        return resp, captured

    def test_thinking_param_reaches_upstream(self):
        resp, captured = self._post_chat("max")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0].get("reasoning_effort"), "high")  # max → 拉伸映射最高档

    def test_empty_thinking_sends_no_extra_param(self):
        resp, captured = self._post_chat("")
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn("reasoning_effort", captured[0])
        self.assertNotIn("thinking", captured[0])
        self.assertNotIn("enable_thinking", captured[0])

    def test_rejected_thinking_param_retries_without_it(self):
        # 降级安全网：上游不认识思考参数整请求 400 时，剥掉重发一次，聊天不坏
        resp, captured = self._post_chat("low", reject_first=True)
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(captured), 2)
        self.assertEqual(captured[0].get("reasoning_effort"), "low")
        self.assertNotIn("reasoning_effort", captured[1])
        self.assertEqual(captured[1]["messages"], captured[0]["messages"])  # 其余请求体不变


class NonStreamUsagePassthroughTest(RouteTestBase):
    """非流式透传出口的 usage 记账（T149）：上游 200＋usage 齐全但 content
    缺失（推理型模型烧光 max_tokens 必现）时，早退分支不得漏掉
    record_usage/_log_cache_hit_rate——记账与有 content 路径同口径，
    正文原样透传不变。"""

    def _post_chat(self, handler):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client), \
             mock.patch.object(usage_stats_mod, "record_usage") as record, \
             mock.patch.object(usage_stats_mod, "record_failure") as fail_record, \
             mock.patch.object(models_routes_mod, "_log_cache_hit_rate") as hit_rate:
            resp = self.client.post("/api/models/chat", json={
                "messages": [{"role": "user", "content": "hi"}],
                "provider": "deepseek",
                "api_key": "sk-test",
                "base_url": "https://api.deepseek.com",
                "model": "deepseek-chat",
                "stream": False,
                "session_id": "sess-t149",
            })
        return resp, record, hit_rate, fail_record

    def test_missing_content_still_records_usage(self):
        usage = {"prompt_tokens": 100, "completion_tokens": 0}
        resp, record, hit_rate, fail_record = self._post_chat(
            lambda request: httpx.Response(200, json={
                "choices": [{"message": {"reasoning_content": "token 烧光"}}],
                "usage": usage,
            }))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["choices"][0]["message"]["reasoning_content"], "token 烧光")
        record.assert_called_once_with("deepseek", "deepseek-chat", "legacy", "sess-t149", usage,
                                       duration_ms=mock.ANY)
        hit_rate.assert_called_once_with(usage)
        fail_record.assert_not_called()

    def test_content_path_records_usage_unchanged(self):
        # 有 content 路径口径不变：记账参数与缺 content 分支完全一致
        usage = {"prompt_tokens": 10, "completion_tokens": 2}
        resp, record, hit_rate, fail_record = self._post_chat(
            lambda request: httpx.Response(200, json={
                "choices": [{"message": {"content": "pong"}}], "usage": usage}))
        self.assertEqual(resp.status_code, 200)
        record.assert_called_once_with("deepseek", "deepseek-chat", "legacy", "sess-t149", usage,
                                       duration_ms=mock.ANY)
        hit_rate.assert_called_once_with(usage)
        fail_record.assert_not_called()

    def test_non_json_body_skips_usage(self):
        # 非 JSON 正文（网关错误页）：解析不出 usage 不记成功账，但失败进账（2026-10-08）
        resp, record, hit_rate, fail_record = self._post_chat(
            lambda request: httpx.Response(200, text="<html>bad gateway</html>"))
        self.assertEqual(resp.status_code, 200)
        record.assert_not_called()
        hit_rate.assert_not_called()
        fail_record.assert_called_once()
        call = fail_record.call_args
        self.assertEqual(call.args[2], "legacy")  # kind
        self.assertIn("非 JSON", call.args[4])    # error 原因


class LinearRetirementGateTest(RouteTestBase):
    """线性主聊天退役硬门禁（2026-09-25）：prompt 新格式只受理画布锚定请求。

    无锚普通 prompt 与 quick 寒暄一律 410；messages 直传旧格式（测验 / 知识 /
    大陆 / 可视化等辅助功能的通道）不受影响。带锚放行用例走 MockTransport
    截获上游，不触网。
    """

    def _post(self, payload):
        return self.client.post("/api/models/chat", json={
            "provider": "deepseek", "api_key": "sk-test",
            "model": "test-model", "stream": False, **payload})

    def _post_with_mock_upstream(self, payload):
        def handler(request):
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client):
            return self._post(payload)

    def test_anchorless_prompt_rejected(self):
        # 旧线性主聊天的直调通道：无 branch_id / graph_path / workflow_context
        resp = self._post({"prompt": "什么是电磁感应", "level": "university"})
        self.assertEqual(resp.status_code, 410)

    def test_quick_rejected_even_with_anchor(self):
        # 寒暄通道前端已无入口，带锚直调也拒绝，只防外部绕过
        resp = self._post({"prompt": "你好", "quick": True, "branch_id": "br-gate"})
        self.assertEqual(resp.status_code, 410)

    def test_branch_anchored_prompt_allowed(self):
        resp = self._post_with_mock_upstream(
            {"prompt": "再讲细一点", "branch_id": "br-gate", "session_id": "s-gate"})
        self.assertEqual(resp.status_code, 200)

    def test_graph_path_anchored_prompt_allowed(self):
        resp = self._post_with_mock_upstream({
            "prompt": "物理视角里磁通量怎么理解",
            "graph_path": [{"kind": "user", "timestamp": 1}],
            "session_id": "s-gate-tree",
        })
        self.assertEqual(resp.status_code, 200)

    def test_workflow_context_anchored_prompt_allowed(self):
        resp = self._post_with_mock_upstream({
            "prompt": "生成物理直觉模块",
            "workflow_context": {"mode": "analysis", "target": {"kind": "answer", "label": "AI 回答"}},
        })
        self.assertEqual(resp.status_code, 200)

    def test_messages_passthrough_unaffected(self):
        resp = self._post_with_mock_upstream(
            {"messages": [{"role": "user", "content": "hi"}]})
        self.assertEqual(resp.status_code, 200)


class ValidateModelTargetUnitTest(unittest.TestCase):
    """config.validate_model_target 的纯函数用例（不触网）。"""

    def test_empty_base_url_resolves_official(self):
        url = config_mod.validate_model_target("deepseek", "", False)
        self.assertEqual(url, "https://api.deepseek.com")

    def test_unknown_provider_without_base_url_raises(self):
        with self.assertRaises(ValueError):
            config_mod.validate_model_target("nope", "", False)

    def test_https_custom_endpoint_allowed_with_user_key(self):
        url = config_mod.validate_model_target(
            "custom", "https://my-gateway.example.com/v1", False
        )
        self.assertEqual(url, "https://my-gateway.example.com/v1")

    def test_local_http_allowed(self):
        for host in ("127.0.0.1", "localhost", "192.168.1.5", "10.0.0.2", "172.20.0.1"):
            url = config_mod.validate_model_target(
                "local", f"http://{host}:11434/v1", False
            )
            self.assertTrue(url.startswith(f"http://{host}"))

    def test_env_key_official_host_allowed(self):
        url = config_mod.validate_model_target(
            "deepseek", "https://api.deepseek.com", True
        )
        self.assertEqual(url, "https://api.deepseek.com")

    def test_env_key_foreign_host_rejected(self):
        with self.assertRaises(ValueError):
            config_mod.validate_model_target(
                "deepseek", "https://api.deepseek.com.evil.io", True
            )

    def test_non_http_scheme_rejected(self):
        with self.assertRaises(ValueError):
            config_mod.validate_model_target("custom", "file:///etc/passwd", False)
        with self.assertRaises(ValueError):
            config_mod.validate_model_target("custom", "ftp://x/y", False)


class GetMessagesPathUnitTest(unittest.TestCase):
    def test_valid_ids(self):
        for sid in ("sess_abc123", "session-2024", "phymathia_x"):
            p = storage_mod._get_messages_path(sid)
            self.assertEqual(p.name, f"{sid}.json")

    def test_traversal_ids_raise(self):
        for sid in (
            "..\\..\\secret",
            "../../secret",
            "..",
            "a/b",
            "a\\b",
            "sess x",  # 空格
            "sess:x",
            "",
        ):
            with self.assertRaises(ValueError, msg=sid):
                storage_mod._get_messages_path(sid)


class BackupRestoreRollbackTest(RouteTestBase):
    """备份恢复原子性：中途写失败必须整体回滚，不留半恢复状态。"""

    def _read_raw(self, path):
        p = Path(path)
        return json.loads(p.read_text(encoding="utf-8")) if p.exists() else None

    def test_failed_restore_rolls_back_all_sections(self):
        td = Path(self._td.name) / "users" / "default"   # 账号域数据根
        (Path(self._td.name) / "profiles").mkdir(exist_ok=True)
        # 导入前的现状
        storage_mod._write_json(td / "sessions.json", {
            "s1": {"id": "s1", "title": "旧会话", "createdAt": 1, "updatedAt": 1},
        })
        storage_mod._write_json(td / "messages" / "s1.json",
                                [{"role": "user", "content": "旧消息", "timestamp": 1}])
        payload = {
            "sessions": [{"id": "s2", "title": "新会话"}],
            "messages": {"s2": [{"role": "user", "content": "新消息", "timestamp": 2}]},
            "knowledge": {"k9": {"id": "k9", "title": "新知识"}},
            "profiles": {"dev9": {"enabled": True}},
        }
        # 注入故障：写 knowledge.json 时抛 OSError（模拟文件被占用）——
        # 此时 sessions 与 s2 消息文件已落盘，正是旧实现留半恢复状态的时点
        orig_write = backup_mod._write_json

        def failing_write(path, data):
            if Path(path).name == "knowledge.json":
                raise OSError("file locked")
            return orig_write(path, data)

        backup_mod._write_json = failing_write
        try:
            with self.assertRaises(RuntimeError) as ctx:
                backup_mod._restore_backup(payload, replace=False)
        finally:
            backup_mod._write_json = orig_write
        self.assertIn("回滚", str(ctx.exception))

        # sessions 回到导入前（s2 消失、s1 保留）
        sessions_now = self._read_raw(td / "sessions.json")
        self.assertIn("s1", sessions_now)
        self.assertNotIn("s2", sessions_now)
        # 新会话消息文件被回滚删除，旧会话消息原样保留
        self.assertFalse((td / "messages" / "s2.json").exists())
        self.assertEqual(self._read_raw(td / "messages" / "s1.json"),
                         [{"role": "user", "content": "旧消息", "timestamp": 1}])
        # knowledge 从未成功写入
        self.assertIsNone(self._read_raw(td / "knowledge.json"))

    def test_successful_restore_still_merges(self):
        td = Path(self._td.name) / "users" / "default"   # 账号域数据根
        (Path(self._td.name) / "profiles").mkdir(exist_ok=True)
        payload = {
            "sessions": [{"id": "s2", "title": "新会话"}],
            "messages": {"s2": [{"role": "user", "content": "hi", "timestamp": 2}]},
        }
        result = backup_mod._restore_backup(payload, replace=False)
        self.assertTrue(result["ok"])
        self.assertEqual(result["sessions"], 1)
        self.assertIn("s2", self._read_raw(td / "sessions.json"))
        self.assertTrue((td / "messages" / "s2.json").exists())


class KnowledgeIngestGateTest(RouteTestBase):
    """v4 入库闸门 + 提取闸门：非知识条目进不了库，推理泄漏不触发提取。

    浏览器会把 localStorage 里本地独有的知识点并集推回 /api/knowledge，所以「删掉
    又被推回来」是常态——入口拒收才是清得掉的保证（实测踩过）。手动条目豁免。
    """

    def test_ingest_rejects_instruction_echo_item(self):
        # 条目必须挂在活会话下：孤儿闸门（见 KnowledgeOrphanGateTest）会拒收死会话条目
        storage_mod._write_json(main_mod.SESSIONS_PATH,
                                {"sess_gate": {"id": "sess_gate", "title": "闸门"}})
        junk = {"id": "ki_junk", "sessionId": "sess_gate", "source": "ai_extract",
                "title": "用户要求：从方向导数最大值推导梯度在直角坐标下的分量表达式。这是一"}
        ok = {"id": "ki_ok", "sessionId": "sess_gate", "source": "ai_extract", "title": "梯度的定义与坐标表达"}
        resp = self.client.post("/api/knowledge", json={"items": {"ki_junk": junk, "ki_ok": ok}})
        self.assertEqual(resp.status_code, 200)
        data = self.client.get("/api/knowledge").json()
        self.assertIn("ki_ok", data)
        self.assertNotIn("ki_junk", data)

    def test_ingest_keeps_manual_item_even_with_odd_title(self):
        storage_mod._write_json(main_mod.SESSIONS_PATH,
                                {"sess_gate": {"id": "sess_gate", "title": "闸门"}})
        manual = {"id": "ki_manual", "sessionId": "sess_gate", "source": "manual",
                  "title": "用户要求：我自己写的笔记标题。保留它"}
        resp = self.client.post("/api/knowledge", json={"items": {"ki_manual": manual}})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("ki_manual", self.client.get("/api/knowledge").json())

    def test_steady_state_push_does_not_rewrite(self):
        # T202：前端定时同步反复全量推送 /api/knowledge，内容已收敛的稳态推送
        # 不再全库重写+全库去重（对照消息保存的短路）——二次同内容 POST 后
        # 库存文件 mtime 不动；内容真变化仍照常写盘。
        storage_mod._write_json(main_mod.SESSIONS_PATH,
                                {"sess_gate": {"id": "sess_gate", "title": "闸门"}})
        item = {"id": "ki_steady", "sessionId": "sess_gate", "source": "ai_extract",
                "title": "牛顿第二定律", "summary": "F=ma"}
        first = self.client.post("/api/knowledge", json={"items": {"ki_steady": item}})
        self.assertEqual(first.status_code, 200)
        kf = Path(main_mod.SESSIONS_PATH).parent / "knowledge.json"
        mtime1 = kf.stat().st_mtime_ns
        time.sleep(0.02)
        second = self.client.post("/api/knowledge", json={"items": {"ki_steady": item}})
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.json()["count"], 1)
        self.assertEqual(kf.stat().st_mtime_ns, mtime1)
        changed = self.client.post("/api/knowledge", json={
            "items": {"ki_steady": {**item, "summary": "F = m·a（更新摘要）"}}})
        self.assertEqual(changed.status_code, 200)
        self.assertGreater(kf.stat().st_mtime_ns, mtime1)

    def test_extract_skips_reasoning_leak_content(self):
        leak = ("用户要求：从方向导数最大值推导梯度在直角坐标与正交曲线坐标下的分量表达式。"
                "这是一个数学主题。当前分支类型是\"进阶学习\"，需要生成完整探索回答簇。"
                "注意上下文说\"必须只输出三行列表\"。公式用标签包裹，尽量少公式。")
        resp = self.client.post("/api/extract_knowledge", json={
            "sessionId": "sess_leak",
            "messages": [
                {"role": "user", "content": "请详细讲解：从方向导数最大值推导梯度"},
                {"role": "assistant", "content": leak},
            ],
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["items"], [])

    def test_extract_still_works_for_normal_answer(self):
        resp = self.client.post("/api/extract_knowledge", json={
            "sessionId": "sess_normal",
            "messages": [
                {"role": "user", "content": "解释简谐运动"},
                {"role": "assistant",
                 "content": "# 简谐运动\n回复力与位移成正比。<formula>F=-kx</formula>"},
            ],
        })
        self.assertEqual(resp.status_code, 200)
        items = resp.json()["items"]
        self.assertTrue(items)
        self.assertEqual(items[0]["title"], "简谐运动")


class ExtractKnowledgeEndpointTest(RouteTestBase):
    """P2 知识点摘要：/api/extract_knowledge 的描述模型链路回归。

    覆盖两类纯函数层测不到的端点级缺陷：
    1. 描述目标非法（SSRF 校验拒绝）时端点必须 200——曾经 _describe_formulas
       漏改 return {}，main.py 元组解包 ValueError → 整个端点 500；
    2. 无公式仅有知识点（descriptor-only 场景）也要发起 DESCRIBE 调用。
    """

    def _payload(self, **overrides):
        payload = {
            "sessionId": "sess_extract",
            "messages": [
                {"role": "user", "content": "解释简谐运动"},
                {"role": "assistant", "content": "# 简谐运动\n简谐运动是周期性振动。"},
            ],
        }
        payload.update(overrides)
        return payload

    def test_invalid_descriptor_base_url_returns_200_not_500(self):
        # 未配置主模型 → 本地提取兜底；内容含公式触发 DESCRIBE 调用，
        # 描述模型 base_url 未过 SSRF 校验时端点仍须 200（曾经
        # _describe_formulas 漏改 return {} → 元组解包 ValueError → 500）
        resp = self.client.post("/api/extract_knowledge", json=self._payload(
            messages=[
                {"role": "user", "content": "解释简谐运动"},
                {"role": "assistant",
                 "content": "# 简谐运动\n简谐运动是周期性振动。<formula>F=-kx</formula>"},
            ],
            descriptor_provider="deepseek",
            descriptor_api_key="k",
            descriptor_model="m",
            descriptor_base_url="http://evil.example.com",
        ))
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["descriptions"], {})
        self.assertEqual(data["summaries"], {})
        self.assertTrue(data["items"])

    def test_describe_fired_for_knowledge_without_formulas(self):
        # 无公式但有知识点：DESCRIBE 也要发起（summaries 是 local 条目升级
        # 为模型摘要的唯一通道）；mock 掉真实调用，断言调用参数与响应透传
        calls = {}

        async def fake_describe(summary, formulas, items, provider, api_key, model, base_url, level="university", env_key_used=False):
            calls["formulas"] = list(formulas)
            calls["titles"] = [it.get("title") for it in items]
            return {}, {"简谐运动": "回复力与位移成正比的周期性振动"}

        with mock.patch.object(knowledge_mod, "_describe_formulas", new=fake_describe):
            resp = self.client.post("/api/extract_knowledge", json=self._payload(
                descriptor_provider="deepseek",
                descriptor_api_key="k",
                descriptor_model="m",
                descriptor_base_url="https://api.example.com",
            ))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(calls.get("formulas"), [])
        self.assertTrue(calls.get("titles"))
        self.assertEqual(resp.json()["summaries"],
                         {"简谐运动": "回复力与位移成正比的周期性振动"})

    def test_describe_not_fired_when_nothing_to_extract(self):
        # 消息里没有可提取内容（assistant 空文本 → items 为空）时不发起调用
        called = {"n": 0}

        async def fake_describe(*args, **kwargs):
            called["n"] += 1
            return {}, {}

        with mock.patch.object(knowledge_mod, "_describe_formulas", new=fake_describe):
            resp = self.client.post("/api/extract_knowledge", json=self._payload(
                messages=[
                    {"role": "user", "content": "解释简谐运动"},
                    {"role": "assistant", "content": ""},
                ],
                descriptor_provider="deepseek",
                descriptor_api_key="k",
                descriptor_model="m",
                descriptor_base_url="https://api.example.com",
            ))
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(called["n"], 0)
        self.assertEqual(resp.json()["items"], [])

    def test_local_fallback_templates_summary_and_keeps_anchor(self):
        # P4：本地兜底条目的展示 summary 为模板文案（标题+首个公式含义+分类），
        # 不再是整卡摘要；锚点优先级——有 <summary> 用其原文落锚，无 <summary>
        # 保留本地提取的整卡摘要头（锚点绝不落到模板文案上，否则画布定位
        # 滑窗失配，且 P3 isLegacyCardSummaryItem 会把新条目误判为旧摘要）
        resp = self.client.post("/api/extract_knowledge", json=self._payload(
            messages=[
                {"role": "user", "content": "解释简谐运动"},
                {"role": "assistant",
                 "content": "# 简谐运动\n回复力让物体振动。<formula>F=-kx</formula>\n"
                            "<summary>甲卡整卡摘要</summary>"},
            ],
        ))
        self.assertEqual(resp.status_code, 200)
        it = resp.json()["items"][0]
        self.assertEqual(it["summarySource"], "local")
        self.assertEqual(
            it["summary"],
            "「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）")
        self.assertEqual(it["anchorSummary"], "甲卡整卡摘要")

        # 无 <summary>：锚点 = 本地提取的整卡摘要头（正文头 120 字），而非模板
        resp2 = self.client.post("/api/extract_knowledge", json=self._payload(
            messages=[
                {"role": "user", "content": "解释简谐运动"},
                {"role": "assistant",
                 "content": "# 简谐运动\n回复力让物体振动。<formula>F=-kx</formula>"},
            ],
        ))
        self.assertEqual(resp2.status_code, 200)
        it2 = resp2.json()["items"][0]
        self.assertIn("胡克定律", it2["summary"])
        self.assertNotEqual(it2["anchorSummary"], it2["summary"])
        self.assertIn("回复力让物体振动", it2["anchorSummary"])


class ProxyOpencodeSessionHeaderTest(RouteTestBase):
    """OpenCode 网关会话头（x-opencode-session）：同会话稳定注入 + 客户端 UA。

    OpenCode 要求/建议代理请求携带 x-opencode-session（网关按会话路由并优化
    prompt 缓存），并用可识别 User-Agent 标明客户端。用 MockTransport 截获
    代理实际发出的请求头做断言，不触网。
    """

    def _capture_upstream(self, provider, base_url, session_id=None):
        seen = {}

        def handler(request):
            seen["url"] = str(request.url)
            seen["headers"] = dict(request.headers)
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        async_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=async_client):
            payload = {
                "messages": [{"role": "user", "content": "hi"}],
                "provider": provider,
                "api_key": "sk-user-supplied",
                "base_url": base_url,
                "model": "test-model",
                "stream": False,
            }
            if session_id is not None:
                payload["session_id"] = session_id
            resp = self.client.post("/api/models/chat", json=payload)
        self.assertEqual(resp.status_code, 200)
        return seen

    def test_opencode_request_carries_session_and_ua(self):
        seen = self._capture_upstream(
            "opencode-go", "https://opencode.ai/zen/go/v1", "sess_abc123"
        )
        self.assertEqual(seen["headers"].get("x-opencode-session"), "sess_abc123")
        self.assertTrue(
            seen["headers"].get("user-agent", "").startswith("PhyMathia/"),
            f"UA 应标明客户端，实际 {seen['headers'].get('user-agent')}",
        )

    def test_opencode_without_session_falls_back_to_stable_id(self):
        seen = self._capture_upstream("opencode", "https://opencode.ai/zen/v1", None)
        self.assertEqual(seen["headers"].get("x-opencode-session"), "phymathia-anonymous")

    def test_non_opencode_target_has_no_session_header(self):
        seen = self._capture_upstream("deepseek", "https://api.deepseek.com", "sess_abc123")
        self.assertNotIn("x-opencode-session", seen["headers"])
        self.assertNotIn("User-Agent", seen["headers"])


class ContinentRouteTest(RouteTestBase):
    """大陆投影（大陆计划 v1）：GET /api/continent 只读端点。

    端点每次现算（knowledge + sessions → 投影），必须保持无写路径：
    请求前后数据文件字节一致，投影结果与纯函数口径一致。
    """

    def _seed(self):
        td = Path(self._td.name) / "users" / "default"   # 账号域数据根
        (td / "knowledge.json").write_text(json.dumps({
            "k1": {"id": "k1", "sessionId": "sess_a", "title": "阻尼振动",
                   "formulas": [], "category": "", "createdAt": 1},
            "k2": {"id": "k2", "sessionId": "sess_b", "title": "非线性振动",
                   "formulas": [], "category": "", "createdAt": 2},
        }, ensure_ascii=False), encoding="utf-8")
        (td / "sessions.json").write_text(json.dumps({
            "sess_a": {"id": "sess_a", "title": "波与振动", "updatedAt": 100},
            "sess_b": {"id": "sess_b", "title": "傅里叶", "updatedAt": 200},
        }, ensure_ascii=False), encoding="utf-8")
        storage_mod._JSON_READ_CACHE.clear()

    def test_continent_projection_shape(self):
        self._seed()
        resp = self.client.get("/api/continent")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["clusterCount"], 2)
        self.assertEqual(data["itemCount"], 2)
        # 簇按会话 updatedAt 降序：傅里叶(200) → 波与振动(100)
        self.assertEqual([c["sessionId"] for c in data["clusters"]], ["sess_b", "sess_a"])
        # 跨会话共享词面「振动」被检出
        self.assertTrue(any(s["kind"] == "title" and s["label"] == "振动"
                            for s in data["shared"]))

    def test_continent_endpoint_is_readonly(self):
        self._seed()
        td = Path(self._td.name) / "users" / "default"   # 账号域数据根
        before = ((td / "knowledge.json").read_bytes(),
                  (td / "sessions.json").read_bytes())
        resp = self.client.get("/api/continent")
        self.assertEqual(resp.status_code, 200)
        after = ((td / "knowledge.json").read_bytes(),
                 (td / "sessions.json").read_bytes())
        self.assertEqual(before, after, "只读端点不得改动数据文件")

    def test_continent_merges_user_edges_from_kv(self):
        # v2：KV continent_edges 里的用户簇间边按当前投影校验后随响应下发
        self._seed()
        td = Path(self._td.name) / "users" / "default"   # 账号域数据根
        (td / "kv_store.json").write_text(json.dumps({
            "continent_edges": {"edges": [
                {"id": "e1", "fromItem": "k1", "toItem": "k2",
                 "fromSession": "sess_a", "toSession": "sess_b",
                 "label": "同为振动", "createdAt": 9},
                {"id": "e2", "fromItem": "k1", "toItem": "k_gone", "createdAt": 8},
            ]},
        }, ensure_ascii=False), encoding="utf-8")
        storage_mod._JSON_READ_CACHE.clear()
        resp = self.client.get("/api/continent")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(len(data["userEdges"]), 1)
        self.assertEqual(data["userEdges"][0]["label"], "同为振动")
        self.assertEqual(data["danglingEdges"][0]["id"], "e2")
        self.assertEqual(data["danglingEdges"][0]["missing"], "to")

    def test_continent_empty_library_returns_empty_projection(self):
        resp = self.client.get("/api/continent")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["clusters"], [])
        self.assertEqual(data["shared"], [])
        self.assertEqual(data["userEdges"], [])
        self.assertEqual(data["danglingEdges"], [])


class StaticCacheHeaderTest(RouteTestBase):
    """静态资源显式缓存头（根治「改了没生效必须 Ctrl+Shift+R」）。

    应用产物文件名无内容指纹：必须发 Cache-Control: no-cache（每次协商、ETag
    命中回 304），否则浏览器启发式缓存会在普通刷新时拿旧 JS；/api/* 不发缓存头，
    各走各的路由。"""

    def test_static_js_carries_no_cache(self):
        resp = self.client.get("/js/app.js")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("cache-control"), "no-cache")

    def test_conditional_request_returns_304(self):
        first = self.client.get("/js/app.js")
        self.assertEqual(first.status_code, 200)
        etag = first.headers.get("etag")
        self.assertTrue(etag, "FileResponse 应自带 ETag")
        second = self.client.get("/js/app.js", headers={"If-None-Match": etag})
        self.assertEqual(second.status_code, 304)
        # 304 也必须带着缓存口径，否则浏览器拿不到协商指令
        self.assertEqual(second.headers.get("cache-control"), "no-cache")

    def test_index_html_carries_no_cache(self):
        # HTML 是缓存链条的关键一环：app.js?v=<内容哈希> 写在 HTML 里，
        # HTML 不协商就拿不到新哈希
        resp = self.client.get("/")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("cache-control"), "no-cache")

    def test_api_routes_untouched(self):
        resp = self.client.get("/api/knowledge")
        self.assertEqual(resp.status_code, 200)
        # T147：知识/公式两个 15 秒轮询 GET 刻意改为 no-cache+ETag 协商
        # （存但每次回源验证）；「静态缓存策略不得外溢到 API 路由」的底线不变——
        # 绝不许出现长 max-age
        cc = resp.headers.get("cache-control")
        self.assertIsNotNone(cc)
        self.assertNotIn("max-age", cc)

    def test_vendor_files_same_policy(self):
        # /vendor/ 第三方本地副本无版本指纹，同样只能 no-cache，不许长 max-age
        katex = Path(ROOT) / "src/static/vendor/katex/katex.min.css"
        if not katex.exists():
            self.skipTest("vendor katex.css not present")
        resp = self.client.get("/vendor/katex/katex.min.css")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("cache-control"), "no-cache")




class HarnessStreamReviewTest(RouteTestBase):
    """Φ 流式评审端点（stream:true 走 SSE）：事件框架完整、最终结果与非流式
    完全一致；默认不带 stream 参数时必须仍走旧 JSON 协议（battery 零影响）。
    模型调用打桩，不走网络；usage 日志重定向到临时目录。"""

    def _patch_harness(self):
        from harness import api as harness_api
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False, on_delta=None):
            return {
                "content": '{"summary": "已完成梳理", "operations": [{"op": "update_node", "node_id": "A", "patch": {"content": "新内容"}, "reason": "r"}]}',
                "tool_calls": [],
            }

        return (
            mock.patch.object(harness_api, "_LOG_DIR", Path(self._td.name)),
            mock.patch.object(harness_api, "_USAGE_LOG", Path(self._td.name) / "usage.jsonl"),
            mock.patch.object(review_mod, "_call_model", new=fake_call),
        )

    @staticmethod
    def _base_body(**extra):
        body = {
            "instruction": "把导数内容改掉",
            "model": {"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
            "mode": "json",
            "self_check": "off",
            "snapshot": {"version": 1, "nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
        }
        body.update(extra)
        return body

    @staticmethod
    def _parse_sse(text):
        events = []
        for block in text.split("\n\n"):
            for line in block.split("\n"):
                if line.startswith("data:"):
                    events.append(json.loads(line[5:].strip()))
        return events

    def test_stream_emits_status_then_result(self):
        patches = self._patch_harness()
        usage_log = Path(self._td.name) / "usage.jsonl"
        with patches[0], patches[1], patches[2]:
            resp = self.client.post(
                "/api/harness/graph/review", json=self._base_body(stream=True)
            )
        self.assertEqual(resp.status_code, 200)
        self.assertIn("text/event-stream", resp.headers.get("content-type", ""))
        events = self._parse_sse(resp.text)
        types = [e.get("type") for e in events]
        self.assertIn("status", types)
        self.assertEqual(types[-1], "result")
        start = next(e for e in events if e.get("type") == "status" and e.get("stage") == "start")
        self.assertIn("已理解指令", start["message"])
        result = events[-1]["data"]
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["op"], "update_node")
        self.assertEqual(result["operations"][0]["id"], "A")
        self.assertEqual(result["summary"], "已完成梳理")
        self.assertTrue(usage_log.exists())

    def test_stream_result_matches_nonstream(self):
        patches = self._patch_harness()
        with patches[0], patches[1], patches[2]:
            streamed = self.client.post(
                "/api/harness/graph/review", json=self._base_body(stream=True)
            )
            nonstream = self.client.post(
                "/api/harness/graph/review", json=self._base_body(stream=False)
            )
        s = self._parse_sse(streamed.text)[-1]["data"]
        self.assertIn("application/json", nonstream.headers.get("content-type", ""))
        n = nonstream.json()
        for key in ("summary", "operations", "status", "phase"):
            self.assertEqual(s.get(key), n.get(key), f"流式与非流式的 {key} 不一致")

    def test_default_without_stream_stays_json(self):
        # 旧协议必须原样保留：不带 stream 参数 → 直接回 JSON（battery/旧客户端零影响）
        patches = self._patch_harness()
        with patches[0], patches[1], patches[2]:
            resp = self.client.post(
                "/api/harness/graph/review", json=self._base_body()
            )
        self.assertEqual(resp.status_code, 200)
        self.assertIn("application/json", resp.headers.get("content-type", ""))
        self.assertEqual(resp.json()["status"], "ok")

    def test_empty_snapshot_preset_passes_defense(self):
        # 空快照防御必须放行创造模式（2026-09-30）：从空画布从零创作是 preset 的本职，
        # 用户真机取证「帮我做一个纠错节点」被 no_ops 拦掉、模型一次都没调。
        from harness import api as harness_api
        from harness import review as review_mod

        async def fake_clarify(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False, on_delta=None):
            return {
                "content": '{"summary": "需要确认", "clarify": {"question": "做什么用？", "options": ["答题", "演示"]}}',
                "tool_calls": [],
            }

        body = self._base_body(
            stream=False,
            phase="preset",
            snapshot={"version": 1, "nodes": [], "edges": []},
        )
        with mock.patch.object(harness_api, "_LOG_DIR", Path(self._td.name)), \
             mock.patch.object(harness_api, "_USAGE_LOG", Path(self._td.name) / "usage.jsonl"), \
             mock.patch.object(review_mod, "_call_model", new=fake_clarify):
            resp = self.client.post("/api/harness/graph/review", json=body)
        self.assertEqual(resp.status_code, 200)
        result = resp.json()
        self.assertEqual(result["status"], "clarify")
        self.assertEqual(result["clarify"]["question"], "做什么用？")
        self.assertGreaterEqual(result.get("model_calls", 0), 1)

    def test_empty_snapshot_chat_passes_defense(self):
        # 空快照防御放行答疑模式（2026-09-30 三模式切换器）：问问题不需要图上有内容
        from harness import api as harness_api
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False, **kwargs):
            return {"content": "这是一条答疑模式的纯文字回答。", "tool_calls": []}

        body = self._base_body(
            stream=False,
            mode="tools",
            phase="chat",
            snapshot={"version": 1, "nodes": [], "edges": []},
        )
        with mock.patch.object(harness_api, "_LOG_DIR", Path(self._td.name)), \
             mock.patch.object(harness_api, "_USAGE_LOG", Path(self._td.name) / "usage.jsonl"), \
             mock.patch.object(review_mod, "_call_model", new=fake_call):
            resp = self.client.post("/api/harness/graph/review", json=body)
        self.assertEqual(resp.status_code, 200)
        result = resp.json()
        self.assertIn("纯文字回答", result["summary"])
        self.assertEqual(result["operations"], [])

    def test_empty_snapshot_without_preset_still_blocked(self):
        # 非 preset 相位空快照仍走防御：省一次注定无效的模型调用（存量行为护栏）
        from harness import api as harness_api
        from harness import review as review_mod

        async def must_not_call(messages, model, max_tokens, **kwargs):
            raise AssertionError("空快照防御不应触发模型调用")

        body = self._base_body(
            stream=False,
            snapshot={"version": 1, "nodes": [], "edges": []},
        )
        with mock.patch.object(harness_api, "_LOG_DIR", Path(self._td.name)), \
             mock.patch.object(harness_api, "_USAGE_LOG", Path(self._td.name) / "usage.jsonl"), \
             mock.patch.object(review_mod, "_call_model", new=must_not_call):
            resp = self.client.post("/api/harness/graph/review", json=body)
        self.assertEqual(resp.status_code, 200)
        result = resp.json()
        self.assertEqual(result["status"], "no_ops")
        self.assertEqual(result.get("model_calls"), 0)
        self.assertIn("empty snapshot", result["warnings"][0]["reason"])


class SessionDeleteCleanupTest(RouteTestBase):
    """删除会话的完整清理 + 知识入库孤儿闸门（09-23「已删除的画布」孤岛修复）。

    真机取证：旧顺序「先 pop 名单、后清资料」中途被打断 → 名单没了、资料原地
    残留，大陆投影出「已删除的画布」孤岛；探索网快照（data/kv/<sid>.json）此前
    从不清，会被回填脚本当提取料把死会话知识点重新入库。
    """

    SID = "sess_delclean0000000000000000000"

    def _seed(self):
        sid = self.SID
        storage_mod._write_json(main_mod.SESSIONS_PATH, {sid: {"id": sid, "title": "测试"}})
        main_mod._write_json(main_mod.MESSAGES_DIR / f"{sid}.json",
                             [{"role": "user", "content": "hi", "timestamp": "1"}])
        storage_mod._write_json(main_mod.KNOWLEDGE_PATH,
                                {"ki_1": {"id": "ki_1", "sessionId": sid, "title": "机械能守恒"}})
        storage_mod._write_json(main_mod.FORMULAS_PATH,
                                {"f_1": {"id": "f_1", "sessionId": sid, "latex": "E=mc^2"}})
        # kv_write 自动 mkdir 并路由到 KV_DIR/<sid>.json（探索网快照的真实落点）
        storage_mod.kv_write(f"graph:{sid}", {"customNodes": []})
        return sid

    def test_delete_removes_all_resources_then_unlists(self):
        sid = self._seed()
        resp = self.client.delete(f"/api/sessions/{sid}")
        self.assertEqual(resp.status_code, 200)
        self.assertNotIn(sid, storage_mod._read_json(main_mod.SESSIONS_PATH, {}))          # 名单
        self.assertFalse((main_mod.MESSAGES_DIR / f"{sid}.json").exists())                 # 消息
        self.assertEqual(storage_mod._read_json(main_mod.KNOWLEDGE_PATH, {}), {})          # 知识点
        self.assertEqual(storage_mod._read_json(main_mod.FORMULAS_PATH, {}), {})           # 公式
        self.assertFalse((main_mod.KV_DIR / f"{sid}.json").exists())                       # KV 快照

    def test_delete_twice_is_idempotent(self):
        sid = self._seed()
        self.assertEqual(self.client.delete(f"/api/sessions/{sid}").status_code, 200)
        # 再删一次不报错（前端重试 / 并发删除的安全网）
        self.assertEqual(self.client.delete(f"/api/sessions/{sid}").status_code, 200)

    def test_delete_session_purges_dangling_continent_edges(self):
        """删画布自动清断桥（2026-10-03 用户拍板）：端点随画布消失的航线整条移除；
        端点都健在的边原样保留——只查端点存在性（同会话与否是投影的事）。"""
        sid, other = self.SID, "sess_keepXX00000000000000000"
        self._seed()
        storage_mod._write_json(main_mod.SESSIONS_PATH, {
            sid: {"id": sid, "title": "测试"}, other: {"id": other, "title": "保留"}})
        storage_mod._write_json(main_mod.KNOWLEDGE_PATH, {
            "ki_1": {"id": "ki_1", "sessionId": sid, "title": "机械能守恒"},
            "ki_2": {"id": "ki_2", "sessionId": other, "title": "动量守恒"},
            "ki_3": {"id": "ki_3", "sessionId": other, "title": "角动量守恒"}})
        storage_mod.kv_write("continent_edges", [
            {"id": "e_keep", "fromItem": "ki_2", "toItem": "ki_3", "createdAt": 1},
            {"id": "e_dead", "fromItem": "ki_1", "toItem": "ki_2", "createdAt": 2},
        ])
        self.assertEqual(self.client.delete(f"/api/sessions/{sid}").status_code, 200)
        self.assertEqual([e["id"] for e in storage_mod.kv_read("continent_edges")], ["e_keep"])

    def test_clear_messages_purges_dangling_continent_edges(self):
        """清空画布（清消息连带清概念）同批自动清断桥。"""
        sid, other = self.SID, "sess_keepYY00000000000000000"
        self._seed()
        storage_mod._write_json(main_mod.SESSIONS_PATH, {
            sid: {"id": sid, "title": "测试"}, other: {"id": other, "title": "保留"}})
        storage_mod._write_json(main_mod.KNOWLEDGE_PATH, {
            "ki_1": {"id": "ki_1", "sessionId": sid, "title": "机械能守恒"},
            "ki_2": {"id": "ki_2", "sessionId": other, "title": "动量守恒"},
            "ki_3": {"id": "ki_3", "sessionId": other, "title": "角动量守恒"}})
        storage_mod.kv_write("continent_edges", [
            {"id": "e_keep", "fromItem": "ki_2", "toItem": "ki_3", "createdAt": 1},
            {"id": "e_dead", "fromItem": "ki_1", "toItem": "ki_2", "createdAt": 2},
        ])
        self.assertEqual(self.client.delete(f"/api/sessions/{sid}/messages").status_code, 200)
        self.assertEqual([e["id"] for e in storage_mod.kv_read("continent_edges")], ["e_keep"])


class KnowledgeOrphanGateTest(RouteTestBase):
    """POST /api/knowledge 拒收指向不存在会话的条目（空 sessionId 旧数据放行）。

    删除会话后 localStorage 残留条目会被前端定时同步推回（端点是纯合并，推回即
    复活），没有这道闸门「已删除的画布」岛删了又复活。
    """

    def test_orphan_session_items_rejected_live_and_blank_accepted(self):
        live = "sess_live00000000000000000000000"
        dead = "sess_dead00000000000000000000000"
        storage_mod._write_json(main_mod.SESSIONS_PATH, {live: {"id": live, "title": "活会话"}})
        items = {
            "ki_dead": {"id": "ki_dead", "sessionId": dead, "title": "机械能守恒", "source": "ai_extract"},
            "ki_live": {"id": "ki_live", "sessionId": live, "title": "动能定理", "source": "ai_extract"},
            "ki_blank": {"id": "ki_blank", "title": "动量守恒", "source": "ai_extract"},
        }
        resp = self.client.post("/api/knowledge", json={"items": items})
        self.assertEqual(resp.status_code, 200)
        stored = storage_mod._read_json(main_mod.KNOWLEDGE_PATH, {})
        self.assertNotIn("ki_dead", stored)   # 死会话条目被拒收
        self.assertIn("ki_live", stored)      # 活会话条目正常入库
        self.assertIn("ki_blank", stored)     # 空 sessionId 旧数据放行



if __name__ == "__main__":
    unittest.main()
