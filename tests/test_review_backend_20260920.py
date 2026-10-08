"""2026-09-20 全仓后端复审的回归测试（代码结构优化 + bug 修复轮）。

本轮四个审查代理报告、逐条核实后修复的问题，每个修复至少一条会失败的
回归。分组与修复点一一对应；数据路径统一指向临时目录，不碰真实 data/。

A. main.py / config.py
  - 空消息列表不再清空服务端更长历史（数据丢失路径）
  - resolve_api_key 统一 env 兜底：deepseek env 密钥 + 任意 base_url 必须
    被 SSRF 校验拦下（env_key_used 一路传进提取 helper）
  - GET /chat 不再 500（root 缺 request 参数的回归）
  - sessions 写入口校验 id 白名单；备份导出对历史脏键不再 500
  - 契约外 body 形状（messages/itms 非列表）返回 400 而非 500
B. context.py / knowledge.py / documents.py
  - 滚动记忆注入的第二次预算收缩不再压掉 active 全文保护集
  - 本地文档提取：模块名标题不产空标题节点；截断后边过滤到保留节点
  - 画像 ops：fact 含 `]` 时括号深度扫描仍可解析（懒惰正则整轮丢弃）
C. continent.py / family.py / concept.py / profile.py
  - 脏 updatedAt/createdAt（字符串时间戳）不再把 /api/continent 打成 500
  - merge_families 落实 FAMILY_LIMIT（custom 优先、builtin 靠后截断）
  - _shared_runs 保序去重（重复提及不再重复计分）
  - 画像容量满时被挤出的固化事实落 archive，不静默蒸发
D. harness/
  - parse_tool_calls 接受 dict 型 arguments（此前 TypeError 整次编辑报废）
  - 焦点过滤后逆操作为空 → 明确 no-op，绝不跌回模型路径
  - targeted 撤销保住 restore_node+add_edge 恢复对
  - /graph/undo 缺 before_snapshot → 明确拒绝（不再拿当前态冒充前态；该端点
    2026-10-06 随死代码退役删除，对应测试已移除）
  - 原始 add_edge（无 edge_key）也能生成逆操作
  - diff 签名补 status；patch 的 title/summary 归一到 label/content
  - summary JSON 外壳提取：summary 与 operations 之间夹其他键时取到干净文本
  - _selfcheck_ops 按 provider 门控 required（opencode 走 auto）
"""

import asyncio
import os
import sys
import tempfile
import unittest
import unittest.mock
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import backup as backup_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import continent as continent_mod  # noqa: E402
from server import knowledge as knowledge_mod  # noqa: E402  _ai_extract_knowledge 属主（T163）
from server import context as context_mod  # noqa: E402
from server import documents as documents_mod  # noqa: E402
from server import family as family_mod  # noqa: E402
from server import knowledge as knowledge_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402

_MISSING = object()


def _patched_paths(td):
    return {
        "MESSAGES_DIR": Path(td) / "messages",
        "SESSIONS_PATH": Path(td) / "sessions.json",
        "KNOWLEDGE_PATH": Path(td) / "knowledge.json",
        "FORMULAS_PATH": Path(td) / "formulas.json",
        "KV_PATH": Path(td) / "kv_store.json",
        "KV_DIR": Path(td) / "kv",
        "PROFILES_DIR": Path(td) / "profiles",
    }


class RouteTestBase(unittest.TestCase):
    """数据路径重定向到临时目录（与 test_routes.py 同一套补丁口径）。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        paths = _patched_paths(self._td.name)
        paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
        paths["PROFILES_DIR"].mkdir(parents=True, exist_ok=True)
        self._orig_modules = {}
        for mod in (main_mod, storage_mod, backup_mod, profile_mod):
            for name, value in paths.items():
                self._orig_modules[(id(mod), name)] = getattr(mod, name, _MISSING)
                setattr(mod, name, value)
        self._orig_config = {}
        for name, value in paths.items():
            self._orig_config[name] = getattr(config_mod, name, _MISSING)
            setattr(config_mod, name, value)
        storage_mod._JSON_READ_CACHE.clear()
        self.client = TestClient(main_mod.app)

    def tearDown(self):
        for (mid, name), value in self._orig_modules.items():
            for mod in (main_mod, storage_mod, backup_mod, profile_mod):
                if id(mod) == mid:
                    if value is _MISSING:
                        if hasattr(mod, name):
                            delattr(mod, name)
                    else:
                        setattr(mod, name, value)
        for name, value in self._orig_config.items():
            if value is _MISSING:
                if hasattr(config_mod, name):
                    delattr(config_mod, name)
            else:
                setattr(config_mod, name, value)
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()


# ====== A. main.py / config.py ======

class MessagesEmptyListNoWipeTest(RouteTestBase):
    def test_empty_post_never_wipes_longer_history(self):
        history = []
        for i in range(3):
            history.append({"role": "user", "content": f"问{i}"})
            history.append({"role": "assistant", "content": f"答{i}"})
        storage_mod._write_json(storage_mod._get_messages_path("sess_keep"), history)
        resp = self.client.post("/api/sessions/sess_keep/messages", json={"messages": []})
        self.assertEqual(resp.status_code, 200)
        after = self.client.get("/api/sessions/sess_keep/messages").json()
        self.assertEqual(len(after), len(history))
        # 正常保存路径不受影响：更长的合法列表照常写入
        longer = history + [{"role": "user", "content": "新问题"}]
        self.client.post("/api/sessions/sess_keep/messages", json={"messages": longer})
        after = self.client.get("/api/sessions/sess_keep/messages").json()
        self.assertEqual(len(after), len(longer))


class ResolveApiKeySsrfTest(RouteTestBase):
    def test_resolve_api_key_flags_env_fallback(self):
        with unittest.mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env-secret"}):
            key, env_used = config_mod.resolve_api_key("deepseek", "")
            self.assertEqual(key, "sk-env-secret")
            self.assertTrue(env_used)
            # 用户在面板里填写的 key 不算 env 兜底
            key2, env_used2 = config_mod.resolve_api_key("deepseek", "sk-user")
            self.assertEqual(key2, "sk-user")
            self.assertFalse(env_used2)

    def test_extract_route_passes_env_flag_to_helper(self):
        """路由层解析 env key 后必须把 env_key_used 传给提取 helper——
        此前 deepseek 的 env 密钥对任意 base_url 只剩「合法 https」检查。"""
        captured = {}

        async def fake_extract(messages, provider, api_key, model, base_url, level,
                               profile_digest="", env_key_used=False):
            captured["env_key_used"] = env_key_used
            captured["base_url"] = base_url
            return [], [], []

        with unittest.mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env-secret"}):
            with unittest.mock.patch.object(knowledge_mod, "_ai_extract_knowledge", new=fake_extract):
                resp = self.client.post("/api/extract_knowledge", json={
                    "sessionId": "sess_ssrf",
                    "provider": "deepseek", "model": "m",
                    "base_url": "https://evil.example/v1",
                    "messages": [
                        {"role": "user", "content": "解释简谐运动"},
                        {"role": "assistant", "content": "# 简谐运动\n回复力与位移成正比。"},
                    ],
                })
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(captured["env_key_used"])
        self.assertEqual(captured["base_url"], "https://evil.example/v1")

    def test_helper_rejects_env_key_to_foreign_domain(self):
        with unittest.mock.patch.dict(os.environ, {"DEEPSEEK_API_KEY": "sk-env-secret"}):
            async def _run():
                # 空 key 直接调 helper（旧调用方形态）：内部兜底必须算出 env 标志
                # 并拦下外发目标，返回空三元组走本地提取
                return await knowledge_mod._ai_extract_knowledge(
                    [], "deepseek", "", "m", "https://evil.example/v1")

            items, facts, ops = asyncio.run(_run())
        self.assertEqual((items, facts, ops), ([], [], []))


class RouteShapeAndSessionIdTest(RouteTestBase):
    def test_chat_ui_route_returns_200(self):
        resp = self.client.get("/chat")
        self.assertEqual(resp.status_code, 200)

    def test_sessions_post_rejects_non_whitelisted_id(self):
        resp = self.client.post("/api/sessions", json=[{"id": "我的会话", "title": "x"}])
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["count"], 0)
        self.assertNotIn("我的会话", self.client.get("/api/sessions").json())
        # 合法 id 照常写入并被计数
        resp = self.client.post("/api/sessions", json=[{"id": "sess_ok1", "title": "x"}])
        self.assertEqual(resp.json()["count"], 1)
        self.assertIn("sess_ok1", self.client.get("/api/sessions").json())

    def test_sessions_put_rejects_non_whitelisted_id(self):
        resp = self.client.put("/api/sessions/..%5Cevil", json={"title": "x"})
        self.assertEqual(resp.status_code, 400)

    def test_backup_export_survives_dirty_session_key(self):
        storage_mod._write_json(main_mod.SESSIONS_PATH, {
            "合法id": None,  # 会被 isinstance 跳过
            "我的会话": {"id": "我的会话", "title": "脏键"},
            "sess_ok2": {"id": "sess_ok2", "title": "正常"},
        })
        resp = self.client.get("/api/backup/export")
        self.assertEqual(resp.status_code, 200)

    def test_malformed_message_shapes_return_400(self):
        resp = self.client.post("/api/extract_knowledge", json={"messages": "abc"})
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post("/api/extract_knowledge", json={"messages": [1, 2]})
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post("/api/formulas", json={"items": {"a": 1}})
        self.assertEqual(resp.status_code, 400)
        resp = self.client.post("/api/models/chat", json={
            "provider": "opencode", "messages": "abc", "stream": False})
        self.assertEqual(resp.status_code, 400)


# ====== B. context / knowledge / documents ======

class RollingMemoryProtectsActiveTest(unittest.TestCase):
    def test_active_content_lives_in_tail_block_not_history(self):
        """契约变更（2026-09-24 树路径前缀缓存拍板）：路径历史区 assistant 一律
        摘要（含 active 节点），active 全文由 tree_active_content_block 单独提供、
        并入尾部上下文块——预算收缩保护集随之取消（历史区不再有需要保护的全文）。
        会话记忆仍由 rolling_memory_block 单独取（09-21 拍板不变）。"""
        active = "物" * 3600  # CJK：约 3600 token，远超预算
        messages = [
            {"role": "user", "content": "请解释", "timestamp": "t1"},
            {"role": "assistant", "content": active, "timestamp": "t2"},
        ]
        graph_path = [{"timestamp": "t1"}, {"timestamp": "t2"}]
        with unittest.mock.patch.object(context_mod, "_load_messages", return_value=messages), \
             unittest.mock.patch.object(
                 context_mod, "_read_rolling_memory",
                 return_value={"summary": "之前聊过阻尼振动的基本模型。"}):
            result = context_mod._load_session_context_from_path(
                "sess_mem", graph_path, budget_tokens=3000)
            block = context_mod.tree_active_content_block("sess_mem", graph_path)
            mem = context_mod.rolling_memory_block("sess_mem")
        joined = [str(m.get("content") or "") for m in result]
        self.assertFalse(any(c == active for c in joined),
                         "active 全文不应再出现在历史区：" + str([len(c) for c in joined]))
        self.assertTrue(any(c.startswith(active[:50]) for c in joined),
                        "active 节点在历史区应有摘要（头部截断形态）")
        self.assertIn(active, block, "active 全文应完整进入尾部上下文块")
        self.assertIn("当前节点正文", block)
        self.assertFalse(any(c.startswith("（会话记忆）") for c in joined),
                         "记忆不应再出现在历史里")
        self.assertEqual(mem, "（会话记忆）之前聊过阻尼振动的基本模型。")


class LocalDocumentExtractTest(unittest.TestCase):
    def test_module_name_headings_produce_no_empty_title(self):
        text = ("# 讲义\n## 知识图谱\n内容A\n## 延伸思考\n内容B\n## 阻尼振动\n"
                "振幅随时间衰减的振动。\n")
        nodes, edges, _ = documents_mod._local_extract_document_knowledge(text, "a.md", 10)
        titles = [n["title"] for n in nodes]
        self.assertTrue(titles)
        self.assertTrue(all(t.strip() for t in titles), titles)
        self.assertIn("阻尼振动", titles)

    def test_edges_filtered_to_kept_nodes_after_truncation(self):
        text = "\n".join(f"## 标题{i}\n内容{i}\n" for i in range(1, 10))
        nodes, edges, _ = documents_mod._local_extract_document_knowledge(text, "a.md", 3)
        kept = {n["id"] for n in nodes}
        self.assertEqual(len(nodes), 3)
        for e in edges:
            self.assertIn(e["from"], kept)
            self.assertIn(e["to"], kept)


class ProfileOpsBracketScanTest(unittest.TestCase):
    def test_fact_with_bracket_survives(self):
        text = ('前缀文字 "profile_ops": ['
                '{"op": "new", "fact": "喜欢物理[选修]教材", "category": "interest"}'
                '] 后缀文字')
        ops = knowledge_mod._parse_profile_ops(text)
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["fact"], "喜欢物理[选修]教材")


# ====== C. continent / family / concept / profile ======

class ContinentDirtyTimestampTest(unittest.TestCase):
    def test_string_updated_at_does_not_500(self):
        items = {
            "i1": {"sessionId": "s1", "title": "梯度", "createdAt": 1},
            "i2": {"sessionId": "s2", "title": "散度", "createdAt": 2},
        }
        sessions = {
            "s1": {"id": "s1", "title": "一会话", "updatedAt": "1699999999"},
            "s2": {"id": "s2", "title": "二会话", "updatedAt": 1700000000},
        }
        out = continent_mod.build_continent(items, sessions)
        self.assertEqual(out["clusterCount"], 2)

    def test_string_edge_created_at_does_not_500(self):
        items = {
            "i1": {"sessionId": "s1", "title": "梯度", "createdAt": 1},
            "i2": {"sessionId": "s2", "title": "散度", "createdAt": 2},
        }
        edges = [{
            "id": "e1", "fromItem": "i1", "toItem": "i2",
            "fromSession": "s1", "toSession": "s2",
            "createdAt": "1726000000000",
        }]
        out = continent_mod.build_continent(items, sessions={}, user_edges=edges)
        self.assertEqual(len(out["userEdges"]), 1)


class FamilyLimitTest(unittest.TestCase):
    def test_merge_truncates_custom_first(self):
        custom = [{"canonical": f"自定义{i}", "terms": [f"术语{i}"]} for i in range(40)]
        merged = family_mod.merge_families(family_mod.BUILTIN_FAMILIES, custom)
        self.assertLessEqual(len(merged), family_mod.FAMILY_LIMIT)
        self.assertEqual(merged[0]["canonical"], "自定义0")
        self.assertTrue(all(f["canonical"].startswith("自定义") for f in merged))


class SharedRunsDedupeTest(unittest.TestCase):
    def test_repeated_mentions_not_double_counted(self):
        from server.concept import _shared_runs
        runs = _shared_runs("简谐运动与简谐运动的能量", "简谐运动", 2, 3)
        self.assertEqual(len(runs), len(set(runs)), runs)
        self.assertEqual(runs.count("简谐运动"), 1)


class ProfileCapacityArchiveTest(RouteTestBase):
    def test_overflow_facts_archived_not_dropped(self):
        device = "dev_cap"
        ops = [{"op": "new", "fact": f"事实编号{i}", "category": "stage"}
               for i in range(profile_mod.MAX_FACTS + 1)]
        profile_mod.apply_profile_ops(device, ops, source="chat")
        p = profile_mod.get_profile(device)
        self.assertEqual(len(p["facts"]), profile_mod.MAX_FACTS)
        self.assertTrue(p["archive"], "被挤出的固化事实应落 archive 而不是静默蒸发")
        self.assertEqual(p["archive"][0]["source"], "capacity")
        self.assertEqual(p["archive"][0]["fact"], "事实编号0")


# ====== D. harness ======

class HarnessDictArgumentsTest(unittest.TestCase):
    def test_parse_tool_calls_accepts_dict_arguments(self):
        from harness.tools import parse_tool_calls
        ops, errors = parse_tool_calls([{
            "function": {
                "name": "create_node",
                "arguments": {"temp_id": "n1", "kind": "knowledge",
                              "label": "测试", "reason": "补充"},
            },
        }])
        self.assertEqual(errors, [])
        self.assertEqual(len(ops), 1)
        self.assertEqual(ops[0]["op"], "create_node")
        self.assertEqual(ops[0]["temp_id"], "n1")


class HarnessDeterministicUndoTest(unittest.TestCase):
    """确定性撤销的三个契约：不跌模型、恢复对不拆、原始 add_edge 可逆。"""

    MODEL = {"provider": "opencode", "model": "mimo-v2.5-free",
             "base_url": "https://opencode.ai/zen/v1", "api_key": ""}

    def test_focus_filtered_empty_returns_noop_without_model(self):
        from harness import review as review_mod

        async def fail_call(*args, **kwargs):
            raise AssertionError("确定性撤销不允许调用模型")

        after = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "原"},
                {"id": "B", "kind": "knowledge", "label": "极限", "content": "极限内容"},
            ],
            "edges": [],
        }
        before = {
            "nodes": [
                {"id": "A", "kind": "knowledge", "label": "导数", "content": "原"},
                {"id": "B", "kind": "knowledge", "label": "极限", "content": "旧内容"},
            ],
            "edges": [],
        }
        with unittest.mock.patch.object(review_mod, "_call_model", new=fail_call):
            result = asyncio.run(review_mod.review_graph(
                after, "刚才 A 那边的改动不要了，恢复原样",
                model=self.MODEL, mode="tools", self_check="off", retries=0,
                focus_node_ids=["A"],
                previous_snapshot=before,
                previous_ops=[{"op": "update_node", "id": "B",
                               "patch": {"content": "极限内容"}, "reason": "改B"}],
            ))
        self.assertEqual(result["status"], "undo")
        self.assertIn("无关", result["summary"])
        self.assertEqual(result["operations"], [])

    def test_filter_keeps_restore_pair_for_kept_edge(self):
        from harness.core import build_inverse_ops, normalize_snapshot
        from harness.review import _filter_inverse_by_targets
        before = {
            "nodes": [
                {"id": "T", "kind": "knowledge", "label": "主题", "content": "c"},
                {"id": "D", "kind": "knowledge", "label": "被删", "content": "d"},
            ],
            "edges": [{"from": "T", "to": "D"}],
        }
        after = {"nodes": [{"id": "T", "kind": "knowledge", "label": "主题", "content": "c"}],
                 "edges": []}
        inverse = build_inverse_ops(
            before, [{"op": "delete_node", "id": "D", "reason": "清理"}], after)
        filtered = _filter_inverse_by_targets(inverse, ["T"], normalize_snapshot(after))
        kinds = {str(op.get("op")) for op in filtered}
        self.assertIn("add_edge", kinds)
        self.assertIn("restore_node", kinds,
                      "保住 add_edge 必须连带保住端点的 restore_node（恢复对不拆散）")

    def test_raw_add_edge_generates_inverse(self):
        from harness.core import build_inverse_ops
        before = {
            "nodes": [{"id": "A", "kind": "knowledge", "label": "a", "content": "x"},
                      {"id": "B", "kind": "knowledge", "label": "b", "content": "y"}],
            "edges": [{"from": "A", "to": "B"}],
        }
        inverse = build_inverse_ops(
            before, [{"op": "add_edge", "from": "A", "to": "B", "reason": "连线"}], None)
        self.assertTrue(any(op.get("op") == "remove_edge" for op in inverse),
                        "无 edge_key 的原始 add_edge 也应生成 remove_edge 逆操作")

class HarnessDiffAndPatchTest(unittest.TestCase):
    SNAP = {"version": 1,
            "nodes": [{"id": "A", "kind": "knowledge", "label": "旧名", "content": "内容"}],
            "edges": []}

    def test_status_change_visible_in_diff(self):
        from harness.core import build_next_snapshot
        result = build_next_snapshot(
            dict(self.SNAP),
            [{"op": "update_node", "id": "A", "reason": "标记完成",
              "patch": {"status": "done"}}])
        self.assertTrue(result["diff"], "status 变更必须进 diff（对拍/前端高亮的数据源）")

    def test_title_alias_maps_to_label_no_orphan_field(self):
        from harness.core import build_next_snapshot
        result = build_next_snapshot(
            dict(self.SNAP),
            [{"op": "update_node", "id": "A", "reason": "改名", "patch": {"title": "新名"}}])
        node = result["next_snapshot"]["nodes"][0]
        self.assertEqual(node["label"], "新名")
        self.assertNotIn("title", node, "title 别名不该落成孤儿字段")


class JsonShellSummaryKeysBetweenTest(unittest.TestCase):
    def test_summary_with_clarify_between_operations(self):
        from harness.review import _extract_summary_from_json_shell
        raw = ('{"summary": "好的，我来帮你", "clarify": {"question": "哪个节点?", '
               '"options": ["A", "B"], "operations": []}')
        out = _extract_summary_from_json_shell(raw)
        self.assertEqual(out, "好的，我来帮你")

    def test_summary_with_inner_unescaped_quotes_kept_full(self):
        from harness.review import _extract_summary_from_json_shell
        raw = ('{\n  "summary": "导数的物理意义本质上就是"变化率"：它刻画瞬时快慢。",\n'
               '  "operations": []\n}')
        out = _extract_summary_from_json_shell(raw)
        self.assertIn("变化率", out)
        self.assertIn("瞬时快慢", out)


class SelfcheckGateTest(unittest.TestCase):
    def test_opencode_selfcheck_uses_auto(self):
        from harness import review as review_mod

        captured = {}

        async def fake_call(messages, model, max_tokens, tools=None,
                            tool_choice=None, json_mode=False):
            captured["tool_choice"] = tool_choice
            return {"content": "", "tool_calls": [
                {"function": {"name": "submit_selfcheck",
                              "arguments": '{"ok": true, "issues": [], "missing": []}'}},
            ]}

        with unittest.mock.patch.object(review_mod, "_call_model", new=fake_call):
            asyncio.run(review_mod._selfcheck_ops(
                {"nodes": [{"id": "A", "kind": "knowledge", "label": "A"}], "edges": []},
                "删除 H",
                [{"op": "delete_node", "id": "H", "reason": "x"}],
                {"provider": "opencode", "model": "mimo-v2.5-free",
                 "base_url": "https://opencode.ai/zen/v1", "api_key": ""},
            ))
        self.assertEqual(captured["tool_choice"], "auto",
                         "opencode 不支持 required，自检不该白烧一整轮注定失败的调用")


if __name__ == "__main__":
    unittest.main()
