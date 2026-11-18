#!/usr/bin/env python3
"""任务并行化 · 第 0 步量化（离线口径）

用法：
    python3 scripts/measure_task_queue.py                 # 全部账号
    python3 scripts/measure_task_queue.py --account default
    python3 scripts/measure_task_queue.py --json          # 机器可读

为什么要有这支脚本：`docs/任务并行化方案-v2-2026-11-18.md` §1 的第 0 步原本
要求「跑一轮真实任务 → 控制台贴 __wfLogs 片段」，只能拿到**当前这一轮**的数。
任务列表本身有服务端镜像（`data/users/<账号>/kv_store.json` 的 `tasks:global`），
每条任务带 createdAt / startedAt / endedAt，每颗节点也带起止时间戳——历史全量
都能算，比贴一次控制台更有代表性，而且零成本、可反复跑。

口径（与计划 §1 的 Q1/Q3/Q4/Q5 一一对应）：
  Q1 viz 占比      = 该任务里 viz 载体节点耗时之和 ÷ 任务墙钟
  Q3 并行度        = 该任务所有节点耗时之和 ÷ 任务墙钟（>1 才是真并行）
  Q4 同画布        = 排队对上那条任务与本条是否同一 sessionId
  Q5 排队时长      = startedAt − createdAt（只有「上一条还在跑时提交」才 > 0）
  Q2（viz 是否自动重试）与 Q6（并行下的额度争抢）**算不出来**——前者是浏览器
  控制台信号，后者要有并行实现后的对照跑，本脚本对这两项只打印占位说明。
"""
import argparse
import json
import statistics
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USERS_DIR = ROOT / "data" / "users"

VIZ_HINTS = ("可视化", "viz")


def _fmt(ms):
    if not ms:
        return "-"
    return datetime.fromtimestamp(ms / 1000).strftime("%m-%d %H:%M:%S")


def _load_tasks(account_dir):
    p = account_dir / "kv_store.json"
    if not p.exists():
        return []
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:  # 损坏的镜像不该挡住整体统计
        print(f"  ! {p} 解析失败：{exc}", file=sys.stderr)
        return []
    t = d.get("tasks:global")
    if not t:
        return []
    if isinstance(t, dict):
        t = t.get("tasks") or []
    return t if isinstance(t, list) else []


def _is_viz_label(label):
    s = str(label or "").lower()
    return any(h in s for h in VIZ_HINTS)


def analyse(tasks):
    rows = []
    for t in tasks:
        created = int(t.get("createdAt") or 0)
        started = int(t.get("startedAt") or 0)
        ended = int(t.get("endedAt") or 0)
        nodes = t.get("nodes") or []
        durs = []
        viz_dur = 0.0
        for n in nodes:
            ns, ne = int(n.get("startedAt") or 0), int(n.get("endedAt") or 0)
            if not ns or not ne or ne < ns:
                continue
            d = (ne - ns) / 1000.0
            durs.append(d)
            if _is_viz_label(n.get("label")):
                viz_dur += d
        wall = (ended - started) / 1000.0 if started and ended and ended >= started else None
        rows.append({
            "id": t.get("id"),
            "title": t.get("title") or "",
            "state": t.get("state") or "",
            "sessionId": t.get("sessionId") or "",
            "sessionTitle": t.get("sessionTitle") or "",
            "created": created,
            "started": started,
            "ended": ended,
            "delay": (started - created) / 1000.0 if created and started and started >= created else None,
            "wall": wall,
            "nodeSum": sum(durs),
            "nodeCount": len(durs),
            "viz": viz_dur if viz_dur else None,
            "par": (sum(durs) / wall) if wall and wall > 0 and durs else None,
            "vizShare": (viz_dur / wall) if wall and wall > 0 and viz_dur else None,
        })
    rows.sort(key=lambda r: r["created"] or 0)
    return rows


def _median(vals):
    vals = [v for v in vals if v is not None]
    return statistics.median(vals) if vals else None


def _p(v, nd=1):
    return "-" if v is None else f"{v:.{nd}f}"


def report(account, rows, as_json=False):
    if not rows:
        print(f"[{account}] 无任务记录")
        return None

    # Q5 / Q4：谁是在别人还在跑的时候提交的（真排队场景）
    busy_pairs = []
    for i, r in enumerate(rows):
        if not r["created"]:
            continue
        for prev in rows[:i]:
            if prev["started"] and prev["ended"] and prev["started"] <= r["created"] < prev["ended"]:
                busy_pairs.append({
                    "waiter": r,
                    "blocker": prev,
                    "sameSession": bool(r["sessionId"]) and r["sessionId"] == prev["sessionId"],
                    "wait": r["delay"],
                })
                break

    waits = [p["wait"] for p in busy_pairs if p["wait"] is not None]
    summary = {
        "account": account,
        "tasks": len(rows),
        "wallMedian": _median([r["wall"] for r in rows]),
        "parMedian": _median([r["par"] for r in rows]),
        "vizShareMedian": _median([r["vizShare"] for r in rows]),
        "vizTasks": sum(1 for r in rows if r["viz"]),
        "vizOnly": sum(1 for r in rows if r["viz"] and r["wall"] and abs(r["viz"] - r["wall"]) < 1),
        "queued": len(busy_pairs),
        "waitMedian": _median(waits),
        "waitMax": max(waits) if waits else None,
        "sameSessionQueued": sum(1 for p in busy_pairs if p["sameSession"]),
    }

    if as_json:
        print(json.dumps({"summary": summary, "rows": rows, "busyPairs": [
            {"waiter": p["waiter"]["id"], "blocker": p["blocker"]["id"],
             "sameSession": p["sameSession"], "wait": p["wait"]} for p in busy_pairs]},
            ensure_ascii=False, indent=1))
        return summary

    print(f"\n=== 账号 {account} · {len(rows)} 条任务 ===")
    print(f"{'创建':16} {'排队':>7} {'墙钟':>7} {'节点和':>8} {'并行度':>6} {'viz占比':>7}  状态     标题 / 画布")
    for r in rows:
        viz = f"{r['vizShare']*100:.0f}%" if r["vizShare"] else "-"
        print(f"{_fmt(r['created']):16} {_p(r['delay']):>7} {_p(r['wall']):>7} "
              f"{_p(r['nodeSum']):>8} {_p(r['par'], 2):>6} {viz:>7}  {r['state']:<8} "
              f"{(r['title'] or '')[:16]} / {(r['sessionTitle'] or '')[:12]}")

    print("\n--- 汇总 ---")
    print(f"任务数 {summary['tasks']} · 墙钟中位数 {_p(summary['wallMedian'])}s · "
          f"并行度中位数 {_p(summary['parMedian'], 2)} · viz 占比中位数 "
          f"{_p((summary['vizShareMedian'] or 0)*100, 0)}%（{summary['vizTasks']} 条含 viz，"
          f"其中 {summary['vizOnly']} 条 viz 独占整轮）")
    print(f"真排队场景 {summary['queued']} 次 · 其中同画布 {summary['sameSessionQueued']} 次 · "
          f"排队中位数 {_p(summary['waitMedian'])}s · 最长 {_p(summary['waitMax'])}s")
    if busy_pairs:
        print("  排队明细：")
        for p in busy_pairs:
            print(f"    {_fmt(p['waiter']['created'])} 提交 → 等 {_p(p['wait'])}s 才开跑"
                  f"（挡在前面的是 {p['blocker']['id']}，"
                  f"{'同画布' if p['sameSession'] else '不同画布'}）")
    print("Q2（viz 自动重试）/ Q6（并行额度争抢）本脚本算不出：Q2 看浏览器控制台 "
          "`Viz module automatic retry failed`，Q6 要有并行实现后的开关对照跑。")
    return summary


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--account", help="只统计某个账号目录名（默认全部）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    if not USERS_DIR.exists():
        sys.exit(f"未找到 {USERS_DIR}（请在项目根目录运行）")
    dirs = sorted(p for p in USERS_DIR.iterdir() if p.is_dir() and p.name not in ("_trash",))
    if args.account:
        dirs = [p for p in dirs if p.name == args.account]
        if not dirs:
            sys.exit(f"没有账号目录 {args.account}")

    all_summary = []
    for d in dirs:
        tasks = _load_tasks(d)
        if not tasks:
            continue
        s = report(d.name, analyse(tasks), as_json=args.json)
        if s:
            all_summary.append(s)

    if not args.json and len(all_summary) > 1:
        print("\n=== 跨账号合计 ===")
        tot = sum(s["tasks"] for s in all_summary)
        viz = sum(s["vizTasks"] for s in all_summary)
        q = sum(s["queued"] for s in all_summary)
        print(f"任务 {tot} 条 · 含 viz {viz} 条 · 真排队 {q} 次")
    if not all_summary:
        print("没有任何任务镜像（kv_store.json 的 tasks:global 为空）")


if __name__ == "__main__":
    main()
