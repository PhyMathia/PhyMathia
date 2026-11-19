#!/usr/bin/env python3
"""会话历史可读归档回填：把每个会话的「画布节点 + 聊天消息」写成
data/history/<账号>/<标题>-<sid后8>.md

背景（2026-11-19）：本机 53 个会话里只有 5 个有消息文件——但内容并没有全丢，
大部分以画布节点形式存在 data/users/<账号>/kv/<sid>.json（物理/数学视角、
交互可视化、追问卡）。本脚本按会话名单逐个生成可读时间线，让「历史在项目
文件夹里」变成看得见的事实。

用法：
  python3 scripts/backfill_history_archive.py                 # 全部账号
  python3 scripts/backfill_history_archive.py --account default
  python3 scripts/backfill_history_archive.py --dry-run       # 只打印计划

归档是派生副本：随时可删、可用本脚本重建，不参与任何读写决策。
"""

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))

from server import accounts, storage  # noqa: E402


def _load_messages(path: Path):
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, OSError):
        return []
    return data if isinstance(data, list) else []


def main() -> int:
    parser = argparse.ArgumentParser(description="把会话的画布节点与消息回填成可读 Markdown")
    parser.add_argument("--account", default="", help="只处理指定账号（默认全部）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划，不写文件")
    args = parser.parse_args()

    users_dir = Path(storage.config.DATA_DIR) / "users"
    if not users_dir.is_dir():
        print(f"没有找到 {users_dir}，先启动一次服务让目录生成。")
        return 1

    account_ids = [
        entry.name for entry in sorted(users_dir.iterdir())
        if entry.is_dir() and not entry.name.startswith("_")
        and (not args.account or entry.name == args.account)
    ]

    total_written = total_skip = 0
    for account in account_ids:
        paths = accounts.resolve_paths(account)
        sessions = storage._read_json(paths.sessions_path, {})
        if not isinstance(sessions, dict) or not sessions:
            print(f"== 账号 {account}：没有会话名单")
            continue
        written = skipped = 0
        for sid, meta in sessions.items():
            msgs = _load_messages(paths.messages_dir / f"{sid}.json")
            nodes = storage._graph_nodes(sid, account)
            if not msgs and not nodes:
                skipped += 1
                continue
            title = (meta or {}).get("title") if isinstance(meta, dict) else ""
            if args.dry_run:
                print(f"[计划] {account}/{sid} 《{title}》 节点 {len(nodes)} · 消息 {len(msgs)}")
            else:
                target = storage.write_message_archive(sid, msgs, account)
                if target:
                    print(f"[写入] {target.name}  节点 {len(nodes)} · 消息 {len(msgs)}")
                else:
                    skipped += 1
                    continue
            written += 1
        total_written += written
        total_skip += skipped
        print(f"== 账号 {account}：会话 {len(sessions)} 个，生成 {written} 个，跳过空会话 {skipped} 个")

    verb = "将生成" if args.dry_run else "已生成"
    print(f"\n汇总：{verb} {total_written} 个归档（跳过 {total_skip} 个空会话）")
    if args.dry_run:
        print("这是 dry-run，未落盘。去掉 --dry-run 再跑一次。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
