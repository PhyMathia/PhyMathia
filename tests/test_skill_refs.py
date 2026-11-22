"""skill 参考按需取（第 7 版，2026-11-17）。

守护四件事：目录能从 INDEX.md 读出来、预算真的裁到上限内、越界文件名一律拒绝、
挑文件的解析对模型的脏输出足够宽容。这些全部是纯函数，不跑模型。
"""

from __future__ import annotations

import pytest

from server import config, skill_refs, skill_registry


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path, raising=False)
    skill_registry.reload_skills()
    yield
    skill_registry.reload_skills()


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_builtin_anatomy_exposes_catalog_from_index():
    rows = skill_refs.catalog("anatomy")
    assert len(rows) == 10
    files = [row["file"] for row in rows]
    assert "craft.md" in files and "motion.md" in files
    craft = [row for row in rows if row["file"] == "craft.md"][0]
    # 说明取自 INDEX.md 的中文一句，不是英文标题
    assert "画家顺序" in craft["label"]
    assert skill_refs.available("anatomy") is True


def test_skill_without_references_has_empty_catalog():
    # iso-cutaway 是文件型 md，没有目录，更不会有 references/
    assert skill_refs.catalog("iso-cutaway") == []
    assert skill_refs.available("iso-cutaway") is False
    assert skill_refs.compose("iso-cutaway", ["craft.md"]) == ""


def test_catalog_falls_back_to_first_heading():
    root = skill_registry._user_dir("default")
    base = root / "demo-refs"
    _write(base / "phymathia.md",
           "---\nid: demo-refs\nname: 带参考\n desc: x\nscope: viz\n---\n\n正文\n".replace(" desc", "desc"))
    _write(base / "references" / "alpha.md", "# Alpha Section\n\n内容\n")
    _write(base / "references" / "beta.md", "# Beta Section\n\n内容\n")
    skill_registry.reload_skills()

    rows = {row["file"]: row["label"] for row in skill_refs.catalog("demo-refs")}
    assert rows["alpha.md"] == "Alpha Section"
    assert rows["beta.md"] == "Beta Section"


def test_compose_respects_budget_and_file_cap():
    block = skill_refs.compose("anatomy", ["craft.md", "kit.md", "motion.md"])
    assert block.startswith("\n\n<skill_refs")
    # 最多两份（第三份被丢），且总量不超上限
    assert len(block) <= skill_refs.MAX_CHARS
    assert "craft.md" in block
    assert "kit.md" in block
    assert "motion.md" not in block
    # 冲突时的优先级说明必须带上：英文原文不能盖掉本地契约
    assert "以上面的契约为准" in block


def test_compose_rejects_unsafe_or_unknown_names():
    assert skill_refs.compose("anatomy", ["../phymathia.md"]) == ""
    assert skill_refs.compose("anatomy", ["/etc/passwd"]) == ""
    assert skill_refs.compose("anatomy", ["craft.txt"]) == ""
    assert skill_refs.compose("anatomy", ["not-exist.md"]) == ""


def test_parse_picks_tolerates_model_shapes():
    rows = skill_refs.catalog("anatomy")
    known = [row["file"] for row in rows]
    assert skill_refs.parse_picks('{"read":["craft.md"]}', rows) == ["craft.md"]
    assert skill_refs.parse_picks('["motion.md"]', rows) == ["motion.md"]
    # 带解释、包 code fence 的情况
    assert skill_refs.parse_picks('好的：\n```json\n{"read": ["verify.md"]}\n```', rows) == ["verify.md"]
    # 模型自创的文件名要丢掉
    assert skill_refs.parse_picks('{"read":["nope.md"]}', rows) == []
    assert skill_refs.parse_picks('{"read":[]}', rows) == []
    # 坏 JSON 退回扫文件名
    assert skill_refs.parse_picks("{oops craft.md", rows) == ["craft.md"]
    assert skill_refs.parse_picks("", rows) == []
    assert known  # 目录本身非空


def test_parse_picks_caps_at_two_files():
    rows = skill_refs.catalog("anatomy")
    picked = skill_refs.parse_picks(
        '{"read":["craft.md","motion.md","verify.md","kit.md"]}', rows)
    assert len(picked) == skill_refs.MAX_FILES


def test_pick_prompt_lists_files_and_json_shape():
    rows = skill_refs.catalog("anatomy")
    prompt = skill_refs.pick_prompt("四冲程发动机怎么工作", rows)
    assert "四冲程发动机怎么工作" in prompt
    for row in rows:
        assert row["file"] in prompt
    assert '{"read":' in prompt
    assert str(skill_refs.MAX_FILES) in prompt
    # 没有目录时返回空串（调用方据此跳过这次挑选）
    assert skill_refs.pick_prompt("随便", []) == ""


def test_append_to_last_user_handles_text_and_parts():
    from server.models_routes import _append_to_last_user

    plain = [{"role": "system", "content": "s"}, {"role": "user", "content": "问题"}]
    out = _append_to_last_user(plain, "\n\n<skill_refs>x</skill_refs>")
    assert out[-1]["content"].endswith("<skill_refs>x</skill_refs>")
    # 不改就地对象（回归锚：调用方结构不被顺手改写）
    assert plain[-1]["content"] == "问题"

    parts = [{"role": "user", "content": [{"type": "text", "text": "问题"}]}]
    out2 = _append_to_last_user(parts, "补")
    assert out2[0]["content"][-1] == {"type": "text", "text": "补"}
    assert len(parts[0]["content"]) == 1

    # 没有 user 消息、或 extra 为空 → 原样返回
    assert _append_to_last_user([{"role": "system", "content": "s"}], "x") == [{"role": "system", "content": "s"}]
    assert _append_to_last_user(plain, "") == plain


def test_pick_skill_refs_end_to_end_with_fake_upstream(monkeypatch):
    """挑选 → 读文件 的串联：上游回一份文件名，拿到的应该是真内容。"""
    import asyncio

    from server import http_client, models_routes

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": '{"read":["craft.md"]}'}}]}

    class FakeClient:
        async def post(self, *args, **kwargs):
            return FakeResp()

    monkeypatch.setattr(http_client, "get_http_client", lambda: FakeClient())
    text = asyncio.run(models_routes._pick_skill_refs(
        "anatomy", "四冲程发动机怎么工作", "http://127.0.0.1:1/x", {}, "fake-model", "default"))
    assert "<skill_refs" in text
    assert "craft.md" in text
    # 真的读到了英文原文（而不是只回了文件名）
    assert len(text) > 2000


def test_pick_skill_refs_degrades_on_upstream_error(monkeypatch):
    import asyncio

    from server import http_client, models_routes

    class BadResp:
        status_code = 500

        def json(self):
            return {}

    class BadClient:
        async def post(self, *args, **kwargs):
            return BadResp()

    monkeypatch.setattr(http_client, "get_http_client", lambda: BadClient())
    assert asyncio.run(models_routes._pick_skill_refs(
        "anatomy", "q", "http://127.0.0.1:1/x", {}, "m", "default")) == ""

    # 没有 references 的 skill 连请求都不发（返回空、不报错）
    assert asyncio.run(models_routes._pick_skill_refs(
        "iso-cutaway", "q", "http://127.0.0.1:1/x", {}, "m", "default")) == ""


def test_pick_skill_refs_end_to_end_with_fake_upstream(monkeypatch):
    """挑选 → 读文件 的串联：上游回一份文件名，拿到的应该是真内容。"""
    import asyncio

    from server import http_client, models_routes

    class FakeResp:
        status_code = 200

        def json(self):
            return {"choices": [{"message": {"content": '{"read":["craft.md"]}'}}]}

    class FakeClient:
        async def post(self, *args, **kwargs):
            return FakeResp()

    monkeypatch.setattr(http_client, "get_http_client", lambda: FakeClient())
    text = asyncio.run(models_routes._pick_skill_refs(
        "anatomy", "四冲程发动机怎么工作", "http://127.0.0.1:1/x", {}, "fake-model", "default"))
    assert "<skill_refs" in text
    assert "craft.md" in text
    # 真的读到了英文原文（而不是只回了文件名）
    assert len(text) > 2000


def test_pick_skill_refs_degrades_on_upstream_error(monkeypatch):
    import asyncio

    from server import http_client, models_routes

    class BadResp:
        status_code = 500

        def json(self):
            return {}

    class BadClient:
        async def post(self, *args, **kwargs):
            return BadResp()

    monkeypatch.setattr(http_client, "get_http_client", lambda: BadClient())
    assert asyncio.run(models_routes._pick_skill_refs(
        "anatomy", "q", "http://127.0.0.1:1/x", {}, "m", "default")) == ""

    # 没有 references 的 skill 连请求都不发（返回空、不报错）
    assert asyncio.run(models_routes._pick_skill_refs(
        "iso-cutaway", "q", "http://127.0.0.1:1/x", {}, "m", "default")) == ""


def test_parse_picks_fallback_matches_whole_name():
    rows = [{"file": "craft.md", "label": "x"}, {"file": "t.md", "label": "y"}]
    # 散文回退扫描曾用裸子串：提及 craft.md 会连「文件名的子串」t.md 一起误挑，
    # 错参考挤占 MAX_FILES 配额、挤掉本该入选的真资料
    assert skill_refs.parse_picks("我想参考 craft.md 的画家顺序", rows) == ["craft.md"]
    # 词边界不挡正常提及（路径前缀/独立文件名都认）
    assert skill_refs.parse_picks("读 references/t.md 和 craft.md", rows) == ["craft.md", "t.md"]
