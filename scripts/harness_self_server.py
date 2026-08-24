"""Self-model harness test server.

Runs the harness pipeline with ox-alpha (the coding agent) acting as the
model under test. Instead of calling a remote LLM, every _call_model request
is written to .tmp/harness-self/inbox/<id>.json; the agent reads the prompt,
writes its answer to .tmp/harness-self/outbox/<id>.resp.json, and the
pipeline continues (validation, semantics, scoring all run for real).

Run:  python3 scripts/harness_self_server.py -p 5052
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import uvicorn
from fastapi import FastAPI, Request

import harness.review as harness_review
from harness.api import router as harness_router

BRIDGE_DIR = Path(ROOT) / ".tmp" / "harness-self"
INBOX = BRIDGE_DIR / "inbox"
OUTBOX = BRIDGE_DIR / "outbox"
TIMEOUT_S = float(os.environ.get("HARNESS_SELF_TIMEOUT", "900"))

_SEQ = [0]


async def _self_call_model(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
    INBOX.mkdir(parents=True, exist_ok=True)
    OUTBOX.mkdir(parents=True, exist_ok=True)
    _SEQ[0] += 1
    rid = f"req-{_SEQ[0]:04d}-{int(time.time())}"
    req_path = INBOX / f"{rid}.json"
    resp_path = OUTBOX / f"{rid}.resp.json"
    req_path.write_text(
        json.dumps(
            {
                "id": rid,
                "purpose": "selfcheck" if any(
                    isinstance(t, dict) and t.get("type") == "function"
                    and t.get("function", {}).get("name") == "submit_selfcheck"
                    for t in (tools or [])
                ) else "main",
                "messages": messages,
                "tools": tools or [],
                "tool_choice": tool_choice,
                "json_mode": bool(json_mode),
                "max_tokens": max_tokens,
            },
            ensure_ascii=False,
            indent=1,
        ),
        encoding="utf-8",
    )
    deadline = time.monotonic() + TIMEOUT_S
    while time.monotonic() < deadline:
        if resp_path.exists():
            try:
                data = json.loads(resp_path.read_text(encoding="utf-8"))
            except Exception:
                await asyncio.sleep(0.3)
                continue
            content = data.get("content")
            if content is None and isinstance(data.get("choices"), list):
                msg = (data["choices"][0] or {}).get("message") or {}
                content = msg.get("content")
            if content is None and isinstance(data, dict):
                # 兼容裸模型输出：无 content/choices 包装时，整个对象就是模型应答
                # （如 {"operations":[...],"summary":..} 或 selfcheck {"ok":true,...}）
                content = json.dumps(data, ensure_ascii=False)
            content = str(content if content is not None else "").strip()
            # 留痕：把请求+响应存档到 journal/，再删除响应文件避免下一轮误读
            journal = BRIDGE_DIR / "journal"
            journal.mkdir(parents=True, exist_ok=True)
            (journal / f"{rid}.exchange.json").write_text(
                json.dumps(
                    {"request": req_path.read_text(encoding="utf-8"), "response_content": content},
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            resp_path.unlink(missing_ok=True)
            return {"content": content, "tool_calls": data.get("tool_calls") or []}
        await asyncio.sleep(0.3)
    raise RuntimeError(f"self-model bridge timeout after {TIMEOUT_S}s waiting for {resp_path.name}")


harness_review._call_model = _self_call_model

app = FastAPI(title="Harness Self-Model Test Server")
app.state.harness_context = ""
app.include_router(harness_router, prefix="/api/harness")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "harness-self", "requests_served": _SEQ[0]}


@app.on_event("startup")
async def _reset_bridge():
    for d in (INBOX, OUTBOX):
        d.mkdir(parents=True, exist_ok=True)
        for old in d.glob("*"):
            old.unlink()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", "--port", type=int, default=5052)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
