"""节点配方创造改进（2026-10-09 工作区 diff）单元测试。

覆盖点（harness/core.py、harness/tools.py、harness/review.py、
harness/review_ops.py、harness/prompts.py 的当前未提交改动）：

- normalize_snapshot：recipe_detail（用户选中目标的完整旧配置）先经 normalize+validate
  才认领，且优先进入 user_recipes 摘要（去重置顶、总预算仍 32）；缺 id、非法底座或
  过不了校验的旧配置一律不带。
- build_next_snapshot：create_recipe.temp_recipe_id 与同批 create_node.recipe_id 闭环并
  回写后端分配的最终 ID；前向引用、重复临时 ID（含撞已有清单 id）、批内重名被拒。
- update_recipe 指定 recipe_detail 目标时递归合并（对象递归、数组整体替换、null/空串
  清除未提交字段依然保留），其他目标仍走旧「整份 payload」口径；构建过程不改写输入。
- review_graph：prev_ops 含 update_recipe / delete_recipe 的撤销意图返回 no_ops 并说明
  走整批 checkpoint 路径——不调用模型、绝不半撤混合批次。
- tools：update_recipe 允许缺 name 的局部 patch；create_recipe 透传 temp_recipe_id。
- review_ops._focus_subgraph：大图降采样透传 recipe_detail。
- prompts：创造模式系统提示词与工具 schema 对同一合并契约口径一致。

本文件只读被测纯函数与桩模型，不写任何源文件。
"""

import asyncio
import json
import os
import sys
import unittest
import unittest.mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# conftest 会补这两个路径（harness.review 顶层 import server 包）；这里自补一份，
# 保证不经 conftest 直接跑本文件也能导入。
for _path in (ROOT, os.path.join(ROOT, "src")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from harness.core import build_next_snapshot, normalize_snapshot
from harness.review_ops import _focus_subgraph
from harness.tools import _args_to_op, build_tools, parse_tool_calls

# review_graph 桩路径用的模型条目（与 tests/test_harness.py 既有用法同形）
MODEL = {
    "provider": "opencode",
    "model": "mimo-v2.5-free",
    "base_url": "https://opencode.ai/zen/v1",
    "api_key": "",
}


def _valid_recipe(**over):
    """一份能过 normalize+validate 的 module 配方（嵌套字段＋动态出口齐全）。"""
    recipe = {
        "name": "错题复盘",
        "desc": "旧描述",
        "base": {"kind": "module"},
        "appearance": {"palette": "teal", "shape": "is-round"},
        "generate": {
            "prompt": "按错因分类精讲，每类给一道变式。",
            "followup_prompt": "要不要再练一题？",
            "context_channel": "workflow_context",
        },
        "ports": {
            "static": [{"label": "再练一题", "drag_form": "user"}],
            "dynamic": {
                "parser": {
                    "pattern": "numbered_list",
                    "level_tags": ["基础", "进阶", "拓展"],
                    "label_from": "index_question",
                },
                "fallback": {"mode": "label_questions_from_text"},
                "each": {"type": "socratic"},
            },
        },
        "content_kind": "markdown",
        "unknown_field": "会被 normalize 剥除",
    }
    recipe.update(over)
    return recipe


def _detail(recipe_id="recipe-1", **over):
    return {"id": recipe_id, **_valid_recipe(**over)}


def _snapshot_with_recipes(**over):
    snapshot = {
        "nodes": [{"id": "A", "kind": "knowledge", "label": "导数"}],
        "edges": [],
        "user_recipes": [
            {"id": "recipe-1", "name": "错题复盘", "desc": "用户配方", "base_kind": "module"},
            {"id": "recipe-2", "name": "公式速查", "base_kind": "knowledge"},
        ],
    }
    snapshot.update(over)
    return snapshot


def _call(name, arguments):
    return {"function": {"name": name, "arguments": arguments}}


class RecipeDetailSnapshotTest(unittest.TestCase):
    """normalize_snapshot：recipe_detail 归一化、置顶去重、32 预算与丢弃条件。"""

    def test_valid_detail_normalized_and_promoted_to_front(self):
        normalized = normalize_snapshot(_snapshot_with_recipes(recipe_detail=_detail()))
        detail = normalized["recipe_detail"]
        self.assertEqual(detail["id"], "recipe-1")
        self.assertEqual(detail["name"], "错题复盘")
        self.assertEqual(detail["generate"]["prompt"], "按错因分类精讲，每类给一道变式。")
        self.assertNotIn("unknown_field", detail, "未知字段应被 normalize 剥除")
        # 摘要里按 id 去重后置顶，且选中目标条目只保留身份字段
        self.assertEqual(normalized["user_recipes"][0], {"id": "recipe-1", "name": "错题复盘"})
        self.assertEqual([e["id"] for e in normalized["user_recipes"]], ["recipe-1", "recipe-2"])

    def test_detail_takes_precedence_over_32_summary_budget(self):
        recipes = [{"id": f"r{i}", "name": f"配方{i}"} for i in range(33)]
        base = {"nodes": [], "edges": [], "user_recipes": recipes}
        # 无选中目标：摘要按 normalize_user_recipes 的旧口径截到 32
        plain = normalize_snapshot(base)
        self.assertEqual(len(plain["user_recipes"]), 32)
        self.assertEqual([e["id"] for e in plain["user_recipes"]], [f"r{i}" for i in range(32)])
        # 有选中目标：detail 置顶且不额外占额，仍 32 条，原最末一条让位
        selected = normalize_snapshot({
            **base,
            "recipe_detail": _detail(recipe_id="r-det", name="选中配方"),
        })
        self.assertEqual(selected["recipe_detail"]["id"], "r-det")
        self.assertEqual(len(selected["user_recipes"]), 32)
        self.assertEqual(selected["user_recipes"][0]["id"], "r-det")
        ids = [e["id"] for e in selected["user_recipes"]]
        self.assertIn("r30", ids)
        self.assertNotIn("r31", ids)
        self.assertNotIn("r32", ids)

    def test_detail_dropped_without_id_or_when_invalid(self):
        # 缺 id：不认领、不进摘要
        no_id = normalize_snapshot(_snapshot_with_recipes(recipe_detail=_valid_recipe()))
        self.assertNotIn("recipe_detail", no_id)
        self.assertEqual([e["id"] for e in no_id["user_recipes"]], ["recipe-1", "recipe-2"])
        # 非法底座：normalize 直接失败
        bad_base = normalize_snapshot(_snapshot_with_recipes(
            recipe_detail={"id": "d1", "base": {"kind": "bogus"}}))
        self.assertNotIn("recipe_detail", bad_base)
        # 过得了 normalize、过不了 validate（AI 底座没有主提示词）
        bad_validate = normalize_snapshot(_snapshot_with_recipes(
            recipe_detail={"id": "d2", "name": "无提示词", "base": {"kind": "module"}}))
        self.assertNotIn("recipe_detail", bad_validate)
        self.assertNotIn("d2", [e["id"] for e in bad_validate["user_recipes"]])
        # 非 dict 同样静默丢弃
        self.assertNotIn("recipe_detail", normalize_snapshot(
            _snapshot_with_recipes(recipe_detail="junk")))


class RecipeBatchClosureTest(unittest.TestCase):
    """build_next_snapshot：同批 create_recipe → create_node 闭环与引用拒绝。"""

    def test_temp_recipe_id_closes_loop_and_writes_back_final_id(self):
        result = build_next_snapshot(_snapshot_with_recipes(), [
            {"op": "create_recipe", "temp_recipe_id": "new_recipe",
             "recipe": _valid_recipe(name="考前速记", desc="按考点速记"), "reason": "用户要求新建"},
            {"op": "create_node", "temp_id": "t1", "kind": "module", "label": "考前速记",
             "recipe_id": "new_recipe", "reason": "在画布上放一个试试"},
        ])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["errors"], [])
        recipe_op, node_op = result["operations"]
        final_id = recipe_op["recipe_id"]
        self.assertTrue(final_id.startswith("recipe-hn-"), "后端分配最终配方 ID")
        # 回写：create_node 的临时引用被解析成最终 ID——op 与节点两侧都要
        self.assertEqual(node_op["recipe_id"], final_id)
        node = next(n for n in result["next_snapshot"]["nodes"] if n["id"] == node_op["assigned_id"])
        self.assertEqual(node["recipe_id"], final_id)
        self.assertEqual(node["module_key"], "", "配方实例节点 module_key 允许为空")

    def test_forward_reference_is_rejected(self):
        # 同一批里先 create_node 引用后 create_recipe：顺序语义下引用不可见，必须拒绝
        result = build_next_snapshot(_snapshot_with_recipes(), [
            {"op": "create_node", "temp_id": "t1", "kind": "module", "label": "考前速记",
             "recipe_id": "new_recipe", "reason": "先引用后创建"},
            {"op": "create_recipe", "temp_recipe_id": "new_recipe",
             "recipe": _valid_recipe(name="考前速记"), "reason": "用户要求新建"},
        ])
        self.assertEqual(result["status"], "partial")
        self.assertEqual([e["op"] for e in result["errors"]], ["create_node"])
        self.assertIn("配方不存在", result["errors"][0]["reason"])
        self.assertEqual([op["op"] for op in result["operations"]], ["create_recipe"])
        self.assertFalse(any(n.get("recipe_id") == "new_recipe"
                             for n in result["next_snapshot"]["nodes"]),
                         "前向引用不得建出悬空配方节点")

    def test_duplicate_temp_recipe_id_or_name_rejected(self):
        # 临时 ID 批内重复：第一条有效、第二条整条拒
        two = build_next_snapshot(_snapshot_with_recipes(), [
            {"op": "create_recipe", "temp_recipe_id": "dup",
             "recipe": _valid_recipe(name="配方甲"), "reason": "建"},
            {"op": "create_recipe", "temp_recipe_id": "dup",
             "recipe": _valid_recipe(name="配方乙"), "reason": "建"},
        ])
        self.assertEqual(two["status"], "partial")
        self.assertEqual(len(two["operations"]), 1)
        self.assertIn("临时 ID 重复", two["errors"][0]["reason"])
        # 临时 ID 撞上清单里已有的 id 同样拒绝
        clash = build_next_snapshot(_snapshot_with_recipes(), [
            {"op": "create_recipe", "temp_recipe_id": "recipe-1",
             "recipe": _valid_recipe(name="配方丙"), "reason": "建"},
        ])
        self.assertEqual(clash["status"], "invalid")
        self.assertIn("临时 ID 重复", clash["errors"][0]["reason"])
        # 名字批内重复：查重库包含本批刚建的那条，第二条被校验器拒
        dup_name = build_next_snapshot(_snapshot_with_recipes(), [
            {"op": "create_recipe", "temp_recipe_id": "a",
             "recipe": _valid_recipe(name="双份配方"), "reason": "建"},
            {"op": "create_recipe", "temp_recipe_id": "b",
             "recipe": _valid_recipe(name="双份配方"), "reason": "建"},
        ])
        self.assertEqual(dup_name["status"], "partial")
        self.assertIn("已有同名配方", dup_name["errors"][0]["reason"])


class RecipeDetailMergeTest(unittest.TestCase):
    """update_recipe 对 recipe_detail 目标递归合并；其他目标仍整份提交。"""

    def _update(self, snapshot, recipe_id, payload, reason="调整配方"):
        return build_next_snapshot(snapshot, [
            {"op": "update_recipe", "recipe_id": recipe_id, "recipe": payload, "reason": reason},
        ])

    def test_partial_update_merges_and_keeps_unsubmitted_fields(self):
        result = self._update(
            _snapshot_with_recipes(recipe_detail=_detail()), "recipe-1", {"desc": "只改描述"})
        self.assertEqual(result["status"], "ok")
        op = result["operations"][0]
        recipe = op["recipe"]
        # 未提交的深层字段全部保留（含 name——局部 patch 不再要求整份 payload）
        self.assertEqual(recipe["name"], "错题复盘")
        self.assertEqual(recipe["desc"], "只改描述")
        self.assertEqual(recipe["generate"]["prompt"], "按错因分类精讲，每类给一道变式。")
        self.assertEqual(recipe["generate"]["followup_prompt"], "要不要再练一题？")
        self.assertEqual(recipe["appearance"]["palette"], "teal")
        self.assertEqual(recipe["ports"]["dynamic"]["parser"]["level_tags"], ["基础", "进阶", "拓展"])
        self.assertEqual(recipe["ports"]["static"][0]["label"], "再练一题")
        self.assertEqual(op["recipe_name"], "错题复盘")

    def test_partial_update_still_rejected_for_other_targets(self):
        # 快照没有 recipe_detail：旧整份口径不变，缺 name 的 patch 被拒
        no_detail = self._update(_snapshot_with_recipes(), "recipe-1", {"desc": "只改描述"})
        self.assertEqual(no_detail["status"], "invalid")
        self.assertIn("payload 不合法", no_detail["errors"][0]["reason"])
        # 有 recipe_detail 但不是本次目标：同样不合并，仍要求整份
        other = self._update(_snapshot_with_recipes(recipe_detail=_detail()), "recipe-2", {"desc": "只改描述"})
        self.assertEqual(other["status"], "invalid")
        self.assertIn("payload 不合法", other["errors"][0]["reason"])

    def test_null_clears_dynamic_ports_and_empty_string_clears_text(self):
        result = self._update(
            _snapshot_with_recipes(recipe_detail=_detail()),
            "recipe-1",
            {"ports": {"dynamic": None}, "desc": "", "generate": {"followup_prompt": ""}},
        )
        self.assertEqual(result["status"], "ok")
        recipe = result["operations"][0]["recipe"]
        self.assertNotIn("dynamic", recipe["ports"], "ports.dynamic=null 应清除动态出口")
        self.assertEqual(recipe["ports"]["static"][0]["label"], "再练一题")
        self.assertEqual(recipe["desc"], "")
        self.assertEqual(recipe["generate"]["followup_prompt"], "")
        self.assertEqual(recipe["generate"]["prompt"], "按错因分类精讲，每类给一道变式。",
                         "清空一个槽不得连坐其他槽")

    def test_arrays_replace_wholesale_while_objects_merge(self):
        result = self._update(
            _snapshot_with_recipes(recipe_detail=_detail()),
            "recipe-1",
            {"ports": {"static": [{"label": "唯一出口"}]}, "generate": {"prompt": "新的生成提示词"}},
        )
        self.assertEqual(result["status"], "ok")
        recipe = result["operations"][0]["recipe"]
        # 数组整体替换：旧 static 出口不残留
        self.assertEqual(recipe["ports"]["static"], [{"label": "唯一出口", "drag_form": "draft"}])
        # 同层的 dynamic 是未提交字段，递归合并后保留
        self.assertEqual(recipe["ports"]["dynamic"]["parser"]["level_tags"], ["基础", "进阶", "拓展"])
        self.assertEqual(recipe["generate"]["prompt"], "新的生成提示词")
        self.assertEqual(recipe["generate"]["followup_prompt"], "要不要再练一题？")

    def test_build_next_snapshot_leaves_inputs_untouched(self):
        snapshot = _snapshot_with_recipes(recipe_detail=_detail())
        ops = [{"op": "update_recipe", "recipe_id": "recipe-1",
                "recipe": {"desc": "只改描述"}, "reason": "调整"}]
        snapshot_before = json.loads(json.dumps(snapshot, ensure_ascii=False))
        ops_before = json.loads(json.dumps(ops, ensure_ascii=False))
        result = build_next_snapshot(snapshot, ops)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(snapshot, snapshot_before, "合并结果不得回写进调用方快照")
        self.assertEqual(ops, ops_before, "payload 不得被合并流程改写")
        self.assertEqual(snapshot["recipe_detail"]["desc"], "旧描述")
        self.assertIsNot(result["operations"][0]["recipe"], snapshot["recipe_detail"],
                         "输出应是独立副本")


class RecipeToolArgsTest(unittest.TestCase):
    """tools：update 局部 patch 通过、create 仍要 name、temp_recipe_id 透传与 schema。"""

    def test_tool_args_allow_partial_patch_and_pass_temp_id(self):
        op = _args_to_op("update_recipe", {
            "recipe_id": "recipe-1", "recipe": {"desc": "只改描述"}, "reason": "改描述"})
        self.assertIsNotNone(op)
        self.assertEqual(op["recipe"], {"desc": "只改描述"})
        self.assertEqual(op["recipe_id"], "recipe-1")
        ops, errors = parse_tool_calls([_call("update_recipe", {
            "recipe_id": "recipe-1", "recipe": {"desc": "只改描述"}, "reason": "改描述"})])
        self.assertEqual(errors, [])
        self.assertEqual(len(ops), 1)
        # create 仍必须带 name——没有名字就无从建立配方
        self.assertIsNone(_args_to_op("create_recipe", {"recipe": {"desc": "无名"}, "reason": "建"}))
        # temp_recipe_id 透传（strip 后），缺省不生成该键
        created = _args_to_op("create_recipe", {
            "recipe": _valid_recipe(name="新配方"), "temp_recipe_id": "  new_recipe  ", "reason": "建"})
        self.assertEqual(created["temp_recipe_id"], "new_recipe")
        plain = _args_to_op("create_recipe", {"recipe": _valid_recipe(name="新配方"), "reason": "建"})
        self.assertNotIn("temp_recipe_id", plain)
        # 局部合并契约落在 schema 上：create 的 recipe 仍需 name，update 不再要求
        schemas = {t["function"]["name"]: t["function"]["parameters"]["properties"]
                   for t in build_tools("preset")}
        self.assertIn("temp_recipe_id", schemas["create_recipe"])
        self.assertEqual(schemas["create_recipe"]["recipe"]["required"], ["name"])
        self.assertEqual(schemas["update_recipe"]["recipe"]["required"], [])
        self.assertIn("temp_recipe_id", schemas["create_node"]["recipe_id"]["description"])


class RecipeUndoGuardTest(unittest.TestCase):
    """review_graph：混合配方批次的撤销守卫——不调模型、整批走 checkpoint 路径。"""

    def test_mixed_recipe_undo_returns_no_ops_without_model_call(self):
        from harness import review as review_mod

        called = {"n": 0}

        async def fake_call(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
            called["n"] += 1
            return {"content": '{"summary": "已处理", "operations": []}', "tool_calls": []}

        snapshot = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "新"}],
                    "edges": []}
        previous = {"nodes": [{"id": "A", "kind": "knowledge", "label": "导数", "content": "原"}],
                    "edges": []}
        recipe_op = {"op": "update_recipe", "recipe_id": "recipe-1",
                     "recipe": _valid_recipe(name="错题复盘"), "reason": "改配方"}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            blocked = asyncio.run(review_mod.review_graph(
                snapshot, "撤销刚才的修改，恢复原样",
                model=MODEL, phase="preset", mode="tools", self_check="off",
                previous_snapshot=previous,
                previous_ops=[
                    {"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "改"},
                    recipe_op,
                ],
            ))
        self.assertEqual(called["n"], 0, "含配方操作的撤销不得调用模型")
        self.assertEqual(blocked["status"], "no_ops")
        self.assertEqual(blocked["operations"], [])
        self.assertEqual(blocked["diff"], [])
        self.assertEqual(blocked["errors"], [])
        self.assertFalse(blocked["raw_has_ops"])
        self.assertEqual(blocked["model_calls"], 0)
        self.assertIn("撤销本次", blocked["summary"])
        self.assertIn("整批", blocked["summary"])
        # 完全不撤：普通节点的改动也要留着，绝不半撤混合批次
        self.assertEqual(blocked["next_snapshot"], normalize_snapshot(snapshot),
                         "混合批次必须原样不动，等整批 checkpoint 还原")
        self.assertEqual(blocked["next_snapshot"]["nodes"][0]["content"], "新")

        # 对照：同一批历史不含配方操作时，确定性撤销照常工作（守卫只拦配方批次）
        called["n"] = 0
        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            plain = asyncio.run(review_mod.review_graph(
                snapshot, "撤销刚才的修改，恢复原样",
                model=MODEL, phase="preset", mode="tools", self_check="off",
                previous_snapshot=previous,
                previous_ops=[{"op": "update_node", "id": "A", "patch": {"content": "新"}, "reason": "改"}],
            ))
        self.assertEqual(called["n"], 0)
        self.assertEqual(plain["status"], "undo")
        self.assertEqual(plain["next_snapshot"]["nodes"][0]["content"], "原")


class RecipeFocusAndPromptTest(unittest.TestCase):
    """焦点裁剪透传 recipe_detail；预设提示词/工具描述与合并契约口径一致。"""

    def test_focus_subgraph_carries_recipe_detail(self):
        nodes = [{"id": "n0", "kind": "knowledge", "label": "焦点"}]
        nodes += [{"id": f"n{i}", "kind": "knowledge", "label": f"节点{i}"} for i in range(1, 60)]
        detail = {"id": "recipe-1", "name": "错题复盘"}
        sub = _focus_subgraph({"nodes": nodes, "edges": [], "recipe_detail": detail}, ["n0"])
        self.assertIsNotNone(sub)
        self.assertLess(len(sub["nodes"]), len(nodes))
        self.assertEqual(sub["recipe_detail"], detail,
                         "大图降采样丢掉选中目标旧配置，局部合并就无从谈起")
        without = _focus_subgraph({"nodes": nodes, "edges": []}, ["n0"])
        self.assertNotIn("recipe_detail", without)

    def test_preset_prompt_and_tool_descriptions_aligned(self):
        from harness.prompts import HARNESS_PRESET_SYSTEM_PROMPT, build_preset_messages

        self.assertIn("recipe_detail", HARNESS_PRESET_SYSTEM_PROMPT)
        self.assertIn("后端递归合并保留未提交字段", HARNESS_PRESET_SYSTEM_PROMPT)
        self.assertIn("数组整体替换", HARNESS_PRESET_SYSTEM_PROMPT)
        self.assertIn("temp_recipe_id", HARNESS_PRESET_SYSTEM_PROMPT)
        self.assertIn("不要猜测后端分配的最终 ID", HARNESS_PRESET_SYSTEM_PROMPT)
        self.assertIn("没有该目标的 recipe_detail 时仍须整份提交", HARNESS_PRESET_SYSTEM_PROMPT)
        descs = {t["function"]["name"]: t["function"]["description"] for t in build_tools("preset")}
        self.assertIn("recipe_detail", descs["update_recipe"])
        self.assertIn("递归保留", descs["update_recipe"])
        # 快照带 recipe_detail 时随预设 user 消息进提示词，旧参数对模型可见
        normalized = normalize_snapshot(_snapshot_with_recipes(recipe_detail=_detail()))
        msgs = build_preset_messages(normalized, "把选中的配方改一下")
        self.assertEqual(len(msgs), 2)
        self.assertIn("recipe_detail", msgs[1]["content"])
        self.assertIn("错题复盘", msgs[1]["content"])
        self.assertIn("基础", msgs[1]["content"])


if __name__ == "__main__":
    unittest.main()
