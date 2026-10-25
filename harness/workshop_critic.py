"""节点工坊 C3：内容初筛评分（2026-10-25）。

体检（前端 _rwJudgeOutput）是纯形式判定——语义错误但格式漂亮的输出照样
「结构正常」（A/B 检验在案的盲区，docs/日志/2026-10-25.md「工坊 A/B 检验」
节末「范围提醒」）。C3 在结构体检通过后花一次模型调用，从内容维度评一遍：
答没答材料里的问题／事实与公式有没有编造／有没有空话套话／深度是否匹配材料。

边界（拍板，见 docs/dev/harness.md C3 节）：
- **不带 tools**——critic 不许调工具，与 /workshop/step 的「代理＋工具表」职责
  分开（那边工具在浏览器执行，这边根本不该有工具）；
- **坏回包降级不是报错**：模型没回合法 JSON／verdict 不认识 → warn＋score:-1
  （前端据此说「这次没评上」），主流程不因 critic 挂掉而断；上游传输层故障
  （HarnessError）照常上抛走 502 协议——降级只兜「模型回了但回包形状坏」；
- **只评一次**：发现问题至多由前端触发一轮既有补丁管道＋复跑（仍受 2 次试跑
  总闸），本层不做多轮评分。
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from .json_utils import extract_json
from .prompts import HARNESS_WORKSHOP_CRITIC_SYSTEM_PROMPT
from .review import HarnessError, _apply_thinking_default, _call_model, _resolve_model

logger = logging.getLogger(__name__)

# 评分回包很小（verdict/score/≤5 条 issues/say），900 默认＋1200 封顶足够
WORKSHOP_CRITIC_MAX_TOKENS = 900
WORKSHOP_CRITIC_TOKENS_CEILING = 1200
# 入参截断：试跑输出带公式与分步、全文较长，1.2 万字符够初筛读全貌
WORKSHOP_CRITIC_OUTPUT_MAX_CHARS = 12000
WORKSHOP_CRITIC_MATERIALS_MAX_CHARS = 2400
WORKSHOP_CRITIC_NAME_MAX = 80
# 清洗上限（与 recipe_draft 的 QUESTION_TEXT/SAY 截断同风格）
WORKSHOP_CRITIC_ISSUES_MAX = 5
WORKSHOP_CRITIC_ISSUE_KIND_MAX = 24
WORKSHOP_CRITIC_ISSUE_DETAIL_MAX = 160
WORKSHOP_CRITIC_SAY_MAX = 160


def _degrade_result() -> Dict[str, Any]:
    """没拿到合法评分：warn＋score:-1（降级不是报错，前端据此说「这次没评上」）。"""
    return {"status": "ok", "verdict": "warn", "score": -1, "issues": [], "say": "这次评分没拿到，跳过"}


def _clamp_score(raw: Any) -> int:
    """score 越界钳到 [0,10]；不是数字落 0（分数只是参考，行为看 verdict）。"""
    try:
        value = int(round(float(raw)))
    except (TypeError, ValueError):
        return 0
    return max(0, min(10, value))


def _clean_issues(raw: Any) -> List[Dict[str, str]]:
    """issues 清洗：只留 detail 非空的 {kind, detail}，至多 5 条，多余键剥掉。"""
    out: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for item in raw:
        if len(out) >= WORKSHOP_CRITIC_ISSUES_MAX:
            break
        if not isinstance(item, dict):
            continue
        detail = str(item.get("detail") or item.get("issue") or "").strip()[:WORKSHOP_CRITIC_ISSUE_DETAIL_MAX]
        if not detail:
            continue
        kind = str(item.get("kind") or "问题").strip()[:WORKSHOP_CRITIC_ISSUE_KIND_MAX] or "问题"
        out.append({"kind": kind, "detail": detail})
    return out


def _clean_say(raw: Any, verdict: str, issue_count: int) -> str:
    """say 只留第一行自然语言（≤160 字）；模型没给就按判决补一句人话。"""
    text = str(raw or "").strip()
    if text:
        return text.splitlines()[0].strip()[:WORKSHOP_CRITIC_SAY_MAX]
    if verdict == "pass":
        return "内容初筛：未发现问题"
    if verdict == "fail":
        return f"内容初筛：发现 {issue_count} 处问题"
    return f"内容初筛：有几处拿不太准（{issue_count} 处）" if issue_count else "内容初筛：有点拿不太准"


def build_workshop_critic_messages(output: str, recipe_name: str, materials_summary: str) -> list:
    user = "\n\n".join([
        f"配方名：{recipe_name or '（未命名）'}",
        f"试跑材料摘要：\n{materials_summary or '（空）'}",
        f"试跑输出全文：\n{output}",
        "按系统提示词只输出那一个 JSON 对象。",
    ])
    return [
        {"role": "system", "content": HARNESS_WORKSHOP_CRITIC_SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


async def workshop_critic_call(
    output: Any,
    recipe_name: Any = "",
    materials_summary: Any = "",
    model: Any = None,
    thinking: str = "",
    max_tokens: Any = None,
) -> Dict[str, Any]:
    """一次内容初筛评分：返回 {status, verdict, score, issues, say}（清洗后）。"""
    output_text = str(output or "").strip()
    if not output_text:
        # 没输出可评＝没评上：降级，不白烧一次模型调用（实际链路上体检已保 ≥120 字）
        return _degrade_result()
    resolved = _resolve_model(model)
    _apply_thinking_default(resolved, str(thinking or ""), "preset")
    try:
        tokens = int(max_tokens or WORKSHOP_CRITIC_MAX_TOKENS)
    except (TypeError, ValueError):
        tokens = WORKSHOP_CRITIC_MAX_TOKENS
    tokens = max(256, min(tokens, WORKSHOP_CRITIC_TOKENS_CEILING))
    messages = build_workshop_critic_messages(
        output_text[:WORKSHOP_CRITIC_OUTPUT_MAX_CHARS],
        str(recipe_name or "").strip()[:WORKSHOP_CRITIC_NAME_MAX],
        str(materials_summary or "").strip()[:WORKSHOP_CRITIC_MATERIALS_MAX_CHARS],
    )
    # HarnessError（上游传输层故障）照常上抛→路由 502；回包形状坏才降级
    reply = await _call_model(messages, resolved, tokens, json_mode=True)
    payload = extract_json(str(reply.get("content") or ""))
    if isinstance(payload, list) and payload:
        payload = payload[0]
    if not isinstance(payload, dict):
        logger.info("workshop critic: model returned no JSON (%d chars)", len(str(reply.get("content") or "")))
        return _degrade_result()
    verdict = str(payload.get("verdict") or "").strip().lower()
    if verdict not in ("pass", "warn", "fail"):
        logger.info("workshop critic: bad verdict %r -> degrade", payload.get("verdict"))
        return _degrade_result()
    issues = _clean_issues(payload.get("issues"))
    score = _clamp_score(payload.get("score"))
    say = _clean_say(payload.get("say") or payload.get("summary"), verdict, len(issues))
    logger.info("workshop critic: verdict=%s score=%d issues=%d", verdict, score, len(issues))
    return {"status": "ok", "verdict": verdict, "score": score, "issues": issues, "say": say}
