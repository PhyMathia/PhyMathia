"""文件上传存取与文档/图片文本抽取（素材摄取的机械转写端）。

2026-10-28（T383）：/api/documents/parse 知识点提取链退役，原 AI/本地
文档提取五函数（_parse_document_extract_json/_safe_score/
_extract_text_formulas/_local_/_ai_extract_document_knowledge）随链删除。
"""

import io
import logging
import os
import re
import threading
import time
import uuid
from pathlib import Path

from .config import UPLOAD_DIR, UPLOADS_META_PATH
from .storage import _mutate_json, _read_json

logger = logging.getLogger(__name__)

def _sanitize_filename(filename: str) -> str:
    name = Path(str(filename or "upload")).name
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip()[:120] or "upload"
    return name


def _read_upload(file_id: str):
    meta = _read_json(UPLOADS_META_PATH, {})
    entry = meta.get(file_id)
    if not entry:
        return None
    path = UPLOAD_DIR / f"{file_id}.bin"
    if not path.exists():
        return None
    return entry, path.read_bytes()


def _save_upload(file_id: str, filename: str, content: bytes) -> None:
    # meta 走 _mutate_json 锁内读-改-写：并发上传时后写者不再覆盖前者的条目
    _mutate_json(UPLOADS_META_PATH, lambda meta: {**meta, file_id: {
        "id": file_id,
        "filename": filename,
        "savedAt": int(time.time() * 1000),
    }})
    (UPLOAD_DIR / f"{file_id}.bin").write_bytes(content)


# OCR 引擎进程级单例：RapidOCR() 构造要加载 ONNX 模型，是图片识别最贵的一步
# （此前每次识别都重建实例）。推理期并发极少了；引擎初始化用锁防双建。
_OCR_ENGINE = None
_OCR_LOCK = threading.Lock()


def _get_ocr_engine():
    global _OCR_ENGINE
    if _OCR_ENGINE is None:
        with _OCR_LOCK:
            if _OCR_ENGINE is None:
                from rapidocr_onnxruntime import RapidOCR
                _OCR_ENGINE = RapidOCR()
    return _OCR_ENGINE


def _extract_image_text(content: bytes) -> str:
    try:
        _get_ocr_engine()
    except ImportError:
        return ""
    # 唯一临时文件名：并发图片解析共用固定名会互相覆盖；用完即删不留残留
    tmp_path = UPLOAD_DIR / f"ocr_tmp_{uuid.uuid4().hex[:8]}.png"
    try:
        tmp_path.write_bytes(content)
        result, _ = _get_ocr_engine()(str(tmp_path))
        if result:
            return "\n".join(str(item[1]) for item in result if len(item) > 1)
    except Exception as e:
        logger.warning(f"Image OCR failed: {e}")
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
    return ""


def _extract_document_text(filename: str, content: bytes) -> str:
    ext = Path(filename).suffix.lower()
    if ext in {".txt", ".md", ".markdown", ".csv", ".json", ".log", ".tex"}:
        for enc in ("utf-8", "utf-8-sig", "gbk"):
            try:
                return content.decode(enc)
            except (UnicodeDecodeError, ValueError):
                continue
        return content.decode("utf-8", "ignore")
    if ext == ".pdf":
        try:
            from pypdf import PdfReader
        except ImportError:
            return ""
        try:
            reader = PdfReader(io.BytesIO(content))
            return "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception as e:
            logger.warning(f"PDF extraction failed: {e}")
            return ""
    if ext == ".docx":
        try:
            import docx
        except ImportError:
            return ""
        try:
            doc = docx.Document(io.BytesIO(content))
            parts = [p.text for p in doc.paragraphs]
            for table in doc.tables:
                for row in table.rows:
                    parts.append(" | ".join(cell.text for cell in row.cells))
            return "\n".join(parts)
        except Exception as e:
            logger.warning(f"DOCX extraction failed: {e}")
            return ""
    if ext in {".pptx", ".ppt"}:
        try:
            from pptx import Presentation
        except ImportError:
            return ""
        try:
            prs = Presentation(io.BytesIO(content))
            parts = []
            for slide in prs.slides:
                for shape in slide.shapes:
                    if hasattr(shape, "text") and shape.text:
                        parts.append(shape.text)
                    if hasattr(shape, "has_table") and shape.has_table:
                        for row in shape.table.rows:
                            parts.append(" | ".join(cell.text for cell in row.cells))
            return "\n".join(parts)
        except Exception as e:
            logger.warning(f"PPTX extraction failed: {e}")
            return ""
    if ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}:
        return _extract_image_text(content)
    return ""


# ===== 扫描版 PDF 页转图（T382，2026-10-23）=====
# 文字版 PDF/Word/txt 照旧抽文字进管道；只有**抽不出字**的扫描版（图片型、无
# 文字层）才需要页转图——各家供应商的文档块格式互不通用（17 家随便配），统一
# 走「页渲染成 JPEG → 图片通道」，与素材篮附图同一套。渲染在发送时按需做
# （GET /api/input/pdf_pages），ingest 只打标、不落任何渲染产物。
PDF_PAGE_MAX = 8              # 单份 PDF 最多参与前 8 页（配额见前端 _allocateSendImageRefs）
PDF_RENDER_MAX_EDGE = 1600    # 与前端压图上限同口径：渲染就不给超大图
PDF_RENDER_QUALITY = 82
PDF_SCANNED_AVG_CHARS = 10    # 平均每页可抽字数低于此值＝「抽不出字」（扫描版判定）


def pdf_page_count(content: bytes) -> int:
    """PDF 页数；读不出来返回 0（加密/损坏）。只读目录，不做渲染。"""
    try:
        from pypdf import PdfReader

        return len(PdfReader(io.BytesIO(content)).pages)
    except Exception as e:
        logger.warning(f"PDF page count failed: {e}")
        return 0


def pdf_is_scanned(text: str, pages: int) -> bool:
    """扫描版判定：有页却几乎抽不出字（每页平均 < PDF_SCANNED_AVG_CHARS）。

    严格按空白归一后的字符数算——版式空行不算「字」。文字版 PDF 即使短也常
    有几十字/页，不会误判；扫描版即使带页眉页码（OCR 层）也能识别。
    """
    if pages <= 0:
        return False
    chars = len(re.sub(r"\s+", "", str(text or "")))
    return chars < pages * PDF_SCANNED_AVG_CHARS


def render_pdf_page(content: bytes, page_number: int,
                    max_edge: int = PDF_RENDER_MAX_EDGE,
                    quality: int = PDF_RENDER_QUALITY) -> bytes:
    """把第 page_number 页（1-based）渲染成 JPEG 字节；失败返回 b""。

    pypdfium2 缺失/页号越界/渲染异常一律静默降级为空——页图是增益，缺了就
    回落成「未提取到文本」的占位，不因渲染失败挡发送（与附图同口径）。
    """
    if page_number < 1 or page_number > PDF_PAGE_MAX:
        return b""
    try:
        import pypdfium2 as pdfium
    except ImportError:
        logger.warning("pypdfium2 未安装：扫描版 PDF 页渲染不可用（pip install pypdfium2）")
        return b""
    doc = None
    try:
        doc = pdfium.PdfDocument(content)
        if page_number > len(doc):
            return b""
        page = doc[page_number - 1]
        width, height = page.get_size()
        longest = max(float(width or 0), float(height or 0), 1.0)
        # 大页面降采样、小页面保持原尺寸：渲染侧就压到与前端同一上限，省内存
        scale = max(1.0, min(2.0, max_edge / longest))
        bitmap = page.render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        buf = io.BytesIO()
        image.save(buf, format="JPEG", quality=quality)
        return buf.getvalue()
    except Exception as e:
        logger.warning(f"PDF page render failed (page {page_number}): {e}")
        return b""
    finally:
        if doc is not None:
            try:
                doc.close()
            except Exception:
                pass


__all__ = [
    "_sanitize_filename", "_read_upload", "_save_upload", "_extract_document_text",
]
