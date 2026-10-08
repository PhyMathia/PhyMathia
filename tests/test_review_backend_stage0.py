"""Stage-0 backend contracts; only temporary data and fake HTTP transports.

B3 uses the ordinary context's documented 3 full + 7 digest rounds
(context._recent_context_messages), not the 15-message trigger as its window.
No cursor/migration representation is prescribed by these tests.
"""

import asyncio
from pathlib import Path
from unittest import mock

import httpx
import pytest

from test_routes import RouteTestBase
import main as main_mod
from server import backup, context, http_client, models_routes, storage


@pytest.fixture
def isolated():
    base = RouteTestBase()
    base.setUp()
    # 多账号 P1：KV 主文件路径经 context._kv_path() 调用期解析（跟 RouteTestBase
    # patch 的 config.DATA_DIR 走），无需再补丁本模块常量。
    with mock.patch.object(models_routes, "_summary_tasks", {}), \
         mock.patch.object(context, "_rolling_memory_epoch", 0), \
         mock.patch.object(context, "_rolling_memory_generations", {}):
        try:
            yield base
        finally:
            base.client.close()
            base.tearDown()


def rounds(count):
    return [
        {"role": role, "content": f"topic_{i:03d}_{role}", "timestamp": i * 2 + j}
        for i in range(1, count + 1)
        for j, role in enumerate(("user", "assistant"))
    ]


def save_messages(sid, count=8):
    storage._write_json(storage._get_messages_path(sid), rounds(count))


def test_b1_snapshot_read_failure_aborts_before_restore(isolated):
    target = backup.SESSIONS_PATH
    original = b'{"A":{"id":"A","title":"original"}}'
    target.write_bytes(original)
    read_bytes = Path.read_bytes
    faults = []

    def failing_read(path):
        if path == target:
            faults.append(path)
            raise OSError("injected snapshot read failure")
        return read_bytes(path)

    # Apply must never start when the complete snapshot cannot be read.
    with mock.patch.object(Path, "read_bytes", failing_read), \
         mock.patch.object(backup, "_apply_restore", side_effect=OSError("injected apply fault")) as apply:
        error = None
        try:
            backup._restore_backup({}, replace=True)
        except (OSError, RuntimeError) as exc:
            error = exc
    assert faults, "snapshot fault must actually be reached"
    after = target.read_bytes() if target.exists() else None
    assert (apply.call_count, after, error is not None) == (0, original, True), (
        f"B1: apply_calls={apply.call_count}, original_preserved={after == original}, error={error!r}"
    )


def test_b2_real_written_state_expires_after_25_hours(isolated):
    epoch = 1_800_000_000
    with mock.patch.object(context.time, "time", return_value=epoch):
        context._write_socratic_state("A", {"active": True, "question": "original"})
        assert context._read_socratic_state("A")["question"] == "original"
    with mock.patch.object(context.time, "time", return_value=epoch + 25 * 3600):
        assert context._read_socratic_state("A") is None, "B2: 25-hour-old written state remains active"


@pytest.mark.parametrize("timestamp,visible", [
    (1_800_000_000, False), (1_800_000_000 + 24 * 3600, True),
    (1, True), (0, True), (None, True),
])
def test_b2_legacy_seconds_and_placeholder_controls(isolated, timestamp, visible):
    state = {"active": True, "question": "legacy"}
    if timestamp is not None:
        state["updatedAt"] = timestamp
    storage._write_json(context._kv_path(), {"socratic:A": state})
    before = context._kv_path().read_bytes()
    with mock.patch.object(context.time, "time", return_value=1_800_000_000 + 25 * 3600):
        assert (context._read_socratic_state("A") is not None) is visible
    assert context._kv_path().read_bytes() == before, "state read must remain side-effect-free"


def test_b3_refresh_input_covers_messages_leaving_short_term_window(isolated):
    inputs = []
    # 8 messages of growth per cycle satisfies the real refresh gate. The
    # second batch (rounds 7-10) is outside the 3+7 window by round 20.
    for count in (8, 12, 16, 20):
        save_messages("A", count)
        due = context._rolling_summary_due("A")
        assert due == count * 2
        inputs.append(context._rolling_memory_input("A"))
        context._write_rolling_memory("A", "synthetic summary without topic markers", due)
        assert context._rolling_summary_due("A") == 0
    recent = context._recent_context_messages(rounds(20))
    recent_text = "\n".join(m["content"] for m in recent)
    assert "topic_011_user" in recent_text
    for i in range(7, 11):
        marker = f"topic_{i:03d}_user"
        assert marker not in recent_text
    missing = [f"topic_{i:03d}_user" for i in range(7, 11)
               if not any(f"topic_{i:03d}_user" in text for text in inputs)]
    assert not missing, f"B3: newly old messages never sent to summary: {missing}"


@pytest.mark.parametrize("provider,base_url", [
    ("opencode-go", "https://opencode.ai/zen/go/v1"),
    ("opencode", "https://opencode.ai/zen/v1"),
])
def test_b4_main_and_summary_transport_headers(isolated, provider, base_url):
    save_messages("A")
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(200, json={"choices": [{"message": {"content": "fake summary"}}]})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as upstream:
            with mock.patch.object(http_client, "get_http_client", return_value=upstream):
                # ASGI stays in the same event loop as the fake upstream.
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_mod.app),
                                             base_url="http://test") as client:
                    response = await client.post("/api/models/chat", json={
                        "messages": [{"role": "user", "content": "hello"}],
                        "session_id": "A", "provider": provider, "base_url": base_url,
                        "api_key": "stage0-fake-key", "model": "test-model", "stream": False,
                    })
                    assert response.status_code == 200
                await main_mod._run_rolling_summary("A", provider, "stage0-fake-key",
                                                    "test-model", base_url, 16)
    asyncio.run(run())
    assert len(seen) == 2
    assert context._read_rolling_memory("A")["summary"] == "fake summary"
    for request in seen:
        assert str(request.url) == base_url + "/chat/completions"
        assert request.headers["x-opencode-session"] == "A"
        assert request.headers["user-agent"].startswith("PhyMathia/")
    expected = "Bearer stage0-fake-key" if provider == "opencode-go" else None
    assert [r.headers.get("authorization") for r in seen] == [expected, expected], (
        "B4: main and rolling-summary authentication must agree; free OpenCode stays unauthenticated"
    )


def seed_sessions(alias=False):
    # B is deliberately a prefix neighbor of A: fuzzy-prefix deletion is wrong.
    storage._write_json(main_mod.SESSIONS_PATH, {
        "A": {"id": "A", "sessionId": "remote_A" if alias else ""},
        "AB": {"id": "AB", "sessionId": "remote_AB" if alias else ""},
    })
    for sid in ("A", "AB"):
        save_messages(sid)
        context._write_rolling_memory(sid, f"OLD_{sid}", 16)
    if alias:
        context._write_rolling_memory("remote_A", "OLD_ALIAS_A", 16)
        context._write_rolling_memory("remote_AB", "OLD_ALIAS_B", 16)
        assert context._load_messages("remote_A") == context._load_messages("A")


@pytest.mark.parametrize("suffix", ["", "/messages"])
@pytest.mark.parametrize("alias", [False, True], ids=["direct", "alias"])
def test_s1_single_clear_removes_exact_session_memory(isolated, suffix, alias):
    seed_sessions(alias)
    response = isolated.client.delete("/api/sessions/A" + suffix)
    assert response.status_code == 200
    assert context._load_messages("A") == []
    assert context._read_rolling_memory("AB")["summary"] == "OLD_AB"
    if alias:
        assert context._read_rolling_memory("remote_AB")["summary"] == "OLD_ALIAS_B"
    # Reuse the same local ID: an empty history alone masks the stale KV via
    # _load_session_context's early return, so add a genuinely new message.
    storage._write_json(storage._get_messages_path("A"), [{"role": "user", "content": "new topic"}])
    built = context._load_session_context("A")
    remaining = [sid for sid in (["A", "remote_A"] if alias else ["A"])
                 if context._read_rolling_memory(sid) is not None]
    assert not remaining and "OLD_" not in str(built), (
        f"P1-S1: retained keys={remaining}; reused-session context={built}"
    )


def test_s1_all_clear_removes_existing_memory_control(isolated):
    seed_sessions(alias=True)
    assert isolated.client.delete("/api/sessions").status_code == 200
    assert storage._read_json(context._kv_path(), {}) == {}
    assert storage._read_json(main_mod.SESSIONS_PATH, {}) == {}
    assert context._load_messages("A") == context._load_messages("AB") == []


@pytest.mark.parametrize("path", ["/api/sessions/A", "/api/sessions/A/messages", "/api/sessions"])
def test_s1_inflight_summary_cannot_resurrect_cleared_memory(isolated, path):
    seed_sessions()
    # Remove preexisting A memory to distinguish resurrection from the static
    # cleanup defect; AB remains as the exact-ID preservation control.
    storage._mutate_json(context._kv_path(), lambda data: {k: v for k, v in data.items() if k != "mem:A"})

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        async def delayed_response(request):
            entered.set()
            await release.wait()
            return httpx.Response(200, json={"choices": [{"message": {"content": "RESURRECTED_A"}}]})

        async with httpx.AsyncClient(transport=httpx.MockTransport(delayed_response)) as upstream:
            with mock.patch.object(http_client, "get_http_client", return_value=upstream):
                main_mod._maybe_schedule_rolling_summary("A", "opencode", "", "test-model",
                                                         "https://opencode.ai/zen/v1")
                task = models_routes._summary_tasks["A:test-model"]
                try:
                    await asyncio.wait_for(entered.wait(), timeout=2)
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main_mod.app),
                                                 base_url="http://test") as client:
                        assert (await client.delete(path)).status_code == 200
                    assert context._read_rolling_memory("A") is None
                    release.set()
                    try:
                        await asyncio.wait_for(task, timeout=2)
                    except asyncio.CancelledError:
                        pass  # Cancelling on deletion is a valid future fix.
                finally:
                    release.set()
                    if not task.done():
                        task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        if path == "/api/sessions":
            assert context._read_rolling_memory("AB") is None
        else:
            assert context._read_rolling_memory("AB")["summary"] == "OLD_AB"
        assert context._read_rolling_memory("A") is None, "P1-S1: delayed response resurrected cleared A memory"
    asyncio.run(run())
