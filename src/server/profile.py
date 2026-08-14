"""用户画像（记忆）存储：设备级隔离，JSON 文件持久化。

隐私设计：
- 画像按匿名设备 ID 隔离（前端 localStorage 生成），存 data/profiles/{device_id}.json
- enabled=False 时：不注入、不写入（add_fact_candidates 直接忽略），已存数据保留
- facts（自动固化）与 pending（候选）分离：同一事实出现 >=2 次才固化生效
- 开关与清除由前端驱动，本模块只负责存取与规则
"""

import copy
import logging
import re
import time
import uuid
from pathlib import Path

from .config import DATA_DIR
from .storage import _invalidate_json_cache, _read_json, _write_json

logger = logging.getLogger(__name__)

PROFILES_DIR = DATA_DIR / "profiles"
PROFILES_DIR.mkdir(parents=True, exist_ok=True)

PROFILE_VERSION = 1
MAX_FACTS = 50
MAX_PENDING = 30

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


def _default_profile() -> dict:
    return {
        "version": PROFILE_VERSION,
        "enabled": True,
        "explicit": copy.deepcopy(DEFAULT_EXPLICIT),
        "facts": [],
        "pending": [],
        "createdAt": time.time(),
        "updatedAt": time.time(),
    }


def _profile_path(device_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "", str(device_id or ""))
    if not safe or len(safe) > 64:
        safe = "default"
    return PROFILES_DIR / f"{safe}.json"


def get_profile(device_id: str) -> dict:
    """读取画像；不存在或损坏时返回默认画像。"""
    path = _profile_path(device_id)
    data = _read_json(path, None)
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
    for key in ("facts", "pending"):
        if isinstance(data.get(key), list):
            base[key] = [it for it in data[key] if isinstance(it, dict)][: (MAX_FACTS if key == "facts" else MAX_PENDING)]
    return base


def save_profile(device_id: str, profile: dict) -> dict:
    profile["updatedAt"] = time.time()
    _write_json(_profile_path(device_id), profile)
    return profile


def update_profile(device_id: str, updates: dict) -> dict:
    """合并更新：支持 explicit / enabled / facts / pending 局部更新。"""
    profile = get_profile(device_id)
    if not isinstance(updates, dict):
        return profile
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
    for key in ("facts", "pending"):
        if isinstance(updates.get(key), list):
            profile[key] = updates[key][: (MAX_FACTS if key == "facts" else MAX_PENDING)]
    return save_profile(device_id, profile)


def delete_profile(device_id: str) -> bool:
    """删除设备画像文件，返回是否存在。"""
    path = _profile_path(device_id)
    existed = path.exists()
    if existed:
        path.unlink(missing_ok=True)
        _invalidate_json_cache(path)
    return existed


def add_fact_candidates(device_id: str, candidates: list) -> int:
    """搭车提取入口：候选进入 pending；同一事实出现 >=2 次固化进 facts。

    开关关闭时直接忽略（不写入）。返回处理条数（0 表示无变化/已忽略）。
    """
    profile = get_profile(device_id)
    if not profile.get("enabled", True):
        return 0
    if not isinstance(candidates, list) or not candidates:
        return 0
    changed = 0
    for cand in candidates:
        if not isinstance(cand, dict):
            continue
        fact = str(cand.get("fact") or "").strip()
        if not fact or len(fact) > 120:
            continue
        category = str(cand.get("category") or "other").strip()
        if category not in FACT_CATEGORIES:
            category = "other"
        source = str(cand.get("sourceSession") or "")[:64]
        now = time.time()

        hit = next((f for f in profile["facts"] if str(f.get("fact") or "").strip() == fact), None)
        if hit:
            hit["occurrences"] = int(hit.get("occurrences", 1)) + 1
            hit["updatedAt"] = now
            if source:
                hit["sourceSession"] = source
            changed += 1
            continue

        pend = next((p for p in profile["pending"] if str(p.get("fact") or "").strip() == fact), None)
        if pend:
            pend["occurrences"] = int(pend.get("occurrences", 1)) + 1
            pend["updatedAt"] = now
            if source:
                pend["sourceSession"] = source
            if pend["occurrences"] >= 2:
                profile["facts"].append(pend)
                profile["pending"].remove(pend)
            changed += 1
            continue

        profile["pending"].append({
            "id": "pf_" + uuid.uuid4().hex[:12],
            "fact": fact,
            "category": category,
            "sourceSession": source,
            "occurrences": 1,
            "createdAt": now,
            "updatedAt": now,
        })
        changed += 1

    if not changed:
        return 0
    # 容量裁剪：保留最新
    profile["pending"] = profile["pending"][-MAX_PENDING:]
    profile["facts"] = profile["facts"][-MAX_FACTS:]
    save_profile(device_id, profile)
    return changed


def profile_context_text(device_id: str, max_chars: int = 1200) -> str:
    """生成注入 system prompt 的 <user_profile> 段；关闭或无内容时返回空串。"""
    profile = get_profile(device_id)
    if not profile.get("enabled", True):
        return ""
    exp = profile["explicit"]
    parts = []
    if exp.get("stage"):
        parts.append(f"学段：{exp['stage']}")
    if exp.get("goal"):
        parts.append(f"目标：{exp['goal']}")
    if exp.get("interests"):
        parts.append(f"兴趣：{exp['interests']}")
    if exp.get("weakAreas"):
        parts.append(f"薄弱：{exp['weakAreas']}")
    style = exp.get("style") or {}
    style_parts = []
    if style.get("detail") and style["detail"] != "标准":
        style_parts.append(f"详略={style['detail']}")
    if style.get("jargon") and style["jargon"] != "标准":
        style_parts.append(f"术语={style['jargon']}")
    if style.get("visuals") and style["visuals"] != "否":
        style_parts.append(f"可视化={style['visuals']}")
    if style_parts:
        parts.append("回答偏好：" + "；".join(style_parts))
    facts = [f for f in profile["facts"] if str(f.get("fact") or "").strip()]
    if facts:
        parts.append("已记录事实：" + "；".join(str(f["fact"])[:60] for f in facts))
    if not parts:
        return ""
    text = (
        "<user_profile>\n"
        "（以下为用户的长期画像，仅用于个性化表达与建议。规则：1. 与对话中最新陈述冲突时，以对话为准；"
        "2. 术语偏好与难度等级冲突时，以难度等级为准；3. 不得编造画像之外的用户信息。）\n"
        + "\n".join(parts)
        + "\n</user_profile>"
    )
    return text[:max_chars]


__all__ = [
    "PROFILES_DIR", "get_profile", "save_profile", "update_profile",
    "delete_profile", "add_fact_candidates", "profile_context_text",
]
