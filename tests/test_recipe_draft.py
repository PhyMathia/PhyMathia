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

from harness import prompts as prompts_mod
from harness import recipe_draft as draft_mod
from harness import recipes as recipes_mod
from harness.recipe_draft import changed_fields, deep_merge, flatten_recipe
from harness.recipe_templates import RECIPE_TEMPLATES, pick_template, template_catalog
from harness.recipes import normalize_recipe_input, validate_recipe

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
        # 指令刻意不命中任何模板（B 起 draft 模式会先挑模板，这里保住「纯从零」的原语义）
        out = _run(patch, draft=dict(BASE), mode="draft", instruction="造一个整理课堂便签的节点")
        self.assertEqual(out["recipe"]["name"], "错题复盘")
        self.assertEqual(out["recipe"]["ports"]["static"], [{"label": "错因", "drag_form": "draft"}])
        self.assertEqual(out["template"], "")

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


class CapabilitiesReflectionTest(unittest.TestCase):
    """B：能力反射——端点与草稿提示词都从 recipes.py 常量派生，不许手抄第二份。"""

    def test_capabilities_mirror_schema_constants(self):
        caps = recipes_mod.recipe_capabilities()
        self.assertEqual(caps["base_kinds"]["all"], list(recipes_mod.RECIPE_BASE_KINDS))
        self.assertEqual(caps["base_kinds"]["ai"], list(recipes_mod.RECIPE_AI_BASE_KINDS))
        self.assertEqual(caps["palettes"], list(recipes_mod.RECIPE_PALETTE_KEYS))
        self.assertEqual(caps["shapes"], list(recipes_mod.RECIPE_SHAPES), "T408：能力清单缺 shapes")
        self.assertEqual(caps["port_types"], list(recipes_mod.RECIPE_PORT_TYPES))
        self.assertEqual(caps["content_kinds"], list(recipes_mod.RECIPE_CONTENT_KINDS))
        self.assertEqual(caps["dynamic"]["base_kinds"], list(recipes_mod.RECIPE_DYNAMIC_BASE_KINDS),
                         "T408：动态出口底座必须是反射，不许手抄 [\"module\"]")
        self.assertEqual(caps["dynamic"]["patterns"], list(recipes_mod.RECIPE_PARSER_PATTERNS))
        self.assertEqual(caps["dynamic"]["port_types"], list(recipes_mod.RECIPE_DYNAMIC_PORT_TYPES))
        self.assertEqual(caps["on_generated"]["kinds"], list(recipes_mod.RECIPE_ON_GENERATED_KINDS))
        self.assertEqual(caps["limits"]["prompt"], recipes_mod.RECIPE_PROMPT_BUDGET)
        self.assertEqual(caps["limits"]["name"], recipes_mod.RECIPE_NAME_MAX)
        self.assertEqual(caps["limits"]["ports"], recipes_mod.RECIPE_MAX_PORTS)
        # T408：缺省值从归一化真正用的常量/函数取，不许字面量各说各话
        self.assertEqual(caps["defaults"]["palette"], recipes_mod.RECIPE_DEFAULT_PALETTE)
        self.assertEqual(caps["defaults"]["content_kind"], recipes_mod.RECIPE_DEFAULT_CONTENT_KIND)
        self.assertEqual(caps["defaults"]["context_channel"], recipes_mod.RECIPE_DEFAULT_CONTEXT_CHANNEL)
        self.assertEqual(caps["defaults"]["model_role"], recipes_mod.RECIPE_DEFAULT_MODEL_ROLE)
        self.assertEqual(caps["defaults"]["aggregation"],
                         {"ai_base": "ancestors", "manual_base": "none"})
        normalized = normalize_recipe_input({"name": "甲", "base": {"kind": "module"}})
        self.assertEqual(normalized["appearance"]["palette"], caps["defaults"]["palette"],
                         "清单报的默认色板必须就是归一化落库的那个")
        self.assertEqual(normalized["content_kind"], caps["defaults"]["content_kind"])
        self.assertEqual(normalized["generate"]["model_role"], caps["defaults"]["model_role"])
        self.assertEqual(normalized["generate"]["context_channel"], caps["defaults"]["context_channel"])

    def test_draft_prompt_carries_every_enum(self):
        # 提示词是插值生成的，但守护仍要钉死：schema 加了枚举值没跟文案，当场红
        prompt = prompts_mod.HARNESS_RECIPE_DRAFT_SYSTEM_PROMPT
        values = (
            recipes_mod.RECIPE_BASE_KINDS + recipes_mod.RECIPE_AI_BASE_KINDS
            + recipes_mod.RECIPE_PALETTE_KEYS + recipes_mod.RECIPE_CONTENT_KINDS
            + recipes_mod.RECIPE_PORT_TYPES + recipes_mod.RECIPE_MODEL_ROLES
            + recipes_mod.RECIPE_CONTEXT_CHANNELS + recipes_mod.RECIPE_AGGREGATIONS
            + recipes_mod.RECIPE_PARSER_PATTERNS + recipes_mod.RECIPE_LABEL_FROM
            + recipes_mod.RECIPE_FALLBACK_MODES + recipes_mod.RECIPE_DYNAMIC_PORT_TYPES
            + recipes_mod.RECIPE_SHAPES + recipes_mod.RECIPE_ON_GENERATED_KINDS
            + tuple(v for v in recipes_mod.RECIPE_ON_GENERATED_CONTENT_FROM if v)
        )
        for value in values:
            self.assertIn(value, prompt, f"枚举「{value}」没进草稿提示词——加枚举忘了跟文案")
        for number in (recipes_mod.RECIPE_PROMPT_BUDGET, recipes_mod.RECIPE_MAX_DYNAMIC,
                       recipes_mod.RECIPE_NAME_MAX, recipes_mod.RECIPE_MAX_INPUTS):
            self.assertIn(str(number), prompt)

    def test_capabilities_endpoint_route_registered(self):
        # C 的工具层与前端查能力的口：路由删了这里先红
        from harness import api as api_mod

        paths = {getattr(route, "path", "") for route in api_mod.router.routes}
        self.assertTrue(
            any(str(path).endswith("/recipe/capabilities") for path in paths),
            f"GET /recipe/capabilities 路由丢了，实际注册：{sorted(paths)[:8]}…",
        )


class TemplateLibraryTest(unittest.TestCase):
    """B：模板库——全量合法（schema 演进的守护）、确定性命中、补丁模式不挑模板。"""

    def test_all_templates_normalize_and_validate(self):
        self.assertTrue(8 <= len(RECIPE_TEMPLATES) <= 12, "模板库约定 8~12 份")
        for item in RECIPE_TEMPLATES:
            normalized = normalize_recipe_input(item["recipe"])
            self.assertIsNotNone(normalized, f"模板 {item['key']} 连归一化都过不了")
            verdict = validate_recipe(normalized)
            self.assertTrue(verdict["ok"], f"模板 {item['key']} 校验失败：{verdict['errors']}")
            self.assertNotIn("id", item["recipe"], "模板不许带固定 id（每次起稿生成新 id，草稿互不串）")
            self.assertTrue(item.get("keywords"), f"模板 {item['key']} 没配检索关键词")
            self.assertTrue(item.get("strong"), f"模板 {item['key']} 没配强关键词（单强关键词放行靠它，T407）")

    def test_pick_template_hits(self):
        cases = [
            ("做一个错题复盘节点，喂我做错的题和当时的答案", "mistake_review"),
            ("想要受力分析：喂题目和受力图，吐方程", "force_analysis"),
            ("来一个考我的苏格拉底追问节点", "socratic_ask"),
            ("做一个可视化的流程图节点", "viz_diagram"),
            ("帮我做个分步解题的助手", "step_by_step"),
            # T407：口语单关键词——强关键词单独出现也要够门槛
            ("做个错题节点", "mistake_review"),
            ("画个流程图", "viz_diagram"),
            ("背公式", "formula_cards"),
            ("考考我", "socratic_ask"),
            ("检查单位", "dimension_check"),
            ("这道题我不会，能解题就行", "step_by_step"),
            ("动能和动量分不清", "concept_contrast"),
        ]
        for text, key in cases:
            picked = pick_template(text)
            self.assertIsNotNone(picked, f"「{text}」应命中模板")
            self.assertEqual(picked["key"], key, f"「{text}」应命中 {key}，实际 {picked['key']}")

    def test_pick_template_threshold_and_empty(self):
        # 只中一个弱关键词：宁可从零起草也不错配底稿（强关键词单独出现才放行）
        self.assertIsNone(pick_template("这道题有点马虎"))
        self.assertIsNone(pick_template("随便来一个节点"))
        self.assertIsNone(pick_template(""))

    def test_draft_mode_builds_on_matched_template(self):
        seen = []
        payload = {"recipe": {"name": "我的错题本"}, "say": "在模板上改名了"}
        out = _run(payload, mode="draft",
                   instruction="做一个错题复盘节点，喂做错的题", seen=seen)
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["template"], "错题复盘")
        self.assertEqual(out["recipe"]["name"], "我的错题本")
        # 模型没提到的字段原样来自模板底稿（这正是「不从白纸写」的意义）
        self.assertEqual([p["label"] for p in out["recipe"]["ports"]["inputs"]], ["题目", "我的答案"])
        self.assertEqual([p["label"] for p in out["recipe"]["ports"]["static"]], ["错因", "正确思路", "同类题眼"])
        # 模型收到的是「模板底稿＋补丁口径」，不再是「从零起草」
        user_text = seen[0]["messages"][1]["content"]
        self.assertIn("模板", user_text)
        self.assertIn("错题复盘", user_text)
        self.assertNotIn("从零起草", user_text)
        # changed 只报模型改的字段，模板基底自身不算改动
        self.assertEqual(out["changed"], ["name"])

    def test_draft_mode_dedupes_name_against_existing(self):
        # T406：弱模型沿用模板名撞用户已有配方——服务端加序号兜底，不再落「已有同名配方」红灯
        payload = {"recipe": {"desc": "喂做错的题，拆错因"}, "say": "按模板起了底稿"}
        out = _run(payload, mode="draft",
                   instruction="做一个错题复盘节点，喂我做错的题",
                   user_recipes=[{"id": "r1", "name": "错题复盘"}])
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["recipe"]["name"], "错题复盘2")
        self.assertEqual(out["field_errors"], [])
        self.assertTrue(any("错题复盘2" in w for w in out["warnings"]), out["warnings"])
        self.assertIn("name", out["changed"], "自动改名要算进 changed，前端高亮名字")
        # 序号顺延：2 也被占了就取 3
        out2 = _run(payload, mode="draft",
                    instruction="做一个错题复盘节点，喂我做错的题",
                    user_recipes=[{"id": "r1", "name": "错题复盘"}, {"id": "r2", "name": "错题复盘2"}])
        self.assertEqual(out2["recipe"]["name"], "错题复盘3")

    def test_draft_from_zero_also_dedupes(self):
        # T406 不只保模板起稿：从零起稿撞名同样兜底
        payload = {"recipe": {"name": "便签整理", "base": {"kind": "note"}}, "say": "手填底稿来了"}
        out = _run(payload, mode="draft", instruction="造一个整理课堂便签的节点",
                   user_recipes=[{"id": "r1", "name": "便签整理"}])
        self.assertEqual(out["status"], "ok")
        self.assertEqual(out["recipe"]["name"], "便签整理2")

    def test_patch_mode_keeps_duplicate_error(self):
        # 补丁模式是用户自己的草稿：重名照实报 field_error，不许服务端擅改名（T406 边界）
        patch = {"recipe": {"desc": "拆对象、列方程"}, "say": "改了描述"}
        out = _run(patch, draft=dict(BASE),
                   user_recipes=[{"id": "other", "name": "受力分析"}])
        self.assertEqual(out["recipe"]["name"], "受力分析")
        fields = [item["field"] for item in out["field_errors"]]
        self.assertIn("name", fields)

    def test_draft_mode_without_match_stays_from_zero(self):
        seen = []
        payload = {"recipe": {"name": "便签整理", "base": {"kind": "note"}}, "say": "手填底稿来了"}
        out = _run(payload, mode="draft",
                   instruction="造一个整理课堂便签的节点", seen=seen)
        self.assertEqual(out["template"], "")
        self.assertIn("从零起草", seen[0]["messages"][1]["content"])
        self.assertEqual(out["recipe"]["name"], "便签整理")

    def test_patch_mode_never_picks_template(self):
        seen = []
        payload = {"recipe": {"desc": "拆对象、列方程"}, "say": "改了描述"}
        out = _run(payload, draft=dict(BASE), mode="patch",
                   instruction="做一个错题复盘节点", seen=seen)
        self.assertEqual(out["template"], "")
        # 用户当前草稿（受力分析）才是基底，不许被模板顶掉
        self.assertIn("受力分析", seen[0]["messages"][1]["content"])
        self.assertEqual(out["recipe"]["name"], "受力分析")

    def test_template_catalog_is_lightweight(self):
        entries = template_catalog()
        self.assertEqual(len(entries), len(RECIPE_TEMPLATES))
        for entry in entries:
            self.assertNotIn("recipe", entry, "目录不许带配方正文（端点载荷要轻）")
            self.assertTrue(entry["key"] and entry["label"] and entry["keywords"])


if __name__ == "__main__":
    unittest.main()
