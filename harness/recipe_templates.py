"""工坊内置配方模板库（B：让 Φ 不从白纸写整份配方）。

DSH 对照的结论：弱模型一次写整份配方会丢字段、枚举靠猜（T79 在案）。模板库把
「从零起草」换成「在验证过的底稿上打补丁」——一句命中关键词的话先挑出最近邻
模板当深合并基底，模型只改与用户意图不同的字段（合并/归一/校验仍在
recipe_draft 的既有管道里，本模块只负责「给基底」）。

- 模板是纯数据：每份都必须能过 normalize_recipe_input + validate_recipe
  （tests/test_recipe_draft.py 有全量守护，schema 演进时模板不合法当场红）。
- 模板不给 id：每次起稿 normalize 都生成新 id，草稿互不串。
- pick_template 是确定性关键词打分（每个关键词命中 1 分、模板名整词命中 +2），
  ≥2 分才启用；宁可从零起草也不错配底稿。不打模型调用。
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

TEMPLATE_MATCH_THRESHOLD = 2

RECIPE_TEMPLATES: List[Dict[str, Any]] = [
    {
        "key": "mistake_review",
        "label": "错题复盘",
        "brief": "喂做错的题和当时的答案，拆错因、给正确思路、点同类题眼",
        "keywords": ["错题", "复盘", "错因", "订正", "改错", "做错", "没做对", "马虎"],
        "recipe": {
            "name": "错题复盘",
            "desc": "喂做错的题和当时的答案，拆错因、给正确思路、点同类题眼",
            "base": {"kind": "module"},
            "appearance": {"palette": "rose"},
            "generate": {"prompt": "你在做一道错题的复盘。按「第一步 错在哪」指出当时的答案具体错在哪一步、为什么错；「第二步 正确思路」给从题面到答案的完整思路，公式用 $…$ 包起来；「第三步 同类题眼」提炼这道题的考点和下次见到同类题的判断信号。不要复述题目原文。"},
            "ports": {
                "static": [
                    {"label": "错因", "drag_form": "draft"},
                    {"label": "正确思路", "drag_form": "draft"},
                    {"label": "同类题眼", "drag_form": "draft"},
                ],
                "inputs": [{"label": "题目", "type": "text"}, {"label": "我的答案", "type": "text"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "force_analysis",
        "label": "受力分析",
        "brief": "喂题目和受力图，拆研究对象、受力清单、方程，出口可换条件再算",
        "keywords": ["受力", "力学", "牛顿", "斜面", "摩擦", "拉力", "平衡", "受力图"],
        "recipe": {
            "name": "受力分析",
            "desc": "喂题目和受力图，拆研究对象、受力清单、方程",
            "base": {"kind": "module"},
            "appearance": {"palette": "blue"},
            "generate": {"prompt": "你在做受力分析。按「第一步 研究对象」说清取谁、怎么建系；「第二步 受力清单」逐个列出力（名称、方向、来源）；「第三步 方程」沿坐标轴列方程并解出目标量，公式用 $…$ 包起来；「第四步 检查」用特例或数量级核对。只输出正文，不要开场白，不要复述题目。"},
            "ports": {
                "static": [
                    {"label": "研究对象", "drag_form": "draft"},
                    {"label": "受力清单", "drag_form": "draft"},
                    {"label": "方程", "drag_form": "draft"},
                    {"label": "换个条件", "drag_form": "draft"},
                ],
                "inputs": [{"label": "题目", "type": "text"}, {"label": "受力图", "type": "diagram"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "formula_insight",
        "label": "公式理解",
        "brief": "喂一个公式，讲直觉、推导、易错点",
        "keywords": ["公式理解", "理解公式", "公式直觉", "推导", "怎么来的", "为什么成立", "直觉解释", "公式含义"],
        "recipe": {
            "name": "公式理解",
            "desc": "喂一个公式，讲直觉、推导、易错点",
            "base": {"kind": "module"},
            "appearance": {"palette": "violet"},
            "generate": {"prompt": "你在讲一个公式的来龙去脉。按「第一步 直觉」说清这个公式为什么长这样、每一项的物理或几何含义；「第二步 推导」从更基本的结论推出来，每步给出依据；「第三步 易错点」点名单位、符号、适用条件上最容易踩的坑。公式一律用 $…$ 包起来。"},
            "ports": {
                "static": [
                    {"label": "直觉", "drag_form": "draft"},
                    {"label": "推导", "drag_form": "draft"},
                    {"label": "易错点", "drag_form": "draft"},
                ],
                "inputs": [{"label": "公式", "type": "formula"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "proof_check",
        "label": "证明检查",
        "brief": "喂命题和证明，逐段找缺口、给修补建议、下结论",
        "keywords": ["证明", "证伪", "严谨", "跳步", "循环论证"],
        "recipe": {
            "name": "证明检查",
            "desc": "喂命题和证明，逐段找缺口、给修补建议、下结论",
            "base": {"kind": "module"},
            "appearance": {"palette": "teal"},
            "generate": {"prompt": "你在审一份证明。按「第一步 逐段检查」每段说明用了什么依据、哪段依据不足；「第二步 缺口」点名跳步或循环论证的具体位置；「第三步 修补建议」给出能补上的引理或步骤；「第四步 结论」明确通过 / 需补 / 不成立。不要重写整份证明，关键式子用 $…$ 包起来。"},
            "ports": {
                "static": [
                    {"label": "缺口", "drag_form": "draft"},
                    {"label": "修补建议", "drag_form": "draft"},
                    {"label": "结论", "drag_form": "draft"},
                ],
                "inputs": [{"label": "命题", "type": "text"}, {"label": "证明", "type": "text"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "concept_contrast",
        "label": "概念辨析",
        "brief": "喂两个容易混的概念，对着讲区别、联系、对比例子",
        "keywords": ["辨析", "区别", "对比", "混淆", "分不清", "两个概念", "异同"],
        "recipe": {
            "name": "概念辨析",
            "desc": "喂两个容易混的概念，对着讲区别、联系、对比例子",
            "base": {"kind": "module"},
            "appearance": {"palette": "blue"},
            "generate": {"prompt": "你在辨析两个容易混的概念。按「第一步 一句话区别」；「第二步 各自的定义与适用场景」；「第三步 联系」什么条件下会互相转化或同时出现；「第四步 对比例子」同一情境下两者的不同用法。别各写各的，要处处对着比。"},
            "ports": {
                "static": [
                    {"label": "区别", "drag_form": "draft"},
                    {"label": "联系", "drag_form": "draft"},
                    {"label": "例子", "drag_form": "draft"},
                ],
                "inputs": [{"label": "概念A", "type": "text"}, {"label": "概念B", "type": "text"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "socratic_ask",
        "label": "苏格拉底追问",
        "brief": "喂一段材料，正文自动长出分层追问按钮（基础/进阶）",
        "keywords": ["苏格拉底", "追问", "提问", "考我", "引导", "问我"],
        "recipe": {
            "name": "苏格拉底追问",
            "desc": "喂一段材料，正文自动长出分层追问按钮",
            "base": {"kind": "module"},
            "appearance": {"palette": "teal"},
            "generate": {"prompt": "你在给一段材料配追问。先给两三句简短点评，指出关键思路；然后按编号列追问，每行一个，格式「1. [基础] 问题」「2. [进阶] 问题」，共 3~6 个：基础问事实与公式，进阶问变化与迁移。不要给答案。"},
            "ports": {
                "static": [{"label": "换个角度", "drag_form": "draft"}],
                "inputs": [{"label": "材料", "type": "text"}],
                "dynamic": {
                    "parser": {"pattern": "numbered_list", "level_tags": ["基础", "进阶"], "max": 6, "label_from": "index_question"},
                    "fallback": {"mode": "label_questions_from_text", "labels": []},
                    "each": {"type": "socratic", "branch_type": "socratic", "drag_form": "draft"},
                },
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "viz_diagram",
        "label": "可视化图解",
        "brief": "喂一个主题，产出 mermaid 关系图＋怎么读这张图",
        "keywords": ["可视化", "图解", "流程图", "关系图", "示意图", "画图", "mermaid"],
        "recipe": {
            "name": "可视化图解",
            "desc": "喂一个主题，产出 mermaid 关系图＋怎么读这张图",
            "base": {"kind": "module"},
            "appearance": {"palette": "violet"},
            "generate": {"prompt": "你在把一个主题画成一张图。输出一个 mermaid 代码块（用 ```mermaid 围栏），节点文字用中文、每个不超过 12 个字，连线上写关系词；代码块外只给两三句「怎么读这张图」的说明，不要再输出别的正文。"},
            "ports": {
                "static": [{"label": "图解说明", "drag_form": "draft"}],
                "inputs": [{"label": "主题", "type": "text"}],
            },
            "content_kind": "mermaid",
        },
    },
    {
        "key": "dimension_check",
        "label": "量纲检查",
        "brief": "喂一个表达式，逐项查量纲、推整体、下结论",
        "keywords": ["量纲", "单位检查", "单位对不对", "量纲分析"],
        "recipe": {
            "name": "量纲检查",
            "desc": "喂一个表达式，逐项查量纲、推整体、下结论",
            "base": {"kind": "module"},
            "appearance": {"palette": "blue"},
            "generate": {"prompt": "你在做量纲与单位检查。按「第一步 逐项量纲」把表达式每一项的量纲写出来，用 $[\\mathrm{M}]$ 这类记号并包在 $…$ 里；「第二步 运算」按量纲运算法则推整体的量纲；「第三步 结论」两边量纲是否一致、单位换算要注意什么。发现不一致要明说，别替用户圆场。"},
            "ports": {
                "static": [
                    {"label": "量纲", "drag_form": "draft"},
                    {"label": "结论", "drag_form": "draft"},
                ],
                "inputs": [{"label": "表达式", "type": "formula"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "formula_cards",
        "label": "公式速记卡",
        "brief": "喂章节主题，列关键公式和记忆钩子，考前突击用",
        "keywords": ["速记", "背公式", "默写", "公式卡", "公式清单", "考前突击", "记忆钩子"],
        "recipe": {
            "name": "公式速记卡",
            "desc": "喂章节主题，列关键公式和记忆钩子，考前突击用",
            "base": {"kind": "module"},
            "appearance": {"palette": "amber"},
            "generate": {"prompt": "你在整理一章的公式速记卡。按「第一步 关键公式」按重要性列 5~8 个，每个用 $$…$$ 独立成行，后面跟一句它什么时候用；「第二步 记忆钩子」给 2~3 条把容易混的公式区分开的口诀或图像。不要写推导过程。"},
            "ports": {
                "static": [
                    {"label": "关键公式", "drag_form": "draft"},
                    {"label": "记忆钩子", "drag_form": "draft"},
                ],
                "inputs": [{"label": "章节主题", "type": "text"}],
            },
            "content_kind": "markdown",
        },
    },
    {
        "key": "step_by_step",
        "label": "分步解题",
        "brief": "喂一道题，按步推进并在最后自检（最通用的解题底稿）",
        "keywords": ["解题", "分步", "求解", "怎么做", "步骤", "解法", "做题"],
        "recipe": {
            "name": "分步解题",
            "desc": "喂一道题，按步推进并在最后自检",
            "base": {"kind": "module"},
            "appearance": {"palette": "amber"},
            "generate": {"prompt": "你在解一道题。按「第一步 …」逐段推进：每步先说这步在干什么，再给依据与具体代入，公式用 $…$ 包起来；最后一段「检查」用特例或量纲核对结果。不要复述题目，不要开场白。"},
            "ports": {
                "static": [
                    {"label": "步骤", "drag_form": "draft"},
                    {"label": "检查", "drag_form": "draft"},
                ],
                "inputs": [{"label": "题目", "type": "text"}],
            },
            "content_kind": "markdown",
        },
    },
]


def pick_template(instruction: str) -> Optional[Dict[str, Any]]:
    """一句话 → 最近邻模板。确定性关键词打分，不打模型。

    每个关键词命中记 1 分、模板名整词出现再 +2；同分取列表里更靠前（更专一）的。
    低于阈值返回 None——宁可从零起草，也不错配底稿。
    """
    text = str(instruction or "")
    if not text.strip():
        return None
    best: Optional[Dict[str, Any]] = None
    best_score = 0
    for item in RECIPE_TEMPLATES:
        score = 0
        for keyword in item["keywords"]:
            if keyword and keyword in text:
                score += 1
        label = str(item.get("label") or "")
        if label and label in text:
            score += 2
        if score > best_score:
            best, best_score = item, score
    return best if best_score >= TEMPLATE_MATCH_THRESHOLD else None


def template_catalog() -> List[Dict[str, Any]]:
    """轻量目录（给能力端点/工具层用）：不带配方正文，只有 key/label/brief/keywords。"""
    return [
        {
            "key": str(item.get("key") or ""),
            "label": str(item.get("label") or ""),
            "brief": str(item.get("brief") or ""),
            "keywords": [str(k) for k in (item.get("keywords") or [])],
        }
        for item in RECIPE_TEMPLATES
    ]
