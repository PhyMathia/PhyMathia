"""文档解析（server/documents.py）的单元回归。

这个模块此前只有路由层零星触及，核心的解析与清洗函数一个测试都没有
（backlog D4 登记于 2026-09-27）。它是「把一份 PDF/图片丢进来，自动长出知识点」
这条链路的解析端，脏数据全靠这里的正则和守卫挡——挡错了就是脏条目进库。

覆盖三块：
- **纯函数**：模型返回的 JSON 解析、分数钳位、公式抽取、文件名清洗；
- **文本提取的编码兜底**：utf-8 / utf-8-sig / gbk 依次尝试；
- **OCR 临时文件**：用完即删不留残留（`_extract_image_text` 的 finally）。

**不加载 OCR 引擎**（rapidocr_onnxruntime 几百 MB，且多数机器没装）：引擎用桩
替掉，测的是我们自己的临时文件生命周期与异常兜底，不是引擎质量。
"""

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

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from server import documents as docs  # noqa: E402


class ParseExtractJsonTest(unittest.TestCase):
    """模型返回的知识点 JSON —— 脏数据都该在这里被挡掉。"""

    def test_plain_json_object(self):
        nodes, edges, relations = docs._parse_document_extract_json(
            json.dumps({"nodes": [{"title": "简谐运动", "category": "physics"}]}), 20)
        self.assertEqual(len(nodes), 1)
        self.assertEqual(nodes[0]["title"], "简谐运动")
        self.assertEqual(nodes[0]["category"], "physics")

    def test_fenced_json_block(self):
        text = '这是模型的回答：\n```json\n{"nodes":[{"title":"梯度","category":"math"}]}\n```\n以上。'
        nodes, _, _ = docs._parse_document_extract_json(text, 20)
        self.assertEqual([n["title"] for n in nodes], ["梯度"])

    def test_json_embedded_in_prose_without_fence(self):
        """模型爱在正文里裸吐 JSON——从第一个 { 到最后一个 } 抠出来。"""
        text = '好的，结果如下：{"nodes":[{"title":"能量守恒"}]} 希望有用。'
        nodes, _, _ = docs._parse_document_extract_json(text, 20)
        self.assertEqual([n["title"] for n in nodes], ["能量守恒"])

    def test_garbage_returns_empty_not_raise(self):
        """解析失败必须返回空三元组，不能把异常抛给上传接口。"""
        for bad in ["", "完全不是 JSON", "{断掉的", None, "[]", '"一个字符串"', "123"]:
            with self.subTest(bad=bad):
                self.assertEqual(docs._parse_document_extract_json(bad, 20), ([], [], []))

    def test_items_alias_accepted(self):
        """nodes 与 items 两个键都收——模型两代输出格式。"""
        nodes, _, _ = docs._parse_document_extract_json(
            json.dumps({"items": [{"title": "泊松分布"}]}), 20)
        self.assertEqual(len(nodes), 1)

    def test_unknown_category_falls_back_to_other(self):
        nodes, _, _ = docs._parse_document_extract_json(
            json.dumps({"nodes": [{"title": "某概念", "category": "量子力学"}]}), 20)
        self.assertEqual(nodes[0]["category"], "other")

    def test_entries_without_title_dropped(self):
        nodes, _, _ = docs._parse_document_extract_json(
            json.dumps({"nodes": [{"category": "math"}, {"title": "  "}, {"title": "散度"}]}), 20)
        self.assertEqual([n["title"] for n in nodes], ["散度"])

    def test_non_dict_nodes_ignored(self):
        """nodes 是个 list 但里面混了非 dict——不能整个炸掉，跳过即可。"""
        nodes, _, _ = docs._parse_document_extract_json(
            json.dumps({"nodes": ["字符串", 42, {"title": "旋度"}]}), 20)
        self.assertEqual([n["title"] for n in nodes], ["旋度"])

    def test_max_items_caps(self):
        payload = {"nodes": [{"title": "概念%d" % i} for i in range(10)]}
        nodes, _, _ = docs._parse_document_extract_json(json.dumps(payload), 3)
        self.assertLessEqual(len(nodes), 3)


class SafeScoreTest(unittest.TestCase):
    """分数钳位：脏值一律回落到默认值，绝不放行 0<=x<=1 之外的东西。"""

    def test_in_range_passthrough(self):
        self.assertAlmostEqual(docs._safe_score(0.42), 0.42)
        self.assertAlmostEqual(docs._safe_score(0), 0.0)
        self.assertAlmostEqual(docs._safe_score(1), 1.0)
        self.assertAlmostEqual(docs._safe_score("0.8"), 0.8)

    def test_out_of_range_falls_back(self):
        for bad in [-0.1, 1.1, 5, -3, 999]:
            with self.subTest(bad=bad):
                self.assertAlmostEqual(docs._safe_score(bad), 0.7)

    def test_non_numeric_falls_back(self):
        for bad in ["高", None, "", [], {}, float("nan"), float("inf")]:
            with self.subTest(bad=bad):
                got = docs._safe_score(bad)
                self.assertTrue(0.0 <= got <= 1.0, "回退值也必须落在 [0,1]，实得 %r" % got)


class ExtractTextFormulasTest(unittest.TestCase):
    def test_all_four_delimiters(self):
        text = r"行内 $a^2+b^2$、\(x+y\)、块 $$E=mc^2$$、方块 \[F=ma\]"
        got = docs._extract_text_formulas(text)
        self.assertTrue(got, "四种定界符都该被认出来")
        for want in ("a^2+b^2", "x+y", "E=mc^2", "F=ma"):
            self.assertTrue(any(want in g for g in got), "漏了 %s，实得 %r" % (want, got))

    def test_deduplicated(self):
        text = "$E=mc^2$ 和 $E=mc^2$ 是同一个"
        got = docs._extract_text_formulas(text)
        self.assertEqual(len(got), 1, "同一条公式出现两次只收一次")

    def test_capped_at_eight(self):
        text = " ".join("$f%d(x)$" % i for i in range(20))
        self.assertLessEqual(len(docs._extract_text_formulas(text)), 8)

    def test_prose_without_math_returns_empty(self):
        self.assertEqual(docs._extract_text_formulas("这是一段普通中文，没有公式。"), [])
        self.assertEqual(docs._extract_text_formulas(""), [])


class ExtractDocumentTextTest(unittest.TestCase):
    """文本类文件的编码兜底：utf-8 → utf-8-sig → gbk。"""

    def test_utf8(self):
        got = docs._extract_document_text("a.txt", "简谐运动".encode("utf-8"))
        self.assertEqual(got, "简谐运动")

    def test_utf8_bom_behaviour_pinned(self):
        """**当前行为**：BOM 留在正文里（documents.py 的编码顺序是 utf-8 在前，
        utf-8-sig 永远轮不到，所以 BOM 不会被剥掉）。

        这里按实际行为钉住，不擅自改断言说"应该剥掉"——改编码顺序会动到所有文本
        提取路径，是独立一轮。潜在影响：走本地抽取（不经模型）时，正文开头的
        U+FEFF 会进第一个知识点的标题。已登记 docs/backlog.md。
        """
        got = docs._extract_document_text("a.txt", "﻿简谐运动".encode("utf-8-sig"))
        self.assertTrue(got.endswith("简谐运动"), "正文主体必须完好")
        self.assertTrue(got.startswith("\ufeff"), "记录当前行为：BOM 未被剥掉")

    def test_gbk_fallback(self):
        raw = "梯度与散度".encode("gbk")
        got = docs._extract_document_text("a.txt", raw)
        self.assertEqual(got, "梯度与散度")

    def test_undecodable_does_not_raise(self):
        """三种编码都解不开时走 utf-8 + errors="ignore" 的有损解码。

        不是返回空串——是真解不出来的字节被丢掉、其余保留。记的是「不抛异常」
        这条契约：UnicodeDecodeError 一路上去就是上传接口 500。
        """
        got = docs._extract_document_text("a.txt", b"\xff\xfe\x00\x81\x8d\xff")
        self.assertIsInstance(got, str)


class OcrTempFileTest(unittest.TestCase):
    """OCR 临时文件：用完即删不留残留。

    注：`documents.py:71` 那句「并发图片解析共用固定名会互相覆盖」是**已修**的
    说明（所以那里用 uuid4），不是现存 bug。这里守的是「用完即删」这条尾巴——
    OCR 失败时最容易漏，临时图会一直堆在上传目录里。
    """

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self._orig_dir = docs.UPLOAD_DIR
        docs.UPLOAD_DIR = Path(self._td.name)

    def tearDown(self):
        docs.UPLOAD_DIR = self._orig_dir
        self._td.cleanup()

    @staticmethod
    def _engine(result):
        """替掉 _get_ocr_engine。

        它在 documents.py 里是两段式：先 `_get_ocr_engine()` 热身（无参），再
        `_get_ocr_engine()(str(tmp_path))` 调返回的那个。第一版把桩写成单段，
        直接 TypeError——记一笔：桩的形状要照真实的调用形状写。
        """
        calls = []

        def runner(path):
            calls.append(path)
            return (result, None)

        return lambda: runner, calls

    def test_temp_file_removed_on_success(self):
        engine, calls = self._engine([[[0, 0, 1, 1], "简谐运动"]])
        with mock.patch.object(docs, "_get_ocr_engine", engine):
            got = docs._extract_image_text(b"fake-png-bytes")
        self.assertEqual(got, "简谐运动")
        self.assertEqual(len(calls), 1)
        self.assertFalse(os.path.exists(calls[0]), "OCR 成功后临时文件必须删掉")
        self.assertEqual(os.listdir(self._td.name), [], "上传目录不该留下残留")

    def test_temp_file_removed_on_failure(self):
        """引擎抛异常时也必须删——这是最容易漏的一条尾巴。"""
        def runner(path):
            raise RuntimeError("引擎炸了")

        with mock.patch.object(docs, "_get_ocr_engine", lambda: runner):
            self.assertEqual(docs._extract_image_text(b"fake"), "")
        self.assertEqual(os.listdir(self._td.name), [], "失败路径也必须清理干净")

    def test_each_call_gets_a_unique_name(self):
        """两次调用不得共用同一个临时文件名（那正是当初改成 uuid4 的原因）。"""
        seen = []

        def runner(path):
            seen.append(path)
            return ([], None)

        with mock.patch.object(docs, "_get_ocr_engine", lambda: runner):
            docs._extract_image_text(b"a")
            docs._extract_image_text(b"b")
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0], seen[1], "临时文件名撞车 = 并发时互相覆盖")

    def test_import_error_returns_empty(self):
        """rapidocr 没装时安静返回空串，不该让上传接口炸掉。"""
        def runner(path):
            raise ImportError("没装 rapidocr")

        # 热身那一次就该抛 ImportError（documents.py:68 的 except ImportError 管的就是它）
        with mock.patch.object(docs, "_get_ocr_engine", lambda: runner):
            self.assertEqual(docs._extract_image_text(b"fake"), "")


class SanitizeFilenameTest(unittest.TestCase):
    def test_strips_directory_components(self):
        """目录穿越必须在读盘前就掐掉。

        真实实现（documents.py:23）是 `Path(name).name` 再把残留的
        `[\\/:*?"<>|]` 换成 `_`。所以不变式是**路径分隔符与盘符一个不剩**
        （`..` 作为普通字符留着无害——没有分隔符它就构不成路径），不是「.. 也没了」。
        """
        for bad in ["../../etc/passwd", "..\\..\\windows\\system32",
                    "/abs/path.txt", "C:\\Users\\x\\a.txt"]:
            with self.subTest(bad=bad):
                got = docs._sanitize_filename(bad)
                for ch in "/\\:*?\"<>|":
                    self.assertNotIn(ch, got, "残留了路径/盘符字符 %r：%r" % (ch, got))
                self.assertEqual(Path(got).name, got, "清洗后仍是个可被当路径解释的名字")


if __name__ == "__main__":
    unittest.main()
