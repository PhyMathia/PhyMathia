"""备份导入防丢回归（583/584，2026-11-24）。

覆盖三件事：
- 合并导入按时间合并消息，不整份覆盖（584）；
- 会话/知识/公式/画布同 id 冲突默认取新，显式「以备份为准」才覆盖（584）；
- 导入前自动备份、列表与恢复（583）。
"""

import json
import unittest
from pathlib import Path

from route_test_base import RouteTestBase

from server import backup as backup_mod
from server import storage as storage_mod


def _read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


class BackupMergeTest(RouteTestBase):
    def setUp(self):
        super().setUp()
        self.root = Path(self._td.name) / "users" / "default"

    def _write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        storage_mod._write_json(path, data)
        return path

    def test_merge_messages_keeps_both_sides_and_sorts(self):
        self._write("sessions.json", {
            "s1": {"id": "s1", "title": "现有标题", "createdAt": 1, "updatedAt": 300},
        })
        self._write("messages/s1.json", [
            {"role": "user", "content": "一", "timestamp": 100},
            {"role": "assistant", "content": "三", "timestamp": 300},
        ])
        result = backup_mod._restore_backup({
            "sessions": {"s1": {"id": "s1", "title": "旧备份标题",
                                "createdAt": 1, "updatedAt": 200}},
            "messages": {"s1": [
                {"role": "user", "content": "一", "timestamp": 100},
                {"role": "assistant", "content": "二", "timestamp": 200},
            ]},
        }, replace=False)
        self.assertTrue(result["ok"])
        # 旧备份不能把服务端较新的会话标题盖回去
        sessions = _read(self.root / "sessions.json")
        self.assertEqual(sessions["s1"]["title"], "现有标题")
        # 两边独有的消息都保留，并按时间升序
        msgs = _read(self.root / "messages" / "s1.json")
        self.assertEqual([m["timestamp"] for m in msgs], [100, 200, 300])

    def test_backup_conflict_can_win_explicitly(self):
        self._write("sessions.json", {
            "s1": {"id": "s1", "title": "现有标题", "createdAt": 1, "updatedAt": 300},
        })
        self._write("messages/s1.json", [
            {"role": "user", "content": "现有内容", "timestamp": 100},
        ])
        backup_mod._restore_backup({
            "sessions": {"s1": {"id": "s1", "title": "备份标题",
                                "createdAt": 1, "updatedAt": 200}},
            "messages": {"s1": [
                {"role": "user", "content": "备份内容", "timestamp": 100},
            ]},
        }, replace=False, conflict="backup")
        sessions = _read(self.root / "sessions.json")
        self.assertEqual(sessions["s1"]["title"], "备份标题")
        msgs = _read(self.root / "messages" / "s1.json")
        self.assertEqual(msgs[0]["content"], "备份内容")

    def test_newer_wins_for_knowledge_formulas_and_graphs(self):
        self._write("knowledge.json", {
            "k1": {"id": "k1", "title": "新知识", "updatedAt": 300, "createdAt": 1},
        })
        self._write("formulas.json", {
            "f1": {"id": "f1", "latex": "$E=mc^2$", "concept": "新公式",
                   "createdAt": 300},
        })
        storage_mod.kv_write("graph:s1", {"updatedAt": 300, "customNodes": ["new"]})

        backup_mod._restore_backup({
            "sessions": {},
            "messages": {},
            "knowledge": {"k1": {"id": "k1", "title": "旧知识", "updatedAt": 200, "createdAt": 1}},
            "formulas": {"f1": {"id": "f1", "latex": "$E=mc^2$", "concept": "旧公式",
                                "createdAt": 200}},
            "kv": {"graph:s1": {"updatedAt": 200, "customNodes": ["old"]}},
        }, replace=False)

        self.assertEqual(_read(self.root / "knowledge.json")["k1"]["title"], "新知识")
        self.assertEqual(_read(self.root / "formulas.json")["f1"]["concept"], "新公式")
        self.assertEqual(storage_mod.kv_read("graph:s1")["customNodes"], ["new"])

    def test_browser_shape_backup_restores_graphs_and_histories(self):
        # 浏览器导出的备份把画布放顶层 graphs/graphHistories（无 kv 桶）。此前
        # 服务端恢复只认 kv——在线导入时画布内容不入服务端存档，只活在本机缓存
        # 那一份（2026-11-24 实测：本机缓存被配额满卡掉时画布内容就丢了）。
        storage_mod.kv_write("graph:s1", {"updatedAt": 300, "customNodes": ["current"]})
        backup_mod._restore_backup({
            "sessions": {},
            "messages": {},
            "knowledge": {},
            "formulas": {},
            "graphs": {
                "s1": {"updatedAt": 200, "customNodes": ["browser"]},
                "s2": {"updatedAt": 100, "customNodes": ["other"]},
                "history_s3": ["snapshot"],
                "../evil": {"updatedAt": 1},
            },
            "graphHistories": {"s1": {"v": 2, "e": [], "c": 0, "t": 200}},
        }, replace=False)
        # s1 现值较新：584 口径保留现值；s2 照常入库存档；旧版 history_ 前缀归位
        self.assertEqual(storage_mod.kv_read("graph:s1")["customNodes"], ["current"])
        self.assertEqual(storage_mod.kv_read("graph:s2")["customNodes"], ["other"])
        self.assertEqual(storage_mod.kv_read("graph_history:s1")["v"], 2)
        self.assertEqual(storage_mod.kv_read("graph_history:s3"), ["snapshot"])
        self.assertIsNone(storage_mod.kv_read("graph:../evil"))

    def test_browser_shape_backup_replace_restores_graphs(self):
        storage_mod.kv_write("graph:old", {"updatedAt": 1, "customNodes": []})
        backup_mod._restore_backup({
            "sessions": {},
            "messages": {},
            "knowledge": {},
            "formulas": {},
            "graphs": {"s9": {"updatedAt": 5, "customNodes": ["fresh"]}},
        }, replace=True)
        self.assertIsNone(storage_mod.kv_read("graph:old"))
        self.assertEqual(storage_mod.kv_read("graph:s9")["customNodes"], ["fresh"])

    def test_preview_is_read_only_and_counts_conflicts(self):
        self._write("sessions.json", {
            "s1": {"id": "s1", "title": "现有", "updatedAt": 300},
        })
        before = (self.root / "sessions.json").read_bytes()
        preview = backup_mod._preview_backup({
            "sessions": {"s1": {"id": "s1", "title": "备份", "updatedAt": 200}},
            "messages": {"s1": [{"role": "user", "content": "x", "timestamp": 1}]},
        }, replace=False)
        self.assertEqual(preview["conflicts"]["sessions"], 1)
        self.assertEqual(preview["conflicts"]["olderInBackup"]["sessions"], 1)
        self.assertEqual(preview["incoming"]["messages"], 1)
        self.assertEqual((self.root / "sessions.json").read_bytes(), before)


class AutoBackupRouteTest(RouteTestBase):
    def setUp(self):
        super().setUp()
        self.root = Path(self._td.name) / "users" / "default"

    def test_import_creates_snapshot_and_restore_brings_it_back(self):
        self.root.mkdir(parents=True, exist_ok=True)
        storage_mod._write_json(self.root / "sessions.json", {
            "s1": {"id": "s1", "title": "导入前", "createdAt": 1, "updatedAt": 100},
        })
        (self.root / "messages").mkdir(parents=True, exist_ok=True)
        storage_mod._write_json(self.root / "messages" / "s1.json", [
            {"role": "user", "content": "导入前消息", "timestamp": 100},
        ])

        resp = self.client.post("/api/backup/import", json={
            "mode": "merge",
            "auto_backup": True,
            "backup": {
                "sessions": {"s2": {"id": "s2", "title": "导入后", "updatedAt": 200}},
                "messages": {"s2": [{"role": "user", "content": "导入后消息", "timestamp": 200}]},
            },
        })
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertIn("autoBackup", body)
        self.assertTrue(body["autoBackup"]["id"])

        snapshots = self.client.get("/api/backup/snapshots").json()["snapshots"]
        self.assertTrue(any(item["id"] == body["autoBackup"]["id"] for item in snapshots))
        self.assertEqual(len(snapshots), 1)

        restored = self.client.post(
            "/api/backup/snapshots/" + body["autoBackup"]["id"] + "/restore",
            json={})
        self.assertEqual(restored.status_code, 200, restored.text)
        sessions = _read(self.root / "sessions.json")
        self.assertIn("s1", sessions)
        self.assertNotIn("s2", sessions)
        msgs = _read(self.root / "messages" / "s1.json")
        self.assertEqual(msgs[0]["content"], "导入前消息")


if __name__ == "__main__":
    unittest.main()
