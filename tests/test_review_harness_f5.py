"""F5 regression: deterministic undo restores full text and evaluation nodes.

原经 HTTP /graph/undo 端点真发；该端点 2026-10-06 随死代码退役删除
（T110），改直连 core 的同一条恢复链（build_inverse_ops →
build_next_snapshot），断言逐字保留。
"""
import pytest
from copy import deepcopy

from harness.core import build_inverse_ops, build_next_snapshot, normalize_snapshot


def undo_fixture():
    body = "  原始正文\\n" + "长正文 $E=mc^2$\n" * 240 + " END  "
    formula = "  " + r"\frac{a}{b}+" * 90 + "z  "
    before = {"version": 1, "nodes": [
        {"id": "note", "kind": "human_note", "label": "我的笔记", "content": body,
         "formula": formula, "manual": True, "x": 123, "y": 456, "status": "done"},
        {"id": "eval", "kind": "ai_eval", "label": "评价", "content": body,
         "formula": formula, "suggestion": body, "target_node_id": "note",
         "target_label": "我的笔记", "priority": "high", "status": "pending", "x": 321, "y": 654},
    ], "edges": [{"key": "note:out-0->eval:in-0", "from": "note", "to": "eval",
                    "fromPort": "out-0", "toPort": "in-0", "custom": True,
                    "relation": "评价", "label": "评价"}]}
    operations = [{"op": "update_node", "id": "note", "patch": {"content": "changed", "formula": "x"}},
                  {"op": "delete_node", "id": "eval"}]
    after = deepcopy(before)
    after["nodes"] = [dict(before["nodes"][0], content="changed", formula="x")]
    after["edges"] = []
    return before, operations, after


def test_undo_core_restores_full_fields():
    before, operations, after = undo_fixture()
    current = normalize_snapshot(after)
    inverse = build_inverse_ops(before, operations, current)
    result = build_next_snapshot(current, inverse)
    assert result.get("errors", []) == [], result
    assert any(op["op"] == "restore_node" for op in result["operations"]), result
    restored = {n["id"]: n for n in result["next_snapshot"]["nodes"]}
    for original in before["nodes"]:
        assert original["id"] in restored
        for field, value in original.items():
            assert restored[original["id"]].get(field) == value, (original["id"], field)
    assert result["next_snapshot"]["edges"] == before["edges"]


def test_model_cannot_invoke_restore_node_and_bad_kind_is_rejected():
    """restore_node 不对模型开放；类型不白名单时明确报错不猜测。"""
    from harness.core import UndoRestoreError, build_next_snapshot

    result = build_next_snapshot({"nodes": [], "edges": []}, [
        {"op": "restore_node", "id": "n1", "node": {"kind": "knowledge", "content": "x"}, "reason": "r"}])
    assert result["status"] == "invalid"
    assert any("不支持的操作类型" in e["reason"] for e in result["errors"]), result
    with pytest.raises(UndoRestoreError):
        build_next_snapshot(
            {"nodes": [], "edges": []},
            _inverse([{"op": "restore_node", "id": "n1", "node": {"kind": "nonsense"}, "reason": "r"}]))


def _inverse(ops):
    from harness.core import _InverseOperations
    return _InverseOperations(ops)


def test_review_undo_without_lossless_before_rejects_instead_of_guessing():
    """缺无损前态时必须明确拒绝（status=error），不得静默降级为有损猜测恢复。"""
    import asyncio
    import unittest.mock
    from harness import review as review_mod

    async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
        return {"content": "不应被调用", "tool_calls": []}

    after = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "新"}], "edges": []}
    with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
        result = asyncio.run(review_mod.review_graph(
            after,
            "撤销刚才的修改",
            model={"provider": "opencode", "model": "mimo-v2.5-free", "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
            mode="tools",
            self_check="off",
            retries=0,
            previous_ops=[{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "修改"}],
            previous_snapshot=None,
        ))
    assert result["status"] == "error"
    assert "撤销前态" in (result["errors"][0]["reason"] or "") or "撤销前态" in result["summary"]
    assert result["operations"] == []
    assert result["next_snapshot"]["nodes"][0]["content"] == "新"
