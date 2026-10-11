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
    """19 条官方配方：16 个手动入口 + relation/ai_eval/hub 三个 hidden 类型（2026-10-11 junction 复活结构组）。"""
    entries = _parse_frontend_recipes()
    assert len(entries) == 19, f"官方配方应为 19 条（16 入口 + relation/ai_eval/hub），实际 {len(entries)}"
    visible = [e for e in entries if not e["hidden"]]
    assert len(visible) == 16, "添加面板入口应保持 16 个（2026-10-11 junction 复活结构组后）"
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
    # hub 同款（2026-10-10 退役，backlog 267）：hidden 且不可创建，kind 保留存续
    hub = next(e for e in entries if e["key"] == "hub")
    assert hub["hidden"] is True
    assert "hub" not in ALLOWED_CREATE_KINDS, "创建口径保持移除（hub 2026-10-10 退役）"


    # hub 同款（2026-10-10 退役，backlog 267）：hidden 且不可创建，kind 保留存续
    hub = next(e for e in entries if e["key"] == "hub")
    assert hub["hidden"] is True
    assert "hub" not in ALLOWED_CREATE_KINDS, "创建口径保持移除（hub 2026-10-10 退役）"
    # junction（2026-10-11 用户拍板）：走线锚点，面板可见（entry 不 hidden）但 Φ 不建
    # ——用户手动工具的定位，kind 进白名单只为存量存续与 viewer 渲染
    junction = next(e for e in entries if e["key"] == "junction")
    assert junction["hidden"] is False, "junction 应进添加面板（用户手动走线工具）"
    assert "junction" in kinds, "junction 必须进 kind 白名单（存量图/查看器存续）"
    assert "junction" not in ALLOWED_CREATE_KINDS, "Φ 不建 junction（提示词红线）"


def test_module_keys_match_between_frontend_and_backend():
    entries = _parse_frontend_recipes()
    modules = {e["moduleKey"] for e in entries if e["moduleKey"]}
    assert modules == ALLOWED_MODULE_KEYS


def test_prompt_type_lines_unchanged():
    """提示词节点类型表：15 行（2026-10-10 hub 行随退役移除）、全部来自注册表、relation 红线未动。"""
    assert len(PROMPT_TYPE_LINES) == 15
    for line in PROMPT_TYPE_LINES:
        assert line in HARNESS_SYSTEM_PROMPT, f"提示词缺少注册表行：{line}"
    # 关系规则红线（relation 口径）不被注册表化误伤
    assert "不要尝试创建 kind=relation 节点" in HARNESS_SYSTEM_PROMPT
    # 占位符必须已被替换（不能把 __NODE_TYPE_LINES__ 漏进提示词）
    assert "__NODE_TYPE_LINES__" not in HARNESS_SYSTEM_PROMPT
