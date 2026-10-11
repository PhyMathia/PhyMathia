"""节点类型注册表（后端投影，P0）。

设计文档：docs/节点配方与创造模式-总体设计-2026-09-29.md。
单一数据源在前端 ``src/static/js/graph-recipes.js``（BUILTIN_RECIPES），
本模块是 harness 后端需要的投影：kind 集合、module_key 集合、可创建集合、
Φ 提示词的中文节点类型表。两侧由 ``tests/test_registry_consistency.py``
对拍守护——改任何一侧必须同步改另一侧，别只改一处。

P0 原则是"数据收敛、行为零变化"：core.py 的三个白名单与 prompts.py 的
节点类型表在 P0 前后必须逐值（提示词则逐字）一致。

标签口径说明：提示词里的标签以历史提示词为准（blank 是「空白节点」而非添加
面板的「AI 生成空白」），与添加面板文案本就不是同一份；对拍测试只对拍
kind/module_key 集合，不对拍 label。前端 available_node_types 通道已于
2026-10-06 随死代码退役删除（T111，见 docs/dev/harness.md 当日节）。
"""

from __future__ import annotations

# kind → 中文标签（Φ 提示词口径）
NODE_KIND_LABELS = {
    "blank": "空白节点",
    "user": "问题",
    "answer": "AI 回答",
    "knowledge": "知识点",
    "human_note": "我的理解",
    "note": "我的总结",
    "hub": "汇聚",
    "summary": "AI 总结",
    "source": "输入",
    "relation": "联系",
    "ai_eval": "AI 评价",
    # junction（2026-10-11 中转节点）：走线锚点，用户面板可见但 Φ 不建——
    # 见下方 REMOVED_CREATE_KINDS 说明
    "junction": "中转",
}

# module_key → 中文标签（kind=module 的六个视角模块 + manual）
MODULE_LABELS = {
    "physics": "物理视角",
    "math": "数学视角",
    "graph": "知识图谱",
    "viz": "交互可视化",
    "socratic": "苏格拉底追问",
    "learn": "进阶学习",
    "manual": "我的回答",
}

# 创建口径已移除的 kind：relation 提示词明示"不要创建 kind=relation"（关系一律用连线表达）；
# hub 于 2026-10-10 退役（backlog 267，多端口任意连后接线职能已被「＋加输入口」取代）；
# junction 于 2026-10-11 新增（用户拍板的走线锚点，面板可见但定位是用户手动工具——
# 提示词红线「勿建 kind=junction」，多路分叉时 Φ 从同一输出口 add_edge 多条边即可）。
# ALLOWED_CREATE_KINDS 均不含它们；但快照里允许出现（旧会话数据存续／junction 为用户
# 手建），更新/删除/连线穿过不受限。
REMOVED_CREATE_KINDS = ("relation", "hub", "junction")

ALLOWED_NODE_KINDS = set(NODE_KIND_LABELS) | {"module"}
ALLOWED_CREATE_KINDS = ALLOWED_NODE_KINDS - set(REMOVED_CREATE_KINDS)
ALLOWED_MODULE_KEYS = set(MODULE_LABELS)

# Φ 提示词「可用节点类型」完整行文本（含 source / ai_eval 的括注话术），
# 与 2026-09-29 P0 之前的内联文本逐字一致；改行序/改文案必须同步 review 对拍测试。
PROMPT_TYPE_LINES = (
    "- kind=module, module_key=physics：物理视角",
    "- kind=module, module_key=math：数学视角",
    "- kind=module, module_key=graph：知识图谱",
    "- kind=module, module_key=viz：交互可视化",
    "- kind=module, module_key=socratic：苏格拉底追问",
    "- kind=module, module_key=learn：进阶学习",
    "- kind=knowledge：知识点",
    "- kind=human_note：我的理解",
    "- kind=ai_eval：AI 评价节点，用于评价/建议/反馈",
    "- kind=note：我的总结",
    "- kind=summary：AI 总结",
    "- kind=source：输入（原材料节点；快照里带 items 字段，是该材料解析出的知识点列表，建立/检查关系时以 items 内容为准）",
    "- kind=blank：空白节点",
    "- kind=user：问题",
    "- kind=answer：AI 回答",
)


def prompt_node_type_lines() -> list[str]:
    """提示词节点类型表（prompts.py 组装提示词时唯一入口）。"""
    return list(PROMPT_TYPE_LINES)
