"""Φ 会话事件日志（pi 式 JSONL，T96）：每次请求的完整往返、应用批次、撤销与反馈。

背景（docs/Φ智能体成熟度评审与改进路线-2026-09-30.md #11）：此前 history 只存
summary + 校验后的 operations，不存提示词、模型原话、工具调用——同指令重跑不可
复现、👎 反馈无模型名与操作明细可归因、撤销只有单步。本模块按 Φ 会话逐行追加
事件到 logs/harness_events/<session_id>.jsonl，一次投入多处受益：

- 问题复现：review 事件带 roundtrips（messages 原文 + 模型原话 + tool_calls），
  能重放「模型当时看到了什么」；
- 任意步撤销：applied 事件带无损 before_snapshot，前端撤销时间线据此整批回滚；
- 反馈归因：feedback 事件挂 event_id（关联到 review 事件），不再是孤儿数据。

写侧全部 best-effort：落盘失败静默吞掉，绝不影响业务响应（与 api._log_usage 同
口径）。会话 id 不合法（旧客户端/匿名请求）时直接不落盘，行为与从前逐字节一致。
"""

from __future__ import annotations

import json
import os
import re
import secrets
import time
from pathlib import Path
from typing import Optional

# 事件文件目录：与 harness_usage.jsonl 同住 logs/，按 Φ 会话一文件。
# 测试用 set_events_dir 注入临时目录。
_EVENTS_DIR = Path(__file__).resolve().parent.parent / "logs" / "harness_events"

# Φ 会话 id 形如 phi_<hex>；白名单同时覆盖画布 sid 等调用方可能传入的形态，
# 拒绝路径穿越（../、斜杠、空字节等）。
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")


def set_events_dir(path) -> None:
    global _EVENTS_DIR
    _EVENTS_DIR = Path(path)
    # 目录换了：旧路径的读缓存与压缩节流时间戳全部作废（测试注入 tmp 的高频路径）
    _events_cache.clear()
    _compact_last.clear()


def valid_session_id(sid) -> bool:
    return bool(_SESSION_ID_RE.match(str(sid or "")))


def new_event_id() -> str:
    return "evt_%06d%s" % (int(time.time() * 1000) % 10**9, secrets.token_hex(3))


def _session_path(session_id: str) -> Path:
    return _EVENTS_DIR / (session_id + ".jsonl")


# ===== 读缓存（T209）：GET /graph/events 过去每次全文件重读重解析（同步 IO 跑在
# async 路由里，文件一大就卡）。按「文件指纹 (mtime_ns, size)」缓存整份解析结果，
# 未变化的重复读取零 IO；写入/压缩改变文件后指纹失配自动失效。LRU 上限防长驻
# 进程把读过的会话文件全都留在内存里。
_EVENTS_CACHE_MAX_FILES = 16
_events_cache: dict = {}   # str(path) -> {"key": (mtime_ns, size), "lines": [(lineno, evt), ...]}
_compact_last: dict = {}   # str(path) -> 上次压缩时刻（节流）


def _drop_cache(path: Path) -> None:
    _events_cache.pop(str(path), None)


def _parse_event_lines(text: str) -> list:
    """整份文本 → [(lineno, evt_dict)]。坏行/空行/非 dict 行跳过，行号照留（seq 契约）。"""
    parsed: list = []
    for lineno, line in enumerate(text.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if isinstance(evt, dict):
            parsed.append((lineno, evt))
    return parsed


def _load_session_lines(path: Path) -> list:
    """带缓存的整文件解析 → [(lineno, evt)]。evt 是缓存共享 dict，调用方只读；
    要注入字段/剥字段时自行浅拷贝（read_events 负责拷）。"""
    strpath = str(path)
    try:
        st = path.stat()
    except Exception:
        _events_cache.pop(strpath, None)
        return []
    key = (st.st_mtime_ns, st.st_size)
    hit = _events_cache.get(strpath)
    if hit and hit["key"] == key:
        _events_cache[strpath] = _events_cache.pop(strpath)   # LRU：命中挪到队尾
        return hit["lines"]
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        _events_cache.pop(strpath, None)
        return []
    lines = _parse_event_lines(text)
    _events_cache[strpath] = {"key": key, "lines": lines}
    if len(_events_cache) > _EVENTS_CACHE_MAX_FILES:
        _events_cache.pop(next(iter(_events_cache)))
    return lines


def append_event(session_id: str, event: dict) -> Optional[str]:
    """按会话追加一行事件。返回事件 id；会话 id 非法或写盘失败返回 None。"""
    if not valid_session_id(session_id):
        return None
    evt = dict(event)
    evt.setdefault("ts", round(time.time(), 3))
    try:
        _EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        path = _session_path(session_id)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(evt, ensure_ascii=False) + "\n")
        _maybe_compact_session_file(path)   # T209：体量治理（节流＋best-effort）
        return str(evt.get("id") or "")
    except Exception:
        return None


def read_events(
    session_id: str,
    types=None,
    event_id: Optional[str] = None,
    limit: int = 100,
    include_snapshot: bool = False,
) -> list:
    """读会话事件（追加序 = seq，恒为行号，坏行跳过但不挤占后续 seq）。

    types：按 type 过滤（逗号分隔的集合）；event_id：精确取一条（隐含带
    before_snapshot，撤销回滚要取的就是它）；limit：从尾部截取最近 N 条；
    include_snapshot：applied 事件默认剥掉 before_snapshot（列表只要元信息，
    整图快照只在真正回滚时取）；T101 起 recipes_before（配方库前态）跟随
    同一开关剥离/带出。
    """
    if not valid_session_id(session_id):
        return []
    path = _session_path(session_id)
    if not path.exists():
        _drop_cache(path)
        return []
    type_set = {str(t).strip() for t in types if str(t).strip()} if types else None
    events: list = []
    for lineno, evt in _load_session_lines(path):
        if event_id and str(evt.get("id") or "") != event_id:
            continue
        if type_set and str(evt.get("type") or "") not in type_set:
            continue
        out = dict(evt)   # 浅拷贝：缓存里的 dict 绝不就地改（seq 注入/剥字段都落在副本上）
        out["seq"] = lineno
        if not include_snapshot and not event_id:
            # 列表模式剥大字段：before_snapshot 整图快照 + recipes_before 配方库
            # 前态（T101，跟随同一开关）——列表只要元信息，回滚时走 event_id 精确取
            out = {k: v for k, v in out.items()
                   if k not in ("before_snapshot", "recipes_before")}
        events.append(out)
    if not event_id:
        events = events[-limit:]
    return events


# ===== 落盘体量治理（T209）：单会话 JSONL 原本无上限——review 事件带整段往返
# 明细、applied 带整图 before_snapshot，用久了又占盘又拖慢首读。压缩策略
# 「只减重、绝不删行」：seq＝行号、undo 的 undone_from_seq 按行号引用，删行会让
# 它们全体漂移，所以老事件只在**原行内**剥重字段；最新的若干条 applied/review
# 原样保留（撤销时间线与反馈归因的功能窗口），被减重的批次撤销时取不到前态 →
# 走前端既有口径「取不到只报错不动画布」。剥完仍超硬上限才把最老的非保留事件
# 整行换成**等行数**的 pruned 占位（id 保留，feedback 引用不断；换了不省就跳过，
# undo/feedback 这类小事件天然受保护）。触发挂在 append 尾部（节流），任何异常
# 放弃、原文件不动。
_COMPACT_SOFT_BYTES = 4 * 1024 * 1024   # 触发线
_COMPACT_HARD_BYTES = 8 * 1024 * 1024   # 减重后仍超才整行占位（best-effort：保不了就超着）
_COMPACT_MIN_INTERVAL = 60.0            # 同一文件两次压缩的最小间隔（秒）
_COMPACT_KEEP_APPLIED = 12              # 最新 N 条 applied 保留 before_snapshot
_COMPACT_KEEP_REVIEW = 6                # 最新 N 条 review 保留 roundtrips


def _compact_session_file(path: Path) -> None:
    strpath = str(path)
    if time.time() - (_compact_last.get(strpath) or 0.0) < _COMPACT_MIN_INTERVAL:
        return
    _compact_last[strpath] = time.time()
    tmp: Optional[Path] = None
    try:
        if path.stat().st_size <= _COMPACT_SOFT_BYTES:
            return
        lines = _load_session_lines(path)
        keep: set = set()
        kept_applied = kept_review = 0
        for lineno, evt in reversed(lines):
            t = str(evt.get("type") or "")
            if t == "applied" and kept_applied < _COMPACT_KEEP_APPLIED:
                keep.add(lineno)
                kept_applied += 1
            elif t == "review" and kept_review < _COMPACT_KEEP_REVIEW:
                keep.add(lineno)
                kept_review += 1
        out_lines: list = []
        for lineno, evt in lines:
            if lineno in keep:
                out_lines.append(json.dumps(evt, ensure_ascii=False))
                continue
            lean = dict(evt)
            t = str(lean.get("type") or "")
            if t == "applied":
                lean.pop("before_snapshot", None)
                lean.pop("recipes_before", None)
            elif t == "review":
                lean.pop("roundtrips", None)
            out_lines.append(json.dumps(lean, ensure_ascii=False))
        total = sum(len(s) + 1 for s in out_lines)
        if total > _COMPACT_HARD_BYTES:
            for i, (lineno, evt) in enumerate(lines):
                if total <= _COMPACT_HARD_BYTES:
                    break
                if lineno in keep:
                    continue
                marker = json.dumps({"id": evt.get("id"), "type": "pruned", "ts": evt.get("ts")},
                                    ensure_ascii=False)
                if len(marker) >= len(out_lines[i]):
                    continue   # 换了不省就别换
                total += len(marker) - len(out_lines[i])
                out_lines[i] = marker
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
        os.replace(tmp, path)
        _drop_cache(path)   # 内容已变，强制下一次读取重载
    except Exception:
        if tmp is not None:
            try:
                tmp.unlink()
            except Exception:
                pass


def _maybe_compact_session_file(path: Path) -> None:
    try:
        _compact_session_file(path)
    except Exception:
        pass


def delete_events(session_id: str) -> bool:
    """删除单个 Φ 会话的事件文件（T127：删除 Φ 对话后磁盘不留完整往返）。

    会话 id 非法 / 文件不存在 / 删除失败都返回 False（best-effort，同写侧口径：
    事件日志是审计副产物，绝不因它失败打断业务）。"""
    if not valid_session_id(session_id):
        return False
    try:
        _session_path(session_id).unlink()
        _drop_cache(_session_path(session_id))
        return True
    except Exception:
        return False


def delete_all_events() -> int:
    """清空全部事件文件（「清空所有 Φ 对话」时调用），返回删除数。best-effort：
    单个文件删不掉不影响其余；目录不存在返回 0。"""
    removed = 0
    try:
        for path in _EVENTS_DIR.glob("*.jsonl"):
            try:
                path.unlink()
                removed += 1
            except Exception:
                continue
    except Exception:
        pass
    _events_cache.clear()
    return removed
