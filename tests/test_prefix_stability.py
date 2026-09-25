"""前缀稳定性回归（prompt cache 改造的核心契约）。

ZCode 的 prompt-trajectory 思路：把「相邻两次请求的消息数组只做尾部变化」
固化为测试。2026-09-25 线性主聊天退役后（现役 UI 的新话题提问全部走工作流，
旧线性装配 _recent_context_append_only/linear_active_content_block 已删，恢复
见 docs/dev/linear-chat-retired.md），契约收敛为：
- system 只含场景底座，逐轮易变注入集中在末条 user 消息的 <上下文> 块；
- 树路径历史区严格 append-only（出生定形），下钻零改写；
- active/聚焦节点全文只在尾部上下文块，绝不在历史区；
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


def _serialize(messages):
    """与探针/真机同口径的消息流序列化（前缀比对用）。"""
    return "".join(f"{m.get('role')}\n{m.get('content')}\n" for m in messages)


class PrefixStabilityContextTest(unittest.TestCase):
    """context 层：重复组装确定性、viz 粘性（旧窗口装配，quick/工作流/分支/树路径共用）。"""

    def setUp(self):
        self._orig_load = context_mod._load_messages
        self._orig_read_mem = context_mod._read_rolling_memory
        context_mod._read_rolling_memory = lambda sid: {"summary": "旧记忆", "messageCount": 10}

    def tearDown(self):
        context_mod._load_messages = self._orig_load
        context_mod._read_rolling_memory = self._orig_read_mem

    def test_same_state_renders_identical_bytes(self):
        messages = _rounds(8)
        context_mod._load_messages = lambda sid: messages
        a = context_mod._load_session_context("s", max_rounds=3, current_prompt="同一提问")
        b = context_mod._load_session_context("s", max_rounds=3, current_prompt="同一提问")
        self.assertEqual(a, b)

    def test_viz_rendering_pinned_to_trigger_prompt(self):
        big_viz = ("<viz><html>" + "<div>x</div>" * 3000 + "</html></viz>")
        messages = [
            {"role": "user", "content": "给我做一个弹簧振动可视化", "timestamp": 1},
            {"role": "assistant", "content": "讲解" + big_viz, "timestamp": 2},
            {"role": "user", "content": "接下来讲讲阻尼", "timestamp": 3},
        ]
        # 触发提问要可视化，当前提问不要 → 保留摘要形态（旧窗口装配，quick/分支/滚动记忆仍走此函数）
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


def _tree_msgs():
    """树探索夹具：根提问 + 完整卡片回答（physics 段足够长）+ 一层追问。

    u2 带 branchId/parentId 供 fallback 用例复用；主用例不传 branch_id，
    路径加载器不受这两个字段影响。
    """
    physics_full = "根物理视角正文。" + "磁通量变化在闭合回路中产生感应电动势，" * 40
    return [
        {"role": "user", "content": "什么是电磁感应", "timestamp": 1},
        {"role": "assistant", "content": (
            f"<physics>{physics_full}</physics>"
            "<math>根数学视角正文：ε = -dΦ/dt。</math>"
            "<summary>根卡片摘要：磁通变化产生电动势。</summary>"
        ), "timestamp": 2},
        {"role": "user", "content": "物理视角里磁通量怎么理解",
         "timestamp": 3, "branchId": "br1", "parentId": 2},
        {"role": "assistant", "content": (
            "<physics>子层物理正文。" + "感应电动势方向由楞次定律判定，" * 40 + "</physics>"
            "<summary>子层摘要：楞次定律判方向。</summary>"
        ), "timestamp": 4},
    ]


class TreePathPrefixStabilityTest(unittest.TestCase):
    """2026-09-24 树路径拍板：路径历史区 assistant 一律摘要（含 active 节点），
    历史区只增不改；active 全文由 tree_active_content_block 进尾部上下文块。"""

    def setUp(self):
        self._orig_load = context_mod._load_messages
        self.msgs = _tree_msgs()
        context_mod._load_messages = lambda sid: self.msgs

    def tearDown(self):
        context_mod._load_messages = self._orig_load

    @staticmethod
    def _path(depth):
        path = [
            {"kind": "user", "timestamp": 1},
            {"kind": "answer", "timestamp": 2, "module": "physics"},
        ]
        if depth >= 2:
            path += [
                {"kind": "user", "timestamp": 3},
                {"kind": "answer", "timestamp": 4, "module": "physics"},
            ]
        return path

    @staticmethod
    def _serialize(messages):
        return "".join(f"{m.get('role')}\n{m.get('content')}\n" for m in messages)

    def test_tree_drilldown_history_is_append_only(self):
        """下钻一层：历史区字节严格前缀。旧设计会把上一层从全文翻成摘要，
        该位置之后的前缀缓存全部打灭——这是本次拍板的核心契约。"""
        h1 = self._serialize(context_mod._load_session_context_from_path("s", self._path(1)))
        h2 = self._serialize(context_mod._load_session_context_from_path("s", self._path(2)))
        self.assertTrue(len(h1) > 100, "precondition: 一层路径应有实质历史区")
        self.assertTrue(h2.startswith(h1),
                        f"下钻改写了历史区前缀字节：\n h1={h1[:200]!r}\n h2={h2[:200]!r}")

    def test_tree_active_module_full_text_lives_in_tail_block(self):
        msg = self.msgs[1]["content"]
        physics_full = msg[msg.index("<physics>") + len("<physics>"):msg.index("</physics>")]
        joined = [str(m.get("content") or "") for m in
                  context_mod._load_session_context_from_path("s", self._path(1))]
        self.assertFalse(any(physics_full in c for c in joined),
                         "active 模块全文不应出现在历史区")
        block = context_mod.tree_active_content_block("s", self._path(1))
        self.assertTrue(block.startswith("# 当前节点正文（参考资料）"))
        self.assertIn(physics_full, block, "active 全文应完整进入尾部块")

    def test_tree_user_nodes_stay_full_in_history(self):
        joined = [str(m.get("content") or "") for m in
                  context_mod._load_session_context_from_path("s", self._path(2))]
        self.assertIn("什么是电磁感应", joined)
        self.assertIn("物理视角里磁通量怎么理解", joined)

    def test_tree_active_content_fallback_uses_parent_source(self):
        """active 模块抽取为空且带 branch_id 时，全文回退分支父回答
        （原 active_parent_missing 逻辑随全文一起迁入尾部块）。"""
        self.msgs[3]["content"] = "<math>只有数学段</math><summary>子层摘要</summary>"
        block = context_mod.tree_active_content_block(
            "s", self._path(2), source_module="physics", branch_id="br1")
        self.assertIn("根物理视角正文。", block, "应回退取父回答的 physics 段")
        self.assertNotIn("只有数学段", block)
        self.assertEqual(
            context_mod.tree_active_content_block("s", self._path(2)),
            "", "不带 branch_id 时无回退、返回空串")

    def test_tree_workflow_skip_upstream_keeps_only_summaries(self):
        """工作流模式：上游 assistant 跳过、active 也是摘要——全文输入改由尾部
        块提供（main.py 注入），历史区不再有需要保护的全文。"""
        h = context_mod._load_session_context_from_path(
            "s", self._path(2),
            workflow_context={"upstream": [{"label": "x", "content": "..."}]})
        joined = [str(m.get("content") or "") for m in h]
        self.assertEqual(len(h), 3, "上游 assistant 应跳过：仅剩 2 个 user 全文 + active 摘要")
        self.assertTrue(all(len(c) <= 250 for c in joined),
                         "历史区应全为摘要/短全文：" + str([len(c) for c in joined]))
        self.assertTrue(any("楞次定律" in c for c in joined), "active 节点摘要应在历史区")


class TreeUpstreamDetailBlockTest(unittest.TestCase):
    """2026-09-25 三代窗拍板：父与祖父的 ~800 字详摘要（summary_detail）进尾
    部上下文块。核心契约：出生定形（落盘存字段，读取侧只用不改）、缺字段时
    确定性现算、user 祖先不进段、祖父→父顺序由路径深度决定。"""

    def setUp(self):
        self._orig_load = context_mod._load_messages
        self.msgs = _tree_msgs()
        context_mod._load_messages = lambda sid: self.msgs

    def tearDown(self):
        context_mod._load_messages = self._orig_load

    def _path(self):
        # 三层路径：user(1) → answer(2) → user(3) → answer(4)，active=4，
        # 父=user(3) 不进段，祖父=answer(2) 进段。
        return [
            {"kind": "user", "timestamp": 1},
            {"kind": "answer", "timestamp": 2, "module": "physics"},
            {"kind": "user", "timestamp": 3},
            {"kind": "answer", "timestamp": 4, "module": "physics"},
        ]

    def test_grandparent_detail_in_block_parent_user_excluded(self):
        block = context_mod.tree_upstream_detail_block("s", self._path())
        self.assertTrue(block.startswith("# 上游节点详情（参考资料）"))
        self.assertIn("【祖父节点】", block)
        self.assertNotIn("【父节点】", block, "路径父节点是 user（历史区已全文），不进段")
        self.assertIn("磁通量变化在闭合回路中产生感应电动势", block, "祖父正文应被截进详情")

    def test_detail_is_born_fixed_prefers_stored_field(self):
        """存了 summary_detail 就逐字节用存量；同一消息两次调用结果全同。"""
        self.msgs[1]["summary_detail"] = "出生定形的详情字节。"
        self.assertEqual(
            context_mod.tree_upstream_detail_block("s", self._path()),
            context_mod.tree_upstream_detail_block("s", self._path()))
        block = context_mod.tree_upstream_detail_block("s", self._path())
        self.assertIn("出生定形的详情字节。", block)
        self.assertNotIn("磁通量变化在闭合回路中", block, "有存量字段就不再现算正文")

    def test_fallback_compute_is_deterministic_and_capped(self):
        """旧数据无 summary_detail：现算结果确定性、封顶 800 字。"""
        self.msgs[1].pop("summary_detail", None)
        d1 = context_mod.summary_detail(self.msgs[1])
        d2 = context_mod.summary_detail(self.msgs[1])
        self.assertEqual(d1, d2)
        self.assertLessEqual(len(d1), context_mod.DETAIL_SUMMARY_CHARS)
        self.assertGreater(len(d1), 400, "precondition: 长正文应截出接近上限的详情")
        self.assertTrue(d1.endswith("…"), "句界截断应以省略号收尾")

    def test_short_path_returns_empty(self):
        self.assertEqual(context_mod.tree_upstream_detail_block("s", []), "")
        self.assertEqual(
            context_mod.tree_upstream_detail_block("s", [{"kind": "user", "timestamp": 1}]), "")


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
            resp = self._post_chat({
                "device_id": "dev-tail",
                "session_id": "s_tail",
                # 2026-09-25 线性退役门禁：prompt 必须带画布锚；单元素路径
                # 不产生树路径尾部块，不影响本用例的注入位置断言
                "graph_path": [{"kind": "user", "timestamp": 1}],
            }, handler)
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

    def test_tree_request_full_text_in_tail_user_message(self):
        """树路径拍板端到端：active 模块全文只在尾部 <上下文> 块，历史区只有摘要；
        user 路径节点保持全文。"""
        physics_full = "根物理视角正文。" + "磁通量变化产生感应电动势，" * 60
        msgs = [
            {"role": "user", "content": "什么是电磁感应", "timestamp": 1},
            {"role": "assistant", "content": (
                f"<physics>{physics_full}</physics><summary>根卡片摘要。</summary>"
            ), "timestamp": 2},
        ]
        seen = {}

        def handler(request):
            seen["body"] = json.loads(request.content.decode())
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        graph_path = [
            {"kind": "user", "timestamp": 1},
            {"kind": "answer", "timestamp": 2, "module": "physics"},
        ]
        with mock.patch.object(context_mod, "_load_messages", return_value=msgs):
            resp = self._post_chat({
                "session_id": "s_tree_http",
                "prompt": "物理视角里磁通量怎么理解",
                "graph_path": graph_path,
                "source_module": "physics",
            }, handler)
        self.assertEqual(resp.status_code, 200)
        messages = seen["body"]["messages"]
        self.assertEqual(messages[0]["role"], "system")
        for m in messages[1:-1]:
            self.assertNotIn(physics_full, str(m.get("content") or ""),
                             "历史区不应出现 active 模块全文")
        tail_text = str(messages[-1].get("content") or "")
        self.assertTrue(tail_text.startswith("<上下文>"), "树路径易变注入应集中末条 user 消息")
        self.assertIn("# 当前节点正文（参考资料）", tail_text)
        self.assertIn(physics_full, tail_text)
        self.assertEqual(str(messages[1].get("content")), "什么是电磁感应",
                         "user 路径节点应保持全文")


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
