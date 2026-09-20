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
    """storage 的 KV_PATH/KV_DIR 绑定指向临时目录（与 test_routes 同口径）。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        td = Path(self._td.name)
        self.kv_path = td / "kv_store.json"
        self.kv_dir = td / "kv"
        self._orig = {}
        for name in ("KV_PATH", "KV_DIR", "MESSAGES_DIR", "SESSIONS_PATH"):
            self._orig[name] = getattr(storage_mod, name, None)
        storage_mod.KV_PATH = self.kv_path
        storage_mod.KV_DIR = self.kv_dir

    def tearDown(self):
        for name, value in self._orig.items():
            setattr(storage_mod, name, value)
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
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        td = Path(self._td.name)
        (td / "messages").mkdir()
        (td / "profiles").mkdir()
        self.paths = {
            "SESSIONS_PATH": td / "sessions.json",
            "MESSAGES_DIR": td / "messages",
            "KNOWLEDGE_PATH": td / "knowledge.json",
            "FORMULAS_PATH": td / "formulas.json",
            "KV_PATH": td / "kv_store.json",
            "KV_DIR": td / "kv",
            "PROFILES_DIR": td / "profiles",
        }
        from server import backup as backup_mod
        from server import profile as profile_mod
        self._mods = (backup_mod, profile_mod)
        self._orig = {}
        for mod in self._mods:
            for name, value in self.paths.items():
                self._orig[(id(mod), name)] = getattr(mod, name, None)
                setattr(mod, name, value)

    def tearDown(self):
        for mod in self._mods:
            for name in self.paths:
                setattr(mod, name, self._orig[(id(mod), name)])
        self._td.cleanup()

    def test_export_import_roundtrip_with_split_keys(self):
        from server import backup as backup_mod
        from server import storage as storage_mod

        storage_orig = {n: getattr(storage_mod, n) for n in ("KV_PATH", "KV_DIR", "SESSIONS_PATH", "MESSAGES_DIR")}
        for n, value in self.paths.items():
            if n in storage_orig:
                setattr(storage_mod, n, value)
        try:
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
        finally:
            for n, value in storage_orig.items():
                setattr(storage_mod, n, value)


if __name__ == "__main__":
    unittest.main()
