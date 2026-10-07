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
from server import trash  # noqa: E402


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    """DATA_DIR 指向临时目录 + 清 ensure/注册表缓存；返回 (tmp 目录, accounts 模块)。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    _reset_caches()
    yield tmp_path, accounts
    _reset_caches()


def _reset_caches():
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}


def _make(account, name=None):
    """建账号的显式两步（2026-10-07 T186 起 ensure_account 不再自动登记非
    default 账号）：先登记再 ensure，与生产路径（POST /api/accounts）同序同果。"""
    accounts.register_account(account, name=name)
    return accounts.ensure_account(account, name=name)


# ====== 账号 id 消毒（路径穿越防线） ======

def test_validate_account_id_accepts_safe(acc_env):
    assert accounts.validate_account_id("alice") == "alice"
    assert accounts.validate_account_id("A-b_9") == "A-b_9"
    assert accounts.validate_account_id("default") == "default"


def test_validate_account_id_rejects_traversal(acc_env):
    # 空/None/路径分隔符/反斜杠/超长/服务保留名（_ 前缀＝_trash 墓碑区），
    # 一律回 default，杜绝拼路径穿越
    for bad in ("", None, "..", "a/b", "..\\evil", "a b", "x" * 65, "_trash", "_tmp"):
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


def test_remove_account_registry_only_and_default_protected(acc_env):
    """remove_account 只除名不动磁盘（2026-10-07 删账号回收站化后，数据目录的
    处置——移入墓碑区或彻底清除——归 trash 层）；default 拒删不变。"""
    tmp_path, _ = acc_env
    paths = _make("bob")
    (paths.root / "sessions.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError):
        accounts.remove_account("default")  # 兜底账号拒删
    accounts.remove_account("bob")
    assert "bob" not in accounts.load_registry()
    assert (tmp_path / "users" / "bob" / "sessions.json").exists()  # 目录原样
    # forget_ensured 后 ensure 不再复活（T186 幽灵闸门）：登记只走显式路由——
    # 恢复账号走 trash.restore_account_tombstone（按 meta.entry 重登记）
    accounts.forget_ensured("bob")
    accounts.ensure_account("bob")
    assert "bob" not in accounts.load_registry()
    # 显式恢复路径（register + ensure）照常
    _make("bob")
    assert "bob" in accounts.load_registry()


# ====== ensure_account：目录 + 缓存 + 登记 ======

def test_ensure_account_creates_dirs_for_registered_account(acc_env):
    """已登记账号：ensure 建目录并登记（幂等，重复调用不重建）。"""
    tmp_path, _ = acc_env
    paths = _make("carol")
    assert paths.messages_dir.is_dir()
    assert paths.kv_dir.is_dir()
    assert "carol" in accounts.load_registry()
    paths2 = accounts.ensure_account("carol")
    assert paths2 == paths


def test_ensure_account_skips_unregistered_non_default(acc_env):
    """未登记且无墓碑的非 default 账号：ensure 不建目录、不登记（T186 幽灵闸门
    的直调防线——请求侧更早的闸在 main.py _account_id）。default 例外，首启自登记。"""
    tmp_path, _ = acc_env
    paths = accounts.ensure_account("ghost")
    assert not paths.root.exists()
    assert "ghost" not in accounts.load_registry()
    # default 例外：它是无 account_id 请求的落点，首启即自登记
    accounts.ensure_account()
    assert "default" in accounts.load_registry()


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
    _make("alice")
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
    paths = _make("alice")
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
    _make("alice")
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
    """带 account_id 的会话路由读写各自账号域；不带 account_id 落 default。
    未登记的 account_id 一律 404（T186 幽灵闸门：账号存在＝注册表有条目）。"""
    tmp_path, _ = acc_env
    from fastapi.testclient import TestClient
    import main as main_mod
    accounts._ENSURED.clear()
    _make("alice")
    with TestClient(main_mod.app) as client:
        r = client.post("/api/sessions", json={"id": "s1", "title": "甲的会话", "account_id": "alice"})
        assert r.status_code == 200 and r.json()["count"] == 1
        # 不带账号 = default：看不见 alice 的会话
        assert client.get("/api/sessions").json() == {}
        # 带 account_id=alice 才看得见
        assert client.get("/api/sessions", params={"account_id": "alice"}).json()["s1"]["title"] == "甲的会话"
        # 未登记的 id（曾把已删账号复活的形态）：404，不建目录不登记
        assert client.get("/api/sessions", params={"account_id": "nobody"}).status_code == 404
        assert not (tmp_path / "users" / "nobody").exists()
        assert "nobody" not in accounts.load_registry()
        # 非法 account_id 消毒回 default，不会穿越出账号目录
        assert client.get("/api/sessions", params={"account_id": "..%2F..%2Fetc"}).json() == {}
    alice_sessions = accounts.resolve_paths("alice").sessions_path
    assert json.loads(alice_sessions.read_text(encoding="utf-8"))["s1"]["title"] == "甲的会话"


# ====== 账号管理路由（P2：/api/accounts CRUD）======

def _client(acc_env):
    from fastapi.testclient import TestClient
    import main as main_mod
    accounts._ENSURED.clear()
    return TestClient(main_mod.app)


def test_accounts_route_list_default_first(acc_env):
    """列表：default 排最前，条目带 id/name/allowBrowse/createdAt。"""
    accounts.ensure_account("default")
    _make("bob")
    with _client(acc_env) as client:
        items = client.get("/api/accounts").json()["accounts"]
        ids = [e["id"] for e in items]
        assert ids[0] == "default" and "bob" in ids
        assert all(set(e) >= {"id", "name", "allowBrowse", "createdAt"} for e in items)


def test_accounts_route_create_switch_domain(acc_env):
    """新建：服务端生成 12 位十六进制 id、建目录登记；后续存储请求按新 id 分域。"""
    with _client(acc_env) as client:
        r = client.post("/api/accounts", json={"name": "测试账号"})
        assert r.status_code == 200
        entry = r.json()
        assert entry["name"] == "测试账号" and entry["allowBrowse"] is False
        assert len(entry["id"]) == 12
        # 新账号目录已建（messages/kv 就位），且会话写入落自己的域
        assert (accounts.resolve_paths(entry["id"]).messages_dir).is_dir()
        client.post("/api/sessions", json={"id": "s1", "title": "新账号的画布", "account_id": entry["id"]})
        assert client.get("/api/sessions").json() == {}  # default 看不见
    names = {e["name"] for e in accounts.load_registry().values()}
    assert "测试账号" in names


def test_accounts_route_create_name_clamp_and_default_name(acc_env):
    """新建：空名落默认命名（id）；超长昵称截到 40 字符。"""
    with _client(acc_env) as client:
        e1 = client.post("/api/accounts", json={}).json()
        assert e1["name"] == e1["id"]
        e2 = client.post("/api/accounts", json={"name": "长" * 99}).json()
        assert len(e2["name"]) == 40


def test_accounts_route_create_rerolls_id_colliding_with_tombstone(acc_env, monkeypatch):
    """建号重摇（T191）：id 撞墓碑时目录建不起来（墓碑目录占名）且请求走
    「已删账号」404，只能换号；monkeypatch uuid4 先给墓碑 id、再给新 id。"""
    import types
    import uuid as uuid_mod
    import main as main_mod
    accounts.ensure_account("default")
    _make("deadbeefcafe")
    entry = dict(accounts.get_account("deadbeefcafe"))
    accounts.remove_account("deadbeefcafe")  # 与删除路由同序：注册表除名后墓碑化
    assert trash.capture_account("deadbeefcafe", entry, 7)
    real_uuid4 = uuid_mod.uuid4
    pending = ["deadbeefcafe", "0f0f0f0f0f0f"]

    def fake_uuid4():
        if pending:
            return types.SimpleNamespace(hex=pending.pop(0))
        return real_uuid4()  # 其它调用方（落盘 tmp 文件名等）照常

    with _client(acc_env) as client:
        monkeypatch.setattr(main_mod.uuid, "uuid4", fake_uuid4)
        r = client.post("/api/accounts", json={"name": "重摇"})
    assert r.status_code == 200 and r.json()["id"] == "0f0f0f0f0f0f"
    assert pending == []  # 预置两号都被取走：先撞墓碑、再摇到可用 id
    assert "deadbeefcafe" not in accounts.load_registry()
    assert trash.tombstone_account_ids() == {"deadbeefcafe"}


def test_accounts_route_rename_and_allow_browse(acc_env):
    """改名与 allow_browse：对已登记账号生效；缺账号 404；空名/缺 id 400。"""
    accounts.ensure_account("default")
    _make("carol")
    with _client(acc_env) as client:
        r = client.post("/api/accounts/rename", json={"account_id": "carol", "name": "卡罗"})
        assert r.status_code == 200 and r.json()["name"] == "卡罗"
        # default 也可改名（昵称显示用，id 不变）
        assert client.post("/api/accounts/rename", json={"account_id": "default", "name": "我的主号"}).json()["name"] == "我的主号"
        r = client.post("/api/accounts/allow_browse", json={"account_id": "carol", "allow": True})
        assert r.status_code == 200 and r.json()["allowBrowse"] is True
        assert accounts.can_browse("carol") is True
        assert client.post("/api/accounts/rename", json={"account_id": "ghost", "name": "x"}).status_code == 404
        assert client.post("/api/accounts/allow_browse", json={"account_id": "ghost", "allow": True}).status_code == 404
        assert client.post("/api/accounts/rename", json={"account_id": "carol", "name": "  "}).status_code == 400
        assert client.post("/api/accounts/rename", json={"name": "无目标"}).status_code == 400
        # 非法 id（穿越串）在管理路由是 400 而非静默落 default——管理操作必须精确
        assert client.post("/api/accounts/delete", json={"account_id": "../evil"}).status_code == 400


def test_accounts_route_delete_enters_tombstone_and_restores(acc_env):
    """删除：注册表除名 + 目录整体移入 data/users/_trash/ 墓碑区 + meta 完整
    标志；恢复＝数据与注册表条目全回（昵称/allowBrowse/createdAt 原样，
    账号 id 不变）。default 拒删 400、保留名 _trash 400 不变。"""
    accounts.ensure_account("default")
    _make("dave")
    accounts.rename_account("dave", "呆夫")
    accounts.set_allow_browse("dave", True)
    dave_paths = accounts.resolve_paths("dave")
    dave_paths.kv_dir.mkdir(parents=True, exist_ok=True)
    (dave_paths.kv_dir / "k.json").write_text("{}", encoding="utf-8")
    created_at = accounts.get_account("dave")["createdAt"]
    with _client(acc_env) as client:
        assert client.post("/api/accounts/delete", json={"account_id": "default", "delete_data": True}).status_code == 400
        assert client.post("/api/accounts/delete", json={"account_id": "_trash", "delete_data": True}).status_code == 400
        r = client.post("/api/accounts/delete", json={"account_id": "dave", "delete_data": True})
        assert r.status_code == 200 and r.json()["ok"] is True and r.json()["inTrash"] is True
        assert "dave" not in accounts.load_registry()
        assert not (accounts.users_dir() / "dave").exists()
        stones = trash.list_account_tombstones()
        assert len(stones) == 1 and stones[0]["id"] == "dave" and stones[0]["name"] == "呆夫"
        stone = stones[0]["stone"]
        assert (accounts.users_dir() / "_trash" / stone / "kv" / "k.json").exists()
        assert (accounts.users_dir() / "_trash" / stone / "meta.json").exists()
        # 幂等：重复删仍 200（目录已不在则不建墓碑）
        assert client.post("/api/accounts/delete", json={"account_id": "dave", "delete_data": True}).status_code == 200
        assert len(trash.list_account_tombstones()) == 1
        # 恢复：数据 + 注册表条目全回
        r = client.post(f"/api/trash/accounts/{stone}/restore")
        assert r.status_code == 200 and r.json()["id"] == "dave"
        assert (accounts.resolve_paths("dave").kv_dir / "k.json").exists()
        entry = accounts.load_registry()["dave"]
        assert entry["name"] == "呆夫" and entry["allowBrowse"] is True and entry["createdAt"] == created_at
        assert trash.list_account_tombstones() == []
        # 恢复后再删：新墓碑可再次恢复（id 不变，命名空间无缝）
        client.post("/api/accounts/delete", json={"account_id": "dave", "delete_data": True})
        stones = trash.list_account_tombstones()
        assert len(stones) == 1 and trash.restore_account_tombstone(stones[0]["stone"]) == "dave"


def test_accounts_route_delete_trash_off_purges_immediately(acc_env):
    """保留天数 0（回收站关闭）＝删除即彻底清除，不留墓碑（与画布同口径；
    curl 直调不带 query 时按目标账号自身设置算天数）。"""
    accounts.ensure_account("default")
    _make("henry")
    kv_dir = accounts.resolve_paths("henry").kv_dir
    kv_dir.mkdir(parents=True, exist_ok=True)
    (kv_dir / "k.json").write_text("{}", encoding="utf-8")
    trash.set_retention_days("henry", 0)
    with _client(acc_env) as client:
        r = client.post("/api/accounts/delete", json={"account_id": "henry", "delete_data": True})
        assert r.status_code == 200 and r.json()["inTrash"] is False
        assert not (accounts.users_dir() / "henry").exists()
        assert trash.list_account_tombstones() == []


def test_trash_account_purge_route(acc_env):
    """墓碑彻底删除：200 后目录消失；再删 404。"""
    accounts.ensure_account("default")
    _make("iris")
    stone = trash.capture_account("iris", accounts.get_account("iris"), 7)
    assert stone
    with _client(acc_env) as client:
        assert client.delete(f"/api/trash/accounts/{stone}").status_code == 200
        assert client.delete(f"/api/trash/accounts/{stone}").status_code == 404
    assert not (trash.account_tombstone_dir() / stone).exists()


def test_account_restore_conflict_when_target_exists(acc_env):
    """恢复前防御性检查：目标目录已存在 → TrashConflictError，墓碑原样保留
    可重试。ensure 已被墓碑闸门拦住不会复活目录，这里手动建目标目录——
    防御检查本身保留，防的是未来新出现的复活路径。"""
    accounts.ensure_account("default")
    _make("eve")
    entry = accounts.get_account("eve")
    stone = trash.capture_account("eve", entry, 7)
    assert stone
    (accounts.users_dir() / "eve").mkdir(parents=True)
    with pytest.raises(trash.TrashConflictError):
        trash.restore_account_tombstone(stone)
    assert (trash.account_tombstone_dir() / stone / "meta.json").exists()


def test_account_restore_conflict_when_registry_entry_exists(acc_env):
    """恢复前防御性检查（T191）：同 id 账号已新建（注册表有条目，目录可以不在）
    → TrashConflictError，不得让 restore_entry 静默覆盖新账号的注册表条目；
    条目与墓碑原样不动。"""
    accounts.ensure_account("default")
    _make("eve")
    entry = dict(accounts.get_account("eve"))
    accounts.remove_account("eve")
    stone = trash.capture_account("eve", entry, 7)
    assert stone
    accounts.register_account("eve", name="新夏娃")  # 撞 id 新建（只有条目，未 ensure 目录）
    with pytest.raises(trash.TrashConflictError):
        trash.restore_account_tombstone(stone)
    assert accounts.get_account("eve")["name"] == "新夏娃"
    assert (trash.account_tombstone_dir() / stone / "meta.json").exists()


# ====== 只读查阅兜底闸门（P3：X-Phymathia-Readonly 中间件）======

def test_readonly_gate_blocks_mutations_with_header(acc_env):
    """带 X-Phymathia-Readonly 头的改写请求一律 403（白名单两条例外）；
    不带头不受影响（本地无认证，防的是前端漏闸不是手写 curl）。"""
    accounts.ensure_account("default")
    with _client(acc_env) as client:
        h = {"X-Phymathia-Readonly": "1"}
        # 改写请求 + 只读头 → 403
        assert client.post("/api/sessions", json={"id": "s1"}, headers=h).status_code == 403
        assert client.delete("/api/sessions", headers=h).status_code == 403
        assert client.put("/api/profile", json={}, headers=h).status_code == 403
        # 读请求 + 只读头 → 正常
        assert client.get("/api/sessions", headers=h).status_code == 200
        # 白名单读语义 POST：放行（models/list 缺 provider 会 400/422，但绝不是 403）
        r = client.post("/api/models/list", json={}, headers=h)
        assert r.status_code != 403
        # 同样的改写请求不带只读头 → 照常（礼节性隔离口径）
        assert client.post("/api/sessions", json={"id": "s1"}).status_code == 200
        # 非 /api/ 路径不拦（静态页面 POST 不存在，但别误伤 /v1/ 之外的未来路由判断）
        assert client.post("/health", headers=h).status_code == 405


def test_deleted_account_not_revived_by_late_requests(acc_env):
    """回归钉子（真机实操抓出）：删除页面 reload 的 beforeunload sendBeacon
    冲刷还带着已删账号的 account_id，ensure 不得把它在空目录上复活——
    否则注册表出幽灵条目、墓碑恢复撞 409。"""
    accounts.ensure_account("default")
    _make("peter")
    (accounts.resolve_paths("peter").kv_dir.mkdir(parents=True, exist_ok=True))
    with _client(acc_env) as client:
        assert client.post("/api/accounts/delete", json={"account_id": "peter", "delete_data": True}).status_code == 200
        accounts.ensure_account("peter")  # 模拟迟到请求过 ensure（不经请求咽喉的直调）
        assert "peter" not in accounts.load_registry()
        assert not (accounts.users_dir() / "peter").exists()
        stones = trash.list_account_tombstones()
        assert len(stones) == 1
        assert trash.restore_account_tombstone(stones[0]["stone"]) == "peter"
        assert "peter" in accounts.load_registry()


def test_has_account_tombstone_suffix_must_be_digits(acc_env):
    """墓碑目录名后缀必须纯数字（<id>_<时间戳>）：防下划线账号前缀互撞
    （peter_x 的墓碑不算 peter 的）。"""
    _make("peter")
    area = accounts.users_dir() / "_trash"
    (area / "peter_123").mkdir(parents=True)
    (area / "peter_x_456").mkdir(parents=True)
    assert accounts.has_account_tombstone("peter") is True
    assert accounts.has_account_tombstone("peter_x") is True
    assert accounts.has_account_tombstone("other") is False
    (area / "peter_123").rmdir()
    assert accounts.has_account_tombstone("peter") is False


def test_tombstoned_account_requests_get_404(acc_env):
    """回归钉子（真机抓出第二段）：kv_write 等存储原语自带 mkdir，绕过 ensure
    闸门把已删账号目录拼回来——_account_id 单一咽喉必须拦：已删账号的请求
    一律 404，目录不复活、注册表不出幽灵、恢复不撞 409。"""
    accounts.ensure_account("default")
    _make("peter")
    (accounts.resolve_paths("peter").kv_dir.mkdir(parents=True, exist_ok=True))
    with _client(acc_env) as client:
        assert client.post("/api/accounts/delete", json={"account_id": "peter", "delete_data": True}).status_code == 200
        # 迟到的写（任务列表 tasks:global 自动保存的路径）：404 且不建目录
        assert client.post("/api/kv/tasks%3Aglobal", json={"value": {}},
                           params={"account_id": "peter"}).status_code == 404
        # 迟到的读同样 404（明白话，静默回落 default 会错账）
        assert client.get("/api/sessions", params={"account_id": "peter"}).status_code == 404
        assert not (accounts.users_dir() / "peter").exists()
        assert "peter" not in accounts.load_registry()
        # 重复删（幂等）仍 200：删除路由内部走 _account_id_raw 不吃自家闸门
        assert client.post("/api/accounts/delete", json={"account_id": "peter", "delete_data": True}).status_code == 200
        # 恢复不撞 409
        stones = trash.list_account_tombstones()
        assert trash.restore_account_tombstone(stones[0]["stone"]) == "peter"
        assert client.get("/api/sessions", params={"account_id": "peter"}).status_code == 200


def test_purged_account_requests_get_404_no_ghost_revival(acc_env):
    """回归钉子（T186 2026-10-07）：保留天数 0 的即删／墓碑到期清理之后墓碑消失，
    残留页面（另一浏览器/另一标签还开着该账号）的定时自动保存曾把账号连目录带
    注册表条目一起复活成幽灵空账号（昵称回落为 id，看着像「账号还在、数据没了」）。
    现在的口径：账号存在＝注册表有条目——未登记且无墓碑一律 404，目录与注册表
    都不许被迟到请求拼回来。"""
    accounts.ensure_account("default")
    _make("peter")
    with _client(acc_env) as client:
        # 保留天数 0＝删除即彻底清除，不留墓碑（前端 fetch 包装恒带当前账号的
        # query account_id，删除路由按发起删除的账号算保留天数——直调要显式带）
        assert client.post("/api/trash/settings", json={"days": 0}).status_code == 200
        assert client.post("/api/accounts/delete", json={"account_id": "peter", "delete_data": True},
                           params={"account_id": "default"}).status_code == 200
        assert not accounts.has_account_tombstone("peter")
        assert not (accounts.users_dir() / "peter").exists()
        # 迟到的自动保存：kv 写（自带 mkdir 的存储原语）与 sessions 写都 404
        r = client.post("/api/kv/tasks%3Aglobal", json={"value": []}, params={"account_id": "peter"})
        assert r.status_code == 404
        assert r.headers.get("X-Phymathia-Account-Gone") == "1"
        assert client.post("/api/sessions", json={"sessions": {}}, params={"account_id": "peter"}).status_code == 404
        assert client.get("/api/sessions", params={"account_id": "peter"}).status_code == 404
        # 目录与注册表都没被拼回来（幽灵空账号的两个要件）
        assert not (accounts.users_dir() / "peter").exists()
        assert "peter" not in accounts.load_registry()
        assert [e["id"] for e in client.get("/api/accounts").json()["accounts"]] == ["default"]
        # 同 id 重新建号（显式路由）后照常可用——闸门只认「未登记」
        _make("peter")
        assert client.get("/api/sessions", params={"account_id": "peter"}).status_code == 200


def test_expired_tombstone_purge_then_requests_404(acc_env):
    """墓碑到期清理（含手动彻底删墓碑）之后同样不许复活：清理前墓碑闸门 404，
    清理后走「未登记」闸门 404，两条路径都不建目录不登记。"""
    accounts.ensure_account("default")
    _make("peter")
    with _client(acc_env) as client:
        assert client.post("/api/accounts/delete", json={"account_id": "peter", "delete_data": True}).status_code == 200
        stones = trash.list_account_tombstones()
        assert len(stones) == 1
        assert trash.purge_account_tombstone(stones[0]["stone"]) is None
        assert not accounts.has_account_tombstone("peter")
        assert client.post("/api/kv/tasks%3Aglobal", json={"value": []},
                           params={"account_id": "peter"}).status_code == 404
        assert not (accounts.users_dir() / "peter").exists()
        assert "peter" not in accounts.load_registry()


def test_registry_cache_tracks_external_edits(acc_env):
    """注册表读取缓存按 (路径, mtime_ns, size) 失效：外部手改 accounts.json
    （测试/运维/别的进程）必须被下一个请求看见——缓存不得把已删账号留成「仍登记」。"""
    accounts.ensure_account("default")
    _make("alice")
    assert accounts.is_registered("alice") is True
    reg = accounts.registry_path()
    data = json.loads(reg.read_text(encoding="utf-8"))
    data["accounts"] = [e for e in data["accounts"] if e.get("id") != "alice"]
    reg.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert accounts.is_registered("alice") is False
    # 反向：手写回条目也要立刻可见
    data["accounts"].append({"id": "alice", "name": "手写", "allowBrowse": False, "createdAt": 1})
    reg.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    assert accounts.is_registered("alice") is True


# ====== 只读查阅的 GET 副作用（T187 2026-10-07）======

def test_readonly_dashboard_skips_device_binding(acc_env):
    """查阅态打开画像面板不得把查阅者设备绑进被查阅账号（会挤占对方绑定上限、
    对方备份带走查阅者画像、对方彻底清除误删查阅者画像文件）；非查阅态照常登记。"""
    accounts.ensure_account("default")
    _make("bob")
    accounts.set_allow_browse("bob", True)
    with _client(acc_env) as client:
        h = {"X-Phymathia-Readonly": "1"}
        r = client.get("/api/profile/dashboard", params={"device_id": "dev_intruder", "account_id": "bob"}, headers=h)
        assert r.status_code == 200
        assert accounts.get_account("bob").get("devices") in (None, [])
        # 不带只读头＝正常使用：面板即归属登记点（新账号首次看面板即绑定）
        r = client.get("/api/profile/dashboard", params={"device_id": "dev_owner", "account_id": "bob"})
        assert r.status_code == 200
        assert accounts.get_account("bob")["devices"] == ["dev_owner"]


def test_readonly_export_blocked(acc_env):
    """查阅态整包导出被拒（403，2026-10-07 拍板）：allowBrowse 的礼节是只读查阅
    会话与知识，整包 .pmu 是把对方全部内容一次带走；同时不给对方账号登记设备。"""
    accounts.ensure_account("default")
    _make("bob")
    accounts.set_allow_browse("bob", True)
    with _client(acc_env) as client:
        h = {"X-Phymathia-Readonly": "1"}
        r = client.get("/api/backup/export", params={"device_id": "dev_intruder", "account_id": "bob"}, headers=h)
        assert r.status_code == 403
        assert accounts.get_account("bob").get("devices") in (None, [])
        # 非查阅态照常导出并登记归属
        r = client.get("/api/backup/export", params={"device_id": "dev_owner", "account_id": "bob"})
        assert r.status_code == 200
        assert accounts.get_account("bob")["devices"] == ["dev_owner"]
