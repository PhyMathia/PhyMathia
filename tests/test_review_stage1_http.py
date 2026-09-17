"""Stage 1 HTTP integration: backup/delete/restore and atomic profile management.

Run: python3 -m pytest tests/test_review_stage1_http.py -v
Each case runs in a fresh process: config is redirected BEFORE importing main
(main performs knowledge cleanup at import time). RouteTestBase alone redirects
paths too late for that side effect and does not cover context.KV_PATH.
No application functions are called to seed, delete, restore or manage data.
"""

import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def _run_isolated(method):
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), method],
        cwd=ROOT, capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_backup_export_delete_import_merge_http():
    _run_isolated("test_backup_merge")


def test_backup_export_delete_import_replace_http():
    _run_isolated("test_backup_replace")


def test_profile_manage_preserves_interleaved_updates_http():
    _run_isolated("test_profile_manage")


def _isolated_client(directory):
    """Child-only bootstrap; do not import test_routes/main during collection."""
    sys.path[:0] = [str(ROOT / "src"), str(ROOT)]
    production = ROOT / "data"

    # Fail closed on any accidental access to live data, including reads. The
    # audit hook remains confined to this disposable child process.
    def guard(event, args):
        path_args = {"open": (0,), "os.listdir": (0,), "os.scandir": (0,),
                     "os.mkdir": (0,), "os.remove": (0,), "os.rmdir": (0,),
                     "os.rename": (0, 1)}.get(event, ())
        for index in path_args:
            value = args[index]
            if isinstance(value, (str, bytes, os.PathLike)):
                path = Path(os.fsdecode(value)).absolute()
                if path == production or production in path.parents:
                    raise AssertionError(f"Live data access forbidden: {event} {path}")
        if event in ("socket.connect", "socket.getaddrinfo"):
            raise AssertionError(f"Network access forbidden: {event}")

    sys.addaudithook(guard)
    original_mkdir = Path.mkdir

    def config_mkdir(path, *args, **kwargs):
        # config has three eager mkdir calls before its constants can be patched.
        if path == production or production in path.parents:
            return None
        return original_mkdir(path, *args, **kwargs)

    with mock.patch.object(Path, "mkdir", config_mkdir):
        from server import config
    for name, value in list(vars(config).items()):
        if isinstance(value, Path) and (value == production or production in value.parents):
            setattr(config, name, directory / value.relative_to(production))
    for name in ("DATA_DIR", "MESSAGES_DIR", "UPLOAD_DIR"):
        getattr(config, name).mkdir(parents=True, exist_ok=True)

    # All from-import references (backup/profile/knowledge/context/storage/main)
    # now inherit temporary paths, including startup knowledge deduplication.
    import main
    from fastapi.testclient import TestClient
    from server import backup, context, knowledge, profile, storage
    for module in (config, main, backup, context, knowledge, profile, storage):
        for name, value in vars(module).items():
            if isinstance(value, Path) and (name.endswith("_PATH") or name.endswith("_DIR")):
                if value == production or production in value.parents:
                    raise AssertionError(f"Unisolated path: {module.__name__}.{name}")
    return TestClient(main.app)


class _HTTPChecks(unittest.TestCase):
    # Only instantiated by the child entry point, not collected by pytest.
    __test__ = False

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="phymathia-stage1-http-")
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.client = _isolated_client(self.data)
        self.addCleanup(self.client.close)
        self.device = "dev_stage1_http"

    def request(self, method, url, **kwargs):
        response = self.client.request(method, url, **kwargs)
        self.assertEqual(response.status_code, 200, f"{method} {url}: {response.text}")
        return response.json()

    def disk(self, relative):
        return json.loads((self.data / relative).read_text(encoding="utf-8"))

    def get_profile(self):
        return self.request("GET", "/api/profile", params={"device_id": self.device})

    def put_profile(self, updates):
        return self.request("PUT", "/api/profile", json={
            "device_id": self.device, "updates": updates})

    def candidates(self, items):
        return self.request("POST", "/api/profile/candidates", json={
            "device_id": self.device, "candidates": items, "source": "signal"})

    def seed(self):
        sessions, messages, knowledge, formulas = {}, {}, {}, {}
        for index in (1, 2):
            sid = f"sess_stage1_{index}"
            sessions[sid] = {
                "id": sid, "title": f"振动笔记{index}", "icon": "physics",
                "sessionId": f"server_stage1_{index}",
                "createdAt": 1700000000000 + index, "updatedAt": 1700000001000 + index,
            }
            messages[sid] = [
                {"id": f"u{index}", "role": "user", "content": "解释回复力", "timestamp": 1700000000100},
                {"id": f"a{index}", "role": "assistant", "content": "回复力与位移方向相反。",
                 "summary": "简谐运动的回复力", "timestamp": 1700000000200},
            ]
            kid, fid = f"ki_stage1_{index}", f"f_stage1_{index}"
            knowledge[kid] = {
                "id": kid, "sessionId": sid, "title": "简谐运动", "source": "manual",
                "summary": "回复力与位移成正比", "summarySource": "manual",
                "anchorSummary": "简谐运动的回复力", "formulas": ["$F=-kx$"],
                "category": "physics", "createdAt": 1700000000300 + index,
            }
            formulas[fid] = {
                "id": fid, "latex": "$F=-kx$", "concept": "胡克定律", "meaning": "回复力",
                "meaningSource": "local", "topic": "振动", "related": ["简谐运动"],
                "sessionId": sid, "messageId": f"a{index}", "moduleKey": "physics",
                "nodeId": f"node{index}", "createdAt": 1700000000400 + index,
            }
        self.assertEqual(self.request("POST", "/api/sessions", json=sessions), {"ok": True, "count": 2})
        for sid, items in messages.items():
            self.assertEqual(self.request("POST", f"/api/sessions/{sid}/messages", json={"messages": items}),
                             {"ok": True, "count": 2})
        self.assertEqual(self.request("POST", "/api/knowledge", json={"items": knowledge}),
                         {"ok": True, "count": 2})
        self.assertEqual(self.request("POST", "/api/formulas", json={"items": list(formulas.values())}),
                         {"ok": True, "count": 2})
        kv = {"phymathia_stage1": {"note": "跨会话学习状态", "values": [1, False, None],
                                    "updatedAt": 1700000000500}}
        for key, value in kv.items():
            self.assertEqual(self.request("POST", f"/api/kv/{key}", json={"value": value}), {"ok": True})
        self.put_profile({"explicit": {"stage": "高二", "goal": "理解振动", "style": {"detail": "详细"}}})
        self.candidates([
            {"fact": "我是高二学生", "category": "stage", "sourceSession": "sess_stage1_1"},
            {"fact": "喜欢天体物理", "category": "interest", "sourceSession": "sess_stage1_2"},
        ])
        profile = self.get_profile()
        self.assertTrue(profile["enabled"])
        self.assertEqual([f["fact"] for f in profile["facts"]], ["我是高二学生"])
        self.assertEqual([f["fact"] for f in profile["pending"]], ["喜欢天体物理"])
        self.assertEqual(profile["explicit"]["style"]["detail"], "详细")
        return {"version": 3, "sessions": sessions, "messages": messages,
                "knowledge": knowledge, "formulas": formulas, "kv": kv,
                "profiles": {self.device: profile}}

    @staticmethod
    def stable_backup(payload):
        result = copy.deepcopy(payload)
        # Only these fields really change: export generation time and
        # save_profile's top-level updatedAt during import. Do NOT strip nested
        # fact/history timestamps, session times, message times or KV times.
        result.pop("exportedAt")
        for profile in result["profiles"].values():
            profile.pop("updatedAt")
        return result

    def roundtrip(self, mode):
        expected = self.seed()
        before = self.request("GET", "/api/backup/export")
        self.assertEqual(set(before), set(expected) | {"exportedAt"})
        self.assertIsInstance(before["exportedAt"], (int, float))
        self.assertEqual({k: v for k, v in before.items() if k != "exportedAt"}, expected)
        profile_path = f"profiles/{self.device}.json"
        self.assertEqual(self.disk(profile_path), expected["profiles"][self.device])
        self.assertEqual(self.request("DELETE", "/api/profile", params={"device_id": self.device}), {"ok": True})
        self.assertFalse((self.data / profile_path).exists())
        self.assertEqual(self.request("DELETE", "/api/sessions"), {"ok": True})
        for name in ("sessions.json", "knowledge.json", "formulas.json", "kv_store.json"):
            self.assertEqual(self.disk(name), {}, name)
        self.assertEqual(list((self.data / "messages").glob("*.json")), [])
        self.assertEqual(list((self.data / "profiles").glob("*.json")), [])
        self.assertEqual(self.request("GET", "/api/sessions"), {})
        for sid in expected["sessions"]:
            self.assertEqual(self.request("GET", f"/api/sessions/{sid}/messages"), [])
        cleared = self.request("GET", "/api/backup/export")
        for key in ("sessions", "messages", "knowledge", "formulas", "kv", "profiles"):
            self.assertEqual(cleared[key], {}, key)
        self.assertEqual(self.request("POST", "/api/backup/import", json={"mode": mode, "backup": before}),
                         {"ok": True, "sessions": 2, "messages": 4, "knowledge": 2,
                          "formulas": 2, "kv": 1, "profiles": 1})
        after = self.request("GET", "/api/backup/export")
        self.assertGreater(after["exportedAt"], before["exportedAt"])
        self.assertGreater(after["profiles"][self.device]["updatedAt"],
                           before["profiles"][self.device]["updatedAt"])
        self.assertEqual(self.stable_backup(after), self.stable_backup(before))
        for section, filename in (("sessions", "sessions.json"), ("knowledge", "knowledge.json"),
                                  ("formulas", "formulas.json"), ("kv", "kv_store.json")):
            self.assertEqual(self.disk(filename), expected[section])
        for sid, items in expected["messages"].items():
            self.assertEqual(self.disk(f"messages/{sid}.json"), items)
            self.assertEqual(self.request("GET", f"/api/sessions/{sid}/messages"), items)
        self.assertEqual(self.disk(profile_path), after["profiles"][self.device])
        self.assertEqual(self.get_profile(), after["profiles"][self.device])

    def test_backup_merge(self):
        self.roundtrip("merge")

    def test_backup_replace(self):
        self.roundtrip("replace")

    def test_profile_manage(self):
        self.candidates([{"fact": "我是高二学生", "category": "stage"}])
        # Panel GET holds a stale snapshot; all subsequent writes are HTTP too.
        stale = self.get_profile()
        target = stale["facts"][0]["id"]
        self.assertTrue(stale["enabled"])
        result = self.candidates([{"fact": "目标：高考物理90分", "category": "goal"}])
        self.assertEqual(result["changed"], 1)
        background = self.get_profile()
        new_fact = next(f for f in background["facts"] if f["id"] != target)
        self.put_profile({"enabled": False, "explicit": {"goal": "另一标签页的新目标"}})
        before_delete = self.get_profile()
        profile_path = self.data / "profiles" / f"{self.device}.json"
        raw_before_get = profile_path.read_bytes()
        self.assertEqual(self.get_profile(), before_delete)
        self.assertEqual(profile_path.read_bytes(), raw_before_get, "GET must not write a stale snapshot")
        managed = self.request("POST", "/api/profile/manage", json={
            "device_id": self.device, "action": "delete_fact", "fact_id": target})
        self.assertEqual(managed, {"accepted": True, "changed": 1, "promoted": []})
        final = self.get_profile()
        expected = copy.deepcopy(before_delete)
        expected["facts"] = [new_fact]
        # Management updates only the target list plus profile.updatedAt.
        self.assertGreaterEqual(final["updatedAt"], expected["updatedAt"])
        expected["updatedAt"] = final["updatedAt"]
        self.assertEqual(final, expected)
        self.assertFalse(final["enabled"])
        self.assertEqual(self.disk(f"profiles/{self.device}.json"), final)
        # Delayed background collection while disabled must not resurrect data.
        disk_before = profile_path.read_bytes()
        ignored = self.candidates([{"fact": "目标：考研", "category": "goal"}])
        self.assertEqual(ignored["changed"], 0)
        self.assertEqual(self.get_profile(), final)
        self.assertEqual(profile_path.read_bytes(), disk_before)
        duplicate = self.request("POST", "/api/profile/manage", json={
            "device_id": self.device, "action": "delete_fact", "fact_id": target})
        self.assertEqual(duplicate, {"accepted": False, "changed": 0, "promoted": []})
        self.assertEqual(profile_path.read_bytes(), disk_before)


if __name__ == "__main__":
    suite = unittest.TestSuite([_HTTPChecks(sys.argv[1])])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
