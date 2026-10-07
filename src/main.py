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
from fastapi.responses import FileResponse, HTMLResponse, Response, StreamingResponse
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

# 确保 src/ 与项目根目录都在模块搜索路径（兼容 embeddable python 等环境）
_SRC_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_SRC_DIR)
for _path in (_SRC_DIR, _ROOT_DIR):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from http_client import close_http_client, get_http_client  # noqa: E402
import llm_common  # noqa: E402  项目根共享层：网关头/密钥兜底/token 估算唯一事实源
import usage_stats  # noqa: E402  项目根共享层：token 用量与缓存命中计量落盘

from server import accounts, backup, concept, continent, context, documents, embedding, family, knowledge, profile, prompts, storage  # noqa: F401
from server.backup import *
from server.config import *
from server.context import *
from server.documents import *
from server.knowledge import *
from server.prompts import *
from server.storage import *
from server.context_preview import router as context_preview_router  # 开发调试用，正式版可删

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ====== FastAPI 应用 ======
@asynccontextmanager
async def lifespan(_app: FastAPI):
    _app.state.http_client = get_http_client()
    # KV 会话级键拆分的一次性迁移（幂等）：把主文件里的 graph:/harness_history:
    # 等会话键搬进 data/kv/<sid>.json，成功前不动主文件
    storage.kv_migrate_session_keys()
    try:
        yield
    finally:
        await close_http_client()


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


async def _parse_json_object(request: Request) -> dict:
    """统一解析 JSON 对象 body：非法 JSON / 非对象（list/str/number）一律 400，
    避免后续 payload.get(...) 抛 AttributeError 变成 500。大 body（文档上传
    可达 100MB 级 JSON 串）的 json.loads 卸到工作线程，不阻塞事件循环。"""
    raw = await request.body()
    try:
        payload = await asyncio.to_thread(json.loads, raw)
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON object expected")
    return payload


def _account_id(request: Request = None, payload: dict = None) -> str:
    """请求的账号域：query account_id → body account_id → default。

    刻意**不回退 device_id**（accounts.py 模块注释有完整论证）：现有前端只在
    一部分请求带 device_id（quiz-stats 的 kv 写带、读不带），拿它当账号键会让
    读写分家。P2 前端落地前所有请求都落 default 账号＝与旧行为逐字节一致。
    """
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



@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    """兼容占位：本地 Mock 已移除，请通过前端模型设置使用真实模型（可用 opencode 免费模型）。"""
    raise HTTPException(status_code=400, detail="本地 Mock 已移除，请在模型设置中配置 AI 模型（可直接使用免费模型）")


def _opencode_session_headers(base_url: str, session_id: str) -> dict:
    """OpenCode 网关（opencode.ai）的会话标识头，唯一实现在
    llm_common.opencode_gateway_headers（harness 侧同源）；这里保留本名作
    转发，x-opencode-session 取当前聊天会话 id——同会话保持稳定，网关按它
    路由并优化 prompt 缓存。非 opencode.ai 域名不附加任何头。"""
    return llm_common.opencode_gateway_headers(base_url, session_id)


_BUCKET_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _normalize_session_bucket(value) -> str:
    """辅助调用的会话桶名白名单消毒：不合法一律退回空（落匿名桶）。"""
    text = str(value or "").strip()
    return text if _BUCKET_RE.match(text) else ""


def _chat_request_headers(provider: str, api_key: str, base_url: str, session_id: str) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key and provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, session_id))
    return headers


def _thinking_request_params(provider: str, level: str) -> dict:
    """「思考程度」→ 上游请求参数（薄包装）。

    唯一实现已下沉 llm_common.thinking_request_params（2026-09-30，Φ 智能体
    按相位接同一张表）；此处保留同名函数，调用方与直测它的用例零改动。
    """
    return llm_common.thinking_request_params(provider, level)


def _log_cache_hit_rate(usage) -> None:
    """前缀缓存命中率观测（2026-09-25）：供应商 usage 带命中字段时打一行，
    缺失（端点不报/没开缓存）静默。仅日志旁路，不影响主请求。"""
    parsed = usage_stats.parse_usage(usage)
    if not parsed or parsed["cache_hit_tokens"] is None:
        return
    prompt_tokens = parsed["prompt_tokens"] or 0
    hit = parsed["cache_hit_tokens"]
    pct = round(hit * 100 / prompt_tokens) if prompt_tokens > 0 else 0
    logger.info(f"AI proxy cache: hit {hit}/{prompt_tokens} tok ({pct}%)")


@app.post("/api/models/chat")
async def api_models_chat(request: Request):
    """代理请求到 AI API，流式返回 OpenAI 格式 SSE。
    支持两种调用格式：
    1. 新格式：{prompt, level, session_id, provider, api_key, model, base_url}
       → 后端构建消息（系统提示词 + 难度后缀 + 会话上下文）
       仅受理画布锚定请求（branch_id / graph_path / workflow_context 至少其一）：
       无锚普通提问是已退役线性主聊天的直调通道，2026-09-25 起硬门禁 410。
    2. 旧格式：{messages, provider, api_key, model, base_url}
       → 直接使用传入的 messages（测验 / 知识 / 大陆 / 可视化等辅助功能仍走它）
    """
    payload = await _parse_json_object(request)

    # 线性主聊天退役硬门禁（2026-09-25，见 docs/dev/linear-chat-retired.md）：
    # prompt 新格式必须带画布锚——分支/苏格拉底（branch_id / graph_path）或
    # 工作流（workflow_context）；quick 寒暄同属线性语义，即便带锚也拒绝
    # （前端寒暄通道已随线性退役，此处只防外部直调）。messages 直传不受影响。
    if payload.get("prompt"):
        has_anchor = bool(
            payload.get("branch_id") or payload.get("branchId")
            or payload.get("graph_path") or payload.get("graphPath")
            or payload.get("workflow_context") or payload.get("workflowContext")
        )
        if payload.get("quick"):
            raise HTTPException(
                status_code=410,
                detail="quick 寒暄通道已随线性主聊天退役（2026-09-25），不再受理",
            )
        if not has_anchor:
            raise HTTPException(
                status_code=410,
                detail="无锚普通 prompt 已随线性主聊天退役（2026-09-25）："
                       "分支/苏格拉底请带 branch_id 或 graph_path，工作流请带 workflow_context",
            )


    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model_name = payload.get("model", "")
    if not model_name and provider == "deepseek":
        model_name = "deepseek-chat"
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)
    context_budget = resolve_context_budget(model_name)
    account = _account_id(request, payload)

    if not api_key and provider not in ("opencode", "opencode-go", "llama", "local"):
        raise HTTPException(
            status_code=400,
            detail=f"未配置 {provider} API Key：请在项目根目录 .env 中设置 DEEPSEEK_API_KEY，或在模型配置中填写密钥",
        )

    # 构建消息列表
    prompt = payload.get("prompt", "")
    session_id = payload.get("session_id", "")
    # 辅助调用会话桶（2026-09-21 分桶拍板）：旧格式直传的调用（测验/大陆/摘要
    # 优化/可视化）没有聊天会话 id，此前全部落进同一个「匿名桶」，网关侧互相
    # 挤占缓存路由。前端按功能传稳定桶名，消毒后与 session_id 二选一用作
    # x-opencode-session；新格式聊天永远以 session_id 优先。
    session_bucket = _normalize_session_bucket(
        payload.get("session_bucket") or payload.get("sessionBucket") or "")
    branch_id = payload.get("branch_id") or payload.get("branchId") or ""
    branch_type = payload.get("branch_type") or payload.get("branchType") or ""
    source_module = payload.get("source_module") or payload.get("sourceModule") or ""
    parent_id = payload.get("parent_id") or payload.get("parentId") or ""
    graph_path = payload.get("graph_path") or payload.get("graphPath") or []
    if not isinstance(graph_path, list):
        # _graph_path_instruction 会逐项 item.get，字符串/数字进来就是 500
        raise HTTPException(status_code=400, detail="graph_path must be a list")
    workflow_context = payload.get("workflow_context") or payload.get("workflowContext") or {}
    socratic_mode = "answer"  # 显式初始化：此前靠三个前缀分支隐式保证，漏一个分支就 NameError
    socratic_ref = branch_id or session_id
    # 画像注入快照（角标用）：在函数作用域先声明——messages 旧格式不进入
    # prompt 分支，若只在分支内赋值，两个响应出口引用它会报 free variable 未绑定
    profile_usage = None
    if prompt:
        # 新格式：后端构建消息
        is_socratic_prompt = _is_socratic_prompt_text(prompt)
        if is_socratic_prompt:
            if prompt.lstrip().startswith("[苏格拉底提示]"):
                socratic_mode = "hint"
            elif prompt.lstrip().startswith("[苏格拉底讲解]"):
                socratic_mode = "explain"
            else:
                socratic_mode = "answer"
        if not branch_id and is_socratic_prompt:
            # 手动输入 [苏格拉底回答] 且未带分支时，自动定位最近仍在进行的苏格拉底分支
            resolved_branch = _resolve_socratic_branch(session_id, account)
            if resolved_branch:
                branch_id = resolved_branch
                socratic_ref = resolved_branch
                if not branch_type:
                    branch_type = "socratic"
                if not source_module:
                    source_module = "extend"
        socratic_state = _read_socratic_state(socratic_ref, account) if socratic_ref else None
        if socratic_state and not is_socratic_prompt:
            # 非苏格拉底的新提问开始时，结束当前苏格拉底支线
            _delete_socratic_state(socratic_ref, account)
            socratic_state = None
        include_socratic = bool(socratic_state) or is_socratic_prompt
        if socratic_state and is_socratic_prompt:
            # 延续中的闭环：用本次消息里的问题/等级刷新状态（保留连对次数与已答轮数）
            _sync_socratic_state_from_prompt(socratic_state, prompt)
            _write_socratic_state(socratic_ref, socratic_state, account)

        # quick 寒暄提示词分支已随退役门禁删除（QUICK_SYSTEM_PROMPT 同步移除）：
        # 能走到这里的 prompt 请求必带锚，只剩工作流与分支两条路径
        if workflow_context:
            system_content = MODULE_SYSTEM_PROMPT
        else:
            system_content = get_system_prompt()
        # 前缀缓存拍板（2026-09-21）：system 只保留场景底座。逐轮易变的注入
        # （支线状态/分支/路径/工作流/会话记忆/概念地基/画像）原来追加在 system
        # 尾部——位于历史之前，任何一处变化都会把「system+全部历史」的 provider
        # 前缀缓存整个打灭。现在统一收进「上下文块」，拼在历史之后的最后一条
        # user 消息头部：易变字节集中到请求末尾，system+历史成为稳定前缀。
        context_parts = []
        # T4 前缀缓存拍板（2026-10-01）：工作流上下文拆 shared/target 两段，shared
        # 段（question/analysis/upstream，兄弟模块逐字节相同）提到苏格拉底/分支/路径
        # 指令之前——兄弟模块公共前缀从仅 system（~698 字）延长到 system＋共享段；
        # 路径指令（含逐模块不同的自节点行与「当前聚焦气泡」行）与 target 段落到
        # 公共前缀之后的缓存断点。后文滚动记忆 context_parts.insert(0, memory_block)
        # 仍插在 shared 之前——记忆对兄弟模块也恒同字节，顺序无碍。
        _wf_shared, _wf_target = ("", "")
        if workflow_context:
            _wf_shared, _wf_target = _workflow_context_parts(workflow_context)
            if _wf_shared:
                context_parts.append(_wf_shared)
        state_instruction = _socratic_state_instruction(socratic_ref, socratic_mode, account=account) if socratic_ref and is_socratic_prompt else ""
        if state_instruction:
            context_parts.append(state_instruction)

        if branch_id:
            context_parts.append(_branch_context_instruction(branch_type, source_module, payload.get("branch_label") or payload.get("branchLabel") or "", parent_id))
        if graph_path:
            context_parts.append(_graph_path_instruction(graph_path, source_module))
            # 前缀缓存拍板（2026-09-25 三代窗）：父与祖父的 ~800 字详摘要进尾
            # 部块，与当前节点全文一起构成「当前全文 + 上两代详情」——下钻时尾
            # 部本就在缓存断点之后，细节零缓存代价；兄弟分叉时该段逐字节相同。
            _upstream_block = context.tree_upstream_detail_block(
                session_id, graph_path, source_module=source_module, branch_id=branch_id, account=account)
            if _upstream_block:
                context_parts.append(_upstream_block)
            # 前缀缓存拍板（2026-09-24）：路径历史区 assistant 一律摘要（只增不
            # 改），当前聚焦节点全文改由尾部上下文块提供——工作流模块再生成的
            # 唯一全文输入也随之落在这里。
            _active_block = context.tree_active_content_block(
                session_id, graph_path, source_module=source_module, branch_id=branch_id, account=account)
            if _active_block:
                context_parts.append(_active_block)
        # 2026-09-25 线性主聊天退役：linear_active_content_block 尾部块随现役 UI
        # 的线性通道一起删除（恢复见 docs/dev/linear-chat-retired.md）。
        # T4（2026-10-01）：target 段（当前生成目标/严格格式指令，逐模块各异）仍在
        # 路径与树尾部块之后——留在兄弟公共前缀之外，不回头挤缓存命中。
        if _wf_target:
            context_parts.append(_wf_target)
        # 概念地基（M4 / P1-A）：knowledge 条目首次作为检索基底参与 prompt——
        # 消息层管「我们聊到哪」，这一段管「这个话题的地基是什么」。
        # 与画像注入同一范围（graph_path-only 锚定请求；画布模块生成 workflow_context
        # 与支线 branch_id 不注入）：
        # 支线与模块重生成是局部动作，多这一层只会挤 token。查空返回空串 = 零回归。
        # 记忆第二步「用起来」：画像薄弱词传给检索作排序加权（只重排、不放水）。
        _device_id = payload.get("device_id") or payload.get("deviceId") or ""
        if not workflow_context and not branch_id:
            concept_text = concept.concept_context_text(
                prompt, session_id=session_id,
                weak_terms=(profile.profile_weak_terms(_device_id) if _device_id else None),
                account=account,
            )
            if concept_text:
                context_parts.append(concept_text)
        # 用户画像（记忆）注入：仅 graph_path-only 锚定请求（画布模块生成 / 支线
        # 不注入——与上方概念地基同一范围，09-20 补齐 branch_id：此前支线也会
        # 注入画像并刷新 lastUsedAt，与注释宣称的口径不一致）。
        # 契约化段落 + 注入回写：命中的事实记 lastUsedAt，长期未命中的自动休眠。
        # 同时把「本次实际注入了什么」随响应回传（角标不再按前端缓存重算）。
        if not workflow_context and not branch_id:
            if _device_id:
                _profile_ctx = profile.profile_context(_device_id, account=account)
                profile_usage = {"sections": _profile_ctx["sections"],
                                 "factCount": len(_profile_ctx["factIds"])}
                if _profile_ctx["text"]:
                    context_parts.append(_profile_ctx["text"])
                    profile.mark_profile_used(_device_id, _profile_ctx["factIds"])
        messages = [{"role": "system", "content": system_content}]

        if session_id:
            # 命名为 history：局部变量不能遮蔽模块名 context（server.context），
            # 否则后续在函数内补用 context._xxx 会拿到 list 而 AttributeError
            history = _load_session_context(
                session_id,
                include_socratic=include_socratic,
                branch_id=branch_id,
                branch_type=branch_type,
                source_module=source_module,
                parent_id=parent_id,
                graph_path=graph_path,
                max_rounds=3,
                current_prompt=prompt,
                workflow_context=workflow_context,
                budget_tokens=context_budget,
                account=account,
            )
            messages.extend(history)
            # 会话记忆并入上下文块首位（不再插在历史第 0 位，见
            # context.rolling_memory_block 的拍板说明）
            memory_block = context.rolling_memory_block(session_id, account)
            if memory_block:
                context_parts.insert(0, memory_block)

        current_text = prompt
        if context_parts:
            current_text = "<上下文>\n" + "\n\n".join(context_parts) + "\n</上下文>\n\n" + prompt

        level = payload.get("level", "university")
        level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
        messages.append({"role": "user", "content": current_text + level_suffix})

        ctx_text = "".join(str(m.get("content") or "") for m in messages)
        logger.info(f"AI proxy (built msgs): {provider}/{model_name}, level={level}, msgs={len(messages)}, ctx_chars={len(ctx_text)}, est_tokens={estimate_tokens(ctx_text)}, budget={context_budget}")
    else:
        # 旧格式：直接使用传入的 messages（兼容向后）
        messages = payload.get("messages", [])
        if not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
            # 逐项 m.get 前先挡掉契约外形状（字符串/数字元素），别变成 500
            raise HTTPException(status_code=400, detail="'messages' must be a list of message objects")
        raw_text = "".join(str(m.get("content") or "") for m in messages)
        logger.info(f"AI proxy (raw msgs): {provider}/{model_name}, msg_count={len(messages)}, ctx_chars={len(raw_text)}, est_tokens={estimate_tokens(raw_text)}")

    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if provider_info:
            base_url = provider_info["base_url"]
        else:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")

    # 防 SSRF 外发 .env 密钥：env 兜底 key 只允许发往官方域名；远程端点强制 https
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = _chat_request_headers(provider, api_key, base_url, session_id or session_bucket)
    target = workflow_context.get("target") or {} if isinstance(workflow_context, dict) else {}
    module_key = target.get("module") or source_module
    is_strict_module = module_key in ("socratic", "learn") and (
        target.get("kind") == "module" or branch_type == "blank"
    )
    max_tokens = payload.get("max_tokens")
    if is_strict_module and not max_tokens:
        max_tokens = STRICT_MODULE_MAX_TOKENS
    body = {
        "model": model_name,
        "messages": messages,
        "stream": stream,
    }
    if stream:
        # 流式也要计量：include_usage 让上游在 [DONE] 前补一帧带 usage 的 chunk；
        # 不认识的兼容端点会整请求 400，由下方降级链剥掉重发
        body["stream_options"] = {"include_usage": True}
    if max_tokens:
        try:
            body["max_tokens"] = int(max_tokens)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="max_tokens must be an integer")
    # 思考程度（模型配置弹窗按条目设置）：仅显式选择时注入对应供应商的思考参数
    thinking_params = _thinking_request_params(provider, str(payload.get("thinking") or ""))
    if thinking_params:
        body.update(thinking_params)

    if session_id and prompt:
        _maybe_schedule_rolling_summary(session_id, provider, api_key, model_name, base_url, account=account)

    logger.info(f"AI proxy: {provider}/{model_name} -> POST {url}")

    # 上游请求先发出、拿到状态码之后再决定响应形态：
    # 旧实现把上游非 200 塞进 SSE 错误帧、HTTP 状态仍是 200，调用方无法用
    # resp.ok 分辨失败；stream=false 分支也裸吐上游 JSON 却带 event-stream 媒体类型
    client = get_http_client()

    async def _send_upstream():
        req = client.build_request("POST", url, json=body, headers=headers,
                                   timeout=httpx.Timeout(180.0, connect=15.0))
        return await client.send(req, stream=True)

    try:
        resp = await _send_upstream()
    except httpx.HTTPError as e:
        logger.error(f"AI proxy connect error: {e}")
        raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    if resp.status_code == 400 and "stream_options" in body:
        # 降级第一级：该供应商不认识 stream_options（整请求 400）时剥掉重发。
        # 与思考参数的降级分开两级剥——为保计量帧不该丢思考档，反之亦然
        await resp.aclose()
        body.pop("stream_options", None)
        logger.warning("AI proxy: upstream rejected stream_options, retried without it")
        try:
            resp = await _send_upstream()
        except httpx.HTTPError as e:
            logger.error(f"AI proxy connect error: {e}")
            raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    if resp.status_code == 400 and thinking_params:
        # 降级安全网：该供应商不认识思考参数（整请求 400）时剥掉重发一次——
        # 配错了供应商只会「设置不生效」，绝不能把聊天本身弄坏
        await resp.aclose()
        for key in thinking_params:
            body.pop(key, None)
        logger.warning(f"AI proxy: upstream rejected thinking params {sorted(thinking_params)}, retried without them")
        try:
            resp = await _send_upstream()
        except httpx.HTTPError as e:
            logger.error(f"AI proxy connect error: {e}")
            raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    logger.info(f"AI proxy response: {resp.status_code} from {url}")

    if resp.status_code != 200:
        try:
            error_body = await resp.aread()
        finally:
            await resp.aclose()
        error_text = error_body.decode(errors='replace')[:500]
        logger.error(f"AI proxy upstream error: status={resp.status_code} body={error_text} url={url}")
        # T43：401/403 或正文命中凭证错误时，文案带上「换钥」引导而非只报状态码
        raise HTTPException(status_code=502, detail=llm_common.upstream_error_detail(resp.status_code, error_text))

    if not stream:
        try:
            raw = await resp.aread()
        finally:
            await resp.aclose()
        text = raw.decode(errors="replace")
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            # 上游 200 却回非 JSON 正文（网关错误页等）：原样透传，但别让
            # 下面的状态更新/快照回填跟着裸 except 一起静默蒸发
            logger.warning("AI proxy non-stream: upstream 200 with non-JSON body")
            return Response(content=raw, media_type="application/json")
        try:
            content = data["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            logger.warning("AI proxy non-stream: upstream JSON missing choices[0].message.content")
            return Response(content=raw, media_type="application/json")
        if data.get("usage"):
            logger.info(f"AI proxy usage: {data['usage']}")
            usage_stats.record_usage(provider, model_name,
                                     "chat" if prompt else "legacy",
                                     session_id or session_bucket, data["usage"])
            _log_cache_hit_rate(data["usage"])
        _update_socratic_state_from_content(content, socratic_ref)
        if profile_usage is not None:
            # 非流式出口同样回传注入快照；序列化失败退回原字节
            try:
                data["profile_usage"] = profile_usage
                return Response(content=json.dumps(data, ensure_ascii=False),
                                media_type="application/json")
            except (TypeError, ValueError):
                pass
        return Response(content=raw, media_type="application/json")

    async def proxy_stream():
        try:
            streamed_content = []
            streamed_len = 0
            last_usage = None
            # 注入快照先于正文下发：角标在正文渲染前就能拿到「本次实际注入」，
            # 且协议向后兼容——不认识该字段的客户端只会当作无 delta 的帧跳过
            if profile_usage is not None:
                yield f"data: {json.dumps({'profile_usage': profile_usage}, ensure_ascii=False)}\n\n"
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str != "[DONE]":
                        try:
                            data = json.loads(data_str)
                            if data.get("usage"):
                                last_usage = data["usage"]
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            delta_text = delta.get("content")
                            if not delta_text:
                                delta_text = delta.get("reasoning_content") or ""
                            if delta_text and streamed_len < 200_000:
                                # 仅用于结束后提取苏格拉底状态，封顶防止超长流式回复无上限累积
                                streamed_content.append(delta_text)
                                streamed_len += len(delta_text)
                        except Exception:
                            pass
                    yield line + "\n\n"
            if last_usage:
                logger.info(f"AI proxy usage: {last_usage}")
                usage_stats.record_usage(provider, model_name,
                                         "chat" if prompt else "legacy",
                                         session_id or session_bucket, last_usage)
                _log_cache_hit_rate(last_usage)
            _update_socratic_state_from_content("".join(streamed_content), socratic_ref, account)
        except Exception as e:
            logger.error(f"AI proxy error: {e}")
            yield f"data: {json.dumps({'error': 500, 'detail': str(e)})}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            await resp.aclose()

    return StreamingResponse(proxy_stream(), media_type="text/event-stream")



def _model_pricing_free(item: dict):
    """T60：从上游模型条目推断免费/付费——pricing 全 0 视为免费、任一非 0 视为
    付费；没有 pricing 或字段读不了返回 None（不标注，别瞎猜）。金额各家形态
    不一（OpenRouter 是字符串、有的是数值），统一 float 再比。"""
    pricing = item.get("pricing") if isinstance(item, dict) else None
    if not isinstance(pricing, dict) or not pricing:
        return None
    vals = []
    for key in ("prompt", "completion"):
        if key not in pricing or pricing[key] is None:
            continue
        try:
            vals.append(float(pricing[key]))
        except (TypeError, ValueError):
            return None
    if not vals:
        return None
    return all(v == 0 for v in vals)


@app.post("/api/models/list")
async def api_models_list(request: Request):
    """代理拉取供应商在线模型列表（OpenAI 兼容 GET {base_url}/models）。

    添加模型弹窗「获取模型列表」按钮的后端：内置预设清单只是初值会过期，
    在线列表才是事实源；本地服务（Ollama/LM Studio/llama.cpp）同样适用——
    列出的就是本机已装模型。密钥回退与 SSRF 校验与 /api/models/chat 同口径。
    """
    payload = await _parse_json_object(request)
    provider = payload.get("provider", "")
    api_key, env_key_used = resolve_api_key(provider, payload.get("api_key", ""))

    base_url = payload.get("base_url", "")
    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if not provider_info:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")
        base_url = provider_info["base_url"]
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    url = f"{base_url.rstrip('/')}/models"
    headers = {}
    # opencode 网关的 /models 清单公开可读（zen 免费与 zen/go 2026-09-25 实测均 200），
    # 反而带无效 Bearer 会 401 Invalid credential——列清单不附带密钥，与 chat 路径分开
    if api_key and provider != "opencode" and "opencode.ai" not in base_url:
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, ""))

    client = get_http_client()
    try:
        resp = await client.get(url, headers=headers, timeout=httpx.Timeout(20.0, connect=8.0))
    except httpx.HTTPError as e:
        # 空消息的传输异常不带上类型名就只剩「上游连接失败: 」，用户无从排查
        logger.error(f"models list connect error: {provider} {url}: {type(e).__name__}: {e}")
        raise HTTPException(status_code=502, detail=f"上游连接失败: {type(e).__name__}: {e}")
    if resp.status_code != 200:
        logger.error(f"models list upstream error: status={resp.status_code} body={resp.text[:300]} url={url}")
        # T43：拉模型清单遇 401 时用户最需要的就是「去换钥」这句话
        raise HTTPException(status_code=502, detail=llm_common.upstream_error_detail(resp.status_code, resp.text[:300]))
    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="上游返回的不是 JSON")
    raw = data.get("data") if isinstance(data, dict) else data
    ids = []
    meta = {}
    if isinstance(raw, list):
        for item in raw:
            mid = item.get("id") if isinstance(item, dict) else None
            if isinstance(mid, str) and mid.strip():
                mid = mid.strip()
                ids.append(mid)
                # T60：上游带定价字段时顺手标注免费/付费（OpenRouter 等有、
                # opencode 没有——后者靠 /api/models/probe 真发探活）
                free = _model_pricing_free(item)
                if free is not None:
                    meta[mid] = {"free": free}
    return {"models": sorted(set(ids)), "meta": meta}


@app.post("/api/models/probe")
async def api_models_probe(request: Request):
    """T60：单模型探活——真发一条最小对话验证「列表里有」≠「能用」。

    免费网关清单常混付费档模型（免费模式下诱导踩坑）；200 但 content 为空的
    「假活」也在这里拦下。密钥回退与 SSRF 校验与 /api/models/list 同口径。
    故意不带 max_tokens（部分新系列拒收该参数会造成假阴性），ping 一句成本可忽略。
    """
    payload = await _parse_json_object(request)
    provider = payload.get("provider", "")
    api_key, env_key_used = resolve_api_key(provider, payload.get("api_key", ""))
    model_name = str(payload.get("model", "") or "").strip()
    if not model_name:
        raise HTTPException(status_code=400, detail="缺少 model")

    base_url = payload.get("base_url", "")
    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if not provider_info:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")
        base_url = provider_info["base_url"]
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, "models-probe"))
    body = {"model": model_name, "messages": [{"role": "user", "content": "ping"}], "stream": False}

    client = get_http_client()
    try:
        resp = await client.post(url, json=body, headers=headers,
                                 timeout=httpx.Timeout(25.0, connect=8.0))
    except httpx.HTTPError as e:
        logger.error(f"models probe connect error: {provider} {model_name} {url}: {type(e).__name__}: {e}")
        return {"ok": False, "detail": f"连接失败: {type(e).__name__}"}
    if resp.status_code != 200:
        return {"ok": False, "detail": llm_common.upstream_error_detail(resp.status_code, resp.text[:200])}
    try:
        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        content = str(message.get("content") or "")
        reasoning = str(message.get("reasoning_content") or message.get("reasoning") or "")
    except Exception:
        return {"ok": False, "detail": "返回 200 但不是标准补全 JSON"}
    if not content.strip() and not reasoning.strip():
        # T60：200 但内容为空的「假活」——列表在、实际不可用，标注出来别误导
        return {"ok": False, "detail": "返回 200 但内容为空（疑似不可用）"}
    return {"ok": True, "detail": "可用"}


@app.get("/api/usage/stats")
async def api_usage_stats(days: int = 7):
    """token 用量与缓存命中率汇总（前缀缓存改造的观测口）。

    数据来自 data/usage/YYYY-MM-DD.jsonl；hitRate 只在「上游确实回报了
    命中字段」的请求上累计（hitKnownRequests 可分辨供应商是否回报）。
    """
    return usage_stats.summarize(days=days)



# ====== 滚动会话记忆（长会话后台摘要，不阻塞当前请求） ======
# key -> asyncio.Task：必须存任务对象的强引用——只存 key 时 create_task 返回的
# Task 可能被 GC 中途取消（asyncio 官方文档警告）；key 用于同会话去重
_summary_tasks = {}


def _maybe_schedule_rolling_summary(session_id, provider, api_key, model_name, base_url, account=accounts.DEFAULT_ACCOUNT):
    """长会话后台滚动记忆：不阻塞当前请求，下次提问即可用上。"""
    if not session_id:
        return
    try:
        generation = context._rolling_memory_generation(session_id)
        due = context._rolling_summary_due(session_id, account)
    except Exception:
        return
    if not due:
        return
    key = f"{session_id}:{model_name}"
    if key in _summary_tasks:
        return
    task = asyncio.create_task(
        _run_rolling_summary(session_id, provider, api_key, model_name, base_url, due, generation=generation, account=account)
    )
    _summary_tasks[key] = task
    task.add_done_callback(lambda _t, _key=key: _summary_tasks.pop(_key, None))


async def _run_rolling_summary(session_id, provider, api_key, model_name, base_url, count, generation=None, account=accounts.DEFAULT_ACCOUNT):
    try:
        if generation is None:
            generation = context._rolling_memory_generation(session_id)
        elif generation != context._rolling_memory_generation(session_id):
            return
        snapshot = context._rolling_memory_snapshot(session_id, account=account)
        input_text = snapshot["text"]
        if not input_text:
            return
        url = f"{base_url.rstrip('/')}/chat/completions"
        headers = _chat_request_headers(provider, api_key, base_url, session_id)
        body = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": ROLLING_SUMMARY_PROMPT},
                {"role": "user", "content": input_text},
            ],
            "stream": False,
            "max_tokens": 300,
        }
        client = get_http_client()
        resp = await client.post(url, json=body, headers=headers, timeout=30.0)
        if resp.status_code != 200:
            return
        data = resp.json()
        if data.get("usage"):
            usage_stats.record_usage(provider, model_name, "summary", session_id, data["usage"])
        content = data["choices"][0]["message"]["content"]
        if context._write_rolling_memory(session_id, content, snapshot["messageCount"],
                                         expected_generation=generation, snapshot=snapshot,
                                         account=account):
            logger.info("rolling memory updated: session=%s count=%d", session_id, count)
    except Exception as e:
        logger.warning("rolling memory update failed: %s", e)


# ====== 账号管理 API（本地多账号 P2，2026-10-07）======
# 存储分域靠各存储路由的 account_id 请求参数（_account_id），这里只管账号
# 注册表本身（data/users/accounts.json）。CRUD 函数与默认名/拒删规则在
# accounts.py，路由层只做参数校验与 HTTP 语义。

@app.get("/api/accounts")
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


@app.post("/api/accounts")
async def api_accounts_create(request: Request):
    payload = await _parse_json_object(request)
    name = str(payload.get("name") or "").strip()[:40] or None
    # id 服务端生成（12 位十六进制；前端键前缀取前 8 位，见 config.js accountLsPrefix）
    entries = accounts.load_registry()
    account_id = uuid.uuid4().hex[:12]
    while account_id in entries:
        account_id = uuid.uuid4().hex[:12]
    entry = accounts.register_account(account_id, name=name)
    accounts.ensure_account(account_id, name=name)
    return entry


@app.post("/api/accounts/rename")
async def api_accounts_rename(request: Request):
    account, payload = await _parse_account_payload(request)
    name = str(payload.get("name") or "").strip()[:40]
    if not name:
        raise HTTPException(status_code=400, detail="name required")
    try:
        return accounts.rename_account(account, name)
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")


@app.post("/api/accounts/allow_browse")
async def api_accounts_allow_browse(request: Request):
    account, payload = await _parse_account_payload(request)
    try:
        return accounts.set_allow_browse(account, bool(payload.get("allow")))
    except KeyError:
        raise HTTPException(status_code=404, detail="account not found")


@app.post("/api/accounts/delete")
async def api_accounts_delete(request: Request):
    account, payload = await _parse_account_payload(request)
    if account == accounts.DEFAULT_ACCOUNT:
        # default 是无 account_id 请求的兜底落点，删了数据就丢（accounts.remove_account 同款防线）
        raise HTTPException(status_code=400, detail="default 账号不可删除")
    accounts.remove_account(account, delete_data=bool(payload.get("delete_data")))
    return {"ok": True, "id": account}


# ====== 会话管理 API ======
@app.get("/api/sessions")
async def api_get_sessions(request: Request = None):
    return _read_json_cached(_account_paths(request).sessions_path, {})


@app.post("/api/sessions")
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


@app.put("/api/sessions/{session_id}")
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


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str, request: Request = None):
    payload = {}
    account = _account_id(request, payload)
    paths = _account_paths(request, payload)
    try:
        msgs_path = _get_messages_path(session_id, account)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
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


@app.delete("/api/sessions")
async def api_clear_all_sessions(request: Request = None):
    paths = _account_paths(request)
    account = paths.account
    context._clear_all_rolling_memory(account)
    _write_json(paths.sessions_path, {})
    for f in paths.messages_dir.glob("*.json"):
        f.unlink()
    _write_json(paths.knowledge_path, {})
    _write_json(paths.formulas_path, {})
    _write_json(paths.kv_path, {})
    if paths.kv_dir.exists():
        for f in paths.kv_dir.glob("*.json"):
            f.unlink()
    return {"ok": True}



# ====== 消息管理 API ======
@app.post("/api/sessions/messages-batch")
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
    result = {}
    for sid in session_ids:
        msgs = _read_json_cached(_get_messages_path(sid, account), [])
        result[sid] = msgs if isinstance(msgs, list) else []
    return {"messages": result}


@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str, request: Request = None):
    try:
        path = _get_messages_path(session_id, _account_id(request))
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    return _read_json_cached(path, [])


@app.post("/api/sessions/{session_id}/messages")
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

    _mutate_json(msgs_path, msgs_updater, default=[])
    return {"ok": True, "count": len(messages)}


@app.delete("/api/sessions/{session_id}/messages")
async def api_clear_messages(session_id: str, request: Request = None):
    account = _account_id(request)
    paths = _account_paths(request)
    try:
        msgs_path = _get_messages_path(session_id, account)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
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



# T147：GET /api/knowledge、/api/formulas 的缓存协商——前端 15 秒轮询此前每轮
# 全量重算去重＋全表传输，库越大越卡。按文件指纹（mtime_ns+size）缓存「去重后
# 的响应体＋ETag」：文件没变免重算，If-None-Match 命中回 304 免传输。
# 写路径（POST/DELETE）改文件即改指纹，缓存自然失效，无需主动清。
_json_get_cache: dict = {}
_JSON_GET_CACHE_MAX = 64  # 含 q 搜索变体（键带 q），超限整体清掉防膨胀


def _json_get_payload(path, transform, cache_key=None):
    """→ (body_str, etag)。指纹命中时免 transform 重算（去重/归一化是每轮大头）。"""
    try:
        st = os.stat(path)
        fp = (st.st_mtime_ns, st.st_size)
    except OSError:
        fp = None
    key = cache_key or str(path)
    hit = _json_get_cache.get(key)
    if fp is not None and hit and hit[0] == fp:
        return hit[1], hit[2]
    if len(_json_get_cache) >= _JSON_GET_CACHE_MAX:
        _json_get_cache.clear()
    payload = transform(_read_json(path, {}))
    body = json.dumps(payload, ensure_ascii=False)
    etag = '"' + hashlib.md5(body.encode("utf-8")).hexdigest() + '"'
    if fp is not None:
        _json_get_cache[key] = (fp, body, etag)
    return body, etag


def _json_get_response(request: Request, path, transform, cache_key=None):
    body, etag = _json_get_payload(path, transform, cache_key)
    inm = request.headers.get("if-none-match") or ""
    if inm and etag in inm:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    # Cache-Control: no-cache = 可存但每次必须带 ETag 回源验证——15 秒轮询从此
    # 拿 304 空响应，浏览器沿用本地副本
    return Response(content=body, media_type="application/json",
                    headers={"ETag": etag, "Cache-Control": "no-cache"})


@app.get("/api/knowledge")
async def api_get_knowledge(request: Request = None):
    paths = _account_paths(request)
    if request is None:
        # 直调兼容（脚本/回归子进程直接 await 端点函数）：回原始 dict，不过 HTTP 层
        return _dedupe_knowledge(_read_json(paths.knowledge_path, {}))
    return _json_get_response(request, paths.knowledge_path, _dedupe_knowledge)


def _card_vector_text(item: dict) -> str:
    """向量证据的卡片文本：标题 + 真摘要（summarySource=local 的模板文案是空串——
    v5.3 口径，「xxx相关公式：xxx」式模板只会污染语义）。"""
    title = str((item or {}).get("title") or "").strip()
    src = str(item.get("summarySource") or "local")
    summary = str(item.get("summary") or "").strip() if src in ("model", "manual") else ""
    text = f"{title}\n{summary[:embedding._CACHE_SUMMARY_CLIP]}" if summary else title
    return text.strip()


def _continent_vectors(items: dict, accepted_families: list):
    """向量证据的一次性准备（v10 从 _continent_card_sims 抽出共用）：
    → (卡片×族中心的余弦表, 卡片向量表)。

    同步函数，路由里 asyncio.to_thread 包住跑（模型加载 1-3 秒 + 批推理，不能阻塞
    事件循环）。向量全部来自 embedding.gather_vectors 的本地缓存，缺模型/缺依赖/
    推理失败返回 ({}, {})——投影与建议都自动退回纯词面口径。
    """
    texts = {}
    for iid, item in (items or {}).items():
        if isinstance(item, dict):
            t = _card_vector_text(item)
            if t:
                texts[str(iid)] = t
    # 族文本直接以「规范名/术语原文」为键（family_centroid_vectors 按原文查找；
    # 与卡片标题撞键无害——同文本同向量）
    fam_texts = {}
    for fam in (accepted_families or []):
        canonical = str(fam.get("canonical") or "").strip()
        if not canonical:
            continue
        fam_texts[canonical] = canonical
        for term in (fam.get("terms") or []):
            t = str(term).strip()
            if t:
                fam_texts[t] = t
    vecs, _ = embedding.gather_vectors({**texts, **fam_texts})
    if not vecs:
        return {}, {}
    fam_vecs = embedding.family_centroid_vectors(accepted_families, vecs)
    if not fam_vecs:
        return {}, {}
    sims = {}
    for iid, vec in vecs.items():
        if iid in texts:
            row = {d: embedding.cosine(vec, fv) for d, fv in fam_vecs.items()}
            if row:
                sims[iid] = row
    card_vecs = {iid: vecs[iid] for iid in sims}  # 只回有相似度行的卡（聚类用）
    return sims, card_vecs


def _continent_card_sims(items: dict, accepted_families: list):
    """卡片 × 概念族中心的向量相似度（v9 海域层第五路证据的数据来源）。

    v10 起是 `_continent_vectors` 的投影专用薄壳：族中心缺席时返回 ({}, False)，
    与旧版两个失败分支的行为逐字一致。
    """
    sims, _ = _continent_vectors(items, accepted_families)
    return sims, bool(sims)


@app.get("/api/continent")
async def api_get_continent(request: Request = None):
    """大陆投影（v1 只读 + v2 簇间边）：跨会话概念聚簇 + 共享概念 + 用户连线。

    聚簇与共享概念纯本地推导（无 AI 网关调用）；用户簇间边是主图自有数据
    （KV `continent_edges`，经 /api/kv 读写），在此合入并按当前投影校验出
    悬空边。子图（knowledge + sessions）仍是聚簇的唯一事实源，随时可重算。
    v9 向量证据：本地 embedding 模型给「卡片 × 族中心」算余弦（data/embedding_cache.json
    缓存，只算新文本），词面认不出的卡也能被路由进正确海域；缺模型自动降级，
    投影退回纯词面口径。向量只进 domain* 字段（门控只路由不证明）。
    """
    paths = _account_paths(request)
    items = _dedupe_knowledge(_read_json(paths.knowledge_path, {}))
    sessions = _read_json(paths.sessions_path, {})
    # 合并视图：主文件 + data/kv/ 会话文件（用户连线/概念族等 KV 自有数据可能已拆分）
    kv = storage.kv_all_data(paths.account)
    user_edges = kv.get("continent_edges")
    # v6 概念族：内置表 + KV 自有扩展（用户/Φ 确认过的汇聚结果，与簇间边同级的主图数据）
    user_families = kv.get("continent_families")
    # v7.1b 门控产物：Φ 批量打标（只读离线产物，版本不符整批忽略——打开大陆仍是纯本地现算）
    gate = kv.get("continent_gate")
    # v9 向量证据：族中心锚点与 build_continent 内部同一份合并口径（同名族 KV 覆盖内置）
    accepted = family.merge_families(family.BUILTIN_FAMILIES,
                                     family.families_from_payload(user_families))
    card_sims, _ = await asyncio.to_thread(_continent_card_sims, items, accepted)
    return continent.build_continent(items, sessions, user_edges, user_families, gate,
                                     card_sims=card_sims)


@app.get("/api/families")
async def api_get_families(request: Request = None):
    """概念族表合并视图（v8 族表编辑界面用）：内置表 + KV `continent_families` 覆盖。

    只读；增删改走既有 KV 通道（POST /api/kv/continent_families，同名覆盖内置）。
    """
    return family.families_view(storage.kv_all_data(_account_id(request)).get("continent_families"))


@app.get("/api/families/suggestions")
async def api_get_family_suggestions(request: Request = None):
    """v10 语义找亲（只读）：向量给族表查漏 + 新族候选，族表弹层渲染。

    两类候选按构造不相交（补词管「气味指向已有族」的卡，新族候选管「哪个族都
    不像但彼此抱团」的卡）：suggestions=补词条建议（泊松岛配方），clusters=无主
    抱团簇（四步方案第 1 步，起名在前端点「让 Φ 起名」才调模型——触发不自动）。
    **机器不自动落笔**：建议只是读侧产物，收下/建族走既有 KV 通道
    （POST /api/kv/continent_families），拒绝/命名缓存落 KV
    `continent_family_suggestions`。向量通道缺席（缺模型/缺依赖/开关关）→
    两类候选整体为空——查空是正常路径，与投影降级同一立场。
    """
    paths = _account_paths(request)
    items = _dedupe_knowledge(_read_json(paths.knowledge_path, {}))
    kv = storage.kv_all_data(paths.account)
    accepted = family.merge_families(family.BUILTIN_FAMILIES,
                                     family.families_from_payload(kv.get("continent_families")))
    card_sims, card_vecs = await asyncio.to_thread(_continent_vectors, items, accepted)
    if not card_sims:
        return {"suggestions": [], "clusters": [], "embedEnabled": False}
    state = kv.get("continent_family_suggestions")
    rejected = state.get("rejected") if isinstance(state, dict) else None
    suggestions = await asyncio.to_thread(
        continent.family_term_suggestions, items, accepted, card_sims, rejected)
    clusters = await asyncio.to_thread(
        continent.family_cluster_suggestions, items, accepted, card_sims, card_vecs)
    return {"suggestions": suggestions, "clusters": clusters, "embedEnabled": True}


# 双击 .pmu 的桌面启动器（scripts/utopia_opener/）把文件复制进 data/utopia_inbox/，
# 查看器（viewer.html?from=inbox&id=<名>）经此只读取回。写入不在 HTTP 面：唯一的
# 投递方式是本机启动器的文件复制，杜绝任意写。
_UtopiaInboxNameRe = re.compile(r'^[A-Za-z0-9_.-]{1,80}$')


@app.get("/api/utopia/inbox/{name}")
async def api_utopia_inbox_get(name: str):
    if not _UtopiaInboxNameRe.match(name) or not name.lower().endswith((".pmu", ".json")):
        raise HTTPException(status_code=422, detail="非法的快照文件名")
    path = UTOPIA_INBOX_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="收件箱里没有这个快照")
    return Response(content=path.read_text(encoding="utf-8"), media_type="application/json")


@app.post("/api/knowledge")
async def api_save_knowledge(request: Request):
    payload = await _parse_json_object(request)

    incoming = _normalize_knowledge(payload)
    # 入库闸门：非知识条目（「用户要求：…」这类指令句回显 / 整句标题）拒收。浏览器会把
    # localStorage 里本地独有的知识点并集推回服务端，入口拒收才保证清掉的垃圾不会被
    # 另一个标签页推回来（手动条目豁免，见 _is_acceptable_knowledge_item）。
    rejected = [k for k, v in incoming.items() if not _is_acceptable_knowledge_item(v)]
    for key in rejected:
        incoming.pop(key, None)
    if rejected:
        logger.info(f"Ingest gate rejected {len(rejected)} non-knowledge items")

    # 孤儿拒收：指向不存在会话的条目一律拒收（空 sessionId 的旧数据放行）。
    # 删除会话后 localStorage 里的残留条目会被前端定时同步推回（本端点是纯合并，
    # 推回即复活），没有这道闸门「已删除的画布」岛删了又复活——与上面的入库
    # 闸门同一条「删得掉」保证。正常链路都是先建会话后写知识，不受影响。
    known_sessions = set(_read_json(_account_paths(request, payload).sessions_path, {}).keys())
    orphaned = [k for k, v in incoming.items()
                if isinstance(v, dict) and v.get("sessionId")
                and str(v["sessionId"]) not in known_sessions]
    for key in orphaned:
        incoming.pop(key, None)
    if orphaned:
        logger.info(f"Ingest gate rejected {len(orphaned)} orphan-session items")

    def updater(data):
        data = _normalize_knowledge(data)
        # 隐式画像：只对「本轮真正新增」的 id 记 extract 事件——前端定时同步会
        # 反复全量推送，按 id 差分才不会每次同步都给兴趣加一次权重
        new_keys = [k for k in incoming if k not in data]
        data.update(incoming)
        data = _dedupe_knowledge(data)
        new_items.extend(incoming[k] for k in new_keys)
        return data

    new_items = []
    account = _account_id(request, payload)
    data = _mutate_json(accounts.resolve_paths(account).knowledge_path, updater)
    _device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if _device_id and new_items:
        events = [{"type": "extract",
                   "topic": str(it.get("topic") or it.get("concept") or "")[:60]}
                  for it in new_items if isinstance(it, dict)]
        profile.record_implicit_event(_device_id, events, account=account)
    return {"ok": True, "count": len(data)}


@app.delete("/api/knowledge/{item_id}")
async def api_delete_knowledge(item_id: str, request: Request = None):
    def updater(data):
        data = _normalize_knowledge(data)
        data.pop(item_id, None)
        return data

    _mutate_json(_account_paths(request).knowledge_path, updater)
    return {"ok": True}



@app.get("/api/formulas")
async def api_get_formulas(request: Request = None, q: str = ""):
    # 只读视图：去重不回写。GET 内写文件与并发 POST 存在「读→去重→覆盖」竞态，
    # 会把窗口期内新增的公式回滚丢失；物理去重改在 POST 写入路径执行。
    # T147：整表与搜索结果都走 ETag 缓存协商（缓存键带 q，互不串）。

    def _formula_payload(raw: dict) -> dict:
        data = _dedupe_formula_map(raw)
        items = list(data.values())
        if q:
            ql = q.lower()
            items = [it for it in items if
                     ql in (it.get("concept") or "").lower() or
                     ql in (it.get("meaning") or "").lower() or
                     ql in (it.get("topic") or "").lower() or
                     ql in (it.get("latex") or "").lower() or
                     any(ql in (t or "").lower() for t in (it.get("related") or []))]
        items.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
        return {"items": items, "count": len(items)}

    paths = _account_paths(request)
    if request is None:
        # 直调兼容（脚本/回归子进程直接 await 端点函数）：回原始 dict，不过 HTTP 层
        return _formula_payload(_read_json(paths.formulas_path, {}))
    return _json_get_response(request, paths.formulas_path, _formula_payload,
                              cache_key=f"{paths.formulas_path}::q={q}")


@app.post("/api/formulas")
async def api_save_formulas(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    items = payload if isinstance(payload, list) else payload.get("items", [])
    if not isinstance(items, list) or any(not isinstance(it, dict) for it in items):
        # 逐项 it.get 前先挡掉契约外形状（dict/字符串进来就是 500）
        raise HTTPException(status_code=400, detail="'items' must be a list of objects")
    count = 0

    def updater(data):
        nonlocal count
        # 写入时物理去重（原挂在 GET 里的清理逻辑挪到这里）
        data = _dedupe_formula_map(data)
        for it in items:
            latex = _normalize_formula(it.get("latex") or "")
            if not latex or not _looks_like_formula(latex):
                continue
            # 去重（T146 起全局）：同公式跨会话并进同一条，归属写 sessionIds
            existing = next((v for v in data.values()
                             if _formula_key(v.get("latex")) == _formula_key(latex)), None)
            if existing:
                # 本地快速提取先入库，后续 AI 结果可以补充更完整的说明。
                changed = False
                incoming_source = str(it.get("meaningSource") or "local")
                existing_source = str(existing.get("meaningSource") or "local")
                incoming_meaning = (it.get("meaning") or "").strip()
                if incoming_meaning and (
                    incoming_source == "model" or existing_source != "model"
                ):
                    existing["meaning"] = incoming_meaning[:200]
                    existing["meaningSource"] = incoming_source
                    changed = True
                for key in ("concept", "topic", "related", "messageId", "moduleKey", "nodeId"):
                    value = it.get(key)
                    if value and not existing.get(key):
                        existing[key] = value
                        changed = True
                # T146：并入本次会话归属（若尚不是它的归属之一）
                it_sid = str(it.get("sessionId") or "")
                if it_sid and it_sid != existing.get("sessionId") \
                        and it_sid not in (existing.get("sessionIds") or []):
                    merged_sids = [str(existing.get("sessionId") or "")] + \
                        [str(s or "") for s in (existing.get("sessionIds") or [])] + [it_sid]
                    sid_seen, ordered_sids = set(), []
                    for sid in merged_sids:
                        if sid and sid not in sid_seen:
                            sid_seen.add(sid)
                            ordered_sids.append(sid)
                    existing["sessionIds"] = ordered_sids
                    changed = True
                if changed:
                    count += 1
                continue
            fid = str(it.get("id") or "") or ("f_" + uuid.uuid4().hex[:12])
            data[fid] = {
                "id": fid,
                "latex": latex,
                "concept": (it.get("concept") or "")[:80],
                "meaning": (it.get("meaning") or "")[:200],
                "meaningSource": it.get("meaningSource") or "local",
                "topic": (it.get("topic") or "")[:60],
                "related": [str(t) for t in (it.get("related") or [])][:8],
                "sessionId": it.get("sessionId", ""),
                "messageId": it.get("messageId", ""),
                "moduleKey": it.get("moduleKey", ""),
                "nodeId": it.get("nodeId", ""),
                "createdAt": it.get("createdAt") or int(time.time() * 1000),
            }
            count += 1
        return data if count else None

    _mutate_json(_account_paths(request, payload).formulas_path, updater)
    return {"ok": True, "count": count}


@app.delete("/api/formulas")
async def api_delete_formulas_by_session(session_id: str = ""):
    """按会话删除公式（session_id 为空时删除全部）"""
    removed = 0

    def updater(data):
        nonlocal removed
        if session_id:
            removed = [k for k, v in data.items() if v.get("sessionId") == session_id]
            for k in removed:
                data.pop(k, None)
        else:
            removed = list(data.keys())
            data.clear()
        return data if removed else None

    _mutate_json(_account_paths(request).formulas_path, updater)
    return {"ok": True, "count": len(removed)}


@app.delete("/api/formulas/{formula_id}")
async def api_delete_formula(formula_id: str, request: Request = None):
    def updater(data):
        data.pop(formula_id, None)
        return data

    _mutate_json(_account_paths(request).formulas_path, updater)
    return {"ok": True}



@app.post("/api/extract_knowledge")
async def api_extract_knowledge(request: Request):
    """从对话中提取知识点（优先 AI，失败或无模型时本地正则兜底），并自动入库公式"""
    payload = await _parse_json_object(request)

    messages = payload.get("messages", [])
    if not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
        # 下方按角色/内容逐条取字段，契约外形状直接 400
        raise HTTPException(status_code=400, detail="'messages' must be a list of message objects")
    account = _account_id(request, payload)
    session_id = payload.get("sessionId", "")
    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model = payload.get("model", "")
    base_url = payload.get("base_url", "")
    level = payload.get("level", "university")

    latest_assistant = next((m for m in reversed(messages) if m.get("role") == "assistant"), None)
    if latest_assistant and (
        _is_socratic_followup(latest_assistant.get("content", ""))
        or latest_assistant.get("branchType") in ("followup", "confused", "socratic")
    ):
        # 分支守卫：追问/没看懂/苏格拉底不做知识提取，但这是可靠的兴趣/风格信号——
        # 记一条隐式画像事件（主题按用户分支问题文本归题）再返回
        _branch_device = payload.get("device_id") or payload.get("deviceId") or ""
        if _branch_device:
            _branch_user = next((m.get("content") for m in reversed(messages)
                                 if m.get("role") == "user"), "")
            _branch_type = {"confused": "confused", "socratic": "socratic"}.get(
                latest_assistant.get("branchType"), "followup")
            profile.record_implicit_event(_branch_device, [{
                "type": _branch_type,
                "topic": profile.assign_topic(str(_branch_user or "")[:500], account=account),
            }], account=account)
        return {"items": []}
    # 推理泄漏闸门（先于 AI/本地两条路径）：正文其实是模型的思维链时，本轮不做提取。
    # 否则「用户要求：…」这类假标题 + 系统提示词回显的假公式会进库，并顺着
    # knowledge 流到知识面板、概念地基与大陆投影（实测四条虚假共享概念由此而来）。
    if latest_assistant and _looks_like_reasoning_leak(latest_assistant.get("content", "")):
        logger.info(f"Skip knowledge extraction: reasoning leak in assistant content for session {session_id}")
        return {"items": []}
    # 公式描述模型（前端传入，可选；未配置时回退默认摘要）
    desc_provider = payload.get("descriptor_provider", "")
    desc_api_key = payload.get("descriptor_api_key", "")
    desc_model = payload.get("descriptor_model", "")
    desc_base_url = payload.get("descriptor_base_url", "")
    desc_api_key, desc_env_used = resolve_api_key(desc_provider, desc_api_key)

    items = []
    profile_facts = []
    profile_ops = []
    # 搭车画像采集：把既有画像摘要带给提取模型，模型输出 new/confirm/update/remove 合并操作
    # （记忆开关关闭时后端自动忽略；device_id 需在读摘要前解析）
    device_id = payload.get("device_id") or payload.get("deviceId") or ""
    profile_digest = profile.profile_ops_digest(device_id) if device_id else ""
    if (api_key or provider in ("opencode", "opencode-go")) and model:
        try:
            extracted = await _ai_extract_knowledge(messages, provider, api_key, model, base_url, level,
                                                    profile_digest=profile_digest,
                                                    env_key_used=env_key_used)
            if isinstance(extracted, tuple) and len(extracted) == 3:
                items, profile_facts, profile_ops = extracted
            elif isinstance(extracted, tuple):
                items, profile_facts = extracted
            else:
                items = extracted
            if items:
                logger.info(f"AI extract: {len(items)} items for session {session_id}")
        except Exception as e:
            logger.warning(f"AI extract failed, fallback to local: {e}")
    if not items:
        items = _local_extract_knowledge(messages)
        if items:
            logger.info(f"Local extract: {len(items)} items for session {session_id}")

    profile_result = None
    if device_id:
        # 旧格式 profile_facts 兼容：按 new 语义并入 ops（合并式采集内部按规范化文本去重）。
        # 模型同时输出新旧两种格式时，同一句陈述会在这里被数两次（第二条撞重直接固化，
        # 绕过两击门槛），故并入前按规范化文本与 ops 的 new/update 去重
        all_ops = list(profile_ops or [])
        op_norms = {profile._norm_fact(str(o.get("fact") or ""))
                    for o in all_ops
                    if isinstance(o, dict) and str(o.get("op") or "").lower() in ("new", "update")}
        for pf in profile_facts or []:
            if isinstance(pf, dict) and str(pf.get("fact") or "").strip():
                if profile._norm_fact(str(pf.get("fact") or "")) in op_norms:
                    continue
                pf.setdefault("sourceSession", session_id)
                all_ops.append({"op": "new", **pf})
        for op in all_ops:
            if isinstance(op, dict):
                op.setdefault("sourceSession", session_id)
                op.setdefault("source", "chat")
        if all_ops:
            try:
                accepted = profile.apply_profile_ops(device_id, all_ops, source="chat")
                profile_result = {"changed": accepted.get("changed", 0), "promoted": accepted.get("promoted", [])}
                if accepted.get("changed"):
                    logger.info(f"Profile ops applied for device {device_id[:8]}: {accepted}")
            except Exception as e:
                logger.warning(f"Profile fact ingest failed: {e}")

    # 整卡摘要双重用途（P2 起）：主模型 <summary> 只落 anchorSummary（画布定位锚点），
    # 不再覆盖各条目的展示 summary——AI 逐条摘要保优合并靠 summarySource 等级；
    # 本地兜底条目（P4 起）展示 summary 为模板文案，整卡摘要原文由
    # _local_extract_knowledge 自行落 anchorSummary。无 <summary> 时优先保留
    # 条目既有锚点（本地提取的整卡摘要原文），AI 条目再回退其自身摘要作锚点
    # ——锚点绝不能落到模板文案上，否则定位滑窗匹配失效且 P3 旧摘要判定误报。
    summary_text = _extract_summary(messages)
    for it in items:
        anchor = summary_text or it.get("anchorSummary") or it.get("summary") or ""
        if anchor:
            it["anchorSummary"] = anchor[:200]

    # 公式描述 + 知识点摘要：配置了描述模型时并入同一次调用（不增加请求数），
    # 为新增公式生成简要描述，并为各知识点生成逐条摘要。
    # 无公式但有知识点（纯概念回答）也要发起：DESCRIBE 的 summaries 块是
    # local 来源条目升级为模型摘要的唯一通道（descriptor-only 场景）。
    descriptions = {}
    knowledge_summaries = {}
    all_formulas = []
    for it in items:
        for f in (it.get("formulas") or []):
            latex = _normalize_formula(str(f).strip())
            if latex and _looks_like_formula(latex) and latex not in all_formulas:
                all_formulas.append(latex)
    has_knowledge_items = any(str(it.get("title") or "").strip() for it in items)
    if (all_formulas or has_knowledge_items) and desc_model and (desc_api_key or desc_provider in ("opencode", "opencode-go")):
        descriptions, knowledge_summaries = await _describe_formulas(
            summary_text, all_formulas, items, desc_provider, desc_api_key, desc_model, desc_base_url, level,
            env_key_used=desc_env_used)
        if descriptions or knowledge_summaries:
            logger.info(f"Generated {len(descriptions)} formula descriptions / {len(knowledge_summaries)} knowledge summaries for session {session_id}")

    message_id = str(latest_assistant.get("timestamp") or "") if latest_assistant else ""
    added = _add_formulas_from_items(items, session_id, descriptions, message_id, account=account)
    if added:
        logger.info(f"Auto added {added} formulas to library")
    if device_id:
        # 隐式画像：主回答 = ask 事件（归题＋节奏篇幅）；带公式的条目 = formula 事件。
        # extract 事件不在这里记——条目要等前端经 /api/knowledge 落库，那边按新 id 差分
        try:
            _ask_user = next((m.get("content") for m in reversed(messages)
                              if m.get("role") == "user"), "")
            _events = [{"type": "ask",
                        "topic": profile.assign_topic(str(_ask_user or "")[:500], account=account),
                        "len": len(str((latest_assistant or {}).get("content") or ""))}]
            for it in items:
                if isinstance(it, dict) and it.get("formulas"):
                    _events.append({"type": "formula",
                                    "topic": str(it.get("topic") or it.get("title") or "")[:60]})
            profile.record_implicit_event(device_id, _events, account=account)
        except Exception as e:
            logger.warning(f"Implicit ask event failed: {e}")

    return {"items": items, "descriptions": descriptions, "summaries": knowledge_summaries,
            "profile": profile_result or {"changed": 0, "promoted": []}}


@app.post("/api/profile/candidates")
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


@app.post("/api/profile/manage")
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



@app.post("/api/documents/parse")
async def api_parse_document(request: Request):
    payload = await _parse_json_object(request)

    filename = _sanitize_filename(payload.get("fileName") or "")
    try:
        max_items = min(max(int(payload.get("maxItems") or 5), 1), 50)
    except (TypeError, ValueError):
        max_items = 5
    content = None
    file_id = str(payload.get("fileId") or "")
    if file_id:
        # 20MB 级文件的读盘与 base64 解码都是秒级同步 CPU/IO 重活：
        # 全部卸到工作线程，期间事件循环继续服务 AI 回复流等其他请求
        loaded = await asyncio.to_thread(_read_upload, file_id)
        if not loaded:
            raise HTTPException(status_code=404, detail="文件不存在，请重新上传")
        entry, content = loaded
        filename = _sanitize_filename(entry.get("filename") or filename)
    else:
        try:
            content = await asyncio.to_thread(base64.b64decode, str(payload.get("contentBase64") or ""))
        except Exception:
            raise HTTPException(status_code=400, detail="文件内容格式错误")
        if not content:
            raise HTTPException(status_code=400, detail="缺少文件内容")
        if len(content) > UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 20MB 限制")
        file_id = "doc_" + uuid.uuid4().hex[:12]
        await asyncio.to_thread(_save_upload, file_id, filename, content)

    # PDF/DOCX/PPTX 解析与图片 OCR：最重的同步 CPU 段，必须离事件循环
    text = await asyncio.to_thread(_extract_document_text, filename, content)
    ext = Path(filename).suffix.lower()
    is_image = ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}
    image_b64 = await asyncio.to_thread(lambda: base64.b64encode(content).decode("ascii")) if is_image else ""

    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    level = str(payload.get("level") or "university")

    nodes, edges, relations = [], [], []
    if model and (api_key or provider in ("opencode", "opencode-go")):
        try:
            nodes, edges, relations = await _ai_extract_document_knowledge(
                text, filename, is_image, image_b64, provider, api_key, model, base_url, level, max_items,
                env_key_used=env_key_used
            )
        except Exception as e:
            logger.warning(f"AI document extraction failed: {e}")
    if not nodes:
        nodes, edges, relations = await asyncio.to_thread(_local_extract_document_knowledge, text, filename, max_items)
    if not nodes:
        raise HTTPException(status_code=422, detail="无法从文件中提取知识点。请使用文本/PDF/DOCX，或为图片配置视觉模型/OCR。")

    return {
        "ok": True,
        "fileId": file_id,
        "fileName": filename,
        "maxItems": max_items,
        "textLength": len(text),
        "nodes": nodes,
        "edges": edges,
        "relations": relations,
        "extractedTextPreview": text[:500],
    }



# ====== 键值存储 API ======
# 读写经 storage.kv_* 拆分路由：graph:<sid>/harness_history:<sid> 等会话级键
# 落到 data/kv/<sid>.json（保存单会话不再全量重写主文件），全局键走主文件。
@app.get("/api/kv/{key}")
async def api_get_kv(key: str, request: Request = None):
    return {"key": key, "value": storage.kv_read(key, account=_account_id(request))}


@app.post("/api/kv/{key}")
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


@app.delete("/api/kv/{key}")
async def api_delete_kv(key: str, request: Request = None):
    storage.kv_delete(key, account=_account_id(request))
    return {"ok": True}


# ====== 用户画像（记忆）API ======
@app.get("/api/profile")
async def api_get_profile(device_id: str = ""):
    return profile.get_profile(device_id)


@app.put("/api/profile")
async def api_update_profile(request: Request):
    payload = await _parse_json_object(request)
    device_id = str(payload.get("device_id") or "")
    updates = payload.get("updates")
    if not isinstance(updates, dict):
        raise HTTPException(status_code=400, detail="updates must be an object")
    return profile.update_profile(device_id, updates)


@app.delete("/api/profile")
async def api_delete_profile(device_id: str = ""):
    profile.delete_profile(device_id)
    return {"ok": True}


@app.post("/api/profile/event")
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


@app.post("/api/profile/implicit")
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


@app.get("/api/profile/dashboard")
async def api_profile_dashboard(device_id: str = ""):
    """画像仪表盘：隐式状态的派生视图（衰减/保留/成熟度/账本都在服务端算）。"""
    if not device_id:
        raise HTTPException(status_code=400, detail="缺少 device_id")
    return profile.implicit_dashboard(device_id)



@app.get("/api/backup/export")
async def api_backup_export(request: Request = None):
    return _build_backup_payload(_account_id(request))


@app.post("/api/backup/import")
async def api_backup_import(request: Request):
    payload = await _parse_json_object(request)
    backup = payload.get("backup") if isinstance(payload.get("backup"), dict) else payload
    if not isinstance(backup, dict):
        raise HTTPException(status_code=400, detail="Backup payload must be an object")
    mode = str(payload.get("mode") or "merge").lower()
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="mode must be merge or replace")
    try:
        return _restore_backup(backup, mode == "replace", account=_account_id(request, payload))
    except HTTPException:
        raise
    except Exception as exc:
        # _restore_backup 失败时已整体回滚，把回滚报告带回给调用方
        raise HTTPException(status_code=500, detail=str(exc))



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
