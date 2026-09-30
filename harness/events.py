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


def valid_session_id(sid) -> bool:
    return bool(_SESSION_ID_RE.match(str(sid or "")))


def new_event_id() -> str:
    return "evt_%06d%s" % (int(time.time() * 1000) % 10**9, secrets.token_hex(3))


def _session_path(session_id: str) -> Path:
    return _EVENTS_DIR / (session_id + ".jsonl")


def append_event(session_id: str, event: dict) -> Optional[str]:
    """按会话追加一行事件。返回事件 id；会话 id 非法或写盘失败返回 None。"""
    if not valid_session_id(session_id):
        return None
    evt = dict(event)
    evt.setdefault("ts", round(time.time(), 3))
    try:
        _EVENTS_DIR.mkdir(parents=True, exist_ok=True)
        with open(_session_path(session_id), "a", encoding="utf-8") as f:
            f.write(json.dumps(evt, ensure_ascii=False) + "\n")
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
    整图快照只在真正回滚时取）。
    """
    if not valid_session_id(session_id):
        return []
    path = _session_path(session_id)
    if not path.exists():
        return []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []
    type_set = {str(t).strip() for t in types if str(t).strip()} if types else None
    events: list = []
    for lineno, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        try:
            evt = json.loads(line)
        except Exception:
            continue
        if not isinstance(evt, dict):
            continue
        evt["seq"] = lineno
        if event_id and str(evt.get("id") or "") != event_id:
            continue
        if type_set and str(evt.get("type") or "") not in type_set:
            continue
        if not include_snapshot and not event_id:
            evt = {k: v for k, v in evt.items() if k != "before_snapshot"}
        events.append(evt)
    if not event_id:
        events = events[-limit:]
    return events
