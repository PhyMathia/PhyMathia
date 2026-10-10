"""节点配方 schema 校验器（后端投影，P1＋P2）。

设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md（第 3 节 schema、第 6 节 P1/P2）。
与前端 ``src/static/js/graph-recipes.js`` 的 ``normalizeRecipeInput``/``validateRecipe``
同构——两侧由 ``tests/test_recipe_schema.py`` 对拍守护，改任何一侧先同步另一侧。

P3 起 Φ 产出配方时后端把关（preset 相位的 create_recipe/update_recipe op 过
``normalize_recipe_input``＋``validate_recipe``）；配方库存储在前端
（localStorage + /api/kv/node_recipes 镜像），后端不存配方。

规则口径（与 JS 逐条对应）：
- 名称必填、≤24 字、与现有清单查重（同 id 除外）
- 底座 kind 只允许白名单（module/summary/knowledge/relation/note/human_note/manual/question）
- 色板只允许成对令牌 key（D-R8 的预设档）；另允许可选的 ``appearance.color``
  自由色（#rrggbb / #rgb；2026-09-30 用户拍板放宽），给了就压过 palette 令牌
- AI 底座必须有主提示词；每个提示词槽（含 retry_prompt）≤800 字
- 出口 ≤8 个，名字 ≤12 字、不重复；drag_form 只允许 draft / user / connected:<key>
- T263 端口分类体系 v2：出口/输入端口可选内容类型（text/formula/diagram/html，与内容
  载体同源，不填＝不限）；具名输入端口 ``ports.inputs`` ≤8 个 {label, type}，
  名字 ≤12 字、组内不重复（与出口表各自独立去重）；类型不拦连线
- P2：动态出口（parser.numbered_list / label_from / fallback.mode / each.type）全枚举；
  content_kind 允许 mermaid / html_iframe（须 AI 底座）；model_role 六槽；
  aggregation: first_inbound 与 analysis_phase 仅 module 底座；on_generated 引用闭环
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional

RECIPE_BASE_KINDS = ("module", "summary", "knowledge", "relation", "note", "human_note", "manual", "question")
RECIPE_AI_BASE_KINDS = ("module", "summary", "knowledge", "relation")
RECIPE_PALETTE_KEYS = ("amber", "blue", "rose", "teal", "violet", "human", "note")
RECIPE_SHAPES = ("is-round", "is-square", "is-diamond", "is-ring")
RECIPE_CONTENT_KINDS = ("markdown", "plain", "mermaid", "html_iframe")
RECIPE_CONTEXT_CHANNELS = ("workflow_context", "prompt_inline")
RECIPE_MODEL_ROLES = ("agent", "html", "branch", "graph", "quiz", "descriptor")
RECIPE_PARSER_PATTERNS = ("numbered_list",)
RECIPE_LABEL_FROM = ("index_question", "question_trunc12")
RECIPE_FALLBACK_MODES = ("static", "label_questions_from_text", "none")
RECIPE_DYNAMIC_PORT_TYPES = ("socratic", "learn", "branch")
RECIPE_AGGREGATIONS = ("ancestors", "self_fields", "first_inbound", "none")
RECIPE_ON_GENERATED_KINDS = ("answer", "module", "blank", "user", "note", "human_note")
RECIPE_ON_GENERATED_CONTENT_FROM = ("", "self_content", "self_directions")
RECIPE_PROMPT_BUDGET = 800
RECIPE_MAX_PORTS = 8
# T263 端口分类体系 v2：内容类型枚举（与前端 RECIPE_PORT_TYPES 对拍；不填＝不限）
RECIPE_PORT_TYPES = ("text", "formula", "diagram", "html")
RECIPE_MAX_INPUTS = 8
RECIPE_MAX_DYNAMIC = 12
RECIPE_MAX_ON_GENERATED = 4
RECIPE_NAME_MAX = 24
RECIPE_DESC_MAX = 80
RECIPE_PORT_LABEL_MAX = 12

_DRAG_FORM_RE = re.compile(r"^connected:[a-z_]+$")
_RECIPE_COLOR_RE = re.compile(r"^#(?:[0-9a-f]{3}|[0-9a-f]{6})$")


def _normalize_color(value: Any) -> str:
    """自由色归一化（与前端 normalizeRecipeColor 同口径）：短写补齐、非法返回空串。"""
    raw = _text(value).lower()
    if not _RECIPE_COLOR_RE.match(raw):
        return ""
    if len(raw) == 4:
        return "#" + raw[1] * 2 + raw[2] * 2 + raw[3] * 2
    return raw


def _aggregation_for_base(base_kind: str, override: Any = None) -> str:
    if base_kind == "module" and override == "first_inbound":
        return "first_inbound"
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


def _normalize_dynamic(raw: Any) -> Optional[Dict[str, Any]]:
    d = raw if isinstance(raw, dict) else {}
    p = d.get("parser") if isinstance(d.get("parser"), dict) else None
    if p is None:
        return None
    pattern = p.get("pattern") if p.get("pattern") in RECIPE_PARSER_PATTERNS else "numbered_list"
    level_tags_raw = p.get("level_tags") if isinstance(p.get("level_tags"), list) else []
    level_tags = [_text(tag)[:6] for tag in level_tags_raw if _text(tag)][:4]
    try:
        max_items = max(1, min(RECIPE_MAX_DYNAMIC, int(p.get("max") or RECIPE_MAX_DYNAMIC)))
    except (TypeError, ValueError):
        max_items = RECIPE_MAX_DYNAMIC
    label_from = p.get("label_from") if p.get("label_from") in RECIPE_LABEL_FROM else "index_question"
    f = d.get("fallback") if isinstance(d.get("fallback"), dict) else {}
    fallback_mode = f.get("mode") if f.get("mode") in RECIPE_FALLBACK_MODES else "label_questions_from_text"
    labels_raw = f.get("labels") if isinstance(f.get("labels"), list) else []
    fallback_labels = [_text(label)[:RECIPE_PORT_LABEL_MAX] for label in labels_raw if _text(label)][:RECIPE_MAX_PORTS]
    e = d.get("each") if isinstance(d.get("each"), dict) else {}
    each_type = e.get("type") if e.get("type") in RECIPE_DYNAMIC_PORT_TYPES else "socratic"
    return {
        "parser": {"pattern": pattern, "level_tags": level_tags, "max": max_items, "label_from": label_from},
        "fallback": {"mode": fallback_mode, "labels": fallback_labels},
        "each": {
            "type": each_type,
            "branch_type": _text(e.get("branch_type")) or each_type,
            "drag_form": "user" if e.get("drag_form") == "user" else "draft",
        },
    }


def _normalize_on_generated(raw: Any) -> Optional[Dict[str, Any]]:
    s = raw if isinstance(raw, dict) else None
    if s is None:
        return None
    create_out: List[Dict[str, Any]] = []
    for item in (s.get("create") if isinstance(s.get("create"), list) else [])[:RECIPE_MAX_ON_GENERATED]:
        if not isinstance(item, dict):
            continue
        base = item.get("base") if isinstance(item.get("base"), dict) else {}
        kind = base.get("kind") if base.get("kind") in RECIPE_ON_GENERATED_KINDS else ""
        if not kind:
            continue
        entry: Dict[str, Any] = {"as": _text(item.get("as"))[:8], "base": {"kind": kind}}
        recipe_ref = _text(base.get("recipe"))[:64]
        if recipe_ref:
            entry["base"]["recipe"] = recipe_ref
        if _text(item.get("label_template")):
            entry["label_template"] = str(item.get("label_template"))[:40]
        elif _text(item.get("label")):
            entry["label"] = _text(item.get("label"))[:RECIPE_NAME_MAX]
        content_from = item.get("content_from") if item.get("content_from") in RECIPE_ON_GENERATED_CONTENT_FROM else ""
        if content_from:
            entry["content_from"] = content_from
        create_out.append(entry)
    if not create_out:
        return None
    refs = {item["as"] for item in create_out}
    connect_out: List[Dict[str, Any]] = []
    for item in (s.get("connect") if isinstance(s.get("connect"), list) else []):
        if not isinstance(item, dict):
            continue
        src = _text(item.get("from"))
        dst = _text(item.get("to"))
        if src != "self" and src not in refs:
            continue
        if dst not in refs:
            continue
        connect_out.append({"from": src, "to": dst, "relation": _text(item.get("relation"))[:12]})
    return {
        "create": create_out,
        "connect": connect_out,
        "chain_check": s.get("chain_check") is True,
    }


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
    custom_color = _normalize_color(appearance.get("color"))
    # 形状不是配方参数（2026-10-09 用户拍板）：按底座推导，输入里的 shape 一律忽略
    shape = _default_shape(base_kind)
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
        entry: Dict[str, Any] = {"label": label, "drag_form": _text(port.get("drag_form")) or "draft"}
        # 出口类型可选（覆盖时才落库，缺省按 content_kind 自动推导）
        port_type = port.get("type") if port.get("type") in RECIPE_PORT_TYPES else ""
        if port_type:
            entry["type"] = port_type
        static_out.append(entry)
    # 具名输入端口（T263）：{label, type}，type 缺省 ""＝不限；旧设计稿的数字型
    # inputs 不是列表，走到这里自然剥除；空表不设键（与 dynamic 同法，对拍友好）
    input_ports = ports.get("inputs") if isinstance(ports.get("inputs"), list) else []
    inputs_out = []
    for port in input_ports[: RECIPE_MAX_INPUTS + 4]:
        if not isinstance(port, dict):
            continue
        label = _text(port.get("label"))[:RECIPE_PORT_LABEL_MAX]
        if not label:
            continue
        inputs_out.append({
            "label": label,
            "type": port.get("type") if port.get("type") in RECIPE_PORT_TYPES else "",
        })
    channel = _text(g.get("context_channel"))
    model_role = g.get("model_role") if g.get("model_role") in RECIPE_MODEL_ROLES else "agent"
    on_incomplete_raw = g.get("on_incomplete") if isinstance(g.get("on_incomplete"), dict) else {}
    try:
        max_retries = max(0, min(2, int(on_incomplete_raw.get("max_retries", 1))))
    except (TypeError, ValueError):
        max_retries = 1
    dynamic = _normalize_dynamic(ports.get("dynamic"))
    on_generated = _normalize_on_generated(raw.get("on_generated"))
    content_kind = raw.get("content_kind") if raw.get("content_kind") in RECIPE_CONTENT_KINDS else "markdown"
    now = int(time.time() * 1000)

    def _num(value: Any) -> int:
        try:
            return int(value)
        except (TypeError, ValueError):
            return 0

    recipe = {
        "id": _text(raw.get("id")) or f"recipe-{now}-backend",
        "name": name[:RECIPE_NAME_MAX],
        "desc": _text(raw.get("desc"))[:RECIPE_DESC_MAX],
        "builtin": False,
        "base": {"kind": base_kind},
        # 自由色是可选段：不声明就不设键（与前端 normalize 同形，对拍/快照友好）
        "appearance": (
            {"palette": palette, "color": custom_color, "shape": shape}
            if custom_color else {"palette": palette, "shape": shape}
        ),
        "generate": {
            "prompt": _text(g.get("prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "strict_output": _text(g.get("strict_output"))[: RECIPE_PROMPT_BUDGET * 2],
            "followup_prompt": _text(g.get("followup_prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "confused_prompt": _text(g.get("confused_prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "retry_prompt": _text(g.get("retry_prompt"))[: RECIPE_PROMPT_BUDGET * 2],
            "context_channel": channel if channel in RECIPE_CONTEXT_CHANNELS else "workflow_context",
            "model_role": model_role,
            "on_incomplete": {"max_retries": max_retries},
        },
        "ports": {"static": static_out},
        "content_kind": content_kind,
        "aggregation": _aggregation_for_base(base_kind, raw.get("aggregation")),
        "analysis_phase": base_kind == "module" and raw.get("analysis_phase") is True,
        "createdAt": _num(raw.get("createdAt")) or now,
        "updatedAt": _num(raw.get("updatedAt")) or now,
    }
    if dynamic is not None:
        recipe["ports"]["dynamic"] = dynamic
    if inputs_out:
        recipe["ports"]["inputs"] = inputs_out
    if on_generated is not None:
        recipe["on_generated"] = on_generated
    return recipe


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
    # 自由色是可选段：给了就必须是真的 hex（表单只吐合法值，这里挡手改/导入的脏数据）
    if _text(appearance.get("color")) and not _normalize_color(appearance.get("color")):
        errors.append("自定义颜色不合法（要 #rrggbb 或 #rgb）")
    shape = _text(appearance.get("shape"))
    if shape and shape not in RECIPE_SHAPES:
        errors.append("形状不合法")
    desc = _text(recipe.get("desc"))
    if len(desc) > RECIPE_DESC_MAX:
        errors.append(f"描述最长 {RECIPE_DESC_MAX} 字")
    g = recipe.get("generate") if isinstance(recipe.get("generate"), dict) else {}
    for slot in ("prompt", "strict_output", "followup_prompt", "confused_prompt", "retry_prompt"):
        text = _text(g.get(slot))
        if len(text) > RECIPE_PROMPT_BUDGET:
            errors.append(f"提示词槽「{slot}」超预算（建议单项 ≤{RECIPE_PROMPT_BUDGET} 字，当前 {len(text)}）")
    if base_kind in RECIPE_AI_BASE_KINDS and not _text(g.get("prompt")):
        errors.append("AI 底座必须填写主提示词")
    channel = _text(g.get("context_channel"))
    if channel and channel not in RECIPE_CONTEXT_CHANNELS:
        errors.append("上下文通道不合法")
    model_role = _text(g.get("model_role"))
    if model_role and model_role not in RECIPE_MODEL_ROLES:
        errors.append("模型槽位不合法（agent/html/branch/graph/quiz/descriptor）")
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
        if port.get("type") and port.get("type") not in RECIPE_PORT_TYPES:
            errors.append(f"出口「{label}」的类型不合法（text/formula/diagram/html 或留空）")
    # 具名输入端口（T263）：与出口同款校验，去重独立于出口表
    input_ports = ports.get("inputs") if isinstance(ports.get("inputs"), list) else []
    if len(input_ports) > RECIPE_MAX_INPUTS:
        errors.append(f"输入端口最多 {RECIPE_MAX_INPUTS} 个")
    seen_input_labels = set()
    for port in input_ports:
        if not isinstance(port, dict):
            errors.append("存在没有名字的输入端口")
            continue
        label = _text(port.get("label"))
        if not label:
            errors.append("存在没有名字的输入端口")
        elif len(label) > RECIPE_PORT_LABEL_MAX:
            errors.append(f"输入端口「{label}」名字最长 {RECIPE_PORT_LABEL_MAX} 字")
        if label in seen_input_labels:
            errors.append(f"输入端口名字重复：「{label}」")
        seen_input_labels.add(label)
        if port.get("type") and port.get("type") not in RECIPE_PORT_TYPES:
            errors.append(f"输入端口「{label}」的类型不合法（text/formula/diagram/html 或留空）")
    dynamic = ports.get("dynamic") if isinstance(ports.get("dynamic"), dict) else None
    if dynamic is not None:
        if base_kind != "module":
            errors.append("动态出口只支持视角模块底座")
        parser = dynamic.get("parser") if isinstance(dynamic.get("parser"), dict) else {}
        if parser.get("pattern") not in RECIPE_PARSER_PATTERNS:
            errors.append("动态出口解析器不合法（P2 只支持 numbered_list）")
        if parser.get("label_from") and parser.get("label_from") not in RECIPE_LABEL_FROM:
            errors.append("动态出口标签方式不合法")
        try:
            max_items = int(parser.get("max") or RECIPE_MAX_DYNAMIC)
        except (TypeError, ValueError):
            max_items = RECIPE_MAX_DYNAMIC
        if max_items < 1 or max_items > RECIPE_MAX_DYNAMIC:
            errors.append(f"动态出口上限须在 1～{RECIPE_MAX_DYNAMIC} 之间")
        fallback = dynamic.get("fallback") if isinstance(dynamic.get("fallback"), dict) else {}
        if fallback.get("mode") and fallback.get("mode") not in RECIPE_FALLBACK_MODES:
            errors.append("动态出口兜底方式不合法")
        fallback_labels = fallback.get("labels") if isinstance(fallback.get("labels"), list) else []
        if len(fallback_labels) > RECIPE_MAX_PORTS:
            errors.append(f"兜底出口名最多 {RECIPE_MAX_PORTS} 个")
        each = dynamic.get("each") if isinstance(dynamic.get("each"), dict) else {}
        if each.get("type") and each.get("type") not in RECIPE_DYNAMIC_PORT_TYPES:
            errors.append("动态出口的端口行为不合法（socratic/learn/branch）")
    content_kind = recipe.get("content_kind")
    if content_kind and content_kind not in RECIPE_CONTENT_KINDS:
        errors.append("内容载体不合法（markdown / plain / mermaid / html_iframe）")
    ai_base = base_kind in RECIPE_AI_BASE_KINDS
    if content_kind in ("mermaid", "html_iframe") and not ai_base:
        errors.append("mermaid / html_iframe 载体需要 AI 底座")
    if recipe.get("aggregation") == "first_inbound" and base_kind != "module":
        errors.append("单链取材（first_inbound）只支持视角模块底座")
    if recipe.get("analysis_phase") and base_kind != "module":
        errors.append("双阶段概要（analysis_phase）只支持视角模块底座")
    on_generated = recipe.get("on_generated") if isinstance(recipe.get("on_generated"), dict) else None
    if on_generated is not None:
        create = on_generated.get("create") if isinstance(on_generated.get("create"), list) else []
        refs = {_text(item.get("as")) for item in create if isinstance(item, dict)}
        for index, item in enumerate(create):
            if not isinstance(item, dict) or not _text(item.get("as")):
                errors.append(f"生成后动作第 {index + 1} 项缺少 as 引用")
                continue
            base = item.get("base") if isinstance(item.get("base"), dict) else {}
            if base.get("kind") not in RECIPE_ON_GENERATED_KINDS:
                errors.append(f"生成后动作「{_text(item.get('as'))}」的底座不合法")
        for item in on_generated.get("connect", []) if isinstance(on_generated.get("connect"), list) else []:
            if not isinstance(item, dict):
                continue
            src = _text(item.get("from"))
            dst = _text(item.get("to"))
            if src != "self" and src not in refs:
                errors.append(f"生成后连线 from 引用未声明：「{src}」")
            if dst not in refs:
                errors.append(f"生成后连线 to 引用未声明：「{dst}」")
    dup = any(
        isinstance(item, dict) and _text(item.get("name")) == name and _text(item.get("id")) != _text(recipe.get("id"))
        for item in (existing or [])
    )
    if dup:
        errors.append(f"已有同名配方：「{name}」")
    return {"ok": not errors, "errors": errors}
