"""上下文体检端点（server/context_preview.py）的单元回归。

这个模块此前是 src/server/ 里**唯一零测试覆盖**的模块（backlog D4 登记于
2026-09-27）。它自己不是业务路径，是开发调试用的「这条请求实际会发给模型什么」
的透视窗——所以它真正要守的不是"算得准"，而是两条同构性：

1. **门禁同构**：/api/context/preview 的 410 门禁必须与已退役的
   /api/models/chat（src/main.py:248 起）判在同一件事上。端点自己的注释写着
   「保证『预览里能看到』与『真实请求能发出』是同一套边界」——可这条边界此前
   **一个测试都没有**：chat 侧有（test_routes.py:360、test_profile_usage.py:141），
   preview 侧没有。改了一边忘了另一边，"预览能看见但真实发不出去"（或反过来）
   就静默成立。isCasual 那类事故的同类。

2. **组装同构**：概念地基、滚动记忆、树路径上下文块、难度后缀的挂载位置，
   必须与真实 chat 路径一致——不一致的话，"预览里没有"会被当成"没生效"。

纯函数式断言，不联网、不烧模型。
"""

import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from fastapi import HTTPException  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import context_preview as cp  # noqa: E402
from server import http_client as http_client_mod  # noqa: E402  出网口补丁单点（T163）
from server.config import LEVEL_PROMPTS  # noqa: E402
from server.prompts import MODULE_SYSTEM_PROMPT, get_system_prompt  # noqa: E402

PREVIEW = "/api/context/preview"


async def _call(**kw):
    """直接调端点函数，绕开 HTTP 层——门禁与组装逻辑都在函数体里。"""
    return await cp.preview_context(**kw)


def _http_exception_of(coro):
    try:
        import asyncio
        asyncio.run(coro)
    except HTTPException as e:
        return e
    return None


class GateIsomorphismTest(unittest.TestCase):
    """门禁必须与 /api/models/chat 判在同一件事上。"""

    def test_quick_always_410_even_with_anchor(self):
        """quick 寒暄即便带锚也 410——它是线性语义，前端通道已随线性退役。"""
        e = _http_exception_of(_call(prompt="你好", quick=1, branch_id="br_1"))
        self.assertIsNotNone(e, "带锚的 quick 也必须被拒")
        self.assertEqual(e.status_code, 410)
        self.assertIn("quick", str(e.detail))

    def test_prompt_without_anchor_410(self):
        e = _http_exception_of(_call(prompt="讲讲梯度"))
        self.assertIsNotNone(e, "无锚 prompt 必须 410（线性主聊天已退役）")
        self.assertEqual(e.status_code, 410)

    def test_anchored_prompts_pass(self):
        """三种锚各放行一次——分支 / 树路径 / 工作流。"""
        for label, kw in [
            ("branch_id", {"prompt": "追问一下", "branch_id": "br_1"}),
            ("graph_path", {"prompt": "追问一下", "graph_path": json.dumps(
                [{"kind": "answer", "timestamp": "1", "module": "physics"}])}),
            ("workflow", {"prompt": "讲讲梯度", "workflow": 1}),
        ]:
            with self.subTest(anchor=label):
                out = _run(_call(prompt=kw.pop("prompt"), **kw))
                self.assertEqual(out["count"], len(out["messages"]))
                self.assertGreaterEqual(out["count"], 2)

    def test_malformed_graph_path_is_treated_as_no_anchor(self):
        """坏掉的 graph_path JSON 退化成空 → 没有锚 → 带 prompt 必须 410。

        不能因为解析失败就把请求放过去：那是「解析出错 = 当作有权限」的经典写法。
        """
        e = _http_exception_of(_call(prompt="追问一下", graph_path="{不是 json"))
        self.assertIsNotNone(e)
        self.assertEqual(e.status_code, 410)

    def test_chat_endpoint_agrees_on_every_case(self):
        """**同一条输入，两个端点必须给出同一个判决。**

        这是本文件最要紧的一条：门禁在两边各写一份，改一边忘了另一边就会出现
        「预览说能发、真实发不出去」。逐条对拍，任何一边单独漂移都会红。
        """
        cases = [
            {"prompt": "你好", "quick": 1, "branch_id": "br_1"},          # quick+锚 → 拒
            {"prompt": "讲讲梯度"},                                        # 无锚 → 拒
            {"prompt": "追问一下", "branch_id": "br_1"},                   # 分支 → 放
            {"prompt": "追问一下", "graph_path": json.dumps(               # 树路径 → 放
                [{"kind": "answer", "timestamp": "1", "module": "physics"}])},
        ]
        for case in cases:
            with self.subTest(case=sorted(case)):
                preview_rejects = _http_exception_of(_call(**case)) is not None
                chat_rejects = self._chat_rejects(case)
                self.assertEqual(
                    preview_rejects, chat_rejects,
                    "两个端点对同一输入判决不一致：preview 拒=%s，chat 拒=%s"
                    % (preview_rejects, chat_rejects))

    def _chat_rejects(self, case):
        """问 /api/models/chat 同样的输入会不会被门禁挡下。

        真的打一次 HTTP，但**必须把出网口堵死**：门禁在组装消息之后、触网之前，
        放行的用例会一路走到上游代理去。真等网络超时要 15 秒 × 若干用例，一个
        单元测试跑出半分钟，还平白依赖外网。这里把 httpx 客户端换成立刻抛错的
        假货——于是「不是 410」就等价于「过了门禁」，且不触网。
        """
        import httpx

        class _DeadClient:
            async def send(self, *a, **kw):
                raise httpx.ConnectError("测试里堵死出网口")

            async def aclose(self):
                return None

        payload = dict(case)
        if "graph_path" in payload and isinstance(payload["graph_path"], str):
            payload["graph_path"] = json.loads(payload["graph_path"])
        payload.setdefault("provider", "openai")
        payload.setdefault("api_key", "test-key")
        payload.setdefault("model", "test-model")
        client = TestClient(main_mod.app)
        # T163 起 chat 路由经 http_client 模块属性出网，打 server.http_client
        # 单点即对全部出网通道生效（main_mod 死绑定坑已随拆分消除）。
        with mock.patch.object(http_client_mod, "get_http_client", lambda: _DeadClient()):
            try:
                resp = client.post("/api/models/chat", json=payload)
            except Exception:
                # 异常从流式生成器里冒出来 = 请求已经过了门禁、死在出网那一步。
                # 门禁拒绝的定义只有一个：HTTP 410。别把下游炸了当成门禁拒了——
                # 第一版正是这么写的，于是「放行」的两条被误判成「拒绝」而红。
                return False
        return resp.status_code == 410


class AssemblyTest(unittest.TestCase):
    """组装口径：system 底座、难度后缀、上下文块挂载位置。"""

    def test_workflow_uses_module_system_prompt(self):
        out = _run(_call(prompt="讲讲梯度", workflow=1))
        self.assertEqual(out["messages"][0]["content"], MODULE_SYSTEM_PROMPT)

    def test_non_workflow_uses_level_system_prompt(self):
        out = _run(_call(prompt="讲讲梯度", branch_id="br_1"))
        self.assertEqual(out["messages"][0]["content"], get_system_prompt())

    def test_level_suffix_lands_on_last_user_message(self):
        """难度后缀挂在末条 user 消息尾部——前缀缓存要求易变部分一律不进 system。"""
        for level, suffix in LEVEL_PROMPTS.items():
            with self.subTest(level=level):
                out = _run(_call(prompt="讲讲梯度", branch_id="br_1", level=level))
                last = out["messages"][-1]
                self.assertEqual(last["role"], "user")
                self.assertTrue(last["content"].endswith(suffix),
                                "难度后缀没落在末条 user 消息尾部")

    def test_unknown_level_falls_back_to_university(self):
        out = _run(_call(prompt="讲讲梯度", branch_id="br_1", level="不存在的难度"))
        self.assertTrue(out["messages"][-1]["content"].endswith(
            LEVEL_PROMPTS["university"]))

    def test_first_message_is_always_system(self):
        out = _run(_call(prompt="讲讲梯度", branch_id="br_1"))
        self.assertEqual(out["messages"][0]["role"], "system")

    def test_token_estimate_is_positive_and_budget_reported(self):
        out = _run(_call(prompt="讲讲梯度", branch_id="br_1"))
        self.assertGreater(out["est_tokens"], 0)
        self.assertGreater(out["budget_tokens"], 0)
        self.assertEqual(out["over_budget"], out["est_tokens"] > out["budget_tokens"])
        self.assertEqual(out["total_chars"], sum(
            len(str(m.get("content") or "")) for m in out["messages"]))

    def test_context_blocks_land_in_last_user_message_not_system(self):
        """易变注入（概念地基 / 滚动记忆 / 树路径块）一律进末条 user 消息。

        2026-09-21 拍板：记忆不许 insert 进历史第 0 位，每 8 轮全灭一次缓存。
        这里钉的是「它们没出现在 system 里」——比逐个断言哪个块出现了更抗改动。
        """
        with mock.patch.object(cp.concept_mod, "concept_context_text",
                               return_value="【概念地基】占位"), \
             mock.patch.object(cp.context_mod, "rolling_memory_block",
                               return_value="【记忆】占位"):
            out = _run(_call(prompt="讲讲梯度", session_id="sess_x", branch_id="br_1"))
        system = out["messages"][0]["content"]
        self.assertNotIn("占位", system, "易变注入漏进了 system —— 会打断前缀缓存")
        last = out["messages"][-1]["content"]
        self.assertIn("<上下文>", last)
        self.assertIn("</上下文>", last)
        self.assertTrue(last.rstrip().endswith(
            LEVEL_PROMPTS["university"]), "上下文块把难度后缀挤到了中间")


def _run(coro):
    import asyncio
    return asyncio.run(coro)


if __name__ == "__main__":
    unittest.main()
