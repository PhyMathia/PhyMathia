"""Follow-up review fixes: orphan alias memory (S1 residual), Socratic branch
mixed time units (B2 residual), rolling-summary tail edits (B3 follow-up).

All data is temporary; no real service, no network, no real model.
Run: python3 -m pytest tests/test_review_followup.py -q
"""

import json
import time

import pytest

from test_review_backend_stage0 import isolated, rounds, save_messages, seed_sessions
from server import context, storage


# ---------- S1 残留：别名映射丢失后的孤儿记忆 ----------

def seed_alias_session():
    """A 的 server sessionId 是 remote_A；记忆按别名键落盘（聊天请求带的是别名）。"""
    storage._write_json(storage.SESSIONS_PATH, {"A": {"id": "A", "sessionId": "remote_A"}})
    save_messages("A")
    assert context._write_rolling_memory("remote_A", "ALIAS_MEMORY", 16)
    return context.KV_PATH.read_bytes()


def kv_keys():
    return set(storage._read_json(context.KV_PATH, {}))


def test_orphan_alias_memory_removed_after_mapping_lost(isolated):
    seed_alias_session()
    assert "mem:remote_A" in kv_keys()
    # 模拟数据漂移：sessions.json 丢了这条会话的映射，删除时再也解析不出别名
    storage._write_json(storage.SESSIONS_PATH, {})
    context._delete_rolling_memory("A")
    assert "mem:remote_A" not in kv_keys(), "mapping loss must not leave an orphan alias memory"


def test_orphan_sweep_consumes_generation_of_alias_key(isolated):
    seed_alias_session()
    old = context._rolling_memory_generation("remote_A")
    storage._write_json(storage.SESSIONS_PATH, {})
    context._delete_rolling_memory("A")
    assert context._rolling_memory_generation("remote_A") != old, "in-flight alias task must be invalidated"
    assert not context._write_rolling_memory("remote_A", "LATE", 16, expected_generation=old)


def test_alias_claimed_by_another_session_is_preserved(isolated):
    seed_alias_session()
    # remote_A 如今被另一个会话声明（多会话共用同一别名）：不能误删
    storage._write_json(storage.SESSIONS_PATH, {"B": {"id": "B", "sessionId": "remote_A"},
                                               "A": {"id": "A", "sessionId": "remote_A"}})
    context._delete_rolling_memory("A")
    assert context._read_rolling_memory("remote_A")["summary"] == "ALIAS_MEMORY"


def test_alias_with_own_messages_file_is_preserved(isolated):
    seed_alias_session()
    save_messages("remote_A")  # 别名自己成了一套会话
    storage._write_json(storage.SESSIONS_PATH, {})
    context._delete_rolling_memory("A")
    assert context._read_rolling_memory("remote_A")["summary"] == "ALIAS_MEMORY"


def test_other_sessions_memory_is_never_swept(isolated):
    seed_alias_session()
    storage._mutate_json(context.KV_PATH, lambda d: {**d, "mem:other": {
        "summary": "OTHER", "messageCount": 16, "owner": "other"}})
    storage._write_json(storage.SESSIONS_PATH, {})
    context._delete_rolling_memory("A")
    data = storage._read_json(context.KV_PATH, {})
    assert data["mem:other"]["summary"] == "OTHER"


def test_delete_without_memory_does_not_rewrite_kv(isolated):
    save_messages("A")
    storage._write_json(context.KV_PATH, {"other:key": 1})
    before = context.KV_PATH.read_bytes()
    context._delete_rolling_memory("A")
    assert context.KV_PATH.read_bytes() == before, "no memory for this session: leave the file alone"


# ---------- B2 残留：苏格拉底分支状态秒/毫秒混存 ----------

def branch_ref(name):
    return f"br_A_{name * 10}"


def write_state(name, updated_at, active=True):
    storage._mutate_json(context.KV_PATH, lambda d: {**d, f"socratic:{branch_ref(name)}": {
        "active": active, "level": "basic", "updatedAt": updated_at}})


def test_newer_seconds_state_beats_older_milliseconds_state(isolated):
    now = int(time.time())
    write_state("a", (now - 600) * 1000)     # 10 分钟前，毫秒写法
    write_state("b", now - 60)               # 1 分钟前，秒写法
    assert context._resolve_socratic_branch("A") == branch_ref("b")


def test_same_unit_ordering_is_unchanged(isolated):
    now = int(time.time())
    write_state("a", now - 600)
    write_state("b", now - 60)
    assert context._resolve_socratic_branch("A") == branch_ref("b")


def test_legacy_placeholder_states_still_resolve(isolated):
    write_state("a", 1)          # 旧版占位值
    write_state("b", 99999999)
    assert context._resolve_socratic_branch("A") == branch_ref("b")


def test_junk_timestamps_do_not_crash_or_win(isolated):
    now = int(time.time())
    storage._mutate_json(context.KV_PATH, lambda d: {**d,
        f"socratic:{branch_ref('a')}": {"active": True, "updatedAt": "garbage"},
        f"socratic:{branch_ref('b')}": {"active": True, "updatedAt": now}})
    assert context._resolve_socratic_branch("A") == branch_ref("b")


def test_expired_state_is_still_dropped(isolated):
    now = int(time.time())
    write_state("a", (now - 25 * 3600) * 1000)   # 超过 24 小时
    write_state("b", now - 60)
    assert context._resolve_socratic_branch("A") == branch_ref("b")
    assert f"socratic:{branch_ref('a')}" not in kv_keys()


# ---------- B3 后续：尾部变化不再丢掉已经生成的摘要 ----------

def test_tail_edit_while_summary_in_flight_is_kept(isolated):
    save_messages("A", 12)
    snapshot = context._rolling_memory_snapshot("A")
    messages = rounds(12)
    assert 0 < snapshot["coveredMessageCount"] < len(messages), "precondition: snapshot has an uncovered tail"
    messages[-1]["content"] = "regenerated answer"     # 重生成最后一条回答：长度不变
    storage._write_json(storage._get_messages_path("A"), messages)
    assert context._write_rolling_memory("A", "tail-safe summary", 24, snapshot=snapshot)
    assert context._read_rolling_memory("A")["summary"] == "tail-safe summary"


def test_tail_edit_does_not_claim_uncovered_messages(isolated):
    save_messages("A", 12)
    snapshot = context._rolling_memory_snapshot("A")
    messages = rounds(12)
    messages[-1]["content"] = "regenerated answer"
    storage._write_json(storage._get_messages_path("A"), messages)
    context._write_rolling_memory("A", "tail-safe summary", 24, snapshot=snapshot)
    saved = context._read_rolling_memory("A")
    assert saved["coveredMessageCount"] == snapshot["coveredMessageCount"]
    assert saved["messageCount"] == snapshot["messageCount"]


def test_covered_region_rewrite_is_still_refused(isolated):
    save_messages("A", 12)
    snapshot = context._rolling_memory_snapshot("A")
    messages = rounds(12)
    messages[0]["content"] = "rewritten history"
    storage._write_json(storage._get_messages_path("A"), messages)
    assert not context._write_rolling_memory("A", "stale", 24, snapshot=snapshot)
    assert context._read_rolling_memory("A") is None
