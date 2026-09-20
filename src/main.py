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

from server import backup, concept, continent, context, documents, knowledge, profile, prompts, storage  # noqa: F401
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
    避免后续 payload.get(...) 抛 AttributeError 变成 500。"""
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="JSON object expected")
    return payload



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


def _chat_request_headers(provider: str, api_key: str, base_url: str, session_id: str) -> dict:
    headers = {"Content-Type": "application/json"}
    if api_key and provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, session_id))
    return headers


def _thinking_request_params(provider: str, level: str) -> dict:
    """「思考程度」→ 上游请求参数（纯函数，tests 直测）。

    用户档位 default('')/low/high/max：default 不发送任何思考参数——现状行为
    零变化。各家 OpenAI 兼容端点的思考字段不统一：OpenAI 系（含 Gemini/
    OpenRouter/Groq/自定义网关）用 reasoning_effort，千问百炼用 enable_thinking，
    智谱用 thinking.type，Ollama 用 think。reasoning_effort 只有 low/medium/high
    三档，low/high/max 按序拉伸映射（low→low、high→medium、max→high），
    三档在每个 reasoning_effort 供应商上都有区分度；布尔开关族（qwen/zhipu/
    ollama）三档同为「开启」。上游不认识注入字段而拒绝整个请求时，由调用方
    剥掉参数降级重试一次。
    """
    p = (provider or "").strip().lower()
    if level not in ("low", "high", "max"):
        return {}
    if p == "qwen":
        return {"enable_thinking": True}
    if p == "zhipu":
        return {"thinking": {"type": "enabled"}}
    if p == "ollama":
        return {"think": True}
    return {"reasoning_effort": {"low": "low", "high": "medium", "max": "high"}[level]}


@app.post("/api/models/chat")
async def api_models_chat(request: Request):
    """代理请求到 AI API，流式返回 OpenAI 格式 SSE。
    支持两种调用格式：
    1. 新格式：{prompt, level, session_id, provider, api_key, model, base_url}
       → 后端构建消息（系统提示词 + 难度后缀 + 会话上下文）
    2. 旧格式：{messages, provider, api_key, model, base_url}
       → 直接使用传入的 messages
    """
    payload = await _parse_json_object(request)


    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model_name = payload.get("model", "")
    if not model_name and provider == "deepseek":
        model_name = "deepseek-chat"
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)
    context_budget = resolve_context_budget(model_name)

    if not api_key and provider not in ("opencode", "opencode-go", "llama", "local"):
        raise HTTPException(
            status_code=400,
            detail=f"未配置 {provider} API Key：请在项目根目录 .env 中设置 DEEPSEEK_API_KEY，或在模型配置中填写密钥",
        )

    # 构建消息列表
    prompt = payload.get("prompt", "")
    session_id = payload.get("session_id", "")
    branch_id = payload.get("branch_id") or payload.get("branchId") or ""
    branch_type = payload.get("branch_type") or payload.get("branchType") or ""
    source_module = payload.get("source_module") or payload.get("sourceModule") or ""
    parent_id = payload.get("parent_id") or payload.get("parentId") or ""
    graph_path = payload.get("graph_path") or payload.get("graphPath") or []
    if not isinstance(graph_path, list):
        # _graph_path_instruction 会逐项 item.get，字符串/数字进来就是 500
        raise HTTPException(status_code=400, detail="graph_path must be a list")
    workflow_context = payload.get("workflow_context") or payload.get("workflowContext") or {}
    quick = bool(payload.get("quick"))
    is_quick = False
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
            resolved_branch = _resolve_socratic_branch(session_id)
            if resolved_branch:
                branch_id = resolved_branch
                socratic_ref = resolved_branch
                if not branch_type:
                    branch_type = "socratic"
                if not source_module:
                    source_module = "extend"
        socratic_state = _read_socratic_state(socratic_ref) if socratic_ref else None
        if socratic_state and not is_socratic_prompt:
            # 用户开始新的普通问答时，结束当前苏格拉底支线
            _delete_socratic_state(socratic_ref)
            socratic_state = None
        include_socratic = bool(socratic_state) or is_socratic_prompt
        if socratic_state and is_socratic_prompt:
            # 延续中的闭环：用本次消息里的问题/等级刷新状态（保留连对次数与已答轮数）
            _sync_socratic_state_from_prompt(socratic_state, prompt)
            _write_socratic_state(socratic_ref, socratic_state)

        is_quick = quick and not branch_id and not graph_path and not workflow_context
        if is_quick:
            system_content = QUICK_SYSTEM_PROMPT
        elif workflow_context:
            system_content = MODULE_SYSTEM_PROMPT
        else:
            system_content = get_system_prompt()
        state_instruction = _socratic_state_instruction(socratic_ref, socratic_mode) if socratic_ref and is_socratic_prompt else ""
        if state_instruction:
            system_content += "\n\n" + state_instruction

        if branch_id:
            system_content += _branch_context_instruction(branch_type, source_module, payload.get("branch_label") or payload.get("branchLabel") or "", parent_id)
        if graph_path:
            system_content += _graph_path_instruction(graph_path, source_module)
        if workflow_context:
            system_content += _workflow_context_instruction(workflow_context)
        # 概念地基（M4 / P1-A）：knowledge 条目首次作为检索基底参与 prompt——
        # 消息层管「我们聊到哪」，这一段管「这个话题的地基是什么」。
        # 与画像注入同一范围（默认完整回答路径，不含 quick / 画布模块生成 / 支线）：
        # 支线与模块重生成是局部动作，多这一层只会挤 token。查空返回空串 = 零回归。
        if not is_quick and not workflow_context and not branch_id:
            concept_text = concept.concept_context_text(prompt, session_id=session_id)
            if concept_text:
                system_content += "\n\n" + concept_text
        # 用户画像（记忆）注入：仅默认完整回答路径（quick / 画布模块生成 / 支线
        # 不注入——与上方概念地基同一范围，09-20 补齐 branch_id：此前支线也会
        # 注入画像并刷新 lastUsedAt，与注释宣称的口径不一致）。
        # 契约化段落 + 注入回写：命中的事实记 lastUsedAt，长期未命中的自动休眠。
        # 同时把「本次实际注入了什么」随响应回传（角标不再按前端缓存重算）。
        if not is_quick and not workflow_context and not branch_id:
            _device_id = payload.get("device_id") or payload.get("deviceId") or ""
            if _device_id:
                _profile_ctx = profile.profile_context(_device_id)
                profile_usage = {"sections": _profile_ctx["sections"],
                                 "factCount": len(_profile_ctx["factIds"])}
                if _profile_ctx["text"]:
                    system_content += "\n\n" + _profile_ctx["text"]
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
                max_rounds=(1 if is_quick else 3),
                current_prompt=prompt,
                workflow_context=workflow_context,
                budget_tokens=context_budget,
            )
            messages.extend(history)

        level = payload.get("level", "university")
        if not is_quick:
            level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
            messages.append({"role": "user", "content": prompt + level_suffix})
        else:
            messages.append({"role": "user", "content": prompt})

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
    headers = _chat_request_headers(provider, api_key, base_url, session_id)
    target = workflow_context.get("target") or {} if isinstance(workflow_context, dict) else {}
    module_key = target.get("module") or source_module
    is_strict_module = module_key in ("socratic", "learn") and (
        target.get("kind") == "module" or branch_type == "blank"
    )
    max_tokens = payload.get("max_tokens")
    if is_strict_module and not max_tokens:
        max_tokens = STRICT_MODULE_MAX_TOKENS
    if is_quick and not max_tokens:
        max_tokens = 400
    body = {
        "model": model_name,
        "messages": messages,
        "stream": stream,
    }
    if max_tokens:
        try:
            body["max_tokens"] = int(max_tokens)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="max_tokens must be an integer")
    # 思考程度（模型配置弹窗按条目设置）：仅显式选择时注入对应供应商的思考参数
    thinking_params = _thinking_request_params(provider, str(payload.get("thinking") or ""))
    if thinking_params:
        body.update(thinking_params)

    if session_id and prompt and not is_quick:
        _maybe_schedule_rolling_summary(session_id, provider, api_key, model_name, base_url)

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
        raise HTTPException(status_code=502, detail=f"上游返回 {resp.status_code}: {error_text}")

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
            _update_socratic_state_from_content("".join(streamed_content), socratic_ref)
        except Exception as e:
            logger.error(f"AI proxy error: {e}")
            yield f"data: {json.dumps({'error': 500, 'detail': str(e)})}\n\n"
            yield "data: [DONE]\n\n"
        finally:
            await resp.aclose()

    return StreamingResponse(proxy_stream(), media_type="text/event-stream")



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
    if api_key and provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(_opencode_session_headers(base_url, ""))

    client = get_http_client()
    try:
        resp = await client.get(url, headers=headers, timeout=httpx.Timeout(20.0, connect=8.0))
    except httpx.HTTPError as e:
        logger.error(f"models list connect error: {provider} {url}: {e}")
        raise HTTPException(status_code=502, detail=f"上游连接失败: {e}")
    if resp.status_code != 200:
        logger.error(f"models list upstream error: status={resp.status_code} body={resp.text[:300]} url={url}")
        raise HTTPException(status_code=502, detail=f"上游返回 {resp.status_code}: {resp.text[:300]}")
    try:
        data = resp.json()
    except Exception:
        raise HTTPException(status_code=502, detail="上游返回的不是 JSON")
    raw = data.get("data") if isinstance(data, dict) else data
    ids = []
    if isinstance(raw, list):
        for item in raw:
            mid = item.get("id") if isinstance(item, dict) else None
            if isinstance(mid, str) and mid.strip():
                ids.append(mid.strip())
    return {"models": sorted(set(ids))}



# ====== 滚动会话记忆（长会话后台摘要，不阻塞当前请求） ======
# key -> asyncio.Task：必须存任务对象的强引用——只存 key 时 create_task 返回的
# Task 可能被 GC 中途取消（asyncio 官方文档警告）；key 用于同会话去重
_summary_tasks = {}


def _maybe_schedule_rolling_summary(session_id, provider, api_key, model_name, base_url):
    """长会话后台滚动记忆：不阻塞当前请求，下次提问即可用上。"""
    if not session_id:
        return
    try:
        generation = context._rolling_memory_generation(session_id)
        due = context._rolling_summary_due(session_id)
    except Exception:
        return
    if not due:
        return
    key = f"{session_id}:{model_name}"
    if key in _summary_tasks:
        return
    task = asyncio.create_task(
        _run_rolling_summary(session_id, provider, api_key, model_name, base_url, due, generation=generation)
    )
    _summary_tasks[key] = task
    task.add_done_callback(lambda _t, _key=key: _summary_tasks.pop(_key, None))


async def _run_rolling_summary(session_id, provider, api_key, model_name, base_url, count, generation=None):
    try:
        if generation is None:
            generation = context._rolling_memory_generation(session_id)
        elif generation != context._rolling_memory_generation(session_id):
            return
        snapshot = context._rolling_memory_snapshot(session_id)
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
        content = data["choices"][0]["message"]["content"]
        if context._write_rolling_memory(session_id, content, snapshot["messageCount"],
                                         expected_generation=generation, snapshot=snapshot):
            logger.info("rolling memory updated: session=%s count=%d", session_id, count)
    except Exception as e:
        logger.warning("rolling memory update failed: %s", e)


# ====== 会话管理 API ======
@app.get("/api/sessions")
async def api_get_sessions():
    return _read_json_cached(SESSIONS_PATH, {})


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
    _mutate_json(SESSIONS_PATH, updater)
    # count 返回实际写入条数（非法 id 被跳过的不算），与 knowledge 路由口径一致
    return {"ok": True, "count": written}


@app.put("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    payload = await _parse_json_object(request)
    try:
        _get_messages_path(session_id)
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

    _mutate_json(SESSIONS_PATH, updater)
    return {"ok": True}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    try:
        msgs_path = _get_messages_path(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    # 删除别名映射前清理摘要并推进删除代次；失败中止，不能留下旧上下文却报清除成功
    context._delete_rolling_memory(session_id)

    def updater(data):
        data.pop(session_id, None)
        return data

    _mutate_json(SESSIONS_PATH, updater)
    if msgs_path.exists():
        msgs_path.unlink()
    _delete_by_session(KNOWLEDGE_PATH, session_id)
    _delete_by_session(FORMULAS_PATH, session_id)
    _delete_socratic_state(session_id)
    return {"ok": True}


@app.delete("/api/sessions")
async def api_clear_all_sessions():
    context._clear_all_rolling_memory()
    _write_json(SESSIONS_PATH, {})
    for f in MESSAGES_DIR.glob("*.json"):
        f.unlink()
    _write_json(KNOWLEDGE_PATH, {})
    _write_json(FORMULAS_PATH, {})
    _write_json(KV_PATH, {})
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

    result = {}
    for sid in session_ids:
        msgs = _read_json_cached(_get_messages_path(sid), [])
        result[sid] = msgs if isinstance(msgs, list) else []
    return {"messages": result}


@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    try:
        path = _get_messages_path(session_id)
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
    try:
        msgs_path = _get_messages_path(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")

    def msgs_updater(existing):
        # 双标签页并发保存时按「消息更多的一方」取胜（与前端 _syncFromServer
        # 的合并语义一致），避免旧的短列表整体覆盖新的长列表丢消息。
        # 空列表同样不许写：它是本地读档失败/竞态的表现（合法清空走 DELETE
        # 路由），原 `not messages or` 让空列表击败任意更长的服务端历史——
        # localStorage 丢档后一切会话即触发服务端唯一副本被清空（09-20 修复）
        if not isinstance(existing, list):
            return messages
        if messages and len(existing) <= len(messages):
            return messages
        return None  # 已存历史更长（或来的是空列表）：保留，不写

    _mutate_json(msgs_path, msgs_updater, default=[])
    return {"ok": True, "count": len(messages)}


@app.delete("/api/sessions/{session_id}/messages")
async def api_clear_messages(session_id: str):
    try:
        msgs_path = _get_messages_path(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session id")
    # 清消息同样清滚动摘要并推进删除代次（阶段1 S1：复用会话 ID 不得吃旧记忆）
    context._delete_rolling_memory(session_id)
    if msgs_path.exists():
        msgs_path.unlink()
    _write_json(msgs_path, [])
    _delete_by_session(KNOWLEDGE_PATH, session_id)
    _delete_by_session(FORMULAS_PATH, session_id)
    _delete_socratic_state(session_id)
    return {"ok": True}



@app.get("/api/knowledge")
async def api_get_knowledge():
    return _dedupe_knowledge(_read_json(KNOWLEDGE_PATH, {}))


@app.get("/api/continent")
async def api_get_continent():
    """大陆投影（v1 只读 + v2 簇间边）：跨会话概念聚簇 + 共享概念 + 用户连线。

    聚簇与共享概念纯本地推导（无模型调用）；用户簇间边是主图自有数据
    （KV `continent_edges`，经 /api/kv 读写），在此合入并按当前投影校验出
    悬空边。子图（knowledge + sessions）仍是聚簇的唯一事实源，随时可重算。
    """
    items = _dedupe_knowledge(_read_json(KNOWLEDGE_PATH, {}))
    sessions = _read_json(SESSIONS_PATH, {})
    kv = _read_json(KV_PATH, {})
    user_edges = kv.get("continent_edges")
    # v6 概念族：内置表 + KV 自有扩展（用户/Φ 确认过的汇聚结果，与簇间边同级的主图数据）
    user_families = kv.get("continent_families")
    # v7.1b 门控产物：Φ 批量打标（只读离线产物，版本不符整批忽略——打开大陆仍是纯本地现算）
    gate = kv.get("continent_gate")
    return continent.build_continent(items, sessions, user_edges, user_families, gate)


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

    def updater(data):
        data = _normalize_knowledge(data)
        # 合并：同 id 以新数据为准；全量上传时等价于覆盖
        data.update(incoming)
        return _dedupe_knowledge(data)

    data = _mutate_json(KNOWLEDGE_PATH, updater)
    return {"ok": True, "count": len(data)}


@app.delete("/api/knowledge/{item_id}")
async def api_delete_knowledge(item_id: str):
    def updater(data):
        data = _normalize_knowledge(data)
        data.pop(item_id, None)
        return data

    _mutate_json(KNOWLEDGE_PATH, updater)
    return {"ok": True}



@app.get("/api/formulas")
async def api_get_formulas(q: str = ""):
    # 只读视图：去重不回写。GET 内写文件与并发 POST 存在「读→去重→覆盖」竞态，
    # 会把窗口期内新增的公式回滚丢失；物理去重改在 POST 写入路径执行
    data = _dedupe_formula_map(_read_json(FORMULAS_PATH, {}))
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
            # 去重：同会话同公式不重复入库
            existing = next((v for v in data.values()
                             if _formula_key(v.get("latex")) == _formula_key(latex)
                             and v.get("sessionId") == it.get("sessionId")), None)
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

    _mutate_json(FORMULAS_PATH, updater)
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

    _mutate_json(FORMULAS_PATH, updater)
    return {"ok": True, "count": len(removed)}


@app.delete("/api/formulas/{formula_id}")
async def api_delete_formula(formula_id: str):
    def updater(data):
        data.pop(formula_id, None)
        return data

    _mutate_json(FORMULAS_PATH, updater)
    return {"ok": True}



@app.post("/api/extract_knowledge")
async def api_extract_knowledge(request: Request):
    """从对话中提取知识点（优先 AI，失败或无模型时本地正则兜底），并自动入库公式"""
    payload = await _parse_json_object(request)

    messages = payload.get("messages", [])
    if not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
        # 下方按角色/内容逐条取字段，契约外形状直接 400
        raise HTTPException(status_code=400, detail="'messages' must be a list of message objects")
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
    added = _add_formulas_from_items(items, session_id, descriptions, message_id)
    if added:
        logger.info(f"Auto added {added} formulas to library")

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
@app.get("/api/kv/{key}")
async def api_get_kv(key: str):
    data = _read_json(KV_PATH, {})
    return {"key": key, "value": data.get(key)}


@app.post("/api/kv/{key}")
async def api_set_kv(key: str, request: Request):
    payload = await _parse_json_object(request)

    def updater(data):
        data[key] = payload.get("value", "")
        return data

    _mutate_json(KV_PATH, updater)
    return {"ok": True}


@app.delete("/api/kv/{key}")
async def api_delete_kv(key: str):
    def updater(data):
        data.pop(key, None)
        return data

    _mutate_json(KV_PATH, updater)
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



@app.get("/api/backup/export")
async def api_backup_export():
    return _build_backup_payload()


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
        return _restore_backup(backup, mode == "replace")
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

# 启动前清理历史重复知识点
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
