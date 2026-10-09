"""T207：概念地基共享串索引的进程内增量缓存。

钉死三件事：
1. **等价性**：增量维护的索引与 T207 前的全量重建版（本文件里的参照实现）在任意
   条目集变化序列下逐字节一致——加条目/改标题/删条目/口径切换/账号域交替；
2. **稳态零重建**：条目没变时索引对象原样复用，_normalize_title 一次都不跑；
3. **无空桶不变量**：条目删除后索引里不留下空集合（空桶会把 df 算成 1，等于给
   不存在的串发稀有票——_run_weight 的 `or 1` 兜底会放大它）。
"""

import os
import random
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from server import concept as concept_mod  # noqa: E402


def _reference_index(items, allow_cross_session, session_id):
    """T207 前的全量重建版逐字拷贝（唯一参照；两实现分歧即本测试红）。"""
    index = {}
    for item_id, item in items.items():
        if not isinstance(item, dict):
            continue
        if not allow_cross_session and str(item.get("sessionId") or "") not in ("", str(session_id)):
            continue
        title = concept_mod._normalize_title(item.get("title"))
        for size in range(concept_mod._TITLE_RUN_MIN_CJK, len(title) + 1):
            for i in range(0, len(title) - size + 1):
                piece = title[i:i + size]
                if piece.isascii() and size < concept_mod._TITLE_RUN_MIN_LATIN:
                    continue
                index.setdefault(piece, set()).add(str(item_id))
    return index


def _norm(index):
    """索引归一成可断言的形状（set 无序、键值都转不可变）。"""
    return {piece: frozenset(ids) for piece, ids in index.items()}


class TitleRunIndexCacheTest(unittest.TestCase):
    def setUp(self):
        # 模块级缓存跨测试驻留：每个用例从空缓存起跑，模拟进程首次调用
        concept_mod._reset_title_run_cache()

    def tearDown(self):
        concept_mod._reset_title_run_cache()

    # ---- 等价性：随机变化序列逐步对照暴力参照 ----

    def test_random_mutation_sequence_matches_reference(self):
        rng = random.Random(20261009)
        pool = [
            "简谐运动", "阻尼振动", "非线性振动", "1. 傅立叶变换的定义", "傅里叶变换",
            "梯度下降", "gradient descent", "拉普拉斯算子", "ab", "", "  带噪声的标题  ",
            "**加粗**标题", "麦克斯威尔方程组", " Maxwell Equations ", "2.3 薛定谔方程",
            "的", "运动和定理的关系", "duplicate", "duplicate",
        ]
        items = {}
        for step in range(60):
            action = rng.choice(["add", "rename", "remove", "scope"])
            allow_cross = rng.random() > 0.3
            sid = rng.choice(["", "s1", "s2"])
            if action == "add" or not items:
                iid = f"it{step % 7}"
                items[iid] = {"title": rng.choice(pool),
                             "sessionId": rng.choice(["", "s1", "s2"])}
            elif action == "rename":
                iid = rng.choice(list(items))
                # 原 dict 原地改标题（缓存只按原文字面比对，必须认这种变化）
                items[iid]["title"] = rng.choice(pool)
            elif action == "remove":
                items.pop(rng.choice(list(items)), None)
            # scope 动作不改 items，只换过滤口径
            got = _norm(concept_mod._title_run_index(items, allow_cross, sid))
            want = _norm(_reference_index(items, allow_cross, sid))
            self.assertEqual(got, want, f"step={step} action={action} "
                                        f"cross={allow_cross} sid={sid}")

    # ---- 稳态零重建 ----

    def test_steady_state_reuses_index_without_normalizing(self):
        items = {f"i{n}": {"title": t} for n, t in
                 enumerate(["简谐运动", "阻尼振动", "拉普拉斯算子", "gradient descent"])}
        first = concept_mod._title_run_index(items, True, "")
        calls = []
        orig = concept_mod._normalize_title

        def counting(title):
            calls.append(title)
            return orig(title)

        concept_mod._normalize_title = counting
        try:
            second = concept_mod._title_run_index(items, True, "")
        finally:
            concept_mod._normalize_title = orig
        self.assertIs(first, second)          # 同一对象：整个索引原样复用
        self.assertEqual(calls, [])           # 稳态下一次标题归一都没跑

    def test_changed_title_only_recomputes_that_item(self):
        items = {"a": {"title": "简谐运动"}, "b": {"title": "阻尼振动"}}
        concept_mod._title_run_index(items, True, "")
        calls = []
        orig = concept_mod._normalize_title

        def counting(title):
            calls.append(title)
            return orig(title)

        items["b"]["title"] = "非线性振动"
        concept_mod._normalize_title = counting
        try:
            got = _norm(concept_mod._title_run_index(items, True, ""))
        finally:
            concept_mod._normalize_title = orig
        self.assertEqual(_norm(_reference_index(items, True, "")), got)
        self.assertEqual(calls, ["非线性振动"])  # 只归一改了标题的那一条

    # ---- 口径切换与账号域病理 ----

    def test_scope_switch_rebuilds_full_and_leaves_no_residue(self):
        items = {
            "a": {"title": "简谐运动", "sessionId": ""},
            "b": {"title": "阻尼振动", "sessionId": "s1"},
            "c": {"title": "受迫振动", "sessionId": "s2"},
        }
        wide = _norm(concept_mod._title_run_index(items, True, ""))
        narrow = _norm(concept_mod._title_run_index(items, False, "s1"))
        self.assertEqual(_norm(_reference_index(items, False, "s1")), narrow)
        self.assertEqual(narrow["振动"], frozenset({"b"}))  # a 标题不含「振动」；c 属 s2 不进本会话口径
        self.assertNotIn("受迫", narrow)                      # c 的独有子串整体缺席
        back = _norm(concept_mod._title_run_index(items, True, ""))
        self.assertEqual(wide, back)  # 切回来与初次全量一致，无残留

    def test_same_id_different_domain_alternating(self):
        """两个账号域同 id 不同标题交替调用：各自结果正确（至多重建，绝不串）。"""
        a = {"7": {"title": "简谐运动"}}
        b = {"7": {"title": "阻尼振动"}}
        for _ in range(3):
            self.assertEqual(_norm(concept_mod._title_run_index(a, True, "")),
                             _norm(_reference_index(a, True, "")))
            self.assertEqual(_norm(concept_mod._title_run_index(b, True, "")),
                             _norm(_reference_index(b, True, "")))

    # ---- 无空桶不变量 ----

    def test_no_empty_buckets_after_removals(self):
        items = {f"i{n}": {"title": t} for n, t in
                 enumerate(["简谐运动", "简谐", "谐运动", "运动"])}
        concept_mod._title_run_index(items, True, "")
        del items["i0"]
        del items["i1"]
        index = concept_mod._title_run_index(items, True, "")
        self.assertTrue(index)
        for piece, bucket in index.items():
            self.assertTrue(bucket, f"空桶残留：{piece!r}")
        self.assertEqual(_norm(index), _norm(_reference_index(items, True, "")))

    # ---- 端到端：缓存预热不污染后续检索结果 ----

    def test_match_details_unaffected_by_warm_cache(self):
        items = {
            "k1": {"title": "简谐运动", "formulas": ["F=-kx"], "sessionId": ""},
            "k2": {"title": "胡克定律", "formulas": ["F=-kx"], "sessionId": ""},
            "k3": {"title": "阻尼振动", "formulas": ["x''+2γx'+ω²x=0"], "sessionId": ""},
        }
        cold = concept_mod.match_concept_details("阻尼振动的周期会变吗", items)
        # 换一份_items 再换回来，模拟缓存被别的账号域/别的请求预热过
        concept_mod._title_run_index({"other": {"title": "完全不相干的标题"}}, True, "")
        warm = concept_mod.match_concept_details("阻尼振动的周期会变吗", items)
        self.assertEqual(cold, warm)
        self.assertTrue(cold)
        self.assertEqual(cold[0]["id"], "k3")

    def test_empty_and_non_dict_inputs(self):
        self.assertEqual(concept_mod._title_run_index({}, True, ""), {})
        self.assertEqual(concept_mod._title_run_index({"x": "not-a-dict"}, True, ""), {})


if __name__ == "__main__":
    unittest.main()
