"""skill 注册表与路由载荷（2026-11-16）。

skill = 一份带「适用范围」的附加规范（画法契约、叙事骨架、推导模板……）。它与提示词
常量的区别是：**skill 是内容资产，不住在代码里**——一份 md 一条，加 skill 不用改 Python。

两个来源（2026-11-16 第二版起）：
- **内置**：`src/skills/*.md`，随程序发布、只读；
- **用户自建**：`data/users/<账号>/skills/*.md`，一个账号一份，可增删改。
同 id 时用户那份覆盖内置那份（但接口层禁止用户建与内置同名的 id，避免「改了没生效」的困惑）。

三段式（设计说明见 `docs/dev/skills.md`）：

1. **注册表**：按「目录指纹」缓存，改了文件自动失效（不用重启）；
2. **路由**：问题分析步（`workflow_context.mode == "analysis"`）拿到候选卡，在正文前
   吐一行 `<skill_plan>{"viz":"iso-cutaway"}</skill_plan>`，前端解析后落在分析节点上；
3. **投递**：某个模块生成时带上自己那一条（`workflow_context.skill`），这里按 id
   查出正文，拼到 user 消息尾部（与难度档位同处，system 保持常驻可缓存）。

设计红线：
- **每节点最多一条**（v1）：6 个模块全命中也就 6×~800 字符，budget 16000 扛得住；
- **宁可漏判**：候选之外不得自创 id，解析不出就当没有计划，绝不因此阻塞生成；
- **无计划时兜底**：`viz_style` 的 embedding 判定照旧——「画布上直接生成交互可视化」
  那条路径没有分析步，永远拿不到计划。
- 全部失败模式一律降级为「不注入」，不抛异常到路由。
- 用户正文原样注入，故有长度与条数上限，超限直接拒绝写入（见 `LIMITS`）。

开关：`PHYMATHIA_SKILL_ROUTER=0/off/false` 关闭（未设＝开）。
"""

from __future__ import annotations

import os
import re
import threading
from typing import Any, Dict, Iterable, List

from .accounts import DEFAULT_ACCOUNT, resolve_paths

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

# 用户可写内容的硬上限（超限拒绝写入，不做静默截断——静默截断会让人以为存进去了）
LIMITS = {
    "name": 40,
    "desc": 120,
    "body": 20000,
    "skills": 40,
}

DESC_MAX = LIMITS["desc"]
_SKILL_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
_FRONT_MATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)

_lock = threading.Lock()
_cache: Dict[str, Dict[str, Any]] = {}


def _enabled() -> bool:
    return str(os.environ.get("PHYMATHIA_SKILL_ROUTER") or "").strip().lower() not in ("0", "off", "false")


def enabled() -> bool:
    """对外开关（路由链整体）。关掉后只剩 viz_style 的兜底判定。"""
    return _enabled()


def _account(account: Any = None) -> str:
    text = str(account or "").strip()
    return text or DEFAULT_ACCOUNT


def _builtin_dir():
    override = str(os.environ.get("PHYMATHIA_SKILLS_DIR") or "").strip()
    if override:
        from pathlib import Path

        return Path(override)
    from pathlib import Path

    return Path(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))) / "skills"


def _user_dir(account: Any = None):
    """账号自己的技能目录（纯计算，不建目录）。"""
    return resolve_paths(_account(account)).skills_dir


# ====== 解析与加载 ======

def _parse_scope(raw: str) -> List[str]:
    text = str(raw or "").strip().strip("[]")
    parts = re.split(r"[,，\s]+", text)
    out: List[str] = []
    for part in parts:
        key = part.strip().strip("'\"")
        if key in MODULE_LABELS and key not in out:
            out.append(key)
    return out


def _parse_skill(text: str, builtin: bool = False) -> Dict[str, Any] | None:
    """解析一份 md：front-matter 取 id/name/desc/scope，其余是正文。"""
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
    if not _SKILL_ID_RE.match(skill_id) or not body:
        return None
    scope = _parse_scope(meta.get("scope", ""))
    if not scope:
        # 没声明范围的 skill 不参与路由——宁可不用，也不要四处乱挂
        return None
    return {
        "id": skill_id,
        "name": str(meta.get("name") or skill_id).strip()[:LIMITS["name"]],
        "desc": str(meta.get("desc") or "").strip()[:DESC_MAX],
        "scope": scope,
        "body": body,
        "builtin": builtin,
    }


def _dir_signature(path) -> tuple:
    """目录指纹：(文件名, mtime_ns, size)。外部改文件/加文件都会让它变。"""
    try:
        rows = []
        for item in sorted(path.glob("*.md")):
            try:
                stat = item.stat()
            except OSError:
                continue
            rows.append((item.name, stat.st_mtime_ns, stat.st_size))
        return tuple(rows)
    except Exception:
        return ()


def _read_dir(path, builtin: bool) -> List[Dict[str, Any]]:
    found: List[Dict[str, Any]] = []
    try:
        files = sorted(path.glob("*.md"))
    except Exception:
        files = []
    for file_path in files:
        try:
            parsed = _parse_skill(file_path.read_text(encoding="utf-8"), builtin=builtin)
        except Exception:
            parsed = None
        if parsed:
            found.append(parsed)
    return found


def all_skills(account: Any = None) -> List[Dict[str, Any]]:
    """该账号可用的全部 skill：内置 + 自建（同 id 自建覆盖内置，按 id 排序）。"""
    key = _account(account)
    builtin_dir = _builtin_dir()
    user_dir = _user_dir(key)
    signature = (_dir_signature(builtin_dir), _dir_signature(user_dir))
    with _lock:
        cached = _cache.get(key)
        if cached and cached["sig"] == signature:
            return cached["items"]
    merged: Dict[str, Dict[str, Any]] = {}
    for item in _read_dir(builtin_dir, builtin=True):
        merged[item["id"]] = item
    for item in _read_dir(user_dir, builtin=False):
        merged[item["id"]] = item
    items = [merged[i] for i in sorted(merged)]
    with _lock:
        _cache[key] = {"sig": signature, "items": items}
    return items


def reload_skills(account: Any = None) -> List[Dict[str, Any]]:
    """丢掉缓存重读（测试与运维用；正常读写已经按目录指纹自动失效）。"""
    with _lock:
        _cache.clear()
    return all_skills(account)


def by_scope(modules: Iterable[str] | None = None, account: Any = None) -> List[Dict[str, Any]]:
    """按模块键过滤 skill；不传或传空＝不过滤。"""
    wanted = {str(m).strip() for m in (modules or []) if str(m).strip() in MODULE_LABELS}
    items = all_skills(account)
    if not wanted:
        return list(items)
    return [item for item in items if wanted.intersection(item["scope"])]


def get(skill_id: str, account: Any = None) -> Dict[str, Any] | None:
    target = str(skill_id or "").strip()
    if not target:
        return None
    for item in all_skills(account):
        if item["id"] == target:
            return item
    return None


def payload(skill_id: str, account: Any = None) -> str:
    """skill 正文（投递用）；查不到返回空串。"""
    item = get(skill_id, account)
    return item["body"] if item else ""


# ====== 用户自建：写 / 删 / 列表 ======

def _clean_line(value: Any, limit: int) -> str:
    text = str(value or "").replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


def save_skill(account: Any, data: Dict[str, Any]) -> Dict[str, Any]:
    """新建或更新一条自建 skill。返回落盘后的条目；非法输入抛 ValueError。

    只允许写「自建」目录：与内置同 id 的写入直接拒绝（提示换个 id），
    否则用户会以为改了内置那条、实际只是覆盖了个看不见的副本。
    """
    key = _account(account)
    if not _enabled():
        raise ValueError("技能系统已关闭（PHYMATHIA_SKILL_ROUTER=0）")
    skill_id = str(data.get("id") or "").strip().lower()
    if not _SKILL_ID_RE.match(skill_id):
        raise ValueError("id 只能用小写字母开头、字母数字与连字符（2–41 位），例如 force-analysis")
    name = _clean_line(data.get("name"), LIMITS["name"])
    desc = _clean_line(data.get("desc"), LIMITS["desc"])
    body = str(data.get("body") or "").replace("\r\n", "\n").strip()
    scope = _parse_scope(",".join(data.get("scope") or []) if isinstance(data.get("scope"), list) else str(data.get("scope") or ""))
    if not name:
        raise ValueError("请填写技能名")
    if not desc:
        raise ValueError("请填写一句话适用描述（用来判断什么时候挂它）")
    if not scope:
        raise ValueError("请至少选一个适用节点")
    if not body:
        raise ValueError("请填写正文")
    if len(body) > LIMITS["body"]:
        raise ValueError(f"正文太长（{len(body)} 字），上限 {LIMITS['body']} 字")

    builtin = get(skill_id, key)
    if builtin and builtin.get("builtin"):
        raise ValueError("这是内置技能，换个 id 另建一条（内置那份不可改）")

    user_dir = _user_dir(key)
    existing = sorted(user_dir.glob("*.md")) if user_dir.exists() else []
    if not (user_dir / f"{skill_id}.md").exists() and len(existing) >= LIMITS["skills"]:
        raise ValueError(f"自建技能最多 {LIMITS['skills']} 条，先删几条再加")

    user_dir.mkdir(parents=True, exist_ok=True)
    text = (
        "---\n"
        f"id: {skill_id}\n"
        f"name: {name}\n"
        f"desc: {desc}\n"
        f"scope: {', '.join(scope)}\n"
        "---\n\n"
        f"{body}\n"
    )
    target = user_dir / f"{skill_id}.md"
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, target)
    reload_skills(key)
    return get(skill_id, key) or {}


def delete_skill(account: Any, skill_id: str) -> bool:
    """删一条自建 skill；内置的删不掉（抛 ValueError）。不存在返回 False。"""
    key = _account(account)
    target = str(skill_id or "").strip()
    if not _SKILL_ID_RE.match(target):
        raise ValueError("id 不合法")
    item = get(target, key)
    if not item:
        return False
    if item.get("builtin"):
        raise ValueError("内置技能删不掉（它随程序发布）")
    path = _user_dir(key) / f"{target}.md"
    if not path.exists():
        return False
    path.unlink()
    reload_skills(key)
    return True


def list_for_ui(account: Any = None) -> Dict[str, Any]:
    """设置页用：条目 + 每个模块有哪些候选（让人一眼看出该给谁挂）。"""
    items = all_skills(account)
    rows = [{
        "id": item["id"],
        "name": item["name"],
        "desc": item["desc"],
        "scope": list(item["scope"]),
        "chars": len(item["body"]),
        "builtin": bool(item.get("builtin")),
        "body": item["body"],
    } for item in items]
    by_module: Dict[str, List[str]] = {key: [] for key in MODULE_LABELS}
    for item in rows:
        for module in item["scope"]:
            by_module.setdefault(module, []).append(item["id"])
    return {
        "skills": rows,
        "byModule": by_module,
        "modules": MODULE_LABELS,
        "limits": dict(LIMITS),
    }


# ====== 路由载荷 ======

def _downstream_modules(downstream: Any) -> List[str]:
    out: List[str] = []
    if isinstance(downstream, list):
        for entry in downstream:
            module = str(entry.get("module") or "").strip() if isinstance(entry, dict) else str(entry or "").strip()
            if module in MODULE_LABELS and module not in out:
                out.append(module)
    return out


def menu_block(downstream: Any = None, account: Any = None) -> str:
    """分析步的候选卡：只列可能用得上的 skill，并要求正文前吐一行计划。

    downstream 非空（画布上已连好下游节点）时按模块过滤候选；为空（首问路径——
    模块节点是分析之后才建的）时列全部，由分析步自己决定建议哪些模块。
    """
    if not _enabled():
        return ""
    scopes = _downstream_modules(downstream)
    items: List[Dict[str, Any]] = []
    for skill in all_skills(account):
        usable = [s for s in skill["scope"] if (not scopes or s in scopes)]
        if not usable:
            continue
        row = dict(skill)
        row["usable"] = usable
        items.append(row)
    if not items:
        return ""

    lines = ["\n\n# 可挂的 skill 候选（这一步只决定「后面生成节点时挂不挂」，不改变你现在写概要的任务）"]
    for skill in items:
        labels = "、".join(MODULE_LABELS[s] for s in skill["usable"])
        lines.append(f"- id={skill['id']}｜{skill['name']}｜适用节点：{labels}｜{skill['desc']}")
    lines.append("")
    lines.append("怎么决定：")
    lines.append("- 逐条对照「适用节点」与描述：这道题确实落在某条的范围里，就把那条挂给对应节点；")
    lines.append("  明确不适用才跳过，不要因为「这步只写概要」就默认全部不挂——挂的是后面节点，不是这一步。")
    lines.append("- 挂法：在正文最前面单独输出一行（只此一行，不要解释、不要写进概要）：")
    lines.append('- <skill_plan>{"viz":"iso-cutaway"}</skill_plan>')
    lines.append("- 一条都不合适就输出 <skill_plan>none</skill_plan>。")
    lines.append("- 键用模块英文键：" + "、".join(f"{k}={v}" for k, v in MODULE_LABELS.items()) + "。")
    lines.append("- 严禁自创候选之外的 id；同一节点最多一条。")
    lines.append("- 这一行与「不要输出 XML 标签」「不要生成模块内容」不冲突：它只是一条调度记录，"
                 "不是模块正文，也不是概要的一部分。")
    return "\n".join(lines)


def requested_block(workflow_context: Any, account: Any = None) -> tuple:
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
    body = payload(skill_id, account)
    if not body:
        return ("", "")
    return ("\n\n" + body, skill_id)
