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
import re
import threading
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

# ====== .env 加载（无第三方依赖）======
def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


_load_env_file(Path(__file__).resolve().parent.parent / ".env")

# ====== 数据持久化目录 ======
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR.parent / "data"
MESSAGES_DIR = DATA_DIR / "messages"
DATA_DIR.mkdir(parents=True, exist_ok=True)
MESSAGES_DIR.mkdir(parents=True, exist_ok=True)

SESSIONS_PATH = DATA_DIR / "sessions.json"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.json"
KV_PATH = DATA_DIR / "kv_store.json"
FORMULAS_PATH = DATA_DIR / "formulas.json"

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
_JSON_LOCK = threading.RLock()


def _read_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return default if default is not None else {}


def _write_json(path: Path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with _JSON_LOCK:
        try:
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(tmp_path, path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


def _mutate_json(path: Path, updater, default=None):
    """串行执行 JSON 文件的读-改-写，避免并发请求互相覆盖。"""
    with _JSON_LOCK:
        data = _read_json(path, default)
        result = updater(data)
        if result is not None:
            _write_json(path, result)
            return result
        return data


def _delete_by_session(path: Path, session_id: str) -> int:
    """删除数据中属于指定会话的条目，返回删除数量。"""
    removed = []

    def updater(data):
        nonlocal removed
        removed = [k for k, v in data.items() if v.get("sessionId") == session_id]
        for k in removed:
            data.pop(k, None)
        return data if removed else None

    _mutate_json(path, updater)
    return len(removed)


def _get_messages_path(session_id: str) -> Path:
    return MESSAGES_DIR / f"{session_id}.json"


# ====== System Prompt & Level Prompts ======
def _load_system_prompt() -> str:
    """从 system prompt.md 加载系统提示词，失败时使用默认提示词"""
    prompt_path = BASE_DIR / "system prompt.md"
    if prompt_path.exists():
        content = prompt_path.read_text(encoding="utf-8").strip()
        logger.info(f"Loaded system prompt from {prompt_path} ({len(content)} chars)")
        return content
    logger.warning(f"System prompt file not found: {prompt_path}, using default")
    return """你是一个物理数学双域解释与可视化助手 PhyMathia。
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

SYSTEM_PROMPT = _load_system_prompt()

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

简谐运动是物体在回复力 <formula>F=-kx</formula> 作用下的周期性运动。想象一个弹簧振子：当你拉长弹簧后松手，物体会在平衡位置附近来回振荡。

关键物理量：
- **振幅 A**：最大偏离距离
- **周期 T**：完成一次完整振动的时间，<formula>T = 2\pi\sqrt{\frac{m}{k}}</formula>
- **频率 f**：单位时间内振动次数，<formula>f = 1/T</formula>

在振动过程中，动能和势能不断相互转换，但总机械能守恒：
<formula>E_{\text{total}} = \frac{1}{2}kA^2</formula>

</physics>
<math>
## 📐 数学视角

简谐运动的位移随时间变化满足正弦函数：
<formula>x(t) = A\cos(\omega t + \varphi_0)</formula>

其中角频率 <formula>\omega = \sqrt{\frac{k}{m}}</formula>，φ₀ 是初相位。

速度与加速度：
<formula>v(t) = -A\omega\sin(\omega t + \varphi_0)</formula>
<formula>a(t) = -A\omega^2\cos(\omega t + \varphi_0) = -\omega^2 x(t)</formula>

可见加速度始终与位移方向相反、大小成正比，这正是简谐运动的数学本质——二阶线性微分方程：
<formula>\frac{d^2x}{dt^2} + \omega^2 x = 0</formula>

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
</extend>

<summary>简谐运动是回复力与位移成正比的周期运动，能量在动能与势能间周期转换</summary>"""


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
    if not api_key and provider == "deepseek":
        api_key = os.getenv("DEEPSEEK_API_KEY", "")
    model_name = payload.get("model", "")
    if not model_name and provider == "deepseek":
        model_name = "deepseek-chat"
    base_url = payload.get("base_url", "")
    stream = payload.get("stream", True)

    if not api_key:
        raise HTTPException(
            status_code=400,
            detail=f"未配置 {provider} API Key：请在项目根目录 .env 中设置 DEEPSEEK_API_KEY，或在模型配置中填写密钥",
        )

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
                    if not stream:
                        raw = await resp.aread()
                        yield raw.decode(errors="replace")
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

    def updater(data):
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
        return data

    _mutate_json(SESSIONS_PATH, updater)
    return {"ok": True, "count": len(payload) if isinstance(payload, dict) else 1}


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
    return {"ok": True}


# ====== 知识条目 API ======
def _normalize_knowledge(data) -> dict:
    """将 knowledge 数据归一化为 id->item 映射。

    兼容三种历史格式：
    - {"items": [...]} 包装（POST 直写 payload 的历史残留）
    - {"items": {...}} 包装
    - 纯数组 [item, ...]
    以及垃圾数据 {"items": null} -> {}
    """
    if not isinstance(data, dict):
        return {}
    if "items" in data:
        items = data.get("items")
        if isinstance(items, dict):
            return items
        if isinstance(items, list):
            return {it.get("id") or ("k_" + uuid.uuid4().hex[:12]): it
                    for it in items if isinstance(it, dict)}
        return {}
    return data


@app.get("/api/knowledge")
async def api_get_knowledge():
    return _normalize_knowledge(_read_json(KNOWLEDGE_PATH, {}))


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
        return data

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


# ====== 公式库 API ======
def _normalize_formula(latex: str) -> str:
    """标准化公式：\$→$、去首尾 $、统一包 $..$；无效返回空串"""
    s = (latex or "").strip()
    s = s.replace("\\$", "$").strip()
    s = re.sub(r"^\$+|\$+$", "", s).strip()
    # 清洗 PowerShell 转义等产生的无效 LaTeX 命令（\= 等）
    s = re.sub(r"\\([=,;:])", r"\1", s)
    if not s:
        return ""
    return f"${s}$"


def _formula_key(latex: str) -> str:
    """生成用于跨来源去重的公式键，忽略定界符和常见空白差异。"""
    s = _normalize_formula(latex).strip("$").strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"\s*([=,;:+\-*/])\s*", r"\1", s)
    return s.strip()


def _looks_like_formula(latex: str) -> bool:
    """判断提取的文本是否像真正的公式（排除单字符、纯命令、纯单位、短字母串）。

    KaTeX 等解析工具只能校验语法合法性（单字符 m、纯命令 \\omega 都是合法 LaTeX），
    是否"算公式"是语义判断，需结构启发式：保留含运算符/函数/数字/上下标的结构。
    """
    s = (latex or "").strip().strip("$").strip()
    if not s:
        return False
    # 单个字符（字母/数字/符号）不算公式：m、k、ω
    if len(s) == 1:
        return False
    # 纯短字母串（≤3 个字母，无结构）：rad、kg、Hz
    if re.fullmatch(r"[A-Za-z]{1,3}", s):
        return False
    # 纯符号命令：\omega、\pi、\theta
    if re.fullmatch(r"\\[A-Za-z]+", s):
        return False
    # 纯 \text{...}（单位/文字）：\text{rad/s}
    if re.fullmatch(r"\\text\{[^{}]*\}", s):
        return False
    # 纯短字母+斜杠（单位）：rad/s、m/s
    if re.fullmatch(r"[A-Za-z]{1,4}(/[A-Za-z]{1,4})+", s):
        return False
    # 其余视为公式（含 = + - ( ) { } 数字、函数结构等）
    return True


def _dedupe_formula_map(data: dict) -> dict:
    """按会话+规范化公式去重，保留较新的记录。"""
    seen = set()
    result = {}
    for fid in sorted(data, key=lambda k: data[k].get("createdAt", 0) or 0, reverse=True):
        item = data[fid]
        key = (_formula_key(item.get("latex") or ""), item.get("sessionId"))
        if key not in seen:
            result[fid] = item
            seen.add(key)
    return result


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
                for key in ("concept", "meaning", "topic", "related"):
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
                "topic": (it.get("topic") or "")[:60],
                "related": [str(t) for t in (it.get("related") or [])][:8],
                "sessionId": it.get("sessionId", ""),
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


# ====== 知识提取 API ======
EXTRACT_PROMPT = """你是知识提取助手。请从下面这段对话中提取关键知识点（1-5 个），
只输出 JSON，不要输出任何其他内容或解释：
{"items": [{"title": "知识点名称", "category": "physics|math|other", "tags": ["标签1", "标签2"], "summary": "一句话摘要", "formulas": ["$F=ma$"]}]}
要求：
- title 是具体概念名，如"简谐运动"
- category 三选一：physics（物理现象/定律）、math（数学结构/定理）、other
- formulas 中公式用 $...$ 或 $$...$$ 包裹，没有公式则为空数组
- 不要编造对话中不存在的知识点"""


def _parse_extract_json(text: str) -> list:
    """容错解析模型输出的 JSON"""
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if m:
        text = m.group(1)
    else:
        start, end = text.find("{"), text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return []
    items = data.get("items", []) if isinstance(data, dict) else []
    result = []
    for it in items:
        if not isinstance(it, dict):
            continue
        title = _clean_knowledge_title(str(it.get("title", "")))
        if not title:
            continue
        category = it.get("category")
        if category not in ("physics", "math", "other"):
            category = "other"
        formulas = []
        for f in (it.get("formulas") or []):
            fs = str(f).strip()
            if fs and _looks_like_formula(fs):
                formulas.append(fs)
        result.append({
            "title": title[:80],
            "category": category,
            "tags": [str(t).strip() for t in (it.get("tags") or []) if str(t).strip()][:6],
            "summary": str(it.get("summary", ""))[:200],
            "formulas": formulas[:8],
        })
    return result[:6]


def _clean_knowledge_title(title: str) -> str:
    """把学习卡片标题规范成具体知识点名，过滤视角/图谱/追问等模块标题。"""
    title = str(title or "").strip()
    title = re.sub(r"^#+\s*", "", title).splitlines()[0].strip() if title else ""
    title = re.sub(r"^.*?PhyMathia\s*学习卡片\s*[:：]\s*", "", title).strip()
    title = re.sub(r"的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向)$", "", title).strip()
    title = re.sub(r"的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$", "", title).strip()
    title = re.sub(r"^[🔬📐🧠💡🗺️]+\s*", "", title).strip()
    return title


def _pick_knowledge_title(titles: list, content: str) -> str:
    """优先取学习卡片标题，其次取第一个非模块标题。"""
    module_keywords = (
        "物理直觉", "数学本质", "物理视角", "数学视角",
        "知识图谱", "延伸思考", "进阶学习方向", "学习方向",
    )
    card_title = next((t for t in titles if "PhyMathia" in t and "学习卡片" in t), None)
    if card_title:
        cleaned = _clean_knowledge_title(card_title)
        if cleaned:
            return cleaned
    for t in titles:
        if any(k in t for k in module_keywords):
            continue
        cleaned = _clean_knowledge_title(t)
        if cleaned:
            return cleaned
    return ""


def _formula_tags_from_content(content: str, formulas: list) -> dict:
    """按公式所在的 <physics>/<math> 区块给公式打标签。"""
    def _section(tag: str) -> str:
        m = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", content, re.I)
        return m.group(1) if m else ""

    physics_content = _section("physics")
    math_content = _section("math")
    result = {}
    for formula in formulas:
        stripped = formula.strip("$").strip()
        tags = []
        if stripped and stripped in physics_content:
            tags.append("物理")
        if stripped and stripped in math_content:
            tags.append("数学")
        if tags:
            result[formula] = tags
    return result


def _local_formula_meaning(latex: str, summary: str, concept: str) -> str:
    """没有描述模型时，为单个公式生成一句具体、简短的含义。"""
    s = _normalize_formula(latex).strip("$").strip()
    s = re.sub(r"\s+", " ", s)
    rules = [
        (r"(\\sum|\\int).*e\^", "傅里叶级数/变换：用指数基元把信号分解为频率成分"),
        (r"\\sum", "傅里叶级数：用离散频率谐波叠加表示周期信号"),
        (r"\\int", "傅里叶变换：把信号分解为连续频率分量的积分表示"),
        (r"^F\s*=\s*-?\s*k\s*x", "胡克定律：回复力与位移大小成正比、方向相反"),
        (r"^T\s*=\s*2\\pi\\sqrt\{\\frac\{m\}\{k\}\}", "简谐运动周期由质量与劲度系数决定"),
        (r"^f\s*=\s*1\s*/\s*T", "频率是周期的倒数"),
        (r"\\omega\s*=\s*\\sqrt\{\\frac\{k\}\{m\}\}", "角频率由劲度系数与质量共同决定"),
        (r"E\s*=\s*\\frac\{1\}\{2\}kA\^2", "简谐运动总机械能与振幅平方成正比"),
        (r"v\(t\).*\\sin", "速度随时间呈正弦变化，相位落后于位移"),
        (r"a\(t\).*\\omega\^2.*x", "加速度与位移反向且成正比"),
        (r"x\(t\).*\\cos", "位移随时间余弦变化，A 为振幅"),
        (r"\\frac\{d\^2x\}\{dt\^2\}.*\\omega\^2.*x", "二阶线性微分方程：加速度与位移成正比且反向"),
    ]
    for pattern, description in rules:
        if re.search(pattern, s):
            return description
    if concept and concept != "相关公式":
        clean_concept = re.sub(r"的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$", "", concept).strip()
        return f"{clean_concept}相关公式：用于描述{clean_concept}的定量关系"
    return "该公式用于描述物理量之间的定量关系"


def _local_extract_knowledge(messages: list) -> list:
    """本地正则兜底提取：从最近的 assistant 消息提取公式与标题"""
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content") or ""
        if not content.strip():
            continue

        formulas = []
        # 优先提取 AI 按规范标注的 <formula>...</formula> 标签（精准公式）
        tagged = re.findall(r"<formula>([\s\S]*?)</formula>", content, re.I)
        if tagged:
            for expr in tagged:
                normalized = _normalize_formula(expr)
                if normalized and _looks_like_formula(normalized) and normalized not in formulas:
                    formulas.append(normalized)
                if len(formulas) >= 8:
                    break
        # 无标注时回退：同时匹配 $$..$$、\(..\)（AI 实际输出格式）、\[..\]、$..$
        if not formulas:
            for m in re.finditer(r"\$\$([^$\n]+)\$\$|\\\((.+?)\\\)|\\\[(.+?)\\\]|\$([^$\n]+)\$", content):
                expr = next((g for g in m.groups() if g), "")
                normalized = _normalize_formula(expr)
                # 过滤单字符/纯命令/纯单位等非公式（如 \(m\)、\(\omega\)、\text{rad/s}）
                if normalized and _looks_like_formula(normalized) and normalized not in formulas:
                    formulas.append(normalized)
                if len(formulas) >= 8:
                    break

        titles = [t.strip() for t in re.findall(r"^#{1,3}\s+(.+?)\s*$", content, re.M) if t.strip()]
        title = _pick_knowledge_title(titles, content)
        if not title:
            text = re.sub(r"<[^>]+>", " ", content)
            text = re.sub(
                r"^\s*#{1,3}\s*(?:[🔬📐🧠💡🗺️]+\s*)?(?:物理视角|数学视角|物理直觉|数学本质|知识图谱|延伸思考)\s*",
                "",
                text,
            )
            text = re.sub(r"\s+", " ", text).strip()
            concept_match = re.match(r"^([^，。；、]{2,24})是", text)
            title = concept_match.group(1) if concept_match else (text[:40] + ("..." if len(text) > 40 else ""))

        c = content[:2000]
        has_math_kw = any(k in c for k in ("方程", "函数", "导数", "积分", "矩阵", "几何", "代数", "微分", "定理", "证明", "数学"))
        has_phy_kw = any(k in c for k in ("物理", "力学", "电磁", "光学", "热", "振动", "波", "场", "力", "能量", "实验"))
        if has_phy_kw and not has_math_kw:
            category = "physics"
        elif has_math_kw and not has_phy_kw:
            category = "math"
        elif has_phy_kw and has_math_kw:
            category = "math" if ("数学本质" in c or "数学视角" in c) else "physics"
        else:
            category = "other"

        formula_tags = _formula_tags_from_content(content, formulas)
        summary = re.sub(r"\s+", " ", content)[:120]
        return [{
            "title": title[:80],
            "category": category,
            "tags": ["物理" if category == "physics" else "数学" if category == "math" else "其他"],
            "summary": summary,
            "formulas": formulas,
            "formula_tags": formula_tags,
        }]
    return []


async def _ai_extract_knowledge(messages: list, provider: str, api_key: str, model: str, base_url: str) -> list:
    """调用 AI 模型提取知识点（非流式）"""
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return []

    # 取最近一轮对话（最后一条 user 消息及之后）
    msgs = [{"role": "system", "content": EXTRACT_PROMPT}]
    last_user_idx = -1
    for i, m in enumerate(messages):
        if m.get("role") == "user":
            last_user_idx = i
    if last_user_idx >= 0:
        recent = messages[last_user_idx:]
    else:
        recent = messages[-4:]
    msgs.extend({"role": m.get("role", "user"), "content": (m.get("content") or "")[:4000]} for m in recent)

    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    body = {"model": model, "messages": msgs, "stream": False, "temperature": 0.3}
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    content = data["choices"][0]["message"]["content"]
    return _parse_extract_json(content)


def _add_formulas_from_items(items: list, session_id: str, descriptions: dict = None) -> int:
    """将提取出的公式自动写入公式库，返回新增数量；descriptions 为 {latex: 简要描述}"""
    if not items:
        return 0
    descriptions = descriptions or {}
    now = int(time.time() * 1000)
    count = 0
    changed = False

    def updater(data):
        nonlocal count, changed
        for it in items:
            title = it.get("title", "")
            summary = it.get("summary", "")
            tags = it.get("tags", [])
            formula_tags = it.get("formula_tags") or {}
            for f in (it.get("formulas") or []):
                latex = _normalize_formula(str(f).strip())
                # 过滤单字符/纯命令/纯单位（双保险：提取层已过滤，入库层再拦一道）
                if not latex or not _looks_like_formula(latex):
                    continue
                existing = next((v for v in data.values()
                                 if _formula_key(v.get("latex")) == _formula_key(latex)
                                 and v.get("sessionId") == session_id), None)
                if existing:
                    # 快速本地提取可能先写入摘要，后续描述模型返回时只更新说明。
                    description = (descriptions.get(latex) or "").strip() or _local_formula_meaning(latex, summary, title)
                    old_meaning = (existing.get("meaning") or "").strip()
                    if description and old_meaning != description[:200] and (
                        not old_meaning or old_meaning == summary or old_meaning.startswith("该公式")
                    ):
                        existing["meaning"] = description[:200]
                        changed = True
                    continue
                fid = "f_" + uuid.uuid4().hex[:12]
                # 描述模型生成的简要描述优先，否则为单个公式生成具体说明
                meaning = (descriptions.get(latex) or "").strip() or _local_formula_meaning(latex, summary, title)
                data[fid] = {
                    "id": fid,
                    "latex": latex,
                    "concept": title[:80],
                    "meaning": meaning[:200],
                    "topic": "",
                    "related": formula_tags.get(latex) or tags[:8],
                    "sessionId": session_id,
                    "createdAt": now,
                }
                count += 1
        return data if count or changed else None

    _mutate_json(FORMULAS_PATH, updater)
    return count


def _extract_summary(messages: list) -> str:
    """从最近 assistant 消息提取 <summary> 标签内容（主模型输出的一句话摘要）"""
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        m = re.search(r"<summary>([\s\S]*?)</summary>", msg.get("content") or "", re.I)
        if m:
            return m.group(1).strip()[:200]
    return ""


DESCRIBE_PROMPT = """你是公式解说助手。针对下面的每个公式，分别生成一句只解释该公式本身的简短中文描述（不超过30字）。
不要给所有公式复用同一句对话摘要；例如 F=-kx 应写"胡克定律：回复力与位移成正比"。
只输出 JSON，不要输出任何其他内容：
{"descriptions": {"<公式原文>": "描述"}}
要求：
- 公式原文作为键，保持原样
- 描述要具体，例如"胡克定律：弹簧弹力与形变量成正比"
- 每个公式必须单独描述，禁止所有公式共用同一句话
- 无法确定含义的公式，描述用空字符串
- 不要编造摘要中不存在的概念"""


async def _describe_formulas(summary: str, formulas: list, provider: str, api_key: str, model: str, base_url: str) -> dict:
    """调用描述模型为公式生成简要描述，返回 {latex: 描述}；失败返回空 dict"""
    if not formulas or not api_key or not model:
        return {}
    if not base_url:
        base_url = AI_PROVIDERS.get(provider, {}).get("base_url", "")
    if not base_url:
        return {}
    msgs = [
        {"role": "system", "content": DESCRIBE_PROMPT},
        {"role": "user", "content": f"对话摘要：{summary[:300]}\n公式列表：\n" + "\n".join(f"- {f}" for f in formulas)},
    ]
    url = f"{base_url.rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    body = {"model": model, "messages": msgs, "stream": False, "temperature": 0.2}
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, json=body, headers=headers)
            resp.raise_for_status()
            data = resp.json()
        content = data["choices"][0]["message"]["content"]
        m = re.search(r"\{[\s\S]*\}", content)
        if not m:
            return {}
        parsed = json.loads(m.group(0))
        descs = parsed.get("descriptions", {}) if isinstance(parsed, dict) else {}
        result = {}
        for k, v in descs.items():
            if isinstance(v, str) and v.strip():
                result[k.strip()] = v.strip()[:80]
        return result
    except Exception as e:
        logger.warning(f"Describe formulas failed: {e}")
        return {}


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
    # 公式描述模型（前端传入，可选；未配置时回退默认摘要）
    desc_provider = payload.get("descriptor_provider", "")
    desc_api_key = payload.get("descriptor_api_key", "")
    desc_model = payload.get("descriptor_model", "")
    desc_base_url = payload.get("descriptor_base_url", "")

    items = []
    if api_key and model:
        try:
            items = await _ai_extract_knowledge(messages, provider, api_key, model, base_url)
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
    if all_formulas and desc_model and desc_api_key:
        descriptions = await _describe_formulas(summary_text, all_formulas, desc_provider, desc_api_key, desc_model, desc_base_url)
        if descriptions:
            logger.info(f"Generated {len(descriptions)} formula descriptions for session {session_id}")

    added = _add_formulas_from_items(items, session_id, descriptions)
    if added:
        logger.info(f"Auto added {added} formulas to library")

    return {"items": items}


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
