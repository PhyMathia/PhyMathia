"""画像与备份路由（T163 自 main.py 收编）：设备画像 CRUD/隐式画像、
记忆候选与管理、备份导出导入。
"""

import logging

from fastapi import APIRouter, HTTPException, Request

from . import profile
from .backup import _build_backup_payload, _restore_backup
from .request_ctx import _account_id, _parse_json_object, _readonly_request

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/api/profile/candidates")
async def api_profile_candidates(request: Request):
    """画像候选通用入口：确定性信号（检测错题/苏格拉底答错等）直接落候选。

    body: {"device_id": str, "candidates": [{"fact", "category", "sourceSession"?}], "source"?}
    合并语义与对话采集一致（new/规范化查重/两击固化），返回 {"changed", "promoted"}。
    """
    payload = await _parse_json_object(request)
    device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if not device_id:
        raise HTTPException(status_code=400, detail="缺少 device_id")
    candidates = payload.get("candidates")
    # 单批上限：正常信号源（检测/提取）一次最多几条，超量只可能是异常或恶意输入
    if isinstance(candidates, list):
        candidates = candidates[:50]
    source = str(payload.get("source") or "signal")[:32]
    try:
        return profile.apply_profile_ops(device_id, candidates, source=source, report_acceptance=True)
    except Exception as e:
        logger.warning(f"Profile candidates ingest failed: {e}")
        raise HTTPException(status_code=500, detail="记忆候选保存失败，请稍后重试") from e


@router.post("/api/profile/manage")
async def api_profile_manage(request: Request):
    """画像条目原子管理操作：只动目标 ID，不整份覆盖其他数据（并发安全）。

    body: {"device_id": str, "action": delete_fact|restore_fact|confirm_pending|
           delete_pending|restore_archive|delete_archive, "fact_id": str}
    返回 {"changed", "promoted", "accepted"}；accepted=false 表示 ID 不存在或
    容量不足（200，与 400 参数错误区分）。记忆开关关闭时管理操作仍可用。
    """
    payload = await _parse_json_object(request)
    device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if not device_id:
        raise HTTPException(status_code=400, detail="缺少 device_id")
    action = str(payload.get("action") or "")
    fact_id = str(payload.get("fact_id") or payload.get("factId") or "")
    if action not in ("delete_fact", "restore_fact", "confirm_pending", "delete_pending", "restore_archive", "delete_archive") or not fact_id:
        raise HTTPException(status_code=400, detail="无效 action 或缺少 fact_id")
    try:
        return profile.manage_profile_fact(device_id, action, fact_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

# ====== 用户画像（记忆）API ======
@router.get("/api/profile")
async def api_get_profile(device_id: str = ""):
    return profile.get_profile(device_id)


@router.put("/api/profile")
async def api_update_profile(request: Request):
    payload = await _parse_json_object(request)
    device_id = str(payload.get("device_id") or "")
    updates = payload.get("updates")
    if not isinstance(updates, dict):
        raise HTTPException(status_code=400, detail="updates must be an object")
    return profile.update_profile(device_id, updates)


@router.delete("/api/profile")
async def api_delete_profile(device_id: str = ""):
    profile.delete_profile(device_id)
    return {"ok": True}


@router.post("/api/profile/event")
async def api_profile_event(request: Request):
    """隐式画像事件上报（前端 expand/visualize/difficulty 等纯前端信号）。

    body: {"device_id": str, "events": [{"type", "topic"?, "value"?}...]}
    fire-and-forget 语义：失败只记日志，绝不影响调用方 UI。
    """
    payload = await _parse_json_object(request)
    device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if not device_id:
        raise HTTPException(status_code=400, detail="缺少 device_id")
    events = payload.get("events")
    if not isinstance(events, list) or not events or len(events) > 20:
        raise HTTPException(status_code=400, detail="events must be a non-empty list (≤20)")
    recorded = profile.record_implicit_event(device_id, events, account=_account_id(request, payload))
    return {"ok": True, "recorded": bool(recorded)}


@router.post("/api/profile/implicit")
async def api_profile_implicit_manage(request: Request):
    """隐式画像面板管理：freeze / unfreeze / set / reset（可见可纠原则的用户侧）。"""
    payload = await _parse_json_object(request)
    device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if not device_id:
        raise HTTPException(status_code=400, detail="缺少 device_id")
    try:
        return profile.manage_implicit(device_id, str(payload.get("action") or ""),
                                       dim=str(payload.get("dim") or ""),
                                       key=str(payload.get("key") or ""),
                                       value=payload.get("value"))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/api/profile/dashboard")
async def api_profile_dashboard(request: Request = None, device_id: str = ""):
    """画像仪表盘：隐式状态的派生视图（衰减/保留/成熟度/账本都在服务端算）。"""
    if not device_id:
        raise HTTPException(status_code=400, detail="缺少 device_id")
    account = _account_id(request)
    # 打开画像面板＝最自然的归属登记点（新账号首次看面板即绑定，无需先聊天）。
    # 只读查阅态跳过（T187）：查阅者的设备不能绑进被查阅账号——否则挤占对方
    # 绑定上限（8 个）、对方备份带走查阅者画像、对方彻底清除时误删查阅者画像
    # 文件。面板本身照常出（读的是查阅者自己 device 的画像，不是对方的）。
    if not _readonly_request(request):
        profile.note_device_binding(device_id, account=account)
    return profile.implicit_dashboard(device_id)



@router.get("/api/backup/export")
async def api_backup_export(request: Request = None):
    # 查阅态拒绝整包导出（2026-10-07 拍板，T187 顺带项）：allowBrowse 的礼节是
    # 「只读查阅此账号的会话与知识」，整包 .pmu 是把对方全部内容（消息/知识/
    # KV/画像）一次带走，超出浏览语义——读得走、搬不走。PNG 海报与单画布
    # .pmu（纯前端产物）不受影响。前端 ui.js exportData 同步有闸（先礼后兵）。
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式：只读，不能导出对方数据")
    account = _account_id(request)
    # 设备提示（前端 2026-10-07 起恒传）：画像按账号隔离的圈定键——导出只带
    # 本账号归属的画像设备；顺手登记绑定，归属随首次导出/使用自然长全
    device_id = str(request.query_params.get("device_id") or "") if request is not None else ""
    if device_id:
        profile.note_device_binding(device_id, account=account)
    return _build_backup_payload(account, device_id)


@router.post("/api/backup/import")
async def api_backup_import(request: Request):
    payload = await _parse_json_object(request)
    backup = payload.get("backup") if isinstance(payload.get("backup"), dict) else payload
    if not isinstance(backup, dict):
        raise HTTPException(status_code=400, detail="Backup payload must be an object")
    mode = str(payload.get("mode") or "merge").lower()
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="mode must be merge or replace")
    account = _account_id(request, payload)
    device_id = str(payload.get("device_id") or "")
    if device_id:
        profile.note_device_binding(device_id, account=account)
    try:
        return _restore_backup(backup, mode == "replace", account=account, device_id=device_id)
    except HTTPException:
        raise
    except Exception as exc:
        # _restore_backup 失败时已整体回滚，把回滚报告带回给调用方
        raise HTTPException(status_code=500, detail=str(exc))
