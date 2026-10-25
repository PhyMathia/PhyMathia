"""节点工坊 C3（2026-10-25）：/workshop/critic 内容初筛——清洗、降级、路由、红线。

边界（拍板，docs/dev/harness.md C3 节）：
- critic **无工具**：_call_model 不带 tools、json_mode 纯文本评分（与 /workshop/step
  的「代理＋工具表」职责分开）；
- 坏回包降级不是报错：模型没回合法 JSON／verdict 不认识 → warn＋score:-1＋
  「这次评分没拿到」，主流程不因 critic 挂掉而断；HarnessError（传输层）才 502；
- 清洗：issues ≤5 条只留 {kind,detail}、score 钳到 [0,10]、say 只留第一行；
- 提示词红线：「结构问题不归你管」「拿不准就降级 warn，不许硬判 fail」；
- usage 落 workshop_critic 桶；错误协议 400/502 与 /workshop/step 同款。
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

from harness import api as api_mod
from harness import prompts as prompts_mod
from harness import workshop_critic as critic_mod
from harness.review import HarnessError

MODEL = {"provider": "opencode", "model": "m", "base_url": "https://opencode.ai/zen/v1", "api_key": ""}


def _run(payload=None, content=None, output="第一步 研究\n取物块为研究对象。\n第二步 方程\n$mg\\sin\\theta=ma$。",
         seen=None, **kwargs):
    """假 _call_model：返回给定 JSON / 原文，记录入参（tools/json_mode/messages）。"""

    async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                   json_mode=False, on_delta=None):
        if seen is not None:
            seen.append({
                "messages": json.loads(json.dumps(messages, ensure_ascii=False)),
                "tools": tools,
                "tool_choice": tool_choice,
                "json_mode": json_mode,
                "max_tokens": max_tokens,
            })
        text = content if content is not None else json.dumps(payload, ensure_ascii=False)
        return {"content": text, "tool_calls": []}

    with mock.patch.object(critic_mod, "_call_model", new=fake), \
            mock.patch.object(critic_mod, "_resolve_model", new=lambda model: dict(MODEL)):
        return asyncio.run(critic_mod.workshop_critic_call(output=output, model=dict(MODEL), **kwargs))


class CriticPromptTest(unittest.TestCase):
    """提示词红线：只管内容、结构不归它管、拿不准必须降级。"""

    def test_prompt_red_lines(self):
        prompt = prompts_mod.HARNESS_WORKSHOP_CRITIC_SYSTEM_PROMPT
        for phrase in (
            "结构问题不归你管",          # 结构体检已做过，别重复报形式问题
            "拿不准就降级 warn",          # 宁可漏报不许冤枉
            "不许硬判 fail",             # fail 只留给明确硬伤
            "初筛不是终审",              # 定位：初筛
            "verdict", "score", "issues", "say",   # JSON 契约字段写明
            "空话",                      # 四个内容维度在场（答问/硬伤/空话/深度）
            "深度",
        ):
            self.assertIn(phrase, prompt, f"critic 提示词缺红线/要素「{phrase}」")
        self.assertNotIn("一定对", prompt, "critic 提示词不许出现「一定对」类许愿")

    def test_prompt_anchor_distinct_from_draft(self):
        # mock 剧本⑬的锚「内容初筛」必须只在 critic 提示词里（草稿/循环提示词不带）
        self.assertIn("内容初筛", prompts_mod.HARNESS_WORKSHOP_CRITIC_SYSTEM_PROMPT)
        self.assertNotIn("内容初筛", prompts_mod.HARNESS_RECIPE_DRAFT_SYSTEM_PROMPT)
        self.assertNotIn("内容初筛", prompts_mod.HARNESS_WORKSHOP_AGENT_SYSTEM_PROMPT)


class CriticCallTest(unittest.TestCase):
    """调用层：无工具、json_mode、系统提示词顶前、入参截断。"""

    def test_no_tools_json_mode_and_prompt_prepended(self):
        seen = []
        result = _run(payload={"verdict": "pass", "score": 9, "issues": [], "say": "没问题"},
                      recipe_name="受力分析", materials_summary="质量 m 的物块放在斜面上", seen=seen)
        self.assertEqual(result["verdict"], "pass")
        self.assertEqual(len(seen), 1)
        # critic 不许带工具：tools/tool_choice 都不传
        self.assertIsNone(seen[0]["tools"])
        self.assertIsNone(seen[0]["tool_choice"])
        self.assertTrue(seen[0]["json_mode"])
        # 服务端固定系统提示词第一条；user 带配方名/材料摘要/输出全文
        roles = [item["role"] for item in seen[0]["messages"]]
        self.assertEqual(roles, ["system", "user"])
        self.assertEqual(seen[0]["messages"][0]["content"], prompts_mod.HARNESS_WORKSHOP_CRITIC_SYSTEM_PROMPT)
        user_text = seen[0]["messages"][1]["content"]
        for needle in ("受力分析", "质量 m 的物块放在斜面上", "取物块为研究对象"):
            self.assertIn(needle, user_text, f"critic user 消息没带「{needle}」")

    def test_max_tokens_default_and_ceiling(self):
        seen = []
        _run(payload={"verdict": "pass"}, seen=seen)
        self.assertEqual(seen[-1]["max_tokens"], critic_mod.WORKSHOP_CRITIC_MAX_TOKENS)
        _run(payload={"verdict": "pass"}, seen=seen, max_tokens=99999)
        self.assertEqual(seen[-1]["max_tokens"], critic_mod.WORKSHOP_CRITIC_TOKENS_CEILING)
        _run(payload={"verdict": "pass"}, seen=seen, max_tokens="abc")
        self.assertEqual(seen[-1]["max_tokens"], critic_mod.WORKSHOP_CRITIC_MAX_TOKENS)

    def test_empty_output_degrades_without_model_call(self):
        async def fail_call(*args, **kwargs):
            raise AssertionError("空输出不该发起模型调用")

        with mock.patch.object(critic_mod, "_call_model", new=fail_call), \
                mock.patch.object(critic_mod, "_resolve_model", new=lambda model: dict(MODEL)):
            result = asyncio.run(critic_mod.workshop_critic_call(output="   ", model=dict(MODEL)))
        self.assertEqual(result, critic_mod._degrade_result())


class CriticCleanTest(unittest.TestCase):
    """回包清洗：好回包规整、坏 JSON/坏 verdict 降级、issues 截断、score 钳制。"""

    def test_good_reply_cleaned(self):
        result = _run(payload={
            "verdict": "fail", "score": 3,
            "issues": [
                {"kind": "硬伤", "detail": "第二步公式记错了", "extra": "剥掉我"},
                {"detail": "没回答材料里的追问"},                       # kind 缺省补「问题」
                "不是字典",                                              # 坏形状跳过
                {"kind": "空话", "detail": ""},                          # 空 detail 跳过
            ],
            "say": "第一行人话\n第二行不该出现",
        })
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["verdict"], "fail")
        self.assertEqual(result["score"], 3)
        self.assertEqual(result["issues"], [
            {"kind": "硬伤", "detail": "第二步公式记错了"},
            {"kind": "问题", "detail": "没回答材料里的追问"},
        ])
        self.assertEqual(result["say"], "第一行人话")

    def test_bad_json_degrades(self):
        result = _run(content="模型这次说了一堆人话但就是没有 JSON")
        self.assertEqual(result, critic_mod._degrade_result())
        self.assertEqual(result["score"], -1)
        # verdict 不认识（中文/瞎拼）同样降级，不许 500
        result = _run(payload={"verdict": "通过", "score": 9, "issues": [], "say": "好"})
        self.assertEqual(result, critic_mod._degrade_result())

    def test_issues_truncated_to_five(self):
        issues = [{"kind": f"问题{i}", "detail": f"第 {i} 处"} for i in range(1, 9)]
        result = _run(payload={"verdict": "warn", "score": 5, "issues": issues, "say": "一般"})
        self.assertEqual(len(result["issues"]), critic_mod.WORKSHOP_CRITIC_ISSUES_MAX)
        self.assertEqual(result["issues"][0]["kind"], "问题1")
        self.assertEqual(result["issues"][-1]["kind"], "问题5")

    def test_score_clamped_and_non_numeric(self):
        self.assertEqual(_run(payload={"verdict": "pass", "score": 99})["score"], 10)
        self.assertEqual(_run(payload={"verdict": "warn", "score": -8})["score"], 0)
        self.assertEqual(_run(payload={"verdict": "pass", "score": "8.6"})["score"], 9)
        self.assertEqual(_run(payload={"verdict": "pass", "score": "abc"})["score"], 0)

    def test_say_fallback_by_verdict(self):
        # 模型没给 say：按判决补一句人话，不许空串
        self.assertEqual(_run(payload={"verdict": "pass", "score": 9, "issues": []})["say"], "内容初筛：未发现问题")
        self.assertEqual(_run(payload={"verdict": "fail", "score": 2,
                                       "issues": [{"kind": "硬伤", "detail": "x"}]})["say"],
                         "内容初筛：发现 1 处问题")

    def test_harness_error_propagates(self):
        # 传输层故障不是降级能兜的：照常上抛走 502 协议
        async def fail_call(*args, **kwargs):
            raise HarnessError("上游挂了")

        with mock.patch.object(critic_mod, "_call_model", new=fail_call), \
                mock.patch.object(critic_mod, "_resolve_model", new=lambda model: dict(MODEL)):
            with self.assertRaises(HarnessError):
                asyncio.run(critic_mod.workshop_critic_call(output="有输出", model=dict(MODEL)))


class CriticRouteTest(unittest.TestCase):
    """/workshop/critic 路由：注册、400/502、200＋usage 记 workshop_critic 桶。"""

    @classmethod
    def setUpClass(cls):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        app.include_router(api_mod.router, prefix="/api/harness")
        cls.client = TestClient(app)

    def test_route_registered(self):
        paths = {getattr(route, "path", "") for route in api_mod.router.routes}
        self.assertTrue(any(str(p).endswith("/workshop/critic") for p in paths),
                        f"POST /workshop/critic 路由丢了，实际注册：{sorted(paths)[:8]}…")

    def test_bad_json_is_400(self):
        resp = self.client.post("/api/harness/workshop/critic", content="不是 json",
                                headers={"Content-Type": "application/json"})
        self.assertEqual(resp.status_code, 400)
        self.assertEqual(resp.json()["status"], "error")

    def test_ok_and_usage_logged(self):
        usage = []

        async def fake_call(output, recipe_name="", materials_summary="", model=None,
                            thinking="", max_tokens=None):
            return {"status": "ok", "verdict": "pass", "score": 9, "issues": [], "say": "未发现问题"}

        with mock.patch.object(api_mod, "_log_usage", new=usage.append), \
                mock.patch.object(critic_mod, "workshop_critic_call", new=fake_call):
            resp = self.client.post("/api/harness/workshop/critic", json={
                "model": MODEL,
                "output": "第一步 …",
                "recipe_name": "受力分析",
                "materials_summary": "斜面物块",
            })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["verdict"], "pass")
        self.assertEqual(body["score"], 9)
        self.assertEqual(len(usage), 1)
        self.assertEqual(usage[0]["endpoint"], "workshop_critic")

    def test_upstream_error_is_502_with_usage(self):
        usage = []

        async def fake_call(output, recipe_name="", materials_summary="", model=None,
                            thinking="", max_tokens=None):
            raise HarnessError("上游挂了")

        with mock.patch.object(api_mod, "_log_usage", new=usage.append), \
                mock.patch.object(critic_mod, "workshop_critic_call", new=fake_call):
            resp = self.client.post("/api/harness/workshop/critic", json={
                "model": MODEL,
                "output": "第一步 …",
            })
        self.assertEqual(resp.status_code, 502)
        self.assertIn("上游挂了", resp.json()["errors"][0]["reason"])
        self.assertEqual(usage[0]["endpoint"], "workshop_critic")

    def test_degraded_reply_is_200_not_error(self):
        # 坏回包降级是业务结果（200＋score:-1），不是报错——主流程不断
        usage = []

        async def fake_call(output, recipe_name="", materials_summary="", model=None,
                            thinking="", max_tokens=None):
            return critic_mod._degrade_result()

        with mock.patch.object(api_mod, "_log_usage", new=usage.append), \
                mock.patch.object(critic_mod, "workshop_critic_call", new=fake_call):
            resp = self.client.post("/api/harness/workshop/critic", json={
                "model": MODEL,
                "output": "第一步 …",
            })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["verdict"], "warn")
        self.assertEqual(resp.json()["score"], -1)
        self.assertEqual(usage[0]["endpoint"], "workshop_critic")


if __name__ == "__main__":
    unittest.main()
