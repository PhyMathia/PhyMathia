"""LLM token 用量与缓存命中计量（聊天主应用与 Φ 智能体的共享底层）。

上游 chat/completions 响应里的 usage 字段此前只写一行日志就丢弃——缓存
命中率无从谈起。本模块把每次调用的 usage 解析后追加落盘
data/usage/YYYY-MM-DD.jsonl，并提供按天/模型汇总（GET /api/usage/stats）。

缓存命中字段按各家兼容解析（取到哪个算哪个，全缺记 null）：
- DeepSeek: prompt_cache_hit_tokens
- OpenAI 系: prompt_tokens_details.cached_tokens
- Anthropic 式: cache_read_input_tokens（原生协议字段，个别兼容端点透传）

2026-10-08 补两维（结果可见性）：①失败调用也进账——record_failure 在各调用
点的错误出口（HTTP 非 200/连接异常/正文不可用）落 status=error 记录，token 数
为 null、error 存截断到 200 字符的原因，聚合进 errorRequests；②请求耗时——
成功与失败都带 durationMs（调用点用 elapsed_ms 从 monotonic 起点算），聚合出
avgDurationMs。旧记录没有 status/durationMs 字段，聚合按「成功、无耗时」兼容。

住进 server 包的理由：聊天主应用与 Φ 智能体（harness）两侧运行时都
import 得到 server 包（路径保证见 llm_common.py 头注）。
只依赖标准库；本模块不得 import 任何使用方。
"""

import json
import logging
import sys
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)


def _default_usage_dir() -> Path:
    # 与 src/server/config.py 的 DATA_DIR 同口径（仓库根 data/）：打包（frozen）
    # 时数据写到 exe 所在目录。2026-10-08 从 src/server/data/usage 拨回——T161
    # 收编模块时把目录带歪到包内，与全仓运行时数据约定相悖，且历史 JSONL 全在
    # 仓库根，包内目录只有搬家后的零星几天，统计会凭空缺历史。
    if getattr(sys, "frozen", False):
        root = Path(sys.executable).resolve().parent
    else:
        root = Path(__file__).resolve().parents[2]
    return root / "data" / "usage"


# 模块级属性、函数体内现取：测试 monkeypatch 此值即可换目录
USAGE_DIR = _default_usage_dir()

_APPEND_LOCK = threading.Lock()


def parse_usage(usage):
    """从上游 usage dict 提取 prompt/completion/缓存命中三个数，形状不符返回 None。"""
    if not isinstance(usage, dict):
        return None

    def _int(value):
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    hit = _int(usage.get("prompt_cache_hit_tokens"))
    if hit is None:
        details = usage.get("prompt_tokens_details")
        if isinstance(details, dict):
            hit = _int(details.get("cached_tokens"))
    if hit is None:
        hit = _int(usage.get("cache_read_input_tokens"))
    return {
        "prompt_tokens": _int(usage.get("prompt_tokens")),
        "completion_tokens": _int(usage.get("completion_tokens")),
        "cache_hit_tokens": hit,
    }


def _write_entry(entry):
    """JSONL 追加（当天一文件）；落盘失败只警告不抛——计量是旁路观测。"""
    try:
        usage_dir = USAGE_DIR
        usage_dir.mkdir(parents=True, exist_ok=True)
        path = usage_dir / f"{datetime.now():%Y-%m-%d}.jsonl"
        with _APPEND_LOCK:
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as e:
        logger.warning("usage_stats: 落盘失败（不影响主请求）: %s", e)
        return None
    return entry


def elapsed_ms(t0):
    """monotonic 起点 → 毫秒整数（耗时记账统一从这里取，负数截 0）。"""
    return max(0, int((time.monotonic() - t0) * 1000))


def _norm_duration(duration_ms):
    try:
        value = int(duration_ms)
    except (TypeError, ValueError):
        return None
    return value if value >= 0 else None


def record_usage(provider, model, kind, session_id, usage, duration_ms=None):
    """解析并追加一条成功用量记录；解析不出任何 token 数时静默跳过。

    返回写入的条目 dict（测试/调用方可用），未写入返回 None。
    计量是旁路观测：任何落盘失败只记警告，绝不影响主请求。
    """
    parsed = parse_usage(usage)
    if parsed is None or (parsed["prompt_tokens"] is None and parsed["completion_tokens"] is None):
        return None
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "kind": str(kind or ""),
        "provider": str(provider or ""),
        "model": str(model or ""),
        "sessionId": str(session_id or ""),
        "status": "ok",
        "durationMs": _norm_duration(duration_ms),
        **parsed,
    }
    return _write_entry(entry)


def record_failure(provider, model, kind, session_id, error, duration_ms=None):
    """失败调用也进账：HTTP 非 200/连接异常/正文不可用等落一条 status=error
    记录（token 数为 null，error 存截断到 200 字符的原因）。

    在调用方 except 链里被调用，自身绝不抛（写失败只警告），否则会顶掉原异常。
    """
    try:
        message = str(error).strip() if error is not None else ""
    except Exception:
        message = ""
    entry = {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "kind": str(kind or ""),
        "provider": str(provider or ""),
        "model": str(model or ""),
        "sessionId": str(session_id or ""),
        "status": "error",
        "durationMs": _norm_duration(duration_ms),
        "error": message[:200] or "unknown",
        "prompt_tokens": None,
        "completion_tokens": None,
        "cache_hit_tokens": None,
    }
    return _write_entry(entry)


def _agg_bucket():
    return {"requests": 0, "errorRequests": 0, "hitKnownRequests": 0,
            "promptTokens": 0, "completionTokens": 0, "totalTokens": 0,
            "cachedTokens": 0, "durationMsSum": 0, "durationKnown": 0}


def _agg_add(bucket, entry):
    bucket["requests"] += 1
    if entry.get("status") == "error":
        # 失败调用计次不计 token（旧记录无 status 字段＝成功，向后兼容）
        bucket["errorRequests"] += 1
    duration = entry.get("durationMs")
    if isinstance(duration, (int, float)) and duration >= 0:
        bucket["durationMsSum"] += int(duration)
        bucket["durationKnown"] += 1
    prompt = entry.get("prompt_tokens")
    completion = entry.get("completion_tokens")
    hit = entry.get("cache_hit_tokens")
    if prompt is not None:
        bucket["promptTokens"] += prompt
    if completion is not None:
        bucket["completionTokens"] += completion
    # 画图主数值：prompt+completion 合计（一侧缺失按 0 计，两个都缺仍是 0）
    bucket["totalTokens"] += (prompt or 0) + (completion or 0)
    if hit is not None:
        # 命中率只在「上游确实回报了命中字段」的请求上累计——不回报的
        # 供应商混进分母只会把命中率无声拉低，读数时以 hitKnownRequests 为准
        bucket["hitKnownRequests"] += 1
        bucket["cachedTokens"] += hit


def _agg_finalize(bucket):
    out = dict(bucket)
    out["hitRate"] = (round(bucket["cachedTokens"] / bucket["promptTokens"], 4)
                      if bucket["promptTokens"] else None)
    out["avgDurationMs"] = (round(bucket["durationMsSum"] / bucket["durationKnown"])
                            if bucket["durationKnown"] else None)
    return out


def summarize(days=30, records=0):
    """读最近 N 天的 JSONL，返回按天/按模型/按用途/总体的汇总。

    返回键：
    - days/models/total：既有三桶（requests/promptTokens/completionTokens/
      totalTokens/cachedTokens/hitRate/hitKnownRequests；requests 含失败调用，
      失败次数看 errorRequests、平均耗时看 avgDurationMs——只累计带了
      durationMs 的记录）
    - series：天×模型交叉表 {日期: {模型: 聚合桶}}——前端「每日趋势按模型
      分线」折线图的数据源
    - kinds：按用途（chat/extract/describe/docs/summary/harness…）聚合
      {用途: 聚合桶}——前端「用途分布」条形图的数据源
    - records：records>0 时附带范围内最近 N 条调用明细（时间倒序，上限
      500）——前端「最近调用」明细卡的数据源；旧记录无 status 按「成功」、
      无 durationMs 为 null（与聚合同一套兼容口径）
    """
    try:
        day_limit = max(1, min(365, int(days)))
    except (TypeError, ValueError):
        day_limit = 30
    try:
        # 上限 500 防调用方传超大值把响应撑爆；负数/垃圾值归 0（不带明细）
        record_limit = max(0, min(500, int(records)))
    except (TypeError, ValueError):
        record_limit = 0
    cutoff = (datetime.now() - timedelta(days=day_limit - 1)).strftime("%Y-%m-%d")
    by_day = {}
    by_model = {}
    by_kind = {}
    by_series = {}
    total = _agg_bucket()
    collected = []
    try:
        files = sorted(USAGE_DIR.glob("*.jsonl"))
    except OSError:
        files = []
    for path in files:
        day = path.stem
        if day < cutoff:
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(entry, dict):
                continue
            day_bucket = by_day.setdefault(day, _agg_bucket())
            model = str(entry.get("model") or "unknown")
            kind = str(entry.get("kind") or "unknown")
            model_bucket = by_model.setdefault(model, _agg_bucket())
            kind_bucket = by_kind.setdefault(kind, _agg_bucket())
            series_bucket = by_series.setdefault(day, {}).setdefault(model, _agg_bucket())
            for bucket in (day_bucket, model_bucket, kind_bucket, series_bucket, total):
                _agg_add(bucket, entry)
            if record_limit:
                collected.append(entry)
    record_items = []
    if record_limit:
        # JSONL 按日名升序读、行内按写入序，collected 即时间正序（ts 本就随
        # 追加单调）；取末尾 N 条再倒序＝最近 N 条、新的在前，同秒多条保持
        # 发生顺序——不另做 sorted，避免破坏落盘序的稳定性
        for entry in collected[-record_limit:][::-1]:
            prompt = entry.get("prompt_tokens")
            completion = entry.get("completion_tokens")
            record_items.append({
                "ts": entry.get("ts"),
                "kind": str(entry.get("kind") or ""),
                "provider": str(entry.get("provider") or ""),
                "model": str(entry.get("model") or ""),
                "status": entry.get("status") or "ok",
                "durationMs": entry.get("durationMs"),
                "promptTokens": prompt,
                "completionTokens": completion,
                "totalTokens": (prompt or 0) + (completion or 0),
                "error": entry.get("error"),
            })
    return {
        "days": {day: _agg_finalize(b) for day, b in sorted(by_day.items())},
        "models": {model: _agg_finalize(b) for model, b in sorted(by_model.items())},
        "kinds": {kind: _agg_finalize(b) for kind, b in sorted(by_kind.items())},
        "series": {day: {m: _agg_finalize(b) for m, b in models_of_day.items()}
                   for day, models_of_day in sorted(by_series.items())},
        "records": record_items,
        "total": _agg_finalize(total),
    }
