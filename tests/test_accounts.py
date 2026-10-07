"""本地多账号 P1（服务端账号域）：注册表、路径工厂、旧数据迁移、双账号隔离。

核心钉死「串号」风险：同一 session id / KV 键在两个账号下互不可见——
P1 完成后的双账号交叉读写专项（计划验收项）。
"""

import json
import os
import sys
from pathlib import Path

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
    """DATA_DIR 指向临时目录 + 清 ensure 缓存；返回 (tmp 目录, accounts 模块)。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    yield tmp_path, accounts
    accounts._ENSURED.clear()


# ====== 账号 id 消毒（路径穿越防线） ======

def test_validate_account_id_accepts_safe(acc_env):
    assert accounts.validate_account_id("alice") == "alice"
    assert accounts.validate_account_id("A-b_9") == "A-b_9"
    assert accounts.validate_account_id("default") == "default"


def test_validate_account_id_rejects_traversal(acc_env):
    # 空/None/路径分隔符/反斜杠/超长，一律回 default，杜绝拼路径穿越
    for bad in ("", None, "..", "a/b", "..\\evil", "a b", "x" * 65):
        assert accounts.validate_account_id(bad) == "default", bad


# ====== resolve_paths 布局 ======

def test_resolve_paths_layout(acc_env):
    tmp_path, _ = acc_env
    paths = accounts.resolve_paths("alice")
    root = tmp_path / "users" / "alice"
    assert paths.root == root
    assert paths.sessions_path == root / "sessions.json"
    assert paths.messages_dir == root / "messages"
    assert paths.knowledge_path == root / "knowledge.json"
    assert paths.formulas_path == root / "formulas.json"
    assert paths.kv_path == root / "kv_store.json"
    assert paths.kv_dir == root / "kv"
    # 纯计算不落盘
    assert not root.exists()


# ====== 注册表 CRUD ======

def test_register_account_idempotent_with_defaults(acc_env):
    tmp_path, _ = acc_env
    first = accounts.register_account("alice")
    assert first["id"] == "alice"
    assert first["name"] == "alice"
    assert first["allowBrowse"] is False
    created = first["createdAt"]
    # 重复登记不改已有字段
    again = accounts.register_account("alice")
    assert again["createdAt"] == created
    # default 账号默认名「我的」
    assert accounts.register_account("default")["name"] == "我的"
    # 落盘形状
    data = json.loads(accounts.registry_path().read_text(encoding="utf-8"))
    assert {e["id"] for e in data["accounts"]} >= {"alice", "default"}


def test_rename_and_allow_browse(acc_env):
    _, _ = acc_env
    accounts.register_account("alice")
    renamed = accounts.rename_account("alice", "小爱")
    assert renamed["name"] == "小爱"
    assert accounts.set_allow_browse("alice", True)["allowBrowse"] is True
    assert accounts.can_browse("alice") is True
    assert accounts.can_browse("nobody") is False  # 未登记一律不可查阅
    accounts.set_allow_browse("alice", False)
    assert accounts.can_browse("alice") is False


def test_remove_account_and_default_protected(acc_env):
    tmp_path, _ = acc_env
    paths = accounts.ensure_account("bob")
    (paths.root / "sessions.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError):
        accounts.remove_account("default", delete_data=True)  # 兜底账号拒删
    accounts.remove_account("bob", delete_data=True)
    assert "bob" not in accounts.load_registry()
    assert not (tmp_path / "users" / "bob").exists()


# ====== ensure_account：目录 + 缓存 + 登记 ======

def test_ensure_account_creates_dirs_and_registers(acc_env):
    tmp_path, _ = acc_env
    paths = accounts.ensure_account("carol")
    assert paths.messages_dir.is_dir()
    assert paths.kv_dir.is_dir()
    assert "carol" in accounts.load_registry()
    # 幂等：重复调用不重建
    paths2 = accounts.ensure_account("carol")
    assert paths2 == paths


# ====== 旧数据迁移（一次性，只 mv 不删） ======

def test_migration_moves_legacy_files_on_first_account(acc_env):
    tmp_path, _ = acc_env
    # 模拟升级现场：data/ 根有旧全局文件与目录
    (tmp_path / "sessions.json").write_text('{"s1": {"id": "s1"}}', encoding="utf-8")
    (tmp_path / "knowledge.json").write_text('{"k1": {"id": "k1"}}', encoding="utf-8")
    (tmp_path / "formulas.json").write_text('{"f1": {}}', encoding="utf-8")
    (tmp_path / "kv_store.json").write_text('{"g:k": "v"}', encoding="utf-8")
    (tmp_path / "messages").mkdir()
    (tmp_path / "messages" / "s1.json").write_text("[]", encoding="utf-8")
    (tmp_path / "kv").mkdir()
    (tmp_path / "kv" / "s1.json").write_text("{}", encoding="utf-8")
    # 共享目录不该被动
    (tmp_path / "uploads").mkdir()
    (tmp_path / "uploads" / "x.bin").write_bytes(b"z")

    paths = accounts.ensure_account("default")
    acc_root = tmp_path / "users" / "default"
    assert json.loads((acc_root / "sessions.json").read_text(encoding="utf-8")) == {"s1": {"id": "s1"}}
    assert json.loads((acc_root / "knowledge.json").read_text(encoding="utf-8")) == {"k1": {"id": "k1"}}
    assert (acc_root / "messages" / "s1.json").exists()
    assert (acc_root / "kv" / "s1.json").exists()
    # 旧位置只剩空壳（目录）/已消失（文件）
    assert not (tmp_path / "sessions.json").exists()
    assert not (tmp_path / "messages").exists()
    # 共享目录原样
    assert (tmp_path / "uploads" / "x.bin").read_bytes() == b"z"
    # flag 落盘防重跑
    assert (tmp_path / "users" / "legacy_migrated.flag").exists()


def test_migration_flag_prevents_second_run(acc_env):
    tmp_path, _ = acc_env
    (tmp_path / "sessions.json").write_text('{"s1": {"id": "s1"}}', encoding="utf-8")
    accounts.ensure_account("default")
    assert not (tmp_path / "sessions.json").exists()
    # flag 在：后续新账号/重复 ensure 都不再扫根目录（防偷走用户手动放回的文件）
    (tmp_path / "sessions.json").write_text('{"new": 1}', encoding="utf-8")
    accounts.ensure_account("alice")
    assert (tmp_path / "sessions.json").exists()  # 根目录文件未被第二个账号搬走
    assert not (tmp_path / "users" / "alice" / "sessions.json").exists()


def test_migration_resumes_after_interrupt(acc_env):
    tmp_path, _ = acc_env
    (tmp_path / "sessions.json").write_text('{"s1": 1}', encoding="utf-8")
    (tmp_path / "knowledge.json").write_text('{"k1": 1}', encoding="utf-8")
    # 模拟中断：sessions 已搬、knowledge 未搬、flag 未落
    users = tmp_path / "users"
    users.mkdir()
    (users / "default").mkdir()
    (users / "default" / "sessions.json").write_text('{"s1": 1}', encoding="utf-8")
    paths = accounts.ensure_account("default")
    assert json.loads((paths.root / "knowledge.json").read_text(encoding="utf-8")) == {"k1": 1}
    assert (paths.root / "sessions.json").exists()  # 已搬的不受影响


# ====== 双账号交叉读写（串号专项） ======

def test_kv_isolated_between_accounts(acc_env):
    _, _ = acc_env
    storage.kv_write("phymathia_quiz_stats", {"v": 1}, account="default")
    storage.kv_write("phymathia_quiz_stats", {"v": 2}, account="alice")
    storage.kv_write("graph:sess_x", {"nodes": [1]}, account="alice")
    assert storage.kv_read("phymathia_quiz_stats", account="default") == {"v": 1}
    assert storage.kv_read("phymathia_quiz_stats", account="alice") == {"v": 2}
    assert storage.kv_read("graph:sess_x", account="alice") == {"nodes": [1]}
    assert storage.kv_read("graph:sess_x", account="default") is None
    # 会话级拆分文件也按账号分目录
    alice_kv_dir = accounts.resolve_paths("alice").kv_dir
    assert (alice_kv_dir / "sess_x.json").exists()
    default_kv_dir = accounts.resolve_paths("default").kv_dir
    assert not (default_kv_dir / "sess_x.json").exists()
    # 删除也分域
    storage.kv_delete("phymathia_quiz_stats", account="alice")
    assert storage.kv_read("phymathia_quiz_stats", account="alice") is None
    assert storage.kv_read("phymathia_quiz_stats", account="default") == {"v": 1}


def test_sessions_and_messages_isolated_between_accounts(acc_env):
    _, _ = acc_env
    for acc, sid in (("default", "sess_a"), ("alice", "sess_a")):  # 同一 session id 两账号各一份
        path = storage._get_messages_path(sid, account=acc)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps([{"role": "user", "content": f"msg-{acc}"}]), encoding="utf-8")
        storage._invalidate_json_cache(path)
    assert json.loads(storage._get_messages_path("sess_a", account="default").read_text(encoding="utf-8"))[0]["content"] == "msg-default"
    assert json.loads(storage._get_messages_path("sess_a", account="alice").read_text(encoding="utf-8"))[0]["content"] == "msg-alice"
    # 反向解析（server sessionId → local id）也分域
    from server.storage import _resolve_messages_path
    sessions = accounts.resolve_paths("alice").sessions_path
    sessions.parent.mkdir(parents=True, exist_ok=True)
    sessions.write_text(json.dumps({"sess_a": {"id": "sess_a", "sessionId": "remote_1"}}), encoding="utf-8")
    assert _resolve_messages_path("remote_1", account="alice") == storage._get_messages_path("sess_a", account="alice")
    # default 账号没有该别名映射：回落 default 自己的直连路径，绝不越到 alice 域
    assert _resolve_messages_path("remote_1", account="default") == storage._get_messages_path("remote_1", account="default")


def test_kv_migrate_and_restore_bulk_per_account(acc_env):
    _, _ = acc_env
    paths = accounts.ensure_account("alice")
    # 主文件里带会话级键 → 启动迁移按账号搬进 data/kv
    paths.kv_path.parent.mkdir(parents=True, exist_ok=True)
    paths.kv_path.write_text(json.dumps({"graph:s1": {"n": 1}, "g:k": "v"}), encoding="utf-8")
    assert storage.kv_migrate_session_keys(account="alice") == 1  # 搬的是会话级键数（graph:s1）
    assert (paths.kv_dir / "s1.json").exists()
    assert json.loads(paths.kv_path.read_text(encoding="utf-8")) == {"g:k": "v"}  # 全局键留主文件
    # 备份导入按账号落盘
    storage.kv_restore_bulk({"g:k2": "v2", "graph:s2": {"n": 2}}, replace=False, account="alice")
    assert storage.kv_read("g:k2", account="alice") == "v2"
    assert storage.kv_read("g:k2", account="default") is None
    merged = storage.kv_all_data(account="alice")
    assert merged["g:k"] == "v" and merged["g:k2"] == "v2" and merged["graph:s2"] == {"n": 2}


# ====== 备份按账号导出/恢复 ======

def test_backup_payload_is_account_scoped(acc_env):
    tmp_path, _ = acc_env
    from server import backup
    accounts.ensure_account("default")
    accounts.ensure_account("alice")
    storage.kv_write("g:k", "v-default", account="default")
    storage.kv_write("g:k", "v-alice", account="alice")
    d_paths = accounts.resolve_paths("default")
    a_paths = accounts.resolve_paths("alice")
    for paths, marker in ((d_paths, "d"), (a_paths, "a")):
        paths.sessions_path.parent.mkdir(parents=True, exist_ok=True)
        backup._write_json(paths.knowledge_path, {"k": {"id": "k", "title": marker}})
    payload_d = backup._build_backup_payload("default")
    payload_a = backup._build_backup_payload("alice")
    assert payload_d["kv"]["g:k"] == "v-default"
    assert payload_a["kv"]["g:k"] == "v-alice"
    # replace 导入只清目标账号
    backup._restore_backup({"sessions": [], "messages": {}, "knowledge": {}, "formulas": {},
                            "kv": {"g:k": "restored"}, "profiles": {}}, replace=True, account="alice")
    assert storage.kv_read("g:k", account="alice") == "restored"
    assert storage.kv_read("g:k", account="default") == "v-default"  # default 不被波及


# ====== 路由层 _account_id 透传（TestClient 端到端） ======

def test_route_account_isolation_end_to_end(acc_env):
    """带 account_id 的会话路由读写各自账号域；不带 account_id 落 default。"""
    tmp_path, _ = acc_env
    from fastapi.testclient import TestClient
    import main as main_mod
    accounts._ENSURED.clear()
    with TestClient(main_mod.app) as client:
        r = client.post("/api/sessions", json={"id": "s1", "title": "甲的会话", "account_id": "alice"})
        assert r.status_code == 200 and r.json()["count"] == 1
        # 不带账号 = default：看不见 alice 的会话
        assert client.get("/api/sessions").json() == {}
        # 带 account_id=alice 才看得见
        assert client.get("/api/sessions", params={"account_id": "alice"}).json()["s1"]["title"] == "甲的会话"
        # 非法 account_id 消毒回 default，不会穿越出账号目录
        assert client.get("/api/sessions", params={"account_id": "..%2F..%2Fetc"}).json() == {}
    alice_sessions = accounts.resolve_paths("alice").sessions_path
    assert json.loads(alice_sessions.read_text(encoding="utf-8"))["s1"]["title"] == "甲的会话"
