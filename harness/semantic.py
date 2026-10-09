"""Φ 语义检索层（优化新路径三，2026-10-09）。

把 src/server/embedding.py 的本地 ONNX 推理（continent/知识库在用，Φ 从未接）
接到 Φ 的检索链路上：字面 miss 时用 embedding 近邻补召回。三条使用线：
search_nodes 节点召回、search_knowledge/search_formulas 知识资产召回、
快照 user_recipes 名额按指令相关度重排（均由 review.py 调用，tools.py 只收
组装好的命中列表，保持纯函数）。

设计约束（docs/Φ智能体优化新路径-2026-10-09.md 路径三）：
- **字面优先、语义只补位**：调用方只在字面检索完全 miss 时来问；返回条数封顶、
  分数过门槛——向量质量差时最坏也只是几条带 semantic 标记的候选，绝不改变
  既有字面命中；
- **降级链**：server 包不可用（独立部署/测试桩）/ 模型目录缺失 / 推理失败 /
  PHYMATHIA_EMBEDDING=0 → 一律返回空（调用方行为与从前逐字一致，
  server.embedding 查空是正常路径，警告只打一次）；
- **索引缓存按账号分桶**（T190 教训：全局单桶会跨账号互相顶替），桶内按内容
  签名惰性建、签名变化整桶重建；文本向量本体走 server.embedding.gather_vectors
  的持久缓存（data/embedding_cache.json），重建时未变文本零推理。线程口径同
  review_kb._KB_CACHE：无锁（桶字段一次赋值整体替换）。

门槛与封顶的本机实测依据（Qwen3-Embedding int8，2026-10-09）：查询「电磁感应」
对「法拉第定律＋磁通量变化率正文」节点余弦 0.55–0.56，对导数/物理视角等噪声
节点 0.24–0.30、极限 0.40（最贴的噪声）——0.42 门槛在信号与噪声之间留出两侧
余量；改模型（PHYMATHIA_EMBEDDING_DIR 换 bge 系）后应重测调整。
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger("harness.semantic")

# server.embedding 缺席（独立部署/测试桩环境）→ 逐字降级，语义层整体关闭
try:
    from server.embedding import cosine, embed_texts, gather_vectors
except Exception:  # pragma: no cover - 独立部署路径，CI 里 server 始终可导入
    cosine = None
    embed_texts = None
    gather_vectors = None

SEMANTIC_MIN_SCORE = 0.42       # 召回分数门槛（见模块 docstring 的实测依据）
SEMANTIC_LIMIT = 5              # 单次召回条数封顶（永远排在字面命中之后且不占字面名额）
_SEMANTIC_MAX_NODES = 512       # 建索引的图规模上限：超过即语义关闭，字面路径不受影响
_NODE_TEXT_CLIP = 200           # 节点向量文本＝label＋正文前 N 字（与大陆摘要口径同级）
_RECIPE_MIN_SCORE = 0.45        # 配方重排的门槛更高：只有强相关才值得顶到最前
_RECIPE_PROMOTE = 8             # 相关度优先的名额上限（其余保序跟在后面）

# 进程内索引缓存：外层键＝账号 id，桶按内容签名失效（见模块 docstring）
_INDEX_CACHE: Dict[str, Dict[str, Any]] = {}


def _enabled() -> bool:
    return cosine is not None and embed_texts is not None and gather_vectors is not None


def _bucket(account: str) -> Dict[str, Any]:
    key = str(account or "default")
    bucket = _INDEX_CACHE.get(key)
    if bucket is None:
        bucket = {}
        _INDEX_CACHE[key] = bucket
    return bucket


def _sig(pairs: List[str]) -> str:
    return hashlib.sha1("\n".join(pairs).encode("utf-8")).hexdigest()


async def _vectors_for(bucket: Dict[str, Any], slot: str, sig: str,
                       texts: Dict[str, str]) -> Optional[Dict[str, List[float]]]:
    """签名命中直接复用；否则线程内重建（推理不阻塞事件循环，embed_texts docstring
    要求 asyncio.to_thread 包一层）。降级返回 None（不缓存死桶，模型装好后自动恢复）。"""
    cached = bucket.get(slot)
    if isinstance(cached, dict) and cached.get("sig") == sig:
        return cached.get("vectors") or {}
    # gather_vectors 返回 (向量字典, 是否有缓存增量) 二元组——只取向量部分
    gathered = await asyncio.to_thread(gather_vectors, texts)
    vectors = gathered[0] if isinstance(gathered, tuple) else gathered
    if not isinstance(vectors, dict) or not vectors:
        return None
    bucket[slot] = {"sig": sig, "vectors": vectors}
    return vectors


async def _query_vector(keyword: str) -> Optional[List[float]]:
    vecs = await asyncio.to_thread(embed_texts, [keyword])
    if isinstance(vecs, list) and vecs:
        return vecs[0]
    return None


def _rank(vectors: Dict[str, List[float]], query_vec: List[float],
          limit: int, min_score: float) -> List[tuple]:
    hits = []
    for key, vec in vectors.items():
        score = cosine(query_vec, vec)
        if score >= min_score:
            hits.append((key, round(score, 4)))
    hits.sort(key=lambda kv: kv[1], reverse=True)
    return hits[:limit]


def _node_text(node: Dict[str, Any]) -> str:
    label = str(node.get("label") or "").strip()
    content = str(node.get("content") or "").strip()[:_NODE_TEXT_CLIP]
    return (label + "\n" + content).strip() if content else label


async def semantic_node_recall(snapshot: Any, keyword: str, account: str = "default",
                               limit: int = SEMANTIC_LIMIT,
                               min_score: float = SEMANTIC_MIN_SCORE) -> List[Dict[str, Any]]:
    """节点语义召回：[{id,label,kind,score}] 按分降序；降级/无命中/图过大 → []。

    只在 search_nodes 字面完全 miss 时由调用方触发；返回条目由 tools.py 补上
    正文摘录并打 semantic 标记后进模型上下文。"""
    if not _enabled():
        return []
    keyword = str(keyword or "").strip()
    if not keyword or not isinstance(snapshot, dict):
        return []
    nodes = [
        n for n in (snapshot.get("nodes") or [])
        if isinstance(n, dict) and str(n.get("id") or "")
    ]
    if not nodes or len(nodes) > _SEMANTIC_MAX_NODES:
        return []
    texts = {str(n["id"]): _node_text(n) for n in nodes}
    texts = {k: v for k, v in texts.items() if v}
    if not texts:
        return []
    vectors = await _vectors_for(
        _bucket(account), "nodes",
        _sig([f"{k}|{v}" for k, v in sorted(texts.items())]), texts,
    )
    if not vectors:
        return []
    query_vec = await _query_vector(keyword)
    if not query_vec:
        return []
    by_id = {str(n["id"]): n for n in nodes}
    out = []
    for nid, score in _rank(vectors, query_vec, limit, min_score):
        node = by_id.get(nid) or {}
        out.append({
            "id": nid,
            "label": str(node.get("label") or ""),
            "kind": str(node.get("kind") or ""),
            "score": score,
        })
    return out


def _kb_item_text(kind: str, item: Dict[str, Any]) -> str:
    if kind == "formulas":
        concept = str(item.get("concept") or "").strip()
        meaning = str(item.get("meaning") or "").strip()[:_NODE_TEXT_CLIP]
        return (concept + "\n" + meaning).strip() if meaning else concept
    title = str(item.get("title") or "").strip()
    summary = str(item.get("summary") or "").strip()[:_NODE_TEXT_CLIP]
    return (title + "\n" + summary).strip() if summary else title


def _kb_item_key(kind: str, item: Dict[str, Any]) -> str:
    return str(item.get("id") or item.get("title") or item.get("concept")
               or item.get("latex") or "")


async def semantic_kb_recall(kind: str, kb: Any, keyword: str, account: str = "default",
                             limit: int = SEMANTIC_LIMIT,
                             min_score: float = SEMANTIC_MIN_SCORE) -> List[Dict[str, Any]]:
    """知识库/公式速查的语义召回：[{item,score}]（item＝原始条目，由 tools.py 按
    各自形状组装命中行）。降级/无命中 → []。与节点召回共用账号桶的不同 slot，
    签名基于条目 key 集合——文件变更（mtime 缓存换清单）即重建。"""
    if not _enabled() or kind not in ("knowledge", "formulas"):
        return []
    keyword = str(keyword or "").strip()
    if not keyword or not isinstance(kb, dict):
        return []
    items = [i for i in (kb.get(kind) or []) if isinstance(i, dict)]
    texts: Dict[str, str] = {}
    for idx, item in enumerate(items):
        text = _kb_item_text(kind, item)
        if text:
            texts[_kb_item_key(kind, item) or f"#{idx}"] = text
    if not texts:
        return []
    vectors = await _vectors_for(
        _bucket(account), "kb_" + kind,
        _sig(sorted(texts.keys())), texts,
    )
    if not vectors:
        return []
    query_vec = await _query_vector(keyword)
    if not query_vec:
        return []
    by_key = {}
    for idx, item in enumerate(items):
        by_key[_kb_item_key(kind, item) or f"#{idx}"] = item
    out = []
    for key, score in _rank(vectors, query_vec, limit, min_score):
        out.append({"item": by_key.get(key) or {}, "score": score})
    return out


async def rank_recipes_for_instruction(recipes: List[Any], instruction: str,
                                       account: str = "default",
                                       promote: int = _RECIPE_PROMOTE,
                                       min_score: float = _RECIPE_MIN_SCORE) -> Optional[List[Any]]:
    """快照 user_recipes 名额重排（路径三落点三）：与指令强相关的配方顶到最前，
    其余保序跟后。降级返回 None（调用方保持原顺序，与 T244 行为一致）。

    只在清单条数超过后端截断上限（core.py user_recipes[:32]）时才有重排意义，
    调用方负责门控；本函数只做排序，一次调用不发任何模型请求。"""
    if not _enabled():
        return None
    instruction = str(instruction or "").strip()
    if not instruction or not isinstance(recipes, list) or not recipes:
        return None
    texts: Dict[str, str] = {}
    for idx, recipe in enumerate(recipes):
        if not isinstance(recipe, dict):
            continue
        text = (str(recipe.get("name") or "").strip() + "\n"
                + str(recipe.get("desc") or "").strip()).strip()
        if text:
            texts[str(recipe.get("id") or f"#{idx}")] = text
    if not texts:
        return None
    vectors = await _vectors_for(
        _bucket(account), "recipes",
        _sig([f"{k}|{v}" for k, v in sorted(texts.items())]), texts,
    )
    if not vectors:
        return None
    query_vec = await _query_vector(instruction)
    if not query_vec:
        return None
    promoted = [key for key, _ in _rank(vectors, query_vec, promote, min_score)]
    if not promoted:
        return list(recipes)
    promoted_set = set(promoted)

    def _key_of(recipe: Any, idx: int) -> str:
        return str((recipe.get("id") if isinstance(recipe, dict) else "") or f"#{idx}")

    front = [r for i, r in enumerate(recipes) if _key_of(r, i) in promoted_set]
    rest = [r for i, r in enumerate(recipes) if _key_of(r, i) not in promoted_set]
    # 保序护栏：重排只挪位置不丢条目（丢条目＝静默改变配方视野，宁可放弃重排）
    if len(front) + len(rest) != len(recipes):
        return list(recipes)
    return front + rest
