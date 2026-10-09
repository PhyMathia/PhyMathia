"""知识内容路由（T163 自 main.py 收编）：知识库/公式速查/知识提取、
探索网大陆与概念族投影、utopia 收件箱、文档解析。

GET 协商缓存（T147）的 _json_get_cache 住本模块；AI 提取与公式描述 worker
（_ai_extract_knowledge/_describe_formulas）经 knowledge 模块属性调用——
tests 打在 server.knowledge 上的补丁因此对 extract 与 describe 全部生效。
"""

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from . import accounts, continent, context, documents, embedding, family, knowledge, profile, storage
from .config import UPLOAD_MAX_BYTES, UTOPIA_INBOX_DIR
from .documents import (
    _ai_extract_document_knowledge,
    _extract_document_text,
    _local_extract_document_knowledge,
    _read_upload,
    _sanitize_filename,
    _save_upload,
)
from .knowledge import (
    _add_formulas_from_items,
    _dedupe_formula_map,
    _dedupe_knowledge,
    _extract_summary,
    _formula_key,
    _is_acceptable_knowledge_item,
    _looks_like_formula,
    _looks_like_reasoning_leak,
    _local_extract_knowledge,
    _normalize_formula,
    _normalize_knowledge,
)
from .context import _is_socratic_followup
from .llm_common import resolve_api_key
from .request_ctx import _account_id, _account_paths, _parse_json_object
from .storage import _mutate_json, _read_json

logger = logging.getLogger(__name__)

router = APIRouter()


# T147：GET /api/knowledge、/api/formulas 的缓存协商——前端 15 秒轮询此前每轮
# 全量重算去重＋全表传输，库越大越卡。按文件指纹（mtime_ns+size）缓存「去重后
# 的响应体＋ETag」：文件没变免重算，If-None-Match 命中回 304 免传输。
# 写路径（POST/DELETE）改文件即改指纹，缓存自然失效，无需主动清。
_json_get_cache: dict = {}
_JSON_GET_CACHE_MAX = 64  # 含 q 搜索变体（键带 q），超限整体清掉防膨胀


def _json_get_payload(path, transform, cache_key=None):
    """→ (body_str, etag)。指纹命中时免 transform 重算（去重/归一化是每轮大头）。"""
    try:
        st = os.stat(path)
        fp = (st.st_mtime_ns, st.st_size)
    except OSError:
        fp = None
    key = cache_key or str(path)
    hit = _json_get_cache.get(key)
    if fp is not None and hit and hit[0] == fp:
        return hit[1], hit[2]
    if len(_json_get_cache) >= _JSON_GET_CACHE_MAX:
        _json_get_cache.clear()
    payload = transform(_read_json(path, {}))
    body = json.dumps(payload, ensure_ascii=False)
    etag = '"' + hashlib.md5(body.encode("utf-8")).hexdigest() + '"'
    if fp is not None:
        _json_get_cache[key] = (fp, body, etag)
    return body, etag


def _json_get_response(request: Request, path, transform, cache_key=None):
    body, etag = _json_get_payload(path, transform, cache_key)
    inm = request.headers.get("if-none-match") or ""
    if inm and etag in inm:
        return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "no-cache"})
    # Cache-Control: no-cache = 可存但每次必须带 ETag 回源验证——15 秒轮询从此
    # 拿 304 空响应，浏览器沿用本地副本
    return Response(content=body, media_type="application/json",
                    headers={"ETag": etag, "Cache-Control": "no-cache"})


@router.get("/api/knowledge")
async def api_get_knowledge(request: Request = None):
    paths = _account_paths(request)
    if request is None:
        # 直调兼容（脚本/回归子进程直接 await 端点函数）：回原始 dict，不过 HTTP 层
        return _dedupe_knowledge(_read_json(paths.knowledge_path, {}))
    return _json_get_response(request, paths.knowledge_path, _dedupe_knowledge)


def _card_vector_text(item: dict) -> str:
    """向量证据的卡片文本：标题 + 真摘要（summarySource=local 的模板文案是空串——
    v5.3 口径，「xxx相关公式：xxx」式模板只会污染语义）。"""
    title = str((item or {}).get("title") or "").strip()
    src = str(item.get("summarySource") or "local")
    summary = str(item.get("summary") or "").strip() if src in ("model", "manual") else ""
    text = f"{title}\n{summary[:embedding._CACHE_SUMMARY_CLIP]}" if summary else title
    return text.strip()


def _continent_vectors(items: dict, accepted_families: list):
    """向量证据的一次性准备（v10 从 _continent_card_sims 抽出共用）：
    → (卡片×族中心的余弦表, 卡片向量表)。

    同步函数，路由里 asyncio.to_thread 包住跑（模型加载 1-3 秒 + 批推理，不能阻塞
    事件循环）。向量全部来自 embedding.gather_vectors 的本地缓存，缺模型/缺依赖/
    推理失败返回 ({}, {})——投影与建议都自动退回纯词面口径。
    """
    texts = {}
    for iid, item in (items or {}).items():
        if isinstance(item, dict):
            t = _card_vector_text(item)
            if t:
                texts[str(iid)] = t
    # 族文本直接以「规范名/术语原文」为键（family_centroid_vectors 按原文查找；
    # 与卡片标题撞键无害——同文本同向量）
    fam_texts = {}
    for fam in (accepted_families or []):
        canonical = str(fam.get("canonical") or "").strip()
        if not canonical:
            continue
        fam_texts[canonical] = canonical
        for term in (fam.get("terms") or []):
            t = str(term).strip()
            if t:
                fam_texts[t] = t
    vecs, _ = embedding.gather_vectors({**texts, **fam_texts})
    if not vecs:
        return {}, {}
    fam_vecs = embedding.family_centroid_vectors(accepted_families, vecs)
    if not fam_vecs:
        return {}, {}
    sims = {}
    for iid, vec in vecs.items():
        if iid in texts:
            row = {d: embedding.cosine(vec, fv) for d, fv in fam_vecs.items()}
            if row:
                sims[iid] = row
    card_vecs = {iid: vecs[iid] for iid in sims}  # 只回有相似度行的卡（聚类用）
    return sims, card_vecs


def _continent_card_sims(items: dict, accepted_families: list):
    """卡片 × 概念族中心的向量相似度（v9 海域层第五路证据的数据来源）。

    v10 起是 `_continent_vectors` 的投影专用薄壳：族中心缺席时返回 ({}, False)，
    与旧版两个失败分支的行为逐字一致。
    """
    sims, _ = _continent_vectors(items, accepted_families)
    return sims, bool(sims)


@router.get("/api/continent")
async def api_get_continent(request: Request = None):
    """大陆投影（v1 只读 + v2 簇间边）：跨会话概念聚簇 + 共享概念 + 用户连线。

    聚簇与共享概念纯本地推导（无 AI 网关调用）；用户簇间边是主图自有数据
    （KV `continent_edges`，经 /api/kv 读写），在此合入并按当前投影校验出
    悬空边。子图（knowledge + sessions）仍是聚簇的唯一事实源，随时可重算。
    v9 向量证据：本地 embedding 模型给「卡片 × 族中心」算余弦（data/embedding_cache.json
    缓存，只算新文本），词面认不出的卡也能被路由进正确海域；缺模型自动降级，
    投影退回纯词面口径。向量只进 domain* 字段（门控只路由不证明）。
    """
    paths = _account_paths(request)
    items = _dedupe_knowledge(_read_json(paths.knowledge_path, {}))
    sessions = _read_json(paths.sessions_path, {})
    # 合并视图：主文件 + data/kv/ 会话文件（用户连线/概念族等 KV 自有数据可能已拆分）
    kv = storage.kv_all_data(paths.account)
    user_edges = kv.get("continent_edges")
    # v6 概念族：内置表 + KV 自有扩展（用户/Φ 确认过的汇聚结果，与簇间边同级的主图数据）
    user_families = kv.get("continent_families")
    # v7.1b 门控产物：Φ 批量打标（只读离线产物，版本不符整批忽略——打开大陆仍是纯本地现算）
    gate = kv.get("continent_gate")
    # v9 向量证据：族中心锚点与 build_continent 内部同一份合并口径（同名族 KV 覆盖内置）
    accepted = family.merge_families(family.BUILTIN_FAMILIES,
                                     family.families_from_payload(user_families))
    card_sims, _ = await asyncio.to_thread(_continent_card_sims, items, accepted)
    # T207：build_continent 本体（跨会话聚簇＋布局推导，纯本地 CPU）此前只包了向量
    # 准备、本体留在事件循环里同步跑——开一次图就占住整个循环若干秒，期间其他请求
    # 全部排队。这里一并挪出，与 card_sims 同口径。
    return await asyncio.to_thread(continent.build_continent, items, sessions,
                                   user_edges, user_families, gate, card_sims=card_sims)


@router.get("/api/families")
async def api_get_families(request: Request = None):
    """概念族表合并视图（v8 族表编辑界面用）：内置表 + KV `continent_families` 覆盖。

    只读；增删改走既有 KV 通道（POST /api/kv/continent_families，同名覆盖内置）。
    """
    return family.families_view(storage.kv_all_data(_account_id(request)).get("continent_families"))


@router.get("/api/families/suggestions")
async def api_get_family_suggestions(request: Request = None):
    """v10 语义找亲（只读）：向量给族表查漏 + 新族候选，族表弹层渲染。

    两类候选按构造不相交（补词管「气味指向已有族」的卡，新族候选管「哪个族都
    不像但彼此抱团」的卡）：suggestions=补词条建议（泊松岛配方），clusters=无主
    抱团簇（四步方案第 1 步，起名在前端点「让 Φ 起名」才调模型——触发不自动）。
    **机器不自动落笔**：建议只是读侧产物，收下/建族走既有 KV 通道
    （POST /api/kv/continent_families），拒绝/命名缓存落 KV
    `continent_family_suggestions`。向量通道缺席（缺模型/缺依赖/开关关）→
    两类候选整体为空——查空是正常路径，与投影降级同一立场。
    """
    paths = _account_paths(request)
    items = _dedupe_knowledge(_read_json(paths.knowledge_path, {}))
    kv = storage.kv_all_data(paths.account)
    accepted = family.merge_families(family.BUILTIN_FAMILIES,
                                     family.families_from_payload(kv.get("continent_families")))
    card_sims, card_vecs = await asyncio.to_thread(_continent_vectors, items, accepted)
    if not card_sims:
        return {"suggestions": [], "clusters": [], "embedEnabled": False}
    state = kv.get("continent_family_suggestions")
    rejected = state.get("rejected") if isinstance(state, dict) else None
    suggestions = await asyncio.to_thread(
        continent.family_term_suggestions, items, accepted, card_sims, rejected)
    clusters = await asyncio.to_thread(
        continent.family_cluster_suggestions, items, accepted, card_sims, card_vecs)
    return {"suggestions": suggestions, "clusters": clusters, "embedEnabled": True}


# 双击 .pmu 的桌面启动器（scripts/utopia_opener/）把文件复制进 data/utopia_inbox/，
# 查看器（viewer.html?from=inbox&id=<名>）经此只读取回。写入不在 HTTP 面：唯一的
# 投递方式是本机启动器的文件复制，杜绝任意写。
_UtopiaInboxNameRe = re.compile(r'^[A-Za-z0-9_.-]{1,80}$')


@router.get("/api/utopia/inbox/{name}")
async def api_utopia_inbox_get(name: str):
    if not _UtopiaInboxNameRe.match(name) or not name.lower().endswith((".pmu", ".json")):
        raise HTTPException(status_code=422, detail="非法的快照文件名")
    path = UTOPIA_INBOX_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="收件箱里没有这个快照")
    return Response(content=path.read_text(encoding="utf-8"), media_type="application/json")


@router.post("/api/knowledge")
async def api_save_knowledge(request: Request):
    payload = await _parse_json_object(request)

    incoming = _normalize_knowledge(payload)
    # 入库闸门：非知识条目（「用户要求：…」这类指令句回显 / 整句标题）拒收。浏览器会把
    # localStorage 里本地独有的知识点并集推回服务端，入口拒收才保证清掉的垃圾不会被
    # 另一个标签页推回来（手动条目豁免，见 _is_acceptable_knowledge_item）。
    rejected = [k for k, v in incoming.items() if not _is_acceptable_knowledge_item(v)]
    for key in rejected:
        incoming.pop(key, None)
    if rejected:
        logger.info(f"Ingest gate rejected {len(rejected)} non-knowledge items")

    # 孤儿拒收：指向不存在会话的条目一律拒收（空 sessionId 的旧数据放行）。
    # 删除会话后 localStorage 里的残留条目会被前端定时同步推回（本端点是纯合并，
    # 推回即复活），没有这道闸门「已删除的画布」岛删了又复活——与上面的入库
    # 闸门同一条「删得掉」保证。正常链路都是先建会话后写知识，不受影响。
    # T201：sessions.json 读取挪 to_thread（本端点被前端定时同步反复调用）。
    sessions_raw = await asyncio.to_thread(
        _read_json, _account_paths(request, payload).sessions_path, {})
    known_sessions = set(sessions_raw.keys()) if isinstance(sessions_raw, dict) else set()
    orphaned = [k for k, v in incoming.items()
                if isinstance(v, dict) and v.get("sessionId")
                and str(v["sessionId"]) not in known_sessions]
    for key in orphaned:
        incoming.pop(key, None)
    if orphaned:
        logger.info(f"Ingest gate rejected {len(orphaned)} orphan-session items")

    def updater(data):
        normalized = _normalize_knowledge(data)
        # 隐式画像：只对「本轮真正新增」的 id 记 extract 事件——前端定时同步会
        # 反复全量推送，按 id 差分才不会每次同步都给兴趣加一次权重
        new_keys = [k for k in incoming if k not in normalized]
        merged = dict(normalized)
        merged.update(incoming)
        merged = _dedupe_knowledge(merged)
        new_items.extend(incoming[k] for k in new_keys)
        # T202：合并结果与库存一致就不写盘（对照消息保存的短路）。库存本就是
        # 本管线（归一化+去重）的产物、两步对已收敛数据幂等，前端定时同步的
        # 稳态全量推送在此逐字节收敛；此前的「恒 return data」让本端点每轮
        # 同步都全库重写+全库去重一遍（路由内旧注释自述的痛点）。
        if merged == data:
            return None
        return merged

    new_items = []
    account = _account_id(request, payload)
    # T201：读并+合并+去重+写盘挪 to_thread，同步推送高峰不再卡流式下发
    data = await asyncio.to_thread(
        _mutate_json, accounts.resolve_paths(account).knowledge_path, updater)
    _device_id = str(payload.get("device_id") or payload.get("deviceId") or "")
    if _device_id and new_items:
        events = [{"type": "extract",
                   "topic": str(it.get("topic") or it.get("concept") or "")[:60]}
                  for it in new_items if isinstance(it, dict)]
        profile.record_implicit_event(_device_id, events, account=account)
    return {"ok": True, "count": len(data)}


@router.delete("/api/knowledge/{item_id}")
async def api_delete_knowledge(item_id: str, request: Request = None):
    def updater(data):
        data = _normalize_knowledge(data)
        data.pop(item_id, None)
        return data

    _mutate_json(_account_paths(request).knowledge_path, updater)
    return {"ok": True}



@router.get("/api/formulas")
async def api_get_formulas(request: Request = None, q: str = ""):
    # 只读视图：去重不回写。GET 内写文件与并发 POST 存在「读→去重→覆盖」竞态，
    # 会把窗口期内新增的公式回滚丢失；物理去重改在 POST 写入路径执行。
    # T147：整表与搜索结果都走 ETag 缓存协商（缓存键带 q，互不串）。

    def _formula_payload(raw: dict) -> dict:
        data = _dedupe_formula_map(raw)
        items = list(data.values())
        if q:
            ql = q.lower()
            items = [it for it in items if
                     ql in (it.get("concept") or "").lower() or
                     ql in (it.get("meaning") or "").lower() or
                     ql in (it.get("topic") or "").lower() or
                     ql in (it.get("latex") or "").lower() or
                     any(ql in (t or "").lower() for t in (it.get("related") or []))]
        items.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
        return {"items": items, "count": len(items)}

    paths = _account_paths(request)
    if request is None:
        # 直调兼容（脚本/回归子进程直接 await 端点函数）：回原始 dict，不过 HTTP 层
        return _formula_payload(_read_json(paths.formulas_path, {}))
    return _json_get_response(request, paths.formulas_path, _formula_payload,
                              cache_key=f"{paths.formulas_path}::q={q}")


@router.post("/api/formulas")
async def api_save_formulas(request: Request):
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    items = payload if isinstance(payload, list) else payload.get("items", [])
    if not isinstance(items, list) or any(not isinstance(it, dict) for it in items):
        # 逐项 it.get 前先挡掉契约外形状（dict/字符串进来就是 500）
        raise HTTPException(status_code=400, detail="'items' must be a list of objects")
    count = 0

    def updater(data):
        nonlocal count
        # 写入时物理去重（原挂在 GET 里的清理逻辑挪到这里）
        data = _dedupe_formula_map(data)
        for it in items:
            latex = _normalize_formula(it.get("latex") or "")
            if not latex or not _looks_like_formula(latex):
                continue
            # 去重（T146 起全局）：同公式跨会话并进同一条，归属写 sessionIds
            existing = next((v for v in data.values()
                             if _formula_key(v.get("latex")) == _formula_key(latex)), None)
            if existing:
                # 本地快速提取先入库，后续 AI 结果可以补充更完整的说明。
                changed = False
                incoming_source = str(it.get("meaningSource") or "local")
                existing_source = str(existing.get("meaningSource") or "local")
                incoming_meaning = (it.get("meaning") or "").strip()
                if incoming_meaning and (
                    incoming_source == "model" or existing_source != "model"
                ):
                    existing["meaning"] = incoming_meaning[:200]
                    existing["meaningSource"] = incoming_source
                    changed = True
                for key in ("concept", "topic", "related", "messageId", "moduleKey", "nodeId"):
                    value = it.get(key)
                    if value and not existing.get(key):
                        existing[key] = value
                        changed = True
                # T146：并入本次会话归属（若尚不是它的归属之一）
                it_sid = str(it.get("sessionId") or "")
                if it_sid and it_sid != existing.get("sessionId") \
                        and it_sid not in (existing.get("sessionIds") or []):
                    merged_sids = [str(existing.get("sessionId") or "")] + \
                        [str(s or "") for s in (existing.get("sessionIds") or [])] + [it_sid]
                    sid_seen, ordered_sids = set(), []
                    for sid in merged_sids:
                        if sid and sid not in sid_seen:
                            sid_seen.add(sid)
                            ordered_sids.append(sid)
                    existing["sessionIds"] = ordered_sids
                    changed = True
                if changed:
                    count += 1
                continue
            fid = str(it.get("id") or "") or ("f_" + uuid.uuid4().hex[:12])
            data[fid] = {
                "id": fid,
                "latex": latex,
                "concept": (it.get("concept") or "")[:80],
                "meaning": (it.get("meaning") or "")[:200],
                "meaningSource": it.get("meaningSource") or "local",
                "topic": (it.get("topic") or "")[:60],
                "related": [str(t) for t in (it.get("related") or [])][:8],
                "sessionId": it.get("sessionId", ""),
                "messageId": it.get("messageId", ""),
                "moduleKey": it.get("moduleKey", ""),
                "nodeId": it.get("nodeId", ""),
                "createdAt": it.get("createdAt") or int(time.time() * 1000),
            }
            count += 1
        return data if count else None

    _mutate_json(_account_paths(request, payload).formulas_path, updater)
    return {"ok": True, "count": count}


@router.delete("/api/formulas")
async def api_delete_formulas_by_session(session_id: str = "", request: Request = None):
    """按会话删除公式（session_id 为空时删除全部）。

    request 形参不可省——函数体要拿它解析账号域（P1 参数化时漏改签名，
    2026-10-07 真机实操抓出：删画布的公式清理自那时起一直 500 静默失败）。
    """
    removed = 0

    def updater(data):
        nonlocal removed
        if session_id:
            removed = [k for k, v in data.items() if v.get("sessionId") == session_id]
            for k in removed:
                data.pop(k, None)
        else:
            removed = list(data.keys())
            data.clear()
        return data if removed else None

    _mutate_json(_account_paths(request).formulas_path, updater)
    return {"ok": True, "count": len(removed)}


@router.delete("/api/formulas/{formula_id}")
async def api_delete_formula(formula_id: str, request: Request = None):
    def updater(data):
        data.pop(formula_id, None)
        return data

    _mutate_json(_account_paths(request).formulas_path, updater)
    return {"ok": True}



@router.post("/api/extract_knowledge")
async def api_extract_knowledge(request: Request):
    """从对话中提取知识点（优先 AI，失败或无模型时本地正则兜底），并自动入库公式"""
    payload = await _parse_json_object(request)

    messages = payload.get("messages", [])
    if not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
        # 下方按角色/内容逐条取字段，契约外形状直接 400
        raise HTTPException(status_code=400, detail="'messages' must be a list of message objects")
    account = _account_id(request, payload)
    session_id = payload.get("sessionId", "")
    provider = payload.get("provider", "")
    api_key = payload.get("api_key", "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model = payload.get("model", "")
    base_url = payload.get("base_url", "")
    level = payload.get("level", "university")

    latest_assistant = next((m for m in reversed(messages) if m.get("role") == "assistant"), None)
    if latest_assistant and (
        _is_socratic_followup(latest_assistant.get("content", ""))
        or latest_assistant.get("branchType") in ("followup", "confused", "socratic")
    ):
        # 分支守卫：追问/没看懂/苏格拉底不做知识提取，但这是可靠的兴趣/风格信号——
        # 记一条隐式画像事件（主题按用户分支问题文本归题）再返回
        _branch_device = payload.get("device_id") or payload.get("deviceId") or ""
        if _branch_device:
            _branch_user = next((m.get("content") for m in reversed(messages)
                                 if m.get("role") == "user"), "")
            _branch_type = {"confused": "confused", "socratic": "socratic"}.get(
                latest_assistant.get("branchType"), "followup")
            profile.record_implicit_event(_branch_device, [{
                "type": _branch_type,
                "topic": profile.assign_topic(str(_branch_user or "")[:500], account=account),
            }], account=account)
        return {"items": []}
    # 推理泄漏闸门（先于 AI/本地两条路径）：正文其实是模型的思维链时，本轮不做提取。
    # 否则「用户要求：…」这类假标题 + 系统提示词回显的假公式会进库，并顺着
    # knowledge 流到知识面板、概念地基与大陆投影（实测四条虚假共享概念由此而来）。
    if latest_assistant and _looks_like_reasoning_leak(latest_assistant.get("content", "")):
        logger.info(f"Skip knowledge extraction: reasoning leak in assistant content for session {session_id}")
        return {"items": []}
    # 公式描述模型（前端传入，可选；未配置时回退默认摘要）
    desc_provider = payload.get("descriptor_provider", "")
    desc_api_key = payload.get("descriptor_api_key", "")
    desc_model = payload.get("descriptor_model", "")
    desc_base_url = payload.get("descriptor_base_url", "")
    desc_api_key, desc_env_used = resolve_api_key(desc_provider, desc_api_key)

    items = []
    profile_facts = []
    profile_ops = []
    # 搭车画像采集：把既有画像摘要带给提取模型，模型输出 new/confirm/update/remove 合并操作
    # （记忆开关关闭时后端自动忽略；device_id 需在读摘要前解析）
    device_id = payload.get("device_id") or payload.get("deviceId") or ""
    profile_digest = profile.profile_ops_digest(device_id) if device_id else ""
    if (api_key or provider in ("opencode", "opencode-go")) and model:
        try:
            extracted = await knowledge._ai_extract_knowledge(messages, provider, api_key, model, base_url, level,
                                                    profile_digest=profile_digest,
                                                    env_key_used=env_key_used)
            if isinstance(extracted, tuple) and len(extracted) == 3:
                items, profile_facts, profile_ops = extracted
            elif isinstance(extracted, tuple):
                items, profile_facts = extracted
            else:
                items = extracted
            if items:
                logger.info(f"AI extract: {len(items)} items for session {session_id}")
        except Exception as e:
            logger.warning(f"AI extract failed, fallback to local: {e}")
    if not items:
        items = _local_extract_knowledge(messages)
        if items:
            logger.info(f"Local extract: {len(items)} items for session {session_id}")

    profile_result = None
    if device_id:
        # 旧格式 profile_facts 兼容：按 new 语义并入 ops（合并式采集内部按规范化文本去重）。
        # 模型同时输出新旧两种格式时，同一句陈述会在这里被数两次（第二条撞重直接固化，
        # 绕过两击门槛），故并入前按规范化文本与 ops 的 new/update 去重
        all_ops = list(profile_ops or [])
        op_norms = {profile._norm_fact(str(o.get("fact") or ""))
                    for o in all_ops
                    if isinstance(o, dict) and str(o.get("op") or "").lower() in ("new", "update")}
        for pf in profile_facts or []:
            if isinstance(pf, dict) and str(pf.get("fact") or "").strip():
                if profile._norm_fact(str(pf.get("fact") or "")) in op_norms:
                    continue
                pf.setdefault("sourceSession", session_id)
                all_ops.append({"op": "new", **pf})
        for op in all_ops:
            if isinstance(op, dict):
                op.setdefault("sourceSession", session_id)
                op.setdefault("source", "chat")
        if all_ops:
            try:
                accepted = profile.apply_profile_ops(device_id, all_ops, source="chat")
                profile_result = {"changed": accepted.get("changed", 0), "promoted": accepted.get("promoted", [])}
                if accepted.get("changed"):
                    logger.info(f"Profile ops applied for device {device_id[:8]}: {accepted}")
            except Exception as e:
                logger.warning(f"Profile fact ingest failed: {e}")

    # 整卡摘要双重用途（P2 起）：主模型 <summary> 只落 anchorSummary（画布定位锚点），
    # 不再覆盖各条目的展示 summary——AI 逐条摘要保优合并靠 summarySource 等级；
    # 本地兜底条目（P4 起）展示 summary 为模板文案，整卡摘要原文由
    # _local_extract_knowledge 自行落 anchorSummary。无 <summary> 时优先保留
    # 条目既有锚点（本地提取的整卡摘要原文），AI 条目再回退其自身摘要作锚点
    # ——锚点绝不能落到模板文案上，否则定位滑窗匹配失效且 P3 旧摘要判定误报。
    summary_text = _extract_summary(messages)
    for it in items:
        anchor = summary_text or it.get("anchorSummary") or it.get("summary") or ""
        if anchor:
            it["anchorSummary"] = anchor[:200]

    # 公式描述 + 知识点摘要：配置了描述模型时并入同一次调用（不增加请求数），
    # 为新增公式生成简要描述，并为各知识点生成逐条摘要。
    # 无公式但有知识点（纯概念回答）也要发起：DESCRIBE 的 summaries 块是
    # local 来源条目升级为模型摘要的唯一通道（descriptor-only 场景）。
    descriptions = {}
    knowledge_summaries = {}
    all_formulas = []
    for it in items:
        for f in (it.get("formulas") or []):
            latex = _normalize_formula(str(f).strip())
            if latex and _looks_like_formula(latex) and latex not in all_formulas:
                all_formulas.append(latex)
    has_knowledge_items = any(str(it.get("title") or "").strip() for it in items)
    if (all_formulas or has_knowledge_items) and desc_model and (desc_api_key or desc_provider in ("opencode", "opencode-go")):
        descriptions, knowledge_summaries = await knowledge._describe_formulas(
            summary_text, all_formulas, items, desc_provider, desc_api_key, desc_model, desc_base_url, level,
            env_key_used=desc_env_used)
        if descriptions or knowledge_summaries:
            logger.info(f"Generated {len(descriptions)} formula descriptions / {len(knowledge_summaries)} knowledge summaries for session {session_id}")

    message_id = str(latest_assistant.get("timestamp") or "") if latest_assistant else ""
    added = _add_formulas_from_items(items, session_id, descriptions, message_id, account=account)
    if added:
        logger.info(f"Auto added {added} formulas to library")
    if device_id:
        # 隐式画像：主回答 = ask 事件（归题＋节奏篇幅）；带公式的条目 = formula 事件。
        # extract 事件不在这里记——条目要等前端经 /api/knowledge 落库，那边按新 id 差分
        try:
            _ask_user = next((m.get("content") for m in reversed(messages)
                              if m.get("role") == "user"), "")
            _events = [{"type": "ask",
                        "topic": profile.assign_topic(str(_ask_user or "")[:500], account=account),
                        "len": len(str((latest_assistant or {}).get("content") or ""))}]
            for it in items:
                if isinstance(it, dict) and it.get("formulas"):
                    _events.append({"type": "formula",
                                    "topic": str(it.get("topic") or it.get("title") or "")[:60]})
            profile.record_implicit_event(device_id, _events, account=account)
        except Exception as e:
            logger.warning(f"Implicit ask event failed: {e}")

    return {"items": items, "descriptions": descriptions, "summaries": knowledge_summaries,
            "profile": profile_result or {"changed": 0, "promoted": []}}

@router.post("/api/documents/parse")
async def api_parse_document(request: Request):
    payload = await _parse_json_object(request)

    filename = _sanitize_filename(payload.get("fileName") or "")
    try:
        max_items = min(max(int(payload.get("maxItems") or 5), 1), 50)
    except (TypeError, ValueError):
        max_items = 5
    content = None
    file_id = str(payload.get("fileId") or "")
    if file_id:
        # 20MB 级文件的读盘与 base64 解码都是秒级同步 CPU/IO 重活：
        # 全部卸到工作线程，期间事件循环继续服务 AI 回复流等其他请求
        loaded = await asyncio.to_thread(_read_upload, file_id)
        if not loaded:
            raise HTTPException(status_code=404, detail="文件不存在，请重新上传")
        entry, content = loaded
        filename = _sanitize_filename(entry.get("filename") or filename)
    else:
        try:
            content = await asyncio.to_thread(base64.b64decode, str(payload.get("contentBase64") or ""))
        except Exception:
            raise HTTPException(status_code=400, detail="文件内容格式错误")
        if not content:
            raise HTTPException(status_code=400, detail="缺少文件内容")
        if len(content) > UPLOAD_MAX_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 20MB 限制")
        file_id = "doc_" + uuid.uuid4().hex[:12]
        await asyncio.to_thread(_save_upload, file_id, filename, content)

    # PDF/DOCX/PPTX 解析与图片 OCR：最重的同步 CPU 段，必须离事件循环
    text = await asyncio.to_thread(_extract_document_text, filename, content)
    ext = Path(filename).suffix.lower()
    is_image = ext in {".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tiff"}
    image_b64 = await asyncio.to_thread(lambda: base64.b64encode(content).decode("ascii")) if is_image else ""

    provider = str(payload.get("provider") or "")
    api_key = str(payload.get("api_key") or "")
    api_key, env_key_used = resolve_api_key(provider, api_key)
    model = str(payload.get("model") or "")
    base_url = str(payload.get("base_url") or "")
    level = str(payload.get("level") or "university")

    nodes, edges, relations = [], [], []
    if model and (api_key or provider in ("opencode", "opencode-go")):
        try:
            nodes, edges, relations = await _ai_extract_document_knowledge(
                text, filename, is_image, image_b64, provider, api_key, model, base_url, level, max_items,
                env_key_used=env_key_used
            )
        except Exception as e:
            logger.warning(f"AI document extraction failed: {e}")
    if not nodes:
        nodes, edges, relations = await asyncio.to_thread(_local_extract_document_knowledge, text, filename, max_items)
    if not nodes:
        raise HTTPException(status_code=422, detail="无法从文件中提取知识点。请使用文本/PDF/DOCX，或为图片配置视觉模型/OCR。")

    return {
        "ok": True,
        "fileId": file_id,
        "fileName": filename,
        "maxItems": max_items,
        "textLength": len(text),
        "nodes": nodes,
        "edges": edges,
        "relations": relations,
        "extractedTextPreview": text[:500],
    }

