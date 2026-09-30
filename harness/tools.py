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
from .json_utils import repair_json

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
    # 节点配方 P3（创造模式）
    "create_recipe": "create_recipe",
    "update_recipe": "update_recipe",
    "delete_recipe": "delete_recipe",
}

# T93（评审路线 #8）只读查询工具：模型可以先看图中内容再决定改哪。
# 它们不产出任何图操作，也绝不进 TOOL_TO_OP——若混进最终编辑批次，
# parse_tool_calls 会按既有「不支持的工具」错误软重试兜底。
READONLY_TOOL_NAMES = ("read_node", "list_neighbors", "search_nodes")

# 查询结果上限：邻接 40 条、搜索 10 条、摘录 80 字（回灌上下文预算）
_READONLY_NEIGHBOR_LIMIT = 40
_READONLY_SEARCH_LIMIT = 10
_READONLY_EXCERPT_CHARS = 80

# read_node 返回的节点全字段（与 core.normalize_node 的输出字段一致）
_NODE_QUERY_FIELDS = (
    "id", "kind", "label", "content", "formula", "module_key", "manual",
    "target_node_id", "target_label", "suggestion", "priority", "status", "read_only",
)


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
            "module_key": _str_prop("kind=module 时必须填写模块类型（带 recipe_id 时可空）", list(ALLOWED_MODULE_KEYS)),
            "recipe_id": _str_prop("创造模式专用：配方 ID（来自本批 create_recipe 的结果或 user_recipes 清单）——放一个该配方的节点到画布"),
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
        "修改一条已有连线的关系/说明（只读连线会自动转为删除后重建）。可用 edge_key 精确定位，或提供 from/to/from_port/to_port 由系统推导。",
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

    # ---- 节点配方 P3（创造模式）：配方是纯 JSON（D-R2），schema 枚举在后端校验器把关 ----
    recipe_obj_prop = {
        "type": "object",
        "description": "配方完整 JSON：name(必填≤24字) / desc(≤80) / base:{kind:module|summary|knowledge|relation|note|human_note|manual|question} / "
        "appearance:{palette:amber|blue|rose|teal|violet|human|note, shape:is-round|is-square|is-diamond|is-ring} / "
        "generate:{prompt(必填≤800字), strict_output, followup_prompt, confused_prompt, retry_prompt, context_channel:workflow_context|prompt_inline, "
        "model_role:agent|html|branch|graph|quiz|descriptor, on_incomplete:{max_retries:0|1|2}} / "
        "ports:{static:[{label≤12字, drag_form:draft|user|connected:<官方key>}], dynamic:{parser:{pattern:numbered_list, level_tags, max≤12, "
        "label_from:index_question|question_trunc12}, fallback:{mode:static|label_questions_from_text|none, labels}, each:{type:socratic|learn|branch, "
        "drag_form:draft|user}}}（dynamic 仅 module 底座）/ content_kind:markdown|plain|mermaid|html_iframe（后两者须 AI 底座）",
        "properties": {
            "name": _str_prop("配方名（必填，≤24 字，不得与现有配方重名）"),
            "desc": _str_prop("一句话描述（≤80 字）"),
            "base": {"type": "object", "properties": {"kind": _str_prop("底座类型")}},
            "appearance": {"type": "object", "properties": {
                "palette": _str_prop("色板令牌", ["amber", "blue", "rose", "teal", "violet", "human", "note"]),
                "shape": _str_prop("形状族", ["is-round", "is-square", "is-diamond", "is-ring"]),
            }},
            "generate": {"type": "object", "description": "生成四槽＋通道＋模型槽＋重试"},
            "ports": {"type": "object", "description": "静态出口表＋动态出口声明"},
            "content_kind": _str_prop("内容载体", ["markdown", "plain", "mermaid", "html_iframe"]),
        },
        "required": ["name"],
    }

    create_recipe = _tool(
        "create_recipe",
        "创造模式：新建一个节点配方（用户可复用的自定义节点类型，纯 JSON）。需求不明时先用 clarify 问清"
        "（用途/出口/载体），明确后一次性产出完整配方；保存前想过校验器（名称查重/枚举白名单/预算）。",
        {"recipe": recipe_obj_prop, "reason": _str_prop(REASON_DESC)},
        ["recipe", "reason"],
    )

    update_recipe = _tool(
        "update_recipe",
        "创造模式：修改现有配方（只能改 user_recipes 清单里列出的 id；payload 与 create 同构，整份提交）。",
        {
            "recipe_id": _str_prop("要修改的配方 ID（必须来自 user_recipes 清单）"),
            "recipe": recipe_obj_prop,
            "reason": _str_prop(REASON_DESC),
        },
        ["recipe_id", "recipe", "reason"],
    )

    delete_recipe = _tool(
        "delete_recipe",
        "创造模式：删除现有配方（只能删 user_recipes 清单里列出的 id；删除需用户已在对话中明确要求）。"
        "画布上由该配方创建的旧节点不受影响。",
        {
            "recipe_id": _str_prop("要删除的配方 ID（必须来自 user_recipes 清单）"),
            "reason": _str_prop(REASON_DESC),
        },
        ["recipe_id", "reason"],
    )

    # ---- T93 只读查询工具（不产出图操作） ----
    read_node = _tool(
        "read_node",
        "读取一个节点的完整内容（正文全文、公式、类型、状态）。修改节点前先用它看全文，避免只凭目录行猜测。",
        {"node_id": _str_prop("要读取的节点 ID（也可以用节点标题精确匹配）")},
        ["node_id"],
    )

    list_neighbors = _tool(
        "list_neighbors",
        "列出某节点的所有邻接节点与连线（方向、关系类型、连线标签）。",
        {"node_id": _str_prop("要查看邻接的节点 ID（也可以用节点标题精确匹配）")},
        ["node_id"],
    )

    search_nodes = _tool(
        "search_nodes",
        "按关键词在节点标签与正文中搜索节点，返回 id、标签、类型与正文摘录。",
        {"keyword": _str_prop("搜索关键词（不区分大小写）")},
        ["keyword"],
    )

    return {
        "create_node": create_node,
        "update_node": update_node,
        "delete_node": delete_node,
        "add_edge": add_edge,
        "remove_edge": remove_edge,
        "update_edge": update_edge,
        "create_eval_node": create_eval_node,
        "create_recipe": create_recipe,
        "update_recipe": update_recipe,
        "delete_recipe": delete_recipe,
        "read_node": read_node,
        "list_neighbors": list_neighbors,
        "search_nodes": search_nodes,
    }


_TOOL_DEFS = _tool_definitions()

# 每个阶段可用的工具（与 prompts 中的阶段语义一致）
# T93：normal/expand/apply/preset 追加三只读查询工具（模型先查图再改）；
# chat/evaluate 保持单轮（拍板）——不加只读名，解析路径与工具表同构不变。
PHASE_TOOLS: Dict[str, List[str]] = {
    "normal": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
    "expand": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
    "evaluate": ["create_eval_node"],
    "apply": ["update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
    # 创造模式（P3）：配方三件套＋create_node（带 recipe_id＝「在画布上放一个试试」）
    "preset": ["create_recipe", "update_recipe", "delete_recipe", "create_node"]
    + list(READONLY_TOOL_NAMES),
    # 答疑模式（三模式切换器）：编辑工具表与 normal 相同，但不含只读查询
    #（chat 保持单轮）——「只说不改」由红线 prompt + 服务端 ops 保险丝双层保证
    "chat": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"],
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
        # 创造模式：配方实例节点（module 底座＋recipe_id，module_key 可空）
        if _text(args.get("recipe_id")):
            op["recipe_id"] = _text(args.get("recipe_id"))
        return op

    if name in ("create_recipe", "update_recipe"):
        reason = _text(args.get("reason"))
        recipe = args.get("recipe") if isinstance(args.get("recipe"), dict) else None
        if not reason or not isinstance(recipe, dict) or not _text(recipe.get("name")):
            return None
        op: Dict[str, Any] = {"op": name, "recipe": recipe, "reason": reason}
        if name == "update_recipe":
            recipe_id = _text(args.get("recipe_id"))
            if not recipe_id:
                return None
            op["recipe_id"] = recipe_id
        return op

    if name == "delete_recipe":
        reason = _text(args.get("reason"))
        recipe_id = _text(args.get("recipe_id"))
        if not reason or not recipe_id:
            return None
        return {"op": "delete_recipe", "recipe_id": recipe_id, "reason": reason}

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
        if isinstance(raw_args, dict):
            # 部分 OpenAI 兼容网关/本地服务会把 arguments 直接给成对象——
            # json.loads 对 dict 抛 TypeError（except 只捕 JSON 解析错），
            # 整次编辑兜成「harness 内部错误」（09-20 修复）
            args = raw_args
        else:
            try:
                args = json.loads(raw_args) if _text(raw_args) else {}
            except (json.JSONDecodeError, ValueError, TypeError):
                repaired = repair_json(raw_args)
                if isinstance(repaired, dict):
                    args = repaired
                else:
                    errors.append({"index": index, "op": name, "reason": f"工具 {name} 的参数不是合法 JSON（可能被截断）"})
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


# ---- T93 只读查询执行器（纯函数，便于直测） ----


def _find_query_node(nodes: List[Dict[str, Any]], query: str) -> Optional[Dict[str, Any]]:
    """节点定位：先按 id 精确匹配，再按 label 全等匹配（找不到返回 None）。"""
    for node in nodes:
        if _text(node.get("id")) == query:
            return node
    for node in nodes:
        if _text(node.get("label")) == query:
            return node
    return None


def _neighbor_entry(node_by_id: Dict[str, Dict[str, Any]], edge: Dict[str, Any],
                    neighbor_id: str, direction: str) -> Dict[str, Any]:
    neighbor = node_by_id.get(neighbor_id) or {}
    return {
        "neighbor_id": neighbor_id,
        "neighbor_label": _text(neighbor.get("label")),
        "neighbor_kind": _text(neighbor.get("kind")),
        "direction": direction,
        "relation": _text(edge.get("relation")),
        "edge_label": _text(edge.get("label")),
        "edge_key": _text(edge.get("key") or edge.get("edge_key")),
    }


def execute_readonly_tool(name: str, arguments: Any, snapshot: Any) -> Dict[str, Any]:
    """Execute one read-only graph query against the snapshot.

    snapshot 必须是归一化后的完整快照（未做焦点收缩/正文压缩的那一份）——
    read_node 的价值就在于把目录行降级掉的正文全文取回来，调用方负责传对。

    参数非法/缺必填时返回 {"error": ...} 而不是抛异常：这是回给模型的工具
    结果，让模型看到错误后自行纠正，不打断查询循环。
    """
    if name not in READONLY_TOOL_NAMES:
        return {"error": f"未知的只读工具：{name or '空'}"}
    if not isinstance(arguments, dict):
        return {"error": f"参数无效：{name} 的参数必须是 JSON 对象"}
    data = snapshot if isinstance(snapshot, dict) else {}
    nodes = [node for node in (data.get("nodes") or []) if isinstance(node, dict)]
    edges = [edge for edge in (data.get("edges") or []) if isinstance(edge, dict)]

    if name == "read_node":
        query = _text(arguments.get("node_id") or arguments.get("id") or arguments.get("label"))
        if not query:
            return {"error": "参数无效：read_node 需要 node_id"}
        node = _find_query_node(nodes, query)
        if node is None:
            return {"found": False, "error": f"未找到节点：{query}"}
        return {"found": True, "node": {key: node.get(key) for key in _NODE_QUERY_FIELDS}}

    if name == "list_neighbors":
        query = _text(arguments.get("node_id") or arguments.get("id") or arguments.get("label"))
        if not query:
            return {"error": "参数无效：list_neighbors 需要 node_id"}
        node = _find_query_node(nodes, query)
        if node is None:
            return {"found": False, "error": f"未找到节点：{query}"}
        node_id = _text(node.get("id"))
        node_by_id = {_text(item.get("id")): item for item in nodes}
        neighbors: List[Dict[str, Any]] = []
        for edge in edges:
            from_id = _text(edge.get("from"))
            to_id = _text(edge.get("to"))
            if from_id == node_id:
                neighbors.append(_neighbor_entry(node_by_id, edge, to_id, "out"))
            elif to_id == node_id:
                neighbors.append(_neighbor_entry(node_by_id, edge, from_id, "in"))
        truncated = len(neighbors) > _READONLY_NEIGHBOR_LIMIT
        return {
            "found": True,
            "node_id": node_id,
            "node_label": _text(node.get("label")),
            "neighbors": neighbors[:_READONLY_NEIGHBOR_LIMIT],
            "count": min(len(neighbors), _READONLY_NEIGHBOR_LIMIT),
            "total": len(neighbors),
            "truncated": truncated,
        }

    # search_nodes：label 命中优先，其次 content 命中；保持节点原顺序
    keyword = _text(arguments.get("keyword") or arguments.get("query") or arguments.get("text"))
    if not keyword:
        return {"error": "参数无效：search_nodes 需要 keyword"}
    needle = keyword.lower()
    label_hits: List[Dict[str, Any]] = []
    content_hits: List[Dict[str, Any]] = []
    for node in nodes:
        if needle in _text(node.get("label")).lower():
            label_hits.append(node)
        elif needle in _text(node.get("content")).lower():
            content_hits.append(node)
    ranked = label_hits + content_hits
    truncated = len(ranked) > _READONLY_SEARCH_LIMIT
    matches = [
        {
            "id": _text(node.get("id")),
            "label": _text(node.get("label")),
            "kind": _text(node.get("kind")),
            "excerpt": _text(node.get("content"))[:_READONLY_EXCERPT_CHARS],
        }
        for node in ranked[:_READONLY_SEARCH_LIMIT]
    ]
    return {
        "matches": matches,
        "count": len(matches),
        "total": len(ranked),
        "truncated": truncated,
    }
