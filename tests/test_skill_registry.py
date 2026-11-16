"""skill 注册表、用户自建与三段式投递（2026-11-16）。

守护五件事：内置 skill 能读到、按模块范围过滤、候选卡里带着计划格式、按 id 取得到正文、
用户自建能落盘/能删/不能覆盖内置；以及开关关掉后整条链静默失效。

隔离：`config.DATA_DIR` 指到 tmp_path——用户自建目录在 `data/users/<账号>/skills`，
不隔离的话本机真实账号里加过的技能会让「按 scope 过滤」的断言随机飘。
"""

from __future__ import annotations

import pytest

from server import config, skill_registry


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path, raising=False)
    skill_registry.reload_skills()
    yield
    skill_registry.reload_skills()


def test_builtin_skills_load():
    skills = skill_registry.all_skills()
    ids = [item["id"] for item in skills]
    assert "iso-cutaway" in ids
    assert "teardown-narrative" in ids
    assert all(item["builtin"] for item in skills)
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
    assert len(skill_registry.by_scope()) == len(skill_registry.all_skills())


def test_menu_block_lists_candidates_and_plan_hint():
    block = skill_registry.menu_block(None)
    assert "<skill_plan>" in block
    assert "iso-cutaway" in block
    assert "teardown-narrative" in block
    # 下游只有物理视角：两条内置都不落在物理视角上 → 不给候选（省 token）
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


def test_user_skill_roundtrip_and_isolation():
    saved = skill_registry.save_skill("acct1", {
        "id": "force-analysis",
        "name": "受力分析七步",
        "desc": "多物体、要判方向的力学题",
        "scope": ["physics"],
        "body": "先选研究对象，再画受力图。",
    })
    assert saved["id"] == "force-analysis"
    assert saved["builtin"] is False

    # 落了盘，且只在写它的账号里可见
    path = config.DATA_DIR / "users" / "acct1" / "skills" / "force-analysis.md"
    assert path.exists()
    assert "force-analysis" in [i["id"] for i in skill_registry.all_skills("acct1")]
    assert "force-analysis" not in [i["id"] for i in skill_registry.all_skills("acct2")]

    # 进了候选卡与投递
    assert "force-analysis" in skill_registry.menu_block([{"module": "physics"}], "acct1")
    text, sid = skill_registry.requested_block({"skill": "force-analysis"}, "acct1")
    assert sid == "force-analysis" and "研究对象" in text

    # 删除
    assert skill_registry.delete_skill("acct1", "force-analysis") is True
    assert skill_registry.delete_skill("acct1", "force-analysis") is False
    assert "force-analysis" not in [i["id"] for i in skill_registry.all_skills("acct1")]


def test_user_skill_rejects_bad_input_and_builtin():
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {"id": "Bad Id", "name": "x", "desc": "y", "scope": ["viz"], "body": "z"})
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {"id": "no-scope", "name": "x", "desc": "y", "scope": [], "body": "z"})
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {"id": "no-desc", "name": "x", "desc": "", "scope": ["viz"], "body": "z"})
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {
            "id": "too-long", "name": "x", "desc": "y", "scope": ["viz"], "body": "字" * (skill_registry.LIMITS["body"] + 1),
        })
    # 内置的不能覆盖、不能删
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {"id": "iso-cutaway", "name": "x", "desc": "y", "scope": ["viz"], "body": "z"})
    with pytest.raises(ValueError):
        skill_registry.delete_skill("acct1", "iso-cutaway")


def test_name_and_desc_over_limit_are_rejected_not_truncated():
    """backlog 476①：超限必须拒绝（手册承诺），不能悄悄剪短后存进去。"""
    ok_name = "名" * skill_registry.LIMITS["name"]
    ok_desc = "描" * skill_registry.LIMITS["desc"]
    saved = skill_registry.save_skill("acct1", {
        "id": "limit-ok", "name": ok_name, "desc": ok_desc, "scope": ["viz"], "body": "正文",
    })
    assert saved["name"] == ok_name
    assert saved["desc"] == ok_desc
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {
            "id": "name-too-long", "name": "名" * (skill_registry.LIMITS["name"] + 1),
            "desc": "y", "scope": ["viz"], "body": "z",
        })
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {
            "id": "desc-too-long", "name": "x",
            "desc": "描" * (skill_registry.LIMITS["desc"] + 1), "scope": ["viz"], "body": "z",
        })


def test_scope_with_mixed_types_is_clean_error():
    """backlog 476③：scope 里混数字要回 ValueError（400 中文原因），不能 TypeError→500。"""
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {"id": "mixed", "name": "x", "desc": "y", "scope": [1, 2], "body": "z"})
    saved = skill_registry.save_skill("acct1", {
        "id": "mixed-ok", "name": "x", "desc": "y", "scope": [1, "viz"], "body": "z",
    })
    assert saved["scope"] == ["viz"]


def test_requested_block_enforces_scope():
    """backlog 476②：适用范围是硬护栏——「画法」挂到数学节点上必须不注入。"""
    assert skill_registry.requested_block({"skill": {"id": "iso-cutaway", "module": "math"}}) == ("", "")
    assert skill_registry.requested_block({"skill": {"id": "iso-cutaway", "module": "viz"}})[1] == "iso-cutaway"
    # 计划只给 id 时看 target.module
    assert skill_registry.requested_block({"skill": "iso-cutaway", "target": {"module": "math"}}) == ("", "")
    # 两处都没有模块信息：旧快照兼容，放行
    assert skill_registry.requested_block({"skill": "iso-cutaway"})[1] == "iso-cutaway"


def test_switch_off_by_env(monkeypatch):
    monkeypatch.setenv("PHYMATHIA_SKILL_ROUTER", "0")
    assert skill_registry.menu_block(None) == ""
    assert skill_registry.requested_block({"skill": "iso-cutaway"}) == ("", "")
    with pytest.raises(ValueError):
        skill_registry.save_skill("acct1", {"id": "x1", "name": "x", "desc": "y", "scope": ["viz"], "body": "z"})


# ====== 试一条（preview，2026-11-16 第 3 版）======

def test_preview_engine_question_hits_viz_candidate():
    """正样本：发动机题 → 认出交互可视化 → 剖视那条是候选，注入字数为正文+2 换行。"""
    out = skill_registry.preview("四冲程发动机怎么工作")
    assert out["enabled"] is True
    assert out["moduleSource"] == "keywords"
    assert "viz" in out["modules"]
    assert "发动机" in out["matched"]["viz"]
    by_id = {item["id"]: item for item in out["candidates"]}
    assert "iso-cutaway" in by_id
    row = by_id["iso-cutaway"]
    assert row["chars"] == len(skill_registry.payload("iso-cutaway")) + 2  # requested_block 的 "\n\n"
    assert row["chars"] == out["totalChars"]
    assert row["usable"] == ["viz"]
    assert row["text"].startswith("\n\n")
    # 预览与真正投递是同一份文本，不能出现「预览说的和发出去的不一样」
    assert row["text"] == skill_registry.requested_block({"skill": {"id": "iso-cutaway", "module": "viz"}})[0]


def test_preview_math_question_has_no_viz_candidate():
    """负样本：纯数学题 → 不认交互可视化 → 剖视那条连候选都不是（模型根本看不到它）。"""
    out = skill_registry.preview("求导公式怎么推导出来的")
    assert "viz" not in out["modules"]
    assert "iso-cutaway" not in [item["id"] for item in out["candidates"]]
    assert out["totalChars"] == 0


def test_preview_explicit_modules_override_and_unknown_module():
    out = skill_registry.preview("随便一句话", ["viz", "不存在"])
    assert out["moduleSource"] == "explicit"
    assert out["modules"] == ["viz"]
    assert [item["id"] for item in out["candidates"]] == ["iso-cutaway"]


def test_preview_all_modules_when_no_keyword_hit():
    """一个问题都没命中时列全部节点——报「空候选」会让人误以为技能永远用不上。"""
    out = skill_registry.preview("这是什么")
    assert out["moduleSource"] == "all"
    assert set(out["modules"]) == set(skill_registry.MODULE_LABELS)
    assert len(out["candidates"]) == len(skill_registry.all_skills())


def test_preview_empty_question_is_all_modules_and_switch_off(monkeypatch):
    assert skill_registry.preview("")["moduleSource"] == "all"
    monkeypatch.setenv("PHYMATHIA_SKILL_ROUTER", "0")
    off = skill_registry.preview("四冲程发动机怎么工作")
    assert off["enabled"] is False
    assert off["candidates"] == []
    assert off["totalChars"] == 0
    assert off["notes"]
