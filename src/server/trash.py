"""回收站（2026-10-07）：会话删除先整体快照进站，保留期内可恢复。

设计拍板（与当日日志「文件清单」节的声明一致）：
- 粒度＝会话（画布）。单删与清空全部两类入口在动手毁数据前先快照；快照抛
  异常时调用方（删除路由）必须中止删除——「防误删」的前提是删了还能回来，
  宁可让请求 500 也不能不可恢复地丢数据。
- 捕获集＝删除链路真正会抹掉的数据：sessions.json 条目、messages/<sid>.json、
  知识/公式里「本会话是唯一归属」的条目（共享条目只会被摘除归属而存活，
  见 knowledge._delete_items_by_session）、kv/<sid>.json（探索网快照：
  graph:/harness_history:/graph_history: 拆分键，storage._KV_SESSION_PREFIXES）、
  socratic: 状态键、quiz 统计与题库里本会话的条目（这几样由前端在删除返回后
  才清 kv，捕获点在 DELETE /api/sessions/{sid} 内、早于前端清理，所以还在）。
- 刻意不捕获：滚动记忆（kv 派生键，有代次失效机制，恢复后按消息自动重建）、
  continent_edges（跨会话投影，知识大陆会按恢复后的知识重新投影）。
- 目录布局：data/users/<账号>/trash/<sid>/，meta.json 最后落盘＝条目完整性
  标志（列表/恢复/彻底删除只认有 meta 的目录，半写入的孤儿目录不会被列出，
  且过期后会被过期清理顺手扫掉）。
- purgeAt 在入站时刻按当时保留天数算死；之后改保留天数只影响以后入站的
  条目（面板文案如实标注）。列表与启动时惰性清过期。
- 保留天数 0＝关闭回收站：capture 直接返回 False，删除走原链路（不留任何
  快照）；确认弹窗文案在前端按本地缓存的保留天数随之变化。
"""

import json
import logging
import re
import shutil
import time
from pathlib import Path

from server import accounts, context, storage

logger = logging.getLogger(__name__)

TRASH_DIR_NAME = "trash"
_META_NAME = "meta.json"

# 与 storage._SESSION_ID_RE 同款白名单：item id / 会话形态变体都要拼文件路径，
# 杜绝路径分隔符与 Windows 反斜杠穿越
_ITEM_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# quiz 全局 kv 键（与前端 QUIZ_STATS_KEY / phymathia_quiz_bank 一字对应）
QUIZ_STATS_KV_KEY = "phymathia_quiz_stats"
QUIZ_BANK_KV_KEY = "phymathia_quiz_bank"

_DAY_MS = 86_400_000


class TrashConflictError(Exception):
    """恢复目标会话 id 已被现存会话占用（随机 id 下实际几乎不可达，防御位）。"""


def trash_root(paths: accounts.AccountPaths) -> Path:
    return paths.root / TRASH_DIR_NAME


def retention_days(account: str) -> int:
    return accounts.get_trash_retention(account)


def set_retention_days(account: str, days) -> int:
    entry = accounts.set_trash_retention(account, days)
    return int(entry.get("trashRetentionDays"))


# ====== 捕获（删除路由先调这里，失败即中止删除） ======

def capture_session(paths: accounts.AccountPaths, session_id: str, messages_path: Path = None) -> bool:
    """把一个会话的现行数据整体快照进回收站。返回是否捕获到东西。

    任何读写异常都向上抛——调用方必须中止删除。本函数只写入 trash 目录，
    不碰任何活数据（删除仍由原链路执行）。
    """
    if retention_days(paths.account) == 0:
        return False  # 保留天数 0：回收站关闭，删除即彻底清除

    sessions = storage._read_json(paths.sessions_path, {})
    entry = sessions.get(session_id)
    match_variants, file_variants = _session_variants(session_id, entry)

    payloads = {}
    if isinstance(entry, dict):
        payloads["session.json"] = entry

    if messages_path is None:
        try:
            messages_path = storage._get_messages_path(session_id, paths.account)
        except ValueError:
            messages_path = None
    if messages_path is not None and messages_path.exists():
        payloads["messages.json"] = storage._read_json(messages_path, [])

    knowledge = _sole_owner_items(paths.knowledge_path, match_variants)
    if knowledge:
        payloads["knowledge.json"] = knowledge
    formulas = _sole_owner_items(paths.formulas_path, match_variants)
    if formulas:
        payloads["formulas.json"] = formulas

    # 探索网快照按会话形态变体逐文件捕（graph:sess_xxx 与 graph:phymathia_xxx
    # 落在不同拆分文件），文件名带 kv__ 前缀、恢复时各回各的拆分文件
    for variant in sorted(file_variants):
        snap = paths.kv_dir / f"{variant}.json"
        if snap.exists():
            payloads[f"kv__{variant}.json"] = storage._read_json(snap, {})

    socratic = context.snapshot_socratic_state(sorted(match_variants), paths.account)
    if socratic:
        payloads["socratic.json"] = socratic

    quiz = _capture_quiz(paths, match_variants)
    if quiz.get("stats"):
        payloads["quiz_stats.json"] = quiz["stats"]
    if quiz.get("bank"):
        payloads["quiz_bank.json"] = quiz["bank"]

    if not payloads:
        return False

    item_dir = trash_root(paths) / session_id
    item_dir.mkdir(parents=True, exist_ok=True)
    now = int(time.time() * 1000)
    days = retention_days(paths.account)
    counts = {
        "messages": len(payloads.get("messages.json") or []) if isinstance(payloads.get("messages.json"), list) else 0,
        "knowledge": len(payloads.get("knowledge.json") or {}),
        "formulas": len(payloads.get("formulas.json") or {}),
    }
    for name, payload in payloads.items():
        storage._write_json(item_dir / name, payload)
    # meta 最后写：meta 在＝条目完整（半写入的孤儿目录不会被列出/恢复）
    storage._write_json(item_dir / _META_NAME, {
        "id": session_id,
        "title": (entry or {}).get("title") or "未命名画布",
        "deletedAt": now,
        "purgeAt": now + days * _DAY_MS,
        "retentionDays": days,
        "counts": counts,
    })
    return True


def capture_all(paths: accounts.AccountPaths) -> int:
    """清空全部前逐会话快照；任一失败向上抛（调用方中止清空）。返回入站条数。"""
    sessions = storage._read_json(paths.sessions_path, {})
    captured = 0
    for sid in list(sessions.keys()):
        if capture_session(paths, sid):
            captured += 1
    return captured


def _session_variants(session_id: str, entry) -> tuple:
    """会话的两种标识形态：列表键（sess_xxx）与 sessionId 字段（phymathia_xxx）。

    返回 (匹配集, 文件名安全集)：匹配集含原始值（字符串相等比较，不拼路径），
    文件名安全集只留过白名单的形态（entry.sessionId 来自前端 payload、未经
    服务端校验，绝不能直接拼路径）。
    """
    match = set()
    if isinstance(session_id, str) and session_id:
        match.add(session_id)
    if isinstance(entry, dict):
        raw = str(entry.get("sessionId") or "")
        if raw:
            match.add(raw)
    safe = {v for v in match if _ITEM_ID_RE.match(v)}
    return match, safe


def _sole_owner_items(path: Path, variants: set) -> dict:
    """知识/公式库中「仅归属本会话」的条目（删除时会整条抹掉的那些）。

    共享条目只会被摘除本会话归属而存活，不入站；恢复时按键合并回去，
    键已存在（活数据）一律跳过。归属判定与 knowledge._delete_items_by_session
    同口径：sessionId 字段 ∪ sessionIds 数组。
    """
    data = storage._read_json(path, {})
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, item in data.items():
        if not isinstance(item, dict):
            continue
        sids = {str(s) for s in [item.get("sessionId"), *(item.get("sessionIds") or [])] if s}
        if sids and sids <= set(variants):
            out[key] = item
    return out


def _capture_quiz(paths: accounts.AccountPaths, variants: set) -> dict:
    """检测统计与题库里本会话的条目（全局 kv 键内按 sessionId 归属的子条目）。"""
    store = storage._read_json(paths.kv_path, {})
    out = {"stats": None, "bank": None}
    stats = store.get(QUIZ_STATS_KV_KEY)
    if isinstance(stats, dict):
        captured = {"_meta": {}}
        got = False
        for key, val in stats.items():
            if key == "_meta":
                continue
            if isinstance(val, dict) and str(val.get("sessionId") or "") in variants:
                captured[key] = val
                got = True
        meta = stats.get("_meta")
        if isinstance(meta, dict):
            for field in ("wrongQuestions", "openResults"):
                items = meta.get(field)
                if isinstance(items, list):
                    hits = [it for it in items
                            if isinstance(it, dict) and str(it.get("sessionId") or "") in variants]
                    if hits:
                        captured["_meta"][field] = hits
                        got = True
        if got:
            out["stats"] = captured
    bank = store.get(QUIZ_BANK_KV_KEY)
    if isinstance(bank, dict) and isinstance(bank.get("questions"), list):
        hits = [q for q in bank["questions"]
                if isinstance(q, dict) and str(q.get("sessionId") or "") in variants]
        if hits:
            out["bank"] = {"questions": hits}
    return out


# ====== 列表 / 恢复 / 清除 ======

def list_items(paths: accounts.AccountPaths) -> list:
    """站内条目（新删的在前）；顺手惰性清掉过期条目与超过一天的孤儿目录。"""
    purge_expired(paths)
    root = trash_root(paths)
    if not root.is_dir():
        return []
    items = []
    for child in sorted(root.iterdir()):
        meta = storage._read_json(child / _META_NAME, {}) if child.is_dir() else {}
        if meta.get("id"):
            items.append(meta)
    items.sort(key=lambda m: m.get("deletedAt") or 0, reverse=True)
    return items


def restore_item(paths: accounts.AccountPaths, item_id: str) -> str:
    """整条恢复：快照数据写回原位，成功后移除站内条目。返回恢复的会话 id。

    键冲突一律「活的优先」（被删除会话的数据此刻不应存在，setdefault 兜底
    防御重复恢复等异常时序）；目标会话 id 还活着则整体拒绝——半恢复比不恢复糟。
    """
    _validate_item_id(item_id)
    item_dir = trash_root(paths) / item_id
    meta = storage._read_json(item_dir / _META_NAME, {})
    if not meta.get("id"):
        raise KeyError(f"trash item not found: {item_id}")

    sessions = storage._read_json(paths.sessions_path, {})
    if item_id in sessions:
        raise TrashConflictError(f"会话 {item_id} 已存在，无法恢复")

    def _payload(name):
        p = item_dir / name
        return storage._read_json(p, None) if p.exists() else None

    entry = _payload("session.json")
    messages = _payload("messages.json")
    knowledge = _payload("knowledge.json") or {}
    formulas = _payload("formulas.json") or {}
    socratic = _payload("socratic.json") or {}
    quiz_stats = _payload("quiz_stats.json")
    quiz_bank = _payload("quiz_bank.json")

    if isinstance(entry, dict):
        def sess_updater(data):
            data[item_id] = entry
            return data
        storage._mutate_json(paths.sessions_path, sess_updater)

    if isinstance(messages, list):
        try:
            msgs_path = storage._get_messages_path(item_id, paths.account)
        except ValueError:
            msgs_path = None
        if msgs_path is not None:
            storage._write_json(msgs_path, messages)

    for path, payload in ((paths.knowledge_path, knowledge), (paths.formulas_path, formulas)):
        if not payload:
            continue

        def merge(data, _payload=payload):
            for key, item in _payload.items():
                data.setdefault(key, item)
            return data

        storage._mutate_json(path, merge)

    # 探索网快照：kv__<variant>.json 各回各的拆分文件（文件名来自捕获时的白名单形态）
    for p in sorted(item_dir.glob("kv__*.json")):
        variant = p.name[len("kv__"):-len(".json")]
        if not _ITEM_ID_RE.match(variant):
            continue
        snap = storage._read_json(p, {})

        def kv_merge(data, _snap=snap):
            for k, v in _snap.items():
                data.setdefault(k, v)
            return data

        storage._mutate_json(paths.kv_dir / f"{variant}.json", kv_merge)

    if socratic:
        def soc_merge(data, _snap=socratic):
            for k, v in _snap.items():
                data.setdefault(k, v)
            return data

        storage._mutate_json(paths.kv_path, soc_merge)

    if isinstance(quiz_stats, dict):
        def stats_merge(data, _snap=quiz_stats):
            cur = data.get(QUIZ_STATS_KV_KEY)
            cur = cur if isinstance(cur, dict) else {}
            merged = dict(cur)
            for k, v in _snap.items():
                if k != "_meta":
                    merged.setdefault(k, v)
            snap_meta = _snap.get("_meta") if isinstance(_snap.get("_meta"), dict) else {}
            meta_cur = dict(cur.get("_meta")) if isinstance(cur.get("_meta"), dict) else {}
            for field in ("wrongQuestions", "openResults"):
                incoming = [it for it in (snap_meta.get(field) or []) if isinstance(it, dict)]
                if not incoming:
                    continue
                existing = [it for it in (meta_cur.get(field) or []) if isinstance(it, dict)]
                seen = {json.dumps(it, ensure_ascii=False, sort_keys=True) for it in existing}
                meta_cur[field] = existing + [it for it in incoming
                                              if json.dumps(it, ensure_ascii=False, sort_keys=True) not in seen]
            merged["_meta"] = meta_cur
            data[QUIZ_STATS_KV_KEY] = merged
            return data

        storage._mutate_json(paths.kv_path, stats_merge)

    if isinstance(quiz_bank, dict):
        def bank_merge(data, _snap=quiz_bank):
            cur = data.get(QUIZ_BANK_KV_KEY)
            cur = cur if isinstance(cur, dict) else {}
            questions = list(cur.get("questions")) if isinstance(cur.get("questions"), list) else []
            have = {q.get("id") for q in questions if isinstance(q, dict)}
            add = [q for q in (_snap.get("questions") or [])
                   if isinstance(q, dict) and q.get("id") not in have]
            if not add:
                return None  # 无可回填就不重写文件
            cur = dict(cur)
            cur["questions"] = questions + add
            cur["updatedAt"] = int(time.time() * 1000)
            data[QUIZ_BANK_KV_KEY] = cur
            return data

        storage._mutate_json(paths.kv_path, bank_merge)

    shutil.rmtree(item_dir, ignore_errors=True)
    return item_id


def purge_item(paths: accounts.AccountPaths, item_id: str) -> None:
    """彻底删除单条（不可恢复）。条目不存在抛 KeyError（路由层转 404）。"""
    _validate_item_id(item_id)
    item_dir = trash_root(paths) / item_id
    if not (item_dir / _META_NAME).exists():
        raise KeyError(f"trash item not found: {item_id}")
    shutil.rmtree(item_dir, ignore_errors=True)


def empty_trash(paths: accounts.AccountPaths) -> int:
    """清空本账号回收站，返回清除条数。"""
    root = trash_root(paths)
    if not root.is_dir():
        return 0
    purged = 0
    for child in sorted(root.iterdir()):
        if child.is_dir() and (child / _META_NAME).exists():
            shutil.rmtree(child, ignore_errors=True)
            purged += 1
    return purged


def purge_expired(paths: accounts.AccountPaths) -> int:
    """清除 purgeAt 已到的条目；顺带扫掉超过一天的孤儿目录（半写入残留）。"""
    root = trash_root(paths)
    if not root.is_dir():
        return 0
    now = int(time.time() * 1000)
    purged = 0
    for child in sorted(root.iterdir()):
        if not child.is_dir():
            continue
        meta = storage._read_json(child / _META_NAME, {})
        purge_at = meta.get("purgeAt")
        expired = isinstance(purge_at, int) and purge_at > 0 and purge_at <= now
        orphan = not meta.get("id") and _dir_age_ms(child) > _DAY_MS
        if expired or orphan:
            shutil.rmtree(child, ignore_errors=True)
            purged += 1
    return purged


def purge_expired_all() -> int:
    """启动期全账号清理（main.py 模块级调用；单账号失败只告警不拖垮启动）。"""
    total = 0
    seen = set()
    for account in [accounts.DEFAULT_ACCOUNT, *accounts.load_registry().keys()]:
        if account in seen:
            continue
        seen.add(account)
        try:
            total += purge_expired(accounts.resolve_paths(account))
        except Exception as e:  # 清理是附带收益，不许让它拖垮启动
            logger.warning("trash startup purge for %s failed: %s", account, e)
    return total


def _dir_age_ms(path: Path) -> float:
    try:
        return max(0.0, (time.time() - path.stat().st_mtime) * 1000)
    except OSError:
        return 0.0


def _validate_item_id(item_id: str) -> str:
    """item id 直接拼 trash 目录名，白名单外一律 KeyError（路由层 404，不泄露合法性）。"""
    if not isinstance(item_id, str) or not _ITEM_ID_RE.match(item_id) or len(item_id) > 128:
        raise KeyError(f"invalid trash item id: {item_id!r}")
    return item_id
