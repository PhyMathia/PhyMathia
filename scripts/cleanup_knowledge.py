#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""知识库存量清理：非知识条目 / 中文散文"公式" / 幽灵簇（只报不改）。

为什么需要它：标题卫生（knowledge._is_junk_knowledge_title / _looks_like_formula）
是 v4 起才有的闸门，闸门只能拦住**新**数据；库里已有的垃圾条目（如模型推理泄漏被
"提取"成的 40 字假标题 + 中文散文公式）会一直顺着 knowledge 流到知识面板、概念地基
与知识大陆投影——真机上一条这样的条目炸出了 4 条虚假共享概念。

用法:
  python3 scripts/cleanup_knowledge.py              # dry-run（只列，不写）
  python3 scripts/cleanup_knowledge.py --apply      # 落盘（先备份 .bak-<时间戳>）
  python3 scripts/cleanup_knowledge.py --data-dir data

清理口径（与运行时闸门同一把尺子，不另写一份）:
  1. 条目：`_is_junk_knowledge_title(title)` 且 source != manual → 删（手动条目永不碰）
  2. 公式：`_looks_like_formula` 不认的 → 从存活条目里剔除（条目保留）
  3. 幽灵簇：sessionId 不在 sessions.json 里 → **只报**（可能是刚清空的画布，
     删条目等于替用户做决定，要删请在知识面板里手动删）
"""

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# server.knowledge 会 import 仓库根的 http_client（httpx 客户端单例），两个路径都要在
for _p in (str(ROOT), str(ROOT / "src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from server.knowledge import (  # noqa: E402
    _dedupe_knowledge,
    _is_junk_knowledge_title,
    _looks_like_formula,
)


def _read(path: Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"！读取 {path} 失败：{exc}")
        return default


def _backup(path: Path) -> Path:
    stamp = time.strftime("%Y%m%d-%H%M%S")
    dest = path.with_suffix(path.suffix + f".bak-{stamp}")
    shutil.copy2(path, dest)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser(description="知识库存量清理（默认 dry-run）")
    ap.add_argument("--data-dir", default=str(ROOT / "data"), help="数据目录（默认 <repo>/data）")
    ap.add_argument("--apply", action="store_true", help="落盘写入（默认只列清单）")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    kpath, spath = data_dir / "knowledge.json", data_dir / "sessions.json"
    items = _dedupe_knowledge(_read(kpath, {}))
    sessions = _read(spath, {})

    removed, cleaned, ghosts = [], [], {}
    for item_id, item in items.items():
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "")
        if str(item.get("source") or "") != "manual" and _is_junk_knowledge_title(title):
            removed.append((item_id, title))
            continue
        bad = [f for f in (item.get("formulas") or []) if not _looks_like_formula(str(f))]
        if bad:
            cleaned.append((item_id, title, bad))
        sid = str(item.get("sessionId") or "")
        if sid and sid not in sessions and not str(sessions.get(sid, {}).get("title") or "").strip():
            ghosts.setdefault(sid, []).append(title)

    print(f"知识库：{kpath}")
    print(f"条目 {len(items)} 条｜待删 {len(removed)} 条｜待清公式 {sum(len(b) for _, _, b in cleaned)} 条")
    for item_id, title in removed:
        print(f"  ✕ 删除条目 {item_id}｜{title[:60]}")
    for item_id, title, bad in cleaned:
        print(f"  ~ 清公式 {item_id}｜{title[:40]}")
        for f in bad:
            print(f"      - {str(f)[:70]}")
    for sid, titles in ghosts.items():
        print(f"  ? 幽灵簇 {sid}（会话记录已不在，{len(titles)} 条，只报不删）：{titles[0][:30]}")

    if not removed and not cleaned:
        print("没有可清理的内容。")
        return 0
    if not args.apply:
        print("\ndry-run：未写入。加 --apply 落盘（会自动备份 .bak-<时间戳>）")
        return 0

    if kpath.exists():
        dest = _backup(kpath)
        print(f"已备份 → {dest.name}")
    for item_id, _, _ in cleaned:
        items[item_id]["formulas"] = [
            f for f in (items[item_id].get("formulas") or []) if _looks_like_formula(str(f))]
    for item_id, _ in removed:
        items.pop(item_id, None)
    kpath.write_text(json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"已写入：{len(items)} 条（删除 {len(removed)} 条 + 清理 {len(cleaned)} 条的脏公式）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
