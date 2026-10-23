"""分类基准岛集（L4，2026-10-23）：**「归对没归对」的语义回归**。

为什么要多一个文件：`test_continent_gate_snapshot.py` 冻的是**数值快照**——它咬得住
「阈值改了会不会翻盘」，却咬不住「翻过去的名字对不对」。一座材料力学岛被自信地归进
「相对论」，快照全程是绿的。本文件补的就是这一层：拿 10 座真岛，逐条断言
「名字 / 来源 / 三态 / 边际 / 候选」应该长什么样。

数据：`tests/fixtures/continent_baseline.json`
- 真标题（照真机库抄，含「从哪里引出这个量」这种口语标题）＋**真公式条数**；
- 冻结余弦：bge-small-zh-v1.5 对 31 个内置族中心的**实测**值，只要 cos>=0.45 的最强 6 族；
- 10 座岛 82 张卡，覆盖 4 类结局：弃权（3）、疑似（3）、确定（4——力学/代数学/电磁学/
  数学物理与应用数学），以及三座临界岛（简谐 0.41/0.22/0.36、矩阵 0.53/0.18/0.67、
  泊松 0.36/0.06/0.67）。

手法照 gate_snapshot：**不加载模型**，card_sims 喂冻结表。模型准不准、计时多少在别人
机器上必然飘，那是 `perf_profile_baseline.py` 与一次性脚本的活；这里咬的是**口径**。

期望值取自**这 10 岛子库**（82 卡）而不是真机全库（180 卡）：IDF 的分母是全库卡数，
子库会差 <0.02（实测 杨氏 0.789/0.793、矩阵 0.533/0.526、电容 0.891/0.909），名次与
档位完全一致。全库口径见计划文档 §8 与 §12 的复现脚本。

**红了怎么办（别直接改数字）**
1. 先问「这是想要的翻转吗」：把失败岛的 top / margin / consensus 与候选一起看，
   再对一遍计划文档 §8 的期望表；
2. 是的话，连 `why` 与期望一起改（`why` 要写清为什么这条期望变了），并把计划文档
   §8 / 当日日志同步；
3. 不是的话，改回代码——本文件红着提交，等于把「错路由」写进契约。

**约定（L4 的落点）**：改词表 / 门控权重 / 弃权参数 / 三态阈值 / 海图，**必须跑本文件**，
并与 `test_continent_gate_snapshot.py`（数值快照）一起看。两者红的方向不同：
本文件红＝「名字变了」，快照红＝「概率变了」。

重生成夹具（真库变了、且 §8 已按新数据复核过之后）：用计划文档 §12 的脚本接
`knowledge_routes._continent_vectors` 算出 cos，按本文件 `_library()` 的形状重写 JSON
（岛/卡/公式条数/cos>=0.45 前 6）。只读脚本 + 临时数据目录，不碰真库。
"""

import copy
import json
import os
import sys
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server import continent as C  # noqa: E402
from server.family import (  # noqa: E402
    BUILTIN_FAMILIES,
    BUILTIN_SEA_MAP,
    merge_families,
)

FIXTURE = os.path.join(ROOT, "tests", "fixtures", "continent_baseline.json")
with open(FIXTURE, encoding="utf-8") as _fh:
    DATA = json.load(_fh)
ISLANDS = DATA["islands"]

# 首批 10 条（计划文档 §6 L4 的名单）。加条目前先问：它是「语义护栏」还是「又一份快照」？
FIRST_BATCH = 10


def _library(islands=None):
    """夹具 → `build_continent` 的三份入参（items / sessions / card_sims）。

    公式只喂**条数**（空串 × n）：岛级信息量是 `1 + min(3, 公式条数)`，而公式指纹
    那 +0.5 的细节不进基准集（它在 gate_snapshot 与 test_continent.py 里另测）。
    空串经 `_structural_tokens` 得到空集——`BaselineLibraryTest` 有断言钉住这点，
    否则一次「把空串换成 {}」的重构会静默给每张卡加上公式证据。
    """
    items, sessions, sims = {}, {}, {}
    for k, island in enumerate(islands if islands is not None else ISLANDS):
        sid = "base_%02d" % k
        sessions[sid] = {"id": sid, "title": island["title"], "updatedAt": 1000 - k}
        for j, card in enumerate(island["cards"]):
            iid = "%s_k%02d" % (sid, j)
            items[iid] = {
                "id": iid,
                "sessionId": sid,
                "title": card["title"],
                "formulas": [""] * int(card.get("formulas") or 0),
                "createdAt": j,
            }
            if card.get("sims"):
                sims[iid] = dict(card["sims"])
    return items, sessions, sims


def _route(sea_map=None):
    """跑一遍基准集 → ({岛名: 簇}, 投影)。sea_map={} ＝关掉海域折叠（细族口径）。"""
    items, sessions, sims = _library()
    fold = dict(BUILTIN_SEA_MAP) if sea_map is None else sea_map
    data = C.build_continent(items, sessions, None, None, None,
                             card_sims=sims, sea_map=fold)
    return {c["title"]: c for c in data["clusters"]}, data


_ROWS, _PROJECTION = _route()


class BaselineLibraryTest(unittest.TestCase):
    """夹具自检：数据不成立时，下面的路由断言全是空话。"""

    def test_meta_matches_payload(self):
        self.assertEqual(DATA["meta"]["baselineIslands"], len(ISLANDS))
        self.assertEqual(len(ISLANDS), FIRST_BATCH, "首批 10 条；加条目改这里并说明理由")
        self.assertEqual(sum(len(i["cards"]) for i in ISLANDS), 82,
                         "卡片总数变了——先确认夹具是不是被误改（真库 180 卡里这 10 岛共 82 卡）")
        self.assertEqual(len(_ROWS), len(ISLANDS), "岛名撞车了：基准集按岛名取值，必须唯一")

    def test_every_island_documents_itself(self):
        """每条都要有 id / title / 非空 why——`why` 是红了之后唯一能告诉后人「为什么」的东西。"""
        for island in ISLANDS:
            with self.subTest(island=island.get("title")):
                self.assertTrue(island.get("id"), "缺 id")
                self.assertTrue(island.get("title"), "缺 title")
                self.assertTrue(island.get("why", "").strip(), "缺 why：红了的人无从判断该改哪边")
        ids = [i["id"] for i in ISLANDS]
        self.assertEqual(len(ids), len(set(ids)), "id 必须唯一")

    def test_cards_are_well_formed(self):
        for island in ISLANDS:
            self.assertTrue(island["cards"], "%s：空岛没有路由可言" % island["title"])
            for card in island["cards"]:
                self.assertTrue(str(card.get("title") or "").strip(), "空标题")
                self.assertIsInstance(card.get("formulas"), int)
                self.assertGreaterEqual(card["formulas"], 0)

    def test_sims_respect_documented_truncation(self):
        """cos 只留 0.45 以上、每卡最多 6 个族（floor 0.55 下留 0.10、TOPK 3 下留一倍余量）。"""
        floor = DATA["meta"]["simFloor"]
        cap = DATA["meta"]["simsPerCardMax"]
        for island in ISLANDS:
            for card in island["cards"]:
                with self.subTest(card=card["title"]):
                    self.assertLessEqual(len(card.get("sims") or {}), cap)
                    for fam, cos in (card.get("sims") or {}).items():
                        self.assertGreaterEqual(cos, floor, "低于记录下限的余弦不该进夹具")
                        self.assertLessEqual(cos, 1.0)

    def test_every_sim_key_is_a_live_family(self):
        """夹具里的族名必须都在生效族表里——族被改名/删掉时要**在这里**红，别让路由替它说话。

        `build_continent` 会把名单外的领域名静默丢掉（`d in accepted_names`）；丢了之后
        这座岛的证据凭空少一块，翻出来的名次会被误读成「参数漂了」。所以先查名字。
        """
        accepted = {f["canonical"] for f in merge_families(copy.deepcopy(BUILTIN_FAMILIES), [])}
        for island in ISLANDS:
            seen = set()
            for card in island["cards"]:
                seen |= set((card.get("sims") or {}).keys())
            with self.subTest(island=island["title"]):
                unknown = seen - accepted
                self.assertFalse(unknown, "族表里没有这些名字：%s——改名/删族了？先确认口径，"
                                          "再更新夹具（别只把断言删掉）" % sorted(unknown))

    def test_vector_channel_is_engaged(self):
        """先证明这张表真的把向量通道点着了——否则「靠向量的岛」全是空断言。"""
        self.assertTrue(_PROJECTION.get("embedEnabled"))

    def test_formula_counts_do_not_leak_structural_evidence(self):
        """公式只喂条数：空串不许切出结构 token（否则公式指纹会凭空 +0.5）。"""
        items, _, _ = _library()
        leaked = {iid: C._structural_tokens(item) for iid, item in items.items()
                  if C._structural_tokens(item)}
        self.assertEqual(leaked, {}, "空公式切出了结构 token——夹具的「只喂条数」前提被破坏了")


class BaselineRoutingTest(unittest.TestCase):
    """逐条断言名字 / 来源 / 三态 / 边际 / 候选。"""

    def test_names_and_sources(self):
        for island in ISLANDS:
            title, want = island["title"], island["expect"]
            row = _ROWS[title]
            with self.subTest(island=title):
                if want["domain"] == "abstain":
                    self.assertIsNone(
                        row["domain"],
                        "%s：证据不成立却给了名字 %r（top=%.3f / 候选=%s）——弃权闸门漏了"
                        % (title, row["domain"], row["domainConf"],
                           [d["name"] for d in row["domains"]]))
                    self.assertEqual(row["domainConf"], 0.0, "弃权时 domainConf 必须同时清空")
                else:
                    self.assertEqual(
                        row["domain"], want["domain"],
                        "%s：名次翻了（现在 top=%r / margin=%.3f / consensus=%.3f / 候选=%s）。"
                        "先判断这是不是想要的翻转，再决定改代码还是改基准"
                        % (title, row["domain"], row["domainMargin"], row["domainConsensus"],
                           [d["name"] for d in row["domains"]]))
                    self.assertGreater(row["domainConf"], 0.0)
                self.assertEqual(row["domainSource"], want["source"],
                                 "%s：来源变了（词面直认/岛内投票/Φ 打标），图例口径跟着变" % title)

    def test_tiers(self):
        """三态（L3）：确定/疑似/未归类。改 GATE_SOLID_* 先看这一条的失败清单。"""
        for island in ISLANDS:
            title, want = island["title"], island["expect"]
            row = _ROWS[title]
            with self.subTest(island=title):
                self.assertEqual(
                    row["domainTier"], want["tier"],
                    "%s：三态从 %r 变成 %r（margin=%.3f / consensus=%.3f）——三态翻的是颜色与「?」，"
                    "名字是否翻盘看 test_names_and_sources"
                    % (title, want["tier"], row["domainTier"], row["domainMargin"],
                       row["domainConsensus"]))

    def test_margin_bands(self):
        """边际区间：±0.01 只是取整余量，不是自由参数——它漂了就说明证据结构变了。"""
        for island in ISLANDS:
            title, want = island["title"], island["expect"]
            row = _ROWS[title]
            lo, hi = want["margin"]
            with self.subTest(island=title):
                self.assertTrue(lo <= row["domainMargin"] <= hi,
                                "%s：margin %.3f 出了基准区间 [%.3f, %.3f]（top=%r / 候选=%s）"
                                % (title, row["domainMargin"], lo, hi, row["domain"],
                                   [d["name"] for d in row["domains"]]))

    def test_candidates(self):
        """候选清单（按 GATE_MIN_P 过滤后）。灰岛也要能说「候选是哪两片海、各占多少」。

        行波这座岛冻的是**空清单**：冠军海份额 0.19，连 GATE_MIN_P=0.25 都不到，
        所以「未归类（候选：…）」这句文案在它身上看不见——已知缺口，登记 backlog T388。
        冻在这里是为了让修它的人必须来改这一行（改完顺便把 T388 销账），而不是让它
        悄悄变空或悄悄变有。
        """
        for island in ISLANDS:
            title, want = island["title"], island["expect"]
            got = [d["name"] for d in _ROWS[title]["domains"]]
            with self.subTest(island=title):
                self.assertEqual(got, want["candidates"],
                                 "%s：候选清单变了（期望 %s，实际 %s）"
                                 % (title, want["candidates"], got))


class BaselineSensitivityTest(unittest.TestCase):
    """夹具的牙齿：证明它真的咬住**词表 / 弃权闸 / 三态闸 / 海图**四条线。

    四条各抽一根，断的都是真机实测过的轴——不是把常量随便调大调小看会不会红。
    """

    def test_dropping_l2_family_sends_youngs_modulus_back_to_abstain(self):
        """摘掉 L2 的材料力学族，杨氏模量岛就退回 L1 的弃权态（margin 0.013，正是当初的掷硬币）。

        这条同时是「为什么要有基准集」的自证：同一条代码路径，族表一动，结局从
        「力学 solid」变「未归类」——数值快照抓不到这种翻盘，语义断言抓得到。
        """
        families = [f for f in copy.deepcopy(BUILTIN_FAMILIES) if f["canonical"] != "材料力学"]
        with mock.patch.object(C, "BUILTIN_FAMILIES", families):
            rows, _ = _route()
        row = rows["杨氏模量"]
        self.assertIsNone(row["domain"], "摘掉材料力学族后它不该还有名字（%r）" % row["domain"])
        self.assertLess(row["domainMargin"], 0.05,
                        "摘族之后应当是「掷硬币」的边际（实测 0.013），现在是 %.3f" % row["domainMargin"])

    def test_margin_gate_is_what_keeps_harmonic_motion(self):
        """边际闸门真在筛：抬到 0.30，简谐运动（margin 0.217）变灰，电容（0.844）不动。"""
        with mock.patch.object(C, "GATE_MIN_MARGIN", 0.30):
            rows, _ = _route()
        self.assertIsNone(rows["简谐运动是什么?为什么它总在振动?"]["domain"])
        self.assertEqual(rows["电容"]["domain"], "电磁学", "高置信岛不许被误伤")

    def test_consensus_gate_is_what_keeps_poisson(self):
        """一致率闸门真在救：泊松靠 consensus 0.667 顶住薄边际，抬到 0.70 它就变灰。"""
        with mock.patch.object(C, "GATE_MIN_CONSENSUS", 0.70):
            rows, _ = _route()
        self.assertIsNone(rows["泊松分布"]["domain"], "0.667 的一致率撑不住 0.70 的门槛")
        self.assertEqual(rows["电容"]["domain"], "电磁学")
        self.assertEqual(rows["电容"]["domainTier"], "solid")

    def test_solid_tier_needs_all_three_signals(self):
        """三态闸：抬一道，矩阵从「确定」掉回「疑似」——但**名字不许跟着翻**。"""
        with mock.patch.object(C, "GATE_SOLID_CONSENSUS", 0.90):
            rows, _ = _route()
        self.assertEqual(rows["矩阵"]["domainTier"], "light")
        self.assertEqual(rows["矩阵"]["domain"], "代数学", "三态只翻颜色，不翻名字")
        self.assertEqual(rows["电容"]["domainTier"], "solid")

    def test_domain_names_are_seas_not_families(self):
        """海图折叠真在起作用：关掉折叠，岛名回到细族（梯度→矢量分析、泊松→概率统计）。"""
        rows, _ = _route(sea_map={})
        self.assertEqual(rows["梯度"]["domain"], "矢量分析")
        self.assertEqual(rows["泊松分布"]["domain"], "概率统计")
        # 与基准集里的海域名成对出现，作为「细族 → 海域」这条口径的活文档
        self.assertNotEqual(rows["梯度"]["domain"], _ROWS["梯度"]["domain"])
        self.assertNotEqual(rows["泊松分布"]["domain"], _ROWS["泊松分布"]["domain"])


if __name__ == "__main__":
    unittest.main()
