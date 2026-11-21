"""537 回归：公式删除墓碑——跨标签页删除传播。

协议（2026-11-21，仿 526 知识墓碑 / T271 会话墓碑）：
- DELETE /api/formulas/{id}（含按会话删）在删除时刻登记墓碑（trash._deleted_formulas.json）；
- POST /api/formulas 合并时「createdAt ≤ 删除时刻」的删前旧副本拒收不重建
  （公式无 updatedAt，时间戳只讲 createdAt），无时间戳的净新建放行；
- POST payload 随带客户端本地已删清单（deleted: {id: 时刻}）→ 服务端补登记并
  清掉残留条目（DELETE 失败的兜底收敛）；GET /api/formulas/deleted-ids 供前端
  清本地残留（loadFormulas 的「保留本地独有」离线收藏兜底是复活向量）；
- 删会话连带删掉的独占公式经 _delete_items_by_session(on_removed=…) 同锁内登记；
  回收站恢复随回写条目除名（trash._restore_payload_data）。
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import accounts as accounts_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import knowledge_routes as knowledge_routes_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402
from server import trash as trash_mod  # noqa: E402


def _now_ms() -> int:
    return int(time.time() * 1000)


def _formula(fid: str, created_at: int, latex: str = "E=mc^2", **extra) -> dict:
    base = {"id": fid, "latex": latex, "concept": "质能方程", "meaning": "质量与能量的等价关系",
            "meaningSource": "model", "topic": "相对论", "related": [],
            "sessionId": "", "createdAt": created_at}
    base.update(extra)
    return base


class FormulaTombstoneTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_mod.app, base_url="http://127.0.0.1")
        main_mod._json_get_cache.clear()
        self._orig_data_dir = config_mod.DATA_DIR
        self._td = tempfile.TemporaryDirectory()
        config_mod.DATA_DIR = Path(self._td.name)
        accounts_mod._ENSURED.clear()
        self.fp = Path(self._td.name) / "users" / "default" / "formulas.json"
        self.fp.parent.mkdir(parents=True, exist_ok=True)
        self.fp.write_text("{}", encoding="utf-8")

    def tearDown(self):
        config_mod.DATA_DIR = self._orig_data_dir
        accounts_mod._ENSURED.clear()
        self._td.cleanup()

    def _registry(self) -> dict:
        paths = accounts_mod.resolve_paths("default")
        return trash_mod.formula_tombstone_read(paths)

    # ---- DELETE 登记 + POST 闸门 ----

    def test_delete_registers_tombstone_and_gate_blocks_stale_copy(self):
        t0 = _now_ms() - 5000  # 删前旧副本的 createdAt（比删除时刻早 5 秒）
        storage_mod._write_json(self.fp, {"f1": _formula("f1", t0)})

        r = self.client.delete("/api/formulas/f1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(storage_mod._read_json(self.fp), {})
        reg = self._registry()
        self.assertIn("f1", reg)
        self.assertGreaterEqual(reg["f1"], t0 + 4000)  # 登记的是删除时刻，非条目 createdAt

        # 兄弟标签页残留副本（createdAt ≤ 删除时刻）推回：拒收不重建
        r = self.client.post("/api/formulas", json={"items": [_formula("f1", t0)]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(storage_mod._read_json(self.fp), {})

        # 净新建（无时间戳）放行：同 id 重建以新为准
        fresh = _formula("f1", t0)
        fresh.pop("createdAt")
        r = self.client.post("/api/formulas", json={"items": [fresh]})
        self.assertEqual(r.status_code, 200)
        self.assertIn("f1", storage_mod._read_json(self.fp))

    def test_gate_passes_fresh_created_at_after_delete(self):
        t0 = _now_ms() - 5000
        storage_mod._write_json(self.fp, {"f1": _formula("f1", t0)})
        self.client.delete("/api/formulas/f1")
        deleted_at = self._registry()["f1"]

        # createdAt 晚于删除时刻：视为改稿/重建，放行
        edited = _formula("f1", deleted_at + 1000)
        r = self.client.post("/api/formulas", json={"items": [edited]})
        self.assertEqual(r.status_code, 200)
        self.assertIn("f1", storage_mod._read_json(self.fp))

        # 删前旧副本（createdAt 更早）仍拒收：先清库再删一次
        storage_mod._write_json(self.fp, {"f1": _formula("f1", t0)})
        self.client.delete("/api/formulas/f1")
        stale = _formula("f1", self._registry()["f1"] - 1)
        r = self.client.post("/api/formulas", json={"items": [stale]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(storage_mod._read_json(self.fp), {})

    # ---- 客户端上报清单：补登记 + 残留自愈 ----

    def test_client_reported_deleted_purges_server_residue(self):
        t0 = _now_ms() - 5000
        # 模拟 DELETE 失败：条目仍留在库存，本地清单随全量推送上来
        storage_mod._write_json(self.fp, {"f1": _formula("f1", t0)})

        r = self.client.post("/api/formulas", json={
            "items": [_formula("f1", t0)],
            "deleted": {"f1": _now_ms()},
        })
        self.assertEqual(r.status_code, 200)
        # 补登记成功 + 库存残留自愈清掉
        self.assertIn("f1", self._registry())
        self.assertEqual(storage_mod._read_json(self.fp), {})

        # deleted-ids 端点（复活防线客户端半边）返回登记表
        r = self.client.get("/api/formulas/deleted-ids")
        self.assertEqual(r.status_code, 200)
        self.assertIn("f1", r.json()["deleted"])

        # 之后的旧副本推送照旧被闸门拒收
        r = self.client.post("/api/formulas", json={"items": [_formula("f1", t0)]})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(storage_mod._read_json(self.fp), {})

    def test_client_reported_deleted_sanitizes_bad_entries(self):
        now = _now_ms()
        # 脏条目：非法 id / 非法时刻 / 未来时钟——补登记不落库、非法回落 now、未来钳到 now
        r = self.client.post("/api/formulas", json={
            "items": [],
            "deleted": {"../evil": now, "f1": "not-a-number", "f2": now + 999999},
        })
        self.assertEqual(r.status_code, 200)
        reg = self._registry()
        self.assertNotIn("../evil", reg)
        self.assertIn("f1", reg)              # 非法时刻回落 now
        self.assertIn("f2", reg)
        # 未来时钟钳到处理时刻的 now（≤ 当下真时钟）
        self.assertLessEqual(reg["f2"], _now_ms())
        self.assertGreater(reg["f2"], 1_000_000_000_000)  # 且是合法毫秒时刻，非原样落库

    # ---- 按会话删除：整删条目登记 ----

    def test_delete_by_session_registers_removed_ids(self):
        t0 = _now_ms()
        storage_mod._write_json(self.fp, {
            "f1": _formula("f1", t0, latex="F=ma", sessionId="s1"),   # s1 独占 → 整条删除
            "f2": _formula("f2", t0, latex="E=mc^2", sessionId="s2"),  # 主归属非 s1 → 不动
        })

        r = self.client.delete("/api/formulas", params={"session_id": "s1"})
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["count"], 1)
        data = storage_mod._read_json(self.fp)
        self.assertEqual(set(data), {"f2"})
        # 只有整删的 f1 进墓碑：f2 还活着，不许被后续推送拒收
        reg = self._registry()
        self.assertIn("f1", reg)
        self.assertNotIn("f2", reg)

    # ---- 回收站恢复：回写条目除名 ----

    def test_trash_restore_unregisters_formula_tombstones(self):
        t0 = _now_ms() - 5000
        paths = accounts_mod.resolve_paths("default")
        trash_mod.formula_tombstone_register(paths, ["f1"])
        # 快照目录：只带 formulas.json（其余段缺失走既有空值分支）
        item_dir = Path(self._td.name) / "stone"
        item_dir.mkdir()
        (item_dir / "formulas.json").write_text(
            json.dumps({"f1": _formula("f1", t0)}), encoding="utf-8")

        trash_mod._restore_payload_data(paths, item_dir, "s1")
        # 条目回写 + 墓碑除名：恢复后的条目要能照常收写
        self.assertIn("f1", storage_mod._read_json(self.fp))
        self.assertNotIn("f1", self._registry())

    # ---- 登记表自身：TTL / 白名单 / 返回整表 ----

    def test_register_ttl_and_return_value(self):
        paths = accounts_mod.resolve_paths("default")
        old = _now_ms() - 100 * 24 * 3600 * 1000  # 100 天前，超 90 天 TTL
        reg = trash_mod.formula_tombstone_register(paths, ["f_old"], at_ms=old)
        self.assertNotIn("f_old", reg)  # 过期清理当场生效
        reg = trash_mod.formula_tombstone_register(paths, ["f_new"])
        self.assertIn("f_new", reg)
        # 非法 id 过白名单不落表
        reg = trash_mod.formula_tombstone_register(paths, ["../evil"])
        self.assertNotIn("../evil", reg)

    def test_delete_route_runs_off_loop_thread(self):
        # T240 口径守恒：删除路由的磁盘活儿仍在工作线程（墓碑登记同段，不回循环线程）
        class _Spy:
            def __init__(self, real):
                self._real = real
                self.run_thread = None

            def __call__(self, *args, **kwargs):
                self.run_thread = threading.current_thread()
                return self._real(*args, **kwargs)

        spy = _Spy(knowledge_routes_mod._mutate_json)
        orig = knowledge_routes_mod._mutate_json
        knowledge_routes_mod._mutate_json = spy
        try:
            storage_mod._write_json(self.fp, {"f1": _formula("f1", _now_ms())})
            r = self.client.delete("/api/formulas/f1")
            self.assertEqual(r.status_code, 200)
        finally:
            knowledge_routes_mod._mutate_json = orig
        self.assertIsNotNone(spy.run_thread)
        self.assertIsNot(spy.run_thread, threading.main_thread())


if __name__ == "__main__":
    unittest.main()
