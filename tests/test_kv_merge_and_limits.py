"""backlog 527/529/530：KV 并发合并与写入上限定界回归。

钉死的修法（沿既有锁纪律与限流先例，不发明新锁/新体系）：
- 527 kv_restore_bulk「清层→重写整段」收进同一把 storage._JSON_LOCK——修前各步
  各自持锁，导入窗口期并发的 kv_write 会被组整写/清层无声抹掉（分裂文件走
  _mutate_json 合并幸存，主文件键整份蒸发）；
- 529 api_set_kv 对已知整表键（phymathia_quiz_stats / continent_edges）改服务端
  锁内合并（kv_mutate 同一临界区）：quiz_stats 镜像前端 _mergeQuizStats 语义
  （逐主题键并集、新者胜、_meta 清单并集去重）；continent_edges「含新增即并集、
  纯子集即删除」（客户端整表提交且删线是核心手势，无脑并集会让删除复活）。
  老客户端整值照发照落——它的整值只是合并的其中一方（向后兼容）；
- 530 写端点大小/条数上限：kv value 8MB 硬顶＋主文件键 512KB 拦截、sessions
  title/icon 截断、messages 条数硬顶＋单条正文截断、knowledge 条数硬顶＋单条
  丢弃、formulas 条数硬顶＋超长 latex 跳过。上限量级全部取「正常使用永远碰
  不到、只有失控写入才会撞」，参照系为代码内既有先例（kv 膨胀守卫 64KB/128KB、
  聊天附图 8M 字符、ingest 截断 8000 字）。

并发用例的确定性手法（test_clear_chain_concurrency 同款纪律）：竞方走真路由
原语（独立线程＋独立事件循环，不做同线程再入）；导入链中段钩子到点放行竞方
（go/done 时序桩）——修前竞窗确定性复现，修后竞方排队到临界区之后、有界等待
超时＝窗口已闭合。修前必红 / 修后绿。
"""

import asyncio
import json
import os
import sys
import threading

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from fastapi import HTTPException, Response  # noqa: E402
from starlette.requests import Request  # noqa: E402

from server import accounts, knowledge_routes, session_routes, storage  # noqa: E402
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


def _fake_request(payload):
    """直调路由用裸 Request（星号协议最小 scope＋一次性 body）。"""
    async def receive():
        return {"type": "http.request",
                "body": json.dumps(payload).encode("utf-8"), "more_body": False}

    scope = {"type": "http", "method": "POST", "path": "/",
             "query_string": b"", "headers": []}
    return Request(scope, receive)


def _rec(last, correct=1, wrong=0):
    # history 带与 correct/wrong 等量的作答事件（隐式画像差分按 history 回放）
    history = [{"correct": True, "at": last, "questionId": "q1", "difficulty": "medium"} for _ in range(correct)] + \
              [{"correct": False, "at": last, "questionId": "q1", "difficulty": "medium"} for _ in range(wrong)]
    return {"correct": correct, "wrong": wrong, "last": last, "topicKey": "t",
            "history": history, "reps": 0, "lapses": 0, "intervalDays": 1,
            "dueAt": 0, "ease": 2.5}


# ====== 527：kv_restore_bulk replace 清层→重写 × 并发 kv_write ======

def test_restore_bulk_replace_vs_concurrent_kv_write(acc_env, monkeypatch):
    """导入窗口期并发的 kv 写主文件键不得被整文件覆盖丢失：修前清层与组写入
    之间是裸窗口，竞方写进窗口即被组整写抹掉（响应无从感知）；修后整段持锁，
    竞方排队到导入完成后做锁内合并、必然存活。"""
    paths = accounts.resolve_paths()
    paths.kv_dir.mkdir(parents=True, exist_ok=True)
    paths.kv_meta_dir.mkdir(parents=True, exist_ok=True)
    backup = {
        "backup_global_key": {"note": "备份里的全局键"},
        "continent_edges": [{"id": "e_bk", "fromItem": "a", "toItem": "b"}],
    }
    go, done = threading.Event(), threading.Event()
    clear_seen = []
    real_write = storage._write_json

    def racing_write(path, data):
        # 钩子只认 replace 的清层写（主文件＋空 dict，且只认第一次）
        if path == paths.kv_path and data == {} and not clear_seen:
            clear_seen.append(True)
            go.set()
            # 修后：锁被导入链持有，竞方卡在锁上，这里的有界等待超时＝窗口闭合
            done.wait(timeout=2.0)
        return real_write(path, data)

    monkeypatch.setattr(storage, "_write_json", racing_write)

    def _restore():
        try:
            storage.kv_restore_bulk(backup, replace=True)
        except Exception as e:  # noqa: BLE001
            go.set()
            done.set()
            raise

    t = threading.Thread(target=_restore)
    t.start()
    assert go.wait(timeout=10), "清层钩子未触发"
    storage.kv_write("tasks:global", {"n": 1, "note": "导入窗口期的并发写"})
    done.set()
    t.join(timeout=10)
    assert not t.is_alive()
    assert clear_seen, "清层写未被钩子捕获（夹具失效）"
    # 备份键照常入库
    assert storage.kv_read("backup_global_key") == {"note": "备份里的全局键"}
    assert storage.kv_read("continent_edges") == backup["continent_edges"]
    # 并发写必须幸存（修前在这里被组整写抹掉）
    assert storage.kv_read("tasks:global") == {"n": 1, "note": "导入窗口期的并发写"}


def test_restore_bulk_replace_semantics_unchanged(acc_env):
    """replace 语义不因收锁而变：导入前已存在、备份里没有的键被如实抹掉。"""
    storage.kv_write("pre_existing_key", {"old": True})
    storage.kv_restore_bulk({"backup_global_key": 1}, replace=True)
    assert storage.kv_read("backup_global_key") == 1
    assert storage.kv_read("pre_existing_key") is None


def test_restore_bulk_merge_mode_keeps_concurrent_key(acc_env):
    """合并导入（replace=False）：存量键保留、备份键合并进主文件。"""
    storage.kv_write("kept_key", "kept")
    storage.kv_restore_bulk({"backup_global_key": 2}, replace=False)
    assert storage.kv_read("kept_key") == "kept"
    assert storage.kv_read("backup_global_key") == 2


# ====== 529（纯函数）：quiz_stats / continent_edges 合并语义 ======

def test_quiz_merge_unions_disjoint_topics():
    current = {"tA": _rec(1000)}
    incoming = {"tB": _rec(1000)}
    merged = session_routes._merge_quiz_stats_value(current, incoming)
    assert "tA" in merged and "tB" in merged


def test_quiz_merge_newer_record_wins_same_topic():
    current = {"tA": _rec(1000, correct=1, wrong=0)}
    incoming = {"tA": _rec(2000, correct=2, wrong=1)}
    merged = session_routes._merge_quiz_stats_value(current, incoming)
    assert merged["tA"]["correct"] == 2 and merged["tA"]["wrong"] == 1
    # 另一设备（incoming）更旧：留服务端现值
    merged2 = session_routes._merge_quiz_stats_value(current, {"tA": _rec(500, correct=9)})
    assert merged2["tA"]["correct"] == 1
    # 平局留服务端现值（前端 _mergeQuizStats 的「服务端赢平局」镜像）
    merged3 = session_routes._merge_quiz_stats_value(current, {"tA": _rec(1000, correct=9)})
    assert merged3["tA"]["correct"] == 1


def test_quiz_merge_meta_union_and_caps():
    current = {"_meta": {"attempts": 5, "updatedAt": 100,
                         "wrongQuestions": [
                             {"id": "q1", "prompt": "P1", "formulaText": "F1",
                              "options": [{"key": "A", "text": "对"}], "correctIndex": 0,
                              "wrongAt": 900},
                             {"id": "q2", "prompt": "P2", "formulaText": "",
                              "options": [], "correctIndex": -1, "wrongAt": 800},
                         ]}}
    incoming = {"_meta": {"attempts": 3, "updatedAt": 200,
                          "wrongQuestions": [
                              # 同身份（prompt|formulaText|正确项文本）较新的一条胜
                              {"id": "q1", "prompt": "P1", "formulaText": "F1",
                               "options": [{"key": "A", "text": "对"}], "correctIndex": 0,
                               "wrongAt": 950},
                              {"id": "q3", "prompt": "P3", "formulaText": "",
                               "options": [], "correctIndex": -1, "wrongAt": 700},
                          ]}}
    merged = session_routes._merge_quiz_stats_value(current, incoming)
    meta = merged["_meta"]
    assert meta["attempts"] == 5 and meta["updatedAt"] == 200
    keys = [session_routes._wrong_question_key(w) for w in meta["wrongQuestions"]]
    assert len(keys) == len(set(keys)) == 3  # q1 去重、q2/q3 保留
    q1 = next(w for w in meta["wrongQuestions"] if w["id"] == "q1")
    assert q1["wrongAt"] == 950  # 同身份较新的一条胜


def test_quiz_merge_meta_list_cap():
    many = [{"id": f"q{i}", "prompt": f"P{i}", "formulaText": "",
             "options": [], "correctIndex": -1, "wrongAt": i} for i in range(150)]
    merged = session_routes._merge_quiz_stats_value(
        {"_meta": {"wrongQuestions": many}}, {"_meta": {}})
    assert len(merged["_meta"]["wrongQuestions"]) == 100  # QUIZ_MAX_WRONG 同前端
    open_results = [{"id": f"o{i}", "at": i} for i in range(40)]
    merged2 = session_routes._merge_quiz_stats_value(
        {"_meta": {"openResults": open_results}}, {"_meta": {}})
    assert len(merged2["_meta"]["openResults"]) == 20  # QUIZ_MAX_OPEN_RESULTS 同前端


def test_quiz_merge_answers_shuffled_never_regresses():
    merged = session_routes._merge_quiz_stats_value(
        {"_meta": {"answersShuffled": True}}, {"_meta": {}})
    assert merged["_meta"]["answersShuffled"] is True


def test_quiz_merge_backward_compat_non_dict_value():
    # 老客户端发非 dict 整值（历史脏数据）：退回整值照存（盲替换语义），不炸
    assert session_routes._merge_quiz_stats_value({"tA": _rec(1)}, "junk") == "junk"
    assert session_routes._merge_quiz_stats_value(None, {"tA": _rec(1)}) == {"tA": _rec(1)}


def _edge(eid, frm="a", to="b", created=0):
    return {"id": eid, "fromItem": frm, "toItem": to, "createdAt": created}


def test_continent_edges_union_keeps_concurrent_add():
    # 双设备并发画线：A 加了 e_a，B（镜像里没有 e_a）带着自己的 e_b 整表提交
    current = [_edge("e_a", created=100)]
    incoming = [_edge("e_old", created=1), _edge("e_b", created=200)]
    merged = session_routes._merge_continent_edges_value(current, incoming)
    ids = [e["id"] for e in merged]
    assert "e_a" in ids and "e_b" in ids and "e_old" in ids


def test_continent_edges_subset_is_deletion_stored_as_is():
    # 删线/清断桥/Ctrl+Z：整表少了若干 id（纯子集）→ 照存，删除不被并集复活
    current = [_edge("e1"), _edge("e2"), _edge("e_del")]
    incoming = [_edge("e1"), _edge("e2")]
    assert session_routes._merge_continent_edges_value(current, incoming) == incoming
    # 相等 id 集＝纯编辑：照存
    incoming2 = [{**_edge("e1"), "label": "改"}, _edge("e2")]
    assert session_routes._merge_continent_edges_value(current, incoming2) == incoming2


def test_continent_edges_non_list_falls_back():
    assert session_routes._merge_continent_edges_value([_edge("e1")], "junk") == "junk"


def test_continent_edges_union_capped_at_user_edge_limit():
    current = [_edge(f"e{i}") for i in range(200)]
    incoming = [_edge("new_one")]
    merged = session_routes._merge_continent_edges_value(current, incoming)
    assert len(merged) == 120  # USER_EDGE_LIMIT 与前端 CONTINENT_USER_EDGE_LIMIT 同口径
    assert merged[0]["id"] == "new_one"


def test_continent_edges_wrapper_current_shape_merged():
    # current 可能是 {edges: [...]} 包装（normalize_user_edge_payload 口径）
    current = {"edges": [_edge("e_a")]}
    incoming = [_edge("e_b")]
    merged = session_routes._merge_continent_edges_value(current, incoming)
    assert {e["id"] for e in merged} == {"e_a", "e_b"}


# ====== 529（路由级）：双设备并发答题互不覆盖 ======

def _set_kv_in_thread(key, body, go, done, result):
    """竞方：独立线程＋独立事件循环走真路由（api_set_kv），不做同线程再入。"""
    def _run():
        try:
            assert go.wait(timeout=10), "钩子未放行"
            result["resp"] = asyncio.run(
                session_routes.api_set_kv(key, _fake_request(body)))
        except Exception as e:  # noqa: BLE001
            result["error"] = e
        finally:
            done.set()
    t = threading.Thread(target=_run)
    t.start()
    return t


def test_set_kv_quiz_stats_two_devices_both_survive(acc_env):
    """双设备各自答不同主题后并发整表提交：两份记录都必须幸存。盲替换（修前）
    只剩后到一方；服务端合并后只多不少。"""
    body_a = {"value": {"devA_topic": _rec(1000, correct=1)}, "device_id": ""}
    body_b = {"value": {"devB_topic": _rec(1000, correct=1)}, "device_id": ""}
    go, done_a, done_b = threading.Event(), threading.Event(), threading.Event()
    ra, rb = {}, {}
    ta = _set_kv_in_thread("phymathia_quiz_stats", body_a, go, done_a, ra)
    tb = _set_kv_in_thread("phymathia_quiz_stats", body_b, go, done_b, rb)
    go.set()
    assert done_a.wait(timeout=10) and done_b.wait(timeout=10)
    assert "error" not in ra and "error" not in rb, (ra.get("error"), rb.get("error"))
    assert ra["resp"] == {"ok": True} and rb["resp"] == {"ok": True}
    stats = storage.kv_read("phymathia_quiz_stats")
    assert "devA_topic" in stats and "devB_topic" in stats


def test_set_kv_continent_edges_two_devices_both_edges_survive(acc_env):
    """双设备并发画线：两边各自的整表提交合并后两条边都在。"""
    body_a = {"value": [_edge("e_a", created=1)]}
    body_b = {"value": [_edge("e_b", created=2)]}
    go, done_a, done_b = threading.Event(), threading.Event(), threading.Event()
    ra, rb = {}, {}
    ta = _set_kv_in_thread("continent_edges", body_a, go, done_a, ra)
    tb = _set_kv_in_thread("continent_edges", body_b, go, done_b, rb)
    go.set()
    assert done_a.wait(timeout=10) and done_b.wait(timeout=10)
    assert "error" not in ra and "error" not in rb, (ra.get("error"), rb.get("error"))
    edges = storage.kv_read("continent_edges")
    assert isinstance(edges, list)
    ids = {e.get("id") for e in edges if isinstance(e, dict)}
    assert {"e_a", "e_b"} <= ids


def test_set_kv_delete_route_unaffected(acc_env):
    """DELETE /api/kv/{key} 不受合并影响（照旧整键删除）。"""
    storage.kv_write("continent_edges", [_edge("e1")])
    r = asyncio.run(session_routes.api_delete_kv("continent_edges", None))
    assert r == {"ok": True}
    assert storage.kv_read("continent_edges") is None


# ====== 530：写端点大小/条数上限 ======

def test_set_kv_value_cap_oversize_rejected(acc_env):
    big = "x" * (8 * 1024 * 1024 + 1024)  # 8MB 硬顶之外
    async def _call():
        return await session_routes.api_set_kv("some_global_key", _fake_request({"value": big}))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(_call())
    assert ei.value.status_code == 413


def test_set_kv_main_file_heavy_value_blocked_split_allowed(acc_env):
    """主文件键 512KB 拦截（该量级该走拆分路由）；同体积走拆分层的键放行。"""
    heavy = "x" * (512 * 1024 + 1024)

    async def _call_main():
        return await session_routes.api_set_kv("unrouted_global", _fake_request({"value": heavy}))

    with pytest.raises(HTTPException) as ei:
        asyncio.run(_call_main())
    assert ei.value.status_code == 413
    assert storage.kv_read("unrouted_global") is None

    async def _call_split():
        return await session_routes.api_set_kv("continent_families", _fake_request({"value": {"f": heavy}}))
    resp = asyncio.run(_call_split())
    assert resp == {"ok": True}
    assert "f" in storage.kv_read("continent_families")


def test_set_kv_normal_size_still_passes(acc_env):
    async def _call():
        return await session_routes.api_set_kv("phymathia_stage1", _fake_request({"value": {"note": "正常大小"}}))
    assert asyncio.run(_call()) == {"ok": True}
    assert storage.kv_read("phymathia_stage1") == {"note": "正常大小"}


def test_save_sessions_truncates_title_and_icon(acc_env):
    paths = accounts.resolve_paths()
    long_title = "标" * 500
    long_icon = "i" * 200
    payload = [{"id": "sess_cap1", "title": long_title, "icon": long_icon}]
    resp = asyncio.run(session_routes.api_save_sessions(_fake_request(payload)))
    assert resp["ok"] is True and resp["count"] == 1
    stored = storage._read_json(paths.sessions_path, {})
    assert len(stored["sess_cap1"]["title"]) <= session_routes._SESSION_TITLE_MAX_CHARS
    assert len(stored["sess_cap1"]["icon"]) <= session_routes._SESSION_ICON_MAX_CHARS

    # PUT 同口径
    async def _put():
        return await session_routes.api_update_session(
            "sess_cap1", _fake_request({"title": long_title, "icon": long_icon}))
    assert asyncio.run(_put()) == {"ok": True}
    stored = storage._read_json(paths.sessions_path, {})
    assert len(stored["sess_cap1"]["title"]) <= session_routes._SESSION_TITLE_MAX_CHARS
    assert len(stored["sess_cap1"]["icon"]) <= session_routes._SESSION_ICON_MAX_CHARS


def test_save_messages_content_truncated(acc_env):
    long_content = "答" * (session_routes._MESSAGE_CONTENT_MAX_CHARS + 5000)
    messages = [
        {"role": "user", "content": "问", "timestamp": 1000},
        {"role": "assistant", "content": long_content, "timestamp": 2000},
    ]
    resp = asyncio.run(session_routes.api_save_messages(
        "sess_cap_msg", _fake_request({"messages": messages}), Response()))
    assert resp["ok"] is True
    stored = storage._read_json(accounts.resolve_paths().messages_dir / "sess_cap_msg.json", [])
    assert len(stored[1]["content"]) == session_routes._MESSAGE_CONTENT_MAX_CHARS
    assert stored[0]["content"] == "问"  # 正常消息原样


def test_save_messages_count_capped(acc_env):
    flood = [{"role": "user", "content": "x", "timestamp": i}
             for i in range(session_routes._MESSAGES_COUNT_MAX + 1)]
    async def _call():
        return await session_routes.api_save_messages(
            "sess_flood", _fake_request({"messages": flood}), Response())
    with pytest.raises(HTTPException) as ei:
        asyncio.run(_call())
    assert ei.value.status_code == 413


def _knowledge_item(kid, size=0):
    return {"id": kid, "title": f"牛顿第二定律{kid}", "source": "manual",
            "sessionId": "", "topic": "物理", "concept": "F=ma", "pad": "z" * size}


def test_save_knowledge_items_cap(acc_env):
    flood = {"items": [_knowledge_item(f"k{i}") for i in range(knowledge_routes._KNOWLEDGE_ITEMS_MAX + 1)]}
    async def _call():
        return await knowledge_routes.api_save_knowledge(_fake_request(flood))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(_call())
    assert ei.value.status_code == 413


def test_save_knowledge_oversize_item_dropped_others_stored(acc_env):
    paths = accounts.resolve_paths()
    payload = {"items": [
        _knowledge_item("k_ok1"),
        _knowledge_item("k_big", size=knowledge_routes._KNOWLEDGE_ITEM_MAX_BYTES + 2048),
        _knowledge_item("k_ok2"),
    ]}
    resp = asyncio.run(knowledge_routes.api_save_knowledge(_fake_request(payload)))
    assert resp["ok"] is True
    stored = storage._read_json(paths.knowledge_path, {})
    assert "k_ok1" in stored and "k_ok2" in stored
    assert "k_big" not in stored  # 超限条丢弃，整单不受拖累


def _formula_item(fid, latex="x = \\frac{a}{b}"):
    return {"id": fid, "latex": latex, "concept": "公式", "meaning": "测试",
            "topic": "物理", "sessionId": "", "createdAt": 1700000000000}


def test_save_formulas_items_cap(acc_env):
    flood = {"items": [_formula_item(f"f{i}") for i in range(knowledge_routes._FORMULAS_ITEMS_MAX + 1)]}
    async def _call():
        return await knowledge_routes.api_save_formulas(_fake_request(flood))
    with pytest.raises(HTTPException) as ei:
        asyncio.run(_call())
    assert ei.value.status_code == 413


def test_save_formulas_oversize_latex_skipped_normal_stored(acc_env):
    paths = accounts.resolve_paths()
    huge_latex = "a + " * (knowledge_routes._FORMULA_LATEX_MAX_CHARS // 2) + "b"
    assert len(huge_latex) > knowledge_routes._FORMULA_LATEX_MAX_CHARS
    payload = {"items": [_formula_item("f_ok"), _formula_item("f_big", latex=huge_latex)]}
    resp = asyncio.run(knowledge_routes.api_save_formulas(_fake_request(payload)))
    assert resp == {"ok": True, "count": 1}
    stored = storage._read_json(paths.formulas_path, {})
    assert "f_ok" in stored and "f_big" not in stored


def test_set_kv_quiz_stats_profile_diff_after_merge(acc_env, monkeypatch):
    """隐式画像差分改在合并结果上：另一设备已同步过的答案不重复计事件。"""
    events_seen = []
    monkeypatch.setattr(session_routes.profile, "record_implicit_event",
                        lambda device, events, account=None: events_seen.extend(events))
    # 设备 A 先答一题并已同步到服务端
    async def _a():
        return await session_routes.api_set_kv("phymathia_quiz_stats", _fake_request({
            "value": {"t1": _rec(1000, correct=1)}, "device_id": "devA"}))
    asyncio.run(_a())
    n_first = len(events_seen)
    assert n_first == 1
    # 设备 B 的整表镜像里已带着 t1（它同步过），再答自己的一题后提交
    async def _b():
        return await session_routes.api_set_kv("phymathia_quiz_stats", _fake_request({
            "value": {"t1": _rec(1000, correct=1), "t2": _rec(2000, correct=1)},
            "device_id": "devB"}))
    asyncio.run(_b())
    # t1 是 B 从服务端同步来的旧闻（delta=0 不计），只应新增 t2 一条事件
    assert len(events_seen) == 2
    assert events_seen[-1]["topic"] == "t2"
