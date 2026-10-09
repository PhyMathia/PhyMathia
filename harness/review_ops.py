"""图操作合成与净化＋tool_call 归一化。

自 review.py 拆出（2026-10-04，T163）：合并后处理（_merge_post_ops 族）、进阶补链、
孤岛自动连线、子图聚焦、快照压缩、journal 落形、只读查询批次判定。全部纯逻辑，
模型调用与 HarnessError 留在 review.py（_compact_snapshot 因 raise HarnessError 一并留守）。
"""
import json
import re
from typing import Any, Dict, Optional

from .core import (
    MAX_SNAPSHOT_CHARS,
    MAX_SNAPSHOT_HARD_CHARS,
    NON_FOCUS_CONTENT_CHARS,
    build_next_snapshot,
    diff_snapshots,
)
from .json_utils import repair_json
from .tools import READONLY_TOOL_NAMES

def _merge_post_ops(current: Dict[str, Any], result: Dict[str, Any], extra_ops: list,
                    diff_base: Any = None) -> Dict[str, Any]:
    """把事后补的操作（自动连边/补链/评价清理）合并进既有结果并重算 diff。

    三处「build_next_snapshot → operations 相加 → diff 重算 → errors append」
    的公共形态（09-20 抽取）。追加的 errors 必须能把 ok 翻成 error——
    此前 status 在 build_next_snapshot 里已定死，事后报错改不了它，
    孤立节点依旧孤立、结果却显示成功。"""
    ops = list(result.get("operations") or [])
    merged = build_next_snapshot(result.get("next_snapshot") or current, extra_ops)
    result["operations"] = ops + list(merged.get("operations") or [])
    result["next_snapshot"] = merged["next_snapshot"]
    result["diff"] = diff_snapshots(diff_base if diff_base is not None else current,
                                    merged["next_snapshot"])
    for err in merged.get("errors") or []:
        result.setdefault("errors", []).append(err)
    if result.get("errors") and result.get("status") == "ok":
        result["status"] = "error"
    return result


def _complete_expand_chains(current: Dict[str, Any], result: Dict[str, Any], focus_node_ids) -> Dict[str, Any]:
    """Deterministic safety net for expand phase:
    1. When the model created answer nodes but forgot the corresponding learn module,
       auto-create one and connect it (answer -> learn).
    2. When the model omitted an answer chain entirely for a focus target
       (known weak-model behavior: merging/omitting multi-target expands),
       auto-create the full chain (answer + learn + target->answer + answer->learn).
    Only runs for created/answered targets; never touches existing nodes."""
    ops = list(result.get("operations") or [])
    answers = []
    learn_ids = set()
    edges = []
    for op in ops:
        name = str(op.get("op") or "")
        node_id = str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")
        if name == "create_node":
            if str(op.get("kind") or "") == "answer":
                answers.append(op)
            elif str(op.get("kind") or "") == "module" and str(op.get("module_key") or "") == "learn":
                if node_id:
                    learn_ids.add(node_id)
        elif name == "add_edge":
            edges.append((str(op.get("from") or ""), str(op.get("to") or "")))
    edge_pairs = set(edges)

    def _ans_id(op):
        return str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "")

    extra_ops = []
    auto_learn_count = 0
    auto_chain_count = 0

    # pass 1: missing learn module for created answers
    for op in answers:
        answer_id = _ans_id(op)
        if not answer_id:
            continue
        if any((answer_id, learn) in edge_pairs for learn in learn_ids):
            continue
        extra_ops.append({
            "op": "create_node",
            "temp_id": "auto_learn_" + answer_id,
            "kind": "module",
            "module_key": "learn",
            "label": "进阶学习",
            "content": str(op.get("content") or "")[:300] or "进阶学习内容",
            "reason": "自动补全进阶学习模块（模型遗漏）",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": answer_id,
            "to": "auto_learn_" + answer_id,
            "relation": "模块",
            "label": "进入进阶内容",
            "reason": "自动补全进阶学习链",
        })
        auto_learn_count += 1

    # pass 2: full missing chain per focus target
    current_nodes = {str(n.get("id")): n for n in (current.get("nodes") or [])}
    answer_ids = set(_ans_id(op) for op in answers if _ans_id(op))
    covered_targets = {
        frm for (frm, to) in edge_pairs
        if to in answer_ids
    }
    for tid in (focus_node_ids or []):
        tid = str(tid)
        if tid in covered_targets or tid not in current_nodes:
            continue
        target_label = str(current_nodes[tid].get("label") or current_nodes[tid].get("title") or tid)
        ans_temp = "auto_ans_" + tid
        learn_temp = "auto_learn_" + tid
        extra_ops.append({
            "op": "create_node",
            "temp_id": ans_temp,
            "kind": "answer",
            "label": target_label + "的进阶学习",
            "content": "深入「" + target_label + "」的高阶方向与应用（正文由内容生成流程填充）",
            "reason": "自动补全进阶学习链（模型遗漏该目标）",
        })
        extra_ops.append({
            "op": "create_node",
            "temp_id": learn_temp,
            "kind": "module",
            "module_key": "learn",
            "label": "进阶学习",
            "content": "进阶方向占位（正文由内容生成流程填充）",
            "reason": "自动补全进阶学习链（模型遗漏该目标）",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": tid,
            "to": ans_temp,
            "relation": "进阶",
            "label": "深入" + target_label,
            "reason": "自动补全进阶学习链",
        })
        extra_ops.append({
            "op": "add_edge",
            "from": ans_temp,
            "to": learn_temp,
            "relation": "模块",
            "label": "进入进阶内容",
            "reason": "自动补全进阶学习链",
        })
        auto_chain_count += 1

    if not extra_ops:
        return result
    _merge_post_ops(current, result, extra_ops)
    reasons = []
    if auto_learn_count:
        reasons.append("为 " + str(auto_learn_count) + " 个 AI 回答节点自动补全进阶学习模块")
    if auto_chain_count:
        reasons.append("为 " + str(auto_chain_count) + " 个目标知识点自动补全进阶学习链（模型遗漏）")
    if reasons:
        result.setdefault("warnings", []).append({
            "index": "auto-expand",
            "op": "create_node",
            "reason": "；".join(reasons),
        })
    return result

def _auto_connect_isolated(current: Dict[str, Any], result: Dict[str, Any], focus_node_ids, instruction: str = "") -> Dict[str, Any]:
    """Deterministic safety net: connect created nodes that ended up isolated
    (no add_edge referencing them) to the focus node, or to the first existing
    node when there is no focus. Never runs for evaluate/apply phases."""
    text = str(instruction or "")
    if any(word in text for word in ("独立", "单独", "不要连接", "不连接")):
        return result
    ops = list(result.get("operations") or [])
    created = [op for op in ops if str(op.get("op")) == "create_node"]
    if not created:
        return result
    edge_endpoints = set()
    for op in ops:
        if str(op.get("op")) == "add_edge":
            if op.get("from"):
                edge_endpoints.add(str(op.get("from")))
            if op.get("to"):
                edge_endpoints.add(str(op.get("to")))
    isolated = [
        op for op in created
        if str(op.get("assigned_id") or op.get("id") or op.get("temp_id") or "") not in edge_endpoints
    ]
    if not isolated:
        return result
    # 锚点从合并后快照的存活节点里选：current 是操作应用前的图，同批
    # 「删第一个节点 + 建孤立节点」会把锚连到已删节点上报「起点不存在」，
    # 孤立节点依旧孤立（09-20 修复）
    live_ids = [str(node.get("id"))
                for node in (result.get("next_snapshot") or {}).get("nodes", [])]
    existing_ids = live_ids or [str(node.get("id")) for node in current.get("nodes", [])]
    anchors = [str(item) for item in (focus_node_ids or []) if str(item) in existing_ids]
    anchor = anchors[0] if anchors else (existing_ids[0] if existing_ids else None)
    if not anchor:
        return result
    extra_ops = [
        {
            "op": "add_edge",
            "from": anchor,
            "to": str(op.get("assigned_id") or op.get("id") or op.get("temp_id")),
            "relation": "关联",
            "label": "自动连接（避免孤立节点）",
            "reason": "自动连接（避免孤立节点）",
        }
        for op in isolated
    ]
    _merge_post_ops(current, result, extra_ops)
    result.setdefault("warnings", []).append({
        "index": "auto-connect",
        "op": "add_edge",
        "reason": "为 " + str(len(extra_ops)) + " 个孤立新节点自动连接到「" + anchor + "」",
    })
    return result


def _fallback_summary(ops: list) -> str:
    """Build a compact, human-readable Chinese summary from validated operations
    when the model returned no text (common with tool-calling where content is empty).
    Uses labels attached by core.py; never exposes raw node ids or edge keys."""
    counts = {
        "create_node": 0, "create_eval_node": 0, "update_node": 0,
        "delete_node": 0, "add_edge": 0, "remove_edge": 0, "update_edge": 0,
    }
    details = []
    for op in ops or []:
        name = str(op.get("op") or op.get("type") or "")
        if name in counts:
            counts[name] += 1
        label = str(op.get("label") or op.get("title") or "")
        frm = str(op.get("from_label") or op.get("from") or "")
        to = str(op.get("to_label") or op.get("to") or "")
        target = str(op.get("target_label") or op.get("target") or op.get("target_node_id") or "")
        if name == "create_node":
            details.append("新增「" + (label or "节点") + "」")
        elif name == "create_eval_node":
            details.append("为「" + (target or label or "目标节点") + "」生成评价")
        elif name == "update_node":
            details.append("修改「" + (label or "节点") + "」")
        elif name == "delete_node":
            details.append("删除「" + (label or "节点") + "」")
        elif name == "add_edge":
            details.append("新增连线「" + (frm or "上游") + "」→「" + (to or "下游") + "」")
        elif name == "remove_edge":
            details.append("删除连线「" + (frm or "上游") + "」→「" + (to or "下游") + "」")
        elif name == "update_edge":
            details.append("调整连线「" + (frm or "上游") + "」→「" + (to or "下游") + "」")
    if not details:
        return ""
    count_parts = []
    if counts["create_node"]:
        count_parts.append("新增 " + str(counts["create_node"]) + " 个节点")
    if counts["add_edge"]:
        count_parts.append(str(counts["add_edge"]) + " 条连线")
    if counts["update_node"]:
        count_parts.append("修改 " + str(counts["update_node"]) + " 处")
    if counts["update_edge"]:
        count_parts.append("调整 " + str(counts["update_edge"]) + " 条连线")
    if counts["delete_node"]:
        count_parts.append("删除 " + str(counts["delete_node"]) + " 个节点")
    if counts["remove_edge"]:
        count_parts.append("移除 " + str(counts["remove_edge"]) + " 条连线")
    if counts["create_eval_node"]:
        count_parts.append(str(counts["create_eval_node"]) + " 条评价建议")
    head = ""
    if count_parts:
        head = "好的，已按你的要求完成梳理，共 " + str(len(ops or [])) + " 处调整（" + "、".join(count_parts) + "）。"
    return (head + " " + "；".join(details)).strip()[:300]


def _summarize_errors(errors) -> str:
    lines = []
    for item in errors or []:
        op = item.get("op") or "?"
        reason = item.get("reason") or "?"
        lines.append(f"- operation {item.get('index', '?')} ({op}): {reason}")
    return "\n".join(lines)




def _focus_subgraph(snapshot: Dict[str, Any], focus_node_ids, max_hops: int = 2, max_nodes: int = 40) -> Optional[Dict[str, Any]]:
    """快照过大且有焦点时，抽取焦点节点邻域子图（焦点 + 至多 max_hops 跳邻居）。

    返回新快照（含 omitted_node_count），无法抽取（无焦点/无邻居）时返回 None。
    只保留焦点邻域内的节点与连线，显著减小发送给模型的上下文。
    """
    nodes = snapshot.get("nodes") or []
    edges = snapshot.get("edges") or []
    focus = {str(item) for item in (focus_node_ids or []) if str(item)}
    if not focus:
        return None
    node_by_id = {str(n.get("id")): n for n in nodes}
    adj = {}
    for e in edges:
        frm = str(e.get("from") or "")
        to = str(e.get("to") or "")
        if frm:
            adj.setdefault(frm, set()).add(to)
        if to:
            adj.setdefault(to, set()).add(frm)
    kept = {nid for nid in focus if nid in node_by_id}
    if not kept:
        return None
    frontier = set(kept)
    for _ in range(max_hops):
        if len(kept) >= max_nodes:
            break
        nxt = set()
        for nid in frontier:
            for nb in adj.get(nid, ()):
                if nb in node_by_id and nb not in kept and len(kept) < max_nodes:
                    kept.add(nb)
                    nxt.add(nb)
        if not nxt:
            break
        frontier = nxt
    # 保留 AI 评价节点
    for n in nodes:
        if n.get("kind") == "ai_eval" and str(n.get("id")) not in kept and len(kept) < max_nodes:
            kept.add(str(n.get("id")))
    kept_edges = [e for e in edges if str(e.get("from") or "") in kept and str(e.get("to") or "") in kept]
    kept_nodes = [node_by_id[nid] for nid in kept if nid in node_by_id]
    result = {
        "nodes": kept_nodes,
        "edges": kept_edges,
        "omitted_node_count": len(nodes) - len(kept_nodes),
    }
    # M2：薄弱点不是图元素，抽邻域子图时原样带过去（否则大图一降采样提示词就看不到薄弱点）
    if snapshot.get("quiz_weak"):
        result["quiz_weak"] = snapshot["quiz_weak"]
    # 大陆 v3：跨画布共享点同理——它是提示词参考字段，不随节点裁剪丢失
    if snapshot.get("continent_shared"):
        result["continent_shared"] = snapshot["continent_shared"]
    # P3 节点配方：user_recipes 是用户配方清单摘要，与 quiz_weak/continent_shared
    # 同为提示词参考字段（Φ 据它查重/引用 recipe_id），本身不是图节点，大图降采样
    # 时同样必须透传——否则快照一大就看不到配方清单（T234）
    if snapshot.get("user_recipes"):
        result["user_recipes"] = snapshot["user_recipes"]
    return result



# ---- T96 会话事件日志：模型往返捕获（journal 由 api 层传入，None 时零开销） ----
# 每条 journal 记录一次真实模型调用的进与出。messages 只在首轮存全文——重试轮的
# 消息体 = 首轮 + retry_feedback 追加，存反馈文本即可无损重建，避免每轮重复背
# 一整份快照把日志撑大。长度上限按「够重放」取，超限截断并打标。
_JOURNAL_MESSAGE_CAP = 32000
_JOURNAL_RAW_CAP = 30000
_JOURNAL_REASONING_CAP = 8000


def _journal_raw_dict(raw: Dict[str, Any]) -> Dict[str, Any]:
    """模型原话（剥思考前的正文 + 思维链 + 工具调用），截长落盘。

    测试桩的 _call_model 返回不含 raw_content（固定形状），退回 content——
    桩路径本来也没有思考原文可记。"""
    content = raw.get("raw_content")
    if content is None:
        content = raw.get("content")
    content = str(content or "")
    reasoning = str(raw.get("reasoning_content") or "")
    return {
        "content": content[:_JOURNAL_RAW_CAP],
        "content_truncated": len(content) > _JOURNAL_RAW_CAP or None,
        "reasoning_content": reasoning[:_JOURNAL_REASONING_CAP],
        "reasoning_truncated": len(reasoning) > _JOURNAL_REASONING_CAP or None,
        "tool_calls": raw.get("tool_calls") or [],
    }


def _journal_roundtrip(
    journal: Optional[list],
    stage: str,
    raw: Dict[str, Any],
    attempt: int = 0,
    retry_feedback: str = "",
    fallback: str = "",
    messages: Optional[list] = None,
    step: Optional[int] = None,
) -> None:
    if journal is None:
        return
    entry: Dict[str, Any] = {"stage": stage, "attempt": attempt}
    if step is not None:
        entry["step"] = int(step)
    if fallback:
        entry["fallback"] = fallback
    if retry_feedback:
        entry["retry_feedback"] = str(retry_feedback)[:2000]
    if messages is not None:
        shaped = []
        for m in messages:
            content = str(m.get("content") or "")
            item = {"role": str(m.get("role") or ""), "content": content[:_JOURNAL_MESSAGE_CAP]}
            if len(content) > _JOURNAL_MESSAGE_CAP:
                item["content_truncated"] = True
            shaped.append(item)
        entry["messages"] = shaped
    entry["raw"] = _journal_raw_dict(raw)
    journal.append(entry)
# ---- T93 只读查询回灌：tool_call 归一化与批次判定 ----

def _tool_call_name_args(call: Any) -> tuple:
    """取一个 tool_call 的 (name, arguments dict)；参数串非法/非对象给空 dict。"""
    if not isinstance(call, dict):
        return "", {}
    fn = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(fn.get("name") or "").strip()
    raw_args = fn.get("arguments")
    if isinstance(raw_args, dict):
        return name, raw_args
    text = str(raw_args or "").strip()
    if not text:
        return name, {}
    try:
        args = json.loads(text)
    except (json.JSONDecodeError, ValueError, TypeError):
        args = repair_json(raw_args)
    return name, args if isinstance(args, dict) else {}


def _readonly_batch(tool_calls: Any) -> list:
    """本批 tool_calls 里的只读查询调用；空列表＝无需进入查询循环。"""
    if not isinstance(tool_calls, list):
        return []
    batch = []
    for call in tool_calls:
        name, _args = _tool_call_name_args(call)
        if name in READONLY_TOOL_NAMES:
            batch.append(call)
    return batch


def _assistant_tool_message(raw: Dict[str, Any]) -> Dict[str, Any]:
    """把模型输出归一化成 assistant 回声消息（tool_calls 形状与回灌一致）。

    id 缺失时补 call_<n>——role:"tool" 消息的 tool_call_id 必须与它逐条对上，
    否则上游/网关会拒整段对话。"""
    calls = raw.get("tool_calls") if isinstance(raw, dict) else None
    shaped = []
    for index, call in enumerate(calls or []):
        if not isinstance(call, dict):
            call = {}
        fn = call.get("function") if isinstance(call.get("function"), dict) else {}
        args = fn.get("arguments")
        if not isinstance(args, str):
            args = json.dumps(args if args is not None else {}, ensure_ascii=False)
        shaped.append({
            "id": str(call.get("id") or f"call_{index + 1}"),
            "type": "function",
            "function": {
                "name": str(fn.get("name") or ""),
                "arguments": args,
            },
        })
    return {
        "role": "assistant",
        "content": str((raw or {}).get("content") or ""),
        "tool_calls": shaped,
    }


def _readonly_call_arg(name: str, args: Dict[str, Any]) -> str:
    """进度事件里的查询参数预览（read_node/list_neighbors 取节点，search* 取词）。"""
    key = "node_id" if name in ("read_node", "list_neighbors") else "keyword"
    return str(args.get(key) or args.get("id") or args.get("label") or "")[:60]


def _readonly_tool_label(name: str) -> str:
    """查询轮进度事件的来源标签：图查询 / 知识库 / 公式速查。"""
    if name == "search_knowledge":
        return "知识库"
    if name == "search_formulas":
        return "公式速查"
    return "图中信息"
