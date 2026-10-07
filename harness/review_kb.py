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
# 2026-10-07 T190：外层键＝账号 id，每账号一个四键桶。原先全局单份时多账号交替
# 查询互相顶替，且两账号文件 mtime_ns 恰好相等会跨账号回错清单。账号集是开放
# 集合（可任意建号），桶按需惰性建、不设上限清理——进程内小缓存，单账号至多四
# 条目，随进程退出即失效。线程口径同原先：无锁。
_KB_CACHE: Dict[str, Dict[str, Any]] = {}


def _load_kb_file(cache: Dict[str, Any], path, mtime_key: str, list_key: str) -> list:
    try:
        mtime = path.stat().st_mtime_ns
    except Exception:
        return []
    if cache[mtime_key] == mtime:
        return cache[list_key]
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
    cache[mtime_key] = mtime
    cache[list_key] = items
    return items


def _load_user_kb(account: str = "default") -> Dict[str, list]:
    """知识检索工具的数据源：data/knowledge.json（知识面板）与 data/formulas.json（公式速查）。

    account（多账号 P1）：存储账号域，经 server.accounts.resolve_paths 解析到
    该账号自己的 knowledge/formulas 文件；server 包不可用（battery 测试桩/
    独立部署）时降级空清单——与既有降级路同口径。"""
    try:
        from server import accounts
        paths = accounts.resolve_paths(account)
        knowledge_path, formulas_path = paths.knowledge_path, paths.formulas_path
    except Exception:
        return {"knowledge": [], "formulas": []}
    # 桶键取消毒后的 paths.account：非法 id 已被 resolve_paths 归一为 default，别名共享同一桶
    bucket = _KB_CACHE.setdefault(paths.account, {
        "knowledge_mtime": None,
        "formulas_mtime": None,
        "knowledge": [],
        "formulas": [],
    })
    return {
        "knowledge": _load_kb_file(bucket, knowledge_path, "knowledge_mtime", "knowledge"),
        "formulas": _load_kb_file(bucket, formulas_path, "formulas_mtime", "formulas"),
    }
