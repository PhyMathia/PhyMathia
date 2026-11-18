"""skill 注册表、用户自建与三段式投递（2026-11-16）。

守护五件事：内置 skill 能读到、按模块范围过滤、候选卡里带着计划格式、按 id 取得到正文、
用户自建能落盘/能删/不能覆盖内置；以及开关关掉后整条链静默失效。

隔离：`config.DATA_DIR` 指到 tmp_path——用户自建目录在 `data/users/<账号>/skills`，
不隔离的话本机真实账号里加过的技能会让「按 scope 过滤」的断言随机飘。
"""

from __future__ import annotations

import json
import logging

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
    # viz 有三条：md 型的 iso-cutaway / three-3d（2026-11-17 加）+ 目录型的 anatomy（src/skills/anatomy/）
    assert [item["id"] for item in skill_registry.by_scope(["viz"])] == ["anatomy", "iso-cutaway", "three-3d"]
    learn = [item["id"] for item in skill_registry.by_scope(["learn", "math"])]
    assert "teardown-narrative" in learn
    assert "iso-cutaway" not in learn
    assert "anatomy" not in learn
    assert "three-3d" not in learn
    # 不传＝不过滤
    assert len(skill_registry.by_scope()) == len(skill_registry.all_skills())


def test_menu_block_lists_candidates_and_plan_hint():
    block = skill_registry.menu_block(None)
    assert "<skill_plan>" in block
    assert "iso-cutaway" in block
    assert "teardown-narrative" in block
    # 分析卡要显示「这次挂了什么、为什么」：候选卡必须把 why 一并要来（选填但示例里有）
    assert '"why"' in block
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
    # 纯内置（没写过副本）不能删；但**可以**用同 id 写一份自己的副本（第 5 版：改内置）
    with pytest.raises(ValueError):
        skill_registry.delete_skill("acct1", "iso-cutaway")
    saved = skill_registry.save_skill("acct1", {
        "id": "iso-cutaway", "name": "我自己改的剖视图", "desc": "只在讲装配图时用",
        "scope": ["viz", "learn"], "body": "用户改写过的正文。",
    })
    assert saved["id"] == "iso-cutaway"
    assert saved["source"] == "user"
    assert saved["overridden"] is True
    assert saved["name"] == "我自己改的剖视图"
    assert skill_registry.requested_block({"skill": "iso-cutaway", "module": "learn"}, "acct1")[1] == "iso-cutaway"
    # 删掉副本＝恢复默认：内置那条回来，且标题回到出厂值
    assert skill_registry.delete_skill("acct1", "iso-cutaway") is True
    restored = skill_registry.get("iso-cutaway", "acct1")
    assert restored["builtin"] is True
    assert restored["name"] == "等距剖视画法"


def test_single_skill_switch_persists_and_filters_route(monkeypatch):
    """第 5 版：单条开关只写 state 文件，不动内容；关掉后候选/投递/预览都看不见它。"""
    assert skill_registry.set_skill_enabled("acct1", "iso-cutaway", False) is False
    state_path = config.DATA_DIR / "users" / "acct1" / "skills_state.json"
    assert state_path.exists()
    assert skill_registry.read_state("acct1")["disabled"] == ["iso-cutaway"]

    assert "iso-cutaway" not in [i["id"] for i in skill_registry.by_scope(["viz"], "acct1")]
    assert skill_registry.requested_block({"skill": "iso-cutaway", "module": "viz"}, "acct1") == ("", "")
    assert "iso-cutaway" not in skill_registry.menu_block([{"module": "viz"}], "acct1")
    assert "iso-cutaway" not in [i["id"] for i in skill_registry.preview("四冲程发动机怎么工作", None, "acct1")["candidates"]]
    # 设置页仍然列它，只是标成关着（否则用户没地方再打开）
    row = [i for i in skill_registry.list_for_ui("acct1")["skills"] if i["id"] == "iso-cutaway"][0]
    assert row["enabled"] is False
    assert "iso-cutaway" not in skill_registry.list_for_ui("acct1")["byModule"]["viz"]

    # 另一个账号不受影响（开关是账号级的）
    assert skill_registry.requested_block({"skill": "iso-cutaway", "module": "viz"}, "acct2")[1] == "iso-cutaway"

    assert skill_registry.set_skill_enabled("acct1", "iso-cutaway", True) is True
    assert skill_registry.requested_block({"skill": "iso-cutaway", "module": "viz"}, "acct1")[1] == "iso-cutaway"
    assert skill_registry.read_state("acct1")["disabled"] == []

    with pytest.raises(ValueError):
        skill_registry.set_skill_enabled("acct1", "no-such-skill", False)


def test_router_switch_by_account_and_env_priority(monkeypatch):
    """账号级总开关（state.router）与 env 硬关是「与」；关闭后编辑技能仍可用。"""
    assert skill_registry.set_router("acct1", False) is False
    assert skill_registry.enabled("acct1") is False
    assert skill_registry.menu_block(None, "acct1") == ""
    assert skill_registry.preview("四冲程发动机怎么工作", None, "acct1")["enabled"] is False
    # 别关掉别人的
    assert skill_registry.enabled("acct2") is True
    # 总开关关着也能改技能（否则用户想改完再开就锁死了）
    skill_registry.save_skill("acct1", {"id": "still-editable", "name": "x", "desc": "y", "scope": ["viz"], "body": "z"})
    skill_registry.set_router("acct1", True)
    assert skill_registry.enabled("acct1") is True
    # env 硬关压过账号开关
    monkeypatch.setenv("PHYMATHIA_SKILL_ROUTER", "0")
    assert skill_registry.enabled("acct1") is False
    assert skill_registry.env_enabled() is False


# ====== 导入（第 5 版）======

def test_parse_import_front_matter_roundtrip():
    text = (
        "---\nid: dim-analysis\ndesc: 量纲检查\nname: 量纲分析\nscope: physics, math\n---\n\n"
        "先列出所有物理量，再写量纲方程。\n"
    )
    parsed = skill_registry.parse_import(text, "dim.md")
    assert parsed["ok"] is True
    assert parsed["id"] == "dim-analysis"
    assert parsed["name"] == "量纲分析"
    assert parsed["scope"] == ["physics", "math"]
    assert parsed["chars"] > 0
    assert parsed["problems"] == []


def test_parse_import_without_front_matter_guesses():
    """裸正文：id 取文件名，名字取首个标题，节点按内容猜，并在 warnings 里说清是猜的。"""
    parsed = skill_registry.parse_import(
        "# 受力分析三步\n\n斜面题先选研究对象，再画受力图，最后列方程。\n", "force-three-step.md"
    )
    assert parsed["ok"] is True
    assert parsed["id"] == "force-three-step"
    assert parsed["name"] == "受力分析三步"
    assert "physics" in parsed["scope"]
    assert parsed["guessedScope"] is True
    assert any("猜成" in line for line in parsed["warnings"])


def test_parse_import_chinese_filename_gets_stable_fallback_id():
    body = "# 解题模板\n\n先看已知，再列方程，最后求导。"
    first = skill_registry.parse_import(body, "受力分析.md")
    second = skill_registry.parse_import(body, "受力分析.md")
    assert first["ok"] is True
    assert first["id"].startswith("import-")
    assert first["id"] == second["id"]  # 同一份内容重复导入 → 同一个 id（覆盖自己，不堆重复）


def test_parse_import_flags_conflict_and_problems():
    out = skill_registry.parse_imports([
        {"name": "iso-cutaway.md", "text": "---\nid: iso-cutaway\nname: 改过的\nscope: viz\n---\n\n正文"},
        {"name": "empty.md", "text": "   "},
        {"name": "no-scope.md", "text": "---\nid: no-scope-new\nname: 无节点\n---\n\n先看已知，再列方程，求导。"},
    ])
    rows = out["entries"]
    assert rows[0]["conflict"] == "builtin"
    assert rows[0]["ok"] is True
    assert rows[1]["ok"] is False and rows[1]["problems"]
    assert rows[2]["ok"] is True and rows[2]["scope"]  # 从正文猜出了 math
    with pytest.raises(ValueError):
        skill_registry.parse_imports([""] * (skill_registry.IMPORT_MAX + 1))


def test_import_skills_partial_success():
    ok = skill_registry.import_skills("acct1", [
        {"id": "imported-a", "name": "A", "desc": "d", "scope": ["viz"], "body": "b"},
        {"id": "imported-b", "name": "", "desc": "d", "scope": ["viz"], "body": "b"},
    ])
    assert [row["id"] for row in ok["imported"]] == ["imported-a"]
    assert ok["failed"] and ok["failed"][0]["id"] == "imported-b"
    assert "imported-a" in [item["id"] for item in skill_registry.all_skills("acct1")]
    with pytest.raises(ValueError):
        skill_registry.import_skills("acct1", [])



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
    # totalChars 是「所有候选都注入」的合计；viz 现在有两条，不能等于单条
    assert out["totalChars"] == sum(item["chars"] for item in out["candidates"])
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
    assert [item["id"] for item in out["candidates"]] == ["anatomy", "iso-cutaway", "three-3d"]


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


# ====== 第 6 版：目录型 skill（2026-11-17）======
# 形态：skills/<id>/ + phymathia.md（适配层）。只有原版 SKILL.md 的目录必须「看得见、
# 用不上」——原版里全是本宿主执行不了的指令，注进去只会让模型编造已执行的步骤。


def _write_skill_file(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _adapter(skill_id, scope="viz", body="目录型正文"):
    return (
        "---\n"
        f"id: {skill_id}\n"
        f"name: 演示{skill_id}\n"
        f"desc: 目录型演示条目\n"
        f"scope: {scope}\n"
        "---\n\n"
        f"{body}\n"
    )


def test_dir_skill_with_adapter_is_injected():
    root = skill_registry._user_dir("default")
    _write_skill_file(root / "demo-dir" / "SKILL.md", "---\nname: Demo\n---\n\n原版流程\n")
    _write_skill_file(root / "demo-dir" / "phymathia.md", _adapter("demo-dir"))
    skill_registry.reload_skills()

    assert "demo-dir" in [item["id"] for item in skill_registry.by_scope(["viz"])]
    text, sid = skill_registry.requested_block({"skill": {"id": "demo-dir", "module": "viz"}})
    assert sid == "demo-dir"
    assert "目录型正文" in text
    row = {i["id"]: i for i in skill_registry.list_for_ui()["skills"]}["demo-dir"]
    assert row["layout"] == "dir" and row["adapted"] is True
    assert row["dir"] == "demo-dir"


def test_original_dir_is_usable_after_scope_is_assigned():
    """装进来的主流包（只有 SKILL.md、没有适用节点）：列表可见但不注入；人指定节点后可用，
    注入时前面带宿主能力声明（原版正文里可能有「跑脚本」这类本宿主做不到的步骤）。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(
        root / "upstream-demo" / "SKILL.md",
        "---\nname: Upstream Demo\ndescription: 原版说明\n---\n\n# Demo\n\nrun build.mjs --audit\n",
    )
    skill_registry.reload_skills()

    row = {i["id"]: i for i in skill_registry.list_for_ui()["skills"]}["upstream-demo"]
    assert row["layout"] == "dir"
    assert row["adapted"] is False
    assert row["needsScope"] is True
    assert row["scope"] == []
    # 没人指定节点 → 候选、投递都不给（正文在，但不知道该挂哪个节点）
    assert "upstream-demo" not in [i["id"] for i in skill_registry.by_scope(["viz"])]
    assert skill_registry.requested_block({"skill": {"id": "upstream-demo", "module": "viz"}}) == ("", "")
    assert "upstream-demo" not in skill_registry.menu_block([{"module": "viz"}])

    # 指定之后可用，注入内容带宿主能力声明
    assert skill_registry.set_skill_scope("default", "upstream-demo", ["viz"]) == ["viz"]
    text, sid = skill_registry.requested_block({"skill": {"id": "upstream-demo", "module": "viz"}})
    assert sid == "upstream-demo"
    assert "build.mjs" in text and "不要声称已经执行过" in text
    # 指定结果写在账号 state 里，人家的 md 一个字节都没改
    assert skill_registry.read_state("default")["scope"]["upstream-demo"] == ["viz"]
    assert "metadata" not in (root / "upstream-demo" / "SKILL.md").read_text(encoding="utf-8")


def test_unadapted_dir_does_not_shadow_adapted_builtin():
    """移入原版 anatomy 不能把已经适配好的内置 anatomy 顶掉（否则越装越差）。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(
        root / "anatomy" / "SKILL.md",
        "---\nname: Anatomy\ndescription: upstream\n---\n\n# 原版\n",
    )
    skill_registry.reload_skills()

    item = skill_registry.get("anatomy")
    assert item["builtin"] is True
    assert item["adapted"] is True
    assert item["body"].strip()  # 仍是内置适配版那份
    row = {i["id"]: i for i in skill_registry.list_for_ui()["skills"]}["anatomy"]
    assert row["shadowed"] and row["shadowed"]["needs_adapt"] is True


def test_oversize_adapter_is_not_injected():
    """适配层超 LIMITS["body"] → 不注入，也不静默截断（截断会让模型以为读全了）。"""
    root = skill_registry._user_dir("default")
    fat = "字" * (skill_registry.LIMITS["body"] + 1)
    _write_skill_file(root / "fat" / "phymathia.md", _adapter("fat", body=fat))
    skill_registry.reload_skills()

    item = skill_registry.get("fat")
    assert item["body"] == ""
    assert item.get("oversize") is True
    assert skill_registry.requested_block({"skill": {"id": "fat", "module": "viz"}}) == ("", "")
    assert "fat" not in [i["id"] for i in skill_registry.by_scope(["viz"])]


def test_dir_scan_is_one_level_and_skips_kit_like_dirs():
    """只下探一层：上游仓库里 kit/、references/ 那一堆 md 不能被当成 skill 读进来。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(root / "outer" / "inner" / "phymathia.md", _adapter("inner"))
    _write_skill_file(root / "kit" / "phymathia.md", _adapter("kit"))
    _write_skill_file(root / ".hidden" / "phymathia.md", _adapter("hidden"))
    skill_registry.reload_skills()

    ids = [item["id"] for item in skill_registry.all_skills()]
    assert "inner" not in ids
    assert "kit" not in ids
    assert "hidden" not in ids


def test_dir_skill_cannot_be_deleted_or_rewritten_via_api():
    """目录型不走接口删/改：里面可能是几十 MB 用户数据，删错不可逆。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(root / "keep-dir" / "phymathia.md", _adapter("keep-dir"))
    skill_registry.reload_skills()

    with pytest.raises(ValueError) as deleted:
        skill_registry.delete_skill("default", "keep-dir")
    assert "文件夹" in str(deleted.value)
    with pytest.raises(ValueError) as saved:
        skill_registry.save_skill("default", {
            "id": "keep-dir", "name": "改名", "desc": "描述", "scope": ["viz"], "body": "正文",
        })
    assert "phymathia.md" in str(saved.value)
    # 两条拒绝之后原条目还在、内容没被改写
    assert skill_registry.get("keep-dir")["body"].strip() == "目录型正文"


def test_builtin_anatomy_is_dir_layout_and_adapted():
    """内置示例：src/skills/anatomy/ 是目录型（上游原版只做来源说明，不参与注入）。"""
    item = skill_registry.get("anatomy")
    assert item["layout"] == "dir"
    assert item["builtin"] is True
    assert item["adapted"] is True
    assert item["scope"] == ["viz"]
    assert len(item["body"]) <= skill_registry.LIMITS["body"]


# ====== 第 8 版：与主流 Agent Skills 格式对齐（2026-11-17）======

def test_mainstream_front_matter_is_parsed():
    """主流写法（name 当标识 + description + metadata.title/scope）不需要本地字段就能用。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(
        root / "pdf-tables" / "SKILL.md",
        "---\n"
        "name: pdf-tables\n"
        "description: 从 PDF 里抽表格。用户提到 PDF 表格或导出表格时使用。\n"
        "metadata:\n"
        "  title: PDF 抽表\n"
        "  scope: math\n"
        "---\n\n正文：先看表头再定列。\n",
    )
    skill_registry.reload_skills()

    item = skill_registry.get("pdf-tables")
    assert item["name"] == "PDF 抽表"          # 显示名取 metadata.title
    assert item["scope"] == ["math"]           # 范围取 metadata.scope
    assert item["needs_scope"] is False
    assert item["scope_source"] == "metadata"
    assert item["desc"].startswith("从 PDF 里抽表格")  # description = 本地 desc
    text, sid = skill_registry.requested_block({"skill": {"id": "pdf-tables", "module": "math"}})
    assert sid == "pdf-tables" and "表头" in text
    assert "宿主能力说明" in text  # 原版正文（无 phymathia.md）→ 带宿主能力声明


def test_scope_assignment_persists_and_can_be_cleared():
    """手动指定节点：写 skills_state.json，传空＝撤销，账号之间互不干扰。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(root / "bare" / "SKILL.md", "---\nname: bare\ndescription: 无节点\n---\n\n正文\n")
    skill_registry.reload_skills()
    assert skill_registry.get("bare")["needs_scope"] is True

    assert skill_registry.set_skill_scope("default", "bare", ["viz", "learn"]) == ["viz", "learn"]
    assert skill_registry.get("bare")["scope"] == ["viz", "learn"]
    assert "bare" in [i["id"] for i in skill_registry.by_scope(["learn"])]

    assert skill_registry.set_skill_scope("default", "bare", []) == []
    assert skill_registry.get("bare")["needs_scope"] is True
    assert "bare" not in skill_registry.read_state("default")["scope"]

    with pytest.raises(ValueError):
        skill_registry.set_skill_scope("other-acct", "bare", ["viz"])
    with pytest.raises(ValueError):
        skill_registry.set_skill_scope("default", "not-exist", ["viz"])


def test_scope_rejects_non_list_payload():
    """脏载荷（数字/字典）要 ValueError→路由 400，不能 TypeError 炸成 500（2026-11-18）。"""
    root = skill_registry._user_dir("default")
    _write_skill_file(root / "bare" / "SKILL.md", "---\nname: bare\ndescription: 无节点\n---\n\n正文\n")
    skill_registry.reload_skills()
    with pytest.raises(ValueError):
        skill_registry.set_skill_scope("default", "bare", 123)
    with pytest.raises(ValueError):
        skill_registry.set_skill_scope("default", "bare", {"viz": 1})
    # None＝撤销指定，照常工作
    assert skill_registry.set_skill_scope("default", "bare", None) == []


def test_desc_limit_is_256_and_import_truncates_long_ones():
    """手写超限即拒（不静默截断）；导入路径截断 + 明示（确认卡上能看见再改）。"""
    assert skill_registry.LIMITS["desc"] == 256
    with pytest.raises(ValueError):
        skill_registry.save_skill("default", {
            "id": "long-desc", "name": "长描述", "desc": "描" * 400, "scope": ["viz"], "body": "正文",
        })

    parsed = skill_registry.parse_import(
        "---\nname: from-upstream\ndescription: " + "描" * 400 + "\n"
        "metadata:\n  scope: viz\n---\n\n正文\n"
    )
    assert parsed["ok"] is True
    assert len(parsed["desc"]) <= 256
    assert any("截断" in w for w in parsed["warnings"])


def test_menu_card_caps_desc_at_200_chars():
    """存储可以到 256，但候选卡只给前 200 字——判断够用，也不吃分析步的上下文。"""
    skill_registry.save_skill("default", {
        "id": "chatty", "name": "话多", "desc": "描" * 256, "scope": ["viz"], "body": "正文",
    })
    block = skill_registry.menu_block([{"module": "viz"}])
    line = [row for row in block.splitlines() if "id=chatty" in row][0]
    assert line.endswith("…")
    assert len(line) < 400


def test_saved_skill_is_written_in_mainstream_shape():
    """save_skill 写出来的 front-matter 直接是主流形状（name/description + metadata）。"""
    skill_registry.save_skill("default", {
        "id": "written-now", "name": "写出来的", "desc": "一句话描述", "scope": ["viz"], "body": "正文内容",
    })
    text = (skill_registry._user_dir("default") / "written-now.md").read_text(encoding="utf-8")
    head = text.split("---")[1]
    assert "name: written-now" in head
    assert "description: 一句话描述" in head
    assert "title: 写出来的" in head
    assert "scope: viz" in head
    assert "id:" not in head  # 主流没有 id 字段，靠 name 当标识
    # 回读一致
    item = skill_registry.get("written-now")
    assert item["name"] == "写出来的" and item["scope"] == ["viz"]


def test_capabilities_reflect_schema_instead_of_a_second_copy(monkeypatch):
    """能力清单一律反射属主常量——改 LIMITS 不改这里，清单必须跟着变。"""
    caps = skill_registry.capabilities("default")
    assert caps["limits"] == skill_registry.LIMITS
    assert caps["scope"] == skill_registry.MODULE_LABELS
    assert caps["id"]["pattern"] == skill_registry._SKILL_ID_RE.pattern
    assert caps["cards"]["desc"] == skill_registry.CARD_DESC_MAX
    assert caps["planBlock"]["tag"] == skill_registry.PLAN_TAG
    monkeypatch.setitem(skill_registry.LIMITS, "desc", 999)
    assert skill_registry.capabilities("default")["limits"]["desc"] == 999


def test_capabilities_lists_existing_skills_and_write_boundary():
    """清单要能让作者面查重、并且一眼看出哪条写不进去（目录型只能去文件管理器）。"""
    skill_registry.save_skill("default", {
        "id": "forge-demo", "name": "工坊样例", "desc": "一句话描述", "scope": ["viz"], "body": "正文",
    })
    caps = skill_registry.capabilities("default")
    row = [item for item in caps["existing"] if item["id"] == "forge-demo"][0]
    assert row["layout"] == "file" and row["enabled"] is True and row["builtin"] is False
    assert caps["counts"]["limit"] == skill_registry.LIMITS["skills"]
    assert caps["counts"]["user"] >= 1
    # 内置 anatomy 是目录型：写入口拒它，能力清单要把这条边界说清
    dir_row = [item for item in caps["existing"] if item["id"] == "anatomy"][0]
    assert dir_row["layout"] == "dir" and dir_row["builtin"] is True
    assert caps["layouts"]["writable"] == ["file"]
    # 摘要不带正文（正文可能两万字，工具要用再按 id 取）
    assert "body" not in row


# ====== 修 497（2026-11-18）：state 编解码 + front-matter 引号往返 ======

def test_state_file_bom_and_gbk_are_decoded_not_reset():
    """BOM / GBK 写法的 state 必须读回原状态，不能吞成全开默认。"""
    payload = {
        "router": False,
        "disabled": ["iso-cutaway"],
        "scope": {"中文技能": ["viz"]},  # 中文键逼出 GBK 与 UTF-8 的字节差异
    }
    path = config.DATA_DIR / "users" / "encoding-acct" / "skills_state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    for encoding in ("utf-8-sig", "gbk"):
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding=encoding)
        skill_registry.reload_skills()
        assert skill_registry.read_state("encoding-acct") == payload
    assert not list(path.parent.glob("*.bak"))  # 能读懂就不该触发隔离


def test_corrupt_state_file_is_backed_up_and_setter_does_not_bury_it(caplog):
    """解不出/解出非 JSON：warning 留痕＋原文改名备份，下次点开关不把原文覆盖掉。"""
    for slot, raw in enumerate((b"\xff\xfe\x00not-json", b'{"router": ')):
        acct = f"corrupt-{slot}"
        path = config.DATA_DIR / "users" / acct / "skills_state.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        skill_registry.reload_skills()

        with caplog.at_level(logging.WARNING, logger="server.skill_registry"):
            assert skill_registry.read_state(acct) == {"router": True, "disabled": [], "scope": {}}
        assert "隔离" in caplog.text and str(path) in caplog.text  # 读失败留痕
        backups = list(path.parent.glob("skills_state.json.corrupt-*.bak"))
        assert len(backups) == 1
        assert backups[0].read_bytes() == raw  # 原文一字未动

        # 下一次点开关：写的是干净新状态，被隔离的原文仍可取回
        assert skill_registry.set_router(acct, False) is False
        assert skill_registry.set_skill_enabled(acct, "iso-cutaway", False) is False
        assert skill_registry.read_state(acct) == {
            "router": False, "disabled": ["iso-cutaway"], "scope": {},
        }
        assert json.loads(path.read_text(encoding="utf-8"))["router"] is False
        assert backups[0].read_bytes() == raw


def test_front_matter_quote_roundtrip():
    """只剥成对同种的一层引号：正常引号正确去掉，值里真引号留得住且 save→reload 不漂移。"""
    text = (
        "---\n"
        'title: "PDF 处理"\n'
        "a: \"'hello'\"\n"
        "b: '\"hi\"'\n"
        "c: \"mix'\n"      # 不成对 → 原样
        "d: 'mix\"\n"      # 不成对 → 原样
        "e: 'hello'\n"     # 真成对 → 剥一层
        "---\n\n正文\n"
    )
    meta, body = skill_registry._front_meta(text)
    assert body == "正文"
    assert meta["title"] == "PDF 处理"
    assert meta["a"] == "'hello'"
    assert meta["b"] == '"hi"'
    assert meta["c"] == '"mix\''   # 不成对 → 连开头的引号一起原样留住
    assert meta["d"] == '\'mix"'   # 不成对 → 连开头的引号一起原样留住
    assert meta["e"] == "hello"

    for index, name in enumerate(("'hello'", '"hi"', '说 "hi"', "PDF 处理")):
        sid = f"quoted-{index}"
        skill_registry.save_skill("default", {
            "id": sid, "name": name, "desc": "引号往返", "scope": ["viz"], "body": "正文",
        })
        assert skill_registry.get(sid)["name"] == name  # reload 后仍逐字一致
