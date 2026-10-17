"""画布图状态跨设备节点级合并（T360，2026-10-17）。

背景：`graph:<sid>` 这一份 KV 里装着整张画布（节点内容、连线、分组、视口……），前端
历来是「整图 updatedAt 定胜负、之后任意一次保存全量覆写」。于是旧设备/长开的旧标签页
只要碰一下画布（连纯平移缩放也算一次保存），就能把另一台设备刚生成的节点内容整图抹掉。

这里把「节点内容」这一层改成三方合并：前端随包带上

- `base_node_sigs`：那一版里各节点的**内容签名**（前端算，键＝节点 id）＝「我上次同步时
  服务端是什么」；
- `value.nodeSigs`：本次各节点的内容签名（缺失的 id 带 `{"d": 时间戳}`＝本设备删了它）。

服务端只做比较、不自己算签名（JS/Python 的 JSON 序列化不规范一致，签名一律由前端算并
随包携带）。规则（记 `mine` ＝本次保存、`theirs` ＝服务端现值、`base` ＝前端那一版）：

1. `base` 非空且与服务端签名表逐项相同 → 服务端就是我这次保存基于的那一版，整份照存
   （快路径。**判据只能是签名表**：一旦发生过合并，服务端的 `updatedAt` 会等于本端那次
   保存的值，而内容其实留了对方那版——按版本号放行会让下一拍整图把对方内容盖掉，
   2026-10-17 真机两设备复现）；
2. 同一节点两侧都有：
   - 对端改过、本端没改 → 留对端（**这就是要堵的丢内容**）；
   - 本端改过、对端没改（或两侧都改过）→ 用本次保存（并发编辑仍按最后写入者胜）；
   - 两侧都没改 → 用本次保存（内容一致，只是顺带更新坐标等视图字段）；
   - 没有 base 记录（旧数据/首次同步）→ 内容一空一满时留满的那侧，其余用本次保存；
3. 节点只在服务端有：本端签名为墓碑、或本端 base 里本来有它 → 视为本端删除
   （但对方改过就留对方的：编辑胜过删除）；否则是对方新加的，留着；
4. 节点只在本端有 → 留着（新增）；
5. 视口/分组等其余字段一律用本次保存（布局是「正看着画布的那台设备」说了算），
   `updatedAt` 取两侧较大值。

签名只覆盖内容字段——坐标/尺寸/折叠属于纯视图字段（同 harness 的画布指纹口径），
拖一下节点不该让它看起来「被改过」。这个口径由前端 `_graphNodeSig` 定，服务端不重算。

明确不做的边界（不比现状差，故留作后续）：连线/分组/Φ 状态等非节点字段仍是「本次保存
胜」；服务端删掉的节点，对端若不知道（签名表里没有墓碑）仍可能被它加回来（现状亦然）。
"""

from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)

# 删除墓碑过期时间：签名表里的 {"d": 时间戳} 超过它即回收（不然签名表只涨不消）。
# 与前端 session.js 的 GRAPH_NODE_TOMBSTONE_TTL_MS 对齐（30 天）。
TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000

# 节点上的纯视图字段：留对端内容时，这些仍听本次保存（正看着画布的那台设备）
_VIEW_KEYS = ("x", "y", "w", "h", "minimized", "hidden", "pinned", "z")


def _node_index(nodes):
    """{id: node}；无 id 的条目丢掉（合并没有它可以落点）。"""
    out = {}
    if not isinstance(nodes, list):
        return out
    for node in nodes:
        if isinstance(node, dict) and node.get("id") is not None:
            out[str(node["id"])] = node
    return out


def _sig_at(sigs, node_id):
    """取签名表条目（可能是内容签名，也可能是墓碑），没有则 None。"""
    if not isinstance(sigs, dict):
        return None
    return sigs.get(node_id) if node_id in sigs else None


def is_tombstone(entry):
    """签名表里的删除墓碑：{"d": 时间戳}。"""
    return isinstance(entry, dict) and entry.get("d") is not None


def _tombstone_fresh(entry, now_ms):
    try:
        at = float(entry.get("d"))
    except (TypeError, ValueError):
        return False
    return (now_ms - at) <= TOMBSTONE_TTL_MS


def _node_text(node):
    if not isinstance(node, dict):
        return ""
    return str(node.get("content") or "").strip()


def _generated_at(node):
    """节点正文的生成时刻（AI 生成时打）；没有就 None。"""
    if not isinstance(node, dict):
        return None
    value = node.get("generatedAt")
    if isinstance(value, bool) or value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _keep_incoming_geometry(server_node, incoming_node):
    """内容留服务端那版，坐标/尺寸/折叠等视图字段仍听本次保存。"""
    merged = dict(server_node)
    for key in _VIEW_KEYS:
        if key in incoming_node:
            merged[key] = incoming_node[key]
    return merged


def _sigs_equal(left, right) -> bool:
    """两张签名表逐项相同（值可能是字符串签名，也可能是 {"d": 时间戳} 墓碑）。"""
    if not isinstance(left, dict) or not isinstance(right, dict):
        return False
    if len(left) != len(right):
        return False
    for key, value in left.items():
        other = right.get(key)
        if isinstance(value, dict) or isinstance(other, dict):
            if not (isinstance(value, dict) and isinstance(other, dict)):
                return False
            if int(float(value.get("d", 0))) != int(float(other.get("d", 0))):
                return False
            continue
        if value != other:
            return False
    return True


def _merged_updated_at(server, incoming):
    """合并后的 updatedAt：取两侧较大值（老设备时钟落后时也别把版本号写回去）。"""
    try:
        return int(max(float(server.get("updatedAt") or 0), float(incoming.get("updatedAt") or 0)))
    except (TypeError, ValueError):
        return incoming.get("updatedAt")


def merge_graph_states(server, incoming, base_node_sigs=None, now_ms=None):
    """合并一份画布状态，返回 (merged_state, merged_flag)。

    `merged_flag` 为 False＝快路径/没得合并（调用方照原样存 incoming 即可）。
    """
    if not isinstance(incoming, dict):
        return server, False
    if not isinstance(server, dict):
        return incoming, False
    # 快路径：本端 base 签名表非空且与服务端现值逐项一致——服务端就是这次保存基于的那一版。
    # 空 base（旧数据首同步）不许走快路径：那正是要按下面的保守判据合并的一格。
    if base_node_sigs and _sigs_equal(base_node_sigs, server.get("nodeSigs")):
        incoming["updatedAt"] = _merged_updated_at(server, incoming)
        return incoming, False

    base = base_node_sigs if isinstance(base_node_sigs, dict) else {}
    server_nodes = _node_index(server.get("customNodes"))
    incoming_nodes = _node_index(incoming.get("customNodes"))
    server_sigs = server.get("nodeSigs") if isinstance(server.get("nodeSigs"), dict) else {}
    incoming_sigs = incoming.get("nodeSigs") if isinstance(incoming.get("nodeSigs"), dict) else {}
    now = int(now_ms if now_ms is not None else time.time() * 1000)

    merged = dict(incoming)
    merged_sigs = {}
    out_nodes = []
    out_ids = set()

    def _take(node, sig):
        out_nodes.append(node)
        out_ids.add(str(node.get("id")))
        if sig is not None:
            merged_sigs[str(node.get("id"))] = sig

    for node_id, node in incoming_nodes.items():
        theirs = server_nodes.get(node_id)
        if theirs is None:
            # 本端带着这颗节点来，服务端却没有：若是别的设备留下的墓碑（且本端没改过，
            # 只是揣着旧副本），就按删除处理——别让它把删掉的节点复活。
            server_tomb = _sig_at(server_sigs, node_id)
            if is_tombstone(server_tomb):
                mine_changed = (node_id in base) and _sig_at(incoming_sigs, node_id) != base.get(node_id)
                if not mine_changed:
                    continue
            _take(node, _sig_at(incoming_sigs, node_id))  # 本端新增
            continue
        base_known = node_id in base
        mine_changed = (not base_known) or _sig_at(incoming_sigs, node_id) != base.get(node_id)
        theirs_changed = base_known and _sig_at(server_sigs, node_id) != base.get(node_id)
        if base_known and theirs_changed and not mine_changed:
            # 对端改过、本端没动：内容留对端（T360 要堵的那条）
            _take(_keep_incoming_geometry(theirs, node), _sig_at(server_sigs, node_id))
            continue
        if not base_known:
            # 没有 base 可比（T360 之前的旧数据，第一次保存）：本端证明不了「这颗是我刚改的」，
            # 用几条保守判据代替，宁可留服务端那版也别拿旧副本盖掉——顺序：
            #   ①一边空一边满 → 留满的（用户报的正是「屏幕有字、盘上回空」这一格）
            #   ②内容一样 → 无所谓，按本次保存（顺带更新坐标）
            #   ③人工定稿那侧权威（T355 口径：人工内容不许被 AI/旧副本盖掉）
            #   ④两边都有生成时刻且不同 → 留新的
            #   ⑤其余仍按本次保存（与旧口径一致的 LWW）
            mine_text = _node_text(node)
            theirs_text = _node_text(theirs)
            if not mine_text and theirs_text:
                keep_theirs = True
            elif mine_text == theirs_text:
                keep_theirs = False
            elif bool(theirs.get("humanDone")) and not bool(node.get("humanDone")):
                keep_theirs = True
            else:
                mine_at = _generated_at(node)
                theirs_at = _generated_at(theirs)
                keep_theirs = mine_at is not None and theirs_at is not None and theirs_at > mine_at
            if keep_theirs:
                _take(_keep_incoming_geometry(theirs, node), _sig_at(server_sigs, node_id))
                continue
        _take(node, _sig_at(incoming_sigs, node_id))

    for node_id, node in server_nodes.items():
        if node_id in incoming_nodes:
            continue
        tomb = _sig_at(incoming_sigs, node_id)
        base_known = node_id in base
        # 本端说「我删了它」（墓碑），或本端 base 里本来有、现在没了（同样是删）
        deleted_by_incoming = is_tombstone(tomb) or base_known
        if not deleted_by_incoming:
            _take(node, _sig_at(server_sigs, node_id))  # 对端新加、本端没见过：留着
            continue
        theirs_changed = base_known and _sig_at(server_sigs, node_id) != base.get(node_id)
        if theirs_changed:
            _take(node, _sig_at(server_sigs, node_id))  # 对方在删之后改过：编辑胜过删除
            continue
        # 删除生效：不留该节点的签名；墓碑未过期就继续留在表里挡别处复活
        if is_tombstone(tomb) and _tombstone_fresh(tomb, now):
            merged_sigs[node_id] = {"d": int(float(tomb.get("d")))}

    # 两侧的墓碑（未过期、且该节点确实不在合并结果里）都留：别再被谁加回来
    for sigs in (server_sigs, incoming_sigs):
        if not isinstance(sigs, dict):
            continue
        for node_id, entry in sigs.items():
            if node_id in merged_sigs or node_id in out_ids:
                continue
            if is_tombstone(entry) and _tombstone_fresh(entry, now):
                merged_sigs[node_id] = {"d": int(float(entry.get("d")))}

    merged["customNodes"] = out_nodes
    merged["nodeSigs"] = merged_sigs
    merged["updatedAt"] = _merged_updated_at(server, incoming)
    return merged, True
