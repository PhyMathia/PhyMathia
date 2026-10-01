"""Unit tests for the refactored src/server package (PhyMathia backend modules)."""

import asyncio
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

from server import backup as backup_mod
from server import config as config_mod
from server import context as context_mod
from server import concept as concept_mod
from server import documents as documents_mod
from server import knowledge as knowledge_mod
from server import prompts as prompts_mod
from server import storage as storage_mod


class StorageTest(unittest.TestCase):
    def test_write_read_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kv.json"
            storage_mod._write_json(path, {"a": 1, "中文": [1, 2]})
            self.assertEqual(storage_mod._read_json(path), {"a": 1, "中文": [1, 2]})

    def test_read_missing_returns_default(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(storage_mod._read_json(Path(td) / "missing.json"), {})
            self.assertEqual(storage_mod._read_json(Path(td) / "missing.json", []), [])

    def test_mutate_json_serialized(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kv.json"
            storage_mod._write_json(path, {"n": 1})
            storage_mod._mutate_json(path, lambda d: {**d, "n": d.get("n", 0) + 1})
            self.assertEqual(storage_mod._read_json(path)["n"], 2)

    def test_delete_by_session(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "formulas.json"
            storage_mod._write_json(path, {
                "f1": {"sessionId": "sess_a"},
                "f2": {"sessionId": "sess_b"},
            })
            removed = storage_mod._delete_by_session(path, "sess_a")
            self.assertEqual(removed, 1)
            self.assertNotIn("f1", storage_mod._read_json(path))
            self.assertIn("f2", storage_mod._read_json(path))


class FormulaTest(unittest.TestCase):
    def test_normalize_formula_wraps_dollars(self):
        self.assertEqual(knowledge_mod._normalize_formula("F=-kx"), "$F=-kx$")
        self.assertEqual(knowledge_mod._normalize_formula("$F=-kx$"), "$F=-kx$")
        self.assertEqual(knowledge_mod._normalize_formula(""), "")

    def test_normalize_formula_cleans_escapes(self):
        self.assertEqual(knowledge_mod._normalize_formula("\\$x\\$"), "$x$")
        self.assertEqual(knowledge_mod._normalize_formula("\\=x"), "$=x$")

    def test_looks_like_formula(self):
        self.assertTrue(knowledge_mod._looks_like_formula("$F=-kx$"))
        self.assertTrue(knowledge_mod._looks_like_formula("E=mc^2"))
        self.assertFalse(knowledge_mod._looks_like_formula("m"))
        self.assertFalse(knowledge_mod._looks_like_formula("rad/s"))
        self.assertFalse(knowledge_mod._looks_like_formula("\\omega"))
        self.assertFalse(knowledge_mod._looks_like_formula("\\text{rad/s}"))

    def test_formula_key_ignores_spacing(self):
        self.assertEqual(
            knowledge_mod._formula_key("$F = -kx$"),
            knowledge_mod._formula_key("F=-kx"),
        )


class KnowledgeTest(unittest.TestCase):
    def test_normalize_knowledge_formats(self):
        items = [{"id": "k1", "title": "导数"}]
        self.assertEqual(knowledge_mod._normalize_knowledge({"items": items}), {"k1": items[0]})
        self.assertEqual(knowledge_mod._normalize_knowledge({"items": None}), {})

    def test_dedupe_knowledge_merges_same_session_title(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "旧"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "新"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        self.assertEqual(list(result.values())[0]["summary"], "新")

    def test_dedupe_formula_map_merges_by_key(self):
        data = {
            "f1": {"latex": "$F=-kx$", "sessionId": "s1", "meaning": "旧"},
            "f2": {"latex": "$F = -kx$", "sessionId": "s1", "meaning": "新"},
        }
        result = knowledge_mod._dedupe_formula_map(data)
        self.assertEqual(len(result), 1)

    def test_dedupe_knowledge_merges_across_sessions_with_session_ids(self):
        # T146：同名概念分属两个会话 → 全局合并为一条，sessionIds 记录双归属；
        # 保优排序同源（都无 summarySource → local）时长 summary tie-break 胜出
        data = {
            "k1": {"title": "梯度", "sessionId": "s1", "summary": "短摘要", "createdAt": 1},
            "k2": {"title": "梯度", "sessionId": "s2", "summary": "更长的梯度摘要，保优后应胜出", "createdAt": 2},
            "k3": {"title": "散度", "sessionId": "s1", "summary": "不重复条目", "createdAt": 3},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 2)
        self.assertIn("k3", result)  # 不重复条目原样保留
        merged = result["k2"]
        self.assertEqual(merged["summary"], "更长的梯度摘要，保优后应胜出")
        self.assertEqual(merged["sessionIds"], ["s1", "s2"])

    def test_dedupe_formula_map_cross_session_merges_with_session_ids(self):
        # T146：同一公式跨会话（空格变体同键）合并为一条；meaningSource=model
        # 保优胜出，sessionIds 含两个会话且保留条（model）的会话在前
        data = {
            "f1": {"latex": "$F=-kx$", "sessionId": "s1", "meaning": "旧", "createdAt": 1},
            "f2": {"latex": "$F = -kx$", "sessionId": "s2", "meaning": "新",
                   "meaningSource": "model", "createdAt": 2},
        }
        result = knowledge_mod._dedupe_formula_map(data)
        self.assertEqual(len(result), 1)
        merged = result["f2"]
        self.assertEqual(merged["meaning"], "新")
        self.assertEqual(merged["meaningSource"], "model")
        self.assertEqual(merged["sessionIds"], ["s2", "s1"])

    def test_delete_items_by_session_strips_and_reprimary(self):
        # T146：sessionIds 感知的按会话删除——条目从该会话归属里摘除，还有别的
        # 归属就把主 sessionId 改到剩余归属（孤儿闸门要求 sessionId 指向活会话），
        # 归属清零才整条删除
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "knowledge.json"
            storage_mod._write_json(path, {
                "k1": {"title": "梯度", "sessionId": "s2", "sessionIds": ["s2", "s1"]},
                "k2": {"title": "散度", "sessionId": "s1"},
            })

            # 两条都受影响：「散度」归属清零整条删、「梯度」摘除 s1 归属（返回
            # 受影响条数，两个分支都计数）
            removed = knowledge_mod._delete_items_by_session(path, "s1")
            self.assertEqual(removed, 2)
            data = storage_mod._read_json(path)
            self.assertEqual(set(data), {"k1"})  # 只剩「梯度」
            self.assertEqual(data["k1"]["sessionId"], "s2")
            # 只剩单一归属：sessionIds 收敛为 ["s2"]（实现直接移除该键，等价口径）
            self.assertEqual(data["k1"].get("sessionIds", ["s2"]), ["s2"])

            removed = knowledge_mod._delete_items_by_session(path, "s2")
            self.assertEqual(removed, 1)
            self.assertEqual(storage_mod._read_json(path), {})

    def test_normalize_formula_map(self):
        self.assertEqual(
            knowledge_mod._normalize_formula_map([{"id": "f1", "latex": "$a$"}]),
            {"f1": {"id": "f1", "latex": "$a$"}},
        )


class KnowledgeTitleHygieneTest(unittest.TestCase):
    """v4 标题卫生：一把尺子（章节号 / 指令句 / 整句 / 超长），提取与大陆共用。

    真机现场：一条 40 字推理泄漏条目（标题=用户整句话）在知识大陆上炸出 4 条虚假
    共享概念（梯度/正交/坐标/表达），全部来自长句里的语法碎片。
    """

    def test_section_prefix_stripped_from_title(self):
        self.assertEqual(knowledge_mod._clean_knowledge_title("1. 定义与坐标表达"), "定义与坐标表达")
        self.assertEqual(
            knowledge_mod._clean_knowledge_title("二、从微元立方体导出直角坐标表达式"),
            "从微元立方体导出直角坐标表达式")
        self.assertEqual(
            knowledge_mod._clean_knowledge_title("2. 几何意义：方向导数与等值面正交性（续）"),
            "几何意义：方向导数与等值面正交性")

    def test_junk_title_predicate(self):
        # 指令句回显 / 整句 → 不是知识
        self.assertTrue(knowledge_mod._is_junk_knowledge_title(
            "用户要求：从方向导数最大值推导梯度在直角坐标下的分量表达式。这是一"))
        self.assertTrue(knowledge_mod._is_junk_knowledge_title("请详细讲解梯度的几何意义。"))
        # 章节号标题与叙述句是「不是概念名」，但仍是真卡片：不许当垃圾删
        self.assertFalse(knowledge_mod._is_junk_knowledge_title("1. 定义与坐标表达"))
        self.assertFalse(knowledge_mod._is_junk_knowledge_title("从微元立方体导出直角坐标表达式"))

    def test_concept_like_title_predicate(self):
        self.assertTrue(knowledge_mod._is_concept_like_title("简谐运动"))
        self.assertTrue(knowledge_mod._is_concept_like_title("梯度的几何意义：方向导数与等值超曲面"))
        # 章节号（即便剥完是像样的短语）/ 叙述口吻 / 超长句都不当共享证据来源
        self.assertFalse(knowledge_mod._is_concept_like_title("1. 定义与坐标表达"))
        self.assertFalse(knowledge_mod._is_concept_like_title("2. 几何意义：方向导数与等值面正交性（续）"))
        self.assertFalse(knowledge_mod._is_concept_like_title("二、从微元立方体导出直角坐标表达式"))
        self.assertFalse(knowledge_mod._is_concept_like_title("从微元立方体导出直角坐标表达式"))
        self.assertFalse(knowledge_mod._is_concept_like_title("很长" * 20))

    def test_formula_rejects_chinese_prose(self):
        # 推理泄漏正文被"提取"成公式的原样：含中文散文且无任何 LaTeX 结构
        self.assertFalse(knowledge_mod._looks_like_formula(
            '$标签包裹。物理直觉里"尽量少公式"。如果有公式如 "f"，用 f$'))
        # 带结构与数字的中文公式照旧是真公式
        self.assertTrue(knowledge_mod._looks_like_formula(r"$\text{速度} = \frac{ds}{dt}$"))
        self.assertTrue(knowledge_mod._looks_like_formula("$F=-kx$"))

    def test_parse_extract_json_drops_junk_title(self):
        text = json.dumps({"items": [
            {"title": "简谐运动", "category": "physics", "summary": "周期性振动",
             "formulas": ["$F=-kx$"]},
            {"title": "用户要求：从方向导数最大值推导梯度在直角坐标下的分量表达式。这是一",
             "category": "math", "summary": "泄漏正文", "formulas": ["$标签包裹。物理直觉里$"]},
        ]}, ensure_ascii=False)
        items = knowledge_mod._parse_extract_json(f"```json\n{text}\n```")
        self.assertEqual([it["title"] for it in items], ["简谐运动"])

    def test_reasoning_leak_predicate(self):
        leak = ('用户要求：从方向导数最大值推导梯度在直角坐标下的分量表达式。这是一个数学主题。'
                '当前分支类型是"进阶学习"，需要生成完整探索回答簇，公式用标签包裹。')
        self.assertTrue(knowledge_mod._looks_like_reasoning_leak(leak))
        normal = "## 梯度的定义\n在直角坐标系中，梯度是这样一个向量：<formula>\\nabla f</formula>"
        self.assertFalse(knowledge_mod._looks_like_reasoning_leak(normal))
        self.assertFalse(knowledge_mod._looks_like_reasoning_leak(""))

    def test_acceptable_item_gate_exempts_manual(self):
        junk = {"title": "用户要求：随便写的。这是一句整句", "source": "ai_extract"}
        self.assertFalse(knowledge_mod._is_acceptable_knowledge_item(junk))
        self.assertTrue(knowledge_mod._is_acceptable_knowledge_item(dict(junk, source="manual")))
        self.assertTrue(knowledge_mod._is_acceptable_knowledge_item({"title": "简谐运动", "source": "ai_extract"}))
        self.assertFalse(knowledge_mod._is_acceptable_knowledge_item(None))


class KnowledgeSummaryTest(unittest.TestCase):
    """P2 知识点摘要方案 A：summarySource/anchorSummary 契约与保优合并。"""

    def test_summary_source_rank(self):
        self.assertEqual(knowledge_mod._summary_source_rank({"summarySource": "manual"}), 0)
        self.assertEqual(knowledge_mod._summary_source_rank({"summarySource": "model"}), 1)
        self.assertEqual(knowledge_mod._summary_source_rank({"summarySource": "local"}), 2)
        # 旧数据无该字段一律视为 local
        self.assertEqual(knowledge_mod._summary_source_rank({}), 2)
        self.assertEqual(knowledge_mod._summary_source_rank(None), 2)

    def test_dedupe_knowledge_manual_beats_longer_model(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "手动写的摘要", "summarySource": "manual"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "模型生成的更长的导数摘要，不应覆盖手动摘要",
                    "summarySource": "model"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        self.assertEqual(list(result.values())[0]["summary"], "手动写的摘要")
        self.assertEqual(list(result.values())[0]["summarySource"], "manual")

    def test_dedupe_knowledge_model_beats_longer_local(self):
        # 整卡摘要（local）更长也不得把模型逐条摘要（model）拉回去：长度只在同源时比
        data = {
            "k1": {"title": "简谐运动", "sessionId": "s1", "summary": "很长的本地整卡摘要" * 10},
            "k2": {"title": "简谐运动", "sessionId": "s1", "summary": "回复力与位移成正比的周期性振动",
                    "summarySource": "model"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        kept = list(result.values())[0]
        self.assertEqual(kept["summary"], "回复力与位移成正比的周期性振动")
        self.assertEqual(kept["summarySource"], "model")

    def test_dedupe_knowledge_same_source_length_tiebreak(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "短", "summarySource": "local"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "更长的同源摘要", "summarySource": "local"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(list(result.values())[0]["summary"], "更长的同源摘要")

    def test_dedupe_knowledge_missing_source_treated_as_local(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "旧数据无来源字段"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "模型摘要", "summarySource": "model"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        kept = list(result.values())[0]
        self.assertEqual(kept["summary"], "模型摘要")
        self.assertEqual(kept["summarySource"], "model")

    def test_dedupe_knowledge_keeps_group_when_keeper_summary_empty(self):
        # 手动条目摘要在收藏时可留空：保优保留该条目本身，但摘要从组内非空成员继承
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "", "summarySource": "manual"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "本地整卡摘要", "summarySource": "local",
                    "anchorSummary": "本地整卡摘要"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        kept = list(result.values())[0]
        self.assertEqual(kept["summarySource"], "manual")  # 条目本身保留（手动收藏不丢）
        self.assertEqual(kept["summary"], "本地整卡摘要")  # 摘要内容不丢
        self.assertEqual(kept["anchorSummary"], "本地整卡摘要")

    def test_dedupe_knowledge_anchor_summary_inherited_from_group(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "模型逐条摘要", "summarySource": "model"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "整卡摘要", "summarySource": "local",
                    "anchorSummary": "整卡摘要"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        kept = list(result.values())[0]
        self.assertEqual(kept["summarySource"], "model")
        self.assertEqual(kept["anchorSummary"], "整卡摘要")

    def test_dedupe_knowledge_empty_summary_inherits_best_ranked_donor(self):
        # 保留条（manual 空摘要）从组内最高保优等级的非空成员继承摘要，
        # 与前端 dedupeKnowledgeItems 的 ranked（最优在前）同方向——
        # 曾经从最低等级成员取，manual 空摘要条目会拿到 local 整卡摘要而非模型摘要
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "", "summarySource": "manual"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "模型逐条摘要", "summarySource": "model"},
            "k3": {"title": "导数", "sessionId": "s1", "summary": "本地整卡摘要更长", "summarySource": "local"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        kept = list(result.values())[0]
        self.assertEqual(kept["summarySource"], "manual")
        self.assertEqual(kept["summary"], "模型逐条摘要")

    def test_dedupe_knowledge_anchor_prefers_best_ranked_donor(self):
        # 保留条无锚点时从组内最高保优等级成员继承锚点（与前端 ranked 顺序一致）
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "短", "summarySource": "local",
                    "anchorSummary": "锚A"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "更长的本地摘要", "summarySource": "local",
                    "anchorSummary": "锚B"},
            "k3": {"title": "导数", "sessionId": "s1", "summary": "模型摘要", "summarySource": "model"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        kept = list(result.values())[0]
        self.assertEqual(kept["summarySource"], "model")
        self.assertEqual(kept["anchorSummary"], "锚B")

    def test_parse_extract_json_stamps_model_source(self):
        text = json.dumps({"items": [
            {"title": "简谐运动", "category": "physics", "summary": "回复力与位移成正比的周期性振动",
             "formulas": ["$F=-kx$"]},
            {"title": "胡克定律", "category": "physics", "summary": "弹簧弹力与形变量成正比",
             "formulas": ["$F=-kx$"]},
        ]}, ensure_ascii=False)
        items = knowledge_mod._parse_extract_json(f"```json\n{text}\n```")
        self.assertEqual(len(items), 2)
        for it in items:
            self.assertEqual(it["summarySource"], "model")
        # 同次多条 summary 各自保留（互异性的解析基础，不被整卡摘要覆盖）
        self.assertEqual(items[0]["summary"], "回复力与位移成正比的周期性振动")
        self.assertEqual(items[1]["summary"], "弹簧弹力与形变量成正比")

    def test_local_extract_knowledge_templates_summary_and_keeps_anchor(self):
        messages = [{"role": "assistant", "content":
            "# 简谐运动\n物体受回复力作用做简谐运动。<formula>F=-kx</formula>\n"
            "<summary>简谐运动核心摘要</summary>"}]
        items = knowledge_mod._local_extract_knowledge(messages)
        self.assertEqual(len(items), 1)
        it = items[0]
        self.assertEqual(it["summarySource"], "local")
        # P4 模板化：展示摘要 = 「{标题}」：{首个公式含义（规则表）}（{分类}），
        # 不再是整卡摘要原文；整卡摘要原文仅落为定位锚点
        self.assertEqual(
            it["summary"],
            "「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）")
        self.assertNotEqual(it["anchorSummary"], it["summary"])
        self.assertIn("简谐运动核心摘要", it["anchorSummary"])

    def test_local_knowledge_summary_without_formulas(self):
        # 无公式退化模板：标题 + 分类，不同标题文案不同
        s1 = knowledge_mod._local_knowledge_summary("导数", [], "math")
        s2 = knowledge_mod._local_knowledge_summary("动量守恒", [], "physics")
        self.assertEqual(s1, "「导数」：数学知识点")
        self.assertEqual(s2, "「动量守恒」：物理知识点")
        self.assertNotEqual(s1, s2)

    def test_local_knowledge_summary_long_title_keeps_structure(self):
        # 审查修复回归：120 硬截断不得截出残缺文案——超长标题先按预算压缩，
        # 「」/公式含义/分类括注保持完整；概念回退含义以标题为原料（≈2×标题长），
        # 收紧时先用 24 字标题上限压含义；原本适配的短标题输出逐字不变
        unit = "很长的知识点标题"
        long_title = unit * 15  # 120 字标题
        s = knowledge_mod._local_knowledge_summary(long_title, ["F=ma"], "physics")
        self.assertEqual(len(s), 120)
        self.assertTrue(s.startswith("「"))
        self.assertTrue(s.endswith("（物理）"))
        # 概念回退含义完整（含义基于 24 字标题上限，不再被截断）
        self.assertIn(unit * 3 + "相关公式：用于描述" + unit * 3 + "的定量关系", s)
        s2 = knowledge_mod._local_knowledge_summary(long_title, [], "math")
        self.assertEqual(len(s2), 120)
        self.assertTrue(s2.startswith("「"))
        self.assertTrue(s2.endswith("」：数学知识点"))
        # 规则表命中的公式：超长标题压缩后含义仍逐字完整
        s3 = knowledge_mod._local_knowledge_summary(long_title, ["$F=-kx$"], "physics")
        self.assertEqual(len(s3), 120)
        self.assertIn("胡克定律：回复力与位移大小成正比、方向相反", s3)
        self.assertTrue(s3.endswith("（物理）"))
        # 原本适配的短标题输出逐字不变（口径回归）
        self.assertEqual(
            knowledge_mod._local_knowledge_summary("简谐运动", ["$F=-kx$"], "physics"),
            "「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）")
        self.assertEqual(
            knowledge_mod._local_knowledge_summary("导数", [], "math"),
            "「导数」：数学知识点")

    def test_local_extract_summaries_differ_for_multi_formula_answers(self):
        # P4 验收：同一回答多公式输入 → 本地提取各条 summary 互不相同。
        # 本地兜底链路每次从最近一条 assistant 提取一条；对同一会话的多条
        # （多公式）回答逐条提取，各条 summary 必须互不相同（离线不再千篇一律），
        # 且都不等于各自 anchorSummary（整卡摘要仅作定位锚点）。
        answers = [
            # 多公式回答：摘要取首个公式的规则含义（胡克定律），不串到第二公式（周期）
            "# 简谐运动\n回复力让物体振动。\n<formula>F=-kx</formula>\n"
            "<formula>T=2\\pi\\sqrt{\\frac{m}{k}}</formula>\n<summary>甲卡整卡摘要</summary>",
            "# 傅里叶级数\n周期信号可分解为谐波叠加。\n"
            "<formula>\\sum_{n=1}^{\\infty}a_n e^{inx}</formula>\n<summary>乙卡整卡摘要</summary>",
            "# 傅里叶变换\n把信号分解为连续频率分量。\n"
            "<formula>\\int_0^{T}f(t)dt</formula>\n<summary>丙卡整卡摘要</summary>",
            "# 简谐运动能量\n总机械能与振幅平方成正比。\n"
            "<formula>E=\\frac{1}{2}kA^2</formula>\n<summary>丁卡整卡摘要</summary>",
            "# 导数\n刻画函数的瞬时变化率，本卡没有公式。",
        ]
        summaries, anchors = [], []
        for content in answers:
            items = knowledge_mod._local_extract_knowledge(
                [{"role": "assistant", "content": content}])
            self.assertEqual(len(items), 1)
            summaries.append(items[0]["summary"])
            anchors.append(items[0]["anchorSummary"])
        # 逐字锁定模板口径（与 frontend_smoke 的 P4 用例同一组期望文案，
        # 前端 _buildLocalKnowledgeSummary 逐字同口径，两侧摘要不冲突）
        self.assertEqual(summaries, [
            "「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）",
            "「傅里叶级数」：傅里叶级数/变换：用指数基元把信号分解为频率成分（物理）",
            "「傅里叶变换」：傅里叶变换：把信号分解为连续频率分量的积分表示（其他）",
            "「简谐运动能量」：简谐运动总机械能与振幅平方成正比（物理）",
            "「导数」：数学知识点",
        ])
        # 各条互不相同（不同公式/概念 → 不同文案）
        self.assertEqual(len(set(summaries)), len(summaries))
        for summary, anchor in zip(summaries, anchors):
            self.assertNotEqual(summary, anchor)
        # 多公式回答取首个公式的含义（胡克定律），不取第二公式（周期）含义
        self.assertIn("胡克定律", summaries[0])
        self.assertNotIn("周期", summaries[0])
        # 无公式回答退化为「标题 + 分类」模板
        self.assertEqual(summaries[4], "「导数」：数学知识点")
        # 同一回答多公式的每条公式含义互不相同（互异性的确定性来源）
        meanings = [knowledge_mod._local_formula_meaning(f, "", "简谐运动") for f in
                    ("$F=-kx$", "$T=2\\pi\\sqrt{\\frac{m}{k}}$", "$E=\\frac{1}{2}kA^2$")]
        self.assertEqual(len(set(meanings)), len(meanings))

    def test_describe_formulas_returns_formula_and_knowledge_blocks(self):
        payload = {"choices": [{"message": {"content": json.dumps({
            "descriptions": {"$F=-kx$": "胡克定律：弹力与形变量成正比"},
            "summaries": {"简谐运动": "回复力与位移成正比的周期性振动，F=-kx 表征回复力线性特征"},
        }, ensure_ascii=False)}}]}
        fake = _FakeDescribeClient(payload)
        with mock.patch.object(knowledge_mod, "get_http_client", return_value=fake):
            descs, summaries = asyncio.run(knowledge_mod._describe_formulas(
                "整卡摘要", ["$F=-kx$"], [{"title": "简谐运动", "formulas": ["$F=-kx$"]}],
                "deepseek", "key", "test-model", "https://api.example.com", "university"))
        self.assertEqual(descs, {"$F=-kx$": "胡克定律：弹力与形变量成正比"})
        self.assertEqual(summaries, {"简谐运动": "回复力与位移成正比的周期性振动，F=-kx 表征回复力线性特征"})
        # 知识点列表并入同一次请求（不增加请求数）
        self.assertEqual(len(fake.calls), 1)
        user_content = fake.calls[0]["json"]["messages"][1]["content"]
        self.assertIn("公式列表", user_content)
        self.assertIn("知识点列表", user_content)
        self.assertIn("简谐运动", user_content)

    def test_describe_formulas_runs_for_knowledge_without_formulas(self):
        # 只配置描述模型、无公式时也要能为知识点生成摘要（descriptor-only 场景）
        payload = {"choices": [{"message": {"content": json.dumps({
            "summaries": {"简谐运动": "回复力与位移成正比的周期性振动"}}, ensure_ascii=False)}}]}
        fake = _FakeDescribeClient(payload)
        with mock.patch.object(knowledge_mod, "get_http_client", return_value=fake):
            descs, summaries = asyncio.run(knowledge_mod._describe_formulas(
                "整卡摘要", [], [{"title": "简谐运动", "formulas": []}],
                "deepseek", "key", "test-model", "https://api.example.com", "university"))
        self.assertEqual(descs, {})
        self.assertEqual(summaries["简谐运动"], "回复力与位移成正比的周期性振动")

    def test_describe_formulas_without_model_returns_empty_pair(self):
        descs, summaries = asyncio.run(knowledge_mod._describe_formulas(
            "整卡摘要", ["$F=-kx$"], [{"title": "简谐运动"}],
            "deepseek", "key", "", "https://api.example.com", "university"))
        self.assertEqual((descs, summaries), ({}, {}))

    def test_describe_formulas_rejected_target_returns_empty_pair(self):
        # 描述目标被拒（SSRF 校验失败 / 未知 provider 无官方地址）时也必须返回
        # 二元组空值——main.py 对返回值做元组解包，裸 {} 会让端点直接 500
        descs, summaries = asyncio.run(knowledge_mod._describe_formulas(
            "整卡摘要", ["$F=-kx$"], [{"title": "简谐运动"}],
            "deepseek", "key", "test-model", "http://evil.example.com", "university"))
        self.assertEqual((descs, summaries), ({}, {}))
        descs, summaries = asyncio.run(knowledge_mod._describe_formulas(
            "整卡摘要", ["$F=-kx$"], [{"title": "简谐运动"}],
            "nosuch-provider", "key", "test-model", "", "university"))
        self.assertEqual((descs, summaries), ({}, {}))
        # 非 opencode 系 provider 缺 api_key 的拒绝路径同样返回二元组
        descs, summaries = asyncio.run(knowledge_mod._describe_formulas(
            "整卡摘要", ["$F=-kx$"], [{"title": "简谐运动"}],
            "deepseek", "", "test-model", "https://api.example.com", "university"))
        self.assertEqual((descs, summaries), ({}, {}))

    def test_prompts_carry_summary_constraints(self):
        # 提示词契约回归：摘要约束（≤60 字、禁止近义复述）与双块 JSON 键必须存在
        self.assertIn("60", prompts_mod.EXTRACT_PROMPT)
        self.assertIn("不得相同", prompts_mod.EXTRACT_PROMPT)
        self.assertIn("近义复述", prompts_mod.EXTRACT_PROMPT)
        self.assertIn("summaries", prompts_mod.DESCRIBE_PROMPT)
        self.assertIn("60", prompts_mod.DESCRIBE_PROMPT)


class _FakeDescribeClient:
    """_describe_formulas 的 HTTP 客户端桩：记录请求并返回固定补全响应。"""

    def __init__(self, payload):
        self._payload = payload
        self.calls = []

    async def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        return _FakeDescribeResponse(self._payload)


class _FakeDescribeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


class ContextTest(unittest.TestCase):
    def test_is_socratic_message(self):
        self.assertTrue(context_mod._is_socratic_message({"branch": "socratic", "content": "x"}))
        self.assertTrue(context_mod._is_socratic_message({"content": "[苏格拉底回答] 我的想法"}))
        self.assertTrue(context_mod._is_socratic_message({"content": "<socratic_meta correct='correct'/>"}))
        self.assertFalse(context_mod._is_socratic_message({"content": "普通问题"}))

    def test_is_socratic_followup(self):
        self.assertTrue(context_mod._is_socratic_followup("<socratic_meta correct='correct' done='false'/>"))
        self.assertFalse(context_mod._is_socratic_followup("<physics>完整卡片</physics><socratic_meta/>"))

    def test_recent_context_messages_rounds(self):
        msgs = [{"role": "user", "content": f"u{i}"} for i in range(5)]
        result = context_mod._recent_context_messages(msgs, max_rounds=2)
        # 最近 2 轮完整 + 更早 3 轮一行摘要
        self.assertEqual([m["content"] for m in result], [
            "（更早对话）用户：u0", "（更早对话）用户：u1", "（更早对话）用户：u2", "u3", "u4",
        ])

    def test_recent_context_filters_socratic(self):
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "[苏格拉底回答] 我的回答", "branch": "socratic"},
            {"role": "user", "content": "u2"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=3)
        self.assertNotIn("[苏格拉底回答] 我的回答", [m["content"] for m in result])


    def test_prompt_wants_viz(self):
        self.assertTrue(context_mod._prompt_wants_viz("这个可视化没看懂"))
        self.assertTrue(context_mod._prompt_wants_viz("图里的动画是什么意思"))
        self.assertFalse(context_mod._prompt_wants_viz("讲讲物理意义"))

    def test_trim_context_content_replaces_viz(self):
        big = "<physics>物理正文</physics>\n<viz>```html\n" + ("<div>html内容" * 1500) + "```</viz>\n<summary>一句话摘要</summary>"
        out = context_mod._trim_context_content(big)
        self.assertIn("[交互可视化内容已省略]", out)
        self.assertIn("一句话摘要", out)
        self.assertNotIn("<div>html内容", out)

    def test_trim_context_content_keeps_viz_when_requested(self):
        big = "<viz>```html\n" + ("<div>html内容" * 1500) + "```</viz>"
        out = context_mod._trim_context_content(big, keep_viz=True)
        self.assertIn("[交互可视化摘要]", out)
        self.assertNotIn("<div>html内容", out)

    def test_recent_context_summarizes_old_assistant(self):
        big = "<physics>正文</physics>\n<summary>摘要内容</summary>" + ("很长" * 5000)
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": big},
            {"role": "user", "content": "u2"},
            {"role": "assistant", "content": "短回复"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=2)
        self.assertEqual(result[0]["content"], "u1")
        self.assertIn("摘要内容", result[1]["content"])
        self.assertLess(len(result[1]["content"]), 300)
        self.assertEqual(result[2]["content"], "u2")
        self.assertEqual(result[3]["content"], "短回复")

    def test_recent_context_keeps_viz_by_trigger_prompt(self):
        """前缀缓存拍板（2026-09-21）：viz 折叠判定锚定「触发这条回答的提问」，
        不再随当前提问翻转——同一份历史跨轮字节稳定。"""
        big = "<viz>```html\n" + ("<div>html内容" * 1500) + "```</viz>"
        # 触发提问要可视化：无论当前问什么都保留摘要形态
        msgs = [
            {"role": "user", "content": "做一个弹簧振动可视化"},
            {"role": "assistant", "content": big},
        ]
        viz = context_mod._recent_context_messages(msgs, max_rounds=1, current_prompt="这个可视化没看懂")
        self.assertIn("[交互可视化摘要]", viz[1]["content"])
        viz2 = context_mod._recent_context_messages(msgs, max_rounds=1, current_prompt="接下来讲讲阻尼")
        self.assertEqual(viz, viz2)
        # 触发提问不要可视化：占位符，当前提问再想看也不翻转
        plain = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": big},
        ]
        default = context_mod._recent_context_messages(plain, max_rounds=1, current_prompt="做个可视化看看")
        self.assertIn("[交互可视化内容已省略]", default[1]["content"])

    def test_graph_message_summary_uses_cached(self):
        msg = {"content": "<physics>超长正文</physics>" + ("很长" * 5000), "summary": "缓存的摘要"}
        self.assertEqual(context_mod._graph_message_summary(msg), "缓存的摘要")



    def test_recent_context_digest_pairs_roles(self):
        msgs = [
            {"role": "user", "content": "u0"},
            {"role": "assistant", "content": "<summary>a0</summary>"},
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "<summary>a1</summary>"},
            {"role": "user", "content": "u2"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=1, summary_rounds=2)
        roles = [m["role"] for m in result]
        self.assertEqual(roles, ["user", "assistant", "user", "assistant", "user"])
        self.assertEqual(result[0]["content"], "（更早对话）用户：u0")
        self.assertIn("a0", result[1]["content"])
        self.assertEqual(result[2]["content"], "（更早对话）用户：u1")
        self.assertIn("a1", result[3]["content"])
        self.assertEqual(result[4]["content"], "u2")

    def test_recent_context_budget_applied(self):
        msgs = [{"role": "user", "content": "问题%d" % i + "很长" * 30} for i in range(20)]
        result = context_mod._recent_context_messages(msgs, max_rounds=3, budget_tokens=100)
        total = sum(context_mod.estimate_tokens(m["content"]) for m in result)
        self.assertLessEqual(total, 100)
        self.assertEqual(result[-1]["content"], "问题19" + "很长" * 30)

    def test_shrink_history_to_budget(self):
        msgs = [
            {"role": "user", "content": "u0"},
            {"role": "assistant", "content": "a0 " + "很长" * 500},
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "<summary>最近摘要</summary>" + ("很长" * 5000)},
        ]
        result = context_mod._shrink_history_to_budget(msgs, 400)
        total = sum(context_mod.estimate_tokens(m["content"]) for m in result)
        self.assertLessEqual(total, 400)
        self.assertEqual(result[-1]["role"], "assistant")

    def test_shrink_history_to_budget_protected(self):
        protected = "当前模块正文" + ("很长" * 200)
        msgs = [
            {"role": "user", "content": "u0"},
            {"role": "assistant", "content": "旧回答" + ("很长" * 300)},
            {"role": "assistant", "content": protected},
        ]
        result = context_mod._shrink_history_to_budget(msgs, 150, {protected})
        self.assertEqual(result, [{"role": "assistant", "content": protected}])

    def test_graph_message_summary_cuts_at_sentence(self):
        long_run = "没有标点的补充" * 40
        msg = {"content": "第一句话是物理直觉的完整说明并且足够长超过四十个字符还加了一些额外内容保证句号位置靠后。" + long_run}
        s = context_mod._graph_message_summary(msg)
        self.assertTrue(s.endswith("…"))
        self.assertNotIn("没有标点的补充", s)

    def test_resolve_context_budget(self):
        self.assertEqual(context_mod.resolve_context_budget("deepseek-chat"), 16000)
        self.assertEqual(context_mod.resolve_context_budget("gpt-4o"), 16000)
        self.assertGreaterEqual(context_mod.resolve_context_budget("unknown-model"), 2048)

    def test_path_dedupe_by_ts_and_content(self):
        msgs = [
            {"role": "user", "content": "第一个问题", "timestamp": 1},
            {"role": "assistant", "content": "<summary>回答一</summary>物理正文", "timestamp": 2},
            {"role": "user", "content": "第一个问题", "timestamp": 3},
            {"role": "assistant", "content": "<summary>回答二</summary>数学正文", "timestamp": 4},
        ]
        path = [
            {"kind": "user", "timestamp": 1},
            {"kind": "answer", "timestamp": 2},
            {"kind": "user", "timestamp": 3},
            {"kind": "answer", "timestamp": 4},
        ]
        orig_resolve = context_mod._resolve_messages_path
        orig_read = context_mod._read_json
        context_mod._resolve_messages_path = lambda sid: "fake"
        context_mod._read_json = lambda path_, default: msgs
        try:
            result = context_mod._load_session_context_from_path("s1", path)
        finally:
            context_mod._resolve_messages_path = orig_resolve
            context_mod._read_json = orig_read
        contents = [m["content"] for m in result]
        self.assertEqual(contents.count("第一个问题"), 2)
        self.assertTrue(any("回答一" in c for c in contents))
        self.assertTrue(any("回答二" in c for c in contents))

    def test_path_dedupe_same_ts_same_content(self):
        msgs = [{"role": "user", "content": "重复问题", "timestamp": 1}]
        path = [
            {"kind": "user", "timestamp": 1},
            {"kind": "user", "timestamp": 1},
        ]
        orig_resolve = context_mod._resolve_messages_path
        orig_read = context_mod._read_json
        context_mod._resolve_messages_path = lambda sid: "fake"
        context_mod._read_json = lambda path_, default: msgs
        try:
            result = context_mod._load_session_context_from_path("s1", path)
        finally:
            context_mod._resolve_messages_path = orig_resolve
            context_mod._read_json = orig_read
        contents = [m["content"] for m in result]
        self.assertEqual(contents.count("重复问题"), 1)


class DocumentTest(unittest.TestCase):
    def test_sanitize_filename(self):
        self.assertEqual(documents_mod._sanitize_filename("../evil/name.txt"), "name.txt")
        self.assertEqual(documents_mod._sanitize_filename(""), "upload")
        self.assertEqual(len(documents_mod._sanitize_filename("x" * 300)), 120)

    def test_extract_text_utf8_and_gbk(self):
        self.assertEqual(documents_mod._extract_document_text("a.md", "你好".encode("utf-8")), "你好")
        self.assertEqual(documents_mod._extract_document_text("a.md", "中文".encode("gbk")), "中文")

    def test_extract_unsupported_returns_empty(self):
        self.assertEqual(documents_mod._extract_document_text("a.xyz", b"data"), "")


class BackupTest(unittest.TestCase):
    def test_restore_sessions_merge(self):
        with tempfile.TemporaryDirectory() as td:
            old_path = backup_mod.SESSIONS_PATH
            backup_mod.SESSIONS_PATH = Path(td) / "sessions.json"
            try:
                backup_mod._write_json(backup_mod.SESSIONS_PATH, {"s1": {"id": "s1", "title": "旧"}})
                count = backup_mod._restore_sessions({"s2": {"id": "s2", "title": "新"}}, replace=False)
                self.assertEqual(count, 1)
                data = backup_mod._read_json(backup_mod.SESSIONS_PATH)
                self.assertIn("s1", data)
                self.assertIn("s2", data)
            finally:
                backup_mod.SESSIONS_PATH = old_path


class ContextOptimizationTest(unittest.TestCase):
    def test_recent_context_digest_for_old_rounds(self):
        msgs = []
        for i in range(10):
            msgs.append({"role": "user", "content": "问题" + str(i), "timestamp": "u" + str(i)})
            msgs.append({"role": "assistant", "content": "<summary>答案摘要" + str(i) + "</summary>", "timestamp": "a" + str(i)})
        out = context_mod._recent_context_messages(msgs, max_rounds=3)
        self.assertIn("答案摘要9", out[-1]["content"])
        self.assertEqual(out[-2]["content"], "问题9")
        full_count = sum(1 for m in out if "（更早对话）" not in m["content"])
        digest_count = sum(1 for m in out if "（更早对话）" in m["content"])
        self.assertEqual(full_count, 6)
        # 每个更早轮次拆成「用户一行 + AI 一行」摘要对：7 轮 * 2 = 14 条
        self.assertEqual(digest_count, 14)
        self.assertIn("问题0", out[0]["content"])
        self.assertIn("答案摘要0", out[1]["content"])

    def test_from_path_skips_upstream_when_workflow_context(self):
        msgs = [
            {"role": "user", "content": "q1", "timestamp": "t1"},
            {"role": "assistant", "content": "<physics>A1正文</physics><summary>摘要1</summary>", "timestamp": "t2"},
            {"role": "user", "content": "q2", "timestamp": "t3"},
            {"role": "assistant", "content": "<physics>active正文</physics><summary>摘要2</summary>", "timestamp": "t4"},
        ]
        path = [
            {"timestamp": "t1", "kind": "user"},
            {"timestamp": "t2", "kind": "answer", "module": "physics"},
            {"timestamp": "t3", "kind": "user"},
            {"timestamp": "t4", "kind": "answer", "module": "physics"},
        ]
        orig = context_mod._read_json
        orig_resolve6 = context_mod._resolve_messages_path
        context_mod._read_json = lambda _path, default=None: msgs
        context_mod._resolve_messages_path = lambda sid: "fake"
        try:
            out = context_mod._load_session_context_from_path(
                "sess_x", path, workflow_context={"upstream": [{"label": "x", "content": "..."}]}
            )
        finally:
            context_mod._read_json = orig
            context_mod._resolve_messages_path = orig_resolve6
        contents = [item["content"] for item in out]
        self.assertIn("q1", contents)
        self.assertIn("q2", contents)
        self.assertIn("active正文", contents)
        self.assertNotIn("A1正文", contents)

        context_mod._read_json = lambda _path, default=None: msgs
        context_mod._resolve_messages_path = lambda sid: "fake"
        try:
            out2 = context_mod._load_session_context_from_path("sess_x", path)
        finally:
            context_mod._read_json = orig
            context_mod._resolve_messages_path = orig_resolve6
        contents2 = [item["content"] for item in out2]
        self.assertTrue(any("A1正文" in c for c in contents2))

    def test_module_system_prompt_has_formula_rules(self):
        from server import prompts as prompts_mod
        self.assertTrue(prompts_mod.MODULE_SYSTEM_PROMPT)
        self.assertIn("<formula>", prompts_mod.MODULE_SYSTEM_PROMPT)
        self.assertIn("不输出完整探索卡片", prompts_mod.MODULE_SYSTEM_PROMPT)
        self.assertLess(len(prompts_mod.MODULE_SYSTEM_PROMPT), 1200)




class WorkflowAnalysisInstructionTest(unittest.TestCase):
    def test_analysis_mode_lists_suggested_modules(self):
        inst = context_mod._workflow_context_instruction({"mode": "analysis", "target": {"kind": "answer", "label": "AI 回答"}, "question": "解释简谐运动"})
        self.assertIn("只输出简洁问题概要", inst)
        self.assertIn("建议模块：", inst)
        self.assertIn("物理视角/数学视角", inst)

    def test_module_mode_keeps_analysis_injection(self):
        inst = context_mod._workflow_context_instruction({"mode": "module", "target": {"kind": "module", "module": "physics", "label": "物理视角"}, "analysis": "核心是回复力与位移成正比", "question": "简谐运动"})
        self.assertIn("隐藏问题分析", inst)
        self.assertIn("核心是回复力与位移成正比", inst)



class Wave2OptimizationTest(unittest.TestCase):
    def test_trim_context_keeps_viz_digest(self):
        big = "<viz>```html\n<div>真实页面</div><script>let a=1; /*逻辑*/</script><p>这张图展示简谐运动</p>```</viz><summary>摘要</summary>" + ("很长" * 4000)
        out = context_mod._trim_context_content(big, keep_viz=True)
        self.assertIn("[交互可视化摘要]", out)
        self.assertIn("页面文字", out)
        self.assertIn("脚本片段", out)
        self.assertNotIn("<div>真实页面", out)
        self.assertLess(len(out), len(big))
        self.assertLess(len(out), 9000)

    def test_viz_digest_no_script(self):
        big = "<viz>```html\n<p>只有文字说明</p>```</viz>"
        out = context_mod._viz_digest(big)
        self.assertIn("页面文字", out)
        self.assertIn("只有文字说明", out)

    def test_read_json_cached_invalidation(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "msg.json"
            storage_mod._write_json(path, {"n": 1})
            first = storage_mod._read_json_cached(path)
            second = storage_mod._read_json_cached(path)
            self.assertIs(first, second)
            storage_mod._write_json(path, {"n": 2})
            third = storage_mod._read_json_cached(path)
            self.assertIsNot(first, third)
            self.assertEqual(third["n"], 2)

    def test_socratic_state_expired(self):
        import time as _time
        now = int(_time.time())
        self.assertFalse(context_mod._socratic_state_expired({"active": True, "updatedAt": now}, now))
        self.assertTrue(context_mod._socratic_state_expired({"active": True, "updatedAt": now - 25 * 3600}, now))
        self.assertFalse(context_mod._socratic_state_expired({"active": True}, now))
        self.assertFalse(context_mod._socratic_state_expired(None, now))

    def test_read_socratic_state_expired_is_read_only(self):
        # 读路径不再有写副作用：过期状态返回 None 但不删除，
        # TTL 清理职责在 _resolve_socratic_branch（见 test_resolve_socratic_branch_skips_expired）
        import time as _time
        orig_read = context_mod._read_json
        orig_delete = context_mod._delete_socratic_state
        deleted = []
        context_mod._read_json = lambda path, default=None: {context_mod._socratic_key("br_x"): {"active": True, "updatedAt": int(_time.time()) - 25 * 3600}}
        context_mod._delete_socratic_state = lambda ref: deleted.append(ref)
        try:
            state = context_mod._read_socratic_state("br_x")
        finally:
            context_mod._read_json = orig_read
            context_mod._delete_socratic_state = orig_delete
        self.assertIsNone(state)
        self.assertEqual(deleted, [])

    def test_resolve_socratic_branch_skips_expired(self):
        import time as _time
        orig_read = context_mod._read_json
        orig_mutate = context_mod._mutate_json
        orig_resolve = context_mod._resolve_messages_path
        kv = {"socratic:br_sess_1234567890abc_1": {"active": True, "updatedAt": int(_time.time()) - 25 * 3600}}
        mutated = []
        context_mod._read_json = lambda path, default=None: kv if str(path) == str(context_mod.KV_PATH) else (default if default is not None else [])
        context_mod._mutate_json = lambda path, updater: mutated.append(updater(dict(kv)))
        context_mod._resolve_messages_path = lambda sid: "fake"
        try:
            ref = context_mod._resolve_socratic_branch("sess_1234567890abcdef123456")
        finally:
            context_mod._read_json = orig_read
            context_mod._mutate_json = orig_mutate
            context_mod._resolve_messages_path = orig_resolve
        self.assertEqual(ref, "")
        self.assertTrue(mutated)
        self.assertNotIn("socratic:br_sess_1234567890abc_1", mutated[0])

    def test_socratic_delete_no_cross_session_prefix_collision(self):
        # 旧版按「会话标识前 18 个安全字符」匹配分支前缀：前缀相同的两个会话
        # 会互相误删状态；现按完整标识精确匹配（18 截断旧格式仍单独兼容）
        orig_mutate = context_mod._mutate_json
        results = []

        def fake_mutate(path, updater):
            data = {
                "socratic:br_sess_1234567890abcdef123456_aa11bb22cc": {"active": True, "updatedAt": 1},
                "socratic:br_sess_1234567890abcdefZZZZZZ_bb22cc33dd": {"active": True, "updatedAt": 1},
            }
            results.append(updater(data))

        context_mod._mutate_json = fake_mutate
        try:
            context_mod._delete_socratic_state("sess_1234567890abcdef123456")
        finally:
            context_mod._mutate_json = orig_mutate
        self.assertNotIn("socratic:br_sess_1234567890abcdef123456_aa11bb22cc", results[0])
        self.assertIn("socratic:br_sess_1234567890abcdefZZZZZZ_bb22cc33dd", results[0])




class RollingMemoryTest(unittest.TestCase):
    def test_write_rolling_memory(self):
        orig_mutate = context_mod._mutate_json
        captured = {}
        context_mod._mutate_json = lambda path, updater: captured.update(updater({}))
        try:
            context_mod._write_rolling_memory("sess_abc", "用户学过简谐运动", 20)
        finally:
            context_mod._mutate_json = orig_mutate
        self.assertIn("mem:sess_abc", captured)
        self.assertEqual(captured["mem:sess_abc"]["summary"], "用户学过简谐运动")
        self.assertEqual(captured["mem:sess_abc"]["messageCount"], 20)

    def test_rolling_summary_due(self):
        orig_load = context_mod._load_messages
        orig_read = context_mod._read_rolling_memory
        context_mod._load_messages = lambda sid: [{"role": "user", "content": "x"}] * 20
        context_mod._read_rolling_memory = lambda sid: None
        try:
            self.assertEqual(context_mod._rolling_summary_due("sess_abc"), 20)
            context_mod._read_rolling_memory = lambda sid: {"summary": "旧", "messageCount": 18}
            self.assertEqual(context_mod._rolling_summary_due("sess_abc"), 0)
            context_mod._read_rolling_memory = lambda sid: {"summary": "旧", "messageCount": 10}
            self.assertEqual(context_mod._rolling_summary_due("sess_abc"), 20)
        finally:
            context_mod._load_messages = orig_load
            context_mod._read_rolling_memory = orig_read

    def test_rolling_memory_input(self):
        orig_load = context_mod._load_messages
        orig_read = context_mod._read_rolling_memory
        context_mod._load_messages = lambda sid: [
            {"role": "user", "content": "问题%d" % i, "timestamp": i}
            for i in range(10)
        ]
        context_mod._read_rolling_memory = lambda sid: {"summary": "旧记忆内容", "messageCount": 10}
        try:
            text = context_mod._rolling_memory_input("sess_abc", max_old_pairs=3)
        finally:
            context_mod._load_messages = orig_load
            context_mod._read_rolling_memory = orig_read
        self.assertIn("旧记忆内容", text)
        self.assertIn("问题0", text)

    def test_load_session_context_keeps_memory_out_of_history(self):
        """前缀缓存拍板（2026-09-21）：记忆不再插进历史，改由 rolling_memory_block
        交给 main.py 并入历史后的上下文块——记忆每 8 条消息刷新一次，插在历史
        第 0 位会把整个历史区的前缀缓存打灭。"""
        msgs = [
            {"role": "user", "content": "问题1", "timestamp": 1},
            {"role": "assistant", "content": "回答1", "timestamp": 2},
        ]
        orig_read = context_mod._read_json
        orig_resolve = context_mod._resolve_messages_path
        orig_rm = context_mod._read_rolling_memory
        context_mod._read_json = lambda path, default=None: msgs
        context_mod._resolve_messages_path = lambda sid: "fake"
        context_mod._read_rolling_memory = lambda sid: {"summary": "之前聊过简谐运动", "messageCount": 2}
        try:
            result = context_mod._load_session_context("sess_abc", max_rounds=2)
            block = context_mod.rolling_memory_block("sess_abc")
        finally:
            context_mod._read_json = orig_read
            context_mod._resolve_messages_path = orig_resolve
            context_mod._read_rolling_memory = orig_rm
        contents = [str(m.get("content") or "") for m in result]
        self.assertNotIn("（会话记忆）之前聊过简谐运动", contents)
        self.assertEqual(block, "（会话记忆）之前聊过简谐运动")


class ConceptGroundingTest(unittest.TestCase):
    """M4 概念先导链上下文：匹配闸门、三级推导、预算与零回归。"""

    def _fixture(self):
        return {
            "shm": {
                "id": "shm", "title": "简谐运动", "sessionId": "sess_old",
                "summary": "回复力与位移成正比且反向，运动方程的解是正弦函数，周期由系统参数决定。",
                "summarySource": "model",
                "formulas": ["$F=-kx$", r"$\omega=\sqrt{k/m}$", r"$T=2\pi\sqrt{m/k}$"],
            },
            "hooke": {
                "id": "hooke", "title": "胡克定律", "sessionId": "sess_old",
                "summary": "弹性限度内弹力与形变量成正比，是线性回复力的来源。",
                "summarySource": "model", "formulas": ["$F=-kx$"],
            },
            "damped": {
                "id": "damped", "title": "阻尼振动", "sessionId": "sess_old",
                "summary": "存在阻尼时振幅随时间指数衰减，能量被耗散。",
                "summarySource": "model", "formulas": [r"$m\ddot{x}+c\dot{x}+kx=0$"],
            },
            "template": {
                "id": "template", "title": "梯度的定义与坐标表达", "sessionId": "sess_old",
                "summary": "### 数学视角 梯度是向量分析中的核心算子……", "summarySource": "local",
                "formulas": [r"$\nabla f$"],
            },
        }

    # ====== 匹配闸门 ======

    def test_formula_symbol_in_prompt_matches(self):
        """问题里出现条目公式符号（`F=-kx`）→ 命中。"""
        refs = concept_mod.match_concept_details("F=-kx 里的 k 代表什么？", self._fixture())
        self.assertIn("hooke", [r["id"] for r in refs])
        self.assertTrue(any("kx" in r["hits"] for r in refs))

    def test_single_letter_symbol_does_not_match(self):
        """单字母公式符号（x/t）不参与检索——否则「解释梯度」会连到「简谐运动」。"""
        item = {"only": {"id": "only", "title": "无关条目", "formulas": ["$x = t$"]}}
        self.assertEqual(concept_mod.match_concepts("请解释 x 与 t 的关系", item), [])

    def test_alias_variant_matches_same_concept(self):
        """v6 译名归一：问「傅立叶变换」也能命中库里那条「傅里叶变换」。

        之前这是概念地基的一个静默查空点——没有词面或公式桥梁就不触发（用户换个
        写法问，就等于没学过）。v6 起 `_normalize_title` 收口了译名归一，检索、
        大陆子串切分、概念族匹配三处共用同一把尺子。
        """
        items = {"sch": {"id": "sch", "title": "薛定谔方程", "formulas": []}}
        # 归一本身：两种写法收敛到同一个键
        self.assertEqual(concept_mod._normalize_title("薛丁格方程"), "薛定谔方程")
        self.assertEqual(concept_mod.match_concepts("薛丁格方程怎么解？", items), ["sch"])
        # 区分度证明：表**外**的变体（薛定锷）照旧查空——命中确实来自归一，
        # 而不是 2 字弱证据被放水（「方程」这种弱串没有旁证不放行）
        self.assertEqual(concept_mod.match_concepts("薛定锷方程怎么解？", items), [])

    def test_title_run_matches_concept_name(self):
        refs = concept_mod.match_concepts("简谐运动的周期由什么决定？", self._fixture())
        self.assertEqual(refs[:1], ["shm"])

    def test_weak_run_needs_domain_term_support(self):
        """2 字串只在「跨条目领域词」或公式符号支撑时放行（宁可漏报不可误报）。

        注：「阻尼振动」这类 4 字整名重叠属实质证据（强串），不受此闸门限制；
        这里用只有 2 字重叠的「振动分析」验证闸门本身。
        """
        lone = {"damped": {"id": "damped", "title": "阻尼振动", "formulas": []}}
        self.assertEqual(concept_mod.match_concepts("振动分析怎么做", lone), [])
        with_sibling = dict(lone, forced={"id": "forced", "title": "受迫振动", "formulas": []})
        self.assertIn("damped", concept_mod.match_concepts("振动分析怎么做", with_sibling))

    def test_exact_concept_name_always_admitted(self):
        """问题里写出的完整概念名是强证据，不需要额外支撑。"""
        lone = {"damped": {"id": "damped", "title": "阻尼振动", "formulas": []}}
        self.assertEqual(concept_mod.match_concepts("阻尼振动为什么振幅会衰减", lone), ["damped"])

    def test_generic_term_does_not_trigger_alone(self):
        """「运动」这类泛后缀词不单独触发（无实质重叠 + 无公式支撑时查空）。"""
        item = {"x": {"id": "x", "title": "运动", "formulas": []}}
        self.assertEqual(concept_mod.match_concepts("请描述运动的相对性", item), [])

    def test_shared_runs_takes_maximal_common_substring(self):
        """共享串是「极大公共子串」，不是整串包含：整名重叠与 2 字领域词都要能拿到。"""
        self.assertIn("简谐运动", concept_mod._shared_runs("简谐运动的周期", "简谐运动", 2, 4))
        self.assertIn("阻尼振动", concept_mod._shared_runs("阻尼振动为什么衰减", "阻尼振动", 2, 4))
        # 单字命中（「动」在「运动」里）不足阈值，不算证据
        self.assertEqual(concept_mod._shared_runs("非线性振动的特点", "简谐运动", 2, 4), [])

    def test_stop_char_fragments_rejected(self):
        """达长度的共享串含功能字时仍要丢弃——判定看串里有没有功能字，不看整串相等。

        「和线」长度 2、满足长度阈值，但含「和」，是碎片不是术语；这条闸门在匹配层
        （而不是 _shared_runs 里）执行，因为它要区分「振动」（真术语）与「和线」。
        """
        self.assertEqual(concept_mod._shared_runs("它和线性情况", "运动", 2, 4), [])
        self.assertTrue(concept_mod._STOP_CHARS & set("和线"))
        self.assertFalse(concept_mod._STOP_CHARS & set("振动"))
        self.assertEqual(
            concept_mod.match_concepts("它和线性情况有什么本质区别",
                                       {"x": {"id": "x", "title": "运动", "formulas": []}}), [])

    def test_unrelated_question_matches_nothing(self):
        for q in ("今天午饭吃什么", "帮我写一首诗"):
            self.assertEqual(concept_mod.match_concepts(q, self._fixture()), [])

    def test_same_session_scope_option(self):
        items = self._fixture()
        self.assertEqual(
            concept_mod.match_concepts("简谐运动的周期", items, session_id="sess_new",
                                       allow_cross_session=False), [])
        self.assertEqual(
            concept_mod.match_concepts("简谐运动的周期", items, session_id="sess_old",
                                       allow_cross_session=False)[:1], ["shm"])

    # ====== 三级推导 ======

    def test_shared_formula_gives_prerequisites(self):
        """结构边：与命中概念共享公式的条目成为先导（简谐运动 → 胡克定律）。

        注：夹具里「阻尼振动」也含 kx，共享公式的邻居不止一个；这里断言胡克定律在列，
        且 via 标成结构边（顺序由共享 token 数决定，不在测试里锁死）。
        """
        data = concept_mod.build_grounding(self._fixture(), ["shm"], session_id="sess_new")
        by_title = {row["title"]: row for row in data["one"]}
        self.assertIn("胡克定律", by_title)
        self.assertEqual(by_title["胡克定律"]["via"], "formula")

    def test_explicit_canvas_edge_wins(self):
        """显式边（画布联系线）优先于结构边，并带上用户写的关系说明。"""
        data = concept_mod.build_grounding(
            self._fixture(), ["damped"],
            pairs=[("damped", "shm", "小阻尼近似"), ("damped", "hooke", "")])
        first = data["one"][0]
        self.assertEqual(first["via"], "explicit")
        self.assertEqual(first["relation"], "小阻尼近似")

    def test_self_fallback_when_no_prerequisite(self):
        """第 3 级：没有先导可推时只带概念自身（净增益，不硬凑）。"""
        items = {"solo": {"id": "solo", "title": "熵", "formulas": [],
                          "summary": "无序度的度量。", "summarySource": "model"}}
        data = concept_mod.build_grounding(items, ["solo"], session_id="s")
        self.assertEqual([row["via"] for row in data["one"]], ["self"])

    def test_local_template_summary_not_used(self):
        """local 兜底摘要（模板文案）不当「地基」用——只认 model/manual 摘要。"""
        items = {"t": {"id": "t", "title": "熵", "formulas": [],
                       "summary": "这是模板文案", "summarySource": "local"}}
        data = concept_mod.build_grounding(items, ["t"], session_id="s")
        self.assertEqual(data["one"][0]["summary"], "")

    def test_cross_session_label(self):
        data = concept_mod.build_grounding(self._fixture(), ["shm"], session_id="sess_new")
        self.assertTrue(data["one"][0]["cross_session"])

    def test_missing_refs_returns_empty(self):
        self.assertEqual(concept_mod.build_grounding(self._fixture(), ["nope"], session_id="s"), {})
        self.assertEqual(concept_mod.build_grounding(self._fixture(), [], session_id="s"), {})

    # ====== 渲染、预算与零回归 ======

    def test_render_contains_rules_and_concepts(self):
        text = concept_mod.render_concept_grounding(
            concept_mod.build_grounding(["shm"], session_id="sess_new") if False
            else concept_mod.build_grounding(self._fixture(), ["shm"], session_id="sess_new"))
        self.assertIn("【概念地基】", text)
        self.assertIn("先导概念", text)
        self.assertIn("胡克定律", text)
        self.assertIn("规则：1.", text)

    def test_no_match_returns_empty_string(self):
        """查空是正常路径：返回空串 → 调用方追加空串即零回归。"""
        items = self._fixture()
        self.assertEqual(concept_mod.concept_context_text("今天午饭吃什么", items=items), "")
        self.assertEqual(concept_mod.concept_context_text("", items=items), "")
        self.assertEqual(concept_mod.concept_context_text("简谐运动", items={}), "")

    def test_prompt_block_byte_identical_without_match(self):
        base = "基础提示词"
        text = concept_mod.concept_context_text("今天午饭吃什么", items=self._fixture())
        self.assertEqual(base + text, base)

    def test_context_text_deterministic_and_budgeted(self):
        items = self._fixture()
        text = concept_mod.concept_context_text("简谐运动的周期由什么决定", items=items)
        self.assertTrue(text.startswith("【概念地基】"))
        self.assertEqual(text, concept_mod.concept_context_text("简谐运动的周期由什么决定", items=items))
        self.assertLessEqual(context_mod.estimate_tokens(text),
                             concept_mod.CONCEPT_BLOCK_MAX_TOKENS)
        self.assertLessEqual(len(text.split("\n")),
                             3 + concept_mod.ONESHOT_LIMIT + 1 + concept_mod.TWOSHOT_LIMIT)

    def test_explicit_pairs_reads_graph_state(self):
        """显式边从 KV 的 graph:{session} 读；模块气泡 nodeId 不算知识点节点。"""
        with tempfile.TemporaryDirectory() as td:
            kv_path = Path(td) / "kv_store.json"
            storage_mod._write_json(kv_path, {
                "graph:sess_cur": {
                    "customNodes": [
                        {"id": "knowledge-custom-1", "kind": "knowledge", "knowledgeKey": "shm"},
                        {"id": "knowledge-custom-2", "kind": "knowledge", "knowledgeKey": "hooke"},
                        {"id": "math-custom-9", "kind": "module"},
                    ],
                    "connections": [
                        {"from": "knowledge-custom-1", "to": "knowledge-custom-2",
                         "relation": "线性回复力"},
                        {"from": "math-custom-9", "to": "knowledge-custom-1"},
                    ],
                },
            })
            self.assertEqual(concept_mod.explicit_pairs("sess_cur", kv_path=kv_path),
                             [("shm", "hooke", "线性回复力")])
            self.assertEqual(concept_mod.explicit_pairs("sess_other", kv_path=kv_path), [])


if __name__ == "__main__":
    unittest.main()
