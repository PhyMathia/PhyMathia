"""Stage-1 deletion races and backup snapshot boundaries; all data is temporary."""

import asyncio
from pathlib import Path
from unittest import mock

import httpx
import pytest

from test_review_backend_stage0 import isolated, seed_sessions, save_messages
import main as main_mod
from server import backup, context, http_client, models_routes, storage


async def clear(kind):
    # Call the real async route without yielding through ASGI middleware. This
    # lets the queued-but-not-started test control the exact execution order.
    if kind == "delete":
        await main_mod.api_delete_session("A")
    elif kind == "messages":
        await main_mod.api_clear_messages("A")
    else:
        await main_mod.api_clear_all_sessions()


@pytest.mark.parametrize("kind", ["delete", "messages", "all"])
@pytest.mark.parametrize("started", [False, True], ids=["queued", "inflight"])
def test_s1_alias_task_invalidated_before_start_or_after_response(isolated, kind, started):
    seed_sessions(alias=True)
    storage._mutate_json(context._mem_path(), lambda d: {k: v for k, v in d.items()
                                                  if k != "mem:remote_A"})

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()
        requests = []

        async def handler(request):
            requests.append(request)
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"choices": [{"message": {"content": "OLD_TASK"}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
            with mock.patch.object(http_client, "get_http_client", return_value=upstream):
                main_mod._maybe_schedule_rolling_summary("remote_A", "opencode", "", "m",
                                                         "https://opencode.ai/zen/v1")
                task = models_routes._summary_tasks["remote_A:m"]
                try:
                    if started:
                        await asyncio.wait_for(entered.wait(), 2)
                    await clear(kind)
                    assert context._read_rolling_memory("remote_A") is None
                    # New messages and a new-generation summary must not be
                    # overwritten, even if the old task has not started yet.
                    seed_sessions(alias=True)
                    current = context._rolling_memory_generation("remote_A")
                    assert context._write_rolling_memory("remote_A", "NEW_GENERATION", 16,
                                                         expected_generation=current)
                    release.set()
                    await asyncio.wait_for(task, 2)
                    assert context._read_rolling_memory("remote_A")["summary"] == "NEW_GENERATION"
                    assert len(requests) == int(started)
                finally:
                    release.set()
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                # Completion releases deduplication so a fresh task can run.
                storage._mutate_json(context._mem_path(), lambda d: {k: v for k, v in d.items()
                                                              if k != "mem:remote_A"})
                main_mod._maybe_schedule_rolling_summary("remote_A", "opencode", "", "m",
                                                         "https://opencode.ai/zen/v1")
                await asyncio.wait_for(models_routes._summary_tasks["remote_A:m"], 2)
                assert context._read_rolling_memory("remote_A")["summary"] == "OLD_TASK"
    asyncio.run(run())


@pytest.mark.parametrize("kind", ["delete", "messages", "all"])
def test_s1_unknown_session_generation_survives_clear(isolated, kind):
    old = context._rolling_memory_generation("A")
    asyncio.run(clear(kind))
    # T214：清空全部会移除 mem 族文件（此前是主文件写成 {}）——陈旧代次的写入
    # 既不许改文件、也不许把它凭空建回来
    before = context._mem_path().read_bytes() if context._mem_path().exists() else None
    assert not context._write_rolling_memory("A", "STALE", 16, expected_generation=old)
    after = context._mem_path().read_bytes() if context._mem_path().exists() else None
    assert after == before
    current = context._rolling_memory_generation("A")
    assert current != old
    assert context._write_rolling_memory("A", "NEW", 16, expected_generation=current)


@pytest.mark.parametrize("collision", ["direct_file", "other_alias"])
def test_s1_alias_collision_preserves_actual_other_owner(isolated, collision):
    seed_sessions(alias=True)
    if collision == "direct_file":
        save_messages("remote_A")
    else:
        storage._write_json(storage.SESSIONS_PATH, {
            "AB": {"id": "AB", "sessionId": "remote_A"},
            "A": {"id": "A", "sessionId": "remote_A"},
        })
    old_alias = context._rolling_memory_generation("remote_A")
    context._delete_rolling_memory("A")
    assert context._read_rolling_memory("A") is None
    assert context._read_rolling_memory("remote_A")["summary"] == "OLD_ALIAS_A"
    assert context._rolling_memory_generation("remote_A") == old_alias
    assert context._read_rolling_memory("AB")["summary"] == "OLD_AB"


@pytest.mark.parametrize("replace", [False, True])
def test_b1_late_snapshot_failure_never_writes_or_rolls_back(isolated, replace):
    seed_sessions(alias=True)
    target = backup.PROFILES_DIR / "device.json"
    target.write_bytes(b'{"original":true}')
    before = {p: p.read_bytes() for p in backup._restore_target_paths() if p.exists()}
    read = Path.read_bytes

    def fail(path):
        if path == target:
            raise PermissionError("snapshot denied")
        return read(path)

    with mock.patch.object(Path, "read_bytes", fail), \
         mock.patch.object(backup, "_apply_restore") as apply, \
         mock.patch.object(backup, "_rollback_restore_targets") as rollback:
        with pytest.raises(PermissionError, match="snapshot denied"):
            backup._restore_backup({}, replace=replace)
        apply.assert_not_called()
        rollback.assert_not_called()
    assert {p: p.read_bytes() for p in before} == before


def test_b1_missing_file_deleted_but_empty_existing_file_restored(isolated):
    backup.SESSIONS_PATH.write_bytes(b"")
    assert not backup.KNOWLEDGE_PATH.exists()

    def fail(*args, **kwargs):   # _apply_restore 现带 account 关键字（多账号 P1）
        backup.SESSIONS_PATH.write_bytes(b"changed")
        backup.KNOWLEDGE_PATH.write_bytes(b"new")
        (backup.MESSAGES_DIR / "new.json").write_bytes(b"[]")
        raise OSError("apply fault")

    with mock.patch.object(backup, "_apply_restore", side_effect=fail):
        with pytest.raises(RuntimeError, match="apply fault"):
            backup._restore_backup({}, replace=True)
    assert backup.SESSIONS_PATH.read_bytes() == b""
    assert not backup.KNOWLEDGE_PATH.exists()
    assert not (backup.MESSAGES_DIR / "new.json").exists()
