"""节点配方 schema 对拍测试（P1）。

前端 src/static/js/graph-recipes.js 的 normalizeRecipeInput / validateRecipe 与
后端 harness/recipes.py 必须同构：常量逐值一致、同一批样本两侧判决一致。
改任何一侧先同步另一侧（设计文档第 6 节 P1 的「前后端同构校验器」条目）。
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
    RECIPE_MAX_PORTS,
    RECIPE_PALETTE_KEYS,
    RECIPE_PROMPT_BUDGET,
    RECIPE_SHAPES,
    normalize_recipe_input,
    validate_recipe,
)

ROOT = Path(__file__).resolve().parent.parent
RECIPES_JS = ROOT / "src" / "static" / "js" / "graph-recipes.js"


def _js_constants() -> dict:
    """从 graph-recipes.js 抽常量字面量（P1 段），与后端逐值对拍。"""
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
    m = re.search(r"RECIPE_PALETTE\s*=\s*\[(.*?)\];", src, re.S)
    assert m, "前端缺 RECIPE_PALETTE"
    out["palette_keys"] = re.findall(r"key:\s*'([^']+)'", m.group(1))
    m = re.search(r"RECIPE_PROMPT_BUDGET\s*=\s*(\d+)", src)
    assert m, "前端缺 RECIPE_PROMPT_BUDGET"
    out["prompt_budget"] = int(m.group(1))
    m = re.search(r"RECIPE_MAX_PORTS\s*=\s*(\d+)", src)
    assert m, "前端缺 RECIPE_MAX_PORTS"
    out["max_ports"] = int(m.group(1))
    return out


def test_constants_match_between_frontend_and_backend():
    js = _js_constants()
    assert tuple(js["base_kinds"]) == RECIPE_BASE_KINDS
    assert tuple(js["ai_base_kinds"]) == RECIPE_AI_BASE_KINDS
    assert tuple(js["shapes"]) == RECIPE_SHAPES
    assert tuple(js["content_kinds"]) == RECIPE_CONTENT_KINDS
    assert tuple(js["channels"]) == RECIPE_CONTEXT_CHANNELS
    assert tuple(js["palette_keys"]) == RECIPE_PALETTE_KEYS
    assert js["prompt_budget"] == RECIPE_PROMPT_BUDGET
    assert js["max_ports"] == RECIPE_MAX_PORTS


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


def _samples() -> list:
    return [
        ("valid", _valid_sample(), []),
        ("no_name", {**_valid_sample(), "name": "  "}, ["名称不能为空"]),
        ("bad_base", {**_valid_sample(), "base": {"kind": "hub"}}, ["底座类型不在 P1 支持范围"]),
        ("bad_palette", {**_valid_sample(), "appearance": {"palette": "hotpink", "shape": "is-round"}},
         ["色板不合法（只能从成对色板令牌选）"]),
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
        ("bad_content_kind", {**_valid_sample(), "content_kind": "html_iframe"},
         ["内容载体不合法（P1 只支持 markdown / plain）"]),
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
