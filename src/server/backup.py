"""数据备份导出与导入。"""

import math
import os
import re
import time
import uuid
from pathlib import Path

from . import accounts, config, trash
from .accounts import DEFAULT_ACCOUNT
from .context import _merge_message_fields, _message_identity, merge_message_lists
from .knowledge import (
    _dedupe_formula_map,
    _dedupe_knowledge,
    _normalize_formula_map,
    _normalize_knowledge,
    _strip_nonfinite_ts,
)
from .profile import PROFILES_DIR, device_key as _device_key, save_profile
from .storage import (
    _SESSION_ID_RE,
    _get_messages_path,
    _invalidate_json_cache,
    _read_json,
    _write_json,
    kv_all_data,
    kv_restore_bulk,
)

def _account_profile_keys(account: str = DEFAULT_ACCOUNT, device_id: str = "") -> set | None:
    """账号的画像归属键集合（注册表绑定 ∪ 请求设备提示）。

    None＝归属完全未知（账号从未有过画像活动、请求也没带 device_id）→ 调用方
    回退旧口径（画像全量），兼容既有调用与 curl 直调；浏览器请求恒带
    device_id（2026-10-07 起前端备份两路由补传），正常路径不会是 None。
    """
    keys = set(accounts.account_devices(account))
    if device_id:
        hint = _device_key(device_id)
        if hint:
            keys.add(hint)
    return keys or None


_AUTO_BACKUP_KEEP = 10
_AUTO_BACKUP_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
# 备份画布桶（顶层 graphs/graphHistories）的 sid 白名单，与 storage._SESSION_ID_RE
# 同口径（kv 拆分落盘另有同款白名单，这里前置过滤是让手编备份的脏键直接丢弃）
_BACKUP_SID_RE = re.compile(r"[A-Za-z0-9_-]+")


def _finite_ts(value) -> float:
    """把时间戳字段归一成有限浮点；布尔/非数值/NaN/Inf 一律 0。"""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if math.isfinite(number) else 0.0


def _item_ts(item) -> float:
    """条目更新时间：updatedAt 优先、createdAt 兜底；非数值/非有限一律 0。

    备份合并按它取新（583/584）：手编或旧版条目可能缺字段，缺时间戳时
    不能拿「新备份」的身份去覆盖同 id 的现有条目。
    """
    if not isinstance(item, dict):
        return 0.0
    for field in ("updatedAt", "createdAt"):
        number = _finite_ts(item.get(field))
        if number:
            return number
    return 0.0


def _message_ts(message) -> float:
    """消息时间戳（毫秒）；缺字段时 0。仅用于逐项选择列表的展示与排序。"""
    if not isinstance(message, dict):
        return 0.0
    return _finite_ts(message.get("timestamp"))


def _conflict_text(value, limit: int = 80) -> str:
    """冲突列表的单行标签：压空白、截断，避免手编备份里的超长文本撑爆预览。"""
    text = " ".join(str(value or "").split())
    return text[:limit] + ("…" if len(text) > limit else "")


def _message_conflict_label(message) -> str:
    role = {"user": "我", "assistant": "AI"}.get(
        str((message or {}).get("role") or ""), str((message or {}).get("role") or "消息"))
    return role + "：" + _conflict_text((message or {}).get("content"), 60)


def _normalize_decisions(raw) -> dict:
    """逐项选择的用户决定：{类型: {条目 id: "backup"|"current"}}。

    未出现的条目沿用「保留较新」——只把用户明确翻面的条目传上来，
    预览里有上千项时请求体仍然很小。
    """
    out = {}
    if not isinstance(raw, dict):
        return out
    for kind in ("sessions", "messages", "knowledge", "formulas", "graphs"):
        part = raw.get(kind)
        if not isinstance(part, dict):
            continue
        chosen = {}
        for key, value in part.items():
            if value in ("backup", "current"):
                chosen[str(key)] = value
        if chosen:
            out[kind] = chosen
    return out


def _manual_side(decisions: dict, kind: str, key: str) -> str | None:
    part = decisions.get(kind) if isinstance(decisions, dict) else None
    if not isinstance(part, dict):
        return None
    value = part.get(str(key))
    return value if value in ("backup", "current") else None


def _sessions_map(data) -> dict:
    """sessions 两吃（dict / 旧版数组），只保留对象值。"""
    if isinstance(data, dict):
        return {str(k): v for k, v in data.items() if isinstance(v, dict)}
    if isinstance(data, list):
        out = {}
        for item in data:
            if not isinstance(item, dict):
                continue
            sid = str(item.get("id") or "")
            if sid:
                out[sid] = item
        return out
    return {}


def _payload_counts(payload: dict) -> dict:
    sessions = _sessions_map(payload.get("sessions"))
    messages = payload.get("messages") if isinstance(payload.get("messages"), dict) else {}
    knowledge = _normalize_knowledge(payload.get("knowledge") or {})
    formulas = _normalize_formula_map(payload.get("formulas") or {})
    kv = payload.get("kv") if isinstance(payload.get("kv"), dict) else {}
    profiles = payload.get("profiles") if isinstance(payload.get("profiles"), dict) else {}
    return {
        "sessions": len(sessions),
        "messages": sum(len(v) for v in messages.values() if isinstance(v, list)),
        "knowledge": len(knowledge),
        "formulas": len(formulas),
        "graphs": sum(1 for key in kv if str(key).startswith("graph:")),
        "profiles": len(profiles),
        "kv": len(kv),
    }


def _message_overlap(current_msgs, incoming_msgs) -> int:
    if not isinstance(current_msgs, list) or not isinstance(incoming_msgs, list):
        return 0
    keys = set()
    for msg in current_msgs:
        if isinstance(msg, dict):
            keys.add(_message_identity(msg))
    return sum(1 for msg in incoming_msgs
               if isinstance(msg, dict) and _message_identity(msg) in keys)


def _preview_backup(backup: dict, replace: bool, account: str = DEFAULT_ACCOUNT,
                    device_id: str = None, conflict: str = "newer") -> dict:
    """导入预览：只读，不改任何文件。条数 + 同名冲突 + 备份里较旧的条数。

    预览与真正导入分开，前端先给用户看「会动多少、哪些会被较旧备份盖回去」，
    再让用户确认（583 的确认＋自动备份前置）。逐项选择（manual）额外返回
    内容确有差异的冲突条目清单，供前端逐项翻面；相同条目不需要判断，不列。
    """
    current = _build_backup_payload(account, device_id)
    incoming = backup if isinstance(backup, dict) else {}
    effective_conflict = "backup" if replace else (
        conflict if conflict in ("backup", "manual") else "newer")

    cur_sessions = _sessions_map(current.get("sessions"))
    inc_sessions = _sessions_map(incoming.get("sessions"))
    session_ids = set(cur_sessions) & set(inc_sessions)

    cur_msgs = current.get("messages") if isinstance(current.get("messages"), dict) else {}
    inc_msgs = incoming.get("messages") if isinstance(incoming.get("messages"), dict) else {}
    msg_overlap = 0
    for sid in set(cur_msgs) & set(inc_msgs):
        msg_overlap += _message_overlap(cur_msgs.get(sid), inc_msgs.get(sid))

    cur_knowledge = _normalize_knowledge(current.get("knowledge") or {})
    inc_knowledge = _normalize_knowledge(incoming.get("knowledge") or {})
    knowledge_ids = set(cur_knowledge) & set(inc_knowledge)

    cur_formulas = _normalize_formula_map(current.get("formulas") or {})
    inc_formulas = _normalize_formula_map(incoming.get("formulas") or {})
    formula_ids = set(cur_formulas) & set(inc_formulas)

    cur_kv = current.get("kv") if isinstance(current.get("kv"), dict) else {}
    inc_kv = incoming.get("kv") if isinstance(incoming.get("kv"), dict) else {}
    graph_keys = {str(k) for k in inc_kv if str(k).startswith("graph:")} & \
                 {str(k) for k in cur_kv if str(k).startswith("graph:")}

    items = []
    if effective_conflict == "manual":
        def add_item(kind, item_id, label, current_label, current_ts, backup_ts):
            entry = {
                "kind": kind,
                "id": item_id,
                "label": label or "",
                "currentTs": current_ts,
                "backupTs": backup_ts,
            }
            if current_label and current_label != label:
                entry["currentLabel"] = current_label
            items.append(entry)

        session_titles = {}
        for source in (cur_sessions, inc_sessions):
            for sid, session in source.items():
                title = session.get("title") if isinstance(session, dict) else None
                if title:
                    session_titles[sid] = str(title)

        for sid in session_ids:
            cur = cur_sessions.get(sid) or {}
            inc = inc_sessions.get(sid) or {}
            if cur == inc:
                continue
            add_item("sessions", sid, _conflict_text(inc.get("title") or sid),
                     _conflict_text(cur.get("title") or sid),
                     _item_ts(cur), _item_ts(inc))

        for sid in sorted(set(cur_msgs) & set(inc_msgs)):
            cur_list = cur_msgs.get(sid)
            inc_list = inc_msgs.get(sid)
            if not isinstance(cur_list, list) or not isinstance(inc_list, list):
                continue
            cur_by_id = {_message_identity(msg): msg for msg in cur_list if isinstance(msg, dict)}
            inc_by_id = {_message_identity(msg): msg for msg in inc_list if isinstance(msg, dict)}
            for identity in set(cur_by_id) & set(inc_by_id):
                cur = cur_by_id[identity]
                inc = inc_by_id[identity]
                if cur == inc:
                    continue
                add_item("messages", str(sid) + "|" + identity,
                         _message_conflict_label(inc), _message_conflict_label(cur),
                         _message_ts(cur), _message_ts(inc))

        for kid in knowledge_ids:
            cur = cur_knowledge.get(kid) or {}
            inc = inc_knowledge.get(kid) or {}
            if cur == inc:
                continue
            add_item("knowledge", kid,
                     _conflict_text(inc.get("title") or inc.get("concept") or kid),
                     _conflict_text(cur.get("title") or cur.get("concept") or kid),
                     _item_ts(cur), _item_ts(inc))

        for fid in formula_ids:
            cur = cur_formulas.get(fid) or {}
            inc = inc_formulas.get(fid) or {}
            if cur == inc:
                continue
            add_item("formulas", fid,
                     _conflict_text(inc.get("latex") or inc.get("concept") or fid),
                     _conflict_text(cur.get("latex") or cur.get("concept") or fid),
                     _item_ts(cur), _item_ts(inc))

        for key in graph_keys:
            cur = cur_kv.get(key) or {}
            inc = inc_kv.get(key) or {}
            if cur == inc:
                continue
            sid = key[len("graph:"):]
            label = _conflict_text(session_titles.get(sid) or sid)
            add_item("graphs", key, label, label, _item_ts(cur), _item_ts(inc))

        kind_order = {"sessions": 0, "messages": 1, "knowledge": 2, "formulas": 3, "graphs": 4}
        items.sort(key=lambda item: (
            kind_order.get(item["kind"], 9),
            -max(item["currentTs"], item["backupTs"]),
            item["label"],
        ))

    result = {
        "ok": True,
        "mode": "replace" if replace else "merge",
        "conflict": effective_conflict,
        "serverAvailable": True,
        "incoming": _payload_counts(incoming),
        "current": _payload_counts(current),
        "conflicts": {
            "sessions": len(session_ids),
            "messages": msg_overlap,
            "knowledge": len(knowledge_ids),
            "formulas": len(formula_ids),
            "graphs": len(graph_keys),
            "olderInBackup": {
                "sessions": sum(1 for sid in session_ids
                                if _item_ts(inc_sessions.get(sid)) < _item_ts(cur_sessions.get(sid))),
                "knowledge": sum(1 for kid in knowledge_ids
                                 if _item_ts(inc_knowledge.get(kid)) < _item_ts(cur_knowledge.get(kid))),
                "formulas": sum(1 for fid in formula_ids
                                if _item_ts(inc_formulas.get(fid)) < _item_ts(cur_formulas.get(fid))),
                "graphs": sum(1 for key in graph_keys
                              if _item_ts(inc_kv.get(key)) < _item_ts(cur_kv.get(key))),
            },
        },
    }
    if effective_conflict == "manual":
        result["items"] = items
    return result


def _backup_dir(account: str = DEFAULT_ACCOUNT) -> Path:
    return Path(config.DATA_DIR) / "backups" / accounts.validate_account_id(account)


def _auto_backup_reason(stem: str) -> str:
    parts = str(stem or "").split("-")
    return parts[2] if len(parts) > 2 else "backup"


def _prune_auto_backups(directory: Path) -> None:
    files = [p for p in directory.glob("*.json") if _AUTO_BACKUP_ID_RE.match(p.stem)]
    files.sort(key=lambda p: p.stem, reverse=True)
    for path in files[_AUTO_BACKUP_KEEP:]:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def create_auto_backup(account: str = DEFAULT_ACCOUNT, device_id: str = None,
                       reason: str = "import") -> dict:
    """导入/恢复前把当前账号数据落到 data/backups/<账号>/（保留最近 10 份）。

    失败直接抛给调用方：备份没写成就不该继续做破坏性写入。
    """
    reason = re.sub(r"[^a-z0-9_-]", "", str(reason or "import").lower())[:24] or "import"
    payload = _build_backup_payload(account, device_id)
    payload["backupReason"] = reason
    payload["backupCreatedAt"] = time.time()
    directory = _backup_dir(account)
    directory.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    backup_id = f"{stamp}-{reason}-{uuid.uuid4().hex[:6]}"
    path = directory / (backup_id + ".json")
    _write_json(path, payload)
    _prune_auto_backups(directory)
    stat = path.stat()
    return {
        "id": backup_id,
        "createdAt": int(stat.st_mtime * 1000),
        "size": stat.st_size,
        "reason": reason,
        "counts": _payload_counts(payload),
    }


def list_auto_backups(account: str = DEFAULT_ACCOUNT) -> list:
    directory = _backup_dir(account)
    if not directory.exists():
        return []
    out = []
    for path in directory.glob("*.json"):
        if not _AUTO_BACKUP_ID_RE.match(path.stem):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        out.append({
            "id": path.stem,
            "createdAt": int(stat.st_mtime * 1000),
            "size": stat.st_size,
            "reason": _auto_backup_reason(path.stem),
        })
    out.sort(key=lambda item: item["id"], reverse=True)
    return out


def read_auto_backup(account: str = DEFAULT_ACCOUNT, backup_id: str = "") -> dict:
    """按 id 读一份自动备份；id 白名单校验防路径穿越。"""
    text = str(backup_id or "")
    if not _AUTO_BACKUP_ID_RE.match(text):
        raise ValueError("备份 id 不合法")
    path = _backup_dir(account) / (text + ".json")
    payload = _read_json(path, None)
    if not isinstance(payload, dict):
        raise FileNotFoundError("备份不存在")
    return payload


def _build_backup_payload(account: str = DEFAULT_ACCOUNT, device_id: str = None) -> dict:
    paths = accounts.resolve_paths(account)
    sessions = _read_json(paths.sessions_path, {})
    messages = {}
    for sid in sessions:
        if not isinstance(sessions[sid], dict):
            continue
        try:
            path = _get_messages_path(sid, account)
        except ValueError:
            # 历史脏键（非法 id 曾经能写进 sessions.json）：跳过而不是让
            # 整个导出 500——写入口已加同口径校验，这里只做纵深防御
            continue
        value = _read_json(path, [])
        messages[sid] = value if isinstance(value, list) else []
    for path in sorted(paths.messages_dir.glob("*.json")):
        sid = path.stem
        if sid in messages:
            continue
        value = _read_json(path, [])
        messages[sid] = value if isinstance(value, list) else []
    profiles = {}
    # 画像按账号隔离（2026-10-07）：只带走本账号归属的设备画像——旧口径全量
    # 打包会把邻账号的画像一并塞进备份文件、恢复时还会覆盖对方（A 的备份
    # 回滚 B 的画像）。归属未知（无绑定且无设备提示）时回退全量兼容旧调用。
    profile_keys = _account_profile_keys(account, device_id)
    for path in sorted(PROFILES_DIR.glob("*.json")):
        if profile_keys is not None and path.stem not in profile_keys:
            continue
        value = _read_json(path, None)
        if isinstance(value, dict):
            profiles[path.stem] = value
    return {
        "version": 3,
        "exportedAt": time.time(),
        "sessions": sessions,
        "messages": messages,
        "knowledge": _read_json(paths.knowledge_path, {}),
        "formulas": _read_json(paths.formulas_path, {}),
        # 合并视图：主文件 + data/kv/ 会话文件（graph:<sid> 等会话键已拆分存放）
        "kv": kv_all_data(account),
        "profiles": profiles,
    }


def _restore_sessions(data: dict, replace: bool, account: str = DEFAULT_ACCOUNT,
                      conflict: str = "newer", decisions: dict = None) -> int:
    paths = accounts.resolve_paths(account)
    existing = _read_json(paths.sessions_path, {})
    sessions = {} if replace or not isinstance(existing, dict) else existing
    if not isinstance(data, (dict, list)):
        return 0
    count = 0
    restored = []
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
        incoming = {
            "id": sid,
            "title": sdata.get("title", "新对话"),
            "icon": sdata.get("icon", ""),
            "sessionId": sdata.get("sessionId", ""),
            "createdAt": sdata.get("createdAt", now),
            "updatedAt": sdata.get("updatedAt", now),
        }
        # 584：合并模式下同名会话按 updatedAt 取新——旧设备/旧缓存导出的备份
        # 不能把服务端后来改过的标题与活动时间盖回去。replace 与显式「以备份
        # 为准」仍按备份写。逐项选择（manual）只在用户明确翻面的条目上偏离
        # 较新规则，其余仍按时间取新。
        current = sessions.get(sid)
        side = _manual_side(decisions or {}, "sessions", sid) if conflict == "manual" else None
        if not replace and conflict != "backup":
            if side == "current" and isinstance(current, dict):
                continue
            if side != "backup" and isinstance(current, dict) \
                    and _item_ts(current) > _item_ts(incoming):
                continue
        sessions[sid] = incoming
        count += 1
        restored.append(sid)
    paths.sessions_path.parent.mkdir(parents=True, exist_ok=True)
    _write_json(paths.sessions_path, sessions)
    # T271：恢复出的会话若还在「已删登记表」里，同步除名——否则恢复后改名/推
    # 消息/同步全被墓碑闸门拒收（备份导入是用户明确要回来的数据，等同回收站恢复）。
    # 只清本次导入新增的 id：存量活会话不在册，逐个空写一遍纯浪费
    for sid in restored:
        trash.tombstone_unregister(paths, sid)
    return count


def _restore_messages(data: dict, sessions: dict, replace: bool, account: str = DEFAULT_ACCOUNT,
                      conflict: str = "newer", decisions: dict = None) -> int:
    paths = accounts.resolve_paths(account)
    if replace:
        paths.messages_dir.mkdir(parents=True, exist_ok=True)
        for path in paths.messages_dir.glob("*.json"):
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
            msgs_path = _get_messages_path(sid, account)
        except ValueError:
            continue
        if replace:
            final_msgs = msgs
        else:
            # 584：消息按时间戳逐条合并，而不是整份覆盖。默认现有服务端数据
            # 在前（内容冲突时现有版本赢）；用户显式选「以备份为准」时备份在前。
            existing = _read_json(msgs_path, [])
            if not isinstance(existing, list):
                existing = []
            if conflict == "backup":
                final_msgs = merge_message_lists(msgs, existing)
            elif conflict == "manual":
                final_msgs = merge_message_lists(existing, msgs)
                overrides = (decisions or {}).get("messages") or {}
                if isinstance(overrides, dict) and overrides:
                    cur_by_id = {_message_identity(msg): msg
                                 for msg in existing if isinstance(msg, dict)}
                    inc_by_id = {_message_identity(msg): msg
                                 for msg in msgs if isinstance(msg, dict)}
                    rebuilt = []
                    for msg in final_msgs:
                        identity = _message_identity(msg)
                        side = overrides.get(str(raw_sid) + "|" + identity)
                        if side is None and sid != raw_sid:
                            side = overrides.get(str(sid) + "|" + identity)
                        if side == "backup" and identity in inc_by_id:
                            rebuilt.append(_merge_message_fields(
                                inc_by_id[identity], cur_by_id.get(identity, {})))
                        elif side == "current" and identity in cur_by_id:
                            rebuilt.append(_merge_message_fields(
                                cur_by_id[identity], inc_by_id.get(identity, {})))
                        else:
                            rebuilt.append(msg)
                    final_msgs = rebuilt
            else:
                final_msgs = merge_message_lists(existing, msgs)
        _write_json(msgs_path, final_msgs)
        count += len(final_msgs)
    return count


def _restore_target_paths(account: str = DEFAULT_ACCOUNT) -> list:
    p = accounts.resolve_paths(account)
    paths = [p.sessions_path, p.knowledge_path, p.formulas_path, p.kv_path]
    paths.extend(sorted(p.messages_dir.glob("*.json")))
    # 画像按账号隔离（T189）：快照与回滚枚举只覆盖本账号归属的画像——回滚第二
    # 段「快照外新文件一并移除」用同一枚举，不过滤会把导入窗口内邻账号新建的
    # 画像误删；归属未知（无绑定）回退全量，与导出/replace 清理同口径。
    profile_keys = _account_profile_keys(account, None)
    for path in sorted(PROFILES_DIR.glob("*.json")):
        if profile_keys is not None and path.stem not in profile_keys:
            continue
        paths.append(path)
    # 会话级 KV 拆分文件也是恢复目标：回滚与「新建文件清理」都必须覆盖
    if p.kv_dir.exists():
        paths.extend(sorted(p.kv_dir.glob("*.json")))
    # 族拆分文件（socratic/mem/quiz/continent）同理
    if p.kv_meta_dir.exists():
        paths.extend(sorted(p.kv_meta_dir.glob("*.json")))
    return paths


_SNAPSHOT_MISSING = object()


def _snapshot_restore_targets(account: str = DEFAULT_ACCOUNT) -> dict:
    """读取完整快照；仅文件不存在可回滚删除，其他读取异常在写入前抛出。"""
    snap = {}
    for p in _restore_target_paths(account):
        try:
            snap[str(p)] = p.read_bytes()
        except FileNotFoundError:
            snap[str(p)] = _SNAPSHOT_MISSING
    return snap


def _rollback_restore_targets(snap: dict, account: str = DEFAULT_ACCOUNT) -> list:
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
    # 恢复过程中新建、快照里不存在的文件也一并移除（account 必须传：漏传会
    # 按默认账号枚举，误删邻账号在恢复窗口内新建的文件）
    for p in _restore_target_paths(account):
        if str(p) not in snap:
            try:
                p.unlink(missing_ok=True)
                _invalidate_json_cache(p)
            except OSError:
                failed.append(p.name)
    return failed


def _restore_backup(backup: dict, replace: bool, account: str = DEFAULT_ACCOUNT,
                    device_id: str = None, conflict: str = "newer",
                    decisions: dict = None) -> dict:
    # 恢复按 sessions→消息→知识→公式→kv→画像 依次落盘，中途异常（文件被占用/
    # 磁盘满）会留下半恢复状态。这里先做内容级快照，任一环节失败即整体回滚。
    # 决定只在逐项选择模式下生效——newer/backup 收到 decisions 也不改口径
    # （旧客户端或手改请求不该借此越过「保留较新」）。
    decisions = _normalize_decisions(decisions) if conflict == "manual" else {}
    snapshot = _snapshot_restore_targets(account)
    try:
        return _apply_restore(backup, replace, account=account, device_id=device_id,
                              conflict=conflict, decisions=decisions)
    except Exception as exc:
        rollback_failed = _rollback_restore_targets(snapshot, account)
        detail = f"恢复失败，已回滚到导入前状态：{exc}"
        if rollback_failed:
            detail += f"；以下文件回滚仍失败，请手动检查：{', '.join(rollback_failed)}"
        raise RuntimeError(detail) from exc


def _apply_restore(backup: dict, replace: bool, account: str = DEFAULT_ACCOUNT,
                   device_id: str = None, conflict: str = "newer",
                   decisions: dict = None) -> dict:
    paths = accounts.resolve_paths(account)
    decisions = _normalize_decisions(decisions) if conflict == "manual" else {}
    sessions = backup.get("sessions") or {}
    session_count = _restore_sessions(sessions, replace, account, conflict=conflict,
                                      decisions=decisions)
    saved_sessions = _read_json(paths.sessions_path, {})
    message_count = _restore_messages(backup.get("messages") or {}, saved_sessions, replace,
                                      account, conflict=conflict, decisions=decisions)

    knowledge = _normalize_knowledge(backup.get("knowledge") or {})
    # 手编备份 JSON 能带 NaN/Infinity（json.loads 收得进）——恢复回写前统一落
    # 当前毫秒，否则 GET 响应体从恢复那刻起持续非法（浏览器 JSON.parse 全炸）
    _restore_now_ms = int(time.time() * 1000)
    for _it in knowledge.values():
        if isinstance(_it, dict):
            _strip_nonfinite_ts(_it, _restore_now_ms)
    if replace:
        for target in (paths.knowledge_path, paths.formulas_path, paths.kv_path):
            target.parent.mkdir(parents=True, exist_ok=True)
            _write_json(target, {})
    if knowledge:
        existing_knowledge = _read_json(paths.knowledge_path, {})
        if not isinstance(existing_knowledge, dict):
            existing_knowledge = {}
        merged_knowledge = dict(existing_knowledge)
        for item_id, item in knowledge.items():
            current = merged_knowledge.get(item_id)
            # 584：合并时同 id 按 updatedAt/createdAt 取新；备份版本更旧就保留
            # 现有条目。replace 与「以备份为准」仍直接写备份版本；逐项选择
            # 只覆盖用户明确翻面的条目。
            side = _manual_side(decisions, "knowledge", item_id)
            if not replace and conflict != "backup":
                if side == "current" and isinstance(current, dict):
                    continue
                if side != "backup" and isinstance(current, dict) \
                        and _item_ts(current) > _item_ts(item):
                    continue
            merged_knowledge[item_id] = item
        _write_json(paths.knowledge_path, _dedupe_knowledge(merged_knowledge))
        # 备份导入是用户明确要回来的数据，等同回收站恢复（会话侧 T271 同款纪律）：
        # 恢复条目若还在条目级墓碑登记表里，同步除名——否则下一轮 15 秒同步的
        # POST 闸门/残留自愈会按「删前时间戳 ≤ 删除时刻」把刚恢复的条目二次清除
        trash.knowledge_tombstone_unregister(paths, list(knowledge.keys()))

    formulas = _normalize_formula_map(backup.get("formulas") or {})
    for _it in formulas.values():
        if isinstance(_it, dict):
            _strip_nonfinite_ts(_it, _restore_now_ms)
    if formulas:
        existing_formulas = _read_json(paths.formulas_path, {})
        if not isinstance(existing_formulas, dict):
            existing_formulas = {}
        merged_formulas = dict(existing_formulas)
        for item_id, item in formulas.items():
            current = merged_formulas.get(item_id)
            side = _manual_side(decisions, "formulas", item_id)
            if not replace and conflict != "backup":
                if side == "current" and isinstance(current, dict):
                    continue
                if side != "backup" and isinstance(current, dict) \
                        and _item_ts(current) > _item_ts(item):
                    continue
            merged_formulas[item_id] = item
        _write_json(paths.formulas_path, _dedupe_formula_map(merged_formulas))
        trash.formula_tombstone_unregister(paths, list(formulas.keys()))

    kv_data = backup.get("kv") or {}
    # 浏览器导出的备份把画布放顶层 graphs/graphHistories 桶（本机 localStorage 键
    # 拆出来的），服务端 kv 里对应 graph:<sid>/graph_history:<sid>。此前恢复只认
    # kv——浏览器导出的备份在线导入时画布内容不入服务端存档，只活在本机缓存那
    # 一份（2026-11-24 实测：本机缓存被配额满卡掉时画布内容就丢了）。折进 kv 后
    # 与 kv 内 graph: 键同走下方 584 合并/replace 口径；sid 白名单与前端导入同款
    # （^[A-Za-z0-9_-]+$，防手编备份借键名搞路径花样），history_ 前缀旧备份按
    # 前端导入同款归位到 graph_history。
    graphs_bucket = backup.get("graphs") if isinstance(backup.get("graphs"), dict) else {}
    for _sid, _state in graphs_bucket.items():
        _s = str(_sid)
        if not _BACKUP_SID_RE.fullmatch(_s):
            continue
        if _s.startswith("history_"):
            if isinstance(_state, list):
                kv_data.setdefault("graph_history:" + _s[len("history_"):], _state)
            continue
        if isinstance(_state, dict):
            kv_data.setdefault("graph:" + _s, _state)
    histories_bucket = backup.get("graphHistories") if isinstance(backup.get("graphHistories"), dict) else {}
    for _sid, _env in histories_bucket.items():
        _s = str(_sid)
        if _BACKUP_SID_RE.fullmatch(_s) and isinstance(_env, (list, dict)):
            kv_data.setdefault("graph_history:" + _s, _env)
    if isinstance(kv_data, dict):
        if not replace and conflict != "backup":
            # 584：画布状态按 updatedAt 取新；graph_history 信封按 t（保存时刻）
            # 取新。备份里更旧的状态不覆盖当前画布，避免旧设备回滚新图。
            existing_kv = kv_all_data(account)
            filtered_kv = {}
            for key, value in kv_data.items():
                current = existing_kv.get(key)
                side = _manual_side(decisions, "graphs", key)
                if side == "current" and isinstance(current, dict):
                    continue
                if side != "backup" and isinstance(current, dict) and isinstance(value, dict):
                    if str(key).startswith("graph:") and _item_ts(current) > _item_ts(value):
                        continue
                    if (str(key).startswith("graph_history:")
                            and _item_ts({"updatedAt": current.get("t")})
                            > _item_ts({"updatedAt": value.get("t")})):
                        continue
                filtered_kv[key] = value
            kv_data = filtered_kv
        # 拆分路由落盘：全局键合并主文件、会话键按 sid 进 data/kv/；replace 先清两边
        kv_restore_bulk(kv_data, replace, account)

    profiles = backup.get("profiles") or {}
    profile_count = 0
    if isinstance(profiles, dict) and profiles:
        # 画像按账号隔离（2026-10-07）：replace 只清本账号归属的画像文件（旧
        # 口径全删会把邻账号的画像一并抹掉）；备份里不属本账号的设备画像
        # （旧版全量备份会带）不写回——那是对别人的快照，恢复它＝回滚对方。
        # 归属未知（无绑定且无设备提示）时回退旧口径兼容。
        profile_keys = _account_profile_keys(account, device_id)
        if replace:
            for p in PROFILES_DIR.glob("*.json"):
                if profile_keys is None or p.stem in profile_keys:
                    p.unlink(missing_ok=True)
        for dev, pdata in profiles.items():
            if profile_keys is not None and dev not in profile_keys:
                continue
            if isinstance(pdata, dict):
                save_profile(str(dev), pdata)
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
    "_preview_backup",
    "create_auto_backup",
    "list_auto_backups",
    "read_auto_backup",
]
