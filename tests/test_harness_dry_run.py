"""dry_run 试改自检（2026-10-25 DSH 对照·方向 1）＋ critic 空 issues 500 回归。

覆盖：
- 工具表：normal/apply/coach/expand 含 dry_run；chat/preset/evaluate 不含；
- _execute_dry_run 直测：幻觉 id 逐条错误、scope_node_ids 范围剔除预演、
  新节点孤岛提示、合法批 ok=True、坏参数（非数组/空数组）返回 error 不抛；
- _readonly_batch：dry_run 调用进查询环、编辑类调用照旧不进；
- review_graph 集成：试改一轮→修正→定稿（tool 结果回灌、journal 记账、
  结果协议零变化）；试改超 2 轮第三次收到上限提示；
- critic 空 issues 回归（基线 case 3/4/9/15/16 全 500 的根因）：
  _selfcheck_ops 判 fail 但 issues/missing 全空时不再把 None 送进 finalize，
  降 warning 放行。

桩形态照 test_harness_loop：patch.object(review_mod, "_call_model")，固定签名
带 on_delta=None，按调用序返回预排结果并记录 messages/tools。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness import review as review_mod
from harness.review import DRY_RUN_MAX_ROUNDS, _execute_dry_run
from harness.review_ops import _readonly_batch
from harness.tools import DRY_RUN_TOOL_NAME, build_tools

MODEL = {"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""}

SNAPSHOT = {
    "version": 1,
    "nodes": [
        {"id": "A", "kind": "user", "label": "问题", "content": "导体棒切割磁感线求电动势"},
        {"id": "B", "kind": "note", "label": "动生电动势", "content": "E=BLv", "formula": "E=BLv"},
        {"id": "C", "kind": "summary", "label": "AI 总结", "content": "两条线索汇合"},
    ],
    "edges": [{
        "key": "A:out-0->B:in-0", "from": "A", "to": "B",
        "fromPort": "out-0", "toPort": "in-0", "relation": "依赖", "label": "先答后记",
    }],
}

GOOD_UPDATE = {"op": "update_node", "id": "B", "patch": {"label": "动生电动势公式"}, "reason": "用户要求改名"}


def _tool_call(name, args, call_id="call_1"):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


def _llm(tool_calls=None, content=""):
    return {"content": content, "tool_calls": tool_calls}


def _recording_fake(results, seen):
    """按调用序返回预排结果，并把每次收到的 messages/tools 深拷进 seen。"""

    async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                   json_mode=False, on_delta=None):
        seen.append({
            "messages": json.loads(json.dumps(messages, ensure_ascii=False)),
            "tools": tools,
        })
        index = min(len(seen) - 1, len(results) - 1)
        return results[index]

    return fake


def _run_review(fake, *, snapshot=None, instruction="把「动生电动势」改名为「动生电动势公式」",
                phase="normal", journal=None, retries=0, self_check="off", focus=None):
    with mock.patch.object(review_mod, "_call_model", new=fake):
        return asyncio.run(review_mod.review_graph(
            snapshot or json.loads(json.dumps(SNAPSHOT, ensure_ascii=False)),
            instruction,
            model=dict(MODEL),
            phase=phase,
            retries=retries,
            self_check=self_check,
            progress=None,
            journal=journal,
            fallback_models=None,
            focus_node_ids=focus,
        ))


class DryRunToolsTableTest(unittest.TestCase):
    def test_edit_phases_get_dry_run(self):
        for phase in ("normal", "apply", "coach", "expand"):
            names = [schema["function"]["name"] for schema in build_tools(phase)]
            self.assertIn(DRY_RUN_TOOL_NAME, names, f"{phase} 缺少 dry_run")

    def test_other_phases_no_dry_run(self):
        for phase in ("chat", "preset", "evaluate"):
            names = [schema["function"]["name"] for schema in build_tools(phase)]
            self.assertNotIn(DRY_RUN_TOOL_NAME, names, f"{phase} 不应带 dry_run")


class ExecuteDryRunUnitTest(unittest.TestCase):
    def test_ghost_id_reports_per_op_error(self):
        ops = [{"op": "update_node", "id": "GHOST", "patch": {"label": "x"}, "reason": "r"},
               dict(GOOD_UPDATE)]
        payload = _execute_dry_run(ops, json.loads(json.dumps(SNAPSHOT)), "改标题", [])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["ops_received"], 2)
        self.assertEqual(payload["ops_valid"], 1)  # 合法那条照常过校验
        self.assertTrue(payload["errors"])

    def test_scope_drop_preview(self):
        snap = json.loads(json.dumps(SNAPSHOT))
        snap["scope_node_ids"] = ["A"]
        ops = [dict(GOOD_UPDATE)]  # B 不在选中集
        payload = _execute_dry_run(ops, snap, "整理", [])
        self.assertFalse(payload["ok"])
        self.assertEqual(payload.get("dropped_by_scope"), 1)
        self.assertTrue(any("范围外" in str(w.get("reason") or "") for w in payload["warnings"]))

    def test_isolated_create_flagged(self):
        ops = [{"op": "create_node", "temp_id": "n1", "kind": "human_note",
                "label": "孤立理解", "content": "", "reason": "新节点"}]
        payload = _execute_dry_run(ops, json.loads(json.dumps(SNAPSHOT)), "补节点", [])
        self.assertTrue(payload["isolated_new_nodes"])

    def test_valid_batch_ok(self):
        payload = _execute_dry_run([dict(GOOD_UPDATE)], json.loads(json.dumps(SNAPSHOT)), "改标题", [])
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["ops_valid"], 1)
        self.assertFalse(payload["errors"])

    def test_bad_arguments_return_error(self):
        snap = json.loads(json.dumps(SNAPSHOT))
        self.assertIn("error", _execute_dry_run("不是数组", snap, "", []))
        self.assertIn("error", _execute_dry_run([], snap, "", []))


class ReadonlyBatchDryRunTest(unittest.TestCase):
    def test_dry_run_enters_loop_edit_calls_do_not(self):
        dry = _tool_call(DRY_RUN_TOOL_NAME, {"ops": [dict(GOOD_UPDATE)]}, "call_1")
        edit = _tool_call("update_node", {"id": "B", "patch": {"label": "x"}}, "call_2")
        batch = _readonly_batch([dry, edit])
        self.assertEqual([c["id"] for c in batch], ["call_1"])


class ReviewGraphDryRunLoopTest(unittest.TestCase):
    def test_dry_run_then_fixed_final_plan(self):
        seen = []
        bad_ops = [{"op": "update_node", "id": "GHOST", "patch": {"label": "x"}, "reason": "猜的"}]
        final = json.dumps({"summary": "已把「动生电动势」改名为「动生电动势公式」",
                            "operations": [dict(GOOD_UPDATE)]}, ensure_ascii=False)
        fake = _recording_fake(
            [_llm(tool_calls=[_tool_call(DRY_RUN_TOOL_NAME, {"ops": bad_ops})]),
             _llm(content=final)],
            seen,
        )
        journal: list = []
        result = _run_review(fake, journal=journal)
        self.assertEqual(len(seen), 2)  # 试改一轮 + 定稿一次，无整批重试
        # 试改结果以 tool 消息回灌：第二次调用能看到逐条错误
        tool_msgs = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
        self.assertTrue(tool_msgs)
        self.assertIn("errors", tool_msgs[0]["content"])
        self.assertIn("GHOST", tool_msgs[0]["content"])
        # 最终方案协议零变化
        self.assertEqual(len(result["operations"]), 1)
        self.assertEqual(result["operations"][0]["patch"]["label"], "动生电动势公式")
        # journal 记了试改轮的 tool_results
        rounds = [j for j in journal if j.get("stage") == "generate" and j.get("tool_results")]
        self.assertTrue(any(r["name"] == DRY_RUN_TOOL_NAME for r in rounds[0]["tool_results"]))

    def test_dry_run_round_cap(self):
        ops = [dict(GOOD_UPDATE)]
        final = json.dumps({"summary": "好了", "operations": [dict(GOOD_UPDATE)]}, ensure_ascii=False)
        script = [_llm(tool_calls=[_tool_call(DRY_RUN_TOOL_NAME, {"ops": ops}, f"c{i}")])
                  for i in range(DRY_RUN_MAX_ROUNDS + 1)] + [_llm(content=final)]
        seen = []
        fake = _recording_fake(script, seen)
        result = _run_review(fake)
        self.assertEqual(len(seen), DRY_RUN_MAX_ROUNDS + 2)
        # 第三次试改收到上限提示（tool 结果在最后一次模型调用的消息里）
        tool_texts = [m["content"] for m in seen[-1]["messages"] if m.get("role") == "tool"]
        self.assertTrue(any("已用完" in t for t in tool_texts))
        self.assertEqual(len(result["operations"]), 1)

    def test_no_dry_run_behavior_unchanged(self):
        final = json.dumps({"summary": "已改名", "operations": [dict(GOOD_UPDATE)]}, ensure_ascii=False)
        seen = []
        fake = _recording_fake([_llm(content=final)], seen)
        result = _run_review(fake)
        self.assertEqual(len(seen), 1)  # 不用试改就少一次往返
        self.assertEqual(len(result["operations"]), 1)


class CriticEmptyIssuesRegressionTest(unittest.TestCase):
    """基线 case 3/4/9/15/16：critic 判 fail 且 issues/missing 全空 → 旧码
    return None, [] → None 进 finalize → AttributeError 500。"""

    def test_empty_issues_critic_no_longer_crashes(self):
        final = json.dumps({
            "summary": "补一张理解卡并连线",
            "operations": [
                {"op": "create_node", "temp_id": "n1", "kind": "human_note",
                 "label": "我的理解", "content": "面积变化导致磁通变化", "reason": "用户要求补充"},
                {"op": "add_edge", "from": "A", "to": "n1", "relation": "追问",
                 "label": "从问题引出理解", "reason": "新节点不孤立"},
            ],
        }, ensure_ascii=False)

        async def critic_stub(snapshot, instruction, ops, model, counter=None,
                              journal=None, result_snapshot=None, checklist=None):
            return {"ok": False, "issues": [], "missing": []}

        seen = []
        fake = _recording_fake([_llm(content=final)], seen)
        with mock.patch.object(review_mod, "_selfcheck_ops", new=critic_stub):
            result = _run_review(fake, retries=2, self_check="auto")
        # 不再 500：合法操作照常返回，空 issues 的 fail 降 warning 放行
        self.assertEqual(len(result["operations"]), 2)
        self.assertTrue(any("未给出具体问题" in str(w.get("reason") or "")
                            for w in result.get("warnings") or []))

    def test_critic_with_issues_still_retries(self):
        """issues 非空的重试语义不得被本修复波及：首轮带反馈重试，次轮放行。"""
        first = json.dumps({
            "summary": "补一张理解卡",
            "operations": [
                {"op": "create_node", "temp_id": "n1", "kind": "human_note",
                 "label": "我的理解", "content": "", "reason": "用户要求补充"},
                {"op": "add_edge", "from": "A", "to": "n1", "relation": "追问",
                 "label": "从问题引出理解", "reason": "新节点不孤立"},
            ],
        }, ensure_ascii=False)
        second = first
        calls = {"n": 0}

        async def critic_stub(snapshot, instruction, ops, model, counter=None,
                              journal=None, result_snapshot=None, checklist=None):
            calls["n"] += 1
            if calls["n"] == 1:
                return {"ok": False, "issues": ["未覆盖用户要求"], "missing": []}
            return {"ok": True, "issues": [], "missing": []}

        fake = _recording_fake([_llm(content=first), _llm(content=second)], [])
        with mock.patch.object(review_mod, "_selfcheck_ops", new=critic_stub):
            result = _run_review(fake, retries=2, self_check="auto")
        self.assertEqual(calls["n"], 1)  # critic 仅首次尝试
        self.assertEqual(len(result["operations"]), 2)


if __name__ == "__main__":
    unittest.main()
