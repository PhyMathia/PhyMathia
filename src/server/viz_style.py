"""交互可视化「画法按需注入」（2026-11-16）。

做什么：给一次生成请求判断「这次要不要挂等距剖视的构图规范」，命中才把一段
约 4KB 的载荷追加到 user 消息尾部——不常驻 system prompt，也不改发送链结构。

为什么放 user 侧：难度档位早就是这么做的（`LEVEL_PROMPTS` 拼在 user_text 末尾），
system 常驻会拖累前缀缓存，且每次回答都要付这段 token。

判定口径（实测标定，见 outputs/viz_style_loader_draft.md）：
- 名词短语锚点，不要写成句子（「为什么/怎么」会把数学题吸过来）
- 取 max 不取均值（一个问题通常只贴合一两条锚点）
- 只比相对大小（正样本 0.365~0.639、非正 0.24~0.456，绝对阈值不可分）
- 下限 0.33 仅作兜底
- 宁可漏判：漏了模型照常画图，误判才多花 token 且可能带偏

开关：`PHYMATHIA_VIZ_STYLE=0/off/false` 关闭（未设＝开）。
"""

import asyncio
import os
import threading

from . import embedding

STYLE = "iso-cutaway"
FLOOR = 0.33
_CACHE_MAX = 128

ISO_ANCHORS = [
    "发动机 活塞 曲轴 气缸 连杆 传动",
    "泵 阀门 管路 流体 压力 密封",
    "齿轮 啮合 减速比 传动轴 轴承",
    "拆开 外壳 内部零件 装配 剖视",
    "光路 透镜 反射 折射 焦点",
    "液压 气动 油缸 活塞杆 回路",
]

OTHER_ANCHORS = [
    "函数图像 曲线 斜率 极值",
    "概率分布 期望 方差 密度",
    "数据点 散点 相关性 拟合",
    "矢量场 梯度 散度 旋度",
    "矩阵 特征值 线性变换",
    "概念关系 从属 包含 层级",
    "推导步骤 证明 逻辑链",
    "能级 跃迁 光谱 量子数",
    "相图 临界点 相变",
    "集合 映射 同构 群",
]

PAYLOAD = """# 本次可用的画法（可选，不适用就忽略本段）

适用：讲清实体装置的结构与运动——发动机、泵、阀、齿轮箱、机芯这类，需要同时看到
内部零件和传动关系。不适用：函数图像、概率分布、抽象结构、纯流程、只求一个结论。

若采用，按以下契约画：

1. 根元素写 lang="zh-CN" data-theme="light"（静态声明，宿主据此判「有原生主题」，
   不走反色滤镜）；同时定义 :root 与 html[data-theme="dark"] 两套 CSS 变量，
   颜色一律取变量，不写死色值。
2. 字体只用系统栈，不引外部字体、图标库、图表库、图片、任何 <script src> 或 <link href>。
3. 主图用 SVG：viewBox="0 0 440 400"，preserveAspectRatio="xMidYMid meet"，宽高 100%。
4. 版式：左侧主图占满剩余宽度，右侧读数面板固定 170–180px；容器窄于 560px 时读数移到下方。
5. 所有几何量由公式算（曲柄连杆、凸轮、齿轮啮合），不写死估算像素；运动件放进
   clipPath 避免越界；传动件先画、运动件后画，形成插入遮挡。
6. 读数必须实算；算不出的量（压力、温度）只做色块示意，并在页脚注明「示意，非计算值」。
7. 零件控制在 12–24 个，按此顺序搭：外壳 → 内腔 → 运动件 → 传动件 → 回转件 → 销轴 → 进排口。
8. 动画用 requestAnimationFrame 累加角度，每帧只改 transform 与端点坐标，文本读数每 3 帧更新一次。
9. 需要交互时，pointerdown 只在回转件半径内接管，pointermove 用 atan2 反算角度。

不合格的样子：零件堆到 40 个以上、用 filter:invert 假装深色、每帧写 textContent、
把示意图里的压力写成「计算值」、引入任何外部库。"""

_anchors = None
_anchor_lock = threading.Lock()
_cache = {}
_cache_lock = threading.Lock()


def _enabled():
    return str(os.environ.get("PHYMATHIA_VIZ_STYLE") or "").strip().lower() not in ("0", "off", "false")


def in_scope(source_module="", workflow_context="", branch_id=""):
    """只在这两种请求里考虑注入，其余一律不碰。

    1. 画布上直接生成「交互可视化」模块（source_module == "viz"）；
    2. 完整学习卡片首问（没有工作流上下文、也不是支线）。
    模块重生成（physics/math/graph 等）与支线不注入：局部动作，多这层只挤 token。
    """
    if str(source_module or "") == "viz":
        return True
    return not workflow_context and not branch_id


def _load_anchors():
    global _anchors
    if _anchors is not None:
        return _anchors
    with _anchor_lock:
        if _anchors is not None:
            return _anchors
        vecs = embedding.embed_texts(ISO_ANCHORS + OTHER_ANCHORS)
        if not vecs:
            return None
        n = len(ISO_ANCHORS)
        _anchors = (vecs[:n], vecs[n:])
    return _anchors


def decide_sync(question):
    """同步判定（CPU 密集，async 路由里必须 asyncio.to_thread 包一层）。"""
    q = str(question or "").strip()
    if not q:
        return {"hit": False, "score": 0.0, "rival": 0.0, "reason": "empty"}

    with _cache_lock:
        cached = _cache.get(q)
    if cached is not None:
        return cached

    anchors = _load_anchors()
    if anchors is None:
        return {"hit": False, "score": 0.0, "rival": 0.0, "reason": "embedding-unavailable"}

    vecs = embedding.embed_texts([q])
    if not vecs:
        return {"hit": False, "score": 0.0, "rival": 0.0, "reason": "embedding-unavailable"}

    v = vecs[0]
    iso_vecs, other_vecs = anchors
    score = max(sum(x * y for x, y in zip(v, p)) for p in iso_vecs)
    rival = max(sum(x * y for x, y in zip(v, p)) for p in other_vecs)
    if score <= rival:
        reason = "not-closest"
    elif score < FLOOR:
        reason = "below-floor"
    else:
        reason = "hit"
    out = {"hit": reason == "hit", "score": round(score, 4), "rival": round(rival, 4), "reason": reason}

    with _cache_lock:
        if len(_cache) >= _CACHE_MAX:
            _cache.clear()
        _cache[q] = out
    return out


async def augment(question):
    """命中则返回要追加到 user 消息尾部的文本，否则返回空串（调用方一字不动）。"""
    if not _enabled():
        return ""
    try:
        verdict = await asyncio.to_thread(decide_sync, question)
    except Exception:
        return ""
    if not verdict.get("hit"):
        return ""
    return "\n\n" + PAYLOAD
