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
        self.assertNotIn("items", preview)
        self.assertEqual((self.root / "sessions.json").read_bytes(), before)

    def test_manual_preview_lists_only_differing_items(self):
        self._write("sessions.json", {
            "s1": {"id": "s1", "title": "现有标题", "updatedAt": 300},
            "s2": {"id": "s2", "title": "相同", "updatedAt": 100},
        })
        self._write("knowledge.json", {
            "k1": {"id": "k1", "title": "现有知识", "updatedAt": 300},
            "k2": {"id": "k2", "title": "相同", "updatedAt": 100},
        })
        self._write("formulas.json", {
            "f1": {"id": "f1", "latex": "$a$", "updatedAt": 300},
        })
        self._write("messages/s1.json", [
            {"role": "user", "content": "现有内容", "timestamp": 100},
            {"role": "assistant", "content": "相同", "timestamp": 200},
        ])
        storage_mod.kv_write("graph:s1", {"updatedAt": 300, "customNodes": ["new"]})
        preview = backup_mod._preview_backup({
            "sessions": {
                "s1": {"id": "s1", "title": "备份标题", "updatedAt": 200},
                "s2": {"id": "s2", "title": "相同", "updatedAt": 100},
            },
            "knowledge": {
                "k1": {"id": "k1", "title": "备份知识", "updatedAt": 200},
                "k2": {"id": "k2", "title": "相同", "updatedAt": 100},
            },
            "formulas": {"f1": {"id": "f1", "latex": "$b$", "updatedAt": 200}},
            "messages": {"s1": [
                {"role": "user", "content": "备份内容", "timestamp": 100},
                {"role": "assistant", "content": "相同", "timestamp": 200},
            ]},
            "kv": {"graph:s1": {"updatedAt": 200, "customNodes": ["old"]}},
        }, replace=False, conflict="manual")
        self.assertEqual(preview["conflict"], "manual")
        items = preview["items"]
        by_id = {(item["kind"], item["id"]): item for item in items}
        self.assertEqual(set(by_id), {
            ("sessions", "s1"), ("knowledge", "k1"), ("formulas", "f1"),
            ("messages", "s1|ts:100"), ("graphs", "graph:s1"),
        })
        self.assertEqual(by_id[("sessions", "s1")]["label"], "备份标题")
        self.assertEqual(by_id[("sessions", "s1")]["currentLabel"], "现有标题")
        self.assertEqual(by_id[("sessions", "s1")]["currentTs"], 300)
        self.assertEqual(by_id[("sessions", "s1")]["backupTs"], 200)
        self.assertEqual(by_id[("messages", "s1|ts:100")]["label"], "我：备份内容")
        self.assertEqual(by_id[("messages", "s1|ts:100")]["currentLabel"], "我：现有内容")

    def test_manual_decisions_override_newer_per_item(self):
        self._write("sessions.json", {
            "s1": {"id": "s1", "title": "当前 s1", "updatedAt": 300},
            "s2": {"id": "s2", "title": "当前 s2", "updatedAt": 300},
        })
        self._write("knowledge.json", {
            "k1": {"id": "k1", "title": "当前 k1", "updatedAt": 300},
            "k2": {"id": "k2", "title": "当前 k2", "updatedAt": 300},
        })
        self._write("formulas.json", {
            "f1": {"id": "f1", "latex": "$current$", "updatedAt": 300},
            "f2": {"id": "f2", "latex": "$current2$", "updatedAt": 300},
        })
        storage_mod.kv_write("graph:s1", {"updatedAt": 300, "customNodes": ["current"]})
        storage_mod.kv_write("graph:s2", {"updatedAt": 300, "customNodes": ["current2"]})

        backup_mod._restore_backup({
            "sessions": {
                "s1": {"id": "s1", "title": "备份 s1", "updatedAt": 200},
                "s2": {"id": "s2", "title": "备份 s2", "updatedAt": 200},
            },
            "knowledge": {
                "k1": {"id": "k1", "title": "备份 k1", "updatedAt": 200},
                "k2": {"id": "k2", "title": "备份 k2", "updatedAt": 200},
            },
            "formulas": {
                "f1": {"id": "f1", "latex": "$backup$", "updatedAt": 200},
                "f2": {"id": "f2", "latex": "$backup2$", "updatedAt": 200},
            },
            "kv": {
                "graph:s1": {"updatedAt": 200, "customNodes": ["backup"]},
                "graph:s2": {"updatedAt": 200, "customNodes": ["backup2"]},
            },
        }, replace=False, conflict="manual", decisions={
            "sessions": {"s1": "backup"},
            "knowledge": {"k1": "backup"},
            "formulas": {"f1": "backup"},
            "graphs": {"graph:s1": "backup"},
        })

        sessions = _read(self.root / "sessions.json")
        self.assertEqual(sessions["s1"]["title"], "备份 s1")
        self.assertEqual(sessions["s2"]["title"], "当前 s2")
        knowledge = _read(self.root / "knowledge.json")
        self.assertEqual(knowledge["k1"]["title"], "备份 k1")
        self.assertEqual(knowledge["k2"]["title"], "当前 k2")
        formulas = _read(self.root / "formulas.json")
        self.assertEqual(formulas["f1"]["latex"], "$backup$")
        self.assertEqual(formulas["f2"]["latex"], "$current2$")
        self.assertEqual(storage_mod.kv_read("graph:s1")["customNodes"], ["backup"])
        self.assertEqual(storage_mod.kv_read("graph:s2")["customNodes"], ["current2"])

    def test_manual_decisions_can_force_current_for_newer_backup(self):
        self._write("knowledge.json", {
            "k1": {"id": "k1", "title": "当前旧版", "updatedAt": 200},
        })
        backup_mod._restore_backup({
            "sessions": {},
            "knowledge": {"k1": {"id": "k1", "title": "备份新版", "updatedAt": 300}},
        }, replace=False, conflict="manual", decisions={
            "knowledge": {"k1": "current"},
        })
        self.assertEqual(_read(self.root / "knowledge.json")["k1"]["title"], "当前旧版")

    def test_decisions_ignored_outside_manual_mode(self):
        self._write("knowledge.json", {
            "k1": {"id": "k1", "title": "当前较新", "updatedAt": 300},
        })
        backup_mod._restore_backup({
            "sessions": {},
            "knowledge": {"k1": {"id": "k1", "title": "备份较旧", "updatedAt": 200}},
        }, replace=False, conflict="newer", decisions={
            "knowledge": {"k1": "backup"},
        })
        self.assertEqual(_read(self.root / "knowledge.json")["k1"]["title"], "当前较新")

    def test_manual_message_decision_picks_content_per_message(self):
        self._write("sessions.json", {
            "s1": {"id": "s1", "title": "会话", "updatedAt": 100},
        })
        self._write("messages/s1.json", [
            {"role": "user", "content": "当前同刻", "timestamp": 100},
            {"role": "assistant", "content": "当前独有", "timestamp": 200},
        ])
        backup_mod._restore_backup({
            "sessions": {},
            "messages": {"s1": [
                {"role": "user", "content": "备份同刻", "timestamp": 100},
                {"role": "assistant", "content": "备份独有", "timestamp": 300},
            ]},
        }, replace=False, conflict="manual", decisions={
            "messages": {"s1|ts:100": "backup"},
        })
        msgs = _read(self.root / "messages" / "s1.json")
        self.assertEqual([m["timestamp"] for m in msgs], [100, 200, 300])
        by_ts = {m["timestamp"]: m["content"] for m in msgs}
        self.assertEqual(by_ts[100], "备份同刻")
        self.assertEqual(by_ts[200], "当前独有")
        self.assertEqual(by_ts[300], "备份独有")


class AutoBackupRouteTest(RouteTestBase):
    def setUp(self):
        super().setUp()
        self.root = Path(self._td.name) / "users" / "default"

    def test_import_route_accepts_manual_conflict_and_decisions(self):
        self.root.mkdir(parents=True, exist_ok=True)
        storage_mod._write_json(self.root / "sessions.json", {
            "s1": {"id": "s1", "title": "当前", "updatedAt": 300},
        })
        backup = {
            "sessions": {"s1": {"id": "s1", "title": "备份", "updatedAt": 200}},
        }
        preview = self.client.post("/api/backup/preview", json={
            "mode": "merge", "conflict": "manual", "backup": backup,
        })
        self.assertEqual(preview.status_code, 200, preview.text)
        self.assertEqual(preview.json()["items"][0]["id"], "s1")

        imported = self.client.post("/api/backup/import", json={
            "mode": "merge", "conflict": "manual",
            "decisions": {"sessions": {"s1": "backup"}},
            "auto_backup": False,
            "backup": backup,
        })
        self.assertEqual(imported.status_code, 200, imported.text)
        self.assertEqual(_read(self.root / "sessions.json")["s1"]["title"], "备份")

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
