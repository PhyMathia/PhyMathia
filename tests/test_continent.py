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
        # 「度的」「的定义」这类含功能字的碎片不是领域词：梯度/散度只共享功能碎片
        items = {
            "k1": _item("k1", S1, "梯度的定义"),
            "k2": _item("k2", S2, "散度的定义"),
        }
        out = build_continent(items, SESSIONS)
        self.assertEqual(out["shared"], [])

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
