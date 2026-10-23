"""阶段1「先对齐、再动手」（2026-10-19 计划）：范围硬闸＋复述确认＋拆批提示。

配套 T253 事件环境标记的落点断言也在本文件（Class HarnessEventEnvTest）。
计划：docs/Φ智能体继续建设计划-2026-10-19.md 阶段 1/阶段 0。
"""
import asyncio
import json
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import harness.review as review_mod
from harness.core import normalize_snapshot
from harness.events import append_event, set_event_env, set_events_dir


def _ops_payload(ops, summary="整理"):
    return json.dumps({"summary": summary, "operations": ops}, ensure_ascii=False)


def _op_update(node_id, reason="r"):
    return {"op": "update_node", "id": node_id, "patch": {"content": "新内容"}, "reason": reason}


def _op_create(temp_id, label, reason="r"):
    return {"op": "create_node", "temp_id": temp_id, "kind": "human_note",
            "label": label, "content": "正文", "reason": reason}


TWO_NODE_SNAPSHOT = {
    "nodes": [
        {"id": "A", "kind": "human_note", "label": "电磁感应"},
        {"id": "B", "kind": "human_note", "label": "楞次定律"},
    ],
    "edges": [],
}


class _StubModel:
    """按调用序返回预设响应的 _call_model 桩（复述确认会多发一次轻量调用）。"""

    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    async def __call__(self, messages, model, max_tokens, tools=None,
                       tool_choice=None, json_mode=False, on_delta=None):
        self.calls.append({
            "messages": messages,
            "tools": tools,
            "json_mode": json_mode,
            "max_tokens": max_tokens,
        })
        item = self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]
        if isinstance(item, Exception):
            raise item
        return {"content": item, "tool_calls": []}


def _run_review(stub, snapshot, instruction="整理一下", **kw):
    with unittest.mock.patch.object(review_mod, "_call_model", new=stub):
        with unittest.mock.patch.object(
                review_mod, "_resolve_model",
                lambda m: {"provider": "openai", "model": "stub", "api_key": "k",
                           "base_url": "http://x/v1"}):
            kw.setdefault("mode", "json")
            kw.setdefault("self_check", "off")
            kw.setdefault("retries", 1)
            return asyncio.run(review_mod.review_graph(
                snapshot, instruction, **kw))



class ScopeNodeIdsNormalizationTest(unittest.TestCase):
    """scope_node_ids 穿过归一化（阶段1-2 的前置：此前前端发了后端就丢）。"""

    def test_passes_through_existing_ids_only(self):
        out = normalize_snapshot({
            "nodes": [
                {"id": "A", "kind": "human_note", "label": "a"},
                {"id": "B", "kind": "human_note", "label": "b"},
            ],
            "edges": [],
            "scope_node_ids": ["A", "B", "GHOST", "A"],
        })
        self.assertEqual(out.get("scope_node_ids"), ["A", "B"])

    def test_absent_when_empty_or_all_unknown(self):
        out = normalize_snapshot({
            "nodes": [{"id": "A", "kind": "human_note", "label": "a"}],
            "edges": [],
            "scope_node_ids": ["GHOST"],
        })
        self.assertNotIn("scope_node_ids", out)
        self.assertNotIn("scope_node_ids", normalize_snapshot({"nodes": [], "edges": []}))


class ScopeGateTest(unittest.TestCase):
    """选中即范围硬闸：范围外既有节点的改动被剔除并附 T236 体例警告。"""

    def test_drops_out_of_scope_update_with_warning(self):
        snapshot = dict(TWO_NODE_SNAPSHOT, scope_node_ids=["A"])
        # 两次都带越界（retries=1 → 末次剔除）
        payload = _ops_payload([
            _op_update("A"), _op_create("N1", "新1"), _op_create("N2", "新2"),
            _op_update("B"),
        ])
        stub = _StubModel([payload, payload, "我打算整理「电磁感应」并新增两个节点。"])
        result = _run_review(stub, snapshot)
        self.assertEqual(result["status"], "ok")
        targets = [str(op.get("id") or "") for op in result["operations"]
                   if op.get("op") == "update_node"]
        self.assertNotIn("B", targets)
        self.assertIn("A", targets)
        scope_warnings = [w for w in result.get("warnings") or [] if w.get("index") == "scope"]
        self.assertTrue(scope_warnings)
        self.assertIn("楞次定律", scope_warnings[0]["reason"])

    def test_soft_retry_lets_model_fix_violations(self):
        snapshot = dict(TWO_NODE_SNAPSHOT, scope_node_ids=["A"])
        bad = _ops_payload([_op_update("A"), _op_update("B")])
        good = _ops_payload([_op_update("A")])
        stub = _StubModel([bad, good])
        result = _run_review(stub, snapshot)
        self.assertEqual(result["status"], "ok")
        targets = [str(op.get("id") or "") for op in result["operations"]
                   if op.get("op") == "update_node"]
        self.assertEqual(targets, ["A"])
        self.assertFalse([w for w in result.get("warnings") or [] if w.get("index") == "scope"])
        # 2 条操作不触发复述确认：两次调用都是生成轮
        self.assertEqual(len(stub.calls), 2)

    def test_no_selection_means_no_gate(self):
        snapshot = dict(TWO_NODE_SNAPSHOT)   # 无 scope_node_ids
        payload = _ops_payload([_op_update("A"), _op_update("B")])
        stub = _StubModel([payload])
        result = _run_review(stub, snapshot)
        targets = {str(op.get("id") or "") for op in result["operations"]
                   if op.get("op") == "update_node"}
        self.assertEqual(targets, {"A", "B"})
        self.assertFalse([w for w in result.get("warnings") or [] if w.get("index") == "scope"])


class ConfirmBeatTest(unittest.TestCase):
    """复述确认节拍：≥4 条操作规则触发，模型复述、失败静默降级。"""

    def test_triggered_on_large_batch(self):
        payload = _ops_payload([
            _op_update("A"), _op_update("A", "r2"),
            _op_create("N1", "新1"), _op_create("N2", "新2"),
        ])
        restatement = "我打算把「电磁感应」改成 x，并新增「新1」「新2」。"
        stub = _StubModel([payload, restatement])
        result = _run_review(stub, dict(TWO_NODE_SNAPSHOT), retries=0)
        self.assertIn("confirm", result)
        self.assertEqual(result["confirm"]["text"], restatement)
        self.assertEqual(result["confirm"]["reason"], "ops")
        # 复述调用不带给工具、token 上限收紧
        confirm_call = stub.calls[-1]
        self.assertIsNone(confirm_call["tools"])
        self.assertLessEqual(confirm_call["max_tokens"], 500)

    def test_not_triggered_small_batch(self):
        payload = _ops_payload([_op_update("A"), _op_update("A", "r2")])
        stub = _StubModel([payload])
        result = _run_review(stub, dict(TWO_NODE_SNAPSHOT))
        self.assertNotIn("confirm", result)
        self.assertEqual(len(stub.calls), 1)

    def test_restatement_failure_degrades_silently(self):
        payload = _ops_payload([
            _op_update("A"), _op_update("A", "r2"),
            _op_create("N1", "新1"), _op_create("N2", "新2"),
        ])
        stub = _StubModel([payload, review_mod.HarnessError("上游 429")])
        result = _run_review(stub, dict(TWO_NODE_SNAPSHOT), retries=0)
        self.assertEqual(result["status"], "ok")
        self.assertNotIn("confirm", result)

    def test_chat_phase_never_confirms(self):
        payload = _ops_payload([_op_update("A")] * 5)
        stub = _StubModel([payload])
        result = _run_review(stub, dict(TWO_NODE_SNAPSHOT), phase="chat", retries=0)
        self.assertNotIn("confirm", result)


class BatchSegmentTest(unittest.TestCase):
    """大批拆段：超 BATCH_SEGMENT_OPS 条的批次带 batch_segments 元数据与警告。"""

    def test_nine_ops_get_two_segments(self):
        ops = [_op_create("N%d" % i, "节点%d" % i) for i in range(9)]
        stub = _StubModel([_ops_payload(ops), "我打算新建 9 个节点。"])
        result = _run_review(stub, dict(TWO_NODE_SNAPSHOT), retries=0)
        batch_warnings = [w for w in result.get("warnings") or [] if w.get("index") == "batch"]
        self.assertTrue(batch_warnings)
        self.assertIn("拆", batch_warnings[0]["reason"])
        meta = result.get("batch_segments") or {}
        self.assertEqual(meta.get("segment_ops"), review_mod.BATCH_SEGMENT_OPS)
        self.assertGreaterEqual(meta.get("segments") or 0, 2)
        self.assertFalse(meta.get("oversized"))

    def test_oversized_batch_advises_narrowing(self):
        ops = [_op_create("N%d" % i, "节点%d" % i) for i in range(review_mod.BATCH_OVERSIZED_OPS + 1)]
        stub = _StubModel([_ops_payload(ops), "我打算新建很多节点。"])
        result = _run_review(stub, dict(TWO_NODE_SNAPSHOT), retries=0)
        self.assertTrue((result.get("batch_segments") or {}).get("oversized"))
        batch_warnings = [w for w in result.get("warnings") or [] if w.get("index") == "batch"]
        self.assertTrue(any("缩小范围" in w["reason"] for w in batch_warnings))


class HarnessEventEnvTest(unittest.TestCase):
    """T253：事件环境标记——测试流量与真实使用可分，记分牌默认排除。"""

    def test_append_event_stamps_env(self):
        from harness import events as events_mod
        original_dir = events_mod._EVENTS_DIR
        original_env = events_mod.event_env()
        with tempfile.TemporaryDirectory() as tmp:
            try:
                set_events_dir(tmp)
                set_event_env("user")
                append_event("phi_env_test", {"id": "e1", "type": "review"})
                set_event_env("test")
                append_event("phi_env_test", {"id": "e2", "type": "review"})
                lines = [json.loads(x) for x in
                         (Path(tmp) / "phi_env_test.jsonl").read_text(encoding="utf-8").splitlines()]
                self.assertEqual(lines[0].get("env"), "user")
                self.assertEqual(lines[1].get("env"), "test")
            finally:
                set_event_env(original_env)
                set_events_dir(original_dir)

    def test_metrics_split_test_traffic(self):
        from scripts.harness_metrics import split_test_traffic
        real = {"type": "review", "env": "user", "model": {"model": "mimo"}}
        marked = {"type": "review", "env": "test", "model": {"model": "mimo"}}
        legacy = {"type": "review", "model": {"model": "m"}}          # 遗留：无 env＋mock 名
        legacy_real = {"type": "review", "model": {"model": "mimo"}}  # 遗留：无 env＋真模型
        real_events, test_events = split_test_traffic([real, marked, legacy, legacy_real])
        self.assertEqual([id(x) for x in real_events], [id(real), id(legacy_real)])
        self.assertEqual([id(x) for x in test_events], [id(marked), id(legacy)])


if __name__ == "__main__":
    unittest.main()
