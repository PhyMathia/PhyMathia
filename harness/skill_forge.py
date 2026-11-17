"""技能工坊执行器（2026-11-17，skill 系统第 9 版 P2）。

DSH 创造模式的四件套（查/装/验工具、模板可复制、以结果字段判定、幂等安装可回滚）
在这里落成四个服务端执行的工具：

- `skill_spec`     查：格式/上限/scope/目录型边界 + 现役技能清单（反射 `capabilities`）
- `read_skill`     查：读一条现役技能的正文（改造它，不从白纸写）
- `preview_skill`  验：`validate_skill` 逐字段校验 + 结构体检 + 路由试跑 + 草稿指纹
- `install_skill`  装：幂等入册（`save_skill`），必须带 preview 发回的指纹

**草稿不落盘**：草稿全文就在对话里（模型每次把完整 skill 传进来），服务端零状态；
回滚＝不调 install，或装完后去技能页关掉/删掉。指纹 = 入参哈希，保证「写进去的字节」
就是「用户看过预览的那一版」——这是把「人确认」变成可机器校验的一步。

与配方工坊的分工：那边判的是结构化 JSON（深合并补丁），这边判的是自然语言正文，
所以没有草稿合并层，只有「校验 + 体检 + 试跑」三样结果字段。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, List

# 工具名：与 tools.py 的 tdef 一一对应（那边从本模块导入这组常量，别各写一份）
SKILL_TOOL_NAMES = ("skill_spec", "read_skill", "preview_skill", "install_skill")

# 草稿指纹长度：12 位足够区分（这是防「预览后偷偷改payload」，不是密码学用途）
DRAFT_TOKEN_LEN = 12
# 试跑最多几条问题（一次 3 条够判断，多了烧步数）
MAX_TEST_QUESTIONS = 3
# read_skill 回给模型的正文字符上限（工具结果总闸 4000，留出字段余量）
READ_BODY_CHARS = 3000

# 本宿主做不到的动作（HOST_GUARD 同源口径）：正文里要求这些步骤，模型会编造「已执行」
HOST_IMPOSSIBLE_HINTS = (
    "运行脚本", "执行脚本", "运行命令", "编译", "build.mjs", "npm run",
    "pip install", "打开浏览器", "截图", "联网下载", "curl ", "wget ",
)


class SkillForgeUnavailable(RuntimeError):
    """server 包不可用（battery 测试桩/独立部署）：技能工具整体不提供。"""


def _registry():
    """惰性导入 `server.skill_registry`（与 harness/api.py 取 profile 同一手法）。

    本包不依赖 server，导入失败一律按「技能系统不可用」处理，工具表里也就不会有这四项。
    """
    try:
        from server import skill_registry  # noqa: PLC0415（惰性：只在真调工具时导入）
    except Exception as exc:  # pragma: no cover - 只在独立部署/测试桩下发生
        raise SkillForgeUnavailable(str(exc)) from exc
    return skill_registry


def available() -> bool:
    """技能工具是否可用（工具表装配处用它决定要不要给这四项）。"""
    try:
        _registry()
    except SkillForgeUnavailable:
        return False
    return True


def draft_token(clean: Dict[str, Any]) -> str:
    """草稿指纹：五个字段按键排序后取 sha256 前 12 位。"""
    payload = {key: clean.get(key) for key in ("id", "name", "desc", "scope", "body")}
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:DRAFT_TOKEN_LEN]


def _body_signals(reg, body: str) -> Dict[str, Any]:
    """正文体检：只看数得出来的东西（与配方工坊 `_rwJudgeOutput` 同一哲学，宁漏勿误）。

    回归不能保证「写得好不好」，但能保证「结构齐不齐、有没有让模型去执行命令」。
    """
    sections = [name for name in reg.BODY_SECTIONS if name in body]
    missing = [name for name in reg.BODY_SECTIONS if name not in body]
    host_hits = [hint for hint in HOST_IMPOSSIBLE_HINTS if hint in body]
    warnings: List[str] = []
    if missing:
        warnings.append("正文缺这几段：" + "、".join(missing) + "（四段都写，模型才知道边界）")
    if len(body) < 200:
        warnings.append(f"正文只有 {len(body)} 字，太短——多半没写清「按什么做」")
    if host_hits:
        warnings.append(
            "正文要求了本宿主做不到的动作：" + "、".join(host_hits)
            + "（本宿主只生成文字与 HTML，不执行命令、不开浏览器；这类步骤会让模型编造「已执行」）"
        )
    return {"sections": sections, "missingSections": missing, "hostHints": host_hits, "warnings": warnings}


def _routing_preview(reg, scope: List[str], questions: Any, avoid: Any) -> Dict[str, Any]:
    """路由试跑：给几条真实问题，看这条草稿会不会进候选（零 token，不跑模型）。

    用的是「试一条」同一个 `guess_modules`（字面锚点粗筛），所以结论口径与技能页
    预览一致：**只回答候选层，最终挂不挂仍由分析步的模型决定**。
    """
    rows: List[Dict[str, Any]] = []
    for raw in list(questions or [])[:MAX_TEST_QUESTIONS]:
        text = str(raw or "").strip()
        if not text:
            continue
        matched = reg.guess_modules(text)
        keys = [key for key in reg.MODULE_LABELS if key in matched]
        usable = [key for key in scope if (not keys or key in keys)]
        rows.append({
            "question": text[:80],
            "matchedModules": [reg.MODULE_LABELS[key] for key in keys],
            "matchSource": "keywords" if keys else "all",
            "wouldEnterCandidates": bool(usable),
            "usableModules": [reg.MODULE_LABELS[key] for key in usable],
        })
    avoid_rows: List[Dict[str, Any]] = []
    for raw in list(avoid or [])[:MAX_TEST_QUESTIONS]:
        text = str(raw or "").strip()
        if not text:
            continue
        matched = reg.guess_modules(text)
        keys = [key for key in reg.MODULE_LABELS if key in matched]
        usable = [key for key in scope if (not keys or key in keys)]
        avoid_rows.append({
            "question": text[:80],
            "wouldAlsoMatch": bool(usable),
            "matchedModules": [reg.MODULE_LABELS[key] for key in keys],
        })
    too_broad = [row["question"] for row in avoid_rows if row["wouldAlsoMatch"]]
    return {"tests": rows, "avoid": avoid_rows, "tooBroad": too_broad}


def _existing_row(reg, account: Any, skill_id: str) -> Dict[str, Any]:
    caps = reg.capabilities(account)
    for row in caps.get("existing") or []:
        if row.get("id") == skill_id:
            return row
    return {}


def _skill_spec(account: Any) -> Dict[str, Any]:
    caps = _registry().capabilities(account)
    return {
        "format": caps["format"],
        "planBlock": caps["planBlock"],
        "id": caps["id"],
        "limits": caps["limits"],
        "cards": caps["cards"],
        "scope": caps["scope"],
        "layouts": caps["layouts"],
        "existing": caps["existing"],
        "counts": caps["counts"],
        "note": "照这些字段写；正文四段结构见 format.bodySections。改一条现役技能先 read_skill 取正文。",
    }


def _read_skill(account: Any, skill_id: str) -> Dict[str, Any]:
    reg = _registry()
    item = reg.get(skill_id, account)
    if not item:
        ids = [row["id"] for row in reg.capabilities(account).get("existing") or []]
        return {"error": f"没有这条技能：{skill_id}", "existing": ids}
    body = str(item.get("body") or "")
    out = {
        "id": item["id"],
        "name": item["name"],
        "desc": item["desc"],
        "scope": list(item["scope"]),
        "layout": item.get("layout") or "file",
        "enabled": bool(item.get("enabled", True)),
        "builtin": bool(item.get("builtin")),
        "writable": (item.get("layout") or "file") == "file",
        "chars": len(body),
        "body": body[:READ_BODY_CHARS],
    }
    if len(body) > READ_BODY_CHARS:
        out["bodyTruncated"] = True
    if out["layout"] != "file":
        out["writableNote"] = "目录型技能不能经接口改：请让用户直接编辑它目录里的 phymathia.md"
    return out


def _preview_skill(account: Any, args: Dict[str, Any]) -> Dict[str, Any]:
    reg = _registry()
    payload = args.get("skill") if isinstance(args.get("skill"), dict) else {}
    errors = reg.skill_errors(account, payload)
    if errors:
        return {
            "ok": False,
            "fieldErrors": errors,
            "hint": "按 fieldErrors 改这几处；其余字段保持不动再调一次 preview_skill。",
        }
    clean = reg.validate_skill(account, payload)
    signals = _body_signals(reg, clean["body"])
    routing = _routing_preview(reg, clean["scope"], args.get("questions"), args.get("avoid"))
    target = _existing_row(reg, account, clean["id"])
    notes = list(signals["warnings"])
    if routing["tooBroad"]:
        notes.append(
            "这些「不该命中」的问题也会命中：" + "；".join(routing["tooBroad"][:3])
            + "——把 scope 收窄，或把「不适用」写进正文让分析步自己筛。"
        )
    if target and target.get("builtin"):
        notes.append(f"id 与内置技能 {clean['id']} 同名：装进去会成为你的副本（可「恢复默认」退回内置）。")
    return {
        "ok": True,
        "id": clean["id"],
        "name": clean["name"],
        "scope": clean["scope"],
        "chars": {"body": len(clean["body"]), "bodyLimit": reg.LIMITS["body"], "desc": len(clean["desc"])},
        "signals": signals,
        "routing": routing,
        "target": target or {"exists": False},
        "draftToken": draft_token(clean),
        "notes": notes,
        "hint": "把 target/signals/routing 的结果讲给用户听；用户明确说「装上/就这个」后再调 install_skill，并把 draftToken 原样带上。",
    }


def _install_skill(account: Any, args: Dict[str, Any]) -> Dict[str, Any]:
    reg = _registry()
    payload = args.get("skill") if isinstance(args.get("skill"), dict) else {}
    token = str(args.get("token") or "").strip()
    errors = reg.skill_errors(account, payload)
    if errors:
        return {"ok": False, "fieldErrors": errors, "hint": "先修字段再入册。"}
    clean = reg.validate_skill(account, payload)
    expected = draft_token(clean)
    if not token or token != expected:
        return {
            "ok": False,
            "error": "入册的草稿与预览过的那一版不一致（或没带 draftToken）。先调 preview_skill 重新预览，拿到 draftToken 再原样带上。",
        }
    before = reg.get(clean["id"], account)
    item = reg.save_skill(account, clean)
    menu = reg.menu_block(None, account)
    return {
        "ok": True,
        "id": item["id"],
        "name": item["name"],
        "scope": list(item["scope"]),
        "created": not bool(before),
        "replacedBuiltin": bool(before and before.get("builtin")),
        "enabled": bool(item.get("enabled", True)),
        "menuListed": f"id={item['id']}" in menu,
        "rollback": "要撤就关掉开关或删掉这条（技能页 / 「恢复默认」退回内置版）。",
    }


def execute_skill_tool(name: str, args: Dict[str, Any], account: Any) -> Dict[str, Any]:
    """执行一个技能工具，返回可直接回灌给模型的结果 dict。

    与只读查询同一条哲学：**不抛异常**——失败也以 `{"error": ...}` 回给模型，让它
    自己改一次再试，别把整个请求打成 502。
    """
    args = args if isinstance(args, dict) else {}
    try:
        if name == "skill_spec":
            return _skill_spec(account)
        if name == "read_skill":
            return _read_skill(account, str(args.get("id") or "").strip())
        if name == "preview_skill":
            return _preview_skill(account, args)
        if name == "install_skill":
            return _install_skill(account, args)
        return {"error": f"未知的技能工具：{name}"}
    except SkillForgeUnavailable as exc:
        return {"error": f"技能系统不可用：{exc}"}
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as exc:  # pragma: no cover - 兜底防 500
        return {"error": f"技能工具执行失败：{exc}"}
