"""画像回归：严格 xfail 保留已知缺陷，--runxfail 显示原始失败。

所有文件操作继承 RouteTestBase 的临时目录隔离。
"""

import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from test_routes import RouteTestBase  # noqa: E402

from server import profile as profile_mod  # noqa: E402


def _call(getter):
    try:
        return getter(), None
    except (ValueError, TypeError, OverflowError) as error:
        return None, error


class ReviewStage0ProfileTest(RouteTestBase):
    """画像数据一致性回归（M 线）。"""

    def _dev(self, tag):
        return f"dev_stage0_{tag}"

    # ---------- M1：整份回写覆盖并发变化 ----------

    def test_m1_manage_keeps_concurrent_fact_and_switch(self):
        dev = self._dev("m1")
        # 客户端 1（面板）：拿到快照，快照里只有学段事实
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        snapshot = profile_mod.get_profile(dev)
        fid = snapshot["facts"][0]["id"]

        # 客户端 2（后台采集/另一标签页）：固化新目标事实 + 关闭开关
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "目标：高考物理90分", "category": "goal"}])
        profile_mod.update_profile(dev, {"enabled": False})

        # 面板执行「删除学段事实」：走冻结契约的原子管理入口（POST /api/profile/manage
        # 的服务端实现），只发送 action+ID，不再整份回写旧快照
        r = profile_mod.manage_profile_fact(dev, "delete_fact", fid)
        self.assertTrue(r["accepted"], "关闭状态下用户主动管理仍应执行")
        self.assertEqual(r["changed"], 1)
        self.assertEqual(r["promoted"], [])

        final = profile_mod.get_profile(dev)
        # 并发固化的事实必须还在
        self.assertTrue(any("高考物理90分" in f["fact"] for f in final["facts"]),
                        f"并发新增事实被旧快照覆盖丢失：{final['facts']}")
        # 并发关闭的开关不得被旧值重新打开
        self.assertFalse(final["enabled"], "另一客户端关闭的开关被旧快照重新打开")

    # ---------- M2：已固化事实被 new 命中时计数可能不落盘 ----------

    def test_m2_repeat_new_on_solid_fact_counts_and_persists(self):
        dev = self._dev("m2")
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])

        r = profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "用户是高二学生", "category": "stage"}])
        self.assertEqual(r["changed"], 1, "重复命中已固化事实属于计数变化，应计 changed")

        p = profile_mod.get_profile(dev)
        f = p["facts"][0]
        self.assertEqual(f["occurrences"], 2, "重读磁盘 occurrences 应为 2")
        self.assertEqual(r["promoted"], [], "重复命中不产生新固化，promoted 应为空")

    def test_m2_control_mixed_batch_still_saves_count(self):
        """对照（当前约定行为）：混合批次里其他操作触发落盘时，重复 new 的计数随批次保存。"""
        dev = self._dev("m2c")
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "薄弱：电磁感应", "category": "weakness"}])
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "用户是高二学生", "category": "stage"},
            {"op": "new", "fact": "薄弱：微分方程", "category": "weakness"},
        ])
        p = profile_mod.get_profile(dev)
        solid = next(f for f in p["facts"] if "高二" in f["fact"])
        self.assertEqual(solid["occurrences"], 2)
        self.assertEqual({f["fact"] for f in p["pending"]}, {"薄弱：电磁感应", "薄弱：微分方程"})

    def test_m2_control_explicit_confirm_on_solid_counts(self):
        """对照：显式 confirm 命中已固化事实时 changed=1 且落盘（现行为已正确）。"""
        dev = self._dev("m2x")
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        fid = profile_mod.get_profile(dev)["facts"][0]["id"]
        r = profile_mod.apply_profile_ops(dev, [{"op": "confirm", "id": fid}])
        self.assertEqual(r["changed"], 1)
        self.assertEqual(profile_mod.get_profile(dev)["facts"][0]["occurrences"], 2)

    # ---------- M3：归档 removedAt 读取即丢 ----------

    def test_m3_archive_removedat_survives_read_and_unrelated_update(self):
        dev = self._dev("m3")
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        fid = profile_mod.get_profile(dev)["facts"][0]["id"]
        profile_mod.apply_profile_ops(dev, [{"op": "remove", "id": fid}])

        first = profile_mod.get_profile(dev)
        self.assertEqual(len(first["archive"]), 1)
        self.assertTrue(first["archive"][0].get("removedAt"),
                        "remove 刚落档的 removedAt 在读取时即丢失")

        # 无关更新（改 explicit）后再读：移除时间不得被完整归一化抹掉
        profile_mod.update_profile(dev, {"explicit": {"stage": "高三"}})
        again = profile_mod.get_profile(dev)
        self.assertTrue(again["archive"][0].get("removedAt"),
                        "无关更新后归档 removedAt 永久丢失")

    # ---------- M4：注入 factIds ≠ 实际展示事实 ----------

    @pytest.mark.xfail(strict=True, reason="M4: 同类超 5 条时 factIds 仍返回全部 6 条（正文只含 5 条）", raises=AssertionError)
    def test_m4_factids_match_sections_per_category_cap(self):
        dev = self._dev("m4")
        # 6 条同类（stage 一次直入）事实，正文按类别截前 5 条
        facts = [f"我是高二{i}班学生" for i in range(6)]
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": t, "category": "stage"} for t in facts])
        ctx = profile_mod.profile_context(dev)
        p = profile_mod.get_profile(dev)
        in_body = [f["id"] for f in p["facts"] if str(f["fact"])[:60] in ctx["text"]]
        self.assertEqual(sorted(ctx["factIds"]), sorted(in_body),
                         f"factIds({len(ctx['factIds'])}) 与实际进入正文的事实({len(in_body)})不一致")
        self.assertEqual(len(ctx["factIds"]), 5, "同类正文截 5 条后，factIds 不应再含第 6 条")

    @pytest.mark.xfail(strict=True, reason="M4: 与显式信息规范化重复的事实未进正文却返回其 ID", raises=AssertionError)
    def test_m4_factids_exclude_explicit_duplicates(self):
        dev = self._dev("m4b")
        profile_mod.update_profile(dev, {"explicit": {"stage": "我是高二学生"}})
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        ctx = profile_mod.profile_context(dev)
        p = profile_mod.get_profile(dev)
        self.assertEqual(len(p["facts"]), 1)
        self.assertNotIn(p["facts"][0]["id"], ctx["factIds"],
                         "与显式学段去重合并的事实不进正文，不应回写 lastUsedAt")

    @pytest.mark.xfail(strict=True, reason="M4: 小预算截断后补闭合标签可超 max_chars，且不保证返回合法最小结构", raises=AssertionError)
    def test_m4_tiny_budget_respects_max_chars(self):
        dev = self._dev("m4c")
        profile_mod.apply_profile_ops(dev, [
            {"op": "new", "fact": "我是高二学生", "category": "stage"},
            {"op": "new", "fact": "目标：高考物理90分", "category": "goal"},
        ])
        ctx = profile_mod.profile_context(dev, max_chars=20)
        text = ctx["text"]
        ok_empty = text == "" and ctx["factIds"] == []
        self.assertTrue(ok_empty or len(text) <= 20,
                        f"max_chars=20 时实际返回 {len(text)} 字：{text!r}")

    # ---------- M7：数值脏字段使读取崩溃 ----------

    def test_m7_dirty_numeric_fields_degrade_not_crash(self):
        dev = self._dev("m7")
        path = profile_mod._profile_path(dev)
        dirty = {
            "version": 2, "enabled": True,
            "explicit": {"stage": "高二", "goal": "", "interests": "", "weakAreas": "",
                         "style": {"detail": "标准", "jargon": "标准", "visuals": "否"}},
            "facts": [
                # 一条完全有效的事实：必须原样保留
                {"id": "pf_ok1", "fact": "我是高二学生", "category": "stage",
                 "occurrences": 2, "status": "active", "history": [],
                 "createdAt": 1700000000.0, "updatedAt": 1700000000.0, "lastUsedAt": 0},
                # 数字写成字符串（合法 JSON，但 int() 对 "3.5" 等仍可能抛）
                {"id": "pf_bad1", "fact": "脏数字串", "category": "other",
                 "occurrences": "三次", "status": "active", "history": [],
                 "createdAt": "昨天", "updatedAt": None, "lastUsedAt": ""},
                # 集合类型 + history 不可迭代
                {"id": "pf_bad2", "fact": "脏类型", "category": "other",
                 "occurrences": [1], "status": "active", "history": {"a": 1},
                 "createdAt": {"t": 1}, "updatedAt": [1], "lastUsedAt": True},
            ],
            "pending": [], "archive": [],
            "createdAt": 1700000000.0, "updatedAt": 1700000000.0,
        }
        path.write_text(json.dumps(dirty, ensure_ascii=False), encoding="utf-8")

        data, err = _call(lambda: profile_mod.get_profile(dev))
        self.assertIsNone(err, f"读取损坏画像不应崩溃：{err!r}")
        self.assertTrue(data["facts"], "有效事实必须保留")
        self.assertTrue(any(f["id"] == "pf_ok1" for f in data["facts"]),
                        "同文件内的有效事实不得被脏字段连坐丢弃")

    def test_m7_control_legacy_missing_fields_still_reads(self):
        """对照：旧数据缺字段（非脏值）仍可读——防止修复把兼容读坏。"""
        dev = self._dev("m7c")
        path = profile_mod._profile_path(dev)
        legacy = {"version": 1, "enabled": True,
                  "explicit": {"stage": "高一"},
                  "facts": [{"id": "pf_old", "fact": "喜欢几何"}],
                  "pending": [], "archive": []}
        path.write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
        p = profile_mod.get_profile(dev)
        self.assertEqual(p["facts"][0]["fact"], "喜欢几何")
        self.assertEqual(p["explicit"]["stage"], "高一")
