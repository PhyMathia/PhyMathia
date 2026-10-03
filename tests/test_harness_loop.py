"""T93（评审路线 #8）只读查询回灌循环 + T82 相位识别收敛（后端超集）回归。

覆盖：
- build_tools：normal/expand/apply/preset 含五只读工具（图查询三件套＋知识检索
  两件套，2026-10-03 扩容）；evaluate 不含、chat 为纯只读表；
- execute_readonly_tool 直测：read_node 按 id/按 label/未找到、list_neighbors
  方向与关系/截断、search_nodes label 优先/截断、search_knowledge/search_formulas
  知识检索命中/空库/不可用/截断、坏参数返回 error 不抛；
- review_graph 查询循环：两步（查→改）回灌形状、完整快照全文回灌（非压缩版）、
  同批编辑调用延迟、步数上限剥只读工具、chat 纯只读表＋专用提示、journal
  step/tool_results、SSE tool/model 事件、查询轮 HarnessError 交外层换模型
  候选链接住、知识检索工具回灌真实结果（normal 与 chat 两相位）；
- T82：后端关键词表逐词覆盖前端旧正则；payload phase=normal 时由 _detect_phase
  重判（评价/采纳建议/改成/重写）、显式 expand 直通不受关键词影响。

桩形态照旧：patch.object(review_mod, "_call_model", new=fake)，固定签名带
on_delta=None；fake 按调用序返回不同结果并记录每次收到的 messages/tools。
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import unittest
from unittest import mock


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from harness import review as review_mod
from harness.core import normalize_snapshot
from harness.review import (
    APPLY_HINTS,
    EVALUATE_HINTS,
    EXPAND_HINTS,
    MODIFY_HINTS,
    _detect_phase,
)
from harness.tools import (
    PHASE_TOOLS,
    READONLY_TOOL_NAMES,
    build_tools,
    execute_readonly_tool,
)

MODEL = {"provider": "opencode", "model": "m", "base_url": "https://x", "api_key": ""}
BACKUP = {"provider": "opencode", "model": "backup", "base_url": "https://x", "api_key": ""}

SNAPSHOT = {
    "version": 1,
    "nodes": [
        {"id": "A", "kind": "knowledge", "label": "导数", "content": "瞬时变化率"},
        {"id": "B", "kind": "knowledge", "label": "极限", "content": "无穷接近"},
    ],
    "edges": [{
        "key": "A:out-0->B:in-0", "from": "A", "to": "B",
        "fromPort": "out-0", "toPort": "in-0",
        "relation": "依赖", "label": "先学极限",
    }],
}


def _tool_call(name, args, call_id="call_1"):
    return {
        "id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)},
    }


def _llm(tool_calls=None, content=""):
    return {"content": content, "tool_calls": tool_calls}


def _recording_fake(results, seen):
    """按调用序返回预排结果，并把每次收到的 messages/tools 深拷进 seen。"""

    async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                   json_mode=False, on_delta=None):
        seen.append({
            "messages": json.loads(json.dumps(messages, ensure_ascii=False)),
            "tools": tools,
            "tool_choice": tool_choice,
            "json_mode": json_mode,
            "model": model["model"],
        })
        index = min(len(seen) - 1, len(results) - 1)
        item = results[index]
        if isinstance(item, BaseException):
            raise item
        return item

    return fake


def _run_review(fake, *, snapshot=None, instruction="修改节点 A 的标题", phase="normal",
                progress=None, journal=None, fallbacks=None, retries=0, focus=None):
    with mock.patch.object(review_mod, "_call_model", new=fake):
        return asyncio.run(review_mod.review_graph(
            snapshot or dict(SNAPSHOT),
            instruction,
            model=dict(MODEL),
            phase=phase,
            retries=retries,
            self_check="off",
            progress=progress,
            journal=journal,
            fallback_models=fallbacks,
            focus_node_ids=focus,
        ))


def _http_error(status):
    err = review_mod.HarnessError(f"模型返回 {status}: upstream busy")
    err.status_code = status
    return err


class ReadonlyToolsTableTest(unittest.TestCase):
    def test_edit_phases_get_readonly_tools(self):
        for phase in ("normal", "expand", "apply", "preset"):
            names = [schema["function"]["name"] for schema in build_tools(phase)]
            for readonly in READONLY_TOOL_NAMES:
                self.assertIn(readonly, names, f"{phase} 缺少 {readonly}")

    def test_evaluate_stays_single_round_chat_is_readonly_only(self):
        # 2026-10-03 智能化第二期：evaluate 维持单轮（无只读工具）；
        # chat 反转为纯只读工具表（图查询＋知识检索），编辑工具不在表里
        names = [schema["function"]["name"] for schema in build_tools("evaluate")]
        for readonly in READONLY_TOOL_NAMES:
            self.assertNotIn(readonly, names, "evaluate 不应含只读工具")
        self.assertEqual(
            sorted(schema["function"]["name"] for schema in build_tools("chat")),
            sorted(READONLY_TOOL_NAMES),
        )

    def test_readonly_schemas_required_params(self):
        schemas = {s["function"]["name"]: s for s in build_tools("normal")}
        for name in ("read_node", "list_neighbors"):
            params = schemas[name]["function"]["parameters"]
            self.assertEqual(params["required"], ["node_id"])
            self.assertIn("node_id", params["properties"])
        for name in ("search_nodes", "search_knowledge", "search_formulas"):
            search = schemas[name]["function"]["parameters"]
            self.assertEqual(search["required"], ["keyword"])


class ExecuteReadonlyToolTest(unittest.TestCase):
    def setUp(self):
        self.snap = normalize_snapshot(SNAPSHOT)

    def test_read_node_by_id_returns_full_fields(self):
        snap = normalize_snapshot({
            "nodes": [{
                "id": "A", "kind": "module", "label": "物理视角",
                "content": "完整正文", "formula": "F=ma", "module_key": "physics",
                "priority": "high", "status": "done", "read_only": True,
            }],
            "edges": [],
        })
        out = execute_readonly_tool("read_node", {"node_id": "A"}, snap)
        self.assertTrue(out["found"])
        node = out["node"]
        self.assertEqual(node["id"], "A")
        self.assertEqual(node["content"], "完整正文")
        self.assertEqual(node["formula"], "F=ma")
        self.assertEqual(node["module_key"], "physics")
        self.assertEqual(node["priority"], "high")
        self.assertEqual(node["status"], "done")
        self.assertTrue(node["read_only"])
        # 全字段都在（与 core.normalize_node 输出一致）
        for key in ("kind", "label", "manual", "target_node_id", "target_label", "suggestion"):
            self.assertIn(key, node)

    def test_read_node_by_label_when_id_misses(self):
        out = execute_readonly_tool("read_node", {"node_id": "极限"}, self.snap)
        self.assertTrue(out["found"])
        self.assertEqual(out["node"]["id"], "B")

    def test_read_node_not_found(self):
        out = execute_readonly_tool("read_node", {"node_id": "不存在"}, self.snap)
        self.assertFalse(out["found"])
        self.assertIn("未找到节点", out["error"])

    def test_list_neighbors_direction_relation_and_edge_meta(self):
        out = execute_readonly_tool("list_neighbors", {"node_id": "A"}, self.snap)
        self.assertTrue(out["found"])
        self.assertEqual(out["count"], 1)
        item = out["neighbors"][0]
        self.assertEqual(item["neighbor_id"], "B")
        self.assertEqual(item["neighbor_label"], "极限")
        self.assertEqual(item["direction"], "out")
        self.assertEqual(item["relation"], "依赖")
        self.assertEqual(item["edge_label"], "先学极限")
        self.assertEqual(item["edge_key"], "A:out-0->B:in-0")
        back = execute_readonly_tool("list_neighbors", {"node_id": "B"}, self.snap)
        self.assertEqual(back["neighbors"][0]["direction"], "in")
        self.assertEqual(back["neighbors"][0]["neighbor_id"], "A")

    def test_list_neighbors_missing_node(self):
        out = execute_readonly_tool("list_neighbors", {"node_id": "Z"}, self.snap)
        self.assertFalse(out["found"])
        self.assertIn("未找到节点", out["error"])

    def test_list_neighbors_truncates_at_40(self):
        nodes = [{"id": "A", "kind": "knowledge", "label": "中心", "content": ""}]
        edges = []
        for index in range(45):
            node_id = f"N{index}"
            nodes.append({"id": node_id, "kind": "knowledge", "label": node_id, "content": ""})
            edges.append({"key": f"A:out-0->{node_id}:in-0", "from": "A", "to": node_id})
        snap = normalize_snapshot({"nodes": nodes, "edges": edges})
        out = execute_readonly_tool("list_neighbors", {"node_id": "A"}, snap)
        self.assertEqual(out["count"], 40)
        self.assertEqual(out["total"], 45)
        self.assertTrue(out["truncated"])

    def test_search_nodes_label_first_and_truncated(self):
        nodes = []
        for index in range(2):
            nodes.append({"id": f"L{index}", "kind": "knowledge",
                          "label": f"导数应用{index}", "content": "标签命中"})
        for index in range(12):
            nodes.append({"id": f"C{index}", "kind": "knowledge",
                          "label": f"内容节点{index}", "content": "正文里提到导数" + "x" * 100})
        snap = normalize_snapshot({"nodes": nodes, "edges": []})
        out = execute_readonly_tool("search_nodes", {"keyword": "导数"}, snap)
        self.assertEqual(out["count"], 10)
        self.assertTrue(out["truncated"])
        self.assertEqual(out["total"], 14)
        self.assertEqual([m["id"] for m in out["matches"][:2]], ["L0", "L1"])
        for match in out["matches"]:
            self.assertLessEqual(len(match["excerpt"]), 80)
            self.assertEqual(match["kind"], "knowledge")

    def test_bad_arguments_return_error_without_raising(self):
        cases = [
            ("read_node", "not-a-dict", self.snap),
            ("read_node", {}, self.snap),
            ("list_neighbors", {}, self.snap),
            ("search_nodes", {}, self.snap),
            ("nope_tool", {"node_id": "A"}, self.snap),
            ("read_node", {"node_id": "A"}, None),
        ]
        for name, args, snap in cases:
            out = execute_readonly_tool(name, args, snap)
            self.assertIsInstance(out, dict)
            self.assertIn("error", out)


class QueryLoopTest(unittest.TestCase):
    def test_two_step_query_then_edit(self):
        seen = []
        fake = _recording_fake([
            _llm([_tool_call("read_node", {"node_id": "A"}, "call_1")]),
            _llm([_tool_call("update_node",
                             {"node_id": "A", "patch": {"label": "瞬时变化率"}, "reason": "更准确"},
                             "call_2")]),
        ], seen)
        result = _run_review(fake)
        self.assertEqual(len(seen), 2)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["model_calls"], 2)
        self.assertEqual(result["operations"][0]["op"], "update_node")
        # 第 2 次调用收到：assistant 回声 + role:tool 结果（tool_call_id 对得上）
        messages = seen[1]["messages"]
        assistant = [m for m in messages if m.get("role") == "assistant" and m.get("tool_calls")]
        self.assertEqual(len(assistant), 1)
        call = assistant[0]["tool_calls"][0]
        self.assertEqual(call["type"], "function")
        self.assertEqual(call["function"]["name"], "read_node")
        self.assertIsInstance(call["function"]["arguments"], str)
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 1)
        self.assertEqual(tool_msgs[0]["tool_call_id"], call["id"])
        payload = json.loads(tool_msgs[0]["content"])
        self.assertTrue(payload["found"])
        self.assertEqual(payload["node"]["id"], "A")
        self.assertEqual(payload["node"]["content"], "瞬时变化率")

    def test_read_node_gets_uncompacted_full_snapshot(self):
        marker = "乙全文标记"
        nodes = []
        for index in range(42):
            nodes.append({"id": f"N{index}", "kind": "knowledge", "label": f"节点{index}",
                          "content": "甲" * 1000})
        nodes.append({"id": "TARGET", "kind": "knowledge", "label": "目标节点",
                      "content": "甲" * 900 + marker + "丙" * 100})
        snapshot = {"version": 1, "nodes": nodes, "edges": []}
        seen = []
        fake = _recording_fake([
            _llm([_tool_call("read_node", {"node_id": "TARGET"}, "call_1")]),
            _llm([_tool_call("update_node",
                             {"node_id": "TARGET", "patch": {"status": "done"}, "reason": "收尾"},
                             "call_2")]),
        ], seen)
        result = _run_review(fake, snapshot=snapshot, instruction="更新目标节点")
        self.assertEqual(result["status"], "ok")
        # 发给模型的快照被压缩过（目录行不含第 900 字之后的正文）
        first_user = seen[0]["messages"][-1]["content"]
        self.assertNotIn(marker, first_user)
        # 但 read_node 的结果是完整快照的全文（证明取数源不是压缩版）
        tool_msg = [m for m in seen[1]["messages"] if m.get("role") == "tool"][0]
        self.assertIn(marker, tool_msg["content"])

    def test_mixed_batch_defers_edit_until_next_round(self):
        seen = []
        fake = _recording_fake([
            _llm([
                _tool_call("read_node", {"node_id": "A"}, "call_1"),
                _tool_call("update_node",
                           {"node_id": "A", "patch": {"label": "旧稿"}, "reason": "先改"},
                           "call_2"),
            ]),
            _llm([_tool_call("update_node",
                             {"node_id": "A", "patch": {"label": "定稿"}, "reason": "看完再改"},
                             "call_3")]),
        ], seen)
        result = _run_review(fake)
        self.assertEqual(len(seen), 2)
        tool_msgs = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 2)
        read_payload = json.loads(tool_msgs[0]["content"])
        self.assertTrue(read_payload["found"])
        deferred = json.loads(tool_msgs[1]["content"])
        self.assertTrue(deferred["deferred"])
        self.assertIn("暂存", deferred["note"])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["operations"][0]["patch"]["label"], "定稿")

    def test_step_limit_strips_readonly_tools_and_notices(self):
        seen = []
        reads = [_llm([_tool_call("read_node", {"node_id": "A"}, f"call_{i}")]) for i in range(9)]
        fake = _recording_fake(reads, seen)
        _run_review(fake)
        self.assertEqual(len(seen), review_mod.MAX_TOOL_STEPS + 1)
        last = seen[-1]
        names = [schema["function"]["name"] for schema in (last["tools"] or [])]
        for readonly in READONLY_TOOL_NAMES:
            self.assertNotIn(readonly, names)
        self.assertTrue(any("查询步数已达上限" in str(m.get("content") or "") for m in last["messages"]))

    def test_chat_phase_offers_readonly_tools_only(self):
        # 2026-10-03：chat 工具表＝五只读工具（先查再答），编辑工具一个都没有
        seen = []
        fake = _recording_fake([_llm(None, "这是一张关于导数的图")], seen)
        result = _run_review(fake, phase="chat", instruction="这个图讲了什么")
        self.assertEqual(result["phase"], "chat")
        names = [schema["function"]["name"] for schema in (seen[0]["tools"] or [])]
        self.assertEqual(sorted(names), sorted(READONLY_TOOL_NAMES))
        # chat 专用提示：讲「先查再答」，不讲通用 AUTO 提示的「要求修改图请使用工具」
        user_text = seen[0]["messages"][-1]["content"]
        self.assertIn("答疑模式", user_text)
        self.assertIn("search_knowledge", user_text)
        self.assertNotIn("如果用户要求修改图，请使用工具", user_text)

    def test_journal_records_query_step_and_tool_results(self):
        journal = []
        fake = _recording_fake([
            _llm([_tool_call("read_node", {"node_id": "A"}, "call_1")]),
            _llm([_tool_call("update_node",
                             {"node_id": "A", "patch": {"label": "新"}, "reason": "改"},
                             "call_2")]),
        ], [])
        _run_review(fake, journal=journal)
        query_entries = [e for e in journal if e.get("tool_results")]
        self.assertEqual(len(query_entries), 1)
        entry = query_entries[0]
        self.assertEqual(entry["stage"], "generate")
        self.assertEqual(entry["step"], 1)
        self.assertNotIn("messages", entry)
        self.assertEqual(entry["tool_results"][0]["name"], "read_node")
        self.assertTrue(entry["tool_results"][0]["ok"])
        self.assertGreater(entry["tool_results"][0]["chars"], 0)
        # 查询轮的模型原话也落一条（带 step，不重复存 messages）
        raw_steps = [e for e in journal if e.get("step") == 1 and e.get("raw") and "tool_results" not in e]
        self.assertTrue(raw_steps)

    def test_sse_tool_and_model_step_events(self):
        events = []
        fake = _recording_fake([
            _llm([_tool_call("read_node", {"node_id": "A"}, "call_1")]),
            _llm([_tool_call("update_node",
                             {"node_id": "A", "patch": {"label": "新"}, "reason": "改"},
                             "call_2")]),
        ], [])
        _run_review(fake, progress=events.append)
        tool_events = [e for e in events if e.get("type") == "status" and e.get("stage") == "tool"]
        self.assertEqual(len(tool_events), 1)
        self.assertEqual(tool_events[0]["step"], 1)
        self.assertIn("read_node", tool_events[0]["message"])
        model_steps = [e.get("step") for e in events if e.get("stage") == "model"]
        self.assertEqual(model_steps[0], 0)
        self.assertIn(1, model_steps)

    def test_query_round_error_reaches_model_fallback_chain(self):
        seen = []
        calls = {"primary": 0}

        async def fake(messages, model, max_tokens, tools=None, tool_choice=None,
                       json_mode=False, on_delta=None):
            seen.append(model["model"])
            if model["model"] == "m":
                calls["primary"] += 1
                if calls["primary"] == 1:
                    return _llm([_tool_call("read_node", {"node_id": "A"}, "call_1")])
                raise _http_error(503)
            return _llm([_tool_call("update_node",
                                    {"node_id": "A", "patch": {"label": "备胎改"}, "reason": "兜底"},
                                    "call_9")])

        result = _run_review(fake, fallbacks=[dict(BACKUP)])
        self.assertEqual(seen[0], "m")
        self.assertEqual(seen[-1], "backup")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["fallback_used"], {"provider": "opencode", "model": "backup"})


class PhaseConvergenceTest(unittest.TestCase):
    def setUp(self):
        self.snap = {"nodes": [{"id": "A", "kind": "knowledge"}], "edges": []}
        self.with_eval = {
            "nodes": [{"id": "A", "kind": "knowledge"}, {"id": "E", "kind": "ai_eval"}],
            "edges": [],
        }

    def test_backend_tables_cover_frontend_regex_words(self):
        # 前端旧 _detectHarnessPhase 正则的逐词快照（收敛前 harness.js:724-735）。
        # 前端不再本地判 normal/evaluate，后端表必须覆盖每一个分支。
        frontend_words = {
            MODIFY_HINTS: "修改 改成 更正 纠正 重写 更新 删掉 删除 补充 新增 创建 连接 加上 加一个 补一个 改进 完善".split(),
            EVALUATE_HINTS: "评价 建议 反馈 点评 指出 哪里需要改进 挑错 有问题吗 对不对 哪里不对 帮我看看".split(),
            EXPAND_HINTS: "拓展 进阶 延伸学习 深入学习 深化".split(),
            APPLY_HINTS: "应用建议 采纳建议 按建议 执行建议".split(),
        }
        for backend, words in frontend_words.items():
            for word in words:
                self.assertIn(word, backend, f"后端关键词表缺少前端词：{word}")

    def test_detect_phase_new_word_cases(self):
        self.assertEqual(_detect_phase("normal", "把标题改成X", self.snap), "normal")
        self.assertEqual(_detect_phase("normal", "重写第二个节点", self.snap), "normal")
        self.assertEqual(_detect_phase("normal", "帮我看看这张图", self.snap), "evaluate")
        self.assertEqual(_detect_phase("normal", "评价一下", self.snap), "evaluate")
        self.assertEqual(_detect_phase("normal", "采纳建议", self.with_eval), "apply")
        # 显式入口/模式锁直通，不受关键词影响
        self.assertEqual(_detect_phase("expand", "评价一下这个图", self.snap), "expand")
        self.assertEqual(_detect_phase("apply", "随便说点什么", self.snap), "apply")

    def test_payload_normal_rerouted_to_evaluate_by_backend(self):
        seen = []
        fake = _recording_fake([
            _llm([_tool_call("create_eval_node",
                             {"temp_id": "e1", "target_node_id": "A",
                              "suggestion": "补公式", "reason": "评价"},
                             "call_1")]),
        ], seen)
        result = _run_review(fake, phase="normal", instruction="评价一下这个图")
        self.assertEqual(result["phase"], "evaluate")
        self.assertEqual(result["operations"][0]["op"], "create_eval_node")

    def test_payload_normal_apply_with_eval_nodes(self):
        snapshot = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "变化率"},
                {"id": "E", "kind": "ai_eval", "label": "AI 建议", "target_node_id": "A",
                 "suggestion": "补公式", "priority": "high"},
            ],
            "edges": [],
        }
        fake = _recording_fake([
            _llm([_tool_call("update_node",
                             {"node_id": "A", "patch": {"formula": "f'(x)"}, "reason": "采纳建议"},
                             "call_1")]),
        ], [])
        result = _run_review(fake, snapshot=snapshot, phase="normal", instruction="采纳建议")
        self.assertEqual(result["phase"], "apply")
        self.assertTrue(any(op.get("op") == "update_node" for op in result["operations"]))

    def test_payload_expand_passthrough_unaffected_by_keywords(self):
        fake = _recording_fake([_llm(None, "好的")], [])
        result = _run_review(fake, phase="expand", instruction="评价一下这个图")
        self.assertEqual(result["phase"], "expand")


class KnowledgeToolsTest(unittest.TestCase):
    """2026-10-03 智能化第二期：search_knowledge / search_formulas 直测。"""

    KB = {
        "knowledge": [
            {"title": "梯度的定义", "category": "math", "tags": ["向量分析"],
             "summary": "梯度是标量场偏导数组合成的矢量场", "formulas": ["$\\nabla f$"]},
            {"title": "阻尼振动", "category": "physics", "tags": ["振动"],
             "summary": "振幅随时间衰减的振动", "formulas": []},
        ],
        "formulas": [
            {"latex": "$\\nabla f = (\\partial f/\\partial x)$", "concept": "梯度的定义",
             "meaning": "梯度方向是增长最快的方向"},
            {"latex": "$F = ma$", "concept": "牛顿第二定律", "meaning": "力等于质量乘加速度"},
        ],
    }

    def test_search_knowledge_hits_title_and_tags(self):
        out = execute_readonly_tool("search_knowledge", {"keyword": "梯度"}, {}, kb=self.KB)
        self.assertEqual(out["total"], 1)
        self.assertEqual(out["matches"][0]["title"], "梯度的定义")
        self.assertEqual(out["matches"][0]["formulas_count"], 1)
        out2 = execute_readonly_tool("search_knowledge", {"keyword": "向量分析"}, {}, kb=self.KB)
        self.assertEqual(out2["total"], 1, "tag 命中也要召回")

    def test_search_knowledge_empty_and_unavailable(self):
        out = execute_readonly_tool("search_knowledge", {"keyword": "x"}, {}, kb={"knowledge": [], "formulas": []})
        self.assertEqual(out["matches"], [])
        self.assertIn("知识库为空", out["note"])
        err = execute_readonly_tool("search_knowledge", {"keyword": "x"}, {}, kb=None)
        self.assertIn("不可用", err["error"])

    def test_search_formulas_hits_concept_and_strips_dollars(self):
        out = execute_readonly_tool("search_formulas", {"keyword": "梯度"}, {}, kb=self.KB)
        self.assertEqual(out["total"], 1)
        self.assertNotIn("$", out["matches"][0]["latex"])
        out2 = execute_readonly_tool("search_formulas", {"keyword": "f = ma"}, {}, kb=self.KB)
        self.assertEqual(out2["total"], 1, "latex 片段命中（大小写不敏感）")

    def test_kb_tools_are_readonly_not_edit(self):
        from harness.tools import KB_TOOL_NAMES, TOOL_TO_OP
        for name in KB_TOOL_NAMES:
            self.assertIn(name, READONLY_TOOL_NAMES)
            self.assertNotIn(name, TOOL_TO_OP)

    def test_search_limit_truncated_flag(self):
        kb = {"knowledge": [{"title": f"振动{i}", "summary": "", "tags": []} for i in range(15)], "formulas": []}
        out = execute_readonly_tool("search_knowledge", {"keyword": "振动"}, {}, kb=kb)
        self.assertEqual(out["count"], 10)
        self.assertEqual(out["total"], 15)
        self.assertTrue(out["truncated"])


class KnowledgeQueryLoopTest(unittest.TestCase):
    """知识检索工具进查询循环：role:"tool" 回灌真实结果；chat 相位先查后答且保险丝兜底。"""

    def test_kb_tool_roundtrip_normal_phase(self):
        seen = []
        fake = _recording_fake([
            _llm([_tool_call("search_knowledge", {"keyword": "梯度"}, "call_1")]),
            _llm([_tool_call("update_node",
                             {"node_id": "A", "patch": {"label": "梯度"}, "reason": "对齐知识库"},
                             "call_2")]),
        ], seen)
        kb = {"knowledge": [{"title": "梯度的定义", "summary": "矢量场", "tags": []}], "formulas": []}
        with mock.patch.object(review_mod, "_load_user_kb", return_value=kb):
            result = _run_review(fake)
        self.assertEqual(result["status"], "ok")
        tool_msg = [m for m in seen[1]["messages"] if m.get("role") == "tool"][0]
        payload = json.loads(tool_msg["content"])
        self.assertEqual(payload["matches"][0]["title"], "梯度的定义")

    def test_chat_query_then_answer_with_fuse(self):
        seen = []
        fake = _recording_fake([
            _llm([_tool_call("search_knowledge", {"keyword": "导数"}, "call_1")]),
            _llm(None, "你图里的『导数』讲的是瞬时变化率；你的知识库也收录了相关笔记。"),
        ], seen)
        kb = {"knowledge": [{"title": "导数", "summary": "瞬时变化率", "tags": []}], "formulas": []}
        events = []

        def progress(event):
            events.append(event)

        with mock.patch.object(review_mod, "_load_user_kb", return_value=kb):
            result = _run_review(fake, phase="chat", instruction="导数是什么", progress=progress)
        self.assertEqual(result["operations"], [], "答疑保险丝必须清空图操作")
        tool_msgs = [m for m in seen[1]["messages"] if m.get("role") == "tool"]
        self.assertEqual(len(tool_msgs), 1)
        self.assertIn("瞬时变化率", tool_msgs[0]["content"])
        tool_events = [e for e in events if e.get("stage") == "tool"]
        self.assertTrue(any("知识库" in e["message"] for e in tool_events), "进度事件应标注检索来源")


if __name__ == "__main__":
    unittest.main()
