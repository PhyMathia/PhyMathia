"""
PhyMathia Web Application - 物理数学双域解释与可视化助手 (离线测试版)

使用固定 mock 回答代替 AI API，方便前端功能测试。
数据持久化使用 JSON 文件存储，无需 Supabase 或任何外部服务。
"""

import argparse
import asyncio
import json
import logging
import os
import time
import uuid
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from starlette.middleware.cors import CORSMiddleware

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
)
logger = logging.getLogger(__name__)

# ====== 数据持久化目录 ======
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR.parent / "data"
MESSAGES_DIR = DATA_DIR / "messages"
DATA_DIR.mkdir(parents=True, exist_ok=True)
MESSAGES_DIR.mkdir(parents=True, exist_ok=True)

SESSIONS_PATH = DATA_DIR / "sessions.json"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.json"
KV_PATH = DATA_DIR / "kv_store.json"

# ====== FastAPI 应用 ======
app = FastAPI(title="PhyMathia", description="物理数学双域解释与可视化助手 (离线测试版)")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ====== 静态文件配置 ======
STATIC_DIR = BASE_DIR / "static"
STATIC_EXTENSIONS = {
    ".png", ".jpg", ".jpeg", ".svg", ".gif", ".ico",
    ".webp", ".css", ".js", ".woff", ".woff2", ".ttf",
}


# ====== JSON 文件持久化工具 ======
def _read_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return default if default is not None else {}


def _write_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _get_messages_path(session_id: str) -> Path:
    return MESSAGES_DIR / f"{session_id}.json"


# ====== System Prompt & Level Prompts ======
SYSTEM_PROMPT = """你是一个物理数学双域解释与可视化助手 PhyMathia。
请按以下格式组织回答，用 XML 标签包裹各部分，不要省略任何部分：

<physics>
物理视角的内容...
</physics>

<math>
数学视角的内容...
</math>

<graph>
知识图谱 Mermaid 代码...
</graph>

<extend>
延伸思考的问题...
</extend>

规则：
- 物理视角：侧重物理直觉、实验现象、能量角度，少量公式
- 数学视角：侧重数学推导、微分方程、对称性，可深入公式
- 知识图谱：输出 Mermaid 代码，用 ```mermaid ... ``` 包裹
- 延伸思考：2-3个引导性问题，可带难度标注
- 如果问题只偏一方，两个标题都要保留，内容可简短
- 可视化 HTML 用 ```html ... ``` 包裹（必要时可单独输出）
"""

LEVEL_PROMPTS = {
    "middle": "（用户是初高中学生，请用最通俗易懂的语言讲解，避免使用大学水平的术语，多用生活中的类比，公式尽量简化，数学推导步骤详细不跳步）",
    "university": "（用户是大学生，请用标准大学物理/数学的教学深度讲解，可以使用专业术语但需要解释，推导步骤完整）",
    "research": "（用户是科研人员，请用学术深度讲解，可以使用高级数学工具和前沿研究视角，推导可以简略关键步骤，关注物理本质和数学结构的深层联系）",
}


def _load_session_context(session_id: str, max_rounds: int = 3) -> list:
    """加载会话上下文消息，返回最近 max_rounds 轮对话"""
    messages_path = _get_messages_path(session_id)
    all_messages = _read_json(messages_path, [])
    if not all_messages:
        return []
    result = []
    rounds = 0
    for msg in reversed(all_messages):
        result.insert(0, {"role": msg.get("role", "user"), "content": msg.get("content", "")})
        if msg.get("role") == "user":
            rounds += 1
            if rounds >= max_rounds:
                break
    return result


# ====== 固定 Mock 回答 ======
MOCK_ANSWER = r"""<physics>
## 🔬 物理视角

简谐运动是物体在回复力 $F=-kx$ 作用下的周期性运动。想象一个弹簧振子：当你拉长弹簧后松手，物体会在平衡位置附近来回振荡。

关键物理量：
- **振幅 A**：最大偏离距离
- **周期 T**：完成一次完整振动的时间，$T = 2\pi\sqrt{\frac{m}{k}}$
- **频率 f**：单位时间内振动次数，$f = 1/T$

在振动过程中，动能和势能不断相互转换，但总机械能守恒：
$$E_{\text{total}} = \frac{1}{2}kA^2$$

</physics>
<math>
## 📐 数学视角

简谐运动的位移随时间变化满足正弦函数：
$$x(t) = A\cos(\omega t + \varphi_0)$$

其中角频率 $\omega = \sqrt{\frac{k}{m}}$，$\varphi_0$ 是初相位。

速度与加速度：
$$v(t) = -A\omega\sin(\omega t + \varphi_0)$$
$$a(t) = -A\omega^2\cos(\omega t + \varphi_0) = -\omega^2 x(t)$$

可见加速度始终与位移方向相反、大小成正比，这正是简谐运动的数学本质——二阶线性微分方程：
$$\frac{d^2x}{dt^2} + \omega^2 x = 0$$

</math>
<graph>
## 🧠 知识图谱

```mermaid
graph TD
    A[简谐运动] --> B[物理特征]
    A --> C[数学描述]
    B --> D[回复力 F=-kx]
    B --> E[能量守恒]
    B --> F[周期 T=2π√(m/k)]
    C --> G[正弦/余弦函数]
    C --> H[微分方程]
    C --> I[相空间椭圆]
    G --> J[x=Acos(ωt+φ₀)]
    H --> K[ẍ+ω²x=0]
```

</graph>
<extend>
## 💡 延伸思考

1. 阻尼振动中能量如何耗散？微分方程会变成什么形式？
2. 受迫振动在驱动频率接近固有频率时会发生什么？（共振！）
3. 复数和相量如何简化简谐运动的叠加分析？
</extend>"""


MOCK_HTML_VISUALIZATION = r"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
body{margin:16px;background:#0f142d;color:#f0f4f8;font-family:sans-serif;display:flex;flex-direction:column;align-items:center}
h2{color:#4a9eff;margin:0 0 10px;font-size:18px}
canvas{border:1px solid rgba(74,158,255,0.3);border-radius:8px;background:rgba(10,14,30,0.5);max-width:100%}
.controls{display:flex;gap:16px;margin:12px 0;flex-wrap:wrap;justify-content:center}
.slider-group{display:flex;flex-direction:column;align-items:center;gap:2px}
.slider-group label{font-size:12px;color:#a0b0d0}
.slider-group input{width:100px}
.info{font-size:13px;color:#a0b0d0;margin-top:8px;text-align:center}
</style></head>
<body>
<h2>&#x1f52c; 简谐运动可视化</h2>
<canvas id="c" width="560" height="160"></canvas>
<div class="controls">
<div class="slider-group"><label>振幅 A</label><input type="range" id="aA" min="20" max="80" value="60"></div>
<div class="slider-group"><label>角频率 &#x3c9;</label><input type="range" id="aW" min="1" max="5" value="2" step="0.1"></div>
<div class="slider-group"><label>速度</label><input type="range" id="aSp" min="0.5" max="3" value="1" step="0.1"></div>
</div>
<div class="info" id="info">x = 60 cos(2.0 t)</div>
<script>
(function(){function r(){
var c=document.getElementById('c'),ctx=c.getContext('2d');
var A=parseFloat(document.getElementById('aA').value)||60;
var w=parseFloat(document.getElementById('aW').value)||2;
var sp=parseFloat(document.getElementById('aSp').value)||1;
t=(t||0)+0.02*sp;var x=A*Math.cos(w*t);var cx=280+x;
ctx.clearRect(0,0,560,160);
ctx.fillStyle='rgba(74,158,255,0.05)';ctx.fillRect(0,0,560,160);
ctx.strokeStyle='rgba(74,158,255,0.15)';ctx.setLineDash([4,4]);
ctx.beginPath();ctx.moveTo(280,30);ctx.lineTo(280,130);ctx.stroke();
ctx.setLineDash([]);
ctx.fillStyle='#4a9eff';ctx.beginPath();ctx.arc(cx,80,8,0,Math.PI*2);ctx.fill();
ctx.fillStyle='rgba(74,158,255,0.25)';ctx.beginPath();ctx.arc(cx,80,14,0,Math.PI*2);ctx.fill();
ctx.strokeStyle='#4a9eff';ctx.beginPath();ctx.moveTo(280,80);ctx.lineTo(cx,80);ctx.stroke();
var v=-A*w*Math.sin(w*t);
document.getElementById('info').textContent='x='+x.toFixed(1)+'  '+'v='+v.toFixed(1);
requestAnimationFrame(r)}
document.getElementById('aA').addEventListener('input',r);
document.getElementById('aW').addEventListener('input',r);
document.getElementById('aSp').addEventListener('input',r);
var t=0;r()})();
</script>
</body></html>"""


async def _mock_stream_openai():
    """生成 OpenAI 格式的 mock SSE 流，模拟逐字输出"""
    # 首个空 chunk（触发前端进度显示）
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "choices": [{"index": 0, "delta": {"content": ""}, "finish_reason": None}],
    }
    await asyncio.sleep(0.3)

    # 逐 chunk 发送 markdown 内容
    chunk_size = 4
    for i in range(0, len(MOCK_ANSWER), chunk_size):
        chunk = MOCK_ANSWER[i : i + chunk_size]
        yield {
            "id": "phymathia-chat",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": "phymathia-mock",
            "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}],
        }
        await asyncio.sleep(0.015)

    await asyncio.sleep(0.2)

    # 发送可视化 HTML（前端会识别 ` ```html `...` ``` ` 并转为 iframe 卡片）
    html_block = f"\n\n```html\n{MOCK_HTML_VISUALIZATION}\n```\n"
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "choices": [{"index": 0, "delta": {"content": html_block}, "finish_reason": None}],
    }
    await asyncio.sleep(0.1)

    # 结束标记
    yield {
        "id": "phymathia-chat",
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": "phymathia-mock",
        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
    }


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

        if stream:
            async def generate():
                async for chunk in _mock_stream_openai():
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
                    "message": {"role": "assistant", "content": MOCK_ANSWER},
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


# ====== AI 模型代理 API ======
AI_PROVIDERS = {
    "deepseek": {"base_url": "https://api.deepseek.com"},
    "openai": {"base_url": "https://api.openai.com/v1"},
}

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
    model_name = payload.get("model", "")
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)

    # 构建消息列表
    prompt = payload.get("prompt", "")
    if prompt:
        # 新格式：后端构建消息
        messages = [{"role": "system", "content": SYSTEM_PROMPT}]

        session_id = payload.get("session_id", "")
        if session_id:
            context = _load_session_context(session_id)
            messages.extend(context)

        level = payload.get("level", "university")
        level_suffix = LEVEL_PROMPTS.get(level, LEVEL_PROMPTS["university"])
        messages.append({"role": "user", "content": prompt + level_suffix})

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
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    body = {
        "model": model_name,
        "messages": messages,
        "stream": stream,
    }

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
                    async for line in resp.aiter_lines():
                        if line.startswith("data: "):
                            yield line + "\n\n"
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

    data = _read_json(SESSIONS_PATH, {})

    if isinstance(payload, dict) and "id" in payload:
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

    _write_json(SESSIONS_PATH, data)
    return {"ok": True, "count": len(payload) if isinstance(payload, dict) else 1}


@app.put("/api/sessions/{session_id}")
async def api_update_session(session_id: str, request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    data = _read_json(SESSIONS_PATH, {})
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

    _write_json(SESSIONS_PATH, data)
    return {"ok": True}


@app.delete("/api/sessions/{session_id}")
async def api_delete_session(session_id: str):
    data = _read_json(SESSIONS_PATH, {})
    data.pop(session_id, None)
    _write_json(SESSIONS_PATH, data)
    msgs_path = _get_messages_path(session_id)
    if msgs_path.exists():
        msgs_path.unlink()
    return {"ok": True}


@app.delete("/api/sessions")
async def api_clear_all_sessions():
    _write_json(SESSIONS_PATH, {})
    for f in MESSAGES_DIR.glob("*.json"):
        f.unlink()
    _write_json(KNOWLEDGE_PATH, {})
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
    _write_json(_get_messages_path(session_id), messages)
    return {"ok": True, "count": len(messages)}


@app.delete("/api/sessions/{session_id}/messages")
async def api_clear_messages(session_id: str):
    msgs_path = _get_messages_path(session_id)
    if msgs_path.exists():
        msgs_path.unlink()
    _write_json(msgs_path, [])
    return {"ok": True}


# ====== 知识条目 API ======
@app.get("/api/knowledge")
async def api_get_knowledge():
    return _read_json(KNOWLEDGE_PATH, {})


@app.post("/api/knowledge")
async def api_save_knowledge(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    items = payload if isinstance(payload, dict) else payload.get("items", {})
    _write_json(KNOWLEDGE_PATH, items)
    return {"ok": True, "count": len(items)}


@app.delete("/api/knowledge/{item_id}")
async def api_delete_knowledge(item_id: str):
    data = _read_json(KNOWLEDGE_PATH, {})
    data.pop(item_id, None)
    _write_json(KNOWLEDGE_PATH, data)
    return {"ok": True}


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

    data = _read_json(KV_PATH, {})
    data[key] = payload.get("value", "")
    _write_json(KV_PATH, data)
    return {"ok": True}


@app.delete("/api/kv/{key}")
async def api_delete_kv(key: str):
    data = _read_json(KV_PATH, {})
    data.pop(key, None)
    _write_json(KV_PATH, data)
    return {"ok": True}


# ====== 静态文件 catch-all（必须放在所有 API 路由之后）======
@app.get("/{filename:path}")
async def serve_static_file(filename: str):
    if not filename:
        return await root()
    path = Path(filename)
    if path.suffix.lower() in STATIC_EXTENSIONS:
        file_path = STATIC_DIR / filename
        if file_path.exists() and file_path.is_file():
            return FileResponse(str(file_path))
    raise HTTPException(status_code=404, detail="Not found")


# ====== 启动 ======
def parse_args():
    parser = argparse.ArgumentParser(description="Start PhyMathia (offline test mode)")
    parser.add_argument("-p", "--port", type=int, default=5000, help="Server port")
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
        host="0.0.0.0",
        port=args.port,
        reload=args.reload,
        workers=1,
    )
