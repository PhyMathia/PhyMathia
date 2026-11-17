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

第 6 版（2026-11-17，目录型）只改「怎么读」，三段式与开关一律不动：

- **目录型 skill**：`skills/<id>/`，里面放 `phymathia.md`（本项目格式的适配层）即算
  「已适配」；只有上游原版 `SKILL.md` 的目录会出现在列表里但标「待适配」，scope 与
  正文都为空，因此不进候选、不被投递。
- **为什么要有适配层**：Claude Code 式 skill 的正文全是「读 examples/、跑 build.mjs、
  开 Chrome 目检」——本宿主没有这些工具，原样注入会让模型编造已执行的步骤。适配层
  是把它翻译成「模型真能照做的契约」（见 `src/skills/anatomy/SOURCE.md` 的对照表）。
- **只下探一层**：上游仓库里有 kit/、examples/、references/ 上百个 md，递归会把它们
  全当 skill 读进来。
- **合并优先级**：用户移入的原版目录若没有适配层，不覆盖已适配的同 id 条目（内置版
  继续生效），只在 `list_for_ui` 里报 `shadowed` 说明原因。
- **目录型不走接口删**：里面可能是几十 MB 用户数据，`DELETE` 只回一句中文提示让人
  自己在文件管理器删（删完按指纹自动失效）。
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
# desc 第 8 版从 120 放宽到 256（2026-11-17 用户拍板：不用对齐主流的 1024）——
# 主流 description 常写到 300+ 字，那是给「全量标签常驻」的宿主用的；我们候选卡
# 每次只现拼几条，描述长到几百字反而稀释判断信号。导入路径对超长单独做截断+提示，
# 手写/编辑路径仍超限即拒。
LIMITS = {
    "name": 40,
    "desc": 256,
    "body": 20000,
    "skills": 40,
}

DESC_MAX = LIMITS["desc"]
# 候选卡里每条技能最多展示这么多字（存储 256，卡面给 200 就够判断了）
CARD_DESC_MAX = 200
# 原版 SKILL.md 直用时自动加的护栏：它可能写着「跑 build.mjs」「开浏览器 4× 目检」这类
# 本宿主做不到的步骤，不声明清楚模型会编造「我已经跑过了」。
HOST_GUARD = (
    "（宿主能力说明：本宿主只能生成文字与 HTML，不执行命令、不开浏览器、不联网下载、"
    "不调用外部工具。下面这段里要求运行脚本／编译／截图校对的步骤一律跳过，"
    "不要声称已经执行过。）\n\n"
)
_SKILL_ID_RE = re.compile(r"^[a-z][a-z0-9-]{1,40}$")
_FRONT_MATTER = re.compile(r"^---\s*\n(.*?)\n---\s*\n?", re.S)

# ====== 目录型 skill（第 6 版，2026-11-17）======
# 形态：`skills/<id>/`，里面
#   phymathia.md  ← 本地适配层（本项目格式，有 front-matter；有它才算「已适配」）
#   SKILL.md      ← 原版入口（Claude Code 式 YAML front-matter，只用来取名字/描述）
#   references/   ← 原版参考资料，**当前不读**（档 1「按需读文件」才用得上）
# 用户把上游仓库整个移进来即可：能识别、能出现在列表里、能关，但没适配层不注入。
DIR_ADAPT_FILE = "phymathia.md"
DIR_ENTRY_FILES = ("SKILL.md", "skill.md")
_DIR_SKIP = {
    "node_modules", "kit", "references", "examples", "tests", "evals", "docs",
    "agents", "film", "sims", "sfx", "assets", "dist", "out", "build", "src",
}

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


def _clean_scope_map(raw: Any) -> Dict[str, List[str]]:
    """把 state 里的 `scope` 表收成 `{id: [模块键]}`，脏值一律丢掉（不抛错）。"""
    out: Dict[str, List[str]] = {}
    if not isinstance(raw, dict):
        return out
    for key, value in raw.items():
        skill_id = str(key or "").strip()
        if not skill_id:
            continue
        if isinstance(value, str):
            value = re.split(r"[,，\s]+", value)
        if not isinstance(value, list):
            continue
        scope = [part for part in (str(item or "").strip() for item in value) if part in MODULE_LABELS]
        uniq: List[str] = []
        for part in scope:
            if part not in uniq:
                uniq.append(part)
        if uniq:
            out[skill_id] = uniq
    return out


def read_state(account: Any = None) -> Dict[str, Any]:
    """账号的开关与「手动指定范围」状态。

    形状：``{"router": bool, "disabled": [id, ...], "scope": {id: [模块键]}}``。

    与内容文件分开存（`skills_state.json`），因为内置技能住代码目录、只读，只有这样才能
    把「内置那条被我关了」「这条装来的技能我指定给交互可视化」表达出来——**不动别人的
    文件一个字节**。文件缺失/损坏一律当默认（全开、无指定），绝不抛错。
    """
    key = _account(account)
    path = _state_path(key)
    try:
        mtime = path.stat().st_mtime_ns
    except OSError:
        return {"router": True, "disabled": [], "scope": {}}
    with _state_lock:
        cached = _state_cache.get(key)
        if cached and cached["mtime"] == mtime:
            return dict(cached["data"])
    data: Dict[str, Any] = {"router": True, "disabled": [], "scope": {}}
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
        data["scope"] = _clean_scope_map(raw.get("scope"))
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
        "scope": _clean_scope_map(data.get("scope")),
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


def set_skill_scope(account: Any, skill_id: str, modules: Any) -> List[str]:
    """人手动指定一条技能的适用节点（第 8 版）。

    为什么要这条：主流技能包里没有「适用节点」这个概念，装进来的包几乎都缺 scope。
    按旧规则它们会被整条丢掉（悄悄不生效）；现在的做法是列表里留一条「请指定适用节点」，
    由人点一下，结果写进 `skills_state.json`——**不动别人的 md 一个字节**，卸载时也不会
    把人家的文件改脏。传空列表＝撤销指定，回到「待指定」。
    """
    target = str(skill_id or "").strip()
    if not target:
        raise ValueError("缺少 id")
    if not get(target, account):
        raise ValueError(f"没有这条技能：{target}")
    if isinstance(modules, str):
        raw = modules
    else:
        raw = ",".join(str(item or "") for item in (modules or []))
    scope = _parse_scope(raw)
    state = read_state(account)
    table = dict(state.get("scope") or {})
    if scope:
        table[target] = scope
    else:
        table.pop(target, None)
    state["scope"] = table
    _write_state(account, state)
    return scope


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


def _front_meta(text: str) -> tuple:
    """拆 front-matter：返回 (meta, 正文)。没有 front-matter 时 meta 为空、正文是全文。

    第 8 版起支持**一层缩进嵌套**（主流 Agent Skills 的写法）：

        name: pdf-processing
        description: 抽出 PDF 文本与表格
        metadata:
          title: PDF 处理          ← 缩进两格的子键挂到 metadata 下面
          scope: viz

    只认一层——深一层没人用，反而容易把正文里的缩进列表误读成元数据。
    顶层值仍然是字符串，空值键后面没跟子项时退化成空串，调用方不必判类型。
    """
    match = _FRONT_MATTER.match(text)
    if not match:
        return {}, text.strip()
    meta: Dict[str, Any] = {}
    parent = ""
    for raw in match.group(1).splitlines():
        if not raw.strip() or raw.strip().startswith("#") or ":" not in raw:
            continue
        indented = raw[:1] in (" ", "\t")
        key, _, value = raw.partition(":")
        key = key.strip().lower()
        value = value.strip().strip('"').strip("'")
        if indented and parent:
            slot = meta.get(parent)
            if isinstance(slot, dict) and key:
                slot[key] = value
            continue
        if not value:
            meta[key] = {}
            parent = key
        else:
            meta[key] = value
            parent = ""
    for key, value in list(meta.items()):
        if isinstance(value, dict) and not value:
            meta[key] = ""
    return meta, text[match.end():].strip()


def _meta_text(meta: Dict[str, Any], *keys: str) -> str:
    """按顺序取第一个非空的顶层字符串值（值是 dict 时跳过）。"""
    for key in keys:
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _meta_sub(meta: Dict[str, Any], name: str, *keys: str) -> str:
    """取 `name:` 缩进子项里的第一个非空值（扩展字段惯例挂在 metadata 下）。"""
    slot = meta.get(name)
    if not isinstance(slot, dict):
        return ""
    for key in keys:
        value = str(slot.get(key) or "").strip()
        if value:
            return value
    return ""


def _yaml_scalar(value: Any) -> str:
    """写回 md 时给值加必要引号，保证生成的文件是合法 YAML（主流工具能读）。"""
    text = _clean_line(value)
    if not text:
        return '""'
    if re.search(r":\s|[#\[\]{}]", text) or re.match(r"^[-*?&!|>%@`]|\s", text):
        return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return text


def _parse_skill(text: str, builtin: bool = False) -> Dict[str, Any] | None:
    """解析一份 md。字段兼容两种写法（第 8 版）：

    | 含义 | 本地写法 | 主流写法 |
    |---|---|---|
    | 唯一标识 | `id: iso-cutaway` | `name: iso-cutaway`（与文件名/目录名一致） |
    | 中文显示名 | `name: 等距剖视画法` | `metadata.title: 等距剖视画法` |
    | 一句话描述 | `desc: …` | `description: …` |
    | 适用节点 | `scope: viz` | `metadata.scope: viz`（主流没有这个字段，塞进 metadata） |

    **没有适用节点不再整条丢弃**（第 8 版，用户拍板）：条目照常可见、可开关，
    但在人指定节点之前不参与候选与注入（`needs_scope=True`）。这样装进来的主流包
    不会「悄悄不生效」，也不会被乱挂到不相关节点。
    """
    meta, body = _front_meta(text)
    if not meta:
        return None
    skill_id = (_meta_text(meta, "id") or _meta_text(meta, "name")).strip().lower()
    if not _SKILL_ID_RE.match(skill_id) or not body:
        return None
    raw_scope = _meta_text(meta, "scope")
    scope = _parse_scope(raw_scope) if raw_scope else _parse_scope(_meta_sub(meta, "metadata", "scope"))
    raw_name = _meta_text(meta, "name")
    title = _meta_sub(meta, "metadata", "title", "displayname") or _meta_text(meta, "title")
    # 旧写法里 name 就是中文显示名；主流写法里 name 是 slug，中文名在 metadata.title
    display = title or (raw_name if raw_name and not _SKILL_ID_RE.match(raw_name.lower()) else "") or skill_id
    return {
        "id": skill_id,
        "name": display[:LIMITS["name"]],
        "desc": (_meta_text(meta, "description", "desc")
                 or _meta_sub(meta, "metadata", "description"))[:DESC_MAX],
        "scope": scope,
        "body": body,
        "builtin": builtin,
        "needs_scope": not scope,
        "scope_source": "file" if raw_scope else ("metadata" if scope else ""),
    }


def _dir_children(path):
    """skills 根目录下的一层子目录（跳过隐藏目录与已知的非 skill 目录）。

    只下探一层是**故意的**：`F:\\skill\\anatomy` 这种上游仓库里有 kit/、examples/、
    references/ 十几个目录、上百个 md，无限递归会把它们全当成 skill 读进来。
    """
    try:
        return [p for p in sorted(path.iterdir())
                if p.is_dir() and not p.name.startswith(".") and p.name.lower() not in _DIR_SKIP]
    except Exception:
        return []


def _dir_signature(path) -> tuple:
    """目录指纹：(文件名, mtime_ns, size)。外部改文件/加文件都会让它变。

    第 6 版起也覆盖一层子目录里的那个入口文件，否则用户换掉 `phymathia.md` 后
    缓存不会失效（要重启才生效，是最容易让人以为「改了没用」的坑）。
    """
    try:
        rows = []
        for item in sorted(path.glob("*.md")):
            try:
                stat = item.stat()
            except OSError:
                continue
            rows.append((item.name, stat.st_mtime_ns, stat.st_size))
        for sub in _dir_children(path):
            for name in (DIR_ADAPT_FILE,) + DIR_ENTRY_FILES:
                entry = sub / name
                try:
                    if entry.is_file():
                        stat = entry.stat()
                        rows.append((f"{sub.name}/{name}", stat.st_mtime_ns, stat.st_size))
                        break
                except OSError:
                    continue
        return tuple(rows)
    except Exception:
        return ()


def _entry_file(sub):
    """子目录里代表这条 skill 的文件：适配层优先，其次原版入口。返回 (path, 是否适配层)。"""
    adapt = sub / DIR_ADAPT_FILE
    try:
        if adapt.is_file():
            return adapt, True
    except OSError:
        pass
    for name in DIR_ENTRY_FILES:
        entry = sub / name
        try:
            if entry.is_file():
                return entry, False
        except OSError:
            continue
    return None, False


def _dir_skill_id(sub, meta: Dict[str, Any]) -> str:
    """目录型条目的 id：front-matter 的 id 优先，其次目录名 slug，最后 name/title slug。

    主流规范要求 `name` 与父目录同名，正常情况三者一致；不一致时以目录为准（磁盘上
    真正的唯一性来源），中文目录转不出 slug 才退回 front-matter 里的名字。
    """
    raw = _meta_text(meta, "id").strip().lower()
    if raw and _SKILL_ID_RE.match(raw):
        return raw
    for candidate in (sub.name, _meta_text(meta, "name"), _meta_text(meta, "title")):
        slug = re.sub(r"[^a-z0-9]+", "-", str(candidate or "").lower()).strip("-")[:41].strip("-")
        if _SKILL_ID_RE.match(slug):
            return slug
    return ""


def _read_one_dir(sub, builtin: bool) -> Dict[str, Any] | None:
    """读一个 `skills/<id>/` 目录，产出条目（适配层 / 原版直用 / 待指定 / 超限）。

    - 有 `phymathia.md` → 走本地适配层（`adapted=True`），正文就是它；
    - 只有原版 `SKILL.md` → **原版直用**（第 8 版，与主流生态接轨）：正文照用，但注入时
      前面加一句宿主能力声明（`HOST_GUARD`），压住「跑 build.mjs」「开浏览器目检」这类
      本宿主做不到的步骤，免得模型编造已经执行过；
    - 入口文件连 front-matter 都没有 → 只留一个可见可开关的壳，正文为空、永不注入；
    - 缺适用节点 → `needs_scope=True`：可见、可开关，等人指定节点后才参与路由（第 8 版：
      不再因为「没写 scope」就把整条丢掉——那是装进来的主流包最常见的形态）；
    - 正文超 `LIMITS["body"]` → 清空正文与范围，标 `oversize`（不做静默截断）。
    """
    entry, adapted = _entry_file(sub)
    if entry is None:
        return None
    try:
        text = entry.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    meta, raw_body = _front_meta(text)
    item = _parse_skill(text, builtin=builtin)
    if item is None:
        # front-matter 不合规（最常见：`name: Upstream Demo` 带空格，规范要求是 slug）。
        # 只要入口文件里还有正文，就按「原版直用」收下——正文能注入，等人指定节点；
        # 连正文都没有才当一个纯壳子（可见可开关，永不注入）。
        skill_id = _dir_skill_id(sub, meta)
        if not skill_id:
            return None
        has_body = bool(str(raw_body or "").strip())
        return {
            "id": skill_id,
            "name": (_meta_sub(meta, "metadata", "title")
                     or _meta_text(meta, "name") or sub.name)[:LIMITS["name"]],
            "desc": (_meta_text(meta, "description", "desc")
                     or _meta_sub(meta, "metadata", "description"))[:DESC_MAX],
            "scope": [],
            "body": raw_body if has_body else "",
            "builtin": builtin,
            "layout": "dir",
            "dir": str(sub.name),
            "adapted": False,
            "needs_scope": True,
            "needs_adapt": not has_body,
        }
    item["layout"] = "dir"
    item["dir"] = str(sub.name)
    item["adapted"] = bool(adapted)
    if len(item["body"]) > LIMITS["body"]:
        item["body"] = ""
        item["scope"] = []
        item["needs_scope"] = True
        item["adapted"] = False
        item["oversize"] = True
        item["needs_adapt"] = True
    return item


def _read_dir(path, builtin: bool) -> List[Dict[str, Any]]:
    """读一个 skills 根目录：顶层 `*.md`（第 1–5 版写法）+ 一层子目录（第 6 版）。

    同 id 时子目录覆盖顶层 md——目录能带 `references/`，是更完整的形态。
    """
    found: Dict[str, Dict[str, Any]] = {}
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
            parsed["layout"] = "file"
            parsed["adapted"] = True
            found[parsed["id"]] = parsed
    for sub in _dir_children(path):
        item = _read_one_dir(sub, builtin)
        if item:
            found[item["id"]] = item
    return list(found.values())


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
        prev = merged.get(item["id"])
        if prev and prev.get("adapted") and not item.get("adapted"):
            # 用户把上游原版整个移进来（没有 phymathia.md）时，别让它顶掉已经能用的那份。
            # 只在 prev 上记一笔，设置页据此说明「这个目录缺适配层，按内置的版本在用」。
            prev["shadowed"] = {"dir": item.get("dir") or "", "needs_adapt": True}
            continue
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

    第 8 版在这里叠「人手动指定的适用节点」（`skills_state.json` 的 `scope`）：
    内容文件里没写 scope 的主流包，由人指定后照样能参与候选与注入，而且不用改人家的文件。
    """
    state = read_state(account)
    disabled = set(state.get("disabled") or [])
    overrides = state.get("scope") or {}
    out: List[Dict[str, Any]] = []
    for item in _base_skills(account):
        row = dict(item)
        override = overrides.get(item["id"])
        if override:
            row["scope"] = list(override)
            row["needs_scope"] = False
            row["scope_source"] = "override"
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


def skill_dir(skill_id: str, account: Any = None):
    """该 skill 的目录（只有目录型有）；文件型或查不到返回 None。

    第 7 版给 `skill_refs` 用：参考资料住在 `<skill 目录>/references/`，这里负责
    回答「这个 id 的目录到底在哪个根下」（内置在 `src/skills`，自建在账号目录）。
    越界一律 None——`dir` 字段来自真实目录名，但不赌它一定干净。
    """
    item = get(skill_id, account)
    if not item or item.get("layout") != "dir":
        return None
    name = str(item.get("dir") or item["id"])
    base = _user_dir(_account(account)) if item.get("source") == "user" else _builtin_dir()
    sub = base / name
    try:
        if not sub.is_dir():
            return None
        root = os.path.realpath(str(base))
        if os.path.commonpath([root, os.path.realpath(str(sub))]) != root:
            return None
    except Exception:
        return None
    return sub


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
    if (user_dir / skill_id).is_dir():
        # 目录型技能写的是 `skills/<id>/phymathia.md`，这里再写一个 `<id>.md` 会被目录覆盖，
        # 变成「改了没生效」。宁可明确拒绝，也不让用户白改。
        raise ValueError(
            f"这个技能是目录型（skills/{skill_id}/），请直接编辑它目录里的 phymathia.md，"
            "设置页只做改名/描述这类轻量修改不适用于它"
        )
    existing = list(user_dir.glob("*.md")) if user_dir.exists() else []
    dir_count = len(_dir_children(user_dir)) if user_dir.exists() else 0
    if not (user_dir / f"{skill_id}.md").exists() and len(existing) + dir_count >= LIMITS["skills"]:
        raise ValueError(f"自建技能最多 {LIMITS['skills']} 条，先删几条再加")

    user_dir.mkdir(parents=True, exist_ok=True)
    # 写出来的 front-matter 直接是**主流形状**（name / description + metadata 扩展字段）：
    # name 用 slug（与文件名一致，符合规范对 name 的约束），中文名放 metadata.title，
    # 本地特有的「适用节点」塞进 metadata.scope——主流工具读到未知的 metadata 键不会报错。
    # 这样把这份 md 改个名字放进 `<id>/SKILL.md` 就能被别的宿主直接吃。
    text = (
        "---\n"
        f"name: {skill_id}\n"
        f"description: {_yaml_scalar(desc)}\n"
        "metadata:\n"
        f"  title: {_yaml_scalar(name)}\n"
        f"  scope: {', '.join(scope)}\n"
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
    if item.get("layout") == "dir":
        # 目录型（用户整个移入的上游仓库）一律不走接口删：里面可能有几十 MB 用户数据，
        # 静默 rmtree 是不可逆的。让用户自己在文件管理器里删，删完注册表按指纹自动失效。
        if item.get("builtin"):
            raise ValueError("内置目录型技能随程序发布，删不掉——可以先把开关关掉")
        where = f"data/users/{key}/skills/{item.get('dir') or target}"
        raise ValueError(f"目录型技能请手动删除整个文件夹：{where}")
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
        # 第 6 版：目录型/md 型、是否已适配、超限、以及「用户移入的原版被内置版挡住」
        "layout": item.get("layout") or "file",
        "dir": item.get("dir") or "",
        "adapted": bool(item.get("adapted", True)),
        "needsAdapt": bool(item.get("needs_adapt")),
        "oversize": bool(item.get("oversize")),
        "shadowed": dict(item["shadowed"]) if isinstance(item.get("shadowed"), dict) else None,
        # 第 8 版：缺适用节点（装进来的主流包常见）——列表里要提示人去指定，不能静默不生效
        "needsScope": bool(item.get("needs_scope")),
        "scopeSource": item.get("scope_source") or "",
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
            "needsScope": len([row for row in rows if row["needsScope"]]),
        },
    }


# ====== 能力清单（第 9 版，2026-11-17：创造模式造 skill 的「查」端）======
# 与 `harness/recipes.py::recipe_capabilities` 同一范式：枚举、上限、路径一律从属主
# 常量反射，绝不手抄第二份。将来的技能工坊（Φ 的造技能相位）提示词与工具都从这里取
# 说明书——格式一改这里自动跟上，不会出现「指南说 120 字、校验器说 256 字」各说各话。
# 对应设计口径见 docs/dev/skills.md 第 9 版。
BODY_SECTIONS = ("适用", "不适用", "若采用按什么做", "红线")
PLAN_TAG = "skill_plan"
PLAN_WHY_MAX = 40


def capabilities(account: Any = None) -> Dict[str, Any]:
    """技能系统的能力清单：模型「查着写」的唯一事实源（零 IO、零模型调用）。

    回答三件事：**格式长什么样**（front-matter 键、正文结构、计划块）、**约束是多少**
    （id 规则、`LIMITS`、候选卡截断）、**现在库里有什么**（id 清单用来查重、目录型提示
    别去写）。`existing` 只给摘要，不带正文——正文可能是两万字，工具要用再按 id 取。
    """
    key = _account(account)
    items = all_skills(key)
    rows = [{
        "id": item["id"],
        "name": item["name"],
        "desc": item["desc"],
        "scope": list(item["scope"]),
        "layout": item.get("layout") or "file",
        "enabled": bool(item.get("enabled", True)),
        "builtin": bool(item.get("builtin")),
        "overridden": bool(item.get("overridden")),
        "needsScope": bool(item.get("needs_scope")),
    } for item in items]
    return {
        "format": {
            # 第 8 版起写的就是主流形状：一份 md 两边宿主都能读
            "frontMatter": {
                "name": "技能 id（小写 slug，必须与文件名/目录名一致）",
                "description": "一句话「做什么＋什么时候用」，进候选卡",
                "metadata.title": "中文显示名",
                "metadata.scope": "适用节点键，逗号分隔，只能取 scope 里的键",
            },
            "legacyKeys": ["id", "desc", "scope"],  # 旧写法继续能读
            "bodySections": list(BODY_SECTIONS),
        },
        "planBlock": {
            "tag": PLAN_TAG,
            "shape": '{"<节点键>":"<技能 id>","why":"为什么挂它"}',
            "whyMax": PLAN_WHY_MAX,
            "none": f"<{PLAN_TAG}>none</{PLAN_TAG}>",
        },
        "id": {
            "pattern": _SKILL_ID_RE.pattern,
            "hint": "小写字母开头，字母数字与连字符，2–41 位（主流规范上限 64，我们更严）",
        },
        "limits": dict(LIMITS),
        "cards": {"desc": CARD_DESC_MAX},
        "scope": dict(MODULE_LABELS),
        "layouts": {
            "file": "skills/<id>.md——一份 md 一条；接口只能写这种",
            "dir": f"skills/<id>/{DIR_ADAPT_FILE}——目录型技能包（可带 references/）",
            "adapter": DIR_ADAPT_FILE,
            "entries": list(DIR_ENTRY_FILES),
            "writable": ["file"],
            "states": {
                "adapted": "有适配层：正常参与候选与投递",
                "original": "只有上游 SKILL.md：正文直接用，注入前自动加宿主能力声明",
                "needsScope": "缺适用节点：可见可开关，但不参与候选与投递，等人指定",
                "oversize": "正文超上限：不注入也不截断",
            },
        },
        "hostGuard": HOST_GUARD,
        "router": {"account": enabled(key), "env": _env_on()},
        "existing": rows,
        "counts": {
            "total": len(rows),
            "user": len([row for row in rows if not row["builtin"]]),
            "limit": LIMITS["skills"],
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
        desc = str(skill["desc"] or "")
        if len(desc) > CARD_DESC_MAX:
            # 存储放宽到 256 后，卡面只给前 200 字：判断够用，也不让候选卡吃掉分析步的上下文
            desc = desc[:CARD_DESC_MAX].rstrip() + "…"
        lines.append(f"- id={skill['id']}｜{skill['name']}｜适用节点：{labels}｜{desc}")
    # 示例行必须取自真实候选：写死某个 id 时，一旦它被关掉，示例里就出现了一个
    # 「严禁自创」却不在候选中的 id，反倒诱导模型抄它
    sample = items[0]
    sample_module = sample["usable"][0]
    lines.append("")
    lines.append("怎么决定：")
    lines.append("- 逐条对照「适用节点」与描述：这道题确实落在某条的范围里，就把那条挂给对应节点；")
    lines.append("  明确不适用才跳过，不要因为「这步只写概要」就默认全部不挂——挂的是后面节点，不是这一步。")
    lines.append("- 挂法：在正文最前面单独输出一行（只此一行，不要解释、不要写进概要）：")
    # 示例行不带列表前缀：模型会照抄这一行的字面样子，若写成「- <skill_plan>…」，
    # 前端剥离计划块后会留下一个孤立的短横线（_stripSkillPlanBlock 只吃标签本身）
    lines.append(f'<skill_plan>{{"{sample_module}":"{sample["id"]}","why":"一句话说清为什么挂它"}}</skill_plan>')
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
    if not item.get("body"):
        # 目录型「待适配 / 超限」条目：正文为空，投递端再判一次（scope 已空，这里是第二道闸）
        return ("", "")
    if not module:
        target = workflow_context.get("target")
        if isinstance(target, dict):
            module = str(target.get("module") or "").strip()
    if module in MODULE_LABELS and module not in item["scope"]:
        return ("", "")
    body = item["body"]
    if item.get("layout") == "dir" and not item.get("adapted"):
        # 原版 SKILL.md 直用（没有本地适配层）：先声明宿主能力，压住「跑 build.mjs」
        # 「开浏览器 4× 目检」这类做不到的步骤——不加这句，模型会编造已经执行过。
        body = HOST_GUARD + body
    return ("\n\n" + body, skill_id)


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
    meta, body = _front_meta(raw)
    if not body:
        body = raw
        warnings.append("front-matter 后面没有正文，已把整段当正文")
    elif not meta:
        warnings.append("没有 front-matter，已按文件名与正文推断（可在这里直接改）")

    guess_title, guess_desc = _guess_meta(body)
    # id：`id` 字段优先；主流写法里没有 id，用 `name`（规范要求它是与目录同名的 slug）
    skill_id = (_meta_text(meta, "id") or _meta_text(meta, "name")).strip().lower() \
        or _auto_id(raw, filename)
    title = _meta_sub(meta, "metadata", "title") or _meta_text(meta, "title")
    raw_name = _plain_line(_meta_text(meta, "name"))
    name = title or (raw_name if raw_name and not _SKILL_ID_RE.match(raw_name.lower()) else "") \
        or guess_title or os.path.splitext(os.path.basename(str(filename or "")))[0] or skill_id
    desc = _clean_line(_meta_text(meta, "description", "desc")) or guess_desc or guess_title
    scope = _parse_scope(_meta_text(meta, "scope") or _meta_sub(meta, "metadata", "scope"))

    # 主流包的 description 常写到 300–1000 字。导入是「解析 → 人确认 → 落盘」，所以这里
    # 截断并写明；手写/编辑路径仍然超限即拒（不静默截断的承诺只对人写的那条路径）。
    if len(desc) > DESC_MAX:
        desc = desc[:DESC_MAX - 1].rstrip() + "…"
        warnings.append(f"描述超过 {DESC_MAX} 字，已截断到 {DESC_MAX} 字——落盘前可以在这里改写")
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
