"""KV 拆分路由（storage.kv_*）、迁移、备份合并视图的回归。

三层落点：graph:<sid>/harness_history:<sid>/graph_history:<sid> 拆到
data/kv/<sid>.json；socratic:<ref>/mem:<sid> 前缀族与 quiz/continent_* 独键族
拆到 data/kv/meta/<族>.json（T214）；其余全局小键留 kv_store.json。context 的
socratic/滚动记忆读写已切族文件（测试锚点随迁，见 test_review_* 系列）。
"""

import logging
import os
import re
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
        self.kv_meta_dir = td / "users" / "default" / "kv" / "meta"
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

    def test_family_prefixes_go_to_meta_files(self):
        # T214：socratic:/mem: 前缀族共居各自 meta 文件，与其余族/全局键隔离
        storage_mod.kv_write("socratic:sess_f", {"active": True})
        storage_mod.kv_write("socratic:br_sess_f_0123456789", {"active": False})
        storage_mod.kv_write("mem:sess_f", {"summary": "s"})
        self.assertEqual(
            sorted(x.name for x in self.kv_meta_dir.glob("*.json")),
            ["mem.json", "socratic.json"])
        self.assertEqual(storage_mod.kv_read("socratic:br_sess_f_0123456789"),
                         {"active": False})
        self.assertEqual(storage_mod.kv_read("mem:sess_f"), {"summary": "s"})

    def test_solo_family_keys_share_one_meta_file(self):
        # quiz 统计/题库共居 quiz.json；continent_* 六键共居 continent.json
        for key in ("phymathia_quiz_stats", "phymathia_quiz_bank"):
            storage_mod.kv_write(key, {"k": key})
        for key in ("continent_edges", "continent_families", "continent_family_suggestions",
                    "continent_gate", "continent_gate_weights", "continent_regions"):
            storage_mod.kv_write(key, {"k": key})
        self.assertEqual(
            sorted(x.name for x in self.kv_meta_dir.glob("*.json")),
            ["continent.json", "quiz.json"])
        self.assertEqual(len(storage_mod._read_json(self.kv_meta_dir / "quiz.json", {})), 2)
        self.assertEqual(len(storage_mod._read_json(self.kv_meta_dir / "continent.json", {})), 6)
        # 写一个大族键不再翻出主文件里的小全局键
        self.assertFalse(self.kv_path.exists())

    def test_family_write_does_not_rewrite_other_family(self):
        # T214 核心收益：写 socratic 族不碰 quiz/continent 族文件的字节
        storage_mod.kv_write("phymathia_quiz_bank", {"questions": [1, 2, 3]})
        before = (self.kv_meta_dir / "quiz.json").read_bytes()
        storage_mod.kv_write("socratic:sess_x", {"active": True})
        self.assertEqual((self.kv_meta_dir / "quiz.json").read_bytes(), before)

    def test_unknown_global_key_stays_in_main_file(self):
        storage_mod.kv_write("node_recipes", {"r": 1})
        self.assertTrue(self.kv_path.exists())
        self.assertFalse(self.kv_meta_dir.exists() and any(self.kv_meta_dir.iterdir()))
        self.assertEqual(storage_mod.kv_read("node_recipes"), {"r": 1})

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
            "node_recipes": {"r": 2},
        })
        moved = storage_mod.kv_migrate_split_keys()
        self.assertEqual(moved, 2)
        main = storage_mod._read_json(self.kv_path, {})
        self.assertEqual(set(main.keys()), {"node_recipes"})
        self.assertEqual(storage_mod.kv_read("graph:sess_old"), {"n": 1})
        self.assertEqual(storage_mod.kv_read("harness_history:sess_old"), [{"a": 1}])
        # 幂等：再跑一次搬 0 个
        self.assertEqual(storage_mod.kv_migrate_split_keys(), 0)

    def test_migration_moves_family_keys_to_meta_files(self):
        # T214：主文件里的 socratic:/mem:/quiz/continent_* 一键不剩地搬进族文件
        storage_mod._write_json(self.kv_path, {
            "socratic:sess_old": {"active": True},
            "mem:sess_old": {"summary": "s"},
            "phymathia_quiz_bank": {"questions": []},
            "continent_edges": {"edges": []},
            "phymathia_current_session": "sess_old",
        })
        moved = storage_mod.kv_migrate_split_keys()
        self.assertEqual(moved, 4)
        self.assertEqual(set(storage_mod._read_json(self.kv_path, {})),
                         {"phymathia_current_session"})
        self.assertEqual(storage_mod.kv_read("socratic:sess_old"), {"active": True})
        self.assertEqual(storage_mod.kv_read("mem:sess_old"), {"summary": "s"})
        self.assertEqual(storage_mod.kv_read("phymathia_quiz_bank"), {"questions": []})
        self.assertEqual(storage_mod.kv_read("continent_edges"), {"edges": []})

    def test_migration_no_main_file_is_noop(self):
        self.assertEqual(storage_mod.kv_migrate_split_keys(), 0)


class _WarnCapture(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(record)


class MainFileBloatGuardTest(KvSplitBase):
    """T223 守卫：名单外重键回落主文件时告警（每进程每账号至多一次）；
    拆分层写入永不触发；阈值为模块常量，测试缩小到 KB 级。"""

    def setUp(self):
        super().setUp()
        self._orig_thresholds = (storage_mod._KV_MAIN_BLOAT_TOTAL_BYTES,
                                 storage_mod._KV_MAIN_HEAVY_VALUE_BYTES)
        storage_mod._KV_MAIN_BLOAT_TOTAL_BYTES = 2048
        storage_mod._KV_MAIN_HEAVY_VALUE_BYTES = 1024
        storage_mod._KV_BLOAT_WARNED.clear()

    def tearDown(self):
        (storage_mod._KV_MAIN_BLOAT_TOTAL_BYTES,
         storage_mod._KV_MAIN_HEAVY_VALUE_BYTES) = self._orig_thresholds
        storage_mod._KV_BLOAT_WARNED.clear()
        super().tearDown()

    def test_write_unrouted_heavy_key_warns_once(self):
        with self.assertLogs(storage_mod.logger, level="WARNING") as cm:
            storage_mod.kv_write("big_stats", {"blob": "x" * 4096})
        self.assertEqual(len(cm.records), 1)
        self.assertIn("T223", cm.output[0])
        self.assertIn("big_stats", cm.output[0])
        # 每进程每账号至多一次：再写不重复告警
        cap = _WarnCapture()
        storage_mod.logger.addHandler(cap)
        try:
            storage_mod.kv_write("big_stats", {"blob": "y" * 4096})
        finally:
            storage_mod.logger.removeHandler(cap)
        self.assertEqual(cap.records, [])

    def test_heavy_single_value_triggers_below_total(self):
        storage_mod._KV_MAIN_BLOAT_TOTAL_BYTES = 10 * 1024 * 1024  # 总量过不了，单键也能触发
        with self.assertLogs(storage_mod.logger, level="WARNING"):
            storage_mod.kv_write("mid_stats", {"blob": "x" * 2048})

    def test_write_split_layer_never_warns(self):
        cap = _WarnCapture()
        storage_mod.logger.addHandler(cap)
        try:
            storage_mod.kv_write("graph:sess_big", {"blob": "x" * 4096})
            storage_mod.kv_write("phymathia_quiz_bank", {"blob": "x" * 4096})
            storage_mod.kv_write("continent_edges", {"blob": "x" * 4096})
        finally:
            storage_mod.logger.removeHandler(cap)
        self.assertEqual(cap.records, [])
        self.assertFalse(self.kv_path.exists())  # 主文件未因这些写而创建

    def test_migrate_warns_on_unrouted_heavy_leftover(self):
        # 启动检查：名单外重键留守主文件（迁移只搬名单内键）→ 告警点名
        storage_mod._write_json(self.kv_path, {
            "big_stats": {"blob": "x" * 4096},
            "node_recipes": {"r": 1},
        })
        with self.assertLogs(storage_mod.logger, level="WARNING") as cm:
            self.assertEqual(storage_mod.kv_migrate_split_keys(), 0)
        self.assertIn("big_stats", cm.output[0])

    def test_migrate_steady_state_no_warning(self):
        storage_mod._write_json(self.kv_path, {"node_recipes": {"r": 1}})
        cap = _WarnCapture()
        storage_mod.logger.addHandler(cap)
        try:
            self.assertEqual(storage_mod.kv_migrate_split_keys(), 0)
        finally:
            storage_mod.logger.removeHandler(cap)
        self.assertEqual(cap.records, [])

    def test_restore_bulk_warns_on_heavy_global_keys(self):
        with self.assertLogs(storage_mod.logger, level="WARNING") as cm:
            storage_mod.kv_restore_bulk({"big_stats": {"blob": "x" * 4096}}, replace=False)
        self.assertIn("big_stats", cm.output[0])


class SplitRouteCoverageTest(unittest.TestCase):
    """T223 覆盖断言：src/ 与 harness/ 里 kv_read/write/delete 的字面量键、
    f-string/拼接的静态前缀、可同文件解析的全大写常量键，必须落在拆分层
    （会话/前缀族/独键族）或登记进 MAIN_FILE_ALLOWLIST——让「新键留守主文件」
    成为显式决定而非静默回落。漏网形态：变量传参的动态键与前端经通用 KV
    接口写的键（Python 源码扫不到），由运行期 _kv_warn_main_bloat 兜底。"""

    # 允许留守主文件的字面量键（2026-11-01 起为空：现有 Python 调用点全部已路由；
    # tasks:global/node_recipes 等主文件常客由前端经通用接口写，不在扫描面内）。
    MAIN_FILE_ALLOWLIST: set = set()

    def _iter_sources(self):
        for base in ("src", "harness"):
            for p in sorted(Path(base).rglob("*.py")):
                if "__pycache__" not in p.parts:
                    yield p

    def test_kv_call_site_keys_route_or_allowlisted(self):
        call_re = re.compile(r'kv_(?:read|write|delete)\(\s*(f?)(["\'])([^"\'\n]+)\2\s*(\+?)')
        const_re = re.compile(r'kv_(?:read|write|delete)\(\s*([A-Z][A-Z0-9_]{2,})\b')
        bad = []
        for path in self._iter_sources():
            text = path.read_text(encoding="utf-8")
            for m in call_re.finditer(text):
                is_f, _quote, raw, concat = m.groups()
                line = text[:m.start()].count("\n") + 1
                if is_f or concat:
                    # 静态前缀（f"graph:{sid}"、"graph:" + sid）：前缀须命中某个拆分层
                    prefix = raw.split("{", 1)[0]
                    routed = (storage_mod._kv_split_session(prefix + "x") is not None
                              or any(prefix.startswith(fp) for fp in storage_mod._KV_FAMILY_PREFIXES)
                              or prefix in storage_mod._KV_SOLO_KEYS)
                    if not routed:
                        bad.append(f"{path}:{line} unrouted prefix {prefix!r}")
                    continue
                if (storage_mod._kv_target_path(raw) is None
                        and raw not in self.MAIN_FILE_ALLOWLIST):
                    bad.append(f"{path}:{line} unrouted key {raw!r}")
            for m in const_re.finditer(text):
                name = m.group(1)
                line = text[:m.start()].count("\n") + 1
                dm = re.search(rf"^{name}\s*=\s*(f?)([\"'])([^\"'\n]+)\2", text, re.M)
                if not dm:
                    bad.append(f"{path}:{line} CONST {name} unresolvable in-file "
                               f"(inline the literal or extend the scanner)")
                    continue
                key = dm.group(3)
                if (storage_mod._kv_target_path(key) is None
                        and key not in self.MAIN_FILE_ALLOWLIST):
                    bad.append(f"{path}:{line} CONST {name}={key!r} unrouted")
        self.assertEqual(bad, [])


class AllDataAndRestoreTest(KvSplitBase):
    def test_all_data_merges_main_and_session_files(self):
        storage_mod.kv_write("graph:sess_m", {"x": 1})
        storage_mod.kv_write("global:key", "v")
        data = storage_mod.kv_all_data()
        self.assertEqual(data["graph:sess_m"], {"x": 1})
        self.assertEqual(data["global:key"], "v")

    def test_all_data_merges_meta_files(self):
        storage_mod.kv_write("socratic:sess_m", {"active": True})
        storage_mod.kv_write("phymathia_quiz_bank", {"questions": [1]})
        data = storage_mod.kv_all_data()
        self.assertEqual(data["socratic:sess_m"], {"active": True})
        self.assertEqual(data["phymathia_quiz_bank"], {"questions": [1]})

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

    def test_restore_bulk_replace_clears_meta_files(self):
        # T214：replace 时族文件一并清空重落，旧族键不残留
        storage_mod.kv_write("socratic:sess_old", {"active": True})
        storage_mod.kv_write("phymathia_quiz_bank", {"questions": [1]})
        storage_mod.kv_restore_bulk({"g:k": 2}, replace=True)
        self.assertIsNone(storage_mod.kv_read("socratic:sess_old"))
        self.assertIsNone(storage_mod.kv_read("phymathia_quiz_bank"))
        self.assertEqual(sorted(x.name for x in self.kv_meta_dir.glob("*.json")), [])

    def test_restore_bulk_routes_family_keys(self):
        storage_mod.kv_restore_bulk({"socratic:sess_n": {"active": True},
                                     "mem:sess_n": {"summary": "s"},
                                     "g:k": 2}, replace=False)
        self.assertEqual(storage_mod.kv_read("socratic:sess_n"), {"active": True})
        self.assertEqual(storage_mod.kv_read("mem:sess_n"), {"summary": "s"})
        self.assertEqual(storage_mod.kv_read("g:k"), 2)

    def test_restore_bulk_non_dict_noop(self):
        self.assertEqual(storage_mod.kv_restore_bulk("junk", True), 0)


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
        storage_mod.kv_write("socratic:sess_rt", {"active": True})
        storage_mod.kv_write("g:k", "v")
        payload = backup_mod._build_backup_payload()
        self.assertIn("graph:sess_rt", payload["kv"])
        self.assertIn("socratic:sess_rt", payload["kv"])
        self.assertIn("g:k", payload["kv"])
        # 破坏现场后恢复
        storage_mod.kv_delete("graph:sess_rt")
        storage_mod.kv_delete("socratic:sess_rt")
        storage_mod.kv_delete("g:k")
        self.assertIsNone(storage_mod.kv_read("graph:sess_rt"))
        backup_mod._restore_backup(
            {"kv": payload["kv"], "sessions": {}, "messages": {}, "knowledge": {}, "formulas": {}, "profiles": {}},
            replace=False,
        )
        self.assertEqual(storage_mod.kv_read("graph:sess_rt"), {"connections": [1]})
        self.assertEqual(storage_mod.kv_read("socratic:sess_rt"), {"active": True})
        self.assertEqual(storage_mod.kv_read("g:k"), "v")


if __name__ == "__main__":
    unittest.main()
