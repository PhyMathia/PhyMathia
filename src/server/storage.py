"""JSON 文件持久化工具与会话消息路径解析。"""

import json
import os
import re
import threading
import uuid
from pathlib import Path

from .config import MESSAGES_DIR, SESSIONS_PATH

# ====== JSON 文件持久化工具 ======
_JSON_LOCK = threading.RLock()

# 会话标识白名单：字母/数字/下划线/连字符，杜绝路径分隔符与 Windows 反斜杠穿越
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _read_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            pass
    return default if default is not None else {}


_JSON_READ_CACHE = {}
_JSON_READ_CACHE_MAX = 32


def _invalidate_json_cache(path) -> None:
    """使指定路径的读取缓存失效（写入后调用）。"""
    if path is not None:
        with _JSON_LOCK:
            _JSON_READ_CACHE.pop(str(path), None)


def _read_json_cached(path, default=None):
    """带 mtime+size 失效的内存缓存读取，适合高频只读路径（如会话消息）。

    - 写入方通过 _write_json 自动失效缓存；
    - 读取方不应原地修改返回的数据（如需修改请先拷贝）。
    """
    try:
        stat = path.stat()
    except OSError:
        return _read_json(path, default)
    key = str(path)
    with _JSON_LOCK:
        cached = _JSON_READ_CACHE.get(key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2]
    data = _read_json(path, default)
    with _JSON_LOCK:
        if len(_JSON_READ_CACHE) >= _JSON_READ_CACHE_MAX:
            _JSON_READ_CACHE.clear()
        _JSON_READ_CACHE[key] = (stat.st_mtime_ns, stat.st_size, data)
    return data

def _write_json(path: Path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with _JSON_LOCK:
        try:
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(tmp_path, path)
            _invalidate_json_cache(path)
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
    # 单会话路由的 session_id 直接拼文件路径，必须白名单校验，
    # 否则 URL 编码的 "..%5C" 反斜杠在 Windows 下可穿越到 data 目录之外
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        raise ValueError(f"invalid session id: {session_id!r}")
    return MESSAGES_DIR / f"{session_id}.json"


def _resolve_messages_path(session_id: str) -> Path:
    """兼容两种会话标识：local key 直接找消息文件，server sessionId 反向查 sessions.json。"""
    direct = None
    try:
        direct = _get_messages_path(session_id)
        if direct.exists():
            return direct
    except ValueError:
        pass
    sessions = _read_json(SESSIONS_PATH, {})
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId") == session_id:
            try:
                return _get_messages_path(sid)
            except ValueError:
                continue
    if direct is not None:
        return direct
    raise ValueError(f"invalid session id: {session_id!r}")




__all__ = [
    "_read_json", "_write_json", "_mutate_json", "_delete_by_session",
    "_read_json_cached", "_invalidate_json_cache",
    "_get_messages_path", "_resolve_messages_path",
]
