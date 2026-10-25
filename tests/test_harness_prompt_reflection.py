"""编辑模式能力反射（2026-10-26 方向 2）的守护：提示词工具/操作名单从 tools.py 反射。

照 tests/test_recipe_draft.py「每个枚举值必须出现在提示词里」的钉法：
build_tools 每个相位的每个工具名，必须出现在该相位实际拼出的提示文案里
（build 期消息经 review._splice_attempt_messages 补工具提示后的成品）
——往 PHASE_TOOLS 加工具忘了跟文案，这里当场红。
"""

import unittest

from harness import prompts as prompts_mod
from harness import review as review_mod
from harness import tools as tools_mod

_SNAPSHOT = {
    "nodes": [{"id": "A", "kind": "human_note", "label": "甲", "content": "…"}],
    "edges": [],
}
_INSTRUCTION = "测试指令"


def _phase_messages(phase):
    """按 review.messages_for_attempt 的分相位装配拼最小消息（chat/coach 同款尾部拼接）。"""
    if phase == "evaluate":
        return prompts_mod.build_evaluate_messages(_SNAPSHOT, _INSTRUCTION)
    if phase == "apply":
        return prompts_mod.build_apply_messages(_SNAPSHOT, _INSTRUCTION)
    if phase == "expand":
        return prompts_mod.build_expand_messages(_SNAPSHOT, _INSTRUCTION)
    if phase == "preset":
        return prompts_mod.build_preset_messages(_SNAPSHOT, _INSTRUCTION)
    messages = prompts_mod.build_review_messages(_SNAPSHOT, _INSTRUCTION)
    if phase == "chat":
        messages[0] = {**messages[0], "content": messages[0]["content"] + prompts_mod.HARNESS_CHAT_REDLINE}
    elif phase == "coach":
        messages[0] = {**messages[0], "content": messages[0]["content"] + prompts_mod.HARNESS_COACH_REPORT_PROMPT}
    return messages


def _phase_prompt_corpus(phase):
    """该相位发给模型的完整文案：build 期消息＋计划阶段的工具提示拼接（复用真身函数，不复制接线）。"""
    current_tools = tools_mod.build_tools(phase)
    readonly_enabled = any(
        schema.get("function", {}).get("name") in tools_mod.READONLY_TOOL_NAMES
        for schema in current_tools
    )
    spliced = review_mod._splice_attempt_messages(
        _phase_messages(phase), "", [], phase, current_tools, "auto", readonly_enabled
    )
    return "\n".join(str(m.get("content") or "") for m in spliced)


class PhasePromptReflectionTest(unittest.TestCase):
    """钉：每个相位的每个工具名必须出现在该相位的提示文案里。"""

    def test_every_phase_tool_named_in_its_prompt(self):
        for phase in tools_mod.PHASE_TOOLS:
            corpus = _phase_prompt_corpus(phase)
            for schema in tools_mod.build_tools(phase):
                name = schema["function"]["name"]
                self.assertIn(
                    name, corpus,
                    f"「{phase}」相位的工具 {name} 在工具表里但没进提示文案——加工具忘了跟文案",
                )

    def test_ops_example_table_matches_edit_tools(self):
        # 操作示例表与 EDIT_TOOL_NAMES 一一对应：少一个＝新编辑工具没示例，
        # 多一个＝残留已退役键（渲染时被跳过、静默漂移），两侧都红。
        self.assertEqual(
            set(prompts_mod._OP_EXAMPLE_FIELDS), set(tools_mod.EDIT_TOOL_NAMES),
            "操作示例表 _OP_EXAMPLE_FIELDS 与 tools.EDIT_TOOL_NAMES 键集不一致",
        )
        for op in tools_mod.EDIT_TOOL_NAMES:
            self.assertIn(f'"op": "{op}"', prompts_mod.HARNESS_SYSTEM_PROMPT)

    def test_edit_tools_all_map_to_ops(self):
        # EDIT_TOOL_NAMES 必须都是真工具（TOOL_TO_OP 有映射），防止它长成
        # 与工具表脱钩的第二份名单。
        for name in tools_mod.EDIT_TOOL_NAMES:
            self.assertIn(name, tools_mod.TOOL_TO_OP)


if __name__ == "__main__":
    unittest.main()
