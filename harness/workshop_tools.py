"""节点工坊 C1+C2：Φ 自助调优循环的固定工具表（2026-10-25）。

架构基线（C1 拍板，别绕）：配方库在 localStorage、画布在内存，所以**工具在浏览器
执行**；本模块只定义 OpenAI function-calling 形状的工具表，供 `/workshop/step`
随模型调用透传给上游——服务端**不执行任何工具**。真正的执行器在
src/static/js/graph-workshop.js 的 `_rwAgentExecTool`（查能力走既有 capabilities
端点、试跑走 `_rwRunTrialOnce`、体检读 `_rwJudgeOutput` 的结果、改配方走
`_rwRequestDraft(mode:'patch')`、入册走 `rwSaveRecipe`、落图走
`rwPlaceOnCanvas({keepOpen:true})`、上游候选读 `_rwUpstreamCandidates`——全是
既有单链，不另写第二套）。

C2 起九个工具＝C1 六个无副作用＋三个副作用（入册/查上游/落图连线）。副作用规
矩（提示词与前端执行器同口径）：每个副作用工具执行前**问用户一次**，被拒不重
试、把拒绝结果回灌给模型收尾说明；落图前必须试跑过（认 run 的 recipeId 章）；
连线 id 只认 `workshop_list_upstream` 返回的候选。删配方仍不做（破坏性删除，
要做先单独拍板）。
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
    "workshop_save_recipe",
    "workshop_list_upstream",
    "workshop_place_on_canvas",
)

# 步数/试跑上限与提示词/前端三处同口径（C2 拍板：10 步模型调用、2 次试跑——
# 多出的两步给「入册 → 查上游 → 落图」这条副作用尾巴）
WORKSHOP_AGENT_MAX_STEPS = 10
WORKSHOP_AGENT_MAX_TRIALS = 2


def build_workshop_tools() -> List[Dict[str, Any]]:
    """九工具表（描述写给模型读：说清每个工具看什么、上限在哪、副作用会问用户）。"""
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
    save_recipe = _tool(
        "workshop_save_recipe",
        "把当前配方入册（存进用户的配方库，之后在添加面板里能找到它）。这是副作用动作："
        "执行前会问用户一次，被拒不重试、直接收尾说明；入册失败照实报告，不要假装成功。",
        {},
        [],
    )
    list_upstream = _tool(
        "workshop_list_upstream",
        "只读：列出画布上可以接到这个新节点的上游候选（id、标题、是否看起来对得上）。"
        "落图要接上游时，upstream_ids 只能从这个列表返回的 id 里挑，别编造。",
        {},
        [],
    )
    place_on_canvas = _tool(
        "workshop_place_on_canvas",
        "把节点放到画布，可选接上游连线（upstream_ids 只用 workshop_list_upstream 返回的 id；"
        "不传或传空就是不接）。落图前这份配方必须试跑过（认试跑记录的配方章，别绕）；"
        "这是副作用动作：执行前会问用户一次，被拒不重试、直接收尾说明；失败照实报告。",
        {
            "upstream_ids": {
                "type": "array",
                "items": {"type": "string"},
                "description": "要接上的上游节点 id 列表（只认 workshop_list_upstream 返回的 id；可不接）",
            },
        },
        [],
    )
    table = [
        capabilities, get_recipe, run_trial, read_judge, patch_recipe, check_name,
        save_recipe, list_upstream, place_on_canvas,
    ]
    assert tuple(item["function"]["name"] for item in table) == WORKSHOP_TOOL_NAMES
    return table
