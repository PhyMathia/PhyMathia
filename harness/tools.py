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
    # T263 访谈协议：结构化追问（review_graph 在 preset 相位短路成 clarify 结果，
    # 绝不进 build_next_snapshot——混进批次也会被先捞出来）
    "ask_user": "ask_user",
}

# T93（评审路线 #8）只读查询工具：模型可以先看图中内容再决定改哪。
# 它们不产出任何图操作，也绝不进 TOOL_TO_OP——若混进最终编辑批次，
# parse_tool_calls 会按既有「不支持的工具」错误软重试兜底。
# 2026-10-03 智能化第二期：新增 search_knowledge / search_formulas 两只
# 知识检索工具（数据源是用户对话中自动收集的知识库与公式速查），并把
# chat 答疑相位的工具表收敛为纯只读——「只说不改」从红线约定升级为
# 工具表层面的保证（编辑工具根本不在表里，服务端 ops 保险丝保留兜底）。
# 2026-10-09 优化新路径六第 1 档：新增 graph_stats 整图学习结构体检工具
# （学习教练）：把整张图当课程表看的统计入口，chat 答疑相位立即可用。
READONLY_TOOL_NAMES = ("read_node", "list_neighbors", "search_nodes", "search_knowledge", "search_formulas", "graph_stats")

# 知识检索类工具（READONLY 的子集）：执行时需要调用方额外注入用户
# 知识库/公式速查数据（kb 参数），图查询三件套用不到。
KB_TOOL_NAMES = ("search_knowledge", "search_formulas")

# 查询结果上限：邻接 40 条、搜索 10 条、摘录 80 字（回灌上下文预算）
_READONLY_NEIGHBOR_LIMIT = 40
_READONLY_SEARCH_LIMIT = 10
_READONLY_EXCERPT_CHARS = 80
# 公式 LaTeX 较长，摘录上限放宽到 160 字（够看出结构，不爆预算）
_READONLY_FORMULA_CHARS = 160
# graph_stats 的无先修知识节点清单上限（只数不列全，超限截断）
_READONLY_STATS_NODE_LIMIT = 20

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
            "recipe_id": _str_prop("配方 ID（来自快照 user_recipes 清单或本批先创建的 create_recipe.temp_recipe_id）——放置一个该配方的节点实例，编辑/创造模式均可"),
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
        "appearance:{palette:amber|blue|rose|teal|violet|human|note}（外观只有颜色，形状按底座推导、别写 shape） / "
        "generate:{prompt(必填≤800字), strict_output, followup_prompt, confused_prompt, retry_prompt, context_channel:workflow_context|prompt_inline, "
        "model_role:agent|html|branch|graph|quiz|descriptor, on_incomplete:{max_retries:0|1|2}} / "
        "ports:{static:[{label≤12字, drag_form:draft|user|connected:<官方key>, type:text|formula|diagram|html}], "
        "inputs:[{label≤12字, type:text|formula|diagram|html}](具名输入端口：这条线等什么材料；type 留空＝不限), "
        "dynamic:{parser:{pattern:numbered_list, level_tags, max≤12, "
        "label_from:index_question|question_trunc12}, fallback:{mode:static|label_questions_from_text|none, labels}, each:{type:socratic|learn|branch, "
        "drag_form:draft|user}}}（dynamic 仅 module 底座）/ content_kind:markdown|plain|mermaid|html_iframe（后两者须 AI 底座）",
        "properties": {
            "name": _str_prop("配方名（必填，≤24 字，不得与现有配方重名）"),
            "desc": _str_prop("一句话描述（≤80 字）"),
            "base": {"type": "object", "properties": {"kind": _str_prop("底座类型")}},
            "appearance": {"type": "object", "properties": {
                "palette": _str_prop("色板令牌", ["amber", "blue", "rose", "teal", "violet", "human", "note"]),
            }},
            "generate": {"type": "object", "description": "生成四槽＋通道＋模型槽＋重试"},
            "ports": {"type": "object", "description": "静态出口表＋具名输入端口表(inputs)＋动态出口声明"},
            "content_kind": _str_prop("内容载体", ["markdown", "plain", "mermaid", "html_iframe"]),
        },
        "required": ["name"],
    }

    create_recipe = _tool(
        "create_recipe",
        "创造模式：新建一个节点配方（用户可复用的自定义节点类型，纯 JSON）。需求不明时先用 ask_user 追问"
        "（用途/输入口/出口/载体），明确后一次性产出完整配方；保存前想过校验器（名称查重/枚举白名单/预算）。",
        {"recipe": recipe_obj_prop, "reason": _str_prop(REASON_DESC),
         "temp_recipe_id": _str_prop("可选临时配方 ID；同批先创建配方，再用 create_node.recipe_id 引用此值")},
        ["recipe", "reason"],
    )

    update_recipe = _tool(
        "update_recipe",
        "创造模式：修改现有配方（只能改 user_recipes 清单里列出的 id）。目标与 recipe_detail.id 一致时只提交改变的字段，未提交字段递归保留；数组整体替换，null 清除可选配置。其他目标必须整份提交。",
        {
            "recipe_id": _str_prop("要修改的配方 ID（必须来自 user_recipes 清单）"),
            "recipe": {**recipe_obj_prop, "required": []},
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

    # ---- 2026-10-03 智能化第二期：用户知识资产检索（只读，不产出图操作） ----
    search_knowledge = _tool(
        "search_knowledge",
        "在用户的知识库（对话中自动收集的知识点，跨会话）里按关键词搜索：标题/摘要/标签命中，"
        "返回标题、分类、摘要摘录。回答知识问题或补图内容前先查它，能引用用户自己学过的表述。",
        {"keyword": _str_prop("搜索关键词（不区分大小写）")},
        ["keyword"],
    )

    search_formulas = _tool(
        "search_formulas",
        "在用户的公式速查（对话中自动收集的公式）里按关键词搜索：概念名/含义/LaTeX 片段命中，"
        "返回 LaTeX、所属概念与含义摘录。",
        {"keyword": _str_prop("搜索关键词（概念名或公式片段，不区分大小写）")},
        ["keyword"],
    )

    # ---- 优化新路径六第 1 档（2026-10-09）：学习教练——整图学习结构体检 ----
    graph_stats = _tool(
        "graph_stats",
        "整张图的学习结构体检（只读统计，不改图）：连通分量数（>1 说明有互不连通的孤岛主题）、"
        "各类节点的链深分布（难度梯度）、没有任何先修来源的知识节点（可能是缺前置连线）、"
        "检测薄弱点（quiz_weak）在图上的覆盖情况。用户问「该先学什么/这张图作为学习路线"
        "合不合格/哪里薄弱」时先调它，回答要引用具体数字与节点，不要泛泛而谈。",
        {},
        [],
    )

    # ---- T263 访谈协议：创造模式的结构化追问（走工具通道，兼容 tool_choice=required）----
    ask_user = _tool(
        "ask_user",
        "创造模式：向用户追问澄清节点需求。信息不足时必须先问再产出配方：一次 1~3 个问题、"
        "最多追问 3 轮，问过的不要重复问；问题要具体到可回答（这个节点帮用户做什么/每个输入口"
        "叫什么、等什么材料/每个出口叫什么、拖出去干什么/内容载体/要不要动态出口）。"
        "信息足够后立即产出配方，不要再问。",
        {
            "questions": {
                "type": "array",
                "description": "问题列表（1~3 个，每项 {question, options?}；options 是可点选的候选项，每项 ≤60 字、最多 6 个）",
                "items": {
                    "type": "object",
                    "properties": {
                        "question": _str_prop("问题正文（一次问清一件事，≤200 字）"),
                        "options": {"type": "array", "items": {"type": "string"}, "description": "候选答案（可选，用户点选即答）"},
                    },
                    "required": ["question"],
                },
            },
        },
        ["questions"],
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
        "ask_user": ask_user,
        "read_node": read_node,
        "list_neighbors": list_neighbors,
        "search_nodes": search_nodes,
        "search_knowledge": search_knowledge,
        "search_formulas": search_formulas,
        "graph_stats": graph_stats,
    }


_TOOL_DEFS = _tool_definitions()

# 每个阶段可用的工具（与 prompts 中的阶段语义一致）
# T93：normal/expand/apply/preset 追加只读查询工具（模型先查图再改）；
# evaluate 保持单轮（拍板）——不加只读名，解析路径与工具表同构不变。
# 2026-10-03 智能化第二期（拍板修订，用户点名「更智能、更像 harness」）：
# ① chat 答疑相位从「编辑工具表＋红线禁用」改为**纯只读工具表**——图查询
#   三件套＋知识检索两件套，先查图/查知识库再作答；编辑工具根本不在表里，
#   「只说不改」由工具表结构保证（服务端 ops 保险丝与红线 prompt 保留兜底）；
# ② 其余工具相位（normal/expand/apply/preset）随 READONLY_TOOL_NAMES 扩容
#   自动获得知识检索能力。
PHASE_TOOLS: Dict[str, List[str]] = {
    "normal": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
    "expand": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
    "evaluate": ["create_eval_node"],
    "apply": ["update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
    # 创造模式（P3）：配方三件套＋ask_user（T263 访谈）＋create_node（带 recipe_id＝「在画布上放一个试试」）
    "preset": ["ask_user", "create_recipe", "update_recipe", "delete_recipe", "create_node"]
    + list(READONLY_TOOL_NAMES),
    # 答疑模式（三模式切换器）：纯只读——查图、查知识库、查公式速查，绝不改图
    "chat": list(READONLY_TOOL_NAMES),
    # 课程表体检（路径六第 2 档，2026-10-09）：与 normal 同表——报告里的建议
    # 批次是普通编辑操作，统计已由服务端预计算注入（graph_stats 仍在表里供
    # 模型复查个别节点时用，提示词已注明不必重复拉整图统计）
    "coach": ["create_node", "update_node", "delete_node", "add_edge", "remove_edge", "update_edge"]
    + list(READONLY_TOOL_NAMES),
}


def build_tools(phase: str) -> List[Dict[str, Any]]:
    """Return the tool schema list for a harness phase ([] when unsupported)."""
    names = PHASE_TOOLS.get(str(phase or "normal"), [])
    return [_TOOL_DEFS[name] for name in names if name in _TOOL_DEFS]


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_ask_questions(raw: Any) -> Optional[Dict[str, Any]]:
    """T263 访谈协议：追问载荷归一化（ask_user 工具参数与 JSON clarify 通道共用）。

    接受 ``{questions: [{question, options?}]}``（新多问）或 ``{question, options}``
    （旧单问兼容）；问题正文必填非空（≤200 字）、options 每项 ≤60 字最多 6 个、
    单轮最多 3 问。全部问题为空返回 None（调用方走重试反馈，不原样透传脏载荷）。
    """
    if not isinstance(raw, dict):
        return None

    def _clean_entry(item: Any) -> Optional[Dict[str, Any]]:
        if not isinstance(item, dict):
            return None
        text = _text(item.get("question"))
        if not text:
            return None
        entry: Dict[str, Any] = {"question": text[:200]}
        options = item.get("options") if isinstance(item.get("options"), list) else []
        clean = [_text(option)[:60] for option in options if _text(option)][:6]
        if clean:
            entry["options"] = clean
        return entry

    questions = [entry for entry in (_clean_entry(item) for item in (raw.get("questions") if isinstance(raw.get("questions"), list) else [])[:3]) if entry]
    if not questions:
        legacy = _clean_entry(raw)
        if legacy:
            questions.append(legacy)
    if not questions:
        return None
    return {"questions": questions}


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
        if not reason or not isinstance(recipe, dict) or (name == "create_recipe" and not _text(recipe.get("name"))):
            return None
        op: Dict[str, Any] = {"op": name, "recipe": recipe, "reason": reason}
        if name == "create_recipe" and _text(args.get("temp_recipe_id")):
            op["temp_recipe_id"] = _text(args.get("temp_recipe_id"))
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

    if name == "ask_user":
        # T263 访谈协议：追问不产出任何图/配方操作，归一化后由 review_graph 短路成 clarify
        normalized = normalize_ask_questions(args)
        if not normalized:
            return None
        return {"op": "ask_user", "questions": normalized["questions"], "reason": _text(args.get("reason"))}

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


def _graph_stats(nodes: List[Dict[str, Any]], edges: List[Dict[str, Any]], data: Dict[str, Any]) -> Dict[str, Any]:
    """整图学习结构体检（优化新路径六第 1 档）：确定性统计、零模型调用。

    四个指标对着「把整张图当课程表」的问题：
    ① 连通分量数——先修链在主题之间有没有断开（孤岛）；
    ② 按 kind 的链深分布——难度梯度顺不顺（叶子到根的深度直方图）；
    ③ 入度为 0 的知识节点——无先修来源，是起点还是缺前置连线；
    ④ quiz_weak 覆盖率——检测薄弱点在图上有没有节点与进阶链（只统计、
       只读；quiz_weak 红线禁的是建状态类图元素，统计事实出口相容）。

    深度用 Kahn 拓扑分层算最长路径层：环上的节点无法定层，计入
    cycle_locked 单独报告（不因数据有环就崩或给假深度）。
    """
    node_ids = {_text(node.get("id")) for node in nodes}
    if not node_ids:
        return {"nodes": 0, "edges": len(edges), "note": "空图：还没有节点，先从一个问题或一个概念开始建图。"}

    adjacent: Dict[str, set] = {nid: set() for nid in node_ids}
    out_adjacent: Dict[str, List[str]] = {nid: [] for nid in node_ids}
    in_degree = {nid: 0 for nid in node_ids}
    out_degree = {nid: 0 for nid in node_ids}
    for edge in edges:
        from_id = _text(edge.get("from"))
        to_id = _text(edge.get("to"))
        if from_id not in node_ids or to_id not in node_ids or from_id == to_id:
            continue
        adjacent[from_id].add(to_id)
        adjacent[to_id].add(from_id)
        out_adjacent[from_id].append(to_id)
        in_degree[to_id] += 1
        out_degree[from_id] += 1

    # ① 连通分量（无向口径：先修链断裂/孤岛主题）
    visited = set()
    components = 0
    isolated_nodes = 0
    for start in sorted(node_ids):
        if start in visited:
            continue
        components += 1
        if not adjacent[start]:
            visited.add(start)
            isolated_nodes += 1
            continue
        stack = [start]
        visited.add(start)
        while stack:
            current = stack.pop()
            for neighbor in adjacent[current]:
                if neighbor not in visited:
                    visited.add(neighbor)
                    stack.append(neighbor)

    # ② 链深（Kahn 最长路径分层；环锁住的节点拿不到深度，单独计数）
    working_in_degree = dict(in_degree)
    depth: Dict[str, int] = {}
    queue = sorted(nid for nid in node_ids if working_in_degree[nid] == 0)
    for nid in queue:
        depth[nid] = 0
    head = 0
    while head < len(queue):
        current = queue[head]
        head += 1
        for nxt in out_adjacent[current]:
            candidate = depth[current] + 1
            if candidate > depth.get(nxt, -1):
                depth[nxt] = candidate
            working_in_degree[nxt] -= 1
            if working_in_degree[nxt] == 0:
                queue.append(nxt)
                depth.setdefault(nxt, 0)
    cycle_locked = [nid for nid in node_ids if nid not in depth]

    depth_by_kind: Dict[str, Dict[str, Any]] = {}
    for node in nodes:
        kind = _text(node.get("kind")) or "unknown"
        entry = depth_by_kind.setdefault(kind, {"nodes": 0, "max_depth": 0, "depth_histogram": {}})
        node_depth = depth.get(_text(node.get("id")))
        if node_depth is None:
            entry["cycle_locked"] = entry.get("cycle_locked", 0) + 1
            continue
        entry["nodes"] += 1
        entry["max_depth"] = max(entry["max_depth"], node_depth)
        bucket = str(node_depth)
        entry["depth_histogram"][bucket] = entry["depth_histogram"].get(bucket, 0) + 1

    # ③ 无先修来源的知识节点（入度为 0；模块/笔记不算——它们本就不是知识链一环）
    no_prereq = [
        {"id": _text(node.get("id")), "label": _text(node.get("label"))}
        for node in nodes
        if _text(node.get("kind")) == "knowledge" and in_degree.get(_text(node.get("id")), 0) == 0
    ]

    # ④ quiz_weak 覆盖率（快照可选参考字段；缺失时明说跳过，不猜）
    quiz_raw = data.get("quiz_weak")
    if not isinstance(quiz_raw, list) or not quiz_raw:
        quiz_section: Dict[str, Any] = {"present": False, "note": "快照未带检测薄弱点（quiz_weak），跳过覆盖率统计"}
    else:
        items = []
        for entry in quiz_raw:
            if not isinstance(entry, dict):
                continue
            title = _text(entry.get("title"))
            if not title:
                continue
            needle = title.lower()
            matched = None
            for node in nodes:
                if _text(node.get("label")).lower() == needle:
                    matched = node
                    break
            if matched is None:
                for node in nodes:
                    label = _text(node.get("label")).lower()
                    if label and (needle in label or label in needle):
                        matched = node
                        break
            if matched is not None:
                matched_id = _text(matched.get("id"))
                outgoing = out_degree.get(matched_id, 0)
                items.append({
                    "title": title,
                    "covered": True,
                    "node_id": matched_id,
                    "node_label": _text(matched.get("label")),
                    "outgoing_edges": outgoing,
                    "note": "图上有对应节点" + ("；但它没有任何向外延伸的连线，缺进阶链" if outgoing == 0 else ""),
                })
            else:
                items.append({"title": title, "covered": False, "note": "图上没有对应节点——薄弱考点尚未进图"})
        covered_count = sum(1 for item in items if item.get("covered"))
        quiz_section = {
            "present": True,
            "total": len(items),
            "covered": covered_count,
            "items": items,
        }

    result: Dict[str, Any] = {
        "nodes": len(nodes),
        "edges": len(edges),
        "components": components,
        "components_note": (
            "全部节点连成一片，没有孤岛主题" if components <= 1
            else f"图分成了 {components} 个互不连通的部分——主题之间的先修链断了，建议补连线"
        ),
        "isolated_nodes": isolated_nodes,
        "depth_by_kind": depth_by_kind,
        "no_prereq_knowledge": {
            "count": len(no_prereq),
            "items": no_prereq[:_READONLY_STATS_NODE_LIMIT],
            "truncated": len(no_prereq) > _READONLY_STATS_NODE_LIMIT,
            "note": "这些知识节点没有任何先修来源连线——是真正的学习起点，还是缺了前置连线，需结合内容判断",
        },
        "quiz_weak_coverage": quiz_section,
    }
    if cycle_locked:
        result["cycle_locked"] = len(cycle_locked)
        result["cycle_note"] = "有连线成环，环上节点的深度无法计层（不进直方图）——建议检查是否有互相依赖"
    return result


def execute_readonly_tool(name: str, arguments: Any, snapshot: Any, kb: Optional[Dict[str, Any]] = None, semantic_hits: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Execute one read-only graph query against the snapshot.

    snapshot 必须是归一化后的完整快照（未做焦点收缩/正文压缩的那一份）——
    read_node 的价值就在于把目录行降级掉的正文全文取回来，调用方负责传对。

    kb（2026-10-03 智能化第二期）：知识检索工具的数据源，形如
    {"knowledge": [...], "formulas": [...]}，由调用方加载注入；缺省 None
    时知识检索工具回「数据不可用」，图查询三件套不受影响。

    semantic_hits（优化新路径三，2026-10-09）：字面检索完全 miss 时的语义召回
    候选，由调用方（review.py 的查询回灌循环）经 harness.semantic 算好注入——
    本函数保持纯同步、不碰 embedding；只在对应检索零字面命中时用于补位，
    条目带 semantic/score 标记。None/空时行为与从前逐字节一致。

    参数非法/缺必填时返回 {"error": ...} 而不是抛异常：这是回给模型的工具
    结果，让模型看到错误后自行纠正，不打断查询循环。
    """
    if name not in READONLY_TOOL_NAMES:
        return {"error": f"未知的只读工具：{name or '空'}"}
    if not isinstance(arguments, dict):
        return {"error": f"参数无效：{name} 的参数必须是 JSON 对象"}

    # ---- 知识检索两件套：数据源是 kb，不碰图快照 ----
    if name in KB_TOOL_NAMES:
        keyword = _text(arguments.get("keyword") or arguments.get("query") or arguments.get("text"))
        if not keyword:
            return {"error": f"参数无效：{name} 需要 keyword"}
        if not isinstance(kb, dict):
            return {"error": "知识库数据不可用（服务端未加载到用户知识数据）"}
        needle = keyword.lower()
        if name == "search_knowledge":
            entries = [item for item in (kb.get("knowledge") or []) if isinstance(item, dict)]
            if not entries:
                return {"matches": [], "count": 0, "total": 0, "truncated": False,
                        "note": "知识库为空：还没有从对话中收集到知识点"}
            ranked = [
                item for item in entries
                if needle in _text(item.get("title")).lower()
                or needle in _text(item.get("summary")).lower()
                or needle in " ".join(str(tag) for tag in (item.get("tags") or [])).lower()
            ]
            if not ranked and semantic_hits:
                # 路径三：字面完全 miss 才用语义召回补位（条目由调用方算好注入，
                # 数量已封顶；semantic 标记让模型知道这是近似匹配）
                sem_matches = [
                    {
                        "title": _text(hit.get("item", {}).get("title")),
                        "category": _text(hit.get("item", {}).get("category")),
                        "tags": [str(tag) for tag in (hit.get("item", {}).get("tags") or [])][:4],
                        "excerpt": _text(hit.get("item", {}).get("summary"))[:_READONLY_EXCERPT_CHARS],
                        "formulas_count": len(hit.get("item", {}).get("formulas") or []),
                        "semantic": True,
                        "score": hit.get("score"),
                    }
                    for hit in semantic_hits[:_READONLY_SEARCH_LIMIT]
                    if isinstance(hit, dict) and isinstance(hit.get("item"), dict)
                ]
                return {
                    "matches": sem_matches,
                    "count": len(sem_matches),
                    "total": len(sem_matches),
                    "truncated": False,
                    "note": "字面无命中，以下为语义近似结果",
                }
            matches = [
                {
                    "title": _text(item.get("title")),
                    "category": _text(item.get("category")),
                    "tags": [str(tag) for tag in (item.get("tags") or [])][:4],
                    "excerpt": _text(item.get("summary"))[:_READONLY_EXCERPT_CHARS],
                    "formulas_count": len(item.get("formulas") or []),
                }
                for item in ranked[:_READONLY_SEARCH_LIMIT]
            ]
            return {
                "matches": matches,
                "count": len(matches),
                "total": len(ranked),
                "truncated": len(ranked) > _READONLY_SEARCH_LIMIT,
            }
        # search_formulas
        entries = [item for item in (kb.get("formulas") or []) if isinstance(item, dict)]
        if not entries:
            return {"matches": [], "count": 0, "total": 0, "truncated": False,
                    "note": "公式速查为空：还没有从对话中收集到公式"}
        ranked = [
            item for item in entries
            if needle in _text(item.get("latex")).lower()
            or needle in _text(item.get("concept")).lower()
            or needle in _text(item.get("meaning")).lower()
        ]
        if not ranked and semantic_hits:
            # 路径三：公式速查的字面 miss 语义补位（同知识库口径）
            sem_matches = [
                {
                    "latex": _text(hit.get("item", {}).get("latex")).replace("$", "")[:_READONLY_FORMULA_CHARS],
                    "concept": _text(hit.get("item", {}).get("concept")),
                    "meaning_excerpt": _text(hit.get("item", {}).get("meaning"))[:_READONLY_EXCERPT_CHARS],
                    "semantic": True,
                    "score": hit.get("score"),
                }
                for hit in semantic_hits[:_READONLY_SEARCH_LIMIT]
                if isinstance(hit, dict) and isinstance(hit.get("item"), dict)
            ]
            return {
                "matches": sem_matches,
                "count": len(sem_matches),
                "total": len(sem_matches),
                "truncated": False,
                "note": "字面无命中，以下为语义近似结果",
            }
        matches = [
            {
                "latex": _text(item.get("latex")).replace("$", "")[:_READONLY_FORMULA_CHARS],
                "concept": _text(item.get("concept")),
                "meaning_excerpt": _text(item.get("meaning"))[:_READONLY_EXCERPT_CHARS],
            }
            for item in ranked[:_READONLY_SEARCH_LIMIT]
        ]
        return {
            "matches": matches,
            "count": len(matches),
            "total": len(ranked),
            "truncated": len(ranked) > _READONLY_SEARCH_LIMIT,
        }

    data = snapshot if isinstance(snapshot, dict) else {}
    nodes = [node for node in (data.get("nodes") or []) if isinstance(node, dict)]
    edges = [edge for edge in (data.get("edges") or []) if isinstance(edge, dict)]

    # 学习教练（路径六第 1 档）：整图统计不取参数，多余的 arguments 也接受
    # （部分模型爱传 {} 或 {"include": "all"}，不接受会平白多一轮纠错往返）
    if name == "graph_stats":
        return _graph_stats(nodes, edges, data)

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
    if not ranked and semantic_hits:
        # 路径三落点一：字面完全 miss 才用语义召回补位——「搜电磁感应找不到
        # 法拉第定律」由此召回。命中数已由调用方封顶；条目带 semantic/score
        # 标记，摘录从快照原文取（调用方只传 id/label/kind/score）。
        by_id = {_text(node.get("id")): node for node in nodes}
        sem_matches = []
        for hit in semantic_hits[:_READONLY_SEARCH_LIMIT]:
            if not isinstance(hit, dict):
                continue
            node = by_id.get(_text(hit.get("id")))
            if node is None:
                continue
            sem_matches.append({
                "id": _text(node.get("id")),
                "label": _text(node.get("label")),
                "kind": _text(node.get("kind")),
                "excerpt": _text(node.get("content"))[:_READONLY_EXCERPT_CHARS],
                "semantic": True,
                "score": hit.get("score"),
            })
        return {
            "matches": sem_matches,
            "count": len(sem_matches),
            "total": len(sem_matches),
            "truncated": False,
            "note": "字面无命中，以下为语义近似结果",
        }
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
