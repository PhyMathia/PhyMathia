"""回收站（2026-10-07）：删除先入站、保留期内可恢复、过期自动清除。

钉死的拍板：快照失败必须中止删除（宁可 500 不可丢数据）；meta.json 最后落盘
＝条目完整性标志；purgeAt 入站时刻算死（改保留天数不追溯）；保留 0 天＝关闭
回收站；共享归属的知识/公式条目不入站（它们不会被删除抹掉）。
"""

import json
import os
import sys
import time
from pathlib import Path

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server import accounts, storage, trash  # noqa: E402
from server import config as config_mod  # noqa: E402


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    """DATA_DIR 指向临时目录 + 清 ensure 缓存（与 test_accounts 同款）。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    yield tmp_path
    accounts._ENSURED.clear()


def _paths(account="default"):
    return accounts.resolve_paths(account)


def _seed_session(account="default", sid="sess_aaa", title="物理画布"):
    """种一个「全件套」会话：名单/消息/独占与共享知识/公式/kv 快照/苏格拉底/quiz。"""
    paths = _paths(account)
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.messages_dir.mkdir(parents=True, exist_ok=True)
    paths.kv_dir.mkdir(parents=True, exist_ok=True)
    now = 1_700_000_000_000
    storage._write_json(paths.sessions_path, {
        sid: {"id": sid, "title": title, "sessionId": "phymathia_aaa",
              "createdAt": now, "updatedAt": now},
        "sess_bbb": {"id": "sess_bbb", "title": "别人的画布", "sessionId": "phymathia_bbb",
                     "createdAt": now, "updatedAt": now},
    })
    storage._write_json(paths.messages_dir / f"{sid}.json",
                        [{"role": "user", "content": "什么是牛顿第二定律", "timestamp": now}])
    # k1 独占（入站）、k2 与 sess_bbb 共享（摘归属存活，不入站）、k3 别人的（不相干）
    storage._write_json(paths.knowledge_path, {
        "k1": {"title": "牛顿第二定律", "sessionId": sid},
        "k2": {"title": "共享条目", "sessionId": "phymathia_aaa",
               "sessionIds": ["phymathia_aaa", "sess_bbb"]},
        "k3": {"title": "别人的", "sessionId": "sess_bbb"},
    })
    storage._write_json(paths.formulas_path, {
        "f1": {"latex": "F=ma", "sessionId": sid},
    })
    storage._write_json(paths.kv_dir / f"{sid}.json", {"graph:" + sid: {"zoom": 0.9}})
    storage._write_json(paths.kv_path, {
        "socratic:" + sid: {"active": True, "stage": "hint"},
        "socratic:br_" + sid + "_1234567890": {"active": True, "stage": "answer"},
        "phymathia_quiz_stats": {
            "q1": {"sessionId": sid, "score": 1},
            "q2": {"sessionId": "sess_bbb", "score": 0},
            "_meta": {
                "wrongQuestions": [{"sessionId": "phymathia_aaa", "q": "w1"}],
                "openResults": [{"sessionId": sid, "answer": "F=ma"}],
            },
        },
        "phymathia_quiz_bank": {"questions": [{"id": "b1", "sessionId": sid},
                                              {"id": "b2", "sessionId": "sess_bbb"}],
                                "updatedAt": now},
    })


# ====== 捕获 ======

def test_capture_snapshot_is_complete_and_touches_nothing(acc_env):
    _seed_session()
    paths = _paths()
    assert trash.capture_session(paths, "sess_aaa") is True
    item_dir = paths.root / "trash" / "sess_aaa"
    assert (item_dir / "meta.json").exists()
    assert (item_dir / "session.json").is_file()
    assert (item_dir / "messages.json").is_file()
    assert (item_dir / "knowledge.json").is_file()
    assert (item_dir / "formulas.json").is_file()
    assert (item_dir / "kv__sess_aaa.json").is_file()
    assert (item_dir / "socratic.json").is_file()
    assert (item_dir / "quiz_stats.json").is_file()
    assert (item_dir / "quiz_bank.json").is_file()
    # 共享归属的 k2 不入站（它不会被删除抹掉）
    captured_k = json.loads((item_dir / "knowledge.json").read_text(encoding="utf-8"))
    assert set(captured_k) == {"k1"}
    # quiz 只捕本会话条目
    captured_stats = json.loads((item_dir / "quiz_stats.json").read_text(encoding="utf-8"))
    assert "q1" in captured_stats and "q2" not in captured_stats
    assert captured_stats["_meta"]["wrongQuestions"][0]["sessionId"] == "phymathia_aaa"
    # 捕获只写 trash 目录，不碰活数据（删除由原链路负责）
    assert "sess_aaa" in storage._read_json(paths.sessions_path, {})
    assert (paths.messages_dir / "sess_aaa.json").exists()
    meta = json.loads((item_dir / "meta.json").read_text(encoding="utf-8"))
    assert meta["title"] == "物理画布"
    assert meta["counts"] == {"messages": 1, "knowledge": 1, "formulas": 1}
    assert meta["purgeAt"] > meta["deletedAt"]


def test_capture_nothing_when_session_has_no_data(acc_env):
    paths = _paths()
    assert trash.capture_session(paths, "sess_ghost") is False
    assert not (paths.root / "trash" / "sess_ghost").exists()


def test_retention_zero_disables_capture(acc_env):
    _seed_session()
    trash.set_retention_days("default", 0)
    paths = _paths()
    assert trash.capture_session(paths, "sess_aaa") is False
    assert not (paths.root / "trash" / "sess_aaa").exists()


def test_capture_all_counts_sessions(acc_env):
    _seed_session()
    storage._write_json(_paths().messages_dir / "sess_bbb.json", [])
    assert trash.capture_all(_paths()) == 2
    assert len(trash.list_items(_paths())) == 2


def test_capture_unsafe_session_id_in_entry_not_used_for_paths(acc_env):
    """entry.sessionId 来自前端 payload 未经校验：可作匹配值，绝不进文件路径。"""
    _seed_session()
    paths = _paths()
    sessions = storage._read_json(paths.sessions_path, {})
    sessions["sess_aaa"]["sessionId"] = "../../evil"
    storage._write_json(paths.sessions_path, sessions)
    assert trash.capture_session(paths, "sess_aaa") is True
    assert not (paths.root.parent.parent / "evil").exists()
    assert not list((paths.root / "trash" / "sess_aaa").glob("kv__..*"))


# ====== 恢复 ======

def test_restore_roundtrip_brings_everything_back(acc_env):
    _seed_session()
    paths = _paths()
    assert trash.capture_session(paths, "sess_aaa") is True
    # 模拟原删除链路把活数据全抹掉
    sessions = storage._read_json(paths.sessions_path, {})
    sessions.pop("sess_aaa")
    storage._write_json(paths.sessions_path, sessions)
    (paths.messages_dir / "sess_aaa.json").unlink()
    storage._write_json(paths.knowledge_path, {"k2": {"title": "共享条目"}, "k3": {}})
    storage._write_json(paths.formulas_path, {})
    (paths.kv_dir / "sess_aaa.json").unlink()
    storage._write_json(paths.kv_path, {"phymathia_quiz_stats": {"q2": {"sessionId": "sess_bbb"}},
                                        "phymathia_quiz_bank": {"questions": [{"id": "b2", "sessionId": "sess_bbb"}]}})
    assert trash.restore_item(paths, "sess_aaa") == "sess_aaa"
    # 名单与消息回来
    assert storage._read_json(paths.sessions_path, {})["sess_aaa"]["title"] == "物理画布"
    assert len(storage._read_json(paths.messages_dir / "sess_aaa.json", [])) == 1
    # 独占知识/公式回填；活数据（k2/k3）不被覆盖
    knowledge = storage._read_json(paths.knowledge_path, {})
    assert "k1" in knowledge and "k2" in knowledge and "k3" in knowledge
    assert knowledge["k2"]["title"] == "共享条目"
    assert storage._read_json(paths.formulas_path, {})["f1"]["latex"] == "F=ma"
    # 探索网快照回原拆分文件
    assert storage._read_json(paths.kv_dir / "sess_aaa.json", {})["graph:sess_aaa"] == {"zoom": 0.9}
    # 苏格拉底两代键（精确 + 分支链）都回来
    kv = storage._read_json(paths.kv_path, {})
    assert kv["socratic:sess_aaa"]["stage"] == "hint"
    assert kv["socratic:br_sess_aaa_1234567890"]["active"] is True
    # quiz 统计（q1/wrong/open）与题库 b1 回填，别人的 q2/b2 不受影响
    stats = kv["phymathia_quiz_stats"]
    assert stats["q1"]["score"] == 1 and "q2" in stats
    assert {"sessionId": "phymathia_aaa", "q": "w1"} in stats["_meta"]["wrongQuestions"]
    assert {"sessionId": "sess_aaa", "answer": "F=ma"} in stats["_meta"]["openResults"]
    assert {q["id"] for q in kv["phymathia_quiz_bank"]["questions"]} == {"b1", "b2"}
    # 站内条目移除；重复恢复 404 语义（KeyError）
    assert trash.list_items(paths) == []
    with pytest.raises(KeyError):
        trash.restore_item(paths, "sess_aaa")


def test_restore_conflict_when_live_session_exists(acc_env):
    _seed_session()
    paths = _paths()
    trash.capture_session(paths, "sess_aaa")
    with pytest.raises(trash.TrashConflictError):
        trash.restore_item(paths, "sess_aaa")
    # 拒绝后站内条目还在，活数据没被动过
    assert len(trash.list_items(paths)) == 1
    assert storage._read_json(paths.sessions_path, {})["sess_aaa"]["title"] == "物理画布"


def test_restore_missing_item_raises_key_error(acc_env):
    with pytest.raises(KeyError):
        trash.restore_item(_paths(), "sess_nope")


def test_restore_rejects_unsafe_item_id(acc_env):
    for bad in ("..", "a/b", "a b", "..\\evil"):
        with pytest.raises(KeyError):
            trash.restore_item(_paths(), bad)


# ====== 过期清理 / 清空 / 列表 ======

def test_purge_expired_lazy_on_list(acc_env):
    _seed_session()
    paths = _paths()
    trash.capture_session(paths, "sess_aaa")
    meta_path = paths.root / "trash" / "sess_aaa" / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["purgeAt"] = 1  # 远古时间＝已过期
    meta_path.write_text(json.dumps(meta), encoding="utf-8")
    assert trash.list_items(paths) == []
    assert not (paths.root / "trash" / "sess_aaa").exists()


def test_purge_expired_sweeps_orphan_dirs_after_a_day(acc_env):
    _seed_session()
    paths = _paths()
    orphan = paths.root / "trash" / "sess_orphan"
    orphan.mkdir(parents=True)
    (orphan / "session.json").write_text("{}", encoding="utf-8")  # 有文件没 meta＝半写入
    assert trash.list_items(paths) == []
    import os as _os
    old = time.time() - 2 * 86_400
    os.utime(orphan, (old, old))
    trash.purge_expired(paths)
    assert not orphan.exists()


def test_empty_trash(acc_env):
    _seed_session()
    paths = _paths()
    trash.capture_all(paths)
    assert trash.empty_trash(paths) == 2
    assert trash.list_items(paths) == []


def test_purge_item_single(acc_env):
    _seed_session()
    paths = _paths()
    trash.capture_session(paths, "sess_aaa")
    trash.purge_item(paths, "sess_aaa")
    assert trash.list_items(paths) == []


# ====== 账号域 ======

def test_trash_is_per_account(acc_env):
    accounts.ensure_account("alice")
    accounts.ensure_account("bob")
    _seed_session(account="alice")
    assert trash.capture_session(_paths("alice"), "sess_aaa") is True
    alice = trash.list_items(_paths("alice"))
    assert [it["id"] for it in alice] == ["sess_aaa"]
    assert trash.list_items(_paths("bob")) == []
    assert trash.list_items(_paths()) == []  # default 也看不见
    with pytest.raises(KeyError):
        trash.restore_item(_paths("bob"), "sess_aaa")


# ====== 保留天数（存注册表，按账号独立） ======

def test_retention_default_seven(acc_env):
    accounts.ensure_account("default")
    assert trash.retention_days("default") == 7
    accounts.ensure_account("alice")
    assert trash.retention_days("alice") == 7


def test_retention_set_and_validate(acc_env):
    accounts.ensure_account("alice")
    assert trash.set_retention_days("alice", 30) == 30
    assert trash.retention_days("alice") == 30
    assert trash.set_retention_days("alice", "3") == 3  # 字符串整数也收（表单友好）
    for bad in (-1, 366, "abc", None, [7]):
        with pytest.raises(ValueError):
            trash.set_retention_days("alice", bad)
    assert trash.retention_days("alice") == 3  # 非法值不落库
    assert trash.retention_days("default") == 7  # 按账号独立，互不污染


def test_retention_dirty_registry_falls_back_to_default(acc_env):
    accounts.ensure_account("default")
    reg_path = accounts.registry_path()
    data = json.loads(reg_path.read_text(encoding="utf-8"))
    data["accounts"][0]["trashRetentionDays"] = "一百万年"
    reg_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert trash.retention_days("default") == 7


# ====== 路由层（TestClient 端到端） ======

def _client():
    from fastapi.testclient import TestClient
    import main as main_mod
    accounts._ENSURED.clear()
    return TestClient(main_mod.app)


def test_route_delete_goes_to_trash_and_restores(acc_env):
    _seed_session(account="alice")
    accounts.ensure_account("alice")
    with _client() as client:
        # 删除（走原路由）→ 进回收站而非消失
        r = client.delete("/api/sessions/sess_aaa", params={"account_id": "alice"})
        assert r.status_code == 200 and r.json()["ok"] is True
        alice_sessions = storage._read_json(_paths("alice").sessions_path, {})
        assert "sess_aaa" not in alice_sessions
        listing = client.get("/api/trash", params={"account_id": "alice"}).json()
        assert listing["retentionDays"] == 7
        assert [it["id"] for it in listing["items"]] == ["sess_aaa"]
        assert listing["items"][0]["counts"]["messages"] == 1
        # 恢复 → 名单与消息都回来
        r = client.post("/api/trash/sess_aaa/restore", params={"account_id": "alice"})
        assert r.status_code == 200 and r.json()["sessionId"] == "sess_aaa"
        restored = storage._read_json(_paths("alice").sessions_path, {})
        assert restored["sess_aaa"]["title"] == "物理画布"
        msgs = client.get("/api/sessions/sess_aaa/messages", params={"account_id": "alice"})
        assert msgs.status_code == 200 and len(msgs.json()) == 1
        # 恢复后站内已空
        assert client.get("/api/trash", params={"account_id": "alice"}).json()["items"] == []


def test_route_trash_is_account_scoped(acc_env):
    _seed_session(account="alice")
    accounts.ensure_account("alice")
    accounts.ensure_account("bob")
    with _client() as client:
        client.delete("/api/sessions/sess_aaa", params={"account_id": "alice"})
        assert client.get("/api/trash").json()["items"] == []  # default 看不见 alice 的回收站


def test_route_trash_settings_and_validation(acc_env):
    accounts.ensure_account("default")
    with _client() as client:
        assert client.post("/api/trash/settings", json={"days": 30}).json()["retentionDays"] == 30
        assert client.get("/api/trash").json()["retentionDays"] == 30
        for bad in (-1, 366, "abc"):
            assert client.post("/api/trash/settings", json={"days": bad}).status_code == 400


def test_route_trash_readonly_gate(acc_env):
    """查阅态：GET 放行，POST/DELETE 被只读头兜底中间件拦 403。"""
    accounts.ensure_account("default")
    with _client() as client:
        ro = {"x-phymathia-readonly": "1"}
        assert client.get("/api/trash", headers=ro).status_code == 200
        assert client.post("/api/trash/settings", json={"days": 7}, headers=ro).status_code == 403
        assert client.post("/api/trash/x/restore", headers=ro).status_code == 403
        assert client.delete("/api/trash", headers=ro).status_code == 403
        assert client.delete("/api/trash/x", headers=ro).status_code == 403


def test_route_purge_and_404(acc_env):
    _seed_session(account="alice")
    accounts.ensure_account("alice")
    with _client() as client:
        client.delete("/api/sessions/sess_aaa", params={"account_id": "alice"})
        assert client.delete("/api/trash/sess_aaa", params={"account_id": "alice"}).json()["ok"] is True
        assert client.delete("/api/trash/sess_aaa", params={"account_id": "alice"}).status_code == 404
        assert client.delete("/api/trash/nope", params={"account_id": "alice"}).status_code == 404
        # 白名单外 id 不 500（httpx 会把 ".." 归一化掉，用带空格的非法 id 验证）
        assert client.delete("/api/trash/a%20b", params={"account_id": "alice"}).status_code == 404


def test_route_delete_formulas_by_session_no_name_error(acc_env):
    """回归钉子（2026-10-07 真机抓出）：P1 账号参数化漏改了本路由签名，
    函数体引用 request 而 signature 没有它——删画布的公式清理一直 500 静默失败。"""
    _seed_session(account="alice")
    accounts.ensure_account("alice")
    with _client() as client:
        r = client.delete("/api/formulas", params={"session_id": "sess_aaa", "account_id": "alice"})
        assert r.status_code == 200, r.text
        assert json.loads(_paths("alice").formulas_path.read_text(encoding="utf-8")) == {}
