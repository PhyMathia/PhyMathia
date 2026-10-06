"""隐式用户画像层（数学模型 v1，2026-10-06）：行为痕迹 → 三元组状态 S=(W, M, F)。

口径唯一事实源：docs/用户画像数学模型-2026-10-06.md（本文件是其可执行实现）。
- W 兴趣向量：带半衰期衰减的加权计数（τ=14 天，底数 2），自激加成带 2 小时时窗
- M 能力向量：BKT 贝叶斯更新 × 半衰期保留（HLR），半衰期按每次答题在线校准
- F 风格向量：双极轴 EMA（f1 直觉↔形式、f2 具象↔抽象），只排呈现配比不设能力上限
设计原则：「可以推断，但必须可见可纠」——每个分量带证据账本，面板可冻结/改值。
状态挂 profile["implicit"]（与显式记忆同一份 JSON、同一套 device 隔离），零出网。

事件采集（v1）：
- 服务端 6 类挂已有数据写入点：ask/节奏（/api/extract_knowledge 主回答路径）、
  confused/socratic/followup（同端点分支守卫）、extract（/api/knowledge 仅新 id）、
  formula（/api/extract_knowledge 公式自动入库）、quiz/socratic_answer
  （/api/kv/phymathia_quiz_stats 写入时新旧差分）
- 前端 3 类（expand/visualize/difficulty）走 POST /api/profile/event
所有函数路径参数化（path 显式传入），本模块不 import profile，避免循环。
"""

import copy
import logging
import math
import re
import time

from .config import DATA_DIR
from .storage import _mutate_json, _read_json, kv_read

logger = logging.getLogger(__name__)

# ---- 参数（模型文档 §9 参数表；改默认值先改文档） ----
TAU_INTEREST_DAYS = 14.0        # 兴趣半衰期（2^(-Δt/τ) 的 τ）
STREAK_WINDOW_S = 2 * 3600      # 自激时窗：超过即清零重数（隔天不算「连问」）
STREAK_GAIN = 0.15              # 自激增益（Hawkes 线性近似）
STREAK_CAP = 2.0                # 自激封顶倍数
P_TRANSIT = 0.1                 # BKT 学习概率 P(T)
P_SLIP = 0.1                    # BKT 失误率 P(S)
P_GUESS = 0.2                   # BKT 猜对率 P(G)（v1 常数；按选项数 1/n 留 v2，见 T174-③）
H0_DAYS = 5.0                   # 初始保留半衰期
H_MIN_DAYS = 1.0
H_MAX_DAYS = 120.0
H_GAIN = 1.0                    # 半衰期校准增益 γ：H ← clip(H·e^{γ(x−p̂)})
ETA_STYLE = 0.05                # 风格 EMA 步长
ETA_RHYTHM = 0.02               # 节奏 EMA 步长
W_CONFUSED = 0.3                # 「没看懂」弱负观测权重（自报信号含噪）
CONFUSED_CAP_S = 24 * 3600      # 没看懂频率上限：同主题 24h 只计一次（T174-①）
MAT_N0 = 20.0                   # 成熟度门控中心（约 20 个事件后过半）
MAT_S = 10.0                    # 成熟度门控尺度
INJECT_MIN_EVENTS = 3           # 事件数下限：更少时噪声太大，不产出注入段
LEDGER_K = 8                    # 证据账本深度（环形，展示用）
PRUNE_W = 0.05                  # 主题剪枝阈值（≈4.9 个半衰期 ≈ 68 天不活跃）
MAX_TOPICS = 400                # 主题表硬上限（防异常输入撑爆状态文件）

QUIZ_KV_KEY = "phymathia_quiz_stats"
KNOWLEDGE_PATH = DATA_DIR / "knowledge.json"

# 事件兴趣权重 α（文档 §1 表）；socratic_answer 是 kv 差分出的「苏格拉底答题」
ALPHA = {
    "ask": 1.0, "socratic": 1.3, "socratic_answer": 1.3, "extract": 1.5,
    "formula": 0.8, "quiz": 0.6, "confused": 0.5, "followup": 0.3,
    "expand": 0.3, "visualize": 0.3, "difficulty": 0.4,
}
# 风格证据（文档 §4 表）：事件 → (轴, 贡献值)。苏格拉底只记答题侧（kv 里有
# questionId='socratic' 的可靠标记），追问侧不再计风格，避免同一轮双计。
STYLE_EVIDENCE = {
    "socratic_answer": ("f1", 0.6),
    "expand": ("f1", -0.4),
    "confused": ("f1", 0.3),
    "visualize": ("f2", -0.5),
}
FROZEN_DIMS = ("interest", "mastery", "style")


def default_implicit() -> dict:
    return {
        "v": 1,
        "topics": {},      # 主题名 → {w, wAt, p, h, hAt, ans, ok, ledger}
        "style": {"f1": 0.0, "f2": 0.0, "ledger": []},
        "rhythm": {"h": [0.0] * 24, "avgLen": 0.0, "at": 0.0},
        "events": 0,
        "streak": {"topic": "", "n": 0, "at": 0.0},
        "confusedAt": {},  # 主题 → 上次「没看懂」时刻（频率上限用）
        "frozen": {"interest": False, "mastery": False, "style": False},
        "seeded": False,   # 一次性回填标记
    }


def _ts(value, default=0.0):
    """秒为标准，兼容前端毫秒时间戳。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(number) or number < 0:
        return default
    if number >= 1e12:
        number /= 1000.0
    return number


def _clamp(value, low, high):
    return max(low, min(high, value))


def decay2(dt_s: float, half_life_days: float) -> float:
    """半衰期衰减因子 2^(-Δt/H)；Δt 为负（时钟偏差）按 0 处理。"""
    return 2.0 ** (-max(dt_s, 0.0) / max(half_life_days * 86400.0, 1e-9))


def maturity(state: dict) -> float:
    """画像成熟度 σ((n−n₀)/s)；n₀=20 前信不过，n₀ 后逐渐全信。"""
    n = float(state.get("events") or 0)
    return 1.0 / (1.0 + math.exp(-(n - MAT_N0) / MAT_S))


def normalize_implicit(raw) -> dict:
    """任意磁盘数据 → 合法状态（逐字段降级，未知字段保留由调用方合并）。"""
    state = default_implicit()
    if not isinstance(raw, dict):
        return state
    topics = raw.get("topics")
    if isinstance(topics, dict):
        for name, t in list(topics.items())[:MAX_TOPICS]:
            if not isinstance(t, dict) or not str(name or "").strip():
                continue
            state["topics"][str(name)[:60]] = {
                "w": max(float(_ts(t.get("w"), 0.0)), 0.0),
                "wAt": _ts(t.get("wAt")),
                "p": _clamp(_ts(t.get("p"), 0.2), 0.0, 1.0),
                "h": _clamp(_ts(t.get("h"), H0_DAYS), H_MIN_DAYS, H_MAX_DAYS),
                "hAt": _ts(t.get("hAt")),
                "ans": max(int(_ts(t.get("ans"), 0.0)), 0),
                "ok": max(int(_ts(t.get("ok"), 0.0)), 0),
                "ledger": _norm_ledger(t.get("ledger")),
            }
    style = raw.get("style")
    if isinstance(style, dict):
        state["style"]["f1"] = _clamp(_ts(style.get("f1"), 0.0), -1.0, 1.0)
        state["style"]["f2"] = _clamp(_ts(style.get("f2"), 0.0), -1.0, 1.0)
        state["style"]["ledger"] = _norm_ledger(style.get("ledger"))
    rhythm = raw.get("rhythm")
    if isinstance(rhythm, dict):
        hours = rhythm.get("h")
        if isinstance(hours, list) and len(hours) == 24:
            state["rhythm"]["h"] = [max(_ts(h, 0.0), 0.0) for h in hours]
        state["rhythm"]["avgLen"] = max(_ts(rhythm.get("avgLen"), 0.0), 0.0)
        state["rhythm"]["at"] = _ts(rhythm.get("at"))
    state["events"] = max(int(_ts(raw.get("events"), 0.0)), 0)
    streak = raw.get("streak")
    if isinstance(streak, dict):
        state["streak"] = {
            "topic": str(streak.get("topic") or "")[:60],
            "n": max(int(_ts(streak.get("n"), 0.0)), 0),
            "at": _ts(streak.get("at")),
        }
    confused_at = raw.get("confusedAt")
    if isinstance(confused_at, dict):
        state["confusedAt"] = {str(k)[:60]: _ts(v) for k, v in list(confused_at.items())[:200]
                               if isinstance(k, str)}
    frozen = raw.get("frozen")
    if isinstance(frozen, dict):
        state["frozen"] = {d: bool(frozen.get(d)) for d in FROZEN_DIMS}
    state["seeded"] = bool(raw.get("seeded"))
    return state


def _norm_ledger(raw) -> list:
    if not isinstance(raw, list):
        return []
    return [{"type": str(e.get("type") or "")[:16], "at": _ts(e.get("at")),
             **{k: v for k, v in e.items() if k in ("w", "x", "p", "axis", "val")}}
            for e in raw if isinstance(e, dict)][-LEDGER_K:]


def _ledger_push(ledger: list, entry: dict) -> list:
    return (list(ledger) + [entry])[-LEDGER_K:]


def _new_topic() -> dict:
    return {"w": 0.0, "wAt": 0.0, "p": 0.2, "h": H0_DAYS, "hAt": 0.0,
            "ans": 0, "ok": 0, "ledger": []}


# ---- 事件应用（纯状态机，便于单测） ----

def _bump_interest(state: dict, topic: str, alpha: float, ts: float):
    t = state["topics"].setdefault(topic, _new_topic())
    # 惰性衰减：把 w 从上次更新时刻衰到当前，再叠加
    t["w"] = t["w"] * decay2(ts - t["wAt"], TAU_INTEREST_DAYS)
    streak = state["streak"]
    if streak.get("topic") == topic and ts - streak.get("at", 0.0) <= STREAK_WINDOW_S:
        streak["n"] = int(streak.get("n") or 0) + 1
    else:
        streak["topic"], streak["n"] = topic, 1
    streak["at"] = ts
    alpha *= min(1.0 + STREAK_GAIN * (streak["n"] - 1), STREAK_CAP)
    t["w"] = min(t["w"] + alpha, 1e6)
    t["wAt"] = ts
    t["ledger"] = _ledger_push(t["ledger"], {"type": "interest", "at": ts, "w": round(alpha, 3)})


def _bkt_posterior(p: float, x: int) -> float:
    """观测步：P(L=1 | x) 的贝叶斯后验。"""
    if x:
        num = p * (1.0 - P_SLIP)
        den = num + (1.0 - p) * P_GUESS
    else:
        num = p * P_SLIP
        den = num + (1.0 - p) * (1.0 - P_GUESS)
    return num / den if den > 0 else p


def _apply_answer(state: dict, topic: str, x: int, ts: float):
    """真实答题：半衰期校准（用旧 p 与预测 p̂）→ BKT 观测步 + 学习步。"""
    t = state["topics"].setdefault(topic, _new_topic())
    p_hat = t["p"] * decay2(ts - t["hAt"], t["h"]) if t["hAt"] > 0 else t["p"]
    t["h"] = _clamp(t["h"] * math.exp(H_GAIN * (x - p_hat)), H_MIN_DAYS, H_MAX_DAYS)
    tilde = _bkt_posterior(t["p"], x)
    t["p"] = tilde + (1.0 - tilde) * P_TRANSIT
    t["hAt"] = ts
    t["ans"] += 1
    t["ok"] += x
    t["ledger"] = _ledger_push(t["ledger"], {"type": "answer", "at": ts, "x": x,
                                             "p": round(t["p"], 3)})


def _apply_confused(state: dict, topic: str, ts: float):
    """「没看懂」弱负观测：向 x=0 后验插值，不做学习步、不动半衰期（文档 §3.1）。"""
    t = state["topics"].setdefault(topic, _new_topic())
    tilde0 = _bkt_posterior(t["p"], 0)
    t["p"] = _clamp(t["p"] + W_CONFUSED * (tilde0 - t["p"]), 0.0, 1.0)
    t["ledger"] = _ledger_push(t["ledger"], {"type": "confused", "at": ts,
                                             "p": round(t["p"], 3)})


def _bump_rhythm(state: dict, ts: float, length):
    rhythm = state["rhythm"]
    hour = time.localtime(ts).tm_hour if ts > 0 else time.localtime().tm_hour
    hours = rhythm["h"]
    rhythm["h"] = [(1.0 - ETA_RHYTHM) * v + ETA_RHYTHM * (1.0 if k == hour else 0.0)
                   for k, v in enumerate(hours)]
    try:
        length = max(float(length or 0), 0.0)
    except (TypeError, ValueError):
        length = 0.0
    rhythm["avgLen"] = (1.0 - ETA_RHYTHM) * rhythm["avgLen"] + ETA_RHYTHM * length
    rhythm["at"] = ts


def apply_events(state: dict, events: list, now: float) -> bool:
    """把事件流应用进状态（原地修改）；返回是否有变化。"""
    changed = False
    for ev in events:
        if not isinstance(ev, dict):
            continue
        etype = str(ev.get("type") or "").strip()
        if etype not in ALPHA:
            continue
        state["events"] = int(state.get("events") or 0) + 1
        changed = True
        ts = _ts(ev.get("ts"), now) if ev.get("ts") is not None else now
        topic = str(ev.get("topic") or "").strip()[:60]
        frozen = state.get("frozen") or {}
        # 兴趣
        if topic and not frozen.get("interest"):
            _bump_interest(state, topic, ALPHA[etype], ts)
        # 能力：真实答题
        if etype in ("quiz", "socratic_answer") and topic and not frozen.get("mastery"):
            _apply_answer(state, topic, 1 if ev.get("correct") else 0, ts)
        # 能力：没看懂弱负观测（同主题 24h 频率上限，防连点刷分）
        if etype == "confused" and topic and not frozen.get("mastery"):
            if ts - _ts(state["confusedAt"].get(topic)) >= CONFUSED_CAP_S:
                state["confusedAt"][topic] = ts
                _apply_confused(state, topic, ts)
        # 风格
        evidence = STYLE_EVIDENCE.get(etype)
        if evidence and not frozen.get("style"):
            axis, val = evidence
            style = state["style"]
            style[axis] = _clamp((1.0 - ETA_STYLE) * style[axis] + ETA_STYLE * val, -1.0, 1.0)
            style["ledger"] = _ledger_push(style["ledger"], {
                "type": etype, "at": ts, "axis": axis, "val": val})
        # 节奏：只挂主回答
        if etype == "ask":
            _bump_rhythm(state, ts, ev.get("len"))
    return changed


def prune_topics(state: dict, now: float):
    """保存时剪枝：长期无活跃且无答题史的主题剔除（文档 §6；任一冻结则不剪）。"""
    if any((state.get("frozen") or {}).values()):
        return
    for name in list(state["topics"].keys()):
        t = state["topics"][name]
        w_now = t.get("w", 0.0) * decay2(now - t.get("wAt", 0.0), TAU_INTEREST_DAYS)
        has_user_edit = any(e.get("type") == "user" for e in (t.get("ledger") or []))
        if w_now < PRUNE_W and not t.get("ans") and not has_user_edit:
            del state["topics"][name]
    cutoff = now - 7 * 86400
    state["confusedAt"] = {k: v for k, v in (state.get("confusedAt") or {}).items() if v > cutoff}


# ---- 持久化入口（profile.py 包装后对外） ----

def record_events(path, events: list, now: float = None) -> bool:
    if not isinstance(events, list) or not events:
        return False
    now = now or time.time()
    applied = []

    def updater(raw):
        profile = raw if isinstance(raw, dict) else {}
        if profile.get("enabled") is False:
            return None
        state = normalize_implicit(profile.get("implicit"))
        if not apply_events(state, events, now):
            return None
        prune_topics(state, now)
        applied.append(True)
        profile = dict(profile)
        profile["implicit"] = state
        profile["updatedAt"] = now
        return profile

    # 注意 _mutate_json 在 updater 返回 None 时返回原数据（非 None）——
    # 「是否真的写了」必须用 applied 旗标表达，不能用返回值判空
    _mutate_json(path, updater)
    return bool(applied)


def ensure_seeded(path) -> bool:
    """一次性回填（文档 §6 冷启动）：knowledge.json → W、历史测验 → M 全量回放。

    幂等：seeded 标记已置位时零写入（updater 返回 None）。返回是否发生了回填。
    """
    applied = []

    def updater(raw):
        profile = raw if isinstance(raw, dict) else {}
        if profile.get("enabled") is False:
            return None
        state = profile.get("implicit")
        if isinstance(state, dict) and state.get("seeded"):
            return None
        state = normalize_implicit(state)
        now = time.time()
        # W ← 知识库（主题=topic||concept，按 createdAt 衰减）
        kb = _read_json(KNOWLEDGE_PATH, {})
        if isinstance(kb, dict):
            for item in kb.values():
                if not isinstance(item, dict):
                    continue
                name = str(item.get("topic") or item.get("concept") or "").strip()[:60]
                if not name:
                    continue
                created = _ts(item.get("createdAt"))
                alpha = 1.5 * decay2(now - created, TAU_INTEREST_DAYS) if created else 0.3
                t = state["topics"].setdefault(name, _new_topic())
                t["w"] += alpha
                if not t["wAt"]:
                    t["wAt"] = now
                state["events"] += 1
        # M ← 历史测验/苏格拉底作答逐条回放（kv 全局键）
        try:
            stats = kv_read(QUIZ_KV_KEY)
        except Exception as e:  # pragma: no cover - kv 异常不阻断回填
            logger.warning(f"Implicit seed kv_read failed: {e}")
            stats = None
        if isinstance(stats, dict):
            replay = []
            for key, item in stats.items():
                if key == "_meta" or not isinstance(item, dict):
                    continue
                topic = str(item.get("title") or key)[:60]
                for h in (item.get("history") or []):
                    if isinstance(h, dict):
                        replay.append({
                            "type": "socratic_answer" if str(h.get("questionId") or "") == "socratic" else "quiz",
                            "topic": topic, "correct": bool(h.get("correct")),
                            "ts": _ts(h.get("at"), now) or now,
                        })
            apply_events(state, replay, now)
        state["seeded"] = True
        applied.append(True)
        profile = dict(profile)
        profile["implicit"] = state
        profile["updatedAt"] = now
        return profile

    _mutate_json(path, updater)
    return bool(applied)


def manage_implicit(path, action: str, dim: str = "", key: str = "", value=None) -> dict:
    """面板原子操作：freeze / unfreeze / set / reset（用户主动管理不受 enabled 限制）。"""
    if action not in ("freeze", "unfreeze", "set", "reset"):
        raise ValueError(f"unknown implicit action: {action!r}")
    if action in ("freeze", "unfreeze", "set") and dim not in FROZEN_DIMS:
        raise ValueError(f"unknown implicit dim: {dim!r}")

    def updater(raw):
        profile = raw if isinstance(raw, dict) else {"enabled": True}
        state = normalize_implicit(profile.get("implicit"))
        now = time.time()
        if action == "reset":
            state = default_implicit()
            state["seeded"] = True  # 防 ensure_seeded 立即回填复活
        elif action in ("freeze", "unfreeze"):
            state["frozen"][dim] = (action == "freeze")
            state["style"]["ledger"] = _ledger_push(state["style"]["ledger"], {
                "type": "user", "at": now, "axis": dim, "val": action})
        elif action == "set":
            number = _ts(value, None)
            if number is None:
                raise ValueError("value must be a number")
            if dim == "style":
                axis = key if key in ("f1", "f2") else ""
                if not axis:
                    raise ValueError("style set needs key f1|f2")
                state["style"][axis] = _clamp(number, -1.0, 1.0)
                state["style"]["ledger"] = _ledger_push(state["style"]["ledger"], {
                    "type": "user", "at": now, "axis": axis, "val": state["style"][axis]})
            elif dim == "mastery":
                topic = str(key or "").strip()[:60]
                if not topic or topic not in state["topics"]:
                    raise ValueError("mastery set needs an existing topic")
                t = state["topics"][topic]
                t["p"] = _clamp(number, 0.0, 1.0)
                t["ledger"] = _ledger_push(t["ledger"], {"type": "user", "at": now,
                                                         "p": round(t["p"], 3)})
            else:  # interest
                topic = str(key or "").strip()[:60]
                if not topic:
                    raise ValueError("interest set needs a topic")
                t = state["topics"].setdefault(topic, _new_topic())
                t["w"] = max(number, 0.0)
                t["wAt"] = now
                t["ledger"] = _ledger_push(t["ledger"], {"type": "user", "at": now,
                                                         "w": round(t["w"], 3)})
        profile = dict(profile)
        profile["implicit"] = state
        profile["updatedAt"] = now
        return profile

    return _mutate_json(path, updater) or {}


# ---- 消费端 ----

def topic_vocab() -> list:
    """归题词表：知识库的 topic/concept 全集（_read_json 有缓存，代价可控）。"""
    data = _read_json(KNOWLEDGE_PATH, {})
    terms = []
    if isinstance(data, dict):
        for item in data.values():
            if not isinstance(item, dict):
                continue
            for key in ("topic", "concept"):
                value = str(item.get(key) or "").strip()
                if len(value) >= 2 and value not in terms:
                    terms.append(value)
    return terms


def assign_topic(text, vocab: list = None) -> str:
    """v1 归题：词表最长包含匹配；空文本/无命中返回空串（事件仍计入成熟度与节奏）。"""
    text = str(text or "")
    if not text.strip():
        return ""
    for term in (vocab if vocab is not None else topic_vocab()):
        if term in text and len(term) > 0:
            return term[:60]
    return ""


def quiz_stats_events(old_stats, new_stats) -> list:
    """KV 写入差分：新旧两份测验统计对比，产出逐次作答事件（纯函数）。

    统计形态见 quiz-stats.js：{topicKey: {correct, wrong, history: [{correct, at,
    questionId, difficulty}], title, ...}, _meta}。questionId='socratic' 即苏格拉底答题。
    history 只留最近 20 条：差分条数超过它时按可得历史回放（近似，可接受）。
    """
    events = []
    old = old_stats if isinstance(old_stats, dict) else {}
    new = new_stats if isinstance(new_stats, dict) else {}
    for key, item in new.items():
        if key == "_meta" or not isinstance(item, dict):
            continue
        total_new = int(_ts(item.get("correct"), 0.0) + _ts(item.get("wrong"), 0.0))
        prev = old.get(key)
        total_old = 0
        if isinstance(prev, dict):
            total_old = int(_ts(prev.get("correct"), 0.0) + _ts(prev.get("wrong"), 0.0))
        delta = total_new - total_old
        if delta <= 0:
            continue
        history = [h for h in (item.get("history") or []) if isinstance(h, dict)]
        fresh = history[-delta:]
        for h in fresh:
            events.append({
                "type": "socratic_answer" if str(h.get("questionId") or "") == "socratic" else "quiz",
                "topic": str(item.get("title") or key)[:60],
                "correct": bool(h.get("correct")),
                "ts": _ts(h.get("at")) or None,
            })
    return events


def _explicit_interest_text(profile: dict) -> str:
    exp = profile.get("explicit") if isinstance(profile.get("explicit"), dict) else {}
    parts = [str(exp.get(k) or "") for k in ("interests", "weakAreas", "goal")]
    for f in profile.get("facts") or []:
        if isinstance(f, dict) and f.get("category") in ("interest", "weakness", "goal") \
                and f.get("status", "active") == "active":
            parts.append(str(f.get("fact") or ""))
    return re.sub(r"\s+", "", "；".join(parts))


def _knowledge_domains() -> dict:
    """知识库领域归类：topic/concept 词 → category 集合（§8.2 相邻关系 v1 数据源）。"""
    mapping = {}
    data = _read_json(KNOWLEDGE_PATH, {})
    if isinstance(data, dict):
        for item in data.values():
            if not isinstance(item, dict):
                continue
            term = str(item.get("topic") or item.get("concept") or "").strip()
            cat = str(item.get("category") or "").strip()
            if term and cat:
                mapping.setdefault(term, set()).add(cat)
    return mapping


def _stretch_picks(rows, picked_names: list, explicit_norm: str, limit: int = 2) -> list:
    """§8.2 拉伸分布 v1：三成探索位从「低活跃但相邻/同领域」的已归题主题里点名 1-2 个。

    相邻 = 知识库 category 同域归类（与举例主侧任一主题同域者优先）；
    归类拿不到（知识库无归类/无同域候选）退化为候选中 W 最小者——
    排序键 (同域优先, W 升序) 一条式覆盖两条路。偏差说明见数学文档 §8.2 落地注记。
    """
    picked_set = set(picked_names)
    cands = []
    for name, w, _t in rows:
        if name in picked_set:
            continue
        norm = re.sub(r"\s+", "", name)
        if norm and norm in explicit_norm:  # 显式兴趣里的主题不占探索位（§8.1 同款去重）
            continue
        cands.append((name, w))
    if not cands:
        return []
    domains = _knowledge_domains()
    mine = set()
    for name in picked_names:
        mine |= domains.get(name, set())

    def _order(entry):
        name, w = entry
        same = bool(mine) and bool(mine & domains.get(name, set()))
        return (0 if same else 1, w)

    cands.sort(key=_order)
    return [name for name, _w in cands[:limit]]


def compile_user_model(state, profile: dict, max_chars: int = 700) -> list:
    """把隐式状态编译成【画像】注入段条目（文档 §8.1 回答偏向＋§8.2 举例偏向）。数据不足返回 []。

    预算裁剪由调用方（profile_context 的逐条回退循环）兜底；本函数自限 max_chars。
    """
    state = state if isinstance(state, dict) else {}
    if int(state.get("events") or 0) < INJECT_MIN_EVENTS:
        return []
    now = time.time()
    frozen = state.get("frozen") or {}
    explicit_norm = _explicit_interest_text(profile)
    rows = []
    for name, t in (state.get("topics") or {}).items():
        if not isinstance(t, dict) or t.get("w", 0.0) <= 0:
            continue
        w_now = t["w"] * decay2(now - t.get("wAt", 0.0), TAU_INTEREST_DAYS)
        if w_now > 0:
            rows.append((name, w_now, t))
    rows.sort(key=lambda r: -r[1])
    total = sum(w for _, w, _ in rows)

    items = []
    if total > 0 and not frozen.get("interest"):
        picked = []
        for name, _w, _t in rows:
            if len(picked) >= 3:
                break
            # §8.1 去重：显式兴趣/薄弱/目标里已有的主题不重复占预算
            if re.sub(r"\s+", "", name) and re.sub(r"\s+", "", name) in explicit_norm:
                continue
            picked.append(name)
        if picked:
            # §8.2 举例偏向：q = 0.7·π + 0.3·ν（β 见 §9 参数表）——七成顺兴趣 top
            # 主题，三成往低活跃相邻主题带一步；v1 不做逐例采样，以措辞指令表达配比
            line = "举例：七成用 " + "/".join(picked)
            stretch = _stretch_picks(rows, picked, explicit_norm)
            if stretch:
                line += "，三成带一步 " + "/".join(stretch)
            items.append(line)
    if not frozen.get("mastery"):
        depth = []
        for name, _w, t in rows:
            if t.get("ans", 0) <= 0:
                continue
            m_hat = t["p"] * decay2(now - t.get("hAt", 0.0), t["h"])
            depth.append(f"{name[:16]}掌握≈{m_hat:.2f}→讲解约{1 + 4 * m_hat:.1f}档")
            if len(depth) >= 3:
                break
        if depth:
            items.append("深度：" + "；".join(depth))
    if not frozen.get("style"):
        style = state.get("style") or {}
        f1, f2 = style.get("f1", 0.0), style.get("f2", 0.0)
        if abs(f1) >= 0.1:
            r = (f1 + 1.0) / 2.0
            tend = "直觉类比" if f1 > 0 else "形式推导"
            items.append(f"风格：偏{tend}（直觉:形式≈{int(r * 100)}:{100 - int(r * 100)}，先讲偏好端）")
        if abs(f2) >= 0.15:
            items.append("风格：偏具象例子" if f2 < 0 else "风格：偏抽象概括")
    if not items:
        return []
    items.append(f"（以上为行为统计推断，成熟度 {int(maturity(state) * 100)}%；"
                 f"与用户明示冲突时以用户为准）")
    while len("".join(items)) > max_chars and len(items) > 2:
        items.pop(1)
    return items


def dashboard_view(state) -> dict:
    """给画像仪表盘的派生视图：衰减到当前的 W/π、保留调整后的 m̂、成熟度。"""
    state = state if isinstance(state, dict) else {}
    now = time.time()
    rows = []
    for name, t in (state.get("topics") or {}).items():
        if not isinstance(t, dict):
            continue
        w_now = t.get("w", 0.0) * decay2(now - t.get("wAt", 0.0), TAU_INTEREST_DAYS)
        m_hat = t.get("p", 0.2) * decay2(now - t.get("hAt", 0.0), t.get("h", H0_DAYS)) \
            if t.get("hAt", 0.0) > 0 else t.get("p", 0.2)
        rows.append({"topic": name, "w": round(w_now, 4), "p": round(t.get("p", 0.2), 3),
                     "m": round(m_hat, 3), "h": round(t.get("h", H0_DAYS), 1),
                     "ans": t.get("ans", 0), "ok": t.get("ok", 0),
                     "ledger": (t.get("ledger") or [])[-LEDGER_K:]})
    total = sum(r["w"] for r in rows)
    rows.sort(key=lambda r: -r["w"])
    for r in rows:
        r["share"] = round(r["w"] / total, 4) if total > 0 else 0.0
    style = state.get("style") or {}
    return {
        "maturity": round(maturity(state), 3),
        "events": int(state.get("events") or 0),
        "topics": rows[:20],
        "style": {"f1": round(style.get("f1", 0.0), 3), "f2": round(style.get("f2", 0.0), 3),
                  "ledger": (style.get("ledger") or [])[-LEDGER_K:]},
        "rhythm": state.get("rhythm") or {},
        "frozen": state.get("frozen") or {},
        "seeded": bool(state.get("seeded")),
    }


__all__ = [
    "QUIZ_KV_KEY", "default_implicit", "normalize_implicit", "decay2", "maturity",
    "apply_events", "record_events", "ensure_seeded", "manage_implicit",
    "topic_vocab", "assign_topic", "quiz_stats_events", "compile_user_model",
    "dashboard_view", "prune_topics",
]
