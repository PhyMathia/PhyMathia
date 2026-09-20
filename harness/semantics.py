"""Deterministic semantic checks for the graph harness.

These checks run after operation validation and complement the model critic:
- find_isolated_created_nodes: new nodes that ended up disconnected from every
  pre-existing node (the model often forgets to add_edge);
- rule_selfcheck: cheap instruction-coverage warnings (focus untouched,
  imperative instruction with zero ops, excessive deletion).
"""

from __future__ import annotations

import re
from typing import Any, Dict, List

_ANCHOR_ADD_RE = re.compile(r"(给|为|在|把)[^，。；\n]{0,30}?(加|补|新增|添加|创建|生成)")


def _connected_node_ids(snapshot: Any, seed_ids) -> set:
    """沿连线 BFS，返回与 seed 节点连通的所有节点 id。"""
    seeds = {str(s) for s in (seed_ids or []) if str(s)}
    if not seeds:
        return set()
    adj: Dict[str, set] = {}
    for e in snapshot.get("edges") or []:
        f = str(e.get("from") or "")
        t = str(e.get("to") or "")
        if f and t:
            adj.setdefault(f, set()).add(t)
            adj.setdefault(t, set()).add(f)
    seen = set(seeds)
    stack = list(seeds)
    while stack:
        cur = stack.pop()
        for nb in adj.get(cur, set()):
            if nb not in seen:
                seen.add(nb)
                stack.append(nb)
    return seen


def _anchor_add_covered(text: str, snapshot: Any, touched, untouched) -> bool:
    """“给 X 加一个物理视角”这类指令里 X 只是锚点：模型改为扩展现有模块（不直接动 X）是合理行为，不报 warning。"""
    if not _ANCHOR_ADD_RE.search(str(text or "")):
        return False
    neighbors = _connected_node_ids(snapshot, untouched)
    return any(str(t) in neighbors for t in (touched or []))


ACTION_WORDS = (
    "删除", "删掉", "去掉", "新增", "补充", "创建", "加上", "添加", "连接",
    "修改", "改成", "加一个", "补一个", "整理", "优化",
)


def find_isolated_created_nodes(snapshot: Any, ops: Any) -> List[Dict[str, Any]]:
    """Return created nodes that are not connected (directly or transitively)
    to any pre-existing node.

    ops should be the validated operations (result["operations"]) so that
    create_node carries assigned_id and add_edge carries resolved from/to.
    """
    nodes = snapshot.get("nodes") or []
    existing_ids = {str(node.get("id")) for node in nodes}
    created: List[Dict[str, Any]] = []
    created_ids = set()

    def created_id(op: Dict[str, Any]) -> str:
        return str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")

    for op in ops or []:
        if not isinstance(op, dict):
            continue
        name = str(op.get("op") or "")
        if name in ("create_node", "create_eval_node"):
            node_id = created_id(op)
            if node_id:
                created.append({"id": node_id, "label": str(op.get("label") or node_id)})
                created_ids.add(node_id)
    if not created:
        return []

    # union-find over existing + created nodes
    parent: Dict[str, str] = {}

    def find(x: str) -> str:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    all_ids = existing_ids | created_ids
    for node_id in all_ids:
        parent[node_id] = node_id

    for op in ops or []:
        if not isinstance(op, dict):
            continue
        name = str(op.get("op") or "")
        if name == "add_edge":
            a = str(op.get("from") or "")
            b = str(op.get("to") or "")
            if a in all_ids and b in all_ids:
                union(a, b)
        elif name == "create_eval_node":
            target = str(op.get("target_node_id") or op.get("from") or "")
            node_id = created_id(op)
            if target in all_ids and node_id in all_ids:
                union(target, node_id)

    existing_roots = {find(x) for x in existing_ids}
    isolated = [item for item in created if find(item["id"]) not in existing_roots]
    return isolated


def rule_selfcheck(
    snapshot: Any,
    instruction: str,
    focus_node_ids,
    ops: Any,
) -> Dict[str, Any]:
    """Cheap deterministic coverage checks. Returns {"ok": bool, "issues": [...]}."""
    issues: List[str] = []
    text = str(instruction or "")
    total = len(snapshot.get("nodes") or [])
    op_list = [op for op in (ops or []) if isinstance(op, dict)]

    touched = set()
    for op in op_list:
        for key in ("id", "from", "to", "target_node_id", "node_id"):
            value = str(op.get(key) or "")
            if value:
                touched.add(value)

    focus = [str(item) for item in (focus_node_ids or []) if str(item)]
    if focus:
        untouched = [node_id for node_id in focus if node_id not in touched]
        if untouched and not _anchor_add_covered(text, snapshot, touched, untouched):
            issues.append("指令指向的节点未在本次操作中涉及：" + "、".join(untouched))

    if not op_list and any(word in text for word in ACTION_WORDS):
        issues.append("指令包含明确的修改意图，但模型没有提出任何操作")


    # 重复模块检查：新建 module 时若图中已有同 module_key 的模块，给出警告
    existing_modules = {}
    for node in snapshot.get("nodes", []):
        if node.get("kind") == "module" and node.get("module_key"):
            existing_modules.setdefault(str(node.get("module_key")), []).append(str(node.get("label") or node.get("id") or node.get("module_key")))
    for op in op_list:
        if str(op.get("op")) == "create_node" and str(op.get("kind")) == "module":
            mk = str(op.get("module_key") or op.get("moduleKey") or "")
            if mk and mk in existing_modules:
                dup_labels = "、".join(existing_modules[mk])
                issues.append(f"图中已有同类型模块节点（{dup_labels}），新增会造成重复；若用户明确要求再新增一个可忽略本提示")

    deletes = sum(1 for op in op_list if str(op.get("op")) == "delete_node")
    if deletes > 5 and total and deletes > 0.4 * total:
        issues.append(f"本次删除节点较多（{deletes}/{total}），请确认是否符合预期")

    return {"ok": not issues, "issues": issues}


def find_missing_expansion_chains(snapshot: Any, ops: Any, target_ids) -> List[Dict[str, Any]]:
    """Return target knowledge nodes that miss a created knowledge->answer->learn chain.

    ops should be validated operations (result["operations"]) so create_node
    carries assigned_id and add_edge carries resolved from/to.
    """
    targets = [str(item) for item in (target_ids or []) if str(item)]
    if not targets:
        return []

    created_answers: Dict[str, str] = {}
    created_learns = set()
    edges: List[tuple] = []
    for op in ops or []:
        if not isinstance(op, dict):
            continue
        name = str(op.get("op") or "")
        node_id = str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")
        if name == "create_node":
            kind = str(op.get("kind") or "")
            if kind == "answer":
                created_answers[node_id] = str(op.get("label") or node_id)
            elif kind == "module" and str(op.get("module_key") or "") == "learn":
                created_learns.add(node_id)
        elif name == "add_edge":
            edges.append((str(op.get("from") or ""), str(op.get("to") or "")))

    missing: List[Dict[str, Any]] = []
    for target in targets:
        answers = [aid for aid in created_answers if (target, aid) in edges]
        if not answers:
            missing.append({"id": target, "reason": "缺少 AI 回答节点链（未创建并连接 answer 节点）"})
            continue
        if not any((aid, learn_id) in edges for aid in answers for learn_id in created_learns):
            missing.append({"id": target, "reason": "AI 回答节点未连接进阶学习模块"})
    return missing
