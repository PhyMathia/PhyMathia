"""T237–T240 销账回归（2026-10-09 体检 backlog 余项）。

- T240：knowledge/session 路由里残存的同步 `_mutate_json` 与 GET 读路径整体
  挪进 `asyncio.to_thread`（T201 首波只覆盖消息/批量 KV/大陆本体）。钉法：
  ① 线程身份——补丁记录 `_mutate_json`/`_json_get_payload` 实际运行的线程，
  必须不是事件循环线程（旧代码就地跑，断言红）；② 循环不被堵——写盘期间
  并发 ticker 必须持续被让渡（旧代码整段 sleep 压循环，ticker 零次，断言红）。
- T238：accounts 注册表缓存的「两步更新」与「两步读取」加 `_LOCK` 互斥。
  钉法：挂起 dict 的 `__setitem__('key')`，在 key 落地、entries 未换的窗口放
  一个真实并发读者——旧代码读者比中新文件指纹却拿走旧条目表（刚登记的账号
  在幽灵闸门里查无此人），新代码读者被锁挡到更新完成后拿到新表。
"""

import asyncio
import os
import sys
import threading
import time

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
from server import knowledge_routes  # noqa: E402
from server import session_routes  # noqa: E402
from server import storage  # noqa: E402


class _FakeRequest:
    """直调路由层函数的假请求：json() 回 payload；headers 供 ETag 协商读；
    query_params 缺失被 _account_id_raw 的 try/except 吞掉，账号落 default。
    （test_formula_timestamps.py 同款，补 headers）"""

    def __init__(self, body=None, headers=None):
        self._body = body
        self.headers = headers or {}

    async def json(self):
        return self._body


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    """DATA_DIR 指向临时目录 + 清 ensure 缓存；yield default 账号路径组。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    yield accounts.ensure_account("default")
    accounts._ENSURED.clear()


class _ThreadSpy:
    """记录被补丁函数实际运行的线程（配合 asyncio.run 捕获循环线程）。"""

    def __init__(self, real):
        self._real = real
        self.loop_thread = None
        self.run_thread = None
        self.calls = 0

    def __call__(self, *args, **kwargs):
        self.run_thread = threading.current_thread()
        self.calls += 1
        return self._real(*args, **kwargs)


# ====== T240：阻塞 IO 离开事件循环 ======

def test_post_formulas_mutate_runs_off_event_loop(acc_env, monkeypatch):
    spy = _ThreadSpy(knowledge_routes._mutate_json)
    monkeypatch.setattr(knowledge_routes, "_mutate_json", spy)
    spy.loop_thread = threading.current_thread()

    result = asyncio.run(knowledge_routes.api_save_formulas(_FakeRequest(
        {"items": [{"latex": "F=ma", "concept": "牛顿第二定律"}]})))

    assert result["ok"] and result["count"] == 1
    assert spy.calls == 1
    assert spy.run_thread is not spy.loop_thread, "POST /api/formulas 的 _mutate_json 仍在事件循环线程上"
    # 行为不回退：公式真的落了盘
    assert "F=ma" in str(storage._read_json(acc_env.formulas_path, {}))


def test_get_formulas_payload_runs_off_event_loop(acc_env, monkeypatch):
    storage._write_json(acc_env.formulas_path,
                        {"f1": {"id": "f1", "latex": "E=mc^2", "createdAt": 1}})
    spy = _ThreadSpy(knowledge_routes._json_get_payload)
    monkeypatch.setattr(knowledge_routes, "_json_get_payload", spy)
    spy.loop_thread = threading.current_thread()

    resp = asyncio.run(knowledge_routes.api_get_formulas(_FakeRequest(headers={})))

    assert resp.status_code == 200
    assert b"E=mc^2" in resp.body
    assert spy.calls == 1
    assert spy.run_thread is not spy.loop_thread, "GET /api/formulas 的读盘＋去重仍在事件循环线程上"


def test_post_sessions_mutate_runs_off_event_loop(acc_env, monkeypatch):
    spy = _ThreadSpy(session_routes._mutate_json)
    monkeypatch.setattr(session_routes, "_mutate_json", spy)
    spy.loop_thread = threading.current_thread()

    result = asyncio.run(session_routes.api_save_sessions(
        _FakeRequest({"s1": {"title": "画布一"}})))

    assert result["ok"] and result["count"] == 1
    assert spy.calls == 1
    assert spy.run_thread is not spy.loop_thread, "POST /api/sessions 的 _mutate_json 仍在事件循环线程上"
    assert "s1" in storage._read_json(acc_env.sessions_path, {})


def test_event_loop_not_blocked_during_slow_formula_write(acc_env, monkeypatch):
    """行为钉：慢写盘（挂起模拟持锁大文件写）期间事件循环必须保持响应——
    旧代码同步执行时并发 ticker 一次都跑不到，全服务请求一起停摆。"""
    real = knowledge_routes._mutate_json

    def slow(path, updater, default=None):
        time.sleep(0.3)
        return real(path, updater, default)

    monkeypatch.setattr(knowledge_routes, "_mutate_json", slow)

    async def main():
        task = asyncio.create_task(knowledge_routes.api_save_formulas(
            _FakeRequest({"items": [{"latex": "F=ma"}]})))
        ticks = 0

        async def ticker():
            nonlocal ticks
            while not task.done():
                ticks += 1
                await asyncio.sleep(0.01)

        await asyncio.gather(task, ticker())
        return ticks

    ticks = asyncio.run(main())
    assert ticks > 5, f"写盘 0.3s 内循环只被让渡 {ticks} 次（旧代码恒为 0）"
    assert "F=ma" in str(storage._read_json(acc_env.formulas_path, {}))


# ====== T238：注册表缓存撕裂读 ======

class _TornCache(dict):
    """在 `__setitem__("key", ...)` 落地后触发挂起的读者——复现两步更新
    「新文件指纹已入缓存、entries 还是旧表」的中间态。"""

    def __init__(self):
        super().__init__({"key": None, "entries": {}})
        self.on_key_write = None

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        if key == "key" and self.on_key_write is not None:
            self.on_key_write()


def test_registry_save_load_roundtrip_through_locks(monkeypatch, tmp_path):
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    monkeypatch.setattr(accounts, "_REGISTRY_CACHE", {"key": None, "entries": {}})

    accounts.save_registry({"a": {"id": "a", "name": "甲"}})
    assert accounts.load_registry() == {"a": {"id": "a", "name": "甲"}}
    accounts.save_registry({"a": {"id": "a", "name": "甲"}, "b": {"id": "b"}})
    assert set(accounts.load_registry()) == {"a", "b"}
    assert accounts.is_registered("b")


def test_register_account_survives_reentrant_locks(monkeypatch, tmp_path):
    """register_account 外层持 _LOCK 再调 load/save（RLock 可重入）——
    加锁后这条既有路径必须照常工作。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    monkeypatch.setattr(accounts, "_REGISTRY_CACHE", {"key": None, "entries": {}})

    entry = accounts.register_account("tom", "汤姆")
    assert entry["name"] == "汤姆"
    assert accounts.is_registered("tom")
    assert accounts.get_account("tom")["name"] == "汤姆"


def test_registry_cache_never_serves_torn_pair(monkeypatch, tmp_path):
    """并发读者在 save_registry 换 key 之后、换 entries 之前到达：
    旧代码读者比中新文件指纹却拿走旧条目表（=刚登记的账号幽灵闸门 404）；
    新代码读者被 _LOCK 挡到两步都落地后才读，拿到新表。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    cache = _TornCache()
    monkeypatch.setattr(accounts, "_REGISTRY_CACHE", cache)

    accounts.save_registry({"a": {"id": "a"}})

    seen = []
    writer_parked = threading.Event()
    reader_done = threading.Event()
    hook_result = []

    def reader():
        writer_parked.wait(5)
        try:
            seen.append(dict(accounts.load_registry()))
        finally:
            reader_done.set()

    def hook():
        writer_parked.set()
        hook_result.append(reader_done.wait(0.5))

    threading.Thread(target=reader, daemon=True).start()
    cache.on_key_write = hook
    accounts.save_registry({"a": {"id": "a"}, "b": {"id": "b"}})

    # 0.5s 窗口内读者必须仍未读完：锁把它挡在整个两步更新之外，
    # 而不是放进「新指纹＋旧条目」的中间态（旧代码这里 reader_done 已置位）
    assert hook_result == [False], "读者在两步更新中间读到了缓存（撕裂窗口未被锁覆盖）"
    assert reader_done.wait(5), "并发读者未能完成（死锁？）"
    assert "b" in seen[0], "读者拿到新文件指纹却读到旧条目表（撕裂读）"
