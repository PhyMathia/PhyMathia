"""数据备份导出与导入。"""

import time

from .config import FORMULAS_PATH, KNOWLEDGE_PATH, KV_PATH, MESSAGES_DIR, SESSIONS_PATH
from .knowledge import (
    _dedupe_formula_map,
    _dedupe_knowledge,
    _normalize_formula_map,
    _normalize_knowledge,
)
from .profile import PROFILES_DIR, save_profile
from .storage import _get_messages_path, _read_json, _write_json

def _build_backup_payload() -> dict:
    sessions = _read_json(SESSIONS_PATH, {})
    messages = {}
    for sid in sessions:
        if not isinstance(sessions[sid], dict):
            continue
        path = _get_messages_path(sid)
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
        if not sid:
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
        _write_json(_get_messages_path(sid), msgs)
        count += len(msgs)
    return count


def _restore_backup(backup: dict, replace: bool) -> dict:
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



__all__ = ["_build_backup_payload", "_restore_backup"]
