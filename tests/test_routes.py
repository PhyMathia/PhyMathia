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

    def test_continent_empty_library_returns_empty_projection(self):
        resp = self.client.get("/api/continent")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["clusters"], [])
        self.assertEqual(data["shared"], [])




if __name__ == "__main__":
    unittest.main()
