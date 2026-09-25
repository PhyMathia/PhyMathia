"""知识大陆 v9 向量证据（server/embedding.py + continent.py 向量通道）单测。

铁律（与 manual 对齐，改这里前先读 docs/dev/concept-continent.md 的 v9 段）：
- 门控只路由不证明：向量证据只进 cluster 的 domain* 字段，绝不产生 shared 条目；
- 查空是正常路径：card_sims 缺省/空表 → 投影与 v8 行为一致（embedEnabled=False）；
- 纯函数边界：build_continent 吃现成的 {itemId: {领域: 余弦}}，不加载模型、不读缓存。

本文件不加载真模型：向量模块的测试全部走「monkeypatch 假 embed 函数 + 临时缓存
文件」，评分与投影的测试直接注入假相似度表。真模型的质量验证是一次性脚本
（真实库四岛路由），不进 pytest——计时断言在别人机器上必然飘。
"""

import json
import os
import sys
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

import tempfile

from server import embedding
from server.continent import (  # noqa: E402
    GATE_EMBED_FLOOR,
    GATE_EMBED_TOPK,
    GATE_W_EMBED,
    GATE_W_FORMULA,
    GATE_WIDE_DOMAINS,
    _embed_pull,
    _gate_card_scores,
    build_continent,
)

S1, S2 = "sess_aaa", "sess_bbb"
SESSIONS = {
    S1: {"id": S1, "title": "随机现象", "updatedAt": 200},
    S2: {"id": S2, "title": "梯度", "updatedAt": 100},
}


def _item(iid, sid, title, created=0):
    return {"id": iid, "sessionId": sid, "title": title,
            "formulas": [], "createdAt": created}


# 词面零命中的标题（不在任何内置族术语里）——向量证据的主战场
_NOISE_TITLES = ("钟形曲线与三倍标准差", "计数过程的稀疏事件")


class EmbedPullTest(unittest.TestCase):
    """_embed_pull：下限截断 + top-K + 线性换算。"""

    def test_below_floor_never_pulls(self):
        self.assertEqual(_embed_pull({"概率统计": GATE_EMBED_FLOOR}), {})
        self.assertEqual(_embed_pull({"概率统计": 0.1}), {})
        self.assertEqual(_embed_pull(None), {})
        self.assertEqual(_embed_pull({}), {})

    def test_linear_pull_above_floor(self):
        pulls = _embed_pull({"概率统计": GATE_EMBED_FLOOR + 0.1})
        self.assertAlmostEqual(pulls["概率统计"], GATE_W_EMBED * 0.1)

    def test_topk_keeps_only_closest_families(self):
        sims = {f"族{i}": GATE_EMBED_FLOOR + 0.05 * (5 - i) for i in range(6)}
        pulls = _embed_pull(sims)
        self.assertEqual(len(pulls), GATE_EMBED_TOPK)
        # 留下的必须是最亲近的几个（余弦最高的前 K 名）
        for i in range(GATE_EMBED_TOPK):
            self.assertIn(f"族{i}", pulls)

    def test_ties_are_deterministic(self):
        sims = {f"族{i}": 0.6 for i in range(5)}
        a, b = _embed_pull(sims), _embed_pull(sims)
        self.assertEqual(sorted(a), sorted(b))


class GateScoresEmbedTest(unittest.TestCase):
    """_gate_card_scores 的向量通道：先验与公式指纹的边界。"""

    def setUp(self):
        self.term_df, self.n_scored, self.term_k = {}, 10, {}

    def test_embed_only_evidence_no_wide_prior(self):
        """宽领域先验只压词面/模型证据——向量独证时分数必须干净。"""
        dom = "概率统计"
        assert dom in GATE_WIDE_DOMAINS
        sims = {dom: GATE_EMBED_FLOOR + 0.2}
        scores = _gate_card_scores({}, set(), None, self.term_df, self.n_scored,
                                   self.term_k, embed_sims=sims)
        import math
        self.assertAlmostEqual(scores[dom], GATE_W_EMBED * 0.2)

    def test_fingerprint_does_not_fire_on_embed_only(self):
        """公式指纹不许跟向量证据搭车定归属（打平器语义：基底不含向量）。"""
        sims = {"量子力学": GATE_EMBED_FLOOR + 0.3}
        scores = _gate_card_scores({}, {"ψ"}, None, self.term_df, self.n_scored,
                                   self.term_k, embed_sims=sims)
        # 量子力学的分数必须恰好是向量拉动本身——指纹的 0.5 没有搭车
        self.assertAlmostEqual(scores["量子力学"], GATE_W_EMBED * 0.3)

    def test_fingerprint_still_fires_on_lexical_base(self):
        import math
        from server.continent import _term_specificity
        hits = {"矢量分析": ["梯度"]}
        scores = _gate_card_scores(hits, {"grad"}, None,
                                   {"梯度": 1}, 10, {"梯度": 1})
        expected_title = 1.0 * _term_specificity("梯度") * math.log(11.0)
        self.assertAlmostEqual(scores["矢量分析"],
                               expected_title + GATE_W_FORMULA, places=6)

    def test_wide_prior_applies_to_lexical_evidence(self):
        import math
        dom = "概率统计"
        hits = {dom: ["正态分布"]}
        scores = _gate_card_scores(hits, set(), None,
                                   {"正态分布": 1}, 10, {"正态分布": 1})
        base = scores[dom] - math.log(0.8)
        self.assertGreater(base, 0)
        self.assertAlmostEqual(scores[dom], base + math.log(0.8))


class BuildContinentEmbedTest(unittest.TestCase):
    """build_continent 的向量通道：只路由不证明 + 查空降级。"""

    def _base_items(self):
        return {
            "ki_1": _item("ki_1", S1, _NOISE_TITLES[0], created=1),
            "ki_2": _item("ki_2", S2, _NOISE_TITLES[1], created=2),
            "ki_3": _item("ki_3", S2, "梯度", created=3),
        }

    def _proj(self, items, card_sims):
        return build_continent(items, dict(SESSIONS), None, None, None,
                               card_sims=card_sims)

    def test_embed_routes_lexically_unmatched_islands(self):
        sims = {"ki_1": {"概率统计": 0.8}, "ki_2": {"概率统计": 0.7},
                "ki_3": {"矢量分析": 0.9}}
        proj = self._proj(self._base_items(), sims)
        self.assertTrue(proj["embedEnabled"])
        domains = {c["title"]: c["domain"] for c in proj["clusters"]}
        self.assertEqual(domains["随机现象"], "概率统计")
        self.assertEqual(domains["梯度"], "矢量分析")

    def test_embed_never_creates_shared_entries(self):
        """铁律「门控只路由不证明」：有无向量证据，shared 必须逐字节一致。"""
        items = self._base_items()
        no_embed = build_continent(items, dict(SESSIONS), None, None, None)
        with_embed = build_continent(items, dict(SESSIONS), None, None, None,
                                     card_sims={"ki_1": {"概率统计": 0.9},
                                                "ki_2": {"概率统计": 0.8},
                                                "ki_3": {"矢量分析": 0.9}})
        self.assertEqual(no_embed["shared"], with_embed["shared"])

    def test_missing_sims_degrades_silently(self):
        """查空是正常路径：不传/传空表/名单外领域名，投影都不炸。"""
        items = self._base_items()
        for sims in (None, {}, {"ki_1": {}}, {"ki_1": {"不存在的族": 0.9}}):
            proj = build_continent(items, dict(SESSIONS), None, None, None,
                                   card_sims=sims)
            self.assertFalse(proj["embedEnabled"])

    def test_dims_mismatch_scores_zero(self):
        self.assertEqual(embedding.cosine([1, 2], [1, 2, 3]), 0.0)
        self.assertEqual(embedding.cosine([], []), 0.0)
        self.assertEqual(embedding.cosine(None, None), 0.0)


class EmbeddingModuleTest(unittest.TestCase):
    """向量模块：缓存增量、总开关、族中心。全部用假 embed 函数，不碰真模型。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self._patcher = mock.patch.object(
            embedding, "_cache_path",
            lambda: Path(self._td.name) / "embedding_cache.json")
        self._patcher.start()

    def tearDown(self):
        self._patcher.stop()
        self._td.cleanup()

    def test_gather_caches_and_never_recomputes(self):
        calls = []

        def fake_embed(texts):
            calls.append(list(texts))
            return [[float(len(t)), 1.0] for t in texts]

        with mock.patch.object(embedding, "embed_texts", fake_embed):
            vecs, changed = embedding.gather_vectors({"a": "正态分布", "b": "泊松分布"})
            self.assertTrue(changed)
            self.assertEqual(vecs["a"], [4.0, 1.0])
            vecs2, changed2 = embedding.gather_vectors({"a": "正态分布", "b": "泊松分布"})
            self.assertFalse(changed2)   # 全部命中缓存，不再推理
            self.assertEqual(vecs2, vecs)
            self.assertEqual(len(calls), 1)  # 假函数只被调了一批

    def test_gather_changed_reports_only_new_texts(self):
        calls = []

        def fake_embed(texts):
            calls.append(list(texts))
            return [[1.0] for _ in texts]

        with mock.patch.object(embedding, "embed_texts", fake_embed):
            embedding.gather_vectors({"a": "旧文本"})
            vecs, changed = embedding.gather_vectors({"a": "旧文本", "b": "新文本"})
            self.assertTrue(changed)
            self.assertEqual(calls[-1], ["新文本"])  # 增量：只算没见过的

    def test_corrupt_cache_rebuilds(self):
        (Path(self._td.name) / "embedding_cache.json").write_text("not json{")
        with mock.patch.object(embedding, "embed_texts", lambda ts: [[1.0] for _ in ts]):
            vecs, changed = embedding.gather_vectors({"a": "任意"})
            self.assertTrue(changed)
            self.assertIn("a", vecs)

    def test_kill_switch_returns_none(self):
        with mock.patch.dict(os.environ, {"PHYMATHIA_EMBEDDING": "0"}):
            self.assertIsNone(embedding.embed_texts(["正态分布"]))

    def test_family_centroid_mean_and_normalize(self):
        fams = [{"canonical": "概率统计", "terms": ["正态分布", "期望"]}]
        key_vectors = {"概率统计": [3.0, 0.0], "正态分布": [1.0, 0.0], "期望": [2.0, 0.0]}
        out = embedding.family_centroid_vectors(fams, key_vectors)
        self.assertAlmostEqual(out["概率统计"][0], 1.0, places=5)
        self.assertAlmostEqual(out["概率统计"][1], 0.0, places=5)

    def test_family_centroid_skips_family_without_vectors(self):
        fams = [{"canonical": "有中心", "terms": ["甲"]},
                {"canonical": "没中心", "terms": ["乙"]}]
        out = embedding.family_centroid_vectors(fams, {"甲": [1.0, 0.0]})
        self.assertIn("有中心", out)
        self.assertNotIn("没中心", out)

    def test_card_vector_text_uses_title_plus_real_summary_only(self):
        import main as main_mod
        local = {"title": "标题", "summary": "模板文案", "summarySource": "local"}
        self.assertEqual(main_mod._card_vector_text(local), "标题")
        model = {"title": "标题", "summary": "真" * 300, "summarySource": "model"}
        text = main_mod._card_vector_text(model)
        self.assertTrue(text.startswith("标题\n"))
        self.assertEqual(len(text), len("标题") + 1 + embedding._CACHE_SUMMARY_CLIP)
        none_src = {"title": "标题", "summary": "旧数据无来源字段"}
        self.assertEqual(main_mod._card_vector_text(none_src), "标题")


if __name__ == "__main__":
    unittest.main()
