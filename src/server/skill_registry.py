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

第 5 版（2026-11-16 夜，管理面）加了三件事，都不改三段式本身：
- **开关**：全局 `router` 与单条 `disabled` 存 `data/users/<账号>/skills_state.json`
  （内容文件一个字节都不动，内置技能也能关）。关闭的条目不进候选、不投递、不进预览。
- **导入**：`parse_imports` 把 md 文本解析成条目（缺 front-matter 时用文件名/标题推断），
  前端让用户确认节点后再落盘；导入只是 `save_skill` 的批量外壳。
- **改内置**：允许用户用同 id 写一份自己的副本（合并规则本来就是「自建覆盖内置」），
  UI 标 `overridden` 并提供「恢复默认」＝删掉副本。此前直接拒绝，导致内置技能连名字
  都改不了。

开关：环境变量 `PHYMATHIA_SKILL_ROUTER=0/off/false` 仍是**最高优先级的硬关**（运维/测试用）；
没设时看账号的 state 文件（缺省＝开）。两者是「与」的关系。
"""

from __future__ import annotations

import hashlib
import json
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

STATE_FILE = "skills_state.json"
_state_lock = threading.Lock()
_state_cache: Dict[str, Dict[str, Any]] = {}


def _env_on() -> bool:
    return str(os.environ.get("PHYMATHIA_SKILL_ROUTER") or "").strip().lower() not in ("0", "off", "false")


def env_enabled() -> bool:
    """环境变量这一层的开关（运维硬关）。界面用它解释「为什么开了还是不生效」。"""
    return _env_on()


def _state_path(account: Any = None):
    """账号根目录下的 `skills_state.json`（与 skills/ 并列，不混进技能 md 里）。"""
    return resolve_paths(_account(account)).root / STATE_FILE


def read_state(account: Any = None) -> Dict[str, Any]:
    """账号的开关状态：``{"router": bool, "disabled": [id, ...]}``。

    与内容文件分开存（`skills_state.json`），因为内置技能住代码目录、只读，只有这样才能
    把「内置那条被我关了」表达出来。文件缺失/损坏一律当默认（全开），绝不抛错。
    """
    key = _account(account)
    path = _state_path(key)
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return {"router": True, "disabled": []}
    with _state_lock:
        cached = _state_cache.get(key)
        if cached and cached["mtime"] == mtime:
            return dict(cached["data"])
    data: Dict[str, Any] = {"router": True, "disabled": []}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        raw = {}
    if isinstance(raw, dict):
        disabled = raw.get("disabled")
        if isinstance(disabled, list):
            seen: List[str] = []
            for item in disabled:
                text = str(item or "").strip()
                if text and text not in seen:
                    seen.append(text)
            data["disabled"] = seen
        if "router" in raw:
            data["router"] = bool(raw.get("router"))
    with _state_lock:
        _state_cache[key] = {"mtime": mtime, "data": dict(data)}
    return data


def _write_state(account: Any, data: Dict[str, Any]) -> Dict[str, Any]:
    key = _account(account)
    path = _state_path(key)
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = {
        "router": bool(data.get("router", True)),
        "disabled": [str(item) for item in (data.get("disabled") or [])],
    }
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)
    with _state_lock:
        _state_cache.pop(key, None)
    return clean


def enabled(account: Any = None) -> bool:
    """路由链总开关：环境变量硬关优先，其次看账号 state（缺省开）。"""
    if not _env_on():
        return False
    return bool(read_state(account).get("router", True))


def set_router(account: Any, on: bool) -> bool:
    state = read_state(account)
    state["router"] = bool(on)
    return _write_state(account, state)["router"]


def set_skill_enabled(account: Any, skill_id: str, on: bool) -> bool:
    """单条开关。内置与自建都能关（只记 id，不动文件）。返回落盘后的状态。"""
    target = str(skill_id or "").strip()
    if not target:
        raise ValueError("缺少 id")
    if not get(target, account):
        raise ValueError(f"没有这条技能：{target}")
    state = read_state(account)
    disabled = [item for item in state["disabled"] if item != target]
    if not on:
        disabled.append(target)
    state["disabled"] = disabled
    _write_state(account, state)
    return bool(on)


def _disabled_set(account: Any = None) -> set:
    return set(read_state(account).get("disabled") or [])


def is_enabled(skill: Dict[str, Any]) -> bool:
    """条目级开关（不含全局开关）。"""
    return bool(skill.get("enabled", True))


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


def _base_skills(account: Any = None) -> List[Dict[str, Any]]:
    """合并后的条目（不带开关状态），按目录指纹缓存。"""
    key = _account(account)
    builtin_dir = _builtin_dir()
    user_dir = _user_dir(key)
    signature = (_dir_signature(builtin_dir), _dir_signature(user_dir))
    with _lock:
        cached = _cache.get(key)
        if cached and cached["sig"] == signature:
            return cached["items"]
    merged: Dict[str, Dict[str, Any]] = {}
    builtin_ids = set()
    for item in _read_dir(builtin_dir, builtin=True):
        builtin_ids.add(item["id"])
        item["source"] = "builtin"
        item["overridden"] = False
        merged[item["id"]] = item
    for item in _read_dir(user_dir, builtin=False):
        item["source"] = "user"
        # 同 id 有内置那份 → 这是用户覆盖出来的副本（可「恢复默认」）
        item["overridden"] = item["id"] in builtin_ids
        merged[item["id"]] = item
    items = [merged[i] for i in sorted(merged)]
    with _lock:
        _cache[key] = {"sig": signature, "items": items}
    return items


def all_skills(account: Any = None, only_enabled: bool = False) -> List[Dict[str, Any]]:
    """该账号的全部 skill：内置 + 自建（同 id 自建覆盖内置，按 id 排序）。

    `only_enabled=True` 时剔除被单条关掉的（路由/候选/预览都走这个口径）；
    设置页要列出全部（含关掉的），所以默认不过滤。
    """
    disabled = _disabled_set(account)
    out: List[Dict[str, Any]] = []
    for item in _base_skills(account):
        row = dict(item)
        row["enabled"] = item["id"] not in disabled
        if only_enabled and not row["enabled"]:
            continue
        out.append(row)
    return out


def reload_skills(account: Any = None) -> List[Dict[str, Any]]:
    """丢掉缓存重读（测试与运维用；正常读写已经按目录指纹自动失效）。"""
    with _lock:
        _cache.clear()
    with _state_lock:
        _state_cache.clear()
    return all_skills(account)


def by_scope(modules: Iterable[str] | None = None, account: Any = None) -> List[Dict[str, Any]]:
    """按模块键过滤 skill；不传或传空＝不过滤。关掉的条目不出现。"""
    wanted = {str(m).strip() for m in (modules or []) if str(m).strip() in MODULE_LABELS}
    items = all_skills(account, only_enabled=True)
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

    与内置同 id 时**允许**写入——合并规则本来就是「自建覆盖内置」，写出来的是用户自己的
    副本（`overridden=True`），升级不会把它盖回去；UI 上给「恢复默认」（删掉副本）出口。
    第 2 版曾直接拒绝，但那样连内置技能的名字/适用节点都改不了（用户实测提的需求）。
    """
    key = _account(account)
    # 只认环境变量硬关：账号级总开关是「现在别路由」，不该连编辑技能一起锁死
    if not _env_on():
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
    """删一条技能文件。返回是否真的删掉。

    - 自建：删掉它的 md；
    - 内置 + 有用户副本（改过）：删副本＝**恢复默认**（内置那份重新生效，仍是 True）；
    - 纯内置（没改过）：抛 ValueError——它随程序发布，只能关掉，不能删。

    第 2 版对所有内置一律抛错，用户改过内置之后就没有「反悔」入口了（用户实测提的需求）。
    """
    key = _account(account)
    target = str(skill_id or "").strip()
    if not _SKILL_ID_RE.match(target):
        raise ValueError("id 不合法")
    item = get(target, key)
    if not item:
        return False
    path = _user_dir(key) / f"{target}.md"
    if path.exists():
        path.unlink()
        reload_skills(key)
        return True
    if item.get("builtin"):
        raise ValueError("内置技能随程序发布，删不掉——可以用它右边的开关先关掉，或改成你自己的版本")
    return False


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
        "source": item.get("source") or ("builtin" if item.get("builtin") else "user"),
        "overridden": bool(item.get("overridden")),
        "enabled": bool(item.get("enabled", True)),
        "body": item["body"],
    } for item in items]
    # 分组只算「开着」的：关掉的技能不会出现在任何节点的候选里，放进分组会误导
    active = [row for row in rows if row["enabled"]]
    by_module: Dict[str, List[str]] = {key: [] for key in MODULE_LABELS}
    for item in active:
        for module in item["scope"]:
            by_module.setdefault(module, []).append(item["id"])
    return {
        "skills": rows,
        "byModule": by_module,
        "modules": MODULE_LABELS,
        "limits": dict(LIMITS),
        "enabled": enabled(account),
        "counts": {
            "total": len(rows),
            "enabled": len(active),
            "user": len([row for row in rows if row["source"] == "user"]),
            "disabled": len([row for row in rows if not row["enabled"]]),
        },
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
    if not enabled(account):
        return ""
    scopes = _downstream_modules(downstream)
    items: List[Dict[str, Any]] = []
    for skill in all_skills(account, only_enabled=True):
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
    lines.append('- <skill_plan>{"viz":"iso-cutaway","why":"这句话里要看到装置内部结构"}</skill_plan>')
    lines.append("- why 选填但强烈建议写：一句话（≤40 字）说清为什么挂这条，用户会在分析卡上点开看；"
                 "挂了多条时按节点用「；」分开写。")
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
    if not enabled(account) or not isinstance(workflow_context, dict):
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
    # 单条关掉的技能，即使旧快照的计划里还写着它也不注入
    if not item.get("enabled", True):
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
        "enabled": enabled(account),
        "notes": [],
    }

    if not enabled(account):
        out["notes"].append("技能路由已关闭，现在不会有任何技能被注入。")
        return out

    disabled = [item["id"] for item in all_skills(account) if not item.get("enabled", True)]
    if disabled:
        out["notes"].append(
            "已关闭的技能不参与预览：" + "、".join(disabled) + "（要试它们，先在列表里打开开关）。"
        )

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


# ====== 导入（2026-11-16 第 5 版：管理面）======
# 导入 = 「把一份 md 变成一条技能」的外壳，落盘仍走 save_skill（同一套校验，不做第二套）。
# 分两步：`parse_imports` 只解析给前端确认（改名字/节点/id），`import_skills` 才落盘。
# 这样「导入前能看见会发生什么」，也不用把 front-matter 规则抄一遍到 JS 里。

IMPORT_MAX = 20


def _slugify(text: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text or "").lower()).strip("-")[:41]


def _auto_id(raw: str, filename: str = "") -> str:
    """文件名能转成合法 id 就用它，否则给一个稳定的 import-xxxx（同名文件重复导入会覆盖自己）。"""
    stem = os.path.splitext(os.path.basename(str(filename or "")))[0]
    slug = _slugify(stem)
    if _SKILL_ID_RE.match(slug):
        return slug
    digest = hashlib.sha1(str(raw or "").encode("utf-8")).hexdigest()[:6]
    return f"import-{digest}"


def _plain_line(text: Any) -> str:
    """去掉 markdown 记号，用于从正文推断标题/描述。"""
    out = re.sub(r"^\s*[#>*+\-]+\s*", "", str(text or "")).strip()
    out = re.sub(r"[`*_]", "", out)
    return out.strip()


def _guess_meta(body: str) -> tuple:
    """返回 (标题候选, 描述候选)：标题取第一行，描述取第一条不是标题的正文行。"""
    title = ""
    desc = ""
    for line in str(body or "").splitlines():
        text = line.strip()
        if not text:
            continue
        plain = _plain_line(text)
        if not plain:
            continue
        if not title:
            title = plain
            continue
        if text.startswith("#"):
            continue
        desc = plain
        break
    return title, desc


def parse_import(text: Any, filename: str = "") -> Dict[str, Any]:
    """把一段 md 解析成「待确认的条目」。不落盘、不抛异常（问题放进 problems）。"""
    raw = str(text or "").replace("\r\n", "\n").strip()
    if not raw:
        return {"ok": False, "filename": filename, "problems": ["内容是空的"], "warnings": []}
    warnings: List[str] = []
    meta: Dict[str, str] = {}
    body = raw
    match = _FRONT_MATTER.match(raw)
    if match:
        for line in match.group(1).splitlines():
            if ":" in line:
                key, _, value = line.partition(":")
                meta[key.strip().lower()] = value.strip()
        body = raw[match.end():].strip()
        if not body:
            body = raw
            warnings.append("front-matter 后面没有正文，已把整段当正文")
    else:
        warnings.append("没有 front-matter，已按文件名与正文推断（可在这里直接改）")

    guess_title, guess_desc = _guess_meta(body)
    skill_id = str(meta.get("id") or "").strip().lower() or _auto_id(raw, filename)
    name = _plain_line(meta.get("name")) or guess_title \
        or os.path.splitext(os.path.basename(str(filename or "")))[0] or skill_id
    desc = _clean_line(meta.get("desc")) or guess_desc or guess_title
    scope = _parse_scope(meta.get("scope", ""))
    guessed_scope = False
    if not scope:
        hits = guess_modules(name + " " + desc + " " + body[:400])
        scope = [key for key in MODULE_LABELS if key in hits]
        guessed_scope = bool(scope)
        if guessed_scope:
            warnings.append(
                "没写适用节点，已按内容猜成：" + "、".join(MODULE_LABELS[s] for s in scope) + "（导入前请确认）"
            )
        else:
            warnings.append("没写适用节点，也没猜出来——导入前至少勾一个")

    problems: List[str] = []
    if not _SKILL_ID_RE.match(skill_id):
        problems.append("id 不合法：小写字母开头，只能有字母数字与连字符（2–41 位）")
    if not name:
        problems.append("缺技能名")
    if len(name) > LIMITS["name"]:
        problems.append(f"技能名太长（{len(name)} 字，上限 {LIMITS['name']}）")
    if not desc:
        problems.append("缺一句话描述（模型靠它判断挂不挂）")
    if len(desc) > LIMITS["desc"]:
        problems.append(f"描述太长（{len(desc)} 字，上限 {LIMITS['desc']}）")
    if not scope:
        problems.append("没选适用节点")
    if len(body) > LIMITS["body"]:
        problems.append(f"正文太长（{len(body)} 字，上限 {LIMITS['body']}）")

    return {
        "ok": not problems,
        "filename": str(filename or ""),
        "id": skill_id,
        "name": name[:LIMITS["name"]],
        "desc": (desc or "")[:LIMITS["desc"]],
        "scope": scope,
        "body": body,
        "chars": len(body),
        "guessedScope": guessed_scope,
        "warnings": warnings,
        "problems": problems,
    }


def parse_imports(texts: Any, account: Any = None) -> Dict[str, Any]:
    """批量解析（导入前预览）。`texts` 接受字符串或 `{name, text}`，返回逐条结论。"""
    rows = texts if isinstance(texts, list) else []
    if len(rows) > IMPORT_MAX:
        raise ValueError(f"一次最多导入 {IMPORT_MAX} 条")
    existing = {item["id"]: item for item in all_skills(account)}
    entries: List[Dict[str, Any]] = []
    for row in rows:
        if isinstance(row, dict):
            text = row.get("text")
            filename = row.get("name") or row.get("filename") or ""
        else:
            text, filename = row, ""
        parsed = parse_import(text, filename)
        if parsed.get("ok") and parsed.get("id") in existing:
            prev = existing[parsed["id"]]
            parsed["conflict"] = "builtin" if prev.get("builtin") else "user"
            parsed["conflictName"] = prev.get("name") or ""
        entries.append(parsed)
    return {"ok": True, "entries": entries, "limits": dict(LIMITS), "max": IMPORT_MAX}


def import_skills(account: Any, skills: Any) -> Dict[str, Any]:
    """把前端确认过的条目落盘。逐条走 save_skill，失败不中断其余条目。"""
    rows = skills if isinstance(skills, list) else []
    if not rows:
        raise ValueError("没有要导入的技能")
    if len(rows) > IMPORT_MAX:
        raise ValueError(f"一次最多导入 {IMPORT_MAX} 条")
    imported: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            failed.append({"id": "", "reason": "条目格式不对"})
            continue
        try:
            saved = save_skill(account, row)
        except ValueError as exc:
            failed.append({"id": str(row.get("id") or ""), "reason": str(exc)})
            continue
        imported.append({
            "id": saved.get("id", ""),
            "name": saved.get("name", ""),
            "scope": saved.get("scope", []),
            "chars": len(saved.get("body", "")),
            "overridden": bool(saved.get("overridden")),
        })
    return {"ok": True, "imported": imported, "failed": failed}
