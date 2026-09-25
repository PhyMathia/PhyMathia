"""知识大陆 v10 语义找亲·补词建议（continent.family_term_suggestions）单测。

铁律（与 docs/dev/concept-continent.md 的 v10 段对齐）：
- 机器不自动落笔：本函数只产出建议清单，写路径只在用户确认后的 KV 通道；
- 查空是正常路径：向量缺席 / 候选全被卫生闸挡掉 → 空清单，不报错；
- 纯函数边界：items / families / card_sims 全部调用方喂参，不加载模型不读缓存。
  本文件不加载真模型（conftest 统一 PHYMATHIA_EMBEDDING=0），路由测试直接
  monkeypatch main._continent_card_sims 喂假相似度表。
"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server.continent import (  # noqa: E402
    FAMILY_SUGGEST_MARGIN,
    FAMILY_SUGGEST_MAX,
    GATE_EMBED_FLOOR,
    family_term_suggestions,
)
from server.family import BUILTIN_FAMILIES  # noqa: E402

PROB = "概率统计"


def _item(iid, title, sid="sess_a", created=0):
    return {"id": iid, "sessionId": sid, "title": title,
            "formulas": [], "createdAt": created}


# 词面零命中的标题（泊松岛配方）：气味指向概率统计，但标题里一个族术语都没有
_ZERO_HIT = {
    "k1": _item("k1", "泊松分布：稀疏事件的计数"),
    "k2": _item("k2", "测量误差：平方和的统计本性", sid="sess_b"),
}
# 同词条四张卡（「主题：副题」句式各不相同，提炼出的词条都是「泊松分布」）：
# 建议按证据数合并成一条，也是「拒绝后再提」的grow 场景素材
_SAME_TERM = {
    "k1": _item("k1", "泊松分布：稀疏事件的计数"),
    "k2": _item("k2", "泊松分布：保险精算的应用", sid="sess_b"),
    "k3": _item("k3", "泊松分布：放射性衰变的计数过程"),
    "k4": _item("k4", "泊松分布：排队论里的到达数", sid="sess_b"),
}


class FamilySuggestTest(unittest.TestCase):
    """补词建议的判据三闸：词面零命中 / 气味过地板且领先 / 词条过卫生闸。"""

    def test_zero_hit_high_sim_suggests_term(self):
        sims = {"k1": {PROB: 0.72, "微积分": 0.30},
                "k2": {PROB: 0.66, "微积分": 0.20}}
        out = family_term_suggestions(_ZERO_HIT, BUILTIN_FAMILIES, sims)
        by_term = {s["term"]: s for s in out}
        self.assertIn("泊松分布", by_term)
        self.assertEqual(by_term["泊松分布"]["family"], PROB)
        self.assertIn("测量误差", by_term)

    def test_same_term_cards_merge_into_one_suggestion(self):
        sims = {iid: {PROB: 0.70} for iid in _SAME_TERM}
        out = family_term_suggestions(_SAME_TERM, BUILTIN_FAMILIES, sims)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["term"], "泊松分布")
        self.assertEqual(len(out[0]["cards"]), 4)

    def test_lexical_hit_is_someone_elses_business(self):
        # 标题已命中族术语（正态分布 ∈ 概率统计）：族表没漏词，不归建议管
        items = {"k1": _item("k1", "正态分布与钟形曲线")}
        sims = {"k1": {PROB: 0.9}}
        self.assertEqual(family_term_suggestions(items, BUILTIN_FAMILIES, sims), [])

    def test_below_floor_excluded(self):
        sims = {"k1": {PROB: round(GATE_EMBED_FLOOR - 0.01, 3)}}
        self.assertEqual(family_term_suggestions(
            {"k1": _ZERO_HIT["k1"]}, BUILTIN_FAMILIES, sims), [])

    def test_ambiguous_margin_excluded(self):
        # 与次高族差 < FAMILY_SUGGEST_MARGIN：双族暧昧的卡不配当证据
        sims = {"k1": {PROB: 0.60, "微积分": round(0.60 - FAMILY_SUGGEST_MARGIN + 0.01, 3)}}
        self.assertEqual(family_term_suggestions(
            {"k1": _ZERO_HIT["k1"]}, BUILTIN_FAMILIES, sims), [])

    def test_term_hitting_other_family_excluded(self):
        # 提议词条在词面上误伤别的族（含「积分」→ 微积分）：进表会把未来的卡拉歪
        # （均匀分布岛那次误伤的配方）
        items = {"k1": _item("k1", "概率积分变换")}
        sims = {"k1": {PROB: 0.75}}
        self.assertEqual(family_term_suggestions(items, BUILTIN_FAMILIES, sims), [])

    def test_function_char_and_generic_terms_excluded(self):
        # 功能字碎片（「随机的漫步」含「的」）与裸泛词（「变换」）永不建议进表
        items = {"k1": _item("k1", "随机的漫步：布朗运动初探"),
                 "k2": _item("k2", "变换：从一个视角")}
        sims = {"k1": {PROB: 0.7}, "k2": {PROB: 0.7}}
        out = family_term_suggestions(items, BUILTIN_FAMILIES, sims)
        self.assertEqual([s["term"] for s in out], [])

    def test_empty_sims_returns_empty(self):
        self.assertEqual(family_term_suggestions(_ZERO_HIT, BUILTIN_FAMILIES, {}), [])

    def test_empty_families_returns_empty(self):
        sims = {"k1": {PROB: 0.72}}
        self.assertEqual(family_term_suggestions(_ZERO_HIT, [], sims), [])


class SuggestRejectMemoryTest(unittest.TestCase):
    """拒绝记录：证据没长出来闭嘴（防骚扰），长出超过 REGROW 的新卡才重新开口。"""

    SIMS = {iid: {PROB: 0.70} for iid in _SAME_TERM}

    def test_rejected_evidence_suppressed(self):
        # 拒过时 2 张卡，现在还是 4 张（≤ 2+REGROW）：闭嘴
        rejected = {PROB: {"泊松分布": {"cards": 2, "at": 1}}}
        out = family_term_suggestions(_SAME_TERM, BUILTIN_FAMILIES, self.SIMS,
                                      rejected=rejected)
        self.assertEqual([s["term"] for s in out if s["term"] == "泊松分布"], [])

    def test_regrown_evidence_resurfaces_with_flag(self):
        # 拒过时只有 1 张卡，现在 4 张（> 1+REGROW）：重新开口，并带上 regrown 标记
        rejected = {PROB: {"泊松分布": {"cards": 1, "at": 1}}}
        out = family_term_suggestions(_SAME_TERM, BUILTIN_FAMILIES, self.SIMS,
                                      rejected=rejected)
        flagged = [s for s in out if s["term"] == "泊松分布"]
        self.assertEqual(len(flagged), 1)
        self.assertTrue(flagged[0]["regrown"])
        self.assertEqual(len(flagged[0]["cards"]), 4)

    def test_suppression_does_not_eat_the_cap(self):
        # 13 个互不相同、都过卫生闸的候选：截断到上限；压掉其中一条后，
        # 第 13 名顶上来——名额仍是 FAMILY_SUGGEST_MAX（压制在截断之前）
        names = ["泊松", "二项", "几何", "超几何", "指数", "伽马", "贝塔",
                 "卡方", "威布尔", "瑞利", "负二项", "均匀", "极值"]
        items = {f"k{i}": _item(f"k{i}", f"{n}分布：随机现象{i}")
                 for i, n in enumerate(names)}
        sims = {f"k{i}": {PROB: 0.7} for i in range(len(names))}
        full = family_term_suggestions(items, BUILTIN_FAMILIES, sims)
        self.assertEqual(len(full), FAMILY_SUGGEST_MAX)
        self._kv = {PROB: {"泊松分布": {"cards": 1, "at": 1}}}
        trimmed = family_term_suggestions(items, BUILTIN_FAMILIES, sims,
                                          rejected=self._kv)
        self.assertEqual(len(trimmed), FAMILY_SUGGEST_MAX)
        self.assertNotIn("泊松分布", {s["term"] for s in trimmed})


class SuggestRouteTest(unittest.TestCase):
    """GET /api/families/suggestions：向量缺席 → 空清单（降级是正常路径）；
    向量在场（假相似度表）→ 建议随响应下发；拒绝记录 KV 被路由消费。"""

    def setUp(self):
        from fastapi.testclient import TestClient
        from server import storage as storage_mod
        import main as main_mod  # src/main.py（与 test_routes.py 同一导入口径）
        self._td = tempfile.TemporaryDirectory()
        self._main = main_mod
        self._storage = storage_mod
        self._orig_kp = main_mod.KNOWLEDGE_PATH
        main_mod.KNOWLEDGE_PATH = Path(self._td.name) / "knowledge.json"
        self._orig_kv = storage_mod.kv_all_data
        self._kv = {}
        storage_mod.kv_all_data = lambda: dict(self._kv)
        self.client = TestClient(main_mod.app)

    def tearDown(self):
        self._main.KNOWLEDGE_PATH = self._orig_kp
        self._storage.kv_all_data = self._orig_kv
        self._td.cleanup()

    def _seed(self, items):
        self._main.KNOWLEDGE_PATH.write_text(
            json.dumps(items, ensure_ascii=False), encoding="utf-8")

    def test_embed_absent_returns_empty_and_disabled(self):
        self._seed({"k1": _item("k1", "泊松分布：稀疏事件的计数")})
        with mock.patch.object(self._main, "_continent_card_sims",
                               return_value=({}, False)):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"suggestions": [], "embedEnabled": False})

    def test_fake_sims_flow_through_route(self):
        self._seed({"k1": _item("k1", "泊松分布：稀疏事件的计数")})
        sims = {"k1": {PROB: 0.72, "微积分": 0.30}}
        with mock.patch.object(self._main, "_continent_card_sims",
                               return_value=(sims, True)):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["embedEnabled"])
        self.assertEqual(data["suggestions"][0]["term"], "泊松分布")
        self.assertEqual(data["suggestions"][0]["family"], PROB)

    def test_rejected_kv_read_by_route(self):
        self._seed({"k1": _item("k1", "泊松分布：稀疏事件的计数")})
        self._kv["continent_family_suggestions"] = {
            "version": 1, "rejected": {PROB: {"泊松分布": {"cards": 1, "at": 1}}}}
        sims = {"k1": {PROB: 0.72}}
        with mock.patch.object(self._main, "_continent_card_sims",
                               return_value=(sims, True)):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["suggestions"], [])


if __name__ == "__main__":
    unittest.main()
