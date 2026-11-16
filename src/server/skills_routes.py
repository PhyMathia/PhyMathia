"""技能（skill）路由：用户自建 skill 的读写（2026-11-16 skill 系统第 2 版）。

只管**内容资产**的增删改查；要不要挂、挂给谁都由 `skill_registry` 的候选卡与分析步
那个 `<skill_plan>` 决定，这里不掺和判定。

账号口径与其它路由一致：走 `request_ctx._account_id`（请求头/载荷），查阅模式
（只读）由 `_readonly_request` 拦。写失败一律 400 带中文原因，前端直接弹给用户。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Request

from . import skill_registry
from .request_ctx import _account_id, _parse_json_object, _readonly_request

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/api/skills")
async def api_skills_list(request: Request):
    """列出当前账号可用的全部 skill（内置只读 + 自建可改）。"""
    account = _account_id(request, {})
    return skill_registry.list_for_ui(account)


@router.post("/api/skills/save")
async def api_skills_save(request: Request):
    """新建或更新一条自建 skill。

    body: {"id", "name", "desc", "scope": ["viz", ...], "body"}
    返回 {"ok": true, "skill": {...}}；非法输入 400 + 中文原因（前端直接展示）。
    """
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式下不能修改技能")
    try:
        saved = skill_registry.save_skill(account, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # 磁盘异常等，别让 500 页面吓到用户
        logger.warning(f"Skill save failed: {exc}")
        raise HTTPException(status_code=500, detail="技能保存失败，请稍后重试") from exc
    return {"ok": True, "skill": {
        "id": saved.get("id", ""),
        "name": saved.get("name", ""),
        "desc": saved.get("desc", ""),
        "scope": saved.get("scope", []),
        "chars": len(saved.get("body", "")),
        "builtin": bool(saved.get("builtin")),
    }}


@router.post("/api/skills/delete")
async def api_skills_delete(request: Request):
    """删一条自建 skill。body: {"id"}。内置的删不掉（400 说明原因）。"""
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式下不能修改技能")
    skill_id = str(payload.get("id") or "").strip()
    if not skill_id:
        raise HTTPException(status_code=400, detail="缺少 id")
    try:
        removed = skill_registry.delete_skill(account, skill_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": bool(removed), "id": skill_id}


@router.get("/api/skills/candidates")
async def api_skills_candidates(request: Request):
    """调试口：某个账号有哪些 skill 会在给定下游模块上成为候选。

    query: ?modules=viz,learn（逗号分隔）；不给 modules 就是全部。
    用来在设置页里回答「这条技能会被哪些节点看到」。
    """
    account = _account_id(request, {})
    raw = str(request.query_params.get("modules") or "").strip()
    modules = [m for m in raw.replace("，", ",").split(",") if m.strip()] if raw else []
    items = skill_registry.by_scope(modules, account)
    return {
        "modules": modules or list(skill_registry.MODULE_LABELS),
        "skills": [{"id": i["id"], "name": i["name"], "scope": i["scope"]} for i in items],
    }


@router.post("/api/skills/preview")
async def api_skills_preview(request: Request):
    """「试一条」：给一个问题，回答候选/字数/实际注入的正文。**不跑模型，零 token。**

    body: {"question": "...", "modules": ["viz", ...]}（modules 可选，给了就不按问题推断）
    读操作，查阅模式下也放行——它不落盘、不给账号写任何东西。
    """
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    question = str(payload.get("question") or "")
    raw_modules = payload.get("modules")
    if isinstance(raw_modules, str):
        raw_modules = raw_modules.replace("，", ",").split(",")
    if not isinstance(raw_modules, list):
        raw_modules = []
    return skill_registry.preview(question, raw_modules, account)
