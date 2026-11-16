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

# 「试一条」（`preview`）用的模块关键词表：**只做粗筛，不是判定**。
# 预览要零 token，所以不能问模型「这题该挂哪些节点」，只能用字面锚点猜一个模块集合，
# 再拿它去 `by_scope` 过滤候选。锚点一律两字以上——单字（力、场、功）在中文里到处撞词
# （能力、现场、功能），会把数学题也拖进物理候选，反而比不猜更误导。
MODULE_KEYWORDS = {
    "physics": [
        "受力", "加速度", "位移", "摩擦力", "斜面", "重力", "弹力", "动量", "冲量",
        "电势", "电流", "电压", "电阻", "电容", "磁场", "磁通", "电感", "电场",
        "波长", "频率", "折射", "反射", "透镜", "压强", "浮力", "热力学", "熵变",
        "简谐", "振动", "单摆", "圆周运动", "洛伦兹", "光电效应", "衰变", "理想气体",
    ],
    "math": [
        "函数", "方程", "不等式", "求导", "导数", "微分", "积分", "极限", "级数",
        "数列", "通项", "递推", "矩阵", "行列式", "特征值", "向量", "概率", "期望",
        "方差", "排列组合", "二项式", "三角函数", "对数", "指数", "复数", "集合",
        "映射", "同构", "证明", "定理", "归纳法", "圆锥曲线", "椭圆", "双曲线",
        "抛物线", "立体几何", "解析几何",
    ],
    "graph": ["关系", "区别", "对比", "分类", "体系", "脉络", "知识结构", "概念图", "类比"],
    "viz": [
        "发动机", "四冲程", "齿轮", "活塞", "曲轴", "连杆", "气缸", "传动", "液压",
        "阀门", "光路", "机芯", "剖视", "内部结构", "装配", "三视图", "动画",
        "可视化", "交互", "演示", "示意", "模拟",
    ],
    "socratic": ["为什么", "怎么理解", "本质", "直觉", "追问", "引导我", "提示我"],
    "learn": ["进阶", "拓展", "延伸", "深入", "相关领域", "前沿", "文献"],
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

def _clean_line(value: Any) -> str:
    """只做空白归一（换行收成空格），**不截断**——截断会让人以为存全了。

    长度校验在 `save_skill` 里显式做：超限抛 ValueError（400 中文原因），
    与 `LIMITS` 的承诺一致（backlog 476①）。
    """
    return str(value or "").replace("\r", " ").replace("\n", " ").strip()


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
    name = _clean_line(data.get("name"))
    desc = _clean_line(data.get("desc"))
    body = str(data.get("body") or "").replace("\r\n", "\n").strip()
    # 适用范围可能来自手写请求：列表里混数字/None 时逐个转串，别让 join 抛 500（backlog 476③）
    raw_scope = data.get("scope")
    if isinstance(raw_scope, list):
        raw_scope = ",".join(str(item or "") for item in raw_scope)
    scope = _parse_scope(raw_scope)
    if not name:
        raise ValueError("请填写技能名")
    if len(name) > LIMITS["name"]:
        raise ValueError(f"技能名太长（{len(name)} 字），上限 {LIMITS['name']} 字")
    if not desc:
        raise ValueError("请填写一句话适用描述（用来判断什么时候挂它）")
    if len(desc) > LIMITS["desc"]:
        raise ValueError(f"描述太长（{len(desc)} 字），上限 {LIMITS['desc']} 字——写清「什么题用它」就够")
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

    **适用范围是硬护栏**（backlog 476②）：计划把「剖视画法」挂到数学节点上时，这里
    直接不注入——「适用范围」不能只在候选卡里当提示，投递端必须自己也判一次。
    判据取两处：计划里的 module、`target.module`；两处都缺就不判（旧快照兼容）。
    """
    if not _enabled() or not isinstance(workflow_context, dict):
        return ("", "")
    raw = workflow_context.get("skill")
    skill_id = ""
    module = ""
    if isinstance(raw, dict):
        skill_id = str(raw.get("id") or raw.get("skill") or "").strip()
        module = str(raw.get("module") or "").strip()
    elif isinstance(raw, str):
        skill_id = raw.strip()
    if not skill_id:
        return ("", "")
    item = get(skill_id, account)
    if not item:
        return ("", "")
    if not module:
        target = workflow_context.get("target")
        if isinstance(target, dict):
            module = str(target.get("module") or "").strip()
    if module in MODULE_LABELS and module not in item["scope"]:
        return ("", "")
    return ("\n\n" + item["body"], skill_id)


# ====== 「试一条」预览（2026-11-16 第 3 版）======

def guess_modules(question: Any) -> Dict[str, List[str]]:
    """从问题里猜出涉及哪几个模块，返回 {模块键: 命中的关键词}。

    **这是粗筛，不是判定**：预览要零 token，不能问模型；关键词只用来决定「拿哪些模块
    去 `by_scope` 过滤」，让「问数学题不会看到交互可视化的候选」这类直觉成立。
    真实路由仍由分析步的模型看候选卡决定，两者不要混为一谈。
    """
    text = str(question or "")
    hits: Dict[str, List[str]] = {}
    if not text.strip():
        return hits
    for module, words in MODULE_KEYWORDS.items():
        matched = [word for word in words if word in text]
        if matched:
            hits[module] = matched
    return hits


def preview(question: Any, modules: Iterable[str] | None = None, account: Any = None) -> Dict[str, Any]:
    """「这条技能会不会被选中 / 注入多少字 / 实际注入什么」——不跑模型。

    回答的是**候选层**：这条问题会让哪些 skill 进入候选卡、若挂上会追加多少字、追加的
    正文是什么。候选里具体挂不挂仍由分析步的模型决定（`menu_block` 那段），这里不猜。

    `modules` 给了就按给的过滤（`module_source="explicit"`）；没给就按 `guess_modules`
    猜；一个关键词都没命中时按全部节点列出（`module_source="all"`）——那种问题属于
    「模型自己看着办」，报「空候选」会让人误以为技能永远用不上。
    """
    text = str(question or "").strip()
    explicit: List[str] = []
    for raw in (modules or []):
        key = str(raw or "").strip()
        if key in MODULE_LABELS and key not in explicit:
            explicit.append(key)

    if explicit:
        targets = explicit
        source = "explicit"
        matched: Dict[str, List[str]] = {key: [] for key in explicit}
    else:
        matched = guess_modules(text)
        if matched:
            targets = [key for key in MODULE_LABELS if key in matched]
            source = "keywords"
        else:
            targets = list(MODULE_LABELS)
            source = "all"

    out: Dict[str, Any] = {
        "question": text,
        "modules": targets,
        "moduleSource": source,
        "matched": matched,
        "candidates": [],
        "totalChars": 0,
        "enabled": _enabled(),
        "notes": [],
    }

    if not _enabled():
        out["notes"].append("技能路由已关闭（PHYMATHIA_SKILL_ROUTER=0），现在不会有任何技能被注入。")
        return out

    if source == "keywords":
        pairs = "、".join(
            f"{MODULE_LABELS[key]}（{'/'.join(matched[key])}）" for key in targets
        )
        out["notes"].append(f"按问题里的字面词认出这些节点：{pairs}。")
    elif source == "all":
        out["notes"].append(
            "问题里没有命中任何模块关键词，按全部 6 个节点列出候选——真实判定由分析步的模型做。"
        )
    else:
        out["notes"].append("节点由请求指定（modules 参数），未按问题推断。")

    total = 0
    for item in by_scope(targets, account):
        usable = [key for key in item["scope"] if key in targets]
        if not usable:
            continue
        # 真到节点上注入时走的就是同一个函数（含 "\n\n" 前缀），预览不做第二套算法
        block, _ = requested_block({"skill": {"id": item["id"], "module": usable[0]}}, account)
        if not block:
            continue
        total += len(block)
        out["candidates"].append({
            "id": item["id"],
            "name": item["name"],
            "desc": item["desc"],
            "scope": list(item["scope"]),
            "builtin": bool(item.get("builtin")),
            "usable": usable,
            "usableLabels": [MODULE_LABELS[key] for key in usable],
            "chars": len(block),
            "text": block,
        })
    out["totalChars"] = total

    if not out["candidates"]:
        out["notes"].append(
            "没有候选：这些节点上一条技能都没有，模型这次看不到任何技能正文。"
            "换一个问题、或把技能的「适用节点」勾上这些节点再看。"
        )
    else:
        out["notes"].append(
            "预览只回答「会不会进候选卡」——候选里到底挂不挂，由分析步的模型看题目决定，"
            "这里不跑模型（零 token）。"
        )
    return out
