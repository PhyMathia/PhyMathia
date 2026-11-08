#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""改图金样集专用 mock 上游（Python stdlib 版，不依赖 Node 网络栈）。

与通用 scripts/mock_upstream.mjs 的区别：按「金样指令」精确回放正确工具调用，
保证 --mock 模式下 30 条金样能跑出稳定的满分基线；GOLD_DEGRADE_EVERY=N 时
按用例序号注入坏答案，用来端到端验证「尺子有灵敏度」（对应 --selftest 的纯本地 A/B）。

为什么不是 .mjs（2026-11-08 实踩）：本机 Node 22 只要 http.createServer + listen
就会初始化 undici 的 lazyllhttp WASM 并抛 RangeError: Out of memory，连最简的
`node -e "import http from 'node:http'; http.createServer(...).listen(...)"` 都崩；
覆盖 globalThis.fetch / 清 NODE_OPTIONS / 换系统 Node 均无效。Python 的
ThreadingHTTPServer 与后端 httpx 客户端都正常，故 mock 上游改由 Python 承载。

端口默认 5091（避开 5065 通用 mock、5060/5061 undici 坏端口与各真机脚本常量口）。
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

PORT = int(os.environ.get("PORT", "5091"))
DEGRADE_EVERY = int(os.environ.get("GOLD_DEGRADE_EVERY", "0"))

CASES = []
SEQ = 0
STATS = {"chat_requests": 0, "matched": 0, "unmatched": 0, "degraded": 0, "selfcheck": 0}


def next_seq():
    global SEQ
    SEQ += 1
    return SEQ


def tool_call(name, args):
    return {
        "id": "gold-call-%d-%d" % (int(time.time() * 1000), next_seq()),
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


def judge(body):
    msgs = body.get("messages") if isinstance(body.get("messages"), list) else []
    last_user = ""
    for m in reversed(msgs):
        if isinstance(m, dict) and m.get("role") == "user":
            last_user = str(m.get("content") or "")
            break
    tools = []
    for t in (body.get("tools") if isinstance(body.get("tools"), list) else []):
        if isinstance(t, dict):
            fn = t.get("function")
            if isinstance(fn, dict) and fn.get("name"):
                tools.append(fn["name"])
    all_text = "\n".join(
        str(m.get("content") or "") for m in msgs if isinstance(m, dict)
    )
    return {"user_text": last_user, "all_text": all_text, "tools": tools}


# 指令可能互为前缀（改同一节点的不同说法），取「被包含且最长」的那条。
def match_case(user_text):
    best_idx, best = -1, None
    for i, c in enumerate(CASES):
        ins = c.get("instruction") or ""
        if ins and ins in user_text:
            if best is None or len(ins) > len(best.get("instruction") or ""):
                best_idx, best = i, c
    return best_idx, best


def reply(body):
    j = judge(body)

    # 质检/判官请求：一致放行，金样集测的是「主模型出方案→结果图」，不是质检器。
    if "submit_selfcheck" in j["tools"]:
        STATS["selfcheck"] += 1
        return {
            "content": "",
            "tool_calls": [tool_call("submit_selfcheck", {"ok": True, "issues": [], "missing": []})],
        }

    idx, c = match_case(j["user_text"])
    if c is None:
        STATS["unmatched"] += 1
        return {"content": '{"summary":"mock 未匹配到金样指令","operations":[]}'}
    STATS["matched"] += 1

    if DEGRADE_EVERY > 0 and (idx + 1) % DEGRADE_EVERY == 0:
        STATS["degraded"] += 1
        return {"content": '{"summary":"（降级样本）没理解指令","operations":[]}'}

    ops = c.get("mock_ops") if isinstance(c.get("mock_ops"), list) else []
    if not ops:
        # JSON 通道的空操作回包（后端 tool_calls 为空时会走 JSON 兜底解析）。
        return {"content": '{"summary":"已按要求处理，无需改图。","operations":[]}'}
    return {
        "content": "好的，按你的要求改图。",
        "tool_calls": [tool_call(o["name"], o.get("args", {})) for o in ops],
    }


def sse_chunk(delta):
    payload = {"id": "gold-%d" % next_seq(), "choices": [{"delta": delta}]}
    return "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    # 每请求即关连接：降级轮会触发后端重试，keep-alive 会让
    # ThreadingHTTPServer 累积常驻线程（实测跑满 30 条时最后一条被拖到 90s
    # 超时）。本地 mock 新建连接的开销可忽略，换来线程数不随轮次增长。
    def _send(self, code, obj):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.send_header("connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(raw)

    def _send_text(self, code, ctype, raw):
        self.send_response(code)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(raw)))
        self.send_header("cache-control", "no-cache")
        self.send_header("connection", "close")
        self.close_connection = True
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            return json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            return {}

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/health", "/"):
            return self._send(200, {"status": "ok", "mock": "graph-gold", "cases": len(CASES), "stats": STATS})
        if path == "/v1/models":
            return self._send(200, {"object": "list", "data": [{"id": "gold-1", "object": "model"}]})
        if path == "/__stats":
            return self._send(200, dict(mock="graph-gold", **STATS))
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        global CASES
        path = urlparse(self.path).path
        body = self._read_json()

        if path == "/__cases":
            CASES = body if isinstance(body, list) else []
            return self._send(200, {"ok": True, "cases": len(CASES)})

        if path in ("/v1/chat/completions", "/chat/completions"):
            STATS["chat_requests"] += 1
            msg = reply(body)
            if body.get("stream"):
                frames = []
                if msg.get("content"):
                    frames.append(sse_chunk({"content": msg["content"]}))
                for i, tc in enumerate(msg.get("tool_calls", [])):
                    frames.append(sse_chunk({"tool_calls": [{
                        "index": i, "id": tc["id"], "type": "function",
                        "function": {"name": tc["function"]["name"], "arguments": ""},
                    }]}))
                    frames.append(sse_chunk({"tool_calls": [{
                        "index": i, "function": {"arguments": tc["function"]["arguments"]},
                    }]}))
                frames.append("data: " + json.dumps({
                    "choices": [], "usage": {"prompt_tokens": 100, "completion_tokens": 20},
                }) + "\n\n")
                payload = ("".join(frames) + "data: [DONE]\n\n").encode("utf-8")
                return self._send_text(200, "text/event-stream", payload)

            choices = [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": msg.get("content") or "",
                    "tool_calls": msg.get("tool_calls", []),
                },
                "finish_reason": "tool_calls" if msg.get("tool_calls") else "stop",
            }]
            return self._send(200, {
                "id": "gold-%d-%d" % (int(time.time() * 1000), next_seq()),
                "object": "chat.completion",
                "choices": choices,
            })

        return self._send(404, {"error": "not found"})


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    print("[graph-gold mock] http://127.0.0.1:%d/v1  cases=%d degrade=%d"
          % (PORT, len(CASES), DEGRADE_EVERY), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
