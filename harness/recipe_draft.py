"""节点工坊草稿接口（2026-10-20，创造模式重做 P1/P2）。

设计文档：docs/archive/创造模式重做计划-2026-10-20.md（3.4 节「对话：补丁式，不是重写式」）。

与 Φ 的 preset 相位彻底分开：那条链路产的是「配方 + 图操作清单」，要过 ops 白名单与
画布快照；工坊只要一份**配方草稿**——不碰画布、不产操作、不写配方库。

核心是三步（顺序不能反）：
  ① 深合并：模型返回的 recipe 只是补丁，数组整体替换、null 删键、缺的字段保留旧值；
  ② 归一化：过 ``normalize_recipe_input``（与前端同构的唯一白名单）；
  ③ 校验：过 ``validate_recipe``，错误按字段挂回去（``field_errors``）。
弱模型漏字段时①保住用户已确定的部分（T79 的洞），脏字段在②被剥掉，③给出人话定位。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Optional

from .json_utils import extract_json
from .prompts import build_recipe_draft_messages
from .recipes import normalize_recipe_input, validate_recipe
from .review import HarnessError, _apply_thinking_default, _call_model, _resolve_model

logger = logging.getLogger(__name__)

# 一份配方草稿的 JSON 体量很小（<8KB），1800 够写满所有提示词槽再留余量
DRAFT_MAX_TOKENS = 1800
QUESTION_TEXT_MAX = 120
SAY_MAX = 160


def deep_merge(base: Any, patch: Any) -> Any:
    """配方补丁合并：字典递归、数组整体替换、null＝删除该键。"""
    if isinstance(base, dict) and isinstance(patch, dict):
        out = dict(base)
        for key, value in patch.items():
            if value is None:
                out.pop(key, None)
            else:
                out[key] = deep_merge(out.get(key), value)
        return out
    return patch


def _leaf(value: Any) -> str:
    """叶子值比口径：一律 JSON 文本化（列表/字典按整段比，顺序敏感）。"""
    try:
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        return repr(value)


def flatten_recipe(value: Any, prefix: str = "", out: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """把配方展平成 {路径: 叶子串}，用来算「这次改了哪些字段」。

    字典逐层展开；**对象数组**按下标展开（元素下标路径），这样「只改第二个出口」
    能被前端精确高亮；标量数组与标量按整体比。
    """
    if out is None:
        out = {}
    if isinstance(value, dict):
        for key, item in value.items():
            path = f"{prefix}.{key}" if prefix else str(key)
            flatten_recipe(item, path, out)
        return out
    if isinstance(value, list) and value and all(isinstance(item, dict) for item in value):
        for index, item in enumerate(value):
            flatten_recipe(item, f"{prefix}[{index}]", out)
        return out
    out[prefix] = _leaf(value)
    return out


def changed_fields(before: Any, after: Any) -> List[str]:
    """两次草稿之间变了哪些字段（路径列表，稳定排序）。"""
    left = flatten_recipe(before or {})
    right = flatten_recipe(after or {})
    keys = set(left) | set(right)
    return sorted(key for key in keys if left.get(key) != right.get(key))


# 校验错误 → 字段路径。validate_recipe 是人话报错（前后端同构的唯一事实源），
# 这里只做「这句话说的是哪个字段」的翻译，绝不另起一套判定——判定仍归校验器。
def _field_path_for_error(message: str, recipe: Optional[dict]) -> str:
    text = str(message or "")
    if not text:
        return ""
    if text.startswith("名称不能为空") or text.startswith("名称最长") or text.startswith("已有同名配方"):
        return "name"
    if text.startswith("底座类型"):
        return "base.kind"
    if text.startswith("色板不合法"):
        return "appearance.palette"
    if text.startswith("自定义颜色不合法"):
        return "appearance.color"
    if text.startswith("形状不合法"):
        return "appearance"
    if text.startswith("描述最长"):
        return "desc"
    if text.startswith("提示词槽「"):
        slot = text.split("「", 1)[1].split("」", 1)[0] if "「" in text else ""
        return f"generate.{slot}" if slot else "generate"
    if text.startswith("AI 底座必须填写主提示词"):
        return "generate.prompt"
    if text.startswith("上下文通道不合法"):
        return "generate.context_channel"
    if text.startswith("模型槽位不合法"):
        return "generate.model_role"
    if text.startswith("出口最多") or text.startswith("存在没有名字的出口") or text.startswith("出口名字重复"):
        return "ports.static"
    if text.startswith("出口「"):
        label = text.split("「", 1)[1].split("」", 1)[0]
        ports = ((recipe or {}).get("ports") or {}).get("static") or []
        for index, port in enumerate(ports):
            if isinstance(port, dict) and str(port.get("label") or "") == label:
                if "拖出目标" in text:
                    return f"ports.static[{index}].drag_form"
                if "类型不合法" in text:
                    return f"ports.static[{index}].type"
                return f"ports.static[{index}].label"
        return "ports.static"
    if text.startswith("输入端口「"):
        label = text.split("「", 1)[1].split("」", 1)[0]
        ports = ((recipe or {}).get("ports") or {}).get("inputs") or []
        for index, port in enumerate(ports):
            if isinstance(port, dict) and str(port.get("label") or "") == label:
                return f"ports.inputs[{index}].type" if "类型不合法" in text else f"ports.inputs[{index}].label"
        return "ports.inputs"
    if text.startswith("输入端口"):
        return "ports.inputs"
    if text.startswith("动态出口"):
        return "ports.dynamic"
    if text.startswith("内容载体不合法") or text.startswith("mermaid / html_iframe"):
        return "content_kind"
    if text.startswith("单链取材"):
        return "aggregation"
    if text.startswith("双阶段概要"):
        return "analysis_phase"
    if text.startswith("生成后"):
        return "on_generated"
    return ""


def _sanitize_question(raw: Any) -> Optional[dict]:
    """模型的一个追问：{field, text}。字段路径只做提示用，文本截断防长文灌进气泡。"""
    if not isinstance(raw, dict):
        return None
    text = str(raw.get("text") or raw.get("question") or raw.get("say") or "").strip()
    if not text:
        return None
    return {"field": str(raw.get("field") or raw.get("path") or "").strip()[:80], "text": text[:QUESTION_TEXT_MAX]}


def _sanitize_say(raw: Any) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    # 模型偶尔把 JSON 塞进 say：只留第一行自然语言，避免气泡里出现一坨数据
    return text.splitlines()[0].strip()[:SAY_MAX]


def _error_result(say: str, base: Optional[dict], mode: str, retry: bool = False) -> dict:
    return {
        "status": "error",
        "say": say,
        "recipe": base,
        "changed": [],
        "question": None,
        "warnings": [],
        "field_errors": [],
        "mode": mode,
        "retry": bool(retry),
    }


async def draft_recipe(
    instruction: str,
    draft: Any = None,
    model: Any = None,
    mode: str = "patch",
    history: Any = None,
    user_recipes: Any = None,
    level: str = "",
    thinking: str = "",
    max_tokens: Any = None,
) -> dict:
    """产一份配方草稿补丁（P1 起稿 / P2 补丁共用一条通道）。"""
    mode = "draft" if str(mode or "").strip().lower() == "draft" else "patch"
    base = normalize_recipe_input(draft) if isinstance(draft, dict) else None
    if mode == "draft":
        base = None
    resolved = _resolve_model(model)
    _apply_thinking_default(resolved, str(thinking or ""), "preset")
    messages = build_recipe_draft_messages(
        instruction=instruction,
        draft=base,
        mode=mode,
        history=history,
        user_recipes=user_recipes,
        level=level,
    )
    try:
        reply = await _call_model(
            messages,
            resolved,
            int(max_tokens or DRAFT_MAX_TOKENS),
            json_mode=True,
        )
    except HarnessError:
        raise
    payload = extract_json(str(reply.get("content") or ""))
    if isinstance(payload, list) and payload:
        payload = payload[0]
    if not isinstance(payload, dict):
        logger.info("recipe draft: model returned no JSON (%d chars)", len(str(reply.get("content") or "")))
        return _error_result(
            "模型这次没有按要求的格式回话，请再说一遍（或换个模型）。",
            base,
            mode,
            retry=True,
        )
    say = _sanitize_say(payload.get("say") or payload.get("summary"))
    patch = payload.get("recipe")
    if patch is None:
        patch = payload.get("patch")
    if patch is None:
        patch = payload.get("draft")
    if isinstance(patch, str):
        patch = extract_json(patch)   # 模型偶尔把 recipe 写成 JSON 字符串
    if not isinstance(patch, dict):
        patch = {}
    question = _sanitize_question(payload.get("question"))
    warnings: List[str] = []
    if not patch:
        if base is None:
            return _error_result(
                say or "想先确认一下：这个节点主要拿来做什么？喂什么材料、想要几个出口？",
                None,
                mode,
            )
        # 只回一句话（回答用户提问/追问）：草稿原样保留，改动为空
        return {
            "status": "ok",
            "say": say or "好的。",
            "recipe": base,
            "changed": [],
            "question": question,
            "warnings": [],
            "field_errors": [],
            "mode": mode,
        }
    merged = deep_merge(base or {}, patch) if base else dict(patch)
    normalized = normalize_recipe_input(merged)
    if normalized is None:
        # 连归一化都过不了：名字空或底座非法——上一版草稿原样退回，错误挂到字段上
        name = str(merged.get("name") or "").strip() if isinstance(merged, dict) else ""
        kind = str(((merged or {}).get("base") or {}).get("kind") or "") if isinstance(merged, dict) else ""
        if not name:
            field, message = "name", "还没给这个节点起名字"
        else:
            field, message = "base.kind", f"底座「{kind}」不在可选范围里"
        return {
            "status": "error",
            "say": say or "这一步没生成出可用的草稿，再试一次。",
            "recipe": base,
            "changed": [],
            "question": question,
            "warnings": [],
            "field_errors": [{"field": field, "message": message}],
            "mode": mode,
        }
    verdict = validate_recipe(normalized, user_recipes if isinstance(user_recipes, list) else [])
    field_errors = [
        {"field": _field_path_for_error(message, normalized), "message": str(message)}
        for message in (verdict.get("errors") or [])
    ]
    changed = changed_fields(base or {}, normalized)
    # 模型给了但归一化不认的键（拼错字段名/枚举越界）：不静默吞，折算成一条人话提示
    dropped = sorted(set(flatten_recipe(patch)) - set(flatten_recipe(normalized)))
    if dropped:
        warnings.append("这些设置没能落下（字段名或取值不认识），已忽略：" + "、".join(dropped[:3]))
    if not say:
        if base is None:
            say = "初稿已经画在中间了，你看看像不像你要的。"
        elif changed:
            say = "改了 " + str(len(changed)) + " 处，卡片上高亮的就是。"
        else:
            say = "这轮没改动配方，我把话补在前面了。"
    logger.info(
        "recipe draft: mode=%s changed=%d errors=%d dropped=%d",
        mode, len(changed), len(field_errors), len(dropped),
    )
    return {
        "status": "ok",
        "say": say,
        "recipe": normalized,
        "changed": changed,
        "question": question,
        "warnings": warnings,
        "field_errors": field_errors,
        "mode": mode,
    }
