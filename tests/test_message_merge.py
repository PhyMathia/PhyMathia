"""消息逐条合并（context.merge_message_lists）与保存路由防丢回归。

取代旧「条数多者胜 / 更长者胜」：按 timestamp 身份逐条合并，两边各自
独有的消息都保留；空列表不许清空服务端历史的 09-20 保护不许回退。
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

from server import context as context_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


class MergeListsTest(unittest.TestCase):
    def test_disjoint_union_keeps_both(self):
        a = [{"role": "user", "content": "A", "timestamp": 1}]
        b = [{"role": "assistant", "content": "B", "timestamp": 2}]
        merged = context_mod.merge_message_lists(a, b)
        self.assertEqual([m["content"] for m in merged], ["A", "B"])

    def test_duplicate_timestamp_merged_fieldwise(self):
        a = [{"role": "assistant", "content": "同一条", "timestamp": 5, "summary": ""}]
        b = [{"role": "assistant", "content": "同一条", "timestamp": 5, "summary": "服务端摘要"}]
        merged = context_mod.merge_message_lists(a, b)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["summary"], "服务端摘要")  # 空 summary 不覆盖非空
        self.assertEqual(merged[0]["content"], "同一条")

    def test_conflict_prefers_primary(self):
        a = [{"role": "user", "content": "本地版", "timestamp": 3}]
        b = [{"role": "user", "content": "服务端版", "timestamp": 3}]
        merged = context_mod.merge_message_lists(a, b)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["content"], "本地版")

    def test_sorted_by_timestamp_when_all_present(self):
        a = [{"role": "user", "content": "t3", "timestamp": 3}]
        b = [{"role": "user", "content": "t1", "timestamp": 1},
             {"role": "user", "content": "t2", "timestamp": 2}]
        merged = context_mod.merge_message_lists(a, b)
        self.assertEqual([m["content"] for m in merged], ["t1", "t2", "t3"])

    def test_missing_timestamp_identity_fallback(self):
        a = [{"role": "user", "content": "x"}]
        b = [{"role": "user", "content": "x"}, {"role": "user", "content": "y"}]
        merged = context_mod.merge_message_lists(a, b)
        self.assertEqual([m["content"] for m in merged], ["x", "y"])

    def test_tsless_message_with_backfilled_summary_still_dedupes(self):
        # 服务端保存会给 assistant 回填 summary——身份键不能因此漂移（曾致 6+3+1=10）
        a = [{"role": "assistant", "content": "同样的回答"}]
        b = [{"role": "assistant", "content": "同样的回答", "summary": "回填摘要"}]
        merged = context_mod.merge_message_lists(a, b)
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["summary"], "回填摘要")

    def test_non_dict_entries_filtered(self):
        merged = context_mod.merge_message_lists(
            ["junk", {"role": "user", "content": "ok", "timestamp": 1}], None)
        self.assertEqual(len(merged), 1)

    def test_empty_inputs(self):
        self.assertEqual(context_mod.merge_message_lists(None, []), [])
        one = [{"role": "user", "content": "a", "timestamp": 1}]
        self.assertEqual(context_mod.merge_message_lists(one, None), one)


class SaveMessagesRouteTest(unittest.TestCase):
    """POST /api/sessions/<sid>/messages 的合并语义（与 09-20 空列表保护共存）。"""

    def setUp(self):
        import main as main_mod
        self._main = main_mod
        self._td = tempfile.TemporaryDirectory()
        td = Path(self._td.name)
        self.paths = {
            "MESSAGES_DIR": td / "messages", "SESSIONS_PATH": td / "sessions.json",
            "KNOWLEDGE_PATH": td / "knowledge.json", "FORMULAS_PATH": td / "formulas.json",
            "KV_PATH": td / "kv_store.json", "KV_DIR": td / "kv", "PROFILES_DIR": td / "profiles",
        }
        self.paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
        self._orig = {}
        for mod in (main_mod, storage_mod):
            for name, value in self.paths.items():
                self._orig[(id(mod), name)] = getattr(mod, name, None)
                setattr(mod, name, value)

    def tearDown(self):
        for mod in (self._main, storage_mod):
            for name in self.paths:
                setattr(mod, name, self._orig[(id(mod), name)])
        self._td.cleanup()

    def _seed(self, sid, msgs):
        storage_mod._write_json(storage_mod._get_messages_path(sid), msgs)

    def _saved(self, sid):
        return storage_mod._read_json(storage_mod._get_messages_path(sid), [])

    def test_post_merges_instead_of_overwrite(self):
        from fastapi.testclient import TestClient
        sid = "sess_merge"
        self._seed(sid, [
            {"role": "user", "content": "旧消息", "timestamp": 1},
            {"role": "assistant", "content": "旧回复", "timestamp": 2, "summary": "服务端摘要"},
        ])
        client = TestClient(self._main.app)
        resp = client.post(f"/api/sessions/{sid}/messages", json=[
            {"role": "user", "content": "新消息", "timestamp": 3},
            {"role": "assistant", "content": "旧回复", "timestamp": 2, "summary": ""},
        ])
        self.assertEqual(resp.status_code, 200)
        saved = self._saved(sid)
        self.assertEqual([m["content"] for m in saved], ["旧消息", "旧回复", "新消息"])
        self.assertEqual(saved[1]["summary"], "服务端摘要")  # 不被空 summary 覆盖

    def test_post_empty_list_never_wipes(self):
        from fastapi.testclient import TestClient
        sid = "sess_empty"
        seed = [{"role": "user", "content": "唯一副本", "timestamp": 1}]
        self._seed(sid, seed)
        client = TestClient(self._main.app)
        resp = client.post(f"/api/sessions/{sid}/messages", json=[])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(self._saved(sid), seed)  # 09-20 保护：空列表不写

    def test_post_identical_no_rewrite(self):
        from fastapi.testclient import TestClient
        sid = "sess_same"
        seed = [{"role": "user", "content": "同样", "timestamp": 1}]
        self._seed(sid, seed)
        before = storage_mod._get_messages_path(sid).read_bytes()
        client = TestClient(self._main.app)
        client.post(f"/api/sessions/{sid}/messages", json=seed)
        self.assertEqual(storage_mod._get_messages_path(sid).read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
