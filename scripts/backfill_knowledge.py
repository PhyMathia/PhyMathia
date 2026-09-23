#!/usr/bin/env python3
"""老会话存量补提取（大陆「存量回填」）：把探索网里已沉淀的完整讲解重新提取成知识点。

为什么不是重跑消息：老会话的消息文件大多已清空（12 个文件 10 个空），真正的存量在
`data/kv/<sid>.json` 的探索网节点里——每个会话的 physics / math 模块存着数千字的
完整讲解（正是提取管线该吃的东西），而多数岛当时只提出了 1 个知识点。

流程（与页面内提取完全同一条链路）：
  1. 备份 data/knowledge.json / formulas.json / sessions.json 到 data/backup/backfill-<ts>/
  2. 起一个隔离端口的服务实例（数据目录就是真实 data/，页面服务不用动）
  3. 逐个提取单元合成伪对话（用户问题 + 模块讲解正文），POST /api/extract_knowledge
     —— 苏格拉底追问跳过 / 思维链拒收 / 标题闸门 / 去重全部走服务端既有口径
  4. 返回条目回填 sessionId / messageId / source 后 POST /api/knowledge 入库
     （服务端再过一次入库闸门 + 按会话+规范标题去重）
  5. 打印前后对比（知识点数、大陆岛数/城市数）

幂等：处理过的单元记进 data/backfill_state.json，重跑只补增量；--all 忽略记录全量重提
（同标题条目会被服务端去重合并，不会翻倍）。

模型：默认智谱官方 GLM（OpenAI 兼容口 https://open.bigmodel.cn/api/paas/v4），
key 从环境变量 / .env 的 ZHIPU_API_KEY 读取。用法：
  python3 scripts/backfill_knowledge.py --dry-run   # 只看计划，不调用不写入
  python3 scripts/backfill_knowledge.py             # 真跑（需先配好 ZHIPU_API_KEY）
"""

import argparse
import hashlib
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
KV = os.path.join(DATA, "kv")
MSGS = os.path.join(DATA, "messages")
STATE_PATH = os.path.join(DATA, "backfill_state.json")

# 只提这两个模块：physics/math 是完整讲解正文；viz/graph/learn 要么是代码/元数据，
# 要么只有一两句话——喂给提取模型只会产出垃圾或空转
MODULE_KEYS = {"physics", "math"}
MIN_CONTENT_CHARS = 500
SOCRATIC_BRANCHES = {"followup", "confused", "socratic"}


def load_env():
    """轻量 .env 读取（与 src/server/config.py 同口径：不覆盖已有环境变量）。"""
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def http_json(port, method, path, payload=None, timeout=120):
    url = f"http://127.0.0.1:{port}{path}"
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_state():
    try:
        with open(STATE_PATH, encoding="utf-8") as f:
            state = json.load(f)
        if isinstance(state, dict) and isinstance(state.get("processed"), dict):
            return state
    except (OSError, ValueError):
        pass
    return {"processed": {}}


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1)
    os.replace(tmp, STATE_PATH)


def backup():
    ts = time.strftime("%Y%m%d-%H%M%S")
    dest = os.path.join(DATA, "backup", f"backfill-{ts}")
    os.makedirs(dest, exist_ok=True)
    for name in ("knowledge.json", "formulas.json", "sessions.json"):
        src = os.path.join(DATA, name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dest, name))
    return dest


def read_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def is_code_block(text):
    return text.startswith("```")


def collect_units():
    """提取单元清单：[{key, sessionId, question, answer, source}]。

    两个来源：① 消息文件里未提取过的 assistant 回复（存量极少，但不漏）；
    ② kv 图节点里 physics/math 模块的讲解正文（主料）。已入库条目的 messageId
    用于跳过消息来源的重复；图节点用节点 id 记账（节点内容变了 hash 也变——
    记账键带内容短 hash，改了会重新提）。
    """
    sessions = read_json(os.path.join(DATA, "sessions.json"), {})
    titles = {}
    for sid, s in sessions.items():
        if isinstance(s, dict):
            titles[sid] = str(s.get("title") or "")
    # 只提活会话：已删会话的消息/KV 残留文件若被提取入库，知识点带着死 sid
    # 进库，大陆会投影出「已删除的画布」孤岛（09-23 真机取证）
    live_sids = set(sessions.keys())
    knowledge = read_json(os.path.join(DATA, "knowledge.json"), {})
    extracted = {(v.get("sessionId") or "", str(v.get("messageId") or ""))
                 for v in knowledge.values() if isinstance(v, dict)}

    units = []
    skipped_dead = 0
    # ① 消息来源
    if os.path.isdir(MSGS):
        for name in sorted(os.listdir(MSGS)):
            if not name.endswith(".json"):
                continue
            sid = name[:-5]
            if sid not in live_sids:
                skipped_dead += 1
                continue
            msgs = read_json(os.path.join(MSGS, name), [])
            if not isinstance(msgs, list):
                continue
            for i, m in enumerate(msgs):
                if not isinstance(m, dict) or m.get("role") != "assistant":
                    continue
                content = str(m.get("content") or "").strip()
                if not content or m.get("branchType") in SOCRATIC_BRANCHES:
                    continue
                ts = str(m.get("timestamp") or "")
                if ts and (sid, ts) in extracted:
                    continue
                question = next((str(u.get("content") or "").strip()
                                 for u in reversed(msgs[:i]) if u.get("role") == "user"), "")
                units.append({"key": f"{sid}|msg-{ts or i}", "sessionId": sid,
                              "question": question[:2000], "answer": content[:4000],
                              "source": "message", "messageId": ts})
    # ② kv 图节点来源（主料）
    if os.path.isdir(KV):
        for name in sorted(os.listdir(KV)):
            if not name.endswith(".json"):
                continue
            sid = name[:-5]
            if sid not in live_sids:
                skipped_dead += 1
                continue
            kvd = read_json(os.path.join(KV, name), {})
            graph = kvd.get("graph:" + sid) or {}
            nodes = graph.get("customNodes") or []
            if not isinstance(nodes, list) or not nodes:
                continue
            root_q = next((str(n.get("content") or "").strip() for n in nodes
                           if n.get("isRoot")
                           and str(n.get("content") or "").strip()
                           and not is_code_block(str(n.get("content")).strip())), "")
            if not root_q:
                root_q = next((str(n.get("content") or "").strip() for n in nodes
                               if (n.get("kind") != "module" and not n.get("moduleKey"))
                               and 0 < len(str(n.get("content") or "").strip()) < 200
                               and not is_code_block(str(n.get("content")).strip())), "")
            if not root_q:
                root_q = "（本会话主题：" + (titles.get(sid) or sid) + "）"
            for n in nodes:
                if not isinstance(n, dict) or n.get("moduleKey") not in MODULE_KEYS:
                    continue
                content = str(n.get("content") or "").strip()
                if len(content) < MIN_CONTENT_CHARS or is_code_block(content):
                    continue
                # 记账键带内容短 hash（md5——内置 hash() 每次进程都变，记录会永远对不上），
                # 节点正文改了会当作新单元重提
                short_hash = hashlib.md5(content.encode("utf-8")).hexdigest()[:8]
                units.append({"key": f"{sid}|node-{n.get('id')}-{short_hash}",
                              "sessionId": sid, "question": root_q[:2000],
                              "answer": content[:4000], "source": "graph-node",
                              "messageId": str(n.get("timestamp") or "")})
    if skipped_dead:
        print(f"跳过 {skipped_dead} 个已删除会话的残留文件（不提取，防「已删除的画布」孤岛复活）")
    return units


def start_server(port):
    proc = subprocess.Popen([sys.executable, "src/main.py", "-p", str(port)],
                            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 30
    while time.time() < deadline:
        try:
            http_json(port, "GET", "/health")
            return proc
        except (urllib.error.URLError, ConnectionError, OSError):
            time.sleep(0.4)
    proc.kill()
    raise RuntimeError("服务 30s 内未就绪")


def stop_server(proc):
    try:
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=8)
    except (subprocess.TimeoutExpired, OSError):
        try:
            proc.kill()
        except OSError:
            pass


def main():
    ap = argparse.ArgumentParser(description="老会话存量补提取（大陆存量回填）")
    ap.add_argument("--dry-run", action="store_true", help="只打印计划，不调模型不写库")
    ap.add_argument("--all", action="store_true", help="忽略处理记录全量重提（同标题服务端自动合并）")
    ap.add_argument("--limit", type=int, default=0, help="最多处理 N 个单元（0=不限）")
    ap.add_argument("--port", type=int, default=5093, help="隔离服务实例端口（默认 5093）")
    ap.add_argument("--model", default=os.environ.get("ZHIPU_MODEL", "glm-5.3-flash"),
                    help="提取模型（默认 glm-5.3-flash，可用 ZHIPU_MODEL 覆盖）")
    ap.add_argument("--base-url", default="https://open.bigmodel.cn/api/paas/v4",
                    help="OpenAI 兼容 base_url（默认智谱官方）")
    ap.add_argument("--provider", default="openai", help="供应商标记（默认 openai，兼容口）")
    ap.add_argument("--api-key", default=os.environ.get("ZHIPU_API_KEY", ""),
                    help="API key（默认读 ZHIPU_API_KEY）")
    ap.add_argument("--level", default="university", help="难度等级（默认 university）")
    ap.add_argument("--sleep", type=float, default=0.6, help="两次调用间隔秒数")
    args = ap.parse_args()

    units = collect_units()
    state = load_state()
    todo = [u for u in units if args.all or u["key"] not in state["processed"]]
    if args.limit > 0:
        todo = todo[:args.limit]

    by_sid = {}
    for u in todo:
        by_sid.setdefault(u["sessionId"], []).append(u)
    print(f"提取单元共 {len(units)} 个，待处理 {len(todo)} 个：")
    for sid, us in sorted(by_sid.items(), key=lambda kv: -len(kv[1])):
        print(f"  {sid[:20]} {len(us)} 个（{', '.join(sorted({u['source'] for u in us}))}）")
    if not todo:
        print("没有待处理的单元。")
        return

    if args.dry_run:
        print("\n[dry-run] 不调用模型、不写库。前 5 个单元预览：")
        for u in todo[:5]:
            print(f"  [{u['source']}] {u['sessionId'][:20]} 问:{u['question'][:40]!r} "
                  f"答:{len(u['answer'])}字")
        return

    if not args.api_key:
        print("缺少智谱 API key：请在项目根 .env 里加一行 ZHIPU_API_KEY=你的key"
              "（open.bigmodel.cn 控制台创建），或用 --api-key 传入。")
        sys.exit(2)

    backup_dest = backup()
    print(f"已备份到 {os.path.relpath(backup_dest, ROOT)}")

    knowledge_before = set(read_json(os.path.join(DATA, "knowledge.json"), {}).keys())
    continent_before = None
    proc = start_server(args.port)
    try:
        try:
            continent_before = http_json(args.port, "GET", "/api/continent")
        except Exception as e:
            print(f"（大陆投影读取失败，不影响提取：{e}）")

        done = failed = added_items = 0
        for i, u in enumerate(todo, 1):
            messages = []
            if u["question"]:
                messages.append({"role": "user", "content": u["question"]})
            messages.append({"role": "assistant", "content": u["answer"]})
            payload = {
                "messages": messages, "sessionId": u["sessionId"],
                "provider": args.provider, "api_key": args.api_key,
                "model": args.model, "base_url": args.base_url, "level": args.level,
                # 描述模型用同一把：逐条摘要（summarySource=model）是岛牌真摘要的来源
                "descriptor_provider": args.provider, "descriptor_api_key": args.api_key,
                "descriptor_model": args.model, "descriptor_base_url": args.base_url,
            }
            try:
                resp = http_json(args.port, "POST", "/api/extract_knowledge", payload)
            except Exception as e:
                print(f"  [{i}/{len(todo)}] 提取失败 {u['key'][:40]}: {e}")
                failed += 1
                continue
            items = resp.get("items") or []
            summaries = resp.get("summaries") or {}
            if items:
                body = {}
                now_ms = int(time.time() * 1000)
                for j, it in enumerate(items):
                    title = str(it.get("title") or "").strip()
                    if not title:
                        continue
                    if not it.get("summary") and summaries.get(title):
                        it["summary"] = str(summaries[title])[:120]
                        it["summarySource"] = "model"
                    item_id = f"ki_bf{now_ms:x}{i:x}{j:x}"
                    it["id"] = item_id
                    it["sessionId"] = u["sessionId"]
                    it["messageId"] = u["messageId"]
                    it.setdefault("source", "ai_extract")
                    it.setdefault("createdAt", now_ms)
                    body[item_id] = it
                if body:
                    try:
                        http_json(args.port, "POST", "/api/knowledge", body)
                        added_items += len(body)
                    except Exception as e:
                        print(f"  [{i}/{len(todo)}] 入库失败 {u['key'][:40]}: {e}")
                        failed += 1
                        continue
            state["processed"][u["key"]] = {"at": int(time.time() * 1000),
                                            "items": len(items)}
            save_state(state)
            done += 1
            print(f"  [{i}/{len(todo)}] {u['sessionId'][:20]} "
                  f"{u['source']} -> {len(items)} 条"
                  + ("" if items else "（闸门判空，已记账不重试）"))
            if i < len(todo):
                time.sleep(args.sleep)

        knowledge_after = set(read_json(os.path.join(DATA, "knowledge.json"), {}).keys())
        print(f"\n完成：处理 {done} 个单元，新增知识点 "
              f"{len(knowledge_after - knowledge_before)} 条（提取出 {added_items} 条，"
              f"其余与既有条目按会话+规范标题合并）；失败 {failed} 个。")
        try:
            after = http_json(args.port, "GET", "/api/continent")
            if continent_before:
                def shape(d):
                    return (f"{d.get('clusterCount')} 岛 / {d.get('itemCount')} 卡 / "
                            f"{sum(1 for s in d.get('shared', []) if not s.get('covered'))} 座可画城市")
                print(f"大陆前后：{shape(continent_before)}  ->  {shape(after)}")
            else:
                print(f"大陆现状：{after.get('clusterCount')} 岛 / {after.get('itemCount')} 卡")
        except Exception as e:
            print(f"（大陆投影读取失败：{e}）")
        if failed:
            sys.exit(1)
    finally:
        stop_server(proc)


if __name__ == "__main__":
    load_env()
    main()
