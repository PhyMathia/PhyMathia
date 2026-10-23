# -*- coding: utf-8 -*-
"""v8.14 海域粗粒度层：细族 → 海域 折叠的契约。

三个不变量（改折叠语义前先读 docs/dev/concept-continent.md「v8.14 海域粗粒度层」）：
1. 细族层是证据语言：domainList / gateVersion / gate KV 打标口径全部保持细族，
   折叠表不进 gateVersion（换海域划分不作废 Φ 打标）；
2. 折叠发生在卡级评分 softmax 之前，语义是**海内取最强细族、海间比强弱**
   （求和会让宽海靠族多吸卡，实测卡方岛被数学分析吸走）；domain* 四字段装海域键；
3. 恒等折叠（sea_map 缺席/空表）与不折叠逐字节一致。
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))

from server import family, storage  # noqa: E402
from server.continent import _maxfold_by_sea, build_continent  # noqa: E402


def _item(iid, sid, title, formulas=None, created=0):
    return {"id": iid, "sessionId": sid, "title": title,
            "formulas": formulas or [], "category": "", "createdAt": created}


FOLD = {"静电场": "电磁学", "电磁感应": "电磁学", "矢量分析": "数学物理与应用数学"}

SESS = {
    "sess_e1": {"id": "sess_e1", "title": "电容", "sessionId": "p1", "updatedAt": 100},
    "sess_e2": {"id": "sess_e2", "title": "自感", "sessionId": "p2", "updatedAt": 200},
    "sess_g1": {"id": "sess_g1", "title": "梯度", "sessionId": "p3", "updatedAt": 300},
}


class BuiltinSeaMapTest(unittest.TestCase):
    """内置映射表自身的完整性：30 族全部有归属、值都是真折叠。"""

    def test_every_builtin_family_has_exactly_one_sea(self):
        canon = {f["canonical"] for f in family.BUILTIN_FAMILIES}
        # 数论是刻意的单族海：族名即海名，恒等不进映射表
        identity_by_design = {"数论"}
        self.assertEqual(set(family.BUILTIN_SEA_MAP) | identity_by_design, canon,
                         "BUILTIN_SEA_MAP 与 BUILTIN_FAMILIES 必须对得上"
                         "（漏键且非单族海＝该族被遗忘，多键＝指向不存在的族）")

    def test_no_identity_entries_and_expected_sea_count(self):
        for f, s in family.BUILTIN_SEA_MAP.items():
            self.assertNotEqual(f, s, "内置表里不许有恒等条目（不在表里＝恒等，独立成海是用户的权利）")
        # 默认海域宇宙 = 折叠目标 ∪ 未折叠细族自身，应为 15 片
        seas = set(family.BUILTIN_SEA_MAP.values())
        canon = {f["canonical"] for f in family.BUILTIN_FAMILIES}
        seas |= canon - set(family.BUILTIN_SEA_MAP)
        self.assertEqual(len(seas), 15)


class MaxFoldTest(unittest.TestCase):
    """海内取 max 不求和：宽海不许靠族多吸卡。"""

    def test_max_not_sum(self):
        # 数学分析 3 族各拿一点 vs 概率与统计单族更强 → 概率与统计必须赢
        scores = {"微积分": 0.9, "傅里叶分析": 0.8, "复变函数": 0.7, "概率统计": 1.5}
        fold = {"微积分": "数学分析", "傅里叶分析": "数学分析",
                "复变函数": "数学分析", "概率统计": "概率与统计"}
        out = _maxfold_by_sea(scores, fold)
        self.assertEqual(out, {"数学分析": 0.9, "概率与统计": 1.5})

    def test_empty_fold_is_identity_and_unknown_keys_pass_through(self):
        scores = {"a": 1.0}
        self.assertIs(_maxfold_by_sea(scores, {}), scores)
        self.assertEqual(_maxfold_by_sea({"x": 1.0, "静电场": 2.0}, FOLD),
                         {"x": 1.0, "电磁学": 2.0})


class ResolveSeaMapTest(unittest.TestCase):
    """KV continent_seas：稀疏覆盖内置；独立成海＝删键；脏数据照常返回别报错。"""

    NAMES = [f["canonical"] for f in family.BUILTIN_FAMILIES]

    def test_builtin_defaults_filtered_by_accepted(self):
        fold = family.resolve_sea_map(None, self.NAMES)
        self.assertEqual(fold, family.BUILTIN_SEA_MAP)

    def test_user_override_wins(self):
        fold = family.resolve_sea_map({"map": {"静电场": "量子物理"}}, self.NAMES)
        self.assertEqual(fold["静电场"], "量子物理")
        self.assertEqual(fold["电磁感应"], "电磁学")  # 未触的键照走内置

    def test_independent_sea_removes_key(self):
        fold = family.resolve_sea_map({"map": {"静电场": "静电场"}}, self.NAMES)
        self.assertNotIn("静电场", fold)
        self.assertIn("电磁感应", fold)

    def test_dirty_payload_returned_empty_not_raised(self):
        for bad in (None, [], "x", 42, {"map": "x"}, {"map": {"静电场": ""}},
                    {"map": {"不存在的族": "某海"}}, {"map": {None: "某海"}}):
            self.assertEqual(family.sea_map_from_payload(bad, self.NAMES), {})

    def test_bare_dict_shape_accepted(self):
        self.assertEqual(family.sea_map_from_payload({"静电场": "量子物理"}, self.NAMES),
                         {"静电场": "量子物理"})


class FoldRouteTest(unittest.TestCase):
    """折叠过投影：domain 装海域键、seaList/seaMap 随投影下发、恒等折叠逐字节一致。"""

    def _items(self):
        return {
            "k1": _item("k1", "sess_e1", "电容的定义与几何属性", created=1),
            "k2": _item("k2", "sess_e2", "自感与互感", created=2),
            "k3": _item("k3", "sess_g1", "梯度的几何意义", created=3),
        }

    def test_domain_fields_carry_sea_keys(self):
        out = build_continent(self._items(), SESS, sea_map=FOLD)
        rows = {c["sessionId"]: c for c in out["clusters"]}
        self.assertEqual(rows["sess_e1"]["domain"], "电磁学")
        self.assertEqual(rows["sess_e2"]["domain"], "电磁学")
        self.assertEqual(rows["sess_g1"]["domain"], "数学物理与应用数学")
        # 次要领域同样是海域键（岛名命中的细族也折叠了）
        for row in rows.values():
            for d in row["domains"]:
                self.assertNotIn(d["name"], FOLD)

    def test_identity_fold_is_fine_keys(self):
        out = build_continent(self._items(), SESS)
        rows = {c["sessionId"]: c for c in out["clusters"]}
        self.assertEqual(rows["sess_e1"]["domain"], "静电场")
        self.assertEqual(rows["sess_g1"]["domain"], "矢量分析")

    def test_sea_list_and_sea_map_in_payload(self):
        out = build_continent(self._items(), SESS, sea_map=FOLD)
        # 折走的细族键不再出现在海域名单里；名单按生效族表序去重
        self.assertNotIn("静电场", out["seaList"])
        self.assertIn("电磁学", out["seaList"])
        self.assertEqual(len(out["seaList"]), len(set(out["seaList"])))
        self.assertEqual(out["seaMap"], FOLD)

    def test_fold_does_not_touch_gate_version(self):
        v_plain = build_continent(self._items(), SESS)["gateVersion"]
        v_folded = build_continent(self._items(), SESS, sea_map=FOLD)["gateVersion"]
        self.assertEqual(v_plain, v_folded,
                         "折叠表不进门控版本指纹——换海域划分不作废存量 Φ 打标")

    def test_domain_list_stays_fine_grained(self):
        out = build_continent(self._items(), SESS, sea_map=FOLD)
        self.assertIn("静电场", out["domainList"])  # Φ 打标名单保持细族口径
        self.assertNotIn("电磁学", out["domainList"])


class SeaLevelAbstainTest(unittest.TestCase):
    """L1 岛级弃权（2026-10-23 计划）：margin/consensus 按**海域**算，不是细族。

    同一座岛两张卡各只认一个细族（电容→静电场、自感→电磁感应）：细族口径 50:50
    平局该弃权；折进「电磁学」后 consensus/margin 全满该保留——折叠改变判定结论
    本身就是「按海域算」的证据。
    """

    def test_same_sea_split_kept_identity_split_abstains(self):
        items = {
            "k1": _item("k1", "sess_x", "电容的定义", created=1),
            "k2": _item("k2", "sess_x", "自感与互感", created=2),
        }
        sess = {"sess_x": {"id": "sess_x", "title": "随手记", "sessionId": "p1", "updatedAt": 1}}
        plain = build_continent(items, sess)["clusters"][0]
        folded = build_continent(items, sess, sea_map=FOLD)["clusters"][0]
        self.assertIsNone(plain["domain"], "细族 50:50 平局该弃权")
        self.assertEqual(plain["domainMargin"], 0.0)
        self.assertEqual(folded["domain"], "电磁学")
        self.assertEqual(folded["domainMargin"], 1.0)
        self.assertEqual(folded["domainConsensus"], 1.0)


class MaterialsMechanicsFamilyTest(unittest.TestCase):
    """L2（2026-10-23 分类质量计划 / backlog T347）：材料力学细族进表、折进力学海。

    混词护栏：术语全词收——「泊松比」只属材料力学，「泊松分布」不许把卡带进材料力学。
    """

    def test_terms_hit_only_materials_family(self):
        prepared = family.prepare_families(family.BUILTIN_FAMILIES)
        self.assertEqual(family.match_families("泊松比", prepared), ["材料力学"])
        self.assertNotIn("材料力学", family.match_families("泊松分布", prepared))
        for title in ("杨氏模量与弹性模量", "正应力与正应变", "切应力与切应变",
                      "胡克定律", "弯曲与扭转", "弯矩与惯性矩", "强度理论", "屈服"):
            self.assertIn("材料力学", family.match_families(title, prepared),
                          "标题该命中材料力学：%s" % title)

    def test_materials_folds_into_mechanics_sea(self):
        fold = family.resolve_sea_map(None, [f["canonical"] for f in family.BUILTIN_FAMILIES])
        self.assertEqual(fold["材料力学"], "力学", "材料力学必须折进力学海（不新增海域）")

    def test_family_view_lists_materials(self):
        view = family.families_view(None)
        fam = next((f for f in view["families"] if f["canonical"] == "材料力学"), None)
        self.assertIsNotNone(fam, "族表编辑视图（/api/families）该显示材料力学")
        self.assertEqual(fam["source"], "builtin")
        self.assertGreaterEqual(len(fam["terms"]), 18)


class SeaKvRoutingTest(unittest.TestCase):
    """continent_seas 与族表同住 meta/continent.json（备份导入自动带走）。"""

    def test_solo_key_routed_to_continent_meta_file(self):
        path = storage._kv_target_path("continent_seas")
        self.assertIsNotNone(path)
        self.assertEqual(path.name, "continent.json")
        self.assertIn("continent_seas", storage._KV_SOLO_KEYS)


if __name__ == "__main__":
    unittest.main()
