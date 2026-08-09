"""JSON extraction helpers for model responses."""

from __future__ import annotations

import json
import re
from typing import Any, Optional


def _try_parse(text: str):
    try:
        return json.loads(text)
    except (json.JSONDecodeError, ValueError):
        return None



def repair_json(text: str):
    """Try to salvage truncated JSON (common when a model hits max_tokens and
    tool-call arguments get cut off mid-string). Returns parsed value or None."""
    if not isinstance(text, str) or not text.strip():
        return None
    cleaned = text.strip()
    parsed = _try_parse(cleaned)
    if parsed is not None:
        return parsed

    def try_parse_with(prefix: str, suffix: str):
        return _try_parse(prefix + suffix)

    # 1) If it ends with a dangling comma, drop it and close.
    candidate = re.sub(r",\s*$", "", cleaned)
    for suffix in ("}", "]}", "}]}"):
        parsed = try_parse_with(candidate, suffix)
        if parsed is not None:
            return parsed

    # 2) Count braces/brackets/quotes; close what is open.
    depth_brace = 0
    depth_bracket = 0
    in_string = False
    escape = False
    for ch in cleaned:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth_brace += 1
        elif ch == "}":
            depth_brace -= 1
        elif ch == "[":
            depth_bracket += 1
        elif ch == "]":
            depth_bracket -= 1
    if in_string:
        cleaned += '"'
    if depth_bracket > 0:
        cleaned += "]" * depth_bracket
    if depth_brace > 0:
        cleaned += "}" * depth_brace
    parsed = _try_parse(cleaned)
    if parsed is not None:
        return parsed

    # Concatenated objects: model sometimes emits {..}{..} as one arguments
    # string (e.g. two tool calls merged). Take the FIRST complete object.
    depth = 0
    in_string = False
    escape = False
    for i, ch in enumerate(cleaned):
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                parsed = _try_parse(cleaned[: i + 1])
                if parsed is not None:
                    return parsed
    return None


def extract_json(text: str):
    """Extract a JSON object/array from a model response.

    Tolerates markdown fences and prose around the JSON payload. Falls back to
    balanced scanning so truncated tails or trailing commas do not make a valid
    prefix unusable. Top-level arrays (models often emit [ {op...} ] directly)
    are returned as-is.
    """

    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()

    # Fast path: the whole payload is valid JSON.
    parsed = _try_parse(cleaned)
    if parsed is not None:
        return parsed

    start = cleaned.find("{")
    arr_start = cleaned.find("[")

    # Top-level array: models often emit [ {op...}, ... ] directly.
    if arr_start >= 0 and (start < 0 or arr_start < start):
        no_trailing_arr = re.sub(r",\s*([}\]])", r"\1", cleaned)
        parsed = _try_parse(no_trailing_arr)
        if isinstance(parsed, list):
            return parsed

    if start < 0:
        return None

    # Strip trailing commas (models often emit them before } or ]).
    no_trailing = re.sub(r",\s*([}\]])", r"\1", cleaned)
    parsed = _try_parse(no_trailing)
    if parsed is not None:
        return parsed

    # Salvage truncated JSON (model hit max_tokens).
    repaired = repair_json(no_trailing)
    if repaired is not None:
        return repaired

    # Balanced scan: walk from the first { and remember each position where the
    # brace depth returns to zero; try the longest such prefix first.
    depth = 0
    in_string = False
    escape = False
    candidates = []
    for i in range(start, len(no_trailing)):
        ch = no_trailing[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                candidates.append(i)
    for end in reversed(candidates):
        parsed = _try_parse(no_trailing[start : end + 1])
        if parsed is not None:
            return parsed
    return None
