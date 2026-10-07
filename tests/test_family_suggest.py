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
    FAMILY_CLUSTER_MIN_CARDS,
    FAMILY_CLUSTER_POOL_CAP,
    FAMILY_SUGGEST_MARGIN,
    FAMILY_SUGGEST_MAX,
    GATE_EMBED_FLOOR,
    family_cluster_suggestions,
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


class FamilyClusterTest(unittest.TestCase):
    """新族候选（v10 第二期）：无主（离所有族都远）+ 抱团（两两相似）+ 成色（均聚）。"""

    def setUp(self):
        # 四张词面零命中的卡：三张是博弈论（彼此向量近），一张离群的（向量朝另一方向）
        self.items = {
            "g1": _item("g1", "纳什均衡与策略选择"),
            "g2": _item("g2", "囚徒困境：合作与背叛的推演", sid="sess_b"),
            "g3": _item("g3", "占优策略与重复博弈"),
            "x1": _item("x1", "音乐声学：频率与音色"),
        }
        e = [1.0, 0.0]
        self.vecs = {
            "g1": [0.98, 0.2], "g2": [1.0, 0.1], "g3": [0.95, 0.25],
            "x1": [0.05, 1.0],
        }
        # 无主：对每个族的余弦都低于地板（用低于 GATE_EMBED_FLOOR 的假表表达）
        self.no_sims = {iid: {PROB: 0.30} for iid in self.items}

    def test_tight_cluster_detected(self):
        out = family_cluster_suggestions(self.items, BUILTIN_FAMILIES,
                                         self.no_sims, self.vecs)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["size"], 3)
        self.assertEqual({c["id"] for c in out[0]["cards"]}, {"g1", "g2", "g3"})
        self.assertTrue(out[0]["key"])  # 稳定指纹存在

    def test_cluster_key_is_stable(self):
        a = family_cluster_suggestions(self.items, BUILTIN_FAMILIES, self.no_sims, self.vecs)
        b = family_cluster_suggestions(self.items, BUILTIN_FAMILIES, self.no_sims, self.vecs)
        self.assertEqual(a[0]["key"], b[0]["key"])

    def test_lexically_owned_card_not_candidate(self):
        # g1 标题里出现族术语（随机变量 ∈ 概率统计）：词面已认领，不进无主池——
        # 剩下 g2/g3 两张不成簇 → 空清单
        items = dict(self.items)
        items["g1"] = _item("g1", "随机变量与纳什均衡")
        out = family_cluster_suggestions(items, BUILTIN_FAMILIES, self.no_sims, self.vecs)
        self.assertEqual(out, [])

    def test_pair_too_small(self):
        items = {"g1": self.items["g1"], "g2": self.items["g2"]}
        out = family_cluster_suggestions(items, BUILTIN_FAMILIES,
                                         {iid: {PROB: 0.30} for iid in items},
                                         {k: self.vecs[k] for k in items})
        self.assertEqual(out, [], f"少于 {FAMILY_CLUSTER_MIN_CARDS} 张卡不成簇")

    def test_loose_chain_rejected(self):
        # 链式松簇：a-b 近（0.71）、b-c 近（0.71）、a-c 远（0）——能连成连通分量，
        # 但簇内平均相似度低于成色线，不算一伙
        vecs = {"a": [1.0, 0.0, 0.0], "b": [0.7071, 0.7071, 0.0], "c": [0.0, 1.0, 0.0]}
        items = {k: _item(k, f"未知主题{k}") for k in vecs}
        sims = {k: {PROB: 0.30} for k in vecs}
        self.assertEqual(family_cluster_suggestions(items, BUILTIN_FAMILIES, sims, vecs), [])

    def test_family_similar_card_excluded(self):
        # x1 虽然词面零命中，但气味过地板（属于概率统计）——补词建议的地盘
        sims = dict(self.no_sims)
        sims["x1"] = {PROB: round(GATE_EMBED_FLOOR + 0.05, 3)}
        out = family_cluster_suggestions(self.items, BUILTIN_FAMILIES, sims, self.vecs)
        self.assertEqual(len(out), 1)
        self.assertNotIn("x1", [c["id"] for c in out[0]["cards"]])

    def test_junk_title_excluded(self):
        # g2 换成章节号标题：不当证据来源——剩下 g1/g3 两张不成簇 → 空清单
        items = dict(self.items)
        items["g2"] = _item("g2", "1. 纳什均衡的定义", sid="sess_b")
        out = family_cluster_suggestions(items, BUILTIN_FAMILIES, self.no_sims, self.vecs)
        self.assertEqual(out, [])

    def test_no_vecs_returns_empty(self):
        self.assertEqual(family_cluster_suggestions(self.items, BUILTIN_FAMILIES,
                                                    self.no_sims, {}), [])

    def test_no_families_returns_empty(self):
        self.assertEqual(family_cluster_suggestions(self.items, [],
                                                    self.no_sims, self.vecs), [])

    def test_pool_cap_bounded(self):
        # 无主池超过上限（向量通道异常把全库判成无主）→ 整体放弃，有界退化
        n = FAMILY_CLUSTER_POOL_CAP + 1
        items = {f"k{i}": _item(f"k{i}", f"未知主题{i}") for i in range(n)}
        vecs = {f"k{i}": [float(i % 5), float(i % 3), 1.0] for i in range(n)}
        sims = {f"k{i}": {PROB: 0.30} for i in range(n)}
        self.assertEqual(family_cluster_suggestions(items, BUILTIN_FAMILIES, sims, vecs), [])

    def test_summary_only_real_source(self):
        items = dict(self.items)
        items["g1"] = dict(self.items["g1"], summary="模板文案",
                           summarySource="local")
        out = family_cluster_suggestions(items, BUILTIN_FAMILIES, self.no_sims, self.vecs)
        g1 = next(c for c in out[0]["cards"] if c["id"] == "g1")
        self.assertEqual(g1["summary"], "")
        items["g1"] = dict(self.items["g1"], summary="真摘要",
                           summarySource="model")
        out = family_cluster_suggestions(items, BUILTIN_FAMILIES, self.no_sims, self.vecs)
        g1 = next(c for c in out[0]["cards"] if c["id"] == "g1")
        self.assertEqual(g1["summary"], "真摘要")


class SuggestRouteTest(unittest.TestCase):
    """GET /api/families/suggestions：向量缺席 → 双空清单（降级是正常路径）；
    向量在场（假相似度/假向量表）→ 补词与新族候选随响应下发；拒绝记录 KV 被消费。"""

    def setUp(self):
        from fastapi.testclient import TestClient
        from server import accounts as accounts_mod
        from server import config as config_mod
        from server import storage as storage_mod
        import main as main_mod  # src/main.py（与 test_routes.py 同一导入口径）
        self._td = tempfile.TemporaryDirectory()
        self._main = main_mod
        self._storage = storage_mod
        # 多账号 P1：路由经 accounts.resolve_paths 读知识库/KV，patch DATA_DIR 一处
        self._config_mod = config_mod
        self._accounts_mod = accounts_mod
        self._orig_data_dir = config_mod.DATA_DIR
        config_mod.DATA_DIR = Path(self._td.name)
        accounts_mod._ENSURED.clear()
        self.kp = Path(self._td.name) / "users" / "default" / "knowledge.json"
        self.kp.parent.mkdir(parents=True, exist_ok=True)
        self.kp.write_text("{}", encoding="utf-8")
        self._orig_kv = storage_mod.kv_all_data
        self._kv = {}
        storage_mod.kv_all_data = lambda account="default": dict(self._kv)
        self.client = TestClient(main_mod.app)

    def tearDown(self):
        self._storage.kv_all_data = self._orig_kv
        self._config_mod.DATA_DIR = self._orig_data_dir
        self._accounts_mod._ENSURED.clear()
        self._td.cleanup()

    def _seed(self, items):
        self.kp.write_text(
            json.dumps(items, ensure_ascii=False), encoding="utf-8")

    def test_embed_absent_returns_empty_and_disabled(self):
        self._seed({"k1": _item("k1", "泊松分布：稀疏事件的计数")})
        with mock.patch.object(self._main, "_continent_vectors",
                               return_value=({}, {})):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(),
                         {"suggestions": [], "clusters": [], "embedEnabled": False})

    def test_fake_sims_flow_through_route(self):
        self._seed({"k1": _item("k1", "泊松分布：稀疏事件的计数")})
        sims = {"k1": {PROB: 0.72, "微积分": 0.30}}
        vecs = {"k1": [1.0, 0.0]}
        with mock.patch.object(self._main, "_continent_vectors",
                               return_value=(sims, vecs)):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["embedEnabled"])
        self.assertEqual(data["suggestions"][0]["term"], "泊松分布")
        self.assertEqual(data["suggestions"][0]["family"], PROB)
        self.assertEqual(data["clusters"], [])  # 单卡不成簇

    def test_rejected_kv_read_by_route(self):
        self._seed({"k1": _item("k1", "泊松分布：稀疏事件的计数")})
        self._kv["continent_family_suggestions"] = {
            "version": 1, "rejected": {PROB: {"泊松分布": {"cards": 1, "at": 1}}}}
        sims = {"k1": {PROB: 0.72}}
        with mock.patch.object(self._main, "_continent_vectors",
                               return_value=(sims, {"k1": [1.0, 0.0]})):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["suggestions"], [])

    def test_clusters_flow_through_route(self):
        titles = ["纳什均衡与策略选择", "囚徒困境：合作与背叛的推演", "占优策略与重复博弈"]
        items = {f"g{i}": _item(f"g{i}", t) for i, t in enumerate(titles)}
        self._seed(items)
        sims = {f"g{i}": {PROB: 0.30} for i in range(3)}
        vecs = {"g0": [1.0, 0.0], "g1": [0.98, 0.17], "g2": [0.95, 0.31]}
        with mock.patch.object(self._main, "_continent_vectors",
                               return_value=(sims, vecs)):
            resp = self.client.get("/api/families/suggestions")
        self.assertEqual(resp.status_code, 200)
        clusters = resp.json()["clusters"]
        self.assertEqual(len(clusters), 1)
        self.assertEqual(clusters[0]["size"], 3)
        self.assertEqual([c["id"] for c in clusters[0]["cards"]], ["g0", "g1", "g2"])


if __name__ == "__main__":
    unittest.main()
