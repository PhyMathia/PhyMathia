"""Model critic for the graph harness.

After operations are generated and validated, a lightweight model call checks
whether the operations actually satisfy the user instruction (wrong target,
missed action, redundant change). This is a critic pass, not a second editor:
it only reports issues so the main flow can retry once with feedback.
"""

from __future__ import annotations

import json
from typing import Any, Dict

from .json_utils import extract_json

SELFCHECK_SYSTEM_PROMPT = """你是图修改结果质检员。下面给出用户指令、图快照（精简）和已经生成的操作。
检查这些操作是否准确、完整地执行了用户指令：有没有选错节点、漏做关键动作、做了多余或冲突的修改。

如果环境提供了 submit_selfcheck 工具，必须调用它提交结论（ok/issues/missing），不要在文本里重复输出 JSON。
如果环境没有提供该工具，则只输出 JSON：
{"ok": true或false, "issues": ["具体问题1", "具体问题2"], "missing": ["指令要求但没做的动作1"]}

规则：
- ok 为 false 时必须给出 issues 或 missing。
- 不要检查格式是否正确，只检查语义是否符合指令。
- 没有问题时 ok 为 true，issues 和 missing 都为空数组。
- 指令本身模糊时不要强行挑错，ok 为 true。
"""



SELFCHECK_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_selfcheck",
        "description": "提交质检结论：操作是否准确、完整地执行了用户指令",
        "parameters": {
            "type": "object",
            "properties": {
                "ok": {"type": "boolean", "description": "true=操作符合指令；false=存在遗漏或错误"},
                "issues": {"type": "array", "items": {"type": "string"}, "description": "发现的具体问题，如选错节点、多余修改"},
                "missing": {"type": "array", "items": {"type": "string"}, "description": "指令要求但没做的动作"},
            },
            "required": ["ok", "issues", "missing"],
        },
    },
}


def parse_selfcheck_tool(tool_calls):
    """Parse a submit_selfcheck tool call; None when not usable."""
    for call in tool_calls or []:
        if not isinstance(call, dict):
            continue
        fn = call.get("function")
        if not isinstance(fn, dict) or fn.get("name") != "submit_selfcheck":
            continue
        try:
            args = json.loads(str(fn.get("arguments") or "{}"))
        except (json.JSONDecodeError, ValueError):
            return None
        if not isinstance(args, dict):
            return None
        issues = [str(item) for item in (args.get("issues") or []) if str(item)]
        missing = [str(item) for item in (args.get("missing") or []) if str(item)]
        ok = bool(args.get("ok")) and not issues and not missing
        return {"ok": ok, "issues": issues, "missing": missing}
    return None


def build_selfcheck_messages(instruction: str, snapshot: dict, ops: list) -> list:
    compact = {
        "nodes": [
            {"id": node.get("id"), "kind": node.get("kind"), "label": node.get("label")}
            for node in snapshot.get("nodes", [])
        ],
        "edges": [
            {"key": edge.get("key"), "from": edge.get("from"), "to": edge.get("to")}
            for edge in snapshot.get("edges", [])
        ],
    }
    user_text = (
        f"用户指令：{instruction}\n\n图快照（精简）：\n{json.dumps(compact, ensure_ascii=False, indent=2)}"
        f"\n\n已生成操作：\n{json.dumps(ops, ensure_ascii=False, indent=2)}\n\n只输出质检 JSON。"
    )
    return [
        {"role": "system", "content": SELFCHECK_SYSTEM_PROMPT},
        {"role": "user", "content": user_text},
    ]


def parse_selfcheck(text: str) -> Dict[str, Any]:
    """Parse the critic JSON; never blocks the flow on bad output."""
    payload = extract_json(text)
    if not isinstance(payload, dict):
        return {"ok": True, "issues": [], "missing": [], "parse_error": True}
    issues = [str(item) for item in (payload.get("issues") or []) if str(item)]
    missing = [str(item) for item in (payload.get("missing") or []) if str(item)]
    ok = bool(payload.get("ok")) and not issues and not missing
    return {"ok": ok, "issues": issues, "missing": missing}
