"""usage_stats（token 用量与缓存命中计量）的单元回归。

前缀缓存改造第一步的观测底座：解析三家兼容的命中字段、JSONL 落盘、
按天/模型汇总命中率。USAGE_DIR 指向临时目录（与 test_kv_split 同口径）。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (ROOT, os.path.join(ROOT, "src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from server import usage_stats  # noqa: E402


class UsageStatsBase(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self._orig_dir = usage_stats.USAGE_DIR
        usage_stats.USAGE_DIR = Path(self._td.name)

    def tearDown(self):
        usage_stats.USAGE_DIR = self._orig_dir
        self._td.cleanup()


class ParseUsageTest(UsageStatsBase):
    def test_deepseek_form(self):
        parsed = usage_stats.parse_usage({
            "prompt_tokens": 100, "completion_tokens": 20,
            "prompt_cache_hit_tokens": 80, "prompt_cache_miss_tokens": 20,
        })
        self.assertEqual(parsed, {"prompt_tokens": 100, "completion_tokens": 20, "cache_hit_tokens": 80})

    def test_openai_form(self):
        parsed = usage_stats.parse_usage({
            "prompt_tokens": 100, "completion_tokens": 20,
            "prompt_tokens_details": {"cached_tokens": 64},
        })
        self.assertEqual(parsed["cache_hit_tokens"], 64)

    def test_anthropic_form(self):
        parsed = usage_stats.parse_usage({
            "prompt_tokens": 100, "cache_read_input_tokens": 96,
        })
        self.assertEqual(parsed["cache_hit_tokens"], 96)

    def test_no_hit_field_is_none(self):
        parsed = usage_stats.parse_usage({"prompt_tokens": 10, "completion_tokens": 5})
        self.assertIsNone(parsed["cache_hit_tokens"])

    def test_garbage(self):
        self.assertIsNone(usage_stats.parse_usage(None))
        self.assertIsNone(usage_stats.parse_usage("usage"))
        # dict 但字段全不可解析：返回全 None，由 record_usage 负责跳过不落盘
        self.assertEqual(
            usage_stats.parse_usage({"prompt_tokens": "abc"}),
            {"prompt_tokens": None, "completion_tokens": None, "cache_hit_tokens": None},
        )
        self.assertIsNone(usage_stats.record_usage("deepseek", "m", "chat", "", {"prompt_tokens": "abc"}))


class WorkflowStatsTagTest(UsageStatsBase):
    """2026-10-14 T326：工作流运行级标签（前端 wfStats → 记账 wf 键 → 面板波列）。

    消毒口径、record_usage/record_failure 的入键开关、summarize records 的
    透出三格各钉一条；旧调用不传 wf 不带键，旧记录/旧面板零影响。
    """

    def test_normalize_wf_passes_and_filters(self):
        good = {"run": "wf-lz1a2b-3cd", "node": "n1234567890", "wave": 2, "hash": "xyz8a7b"}
        self.assertEqual(usage_stats.normalize_wf(good), good)
        # wave 数字字符串可转；布尔不当整数（True 不能当 1 波）
        self.assertEqual(usage_stats.normalize_wf({"wave": "3"}), {"wave": 3})
        self.assertEqual(usage_stats.normalize_wf({"run": "wf-1", "wave": True}), {"run": "wf-1"})
        # 非 dict / 空 / 无合法字段 → None（调用方据此不带 wf 键）
        self.assertIsNone(usage_stats.normalize_wf(None))
        self.assertIsNone(usage_stats.normalize_wf("wf-x"))
        self.assertIsNone(usage_stats.normalize_wf({}))
        # 无任何合法字段 → None；有合法字段时只留合法键
        self.assertIsNone(usage_stats.normalize_wf({"wave": "NaN"}))
        self.assertEqual(usage_stats.normalize_wf({"run": "ok", "wave": "NaN"}), {"run": "ok"})
        # 白名单外字符/超长丢键（run 65 字符出局、hash 64 字符保留）
        self.assertEqual(usage_stats.normalize_wf({"run": "wf-1", "node": "bad node!"}), {"run": "wf-1"})
        self.assertEqual(usage_stats.normalize_wf({"run": "x" * 65, "hash": "h" * 64}), {"hash": "h" * 64})
        # wave 越界/非数丢键，其余键照常
        self.assertEqual(usage_stats.normalize_wf({"run": "wf-1", "wave": "-1"}), {"run": "wf-1"})
        self.assertEqual(usage_stats.normalize_wf({"run": "wf-1", "wave": 100}), {"run": "wf-1"})

    def test_record_usage_carries_wf_when_present(self):
        entry = usage_stats.record_usage(
            "deepseek", "m", "chat", "s1", {"prompt_tokens": 10, "completion_tokens": 1},
            wf={"run": "wf-lz1a2b-3cd", "node": "n1234567890", "wave": 2, "hash": "xyz8a7b"})
        self.assertEqual(entry["wf"],
                         {"run": "wf-lz1a2b-3cd", "node": "n1234567890", "wave": 2, "hash": "xyz8a7b"})
        # 不传 wf 不带键（旧调用方零影响）
        plain = usage_stats.record_usage("deepseek", "m", "chat", "s1",
                                         {"prompt_tokens": 10, "completion_tokens": 1})
        self.assertNotIn("wf", plain)

    def test_record_failure_carries_wf(self):
        entry = usage_stats.record_failure("deepseek", "m", "chat", "s1", "boom",
                                           wf={"run": "wf-x1", "wave": 3})
        self.assertEqual(entry["wf"], {"run": "wf-x1", "wave": 3})
        self.assertNotIn("wf", usage_stats.record_failure("deepseek", "m", "chat", "s1", "boom"))

    def test_summarize_records_exposes_wf(self):
        usage_stats.record_usage("deepseek", "m", "chat", "s1",
                                 {"prompt_tokens": 10, "completion_tokens": 1},
                                 wf={"run": "wf-lz1a2b-3cd", "node": "n1234567890", "wave": 1})
        out = usage_stats.summarize(days=30, records=10)
        self.assertEqual(len(out["records"]), 1)
        self.assertEqual(out["records"][0]["wf"]["node"], "n1234567890")
        self.assertEqual(out["records"][0]["wf"]["wave"], 1)
    def test_writes_jsonl_line(self):
        entry = usage_stats.record_usage("deepseek", "deepseek-chat", "chat", "sess_1", {
            "prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 80,
        })
        self.assertIsNotNone(entry)
        files = list(usage_stats.USAGE_DIR.glob("*.jsonl"))
        self.assertEqual(len(files), 1)
        line = json.loads(files[0].read_text(encoding="utf-8").strip())
        self.assertEqual(line["kind"], "chat")
        self.assertEqual(line["sessionId"], "sess_1")
        self.assertEqual(line["cache_hit_tokens"], 80)
        self.assertIn("ts", line)

    def test_skips_when_no_tokens(self):
        self.assertIsNone(usage_stats.record_usage("deepseek", "m", "chat", "", {"usage": True}))
        self.assertIsNone(usage_stats.record_usage("deepseek", "m", "chat", "", None))
        self.assertEqual(list(usage_stats.USAGE_DIR.glob("*.jsonl")), [])

    def test_appends_across_calls(self):
        usage_stats.record_usage("deepseek", "m", "chat", "s1", {"prompt_tokens": 10, "completion_tokens": 1})
        usage_stats.record_usage("deepseek", "m", "summary", "s1", {"prompt_tokens": 30, "completion_tokens": 2})
        lines = list(usage_stats.USAGE_DIR.glob("*.jsonl"))[0].read_text(encoding="utf-8").strip().splitlines()
        self.assertEqual(len(lines), 2)


class WorkflowRunAggregationTest(UsageStatsBase):
    """2026-10-14 T327：summarize 的 wfRuns（按 wf.run 的轮次聚合）。

    每轮一行：nodes/waves 去重计数、requests 含失败、cachedTokens≈预计省；
    最近活跃倒序、封顶 50 轮；非工作流调用与缺 run/run 不合白名单不进。
    """

    def _write(self, day, entries):
        usage_stats.USAGE_DIR.mkdir(parents=True, exist_ok=True)
        path = usage_stats.USAGE_DIR / f"{day}.jsonl"
        path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")

    def test_groups_by_run_with_nodes_waves_and_failures(self):
        today = "2099-01-01"
        self._write(today, [
            # 本轮：3 个节点、2 波（wave 0/1）、1 次失败＋2 次成功，命中两笔
            {"ts": f"{today}T10:00:00", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": 50,
             "wf": {"run": "wf-aaa", "node": "n1", "wave": 0}},
            {"ts": f"{today}T10:00:30", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 200, "completion_tokens": 20, "cache_hit_tokens": 120,
             "wf": {"run": "wf-aaa", "node": "n2", "wave": 0}},
            # 同节点重试算两次调用但只计一个节点；失败计次不计 token
            {"ts": f"{today}T10:01:00", "kind": "chat", "model": "a", "status": "error",
             "prompt_tokens": None, "completion_tokens": None, "cache_hit_tokens": None,
             "error": "boom", "wf": {"run": "wf-aaa", "node": "n2", "wave": 1}},
            # 另一轮：更晚，倒序应排在前
            {"ts": f"{today}T11:00:00", "kind": "chat", "model": "b", "status": "ok",
             "prompt_tokens": 40, "completion_tokens": 5, "cache_hit_tokens": None,
             "wf": {"run": "wf-bbb", "node": "n9", "wave": 0}},
            # 非工作流调用不进 wfRuns
            {"ts": f"{today}T12:00:00", "kind": "harness", "model": "b", "status": "ok",
             "prompt_tokens": 7, "completion_tokens": 1, "cache_hit_tokens": None},
        ])
        out = usage_stats.summarize(days=30)
        runs = out["wfRuns"]
        self.assertEqual(list(runs), ["wf-bbb", "wf-aaa"], "按最近活跃时间倒序（新→旧）")
        a, b = runs["wf-aaa"], runs["wf-bbb"]
        self.assertEqual([a["nodes"], a["waves"], a["requests"], a["errorRequests"]], [2, 2, 3, 1])
        self.assertEqual(a["promptTokens"], 300)
        self.assertEqual(a["totalTokens"], 330)
        self.assertEqual(a["cachedTokens"], 170)
        self.assertEqual(a["hitKnownRequests"], 2)
        self.assertEqual(a["hitRate"], round(170 / 300, 4))
        self.assertEqual([a["firstTs"], a["lastTs"]],
                         [f"{today}T10:00:00", f"{today}T10:01:00"])
        self.assertEqual([b["nodes"], b["requests"]], [1, 1])
        self.assertEqual(b["cachedTokens"], 0)
        # 上游不报缓存字段：hitKnownRequests=0（面板据此显 —，不拿 0% 冒充
        # 「零命中」）；hitRate 沿袭 _agg_finalize 口径＝0.0
        self.assertEqual(b["hitKnownRequests"], 0)
        self.assertEqual(b["hitRate"], 0.0)
        # 聚合桶与既有桶同构（requests/errorRequests/…/hitRate/avgDurationMs 都在）
        for key in ("requests", "errorRequests", "promptTokens", "completionTokens",
                    "totalTokens", "cachedTokens", "hitKnownRequests", "hitRate", "avgDurationMs"):
            self.assertIn(key, a)

    def test_entries_without_valid_run_excluded(self):
        today = "2099-01-02"
        self._write(today, [
            # 无 wf 键（非工作流调用）
            {"ts": f"{today}T10:00:00", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 10, "completion_tokens": 1},
            # wf 缺 run / run 非白名单形状（直接落盘的脏 key）
            {"ts": f"{today}T10:00:01", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 10, "completion_tokens": 1, "wf": {"node": "n1"}},
            {"ts": f"{today}T10:00:02", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 10, "completion_tokens": 1, "wf": {"run": "bad run!", "node": "n1"}},
            {"ts": f"{today}T10:00:03", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 10, "completion_tokens": 1, "wf": "wf-x"},
        ])
        out = usage_stats.summarize(days=30)
        self.assertEqual(out["wfRuns"], {})
        self.assertEqual(out["total"]["requests"], 4)

    def test_run_limit_and_window(self):
        # 窗口外（旧日子）的轮不进；窗口内封顶 50 轮、留最新的
        self._write("2000-01-01", [
            {"ts": "2000-01-01T10:00:00", "kind": "chat", "model": "a", "status": "ok",
             "prompt_tokens": 1, "completion_tokens": 1, "wf": {"run": "wf-old", "node": "n0"}},
        ])
        today = "2099-01-03"
        entries = []
        for i in range(55):
            entries.append({"ts": f"{today}T{10 + i // 60:02d}:{i % 60:02d}:00",
                            "kind": "chat", "model": "a", "status": "ok",
                            "prompt_tokens": 1, "completion_tokens": 1,
                            "wf": {"run": f"wf-cap-{i:02d}", "node": f"n{i}"}})
        self._write(today, entries)
        out = usage_stats.summarize(days=30)
        runs = out["wfRuns"]
        self.assertEqual(len(runs), usage_stats._WF_RUN_LIMIT)
        self.assertLessEqual(len(runs), 50)
        self.assertNotIn("wf-old", runs, "窗口外的轮不进")
        # ts 递升 → 最新的是 cap-54、最旧被截掉的是 cap-00
        self.assertIn("wf-cap-54", runs)
        self.assertNotIn("wf-cap-00", runs)
        self.assertEqual(list(runs)[0], "wf-cap-54", "第一条应是最新轮")


class FailureAndDurationTest(UsageStatsBase):
    """2026-10-08 补的两维：失败进账（record_failure → errorRequests）＋请求耗时
    （durationMs → avgDurationMs）；旧格式记录（无 status/durationMs 字段）按
    「成功、无耗时」兼容读取，既有口径不受影响。"""

    def _write(self, day, entries):
        usage_stats.USAGE_DIR.mkdir(parents=True, exist_ok=True)
        path = usage_stats.USAGE_DIR / f"{day}.jsonl"
        path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")

    def test_record_failure_writes_error_entry(self):
        entry = usage_stats.record_failure("deepseek", "m", "chat", "s1",
                                           "HTTP 429: rate limited", duration_ms=1234)
        self.assertEqual(entry["status"], "error")
        self.assertEqual(entry["error"], "HTTP 429: rate limited")
        self.assertEqual(entry["durationMs"], 1234)
        self.assertIsNone(entry["prompt_tokens"])
        self.assertIsNone(entry["completion_tokens"])
        self.assertIsNone(entry["cache_hit_tokens"])
        line = json.loads(list(usage_stats.USAGE_DIR.glob("*.jsonl"))[0]
                          .read_text(encoding="utf-8").strip())
        self.assertEqual(line["kind"], "chat")
        self.assertEqual(line["sessionId"], "s1")

    def test_record_failure_sanitizes_and_defaults(self):
        # error 截断到 200 字符；None 兜底 unknown；非法 duration 归 None
        entry = usage_stats.record_failure("p", "m", "chat", "", "x" * 500)
        self.assertEqual(len(entry["error"]), 200)
        self.assertEqual(usage_stats.record_failure("p", "m", "chat", "", None)["error"], "unknown")
        self.assertIsNone(
            usage_stats.record_failure("p", "m", "chat", "", "boom", duration_ms="abc")["durationMs"])

    def test_record_usage_carries_status_and_duration(self):
        entry = usage_stats.record_usage("deepseek", "m", "chat", "",
                                         {"prompt_tokens": 10, "completion_tokens": 1}, duration_ms=250)
        self.assertEqual(entry["status"], "ok")
        self.assertEqual(entry["durationMs"], 250)
        no_dur = usage_stats.record_usage("deepseek", "m", "chat", "",
                                          {"prompt_tokens": 10, "completion_tokens": 1})
        self.assertIsNone(no_dur["durationMs"])

    def test_failure_detail_appends_upstream_body(self):
        # T302：raise_for_status 型异常把上游拒绝原因（响应体）拼进错误串，
        # 与 chat 主链路「HTTP {status}: {body}」同口径
        req = httpx.Request("POST", "http://upstream/v1/chat/completions")
        resp = httpx.Response(400, request=req, text='{"error":"invalid api key"}')
        exc = httpx.HTTPStatusError("Client error '400 Bad Request'", request=req, response=resp)
        detail = usage_stats.failure_detail(exc)
        self.assertIn("HTTP 400", detail)
        self.assertIn("invalid api key", detail)

    def test_failure_detail_falls_back_to_str(self):
        # 无响应对象（连接/超时/解析类）退回 str(e)；空串退类型名
        self.assertEqual(usage_stats.failure_detail(ValueError("boom")), "boom")
        self.assertEqual(usage_stats.failure_detail(ValueError("")), "ValueError")

    def test_summarize_counts_errors_and_avg_duration(self):
        today = "2099-01-01"
        self._write(today, [
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "status": "ok", "durationMs": 1000,
             "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": None},
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "status": "ok", "durationMs": 3000,
             "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": None},
            # 失败调用：计次不计 token；本条不带 durationMs，也不进均值
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "status": "error", "error": "HTTP 502",
             "prompt_tokens": None, "completion_tokens": None, "cache_hit_tokens": None},
            # 旧格式记录：无 status/durationMs ＝成功、无耗时
            {"ts": "t", "kind": "chat", "provider": "p", "model": "b", "sessionId": "",
             "prompt_tokens": 40, "completion_tokens": 5, "cache_hit_tokens": None},
        ])
        out = usage_stats.summarize(days=30)
        total = out["total"]
        self.assertEqual(total["requests"], 4)  # 失败也计次
        self.assertEqual(total["errorRequests"], 1)
        self.assertEqual(total["durationKnown"], 2)
        self.assertEqual(total["avgDurationMs"], 2000)
        self.assertEqual(total["promptTokens"], 240)  # 失败不污染 token 口径
        self.assertEqual(total["totalTokens"], 265)
        self.assertEqual(out["models"]["a"]["requests"], 3)
        self.assertEqual(out["models"]["a"]["errorRequests"], 1)
        self.assertEqual(out["models"]["a"]["avgDurationMs"], 2000)
        self.assertEqual(out["models"]["b"]["errorRequests"], 0)
        self.assertIsNone(out["models"]["b"]["avgDurationMs"])
        self.assertEqual(out["days"][today]["errorRequests"], 1)
        self.assertEqual(out["series"][today]["a"]["requests"], 3)
        self.assertEqual(out["kinds"]["chat"]["errorRequests"], 1)


class SessionDimensionTest(UsageStatsBase):
    """T197 会话维度：summarize(session=…) 按 sessionId 精确聚合一桶回读
    （前端「本次会话消耗」卡的数据源）。"""

    def _write(self, day, entries):
        usage_stats.USAGE_DIR.mkdir(parents=True, exist_ok=True)
        path = usage_stats.USAGE_DIR / f"{day}.jsonl"
        path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")

    def test_session_bucket_aggregates_matching_only(self):
        today = "2099-01-10"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "status": "ok", "prompt_tokens": 100, "completion_tokens": 10, "durationMs": 500},
            # 别的画布（s2）不进 s1 的账
            {"ts": f"{today}T10:00:01", "kind": "chat", "provider": "p", "model": "b", "sessionId": "s2",
             "status": "ok", "prompt_tokens": 50, "completion_tokens": 5},
            # 无会话上下文的内部调用（知识提取/描述等落空串）不入会话账
            {"ts": f"{today}T10:00:02", "kind": "extract", "provider": "p", "model": "a", "sessionId": "",
             "status": "ok", "prompt_tokens": 7, "completion_tokens": 1},
            # 失败调用也归会话（计次不计 token）；带 durationMs 的记录进均值
            {"ts": f"{today}T10:00:03", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "status": "error", "error": "boom", "prompt_tokens": None, "completion_tokens": None,
             "durationMs": 100},
            # T288 脏记录（model=primary）主循环跳过，会话桶一并跳过
            {"ts": f"{today}T10:00:04", "kind": "chat", "provider": "p", "model": "primary", "sessionId": "s1",
             "status": "ok", "prompt_tokens": 999, "completion_tokens": 999},
        ])
        out = usage_stats.summarize(days=30, session="s1")
        cur = out["currentSession"]
        self.assertEqual(cur["requests"], 2)
        self.assertEqual(cur["errorRequests"], 1)
        self.assertEqual(cur["promptTokens"], 100)
        self.assertEqual(cur["completionTokens"], 10)
        self.assertEqual(cur["totalTokens"], 110)
        self.assertEqual(cur["avgDurationMs"], 300)
        # 全局桶不受 session 参数影响（口径互不污染）
        self.assertEqual(out["total"]["totalTokens"], 173)
        # 聚合桶与既有桶同构
        for key in ("requests", "errorRequests", "promptTokens", "completionTokens",
                    "totalTokens", "cachedTokens", "hitKnownRequests", "hitRate", "avgDurationMs"):
            self.assertIn(key, cur)

    def test_session_unset_none_and_zero_bucket_distinction(self):
        today = "2099-01-11"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "status": "ok", "prompt_tokens": 10, "completion_tokens": 1},
        ])
        # 未传/空串/None → currentSession 为 None（前端不渲染卡，旧调用方零影响）
        self.assertIsNone(usage_stats.summarize(days=30)["currentSession"])
        self.assertIsNone(usage_stats.summarize(days=30, session="")["currentSession"])
        self.assertIsNone(usage_stats.summarize(days=30, session=None)["currentSession"])
        # 传了但范围内无匹配 → requests=0 的桶（前端显「还没有调用」而非藏卡）
        out = usage_stats.summarize(days=30, session="nope")
        self.assertEqual(out["currentSession"]["requests"], 0)
        self.assertEqual(out["currentSession"]["totalTokens"], 0)

    def test_session_respects_day_window(self):
        # 范围外（旧日子）的同会话调用不计入
        self._write("2000-01-01", [
            {"ts": "2000-01-01T10:00:00", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "status": "ok", "prompt_tokens": 500, "completion_tokens": 50},
        ])
        today = "2099-01-12"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "status": "ok", "prompt_tokens": 10, "completion_tokens": 1},
        ])
        out = usage_stats.summarize(days=30, session="s1")
        self.assertEqual(out["currentSession"]["totalTokens"], 11)
        self.assertEqual(out["currentSession"]["requests"], 1)


class DefaultDirTest(unittest.TestCase):
    def test_default_dir_is_repo_root_data_usage(self):
        # 2026-10-08 拨回仓库根 data/usage（与 config.py DATA_DIR 同口径）：
        # 非 frozen 时＝src/../data/usage，防止再被带歪到包内
        d = usage_stats._default_usage_dir()
        expected = Path(usage_stats.__file__).resolve().parents[2] / "data" / "usage"
        self.assertEqual(d, expected)


class SummarizeTest(UsageStatsBase):
    def _write(self, day, entries):
        usage_stats.USAGE_DIR.mkdir(parents=True, exist_ok=True)
        path = usage_stats.USAGE_DIR / f"{day}.jsonl"
        path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")

    def test_aggregates_by_day_and_model(self):
        today = "2099-01-01"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "deepseek", "model": "a",
             "sessionId": "s", "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": 50},
            {"ts": f"{today}T11:00:00", "kind": "chat", "provider": "deepseek", "model": "a",
             "sessionId": "s", "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": 100},
            {"ts": f"{today}T12:00:00", "kind": "harness", "provider": "opencode", "model": "b",
             "sessionId": "harness", "prompt_tokens": 40, "completion_tokens": 5, "cache_hit_tokens": None},
        ])
        out = usage_stats.summarize(days=30)
        total = out["total"]
        self.assertEqual(total["requests"], 3)
        self.assertEqual(total["promptTokens"], 240)
        self.assertEqual(total["cachedTokens"], 150)
        self.assertEqual(total["hitKnownRequests"], 2)
        # 命中率分母是全部已知 prompt（含不回报命中的请求），hitKnownRequests 供读数甄别
        self.assertEqual(total["hitRate"], round(150 / 240, 4))
        self.assertEqual(out["models"]["a"]["hitRate"], round(150 / 200, 4))
        self.assertEqual(out["days"][today]["requests"], 3)

    def test_days_filter_and_corrupt_lines(self):
        self._write("2099-01-01", [
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "prompt_tokens": 10, "completion_tokens": 1, "cache_hit_tokens": 0},
        ])
        self._write("2000-01-01", [
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "prompt_tokens": 999, "completion_tokens": 1, "cache_hit_tokens": 0},
        ])
        old = usage_stats.USAGE_DIR / "2000-01-01.jsonl"
        old.write_text(old.read_text(encoding="utf-8") + "{broken json}\n", encoding="utf-8")
        out = usage_stats.summarize(days=30)
        self.assertEqual(out["total"]["requests"], 1)
        self.assertEqual(out["total"]["promptTokens"], 10)

    def test_empty_dir(self):
        out = usage_stats.summarize(days=7)
        self.assertEqual(out["total"]["requests"], 0)
        self.assertIsNone(out["total"]["hitRate"])

    def test_series_kinds_and_total_tokens(self):
        # 2026-10-08 新增聚合：series（天×模型交叉，折线分线数据源）与
        # kinds（按用途聚合，条形图数据源）；totalTokens＝prompt+completion
        today = "2099-01-01"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "deepseek", "model": "a",
             "sessionId": "s", "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": 50},
            {"ts": f"{today}T11:00:00", "kind": "chat", "provider": "deepseek", "model": "a",
             "sessionId": "s", "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": 100},
            {"ts": f"{today}T12:00:00", "kind": "harness", "provider": "opencode", "model": "b",
             "sessionId": "harness", "prompt_tokens": 40, "completion_tokens": 5, "cache_hit_tokens": None},
        ])
        out = usage_stats.summarize(days=30)
        self.assertEqual(out["series"][today]["a"]["requests"], 2)
        self.assertEqual(out["series"][today]["a"]["totalTokens"], 220)
        self.assertEqual(out["series"][today]["b"]["totalTokens"], 45)
        self.assertEqual(out["kinds"]["chat"]["requests"], 2)
        self.assertEqual(out["kinds"]["chat"]["totalTokens"], 220)
        self.assertEqual(out["kinds"]["harness"]["promptTokens"], 40)
        self.assertEqual(out["total"]["totalTokens"], 265)
        # 既有三桶口径不受影响
        self.assertEqual(out["models"]["a"]["promptTokens"], 200)
        self.assertEqual(out["days"][today]["requests"], 3)

    def test_series_empty_day_and_unknown_kind(self):
        # 空目录 series/kinds 为空壳；kind 缺失/空串归入 unknown，不丢条目
        today = "2099-01-01"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "", "provider": "p", "model": "a",
             "sessionId": "", "prompt_tokens": 10, "completion_tokens": None, "cache_hit_tokens": None},
        ])
        out = usage_stats.summarize(days=30)
        self.assertEqual(out["kinds"]["unknown"]["requests"], 1)
        self.assertEqual(out["series"][today]["a"]["totalTokens"], 10)

    def test_primary_slot_records_excluded(self):
        # T288：旧 harness 记账把槽位名 "primary" 当模型名落盘（prompt_tokens=1
        # 的退化 usage，真实模型不会叫这个名字）——四桶与明细一并跳过
        today = "2099-01-01"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "harness", "provider": "opencode",
             "model": "primary", "prompt_tokens": 1, "completion_tokens": None},
            {"ts": f"{today}T10:00:05", "kind": "chat", "provider": "deepseek",
             "model": "deepseek-chat", "prompt_tokens": 100, "completion_tokens": 50},
        ])
        out = usage_stats.summarize(days=30, records=10)
        self.assertNotIn("primary", out["models"])
        self.assertNotIn("primary", out["days"][today])
        self.assertNotIn("primary", out["series"][today])
        self.assertNotIn("harness", out["kinds"])
        self.assertEqual(out["models"]["deepseek-chat"]["requests"], 1)
        self.assertEqual(out["total"]["promptTokens"], 100)
        self.assertEqual([r["model"] for r in out["records"]], ["deepseek-chat"])

    def test_empty_dir_structure(self):
        out = usage_stats.summarize(days=7)
        self.assertEqual(out["series"], {})
        self.assertEqual(out["kinds"], {})
        self.assertEqual(out["records"], [])

    def test_records_recent_desc_and_fields(self):
        # 2026-10-08 五轮 T196：records>0 附带最近 N 条明细（时间倒序，新的在前）。
        # 字段驼峰化＋totalTokens 预合计；失败行带 error、旧记录无 status 按「成功」
        today = "2099-01-01"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "status": "ok", "durationMs": 800,
             "prompt_tokens": 100, "completion_tokens": 10, "cache_hit_tokens": None},
            {"ts": f"{today}T11:00:00", "kind": "harness", "provider": "q", "model": "b", "sessionId": "s2",
             "status": "error", "error": "HTTP 502", "durationMs": 120,
             "prompt_tokens": None, "completion_tokens": None, "cache_hit_tokens": None},
            {"ts": f"{today}T12:00:00", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s3",
             "prompt_tokens": 30, "completion_tokens": 5, "cache_hit_tokens": 0},
        ])
        out = usage_stats.summarize(days=30, records=2)
        recs = out["records"]
        self.assertEqual(len(recs), 2)
        # JSONL 按写入序＝时间序，取末尾 N 条倒序：最后写入的最前
        self.assertEqual(recs[0]["ts"], f"{today}T12:00:00")
        self.assertEqual(recs[1]["ts"], f"{today}T11:00:00")
        # 旧格式记录（无 status）按成功、无耗时为 None；token 预合计
        self.assertEqual(recs[0]["status"], "ok")
        self.assertEqual(recs[0]["durationMs"], None)
        self.assertEqual(recs[0]["totalTokens"], 35)
        # 失败行：error 透传、token 全空但 totalTokens 归 0（不抛 None+None）
        self.assertEqual(recs[1]["status"], "error")
        self.assertEqual(recs[1]["error"], "HTTP 502")
        self.assertIsNone(recs[1]["promptTokens"])
        self.assertEqual(recs[1]["totalTokens"], 0)
        # T325：records 逐条带 cacheHitTokens（驼峰化）——面板「命中」列数据源；
        # 0=上游报了但零命中、None=该上游不报缓存字段（面板显 —）
        self.assertEqual(recs[0]["cacheHitTokens"], 0)
        self.assertIsNone(recs[1]["cacheHitTokens"])
        # 聚合桶口径不受 records 参数影响
        self.assertEqual(out["total"]["requests"], 3)

    def test_records_limit_bounds(self):
        # 越界入参：0/负数/垃圾值 → 不带明细（空数组）；条数不足上限时全返回
        today = "2099-01-01"
        self._write(today, [
            {"ts": f"{today}T10:00:00", "kind": "chat", "provider": "p", "model": "a",
             "sessionId": "", "prompt_tokens": 1, "completion_tokens": 1, "cache_hit_tokens": None},
        ])
        for bad in (0, -5, "abc", None):
            self.assertEqual(usage_stats.summarize(days=7, records=bad)["records"], [])
        self.assertEqual(len(usage_stats.summarize(days=7, records=500)["records"]), 1)


class ReadCacheTest(UsageStatsBase):
    """T200 读缓存（平移 T209 文件指纹法）：指纹未变的重复汇总零重读、
    追加（指纹失配）后立即反映。用 read_text 计数桩观察实际 IO 次数。"""

    def _write(self, day, entries):
        usage_stats.USAGE_DIR.mkdir(parents=True, exist_ok=True)
        path = usage_stats.USAGE_DIR / f"{day}.jsonl"
        path.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries), encoding="utf-8")

    def test_repeat_summarize_hits_cache_and_append_invalidates(self):
        from unittest import mock
        today = "2099-01-01"
        self._write(today, [
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "prompt_tokens": 10, "completion_tokens": 1, "cache_hit_tokens": None},
        ])
        path = usage_stats.USAGE_DIR / f"{today}.jsonl"
        real_read_text = Path.read_text
        with mock.patch.object(Path, "read_text", autospec=True, side_effect=real_read_text) as rt:
            out1 = usage_stats.summarize(days=30)
            self.assertEqual(out1["total"]["requests"], 1)
            self.assertEqual(rt.call_count, 1)            # 首读恰好落盘一次
            out2 = usage_stats.summarize(days=30)         # 指纹未变：零重读
            self.assertEqual(rt.call_count, 1)
            self.assertEqual(out2["total"]["requests"], 1)
            with path.open("a", encoding="utf-8") as f:   # 追加→指纹失配→恰好重读一次
                f.write(json.dumps({"ts": "t", "kind": "chat", "provider": "p", "model": "a",
                                    "sessionId": "", "prompt_tokens": 5, "completion_tokens": 1,
                                    "cache_hit_tokens": None}, ensure_ascii=False) + "\n")
            out3 = usage_stats.summarize(days=30)
            self.assertEqual(rt.call_count, 2)
            self.assertEqual(out3["total"]["requests"], 2)

    def test_corrupt_lines_skipped_consistently_across_cache(self):
        # 坏行口径走缓存前后一致：坏行不计数、不进缓存条目
        today = "2099-01-01"
        self._write(today, [
            {"ts": "t", "kind": "chat", "provider": "p", "model": "a", "sessionId": "",
             "prompt_tokens": 10, "completion_tokens": 1, "cache_hit_tokens": None},
        ])
        path = usage_stats.USAGE_DIR / f"{today}.jsonl"
        path.write_text(path.read_text(encoding="utf-8") + "{broken json}\n", encoding="utf-8")
        first = usage_stats.summarize(days=30)
        second = usage_stats.summarize(days=30)
        self.assertEqual(first["total"]["requests"], 1)
        self.assertEqual(second["total"]["requests"], 1)

    def test_shared_entries_not_mutated_by_records_view(self):
        # 明细卡（records>0）从缓存条目取值建新 dict：缓存本体绝不就地改
        today = "2099-01-01"
        self._write(today, [
            {"ts": "t1", "kind": "chat", "provider": "p", "model": "a", "sessionId": "s1",
             "prompt_tokens": 10, "completion_tokens": 1, "cache_hit_tokens": None},
        ])
        out = usage_stats.summarize(days=30, records=5)
        self.assertEqual(out["records"][0]["ts"], "t1")
        out["records"][0]["ts"] = "tampered"
        again = usage_stats.summarize(days=30, records=5)
        self.assertEqual(again["records"][0]["ts"], "t1")


if __name__ == "__main__":
    unittest.main()
