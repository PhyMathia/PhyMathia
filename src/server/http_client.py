"""Shared HTTP client pool for PhyMathia.

Reusing one ``httpx.AsyncClient`` keeps TCP/TLS connections alive across
model calls (chat proxy, knowledge extraction, formula description, document
parsing and harness review) instead of paying for a new connection per call.

T222 起另收口聊天补全出网样板（post_chat_completion）：knowledge 提取/公式
描述、documents 解析三处复制的 URL/鉴权头/网关头构造与记账集中到这里。
"""

from __future__ import annotations

import asyncio
import threading
import time

import httpx

from . import usage_stats
from .llm_common import opencode_gateway_headers

_client: httpx.AsyncClient | None = None
_lock = threading.Lock()

_DEFAULT_TIMEOUT = httpx.Timeout(60.0, connect=10.0)
_DEFAULT_LIMITS = httpx.Limits(max_connections=30, max_keepalive_connections=10)


def get_http_client() -> httpx.AsyncClient:
    """Return the process-wide AsyncClient, creating it lazily."""
    global _client
    with _lock:
        if _client is None or _client.is_closed:
            _client = httpx.AsyncClient(
                timeout=_DEFAULT_TIMEOUT,
                limits=_DEFAULT_LIMITS,
                # 不跟随重定向：携带 API Key 的请求经 302 可被引向任意主机
                follow_redirects=False,
            )
        return _client


async def close_http_client() -> None:
    """Close the shared client (called from the FastAPI lifespan shutdown)."""
    global _client
    with _lock:
        client = _client
        _client = None
    if client is not None and not client.is_closed:
        await client.aclose()


def shutdown_http_client_sync() -> None:
    """Best-effort synchronous shutdown for non-async contexts."""
    global _client
    with _lock:
        client = _client
        _client = None
    if client is not None and not client.is_closed:
        try:
            asyncio.run(client.aclose())
        except Exception:
            pass


async def post_chat_completion(
    client: httpx.AsyncClient,
    *,
    provider: str,
    model: str,
    base_url: str,
    api_key: str,
    messages: list,
    temperature: float,
    usage_kind: str,
    gateway_bucket: str,
    timeout=httpx.USE_CLIENT_DEFAULT,
) -> dict:
    """聊天补全出网样板（T222 收口三处复制：extract / describe / docs）。

    收口内容：/chat/completions URL 拼接、Bearer 鉴权头（opencode 走网关免
    Bearer）、网关会话头（桶名由调用方给——同功能调用落同一缓存桶，不与对话
    链路互相挤占）、POST + 非 2xx 抛错、失败与 usage 记账。

    client 由调用侧 get_http_client() 取得后传入：tests 的打桩锚在各模块的
    get_http_client 名字上（models-api.md 2026-10-08 拍板），别把获取挪进来。

    超时口径（集中说明，别再散落）：缺省 timeout=USE_CLIENT_DEFAULT 走共享
    client 的 60s（对话级出网）；文档/图片解析传 120.0（大输入慢，documents
    长期口径）。传 None 会禁用超时，勿用。

    失败先记账（record_failure）再原样 raise，调用方的回退/报错行为不变。"""
    url = f"{str(base_url).rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if provider != "opencode":
        headers["Authorization"] = f"Bearer {api_key}"
    headers.update(opencode_gateway_headers(base_url, gateway_bucket))
    body = {"model": model, "messages": messages, "stream": False, "temperature": temperature}
    # 缺省（USE_CLIENT_DEFAULT）时不传 timeout kwarg：与收口前的旧代码逐字节
    # 一致（不传＝走 client 默认），既有测试桩的 post() 也不必收这个参数
    request_kwargs = {} if timeout is httpx.USE_CLIENT_DEFAULT else {"timeout": timeout}
    t0 = time.monotonic()
    try:
        resp = await client.post(url, json=body, headers=headers, **request_kwargs)
        resp.raise_for_status()
        data = resp.json()
    except (httpx.HTTPError, ValueError) as e:
        usage_stats.record_failure(provider, model, usage_kind, "",
                                   usage_stats.failure_detail(e), usage_stats.elapsed_ms(t0))
        raise
    if data.get("usage"):
        usage_stats.record_usage(provider, model, usage_kind, "", data["usage"],
                                 duration_ms=usage_stats.elapsed_ms(t0))
    return data


__all__ = [
    "get_http_client",
    "post_chat_completion",
    "close_http_client",
    "shutdown_http_client_sync",
]
