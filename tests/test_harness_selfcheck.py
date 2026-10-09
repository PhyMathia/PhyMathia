"""Unit tests for harness.selfcheck: critic parsing and snapshot consistency."""

import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness.selfcheck import (
    _result_state_excerpt,
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


class ResultStateExcerptTest(unittest.TestCase):
    """路径二第一步：结果图摘录（触及＋一跳邻居、80 字截断、降级逐字节一致）。"""

    @staticmethod
    def _snapshot():
        return {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "x" * 200, "formula": "f'(x)"},
                {"id": "B", "kind": "knowledge", "label": "极限", "content": "趋近", "formula": ""},
                {"id": "C", "kind": "module", "label": "物理视角", "content": "速度", "formula": ""},
                {"id": "D", "kind": "knowledge", "label": "远岛", "content": "不相邻", "formula": ""},
            ],
            "edges": [
                {"key": "B:out-0->A:in-0", "from": "B", "to": "A", "relation": "依赖"},
                {"key": "A:out-0->C:in-0", "from": "A", "to": "C", "relation": "视角"},
            ],
        }

    def test_touched_neighbors_and_truncation(self):
        before = self._snapshot()
        result = {
            "nodes": [dict(n) for n in before["nodes"]] + [
                {"id": "N1", "kind": "module", "label": "新模块", "content": "新内容", "formula": ""},
            ],
            "edges": before["edges"] + [
                {"key": "N1:out-0->A:in-1", "from": "N1", "to": "A", "relation": "补充"},
            ],
        }
        ops = [
            {"op": "create_node", "temp_id": "t1", "kind": "module", "label": "新模块", "reason": "r"},
            {"op": "add_edge", "from": "N1", "to": "A", "reason": "连线"},
        ]
        excerpt = _result_state_excerpt(before, result, ops)
        by_id = {n["id"]: n for n in excerpt["nodes"]}
        # 触及＝新建 N1＋连线的 A；B、C 是 A 的一跳邻居；D 与触及区域无连线不该出现
        self.assertIn("N1", by_id)
        self.assertIn("A", by_id)
        self.assertIn("B", by_id)
        self.assertIn("C", by_id)
        self.assertNotIn("D", by_id)
        self.assertTrue(by_id["N1"]["touched"])
        self.assertTrue(by_id["A"]["touched"])
        self.assertFalse(by_id["B"]["touched"])
        self.assertFalse(by_id["C"]["touched"])
        # 80 字截断＋省略号（对齐只读工具 _READONLY_EXCERPT_CHARS 口径）
        self.assertEqual(by_id["A"]["content"], "x" * 80 + "…")
        edge_keys = [e["key"] for e in excerpt["edges"]]
        self.assertIn("N1:out-0->A:in-1", edge_keys)
        self.assertIn("B:out-0->A:in-0", edge_keys)
        messages = build_selfcheck_messages("加一个新模块并连到导数", before, ops, result)
        content = messages[1]["content"]
        self.assertIn("操作执行后的结果图", content)
        self.assertIn("新模块", content)
        self.assertIn("x" * 80 + "…", content)
        self.assertNotIn("x" * 81, content)
        # D（远岛）在前态精简图里本就存在，只该从「结果图」段缺席
        result_section = content.split("操作执行后的结果图", 1)[1]
        self.assertNotIn("远岛", result_section)

    def test_deleted_nodes_listed(self):
        before = self._snapshot()
        result = {
            "nodes": [n for n in before["nodes"] if n["id"] != "B"],
            "edges": [e for e in before["edges"] if e.get("from") != "B"],
        }
        excerpt = _result_state_excerpt(before, result, [{"op": "delete_node", "id": "B", "reason": "r"}])
        self.assertIn("B", excerpt["removed_node_ids"])
        self.assertNotIn("B", [n["id"] for n in excerpt["nodes"]])

    def test_bad_result_shapes_degrade_identically(self):
        before = self._snapshot()
        ops = [{"op": "update_node", "id": "A", "patch": {"label": "X"}, "reason": "r"}]
        legacy = build_selfcheck_messages("改标题", before, ops)
        self.assertNotIn("操作执行后的结果图", legacy[1]["content"])
        for bad in (None, "not-a-dict", 123, {"nodes": "oops"}):
            self.assertEqual(build_selfcheck_messages("改标题", before, ops, bad), legacy)


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
