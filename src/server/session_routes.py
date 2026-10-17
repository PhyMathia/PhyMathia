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

from . import accounts, continent, context, graph_merge, profile, storage, trash
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
    # T241：_read_json_cached 的 stat 也在 _JSON_LOCK 内做——后台线程持锁写大文件时，
    # 这次 stat 会把事件循环堵在锁上（前端 15 秒同步反复打这个端点）。读盘整体离线程。
    paths = _account_paths(request)
    data = await asyncio.to_thread(_read_json_cached, paths.sessions_path, {})
    # T356：消息文件在位标记（msgSaved）——历史缺口（写穿欠账/跨机迁移）以前对前端
    # 完全不可见：同步只拉不补、窗口外会话永不补传，缺口画布两边齐空转。给每条
    # 会话标上服务端 messages/<sid>.json 是否存在，前端据此定向补传。代价＝一次
    # readdir（只看文件名，不解析消息体）；读的是缓存对象，标注必须落在浅拷贝上，
    # 否则会把 _read_json_cached 的缓存污染掉。
    try:
        have_msgs = {p.stem for p in paths.messages_dir.glob("*.json")}
    except OSError:
        have_msgs = set()
    if isinstance(data, dict):
        return {
            sid: ({**s, "msgSaved": sid in have_msgs} if isinstance(s, dict) else s)
            for sid, s in data.items()
        }
    return data


@router.post("/api/sessions")
async def api_save_sessions(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    paths = _account_paths(request, payload)

    def updater(data):
        nonlocal written, rejected
        now = int(time.time() * 1000)
        # T271 墓碑闸门：已删会话的**删前旧副本**拒收不重建（兄弟标签页卸载信标、
        # 同步竞态写回的本地快照都带删前 updatedAt）。时间戳感知——只拒「带
        # updatedAt 且 ≤ 删除时刻」的副本；无 updatedAt 的净新建放行（语义即
        # 「同 id 重建以新为准」，也是测试/新客户端首建的合法形态）。在 updater
        # 内读登记表——与删除路由的登记同持全局 _JSON_LOCK，杜绝「读表→删除
        # 登记→写名单」的竞窗。
        tombstones = trash.tombstone_read(paths)

        def _stale_copy(sid, sdata):
            deleted_at = tombstones.get(sid)
            if deleted_at is None:
                return False
            raw = sdata.get("updatedAt") if isinstance(sdata, dict) else None
            if raw is None:
                return False  # 净新建（无时间戳）：放行
            try:
                return int(raw) <= deleted_at
            except (TypeError, ValueError):
                return True  # 脏时间戳按旧副本从严

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
                if not entry:
                    continue
                if _stale_copy(entry["id"], sdata):
                    rejected.append(entry["id"])
                    continue
                data[entry["id"]] = entry
                written += 1
        elif isinstance(payload, dict) and "id" in payload:
            entry = _entry(payload["id"], payload)
            if entry:
                if _stale_copy(entry["id"], payload):
                    rejected.append(entry["id"])
                else:
                    data[entry["id"]] = entry
                    written += 1
        elif isinstance(payload, dict):
            for sid, sdata in payload.items():
                if not isinstance(sdata, dict):
                    continue
                entry = _entry(sdata.get("id") or sid, sdata)
                if not entry:
                    continue
                if _stale_copy(entry["id"], sdata):
                    rejected.append(entry["id"])
                    continue
                data[entry["id"]] = entry
                written += 1
        return data

    written = 0
    rejected = []
    # T240：sessions.json 的读-改-写整体挪 to_thread（T201 首波漏了会话名单表，
    # 收尾补上）——整表重写持全局 _JSON_LOCK，压在事件循环上时后台持锁写大文件
    # 会把全服务请求堵停。updater 是纯本地 dict 操作，无线程安全问题
    await asyncio.to_thread(_mutate_json, paths.sessions_path, updater)
    # count 返回实际写入条数（非法 id 被跳过的不算），与 knowledge 路由口径一致。
    # rejected 仅在真有墓碑拒收时附带——冻结契约（review_stage1_http）对响应做
    # 精确断言，稳态空表不添键，形状与旧版逐字节一致
    result = {"ok": True, "count": written}
    if rejected:
        result["rejected"] = rejected
    return result


@router.put("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    try:
        _get_messages_path(session_id, account)
    except ValueError:
        # 与 DELETE 同口径：路径 id 先过白名单，PUT 不能为任意字符串建条目
        raise HTTPException(status_code=400, detail="Invalid session id")
    paths = accounts.resolve_paths(account)

    tombstoned = False

    def updater(data):
        nonlocal tombstoned
        now = int(time.time() * 1000)
        # T271 墓碑闸门：已删会话不重建条目（改名/换图标的 PUT 不该复活画布）。
        # 在 updater 内读登记表，与删除登记同锁无竞窗；置位后在锁外回 409。
        if session_id in trash.tombstone_read(paths):
            tombstoned = True
            return data
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

    # T240：与 POST 同表同患——单条 upsert 也是整文件重写，一并离线程
    await asyncio.to_thread(_mutate_json, paths.sessions_path, updater)
    if tombstoned:
        raise HTTPException(status_code=409, detail="该画布已删除，无法更新（保留期内可在回收站恢复）")
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


def _delete_session_sync(paths, account, session_id, msgs_path) -> None:
    """T241：DELETE /api/sessions/{id} 的整套磁盘活儿，整体在 to_thread 里跑。

    顺序语义不能动（09-23 真机取证）：先清资料、最后删名单——反过来中断会留下
    「名单没了、资料还在」的孤岛；探索网快照（data/kv/<sid>.json 整文件）必须清，
    残留会被回填脚本当提取料把已删会话的知识点重新入库（孤岛的「复活」通道）。
    全链在同一个工作线程里串行执行，先后次序与旧版逐句跑一致；_JSON_LOCK 是
    threading.RLock 跨线程照常串行，墓碑登记与名单删除仍同锁同刻。快照抛异常
    ＝中止删除（500），语义不变。"""
    # 回收站（2026-10-07）：动手毁数据前先整体快照进站——「防误删」的前提是删了
    # 还能回来，宁可报错不可丢数据。保留天数为 0（回收站关闭）时 capture 返回
    # False，走原删除链路。
    trash.capture_session(paths, session_id, messages_path=msgs_path)
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
        existed = session_id in data
        data.pop(session_id, None)
        # T271：登记已删墓碑（与名单删除同锁同刻）——此后带删前 updatedAt 的
        # 旧副本（卸载信标/同步竞态）写不回。只登记删除时刻确在名单的 id：
        # 重复删/幻 id 不入登记表，登记表不积垃圾
        if existed:
            trash.tombstone_register(paths, [session_id])
        return data

    _mutate_json(paths.sessions_path, updater)


@router.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str, request: Request = None):
    payload = {}
    account = _account_id(request, payload)
    paths = _account_paths(request, payload)
    try:
        msgs_path = _get_messages_path(session_id, account)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    # 滚动摘要的失效边界必须先于一切 await（S1 红线「失效任务零请求」在单删链的
    # 落法，test_s1_alias_task_invalidated[delete-queued] 钉死）：先在循环线程上
    # 作废该会话排队的摘要任务，再把整套慢 IO 离线程——线程切换的空窗里，排队
    # 任务没有抢跑发请求的机会。mem 族文件小，这一步留在循环线程是刻意的；
    # 失败中止，不能留下旧上下文却报清除成功。它先于快照跑是无损重排：快照捕的
    # 是 session/messages/knowledge/formulas/kv，不含 mem 键。
    context._delete_rolling_memory(session_id, account)
    # T241：快照＋资料清理×2＋断桥＋苏格拉底状态＋消息/KV unlink＋名单表重写
    # 原来逐句压在事件循环线程上，删大会话期间全服务请求停摆；整体收拢进
    # _delete_session_sync 离线程，顺序契约在其 docstring 里钉死。
    await asyncio.to_thread(_delete_session_sync, paths, account, session_id, msgs_path)
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
    # T271：清空前把现存 id 全部登记成墓碑（失败同样中止）——否则兄弟标签页
    # 的卸载信标/同步竞态回传会把它们逐条写回，清空等于白清
    try:
        trash.tombstone_register(paths, list(_read_json(paths.sessions_path, {}).keys()))
    except Exception as e:
        logger.warning(f"clear all: tombstone register failed, abort: {e}")
        raise HTTPException(status_code=500, detail="删除登记失败，已中止清空，请稍后重试")
    context._clear_all_rolling_memory(account)  # 先失效在途摘要任务（代次 bump），必须先于一切 await

    def _clear_all_io():
        _write_json(paths.sessions_path, {})
        for f in paths.messages_dir.glob("*.json"):
            f.unlink()
        _write_json(paths.knowledge_path, {})
        _write_json(paths.formulas_path, {})
        _write_json(paths.kv_path, {})
        for directory in (paths.kv_dir, paths.kv_meta_dir):
            if directory.exists():
                for f in directory.glob("*.json"):
                    f.unlink()

    await asyncio.to_thread(_clear_all_io)  # T201：批量写/删文件不压事件循环
    return {"ok": True}


@router.get("/api/sessions/deleted-ids")
async def api_deleted_session_ids(request: Request = None):
    """已删会话墓碑登记表（T271，id→删除毫秒时刻）。前端 15 秒同步轮询它清
    本地残留（删除竞态写回的名单条目、兄弟标签页删掉的画布）——复活防线的
    客户端半边；服务端写闸门见 POST/PUT /api/sessions 的墓碑拒收。"""
    paths = _account_paths(request)
    return {"deleted": trash.tombstone_read(paths)}


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


@router.post("/api/sessions/graph-stats")
async def api_get_graph_stats(request: Request):
    """一次读取多个会话的图状态内容量（customNodes/connections/nodes 计数），
    供前端 15 秒同步判定「空画布」徽标。图状态按需加载（只切进画布拉一次
    graph:<sid>），没在本机加载过的画布本地没有图状态键——不拿服务端口径就会
    把「有内容但未加载」的画布误判为空（2026-10-13 用户实踩）。只回数量不回
    内容，响应体积与一张图的大小脱钩。"""
    payload = await _parse_json_object(request)

    raw_ids = payload.get("session_ids") or payload.get("ids") or []
    if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
    session_ids = []
    for raw_sid in raw_ids:
        sid = str(raw_sid).strip()
        # 与 messages-batch 同一把白名单，防止批量接口被用来做路径穿越
        if storage._SESSION_ID_RE.match(sid):
            session_ids.append(sid)
        if len(session_ids) >= 500:
            break

    account = _account_id(request, payload)

    def _read_batch():
        result = {}
        for sid in session_ids:
            try:
                state = storage.kv_read("graph:" + sid, None, account)
            except Exception:
                state = None
            if not isinstance(state, dict):
                state = {}

            def _count(field):
                value = state.get(field)
                return len(value) if isinstance(value, list) else 0

            result[sid] = {
                "custom": _count("customNodes"),
                "connections": _count("connections"),
                "nodes": _count("nodes"),
            }
        return result

    return {"stats": await asyncio.to_thread(_read_batch)}


@router.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str, request: Request = None):
    try:
        path = _get_messages_path(session_id, _account_id(request))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    # T241：与 GET /api/sessions 同型——_read_json_cached 的 stat 持全局锁，离线程
    return await asyncio.to_thread(_read_json_cached, path, [])


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

    tombstoned_msgs = False
    wrote_msgs = False

    def msgs_updater(existing):
        nonlocal tombstoned_msgs, wrote_msgs
        # T271 墓碑闸门：已删会话的消息推送静默不落盘（不建孤儿消息文件）。
        # 与删除登记同持全局 _JSON_LOCK，无竞窗；响应仍 ok（信标/同步调用方
        # 只看 resp.ok，静默跳过防重试风暴）。
        if session_id in trash.tombstone_read(accounts.resolve_paths(account)):
            tombstoned_msgs = True
            return None
        # 逐条合并（按 timestamp 身份，与前端 _mergeMessageLists 同口径）：
        # 两边各自独有的消息都保留、字段互补——取代旧「消息更多的一方取胜」
        # （旧规则在两边各有一些消息时会把少的一边独有的整份丢掉）。
        # 空列表同样不许写：它是本地读档失败/竞态的表现（合法清空走 DELETE
        # 路由），空列表清空服务端唯一副本（09-20 修复，不许回退）。
        if not isinstance(existing, list):
            wrote_msgs = True
            return messages
        if not messages:
            return None
        merged = merge_message_lists(existing, messages)
        if merged == existing:
            return None  # 没有任何新东西：不写盘
        wrote_msgs = True
        return merged

    # T201：读并+合并+写盘挪 to_thread，长会话保存不再卡流式下发
    # （storage._JSON_LOCK 是 threading.RLock，跨线程照常串行，语义不变）
    await asyncio.to_thread(_mutate_json, msgs_path, msgs_updater, default=[])
    # T356：written＝这轮真落盘了没有。200 从此不等于「已存」——空推送/无增量/
    # 墓碑窗口都如实回报，调用方与日志能看出「推送了但没写」这件事。
    if tombstoned_msgs:
        return {"ok": True, "count": 0, "tombstoned": True, "written": False}
    return {"ok": True, "count": len(messages), "written": wrote_msgs}


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
    # 画布图状态（T360）：带 graph_merge 的保存走节点级三方合并，防旧设备/旧标签页
    # 整图覆盖抹掉另一台设备刚生成的节点内容。规则见 server/graph_merge.py。
    # 读—合并—写在同一次 await 之间完成（中间无 await），不会被并发请求插队。
    if key.startswith("graph:") and isinstance(payload.get("graph_merge"), dict) and isinstance(payload.get("value"), dict):
        merge_info = payload["graph_merge"]
        value = payload["value"]
        try:
            merged, did_merge = graph_merge.merge_graph_states(
                storage.kv_read(key, None, account=account),
                value,
                merge_info.get("base_node_sigs"),
            )
        except Exception as e:
            # 合并出岔子不该让保存失败：退回整份照存（旧口径），并留日志
            logger.warning(f"Graph state merge failed, storing as-is: {e}")
            merged, did_merge = value, False
        storage.kv_write(key, merged, account=account)
        return {"ok": True, "merged": did_merge, "updatedAt": merged.get("updatedAt") if isinstance(merged, dict) else None}
    storage.kv_write(key, payload.get("value", ""), account=account)
    return {"ok": True}


@router.delete("/api/kv/{key}")
async def api_delete_kv(key: str, request: Request = None):
    storage.kv_delete(key, account=_account_id(request))
    return {"ok": True}
