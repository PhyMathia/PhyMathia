"""会话历史可读归档（2026-11-19）：消息落盘时同步写 data/history/<账号>/*.md。

背景：浏览器 phymathia_msgs_ 只是 LRU 读取缓存（只留 5 个会话），服务端消息
文件才是权威副本；本机实测 53 个会话 48 个连消息文件都没有。本次改动＝
① 服务端每次真切写就刷一份人可读 Markdown 到项目文件夹；
② POST messages 响应加 stored（服务端是否握有这份内容），前端据此决定记不记
   「已推送」签名——200 不再冒充已存；
③ 删除会话/清空消息/回收站恢复三处与归档同步。
"""

import json
import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server import accounts  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import storage  # noqa: E402


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}
    yield tmp_path
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}


def _seed_session(sid, title="画布"):
    sessions_path = accounts.resolve_paths("default").sessions_path
    sessions_path.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(sessions_path.read_text(encoding="utf-8")) if sessions_path.exists() else {}
    data[sid] = {"id": sid, "title": title, "sessionId": sid, "createdAt": 1, "updatedAt": 1}
    sessions_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    storage._invalidate_json_cache(sessions_path)


def _client():
    from fastapi.testclient import TestClient
    import main as main_mod
    return TestClient(main_mod.app, base_url="http://127.0.0.1")


def _archives(sid):
    return sorted(storage.history_dir("default").glob(f"*-{sid[-8:]}.md"))


def test_save_messages_writes_readable_archive(acc_env):
    _seed_session("sess_hist_a", title="三相交流电路")
    with _client() as client:
        r = client.post("/api/sessions/sess_hist_a/messages", json={"messages": [
            {"role": "user", "content": "三相是什么？", "timestamp": 1700000000000},
            {"role": "assistant", "content": "三相是相位差 120° 的三组正弦量。", "timestamp": 1700000001000},
        ]})
        assert r.json()["written"] is True
        assert r.headers["X-Phy-Stored"] == "1"

    files = _archives("sess_hist_a")
    assert len(files) == 1
    assert files[0].name.startswith("三相交流电路-")
    text = files[0].read_text(encoding="utf-8")
    assert "# 三相交流电路" in text
    assert "三相是什么？" in text
    assert "相位差 120°" in text
    assert "## 1. 我" in text and "## 2. AI" in text


def test_archive_survives_noop_push_and_tracks_title_rename(acc_env):
    _seed_session("sess_hist_b", title="旧标题")
    msgs = [{"role": "user", "content": "在吗", "timestamp": 1}]
    with _client() as client:
        assert client.post("/api/sessions/sess_hist_b/messages", json={"messages": msgs}).json()["written"] is True
        # 逐字重推＝合并无增量：不写盘，但 stored 为真（服务端确实有这份内容）
        again = client.post("/api/sessions/sess_hist_b/messages", json={"messages": msgs})
        assert again.json()["written"] is False
        assert again.headers["X-Phy-Stored"] == "1"
        assert len(_archives("sess_hist_b")) == 1

        # 改标题后再写一条：旧文件名要被换掉，不留两份
        _seed_session("sess_hist_b", title="新标题")
        client.post("/api/sessions/sess_hist_b/messages", json={"messages": msgs + [
            {"role": "assistant", "content": "在的", "timestamp": 2},
        ]})
    files = _archives("sess_hist_b")
    assert len(files) == 1
    assert files[0].name.startswith("新标题")


def test_empty_push_reports_not_stored_and_writes_no_archive(acc_env):
    _seed_session("sess_hist_c")
    with _client() as client:
        resp = client.post("/api/sessions/sess_hist_c/messages", json={"messages": []})
    assert resp.json()["written"] is False
    assert resp.headers["X-Phy-Stored"] == "0"
    assert _archives("sess_hist_c") == []


def test_delete_session_removes_archive(acc_env):
    _seed_session("sess_hist_d", title="要删的")
    with _client() as client:
        client.post("/api/sessions/sess_hist_d/messages", json={"messages": [
            {"role": "user", "content": "删我", "timestamp": 1},
        ]})
        assert len(_archives("sess_hist_d")) == 1
        assert client.delete("/api/sessions/sess_hist_d").status_code == 200
    assert _archives("sess_hist_d") == []


def test_clear_messages_removes_archive(acc_env):
    _seed_session("sess_hist_e", title="要清的")
    with _client() as client:
        client.post("/api/sessions/sess_hist_e/messages", json={"messages": [
            {"role": "user", "content": "清我", "timestamp": 1},
        ]})
        assert len(_archives("sess_hist_e")) == 1
        assert client.delete("/api/sessions/sess_hist_e/messages").status_code == 200
    assert _archives("sess_hist_e") == []


def test_archive_includes_graph_nodes_when_messages_missing(acc_env):
    """聊天流缺失的会话（本机 48/53）内容仍在画布节点里：归档必须把节点写进来，
    交互可视化的 HTML 代码不写（几十 KB 代码不是历史），只留一句说明。"""
    _seed_session("sess_hist_g", title="三相")
    kv_path = accounts.resolve_paths("default").kv_dir / "sess_hist_g.json"
    kv_path.parent.mkdir(parents=True, exist_ok=True)
    kv_path.write_text(json.dumps({
        "graph:sess_hist_g": {"customNodes": [
            {"kind": "user", "content": "三相交流电路", "timestamp": 1000},
            {"kind": "module", "label": "物理视角", "content": "空间对称 → 时间错相", "timestamp": 2000},
            {"kind": "module", "label": "交互可视化",
             "content": "```html\n<!DOCTYPE html><html><body>viz</body></html>", "timestamp": 3000},
        ]},
    }, ensure_ascii=False), encoding="utf-8")

    target = storage.write_message_archive("sess_hist_g", [], "default")
    assert target is not None
    text = target.read_text(encoding="utf-8")
    assert "三相交流电路" in text
    assert "物理视角" in text and "空间对称 → 时间错相" in text
    assert "交互可视化" in text and "字代码，正文见画布" in text
    assert "<!DOCTYPE html>" not in text


def test_empty_session_writes_no_archive(acc_env):
    _seed_session("sess_hist_h", title="空画布")
    assert storage.write_message_archive("sess_hist_h", [], "default") is None
    assert _archives("sess_hist_h") == []


def test_backfill_helper_rebuilds_archive(acc_env):
    """归档是派生副本：删掉后能由消息文件原样重建（回填脚本就是干这个）。"""
    _seed_session("sess_hist_f", title="可重建")
    path = storage._get_messages_path("sess_hist_f", account="default")
    storage._write_json(path, [{"role": "user", "content": "重建我", "timestamp": 1}])
    assert _archives("sess_hist_f") == []

    storage.write_message_archive("sess_hist_f", storage._read_json(path, []), "default")
    files = _archives("sess_hist_f")
    assert len(files) == 1
    assert "重建我" in files[0].read_text(encoding="utf-8")


def test_archive_kinds_formula_and_materials():
    """575（2026-11-24）：类型中文名补全、<formula> 转成 $$／$（前端导出同夹具，见
    frontend_smoke/notes-export.mjs）、问题分析与清单取材、与节点正文完全相同的消息不重复列。"""
    text = ("力 <formula>F=-kx</formula> 作用\n\n"
            "<formula>\nT=2\\pi\\sqrt{\\frac{m}{k}}\n</formula>\n\n"
            "收尾 <formula> a &lt; b </formula>")
    nodes = [
        {"kind": "user", "content": "简谐运动是什么", "timestamp": 1000},
        {"kind": "hub", "content": "", "timestamp": 2000},  # 空节点：不列
        {"kind": "summary", "content": text, "timestamp": 3000},
        {"kind": "note", "content": "# 齿轮基本参数", "timestamp": 4000},
        {"kind": "answer", "content": "", "analysis": "题意歧义：……", "timestamp": 5000},
        {"kind": "module", "content": "", "timestamp": 6000,
         "items": [{"levelName": "基础", "question": "为什么周期与振幅无关？"},
                   {"kind": "image", "fileName": "a.png"}]},
    ]
    messages = [
        {"role": "user", "content": "简谐运动\n是什么", "timestamp": 1000},  # 与节点同文：不重复列
        {"role": "assistant", "content": "好问题", "timestamp": 1500},
        {"role": "system", "content": "系统提示不进归档", "timestamp": 1600},
    ]
    md = storage.message_archive_markdown("sess_x", messages, "简谐运动", nodes)
    heads = [line.split(" · ")[0] for line in md.splitlines() if line.startswith("## ")]
    assert heads == ["## 1. 我", "## 2. AI", "## 3. AI 总结", "## 4. 我的总结", "## 5. 问题分析", "## 6. 模块"]
    assert "力 $F=-kx$ 作用" in md                      # 夹在句中 → inline
    assert "$$\nT=2\\pi\\sqrt{\\frac{m}{k}}\n$$" in md  # 独占一行 → display
    assert "收尾 $a < b$" in md                         # 实体解码、首尾空白剥掉
    assert "<formula>" not in md
    assert "题意歧义：……" in md                        # 「问题分析」卡正文取自 analysis
    assert "- [基础] 为什么周期与振幅无关？" in md and "- 图片「a.png」" in md
    assert "系统提示不进归档" not in md
    assert md.count("简谐运动是什么") == 1


def test_history_text_normalization():
    """口径对齐前端 renderMarkdown：思考块／summary／分节标签不显示，<viz> 段与完整网页代码块
    换成说明（短片段保留为代码块），双层定界收成单层，未闭合 <formula> 从标签起截掉。"""
    page = "<!DOCTYPE html><html><body>" + "x" * 120 + "</body></html>"
    viz_inner = "\n```html\n" + page + "\n```\n"
    raw = ("<think>内部推理</think>正文<physics>甲</physics><summary>摘要标签</summary>"
           f"<viz>{viz_inner}</viz>后文\n\n```html\n<b>片段</b>\n```\n"
           "$$<formula>E=mc^2</formula>$$\n\n结尾 <formula>\\frac{a}{b}")
    out = storage._history_text(raw)
    assert "内部推理" not in out and "摘要标签" not in out
    assert "正文甲" in out
    assert f"（交互可视化，{len(viz_inner):,} 字代码，正文见画布）" in out
    assert "```html\n<b>片段</b>\n```" in out
    assert "$$\nE=mc^2\n$$" in out
    assert "\\frac{a}{b}" not in out and out.endswith("结尾")


def test_archive_truncates_long_entry():
    md = storage.message_archive_markdown("sess_y", [], "长文", [{"kind": "module", "content": "字" * 9000, "timestamp": 1}])
    body = md.split("\n\n…（已截断")[0]
    assert body.endswith("…") is False and body.count("字") == storage._HISTORY_ENTRY_MAX
    assert "…（已截断，共 9,000 字，完整内容见画布）" in md
