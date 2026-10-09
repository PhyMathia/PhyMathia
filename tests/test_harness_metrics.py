"""质量记分牌单测（优化新路径①）：A/B 自检——好坏两套事件必须朝正确方向分化。

记分牌要能当回归门，先得证明它分得出好坏：好批次（一次通过、全量接受、结构
健康）与坏批次（重试、空操作、半量接受、改出孤立节点）喂进去，每个指标的差值
方向都要符合直觉。这是「故意删提示词规则→孤立率变红」那次 A/B 的确定性等价
（不花模型调用、可反复跑）。
"""

import importlib.util
import json
import os
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

_SPEC = importlib.util.spec_from_file_location(
    "harness_metrics", os.path.join(ROOT, "scripts", "harness_metrics.py"))
metrics = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(metrics)


def _connected_snapshot():
    return {
        "nodes": [
            {"id": "A", "kind": "knowledge", "label": "导数", "content": "变化率"},
            {"id": "B", "kind": "knowledge", "label": "极限", "content": "趋近"},
        ],
        "edges": [{"key": "B:out-0->A:in-0", "from": "B", "to": "A", "relation": "依赖"}],
    }


def _review(evt_id, ts, model, roundtrips, operations, status="ok"):
    return {"id": evt_id, "type": "review", "ts": ts, "status": status,
            "model": {"provider": "p", "model": model, "base_url": "u"},
            "operations": operations, "model_calls": 1 + len(roundtrips),
            "latency_ms": 3000, "snapshot_meta": {"est_tokens": 8000},
            "roundtrips": roundtrips}


GOOD_EVENTS = [
    _review("r1", 1759900000, "model-good",
            [{"stage": "main", "attempt": 0}],
            [{"op": "update_node", "id": "A", "patch": {"label": "X"}, "reason": "r"},
             {"op": "update_node", "id": "B", "patch": {"label": "Y"}, "reason": "r"}]),
    {"id": "a1", "type": "applied", "ts": 1759900100, "event_id": "r1", "mode": "all",
     "applied_ops": [{"op": "update_node", "id": "A", "patch": {"label": "X"}, "reason": "r"},
                     {"op": "update_node", "id": "B", "patch": {"label": "Y"}, "reason": "r"}],
     "before_snapshot": _connected_snapshot()},
    {"id": "f1", "type": "feedback", "ts": 1759900200, "kind": "good",
     "model": {"model": "model-good"}},
]

BAD_EVENTS = [
    _review("r2", 1759900000, "model-bad",
            [{"stage": "main", "attempt": 0}, {"stage": "main", "attempt": 1}],
            [{"op": "delete_node", "id": "B", "reason": "r"},
             {"op": "create_node", "temp_id": "t1", "kind": "knowledge", "label": "孤岛", "reason": "r"}]),
    _review("r3", 1759900000, "model-bad",
            [{"stage": "main", "attempt": 0}], [], status="no_ops"),
    {"id": "a2", "type": "applied", "ts": 1759900100, "event_id": "r2", "mode": "selected",
     "applied_ops": [{"op": "create_node", "temp_id": "t1", "kind": "knowledge",
                      "label": "孤岛", "reason": "r"}],
     "before_snapshot": _connected_snapshot()},
    {"id": "f2", "type": "feedback", "ts": 1759900200, "kind": "bad",
     "model": {"model": "model-bad"}},
]


class ScoreboardABTest(unittest.TestCase):
    """记分牌自身的 A/B 自检：好/坏两套事件，指标方向必须分化。"""

    @classmethod
    def setUpClass(cls):
        cls.good = metrics.compute_all(list(GOOD_EVENTS))
        cls.bad = metrics.compute_all(list(BAD_EVENTS))

    def test_first_pass_and_retry_diverge(self):
        self.assertEqual(self.good["overall"]["first_pass_pct"], 100.0)
        # 坏批次 2 条 review：1 条重试（attempt 0→1）、1 条单轮
        self.assertEqual(self.bad["overall"]["first_pass_pct"], 50.0)
        self.assertGreater(self.bad["overall"]["avg_retry_rounds"],
                           self.good["overall"]["avg_retry_rounds"])

    def test_noop_rate_diverges(self):
        self.assertEqual(self.good["overall"]["noop_pct"], 0.0)
        self.assertEqual(self.bad["overall"]["noop_pct"], 50.0)

    def test_acceptance_diverges(self):
        self.assertEqual(self.good["overall"]["accept_ratio_pct"], 100.0)
        # 提议 2 条只应用 1 条（勾选一半）
        self.assertEqual(self.bad["overall"]["accept_ratio_pct"], 50.0)

    def test_orphan_rate_diverges(self):
        self.assertEqual(self.good["overall"]["orphan_rate_pct"], 0.0)
        # 坏批次应用了「新建节点不连线」→ 重放结果图里 3 节点 1 孤立
        self.assertAlmostEqual(self.bad["overall"]["orphan_rate_pct"],
                               100.0 / 3.0, places=3)

    def test_thumbs_diverge(self):
        self.assertEqual((self.good["overall"]["thumbs_up"],
                          self.good["overall"]["thumbs_down"]), (1, 0))
        self.assertEqual((self.bad["overall"]["thumbs_up"],
                          self.bad["overall"]["thumbs_down"]), (0, 1))

    def test_grouped_by_week_and_model(self):
        self.assertIn("2025-W41 model-good", self.good["groups"])
        self.assertIn("2025-W41 model-bad", self.bad["groups"])
        self.assertEqual(self.good["groups"]["2025-W41 model-good"]["first_pass_pct"], 100.0)

    def test_load_events_skips_bad_lines(self):
        with tempfile.TemporaryDirectory() as td:
            with open(os.path.join(td, "phi_test.jsonl"), "w", encoding="utf-8") as f:
                f.write(json.dumps(GOOD_EVENTS[0]) + "\n")
                f.write("not-json\n\n")
            events = metrics.load_events(td)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["_session"], "phi_test")

    def test_unlinked_applied_counted_separately(self):
        events = list(BAD_EVENTS) + [
            {"id": "a9", "type": "applied", "ts": 1759900300, "event_id": "missing",
             "applied_ops": [], "before_snapshot": None},
        ]
        report = metrics.compute_all(events)
        self.assertEqual(report["counts"]["applied_unlinked"], 1)
        # 未关联批次不进接受率分母
        self.assertEqual(report["overall"]["accept_ratio_pct"], 50.0)


if __name__ == "__main__":
    unittest.main()
