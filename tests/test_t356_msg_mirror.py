"""T356 消息镜像缺口（2026-10-17 答辩后修复轮）：服务端给前端「消息文件在位」信号
＋消息保存接口真写语义。

背景：跨机迁移后旧会话「半空」——服务端消息镜像只覆盖 5/43，前端同步只拉不补、
保存接口对空推送/无增量也回 200（200≠已存），缺口画布两边齐空转。修复＝
GET /api/sessions 每条会话标注 msgSaved（messages/<sid>.json 是否存在），
POST messages 响应带 written（这轮真落盘了没有）。
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
from server import trash  # noqa: E402


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}
    yield tmp_path, accounts
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}


def _seed_session(sid, title="画布"):
    """直写 sessions.json（绕过路由），并失效读缓存——与 accounts 测试同口径。"""
    sessions_path = accounts.resolve_paths("default").sessions_path
    sessions_path.parent.mkdir(parents=True, exist_ok=True)
    data = json.loads(sessions_path.read_text(encoding="utf-8")) if sessions_path.exists() else {}
    data[sid] = {"id": sid, "title": title, "sessionId": sid, "createdAt": 1, "updatedAt": 1}
    sessions_path.write_text(json.dumps(data), encoding="utf-8")
    storage._invalidate_json_cache(sessions_path)


def _write_msgs(sid, msgs):
    path = storage._get_messages_path(sid, account="default")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(msgs), encoding="utf-8")
    storage._invalidate_json_cache(path)
    return path


# ====== GET /api/sessions 的 msgSaved 标注 ======

def test_get_sessions_annotates_msg_saved(acc_env):
    _, _ = acc_env
    _seed_session("sess_with_msgs")
    _seed_session("sess_without_msgs")
    _write_msgs("sess_with_msgs", [{"role": "user", "content": "在的", "timestamp": 1}])
    from fastapi.testclient import TestClient
    import main as main_mod
    with TestClient(main_mod.app, base_url="http://127.0.0.1") as client:
        data = client.get("/api/sessions").json()
    assert data["sess_with_msgs"]["msgSaved"] is True
    assert data["sess_without_msgs"]["msgSaved"] is False


def test_get_sessions_msgs_dir_missing_all_false(acc_env):
    _, _ = acc_env
    _seed_session("sess_lone")
    from fastapi.testclient import TestClient
    import main as main_mod
    with TestClient(main_mod.app, base_url="http://127.0.0.1") as client:
        data = client.get("/api/sessions").json()
    assert data["sess_lone"]["msgSaved"] is False


def test_get_sessions_annotation_does_not_poison_read_cache(acc_env):
    """标注必须落在拷贝上：_read_json_cached 的缓存对象不得被写入 msgSaved，
    否则下一轮读到脏结构、且别的消费方会看到不该有的字段。"""
    _, _ = acc_env
    _seed_session("sess_pure")
    from fastapi.testclient import TestClient
    import main as main_mod
    sessions_path = accounts.resolve_paths("default").sessions_path
    with TestClient(main_mod.app, base_url="http://127.0.0.1") as client:
        client.get("/api/sessions")
    cached = storage._read_json_cached(sessions_path, {})
    assert "msgSaved" not in cached["sess_pure"]


# ====== POST messages 的 written 真写语义 ======

def _client():
    from fastapi.testclient import TestClient
    import main as main_mod
    return TestClient(main_mod.app, base_url="http://127.0.0.1")


def test_save_messages_written_true_on_real_write(acc_env):
    _, _ = acc_env
    with _client() as client:
        r = client.post("/api/sessions/sess_w/messages",
                        json={"messages": [{"role": "user", "content": "你好", "timestamp": 1}]})
        assert r.status_code == 200
        assert r.json()["written"] is True
        # 原样重推（逐字相同＝合并无增量）：这次没有写盘
        r2 = client.post("/api/sessions/sess_w/messages",
                         json={"messages": [{"role": "user", "content": "你好", "timestamp": 1}]})
        assert r2.json()["written"] is False
        # 追加一条新消息：真写
        r3 = client.post("/api/sessions/sess_w/messages",
                         json={"messages": [
                             {"role": "user", "content": "你好", "timestamp": 1},
                             {"role": "assistant", "content": "答", "timestamp": 2},
                         ]})
        assert r3.json()["written"] is True
        assert len(json.loads(storage._get_messages_path("sess_w", account="default").read_text(encoding="utf-8"))) == 2


def test_save_messages_empty_push_never_writes(acc_env):
    """空推送不许建文件也不许清副本（09-20 拍板不许回退），written 如实报 False。"""
    _, _ = acc_env
    with _client() as client:
        r = client.post("/api/sessions/sess_empty/messages", json={"messages": []})
        assert r.status_code == 200
        assert r.json()["written"] is False
        assert not storage._get_messages_path("sess_empty", account="default").exists()


def test_save_messages_tombstoned_reports_written_false(acc_env):
    """墓碑窗口的推送静默不落盘（T271）：响应带 tombstoned＋written=False，
    前端与日志从此能看出「200 但没存」。"""
    _, _ = acc_env
    paths = accounts.resolve_paths("default")
    trash.tombstone_register(paths, ["sess_dead"], at_ms=9999999999999)
    with _client() as client:
        r = client.post("/api/sessions/sess_dead/messages",
                        json={"messages": [{"role": "user", "content": "复活失败", "timestamp": 1}]})
        assert r.status_code == 200
        body = r.json()
        assert body["tombstoned"] is True
        assert body["written"] is False
        assert not storage._get_messages_path("sess_dead", account="default").exists()
