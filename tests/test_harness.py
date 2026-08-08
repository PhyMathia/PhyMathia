"""Unit tests for the independent graph harness."""

import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness.core import build_next_snapshot, diff_snapshots, normalize_snapshot
from harness.json_utils import extract_json
from harness.prompts import build_evaluate_messages
from harness.review import _cleanup_remaining_eval_nodes, _detect_phase


class HarnessCoreTest(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "knowledge", "label": "函数"},
            ],
            "edges": [
                {"key": "B:out-0->A:in-0", "from": "B", "to": "A", "relation": "依赖"},
            ],
        }

    def test_create_node_and_add_edge(self):
        result = build_next_snapshot(
            self.snapshot,
            [
                {
                    "op": "create_node",
                    "temp_id": "n_limit",
                    "kind": "knowledge",
                    "label": "极限",
                    "content": "趋近过程",
                    "reason": "补全基础",
                },
                {
                    "op": "add_edge",
                    "from": "n_limit",
                    "to": "A",
                    "relation": "依赖",
                    "reason": "导数需要极限",
                },
            ],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["operations"]), 2)
        self.assertEqual(len(result["next_snapshot"]["nodes"]), 3)
        self.assertEqual(len(result["next_snapshot"]["edges"]), 2)
        created = result["operations"][0]
        self.assertTrue(created.get("assigned_id"))
        self.assertNotEqual(created["assigned_id"], "n_limit")
        edge_op = result["operations"][1]
        self.assertEqual(edge_op["from"], created["assigned_id"])
        self.assertEqual(edge_op["to"], "A")

    def test_delete_node_cascades_edges(self):
        result = build_next_snapshot(
            self.snapshot,
            [{"op": "delete_node", "id": "A", "reason": "删除错误节点"}],
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual([node["id"] for node in result["next_snapshot"]["nodes"]], ["B"])
        self.assertEqual(result["next_snapshot"]["edges"], [])

    def test_invalid_operation_is_skipped(self):
        result = build_next_snapshot(
            self.snapshot,
            [
                {"op": "delete_node", "id": "missing", "reason": "不存在"},
                {"op": "update_node", "id": "A", "patch": {"label": "瞬时变化率"}, "reason": "更准确"},
            ],
        )
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["operations"]), 1)
        self.assertEqual(len(result["errors"]), 1)

    def test_read_only_node_cannot_be_updated(self):
        snapshot = {
            "nodes": [
                {"id": "AI", "kind": "answer", "label": "AI 回答", "read_only": True},
            ],
            "edges": [],
        }
        result = build_next_snapshot(
            snapshot,
            [{"op": "update_node", "id": "AI", "patch": {"label": "改了"}, "reason": "测试"}],
        )
        self.assertEqual(result["status"], "invalid")

    def test_create_module_node_with_module_key(self):
        result = build_next_snapshot(
            self.snapshot,
            [
                {
                    "op": "create_node",
                    "temp_id": "n_physics",
                    "kind": "module",
                    "module_key": "physics",
                    "label": "物理视角",
                    "content": "用物理场景解释",
                    "reason": "用户要求补充物理视角",
                }
            ],
        )
        self.assertEqual(result["status"], "ok")
        created = result["next_snapshot"]["nodes"][-1]
        self.assertEqual(created["kind"], "module")
        self.assertEqual(created["module_key"], "physics")

    def test_reject_invalid_module_key(self):
        result = build_next_snapshot(
            self.snapshot,
            [
                {
                    "op": "create_node",
                    "temp_id": "n_bad",
                    "kind": "module",
                    "module_key": "not_a_module",
                    "label": "坏模块",
                    "reason": "测试非法模块类型",
                }
            ],
        )
        self.assertEqual(result["status"], "invalid")

    def test_create_eval_node_builds_node_and_edge(self):
        result = build_next_snapshot(
            self.snapshot,
            [
                {
                    "op": "create_eval_node",
                    "temp_id": "eval_A",
                    "target_node_id": "A",
                    "suggestion": "把标题改为瞬时变化率",
                    "priority": "high",
                    "reason": "当前表述不够准确",
                }
            ],
        )
        self.assertEqual(result["status"], "ok")
        eval_node = result["next_snapshot"]["nodes"][-1]
        self.assertEqual(eval_node["kind"], "ai_eval")
        self.assertEqual(eval_node["target_node_id"], "A")
        self.assertEqual(len(result["next_snapshot"]["edges"]), 2)
        eval_op = result["operations"][0]
        self.assertTrue(eval_op["assigned_id"])
        self.assertEqual(eval_op["edge_key"], "A:out-0->" + eval_op["assigned_id"] + ":in-0")

    def test_create_eval_node_rejects_missing_target(self):
        result = build_next_snapshot(
            self.snapshot,
            [
                {
                    "op": "create_eval_node",
                    "temp_id": "eval_missing",
                    "target_node_id": "missing",
                    "suggestion": "不存在",
                    "reason": "测试非法目标",
                }
            ],
        )
        self.assertEqual(result["status"], "invalid")

    def test_apply_phase_cleanup_removes_eval_nodes(self):
        original = normalize_snapshot(self.snapshot)
        evaluated = build_next_snapshot(
            original,
            [
                {
                    "op": "create_eval_node",
                    "temp_id": "eval_A",
                    "target_node_id": "A",
                    "suggestion": "改为瞬时变化率",
                    "reason": "生成评价",
                }
            ],
        )
        cleaned = _cleanup_remaining_eval_nodes(evaluated, original)
        self.assertFalse(any(node["kind"] == "ai_eval" for node in cleaned["next_snapshot"]["nodes"]))
        self.assertTrue(any(op["op"] == "delete_node" for op in cleaned["operations"]))

    def test_detect_phase_from_instruction(self):
        self.assertEqual(
            _detect_phase("normal", "帮我评价这张图", {"nodes": [], "edges": []}),
            "evaluate",
        )
        with_eval = {
            "nodes": [{"id": "E", "kind": "ai_eval", "label": "建议"}],
            "edges": [],
        }
        self.assertEqual(
            _detect_phase("normal", "应用建议", with_eval),
            "apply",
        )
        self.assertEqual(
            _detect_phase("normal", "整理层级", with_eval),
            "normal",
        )

    def test_evaluate_prompt_includes_phymathia_standards_and_level(self):
        messages = build_evaluate_messages(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            "评价我对导数的理解",
            context="PhyMathia 系统上下文",
            level="middle",
            focus_node_ids=["A"],
        )
        system_text = messages[0]["content"]
        self.assertIn("PhyMathia 评价标准", system_text)
        self.assertIn("当前难度：初高中", system_text)
        self.assertIn("PhyMathia 系统上下文", system_text)
        self.assertIn("用户重点指定的节点", messages[1]["content"])

    def test_diff_reports_add_update_delete(self):
        after = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "瞬时变化率"},
                {"id": "C", "kind": "knowledge", "label": "极限"},
            ],
            "edges": [],
        }
        diff = diff_snapshots(self.snapshot, after)
        kinds = {item["type"] for item in diff}
        self.assertIn("update_node", kinds)
        self.assertIn("add_node", kinds)
        self.assertIn("delete_node", kinds)

    def test_normalize_snapshot_filters_bad_rows(self):
        normalized = normalize_snapshot(
            {
                "nodes": [
                    {"id": "ok", "kind": "knowledge", "label": "正常"},
                    {"id": "", "kind": "knowledge", "label": "坏节点"},
                ],
                "edges": [
                    {"from": "ok", "to": "missing"},
                ],
            }
        )
        self.assertEqual(len(normalized["nodes"]), 1)
        self.assertEqual(len(normalized["edges"]), 0)

    def test_extract_json_tolerates_fence(self):
        payload = extract_json('```json\n{"summary":"x","operations":[]}\n```')
        self.assertEqual(payload["summary"], "x")


if __name__ == "__main__":
    unittest.main()
