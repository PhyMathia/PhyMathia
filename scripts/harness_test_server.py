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
from fastapi import FastAPI, Request

from harness.api import router as harness_router
import asyncio
import json
import os
from pathlib import Path

import harness.review as harness_review

_RAW_LOG = Path(os.environ.get("HARNESS_RAW_LOG", str(Path(__file__).resolve().parent.parent / ".tools" / "harness-raw.log")))


_ORIG_CALL_MODEL = harness_review._call_model


async def _logged_call_model(messages, model, max_tokens, tools=None, tool_choice=None, json_mode=False, on_delta=None):
    result = await _ORIG_CALL_MODEL(
        messages, model, max_tokens, tools=tools, tool_choice=tool_choice, json_mode=json_mode, on_delta=on_delta
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
import base64
import logging
from pathlib import Path as _Path

from src.server.config import OPENCODE_DEFAULT_API_KEY
from src.server.documents import (
    _sanitize_filename, _extract_document_text, _ai_extract_document_knowledge, _local_extract_document_knowledge,
)
from src.server.knowledge import (
    _ai_extract_knowledge, _local_extract_knowledge, _extract_summary, _describe_formulas, _is_socratic_followup,
)

logger = logging.getLogger("knowledge-test")

app.state.harness_context = ""
app.include_router(harness_router, prefix="/api/harness")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "harness-test"}



@app.post("/api/extract_knowledge")
async def extract_knowledge(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return {"items": [], "descriptions": {}, "error": "bad json"}
    messages = payload.get("messages") or []
    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    level = str(payload.get("level") or "university")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY
    latest = next((m for m in reversed(messages) if m.get("role") == "assistant"), None)
    if latest and (_is_socratic_followup(latest.get("content") or "") or latest.get("branchType") in ("followup", "confused", "socratic")):
        return {"items": [], "descriptions": {}}
    items = []
    if (api_key or provider == "opencode") and model:
        try:
            items = await _ai_extract_knowledge(messages, provider, api_key, model, base_url, level)
        except Exception as exc:
            logger.warning("AI extract failed: %s", exc)
    if not items:
        items = _local_extract_knowledge(messages)
    summary_text = _extract_summary(messages)
    if summary_text:
        for it in items:
            it["summary"] = summary_text[:200]
    desc_provider = str(payload.get("descriptor_provider") or "")
    desc_api_key = str(payload.get("descriptor_api_key") or "")
    desc_model = str(payload.get("descriptor_model") or "")
    desc_base_url = str(payload.get("descriptor_base_url") or "")
    if not desc_api_key and desc_provider == "opencode":
        desc_api_key = OPENCODE_DEFAULT_API_KEY
    descriptions = {}
    all_formulas = []
    for it in items:
        for f in (it.get("formulas") or []):
            latex = str(f).strip()
            if latex and latex not in all_formulas:
                all_formulas.append(latex)
    if all_formulas and desc_model and (desc_api_key or desc_provider == "opencode"):
        try:
            descriptions = await _describe_formulas(summary_text, all_formulas, desc_provider, desc_api_key, desc_model, desc_base_url, level)
        except Exception as exc:
            logger.warning("describe failed: %s", exc)
    return {"items": items, "descriptions": descriptions}


@app.post("/api/documents/parse")
async def parse_document(request: Request):
    try:
        payload = await request.json()
    except Exception:
        return {"ok": False, "error": "bad json"}
    filename = _sanitize_filename(payload.get("fileName") or "upload.txt")
    try:
        max_items = min(max(int(payload.get("maxItems") or 5), 1), 50)
    except (TypeError, ValueError):
        max_items = 5
    try:
        content = base64.b64decode(str(payload.get("contentBase64") or ""))
    except Exception:
        return {"ok": False, "error": "bad base64"}
    if not content:
        return {"ok": False, "error": "empty content"}
    text = _extract_document_text(filename, content)
    ext = _Path(filename).suffix.lower()
    is_image = ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}
    image_b64 = base64.b64encode(content).decode("ascii") if is_image else ""
    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    level = str(payload.get("level") or "university")
    if not api_key and provider == "opencode":
        api_key = OPENCODE_DEFAULT_API_KEY
    nodes, edges, relations = [], [], []
    if model and (api_key or provider == "opencode"):
        try:
            nodes, edges, relations = await _ai_extract_document_knowledge(text, filename, is_image, image_b64, provider, api_key, model, base_url, level, max_items)
        except Exception as exc:
            logger.warning("AI doc extract failed: %s", exc)
    if not nodes:
        nodes, edges, relations = _local_extract_document_knowledge(text, filename, max_items)
    return {
        "ok": True,
        "fileName": filename,
        "maxItems": max_items,
        "textLength": len(text),
        "nodes": nodes,
        "edges": edges,
        "relations": relations,
        "extractedTextPreview": text[:500],
    }

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("-p", "--port", type=int, default=5052)
    args = parser.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
