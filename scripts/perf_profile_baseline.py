#!/usr/bin/env python3
"""画像/会话数据路径的分档性能基线（只测量，不优化）。

计划文档「建议优化 4」要求：频繁 JSON 全量读写、全局写锁、跨主题遍历和缓存
并发刷新先有数据量分档测量与明确目标，在此之前不下「性能瓶颈已证实」的结论。
本脚本产出这些数字；是否优化由数字说话。

用法（项目根目录）：
    python3 scripts/perf_profile_baseline.py            # 默认每档取中位数
    python3 scripts/perf_profile_baseline.py --repeat 7

数据全在临时目录，不读不写真实 data/；不联网。
"""

import argparse
import gc
import json
import os
import platform
import statistics
import sys
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT))          # http_client 等顶层模块在仓库根目录


def _isolate(tmp: Path):
    """把数据路径重定向到临时目录（与 tests 的 RouteTestBase 同口径）。"""
    from server import config, context, knowledge, profile, storage
    paths = {
        "DATA_DIR": tmp,
        "MESSAGES_DIR": tmp / "messages",
        "SESSIONS_PATH": tmp / "sessions.json",
        "KNOWLEDGE_PATH": tmp / "knowledge.json",
        "FORMULAS_PATH": tmp / "formulas.json",
        "KV_PATH": tmp / "kv_store.json",
        "PROFILES_DIR": tmp / "profiles",
    }
    for directory in ("MESSAGES_DIR", "PROFILES_DIR"):
        paths[directory].mkdir(parents=True, exist_ok=True)
    for name, value in paths.items():
        setattr(config, name, value)
        setattr(storage, name, value)
        for module in (context, knowledge, profile):
            if hasattr(module, name):
                setattr(module, name, value)
    return storage, profile, context, knowledge


def _timeit(fn, repeat):
    samples = []
    for _ in range(repeat):
        gc.collect()
        start = time.perf_counter()
        fn()
        samples.append((time.perf_counter() - start) * 1000)   # ms
    return statistics.median(samples), min(samples)


def seed_profile(profile, device_id, facts):
    ops = []
    for i in range(facts):
        category = "stage" if i == 0 else ("goal" if i == 1 else "weakness")
        fact = f"我是高二学生" if i == 0 else (f"目标：高考物理90分" if i == 1 else f"薄弱点{i}：公式变形与守恒条件")
        ops.append({"op": "new", "fact": fact, "category": category})
        if category not in ("stage", "goal"):
            ops.append({"op": "new", "fact": fact, "category": category})   # 两次陈述才固化
    if ops:
        profile.apply_profile_ops(device_id, ops, source="perf")


def seed_messages(storage, context, session_id, rounds):
    msgs = []
    for i in range(rounds):
        msgs.append({"role": "user", "content": f"第{i}轮问题：电磁感应的通量怎么算", "timestamp": i * 2})
        msgs.append({"role": "assistant", "content": f"第{i}轮回答：" + "推导与解释。" * 20, "timestamp": i * 2 + 1})
    storage._write_json(storage._get_messages_path(session_id), msgs)
    return msgs


def seed_knowledge(knowledge, storage, count):
    data = {}
    for i in range(count):
        key = f"知识点{i}"
        data[key] = {
            "title": key,
            "content": f"这是第{i}个知识点的内容摘要，涉及物理与数学的对应关系。" * 3,
            "sessionId": f"sess_{i % 5}",
            "source": "model" if i % 3 else "local",
            "summary": f"摘要{i}",
            "formulas": [f"F=ma_{i}"],
            "updatedAt": 1700000000 + i,
        }
    storage._write_json(storage.KNOWLEDGE_PATH, data)
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repeat", type=int, default=5, help="每档重复次数（取中位数）")
    args = parser.parse_args()

    with tempfile.TemporaryDirectory(prefix="phymathia-perf-") as td:
        tmp = Path(td)
        storage, profile, context, knowledge = _isolate(tmp)
        rows = []

        print(f"环境：python {platform.python_version()} / {platform.platform()}")
        print(f"CPU: {os.cpu_count()} 核；每档重复 {args.repeat} 次取中位数\n")

        # ---- 档 1：画像读写与注入组装 ----
        # 画像条目上限 MAX_FACTS=50（超出按保尾截断），因此档位取合法范围内的 10/30/50
        print("== 画像（profiles/*.json 全量读写 + 注入组装；上限 50 条）==")
        for facts in (10, 30, 50):
            device = f"perf_{facts}"
            seed_profile(profile, device, facts)
            size_kb = profile._profile_path(device).stat().st_size / 1024
            read_ms = _timeit(lambda: profile.get_profile(device), args.repeat)[0]
            ctx_ms = _timeit(lambda: profile.profile_context(device), args.repeat)[0]
            ops_ms = _timeit(lambda: profile.apply_profile_ops(
                device, [{"op": "new", "fact": "薄弱点补充：边界条件", "category": "weakness"}], source="perf"),
                args.repeat)[0]
            rows.append(("画像", f"{facts} 条", f"{size_kb:.1f} KB", f"{read_ms:.2f}", f"{ctx_ms:.2f}", f"{ops_ms:.2f}"))
            print(f"  facts={facts:>3}  文件 {size_kb:>6.1f} KB  读 {read_ms:>6.2f} ms  注入组装 {ctx_ms:>6.2f} ms  一次合并写 {ops_ms:>6.2f} ms")

        # ---- 档 2：会话上下文组装（消息遍历 + 预算收缩）----
        print("\n== 会话上下文（messages/*.json 遍历 + 分支隔离 + 预算）==")
        for rounds in (10, 50, 200):
            sid = f"sess_perf_{rounds}"
            seed_messages(storage, context, sid, rounds)
            size_kb = storage._get_messages_path(sid).stat().st_size / 1024
            build_ms = _timeit(lambda: context._load_session_context(sid, current_prompt="通量怎么算"), args.repeat)[0]
            rows.append(("会话上下文", f"{rounds} 轮", f"{size_kb:.1f} KB", f"{build_ms:.2f}", "-", "-"))
            print(f"  rounds={rounds:>3}  文件 {size_kb:>7.1f} KB  组装 {build_ms:>7.2f} ms")

        # ---- 档 3：知识库跨主题检索（概念地基匹配）----
        print("\n== 知识库（concept_context_text：全库遍历 + 标题/公式索引）==")
        for count in (10, 100, 1000):
            seed_knowledge(knowledge, storage, count)
            size_kb = storage.KNOWLEDGE_PATH.stat().st_size / 1024
            match_ms = _timeit(lambda: __import__("server.concept", fromlist=["x"]).concept_context_text(
                "电磁感应的通量怎么算", session_id="sess_perf_200"), args.repeat)[0]
            rows.append(("知识匹配", f"{count} 条", f"{size_kb:.1f} KB", f"{match_ms:.2f}", "-", "-"))
            print(f"  items={count:>4}  文件 {size_kb:>7.1f} KB  匹配 {match_ms:>7.2f} ms")

        # ---- 档 4：全局写锁下的并发写（8 线程 × 25 次）----
        print("\n== 全局写锁（storage._mutate_json，8 线程 × 25 次）==")
        device = "perf_lock"
        seed_profile(profile, device, 50)
        per_write, total = [], []

        def worker():
            for _ in range(25):
                start = time.perf_counter()
                profile.apply_profile_ops(device, [
                    {"op": "new", "fact": "薄弱点补充：边界条件", "category": "weakness"}], source="perf")
                per_write.append((time.perf_counter() - start) * 1000)

        for _ in range(args.repeat):
            threads = [threading.Thread(target=worker) for _ in range(8)]
            start = time.perf_counter()
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            total.append((time.perf_counter() - start) * 1000)
        per_write.sort()
        p95 = per_write[int(len(per_write) * 0.95) - 1]
        rows.append(("并发写锁", "8×25 次", "50 条画像", f"{statistics.median(per_write):.2f}", "-", "-"))
        print(f"  单次写 中位 {statistics.median(per_write):.2f} ms / p95 {p95:.2f} ms；"
              f"200 次总耗时 中位 {statistics.median(total):.0f} ms（吞吐 {200 / (statistics.median(total) / 1000):.0f} 次/秒）")

        # ---- 档 5：JSON 全量读写本身 ----
        print("\n== 纯 JSON 读写（kv_store.json 体积分档）==")
        for kb in (10, 100, 1000):
            payload = {f"key_{i}": {"value": "x" * 200} for i in range(kb * 1000 // 220)}
            path = tmp / f"kv_{kb}.json"
            storage._write_json(path, payload)
            real_kb = path.stat().st_size / 1024
            read_ms = _timeit(lambda: storage._read_json(path, {}), args.repeat)[0]
            write_ms = _timeit(lambda: storage._write_json(path, payload), args.repeat)[0]
            print(f"  体积 {real_kb:>7.1f} KB  读 {read_ms:>7.2f} ms  写 {write_ms:>7.2f} ms")

    print("\n（本脚本只产出数字：是否优化、优化目标多少，按计划文档要求以这些分档结果为准，")
    print("  并需先明确用户可感知的目标——例如单次回答的额外服务端耗时上限。）")


if __name__ == "__main__":
    main()
