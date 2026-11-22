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


def _balanced_close(text: str, start: int, open_ch: str, close_ch: str) -> int:
    """Index of the ``close_ch`` matching ``text[start]`` (an ``open_ch``).

    Brackets inside JSON strings (including escaped quotes) are ignored.
    Returns -1 when the payload is truncated before the matching close.
    """
    if start < 0 or start >= len(text) or text[start] != open_ch:
        return -1
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
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
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return i
    return -1


# 推理模型（deepseek-v4-flash / hy3 等）常在正文里先输出 <think>…</think>
# 思考块再给正式回答；思考里还可能草拟残缺 JSON，干扰 extract_json 的
# 平衡扫描。成对块整段删除；未闭合（max_tokens 截断）从开标签截到结尾。
_REASONING_BLOCK_RE = re.compile(
    r"<(think|thinking|reasoning|thought)>[\s\S]*?</\1\s*>",
    re.IGNORECASE,
)
_REASONING_OPEN_RE = re.compile(r"<(think|thinking|reasoning|thought)>", re.IGNORECASE)


def strip_reasoning(text: str) -> str:
    """Remove chain-of-thought blocks (<think>…</think> etc.) from a response."""
    if not isinstance(text, str) or not text:
        return text
    cleaned = _REASONING_BLOCK_RE.sub("", text)
    m = _REASONING_OPEN_RE.search(cleaned)
    if m:
        # 未闭合的思考块：开标签之后全是被截断的推理过程，直接丢弃
        cleaned = cleaned[: m.start()]
    return cleaned.strip()



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

    # 2) Walk the real bracket stack and close it in LIFO (last-opened-first)
    # order. Emitting every "]" before every "}" breaks nested truncations:
    # {"ops":[{"op":"x","args":{"k":"v" needs "}}]}" (inner object, outer
    # object, array), not "]}" plus a bare "}".
    stack = []
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
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            expected = "{" if ch == "}" else "["
            if stack and stack[-1] == expected:
                stack.pop()
    base = cleaned
    if in_string:
        base += '"'
    # A dangling comma immediately before the cut cannot take a closer.
    base = re.sub(r",\s*$", "", base)
    base += "".join("}" if ch == "{" else "]" for ch in reversed(stack))
    parsed = _try_parse(base)
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

    围栏回退（2026-11-22）：弱模型常先吐一个**非 JSON** 围栏（思路/示例）再给
    真载荷。修前命中第一个围栏就把整段文本替换成围栏内容，后面的真 JSON 被
    吞掉（解析 None→ops 全丢→重试烧轮次）。围栏链路解析不出时回退原文再走
    一遍既有兜底。
    """

    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()
        parsed = _extract_payload(cleaned)
        if parsed is not None:
            return parsed
        # 围栏内容不是 JSON（思路/示例围栏在前）：回退原文，别把围栏后的真载荷吞掉
        return _extract_payload(text.strip())
    return _extract_payload(cleaned)


def _extract_payload(cleaned: str):
    """主链：在已剥壳的文本上找 JSON（fast path / 数组 / repair / 平衡扫描）。"""

    # Fast path: the whole payload is valid JSON.
    parsed = _try_parse(cleaned)
    if parsed is not None:
        return parsed

    # Fast path: the whole payload is valid JSON.
    parsed = _try_parse(cleaned)
    if parsed is not None:
        return parsed

    start = cleaned.find("{")
    arr_start = cleaned.find("[")

    # Top-level array: models often emit [ {op...}, ... ] directly. A model may
    # append a sentence after the array, so a whole-string parse is not enough:
    # cut out the balanced [...] payload first, then parse/repair that alone.
    if arr_start >= 0 and (start < 0 or arr_start < start):
        arr_end = _balanced_close(cleaned, arr_start, "[", "]")
        if arr_end >= 0:
            payload = cleaned[arr_start : arr_end + 1]
            parsed = _try_parse(payload)
            if not isinstance(parsed, list):
                parsed = _try_parse(re.sub(r",\s*([}\]])", r"\1", payload))
            if isinstance(parsed, list):
                return parsed
            repaired = repair_json(payload)
            if isinstance(repaired, list):
                return repaired
        else:
            # 未配平（截断在数组体内）：保留旧兜底，继续走下方 repair_json。
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
