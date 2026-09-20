"""Unit tests for harness.selfcheck: critic parsing and snapshot consistency."""

import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness.selfcheck import (
    build_selfcheck_messages,
    check_snapshot_consistency,
    parse_selfcheck,
    parse_selfcheck_tool,
)


def _selfcheck_call(arguments):
    return {"function": {"name": "submit_selfcheck", "arguments": arguments}}


class ParseSelfcheckToolTest(unittest.TestCase):
    def test_none_on_empty_or_foreign_calls(self):
        self.assertIsNone(parse_selfcheck_tool(None))
        self.assertIsNone(parse_selfcheck_tool([]))
        self.assertIsNone(parse_selfcheck_tool([{"function": {"name": "other", "arguments": "{}"}}]))

    def test_ok_when_clean(self):
        result = parse_selfcheck_tool([_selfcheck_call('{"ok": true, "issues": [], "missing": []}')])
        self.assertEqual(result, {"ok": True, "issues": [], "missing": []})

    def test_ok_true_forced_false_when_issues_present(self):
        result = parse_selfcheck_tool([_selfcheck_call('{"ok": true, "issues": ["删错节点"], "missing": []}')])
        self.assertFalse(result["ok"])
        self.assertEqual(result["issues"], ["删错节点"])

    def test_garbage_arguments_returns_none(self):
        self.assertIsNone(parse_selfcheck_tool([_selfcheck_call("%%%not json%%%")]))

    def test_non_dict_arguments_returns_none(self):
        self.assertIsNone(parse_selfcheck_tool([_selfcheck_call('["list"]')]))


class ParseSelfcheckTest(unittest.TestCase):
    def test_valid_json_parsed(self):
        result = parse_selfcheck('{"ok": false, "issues": ["漏了连接"], "missing": ["补一条前置连线"]}')
        self.assertFalse(result["ok"])
        self.assertEqual(result["missing"], ["补一条前置连线"])
        self.assertNotIn("parse_error", result)

    def test_bad_json_never_blocks_flow(self):
        result = parse_selfcheck("模型胡言乱语")
        self.assertTrue(result["ok"])
        self.assertTrue(result.get("parse_error"))

    def test_ok_true_with_missing_forced_false(self):
        result = parse_selfcheck('{"ok": true, "issues": [], "missing": ["删除冗余节点"]}')
        self.assertFalse(result["ok"])


class BuildSelfcheckMessagesTest(unittest.TestCase):
    def test_two_messages_with_instruction(self):
        snapshot = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []}
        messages = build_selfcheck_messages("把导数改成英文", snapshot, [{"op": "update_node"}])
        self.assertEqual(messages[0]["role"], "system")
        self.assertEqual(messages[1]["role"], "user")
        self.assertIn("把导数改成英文", messages[1]["content"])
        self.assertIn("导数", messages[1]["content"])


class CheckSnapshotConsistencyTest(unittest.TestCase):
    def test_empty_snapshot_is_healthy(self):
        result = check_snapshot_consistency(None)
        self.assertTrue(result["ok"])
        self.assertEqual(result["total"], 0)
        self.assertEqual(result["node_count"], 0)

    def test_broken_edge_is_error(self):
        snapshot = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "a"}],
            "edges": [{"key": "A:out-0->GHOST:in-0", "from": "A", "to": "GHOST"}],
        }
        result = check_snapshot_consistency(snapshot)
        self.assertFalse(result["ok"])
        self.assertEqual(result["issues"][0]["type"], "broken_edge")
        self.assertEqual(result["issues"][0]["severity"], "error")

    def test_orphan_node_is_warning(self):
        snapshot = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "孤岛"}],
            "edges": [],
        }
        result = check_snapshot_consistency(snapshot)
        self.assertTrue(result["ok"])  # warning 不判死
        self.assertEqual(result["issues"][0]["type"], "orphan")

    def test_duplicate_knowledge_label_is_info(self):
        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "knowledge", "label": "导数"},
                {"id": "C", "kind": "knowledge", "label": "导数"},
            ],
            "edges": [],
        }
        result = check_snapshot_consistency(snapshot)
        dup = [i for i in result["issues"] if i["type"] == "duplicate_label"]
        self.assertEqual(len(dup), 1)
        self.assertIn("3 个", dup[0]["message"])

    def test_duplicate_module_is_info(self):
        snapshot = {
            "nodes": [
                {"id": "M1", "kind": "module", "module_key": "learn", "label": "进阶1"},
                {"id": "M2", "kind": "module", "module_key": "learn", "label": "进阶2"},
            ],
            "edges": [],
        }
        result = check_snapshot_consistency(snapshot)
        dup = [i for i in result["issues"] if i["type"] == "duplicate_module"]
        self.assertEqual(len(dup), 1)

    def test_duplicate_edges_and_ids_deduplicated(self):
        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "a"},
                {"id": "A", "kind": "knowledge", "label": "a-copy"},  # 重复 id 只算一次
            ],
            "edges": [
                {"key": "k1", "from": "A", "to": "GHOST"},
                {"key": "k1", "from": "A", "to": "GHOST"},  # 重复 key 只算一次
            ],
        }
        result = check_snapshot_consistency(snapshot)
        self.assertEqual(result["node_count"], 1)
        self.assertEqual(result["edge_count"], 1)
        broken = [i for i in result["issues"] if i["type"] == "broken_edge"]
        self.assertEqual(len(broken), 1)


if __name__ == "__main__":
    unittest.main()
