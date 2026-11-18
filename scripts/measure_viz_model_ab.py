#!/usr/bin/env python3
"""viz 生成模型 A/B 基准（第 1 步改道用）

用法：
    python3 scripts/measure_viz_model_ab.py --models model_x,model_y [--runs 1] [--port 5050]
    python3 scripts/measure_viz_model_ab.py --list            # 列可测模型 id/名称

为什么：`docs/任务并行化方案-v2-2026-11-18.md` §2.0 改道——viz 独占整轮（16 条里 15 条），
单页墙钟中位数 379s，真杠杆是 html 槽选哪个模型，而不是改代码。本脚本用**应用自己的
代理端点**（`POST /api/models/chat`，与前端 `_requestVisualizationHtml` 同一条路）、
同一份提示词与同一份取材，逐个模型真跑一次，量首字延迟／总时长／产出完整度。

口径要点：
- 提示词与前端 `_buildVisualizationPrompt` 逐字对齐（只把 `getLevelPrompt()` 换成同义一句，
  对所有模型一致，不影响横向比较）。
- 密钥只从 `data/users/<账号>/auth.json` 的 `modelKeys` 读，只用于本机代理请求，**不打印**。
- 服务需在跑（`python3 src/main.py -p 5050`）；本脚本只发请求，不写任何应用数据。
"""
import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
USERS = ROOT / "data" / "users"

PROMPT_HEAD = (
    "你是 PhyMathia 的交互可视化生成器。请根据下面的物理数学学习内容，生成一个完整、独立、可交互的 HTML 可视化页面。\n"
    "只输出完整 HTML，不要输出任何解释、Markdown 代码块以外的文字；必须包含至少一个滑块或按钮等交互控件，并适配深色/浅色主题。\n"
    "页面内顶部必须用可见中文写出四段图说：\n"
    "**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n"
    "**怎么看这张图**：用 1. 2. 3. 编号说明观察步骤，每步写“操作 → 会看到什么”；\n"
    "**和公式的联系**：图中现象与公式如何互相印证；\n"
    "**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n"
    "每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n\n"
    "难度：大学物理（先用直觉再给公式）。"
)

# 与工作流重试通道同构的取材（question + analysis + upstream 摘要，截 12000 字）
SOURCE = (
    "问题：三相交流电路中，为什么星形连接时线电压是相电压的 √3 倍？\n\n"
    "分析：三相对称电源的三相电压幅值相同、相位互差 120°。星形连接时，线电压等于两相"
    "电压之差：u_AB = u_A − u_B。用相量看，两个等长矢量夹角 120°，其差矢量长度是 2·U_p·cos30° "
    "= √3·U_p，相位超前 u_A 30°。三个线电压同样互差 120°，仍是对称三相。线电流等于相电流。"
    "三角形连接时相反：线电压等于相电压，线电流是相电流的 √3 倍。\n\n"
    "上游要点：三相互补 → 瞬时功率恒定 → 转矩平稳；中性线在三相负载对称时无电流，"
    "不对称时承载不平衡电流。"
)


def load_models(account):
    models = json.loads((USERS / account / "models.json").read_text(encoding="utf-8"))
    keys = json.loads((USERS / account / "auth.json").read_text(encoding="utf-8"))
    key_by_id = keys.get("modelKeys") or {}
    out = []
    for m in models.get("userModels") or []:
        mid = m.get("id")
        out.append({
            "id": mid,
            "provider": m.get("provider") or "",
            "model": m.get("model") or "",
            "label": m.get("label") or "",
            "baseUrl": m.get("baseUrl") or "",
            "enabled": bool(m.get("enabled")),
            "api_key": key_by_id.get(mid) or "",
        })
    active = models.get("activeModels") or {}
    return out, active


def looks_complete(text):
    t = (text or "").strip()
    if len(t) < 100:
        return False
    if not re.search(r"<html[\s>]|<!doctype|<body[\s>]", t, re.I):
        return False
    return bool(re.search(r"</html>|</body>", t, re.I))


def run_one(entry, port, timeout, thinking=""):
    url = f"http://127.0.0.1:{port}/api/models/chat"
    body = {
        "messages": [{"role": "user", "content": PROMPT_HEAD + "\n\n" + SOURCE[:12000]}],
        "provider": entry["provider"],
        "api_key": entry["api_key"],
        "model": entry["model"],
        "base_url": entry["baseUrl"],
        "stream": True,
        "session_bucket": "phymathia-viz",
    }
    if thinking:
        # 与前端同口径：槽位档位原样传，后端 thinking_request_params 按供应商映射
        body["thinking"] = thinking
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time()
    ttft = None
    chunks = []
    err = ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    obj = json.loads(data)
                except Exception:
                    continue
                delta = ((obj.get("choices") or [{}])[0].get("delta") or {}).get("content")
                if delta:
                    if ttft is None:
                        ttft = time.time() - t0
                    chunks.append(delta)
    except urllib.error.HTTPError as e:
        err = f"HTTP {e.code}: {e.read()[:160].decode('utf-8', 'replace')}"
    except Exception as e:  # 超时/连接中断都记成失败，不让一轮挂掉整个基准
        err = f"{type(e).__name__}: {e}"
    total = time.time() - t0
    text = "".join(chunks)
    return {
        "id": entry["id"], "model": entry["model"], "provider": entry["provider"],
        "label": entry["label"], "ttft": ttft, "total": total, "thinking": thinking,
        "chars": len(text), "complete": looks_complete(text), "error": err,
        "preview": re.sub(r"\s+", " ", text[:120]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", help="逗号分隔的模型 id（见 --list）")
    ap.add_argument("--account", default="default")
    ap.add_argument("--port", type=int, default=5050)
    ap.add_argument("--timeout", type=int, default=1500)
    ap.add_argument("--runs", type=int, default=1, help="每个模型跑几次（同一模型多次取中位数）")
    ap.add_argument("--thinking", default="", help="思考档位（off/low/medium/high/max，空＝跟随模型默认）")
    ap.add_argument("--out", default="docs/日志/viz-model-ab.json")
    ap.add_argument("--list", action="store_true")
    args = ap.parse_args()

    models, active = load_models(args.account)
    if args.list:
        cur = active.get("html_model")
        for m in models:
            mark = " ←当前 html 槽" if m["id"] == cur else ""
            print(f"{m['id']:22} {'✓' if m['enabled'] else ' '} {m['provider']:12} {m['model']:42} {m['label'][:22]}{mark}")
        return

    if not args.models:
        sys.exit("要给 --models（逗号分隔），或用 --list 看可选项")
    want = [s.strip() for s in args.models.split(",") if s.strip()]
    picked = [m for mid in want for m in models if m["id"] == mid]
    missing = [mid for mid in want if not any(m["id"] == mid for m in picked)]
    if missing:
        sys.exit(f"找不到模型 id：{missing}")
    for m in picked:
        if not m["api_key"] and m["provider"] not in ("opencode", "opencode-go", "llama", "local"):
            print(f"! {m['model']} 没有本地密钥，跳过")
    picked = [m for m in picked if m["api_key"] or m["provider"] in ("opencode", "opencode-go", "llama", "local")]

    results = []
    for m in picked:
        for i in range(max(1, args.runs)):
            print(f"→ {m['model']}（{m['provider']}）thinking={args.thinking or '默认'} 第 {i+1} 次…", flush=True)
            r = run_one(m, args.port, args.timeout, args.thinking)
            results.append(r)
            status = "OK" if not r["error"] else "ERR"
            print(f"   {status} 首字 {r['ttft'] and round(r['ttft'],1)}s · "
                  f"总 {round(r['total'],1)}s · 产出 {r['chars']} 字 · 完整HTML {'是' if r['complete'] else '否'}"
                  + (f" · {r['error'][:80]}" if r["error"] else ""), flush=True)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    hist = []
    if out.exists():
        try:
            hist = json.loads(out.read_text(encoding="utf-8"))
        except Exception:
            hist = []
    hist.append({"ts": int(time.time()), "account": args.account, "runs": results})
    out.write_text(json.dumps(hist, ensure_ascii=False, indent=1), encoding="utf-8")

    print("\n--- 汇总 ---")
    for r in results:
        if r["error"]:
            print(f"{r['model']:40} 失败：{r['error'][:60]}")
        else:
            print(f"{r['model']:40} 首字 {r['ttft']:>6.1f}s · 总 {r['total']:>7.1f}s · "
                  f"{r['chars']:>6} 字 · {'完整' if r['complete'] else '不完整'}")
    print(f"\n结果已追加到 {out}")


if __name__ == "__main__":
    main()
