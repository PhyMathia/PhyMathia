"""用户知识资产（知识库/公式速查）检索数据源（2026-10-03 智能化第二期）。

自 review.py 拆出（2026-10-04，T163）：只在 Φ 进程内按 mtime 缓存，只读；server 包
不可用（battery 测试桩/独立部署）或文件缺失/损坏时降级为空清单——检索工具回
「数据不可用/为空」，绝不阻断主流程。
"""
import json
import logging
import os
from typing import Any, Dict

logger = logging.getLogger("harness.review_kb")

# ---- 2026-10-03 智能化第二期：用户知识资产（知识库/公式速查）检索数据源 ----
# 只在 Φ 进程内按 mtime 缓存，只读；server 包不可用（battery 测试桩/独立部署）
# 或文件缺失/损坏时降级为空清单——检索工具回「数据不可用/为空」，绝不阻断主流程。
_KB_CACHE: Dict[str, Any] = {
    "knowledge_mtime": None,
    "formulas_mtime": None,
    "knowledge": [],
    "formulas": [],
}


def _load_kb_file(path, mtime_key: str, list_key: str) -> list:
    try:
        mtime = path.stat().st_mtime_ns
    except Exception:
        return []
    if _KB_CACHE[mtime_key] == mtime:
        return _KB_CACHE[list_key]
    try:
        data = json.loads(path.read_text(encoding="utf-8") or "{}")
    except Exception:
        logger.warning("harness kb load failed: %s", path, exc_info=True)
        return []
    items = []
    if isinstance(data, dict):
        items = [item for item in data.values() if isinstance(item, dict)]
    elif isinstance(data, list):
        items = [item for item in data if isinstance(item, dict)]
    _KB_CACHE[mtime_key] = mtime
    _KB_CACHE[list_key] = items
    return items


def _load_user_kb() -> Dict[str, list]:
    """知识检索工具的数据源：data/knowledge.json（知识面板）与 data/formulas.json（公式速查）。"""
    try:
        from server.config import FORMULAS_PATH, KNOWLEDGE_PATH
    except Exception:
        return {"knowledge": [], "formulas": []}
    return {
        "knowledge": _load_kb_file(KNOWLEDGE_PATH, "knowledge_mtime", "knowledge"),
        "formulas": _load_kb_file(FORMULAS_PATH, "formulas_mtime", "formulas"),
    }
