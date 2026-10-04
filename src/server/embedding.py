"""本地文本向量（知识大陆 v9 语义证据，2026-09-25）。

为什么需要它（正态/泊松/卡方/均匀分布四岛分不到一片海域的实测根因）：
- 词面证据只认「标题里出现族术语」：`概率统计` 族术语表收了「正态分布」却没收
  「泊松/均匀分布/卡方」——泊松岛与卡方岛零命中、均匀分布岛被「积分/熵」误判进
  微积分+热力学。术语表永远在补漏，补漏的速度赶不上新概念出现的速度；
- 本模块给出门控的第五路证据：把卡片标题（+真摘要）与各概念族的向量中心算
  余弦相似度，词面认不出的卡也能被路由进正确的海域。

设计约束（与大陆既有铁律对齐）：
1. **只路由不证明**：向量相似度只进 cluster 的 domain* 字段（海域分区/摆位），
   绝不进 shared——不建城、不连线，那些仍只由强字面/公式/族表/用户断言；
2. **查空是正常路径**：缺 onnxruntime / 缺 tokenizers / 缺模型文件 / 推理失败，
   一律返回 None，投影退回纯词面评分（与引入前逐字一致），警告只打一次；
3. **纯函数边界**：本模块只负责「文本 → 向量 + 缓存」；评分、聚合仍在
   continent.py 的纯函数里（测试注入假向量，不依赖模型）。

模型：Qwen3-Embedding-0.6B（int8 ONNX，社区转换版），离线本地推理，CPU 毫秒级。
池化按官方口径：左侧填充 + 取最后一个位置的隐状态 + L2 归一（等价于官方
`padding_side='left'` + last_token_pool）。向量缓存落 `data/embedding_cache.json`
（独立文件，不进 kv_store.json——热 KV 每次改动全量重写，256KB 级的向量表
会把它顶过性能红线）。
"""

import hashlib
import json
import math
import os
import threading
import time
from pathlib import Path

__all__ = [
    "embed_texts", "family_centroid_vectors", "gather_vectors",
    "EMBED_MODEL_TAG", "EMBED_MAX_TOKENS",
]

EMBED_MODEL_TAG = "qwen3-embedding-0.6b-int8"
EMBED_MAX_TOKENS = 128          # 卡片标题与族术语都是短文本，128 足够
EMBED_BATCH = 32
_CACHE_MAX_ENTRIES = 3000       # 1024 维 × 3 位小数 ≈ 5.5KB/条，封顶 ~16MB
_CACHE_SUMMARY_CLIP = 200       # 摘要并入向量文本时的截断（与投影 formula 同级宽松度）

# 模型目录：env 覆盖 → 项目根 models/Qwen3-Embedding（2026-10-04 自 baseline/embedding 迁入，旧位作废；env 仍可指向任意处，如换 bge-small-zh）
_ENV_DIR = "PHYMATHIA_EMBEDDING_DIR"
_MODEL_FILE = "model_int8.onnx"
_TOKENIZER_FILE = "tokenizer.json"


def _model_dir():
    candidates = []
    env = str(os.environ.get(_ENV_DIR) or "").strip()
    if env:
        candidates.append(Path(env))
    root = Path(__file__).resolve().parents[2]
    candidates.append(root / "models" / "Qwen3-Embedding")
    for p in candidates:
        if (p / _MODEL_FILE).is_file() and (p / _TOKENIZER_FILE).is_file():
            return p
    return None


# ===== 进程级单例（双检锁，同 RapidOCR 的 _get_ocr_engine 模式——别在调用点重建） =====
_session_lock = threading.Lock()
_session = None        # (ort_session, tokenizer, warn_flag 由调用方持有)
_warned = False


def _warn_once(msg):
    global _warned
    if not _warned:
        _warned = True
        print(f"[embedding] {msg}")


def _load():
    """加载 ONNX 会话与分词器；任何缺口返回 None（调用方降级）。"""
    global _session
    if _session is not None:
        return _session
    try:
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
    except ImportError:
        _warn_once("onnxruntime/tokenizers 未安装，向量证据关闭（词面评分不受影响）")
        return None
    d = _model_dir()
    if d is None:
        _warn_once(f"未找到模型文件（{_MODEL_FILE} + {_TOKENIZER_FILE}），"
                   f"向量证据关闭；可用 {_ENV_DIR} 指定目录")
        return None
    try:
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 4) // 2)
        sess = ort.InferenceSession(str(d / _MODEL_FILE), sess_options=opts,
                                    providers=["CPUExecutionProvider"])
        tok = Tokenizer.from_file(str(d / _TOKENIZER_FILE))
    except Exception as e:  # 模型损坏 / 格式不符：降级，不让大陆打不开
        _warn_once(f"模型加载失败（{type(e).__name__}: {e}），向量证据关闭")
        return None
    _session = (sess, tok, np)
    return _session


def _graph_signature(sess):
    """从会话签名读出（需要 position_ids, KV 层数, KV 头数, 头维度）。

    onnx-community 的 int8 导出带 KV-cache 输入（past_key_values.N.key/value），
    首轮喂零长度过去即可等价于普通编码器前向——这是 0.6B 解码器架构做
    feature-extraction 的标准姿势，不是要真的做增量解码。
    """
    need_pos = any(i.name == "position_ids" for i in sess.get_inputs())
    kv_layers, kv_heads, kv_dim = 0, 0, 0
    for i in sess.get_inputs():
        if i.name.endswith(".key") and "past_key_values" in i.name:
            kv_layers += 1
            shape = i.shape
            if len(shape) == 4 and isinstance(shape[1], int):
                kv_heads, kv_dim = shape[1], shape[3]
    return need_pos, kv_layers, kv_heads, kv_dim


def _infer(sess, tok, np, texts, sig):
    """一批文本 → L2 归一后的向量矩阵（list[list[float]]）。失败抛异常由上层接。"""
    need_pos, kv_layers, kv_heads, kv_dim = sig
    seqs = []
    for t in texts:
        ids = tok.encode(str(t or "")).ids[:EMBED_MAX_TOKENS]
        seqs.append(ids)
    max_len = max(len(s) for s in seqs) if seqs else 1
    input_ids = np.zeros((len(seqs), max_len), dtype=np.int64)
    attn = np.zeros((len(seqs), max_len), dtype=np.int64)
    pos = np.zeros((len(seqs), max_len), dtype=np.int64)
    for i, s in enumerate(seqs):
        # 左填充：最后一个位置恒为该行最后一个真实 token（官方 last_token_pool 口径；
        # 填充位被 attention_mask 挡住，取位置 -1 时与填充用什么 id 无关）
        input_ids[i, max_len - len(s):] = s
        attn[i, max_len - len(s):] = 1
        pos[i, max_len - len(s):] = np.arange(len(s))
    names = {i.name for i in sess.get_inputs()}
    feed = {"input_ids": input_ids, "attention_mask": attn}
    if need_pos:
        feed["position_ids"] = pos
    if kv_layers:
        zeros = np.zeros((len(seqs), kv_heads, 0, kv_dim), dtype=np.float32)
        for layer in range(kv_layers):
            feed[f"past_key_values.{layer}.key"] = zeros
            feed[f"past_key_values.{layer}.value"] = zeros
    feed = {k: v for k, v in feed.items() if k in names}
    out_names = [o.name for o in sess.get_outputs()]
    pick = "last_hidden_state" if "last_hidden_state" in out_names else out_names[0]
    hidden = sess.run([pick], feed)[0]
    if hidden.ndim != 3:
        raise ValueError(f"unexpected output rank {hidden.ndim}")
    # 取最后一个位置（左填充下恒为最后一个真实 token），再 L2 归一
    vecs = hidden[:, -1, :].astype(np.float32)
    norms = np.linalg.norm(vecs, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    vecs = vecs / norms
    return [[round(float(x), 4) for x in row] for row in vecs]


def embed_texts(texts):
    """一批文本 → 同序向量列表；依赖/模型缺失或推理失败返回 None（降级正常路径）。

    总开关 PHYMATHIA_EMBEDDING=0/off/false 时直接返回 None（测试沙箱与
    「就要纯词面口径」的场景用）；调用方在 async 路由里必须 asyncio.to_thread
    包一层（613MB 模型首次加载 1-3 秒、批推理百毫秒级，不能阻塞事件循环）。
    """
    if str(os.environ.get("PHYMATHIA_EMBEDDING") or "").strip().lower() in ("0", "off", "false"):
        return None
    clean = [str(t or "").strip() for t in (texts or [])]
    clean = [t for t in clean if t]
    if not clean:
        return []
    loaded = _load()
    if loaded is None:
        return None
    sess, tok, np = loaded
    try:
        sig = _graph_signature(sess)
        out = []
        for i in range(0, len(clean), EMBED_BATCH):
            out.extend(_infer(sess, tok, np, clean[i:i + EMBED_BATCH], sig))
        return out
    except Exception as e:
        _warn_once(f"推理失败（{type(e).__name__}: {e}），向量证据关闭")
        return None


# ===== 向量缓存（独立文件 data/embedding_cache.json，不进 kv_store.json） =====
_cache_lock = threading.Lock()
_CACHE_VERSION = 1


def _cache_path():
    root = Path(__file__).resolve().parents[2]
    return root / "data" / "embedding_cache.json"


def _text_hash(text):
    return hashlib.sha1(f"{EMBED_MODEL_TAG}|{text}".encode("utf-8")).hexdigest()


def _cache_load():
    try:
        with open(_cache_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("version") == _CACHE_VERSION \
                and data.get("model") == EMBED_MODEL_TAG \
                and isinstance(data.get("texts"), dict):
            return data["texts"]
    except (OSError, ValueError):
        pass
    return {}


def _cache_store(texts_map):
    """texts_map: {hash: vec}。写失败静默（缓存只是加速，丢了重算）。"""
    payload = {"version": _CACHE_VERSION, "model": EMBED_MODEL_TAG,
               "savedAt": int(time.time()), "texts": texts_map}
    tmp = Path(str(_cache_path()) + ".tmp")
    try:
        _cache_path().parent.mkdir(parents=True, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp, _cache_path())
    except OSError:
        pass


def gather_vectors(texts):
    """{key: text} → ({key: vec}, 需要回写的缓存增量)。缺模型/推理失败 → ({}, False)。"""
    clean = {k: str(t or "").strip() for k, t in (texts or {}).items()}
    clean = {k: t for k, t in clean.items() if t}
    if not clean:
        return {}, False
    with _cache_lock:
        cached = _cache_load()
        wanted = {k: _text_hash(t) for k, t in clean.items()}
        missing = {h: t for k, h in wanted.items()
                   if h not in cached
                   for t in [clean[k]]}
        if missing and len(cached) + len(missing) > _CACHE_MAX_ENTRIES:
            # 超容量：丢一半最旧的（dict 保序，头部即最旧），再补
            for h in list(cached.keys())[: (len(cached) + len(missing)) - _CACHE_MAX_ENTRIES]:
                cached.pop(h, None)
        if missing:
            hashes = list(missing.keys())
            vecs = embed_texts([missing[h] for h in hashes])
            if vecs is None:
                return {}, False
            for h, v in zip(hashes, vecs):
                cached[h] = v
            _cache_store(cached)
        out = {}
        for k, h in wanted.items():
            v = cached.get(h)
            if v:
                out[k] = v
        return out, bool(missing)


# ===== 概念族向量中心（评分证据的对比锚点） =====

def family_centroid_vectors(families, key_vectors):
    """族列表 + {文本: vec} → {规范名: 归一中心向量}。

    每族取「规范名 + 全部术语」的向量平均再归一；族里任何一个文本缺向量就跳过
    该文本，一个都没有就整族无中心（该族不参与向量证据——查空是正常路径）。
    """
    import numpy as np
    out = {}
    for fam in (families or []):
        canonical = str(fam.get("canonical") or "").strip()
        if not canonical:
            continue
        texts = [canonical] + [str(t) for t in (fam.get("terms") or [])]
        vecs = [key_vectors.get(t) for t in texts]
        vecs = [v for v in vecs if v]
        if not vecs:
            continue
        arr = np.array(vecs, dtype=np.float32)
        centroid = arr.mean(axis=0)
        norm = float(np.linalg.norm(centroid))
        if norm > 0:
            out[canonical] = [round(float(x), 4) for x in (centroid / norm)]
    return out


def cosine(a, b):
    """两条已归一向量的余弦（输入若未归一也不炸）。纯标量版给测试用。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(float(x) * float(y) for x, y in zip(a, b))
    na = math.sqrt(sum(float(x) * float(x) for x in a)) or 1.0
    nb = math.sqrt(sum(float(y) * float(y) for y in b)) or 1.0
    return dot / (na * nb)
