"""skill 参考资料按需取（第 7 版，2026-11-17）。

上一版（第 6 版）让目录型 skill 能被识别，但**只有适配层那份正文进提示词**——上游
`references/` 里几十万字符的原始资料一个字都读不到。这个模块补的是那一步：先让模型看
一份「目录」，挑最多 2 份，再把这些文件里相关的部分读出来拼进提示词。

为什么不让模型自己发「读文件」指令（真正的工具循环，见 backlog 478 的 L2）：
1. 本项目 `/api/models/chat` 是单轮流式转发，工具循环要在流里中断、回灌、再发起，
   前端还要多一套「正在读取」状态；
2. 「挑哪几份」是一次极小的判断（目录约 300 token），放在生成前做，用户几乎无感；
3. 真需要「读完再读」的场景，等 L2 再补，读文件这段代码可以原样复用。

为什么不走向量检索：`references/` 是英文，本项目的 embedding 是中文模型
（bge-small-zh），中文问句检索英文文档不稳；让模型看目录做跨语言判断要准得多，
而且**可解释**——日志里能看出这次读了哪几份。

约定（用户装别的 skill 时照这个写）：
- 参考资料放 `<skill 目录>/references/*.md`；
- 可选 `references/INDEX.md`，一行一份：`craft.md — 一句话说明`。没有就回退到
  各文件的第一个 `# 标题`。这个文件本身**不进提示词全文**，只取那几行当目录。

安全与降级：
- 只读 `.md`，文件名必须是纯文件名（拒绝 `../`、盘符、绝对路径），realpath 必须落在
  `references/` 里；
- 任何一步失败（没有目录、读不出、模型回坏 JSON）一律返回空串，注入内容退回第 6 版行为。
"""

from __future__ import annotations

import os
import re
from typing import Any, Dict, Iterable, List

REF_DIR = "references"
INDEX_NAME = "INDEX.md"
# 单次最多带这么多字符（正文 4k + 参考 12k ≈ 5k token，够一个节点用）
MAX_CHARS = 12000
MAX_FILES = 2
# 每份配额的下限：太小的配额等于没读
MIN_PER_FILE = 2000

_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+\.md$")


# ====== 取目录 ======

def _ref_dir(skill_id: str, account: Any = None):
    from . import skill_registry

    base = skill_registry.skill_dir(skill_id, account)
    if base is None:
        return None
    path = base / REF_DIR
    return path if path.is_dir() else None


def _parse_index(text: str) -> List[Dict[str, str]]:
    """解析 INDEX.md：一行一份，`文件名 — 说明`（也容忍 `-`、`|`、制表符）。"""
    rows: List[Dict[str, str]] = []
    for raw in str(text or "").splitlines():
        line = raw.strip().lstrip("-*").strip()
        if not line or line.startswith("#"):
            continue
        match = re.match(r"^([A-Za-z0-9._-]+\.md)\s*[—–\-|:\t]\s*(.+)$", line)
        if not match:
            continue
        rows.append({"file": match.group(1), "label": match.group(2).strip()})
    return rows


def _title_of(text: str) -> str:
    for line in str(text or "").splitlines():
        line = line.strip()
        if line.startswith("# "):
            return line[2:].strip()
    return ""


def catalog(skill_id: str, account: Any = None) -> List[Dict[str, str]]:
    """可挑的参考目录：[{file, label}]。没有 references/ 时返回空列表。"""
    folder = _ref_dir(skill_id, account)
    if folder is None:
        return []
    index = folder / INDEX_NAME
    if index.is_file():
        try:
            rows = _parse_index(index.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            rows = []
        # 只留真实存在的 .md（防止 INDEX 里写了不存在的文件）
        return [row for row in rows if (folder / row["file"]).is_file()]
    out: List[Dict[str, str]] = []
    try:
        names = sorted(p.name for p in folder.glob("*.md") if p.name != INDEX_NAME)
    except Exception:
        return []
    for name in names:
        if not _SAFE_NAME.match(name):
            continue
        try:
            label = _title_of((folder / name).read_text(encoding="utf-8", errors="replace"))
        except Exception:
            label = ""
        out.append({"file": name, "label": label or name})
    return out


def available(skill_id: str, account: Any = None) -> bool:
    return bool(catalog(skill_id, account))


# ====== 让模型挑 ======

PICK_SYSTEM = "你只做一件事：从给定目录里挑出与问题最相关的参考资料。不要解释，不要输出多余文字。"


def pick_prompt(question: Any, rows: Iterable[Dict[str, str]]) -> str:
    items = list(rows or [])
    if not items:
        return ""
    text = str(question or "").strip()
    lines = [
        "为下面这次装置图生成挑选参考资料。",
        f"问题：{text or '（未提供）'}",
        "",
        "可用参考（一行一份）：",
    ]
    for row in items:
        lines.append(f"- {row['file']} — {row['label']}")
    lines += [
        "",
        f"规则：最多挑 {MAX_FILES} 份；只挑与本问题直接相关的；",
        "说明里写着「本项目不适用」的一律不选；一份都不相关就返回空数组。",
        '只输出一行 JSON，形如：{"read":["craft.md"]}',
    ]
    return "\n".join(lines)


def parse_picks(text: Any, rows: Iterable[Dict[str, str]]) -> List[str]:
    """从模型输出里取出被挑中的文件名。只认目录里真实存在的，顺序按目录顺序。"""
    known = [row["file"] for row in (rows or [])]
    if not known:
        return []
    raw = str(text or "")
    picked: List[str] = []
    # 优先按 JSON 解析；不行就把所有 md 文件名扫一遍（模型爱加解释）
    try:
        import json

        match = re.search(r"\{[\s\S]*\}|\[[\s\S]*\]", raw)
        if match:
            data = json.loads(match.group(0))
            if isinstance(data, dict):
                data = data.get("read") or data.get("files") or data.get("picks") or []
            if isinstance(data, str):
                data = [data]
            if isinstance(data, list):
                for item in data:
                    name = str(item or "").strip().lstrip("./")
                    if name in known and name not in picked:
                        picked.append(name)
    except Exception:
        picked = []
    if not picked:
        # 词边界匹配：裸子串会把「文件名的子串」误挑——references/ 同时有
        # craft.md 与 t.md 时，散文提及 craft.md 会让 "t.md" in "...craft.md..."
        # 命中，错参考挤占 MAX_FILES 配额、挤掉本该入选的真资料
        for name in known:
            if re.search(r"(?<![A-Za-z0-9._-])" + re.escape(name) + r"(?![A-Za-z0-9_-])", raw) \
                    and name not in picked:
                picked.append(name)
    return picked[:MAX_FILES]


# ====== 读正文并按预算裁剪 ======

def _clip(text: str, budget: int) -> str:
    """裁到 budget 以内，尽量在完整小节或段落边界收尾。"""
    body = str(text or "")
    if len(body) <= budget:
        return body
    head = body[:budget]
    cut = head.rfind("\n## ")
    if cut < budget * 0.5:
        cut = head.rfind("\n\n")
    if cut < budget * 0.5:
        cut = budget
    return head[:cut].rstrip() + "\n\n（以下从略，已到本次节选上限）"


def compose(skill_id: str, names: Iterable[str], account: Any = None, max_chars: int = MAX_CHARS) -> str:
    """把挑中的文件读出来拼成 `<skill_refs>` 块。任何异常返回空串。"""
    folder = _ref_dir(skill_id, account)
    if folder is None:
        return ""
    picked = [str(name or "").strip() for name in (names or [])]
    picked = [name for name in picked if _SAFE_NAME.match(name)][:MAX_FILES]
    if not picked:
        return ""
    rows = {row["file"]: row["label"] for row in catalog(skill_id, account)}
    picked = [name for name in picked if name in rows]
    if not picked:
        return ""
    room = max(0, int(max_chars) - 300)  # 留头部与段落标题的位置
    per_file = max(MIN_PER_FILE, room // len(picked))
    chunks: List[str] = []
    used = 0
    for name in picked:
        path = folder / name
        try:
            # realpath 复核：防符号链接/奇怪文件名跳出 references/
            root = os.path.realpath(str(folder))
            if os.path.commonpath([root, os.path.realpath(str(path))]) != root:
                continue
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        left = max_chars - used
        if left <= 200:
            break
        piece = _clip(text, min(per_file, left))
        chunks.append(f"## {name}\n\n{piece}")
        used += len(piece)
    if not chunks:
        return ""
    head = (
        f'\n\n<skill_refs skill="{skill_id}" files="{",".join(picked)}">\n'
        "以下是这个技能的原始参考资料节选（英文原文）。它们是「怎么做」的细节，"
        "与上面的契约冲突时以上面的契约为准（本项目的产物形态、尺寸、依赖限制优先）。\n\n"
    )
    return head + "\n\n".join(chunks) + "\n</skill_refs>"
