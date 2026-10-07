"""JSON 文件持久化工具与会话消息路径解析。"""

import json
import os
import re
import threading
import uuid
from pathlib import Path

from . import accounts
from .accounts import DEFAULT_ACCOUNT

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
        if not isinstance(data, dict):
            return None
        # 兼容旧版 {"items": {...}} 包装格式（POST 直写的历史残留）：
        # 不解包的话删除会静默失效、包装原样写回
        if set(data.keys()) == {"items"} and isinstance(data.get("items"), dict):
            data = data["items"]
        removed = [k for k, v in data.items() if isinstance(v, dict) and v.get("sessionId") == session_id]
        for k in removed:
            data.pop(k, None)
        return data if removed else None

    _mutate_json(path, updater)
    return len(removed)


def _get_messages_path(session_id: str, account: str = DEFAULT_ACCOUNT) -> Path:
    # 单会话路由的 session_id 直接拼文件路径，必须白名单校验，
    # 否则 URL 编码的 "..%5C" 反斜杠在 Windows 下可穿越到 data 目录之外
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        raise ValueError(f"invalid session id: {session_id!r}")
    return accounts.resolve_paths(account).messages_dir / f"{session_id}.json"


def _resolve_messages_path(session_id: str, account: str = DEFAULT_ACCOUNT) -> Path:
    """兼容两种会话标识：local key 直接找消息文件，server sessionId 反向查 sessions.json。"""
    paths = accounts.resolve_paths(account)
    direct = None
    try:
        direct = _get_messages_path(session_id, account)
        if direct.exists():
            return direct
    except ValueError:
        pass
    sessions = _read_json(paths.sessions_path, {})
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId") == session_id:
            try:
                return _get_messages_path(sid, account)
            except ValueError:
                continue
    if direct is not None:
        return direct
    raise ValueError(f"invalid session id: {session_id!r}")


# ====== KV 键值存储：会话级大键拆分路由 ======
# graph:<sid> / harness_history:<sid> / graph_history:<sid> 这类每会话大对象
# 拆到 data/kv/<sid>.json（{键: 值}），保存单个会话不再整写主文件（此前是
# 全量重写 700KB+ 的 kv_store.json，且独占全局 JSON 锁）；其余全局键（测验
# 题库/统计、continent_*、socratic、滚动记忆、当前会话）留在 kv_store.json。
# 多账号（P1）：所有路径按 account 经 accounts.resolve_paths 现算（调用时读
# config.DATA_DIR，测试 patch 一处即整体重定向）；context.py 的 socratic/
# 滚动记忆小键不走本层——既有测试按主文件字节钉死。
_KV_SESSION_PREFIXES = ("graph:", "harness_history:", "graph_history:")


def _kv_split_session(key: str):
    """会话级键返回 (sid, key)；全局键返回 None。sid 必须过白名单防路径穿越。"""
    key = str(key or "")
    for prefix in _KV_SESSION_PREFIXES:
        if key.startswith(prefix):
            sid = key[len(prefix):]
            if sid and _SESSION_ID_RE.match(sid):
                return sid, key
    return None


def _kv_session_path(sid: str, account: str = DEFAULT_ACCOUNT) -> Path:
    if not isinstance(sid, str) or not _SESSION_ID_RE.match(sid):
        raise ValueError(f"invalid session id: {sid!r}")
    return accounts.resolve_paths(account).kv_dir / f"{sid}.json"


def kv_read(key: str, default=None, account: str = DEFAULT_ACCOUNT):
    """按键读 KV：会话级键走 data/kv/<sid>.json，其余走主文件。"""
    paths = accounts.resolve_paths(account)
    split = _kv_split_session(key)
    if split is not None:
        data = _read_json(_kv_session_path(split[0], account), {})
        if isinstance(data, dict) and key in data:
            return data[key]
        return default
    main = _read_json(paths.kv_path, {})
    if isinstance(main, dict) and key in main:
        return main[key]
    return default


def kv_write(key: str, value, account: str = DEFAULT_ACCOUNT) -> None:
    """按键写 KV（upsert），自动路由到会话文件或主文件。"""
    paths = accounts.resolve_paths(account)
    split = _kv_split_session(key)
    path = _kv_session_path(split[0], account) if split is not None else paths.kv_path

    def updater(data):
        data = dict(data) if isinstance(data, dict) else {}
        data[key] = value
        return data

    path.parent.mkdir(parents=True, exist_ok=True)
    _mutate_json(path, updater, default={})


def kv_delete(key: str, account: str = DEFAULT_ACCOUNT) -> None:
    """按键删 KV；会话文件删空后移除文件本身（空 JSON 不是用户数据）。"""
    split = _kv_split_session(key)
    path = _kv_session_path(split[0], account) if split is not None else accounts.resolve_paths(account).kv_path

    def updater(data):
        if not isinstance(data, dict) or key not in data:
            return None
        data = dict(data)
        data.pop(key, None)
        return data

    result = _mutate_json(path, updater, default={})
    if split is not None and isinstance(result, dict) and not result:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def kv_all_data(account: str = DEFAULT_ACCOUNT) -> dict:
    """全量合并视图（主文件 + 所有会话文件，会话文件覆盖同名键）。

    备份导出与大陆投影等「要看到全部 KV」的场合用；会话文件优先——它与
    迁移中断时残留在主文件里的旧副本相比总是较新的一份。
    """
    paths = accounts.resolve_paths(account)
    merged = {}
    main = _read_json(paths.kv_path, {})
    if isinstance(main, dict):
        merged.update(main)
    if paths.kv_dir.exists():
        for path in sorted(paths.kv_dir.glob("*.json")):
            if not _SESSION_ID_RE.match(path.stem):
                continue
            data = _read_json(path, {})
            if isinstance(data, dict):
                merged.update(data)
    return merged


def kv_migrate_session_keys(account: str = DEFAULT_ACCOUNT) -> int:
    """启动迁移：把主文件里的会话级键搬进 data/kv/<sid>.json，返回搬运键数。

    先写会话文件、全部成功后才从主文件移除——中途失败下次启动幂等重跑。
    """
    paths = accounts.resolve_paths(account)
    main = _read_json(paths.kv_path, {})
    if not isinstance(main, dict):
        return 0
    to_move = {}
    for key, value in main.items():
        split = _kv_split_session(key)
        if split is not None:
            to_move.setdefault(split[0], {})[key] = value
    if not to_move:
        return 0
    paths.kv_dir.mkdir(parents=True, exist_ok=True)
    for sid, entries in to_move.items():
        def updater(data, _entries=entries):
            data = dict(data) if isinstance(data, dict) else {}
            data.update(_entries)
            return data

        _mutate_json(_kv_session_path(sid, account), updater, default={})
    moved_keys = {key for entries in to_move.values() for key in entries}

    def remove_moved(data):
        if not isinstance(data, dict):
            return None
        remaining = {k: v for k, v in data.items() if k not in moved_keys}
        return remaining if len(remaining) != len(data) else None

    _mutate_json(paths.kv_path, remove_moved)
    return len(moved_keys)


def kv_restore_bulk(data, replace: bool, account: str = DEFAULT_ACCOUNT) -> int:
    """备份导入：把一份 {键: 值} 按拆分路由落盘，返回导入键数。

    全局键合并进主文件（replace 时先清空）；会话键按 sid 分组合并进各自
    会话文件（replace 时先清空 data/kv/）。比逐键 kv_write 少 O(n) 次全量写。
    """
    paths = accounts.resolve_paths(account)
    if not isinstance(data, dict):
        return 0
    global_part = {}
    session_parts = {}
    for key, value in data.items():
        split = _kv_split_session(key)
        if split is None:
            global_part[key] = value
        else:
            session_parts.setdefault(split[0], {})[key] = value
    if replace:
        paths.kv_path.parent.mkdir(parents=True, exist_ok=True)
        _write_json(paths.kv_path, {})
        if paths.kv_dir.exists():
            for p in paths.kv_dir.glob("*.json"):
                p.unlink(missing_ok=True)
    else:
        existing = _read_json(paths.kv_path, {})
        global_part = {**(existing if isinstance(existing, dict) else {}), **global_part}
    paths.kv_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(paths.kv_path, global_part)
    if session_parts:
        paths.kv_dir.mkdir(parents=True, exist_ok=True)
    for sid, entries in session_parts.items():
        def updater(d, _entries=entries):
            d = dict(d) if isinstance(d, dict) else {}
            d.update(_entries)
            return d

        _mutate_json(_kv_session_path(sid, account), updater, default={})
    return len(data)


__all__ = [
    "_read_json", "_write_json", "_mutate_json", "_delete_by_session",
    "_read_json_cached", "_invalidate_json_cache",
    "_get_messages_path", "_resolve_messages_path",
    "kv_read", "kv_write", "kv_delete", "kv_all_data",
    "kv_migrate_session_keys", "kv_restore_bulk",
]
