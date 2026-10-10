"""
PhyMathia Web Application - 物理数学双域解释与可视化助手 (离线测试版)

模型在「模型设置」中配置（支持自定义 OpenAI 兼容模型）。
数据持久化使用 JSON 文件存储，无需 Supabase 或任何外部服务。
"""

import argparse
import asyncio
import base64
import copy
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from contextlib import asynccontextmanager
from logging.config import dictConfig
from pathlib import Path

import uvicorn
import httpx
from uvicorn.config import LOGGING_CONFIG as _UVICORN_LOGGING_CONFIG
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

# ====== 服务端日志文件（T211） ======
# 应用此前只往 console 打日志：logs/server-<port>.log 是 shell 重定向的产物，无限
# append、换端口/启动方式另起新文件永不清理（实测约 0.5MB/h）。这里给应用装上自己的
# 轮转文件句柄——基于 uvicorn 默认 LOGGING_CONFIG 派生，单例 RotatingFileHandler
# 经 dictConfig 同时挂 root 与 uvicorn/uvicorn.access（uvicorn.error 无 handler，
# 记录经 root 传播一并进文件）；每文件 5MB×5 份封顶，console 观感不变。
# 文件不可写（只读目录/权限不足）时整体退回 console-only 原行为。
_LOG_FILE_TEMPLATE = "server-{port}.log"
_LOG_MAX_BYTES = 5 * 1024 * 1024
_LOG_BACKUP_COUNT = 5
_LOG_FORMATTER = "phymathia"
_LOG_FILE_HANDLER = "phymathia_file"
_LOG_CONSOLE_HANDLER = "phymathia_console"


def _resolve_log_file(port: int):
    """返回 logs/server-<port>.log 路径（目录不存在则建）；不可写时返回 None。"""
    base = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(_ROOT_DIR)
    log_dir = base / "logs"
    try:
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / _LOG_FILE_TEMPLATE.format(port=port)
        with open(log_file, "a", encoding="utf-8"):
            pass  # 预建文件＋可写性探测，失败即走 console-only
        return log_file
    except OSError as e:
        logger.warning(f"file logging disabled: cannot write {log_dir} ({e})")
        return None


def _server_log_config(log_file: Path) -> dict:
    """派生 uvicorn 默认日志配置：console 句柄原样保留，另加单例轮转文件句柄。"""
    cfg = copy.deepcopy(_UVICORN_LOGGING_CONFIG)
    cfg["formatters"][_LOG_FORMATTER] = {
        "format": "%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    }
    cfg["handlers"][_LOG_FILE_HANDLER] = {
        "class": "logging.handlers.RotatingFileHandler",
        "formatter": _LOG_FORMATTER,
        "filename": str(log_file),
        "maxBytes": _LOG_MAX_BYTES,
        "backupCount": _LOG_BACKUP_COUNT,
        "encoding": "utf-8",
    }
    # root：dictConfig 的 root 段会整体替换 basicConfig 装的 console 句柄，
    # 所以 console 必须在这里显式列出，否则控制台直接静默
    cfg["handlers"][_LOG_CONSOLE_HANDLER] = {
        "formatter": _LOG_FORMATTER,
        "class": "logging.StreamHandler",
        "stream": "ext://sys.stderr",
    }
    cfg["root"] = {"level": "INFO", "handlers": [_LOG_CONSOLE_HANDLER, _LOG_FILE_HANDLER]}
    # uvicorn 两个自带 handler 的 logger 追加同一文件句柄实例（共享单例，不会出现
    # 两个句柄各转各的轮转混乱）；uvicorn.error 无 handler，靠 root 传播
    for name in ("uvicorn", "uvicorn.access"):
        handlers = cfg["loggers"].setdefault(name, {}).setdefault("handlers", [])
        if _LOG_FILE_HANDLER not in handlers:
            handlers.append(_LOG_FILE_HANDLER)
    return cfg

# ====== FastAPI 应用 ======
def _migrate_kv_split_all_accounts() -> None:
    """启动迁移（幂等）：把主文件里的会话级键与族键搬进各自拆分文件。

    必须逐账号跑：读路由只认拆分落点，非 default 账号主文件里没迁走的旧键
    （T214 前 socratic/mem/quiz/continent 都写主文件）会变成读不到的孤儿。
    单个账号失败只记警告不中断启动——下次启动幂等重跑。
    """
    for account in [accounts.DEFAULT_ACCOUNT, *accounts.load_registry()]:
        try:
            storage.kv_migrate_split_keys(account=account)
        except Exception as e:
            logger.warning(f"kv split migration failed for account {account}: {e}")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    _app.state.http_client = http_client.get_http_client()
    _migrate_kv_split_all_accounts()
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
    parser.add_argument("--no-file-log", action="store_true",
                        help="Disable rotating file logging (logs/server-<port>.log)")
    return parser.parse_args()


if __name__ == "__main__":
    args = parse_args()
    # T211：文件日志在 banner 之前装配，启动横幅与后续 uvicorn 访问日志都进文件；
    # 未启用（--no-file-log 或文件不可写）时 uvicorn 侧保持默认装配，行为不变
    _log_config = None
    if not args.no_file_log:
        _log_file = _resolve_log_file(args.port)
        if _log_file is not None:
            _log_config = _server_log_config(_log_file)
            dictConfig(_log_config)
    logger.info("=" * 50)
    logger.info("PhyMathia (Offline Test Mode)")
    logger.info(f"  - Port: {args.port}")
    logger.info("  - 模型：需在「模型设置」中配置（支持 OpenAI 兼容接口）")
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
        **({"log_config": None} if _log_config is not None else {}),
    )