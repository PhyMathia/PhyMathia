"""
PhyMathia Web Application - 物理数学双域解释与可视化助手 (离线测试版)

使用固定 mock 回答代替 AI API，方便前端功能测试。
数据持久化使用 JSON 文件存储，无需 Supabase 或任何外部服务。
"""

import argparse
import base64
import json
import logging
import os
import sys
import time
import uuid
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware

from server import backup, context, documents, knowledge, mock, prompts, storage  # noqa: F401
from server.backup import *
from server.config import *
from server.context import *
from server.documents import *
from server.knowledge import *
from server.mock import *
from server.prompts import *
from server.storage import *

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ====== FastAPI 应用 ======
app = FastAPI(title="PhyMathia", description="物理数学双域解释与可视化助手 (离线测试版)")


app.state.harness_context = SYSTEM_PROMPT

if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from harness.api import router as harness_router

app.include_router(harness_router, prefix="/api/harness")

app.add_middleware(
    CORSMiddleware,
    # 仅允许本机来源（服务只绑定 127.0.0.1），避免外部网页跨域读取本地 API
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ====== 页面路由 ======
@app.get("/")
async def root():
    index_html = STATIC_DIR / "index.html"
    if index_html.exists():
        return HTMLResponse(content=index_html.read_text(encoding="utf-8"), status_code=200)
    raise HTTPException(status_code=404, detail="Index page not found")


@app.get("/chat")
async def chat_ui():
    return await root()


@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "PhyMathia offline test mode", "mock": True}



# ====== Mock 流式接口 (OpenAI 格式，前端实际调用) ======
@app.post("/v1/chat/completions")
async def openai_chat_completions(request: Request):
    try:
        payload = await request.json()
        stream = payload.get("stream", False)
        logger.info(f"OpenAI mock request: prompt={payload.get('prompt', '')[:50]}, level={payload.get('level', 'university')}, stream={stream}")

        session_id = payload.get("session_id", "")
        branch_id = payload.get("branch_id", "")
        socratic_ref = branch_id or session_id
        socratic_state = _read_socratic_state(socratic_ref) if socratic_ref else None
        is_socratic_prompt = str(payload.get("prompt") or "").lstrip().startswith("[苏格拉底回答]")
        if socratic_state and not is_socratic_prompt:
            _delete_socratic_state(socratic_ref)
            socratic_state = None
        reply_content = MOCK_ANSWER
        if socratic_state:
            reply_content = (
                MOCK_SOCRATIC_ANSWER_2
                if int(socratic_state.get("correctStreak", 0) or 0) >= 1
                else MOCK_SOCRATIC_ANSWER_1
            )
            _update_socratic_state_from_content(reply_content, socratic_ref)

        if stream:
            async def generate():
                async for chunk in _mock_stream_openai(reply_content, include_html=reply_content is MOCK_ANSWER):
                    yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                yield "data: [DONE]\n\n"

            return StreamingResponse(generate(), media_type="text/event-stream")
        else:
            return {
                "id": "phymathia-chat",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "phymathia-mock",
                "choices": [{
                    "index": 0,
                    "message": {"role": "assistant", "content": reply_content},
                    "finish_reason": "stop",
                }],
            }
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format")
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



# ====== Mock 流式接口 (内部 SSE 格式，兼容保留) ======
@app.post("/stream_run")
async def stream_run(request: Request):
    try:
        payload = await request.json()
        message = payload.get("text", payload.get("message", ""))
        logger.info(f"Stream run mock: {message[:50]}")

        async def generate_sse():
            async for chunk in _mock_stream_openai():
                choices = chunk.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    content = delta.get("content", "")
                    done = choices[0].get("finish_reason") == "stop"
                    if content:
                        yield f"event: message\ndata: {json.dumps({'type': 'content', 'content': content, 'done': False}, ensure_ascii=False)}\n\n"
            yield f"event: message\ndata: {json.dumps({'type': 'content', 'content': '', 'done': True}, ensure_ascii=False)}\n\n"

        return StreamingResponse(generate_sse(), media_type="text/event-stream")
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON format")
    except Exception as e:
        logger.error(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))



@app.post("/api/models/chat")
async def api_models_chat(request: Request):
    """代理请求到 AI API，流式返回 OpenAI 格式 SSE。
    支持两种调用格式：
    1. 新格式：{prompt, level, session_id, provider, api_key, model, base_url}
       → 后端构建消息（系统提示词 + 会话上下文 + 难度后缀）
    2. 旧格式：{messages, provider, api_key, model, base_url}
       → 直接使用传入的 messages
    """
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    model_name = payload.get("model", "")
    if not model_name and provider == "deepseek":
        model_name = "deepseek-chat"
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)

    if not api_key and provider != "opencode":
        raise HTTPException(
            status_code=400,
            detail=f"未配置 {provider} API Key：请在项目根目录 .env 中设置 DEEPSEEK_API_KEY，或在模型配置中填写密钥",
        )

    # 构建消息列表
    prompt = payload.get("prompt", "")
    session_id = payload.get("session_id", "")
    branch_id = payload.get("branch_id", "")
    branch_type = payload.get("branch_type", "")
    source_module = payload.get("source_module", "")
    parent_id = payload.get("parent_id", "")
    graph_path = payload.get("graph_path") or payload.get("graphPath") or []
    workflow_context = payload.get("workflow_context") or payload.get("workflowContext") or {}
    quick = bool(payload.get("quick"))
    is_quick = False
    socratic_ref = branch_id or session_id
    if prompt:
        # 新格式：后端构建消息
        is_socratic_prompt = prompt.lstrip().startswith("[苏格拉底回答]")
        socratic_state = _read_socratic_state(socratic_ref) if socratic_ref else None
        if socratic_state and not is_socratic_prompt:
            # 用户开始新的普通问答时，结束当前苏格拉底支线
            _delete_socratic_state(socratic_ref)
            socratic_state = None
        include_socratic = bool(socratic_state) or is_socratic_prompt

        is_quick = quick and not branch_id and not graph_path and not workflow_context
        system_content = QUICK_SYSTEM_PROMPT if is_quick else SYSTEM_PROMPT
        state_instruction = _socratic_state_instruction(socratic_ref) if socratic_ref and is_socratic_prompt else ""
        if state_instruction:
            system_content += "\n\n" + state_instruction
        if branch_id:
            system_content += _branch_context_instruction(branch_type, source_module, payload.get("branch_label", ""), parent_id)
        if graph_path:
            system_content += _graph_path_instruction(graph_path, source_module)
        if workflow_context:
            system_content += _workflow_context_instruction(workflow_context)
        messages = [{"role": "system", "content": system_content}]

        if session_id:
            context = _load_session_context(
                session_id,
                include_socratic=include_socratic,
                branch_id=branch_id,
                branch_type=branch_type,
                source_module=source_module,
                parent_id=parent_id,
                graph_path=graph_path,
                max_rounds=(1 if is_quick else 3),
                current_prompt=prompt,
            )
            messages.extend(context)

        level = payload.get("level", "university")
        if not is_quick:
            level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
            messages.append({"role": "user", "content": prompt + level_suffix})
        else:
            messages.append({"role": "user", "content": prompt})

        logger.info(f"AI proxy (built msgs): {provider}/{model_name}, level={level}, ctx_rounds={len([m for m in messages if m['role'] != 'system'])}")
    else:
        # 旧格式：直接使用传入的 messages（兼容向后）
        messages = payload.get("messages", [])
        logger.info(f"AI proxy (raw msgs): {provider}/{model_name}, msg_count={len(messages)}")

    if not base_url:
        provider_info = AI_PROVIDERS.get(provider)
        if provider_info:
            base_url = provider_info["base_url"]
        else:
            raise HTTPException(status_code=400, detail=f"Unknown provider '{provider}' and no base_url provided")

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {
        "Content-Type": "application/json",
    }
    if api_key and provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
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
        body["max_tokens"] = int(max_tokens)

    logger.info(f"AI proxy: {provider}/{model_name} -> POST {url}")

    async def proxy_stream():
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                async with client.stream("POST", url, json=body, headers=headers) as resp:
                    logger.info(f"AI proxy response: {resp.status_code} from {url}")
                    if resp.status_code != 200:
                        error_body = await resp.aread()
                        error_text = error_body.decode(errors='replace')[:500]
                        yield f"data: {json.dumps({'error': resp.status_code, 'detail': error_text})}\n\n"
                        yield "data: [DONE]\n\n"
                        return
                    if not stream:
                        raw = await resp.aread()
                        text = raw.decode(errors="replace")
                        try:
                            data = json.loads(text)
                            content = data["choices"][0]["message"]["content"]
                            _update_socratic_state_from_content(content, socratic_ref)
                        except Exception:
                            pass
                        yield text
                        return
                    streamed_content = []
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            data_str = line[6:].strip()
                            if data_str != "[DONE]":
                                try:
                                    data = json.loads(data_str)
                                    delta = data.get("choices", [{}])[0].get("delta", {})
                                    if delta.get("content"):
                                        streamed_content.append(delta["content"])
                                except Exception:
                                    pass
                            yield line + "\n\n"
                    _update_socratic_state_from_content("".join(streamed_content), socratic_ref)
        except Exception as e:
            logger.error(f"AI proxy error: {e}")
            yield f"data: {json.dumps({'error': 500, 'detail': str(e)})}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(proxy_stream(), media_type="text/event-stream")



# ====== 会话管理 API ======
@app.get("/api/sessions")
async def api_get_sessions():
    return _read_json(SESSIONS_PATH, {})


@app.post("/api/sessions")
async def api_save_sessions(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    def updater(data):
        if isinstance(payload, list):
            for sdata in payload:
                if not isinstance(sdata, dict) or not sdata.get("id"):
                    continue
                sid = sdata["id"]
                data[sid] = {
                    "id": sid,
                    "title": sdata.get("title", "新对话"),
                    "icon": sdata.get("icon", ""),
                    "sessionId": sdata.get("sessionId", ""),
                    "createdAt": sdata.get("createdAt", int(time.time() * 1000)),
                    "updatedAt": sdata.get("updatedAt", int(time.time() * 1000)),
                }
        elif isinstance(payload, dict) and "id" in payload:
            data[payload["id"]] = {
                "id": payload["id"],
                "title": payload.get("title", "新对话"),
                "icon": payload.get("icon", ""),
                "sessionId": payload.get("sessionId", ""),
                "createdAt": payload.get("createdAt", int(time.time() * 1000)),
                "updatedAt": payload.get("updatedAt", int(time.time() * 1000)),
            }
        elif isinstance(payload, dict):
            for sid, sdata in payload.items():
                data[sid] = {
                    "id": sdata.get("id", sid),
                    "title": sdata.get("title", "新对话"),
                    "icon": sdata.get("icon", ""),
                    "sessionId": sdata.get("sessionId", ""),
                    "createdAt": sdata.get("createdAt", int(time.time() * 1000)),
                    "updatedAt": sdata.get("updatedAt", int(time.time() * 1000)),
                }
        return data

    _mutate_json(SESSIONS_PATH, updater)
    return {"ok": True, "count": len(payload) if isinstance(payload, (dict, list)) else 1}


@app.put("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

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
    def updater(data):
        data.pop(session_id, None)
        return data

    _mutate_json(SESSIONS_PATH, updater)
    msgs_path = _get_messages_path(session_id)
    if msgs_path.exists():
        msgs_path.unlink()
    _delete_by_session(KNOWLEDGE_PATH, session_id)
    _delete_by_session(FORMULAS_PATH, session_id)
    _delete_socratic_state(session_id)
    return {"ok": True}


@app.delete("/api/sessions")
async def api_clear_all_sessions():
    _write_json(SESSIONS_PATH, {})
    for f in MESSAGES_DIR.glob("*.json"):
        f.unlink()
    _write_json(KNOWLEDGE_PATH, {})
    _write_json(FORMULAS_PATH, {})
    _write_json(KV_PATH, {})
    return {"ok": True}



# ====== 消息管理 API ======
@app.get("/api/sessions/{session_id}/messages")
async def api_get_messages(session_id: str):
    return _read_json(_get_messages_path(session_id), [])


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
    _write_json(_get_messages_path(session_id), messages)
    return {"ok": True, "count": len(messages)}


@app.delete("/api/sessions/{session_id}/messages")
async def api_clear_messages(session_id: str):
    msgs_path = _get_messages_path(session_id)
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


@app.post("/api/knowledge")
async def api_save_knowledge(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    incoming = _normalize_knowledge(payload)

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
    raw = _read_json(FORMULAS_PATH, {})
    data = _dedupe_formula_map(raw)
    if len(data) != len(raw):
        _write_json(FORMULAS_PATH, data)
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
    count = 0

    def updater(data):
        nonlocal count
        for it in items:
            latex = _normalize_formula(it.get("latex") or "")
            if not latex:
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
                for key in ("concept", "topic", "related", "messageId", "moduleKey"):
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
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    messages = payload.get("messages", [])
    session_id = payload.get("sessionId", "")
    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    model = payload.get("model", "")
    base_url = payload.get("base_url", "")
    level = payload.get("level", "university")
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY

    latest_assistant = next((m for m in reversed(messages) if m.get("role") == "assistant"), None)
    if latest_assistant and (
        _is_socratic_followup(latest_assistant.get("content", ""))
        or latest_assistant.get("branchType") in ("followup", "confused", "socratic")
    ):
        return {"items": []}
    # 公式描述模型（前端传入，可选；未配置时回退默认摘要）
    desc_provider = payload.get("descriptor_provider", "")
    desc_api_key = payload.get("descriptor_api_key", "")
    desc_model = payload.get("descriptor_model", "")
    desc_base_url = payload.get("descriptor_base_url", "")
    if not desc_api_key and desc_provider == "deepseek":
        desc_api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if not desc_api_key and desc_provider == "opencode":
        desc_api_key = OPENCODE_DEFAULT_API_KEY

    items = []
    if (api_key or provider == "opencode") and model:
        try:
            items = await _ai_extract_knowledge(messages, provider, api_key, model, base_url, level)
            if items:
                logger.info(f"AI extract: {len(items)} items for session {session_id}")
        except Exception as e:
            logger.warning(f"AI extract failed, fallback to local: {e}")
    if not items:
        items = _local_extract_knowledge(messages)
        if items:
            logger.info(f"Local extract: {len(items)} items for session {session_id}")

    # 摘要双重用途：主模型 <summary> 标签 → 知识条目 summary（替代内容截断）
    summary_text = _extract_summary(messages)
    if summary_text:
        for it in items:
            it["summary"] = summary_text[:200]

    # 公式描述：配置了描述模型且有公式时，为新增公式生成简要描述
    descriptions = {}
    all_formulas = []
    for it in items:
        for f in (it.get("formulas") or []):
            latex = _normalize_formula(str(f).strip())
            if latex and _looks_like_formula(latex) and latex not in all_formulas:
                all_formulas.append(latex)
    if all_formulas and desc_model and (desc_api_key or desc_provider == "opencode"):
        descriptions = await _describe_formulas(summary_text, all_formulas, desc_provider, desc_api_key, desc_model, desc_base_url, level)
        if descriptions:
            logger.info(f"Generated {len(descriptions)} formula descriptions for session {session_id}")

    message_id = str(latest_assistant.get("timestamp") or "") if latest_assistant else ""
    added = _add_formulas_from_items(items, session_id, descriptions, message_id)
    if added:
        logger.info(f"Auto added {added} formulas to library")

    return {"items": items, "descriptions": descriptions}



@app.post("/api/documents/parse")
async def api_parse_document(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    filename = _sanitize_filename(payload.get("fileName") or "")
    try:
        max_items = min(max(int(payload.get("maxItems") or 5), 1), 50)
    except (TypeError, ValueError):
        max_items = 5
    content = None
    file_id = str(payload.get("fileId") or "")
    if file_id:
        loaded = _read_upload(file_id)
        if not loaded:
            raise HTTPException(status_code=404, detail="文件不存在，请重新上传")
        entry, content = loaded
        filename = _sanitize_filename(entry.get("filename") or filename)
    else:
        try:
            content = base64.b64decode(str(payload.get("contentBase64") or ""))
        except Exception:
            raise HTTPException(status_code=400, detail="文件内容格式错误")
        if not content:
            raise HTTPException(status_code=400, detail="缺少文件内容")
        if len(content) > UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 20MB 限制")
        file_id = "doc_" + uuid.uuid4().hex[:12]
        _save_upload(file_id, filename, content)

    text = _extract_document_text(filename, content)
    ext = Path(filename).suffix.lower()
    is_image = ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}
    image_b64 = base64.b64encode(content).decode("ascii") if is_image else ""

    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    level = str(payload.get("level") or "university")
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY

    nodes, edges, relations = [], [], []
    if model and (api_key or provider == "opencode"):
        try:
            nodes, edges, relations = await _ai_extract_document_knowledge(
                text, filename, is_image, image_b64, provider, api_key, model, base_url, level, max_items
            )
        except Exception as e:
            logger.warning(f"AI document extraction failed: {e}")
    if not nodes:
        nodes, edges, relations = _local_extract_document_knowledge(text, filename, max_items)
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
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

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



@app.get("/api/backup/export")
async def api_backup_export():
    return _build_backup_payload()


@app.post("/api/backup/import")
async def api_backup_import(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    backup = payload.get("backup") if isinstance(payload.get("backup"), dict) else payload
    if not isinstance(backup, dict):
        raise HTTPException(status_code=400, detail="Backup payload must be an object")
    mode = str(payload.get("mode") or "merge").lower()
    if mode not in ("merge", "replace"):
        raise HTTPException(status_code=400, detail="mode must be merge or replace")
    return _restore_backup(backup, mode == "replace")



# ====== 静态文件 catch-all（必须放在所有 API 路由之后）======
@app.get("/{filename:path}")
async def serve_static_file(filename: str):
    if not filename:
        return await root()
    path = Path(filename)
    if path.suffix.lower() in STATIC_EXTENSIONS:
        file_path = (STATIC_DIR / filename).resolve()
        # 防目录穿越：仅允许解析后仍位于 STATIC_DIR 内的文件
        if file_path.is_relative_to(STATIC_DIR.resolve()) and file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
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
    logger.info(f"  - Mock: Enabled (no AI API required)")
    logger.info("=" * 50)
    logger.info(f"访问地址: http://localhost:{args.port}")
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=args.port,
        reload=args.reload,
        workers=1,
    )
