#!/usr/bin/env python3
"""孤儿会话数据清理（大陆「已删除的画布」孤岛修复）：清掉指向已删除会话的残留数据。

「已删除的画布」= 知识点还在、但归属会话已从 data/sessions.json 消失——大陆投影
按知识点聚岛、按会话名单取岛名，名单里找不到就打这个标签。2026-09-23 真机取证：
8 个被删会话只完成了名单移除，留下 3 座孤岛（13 条知识点、57 条公式）+ 4 个消息
文件 + 3 个 KV 快照。删除接口已改为「先清资料、后删名单」并在 /api/knowledge 入口
加了孤儿拒收闸门，本脚本负责一次性清掉历史残留；以后再出现同类残留也可复跑。

清理范围（判定口径与大陆投影一致：sessionId 对不上 sessions.json 的键）：
  - data/knowledge.json  里 sessionId 非空且不在会话名单的条目
  - data/formulas.json   同上
  - data/messages/<sid>.json   文件名 sid 不在会话名单
  - data/kv/<sid>.json         同上（探索网快照，回填脚本的提取料）

用法：
  python3 scripts/clean_orphan_sessions.py            # 默认只打印计划（dry-run）
  python3 scripts/clean_orphan_sessions.py --apply    # 先备份到 data/backup/，再真删

建议在服务运行时也可安全执行：服务端 JSON 读取缓存按 mtime+size 失效，改动立即可见；
前端老页面的 localStorage 若还留着孤儿条目，定时同步推回时会被服务端孤儿闸门拒收。
"""

import argparse
import json
import os
import shutil
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def unwrap_items(data):
    """兼容旧版 {"items": {...}} 包装格式（与 storage._delete_by_session 同口径）。"""
    if isinstance(data, dict) and set(data.keys()) == {"items"} and isinstance(data.get("items"), dict):
        return data["items"], True
    return data, False


def collect_orphans():
    """扫描全部四类数据，返回 [(位置, 判定, 待删清单)]，不动任何文件。"""
    sessions = read_json(os.path.join(DATA, "sessions.json"), {})
    live = set(sessions.keys())
    plan = []

    for name in ("knowledge.json", "formulas.json"):
        path = os.path.join(DATA, name)
        raw = read_json(path, {})
        data, _ = unwrap_items(raw)
        dead = {k: v for k, v in data.items()
                if isinstance(v, dict) and v.get("sessionId")
                and str(v["sessionId"]) not in live}
        if dead:
            plan.append((path, "条目 sessionId 不在会话名单", dead))

    for subdir, label in (("messages", "消息文件"), ("kv", "KV 快照文件")):
        folder = os.path.join(DATA, subdir)
        if not os.path.isdir(folder):
            continue
        dead = []
        for name in sorted(os.listdir(folder)):
            if not name.endswith(".json"):
                continue
            sid = name[:-5]
            if sid and sid not in live:
                dead.append(os.path.join(folder, name))
        if dead:
            plan.append((folder, f"{label} sid 不在会话名单", dead))
    return plan


def backup(plan):
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(DATA, "backup", f"orphan-clean-{ts}")
    os.makedirs(dest, exist_ok=True)
    files = set()
    for path, _, dead in plan:
        if isinstance(dead, list):
            files.update(dead)              # 消息/KV：要删的就是这些文件
        elif os.path.isfile(path):
            files.add(path)                 # knowledge/formulas：整文件备份
    for f in files:
        shutil.copy2(f, os.path.join(dest, os.path.basename(f)))
    return dest


def main():
    ap = argparse.ArgumentParser(description="清理指向已删除会话的孤儿数据（大陆「已删除的画布」修复）")
    ap.add_argument("--apply", action="store_true", help="真删（默认 dry-run 只打印计划）；删前自动备份")
    args = ap.parse_args()

    plan = collect_orphans()
    if not plan:
        print("没有孤儿数据：所有知识点/公式/消息/KV 快照都归属现存会话。")
        return

    n_items = sum(len(v) for _, _, v in plan)
    print(f"发现 {n_items} 项孤儿数据：")
    for path, reason, dead in plan:
        if isinstance(dead, list):
            print(f"  {os.path.relpath(path, ROOT)}：{len(dead)} 个文件（{reason}）")
            for f in dead:
                print(f"    - {os.path.relpath(f, ROOT)}")
        else:
            print(f"  {os.path.relpath(path, ROOT)}：{len(dead)} 条（{reason}）")
            for k, v in dead.items():
                label = v.get("title") or v.get("concept") or v.get("latex") or ""
                print(f"    - {k}「{str(label)[:24]}」")

    if not args.apply:
        print("\n[dry-run] 未做任何修改。确认无误后加 --apply 执行（会先自动备份）。")
        return

    dest = backup(plan)
    print(f"\n已备份原文件到 {os.path.relpath(dest, ROOT)}")

    removed = 0
    for path, _, dead in plan:
        if isinstance(dead, list):
            for f in dead:
                os.unlink(f)
                removed += 1
            continue
        raw = read_json(path, {})
        data, wrapped = unwrap_items(raw)
        for k in dead:
            data.pop(k, None)
            removed += 1
        out = {"items": data} if wrapped else data
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)

    print(f"完成：清理 {removed} 项。刷新页面后大陆上不再有「已删除的画布」。")


if __name__ == "__main__":
    main()
