"""LLM token 用量与缓存命中计量（聊天主应用与 Φ 智能体的共享底层）。

上游 chat/completions 响应里的 usage 字段此前只写一行日志就丢弃——缓存
命中率无从谈起。本模块把每次调用的 usage 解析后追加落盘
data/usage/YYYY-MM-DD.jsonl，并提供按天/模型汇总（GET /api/usage/stats）。

缓存命中字段按各家兼容解析（取到哪个算哪个，全缺记 null）：
- DeepSeek: prompt_cache_hit_tokens
- OpenAI 系: prompt_tokens_details.cached_tokens
- Anthropic 式: cache_read_input_tokens（原生协议字段，个别兼容端点透传）

与 llm_common.py 同层的理由：两侧运行时（src/main.py 与 harness/review.py）
都看得见项目根，而 src 不是包，harness 导不进 src.server.*。
只依赖标准库；本模块不得 import 任何使用方。
"""

import json
import logging
import sys
import threading
from datetime import datetime, timedelta
from pathlib import Path

logger = logging.getLogger(__name__)


def _default_usage_dir() -> Path:
    # 与 src/server/config.py 同口径：打包（frozen）时数据写到 exe 所在目录
    if getattr(sys, "frozen", False):
        root = Path(sys.executable).resolve().parent
    else:
        root = Path(__file__).resolve().parent
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


def record_usage(provider, model, kind, session_id, usage):
    """解析并追加一条用量记录；解析不出任何 token 数时静默跳过。

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
        **parsed,
    }
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


def _agg_bucket():
    return {"requests": 0, "hitKnownRequests": 0, "promptTokens": 0,
            "completionTokens": 0, "cachedTokens": 0}


def _agg_add(bucket, entry):
    bucket["requests"] += 1
    prompt = entry.get("prompt_tokens")
    completion = entry.get("completion_tokens")
    hit = entry.get("cache_hit_tokens")
    if prompt is not None:
        bucket["promptTokens"] += prompt
    if completion is not None:
        bucket["completionTokens"] += completion
    if hit is not None:
        # 命中率只在「上游确实回报了命中字段」的请求上累计——不回报的
        # 供应商混进分母只会把命中率无声拉低，读数时以 hitKnownRequests 为准
        bucket["hitKnownRequests"] += 1
        bucket["cachedTokens"] += hit


def _agg_finalize(bucket):
    out = dict(bucket)
    out["hitRate"] = (round(bucket["cachedTokens"] / bucket["promptTokens"], 4)
                      if bucket["promptTokens"] else None)
    return out


def summarize(days=30):
    """读最近 N 天的 JSONL，返回按天/按模型/总体的命中率汇总。"""
    try:
        day_limit = max(1, min(365, int(days)))
    except (TypeError, ValueError):
        day_limit = 30
    cutoff = (datetime.now() - timedelta(days=day_limit - 1)).strftime("%Y-%m-%d")
    by_day = {}
    by_model = {}
    total = _agg_bucket()
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
            model_bucket = by_model.setdefault(model, _agg_bucket())
            for bucket in (day_bucket, model_bucket, total):
                _agg_add(bucket, entry)
    return {
        "days": {day: _agg_finalize(b) for day, b in sorted(by_day.items())},
        "models": {model: _agg_finalize(b) for model, b in sorted(by_model.items())},
        "total": _agg_finalize(total),
    }
