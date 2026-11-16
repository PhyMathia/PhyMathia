"""skill 注册表与路由载荷（2026-11-16）。

skill = 一份带「适用范围」的附加规范（画法契约、叙事骨架、推导模板……）。它与提示词
常量的区别是：**skill 是内容资产，不住在代码里**——`src/skills/*.md` 一份文件一条，
加一条 skill 不用改 Python。

三段式（设计说明见 `docs/dev/skills.md`）：

1. **注册表**：启动后首次用到时扫目录，读 front-matter（id/name/desc/scope）与正文；
2. **路由**：问题分析步（`workflow_context.mode == "analysis"`）拿到「候选卡」，
   在正文前吐一行 `<skill_plan>{"viz":"iso-cutaway"}</skill_plan>`，前端解析后落在
   分析节点上；
3. **投递**：某个模块生成时带上自己那一条（`workflow_context.skill`），这里按 id
   查出正文，拼到 user 消息尾部（与难度档位同处，system 保持常驻可缓存）。

设计红线：
- **每节点最多一条**（v1）：6 个模块全命中也就 6×~800 字符，budget 16000 扛得住；
- **宁可漏判**：候选之外不得自创 id，解析不出就当没有计划，绝不因此阻塞生成；
- **无计划时兜底**：`viz_style` 的 embedding 判定照旧——「画布上直接生成交互可视化」
  那条路径没有分析步，永远拿不到计划。
- 全部失败模式一律降级为「不注入」，不抛异常到路由。

开关：`PHYMATHIA_SKILL_ROUTER=0/off/false` 关闭（未设＝开）。
"""

from __future__ import annotations

import os
import re
import threading
from typing import Any, Dict, Iterable, List

# 与 harness/registry.py、graph.js 的 GRAPH_MODULE_META 同口径的六个模块键；
# skill 的 scope 只能取这里的值（写错当作无效条目，不注入）。
MODULE_LABELS = {
    "physics": "物理视角",
    "math": "数学视角",
    "graph": "知识图谱",
    "viz": "交互可视化",
    "socratic": "苏格拉底追问",
    "learn": "进阶学习",
}

_DESC_MAX = 60
_lock = threading.Lock()
_cache: List[Dict[str, Any]] | None = None

_FRONT_MATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)


def _enabled() -> bool:
    return str(os.environ.get("PHYMATHIA_SKILL_ROUTER") or "").strip().lower() not in ("0", "off", "false")


def enabled() -> bool:
    """对外开关（路由链整体）。关掉后只剩 viz_style 的兜底判定。"""
    return _enabled()


def _skill_dir():
    override = str(os.environ.get("PHYMATHIA_SKILLS_DIR") or "").strip()
    if override:
        return _path(override)
    return _path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / "skills"


def _path(raw: str):
    from pathlib import Path

    return Path(raw)


def _parse_scope(raw: str) -> List[str]:
    text = str(raw or "").strip().strip("[]")
    parts = re.split(r"[,，\s]+", text)
    out: List[str] = []
    for part in parts:
        key = part.strip().strip("'\"")
        if key in MODULE_LABELS and key not in out:
            out.append(key)
    return out


def _parse_skill(text: str) -> Dict[str, Any] | None:
    """解析一份 SKILL.md：front-matter 取 id/name/desc/scope，其余是正文。"""
    match = _FRONT_MATTER.match(text)
    if not match:
        return None
    meta: Dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip()
    skill_id = str(meta.get("id") or "").strip()
    body = text[match.end():].strip()
    if not skill_id or not body:
        return None
    scope = _parse_scope(meta.get("scope", ""))
    if not scope:
        # 没声明范围的 skill 不参与路由——宁可不用，也不要四处乱挂
        return None
    return {
        "id": skill_id,
        "name": str(meta.get("name") or skill_id).strip(),
        "desc": str(meta.get("desc") or "").strip()[:_DESC_MAX],
        "scope": scope,
        "body": body,
    }


def all_skills() -> List[Dict[str, Any]]:
    """全部可用 skill（按 id 排序，进程内缓存一次）。读不到目录返回空表。"""
    global _cache
    if _cache is not None:
        return _cache
    with _lock:
        if _cache is not None:
            return _cache
        found: List[Dict[str, Any]] = []
        try:
            root = _skill_dir()
            files = sorted(root.glob("*.md"))
        except Exception:
            files = []
        for path in files:
            try:
                parsed = _parse_skill(path.read_text(encoding="utf-8"))
            except Exception:
                parsed = None
            if parsed:
                found.append(parsed)
        found.sort(key=lambda item: item["id"])
        _cache = found
        return _cache


def reload_skills() -> List[Dict[str, Any]]:
    """丢掉缓存重读（改完 md 不用重启服务；测试与开发用）。"""
    global _cache
    with _lock:
        _cache = None
    return all_skills()


def by_scope(modules: Iterable[str] | None = None) -> List[Dict[str, Any]]:
    """按模块键过滤 skill；不传或传空＝不过滤。"""
    wanted = {str(m).strip() for m in (modules or []) if str(m).strip() in MODULE_LABELS}
    items = all_skills()
    if not wanted:
        return list(items)
    return [item for item in items if wanted.intersection(item["scope"])]


def get(skill_id: str) -> Dict[str, Any] | None:
    target = str(skill_id or "").strip()
    if not target:
        return None
    for item in all_skills():
        if item["id"] == target:
            return item
    return None


def payload(skill_id: str) -> str:
    """skill 正文（投递用）；查不到返回空串。"""
    item = get(skill_id)
    return item["body"] if item else ""


def _downstream_modules(downstream: Any) -> List[str]:
    out: List[str] = []
    if isinstance(downstream, list):
        for entry in downstream:
            module = str(entry.get("module") or "").strip() if isinstance(entry, dict) else str(entry or "").strip()
            if module in MODULE_LABELS and module not in out:
                out.append(module)
    return out


def menu_block(downstream: Any = None) -> str:
    """分析步的候选卡：只列可能用得上的 skill，并要求正文前吐一行计划。

    downstream 非空（画布上已连好下游节点）时按模块过滤候选；为空（首问路径——
    模块节点是分析之后才建的）时列全部，由分析步自己决定建议哪些模块。
    """
    if not _enabled():
        return ""
    scopes = _downstream_modules(downstream)
    items: List[Dict[str, Any]] = []
    for skill in all_skills():
        usable = [s for s in skill["scope"] if (not scopes or s in scopes)]
        if not usable:
            continue
        row = dict(skill)
        row["usable"] = usable
        items.append(row)
    if not items:
        return ""

    lines = ["\n\n# 可挂的 skill 候选（生成前一次性决定，不影响下面正文的写法）"]
    for skill in items:
        labels = "、".join(MODULE_LABELS[s] for s in skill["usable"])
        lines.append(f"- id={skill['id']}｜{skill['name']}｜适用节点：{labels}｜{skill['desc']}")
    lines.append("")
    lines.append("规则：")
    lines.append("- 只在这些节点确实需要时才挂：候选之外不得自创 id，同一节点最多一条。")
    lines.append("- 需要时，在正文最前面单独输出一行（只此一行，不要解释、不要写进概要）：")
    lines.append('- <skill_plan>{"viz":"iso-cutaway"}</skill_plan>')
    lines.append("- 不需要任何 skill 就输出 <skill_plan>none</skill_plan>。")
    lines.append("- 键用模块英文键：" + "、".join(f"{k}={v}" for k, v in MODULE_LABELS.items()) + "。")
    lines.append("- 这一行优先于前面对「不要输出 XML 标签」的要求；除它以外仍然不要输出任何标签。")
    return "\n".join(lines)


def requested_block(workflow_context: Any) -> tuple:
    """模块生成时按计划取正文。返回 (要追加的文本, skill_id)；没有计划返回 ("", "")。

    计划形状由前端给：``workflow_context.skill = {"id": "...", "module": "viz"}``，
    也兼容直接给 id 字符串。
    """
    if not _enabled() or not isinstance(workflow_context, dict):
        return ("", "")
    raw = workflow_context.get("skill")
    skill_id = ""
    if isinstance(raw, dict):
        skill_id = str(raw.get("id") or raw.get("skill") or "").strip()
    elif isinstance(raw, str):
        skill_id = raw.strip()
    if not skill_id:
        return ("", "")
    body = payload(skill_id)
    if not body:
        return ("", "")
    return ("\n\n" + body, skill_id)


def describe_plan(workflow_context: Any) -> str:
    """日志用的短描述（不参与注入）。"""
    block, skill_id = requested_block(workflow_context)
    return f"plan:{skill_id}:{len(block)}" if block else ""
