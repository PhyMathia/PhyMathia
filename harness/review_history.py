"""编辑历史渲染与模型摘要展示清洗。

自 review.py 拆出（2026-10-04，T163）。摘要触发与调用（预算常量、_summarize_history）
留在 review.py——tests 在模块对象上 monkeypatch 那些常量。
"""

import re

# 历史条数超过该值即触发压缩（保留最近 HISTORY_KEEP_RECENT 条原文）
HISTORY_KEEP_RECENT = 6
def _history_block(history) -> str:
    """多轮编辑历史：最近 HISTORY_KEEP_RECENT 条详细（含操作摘要），更早条目压缩为一行，控制上下文体积。

    T94：`role=="compact_summary"` 的条目（更早历史经一次模型摘要压缩而来）渲染成
    一条「[此前 N 轮对话已压缩] 摘要：…」，统一排在历史块头部（即使用例传入的位置
    不在开头），其余条目逻辑不变；编号沿用原枚举序号，摘要条目本身不占号。"""
    if not history:
        return ""
    lines = ["\n\n此前多轮编辑历史（最新在后）："]
    compact_notes: list = []
    recent_start = max(0, len(history) - HISTORY_KEEP_RECENT)
    for i, item in enumerate(history):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user")
        if role == "compact_summary":
            covered = item.get("covered")
            try:
                covered_n = int(covered or 0)
            except (TypeError, ValueError):
                covered_n = 0
            compact_notes.append(
                f"\n\n[此前 {covered_n} 轮对话已压缩] 摘要：{str(item.get('summary') or '')}"
            )
            continue
        if role == "user":
            text = str(item.get("instruction") or "")
            if i < recent_start:
                lines.append(f"{i + 1}. 用户：{text[:100]}")
            else:
                lines.append(f"{i + 1}. 用户：{text[:200]}")
        else:
            summary = str(item.get("summary") or "")
            if i < recent_start:
                lines.append(f"{i + 1}. 助手：{summary[:80]}")
            else:
                ops = item.get("operations") or []
                op_desc = "；".join(
                    f"{o.get('op')}({o.get('id') or o.get('temp_id') or o.get('label') or ''})"
                    for o in ops[:20]
                )
                lines.append(f"{i + 1}. 助手：{summary[:120]}" + (f"；操作：{op_desc[:300]}" if op_desc else ""))
    if compact_notes:
        # 摘要条目始终排历史块头部（紧跟标题行）
        lines[1:1] = compact_notes
    return "\n".join(lines)


def _clamp_display_summary(text, limit: int = 800) -> str:
    """纯文字兜底 summary 的展示截断：推理模型的长篇思考即使剥离后仍可能
    留下超长正文，面板只展示前 limit 字，避免“输出一大堆”刷屏。"""
    t = str(text or "").strip()
    if len(t) <= limit:
        return t
    return t[:limit].rstrip() + "……（模型输出过长，已截断显示）"


def _extract_summary_from_json_shell(text):
    """模型偶尔把整个 JSON 对象写进正文，且字符串内含未转义引号导致解析失败。
    此时按"纯文字回答"兜底时，剥掉 JSON 外壳只保留 summary 文本，避免用户看到原始 JSON。"""
    if not isinstance(text, str):
        return None
    cleaned = text.strip()
    if not cleaned.startswith("{") or '"summary"' not in cleaned:
        return None
    marker = '"operations"'
    prefix = cleaned[: cleaned.index(marker)] if marker in cleaned else cleaned
    m = re.search(r'"summary"\s*:\s*"', prefix)
    if not m:
        return None
    start = m.end()
    # 闭引号定位：正文含未转义引号是常态，靠「第一个引号」会截半句；summary
    # 与 operations 之间夹其他键（如 clarify/options）时，嵌套值的闭引号后面
    # 同样是「, "下一个键":」——光看尾巴形状分不出来。两轮择优（都从最后
    # 一个候选往回）：① 剩余是纯标点且提取值不含 JSON 结构痕迹（引号键、{、[）；
    # ② 剩余紧跟下一个键且提取值干净。两种形态都取到完整 summary（09-20 修复）
    candidates = []
    esc = False
    for i in range(start, len(prefix)):
        ch = prefix[i]
        if esc:
            esc = False
            continue
        if ch == "\\":
            esc = True
            continue
        if ch == '"':
            candidates.append(i)
    if not candidates:
        return None

    def _clean_value(pos):
        value = prefix[start:pos]
        return not re.search(r'[\[{]|"\s*:', value)

    end = candidates[-1]
    for pos in reversed(candidates):
        if re.match(r'^[\s,}\]]*$', prefix[pos + 1:]) and _clean_value(pos):
            end = pos
            break
    if end == candidates[-1] or not _clean_value(end):
        for pos in reversed(candidates):
            if re.match(r'^\s*,\s*"[^"\n]*"\s*:', prefix[pos + 1:]) and _clean_value(pos):
                end = pos
                break
    if end <= start:
        return None
    value = prefix[start:end].strip()
    if not value:
        return None
    return value.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t")
