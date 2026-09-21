"""Model-backed review flow for the independent harness.

Supports two operation submission modes:
- tools (function calling): preferred, more stable; the model emits tool_calls
  which are converted into the internal operation contract;
- json (free-form JSON): fallback for providers without function-calling
  support, or when tools requests fail.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Dict, Optional

import httpx

from http_client import get_http_client
from llm_common import (
    PROVIDER_BASE_URLS,
    estimate_tokens,
    opencode_gateway_headers,
    resolve_api_key,
)
import usage_stats  # 项目根共享层：token 用量与缓存命中计量落盘

# harness 无会话上下文，按进程派生稳定 id——同进程内的重试与自检落在同一缓存桶，
# 也是计量记录里 harness 调用的会话桶标识
_HARNESS_SESSION_ID = "phymathia-harness-" + str(os.getpid())

from .core import (
    MAX_SNAPSHOT_CHARS,
    MAX_SNAPSHOT_HARD_CHARS,
    NON_FOCUS_CONTENT_CHARS,
    build_inverse_ops,
    build_next_snapshot,
    diff_snapshots,
    normalize_snapshot,
)
from .selfcheck import (
    SELFCHECK_TOOL,
    build_selfcheck_messages,
    parse_selfcheck,
    parse_selfcheck_tool,
)
from .semantics import find_isolated_created_nodes, find_missing_expansion_chains, rule_selfcheck
from .json_utils import extract_json, strip_reasoning
from .prompts import (
    build_apply_messages,
    build_evaluate_messages,
    build_expand_messages,
    build_resolve_messages,
    build_review_messages,
)
from .tools import build_tools, parse_tool_calls

logger = logging.getLogger("harness.review")

EVALUATE_HINTS = (
    "评价", "建议", "反馈", "点评", "指出", "哪里需要改进",
    "挑错", "有问题吗", "对不对", "哪里不对", "帮我看看",
)
APPLY_HINTS = ("应用建议", "采纳建议", "按建议", "执行建议", "应用评价", "按评价")
MODIFY_HINTS = (
    "修改", "改成", "更正", "纠正", "重写", "更新", "删掉", "删除",
    "补充", "新增", "创建", "连接", "加上", "加一个", "补一个", "改进", "完善",
)
EXPAND_HINTS = ("拓展", "进阶", "延伸学习", "深入学习", "深化")

TOOLS_USER_HINT = (
    "\n\n（本次请求支持工具调用：请优先使用提供的工具提交 operations，"
    "不要在文本里重复输出 JSON；文本内容只写一句话 summary。若工具不可用，再按上面的 JSON 结构输出。）"
)
TOOLS_AUTO_HINT = (
    "\n\n（本次支持两种回答方式：如果用户只是提问/讨论，请直接用文字回答，不需要调用工具；"
    "如果用户要求修改图，请使用工具提交 operations，文本只写一句话 summary。）"
)

# 流式进度事件里的阶段中文名（发给前端状态条）
_PHASE_LABELS = {
    "normal": "审阅整理",
    "evaluate": "生成评价",
    "apply": "应用建议",
    "expand": "拓展进阶",
    "undo": "撤销回滚",
}



UNDO_HINTS = (
    "撤销", "回退", "恢复", "还原", "撤回", "不要刚才", "重来",
    "改回去", "改回", "退回", "退回去", "撤掉", "撤了", "不要了",
    "刚加的", "删掉刚才", "undo", "rollback",
)


def _detect_undo_intent(instruction: str) -> bool:
    text = str(instruction or "")
    return any(hint in text.lower() for hint in UNDO_HINTS)


def _filter_inverse_by_targets(inverse_ops: list, targets, snapshot=None) -> list:
    targets = {str(item) for item in (targets or []) if str(item)}
    if not targets:
        return inverse_ops
    edge_ends = {}
    if snapshot is not None:
        try:
            norm = normalize_snapshot(snapshot)
            for e in norm["edges"]:
                key = str(e.get("key") or "")
                if key:
                    edge_ends[key] = {str(e.get("from") or ""), str(e.get("to") or "")}
        except Exception:
            edge_ends = {}
    kept = []
    for op in inverse_ops:
        ids = [op.get("id"), op.get("from"), op.get("to"), op.get("temp_id"), op.get("force_id")]
        if any(str(item) in targets for item in ids if item):
            kept.append(op)
            continue
        ek = str(op.get("edge_key") or op.get("key") or "")
        ends = edge_ends.get(ek)
        if ends and ends & targets:
            kept.append(op)
    if kept:
        # 恢复对成对判定：保住 add_edge(T->D) 时，它端点 D 的 restore_node 也
        # 必须一起保——只留边不留节点，build_next_snapshot 会报「终点不存在」，
        # 这条边从此撤不回来（09-20 修复）
        kept_ends = set()
        for op in kept:
            if str(op.get("op") or "") == "add_edge":
                for end in (op.get("from"), op.get("to")):
                    if end:
                        kept_ends.add(str(end))
        if kept_ends:
            for op in inverse_ops:
                if str(op.get("op") or "") == "restore_node" \
                        and str(op.get("id") or "") in kept_ends and op not in kept:
                    kept.append(op)
    return kept


def _undo_scope(instruction: str, focus_node_ids) -> str:
    """Decide how much history an undo request should revert.

    - 'full': 撤销全部/所有修改（回到最初快照）
    - 'targeted': 指定了目标节点，且表达“恢复原样/改回去/撤掉”等上下文反悔
      —— 撤销该目标相关的全部历史改动，保留其它改动
    - 'last': 只撤销上一步修改
    """
    text = str(instruction or "")
    if "全部" in text or "所有" in text:
        return "full"
    if focus_node_ids and any(k in text for k in (
        "恢复", "还原", "原样", "改回", "退回", "撤掉", "撤了", "不要了", "刚加的", "那边",
    )):
        return "targeted"
    return "last"


def _history_block(history) -> str:
    """多轮编辑历史：最近 6 条详细（含操作摘要），更早条目压缩为一行，控制上下文体积。"""
    if not history:
        return ""
    lines = ["\n\n此前多轮编辑历史（最新在后）："]
    recent_start = max(0, len(history) - 6)
    for i, item in enumerate(history):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        if role == "user":
            text = str(item.get("instruction") or "")
            if i < recent_start:
                lines.append(f"{i + 1}. 用户：{text[:100]}")
            else:
                lines.append(f"{i + 1}. 用户：{text[:200]}")
        else:
            summary = str(item.get("summary") or "")
            if i < recent_start:
                lines.append(f"{i + 1}. 助手：{summary[:80]}")
            else:
                ops = item.get("operations") or []
                op_desc = "；".join(
                    f"{o.get('op')}({o.get('id') or o.get('temp_id') or o.get('label') or ''})"
                    for o in ops[:20]
                )
                lines.append(f"{i + 1}. 助手：{summary[:120]}" + (f"；操作：{op_desc[:300]}" if op_desc else ""))
    return "\n".join(lines)


def _clamp_display_summary(text, limit: int = 800) -> str:
    """纯文字兜底 summary 的展示截断：推理模型的长篇思考即使剥离后仍可能
    留下超长正文，面板只展示前 limit 字，避免“输出一大堆”刷屏。"""
    t = str(text or "").strip()
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "……（模型输出过长，已截断显示）"


def _extract_summary_from_json_shell(text):
    """模型偶尔把整个 JSON 对象写进正文，且字符串内含未转义引号导致解析失败。
    此时按"纯文字回答"兜底时，剥掉 JSON 外壳只保留 summary 文本，避免用户看到原始 JSON。"""
    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    if not cleaned.startswith("{") or '"summary"' not in cleaned:
        return None
    marker = '"operations"'
    prefix = cleaned[: cleaned.index(marker)] if marker in cleaned else cleaned
    m = re.search(r'"summary"\s*:\s*"', prefix)
    if not m:
        return None
    start = m.end()
    # 闭引号定位：正文含未转义引号是常态，靠「第一个引号」会截半句；summary
    # 与 operations 之间夹其他键（如 clarify/options）时，嵌套值的闭引号后面
    # 同样是「, "下一个键":」——光看尾巴形状分不出来。两轮择优（都从最后
    # 一个候选往回）：① 剩余是纯标点且提取值不含 JSON 结构痕迹（引号键、{、[）；
    # ② 剩余紧跟下一个键且提取值干净。两种形态都取到完整 summary（09-20 修复）
    candidates = []
    esc = False
    for i in range(start, len(prefix)):
        ch = prefix[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            candidates.append(i)
    if not candidates:
        return None

    def _clean_value(pos):
        value = prefix[start:pos]
        return not re.search(r'[\[{]|"\s*:', value)

    end = candidates[-1]
    for pos in reversed(candidates):
        if re.match(r'^[\s,}\]]*$', prefix[pos + 1:]) and _clean_value(pos):
            end = pos
            break
    if end == candidates[-1] or not _clean_value(end):
        for pos in reversed(candidates):
            if re.match(r'^\s*,\s*"[^"\n]*"\s*:', prefix[pos + 1:]) and _clean_value(pos):
                end = pos
                break
    if end <= start:
        return None
    value = prefix[start:end].strip()
    if not value:
        return None
    return value.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")


class HarnessError(RuntimeError):
    pass


def _supports_required_tool_choice(provider: str) -> bool:
    """Providers that accept tool_choice="required" (some free/open proxies do not)."""
    return str(provider or "").strip().lower() in ("deepseek", "openai")


def _supports_json_mode(provider: str) -> bool:
    """Providers that accept response_format={"type":"json_object"}."""
    return str(provider or "").strip().lower() in ("deepseek", "openai")



def _has_edit_intent(text: str) -> bool:
    """True when the instruction contains explicit graph-edit verbs."""
    return any(hint in str(text or "") for hint in MODIFY_HINTS)


# 模型用文字解释"为什么不做操作"时的特征词：目标不存在/已满足/受保护/无内容等。
# 此时再强制重试只是浪费一次模型调用（线上即数十秒延迟），应直接接受空操作结果。
_REFUSAL_MARKERS = (
    "不存在", "没有找到", "未找到", "找不到", "没有名为", "无此节点", "查无",
    "只读", "无法删除", "无法修改", "不能删除", "不能修改", "受保护", "不适合", "不宜",
    "已存在", "已经存在", "已有连线", "无需重复", "重复添加", "已经是",
    "空的", "空图", "没有节点", "暂无节点", "没有可评价", "无可评价", "无从评价", "没有内容",
)


def _refusal_explained(summary: str) -> bool:
    """模型是否在 summary 里给出了不做操作的具体原因。

    空操作 + 解释 = 合法拒绝（目标不存在 / 操作已满足 / 节点只读 / 图为空），
    强制重试只会逼模型编造操作；空操作 + 无解释才视为偷懒，需要重试。"""
    text = str(summary or "").strip()
    if len(text) < 8:
        return False
    return any(marker in text for marker in _REFUSAL_MARKERS)


def _detect_phase(phase: str, instruction: str, snapshot: dict, focus_node_ids=None) -> str:
    """Choose the intended harness phase from explicit phase or instruction hints."""
    text = str(instruction or "")
    has_eval = any(hint in text for hint in EVALUATE_HINTS)
    has_modify = any(hint in text for hint in MODIFY_HINTS)
    has_expand = any(hint in text for hint in EXPAND_HINTS)
    has_apply = any(hint in text for hint in APPLY_HINTS)
    focus_ids = [str(item) for item in (focus_node_ids or []) if str(item)]
    has_eval_nodes = any(node.get("kind") == "ai_eval" for node in snapshot.get("nodes", []))
    auto_phases = ("", "auto", "normal", "expand")
    if phase == "apply" or (phase in auto_phases and has_apply and has_eval_nodes):
        return "apply"
    if phase in auto_phases and has_expand and focus_ids:
        return "expand"
    if phase == "evaluate" or (phase in auto_phases and has_eval):
        return "evaluate"
    if phase in auto_phases and has_modify and not has_eval:
        return "normal"
    return "normal"


def _resolve_model(model: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    model = model or {}
    provider = str(model.get("provider") or "deepseek").strip()
    model_name = str(model.get("model") or model.get("model_name") or "deepseek-chat").strip()
    base_url = str(model.get("base_url") or model.get("baseUrl") or "").strip()
    api_key = str(model.get("api_key") or model.get("apiKey") or "").strip()
    # 服务端密钥回退（唯一实现在 llm_common.resolve_api_key）：宽口径识别
    # opencode-go（hy3/hy3-preview 必须带 Bearer，否则上游返回 401 "Invalid
    # API key"），别家 env 都没配时末位回退 DEEPSEEK_API_KEY；免费 opencode
    # （zen/v1）不需要 key。前端可留空密钥，靠这里的环境变量兜底。
    api_key, _ = resolve_api_key(provider, api_key, base_url, wide_go=True, deepseek_last_resort=True)
    if not base_url:
        base_url = PROVIDER_BASE_URLS.get(provider, "")
    if not model_name:
        raise HarnessError("模型名称不能为空")
    if not base_url:
        raise HarnessError("模型 API 地址不能为空")
    return {
        "provider": provider,
        "model": model_name,
        "base_url": base_url,
        "api_key": api_key,
    }


async def _stream_chat_completions(client, url: str, headers: dict, body: dict, on_delta):
    """流式拉取 chat/completions：正文增量实时回调 on_delta，返回
    (与非流式同构的 message dict, 上游 usage 或 None)。

    兼容三类上游行为：
    - 标准 SSE（data: {...} / data: [DONE]）；
    - 忽略 stream 参数直接回整段 JSON（按非流式一次性解析，不视为错误）；
    - tool_calls 分片到达（按 index 重组 arguments）。
    """
    content_parts: list = []
    reasoning_parts: list = []
    tool_acc: Dict[int, Dict[str, Any]] = {}
    last_usage = None
    async with client.stream("POST", url, json=body, headers=headers, timeout=90.0) as resp:
        if resp.status_code != 200:
            detail = (await resp.aread()).decode("utf-8", "ignore")[:500]
            raise HarnessError(f"模型返回 {resp.status_code}: {detail}")
        if "text/event-stream" not in str(resp.headers.get("content-type") or ""):
            try:
                data = json.loads((await resp.aread()).decode("utf-8", "ignore"))
                message = data["choices"][0].get("message") or {}
            except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
                raise HarnessError("模型响应缺少有效内容") from exc
            return message, (data.get("usage") if isinstance(data, dict) else None)
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            payload_text = line[5:].strip()
            if payload_text == "[DONE]":
                break
            try:
                chunk = json.loads(payload_text)
            except json.JSONDecodeError:
                continue
            if isinstance(chunk, dict) and chunk.get("usage"):
                # include_usage 的计量帧 choices 为空，会在下方被跳过，先接住
                last_usage = chunk["usage"]
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                content_parts.append(str(text))
                if on_delta is not None:
                    try:
                        on_delta(str(text))
                    except Exception:
                        pass
            reasoning = delta.get("reasoning_content")
            if reasoning:
                # 推理模型的思维链只单独攒（回退用），绝不混进正文增量
                reasoning_parts.append(str(reasoning))
            for frag in delta.get("tool_calls") or []:
                try:
                    idx = int(frag.get("index") or 0)
                except (TypeError, ValueError):
                    idx = 0
                slot = tool_acc.setdefault(
                    idx, {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                )
                if frag.get("id"):
                    slot["id"] = str(frag["id"])
                fn = frag.get("function") or {}
                if fn.get("name") and not slot["function"]["name"]:
                    slot["function"]["name"] = str(fn["name"])
                if fn.get("arguments"):
                    # 流式增量通常是 JSON 片段字符串，个别网关直接给对象——
                    # str(dict) 拼出单引号 repr，后续 repair_json 也救不回，
                    # 整批 ops 会被丢弃重试（09-20 修复）
                    chunk = fn["arguments"]
                    if isinstance(chunk, dict):
                        chunk = json.dumps(chunk, ensure_ascii=False)
                    slot["function"]["arguments"] += chunk
    message: Dict[str, Any] = {}
    content = "".join(content_parts)
    reasoning = "".join(reasoning_parts)
    if content:
        message["content"] = content
    if reasoning:
        message["reasoning_content"] = reasoning
    if tool_acc:
        message["tool_calls"] = [tool_acc[key] for key in sorted(tool_acc)]
    return message, last_usage


async def _call_model(
    messages: list,
    model: Dict[str, Any],
    max_tokens: int,
    tools: Optional[list] = None,
    tool_choice: Optional[str] = None,
    json_mode: bool = False,
    on_delta=None,
) -> Dict[str, Any]:
    """Call the chat completions endpoint and return content + tool_calls.

    on_delta 提供时走流式（SSE），正文增量实时回调（前端打字机预览）；
    返回值与非流式完全一致。"""
    url = f"{model['base_url'].rstrip('/')}/chat/completions"
    headers = {"Content-Type": "application/json"}
    if model["api_key"] and model["provider"] != "opencode":
        headers["Authorization"] = f"Bearer {model['api_key']}"
    headers.update(opencode_gateway_headers(model["base_url"], _HARNESS_SESSION_ID))
    body = {
        "model": model["model"],
        "messages": messages,
        "stream": on_delta is not None,
        "temperature": 0.2,
        "max_tokens": max_tokens,
    }
    if tools:
        body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
    elif json_mode:
        body["response_format"] = {"type": "json_object"}
    usage = None
    try:
        client = get_http_client()
        if on_delta is not None:
            message, usage = await _stream_chat_completions(client, url, headers, body, on_delta)
        else:
            resp = await client.post(url, json=body, headers=headers, timeout=90.0)
            if resp.status_code != 200:
                detail = resp.text[:500]
                raise HarnessError(f"模型返回 {resp.status_code}: {detail}")
            try:
                data = resp.json()
                usage = data.get("usage") if isinstance(data, dict) else None
                message = data["choices"][0].get("message") or {}
            except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
                raise HarnessError("模型响应缺少有效内容") from exc
    except httpx.HTTPError as exc:
        raise HarnessError(f"模型请求失败: {exc}") from exc
    logger.info(
        "harness model call: %s/%s tools=%s tool_choice=%s json_mode=%s",
        model["provider"], model["model"], bool(tools), tool_choice or "-", json_mode,
    )
    if usage:
        usage_stats.record_usage(model["provider"], model["model"], "harness",
                                 _HARNESS_SESSION_ID, usage)
    # 推理模型（deepseek-v4-flash / hy3 等）两种形态都要防：
    # ① 正文带 <think>…</think> 思考块（思考里还可能草拟残缺 JSON 干扰解析）；
    # ② 正文为空、全文落在 reasoning_content。
    # 先剥离再返回，避免思考文本污染 JSON 解析与 summary 展示。
    raw_content = str(message.get("content") or "")
    cleaned = strip_reasoning(raw_content)
    fallback_reasoning = False
    if not cleaned.strip():
        alt = strip_reasoning(str(message.get("reasoning_content") or ""))
        if alt.strip():
            cleaned = alt
            fallback_reasoning = True
    if cleaned != raw_content or fallback_reasoning:
        logger.info(
            "harness think-strip: %d -> %d chars (fallback_reasoning=%s)",
            len(raw_content), len(cleaned), fallback_reasoning,
        )
    return {
        "content": cleaned,
        "tool_calls": message.get("tool_calls") or [],
        "reasoning_stripped": bool(cleaned != raw_content) and not fallback_reasoning,
        "reasoning_fallback": fallback_reasoning,
    }





def _merge_post_ops(current: Dict[str, Any], result: Dict[str, Any], extra_ops: list,
                    diff_base: Any = None) -> Dict[str, Any]:
    """把事后补的操作（自动连边/补链/评价清理）合并进既有结果并重算 diff。

    三处「build_next_snapshot → operations 相加 → diff 重算 → errors append」
    的公共形态（09-20 抽取）。追加的 errors 必须能把 ok 翻成 error——
    此前 status 在 build_next_snapshot 里已定死，事后报错改不了它，
    孤立节点依旧孤立、结果却显示成功。"""
    ops = list(result.get("operations") or [])
    merged = build_next_snapshot(result.get("next_snapshot") or current, extra_ops)
    result["operations"] = ops + list(merged.get("operations") or [])
    result["next_snapshot"] = merged["next_snapshot"]
    result["diff"] = diff_snapshots(diff_base if diff_base is not None else current,
                                    merged["next_snapshot"])
    for err in merged.get("errors") or []:
        result.setdefault("errors", []).append(err)
    if result.get("errors") and result.get("status") == "ok":
        result["status"] = "error"
    return result


def _complete_expand_chains(current: Dict[str, Any], result: Dict[str, Any], focus_node_ids) -> Dict[str, Any]:
    """Deterministic safety net for expand phase:
    1. When the model created answer nodes but forgot the corresponding learn module,
       auto-create one and connect it (answer -> learn).
    2. When the model omitted an answer chain entirely for a focus target
       (known weak-model behavior: merging/omitting multi-target expands),
       auto-create the full chain (answer + learn + target->answer + answer->learn).
    Only runs for created/answered targets; never touches existing nodes."""
    ops = list(result.get("operations") or [])
    answers = []
    learn_ids = set()
    edges = []
    for op in ops:
        name = str(op.get("op") or "")
        node_id = str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")
        if name == "create_node":
            if str(op.get("kind") or "") == "answer":
                answers.append(op)
            elif str(op.get("kind") or "") == "module" and str(op.get("module_key") or "") == "learn":
                if node_id:
                    learn_ids.add(node_id)
        elif name == "add_edge":
            edges.append((str(op.get("from") or ""), str(op.get("to") or "")))
    edge_pairs = set(edges)

    def _ans_id(op):
        return str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")

    extra_ops = []
    auto_learn_count = 0
    auto_chain_count = 0

    # pass 1: missing learn module for created answers
    for op in answers:
        answer_id = _ans_id(op)
        if not answer_id:
            continue
        if any((answer_id, learn) in edge_pairs for learn in learn_ids):
            continue
        extra_ops.append({
            "op": "create_node",
            "temp_id": "auto_learn_" + answer_id,
            "kind": "module",
            "module_key": "learn",
            "label": "进阶学习",
            "content": str(op.get("content") or "")[:300] or "进阶学习内容",
            "reason": "自动补全进阶学习模块（模型遗漏）",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": answer_id,
            "to": "auto_learn_" + answer_id,
            "relation": "模块",
            "label": "进入进阶内容",
            "reason": "自动补全进阶学习链",
        })
        auto_learn_count += 1

    # pass 2: full missing chain per focus target
    current_nodes = {str(n.get("id")): n for n in (current.get("nodes") or [])}
    answer_ids = set(_ans_id(op) for op in answers if _ans_id(op))
    covered_targets = {
        frm for (frm, to) in edge_pairs
        if to in answer_ids
    }
    for tid in (focus_node_ids or []):
        tid = str(tid)
        if tid in covered_targets or tid not in current_nodes:
            continue
        target_label = str(current_nodes[tid].get("label") or current_nodes[tid].get("title") or tid)
        ans_temp = "auto_ans_" + tid
        learn_temp = "auto_learn_" + tid
        extra_ops.append({
            "op": "create_node",
            "temp_id": ans_temp,
            "kind": "answer",
            "label": target_label + "的进阶学习",
            "content": "深入「" + target_label + "」的高阶方向与应用（正文由内容生成流程填充）",
            "reason": "自动补全进阶学习链（模型遗漏该目标）",
        })
        extra_ops.append({
            "op": "create_node",
            "temp_id": learn_temp,
            "kind": "module",
            "module_key": "learn",
            "label": "进阶学习",
            "content": "进阶方向占位（正文由内容生成流程填充）",
            "reason": "自动补全进阶学习链（模型遗漏该目标）",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": tid,
            "to": ans_temp,
            "relation": "进阶",
            "label": "深入" + target_label,
            "reason": "自动补全进阶学习链",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": ans_temp,
            "to": learn_temp,
            "relation": "模块",
            "label": "进入进阶内容",
            "reason": "自动补全进阶学习链",
        })
        auto_chain_count += 1

    if not extra_ops:
        return result
    _merge_post_ops(current, result, extra_ops)
    reasons = []
    if auto_learn_count:
        reasons.append("为 " + str(auto_learn_count) + " 个 AI 回答节点自动补全进阶学习模块")
    if auto_chain_count:
        reasons.append("为 " + str(auto_chain_count) + " 个目标知识点自动补全进阶学习链（模型遗漏）")
    if reasons:
        result.setdefault("warnings", []).append({
            "index": "auto-expand",
            "op": "create_node",
            "reason": "；".join(reasons),
        })
    return result

def _auto_connect_isolated(current: Dict[str, Any], result: Dict[str, Any], focus_node_ids, instruction: str = "") -> Dict[str, Any]:
    """Deterministic safety net: connect created nodes that ended up isolated
    (no add_edge referencing them) to the focus node, or to the first existing
    node when there is no focus. Never runs for evaluate/apply phases."""
    text = str(instruction or "")
    if any(word in text for word in ("独立", "单独", "不要连接", "不连接")):
        return result
    ops = list(result.get("operations") or [])
    created = [op for op in ops if str(op.get("op")) == "create_node"]
    if not created:
        return result
    edge_endpoints = set()
    for op in ops:
        if str(op.get("op")) == "add_edge":
            if op.get("from"):
                edge_endpoints.add(str(op.get("from")))
            if op.get("to"):
                edge_endpoints.add(str(op.get("to")))
    isolated = [
        op for op in created
        if str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "") not in edge_endpoints
    ]
    if not isolated:
        return result
    # 锚点从合并后快照的存活节点里选：current 是操作应用前的图，同批
    # 「删第一个节点 + 建孤立节点」会把锚连到已删节点上报「起点不存在」，
    # 孤立节点依旧孤立（09-20 修复）
    live_ids = [str(node.get("id"))
                for node in (result.get("next_snapshot") or {}).get("nodes", [])]
    existing_ids = live_ids or [str(node.get("id")) for node in current.get("nodes", [])]
    anchors = [str(item) for item in (focus_node_ids or []) if str(item) in existing_ids]
    anchor = anchors[0] if anchors else (existing_ids[0] if existing_ids else None)
    if not anchor:
        return result
    extra_ops = [
        {
            "op": "add_edge",
            "from": anchor,
            "to": str(op.get("assigned_id") or op.get("id") or op.get("temp_id")),
            "relation": "关联",
            "label": "自动连接（避免孤立节点）",
            "reason": "自动连接（避免孤立节点）",
        }
        for op in isolated
    ]
    _merge_post_ops(current, result, extra_ops)
    result.setdefault("warnings", []).append({
        "index": "auto-connect",
        "op": "add_edge",
        "reason": "为 " + str(len(extra_ops)) + " 个孤立新节点自动连接到「" + anchor + "」",
    })
    return result


def _fallback_summary(ops: list) -> str:
    """Build a compact, human-readable Chinese summary from validated operations
    when the model returned no text (common with tool-calling where content is empty).
    Uses labels attached by core.py; never exposes raw node ids or edge keys."""
    counts = {
        "create_node": 0, "create_eval_node": 0, "update_node": 0,
        "delete_node": 0, "add_edge": 0, "remove_edge": 0, "update_edge": 0,
    }
    details = []
    for op in ops or []:
        name = str(op.get("op") or op.get("type") or "")
        if name in counts:
            counts[name] += 1
        label = str(op.get("label") or op.get("title") or "")
        frm = str(op.get("from_label") or op.get("from") or "")
        to = str(op.get("to_label") or op.get("to") or "")
        target = str(op.get("target_label") or op.get("target") or op.get("target_node_id") or "")
        if name == "create_node":
            details.append("新增「" + (label or "节点") + "」")
        elif name == "create_eval_node":
            details.append("为「" + (target or label or "目标节点") + "」生成评价")
        elif name == "update_node":
            details.append("修改「" + (label or "节点") + "」")
        elif name == "delete_node":
            details.append("删除「" + (label or "节点") + "」")
        elif name == "add_edge":
            details.append("新增连线「" + (frm or "上游") + "」→「" + (to or "下游") + "」")
        elif name == "remove_edge":
            details.append("删除连线「" + (frm or "上游") + "」→「" + (to or "下游") + "」")
        elif name == "update_edge":
            details.append("调整连线「" + (frm or "上游") + "」→「" + (to or "下游") + "」")
    if not details:
        return ""
    count_parts = []
    if counts["create_node"]:
        count_parts.append("新增 " + str(counts["create_node"]) + " 个节点")
    if counts["add_edge"]:
        count_parts.append(str(counts["add_edge"]) + " 条连线")
    if counts["update_node"]:
        count_parts.append("修改 " + str(counts["update_node"]) + " 处")
    if counts["update_edge"]:
        count_parts.append("调整 " + str(counts["update_edge"]) + " 条连线")
    if counts["delete_node"]:
        count_parts.append("删除 " + str(counts["delete_node"]) + " 个节点")
    if counts["remove_edge"]:
        count_parts.append("移除 " + str(counts["remove_edge"]) + " 条连线")
    if counts["create_eval_node"]:
        count_parts.append(str(counts["create_eval_node"]) + " 条评价建议")
    head = ""
    if count_parts:
        head = "好的，已按你的要求完成梳理，共 " + str(len(ops or [])) + " 处调整（" + "、".join(count_parts) + "）。"
    return (head + " " + "；".join(details)).strip()[:300]


def _summarize_errors(errors) -> str:
    lines = []
    for item in errors or []:
        op = item.get("op") or "?"
        reason = item.get("reason") or "?"
        lines.append(f"- operation {item.get('index', '?')} ({op}): {reason}")
    return "\n".join(lines)




def _focus_subgraph(snapshot: Dict[str, Any], focus_node_ids, max_hops: int = 2, max_nodes: int = 40) -> Optional[Dict[str, Any]]:
    """快照过大且有焦点时，抽取焦点节点邻域子图（焦点 + 至多 max_hops 跳邻居）。

    返回新快照（含 omitted_node_count），无法抽取（无焦点/无邻居）时返回 None。
    只保留焦点邻域内的节点与连线，显著减小发送给模型的上下文。
    """
    nodes = snapshot.get("nodes") or []
    edges = snapshot.get("edges") or []
    focus = {str(item) for item in (focus_node_ids or []) if str(item)}
    if not focus:
        return None
    node_by_id = {str(n.get("id")): n for n in nodes}
    adj = {}
    for e in edges:
        frm = str(e.get("from") or "")
        to = str(e.get("to") or "")
        if frm:
            adj.setdefault(frm, set()).add(to)
        if to:
            adj.setdefault(to, set()).add(frm)
    kept = {nid for nid in focus if nid in node_by_id}
    if not kept:
        return None
    frontier = set(kept)
    for _ in range(max_hops):
        if len(kept) >= max_nodes:
            break
        nxt = set()
        for nid in frontier:
            for nb in adj.get(nid, ()):
                if nb in node_by_id and nb not in kept and len(kept) < max_nodes:
                    kept.add(nb)
                    nxt.add(nb)
        if not nxt:
            break
        frontier = nxt
    # 保留 AI 评价节点
    for n in nodes:
        if n.get("kind") == "ai_eval" and str(n.get("id")) not in kept and len(kept) < max_nodes:
            kept.add(str(n.get("id")))
    kept_edges = [e for e in edges if str(e.get("from") or "") in kept and str(e.get("to") or "") in kept]
    kept_nodes = [node_by_id[nid] for nid in kept if nid in node_by_id]
    result = {
        "nodes": kept_nodes,
        "edges": kept_edges,
        "omitted_node_count": len(nodes) - len(kept_nodes),
    }
    # M2：薄弱点不是图元素，抽邻域子图时原样带过去（否则大图一降采样提示词就看不到薄弱点）
    if snapshot.get("quiz_weak"):
        result["quiz_weak"] = snapshot["quiz_weak"]
    # 大陆 v3：跨画布共享点同理——它是提示词参考字段，不随节点裁剪丢失
    if snapshot.get("continent_shared"):
        result["continent_shared"] = snapshot["continent_shared"]
    return result


def _compact_snapshot(snapshot: Dict[str, Any], focus_node_ids) -> Dict[str, Any]:
    """Trim non-focus node content for large snapshots; raise when still too big."""
    if len(json.dumps(snapshot, ensure_ascii=False)) <= MAX_SNAPSHOT_CHARS:
        return snapshot
    focus = {str(item) for item in (focus_node_ids or [])}
    for node in snapshot.get("nodes", []):
        if node.get("id") in focus or node.get("kind") == "ai_eval":
            continue
        node["content"] = str(node.get("content") or "")[:NON_FOCUS_CONTENT_CHARS]
        node["formula"] = ""
    if len(json.dumps(snapshot, ensure_ascii=False)) > MAX_SNAPSHOT_HARD_CHARS:
        count = len(snapshot.get("nodes") or [])
        raise HarnessError(f"快照过大（{count} 个节点），请先选中局部节点或缩小范围后再让 AI 修改")
    return snapshot


def _should_selfcheck_ops(ops: list) -> bool:
    """小改动（≤3 条且无创建/删除节点）跳过模型批判自检，省一次串行模型调用。"""
    if len(ops) > 3:
        return True
    return any(
        isinstance(op, dict) and op.get("op") in ("create_node", "create_eval_node", "delete_node")
        for op in ops
    )


async def _selfcheck_ops(snapshot: Dict[str, Any], instruction: str, ops: list, model: Dict[str, Any], counter: Optional[Dict[str, int]] = None) -> Dict[str, Any]:
    """One lightweight critic call checking instruction coverage. Never blocks on failure."""
    def _tick():
        if counter is not None:
            counter["n"] += 1

    messages = build_selfcheck_messages(str(instruction or ""), snapshot, ops)
    # 主循环对 required 有 provider 门控（opencode 免费模型不支持，见
    # _supports_required_tool_choice），自检不带门控会在这些链路上每次
    # 白烧一整轮注定 400 的调用 + 一轮 JSON 重试（09-20 修复）
    can_require = _supports_required_tool_choice(model["provider"])
    try:
        _tick()
        raw = await _call_model(messages, model, 600, tools=[SELFCHECK_TOOL],
                                tool_choice="required" if can_require else "auto")
        parsed = parse_selfcheck_tool(raw["tool_calls"])
        if parsed is not None:
            return parsed
        return parse_selfcheck(raw["content"])
    except HarnessError:
        try:
            _tick()
            raw = await _call_model(messages, model, 600, json_mode=_supports_json_mode(model["provider"]))
            return parse_selfcheck(raw["content"])
        except HarnessError:
            return {"ok": True, "issues": [], "missing": [], "error": "自检调用失败，已跳过"}


def _log_context_metrics(messages: list, snapshot: dict, phase: str) -> None:
    """Log per-request context sizes for the harness review/resolve endpoints."""
    try:
        sys_chars = sum(len(str(m.get("content") or "")) for m in messages if m.get("role") == "system")
        user_chars = sum(len(str(m.get("content") or "")) for m in messages if m.get("role") != "system")
        all_text = "".join(str(m.get("content") or "") for m in messages)
        metrics = {
            "phase": phase,
            "nodes": len(snapshot.get("nodes") or []),
            "edges": len(snapshot.get("edges") or []),
            "snapshot_chars": len(json.dumps(snapshot, ensure_ascii=False)),
            "system_chars": sys_chars,
            "user_chars": user_chars,
            "est_tokens": estimate_tokens(all_text),
        }
        logger.info(
            "harness context: phase=%(phase)s nodes=%(nodes)d edges=%(edges)d snapshot_chars=%(snapshot_chars)d system_chars=%(system_chars)d user_chars=%(user_chars)d est_tokens=%(est_tokens)d",
            metrics,
        )
        return metrics
    except Exception:
        return None


async def review_graph(
    snapshot: Any,
    instruction: str,
    model: Optional[Dict[str, Any]] = None,
    max_tokens: int = 4000,
    retries: int = 1,
    phase: str = "normal",
    context: str = "",
    level: str = "",
    focus_node_ids=None,
    mode: str = "auto",
    self_check: str = "auto",
    history=None,
    previous_ops=None,
    previous_snapshot=None,
    all_previous_ops=None,
    initial_snapshot=None,
    progress=None,
) -> Dict[str, Any]:
    """Review the snapshot and return validated graph operations.

    mode: "tools" (force function calling), "json" (force free-form JSON),
    or "auto" (try tools, fall back to JSON when the provider rejects them).

    progress: 可选回调（dict 事件），流式请求时由 api 层传入；事件两类——
    {"type":"status","stage":...,"message":...} 阶段进度、
    {"type":"delta","text":...} 模型正文增量。不传则零开销。
    """
    def _emit(event: Dict[str, Any]) -> None:
        if progress is None:
            return
        try:
            progress(event)
        except Exception:
            logger.debug("harness progress emit failed", exc_info=True)

    # ---- 模型调用计数：随结果返回，供延迟归因（次数 vs 单次耗时）与优化验证 ----
    call_counter = {"n": 0}
    context_metrics: Optional[Dict[str, Any]] = None
    reasoning_seen = {"hit": False}

    async def _counted_call(messages, model_, max_tokens_, **kw):
        call_counter["n"] += 1
        return await _call_model(messages, model_, max_tokens_, **kw)

    current = normalize_snapshot(snapshot)
    if len(json.dumps(current, ensure_ascii=False)) > MAX_SNAPSHOT_CHARS:
        sub = _focus_subgraph(current, focus_node_ids)
        if sub is not None:
            current = sub
            context = str(context or "") + f"\n（本次快照过大，已省略 {sub.get('omitted_node_count', 0)} 个非焦点节点，仅保留焦点邻域供审阅。）"
    current = _compact_snapshot(current, focus_node_ids)
    instruction = str(instruction or "").strip() or "请审阅并优化这个知识网络"
    phase = _detect_phase(str(phase or "normal"), instruction, current, focus_node_ids)
    _emit({
        "type": "status",
        "stage": "start",
        "message": "已理解指令（" + _PHASE_LABELS.get(phase, phase) + "），正在准备画布上下文",
    })
    # ---- 评价阶段确定性短路：图里没有可评价节点时无需调模型 ----
    if phase == "evaluate":
        editable_nodes = [
            n for n in (current.get("nodes") or [])
            if str(n.get("kind") or "") != "ai_eval"
        ]
        if not editable_nodes:
            result = build_next_snapshot(current, [])
            result["summary"] = "当前图还没有可评价的节点：先添加知识点或提出问题，我再帮你审阅。"
            result["raw_has_ops"] = False
            result["model_calls"] = 0
            return result
    full_context = str(context or "")
    resolved_model = _resolve_model(model)
    provider = resolved_model["provider"]

    mode = str(mode or "auto").strip().lower()
    # ---- 确定性撤销：指令含撤销意图且有上一步操作时，不调用模型 ----
    undo_intent = _detect_undo_intent(instruction)
    text_lower = str(instruction or "").lower()
    scope = _undo_scope(instruction, focus_node_ids)
    use_full = scope in ("full", "targeted") and (all_previous_ops or [])
    prev_ops = list(all_previous_ops or []) if use_full else list(previous_ops or [])
    prev_before = initial_snapshot if use_full else previous_snapshot
    if undo_intent and prev_ops:
        # F5：撤销前态用后端原样快照（未截断），归一化会丢长正文与本地字段。
        current = normalize_snapshot(snapshot)
        if not isinstance(prev_before, dict):
            # 没有无损前态就没有恢复依据：明确拒绝，绝不静默降级成有损猜测恢复。
            reason_text = "缺少本次修改的撤销前态（无损快照），无法安全恢复；请使用画布的「撤销本次」按钮回退"
            _emit({"type": "status", "stage": "undo", "message": reason_text})
            return {
                "status": "error",
                "summary": reason_text,
                "operations": [],
                "next_snapshot": current,
                "diff": [],
                "errors": [{"reason": reason_text}],
                "warnings": [],
                "raw_has_ops": False,
                "model_calls": call_counter["n"],
            }
        try:
            from .core import _InverseOperations, UndoRestoreError

            inverse_ops = build_inverse_ops(
                prev_before if isinstance(prev_before, dict) else current,
                _InverseOperations(prev_ops),
                current,
            )
            inverse_ops = _InverseOperations(_filter_inverse_by_targets(inverse_ops, focus_node_ids, current))
            if inverse_ops:
                _emit({"type": "status", "stage": "undo", "message": "检测到撤销意图，正在直接回滚（无需模型）"})
                undo_result = build_next_snapshot(current, inverse_ops)
                undo_result["summary"] = "已撤销上一步修改" + (
                    "（仅撤销指定节点相关改动）" if focus_node_ids else ""
                ) + (
                    # scope=full 但调用方没带完整操作历史（前端主路径只带上一步）：
                    # 如实说明只回滚了最后一步，别让「全部撤销」静默缩水
                    "（未收到完整操作历史，仅回滚了最后一步）"
                    if scope == "full" and not use_full else ""
                )
                undo_result["status"] = "undo"
                undo_result["phase"] = "undo"
                undo_result["raw_has_ops"] = bool(inverse_ops)
                undo_result["undo_ops"] = inverse_ops
                undo_result["model_calls"] = call_counter["n"]
                return undo_result
        except UndoRestoreError as exc:
            # 恢复契约不闭合（如缺少无损前态）时明确拒绝，绝不静默降级成
            # 有损猜测恢复。给用户可操作的替代出口。
            _emit({"type": "status", "stage": "undo", "message": str(exc)})
            return {
                "status": "error",
                "summary": str(exc),
                "operations": [],
                "next_snapshot": current,
                "diff": [],
                "errors": [{"reason": str(exc)}],
                "warnings": [],
                "raw_has_ops": False,
                "model_calls": call_counter["n"],
            }
        if undo_intent and prev_ops and not inverse_ops:
            # 焦点过滤后逆操作为空（或本就无可逆操作）：明确 no-op 返回。
            # 此前会跌回模型路径——带着「撤销」指令和全套编辑工具自由发挥，
            # 违反「确定性撤销不调模型」的拍板，还会跳过大图守卫把未压缩
            # 快照原样发给模型（09-20 修复）
            reason_text = ("上一步修改与你选中的节点无关，没有可撤销的内容。"
                           if focus_node_ids else "上一步没有生成可撤销的修改。")
            _emit({"type": "status", "stage": "undo", "message": reason_text})
            return {
                "status": "undo",
                "summary": reason_text,
                "operations": [],
                "next_snapshot": current,
                "diff": [],
                "errors": [],
                "warnings": [],
                "raw_has_ops": False,
                "model_calls": call_counter["n"],
            }
    tools = build_tools(phase) if mode in ("auto", "tools") else None
    can_require = _supports_required_tool_choice(provider)
    if not tools:
        tool_choice = None
    elif phase in ("expand", "evaluate", "apply"):
        tool_choice = "required" if can_require else "auto"
    else:
        tool_choice = "required" if (_has_edit_intent(instruction) and can_require) else "auto"
    json_mode = _supports_json_mode(provider) if mode != "tools" else False
    self_check_mode = str(self_check or "auto").strip().lower()
    self_check_enabled = (
        self_check_mode == "on"
        or (self_check_mode == "auto" and phase in ("normal", "apply"))
    )

    last_raw = ""
    last_errors = []

    def messages_for_attempt(retry_errors: str = "") -> list:
        if phase == "evaluate":
            return build_evaluate_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        if phase == "apply":
            return build_apply_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        if phase == "expand":
            return build_expand_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        return build_review_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)

    for attempt in range(retries + 1):
        messages = messages_for_attempt(_summarize_errors(last_errors) if attempt > 0 else "")
        current_tools = list(tools) if tools else None
        current_choice = tool_choice if current_tools else None
        current_json = json_mode if not current_tools else False
        if current_tools:
            messages[-1]["content"] += (TOOLS_AUTO_HINT if tool_choice == "auto" else TOOLS_USER_HINT)
        history_text = _history_block(history)
        if history_text:
            messages[-1]["content"] += history_text
        if attempt == 0:
            context_metrics = _log_context_metrics(messages, current, phase) or context_metrics

        _emit({
            "type": "status",
            "stage": "model",
            "message": "正在思考方案…" if attempt == 0
            else f"正在根据校验反馈修正方案（第 {attempt + 1} 轮）…",
        })
        # on_delta 只在流式请求（progress 存在）时附带：测试桩/battery 的
        # _call_model 桩是固定签名，多余的 kwargs 会让它们直接抛 TypeError
        model_kwargs: Dict[str, Any] = {}
        if progress is not None:
            model_kwargs["on_delta"] = lambda chunk: _emit({"type": "delta", "text": chunk})
        try:
            raw = await _counted_call(
                messages,
                resolved_model,
                max_tokens,
                tools=current_tools,
                tool_choice=current_choice,
                json_mode=current_json,
                **model_kwargs,
            )
        except HarnessError as exc:
            if current_tools and mode == "auto":
                if tool_choice == "required":
                    # 部分 provider（如 opencode 免费模型）不支持 required，先降级为 auto
                    logger.warning("tool_choice=required 失败，降级为 auto: %s", exc)
                    tool_choice = "auto"
                    raw = await _counted_call(
                        messages,
                        resolved_model,
                        max_tokens,
                        tools=current_tools,
                        tool_choice="auto",
                        **model_kwargs,
                    )
                else:
                    logger.warning("工具调用失败，降级为自由 JSON: %s", exc)
                    tools = None
                    tool_choice = None
                    messages[-1]["content"] = messages[-1]["content"].replace(TOOLS_USER_HINT, "").replace(TOOLS_AUTO_HINT, "")
                    raw = await _counted_call(
                        messages,
                        resolved_model,
                        max_tokens,
                        json_mode=_supports_json_mode(provider),
                        **model_kwargs,
                    )
            else:
                raise

        # 消费端再剥一次（幂等）：即使 _call_model 未经过（测试桩/旧路径）也能兜住
        _emit({"type": "status", "stage": "validate", "message": "方案已生成，正在校验操作…"})
        last_raw = strip_reasoning(raw["content"] or "")
        if not last_raw.strip() and raw.get("reasoning_content"):
            # 正文为空时回退 reasoning_content（推理模型全文落在思考字段）
            alt = strip_reasoning(str(raw["reasoning_content"]))
            if alt.strip():
                last_raw = alt
                reasoning_seen["hit"] = True
        if raw.get("reasoning_stripped") or raw.get("reasoning_fallback"):
            reasoning_seen["hit"] = True
        if raw.get("tool_calls"):
            raw_ops, tool_errors = parse_tool_calls(raw["tool_calls"])
            if tool_errors:
                last_errors = tool_errors
                logger.warning("tool_calls 解析失败: %s", tool_errors)
                continue
            summary = str(raw.get("content") or "").strip()
        else:
            payload = extract_json(last_raw)
            if payload is None and current_tools is not None:
                # 模型选择纯文字回答（未调用工具），视为对话，不强制图操作；
                # 若文本是“JSON 外壳”（模型把 JSON 写进正文且引号未转义），只保留内层 summary
                summary = _clamp_display_summary(
                    _extract_summary_from_json_shell(last_raw) or last_raw
                )
                raw_ops = []
            elif payload is None:
                last_errors = [{"index": "parse", "op": "json", "reason": "模型输出不是合法 JSON"}]
                logger.warning("模型输出不是合法 JSON: %s", last_raw[:300])
                continue
            elif isinstance(payload, list):
                # 模型直接输出了顶层操作数组
                raw_ops = payload
                summary = ""
            else:
                raw_ops = payload.get("operations") or payload.get("ops") or []
                if not isinstance(raw_ops, list):
                    last_errors = [{"index": "schema", "op": "operations", "reason": "operations 必须是数组"}]
                    continue
                summary = str(payload.get("summary") or "").strip()
                if isinstance(payload.get("clarify"), dict):
                    return {
                        "status": "clarify",
                        "summary": summary or "需要向你确认一下",
                        "clarify": payload["clarify"],
                        "operations": [],
                        "next_snapshot": current,
                        "diff": [],
                        "errors": [],
                        "warnings": [],
                        "raw_has_ops": False,
                        "model_calls": call_counter["n"],
                        "out_chars": len(last_raw),
                        "reasoning_stripped": reasoning_seen["hit"],
                    }

        # 归一化操作名与字段别名：action/operation/type -> op；node_id -> id
        normalized_ops = []
        for op in raw_ops:
            if not isinstance(op, dict):
                normalized_ops.append(op)
                continue
            op = dict(op)
            op["op"] = str(op.get("op") or op.get("action") or op.get("operation") or op.get("type") or "")
            if not op.get("id") and op.get("node_id"):
                op["id"] = op.get("node_id")
            normalized_ops.append(op)
        raw_ops = normalized_ops

        if phase == "evaluate":
            raw_ops = [
                op for op in raw_ops
                if isinstance(op, dict) and op.get("op") == "create_eval_node"
            ]
        elif phase in ("normal", "apply"):
            eval_ops = [
                op for op in raw_ops
                if isinstance(op, dict) and op.get("op") == "create_eval_node"
            ]
            if eval_ops:
                reason = "正常审阅不能创建 AI 评价节点，请改用“评价/建议”类指令" if phase == "normal" else "应用阶段不能创建 AI 评价节点，请根据已有评价节点执行真实修改"
                last_errors = [{
                    "index": "phase",
                    "op": "create_eval_node",
                    "reason": reason,
                }]
                continue

        # ---- 焦点遵从校验：指定了重点节点却全部未命中时，带反馈重试 ----
        focus_set = {str(f) for f in (focus_node_ids or []) if str(f)}
        if phase == "evaluate" and raw_ops and focus_set and attempt < retries:
            eval_targets = {str(op.get("target_node_id") or "") for op in raw_ops}
            if not eval_targets & focus_set:
                focus_labels = [
                    str(n.get("label") or n.get("id"))
                    for n in current.get("nodes") or []
                    if str(n.get("id")) in focus_set
                ]
                last_errors = [{
                    "index": "evaluate",
                    "op": "create_eval_node",
                    "reason": "评价目标未命中用户指定的重点节点（"
                              + "、".join(focus_labels) + "）。只评价这些节点，不要评价其他节点",
                }]
                continue

        if phase == "evaluate" and not raw_ops:
            if attempt < retries and not _refusal_explained(summary):
                last_errors = [{
                    "index": "evaluate",
                    "op": "create_eval_node",
                    "reason": "评价阶段必须生成 create_eval_node 操作，不要只返回文字或空操作",
                }]
                continue

        if phase == "normal" and not raw_ops and _has_edit_intent(instruction) and not _detect_undo_intent(instruction):
            if attempt < retries and not _refusal_explained(summary):
                last_errors = [{
                    "index": "normal",
                    "op": "operation",
                    "reason": "指令包含明确的修改意图（新增/删除/修改/补充等），请输出真实图操作，不要只返回文字",
                }]
                continue

        if phase == "normal" and raw_ops and focus_set and attempt < retries:
            upd = [op for op in raw_ops if op.get("op") == "update_node"]
            if upd and not any(str(op.get("id")) in focus_set for op in upd):
                focus_labels = [
                    str(n.get("label") or n.get("id"))
                    for n in current.get("nodes") or []
                    if str(n.get("id")) in focus_set
                ]
                last_errors = [{
                    "index": "normal",
                    "op": "update_node",
                    "reason": "修改目标未命中用户指定的重点节点（"
                              + "、".join(focus_labels) + "）。请改为修改这些节点",
                }]
                continue

        if phase == "apply" and not raw_ops:
            if attempt < retries:
                last_errors = [{
                    "index": "apply",
                    "op": "update_node",
                    "reason": "应用阶段必须根据 ai_eval 节点输出真实修改操作（update/delete/add_edge/remove_edge/update_edge），不要只返回文字",
                }]
                continue

        result = build_next_snapshot(current, raw_ops)
        ops_for_summary = result.get("operations") or []
        result["summary"] = summary or _fallback_summary(ops_for_summary) or ("本次未提出图修改建议" if not ops_for_summary else "")
        result["raw_has_ops"] = bool(raw_ops)
        if phase == "apply":
            result = _cleanup_remaining_eval_nodes(result, current)

        # ---- 语义自检：规则（零成本） ----
        result["self_check"] = {
            "rules": rule_selfcheck(current, instruction, focus_node_ids, raw_ops),
        }
        for issue in result["self_check"]["rules"].get("issues", []):
            result["warnings"].append({"index": "rules", "op": "selfcheck", "reason": issue})

        # ---- 语义自检：新建节点必须连线（软重试） ----
        isolated = find_isolated_created_nodes(current, result.get("operations") or [])
        if isolated:
            labels = "、".join(item.get("label") or item.get("id") for item in isolated)
            if attempt < retries:
                last_errors = [{
                    "index": "isolated",
                    "op": "create_node",
                    "reason": f"新节点未连接到已有节点：{labels}。请补充 add_edge（若用户明确要独立节点，请在 summary 中说明）",
                }]
                continue
            result["warnings"].append({
                "index": "isolated",
                "op": "create_node",
                "reason": f"新节点未连接到已有节点：{labels}",
            })

        # ---- 拓展阶段：每个目标知识点必须生成完整进阶链（软重试） ----
        if phase == "expand":
            missing_chains = find_missing_expansion_chains(current, result.get("operations") or [], focus_node_ids)
            if missing_chains:
                detail = "；".join(
                    f"节点 {item.get('id')}: {item.get('reason')}"
                    for item in missing_chains
                )
                if attempt < retries:
                    last_errors = [{
                        "index": "expand",
                        "op": "create_node",
                        "reason": "进阶链不完整：" + detail,
                    }]
                    continue
                result["warnings"].append({
                    "index": "expand",
                    "op": "create_node",
                    "reason": "进阶链不完整：" + detail,
                })

        # ---- 语义自检：模型批判（一次轻量调用，仅在首次尝试） ----
        if self_check_enabled and raw_ops and attempt == 0 and _should_selfcheck_ops(raw_ops):
            _emit({"type": "status", "stage": "selfcheck", "message": "正在进行深度自检…"})
            critic = await _selfcheck_ops(current, instruction, raw_ops, resolved_model, counter=call_counter)
            result["self_check"]["critic"] = critic
            if not critic.get("ok", True) and attempt < retries:
                critic_errors = [
                    {"index": "selfcheck", "op": "critic", "reason": reason}
                    for reason in critic.get("issues", [])
                ] + [
                    {"index": "selfcheck", "op": "critic", "reason": "缺少：" + reason}
                    for reason in critic.get("missing", [])
                ]
                last_errors = critic_errors
                continue
            if not critic.get("ok", True):
                for reason in critic.get("issues", []):
                    result["warnings"].append({"index": "selfcheck", "op": "critic", "reason": reason})
                for reason in critic.get("missing", []):
                    result["warnings"].append({"index": "selfcheck", "op": "critic", "reason": "缺少：" + reason})

        if result["errors"] and attempt < retries:
            last_errors = result["errors"]
            continue
        if phase in ("normal", "expand"):
            result = _auto_connect_isolated(current, result, focus_node_ids, instruction)
        if phase == "expand":
            result = _complete_expand_chains(current, result, focus_node_ids)
        result["phase"] = phase
        result["model_calls"] = call_counter["n"]
        result["out_chars"] = len(last_raw)
        result["reasoning_stripped"] = reasoning_seen["hit"]
        if context_metrics:
            result["context_metrics"] = context_metrics
        return result

    return {
        "status": "parse_error",
        "summary": "",
        "operations": [],
        "next_snapshot": current,
        "diff": [],
        "errors": last_errors or [{"reason": "模型输出解析失败"}],
        "warnings": [],
        "raw_has_ops": bool(last_raw.strip()),
        "out_chars": len(last_raw),
        "reasoning_stripped": reasoning_seen["hit"],
    }


def _deterministic_focus(instruction: str, current: Dict[str, Any]) -> list:
    """指令里的「引号标签」全部能唯一定位到节点时，免模型直接给出焦点。

    返回去重后的节点 id 列表；任一词未命中或有歧义、或根本没有引号词，
    返回空列表交回模型解析（保守：宁可多调一次也不猜）。"""
    import re

    text = str(instruction or "")
    terms = re.findall(r"[「『\"“]([^」』\"”]{1,30})[」』\"”]", text)
    if not terms:
        return []
    nodes = current.get("nodes") or []
    ids = []
    for term in terms:
        matches = [
            str(n.get("id"))
            for n in nodes
            if str(n.get("label") or "") == term or str(n.get("id")) == term
        ]
        if len(matches) != 1:
            return []
        ids.append(matches[0])
    return list(dict.fromkeys(ids))


async def resolve_focus(
    snapshot: Any,
    instruction: str,
    model: Optional[Dict[str, Any]] = None,
    max_tokens: int = 900,
    retries: int = 1,
    context: str = "",
    level: str = "",
) -> Dict[str, Any]:
    current = normalize_snapshot(snapshot)

    # ---- 确定性快路径：引号标签唯一定位时零模型调用 ----
    fast_ids = _deterministic_focus(instruction, current)
    if fast_ids:
        return {
            "status": "ok",
            "focus_node_ids": fast_ids,
            "ambiguous": False,
            "question": "",
            "candidates": [],
            "model_calls": 0,
            "deterministic": True,
        }

    node_ids = {node["id"] for node in current["nodes"]}
    full_context = str(context or "")
    resolved_model = _resolve_model(model)
    json_mode = _supports_json_mode(resolved_model["provider"])
    last_errors = []
    for attempt in range(retries + 1):
        messages = build_resolve_messages(
            current,
            str(instruction or ""),
            full_context,
            level,
            _summarize_errors(last_errors) if attempt else "",
        )
        if attempt == 0:
            _log_context_metrics(messages, current, "resolve")
        raw = await _call_model(messages, resolved_model, max_tokens, json_mode=json_mode)
        payload = extract_json(strip_reasoning(raw["content"] or ""))
        if payload is None:
            last_errors = [{"index": "parse", "op": "resolve", "reason": "目标解析输出不是合法 JSON"}]
            continue
        focus_ids = [
            str(item) for item in (payload.get("focus_node_ids") or [])
            if str(item) in node_ids
        ]
        candidates = payload.get("candidates") or []
        normalized_candidates = []
        for item in candidates:
            if not isinstance(item, dict):
                continue
            candidate_id = str(item.get("id") or "")
            if candidate_id in node_ids:
                normalized_candidates.append({
                    "id": candidate_id,
                    "label": str(item.get("label") or candidate_id),
                    "hint": str(item.get("hint") or ""),
                })
        return {
            "status": "ok",
            "focus_node_ids": list(dict.fromkeys(focus_ids)),
            "ambiguous": bool(payload.get("ambiguous")),
            "question": str(payload.get("question") or "").strip(),
            "candidates": normalized_candidates,
        }
    return {
        "status": "error",
        "focus_node_ids": [],
        "ambiguous": False,
        "question": "",
        "candidates": [],
        "errors": last_errors,
    }


def _cleanup_remaining_eval_nodes(result: Dict[str, Any], original_snapshot: Dict[str, Any]) -> Dict[str, Any]:
    remaining = [
        node for node in result.get("next_snapshot", {}).get("nodes", [])
        if node.get("kind") == "ai_eval"
    ]
    if not remaining:
        return result
    cleanup_ops = [
        {"op": "delete_node", "id": node["id"], "reason": "应用建议后自动清理 AI 评价节点"}
        for node in remaining
    ]
    _merge_post_ops(result.get("next_snapshot"), result, cleanup_ops,
                    diff_base=original_snapshot)
    return result
