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


class RecordUsageTest(UsageStatsBase):
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

    def test_empty_dir_structure(self):
        out = usage_stats.summarize(days=7)
        self.assertEqual(out["series"], {})
        self.assertEqual(out["kinds"], {})


if __name__ == "__main__":
    unittest.main()
