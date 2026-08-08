"""Pure graph snapshot and operation handling.

This module intentionally has no dependency on PhyMathia UI code. It works
with a small semantic graph contract so the harness can be reused elsewhere.
"""

from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Optional


ALLOWED_NODE_KINDS = {
    "blank",
    "user",
    "answer",
    "module",
    "hub",
    "summary",
    "note",
    "source",
    "knowledge",
    "relation",
    "human_note",
    "ai_eval",
}

ALLOWED_CREATE_KINDS = {
    "blank",
    "module",
    "user",
    "answer",
    "hub",
    "summary",
    "note",
    "source",
    "knowledge",
    "relation",
    "human_note",
    "ai_eval",
}

ALLOWED_MODULE_KEYS = {
    "physics",
    "math",
    "graph",
    "viz",
    "socratic",
    "learn",
    "manual",
}

ALLOWED_OPERATIONS = {
    "create_node",
    "update_node",
    "delete_node",
    "add_edge",
    "remove_edge",
    "update_edge",
    "create_eval_node",
}

UPDATEABLE_NODE_FIELDS = {"label", "title", "content", "summary", "formula", "status"}
UPDATEABLE_EDGE_FIELDS = {"relation", "label"}

MAX_NODE_CONTENT_LENGTH = 1200
MAX_OPERATIONS = 80

# 大图守护：超过阈值时压缩非焦点节点，超过硬阈值直接拒绝
MAX_SNAPSHOT_CHARS = 40000
MAX_SNAPSHOT_HARD_CHARS = 60000
NON_FOCUS_CONTENT_CHARS = 120


def _text(value: Any, default: str = "") -> str:
    if value is None:
        return default
    return str(value).strip()


def _bool(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, bool):
        return value
    return str(value).lower() in {"1", "true", "yes", "y", "on"}


def _edge_key(from_id: str, to_id: str, from_port: str = "out-0", to_port: str = "in-0") -> str:
    return f"{from_id}:{from_port}->{to_id}:{to_port}"


def normalize_node(node: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(node, dict):
        return None
    node_id = _text(node.get("id") or node.get("node_id"))
    if not node_id:
        return None
    kind = _text(node.get("kind"), "knowledge")
    if kind not in ALLOWED_NODE_KINDS:
        kind = "knowledge"
    label = _text(node.get("label") or node.get("title") or node.get("name"))
    content = _text(node.get("content") or node.get("summary"))[:MAX_NODE_CONTENT_LENGTH]
    formula = _text(node.get("formula"))[:500]
    return {
        "id": node_id,
        "kind": kind,
        "label": label,
        "content": content,
        "formula": formula,
        "module_key": _text(node.get("module_key") or node.get("moduleKey")),
        "manual": _bool(node.get("manual")),
        "target_node_id": _text(node.get("target_node_id") or node.get("targetNodeId")),
        "target_label": _text(node.get("target_label") or node.get("targetLabel")),
        "suggestion": _text(node.get("suggestion")),
        "priority": _text(node.get("priority"), "medium"),
        "status": _text(node.get("status")),
        "read_only": _bool(node.get("read_only") or node.get("readOnly")),
    }


def normalize_edge(edge: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(edge, dict):
        return None
    from_id = _text(edge.get("from") or edge.get("source"))
    to_id = _text(edge.get("to") or edge.get("target"))
    if not from_id or not to_id:
        return None
    from_port = _text(edge.get("fromPort") or edge.get("from_port"), "out-0")
    to_port = _text(edge.get("toPort") or edge.get("to_port"), "in-0")
    key = _text(edge.get("key") or edge.get("edge_key") or _edge_key(from_id, to_id, from_port, to_port))
    return {
        "key": key,
        "from": from_id,
        "to": to_id,
        "fromPort": from_port,
        "toPort": to_port,
        "relation": _text(edge.get("relation")),
        "label": _text(edge.get("label")),
        "custom": _bool(edge.get("custom")),
    }


def normalize_snapshot(snapshot: Any) -> Dict[str, Any]:
    if not isinstance(snapshot, dict):
        snapshot = {}
    nodes: List[Dict[str, Any]] = []
    seen_node_ids = set()
    for raw_node in snapshot.get("nodes") or []:
        node = normalize_node(raw_node)
        if node and node["id"] not in seen_node_ids:
            seen_node_ids.add(node["id"])
            nodes.append(node)

    edges: List[Dict[str, Any]] = []
    seen_edge_keys = set()
    for raw_edge in snapshot.get("edges") or []:
        edge = normalize_edge(raw_edge)
        if edge and edge["key"] not in seen_edge_keys:
            seen_edge_keys.add(edge["key"])
            edges.append(edge)

    node_ids = {node["id"] for node in nodes}
    edges = [edge for edge in edges if edge["from"] in node_ids and edge["to"] in node_ids]

    return {"version": 1, "nodes": nodes, "edges": edges}


def normalize_operations(operations: Any) -> List[Dict[str, Any]]:
    if not isinstance(operations, list):
        return []
    result: List[Dict[str, Any]] = []
    for item in operations:
        if isinstance(item, dict):
            result.append(item)
    return result[:MAX_OPERATIONS]


def _next_temp_id(nodes: Dict[str, Any], index: int) -> str:
    candidate = f"hn_{time.time_ns()}_{index + 1}"
    suffix = 2
    while candidate in nodes:
        candidate = f"hn_{index + 1}_{suffix}"
        suffix += 1
    return candidate


def _operation_edge_key(op: Dict[str, Any], edges: Dict[str, Any]) -> Optional[str]:
    key = _text(op.get("edge_key") or op.get("key"))
    if key:
        return key
    from_id = _text(op.get("from") or op.get("source"))
    to_id = _text(op.get("to") or op.get("target"))
    if from_id and to_id:
        from_port = _text(op.get("fromPort") or op.get("from_port"), "out-0")
        to_port = _text(op.get("toPort") or op.get("to_port"), "in-0")
        candidate = _edge_key(from_id, to_id, from_port, to_port)
        if candidate in edges:
            return candidate
        return candidate
    return None


def build_next_snapshot(
    snapshot: Any,
    operations: Any,
    *,
    allow_read_only_delete: bool = True,
) -> Dict[str, Any]:
    """Validate operations and return the resulting snapshot.

    The original snapshot is not mutated. Invalid operations are skipped and
    reported in ``errors``. Valid operations are returned in ``operations``.
    """

    current = normalize_snapshot(snapshot)
    nodes: Dict[str, Dict[str, Any]] = {node["id"]: dict(node) for node in current["nodes"]}
    edges: Dict[str, Dict[str, Any]] = {edge["key"]: dict(edge) for edge in current["edges"]}
    ops = normalize_operations(operations)
    valid_ops: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    warnings: List[Dict[str, Any]] = []
    temp_to_assigned: Dict[str, str] = {}

    # ---- 冲突预检：同一批次内“既改又删 / 引用即将被删除的节点” ----
    blocked_indices: set = set()
    deleted_ids: set = set()
    for op in ops:
        if _text(op.get("op")) == "delete_node":
            node_id = _text(op.get("id"))
            if node_id:
                deleted_ids.add(node_id)
    for index, op in enumerate(ops):
        op_name = _text(op.get("op"))
        if op_name == "update_node" and _text(op.get("id")) in deleted_ids:
            errors.append({"index": index, "op": op_name, "reason": f"节点 {_text(op.get('id'))} 在同一批中将被删除，update 操作被跳过"})
            blocked_indices.add(index)
        elif op_name == "add_edge":
            from_id = _text(op.get("from") or op.get("source"))
            to_id = _text(op.get("to") or op.get("target"))
            if from_id in deleted_ids or to_id in deleted_ids:
                target = from_id if from_id in deleted_ids else to_id
                errors.append({"index": index, "op": op_name, "reason": f"add_edge 引用了即将被删除的节点 {target}，已跳过"})
                blocked_indices.add(index)

    def resolve_ref(value: Any) -> str:
        key = _text(value)
        return temp_to_assigned.get(key, key)

    for index, op in enumerate(ops):
        if index in blocked_indices:
            continue
        op_name = _text(op.get("op"))
        reason = _text(op.get("reason"))
        label = f"operation[{index}]"

        if op_name not in ALLOWED_OPERATIONS:
            errors.append({"index": index, "op": op_name, "reason": "不支持的操作类型"})
            continue
        if not reason:
            errors.append({"index": index, "op": op_name, "reason": "缺少修改理由"})
            continue

        if op_name == "create_node":
            temp_id = _text(op.get("temp_id") or op.get("id"))
            kind = _text(op.get("kind"), "knowledge")
            node_label = _text(op.get("label") or op.get("title"))
            if not temp_id:
                errors.append({"index": index, "op": op_name, "reason": "缺少 temp_id"})
                continue
            if temp_id in nodes:
                errors.append({"index": index, "op": op_name, "reason": f"temp_id 与现有节点冲突: {temp_id}"})
                continue
            if temp_id in temp_to_assigned:
                errors.append({"index": index, "op": op_name, "reason": f"temp_id 重复: {temp_id}"})
                continue
            if kind not in ALLOWED_CREATE_KINDS:
                errors.append({"index": index, "op": op_name, "reason": f"不允许新建节点类型: {kind}"})
                continue
            if not node_label:
                errors.append({"index": index, "op": op_name, "reason": "缺少节点标题"})
                continue
            module_key = _text(op.get("module_key") or op.get("moduleKey"))
            if kind == "module" and module_key not in ALLOWED_MODULE_KEYS:
                errors.append({"index": index, "op": op_name, "reason": f"无效模块类型: {module_key or '空'}"})
                continue
            assigned_id = _next_temp_id(nodes, index)
            nodes[assigned_id] = {
                "id": assigned_id,
                "kind": kind,
                "label": node_label,
                "content": _text(op.get("content") or op.get("summary"))[:MAX_NODE_CONTENT_LENGTH],
                "formula": _text(op.get("formula"))[:500],
                "module_key": module_key,
                "manual": _bool(op.get("manual")),
                "status": _text(op.get("status"), "done"),
                "read_only": False,
            }
            temp_to_assigned[temp_id] = assigned_id
            valid_ops.append({**op, "assigned_id": assigned_id})
            continue

        if op_name == "create_eval_node":
            temp_id = _text(op.get("temp_id") or op.get("id"))
            target_id = resolve_ref(op.get("target_node_id") or op.get("target_node") or op.get("target"))
            target_node = nodes.get(target_id)
            suggestion = _text(op.get("suggestion") or op.get("content"))
            if not temp_id:
                errors.append({"index": index, "op": op_name, "reason": "缺少 temp_id"})
                continue
            if not target_node:
                errors.append({"index": index, "op": op_name, "reason": f"评价目标节点不存在: {target_id}"})
                continue
            if not suggestion:
                errors.append({"index": index, "op": op_name, "reason": "缺少评价建议"})
                continue
            if temp_id in nodes or temp_id in temp_to_assigned:
                errors.append({"index": index, "op": op_name, "reason": f"temp_id 冲突: {temp_id}"})
                continue
            priority = _text(op.get("priority"), "medium")
            if priority not in {"high", "medium", "low"}:
                priority = "medium"
            assigned_id = _next_temp_id(nodes, index)
            target_label = _text(target_node.get("label"), target_id)
            nodes[assigned_id] = {
                "id": assigned_id,
                "kind": "ai_eval",
                "label": f"对「{target_label}」的建议",
                "content": suggestion,
                "formula": "",
                "module_key": "",
                "manual": False,
                "target_node_id": target_id,
                "target_label": target_label,
                "suggestion": suggestion,
                "priority": priority,
                "status": "pending",
                "read_only": False,
            }
            temp_to_assigned[temp_id] = assigned_id
            key = _edge_key(target_id, assigned_id)
            edges[key] = {
                "key": key,
                "from": target_id,
                "to": assigned_id,
                "fromPort": "out-0",
                "toPort": "in-0",
                "relation": "评价",
                "label": "评价",
                "custom": True,
            }
            valid_ops.append(
                {
                    **op,
                    "assigned_id": assigned_id,
                    "edge_key": key,
                    "from": target_id,
                    "to": assigned_id,
                    "fromPort": "out-0",
                    "toPort": "in-0",
                }
            )
            continue

        if op_name == "update_node":
            node_id = _text(op.get("id"))
            node = nodes.get(node_id)
            if not node:
                errors.append({"index": index, "op": op_name, "reason": f"节点不存在: {node_id}"})
                continue
            if node["read_only"]:
                errors.append({"index": index, "op": op_name, "reason": f"只读节点不能修改: {node_id}"})
                continue
            patch = op.get("patch") if isinstance(op.get("patch"), dict) else {}
            changed = False
            for field in UPDATEABLE_NODE_FIELDS:
                if field not in patch:
                    continue
                value = _text(patch.get(field), "")
                if field == "content":
                    value = value[:MAX_NODE_CONTENT_LENGTH]
                if field == "formula":
                    value = value[:500]
                if nodes[node_id].get(field) != value:
                    nodes[node_id][field] = value
                    changed = True
            if not changed:
                warnings.append({"index": index, "op": op_name, "reason": "修改前后没有变化"})
            valid_ops.append({**op, "id": node_id})
            continue

        if op_name == "delete_node":
            node_id = _text(op.get("id"))
            node = nodes.get(node_id)
            if not node:
                errors.append({"index": index, "op": op_name, "reason": f"节点不存在: {node_id}"})
                continue
            if node["read_only"] and not allow_read_only_delete:
                errors.append({"index": index, "op": op_name, "reason": f"只读节点不能删除: {node_id}"})
                continue
            nodes.pop(node_id, None)
            removed_edge_keys = [key for key, edge in edges.items() if edge["from"] == node_id or edge["to"] == node_id]
            for key in removed_edge_keys:
                edges.pop(key, None)
            valid_ops.append({**op, "id": node_id, "cascade_edges": removed_edge_keys})
            continue

        if op_name == "add_edge":
            from_id = resolve_ref(op.get("from") or op.get("source"))
            to_id = resolve_ref(op.get("to") or op.get("target"))
            if from_id not in nodes:
                errors.append({"index": index, "op": op_name, "reason": f"起点不存在: {from_id}"})
                continue
            if to_id not in nodes:
                errors.append({"index": index, "op": op_name, "reason": f"终点不存在: {to_id}"})
                continue
            if from_id == to_id:
                errors.append({"index": index, "op": op_name, "reason": "不能添加自环"})
                continue
            from_port = _text(op.get("fromPort") or op.get("from_port"), "out-0")
            to_port = _text(op.get("toPort") or op.get("to_port"), "in-0")
            key = _text(op.get("edge_key") or op.get("key") or _edge_key(from_id, to_id, from_port, to_port))
            if key in edges:
                errors.append({"index": index, "op": op_name, "reason": f"连线已存在: {key}"})
                continue
            edges[key] = {
                "key": key,
                "from": from_id,
                "to": to_id,
                "fromPort": from_port,
                "toPort": to_port,
                "relation": _text(op.get("relation")),
                "label": _text(op.get("label")),
                "custom": True,
            }
            valid_ops.append(
                {
                    **op,
                    "from": from_id,
                    "to": to_id,
                    "fromPort": from_port,
                    "toPort": to_port,
                    "edge_key": key,
                }
            )
            continue

        if op_name == "remove_edge":
            key = _operation_edge_key(op, edges)
            if not key or key not in edges:
                errors.append({"index": index, "op": op_name, "reason": f"连线不存在: {key or ''}"})
                continue
            edges.pop(key, None)
            valid_ops.append({**op, "edge_key": key})
            continue

        if op_name == "update_edge":
            key = _operation_edge_key(op, edges)
            edge = edges.get(key or "")
            if not key or not edge:
                errors.append({"index": index, "op": op_name, "reason": f"连线不存在: {key or ''}"})
                continue
            if not edge.get("custom"):
                errors.append({"index": index, "op": op_name, "reason": "只读连线不能修改"})
                continue
            patch = op.get("patch") if isinstance(op.get("patch"), dict) else {}
            for field in UPDATEABLE_EDGE_FIELDS:
                if field in patch:
                    edges[key][field] = _text(patch.get(field), "")
            valid_ops.append({**op, "edge_key": key})
            continue

    next_snapshot = {
        "version": 1,
        "nodes": list(nodes.values()),
        "edges": list(edges.values()),
    }
    diff = diff_snapshots(current, next_snapshot)
    status = "ok" if valid_ops else "no_ops"
    if errors:
        status = "partial" if valid_ops else "invalid"
    return {
        "status": status,
        "summary": "",
        "operations": valid_ops,
        "next_snapshot": next_snapshot,
        "diff": diff,
        "errors": errors,
        "warnings": warnings,
    }


def _node_signature(node: Dict[str, Any]) -> tuple:
    return (
        node.get("kind", ""),
        node.get("label", ""),
        node.get("content", ""),
        node.get("formula", ""),
        node.get("module_key", ""),
        node.get("manual", ""),
    )


def diff_snapshots(before: Any, after: Any) -> List[Dict[str, Any]]:
    before = normalize_snapshot(before)
    after = normalize_snapshot(after)
    before_nodes = {node["id"]: node for node in before["nodes"]}
    after_nodes = {node["id"]: node for node in after["nodes"]}
    before_edges = {edge["key"]: edge for edge in before["edges"]}
    after_edges = {edge["key"]: edge for edge in after["edges"]}

    diff: List[Dict[str, Any]] = []
    for node_id, node in after_nodes.items():
        if node_id not in before_nodes:
            diff.append({"type": "add_node", "id": node_id, "label": node.get("label", "")})
        elif _node_signature(before_nodes[node_id]) != _node_signature(node):
            diff.append({"type": "update_node", "id": node_id, "label": node.get("label", "")})
    for node_id, node in before_nodes.items():
        if node_id not in after_nodes:
            diff.append({"type": "delete_node", "id": node_id, "label": node.get("label", "")})

    for key, edge in after_edges.items():
        if key not in before_edges:
            diff.append(
                {
                    "type": "add_edge",
                    "key": key,
                    "from": edge.get("from", ""),
                    "to": edge.get("to", ""),
                    "relation": edge.get("relation", ""),
                }
            )
        elif before_edges[key].get("relation") != edge.get("relation") or before_edges[key].get("label") != edge.get("label"):
            diff.append({"type": "update_edge", "key": key, "relation": edge.get("relation", "")})
    for key, edge in before_edges.items():
        if key not in after_edges:
            diff.append(
                {
                    "type": "delete_edge",
                    "key": key,
                    "from": edge.get("from", ""),
                    "to": edge.get("to", ""),
                }
            )
    return diff
