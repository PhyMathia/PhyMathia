"""配方创造模式安全修复回归（2026-10-09）。

覆盖本轮四个后端安全点：
1. 撤销守卫必须在 MAX_OPERATIONS 截片【之前】判含 update/delete_recipe 的批
   （截断会把更早的配方操作漏检，跌回「图回滚、配方不动」的半撤）；op/type 双键名。
2. 同批 delete_recipe 与 create_node/update_recipe 的引用冲突预检（两种顺序都拦）。
3. 名称账本批内更新（update 改名 / delete 移除后，后续查重按新状态判）；
   T243 旧名必须在改账本前捕获（rename 时 recipe_name 仍是旧名）。
4. update_recipe 合并目标的漏字段警告必须说「保持原值」，整份覆盖目标才说
   「重置为默认值」；合并保留未提交字段、null 清除动态出口。

与 tests/test_recipe_creation_improvements.py（另一批用例）互不重叠、互不改动。
"""

import asyncio
import unittest
import unittest.mock

from harness.core import build_next_snapshot, normalize_snapshot


def _recipe(name="错题复盘", recipe_id="r1", dynamic=True):
    recipe = {
        "id": recipe_id,
        "name": name,
        "desc": "一页复盘",
        "base": {"kind": "module"},
        "appearance": {"palette": "amber", "shape": "is-round"},
        "generate": {
            "prompt": "输出错因与正确思路",
            "strict_output": "",
            "followup_prompt": "",
            "confused_prompt": "",
            "retry_prompt": "",
            "context_channel": "workflow_context",
            "model_role": "agent",
            "on_incomplete": {"max_retries": 1},
        },
        "ports": {"static": [{"label": "提示", "drag_form": "draft"}]},
        "content_kind": "markdown",
    }
    if dynamic:
        recipe["ports"]["dynamic"] = {
            "parser": {
                "pattern": "numbered_list",
                "level_tags": ["基础", "进阶", "拓展"],
                "max": 4,
                "label_from": "index_question",
            },
            "fallback": {"mode": "label_questions_from_text", "labels": []},
            "each": {"type": "socratic", "branch_type": "socratic", "drag_form": "draft"},
        }
    return recipe


class UndoRecipeGuardTest(unittest.TestCase):
    """确定性撤销对含配方 update/delete 的批整批拒绝（且不受 >80 截片影响）。"""

    MODEL = {"provider": "opencode", "model": "mimo-v2.5-free",
             "base_url": "https://opencode.ai/zen/v1", "api_key": ""}
    SNAP = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}], "edges": []}

    def _run(self, instruction, snapshot=None, **kw):
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": "", "tool_calls": []}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            result = asyncio.run(review_mod.review_graph(
                self.SNAP if snapshot is None else snapshot,
                instruction,
                model=self.MODEL,
                mode="tools",
                self_check="off",
                retries=0,
                **kw,
            ))
        return result, called

    def test_recipe_op_in_truncated_prefix_still_blocks(self):
        """配方操作排在 90 条历史的最前面：截片前判定必须命中，不得半撤。"""
        graph_ops = [
            {"op": "update_node", "id": "A", "patch": {"content": f"v{i}"}, "reason": "改"}
            for i in range(90)
        ]
        recipe_op = {"op": "update_recipe", "recipe_id": "r1",
                     "recipe": {"name": "新名"}, "reason": "改名"}
        result, called = self._run(
            "撤销全部", previous_ops=[], all_previous_ops=[recipe_op] + graph_ops,
        )
        self.assertEqual(called["n"], 0, "配方批拦截不应调模型")
        self.assertEqual(result["status"], "no_ops", result.get("summary"))
        self.assertIn("配方", result["summary"])
        self.assertEqual(result["operations"], [])

    def test_type_alias_recipe_op_blocks(self):
        """历史条目用 type 而非 op 时同样拦截。"""
        result, called = self._run(
            "撤销",
            previous_ops=[{"type": "delete_recipe", "recipe_id": "r1", "reason": "删"}],
            previous_snapshot=self.SNAP,
        )
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "no_ops")
        self.assertIn("配方", result["summary"])

    def test_graph_only_undo_still_deterministic(self):
        """无配方操作的批照旧走确定性逆操作（本修复不得误伤）。"""
        before = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}], "edges": []}
        after = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "新"}], "edges": []}
        result, called = self._run(
            "撤销",
            previous_ops=[{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "改"}],
            previous_snapshot=before,
            snapshot=after,
        )
        self.assertEqual(called["n"], 0)
        self.assertEqual(result["status"], "undo", result.get("summary"))
        self.assertEqual(result["next_snapshot"]["nodes"][0]["content"], "原")


class DeleteRecipeReferenceTest(unittest.TestCase):
    """同批「删配方 + 引用该配方」必须拦引用，两种顺序都拦。"""

    def _snapshot(self):
        return {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "甲", "content": "a"}],
            "user_recipes": [{"id": "r1", "name": "错题复盘", "base_kind": "module"}],
            "recipe_detail": _recipe(),
        }

    def _assert_blocked(self, ops):
        result = build_next_snapshot(self._snapshot(), ops)
        blocked = [err for err in result["errors"] if err.get("op") == "create_node"]
        self.assertEqual(len(blocked), 1, result["errors"])
        self.assertIn("将被删除", blocked[0]["reason"])
        self.assertFalse([op for op in result["operations"] if (op.get("op") or op.get("type")) == "create_node"],
                         "被拦的 create_node 不得进入有效操作")

    def test_delete_then_create_node_blocked(self):
        self._assert_blocked([
            {"op": "delete_recipe", "recipe_id": "r1", "reason": "删掉"},
            {"op": "create_node", "temp_id": "n1", "kind": "module", "recipe_id": "r1",
             "label": "错题复盘", "reason": "放一个"},
        ])

    def test_create_node_before_delete_blocked(self):
        self._assert_blocked([
            {"op": "create_node", "temp_id": "n1", "kind": "module", "recipe_id": "r1",
             "label": "错题复盘", "reason": "放一个"},
            {"op": "delete_recipe", "recipe_id": "r1", "reason": "删掉"},
        ])

    def test_delete_then_update_recipe_blocked(self):
        result = build_next_snapshot(self._snapshot(), [
            {"op": "delete_recipe", "recipe_id": "r1", "reason": "删掉"},
            {"op": "update_recipe", "recipe_id": "r1", "recipe": {"desc": "新描述"}, "reason": "改描述"},
        ])
        blocked = [err for err in result["errors"] if err.get("op") == "update_recipe"]
        self.assertEqual(len(blocked), 1, result["errors"])
        self.assertIn("将被删除", blocked[0]["reason"])


class RecipeNameLedgerTest(unittest.TestCase):
    """名称账本批内更新：改名的旧名对照、改名后查重、删除后同名可重建。"""

    def test_rename_then_create_same_name_blocked_and_keeps_old_name(self):
        snapshot = {
            "nodes": [],
            "user_recipes": [{"id": "r1", "name": "旧名", "base_kind": "module"}],
            "recipe_detail": _recipe("旧名"),
        }
        result = build_next_snapshot(snapshot, [
            {"op": "update_recipe", "recipe_id": "r1", "recipe": {"name": "新名"}, "reason": "改名"},
            {"op": "create_recipe", "recipe": _recipe("新名", recipe_id=""), "reason": "新建"},
        ])
        ops = result["operations"]
        updates = [op for op in ops if op.get("op") == "update_recipe"]
        creates = [op for op in ops if op.get("op") == "create_recipe"]
        self.assertEqual(len(updates), 1, result["errors"])
        self.assertEqual(len(creates), 0, "改名后的新名字必须参与同名查重")
        # T243：rename 的 before→after 对照必须保留旧名（账本更新不得污染 matched）
        self.assertEqual(updates[0]["recipe_name"], "旧名")
        self.assertEqual(updates[0]["recipe"]["name"], "新名")
        dup_errors = [err for err in result["errors"] if "同名" in err.get("reason", "")]
        self.assertEqual(len(dup_errors), 1, result["errors"])

    def test_delete_then_create_same_name_allowed(self):
        snapshot = {
            "nodes": [],
            "user_recipes": [{"id": "r1", "name": "旧名", "base_kind": "module"}],
        }
        result = build_next_snapshot(snapshot, [
            {"op": "delete_recipe", "recipe_id": "r1", "reason": "删掉"},
            {"op": "create_recipe", "recipe": _recipe("旧名", recipe_id=""), "reason": "重建同名"},
        ])
        creates = [op for op in result["operations"] if op.get("op") == "create_recipe"]
        self.assertEqual(len(creates), 1, result["errors"])
        self.assertNotIn("同名", "；".join(err.get("reason", "") for err in result["errors"]))


class MergeSemanticsTest(unittest.TestCase):
    """合并目标：字段保留、null 清除、警告说「保持原值」；整份覆盖才说「重置」。"""

    def _detail_snapshot(self):
        return {
            "nodes": [],
            "user_recipes": [{"id": "r1", "name": "错题复盘", "base_kind": "module"}],
            "recipe_detail": _recipe(),
        }

    def test_merged_warning_says_kept_not_reset(self):
        result = build_next_snapshot(self._detail_snapshot(), [
            {"op": "update_recipe", "recipe_id": "r1",
             "recipe": {"appearance": {"palette": "blue"}},
             "reason": "把档位标签改成三档"},
        ])
        self.assertEqual(result["status"], "ok", result["errors"])
        recipe = result["operations"][0]["recipe"]
        self.assertEqual(recipe["appearance"]["palette"], "blue")
        self.assertEqual(recipe["ports"]["dynamic"]["parser"]["level_tags"], ["基础", "进阶", "拓展"])
        self.assertEqual(recipe["generate"]["prompt"], "输出错因与正确思路")
        reasons = "；".join(w.get("reason", "") for w in result["warnings"])
        self.assertIn("保持原值", reasons)
        self.assertNotIn("将被重置", reasons)

    def test_merged_null_clears_dynamic(self):
        result = build_next_snapshot(self._detail_snapshot(), [
            {"op": "update_recipe", "recipe_id": "r1",
             "recipe": {"ports": {"dynamic": None}},
             "reason": "不要动态出口了"},
        ])
        self.assertEqual(result["status"], "ok", result["errors"])
        recipe = result["operations"][0]["recipe"]
        self.assertNotIn("dynamic", recipe["ports"])
        self.assertEqual(recipe["ports"]["static"][0]["label"], "提示")

    def test_full_replace_warning_still_says_reset(self):
        snapshot = {
            "nodes": [],
            "user_recipes": [{"id": "r1", "name": "错题复盘", "base_kind": "module"}],
        }
        result = build_next_snapshot(snapshot, [
            {"op": "update_recipe", "recipe_id": "r1",
             "recipe": _recipe(dynamic=False),
             "reason": "把档位标签改成三档"},
        ])
        self.assertEqual(result["status"], "ok", result["errors"])
        reasons = "；".join(w.get("reason", "") for w in result["warnings"])
        self.assertIn("将被重置", reasons)


class DetailBudgetTest(unittest.TestCase):
    """32 条摘要预算下，selected 的 recipe_detail 仍在清单里且置顶。"""

    def test_selected_detail_survives_32_cap(self):
        summaries = [{"id": f"r{i}", "name": f"配方{i}"} for i in range(40)]
        snapshot = {
            "nodes": [],
            "user_recipes": summaries,
            "recipe_detail": _recipe("目标配方", recipe_id="r35"),
        }
        normalized = normalize_snapshot(snapshot)
        self.assertIn("recipe_detail", normalized)
        self.assertEqual(normalized["recipe_detail"]["id"], "r35")
        self.assertEqual(len(normalized["user_recipes"]), 32)
        self.assertEqual(normalized["user_recipes"][0]["id"], "r35")


if __name__ == "__main__":
    unittest.main()
