#!/usr/bin/env python3
"""工作流前缀缓存竞速探针（2026-10-14 T322/T323 查证产出）。

测某个模型槽位的网关前缀缓存行为，三种模式各一轮（每轮独占 salt，防跨轮字节
复用互相污染）：
  replay  同一字节连发两遍（间隔 2s）——整请求级缓存是否工作；
  sim     兄弟模块两路同时发——共享段（question/analysis/upstream）写入竞速；
  gap800  首路发出 0.8s 后发第二路——派发错峰能否消除竞速。

2026-10-14 实测结论（opencode zen 网关，hit 恒为 256-token 块整倍数口径）：
  deepseek-v4.1-flash（当时激活）：replay 87%；兄弟 sim／首路完整跑完后再发／
    gap800 全 0% ——只做整请求级命中，无部分前缀复用；
  mimo-v2.6-flash：replay 100%；兄弟首路完整跑完后再发 73%、sim 0%、gap800 0%、
    gap300 41% ——部分前缀复用存在但写入可见性非确定，错峰收益不稳定；
  deepseek-chat（官方直连）／glm-5.3-flash（zhipu）：usage 不报缓存字段，测不了。
用途：换 agent_model 后跑一遍，判断该模型下工作流缓存经济是否成立。

用法：先 `python3 src/main.py -p 5050` 起服务，再
  python3 scripts/workflow_cache_race_probe.py [模型名，默认 deepseek-v4.1-flash]
槽位与密钥读 data/users/default（单模型密钥优先、回落组密钥；密钥只进请求不打印）。
口径：服务端日志 `AI proxy cache: hit X/Y tok`
（models_routes._log_cache_hit_rate → usage_stats.parse_usage）。
"""
import json
import sys
import threading
import time

import httpx

BASE = "http://localhost:5050/api/models/chat"
MODELS_JSON = "data/users/default/models.json"
AUTH_JSON = "data/users/default/auth.json"
LOG_PATH = "logs/server-5050.log"
DEFAULT_MODEL = "deepseek-v4.1-flash"
MODEL_NAME = DEFAULT_MODEL  # __main__ 里按 argv 覆盖

QUESTION_TMPL = (
    "用几段话说明{salt}场景下法拉第电磁感应定律的物理图像与数学表达，并给出一个简单例子。"
)
ANALYSIS_TMPL = (
    "核心是通过磁通量变化率刻画感应电动势：物理图像是磁力线与导体回路的相对运动"
    "（楞次定律给方向），数学结构是电动势等于磁通量变化率的负值乘匝数。"
    "本轮标记：{salt}。建议模块：物理视角、数学视角。"
)
UPSTREAM_TMPL = (
    "问题原文：{salt}场景下的法拉第电磁感应定律。要求同时讲物理图像（磁力线与导体回路的"
    "相对运动、楞次定律的方向判断）与数学表达（磁通量定义、电动势等于磁通量变化率的负值、"
    "线圈匝数因子），并联系动生电动势与感生电动势两类来源，最后给一个导体棒在导轨上滑动的"
    "数值例子，说明如何用公式求感应电流的大小与方向。这段填充文本用于把 upstream 条目撑到"
    "接近线上 800 字切片的体量，观察 256-token 块粒度下的缓存命中差异，避免共享段太小导致"
    "命中数字分辨率不足。{salt}"
)


def resolve_slot(model_name):
    """槽位 → (provider, base_url, api_key)；单模型密钥优先、回落组密钥。"""
    models = json.load(open(MODELS_JSON, encoding="utf-8"))
    auth = json.load(open(AUTH_JSON, encoding="utf-8"))
    for m in models.get("userModels", []):
        if m.get("model") == model_name:
            key = (auth.get("modelKeys") or {}).get(m["id"]) \
                or (auth.get("groupKeys") or {}).get(m.get("provider")) or ""
            return m.get("provider", ""), m.get("baseUrl", ""), key
    raise SystemExit(f"模型槽位未找到：{model_name}（查 {MODELS_JSON} 的 userModels[].model）")


def _payload(slot, session_id, salt, module_key, label):
    """模块形状请求：shared 段（question/analysis/upstream）对兄弟逐字节相同，
    graph_path 的 module 项与 source_module 逐请求不同（仿 test_prefix_stability
    场景 F / 前端 _buildWorkflowContextForNode）。"""
    provider, base_url, api_key = slot
    return {
        "provider": provider,
        "model": MODEL_NAME,
        "base_url": base_url,
        "api_key": api_key,
        "stream": True,
        "session_id": session_id,
        "prompt": f"请生成{label}模块正文",
        "graph_path": [
            {"kind": "user", "timestamp": 1},
            {"kind": "answer", "timestamp": 2, "module": "answer"},
            {"kind": "module", "timestamp": 3, "module": module_key},
        ],
        "source_module": module_key,
        "workflow_context": {
            "mode": "module",
            "target": {"kind": "module", "module": module_key, "label": label},
            "question": QUESTION_TMPL.format(salt=salt),
            "analysis": ANALYSIS_TMPL.format(salt=salt),
            "requirements": "",
            "upstream": [{"label": "问题", "content": UPSTREAM_TMPL.format(salt=salt)}],
        },
    }


def _post_stream(client, payload):
    with client.stream("POST", BASE, json=payload, timeout=120) as resp:
        resp.read()
        return resp.status_code


def _tail_hit_lines(mark):
    with open(LOG_PATH, encoding="utf-8", errors="replace") as f:
        lines = f.readlines()
    hits = [l.rstrip("\n") for l in lines[mark:] if "AI proxy cache" in l]
    return [h.split("AI proxy cache:")[-1].strip() for h in hits]


def run_round(slot, name, mode):
    """一轮一种模式；salt 独占，命中只可能来自本轮内更早的请求。"""
    salt = f"{name}-{int(time.time())}"
    session_id = f"sess_race_{name}_{int(time.time())}"
    with open(LOG_PATH, encoding="utf-8", errors="replace") as f:
        mark = len(f.readlines())
    results = {}
    with httpx.Client() as client:
        def fire(key, module_key, label):
            results[key] = _post_stream(client, _payload(slot, session_id, salt, module_key, label))

        if mode == "replay":
            fire("same", "physics", "物理视角")
            time.sleep(2)
            fire("same2", "physics", "物理视角")
        elif mode == "sim":
            t1 = threading.Thread(target=fire, args=("phys", "physics", "物理视角"))
            t2 = threading.Thread(target=fire, args=("math", "math", "数学视角"))
            t1.start()
            t2.start()
            t1.join()
            t2.join()
        elif mode == "gap800":
            th = threading.Thread(target=fire, args=("phys", "physics", "物理视角"))
            th.start()
            time.sleep(0.8)
            fire("math", "math", "数学视角")
            th.join()
        else:
            raise ValueError(mode)
        time.sleep(0.5)
    hits = _tail_hit_lines(mark)
    print(f"[{name}] 状态码={results} 命中行（按日志先后）：")
    for h in hits:
        print("   ", h)
    if not hits:
        print("    （无命中行——该上游 usage 可能不报缓存字段，或请求失败，查服务日志）")


if __name__ == "__main__":
    MODEL_NAME = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MODEL
    slot = resolve_slot(MODEL_NAME)
    print(f"探针：{BASE} model={MODEL_NAME} provider={slot[0]} base_url={slot[1]} key={'***' if slot[2] else '无'}")
    for name, mode in (("replay", "replay"), ("sim", "sim"), ("gap800", "gap800")):
        run_round(slot, name, mode)
