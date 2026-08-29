"""Route-level tests for src/main.py (P0 安全修复验收).

覆盖三类请求级缺陷（纯函数层测试覆盖不到）：
1. 会话 id 路径穿越（Windows 反斜杠）→ 必须返回 400 而非读/写 data 外文件
2. 损坏数据文件（GBK 字节）→ 相关 API 优雅降级而非 500
3. SSRF 外发链：provider=deepseek（触发 .env 兜底 key）+ 任意 base_url → 403

运行前会把 main/storage 两个模块命名空间里的数据路径指向临时目录，
避免污染真实 data/。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


def _patched_paths(td):
    """main 与 storage 模块命名空间中的数据路径统一指向临时目录。"""
    return {
        "MESSAGES_DIR": Path(td) / "messages",
        "SESSIONS_PATH": Path(td) / "sessions.json",
        "KNOWLEDGE_PATH": Path(td) / "knowledge.json",
        "FORMULAS_PATH": Path(td) / "formulas.json",
        "KV_PATH": Path(td) / "kv_store.json",
    }


class RouteTestBase(unittest.TestCase):
    """把数据路径重定向到临时目录，测试后恢复。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        paths = _patched_paths(self._td.name)
        paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
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


if __name__ == "__main__":
    unittest.main()
