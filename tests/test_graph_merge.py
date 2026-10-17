"""画布图状态跨设备节点级合并（T360，2026-10-17）回归。

两层：
- 纯函数层（server/graph_merge.py）：快路径、对端改过留对端（丢内容的正主）、
  本端改过用本端、无 base 时空卡不盖有内容、删除墓碑与「编辑胜过删除」、墓碑回收；
- 路由层：POST /api/kv/graph:<sid> 带 graph_merge 时真走合并并回传 updatedAt
  （前端拿它当下一次保存的 base），不带 graph_merge 的旧口径保存一字不变。
"""

import os
import sys
import time

from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from server.graph_merge import merge_graph_states  # noqa: E402
from server.session_routes import router  # noqa: E402

DAY_MS = 24 * 3600 * 1000
# 墓碑新鲜度按真实毫秒时钟判（TOMBSTONE_TTL_MS＝30 天），夹具的时间戳必须贴着 now
NOW = int(time.time() * 1000)


def node(node_id, content, **extra):
    item = {"id": node_id, "kind": "module", "content": content, "x": 0, "y": 0}
    item.update(extra)
    return item


def state(nodes, updated_at=1000, sigs=None, **extra):
    item = {
        "customNodes": nodes,
        "nodeSigs": sigs if sigs is not None else {str(n["id"]): "sig-" + str(n["content"]) for n in nodes},
        "updatedAt": updated_at,
        "pan": {"x": 1, "y": 2},
        "zoom": 0.9,
    }
    item.update(extra)
    return item


# ---- 1. 快路径 ----


def test_fast_path_when_base_sigs_match_server():
    """base 签名表与服务端现值逐项一致＝没人插过队：整份照存，不做合并。"""
    server = state([node("a", "A")], updated_at=1000, sigs={"a": "s-a"})
    incoming = state([node("a", "A2")], updated_at=2000, sigs={"a": "s-a2"})
    merged, did = merge_graph_states(server, incoming, {"a": "s-a"})
    assert did is False
    assert merged is incoming


def test_fast_path_requires_agreement_not_timestamp():
    """快路径判据只能是签名表：合并过的服务端 updatedAt 等于本端那次保存的值，
    按版本号放行会让下一拍整图把对方内容盖掉（2026-10-17 真机两设备复现）。"""
    server = state([node("a", "对方那版")], updated_at=2000, sigs={"a": "s-theirs"})
    incoming = state([node("a", "本端旧副本")], updated_at=2000, sigs={"a": "s-mine"})
    merged, did = merge_graph_states(server, incoming, {"a": "s-mine"})  # 就是没有快路径太空
    assert did is True
    assert merged["customNodes"][0]["content"] == "对方那版"


def test_no_fast_path_for_empty_base():
    """空 base（旧数据首同步）不许走快路径：那正是要走保守判据的一格。"""
    server = state([node("a", "有内容")], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "")], updated_at=6000, sigs={"a": "s-empty"})
    merged, did = merge_graph_states(server, incoming, {})
    assert did is True
    assert merged["customNodes"][0]["content"] == "有内容"
    # 服务端侧签名表本来就空（全新画布）→ 也走合并，结果与本次保存一致
    merged2, did2 = merge_graph_states({"updatedAt": 3}, state([node("a", "A")], updated_at=4), {})
    assert did2 is True and merged2["customNodes"][0]["content"] == "A"


# ---- 2. 节点级胜负 ----


def test_other_side_touched_keeps_other_side():
    """旧设备整图覆盖的场景：本地那一版没动过这颗节点，服务端改过 → 内容留服务端。

    这正是 T359/T360 报的「另一台设备刚生成的节点内容被抹掉」——修复前这一格会
    被本地空/旧内容盖掉。坐标等视图字段仍听本次保存。
    """
    server = state([node("a", "新生成的内容", x=10, y=20)], updated_at=5000, sigs={"a": "s-new"})
    incoming = state([node("a", "旧内容", x=99, y=88)], updated_at=6000, sigs={"a": "s-old"})
    merged, did = merge_graph_states(server, incoming, {"a": "s-old"})
    assert did is True
    assert [n["content"] for n in merged["customNodes"]] == ["新生成的内容"]
    assert merged["customNodes"][0]["x"] == 99 and merged["customNodes"][0]["y"] == 88
    assert merged["nodeSigs"] == {"a": "s-new"}


def test_other_side_emptied_does_not_win():
    """对端把节点清空了（生成开跑）也算「对端改过」：本端没动过就该留服务端那版。"""
    server = state([node("a", "")], updated_at=5000, sigs={"a": "s-empty"})
    incoming = state([node("a", "旧内容")], updated_at=6000, sigs={"a": "s-old"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s-old"})
    assert merged["customNodes"][0]["content"] == ""


def test_mine_touched_wins():
    """本端改过、对端没动：用本次保存（内容与坐标都要）。"""
    server = state([node("a", "旧内容")], updated_at=5000, sigs={"a": "s-old"})
    incoming = state([node("a", "我刚写的")], updated_at=6000, sigs={"a": "s-mine"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s-old"})
    assert merged["customNodes"][0]["content"] == "我刚写的"


def test_both_touched_last_writer_wins():
    server = state([node("a", "对端写的")], updated_at=5000, sigs={"a": "s-theirs"})
    incoming = state([node("a", "我写的")], updated_at=6000, sigs={"a": "s-mine"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s-base"})
    assert merged["customNodes"][0]["content"] == "我写的"


def test_neither_touched_keeps_incoming_layout():
    server = state([node("a", "一样的内容", x=10)], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "一样的内容", x=42)], updated_at=6000, sigs={"a": "s-a"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s-a"})
    assert merged["customNodes"][0]["x"] == 42
    assert merged["nodeSigs"] == {"a": "s-a"}


def test_no_base_legacy_ladder():
    """没有 base 记录（T360 之前的旧数据首次保存）的保守判据阶梯。

    旧设备那台连签名表都没有，证明不了「这颗节点是我刚改的」——此时宁可留服务端
    那版，也不能拿旧副本把用户刚生成/人工定稿的内容盖掉。
    """
    # ①空 vs 满：留满的（用户报的正是这一格：屏幕上见过字、盘上回空）
    server = state([node("a", "服务端有内容")], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "")], updated_at=6000, sigs={"a": "s-empty"})
    assert merge_graph_states(server, incoming, {})[0]["customNodes"][0]["content"] == "服务端有内容"
    # ②内容一致：按本次保存（只是顺带更新坐标）
    server = state([node("a", "一样", x=1)], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "一样", x=88)], updated_at=6000, sigs={"a": "s-a"})
    assert merge_graph_states(server, incoming, {})[0]["customNodes"][0]["x"] == 88
    # ③人工定稿那侧权威（T355 口径）
    server = state([node("a", "人工写的", humanDone=True)], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "旧的 AI 草稿")], updated_at=6000, sigs={"a": "s-b"})
    assert merge_graph_states(server, incoming, {})[0]["customNodes"][0]["content"] == "人工写的"
    # ④都有生成时刻：留新的（旧设备那次「刚生成」比服务端新时仍然算数）
    server = state([node("a", "服务端旧文", generatedAt=1000)], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "本端刚生成的", generatedAt=2000)], updated_at=6000, sigs={"a": "s-b"})
    assert merge_graph_states(server, incoming, {})[0]["customNodes"][0]["content"] == "本端刚生成的"
    server = state([node("a", "服务端刚生成的", generatedAt=2000)], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "本端旧文", generatedAt=1000)], updated_at=6000, sigs={"a": "s-b"})
    assert merge_graph_states(server, incoming, {})[0]["customNodes"][0]["content"] == "服务端刚生成的"
    # ⑤其余仍按本次保存（旧口径 LWW）
    server = state([node("a", "服务端手写", status="done")], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "本端手写", status="done")], updated_at=6000, sigs={"a": "s-b"})
    assert merge_graph_states(server, incoming, {})[0]["customNodes"][0]["content"] == "本端手写"


def test_no_base_empty_does_not_cover_content():
    """没有 base 记录（旧数据首同步）：空卡不许盖掉有内容的。"""
    server = state([node("a", "有内容")], updated_at=5000, sigs={"a": "s-a"})
    incoming = state([node("a", "")], updated_at=6000, sigs={"a": "s-empty"})
    merged, _ = merge_graph_states(server, incoming, {})
    assert merged["customNodes"][0]["content"] == "有内容"
    # 反向：本端有内容、服务端空 → 用本次保存
    server2 = state([node("a", "")], updated_at=5000, sigs={"a": "s-empty"})
    incoming2 = state([node("a", "有内容")], updated_at=6000, sigs={"a": "s-a"})
    merged2, _ = merge_graph_states(server2, incoming2, {})
    assert merged2["customNodes"][0]["content"] == "有内容"


# ---- 3. 增删 ----


def test_server_only_node_kept():
    """服务端新加的节点、本端从没见过：留着（旧设备保存不再把它整颗抹掉）。"""
    server = state([node("keep", "对端新加")], updated_at=5000, sigs={"keep": "s-k"})
    incoming = state([node("mine", "本端的")], updated_at=6000, sigs={"mine": "s-m"})
    merged, _ = merge_graph_states(server, incoming, {"mine": "s-m"})
    ids = sorted(n["id"] for n in merged["customNodes"])
    assert ids == ["keep", "mine"]
    assert merged["nodeSigs"]["keep"] == "s-k"


def test_deleted_node_stays_deleted():
    """本端删掉的节点（签名表里留墓碑）不许被服务端那版加回来。"""
    server = state([node("gone", "旧内容"), node("live", "在")], updated_at=5000,
                   sigs={"gone": "s-g", "live": "s-l"})
    incoming = state([node("live", "在")], updated_at=6000,
                     sigs={"live": "s-l", "gone": {"d": NOW}})
    merged, _ = merge_graph_states(server, incoming, {"gone": "s-g", "live": "s-l"})
    assert [n["id"] for n in merged["customNodes"]] == ["live"]
    # 墓碑继续留在表里挡对端复活
    assert merged["nodeSigs"]["gone"] == {"d": NOW}


def test_deleted_but_other_side_edited_keeps_edit():
    """删了之后对方改过：编辑胜过删除（否则对端的劳动白费）。"""
    server = state([node("x", "对方刚改的")], updated_at=5000, sigs={"x": "s-theirs"})
    incoming = state([], updated_at=6000, sigs={"x": {"d": NOW}})
    merged, _ = merge_graph_states(server, incoming, {"x": "s-base"})
    assert [n["content"] for n in merged["customNodes"]] == ["对方刚改的"]


def test_stale_client_resurrect_is_blocked_by_server_tombstone():
    """服务端已有墓碑（别的设备删了），旧设备还揣着那颗节点来保存：按墓碑丢弃。"""
    server = state([], updated_at=5000, sigs={"gone": {"d": NOW - 1000}})
    incoming = state([node("gone", "旧设备还留着")], updated_at=6000, sigs={"gone": "s-old"})
    merged, _ = merge_graph_states(server, incoming, {"gone": "s-old"})
    assert merged["customNodes"] == []
    assert merged["nodeSigs"]["gone"] == {"d": NOW - 1000}


def test_expired_tombstone_recycled():
    server = state([], updated_at=5000, sigs={"old": {"d": 1000}})
    incoming = state([], updated_at=6000, sigs={})
    merged, _ = merge_graph_states(server, incoming, {"old": "s-old"}, now_ms=NOW + 31 * DAY_MS)
    assert "old" not in merged["nodeSigs"]


def test_non_node_fields_follow_incoming():
    """连线/分组/视口等非节点字段仍是本次保存胜（与旧口径一致，不在本轮范围）。"""
    server = state([node("a", "A")], updated_at=5000, connections=[{"from": "a", "to": "b"}], zoom=0.5)
    incoming = state([node("a", "A")], updated_at=6000, connections=[], zoom=1.5)
    merged, _ = merge_graph_states(server, incoming, {"a": "s-a"})
    assert merged["connections"] == []
    assert merged["zoom"] == 1.5


def test_updated_at_takes_max():
    server = state([node("a", "A")], updated_at=9000, sigs={"a": "s"})
    incoming = state([node("a", "A")], updated_at=6000, sigs={"a": "s"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s"})
    assert merged["updatedAt"] == 9000


def test_garbage_inputs_do_not_raise():
    assert merge_graph_states(None, {"a": 1}, {})[0] == {"a": 1}
    assert merge_graph_states({"updatedAt": 1}, "nope", {})[0] == {"updatedAt": 1}
    merged, did = merge_graph_states(
        {"customNodes": "坏", "updatedAt": 5},
        {"customNodes": [{"no": "id"}, node("a", "A")], "updatedAt": 6},
        None,
    )
    assert did is True and [n["id"] for n in merged["customNodes"]] == ["a"]


# ---- 4. 路由层 ----


def _client():
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_route_merges_and_returns_updated_at():
    client = _client()
    server_state = state([node("a", "服务器上的新内容", x=10)], updated_at=5000, sigs={"a": "s-new"})
    assert client.post("/api/kv/graph:sess_t360", json={"value": server_state}).status_code == 200
    incoming = state([node("a", "本地旧内容", x=77)], updated_at=6000, sigs={"a": "s-old"})
    resp = client.post("/api/kv/graph:sess_t360", json={
        "value": incoming,
        "graph_merge": {"base_node_sigs": {"a": "s-old"}},
    })
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["merged"] is True
    assert body["updatedAt"] == 6000
    stored = client.get("/api/kv/graph:sess_t360").json()["value"]
    assert stored["customNodes"][0]["content"] == "服务器上的新内容"
    assert stored["customNodes"][0]["x"] == 77


def test_route_without_merge_info_stores_as_is():
    """旧口径保存（启动清扫直连/老前端）一字不变：整份照存。"""
    client = _client()
    plain = state([node("a", "本地")], updated_at=7000, sigs={"a": "s-a"})
    assert client.post("/api/kv/graph:sess_t360b", json={"value": plain}).status_code == 200
    stored = client.get("/api/kv/graph:sess_t360b").json()["value"]
    assert stored == plain
    # 非 graph: 键带 graph_merge 也不进合并分支
    assert client.post("/api/kv/other_key", json={
        "value": {"v": 1}, "graph_merge": {"base_node_sigs": {"a": "s"}},
    }).status_code == 200
    assert client.get("/api/kv/other_key").json()["value"] == {"v": 1}


def test_route_merge_failure_falls_back_to_plain_store(monkeypatch):
    """合并抛错不能让保存失败：退回整份照存（旧口径）并留日志。"""
    from server import session_routes as routes_mod

    def boom(*args, **kwargs):
        raise RuntimeError("merge exploded")

    monkeypatch.setattr(routes_mod.graph_merge, "merge_graph_states", boom)
    client = _client()
    assert client.post("/api/kv/graph:sess_t360", json={
        "value": {"customNodes": [], "updatedAt": 9000,
                  "nodeSigs": {"a": "s"}},
        "graph_merge": {"base_node_sigs": {"a": "x"}},
    }).status_code == 200
    stored = client.get("/api/kv/graph:sess_t360").json()["value"]
    assert stored["updatedAt"] == 9000
