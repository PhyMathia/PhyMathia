"""输入节点素材摄取：POST /api/input/ingest（2026-10-22 输入节点重做 P0）。

与 /api/documents/parse 的分工：parse 是旧「上传→AI 提炼知识点」一体化链路
（存量输入节点入口保留）；ingest 只做机械转写——文本抽取 / PDF 抽页 / 图片
OCR，绝不调 AI 模型、不产知识点、不写知识面板。返回文本截 8000 字，截断时
全文落 ``data/uploads/<fileId>.txt``（前端按 fileId 可取回）。
"""

import asyncio
import base64
import mimetypes
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, Response

from .config import UPLOAD_DIR, UPLOAD_MAX_BYTES
from .documents import (
    PDF_PAGE_MAX,
    _extract_document_text,
    _read_upload,
    _sanitize_filename,
    _save_upload,
    pdf_is_scanned,
    pdf_page_count,
    render_pdf_page,
)
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

    # 扫描版 PDF 打标（T382）：文字版照旧只走抽文字；抽不出字的（图片型、无文字层）
    # 标出来，发送时按需把前几页渲染成图片走附图通道。素材条目与 data/ 存储不动——
    # 这里只回两个计数，不落任何渲染产物。
    pdf_info = None
    if Path(filename).suffix.lower() == ".pdf":
        pages = await asyncio.to_thread(pdf_page_count, content)
        pdf_info = {"pages": pages, "scanned": pdf_is_scanned(text, pages)}

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
        # 非 PDF 为 None；旧客户端不认该键，照旧读 text/truncated 即可
        "pdf": pdf_info,
    }


# 素材篮条目源文件下载（2026-10-23 取材附图通道）：首问发送前前端按 fileId 取
# 字节压成 dataURL 附进聊天请求。只放行 ingest 自己落的 id 形状，不携带路径语义
_FILE_ID_RE = re.compile(r"^doc_[0-9a-f]{12}$")


@router.get("/api/input/files/{file_id}")
async def api_input_file(file_id: str):
    if not _FILE_ID_RE.match(file_id):
        raise HTTPException(status_code=404, detail="文件不存在")
    loaded = await asyncio.to_thread(_read_upload, file_id)
    if not loaded:
        raise HTTPException(status_code=404, detail="文件不存在")
    entry, content = loaded
    return Response(content=content, media_type=_guess_mime(str(entry.get("filename") or "")))


# 扫描版 PDF 页转图（T382，2026-10-23）：发送时按需渲染，服务端不缓存、不落盘。
# 页号 1-based，只放行前 PDF_PAGE_MAX 页——多页扫描件全发既超配额（一条消息 4 张）
# 又烧时延；配额的分配规则在前端（_allocateSendImageRefs），这里只做单页渲染。
@router.get("/api/input/pdf_pages")
async def api_input_pdf_page(fileId: str = "", page: int = 1):
    if not _FILE_ID_RE.match(str(fileId or "")):
        raise HTTPException(status_code=404, detail="文件不存在")
    if page < 1 or page > PDF_PAGE_MAX:
        raise HTTPException(status_code=400, detail=f"页号超出范围（只渲染前 {PDF_PAGE_MAX} 页）")
    loaded = await asyncio.to_thread(_read_upload, fileId)
    if not loaded:
        raise HTTPException(status_code=404, detail="文件不存在")
    entry, content = loaded
    if Path(str(entry.get("filename") or "")).suffix.lower() != ".pdf":
        raise HTTPException(status_code=400, detail="不是 PDF 文件")
    jpeg = await asyncio.to_thread(render_pdf_page, content, page)
    if not jpeg:
        # 渲染不可用（缺 pypdfium2 / 加密 / 页号越界）——前端按「这张取不到」静默跳过
        raise HTTPException(status_code=422, detail="这一页渲染不出来")
    # 同一 fileId+page 的字节是确定的：允许浏览器短缓存，翻来覆去重发同一页不重复渲染
    return Response(content=jpeg, media_type="image/jpeg",
                    headers={"Cache-Control": "private, max-age=600"})
