"""Tool/function-calling definitions for the graph harness.

The harness can submit graph operations either as structured tool calls
(preferred, more stable) or as free-form JSON (fallback for providers
without function-calling support). This module defines the tool schemas
and converts tool_calls responses back into the internal operation
contract consumed by harness.core.build_next_snapshot.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from .core import ALLOWED_CREATE_KINDS, ALLOWED_MODULE_KEYS

REASON_DESC = "修改理由：为什么执行这个操作（必填，没有理由的操作不会被应用）"
NODE_ID_DESC = "快照中真实存在的节点 ID（不能是新建节点的 temp_id）"
PORT_DESC = "端口名，例如 out-0 / in-0；不填时默认 out-0 / in-0"

# 工具名 -> 内部 op 名（与 core.ALLOWED_OPERATIONS 保持一致）
TOOL_TO_OP: Dict[str, str] = {
    "create_node": "create_node",
    "update_node": "update_node",
    "delete_node": "delete_node",
    "add_edge": "add_edge",
    "remove_edge": "remove_edge",
    "update_edge": "update_edge",
    "create_eval_node": "create_eval_node",
}


def _tool(name: str, description: str, properties: Dict[str, Any], required: List[str]) -> Dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


def _str_prop(desc: str, enum: Optional[List[str]] = None) -> Dict[str, Any]:
    prop: Dict[str, Any] = {"type": "string", "description": desc}
    if enum is not None:
        prop["enum"] = list(enum)
    return prop

def _tool_definitions() -> Dict[str, Dict[str, Any]]:
    """Return all tool definitions keyed by tool name."""
    create_node = _tool(
        "create_node",
        "新建一个知识点/模块/联系等节点。新节点只能使用 temp_id，最终 ID 由 harness 分配；"
        "同一批次后续 add_edge 可以直接引用该 temp_id。",
        {
            "temp_id": _str_prop("临时 ID（不能与现有节点或同批其他 temp_id 重复）"),
            "kind": _str_prop("节点类型", list(ALLOWED_CREATE_KINDS)),
            "label": _str_prop("节点标题（必填）"),
            "content": _str_prop("正文/摘要（可空，最多 1200 字）"),
            "formula": _str_prop("公式（可空，纯 LaTeX，不带 $ 定界符）"),
            "module_key": _str_prop("kind=module 时必须填写模块类型", list(ALLOWED_MODULE_KEYS)),
            "reason": _str_prop(REASON_DESC),
        },
        ["temp_id", "kind", "label", "reason"],
    )

    update_node = _tool(
        "update_node",
        "修改已有节点（label/content/formula/status）。不能修改只读节点；修改后没有变化会告警。",
        {
            "node_id": _str_prop(NODE_ID_DESC),
            "patch": {
                "type": "object",
                "description": "要修改的字段，至少包含一个",
                "properties": {
                    "label": _str_prop("新标题"),
                    "content": _str_prop("新正文/摘要"),
                    "formula": _str_prop("新公式（纯 LaTeX）"),
                    "status": _str_prop("状态（如 done/pending/empty）"),
                },
            },
            "reason": _str_prop(REASON_DESC),
        },
        ["node_id", "reason"],
    )

    delete_node = _tool(
        "delete_node",
        "删除已有节点。删除会级联删除所有相关连线，不需要再单独 remove_edge。",
        {
            "node_id": _str_prop(NODE_ID_DESC),
            "reason": _str_prop(REASON_DESC),
        },
        ["node_id", "reason"],
    )

    add_edge = _tool(
        "add_edge",
        "添加一条连线。from 表示上游/基础/来源，to 表示下游/结果/补充视角；"
        "from/to 可以是同批 create_node 的 temp_id。",
        {
            "from": _str_prop("起点节点 ID（或同批 create_node 的 temp_id）"),
            "to": _str_prop("终点节点 ID（或同批 create_node 的 temp_id）"),
            "relation": _str_prop("关系，优先：依赖、前置、导出、支持、反例、适用条件、等价、物理意义、数学意义、应用、追问、进阶"),
            "label": _str_prop("连线说明（可空）"),
            "from_port": _str_prop("起点端口 " + PORT_DESC),
            "to_port": _str_prop("终点端口 " + PORT_DESC),
            "reason": _str_prop(REASON_DESC),
        },
        ["from", "to", "reason"],
    )

    remove_edge = _tool(
        "remove_edge",
        "删除一条连线。可用 edge_key 精确定位，或提供 from/to/from_port/to_port 由系统推导。",
        {
            "edge_key": _str_prop("连线 key，格式：from:out-0->to:in-0"),
            "from": _str_prop("起点节点 ID（未提供 edge_key 时用于推导）"),
            "to": _str_prop("终点节点 ID（未提供 edge_key 时用于推导）"),
            "from_port": _str_prop("起点端口 " + PORT_DESC),
            "to_port": _str_prop("终点端口 " + PORT_DESC),
            "reason": _str_prop(REASON_DESC),
        },
        ["reason"],
    )

    update_edge = _tool(
        "update_edge",
        "修改一条已有连线的关系/说明（只读连线不能修改）。可用 edge_key 精确定位，或提供 from/to/from_port/to_port 由系统推导。",
        {
            "edge_key": _str_prop("连线 key，格式：from:out-0->to:in-0"),
            "from": _str_prop("起点节点 ID（未提供 edge_key 时用于推导）"),
            "to": _str_prop("终点节点 ID（未提供 edge_key 时用于推导）"),
            "from_port": _str_prop("起点端口 " + PORT_DESC),
            "to_port": _str_prop("终点端口 " + PORT_DESC),
            "patch": {
                "type": "object",
                "description": "要修改的字段，至少包含一个",
                "properties": {
                    "relation": _str_prop("新关系"),
                    "label": _str_prop("新连线说明"),
                },
            },
            "reason": _str_prop(REASON_DESC),
        },
        ["reason"],
    )

    create_eval_node = _tool(
        "create_eval_node",
        "创建 AI 评价节点（评价/建议/反馈/点评/指出问题/哪里需要改进）。只能评价真实节点，不能评价其他 AI 评价节点。",
        {
            "temp_id": _str_prop("临时 ID（不能与现有节点或同批其他 temp_id 重复）"),
            "target_node_id": _str_prop("被评价的目标节点 ID（必须真实存在）"),
            "suggestion": _str_prop("具体、可执行的修改建议（如改标题、补正文、补公式、删除错误内容、补一条前置连线）"),
            "priority": _str_prop("优先级", ["high", "medium", "low"]),
            "reason": _str_prop(REASON_DESC),
        },
        ["temp_id", "target_node_id", "suggestion", "reason"],
    )

    return {
        "create_node": create_node,
        "update_node": update_node,
        "delete_node": delete_node,
        "add_edge": add_edge,
        "remove_edge": remove_edge,
        "update_edge": update_edge,
        "create_eval_node": create_eval_node,
    }


_TOOL_DEFS = _tool_definitions()

# 每个阶段可用的工具（与 prompts 中的阶段语义一致）
PHASE_TOOLS: Dict[str, List[str]] = {
    "normal": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"],
    "expand": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"],
    "evaluate": ["create_eval_node"],
    "apply": ["update_node", "delete_node", "add_edge", "remove_edge", "update_edge"],
}


def build_tools(phase: str) -> List[Dict[str, Any]]:
    """Return the tool schema list for a harness phase ([] when unsupported)."""
    names = PHASE_TOOLS.get(str(phase or "normal"), [])
    return [_TOOL_DEFS[name] for name in names if name in _TOOL_DEFS]


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def _args_to_op(name: str, args: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Convert a single tool-call's arguments into the internal op contract."""
    if name == "create_node":
        temp_id = _text(args.get("temp_id"))
        kind = _text(args.get("kind"))
        label = _text(args.get("label"))
        reason = _text(args.get("reason"))
        if not temp_id or not kind or not label or not reason:
            return None
        op: Dict[str, Any] = {
            "op": "create_node",
            "temp_id": temp_id,
            "kind": kind,
            "label": label,
            "reason": reason,
        }
        if _text(args.get("content")):
            op["content"] = _text(args.get("content"))
        if _text(args.get("formula")):
            op["formula"] = _text(args.get("formula"))
        if _text(args.get("module_key")):
            op["module_key"] = _text(args.get("module_key"))
        return op

    if name == "update_node":
        node_id = _text(args.get("node_id") or args.get("id"))
        reason = _text(args.get("reason"))
        if not node_id or not reason:
            return None
        patch = args.get("patch") if isinstance(args.get("patch"), dict) else {}
        clean_patch = {key: _text(patch.get(key)) for key in ("label", "content", "formula", "status") if key in patch and patch.get(key) is not None}
        return {"op": "update_node", "id": node_id, "patch": clean_patch, "reason": reason}

    if name == "delete_node":
        node_id = _text(args.get("node_id") or args.get("id"))
        reason = _text(args.get("reason"))
        if not node_id or not reason:
            return None
        return {"op": "delete_node", "id": node_id, "reason": reason}

    if name == "add_edge":
        from_id = _text(args.get("from"))
        to_id = _text(args.get("to"))
        reason = _text(args.get("reason"))
        if not from_id or not to_id or not reason:
            return None
        op: Dict[str, Any] = {
            "op": "add_edge",
            "from": from_id,
            "to": to_id,
            "reason": reason,
        }
        if _text(args.get("from_port")):
            op["fromPort"] = _text(args.get("from_port"))
        if _text(args.get("to_port")):
            op["toPort"] = _text(args.get("to_port"))
        if _text(args.get("relation")):
            op["relation"] = _text(args.get("relation"))
        if _text(args.get("label")):
            op["label"] = _text(args.get("label"))
        return op

    if name in ("remove_edge", "update_edge"):
        reason = _text(args.get("reason"))
        if not reason:
            return None
        op: Dict[str, Any] = {"op": name, "reason": reason}
        if _text(args.get("edge_key")):
            op["edge_key"] = _text(args.get("edge_key"))
        else:
            from_id = _text(args.get("from"))
            to_id = _text(args.get("to"))
            if from_id and to_id:
                op["from"] = from_id
                op["to"] = to_id
                if _text(args.get("from_port")):
                    op["fromPort"] = _text(args.get("from_port"))
                if _text(args.get("to_port")):
                    op["toPort"] = _text(args.get("to_port"))
        if name == "update_edge":
            patch = args.get("patch") if isinstance(args.get("patch"), dict) else {}
            clean_patch = {key: _text(patch.get(key)) for key in ("relation", "label") if key in patch and patch.get(key) is not None}
            op["patch"] = clean_patch
        return op

    if name == "create_eval_node":
        temp_id = _text(args.get("temp_id"))
        target_id = _text(args.get("target_node_id") or args.get("target"))
        suggestion = _text(args.get("suggestion"))
        reason = _text(args.get("reason"))
        if not temp_id or not target_id or not suggestion or not reason:
            return None
        op: Dict[str, Any] = {
            "op": "create_eval_node",
            "temp_id": temp_id,
            "target_node_id": target_id,
            "suggestion": suggestion,
            "reason": reason,
        }
        priority = _text(args.get("priority"))
        if priority in ("high", "medium", "low"):
            op["priority"] = priority
        return op

    return None


def parse_tool_calls(tool_calls: Any) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Convert an API tool_calls payload into (operations, errors).

    errors uses the same shape as core.build_next_snapshot errors so the
    existing retry/summarize flow can consume them.
    """
    ops: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    if not isinstance(tool_calls, list):
        return ops, errors

    for index, call in enumerate(tool_calls):
        if not isinstance(call, dict):
            errors.append({"index": index, "op": "tool_call", "reason": "工具调用格式非法"})
            continue
        fn = call.get("function")
        if not isinstance(fn, dict):
            errors.append({"index": index, "op": "tool_call", "reason": "工具调用缺少 function 字段"})
            continue
        name = _text(fn.get("name"))
        if name not in TOOL_TO_OP:
            errors.append({"index": index, "op": name or "unknown", "reason": f"不支持的工具: {name or '空'}"})
            continue
        raw_args = fn.get("arguments") or ""
        try:
            args = json.loads(raw_args) if _text(raw_args) else {}
        except (json.JSONDecodeError, ValueError):
            errors.append({"index": index, "op": name, "reason": f"工具 {name} 的参数不是合法 JSON"})
            continue
        if not isinstance(args, dict):
            errors.append({"index": index, "op": name, "reason": f"工具 {name} 的参数必须是对象"})
            continue
        op = _args_to_op(name, args)
        if op is None:
            errors.append({"index": index, "op": name, "reason": f"工具 {name} 缺少必填参数"})
            continue
        ops.append(op)
    return ops, errors
