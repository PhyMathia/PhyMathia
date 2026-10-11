"""T284：模型配置按账号落盘（GET/POST /api/models/config）。

此前模型列表/组密钥/槽位只存浏览器 localStorage，换端口/换主机名打开、清浏览器
数据、多账号切命名空间任一即「配置全丢」（用户实报）。本组用例钉死：整包读写
往返、服务端打 updatedAt（不信客户端时钟）、形状校验与消毒、双账号隔离、已删
账号 404 带墓碑头（走 _account_id 单一咽喉）。
Run: python3 -m pytest tests/test_models_config.py -q
"""

from test_routes import RouteTestBase
from server import accounts as accounts_mod


BLOB = {
    "userModels": [
        {"id": "model_abc123456789", "provider": "deepseek", "model": "deepseek-chat",
         "apiKey": "sk-test-key", "baseUrl": "", "createdAt": 1728600000000},
    ],
    "modelGroupKeys": {"deepseek": "sk-group-key"},
    "activeModels": {"agent_model": "model_abc123456789", "agent_thinking": "high",
                     "html_model": "", "html_thinking": ""},
}


def _register(account: str) -> None:
    accounts_mod._ENSURED.clear()
    accounts_mod._REGISTRY_CACHE["key"] = None
    accounts_mod._REGISTRY_CACHE["entries"] = {}
    accounts_mod.register_account(account)
    accounts_mod.ensure_account(account)


class ModelsConfigRouteTest(RouteTestBase):
    def test_get_fresh_account_returns_empty_and_creates_nothing(self):
        resp = self.client.get("/api/models/config")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["userModels"], [])
        self.assertEqual(data["modelGroupKeys"], {})
        self.assertEqual(data["activeModels"], {})
        self.assertEqual(data["updatedAt"], 0)
        # 读路径刻意不 ensure：不建目录不落文件
        import pathlib
        models_json = pathlib.Path(self._td.name) / "users" / "default" / "models.json"
        self.assertFalse(models_json.exists())

    def test_post_roundtrip_and_server_stamped_updatedat(self):
        resp = self.client.post("/api/models/config", json=BLOB)
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.json()["ok"])
        ts = resp.json()["updatedAt"]
        self.assertGreater(ts, 0)
        # 客户端伪造的 updatedAt 不被采纳（时间戳由服务端打）
        resp2 = self.client.post("/api/models/config", json={**BLOB, "updatedAt": 12345.0})
        self.assertNotEqual(resp2.json()["updatedAt"], 12345.0)
        data = self.client.get("/api/models/config").json()
        self.assertEqual(len(data["userModels"]), 1)
        self.assertEqual(data["userModels"][0]["apiKey"], "sk-test-key")
        self.assertEqual(data["modelGroupKeys"], {"deepseek": "sk-group-key"})
        self.assertEqual(data["activeModels"]["agent_model"], "model_abc123456789")
        self.assertEqual(data["activeModels"]["agent_thinking"], "high")

    def test_post_sanitizes_non_scalar_fields(self):
        dirty = {
            "userModels": [{"id": "m1", "nested": {"x": 1}, "list": [1, 2]}],
            "modelGroupKeys": {"deepseek": "sk-group"},
            "activeModels": {"agent_model": "m1"},
        }
        self.assertEqual(self.client.post("/api/models/config", json=dirty).status_code, 200)
        data = self.client.get("/api/models/config").json()
        self.assertNotIn("nested", data["userModels"][0])
        self.assertNotIn("list", data["userModels"][0])
        self.assertEqual(data["userModels"][0]["id"], "m1")

    def test_post_validates_shapes(self):
        self.assertEqual(self.client.post("/api/models/config", json={
            "userModels": "not-a-list", "modelGroupKeys": {}, "activeModels": {}}).status_code, 400)
        self.assertEqual(self.client.post("/api/models/config", json={
            "userModels": ["not-a-dict"], "modelGroupKeys": {}, "activeModels": {}}).status_code, 400)
        self.assertEqual(self.client.post("/api/models/config", json={
            "userModels": [], "modelGroupKeys": [], "activeModels": {}}).status_code, 400)
        self.assertEqual(self.client.post("/api/models/config", json={
            "userModels": [], "modelGroupKeys": {}, "activeModels": []}).status_code, 400)

    def test_post_rejects_oversized_model_list(self):
        bloated = {**BLOB, "userModels": [{"id": f"m{i}"} for i in range(1001)]}
        self.assertEqual(self.client.post("/api/models/config", json=bloated).status_code, 400)

    def test_account_isolation(self):
        _register("alice")
        self.client.post("/api/models/config?account_id=alice", json=BLOB)
        # default 域不受 alice 写入影响
        self.assertEqual(self.client.get("/api/models/config").json()["userModels"], [])
        data = self.client.get("/api/models/config?account_id=alice").json()
        self.assertEqual(len(data["userModels"]), 1)
        self.assertEqual(data["modelGroupKeys"], {"deepseek": "sk-group-key"})

    def test_unregistered_account_404_with_gone_marker(self):
        resp = self.client.get("/api/models/config?account_id=ghost")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.headers.get("X-Phymathia-Account-Gone"), "1")

    def test_deleted_account_404_with_gone_marker(self):
        _register("bob")
        self.assertEqual(
            self.client.post("/api/models/config?account_id=bob", json=BLOB).status_code, 200)
        resp = self.client.post("/api/accounts/delete", json={"account_id": "bob"})
        self.assertEqual(resp.status_code, 200)
        # 删除后（保留期内＝墓碑态）读写都 404 且带标记头，配置随账号目录进回收站
        resp = self.client.get("/api/models/config?account_id=bob")
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.headers.get("X-Phymathia-Account-Gone"), "1")
        resp = self.client.post("/api/models/config?account_id=bob", json=BLOB)
        self.assertEqual(resp.status_code, 404)
        self.assertEqual(resp.headers.get("X-Phymathia-Account-Gone"), "1")
