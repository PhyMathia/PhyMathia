"""Bounded rolling-summary snapshot regressions; temporary data, no models."""

import pytest

from test_review_backend_stage0 import isolated, rounds, save_messages
from server import context, storage


def test_snapshot_allows_append_without_claiming_new_messages(isolated):
    save_messages("A", 12)
    snapshot = context._rolling_memory_snapshot("A")
    save_messages("A", 16)
    assert context._write_rolling_memory("A", "snapshot summary", 32, snapshot=snapshot)
    saved = context._read_rolling_memory("A")
    assert saved["messageCount"] == 24
    assert saved["coveredMessageCount"] == snapshot["coveredMessageCount"] == 12
    assert "topic_013_user" not in snapshot["text"]


@pytest.mark.parametrize("change", ["edit", "truncate"])
def test_snapshot_rejects_changed_source_prefix(isolated, change):
    save_messages("A", 12)
    snapshot = context._rolling_memory_snapshot("A")
    messages = rounds(12)
    if change == "edit":
        messages[0]["content"] = "replaced topic"
    else:
        messages = messages[:-2]
    storage._write_json(storage._get_messages_path("A"), messages)
    assert not context._write_rolling_memory("A", "stale summary", 24, snapshot=snapshot)
    assert context._read_rolling_memory("A") is None


def test_snapshot_rejects_competing_base_memory(isolated):
    save_messages("A", 12)
    first = context._rolling_memory_snapshot("A")
    competing = context._rolling_memory_snapshot("A")
    assert context._write_rolling_memory("A", "winner", 24, snapshot=first)
    before = context._mem_path().read_bytes()
    assert not context._write_rolling_memory("A", "stale loser", 24, snapshot=competing)
    assert context._mem_path().read_bytes() == before
    assert context._read_rolling_memory("A")["summary"] == "winner"


def test_legacy_message_count_is_not_a_covered_cursor(isolated):
    save_messages("A", 20)
    storage._write_json(context._mem_path(), {
        "mem:A": {"summary": "unknown coverage", "messageCount": 40, "updatedAt": 123}
    })
    before = context._mem_path().read_bytes()
    # Legacy refresh-gap contract (test_server RollingMemoryTest) stays intact:
    # Forty saved messages with no growth stay below the refresh gap.
    assert context._rolling_summary_due("A") == 0
    assert context._mem_path().read_bytes() == before
    # Replay from the start happens at the next scheduled refresh, not eagerly.
    save_messages("A", 24)
    assert context._rolling_summary_due("A") == 48
    snapshot = context._rolling_memory_snapshot("A")
    assert "topic_001_user" in snapshot["text"]
    assert "topic_006_user" in snapshot["text"]
    assert "topic_007_user" not in snapshot["text"]
    assert snapshot["coveredMessageCount"] == 12
    assert snapshot["backlog"] is True


def test_backlog_stays_due_without_new_messages(isolated):
    save_messages("A", 20)
    storage._write_json(context._mem_path(), {
        "mem:A": {"summary": "old", "messageCount": 20,
                  "coveredMessageCount": 12, "coveredPrefix": "stale", "updatedAt": 123}
    })
    # coveredPrefix mismatch (or no cursor at all) means the backlog between the
    # unknown legacy boundary and the short-term window must stay due.
    assert context._rolling_summary_due("A") == 40
    snapshot = context._rolling_memory_snapshot("A")
    assert snapshot["coveredMessageCount"] == 12
    assert snapshot["backlog"] is True


def test_budget_truncation_covers_only_consumed_rounds(isolated, monkeypatch):
    save_messages("A", 24)
    one = context._rolling_memory_snapshot("A", max_old_pairs=1)
    monkeypatch.setattr(context, "ROLLING_MEMORY_INPUT_MAX_CHARS", len(one["text"]))
    snapshot = context._rolling_memory_snapshot("A")
    assert snapshot["text"] == one["text"]
    assert snapshot["coveredMessageCount"] == 2
    assert "topic_002_user" not in snapshot["text"]
    assert snapshot["backlog"] is True
