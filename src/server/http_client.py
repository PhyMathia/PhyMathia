"""Shared HTTP client pool for PhyMathia.

Reusing one ``httpx.AsyncClient`` keeps TCP/TLS connections alive across
model calls (chat proxy, knowledge extraction, formula description, document
parsing and harness review) instead of paying for a new connection per call.
"""

from __future__ import annotations

import asyncio
import threading

import httpx

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


__all__ = [
    "get_http_client",
    "close_http_client",
    "shutdown_http_client_sync",
]
