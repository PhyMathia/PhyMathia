"""Unit tests for harness.semantics: deterministic instruction-coverage rules."""

import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness.semantics import (
    find_isolated_created_nodes,
    find_missing_expansion_chains,
    rule_selfcheck,
)


def _snap(nodes, edges):
    return {
        "nodes": [{"id": n, "kind": "knowledge", "label": n} for n in nodes],
        "edges": [{"key": f"{f}:out-0->{t}:in-0", "from": f, "to": t} for f, t in edges],
    }


class FindIsolatedCreatedNodesTest(unittest.TestCase):
    def test_connected_created_node_not_isolated(self):
        snapshot = _snap(["A"], [])
        ops = [
            {"op": "create_node", "temp_id": "t1", "assigned_id": "N1", "kind": "knowledge", "label": "新点"},
            {"op": "add_edge", "from": "A", "to": "N1", "reason": "连接"},
        ]
        self.assertEqual(find_isolated_created_nodes(snapshot, ops), [])

    def test_unconnected_created_node_is_isolated(self):
        snapshot = _snap(["A"], [])
        ops = [{"op": "create_node", "temp_id": "t1", "assigned_id": "N1", "kind": "knowledge", "label": "悬空"}]
        isolated = find_isolated_created_nodes(snapshot, ops)
        self.assertEqual([item["id"] for item in isolated], ["N1"])

    def test_eval_node_unions_with_target(self):
        snapshot = _snap(["A"], [])
        ops = [{"op": "create_eval_node", "temp_id": "e1", "assigned_id": "E1", "target_node_id": "A", "suggestion": "补内容"}]
        self.assertEqual(find_isolated_created_nodes(snapshot, ops), [])

    def test_transitive_connection_counts(self):
        # 新点只连到另一个新建点，但后者连回了既有节点——传递连通不算孤岛
        snapshot = _snap(["A"], [])
        ops = [
            {"op": "create_node", "temp_id": "t1", "assigned_id": "N1", "kind": "knowledge", "label": "桥"},
            {"op": "create_node", "temp_id": "t2", "assigned_id": "N2", "kind": "knowledge", "label": "新点"},
            {"op": "add_edge", "from": "A", "to": "N1", "reason": "连接"},
            {"op": "add_edge", "from": "N1", "to": "N2", "reason": "连接"},
        ]
        self.assertEqual(find_isolated_created_nodes(snapshot, ops), [])


class RuleSelfcheckTest(unittest.TestCase):
    def test_focus_untouched_warns(self):
        snapshot = _snap(["A", "B"], [("A", "B")])
        ops = [{"op": "update_node", "id": "B", "patch": {"label": "x"}, "reason": "改"}]
        result = rule_selfcheck(snapshot, "修改A节点", ["A"], ops)
        self.assertFalse(result["ok"])
        self.assertTrue(any("A" in issue for issue in result["issues"]))

    def test_anchor_add_instruction_is_exempt(self):
        # 「给A加一个物理视角」：A 只是锚点，模型扩展现有模块（连着 A 的 M）不算漏
        snapshot = _snap(["A", "M"], [("A", "M")])
        ops = [{"op": "update_node", "id": "M", "patch": {"content": "视角"}, "reason": "补"}]
        result = rule_selfcheck(snapshot, "给A加一个物理视角", ["A"], ops)
        self.assertEqual(result["issues"], [])

    def test_action_words_with_zero_ops_warns(self):
        snapshot = _snap(["A"], [])
        result = rule_selfcheck(snapshot, "删除节点A", ["A"], [])
        self.assertFalse(result["ok"])
        self.assertTrue(any("没有提出任何操作" in issue for issue in result["issues"]))

    def test_duplicate_module_key_warns(self):
        snapshot = {"nodes": [{"id": "M1", "kind": "module", "module_key": "learn", "label": "进阶"}], "edges": []}
        ops = [{"op": "create_node", "temp_id": "t9", "kind": "module", "module_key": "learn", "label": "又一个进阶", "reason": "扩"}]
        result = rule_selfcheck(snapshot, "新增一个进阶模块", [], ops)
        self.assertFalse(result["ok"])
        self.assertTrue(any("重复" in issue for issue in result["issues"]))

    def test_batch_delete_threshold(self):
        nodes = [str(i) for i in range(10)]
        snapshot = _snap(nodes, [])
        delete_ops = [{"op": "delete_node", "id": n, "reason": "清理"} for n in nodes[:6]]
        warned = rule_selfcheck(snapshot, "清理冗余", [], delete_ops)
        self.assertTrue(any("删除节点较多" in issue for issue in warned["issues"]))
        # 3/10 = 30% 不超阈值，不告警
        few = rule_selfcheck(snapshot, "清理冗余", [], delete_ops[:3])
        self.assertEqual(few["issues"], [])

    def test_clean_pass_is_ok(self):
        snapshot = _snap(["A", "B"], [("A", "B")])
        ops = [{"op": "update_node", "id": "A", "patch": {"label": "新A"}, "reason": "改"}]
        result = rule_selfcheck(snapshot, "修改A", ["A"], ops)
        self.assertTrue(result["ok"])
        self.assertEqual(result["issues"], [])


class FindMissingExpansionChainsTest(unittest.TestCase):
    def test_no_targets_no_report(self):
        self.assertEqual(find_missing_expansion_chains(_snap(["A"], []), [], []), [])

    def test_missing_answer_chain(self):
        snapshot = _snap(["A"], [])
        missing = find_missing_expansion_chains(snapshot, [], ["A"])
        self.assertEqual(missing[0]["reason"], "缺少 AI 回答节点链（未创建并连接 answer 节点）")

    def test_answer_without_learn_module(self):
        snapshot = _snap(["A"], [])
        ops = [
            {"op": "create_node", "temp_id": "a1", "assigned_id": "ANS1", "kind": "answer", "label": "回答"},
            {"op": "add_edge", "from": "A", "to": "ANS1", "reason": "连"},
        ]
        missing = find_missing_expansion_chains(snapshot, ops, ["A"])
        self.assertEqual(missing[0]["reason"], "AI 回答节点未连接进阶学习模块")

    def test_complete_chain_passes(self):
        snapshot = _snap(["A"], [])
        ops = [
            {"op": "create_node", "temp_id": "a1", "assigned_id": "ANS1", "kind": "answer", "label": "回答"},
            {"op": "create_node", "temp_id": "l1", "assigned_id": "LEARN1", "kind": "module", "module_key": "learn", "label": "进阶"},
            {"op": "add_edge", "from": "A", "to": "ANS1", "reason": "连"},
            {"op": "add_edge", "from": "ANS1", "to": "LEARN1", "reason": "连"},
        ]
        self.assertEqual(find_missing_expansion_chains(snapshot, ops, ["A"]), [])


if __name__ == "__main__":
    unittest.main()
