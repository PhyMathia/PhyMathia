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
