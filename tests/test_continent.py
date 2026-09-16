"""大陆投影（大陆计划 v1 + v2）纯函数测试：聚簇 / 共享概念 / 用户簇间边 / 契约字段。

build_continent 必须长期保持三条性质（见模块 docstring）：
- 纯函数：无 IO、无模型调用、不改入参；
- 查空是正常路径：空库 / 单会话 / 零跨会话重叠 → shared 为空，不报错；
- 公式键只有一把：token 必须经 knowledge._formula_key 归一化（TeX 命令名与
  单字母不参与，否则任意两条含积分的公式互相成为「同源概念」）。

v2 用户簇间边（KV continent_edges，调用方喂参）：
- 两端条目都在且跨会话 → userEdges（会话字段以 item_session 现算为准）；
- 端点失效 → danglingEdges（missing=from/to/both/same_session），投影永不报错；
- 同端点对去重留最新、自环与缺 id 直接丢弃。
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

from server.continent import build_continent, normalize_user_edge_payload  # noqa: E402

S1, S2, S3 = "sess_aaa", "sess_bbb", "sess_ccc"
SESSIONS = {
    S1: {"id": S1, "title": "波与振动", "sessionId": "phymathia_1", "updatedAt": 100},
    S2: {"id": S2, "title": "傅里叶分析", "sessionId": "phymathia_2", "updatedAt": 300},
    S3: {"id": S3, "title": "梯度", "sessionId": "phymathia_3", "updatedAt": 200},
}


def _item(iid, sid, title, formulas=None, created=0, category=""):
    return {"id": iid, "sessionId": sid, "title": title,
            "formulas": formulas or [], "category": category, "createdAt": created}


class BuildContinentClusterTest(unittest.TestCase):
    def test_empty_library_is_normal_path(self):
        out = build_continent({}, {})
        self.assertEqual(out["clusters"], [])
        self.assertEqual(out["shared"], [])
        self.assertEqual(out["clusterCount"], 0)
        self.assertEqual(out["itemCount"], 0)

    def test_clustered_by_session_and_ordered_by_recency(self):
        items = {
            "k1": _item("k1", S1, "简谐运动", created=1),
            "k2": _item("k2", S3, "梯度的定义", created=2),
            "k3": _item("k3", S2, "傅里叶级数", created=3),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["clusterCount"], 3)
        # 簇按会话 updatedAt 降序：傅里叶(300) → 梯度(200) → 波与振动(100)
        self.assertEqual([c["sessionId"] for c in out["clusters"]], [S2, S3, S1])

    def test_items_in_learning_order(self):
        items = {
            "k1": _item("k1", S1, "概念乙", created=20),
            "k2": _item("k2", S1, "概念甲", created=10),
        }
        out = build_continent(items, SESSIONS)
        titles = [it["title"] for it in out["clusters"][0]["items"]]
        self.assertEqual(titles, ["概念甲", "概念乙"])

    def test_deleted_session_fallback_title(self):
        items = {"k1": _item("k1", "sess_gone", "某个概念")}
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["clusters"][0]["title"], "已删除的画布")

    def test_orphan_items_skipped_but_counted(self):
        items = {
            "k1": _item("k1", "", "无主概念"),
            "k2": _item("k2", S1, "正常概念"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["clusterCount"], 1)
        self.assertEqual(out["orphans"], 1)
        self.assertNotIn("无主概念", str(out["clusters"]))

    def test_item_payload_contract(self):
        items = {"k1": _item("k1", S1, "长" * 60, ["x = 1"], created=5, category="物理")}
        out = build_continent(items, SESSIONS)
        it = out["clusters"][0]["items"][0]
        for key in ("itemId", "title", "formulaPreview", "formulaCount",
                    "category", "createdAt"):
            self.assertIn(key, it)
        self.assertLessEqual(len(it["title"]), 41)  # 裁剪含省略号
        self.assertEqual(it["formulaCount"], 1)
        self.assertEqual(it["formulaPreview"], "x = 1")


class BuildContinentSharedTest(unittest.TestCase):
    def test_shared_title_run_across_sessions(self):
        items = {
            "k1": _item("k1", S1, "阻尼振动"),
            "k2": _item("k2", S2, "非线性振动"),
        }
        out = build_continent(items, SESSIONS)
        titles = [s for s in out["shared"] if s["kind"] == "title"]
        self.assertTrue(any(s["label"] == "振动" for s in titles))
        # 连线两端必须落在不同会话
        bridge = next(s for s in titles if s["label"] == "振动")
        sessions_in_links = {l["fromSession"] for l in bridge["links"]} | \
            {l["toSession"] for l in bridge["links"]}
        self.assertEqual(sessions_in_links, {S1, S2})

    def test_same_session_overlap_not_reported(self):
        items = {
            "k1": _item("k1", S1, "阻尼振动"),
            "k2": _item("k2", S1, "非线性振动"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])

    def test_run_fragments_collapsed_to_maximal(self):
        # 「谐运动」「简谐运」都是「简谐运动」的碎片且覆盖同一批条目，必须收敛
        items = {
            "k1": _item("k1", S1, "简谐运动"),
            "k2": _item("k2", S2, "简谐运动方程"),
        }
        out = build_continent(items, SESSIONS)
        title_labels = [s["label"] for s in out["shared"] if s["kind"] == "title"]
        self.assertEqual(title_labels, ["简谐运动"])

    def test_stopchar_runs_dropped(self):
        # 「度的」「的定义」这类含功能字的碎片不是领域词：梯度/散度只共享功能碎片，
        # **字面**证据必须归零。v6 起这层关系改由概念族承载（梯度/散度同属矢量分析），
        # 所以 shared 里只应有族条目、没有任何 title 子串条目——这正是「换来源而不是
        # 放宽阈值」：字面尺子照样严，关系由领域知识层给。
        items = {
            "k1": _item("k1", S1, "梯度的定义"),
            "k2": _item("k2", S2, "散度的定义"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual([s for s in out["shared"] if s["kind"] != "family"], [])
        self.assertEqual([s["label"] for s in out["shared"] if s["kind"] == "family"],
                         ["矢量分析"])

    def test_shared_formula_token_across_sessions(self):
        # grad 是有区分度的标识符 token（\omega 这类希腊命令名按既定口径不参与，
        # 见 concept._TEX_COMMANDS——测试用真实标识符验证结构证据链路）
        items = {
            "k1": _item("k1", S1, "弹簧振子", ["\\operatorname{grad} f"]),
            "k2": _item("k2", S2, "周期信号", ["\\operatorname{grad} V"]),
        }
        out = build_continent(items, SESSIONS)
        kinds = {(s["kind"], s["label"]) for s in out["shared"]}
        self.assertIn(("formula", "grad"), kinds)

    def test_tex_commands_never_become_shared_tokens(self):
        # TeX 命令名不参与：任意两条含 \frac 的公式不能因此成为「同源概念」
        items = {
            "k1": _item("k1", S1, "泰勒展开", ["\\frac{a}{b}"]),
            "k2": _item("k2", S2, "拉普拉斯", ["\\frac{c}{d}"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])

    def test_formula_key_normalization_ignores_whitespace(self):
        # 公式键只有一把：空白/定界符差异不影响同 token 判定
        items = {
            "k1": _item("k1", S1, "静电场", ["\\operatorname{grad} f"]),
            "k2": _item("k2", S2, "引力势", ["\\operatorname{grad}f"]),
        }
        out = build_continent(items, SESSIONS)
        kinds = {(s["kind"], s["label"]) for s in out["shared"]}
        self.assertIn(("formula", "grad"), kinds)

    def test_shared_capped_and_sorted(self):
        items = {}
        for i in range(30):
            sid = S1 if i % 2 == 0 else S2
            items[f"k{i}"] = _item(f"k{i}", sid, f"共享概念{i:02d}的标题", created=i)
        out = build_continent(items, SESSIONS)
        self.assertLessEqual(len(out["shared"]), 24)
        scores = [s["score"] for s in out["shared"]]
        self.assertEqual(scores, sorted(scores, reverse=True))

    def test_input_not_mutated(self):
        items = {"k1": _item("k1", S1, "阻尼振动")}
        sessions = dict(SESSIONS)
        before = {k: dict(v) for k, v in items.items()}
        edges = [{"id": "e1", "fromItem": "k1", "toItem": "kX",
                  "fromSession": S1, "toSession": S2, "label": "桥", "createdAt": 5}]
        build_continent(items, sessions, edges)
        self.assertEqual(items, before)
        self.assertEqual(sessions, SESSIONS)
        self.assertEqual(edges[0]["toItem"], "kX")  # 入参边不被改写


class BuildContinentEvidenceHygieneTest(unittest.TestCase):
    """v4 证据卫生：一条 40 字推理泄漏标题曾炸出 4 条虚假共享概念（真机数据复现）。

    三条不变量：① 不是概念名的标题（章节号 / 指令句回显 / 叙述句 / 超长句）不作
    子串证据来源；② 通用公式符号（dx/dt/oint）不算结构共享；③ 强弱分级——2 字弱证据
    与泛后缀标 weak（前端不上地图，只进清单）。
    """

    def test_section_numbered_titles_are_not_evidence(self):
        # 真机现场：「1. 定义与坐标表达」×「二、从微元立方体导出直角坐标表达式」
        # 曾共享出「坐标」「表达」「坐标表达」「直角坐标」四条（全是语法碎片）
        items = {
            "k1": _item("k1", S3, "1. 定义与坐标表达"),
            "k2": _item("k2", S1, "二、从微元立方体导出直角坐标表达式"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])

    def test_instruction_echo_title_is_not_evidence(self):
        # 真机现场：一条推理泄漏条目（标题=用户整句）曾与真概念共享出
        # 方向导数/梯度/正交/坐标/表达 五条；去掉它，共享必须归零
        junk = "用户要求：从方向导数最大值推导梯度在直角坐标与正交曲线坐标下的分量表达式。这是一"
        items = {
            "k1": _item("k1", S1, junk),
            "k2": _item("k2", S3, "梯度的几何意义：方向导数与等值超曲面"),
            "k3": _item("k3", S3, "泛函梯度与变分法"),
            "k4": _item("k4", S3, "2. 几何意义：方向导数与等值面正交性（续）"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual([s["label"] for s in out["shared"]], [])

    def test_narrative_and_overlong_titles_are_not_evidence(self):
        items = {
            "k1": _item("k1", S1, "从微元立方体导出直角坐标表达式"),
            "k2": _item("k2", S3, "在柱坐标下求解拉普拉斯方程"),
            "k3": _item("k3", S2, "这是一段用于验证超长句不当证据的标题" + "很长" * 20),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])

    def test_legit_concept_titles_still_share(self):
        # 收紧只针对「不像概念名」的标题：真概念名之间的共享照旧
        items = {
            "k1": _item("k1", S1, "阻尼振动"),
            "k2": _item("k2", S3, "阻尼振动的能量衰减"),
        }
        out = build_continent(items, SESSIONS)
        self.assertTrue(any(s["label"] == "阻尼振动" for s in out["shared"]))

    def test_generic_formula_tokens_not_shared(self):
        # dx/dt/oint 这类通用符号任何微分公式都有，不能当「结构共享」
        items = {
            "k1": _item("k1", S1, "微元法", ["$dV = dx\\,dy\\,dz$"]),
            "k2": _item("k2", S3, "梯度定理", ["$\\oint dx$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual([s for s in out["shared"] if s["kind"] == "formula"], [])

    def test_distinctive_formula_token_still_shared(self):
        # 黑名单只剔通用符号：有区分度的标识符（kx 这类多字母标识符）照旧是结构证据
        items = {
            "k1": _item("k1", S1, "弹簧振子", ["$kx$"]),
            "k2": _item("k2", S3, "简谐运动", ["$kx = ma$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertTrue(any(s["kind"] == "formula" and s["label"] == "kx" for s in out["shared"]))

    def test_strength_grading(self):
        items = {
            # 3 字实质重叠 + 公式 token → strong
            "k1": _item("k1", S1, "简谐运动", ["$kx$"]),
            "k2": _item("k2", S3, "简谐运动的能量", ["$kx$"]),
            # 2 字弱证据 → weak（「振动」级）
            "k3": _item("k3", S2, "受迫振动"),
            "k4": _item("k4", S3, "阻尼振动"),
        }
        out = build_continent(items, SESSIONS)
        by_label = {s["label"]: s for s in out["shared"]}
        self.assertEqual(by_label["简谐运动"]["strength"], "strong")
        self.assertEqual(by_label["振动"]["strength"], "weak")
        self.assertEqual(by_label["kx"]["strength"], "strong")

    def test_generic_term_run_is_weak_even_when_long(self):
        # 泛后缀单独立不住：够 3 字（按长度本该 strong）也只给 weak
        items = {
            "k1": _item("k1", S1, "球坐标下的拉普拉斯算子表达式"),
            "k2": _item("k2", S2, "柱坐标表达式"),
        }
        out = build_continent(items, SESSIONS)
        shared = [s for s in out["shared"] if s["label"] == "表达式"]
        self.assertTrue(shared, [s["label"] for s in out["shared"]])
        self.assertEqual(shared[0]["strength"], "weak")

    def test_same_label_multi_session_is_single_entry_with_links(self):
        # 同词跨 3 会话：一条 shared + C(3,2) 条链路（前端据此画一枚 ×3 标签）
        items = {
            "k1": _item("k1", S1, "简谐运动"),
            "k2": _item("k2", S2, "简谐运动方程"),
            "k3": _item("k3", S3, "简谐运动的能量"),
        }
        out = build_continent(items, SESSIONS)
        entries = [s for s in out["shared"] if s["label"] == "简谐运动"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(len(entries[0]["links"]), 3)
        self.assertEqual(entries[0]["strength"], "strong")

    def test_every_shared_entry_carries_strength(self):
        # 契约字段：前端按 strength 决定画不画，缺字段会被当成 undefined 全画
        items = {
            "k1": _item("k1", S1, "简谐运动", ["$kx$"]),
            "k2": _item("k2", S3, "简谐运动的能量", ["$kx$"]),
            "k3": _item("k3", S2, "受迫振动"),
            "k4": _item("k4", S3, "阻尼振动"),
        }
        out = build_continent(items, SESSIONS)
        self.assertTrue(out["shared"])
        for s in out["shared"]:
            self.assertIn(s["strength"], ("strong", "weak"))

    def test_every_shared_entry_carries_covered(self):
        # v5.5 契约字段：前端按 covered 折叠（不单独成城），缺字段会被当成 undefined
        # 当 false → 截断城市重新画上地图
        items = {
            "k1": _item("k1", S1, "简谐运动", ["$kx$"]),
            "k2": _item("k2", S2, "简谐运动的能量", ["$kx$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertTrue(out["shared"])
        for s in out["shared"]:
            self.assertIn(s["covered"], (True, False))


class BuildContinentFamilyTest(unittest.TestCase):
    """v6 概念族（A 档）：把「只共享 2 字领域词」的真关系从折叠清单里救出来。

    病根（真机）：`梯度`/`散度`/`旋度` 三座岛同属矢量分析，两两之间共享的只有 2 字词，
    判 weak 后既不建城也不够格摆位——地图上是一片孤岛。修法不是放宽阈值，而是**换来源**：
    加一层领域知识（概念族表），字面尺子照样严。
    """

    def _family_labels(self, out):
        return [s["label"] for s in out["shared"] if s["kind"] == "family"]

    def test_family_matching_is_linear_not_per_family(self):
        """性能红线：匹配次数必须是 O(卡 + 岛)，不是 O(卡 × 族)。

        曾经的写法把 match_families 放在「族 × 卡」双层循环里：25 族 × 600 卡 = 15,040 次
        调用，每次还在重新规范化族术语 → 实测 600 条要 1.7 秒（cProfile 抓到 420 万次
        str.lower）。修法是「每张卡只匹配一次 + 术语预规范化」。这里用**调用计数**把复杂度
        钉住——计时断言在 CI/别人的机器上必然飘。
        """
        import server.continent as cont

        items, sessions = {}, {}
        for i in range(60):
            sid = "sess_p%d" % (i % 5)
            items["k%d" % i] = _item("k%d" % i, sid, "概念%d的推导" % (i % 7))
        for i in range(5):
            sessions["sess_p%d" % i] = {"id": "sess_p%d" % i, "title": "岛%d" % i, "updatedAt": i}

        calls = {"n": 0}
        real = cont.match_families

        def spy(text, fams):
            calls["n"] += 1
            return real(text, fams)

        cont.match_families = spy
        try:
            build_continent(items, sessions)
        finally:
            cont.match_families = real
        self.assertLessEqual(calls["n"], 60 + 5 + 2,
                             "匹配次数应约等于卡数+岛数，实际 %d（族×卡 的老写法是 >1500）" % calls["n"])

    def test_family_links_two_islands_sharing_one_two_char_term(self):
        items = {
            "k1": _item("k1", S1, "阻尼振动"),
            "k2": _item("k2", S2, "受迫振动"),
        }
        out = build_continent(items, SESSIONS)
        fam = next(s for s in out["shared"] if s["kind"] == "family")
        self.assertEqual(fam["label"], "振动与波动")
        self.assertEqual(fam["strength"], "strong")   # 领域知识=可上图（字面 weak 标签照旧只摆位）
        self.assertEqual(sorted(fam["sessions"]), sorted([S1, S2]))
        self.assertEqual(sorted(fam["owners"]), ["k1", "k2"])
        self.assertTrue(fam["links"])
        # 字面弱证据仍然在（两条证据并存，分工不同：一条画族城、一条只摆位）
        self.assertTrue(any(s["kind"] == "title" and s["label"] == "振动" for s in out["shared"]))

    def test_island_name_counts_as_family_evidence(self):
        # 真机现场：岛名叫「散度」，而岛内唯一那张卡的标题是章节号（闸门不当证据）——
        # 只靠卡片标题，这座岛永远进不了族。岛名是用户/AI 起的短名，可以当证据。
        items = {
            "k1": _item("k1", S1, "梯度的定义与坐标表达"),
            "k2": _item("k2", S2, "二、从微元立方体导出直角坐标表达式"),
        }
        sessions = dict(SESSIONS)
        sessions[S2] = {"id": S2, "title": "散度", "sessionId": "phymathia_2", "updatedAt": 300}
        out = build_continent(items, sessions)
        fam = next(s for s in out["shared"] if s["kind"] == "family")
        self.assertEqual(fam["label"], "矢量分析")
        self.assertEqual(sorted(fam["sessions"]), sorted([S1, S2]))
        # k1 靠**卡名**（梯度）入族；k2 的卡名是章节号（闸门拒收），靠**岛名**「散度」入族
        self.assertEqual(sorted(fam["owners"]), ["k1", "k2"])
        reps = {l["from"] for l in fam["links"]} | {l["to"] for l in fam["links"]}
        self.assertIn("k2", reps)  # 岛名来源：代表卡＝岛内最早学的那张

    def test_specific_concept_wins_over_family(self):
        # 两座岛都学过「简谐运动」：精确标签已经连上这两座岛，族城只是同一件事的第二座
        # 城 → 折进清单（covered），精确城市照画
        items = {
            "k1": _item("k1", S1, "简谐运动"),
            "k2": _item("k2", S2, "简谐运动方程"),
        }
        out = build_continent(items, SESSIONS)
        precise = next(s for s in out["shared"] if s["label"] == "简谐运动")
        self.assertFalse(precise["covered"])
        fam = next(s for s in out["shared"] if s["kind"] == "family")
        self.assertTrue(fam["covered"])
        # 只标记不删除：族照旧返回（前端折进清单、照旧算摆位亲缘）
        self.assertTrue(fam["owners"] and fam["links"])

    def test_family_drawn_when_it_bridges_a_new_island(self):
        # 族连的岛里只要有一座没被精确标签覆盖，族就必须画（真机：矢量分析连 4 座岛，
        # 其中「散度」岛无任何精确标签）
        items = {
            "k1": _item("k1", S1, "梯度"),
            "k2": _item("k2", S2, "梯度"),          # 精确标签：S1↔S2
            "k3": _item("k3", S3, "散度的定义"),
        }
        out = build_continent(items, SESSIONS)
        fam = next(s for s in out["shared"] if s["kind"] == "family")
        self.assertEqual(fam["label"], "矢量分析")
        self.assertEqual(len(fam["sessions"]), 3)
        self.assertFalse(fam["covered"])

    def test_junk_title_does_not_pull_island_into_family(self):
        # 推理泄漏卡（指令句回显）标题里也写着「梯度」——v4 闸门不许它当证据，
        # 否则它会把自己那座岛拖进族里，凭空多出一座族城
        junk = "用户要求：从方向导数最大值推导梯度在直角坐标与正交曲线坐标下的分量表达式。这是一"
        items = {
            "k1": _item("k1", S1, junk),
            "k2": _item("k2", S2, "梯度的定义与坐标表达"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(self._family_labels(out), [])

    def test_user_families_extend_and_override(self):
        items = {
            "k1": _item("k1", S1, "涡旋电场"),
            "k2": _item("k2", S2, "涡旋电场的环流"),
        }
        custom = [{"canonical": "我的专题", "terms": ["涡旋电场"], "source": "user"}]
        out = build_continent(items, SESSIONS, None, custom)
        self.assertIn("我的专题", self._family_labels(out))
        # 覆盖同名内置族：把「矢量分析」的术语换掉后，梯度不再入族
        override = [{"canonical": "矢量分析", "terms": ["梯度场"], "source": "user"}]
        items2 = {"k1": _item("k1", S1, "梯度"), "k2": _item("k2", S2, "散度的定义")}
        out2 = build_continent(items2, SESSIONS, None, override)
        self.assertEqual(self._family_labels(out2), [])

    def test_dirty_family_payload_never_breaks_projection(self):
        items = {"k1": _item("k1", S1, "梯度"), "k2": _item("k2", S2, "散度的定义")}
        out = build_continent(items, SESSIONS, None, [None, "x", {"terms": ["a"]},
                                                      {"canonical": "甲", "terms": ["单"]}])
        self.assertEqual(self._family_labels(out), ["矢量分析"])  # 内置表照常工作

    def test_single_island_family_is_not_a_connection(self):
        # 族只命中一座岛＝那是这座岛的主题，不是跨画布联系
        items = {"k1": _item("k1", S1, "梯度"), "k2": _item("k2", S1, "散度的定义")}
        out = build_continent(items, SESSIONS)
        self.assertEqual(self._family_labels(out), [])

    def test_family_entry_carries_contract_fields(self):
        items = {"k1": _item("k1", S1, "梯度"), "k2": _item("k2", S2, "散度的定义")}
        out = build_continent(items, SESSIONS)
        fam = next(s for s in out["shared"] if s["kind"] == "family")
        for key in ("kind", "label", "score", "strength", "covered", "sessions", "owners",
                    "links", "source"):
            self.assertIn(key, fam, key)
        self.assertIn(fam["source"], ("builtin", "custom", "user"))


class BuildContinentStructuralTokenTest(unittest.TestCase):
    """v5.6 结构证据卫生：`\\text{…}` 里的散文与语法命令名都不算结构证据。

    真机实测：`\\text{const}` 漏出英文填充词 `const`，把「梯度」岛与「能量守恒」岛连成
    一条虚假的 ∑ 结构共享（用户地图上那条 ∑ const 城市）；同一批还漏出 `iff`/`equiv`/
    `langle`/`rangle`/`in`/`dfrac` 等关系符与定界符的命令名——任意两条含 `\\iff` 的公式
    都会变成「同源概念」。两条判据都不靠不断加长的词表：剥 `\\text{…}` 内容 + 公式里
    出现过的 `\\命令名` 不作 token（只放行有区分度的算子命令）。
    """

    def test_text_prose_is_not_structural_evidence(self):
        # 真机现场：一张卡的 `f=\text{const}` 与另一张卡的 `E=\text{const}`
        items = {
            "k1": _item("k1", S1, "梯度：势场的陡峭程度与力的方向", ["$f=\\text{const}$"]),
            "k2": _item("k2", S2, "能量守恒的物理内涵", ["$E=\\text{const}$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual([s["label"] for s in out["shared"]], [])

    def test_grammar_commands_are_not_structural_evidence(self):
        # 关系符 / 定界符命题的命令名：两条毫不相干的公式都含 \iff / \langle 不该连起来
        items = {
            "k1": _item("k1", S1, "命题等价", ["$a \\iff b$"]),
            "k2": _item("k2", S2, "内积记号", ["$\\langle x,y\\rangle$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])

    def test_operatorname_argument_still_counts(self):
        # 反向保护：`\operatorname{grad}` 的 grad 不是命令名（命令名是 operatorname），
        # 照旧是结构证据——既有链路不许被这次收紧误伤
        items = {
            "k1": _item("k1", S1, "静电场", ["$\\operatorname{grad} f$"]),
            "k2": _item("k2", S2, "引力势", ["$\\operatorname{grad} V$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertIn(("formula", "grad"), {(s["kind"], s["label"]) for s in out["shared"]})

    def test_distinctive_operators_survive(self):
        # 有区分度的算子（两条都用外积确实相关）：放行，别一刀切成漏报
        items = {
            "k1": _item("k1", S1, "外微分", ["$\\alpha \\wedge \\beta$"]),
            "k2": _item("k2", S2, "微分形式乘法", ["$\\omega \\wedge \\eta$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertIn(("formula", "wedge"), {(s["kind"], s["label"]) for s in out["shared"]})

    def test_same_meaning_two_languages_never_fake_links(self):
        # `\text{const}` 与 `\text{常量}` 是同一个意思的两种写法：都不当证据
        # （中英不对称既不该制造联系，也不该吞掉联系）
        items = {
            "k1": _item("k1", S1, "梯度：势场的陡峭程度与力的方向", ["$f=\\text{const}$"]),
            "k2": _item("k2", S2, "能量守恒的物理内涵", ["$E=\\text{常量}$"]),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])


class BuildContinentAggregationTest(unittest.TestCase):
    """v5.5 汇聚口径：广度优先排序 + 被覆盖标签不单独成城。

    两条都是真机/构造实测出来的缺陷：
    ① 旧分数 `(60 + 12×字数) / 命中条目数` 把骨干概念压到冷门重叠之下；
    ② 「能量守恒定律」×8 岛 + 「角动量守恒定律」×2 岛会多出一个 10 岛标签
       「量守恒定律」（两条长名的中间截断），前端会画出两座几乎重合、名字读不懂的城。
    """

    def test_breadth_beats_rarity(self):
        # 8 座岛共享「能量守恒定律」必须排在 2 座岛共享的「角动量守恒定律」之前
        items = {}
        for i in range(8):
            items[f"e{i}"] = _item(f"e{i}", f"sess_e{i}", "能量守恒定律", created=i)
        items["a1"] = _item("a1", S1, "角动量守恒定律与开普勒第二定律", created=1)
        items["a2"] = _item("a2", S2, "角动量守恒定律的矢量推导", created=2)
        out = build_continent(items, {})
        labels = [s["label"] for s in out["shared"] if s["kind"] == "title"]
        self.assertIn("能量守恒定律", labels)
        self.assertIn("角动量守恒定律", labels)
        self.assertLess(labels.index("能量守恒定律"), labels.index("角动量守恒定律"))

    def test_truncated_label_marked_covered(self):
        # 「量守恒定律」的每一条命中卡都被更具体的标签覆盖 → covered=True；
        # 两条更具体的标签本身没有被覆盖 → covered=False
        items = {}
        for i in range(8):
            items[f"e{i}"] = _item(f"e{i}", f"sess_e{i}", "能量守恒定律", created=i)
        items["a1"] = _item("a1", S1, "角动量守恒定律与开普勒第二定律", created=1)
        items["a2"] = _item("a2", S2, "角动量守恒定律的矢量推导", created=2)
        out = build_continent(items, {})
        by_label = {s["label"]: s for s in out["shared"] if s["kind"] == "title"}
        self.assertTrue(by_label["量守恒定律"]["covered"])
        self.assertFalse(by_label["能量守恒定律"]["covered"])
        self.assertFalse(by_label["角动量守恒定律"]["covered"])

    def test_family_head_word_not_covered_without_specific_shared_label(self):
        # 反例保护：「阻尼振动」「受迫振动」各只在一座岛出现（不是跨会话共享概念），
        # 所以「振动」不算 covered——它照旧是跨岛家族证据（前端用它摆位）
        items = {
            "k1": _item("k1", S1, "阻尼振动"),
            "k2": _item("k2", S2, "受迫振动"),
        }
        out = build_continent(items, SESSIONS)
        entry = next(s for s in out["shared"] if s["label"] == "振动")
        self.assertFalse(entry["covered"])
        self.assertEqual(entry["strength"], "weak")

    def test_covered_requires_every_owner_covered(self):
        # 「拉普拉斯」横跨三座岛，其中一座的标题只有「拉普拉斯方程」（不是共享概念）
        # → 必须照旧独立成城，不能被「拉普拉斯算子」吞掉
        items = {
            "k1": _item("k1", S1, "拉普拉斯算子的定义"),
            "k2": _item("k2", S2, "拉普拉斯算子的坐标表达"),
            "k3": _item("k3", S3, "拉普拉斯方程"),
        }
        out = build_continent(items, SESSIONS)
        by_label = {s["label"]: s for s in out["shared"] if s["kind"] == "title"}
        self.assertIn("拉普拉斯算子", by_label)
        self.assertIn("拉普拉斯", by_label)
        self.assertFalse(by_label["拉普拉斯"]["covered"])

    def test_covered_entry_keeps_owners_and_links(self):
        # covered 只是「不单独成城」：证据字段一个都不能少（折叠清单要能照报、能跳转）
        items = {}
        for i in range(8):
            items[f"e{i}"] = _item(f"e{i}", f"sess_e{i}", "能量守恒定律", created=i)
        items["a1"] = _item("a1", S1, "角动量守恒定律与开普勒第二定律", created=1)
        items["a2"] = _item("a2", S2, "角动量守恒定律的矢量推导", created=2)
        out = build_continent(items, {})
        entry = next(s for s in out["shared"] if s["label"] == "量守恒定律")
        self.assertEqual(len(entry["owners"]), 10)
        self.assertTrue(entry["links"])
        self.assertEqual(len([s for s in out["shared"] if s["label"] == "量守恒定律"]), 1)


class BuildContinentOwnersTest(unittest.TestCase):
    """v5.1 边界城市：「重逢清单」要按岛列出**全部**命中卡，光有 links（每会话一张
    代表卡）不够——owners 是本条共享概念的完整命中集合，两种字段并存、分工不同。"""

    def test_owners_list_every_hit_not_just_representative(self):
        # 同一会话里两张卡都命中：links 只给一张代表卡，owners 必须两张都在
        items = {
            "k1": _item("k1", S1, "简谐运动", created=1),
            "k2": _item("k2", S1, "简谐运动方程", created=2),
            "k3": _item("k3", S2, "简谐运动的能量", created=3),
        }
        out = build_continent(items, SESSIONS)
        entry = next(s for s in out["shared"] if s["label"] == "简谐运动")
        self.assertEqual(sorted(entry["owners"]), ["k1", "k2", "k3"])
        # links 仍旧是「每会话一张代表卡」：S1 的代表是最早学的 k1
        s1_ends = {l["from"] for l in entry["links"] if l["fromSession"] == S1} | \
            {l["to"] for l in entry["links"] if l["toSession"] == S1}
        self.assertEqual(s1_ends, {"k1"})

    def test_owners_in_learning_order(self):
        # 前端重逢清单按岛分组后照 owners 顺序列卡：**每个会话内部**必须是学习顺序
        # （createdAt 升序）——跨会话怎么交错无所谓，同岛顺序错了清单就读不懂
        items = {
            "k1": _item("k1", S1, "简谐运动", created=30),
            "k2": _item("k2", S1, "简谐运动的相位", created=10),
            "k3": _item("k3", S2, "简谐运动方程", created=20),
        }
        out = build_continent(items, SESSIONS)
        entry = next(s for s in out["shared"] if s["label"] == "简谐运动")
        self.assertEqual([iid for iid in entry["owners"] if iid in ("k1", "k2")], ["k2", "k1"])

    def test_owners_capped_and_never_dangling(self):
        # 上限只防脏数据撑爆 payload；且 owners 里的 id 必须都在投影里（前端要拿它查标题）
        items = {}
        for i in range(60):
            sid = S1 if i % 2 == 0 else S2
            items["k%02d" % i] = _item("k%02d" % i, sid, "简谐运动与相位", created=i)
        out = build_continent(items, SESSIONS)
        entry = next(s for s in out["shared"] if s["label"] == "简谐运动")
        self.assertLessEqual(len(entry["owners"]), 40)
        projected = {it["itemId"] for c in out["clusters"] for it in c["items"]}
        self.assertTrue(set(entry["owners"]) <= projected)

    def test_every_shared_entry_carries_owners(self):
        # 契约字段：前端重逢清单按 owners 展开同岛多卡，缺字段只能退回代表卡一张
        items = {
            "k1": _item("k1", S1, "简谐运动", ["$kx$"]),
            "k2": _item("k2", S3, "简谐运动的能量", ["$kx$"]),
            "k3": _item("k3", S2, "受迫振动"),
            "k4": _item("k4", S3, "阻尼振动"),
        }
        out = build_continent(items, SESSIONS)
        self.assertTrue(out["shared"])
        for s in out["shared"]:
            self.assertTrue(s["owners"], s["label"])
            self.assertTrue(set(s["owners"]) <= {i["itemId"] for c in out["clusters"]
                                                 for i in c["items"]})

    def test_owners_do_not_leak_unrelated_items(self):
        items = {
            "k1": _item("k1", S1, "阻尼振动", created=1),
            "k2": _item("k2", S2, "非线性振动", created=2),
            "k3": _item("k3", S3, "矩阵分解", created=3),
        }
        out = build_continent(items, SESSIONS)
        entry = next(s for s in out["shared"] if s["label"] == "振动")
        self.assertNotIn("k3", entry["owners"])
        self.assertEqual(sorted(entry["owners"]), ["k1", "k2"])

    def test_owners_tolerate_string_and_dirty_timestamps(self):
        # 真机存量数据里有字符串 createdAt（实测 3 条）：原值当排序键会 int/str 比较
        # 抛 TypeError，把整条 /api/continent 打成 500（真机踩过，必须兜底）
        items = {
            "k1": _item("k1", S1, "简谐运动", created="1788010733166"),
            "k2": _item("k2", S1, "简谐运动的相位", created=1788010771879),
            "k3": _item("k3", S2, "简谐运动方程", created=None),
            "k4": _item("k4", S3, "简谐运动的能量", created="坏时间戳"),
        }
        out = build_continent(items, SESSIONS)
        entry = next(s for s in out["shared"] if s["label"] == "简谐运动")
        self.assertEqual(sorted(entry["owners"]), ["k1", "k2", "k3", "k4"])


class BuildContinentSummaryFieldTest(unittest.TestCase):
    """v5.3「问 Φ」：折叠清单行可把两边条目的「标题+摘要」打包给模型判断，条目行
    因此携带 summary——但只认 model/manual 的真摘要：local 是模板文案，喂给模型
    反而误导判断（与概念地基「摘要只认 model/manual」同一口径）；旧数据无
    summarySource 字段视为 local。"""

    def _items(self):
        return {
            "k1": _item("k1", S1, "简谐运动", created=1),
            "k2": _item("k2", S2, "简谐运动的能量", created=2),
        }

    def _rows(self, items):
        out = build_continent(items, SESSIONS)
        return {it["itemId"]: it for c in out["clusters"] for it in c["items"]}

    def test_model_summary_carried_local_dropped(self):
        items = self._items()
        items["k1"]["summary"] = "位移随时间按余弦变化的运动"
        items["k1"]["summarySource"] = "model"
        items["k2"]["summary"] = "模板文案"
        items["k2"]["summarySource"] = "local"
        rows = self._rows(items)
        self.assertEqual(rows["k1"]["summary"], "位移随时间按余弦变化的运动")
        self.assertEqual(rows["k2"]["summary"], "")

    def test_manual_summary_carried_and_missing_source_treated_local(self):
        items = self._items()
        items["k1"]["summary"] = "用户手写的理解"
        items["k1"]["summarySource"] = "manual"
        items["k2"]["summary"] = "旧数据的模板摘要"  # 无 summarySource → 视为 local
        rows = self._rows(items)
        self.assertEqual(rows["k1"]["summary"], "用户手写的理解")
        self.assertEqual(rows["k2"]["summary"], "")

    def test_summary_clipped(self):
        items = self._items()
        items["k1"]["summary"] = "长" * 200
        items["k1"]["summarySource"] = "model"
        rows = self._rows(items)
        self.assertLessEqual(len(rows["k1"]["summary"]), 81)  # 80 字 + 省略号


class BuildContinentUserEdgeTest(unittest.TestCase):
    """v2 主图簇间边：校验 / 悬空 / 去重。"""

    def _items(self):
        return {
            "k1": _item("k1", S1, "阻尼振动", created=1),
            "k2": _item("k2", S2, "非线性振动", created=2),
            "k3": _item("k3", S3, "梯度", created=3),
        }

    def test_valid_edge_passes_with_recomputed_sessions(self):
        # 端点会话以 item_session 现算为准：存了错的 fromSession 也会被纠正
        edges = [{"id": "e1", "fromItem": "k1", "toItem": "k2",
                  "fromSession": "sess_wrong", "toSession": S2,
                  "label": "同为振动", "createdAt": 9}]
        out = build_continent(self._items(), SESSIONS, edges)
        self.assertEqual(len(out["userEdges"]), 1)
        edge = out["userEdges"][0]
        self.assertEqual(edge["fromSession"], S1)
        self.assertEqual(edge["toSession"], S2)
        self.assertEqual(edge["label"], "同为振动")
        self.assertEqual(out["danglingEdges"], [])

    def test_missing_endpoint_becomes_dangling(self):
        edges = [
            {"id": "e1", "fromItem": "k1", "toItem": "gone", "createdAt": 1},
            {"id": "e2", "fromItem": "gone1", "toItem": "k2", "createdAt": 2},
            {"id": "e3", "fromItem": "g1", "toItem": "g2", "createdAt": 3},
        ]
        out = build_continent(self._items(), SESSIONS, edges)
        self.assertEqual(out["userEdges"], [])
        missing = sorted(e["missing"] for e in out["danglingEdges"])
        self.assertEqual(missing, ["both", "from", "to"])

    def test_same_session_edge_is_dangling_not_valid(self):
        # 两端都在但同会话：不是簇间边，走断桥通道等清理，绝不进 userEdges
        edges = [{"id": "e1", "fromItem": "k1", "toItem": "kX", "createdAt": 1},
                 {"id": "e2", "fromItem": "k1", "toItem": "k1", "createdAt": 2}]
        # kX 不存在 → to；自环直接丢弃（连 dangling 都不进）
        edges.append({"id": "e3", "fromItem": "k1", "toItem": "k2", "createdAt": 3})
        items = self._items()
        items["k2"]["sessionId"] = S1  # 挪进同一会话
        out = build_continent(items, SESSIONS, edges)
        self.assertEqual(out["userEdges"], [])
        kinds = sorted(e["missing"] for e in out["danglingEdges"])
        self.assertEqual(kinds, ["same_session", "to"])

    def test_duplicate_pair_keeps_latest(self):
        edges = [
            {"id": "e1", "fromItem": "k1", "toItem": "k2", "label": "旧", "createdAt": 1},
            {"id": "e2", "fromItem": "k2", "toItem": "k1", "label": "新", "createdAt": 2},
        ]
        out = build_continent(self._items(), SESSIONS, edges)
        self.assertEqual([e["id"] for e in out["userEdges"]], ["e2"])
        self.assertEqual(out["userEdges"][0]["label"], "新")

    def test_selfloop_and_blank_ids_dropped(self):
        edges = [
            {"id": "", "fromItem": "k1", "toItem": "k2", "createdAt": 1},
            {"id": "e2", "fromItem": "k3", "toItem": "k3", "createdAt": 2},
        ]
        out = build_continent(self._items(), SESSIONS, edges)
        self.assertEqual(out["userEdges"], [])
        self.assertEqual(out["danglingEdges"], [])

    def test_payload_accepts_bare_list_and_wrapped(self):
        self.assertEqual(len(normalize_user_edge_payload([{"id": "e"}])), 1)
        self.assertEqual(len(normalize_user_edge_payload({"edges": [{"id": "e"}]})), 1)
        self.assertEqual(normalize_user_edge_payload("junk"), [])
        self.assertEqual(normalize_user_edge_payload(None), [])
        self.assertEqual(normalize_user_edge_payload({"edges": "junk"}), [])

    def test_no_edges_yields_empty_lists(self):
        out = build_continent(self._items(), SESSIONS)
        self.assertEqual(out["userEdges"], [])
        self.assertEqual(out["danglingEdges"], [])


if __name__ == "__main__":
    unittest.main()
