"""输入节点素材摄取（server/input_routes.py + server/ocr.py）的单元回归。

2026-10-22 输入节点重做 P0 的验收件：ingest 只做机械转写（文本抽取/图片 OCR），
绝不调 AI。覆盖：文件类型路由、8000 字截断与全文落盘、404/413、OCR 开关、
OCR 结果合并回传；OCR 引擎选路（auto 探测/GLM 失败回落/点名不回落）与 sha1
缓存（done 缓存命中、失败不缓存）。**全程不联网**：OCR 引擎与 Ollama 探测
一律 monkeypatch 桩替。
"""

import base64
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
from server import input_routes, ocr  # noqa: E402


def _b64(text: str) -> str:
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def _make_pdf(text=None, pages=1) -> bytes:
    """造一份最小 PDF：无 text 时页面无文字层（＝扫描版的形状），有 text 时带
    真实文本流（pypdf 能抽出字）。页数由 pages 控制。"""
    import io as _io

    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=400)
    if text:
        stream = DecodedStreamObject()
        stream.set_data(("BT /F1 12 Tf 20 300 Td (" + text + ") Tj ET").encode("ascii"))
        page[NameObject("/Contents")] = writer._add_object(stream)  # noqa: SLF001
        font = DictionaryObject({
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/Helvetica"),
        })
        page[NameObject("/Resources")] = DictionaryObject({
            NameObject("/Font"): DictionaryObject({NameObject("/F1"): writer._add_object(font)})  # noqa: SLF001
        })
    for _ in range(pages - 1):
        writer.add_blank_page(width=300, height=400)
    buf = _io.BytesIO()
    writer.write(buf)
    return buf.getvalue()


class IngestRouteTest(unittest.TestCase):
    """POST /api/input/ingest 的路由契约（TestClient 端到端，数据目录隔离）。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        tmp = Path(self._td.name)
        # UPLOAD_DIR 在 documents/input_routes 两处各有一份模块级引用；
        # OCR_DIR 同理（ocr.py import 时从 DATA_DIR 派生）——只 patch config 不够
        self._patches = [
            mock.patch.object(docs, "UPLOAD_DIR", tmp),
            mock.patch.object(input_routes, "UPLOAD_DIR", tmp),
            mock.patch.object(ocr, "OCR_DIR", tmp),
            # meta 路径也隔离（2026-10-23 补）：此前只隔了目录，meta 一直写真实的
            # data/uploads.json，每跑一轮测试就多几条测试条目
            mock.patch.object(docs, "UPLOADS_META_PATH", tmp / "uploads.json"),
        ]
        for p in self._patches:
            p.start()
        from fastapi.testclient import TestClient
        import main as main_mod
        # base_url 必须是 127.0.0.1：host allowlist 对 testserver 拒 403
        self.client = TestClient(main_mod.app, base_url="http://127.0.0.1")

    def tearDown(self):
        for p in self._patches:
            p.stop()
        self._td.cleanup()

    def _post(self, payload):
        return self.client.post("/api/input/ingest", json=payload)

    def test_txt_roundtrip(self):
        resp = self._post({"fileName": "笔记.txt", "contentBase64": _b64("简谐运动：F=-kx")})
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["kind"], "text")
        self.assertEqual(data["text"], "简谐运动：F=-kx")
        self.assertEqual(data["chars"], len("简谐运动：F=-kx"))
        self.assertFalse(data["truncated"])
        self.assertTrue((Path(docs.UPLOAD_DIR) / f"{data['fileId']}.bin").exists(),
                        "上传原件必须落盘，供按 fileId 重识别取回")

    def test_kind_routing_by_extension(self):
        cases = {"受力图.png": "image", "讲义.pdf": "file", "笔记.md": "text",
                 "图.JPG": "image", "数据.csv": "text", "幻灯.pptx": "file"}
        for name, want in cases.items():
            with self.subTest(name=name):
                data = self._post({"fileName": name, "contentBase64": _b64("x"), "ocr": False}).json()
                self.assertEqual(data["kind"], want)

    def test_truncation_and_fulltext_file(self):
        text = "物理直觉很重要。" * 1200  # 9600 字 > 8000
        data = self._post({"fileName": "长文.txt", "contentBase64": _b64(text)}).json()
        self.assertTrue(data["truncated"])
        self.assertEqual(data["chars"], len(text))
        self.assertEqual(len(data["text"]), 8000)
        full = (Path(docs.UPLOAD_DIR) / f"{data['fileId']}.txt").read_text("utf-8")
        self.assertEqual(full, text, "截断时全文必须落在 <fileId>.txt")

    def test_no_fulltext_when_not_truncated(self):
        data = self._post({"fileName": "短.txt", "contentBase64": _b64("短")}).json()
        self.assertFalse((Path(docs.UPLOAD_DIR) / f"{data['fileId']}.txt").exists(),
                         "未截断时 resp.text 即全文，不另落全文文件")

    def test_unknown_fileid_404(self):
        self.assertEqual(self._post({"fileId": "doc_nope"}).status_code, 404)

    def test_oversize_413(self):
        payload = {"fileName": "big.bin",
                   "contentBase64": base64.b64encode(b"x" * (21 * 1024 * 1024)).decode("ascii")}
        self.assertEqual(self._post(payload).status_code, 413)

    def test_image_ocr_off_marks_skipped(self):
        data = self._post({"fileName": "a.png", "contentBase64": _b64("x"), "ocr": False}).json()
        self.assertEqual(data["kind"], "image")
        self.assertEqual(data["ocr"]["status"], "skipped")
        self.assertEqual(data["text"], "", "OCR 关=只存文件，文本留给前端占位")

    def test_image_ocr_result_merged(self):
        fake = {"text": "F = ma", "engine": "rapidocr", "ms": 12, "status": "done", "error": ""}
        with mock.patch.object(input_routes, "ocr_image", return_value=fake) as run:
            data = self._post({"fileName": "a.png", "contentBase64": _b64("x"),
                               "ocr": True}).json()
        run.assert_called_once()
        self.assertEqual(data["text"], "F = ma")
        self.assertEqual(data["ocr"]["engine"], "rapidocr")
        self.assertEqual(data["ocr"]["ms"], 12)

    def test_reingest_by_fileid(self):
        first = self._post({"fileName": "b.png", "contentBase64": _b64("x"), "ocr": False}).json()
        fake = {"text": "识别出的字", "engine": "rapidocr", "ms": 3, "status": "done", "error": ""}
        with mock.patch.object(input_routes, "ocr_image", return_value=fake):
            second = self._post({"fileId": first["fileId"]}).json()
        self.assertTrue(second["ok"])
        self.assertEqual(second["text"], "识别出的字", "按 fileId 重调缺省开 OCR")
        self.assertEqual(second["fileName"], "b.png", "fileName 从上传 meta 取回")

    def test_file_route_serves_bytes_and_mime(self):
        first = self._post({"fileName": "note.txt", "contentBase64": _b64("素材正文")}).json()
        resp = self.client.get("/api/input/files/" + first["fileId"])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content, "素材正文".encode("utf-8"), "按 fileId 取回源字节")
        self.assertIn("text/plain", resp.headers.get("content-type", ""))

    def test_file_route_unknown_id_404(self):
        self.assertEqual(self.client.get("/api/input/files/doc_000000000000").status_code, 404)

    def test_file_route_bad_id_shape_404(self):
        # id 形状不合一律 404：id 只当 meta 键用，永不携带路径语义
        for bad in ("abc", "doc_xyz", "doc_12345", "DOC_0123456789ab"):
            self.assertEqual(self.client.get("/api/input/files/" + bad).status_code, 404, bad)

    # ===== T382（2026-10-23）：扫描版 PDF 打标与页转图路由 =====

    def test_scanned_pdf_marked_on_ingest(self):
        data = self._post({"fileName": "扫描讲义.pdf",
                           "contentBase64": base64.b64encode(_make_pdf(None, pages=2)).decode("ascii")}).json()
        self.assertEqual(data["kind"], "file")
        self.assertTrue(data["pdf"]["scanned"], "无文字层 PDF 应判为扫描版")
        self.assertEqual(data["pdf"]["pages"], 2)
        self.assertEqual(data["text"].strip(), "", "扫描版抽不出字：text 留空（前端按占位/转图处理）")

    def test_text_pdf_not_marked_scanned(self):
        data = self._post({"fileName": "文字版.pdf",
                           "contentBase64": base64.b64encode(_make_pdf("Newton F equals ma", 1)).decode("ascii")}).json()
        self.assertFalse(data["pdf"]["scanned"], "有文字层照旧只走抽文字，不页转图")
        self.assertEqual(data["pdf"]["pages"], 1)
        self.assertIn("Newton", data["text"])

    def test_non_pdf_has_null_pdf_info(self):
        data = self._post({"fileName": "笔记.txt", "contentBase64": _b64("正文")}).json()
        self.assertIsNone(data["pdf"], "非 PDF 不带 pdf 键信息（旧客户端也不受影响）")

    def test_pdf_page_route_contract(self):
        # 路由契约（渲染器桩替）：200 + image/jpeg + 允许浏览器短缓存；渲染不可用时 422
        first = self._post({"fileName": "扫描件.pdf",
                            "contentBase64": base64.b64encode(_make_pdf(None, pages=2)).decode("ascii")}).json()
        fake_jpeg = b"\xff\xd8\xff" + b"0" * 600
        with mock.patch.object(input_routes, "render_pdf_page", return_value=fake_jpeg) as render:
            resp = self.client.get("/api/input/pdf_pages",
                                   params={"fileId": first["fileId"], "page": 2})
        self.assertEqual(resp.status_code, 200)
        self.assertIn("image/jpeg", resp.headers.get("content-type", ""))
        self.assertIn("max-age", resp.headers.get("cache-control", ""),
                      "同一 fileId+page 字节确定：允许短缓存，别每轮重渲染")
        self.assertEqual(resp.content, fake_jpeg)
        self.assertEqual(render.call_args[0][1], 2, "页号原样交给渲染器（1-based）")
        with mock.patch.object(input_routes, "render_pdf_page", return_value=b""):
            resp = self.client.get("/api/input/pdf_pages",
                                   params={"fileId": first["fileId"], "page": 1})
        self.assertEqual(resp.status_code, 422, "渲染不出来＝这一页取不到（前端静默跳过）")

    def test_pdf_page_route_renders_real_jpeg(self):
        try:
            import pypdfium2  # noqa: F401
        except ImportError:
            self.skipTest("pypdfium2 未安装：真实页渲染不可用（契约由 stub 用例盖着）")
        first = self._post({"fileName": "扫描件.pdf",
                            "contentBase64": base64.b64encode(_make_pdf(None, pages=2)).decode("ascii")}).json()
        resp = self.client.get("/api/input/pdf_pages",
                               params={"fileId": first["fileId"], "page": 1})
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.content.startswith(b"\xff\xd8\xff"), "返回的必须是 JPEG 字节")
        self.assertGreater(len(resp.content), 500, "渲染出来的页图不该是空壳")

    def test_pdf_page_route_page_bounds(self):
        first = self._post({"fileName": "扫描件.pdf",
                            "contentBase64": base64.b64encode(_make_pdf(None, pages=2)).decode("ascii")}).json()
        # 页号 1-based 且只放行前 PDF_PAGE_MAX 页：0 / 超上限一律 400（前端据此静默跳过）
        for page in (0, docs.PDF_PAGE_MAX + 1):
            resp = self.client.get("/api/input/pdf_pages",
                                   params={"fileId": first["fileId"], "page": page})
            self.assertEqual(resp.status_code, 400, page)

    def test_pdf_page_route_rejects_non_pdf(self):
        first = self._post({"fileName": "笔记.txt", "contentBase64": _b64("正文")}).json()
        resp = self.client.get("/api/input/pdf_pages", params={"fileId": first["fileId"], "page": 1})
        self.assertEqual(resp.status_code, 400, "非 PDF 不渲染（不拿别的文件当 PDF 喂 pdfium）")

    def test_pdf_page_route_bad_or_unknown_id_404(self):
        self.assertEqual(self.client.get("/api/input/pdf_pages",
                                         params={"fileId": "abc", "page": 1}).status_code, 404)
        self.assertEqual(self.client.get("/api/input/pdf_pages",
                                         params={"fileId": "doc_000000000000", "page": 1}).status_code, 404)


class PdfScanHelperTest(unittest.TestCase):
    """documents.pdf_is_scanned / render_pdf_page 的纯函数契约（T382）。"""

    def test_scanned_threshold(self):
        self.assertFalse(docs.pdf_is_scanned("", 0), "没有页就不算扫描版（读不出来别硬标）")
        self.assertTrue(docs.pdf_is_scanned("", 1))
        self.assertTrue(docs.pdf_is_scanned("\n \n", 3), "只有版式空白＝抽不出字")
        self.assertFalse(docs.pdf_is_scanned("每页都有几十字" * 40, 2))
        # 平均每页 < 10 字才算扫描版：1 页 9 字算，11 字不算（阈值锚）
        self.assertTrue(docs.pdf_is_scanned("九字九字九字九字九", 1))
        self.assertFalse(docs.pdf_is_scanned("十一个字十一个字十一个字一", 1))

    def test_render_page_out_of_range_returns_empty(self):
        # 页号越界/超上限不抛异常，返回空字节（调用方静默跳过，不挡发送）
        self.assertEqual(docs.render_pdf_page(b"not a pdf", 0), b"")
        self.assertEqual(docs.render_pdf_page(b"not a pdf", docs.PDF_PAGE_MAX + 1), b"")
        self.assertEqual(docs.render_pdf_page(b"not a pdf", 1), b"")

    def test_pdf_page_count_broken_file(self):
        self.assertEqual(docs.pdf_page_count(b"not a pdf"), 0)


class OcrEngineTest(unittest.TestCase):
    """ocr.py RapidOCR 单引擎与缓存（引擎桩替，不联网）。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self._patch_dir = mock.patch.object(ocr, "OCR_DIR", Path(self._td.name))
        self._patch_dir.start()

    def tearDown(self):
        self._patch_dir.stop()
        self._td.cleanup()

    @staticmethod
    def _done(text="识别"):
        return {"text": text, "engine": "rapidocr", "ms": 1, "status": "done", "error": ""}

    def test_done_result_cached(self):
        with mock.patch.object(ocr, "_ocr_rapid", return_value=self._done()) as rapid:
            first = ocr.ocr_image(b"pic")
            second = ocr.ocr_image(b"pic")
        self.assertEqual(first, second)
        rapid.assert_called_once(), "命中缓存不应再跑引擎"

    def test_failed_result_not_cached(self):
        failed = {"text": "", "engine": "rapidocr", "ms": 1, "status": "failed", "error": "x"}
        ok = self._done()
        with mock.patch.object(ocr, "_ocr_rapid", side_effect=[failed, ok]) as rapid:
            ocr.ocr_image(b"pic")
            got = ocr.ocr_image(b"pic")
        self.assertEqual(rapid.call_count, 2, "失败不缓存：重试必须真跑")
        self.assertEqual(got["status"], "done")

    def test_empty_content_never_raises(self):
        got = ocr.ocr_image(b"")
        self.assertEqual(got["status"], "failed")


if __name__ == "__main__":
    unittest.main()
