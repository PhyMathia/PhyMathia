"""节点工坊草稿协议（2026-10-20，创造模式重做 P1/P2）回归。

覆盖：
- deep_merge：字典递归、数组整体替换、null 删键；
- flatten_recipe / changed_fields：标量路径、对象数组按下标展开（「只改第二个出口」
  能被前端精确高亮）、增删两侧都算改动；
- draft_recipe（假 _call_model）：
  · 补丁式合并——模型只回一个字段时其余字段原样保留（T79 的洞）；
  · mode=draft 忽略传入草稿，从零起稿；
  · 归一化失败（名字空）保留上一版草稿并把错误挂到 name；
  · 校验错误（提示词槽超预算）折算成 generate.prompt 路径；
  · 模型不返 JSON → status=error + retry，草稿不丢；
  · 只回一句话（无 recipe）→ 原样保留草稿、changed 为空；
  · 归一化不认的键 → warnings 里点出来，不静默吞；
- question 清洗（最多一个、文本截断）与 say 只留第一行。
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

from harness import recipe_draft as draft_mod
from harness.recipe_draft import changed_fields, deep_merge, flatten_recipe

MODEL = {"provider": "opencode", "model": "m", "base_url": "https://opencode.ai/zen/v1", "api_key": ""}

BASE = {
    "name": "受力分析",
    "desc": "拆对象、列方程",
    "base": {"kind": "module"},
    "appearance": {"palette": "amber"},
    "generate": {"prompt": "输出受力分析步骤"},
    "ports": {
        "static": [{"label": "步骤", "drag_form": "draft"}, {"label": "检查", "drag_form": "draft"}],
        "inputs": [{"label": "题目", "type": "text"}],
    },
    "content_kind": "markdown",
}


def _fake_llm(payload, content=None, seen=None):
    """假 _call_model：返回给定 JSON / 原文，并记录入参。"""

    async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                   json_mode=False, on_delta=None):
        if seen is not None:
            seen.append({
                "messages": json.loads(json.dumps(messages, ensure_ascii=False)),
                "json_mode": json_mode,
                "max_tokens": max_tokens,
            })
        text = content if content is not None else json.dumps(payload, ensure_ascii=False)
        return {"content": text, "tool_calls": []}

    return fake


def _run(payload=None, content=None, draft=None, mode="patch", seen=None, **kwargs):
    fake = _fake_llm(payload, content, seen)
    with mock.patch.object(draft_mod, "_call_model", new=fake), \
            mock.patch.object(draft_mod, "_resolve_model", new=lambda model: dict(MODEL)):
        return asyncio.run(draft_mod.draft_recipe(
            instruction=kwargs.pop("instruction", "做一个受力分析节点"),
            draft=draft,
            model=dict(MODEL),
            mode=mode,
            **kwargs,
        ))


class DeepMergeTest(unittest.TestCase):
    def test_dicts_merge_arrays_replace_null_deletes(self):
        base = {"a": {"b": 1, "c": 2}, "ports": {"static": [{"label": "x"}]}}
        patch = {"a": {"c": None, "b": 3}, "ports": {"static": [{"label": "y"}, {"label": "z"}]}}
        merged = deep_merge(base, patch)
        self.assertEqual(merged["a"], {"b": 3}, "null 应删键、缺失键保留")
        self.assertEqual([item["label"] for item in merged["ports"]["static"]], ["y", "z"], "数组应整体替换")
        self.assertEqual(base["a"], {"b": 1, "c": 2}, "不得原地改基底")

    def test_non_dict_patch_wins(self):
        self.assertEqual(deep_merge({"a": 1}, 5), 5)


class ChangedFieldsTest(unittest.TestCase):
    def test_element_level_paths(self):
        before = {"name": "甲", "ports": {"static": [{"label": "步骤"}, {"label": "检查"}]}}
        after = {"name": "甲", "ports": {"static": [{"label": "步骤"}, {"label": "再测一道"}]}}
        self.assertEqual(changed_fields(before, after), ["ports.static[1].label"])

    def test_added_and_removed_count(self):
        before = {"name": "甲", "ports": {"inputs": [{"label": "题目"}]}}
        after = {"name": "乙", "ports": {"inputs": [{"label": "题目"}, {"label": "图示"}]}}
        paths = changed_fields(before, after)
        self.assertIn("name", paths)
        self.assertIn("ports.inputs[1].label", paths)

    def test_unchanged_is_empty(self):
        self.assertEqual(changed_fields(BASE, json.loads(json.dumps(BASE))), [])

    def test_flatten_keeps_scalar_arrays_whole(self):
        flat = flatten_recipe({"ports": {"dynamic": {"parser": {"level_tags": ["基础", "进阶"]}}}})
        self.assertIn("ports.dynamic.parser.level_tags", flat)


class DraftRecipeTest(unittest.TestCase):
    def test_patch_keeps_unmentioned_fields(self):
        patch = {"recipe": {"ports": {"static": [{"label": "步骤"}, {"label": "再测一道"}]}},
                 "say": "第二个出口改名了"}
        out = _run(patch, draft=dict(BASE))
        self.assertEqual(out["status"], "ok")
        self.assertEqual([p["label"] for p in out["recipe"]["ports"]["static"]], ["步骤", "再测一道"])
        # 补丁没提的字段必须一字不动（这才是「补丁式」的意义）
        self.assertEqual(out["recipe"]["generate"]["prompt"], "输出受力分析步骤")
        self.assertEqual(out["recipe"]["ports"]["inputs"], [{"label": "题目", "type": "text"}])
        self.assertEqual(out["changed"], ["ports.static[1].label"])
        self.assertEqual(out["say"], "第二个出口改名了")

    def test_draft_mode_ignores_incoming_draft(self):
        patch = {"recipe": {"name": "错题复盘", "base": {"kind": "module"},
                            "generate": {"prompt": "输出错因"}, "ports": {"static": [{"label": "错因"}]}}}
        out = _run(patch, draft=dict(BASE), mode="draft")
        self.assertEqual(out["recipe"]["name"], "错题复盘")
        self.assertEqual(out["recipe"]["ports"]["static"], [{"label": "错因", "drag_form": "draft"}])

    def test_invalid_name_keeps_previous_draft(self):
        out = _run({"recipe": {"name": ""}, "say": "改了"}, draft=dict(BASE))
        self.assertEqual(out["status"], "error")
        self.assertEqual(out["recipe"]["name"], "受力分析", "非法补丁不得毁掉上一版草稿")
        self.assertEqual(out["field_errors"][0]["field"], "name")

    def test_validation_error_maps_to_field(self):
        long_prompt = "很长" * 500   # 1000 字，超 800 预算（归一化上限 1600，能活到校验器）
        out = _run({"recipe": {"generate": {"prompt": long_prompt}}}, draft=dict(BASE))
        self.assertEqual(out["status"], "ok")
        self.assertFalse(out["field_errors"] == [])
        self.assertEqual(out["field_errors"][0]["field"], "generate.prompt")
        self.assertIn("generate.prompt", out["changed"])

    def test_non_json_reply_is_retryable_and_keeps_draft(self):
        out = _run(content="我先说说思路：", draft=dict(BASE))
        self.assertEqual(out["status"], "error")
        self.assertTrue(out["retry"])
        self.assertEqual(out["recipe"]["name"], "受力分析")

    def test_say_only_reply_keeps_draft(self):
        out = _run({"say": "光有题目还不够，要几个出口？"}, draft=dict(BASE))
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["changed"], [])
        self.assertEqual(out["recipe"]["name"], "受力分析")

    def test_dropped_keys_warn(self):
        out = _run({"recipe": {"name": "受力分析", "bogus_field": 1}}, draft=dict(BASE))
        self.assertEqual(out["status"], "ok")
        self.assertTrue(any("bogus_field" in item for item in out["warnings"]))

    def test_question_is_sanitized(self):
        out = _run({"recipe": {"desc": "拆分"}, "question": {"field": "ports.inputs", "text": "喂什么材料？"}},
                   draft=dict(BASE))
        self.assertEqual(out["question"], {"field": "ports.inputs", "text": "喂什么材料？"})
        out2 = _run({"recipe": {"desc": "拆分"}, "question": {"field": "x", "text": "问" * 400}},
                    draft=dict(BASE))
        self.assertEqual(len(out2["question"]["text"]), draft_mod.QUESTION_TEXT_MAX)

    def test_say_collapses_to_first_line(self):
        out = _run({"recipe": {"desc": "拆分"}, "say": "改好了\n以下是 JSON：{...}"}, draft=dict(BASE))
        self.assertEqual(out["say"], "改好了")

    def test_request_carries_draft_and_history(self):
        seen = []
        _run({"recipe": {"desc": "拆分"}}, draft=dict(BASE), seen=seen,
             history=[{"role": "me", "text": "要一个受力分析节点"}, {"role": "phi", "text": "先画个初稿"}])
        user_text = seen[0]["messages"][1]["content"]
        self.assertIn("受力分析", user_text, "补丁模式必须把当前草稿喂给模型")
        self.assertIn("要一个受力分析节点", user_text)
        self.assertTrue(seen[0]["json_mode"], "草稿通道固定走 JSON 模式")

    def test_duplicate_name_reported(self):
        out = _run({"recipe": {"desc": "拆分"}}, draft=dict(BASE),
                   user_recipes=[{"id": "other", "name": "受力分析"}])
        fields = [item["field"] for item in out["field_errors"]]
        self.assertIn("name", fields)


if __name__ == "__main__":
    unittest.main()
