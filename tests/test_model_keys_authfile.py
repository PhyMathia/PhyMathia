"""密钥分家（2026-10-12）：条目 apiKey 与组密钥只落 auth.json（0600），
models.json 只存无害配置。对外 GET/POST /api/models/config 契约不变——GET 按
条目 id 回填、POST 拆开落两份，前端与发送链零改动。启动迁移幂等：旧档（密钥
内联）搬一次家；GET 全程只读零副作用（T187 口径）。
Run: python3 -m pytest tests/test_model_keys_authfile.py -q
"""

import json
import os
import pathlib
import unittest

from test_models_config import BLOB
from test_routes import RouteTestBase

from server import models_routes as mr


def _user_dir(base) -> pathlib.Path:
    return pathlib.Path(base) / "users" / "default"


class ModelKeysAuthfileTest(RouteTestBase):
    def test_post_splits_keys_out_of_models_json(self):
        self.assertEqual(self.client.post("/api/models/config", json=BLOB).status_code, 200)
        models_blob = json.loads((_user_dir(self._td.name) / "models.json").read_text(encoding="utf-8"))
        self.assertNotIn("apiKey", models_blob["userModels"][0])  # 条目密钥不落 models.json
        self.assertEqual(models_blob["modelGroupKeys"], {})  # 组密钥同理
        auth = json.loads((_user_dir(self._td.name) / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(auth["modelKeys"], {"model_abc123456789": "sk-test-key"})
        self.assertEqual(auth["groupKeys"], {"deepseek": "sk-group-key"})

    @unittest.skipIf(os.name == "nt", "POSIX 权限位")
    def test_authfile_restricted_to_owner(self):
        self.client.post("/api/models/config", json=BLOB)
        mode = (_user_dir(self._td.name) / "auth.json").stat().st_mode & 0o777
        self.assertEqual(mode, 0o600)

    def test_get_returns_merged_contract(self):
        # 前端契约不变：GET 照旧拿到带 apiKey 的条目与组密钥（发送链零改动）
        self.client.post("/api/models/config", json=BLOB)
        data = self.client.get("/api/models/config").json()
        self.assertEqual(data["userModels"][0]["apiKey"], "sk-test-key")
        self.assertEqual(data["modelGroupKeys"], {"deepseek": "sk-group-key"})
        self.assertEqual(data["activeModels"]["agent_model"], "model_abc123456789")

    def test_get_has_no_side_effect_on_files(self):
        self.client.post("/api/models/config", json=BLOB)
        before = [(p.name, p.read_bytes()) for p in sorted(_user_dir(self._td.name).glob("*.json"))]
        self.client.get("/api/models/config")
        after = [(p.name, p.read_bytes()) for p in sorted(_user_dir(self._td.name).glob("*.json"))]
        self.assertEqual(before, after)

    def test_clearing_key_updates_authfile(self):
        self.client.post("/api/models/config", json=BLOB)
        # 2026-10-24 起「缺钥」不再等于「删钥」：整包上传里条目没带 apiKey 只是
        # 这个客户端不知道这把钥，服务端必须保留（旧契约的整份重写是密钥丢失源）
        cleared = {**BLOB, "userModels": [{**BLOB["userModels"][0], "apiKey": ""}],
                   "modelGroupKeys": {}}
        resp = self.client.post("/api/models/config", json=cleared)
        auth = json.loads((_user_dir(self._td.name) / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(auth["modelKeys"], {"model_abc123456789": "sk-test-key"})
        self.assertEqual(auth["groupKeys"], {"deepseek": "sk-group-key"})
        # 回包把合并后的钥带回去，客户端当场补回本地镜像
        self.assertEqual(resp.json()["modelKeys"], {"model_abc123456789": "sk-test-key"})
        self.assertEqual(resp.json()["groupKeys"], {"deepseek": "sk-group-key"})

    def test_clear_keys_is_the_only_delete_path(self):
        self.client.post("/api/models/config", json=BLOB)
        # 显式清空口：clearKeys 点名的 id 才删；分组密钥用显式空串
        cleared = {**BLOB, "userModels": [{**BLOB["userModels"][0], "apiKey": ""}],
                   "modelGroupKeys": {"deepseek": ""}, "clearKeys": ["model_abc123456789"]}
        self.client.post("/api/models/config", json=cleared)
        auth = json.loads((_user_dir(self._td.name) / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(auth, {"modelKeys": {}, "groupKeys": {}})
        data = self.client.get("/api/models/config").json()
        self.assertFalse(data["userModels"][0].get("apiKey"))
        self.assertFalse(data["modelGroupKeys"])

    def test_removed_entry_prunes_its_key(self):
        self.client.post("/api/models/config", json=BLOB)
        # 条目被删（模型/整组删除）→ 钥随之清理，不留孤儿
        self.client.post("/api/models/config", json={"userModels": [], "modelGroupKeys": {},
                                                    "activeModels": {}})
        auth = json.loads((_user_dir(self._td.name) / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(auth, {"modelKeys": {}, "groupKeys": {}})

    def test_partial_payload_keeps_other_entries_keys(self):
        two = {**BLOB, "userModels": [
            {**BLOB["userModels"][0]},
            {"id": "model_second", "provider": "deepseek", "model": "deepseek-reasoner",
             "apiKey": "sk-second", "baseUrl": ""},
        ]}
        self.client.post("/api/models/config", json=two)
        # 旧标签页/导入替换：只认识第一条、且手里没有钥 → 第二条的钥不得丢
        stale = {**two, "userModels": [{"id": "model_second", "provider": "deepseek",
                                        "model": "deepseek-reasoner", "apiKey": ""}]}
        self.client.post("/api/models/config", json=stale)
        auth = json.loads((_user_dir(self._td.name) / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(auth["modelKeys"], {"model_second": "sk-second"})

    def test_clear_keys_rejects_non_list(self):
        bad = {**BLOB, "clearKeys": "model_abc123456789"}
        self.assertEqual(self.client.post("/api/models/config", json=bad).status_code, 400)

    def test_entry_without_id_gets_generated_id(self):
        no_id = {"userModels": [{"provider": "deepseek", "model": "deepseek-chat", "apiKey": "sk-x"}],
                 "modelGroupKeys": {}, "activeModels": {}}
        self.client.post("/api/models/config", json=no_id)
        entry = self.client.get("/api/models/config").json()["userModels"][0]
        self.assertTrue(entry.get("id"))  # 现场补 id，密钥才有地方挂
        self.assertEqual(entry["apiKey"], "sk-x")
        disk = json.loads((_user_dir(self._td.name) / "models.json").read_text(encoding="utf-8"))
        self.assertNotIn("apiKey", disk["userModels"][0])

    def test_startup_migration_moves_legacy_inline_keys(self):
        legacy = {**BLOB, "updatedAt": 12345.0}
        d = _user_dir(self._td.name)
        d.mkdir(parents=True, exist_ok=True)
        (d / "models.json").write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
        self.assertTrue(mr.migrate_split_model_keys(account="default"))
        disk = json.loads((d / "models.json").read_text(encoding="utf-8"))
        self.assertNotIn("apiKey", disk["userModels"][0])
        self.assertEqual(disk["modelGroupKeys"], {})
        self.assertEqual(disk["updatedAt"], 12345.0)  # 其余字段原样保留
        auth = json.loads((d / "auth.json").read_text(encoding="utf-8"))
        self.assertEqual(auth["modelKeys"], {"model_abc123456789": "sk-test-key"})
        self.assertEqual(auth["groupKeys"], {"deepseek": "sk-group-key"})
        # 迁移后 GET 照旧拿到全量（回填生效）
        data = self.client.get("/api/models/config").json()
        self.assertEqual(data["userModels"][0]["apiKey"], "sk-test-key")

    def test_startup_migration_idempotent(self):
        d = _user_dir(self._td.name)
        d.mkdir(parents=True, exist_ok=True)
        (d / "models.json").write_text(json.dumps(BLOB, ensure_ascii=False), encoding="utf-8")
        self.assertTrue(mr.migrate_split_model_keys(account="default"))
        self.assertFalse(mr.migrate_split_model_keys(account="default"))  # 第二次零改动
