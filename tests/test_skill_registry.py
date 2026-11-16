"""skill 注册表与三段式投递（2026-11-16）。

守护四件事：内置 skill 能被读到、按模块范围过滤、分析步候选卡里带着计划格式、
模块生成时按 id 取得到正文；以及开关关掉后整条链静默失效。
"""

from __future__ import annotations

from server import skill_registry


def test_builtin_skills_load():
    skills = skill_registry.all_skills()
    ids = [item["id"] for item in skills]
    assert "iso-cutaway" in ids
    assert "teardown-narrative" in ids
    for item in skills:
        assert item["scope"], item["id"]
        assert item["body"].strip(), item["id"]
        assert set(item["scope"]) <= set(skill_registry.MODULE_LABELS), item["id"]


def test_by_scope_filters():
    assert [item["id"] for item in skill_registry.by_scope(["viz"])] == ["iso-cutaway"]
    learn = [item["id"] for item in skill_registry.by_scope(["learn", "math"])]
    assert "teardown-narrative" in learn
    assert "iso-cutaway" not in learn
    # 不传＝不过滤
    assert len(skill_registry.by_scope() or []) == len(skill_registry.all_skills())


def test_menu_block_lists_candidates_and_plan_hint():
    block = skill_registry.menu_block(None)
    assert "<skill_plan>" in block
    assert "iso-cutaway" in block
    assert "teardown-narrative" in block
    # 下游只有物理视角：两条 skill 都不落在物理视角上 → 不给候选（省 token）
    assert skill_registry.menu_block([{"module": "physics"}]) == ""
    # 下游含交互可视化：只剩剖视那条
    only_viz = skill_registry.menu_block([{"module": "viz"}])
    assert "iso-cutaway" in only_viz
    assert "teardown-narrative" not in only_viz
    # 脏载荷不炸
    assert skill_registry.menu_block("viz") == skill_registry.menu_block(None)


def test_requested_block_by_plan():
    text, skill_id = skill_registry.requested_block({"skill": {"id": "iso-cutaway", "module": "viz"}})
    assert skill_id == "iso-cutaway"
    assert text.startswith("\n\n")
    assert "画法" in text
    # 也兼容直接给 id 字符串
    text2, skill_id2 = skill_registry.requested_block({"skill": "iso-cutaway"})
    assert skill_id2 == "iso-cutaway"
    assert text2 == text
    # 查不到 id / 没有计划 → 空，绝不返回半截文本
    assert skill_registry.requested_block({"skill": {"id": "no-such-skill"}}) == ("", "")
    assert skill_registry.requested_block({}) == ("", "")
    assert skill_registry.requested_block(None) == ("", "")


def test_switch_off_by_env(monkeypatch):
    monkeypatch.setenv("PHYMATHIA_SKILL_ROUTER", "0")
    assert skill_registry.menu_block(None) == ""
    assert skill_registry.requested_block({"skill": "iso-cutaway"}) == ("", "")
