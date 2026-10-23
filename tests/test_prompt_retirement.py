"""src/system prompt.md 退役（2026-10-11）的守护测试。

三组口径：
① 静态符号——BRANCH_SYSTEM_PROMPT 是旧文件的搬运（活段落保留、退役意图路由
   已删），旧加载符号（get_system_prompt/SYSTEM_PROMPT/_load_system_prompt）灭迹；
② PHI_CONTEXT——Φ 专用底稿不含卡片/苏格拉底渲染专属内容，_trim_harness_context
   已删，_context_block 直通（仅保留 6000 字符上限）；
③ 接线——app.state.harness_context 指向 PHI_CONTEXT，热刷新中间件已删，
   review/resolve 两端点的 payload.context 优先级保持「显式非空优先、缺省回退」。
"""

import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for _p in (SRC, ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from harness import api as harness_api  # noqa: E402
from harness import prompts as harness_prompts  # noqa: E402
from server import prompts as server_prompts  # noqa: E402

_SNAPSHOT = {
    "version": 1,
    "nodes": [{"id": "A", "kind": "human_note", "label": "导数"}],
    "edges": [],
}


class BranchPromptStaticTest(unittest.TestCase):
    """BRANCH_SYSTEM_PROMPT＝旧文件搬运：活段落逐字保留，退役段已删。"""

    def test_live_sections_kept(self):
        prompt = server_prompts.BRANCH_SYSTEM_PROMPT
        for anchor in (
            "# 角色定义",
            "## 完整探索流程",
            "公式标注规范",
            "## 定向追问流程",
            "## 苏格拉底式追问闭环",
            "## 完整探索 vs 局部节点",
            "# 约束",
            "# 输出格式",
        ):
            self.assertIn(anchor, prompt)

    def test_retired_intent_routes_removed(self):
        prompt = server_prompts.BRANCH_SYSTEM_PROMPT
        for anchor in (
            "Step 0",
            "意图识别",
            "## 重做可视化流程",
            "## 公式查询流程",
            "## 自由对话流程",
        ):
            self.assertNotIn(anchor, prompt)

    def test_old_loader_symbols_gone(self):
        self.assertFalse(hasattr(server_prompts, "get_system_prompt"))
        self.assertFalse(hasattr(server_prompts, "SYSTEM_PROMPT"))
        self.assertFalse(hasattr(server_prompts, "_load_system_prompt"))
        self.assertIn("BRANCH_SYSTEM_PROMPT", server_prompts.__all__)
        self.assertNotIn("get_system_prompt", server_prompts.__all__)


class PhiContextStaticTest(unittest.TestCase):
    """PHI_CONTEXT：Φ 专用，卡片渲染专属内容不得混入。"""

    def test_phi_context_shape(self):
        ctx = harness_prompts.PHI_CONTEXT
        self.assertIn("# 角色定义", ctx)
        self.assertIn("禁止编造物理定律或数学定理", ctx)
        for anchor in (
            "<physics>",
            "完整探索流程",
            "<socratic_meta>",
            "<summary>",
            "Step 0",
            "意图识别",
        ):
            self.assertNotIn(anchor, ctx)

    def test_trim_function_gone(self):
        self.assertFalse(hasattr(harness_prompts, "_trim_harness_context"))

    def test_context_block_passes_phi_verbatim(self):
        block = harness_prompts._context_block(harness_prompts.PHI_CONTEXT)
        self.assertIn(harness_prompts.PHI_CONTEXT, block)

    def test_context_block_caps_at_6000(self):
        block = harness_prompts._context_block("字" * 7000)
        self.assertLessEqual(len(block), 6100)


class HarnessContextWiringTest(unittest.TestCase):
    """接线与优先级：payload.context 显式非空优先，缺省回退 PHI_CONTEXT。"""

    def setUp(self):
        self.client = TestClient(main_mod.app, base_url="http://127.0.0.1")

    def test_app_state_defaults_to_phi_context(self):
        self.assertEqual(main_mod.app.state.harness_context, harness_prompts.PHI_CONTEXT)

    def test_hot_reload_middleware_gone(self):
        self.assertFalse(hasattr(main_mod, "_refresh_harness_context"))

    def _review(self, body):
        captured = {}

        async def fake_review_graph(**kwargs):
            captured.update(kwargs)
            return {"status": "no_ops", "operations": [], "summary": "",
                    "errors": [], "warnings": []}

        with mock.patch.object(harness_api, "review_graph", new=fake_review_graph), \
                mock.patch.object(harness_api, "_log_review_event", new=lambda *a, **k: None), \
                mock.patch.object(harness_api, "_log_usage", new=lambda *a, **k: None):
            resp = self.client.post("/api/harness/graph/review", json=body)
        self.assertEqual(resp.status_code, 200)
        return captured.get("context")

    def _resolve(self, body):
        captured = {}

        async def fake_resolve_focus(**kwargs):
            captured.update(kwargs)
            return {"status": "ok", "targets": []}

        with mock.patch.object(harness_api, "resolve_focus", new=fake_resolve_focus), \
                mock.patch.object(harness_api, "_log_review_event", new=lambda *a, **k: None), \
                mock.patch.object(harness_api, "_log_usage", new=lambda *a, **k: None):
            resp = self.client.post("/api/harness/graph/resolve", json=body)
        self.assertEqual(resp.status_code, 200)
        return captured.get("context")

    def test_review_prefers_payload_context(self):
        body = {"instruction": "改一下", "snapshot": _SNAPSHOT, "context": "自定义上下文"}
        self.assertEqual(self._review(body), "自定义上下文")

    def test_review_falls_back_to_phi_context(self):
        body = {"instruction": "改一下", "snapshot": _SNAPSHOT}
        self.assertEqual(self._review(body), harness_prompts.PHI_CONTEXT)

    def test_resolve_prefers_payload_context(self):
        body = {"instruction": "解析目标", "snapshot": _SNAPSHOT, "context": "自定义上下文"}
        self.assertEqual(self._resolve(body), "自定义上下文")

    def test_resolve_falls_back_to_phi_context(self):
        body = {"instruction": "解析目标", "snapshot": _SNAPSHOT}
        self.assertEqual(self._resolve(body), harness_prompts.PHI_CONTEXT)


if __name__ == "__main__":
    unittest.main()
