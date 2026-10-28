"""documents.py（文件上传存取与文本/图片抽取）的单元回归。

覆盖三块：
- **文件名清洗**：目录穿越必须在读盘前掐掉；
- **文本提取的编码兜底**：utf-8 / utf-8-sig / gbk 依次尝试；
- **OCR 临时文件**：用完即删不留残留（`_extract_image_text` 的 finally）。

（2026-10-28 T383：/api/documents/parse 知识点提取链退役，模型 JSON 解析/
分数钳位/公式抽取三组纯函数测试随链路一并删除，git 历史可查。原先本文件
就是为补那条链路的测试空白而建——backlog D4，2026-09-27。）

**不加载 OCR 引擎**（rapidocr_onnxruntime 几百 MB，且多数机器没装）：引擎用桩
替掉，测的是我们自己的临时文件生命周期与异常兜底，不是引擎质量。
"""

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
