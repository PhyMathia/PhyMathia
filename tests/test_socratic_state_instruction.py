"""T351：无进行中闭环时（首卡第一次点）【提示】/【讲解】模式指令不得整体丢失。

病根：_socratic_state_instruction 在 state 缺失时直接返回空串，hint/explain
两条模式指令随之蒸发，AI 退回「按闭环规则只推进一层」口径——用户点了
「给点提示/看讲解」得到的却是又一问。修法：state 缺失但 mode 为 hint/explain
时仍返回该模式的最小指令（answer 模式仍返回空串，保持旧行为）。
Run: python3 -m pytest tests/test_socratic_state_instruction.py -q
"""

import json
from unittest import mock

import httpx

from test_routes import RouteTestBase
from server import context, http_client as http_client_mod

SESSION_ID = "sess_socraticinstr001"


class SocraticStateInstructionTest(RouteTestBase):
    SESSION_ID = SESSION_ID

    # ── 单元层：函数行为 ──

    def test_stateless_hint_keeps_instruction(self):
        text = context._socratic_state_instruction("socratic:ghost", "hint")
        self.assertIn("【提示】", text)
        self.assertIn("不要直接给答案", text)

    def test_stateless_explain_keeps_instruction(self):
        text = context._socratic_state_instruction("socratic:ghost", "explain")
        self.assertIn("【讲解】", text)
        self.assertIn('done="true"', text)

    def test_stateless_answer_stays_empty(self):
        # answer 模式无 state 时维持旧口径：空串（闭环尚未开始，交给分支指令兜底）
        self.assertEqual(context._socratic_state_instruction("socratic:ghost", "answer"), "")

    def test_stateful_path_unchanged(self):
        context._write_socratic_state("refA", {
            "active": True, "level": "advanced", "question": "想让周期缩短一半，质量怎么变？",
            "correctStreak": 1, "answeredCount": 2,
        })
        text = context._socratic_state_instruction("refA", "explain")
        self.assertIn("问题等级=advanced", text)
        self.assertIn("本轮闭环已问答 2 轮", text)
        self.assertIn("【讲解】", text)

    # ── 路由层：指令确实拼进了上游请求 ──

    def _upstream_blob_for(self, prompt):
        captured = []

        def handler(request):
            captured.append(request.content)
            return httpx.Response(200, json={"choices": [{"message": {"content": "讲解正文。"}}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client):
            resp = self.client.post("/api/models/chat", json={
                "provider": "deepseek",
                "api_key": "sk-test",
                "model": "test-model",
                "prompt": prompt,
                "session_id": SESSION_ID,
                "branch_id": "b-instr",
                "branch_type": "socratic",
                "source_module": "extend",
                "stream": False,
            })
        self.assertEqual(resp.status_code, 200, resp.text)
        body = json.loads(captured[0].decode("utf-8"))
        return "\n".join(str(m.get("content") or "") for m in body.get("messages", []))

    def test_stateless_explain_request_carries_instruction(self):
        blob = self._upstream_blob_for(
            "[苏格拉底讲解]\n追问等级：基础\n追问问题：为什么周期与振幅无关？"
        )
        self.assertIn("【讲解】", blob, "无闭环首点『看讲解』也必须带上讲解指令")

    def test_stateless_hint_request_carries_instruction(self):
        blob = self._upstream_blob_for(
            "[苏格拉底提示]\n追问等级：基础\n追问问题：为什么周期与振幅无关？"
        )
        self.assertIn("【提示】", blob, "无闭环首点『给点提示』也必须带上提示指令")
