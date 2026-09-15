"""大陆投影（大陆计划 v1）纯函数测试：聚簇 / 共享概念 / 契约字段。

build_continent 必须长期保持三条性质（见模块 docstring）：
- 纯函数：无 IO、无模型调用、不改入参；
- 查空是正常路径：空库 / 单会话 / 零跨会话重叠 → shared 为空，不报错；
- 公式键只有一把：token 必须经 knowledge._formula_key 归一化（TeX 命令名与
  单字母不参与，否则任意两条含积分的公式互相成为「同源概念」）。
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

from server.continent import build_continent  # noqa: E402

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
        build_continent(items, sessions)
        self.assertEqual(items, before)
        self.assertEqual(sessions, SESSIONS)


if __name__ == "__main__":
    unittest.main()
