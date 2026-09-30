"""T94（评审路线 #9）上下文预算与历史自动压缩回归。

覆盖：
- 条数超 12 触发摘要压缩：摘要 + 最近 6 条原文，最终 user 消息含「已压缩」与摘要；
- 最近 6 条保留原文、更早条目被摘要替换（不再逐条渲染）；
- 进程内摘要缓存命中：同历史第二次请求不再调摘要模型；
- 摘要失败（HarnessError）降级回既有截断行为，绝不阻断，结果仍 ok；
- 条数与预算都不触发时零额外调用；
- 纯预算触发（条数 ≤12 但 est 超预算）与压缩后仍超预算的硬截断（摘要+最近 4 条）；
- older 为空（≤6 条纯预算超）直接硬截到最近 4 条；
- _history_block 对 compact_summary 条目的渲染（头部、与普通条目共存）；
- 摘要调用清空 thinking（model 副本），max_tokens=HISTORY_SUMMARY_MAX_TOKENS；
- journal 收到 stage=="history_compact" 条目；
- context_metrics 新增字段（history_entries/history_compacted/context_est_tokens/
  budget_tokens）且不破坏 resolve 调用点的默认值；
- 摘要正文 400 字硬截。

桩形态照旧：patch.object(review_mod, "_call_model", new=fake)，固定签名；fake 按
messages[0] 的 system 是否含「摘要器」区分摘要调用与正常 review 调用并记录每次
收到的 messages/model/max_tokens。摘要缓存是模块级，setUp/tearDown 清空。
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
from harness.review import _history_block

MODEL = {"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""}
SNAPSHOT = {
    "version": 1,
    "nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "瞬时变化率"}],
    "edges": [],
}
SUMMARY_TEXT = "用户定下的方案：把节点 A 的正文改成物理视角；未完成：补充单位说明。"
GEN_PAYLOAD = {
    "content": json.dumps({
        "summary": "已按此前方案处理",
        "operations": [{
            "op": "update_node", "node_id": "A",
            "patch": {"content": "物理视角"}, "reason": "按早前方案",
        }],
    }, ensure_ascii=False),
    "tool_calls": [],
}


def _history(rounds: int) -> list:
    """rounds 轮对话＝2*rounds 条历史（user 条与 assistant 条交替）。"""
    history = []
    for i in range(rounds):
        history.append({"role": "user", "instruction": f"第{i}轮：把节点 A 改成物理视角"})
        history.append({
            "role": "assistant",
            "summary": f"已完成第{i}轮修改",
            "operations": [{"op": "update_node", "id": "A"}],
        })
    return history


def _make_fake(seen: list, summary_text: str = SUMMARY_TEXT, summary_exc=None,
               gen: dict = GEN_PAYLOAD):
    """记录每次调用；system 含「摘要器」的走摘要分支，其余走正常生成。"""

    async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                   json_mode=False, on_delta=None):
        sys_text = str(messages[0].get("content") or "") if messages else ""
        is_summary = "摘要器" in sys_text
        seen.append({
            "is_summary": is_summary,
            "messages": json.loads(json.dumps(messages, ensure_ascii=False, default=str)),
            "model": dict(model),
            "max_tokens": max_tokens,
            "tools": tools,
        })
        if is_summary:
            if summary_exc is not None:
                raise summary_exc
            return {"content": summary_text, "tool_calls": []}
        return dict(gen)

    return fake


def _run(fake, *, history=None, **kwargs):
    with mock.patch.object(review_mod, "_call_model", new=fake):
        return asyncio.run(review_mod.review_graph(
            dict(SNAPSHOT),
            "把节点 A 的正文更新一下",
            model=dict(MODEL),
            mode="json",
            self_check="off",
            retries=0,
            history=history,
            **kwargs,
        ))


def _gen_user_content(seen: list) -> str:
    """最后一次生成调用收到的最后一条 user 消息（历史块就追加在这里）。"""
    gen_calls = [r for r in seen if not r["is_summary"]]
    return gen_calls[-1]["messages"][-1]["content"]


class _HistoryCompactBase(unittest.TestCase):
    def setUp(self):
        self._orig_budget = review_mod.HARNESS_CONTEXT_BUDGET_TOKENS
        review_mod._HISTORY_SUMMARY_CACHE.clear()

    def tearDown(self):
        review_mod.HARNESS_CONTEXT_BUDGET_TOKENS = self._orig_budget
        review_mod._HISTORY_SUMMARY_CACHE.clear()


class HistoryCompactTriggerTest(_HistoryCompactBase):
    def test_over_12_entries_triggers_summary_plus_recent_six(self):
        history = _history(7)  # 14 条
        seen = []
        result = _run(_make_fake(seen), history=history)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len([r for r in seen if r["is_summary"]]), 1)
        self.assertEqual(len([r for r in seen if not r["is_summary"]]), 1)
        final_user = _gen_user_content(seen)
        self.assertIn("已压缩", final_user)
        self.assertIn(SUMMARY_TEXT, final_user)
        cm = result["context_metrics"]
        self.assertTrue(cm["history_compacted"])
        self.assertEqual(cm["history_entries"], 7)  # 摘要 1 条 + 最近 6 条
        self.assertEqual(cm["budget_tokens"], review_mod.HARNESS_CONTEXT_BUDGET_TOKENS)
        self.assertGreater(cm["context_est_tokens"], 0)

    def test_recent_six_kept_verbatim_old_entries_dropped(self):
        history = _history(7)
        seen = []
        _run(_make_fake(seen), history=history)
        final_user = _gen_user_content(seen)
        self.assertIn(history[-2]["instruction"], final_user)   # 第 13 轮用户指令原文
        self.assertIn(history[-1]["summary"], final_user)       # 第 13 轮助手摘要原文
        self.assertIn(history[-6]["instruction"], final_user)   # 最近 6 条第 1 条
        self.assertNotIn(history[0]["instruction"], final_user)  # 第 0 轮已被摘要替换
        self.assertNotIn(history[1]["summary"], final_user)

    def test_second_request_same_history_hits_summary_cache(self):
        history = _history(7)
        seen = []
        _run(_make_fake(seen), history=history)
        self.assertEqual(len(seen), 2)  # 摘要 + 生成
        result = _run(_make_fake(seen), history=history)
        self.assertEqual(len(seen), 3)  # 第二次只有生成：摘要命中缓存
        self.assertEqual(sum(1 for r in seen if r["is_summary"]), 1)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["context_metrics"]["history_compacted"])

    def test_summary_failure_degrades_to_old_truncation_without_blocking(self):
        history = _history(7)
        seen = []
        result = _run(
            _make_fake(seen, summary_exc=review_mod.HarnessError("摘要上游 500")),
            history=history,
        )
        self.assertEqual(result["status"], "ok")
        self.assertEqual(len([r for r in seen if r["is_summary"]]), 1)
        final_user = _gen_user_content(seen)
        # 降级＝既有「最近 6 条详细 + 更早一行」行为：旧条目以截断前缀出现
        self.assertIn("此前多轮编辑历史", final_user)
        self.assertIn(history[0]["instruction"][:100], final_user)
        cm = result["context_metrics"]
        self.assertFalse(cm["history_compacted"])
        self.assertEqual(cm["history_entries"], 14)

    def test_below_threshold_makes_single_generation_call(self):
        history = _history(5)  # 10 条 ≤ 12，est 远小于预算
        seen = []
        result = _run(_make_fake(seen), history=history)
        self.assertEqual(len(seen), 1)
        self.assertFalse(seen[0]["is_summary"])
        cm = result["context_metrics"]
        self.assertFalse(cm["history_compacted"])
        self.assertEqual(cm["history_entries"], 10)

    def test_budget_trigger_with_few_entries(self):
        review_mod.HARNESS_CONTEXT_BUDGET_TOKENS = 1
        history = _history(4)  # 8 条 ≤ 12：只能靠预算触发
        seen = []
        result = _run(_make_fake(seen), history=history)
        self.assertEqual(sum(1 for r in seen if r["is_summary"]), 1)
        self.assertTrue(result["context_metrics"]["history_compacted"])
        self.assertEqual(result["context_metrics"]["budget_tokens"], 1)

    def test_hard_truncate_to_summary_plus_last_four_when_still_over_budget(self):
        review_mod.HARNESS_CONTEXT_BUDGET_TOKENS = 1
        history = _history(7)
        seen = []
        result = _run(_make_fake(seen), history=history)
        final_user = _gen_user_content(seen)
        self.assertIn(SUMMARY_TEXT, final_user)
        self.assertIn(history[-2]["instruction"], final_user)    # 第 12 轮保留
        self.assertIn(history[-4]["instruction"], final_user)    # 第 10 轮保留
        self.assertNotIn(history[-6]["instruction"], final_user)  # 第 8 轮被硬截掉
        self.assertEqual(result["context_metrics"]["history_entries"], 5)

    def test_budget_trigger_with_no_older_entries_hard_truncates_to_four(self):
        review_mod.HARNESS_CONTEXT_BUDGET_TOKENS = 1
        history = _history(3)  # 6 条：没有可摘要的更早条目
        seen = []
        result = _run(_make_fake(seen), history=history)
        self.assertEqual(len(seen), 1)  # 零摘要调用
        self.assertFalse(seen[0]["is_summary"])
        final_user = _gen_user_content(seen)
        self.assertIn(history[-2]["instruction"], final_user)
        self.assertNotIn(history[0]["instruction"], final_user)
        cm = result["context_metrics"]
        self.assertEqual(cm["history_entries"], 4)
        self.assertFalse(cm["history_compacted"])

    def test_summary_call_clears_thinking_and_uses_summary_max_tokens(self):
        seen = []
        _run(_make_fake(seen), history=_history(7), thinking="high")
        summary_call = [r for r in seen if r["is_summary"]][0]
        gen_call = [r for r in seen if not r["is_summary"]][0]
        self.assertEqual(summary_call["model"].get("thinking"), "")
        self.assertEqual(gen_call["model"].get("thinking"), "high")
        self.assertEqual(summary_call["max_tokens"], review_mod.HISTORY_SUMMARY_MAX_TOKENS)
        self.assertIn("摘要器", summary_call["messages"][0]["content"])

    def test_journal_records_history_compact_entry(self):
        history = _history(7)
        journal = []
        _run(_make_fake([]), history=history, journal=journal)
        entries = [e for e in journal if e.get("stage") == "history_compact"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["covered"], 8)
        self.assertEqual(entries[0]["summary_chars"], len(SUMMARY_TEXT))

    def test_long_summary_truncated_to_400_chars(self):
        long_summary = "摘" * 1000
        seen = []
        _run(_make_fake(seen, summary_text=long_summary), history=_history(7))
        final_user = _gen_user_content(seen)
        self.assertIn("摘" * 400, final_user)
        self.assertNotIn("摘" * 401, final_user)


class HistoryBlockCompactRenderTest(unittest.TestCase):
    def test_compact_summary_rendered_at_head_with_plain_entries(self):
        history = [
            {"role": "user", "instruction": "第五轮续写"},
            {"role": "assistant", "summary": "已完成", "operations": [{"op": "add_edge", "id": "e1"}]},
            {"role": "compact_summary", "summary": "早前把 A 改成物理视角", "covered": 8},
        ]
        block = _history_block(history)
        self.assertIn("[此前 8 轮对话已压缩] 摘要：早前把 A 改成物理视角", block)
        self.assertIn("第五轮续写", block)
        self.assertIn("；操作：add_edge(e1)", block)
        # 摘要条目排在历史块头部（紧跟标题行），即使传入位置靠后
        self.assertLess(block.index("已压缩"), block.index("第五轮续写"))

    def test_compact_summary_does_not_break_old_truncation_behavior(self):
        history = []
        for i in range(8):
            history.append({"role": "user", "instruction": "指令" + str(i) + "长" * 200})
            history.append({"role": "assistant", "summary": "摘要" + str(i) + "长" * 200,
                            "operations": [{"op": "add_edge", "id": "e" + str(i)}]})
        block = _history_block(history)
        self.assertEqual(block.count("；操作："), 3)
        self.assertIn("1. 用户：指令0", block)
        self.assertIn("；操作：add_edge(e7)", block)


class ContextMetricsFieldsTest(_HistoryCompactBase):
    def test_metrics_carry_budget_fields_on_review_path(self):
        result = _run(_make_fake([]), history=_history(5))
        cm = result["context_metrics"]
        for key in ("est_tokens", "history_entries", "history_compacted",
                    "context_est_tokens", "budget_tokens"):
            self.assertIn(key, cm)
        self.assertGreater(cm["context_est_tokens"], 0)

    def test_log_context_metrics_defaults_for_resolve_call_style(self):
        metrics = review_mod._log_context_metrics(
            [{"role": "system", "content": "s"}, {"role": "user", "content": "u"}],
            {"nodes": [], "edges": []},
            "resolve",
        )
        self.assertIn("est_tokens", metrics)
        self.assertEqual(metrics["history_entries"], 0)
        self.assertFalse(metrics["history_compacted"])
        self.assertEqual(metrics["budget_tokens"], review_mod.HARNESS_CONTEXT_BUDGET_TOKENS)
        self.assertEqual(metrics["context_est_tokens"], metrics["est_tokens"])


if __name__ == "__main__":
    unittest.main()
