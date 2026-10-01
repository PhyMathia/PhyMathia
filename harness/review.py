"""Model-backed review flow for the independent harness.

Supports two operation submission modes:
- tools (function calling): preferred, more stable; the model emits tool_calls
  which are converted into the internal operation contract;
- json (free-form JSON): fallback for providers without function-calling
  support, or when tools requests fail.
"""

from __future__ import annotations

import asyncio
import hashlib
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
    thinking_request_params,
    upstream_error_detail,
    validate_model_target,
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
from .json_utils import extract_json, repair_json, strip_reasoning
from .prompts import (
    HARNESS_CHAT_REDLINE,
    build_apply_messages,
    build_evaluate_messages,
    build_expand_messages,
    build_preset_messages,
    build_resolve_messages,
    build_review_messages,
)
from .tools import (
    READONLY_TOOL_NAMES,
    build_tools,
    execute_readonly_tool,
    parse_tool_calls,
)

logger = logging.getLogger("harness.review")

# T82 收敛（后端半边）：相位识别权归 _detect_phase 一处。前端 payload 只直通
# chat/preset/apply/expand，normal/evaluate 的本地猜测一律降级为 normal——所以
# 下面四张关键词表必须覆盖前端旧正则的每一个分支（超集，缺词＝识别退化；
# 逐词覆盖由 tests/test_harness_loop.py 的 T82 用例钉住）。
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

# ---- T93（评审路线 #8）只读查询回灌：先查图，看完了再决定改哪 ----
# 工具表含只读查询工具时（normal/expand/apply/preset），给 user 消息补的使用说明。
READONLY_TOOLS_HINT = (
    "\n\n（你可以先调用只读查询工具（read_node / list_neighbors / search_nodes）"
    "了解图中内容，再输出编辑操作；查询不会修改图。）"
)
# 查询循环步数上限：达到后剥掉只读工具并明示模型直接出方案，防失控。
MAX_TOOL_STEPS = 8
# 单条查询结果回灌的字符上限（超长截断打标，护住上下文预算）
_TOOL_RESULT_CHARS = 4000
# 同批混入的编辑类调用统一延迟到最终方案，不执行（一次批次只处理查询）
_DEFERRED_TOOL_RESULT = {
    "deferred": True,
    "note": "编辑操作已暂存；请基于以上查询结果，在准备好后单独输出编辑类工具调用作为最终方案",
}
_TOOL_STEP_LIMIT_NOTICE = (
    f"查询步数已达上限（{MAX_TOOL_STEPS} 步），请基于已获得的信息直接输出编辑操作"
    "（工具调用）或最终 JSON，不要再查询。"
)

# ---- T94（评审路线 #9）上下文预算与自动压缩 ----
# 长会话后期模型失忆的根因：历史只做「最近 6 条详细 + 更早压一行」，前面聊定的
# 方案被窗口滚掉，且历史条数、快照大小、system 上下文三者互相独立、无统一预算。
# 这里给 system+user（含历史块）一个总账：超条数或超预算就把更早条目摘要压缩，
# 摘要失败降级回既有截断行为，绝不阻断主流程。
# 预算按 estimate_tokens 模型侧口径（与前端同口径）取 24000，给前端 30000 硬拦截
# 线留出工具回灌结果与模型输出的余量。
HARNESS_CONTEXT_BUDGET_TOKENS = 24000
# 历史条数超过该值即触发压缩（保留最近 HISTORY_KEEP_RECENT 条原文）
HISTORY_COMPACT_TRIGGER_ENTRIES = 12
HISTORY_KEEP_RECENT = 6
# 摘要调用 max_tokens；摘要正文落库前再按字符数硬截（防上游无视 max_tokens 超长输出）
HISTORY_SUMMARY_MAX_TOKENS = 300
HISTORY_SUMMARY_MAX_CHARS = 400
# 压缩后重算仍超预算时，硬截到「摘要 + 最近 _HISTORY_HARD_KEEP 条」
_HISTORY_HARD_KEEP = 4
# 进程内摘要缓存：key=sha1(json(older)+模型名) → 摘要文本。上限 64 条挤掉最旧，
# 同历史重复请求（重试/换模型候选重开 attempt 前已压缩一次，同进程再次请求）不再调模型。
_HISTORY_SUMMARY_CACHE: Dict[str, str] = {}
_HISTORY_SUMMARY_CACHE_LIMIT = 64

# 流式进度事件里的阶段中文名（发给前端状态条）
_PHASE_LABELS = {
    "normal": "审阅整理",
    "evaluate": "生成评价",
    "apply": "应用建议",
    "expand": "拓展进阶",
    "preset": "创造模式",
    "chat": "答疑模式",
    "undo": "撤销回滚",
}

# 相位默认思考档（T97，2026-09-30）：质量杠杆按相位分配——评价/创造/应用是
# 结构化深推理，给 high；答疑是即时小问答，给 low 控延迟；normal/expand 留空
# （不发思考参数＝现状行为零变化，且不给改图主路径加不可控延迟）。
# 显式 thinking kwarg / 请求体字段优先，可覆盖任何相位默认（含关掉）。
PHASE_THINKING = {"evaluate": "high", "preset": "high", "apply": "high", "chat": "low"}



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
    """多轮编辑历史：最近 HISTORY_KEEP_RECENT 条详细（含操作摘要），更早条目压缩为一行，控制上下文体积。

    T94：`role=="compact_summary"` 的条目（更早历史经一次模型摘要压缩而来）渲染成
    一条「[此前 N 轮对话已压缩] 摘要：…」，统一排在历史块头部（即使用例传入的位置
    不在开头），其余条目逻辑不变；编号沿用原枚举序号，摘要条目本身不占号。"""
    if not history:
        return ""
    lines = ["\n\n此前多轮编辑历史（最新在后）："]
    compact_notes: list = []
    recent_start = max(0, len(history) - HISTORY_KEEP_RECENT)
    for i, item in enumerate(history):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        if role == "compact_summary":
            covered = item.get("covered")
            try:
                covered_n = int(covered or 0)
            except (TypeError, ValueError):
                covered_n = 0
            compact_notes.append(
                f"\n\n[此前 {covered_n} 轮对话已压缩] 摘要：{str(item.get('summary') or '')}"
            )
            continue
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
    if compact_notes:
        # 摘要条目始终排历史块头部（紧跟标题行）
        lines[1:1] = compact_notes
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


# ---- T95 上游容错：瞬时失败静默重试 ----
# 线上实测（1432 次调用 358 次失败）里 429/503 与网络超时占大头，属可自愈的
# 瞬时故障；此前一律直接抛给用户。退避序列最多 2 次重试；Retry-After 优先，
# 毫秒级封顶防止上游给出离谱等待。测试用 monkeypatch 注入 (0, 0) 免真睡。
_RETRY_DELAYS = (1.0, 3.0)
_RETRY_AFTER_CAP = 30.0
_RETRYABLE_STATUS_CODES = (429, 503)


def _parse_retry_after(resp) -> Optional[float]:
    """上游 Retry-After 头（秒数形式）解析，封顶 _RETRY_AFTER_CAP；无/非法返回 None。

    HTTP-date 形式（RFC 7231 允许）不做时钟推算，直接回落退避序列——
    多等一两秒无妨，解析错时间才危险。"""
    try:
        raw = resp.headers.get("Retry-After") if resp is not None else None
    except Exception:
        raw = None
    if raw is None:
        return None
    try:
        value = float(str(raw).strip())
    except (TypeError, ValueError):
        return None
    if value < 0:
        return None
    return min(value, float(_RETRY_AFTER_CAP))


def _retry_delay(round_index: int, retry_after: Optional[float] = None) -> float:
    """第 round_index 次重试的等待秒数：Retry-After 优先，否则退避序列该次值。"""
    if retry_after is not None:
        return float(retry_after)
    delays = _RETRY_DELAYS or ()
    if 0 <= round_index < len(delays):
        return float(delays[round_index])
    return float(delays[-1]) if delays else 0.0


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
    # 创造模式（P3，D-R6）：只有前端「✦ 创造模式」按钮显式锁定 phase=preset 才进入，
    # 意图词检测永不猜它——误触少、边界清楚
    if phase == "preset":
        return "preset"
    # 答疑模式（三模式切换器，2026-09-30）：显式只读通道，与 preset 同款直通，
    # 意图词检测永不改写它
    if phase == "chat":
        return "chat"
    auto_phases = ("", "auto", "normal")
    if phase == "apply" or (phase in auto_phases and has_apply and has_eval_nodes):
        return "apply"
    # 显式 expand 直通（此前 explicit expand 混在 auto_phases 里，会被评价词覆盖）
    if phase == "expand" or (phase in auto_phases and has_expand and focus_ids):
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
    api_key, env_key_used = resolve_api_key(provider, api_key, base_url, wide_go=True, deepseek_last_resort=True)
    if not base_url:
        base_url = PROVIDER_BASE_URLS.get(provider, "")
    if not model_name:
        raise HarnessError("模型名称不能为空")
    # 防 SSRF 外发 .env 密钥：与 main/documents/knowledge 同口径（唯一实现已
    # 下沉 llm_common.validate_model_target）——env 兜底 key 只允许发往官方
    # 域名，远程端点强制 https；base_url 为空时顺带回填 provider 默认地址。
    # harness 此前是唯一不校验的模块（T98），请求体写任意 base_url 就能把
    # .env 末位兜底的 DEEPSEEK_API_KEY 发过去。
    try:
        base_url = validate_model_target(provider, base_url, env_key_used)
    except ValueError as exc:
        raise HarnessError(str(exc)) from exc
    return {
        "provider": provider,
        "model": model_name,
        "base_url": base_url,
        "api_key": api_key,
        # T97 推理档位随 model dict 透传（_call_model 不新加形参——测试桩是
        # 固定签名）；相位默认在 review_graph 里补，这里只认模型条目自带值。
        "thinking": str(model.get("thinking") or ""),
    }


def _apply_thinking_default(target: Dict[str, Any], thinking: str, phase: str) -> None:
    """T97 相位默认档：显式 thinking 覆盖 > 模型条目自带档位 > 相位默认
    （normal/expand 无默认＝不发参数，改图主路径零变化）。

    primary 与备用候选共用（T95 换模型后必须对候选重新应用一遍）。"""
    if thinking:
        target["thinking"] = thinking
    elif not target.get("thinking"):
        target["thinking"] = PHASE_THINKING.get(phase, "")


def _sanitize_fallback_models(raw: Any) -> Optional[list]:
    """T95 备用模型清洗：至多 2 个，每项只留四字段（全部 str 化），缺 model 整项丢弃。

    前端开关关闭时 payload 根本不带该字段；打开时才出现——但服务端不能信前端
    形状（与 _resolve_model 同款的非法即拒），未知字段一并剥掉，thinking 不在
    备用契约里（换模型后按相位默认重新解析）。无效/空列表 → None＝不启用。"""
    if not isinstance(raw, list):
        return None
    cleaned: list = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        model_name = str(item.get("model") or item.get("model_name") or "").strip()
        if not model_name:
            continue
        cleaned.append({
            "provider": str(item.get("provider") or "").strip(),
            "api_key": str(item.get("api_key") or item.get("apiKey") or "").strip(),
            "model": model_name,
            "base_url": str(item.get("base_url") or item.get("baseUrl") or "").strip(),
        })
        if len(cleaned) >= 2:
            break
    return cleaned or None


# 值得换模型的状态码：鉴权（401 可能是该 key 对上游无效）、超时、限流、上游 5xx。
# 400 不换——请求体/参数问题换谁都没用（T95 拍板）。
_FALLBACK_STATUS_CODES = (401, 408, 429, 500, 502, 503, 504)


def _fallback_worthy(exc: BaseException) -> bool:
    """HarnessError 是否属于「换备用模型可能成功」的失败。无 status_code
    视为网络类（_call_model 已把 httpx 超时/断连归一成无码 HarnessError）。"""
    status = getattr(exc, "status_code", None)
    if status is None:
        return True
    try:
        return int(status) in _FALLBACK_STATUS_CODES
    except (TypeError, ValueError):
        return False


def _journal_fallback(
    journal: Optional[list],
    from_model: Optional[Dict[str, Any]],
    to_model: Optional[Dict[str, Any]],
    error: Optional[BaseException],
) -> None:
    """T96 journal：换备用模型时追一条 {stage:"fallback", from, to, error}。

    与模型往返条目同一仓库，由 api 层整体落盘（分析换模型率用）。"""
    if journal is None:
        return

    def _label(item: Optional[Dict[str, Any]]) -> str:
        item = item or {}
        provider = str(item.get("provider") or "")
        name = str(item.get("model") or item.get("model_name") or "")
        return f"{provider}/{name}" if provider else name

    try:
        journal.append({
            "stage": "fallback",
            "from": _label(from_model),
            "to": _label(to_model),
            "error": str(error or "")[:500],
        })
    except Exception:
        logger.debug("harness journal fallback append failed", exc_info=True)


async def _stream_chat_completions(client, url: str, headers: dict, body: dict, on_delta):
    """流式拉取入口：400 降级链与 main.py 代理侧同型、同序——先剥
    stream_options（只牺牲计量帧），再剥思考参数（配错供应商只是设置不生效），
    都不牺牲对话本身。任一级降级都打 warning 日志（可观测），实际拉取见
    _stream_chat_completions_once。"""
    thinking_keys = [
        key for key in ("reasoning_effort", "enable_thinking", "thinking", "think")
        if key in body
    ]
    for attempt in range(3):
        try:
            return await _stream_chat_completions_once(client, url, headers, body, on_delta)
        except HarnessError as exc:
            if getattr(exc, "status_code", None) != 400:
                raise
            if attempt == 0 and "stream_options" in body:
                body.pop("stream_options", None)
                logger.warning("harness: upstream rejected stream_options, retried without it")
                continue
            if thinking_keys:
                for key in thinking_keys:
                    body.pop(key, None)
                logger.warning(
                    "harness: upstream rejected thinking params %s, retried without them",
                    sorted(thinking_keys),
                )
                thinking_keys = []
                continue
            raise


async def _stream_chat_completions_once(client, url: str, headers: dict, body: dict, on_delta):
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
            # T43：密钥失效附「换钥」引导（与主聊天同一份文案，llm_common 唯一事实源）
            err = HarnessError(upstream_error_detail(resp.status_code, detail))
            err.status_code = resp.status_code
            # T95：流式失败退避重试也要尊重 Retry-After（_call_model 读取该属性）
            err.retry_after = _parse_retry_after(resp)
            raise err
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


def _promote_reasoning(content: str, reasoning: Any) -> tuple:
    """正文为空时的思考字段兜底判定（_call_model 与消费端共用一条门槛）。

    返回 (cleaned, promoted, prose_only)：
    - 剥掉思考标签后能解析出 JSON → 提升为正文（有的推理模型把完整操作
      方案全文写进思考字段，不提升会白白丢掉真实输出）；
    - 裸散文式思维链（网关不带 <think> 标签直接下发）绝不提升——曾整段
      英文推理被当 summary 渲染进面板（2026-09-30），返回 prose_only=True。
    """
    alt = strip_reasoning(str(reasoning or ""))
    if not alt.strip():
        return content, False, False
    if extract_json(alt) is not None:
        return alt, True, False
    return content, False, True


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
    返回值与非流式完全一致。

    T95 上游容错：429/503 与超时/断连静默退避重试（最多 _RETRY_DELAYS 次），
    流式已吐出增量则不重试；确定性失败（401/400 等）直接抛。"""
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
    if on_delta is not None:
        # 流式也要计量（2026-09-25）：include_usage 让上游在 [DONE] 前补一帧
        # 带 usage 的 chunk；不认识的兼容端点整请求 400，由 _stream_chat_completions
        # 剥掉重发（只牺牲计量帧）。此前流式 Φ 调用拿不到计量帧，命中率统计缺 Φ 一角。
        body["stream_options"] = {"include_usage": True}
    # T97 推理档位：模型条目带 thinking 档位时注入供应商思考参数（与主聊天
    # 共用 llm_common.thinking_request_params）；档位只经 model dict 传递，
    # 不给本函数加形参——测试桩是固定签名（既有拍板，见 review_graph 调用点）。
    thinking_keys: list = []
    level = str(model.get("thinking") or "")
    if level:
        params = thinking_request_params(str(model.get("provider") or ""), level)
        if params:
            body.update(params)
            thinking_keys = list(params.keys())
    if tools:
        body["tools"] = tools
        if tool_choice:
            body["tool_choice"] = tool_choice
    elif json_mode:
        body["response_format"] = {"type": "json_object"}
    usage = None
    # T95 上游容错：429/503 与网络超时/断连按 _RETRY_DELAYS 指数退避静默重试
    # （最多 2 次，尊重 Retry-After，见 _parse_retry_after/_retry_delay）。
    # 流式一旦已把正文增量交给前端就绝不重试——同一段文字会被重复渲染；
    # 401/400 等确定性失败不重试（换 key/改请求才有用，由 review_graph 的
    # 备用模型链处理 401 一类）。重试是静默的：不发 SSE 事件，用户无感。
    streamed = {"any": False}

    def _tracking_on_delta(chunk) -> None:
        streamed["any"] = True
        on_delta(chunk)

    stream_callback = _tracking_on_delta if on_delta is not None else None
    client = get_http_client()

    async def _post_once():
        """非流式单次往返（含 T97 思考参数 400 降级重发），返回 (message, usage)。"""
        resp = await client.post(url, json=body, headers=headers, timeout=90.0)
        if resp.status_code == 400 and thinking_keys:
            # 降级安全网（T97）：上游不认识思考参数整请求 400 时剥掉重发
            # 一次——配错供应商只是「档位设置不生效」，绝不弄坏对话本身，
            # 与 main.py 思考参数降级及本文件 stream_options 降级同型。
            for key in thinking_keys:
                body.pop(key, None)
            logger.warning(
                "harness: upstream rejected thinking params %s, retried without them",
                sorted(thinking_keys),
            )
            thinking_keys.clear()
            resp = await client.post(url, json=body, headers=headers, timeout=90.0)
        if resp.status_code != 200:
            detail = str(getattr(resp, "text", "") or "")[:500]
            # T43：密钥失效附「换钥」引导（与主聊天同一份文案，llm_common 唯一事实源）
            err = HarnessError(upstream_error_detail(resp.status_code, detail))
            # 既有缺陷修复（T95）：非流式路径此前不带 status_code，429/503 无法
            # 被识别为可重试（流式路径一直带）。换模型判定同样依赖它。
            err.status_code = resp.status_code
            err.retry_after = _parse_retry_after(resp)
            raise err
        try:
            data = resp.json()
            usage = data.get("usage") if isinstance(data, dict) else None
            message = data["choices"][0].get("message") or {}
        except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
            raise HarnessError("模型响应缺少有效内容") from exc
        return message, usage

    message: Dict[str, Any] = {}
    last_exc: BaseException = HarnessError("模型调用失败")
    max_attempts = len(_RETRY_DELAYS) + 1
    for round_index in range(max_attempts):
        retry_after: Optional[float] = None
        try:
            if on_delta is not None:
                message, usage = await _stream_chat_completions(
                    client, url, headers, body, stream_callback
                )
            else:
                message, usage = await _post_once()
            break
        except HarnessError as exc:
            # status_code 由 _stream_chat_completions_once / _post_once 标注；
            # 无属性的 HarnessError（响应体缺内容等）不可重试，原样抛
            if getattr(exc, "status_code", None) not in _RETRYABLE_STATUS_CODES:
                raise
            last_exc = exc
            retry_after = getattr(exc, "retry_after", None)
        except (httpx.TimeoutException, httpx.TransportError) as exc:
            # 网络抖动/连接断开：整次重发是安全的（尚未产出任何输出）
            last_exc = exc
        except httpx.HTTPError as exc:
            raise HarnessError(f"模型请求失败: {exc}") from exc
        if round_index >= max_attempts - 1 or streamed["any"]:
            # 重试用尽，或流式已有增量吐出（重发会重复渲染）
            if isinstance(last_exc, HarnessError):
                raise last_exc
            raise HarnessError(f"模型请求失败: {last_exc}") from last_exc
        wait = _retry_delay(round_index, retry_after)
        logger.warning(
            "harness: retryable model failure (attempt %d/%d): %s — retrying in %.1fs",
            round_index + 1, max_attempts, last_exc, wait,
        )
        if wait > 0:
            await asyncio.sleep(wait)
    logger.info(
        "harness model call: %s/%s tools=%s tool_choice=%s json_mode=%s thinking=%s",
        model["provider"], model["model"], bool(tools), tool_choice or "-", json_mode,
        level or "-",
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
    reasoning_only = False
    if not cleaned.strip():
        cleaned, fallback_reasoning, reasoning_only = _promote_reasoning(
            cleaned, message.get("reasoning_content")
        )
    if cleaned != raw_content or fallback_reasoning or reasoning_only:
        logger.info(
            "harness think-strip: %d -> %d chars (fallback_reasoning=%s reasoning_only=%s)",
            len(raw_content), len(cleaned), fallback_reasoning, reasoning_only,
        )
    return {
        "content": cleaned,
        "tool_calls": message.get("tool_calls") or [],
        "reasoning_stripped": bool(cleaned != raw_content) and not fallback_reasoning,
        "reasoning_fallback": fallback_reasoning,
        "reasoning_only": reasoning_only,
        # T96 事件日志用：剥思考前的正文原样与思维链原文（journal 落盘时再截长，
        # 业务路径不消费这两个字段；测试桩的固定返回形状不含它们也照常工作）
        "raw_content": raw_content,
        "reasoning_content": str(message.get("reasoning_content") or ""),
    }





# ---- T94 历史自动压缩：摘要调用与进程内缓存 ----

def _history_summary_cache_key(older: list, model: Dict[str, Any]) -> str:
    """缓存键＝sha1(待压缩历史 JSON + 模型名)：同历史同模型不重复摘要。

    模型名进键避免换模型后复用别的模型产出的摘要；`default=str` 兜住罕见的
    非 JSON 值，保证任意入参都能算键。"""
    payload = json.dumps(older, ensure_ascii=False, sort_keys=True, default=str) \
        + "|" + str(model.get("model") or "")
    return hashlib.sha1(payload.encode("utf-8")).hexdigest()


def _render_history_for_summary(older: list) -> str:
    """摘要器输入：逐条渲染旧历史（_history_block 的简版，不占编号窗口、不标最近）。"""
    lines = []
    for i, item in enumerate(older):
        if not isinstance(item, dict):
            continue
        if str(item.get("role") or "user") == "user":
            lines.append(f"{i + 1}. 用户：{str(item.get('instruction') or '')[:300]}")
            continue
        summary = str(item.get("summary") or "")
        ops = item.get("operations") or []
        op_desc = "；".join(
            f"{o.get('op')}({o.get('id') or o.get('temp_id') or o.get('label') or ''})"
            for o in ops[:20] if isinstance(o, dict)
        )
        lines.append(f"{i + 1}. 助手：{summary[:150]}" + (f"；操作：{op_desc[:200]}" if op_desc else ""))
    return "\n".join(lines)


async def _summarize_history(older: list, model: Dict[str, Any]) -> str:
    """一次便宜的历史摘要调用，返回 ≤HISTORY_SUMMARY_MAX_CHARS 的摘要正文。

    失败（HarnessError/空输出）由调用方捕获后降级回既有截断行为，绝不阻断主流程。
    model 副本清空 thinking——摘要不需要深思考，不该把推理档位的延迟/费用花在
    这里（档位只经 model dict 透传，_call_model 不加形参）。"""
    cache_key = _history_summary_cache_key(older, model)
    cached = _HISTORY_SUMMARY_CACHE.get(cache_key)
    if cached:
        return cached
    summary_model = dict(model)
    summary_model["thinking"] = ""
    messages = [
        {
            "role": "system",
            "content": (
                "你是 Φ 助手的对话摘要器。把以下多轮对话压缩成一段不超过 300 字的"
                "连贯摘要，保留用户定下的方案、指明的节点、明确的偏好与未完成事项。"
                "只输出摘要正文。"
            ),
        },
        {"role": "user", "content": _render_history_for_summary(older)},
    ]
    raw = await _call_model(messages, summary_model, HISTORY_SUMMARY_MAX_TOKENS)
    text = str((raw or {}).get("content") or "").strip()
    if not text:
        raise HarnessError("历史摘要输出为空")
    text = text[:HISTORY_SUMMARY_MAX_CHARS]
    if len(_HISTORY_SUMMARY_CACHE) >= _HISTORY_SUMMARY_CACHE_LIMIT:
        # 挤掉最旧一条（dict 保插入序）
        _HISTORY_SUMMARY_CACHE.pop(next(iter(_HISTORY_SUMMARY_CACHE)), None)
    _HISTORY_SUMMARY_CACHE[cache_key] = text
    return text


def _journal_history_compact(journal: Optional[list], covered: int, summary_chars: int) -> None:
    """T96 journal：历史压缩事件（覆盖条数与摘要字数），供观测压缩频率与效果。"""
    if journal is None:
        return
    try:
        journal.append({
            "stage": "history_compact",
            "covered": int(covered),
            "summary_chars": int(summary_chars),
        })
    except Exception:
        logger.debug("harness journal history_compact append failed", exc_info=True)


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


# ---- T96 会话事件日志：模型往返捕获（journal 由 api 层传入，None 时零开销） ----
# 每条 journal 记录一次真实模型调用的进与出。messages 只在首轮存全文——重试轮的
# 消息体 = 首轮 + retry_feedback 追加，存反馈文本即可无损重建，避免每轮重复背
# 一整份快照把日志撑大。长度上限按「够重放」取，超限截断并打标。
_JOURNAL_MESSAGE_CAP = 32000
_JOURNAL_RAW_CAP = 30000
_JOURNAL_REASONING_CAP = 8000


def _journal_raw_dict(raw: Dict[str, Any]) -> Dict[str, Any]:
    """模型原话（剥思考前的正文 + 思维链 + 工具调用），截长落盘。

    测试桩的 _call_model 返回不含 raw_content（固定形状），退回 content——
    桩路径本来也没有思考原文可记。"""
    content = raw.get("raw_content")
    if content is None:
        content = raw.get("content")
    content = str(content or "")
    reasoning = str(raw.get("reasoning_content") or "")
    return {
        "content": content[:_JOURNAL_RAW_CAP],
        "content_truncated": len(content) > _JOURNAL_RAW_CAP or None,
        "reasoning_content": reasoning[:_JOURNAL_REASONING_CAP],
        "reasoning_truncated": len(reasoning) > _JOURNAL_REASONING_CAP or None,
        "tool_calls": raw.get("tool_calls") or [],
    }


def _journal_roundtrip(
    journal: Optional[list],
    stage: str,
    raw: Dict[str, Any],
    attempt: int = 0,
    retry_feedback: str = "",
    fallback: str = "",
    messages: Optional[list] = None,
    step: Optional[int] = None,
) -> None:
    if journal is None:
        return
    entry: Dict[str, Any] = {"stage": stage, "attempt": attempt}
    if step is not None:
        entry["step"] = int(step)
    if fallback:
        entry["fallback"] = fallback
    if retry_feedback:
        entry["retry_feedback"] = str(retry_feedback)[:2000]
    if messages is not None:
        shaped = []
        for m in messages:
            content = str(m.get("content") or "")
            item = {"role": str(m.get("role") or ""), "content": content[:_JOURNAL_MESSAGE_CAP]}
            if len(content) > _JOURNAL_MESSAGE_CAP:
                item["content_truncated"] = True
            shaped.append(item)
        entry["messages"] = shaped
    entry["raw"] = _journal_raw_dict(raw)
    journal.append(entry)


def _should_selfcheck_ops(ops: list) -> bool:
    """小改动（≤3 条且无创建/删除节点）跳过模型批判自检，省一次串行模型调用。"""
    if len(ops) > 3:
        return True
    return any(
        isinstance(op, dict) and op.get("op") in ("create_node", "create_eval_node", "delete_node")
        for op in ops
    )


async def _selfcheck_ops(snapshot: Dict[str, Any], instruction: str, ops: list, model: Dict[str, Any], counter: Optional[Dict[str, int]] = None, journal: Optional[list] = None) -> Dict[str, Any]:
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
        _journal_roundtrip(journal, "selfcheck", raw)
        parsed = parse_selfcheck_tool(raw["tool_calls"])
        if parsed is not None:
            return parsed
        return parse_selfcheck(raw["content"])
    except HarnessError:
        try:
            _tick()
            raw = await _call_model(messages, model, 600, json_mode=_supports_json_mode(model["provider"]))
            _journal_roundtrip(journal, "selfcheck", raw, fallback="json_mode")
            return parse_selfcheck(raw["content"])
        except HarnessError:
            return {"ok": True, "issues": [], "missing": [], "error": "自检调用失败，已跳过"}


def _log_context_metrics(messages: list, snapshot: dict, phase: str,
                         history_entries: Optional[int] = None,
                         history_compacted: bool = False,
                         context_est_tokens: Optional[int] = None,
                         budget_tokens: Optional[int] = None) -> None:
    """Log per-request context sizes for the harness review/resolve endpoints.

    T94：新增历史预算字段（history_entries/history_compacted/context_est_tokens/
    budget_tokens）。既有字段与 resolve 调用点不变（新参全带默认值，不传时
    history_entries=0、context_est_tokens 取本函数自己的 est_tokens 估算）。"""
    try:
        sys_chars = sum(len(str(m.get("content") or "")) for m in messages if m.get("role") == "system")
        user_chars = sum(len(str(m.get("content") or "")) for m in messages if m.get("role") != "system")
        all_text = "".join(str(m.get("content") or "") for m in messages)
        actual_est = estimate_tokens(all_text)
        metrics = {
            "phase": phase,
            "nodes": len(snapshot.get("nodes") or []),
            "edges": len(snapshot.get("edges") or []),
            "snapshot_chars": len(json.dumps(snapshot, ensure_ascii=False)),
            "system_chars": sys_chars,
            "user_chars": user_chars,
            "est_tokens": actual_est,
            "history_entries": int(history_entries or 0),
            "history_compacted": bool(history_compacted),
            "context_est_tokens": int(context_est_tokens) if context_est_tokens is not None else actual_est,
            "budget_tokens": int(budget_tokens) if budget_tokens is not None else HARNESS_CONTEXT_BUDGET_TOKENS,
        }
        logger.info(
            "harness context: phase=%(phase)s nodes=%(nodes)d edges=%(edges)d snapshot_chars=%(snapshot_chars)d system_chars=%(system_chars)d user_chars=%(user_chars)d est_tokens=%(est_tokens)d history_entries=%(history_entries)d history_compacted=%(history_compacted)s context_est_tokens=%(context_est_tokens)d budget_tokens=%(budget_tokens)d",
            metrics,
        )
        return metrics
    except Exception:
        return None


# ---- T93 只读查询回灌：tool_call 归一化与批次判定 ----

def _tool_call_name_args(call: Any) -> tuple:
    """取一个 tool_call 的 (name, arguments dict)；参数串非法/非对象给空 dict。"""
    if not isinstance(call, dict):
        return "", {}
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(fn.get("name") or "").strip()
    raw_args = fn.get("arguments")
    if isinstance(raw_args, dict):
        return name, raw_args
    text = str(raw_args or "").strip()
    if not text:
        return name, {}
    try:
        args = json.loads(text)
    except (json.JSONDecodeError, ValueError, TypeError):
        args = repair_json(raw_args)
    return name, args if isinstance(args, dict) else {}


def _readonly_batch(tool_calls: Any) -> list:
    """本批 tool_calls 里的只读查询调用；空列表＝无需进入查询循环。"""
    if not isinstance(tool_calls, list):
        return []
    batch = []
    for call in tool_calls:
        name, _args = _tool_call_name_args(call)
        if name in READONLY_TOOL_NAMES:
            batch.append(call)
    return batch


def _assistant_tool_message(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把模型输出归一化成 assistant 回声消息（tool_calls 形状与回灌一致）。

    id 缺失时补 call_<n>——role:"tool" 消息的 tool_call_id 必须与它逐条对上，
    否则上游/网关会拒整段对话。"""
    calls = raw.get("tool_calls") if isinstance(raw, dict) else None
    shaped = []
    for index, call in enumerate(calls or []):
        if not isinstance(call, dict):
            call = {}
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        args = fn.get("arguments")
        if not isinstance(args, str):
            args = json.dumps(args if args is not None else {}, ensure_ascii=False)
        shaped.append({
            "id": str(call.get("id") or f"call_{index + 1}"),
            "type": "function",
            "function": {
                "name": str(fn.get("name") or ""),
                "arguments": args,
            },
        })
    return {
        "role": "assistant",
        "content": str((raw or {}).get("content") or ""),
        "tool_calls": shaped,
    }


def _readonly_call_arg(name: str, args: Dict[str, Any]) -> str:
    """进度事件里的查询参数预览（read_node/list_neighbors 取节点，search 取词）。"""
    key = "keyword" if name == "search_nodes" else "node_id"
    return str(args.get(key) or args.get("id") or args.get("label") or "")[:60]


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
    journal: Optional[list] = None,
    thinking: str = "",
    fallback_models=None,
) -> Dict[str, Any]:
    """Review the snapshot and return validated graph operations.

    mode: "tools" (force function calling), "json" (force free-form JSON),
    or "auto" (try tools, fall back to JSON when the provider rejects them).

    progress: 可选回调（dict 事件），流式请求时由 api 层传入；事件两类——
    {"type":"status","stage":...,"message":...} 阶段进度、
    {"type":"delta","text":...} 模型正文增量。不传则零开销。

    journal: 可选 list（T96 事件日志），每次模型调用的往返（messages 原文、
    模型原话、tool_calls）按序 append，由 api 层随事件落盘。不传则零开销，
    测试桩/battery 直调路径行为不变。

    thinking: 可选推理档位覆盖（T97；''/low/high/max）。优先于模型条目自带
    档位与相位默认（PHASE_THINKING：evaluate/preset/apply=high、chat=low、
    normal/expand 不发参数），只传给本函数内解析出的 model dict。

    fallback_models: 可选备用模型列表（T95，前端用户开关开启时才随 payload
    传来），至多 2 个 {provider, api_key, model, base_url}。主模型调用抛
    HarnessError 且错误值得换模型（401/408/429/5xx/网络类，400 不换）时依序
    切换候选，重开完整 attempt 循环；换上的候选在结果里走 fallback_used 字段，
    并给 journal 追一条 stage="fallback" 条目。非 list/无有效项 → 不启用。

    T93 查询回灌：工具表含只读查询工具（normal/expand/apply/preset）时，模型可
    先调用 read_node/list_neighbors/search_nodes，后端对完整快照执行查询并以
    role:"tool" 消息回灌，模型看完结果再出编辑方案；最多 MAX_TOOL_STEPS 步，
    到顶后剥掉只读工具并明示直接出方案。同批混入的编辑调用不执行，只回
    {"deferred": true} 让模型单独重发。chat/evaluate 保持单轮。
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

    def _consume_model_output(raw_dict: Dict[str, Any]) -> tuple:
        """把一次模型输出剥成 (正文, 只出思维链标记)；幂等，查询循环每轮复用。"""
        text = strip_reasoning(raw_dict.get("content") or "")
        only = bool(raw_dict.get("reasoning_only"))
        if not text.strip() and raw_dict.get("reasoning_content"):
            # 正文为空时回退 reasoning_content——与 _call_model 共用同一门槛
            # （_promote_reasoning）：剥掉思考标签后能解析出 JSON 才算模型正式
            # 输出；裸散文式思维链不回退（2026-09-30）
            text, promoted, prose_only = _promote_reasoning(text, raw_dict["reasoning_content"])
            if promoted:
                reasoning_seen["hit"] = True
            only = only or prose_only
        if raw_dict.get("reasoning_stripped") or raw_dict.get("reasoning_fallback") or only:
            reasoning_seen["hit"] = True
        return text, only

    # T93：只读查询的取数源＝归一化后的完整快照（未做焦点收缩/正文压缩）。
    # 必须独立 normalize 一次——_compact_snapshot 会原地裁剪节点正文，与 current
    # 共用同一批 dict 会把「全文」提前压掉，read_node 就取不回目录行的全文了。
    full_snapshot = normalize_snapshot(snapshot)
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
    _apply_thinking_default(resolved_model, thinking, phase)
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
        if phase == "preset":
            return build_preset_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
        if phase == "chat":
            # 答疑模式（三模式切换器）：normal 提示词 + 只读红线段；
            # 工具表同 normal，解析路径完全同构
            messages = build_review_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)
            messages[0]["content"] += HARNESS_CHAT_REDLINE
            return messages
        return build_review_messages(current, instruction, retry_errors, full_context, level, focus_node_ids)

    # ---- T94 上下文预算与自动压缩（评审路线 #9）----
    # 每请求一次，且在首个 attempt 构建 messages 之前（重试轮与换模型候选不重复
    # 压缩）。触发＝条数超阈值 或 system+user 提示词（含历史块）估算超预算；
    # 触发后把更早的多轮历史摘要成一条，修复长会话后期「早期定下的方案被 6 条
    # 窗口滚掉」的失忆。摘要失败降级回既有截断行为，绝不阻断。
    history = list(history) if isinstance(history, (list, tuple)) else []

    def _probe_context_est(hist: list) -> int:
        """探针预算估算：messages_for_attempt("") 纯字符串拼接 + 历史块，不调模型。"""
        try:
            probe = messages_for_attempt("")
        except Exception:
            return 0
        parts = [
            str(m.get("content") or "")
            for m in probe
            if isinstance(m, dict) and m.get("role") in ("system", "user")
        ]
        block = _history_block(hist)
        if block:
            parts.append(block)
        return estimate_tokens("".join(parts))

    context_est = _probe_context_est(history)
    history_compacted = False
    if history and (
        len(history) > HISTORY_COMPACT_TRIGGER_ENTRIES
        or context_est > HARNESS_CONTEXT_BUDGET_TOKENS
    ):
        older = history[:-HISTORY_KEEP_RECENT] if len(history) > HISTORY_KEEP_RECENT else []
        recent = history[-HISTORY_KEEP_RECENT:]
        summary_entry: Optional[Dict[str, Any]] = None
        if older:
            try:
                summary_text = await _summarize_history(older, resolved_model)
            except Exception as exc:
                # 摘要失败绝不阻断：保持原 history，退回首轮起就有的
                # 「最近 6 条详细 + 更早一行」截断行为
                logger.warning("harness: history compact failed, fallback to truncation: %s", exc)
                summary_text = ""
            if summary_text:
                summary_entry = {
                    "role": "compact_summary",
                    "summary": summary_text,
                    "covered": len(older),
                }
        if summary_entry is not None:
            history = [summary_entry] + recent
            history_compacted = True
            # T96 journal：压缩事件（覆盖条数与摘要字数），观测压缩频率与效果
            _journal_history_compact(journal, len(older), len(str(summary_entry["summary"])))
            context_est = _probe_context_est(history)
            if context_est > HARNESS_CONTEXT_BUDGET_TOKENS and len(history) > _HISTORY_HARD_KEEP + 1:
                # 压缩后仍超预算（快照/system 本身过大）：硬截到「摘要 + 最近 4 条」
                history = [summary_entry] + history[-_HISTORY_HARD_KEEP:]
                context_est = _probe_context_est(history)
        elif not older:
            # 没有更早条目可摘要（条数不多、纯预算超）：直接硬截到最近 4 条
            history = history[-_HISTORY_HARD_KEEP:]
            context_est = _probe_context_est(history)

    # ---- T95 上游容错：主模型失败且值得换模型时，依序尝试备用候选 ----
    # fallback_models 只在用户开关开启时随 payload 出现（api 层已清洗），
    # primary 在候选链首位；内层 attempt 循环成功路径全部直接 return，天然
    # 短路；HarnessError 逃出主循环后由下方 except 判定是否降级到下一候选。
    fallback_candidates = _sanitize_fallback_models(fallback_models) or []
    candidate_count = 1 + len(fallback_candidates)
    fallback_used: Optional[Dict[str, str]] = None
    last_error: Optional[HarnessError] = None
    for candidate_index in range(candidate_count):
        if candidate_index > 0:
            candidate = fallback_candidates[candidate_index - 1]
            try:
                switched = _resolve_model(candidate)
            except HarnessError as cfg_exc:
                # 候选配置非法（未知 provider 且无 base_url、远程端点非 https
                # 等）＝不是可运行的模型：发提示并跳过，继续试下一个候选
                _emit({
                    "type": "status",
                    "stage": "fallback",
                    "message": f"⚠ 备用模型 {candidate.get('model') or '?'} 配置不可用，已跳过：{cfg_exc}",
                    "attempt": 0,
                })
                _journal_fallback(journal, resolved_model, candidate, cfg_exc)
                continue
            _apply_thinking_default(switched, thinking, phase)
            _emit({
                "type": "status",
                "stage": "fallback",
                "message": f"⚠ {resolved_model.get('model') or '主模型'} 调用失败，尝试备用模型 {switched.get('model') or '?'}…",
                "attempt": 0,
            })
            _journal_fallback(journal, resolved_model, switched, last_error)
            resolved_model = switched
            provider = resolved_model["provider"]
            fallback_used = {"provider": switched["provider"], "model": switched["model"]}
            # 新候选重开完整 attempt 循环：清空上一候选的原始输出与校验反馈
            last_errors = []
            last_raw = ""

        # per-candidate 派生：工具强制/JSON 模式随 provider 能力变化，换模型必须重算
        tools = build_tools(phase) if mode in ("auto", "tools") else None
        can_require = _supports_required_tool_choice(provider)
        if not tools:
            tool_choice = None
        elif phase == "chat":
            # 答疑模式：工具表照给（与 normal 同构）但永不强制调用——
            # 强制只会逼模型硬产出操作，与「只说不改」的红线相悖
            tool_choice = "auto"
        elif phase in ("expand", "evaluate", "apply", "preset"):
            tool_choice = "required" if can_require else "auto"
        else:
            tool_choice = "required" if (_has_edit_intent(instruction) and can_require) else "auto"
        json_mode = _supports_json_mode(provider) if mode != "tools" else False
        try:
            for attempt in range(retries + 1):
                attempt_feedback = _summarize_errors(last_errors) if attempt > 0 else ""
                messages = messages_for_attempt(attempt_feedback)
                current_tools = list(tools) if tools else None
                current_choice = tool_choice if current_tools else None
                current_json = json_mode if not current_tools else False
                # T93：本相位工具表里是否有只读查询工具（chat/evaluate 没有，
                # 走不到查询回灌；只读名混进最终批次仍由 parse_tool_calls 兜底）
                readonly_enabled = bool(current_tools) and any(
                    schema.get("function", {}).get("name") in READONLY_TOOL_NAMES
                    for schema in current_tools
                )
                if current_tools:
                    messages[-1]["content"] += (TOOLS_AUTO_HINT if tool_choice == "auto" else TOOLS_USER_HINT)
                    if readonly_enabled:
                        messages[-1]["content"] += READONLY_TOOLS_HINT
                history_text = _history_block(history)
                if history_text:
                    messages[-1]["content"] += history_text
                if attempt == 0:
                    context_metrics = _log_context_metrics(
                        messages, current, phase,
                        history_entries=len(history),
                        history_compacted=history_compacted,
                        context_est_tokens=context_est,
                        budget_tokens=HARNESS_CONTEXT_BUDGET_TOKENS,
                    ) or context_metrics

                # attempt 供前端重置流式预览：每轮都重新挂 on_delta，若前端只追加不重置，
                # 第 2/3 轮的残文会接在第 1 轮后面（T87）。只加字段，不动文案与结构。
                # step=0：查询回灌轮从 1 起递增（T93），前端用 attempt>0 || step>0 重置预览。
                _emit({
                    "type": "status",
                    "stage": "model",
                    "attempt": attempt,
                    "step": 0,
                    "message": "正在思考方案…" if attempt == 0
                    else f"正在根据校验反馈修正方案（第 {attempt + 1} 轮）…",
                })
                # on_delta 只在流式请求（progress 存在）时附带：测试桩/battery 的
                # _call_model 桩是固定签名，多余的 kwargs 会让它们直接抛 TypeError
                model_kwargs: Dict[str, Any] = {}
                if progress is not None:
                    model_kwargs["on_delta"] = lambda chunk: _emit({"type": "delta", "text": chunk})
                # T96 journal：记录本调用的降级形态（required→auto / tools→json），
                # 成功返回后统一落一条往返
                journal_fallback = ""
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
                            journal_fallback = "tool_choice_auto"
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
                            messages[-1]["content"] = messages[-1]["content"].replace(TOOLS_USER_HINT, "").replace(TOOLS_AUTO_HINT, "").replace(READONLY_TOOLS_HINT, "")
                            journal_fallback = "json_mode"
                            raw = await _counted_call(
                                messages,
                                resolved_model,
                                max_tokens,
                                json_mode=_supports_json_mode(provider),
                                **model_kwargs,
                            )
                    else:
                        raise
                _journal_roundtrip(
                    journal, "generate", raw,
                    attempt=attempt,
                    retry_feedback=attempt_feedback,
                    fallback=journal_fallback,
                    # 首轮主路径存 messages 全文；降级/重试轮的消息体可由首轮+反馈重建
                    messages=messages if attempt == 0 and not journal_fallback else None,
                )

                # 消费端再剥一次（幂等）：即使 _call_model 未经过（测试桩/旧路径）也能兜住
                _emit({"type": "status", "stage": "validate", "message": "方案已生成，正在校验操作…"})
                last_raw, reasoning_only_seen = _consume_model_output(raw)

                # ---- T93 只读查询回灌循环：模型先查图，看完了再决定改哪 ----
                # 仅当工具表含只读工具（normal/expand/apply/preset）时启用；
                # 查询轮不走 tools→json 降级链（对话已建立，中途降级无意义），
                # HarnessError 直接抛给外层换模型候选链接住。
                if journal_fallback == "json_mode":
                    # 本调用已降级到自由 JSON（无工具通道），查询回灌一并关闭；
                    # 若模型仍吐出只读 tool_calls，由 parse_tool_calls 的错误软重试兜底
                    readonly_enabled = False
                tool_steps = 0
                readonly_calls = _readonly_batch(raw.get("tool_calls")) if readonly_enabled else []
                while readonly_calls:
                    assistant_msg = _assistant_tool_message(raw)
                    messages.append(assistant_msg)
                    batch_results = []
                    for call in assistant_msg["tool_calls"]:
                        name, args = _tool_call_name_args(call)
                        if name in READONLY_TOOL_NAMES:
                            tool_steps += 1
                            _emit({
                                "type": "status",
                                "stage": "tool",
                                "message": "🔎 查询图中信息：" + name + "(" + _readonly_call_arg(name, args) + ")",
                                "attempt": attempt,
                                "step": tool_steps,
                            })
                            output = execute_readonly_tool(name, args, full_snapshot)
                            text = json.dumps(output, ensure_ascii=False)
                            ok = not (isinstance(output, dict) and output.get("error"))
                            if len(text) > _TOOL_RESULT_CHARS:
                                text = text[:_TOOL_RESULT_CHARS] + "…（结果过长已截断）"
                        else:
                            # 同批混入的编辑类调用：统一下发「已暂存」结果，绝不执行；
                            # 模型须在看完查询结果后单独重发编辑方案
                            text = json.dumps(_DEFERRED_TOOL_RESULT, ensure_ascii=False)
                            ok = False
                        messages.append({
                            "role": "tool",
                            "tool_call_id": str(call.get("id") or ""),
                            "content": text,
                        })
                        batch_results.append({
                            "id": str(call.get("id") or ""),
                            "name": name,
                            "ok": ok,
                            "chars": len(text),
                        })
                    if journal is not None:
                        # 查询轮条目：stage 仍 generate，带 step 与 tool_results；
                        # messages 只在 attempt 首轮存过，这里不再重复存
                        journal.append({
                            "stage": "generate",
                            "attempt": attempt,
                            "step": tool_steps,
                            "tool_results": batch_results,
                        })
                    if tool_steps >= MAX_TOOL_STEPS:
                        # 步数上限：剥掉只读工具并明示，之后模型只能出编辑方案
                        readonly_enabled = False
                        current_tools = [
                            schema for schema in (current_tools or [])
                            if schema.get("function", {}).get("name") not in READONLY_TOOL_NAMES
                        ] or None
                        current_choice = tool_choice if current_tools else None
                        messages.append({"role": "user", "content": _TOOL_STEP_LIMIT_NOTICE})
                    _emit({
                        "type": "status",
                        "stage": "model",
                        "attempt": attempt,
                        "step": tool_steps,
                        "message": f"已获得查询结果，正在继续思考方案（第 {tool_steps} 步）…",
                    })
                    raw = await _counted_call(
                        messages,
                        resolved_model,
                        max_tokens,
                        tools=current_tools,
                        tool_choice=current_choice,
                        json_mode=False,
                        **model_kwargs,
                    )
                    _journal_roundtrip(
                        journal, "generate", raw,
                        attempt=attempt, step=tool_steps, messages=None,
                    )
                    last_raw, reasoning_only_seen = _consume_model_output(raw)
                    readonly_calls = _readonly_batch(raw.get("tool_calls")) if readonly_enabled else []

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
                        if not summary.strip() and reasoning_only_seen:
                            # 正文为空且只产出裸思维链（不提升为正文，2026-09-30）：
                            # 给明确提示，不把推理散文当回复，也不让面板沉默
                            summary = "模型这一轮只输出了思考过程，没有给出正式回复，请重试或换个说法。"
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
                            clarify_result = {
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
                            if fallback_used:
                                clarify_result["fallback_used"] = dict(fallback_used)
                            return clarify_result

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

                if phase == "preset":
                    # 创造模式（P3）：只放行配方三件套＋「放一个试试」的配方实例 create_node；
                    # 模型若跑偏去改普通图节点，带反馈重试而不是静默丢弃
                    preset_ops = [
                        op for op in raw_ops
                        if isinstance(op, dict) and (
                            op.get("op") in ("create_recipe", "update_recipe", "delete_recipe")
                            or (op.get("op") == "create_node" and str(op.get("recipe_id") or op.get("recipeId") or ""))
                        )
                    ]
                    dropped = len(raw_ops) - len(preset_ops)
                    if dropped:
                        last_errors = [{
                            "index": "phase",
                            "op": "preset",
                            "reason": f"创造模式只允许配方操作（create_recipe / update_recipe / delete_recipe / 带 recipe_id 的 create_node），本次丢弃了 {dropped} 个越权图操作",
                        }]
                        continue
                    raw_ops = preset_ops
                if phase == "chat":
                    # 答疑模式保险丝：红线 prompt 失效时的服务端兜底——图操作一律清空，
                    # 不带反馈重试（答疑本就不该产出操作）；summary 里注明，避免「嘴上说改了」
                    if raw_ops:
                        summary = (str(summary or "") + "\n\n（答疑模式不改图：已忽略其中的图操作，需要修改请切回「编辑」模式）").strip()
                        raw_ops = []
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
                    critic = await _selfcheck_ops(
                        current, instruction, raw_ops, resolved_model, counter=call_counter,
                        **({"journal": journal} if journal is not None else {}),
                    )
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
                # T95：记录本次成功靠的是哪个备用模型（观测换模型率；api 事件落盘）
                if fallback_used:
                    result["fallback_used"] = dict(fallback_used)
                return result

            parse_failure = {
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
            if fallback_used:
                parse_failure["fallback_used"] = dict(fallback_used)
            return parse_failure
        except HarnessError as exc:
            last_error = exc
            if candidate_index + 1 >= candidate_count or not _fallback_worthy(exc):
                # 400 等确定性失败换谁都没用；没有更多候选也只能原样抛出
                # （保持 api 层错误协议：HarnessError → 502 结构化 body）
                raise

    if last_error is None:  # pragma: no cover - 有候选时上面必然先 return 或先 raise
        raise HarnessError("模型调用失败")
    raise last_error


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
