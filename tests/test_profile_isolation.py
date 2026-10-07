"""学习画像按账号隔离（2026-10-07）：账号↔设备绑定、备份圈定、彻底清除连画像。

画像归因键保持 device_id（P1 拍板不回退账号），文件仍在 data/profiles/；
「按账号隔离」靠注册表 entry.devices 的归属快照在边界处圈定：
- 备份导出只带走本账号归属的设备画像（旧口径全量打包＝A 的备份带走 B 的画像）；
- 备份导入 replace 只清本账号的画像文件、备份里他账设备不写回（旧口径＝
  A 恢复备份把 B 的画像回滚到快照时刻）；
- 删账号彻底清除（保留天数 0 / 墓碑到期 / 墓碑手动彻底删）连画像一起删；
  墓碑保留期内画像原地不动（恢复后同命名空间同 device 无缝重连）。
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

from server import accounts, backup, storage, trash  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
import main as main_mod  # noqa: E402


@pytest.fixture
def env(tmp_path, monkeypatch):
    """DATA_DIR + 画像目录重定向到临时目录（backup/profile 是 from-import，
    命名空间里的 PROFILES_DIR 要分别补丁）；清 ensure/注册表与 JSON 读缓存。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    profiles_dir = tmp_path / "profiles"
    profiles_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(profile_mod, "PROFILES_DIR", profiles_dir)
    monkeypatch.setattr(backup, "PROFILES_DIR", profiles_dir)
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}
    storage._JSON_READ_CACHE.clear()
    yield tmp_path, profiles_dir
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}
    storage._JSON_READ_CACHE.clear()


def _make(account, name=None):
    """建账号的显式两步（2026-10-07 T186 起 ensure_account 不再自动登记非
    default 账号）：先登记再 ensure，与生产路径（POST /api/accounts）同序同果。"""
    accounts.register_account(account, name=name)
    return accounts.ensure_account(account, name=name)


def _write_device_profile(profiles_dir, dev, payload):
    (profiles_dir / f"{dev}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8")


def _read_device_profile(profiles_dir, dev):
    path = profiles_dir / f"{dev}.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


# ====== 绑定登记（归属快照的生长规则） ======

def test_note_device_binding_validates_input(env):
    tmp_path, _ = env
    accounts.register_account("alice")
    profile_mod.note_device_binding("dev_abc123", account="alice")
    assert accounts.account_devices("alice") == ["dev_abc123"]
    # 空 / 含路径字符 / 超长：宁可不绑（折叠后无法反查原始值，不误绑）
    for bad in ("", None, "a/b", "..", "x" * 65, "设备"):
        profile_mod.note_device_binding(bad, account="alice")
    assert accounts.account_devices("alice") == ["dev_abc123"]
    # 未登记的账号不凭空建条目
    profile_mod.note_device_binding("dev_ghost", account="nobody")
    assert accounts.get_account("nobody") == {}
    # 幂等：重复登记不写盘不改序
    profile_mod.note_device_binding("dev_abc123", account="alice")
    assert accounts.account_devices("alice") == ["dev_abc123"]


def test_add_account_devices_cap_drops_oldest(env):
    accounts.register_account("alice")
    devices = [f"dev_{i}" for i in range(10)]
    for d in devices:
        assert accounts.add_account_devices("alice", [d]) is True
    kept = accounts.account_devices("alice")
    # 上限 8 丢最旧：dev_0/dev_1 被挤掉，其余保序
    assert kept == devices[2:]
    # 已在册时再并＝无写入
    assert accounts.add_account_devices("alice", ["dev_5"]) is False


def test_record_implicit_event_binds_device(env):
    accounts.register_account("alice")
    profile_mod.record_implicit_event(
        "dev_live", [{"type": "expand", "topic": "力学"}], account="alice")
    assert "dev_live" in accounts.account_devices("alice")


# ====== 备份导出圈定 ======

def test_export_scoped_to_account_devices(env):
    tmp_path, profiles_dir = env
    accounts.register_account("alice")
    accounts.register_account("bob")
    accounts.add_account_devices("alice", ["dev_a1"])
    accounts.add_account_devices("bob", ["dev_b1"])
    _write_device_profile(profiles_dir, "dev_a1", {"enabled": True})
    _write_device_profile(profiles_dir, "dev_b1", {"enabled": True})
    # alice 的备份只带 alice 的设备画像（旧口径会把 dev_b1 一并带走）
    payload = backup._build_backup_payload("alice")
    assert set(payload["profiles"].keys()) == {"dev_a1"}
    # 请求设备提示即时生效（未绑定的新设备也计入圈定）
    _write_device_profile(profiles_dir, "dev_a2", {"enabled": True})
    payload = backup._build_backup_payload("alice", device_id="dev_a2")
    assert set(payload["profiles"].keys()) == {"dev_a1", "dev_a2"}


def test_export_legacy_fallback_without_binding(env):
    tmp_path, profiles_dir = env
    accounts.register_account("alice")
    _write_device_profile(profiles_dir, "dev_x", {"enabled": True})
    _write_device_profile(profiles_dir, "dev_y", {"enabled": True})
    # 无绑定且无设备提示＝归属完全未知，回退旧口径全量（兼容 curl 直调/存量测试）
    payload = backup._build_backup_payload("alice")
    assert set(payload["profiles"].keys()) == {"dev_x", "dev_y"}


# ====== 备份导入圈定（replace 不波及邻账号＝立项主断言） ======

def test_import_replace_keeps_neighbor_profiles(env):
    tmp_path, profiles_dir = env
    _make("alice")
    _make("bob")
    accounts.add_account_devices("alice", ["dev_a1"])
    accounts.add_account_devices("bob", ["dev_b1"])
    _write_device_profile(profiles_dir, "dev_a1", {"enabled": True})
    _write_device_profile(profiles_dir, "dev_b1", {"enabled": True})
    before_bob = (profiles_dir / "dev_b1.json").read_text(encoding="utf-8")
    backup_payload = {
        "sessions": {},
        "messages": {},
        "profiles": {"dev_a1": {"enabled": False}},
    }
    result = backup._restore_backup(backup_payload, replace=True, account="alice")
    assert result["profiles"] == 1
    # 邻账号画像原样（旧口径 replace 会先全删 data/profiles/*.json 再写回备份内容）
    assert (profiles_dir / "dev_b1.json").read_text(encoding="utf-8") == before_bob
    # 本账号设备被备份内容替换
    assert _read_device_profile(profiles_dir, "dev_a1")["enabled"] is False


def test_import_skips_stranger_devices(env):
    tmp_path, profiles_dir = env
    _make("alice")
    accounts.add_account_devices("alice", ["dev_a1"])
    _write_device_profile(profiles_dir, "dev_b1", {"enabled": True, "note": "原状"})
    before_bob = (profiles_dir / "dev_b1.json").read_text(encoding="utf-8")
    # 旧版全量备份里混着别的设备画像：不属于 alice，恢复时不写回
    backup_payload = {
        "sessions": {},
        "messages": {},
        "profiles": {"dev_b1": {"enabled": False}},
    }
    result = backup._restore_backup(backup_payload, replace=False, account="alice")
    assert result["profiles"] == 0
    assert (profiles_dir / "dev_b1.json").read_text(encoding="utf-8") == before_bob
    # 设备提示能把备份里的旧设备拉进圈定（同账号换浏览器后的旧备份仍可恢复）
    result = backup._restore_backup(backup_payload, replace=False, account="alice",
                                    device_id="dev_b1")
    assert result["profiles"] == 1
    assert _read_device_profile(profiles_dir, "dev_b1")["enabled"] is False


# ====== 删账号彻底清除连画像 ======

def test_purge_bound_profiles_removes_files_and_eval_trace(env):
    tmp_path, profiles_dir = env
    _write_device_profile(profiles_dir, "dev_a1", {"enabled": True})
    (profiles_dir / "dev_a1.eval.jsonl").write_text("{}", encoding="utf-8")
    _write_device_profile(profiles_dir, "dev_b1", {"enabled": True})
    removed = trash.purge_bound_profiles({"devices": ["dev_a1"]})
    assert removed == 2  # 画像 + 评估留痕
    assert not (profiles_dir / "dev_a1.json").exists()
    assert not (profiles_dir / "dev_a1.eval.jsonl").exists()
    assert (profiles_dir / "dev_b1.json").exists()  # 邻账号不动


def test_tombstone_purge_removes_profiles(env):
    tmp_path, profiles_dir = env
    _make("alice")
    accounts.add_account_devices("alice", ["dev_a1"])
    _write_device_profile(profiles_dir, "dev_a1", {"enabled": True})
    entry = accounts.get_account("alice")
    stone = trash.capture_account("alice", entry, days=7)
    assert stone is not None
    # 墓碑保留期内画像原地不动（恢复后同命名空间同 device 无缝重连）
    assert (profiles_dir / "dev_a1.json").exists()
    trash.purge_account_tombstone(stone)
    assert not (profiles_dir / "dev_a1.json").exists()
    assert not (tmp_path / "users" / "alice").exists()


def test_expired_tombstone_purge_removes_profiles(env):
    tmp_path, profiles_dir = env
    _make("alice")
    accounts.add_account_devices("alice", ["dev_a1"])
    _write_device_profile(profiles_dir, "dev_a1", {"enabled": True})
    entry = accounts.get_account("alice")
    stone = trash.capture_account("alice", entry, days=1)
    # 把 purgeAt 拨到过去，模拟保留期到期
    stone_dir = trash.account_tombstone_dir() / stone
    meta = json.loads((stone_dir / "meta.json").read_text(encoding="utf-8"))
    meta["purgeAt"] = 1
    (stone_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    assert trash.purge_expired_tombstones() == 1
    assert not (profiles_dir / "dev_a1.json").exists()


# ====== 路由端到端（device_id 圈定键随备份两路由透传） ======

def test_backup_routes_carry_device_id(env):
    tmp_path, profiles_dir = env
    from fastapi.testclient import TestClient
    accounts.register_account("alice")
    accounts.register_account("bob")
    accounts.add_account_devices("bob", ["dev_b1"])
    _write_device_profile(profiles_dir, "dev_a9", {"enabled": True})
    _write_device_profile(profiles_dir, "dev_b1", {"enabled": True})
    with TestClient(main_mod.app) as client:
        # 导出带 device_id：alice 未绑定也即时圈定 + 顺手登记绑定
        r = client.get("/api/backup/export",
                       params={"account_id": "alice", "device_id": "dev_a9"})
        assert r.status_code == 200
        assert set(r.json()["profiles"].keys()) == {"dev_a9"}
        assert accounts.account_devices("alice") == ["dev_a9"]
        # 导入 replace 带 device_id：只动 alice 的画像，bob 的原样
        before_bob = (profiles_dir / "dev_b1.json").read_text(encoding="utf-8")
        r = client.post("/api/backup/import", json={
            "account_id": "alice", "mode": "replace", "device_id": "dev_a9",
            "backup": {"sessions": {}, "messages": {},
                       "profiles": {"dev_a9": {"enabled": False}, "dev_b1": {"enabled": False}}},
        })
        assert r.status_code == 200
        body = r.json()
        assert body["ok"] is True
        assert body["profiles"] == 1  # dev_b1 是他账设备，被圈定滤掉
        assert _read_device_profile(profiles_dir, "dev_a9")["enabled"] is False
        assert (profiles_dir / "dev_b1.json").read_text(encoding="utf-8") == before_bob
