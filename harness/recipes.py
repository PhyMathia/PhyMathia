"""节点配方 schema 校验器（后端投影，P1）。

设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md（第 3 节 schema、第 6 节 P1）。
与前端 ``src/static/js/graph-recipes.js`` 的 ``normalizeRecipeInput``/``validateRecipe``
同构——两侧由 ``tests/test_recipe_schema.py`` 对拍守护，改任何一侧先同步另一侧。

P1 的调用方是测试与未来 P3（Φ 产出配方时后端把关）；配方库存储在前端
（localStorage + /api/kv/node_recipes 镜像），后端不存配方。

规则口径（与 JS 逐条对应）：
- 名称必填、≤24 字、与现有清单查重（同 id 除外）
- 底座 kind 只允许 P1 白名单（module/summary/knowledge/relation/note/human_note/manual/question）
- 色板只允许成对令牌 key（不开放自由 hex，D-R8）
- AI 底座必须有主提示词；每个提示词槽 ≤800 字（RECIPE_PROMPT_BUDGET）
- 出口 ≤8 个，名字 ≤12 字、不重复；drag_form 只允许 draft / user / connected:<key>
- content_kind 只允许 markdown / plain
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

RECIPE_BASE_KINDS = ("module", "summary", "knowledge", "relation", "note", "human_note", "manual", "question")
RECIPE_AI_BASE_KINDS = ("module", "summary", "knowledge", "relation")
RECIPE_PALETTE_KEYS = ("amber", "blue", "rose", "teal", "violet", "human", "note")
RECIPE_SHAPES = ("is-round", "is-square", "is-diamond", "is-ring")
RECIPE_CONTENT_KINDS = ("markdown", "plain")
RECIPE_CONTEXT_CHANNELS = ("workflow_context", "prompt_inline")
RECIPE_PROMPT_BUDGET = 800
RECIPE_MAX_PORTS = 8
RECIPE_NAME_MAX = 24
RECIPE_DESC_MAX = 80
RECIPE_PORT_LABEL_MAX = 12

_DRAG_FORM_RE = re.compile(r"^connected:[a-z_]+$")


def _aggregation_for_base(base_kind: str) -> str:
    if base_kind == "knowledge":
        return "self_fields"
    if base_kind in RECIPE_AI_BASE_KINDS:
        return "ancestors"
    return "none"


def _default_shape(base_kind: str) -> str:
    # 与前端 RECIPE_BASE_META 的 shape 默认保持一致（modules/data=圆环族、人工=方）
    return {
        "module": "is-round",
        "summary": "is-round",
        "knowledge": "is-ring",
        "relation": "is-ring",
        "note": "is-square",
        "human_note": "is-square",
        "manual": "is-square",
        "question": "is-ring",
    }.get(base_kind, "is-round")


def _text(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_recipe_input(raw: Any) -> Optional[Dict[str, Any]]:
    """未知字段剥除＋类型收敛；名称缺失或底座不合法返回 None（与 JS 同口径）。"""
    if not isinstance(raw, dict):
        return None
    name = _text(raw.get("name"))
    base = raw.get("base") if isinstance(raw.get("base"), dict) else {}
    base_kind = _text(base.get("kind")) or "module"
    if not name or base_kind not in RECIPE_BASE_KINDS:
        return None
    appearance = raw.get("appearance") if isinstance(raw.get("appearance"), dict) else {}
    palette = _text(appearance.get("palette")) or "amber"
    shape = _text(appearance.get("shape")) or _default_shape(base_kind)
    g = raw.get("generate") if isinstance(raw.get("generate"), dict) else {}
    ports = raw.get("ports") if isinstance(raw.get("ports"), dict) else {}
    static_ports = ports.get("static") if isinstance(ports.get("static"), list) else []
    static_out = []
    for port in static_ports[: RECIPE_MAX_PORTS + 4]:
        if not isinstance(port, dict):
            continue
        label = _text(port.get("label"))[:RECIPE_PORT_LABEL_MAX]
        if not label:
            continue
        static_out.append({"label": label, "drag_form": _text(port.get("drag_form")) or "draft"})
    channel = _text(g.get("context_channel"))
    now = int(time.time() * 1000)

    def _num(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    return {
        "id": _text(raw.get("id")) or f"recipe-{now}-backend",
        "name": name[:RECIPE_NAME_MAX],
        "desc": _text(raw.get("desc"))[:RECIPE_DESC_MAX],
        "builtin": False,
        "base": {"kind": base_kind},
        "appearance": {"palette": palette, "shape": shape},
        "generate": {
            "prompt": _text(g.get("prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "strict_output": _text(g.get("strict_output"))[: RECIPE_PROMPT_BUDGET * 2],
            "followup_prompt": _text(g.get("followup_prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "confused_prompt": _text(g.get("confused_prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "context_channel": channel if channel in RECIPE_CONTEXT_CHANNELS else "workflow_context",
        },
        "ports": {"static": static_out},
        "content_kind": raw.get("content_kind") if raw.get("content_kind") in RECIPE_CONTENT_KINDS else "markdown",
        "aggregation": _aggregation_for_base(base_kind),
        "createdAt": _num(raw.get("createdAt")) or now,
        "updatedAt": _num(raw.get("updatedAt")) or now,
    }


def validate_recipe(recipe: Any, existing: Optional[List[Any]] = None) -> Dict[str, Any]:
    """校验（前后端同构）。返回 {ok, errors}；existing 用于名称查重（同 id 除外）。"""
    errors: List[str] = []
    if not isinstance(recipe, dict):
        return {"ok": False, "errors": ["配方不是对象"]}
    name = _text(recipe.get("name"))
    if not name:
        errors.append("名称不能为空")
    elif len(name) > RECIPE_NAME_MAX:
        errors.append(f"名称最长 {RECIPE_NAME_MAX} 字")
    base = recipe.get("base") if isinstance(recipe.get("base"), dict) else {}
    base_kind = _text(base.get("kind"))
    if base_kind not in RECIPE_BASE_KINDS:
        errors.append("底座类型不在 P1 支持范围")
    appearance = recipe.get("appearance") if isinstance(recipe.get("appearance"), dict) else {}
    if _text(appearance.get("palette")) not in RECIPE_PALETTE_KEYS:
        errors.append("色板不合法（只能从成对色板令牌选）")
    shape = _text(appearance.get("shape"))
    if shape and shape not in RECIPE_SHAPES:
        errors.append("形状不合法")
    desc = _text(recipe.get("desc"))
    if len(desc) > RECIPE_DESC_MAX:
        errors.append(f"描述最长 {RECIPE_DESC_MAX} 字")
    g = recipe.get("generate") if isinstance(recipe.get("generate"), dict) else {}
    for slot in ("prompt", "strict_output", "followup_prompt", "confused_prompt"):
        text = _text(g.get(slot))
        if len(text) > RECIPE_PROMPT_BUDGET:
            errors.append(f"提示词槽「{slot}」超预算（建议单项 ≤{RECIPE_PROMPT_BUDGET} 字，当前 {len(text)}）")
    if base_kind in RECIPE_AI_BASE_KINDS and not _text(g.get("prompt")):
        errors.append("AI 底座必须填写主提示词")
    channel = _text(g.get("context_channel"))
    if channel and channel not in RECIPE_CONTEXT_CHANNELS:
        errors.append("上下文通道不合法")
    ports = recipe.get("ports") if isinstance(recipe.get("ports"), dict) else {}
    static_ports = ports.get("static") if isinstance(ports.get("static"), list) else []
    if len(static_ports) > RECIPE_MAX_PORTS:
        errors.append(f"出口最多 {RECIPE_MAX_PORTS} 个")
    seen_labels = set()
    for port in static_ports:
        if not isinstance(port, dict):
            errors.append("存在没有名字的出口")
            continue
        label = _text(port.get("label"))
        if not label:
            errors.append("存在没有名字的出口")
        elif len(label) > RECIPE_PORT_LABEL_MAX:
            errors.append(f"出口「{label}」名字最长 {RECIPE_PORT_LABEL_MAX} 字")
        if label in seen_labels:
            errors.append(f"出口名字重复：「{label}」")
        seen_labels.add(label)
        form = _text(port.get("drag_form")) or "draft"
        if form not in ("draft", "user") and not _DRAG_FORM_RE.match(form):
            errors.append(f"出口「{label}」的拖出目标不合法")
    content_kind = recipe.get("content_kind")
    if content_kind and content_kind not in RECIPE_CONTENT_KINDS:
        errors.append("内容载体不合法（P1 只支持 markdown / plain）")
    dup = any(
        isinstance(item, dict) and _text(item.get("name")) == name and _text(item.get("id")) != _text(recipe.get("id"))
        for item in (existing or [])
    )
    if dup:
        errors.append(f"已有同名配方：「{name}」")
    return {"ok": not errors, "errors": errors}
