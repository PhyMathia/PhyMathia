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


    def test_detect_phase_modify_intent_is_normal(self):
        self.assertEqual(
            _detect_phase("normal", "修改这个回答", {"nodes": [], "edges": []}),
            "normal",
        )
        self.assertEqual(
            _detect_phase("normal", "改进一下这个回答", {"nodes": [], "edges": []}),
            "normal",
        )
        self.assertEqual(
            _detect_phase("normal", "哪里需要改进", {"nodes": [], "edges": []}),
            "evaluate",
        )

    def test_detect_phase_evaluate_still_works(self):
        self.assertEqual(
            _detect_phase("normal", "评价并修改这个回答", {"nodes": [], "edges": []}),
            "evaluate",
        )
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


class HarnessToolsTest(unittest.TestCase):
    def test_build_tools_per_phase(self):
        from harness.tools import PHASE_TOOLS, build_tools
        self.assertEqual(
            set(PHASE_TOOLS["normal"]),
            {"create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"},
        )
        self.assertEqual(PHASE_TOOLS["evaluate"], ["create_eval_node"])
        self.assertNotIn("create_node", PHASE_TOOLS["apply"])
        self.assertEqual(len(build_tools("normal")), 6)
        self.assertEqual(len(build_tools("evaluate")), 1)
        self.assertEqual(len(build_tools("apply")), 5)
        self.assertEqual(build_tools("resolve"), [])

    def test_parse_tool_calls_basic(self):
        from harness.tools import parse_tool_calls
        ops, errors = parse_tool_calls([
            {"function": {"name": "create_node", "arguments": '{"temp_id": "n_lim", "kind": "knowledge", "label": "极限", "reason": "补全基础"}'}},
            {"function": {"name": "add_edge", "arguments": '{"from": "n_lim", "to": "A", "relation": "依赖", "reason": "导数需要极限"}'}},
            {"function": {"name": "delete_node", "arguments": '{"node_id": "H", "reason": "超纲"}'}},
            {"function": {"name": "update_node", "arguments": '{"node_id": "A", "patch": {"label": "瞬时变化率"}, "reason": "更准确"}'}},
        ])
        self.assertEqual(errors, [])
        self.assertEqual([op["op"] for op in ops], ["create_node", "add_edge", "delete_node", "update_node"])
        self.assertEqual(ops[0]["temp_id"], "n_lim")
        self.assertEqual(ops[2]["id"], "H")
        self.assertEqual(ops[3]["id"], "A")
        self.assertEqual(ops[3]["patch"]["label"], "瞬时变化率")

    def test_parse_tool_calls_bad_arguments(self):
        from harness.tools import parse_tool_calls
        ops, errors = parse_tool_calls([
            {"function": {"name": "delete_node", "arguments": "{not json"}},
        ])
        self.assertEqual(ops, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("不是合法 JSON", errors[0]["reason"])

    def test_parse_tool_calls_missing_required(self):
        from harness.tools import parse_tool_calls
        ops, errors = parse_tool_calls([
            {"function": {"name": "delete_node", "arguments": '{"node_id": "H"}'}},
        ])
        self.assertEqual(ops, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("缺少必填参数", errors[0]["reason"])

    def test_parse_tool_calls_unknown_tool(self):
        from harness.tools import parse_tool_calls
        ops, errors = parse_tool_calls([
            {"function": {"name": "explode", "arguments": "{}"}},
        ])
        self.assertEqual(ops, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("不支持的工具", errors[0]["reason"])


class HarnessConflictTest(unittest.TestCase):
    def test_conflict_update_then_delete_skips_update(self):
        result = build_next_snapshot(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            [
                {"op": "update_node", "id": "A", "patch": {"label": "瞬时变化率"}, "reason": "更准确"},
                {"op": "delete_node", "id": "A", "reason": "删除错误节点"},
            ],
        )
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["operations"]), 1)
        self.assertEqual(result["operations"][0]["op"], "delete_node")
        self.assertTrue(any("update 操作被跳过" in item.get("reason", "") for item in result["errors"]))

    def test_conflict_delete_then_update_skips_update(self):
        result = build_next_snapshot(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            [
                {"op": "delete_node", "id": "A", "reason": "删除"},
                {"op": "update_node", "id": "A", "patch": {"label": "改"}, "reason": "再改"},
            ],
        )
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["operations"]), 1)
        self.assertEqual(result["operations"][0]["op"], "delete_node")

    def test_conflict_add_edge_to_deleted_node(self):
        result = build_next_snapshot(
            {
                "nodes": [
                    {"id": "A", "kind": "knowledge", "label": "A"},
                    {"id": "B", "kind": "knowledge", "label": "B"},
                ],
                "edges": [],
            },
            [
                {"op": "delete_node", "id": "A", "reason": "删除"},
                {"op": "add_edge", "from": "A", "to": "B", "relation": "依赖", "reason": "加边"},
            ],
        )
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["operations"]), 1)
        self.assertTrue(any("add_edge 引用了即将被删除" in item.get("reason", "") for item in result["errors"]))


class HarnessReviewModelTest(unittest.TestCase):
    def test_review_graph_uses_tool_calls(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            self.assertTrue(tools)
            return {
                "content": "删除超纲节点",
                "tool_calls": [
                    {"function": {"name": "delete_node", "arguments": '{"node_id": "H", "reason": "超纲"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "H", "kind": "knowledge", "label": "超纲内容"}], "edges": []},
                "把 H 删掉",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["op"], "delete_node")
        self.assertEqual(result["operations"][0]["id"], "H")
        self.assertEqual(result["summary"], "删除超纲节点")

    def test_review_graph_falls_back_to_json_when_tools_rejected(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if tools:
                raise review_mod.HarnessError("模型返回 400: tools not supported")
            return {
                "content": '{"summary": "删除", "operations": [{"op": "delete_node", "id": "H", "reason": "超纲"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "H", "kind": "knowledge", "label": "超纲内容"}], "edges": []},
                "把 H 删掉",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="auto",
                self_check="off",
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["op"], "delete_node")

    def test_review_graph_rejects_eval_node_in_normal_phase(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '{"summary": "x", "operations": [{"op": "create_eval_node", "temp_id": "e", "target_node_id": "A", "suggestion": "改", "reason": "评价"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "整理层级",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                retries=0,
            ))
        self.assertEqual(result["status"], "parse_error")
        self.assertTrue(any("不能创建 AI 评价节点" in item.get("reason", "") for item in result["errors"]))


class HarnessSemanticsTest(unittest.TestCase):
    def test_isolated_created_node(self):
        from harness.semantics import find_isolated_created_nodes
        snapshot = {"nodes": [{"id": "A", "kind": "knowledge", "label": "A"}], "edges": []}
        ops = [
            {"op": "create_node", "temp_id": "n1", "assigned_id": "hn_1", "label": "新节点", "kind": "knowledge"},
            {"op": "add_edge", "from": "hn_1", "to": "A", "reason": "连接"},
        ]
        self.assertEqual(find_isolated_created_nodes(snapshot, ops), [])
        ops2 = [{"op": "create_node", "temp_id": "n1", "assigned_id": "hn_1", "label": "新节点", "kind": "knowledge"}]
        isolated = find_isolated_created_nodes(snapshot, ops2)
        self.assertEqual(len(isolated), 1)
        self.assertEqual(isolated[0]["id"], "hn_1")

    def test_isolated_component_of_created_nodes(self):
        from harness.semantics import find_isolated_created_nodes
        snapshot = {"nodes": [{"id": "A", "kind": "knowledge", "label": "A"}], "edges": []}
        ops = [
            {"op": "create_node", "temp_id": "n1", "assigned_id": "hn_1", "label": "X", "kind": "knowledge"},
            {"op": "create_node", "temp_id": "n2", "assigned_id": "hn_2", "label": "Y", "kind": "knowledge"},
            {"op": "add_edge", "from": "hn_1", "to": "hn_2", "reason": "互连"},
        ]
        isolated = find_isolated_created_nodes(snapshot, ops)
        self.assertEqual(len(isolated), 2)
        ops.append({"op": "add_edge", "from": "hn_2", "to": "A", "reason": "连已有"})
        self.assertEqual(find_isolated_created_nodes(snapshot, ops), [])

    def test_rule_selfcheck_focus_untouched(self):
        from harness.semantics import rule_selfcheck
        result = rule_selfcheck(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "A"}], "edges": []},
            "修改 A 的标题",
            ["A"],
            [{"op": "delete_node", "id": "B", "reason": "x"}],
        )
        self.assertFalse(result["ok"])
        self.assertTrue(any("未在本次操作中涉及" in issue for issue in result["issues"]))

    def test_rule_selfcheck_imperative_zero_ops(self):
        from harness.semantics import rule_selfcheck
        result = rule_selfcheck({"nodes": [], "edges": []}, "请删除这个节点", [], [])
        self.assertFalse(result["ok"])
        self.assertTrue(any("没有提出任何操作" in issue for issue in result["issues"]))

    def test_rule_selfcheck_over_delete(self):
        from harness.semantics import rule_selfcheck
        nodes = [{"id": "n%d" % i, "kind": "knowledge", "label": "n%d" % i} for i in range(10)]
        ops = [{"op": "delete_node", "id": "n%d" % i, "reason": "清理"} for i in range(6)]
        result = rule_selfcheck({"nodes": nodes, "edges": []}, "清理", [], ops)
        self.assertFalse(result["ok"])
        self.assertTrue(any("删除节点较多" in issue for issue in result["issues"]))


class HarnessSelfCheckTest(unittest.TestCase):
    def test_parse_selfcheck_ok(self):
        from harness.selfcheck import parse_selfcheck
        parsed = parse_selfcheck('{"ok": true, "issues": [], "missing": []}')
        self.assertTrue(parsed["ok"])

    def test_parse_selfcheck_not_ok(self):
        from harness.selfcheck import parse_selfcheck
        parsed = parse_selfcheck('{"ok": false, "issues": ["选错节点"], "missing": ["删除 H"]}')
        self.assertFalse(parsed["ok"])
        self.assertIn("选错节点", parsed["issues"])
        self.assertIn("删除 H", parsed["missing"])

    def test_parse_selfcheck_bad_json_does_not_block(self):
        from harness.selfcheck import parse_selfcheck
        parsed = parse_selfcheck("不是 JSON")
        self.assertTrue(parsed["ok"])
        self.assertTrue(parsed.get("parse_error"))

    def test_review_graph_isolated_node_triggers_retry(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                return {
                    "content": "",
                    "tool_calls": [
                        {"function": {"name": "create_node", "arguments": '{"temp_id": "n1", "kind": "knowledge", "label": "新概念", "reason": "补全"}'}},
                    ],
                }
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "create_node", "arguments": '{"temp_id": "n1", "kind": "knowledge", "label": "新概念", "reason": "补全"}'}},
                    {"function": {"name": "add_edge", "arguments": '{"from": "n1", "to": "A", "relation": "依赖", "reason": "连接到已有节点"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "补一个前置概念",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                retries=1,
                self_check="off",
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["operations"]), 2)
        self.assertEqual(result["operations"][1]["op"], "add_edge")

    def test_review_graph_isolated_node_warning_on_final_attempt(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "create_node", "arguments": '{"temp_id": "n1", "kind": "knowledge", "label": "独立概念", "reason": "补全"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "补一个独立概念",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                retries=0,
                self_check="off",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(any("未连接到已有节点" in item.get("reason", "") for item in result["warnings"]))

    def test_review_graph_critic_retries_once(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "update_node", "arguments": '{"node_id": "B", "patch": {"label": "改"}, "reason": "改"}'}},
                ],
            }

        async def fake_selfcheck(snapshot, instruction, ops, model):
            return {"ok": False, "issues": ["用户要求删除 H，但操作只修改了 B"], "missing": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            with unittest.mock.patch.object(review_mod, "_selfcheck_ops", new=fake_selfcheck):
                result = asyncio.run(review_mod.review_graph(
                    {"nodes": [{"id": "B", "kind": "knowledge", "label": "B"}, {"id": "H", "kind": "knowledge", "label": "H"}], "edges": []},
                    "把 H 删掉",
                    model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                    mode="tools",
                    retries=1,
                    self_check="auto",
                ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["status"], "ok")

    def test_review_graph_critic_ok_single_pass(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "delete_node", "arguments": '{"node_id": "H", "reason": "超纲"}'}},
                ],
            }

        async def fake_selfcheck(snapshot, instruction, ops, model):
            return {"ok": True, "issues": [], "missing": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            with unittest.mock.patch.object(review_mod, "_selfcheck_ops", new=fake_selfcheck):
                result = asyncio.run(review_mod.review_graph(
                    {"nodes": [{"id": "H", "kind": "knowledge", "label": "超纲"}], "edges": []},
                    "把 H 删掉",
                    model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                    mode="tools",
                    retries=1,
                    self_check="auto",
                ))
        self.assertEqual(calls["n"], 1)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["self_check"]["critic"]["ok"])


    def test_parse_selfcheck_tool(self):
        from harness.selfcheck import parse_selfcheck_tool
        parsed = parse_selfcheck_tool([
            {"function": {"name": "submit_selfcheck", "arguments": '{"ok": false, "issues": ["选错节点"], "missing": ["删除 H"]}'}},
        ])
        self.assertFalse(parsed["ok"])
        self.assertIn("选错节点", parsed["issues"])
        self.assertIn("删除 H", parsed["missing"])

    def test_selfcheck_ops_uses_tool(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            self.assertTrue(tools)
            self.assertEqual(tool_choice, "required")
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "submit_selfcheck", "arguments": '{"ok": true, "issues": [], "missing": []}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod._selfcheck_ops(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "A"}], "edges": []},
                "删除 H",
                [{"op": "delete_node", "id": "H", "reason": "x"}],
                {"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
            ))
        self.assertTrue(result["ok"])

    def test_selfcheck_ops_falls_back_to_text_json(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if tools:
                raise review_mod.HarnessError("模型返回 400: tools not supported")
            return {"content": '{"ok": true, "issues": [], "missing": []}', "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod._selfcheck_ops(
                {"nodes": [], "edges": []},
                "整理",
                [],
                {"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
            ))
        self.assertEqual(calls["n"], 2)
        self.assertTrue(result["ok"])


class HarnessCompressTest(unittest.TestCase):
    def test_compact_snapshot_trims_non_focus(self):
        import json
        from harness.review import _compact_snapshot
        nodes = []
        for i in range(100):
            nodes.append({"id": "n%d" % i, "kind": "knowledge", "label": "节点%d" % i, "content": "内" * 500, "formula": "F=ma"})
        snapshot = {"version": 1, "nodes": nodes, "edges": []}
        self.assertGreater(len(json.dumps(snapshot, ensure_ascii=False)), 40000)
        compact = _compact_snapshot(snapshot, ["n0"])
        self.assertLessEqual(len(compact["nodes"][1]["content"]), 120)
        self.assertGreater(len(compact["nodes"][0]["content"]), 120)
        self.assertEqual(compact["nodes"][1]["formula"], "")

    def test_compact_snapshot_too_large_raises(self):
        from harness.review import HarnessError, _compact_snapshot
        nodes = []
        for i in range(700):
            nodes.append({"id": "n%d" % i, "kind": "knowledge", "label": "节点%d" % i, "content": "内" * 1200, "formula": "F=ma"})
        snapshot = {"version": 1, "nodes": nodes, "edges": []}
        with self.assertRaises(HarnessError):
            _compact_snapshot(snapshot, [])


class HarnessExpandTest(unittest.TestCase):
    def test_detect_phase_expand_with_focus(self):
        self.assertEqual(
            _detect_phase("normal", "这五个知识点如何拓展", {"nodes": []}, ["A", "B"]),
            "expand",
        )
        self.assertEqual(
            _detect_phase("normal", "这五个知识点如何拓展", {"nodes": []}, []),
            "normal",
        )
        self.assertEqual(
            _detect_phase("expand", "拓展一下", {"nodes": []}, ["A"]),
            "expand",
        )

    def test_build_expand_messages_includes_focus(self):
        from harness.prompts import build_expand_messages
        messages = build_expand_messages(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            "如何拓展",
            focus_node_ids=["A"],
        )
        self.assertIn("进阶学习", messages[0]["content"])
        self.assertIn("用户重点指定的节点", messages[1]["content"])
        self.assertIn("A", messages[1]["content"])

    def test_find_missing_expansion_chains_ok(self):
        from harness.semantics import find_missing_expansion_chains
        ops = [
            {"op": "create_node", "temp_id": "a", "assigned_id": "A1", "kind": "answer", "label": "进阶", "reason": "x"},
            {"op": "create_node", "temp_id": "l", "assigned_id": "L1", "kind": "module", "module_key": "learn", "label": "进阶学习", "reason": "x"},
            {"op": "add_edge", "from": "K", "to": "A1", "reason": "x"},
            {"op": "add_edge", "from": "A1", "to": "L1", "reason": "x"},
        ]
        self.assertEqual(find_missing_expansion_chains({"nodes": []}, ops, ["K"]), [])

    def test_find_missing_expansion_chains_missing_answer_edge(self):
        from harness.semantics import find_missing_expansion_chains
        ops = [
            {"op": "create_node", "temp_id": "a", "assigned_id": "A1", "kind": "answer", "label": "进阶", "reason": "x"},
            {"op": "create_node", "temp_id": "l", "assigned_id": "L1", "kind": "module", "module_key": "learn", "label": "进阶学习", "reason": "x"},
            {"op": "add_edge", "from": "A1", "to": "L1", "reason": "x"},
        ]
        missing = find_missing_expansion_chains({"nodes": []}, ops, ["K"])
        self.assertEqual(len(missing), 1)
        self.assertIn("缺少 AI 回答节点链", missing[0]["reason"])

    def test_find_missing_expansion_chains_missing_learn_edge(self):
        from harness.semantics import find_missing_expansion_chains
        ops = [
            {"op": "create_node", "temp_id": "a", "assigned_id": "A1", "kind": "answer", "label": "进阶", "reason": "x"},
            {"op": "create_node", "temp_id": "l", "assigned_id": "L1", "kind": "module", "module_key": "learn", "label": "进阶学习", "reason": "x"},
            {"op": "add_edge", "from": "K", "to": "A1", "reason": "x"},
            {"op": "add_edge", "from": "X", "to": "L1", "reason": "x"},
        ]
        missing = find_missing_expansion_chains({"nodes": []}, ops, ["K"])
        self.assertEqual(len(missing), 1)
        self.assertIn("未连接进阶学习模块", missing[0]["reason"])

    def test_review_graph_expand_chain_retry(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                # L1 连到了已有节点 X，避免孤立；但缺少 A1->L1 边，链不完整
                return {
                    "content": "",
                    "tool_calls": [
                        {"function": {"name": "create_node", "arguments": '{"temp_id": "a", "kind": "answer", "label": "进阶", "reason": "x"}'}},
                        {"function": {"name": "create_node", "arguments": '{"temp_id": "l", "kind": "module", "module_key": "learn", "label": "进阶学习", "reason": "x"}'}},
                        {"function": {"name": "add_edge", "arguments": '{"from": "K", "to": "a", "relation": "进阶", "reason": "x"}'}},
                        {"function": {"name": "add_edge", "arguments": '{"from": "X", "to": "l", "relation": "模块", "reason": "x"}'}},
                    ],
                }
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "create_node", "arguments": '{"temp_id": "a", "kind": "answer", "label": "进阶", "reason": "x"}'}},
                    {"function": {"name": "create_node", "arguments": '{"temp_id": "l", "kind": "module", "module_key": "learn", "label": "进阶学习", "reason": "x"}'}},
                    {"function": {"name": "add_edge", "arguments": '{"from": "K", "to": "a", "relation": "进阶", "reason": "x"}'}},
                    {"function": {"name": "add_edge", "arguments": '{"from": "a", "to": "l", "relation": "模块", "reason": "x"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {
                    "nodes": [
                        {"id": "K", "kind": "knowledge", "label": "导数"},
                        {"id": "X", "kind": "knowledge", "label": "极限"},
                    ],
                    "edges": [],
                },
                "这五个知识点如何拓展",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                retries=1,
                self_check="off",
                phase="expand",
                focus_node_ids=["K"],
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len(result["operations"]), 4)


class HarnessChatTest(unittest.TestCase):
    def test_review_graph_chat_only_answer(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0, "tool_choice": None}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            calls["tool_choice"] = tool_choice
            return {"content": "导数描述的是瞬时变化率，可以理解为速度……", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "解释一下导数是什么",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
            ))
        self.assertEqual(calls["n"], 1)
        self.assertEqual(calls["tool_choice"], "auto")
        self.assertEqual(result["status"], "no_ops")
        self.assertEqual(result["operations"], [])
        self.assertIn("瞬时变化率", result["summary"])

    def test_review_graph_edit_intent_uses_required_tool_choice(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {"tool_choice": None}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            captured["tool_choice"] = tool_choice
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "delete_node", "arguments": '{"node_id": "H", "reason": "超纲"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "H", "kind": "knowledge", "label": "超纲"}], "edges": []},
                "把 H 删掉",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
            ))
        self.assertEqual(captured["tool_choice"], "required")
        self.assertEqual(result["operations"][0]["op"], "delete_node")


if __name__ == "__main__":
    unittest.main()
