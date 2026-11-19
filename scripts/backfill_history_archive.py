#!/usr/bin/env python3
"""会话历史可读归档回填：data/users/<账号>/messages/*.json → data/history/<账号>/*.md

背景（2026-11-19）：浏览器 localStorage 的 phymathia_msgs_ 只是读取缓存
（session.js 只留最近 5 个会话），服务端消息文件才是权威副本；但本机实测
53 个会话里 48 个连消息文件都不存在。为了让「历史留在项目文件夹里」变成
看得见的事实，服务端从今天起在每次消息落盘后同步写一份 Markdown 归档，
本脚本负责把已经存在的消息文件一次性补齐。

用法：
  python3 scripts/backfill_history_archive.py                 # 全部账号
  python3 scripts/backfill_history_archive.py --account default
  python3 scripts/backfill_history_archive.py --dry-run       # 只打印计划

归档是派生副本：随时可删、可用本脚本重建，不参与任何读写决策。
"""

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from server import storage  # noqa: E402


def _load_messages(path: Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return None
    return data if isinstance(data, list) else None


def main() -> int:
    parser = argparse.ArgumentParser(description="把会话消息文件回填成可读 Markdown 归档")
    parser.add_argument("--account", default="", help="只处理指定账号（默认全部）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不写文件")
    args = parser.parse_args()

    users_dir = Path(storage.config.DATA_DIR) / "users"
    if not users_dir.is_dir():
        print(f"没有找到 {users_dir}，先启动一次服务让目录生成。")
        return 1

    accounts = []
    for entry in sorted(users_dir.iterdir()):
        if not entry.is_dir() or entry.name.startswith("_"):
            continue
        if args.account and entry.name != args.account:
            continue
        accounts.append(entry.name)

    total_files = total_written = total_empty = 0
    for account in accounts:
        msg_dir = users_dir / account / "messages"
        if not msg_dir.is_dir():
            continue
        files = sorted(msg_dir.glob("*.json"))
        written = 0
        for path in files:
            msgs = _load_messages(path)
            if not msgs:
                total_empty += 1
                continue
            total_files += 1
            target = None
            if not args.dry_run:
                target = storage.write_message_archive(path.stem, msgs, account)
            written += 1
            if args.dry_run:
                print(f"[计划] {account}/{path.name} → {len(msgs)} 条")
            else:
                print(f"[写入] {account}/{path.name} → {target.name if target else '（跳过）'}")
        total_written += written
        print(f"== 账号 {account}：消息文件 {len(files)} 个，可归档 {written} 个")

    verb = "将写入" if args.dry_run else "已写入"
    print(f"\n汇总：{verb} {total_written} 个归档（跳过空/损坏 {total_empty} 个）")
    if args.dry_run:
        print("这是 dry-run，未落盘。去掉 --dry-run 再跑一次。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
