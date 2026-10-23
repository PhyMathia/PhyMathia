"""输入节点素材 OCR（2026-10-23 收敛为 RapidOCR 单引擎）。

图片文字转写走纯本地 RapidOCR（PaddleOCR 系 ONNX 模型，pip 包自带模型，
零外部依赖、零网调用），结果按 sha1 落盘缓存。约束：

- ``ocr_image`` 是唯一入口，**永不抛异常**——失败以 ``status='failed'`` 返回，
  不拖垮 ingest 请求（前端条目仍能建，内容是占位文案）；
- 复用 ``documents._extract_image_text``（临时文件生命周期它自管）；
  空串时用 ``find_spec`` 区分「没装」与「没认出字」，两者都报 failed 供前端重试；
- 缓存只存 done 结果——失败可能是暂时的，缓存了会把重试也挡死。

历史：P0 版（2026-10-22）做过「Ollama glm-ocr 优先 / auto 探测回落 RapidOCR」
双引擎，2026-10-23 拍板删除——要更好的识别质量应该在模型设置里配视觉模型
走 AI 提取（图片本来就发得出去），OCR 只留零配置本地兜底，不再私设 Ollama
通道。想换识别效果＝换 RapidOCR 本身或升级 models 装更深的 PP-OCR 模型。
"""

import hashlib
import importlib.util
import json
import logging
import time

from .config import DATA_DIR

logger = logging.getLogger(__name__)

OCR_DIR = DATA_DIR / "ocr"
OCR_DIR.mkdir(parents=True, exist_ok=True)


def _ocr_result(text: str, engine: str, ms: int, status: str, error: str = "") -> dict:
    return {"text": text, "engine": engine, "ms": int(ms), "status": status, "error": error}


def _cache_path(content: bytes):
    return OCR_DIR / f"{hashlib.sha1(content).hexdigest()}-rapidocr.json"


def _read_cache(content: bytes):
    try:
        data = json.loads(_cache_path(content).read_text("utf-8"))
        if isinstance(data, dict) and data.get("engine") == "rapidocr" and data.get("status") == "done":
            return data
    except (OSError, ValueError):
        pass
    return None


def _write_cache(content: bytes, result: dict) -> None:
    try:
        _cache_path(content).write_text(
            json.dumps(result, ensure_ascii=False), "utf-8")
    except OSError as e:
        logger.warning(f"OCR cache write failed: {e}")


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


def ocr_image(content: bytes) -> dict:
    """识别一张图片，返回 {text, engine, ms, status, error}，不抛异常。"""
    if not content:
        return _ocr_result("", "rapidocr", 0, "failed", "空图片")
    hit = _read_cache(content)
    if hit is not None:
        return hit
    result = _ocr_rapid(content)
    if result.get("status") == "done":
        _write_cache(content, result)
    return result
