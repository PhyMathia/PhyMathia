"""Unit tests for the independent graph harness."""

import os
import sys
import unittest


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness.core import build_next_snapshot, diff_snapshots, normalize_snapshot
from harness.json_utils import extract_json
from harness.prompts import (
    _level_requirement,
    build_apply_messages,
    build_evaluate_messages,
    build_expand_messages,
    build_preset_messages,
    build_resolve_messages,
    build_review_messages,
)
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
        user_text = messages[-1]["content"]
        self.assertIn("PhyMathia 评价标准", system_text)
        # harness 前缀缓存拍板（2026-10-01）：难度后置出 system，落在末条 user 尾部
        self.assertNotIn("当前难度", system_text)
        self.assertIn("PhyMathia 系统上下文", system_text)
        self.assertIn("用户重点指定的节点", user_text)
        self.assertTrue(
            user_text.endswith(_level_requirement("middle")),
            "难度要求必须落在末条 user 消息尾部",
        )

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


class HarnessLevelSuffixPlacementTest(unittest.TestCase):
    """harness 前缀缓存拍板（2026-10-01）：难度等级后置出 system。

    上游按请求前缀做字节级 prompt 缓存：难度文本进 system，切一次难度就打灭
    整个 system 前缀。六个 build 函数统一把难度要求追加到最后一条 user 消息
    尾部，system 保持零难度文本（与主聊天 LEVEL_PROMPTS 尾部做法同构）。"""

    BUILDERS = (
        build_resolve_messages,
        build_review_messages,
        build_evaluate_messages,
        build_apply_messages,
        build_expand_messages,
        build_preset_messages,
    )

    def _build(self, builder, level):
        snapshot = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []}
        return builder(snapshot, "评价一下", context="PhyMathia 系统上下文", level=level)

    def test_all_builders_put_level_at_last_user_tail_and_out_of_system(self):
        expected = _level_requirement("middle")
        self.assertTrue(expected, "middle 档必须有难度文案（三份手工同步，勿清空）")
        for builder in self.BUILDERS:
            with self.subTest(builder=builder.__name__):
                messages = self._build(builder, "middle")
                system_text = messages[0]["content"]
                user_text = messages[-1]["content"]
                self.assertNotIn("当前难度", system_text, "system 不得含难度文本")
                self.assertIn("PhyMathia 系统上下文", system_text)
                self.assertTrue(user_text.endswith(expected), "难度要求必须落在末条 user 消息尾部")
                self.assertIn("\n\n" + expected, user_text)

    def test_empty_level_appends_nothing(self):
        for builder in self.BUILDERS:
            with self.subTest(builder=builder.__name__):
                messages = self._build(builder, "")
                self.assertNotIn("当前难度", messages[0]["content"])
                self.assertNotIn("当前难度", messages[-1]["content"])


class HarnessToolsTest(unittest.TestCase):
    def test_build_tools_per_phase(self):
        from harness.tools import PHASE_TOOLS, READONLY_TOOL_NAMES, build_tools
        edit_tools = {"create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"}
        # T93＋2026-10-03 智能化第二期＋2026-10-09 优化新路径六：normal/expand/
        # apply/preset 追加六只读工具（图查询三件套＋知识检索两件套＋graph_stats
        # 学习体检，先查再改）；coach（路径六第 2 档课程表体检）与 normal 同表
        self.assertEqual(set(PHASE_TOOLS["normal"]), edit_tools | set(READONLY_TOOL_NAMES))
        self.assertEqual(set(PHASE_TOOLS["coach"]), set(PHASE_TOOLS["normal"]))
        self.assertEqual(PHASE_TOOLS["evaluate"], ["create_eval_node"])
        self.assertNotIn("create_node", PHASE_TOOLS["apply"])
        self.assertEqual(len(build_tools("normal")), 12)
        self.assertEqual(len(build_tools("coach")), 12)
        self.assertEqual(len(build_tools("evaluate")), 1)
        self.assertEqual(len(build_tools("apply")), 11)
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

        async def fake_selfcheck(snapshot, instruction, ops, model, counter=None, result_snapshot=None):
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

        async def fake_selfcheck(snapshot, instruction, ops, model, counter=None, result_snapshot=None):
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


    def test_review_graph_critic_receives_result_state(self):
        """路径二第一步：critic 收到的 result_snapshot 必须是操作执行后的结果图，
        before 快照保持旧值——「对账操作单」升级为「对账结果图」的接线穿透。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "update_node", "arguments": '{"node_id": "A", "patch": {"content": "改后的正文"}, "reason": "按指令修改"}'}},
                    {"function": {"name": "delete_node", "arguments": '{"node_id": "H", "reason": "超纲"}'}},
                ],
            }

        async def fake_selfcheck(snapshot, instruction, ops, model, counter=None, result_snapshot=None):
            captured["before"] = snapshot
            captured["result"] = result_snapshot
            return {"ok": True, "issues": [], "missing": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            with unittest.mock.patch.object(review_mod, "_selfcheck_ops", new=fake_selfcheck):
                result = asyncio.run(review_mod.review_graph(
                    {"nodes": [
                        {"id": "A", "kind": "knowledge", "label": "A", "content": "旧正文"},
                        {"id": "H", "kind": "knowledge", "label": "超纲"},
                    ], "edges": []},
                    "把 A 的正文改掉并删掉 H",
                    model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                    mode="tools",
                    retries=1,
                    self_check="auto",
                ))
        self.assertEqual(result["status"], "ok")
        self.assertIsInstance(captured["result"], dict)
        result_nodes = {n["id"]: n for n in captured["result"].get("nodes", [])}
        self.assertEqual(result_nodes["A"]["content"], "改后的正文")
        self.assertNotIn("H", result_nodes)
        before_nodes = {n["id"]: n for n in captured["before"].get("nodes", [])}
        self.assertEqual(before_nodes["A"]["content"], "旧正文")
        self.assertIn("H", before_nodes)

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
            # provider=deepseek 支持 required（opencode 免费档不支持；_selfcheck_ops
            # 09-20 起按 _supports_required_tool_choice 门控，opencode 走 auto）
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
                {"provider": "deepseek", "model": "deepseek-chat", "base_url": "https://api.deepseek.com", "api_key": "k"},
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


class HarnessChecklistTest(unittest.TestCase):
    """路径二第二步（2026-10-09）：显式达成清单——机检/重试/降级/语义条目交 critic。"""

    MODEL = {"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""}

    SNAPSHOT = {
        "nodes": [
            {"id": "A", "kind": "knowledge", "label": "导数", "content": "旧正文", "formula": ""},
            {"id": "H", "kind": "knowledge", "label": "旧笔记", "content": ""},
        ],
        "edges": [],
    }

    def test_verify_checklist_machine_patterns(self):
        from harness.selfcheck import verify_checklist
        before = self.SNAPSHOT
        result = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "新正文", "formula": "F=ma"},
                {"id": "N1", "kind": "knowledge", "label": "新概念", "content": ""},
            ],
            "edges": [{"key": "N1:out-0->A:in-0", "from": "N1", "to": "A", "relation": "支持"}],
        }
        v = verify_checklist([
            "「导数」的 formula 已更新为「F=ma」",      # 更新达成（含空格容忍）
            "「导数」的公式已更新为「F = ma」",
            "「旧笔记」已删除",                          # 删除达成（改前有、结果无）
            "「新概念」已创建",                          # 存在达成
            "「新概念」与「导数」已连线",                # 边达成（无向）
            "「导数」的 label 已更新为「导数（核心）」",  # 更新未达成（改得比声明的少）
            "「幽灵」已删除",                            # 删除未达成（本就没有）
            "「导数」的正文足够严谨",                    # 语义条目（解析不出机检结构）
        ], before, result)
        kinds = {i["text"]: (i["kind"], i["passed"]) for i in v["items"]}
        self.assertEqual(kinds["「导数」的 formula 已更新为「F=ma」"], ("machine", True))
        self.assertEqual(kinds["「导数」的公式已更新为「F = ma」"], ("machine", True))
        self.assertEqual(kinds["「旧笔记」已删除"], ("machine", True))
        self.assertEqual(kinds["「新概念」已创建"], ("machine", True))
        self.assertEqual(kinds["「新概念」与「导数」已连线"], ("machine", True))
        self.assertEqual(kinds["「导数」的 label 已更新为「导数（核心）」"], ("machine", False))
        self.assertEqual(kinds["「幽灵」已删除"], ("machine", False))
        self.assertEqual(kinds["「导数」的正文足够严谨"], ("semantic", None))
        self.assertEqual(v["achieved"], 5)
        self.assertEqual(len(v["machine_failed"]), 2)
        self.assertEqual(len(v["semantic"]), 1)

    def test_verify_checklist_bad_shapes_all_semantic(self):
        from harness.selfcheck import verify_checklist
        v = verify_checklist(["「导数」已删除"], None, None)
        self.assertEqual(v["items"][0]["kind"], "semantic")
        self.assertEqual(v["semantic"], ["「导数」已删除"])

    def test_normalize_checklist(self):
        from harness.selfcheck import normalize_checklist
        self.assertEqual(normalize_checklist("bad"), [])
        self.assertEqual(normalize_checklist(None), [])
        self.assertEqual(normalize_checklist(["  ", "ok"]), ["ok"])
        self.assertEqual(len(normalize_checklist(["x"] * 20)), 8)  # 条数封顶

    def _tool_call(self, name, args):
        return {"function": {"name": name, "arguments": __import__("json").dumps(args, ensure_ascii=False)}}

    def test_checklist_machine_retry_and_summary(self):
        """机检未达成→带反馈重试（T236 体例）；重试达成→warnings 汇总「本次目标」。"""
        import asyncio
        import json
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}
        checklist = ["「导数」的 formula 已更新为「F=ma」"]

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                # 两条合法操作但没一条改公式——checklist 自报目标未达成
                return {
                    "content": json.dumps({"summary": "已按要求整理导数", "checklist": checklist}, ensure_ascii=False),
                    "tool_calls": [
                        self._tool_call("update_node", {"node_id": "A", "patch": {"label": "导数（概念）"}, "reason": "整理标题"}),
                        self._tool_call("update_node", {"node_id": "H", "patch": {"content": "润色"}, "reason": "顺手润色"}),
                    ],
                }
            # 重试轮：反馈里必须带机检失败原因
            self.assertTrue(any("达成清单未达成" in str(m.get("content") or "") for m in messages))
            return {
                "content": json.dumps({"summary": "已把导数公式改成 F=ma", "checklist": checklist}, ensure_ascii=False),
                "tool_calls": [
                    self._tool_call("update_node", {"node_id": "A", "patch": {"formula": "F=ma"}, "reason": "按清单改公式"}),
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                self.SNAPSHOT, "把导数的公式改成 F=ma", model=self.MODEL,
                mode="tools", retries=1, self_check="auto",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(calls["n"], 2)
        # 结果级断言：公式确实改成了 F=ma
        ops = result["operations"]
        self.assertTrue(any(o.get("op") == "update_node" and o.get("id") == "A"
                            and o.get("patch", {}).get("formula") == "F=ma" for o in ops))
        # warnings 汇总行（「本次目标 N 条，达成 M 条」）
        self.assertTrue(any(w.get("index") == "checklist" and "本次目标 1 条" in w.get("reason", "")
                            for w in result["warnings"]))
        self.assertEqual(result["self_check"]["checklist"]["achieved"], 1)
        # ≤3 条操作不触发质检门：机检独立起效，无 critic 调用
        self.assertNotIn("critic", result["self_check"])
        # 工具通道的 JSON 外壳 summary 被顶替成外壳里的人话 summary
        self.assertEqual(result["summary"], "已把导数公式改成 F=ma")

    def test_checklist_last_attempt_downgrades_to_warnings(self):
        """无重试机会（retries=0）时机检失败不拦截，末次放行降 warnings。"""
        import asyncio
        import json
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {
                "content": json.dumps({"summary": "整理", "checklist": ["「导数」的 formula 已更新为「F=ma」"]}, ensure_ascii=False),
                "tool_calls": [
                    self._tool_call("update_node", {"node_id": "A", "patch": {"label": "导数（概念）"}, "reason": "整理"}),
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                self.SNAPSHOT, "把导数的公式改成 F=ma", model=self.MODEL,
                mode="tools", retries=0, self_check="auto",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertTrue(any(w.get("index") == "checklist" and "达成清单未达成" in w.get("reason", "")
                            for w in result["warnings"]))
        self.assertTrue(any(w.get("index") == "checklist" and "本次目标 1 条，达成 0 条" in w.get("reason", "")
                            for w in result["warnings"]))

    def test_checklist_json_payload_path(self):
        """JSON 降级通道（无工具）的 checklist 同样生效——顶层可选字段。"""
        import asyncio
        import json
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            calls["n"] += 1
            if calls["n"] == 1:
                payload = {
                    "summary": "整理一下",
                    "checklist": ["「旧笔记」已删除"],
                    "operations": [
                        {"op": "update_node", "id": "A", "patch": {"label": "导数（概念）"}, "reason": "整理"},
                    ],
                }
                return {"content": json.dumps(payload, ensure_ascii=False)}
            return {"content": json.dumps({
                "summary": "已删除旧笔记",
                "checklist": ["「旧笔记」已删除"],
                "operations": [
                    {"op": "delete_node", "id": "H", "reason": "按清单删除"},
                ],
            }, ensure_ascii=False)}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                self.SNAPSHOT, "把旧笔记删掉", model=self.MODEL,
                mode="json", retries=1, self_check="auto",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(calls["n"], 2)
        self.assertTrue(any(o.get("op") == "delete_node" and o.get("id") == "H" for o in result["operations"]))
        self.assertEqual(result["self_check"]["checklist"]["achieved"], 1)

    def test_checklist_missing_degrades_silently(self):
        """checklist 缺失＝静默降级：无 checklist 键、无 checklist warnings、消息无清单段。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod
        from harness.selfcheck import build_selfcheck_messages

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": "", "tool_calls": [
                self._tool_call("update_node", {"node_id": "A", "patch": {"label": "导数（概念）"}, "reason": "整理"}),
            ]}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                self.SNAPSHOT, "把导数改严谨", model=self.MODEL,
                mode="tools", retries=1, self_check="auto",
            ))
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("checklist", result["self_check"])
        self.assertFalse(any(w.get("index") == "checklist" for w in result["warnings"]))
        msgs = build_selfcheck_messages("指令", self.SNAPSHOT, [{"op": "update_node", "id": "A"}], None, None)
        self.assertNotIn("达成清单", msgs[1]["content"])

    def test_checklist_semantic_items_reach_critic(self):
        """语义条目交 critic（条件 kwargs），机检达成条目不重复喂。"""
        import asyncio
        import json
        import unittest.mock
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": json.dumps({"summary": "删掉", "checklist": [
                "「旧笔记」已删除",             # 机检达成
                "「导数」的正文足够严谨",        # 语义条目
            ]}, ensure_ascii=False), "tool_calls": [
                self._tool_call("delete_node", {"node_id": "H", "reason": "删除"}),
            ]}

        async def fake_selfcheck(snapshot, instruction, ops, model, counter=None,
                                 result_snapshot=None, checklist=None):
            captured["checklist"] = checklist
            return {"ok": True, "issues": [], "missing": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            with unittest.mock.patch.object(review_mod, "_selfcheck_ops", new=fake_selfcheck):
                result = asyncio.run(review_mod.review_graph(
                    self.SNAPSHOT, "把旧笔记删掉", model=self.MODEL,
                    mode="tools", retries=1, self_check="auto",
                ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(captured["checklist"], ["「导数」的正文足够严谨"])


class HarnessSemanticSearchTest(unittest.TestCase):
    """路径三（2026-10-09）：语义检索层——字面 miss 补召回、账号分桶缓存、逐字降级。"""

    def test_semantic_recall_degrades_without_embedding(self):
        """conftest 已设 PHYMATHIA_EMBEDDING=0：召回回 []（降级＝字面行为逐字一致）。"""
        import asyncio
        from harness.semantic import semantic_node_recall
        snap = {"nodes": [{"id": "F", "kind": "knowledge", "label": "法拉第定律",
                           "content": "磁通量变化产生感应电动势"}]}
        self.assertEqual(asyncio.run(semantic_node_recall(snap, "电磁感应")), [])

    def test_semantic_node_recall_with_fake_vectors(self):
        import asyncio
        import unittest.mock
        from harness import semantic as sem

        snap = {"nodes": [
            {"id": "F", "kind": "knowledge", "label": "法拉第定律", "content": "磁通量变化产生感应电动势"},
            {"id": "A", "kind": "knowledge", "label": "导数", "content": "瞬时变化率"},
        ]}
        vectors = {"F": [0.95, 0.1], "A": [0.0, 1.0]}
        gather_calls = {"n": 0}

        def fake_gather(texts):
            gather_calls["n"] += 1
            return ({k: vectors[k] for k in texts}, True)

        def fake_embed(texts):
            # 关键词 → 查询向量：「电磁感应」贴法拉第、「再搜一次」谁也不贴（反向）
            return [[1.0, 0.0] if "电磁" in str(t) else [-1.0, 0.0] for t in texts]

        async def run():
            with unittest.mock.patch.object(sem, "gather_vectors", new=fake_gather), \
                 unittest.mock.patch.object(sem, "embed_texts", new=fake_embed):
                first = await sem.semantic_node_recall(snap, "电磁感应")
                second = await sem.semantic_node_recall(snap, "再搜一次", account="default")
                other = await sem.semantic_node_recall(snap, "电磁感应", account="other-account")
            return first, second, other

        first, second, other = asyncio.run(run())
        self.assertEqual([h["id"] for h in first], ["F"])
        self.assertGreaterEqual(first[0]["score"], 0.40)
        # 同账号同图第二次复用索引（gather 只被叫一次）；换账号重建（T190 分桶）
        self.assertEqual(gather_calls["n"], 2)
        self.assertEqual(second, [])  # 反向查询向量：两个节点都过不了门槛
        self.assertEqual([h["id"] for h in other], ["F"])

    def test_semantic_node_recall_graph_change_invalidates(self):
        import asyncio
        import unittest.mock
        from harness import semantic as sem

        snap = {"nodes": [{"id": "F", "kind": "knowledge", "label": "法拉第定律", "content": "磁通量"}]}
        gather_calls = {"n": 0}

        def fake_gather(texts):
            gather_calls["n"] += 1
            return ({k: [0.9, 0.1] for k in texts}, True)

        async def run():
            with unittest.mock.patch.object(sem, "gather_vectors", new=fake_gather), \
                 unittest.mock.patch.object(sem, "embed_texts", new=lambda texts: [[1.0, 0.0]]):
                await sem.semantic_node_recall(snap, "电磁感应")
                snap["nodes"].append({"id": "A", "kind": "knowledge", "label": "导数", "content": "x"})
                await sem.semantic_node_recall(snap, "电磁感应")

        asyncio.run(run())
        self.assertEqual(gather_calls["n"], 2)  # 图变化（签名变）即重建

    def test_search_nodes_semantic_only_on_miss(self):
        from harness.tools import execute_readonly_tool
        snap = {"nodes": [
            {"id": "A", "kind": "knowledge", "label": "导数", "content": "瞬时变化率"},
            {"id": "F", "kind": "knowledge", "label": "法拉第定律", "content": "磁通量变化产生感应电动势"},
        ], "edges": []}
        # 字面命中：输出与既有形状完全一致（不带 semantic 键）
        hit = execute_readonly_tool("search_nodes", {"keyword": "导数"}, snap)
        self.assertEqual(hit["count"], 1)
        self.assertNotIn("semantic", hit["matches"][0])
        self.assertNotIn("note", hit)
        # 字面 miss＋语义命中：补位条目带 semantic/score 标记
        miss = execute_readonly_tool("search_nodes", {"keyword": "电磁感应"}, snap, semantic_hits=[
            {"id": "F", "label": "法拉第定律", "kind": "knowledge", "score": 0.55},
        ])
        self.assertEqual(miss["count"], 1)
        self.assertEqual(miss["matches"][0]["id"], "F")
        self.assertTrue(miss["matches"][0]["semantic"])
        self.assertEqual(miss["matches"][0]["score"], 0.55)
        self.assertIn("语义近似", miss["note"])
        # 字面 miss＋无召回：与从前逐字一致的空结果
        empty = execute_readonly_tool("search_nodes", {"keyword": "电磁感应"}, snap)
        self.assertEqual(empty, {"matches": [], "count": 0, "total": 0, "truncated": False})

    def test_search_knowledge_semantic_fill(self):
        from harness.tools import execute_readonly_tool
        kb = {"knowledge": [{"title": "法拉第定律", "summary": "磁通量变化产生感应电动势", "tags": []}]}
        out = execute_readonly_tool("search_knowledge", {"keyword": "电磁感应"}, None, kb=kb, semantic_hits=[
            {"item": {"title": "法拉第定律", "summary": "磁通量变化产生感应电动势", "tags": []}, "score": 0.55},
        ])
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["matches"][0]["title"], "法拉第定律")
        self.assertTrue(out["matches"][0]["semantic"])

    def test_rank_recipes_degrades_and_promotes(self):
        import asyncio
        import unittest.mock
        from harness import semantic as sem

        recipes = [{"id": "r%d" % i, "name": "配方%d" % i, "desc": ""} for i in range(34)]

        async def degraded():
            with unittest.mock.patch.object(sem, "embed_texts", new=lambda texts: None):
                return await sem.rank_recipes_for_instruction(recipes, "帮我出题")

        self.assertIsNone(asyncio.run(degraded()))

        async def promoted():
            with unittest.mock.patch.object(sem, "gather_vectors", new=lambda texts: ({
                    "r33": [1.0, 0.0], "r0": [0.0, 1.0]}, True)), \
                 unittest.mock.patch.object(sem, "embed_texts", new=lambda texts: [[1.0, 0.0]]):
                return await sem.rank_recipes_for_instruction(recipes, "帮我出题")

        ordered = asyncio.run(promoted())
        self.assertEqual(len(ordered), 34)  # 重排只挪位置不丢条目
        self.assertEqual(ordered[0]["id"], "r33")

    def test_review_tool_loop_injects_semantic_hits(self):
        """查询回灌循环接线穿透：字面 miss 的 search_nodes 回灌结果里带语义召回条目。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            if any(m.get("role") == "tool" for m in messages):
                captured["tool_results"] = [str(m.get("content") or "") for m in messages if m.get("role") == "tool"]
                return {"content": "", "tool_calls": [
                    {"function": {"name": "update_node",
                                  "arguments": '{"node_id": "F", "patch": {"content": "已复习"}, "reason": "补充标注"}'}},
                ]}
            return {"content": "", "tool_calls": [
                {"function": {"name": "search_nodes", "arguments": '{"keyword": "电磁感应"}'}},
            ]}

        async def fake_recall(snapshot, keyword, account="default", **kw):
            captured["keyword"] = keyword
            return [{"id": "F", "label": "法拉第定律", "kind": "knowledge", "score": 0.55}]

        snap = {"nodes": [
            {"id": "A", "kind": "knowledge", "label": "导数", "content": "变化率"},
            {"id": "F", "kind": "knowledge", "label": "法拉第定律", "content": "磁通量变化产生感应电动势"},
        ], "edges": []}
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            with unittest.mock.patch.object(review_mod, "semantic_node_recall", new=fake_recall):
                result = asyncio.run(review_mod.review_graph(
                    snap, "搜一下电磁感应并补充标注", model=self.MODEL,
                    mode="tools", retries=1, self_check="auto",
                ))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(captured["keyword"], "电磁感应")
        self.assertTrue(any("法拉第定律" in t for t in captured["tool_results"]))
        self.assertTrue(any(o.get("op") == "update_node" and o.get("id") == "F" for o in result["operations"]))

    def test_review_reorders_recipes_only_over_limit(self):
        """落点三接线：user_recipes 超后端截断上限（32）才触发重排，≤32 零打扰。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        calls = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return {"content": "", "tool_calls": [
                {"function": {"name": "update_node", "arguments": '{"node_id": "A", "patch": {"label": "导数（概念）"}, "reason": "整理"}'}},
            ]}

        async def fake_rank(recipes, instruction, account="default", **kw):
            calls["n"] += 1
            calls["count"] = len(recipes)
            return list(reversed(recipes))

        base_nodes = [{"id": "A", "kind": "knowledge", "label": "导数", "content": "变化率"}]
        small = {"nodes": base_nodes, "edges": [], "user_recipes": [{"id": "r1", "name": "a"}]}
        big = {"nodes": base_nodes, "edges": [],
               "user_recipes": [{"id": "r%d" % i, "name": "n%d" % i} for i in range(33)]}
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            with unittest.mock.patch.object(review_mod, "rank_recipes_for_instruction", new=fake_rank):
                asyncio.run(review_mod.review_graph(
                    dict(small), "整理", model=self.MODEL, mode="tools", retries=0, self_check="off"))
                self.assertEqual(calls["n"], 0)  # 不超上限不重排
                result = asyncio.run(review_mod.review_graph(
                    dict(big), "帮我出题", model=self.MODEL, mode="tools", retries=0, self_check="off"))
        self.assertEqual(result["status"], "ok")
        self.assertEqual(calls["n"], 1)
        self.assertEqual(calls["count"], 33)

    MODEL = {"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""}


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

    def test_long_undo_history_keeps_newest_not_oldest(self):
        """T235：撤销历史超 80 条时切「最新 80 条」回滚，而不是最旧。

        旧行为 normalize_operations 留头截断会把最新改动整段留下、只回滚最早的
        改动——「撤销全部」语义拧反，且无任何提示。构造 90 个节点各一条
        update_node（旧→新），逆操作 1:1 展开不触限：断言最旧 10 步对应的节点
        保持「新」，其余 80 个回到「原」，summary 明示只回滚了最近 80 条。
        """
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        total = 90
        initial = {"nodes": [{"id": f"A{i}", "kind": "knowledge", "label": f"节点{i}", "content": f"原{i}"} for i in range(total)], "edges": []}
        after_all = {"nodes": [{"id": f"A{i}", "kind": "knowledge", "label": f"节点{i}", "content": f"新{i}"} for i in range(total)], "edges": []}
        ops = [{"op": "update_node", "id": f"A{i}", "patch": {"content": f"新{i}"}, "reason": "修改"} for i in range(total)]
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                after_all,
                "把刚才所有修改全部撤销",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                mode="tools",
                self_check="off",
                retries=0,
                previous_snapshot=None,
                previous_ops=[],
                initial_snapshot=initial,
                all_previous_ops=ops,
            ))
        self.assertEqual(called["n"], 0, "确定性撤销不调模型")
        self.assertEqual(result["status"], "undo", result.get("summary"))
        self.assertIn("仅回滚最近", result["summary"], "超上限要如实说明只回滚了最近 N 条")
        self.assertNotIn("未收到完整操作历史", result["summary"])
        contents = {n["id"]: n["content"] for n in result["next_snapshot"]["nodes"]}
        for i in range(total):
            expected = f"新{i}" if i < 10 else f"原{i}"
            self.assertEqual(
                contents[f"A{i}"], expected,
                f"A{i}：{'最旧 10 步应保留生效' if i < 10 else '最近 80 步应被回滚'}",
            )

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


class HarnessUndoShortInstructionGateTest(unittest.TestCase):
    """T226：确定性撤销的短指令门槛 + 部分失败的 status 语义。

    背景：UNDO_HINTS 是宽泛子串匹配，「这个公式不要了，删掉它」这类**复合编辑
    指令**误命中撤销词 → 图被确定性回滚、summary 谎报「已撤销上一步修改」；
    且 build_next_snapshot 带回 errors 时 status 仍被无条件盖成 undo。修法：
    review.py:1018 处给撤销意图加「指令足够短/指回上一步」门槛、review.py:1060
    处 errors 非空时报 error。桩姿势与同文件其它撤销测试一致（patch
    review_mod._call_model 计数）。
    """

    MODEL = {"provider": "opencode", "model": "mimo-v2.5-free",
             "base_url": "https://opencode.ai/zen/v1", "api_key": ""}
    BEFORE = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}], "edges": []}
    AFTER = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "新"}], "edges": []}
    PREV_OPS = [{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "修改"}]

    def _run(self, instruction, previous_ops=None, previous_snapshot=None, snapshot=None, **kw):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                self.AFTER if snapshot is None else snapshot,
                instruction,
                model=self.MODEL,
                mode="tools",
                self_check="off",
                retries=0,
                previous_ops=self.PREV_OPS if previous_ops is None else previous_ops,
                previous_snapshot=self.BEFORE if previous_snapshot is None else previous_snapshot,
                **kw,
            ))
        return result, called

    def test_gate_counts_short_undo_phrases(self):
        from harness.review import _is_unambiguous_undo

        for phrase in ("撤销", "撤销上一步", "不要了", "恢复", "回退一下",
                       "撤销刚才的修改", "撤销刚才的修改，恢复原样",
                       "把刚才所有修改全部撤销", "把刚才加的固有频率撤掉"):
            self.assertTrue(_is_unambiguous_undo(phrase), phrase)
        for phrase in ("这个公式不要了，删掉它", "把公式恢复成正确写法", "", "   "):
            self.assertFalse(_is_unambiguous_undo(phrase), phrase)

    def test_compound_edit_instructions_no_longer_roll_back_deterministically(self):
        """复合编辑指令（撤销词只是从句里的附带说法）必须改走模型路径（T226）。"""
        for instruction in ("这个公式不要了，删掉它", "把公式恢复成正确写法"):
            with self.subTest(instruction=instruction):
                result, called = self._run(instruction)
                self.assertGreaterEqual(called["n"], 1, "应到达模型路径，而不是确定性回滚")
                self.assertNotEqual(result["status"], "undo")
                self.assertEqual(
                    result["next_snapshot"]["nodes"][0]["content"], "新",
                    "不得把图反向回滚成撤销前",
                )

    def test_short_undo_instructions_still_skip_model(self):
        """短小的明确撤销指令零模型调用、直接回滚（命中即不调模型的拍板原样保留）。"""
        for instruction in ("撤销", "撤销上一步", "不要了", "恢复", "回退一下"):
            with self.subTest(instruction=instruction):
                result, called = self._run(instruction)
                self.assertEqual(called["n"], 0, "短明确的撤销指令必须不调模型")
                self.assertEqual(result["status"], "undo")
                self.assertEqual(result["next_snapshot"]["nodes"][0]["content"], "原")

    def test_composer_button_instruction_stays_deterministic(self):
        """前端「↩ 撤销上一条」按钮实发文案（harness-run.js undoLastHarnessEdit）：

        「撤销刚才的修改，恢复原样」——12 字符，比误报示例「把公式恢复成正确写法」
        （10 字符）还长，任何纯长度阈值都无法放行它又分流误报；靠「明确指回上一步」
        豁免留在确定性路径（T226）。这条用例钉住主撤销入口不回归。
        """
        result, called = self._run("撤销刚才的修改，恢复原样")
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "undo")
        self.assertEqual(result["next_snapshot"]["nodes"][0]["content"], "原")

    def test_undo_partial_failure_reports_error_not_undo(self):
        """build_next_snapshot 部分失败（errors 非空）时 status 不得盖成 undo（T226）。

        构造：delete_node 的逆 = restore_node + 每条入射边一条 add_edge——删两个各带
        40 条边的节点 → 82 条逆操作，超过 MAX_OPERATIONS=80 → build_next_snapshot
        记 1 条 limit error、前 80 条生效（status 本是 partial）。后端必须如实报
        error 与失败项数。注意不能靠 previous_ops 条数超限：normalize_operations
        会先把入参截到 80，逆操作永远碰不到上限。
        """
        neighbors = 40
        before = {"nodes": [
            {"id": "A", "kind": "knowledge", "label": "甲", "content": "a"},
            {"id": "B", "kind": "knowledge", "label": "乙", "content": "b"},
        ] + [{"id": f"n{i}", "kind": "knowledge", "label": f"邻{i}", "content": "c"}
             for i in range(neighbors)],
            "edges": [{"key": f"A:out-0->n{i}:in-0", "from": "A", "to": f"n{i}"}
                      for i in range(neighbors)] +
                     [{"key": f"B:out-0->n{i}:in-0", "from": "B", "to": f"n{i}"}
                      for i in range(neighbors)]}
        ops = [{"op": "delete_node", "id": "A", "reason": "删除"},
               {"op": "delete_node", "id": "B", "reason": "删除"}]
        after = {"nodes": before["nodes"][2:], "edges": []}
        result, called = self._run(
            "撤销", previous_ops=ops, previous_snapshot=before, snapshot=after,
        )
        self.assertEqual(called["n"], 0, "撤销路径不调模型")
        self.assertEqual(result["status"], "error", result.get("summary"))
        self.assertIn("撤销未完全成功：1 项失败", result["summary"])
        self.assertEqual(len(result["errors"]), 1)
        self.assertIn("上限", result["errors"][0]["reason"])
        # T235：撤销语境的 limit error 必须重写——原文案「请把剩余修改拆成下一批指令」
        # 是编辑语境建议，撤销没有下一批；改为告知「画布未应用、可再次撤销逐步回滚」。
        self.assertNotIn("拆成下一批指令", result["errors"][0]["reason"])
        self.assertIn("未应用", result["errors"][0]["reason"])
        self.assertEqual(len(result["operations"]), 80)
        restored = {nd["id"] for nd in result["next_snapshot"]["nodes"]}
        self.assertIn("A", restored)
        self.assertIn("B", restored)


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


class HarnessToolBatchFallthroughTest(unittest.TestCase):
    """T236：工具批一错不全弃——末次尝试放行合法 ops，失败项降级 warnings。"""

    MODEL = {"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""}

    def test_last_attempt_applies_valid_ops_and_warns_failed_item(self):
        """一个坏 tool call 不再连坐整批：retries=0（末次即第一次）也要放行合法项。

        旧行为：任一项失败即 continue 整批重试，retries 耗尽后落 parse_error、
        operations: []——两个完全合法的 update_node 被[1,2,3]这个坏项带走。
        新行为：合法 ops 照常应用，坏项进 warnings（前端渲染 ⚠️、存历史）。
        """
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "update_node", "arguments": '{"node_id": "A", "patch": {"label": "瞬时变化率"}, "reason": "更准确"}'}},
                    # 合法 JSON 但不是对象：repair_json 也救不回来，该项注定失败
                    {"function": {"name": "create_node", "arguments": "[1, 2, 3]"}},
                    {"function": {"name": "update_node", "arguments": '{"node_id": "B", "patch": {"content": "深入理解"}, "reason": "展开"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"},
                           {"id": "B", "kind": "knowledge", "label": "极限"}], "edges": []},
                "把这两个知识点改准确些",
                model=self.MODEL,
                mode="tools",
                self_check="off",
                retries=0,
            ))
        self.assertEqual(called["n"], 1)
        self.assertEqual(result["status"], "ok", result.get("errors"))
        self.assertEqual(result["errors"], [])
        self.assertEqual(len(result["operations"]), 2)
        nodes = {n["id"]: n for n in result["next_snapshot"]["nodes"]}
        self.assertEqual(nodes["A"]["label"], "瞬时变化率")
        self.assertEqual(nodes["B"]["content"], "深入理解")
        failed = [w for w in result["warnings"] if "工具调用解析失败" in str(w.get("reason") or "")]
        self.assertEqual(len(failed), 1)
        self.assertIn("create_node", failed[0]["reason"])

    def test_retryable_attempt_still_retries_whole_batch(self):
        """还有重试机会时仍旧整批重试——保留「JSON 被截断就重新生成干净批次」的好处。"""
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
                        {"function": {"name": "update_node", "arguments": '{"node_id": "A", "patch": {"label": "对"}, "reason": "r"}'}},
                        {"function": {"name": "create_node", "arguments": "[1, 2, 3]"}},
                    ],
                }
            return {
                "content": "",
                "tool_calls": [
                    {"function": {"name": "update_node", "arguments": '{"node_id": "A", "patch": {"label": "对"}, "reason": "r"}'}},
                ],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "改准确些",
                model=self.MODEL,
                mode="tools",
                self_check="off",
                retries=2,
            ))
        self.assertEqual(calls["n"], 2, "首轮有坏项应整批重试，而不是就地放行")
        self.assertEqual(result["status"], "ok", result.get("errors"))
        self.assertEqual(
            [w for w in result["warnings"] if "工具调用解析失败" in str(w.get("reason") or "")],
            [], "重试成功了就不该留失败 warnings",
        )


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

class ReasoningStripTest(unittest.TestCase):
    """推理模型（deepseek-v4-flash 等）思考块剥离：解析与展示两条防线。"""

    def _review(self, fake_payload, instruction="评价一下", mode="json"):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            return dict(fake_payload)

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            return asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                instruction,
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode=mode, self_check="off",
            ))

    def test_strip_reasoning_removes_closed_block(self):
        from harness.json_utils import strip_reasoning
        text = '<think>先分析一下 {"ops": [残缺</think>\n{"summary": "s"}'
        self.assertEqual(strip_reasoning(text), '{"summary": "s"}')

    def test_strip_reasoning_cuts_unclosed_block(self):
        from harness.json_utils import strip_reasoning
        text = '{"summary": "ok"} <think>被截断的思考……'
        self.assertEqual(strip_reasoning(text), '{"summary": "ok"}')

    def test_strip_reasoning_keeps_plain_text(self):
        from harness.json_utils import strip_reasoning
        self.assertEqual(strip_reasoning('{"summary": "s"}'), '{"summary": "s"}')
        self.assertEqual(strip_reasoning(""), "")

    def test_review_parses_through_think_block(self):
        payload = {
            "content": '<think>用户想让我评价导数节点，先草拟 {"op": "bad"</think>\n'
                       '{"summary": "图结构清晰", "operations": []}',
            "tool_calls": [],
            "reasoning_stripped": True,
        }
        result = self._review(payload)
        self.assertEqual(result["status"], "no_ops")
        self.assertEqual(result["summary"], "图结构清晰")
        self.assertTrue(result.get("reasoning_stripped"))

    def test_review_falls_back_to_clean_reasoning_content(self):
        payload = {
            "content": "",
            "reasoning_content": '<think>思考</think>{"summary": "来自reasoning", "operations": []}',
        }
        result = self._review(payload)
        self.assertEqual(result["status"], "no_ops")
        self.assertEqual(result["summary"], "来自reasoning")

    def test_promote_reasoning_gates_on_json(self):
        # _promote_reasoning：思考字段只在剥掉标签后能解析出 JSON 时才提升
        from harness.review import _promote_reasoning
        cleaned, promoted, prose_only = _promote_reasoning("", '{"summary": "s", "operations": []}')
        self.assertTrue(promoted)
        self.assertFalse(prose_only)
        self.assertIn('"summary"', cleaned)
        prose = "Let me think. The user wants to optimize the recipe, so I should call update_recipe."
        cleaned, promoted, prose_only = _promote_reasoning("", prose)
        self.assertEqual(cleaned, "")
        self.assertFalse(promoted)
        self.assertTrue(prose_only)
        # 带思考标签的纯思考（剥完为空）→ 什么都不提升
        cleaned, promoted, prose_only = _promote_reasoning("", "<think>只想不想答</think>")
        self.assertEqual(cleaned, "")
        self.assertFalse(promoted)
        self.assertFalse(prose_only)

    def test_review_never_promotes_prose_reasoning(self):
        # 裸散文式思维链（网关不带 <think> 标签的 reasoning_content）绝不提升为
        # summary——曾整段英文推理被渲染进面板（2026-09-30）。工具模式下答疑类
        # 指令不触发空操作重试，直接拿到友好提示而非推理原文。
        prose = ("The user wants to optimize the recipe. Let me look at the existing "
                 "details first. I should call update_recipe with a full payload.")
        payload = {"content": "", "tool_calls": [], "reasoning_content": prose}
        result = self._review(payload, instruction="这是什么？", mode="tools")
        self.assertNotIn(prose, str(result.get("summary") or ""))
        self.assertEqual(result["status"], "no_ops")
        self.assertIn("思考过程", result["summary"])

    def test_text_summary_clamped_for_display(self):
        from harness.review import _clamp_display_summary
        clamped = _clamp_display_summary("字" * 2000)
        self.assertLess(len(clamped), 900)
        self.assertIn("已截断", clamped)
        self.assertEqual(_clamp_display_summary("短"), "短")
        self.assertEqual(_clamp_display_summary(None), "")

    def test_usage_entry_records_out_chars_and_think_flag(self):
        from harness.api import _usage_entry
        entry = _usage_entry(
            {"snapshot": {"nodes": [], "edges": []}, "instruction": "x",
             "model": {"model": "m"}, "focus_node_ids": []},
            {"status": "no_ops", "operations": [], "warnings": [], "errors": [],
             "model_calls": 1, "out_chars": 1234, "reasoning_stripped": True},
            0.0, "review",
        )
        self.assertEqual(entry["out_chars"], 1234)
        self.assertTrue(entry["think_stripped"])


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


class QuizWeakSnapshotPromptTest(unittest.TestCase):
    """M2（P0-A 检测闭环）：检测侧薄弱点随快照进提示词，并明文禁止状态类图元素。"""

    def _snapshot(self):
        return {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "简谐运动"}],
            "edges": [],
            "quiz_weak": [
                {"title": "等时性", "wrong": 2, "mastery": 40, "sessionId": "sess_x"},
            ],
        }

    def test_review_prompt_forbids_state_nodes(self):
        from harness.prompts import HARNESS_SYSTEM_PROMPT
        # 快照字段本身要被提示词解释（否则模型把 quiz_weak 当节点数据）
        self.assertIn("quiz_weak", HARNESS_SYSTEM_PROMPT)
        # 只许口头提示 + 内容性动作，禁状态类图元素（网无状态立场）
        for token in ("禁止", "染色", "徽标", "内容性"):
            self.assertIn(token, HARNESS_SYSTEM_PROMPT)
        self.assertIn("口头", HARNESS_SYSTEM_PROMPT)

    def test_quiz_weak_reaches_review_user_message(self):
        from harness.prompts import build_review_messages
        messages = build_review_messages(self._snapshot(), "梳理一下这张图")
        user_text = messages[1]["content"]
        self.assertIn("quiz_weak", user_text)
        self.assertIn("等时性", user_text)
        # 系统提示词同时在场（两者缺一都会让模型失去约束）
        self.assertIn("quiz_weak", messages[0]["content"])

    def test_snapshot_without_weak_stays_clean(self):
        from harness.prompts import build_review_messages
        messages = build_review_messages({"nodes": [], "edges": []}, "梳理一下这张图")
        self.assertNotIn("quiz_weak", messages[1]["content"])

    def test_normalize_snapshot_keeps_weak_field(self):
        # 快照进入 harness 前会过 normalize_snapshot：附加字段不能被丢掉
        snap = normalize_snapshot(self._snapshot())
        self.assertIn("quiz_weak", snap)
        self.assertEqual(snap["quiz_weak"][0]["title"], "等时性")

    def test_focus_subgraph_keeps_weak_field(self):
        # 大图降采样走 _focus_subgraph：薄弱点不是图元素，必须原样带过去
        from harness.review import _focus_subgraph
        sub = _focus_subgraph(self._snapshot(), ["A"], max_hops=1, max_nodes=40)
        self.assertIsNotNone(sub)
        self.assertEqual(sub.get("quiz_weak"), self._snapshot()["quiz_weak"])

    def test_normalize_quiz_weak_sanitizes(self):
        from harness.core import normalize_quiz_weak
        self.assertEqual(normalize_quiz_weak(None), [])
        self.assertEqual(normalize_quiz_weak("不是数组"), [])
        # 无标题/非字典条目丢弃；数字字段安全转换
        cleaned = normalize_quiz_weak([
            {"title": "", "wrong": 1},
            "junk",
            {"title": "等时性", "wrong": "2", "mastery": None},
        ])
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["wrong"], 2)
        self.assertEqual(cleaned[0]["mastery"], 0)
        # 条数上限（当前会话 Top3）
        self.assertEqual(len(normalize_quiz_weak([{"title": f"t{i}"} for i in range(10)])), 3)

    def test_review_graph_actually_sends_weak_points(self):
        """端到端（normalize → 子图/压缩 → 提示词 → 模型调用）：薄弱点必须真的发出去。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            captured["messages"] = messages
            return {
                "content": '{"summary": "等时性你错了 2 次，建议优先重学", "operations": []}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            asyncio.run(review_mod.review_graph(
                self._snapshot(),
                "梳理一下这张图",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode="json",
                self_check="off",
            ))
        joined = "\n".join(str(m.get("content") or "") for m in captured["messages"])
        self.assertIn("等时性", joined)
        # 模型侧的唯一防线（禁止状态类图元素）必须与快照同时到场
        self.assertIn("禁止", joined)


class ContinentSharedSnapshotPromptTest(unittest.TestCase):
    """大陆计划 v3（Φ 摆渡）：跨画布共享点随快照进提示词，Φ 只口头建议、不落图操作。"""

    def _snapshot(self):
        return {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "阻尼振动"}],
            "edges": [],
            "continent_shared": [
                {"label": "振动", "kind": "title", "my_title": "阻尼振动",
                 "peer_title": "非线性振动", "peer_session": "傅里叶分析"},
            ],
        }

    def test_review_prompt_explains_field_and_forbids_ops(self):
        from harness.prompts import HARNESS_SYSTEM_PROMPT
        self.assertIn("continent_shared", HARNESS_SYSTEM_PROMPT)
        # Φ 摆渡口径：只许口头建议去大陆连接，严禁输出图操作（跨画布边不归本画布管）
        prompt_fragment_ok = "严禁为此输出任何 operations" in HARNESS_SYSTEM_PROMPT
        self.assertTrue(prompt_fragment_ok)
        self.assertIn("大陆", HARNESS_SYSTEM_PROMPT)

    def test_continent_shared_reaches_review_user_message(self):
        from harness.prompts import build_review_messages
        messages = build_review_messages(self._snapshot(), "梳理一下这张图")
        user_text = messages[1]["content"]
        self.assertIn("continent_shared", user_text)
        self.assertIn("非线性振动", user_text)
        self.assertIn("continent_shared", messages[0]["content"])

    def test_snapshot_without_shared_stays_clean(self):
        from harness.prompts import build_review_messages
        messages = build_review_messages({"nodes": [], "edges": []}, "梳理一下这张图")
        self.assertNotIn("continent_shared", messages[1]["content"])

    def test_normalize_snapshot_keeps_shared_field(self):
        snap = normalize_snapshot(self._snapshot())
        self.assertIn("continent_shared", snap)
        self.assertEqual(snap["continent_shared"][0]["peer_session"], "傅里叶分析")

    def test_focus_subgraph_keeps_shared_field(self):
        from harness.review import _focus_subgraph
        sub = _focus_subgraph(self._snapshot(), ["A"], max_hops=1, max_nodes=40)
        self.assertIsNotNone(sub)
        self.assertEqual(sub.get("continent_shared"), self._snapshot()["continent_shared"])

    def test_normalize_continent_shared_sanitizes(self):
        from harness.core import normalize_continent_shared
        self.assertEqual(normalize_continent_shared(None), [])
        self.assertEqual(normalize_continent_shared({"label": "x"}), [])
        cleaned = normalize_continent_shared([
            {"label": "", "kind": "title"},
            "junk",
            {"label": "振动", "kind": "weird", "my_title": "阻尼振动"},
        ])
        self.assertEqual(len(cleaned), 1)
        self.assertEqual(cleaned[0]["kind"], "title")  # 非法 kind 收敛回 title
        self.assertEqual(cleaned[0]["my_title"], "阻尼振动")
        self.assertEqual(cleaned[0]["peer_title"], "")
        # 条数上限（大陆共享点最多 4 条）
        self.assertEqual(len(normalize_continent_shared(
            [{"label": f"t{i}"} for i in range(10)])), 4)

    def test_review_graph_actually_sends_shared_points(self):
        """端到端：共享点必须真的穿过 normalize/子图到达模型消息。"""
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            captured["messages"] = messages
            return {
                "content": '{"summary": "「阻尼振动」和你在「傅里叶分析」学的「非线性振动」共享「振动」，可以打开知识大陆连起来", "operations": []}',
                "tool_calls": [],
            }

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            asyncio.run(review_mod.review_graph(
                self._snapshot(),
                "梳理一下这张图",
                model={"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""},
                mode="json",
                self_check="off",
            ))
        joined = "\n".join(str(m.get("content") or "") for m in captured["messages"])
        self.assertIn("非线性振动", joined)
        self.assertIn("大陆", joined)


class HarnessStreamMeteringTest(unittest.TestCase):
    """2026-09-25 流式计量拍板：Φ 流式请求发 stream_options include_usage 拿
    计量帧；不认识的端点整请求 400 时剥掉重发一次（只牺牲计量帧，不牺牲对话）。
    此前流式 Φ 调用拿不到 usage，命中率统计缺 Φ 一角。"""

    def test_stream_options_downgrade_on_400(self):
        import asyncio
        import json as _json
        import httpx
        from harness import review as review_mod

        bodies = []

        def handler(request):
            body = _json.loads(request.content.decode())
            bodies.append(body)
            if "stream_options" in body:
                return httpx.Response(400, json={"error": "unknown field: stream_options"})
            sse = (
                'data: {"choices": [{"delta": {"content": "好"}}]}\n\n'
                'data: {"choices": [], "usage": {"prompt_tokens": 100, '
                '"prompt_cache_hit_tokens": 80, "completion_tokens": 5}}\n\n'
                "data: [DONE]\n\n"
            )
            return httpx.Response(200, content=sse,
                                  headers={"content-type": "text/event-stream"})

        async def run():
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                return await review_mod._stream_chat_completions(
                    client, "https://x/v1/chat/completions", {},
                    {"stream_options": {"include_usage": True}}, None)
            finally:
                await client.aclose()

        message, usage = asyncio.run(run())
        self.assertEqual(len(bodies), 2, "400 后应剥掉 stream_options 重发一次")
        self.assertNotIn("stream_options", bodies[1])
        self.assertEqual(message.get("content"), "好")
        self.assertEqual((usage or {}).get("prompt_cache_hit_tokens"), 80,
                         "计量帧应被接住并随返回值带出")


class HarnessSessionBucketTest(unittest.TestCase):
    """Φ 分桶按会话（2026-10-01）：网关分桶（x-opencode-session 头）与计量
    sessionId 从进程级改为按 Φ 会话——api 层把 payload 里的 session_id 经
    harness_session_bucket 置入，_call_model 读取后消毒；非法/缺失回退进程级
    _HARNESS_SESSION_ID。同 Φ 会话落同桶保网关侧缓存亲和，跨会话不再互相挤占。"""

    MODEL = {"provider": "opencode", "model": "m",
             "base_url": "https://opencode.ai/zen/v1", "api_key": ""}

    def _call_model_with_bucket(self, raw_session=None):
        """raw_session 非 None 时经 harness_session_bucket 置桶（api 层同款），
        真调 _call_model（MockTransport 接上游），抓网关请求头与计量 sessionId。"""
        import asyncio
        import httpx
        import unittest.mock
        from harness import review as review_mod

        captured = {"headers": None, "usage_session": None}

        def handler(request):
            captured["headers"] = request.headers
            return httpx.Response(200, json={
                "choices": [{"message": {"content": "{\"summary\": \"好\", \"operations\": []}"}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 2},
            })

        def fake_record_usage(provider, model, kind, session_id, usage, duration_ms=None):
            captured["usage_session"] = session_id
            return None

        async def run():
            client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
            try:
                with unittest.mock.patch.object(
                    review_mod.usage_stats, "record_usage", fake_record_usage
                ), unittest.mock.patch.object(
                    review_mod, "get_http_client", lambda: client
                ):
                    if raw_session is None:
                        return await review_mod._call_model(
                            [{"role": "user", "content": "hi"}], self.MODEL, 100)
                    with review_mod.harness_session_bucket(raw_session):
                        return await review_mod._call_model(
                            [{"role": "user", "content": "hi"}], self.MODEL, 100)
            finally:
                await client.aclose()

        asyncio.run(run())
        return captured

    def test_valid_session_lands_in_gateway_header_and_metering(self):
        captured = self._call_model_with_bucket("phi_123")
        self.assertEqual(captured["headers"].get("x-opencode-session"), "phi_123")
        self.assertEqual(captured["usage_session"], "phi_123")

    def test_missing_session_falls_back_to_process_id(self):
        from harness import review as review_mod

        captured = self._call_model_with_bucket(None)
        self.assertEqual(captured["headers"].get("x-opencode-session"),
                         review_mod._HARNESS_SESSION_ID)
        self.assertEqual(captured["usage_session"], review_mod._HARNESS_SESSION_ID)

    def test_invalid_session_falls_back_to_process_id(self):
        from harness import review as review_mod

        captured = self._call_model_with_bucket("bad session!")
        self.assertEqual(captured["headers"].get("x-opencode-session"),
                         review_mod._HARNESS_SESSION_ID)
        self.assertEqual(captured["usage_session"], review_mod._HARNESS_SESSION_ID)

    def test_session_key_sanitizer(self):
        from harness import review as review_mod

        self.assertEqual(review_mod._harness_session_key("phi_123"), "phi_123")
        self.assertEqual(review_mod._harness_session_key("A-b_9"), "A-b_9")
        self.assertEqual(review_mod._harness_session_key("x" * 64), "x" * 64)
        self.assertEqual(review_mod._harness_session_key(""), review_mod._HARNESS_SESSION_ID)
        self.assertEqual(review_mod._harness_session_key(None), review_mod._HARNESS_SESSION_ID)
        self.assertEqual(review_mod._harness_session_key("bad session!"),
                         review_mod._HARNESS_SESSION_ID)
        self.assertEqual(review_mod._harness_session_key("x" * 65),
                         review_mod._HARNESS_SESSION_ID)

    def test_api_routes_thread_session_id_into_bucket(self):
        """graph_review / graph_resolve 都把 payload 的 session_id 置入分桶键；
        缺失时回退进程级 id。在 _call_model 桩内读键（api 置桶 → review 层可读）。"""
        import unittest.mock
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        from harness import review as review_mod
        from harness.api import router

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            captured["bucket"] = review_mod._harness_session_key(
                review_mod._HARNESS_SESSION_KEY.get())
            return {"content": "{\"summary\": \"好\", \"operations\": []}", "tool_calls": []}

        app = FastAPI()
        app.include_router(router, prefix="/api/harness")
        client = TestClient(app)
        snapshot = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []}
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            resp = client.post("/api/harness/graph/review", json={
                "snapshot": snapshot, "instruction": "评价一下", "session_id": "phi_api",
                "model": self.MODEL, "mode": "json", "self_check": "off",
            })
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(captured.get("bucket"), "phi_api")
            captured.clear()
            resp = client.post("/api/harness/graph/review", json={
                "snapshot": snapshot, "instruction": "评价一下",
                "model": self.MODEL, "mode": "json", "self_check": "off",
            })
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(captured.get("bucket"), review_mod._HARNESS_SESSION_ID)
            captured.clear()
            resp = client.post("/api/harness/graph/resolve", json={
                "snapshot": snapshot, "instruction": "改一下A", "session_id": "phi_api2",
                "model": self.MODEL,
            })
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(captured.get("bucket"), "phi_api2")


class HarnessPresetPhaseTest(unittest.TestCase):
    """节点配方 P3：创造模式相位与配方库 op。"""

    def setUp(self):
        self.snapshot = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}],
            "edges": [],
            "user_recipes": [
                {"id": "recipe-1", "name": "错题复盘", "base_kind": "module",
                 "content_kind": "markdown", "ports": "静态 2"},
            ],
        }

    def _recipe(self, **over):
        payload = {
            "name": "考前速记",
            "desc": "分考点与口诀两段",
            "base": {"kind": "module"},
            "appearance": {"palette": "teal", "shape": "is-round"},
            "generate": {"prompt": "输出考点与口诀两段。", "context_channel": "workflow_context"},
            "ports": {"static": [{"label": "再测一道", "drag_form": "user"}]},
            "content_kind": "markdown",
        }
        payload.update(over)
        return payload

    def test_detect_phase_explicit_preset_passthrough(self):
        self.assertEqual(_detect_phase("preset", "随便说点什么", {}), "preset")
        # 意图词永不猜 preset（D-R6：显式按钮入口，不做自动识别）
        self.assertNotEqual(_detect_phase("auto", "帮我做一个考前速记配方", {}), "preset")

    def test_phase_tools_preset_set(self):
        from harness.tools import PHASE_TOOLS, READONLY_TOOL_NAMES, TOOL_TO_OP, build_tools, _args_to_op
        self.assertEqual(
            set(PHASE_TOOLS["preset"]),
            {"create_recipe", "update_recipe", "delete_recipe", "create_node"} | set(READONLY_TOOL_NAMES),
        )
        tools = build_tools("preset")
        names = {t["function"]["name"] for t in tools}
        self.assertEqual(names, set(PHASE_TOOLS["preset"]))
        # _args_to_op 三件套转换
        op = _args_to_op("create_recipe", {"recipe": self._recipe(), "reason": "用户要求"})
        self.assertEqual(op["op"], "create_recipe")
        self.assertEqual(op["recipe"]["name"], "考前速记")
        op = _args_to_op("update_recipe", {"recipe_id": "recipe-1", "recipe": self._recipe(), "reason": "改口诀"})
        self.assertEqual(op["op"], "update_recipe")
        self.assertEqual(op["recipe_id"], "recipe-1")
        op = _args_to_op("delete_recipe", {"recipe_id": "recipe-1", "reason": "用户要求删除"})
        self.assertEqual(op, {"op": "delete_recipe", "recipe_id": "recipe-1", "reason": "用户要求删除"})
        self.assertIsNone(_args_to_op("delete_recipe", {"reason": "缺 id"}))

    def test_create_recipe_valid_and_dup(self):
        result = build_next_snapshot(self.snapshot, [
            {"op": "create_recipe", "recipe": self._recipe(), "reason": "用户要求"},
        ])
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["operations"][0]["recipe_id"].startswith("recipe-hn-"))
        self.assertEqual(result["operations"][0]["recipe"]["name"], "考前速记")
        self.assertEqual(result["diff"], [], "配方库操作不改图元素")
        # 重名被校验器拦
        dup = build_next_snapshot(self.snapshot, [
            {"op": "create_recipe", "recipe": self._recipe(name="错题复盘"), "reason": "重名"},
        ])
        self.assertEqual(dup["status"], "invalid")
        self.assertIn("同名配方", dup["errors"][0]["reason"])

    def test_update_and_delete_recipe_target_must_exist(self):
        upd = build_next_snapshot(self.snapshot, [
            {"op": "update_recipe", "recipe_id": "recipe-1", "recipe": self._recipe(name="错题复盘·改"), "reason": "改"},
        ])
        self.assertEqual(upd["status"], "ok")
        self.assertEqual(upd["operations"][0]["recipe"]["name"], "错题复盘·改")
        missing = build_next_snapshot(self.snapshot, [
            {"op": "delete_recipe", "recipe_id": "recipe-x", "reason": "删"},
        ])
        self.assertEqual(missing["status"], "invalid")
        self.assertIn("配方不存在", missing["errors"][0]["reason"])

    def test_recipe_ops_carry_name_for_preview(self):
        """T243：三类配方操作都带 recipe_name——预览/历史行不再回落显示内部 id。"""
        dele = build_next_snapshot(self.snapshot, [
            {"op": "delete_recipe", "recipe_id": "recipe-1", "reason": "用户要求删除"},
        ])
        self.assertEqual(dele["status"], "ok")
        self.assertEqual(dele["operations"][0]["recipe_name"], "错题复盘")
        upd = build_next_snapshot(self.snapshot, [
            {"op": "update_recipe", "recipe_id": "recipe-1",
             "recipe": self._recipe(name="错题复盘·改"), "reason": "改个名"},
        ])
        # update 带的是旧名（新名在 payload 里）——前端差异行要 before→after
        self.assertEqual(upd["operations"][0]["recipe_name"], "错题复盘")
        self.assertEqual(upd["operations"][0]["recipe"]["name"], "错题复盘·改")
        cre = build_next_snapshot(self.snapshot, [
            {"op": "create_recipe", "recipe": self._recipe(), "reason": "用户要求"},
        ])
        self.assertEqual(cre["operations"][0]["recipe_name"], "考前速记")

    def test_recipe_desc_gap_warning_is_user_visible(self):
        """T242：「描述说改了、payload 没带」从纯服务端日志升级为用户可见 warnings。

        T79「只 warning 不拦截」拍板不变——链路照旧落库，只是用户在应用前
        终于看得见哪一栏会被静默重置。"""
        snapshot = dict(self.snapshot, user_recipes=[{
            "id": "recipe-1", "name": "三级追问", "base_kind": "module",
            "content_kind": "markdown", "ports": "动态解析出口",
        }])
        base_op = {"op": "update_recipe", "recipe_id": "recipe-1", "recipe": self._recipe(name="三级追问")}
        # 英文键说辞：reason 提 level_tags、payload 没带 → 档位标签将被重置
        result = build_next_snapshot(snapshot, [dict(base_op, reason="把 level_tags 改成基础/进阶/拓展")])
        self.assertEqual(result["status"], "ok")
        hits = [w for w in result["warnings"] if "档位标签" in w.get("reason", "")]
        self.assertEqual(len(hits), 1)
        self.assertIn("重置为默认值", hits[0]["reason"])
        # 中文说辞别名同样检出（模型 reason 常写中文）
        zh = build_next_snapshot(snapshot, [dict(base_op, reason="把兜底出口改一下")])
        self.assertTrue(any("兜底出口" in w.get("reason", "") for w in zh["warnings"]))
        # payload 真带了就不警告——不误报
        carried = dict(base_op, reason="把 level_tags 改成基础/进阶/拓展",
                       recipe=self._recipe(name="三级追问", ports={
                           "static": [{"label": "再测一道"}],
                           "dynamic": {"parser": {"level_tags": ["基础", "进阶", "拓展"]}},
                       }))
        ok = build_next_snapshot(snapshot, [carried])
        self.assertFalse(any("档位标签" in w.get("reason", "") for w in ok["warnings"]))

    def test_create_node_with_recipe_id(self):
        result = build_next_snapshot(self.snapshot, [
            {"op": "create_node", "temp_id": "t1", "kind": "module", "label": "考前速记",
             "recipe_id": "recipe-1", "reason": "在画布上放一个试试"},
        ])
        self.assertEqual(result["status"], "ok")
        node = result["next_snapshot"]["nodes"][1]
        self.assertEqual(node["recipe_id"], "recipe-1")
        self.assertEqual(node["module_key"], "", "配方实例节点 module_key 允许为空")
        # 引用不存在的配方被拦
        bad = build_next_snapshot(self.snapshot, [
            {"op": "create_node", "temp_id": "t1", "kind": "module", "label": "X",
             "recipe_id": "recipe-none", "reason": "不存在"},
        ])
        self.assertEqual(bad["status"], "invalid")
        self.assertIn("配方不存在", bad["errors"][0]["reason"])

    def test_inverse_of_create_recipe_is_delete(self):
        from harness.core import build_inverse_ops
        result = build_next_snapshot(self.snapshot, [
            {"op": "create_recipe", "recipe": self._recipe(), "reason": "用户要求"},
        ])
        inverse = build_inverse_ops(self.snapshot, result["operations"])
        self.assertEqual(len(inverse), 1)
        self.assertEqual(inverse[0]["op"], "delete_recipe")
        self.assertEqual(inverse[0]["recipe_id"], result["operations"][0]["recipe_id"])

    def test_normalize_snapshot_passes_user_recipes(self):
        normalized = normalize_snapshot(self.snapshot)
        self.assertEqual(normalized["user_recipes"][0]["name"], "错题复盘")
        stripped = normalize_snapshot({"nodes": [], "edges": [], "user_recipes": [{"id": "", "name": ""}]})
        self.assertNotIn("user_recipes", stripped)

    def test_preset_messages_reference_recipe_list(self):
        from harness.prompts import build_preset_messages
        msgs = build_preset_messages(normalize_snapshot(self.snapshot), "帮我做一个考前速记节点")
        self.assertIn("节点配方创造助手", msgs[0]["content"])
        self.assertIn("外观只能通过配方的结构化字段表达", msgs[0]["content"])
        self.assertIn("错题复盘", msgs[1]["content"], "配方清单应随快照进提示词")


class HarnessChatPhaseTest(unittest.TestCase):
    """三模式切换器（2026-09-30）：答疑相位显式直通、只读红线与 ops 保险丝。"""

    def test_detect_phase_explicit_chat_passthrough(self):
        self.assertEqual(_detect_phase("chat", "帮我修改这个图", {}), "chat")
        # 意图词永不猜 chat（显式模式入口，不做自动识别，D-R6 哲学推广）
        self.assertNotEqual(_detect_phase("auto", "帮我修改这个图", {}), "chat")

    def test_detect_phase_explicit_expand_passthrough(self):
        # 09-30 补严：此前 explicit expand 混在 auto_phases 里，会被评价词覆盖成 evaluate
        self.assertEqual(_detect_phase("expand", "顺便评价一下这个图", {"nodes": []}), "expand")

    def test_phase_tools_chat_readonly_only(self):
        from harness.tools import PHASE_TOOLS, READONLY_TOOL_NAMES, build_tools
        # 2026-10-03 智能化第二期：chat 工具表收敛为纯只读（图查询＋知识检索），
        # 编辑工具根本不在表里——「只说不改」由工具表结构保证（旧口径「编辑表＋
        # 红线禁用」已随用户点名的智能化升级修订；红线 prompt 与服务端保险丝保留）
        self.assertEqual(PHASE_TOOLS["chat"], list(READONLY_TOOL_NAMES))
        for edit_name in ("create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"):
            self.assertNotIn(edit_name, PHASE_TOOLS["chat"])
        self.assertEqual({t["function"]["name"] for t in build_tools("chat")}, set(READONLY_TOOL_NAMES))

    def test_review_graph_chat_readonly_redline_and_fuse(self):
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        seen = {"system": "", "tool_choice": None}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            seen["system"] = messages[0]["content"]
            seen["tool_choice"] = tool_choice
            # 红线失效假设：模型仍输出图操作 JSON——服务端保险丝必须清空
            return {"content": '{"summary":"已添加节点","operations":[{"op":"create_node","temp_id":"t1","kind":"knowledge","label":"X"}]}', "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}], "edges": []},
                "帮我在图上加一个节点",
                model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                phase="chat",
                mode="tools",
                self_check="off",
            ))
        self.assertIn("答疑模式红线", seen["system"])
        self.assertEqual(seen["tool_choice"], "auto", "答疑相位即使有改图意图词也不得强制工具调用")
        self.assertEqual(result["operations"], [], "答疑保险丝必须清空图操作")
        self.assertIn("答疑模式不改图", result["summary"])

    def test_undo_still_deterministic_under_locked_phases(self):
        # 确定性撤销在相位分派之前、不看相位——锁定 preset/chat 下「↩撤销上一条」照常工作
        import asyncio
        import unittest.mock
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        snapshot = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "新"}],
            "edges": [],
        }
        previous = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}], "edges": []}
        for locked in ("preset", "chat"):
            with self.subTest(phase=locked):
                with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
                    result = asyncio.run(review_mod.review_graph(
                        snapshot,
                        "撤销刚才的修改，恢复原样",
                        model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
                        phase=locked,
                        mode="tools",
                        self_check="off",
                        previous_snapshot=previous,
                        previous_ops=[{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "修改"}],
                    ))
                self.assertEqual(called["n"], 0, "锁定相位下撤销也必须走确定性路径、不调模型")
                self.assertEqual(result["status"], "undo")
                self.assertEqual(result["next_snapshot"]["nodes"][0]["content"], "原")


class OperationsLimitTest(unittest.TestCase):
    """T107（2026-10-03 销账）：单批操作数超上限不再静默截断。"""

    def _ops(self, count):
        return [
            {"op": "create_node", "temp_id": f"t{i}", "kind": "knowledge",
             "label": f"节点{i}", "reason": "批量"}
            for i in range(count)
        ]

    def test_over_limit_records_error_and_truncates(self):
        from harness.core import MAX_OPERATIONS, build_next_snapshot, normalize_operations
        self.assertEqual(len(normalize_operations(self._ops(MAX_OPERATIONS + 5))), MAX_OPERATIONS)
        snapshot = {"nodes": [], "edges": []}
        result = build_next_snapshot(snapshot, self._ops(MAX_OPERATIONS + 5))
        self.assertEqual(len(result["operations"]), MAX_OPERATIONS)
        limit_errors = [e for e in result["errors"] if e.get("index") == "limit"]
        self.assertEqual(len(limit_errors), 1)
        self.assertIn("拆成下一批", limit_errors[0]["reason"])

    def test_at_limit_no_error(self):
        from harness.core import MAX_OPERATIONS, build_next_snapshot
        result = build_next_snapshot({"nodes": [], "edges": []}, self._ops(MAX_OPERATIONS))
        self.assertFalse([e for e in result["errors"] if e.get("index") == "limit"])


class MachineTextSummaryTest(unittest.TestCase):
    """T118：工具分支 content 机器文本判定——无中文/配方键名 → 回落计数摘要。"""

    def test_english_monologue_is_machine_text(self):
        from harness.review import _looks_like_machine_text
        self.assertTrue(_looks_like_machine_text("Let me think about the recipe structure..."))
        self.assertTrue(_looks_like_machine_text(""))
        self.assertTrue(_looks_like_machine_text('{"level_tags": ["基础"]}'))

    def test_chinese_prose_is_not_machine_text(self):
        from harness.review import _looks_like_machine_text
        self.assertFalse(_looks_like_machine_text("已创建「三问追踪」配方，出口为基础/进阶/拓展三档。"))
        # 中文正文里夹少量英文术语不算机器文本
        self.assertFalse(_looks_like_machine_text("这个配方用 KaTeX 渲染公式，max 最多 12 个出口。"))

    def test_recipe_key_names_in_content_is_machine_text(self):
        from harness.review import _looks_like_machine_text
        self.assertTrue(_looks_like_machine_text("设置 confused_prompt 与 retry_prompt 两个槽"))
        self.assertTrue(_looks_like_machine_text("level_tags=['基础','进阶','拓展'] 已写入"))


class RecipeDescPayloadMismatchTest(unittest.TestCase):
    """T79：op 描述声称改了配方字段而 payload 未携带 → 后端 warning（不拦截）。"""

    def _create_op(self, reason, recipe_extra=None):
        recipe = {"name": "三问追踪", "base": {"kind": "module"}, "generate": {"prompt": "生成"}}
        if recipe_extra:
            recipe.update(recipe_extra)
        return {"op": "create_recipe", "recipe": recipe, "reason": reason}

    def test_desc_mentions_missing_key_warns(self):
        from harness.core import build_next_snapshot
        with self.assertLogs("harness.core", level="WARNING") as cm:
            result = build_next_snapshot(
                {"nodes": [], "edges": [], "user_recipes": []},
                [self._create_op("把 level_tags 改为基础/进阶/拓展三档")],
            )
        self.assertTrue(any("level_tags" in line for line in cm.output))
        # 只告警不拦截：配方照常入列
        self.assertFalse(result["errors"])

    def test_desc_without_keys_no_warn(self):
        from harness.core import build_next_snapshot
        recipe = {"name": "三问追踪", "base": {"kind": "module"}, "generate": {"prompt": "生成"},
                  "ports": {"dynamic": {"parser": {"pattern": "numbered_list", "level_tags": ["基础", "进阶", "拓展"]}}}}
        with self.assertNoLogs("harness.core", level="WARNING"):
            build_next_snapshot(
                {"nodes": [], "edges": [], "user_recipes": []},
                [{"op": "create_recipe", "recipe": recipe, "reason": "建好苏格拉底式配方，带三档等级标签"}],
            )
