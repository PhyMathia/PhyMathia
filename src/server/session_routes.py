"""用户数据路由（T163 自 main.py 收编）：账号 CRUD、会话名单、回收站、
消息与 KV 快照。

路径一律调用期经 _account_paths()/paths 对象解析（本模块不持路径常量，
tests 的批量路径重定向夹具无需补丁本模块）；数据读写走 storage 原语，
删除链路的回收站快照纪律见 server/trash.py。
"""

import asyncio
import json
import logging
import time
import uuid

from fastapi import APIRouter, HTTPException, Request

from . import accounts, continent, context, profile, storage, trash
from .context import _delete_socratic_state, _graph_message_summary, merge_message_lists
from .knowledge import _delete_items_by_session
from .request_ctx import _account_id, _account_id_raw, _account_paths, _parse_json_object
from .storage import _get_messages_path, _mutate_json, _read_json, _read_json_cached, _write_json

logger = logging.getLogger(__name__)

router = APIRouter()


# ====== 账号管理 API（本地多账号 P2，2026-10-07）======
# 存储分域靠各存储路由的 account_id 请求参数（_account_id），这里只管账号
# 注册表本身（data/users/accounts.json）。CRUD 函数与默认名/拒删规则在
# accounts.py，路由层只做参数校验与 HTTP 语义。

@router.get("/api/accounts")
async def api_accounts_list():
    # default 排最前（无 account_id 请求的落点），其余按创建时间升序
    entries = accounts.load_registry()
    items = sorted(entries.values(),
                   key=lambda e: (e.get("id") != accounts.DEFAULT_ACCOUNT,
                                  e.get("createdAt") or 0, e.get("id") or ""))
    return {"accounts": items}


async def _parse_account_payload(request: Request) -> tuple:
    payload = await _parse_json_object(request)
    raw = payload.get("account_id")
    if not raw:
        raise HTTPException(status_code=400, detail="account_id required")
    account = accounts.validate_account_id(raw)
    if account != raw:
        # 白名单外（路径穿越等）直接拒——与 _account_id 的「落 default」不同：
        # 这里是管理操作，目标必须精确存在，静默改写目标会造成误伤邻账号
        raise HTTPException(status_code=400, detail="invalid account_id")
    return account, payload


@router.post("/api/accounts")
async def api_accounts_create(request: Request):
    payload = await _parse_json_object(request)
    name = str(payload.get("name") or "").strip()[:40] or None
    # id 服务端生成（12 位十六进制；前端键前缀取前 8 位，见 config.js accountLsPrefix）
    entries = accounts.load_registry()
    # 撞墓碑 id 也重摇（T191）：墓碑目录占名＋「已删账号」闸门会让新账号目录建不
    # 起来且请求全 404；uuid 12 位撞概率极低，防御位零成本。
    tombstoned = trash.tombstone_account_ids()
    account_id = uuid.uuid4().hex[:12]
    while account_id in entries or account_id in tombstoned:
        account_id = uuid.uuid4().hex[:12]
    entry = accounts.register_account(account_id, name=name)
    accounts.ensure_account(account_id, name=name)
    return entry


@router.post("/api/accounts/rename")
async def api_accounts_rename(request: Request):
    account, payload = await _parse_account_payload(request)
    name = str(payload.get("name") or "").strip()[:40]
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    try:
        return accounts.rename_account(account, name)
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")


@router.post("/api/accounts/allow_browse")
async def api_accounts_allow_browse(request: Request):
    account, payload = await _parse_account_payload(request)
    try:
        return accounts.set_allow_browse(account, bool(payload.get("allow")))
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")


@router.post("/api/accounts/delete")
async def api_accounts_delete(request: Request):
    account, payload = await _parse_account_payload(request)
    if account == accounts.DEFAULT_ACCOUNT:
        # default 是无 account_id 请求的兜底落点，删了数据就丢（accounts.remove_account 同款防线）
        raise HTTPException(status_code=400, detail="default 账号不可删除")
    # 删账号回收站化（2026-10-07）：整个账号目录移入 data/users/_trash/ 墓碑区，
    # 保留期内可在回收站恢复；机制与拍板见 trash.py「账号级墓碑」节。
    # 保留天数按发起删除的当前账号算（fetch 包装给所有 /api/ 请求恒带 query
    # account_id＝当前账号；curl 直调无 query 时回落目标账号自身设置，再回默认 7）。
    # 用 _account_id_raw：重复删（幂等除名）时目标已带墓碑，_account_id 会 404
    days = trash.retention_days(_account_id_raw(request, payload))
    entry = accounts.get_account(account)  # 注册表条目快照：墓碑 meta 与回滚都用它
    accounts.remove_account(account)  # 先除名；移目录失败时 restore_entry 回滚
    in_trash = False
    try:
        if days == 0:
            trash.purge_account_data(account)  # 回收站关闭：删除即彻底清除（与画布同口径）
            trash.purge_bound_profiles(entry)  # 本账号归属的画像设备一并彻底清除（2026-10-07 画像按账号隔离）
        else:
            in_trash = trash.capture_account(account, entry, days) is not None
    except Exception as e:
        accounts.restore_entry(entry)  # 移入失败＝原账号原样（宁可 500 不可丢数据）
        raise HTTPException(status_code=500, detail=f"删除失败：账号数据未能移入回收站，原账号未受影响（{e}）")
    accounts.forget_ensured(account)  # 防 ensure 缓存让已删账号以空目录复活
    return {"ok": True, "id": account, "inTrash": in_trash, "restorableDays": days if in_trash else 0}


# ====== 会话管理 API ======
@router.get("/api/sessions")
async def api_get_sessions(request: Request = None):
    return _read_json_cached(_account_paths(request).sessions_path, {})


@router.post("/api/sessions")
async def api_save_sessions(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    def updater(data):
        nonlocal written
        now = int(time.time() * 1000)

        def _entry(sid, sdata):
            # 消息文件路径按 sid 直接拼路径（_get_messages_path 白名单）——
            # 写进 sessions.json 的 id 必须同口径校验，否则一条脏键会让
            # 备份导出（对每个 sid 取路径）永久 500，且 DELETE 拒收删不掉
            if not isinstance(sid, str) or not storage._SESSION_ID_RE.match(sid):
                return None
            return {
                "id": sid,
                "title": sdata.get("title", "新对话"),
                "icon": sdata.get("icon", ""),
                "sessionId": sdata.get("sessionId", ""),
                "createdAt": sdata.get("createdAt", now),
                "updatedAt": sdata.get("updatedAt", now),
            }

        if isinstance(payload, list):
            for sdata in payload:
                if not isinstance(sdata, dict) or not sdata.get("id"):
                    continue
                entry = _entry(sdata["id"], sdata)
                if entry:
                    data[entry["id"]] = entry
                    written += 1
        elif isinstance(payload, dict) and "id" in payload:
            entry = _entry(payload["id"], payload)
            if entry:
                data[entry["id"]] = entry
                written += 1
        elif isinstance(payload, dict):
            for sid, sdata in payload.items():
                if not isinstance(sdata, dict):
                    continue
                entry = _entry(sdata.get("id") or sid, sdata)
                if entry:
                    data[entry["id"]] = entry
                    written += 1
        return data

    written = 0
    _mutate_json(_account_paths(request, payload).sessions_path, updater)
    # count 返回实际写入条数（非法 id 被跳过的不算），与 knowledge 路由口径一致
    return {"ok": True, "count": written}


@router.put("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    try:
        _get_messages_path(session_id, account)
    except ValueError:
        # 与 DELETE 同口径：路径 id 先过白名单，PUT 不能为任意字符串建条目
        raise HTTPException(status_code=400, detail="Invalid session id")

    def updater(data):
        now = int(time.time() * 1000)
        if session_id not in data:
            data[session_id] = {
                "id": session_id,
                "title": "新对话",
                "icon": "",
                "sessionId": "",
                "createdAt": now,
                "updatedAt": now,
            }
        if "title" in payload:
            data[session_id]["title"] = payload["title"]
        if "icon" in payload:
            data[session_id]["icon"] = payload["icon"]
        if "sessionId" in payload:
            data[session_id]["sessionId"] = payload["sessionId"]
        data[session_id]["updatedAt"] = now
        return data

    _mutate_json(_account_paths(request, payload).sessions_path, updater)
    return {"ok": True}


def _purge_dangling_continent_edges(session_id: str, account: str = accounts.DEFAULT_ACCOUNT) -> None:
    """删画布/清空画布后自动清断桥（2026-10-03 用户拍板）：端点条目已随画布消失的
    航线整条从 KV continent_edges 移除，不留死虚线。清理失败只记警告、不阻断删除
    主体（删除本身已生效，漏网的断桥下轮还能手动清）。概念单删类断桥不经这里。"""
    try:
        paths = accounts.resolve_paths(account)
        raw = continent.normalize_user_edge_payload(storage.kv_read("continent_edges", account=account))
        kept = continent.purge_dangling_user_edges(raw, _read_json(paths.knowledge_path, {}))
        if len(kept) != len(raw):
            storage.kv_write("continent_edges", kept, account=account)
            logger.info(f"session {session_id}: purged {len(raw) - len(kept)} dangling continent edge(s)")
    except Exception as e:  # 清理是删除的附带收益，不许让它拖垮主流程
        logger.warning(f"purge dangling continent_edges failed: {e}")


@router.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str, request: Request = None):
    payload = {}
    account = _account_id(request, payload)
    paths = _account_paths(request, payload)
    try:
        msgs_path = _get_messages_path(session_id, account)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    # 回收站（2026-10-07）：动手毁数据前先整体快照进站；快照抛异常＝中止删除
    # （500）——「防误删」的前提是删了还能回来，宁可报错不可丢数据。保留天数
    # 为 0（回收站关闭）时 capture 返回 False，走原删除链路。
    trash.capture_session(paths, session_id, messages_path=msgs_path)
    # 删除别名映射前清理摘要并推进删除代次；失败中止，不能留下旧上下文却报清除成功
    context._delete_rolling_memory(session_id, account)

    # 先清资料、最后删名单（09-23 真机取证：3 座「已删除的画布」孤岛全是旧顺序
    # 「先 pop 名单、后清资料」中途被打断留下的——名单没了，知识点/公式/消息/
    # KV 快照原地保留。反过来中断最多留下一座还看得见的空岛，重删一次即可）。
    # 探索网快照（data/kv/<sid>.json 整文件）此前从不清，残留会被回填脚本当作
    # 提取料把已删会话的知识点重新入库——孤岛的「复活」通道。
    _delete_items_by_session(paths.knowledge_path, session_id)  # T146: sessionIds 感知删除
    _delete_items_by_session(paths.formulas_path, session_id)  # T146: sessionIds 感知删除
    _purge_dangling_continent_edges(session_id, account)
    _delete_socratic_state(session_id, account)
    for stale in (msgs_path, paths.kv_dir / f"{session_id}.json"):
        try:
            if stale.exists():
                stale.unlink()
        except OSError as e:
            logger.warning(f"delete session: unlink {stale.name} failed: {e}")

    def updater(data):
        data.pop(session_id, None)
        return data

    _mutate_json(paths.sessions_path, updater)
    return {"ok": True}


@router.delete("/api/sessions")
async def api_clear_all_sessions(request: Request = None):
    paths = _account_paths(request)
    account = paths.account
    # 回收站：逐会话快照后再清空；任一快照失败即中止（500），一条都不会被删。
    # capture 保持同步：它的 await 点会让排队中的滚动摘要任务赶在下方代次
    # bump 前抢跑发请求（S1 失效保护拍板「失效任务一个请求都不发」，实测被
    # test_s1_alias_task_invalidated 逮住）；删除块的等待点已落在 bump 之后。
    try:
        trash.capture_all(paths)
    except Exception as e:
        logger.warning(f"clear all: trash capture failed, abort: {e}")
        raise HTTPException(status_code=500, detail="回收站快照失败，已中止清空，请稍后重试")
    context._clear_all_rolling_memory(account)  # 先失效在途摘要任务（代次 bump），必须先于一切 await

    def _clear_all_io():
        _write_json(paths.sessions_path, {})
        for f in paths.messages_dir.glob("*.json"):
            f.unlink()
        _write_json(paths.knowledge_path, {})
        _write_json(paths.formulas_path, {})
        _write_json(paths.kv_path, {})
        if paths.kv_dir.exists():
            for f in paths.kv_dir.glob("*.json"):
                f.unlink()

    await asyncio.to_thread(_clear_all_io)  # T201：批量写/删文件不压事件循环
    return {"ok": True}


# ====== 回收站 API（2026-10-07：防误删——删除的会话在保留期内可整体恢复） ======
# 捕获/恢复/清除的规则与拍板见 server/trash.py 模块注释；item id 即会话 id。
# 只读查阅态：GET 放行（读站内列表无害），POST/DELETE 被 _readonly_browse_gate
# 与前端 fetch 包装双层拦——回收站写操作无需额外白名单。

@router.get("/api/trash")
async def api_trash_list(request: Request = None):
    paths = _account_paths(request)
    return {
        "items": trash.list_items(paths),
        "retentionDays": trash.retention_days(paths.account),
        # 已删账号的墓碑（2026-10-07 删账号回收站化）：全局一处不分账号，
        # 任何账号的面板都能看到本机全部可恢复账号
        "deletedAccounts": trash.list_account_tombstones(),
    }


@router.post("/api/trash/settings")
async def api_trash_settings(request: Request):
    payload = await _parse_json_object(request)
    paths = _account_paths(request, payload)
    try:
        days = trash.set_retention_days(paths.account, payload.get("days"))
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"保留天数需为 0–365 的整数（{e}）")
    return {"ok": True, "retentionDays": days}


# 账号墓碑的恢复/彻底删除。字面段 accounts 与 {item_id} 参数段形状不同
# （/api/trash/accounts/<stone> 是两段），与下方条目路由无匹配歧义。
@router.post("/api/trash/accounts/{stone_id}/restore")
async def api_trash_account_restore(stone_id: str):
    try:
        account = trash.restore_account_tombstone(stone_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="回收站里没有这个已删账号")
    except trash.TrashConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "id": account}


@router.delete("/api/trash/accounts/{stone_id}")
async def api_trash_account_purge(stone_id: str):
    try:
        trash.purge_account_tombstone(stone_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="回收站里没有这个已删账号")
    return {"ok": True}


@router.post("/api/trash/{item_id}/restore")
async def api_trash_restore(item_id: str, request: Request = None):
    paths = _account_paths(request)
    try:
        sid = trash.restore_item(paths, item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="回收站里没有这个条目")
    except trash.TrashConflictError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "sessionId": sid}


@router.delete("/api/trash/{item_id}")
async def api_trash_purge(item_id: str, request: Request = None):
    paths = _account_paths(request)
    try:
        trash.purge_item(paths, item_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="回收站里没有这个条目")
    return {"ok": True}


@router.delete("/api/trash")
async def api_trash_empty(request: Request = None):
    paths = _account_paths(request)
    return {"ok": True, "purged": trash.empty_trash(paths)}



# ====== 消息管理 API ======
@router.post("/api/sessions/messages-batch")
async def api_get_messages_batch(request: Request):
    """一次读取多个会话的消息，供前端启动/定时同步使用，避免 N 次串行请求。"""
    payload = await _parse_json_object(request)

    raw_ids = payload.get("session_ids") or payload.get("ids") or []
    if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
    session_ids = []
    for raw_sid in raw_ids:
        sid = str(raw_sid).strip()
        # 与 _get_messages_path 的白名单一致，防止批量接口被用来做路径穿越
        if storage._SESSION_ID_RE.match(sid):
            session_ids.append(sid)
        if len(session_ids) >= 500:
            break

    account = _account_id(request, payload)

    def _read_batch():
        # T201：批量读最多 500 个消息文件，挪 to_thread 跑，不再压在事件循环
        # 上卡流式回复下发（_read_json_cached 自带 RLock，线程安全）
        result = {}
        for sid in session_ids:
            msgs = _read_json_cached(_get_messages_path(sid, account), [])
            result[sid] = msgs if isinstance(msgs, list) else []
        return result

    return {"messages": await asyncio.to_thread(_read_batch)}


@router.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str, request: Request = None):
    try:
        path = _get_messages_path(session_id, _account_id(request))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    return _read_json_cached(path, [])


@router.post("/api/sessions/{session_id}/messages")
async def api_save_messages(session_id: str, request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    messages = payload if isinstance(payload, list) else payload.get("messages", [])
    if isinstance(messages, list):
        for msg in messages:
            if isinstance(msg, dict) and msg.get("role") == "assistant" and not str(msg.get("summary") or "").strip():
                try:
                    msg["summary"] = _graph_message_summary(msg)
                except Exception:
                    pass
            # 前缀缓存拍板（2026-09-25 三代窗）：详摘要在落盘时出生定形，读取侧
            # 只用不改（旧数据缺字段由 context.summary_detail 现算兜底）。
            if isinstance(msg, dict) and msg.get("role") == "assistant" and not str(msg.get("summary_detail") or "").strip():
                try:
                    msg["summary_detail"] = context.summary_detail(msg)
                except Exception:
                    pass
    account = _account_id(request, payload)
    try:
        msgs_path = _get_messages_path(session_id, account)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")

    def msgs_updater(existing):
        # 逐条合并（按 timestamp 身份，与前端 _mergeMessageLists 同口径）：
        # 两边各自独有的消息都保留、字段互补——取代旧「消息更多的一方取胜」
        # （旧规则在两边各有一些消息时会把少的一边独有的整份丢掉）。
        # 空列表同样不许写：它是本地读档失败/竞态的表现（合法清空走 DELETE
        # 路由），空列表清空服务端唯一副本（09-20 修复，不许回退）。
        if not isinstance(existing, list):
            return messages
        if not messages:
            return None
        merged = merge_message_lists(existing, messages)
        if merged == existing:
            return None  # 没有任何新东西：不写盘
        return merged

    # T201：读并+合并+写盘挪 to_thread，长会话保存不再卡流式下发
    # （storage._JSON_LOCK 是 threading.RLock，跨线程照常串行，语义不变）
    await asyncio.to_thread(_mutate_json, msgs_path, msgs_updater, default=[])
    return {"ok": True, "count": len(messages)}


@router.delete("/api/sessions/{session_id}/messages")
async def api_clear_messages(session_id: str, request: Request = None):
    account = _account_id(request)
    paths = _account_paths(request)
    try:
        msgs_path = _get_messages_path(session_id, account)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    # 回收站（T182）：动手毁数据前先快照进站；快照抛异常＝中止清空（500），与
    # 删除画布同一纪律。清空后画布条目本身保留，故捕 kind=messages（真正会被
    # 抹掉的数据，不含 session.json）；保留天数 0＝回收站关闭，走原清空链路。
    # 捕获点必须早于前端的 graph/quiz 清理（session.js clearChat 已同步重排）。
    trash.capture_cleared_messages(paths, session_id, messages_path=msgs_path)
    # 清消息同样清滚动摘要并推进删除代次（阶段1 S1：复用会话 ID 不得吃旧记忆）
    context._delete_rolling_memory(session_id, account)
    if msgs_path.exists():
        msgs_path.unlink()
    _write_json(msgs_path, [])
    _delete_items_by_session(paths.knowledge_path, session_id)  # T146: sessionIds 感知删除
    _delete_items_by_session(paths.formulas_path, session_id)  # T146: sessionIds 感知删除
    _purge_dangling_continent_edges(session_id, account)
    _delete_socratic_state(session_id, account)
    return {"ok": True}

# ====== 键值存储 API ======
# 读写经 storage.kv_* 拆分路由：graph:<sid>/harness_history:<sid> 等会话级键
# 落到 data/kv/<sid>.json（保存单会话不再全量重写主文件），全局键走主文件。
@router.get("/api/kv/{key}")
async def api_get_kv(key: str, request: Request = None):
    return {"key": key, "value": storage.kv_read(key, account=_account_id(request))}


@router.post("/api/kv/{key}")
async def api_set_kv(key: str, request: Request):
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    # 隐式画像：测验/苏格拉底作答统计写入时做新旧差分，产出逐次作答事件
    # （history 里带对错/时间戳/questionId，无需前端新增记录逻辑）
    if key == profile.QUIZ_STATS_KEY:
        _device_id = str(payload.get("device_id") or "")
        if _device_id:
            try:
                _events = profile.quiz_stats_events(storage.kv_read(key, account=account), payload.get("value"))
                if _events:
                    profile.record_implicit_event(_device_id, _events, account=account)
            except Exception as e:
                logger.warning(f"Quiz stats implicit diff failed: {e}")
    storage.kv_write(key, payload.get("value", ""), account=account)
    return {"ok": True}


@router.delete("/api/kv/{key}")
async def api_delete_kv(key: str, request: Request = None):
    storage.kv_delete(key, account=_account_id(request))
    return {"ok": True}
