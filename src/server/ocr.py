"""输入节点素材 OCR（2026-10-22 输入节点重做 P0）。

本机 Ollama（glm-ocr）优先、RapidOCR 兜底，结果按 sha1 落盘缓存。约束：

- ``ocr_image`` 是唯一入口，**永不抛异常**——失败以 ``status='failed'`` 返回，
  不拖垮 ingest 请求（前端条目仍能建，内容是占位文案）；
- RapidOCR 分支复用 ``documents._extract_image_text``（临时文件生命周期它自管）；
  空串时用 ``find_spec`` 区分「没装」与「没认出字」，两者都报 failed 供前端重试；
- ``auto`` 引擎选择走 ``GET /api/tags`` 探测（1s 超时、60s 进程级缓存），Ollama
  不在就是 RapidOCR；GLM 失败自动回落 RapidOCR 一次（点名 glm 不回落）；
- 缓存只存 done 结果——失败可能是暂时的（Ollama 没起），缓存了会把重试也挡死。
"""

import base64
import hashlib
import importlib.util
import io
import json
import logging
import time

import httpx

from .config import DATA_DIR

logger = logging.getLogger(__name__)

OLLAMA_BASE = "http://127.0.0.1:11434"
GLM_OCR_MODEL = "glm-ocr"
GLM_TIMEOUT_S = 120.0
TAGS_TIMEOUT_S = 1.0
TAGS_CACHE_S = 60.0
OCR_MAX_EDGE_PX = 2400

OCR_DIR = DATA_DIR / "ocr"
OCR_DIR.mkdir(parents=True, exist_ok=True)

_tags_cache = {"at": -TAGS_CACHE_S, "has": False}


def _ocr_result(text: str, engine: str, ms: int, status: str, error: str = "") -> dict:
    return {"text": text, "engine": engine, "ms": int(ms), "status": status, "error": error}


def _cache_path(content: bytes, engine: str):
    return OCR_DIR / f"{hashlib.sha1(content).hexdigest()}-{engine}.json"


def _read_cache(content: bytes, engine: str):
    try:
        data = json.loads(_cache_path(content, engine).read_text("utf-8"))
        if isinstance(data, dict) and data.get("engine") == engine and data.get("status") == "done":
            return data
    except (OSError, ValueError):
        pass
    return None


def _write_cache(content: bytes, engine: str, result: dict) -> None:
    try:
        _cache_path(content, engine).write_text(
            json.dumps(result, ensure_ascii=False), "utf-8")
    except OSError as e:
        logger.warning(f"OCR cache write failed: {e}")


def _glm_available() -> bool:
    now = time.monotonic()
    if now - _tags_cache["at"] < TAGS_CACHE_S:
        return _tags_cache["has"]
    has = False
    try:
        resp = httpx.get(f"{OLLAMA_BASE}/api/tags", timeout=TAGS_TIMEOUT_S)
        if resp.status_code == 200:
            models = (resp.json() or {}).get("models") or []
            has = any(
                str(m.get("name") or "").split(":")[0] == GLM_OCR_MODEL
                for m in models if isinstance(m, dict)
            )
    except (httpx.HTTPError, ValueError):
        has = False
    _tags_cache["at"] = now
    _tags_cache["has"] = has
    return has


def _downscale_b64(content: bytes) -> str:
    # 发送前用 PIL 把最长边压到 ≤2400px：截图素材原图常超 4K，b64 体积与识别
    # 时延都跟着涨。PIL 缺失或解码失败退回原图，识别端自己兜。
    try:
        from PIL import Image
        img = Image.open(io.BytesIO(content))
        img.load()
        if img.mode not in ("RGB", "RGBA", "L", "P"):
            img = img.convert("RGB")
        if max(img.size) > OCR_MAX_EDGE_PX:
            ratio = OCR_MAX_EDGE_PX / max(img.size)
            img = img.resize((max(1, round(img.width * ratio)), max(1, round(img.height * ratio))))
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception:
        return base64.b64encode(content).decode("ascii")


def _ocr_glm(content: bytes) -> dict:
    started = time.monotonic()
    try:
        body = {
            "model": GLM_OCR_MODEL,
            "prompt": "Text Recognition:",
            "images": [_downscale_b64(content)],
            "stream": False,
            "options": {"temperature": 0},
        }
        resp = httpx.post(f"{OLLAMA_BASE}/api/generate", json=body, timeout=GLM_TIMEOUT_S)
        resp.raise_for_status()
        text = str((resp.json() or {}).get("response") or "").strip()
        if not text:
            return _ocr_result("", "glm", (time.monotonic() - started) * 1000, "failed", "glm 未返回文字")
        return _ocr_result(text, "glm", (time.monotonic() - started) * 1000, "done")
    except (httpx.HTTPError, ValueError) as e:
        return _ocr_result("", "glm", (time.monotonic() - started) * 1000, "failed", str(e)[:200])


def _ocr_rapid(content: bytes) -> dict:
    from .documents import _extract_image_text
    started = time.monotonic()
    try:
        text = _extract_image_text(content)
    except Exception as e:  # 引擎炸了不让它拖垮 ingest
        return _ocr_result("", "rapidocr", (time.monotonic() - started) * 1000, "failed", str(e)[:200])
    if text:
        return _ocr_result(text, "rapidocr", (time.monotonic() - started) * 1000, "done")
    if importlib.util.find_spec("rapidocr_onnxruntime") is None:
        return _ocr_result("", "rapidocr", (time.monotonic() - started) * 1000, "failed", "rapidocr 未安装")
    return _ocr_result("", "rapidocr", (time.monotonic() - started) * 1000, "failed", "未识别出文字")


def _cached_run(content: bytes, engine: str) -> dict:
    hit = _read_cache(content, engine)
    if hit is not None:
        return hit
    result = _ocr_glm(content) if engine == "glm" else _ocr_rapid(content)
    if result.get("status") == "done":
        _write_cache(content, engine, result)
    return result


def ocr_image(content: bytes, engine: str = "auto") -> dict:
    """识别一张图片，返回 {text, engine, ms, status, error}，不抛异常。"""
    if not content:
        return _ocr_result("", "", 0, "failed", "空图片")
    auto = engine not in ("glm", "rapidocr")
    resolved = engine if not auto else ("glm" if _glm_available() else "rapidocr")
    result = _cached_run(content, resolved)
    # auto 且 GLM 失败：回落 RapidOCR 一次（点名 glm 是用户显式选引擎，不回落）
    if auto and resolved == "glm" and result.get("status") != "done":
        fallback = _cached_run(content, "rapidocr")
        if fallback.get("status") == "done":
            result = fallback
    return result
