"""JSON 文件持久化工具与会话消息路径解析。"""

import json
import os
import threading
import uuid
from pathlib import Path

from .config import MESSAGES_DIR, SESSIONS_PATH

# ====== JSON 文件持久化工具 ======
_JSON_LOCK = threading.RLock()


def _read_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return default if default is not None else {}


def _write_json(path: Path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with _JSON_LOCK:
        try:
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(tmp_path, path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


def _mutate_json(path: Path, updater, default=None):
    """串行执行 JSON 文件的读-改-写，避免并发请求互相覆盖。"""
    with _JSON_LOCK:
        data = _read_json(path, default)
        result = updater(data)
        if result is not None:
            _write_json(path, result)
            return result
        return data


def _delete_by_session(path: Path, session_id: str) -> int:
    """删除数据中属于指定会话的条目，返回删除数量。"""
    removed = []

    def updater(data):
        nonlocal removed
        removed = [k for k, v in data.items() if v.get("sessionId") == session_id]
        for k in removed:
            data.pop(k, None)
        return data if removed else None

    _mutate_json(path, updater)
    return len(removed)


def _get_messages_path(session_id: str) -> Path:
    return MESSAGES_DIR / f"{session_id}.json"


def _resolve_messages_path(session_id: str) -> Path:
    """兼容两种会话标识：local key 直接找消息文件，server sessionId 反向查 sessions.json。"""
    direct = _get_messages_path(session_id)
    if direct.exists():
        return direct
    sessions = _read_json(SESSIONS_PATH, {})
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId") == session_id:
            return _get_messages_path(sid)
    return direct



__all__ = [
    "_read_json", "_write_json", "_mutate_json", "_delete_by_session",
    "_get_messages_path", "_resolve_messages_path",
]
