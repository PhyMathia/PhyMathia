"""节点配方 schema 对拍测试（P1＋P2）。

前端 src/static/js/graph-recipes.js 的 normalizeRecipeInput / validateRecipe 与
后端 harness/recipes.py 必须同构：常量逐值一致、同一批样本两侧判决一致。
改任何一侧先同步另一侧（设计文档第 6 节 P1/P2 的「前后端同构校验器」条目）。
"""

from __future__ import annotations

import json
import re
import subprocess

import tempfile
from pathlib import Path

from harness.recipes import (
    RECIPE_AI_BASE_KINDS,
    RECIPE_BASE_KINDS,
    RECIPE_CONTENT_KINDS,
    RECIPE_CONTEXT_CHANNELS,
    RECIPE_DYNAMIC_PORT_TYPES,
    RECIPE_FALLBACK_MODES,
    RECIPE_LABEL_FROM,
    RECIPE_MAX_DYNAMIC,
    RECIPE_MAX_PORTS,
    RECIPE_MODEL_ROLES,
    RECIPE_ON_GENERATED_KINDS,
    RECIPE_PARSER_PATTERNS,
    RECIPE_PALETTE_KEYS,
    RECIPE_PROMPT_BUDGET,
    RECIPE_SHAPES,
    normalize_recipe_input,
    validate_recipe,
)

ROOT = Path(__file__).resolve().parent.parent
RECIPES_JS = ROOT / "src" / "static" / "js" / "graph-recipes.js"


def _js_constants() -> dict:
    """从 graph-recipes.js 抽常量字面量（P1＋P2 段），与后端逐值对拍。"""
    src = RECIPES_JS.read_text(encoding="utf-8")
    out = {}

    def arr(name: str) -> list:
        m = re.search(name + r"\s*=\s*\[([^\]]+)\]", src)
        assert m, f"前端缺常量 {name}"
        return re.findall(r"'([^']+)'", m.group(1))

    out["base_kinds"] = arr("RECIPE_BASE_KINDS")
    out["ai_base_kinds"] = arr("RECIPE_AI_BASE_KINDS")
    out["shapes"] = arr("RECIPE_SHAPES")
    out["content_kinds"] = arr("RECIPE_CONTENT_KINDS")
    out["channels"] = arr("RECIPE_CONTEXT_CHANNELS")
    out["model_roles"] = arr("RECIPE_MODEL_ROLES")
    out["parser_patterns"] = arr("RECIPE_PARSER_PATTERNS")
    out["label_from"] = arr("RECIPE_LABEL_FROM")
    out["fallback_modes"] = arr("RECIPE_FALLBACK_MODES")
    out["dynamic_port_types"] = arr("RECIPE_DYNAMIC_PORT_TYPES")
    out["on_generated_kinds"] = arr("RECIPE_ON_GENERATED_KINDS")
    m = re.search(r"RECIPE_PALETTE\s*=\s*\[(.*?)\];", src, re.S)
    assert m, "前端缺 RECIPE_PALETTE"
    out["palette_keys"] = re.findall(r"key:\s*'([^']+)'", m.group(1))
    m = re.search(r"RECIPE_PROMPT_BUDGET\s*=\s*(\d+)", src)
    assert m, "前端缺 RECIPE_PROMPT_BUDGET"
    out["prompt_budget"] = int(m.group(1))
    m = re.search(r"RECIPE_MAX_PORTS\s*=\s*(\d+)", src)
    assert m, "前端缺 RECIPE_MAX_PORTS"
    out["max_ports"] = int(m.group(1))
    m = re.search(r"RECIPE_MAX_DYNAMIC\s*=\s*(\d+)", src)
    assert m, "前端缺 RECIPE_MAX_DYNAMIC"
    out["max_dynamic"] = int(m.group(1))
    return out


def test_constants_match_between_frontend_and_backend():
    js = _js_constants()
    assert tuple(js["base_kinds"]) == RECIPE_BASE_KINDS
    assert tuple(js["ai_base_kinds"]) == RECIPE_AI_BASE_KINDS
    assert tuple(js["shapes"]) == RECIPE_SHAPES
    assert tuple(js["content_kinds"]) == RECIPE_CONTENT_KINDS
    assert tuple(js["channels"]) == RECIPE_CONTEXT_CHANNELS
    assert tuple(js["model_roles"]) == RECIPE_MODEL_ROLES
    assert tuple(js["parser_patterns"]) == RECIPE_PARSER_PATTERNS
    assert tuple(js["label_from"]) == RECIPE_LABEL_FROM
    assert tuple(js["fallback_modes"]) == RECIPE_FALLBACK_MODES
    assert tuple(js["dynamic_port_types"]) == RECIPE_DYNAMIC_PORT_TYPES
    assert tuple(js["on_generated_kinds"]) == RECIPE_ON_GENERATED_KINDS
    assert tuple(js["palette_keys"]) == RECIPE_PALETTE_KEYS
    assert js["prompt_budget"] == RECIPE_PROMPT_BUDGET
    assert js["max_ports"] == RECIPE_MAX_PORTS
    assert js["max_dynamic"] == RECIPE_MAX_DYNAMIC


# ---- 样本：两侧都必须给出同样判决 ----

def _valid_sample() -> dict:
    return {
        "id": "recipe-test-1",
        "name": "错题复盘",
        "desc": "考后复盘：考点 / 易错点 / 口诀",
        "base": {"kind": "module"},
        "appearance": {"palette": "amber", "shape": "is-round"},
        "generate": {
            "prompt": "针对当前问题输出考后复盘，分三段：考点回顾 / 易错点 / 记忆口诀。",
            "strict_output": "只输出三段，每段以「### 」标题开头；不要前言和结语。",
            "followup_prompt": "",
            "confused_prompt": "",
            "context_channel": "workflow_context",
        },
        "ports": {"static": [{"label": "追问", "drag_form": "draft"}]},
        "content_kind": "markdown",
    }


def _dynamic_ports_spec() -> dict:
    """设计文档 3.2 试金石「我的追问器」的动态出口段。"""
    return {
        "parser": {"pattern": "numbered_list", "level_tags": ["基础", "进阶", "拓展"],
                   "max": 12, "label_from": "index_question"},
        "fallback": {"mode": "label_questions_from_text", "labels": ["问题1", "问题2", "问题3"]},
        "each": {"type": "socratic", "branch_type": "socratic", "drag_form": "draft"},
    }


def _samples() -> list:
    return [
        ("valid", _valid_sample(), []),
        ("no_name", {**_valid_sample(), "name": "  "}, ["名称不能为空"]),
        ("bad_base", {**_valid_sample(), "base": {"kind": "hub"}}, ["底座类型不在 P1 支持范围"]),
        ("bad_palette", {**_valid_sample(), "appearance": {"palette": "hotpink", "shape": "is-round"}},
         ["色板不合法（只能从成对色板令牌选）"]),
        # ---- 自由色（2026-09-30，D-R8 放宽）：可选段，给了就必须是真 hex ----
        ("valid_custom_color", {**_valid_sample(), "appearance": {
            "palette": "teal", "color": "#3aa", "shape": "is-round"}}, []),
        ("bad_custom_color", {**_valid_sample(), "appearance": {
            "palette": "teal", "color": "chartreuse", "shape": "is-round"}},
         ["自定义颜色不合法（要 #rrggbb 或 #rgb）"]),
        ("bad_custom_color_len", {**_valid_sample(), "appearance": {
            "palette": "teal", "color": "#12345", "shape": "is-round"}},
         ["自定义颜色不合法（要 #rrggbb 或 #rgb）"]),
        ("bad_custom_color_injection", {**_valid_sample(), "appearance": {
            "palette": "teal", "color": "red; background: url(x)", "shape": "is-round"}},
         ["自定义颜色不合法（要 #rrggbb 或 #rgb）"]),
        ("ai_base_no_prompt", {**_valid_sample(), "generate": {"prompt": "", "context_channel": "workflow_context"}},
         ["AI 底座必须填写主提示词"]),
        ("dup_port", {**_valid_sample(), "ports": {"static": [
            {"label": "追问", "drag_form": "draft"}, {"label": "追问", "drag_form": "user"}]}},
         ["出口名字重复：「追问」"]),
        ("bad_drag_form", {**_valid_sample(), "ports": {"static": [{"label": "出口", "drag_form": "explode"}]}},
         ["出口「出口」的拖出目标不合法"]),
        ("too_many_ports", {**_valid_sample(), "ports": {"static": [
            {"label": f"口{i}", "drag_form": "draft"} for i in range(RECIPE_MAX_PORTS + 1)]}},
         [f"出口最多 {RECIPE_MAX_PORTS} 个"]),
        ("bad_content_kind", {**_valid_sample(), "content_kind": "formula"},
         ["内容载体不合法（markdown / plain / mermaid / html_iframe）"]),
        # ---- P2：动态出口 / 载体 / 模型槽 / 取材与编排 ----
        ("valid_dynamic", {**_valid_sample(), "ports": {
            "static": [], "dynamic": _dynamic_ports_spec()}}, []),
        ("dynamic_on_summary", {**_valid_sample(), "base": {"kind": "summary"}, "ports": {
            "static": [], "dynamic": _dynamic_ports_spec()}},
         ["动态出口只支持视角模块底座"]),
        ("bad_pattern", {**_valid_sample(), "ports": {"static": [], "dynamic": {
            **_dynamic_ports_spec(), "parser": {**_dynamic_ports_spec()["parser"], "pattern": "regex"}}}},
         ["动态出口解析器不合法（P2 只支持 numbered_list）"]),
        ("bad_label_from", {**_valid_sample(), "ports": {"static": [], "dynamic": {
            **_dynamic_ports_spec(), "parser": {**_dynamic_ports_spec()["parser"], "label_from": "md_heading"}}}},
         ["动态出口标签方式不合法"]),
        ("bad_dynamic_max", {**_valid_sample(), "ports": {"static": [], "dynamic": {
            **_dynamic_ports_spec(), "parser": {**_dynamic_ports_spec()["parser"], "max": 99}}}},
         [f"动态出口上限须在 1～{RECIPE_MAX_DYNAMIC} 之间"]),
        ("bad_fallback_mode", {**_valid_sample(), "ports": {"static": [], "dynamic": {
            **_dynamic_ports_spec(), "fallback": {"mode": "explode", "labels": []}}}},
         ["动态出口兜底方式不合法"]),
        ("bad_each_type", {**_valid_sample(), "ports": {"static": [], "dynamic": {
            **_dynamic_ports_spec(), "each": {"type": "quiz", "drag_form": "draft"}}}},
         ["动态出口的端口行为不合法（socratic/learn/branch）"]),
        ("valid_viz_recipe", {
            **_valid_sample(),
            "content_kind": "html_iframe",
            "generate": {**_valid_sample()["generate"], "model_role": "html",
                         "retry_prompt": "请务必只输出完整 HTML，不要任何解释。",
                         "on_incomplete": {"max_retries": 1}},
        }, []),
        ("valid_mermaid_recipe", {**_valid_sample(), "content_kind": "mermaid"}, []),
        ("mermaid_on_manual_base", {**_valid_sample(), "base": {"kind": "manual"},
                                    "content_kind": "mermaid", "generate": {}},
         ["mermaid / html_iframe 载体需要 AI 底座"]),
        ("bad_model_role", {**_valid_sample(), "generate": {
            **_valid_sample()["generate"], "model_role": "vip"}},
         ["模型槽位不合法（agent/html/branch/graph/quiz/descriptor）"]),
        ("first_inbound_on_summary", {**_valid_sample(), "base": {"kind": "summary"},
                                      "aggregation": "first_inbound"},
         ["单链取材（first_inbound）只支持视角模块底座"]),
        ("analysis_phase_on_note", {**_valid_sample(), "base": {"kind": "note"},
                                    "analysis_phase": True, "generate": {}},
         ["双阶段概要（analysis_phase）只支持视角模块底座"]),
        ("valid_first_inbound", {**_valid_sample(), "aggregation": "first_inbound",
                                 "analysis_phase": True}, []),
        ("valid_on_generated", {**_valid_sample(), "on_generated": {
            "create": [
                {"as": "$0", "base": {"kind": "answer"}, "label_template": "{self.label}的进阶学习",
                 "content_from": "self_directions"},
                {"as": "$1", "base": {"kind": "module", "recipe": "learn"}, "label": "进阶学习"},
            ],
            "connect": [
                {"from": "self", "to": "$0", "relation": "进阶"},
                {"from": "$0", "to": "$1", "relation": "模块"},
            ],
            "chain_check": True,
        }}, []),
        ("on_generated_bad_ref", {**_valid_sample(), "on_generated": {
            "create": [{"as": "$0", "base": {"kind": "answer"}}],
            "connect": [{"from": "self", "to": "$9", "relation": "进阶"}],
        }}, ["生成后连线 to 引用未声明：「$9」"]),
        ("on_generated_bad_kind", {**_valid_sample(), "on_generated": {
            "create": [{"as": "$0", "base": {"kind": "source"}}],
        }}, ["生成后动作「$0」的底座不合法"]),
    ]


def test_backend_validate_on_samples():
    # 直接校验原始输入（表单口径）：非法枚举要在 validate 当场报错；
    # 「先 normalize 再 validate」的导入口径（非法枚举被收敛成默认值）另测
    for name, sample, expected in _samples():
        verdict = validate_recipe(sample, [])
        got = verdict["errors"]
        assert sorted(got) == sorted(expected), f"样本 {name}：期望 {expected}，实际 {got}"


# ---- 前端侧：用 node 直接执行 normalizeRecipeInput/validateRecipe（沙箱）----

_JS_RUNNER = r"""
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(%r, 'utf8');
// graph-recipes.js 顶层引用 STORAGE_KEY_NODE_RECIPES（config.js 常量）与 localStorage，
// 沙箱里补上即可；BUILTIN_RECIPES 段不依赖任何外部。
const sandbox = {
  console, setTimeout: () => 0,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  fetch: async () => { throw new Error('no fetch'); },
  window: {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(src + '\nthis.__out = { normalize: normalizeRecipeInput, validate: validateRecipe };', sandbox);
const payload = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const out = [];
for (const item of payload) {
  const verdict = sandbox.__out.validate(item.sample, []);
  out.push({ name: item.name, errors: verdict.errors });
}
console.log(JSON.stringify(out));
"""


def _run_frontend_validator(samples: list) -> list:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump([{"name": n, "sample": s} for n, s, _ in samples], fh, ensure_ascii=False)
        payload_path = fh.name
    try:
        script = _JS_RUNNER % str(RECIPES_JS)
        result = subprocess.run(
            ["node", "-e", script, payload_path],
            capture_output=True, text=True, cwd=str(ROOT),
        )
        if result.returncode != 0:
            raise AssertionError(f"前端校验器执行失败：{result.stderr[:500]}")
        return json.loads(result.stdout)
    finally:
        Path(payload_path).unlink(missing_ok=True)


def test_frontend_validate_matches_backend():
    samples = _samples()
    try:
        frontend = {item["name"]: item["errors"] for item in _run_frontend_validator(samples)}
    except FileNotFoundError:
        # CI 无 node 时跳过前端侧执行（常量对拍已覆盖 schema 漂移的主要风险）
        import pytest

        pytest.skip("node 不可用，跳过前端执行侧对拍")
    for name, sample, expected in samples:
        got = frontend.get(name)
        assert got is not None, f"前端结果缺样本 {name}"
        assert sorted(got) == sorted(expected), f"样本 {name} 前后端判决不一致：后端 {expected}，前端 {got}"


def test_normalize_strips_unknown_fields_and_derives_aggregation():
    raw = {
        **_valid_sample(),
        "evil_field": "should be dropped",
        "ports": {"static": [{"label": "追问", "drag_form": "draft", "extra": 1}]},
    }
    normalized = normalize_recipe_input(raw)
    assert normalized is not None
    assert "evil_field" not in normalized
    assert normalized["aggregation"] == "ancestors"
    assert normalized["ports"]["static"][0] == {"label": "追问", "drag_form": "draft"}
    knowledge = normalize_recipe_input({**_valid_sample(), "base": {"kind": "knowledge"}})
    assert knowledge["aggregation"] == "self_fields"
    note = normalize_recipe_input({**_valid_sample(), "base": {"kind": "note"}})
    assert note["aggregation"] == "none"
    # 未声明的可选段不设键（与前端 normalize 同形，对拍/快照友好）
    assert "dynamic" not in normalized["ports"]
    assert "on_generated" not in normalized
    assert normalized["analysis_phase"] is False


def test_normalize_custom_color_expands_short_hex_and_drops_junk():
    """自由色归一化：短写补齐成 #rrggbb、大小写压平；非法值整段丢掉而不是带着进库。

    注入串（``red; background: url(x)``）必须被丢——appearance.color 最终会被拼进
    节点的 style 属性，收窄成 hex 形状是这条防线。
    """
    short = normalize_recipe_input({**_valid_sample(), "appearance": {
        "palette": "rose", "color": "#3aF", "shape": "is-round"}})
    assert short["appearance"] == {"palette": "rose", "color": "#33aaff", "shape": "is-round"}
    plain = normalize_recipe_input(_valid_sample())
    assert "color" not in plain["appearance"]
    for junk in ("url(x)", "#12345", "red", "", "   "):
        dropped = normalize_recipe_input({**_valid_sample(), "appearance": {
            "palette": "rose", "color": junk, "shape": "is-round"}})
        assert "color" not in dropped["appearance"], f"非法色 {junk!r} 不该落库"


def test_normalize_dynamic_and_on_generated_defaults():
    """P2 导入口径：脏枚举收敛成默认、引用闭环过滤、缺省值落位。"""
    raw = {**_valid_sample(), "ports": {
        "static": [],
        "dynamic": {
            "parser": {"pattern": "regex", "level_tags": ["基础", "不合法但超长的级别标记名", "", "进阶", "拓展", "多余"],
                       "max": 99, "label_from": "md_heading"},
            "fallback": {"mode": "explode", "labels": ["问题1", "问题2", "问题3"]},
            "each": {"type": "quiz", "branch_type": "", "drag_form": "user"},
        }}}
    normalized = normalize_recipe_input(raw)
    dyn = normalized["ports"]["dynamic"]
    assert dyn["parser"]["pattern"] == "numbered_list"
    assert dyn["parser"]["level_tags"] == ["基础", "不合法但超长的级别标记名"[:6], "进阶", "拓展"]
    assert dyn["parser"]["max"] == RECIPE_MAX_DYNAMIC
    assert dyn["parser"]["label_from"] == "index_question"
    assert dyn["fallback"]["mode"] == "label_questions_from_text"
    assert dyn["each"]["type"] == "socratic"
    assert dyn["each"]["branch_type"] == "socratic"      # 空 branch_type 收敛成 each.type
    assert dyn["each"]["drag_form"] == "user"
    # on_generated：未声明 create 的空壳被剥掉；坏引用的 connect 被过滤
    empty = normalize_recipe_input({**_valid_sample(), "on_generated": {"create": [], "connect": []}})
    assert "on_generated" not in empty
    bad_ref = normalize_recipe_input({**_valid_sample(), "on_generated": {
        "create": [{"as": "$0", "base": {"kind": "answer"}}],
        "connect": [
            {"from": "self", "to": "$9", "relation": "进阶"},
            {"from": "self", "to": "$0", "relation": "模块"},
        ]}})
    assert bad_ref["on_generated"]["connect"] == [{"from": "self", "to": "$0", "relation": "模块"}]
    # 模型槽与重试预算收敛
    viz = normalize_recipe_input({**_valid_sample(), "content_kind": "html_iframe", "generate": {
        **_valid_sample()["generate"], "model_role": "vip", "on_incomplete": {"max_retries": 9}}})
    assert viz["generate"]["model_role"] == "agent"
    assert viz["generate"]["on_incomplete"] == {"max_retries": 2}
    assert viz["content_kind"] == "html_iframe"
    # first_inbound 只对 module 底座生效，其余底座被推导值覆盖
    summary = normalize_recipe_input({**_valid_sample(), "base": {"kind": "summary"},
                                      "aggregation": "first_inbound"})
    assert summary["aggregation"] == "ancestors"


def test_frontend_normalize_shape_matches_backend():
    """P2 关键形状对拍：同一份带全部维度的配方，两侧 normalize 产物逐键一致。"""
    raw = {
        **_valid_sample(),
        "aggregation": "first_inbound",
        "analysis_phase": True,
        "content_kind": "html_iframe",
        "generate": {**_valid_sample()["generate"], "model_role": "html",
                     "retry_prompt": "只输出完整 HTML。", "on_incomplete": {"max_retries": 1}},
        "ports": {"static": [{"label": "追问", "drag_form": "draft"}], "dynamic": _dynamic_ports_spec()},
        "on_generated": {
            "create": [
                {"as": "$0", "base": {"kind": "answer"}, "label_template": "{self.label}的进阶学习",
                 "content_from": "self_directions"},
                {"as": "$1", "base": {"kind": "module", "recipe": "learn"}, "label": "进阶学习"},
            ],
            "connect": [{"from": "self", "to": "$0", "relation": "进阶"}],
            "chain_check": True,
        },
    }
    backend_out = normalize_recipe_input(raw)
    runner = _JS_RUNNER.replace(
        "const verdict = sandbox.__out.validate(item.sample, []);\n"
        "  out.push({ name: item.name, errors: verdict.errors });",
        "const verdict = sandbox.__out.normalize(item.sample);\n"
        "  out.push({ name: item.name, errors: verdict });")
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as fh:
        json.dump([{"name": "shape", "sample": raw}], fh, ensure_ascii=False)
        payload_path = fh.name
    try:
        script = runner % str(RECIPES_JS)
        result = subprocess.run(["node", "-e", script, payload_path],
                                capture_output=True, text=True, cwd=str(ROOT))
        assert result.returncode == 0, f"前端 normalize 执行失败：{result.stderr[:500]}"
        frontend_out = json.loads(result.stdout)[0]["errors"]
    finally:
        Path(payload_path).unlink(missing_ok=True)
    # id/createdAt/updatedAt 是两侧各自生成的非确定字段，剥掉后逐键比对
    for noisy in ("id", "createdAt", "updatedAt"):
        backend_out.pop(noisy, None)
        frontend_out.pop(noisy, None)
    assert frontend_out == backend_out, (
        f"前后端 normalize 产物不一致：\nbackend={json.dumps(backend_out, ensure_ascii=False)}\n"
        f"frontend={json.dumps(frontend_out, ensure_ascii=False)}"
    )


def test_validate_name_dup_ignores_same_id():
    sample = _valid_sample()
    verdict = validate_recipe(sample, [dict(sample)])
    assert verdict["ok"], "同 id 自身不算重名"
    other = dict(sample)
    other["id"] = "recipe-other"
    verdict = validate_recipe(sample, [other])
    assert not verdict["ok"]
    assert any("同名配方" in e for e in verdict["errors"])


def test_prompt_budget_enforced():
    sample = _valid_sample()
    sample["generate"] = {**sample["generate"], "prompt": "长" * (RECIPE_PROMPT_BUDGET + 1)}
    verdict = validate_recipe(sample, [])
    assert not verdict["ok"]
    assert any("超预算" in e for e in verdict["errors"])
