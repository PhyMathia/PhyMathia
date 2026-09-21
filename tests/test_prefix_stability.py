"""前缀稳定性回归（prompt cache 改造的核心契约）。

ZCode 的 prompt-trajectory 思路：把「相邻两次请求的消息数组只做尾部变化」
固化为测试。本项目是全量重建形态，做不到严格 append-only，但改造后的契约是：
- system 只含场景底座，逐轮易变注入集中在末条 user 消息的 <上下文> 块；
- 相邻两轮的历史区，除「最老全文轮降级为摘要对」这一次性形变外，前缀字节一致；
- 同一状态重复组装字节全同；viz 折叠判定锚定触发提问，不随当前提问翻转；
- 会话记忆出现在末条 user 消息里，绝不落在 system 或历史区。
"""

import asyncio
import json
import os
import sys
import unittest
from unittest import mock

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from server import context as context_mod  # noqa: E402
import main as main_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402
from test_routes import RouteTestBase  # noqa: E402


def _rounds(n, prefix="round"):
    """n 轮 (user, assistant) 消息，时间戳递增。"""
    msgs = []
    ts = 0
    for i in range(n):
        ts += 1
        msgs.append({"role": "user", "content": f"{prefix}_{i}_user 提问内容", "timestamp": ts})
        ts += 1
        msgs.append({"role": "assistant", "content": f"{prefix}_{i}_assistant 回答内容", "timestamp": ts})
    return msgs


def _digest_end(messages):
    """历史列表里摘要区（（更早对话）标记）的结束位置（不含）。"""
    end = 0
    for i, m in enumerate(messages):
        if str(m.get("content") or "").startswith("（更早对话）"):
            end = i + 1
    return end


class PrefixStabilityContextTest(unittest.TestCase):
    """context 层：相邻两轮、重复组装、viz 粘性、尾部保护。"""

    def setUp(self):
        self._orig_load = context_mod._load_messages
        self._orig_read_mem = context_mod._read_rolling_memory
        context_mod._read_rolling_memory = lambda sid: {"summary": "旧记忆", "messageCount": 10}

    def tearDown(self):
        context_mod._load_messages = self._orig_load
        context_mod._read_rolling_memory = self._orig_read_mem

    def test_stable_prefix_across_consecutive_turns(self):
        """第 N+1 轮的历史数组必须保留第 N 轮的摘要区前缀字节不变。"""
        messages = _rounds(6)
        context_mod._load_messages = lambda sid: messages
        turn_t = context_mod._load_session_context("s", max_rounds=3, current_prompt="第7轮提问")
        # 第 7 轮真的发生：尾部追加一轮
        messages.extend(_rounds(1, prefix="round"))
        turn_t1 = context_mod._load_session_context("s", max_rounds=3, current_prompt="第8轮提问")

        stable = _digest_end(turn_t)
        self.assertTrue(stable > 0, "precondition: 6 轮会话应已有摘要区")
        self.assertEqual(turn_t1[:stable], turn_t[:stable],
                         "摘要区前缀字节在相邻两轮之间发生了改写")

    def test_same_state_renders_identical_bytes(self):
        messages = _rounds(8)
        context_mod._load_messages = lambda sid: messages
        a = context_mod._load_session_context("s", max_rounds=3, current_prompt="同一提问")
        b = context_mod._load_session_context("s", max_rounds=3, current_prompt="同一提问")
        self.assertEqual(a, b)

    def test_full_zone_demotion_is_the_only_in_zone_change(self):
        """逐轮对比：轮到轮之间除摘要区增长/最老全文轮降级外，全文区消息字节不变。"""
        messages = _rounds(5)
        context_mod._load_messages = lambda sid: messages
        prev = context_mod._load_session_context("s", max_rounds=3, current_prompt="p")
        for _ in range(3):
            messages.extend(_rounds(1, prefix="round"))
            nxt = context_mod._load_session_context("s", max_rounds=3, current_prompt="p")
            stable = _digest_end(prev)
            self.assertEqual(nxt[:stable], prev[:stable])
            prev = nxt

    def test_viz_rendering_pinned_to_trigger_prompt(self):
        big_viz = ("<viz><html>" + "<div>x</div>" * 3000 + "</html></viz>")
        messages = [
            {"role": "user", "content": "给我做一个弹簧振动可视化", "timestamp": 1},
            {"role": "assistant", "content": "讲解" + big_viz, "timestamp": 2},
            {"role": "user", "content": "接下来讲讲阻尼", "timestamp": 3},
        ]
        # 触发提问要可视化，当前提问不要 → 保留摘要形态
        keep = context_mod._recent_context_messages(messages, 3, False, current_prompt="接下来讲讲阻尼")
        # 触发提问要可视化，当前提问也要 → 同一字节（旧实现会随当前提问翻转）
        keep2 = context_mod._recent_context_messages(messages, 3, False, current_prompt="这个图里动画怎么看")
        self.assertEqual(keep, keep2)
        self.assertTrue(any("[交互可视化摘要]" in str(m.get("content")) for m in keep))
        # 触发提问不要可视化 → 占位符，且当前提问再想看也不翻转历史形态
        plain = [
            {"role": "user", "content": "讲讲弹簧", "timestamp": 1},
            {"role": "assistant", "content": "讲解" + big_viz, "timestamp": 2},
            {"role": "user", "content": "接下来讲讲阻尼", "timestamp": 3},
        ]
        out = context_mod._recent_context_messages(plain, 3, False, current_prompt="做个可视化看看")
        self.assertTrue(any(context_mod.VIZ_PLACEHOLDER in str(m.get("content")) for m in out))

    def test_budget_shrink_never_sacrifices_last_full_message(self):
        big = "物" * 4000
        messages = [
            {"role": "user", "content": "请解释", "timestamp": 1},
            {"role": "assistant", "content": big, "timestamp": 2},
        ]
        out = context_mod._recent_context_messages(messages, 3, False, current_prompt="p", budget_tokens=100)
        self.assertTrue(out and str(out[-1].get("content")) == big,
                        "最后一条完整消息被预算收缩牺牲：" + str([len(str(m.get('content'))) for m in out]))


class AssemblyShapeTest(RouteTestBase):
    """端到端：system 干净、易变注入集中末条 user 消息、记忆不进历史区。"""

    def _post_chat(self, payload, handler):
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(main_mod, "get_http_client", return_value=client):
            base = {
                "prompt": "什么是电磁感应",
                "level": "university",
                "provider": "deepseek",
                "api_key": "sk-test",
                "model": "test-model",
                "stream": False,
            }
            base.update(payload)
            return self.client.post("/api/models/chat", json=base)

    def test_volatile_injections_live_in_tail_user_message(self):
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        with mock.patch.object(context_mod, "_read_rolling_memory",
                               return_value={"summary": "之前聊过法拉第", "messageCount": 2}):
            resp = self._post_chat({"device_id": "dev-tail", "session_id": "s_tail"}, handler)
        self.assertEqual(resp.status_code, 200)
        messages = seen["body"]["messages"]
        self.assertEqual(messages[0]["role"], "system")
        system_text = str(messages[0].get("content") or "")
        self.assertNotIn("（会话记忆）", system_text, "记忆不应出现在 system")
        self.assertNotIn("<上下文>", system_text)

        tail = messages[-1]
        self.assertEqual(tail["role"], "user")
        tail_text = str(tail.get("content") or "")
        self.assertTrue(tail_text.startswith("<上下文>"), "易变注入应集中到末条 user 消息头部")
        self.assertIn("（会话记忆）之前聊过法拉第", tail_text)
        self.assertIn("什么是电磁感应", tail_text)

        # 历史区（system 与末条 user 之间）不得出现记忆
        for m in messages[1:-1]:
            self.assertNotIn("（会话记忆）", str(m.get("content") or ""))


class BucketHeaderTest(RouteTestBase):
    """辅助调用分桶：session_bucket 白名单消毒后用作 x-opencode-session。"""

    def _post(self, bucket):
        seen = {}

        def handler(request):
            seen["headers"] = dict(request.headers)
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        payload = {
            "messages": [{"role": "user", "content": "hello"}],
            "provider": "opencode-go",
            "base_url": "https://opencode.ai/zen/go/v1",
            "api_key": "stage0-fake-key",
            "model": "test-model",
            "stream": False,
        }
        if bucket is not None:
            payload["session_bucket"] = bucket
        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(main_mod, "get_http_client", return_value=client):
            resp = self.client.post("/api/models/chat", json=payload)
        self.assertEqual(resp.status_code, 200)
        return seen["headers"].get("x-opencode-session")

    def test_valid_bucket_reaches_gateway_header(self):
        self.assertEqual(self._post("phymathia-quiz"), "phymathia-quiz")

    def test_invalid_bucket_falls_back_to_anonymous(self):
        self.assertEqual(self._post("bad bucket!"), "phymathia-anonymous")

    def test_missing_bucket_falls_back_to_anonymous(self):
        self.assertEqual(self._post(None), "phymathia-anonymous")


if __name__ == "__main__":
    unittest.main()
