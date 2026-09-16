"""概念族与译名变体（大陆 v6 / A 档）纯函数测试。

三条不变量：
- 译名归一**只做写法**、只做真变体（值==键的同义项、以及「规范名是变体前缀」的截断项
  一律不收——后者会把已经正确的写法改成「拉格朗日日」这类畸形串）；
- 匹配只跑**标题**，ASCII 术语按词边界（`rlc` 不该在 `rlcircuit` 里命中）；
- 脏数据照常返回不报错：空规范名、单字术语、非 dict 条目一律丢弃（单字术语在中文标题里
  到处都是，拿它当族证据会把无关的岛圈成一家）。
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from server.family import (  # noqa: E402
    ALIASES, BUILTIN_FAMILIES, apply_aliases, families_from_payload,
    family_term_index, match_families, merge_families,
)


class AliasTest(unittest.TestCase):
    def test_real_variants_normalized(self):
        self.assertEqual(apply_aliases("傅立叶变换"), "傅里叶变换")
        self.assertEqual(apply_aliases("薛丁格方程"), "薛定谔方程")
        self.assertEqual(apply_aliases("麦克斯威尔方程组"), "麦克斯韦方程组")

    def test_canonical_text_never_mangled(self):
        # 已经是规范写法的一律原样（曾因「拉格朗→拉格朗日」这类截断变体把它们改坏）
        for text in ("拉格朗日方程", "范德瓦尔斯气体", "傅里叶变换", "玻尔半径", "斯托克斯定理"):
            self.assertEqual(apply_aliases(text), text, text)

    def test_empty_and_none_safe(self):
        self.assertEqual(apply_aliases(""), "")
        self.assertEqual(apply_aliases(None), "")

    def test_table_has_no_identity_or_prefix_entries(self):
        # 表自身的不变量：没有 值==键 的死条目，也没有「规范名是变体前缀」的截断项
        for variant, canonical in ALIASES.items():
            self.assertNotEqual(variant, canonical, variant)
            self.assertFalse(canonical.startswith(variant), variant)


class MatchTest(unittest.TestCase):
    def setUp(self):
        self.families = merge_families(BUILTIN_FAMILIES, [])

    def test_two_char_domain_terms_match(self):
        # 真机老问题：梯度/散度/旋度两两只共享 2 字，靠族表才能成为「同一主题」
        self.assertIn("矢量分析", match_families("梯度", self.families))
        self.assertIn("矢量分析", match_families("散度与旋度的定义", self.families))
        self.assertIn("振动与波动", match_families("非线性振动", self.families))

    def test_generic_grammar_fragments_never_match(self):
        # 语法碎片与泛后缀永远不进族表（v4 教训）
        index = family_term_index(self.families)
        for junk in ("表达", "坐标", "定义", "关系", "正交", "意义"):
            self.assertNotIn(junk, index, junk)

    def test_ascii_terms_match_on_word_boundary(self):
        self.assertIn("电路", match_families("rlc 串联电路", self.families))
        self.assertNotIn("电路", match_families("orlcircuit", self.families))

    def test_alias_then_match(self):
        # 异体译名先归一、再匹配：两类写法落进同一族
        self.assertIn("傅里叶分析", match_families(apply_aliases("傅立叶变换的性质"), self.families))

    def test_empty_text_matches_nothing(self):
        self.assertEqual(match_families("", self.families), [])
        self.assertEqual(match_families(None, self.families), [])


class PayloadTest(unittest.TestCase):
    def test_dirty_payload_ignored_not_raised(self):
        raw = [{"canonical": "", "terms": ["x"]}, "junk", {"canonical": "甲", "terms": ["单", "力"]},
               {"canonical": "乙", "terms": ["张力", "张力"]}, {"canonical": "丙", "terms": []}]
        out = families_from_payload(raw)
        self.assertEqual([f["canonical"] for f in out], ["乙"])
        self.assertEqual(out[0]["terms"], ["张力"])  # 去重

    def test_wrapped_payload_accepted(self):
        out = families_from_payload({"families": [{"canonical": "我的专题", "terms": ["涡旋电场"]}]})
        self.assertEqual([f["canonical"] for f in out], ["我的专题"])

    def test_user_family_overrides_builtin_same_name(self):
        merged = merge_families(BUILTIN_FAMILIES, [{"canonical": "矢量分析", "terms": ["梯度场"],
                                                  "source": "user"}])
        target = [f for f in merged if f["canonical"] == "矢量分析"]
        self.assertEqual(len(target), 1)
        self.assertEqual(target[0]["terms"], ["梯度场"])
        self.assertEqual(target[0]["source"], "user")
        # 内置的其它族照旧在
        self.assertTrue(any(f["canonical"] == "振动与波动" for f in merged))


if __name__ == "__main__":
    unittest.main()
