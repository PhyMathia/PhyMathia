"""T96 会话事件日志（pi 式 JSONL）回归：harness/events.py + /graph 事件端点。

覆盖：
- review（非流式 / 流式 / 空快照早退 / 无 session_id）落事件与 roundtrips 内容；
- apply_report / undo_report / graph/events 的快照剥离、types 过滤、event_id 精确取；
- feedback 双写（feedback json + 会话事件）与非法 phi_session_id 的降级；
- 坏 JSONL 行的跳过与 seq 稳定性；journal 截长；usage 条目的 session_id/event_id；
- resolve 端点的 endpoint='resolve' 事件；
- apply_report 的 recipes_before（T101）：合法 list 落盘/列表剥离/event_id 带出，
  形状不对与超上限不落字段。

事件目录用 harness.events.set_events_dir 注入 tmp（api.py 按名导入 append/read，
函数体动态读 events 模块全局，注入对路由路径同样生效）；feedback 的 DATA_DIR
monkeypatch 到 tmp，绝不写真实日志。
"""

from __future__ import annotations

import json

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from harness import api as api_mod
from harness import events as events_mod
from harness import review as review_mod
from harness.api import router

SID = "phi_test_events"

MODEL = {
    "provider": "openai",  # openai 支持 json_mode，走的正是 mode=json 主路径
    "model": "test-model",
    "base_url": "http://127.0.0.1:1/v1",
    "api_key": "k",
}

SNAPSHOT = {
    "version": 1,
    "nodes": [{"id": "A", "kind": "knowledge", "label": "导数",
               "content": "瞬时变化率", "formula": "f'(x)"}],
    "edges": [],
}

GEN_OPS = [
    {"op": "create_node", "temp_id": "cn1", "kind": "knowledge",
     "label": "导数的应用", "content": "切线斜率", "reason": "补充应用"},
    {"op": "add_edge", "from": "A", "to": "cn1", "relation": "延伸", "reason": "连接新节点"},
]


def _review_content(summary: str = "测试摘要", ops=None) -> str:
    return json.dumps({"summary": summary, "operations": ops or []}, ensure_ascii=False)


def review_payload(**overrides) -> dict:
    payload = {
        "session_id": SID,
        "instruction": "请在图上补充一个导数的应用节点",
        "phase": "normal",
        "mode": "json",
        "self_check": "off",
        "retries": 0,
        "snapshot": SNAPSHOT,
        "model": MODEL,
    }
    payload.update(overrides)
    return payload


def install_stub(monkeypatch, content: str, deltas=None) -> list:
    """monkeypatch harness.review._call_model，返回调用记录（进参）。"""
    calls: list = []

    async def fake_call(messages, model, max_tokens, tools=None,
                        tool_choice=None, json_mode=False, on_delta=None):
        calls.append({
            "messages": messages,
            "model": model,
            "max_tokens": max_tokens,
            "tools": tools,
            "tool_choice": tool_choice,
            "json_mode": json_mode,
        })
        if on_delta is not None and deltas:
            for chunk in deltas:
                on_delta(chunk)
        return {"content": content, "tool_calls": []}

    monkeypatch.setattr(review_mod, "_call_model", fake_call)
    return calls


@pytest.fixture()
def events_dir(tmp_path, monkeypatch):
    target = tmp_path / "harness_events"
    monkeypatch.setattr(events_mod, "_EVENTS_DIR", target)
    return target


@pytest.fixture()
def client(events_dir):
    app = FastAPI()
    app.include_router(router, prefix="/api/harness")
    with TestClient(app) as test_client:
        yield test_client


# ---- 1. 非流式 review：完整往返落盘 ----


def test_review_nonstream_logs_full_roundtrip(client, events_dir, monkeypatch):
    calls = install_stub(monkeypatch, _review_content("测试摘要：补充节点", GEN_OPS))

    response = client.post("/api/harness/graph/review", json=review_payload())
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "ok", result
    assert result["event_id"]
    assert any(op["op"] == "create_node" for op in result["operations"]), result
    assert len(calls) == 1

    events = events_mod.read_events(SID)
    assert len(events) == 1
    evt = events[0]
    assert evt["type"] == "review"
    assert evt["endpoint"] == "review"
    assert evt["id"] == result["event_id"]
    assert evt["session_id"] == SID
    assert evt["instruction"] == review_payload()["instruction"]
    assert evt["phase"] == "normal"
    assert evt["summary"] == result["summary"]
    assert evt["operations"] == result["operations"]
    assert evt["status"] == result["status"]
    assert evt["model"]["provider"] == "openai"
    assert evt["model"]["model"] == "test-model"
    assert evt["stream"] is False

    roundtrips = evt["roundtrips"]
    assert len(roundtrips) == 1
    rt = roundtrips[0]
    assert rt["stage"] == "generate"
    assert rt["attempt"] == 0
    roles = [m["role"] for m in rt["messages"]]
    assert roles == ["system", "user"]
    assert all(str(m["content"]).strip() for m in rt["messages"])
    assert "测试摘要" in rt["raw"]["content"]


# ---- 2. 无 session_id：event_id 照发，不落盘 ----


def test_review_without_session_id_returns_event_id_but_no_file(client, events_dir, monkeypatch):
    install_stub(monkeypatch, _review_content("匿名摘要", GEN_OPS))
    payload = review_payload()
    payload.pop("session_id")

    response = client.post("/api/harness/graph/review", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "ok"
    assert result["event_id"]

    assert events_mod.read_events(SID) == []
    assert not events_dir.exists() or list(events_dir.glob("*.jsonl")) == []


# ---- 3. 空快照早退：不调模型也落事件（roundtrips=[]） ----


def test_review_empty_snapshot_early_exit_still_logs_event(client, events_dir, monkeypatch):
    async def boom(*args, **kwargs):
        raise AssertionError("空快照早退不应调用模型")

    monkeypatch.setattr(review_mod, "_call_model", boom)

    payload = review_payload(
        instruction="看看这张图",
        snapshot={"version": 1, "nodes": [], "edges": []},
    )
    response = client.post("/api/harness/graph/review", json=payload)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "no_ops"
    assert result["event_id"]

    events = events_mod.read_events(SID)
    assert len(events) == 1
    evt = events[0]
    assert evt["type"] == "review"
    assert evt["id"] == result["event_id"]
    assert evt["status"] == "no_ops"
    assert evt["model_calls"] == 0
    assert evt["roundtrips"] == []
    assert "快照为空" in evt["summary"]


# ---- 4. SSE 流式 review：result 帧带 event_id 且事件已落盘 ----


def test_review_stream_logs_event(client, events_dir, monkeypatch):
    install_stub(monkeypatch, _review_content("流式摘要", GEN_OPS), deltas=["正在", "生成"])

    result = None
    saw_delta = False
    with client.stream("POST", "/api/harness/graph/review",
                       json=review_payload(stream=True)) as response:
        assert response.status_code == 200
        for line in response.iter_lines():
            if isinstance(line, bytes):
                line = line.decode("utf-8")
            if not line.startswith("data: "):
                continue
            item = json.loads(line[len("data: "):])
            if item.get("type") == "delta":
                saw_delta = True
            if item.get("type") == "result":
                result = item["data"]

    assert result is not None and result["event_id"], result
    assert saw_delta
    events = events_mod.read_events(SID)
    assert len(events) == 1
    evt = events[0]
    assert evt["type"] == "review" and evt["id"] == result["event_id"]
    assert evt["stream"] is True
    assert evt["roundtrips"][0]["stage"] == "generate"


# ---- 5. apply_report：快照剥离 / event_id 精确取 / types 过滤 ----


def test_apply_report_events_snapshot_stripping_and_filters(client, events_dir):
    before1 = json.loads(json.dumps(SNAPSHOT))
    before2 = {"version": 1, "nodes": [{"id": "B", "kind": "knowledge", "label": "积分"}], "edges": []}

    r1 = client.post("/api/harness/graph/apply_report", json={
        "session_id": SID, "event_id": "evt_review_1",
        "applied_ops": [GEN_OPS[0]], "before_snapshot": before1,
        "mode": "all", "summary": "第一批",
    })
    assert r1.status_code == 200, r1.text
    first_id = r1.json()["event_id"]
    assert first_id

    r2 = client.post("/api/harness/graph/apply_report", json={
        "session_id": SID, "applied_ops": [GEN_OPS[1]],
        "before_snapshot": before2, "mode": "manual",
    })
    assert r2.status_code == 200, r2.text
    second_id = r2.json()["event_id"]
    assert second_id != first_id

    # 同会话再塞一条 review 事件：验证 types 过滤确实按 type 分流
    events_mod.append_event(SID, {"id": "evt_review_manual", "type": "review", "session_id": SID})

    listed = client.get("/api/harness/graph/events",
                        params={"session_id": SID, "types": "applied"})
    assert listed.status_code == 200
    events = listed.json()["events"]
    assert [e["type"] for e in events] == ["applied", "applied"]
    assert [e["id"] for e in events] == [first_id, second_id]
    assert [e["seq"] for e in events] == [1, 2]
    for evt in events:
        assert "before_snapshot" not in evt  # 列表默认剥快照，只要元信息
    assert events[0]["event_id"] == "evt_review_1"
    assert events[0]["mode"] == "all" and events[0]["summary"] == "第一批"
    assert events[0]["ops_count"] == 1 and events[0]["applied_ops"] == [GEN_OPS[0]]

    one = client.get("/api/harness/graph/events",
                     params={"session_id": SID, "event_id": first_id})
    assert one.status_code == 200
    single = one.json()["events"]
    assert len(single) == 1
    assert single[0]["id"] == first_id
    assert single[0]["before_snapshot"] == before1  # event_id 精确取隐含带快照

    with_snap = client.get("/api/harness/graph/events",
                           params={"session_id": SID, "types": "applied", "include_snapshot": "1"})
    listed_snaps = with_snap.json()["events"]
    assert len(listed_snaps) == 2
    assert listed_snaps[0]["before_snapshot"] == before1
    assert listed_snaps[1]["before_snapshot"] == before2

    # types 不含 review：applied 过滤里没有那条手工塞的 review 事件
    assert all(e["type"] != "review" for e in events)
    all_types = client.get("/api/harness/graph/events", params={"session_id": SID}).json()["events"]
    assert [e["type"] for e in all_types] == ["applied", "applied", "review"]


# ---- 6. 非法 session_id / seq 一律 400 ----


def test_invalid_session_and_seq_return_400(client):
    bad = client.post("/api/harness/graph/apply_report", json={
        "session_id": "../evil", "applied_ops": []})
    assert bad.status_code == 400
    assert bad.json()["status"] == "error"

    missing_sid = client.post("/api/harness/graph/undo_report", json={"undone_from_seq": 1})
    assert missing_sid.status_code == 400

    no_seq = client.post("/api/harness/graph/undo_report", json={"session_id": SID})
    assert no_seq.status_code == 400
    assert no_seq.json()["status"] == "error"

    zero_seq = client.post("/api/harness/graph/undo_report",
                           json={"session_id": SID, "undone_from_seq": 0})
    assert zero_seq.status_code == 400

    text_seq = client.post("/api/harness/graph/undo_report",
                           json={"session_id": SID, "undone_from_seq": "abc"})
    assert text_seq.status_code == 400

    no_session = client.get("/api/harness/graph/events")
    assert no_session.status_code == 400

    evil_session = client.get("/api/harness/graph/events", params={"session_id": "../evil"})
    assert evil_session.status_code == 400


# ---- 7. undo_report：事件落盘且 undone_from_seq 正确 ----


def test_undo_report_logs_event_with_undone_from_seq(client, events_dir):
    response = client.post("/api/harness/graph/undo_report", json={
        "session_id": SID, "undone_from_seq": 2, "note": "回滚到第一批之前"})
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "ok" and result["event_id"]

    events = events_mod.read_events(SID)
    assert len(events) == 1
    evt = events[0]
    assert evt["type"] == "undo"
    assert evt["id"] == result["event_id"]
    assert evt["undone_from_seq"] == 2
    assert evt["note"] == "回滚到第一批之前"

    listed = client.get("/api/harness/graph/events",
                        params={"session_id": SID, "types": "undo"}).json()["events"]
    assert len(listed) == 1 and listed[0]["undone_from_seq"] == 2


# ---- 8. feedback：json 双字段 + 会话事件；非法 phi_session_id 降级 ----


def test_feedback_writes_json_and_session_event(client, events_dir, tmp_path, monkeypatch):
    import src.server.config as server_config

    data_dir = tmp_path / "data"
    monkeypatch.setattr(server_config, "DATA_DIR", data_dir)

    response = client.post("/api/harness/graph/feedback", json={
        "kind": "bad", "instruction": "补充节点", "summary": "不对", "ops_count": 1,
        "phase": "normal", "note": "多画了一个节点",
        "event_id": "evt_review_x", "phi_session_id": "phi_feedback_1",
    })
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "ok"

    items = json.loads((data_dir / "harness_feedback.json").read_text(encoding="utf-8"))
    assert len(items) == 1
    assert items[0]["event_id"] == "evt_review_x"
    assert items[0]["phi_session_id"] == "phi_feedback_1"

    feed_events = events_mod.read_events("phi_feedback_1")
    assert len(feed_events) == 1
    evt = feed_events[0]
    assert evt["type"] == "feedback"
    assert evt["event_id"] == "evt_review_x"
    assert evt["kind"] == "bad"
    assert evt["note"] == "多画了一个节点"

    # phi_session_id 非法：feedback json 照记（200），但会话事件不落盘
    response2 = client.post("/api/harness/graph/feedback", json={
        "kind": "bad", "note": "第二个", "event_id": "evt_review_y",
        "phi_session_id": "../evil",
    })
    assert response2.status_code == 200
    items2 = json.loads((data_dir / "harness_feedback.json").read_text(encoding="utf-8"))
    assert len(items2) == 2
    assert items2[1]["phi_session_id"] == "../evil"
    assert events_mod.read_events("../evil") == []
    assert [p.name for p in events_dir.glob("*.jsonl")] == ["phi_feedback_1.jsonl"]


# ---- 9. 坏 JSONL 行：跳过不挤占 seq ----


def test_bad_jsonl_line_skipped_and_seq_stays_line_number(events_dir):
    path = events_dir / "phi_badline.jsonl"
    events_dir.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join([
        json.dumps({"id": "e1", "type": "applied"}),
        "{not json",
        json.dumps({"id": "e2", "type": "undo"}),
    ]) + "\n", encoding="utf-8")

    got = events_mod.read_events("phi_badline")
    assert [(e["id"], e["seq"]) for e in got] == [("e1", 1), ("e2", 3)]

    events_mod.append_event("phi_badline", {"id": "e3", "type": "feedback"})
    got = events_mod.read_events("phi_badline")
    assert [(e["id"], e["seq"]) for e in got] == [("e1", 1), ("e2", 3), ("e3", 4)]


# ---- 10. journal 截长：>30000 字符的模型原话截断并打标 ----


def test_journal_truncates_long_model_output(client, events_dir, monkeypatch):
    long_content = json.dumps({"summary": "长" * 31000, "operations": []}, ensure_ascii=False)
    assert len(long_content) > 30000
    install_stub(monkeypatch, long_content)

    response = client.post("/api/harness/graph/review",
                           json=review_payload(instruction="看看这张图有没有问题"))
    assert response.status_code == 200, response.text

    evt = events_mod.read_events(SID)[0]
    raw = evt["roundtrips"][0]["raw"]
    assert len(raw["content"]) <= 30000
    assert raw["content_truncated"] is True


# ---- 11. usage 条目：session_id + event_id 关联 ----


def test_usage_entry_carries_session_and_event_id(client, monkeypatch):
    install_stub(monkeypatch, _review_content("用量摘要", GEN_OPS))
    captured: list = []
    monkeypatch.setattr(api_mod, "_log_usage", lambda entry: captured.append(entry))

    response = client.post("/api/harness/graph/review", json=review_payload())
    assert response.status_code == 200, response.text
    result = response.json()

    assert len(captured) == 1
    entry = captured[0]
    assert entry["endpoint"] == "review"
    assert entry["session_id"] == SID
    assert entry["event_id"]
    assert entry["event_id"] == result["event_id"]


# ---- 12. resolve 端点：endpoint='resolve' 的 review 型事件 ----


def test_resolve_logs_event_with_endpoint_resolve(client, events_dir, monkeypatch):
    content = json.dumps({
        "focus_node_ids": ["A"], "ambiguous": False, "question": "", "candidates": [],
    }, ensure_ascii=False)
    install_stub(monkeypatch, content)

    response = client.post("/api/harness/graph/resolve", json={
        "session_id": SID,
        "instruction": "帮我定位跟求导有关的节点",
        "snapshot": SNAPSHOT,
        "model": MODEL,
    })
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["status"] == "ok"
    assert result["focus_node_ids"] == ["A"]
    assert result["event_id"]

    events = events_mod.read_events(SID)
    assert len(events) == 1
    evt = events[0]
    assert evt["type"] == "review"
    assert evt["endpoint"] == "resolve"
    assert evt["id"] == result["event_id"]
    assert evt["roundtrips"] == []


# ---- 事件模块自身：sid 白名单 / id 形态 / limit 截尾 / types 过滤 ----


def test_valid_session_id_and_append_guard(events_dir):
    assert events_mod.valid_session_id("phi_abc-123")
    assert events_mod.valid_session_id("a" * 80)
    assert not events_mod.valid_session_id("")
    assert not events_mod.valid_session_id(None)
    assert not events_mod.valid_session_id("../evil")
    assert not events_mod.valid_session_id("a/b")
    assert not events_mod.valid_session_id("a" * 81)

    assert events_mod.append_event("../evil", {"type": "review"}) is None
    assert not events_dir.exists() or list(events_dir.glob("*.jsonl")) == []

    ids = {events_mod.new_event_id() for _ in range(50)}
    assert len(ids) == 50
    assert all(i.startswith("evt_") for i in ids)


def test_read_events_tail_limit_and_type_filter(events_dir):
    for index in range(5):
        events_mod.append_event(SID, {
            "id": f"evt_{index}",
            "type": "applied" if index % 2 == 0 else "review",
        })

    tail = events_mod.read_events(SID, limit=2)
    assert [e["id"] for e in tail] == ["evt_3", "evt_4"]
    assert [e["seq"] for e in tail] == [4, 5]

    reviews = events_mod.read_events(SID, types=["review"])
    assert [e["id"] for e in reviews] == ["evt_1", "evt_3"]
    assert all(e["type"] == "review" for e in reviews)


# ---- 13. T101 recipes_before：合法 list 落盘 / 列表剥离 / event_id 带出 ----


def test_apply_report_recipes_before_stored_and_stripped(client, events_dir):
    recipes = [{"id": "r1", "name": "泰勒展开", "formulas": ["f(a+h)=f(a)+f'(a)h"]}]
    response = client.post("/api/harness/graph/apply_report", json={
        "session_id": SID, "event_id": "evt_review_r1",
        "applied_ops": [GEN_OPS[0]], "before_snapshot": SNAPSHOT,
        "recipes_before": recipes, "mode": "all", "summary": "带配方库前态的批次",
    })
    assert response.status_code == 200, response.text
    evt_id = response.json()["event_id"]
    assert evt_id

    # 事件文件里确实存了该字段（读原始 JSONL，不经 read_events 的剥字段逻辑）
    raw = [json.loads(line) for line
           in (events_dir / f"{SID}.jsonl").read_text(encoding="utf-8").splitlines()
           if line.strip()]
    assert len(raw) == 1
    assert raw[0]["recipes_before"] == recipes

    # 列表查询（types=applied）：recipes_before 与 before_snapshot 一并剥掉
    listed = client.get("/api/harness/graph/events",
                        params={"session_id": SID, "types": "applied"}).json()["events"]
    assert len(listed) == 1
    assert "recipes_before" not in listed[0]
    assert "before_snapshot" not in listed[0]

    # include_snapshot=1：recipes_before 跟随同一开关带出
    with_snap = client.get("/api/harness/graph/events",
                           params={"session_id": SID, "types": "applied",
                                   "include_snapshot": "1"}).json()["events"]
    assert with_snap[0]["recipes_before"] == recipes
    assert with_snap[0]["before_snapshot"] == SNAPSHOT

    # event_id 精确查询（隐含 include_snapshot）：带出
    one = client.get("/api/harness/graph/events",
                     params={"session_id": SID, "event_id": evt_id}).json()["events"]
    assert len(one) == 1
    assert one[0]["recipes_before"] == recipes
    assert one[0]["before_snapshot"] == SNAPSHOT


# ---- 14. T101 recipes_before：形状不对 / 空 list / 超上限一律不落字段 ----


def test_apply_report_recipes_before_bad_shapes_dropped(client, events_dir):
    for bad in ({"r1": {"name": "泰勒展开"}}, "泰勒展开", None):
        response = client.post("/api/harness/graph/apply_report", json={
            "session_id": SID, "applied_ops": [GEN_OPS[0]], "recipes_before": bad})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "ok"
        evt = events_mod.read_events(SID, event_id=response.json()["event_id"])[0]
        assert "recipes_before" not in evt


def test_apply_report_recipes_before_over_cap_dropped(client, events_dir):
    for bad in ([], [{"id": f"r{i}"} for i in range(201)]):
        response = client.post("/api/harness/graph/apply_report", json={
            "session_id": SID, "applied_ops": [], "recipes_before": bad})
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "ok"
        evt = events_mod.read_events(SID, event_id=response.json()["event_id"])[0]
        assert "recipes_before" not in evt
