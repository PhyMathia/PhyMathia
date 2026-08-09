"""Minimal harness test server.

Mounted only the harness router so we can iterate on harness/*.py without
restarting the user-facing PhyMathia server. Run with:

    D:\\PhyMathia\\.tools\\python312\\python.exe scripts/harness_test_server.py [port]

"""
from __future__ import annotations

import argparse
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

import uvicorn
from fastapi import FastAPI

from harness.api import router as harness_router
import asyncio
import json
import os
from pathlib import Path

import harness.review as harness_review

_RAW_LOG = Path(os.environ.get("HARNESS_RAW_LOG", str(Path(__file__).resolve().parent.parent / ".tools" / "harness-raw.log")))


_ORIG_CALL_MODEL = harness_review._call_model


async def _logged_call_model(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False):
    result = await _ORIG_CALL_MODEL(
        messages, model, max_tokens, tools=tools, tool_choice=tool_choice, json_mode=json_mode
    )
    try:
        with _RAW_LOG.open("a", encoding="utf-8") as fh:
            fh.write(
                "\n===== " + time.strftime("%Y-%m-%d %H:%M:%S") + " =====\n"
                + "MODEL " + str(model.get("provider")) + "/" + str(model.get("model")) + "\n"
                + "CONTENT:\n" + str(result.get("content") or "")[:6000] + "\n"
                + "TOOL_CALLS:\n" + json.dumps(result.get("tool_calls") or [], ensure_ascii=False)[:4000] + "\n"
            )
    except Exception:
        pass
    return result

harness_review._call_model = _logged_call_model


app = FastAPI(title="Harness Test Server")
import time

app.state.harness_context = ""
app.include_router(harness_router, prefix="/api/harness")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "harness-test"}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", "--port", type=int, default=5052)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
