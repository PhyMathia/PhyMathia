#!/usr/bin/env python3
"""前缀缓存探针：相邻两次请求「发给上游的消息流」的公共前缀占比。

provider 前缀缓存按请求前缀字节匹配（命中部分约 1/10 计价），命中率的原则
就是相邻请求前缀字节重合度。本脚本不走真实上游：用 httpx MockTransport 捕获
/api/models/chat 实际发出的请求体（真实组装路径），逐对计算公共前缀占比——
这是 2026-09-21 手工 mock 上游（已清理未留存）的可复用替代，数字是字节级
代理指标（真实厂商按块粒度计，略低于此值，但前后对比方向性完全有效）。

用法：python3 scripts/prefix_cache_tree_probe.py
数据路径全部重定向到临时目录，不碰真实 data/；不发任何网络请求。
补丁手法与 tests/test_routes.py 的 RouteTestBase 一致，改夹具两处同步。
"""
import json
import os
import sys
import tempfile
import unittest.mock
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

import httpx  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
import usage_stats  # noqa: E402
from server import backup as backup_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import context as context_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


def _patch_paths(td):
    """RouteTestBase 同款：五个模块命名空间的数据路径统一指向临时目录。"""
    paths = {
        "MESSAGES_DIR": Path(td) / "messages",
        "SESSIONS_PATH": Path(td) / "sessions.json",
        "KNOWLEDGE_PATH": Path(td) / "knowledge.json",
        "FORMULAS_PATH": Path(td) / "formulas.json",
        "KV_PATH": Path(td) / "kv_store.json",
        "KV_DIR": Path(td) / "kv",
        "PROFILES_DIR": Path(td) / "profiles",
    }
    for p in paths.values():
        p.parent.mkdir(parents=True, exist_ok=True)
    orig = {}
    for mod in (main_mod, storage_mod, backup_mod, profile_mod, config_mod):
        for name, value in paths.items():
            key = (id(mod), name)
            orig[key] = getattr(mod, name, None)
            setattr(mod, name, value)
    orig_usage = usage_stats.USAGE_DIR
    usage_stats.USAGE_DIR = Path(td) / "usage"
    storage_mod._JSON_READ_CACHE.clear()
    return orig, orig_usage


def _restore(orig, orig_usage):
    for (mid, name), value in orig.items():
        for mod in (main_mod, storage_mod, backup_mod, profile_mod, config_mod):
            if id(mod) == mid:
                setattr(mod, name, value)
    usage_stats.USAGE_DIR = orig_usage
    storage_mod._JSON_READ_CACHE.clear()


def _card(physics_chars, math_chars, tag):
    """一张带 <summary> 的完整学习卡片，physics/math 各指定长度。"""
    return (
        f"<physics>{tag}物理视角：" + "磁通量变化在闭合回路中产生感应电动势，" * (physics_chars // 20)
        + "</physics>"
        + "<math>" + f"{tag}数学视角：ε = -dΦ/dt，" + "对时间求导并代入法拉第定律可解出回路电流，" * (math_chars // 24)
        + "</math>"
        + f"<summary>{tag}电磁感应要点摘要：磁通变化产生电动势。</summary>"
    )


LINEAR_TURNS = [
    "波粒二象性是什么",
    "双缝实验怎么说明它",
    "测不准原理和它什么关系",
    "薛定谔的猫是啥",
    "量子纠缠超光速吗",
    "退相干又是啥",
]
_ASSISTANT_REPLY = _card(600, 400, "第N轮")


def _post_chat(client, session_id, prompt, graph_path):
    payload = {
        "prompt": prompt,
        "level": "university",
        "provider": "deepseek",
        "api_key": "sk-probe",
        "model": "probe-model",
        "stream": False,
        "session_id": session_id,
    }
    if graph_path is not None:
        payload["graph_path"] = graph_path
    resp = client.post("/api/models/chat", json=payload)
    if resp.status_code != 200:
        raise RuntimeError(f"{session_id} 轮 {prompt!r} -> HTTP {resp.status_code}: {resp.text[:200]}")


def _stream_of(captured):
    """取最近一次「聊天」请求的消息流。历史攒到 15 条会触发滚动记忆压缩任务，
    它走同一个 http client（system 开头是「你是会话记忆压缩助手」），必须排除。"""
    for body in reversed(captured):
        msgs = body.get("messages") or []
        if msgs and str((msgs[0] or {}).get("content") or "").startswith("# 角色定义"):
            return "".join(f"{m.get('role')}\n{m.get('content')}\n" for m in msgs)
    raise RuntimeError("captured 里没有聊天请求")


def _report(label, streams):
    for i in range(1, len(streams)):
        common = os.path.commonprefix([streams[i - 1], streams[i]])
        prev_len = len(streams[i - 1])
        ratio = len(common) / prev_len if prev_len else 0.0
        print(f"  {label} {i}→{i + 1}: 前缀重合 {ratio * 100:5.1f}%  （上轮 {prev_len} 字，重合 {len(common)} 字）")
        cut = len(common)
        print(f"    断点@{cut} 上一请求: …{streams[i - 1][cut:cut + 48]!r}")
        print(f"    断点@{cut} 本请求  : …{streams[i][cut:cut + 48]!r}")


def _run_linear(client, captured):
    """主线连问：每轮后按前端口径把该轮问答追加进历史。"""
    saved = []
    orig_load = context_mod._load_messages
    context_mod._load_messages = lambda sid: list(saved)
    streams = []
    try:
        for i, prompt in enumerate(LINEAR_TURNS):
            _post_chat(client, "probe_linear", prompt, None)
            streams.append(_stream_of(captured))
            ts = i * 2 + 1
            saved.append({"role": "user", "content": prompt, "timestamp": ts})
            saved.append({"role": "assistant", "content": _ASSISTANT_REPLY, "timestamp": ts + 1})
    finally:
        context_mod._load_messages = orig_load
    _report("轮", streams)


def _run_tree(client, captured):
    """树探索连钻：每层 = 在当前聚焦模块上追问一次，问答入历史后再钻下一层。

    时序（与真机一致）：请求发出时，路径里引用的节点必须已经入历史——
    本层的追问/子回答在响应之后才落历史，供下一层的路径引用。
    """
    saved = [
        {"role": "user", "content": "什么是电磁感应", "timestamp": 1},
        {"role": "assistant", "content": _card(3000, 2400, "根"), "timestamp": 2},
    ]
    path = [
        {"kind": "user", "timestamp": 1},
        {"kind": "answer", "timestamp": 2, "module": "physics"},
    ]
    prompts = [
        "从物理视角再展开讲讲磁通量",
        "磁通量变化率在有感线圈里怎么表现",
        "感应电动势的方向怎么判断",
        "涡流制动是什么原理",
        "法拉第定律和麦克斯韦方程什么关系",
        "感生和动生电动势怎么区分",
        "变压器是怎么利用电磁感应的",
        "无线充电是同样的原理吗",
    ]
    orig_load = context_mod._load_messages
    context_mod._load_messages = lambda sid: list(saved)
    streams = []
    try:
        for i, prompt in enumerate(prompts):
            _post_chat(client, "probe_tree", prompt, [dict(item) for item in path])
            streams.append(_stream_of(captured))
            u_ts = 100 + i * 10
            saved.append({"role": "user", "content": prompt, "timestamp": u_ts})
            saved.append({"role": "assistant", "content": _card(2600, 1600, f"L{i + 1}"), "timestamp": u_ts + 1})
            path = path + [
                {"kind": "user", "timestamp": u_ts},
                {"kind": "answer", "timestamp": u_ts + 1, "module": "physics"},
            ]
    finally:
        context_mod._load_messages = orig_load
    _report("钻层", streams)


def _run_answer_level(client, captured):
    """answer 层级（无模块键）↔ 模块层级切换：同一消息在两种视图下的历史区
    渲染本就不同（卡片级摘要 vs 模块级摘要），切视图的 ~200 字摘要区变化
    新旧设计都躲不开；旧设计额外损失「全文→摘要」的头部（实测个位数字节）。
    本场景用于观察切视图的最小损耗基线，详见 docs/日志 当天条目的实测结论。"""
    saved = [
        {"role": "user", "content": "什么是电磁感应", "timestamp": 1},
        {"role": "assistant", "content": _card(3000, 2400, "根"), "timestamp": 2},
    ]
    prompts = [
        "再完整地讲一遍核心逻辑",
        "从物理视角深入：磁通量怎么理解",
        "那数学上怎么定量描述",
    ]
    orig_load = context_mod._load_messages
    context_mod._load_messages = lambda sid: list(saved)
    streams = []
    try:
        for i, prompt in enumerate(prompts):
            u_ts = 100 + i * 10
            if i == 0:
                path = [
                    {"kind": "user", "timestamp": 1},
                    {"kind": "answer", "timestamp": 2},
                ]
            else:
                path = [
                    {"kind": "user", "timestamp": 1},
                    {"kind": "answer", "timestamp": 2, "module": "physics"},
                    {"kind": "user", "timestamp": 100},
                    {"kind": "answer", "timestamp": 101, "module": "physics"},
                ] + ([{"kind": "user", "timestamp": 110},
                      {"kind": "answer", "timestamp": 111, "module": "math"}] if i == 2 else [])
            _post_chat(client, "probe_answer", prompt, [dict(item) for item in path])
            streams.append(_stream_of(captured))
            saved.append({"role": "user", "content": prompt, "timestamp": u_ts})
            saved.append({"role": "assistant", "content": _card(2600, 1600, f"A{i + 1}"), "timestamp": u_ts + 1})
    finally:
        context_mod._load_messages = orig_load
    _report("轮", streams)


LONG_LINEAR_TURNS = LINEAR_TURNS + [
    "贝尔不等式说的是什么",
    "CHSH 不等式怎么违背",
    "隐变量理论为什么被排除",
    "多世界诠释怎么解释测量",
    "哥本哈根诠释的坍缩是物理过程吗",
    "量子隧穿和势垒穿透是一回事吗",
    "扫描隧道显微镜用的就是隧穿吗",
    "量子退相干和测量坍缩什么关系",
]


def _run_long_linear(client, captured):
    """14 轮长线性：旧滑动窗口在第 4 轮后逐轮改写边界、第 12 轮起头部摘要
    开始丢弃——断点会钉死在系统提示结尾；追加式历史区下断点应随轮次增长。"""
    saved = []
    orig_load = context_mod._load_messages
    context_mod._load_messages = lambda sid: list(saved)
    streams = []
    try:
        for i, prompt in enumerate(LONG_LINEAR_TURNS):
            _post_chat(client, "probe_linear_long", prompt, None)
            streams.append(_stream_of(captured))
            ts = i * 2 + 1
            saved.append({"role": "user", "content": prompt, "timestamp": ts})
            saved.append({"role": "assistant", "content": _ASSISTANT_REPLY, "timestamp": ts + 1})
    finally:
        context_mod._load_messages = orig_load
    _report("轮", streams)


def _run_fork(client, captured):
    """树兄弟分叉：同一父节点（ts 1/2，physics 模块）下连开多个新方向。

    分叉请求的历史区（root→父）与尾部块（父全文）逐字节相同，结构上除新
    提问外应全命中——本场景把「分叉是缓存最友好场景」的结构结论钉进探针。"""
    saved = [
        {"role": "user", "content": "什么是电磁感应", "timestamp": 1},
        {"role": "assistant", "content": _card(3000, 2400, "根"), "timestamp": 2},
    ]
    path = [
        {"kind": "user", "timestamp": 1},
        {"kind": "answer", "timestamp": 2, "module": "physics"},
    ]
    prompts = [
        "从物理视角再展开讲讲磁通量",
        "那数学上怎么定量描述",
        "感应电动势方向怎么判断",
        "涡流制动是什么原理",
    ]
    orig_load = context_mod._load_messages
    context_mod._load_messages = lambda sid: list(saved)
    streams = []
    try:
        for i, prompt in enumerate(prompts):
            _post_chat(client, "probe_fork", prompt, [dict(item) for item in path])
            streams.append(_stream_of(captured))
            ts = 100 + i * 10
            saved.append({"role": "user", "content": prompt, "timestamp": ts})
            saved.append({"role": "assistant", "content": _card(2600, 1600, f"F{i + 1}"), "timestamp": ts + 1})
    finally:
        context_mod._load_messages = orig_load
    _report("叉", streams)


def main():
    td = tempfile.TemporaryDirectory()
    orig, orig_usage = _patch_paths(td.name)
    captured = []

    def handler(request):
        captured.append(json.loads(request.content.decode()))
        return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

    try:
        client = TestClient(main_mod.app)
        # 路由会在 client 上调 build_request，必须给 AsyncClient 而非裸 transport
        http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with unittest.mock.patch.object(main_mod, "get_http_client", return_value=http):
            print("=" * 64)
            print("场景 A：主线线性连问（哨兵，2026-09-21 真机口径同型）")
            _run_linear(client, captured)
            captured.clear()
            print("-" * 64)
            print("场景 B：树探索连钻 8 层（每层追加 追问+子回答 两个节点，同模块键持续下钻）")
            _run_tree(client, captured)
            captured.clear()
            print("-" * 64)
            print("场景 C：answer 层级追问后转入模块层级（历史区翻转的真实损耗点）")
            _run_answer_level(client, captured)
            captured.clear()
            print("-" * 64)
            print("场景 D：主线长线性 14 轮（旧滑窗 3-10 轮失稳、12 轮起头部丢弃）")
            _run_long_linear(client, captured)
            captured.clear()
            print("-" * 64)
            print("场景 E：树兄弟分叉（同一父节点连开新方向，分叉点前缀应全命中）")
            _run_fork(client, captured)
            print("=" * 64)
    finally:
        _restore(orig, orig_usage)
        td.cleanup()


if __name__ == "__main__":
    main()
