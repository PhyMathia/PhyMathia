#!/usr/bin/env python3
"""隐式画像 §10 有效性验证（只查不改）：data/profiles/*.json → 三判据量化报告。

口径事实源：docs/用户画像数学模型-2026-10-06.md §10（上线前判据）。
直接 import src/server/profile_implicit（复用其参数常量、decay2 与归一化，不重复实现数学）。
本脚本对画像数据零写入：不调 ensure_seeded / record_events，只读 JSON。

判据（§10）：
  ① BKT 校准度   账本答题事件按当时 p̂ 排序、实际对错做标签，池化 AUC + log-loss；
                 累计答题 <50 条直接判「样本不足」（§10.1：视为未达标）。
                 门槛：AUC ≥ 0.65 才允许难度全自动档，否则自动档只能 ±1 微调。
  ② 复习正确率带 到期复习事件的实测正确率应落在 [0.7, 0.85]（§10.2；
                 「到期」按 §3.3 条件 p̂ ≤ p*=0.7 判定）。
  ③ 兴趣稳定性   周间 π 的 L1 漂移 < 0.3（§10.3）。

与 §10 口径的已知简化（详见 docs/画像有效性验证-2026-10-06.md「口径偏差」节）：
  a) T177/T176 落地（2026-10-06）后：答题事件实时追加 *.eval.jsonl（append-only，
     含当时 pHat 与 Δt），本脚本**优先读 JSONL 走精确口径**（无反解、无近似）；
     账本反解（先反推更新前先验、再乘 2^(−Δt/h_当前)，h 用主题当前值近似历史值、
     窗口首条 Δt 不可得取上界）仅作为**无留痕文件设备**的旧数据兜底。
  b) 判据③周间 π 由 wAt 反向重建：t < wAt 的历史权重不可知，按当前值冻结（保守，
     低估「窗口内新增主题」造成的漂移）；已剪枝主题缺席（幸存者偏差）。

用法：python3 scripts/review_profile_eval.py [--profiles data/profiles] [--now <epoch>]
退出码恒 0（报告工具，不做门禁）。
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
for _p in (str(ROOT), str(ROOT / "src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from server import profile_implicit as pi  # noqa: E402

P_STAR = 0.7          # §3.3 到期阈值 p*
BAND_LO, BAND_HI = 0.7, 0.85   # §10.2 目标带
MIN_ANSWERS = 50      # §10.1 池化计算门槛
AUC_GATE = 0.65       # §10.1 难度全自动档门槛
L1_GATE = 0.3         # §10.3 周间漂移门槛
MIN_DUE = 10          # 判据②最低样本（§10 未给门槛，本脚本自设，宁缺勿滥）
WEEK_S = 7 * 86400.0


# ---- 反解 BKT 更新（p̂ 重建的第一步） ----

def _forward(p_old: float, x: int) -> float:
    """与 profile_implicit._apply_answer 完全一致的更新链（观测步＋学习步）。"""
    tilde = pi._bkt_posterior(p_old, x)
    return tilde + (1.0 - tilde) * pi.P_TRANSIT


def invert_answer_update(p_new: float, x: int) -> float:
    """由更新后 p 精确反推更新前先验 p（_bkt_posterior 与学习步均可逆）。

    p_new = tilde + (1-tilde)·P(T)  →  tilde = (p_new − P(T)) / (1 − P(T))
    x=1: tilde = p(1−S) / (p(1−S) + (1−p)G)   → p = tilde·G / ((1−S)(1−tilde) + tilde·G)
    x=0: tilde = p·S   / (p·S   + (1−p)(1−G)) → p = tilde(1−G) / (S(1−tilde) + tilde(1−G))
    """
    tilde = (p_new - pi.P_TRANSIT) / (1.0 - pi.P_TRANSIT)
    tilde = min(max(tilde, 0.0), 1.0)
    if x:
        den = (1.0 - pi.P_SLIP) * (1.0 - tilde) + tilde * pi.P_GUESS
        p_old = tilde * pi.P_GUESS / den if den > 0 else 0.0
    else:
        den = pi.P_SLIP * (1.0 - tilde) + tilde * (1.0 - pi.P_GUESS)
        p_old = tilde * (1.0 - pi.P_GUESS) / den if den > 0 else 0.0
    return min(max(p_old, 0.0), 1.0)


def _self_check_inversion() -> None:
    """反解自检：沿「先验 → 前向更新 → 反解 → 回到先验」做网格回程。

    注意 forward 的值域是 [P(T), 1]（学习步抬底），p_new < P(T) 不可达；
    账本里存的 p 恒为更新后值，必落在值域内，故回程方向才是要验的性质。
    失败即中止（BKT 参数或公式与实现不一致，评估结果不可信）。
    """
    for x in (0, 1):
        for i in range(101):
            p = i / 100.0
            if abs(invert_answer_update(_forward(p, x), x) - p) > 1e-9:
                raise SystemExit(f"反解自检失败：p={p} x={x}（BKT 参数或公式与实现不一致）")


# ---- 指标 ----

def pooled_auc(pairs) -> float | None:
    """池化 AUC（Mann-Whitney 秩和，并列取平均秩）。正或负类为空返回 None。"""
    pos = sum(1 for _p, x in pairs if x)
    neg = len(pairs) - pos
    if not pos or not neg:
        return None
    order = sorted(range(len(pairs)), key=lambda i: pairs[i][0])
    ranks = [0.0] * len(pairs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and pairs[order[j + 1]][0] == pairs[order[i]][0]:
            j += 1
        avg = (i + j) / 2.0 + 1.0  # 1 起平均秩
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    rank_pos = sum(r for r, (_p, x) in zip(ranks, pairs) if x)
    return (rank_pos - pos * (pos + 1) / 2.0) / (pos * neg)


def pooled_logloss(pairs) -> float | None:
    if not pairs:
        return None
    eps = 1e-6
    total = 0.0
    for p, x in pairs:
        q = min(max(p, eps), 1.0 - eps)
        total -= x * math.log(q) + (1 - x) * math.log(1.0 - q)
    return total / len(pairs)


# ---- 数据装载（只读） ----

def load_profiles(profiles_dir: Path):
    """返回 [(文件名, 原始 profile, 归一化 implicit 状态)]；无 implicit 键也给默认零态。"""
    rows = []
    for path in sorted(profiles_dir.glob("*.json")):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            print(f"  ! 跳过不可读文件 {path.name}: {e}")
            continue
        if not isinstance(raw, dict):
            continue
        state = pi.normalize_implicit(raw.get("implicit"))
        rows.append((path.name, raw, state))
    return rows


def kv_replayable_count(kv_path: Path) -> int:
    """上下文参考：kv 测验统计里可被 ensure_seeded 回放的答题条数（只读）。"""
    try:
        data = json.loads(kv_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0
    stats = data.get(pi.QUIZ_KV_KEY) if isinstance(data, dict) else None
    if not isinstance(stats, dict):
        return 0
    total = 0
    for key, item in stats.items():
        if key == "_meta" or not isinstance(item, dict):
            continue
        total += sum(1 for h in (item.get("history") or []) if isinstance(h, dict))
    return total


# ---- 答题 p̂ 重建（判据①②共用） ----

def load_eval_trace(profiles_dir: Path) -> dict:
    """T177 评估留痕：*.eval.jsonl → {画像文件 stem: [条目…]}（只读）。

    条目即 record_events 落盘的账本 answer 形状（type/at/x/p/pHat/dt?/topic），
    JSONL 里坏行保留为 None，由 reconstruct_answers 剔除并计数。
    """
    out = {}
    for path in sorted(profiles_dir.glob("*.eval.jsonl")):
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError as e:
            print(f"  ! 跳过不可读留痕文件 {path.name}: {e}")
            continue
        entries = []
        for ln in lines:
            ln = ln.strip()
            if not ln:
                continue
            try:
                e = json.loads(ln)
                entries.append(e if isinstance(e, dict) else None)
            except ValueError:
                entries.append(None)
        out[path.name[:-len(".eval.jsonl")]] = entries
    return out


def reconstruct_answers(profiles, profiles_dir: Path = None) -> tuple[list, list, int]:
    """答题事件 → [{p_hat, prior, x, gap, has_gap, where}]；(records, 反解异常, JSONL 设备数)。

    有 .eval.jsonl 留痕的设备走精确口径（T177：p̂/Δt 直接读，不反解不近似）；
    无留痕的设备走账本反解兜底：p̂ = 反解先验 · 2^(−Δt/h_当前)，Δt 用账本相邻答题
    时间差（精确），h 用主题当前值近似历史值；窗口首条 Δt 不可得，p̂ 退化为不衰减
    先验（上界）。反解回程超出舍入容差的条目剔除并计数。
    """
    traces = load_eval_trace(profiles_dir) if profiles_dir else {}
    records, bad, trace_devices = [], [], 0
    for fname, _raw, state in profiles:
        stem = fname[:-5] if fname.endswith(".json") else fname
        trace = traces.get(stem)
        if trace is not None:
            trace_devices += 1
            for e in trace:
                where = f"{fname}·{e.get('topic') or '?'}@{int(e.get('at') or 0)}" if e else f"{fname}(trace)坏行"
                if not e or "pHat" not in e:
                    bad.append(where)
                    continue
                try:
                    p_hat = float(e["pHat"])
                except (TypeError, ValueError):
                    bad.append(where)
                    continue
                if not (0.0 <= p_hat <= 1.0):
                    bad.append(where)
                    continue
                dt = e.get("dt")
                try:
                    has_gap = dt is not None and float(dt) > 0
                    gap = float(dt) if has_gap else 0.0
                except (TypeError, ValueError):
                    has_gap, gap = False, 0.0
                records.append({"p_hat": p_hat, "prior": None,
                                "x": 1 if e.get("x") else 0,
                                "gap": gap, "has_gap": has_gap, "where": where})
            continue
        for topic, t in (state.get("topics") or {}).items():
            answers = sorted(
                (e for e in (t.get("ledger") or [])
                 if e.get("type") == "answer" and "x" in e and "p" in e),
                key=lambda e: e.get("at") or 0.0)
            h_days = float(t.get("h") or pi.H0_DAYS)
            for idx, e in enumerate(answers):
                x = 1 if e.get("x") else 0
                p_new = float(e["p"])
                prior = invert_answer_update(p_new, x)
                # p 入账本时 round 到 3 位小数，反解回程允许 5.01e-4 容差
                if abs(_forward(prior, x) - p_new) > 5.01e-4:
                    bad.append(f"{fname}·{topic}@{e.get('at')}")
                    continue
                at = e.get("at") or 0.0
                gap, has_gap = 0.0, False
                if idx > 0:
                    gap = at - (answers[idx - 1].get("at") or 0.0)
                    has_gap = gap > 0
                p_hat = prior * pi.decay2(gap, h_days) if has_gap else prior
                records.append({"p_hat": p_hat, "prior": prior, "x": x,
                                "gap": gap, "has_gap": has_gap,
                                "where": f"{fname}·{topic}@{int(at)}"})
    return records, bad, trace_devices


# ---- 判据①：BKT 校准度 ----

def criterion1(records, bad) -> dict:
    n = len(records)
    out = {"n": n, "bad": bad, "auc": None, "logloss": None,
           "verdict": "", "gate": ""}
    if n < MIN_ANSWERS:
        out["verdict"] = f"样本不足（{n} < {MIN_ANSWERS}）→ 按 §10.1 视为未达标"
        out["gate"] = "难度自动档维持 ±1 微调（不允许全自动）"
        return out
    auc = pooled_auc([(r["p_hat"], r["x"]) for r in records])
    ll = pooled_logloss([(r["p_hat"], r["x"]) for r in records])
    out["auc"], out["logloss"] = auc, ll
    if auc is None:
        out["verdict"] = "正/负类缺失，AUC 无定义 → 视为未达标"
        out["gate"] = "难度自动档维持 ±1 微调（不允许全自动）"
        return out
    ok = auc >= AUC_GATE
    out["verdict"] = f"AUC={auc:.3f} {'≥' if ok else '<'} {AUC_GATE} → {'达标' if ok else '未达标'}；log-loss={ll:.3f}"
    out["gate"] = ("允许启用难度全自动档" if ok
                   else "难度自动档维持 ±1 微调（不允许全自动）")
    return out


# ---- 判据②：复习正确率带 ----

def criterion2(records) -> dict:
    """到期复习：p̂ ≤ p*=0.7（§3.3 到期条件，p̂ 含衰减重建）的实测正确率 ∈ [0.7, 0.85]。

    窗口首条答题 Δt 不可得（p̂ 为上界），不参与到期判定；账本是 8 条环形窗，
    更早的答题被挤出窗——真实到期集合只会更多，此处偏保守。
    """
    repeats = [r for r in records if r["has_gap"]]
    due = [r for r in repeats if r["p_hat"] <= P_STAR]
    out = {"n_repeat": len(repeats), "n_due": len(due), "rate": None,
           "rate_repeat": None, "verdict": "", "note": ""}
    if repeats:
        out["rate_repeat"] = sum(r["x"] for r in repeats) / len(repeats)
    if not due:
        out["verdict"] = "无到期复习事件 → 无法判定"
        return out
    rate = sum(r["x"] for r in due) / len(due)
    out["rate"] = rate
    if len(due) < MIN_DUE:
        out["verdict"] = (f"到期复习 {len(due)} 条（<{MIN_DUE}）正确率 {rate:.3f} "
                          f"仅供参考 → 样本不足，无法判定是否落在 [{BAND_LO:.2f}, {BAND_HI:.2f}]")
    else:
        in_band = BAND_LO <= rate <= BAND_HI
        out["verdict"] = (f"到期复习 {len(due)} 条正确率 {rate:.3f}，"
                          f"{'落在' if in_band else '漂出'}目标带 [{BAND_LO:.2f}, {BAND_HI:.2f}] → "
                          f"{'达标' if in_band else '未达标'}")
        if not in_band:
            out["note"] = ("持续偏低 → §10.2 建议调高 p*；持续偏高 → 调低"
                           if rate < BAND_LO else "持续偏高 → §10.2 建议调低 p*")
    return out


# ---- 判据③：兴趣分布稳定性 ----

def criterion3(profiles, now: float) -> dict:
    """周间 π L1 漂移：T1=now−14d 与 T2=now−7d 两张快照，wAt 反向重建。

    简化（文件头 b 条）：t < wAt 的历史权重不可知，按当前值冻结；
    已剪枝主题缺席。逐画像计算，全部 <0.3 才算达标（§10.3 是「画像级」判据）。
    """
    t2, t1 = now - WEEK_S, now - 2 * WEEK_S
    per_profile = []
    for fname, _raw, state in profiles:
        topics = {k: v for k, v in (state.get("topics") or {}).items() if isinstance(v, dict)}
        if not topics:
            per_profile.append({"file": fname, "l1": None, "n_topics": 0,
                                "n_fresh": 0, "verdict": "无主题 → 无法判定"})
            continue

        def w_at(t: float) -> dict:
            out = {}
            for name, tp in topics.items():
                w_now = float(tp.get("w") or 0.0)
                w_at_i = float(tp.get("wAt") or 0.0)
                out[name] = w_now * pi.decay2(t - w_at_i, pi.TAU_INTEREST_DAYS) \
                    if t >= w_at_i else w_now  # 早于末次触达：历史不可知，冻结在当前值
            return out

        w1, w2 = w_at(t1), w_at(t2)
        s1, s2 = sum(w1.values()), sum(w2.values())
        if s1 <= 0 or s2 <= 0:
            per_profile.append({"file": fname, "l1": None, "n_topics": len(topics),
                                "n_fresh": 0, "verdict": "权重全零 → 无法判定"})
            continue
        names = set(w1) | set(w2)
        l1 = sum(abs((w2.get(n, 0.0) / s2) - (w1.get(n, 0.0) / s1)) for n in names)
        n_fresh = sum(1 for tp in topics.values() if float(tp.get("wAt") or 0.0) > t1)
        ok = l1 < L1_GATE
        per_profile.append({
            "file": fname, "l1": l1, "n_topics": len(topics), "n_fresh": n_fresh,
            "verdict": f"L1={l1:.3f} {'<' if ok else '≥'} {L1_GATE} → {'达标' if ok else '未达标'}"
                       + (f"（{n_fresh} 个主题在窗口内活跃，其历史权重按当前值冻结近似）" if n_fresh else ""),
        })
    evaluated = [r for r in per_profile if r["l1"] is not None]
    if not evaluated:
        overall = "无法判定（没有任何画像有主题数据）"
    elif all(r["l1"] < L1_GATE for r in evaluated):
        overall = f"达标（{len(evaluated)} 份有数据画像全部 L1 < {L1_GATE}）"
    else:
        overall = f"未达标（{sum(1 for r in evaluated if r['l1'] >= L1_GATE)} 份画像 L1 ≥ {L1_GATE}）"
    return {"per_profile": per_profile, "overall": overall}


# ---- 输出 ----

def main() -> int:
    ap = argparse.ArgumentParser(description="隐式画像 §10 有效性验证（只查不改）")
    ap.add_argument("--profiles", default=str(ROOT / "data" / "profiles"))
    ap.add_argument("--now", type=float, default=time.time(),
                    help="评估基准时刻（epoch 秒），默认当前时间")
    args = ap.parse_args()

    _self_check_inversion()
    profiles = load_profiles(Path(args.profiles))
    kv_n = kv_replayable_count(ROOT / "data" / "kv_store.json")

    records, bad, n_trace = reconstruct_answers(profiles, Path(args.profiles))
    c1 = criterion1(records, bad)
    c2 = criterion2(records)
    c3 = criterion3(profiles, args.now)

    n_impl = sum(1 for _f, raw, _s in profiles if isinstance(raw.get("implicit"), dict))
    events = sum(int(s.get("events") or 0) for _f, _r, s in profiles)
    n_topics = sum(len(s.get("topics") or {}) for _f, _r, s in profiles)

    print("=" * 72)
    print("隐式画像 §10 有效性验证（上线前判据）——只查不改")
    print("口径事实源：docs/用户画像数学模型-2026-10-06.md §10")
    print(f"数据：{args.profiles}")
    print("-" * 72)
    print(f"画像文件 {len(profiles)} 份；含 implicit 状态 {n_impl} 份；"
          f"事件总数 {events}；主题总数 {n_topics}；"
          f"答题 p̂ 重建 {c1['n']} 条（JSONL 精确口径 {n_trace} 台设备、"
          f"账本反解兜底其余；Δt 可得 {c2['n_repeat']} 条、"
          f"反解/坏行剔除 {len(c1['bad'])} 条）；"
          f"kv 可回放答题 {kv_n} 条（ensure_seeded 回填上限参考）")
    print("-" * 72)
    print("判据表")
    a1 = "—" if c1["auc"] is None else f"{c1['auc']:.3f}"
    l1s = "—" if c1["logloss"] is None else f"{c1['logloss']:.3f}"
    r2 = "—" if c2["rate"] is None else f"{c2['rate']:.3f}"
    print(f"  ① BKT 校准度    AUC={a1}  log-loss={l1s}  样本={c1['n']}/{MIN_ANSWERS}"
          f"   → {c1['verdict']}")
    print(f"      门槛：AUC ≥ {AUC_GATE} 才允许难度全自动档，否则只能 ±1 微调")
    print(f"      门禁判定：{c1['gate']}")
    print(f"  ② 复习正确率带  到期复习={c2['n_due']} 条  正确率={r2}"
          f"（间隔复习全部 {c2['n_repeat']} 条，正确率="
          f"{'—' if c2['rate_repeat'] is None else format(c2['rate_repeat'], '.3f')}）")
    print(f"      目标带 [{BAND_LO:.2f}, {BAND_HI:.2f}]  → {c2['verdict']}")
    if c2["note"]:
        print(f"      {c2['note']}")
    l1_vals = [r["l1"] for r in c3["per_profile"] if r["l1"] is not None]
    l1_show = "—" if not l1_vals else ", ".join(f"{v:.3f}" for v in l1_vals)
    print(f"  ③ 兴趣稳定性    周间 π L1 漂移={l1_show}（门槛 < {L1_GATE}）")
    print(f"      → {c3['overall']}")
    print("-" * 72)
    print("结论（§10 判据全过才允许难度全自动档；当前逐条如下）")
    print(f"  ① {c1['gate']}")
    print(f"  ② {c2['verdict']}")
    print(f"  ③ {c3['overall']}")
    print("=" * 72)
    if c3["per_profile"]:
        print("判据③逐画像明细（L1 / 主题数 / 窗口内活跃主题数）")
        for r in c3["per_profile"]:
            lv = "—" if r["l1"] is None else f"{r['l1']:.3f}"
            print(f"  {r['file']}: L1={lv}  主题={r['n_topics']}  "
                  f"窗口内活跃={r['n_fresh']}  {r['verdict']}")
    if records:
        print("判据①样本明细（p̂ / 对错 / 位置；JSONL 条目 prior=—，反解条目 p̂=先验·衰减，首条无 Δt 为上界）")
        for r in sorted(records, key=lambda r: -r["p_hat"]):
            prior = "—" if r["prior"] is None else f"{r['prior']:.3f}"
            print(f"  p̂={r['p_hat']:.3f}  prior={prior}  x={r['x']}  {r['where']}")
    if c1["bad"]:
        print("判据①反解异常（超出舍入容差，已剔除；通常是 BKT 参数变更后旧账本未迁移）：")
        for b in c1["bad"]:
            print(f"  {b}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
