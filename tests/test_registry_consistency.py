"""节点配方注册表对拍测试（P0）。

前端单一数据源 src/static/js/graph-recipes.js（BUILTIN_RECIPES）与后端
harness/registry.py 的投影必须一致——改任何一侧先同步另一侧，再跑本文件。
（T76 的 available_node_types 通道已于 2026-10-06 随死代码退役删除（T111），
其两条守护测试一并移除，见 docs/dev/harness.md 当日节。）
"""

from __future__ import annotations

import re
from pathlib import Path

from harness.core import ALLOWED_CREATE_KINDS, ALLOWED_MODULE_KEYS, ALLOWED_NODE_KINDS
from harness.prompts import HARNESS_SYSTEM_PROMPT
from harness.registry import PROMPT_TYPE_LINES

ROOT = Path(__file__).resolve().parent.parent
RECIPES_JS = ROOT / "src" / "static" / "js" / "graph-recipes.js"


def _parse_frontend_recipes() -> list[dict]:
    """从 graph-recipes.js 提取 BUILTIN_RECIPES 条目（每条目单行对象）。"""
    src = RECIPES_JS.read_text(encoding="utf-8")
    entries = []
    for line in src.splitlines():
        if "key:" not in line or "kind:" not in line:
            continue
        m_key = re.search(r"key:\s*'([^']+)'", line)
        m_kind = re.search(r"kind:\s*'([^']+)'", line)
        if not (m_key and m_kind):
            continue
        m_label = re.search(r"label:\s*'([^']+)'", line)
        m_mod = re.search(r"moduleKey:\s*'([^']+)'", line)
        entries.append(
            {
                "key": m_key.group(1),
                "kind": m_kind.group(1),
                "label": m_label.group(1) if m_label else "",
                "moduleKey": m_mod.group(1) if m_mod else "",
                "hidden": "hidden: true" in line,
            }
        )
    return entries


def test_frontend_registry_shape():
    """18 条官方配方：16 个手动入口 + relation/ai_eval 两个 hidden 类型。"""
    entries = _parse_frontend_recipes()
    assert len(entries) == 18, f"官方配方应为 18 条（16 入口 + relation/ai_eval），实际 {len(entries)}"
    visible = [e for e in entries if not e["hidden"]]
    assert len(visible) == 16, "添加面板入口应保持 16 个"
    keys = [e["key"] for e in entries]
    assert len(keys) == len(set(keys)), "配方 key 不允许重复"
    assert all(e["label"] for e in entries), "每条配方必须有中文 label"


def test_kinds_match_between_frontend_and_backend():
    """前端派生 kind 集合 == 后端 ALLOWED_NODE_KINDS（T75：含 relation）。"""
    entries = _parse_frontend_recipes()
    kinds = {e["kind"] for e in entries}
    assert kinds == ALLOWED_NODE_KINDS, (
        f"前后端 kind 集合漂移：前端多 {sorted(kinds - ALLOWED_NODE_KINDS)}，"
        f"后端多 {sorted(ALLOWED_NODE_KINDS - kinds)}——改一侧先同步另一侧"
    )
    assert "relation" in kinds, "relation 必须在白名单（T75：旧会话 relation 节点保存不再被抹掉）"
    # relation 收录只为存续：hidden（无手动入口）且不可创建
    relation = next(e for e in entries if e["key"] == "relation")
    assert relation["hidden"] is True
    assert "relation" not in ALLOWED_CREATE_KINDS, "创建口径保持移除（提示词明示勿建 kind=relation）"


def test_module_keys_match_between_frontend_and_backend():
    entries = _parse_frontend_recipes()
    modules = {e["moduleKey"] for e in entries if e["moduleKey"]}
    assert modules == ALLOWED_MODULE_KEYS


def test_prompt_type_lines_unchanged():
    """提示词节点类型表：16 行、全部来自注册表、relation 红线未动。"""
    assert len(PROMPT_TYPE_LINES) == 16
    for line in PROMPT_TYPE_LINES:
        assert line in HARNESS_SYSTEM_PROMPT, f"提示词缺少注册表行：{line}"
    # 关系规则红线（relation 口径）不被注册表化误伤
    assert "不要尝试创建 kind=relation 节点" in HARNESS_SYSTEM_PROMPT
    # 占位符必须已被替换（不能把 __NODE_TYPE_LINES__ 漏进提示词）
    assert "__NODE_TYPE_LINES__" not in HARNESS_SYSTEM_PROMPT
