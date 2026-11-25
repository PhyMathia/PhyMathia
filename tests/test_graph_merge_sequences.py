"""图谱合并的**序列**与**字段边界**回归（2026-11-25，承接 test_graph_merge.py）。

为什么另开一份：`test_graph_merge.py` 覆盖的是**单次**合并的每个分支（快路径、
四象限胜负、无 base 五条保守阶梯、墓碑增删、路由层与 T525 并发），但「多轮交替
保存」「墓碑之后再被旧副本冲击」「合并结果再喂一次」这类**序列**没有覆盖——而
丢内容的真实发生方式恰是序列：用户不会只保存一次。

本文件钉死四组：

1. 两设备三轮交错保存：各自只改自己的节点，任何一轮都不许把对方改动冲掉；
2. 墓碑与新增同包：一个 payload 里删 a、加 c，两者都要正确落地；
3. 墓碑有效期内被旧副本冲击：揣着被删节点来保存，不许复活它；
4. `_VIEW_KEYS` 白名单边界：内容留对端时**只有白名单内的字段听本次保存**，
   白名单外的自定义字段跟随内容那侧（＝丢本端的值）。

第 4 组钉的是一个**隐性契约**：前端新增「纯视图字段」（坐标/尺寸/折叠这类拖一
下就变、不该算内容改动的字段）必须同步 `_VIEW_KEYS`，否则合并时静默丢值。当前
白名单是 8 个；`test_view_key_whitelist_size_is_intentional` 把它钉在 8 并说明
加字段要想清楚——改它请连同前端 `_graphNodeSig` 的口径一起看。
"""

import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)
SRC = os.path.join(ROOT, "src")
if SRC not in sys.path:
    sys.path.insert(0, SRC)

from server.graph_merge import _VIEW_KEYS, merge_graph_states  # noqa: E402

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


def save(server, incoming, base_sigs):
    """模拟一次 POST /api/kv/graph:<sid>：返回落盘后的服务端状态与是否合并。"""
    merged, did = merge_graph_states(server, incoming, base_sigs)
    return merged, did


def contents_of(state_):
    return [(n["id"], n["content"]) for n in state_["customNodes"]]


# ---- 1. 两设备三轮交错 ----

def test_three_round_interleaved_saves_keep_both_edits():
    """A、B 各改自己的节点、交替保存三轮，两人的改动都要活到最后。

    这是「旧设备抹掉新内容」在多轮下的形态：A 的 base 在 B 保存后就过期了，
    它下一次整图保存若按「本次全量胜」就冲掉 B；按节点签名判胜负才保得住。
    """
    server = state([node("a", "A0"), node("b", "B0")], 1000, {"a": "s-A0", "b": "s-B0"})
    base_a = dict(server["nodeSigs"])
    base_b = dict(server["nodeSigs"])

    # 轮 1：A 改 a。base 与服务端一致＝没人插队 → 快路径（不做合并，整份照存）
    server, did = save(server, state([node("a", "A1"), node("b", "B0")], 2000,
                                    {"a": "s-A1", "b": "s-B0"}), base_a)
    assert did is False, "没人插队的第一笔保存应走快路径"
    base_a = dict(server["nodeSigs"])

    # 轮 2：B 改 b（B 的 base 还是轮 1 之前的，已过期）
    server, did = save(server, state([node("a", "A0"), node("b", "B1")], 3000,
                                    {"a": "s-A0", "b": "s-B1"}), base_b)
    assert did is True
    base_b = dict(server["nodeSigs"])
    # B 的 a 是旧值、且 B 没改过它 → 内容必须留服务端的 A1
    assert contents_of(server) == [("a", "A1"), ("b", "B1")]

    # 轮 3：A 揣着更旧的快照再存（长开标签页），b 仍是 B0
    server, did = save(server, state([node("a", "A1"), node("b", "B0")], 4000,
                                    {"a": "s-A1", "b": "s-B0"}), base_a)
    assert did is True
    assert contents_of(server) == [("a", "A1"), ("b", "B1")], "轮 3 把 B 的改动冲掉了"


def test_interleaved_saves_converge_to_same_state():
    """两个设备各自拿最终状态再存一次，结果必须一致（收敛，不是各说各话）。"""
    server = state([node("a", "A0"), node("b", "B0")], 1000, {"a": "s-A0", "b": "s-B0"})
    base = dict(server["nodeSigs"])
    server, _ = save(server, state([node("a", "A1"), node("b", "B0")], 2000,
                                  {"a": "s-A1", "b": "s-B0"}), base)
    base = dict(server["nodeSigs"])
    server, _ = save(server, state([node("a", "A1"), node("b", "B1")], 3000,
                                  {"a": "s-A1", "b": "s-B1"}), base)
    base = dict(server["nodeSigs"])

    # 设备 A 拿合并结果原样再存，设备 B 也拿它原样再存——两次都应是快路径、结果不变
    snapshot = state(server["customNodes"], 4000, dict(server["nodeSigs"]))
    after_a, did_a = save(server, snapshot, base)
    after_b, did_b = save(server, snapshot, base)
    assert did_a is False and did_b is False
    assert contents_of(after_a) == contents_of(after_b) == [("a", "A1"), ("b", "B1")]


# ---- 2. 墓碑与新增同包 ----

def test_delete_and_add_in_same_payload():
    """一个 payload 里同时删 a、加 c：a 要消失且留墓碑，c 要留下。"""
    server = state([node("a", "A"), node("b", "B")], 5000, {"a": "s-A", "b": "s-B"})
    incoming = state([node("b", "B"), node("c", "C")], 6000,
                     {"b": "s-B", "a": {"d": NOW}, "c": "s-C"})
    # base 里 b 是更早的签名＝前端基于旧版删除、服务端期间被别人动过 → 必须走慢合并
    merged, did = merge_graph_states(server, incoming, {"a": "s-A", "b": "s-OLDER"})
    assert did is True, "base 与服务端不一致时必须落慢合并（快路径会整份照存）"
    assert contents_of(merged) == [("b", "B"), ("c", "C")]
    assert merged["nodeSigs"]["a"] == {"d": NOW}, "墓碑没留下，对端会把 a 加回来"
    assert merged["nodeSigs"].get("c") == "s-C"


def test_tombstone_blocks_resurrection_from_stale_copy():
    """墓碑有效期内，任何揣着被删节点的旧副本都复活不了它。"""
    server = state([node("a", "A"), node("b", "B")], 5000, {"a": "s-A", "b": "s-B"})
    merged, _ = merge_graph_states(
        server,
        # 本端只带 b（a 已删），签名表里 a 是墓碑；base 的 b 过期 → 走慢合并
        state([node("b", "B")], 6000, {"b": "s-B", "a": {"d": NOW}}),
        {"a": "s-A", "b": "s-OLDER"})
    assert contents_of(merged) == [("b", "B")]

    # 旧副本（不知道 a 被删）再来一次
    merged2, _ = merge_graph_states(
        merged,
        state([node("a", "A"), node("b", "B")], 7000, {"a": "s-A", "b": "s-B"}),
        {"a": "s-A", "b": "s-B"})
    assert contents_of(merged2) == [("b", "B")], "被删节点被旧副本复活了"


# ---- 3. 视图字段白名单边界 ----

def test_all_view_keys_follow_incoming_when_content_kept():
    """内容留对端时，白名单内的视图字段全部听本次保存（不是只有 x/y）。"""
    server = state([node("a", "对端新内容")], 5000, {"a": "s-new"})
    geometry = {"x": 11, "y": 22, "w": 333, "h": 444, "minimized": True,
                "hidden": True, "pinned": True, "z": 9}
    incoming = state([node("a", "旧内容", **geometry)], 6000, {"a": "s-old"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s-old"})
    kept = merged["customNodes"][0]
    assert kept["content"] == "对端新内容"
    for key in _VIEW_KEYS:
        assert kept.get(key) == geometry[key], f"视图字段 {key} 没听本次保存"


def test_non_view_custom_field_follows_content_side():
    """**边界口径**：白名单外的自定义字段跟随内容那侧，本端的值会丢。

    这不是缺陷，是「只有视图字段才听当前设备」的必然结果——内容整体取对端那版，
    自然连它带的自定义字段一起取。钉死它是因为它是隐性契约：前端要给节点加
    「纯视图」字段，必须同步 `_VIEW_KEYS`，否则拖一下这个字段就会在合并里丢掉。
    """
    server = state([node("a", "对端新内容")], 5000, {"a": "s-new"})
    incoming = state([node("a", "旧内容", x=11, otherField="本端的值")], 6000, {"a": "s-old"})
    merged, _ = merge_graph_states(server, incoming, {"a": "s-old"})
    kept = merged["customNodes"][0]
    assert kept["content"] == "对端新内容"
    assert kept["x"] == 11, "视图字段仍听本端"
    assert "otherField" not in kept, "白名单外字段跟随内容侧（服务端那版没有它）"


def test_view_key_whitelist_size_is_intentional():
    """白名单是 8 个：加字段前先想清楚「拖一下就变、不该算内容改动」这条判据。

    改这个数字要同时看前端 `_graphNodeSig` 覆盖哪些字段——两边口径必须一致，
    否则前端认为「没改内容」、后端却当成「视图字段」听着本次保存，或反之。
    """
    assert len(_VIEW_KEYS) == 8, f"视图字段白名单变了（{_VIEW_KEYS}）：确认前端 _graphNodeSig 口径同步"


# ---- 4. 合并结果再喂一次 ----

def test_merge_result_is_idempotent_via_fast_path():
    """把合并结果当新的一版再存一次：必须走快路径、结果一字不变。"""
    m1, _ = merge_graph_states(
        state([node("a", "A")], 9000, {"a": "s-a"}),
        state([node("a", "A2")], 9100, {"a": "s-a2"}),
        {"a": "s-a"})
    m2, did = merge_graph_states(m1, state(m1["customNodes"], 9200, dict(m1["nodeSigs"])),
                                 dict(m1["nodeSigs"]))
    assert did is False, "合并结果再存一次走了慢合并，说明签名表没自洽"
    assert contents_of(m2) == contents_of(m1)
    assert m2["nodeSigs"] == m1["nodeSigs"]
