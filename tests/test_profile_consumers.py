"""记忆第二步「用起来」：画像的两个新消费方。

1. profile_review_digest → Φ 快照 user_profile（harness api 注入）
2. profile_weak_terms → 概念检索薄弱加权（concept.match_concept_details）

铁律断言：概念侧「只重排、不放水」——薄弱词绝不把零交集条目带过检索闸门；
weak_terms 为空时行为与不传逐字节一致。
"""

import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from server import concept as concept_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


def _make_profile(device_id: str, **fields):
    """按测试需要直接落一份画像（save_profile 原样写盘，读侧 normalize 补默认）。"""
    storage_mod._JSON_READ_CACHE.clear()
    profile_mod.PROFILES_DIR.mkdir(parents=True, exist_ok=True)
    profile_mod.save_profile(device_id, fields)
    storage_mod._JSON_READ_CACHE.clear()


class ProfileDigestTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self._orig_dir = profile_mod.PROFILES_DIR
        profile_mod.PROFILES_DIR = Path(self._td.name)

    def tearDown(self):
        profile_mod.PROFILES_DIR = self._orig_dir
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()

    def test_digest_one_line_no_brackets(self):
        _make_profile("dev1", enabled=True, explicit={
            "stage": "高中", "goal": "考研", "weakAreas": "等时性", "interests": "",
            "style": {"detail": "详细", "jargon": "标准", "visuals": "否"},
        })
        digest = profile_mod.profile_review_digest("dev1")
        self.assertTrue(digest)
        self.assertNotIn("【", digest)
        self.assertIn("学段：高中", digest)
        self.assertIn("目标：考研", digest)
        self.assertIn("薄弱：等时性", digest)
        self.assertIn("偏好：详略=详细", digest)

    def test_digest_disabled_or_empty_is_blank(self):
        _make_profile("dev2", enabled=False, explicit={"stage": "高中"})
        self.assertEqual(profile_mod.profile_review_digest("dev2"), "")
        _make_profile("dev3", enabled=True, explicit={"stage": "", "goal": "", "weakAreas": "", "interests": ""})
        self.assertEqual(profile_mod.profile_review_digest("dev3"), "")
        self.assertEqual(profile_mod.profile_review_digest(""), "")

    def test_digest_budget_drops_tail_sections(self):
        _make_profile("dev4", enabled=True, explicit={
            "stage": "高中",
            "goal": "考研",
            "weakAreas": "",
            "interests": "天体物理" * 10,
        }, facts=[
            {"id": "f1", "fact": "x" * 60, "category": "other", "status": "active",
             "occurrences": 1, "updatedAt": 1},
        ])
        digest = profile_mod.profile_review_digest("dev4", max_chars=40)
        self.assertLessEqual(len(digest), 40)
        # 从尾部整节丢弃：学段（最重要）必须保留
        self.assertTrue(digest.startswith("学段："))


class ProfileWeakTermsTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self._orig_dir = profile_mod.PROFILES_DIR
        profile_mod.PROFILES_DIR = Path(self._td.name)

    def tearDown(self):
        profile_mod.PROFILES_DIR = self._orig_dir
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()

    def test_explicit_and_facts_split_dedupe_and_strip_prefix(self):
        _make_profile("dev1", enabled=True, explicit={
            "stage": "", "goal": "", "interests": "",
            "weakAreas": "等时性、傅里叶变换",
        }, facts=[
            {"id": "f1", "fact": "检测多次答错：单摆", "category": "weakness", "status": "active",
             "occurrences": 2, "updatedAt": 2},
            {"id": "f2", "fact": "等时性", "category": "weakness", "status": "active",
             "occurrences": 1, "updatedAt": 1},
            {"id": "f3", "fact": "喜欢图像化解释", "category": "interest", "status": "active",
             "occurrences": 3, "updatedAt": 3},
        ])
        self.assertEqual(
            profile_mod.profile_weak_terms("dev1"),
            ["等时性", "傅里叶变换", "单摆"],
        )

    def test_disabled_or_empty(self):
        _make_profile("dev2", enabled=False, explicit={"weakAreas": "等时性"})
        self.assertEqual(profile_mod.profile_weak_terms("dev2"), [])
        _make_profile("dev3", enabled=True, explicit={"weakAreas": ""})
        self.assertEqual(profile_mod.profile_weak_terms("dev3"), [])


# ---- 概念检索薄弱加权（纯函数，不碰磁盘）----
# 两张卡证据完全对等：各含一个 3 字强串（等时性 / 振幅差，权重 60×3=180）、
# 无公式；基线平票按 id 排序 → [amp, iso]。
_ITEMS = {
    "amp": {"title": "圆锥摆振幅差", "formula": ""},
    "iso": {"title": "圆锥摆等时性", "formula": ""},
}


class ConceptWeakBoostTest(unittest.TestCase):
    def test_baseline_tie_without_weak_terms(self):
        rows = concept_mod.match_concept_details("等时性与振幅差", _ITEMS, weak_terms=None)
        self.assertEqual([r["id"] for r in rows], ["amp", "iso"])
        # 与显式空列表、不相干薄弱词完全同分
        for extra in ([], ["相对论"]):
            rows2 = concept_mod.match_concept_details("等时性与振幅差", _ITEMS, weak_terms=extra)
            self.assertEqual(rows, rows2)

    def test_weak_term_reorders_among_admitted(self):
        rows = concept_mod.match_concept_details("等时性与振幅差", _ITEMS, weak_terms=["等时性"])
        self.assertEqual([r["id"] for r in rows], ["iso", "amp"])
        iso = rows[0]
        self.assertEqual(iso["weak_hits"], ["等时性"])
        amp = rows[1]
        self.assertNotIn("weak_hits", amp)
        # 只计最长命中串一次：基线 = 强串 60×3 + 嵌套弱串 8×2 = 196，加权 20×3 → 256
        self.assertEqual(iso["score"], 256.0)
        self.assertEqual(amp["score"], 196.0)

    def test_weak_term_never_breaks_the_gate(self):
        # 问题与两张卡零交集：薄弱词逐字命中标题也绝不放行
        rows = concept_mod.match_concept_details("今天天气怎么样", _ITEMS, weak_terms=["等时性"])
        self.assertEqual(rows, [])

    def test_match_concepts_passes_weak_terms_through(self):
        self.assertEqual(
            concept_mod.match_concepts("等时性与振幅差", _ITEMS, weak_terms=["等时性"]),
            ["iso", "amp"],
        )


class HarnessProfileInjectionTest(unittest.TestCase):
    """api 层把画像摘要注入快照副本（quiz_weak 同款通道），不改 payload 原对象。"""

    def _kwargs(self, payload):
        from harness.api import _review_kwargs
        return _review_kwargs(payload, "")

    def test_digest_injected_into_snapshot_copy(self):
        payload = {"snapshot": {"nodes": [], "edges": []}, "device_id": "dev1"}
        with mock.patch.object(profile_mod, "profile_review_digest", return_value="学段：高中"):
            kwargs = self._kwargs(payload)
        self.assertEqual(kwargs["snapshot"]["user_profile"], "学段：高中")
        # payload 原快照不被污染（usage 日志/undo 前态保持请求原样）
        self.assertNotIn("user_profile", payload["snapshot"])

    def test_no_device_or_blank_digest_skips_injection(self):
        with mock.patch.object(profile_mod, "profile_review_digest", return_value="学段：高中"):
            kwargs = self._kwargs({"snapshot": {"nodes": [], "edges": []}})
        self.assertNotIn("user_profile", kwargs["snapshot"])
        with mock.patch.object(profile_mod, "profile_review_digest", return_value=""):
            kwargs = self._kwargs({"snapshot": {"nodes": [], "edges": []}, "device_id": "dev1"})
        self.assertNotIn("user_profile", kwargs["snapshot"])

    def test_non_dict_snapshot_survives(self):
        with mock.patch.object(profile_mod, "profile_review_digest", return_value="学段：高中"):
            kwargs = self._kwargs({"snapshot": None, "device_id": "dev1"})
        self.assertIsNone(kwargs["snapshot"])


class NormalizeUserProfileTest(unittest.TestCase):
    def test_user_profile_passes_through_normalization(self):
        from harness.core import normalize_snapshot
        snap = {"nodes": [], "edges": [], "user_profile": "学段：高中"}
        normalized = normalize_snapshot(snap)
        self.assertEqual(normalized["user_profile"], "学段：高中")
        # 缺失/非法即不带
        self.assertNotIn("user_profile", normalize_snapshot({"nodes": [], "edges": []}))
        self.assertNotIn(
            "user_profile",
            normalize_snapshot({"nodes": [], "edges": [], "user_profile": "   "}),
        )


if __name__ == "__main__":
    unittest.main()
