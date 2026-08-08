"""Unit tests for the refactored src/server package (PhyMathia backend modules)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from server import backup as backup_mod
from server import config as config_mod
from server import context as context_mod
from server import documents as documents_mod
from server import knowledge as knowledge_mod
from server import storage as storage_mod


class StorageTest(unittest.TestCase):
    def test_write_read_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kv.json"
            storage_mod._write_json(path, {"a": 1, "中文": [1, 2]})
            self.assertEqual(storage_mod._read_json(path), {"a": 1, "中文": [1, 2]})

    def test_read_missing_returns_default(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(storage_mod._read_json(Path(td) / "missing.json"), {})
            self.assertEqual(storage_mod._read_json(Path(td) / "missing.json", []), [])

    def test_mutate_json_serialized(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kv.json"
            storage_mod._write_json(path, {"n": 1})
            storage_mod._mutate_json(path, lambda d: {**d, "n": d.get("n", 0) + 1})
            self.assertEqual(storage_mod._read_json(path)["n"], 2)

    def test_delete_by_session(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "formulas.json"
            storage_mod._write_json(path, {
                "f1": {"sessionId": "sess_a"},
                "f2": {"sessionId": "sess_b"},
            })
            removed = storage_mod._delete_by_session(path, "sess_a")
            self.assertEqual(removed, 1)
            self.assertNotIn("f1", storage_mod._read_json(path))
            self.assertIn("f2", storage_mod._read_json(path))


class FormulaTest(unittest.TestCase):
    def test_normalize_formula_wraps_dollars(self):
        self.assertEqual(knowledge_mod._normalize_formula("F=-kx"), "$F=-kx$")
        self.assertEqual(knowledge_mod._normalize_formula("$F=-kx$"), "$F=-kx$")
        self.assertEqual(knowledge_mod._normalize_formula(""), "")

    def test_normalize_formula_cleans_escapes(self):
        self.assertEqual(knowledge_mod._normalize_formula("\\$x\\$"), "$x$")
        self.assertEqual(knowledge_mod._normalize_formula("\\=x"), "$=x$")

    def test_looks_like_formula(self):
        self.assertTrue(knowledge_mod._looks_like_formula("$F=-kx$"))
        self.assertTrue(knowledge_mod._looks_like_formula("E=mc^2"))
        self.assertFalse(knowledge_mod._looks_like_formula("m"))
        self.assertFalse(knowledge_mod._looks_like_formula("rad/s"))
        self.assertFalse(knowledge_mod._looks_like_formula("\\omega"))
        self.assertFalse(knowledge_mod._looks_like_formula("\\text{rad/s}"))

    def test_formula_key_ignores_spacing(self):
        self.assertEqual(
            knowledge_mod._formula_key("$F = -kx$"),
            knowledge_mod._formula_key("F=-kx"),
        )


class KnowledgeTest(unittest.TestCase):
    def test_normalize_knowledge_formats(self):
        items = [{"id": "k1", "title": "导数"}]
        self.assertEqual(knowledge_mod._normalize_knowledge({"items": items}), {"k1": items[0]})
        self.assertEqual(knowledge_mod._normalize_knowledge({"items": None}), {})

    def test_dedupe_knowledge_merges_same_session_title(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "旧"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "新"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        self.assertEqual(list(result.values())[0]["summary"], "新")

    def test_dedupe_formula_map_merges_by_key(self):
        data = {
            "f1": {"latex": "$F=-kx$", "sessionId": "s1", "meaning": "旧"},
            "f2": {"latex": "$F = -kx$", "sessionId": "s1", "meaning": "新"},
        }
        result = knowledge_mod._dedupe_formula_map(data)
        self.assertEqual(len(result), 1)

    def test_normalize_formula_map(self):
        self.assertEqual(
            knowledge_mod._normalize_formula_map([{"id": "f1", "latex": "$a$"}]),
            {"f1": {"id": "f1", "latex": "$a$"}},
        )


class ContextTest(unittest.TestCase):
    def test_is_socratic_message(self):
        self.assertTrue(context_mod._is_socratic_message({"branch": "socratic", "content": "x"}))
        self.assertTrue(context_mod._is_socratic_message({"content": "[苏格拉底回答] 我的想法"}))
        self.assertTrue(context_mod._is_socratic_message({"content": "<socratic_meta correct='correct'/>"}))
        self.assertFalse(context_mod._is_socratic_message({"content": "普通问题"}))

    def test_is_socratic_followup(self):
        self.assertTrue(context_mod._is_socratic_followup("<socratic_meta correct='correct' done='false'/>"))
        self.assertFalse(context_mod._is_socratic_followup("<physics>完整卡片</physics><socratic_meta/>"))

    def test_recent_context_messages_rounds(self):
        msgs = [{"role": "user", "content": f"u{i}"} for i in range(5)]
        result = context_mod._recent_context_messages(msgs, max_rounds=2)
        self.assertEqual([m["content"] for m in result], ["u3", "u4"])

    def test_recent_context_filters_socratic(self):
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "[苏格拉底回答] 我的回答", "branch": "socratic"},
            {"role": "user", "content": "u2"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=3)
        self.assertNotIn("[苏格拉底回答] 我的回答", [m["content"] for m in result])


class DocumentTest(unittest.TestCase):
    def test_sanitize_filename(self):
        self.assertEqual(documents_mod._sanitize_filename("../evil/name.txt"), "name.txt")
        self.assertEqual(documents_mod._sanitize_filename(""), "upload")
        self.assertEqual(len(documents_mod._sanitize_filename("x" * 300)), 120)

    def test_extract_text_utf8_and_gbk(self):
        self.assertEqual(documents_mod._extract_document_text("a.md", "你好".encode("utf-8")), "你好")
        self.assertEqual(documents_mod._extract_document_text("a.md", "中文".encode("gbk")), "中文")

    def test_extract_unsupported_returns_empty(self):
        self.assertEqual(documents_mod._extract_document_text("a.xyz", b"data"), "")


class BackupTest(unittest.TestCase):
    def test_restore_sessions_merge(self):
        with tempfile.TemporaryDirectory() as td:
            old_path = backup_mod.SESSIONS_PATH
            backup_mod.SESSIONS_PATH = Path(td) / "sessions.json"
            try:
                backup_mod._write_json(backup_mod.SESSIONS_PATH, {"s1": {"id": "s1", "title": "旧"}})
                count = backup_mod._restore_sessions({"s2": {"id": "s2", "title": "新"}}, replace=False)
                self.assertEqual(count, 1)
                data = backup_mod._read_json(backup_mod.SESSIONS_PATH)
                self.assertIn("s1", data)
                self.assertIn("s2", data)
            finally:
                backup_mod.SESSIONS_PATH = old_path


if __name__ == "__main__":
    unittest.main()
