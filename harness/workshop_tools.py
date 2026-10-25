"""节点工坊 C1：Φ 自助调优循环的固定工具表（2026-10-25）。

架构基线（C1 拍板，别绕）：配方库在 localStorage、画布在内存，所以**工具在浏览器
执行**；本模块只定义 OpenAI function-calling 形状的工具表，供 `/workshop/step`
随模型调用透传给上游——服务端**不执行任何工具**。真正的执行器在
src/static/js/graph-workshop.js 的 `_rwAgentExecTool`（查能力走既有 capabilities
端点、试跑走 `_rwRunTrialOnce`、体检读 `_rwJudgeOutput` 的结果、改配方走
`_rwRequestDraft(mode:'patch')`——全是既有单链，不另写第二套）。

C1 只有六个工具，全部无副作用（不改配方库、不写画布）：四个只读（能力/配方/试跑/
体检）＋一个经补丁管道改当前草稿＋一个查重名。入册/落图/连线/删配方留给 C2。
"""

from __future__ import annotations

from typing import Any, Dict, List

from .tools import _str_prop, _tool

# 与前端执行器一一对应；加工具必须两侧同步（冒烟有「不认识的工具」兜底断言）
WORKSHOP_TOOL_NAMES = (
    "workshop_capabilities",
    "workshop_get_recipe",
    "workshop_run_trial",
    "workshop_read_judge",
    "workshop_patch_recipe",
    "workshop_check_name",
)

# 试跑上限与提示词/前端三处同口径（C1 拍板：8 步模型调用、2 次试跑）
WORKSHOP_AGENT_MAX_STEPS = 8
WORKSHOP_AGENT_MAX_TRIALS = 2


def build_workshop_tools() -> List[Dict[str, Any]]:
    """C1 工具表（描述写给模型读：说清每个工具看什么、上限在哪）。"""
    capabilities = _tool(
        "workshop_capabilities",
        "查这个工坊能配什么：底座/色板/形状/内容载体/上下文通道/模型槽位/各字段上限与默认值"
        "（来自服务端能力清单）。写配方前先看这个，别凭记忆猜枚举。",
        {},
        [],
    )
    get_recipe = _tool(
        "workshop_get_recipe",
        "看当前配方快照（名字、输入口、出口、生成要求等完整 JSON）。改之前先看现状。",
        {},
        [],
    )
    run_trial = _tool(
        "workshop_run_trial",
        "用当前材料真实试跑一次这个配方（与用户手动试跑同一条链，输出是流式收全后的全文），"
        "并立即给出结构体检结果与输出节选。整个会话最多 "
        f"{WORKSHOP_AGENT_MAX_TRIALS} 次，超了会拒绝——别浪费在重复验证同一版配方上。",
        {},
        [],
    )
    read_judge = _tool(
        "workshop_read_judge",
        "读最近一次试跑的体检结果（指标：字数/步骤/公式/出口；问题旗：太短/没分步骤/公式没包/"
        "复述输入/出口没解析出来）。体检是纯结构判定，不许凭空编造体检结论。",
        {},
        [],
    )
    patch_recipe = _tool(
        "workshop_patch_recipe",
        "改当前配方：instruction 写清只改哪个有问题的字段、为什么要这么改（走既有补丁管道，"
        "深合并到当前草稿上，没提到的字段保持原样）。每次只改体检发现的问题处，"
        "不要重写整份配方，也不要动已经正确的部分。",
        {"instruction": _str_prop("要改什么与为什么（给补丁管道的修改要求，一段人话）")},
        ["instruction"],
    )
    check_name = _tool(
        "workshop_check_name",
        "检查一个名字是否与用户已有配方重名（想给配方改名/起名前先查，重名会被校验拦下）。",
        {"name": _str_prop("要检查的名字")},
        ["name"],
    )
    table = [capabilities, get_recipe, run_trial, read_judge, patch_recipe, check_name]
    assert tuple(item["function"]["name"] for item in table) == WORKSHOP_TOOL_NAMES
    return table
