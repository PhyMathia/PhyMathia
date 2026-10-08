"""
PhyMathia Web Application - 物理数学双域解释与可视化助手 (离线测试版)

使用 opencode 免费模型（无需 API Key），也支持自定义 OpenAI 兼容模型。
数据持久化使用 JSON 文件存储，无需 Supabase 或任何外部服务。
"""

import argparse
import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

# 确保 src/ 与项目根目录都在模块搜索路径（兼容 embeddable python 等环境）
_SRC_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_SRC_DIR)
for _path in (_SRC_DIR, _ROOT_DIR):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from server import http_client  # noqa: E402  共享层：HTTP 客户端单例（lifespan 建连/收尾）
from server import llm_common  # noqa: E402  共享层：网关头/密钥兜底/token 估算唯一事实源
from server import usage_stats  # noqa: E402  共享层：token 用量与缓存命中计量落盘

from server import accounts, backup, concept, continent, context, documents, embedding, family, knowledge, profile, prompts, storage, trash  # noqa: F401
from server.backup import *
from server.config import *
from server.context import *
from server.documents import *
from server.knowledge import *
from server.prompts import *
from server.storage import *
from server.context_preview import router as context_preview_router  # 开发调试用，正式版可删

# ====== 兼容再出口（T163 拆分后 tests/回归脚本仍从 main 命名空间取这些名字）======
# 只再出口「tests/脚本直取/直调」的符号；打桩类名字（get_http_client/
# _summary_tasks/_ai_extract_knowledge/_describe_formulas/UTOPIA_INBOX_DIR）
# 已改靶到属主模块（server.http_client / server.models_routes /
# server.knowledge / server.knowledge_routes），在此再出口反而会留一个
# 补丁打不中的死绑定。
from server.knowledge_routes import (  # noqa: F401
    _card_vector_text,
    _json_get_cache,
    api_delete_formula,
    api_delete_formulas_by_session,
    api_delete_knowledge,
    api_extract_knowledge,
    api_get_continent,
    api_get_families,
    api_get_family_suggestions,
    api_get_formulas,
    api_get_knowledge,
    api_save_formulas,
    api_save_knowledge,
    api_utopia_inbox_get,
)
from server.models_routes import (  # noqa: F401
    _maybe_schedule_rolling_summary,
    _model_pricing_free,
    _run_rolling_summary,
    _summary_tasks,
    _thinking_request_params,
    api_models_chat,
    api_models_list,
    api_models_probe,
    api_usage_stats,
)
from server.profile_routes import (  # noqa: F401
    api_backup_export,
    api_backup_import,
    api_delete_profile,
    api_get_profile,
    api_profile_candidates,
    api_profile_dashboard,
    api_profile_event,
    api_profile_implicit_manage,
    api_profile_manage,
    api_update_profile,
)
from server.session_routes import (  # noqa: F401
    api_accounts_allow_browse,
    api_accounts_create,
    api_accounts_delete,
    api_accounts_list,
    api_accounts_rename,
    api_clear_all_sessions,
    api_clear_messages,
    api_delete_kv,
    api_delete_session,
    api_get_kv,
    api_get_messages,
    api_get_messages_batch,
    api_get_sessions,
    api_save_messages,
    api_save_sessions,
    api_trash_account_purge,
    api_trash_account_restore,
    api_trash_empty,
    api_trash_list,
    api_trash_purge,
    api_trash_restore,
    api_trash_settings,
    api_update_session,
)


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ====== FastAPI 应用 ======
@asynccontextmanager
async def lifespan(_app: FastAPI):
    _app.state.http_client = http_client.get_http_client()
    # KV 会话级键拆分的一次性迁移（幂等）：把主文件里的 graph:/harness_history:
    # 等会话键搬进 data/kv/<sid>.json，成功前不动主文件
    storage.kv_migrate_session_keys()
    try:
        yield
    finally:
        await http_client.close_http_client()


app = FastAPI(
    title="PhyMathia",
    description="物理数学双域解释与可视化助手 (离线测试版)",
    lifespan=lifespan,
)

app.state.harness_context = get_system_prompt()

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from harness.api import router as harness_router

app.include_router(harness_router, prefix="/api/harness")
app.include_router(context_preview_router)  # 开发调试用，正式版可删

app.add_middleware(
    CORSMiddleware,
    # 仅允许本机来源（服务只绑定 127.0.0.1），避免外部网页跨域读取本地 API
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# 静态 JS/CSS/JSON 走 gzip；SSE（text/event-stream）会自动跳过压缩。
app.add_middleware(GZipMiddleware, minimum_size=1024)


# ====== 只读查阅（P3 2026-10-07）：后端兜底闸门 ======
# 前端处于只读查阅态时（config.js 查阅元键 → window.PHYMATHIA_READONLY），fetch
# 包装给所有 /api/ 请求带 X-Phymathia-Readonly 头，并在客户端先拦非 GET。这里按
# 同一张白名单兜底 403——防的是前端漏打的写点闸门让改写请求溜出去，不防手写
# curl（本地无认证，allow_browse 是 UI 层礼节性隔离，诚实声明口径见 backlog T179）。
_READONLY_MUTATING = {"POST", "PUT", "DELETE", "PATCH"}
# 读语义 POST 白名单：上游代理查询，无本地存储写动作，查阅态放行
# （与 config.js PHY_READONLY_SAFE_POST 一字对应，两边同改）
_READONLY_SAFE_POST = {"/api/models/list", "/api/models/probe"}


@app.middleware("http")
async def _readonly_browse_gate(request: Request, call_next):
    if request.method in _READONLY_MUTATING and request.headers.get("x-phymathia-readonly"):
        path = request.url.path
        if path.startswith("/api/") and path not in _READONLY_SAFE_POST:
            return JSONResponse({"detail": "查阅模式：只读，不能修改数据"}, status_code=403)
    return await call_next(request)


@app.middleware("http")
async def _refresh_harness_context(request: Request, call_next):
    # 只在 harness 请求前热刷新系统提示词；普通/静态请求不再产生文件 stat 开销。
    if request.url.path.startswith("/api/harness"):
        request.app.state.harness_context = get_system_prompt()
    return await call_next(request)

# ====== 页面路由 ======
# 显式缓存口径（根治「改了没生效必须 Ctrl+Shift+R」）：应用产物文件名无内容指纹
# （app.js 靠构建时写入 index.html 的 ?v=<内容哈希> 区分版本，HTML 本身必须每次
# 协商才能拿到新哈希），统一发 no-cache——每次协商、ETag 命中回 304、永不 stale。
# 别换成 max-age（哪怕很短）：/vendor/ 第三方本地副本没有版本指纹，长了就是更新不掉。
# /api/*、/v1/*、/health 走各自路由，不经静态通道，结构上不受影响。
_CACHE_NO_CACHE = {"Cache-Control": "no-cache"}


def _static_file_response(request: Request, file_path: Path) -> Response:
    """静态文件响应：no-cache 协商口径 + If-None-Match 命中回 304。

    本环境 starlette(1.6) 的 FileResponse 只发 ETag、不再做条件判定（老版本
    会在响应类内部比对其返回 304）——no-cache 若没有 304，浏览器每次都全量
    重拉。这里按 starlette 同一算法（md5(mtime-size)）自行比对，命中即 304
    并保留缓存头；不命中走 FileResponse（它自带的 ETag 与这里一致）。
    """
    stat = file_path.stat()
    etag = '"%s"' % hashlib.md5(
        f"{stat.st_mtime}-{stat.st_size}".encode(), usedforsecurity=False
    ).hexdigest()
    inm = request.headers.get("if-none-match", "")
    candidates = [t.strip() for t in inm.split(",") if t.strip()]
    if etag in candidates or "*" in candidates:
        return Response(status_code=304, headers={**_CACHE_NO_CACHE, "ETag": etag})
    return FileResponse(str(file_path), headers=_CACHE_NO_CACHE)


@app.get("/")
async def root(request: Request):
    index_html = STATIC_DIR / "index.html"
    if index_html.exists():
        # FileResponse（而非 HTMLResponse）：自带 ETag/Last-Modified，配合
        # no-cache 让普通刷新就能命中 304，构建新产物后普通刷新即拿到新 JS
        return _static_file_response(request, index_html)
    raise HTTPException(status_code=404, detail="Index page not found")


@app.get("/chat")
async def chat_ui(request: Request):
    return await root(request)


@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "PhyMathia is running"}


# ====== 业务路由（T163 拆分：模型对话 / 用户数据 / 知识内容 / 画像备份四域）======
# include 顺序＝原 main.py 路由定义顺序（chat→sessions→knowledge→profile），
# serve_static_file 的 catch-all 必须留在所有 API 路由之后（见其节头注释）。
from server import knowledge_routes, models_routes, profile_routes, session_routes  # noqa: E402
app.include_router(models_routes.router)
app.include_router(session_routes.router)
app.include_router(knowledge_routes.router)
app.include_router(profile_routes.router)

# ====== 静态文件 catch-all（必须放在所有 API 路由之后）======
@app.get("/{filename:path}")
async def serve_static_file(filename: str, request: Request):
    if not filename:
        return await root(request)
    path = Path(filename)
    if path.suffix.lower() in STATIC_EXTENSIONS:
        file_path = (STATIC_DIR / filename).resolve()
        # 防目录穿越：仅允许解析后仍位于 STATIC_DIR 内的文件
        if file_path.is_relative_to(STATIC_DIR.resolve()) and file_path.exists() and file_path.is_file():
            return _static_file_response(request, file_path)
    raise HTTPException(status_code=404, detail="Not found")

# 启动前初始化账号域（默认账号）并清理历史重复知识点：
# ensure_account 幂等——首次启动把 data/ 根的旧全局文件整体搬进 default 账号
# 目录（只 mv 不删，flag 防重跑），之后每请求 ensure 命中缓存零开销。
accounts.ensure_account()
_dedupe_knowledge_file()
try:
    # 回收站过期清理（2026-10-07，全账号惰性兜底；trash 目录缺失时 no-op）
    trash.purge_expired_all()
except Exception as _trash_e:
    logger.warning(f"trash startup purge failed: {_trash_e}")

# ====== 启动 ======
def parse_args():
    parser = argparse.ArgumentParser(description="Start PhyMathia (offline test mode)")
    parser.add_argument("-p", "--port", type=int, default=5050, help="Server port")
    parser.add_argument("--reload", action="store_true", help="Enable auto reload")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    logger.info("=" * 50)
    logger.info("PhyMathia (Offline Test Mode)")
    logger.info(f"  - Port: {args.port}")
    logger.info(f"  - 模型：免费模型模式（opencode，无需 API Key）")
    logger.info("=" * 50)
    logger.info(f"访问地址: http://localhost:{args.port}")
    # 打包版（PyInstaller）自动打开浏览器；开发模式不自动打开
    if getattr(sys, "frozen", False):
        import threading
        import webbrowser
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{args.port}")).start()

    uvicorn.run(
        app,
        host="127.0.0.1",
        port=args.port,
        reload=args.reload,
        workers=1,
    )