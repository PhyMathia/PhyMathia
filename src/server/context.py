"""会话上下文构建与苏格拉底追问状态管理。"""

import hashlib
import json
import re
import time
from copy import deepcopy

from . import storage
from .config import KV_PATH
from .storage import _mutate_json, _read_json, _read_json_cached, _resolve_messages_path
from . import config as _config_mod  # 模块属性读取，测试补丁 _config_mod.KV_PATH 才能生效
from llm_common import estimate_tokens  # 唯一实现在项目根 llm_common.py，此处转出口（import * 与测试直引都走这里）

# ====== 上下文窗口瘦身（旧窗口装配：工作流 / 分支 / 滚动记忆共用） ======
_CONTEXT_MAX_USER_CHARS = 4000
_CONTEXT_RECENT_FULL_MAX = 8000
_VIZ_DIGEST_MAX = 1200
VIZ_PLACEHOLDER = "[交互可视化内容已省略]"
_VIZ_WANT_RE = re.compile(r"可视化|交互|动画|没看懂|看不懂|HTML|html|演示|3D|这个图|那张图|图里|图上的|画面", re.I)

# ====== 上下文 token 预算 ======
MODEL_CONTEXT_WINDOWS = {
    "deepseek-chat": 65536,
    "deepseek-reasoner": 65536,
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
}
DEFAULT_CONTEXT_WINDOW = 128000
CONTEXT_OUTPUT_RESERVE_TOKENS = 8192
MAX_CONTEXT_BUDGET_TOKENS = 16000
MIN_CONTEXT_BUDGET_TOKENS = 2048


def resolve_context_budget(model_name: str = "") -> int:
    """按模型上下文窗口计算本次请求的输入 token 预算。

    预算 = min(全局上限, 窗口 - 输出预留)，至少 MIN_CONTEXT_BUDGET_TOKENS；
    未知模型按 DEFAULT_CONTEXT_WINDOW 处理。
    """
    key = str(model_name or "").strip().lower()
    window = MODEL_CONTEXT_WINDOWS.get(key, DEFAULT_CONTEXT_WINDOW)
    return max(MIN_CONTEXT_BUDGET_TOKENS, min(MAX_CONTEXT_BUDGET_TOKENS, window - CONTEXT_OUTPUT_RESERVE_TOKENS))


def _content_timestamp_map(messages: list) -> dict:
    """content -> 首次出现的 timestamp，用于跨消息按 (timestamp, content) 去重。"""
    mapping = {}
    for msg in messages or []:
        content = str(msg.get("content") or "")
        if content and content not in mapping:
            mapping[content] = str(msg.get("timestamp") or "")
    return mapping


def _shrink_history_to_budget(messages: list, budget_tokens: int, protected: set = None) -> list:
    """按 token 预算收缩历史消息，保持消息顺序。

    策略（从低优先到高优先逐级压缩）：
    1. 把较早的 assistant 消息替换为摘要（受保护内容与最后一条消息除外）；
    2. 从最早开始丢弃非受保护、非最后一条消息；
    3. 最后一条 assistant 兜底截断为摘要；
    4. 极端情况把最早的消息截短。
    """
    if not messages or not budget_tokens or budget_tokens <= 0:
        return messages
    protected = protected or set()
    total = sum(estimate_tokens(str(m.get("content") or "")) for m in messages)
    if total <= budget_tokens:
        return messages

    last_idx = len(messages) - 1
    # 阶段1：较早 assistant -> 摘要
    for i, m in enumerate(messages):
        if total <= budget_tokens:
            break
        if i >= last_idx:
            break
        if m.get("role") != "assistant":
            continue
        content = str(m.get("content") or "")
        if content in protected:
            continue
        summary = _graph_message_summary(m)[:200]
        if not summary or summary == content:
            continue
        delta = estimate_tokens(content) - estimate_tokens(summary)
        if delta <= 0:
            continue
        m["content"] = summary
        total -= delta

    # 阶段2：从最早开始丢弃非受保护、非最后一条消息
    i = 0
    while total > budget_tokens and i < last_idx:
        m = messages[i]
        content = str(m.get("content") or "")
        if content in protected:
            i += 1
            continue
        total -= estimate_tokens(content)
        messages.pop(i)
        last_idx = len(messages) - 1

    # 阶段3：最后一条 assistant 兜底截断
    if total > budget_tokens and messages and messages[-1].get("role") == "assistant":
        content = str(messages[-1].get("content") or "")
        if content not in protected:
            summary = _graph_message_summary(messages[-1])[:160]
            if summary and summary != content:
                total -= estimate_tokens(content) - estimate_tokens(summary)
                messages[-1]["content"] = summary

    # 阶段4：极端情况把最早的消息截短（保留最后一条）
    i = 0
    while total > budget_tokens and i < len(messages) - 1:
        m = messages[i]
        content = str(m.get("content") or "")
        if content in protected:
            i += 1
            continue
        truncated = content[:200] + "…（已截断）"
        delta = estimate_tokens(content) - estimate_tokens(truncated)
        if delta > 0:
            m["content"] = truncated
            total -= delta
            i += 1
        else:
            total -= estimate_tokens(content)
            messages.pop(i)
    return messages


def _prompt_wants_viz(prompt: str) -> bool:
    """判断当前提问是否与可视化相关（决定是否在上下文中保留整段 HTML）。"""
    if not prompt:
        return False
    return bool(_VIZ_WANT_RE.search(prompt))


def _trim_context_content(content: str, keep_viz: bool = False) -> str:
    """压缩大段 assistant 消息：保留 <summary> 摘要标签；<viz>/```html``` 大块
    HTML 默认替换为占位符（keep_viz=True 时替换为可视化摘要）；超出上限再截断。"""
    if not content:
        return ""
    if len(content) <= _CONTEXT_RECENT_FULL_MAX:
        return content
    summary = ""
    match = re.search(r"<summary>([\s\S]*?)</summary>", content, re.I)
    if match:
        summary = match.group(1).strip()[:200]

    def _viz_repl(match_obj):
        if keep_viz:
            return "[交互可视化摘要]" + "\n" + _viz_digest(match_obj.group(0))
        return VIZ_PLACEHOLDER

    text = re.sub(r"<viz>[\s\S]*?</viz>", _viz_repl, content, flags=re.I)
    # 独立 ```html 围栏代码块（无 <viz> 标签时的形态）：
    # 开始标记是 ```html + 换行，结束标记是单独一行 ```（原正则把开始写成
    # "```html```"，与真实模型输出永不匹配，压缩逻辑从未生效）
    text = re.sub(r"```html\s*\n[\s\S]*?\n```", _viz_repl, text, flags=re.I)
    if len(text) <= _CONTEXT_RECENT_FULL_MAX:
        return text
    head = text[:_CONTEXT_RECENT_FULL_MAX]
    if summary:
        head += "\n\n<summary>" + summary + "</summary>"
    return head + "\n…（上下文已截断）"


def _viz_digest(content: str, max_chars: int = _VIZ_DIGEST_MAX) -> str:
    """从可视化 HTML 中提取模型可用的精简信息：可见文字 + 脚本片段。

    追问可视化时不再发送整段 HTML，避免占用大量 token。
    """
    if not content:
        return ""
    html = content
    viz = _extract_section(content, "viz")
    if viz:
        html = viz
    else:
        m = re.search(r"```html\s*\n([\s\S]*?)\n```", content, re.I)
        if m:
            html = m.group(1)
    scripts = re.findall(r"<script[^>]*>([\s\S]*?)</script>", html, re.I)
    script_snippet = ""
    if scripts:
        joined = " ".join(scripts)
        script_snippet = re.sub(r"\s+", " ", joined).strip()[:_VIZ_DIGEST_MAX // 2]
    text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    lines = []
    if text:
        lines.append("页面文字：" + text[:800])
    if script_snippet:
        lines.append("脚本片段：" + script_snippet)
    return "\n".join(lines)[:max_chars]

_SOCRATIC_PROMPT_PREFIXES = ("[苏格拉底回答]", "[苏格拉底提示]", "[苏格拉底讲解]")


def _is_socratic_prompt_text(prompt: str) -> bool:
    """判断消息是否属于苏格拉底闭环（回答/提示/讲解三种前缀）。"""
    return bool(prompt and prompt.lstrip().startswith(_SOCRATIC_PROMPT_PREFIXES))


def _is_socratic_message(msg) -> bool:
    """识别苏格拉底支线消息，兼容新 branch 字段和历史内容标记。"""
    if not isinstance(msg, dict):
        return False
    if msg.get("branch") == "socratic" or msg.get("branchType") == "socratic":
        return True
    content = str(msg.get("content") or "")
    if content.lstrip().startswith("[苏格拉底回答]") or content.lstrip().startswith("[苏格拉底提示]") or content.lstrip().startswith("[苏格拉底讲解]"):
        return True
    if content.lstrip().startswith("我的回答："):
        # “我的回答：”仅是旧版苏格拉底痕迹，普通用户消息也可能以此开头
        # （回答提问、转述答案），必须同时带有分支元数据才视为苏格拉底支线；
        # 否则该轮对话会被上下文过滤静默丢弃
        if msg.get("branch") or msg.get("branchType") or msg.get("branchId"):
            return True
    if _is_socratic_followup(content):
        # 与提取闸门同口径（复用同一函数）：此前这里是逐字相同的内联正则，
        # 改一处漏一处会让上下文过滤与提取闸门口径分叉
        return True
    return False


def _viz_trigger_map(messages: list) -> dict:
    """每条 assistant 消息的触发提问映射（索引 → 它前面最近的 user 消息内容）。

    viz 折叠判定锚定触发提问而非当前提问：当前提问每轮都变，由它决定历史
    消息的 viz 形态会让同一份历史在「占位符↔摘要」间来回翻转，每翻一次
    打灭一次前缀缓存（2026-09-21 拍板）。
    """
    trigger_by_index = {}
    last_user_content = ""
    for idx, msg in enumerate(messages):
        if str(msg.get("role") or "user") == "user":
            last_user_content = str(msg.get("content") or "")
        else:
            trigger_by_index[idx] = last_user_content
    return trigger_by_index


def _recent_context_messages(
    all_messages: list,
    max_rounds: int = 3,
    include_socratic: bool = False,
    current_prompt: str = "",
    summary_rounds: int = 7,
    budget_tokens: int = 0,
) -> list:
    """按最近用户轮次截取上下文，保留消息内容但剥离分支元数据。

    上下文瘦身策略（旧窗口装配：无 branch_id / workflow_context 的请求，工作流、分支、
    滚动记忆共用）：
    - 最近 max_rounds 轮：用户消息完整保留（超长时截断到上限）；最近一条
      assistant 消息完整保留（<viz>/```html``` 大段 HTML 默认替换为占位符，
      仅当触发它的那条用户提问涉及可视化时才保留）；更早的 assistant 只保留
      摘要。
    - 更早的 summary_rounds 轮：每轮拆成「用户一行 + AI 一行」的摘要对，
      帮助长会话里理解"之前说过/继续"类指代，成本极低。
    - budget_tokens > 0 时，最后按 token 预算收缩（恒保护最后一条完整消息）。
    - current_prompt 保留在签名里只为兼容旧调用；viz 判定已改锚在每条
      assistant 自己的触发提问上（前缀缓存拍板，2026-09-21）。
    """
    messages = all_messages
    if not include_socratic:
        messages = [msg for msg in all_messages if not _is_socratic_message(msg)]
    trigger_by_index = _viz_trigger_map(messages)
    full = []
    digest = []
    rounds = 0
    assistant_count = 0
    summary_rounds_seen = 0
    pending_ai = ""
    for idx in range(len(messages) - 1, -1, -1):
        msg = messages[idx]
        role = msg.get("role", "user")
        content = str(msg.get("content") or "")
        if role == "user":
            if rounds < max_rounds:
                if len(content) > _CONTEXT_MAX_USER_CHARS:
                    content = content[:_CONTEXT_MAX_USER_CHARS] + "\n…（已截断）"
                full.insert(0, {"role": "user", "content": content})
                rounds += 1
            elif summary_rounds_seen < summary_rounds:
                digest.insert(0, {"role": "user", "content": "（更早对话）用户：" + content[:80]})
                if pending_ai:
                    digest.insert(1, {"role": "assistant", "content": "（更早对话）AI：" + pending_ai})
                pending_ai = ""
                summary_rounds_seen += 1
            else:
                break
        else:
            if rounds < max_rounds:
                if assistant_count == 0:
                    content = _trim_context_content(
                        content, keep_viz=_prompt_wants_viz(trigger_by_index.get(idx, "")))
                else:
                    content = _graph_message_summary(msg)
                full.insert(0, {"role": "assistant", "content": content})
                assistant_count += 1
            elif summary_rounds_seen < summary_rounds:
                pending_ai = _graph_message_summary(msg)[:120]
            else:
                break
    if pending_ai and summary_rounds_seen < summary_rounds:
        digest.insert(0, {"role": "assistant", "content": "（更早对话）AI：" + pending_ai})
    result = digest + full
    if budget_tokens and budget_tokens > 0:
        # 恒保护最后一条完整消息（09-20 不变量的制度化）：模块再生成等场景
        # 它是唯一全文输入；没有记忆第二刀之后，这一刀就是唯一收缩点
        keep = {str(result[-1].get("content") or "")} if result else set()
        result = _shrink_history_to_budget(result, budget_tokens, keep)
    return result


def _extract_section(content: str, tag: str) -> str:
    match = re.search(rf"<{tag}>([\s\S]*?)</{tag}>", content or "", re.I)
    return match.group(1).strip() if match else ""


def _branch_source_content(content: str, source_module: str) -> str:
    """从父回答中只取出当前分支聚焦的模块内容。"""
    if source_module in ("physics", "math", "graph", "extend"):
        return _extract_section(content, source_module)
    if source_module in ("viz", "visualization"):
        viz = _extract_section(content, "viz")
        if viz:
            return viz
        graph = _extract_section(content, "graph")
        html_match = re.search(r"```html\s*([\s\S]*?)```", graph, re.I)
        if html_match:
            return f"```html\n{html_match.group(1)}\n```"
        return graph
    return content or ""


def _extract_parent_source(all_messages: list, parent_id: str, source_module: str) -> str:
    """从父消息中提取当前分支聚焦模块的正文；找不到时返回空串。"""
    for msg in all_messages:
        if msg.get("role") == "assistant" and str(msg.get("timestamp")) == str(parent_id):
            return _branch_source_content(str(msg.get("content") or ""), source_module)
    return ""


def _load_messages(session_id: str) -> list:
    """读取会话消息；真实路径走缓存，字符串/测试兼容路径回退普通读取。"""
    try:
        messages_path = _resolve_messages_path(session_id)
    except ValueError:
        return []
    if hasattr(messages_path, "stat"):
        return _read_json_cached(messages_path, [])
    return _read_json(messages_path, [])


# ====== 滚动会话记忆（长会话） ======
ROLLING_MEMORY_KEY_PREFIX = "mem:"
ROLLING_MEMORY_TRIGGER_MESSAGES = 15
ROLLING_MEMORY_REFRESH_GAP = 8
ROLLING_MEMORY_MAX_CHARS = 1500
ROLLING_MEMORY_INPUT_MAX_CHARS = 4000


def _rolling_memory_key(session_id: str) -> str:
    return f"{ROLLING_MEMORY_KEY_PREFIX}{session_id}"


def _session_aliases(session_id: str) -> list:
    """返回会话的精确标识列表：local id 在前，server sessionId 别名在后。

    消息文件只有一份（按 local id 落盘），摘要会以两种键出现——上下文加载用
    local id（_load_session_context），而旧的 schedule 触发也可能带远端别名
    id。别名关系存在 sessions.json 里，所以删除必须赶在会话条目被删之前读。
    """
    ids = [session_id]
    sessions = storage._read_json(storage.SESSIONS_PATH, {})
    entry = sessions.get(session_id) if isinstance(sessions, dict) else None
    alias = entry.get("sessionId") if isinstance(entry, dict) else None
    if isinstance(alias, str) and alias and alias not in ids:
        # 直接消息文件优先，其次按 sessions 顺序解析别名；冲突时不误删别人的摘要。
        try:
            if storage._resolve_messages_path(alias) == storage._get_messages_path(session_id):
                ids.append(alias)
        except ValueError:
            pass
    return ids


def _memory_owner(session_id: str) -> str:
    """记忆归属：能唯一证明时返回该会话的 local id，证明不了返回空串。

    写入时把归属记进记录里，删除会话时即使 sessions.json 的别名映射已经丢失
    （备份恢复、数据漂移），也能按归属找回按别名落盘的那条记忆，不留孤儿键。
    多会话共用同一 server sessionId 时归属不唯一，宁可留键也不猜。
    """
    if not session_id:
        return ""
    sessions = storage._read_json(storage.SESSIONS_PATH, {})
    if not isinstance(sessions, dict):
        return ""
    if session_id in sessions:
        return session_id
    owners = [sid for sid, data in sessions.items()
              if isinstance(data, dict) and data.get("sessionId") == session_id]
    return owners[0] if len(owners) == 1 else ""


def _orphan_memory_keys(data: dict, ids: list, owner: str) -> list:
    """按记录里的 owner 找回「别名已从 sessions.json 消失」的记忆键。

    只清理能证明不再属于别人的键：本身是活跃会话键、自己有消息文件、或仍有会话
    声明该别名（含多会话共用同一别名）的，一律保留——与 _session_aliases 的冲突
    保护同口径，宁可留一个孤儿键也不误删别人的记忆。
    """
    if not owner:
        return []
    sessions = storage._read_json(storage.SESSIONS_PATH, {})
    live = set(sessions) if isinstance(sessions, dict) else set()
    claimed = {e.get("sessionId") for e in sessions.values() if isinstance(e, dict)}
    known = {_rolling_memory_key(sid) for sid in ids}
    found = []
    for key, record in data.items():
        if not key.startswith(ROLLING_MEMORY_KEY_PREFIX) or key in known:
            continue
        if not isinstance(record, dict) or record.get("owner") != owner:
            continue
        alias = key[len(ROLLING_MEMORY_KEY_PREFIX):]
        if alias in live or alias in claimed:
            continue
        try:
            if storage._get_messages_path(alias).exists():
                continue
        except ValueError:
            continue
        found.append(key)
    return found


def _read_rolling_memory(session_id: str):
    if not session_id:
        return None
    data = _read_json(_config_mod.KV_PATH, {})
    if not isinstance(data, dict):
        return None
    # 摘要会以 local id 或 server sessionId 两种键出现（见 _session_aliases）：
    # 读侧按同一归属列表回退，避免上下文加载与写入用了不同键时读不到。
    for key in _session_aliases(session_id):
        mem = data.get(_rolling_memory_key(key))
        if isinstance(mem, dict) and mem.get("summary"):
            return mem
    return None

# 内存代次不放 KV：清空全部会把 KV 写成 {}，不能随之重置防回写凭据。
# 单进程服务重启会终止所有旧任务，因此无需跨进程持久化。
_rolling_memory_epoch = 0
_rolling_memory_generations = {}


def _rolling_memory_generation(session_id: str) -> tuple:
    """调度前捕获；全局代次也覆盖尚无摘要/未登记的会话。"""
    with storage._JSON_LOCK:
        return (_rolling_memory_epoch, _rolling_memory_generations.get(session_id, 0))


def _write_rolling_memory(session_id: str, summary: str, message_count: int,
                          *, expected_generation=None, snapshot=None) -> bool:
    """删除代次校验与写入共用 JSON 锁；返回是否实际写入。"""
    if not session_id or not summary:
        return False
    owner = _memory_owner(session_id)

    def updater(data):
        data[_rolling_memory_key(session_id)] = {
            "summary": str(summary).strip()[:ROLLING_MEMORY_MAX_CHARS],
            "messageCount": snapshot["messageCount"],
            "coveredMessageCount": snapshot["coveredMessageCount"],
            "coveredPrefix": snapshot["coveredPrefix"],
            "backlog": snapshot["backlog"],
            "owner": owner,
            "updatedAt": int(time.time() * 1000),
        }
        return data

    with storage._JSON_LOCK:
        if (expected_generation is not None
                and expected_generation != _rolling_memory_generation(session_id)):
            return False
        if snapshot is None:
            snapshot = _rolling_memory_snapshot(session_id, message_count=message_count)
            if not snapshot["messageCount"]:
                def write_legacy(data):
                    data[_rolling_memory_key(session_id)] = {
                        "summary": str(summary).strip()[:ROLLING_MEMORY_MAX_CHARS],
                        "messageCount": int(message_count or 0),
                        "owner": owner,
                        "updatedAt": int(time.time() * 1000),
                    }
                    return data
                _mutate_json(_config_mod.KV_PATH, write_legacy)
                return True
        messages = _load_messages(session_id)
        # 拒绝条件按「哪些变化会让这次摘要失效」定：整段历史被截断（位置信息作废，
        # 下次重算）或覆盖区被改写（会把过期内容写进记忆）才拒绝；尾部新增或编辑
        # 不影响已覆盖内容，不该丢掉这次（已经付费换来的）摘要。
        covered = int(snapshot.get("coveredMessageCount") or 0)
        if (len(messages) < snapshot["messageCount"]
                or _rolling_prefix(messages[:covered]) != snapshot["coveredPrefix"]
                or _read_rolling_memory(session_id) != snapshot["baseMemory"]):
            return False
        _mutate_json(_config_mod.KV_PATH, updater)
        return True


def _delete_rolling_memory(session_id: str) -> None:
    """在删除会话映射/消息前调用，清理该会话的精确键与归属它的记忆。

    除了 sessions.json 仍能证明的别名，还按记录里的 owner 找回映射已丢失的别名键，
    避免留下永远注入不出去的孤儿记忆。
    """
    if not session_id:
        return
    with storage._JSON_LOCK:
        ids = _session_aliases(session_id)
        for sid in ids:
            _rolling_memory_generations[sid] = _rolling_memory_generations.get(sid, 0) + 1

        def updater(data):
            present = [key for key in (_rolling_memory_key(sid) for sid in ids) if key in data]
            orphans = [key for key in _orphan_memory_keys(data, ids, session_id) if key not in present]
            if not present and not orphans:
                return None  # 该会话没有记忆：不重写文件
            for key in present + orphans:
                data.pop(key, None)
                # 别名的在途任务同样作废，否则它会按新代次把记忆写回来
                alias = key[len(ROLLING_MEMORY_KEY_PREFIX):]
                _rolling_memory_generations[alias] = _rolling_memory_generations.get(alias, 0) + 1
            return data

        _mutate_json(_config_mod.KV_PATH, updater)


def _clear_all_rolling_memory() -> None:
    """全局代次推进，使所有旧任务失效；后续清空整个 KV 也不会重置代次。"""
    global _rolling_memory_epoch
    with storage._JSON_LOCK:
        _rolling_memory_epoch += 1
        _rolling_memory_generations.clear()

        def updater(data):
            return {key: value for key, value in data.items()
                    if not key.startswith(ROLLING_MEMORY_KEY_PREFIX)}

        _mutate_json(_config_mod.KV_PATH, updater)


def _rolling_summary_due(session_id: str) -> int:
    """返回需要生成/刷新滚动记忆时的当前消息数；不需要返回 0。"""
    if not session_id:
        return 0
    messages = _load_messages(session_id)
    count = len(messages)
    if count < ROLLING_MEMORY_TRIGGER_MESSAGES:
        return 0
    mem = _read_rolling_memory(session_id)
    if not mem:
        return count
    cursor = mem.get("coveredMessageCount")
    if cursor is not None and (not isinstance(cursor, int) or not 0 <= cursor <= count
            or mem.get("coveredPrefix") != _rolling_prefix(messages[:cursor])
            or mem.get("backlog")):
        return count
    if count - int(mem.get("messageCount") or 0) >= ROLLING_MEMORY_REFRESH_GAP:
        return count
    return 0


def _rolling_prefix(messages: list) -> str:
    return hashlib.sha256(json.dumps(messages, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _rolling_memory_snapshot(session_id: str, max_old_pairs: int = 6, message_count=None) -> dict:
    with storage._JSON_LOCK:
        messages = deepcopy(_load_messages(session_id))
        if message_count is not None:
            messages = messages[:max(0, int(message_count))]
        mem = deepcopy(_read_rolling_memory(session_id))
    count = len(messages)
    starts = [i for i, m in enumerate(messages)
              if m.get("role") == "user" and not _is_socratic_message(m)]
    # 最近三轮保留原文；提前压缩七轮摘要窗口内的内容，避免刷新间隔造成遗漏。
    end = starts[-3] if len(starts) > 3 else 0
    cursor = (mem or {}).get("coveredMessageCount", 0)
    valid = (isinstance(cursor, int) and 0 <= cursor <= count
             and (mem or {}).get("coveredPrefix") == _rolling_prefix(messages[:cursor]))
    if not valid:
        cursor = 0
    prefix = "旧记忆：" + str(mem.get("summary") or "")[:ROLLING_MEMORY_MAX_CHARS] if mem and (valid or "coveredMessageCount" not in mem) else ""
    parts = [prefix] if prefix else []
    used = cursor
    boundaries = [i for i in starts if cursor <= i < end] + [end]
    for start, stop in list(zip(boundaries, boundaries[1:]))[:max_old_pairs]:
        digest = _recent_context_messages(messages[start:stop], max_rounds=0, summary_rounds=1)
        block = "\n".join(("用户：" if m.get("role") == "user" else "AI：")
                          + str(m.get("content") or "")[:300] for m in digest)
        if not block:
            used = stop
            continue
        if len("\n\n".join(parts + [block])) > ROLLING_MEMORY_INPUT_MAX_CHARS:
            break
        parts.append(block)
        used = stop
    return {"text": "\n\n".join(parts), "messageCount": count,
            "coveredMessageCount": used, "coveredPrefix": _rolling_prefix(messages[:used]),
            "sourcePrefix": _rolling_prefix(messages), "baseMemory": mem,
            "backlog": used < end}


def _rolling_memory_input(session_id: str, max_old_pairs: int = 6) -> str:
    return _rolling_memory_snapshot(session_id, max_old_pairs)["text"]


def rolling_memory_block(session_id: str) -> str:
    """滚动会话记忆的注入文本（无记忆时返回空串）。

    前缀缓存拍板（2026-09-21）：记忆不再 insert 进历史第 0 位——它站在整个
    历史区之前，而摘要每 8 条消息刷新一次，等于把「system+全部历史」的
    provider 前缀缓存整个打灭。改为返回文本，由调用方（main.py 组装）并入
    历史之后的上下文块、拼进最后一条 user 消息头部；「注入后第二刀收缩」
    也随之取消，预算收缩只剩一刀。
    """
    mem = _read_rolling_memory(session_id)
    if not mem:
        return ""
    return "（会话记忆）" + str(mem.get("summary") or "")[:ROLLING_MEMORY_MAX_CHARS]


def _load_session_context(
    session_id: str,
    max_rounds: int = 3,
    include_socratic: bool = False,
    branch_id: str = "",
    branch_type: str = "",
    source_module: str = "",
    parent_id: str = "",
    graph_path: list = None,
    current_prompt: str = "",
    workflow_context: dict = None,
    budget_tokens: int = 0,
) -> list:
    """加载会话上下文消息，支持探索网分支隔离。

    无 branch_id 的默认装配过滤苏格拉底支线；当传入 branch_id 时，保留主线最近内容、
    父回答中聚焦模块的内容，以及该分支自己的消息链。
    budget_tokens > 0 时按 token 预算收缩（保留最后一条消息）。
    """
    all_messages = _load_messages(session_id)
    if not all_messages:
        return []
    if graph_path:
        return _load_session_context_from_path(
            session_id,
            graph_path,
            branch_id=branch_id,
            source_module=source_module,
            max_rounds=max_rounds,
            current_prompt=current_prompt,
            workflow_context=workflow_context,
            budget_tokens=budget_tokens,
        )
    if not branch_id:
        # 2026-09-25 线性主聊天退役（前缀缓存拍板的追加式历史区随现役 UI 的
        # 线性通道一起删除，恢复见 docs/dev/linear-chat-retired.md）：无 branch
        # 的组合（quick 寒暄 / 工作流 / 苏格拉底状态 / 边缘组合）统一走旧窗口
        # 口径；现役 UI 的新话题提问全走工作流（workflow_context 命中此处）。
        return _recent_context_messages(
            all_messages, max_rounds, include_socratic, current_prompt,
            budget_tokens=budget_tokens,
        )

    branch_messages = [msg for msg in all_messages if msg.get("branchId") == branch_id]
    main_messages = [msg for msg in all_messages if not msg.get("branchId") and not _is_socratic_message(msg)]
    result = _recent_context_messages(main_messages, min(2, max_rounds), False, current_prompt)
    seen = {}
    main_ts = _content_timestamp_map(main_messages)
    for item in result:
        seen.setdefault((main_ts.get(item["content"], ""), item["content"]), True)

    target_parent = parent_id or (branch_messages[0].get("parentId") if branch_messages else "")
    source_ts = target_parent
    if target_parent:
        source = _extract_parent_source(all_messages, target_parent, source_module)
        if not source and branch_messages:
            fallback_parent = branch_messages[0].get("parentId") or ""
            if fallback_parent and str(fallback_parent) != str(target_parent):
                source = _extract_parent_source(all_messages, fallback_parent, source_module)
                source_ts = fallback_parent
        if source and (str(source_ts), source) not in seen:
            result.append({"role": "assistant", "content": source})
            seen[(str(source_ts), source)] = True

    branch_ts = _content_timestamp_map(branch_messages)
    for item in _recent_context_messages(branch_messages, max_rounds, True, current_prompt):
        key = (branch_ts.get(item["content"], ""), item["content"])
        if key not in seen:
            result.append(item)
            seen[key] = True

    if budget_tokens and budget_tokens > 0:
        result = _shrink_history_to_budget(result, budget_tokens)
    # 分支路径同样不再注入会话记忆（见 rolling_memory_block 的拍板说明）
    return result

def _branch_context_instruction(
    branch_type: str = "",
    source_module: str = "",
    branch_label: str = "",
    parent_id: str = "",
) -> str:
    """为 AI 提供当前探索网分支的显式上下文。"""
    labels = {
        "followup": "追问",
        "confused": "没看懂",
        "socratic": "苏格拉底追问",
        "learn": "进阶学习",
        "continue": "自由续问",
        "blank": "空白节点",
    }
    module_labels = {
        "physics": "物理视角",
        "math": "数学视角",
        "graph": "知识图谱",
        "viz": "交互可视化",
        "socratic": "苏格拉底追问",
        "learn": "进阶学习",
    }
    lines = ["\n\n# 探索网分支上下文"]
    lines.append(f"- 当前分支类型：{labels.get(branch_type, branch_type or '主线')}")
    if source_module:
        lines.append(f"- 当前聚焦气泡：{module_labels.get(source_module, source_module)}")
    if branch_label:
        lines.append(f"- 分支标签：{branch_label}")
    if parent_id:
        lines.append(f"- 父回答消息 ID：{parent_id}")
    if branch_type == "confused":
        lines.append("- 用户没有看懂当前聚焦气泡，请换更简单、更生活化的方式只重讲这个模块，不要重复其他模块。")
    elif branch_type == "followup":
        lines.append("- 用户希望对当前聚焦气泡继续深入，只围绕该模块增量讲解，不重新生成完整学习卡片。")
    elif branch_type == "socratic":
        lines.append("- 用户正在回答苏格拉底追问，请按闭环规则只推进一层，不直接给出完整答案。")
    elif branch_type == "learn":
        lines.append("- 用户选择了进阶学习方向，请以该方向为目标，基于父回答生成新的完整探索回答簇。")
    elif branch_type == "continue":
        lines.append("- 用户在当前节点自由续问；若问题与当前气泡无关，可以作为新主线回答。")
    elif branch_type == "blank":
        lines.append("- 用户通过空白画布节点要求生成该模块的正文；只输出该模块内容，不要输出完整学习卡片的 XML 标签。")
        strict_instruction = _module_output_instruction(source_module)
        if strict_instruction:
            lines.append(strict_instruction)
    return "\n".join(lines)


def _module_output_instruction(module_key: str) -> str:
    if module_key == "socratic":
        return (
            "严格输出苏格拉底追问小节，格式如下，不得增加任何前言、答案、解释或无关小节：\n"
            "### 苏格拉底追问\n"
            "1. [基础] 只写一个基础引导问题\n"
            "2. [进阶] 只写一个进阶引导问题\n"
            "3. [拓展] 只写一个拓展引导问题\n"
            "禁止输出 XML 标签，禁止输出“进阶学习方向”，禁止展开问题背景或写“想一想”等引导语。"
        )
    if module_key == "learn":
        return (
            "严格输出进阶学习方向小节，格式如下，不得增加任何前言、公式段、步骤讲解或无关小节：\n"
            "### 进阶学习方向\n"
            "1. 方向1\n"
            "2. 方向2\n"
            "3. 方向3\n"
            "禁止输出 XML 标签，禁止输出“苏格拉底追问”，每条方向只保留一个短句。"
        )
    if module_key == "graph":
        return (
            "严格输出知识图谱 Mermaid 代码，不要输出其他模块、不要输出 XML 标签：\n"
            "用 ```mermaid ... ``` 代码块包裹；至少 3 个上游 + 3 个下游概念，中文标注，箭头表示关系，节点文字避免括号（可用下划线替代）。"
        )
    if module_key == "viz":
        return (
            "严格输出 ```html ... ``` 完整 HTML 交互可视化页面，禁止只输出文字描述而不输出 HTML：\n"
            "页面内顶部必须包含图说四段（用页面内可见标题/提示框呈现，缺一不可）：\n"
            "**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n"
            "**怎么看这张图**：1. 2. 3. 编号观察步骤，每步“操作 → 会看到什么”；\n"
            "**和公式的联系**：图中现象与公式如何互相印证；\n"
            "**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n"
            "每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n"
            "不要输出 XML 标签，不要输出其他模块内容。"
        )
    return ""


def _graph_message_summary(message: dict, module_key: str = "") -> str:
    content = str(message.get("content") or "")
    if not module_key:
        cached = str(message.get("summary") or "").strip()
        if cached:
            return cached[:200]
    if module_key:
        content = _branch_source_content(content, module_key)
    match = re.search(r"<summary>([\s\S]*?)</summary>", content, re.I)
    if match:
        return match.group(1).strip()[:200]
    text = re.sub(r"<[^>]+>", " ", content)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= 180:
        return text
    # 按句子边界截断，避免切在公式/半句话中间
    head = text[:180]
    for sep in ("。", "！", "？", ". ", "! ", "? "):
        idx = head.rfind(sep)
        if idx > 40:
            return head[:idx + len(sep)].strip() + "…"
    return head + "…"

def _graph_path_instruction(graph_path: list, source_module: str = "") -> str:
    if not graph_path:
        return ""
    labels = {
        "user": "问题",
        "answer": "AI 回答簇",
        "module": "模块",
    }
    module_labels = {
        "physics": "物理视角",
        "math": "数学视角",
        "graph": "知识图谱",
        "viz": "交互可视化",
        "socratic": "苏格拉底追问",
        "learn": "进阶学习",
    }
    lines = ["\n\n# 当前探索路径"]
    for index, item in enumerate(graph_path):
        kind = item.get("kind") or ""
        module_key = item.get("module") or ""
        branch_type = item.get("branchType") or item.get("branch_type") or ""
        if kind == "module":
            label = module_labels.get(module_key, module_key or "模块")
        elif kind == "answer":
            label = labels.get("answer", "AI 回答簇")
        elif kind == "user":
            label = "延伸追问" if branch_type else labels.get("user", "问题")
        else:
            label = kind or "节点"
        lines.append(f"{index + 1}. {label}（消息 ID：{item.get('timestamp') or ''}）")
    if source_module:
        lines.append(f"- 当前聚焦气泡：{module_labels.get(source_module, source_module)}")
    lines.append("- 上下文只围绕当前探索路径展开；路径各节点在历史区均为摘要，当前聚焦节点的完整正文见下方「当前节点正文（参考资料）」段。")
    if source_module in ("socratic", "learn"):
        lines.append("- 当前节点为 socratic/learn 局部节点，必须只输出三行列表，不要展开为完整讲解。")
    lines.append("- 不要重新展开无关分支，也不要重复其他模块的完整内容。")
    return "\n".join(lines)


# T4 前缀缓存拍板（2026-10-01）：工作流上下文拆 shared/target 两段。shared 段
# （question/analysis/upstream）对同一次工作流的兄弟模块逐字节相同，前置供其命中
# 请求前缀；per-module 的 target 块与严格格式指令后移到公共前缀之后的缓存断点。
def _workflow_context_parts(workflow_context) -> tuple:
    """拆分工作流上下文：(shared, target)，shared 为兄弟模块公共前缀段。"""
    if not isinstance(workflow_context, dict):
        return ("", "")
    mode = workflow_context.get("mode") or ""
    target = workflow_context.get("target") or {}
    question = str(workflow_context.get("question") or "").strip()
    analysis = str(workflow_context.get("analysis") or "").strip()
    requirements = str(workflow_context.get("requirements") or "").strip()
    upstream = workflow_context.get("upstream") or []
    shared_lines = ["\n\n# 工作流节点上下文"]
    if question:
        shared_lines.append(f"- 原始问题：{question[:1200]}")
    if analysis:
        shared_lines.append(f"- 隐藏问题分析（用于保持一致）：{analysis[:1200]}")
    for item in upstream[:8]:
        label = item.get("label") or item.get("kind") or "上游节点"
        content = str(item.get("summary") or item.get("content") or "").strip()
        if content:
            shared_lines.append(f"- {label}：{content[:800]}")
    target_lines = ["\n\n# 工作流节点生成指令"]
    if mode == "analysis":
        target_lines.append("- 当前为隐藏问题分析模式：只输出简洁问题概要，不生成任何模块内容，不输出 XML 标签，不生成完整回答。")
        target_lines.append("- 概要末尾单独一行列出建议生成的知识网络模块方向，格式：建议模块：物理视角、数学视角（候选：物理视角/数学视角/知识图谱/交互可视化/苏格拉底追问/进阶学习；追问等场景按实际需要选择，不必全部列出，也不要超出候选）。")
    if target:
        target_label = target.get("label") or target.get("module") or target.get("kind") or "目标节点"
        target_lines.append(f"- 当前生成目标：{target_label}")
        if target.get("module"):
            target_lines.append(f"- 当前模块：{target['module']}")
        if target.get("kind") == "module":
            target_lines.append("- 当前为局部节点生成模式：只生成该模块正文，不要输出完整学习卡片，不要输出其他模块。")
            strict_instruction = _module_output_instruction(target.get("module", ""))
            if strict_instruction:
                target_lines.append(strict_instruction)
        elif target.get("kind") == "answer":
            target_lines.append("- AI 回答节点是分发节点，不生成正文内容。")
        elif target.get("kind") == "summary":
            target_lines.append("- 当前为 AI 总结节点：根据上游内容生成简明总结正文。")
            target_lines.append("- 只输出总结正文，可使用 Markdown/LaTeX；不要输出完整学习卡片 XML，不要输出 physics/math/graph/viz/extend/summary 标签，不要输出 socratic_meta。")
            target_lines.append("- 总结中如出现公式，仍按全局 <formula> 规范标注，不标注单个符号或单位。")
        elif target.get("kind") == "hub":
            target_lines.append("- 汇聚节点只负责收集上游内容，不生成正文。")
        elif target.get("kind") == "note":
            target_lines.append("- 人工总结节点由用户手动填写，AI 不生成正文。")
    if requirements:
        target_lines.append(f"- 用户额外要求：{requirements[:600]}")
    target_lines.append("- 只生成当前目标节点内容，不重新生成完整回答；上游内容以摘要形式提供，不要重复无关模块。")
    shared = "\n".join(shared_lines) if len(shared_lines) > 1 else ""
    target_text = "\n".join(target_lines) if len(target_lines) > 1 else ""
    return (shared, target_text)


def _workflow_context_instruction(workflow_context) -> str:
    """薄封装：两段非空部分拼接，行为＝拆分前的整块重排版。"""
    return "".join(p for p in _workflow_context_parts(workflow_context) if p)


def _load_session_context_from_path(
    session_id: str,
    graph_path: list,
    branch_id: str = "",
    source_module: str = "",
    max_rounds: int = 3,
    current_prompt: str = "",
    workflow_context: dict = None,
    budget_tokens: int = 0,
) -> list:
    all_messages = _load_messages(session_id)
    if not all_messages or not graph_path:
        return []
    by_ts = {str(msg.get("timestamp") or ""): msg for msg in all_messages}
    result = []
    seen = {}
    active_index = len(graph_path) - 1
    skip_upstream = bool(workflow_context and workflow_context.get("upstream"))

    for index, item in enumerate(graph_path):
        msg = by_ts.get(str(item.get("timestamp") or ""))
        if not msg:
            continue
        is_active = index == active_index
        role = msg.get("role") or "assistant"
        module_key = item.get("module") or item.get("moduleKey") or ""
        ts = str(item.get("timestamp") or "")
        if role == "user":
            # user 节点恒全文：内容写入后永不变（不是翻转源），且摘要化伤指代理解
            content = str(msg.get("content") or "")
        elif is_active or not skip_upstream:
            # 前缀缓存拍板（2026-09-24）：assistant 节点历史区一律摘要（含当前聚
            # 焦节点）。此前「当前节点全文、上游摘要」让每次下钻把上一层从全文翻
            # 成摘要，该位置之后的 provider 前缀缓存全部打灭；一律摘要后历史区严
            # 格只增不改，当前节点全文改由 tree_active_content_block 进尾部上下文块。
            content = _graph_message_summary(msg, module_key)
        else:
            continue
        if not content:
            continue
        key = (ts, content)
        if key in seen:
            continue
        result.append({"role": role, "content": content})
        seen[key] = True

    if branch_id:
        branch_messages = [
            msg for msg in all_messages
            if str(msg.get("branchId") or "") == str(branch_id)
        ]
        branch_ts = _content_timestamp_map(branch_messages)
        for item in _recent_context_messages(branch_messages, max_rounds, True, current_prompt):
            key = (branch_ts.get(item["content"], ""), item["content"])
            if key not in seen:
                result.append(item)
                seen[key] = True

    if budget_tokens and budget_tokens > 0:
        # 前缀缓存拍板（2026-09-24）：protected 保护集随全文出历史区一并取消——
        # 历史区全为摘要/短问题，预算收缩几乎不再触发；当前节点全文活在尾部
        # 上下文块（tree_active_content_block），本就不经过收缩。
        result = _shrink_history_to_budget(result, budget_tokens)
    # 会话记忆改由 main.py 并入上下文块，此处不再二次注入/收缩
    return result


def tree_active_content_block(
    session_id: str,
    graph_path: list,
    source_module: str = "",
    branch_id: str = "",
) -> str:
    """当前聚焦节点的模块全文，作为尾部上下文块的参考资料段（无内容返回空串）。

    前缀缓存拍板（2026-09-24）：路径历史区的 assistant 节点一律摘要（见
    _load_session_context_from_path），当前节点的全文改由本函数提供、由 main.py
    并入末条 user 消息的上下文块——历史区从此只增不改，下钻零打灭；工作流模块
    再生成所需的唯一全文输入也随之落在尾部块。原「active_parent_missing 时全文
    回退分支父回答」的逻辑随全文一起迁入本块。与旧历史区行为平价：不设长度上限。
    """
    if not graph_path:
        return ""
    all_messages = _load_messages(session_id)
    if not all_messages:
        return ""
    by_ts = {str(msg.get("timestamp") or ""): msg for msg in all_messages}
    active = graph_path[-1] if graph_path else {}
    content = ""
    msg = by_ts.get(str((active or {}).get("timestamp") or ""))
    if msg and (msg.get("role") or "assistant") != "user":
        module_key = (active or {}).get("module") or (active or {}).get("moduleKey") or ""
        if module_key:
            content = _branch_source_content(str(msg.get("content") or ""), module_key)
        else:
            content = str(msg.get("content") or "")
    if not content and branch_id:
        branch_messages = [
            m for m in all_messages
            if str(m.get("branchId") or "") == str(branch_id)
        ]
        fallback_parent = branch_messages[0].get("parentId") if branch_messages else ""
        if fallback_parent:
            content = _extract_parent_source(all_messages, fallback_parent, source_module)
    if not content:
        return ""
    return "# 当前节点正文（参考资料）\n" + content


# 前缀缓存拍板（2026-09-25 三代窗）：上游节点详摘要的目标长度。落盘时按此
# 算好存进消息 summary_detail 字段，读取侧永不改写。
DETAIL_SUMMARY_CHARS = 800


def summary_detail(message: dict, module_key: str = "") -> str:
    """上游节点的「详摘要」（三代窗用）：与 200 字摘要同一套清洗与句界截断，
    只是更长（DETAIL_SUMMARY_CHARS）。出生定形——落盘时算好存
    summary_detail 字段；旧数据缺字段时按存量内容现算，截断是内容的确定性
    函数，同一消息永远得到同一串字节，不引入翻转源。"""
    cached = str(message.get("summary_detail") or "").strip()
    if cached:
        return cached[:DETAIL_SUMMARY_CHARS]
    content = str(message.get("content") or "")
    if module_key:
        content = _branch_source_content(content, module_key)
    text = re.sub(r"<[^>]+>", " ", content)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= DETAIL_SUMMARY_CHARS - 20:
        return text
    head = text[:DETAIL_SUMMARY_CHARS - 20]
    for sep in ("。", "！", "？", ". ", "! ", "? "):
        idx = head.rfind(sep)
        if idx > 40:
            return head[:idx + len(sep)].strip() + "…"
    return head + "…"


def tree_upstream_detail_block(
    session_id: str,
    graph_path: list,
    source_module: str = "",
    branch_id: str = "",
) -> str:
    """三代窗的上游两代详摘要段（尾部上下文块用，无 assistant 上游返回空串）。

    前缀缓存拍板（2026-09-25）：父与祖父各 ~800 字详情（summary_detail），
    与当前节点全文（tree_active_content_block）一起构成「当前全文 + 上两代
    详情」的尾部易变区。历史区只增不改不受影响——下钻时尾部本就在公共前缀
    断点之后，加细节零缓存代价；同一父节点的兄弟请求该段逐字节相同（内容取
    自共享链路上的出生定形字节，祖父→父顺序由路径深度决定，天然确定），公共
    前缀反而变长。user 祖先不进本段（历史区已是全文）。"""
    if not graph_path or len(graph_path) < 2:
        return ""
    all_messages = _load_messages(session_id)
    if not all_messages:
        return ""
    by_ts = {str(msg.get("timestamp") or ""): msg for msg in all_messages}
    active_index = len(graph_path) - 1
    labels = {1: "父节点", 2: "祖父节点"}
    sections = []  # 祖父在前、父在后，与链路顺序一致
    for offset in (2, 1):
        idx = active_index - offset
        if idx < 0:
            continue
        item = graph_path[idx] or {}
        msg = by_ts.get(str(item.get("timestamp") or ""))
        if not msg or (msg.get("role") or "assistant") == "user":
            continue
        module_key = item.get("module") or item.get("moduleKey") or ""
        detail = summary_detail(msg, module_key)
        if not detail:
            continue
        sections.append(f"【{labels[offset]}】\n{detail}")
    if not sections:
        return ""
    return "# 上游节点详情（参考资料）\n" + "\n\n".join(sections)


SOCRATIC_STATE_PREFIX = "socratic:"

SOCRATIC_STATE_TTL_SECONDS = 24 * 60 * 60
# 低于该值的时间戳视为旧版占位值（非真实 epoch），不做 TTL 清理
SOCRATIC_STATE_TS_SANITY = 100_000_000


def _socratic_state_updated_seconds(state) -> int:
    """updatedAt 折算为秒：历史写侧是毫秒（time.time()*1000），秒级旧数据与
    占位值直接共存于同一字段，按量级识别（>=1e12 视为毫秒）；缺失/占位返回 0。"""
    if not isinstance(state, dict):
        return 0
    try:
        updated = int(state.get("updatedAt") or 0)
    except (TypeError, ValueError):
        return 0
    if updated < SOCRATIC_STATE_TS_SANITY:
        return 0
    return updated // 1000 if updated >= 1_000_000_000_000 else updated


def _socratic_state_expired(state, now: int = None) -> bool:
    """苏格拉底状态超过 TTL 未更新视为过期；无 updatedAt 或旧版占位时间戳不主动清理。"""
    updated = _socratic_state_updated_seconds(state)
    if not updated:
        return False
    now = now if now is not None else int(time.time())
    return now - updated > SOCRATIC_STATE_TTL_SECONDS


def _socratic_key(ref: str) -> str:
    return f"{SOCRATIC_STATE_PREFIX}{ref}"


def _socratic_branch_prefixes(session_raw: str) -> list:
    """会话的分支状态 key 前缀列表。

    分支 id 形如 br_{会话标识}_{10位hex}。旧版会话标识截前 18 个安全字符，
    前缀相同的两个会话会互相误删/误认状态；现按完整会话标识精确匹配，
    并保留 18 截断的旧前缀以兼容 TTL（24h）内已存的旧格式状态。
    """
    safe = re.sub(r"[^A-Za-z0-9_-]", "", str(session_raw or ""))
    prefixes = []
    if safe:
        prefixes.append(f"{SOCRATIC_STATE_PREFIX}br_{safe}_")
        legacy = safe[:18]
        if legacy and legacy != safe:
            prefixes.append(f"{SOCRATIC_STATE_PREFIX}br_{legacy}_")
    return prefixes


def _read_socratic_state(ref: str):
    # 纯读：过期状态的清理由 _resolve_socratic_branch / 显式删除负责，
    # 读路径不做写副作用
    data = _read_json(KV_PATH, {})
    state = data.get(_socratic_key(ref))
    if isinstance(state, dict) and state.get("active"):
        if _socratic_state_expired(state):
            return None
        return state
    return None


def _write_socratic_state(ref: str, state) -> None:
    def updater(data):
        if state is None:
            data.pop(_socratic_key(ref), None)
        else:
            state["updatedAt"] = int(time.time() * 1000)
            data[_socratic_key(ref)] = state
        return data

    _mutate_json(KV_PATH, updater)


def _delete_socratic_state(ref: str) -> None:
    """删除指定会话/分支的苏格拉底状态。

    兼容三种 key：
    - 精确 key：socratic:{ref}（手动输入路径 / 会话级状态）
    - 分支链前缀：socratic:br_{会话标识}_{10位hex}（“我来回答”弹窗路径）；
      ref 本身是分支 id 时先解出会话标识，按完整标识 + 旧版 18 截断前缀匹配
    """
    def updater(data):
        if not ref:
            return data
        remove_keys = []
        exact = f"{SOCRATIC_STATE_PREFIX}{ref}"
        if exact in data:
            remove_keys.append(exact)
        m = re.match(r"^br_(?P<sess>.+)_[0-9a-fA-F]{10}$", ref)
        session_raw = m.group("sess") if m else ref
        for prefix in _socratic_branch_prefixes(session_raw):
            remove_keys.extend(k for k in data if k.startswith(prefix) and k not in remove_keys)
        for key in remove_keys:
            data.pop(key, None)
        return data

    _mutate_json(KV_PATH, updater)


def _resolve_socratic_branch(session_id: str) -> str:
    """手动输入 [苏格拉底回答] 且未带分支时，定位最近仍在进行的苏格拉底分支。

    优先使用 KV 中该会话最新的活动分支状态；没有活动状态时，回退到消息里
    最近一条苏格拉底消息所在的分支（用于上下文隔离）。过期状态会被清理。
    """
    if not session_id:
        return ""
    data = _read_json(KV_PATH, {})
    prefixes = _socratic_branch_prefixes(session_id)
    best_ref = ""
    # 秒/毫秒混存时按归一化秒比较（占位值与非法值归一化为 0，用原始值打平手，
    # 保持旧数据在同一量级内的原有先后顺序）
    best_key = (-1, -1)
    expired_keys = []
    for key, state in data.items():
        if any(key.startswith(p) for p in prefixes) and isinstance(state, dict) and state.get("active"):
            if _socratic_state_expired(state):
                expired_keys.append(key)
                continue
            try:
                raw_ts = int(state.get("updatedAt") or 0)
            except (TypeError, ValueError):
                raw_ts = 0
            rank = (_socratic_state_updated_seconds(state), raw_ts)
            if rank > best_key:
                best_key = rank
                best_ref = key[len(SOCRATIC_STATE_PREFIX):]
    if expired_keys:
        def updater(d):
            for k in expired_keys:
                d.pop(k, None)
            return d
        _mutate_json(KV_PATH, updater)
    if best_ref:
        return best_ref
    messages = _load_messages(session_id)
    for msg in reversed(messages):
        if msg.get("role") == "user" and _is_socratic_message(msg):
            bid = str(msg.get("branchId") or "")
            if bid:
                return bid
    return ""


def _socratic_state_instruction(ref: str, mode: str = "answer") -> str:
    state = _read_socratic_state(ref)
    if not state:
        return ""
    level = state.get("level", "") or "basic"
    streak = int(state.get("correctStreak", 0) or 0)
    answered = int(state.get("answeredCount", 0) or 0)
    question = state.get("question", "") or ""
    last_correct = state.get("lastCorrect", "") or ""
    last_confidence = state.get("lastConfidence", "") or ""
    lines = [
        f"当前会话处于苏格拉底追问闭环：问题等级={level}，当前问题={question}，"
        f"已连续答对 {streak} 次，本轮闭环已问答 {answered} 轮。"
    ]
    if last_correct:
        lines.append(
            f"上一轮判定：{last_correct}（正确→下一题可升一级加深角度；部分正确→同级换类比再问；有误→降一级并用更生活化的类比）。"
        )
    if last_confidence:
        lines.append(
            f"用户上次自评把握：{last_confidence}（答对但没把握→请其再解释一遍；答错但很有把握→制造认知冲突重点纠偏）。"
        )
    if mode == "hint":
        lines.append(
            "用户请求【提示】：只给出最小提示，不要展开完整讲解、不要直接给答案；"
            "然后再次用带难度前缀的问题请其重试（本次回复不输出 <socratic_meta>）。"
        )
    elif mode == "explain":
        lines.append(
            "用户请求【讲解】：直接给出完整讲解与小结，末尾输出 <socratic_meta ... done=\"true\" /> 结束闭环。"
        )
    else:
        lines.append(
            "用户会以 [苏格拉底回答] 开头携带追问问题、把握程度与自己的回答；请结合最近一条 AI 讲解、当前问题和用户回答继续，"
            "按系统提示词中的闭环规则只推进一层，并在回复末尾输出 <socratic_meta .../>。"
        )
    lines.append("若本轮闭环已问答 4 轮仍未连续答对 2 次，请直接给出小结并结束闭环（done=\"true\"）。")
    return " ".join(lines)


def _sync_socratic_state_from_prompt(state: dict, prompt: str) -> None:
    """延续中的闭环：用 [苏格拉底回答] 消息里的问题/等级刷新状态，保留连对次数与已答轮数。"""
    if not state or not prompt:
        return
    level_match = re.search(r"追问等级[：:]\s*(基础|进阶|拓展)", prompt)
    if level_match:
        level_map = {"基础": "basic", "进阶": "advanced", "拓展": "expand"}
        state["level"] = level_map.get(level_match.group(1), state.get("level", ""))
    question_match = re.search(r"追问问题[：:]\s*([^\n]+)", prompt)
    if question_match and question_match.group(1).strip():
        state["question"] = question_match.group(1).strip()
    confidence_match = re.search(r"把握程度[：:]\s*(很有把握|一般|猜的)", prompt)
    if confidence_match:
        state["lastConfidence"] = confidence_match.group(1)


def _update_socratic_state_from_content(content: str, ref: str) -> None:
    """解析模型输出的 <socratic_meta>，更新或结束分支级追问状态。"""
    if not content or not ref:
        return
    if not _is_socratic_followup(content):
        return
    match = re.search(r"<socratic_meta\b([^>]*?)/?>", content, re.I)
    if not match:
        return

    attrs = match.group(1)
    def attr(name: str, default: str = "") -> str:
        found = re.search(rf'\b{name}\s*=\s*["\']([^"\']*)["\']', attrs, re.I)
        return found.group(1) if found else default

    correct = attr("correct", "").strip().lower()
    done = attr("done", "").strip().lower() in ("1", "true", "yes")
    state = _read_socratic_state(ref) or {
        "active": True,
        "level": "",
        "question": "",
        "correctStreak": 0,
        "answeredCount": 0,
    }
    state["active"] = True
    state["lastCorrect"] = correct
    if correct == "correct":
        state["correctStreak"] = int(state.get("correctStreak", 0) or 0) + 1
    elif correct in ("partial", "wrong"):
        state["correctStreak"] = 0
    state["answeredCount"] = int(state.get("answeredCount", 0) or 0) + 1

    if done or int(state.get("correctStreak", 0) or 0) >= 2:
        _delete_socratic_state(ref)
    else:
        _write_socratic_state(ref, state)




def _is_socratic_followup(content: str) -> bool:
    content = content or ""
    if not re.search(r"<socratic_meta\b", content, re.I):
        return False
    return not re.search(r"<physics>|<math>|<graph>|<extend>|PhyMathia\s*学习卡片", content, re.I)




# ====== 消息逐条合并（前端 session.js _mergeMessageLists 同口径；唯一定义在后端） ======

def _message_identity(msg: dict) -> str:
    ts = msg.get("timestamp")
    if isinstance(ts, (int, float)) and ts:
        return "ts:" + str(ts)
    # 无时间戳的极少数消息：role|content 当身份。不能用整条 JSON——服务端
    # 保存时会回填 summary，JSON 一变身份就变，去重直接失效
    return "raw:" + str(msg.get("role") or "") + "|" + str(msg.get("content") or "")


def _merge_message_fields(base: dict, extra: dict) -> dict:
    merged = dict(base)
    for key, value in extra.items():
        current = merged.get(key)
        is_empty = current is None or current == "" or current == [] or current == {}
        if is_empty and value not in (None, ""):
            merged[key] = value
    return merged


def merge_message_lists(primary, secondary) -> list:
    """两份消息列表按时间戳逐条合并：两边各自独有的都保留，同键字段互补
    （服务端补写的 summary 不被空值覆盖；内容冲突以 primary 为准）。全部
    消息都有时间戳时按时间升序，否则保持插入序（primary 在前）。"""
    by_key = {}
    order = []
    for msg in list(primary or []) + list(secondary or []):
        if not isinstance(msg, dict):
            continue
        key = _message_identity(msg)
        if key not in by_key:
            by_key[key] = dict(msg)
            order.append(key)
        else:
            by_key[key] = _merge_message_fields(by_key[key], msg)
    merged = [by_key[k] for k in order]
    if merged and all(isinstance(m.get("timestamp"), (int, float)) and m.get("timestamp") for m in merged):
        merged.sort(key=lambda m: m["timestamp"])
    return merged


__all__ = [
    "_is_socratic_message", "_is_socratic_prompt_text", "_recent_context_messages", "_extract_section",
    "_branch_source_content", "_extract_parent_source", "_load_session_context", "_branch_context_instruction",
    "_module_output_instruction", "_graph_message_summary", "_graph_path_instruction",
    "_workflow_context_instruction", "_workflow_context_parts", "_load_session_context_from_path",
    "tree_active_content_block", "summary_detail", "tree_upstream_detail_block",
    "DETAIL_SUMMARY_CHARS",
    "_prompt_wants_viz", "_trim_context_content", "VIZ_PLACEHOLDER",
    "SOCRATIC_STATE_PREFIX", "SOCRATIC_STATE_TTL_SECONDS", "estimate_tokens", "resolve_context_budget", "_shrink_history_to_budget", "_content_timestamp_map", "_socratic_state_expired", "_viz_digest", "_socratic_key", "_read_rolling_memory", "_write_rolling_memory", "_rolling_summary_due", "_rolling_memory_input", "rolling_memory_block", "_read_socratic_state",
    "_write_socratic_state", "_delete_socratic_state", "_resolve_socratic_branch", "_socratic_state_instruction",
    "_sync_socratic_state_from_prompt", "_update_socratic_state_from_content", "_is_socratic_followup",
    "merge_message_lists",
]
