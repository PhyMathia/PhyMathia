"""数据备份导出与导入。"""

import os
import time
import uuid
from pathlib import Path

from .config import FORMULAS_PATH, KNOWLEDGE_PATH, KV_PATH, MESSAGES_DIR, SESSIONS_PATH
from .knowledge import (
    _dedupe_formula_map,
    _dedupe_knowledge,
    _normalize_formula_map,
    _normalize_knowledge,
)
from .profile import PROFILES_DIR, save_profile
from .storage import _SESSION_ID_RE, _get_messages_path, _invalidate_json_cache, _read_json, _write_json

def _build_backup_payload() -> dict:
    sessions = _read_json(SESSIONS_PATH, {})
    messages = {}
    for sid in sessions:
        if not isinstance(sessions[sid], dict):
            continue
        try:
            path = _get_messages_path(sid)
        except ValueError:
            # 历史脏键（非法 id 曾经能写进 sessions.json）：跳过而不是让
            # 整个导出 500——写入口已加同口径校验，这里只做纵深防御
            continue
        value = _read_json(path, [])
        messages[sid] = value if isinstance(value, list) else []
    for path in sorted(MESSAGES_DIR.glob("*.json")):
        sid = path.stem
        if sid in messages:
            continue
        value = _read_json(path, [])
        messages[sid] = value if isinstance(value, list) else []
    profiles = {}
    for path in sorted(PROFILES_DIR.glob("*.json")):
        value = _read_json(path, None)
        if isinstance(value, dict):
            profiles[path.stem] = value
    return {
        "version": 3,
        "exportedAt": time.time(),
        "sessions": sessions,
        "messages": messages,
        "knowledge": _read_json(KNOWLEDGE_PATH, {}),
        "formulas": _read_json(FORMULAS_PATH, {}),
        "kv": _read_json(KV_PATH, {}),
        "profiles": profiles,
    }


def _restore_sessions(data: dict, replace: bool) -> int:
    sessions = _read_json(SESSIONS_PATH, {})
    if replace:
        sessions = {}
    if not isinstance(data, (dict, list)):
        return 0
    count = 0
    entries = data.items() if isinstance(data, dict) else [(None, item) for item in data]
    for raw_key, sdata in entries:
        if not isinstance(sdata, dict):
            continue
        sid = str(sdata.get("id") or raw_key or "")
        # 导入侧同口径校验：非法 id 不落盘（否则一条脏键毒化 sessions.json，
        # 备份导出永久 500 且 DELETE 拒收删不掉）
        if not sid or not _SESSION_ID_RE.match(sid):
            continue
        now = int(time.time() * 1000)
        sessions[sid] = {
            "id": sid,
            "title": sdata.get("title", "新对话"),
            "icon": sdata.get("icon", ""),
            "sessionId": sdata.get("sessionId", ""),
            "createdAt": sdata.get("createdAt", now),
            "updatedAt": sdata.get("updatedAt", now),
        }
        count += 1
    _write_json(SESSIONS_PATH, sessions)
    return count


def _restore_messages(data: dict, sessions: dict, replace: bool) -> int:
    if replace:
        for path in MESSAGES_DIR.glob("*.json"):
            path.unlink(missing_ok=True)
    if not isinstance(data, dict):
        return 0
    alias_to_sid = {}
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId"):
            alias_to_sid[sdata["sessionId"]] = sid
    count = 0
    for raw_sid, msgs in data.items():
        sid = alias_to_sid.get(raw_sid, raw_sid)
        if not isinstance(msgs, list):
            continue
        try:
            msgs_path = _get_messages_path(sid)
        except ValueError:
            continue
        _write_json(msgs_path, msgs)
        count += len(msgs)
    return count


def _restore_target_paths() -> list:
    paths = [SESSIONS_PATH, KNOWLEDGE_PATH, FORMULAS_PATH, KV_PATH]
    paths.extend(sorted(MESSAGES_DIR.glob("*.json")))
    paths.extend(sorted(PROFILES_DIR.glob("*.json")))
    return paths


_SNAPSHOT_MISSING = object()


def _snapshot_restore_targets() -> dict:
    """读取完整快照；仅文件不存在可回滚删除，其他读取异常在写入前抛出。"""
    snap = {}
    for p in _restore_target_paths():
        try:
            snap[str(p)] = p.read_bytes()
        except FileNotFoundError:
            snap[str(p)] = _SNAPSHOT_MISSING
    return snap


def _rollback_restore_targets(snap: dict) -> list:
    """尽力把数据文件恢复到快照状态；返回仍然失败的目标名。"""
    failed = []
    for path_str, content in snap.items():
        p = Path(path_str)
        try:
            if content is _SNAPSHOT_MISSING:
                p.unlink(missing_ok=True)
            else:
                tmp = p.with_name(f".{p.name}.{uuid.uuid4().hex}.tmp")
                try:
                    tmp.write_bytes(content)
                    os.replace(tmp, p)
                finally:
                    if tmp.exists():
                        tmp.unlink()
            _invalidate_json_cache(p)
        except OSError:
            failed.append(p.name)
    # 恢复过程中新建、快照里不存在的文件也一并移除
    for p in _restore_target_paths():
        if str(p) not in snap:
            try:
                p.unlink(missing_ok=True)
                _invalidate_json_cache(p)
            except OSError:
                failed.append(p.name)
    return failed


def _restore_backup(backup: dict, replace: bool) -> dict:
    # 恢复按 sessions→消息→知识→公式→kv→画像 依次落盘，中途异常（文件被占用/
    # 磁盘满）会留下半恢复状态。这里先做内容级快照，任一环节失败即整体回滚。
    snapshot = _snapshot_restore_targets()
    try:
        return _apply_restore(backup, replace)
    except Exception as exc:
        rollback_failed = _rollback_restore_targets(snapshot)
        detail = f"恢复失败，已回滚到导入前状态：{exc}"
        if rollback_failed:
            detail += f"；以下文件回滚仍失败，请手动检查：{', '.join(rollback_failed)}"
        raise RuntimeError(detail) from exc


def _apply_restore(backup: dict, replace: bool) -> dict:
    sessions = backup.get("sessions") or {}
    session_count = _restore_sessions(sessions, replace)
    saved_sessions = _read_json(SESSIONS_PATH, {})
    message_count = _restore_messages(backup.get("messages") or {}, saved_sessions, replace)

    knowledge = _normalize_knowledge(backup.get("knowledge") or {})
    if replace:
        _write_json(KNOWLEDGE_PATH, {})
        _write_json(FORMULAS_PATH, {})
        _write_json(KV_PATH, {})
    if knowledge:
        existing_knowledge = _read_json(KNOWLEDGE_PATH, {})
        _write_json(KNOWLEDGE_PATH, _dedupe_knowledge({**existing_knowledge, **knowledge}))

    formulas = _normalize_formula_map(backup.get("formulas") or {})
    if formulas:
        existing_formulas = _read_json(FORMULAS_PATH, {})
        _write_json(FORMULAS_PATH, _dedupe_formula_map({**existing_formulas, **formulas}))

    kv_data = backup.get("kv") or {}
    if isinstance(kv_data, dict):
        existing_kv = {} if replace else _read_json(KV_PATH, {})
        _write_json(KV_PATH, {**existing_kv, **kv_data})

    profiles = backup.get("profiles") or {}
    profile_count = 0
    if isinstance(profiles, dict) and profiles:
        if replace:
            for p in PROFILES_DIR.glob("*.json"):
                p.unlink(missing_ok=True)
        for device_id, pdata in profiles.items():
            if isinstance(pdata, dict):
                save_profile(str(device_id), pdata)
                profile_count += 1

    return {
        "ok": True,
        "sessions": session_count,
        "messages": message_count,
        "knowledge": len(knowledge),
        "formulas": len(formulas),
        "kv": len(kv_data) if isinstance(kv_data, dict) else 0,
        "profiles": profile_count,
    }



__all__ = [
    "_build_backup_payload",
    "_restore_backup",
    "_apply_restore",
    "_snapshot_restore_targets",
    "_rollback_restore_targets",
]
