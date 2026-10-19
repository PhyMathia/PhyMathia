#!/usr/bin/env python3
"""Φ 质量记分牌（优化新路径①，2026-10-09 批次）：把既有数据变成可跨时间对比的分数。

为什么是 Python 而不是既有挖矿脚本的 .mjs：孤立节点/断链要按操作语义重放出
结果图——直接 import harness.core.build_next_snapshot 与
harness.selfcheck.check_snapshot_consistency，重放语义与线上零漂移（在 .mjs 里
再写一遍 op 语义迟早漂移）。

数据源（全只读、零模型调用、零网络）：
- logs/harness_events/<sid>.jsonl   T96 会话事件（review / applied / undo / feedback）

指标（总体＋按 周×模型 聚合）：
- 一次通过率：review 事件没有任何重试轮（roundtrips 里 stage=main 且 attempt>0；
  无 roundtrips 的旧事件退用 model_calls>2 启发式，含自检调用故偏保守）
- 澄清率 / 空操作率 / 错误率：status 口径（clarify / no_ops 或 ok 零操作 / error 族）
- 平均重试轮数 / 平均耗时 / 平均 est token
- 用户接受率：applied 事件经 event_id 关联回 review 事件，Σ应用 ops ÷ Σ提议 ops
- 结构健康（A/B 自检的尺子）：applied 批次用 before_snapshot＋applied_ops 重放出
  结果图，孤立节点率＝孤立节点÷节点总数；断链批次数单列

回归门用法：改 harness/prompts.py、换默认模型、动校验器之前跑一次，
分数差记进 docs/harness/iteration-log.md——「感觉不错」要能变成一条曲线。
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (str(ROOT), str(ROOT / "src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)
# 与 tests/conftest.py 同款双路径：harness 包在根、server 包在 src（harness.review
# 顶层 import server.http_client，只插根不够）

from harness.core import build_next_snapshot  # noqa: E402
from harness.selfcheck import check_snapshot_consistency  # noqa: E402

DEFAULT_EVENTS_DIR = ROOT / "logs" / "harness_events"


def load_events(events_dir) -> list:
    events = []
    directory = Path(events_dir)
    if not directory.exists():
        return events
    for path in sorted(directory.glob("*.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except Exception:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
            except Exception:
                continue
            if isinstance(evt, dict):
                evt["_session"] = path.stem
                events.append(evt)
    return events


# ---- T253（阶段0 A1）：测试流量识别 ----
# 结构化标记：2026-10-19 起事件落盘带 env 字段（测试服务进程 HARNESS_EVENT_ENV=test）。
# 遗留启发式：env 字段出现之前的旧事件里，battery/pytest 流量的模型名固定是
# mock 桩的 "m" 且亚毫秒延迟——用「模型名 m」判定（真实模型不会叫单字符 m）。
# --include-test 可把测试行含回（对照管道本身是否还跑得通时用）。
_LEGACY_TEST_MODELS = {"m"}


def is_test_event(evt: dict) -> bool:
    if str(evt.get("env") or "").strip().lower() == "test":
        return True
    if evt.get("env"):
        return False   # 有 env 且不是 test → 明确的真实流量
    return _model_of(evt) in _LEGACY_TEST_MODELS


def split_test_traffic(events: list) -> tuple:
    real, test = [], []
    for evt in events:
        (test if is_test_event(evt) else real).append(evt)
    return real, test


def week_key(ts) -> str:
    try:
        moment = datetime.datetime.fromtimestamp(float(ts or 0))
    except (TypeError, ValueError, OSError, OverflowError):
        moment = datetime.datetime.fromtimestamp(0)
    iso = moment.isocalendar()
    return "%04d-W%02d" % (iso[0], iso[1])


def _model_of(evt: dict) -> str:
    model = evt.get("model")
    if isinstance(model, dict):
        return str(model.get("model") or model.get("name") or "未知模型")
    if isinstance(model, str) and model:
        return model
    return "未知模型"


def _error_bucket_flags(evt: dict) -> dict:
    """阶段2-1：错误四桶的机检代理（启发式，A3 人工分桶的自动化预筛）。

    数据源＝事件里的 warnings 明细（2026-10-19 起入事件）＋ errors ＋ roundtrips 的
    retry_feedback（重试反馈文本里带着校验器退回的具体原因）。旧事件没有 warnings
    明细时靠 retry_feedback 仍可分桶。桶口径对齐 A3 的人工四桶：
    目标选错／动作选错／范围过大／协议丢字段。
    """
    pool: list = []
    for w in (evt.get("warnings") or []):
        if isinstance(w, dict):
            pool.append("w:%s|%s" % (w.get("index"), w.get("reason")))
    for e in (evt.get("errors") or []):
        if isinstance(e, dict):
            pool.append("e:%s|%s" % (e.get("index"), e.get("reason")))
    for r in (evt.get("roundtrips") or []):
        if isinstance(r, dict):
            pool.append("r|%s" % r.get("retry_feedback"))
    blob = "\n".join(pool)
    status = str(evt.get("status") or "")
    return {
        # 模型改/评了用户没指的节点（焦点遵从校验退回）
        "wrong_target": any(key in blob for key in (
            "未命中用户指定的重点节点", "请改为修改这些节点", "不要评价其他节点")),
        # 模型有意图但产出不合格（空操作拒执行／清单未达成／critic 打回）
        "wrong_action": any(key in blob for key in (
            "达成清单未达成", "selfcheck", "请输出真实图操作",
            "评价阶段必须生成", "应用阶段必须根据")),
        # 越过选中/焦点边界动图（阶段1-2 硬闸剔除记录，或既有焦点退回文案）
        "over_scope": ("w:scope|" in blob or "范围外" in blob),
        # 协议层失败（JSON/工具调用解析、schema 不合）
        "protocol_drop": (status == "parse_error" or any(key in blob for key in (
            "不是合法 JSON", "工具调用解析失败", "必须是数组", "operations"))),
    }


def review_rows(events: list) -> list:
    rows = []
    for evt in events:
        if evt.get("type") != "review":
            continue
        roundtrips = [r for r in (evt.get("roundtrips") or []) if isinstance(r, dict)]
        mains = [r for r in roundtrips if r.get("stage") == "main"]
        if mains:
            retry_rounds = max(int(r.get("attempt") or 0) for r in mains)
        else:
            retry_rounds = 1 if int(evt.get("model_calls") or 0) > 2 else 0
        status = str(evt.get("status") or "")
        ops_count = len(evt.get("operations") or [])
        rows.append({
            "week": week_key(evt.get("ts")),
            "model": _model_of(evt),
            "status": status,
            "ops": ops_count,
            "retry_rounds": retry_rounds,
            "first_pass": retry_rounds == 0,
            "clarify": status == "clarify",
            "noop": status == "no_ops" or (status == "ok" and ops_count == 0),
            "error": status in ("error", "parse_error", "invalid"),
            "latency_ms": float(evt.get("latency_ms") or 0),
            "est_tokens": float((evt.get("snapshot_meta") or {}).get("est_tokens") or 0),
            **_error_bucket_flags(evt),
        })
    return rows


def acceptance_rows(events: list) -> tuple:
    """applied→review 配对（event_id 关联）：提议 ops vs 实际应用 ops。"""
    reviews = {str(e.get("id")): e for e in events
               if e.get("type") == "review" and e.get("id")}
    rows, unlinked = [], 0
    for evt in events:
        if evt.get("type") != "applied":
            continue
        rev = reviews.get(str(evt.get("event_id") or ""))
        if rev is None:
            unlinked += 1
            continue
        proposed = len(rev.get("operations") or [])
        if proposed <= 0:
            continue
        applied = len(evt.get("applied_ops") or [])
        rows.append({
            "week": week_key(rev.get("ts")),
            "model": _model_of(rev),
            "proposed": proposed,
            "applied": min(applied, proposed),
        })
    return rows, unlinked


def structural_rows(events: list) -> list:
    """applied 批次重放结果图 → 孤立节点/断链（结构尺子，A/B 自检用）。"""
    reviews = {str(e.get("id")): e for e in events
               if e.get("type") == "review" and e.get("id")}
    rows = []
    for evt in events:
        if evt.get("type") != "applied":
            continue
        before = evt.get("before_snapshot")
        ops = evt.get("applied_ops")
        if not isinstance(before, dict) or not isinstance(ops, list) or not ops:
            continue
        try:
            after = build_next_snapshot(before, ops).get("next_snapshot")
            report = check_snapshot_consistency(after)
        except Exception:
            continue
        base = reviews.get(str(evt.get("event_id") or "")) or evt
        issues = report.get("issues") or []
        rows.append({
            "week": week_key(base.get("ts")),
            "model": _model_of(base),
            "nodes": int(report.get("node_count") or 0),
            "orphans": sum(1 for i in issues if i.get("type") == "orphan"),
            "broken_edges": sum(1 for i in issues if i.get("type") == "broken_edge"),
        })
    return rows


def feedback_rows(events: list) -> list:
    return [{
        "week": week_key(e.get("ts")),
        "model": _model_of(e),
        "kind": str(e.get("kind") or ""),
    } for e in events if e.get("type") == "feedback"]


def _pct(part, total):
    return (100.0 * part / total) if total else None


def _avg(values):
    # 只滤 None 不滤 0：重试轮数 0 是有效观测（全零被滤掉会让均值变 None）
    values = [v for v in values if v is not None]
    return (sum(values) / len(values)) if values else None


def _metrics(bucket: dict) -> dict:
    reviews_list = bucket["reviews"]
    n = len(reviews_list)
    accept = bucket["accepts"]
    struct = bucket["structs"]
    fb = bucket["feedbacks"]
    nodes_total = sum(r["nodes"] for r in struct)
    return {
        "reviews": n,
        "first_pass_pct": _pct(sum(1 for r in reviews_list if r["first_pass"]), n),
        "clarify_pct": _pct(sum(1 for r in reviews_list if r["clarify"]), n),
        "noop_pct": _pct(sum(1 for r in reviews_list if r["noop"]), n),
        "error_pct": _pct(sum(1 for r in reviews_list if r["error"]), n),
        "avg_retry_rounds": _avg([r["retry_rounds"] for r in reviews_list]),
        "avg_latency_ms": _avg([r["latency_ms"] for r in reviews_list]),
        "avg_est_tokens": _avg([r["est_tokens"] for r in reviews_list]),
        "accept_batches": len(accept),
        "accept_ratio_pct": _pct(sum(r["applied"] for r in accept),
                                 sum(r["proposed"] for r in accept)),
        "replayed_batches": len(struct),
        "orphan_rate_pct": _pct(sum(r["orphans"] for r in struct), nodes_total),
        "broken_edge_batches": sum(1 for r in struct if r["broken_edges"]),
        "thumbs_up": sum(1 for f in fb if f["kind"] != "bad"),
        "thumbs_down": sum(1 for f in fb if f["kind"] == "bad"),
        # 阶段2-1：错误四桶占比（同一 review 可落多桶；n=0 时为 None）
        "bucket_wrong_target_pct": _pct(sum(1 for r in reviews_list if r.get("wrong_target")), n),
        "bucket_wrong_action_pct": _pct(sum(1 for r in reviews_list if r.get("wrong_action")), n),
        "bucket_over_scope_pct": _pct(sum(1 for r in reviews_list if r.get("over_scope")), n),
        "bucket_protocol_pct": _pct(sum(1 for r in reviews_list if r.get("protocol_drop")), n),
    }


def compute_all(events: list) -> dict:
    reviews = review_rows(events)
    accepts, unlinked = acceptance_rows(events)
    structs = structural_rows(events)
    feedbacks = feedback_rows(events)

    groups: dict = {}
    _new_bucket = lambda: {"reviews": [], "accepts": [], "structs": [], "feedbacks": []}  # noqa: E731
    for row in reviews:
        groups.setdefault((row["week"], row["model"]), _new_bucket())["reviews"].append(row)
    for row in accepts:
        groups.setdefault((row["week"], row["model"]), _new_bucket())["accepts"].append(row)
    for row in structs:
        groups.setdefault((row["week"], row["model"]), _new_bucket())["structs"].append(row)
    for row in feedbacks:
        groups.setdefault((row["week"], row["model"]), _new_bucket())["feedbacks"].append(row)

    out = {
        "overall": _metrics({"reviews": reviews, "accepts": accepts,
                             "structs": structs, "feedbacks": feedbacks}),
        "groups": {"%s %s" % key: _metrics(bucket) for key, bucket in sorted(groups.items())},
        "counts": {
            "event_files": len({e.get("_session") for e in events if e.get("_session")}),
            "events": len(events),
            "review": len(reviews),
            "applied_unlinked": unlinked,
        },
    }
    return out


def _fmt(value, suffix=""):
    if value is None:
        return "—"
    if isinstance(value, float):
        return ("%.1f" % value) + suffix
    return str(value) + suffix


def print_report(report: dict, test_excluded: int = 0) -> None:
    counts = report["counts"]

    def line(label, m):
        print("%s  n=%s  一次通过 %s · 澄清 %s · 空操作 %s · 错误 %s · 平均重试 %s 轮"
              % (label, m["reviews"], _fmt(m["first_pass_pct"], "%"),
                 _fmt(m["clarify_pct"], "%"), _fmt(m["noop_pct"], "%"),
                 _fmt(m["error_pct"], "%"), _fmt(m["avg_retry_rounds"])))
        print("      耗时 %s · est tok %s · 接受率 %s（%s 批）· 孤立节点率 %s（重放 %s 批）· 断链批 %s · 👍%s 👎%s"
              % (_fmt(m["avg_latency_ms"], "ms"), _fmt(m["avg_est_tokens"]),
                 _fmt(m["accept_ratio_pct"], "%"), m["accept_batches"],
                 _fmt(m["orphan_rate_pct"], "%"), m["replayed_batches"],
                 m["broken_edge_batches"], m["thumbs_up"], m["thumbs_down"]))
        print("      错误分桶：目标选错 %s · 动作选错 %s · 范围过大 %s · 协议丢字段 %s"
              % (_fmt(m["bucket_wrong_target_pct"], "%"),
                 _fmt(m["bucket_wrong_action_pct"], "%"),
                 _fmt(m["bucket_over_scope_pct"], "%"),
                 _fmt(m["bucket_protocol_pct"], "%")))

    print("Φ 质量记分牌  ·  会话文件 %s 个 · 事件 %s 条（review %s · 未关联 applied %s）"
          % (counts["event_files"], counts["events"], counts["review"],
             counts["applied_unlinked"]))
    if test_excluded:
        print("已排除测试流量 %s 条（env=test 或遗留 mock 模型名；--include-test 可含回）"
              % test_excluded)
    line("总体", report["overall"])
    for key, m in report["groups"].items():
        line(key, m)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Φ 质量记分牌（离线指标，零模型调用）")
    parser.add_argument("--events-dir", default=str(DEFAULT_EVENTS_DIR),
                        help="事件日志目录（默认 logs/harness_events）")
    parser.add_argument("--json", default="", help="另存结构化结果到该路径")
    parser.add_argument("--include-test", action="store_true",
                        help="把测试流量含回统计（T253：默认排除 env=test 与遗留 mock 行）")
    args = parser.parse_args(argv)
    events = load_events(args.events_dir)
    real_events, test_events = split_test_traffic(events)
    excluded = 0 if args.include_test else len(test_events)
    report = compute_all(real_events if not args.include_test else events)
    print_report(report, test_excluded=excluded)
    if args.json:
        Path(args.json).write_text(
            json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print("结构化结果已写入 " + args.json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
