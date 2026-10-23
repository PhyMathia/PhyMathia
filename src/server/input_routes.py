"""输入节点素材摄取：POST /api/input/ingest（2026-10-22 输入节点重做 P0）。

与 /api/documents/parse 的分工：parse 是旧「上传→AI 提炼知识点」一体化链路
（存量输入节点入口保留）；ingest 只做机械转写——文本抽取 / PDF 抽页 / 图片
OCR，绝不调 AI 模型、不产知识点、不写知识面板。返回文本截 8000 字，截断时
全文落 ``data/uploads/<fileId>.txt``（前端按 fileId 可取回）。
"""

import asyncio
import base64
import mimetypes
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

from .config import UPLOAD_DIR, UPLOAD_MAX_BYTES
from .documents import _extract_document_text, _read_upload, _sanitize_filename, _save_upload
from .ocr import ocr_image
from .request_ctx import _parse_json_object

router = APIRouter()

# 与前端 addSourceFiles 的 kind 判定同口径（按扩展名），改一边要同步另一边
IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".json", ".log", ".tex"}
INGEST_TEXT_MAX_CHARS = 8000


def _ingest_kind(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTS:
        return "image"
    if ext in TEXT_EXTS:
        return "text"
    return "file"


def _guess_mime(filename: str) -> str:
    mt, _ = mimetypes.guess_type(filename)
    return mt or "application/octet-stream"


def _write_fulltext(file_id: str, text: str) -> None:
    # 只在截断时落全文：没截断时 resp.text 本身就是全文，<fileId>.txt 的存在
    # 即「有超出展示额度的全文」，不额外占盘
    (UPLOAD_DIR / f"{file_id}.txt").write_text(text, "utf-8")


@router.post("/api/input/ingest")
async def api_input_ingest(request: Request):
    payload = await _parse_json_object(request)

    filename = _sanitize_filename(str(payload.get("fileName") or "素材"))
    content = None
    file_id = str(payload.get("fileId") or "")
    if file_id:
        loaded = await asyncio.to_thread(_read_upload, file_id)
        if not loaded:
            raise HTTPException(status_code=404, detail="文件不存在，请重新上传")
        entry, content = loaded
        filename = _sanitize_filename(entry.get("filename") or filename)
    else:
        try:
            content = await asyncio.to_thread(
                base64.b64decode, str(payload.get("contentBase64") or ""))
        except Exception:
            raise HTTPException(status_code=400, detail="文件内容格式错误")
        if not content:
            raise HTTPException(status_code=400, detail="缺少文件内容")
        if len(content) > UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 20MB 限制")
        file_id = "doc_" + uuid.uuid4().hex[:12]
        await asyncio.to_thread(_save_upload, file_id, filename, content)

    kind = _ingest_kind(filename)
    ocr_info = {"status": "none", "engine": "", "ms": 0, "error": ""}
    if kind == "image":
        # ocr 参数缺省开：按 fileId 重识别（不传 ocr）语义就是「再转写一次」
        if payload.get("ocr") is False:
            ocr_info = {"status": "skipped", "engine": "", "ms": 0, "error": ""}
            text = ""
        else:
            # RapidOCR 首次加载模型是秒级同步操作，OCR 全程离事件循环
            ocr_info = await asyncio.to_thread(ocr_image, content)
            text = str(ocr_info.get("text") or "")
    else:
        text = await asyncio.to_thread(_extract_document_text, filename, content)

    chars = len(text)
    truncated = chars > INGEST_TEXT_MAX_CHARS
    if truncated:
        await asyncio.to_thread(_write_fulltext, file_id, text)

    return {
        "ok": True,
        "fileId": file_id,
        "fileName": filename,
        "kind": kind,
        "text": text[:INGEST_TEXT_MAX_CHARS],
        "chars": chars,
        "truncated": truncated,
        "mime": _guess_mime(filename),
        "size": len(content),
        "ocr": {
            "status": str(ocr_info.get("status") or "none"),
            "engine": str(ocr_info.get("engine") or ""),
            "ms": int(ocr_info.get("ms") or 0),
            "error": str(ocr_info.get("error") or "")[:200],
        },
    }
