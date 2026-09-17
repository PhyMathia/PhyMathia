"""用户画像（记忆）存储：设备级隔离，JSON 文件持久化。

隐私设计：
- 画像按匿名设备 ID 隔离（前端 localStorage 生成），存 data/profiles/{device_id}.json
- enabled=False 时：不注入、不写入（apply_profile_ops / add_fact_candidates 直接忽略），已存数据保留
- 开关与清除由前端驱动，本模块只负责存取与规则

采集（v2 合并式，2026-09-17）：
- 提取模型看到既有画像摘要，输出 profile_ops：new / confirm / update / remove
- new 中 stage/goal 属用户一句即可确信的高精度事实，直接入 facts；其余进 pending
- pending 被再次 confirm（或规范化文本撞上重复）达 2 次固化进 facts——
  旧版靠「同一句原文出现两次」，但 fact 是模型自由文本，逐字节相等几乎不可能，实测三份真机画像 0 固化
- update 原地更替并留 history（矛盾以新为准）；remove 删除并落 archive（面板可查看/恢复）

生命周期：
- 注入时记录 lastUsedAt；超过 IDLE_DAYS 未被注入的事实转入 idle（休眠），不再注入
- 面板可一键恢复（status 回 active，lastUsedAt 刷新）
"""

import copy
import hashlib
import logging
import re
import time
import uuid
from pathlib import Path

from .config import DATA_DIR
from .storage import _invalidate_json_cache, _mutate_json, _read_json, _write_json

logger = logging.getLogger(__name__)

PROFILES_DIR = DATA_DIR / "profiles"
PROFILES_DIR.mkdir(parents=True, exist_ok=True)

PROFILE_VERSION = 2
MAX_FACTS = 50
MAX_PENDING = 30
MAX_ARCHIVE = 10
MAX_FACT_HISTORY = 3
IDLE_DAYS = 30
IDLE_SECONDS = IDLE_DAYS * 86400

# 注入预算：旧版 1200 字把事实掐到前几条；契约化段落后放宽，仍防挤占正文
INJECTION_MAX_CHARS = 1600
MAX_INJECT_FACTS = 12

DEFAULT_EXPLICIT = {
    "stage": "",      # 学段/年级
    "goal": "",       # 学习目标
    "interests": "",  # 兴趣方向
    "weakAreas": "",  # 薄弱章节
    "style": {"detail": "标准", "jargon": "标准", "visuals": "否"},
}

# 回答偏好三轴允许值
STYLE_VALUES = {
    "detail": ("简洁", "标准", "详细"),
    "jargon": ("通俗", "标准", "专业"),
    "visuals": ("否", "公式", "公式+可视化"),
}

FACT_CATEGORIES = ("stage", "goal", "interest", "weakness", "style", "other")
# 用户明确陈述一次即可确信的类别（「我是高二学生」不存在误读，要求说两遍是过度谨慎）
DIRECT_SOLID_CATEGORIES = ("stage", "goal")
PROFILE_OPS = ("new", "confirm", "update", "remove")


def _default_profile() -> dict:
    return {
        "version": PROFILE_VERSION,
        "enabled": True,
        "explicit": copy.deepcopy(DEFAULT_EXPLICIT),
        "facts": [],
        "pending": [],
        "archive": [],
        "createdAt": time.time(),
        "updatedAt": time.time(),
    }


def _profile_path(device_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "", str(device_id or ""))
    if not safe:
        safe = "default"
    elif len(safe) > 64:
        # 超长 id 不能折叠到 default：多个设备会互相串画像。
        # 保留可读前缀 + 全 id 短哈希（48+1+12=61 ≤ 64，稳定且互不碰撞）
        digest = hashlib.sha1(str(device_id).encode("utf-8")).hexdigest()[:12]
        safe = safe[:48] + "-" + digest
    return PROFILES_DIR / f"{safe}.json"


def _normalize_fact_item(item: dict) -> dict:
    """补齐单条事实的字段（旧数据无 status/history/lastUsedAt 等也能读）。"""
    return {
        "id": str(item.get("id") or ("pf_" + uuid.uuid4().hex[:12])),
        "fact": str(item.get("fact") or "").strip(),
        "category": item.get("category") if item.get("category") in FACT_CATEGORIES else "other",
        "sourceSession": str(item.get("sourceSession") or "")[:64],
        "source": str(item.get("source") or "")[:32],
        "occurrences": int(item.get("occurrences", 1) or 1),
        "status": "idle" if item.get("status") == "idle" else "active",
        "history": [h for h in (item.get("history") or []) if isinstance(h, dict)][:MAX_FACT_HISTORY],
        "createdAt": float(item.get("createdAt") or time.time()),
        "updatedAt": float(item.get("updatedAt") or time.time()),
        "lastUsedAt": float(item.get("lastUsedAt") or 0),
    }


def _normalize_profile(data) -> dict:
    """把任意磁盘数据归一化为完整画像结构（缺失/损坏字段回退默认值）。"""
    if not isinstance(data, dict):
        return _default_profile()
    base = _default_profile()
    for key in ("version", "createdAt", "updatedAt"):
        if key in data:
            base[key] = data[key]
    base["enabled"] = bool(data.get("enabled", True))
    if isinstance(data.get("explicit"), dict):
        exp = data["explicit"]
        for key in ("stage", "goal", "interests", "weakAreas"):
            if isinstance(exp.get(key), str):
                base["explicit"][key] = exp[key]
        if isinstance(exp.get("style"), dict):
            for key, allowed in STYLE_VALUES.items():
                if exp["style"].get(key) in allowed:
                    base["explicit"]["style"][key] = exp["style"][key]
    for key, limit in (("facts", MAX_FACTS), ("pending", MAX_PENDING), ("archive", MAX_ARCHIVE)):
        if isinstance(data.get(key), list):
            base[key] = [_normalize_fact_item(it) for it in data[key] if isinstance(it, dict)][-limit:]
    return base


def get_profile(device_id: str) -> dict:
    """读取画像；不存在或损坏时返回默认画像。"""
    return _normalize_profile(_read_json(_profile_path(device_id), None))


def save_profile(device_id: str, profile: dict) -> dict:
    profile["updatedAt"] = time.time()
    _write_json(_profile_path(device_id), profile)
    return profile


def update_profile(device_id: str, updates: dict) -> dict:
    """合并更新：支持 explicit / enabled / facts / pending / archive 局部更新。

    读-改-写全程在 _mutate_json 锁内，并发更新不再互相覆盖。
    """
    if not isinstance(updates, dict):
        return get_profile(device_id)

    def updater(raw):
        profile = _normalize_profile(raw)
        if "enabled" in updates:
            profile["enabled"] = bool(updates["enabled"])
        if isinstance(updates.get("explicit"), dict):
            exp = updates["explicit"]
            for key in ("stage", "goal", "interests", "weakAreas"):
                if isinstance(exp.get(key), str):
                    profile["explicit"][key] = exp[key][:200]
            if isinstance(exp.get("style"), dict):
                for key, allowed in STYLE_VALUES.items():
                    if exp["style"].get(key) in allowed:
                        profile["explicit"]["style"][key] = exp["style"][key]
        for key, limit in (("facts", MAX_FACTS), ("pending", MAX_PENDING), ("archive", MAX_ARCHIVE)):
            if isinstance(updates.get(key), list):
                profile[key] = [_normalize_fact_item(it) for it in updates[key] if isinstance(it, dict)][-limit:]
        profile["updatedAt"] = time.time()
        return profile

    return _mutate_json(_profile_path(device_id), updater)


def delete_profile(device_id: str) -> bool:
    """删除设备画像文件，返回是否存在。"""
    path = _profile_path(device_id)
    existed = path.exists()
    if existed:
        path.unlink(missing_ok=True)
        _invalidate_json_cache(path)
    return existed


def _norm_fact(text: str) -> str:
    """规范化事实文本用于查重：去称谓前缀/标点/空白，忽略大小写。

    旧版逐字节比对是固化率归零的主因之一；模型对同一陈述的复述
    （「我是高二学生」vs「用户是高二学生」）在此归一为同一键。
    """
    t = str(text or "").strip().lower()
    t = re.sub(r"^(用户|我)+(是|的)?", "", t)
    t = re.sub(r"(的|了)$", "", t)
    t = re.sub(r"[\s，。；、：:()（）\[\]【】\"'“”‘’，.!?！？]+", "", t)
    return t


def _sanitize_op(op) -> dict:
    """容错清洗单条 profile_op；不合法返回空 dict。"""
    if not isinstance(op, dict):
        return {}
    kind = str(op.get("op") or "new").strip().lower()
    if kind not in PROFILE_OPS:
        kind = "new"
    fact = str(op.get("fact") or "").strip()
    if kind in ("new", "update") and (not fact or len(fact) > 120):
        return {}
    category = str(op.get("category") or "other").strip()
    if category not in FACT_CATEGORIES:
        category = "other"
    return {
        "op": kind,
        "id": str(op.get("id") or "")[:32],
        "fact": fact,
        "category": category,
        "sourceSession": str(op.get("sourceSession") or "")[:64],
        "source": str(op.get("source") or "")[:32],
    }


def apply_profile_ops(device_id: str, ops: list, source: str = "") -> dict:
    """合并式采集入口：按 op 类型合并进画像，返回 {"changed", "promoted"}。

    - new：规范化查重后撞上已有事实按 confirm 处理；stage/goal 直接入 facts，其余进 pending
    - confirm：命中 facts 计数+1；命中 pending 计数达 2 固化（promoted 返回固化文本）
    - update：原地更替文本，旧文留 history；更替后文本撞上其他事实则合并为一次 confirm
    - remove：从 facts/pending 删除，落 archive（面板可查看/恢复）
    开关关闭时直接忽略（不写入）。
    """
    result = {"changed": 0, "promoted": []}
    if not isinstance(ops, list) or not ops:
        return result

    def updater(raw):
        profile = _normalize_profile(raw)
        if not profile.get("enabled", True):
            return None
        changed = 0
        now = time.time()
        facts = profile["facts"]
        pending = profile["pending"]

        def _confirm_item(item, op):
            """既有事实/候选计数+1；候选达 2 次固化（返回是否固化）。"""
            item["occurrences"] += 1
            item["updatedAt"] = now
            if op["sourceSession"]:
                item["sourceSession"] = op["sourceSession"]
            if item in pending and item["occurrences"] >= 2:
                pending.remove(item)
                facts.append(_normalize_fact_item({**item, "status": "active"}))
                result["promoted"].append(item["fact"])
                return True
            return False

        def _archive_item(item, reason):
            if item in facts:
                facts.remove(item)
                profile["archive"].append({
                    "id": item["id"], "fact": item["fact"], "category": item["category"],
                    "removedAt": now, "source": reason,
                })
                profile["archive"] = profile["archive"][-MAX_ARCHIVE:]
            elif item in pending:
                pending.remove(item)

        def _new_fact(op):
            """落地新事实：规范化查重撞上已有按 confirm；stage/goal 一次直接固化。"""
            norm = _norm_fact(op["fact"])
            if not norm:
                return False
            hit = next((f for f in facts if _norm_fact(f["fact"]) == norm), None)
            if hit:
                return _confirm_item(hit, op)
            pend_hit = next((p for p in pending if _norm_fact(p["fact"]) == norm), None)
            if pend_hit:
                return _confirm_item(pend_hit, op)
            item = _normalize_fact_item({
                "id": "pf_" + uuid.uuid4().hex[:12],
                "fact": op["fact"],
                "category": op["category"],
                "sourceSession": op["sourceSession"],
                "source": op["source"] or source,
                "occurrences": 1,
                "createdAt": now,
                "updatedAt": now,
            })
            if op["category"] in DIRECT_SOLID_CATEGORIES:
                facts.append(item)
                result["promoted"].append(op["fact"])
            else:
                pending.append(item)
            return True

        for raw_op in ops:
            op = _sanitize_op(raw_op)
            if not op:
                continue
            kind = op["op"]

            if kind == "remove":
                hit = next((f for f in facts if f["id"] == op["id"]), None) \
                    or next((p for p in pending if p["id"] == op["id"]), None)
                if hit:
                    _archive_item(hit, op["source"] or "user")
                    changed += 1
                continue

            if kind == "confirm":
                hit = next((f for f in facts if f["id"] == op["id"]), None) \
                    or next((p for p in pending if p["id"] == op["id"]), None)
                if hit:
                    _confirm_item(hit, op)
                    changed += 1
                continue

            if kind == "update":
                target = next((f for f in facts if f["id"] == op["id"]), None) \
                    or next((p for p in pending if p["id"] == op["id"]), None)
                if not target:
                    # 目标不存在：更正信息按新事实落地（内部查重兜底）
                    if _new_fact(op):
                        changed += 1
                    continue
                norm = _norm_fact(op["fact"])
                if norm and norm != _norm_fact(target["fact"]):
                    twin = next((f for f in facts if f is not target and _norm_fact(f["fact"]) == norm), None) \
                        or next((p for p in pending if p is not target and _norm_fact(p["fact"]) == norm), None)
                    if twin:
                        # 更正成了已知事实：旧条目退役，既有条目计数+1（矛盾更替）
                        _archive_item(target, "superseded")
                        _confirm_item(twin, op)
                        changed += 1
                        continue
                old_text = target["fact"]
                target["fact"] = op["fact"]
                target["category"] = op["category"]
                target["updatedAt"] = now
                if op["sourceSession"]:
                    target["sourceSession"] = op["sourceSession"]
                target.setdefault("history", []).append({"fact": old_text, "at": now})
                target["history"] = target["history"][-MAX_FACT_HISTORY:]
                changed += 1
                continue

            # new
            if _new_fact(op):
                changed += 1

        result["changed"] = changed
        if not changed:
            return None
        profile["pending"] = profile["pending"][-MAX_PENDING:]
        profile["facts"] = profile["facts"][-MAX_FACTS:]
        profile["updatedAt"] = time.time()
        return profile

    _mutate_json(_profile_path(device_id), updater)
    return result


def add_fact_candidates(device_id: str, candidates: list) -> int:
    """旧入口兼容：候选数组（无 op 字段）按 new 语义合并。返回处理条数。"""
    if not isinstance(candidates, list):
        return 0
    return apply_profile_ops(device_id, candidates, source="legacy")["changed"]


def mark_profile_used(device_id: str, fact_ids: list) -> None:
    """注入回写：命中事实刷新 lastUsedAt；长期未命中的事实转入 idle 休眠。

    只在注入路径调用（每轮主回答一次）；休眠事实不参与后续注入，
    面板「休眠」区可一键恢复。写失败静默——回写失败不该影响回答。
    """
    fact_ids = fact_ids or []

    def updater(raw):
        profile = _normalize_profile(raw)
        if not profile.get("enabled", True):
            return None
        now = time.time()
        changed = False
        hit_ids = set(str(i) for i in fact_ids)
        for f in profile["facts"]:
            if f["id"] in hit_ids:
                if f["status"] != "active" or f["lastUsedAt"] != now:
                    f["status"] = "active"
                    f["lastUsedAt"] = now
                    changed = True
            elif f["status"] == "active":
                ref = f["lastUsedAt"] or f["createdAt"]
                if ref and now - ref > IDLE_SECONDS:
                    f["status"] = "idle"
                    changed = True
        if not changed:
            return None
        profile["updatedAt"] = now
        return profile

    try:
        _mutate_json(_profile_path(device_id), updater)
    except Exception as e:  # pragma: no cover - 存储异常不阻断回答
        logger.warning(f"Profile mark_used failed: {e}")


def _profile_section_texts(profile: dict) -> tuple:
    """把画像组装为「【类别】内容」段落列表（契约化注入的正文）。

    返回 (sections, fact_ids)：fact_ids 是实际被组进段落的活跃事实 id，
    供注入后回写 lastUsedAt。休眠（idle）事实不参与。
    """
    exp = profile["explicit"]
    facts = [f for f in profile["facts"] if f.get("status", "active") == "active" and str(f.get("fact") or "").strip()]
    facts.sort(key=lambda f: (-int(f.get("occurrences", 1)), -float(f.get("updatedAt") or 0)))
    facts = facts[:MAX_INJECT_FACTS]

    sections = []
    for key, label, category in (
        ("stage", "【学段】", "stage"),
        ("goal", "【目标】", "goal"),
        ("weakAreas", "【薄弱】", "weakness"),
        ("interests", "【兴趣】", "interest"),
    ):
        texts = []
        if exp.get(key):
            texts.append(exp[key])
        texts.extend(str(f["fact"]) for f in facts if f["category"] == category)
        seen = set()
        uniq = []
        for t in texts:
            k = _norm_fact(t)
            if k and k not in seen:
                seen.add(k)
                uniq.append(t[:60])
        if uniq:
            sections.append(label + "；".join(uniq[:5]))
    style = exp.get("style") or {}
    style_parts = []
    if style.get("detail") and style["detail"] != "标准":
        style_parts.append(f"详略={style['detail']}")
    if style.get("jargon") and style["jargon"] != "标准":
        style_parts.append(f"术语={style['jargon']}")
    if style.get("visuals") and style["visuals"] != "否":
        style_parts.append(f"可视化={style['visuals']}")
    # style 类别的自动事实与显式偏好同段注入：否则该类事实永不进段落，
    # 却仍计入 factIds 被 lastUsedAt 刷新，成为不休眠也永不出场的死数据
    style_seen = set()
    for f in facts:
        if f["category"] != "style":
            continue
        t = str(f["fact"])[:60]
        k = _norm_fact(t)
        if k and k not in style_seen:
            style_seen.add(k)
            style_parts.append(t)
    if style_parts:
        sections.append("【偏好】" + "；".join(style_parts))
    other = [str(f["fact"]) for f in facts if f["category"] == "other"]
    if other:
        sections.append("【其他】" + "；".join(t[:60] for t in other[:5]))
    return sections, [f["id"] for f in facts]


def profile_context(device_id: str, max_chars: int = INJECTION_MAX_CHARS) -> dict:
    """生成契约化注入段；返回 {"text", "factIds"}。关闭或无内容时 text 为空串。

    契约：不再丢一团事实让模型自由发挥，而是按类别给段落 + 明确的行为规则
    （学段定素材与术语、薄弱点加铺垫、冲突以对话为准），弱模型也能遵守。
    """
    profile = get_profile(device_id)
    if not profile.get("enabled", True):
        return {"text": "", "factIds": []}
    sections, fact_ids = _profile_section_texts(profile)
    if not sections:
        return {"text": "", "factIds": []}
    rules = [
        "1. 学段/目标决定深度与素材：基础学段用对应考试的素材与语言，回避超纲术语；"
        "提升类目标（考研/竞赛）可用教材级表述。",
        "2. 薄弱章节首次涉及时多给一步铺垫或推导，不必反复点破。",
        "3. 兴趣方向可用于举例，不强求。",
        "4. 与本对话中最新陈述冲突时，以对话为准；术语偏好与难度等级冲突时，以难度等级为准；"
        "不得编造画像之外的用户信息。",
    ]
    text = (
        "<user_profile>\n"
        "以下是从用户长期使用中积累的学习画像，用于个性化本次回答：\n"
        + "\n".join(sections)
        + "\n使用规则：\n" + "\n".join(rules)
        + "\n</user_profile>"
    )
    if len(text) > max_chars:
        # 截断不能吃掉闭合标签：按行回退避免半行残留，再补回 </user_profile>
        body = text[:max_chars]
        nl = body.rfind("\n")
        if nl > 0:
            body = body[:nl]
        text = body + "\n</user_profile>"
    return {"text": text, "factIds": fact_ids}


def profile_context_text(device_id: str, max_chars: int = INJECTION_MAX_CHARS) -> str:
    """旧入口兼容：只返回注入文本。"""
    return profile_context(device_id, max_chars=max_chars)["text"]


def profile_ops_digest(device_id: str, max_lines: int = 20) -> str:
    """给提取模型的既有画像摘要：facts 与 pending 各带 id，供 confirm/update/remove 引用。"""
    profile = get_profile(device_id)
    if not profile.get("enabled", True):
        return ""
    lines = []
    for f in profile["facts"][:max_lines]:
        lines.append(f'{f["id"]}（{"已确认"}）[{f["category"]}] {str(f["fact"])[:60]}')
    for p in profile["pending"][:max(0, max_lines - len(lines))]:
        lines.append(f'{p["id"]}（待确认）[{p["category"]}] {str(p["fact"])[:60]}')
    return "\n".join(lines)


__all__ = [
    "PROFILES_DIR", "get_profile", "save_profile", "update_profile",
    "delete_profile", "add_fact_candidates", "apply_profile_ops",
    "mark_profile_used", "profile_context", "profile_context_text",
    "profile_ops_digest", "_norm_fact",
]
