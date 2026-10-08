"""请求上下文公共层（T163 自 main.py 收编）：账号域解析与只读查阅判据。

全部账号化路由的单一咽喉（_account_id 的 404 语义＝T186 幽灵闸门）与
只读查阅态判据（T187）都住这里；路由模块经 from .request_ctx import 取用，
闸门中间件（_readonly_browse_gate，留在 main）不经过这里——它只认路径与
方法白名单。命名空间里不持任何路径常量：账号域路径一律调用期经
accounts.resolve_paths 解析（tests 的批量路径重定向夹具因此对路由模块免补丁）。
"""

import asyncio
import json

from fastapi import HTTPException, Request

from . import accounts


async def _parse_json_object(request: Request) -> dict:
    raw = await request.body()
    try:
        payload = await asyncio.to_thread(json.loads, raw)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON object expected")
    return payload


def _readonly_request(request: Request = None) -> bool:
    """请求是否来自只读查阅态（前端 fetch 包装恒带 X-Phymathia-Readonly 头）。

    GET 路由里有「带副作用」的少数派（画像归属登记）：查阅者的动作不能写进
    被查阅账号，用这个判据分流（T187 2026-10-07）。服务端无身份概念，只认头
    ——与 _readonly_browse_gate 同一条诚实声明（防前端漏闸，不防手写 curl）。
    """
    try:
        return bool(request is not None and request.headers.get("x-phymathia-readonly"))
    except Exception:
        return False


# 账号已删/不存在：404 同时带标记头。前端 config.js 的 fetch 包装读它触发
# 「自动切回」重载（指针悬空的活标签页不必等用户手动刷新）；detail 文案给人看、
# 头给代码认——改文案不动这个契约，头名两边同改。
_ACCOUNT_GONE_HEADERS = {"X-Phymathia-Account-Gone": "1"}


def _account_id(request: Request = None, payload: dict = None) -> str:
    """请求的账号域：query account_id → body account_id → default。

    刻意**不回退 device_id**（accounts.py 模块注释有完整论证）：现有前端只在
    一部分请求带 device_id（quiz-stats 的 kv 写带、读不带），拿它当账号键会让
    读写分家。P2 前端落地前所有请求都落 default 账号＝与旧行为逐字节一致。

    已删/不存在的账号一律 404：这是全部账号化路由的单一咽喉，ensure 闸门只拦
    「经 _account_paths 的写」，而 kv_write 等存储原语自带 mkdir 会绕开它把已删
    账号目录在磁盘上拼回来（真机抓出：任务列表的 tasks:global 自动保存踩中）。
    两道判据（T186 2026-10-07 补第二道）：①有墓碑＝保留期内可恢复；②未登记且
    无墓碑＝已被彻底删除（保留 0 天即删 / 墓碑到期清理之后，残留页面的自动保存
    曾把账号连目录带注册表条目一起复活成幽灵空账号）。404 对 sendBeacon 无感、
    对活人 tab 是明白话；恢复账号后两种状态都消失，请求自然恢复。default 无
    墓碑可言、且是兜底落点，零开销直通。
    """
    account = _account_id_raw(request, payload)
    if account != accounts.DEFAULT_ACCOUNT:
        if accounts.has_account_tombstone(account):
            raise HTTPException(
                status_code=404,
                detail="该账号已删除（保留期内可在回收站恢复）",
                headers=dict(_ACCOUNT_GONE_HEADERS),
            )
        if not accounts.is_registered(account):
            raise HTTPException(
                status_code=404,
                detail="该账号不存在（已被彻底删除）",
                headers=dict(_ACCOUNT_GONE_HEADERS),
            )
    return account


def _account_id_raw(request: Request = None, payload: dict = None) -> str:
    if request is not None:
        try:
            q = request.query_params.get("account_id") or request.query_params.get("accountId")
        except Exception:
            q = None
        if q:
            return accounts.validate_account_id(q)
    if isinstance(payload, dict):
        v = payload.get("account_id") or payload.get("accountId")
        if v:
            return accounts.validate_account_id(v)
    return accounts.DEFAULT_ACCOUNT


def _account_paths(request: Request = None, payload: dict = None):
    """账号域解析 + 目录确保（ensure_account 幂等，热路径有 _ENSURED 缓存）。"""
    return accounts.ensure_account(_account_id(request, payload))
