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
    def test_model_calls_counted_on_result(self):
        """F1-R4: 结果应携带 model_calls 计数（主路径 1 次调用）。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": '{"summary": "已修改导数内容", "operations": [{"op": "update_node", "node_id": "A", "patch": {"content": "新内容"}, "reason": "r"}]}', "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "把导数内容改掉",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode="json", self_check="off",
            ))
        self.assertEqual(result.get("model_calls"), 1)

    def test_snapshot_prompt_slimmed(self):
        """F1-R4: 提示词里的快照应剔除空/默认字段并紧凑序列化。"""
        from harness.prompts import build_review_messages

        snap = {"version": 1, "nodes": [
            {"id": "A", "kind": "knowledge", "label": "导数", "content": "c", "formula": "",
             "module_key": "", "manual": False, "target_node_id": "", "target_label": "",
             "suggestion": "", "priority": "medium", "status": "", "read_only": False},
        ], "edges": []}
        msgs = build_review_messages(snap, "改一下")
        text = msgs[-1]["content"]
        self.assertNotIn('"target_node_id"', text)
        self.assertNotIn('"manual"', text)
        self.assertIn('"label"', text)

    def test_resolve_deterministic_fast_path_zero_calls(self):
        """F1-R4: 引号标签唯一定位时 resolve 零模型调用。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {"content": "{}", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.resolve_focus(
                {"nodes": [{"id": "D", "kind": "human_note", "label": "我的理解"}], "edges": []},
                "把「我的理解」的内容改得更清楚一些",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
            ))
        self.assertEqual(calls["n"], 0)
        self.assertEqual(result["focus_node_ids"], ["D"])
        self.assertTrue(result.get("deterministic"))

    def test_resolve_ambiguous_quoted_term_falls_back_to_model(self):
        """引号词命中多个/零个节点时应回退模型解析，不能瞎猜。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {"content": '{"focus_node_ids": ["N1"]}', "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.resolve_focus(
                {"nodes": [
                    {"id": "N1", "kind": "knowledge", "label": "导数"},
                    {"id": "N2", "kind": "knowledge", "label": "导数"},
                 ], "edges": []},
                "把「导数」删掉",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
            ))
        self.assertGreaterEqual(calls["n"], 1)
        self.assertEqual(result["focus_node_ids"], ["N1"])

    def test_context_metrics_attached_to_result(self):
        """F1-R5: 结果应携带 context_metrics（est_tokens 等）供长期追踪。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": '{"summary": "已修改", "operations": [{"op": "update_node", "node_id": "A", "patch": {"content": "x"}, "reason": "r"}]}', "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "c"}], "edges": []},
                "改内容",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode="json", self_check="off",
            ))
        cm = result.get("context_metrics") or {}
        self.assertIn("est_tokens", cm)
        self.assertGreater(cm.get("est_tokens", 0), 0)

    def test_selfcheck_prompt_compact(self):
        """F1-R5: selfcheck 提示词应为紧凑序列化（无缩进换行浪费）。"""
        from harness.selfcheck import build_selfcheck_messages

        msgs = build_selfcheck_messages(
            "删掉B",
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"},
                       {"id": "B", "kind": "knowledge", "label": "极限"}],
             "edges": [{"key": "A:out-0->B:in-0", "from": "A", "to": "B"}]},
            [{"op": "delete_node", "node_id": "B", "reason": "r"}],
        )
        text = msgs[-1]["content"]
        self.assertNotIn('\n  "', text)  # 无两空格缩进的键行
        self.assertIn('"id":"A"', text.replace(" ", "")) or self.assertIn('{"id"', text)

    def test_evaluate_focus_miss_retries_then_hits(self):
        """F1-R8: 评价未命中重点节点时应带反馈重试并最终命中。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            import json
            calls["n"] += 1
            if calls["n"] == 1:
                target = "C"  # 第一次评错对象
            else:
                target = "D"
            return {"content": json.dumps({
                "summary": f"评价了节点",
                "operations": [{"op": "create_eval_node", "temp_id": "e1", "target_node_id": target,
                                "suggestion": "s", "priority": "high", "reason": "r"}]}, ensure_ascii=False),
                "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [
                    {"id": "C", "kind": "module", "label": "物理视角"},
                    {"id": "D", "kind": "human_note", "label": "我的理解"},
                 ], "edges": []},
                "评价一下我对导数的理解",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode="json", self_check="off",
                focus_node_ids=["D"],
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["operations"][0]["target_node_id"], "D")

    def test_update_focus_miss_retries_then_hits(self):
        """F1-R8: 修改未命中重点节点时应带反馈重试并最终命中。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            import json
            calls["n"] += 1
            nid = "B" if calls["n"] == 1 else "A"
            return {"content": json.dumps({
                "summary": "已修改",
                "operations": [{"op": "update_node", "node_id": nid, "patch": {"content": "x"}, "reason": "r"}]},
                ensure_ascii=False), "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [
                    {"id": "A", "kind": "knowledge", "label": "导数"},
                    {"id": "B", "kind": "knowledge", "label": "极限"},
                 ], "edges": []},
                "把导数的定义改得更严谨一些",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode="json", self_check="off",
                focus_node_ids=["A"],
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["operations"][0]["id"], "A")

    def test_refusal_explained_accepts_empty_ops_without_retry(self):
        """F1: 目标不存在等合法拒绝（空操作+说明）不应触发强制重试。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {
                "content": '{"summary": "当前图里没有找到名为 H 的节点，未做任何修改；现有节点为导数、极限。", "operations": []}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "把 H 节点删掉，它超纲了",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://x", "api_key": ""},
                mode="auto",
                self_check="off",
            ))
        self.assertEqual(calls["n"], 1)
        self.assertEqual(result["status"], "no_ops")
        self.assertIn("没有找到", result["summary"])

    def test_lazy_empty_ops_still_triggers_retry(self):
        """无解释的空操作仍应被强制重试（防模型偷懒）。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {"content": '{"summary": "好的。", "operations": []}', "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "给导数补充内容",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://x", "api_key": ""},
                mode="auto",
                self_check="off",
                retries=1,
            ))
        self.assertEqual(calls["n"], 2)

    def test_evaluate_empty_graph_short_circuits_without_model_call(self):
        """F1: 空图的评价阶段应零调用直接短路返回。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            return {"content": "{}", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [], "edges": []},
                "评价一下这个图",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://x", "api_key": ""},
                mode="auto",
                self_check="off",
            ))
        self.assertEqual(calls["n"], 0)
        self.assertNotEqual(result["status"], "error")
        self.assertEqual(result["operations"], [])

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
                    {"function": {"name": "delete_node", "arguments": '{"node_id": "H", "reason": "超纲"}'}},
                ],
            }

        async def fake_selfcheck(snapshot, instruction, ops, model, counter=None):
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

        async def fake_selfcheck(snapshot, instruction, ops, model, counter=None):
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
                model={"provider": "deepseek", "model": "deepseek-chat", "base_url": "https://api.deepseek.com", "api_key": ""},
                mode="tools",
                self_check="off",
            ))
        self.assertEqual(captured["tool_choice"], "required")
        self.assertEqual(result["operations"][0]["op"], "delete_node")



class HarnessSummaryFallbackTest(unittest.TestCase):
    def test_fallback_summary_generated_when_model_content_empty(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "create_node", "arguments": '{"temp_id": "n1", "kind": "module", "module_key": "physics", "label": "物理视角", "reason": "用户要求"}'}},
                    {"function": {"name": "add_edge", "arguments": '{"from": "A", "to": "n1", "relation": "物理意义", "reason": "补充视角"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "给导数加物理视角",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["summary"].strip())
        self.assertIn("新增", result["summary"])

    def test_chat_answer_keeps_model_summary(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": "导数描述的是瞬时变化率……", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "解释一下导数是什么",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
            ))
        self.assertEqual(result["summary"], "导数描述的是瞬时变化率……")


class HarnessDedupWarningTest(unittest.TestCase):
    def test_rule_selfcheck_warns_duplicate_module(self):
        from harness.semantics import rule_selfcheck

        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "C", "kind": "module", "module_key": "physics", "label": "物理视角"},
            ],
            "edges": [],
        }
        ops = [
            {"op": "create_node", "temp_id": "n_phy2", "kind": "module", "module_key": "physics", "label": "物理视角2"},
        ]
        check = rule_selfcheck(snapshot, "给导数加物理视角", [], ops)
        self.assertFalse(check["ok"])
        self.assertTrue(any("重复" in issue for issue in check["issues"]))

    def test_rule_selfcheck_no_warning_for_new_module_key(self):
        from harness.semantics import rule_selfcheck

        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "C", "kind": "module", "module_key": "physics", "label": "物理视角"},
            ],
            "edges": [],
        }
        ops = [
            {"op": "create_node", "temp_id": "n_math", "kind": "module", "module_key": "math", "label": "数学视角"},
        ]
        check = rule_selfcheck(snapshot, "给导数加数学视角", [], ops)
        self.assertTrue(check["ok"])


class HarnessJsonExtractHardeningTest(unittest.TestCase):
    def test_extract_json_trailing_comma(self):
        from harness.json_utils import extract_json

        payload = extract_json('{"summary": "x", "operations": [{"op": "create_node", "temp_id": "n1", "kind": "knowledge", "label": "L", "reason": "r",},],}')
        self.assertIsNotNone(payload)
        self.assertEqual(payload["operations"][0]["op"], "create_node")

    def test_extract_json_truncated_tail(self):
        from harness.json_utils import extract_json

        payload = extract_json('{"summary": "x", "operations": [{"op": "create_node", "temp_id": "n1", "kind": "knowledge", "label": "L", "reason": "r"}]}')
        self.assertIsNotNone(payload)
        self.assertEqual(payload["summary"], "x")

    def test_extract_json_prose_after_json(self):
        from harness.json_utils import extract_json

        payload = extract_json('结果如下：{"summary": "s", "operations": []}，以上是修改建议。')
        self.assertIsNotNone(payload)
        self.assertEqual(payload["summary"], "s")


class HarnessArrayPayloadTest(unittest.TestCase):
    def test_extract_json_top_level_array(self):
        from harness.json_utils import extract_json

        payload = extract_json('[{"op": "create_node", "temp_id": "n1", "kind": "knowledge", "label": "L", "reason": "r"}]')
        self.assertIsInstance(payload, list)
        self.assertEqual(payload[0]["op"], "create_node")

    def test_extract_json_fenced_array(self):
        from harness.json_utils import extract_json

        payload = extract_json("""```json
[{"op": "create_node", "temp_id": "n1", "kind": "knowledge", "label": "L", "reason": "r"}]
```""")
        self.assertIsInstance(payload, list)

    def test_review_graph_accepts_top_level_array_with_action_alias(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '[{"action": "create_node", "temp_id": "n1", "kind": "knowledge", "label": "极限", "content": "趋近过程", "reason": "补全基础"}]',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "新增一个极限知识点",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                retries=0,
            ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["op"], "create_node")

    def test_review_graph_normalizes_operation_alias(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '{"summary": "s", "operations": [{"operation": "delete_node", "id": "A", "reason": "删除"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "把 A 删掉",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                retries=0,
            ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["op"], "delete_node")


class HarnessRobustnessTest(unittest.TestCase):
    def test_evaluate_phase_retries_when_empty_ops(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"content": '{"summary": "先看看", "operations": []}', "tool_calls": []}
            return {
                "content": '{"summary": "评价", "operations": [{"op": "create_eval_node", "temp_id": "e1", "target_node_id": "D", "suggestion": "建议补充极限", "priority": "high", "reason": "不够严谨"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [
                    {"id": "A", "kind": "knowledge", "label": "导数"},
                    {"id": "D", "kind": "human_note", "label": "我的理解"},
                ], "edges": []},
                "评价一下我的理解",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                phase="evaluate",
                focus_node_ids=["D"],
                retries=1,
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["op"], "create_eval_node")

    def test_auto_connect_isolated_created_node(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "create_node", "arguments": '{"temp_id": "n1", "kind": "knowledge", "label": "链式法则", "reason": "新增"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "新增知识点：链式法则",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=1,
            ))
        ops = result["operations"]
        add_edges = [op for op in ops if op.get("op") == "add_edge"]
        self.assertTrue(add_edges, "应自动补一条连线避免孤立节点")
        self.assertTrue(any("自动连接" in str(w.get("reason", "")) for w in result.get("warnings", [])))


class HarnessFallbackSummaryEvalTest(unittest.TestCase):
    def test_fallback_summary_names_eval_target(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "create_eval_node", "arguments": '{"temp_id": "e1", "target_node_id": "D", "suggestion": "建议补充极限", "priority": "high", "reason": "不够严谨"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [
                    {"id": "A", "kind": "knowledge", "label": "导数"},
                    {"id": "D", "kind": "human_note", "label": "我的理解"},
                ], "edges": []},
                "评价一下我的理解",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                phase="evaluate",
                focus_node_ids=["D"],
                retries=0,
            ))
        self.assertEqual(result["status"], "ok")
        self.assertIn("D", result["summary"])


class HarnessNestedArgsTest(unittest.TestCase):
    def test_create_node_with_nested_node_object(self):
        from harness.core import build_next_snapshot

        result = build_next_snapshot(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            [
                {
                    "op": "create_node",
                    "reason": "新增",
                    "node": {"temp_id": "n1", "kind": "knowledge", "label": "极限", "content": "趋近过程"},
                },
                {
                    "op": "add_edge",
                    "reason": "连线",
                    "edge": {"from": "n1", "to": "A", "relation": "依赖"},
                },
            ],
        )
        self.assertEqual(result["status"], "ok", result["errors"])
        self.assertEqual(len(result["operations"]), 2)
        created = [op for op in result["operations"] if op.get("op") == "create_node"][0]
        self.assertTrue(created.get("assigned_id"))

    def test_eval_node_on_ai_eval_is_rejected(self):
        from harness.core import build_next_snapshot

        result = build_next_snapshot(
            {"nodes": [
                {"id": "D", "kind": "human_note", "label": "我的理解"},
                {"id": "E1", "kind": "ai_eval", "label": "对「我的理解」的建议"},
            ], "edges": []},
            [
                {"op": "create_eval_node", "temp_id": "e_bad", "target_node_id": "E1", "suggestion": "评价评价", "priority": "low", "reason": "测试"},
            ],
        )
        self.assertEqual(result["status"], "invalid")
        self.assertTrue(any("不能评价 AI 评价节点" in str(e.get("reason")) for e in result["errors"]))


class HarnessNoOpsSummaryTest(unittest.TestCase):
    def test_empty_instruction_gets_fallback_summary(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": "", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
            ))
        self.assertTrue(result["summary"].strip())


class HarnessRepairJsonTest(unittest.TestCase):
    def test_repair_json_truncated_string_and_object(self):
        from harness.json_utils import repair_json

        payload = repair_json('{"temp_id": "eval_B", "target_node_id": "B", "reason": "当前正文过于口语化，')
        self.assertIsNotNone(payload)
        self.assertEqual(payload["target_node_id"], "B")

    def test_repair_json_truncated_before_close(self):
        from harness.json_utils import repair_json

        payload = repair_json('{"temp_id": "n1", "kind": "knowledge", "label": "极限", "reason": "新增"')
        self.assertIsNotNone(payload)
        self.assertEqual(payload["label"], "极限")

    def test_parse_tool_calls_salvages_truncated_args(self):
        from harness.tools import parse_tool_calls

        ops, errors = parse_tool_calls([
            {"function": {"name": "create_eval_node", "arguments": '{"temp_id": "e1", "target_node_id": "B", "suggestion": "补全", "reason": "严谨"'}},
        ])
        self.assertEqual(errors, [])
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], "create_eval_node")

    def test_tool_choice_auto_for_opencode(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {"tool_choice": None}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            captured["tool_choice"] = tool_choice
            return {"content": "", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "评价一下",
                model={"provider": "opencode", "model": "deepseek-v4-flash-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                phase="evaluate",
                retries=0,
            ))
        self.assertEqual(captured["tool_choice"], "auto")


class HarnessEdgeRemapTest(unittest.TestCase):
    def test_update_edge_on_readonly_auto_remaps(self):
        from harness.core import build_next_snapshot

        result = build_next_snapshot(
            {"nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "knowledge", "label": "极限"},
            ], "edges": [
                {"key": "B:out-0->A:in-0", "from": "B", "to": "A", "relation": "依赖", "label": "需要先掌握", "custom": False},
            ]},
            [
                {"op": "update_edge", "edge_key": "B:out-0->A:in-0", "patch": {"relation": "前置"}, "reason": "用户要求"},
            ],
        )
        self.assertEqual(result["status"], "ok", result["errors"])
        self.assertEqual(result["operations"][0]["op"], "update_edge")
        edge = result["next_snapshot"]["edges"][0]
        self.assertEqual(edge["relation"], "前置")


class HarnessUndoTest(unittest.TestCase):
    def _apply(self, snapshot, ops):
        from harness.core import build_next_snapshot

        return build_next_snapshot(snapshot, ops)

    def test_undo_roundtrip_restores_snapshot(self):
        from harness.core import build_inverse_ops, normalize_snapshot

        before = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "原内容", "formula": ""},
                {"id": "B", "kind": "knowledge", "label": "极限", "content": "极限内容", "formula": ""},
            ],
            "edges": [
                {"key": "B:out-0->A:in-0", "from": "B", "to": "A", "relation": "依赖"},
            ],
        }
        ops = [
            {"op": "update_node", "id": "A", "patch": {"content": "新内容"}, "reason": "修改"},
            {"op": "create_node", "temp_id": "n1", "kind": "module", "module_key": "physics", "label": "物理视角", "content": "物理", "reason": "新增"},
            {"op": "add_edge", "from": "A", "to": "n1", "relation": "物理意义", "reason": "连线"},
            {"op": "delete_node", "id": "B", "reason": "删除"},
        ]
        applied = self._apply(before, ops)
        self.assertEqual(applied["status"], "ok", applied["errors"])
        inverse = build_inverse_ops(before, applied["operations"])
        restored = self._apply(applied["next_snapshot"], inverse)
        self.assertEqual(restored["status"], "ok", restored["errors"])
        from harness.core import normalize_snapshot

        def semantic(s):
            nodes = sorted(
                [
                    {
                        "id": n.get("id"),
                        "kind": n.get("kind"),
                        "label": n.get("label"),
                        "content": n.get("content"),
                        "formula": n.get("formula"),
                        "module_key": n.get("module_key"),
                    }
                    for n in s["nodes"]
                ],
                key=lambda n: n["id"],
            )
            edges = sorted(
                [
                    {
                        "key": e.get("key"),
                        "from": e.get("from"),
                        "to": e.get("to"),
                        "relation": e.get("relation"),
                        "label": e.get("label"),
                    }
                    for e in s["edges"]
                ],
                key=lambda e: e["key"],
            )
            return {"nodes": nodes, "edges": edges}

        self.assertEqual(semantic(restored["next_snapshot"]), semantic(normalize_snapshot(before)))

    def test_undo_detected_in_review_graph_without_model_call(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "不应被调用", "tool_calls": []}

        before = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}], "edges": []}
        after = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "新"}], "edges": []}
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                after,
                "撤销刚才的修改",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
                previous_snapshot=before,
                previous_ops=[{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "修改"}],
            ))
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "undo")
        self.assertEqual(result["next_snapshot"]["nodes"][0]["content"], "原")

    def test_clarify_passthrough(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '{"clarify": {"question": "想改哪个节点？", "options": ["导数", "极限"]}}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "帮我改一下这个",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
            ))
        self.assertEqual(result["status"], "clarify")
        self.assertEqual(result["clarify"]["question"], "想改哪个节点？")

    def test_history_block_injected_into_messages(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            captured["user_content"] = messages[-1]["content"]
            return {"content": "明白了", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "再深入一点",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
                history=[
                    {"role": "user", "instruction": "给导数加物理视角"},
                    {"role": "assistant", "summary": "已新增物理视角", "operations": [{"op": "create_node", "temp_id": "n1", "label": "物理视角"}]},
                ],
            ))
        self.assertIn("此前多轮编辑历史", captured["user_content"])
        self.assertIn("给导数加物理视角", captured["user_content"])


class HarnessFullUndoTest(unittest.TestCase):
    def test_full_undo_uses_cumulative_ops(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        initial = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "原"},
                {"id": "B", "kind": "knowledge", "label": "极限", "content": "极限内容"},
            ],
            "edges": [],
        }
        after_all = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "新"},
                {"id": "B", "kind": "knowledge", "label": "极限的定义", "content": "极限内容"},
                {"id": "M", "kind": "module", "module_key": "math", "label": "数学视角", "content": "数学"},
            ],
            "edges": [],
        }
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                after_all,
                "把刚才所有修改全部撤销",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
                previous_snapshot={"nodes": [{"id": "B", "kind": "knowledge", "label": "极限", "content": "极限内容"}], "edges": []},
                previous_ops=[{"op": "update_node", "id": "B", "patch": {"label": "极限的定义"}, "reason": "改名"}],
                initial_snapshot=initial,
                all_previous_ops=[
                    {"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "修改"},
                    {"op": "create_node", "temp_id": "n_m", "kind": "module", "module_key": "math", "label": "数学视角", "content": "数学", "reason": "新增"},
                    {"op": "update_node", "id": "B", "patch": {"label": "极限的定义"}, "reason": "改名"},
                ],
            ))
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "undo")
        ids = [n["id"] for n in result["next_snapshot"]["nodes"]]
        self.assertNotIn("M", ids)
        self.assertEqual(result["next_snapshot"]["nodes"][0]["content"], "原")
        self.assertEqual(result["next_snapshot"]["nodes"][1]["label"], "极限")

    def test_normal_phase_edit_intent_retries_when_no_ops(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"content": "链式法则是复合函数求导的规则……", "tool_calls": []}
            return {
                "content": '{"summary": "新增", "operations": [{"op": "create_node", "temp_id": "n1", "kind": "knowledge", "label": "链式法则", "reason": "新增"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "新增知识点：链式法则",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=1,
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["operations"][0]["op"], "create_node")


class HarnessContextualUndoTest(unittest.TestCase):
    """第三轮：上下文反悔——自然措辞识别、选择性撤销跨历史、边联动过滤。"""

    def test_undo_intent_new_phrases(self):
        from harness.review import _detect_undo_intent

        for phrase in ("我觉得还是改回去比较好", "把刚才加的固有频率撤掉", "这个改动不要了", "刚加的模块撤了"):
            self.assertTrue(_detect_undo_intent(phrase), phrase)
        for phrase in ("把极限节点改一下", "给导数加一个物理视角", "新增知识点：链式法则"):
            self.assertFalse(_detect_undo_intent(phrase), phrase)

    def test_undo_scope_classification(self):
        from harness.review import _undo_scope

        self.assertEqual(_undo_scope("把刚才所有修改全部撤销", []), "full")
        self.assertEqual(_undo_scope("把所有修改全部撤销，回到最初", []), "full")
        self.assertEqual(_undo_scope("刚才简谐运动那边的改动不要了，恢复原样，导数那边保留", ["m1-phy"]), "targeted")
        self.assertEqual(_undo_scope("我觉得还是改回去比较好", ["m1-phy"]), "targeted")
        self.assertEqual(_undo_scope("把刚才加的固有频率撤掉", ["hn_1"]), "targeted")
        self.assertEqual(_undo_scope("撤销刚才的修改", ["A"]), "last")
        self.assertEqual(_undo_scope("撤销刚才的修改", []), "last")

    def test_filter_inverse_keeps_edges_touching_target(self):
        from harness.review import _filter_inverse_by_targets

        inverse = [
            {"op": "remove_edge", "edge_key": "A:out-0->M:in-0", "reason": "撤销"},
            {"op": "delete_node", "id": "M", "reason": "撤销"},
        ]
        current = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}, {"id": "M", "kind": "knowledge", "label": "固有频率"}],
            "edges": [{"key": "A:out-0->M:in-0", "from": "A", "to": "M", "relation": "导出"}],
        }
        kept = _filter_inverse_by_targets(inverse, ["M"], current)
        self.assertEqual([op["op"] for op in kept], ["remove_edge", "delete_node"])

    def test_targeted_undo_reverts_only_focus_across_history(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        initial = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "原"},
                {"id": "B", "kind": "knowledge", "label": "极限", "content": "极限内容"},
            ],
            "edges": [],
        }
        after_all = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "新"},
                {"id": "B", "kind": "knowledge", "label": "极限的定义", "content": "极限内容"},
            ],
            "edges": [],
        }
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                after_all,
                "刚才 A 那边的改动不要了，恢复原样，B 保留",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
                focus_node_ids=["A"],
                previous_snapshot={"nodes": [{"id": "B", "kind": "knowledge", "label": "极限的定义", "content": "极限内容"}], "edges": []},
                previous_ops=[{"op": "update_node", "id": "B", "patch": {"label": "极限的定义"}, "reason": "改名"}],
                initial_snapshot=initial,
                all_previous_ops=[
                    {"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "修改"},
                    {"op": "update_node", "id": "B", "patch": {"label": "极限的定义"}, "reason": "改名"},
                ],
            ))
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "undo")
        nodes = {n["id"]: n for n in result["next_snapshot"]["nodes"]}
        self.assertEqual(nodes["A"]["content"], "原")
        self.assertEqual(nodes["B"]["label"], "极限的定义")

    def test_targeted_undo_created_node_with_edge(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        initial = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}],
            "edges": [],
        }
        after_all = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "原"},
                {"id": "M", "kind": "knowledge", "label": "固有频率", "content": "系统自由振动的频率"},
            ],
            "edges": [
                {"key": "A:out-0->M:in-0", "from": "A", "to": "M", "relation": "导出"},
            ],
        }
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                after_all,
                "把刚才加的固有频率撤掉",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
                focus_node_ids=["M"],
                previous_snapshot=initial,
                previous_ops=[
                    {"op": "create_node", "temp_id": "n_freq", "assigned_id": "M", "kind": "knowledge", "label": "固有频率", "content": "系统自由振动的频率", "reason": "新增"},
                    {"op": "add_edge", "from": "A", "to": "M", "relation": "导出", "edge_key": "A:out-0->M:in-0", "reason": "连线"},
                ],
                initial_snapshot=initial,
                all_previous_ops=[
                    {"op": "create_node", "temp_id": "n_freq", "assigned_id": "M", "kind": "knowledge", "label": "固有频率", "content": "系统自由振动的频率", "reason": "新增"},
                    {"op": "add_edge", "from": "A", "to": "M", "relation": "导出", "edge_key": "A:out-0->M:in-0", "reason": "连线"},
                ],
            ))
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "undo")
        self.assertEqual([n["id"] for n in result["next_snapshot"]["nodes"]], ["A"])
        self.assertEqual(result["next_snapshot"]["edges"], [])


class HarnessConsistencyTest(unittest.TestCase):
    """C：图一致性体检——断链/孤儿/重复标签/重复模块。"""

    def test_clean_graph_ok(self):
        from harness.selfcheck import check_snapshot_consistency

        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "module", "module_key": "physics", "label": "物理视角"},
            ],
            "edges": [
                {"key": "A:out-0->B:in-0", "from": "A", "to": "B", "relation": "物理意义"},
            ],
        }
        result = check_snapshot_consistency(snapshot)
        self.assertTrue(result["ok"])
        self.assertEqual(result["total"], 0)

    def test_broken_edge_reported(self):
        from harness.selfcheck import check_snapshot_consistency

        snapshot = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}],
            "edges": [
                {"key": "A:out-0->X:in-0", "from": "A", "to": "X", "relation": "导出"},
            ],
        }
        result = check_snapshot_consistency(snapshot)
        self.assertFalse(result["ok"])
        types = [item["type"] for item in result["issues"]]
        self.assertIn("broken_edge", types)
        broken = [item for item in result["issues"] if item["type"] == "broken_edge"]
        self.assertTrue(any(item["node_id"] == "X" for item in broken))

    def test_orphan_detected(self):
        from harness.selfcheck import check_snapshot_consistency

        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "knowledge", "label": "极限"},
                {"id": "C", "kind": "knowledge", "label": "连续"},
            ],
            "edges": [{"key": "A:out-0->B:in-0", "from": "A", "to": "B", "relation": "依赖"}],
        }
        result = check_snapshot_consistency(snapshot)
        self.assertTrue(result["ok"])
        orphan = [item for item in result["issues"] if item["type"] == "orphan"]
        self.assertEqual([item["node_id"] for item in orphan], ["C"])

    def test_duplicate_label_and_module(self):
        from harness.selfcheck import check_snapshot_consistency

        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "knowledge", "label": "导数"},
                {"id": "M1", "kind": "module", "module_key": "physics", "label": "物理视角"},
                {"id": "M2", "kind": "module", "module_key": "physics", "label": "物理视角"},
            ],
            "edges": [],
        }
        result = check_snapshot_consistency(snapshot)
        types = [item["type"] for item in result["issues"]]
        self.assertIn("duplicate_label", types)
        self.assertIn("duplicate_module", types)
        self.assertIn("orphan", types)

    def test_health_api_route(self):
        import asyncio

        from harness.api import router
        from fastapi.testclient import TestClient
        from fastapi import FastAPI

        app = FastAPI()
        app.include_router(router, prefix="/api/harness")
        client = TestClient(app)
        resp = client.post("/api/harness/graph/health", json={
            "snapshot": {
                "nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}],
                "edges": [{"key": "A:out-0->X:in-0", "from": "A", "to": "X"}],
            }
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertEqual(data["status"], "ok")
        self.assertFalse(data["ok"])
        self.assertTrue(any(i["type"] == "broken_edge" for i in data["issues"]))


class HarnessExpandCompletionTest(unittest.TestCase):
    def test_expand_auto_completes_missing_learn_module(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '{"summary": "进阶", "operations": [{"op": "create_node", "temp_id": "ans_A", "kind": "answer", "label": "「导数」的进阶学习", "content": "学习方向", "reason": "进阶"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "为导数生成进阶学习链",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                phase="expand",
                focus_node_ids=["A"],
                retries=1,
            ))
        self.assertEqual(result["status"], "ok", result["errors"])
        learns = [op for op in result["operations"] if op.get("op") == "create_node" and op.get("kind") == "module" and op.get("module_key") == "learn"]
        self.assertTrue(learns, "应自动补全 learn 模块")

    def test_expand_auto_completes_missing_answer_chain(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        # 模型只给 A 建了 answer，完全遗漏 B（弱模型合并/遗漏目标的已知行为）
        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '{"summary": "进阶", "operations": [{"op": "create_node", "temp_id": "ans_A", "kind": "answer", "label": "「导数」的进阶学习", "content": "学习方向", "reason": "进阶"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}, {"id": "B", "kind": "knowledge", "label": "极限"}], "edges": []},
                "为导数和极限都生成进阶学习链",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                phase="expand",
                focus_node_ids=["A", "B"],
                retries=1,
            ))
        self.assertEqual(result["status"], "ok", result["errors"])
        ops = result["operations"]
        answers = [op for op in ops if op.get("op") == "create_node" and op.get("kind") == "answer"]
        learns = [op for op in ops if op.get("op") == "create_node" and op.get("kind") == "module" and op.get("module_key") == "learn"]
        self.assertGreaterEqual(len(answers), 2, "应自动为遗漏目标 B 补全 answer 节点")
        self.assertGreaterEqual(len(learns), 2, "应自动补全对应的 learn 模块")
        edges = [(str(op.get("from")), str(op.get("to"))) for op in ops if op.get("op") == "add_edge"]
        answer_ids = set(str(op.get("assigned_id") or op.get("id") or op.get("temp_id")) for op in answers)
        self.assertTrue(any(frm == "B" and to in answer_ids for frm, to in edges), "B 应连到自动补全的 answer 节点")
        self.assertTrue(any(frm in answer_ids and to not in answer_ids for frm, to in edges), "answer 应连到 learn 模块")


class HarnessConcatenatedJsonTest(unittest.TestCase):
    def test_repair_json_concatenated_objects_takes_first(self):
        from harness.json_utils import repair_json

        args = '{"node_id": "D", "patch": {"content": "更深入的理解"}, "reason": "深入"}{"from": "n_math", "to": "A", "relation": "数学意义", "reason": "连线"}'
        payload = repair_json(args)
        self.assertIsNotNone(payload)
        self.assertEqual(payload["node_id"], "D")

    def test_parse_tool_calls_salvages_concatenated_args(self):
        from harness.tools import parse_tool_calls

        ops, errors = parse_tool_calls([
            {"function": {"name": "update_node", "arguments": '{"node_id": "D", "patch": {"content": "x"}, "reason": "r"}{"from": "A", "to": "B", "reason": "e"}'}},
        ])
        self.assertEqual(errors, [])
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], "update_node")


class HarnessNodeIdAliasTest(unittest.TestCase):
    def test_review_graph_accepts_node_id_alias(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": '{"summary": "改", "operations": [{"op": "update_node", "node_id": "A", "patch": {"content": "新"}, "reason": "改"}]}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "改一下",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                retries=0,
            ))
        self.assertEqual(result["status"], "ok", result["errors"])
        self.assertEqual(result["operations"][0]["id"], "A")

    def test_create_node_with_kind_ai_eval_rejected(self):
        from harness.core import build_next_snapshot

        result = build_next_snapshot(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            [{"op": "create_node", "temp_id": "e1", "kind": "ai_eval", "label": "评价", "reason": "绕过"}],
        )
        self.assertEqual(result["status"], "invalid")
        self.assertTrue(any("只能通过 create_eval_node" in str(e.get("reason")) for e in result["errors"]))


class HarnessReadOnlyDeleteTest(unittest.TestCase):
    def test_read_only_node_cannot_be_deleted_by_default(self):
        from harness.core import build_next_snapshot

        result = build_next_snapshot(
            {"nodes": [{"id": "ROOT", "kind": "user", "label": "根问题", "read_only": True}], "edges": []},
            [{"op": "delete_node", "id": "ROOT", "reason": "删除根"}],
        )
        self.assertEqual(result["status"], "invalid")
        self.assertTrue(any("只读节点不能删除" in str(e.get("reason")) for e in result["errors"]))


class HarnessApplyPhaseGuardTest(unittest.TestCase):
    def test_apply_phase_rejects_create_eval_node(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                return {
                    "content": '{"summary": "评价", "operations": [{"op": "create_eval_node", "temp_id": "e1", "target_node_id": "A", "suggestion": "建议", "priority": "high", "reason": "评价"}]}',
                    "tool_calls": [],
                }
            return {
                "content": '{"summary": "应用", "operations": [{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "应用建议"}]}',
                "tool_calls": [],
            }

        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "E1", "kind": "ai_eval", "label": "对「导数」的建议", "target_node_id": "A", "suggestion": "改内容"},
            ],
            "edges": [{"key": "A:out-0->E1:in-0", "from": "A", "to": "E1", "relation": "评价"}],
        }
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                snapshot,
                "应用建议",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="json",
                self_check="off",
                phase="apply",
                retries=1,
            ))
        self.assertEqual(calls["n"], 2)
        self.assertEqual(result["status"], "ok", result["errors"])
        ops = result["operations"]
        self.assertTrue(all(o.get("op") != "create_eval_node" for o in ops))


class HarnessPlaceholderContentTest(unittest.TestCase):
    def test_created_node_content_capped_to_placeholder(self):
        from harness.core import build_next_snapshot

        long_content = "这是一段非常长的正文" * 20
        result = build_next_snapshot(
            {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
            [{"op": "create_node", "temp_id": "n1", "kind": "module", "module_key": "physics", "label": "物理视角", "content": long_content, "reason": "新增"}],
        )
        self.assertEqual(result["status"], "ok", result["errors"])
        created = result["next_snapshot"]["nodes"][-1]
        self.assertLessEqual(len(created["content"]), 80)


class HarnessContextTrimTest(unittest.TestCase):
    def test_trim_harness_context_drops_card_sections(self):
        from harness.prompts import _trim_harness_context
        full = "# 角色\n你是 PhyMathia。\n\n## 完整探索流程\n<physics>...</physics>\n\n## 约束\n1. 禁止编造\n\n## 输出格式\n物理讲述=散文\n\n## 公式查询流程\n直接给出公式"
        out = _trim_harness_context(full)
        self.assertIn("你是 PhyMathia", out)
        self.assertIn("禁止编造", out)
        self.assertNotIn("<physics>", out)
        self.assertNotIn("公式查询流程", out)

    def test_trim_harness_context_short_input_unchanged(self):
        from harness.prompts import _trim_harness_context
        self.assertEqual(_trim_harness_context("简短内容"), "简短内容")


class HarnessSelfCheckSkipTest(unittest.TestCase):
    def test_small_edge_ops_skip_selfcheck(self):
        from harness.review import _should_selfcheck_ops
        self.assertFalse(_should_selfcheck_ops([{"op": "add_edge", "from": "A", "to": "B"}]))
        self.assertFalse(_should_selfcheck_ops([
            {"op": "update_node", "id": "A", "patch": {"label": "x"}},
            {"op": "remove_edge", "edge_key": "k"},
        ]))

    def test_create_delete_or_many_ops_keep_selfcheck(self):
        from harness.review import _should_selfcheck_ops
        self.assertTrue(_should_selfcheck_ops([{"op": "create_node", "temp_id": "n1"}]))
        self.assertTrue(_should_selfcheck_ops([{"op": "delete_node", "id": "A"}]))
        self.assertTrue(_should_selfcheck_ops([{"op": "create_eval_node", "id": "e1"}]))
        many = [{"op": "add_edge", "from": "A", "to": "B" + str(i)} for i in range(4)]
        self.assertTrue(_should_selfcheck_ops(many))




class HarnessResolvePromptTest(unittest.TestCase):
    def test_resolve_prompt_distinguishes_overall_eval(self):
        from harness.prompts import HARNESS_RESOLVE_SYSTEM_PROMPT, build_resolve_messages
        self.assertIn("整体评价", HARNESS_RESOLVE_SYSTEM_PROMPT)
        self.assertIn("focus_node_ids: []", HARNESS_RESOLVE_SYSTEM_PROMPT)
        msgs = build_resolve_messages({"nodes": [], "edges": []}, "你觉得这个做的怎么样")
        self.assertIn("整体评价", msgs[0]["content"])


class HarnessHistoryBlockTest(unittest.TestCase):
    def test_history_block_compresses_old_entries(self):
        from harness.review import _history_block
        history = []
        for i in range(8):
            history.append({"role": "user", "instruction": "指令" + str(i) + "长" * 200})
            history.append({"role": "assistant", "summary": "摘要" + str(i) + "长" * 200,
                            "operations": [{"op": "add_edge", "id": "e" + str(i)}]})
        block = _history_block(history)
        # 最近 6 条详细（3 条助手含操作摘要），更早压缩
        self.assertEqual(block.count("；操作："), 3)
        self.assertIn("1. 用户：指令0", block)
        self.assertNotIn("指令0" + "长" * 200, block)
        lines = block.split("\n")
        first = lines[1]
        self.assertLessEqual(len(first), 130)
        self.assertIn("；操作：add_edge(e7)", block)




if __name__ == "__main__":
    unittest.main()

class HarnessJsonShellSummaryTest(unittest.TestCase):
    """v1.2.1：纯问答时模型把 JSON 整体写进正文（引号未转义）→ 兜底只保留内层 summary。"""

    def test_extract_summary_from_json_shell(self):
        from harness.review import _extract_summary_from_json_shell
        raw = '{\n  "summary": "导数的物理意义本质上就是"变化率"：它刻画瞬时快慢。",\n  "operations": []\n}'
        out = _extract_summary_from_json_shell(raw)
        self.assertIsNotNone(out)
        self.assertIn("变化率", out)
        self.assertNotIn("operations", out)
        self.assertNotIn('"summary"', out)

    def test_extract_summary_plain_text_returns_none(self):
        from harness.review import _extract_summary_from_json_shell
        self.assertIsNone(_extract_summary_from_json_shell("导数的物理意义就是变化率。"))
        self.assertIsNone(_extract_summary_from_json_shell(""))
        self.assertIsNone(_extract_summary_from_json_shell(None))

    def test_extract_summary_escaped_quotes_preserved(self):
        from harness.review import _extract_summary_from_json_shell
        raw = '{\n  "summary": "他说\\"好的\\"，没问题。",\n  "operations": []\n}'
        out = _extract_summary_from_json_shell(raw)
        self.assertIsNotNone(out)
        self.assertIn('"好的"', out)


class HarnessAnchorAddWarningTest(unittest.TestCase):
    """v1.2.1：给 X 加视角类指令，模型扩展现有模块（未直接动 X）不应误报 focus 未涉及。"""

    def _snapshot(self):
        return {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "C", "kind": "module", "module_key": "physics", "label": "物理视角"},
            ],
            "edges": [
                {"key": "A:out-0->C:in-0", "from": "A", "to": "C", "relation": "物理意义"},
            ],
        }

    def test_anchor_add_extend_module_no_warning(self):
        from harness.semantics import rule_selfcheck
        result = rule_selfcheck(
            self._snapshot(),
            "给导数加一个物理视角",
            ["A"],
            [{"op": "update_node", "id": "C", "patch": {"content": "更完整"}, "reason": "扩展现有物理视角"}],
        )
        self.assertTrue(result["ok"])
        self.assertFalse(any("未在本次操作中涉及" in issue for issue in result["issues"]))

    def test_non_anchor_modify_still_warns(self):
        from harness.semantics import rule_selfcheck
        result = rule_selfcheck(
            self._snapshot(),
            "把导数改得更严谨",
            ["A"],
            [{"op": "update_node", "id": "C", "patch": {"content": "x"}, "reason": "改错了目标"}],
        )
        self.assertFalse(result["ok"])
        self.assertTrue(any("未在本次操作中涉及" in issue for issue in result["issues"]))

    def test_anchor_add_with_no_ops_still_warns(self):
        from harness.semantics import rule_selfcheck
        result = rule_selfcheck(self._snapshot(), "给导数加一个物理视角", ["A"], [])
        self.assertFalse(result["ok"])

class FocusSubgraphTest(unittest.TestCase):
    def test_focus_subgraph_keeps_neighborhood(self):
        from harness.review import _focus_subgraph
        snap = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数"},
                {"id": "B", "kind": "module", "module_key": "physics", "label": "物理视角"},
                {"id": "C", "kind": "knowledge", "label": "极限"},
                {"id": "D", "kind": "knowledge", "label": "远节点"},
                {"id": "E", "kind": "ai_eval", "label": "AI 评价"},
            ],
            "edges": [
                {"key": "A->B", "from": "A", "to": "B"},
                {"key": "C->A", "from": "C", "to": "A"},
                {"key": "D->C", "from": "D", "to": "C"},
            ],
        }
        sub = _focus_subgraph(snap, ["A"], max_hops=1, max_nodes=40)
        self.assertIsNotNone(sub)
        ids = {str(n["id"]) for n in sub["nodes"]}
        self.assertIn("A", ids)
        self.assertIn("B", ids)
        self.assertIn("C", ids)
        self.assertNotIn("D", ids)
        self.assertIn("E", ids)
        self.assertEqual(sub["omitted_node_count"], 1)
        self.assertEqual(len(sub["edges"]), 2)

    def test_focus_subgraph_none_without_focus(self):
        from harness.review import _focus_subgraph
        snap = {"nodes": [{"id": "A", "kind": "knowledge"}], "edges": []}
        self.assertIsNone(_focus_subgraph(snap, []))
