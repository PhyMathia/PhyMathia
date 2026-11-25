"""backlog 553-557：删除/清空/回收站链的并发丢数据竞态回归。

钉死的修法（沿 T233「mutate＋空判＋unlink 整段持 _JSON_LOCK」先例，不发明新锁）：
- 553 单删链 capture→unlink→墓碑登记收进同一 _JSON_LOCK 临界区；
- 554 清空单画布消息链（capture→unlink→写 []）同款；
- 555 _restore_cleared_messages 空检查与回填整写同款（「活的优先」闭合）；
- 556 capture_session 复用同名回收站目录先清陈旧 payload；
- 557 _clear_all_io unlink 逐文件 try/OSError（对齐单删链口径）。

并发用例的确定性手法（test_trash.T524 用例同款纪律）：竞方走**真路由原语**
（独立线程＋独立事件循环，不做同线程再入——再入读到的是旧文件，不是生产
交错）；竞方线程先挂起等 `go`，删除链中段钩子到点放行（`go.set()`）再等竞方
合并完成（`done`）——修前无锁，竞窗确定性复现；修后整链持锁、钩子的有界
等待超时（＝窗口已闭合），竞方排到链后，被闸门如实拒收或在清空/回填之后
合并。修前必红 / 修后绿。
"""

import asyncio
import json
import os
import sys
import threading
from pathlib import Path

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server import accounts, session_routes, storage, trash  # noqa: E402
from server import config as config_mod  # noqa: E402


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    """DATA_DIR 指向临时目录 + 清 ensure/注册表缓存（与 test_accounts 同款）。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}
    yield tmp_path
    accounts._ENSURED.clear()
    accounts._REGISTRY_CACHE["key"] = None
    accounts._REGISTRY_CACHE["entries"] = {}


def _msg(content, ts):
    return {"role": "user", "content": content, "timestamp": ts}


def _seed_session(sid, title="竞态画布"):
    """种一个最小会话：名单条目＋一条旧消息。返回 paths。"""
    paths = accounts.resolve_paths()
    paths.root.mkdir(parents=True, exist_ok=True)
    paths.messages_dir.mkdir(parents=True, exist_ok=True)
    paths.kv_dir.mkdir(parents=True, exist_ok=True)
    now = 1_700_000_000_000
    storage._write_json(paths.sessions_path, {
        sid: {"id": sid, "title": title, "sessionId": "",
              "createdAt": now, "updatedAt": now},
    })
    storage._write_json(paths.messages_dir / f"{sid}.json", [_msg("删前旧消息M1", 1000)])
    return paths


def _fake_request(payload):
    """直调路由用裸 Request（星号协议最小 scope＋一次性 body）。"""
    from starlette.requests import Request

    async def receive():
        return {"type": "http.request",
                "body": json.dumps(payload).encode("utf-8"), "more_body": False}

    scope = {"type": "http", "method": "POST", "path": "/",
             "query_string": b"", "headers": []}
    return Request(scope, receive)


def _push_in_thread(sid, body, go, done, result):
    """竞方推送：独立线程＋独立事件循环走**真路由**（真闸门真合并），不做同
    线程再入。先挂起等 `go`（删除链钩子到点放行）再进场，保证落点在竞窗内。
    结束（含异常）必置 done。"""
    def _run():
        try:
            assert go.wait(timeout=10), "钩子未放行"
            from fastapi import Response
            resp = Response()
            result["resp"] = asyncio.run(
                session_routes.api_save_messages(sid, _fake_request(body), resp))
        except Exception as e:  # noqa: BLE001 - 测试要的是结果不是中断
            result["error"] = e
        finally:
            done.set()

    t = threading.Thread(target=_run)
    t.start()
    return t


def _snapshot_msgs(paths, sid):
    return storage._read_json(trash.trash_root(paths) / sid / "messages.json", [])


# ====== 553：单删链 capture→unlink→墓碑登记 × 并发 POST /messages ======

def test_single_delete_vs_concurrent_message_push(acc_env, monkeypatch):
    """删除窗口内并发推送不得被无声吞掉：修前「合并落在 capture 后 → 被 unlink
    销毁且不在快照、响应还报 written=True」（丢数据）；修后整链持锁，推送排队
    到登记之后被墓碑闸门如实拒收（tombstoned=True、无孤儿消息文件），推送结局
    不变式「进快照 / 落活文件 / 如实拒收」三占其一恒成立。"""
    sid = "sess_r553"
    paths = _seed_session(sid)
    msgs_path = paths.messages_dir / f"{sid}.json"

    go, done, result = threading.Event(), threading.Event(), {}
    _push_in_thread(sid, {"messages": [_msg("并发新消息M2", 2000)]}, go, done, result)

    real_purge = session_routes._purge_dangling_continent_edges

    def racing_purge(s, account=accounts.DEFAULT_ACCOUNT):
        # 删除链走到断桥清理这一步（capture 已完成、unlink 未到）放竞方进场。
        # 修后整链持锁：竞方卡在锁上，这里有界等待超时＝窗口已闭合（2s 只在
        # 修后路径付一次；修前竞方毫秒级完成、等待立即返回）。
        go.set()
        done.wait(timeout=2.0)
        return real_purge(s, account)

    monkeypatch.setattr(session_routes, "_purge_dangling_continent_edges", racing_purge)

    session_routes._delete_session_sync(paths, accounts.DEFAULT_ACCOUNT, sid, msgs_path)

    assert go.is_set()
    assert done.wait(timeout=10), "竞方推送线程未结束"
    assert "error" not in result, result.get("error")
    resp = result["resp"]
    # 旧消息无论如何必须在快照里（可恢复是删除链的底线）
    assert any(m.get("timestamp") == 1000 for m in _snapshot_msgs(paths, sid))
    in_snapshot = any(m.get("timestamp") == 2000 for m in _snapshot_msgs(paths, sid))
    in_live = any(m.get("timestamp") == 2000
                  for m in storage._read_json(msgs_path, []))
    honestly_rejected = resp.get("tombstoned") is True
    # 不变式：并发推送的结局只能是三者之一，不许「响应说写成功了、数据却没了」
    assert in_snapshot or in_live or honestly_rejected
    # 修后形态：推送排队到登记之后 → 闸门如实拒收，无孤儿消息文件
    assert honestly_rejected
    assert not msgs_path.exists()
    assert sid in trash.tombstone_read(paths)


# ====== 554：清空单画布消息 unlink+写 [] × 并发 POST /messages ======

def test_clear_messages_vs_concurrent_push(acc_env, monkeypatch):
    """清空与并发推送竞态：修前推送在锁内读到旧全量后放锁，清空的 unlink＋[]
    插队进来，推送再把旧全量写回被 [] 整写抹掉（并发推上的消息蒸发、不在快照）；
    修后整链持锁，推送排队到清空之后、合并在 [] 上做 → 新消息存活。"""
    sid = "sess_r554"
    paths = _seed_session(sid)
    msgs_path = paths.messages_dir / f"{sid}.json"

    go, done, result = threading.Event(), threading.Event(), {}
    _push_in_thread(sid, {"messages": [_msg("清空后推的新消息M2", 2000)]}, go, done, result)

    real_capture = trash.capture_cleared_messages

    def racing_capture(paths_, sid_, messages_path=None):
        # 清空链走到快照之后放竞方进场（unlink 未到）；修后锁被本链持有，
        # 竞方排队到链后，有界等待超时＝窗口已闭合。
        r = real_capture(paths_, sid_, messages_path=messages_path)
        go.set()
        done.wait(timeout=2.0)
        return r

    monkeypatch.setattr(trash, "capture_cleared_messages", racing_capture)

    asyncio.run(session_routes.api_clear_messages(sid, None))

    assert go.is_set()
    assert done.wait(timeout=10), "竞方推送线程未结束"
    assert "error" not in result, result.get("error")
    # 旧消息在快照里（可恢复是清空链的底线）
    item_dirs = [d for d in trash.trash_root(paths).iterdir()
                 if d.name.startswith(f"{sid}__m")]
    assert len(item_dirs) == 1
    snap = storage._read_json(item_dirs[0] / "messages.json", [])
    assert any(m.get("timestamp") == 1000 for m in snap)
    # 修后形态：推送排在清空之后，合并在 [] 上 → 新消息存活
    live = storage._read_json(msgs_path, [])
    assert any(m.get("timestamp") == 2000 for m in live), \
        f"清空后并发推上的消息丢了：live={live}"


# ====== 555：_restore_cleared_messages 空检查→回填整写 × 并发 POST /messages ======

def test_restore_cleared_vs_concurrent_push(acc_env, monkeypatch):
    """恢复清空快照的检查-后-行动竞态：修前空检查在锁外、回填整写单独拿锁，
    检查通过后并发推上的新消息被快照整写覆盖（「活的优先」自述口径被违背）；
    修后检查＋回填同锁段，推送排队到回填之后、合并在快照上做 → 快照与新消息共存。"""
    sid = "sess_r555"
    paths = _seed_session(sid)
    msgs_path = paths.messages_dir / f"{sid}.json"
    # 先用真清空链造一个 kind=messages 回收站条目（快照 M1、活文件清成 []）
    asyncio.run(session_routes.api_clear_messages(sid, None))
    items = trash.list_items(paths)
    assert len(items) == 1 and items[0]["kind"] == "messages"
    item_key = items[0]["key"]

    go, done, result = threading.Event(), threading.Event(), {}
    _push_in_thread(sid, {"messages": [_msg("恢复窗口推的新消息M2", 2000)]}, go, done, result)

    real_payload = trash._restore_payload_data

    def racing_payload(paths_, item_dir, sid_):
        # 回填前放竞方进场（空检查已过、整写未到）；修后同锁段持有中，
        # 竞方排队到回填之后，有界等待超时＝窗口已闭合。
        go.set()
        done.wait(timeout=2.0)
        return real_payload(paths_, item_dir, sid_)

    monkeypatch.setattr(trash, "_restore_payload_data", racing_payload)

    assert trash.restore_item(paths, item_key) == sid

    assert go.is_set()
    assert done.wait(timeout=10), "竞方推送线程未结束"
    assert "error" not in result, result.get("error")
    live = storage._read_json(msgs_path, [])
    stamps = {m.get("timestamp") for m in live}
    # 修后形态：快照回填＋并发新消息共存（回填不许覆盖检查之后写入的活消息）
    assert 1000 in stamps, f"快照没回填：live={live}"
    assert 2000 in stamps, f"检查后并发推上的新消息被回填覆盖了：live={live}"


# ====== 556：capture_session 复用同名回收站目录不清陈旧 payload ======

def test_capture_wipes_stale_payload_from_aborted_capture(acc_env, monkeypatch):
    """删除链中止留下的半态回收站目录，再次删除时旧 payload 不得残留：
    修前按名逐个覆盖、本轮捕不到的数据保留上一轮旧文件，恢复时 setdefault
    把用户已明确清掉的知识复活；修后复用同名目录先整清再重建。"""
    sid = "sess_r556"
    paths = _seed_session(sid)
    storage._write_json(paths.knowledge_path, {
        "k1": {"title": "第一轮的知识", "sessionId": sid},
    })
    storage._write_json(paths.formulas_path, {
        "f1": {"latex": "F=ma", "sessionId": sid},
    })

    # 第一轮 capture 中止在公式写盘处（半态目录：session/messages/knowledge 落了、
    # 无 meta＝不构成条目；真实删除链会因此 500 中止，目录残留）
    real_write = storage._write_json
    state = {"aborted": False}
    item_dir = trash.trash_root(paths) / sid

    def aborting_write(path, data):
        if not state["aborted"] and path.parent == item_dir and path.name == "formulas.json":
            state["aborted"] = True
            raise OSError("模拟删除链中止")
        return real_write(path, data)

    monkeypatch.setattr(storage, "_write_json", aborting_write)
    with pytest.raises(OSError):
        trash.capture_session(paths, sid)
    assert not (item_dir / "meta.json").exists()
    assert (item_dir / "knowledge.json").exists()  # 半态残留就位

    # 用户在两次删除之间清掉了知识与消息（明确不要这些内容）
    storage._write_json(paths.knowledge_path, {})
    storage._write_json(paths.messages_dir / f"{sid}.json", [])

    # 再次删除：capture 完整成功（本轮知识已空、捕不到 k1）
    assert trash.capture_session(paths, sid) is True
    meta = storage._read_json(item_dir / "meta.json", {})
    assert meta.get("counts", {}).get("knowledge") == 0

    # 模拟删除链后半段：capture 本身不删名单，真实删除链随后会移除条目
    def _drop(data):
        data.pop(sid, None)
        return data

    storage._mutate_json(paths.sessions_path, _drop)

    # 恢复 → 修前 stale knowledge.json 的 k1 被 setdefault 回写复活
    assert trash.restore_item(paths, sid) == sid
    knowledge = storage._read_json(paths.knowledge_path, {})
    assert knowledge == {}, \
        f"用户已明确清掉的知识被陈旧 payload 复活了：{knowledge}"
    formulas = storage._read_json(paths.formulas_path, {})
    assert "f1" in formulas  # 对照：用户没清过的数据照常随快照回写


# ====== 557：_clear_all_io 的 unlink 裸调用无容错 ======

def test_clear_all_io_survives_unlink_failure(acc_env, monkeypatch):
    """清空全部的批量 unlink 对单个文件失败（Windows 占用/权限）要逐文件容错：
    修前裸 unlink 一个 OSError 让整段 500，留下「名单已抹＋墓碑已登记 / 资料
    半清」无法靠同步收敛的半清态；修后对齐单删链口径——单文件失败只告警，
    清空语义（名单空＋墓碑在）不变，best-effort 完成。"""
    paths = _seed_session("sess_r557x", title="占用画布")
    # 再种一个不占用的会话：无论 glob 顺序如何，一个被清、一个模拟占用
    now = 1_700_000_000_000
    data = storage._read_json(paths.sessions_path, {})
    data["sess_r557y"] = {"id": "sess_r557y", "title": "陪跑画布", "sessionId": "",
                          "createdAt": now, "updatedAt": now}
    storage._write_json(paths.sessions_path, data)
    storage._write_json(paths.messages_dir / "sess_r557y.json", [_msg("陪跑消息", 1001)])

    real_unlink = Path.unlink
    target = paths.messages_dir / "sess_r557x.json"

    def picky_unlink(self, missing_ok=False):
        if self == target:
            raise OSError("模拟 Windows 文件占用")
        return real_unlink(self, missing_ok)

    monkeypatch.setattr(Path, "unlink", picky_unlink)

    # 修前：OSError 从 _clear_all_io 穿出（路由层 500）；修后：容错走完
    asyncio.run(session_routes.api_clear_all_sessions(None))

    # 名单已抹、墓碑已登记（删除语义不受单文件失败拖累）
    assert storage._read_json(paths.sessions_path, {}) == {}
    deleted = trash.tombstone_read(paths)
    assert {"sess_r557x", "sess_r557y"} <= set(deleted)
    # best-effort：没被占用的文件照常清掉，被占用的留下（与单删链同款容忍；
    # 墓碑在＝旧副本推不回，残留孤儿文件无引用不复活）
    assert not (paths.messages_dir / "sess_r557y.json").exists()
    assert target.exists()
