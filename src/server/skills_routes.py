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


@router.get("/api/skills/capabilities")
async def api_skills_capabilities(request: Request):
    """格式说明书 + 现役清单摘要（第 9 版创造模式「查」端，零模型调用）。

    与 `/api/harness/recipe/capabilities` 同角色：将来的技能工坊提示词、工具层、
    设置页都读这一个口，别各抄一份枚举。
    """
    account = _account_id(request, {})
    return skill_registry.capabilities(account)


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
        "source": saved.get("source") or ("builtin" if saved.get("builtin") else "user"),
        # 覆盖内置时前端要说清「这是你的副本」（保存提示 + 列表徽标都靠它）
        "overridden": bool(saved.get("overridden")),
        "enabled": bool(saved.get("enabled", True)),
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

    body: {"question": "...", "modules": ["viz", ...]}
    （modules 可选，给了就不按问题推断）
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


# ====== 管理面（2026-11-16 第 5 版）：开关 / 导入 ======

@router.post("/api/skills/toggle")
async def api_skills_toggle(request: Request):
    """单条技能开关。body: {"id": "...", "enabled": true|false}。

    内置与自建都能关：只写 `skills_state.json` 的 disabled 列表，内容文件一个字节不动。
    关掉后它不进候选卡、不投递、不进预览（旧快照里留着的计划也不会再注入）。
    """
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式下不能修改技能")
    skill_id = str(payload.get("id") or "").strip()
    on = bool(payload.get("enabled"))
    try:
        state = skill_registry.set_skill_enabled(account, skill_id, on)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning(f"Skill toggle failed: {exc}")
        raise HTTPException(status_code=500, detail="保存技能开关失败，请稍后重试") from exc
    return {"ok": True, "id": skill_id, "enabled": state}


@router.post("/api/skills/router")
async def api_skills_router(request: Request):
    """整条技能路由的总开关。body: {"enabled": true|false}。

    与环境变量 `PHYMATHIA_SKILL_ROUTER=0` 是「与」：环境变量关掉时这里点了开也不生效
    （运维硬关优先），返回里带 `hardOff` 让界面能说清原因。
    """
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式下不能修改技能")
    on = bool(payload.get("enabled"))
    try:
        current = skill_registry.set_router(account, on)
    except Exception as exc:
        logger.warning(f"Skill router toggle failed: {exc}")
        raise HTTPException(status_code=500, detail="保存总开关失败，请稍后重试") from exc
    return {
        "ok": True,
        "enabled": bool(on),
        "hardOff": not skill_registry.env_enabled(),
        "notes": "" if skill_registry.env_enabled() else "环境变量 PHYMATHIA_SKILL_ROUTER 已强制关闭，这里打开的开关不会生效。",
    }


@router.post("/api/skills/scope")
async def api_skills_scope(request: Request):
    """手动指定一条技能的适用节点（第 8 版）。body: {"id": "...", "scope": ["viz", ...]}。

    装进来的主流技能包里没有「适用节点」这个概念，按旧规则会被整条丢掉（悄悄不生效）。
    现在列表里留一条「请指定适用节点」，人点一下走这个接口，结果写 `skills_state.json`
    ——**不动别人的 md 一个字节**。传空数组＝撤销指定，回到「待指定」。
    """
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式下不能修改技能")
    skill_id = str(payload.get("id") or "").strip()
    try:
        scope = skill_registry.set_skill_scope(account, skill_id, payload.get("scope"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning(f"Skill scope assign failed: {exc}")
        raise HTTPException(status_code=500, detail="保存适用节点失败，请稍后重试") from exc
    return {"ok": True, "id": skill_id, "scope": scope, "needsScope": not scope}


@router.post("/api/skills/import")
async def api_skills_import(request: Request):
    """导入 md 技能。两种用法：

    - `{"dryRun": true, "texts": ["--- id: ... ---\\n正文", {"name": "x.md", "text": "..."}]}`
      → 只解析，返回逐条结论（名称/id/节点/字数/冲突/问题），不落盘；
    - `{"skills": [{"id","name","desc","scope","body"}]}`
      → 落盘（逐条走与新建相同的校验，失败不中断其余）。
    """
    payload = await _parse_json_object(request)
    account = _account_id(request, payload)
    if _readonly_request(request):
        raise HTTPException(status_code=403, detail="查阅模式下不能修改技能")
    try:
        if payload.get("dryRun"):
            texts = payload.get("texts")
            if texts is None and payload.get("text") is not None:
                texts = [payload.get("text")]
            return skill_registry.parse_imports(texts, account)
        return skill_registry.import_skills(account, payload.get("skills"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning(f"Skill import failed: {exc}")
        raise HTTPException(status_code=500, detail="导入失败，请稍后重试") from exc
