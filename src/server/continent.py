"""大陆投影（大陆计划 v1 只读）：跨会话概念聚簇，知识大陆视图的数据源。

分层不变量（docs/大陆计划.md）：
1. **归属分层**：子图（各会话探索网）拥有簇内边，主图只拥有簇间关系——本模块
   是纯投影层，零写路径，主图数据可随时重算，不怕改坏；
2. **投影可重算**：只读 knowledge + sessions 推导，无模型调用、无 IO（调用方喂参）。

与 concept.py 的分工与复用：
- concept 管「这个话题的地基是什么」（喂 prompt），本模块管「跨会话的知识版图」（喂画布）；
- 同源检测直接复用其检测器：`_normalize_title` + 标题公共子串（极大公共子串，
  不是整串包含）、`_formula_tokens`（公式 token，经 `knowledge._formula_key`
  归一化——公式键只有一把，前端 `_normalizeFormulaLatex` 不做这层归一化）；
- 功能字过滤沿用 `_STOP_CHARS`（「的定义」这类碎片不是领域词）。

**查空是正常路径**：空库 / 单会话 / 零跨会话重叠时 `shared` 为空、聚簇照常返回，
调用方（前端）渲染「只有一个区域的大陆」而不是报错。宁可漏报不可误报：只报
出现在 ≥2 个会话里的共享概念，同会话内的词面重叠不算。
"""

import itertools
import time

from .concept import (
    _STOP_CHARS,
    _TITLE_RUN_MIN_CJK,
    _TITLE_RUN_MIN_LATIN,
    _formula_tokens,
    _normalize_title,
)

__all__ = ["build_continent"]

# 主图最多画多少条簇间连线：多了是毛线球，按强度取前 N
SHARED_CONCEPT_LIMIT = 24
# 投影节点字段上限（与 concept.py 的裁剪口径一致）
TITLE_MAX_CHARS = 40
FORMULA_PREVIEW_CHARS = 48

_WEAK_RUN_SCORE = 8.0     # 2 字弱证据（「振动」级）：能当边界证据，排位靠后
_STRONG_RUN_SCORE = 60.0  # ≥3 字实质重叠
_FORMULA_SCORE = 30.0     # 结构证据：跨会话共享公式 token
_FALLBACK_TITLE = "未命名画布"
_DELETED_TITLE = "已删除的画布"


def _session_title_index(sessions: dict) -> dict:
    """`sess_xxx` 与 `phymathia_xxx` 两种标识都能查到会话记录（knowledge 条目的
    sessionId 是 sess_xxx，与会话文件键同形，两种都收只是兜底）。"""
    index = {}
    for key, sess in (sessions or {}).items():
        if not isinstance(sess, dict):
            continue
        index[str(key)] = sess
        sid = str(sess.get("sessionId") or "")
        if sid:
            index[sid] = sess
    return index


def _clip(text: str, limit: int) -> str:
    s = str(text or "").strip()
    return s if len(s) <= limit else s[:limit] + "…"


def _item_row(item_id: str, item: dict) -> dict:
    formulas = item.get("formulas") or []
    preview = ""
    for f in formulas:
        if str(f or "").strip():
            preview = str(f)
            break
    return {
        "itemId": str(item_id),
        "title": _clip(item.get("title"), TITLE_MAX_CHARS),
        "formulaPreview": _clip(preview, FORMULA_PREVIEW_CHARS),
        "formulaCount": len(formulas),
        "category": str(item.get("category") or ""),
        "createdAt": item.get("createdAt") or 0,
    }


def _cluster_title(sid: str, title_index: dict, has_sessions: bool) -> str:
    sess = title_index.get(sid) or {}
    title = str(sess.get("title") or "").strip()
    if title:
        return title
    if sid and has_sessions and sid not in title_index:
        return _DELETED_TITLE
    return _FALLBACK_TITLE


def _cross_session_owners(owner_map: dict, item_session: dict) -> list:
    """owner_map 的值（条目集合）里挑出跨 ≥2 个会话的，返回 [(key, owners)]。"""
    out = []
    for key, owners in owner_map.items():
        sids = {item_session[iid] for iid in owners if iid in item_session}
        if len(sids) >= 2:
            out.append((key, owners, sids))
    return out


def _collapse_fragments(entries: list) -> list:
    """标题串收敛到极大公共子串：短串若被更长的串包含、且覆盖条目是其子集，
    就是碎片（「谐运动」⊂「简谐运动」），丢弃。"""
    entries = sorted(entries, key=lambda e: -len(e[0]))
    kept = []
    for label, owners, sids in entries:
        if any(label != other[0] and label in other[0] and owners <= other[1]
               for other in kept):
            continue
        kept.append((label, owners, sids))
    return kept


def _links_for(owners: set, item_session: dict, session_rank: dict) -> list:
    """共享概念在簇间怎么连线：每个会话取排序最前的条目作端点；会话对 ≤4 个时
    全连接，否则连成链（防一处共享炸出毛线球）。"""
    by_session = {}
    for iid in owners:
        by_session.setdefault(item_session[iid], []).append(iid)
    for sid in by_session:
        by_session[sid].sort(key=lambda iid: session_rank.get(iid, 0))
    sids = sorted(by_session, key=lambda s: session_rank.get(min(by_session[s]), 0))
    pairs = (itertools.combinations(sids, 2) if len(sids) <= 4
             else zip(sids, sids[1:]))
    return [{"from": by_session[a][0], "to": by_session[b][0],
             "fromSession": a, "toSession": b} for a, b in pairs]


def build_continent(items: dict, sessions: dict = None) -> dict:
    """从知识条目推导大陆投影。纯函数：无 IO、无模型调用、不修改入参。

    返回 {generatedAt, clusterCount, itemCount, orphans, clusters, shared}：
    - clusters: 每个有知识条目的会话一个簇，按会话最近更新排序；簇内条目按
      createdAt 升序（学习顺序）；
    - shared: 跨会话共享概念（kind=title 公共子串 / kind=formula 公式 token），
      按强度排序取前 SHARED_CONCEPT_LIMIT 条，每条带 links（簇间连线端点）。
    """
    title_index = _session_title_index(sessions)

    # ===== 聚簇：按条目 sessionId 分组（sessionId 为空的孤儿条目不入大陆） =====
    by_session = {}
    item_session = {}
    orphans = 0
    for item_id, item in (items or {}).items():
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        sid = str(item.get("sessionId") or "")
        if not title or not sid:
            orphans += 1
            continue
        iid = str(item_id)
        by_session.setdefault(sid, []).append(iid)
        item_session[iid] = sid

    # 簇排序：会话最近更新在前；条目排序：学习顺序（createdAt 升序）
    def _cluster_sort_key(sid):
        sess = title_index.get(sid) or {}
        return -(sess.get("updatedAt") or 0)

    clusters = []
    session_rank = {}  # itemId → 簇内序（共享连线端点取「每会话最前」用）
    for sid in sorted(by_session, key=_cluster_sort_key):
        iids = sorted(by_session[sid],
                      key=lambda i: ((items[i].get("createdAt") or 0), i))
        for rank, iid in enumerate(iids):
            session_rank[iid] = rank
        clusters.append({
            "sessionId": sid,
            "title": _cluster_title(sid, title_index, bool(sessions)),
            "itemCount": len(iids),
            "items": [_item_row(iid, items[iid]) for iid in iids],
        })

    # ===== 共享概念：倒排索引 → 只留跨 ≥2 会话的 =====
    all_items = [(iid, items[iid]) for sid in by_session for iid in by_session[sid]]

    run_owners = {}
    for iid, item in all_items:
        t = _normalize_title(item.get("title"))
        for size in range(_TITLE_RUN_MIN_CJK, len(t) + 1):
            for i in range(0, len(t) - size + 1):
                piece = t[i:i + size]
                if piece.isascii() and size < _TITLE_RUN_MIN_LATIN:
                    continue
                if any(ch in _STOP_CHARS for ch in piece):
                    continue
                run_owners.setdefault(piece, set()).add(iid)

    token_owners = {}
    for iid, item in all_items:
        for token in _formula_tokens(item):
            token_owners.setdefault(token, set()).add(iid)

    shared = []
    title_entries = _collapse_fragments(_cross_session_owners(run_owners, item_session))
    for label, owners, sids in title_entries:
        df = max(1, len(owners))
        score = (_STRONG_RUN_SCORE + 12.0 * len(label)) / df if len(label) >= 3 \
            else _WEAK_RUN_SCORE + len(sids)
        shared.append({"kind": "title", "label": label, "score": round(score, 2),
                       "sessions": sorted(sids),
                       "links": _links_for(owners, item_session, session_rank)})
    for token, owners, _sids in _cross_session_owners(token_owners, item_session):
        sids = {item_session[iid] for iid in owners}
        score = _FORMULA_SCORE * len(sids) + min(len(owners), 6)
        shared.append({"kind": "formula", "label": token, "score": round(score, 2),
                       "sessions": sorted(sids),
                       "links": _links_for(owners, item_session, session_rank)})

    shared.sort(key=lambda s: (-s["score"], s["label"]))
    shared = shared[:SHARED_CONCEPT_LIMIT]

    return {
        "generatedAt": int(time.time() * 1000),
        "clusterCount": len(clusters),
        "itemCount": sum(c["itemCount"] for c in clusters),
        "orphans": orphans,
        "clusters": clusters,
        "shared": shared,
    }
