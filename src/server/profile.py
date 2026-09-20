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
import math
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
# 用户管理动作（manage_profile_fact）：按 ID 的原子操作，替代面板整份 PUT 回写
MANAGE_ACTIONS = (
    "delete_fact", "restore_fact", "confirm_pending",
    "delete_pending", "restore_archive", "delete_archive",
)


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


def _finite_number(value):
    """只接受有限的数字/数字字符串；bool 不是画像数值。"""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        number = float(value)
    except (ValueError, TypeError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _positive_int(value, default=1):
    number = _finite_number(value)
    if number is None or number < 1:
        return default
    return int(min(number, 2**31 - 1))


def _timestamp(value, default=0):
    """秒为标准，兼容旧毫秒；未知时间不伪造为当前时间。"""
    number = _finite_number(value)
    if number is None or number < 0:
        return default
    if number >= 1e12:
        number /= 1000
    # 限于公元 9999 年以内，避免极大有限数污染排序/生命周期。
    return number if number <= 253402300799 else default


def _normalize_fact_item(item: dict) -> dict:
    """补齐旧字段；逐字段降级，保留扩展字段及未知历史时间。"""
    history = item.get("history")
    return {
        **item,
        "id": str(item.get("id") or ("pf_" + uuid.uuid4().hex[:12])),
        "fact": str(item.get("fact") or "").strip(),
        "category": item.get("category") if item.get("category") in FACT_CATEGORIES else "other",
        "sourceSession": str(item.get("sourceSession") or "")[:64],
        "source": str(item.get("source") or "")[:32],
        "occurrences": _positive_int(item.get("occurrences")),
        "status": "idle" if item.get("status") == "idle" else "active",
        "history": [{**h, "at": _timestamp(h.get("at"))}
                    for h in (history if isinstance(history, list) else [])
                    if isinstance(h, dict)][:MAX_FACT_HISTORY],
        "createdAt": _timestamp(item.get("createdAt")),
        "updatedAt": _timestamp(item.get("updatedAt")),
        "lastUsedAt": _timestamp(item.get("lastUsedAt")),
    }


def _normalize_archive_item(item: dict) -> dict:
    return {**_normalize_fact_item(item),
            "removedAt": _timestamp(item.get("removedAt"), default=None)}


# 画像的三个事实列表共用同一套「逐条归一化 + 保尾截断」规则：
# 磁盘读取（_normalize_profile）与局部更新（update_profile）必须同口径，
# 否则一次面板更新就能把不相关列表里的扩展字段截掉。
FACT_LISTS = (("facts", MAX_FACTS, _normalize_fact_item),
              ("pending", MAX_PENDING, _normalize_fact_item),
              ("archive", MAX_ARCHIVE, _normalize_archive_item))


def _normalize_fact_lists(target: dict, source: dict) -> dict:
    """把 source 里出现的 facts/pending/archive 列表归一化进 target。"""
    for key, limit, normalizer in FACT_LISTS:
        if isinstance(source.get(key), list):
            target[key] = [normalizer(it) for it in source[key] if isinstance(it, dict)][-limit:]
    return target


def _merge_explicit(dest: dict, source, text_limit=None) -> dict:
    """把 explicit 的表单字段与 style 偏好并入 dest（只收合法值）。"""
    if not isinstance(source, dict):
        return dest
    for key in ("stage", "goal", "interests", "weakAreas"):
        value = source.get(key)
        if isinstance(value, str):
            dest[key] = value[:text_limit] if text_limit else value
    if isinstance(source.get("style"), dict):
        for key, allowed in STYLE_VALUES.items():
            if source["style"].get(key) in allowed:
                dest["style"][key] = source["style"][key]
    return dest


def _find_by_id(items, item_id):
    """按 id 找条目；列表里可能混有旧格式的非 dict 项。"""
    return next((it for it in (items or [])
                 if isinstance(it, dict) and it.get("id") == item_id), None)


def _find_by_norm(items, norm: str, exclude=None):
    """按规范化文本找条目（查重口径与 _norm_fact 一致；exclude 用于排除自身）。"""
    if not norm:
        return None
    return next((it for it in (items or [])
                 if it is not exclude and isinstance(it, dict)
                 and _norm_fact(it.get("fact", "")) == norm), None)


def _has_exact_text(items, text: str) -> bool:
    """列表里是否已有原文完全相同的条目（面板确认/恢复时的合并判定）。"""
    return any(isinstance(it, dict) and str(it.get("fact") or "") == text for it in (items or []))


def _normalize_profile(data) -> dict:
    """把任意磁盘数据归一化为完整画像结构（缺失/损坏字段回退默认值）。"""
    if not isinstance(data, dict):
        return _default_profile()
    base = _default_profile()
    base["version"] = _positive_int(data.get("version"), PROFILE_VERSION)
    for key in ("createdAt", "updatedAt"):
        base[key] = _timestamp(data.get(key))
    base["enabled"] = bool(data.get("enabled", True))
    _merge_explicit(base["explicit"], data.get("explicit"))
    _normalize_fact_lists(base, data)
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
        _merge_explicit(profile["explicit"], updates.get("explicit"), text_limit=200)
        _normalize_fact_lists(profile, updates)
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


def apply_profile_ops(device_id: str, ops: list, source: str = "",
                      *, report_acceptance: bool = False) -> dict:
    """合并式采集入口：按 op 类型合并进画像，返回 {"changed", "promoted"}。

    - new：规范化查重后撞上已有事实按 confirm 处理；stage/goal 直接入 facts，其余进 pending
    - confirm：命中 facts 计数+1；命中 pending 计数达 2 固化（promoted 返回固化文本）
    - update：原地更替文本，旧文留 history；更替后文本撞上其他事实则合并为一次 confirm
    - remove：从 facts/pending 删除，落 archive（面板可查看/恢复）
    开关关闭时直接忽略（不写入）。
    changed 统计实际修改的操作次数（含计数），promoted 只报告真实固化。
    """
    result = {"changed": 0, "promoted": []}
    accepted_indices = []
    if report_acceptance:
        result.update(accepted=False, acceptedIndices=[])
    if not isinstance(ops, list) or not ops:
        return result

    def updater(raw):
        profile = _normalize_profile(raw)
        if not profile.get("enabled", True):
            if report_acceptance:
                result["ignored"] = "disabled"
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
            hit = _find_by_norm(facts, norm)
            if hit:
                _confirm_item(hit, op)
                return True
            pend_hit = _find_by_norm(pending, norm)
            if pend_hit:
                _confirm_item(pend_hit, op)
                return True
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

        for index, raw_op in enumerate(ops):
            op = _sanitize_op(raw_op)
            if not op:
                continue
            kind = op["op"]

            if kind == "remove":
                hit = _find_by_id(facts, op["id"]) or _find_by_id(pending, op["id"])
                if hit:
                    _archive_item(hit, op["source"] or "user")
                    changed += 1
                    accepted_indices.append(index)
                continue

            if kind == "confirm":
                hit = _find_by_id(facts, op["id"]) or _find_by_id(pending, op["id"])
                if hit:
                    _confirm_item(hit, op)
                    changed += 1
                    accepted_indices.append(index)
                continue

            if kind == "update":
                target = _find_by_id(facts, op["id"]) or _find_by_id(pending, op["id"])
                if not target:
                    # 目标不存在：更正信息按新事实落地（内部查重兜底）
                    if _new_fact(op):
                        changed += 1
                        accepted_indices.append(index)
                    continue
                norm = _norm_fact(op["fact"])
                if norm and norm != _norm_fact(target["fact"]):
                    twin = _find_by_norm(facts, norm, exclude=target) \
                        or _find_by_norm(pending, norm, exclude=target)
                    if twin:
                        # 更正成了已知事实：旧条目退役，既有条目计数+1（矛盾更替）
                        _archive_item(target, "superseded")
                        _confirm_item(twin, op)
                        changed += 1
                        accepted_indices.append(index)
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
                accepted_indices.append(index)
                continue

            # new
            if _new_fact(op):
                changed += 1
                accepted_indices.append(index)

        result["changed"] = changed
        if not changed:
            return None
        profile["pending"] = profile["pending"][-MAX_PENDING:]
        if len(profile["facts"]) > MAX_FACTS:
            # 容量满时不无声丢数据：被挤出的已固化事实落 archive（与 remove 同
            # 语义，面板可查可恢复），而不是静默蒸发。用户管理路径
            # confirm_pending 在容量满时本来就拒绝写入，自动采集路径不能更
            # 宽松地丢别人的数据（09-20 修复）
            overflow = profile["facts"][:-MAX_FACTS]
            profile["facts"] = profile["facts"][-MAX_FACTS:]
            for item in overflow:
                profile["archive"].append({
                    "id": item.get("id"), "fact": item.get("fact"),
                    "category": item.get("category"), "removedAt": now,
                    "source": "capacity",
                })
            profile["archive"] = profile["archive"][-MAX_ARCHIVE:]
        profile["updatedAt"] = time.time()
        if report_acceptance:
            retained = {_norm_fact(f["fact"]) for f in profile["facts"] + profile["pending"]}
            result["acceptedIndices"] = [i for i in accepted_indices
                if _sanitize_op(ops[i])["op"] not in ("new", "update")
                or _norm_fact(_sanitize_op(ops[i])["fact"]) in retained]
            result["accepted"] = bool(result["acceptedIndices"])
        return profile

    _mutate_json(_profile_path(device_id), updater)
    return result


def add_fact_candidates(device_id: str, candidates: list) -> int:
    """旧入口兼容：候选数组（无 op 字段）按 new 语义合并。返回处理条数。"""
    if not isinstance(candidates, list):
        return 0
    return apply_profile_ops(device_id, candidates, source="legacy")["changed"]


def manage_profile_fact(device_id: str, action, fact_id) -> dict:
    """用户管理单条记忆的原子操作（面板专用，替代整份 PUT 回写）。

    语义对齐原 memory.js 面板行为，避免业务漂移：
    - delete_fact：从 facts 彻底移除（不进 archive）
    - restore_fact：事实回 active，每次请求都刷新 lastUsedAt
    - confirm_pending：用户主动确认，直接固化进 facts（occurrences 至少 2、status active）
    - delete_pending：从 pending 移除，不归档
    - restore_archive：归档回 pending 重新确认——新 ID、occurrences=1、source="restored"；
      pending 已有同文本候选时仅移除归档（不合并计数、不固化）
    - delete_archive：从 archive 彻底删除
    只读写目标 ID 所在列表，不触碰 enabled/explicit/其他事实；与采集开关
    （apply_profile_ops 忽略 enabled=False）不同，用户主动管理在关闭时仍可用。
    返回 {"changed", "promoted", "accepted"}：accepted=true 表示请求有效执行
    （含幂等 no-op）；ID 不存在或容量不足 accepted=false 且不写盘；promoted
    只在真实固化时非空。
    """
    if not isinstance(action, str) or action not in MANAGE_ACTIONS:
        raise ValueError(f"unknown action: {action!r}")
    if not isinstance(fact_id, str) or not fact_id.strip():
        raise ValueError("fact_id must be a non-empty string")

    result = {"changed": 0, "promoted": [], "accepted": False}

    def updater(raw):
        if not isinstance(raw, dict):
            return None
        # 不整份归一化：管理只写目标及 updatedAt，保留扩展字段、其他条目
        # 和历史超容量列表；否则一次删除也可能截断不相关的数据。
        profile = copy.deepcopy(raw)
        lists = {key: profile.get(key, []) for key in ("facts", "pending", "archive")}
        source_key = {"delete_fact": "facts", "restore_fact": "facts",
                      "confirm_pending": "pending", "delete_pending": "pending",
                      "restore_archive": "archive", "delete_archive": "archive"}[action]
        source = lists[source_key]
        if not isinstance(source, list):
            return None
        hit = _find_by_id(source, fact_id)
        if hit is None:
            return None
        now = time.time()
        facts = lists["facts"]
        pending = lists["pending"]
        archive = lists["archive"]

        if action in ("delete_fact", "delete_pending", "delete_archive"):
            source.remove(hit)
        elif action == "restore_fact":
            hit["status"] = "active"
            hit["lastUsedAt"] = now
        elif action == "confirm_pending":
            if not isinstance(facts, list):
                return None
            same_text = _has_exact_text(facts, str(hit.get("fact") or ""))
            if not same_text and len(facts) >= MAX_FACTS:
                return None
            pending.remove(hit)
            if not same_text:
                solid = _normalize_fact_item({**hit, "status": "active",
                    "occurrences": max(_positive_int(hit.get("occurrences")), 2),
                    "updatedAt": now, "lastUsedAt": now})
                facts.append(solid)
                profile["facts"] = facts
                result["promoted"].append(solid["fact"])
        elif action == "restore_archive":
            if not isinstance(pending, list):
                return None
            same_text = _has_exact_text(pending, str(hit.get("fact") or ""))
            if not same_text and len(pending) >= MAX_PENDING:
                return None
            archive.remove(hit)
            if not same_text:
                pending.append(_normalize_fact_item({
                    "id": "pf_" + uuid.uuid4().hex[:12],
                    "fact": hit.get("fact"), "category": hit.get("category"),
                    "source": "restored", "occurrences": 1,
                    "createdAt": now, "updatedAt": now,
                }))
                profile["pending"] = pending

        result["accepted"] = True
        result["changed"] = int(profile != raw)

        if not result["changed"]:
            return None  # 幂等 no-op：接受但不重写文件
        profile["updatedAt"] = now
        return profile

    _mutate_json(_profile_path(device_id), updater)
    return result


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
    """把画像组装为结构化段落（契约化注入的正文）。

    返回 (sections, fact_ids)：sections 每项为 (label, items, ids)——items 是
    实际进入正文的条目文本，ids 与 items 一一对应（显式表单条目无事实 id，
    以 None 占位）。fact_ids 只含真正进入正文的事实，供注入后回写 lastUsedAt；
    休眠（idle）事实与被显式信息去重合并的事实都不返回。预算裁剪时按同结构
    丢弃条目，ID 与正文永不脱节。
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
        candidates = []
        if exp.get(key):
            candidates.append((exp[key], None))
        candidates.extend((str(f["fact"]), f["id"]) for f in facts if f["category"] == category)
        seen = set()
        items, ids = [], []
        for t, fid in candidates:
            k = _norm_fact(t)
            if k and k not in seen:
                seen.add(k)
                items.append(t[:60])
                ids.append(fid)
                if len(items) >= 5:
                    break
        if items:
            sections.append((label, items, ids))
    style = exp.get("style") or {}
    style_parts = []
    if style.get("detail") and style["detail"] != "标准":
        style_parts.append((f"详略={style['detail']}", None))
    if style.get("jargon") and style["jargon"] != "标准":
        style_parts.append((f"术语={style['jargon']}", None))
    if style.get("visuals") and style["visuals"] != "否":
        style_parts.append((f"可视化={style['visuals']}", None))
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
            style_parts.append((t, f["id"]))
    if style_parts:
        sections.append(("【偏好】", [t for t, _ in style_parts], [fid for _, fid in style_parts]))
    other_seen = set()
    other_items, other_ids = [], []
    for f in facts:
        if f["category"] != "other":
            continue
        t = str(f["fact"])[:60]
        k = _norm_fact(t)
        if k and k not in other_seen:
            other_seen.add(k)
            other_items.append(t)
            other_ids.append(f["id"])
            if len(other_items) >= 5:
                break
    if other_items:
        sections.append(("【其他】", other_items, other_ids))
    return sections, [fid for _, _, ids in sections for fid in ids if fid]


def profile_context(device_id: str, max_chars: int = INJECTION_MAX_CHARS) -> dict:
    """生成契约化注入段；返回 {"text", "factIds", "sections"}。

    契约：不再丢一团事实让模型自由发挥，而是按类别给段落 + 明确的行为规则
    （学段定素材与术语、薄弱点加铺垫、冲突以对话为准），弱模型也能遵守。
    factIds 恒等于实际进入 text 的事实（预算裁剪时逐条回退），保证
    lastUsedAt 只刷新真正展示过的内容；sections 是同一份选中的
    `[{"label", "text"}]`，供回答角标展示「本次实际注入了什么」——前端不再
    自己按缓存重算一遍，两套同构算法不会随改动漂移。
    """
    profile = get_profile(device_id)
    if not profile.get("enabled", True):
        return {"text": "", "factIds": [], "sections": []}
    sections, _ = _profile_section_texts(profile)
    if not sections:
        return {"text": "", "factIds": [], "sections": []}
    rules = [
        "1. 学段/目标决定深度与素材：基础学段用对应考试的素材与语言，回避超纲术语；"
        "提升类目标（考研/竞赛）可用教材级表述。",
        "2. 薄弱章节首次涉及时多给一步铺垫或推导，不必反复点破。",
        "3. 兴趣方向可用于举例，不强求。",
        "4. 与本对话中最新陈述冲突时，以对话为准；术语偏好与难度等级冲突时，以难度等级为准；"
        "不得编造画像之外的用户信息。",
    ]

    def render(sel):
        parts = []
        ids = []
        usage = []
        for label, items, sec_ids in sel:
            joined = "；".join(items)
            parts.append(label + joined)
            usage.append({"label": label.strip("【】"), "text": joined})
            ids.extend(fid for fid in sec_ids if fid)
        text = (
            "<user_profile>\n"
            "以下是从用户长期使用中积累的学习画像，用于个性化本次回答：\n"
            + "\n".join(parts)
            + "\n使用规则：\n" + "\n".join(rules)
            + "\n</user_profile>"
        )
        return text, ids, usage

    # 规则和闭合标签必须完整；预算不足时只移除完整条目。
    while sections:
        text, fact_ids, usage = render(sections)
        if len(text) <= max_chars:
            return {"text": text, "factIds": fact_ids, "sections": usage}
        _, items, ids = sections[-1]
        items.pop()
        ids.pop()
        if not items:
            sections.pop()
    return {"text": "", "factIds": [], "sections": []}


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
    "delete_profile", "add_fact_candidates", "apply_profile_ops", "manage_profile_fact",
    "mark_profile_used", "profile_context", "profile_context_text",
    "profile_ops_digest", "_norm_fact",
]
