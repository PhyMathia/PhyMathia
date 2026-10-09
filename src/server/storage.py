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
        # 拆分文件（data/kv/meta/<族>.json 等）所在的目录由写入方自保障：
        # ensure_account 只建 kv/，族目录是 T214 新增层，直写的调用方不该
        # 各自记得 mkdir（漏一个就是 FileNotFoundError）
        path.parent.mkdir(parents=True, exist_ok=True)
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


# ====== KV 键值存储：拆分路由（三层落点） ======
# ① 会话级键 → data/kv/<sid>.json（{键: 值}，一会话一文件）
#    graph:<sid> / harness_history:<sid> / graph_history:<sid> 这类每会话大对象
#    拆出去后，保存单个会话不再整写主文件（此前是全量重写 700KB+ 的
#    kv_store.json，且独占全局 JSON 锁）。
# ② 族/独键 → data/kv/meta/<name>.json（同族共居一文件）
#    socratic:<ref> 与 mem:<sid> 按前缀同族：context 的孤儿记忆清理、分支链
#    状态定位都在族内做前缀全键扫描，拆到每会话文件会切断这些扫描（还会复活
#    「旧版 18 截断前缀」跨会话误删状态的旧 bug）；phymathia_quiz_stats/题库、
#    continent_* 六键按族共居。任一写入只重写本族文件，不再连带其余族。
# ③ 其余全局小键（phi_sessions / tasks:global / 当前会话 / node_recipes …）
#    留在 kv_store.json。
# 多账号（P1）：所有路径按 account 经 accounts.resolve_paths 现算（调用时读
# config.DATA_DIR，测试 patch 一处即整体重定向）。
_KV_SESSION_PREFIXES = ("graph:", "harness_history:", "graph_history:")

# 前缀族：同族键共居一个 meta 文件（族内前缀扫描的必要性见上方注释②）
_KV_FAMILY_PREFIXES = {
    "socratic:": "socratic",
    "mem:": "mem",
}

# 独键族：显式名单（单键/同族共居 meta 文件）；未列出的键保持旧行为留主文件
_KV_SOLO_KEYS = {
    "phymathia_quiz_stats": "quiz",
    "phymathia_quiz_bank": "quiz",
    "continent_edges": "continent",
    "continent_families": "continent",
    "continent_family_suggestions": "continent",
    "continent_gate": "continent",
    "continent_gate_weights": "continent",
    "continent_regions": "continent",
}

_KV_META_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _kv_split_session(key: str):
    """会话级键返回 (sid, key)；其余键返回 None。sid 必须过白名单防路径穿越。"""
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


def _kv_meta_path(family: str, account: str = DEFAULT_ACCOUNT) -> Path:
    """族拆分文件路径。family 只应来自本模块常量表，仍过白名单防呆。"""
    if not isinstance(family, str) or not _KV_META_NAME_RE.match(family):
        raise ValueError(f"invalid kv split family: {family!r}")
    return accounts.resolve_paths(account).kv_meta_dir / f"{family}.json"


def _kv_target_path(key: str, account: str = DEFAULT_ACCOUNT):
    """按键算落点：会话文件 / 族文件 / None＝主文件。"""
    key = str(key or "")
    split = _kv_split_session(key)
    if split is not None:
        return _kv_session_path(split[0], account)
    for prefix, family in _KV_FAMILY_PREFIXES.items():
        if key.startswith(prefix):
            return _kv_meta_path(family, account)
    family = _KV_SOLO_KEYS.get(key)
    if family is not None:
        return _kv_meta_path(family, account)
    return None


def kv_read(key: str, default=None, account: str = DEFAULT_ACCOUNT):
    """按键读 KV：会话键走 data/kv/<sid>.json，族/独键走 data/kv/meta/<族>.json，其余走主文件。"""
    paths = accounts.resolve_paths(account)
    path = _kv_target_path(key, account) or paths.kv_path
    data = _read_json(path, {})
    if isinstance(data, dict) and key in data:
        return data[key]
    return default


def kv_write(key: str, value, account: str = DEFAULT_ACCOUNT) -> None:
    """按键写 KV（upsert），自动路由到会话文件、族文件或主文件。"""
    paths = accounts.resolve_paths(account)
    path = _kv_target_path(key, account) or paths.kv_path

    def updater(data):
        data = dict(data) if isinstance(data, dict) else {}
        data[key] = value
        return data

    path.parent.mkdir(parents=True, exist_ok=True)
    _mutate_json(path, updater, default={})


def kv_delete(key: str, account: str = DEFAULT_ACCOUNT) -> None:
    """按键删 KV；拆分文件（会话/族）删空后移除文件本身（空 JSON 不是用户数据）。"""
    paths = accounts.resolve_paths(account)
    target = _kv_target_path(key, account)
    path = target if target is not None else paths.kv_path

    def updater(data):
        if not isinstance(data, dict) or key not in data:
            return None
        data = dict(data)
        data.pop(key, None)
        return data

    # T233：mutate＋空判＋unlink 必须整段持 _JSON_LOCK。_mutate_json 返回时锁已
    # 释放，此时到 unlink 之间有个窗口：并发 kv_write 往同一拆分层写入新键，
    # 外层再按「删完后读到的空 dict」判断就把整个文件 unlink 掉，新键一起蒸发。
    # _JSON_LOCK 是 RLock 且 updater 只做纯本地 dict 操作（不回调 kv_*），同线程
    # 二次拿锁安全，也没有再入死锁路径。
    with _JSON_LOCK:
        result = _mutate_json(path, updater, default={})
        if target is not None and isinstance(result, dict) and not result:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass


def kv_all_data(account: str = DEFAULT_ACCOUNT) -> dict:
    """全量合并视图（主文件 + 会话文件 + 族文件，拆分文件覆盖同名键）。

    备份导出与大陆投影等「要看到全部 KV」的场合用；拆分文件优先——它与
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
    if paths.kv_meta_dir.exists():
        for path in sorted(paths.kv_meta_dir.glob("*.json")):
            data = _read_json(path, {})
            if isinstance(data, dict):
                merged.update(data)
    return merged


def kv_migrate_split_keys(account: str = DEFAULT_ACCOUNT) -> int:
    """启动迁移：把主文件里的会话级键与族键搬进各自拆分文件，返回搬运键数。

    先写拆分文件、全部成功后才从主文件移除——中途失败下次启动幂等重跑。
    """
    paths = accounts.resolve_paths(account)
    main = _read_json(paths.kv_path, {})
    if not isinstance(main, dict):
        return 0
    groups = {}  # 目标路径 → {键: 值}
    for key, value in main.items():
        path = _kv_target_path(key, account)
        if path is not None:
            groups.setdefault(path, {})[key] = value
    if not groups:
        return 0
    for path, entries in groups.items():
        def updater(data, _entries=entries):
            data = dict(data) if isinstance(data, dict) else {}
            data.update(_entries)
            return data

        path.parent.mkdir(parents=True, exist_ok=True)
        _mutate_json(path, updater, default={})
    moved_keys = {key for entries in groups.values() for key in entries}

    def remove_moved(data):
        if not isinstance(data, dict):
            return None
        remaining = {k: v for k, v in data.items() if k not in moved_keys}
        return remaining if len(remaining) != len(data) else None

    _mutate_json(paths.kv_path, remove_moved)
    return len(moved_keys)


def kv_restore_bulk(data, replace: bool, account: str = DEFAULT_ACCOUNT) -> int:
    """备份导入：把一份 {键: 值} 按拆分路由落盘，返回导入键数。

    全局键合并进主文件（replace 时先清空）；会话键与族键按落点分组，合并进
    各自拆分文件（replace 时先清 data/kv/ 与 data/kv/meta/）。比逐键
    kv_write 少 O(n) 次全量写。
    """
    paths = accounts.resolve_paths(account)
    if not isinstance(data, dict):
        return 0
    groups = {}  # 目标路径 → {键: 值}
    for key, value in data.items():
        path = _kv_target_path(key, account) or paths.kv_path
        groups.setdefault(path, {})[key] = value
    if replace:
        paths.kv_path.parent.mkdir(parents=True, exist_ok=True)
        _write_json(paths.kv_path, {})
        for directory in (paths.kv_dir, paths.kv_meta_dir):
            if directory.exists():
                for p in directory.glob("*.json"):
                    p.unlink(missing_ok=True)
    if paths.kv_path in groups and not replace:
        existing = _read_json(paths.kv_path, {})
        groups[paths.kv_path] = {**(existing if isinstance(existing, dict) else {}),
                                 **groups[paths.kv_path]}
    for path, entries in groups.items():
        if path is paths.kv_path and replace:
            _write_json(paths.kv_path, entries)  # 上面已清空，直接落全局键
            continue

        def updater(d, _entries=entries):
            d = dict(d) if isinstance(d, dict) else {}
            d.update(_entries)
            return d

        path.parent.mkdir(parents=True, exist_ok=True)
        _mutate_json(path, updater, default={})
    return len(data)


__all__ = [
    "_read_json", "_write_json", "_mutate_json", "_delete_by_session",
    "_read_json_cached", "_invalidate_json_cache",
    "_get_messages_path", "_resolve_messages_path",
    "kv_read", "kv_write", "kv_delete", "kv_all_data",
    "kv_migrate_split_keys", "kv_restore_bulk",
]
