"""会话级 KV 拆分路由（storage.kv_*）、迁移、备份合并视图的回归。

graph:<sid>/harness_history:<sid>/graph_history:<sid> 拆到 data/kv/<sid>.json；
全局键留在 kv_store.json；context 的 socratic/滚动记忆小键不走拆分层。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from server import storage as storage_mod  # noqa: E402


class KvSplitBase(unittest.TestCase):
    """多账号 P1 夹具：patch config.DATA_DIR 一处（storage 经 accounts.resolve_paths
    调用期读取），kv_path/kv_dir 取账号域布局真实路径，与路由读取口径一致。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        td = Path(self._td.name)
        from server import accounts as accounts_mod
        from server import config as config_mod
        self._config_mod = config_mod
        self._accounts_mod = accounts_mod
        self._orig_data_dir = config_mod.DATA_DIR
        config_mod.DATA_DIR = td
        accounts_mod._ENSURED.clear()
        self.kv_path = td / "users" / "default" / "kv_store.json"
        self.kv_dir = td / "users" / "default" / "kv"
        self.kv_path.parent.mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        self._config_mod.DATA_DIR = self._orig_data_dir
        self._accounts_mod._ENSURED.clear()
        self._td.cleanup()


class RoutingTest(KvSplitBase):
    def test_session_key_goes_to_session_file(self):
        storage_mod.kv_write("graph:sess_abc", {"nodes": [1]})
        self.assertTrue((self.kv_dir / "sess_abc.json").exists())
        self.assertFalse(self.kv_path.exists())  # 全局主文件不因会话键而创建
        self.assertEqual(storage_mod.kv_read("graph:sess_abc"), {"nodes": [1]})

    def test_global_key_stays_in_main_file(self):
        storage_mod.kv_write("phymathia_quiz_bank", {"q": 1})
        self.assertTrue(self.kv_path.exists())
        self.assertFalse(self.kv_dir.exists() and any(self.kv_dir.iterdir()))
        self.assertEqual(storage_mod.kv_read("phymathia_quiz_bank"), {"q": 1})

    def test_all_split_prefixes(self):
        for key in ("graph:sess_h1", "harness_history:sess_h1", "graph_history:sess_h1"):
            storage_mod.kv_write(key, {"k": key})
        self.assertTrue((self.kv_dir / "sess_h1.json").exists())
        for key in ("graph:sess_h1", "harness_history:sess_h1", "graph_history:sess_h1"):
            self.assertEqual(storage_mod.kv_read(key), {"k": key})

    def test_non_session_graph_key_falls_back_to_main(self):
        # 旧版遗留的畸形键（如备份误写的 graph:history_<sid> 之外的）保持旧行为进主文件
        storage_mod.kv_write("graph:not-a-sid key", 1)
        self.assertIn("graph:not-a-sid key", storage_mod._read_json(self.kv_path, {}))

    def test_bad_sid_session_path_raises(self):
        with self.assertRaises(ValueError):
            storage_mod._kv_session_path("../evil")

    def test_delete_removes_key_and_empty_session_file(self):
        storage_mod.kv_write("graph:sess_del", {"a": 1})
        storage_mod.kv_write("graph_history:sess_del", [1])
        session_file = self.kv_dir / "sess_del.json"
        storage_mod.kv_delete("graph:sess_del")
        self.assertTrue(session_file.exists())  # 还有 graph_history 键
        storage_mod.kv_delete("graph_history:sess_del")
        self.assertFalse(session_file.exists())  # 删空后移除文件本身
        self.assertIsNone(storage_mod.kv_read("graph:sess_del"))


class MigrationTest(KvSplitBase):
    def test_migration_moves_session_keys_only(self):
        storage_mod._write_json(self.kv_path, {
            "graph:sess_old": {"n": 1},
            "harness_history:sess_old": [{"a": 1}],
            "phymathia_quiz_bank": {"q": 2},
        })
        moved = storage_mod.kv_migrate_session_keys()
        self.assertEqual(moved, 2)
        main = storage_mod._read_json(self.kv_path, {})
        self.assertEqual(set(main.keys()), {"phymathia_quiz_bank"})
        self.assertEqual(storage_mod.kv_read("graph:sess_old"), {"n": 1})
        self.assertEqual(storage_mod.kv_read("harness_history:sess_old"), [{"a": 1}])
        # 幂等：再跑一次搬 0 个
        self.assertEqual(storage_mod.kv_migrate_session_keys(), 0)

    def test_migration_no_main_file_is_noop(self):
        self.assertEqual(storage_mod.kv_migrate_session_keys(), 0)


class AllDataAndRestoreTest(KvSplitBase):
    def test_all_data_merges_main_and_session_files(self):
        storage_mod.kv_write("graph:sess_m", {"x": 1})
        storage_mod.kv_write("global:key", "v")
        data = storage_mod.kv_all_data()
        self.assertEqual(data["graph:sess_m"], {"x": 1})
        self.assertEqual(data["global:key"], "v")

    def test_restore_bulk_replace_and_merge(self):
        storage_mod.kv_write("old:key", 1)
        storage_mod.kv_write("graph:sess_old", {"keep": True})
        storage_mod.kv_restore_bulk({"graph:sess_new": {"n": 1}, "g:k": 2}, replace=True)
        self.assertIsNone(storage_mod.kv_read("old:key"))
        self.assertIsNone(storage_mod.kv_read("graph:sess_old"))
        self.assertEqual(storage_mod.kv_read("graph:sess_new"), {"n": 1})
        self.assertEqual(storage_mod.kv_read("g:k"), 2)
        storage_mod.kv_restore_bulk({"g:k": 3}, replace=False)
        self.assertEqual(storage_mod.kv_read("g:k"), 3)
        self.assertEqual(storage_mod.kv_read("graph:sess_new"), {"n": 1})

    def test_restore_bulk_non_dict_noop(self):
        self.assertEqual(storage_mod.kv_restore_bulk("junk", True), 0)


class ConceptSplitFallbackTest(KvSplitBase):
    def test_explicit_pairs_reads_split_graph_state(self):
        from server import concept as concept_mod

        state = {
            "customNodes": [
                {"id": "knowledge-custom-1", "knowledgeKey": "k1"},
                {"id": "knowledge-custom-2", "knowledgeKey": "k2"},
            ],
            "connections": [
                {"from": "knowledge-custom-1", "to": "knowledge-custom-2", "relation": "依赖"},
            ],
        }
        storage_mod.kv_write("graph:sess_c", state)
        pairs = concept_mod.explicit_pairs("sess_c")
        self.assertEqual(pairs, [("k1", "k2", "依赖")])


class BackupRoundtripTest(unittest.TestCase):
    """多账号 P1 夹具：patch config.DATA_DIR 一处（backup/storage/profile 全部经
    accounts.resolve_paths 调用期读取）。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        td = Path(self._td.name)
        from server import accounts as accounts_mod
        from server import config as config_mod
        self._config_mod = config_mod
        self._accounts_mod = accounts_mod
        self._orig_data_dir = config_mod.DATA_DIR
        config_mod.DATA_DIR = td
        accounts_mod._ENSURED.clear()
        (td / "users" / "default" / "messages").mkdir(parents=True)
        (td / "profiles").mkdir()

    def tearDown(self):
        self._config_mod.DATA_DIR = self._orig_data_dir
        self._accounts_mod._ENSURED.clear()
        self._td.cleanup()

    def test_export_import_roundtrip_with_split_keys(self):
        from server import backup as backup_mod
        from server import storage as storage_mod

        storage_mod.kv_write("graph:sess_rt", {"connections": [1]})
        storage_mod.kv_write("g:k", "v")
        payload = backup_mod._build_backup_payload()
        self.assertIn("graph:sess_rt", payload["kv"])
        self.assertIn("g:k", payload["kv"])
        # 破坏现场后恢复
        storage_mod.kv_delete("graph:sess_rt")
        storage_mod.kv_delete("g:k")
        self.assertIsNone(storage_mod.kv_read("graph:sess_rt"))
        backup_mod._restore_backup(
            {"kv": payload["kv"], "sessions": {}, "messages": {}, "knowledge": {}, "formulas": {}, "profiles": {}},
            replace=False,
        )
        self.assertEqual(storage_mod.kv_read("graph:sess_rt"), {"connections": [1]})
        self.assertEqual(storage_mod.kv_read("g:k"), "v")


if __name__ == "__main__":
    unittest.main()
