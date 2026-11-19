#!/usr/bin/env python3
"""把浏览器里残留的会话消息导入服务端，并生成可读归档。

背景：浏览器 localStorage 的 phymathia_msgs_ 是 LRU 缓存（只留最近 5 个会话），
被挤掉且服务端没有消息文件的会话＝永久丢失。这个脚本用于抢救「浏览器里还在」
的那部分：导入后服务端有权威副本，data/history/ 下也有可读 Markdown。

第一步（浏览器 DevTools → Console，跑完内容已复制到剪贴板）：
    copy(JSON.stringify(Object.fromEntries(
      Object.keys(localStorage).filter(k=>k.startsWith('phymathia_msgs_'))
        .map(k=>[k.slice(16), JSON.parse(localStorage.getItem(k))]))))

第二步：把剪贴板粘进一个文本文件（例如项目根下 browser_msgs.json），然后：
    python3 scripts/import_browser_messages.py browser_msgs.json
    python3 scripts/import_browser_messages.py browser_msgs.json --account default
    python3 scripts/import_browser_messages.py browser_msgs.json --dry-run

合并口径：与服务端现有消息按 timestamp 身份并集合并——两边各自独有的都保留、
字段互补，不覆盖、不删除。空数组跳过。
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from server import context, storage  # noqa: E402


def _normalize_key(key: str) -> str:
    key = (key or "").strip()
    if key.startswith("phymathia_msgs_"):
        key = key[len("phymathia_msgs_"):]
    return key


def main() -> int:
    parser = argparse.ArgumentParser(description="导入浏览器导出的会话消息并生成归档")
    parser.add_argument("dump", help="浏览器导出的 JSON 文件（{会话ID: [消息...]}）")
    parser.add_argument("--account", default="default", help="导入到哪个账号（默认 default）")
    parser.add_argument("--dry-run", action="store_true", help="只统计，不写盘")
    args = parser.parse_args()

    dump_path = Path(args.dump)
    if not dump_path.is_file():
        print(f"找不到文件：{dump_path}")
        return 1
    try:
        raw = json.loads(dump_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        print(f"不是合法 JSON：{e}")
        return 1
    if not isinstance(raw, dict):
        print("格式不对：顶层应是 {会话ID: [消息...]}")
        return 1

    imported = skipped = failed = 0
    for raw_key, msgs in raw.items():
        sid = _normalize_key(raw_key)
        if not sid or not isinstance(msgs, list) or not msgs:
            skipped += 1
            continue
        try:
            path = storage._get_messages_path(sid, args.account)
        except ValueError:
            print(f"[跳过] 非法会话 ID：{sid}")
            failed += 1
            continue

        existing = storage._read_json(path, [])
        existing = existing if isinstance(existing, list) else []
        merged = context.merge_message_lists(existing, msgs)
        added = len(merged) - len(existing)
        print(f"[{sid}] 浏览器 {len(msgs)} 条 / 服务端原有 {len(existing)} 条 → 合并 {len(merged)} 条（新增 {added}）")
        if args.dry_run:
            imported += 1
            continue
        try:
            storage._write_json(path, merged)
            archive = storage.write_message_archive(sid, merged, args.account)
            if archive:
                print(f"    归档：{archive}")
            imported += 1
        except OSError as e:
            print(f"[失败] {sid}: {e}")
            failed += 1

    verb = "可导入" if args.dry_run else "已导入"
    print(f"\n汇总：{verb} {imported} 个会话，跳过空/非法 {skipped} 个，失败 {failed} 个")
    if args.dry_run:
        print("这是 dry-run，未落盘。去掉 --dry-run 再跑一次。")
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(main())
