"""JSON 文件持久化工具与会话消息路径解析。"""

import datetime
import json
import logging
import os
import re
import threading
import uuid
from pathlib import Path

from . import accounts, config
from .accounts import DEFAULT_ACCOUNT

logger = logging.getLogger(__name__)

# ====== JSON 文件持久化工具 ======
_JSON_LOCK = threading.RLock()

# 会话标识白名单：字母/数字/下划线/连字符，杜绝路径分隔符与 Windows 反斜杠穿越
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _read_json(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError, OSError):
            pass
    return default if default is not None else {}


_JSON_READ_CACHE = {}
_JSON_READ_CACHE_MAX = 32


def _invalidate_json_cache(path) -> None:
    """使指定路径的读取缓存失效（写入后调用）。"""
    if path is not None:
        with _JSON_LOCK:
            _JSON_READ_CACHE.pop(str(path), None)


def _read_json_cached(path, default=None):
    """带 mtime+size 失效的内存缓存读取，适合高频只读路径（如会话消息）。

    - 写入方通过 _write_json 自动失效缓存；
    - 读取方不应原地修改返回的数据（如需修改请先拷贝）。
    """
    try:
        stat = path.stat()
    except OSError:
        return _read_json(path, default)
    key = str(path)
    with _JSON_LOCK:
        cached = _JSON_READ_CACHE.get(key)
        if cached and cached[0] == stat.st_mtime_ns and cached[1] == stat.st_size:
            return cached[2]
    data = _read_json(path, default)
    with _JSON_LOCK:
        if len(_JSON_READ_CACHE) >= _JSON_READ_CACHE_MAX:
            _JSON_READ_CACHE.clear()
        _JSON_READ_CACHE[key] = (stat.st_mtime_ns, stat.st_size, data)
    return data

def _write_json(path: Path, data):
    content = json.dumps(data, ensure_ascii=False, indent=2)
    tmp_path = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    with _JSON_LOCK:
        # 拆分文件（data/kv/meta/<族>.json 等）所在的目录由写入方自保障：
        # ensure_account 只建 kv/，族目录是 T214 新增层，直写的调用方不该
        # 各自记得 mkdir（漏一个就是 FileNotFoundError）
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            tmp_path.write_text(content, encoding="utf-8")
            os.replace(tmp_path, path)
            _invalidate_json_cache(path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()


def _mutate_json(path: Path, updater, default=None):
    """串行执行 JSON 文件的读-改-写，避免并发请求互相覆盖。"""
    with _JSON_LOCK:
        data = _read_json(path, default)
        result = updater(data)
        if result is not None:
            _write_json(path, result)
            return result
        return data


def _get_messages_path(session_id: str, account: str = DEFAULT_ACCOUNT) -> Path:
    # 单会话路由的 session_id 直接拼文件路径，必须白名单校验，
    # 否则 URL 编码的 "..%5C" 反斜杠在 Windows 下可穿越到 data 目录之外
    if not isinstance(session_id, str) or not _SESSION_ID_RE.match(session_id):
        raise ValueError(f"invalid session id: {session_id!r}")
    return accounts.resolve_paths(account).messages_dir / f"{session_id}.json"


def _resolve_messages_path(session_id: str, account: str = DEFAULT_ACCOUNT) -> Path:
    """兼容两种会话标识：local key 直接找消息文件，server sessionId 反向查 sessions.json。"""
    paths = accounts.resolve_paths(account)
    direct = None
    try:
        direct = _get_messages_path(session_id, account)
        if direct.exists():
            return direct
    except ValueError:
        pass
    sessions = _read_json(paths.sessions_path, {})
    for sid, sdata in sessions.items():
        if isinstance(sdata, dict) and sdata.get("sessionId") == session_id:
            try:
                return _get_messages_path(sid, account)
            except ValueError:
                continue
    if direct is not None:
        return direct
    raise ValueError(f"invalid session id: {session_id!r}")


# ====== 会话历史的可读归档（2026-11-19）======
# 机器读的数据分两处：聊天流在 data/users/<账号>/messages/<sid>.json，画布与
# 节点在 data/users/<账号>/kv/<sid>.json——用户都看不见。这里在
# data/history/<账号>/<标题>-<sid后8>.md 写一份人可读的时间线，摆在项目文件夹里。
#
# 为什么必须两处都读：本机 53 个会话里 48 个没有消息文件（聊天流从没落盘），
# 但内容其实还在画布节点里（物理/数学视角、交互可视化、追问卡）。只按消息文件
# 判断会得出「历史全丢了」的错误结论（2026-11-19 自己踩过，用户当场纠正）。
# 归档是纯派生副本：删了可由 kv/消息重建（scripts/backfill_history_archive.py），
# 不参与任何读写决策。
#
# 归档只在消息保存链重写，节点改动不触发（2026-11-24 拍板不加：改画布就重写是在保存
# 热路上添活，产物用户也找不到）。要「此刻」的可读副本走知识菜单「导出会话历史」
# （note-export.js，当场按内存态生成）。两侧正文口径一字对齐——_history_text /
# _HISTORY_KIND_LABEL 改了必须同步改前端，冒烟与单测钉同一组夹具。

_HISTORY_ROLE_LABEL = {"user": "我", "assistant": "AI", "system": "系统"}
# 节点类型 → 时间线上的叫法。名字跟画布叫法走（GRAPH_NODE_ATTRIBUTES／graph-recipes.js）；
# 存量 7 个不改名——既有归档已用它。
_HISTORY_KIND_LABEL = {
    "user": "我", "human_note": "我的笔记", "module": "模块", "direct": "AI",
    "source": "素材", "answer": "回答", "analysis": "分析",
    "note": "我的总结", "summary": "AI 总结", "relation": "联系", "blank": "AI 生成空白",
    "hub": "汇聚", "junction": "中转", "ai_eval": "AI 评价", "draft": "草稿",
    "manual": "我的回答", "question": "问题", "followup": "追问", "recipe": "配方",
    "viz": "交互可视化", "image": "图片", "mermaid": "图表", "html_iframe": "网页",
}
# 「问题分析」卡正文在 node.analysis 不在 node.content（graph-render.js 同口径）
_HISTORY_ANALYSIS_HEAD = "问题分析"
_HISTORY_ITEM_KIND_LABEL = {"image": "图片", "text": "文本", "file": "文件"}
_HISTORY_ILLEGAL = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
_HISTORY_TITLE_MAX = 40
# 单条正文上限：交互可视化的 HTML 不写进来（几十 KB 代码不是历史），其它长文
# 超限截断并注明——归档要「翻得动」，不是第二份全量数据。
_HISTORY_ENTRY_MAX = 8000
_HISTORY_HTML_RE = re.compile(r'^\s*(```html|<!DOCTYPE\s+html|<html[\s>])', re.IGNORECASE)

# 正文规范化（口径对齐前端 renderMarkdown：思考块/结构标签不显示给用户）
_HISTORY_THINK_RE = re.compile(r"<(think|thinking|reasoning|thought)>[\s\S]*?</\s*\1\s*>", re.IGNORECASE)
_HISTORY_THINK_OPEN_RE = re.compile(r"<(think|thinking|reasoning|thought)>", re.IGNORECASE)
_HISTORY_SOCRATIC_META_RE = re.compile(r"<socratic_meta\b[^>]*>[\s\S]*?</socratic_meta>|<socratic_meta\b[^>]*/?>", re.IGNORECASE)
_HISTORY_SUMMARY_RE = re.compile(r"<summary>[\s\S]*?</summary>", re.IGNORECASE)
_HISTORY_VIZ_SECTION_RE = re.compile(r"<viz\b[^>]*>([\s\S]*?)</viz\s*>", re.IGNORECASE)
_HISTORY_HTML_FENCE_RE = re.compile(r"```html\s*\n([\s\S]*?)```", re.IGNORECASE)
# 完整网页才算可视化（renderMarkdown 转可视化卡的同一道闸：太短的片段保留为代码块）
_HISTORY_PAGE_RE = re.compile(r"<!doctype|<html[\s>]|<body[\s>]", re.IGNORECASE)
_HISTORY_STRUCT_TAG_RE = re.compile(r"</?(?:physics|math|graph|extend|analysis)\b[^>]*>", re.IGNORECASE)
_HISTORY_FORMULA_WRAPPED_RE = re.compile(r"\${1,2}\s*<formula>([\s\S]*?)</formula>\s*\${1,2}", re.IGNORECASE)
_HISTORY_FORMULA_RE = re.compile(r"<formula>([\s\S]*?)</formula>", re.IGNORECASE)
_HISTORY_FORMULA_OPEN_RE = re.compile(r"<formula>(?![\s\S]*</formula>)", re.IGNORECASE)
_HISTORY_ENTITY_RE = re.compile(r"&gt;|&lt;|&quot;|&nbsp;|&amp;", re.IGNORECASE)
_HISTORY_ENTITY_MAP = {"&gt;": ">", "&lt;": "<", "&quot;": '"', "&nbsp;": " ", "&amp;": "&"}
_HISTORY_LEADING_DOLLAR_RE = re.compile(r"^\$+|\$+$")
_HISTORY_BLANK_RE = re.compile(r"\s+")


def history_dir(account: str = DEFAULT_ACCOUNT) -> Path:
    """归档目录：data/history/<账号>/（跟随 config.DATA_DIR，测试可整体重定向）。"""
    return Path(config.DATA_DIR) / "history" / (account or DEFAULT_ACCOUNT)


def _session_title(session_id: str, account: str) -> str:
    try:
        sessions = _read_json(accounts.resolve_paths(account).sessions_path, {})
    except Exception:
        return ""
    entry = sessions.get(session_id) if isinstance(sessions, dict) else None
    return str(entry.get("title") or "") if isinstance(entry, dict) else ""


def _archive_name(session_id: str, title: str) -> str:
    safe = _HISTORY_ILLEGAL.sub("_", title or "").strip(" .")[:_HISTORY_TITLE_MAX]
    return f"{safe or '未命名画布'}-{session_id[-8:]}.md"


def _fmt_ms(ts) -> str:
    try:
        return datetime.datetime.fromtimestamp(float(ts) / 1000).strftime("%m-%d %H:%M")
    except (TypeError, ValueError, OSError, OverflowError):
        return ""


def _ts_of(value) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("inf")  # 没有时间戳的排最后


def _graph_nodes(session_id: str, account: str) -> list:
    """读该会话画布快照里的节点（kv/<sid>.json → graph:<sid>.customNodes）。"""
    try:
        kv_path = accounts.resolve_paths(account).kv_dir / f"{session_id}.json"
    except Exception:
        return []
    # 走 mtime+size 失效的读缓存：消息每次保存都会来取一次，大画布别反复全量解析
    kv = _read_json_cached(kv_path, {})
    if not isinstance(kv, dict):
        return []
    graph = kv.get(f"graph:{session_id}") or kv.get("graph") or {}
    nodes = graph.get("customNodes") if isinstance(graph, dict) else None
    return [n for n in (nodes or []) if isinstance(n, dict)]


def _history_viz_note(code) -> str:
    return f"（交互可视化，{len(code):,} 字代码，正文见画布）"


def _history_formula_clean(latex) -> str:
    s = _HISTORY_ENTITY_RE.sub(lambda m: _HISTORY_ENTITY_MAP[m.group(0).lower()], str(latex or "").strip())
    s = _HISTORY_LEADING_DOLLAR_RE.sub("", s).strip()
    # 只清 PowerShell 转义垃圾 \=；\, \; \: 是合法间距命令（render.js T422 同口径）
    return s.replace("\\$", "$").replace("\\=", "=").strip()


def _history_formula_sub(s: str, m: re.Match) -> str:
    """<formula> → Markdown 数学定界符：独占一行的是 display（$$ 块），夹在句中的是 inline（$）。
    所有阅读器都认这两种；<formula> 标签原样落盘只会显示成带尖括号的 LaTeX 源码。"""
    latex = _history_formula_clean(m.group(1))
    if not latex:
        return ""
    before, after = s[: m.start()], s[m.end():]
    if before.rsplit("\n", 1)[-1].strip() or after.split("\n", 1)[0].strip():
        return "$" + _HISTORY_BLANK_RE.sub(" ", latex) + "$"
    # 独占一行：前后补足空行，display 块在严格按段落判定的阅读器里才不会粘进上一段
    pad_before = "\n\n" if before and not before.endswith("\n\n") else ""
    pad_after = "\n\n" if after and not after.startswith("\n\n") else ""
    return pad_before + "$$\n" + latex + "\n$$" + pad_after


def _history_fence_sub(m: re.Match) -> str:
    code = m.group(1)
    if len(code.strip()) >= 100 and _HISTORY_PAGE_RE.search(code):
        return _history_viz_note(code)
    return m.group(0)


def _history_text(text) -> str:
    """归档/导出共用的正文规范化（前端 _historyText 是同一份口径）：整条是可视化网页的
    只留一句说明；剥思考块、socratic_meta、<summary> 与分节标签；<viz> 段和完整网页代码块
    换成说明；<formula> 转成 $$／$。未闭合的 <formula>（流式截断）从标签起截掉。"""
    s = str(text or "").strip()
    if not s:
        return ""
    if _HISTORY_HTML_RE.match(s):
        return _history_viz_note(s)
    s = _HISTORY_THINK_RE.sub("", s)
    think_open = _HISTORY_THINK_OPEN_RE.search(s)
    if think_open:
        s = s[: think_open.start()]
    s = _HISTORY_SOCRATIC_META_RE.sub("", s)
    s = _HISTORY_SUMMARY_RE.sub("", s)
    s = _HISTORY_VIZ_SECTION_RE.sub(lambda m: _history_viz_note(m.group(1)), s)
    s = _HISTORY_HTML_FENCE_RE.sub(_history_fence_sub, s)
    s = _HISTORY_STRUCT_TAG_RE.sub("", s)
    # AI 把 <formula> 包在 $$..$$ 里的双层定界：先收成单层
    s = _HISTORY_FORMULA_WRAPPED_RE.sub(lambda m: "<formula>" + m.group(1) + "</formula>", s)
    unclosed = _HISTORY_FORMULA_OPEN_RE.search(s)
    if unclosed and s.count("```", 0, unclosed.start()) % 2 == 0:
        s = s[: unclosed.start()]
    return _HISTORY_FORMULA_RE.sub(lambda m: _history_formula_sub(s, m), s).strip()


def _history_items_text(items) -> str:
    """清单类节点的条目（建议追问、素材附件）压成无序列表——正文为空时才用它。"""
    lines = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        question = str(item.get("question") or "").strip()
        name = str(item.get("fileName") or item.get("name") or "").strip()
        body = str(item.get("text") or "").strip()
        if question:
            level = str(item.get("levelName") or "").strip()
            lines.append(f"- {'[' + level + '] ' if level else ''}{question}")
        elif name or body:
            kind = _HISTORY_ITEM_KIND_LABEL.get(str(item.get("kind") or ""), "素材")
            lines.append(f"- {kind}「{name}」" + (f"：{body}" if body else ""))
    return "\n".join(lines)


def _history_norm(text) -> str:
    return _HISTORY_BLANK_RE.sub("", str(text or ""))


def _clip_entry(text) -> str:
    if len(text) > _HISTORY_ENTRY_MAX:
        return text[:_HISTORY_ENTRY_MAX].rstrip() + f"\n\n…（已截断，共 {len(text):,} 字，完整内容见画布）"
    return text


def _archive_entries(messages, nodes) -> list:
    """消息与画布节点合成一条时间线：[(ts, 角色/类型, 小标题, 正文), ...]。

    与某个节点正文（去空白后）完全相同的消息不重复列——节点就是它在画布上的样子。"""
    entries = []
    node_entries = []
    node_norm = set()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        kind = str(node.get("kind") or "")
        head = _HISTORY_KIND_LABEL.get(kind, kind or "节点")
        content = _history_text(node.get("content"))
        if not content and kind == "answer" and not node.get("manual"):
            content = _history_text(node.get("analysis"))
            if content:
                head = _HISTORY_ANALYSIS_HEAD
        if not content:
            content = _history_text(_history_items_text(node.get("items")))
        label = str(node.get("label") or "").strip()
        if not content and not label:
            continue
        content = _clip_entry(content)
        node_norm.add(_history_norm(content))
        node_entries.append((_ts_of(node.get("timestamp")), head, label, content))
    for msg in messages or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "")
        if role == "system":
            continue
        content = _clip_entry(_history_text(msg.get("content")))
        if not content or _history_norm(content) in node_norm:
            continue
        entries.append((_ts_of(msg.get("timestamp")),
                        _HISTORY_ROLE_LABEL.get(role, role or "记录"), "", content))
    entries.extend(node_entries)
    entries.sort(key=lambda e: e[0])
    return entries


def message_archive_markdown(session_id: str, messages: list, title: str = "", nodes=None) -> str:
    entries = _archive_entries(messages, nodes or [])
    stamps = [e[0] for e in entries if e[0] != float("inf")]
    lines = [
        f"# {title or '未命名画布'}", "",
        f"- 会话 ID：`{session_id}`",
        f"- 条目：{len(entries)} 条（画布节点 {len(nodes or [])} 个、聊天消息 {len(messages or [])} 条，空条目已略）",
    ]
    if stamps:
        lines.append(f"- 时间跨度：{_fmt_ms(min(stamps))} → {_fmt_ms(max(stamps))}")
    lines += [f"- 导出时间：{datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}", "", "---", ""]
    for i, (ts, head, label, content) in enumerate(entries, 1):
        line = f"## {i}. {head}"
        if label and label != head:
            line += f" · {label}"
        if ts != float("inf"):
            line += f" · {_fmt_ms(ts)}"
        lines.append(line)
        lines.append("")
        if content:
            lines.append(content)
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def write_message_archive(session_id: str, messages: list, account: str = DEFAULT_ACCOUNT):
    """把「画布节点 + 聊天消息」写成一份可读时间线；两者都空时返回 None。

    返回归档路径。写失败由调用方吞掉——归档是副本，不许影响消息本体的保存。
    """
    if not isinstance(messages, list):
        messages = []
    nodes = _graph_nodes(session_id, account)
    if not messages and not nodes:
        return None
    title = _session_title(session_id, account)
    target_dir = history_dir(account)
    target_dir.mkdir(parents=True, exist_ok=True)
    target = target_dir / _archive_name(session_id, title)
    # 标题改过：同会话旧文件名（按 sid 后 8 位认，只在本账号目录内）一并清掉
    for old in target_dir.glob(f"*-{session_id[-8:]}.md"):
        if old.name != target.name:
            try:
                old.unlink()
            except OSError:
                pass
    content = message_archive_markdown(session_id, messages, title, nodes)
    tmp = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, target)
    return target


def remove_message_archive(session_id: str, account: str = DEFAULT_ACCOUNT) -> int:
    """删除会话/清空消息时同步清归档，避免归档变成删不掉的第二份历史。"""
    target_dir = history_dir(account)
    if not target_dir.is_dir():
        return 0
    removed = 0
    for old in target_dir.glob(f"*-{session_id[-8:]}.md"):
        try:
            old.unlink()
            removed += 1
        except OSError:
            pass
    return removed


# ====== KV 键值存储：拆分路由（三层落点） ======
# ① 会话级键 → data/kv/<sid>.json（{键: 值}，一会话一文件）
#    graph:<sid> / harness_history:<sid> / graph_history:<sid> 这类每会话大对象
#    拆出去后，保存单个会话不再整写主文件（此前是全量重写 700KB+ 的
#    kv_store.json，且独占全局 JSON 锁）。
# ② 族/独键 → data/kv/meta/<name>.json（同族共居一文件）
#    socratic:<ref> 与 mem:<sid> 按前缀同族：context 的孤儿记忆清理、分支链
#    状态定位都在族内做前缀全键扫描，拆到每会话文件会切断这些扫描（还会复活
#    「旧版 18 截断前缀」跨会话误删状态的旧 bug）；phymathia_quiz_stats/题库、
#    continent_* 六键按族共居。任一写入只重写本族文件，不再连带其余族。
# ③ 其余全局小键（phi_sessions / tasks:global / 当前会话 / node_recipes …）
#    留在 kv_store.json。
# 多账号（P1）：所有路径按 account 经 accounts.resolve_paths 现算（调用时读
# config.DATA_DIR，测试 patch 一处即整体重定向）。
_KV_SESSION_PREFIXES = ("graph:", "harness_history:", "graph_history:")

# 前缀族：同族键共居一个 meta 文件（族内前缀扫描的必要性见上方注释②）
_KV_FAMILY_PREFIXES = {
    "socratic:": "socratic",
    "mem:": "mem",
}

# 独键族：显式名单（单键/同族共居 meta 文件）；未列出的键保持旧行为留主文件
_KV_SOLO_KEYS = {
    "phymathia_quiz_stats": "quiz",
    "phymathia_quiz_bank": "quiz",
    "continent_edges": "continent",
    "continent_families": "continent",
    "continent_family_suggestions": "continent",
    "continent_gate": "continent",
    "continent_gate_weights": "continent",
    "continent_regions": "continent",
    "continent_seas": "continent",
}

_KV_META_NAME_RE = re.compile(r"^[A-Za-z0-9_-]+$")


def _kv_split_session(key: str):
    """会话级键返回 (sid, key)；其余键返回 None。sid 必须过白名单防路径穿越。"""
    key = str(key or "")
    for prefix in _KV_SESSION_PREFIXES:
        if key.startswith(prefix):
            sid = key[len(prefix):]
            if sid and _SESSION_ID_RE.match(sid):
                return sid, key
    return None


def _kv_session_path(sid: str, account: str = DEFAULT_ACCOUNT) -> Path:
    if not isinstance(sid, str) or not _SESSION_ID_RE.match(sid):
        raise ValueError(f"invalid session id: {sid!r}")
    return accounts.resolve_paths(account).kv_dir / f"{sid}.json"


def _kv_meta_path(family: str, account: str = DEFAULT_ACCOUNT) -> Path:
    """族拆分文件路径。family 只应来自本模块常量表，仍过白名单防呆。"""
    if not isinstance(family, str) or not _KV_META_NAME_RE.match(family):
        raise ValueError(f"invalid kv split family: {family!r}")
    return accounts.resolve_paths(account).kv_meta_dir / f"{family}.json"


def _kv_target_path(key: str, account: str = DEFAULT_ACCOUNT):
    """按键算落点：会话文件 / 族文件 / None＝主文件。"""
    key = str(key or "")
    split = _kv_split_session(key)
    if split is not None:
        return _kv_session_path(split[0], account)
    for prefix, family in _KV_FAMILY_PREFIXES.items():
        if key.startswith(prefix):
            return _kv_meta_path(family, account)
    family = _KV_SOLO_KEYS.get(key)
    if family is not None:
        return _kv_meta_path(family, account)
    return None


# ====== T223 主文件膨胀守卫 ======
# 拆分后主文件只该放全局小键（2026-11-01 实测 default 账号 55KB，最重合法键
# tasks:global ≈25KB）；总大小或单键越过阈值，基本等于「名单外重键回落主文件」
# ——T214 拆分要防的「任一写＝全量重写主文件」复发前兆。只告警不改行为：确属
# 合法增长（如 tasks:global 随任务数变多）可拍板调阈值或补拆分路由。
_KV_MAIN_BLOAT_TOTAL_BYTES = 128 * 1024
_KV_MAIN_HEAVY_VALUE_BYTES = 64 * 1024
_KV_BLOAT_WARNED: set = set()  # 已告警账号；每进程每账号至多一次，防日志刷屏


def _kv_warn_main_bloat(account: str = DEFAULT_ACCOUNT, trigger_key: str = "") -> None:
    """主文件体积守卫：总大小过 _KV_MAIN_BLOAT_TOTAL_BYTES，或单键序列化值过
    _KV_MAIN_HEAVY_VALUE_BYTES 时告警一次（键数只进文案不做触发条件——键多而小
    不加重「全量重写」成本，体积才是 T214 的痛点信号）。

    触发点三处：kv_write 回落主文件时（当下就涨）、kv_restore_bulk（备份导入
    可能整包落主文件）、kv_migrate_split_keys 尾部（兼作启动检查——迁移只搬
    名单内键，名单外重键留守主文件正是它要抓的形态）。
    """
    if account in _KV_BLOAT_WARNED:
        return
    paths = accounts.resolve_paths(account)
    try:
        size = paths.kv_path.stat().st_size
    except OSError:
        return
    data = _read_json(paths.kv_path, {})
    heavy = []
    if isinstance(data, dict):
        for key, value in data.items():
            try:
                n = len(json.dumps(value, ensure_ascii=False).encode("utf-8"))
            except (TypeError, ValueError):
                n = len(str(value).encode("utf-8", "ignore"))
            if n >= _KV_MAIN_HEAVY_VALUE_BYTES:
                heavy.append((n, str(key)))
    if size < _KV_MAIN_BLOAT_TOTAL_BYTES and not heavy:
        return
    _KV_BLOAT_WARNED.add(account)
    heavy.sort(reverse=True)
    top = "、".join(f"{key}≈{n // 1024}KB" for n, key in heavy[:3]) or "无单键过阈"
    logger.warning(
        "kv main file bloat (T223 guard): account=%s size=%dKB keys=%d "
        "heaviest=[%s]%s -- unrouted heavy key in main file? add it to "
        "_KV_SOLO_KEYS/_KV_FAMILY_PREFIXES split routing, or raise the "
        "threshold if legitimate",
        account, size // 1024, len(data) if isinstance(data, dict) else -1, top,
        f" trigger_key={trigger_key}" if trigger_key else "",
    )


def kv_read(key: str, default=None, account: str = DEFAULT_ACCOUNT):
    """按键读 KV：会话键走 data/kv/<sid>.json，族/独键走 data/kv/meta/<族>.json，其余走主文件。"""
    paths = accounts.resolve_paths(account)
    path = _kv_target_path(key, account) or paths.kv_path
    data = _read_json(path, {})
    if isinstance(data, dict) and key in data:
        return data[key]
    return default


def kv_write(key: str, value, account: str = DEFAULT_ACCOUNT) -> None:
    """按键写 KV（upsert），自动路由到会话文件、族文件或主文件。"""
    paths = accounts.resolve_paths(account)
    target = _kv_target_path(key, account)
    path = target or paths.kv_path

    def updater(data):
        data = dict(data) if isinstance(data, dict) else {}
        data[key] = value
        return data

    path.parent.mkdir(parents=True, exist_ok=True)
    _mutate_json(path, updater, default={})
    if target is None:
        _kv_warn_main_bloat(account, trigger_key=key)


def kv_mutate(key: str, value_updater, default=None, account: str = DEFAULT_ACCOUNT):
    """按键做锁内读-改-写（T525）：value_updater(现值) → 新值，整段持 _JSON_LOCK。

    读现值、算新值、写回必须原子（如 graph: 键三方合并）的场景用它——kv_read＋
    kv_write 两段之间锁已释放，线程写者插入后其更新会被基于旧现值算出的整键
    覆盖抹掉。value_updater 只做纯本地计算（不回调 kv_*、不做 IO），同线程
    二次拿锁安全（RLock），但锁内拖 IO 会卡住全部 JSON 读写。返回变异后该键的
    现值；value_updater 返回 None＝不动现值。
    """
    paths = accounts.resolve_paths(account)
    target = _kv_target_path(key, account)
    path = target or paths.kv_path

    def updater(data):
        data = dict(data) if isinstance(data, dict) else {}
        current = data.get(key, default)
        new_value = value_updater(current)
        if new_value is None:
            return None
        data[key] = new_value
        return data

    path.parent.mkdir(parents=True, exist_ok=True)
    result = _mutate_json(path, updater, default={})
    if target is None:
        _kv_warn_main_bloat(account, trigger_key=key)
    return result.get(key) if isinstance(result, dict) else None


def kv_delete(key: str, account: str = DEFAULT_ACCOUNT) -> None:
    """按键删 KV；拆分文件（会话/族）删空后移除文件本身（空 JSON 不是用户数据）。"""
    paths = accounts.resolve_paths(account)
    target = _kv_target_path(key, account)
    path = target if target is not None else paths.kv_path

    def updater(data):
        if not isinstance(data, dict) or key not in data:
            return None
        data = dict(data)
        data.pop(key, None)
        return data

    # T233：mutate＋空判＋unlink 必须整段持 _JSON_LOCK。_mutate_json 返回时锁已
    # 释放，此时到 unlink 之间有个窗口：并发 kv_write 往同一拆分层写入新键，
    # 外层再按「删完后读到的空 dict」判断就把整个文件 unlink 掉，新键一起蒸发。
    # _JSON_LOCK 是 RLock 且 updater 只做纯本地 dict 操作（不回调 kv_*），同线程
    # 二次拿锁安全，也没有再入死锁路径。
    with _JSON_LOCK:
        result = _mutate_json(path, updater, default={})
        if target is not None and isinstance(result, dict) and not result:
            try:
                target.unlink(missing_ok=True)
            except OSError:
                pass


def _kv_layer_paths(account: str = DEFAULT_ACCOUNT) -> list:
    """kv_all_data 的读取清单（主文件＋会话拆分＋族拆分；顺序＝合并优先级，
    拆分在后覆盖主文件同名键）。kv_layer_stats 与 kv_all_data 共用一份清单，
    防「指纹看漏一层」与「合并多读一层」各自漂移。"""
    paths = accounts.resolve_paths(account)
    out = [paths.kv_path]
    if paths.kv_dir.exists():
        out.extend(p for p in sorted(paths.kv_dir.glob("*.json"))
                   if _SESSION_ID_RE.match(p.stem))
    if paths.kv_meta_dir.exists():
        out.extend(sorted(paths.kv_meta_dir.glob("*.json")))
    return out


def kv_all_data(account: str = DEFAULT_ACCOUNT) -> dict:
    """全量合并视图（主文件 + 会话文件 + 族文件，拆分文件覆盖同名键）。

    备份导出与大陆投影等「要看到全部 KV」的场合用；拆分文件优先——它与
    迁移中断时残留在主文件里的旧副本相比总是较新的一份。
    """
    merged = {}
    for path in _kv_layer_paths(account):
        data = _read_json(path, {})
        if isinstance(data, dict):
            merged.update(data)
    return merged


def kv_layer_stats(account: str = DEFAULT_ACCOUNT) -> tuple:
    """kv_all_data 会读到的每一层文件的 (mtime_ns, size)（文件缺失记 None）。

    结果级缓存（大陆投影 T293）拿它当输入指纹：任何一层落盘即变，缓存自然
    失效——只 stat 不读内容，微秒级。"""
    out = []
    for p in _kv_layer_paths(account):
        try:
            st = p.stat()
            out.append((st.st_mtime_ns, st.st_size))
        except OSError:
            out.append(None)
    return tuple(out)


def kv_migrate_split_keys(account: str = DEFAULT_ACCOUNT) -> int:
    """启动迁移：把主文件里的会话级键与族键搬进各自拆分文件，返回搬运键数。

    先写拆分文件、全部成功后才从主文件移除——中途失败下次启动幂等重跑。
    迁移结束后跑一次主文件膨胀守卫（T223），兼作启动检查。
    """
    paths = accounts.resolve_paths(account)
    main = _read_json(paths.kv_path, {})
    if not isinstance(main, dict):
        _kv_warn_main_bloat(account)
        return 0
    groups = {}  # 目标路径 → {键: 值}
    for key, value in main.items():
        path = _kv_target_path(key, account)
        if path is not None:
            groups.setdefault(path, {})[key] = value
    if not groups:
        _kv_warn_main_bloat(account)
        return 0
    for path, entries in groups.items():
        def updater(data, _entries=entries):
            data = dict(data) if isinstance(data, dict) else {}
            data.update(_entries)
            return data

        path.parent.mkdir(parents=True, exist_ok=True)
        _mutate_json(path, updater, default={})
    moved_keys = {key for entries in groups.values() for key in entries}

    def remove_moved(data):
        if not isinstance(data, dict):
            return None
        remaining = {k: v for k, v in data.items() if k not in moved_keys}
        return remaining if len(remaining) != len(data) else None

    _mutate_json(paths.kv_path, remove_moved)
    _kv_warn_main_bloat(account)
    return len(moved_keys)


def kv_restore_bulk(data, replace: bool, account: str = DEFAULT_ACCOUNT) -> int:
    """备份导入：把一份 {键: 值} 按拆分路由落盘，返回导入键数。

    全局键合并进主文件（replace 时先清空）；会话键与族键按落点分组，合并进
    各自拆分文件（replace 时先清 data/kv/ 与 data/kv/meta/）。比逐键
    kv_write 少 O(n) 次全量写。

    527：「清层→重写整段」收进同一把 _JSON_LOCK——修前各步各自持锁，replace 的
    「清空主文件＋清空拆分层」与随后的组写入之间是裸窗口，导入期间并发的
    kv_write 落进窗口会被组整写（主文件键）或清层（拆分文件键）无声抹掉。收进
    临界区后，并发写要么整体赶在清层前（被 replace 语义如实抹掉——导入语义
    如此，不算丢），要么排队到整段导入完成后做锁内合并、必然存活。RLock 同线程
    再入安全（_write_json/_mutate_json 内部拿的是同一把锁）。
    """
    paths = accounts.resolve_paths(account)
    if not isinstance(data, dict):
        return 0
    groups = {}  # 目标路径 → {键: 值}
    for key, value in data.items():
        path = _kv_target_path(key, account) or paths.kv_path
        groups.setdefault(path, {})[key] = value
    with _JSON_LOCK:
        if replace:
            paths.kv_path.parent.mkdir(parents=True, exist_ok=True)
            _write_json(paths.kv_path, {})
            for directory in (paths.kv_dir, paths.kv_meta_dir):
                if directory.exists():
                    for p in directory.glob("*.json"):
                        p.unlink(missing_ok=True)
        if paths.kv_path in groups and not replace:
            existing = _read_json(paths.kv_path, {})
            groups[paths.kv_path] = {**(existing if isinstance(existing, dict) else {}),
                                     **groups[paths.kv_path]}
        for path, entries in groups.items():
            if path is paths.kv_path and replace:
                _write_json(paths.kv_path, entries)  # 上面已清空，直接落全局键
                continue

            def updater(d, _entries=entries):
                d = dict(d) if isinstance(d, dict) else {}
                d.update(_entries)
                return d

            path.parent.mkdir(parents=True, exist_ok=True)
            _mutate_json(path, updater, default={})
    _kv_warn_main_bloat(account)
    return len(data)


__all__ = [
    "_read_json", "_write_json", "_mutate_json",
    "_read_json_cached", "_invalidate_json_cache",
    "_get_messages_path", "_resolve_messages_path",
    "history_dir", "write_message_archive", "remove_message_archive",
    "kv_read", "kv_write", "kv_delete", "kv_all_data",
    "kv_migrate_split_keys", "kv_restore_bulk",
]
