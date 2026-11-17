"""技能工坊（skill 第 9 版 P2，2026-11-17）。

守护四件事：四个工具只在 forge 相位出现、查的是注册表真身（不是手抄）、
校验与写入口共用同一份规则（预览判过的才写得进去）、入册必须带预览指纹且幂等。
"""

from __future__ import annotations

import pytest

from harness import skill_forge
from harness.tools import PHASE_TOOLS, build_tools
from server import config, skill_registry


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path, raising=False)
    skill_registry.reload_skills()
    yield
    skill_registry.reload_skills()


GOOD_BODY = """## 适用
凡是需要判断「物体受哪几个力」的题：斜面、悬挂、叠放、连接体。

## 不适用
只问运动学公式（无需求力的题）；纯电路题。

## 若采用按什么做
1. 先明确研究对象（隔离法），写出它的受力清单；
2. 每个力写清施力物体与方向，正交分解后再列方程；
3. 答案必须带单位与方向说明。
输出里必须出现「受力图（文字描述）→ 分量表 → 方程 → 结果」四段。

## 红线
不要跳过施力物体直接写「受重力、支持力」；不要给出未做单位检查的数值。
"""


def _draft(**over):
    data = {
        "id": "force-frame",
        "name": "受力图先行",
        "desc": "受力分析题：先列受力清单再分解列方程",
        "scope": ["physics"],
        "body": GOOD_BODY,
    }
    data.update(over)
    return data


def test_forge_phase_survives_detection():
    """_detect_phase 必须直通 forge：被归一成 normal 就会给模型编辑工具表。"""
    from harness.review_phase import _detect_phase

    assert _detect_phase("forge", "把受力分析做成技能", {"nodes": [], "edges": []}) == "forge"


def test_forge_tools_only_in_forge_phase():
    names = [tool["function"]["name"] for tool in build_tools("forge")]
    assert names == list(skill_forge.SKILL_TOOL_NAMES)
    assert PHASE_TOOLS["forge"] == list(skill_forge.SKILL_TOOL_NAMES)
    # 其它相位不该混进写盘工具
    normal = [tool["function"]["name"] for tool in build_tools("normal")]
    assert "install_skill" not in normal and "preview_skill" not in normal


def test_skill_spec_reads_registry_not_a_copy():
    spec = skill_forge.execute_skill_tool("skill_spec", {}, "default")
    assert spec["limits"] == skill_registry.LIMITS
    assert spec["scope"] == skill_registry.MODULE_LABELS
    ids = [row["id"] for row in spec["existing"]]
    assert "anatomy" in ids
    # 目录型边界要写进说明书，否则模型会去改一个改不动的东西
    assert spec["layouts"]["writable"] == ["file"]


def test_preview_reports_field_errors_per_field():
    out = skill_forge.execute_skill_tool("preview_skill", {"skill": _draft(scope=[])}, "default")
    assert out["ok"] is False
    assert [item["field"] for item in out["fieldErrors"]] == ["scope"]
    # 逐字段而不是抛一句总错：弱模型一次只改得动一处
    out2 = skill_forge.execute_skill_tool(
        "preview_skill", {"skill": _draft(id="Bad Id", name="", desc="")}, "default"
    )
    assert {item["field"] for item in out2["fieldErrors"]} == {"id", "name", "desc"}


def test_preview_reports_structure_and_routing():
    out = skill_forge.execute_skill_tool("preview_skill", {
        "skill": _draft(),
        "questions": ["斜面上的木块受哪些力？"],
        "avoid": ["这个函数求导怎么算"],
    }, "default")
    assert out["ok"] is True
    assert out["draftToken"]
    assert out["signals"]["missingSections"] == []
    assert out["routing"]["tests"][0]["wouldEnterCandidates"] is True
    assert "物理视角" in out["routing"]["tests"][0]["usableModules"]
    # 反例是数学题，不该被物理技能命中
    assert out["routing"]["avoid"][0]["wouldAlsoMatch"] is False


def test_preview_flags_host_impossible_steps():
    body = GOOD_BODY + "\n跑一下 npm run build 再截图给我看。\n"
    out = skill_forge.execute_skill_tool("preview_skill", {"skill": _draft(body=body)}, "default")
    assert out["ok"] is True
    assert out["signals"]["hostHints"]
    assert any("宿主做不到" in note for note in out["signals"]["warnings"])


def test_install_requires_preview_token_and_is_idempotent():
    wrong = skill_forge.execute_skill_tool("install_skill", {"skill": _draft(), "token": "nope"}, "default")
    assert wrong["ok"] is False and "draftToken" in wrong["error"]
    assert skill_registry.get("force-frame", "default") is None

    preview = skill_forge.execute_skill_tool("preview_skill", {"skill": _draft()}, "default")
    token = preview["draftToken"]
    first = skill_forge.execute_skill_tool("install_skill", {"skill": _draft(), "token": token}, "default")
    assert first["ok"] is True and first["created"] is True and first["menuListed"] is True
    # 同 id 再装一次：幂等覆盖，不产生副本
    second = skill_forge.execute_skill_tool("install_skill", {"skill": _draft(), "token": token}, "default")
    assert second["ok"] is True and second["created"] is False
    files = list(skill_registry._user_dir("default").glob("force-frame*.md"))
    assert len(files) == 1


def test_install_refuses_modified_draft_after_preview():
    preview = skill_forge.execute_skill_tool("preview_skill", {"skill": _draft()}, "default")
    token = preview["draftToken"]
    tampered = _draft(body=GOOD_BODY + "\n额外加一句。")
    out = skill_forge.execute_skill_tool("install_skill", {"skill": tampered, "token": token}, "default")
    assert out["ok"] is False
    assert skill_registry.get("force-frame", "default") is None


def test_install_refuses_dir_layout_skill():
    out = skill_forge.execute_skill_tool("preview_skill", {
        "skill": _draft(id="anatomy", name="等距剖视", desc="剖视画法"),
    }, "default")
    assert out["ok"] is False
    assert out["fieldErrors"][0]["field"] == "id"
    assert "目录型" in out["fieldErrors"][0]["reason"]


# ====== 端到端：forge 相位在评审主链里真的能用（桩模型）======

import asyncio
import json
from unittest import mock

from harness import review as review_mod

MODEL = {"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""}
SNAPSHOT = {"version": 1, "nodes": [{"id": "A", "kind": "human_note", "label": "受力分析"}], "edges": []}


def _call(name, args, call_id):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


def _fake(results, seen):
    async def inner(messages, model, max_tokens, tools=None, tool_choice=None,
                    json_mode=False, on_delta=None):
        seen.append({"messages": json.loads(json.dumps(messages, ensure_ascii=False)), "tools": tools})
        return results[min(len(seen) - 1, len(results) - 1)]
    return inner


def test_forge_loop_queries_previews_and_installs(monkeypatch):
    """查 → 预览 → 入册，三步都在主链里跑通；产物落盘、结果零图操作。"""
    draft = _draft()
    # 指纹按**归一化后**的草稿算（与预览同一口径）：正文尾部空白会被 validate 剥掉，
    # 拿原始文本去算必然对不上——这正是「预览与入册同一份规则」的体现。
    token = skill_forge.draft_token(skill_registry.validate_skill("default", draft))
    results = [
        {"content": "", "tool_calls": [_call("skill_spec", {}, "c1")]},
        {"content": "", "tool_calls": [_call("preview_skill", {"skill": draft, "questions": ["斜面上物块受力？"]}, "c2")]},
        {"content": "", "tool_calls": [_call("install_skill", {"skill": draft, "token": token}, "c3")]},
        {"content": "已入册「受力图先行」，物理视角的受力题会用它。", "tool_calls": None},
    ]
    seen = []
    monkeypatch.setattr(review_mod, "_call_model", _fake(results, seen))
    result = asyncio.run(review_mod.review_graph(
        dict(SNAPSHOT), "把「先画受力图再列方程」做成技能，物理视角用",
        model=dict(MODEL), phase="forge", retries=0, self_check="off",
    ))
    # 产物：真的写进技能库；不是图操作
    assert result["operations"] == []
    assert skill_registry.get("force-frame", "default")["name"] == "受力图先行"
    # 工具表：模型第一轮拿到的就必须是 forge 的四件（被归一成 normal 的话这里会红）
    assert [tool["function"]["name"] for tool in seen[0]["tools"]] == list(skill_forge.SKILL_TOOL_NAMES)
    # 回灌：模型第二轮看到了能力清单，第三轮看到了草稿指纹，第四轮看到入册结果
    def tool_payloads(step):
        return [m["content"] for m in seen[step]["messages"] if m.get("role") == "tool"]
    assert any("formats" in text or "frontMatter" in text for text in tool_payloads(1))
    assert any(token in text for text in tool_payloads(2))
    assert any('"installed"' in text or '"ok": true' in text for text in tool_payloads(3))
    assert "受力图先行" in str(result.get("summary") or "")
