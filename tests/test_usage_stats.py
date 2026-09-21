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
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import usage_stats  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
