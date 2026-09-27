"""门控向量阈值快照回归（backlog T6，2026-09-27）。

要挡的是**过拟合**：GATE_W_EMBED=12.0 / GATE_EMBED_FLOOR=0.45 / GATE_EMBED_TOPK=3
是照着当时那 11 座岛调出来的，却没有任何测试守着——改任何一个，真实库会不会翻盘
只能靠人肉开一次大陆看。本文件把那 11 座岛的路由结果冻成快照。

手法是**假向量表**：11 座岛照真实库的主题分布摆好，卡片标题照真实库抄（含「词面
认不出」的那些），card_sims 喂一张手写的固定表。这里刻意**不加载真模型**——
计时与模型质量在别人机器上必然飘，那是 `perf_profile_baseline.py` 与一次性脚本的
活。本文件要咬住的是「阈值改了会不会翻盘」，不是模型准不准。

快照内容取自实测（见 docs/dev/concept-continent.md v9 段与本文件末的复现命令）：
- 词面认不出的 4 座岛（泊松 / 卡方 / 均匀 / 费米）不开向量时全是 None，开向量后
  全部归进正确的族——这是向量通道存在的理由，也是最容易被阈值改动掀翻的地方。
- 词面认得出的 7 座岛（梯度 / 散度 / 旋度 / 守恒×2 / 正态 / 折射）加不加向量
  证据**必须一字不差**。向量是补词面盲区的，不是来翻盘的；它一旦盖过词面证据，
  就是「补盲区」变成「喧宾夺主」。

改门控常量、内置族表、词面权重中的任何一个，`test_full_route_snapshot` 都会红。
红了先问「这是想要的翻转吗」，是的话连同下面这份快照与注释一起改，别只改数字。
"""

import math
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server.continent import (  # noqa: E402
    GATE_EMBED_FLOOR,
    GATE_EMBED_TOPK,
    GATE_W_EMBED,
    _embed_pull,
    build_continent,
)

# 11 座岛，照真实库（data/ 25 会话 / 48 知识点，其中 13 座有真主题）的主题分布挑。
# 括注标出每座岛在向量通道里的角色。
_ISLANDS = [
    ("sess_g", "梯度", ["梯度的定义与坐标表达", "梯度的几何意义：方向导数与等值面正交",
                        "物理动机：为什么需要梯度"]),
    ("sess_d", "散度", ["散度的物理意义：单位体积的通量"]),
    ("sess_r", "旋度", ["旋度的计算：环流面密度的极限"]),
    ("sess_e", "能量守恒", ["能量守恒的物理内涵", "出发点：动能定理及其对系统的推广"]),
    ("sess_me", "机械能守恒", ["机械能守恒的条件"]),
    # ↓ 这四座是「词面认不出」的：标题里没有族表术语，只能靠向量证据归类
    ("sess_p", "泊松分布", ["泊松分布概率密度函数", "散粒噪声", "指数等待时间与放射性衰变律"]),
    ("sess_c", "卡方分布", ["测量误差：平方和的统计本性", "自由度的含义"]),
    ("sess_u", "均匀分布", ["连续均匀分布的定义", "均匀分布的数字特征"]),
    ("sess_fe", "费米子", ["从自旋识别费米子", "费米子的交换反对称性",
                            "费米-狄拉克分布", "费米简并压"]),
    # ↑ 四座向量岛
    ("sess_n", "正态分布", ["正态分布概率密度函数", "68-95-99.7经验法则", "中心极限定理"]),
    ("sess_fr", "折射", ["折射定律与斯涅尔公式", "全反射的临界角"]),
]

# 词面认得出的对照岛：加不加向量证据都必须一模一样
_LEXICAL_ISLANDS = ("sess_g", "sess_d", "sess_r", "sess_e", "sess_me", "sess_n", "sess_fr")

# 四座向量岛 → 应当归进的族
_VECTOR_EXPECTED = {
    "sess_p": "概率统计",
    "sess_c": "概率统计",
    "sess_u": "概率统计",
    "sess_fe": "量子力学",
}

# 假向量表。数值取自真实库那次四岛路由的量级，不追求与真模型逐位一致。
# 关键：每座向量岛对自己该去的族给 0.58~0.74（明确过 floor），对别的族给
# 0.10~0.31（明确不过 floor）——于是「过不过 floor」这件事本身成了被测对象。
_FAMILY_VECTORS = {
    "概率统计": {"泊松分布": 0.71, "卡方分布": 0.63, "均匀分布": 0.58,
                 "费米子": 0.22, "梯度": 0.31, "折射": 0.12, "能量守恒": 0.09},
    "量子力学": {"费米子": 0.74, "卡方分布": 0.21, "泊松分布": 0.18,
                 "折射": 0.14, "梯度": 0.27, "能量守恒": 0.11},
    "几何光学": {"折射": 0.69, "费米子": 0.16, "泊松分布": 0.10,
                 "梯度": 0.19, "能量守恒": 0.08},
}
_VECTOR_ISLAND_OF = {"sess_p": "泊松分布", "sess_c": "卡方分布",
                     "sess_u": "均匀分布", "sess_fe": "费米子"}


def _build_library():
    items, sessions, sims = {}, {}, {}
    n = 0
    for sid, title, cards in _ISLANDS:
        sessions[sid] = {"id": sid, "title": title, "updatedAt": 1000 - len(sessions)}
        for card in cards:
            iid = "ki%02d" % (n + 1)
            n += 1
            items[iid] = {"id": iid, "sessionId": sid, "title": card,
                          "formulas": [], "createdAt": n}
            key = _VECTOR_ISLAND_OF.get(sid)
            if key:
                sims[iid] = {fam: vec.get(key, 0.10) for fam, vec in _FAMILY_VECTORS.items()}
    return items, sessions, sims


_ITEMS, _SESSIONS, _SIMS = _build_library()


def _routing(data):
    """{sessionId: (domain, domains, domainSource)} —— 归属的完整口径，不只是 domain。"""
    out = {}
    for c in data.get("clusters") or []:
        out[c["sessionId"]] = (c.get("domain"),
                               tuple(sorted(d["name"] for d in (c.get("domains") or []))),
                               c.get("domainSource"))
    return out


class VectorRouteSnapshotTest(unittest.TestCase):
    """11 座岛在固定假向量表下的完整路由快照。"""

    @classmethod
    def setUpClass(cls):
        cls.off = build_continent(_ITEMS, _SESSIONS)
        cls.on = build_continent(_ITEMS, _SESSIONS, card_sims=_SIMS)
        cls.off_route = _routing(cls.off)
        cls.on_route = _routing(cls.on)

    def test_vector_channel_actually_engaged(self):
        """先证明这张表真的把向量通道点着了——否则下面全是空断言。"""
        self.assertFalse(self.off.get("embedEnabled"))
        self.assertTrue(self.on.get("embedEnabled"))
        # 查空是正常路径：空表时投影必须与 v8 逐字一致
        self.assertEqual(self.off_route, _routing(build_continent(_ITEMS, _SESSIONS, card_sims={})))

    def test_four_vector_islands_route(self):
        """四岛归对：词面认不出的四座，开向量后全部落进正确的族。"""
        for sid, want in _VECTOR_EXPECTED.items():
            with self.subTest(island=sid):
                self.assertIsNone(self.off_route[sid][0],
                                  "前提失效：%s 在不开向量时就不该有归属（词面已认出）" % sid)
                got = self.on_route[sid]
                self.assertEqual(got[0], want, "%s 归错了族" % sid)
                self.assertEqual(got[1], (want,))
                # 向量证据只路由不证明：来源是 vote（岛内投票），不是 island（词面直认）
                self.assertEqual(got[2], "vote")

    def test_lexical_islands_unaffected(self):
        """梯度 / 守恒 等词面认得出的岛，加不加向量证据必须一字不差。"""
        for sid in _LEXICAL_ISLANDS:
            with self.subTest(island=sid):
                self.assertIsNotNone(self.off_route[sid][0], "前提失效：%s 本该词面直认" % sid)
                self.assertEqual(self.on_route[sid], self.off_route[sid],
                                 "向量证据盖过了词面证据——补盲区变成了喧宾夺主")

    def test_only_vector_islands_change(self):
        """整份库里只允许那四座岛变。别的岛被翻盘就是回归。"""
        changed = {sid for sid in self.off_route if self.off_route[sid] != self.on_route[sid]}
        self.assertEqual(changed, set(_VECTOR_EXPECTED))

    def test_full_route_snapshot(self):
        """全量快照：门控常量 / 内置族表 / 词面权重动任何一个，这里都会红。

        红了先问「这是想要的翻转吗」——是的话连同本文件顶部的注释一起更新，
        别只把数字改绿。域名的含义：矢量分析=梯度/散度/旋度，守恒定律=能量/机械能。
        """
        expect = {
            "sess_g": ("矢量分析", ("矢量分析",), "vote"),
            "sess_d": ("矢量分析", ("矢量分析",), "island"),
            "sess_r": ("矢量分析", ("矢量分析",), "island"),
            "sess_e": ("守恒定律", ("守恒定律",), "vote"),
            "sess_me": ("守恒定律", ("守恒定律",), "island"),
            "sess_p": ("概率统计", ("概率统计",), "vote"),
            "sess_c": ("概率统计", ("概率统计",), "vote"),
            "sess_u": ("概率统计", ("概率统计",), "vote"),
            "sess_fe": ("量子力学", ("量子力学",), "vote"),
            "sess_n": ("概率统计", ("概率统计",), "island"),
            "sess_fr": ("几何光学", ("几何光学",), "vote"),
        }
        self.assertEqual(self.on_route, expect)


class EmbedThresholdSensitivityTest(unittest.TestCase):
    """三个常量各自的牙齿：改了就必须红。"""

    def test_pull_is_exact_linear_formula(self):
        """GATE_W_EMBED × (余弦 − 下限)。倍数或下限一动，数值就变。"""
        pull = _embed_pull({"概率统计": 0.71, "量子力学": 0.22})
        self.assertEqual(list(pull), ["概率统计"], "0.22 没过下限，不该拿到证据")
        self.assertAlmostEqual(pull["概率统计"], GATE_W_EMBED * (0.71 - GATE_EMBED_FLOOR), places=9)
        self.assertAlmostEqual(pull["概率统计"], 3.12, places=9)

    def test_floor_is_strict(self):
        """下限是严格大于：恰好等于下限不给证据（`>` 不是 `>=`）。"""
        self.assertEqual(_embed_pull({"边界族": GATE_EMBED_FLOOR}), {})
        self.assertIn("边界族", _embed_pull({"边界族": GATE_EMBED_FLOOR + 1e-9}))

    def test_floor_actually_gates(self):
        """把下限抬到 0.65，0.58/0.63 那两座就该失去证据——证明下限真的在筛。"""
        below = [f for f, s in _FAMILY_VECTORS["概率统计"].items() if 0.45 < s <= 0.65]
        self.assertTrue(below, "前提失效：表里得有过 floor 但不过 0.65 的族")
        for fam in below:
            self.assertIn(fam, _embed_pull({fam: _FAMILY_VECTORS["概率统计"][fam]}))

    def test_topk_caps(self):
        """一张卡的向量证据最多支持 GATE_EMBED_TOPK 个族。"""
        sims = {("族%d" % i): 0.90 - i * 0.01 for i in range(6)}
        pull = _embed_pull(sims)
        self.assertEqual(len(pull), GATE_EMBED_TOPK)
        # 留的必须是最近的几个
        self.assertEqual(set(pull), {"族0", "族1", "族2"})
        # 第 4 名往后不是证据：它连同更远的都不该出现在 pull 里
        for dropped in ("族3", "族4", "族5"):
            self.assertNotIn(dropped, pull)

    def test_multiplier_stays_in_design_band(self):
        """倍数不许盖过词面，也不许弱到没作用——两头都钉。

        设计意图（continent.py `_embed_pull` docstring）：「明显语义拉动 ≈ 一条强标题
        术语命中」。词面那条是 _STRONG_RUN_SCORE=60，最大余弦 1.0 时向量拉动
        12.0×(1−0.45)=6.6，约词面的 1/9——补盲区的量级，不是翻盘的量级。

        上下双界而不是单边：只写「≤ 词面」的话，把倍数调到 40 也照样绿（实测过，
        单边断言只被另一条数值断言拦下，拦得不对症）。倍数调到 4 以下同样要红——
        那时向量通道名义上开着、实际已经推不动任何归属。
        """
        max_pull = GATE_W_EMBED * (1.0 - GATE_EMBED_FLOOR)
        self.assertTrue(math.isfinite(max_pull))
        self.assertGreaterEqual(max_pull, 4.0, "倍数太小：向量通道名义开着、实际推不动归属")
        self.assertLessEqual(max_pull, 12.0, "倍数太大：向量证据能盖过词面，补盲区变成喧宾夺主")
        # 与词面强证据的量级关系也要在注释里对得上号
        self.assertLessEqual(max_pull, 60.0)  # _STRONG_RUN_SCORE：≥3 字实质重叠


if __name__ == "__main__":
    unittest.main()
