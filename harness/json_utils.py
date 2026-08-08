"""JSON extraction helpers for model responses."""

from __future__ import annotations

import json
import re
from typing import Any, Optional


def extract_json(text: str) -> Optional[Any]:
    """Extract a JSON object from a model response.

    Tolerates markdown fences and prose around the JSON payload.
    """

    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", cleaned)
    if fenced:
        cleaned = fenced.group(1).strip()

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        return json.loads(cleaned[start : end + 1])
    except (json.JSONDecodeError, ValueError):
        return None
