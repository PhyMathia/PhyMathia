"""Route-level tests for src/main.py (P0 安全修复验收).

覆盖三类请求级缺陷（纯函数层测试覆盖不到）：
1. 会话 id 路径穿越（Windows 反斜杠）→ 必须返回 400 而非读/写 data 外文件
2. 损坏数据文件（GBK 字节）→ 相关 API 优雅降级而非 500
3. SSRF 外发链：provider=deepseek（触发 .env 兜底 key）+ 任意 base_url → 403

运行前会把 main/storage 两个模块命名空间里的数据路径指向临时目录，
避免污染真实 data/。
"""

import json
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
from server import backup as backup_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


_MISSING = object()


def _patched_paths(td):
    """main 与 storage 模块命名空间中的数据路径统一指向临时目录。"""
    return {
        "MESSAGES_DIR": Path(td) / "messages",
        "SESSIONS_PATH": Path(td) / "sessions.json",
        "KNOWLEDGE_PATH": Path(td) / "knowledge.json",
        "FORMULAS_PATH": Path(td) / "formulas.json",
        "KV_PATH": Path(td) / "kv_store.json",
        "PROFILES_DIR": Path(td) / "profiles",
    }


class RouteTestBase(unittest.TestCase):
    """把数据路径重定向到临时目录，测试后恢复。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        paths = _patched_paths(self._td.name)
        paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
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
        target = Path(self._td.name) / "messages" / "sess_corrupt.json"
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

        with mock.patch.object(main_mod.get_http_client(), "get", side_effect=fake_get):
            resp = self.client.post(
                "/api/models/list",
                json={"provider": "ollama", "api_key": "", "base_url": "http://localhost:11434/v1"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"models": ["a-model", "b-model", "c"]})

    def test_bare_array_response_parsed(self):
        def fake_get(url, headers=None, timeout=None):
            class R:
                status_code = 200

                def json(self):
                    return [{"id": "z"}, {"id": "a"}]

            return R()

        with mock.patch.object(main_mod.get_http_client(), "get", side_effect=fake_get):
            resp = self.client.post(
                "/api/models/list",
                json={"provider": "lmstudio", "api_key": "", "base_url": "http://localhost:1234/v1"},
            )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"models": ["a", "z"]})


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
        with mock.patch.object(main_mod, "get_http_client", return_value=client):
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
        td = Path(self._td.name)
        (td / "profiles").mkdir(exist_ok=True)
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
        td = Path(self._td.name)
        (td / "profiles").mkdir(exist_ok=True)
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
        junk = {"id": "ki_junk", "sessionId": "sess_gate", "source": "ai_extract",
                "title": "用户要求：从方向导数最大值推导梯度在直角坐标下的分量表达式。这是一"}
        ok = {"id": "ki_ok", "sessionId": "sess_gate", "source": "ai_extract", "title": "梯度的定义与坐标表达"}
        resp = self.client.post("/api/knowledge", json={"items": {"ki_junk": junk, "ki_ok": ok}})
        self.assertEqual(resp.status_code, 200)
        data = self.client.get("/api/knowledge").json()
        self.assertIn("ki_ok", data)
        self.assertNotIn("ki_junk", data)

    def test_ingest_keeps_manual_item_even_with_odd_title(self):
        manual = {"id": "ki_manual", "sessionId": "sess_gate", "source": "manual",
                  "title": "用户要求：我自己写的笔记标题。保留它"}
        resp = self.client.post("/api/knowledge", json={"items": {"ki_manual": manual}})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("ki_manual", self.client.get("/api/knowledge").json())

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

        async def fake_describe(summary, formulas, items, provider, api_key, model, base_url, level="university"):
            calls["formulas"] = list(formulas)
            calls["titles"] = [it.get("title") for it in items]
            return {}, {"简谐运动": "回复力与位移成正比的周期性振动"}

        with mock.patch.object(main_mod, "_describe_formulas", new=fake_describe):
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

        with mock.patch.object(main_mod, "_describe_formulas", new=fake_describe):
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
        with mock.patch.object(main_mod, "get_http_client", return_value=async_client):
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
        td = Path(self._td.name)
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
        td = Path(self._td.name)
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
        td = Path(self._td.name)
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
        self.assertIsNone(resp.headers.get("cache-control"))

    def test_vendor_files_same_policy(self):
        # /vendor/ 第三方本地副本无版本指纹，同样只能 no-cache，不许长 max-age
        katex = Path(ROOT) / "src/static/vendor/katex/katex.min.css"
        if not katex.exists():
            self.skipTest("vendor katex.css not present")
        resp = self.client.get("/vendor/katex/katex.min.css")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.headers.get("cache-control"), "no-cache")




if __name__ == "__main__":
    unittest.main()
