"""阶段1画像管理、持久化与旧数据边界；仅使用隔离临时目录。"""

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

import pytest

from test_review_profile_stage0 import RouteTestBase, profile_mod
from server import storage


REJECTED = {"changed": 0, "promoted": [], "accepted": False}


def item(fid, **extra):
    return {"id": fid, "fact": fid, "category": "interest", **extra}


class ReviewStage1ProfileTest(RouteTestBase):
    dev = "stage1"

    def seed(self, **extra):
        raw = {"enabled": False, "explicit": {"stage": "高三", "future": [1]},
               "facts": [item("f", status="idle")], "pending": [item("p")],
               "archive": [item("a", removedAt=1700000000)],
               "future": {"keep": True}, "updatedAt": 17, **extra}
        profile_mod._profile_path(self.dev).write_text(json.dumps(raw), encoding="utf-8")
        return raw

    def disk(self):
        return json.loads(profile_mod._profile_path(self.dev).read_text(encoding="utf-8"))

    def manage(self, action, fid):
        return profile_mod.manage_profile_fact(self.dev, action, fid)

    def test_six_actions_while_disabled_preserve_unrelated_fields(self):
        for action, key, fid in (("delete_fact", "facts", "f"),
                                ("restore_fact", "facts", "f"),
                                ("confirm_pending", "pending", "p"),
                                ("delete_pending", "pending", "p"),
                                ("restore_archive", "archive", "a"),
                                ("delete_archive", "archive", "a")):
            with self.subTest(action=action):
                before = self.seed()
                r = self.manage(action, fid)
                self.assertEqual(r["accepted"], True)
                self.assertEqual(r["changed"], 1)
                after = self.disk()
                for field in ("enabled", "explicit", "future"):
                    self.assertEqual(after[field], before[field])
                affected = {key}
                if action == "confirm_pending":
                    affected.add("facts")
                    solid = after["facts"][-1]
                    self.assertEqual((solid["id"], solid["occurrences"], solid["status"]),
                                     ("p", 2, "active"))
                    self.assertEqual(r["promoted"], ["p"])
                else:
                    self.assertEqual(r["promoted"], [])
                if action == "restore_archive":
                    affected.add("pending")
                    restored = after["pending"][-1]
                    self.assertNotEqual(restored["id"], "a")
                    self.assertEqual((restored["occurrences"], restored["source"]), (1, "restored"))
                if action == "restore_fact":
                    self.assertEqual(after["facts"][0]["status"], "active")
                    self.assertGreater(after["facts"][0]["lastUsedAt"], 0)
                for field in {"facts", "pending", "archive"} - affected:
                    self.assertEqual(after[field], before[field])

    def test_missing_and_wrong_list_ids_do_not_write(self):
        self.seed()
        path = profile_mod._profile_path(self.dev)
        before = path.read_bytes()
        with patch.object(storage, "_write_json", wraps=storage._write_json) as write:
            for action in profile_mod.MANAGE_ACTIONS:
                self.assertEqual(self.manage(action, "missing"), REJECTED)
            self.assertEqual(self.manage("confirm_pending", "f"), REJECTED)
            self.assertEqual(self.manage("delete_fact", " f "), REJECTED)
            write.assert_not_called()
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(profile_mod.manage_profile_fact("absent", "delete_fact", "x"), REJECTED)
        self.assertFalse(profile_mod._profile_path("absent").exists())

    def test_capacity_rejects_without_any_data_loss(self):
        for action, key, limit, fid in (("confirm_pending", "facts", profile_mod.MAX_FACTS, "p"),
                                       ("restore_archive", "pending", profile_mod.MAX_PENDING, "a")):
            for count in (limit - 1, limit, limit + 1):
                with self.subTest(action=action, count=count):
                    before = self.seed(**{key: [item(f"keep{i}") for i in range(count)]})
                    path = profile_mod._profile_path(self.dev)
                    contents = path.read_bytes()
                    with patch.object(storage, "_write_json", wraps=storage._write_json) as write:
                        r = self.manage(action, fid)
                        if count >= limit:
                            self.assertEqual(r, REJECTED)
                            write.assert_not_called()
                            self.assertEqual(path.read_bytes(), contents)
                        else:
                            self.assertTrue(r["accepted"])
                            self.assertEqual(self.disk()[key][:-1], before[key])
                            self.assertEqual(len(self.disk()[key]), limit)

    def test_delete_does_not_truncate_overfull_or_dirty_unrelated_lists(self):
        before = self.seed(pending=[item(str(i)) for i in range(profile_mod.MAX_PENDING + 3)],
                           archive=[item(str(i)) for i in range(profile_mod.MAX_ARCHIVE + 3)])
        before["facts"].append({"id": "dirty", "history": False, "occurrences": "三次"})
        profile_mod._profile_path(self.dev).write_text(json.dumps(before), encoding="utf-8")
        self.manage("delete_fact", "f")
        after = self.disk()
        self.assertEqual(after["pending"], before["pending"])
        self.assertEqual(after["archive"], before["archive"])
        self.assertEqual(after["facts"], before["facts"][1:])

    def test_same_text_at_capacity_only_removes_source(self):
        for action, key, limit, fid in (("confirm_pending", "facts", profile_mod.MAX_FACTS, "p"),
                                       ("restore_archive", "pending", profile_mod.MAX_PENDING, "a")):
            with self.subTest(action=action):
                values = [item(str(i)) for i in range(limit)]
                values[0]["fact"] = fid
                before = self.seed(**{key: values})
                r = self.manage(action, fid)
                self.assertEqual(r, {"accepted": True, "changed": 1, "promoted": []})
                after = self.disk()
                self.assertEqual(after[key], before[key])
                self.assertEqual(after["pending" if action == "confirm_pending" else "archive"], [])

    def test_two_clients_interleave_without_resurrection_or_settings_rollback(self):
        self.seed(enabled=True, facts=[item("f"), item("g")])
        snapshot = profile_mod.get_profile(self.dev)
        self.manage("delete_fact", "g")
        profile_mod.apply_profile_ops(self.dev, [{"fact": "目标新", "category": "goal"}])
        profile_mod.update_profile(self.dev, {"enabled": False, "explicit": {"goal": "考研"}})
        self.manage("delete_fact", snapshot["facts"][0]["id"])
        final = self.disk()
        self.assertEqual([f["fact"] for f in final["facts"]], ["目标新"])
        self.assertFalse(final["enabled"])
        self.assertEqual(final["explicit"]["goal"], "考研")

    def test_simultaneous_confirm_and_delete_have_single_winner(self):
        for _ in range(5):
            self.seed()
            gate = Barrier(2)

            def run(action):
                gate.wait(timeout=3)
                return self.manage(action, "p")

            with ThreadPoolExecutor(max_workers=2) as pool:
                futures = [pool.submit(run, a) for a in ("confirm_pending", "delete_pending")]
                results = [f.result(timeout=5) for f in futures]
            self.assertEqual(sum(r["accepted"] for r in results), 1)
            self.assertEqual(sum(r["changed"] for r in results), 1)
            final = self.disk()
            self.assertEqual(final["pending"], [])
            self.assertEqual(len(final["facts"]), 1 + int(bool(results[0]["promoted"])))

    def test_simultaneous_collection_and_manage_preserve_both_changes(self):
        self.seed(enabled=True)
        gate = Barrier(2)

        def collect():
            gate.wait(timeout=3)
            return profile_mod.apply_profile_ops(self.dev, [{"fact": "新目标", "category": "goal"}])

        def remove():
            gate.wait(timeout=3)
            return self.manage("delete_fact", "f")

        with ThreadPoolExecutor(max_workers=2) as pool:
            a, b = pool.submit(collect), pool.submit(remove)
            self.assertEqual(a.result(timeout=5)["changed"], 1)
            self.assertTrue(b.result(timeout=5)["accepted"])
        self.assertEqual([f["fact"] for f in self.disk()["facts"]], ["新目标"])

    def test_invalid_arguments_and_storage_failure_are_not_success(self):
        self.seed()
        for action, fid in (("CONFIRM_PENDING", "p"), ("remove", "p"),
                            (None, "p"), ([], "p"), ("delete_fact", ""),
                            ("delete_fact", 1)):
            with self.subTest(action=action, fid=fid), self.assertRaises(ValueError):
                self.manage(action, fid)
        before = self.disk()
        with patch.object(storage, "_write_json", side_effect=OSError("disk full")):
            with self.assertRaisesRegex(OSError, "disk full"):
                self.manage("confirm_pending", "p")
        self.assertEqual(self.disk(), before)

    def test_duplicate_new_updates_time_count_and_batch_semantics(self):
        with patch.object(profile_mod.time, "time", return_value=1700000000):
            profile_mod.apply_profile_ops(self.dev, [{"fact": "我是高二学生", "category": "stage"}])
        with patch.object(profile_mod.time, "time", return_value=1700000100):
            r = profile_mod.apply_profile_ops(self.dev, [{"fact": "用户是高二学生", "category": "stage"}])
        self.assertEqual(r, {"changed": 1, "promoted": []})
        solid = self.disk()["facts"][0]
        self.assertEqual((solid["occurrences"], solid["createdAt"], solid["updatedAt"]),
                         (2, 1700000000, 1700000100))
        r = profile_mod.apply_profile_ops(self.dev, [{"fact": "喜欢几何"}] * 2)
        self.assertEqual(r, {"changed": 2, "promoted": ["喜欢几何"]})

    def test_disabled_collection_still_ignored_and_restore_refreshes_clock(self):
        self.seed()
        before = self.disk()
        self.assertEqual(profile_mod.apply_profile_ops(self.dev,
                         [{"fact": "不可采集", "category": "stage"}]),
                         {"changed": 0, "promoted": []})
        self.assertEqual(self.disk(), before)
        with patch.object(profile_mod.time, "time", return_value=1700000000):
            self.assertEqual(self.manage("restore_fact", "f")["changed"], 1)
            with patch.object(storage, "_write_json", wraps=storage._write_json) as write:
                self.assertEqual(self.manage("restore_fact", "f"),
                                 {"changed": 0, "promoted": [], "accepted": True})
                write.assert_not_called()
        with patch.object(profile_mod.time, "time", return_value=1700000010):
            self.assertEqual(self.manage("restore_fact", "f")["changed"], 1)
        self.assertEqual(self.disk()["facts"][0]["lastUsedAt"], 1700000010)

    def test_legacy_seconds_and_milliseconds_have_same_idle_decision(self):
        now = 1700000000
        for factor in (1, 1000):
            with self.subTest(factor=factor):
                self.seed(enabled=True, facts=[
                    item("old", status="active", createdAt=(now - 40 * 86400) * factor),
                    item("recent", status="active", lastUsedAt=(now - 86400) * factor)])
                with patch.object(profile_mod.time, "time", return_value=now):
                    profile_mod.mark_profile_used(self.dev, [])
                self.assertEqual([f["status"] for f in self.disk()["facts"]], ["idle", "active"])

    def test_archive_seconds_milliseconds_and_missing_remain_stable(self):
        for removed, expected in ((1700000000, 1700000000), (1700000000000, 1700000000),
                                  (None, None), ("", None)):
            with self.subTest(removed=removed):
                self.seed(archive=[item("a", removedAt=removed), item("legacy")])
                before = profile_mod._profile_path(self.dev).read_bytes()
                p = profile_mod.get_profile(self.dev)
                self.assertEqual(p["archive"][0]["removedAt"], expected)
                self.assertIsNone(p["archive"][1]["removedAt"])
                self.assertEqual(profile_mod._profile_path(self.dev).read_bytes(), before)
                profile_mod.update_profile(self.dev, {"explicit": {"goal": "新目标"}})
                self.assertEqual(profile_mod.get_profile(self.dev)["archive"][0]["removedAt"], expected)


@pytest.mark.parametrize("value,expected", [("3.5", 3), ("2", 2), (0, 1), (-3, 1),
    (True, 1), (False, 1), (None, 1), ([], 1), ({}, 1), ("三次", 1),
    (float("inf"), 1), (float("nan"), 1), (10**400, 1), (1e100, 2**31 - 1)])
def test_numeric_count_boundaries(value, expected):
    result = profile_mod._normalize_fact_item(item("x", occurrences=value))
    assert result["occurrences"] == expected


@pytest.mark.parametrize("value,expected", [("1700000000.5", 1700000000.5),
    (1700000000500, 1700000000.5), (0, 0), (-1, 0), (True, 0), ([], 0),
    ({}, 0), (None, 0), ("", 0), ("昨天", 0), (float("nan"), 0),
    (float("inf"), 0), (1e100, 0), (10**400, 0), (253402300799000, 253402300799)])
def test_time_boundaries_every_numeric_field(value, expected):
    raw = item("x", createdAt=value, updatedAt=value, lastUsedAt=value,
               history=[{"fact": "old", "at": value}])
    result = profile_mod._normalize_fact_item(raw)
    for key in ("createdAt", "updatedAt", "lastUsedAt"):
        assert result[key] == expected
    assert result["history"][0]["at"] == expected
    profile = profile_mod._normalize_profile({"createdAt": value, "updatedAt": value, "version": value})
    assert profile["createdAt"] == profile["updatedAt"] == expected
    assert isinstance(profile["version"], int)


@pytest.mark.parametrize("history", [True, 3, None, "abc", {"at": 123}, []])
def test_non_list_history_is_empty(history):
    assert profile_mod._normalize_fact_item(item("x", history=history))["history"] == []
