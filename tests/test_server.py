"""Unit tests for the refactored src/server package (PhyMathia backend modules)."""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from server import backup as backup_mod
from server import config as config_mod
from server import context as context_mod
from server import documents as documents_mod
from server import knowledge as knowledge_mod
from server import storage as storage_mod


class StorageTest(unittest.TestCase):
    def test_write_read_roundtrip(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kv.json"
            storage_mod._write_json(path, {"a": 1, "中文": [1, 2]})
            self.assertEqual(storage_mod._read_json(path), {"a": 1, "中文": [1, 2]})

    def test_read_missing_returns_default(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(storage_mod._read_json(Path(td) / "missing.json"), {})
            self.assertEqual(storage_mod._read_json(Path(td) / "missing.json", []), [])

    def test_mutate_json_serialized(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "kv.json"
            storage_mod._write_json(path, {"n": 1})
            storage_mod._mutate_json(path, lambda d: {**d, "n": d.get("n", 0) + 1})
            self.assertEqual(storage_mod._read_json(path)["n"], 2)

    def test_delete_by_session(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "formulas.json"
            storage_mod._write_json(path, {
                "f1": {"sessionId": "sess_a"},
                "f2": {"sessionId": "sess_b"},
            })
            removed = storage_mod._delete_by_session(path, "sess_a")
            self.assertEqual(removed, 1)
            self.assertNotIn("f1", storage_mod._read_json(path))
            self.assertIn("f2", storage_mod._read_json(path))


class FormulaTest(unittest.TestCase):
    def test_normalize_formula_wraps_dollars(self):
        self.assertEqual(knowledge_mod._normalize_formula("F=-kx"), "$F=-kx$")
        self.assertEqual(knowledge_mod._normalize_formula("$F=-kx$"), "$F=-kx$")
        self.assertEqual(knowledge_mod._normalize_formula(""), "")

    def test_normalize_formula_cleans_escapes(self):
        self.assertEqual(knowledge_mod._normalize_formula("\\$x\\$"), "$x$")
        self.assertEqual(knowledge_mod._normalize_formula("\\=x"), "$=x$")

    def test_looks_like_formula(self):
        self.assertTrue(knowledge_mod._looks_like_formula("$F=-kx$"))
        self.assertTrue(knowledge_mod._looks_like_formula("E=mc^2"))
        self.assertFalse(knowledge_mod._looks_like_formula("m"))
        self.assertFalse(knowledge_mod._looks_like_formula("rad/s"))
        self.assertFalse(knowledge_mod._looks_like_formula("\\omega"))
        self.assertFalse(knowledge_mod._looks_like_formula("\\text{rad/s}"))

    def test_formula_key_ignores_spacing(self):
        self.assertEqual(
            knowledge_mod._formula_key("$F = -kx$"),
            knowledge_mod._formula_key("F=-kx"),
        )


class KnowledgeTest(unittest.TestCase):
    def test_normalize_knowledge_formats(self):
        items = [{"id": "k1", "title": "导数"}]
        self.assertEqual(knowledge_mod._normalize_knowledge({"items": items}), {"k1": items[0]})
        self.assertEqual(knowledge_mod._normalize_knowledge({"items": None}), {})

    def test_dedupe_knowledge_merges_same_session_title(self):
        data = {
            "k1": {"title": "导数", "sessionId": "s1", "summary": "旧"},
            "k2": {"title": "导数", "sessionId": "s1", "summary": "新"},
        }
        result = knowledge_mod._dedupe_knowledge(data)
        self.assertEqual(len(result), 1)
        self.assertEqual(list(result.values())[0]["summary"], "新")

    def test_dedupe_formula_map_merges_by_key(self):
        data = {
            "f1": {"latex": "$F=-kx$", "sessionId": "s1", "meaning": "旧"},
            "f2": {"latex": "$F = -kx$", "sessionId": "s1", "meaning": "新"},
        }
        result = knowledge_mod._dedupe_formula_map(data)
        self.assertEqual(len(result), 1)

    def test_normalize_formula_map(self):
        self.assertEqual(
            knowledge_mod._normalize_formula_map([{"id": "f1", "latex": "$a$"}]),
            {"f1": {"id": "f1", "latex": "$a$"}},
        )


class ContextTest(unittest.TestCase):
    def test_is_socratic_message(self):
        self.assertTrue(context_mod._is_socratic_message({"branch": "socratic", "content": "x"}))
        self.assertTrue(context_mod._is_socratic_message({"content": "[苏格拉底回答] 我的想法"}))
        self.assertTrue(context_mod._is_socratic_message({"content": "<socratic_meta correct='correct'/>"}))
        self.assertFalse(context_mod._is_socratic_message({"content": "普通问题"}))

    def test_is_socratic_followup(self):
        self.assertTrue(context_mod._is_socratic_followup("<socratic_meta correct='correct' done='false'/>"))
        self.assertFalse(context_mod._is_socratic_followup("<physics>完整卡片</physics><socratic_meta/>"))

    def test_recent_context_messages_rounds(self):
        msgs = [{"role": "user", "content": f"u{i}"} for i in range(5)]
        result = context_mod._recent_context_messages(msgs, max_rounds=2)
        # 最近 2 轮完整 + 更早 3 轮一行摘要
        self.assertEqual([m["content"] for m in result], [
            "（更早对话）用户：u0", "（更早对话）用户：u1", "（更早对话）用户：u2", "u3", "u4",
        ])

    def test_recent_context_filters_socratic(self):
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "[苏格拉底回答] 我的回答", "branch": "socratic"},
            {"role": "user", "content": "u2"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=3)
        self.assertNotIn("[苏格拉底回答] 我的回答", [m["content"] for m in result])


    def test_prompt_wants_viz(self):
        self.assertTrue(context_mod._prompt_wants_viz("这个可视化没看懂"))
        self.assertTrue(context_mod._prompt_wants_viz("图里的动画是什么意思"))
        self.assertFalse(context_mod._prompt_wants_viz("讲讲物理意义"))

    def test_trim_context_content_replaces_viz(self):
        big = "<physics>物理正文</physics>\n<viz>```html\n" + ("<div>html内容" * 1500) + "```</viz>\n<summary>一句话摘要</summary>"
        out = context_mod._trim_context_content(big)
        self.assertIn("[交互可视化内容已省略]", out)
        self.assertIn("一句话摘要", out)
        self.assertNotIn("<div>html内容", out)

    def test_trim_context_content_keeps_viz_when_requested(self):
        big = "<viz>```html\n" + ("<div>html内容" * 1500) + "```</viz>"
        out = context_mod._trim_context_content(big, keep_viz=True)
        self.assertIn("[交互可视化摘要]", out)
        self.assertNotIn("<div>html内容", out)

    def test_recent_context_summarizes_old_assistant(self):
        big = "<physics>正文</physics>\n<summary>摘要内容</summary>" + ("很长" * 5000)
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": big},
            {"role": "user", "content": "u2"},
            {"role": "assistant", "content": "短回复"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=2)
        self.assertEqual(result[0]["content"], "u1")
        self.assertIn("摘要内容", result[1]["content"])
        self.assertLess(len(result[1]["content"]), 300)
        self.assertEqual(result[2]["content"], "u2")
        self.assertEqual(result[3]["content"], "短回复")

    def test_recent_context_keeps_viz_on_viz_prompt(self):
        big = "<viz>```html\n" + ("<div>html内容" * 1500) + "```</viz>"
        msgs = [
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": big},
        ]
        default = context_mod._recent_context_messages(msgs, max_rounds=1)
        self.assertNotIn("<div>html内容", default[1]["content"])
        viz = context_mod._recent_context_messages(msgs, max_rounds=1, current_prompt="这个可视化没看懂")
        self.assertNotIn("<div>html内容", viz[1]["content"])
        self.assertIn("[交互可视化摘要]", viz[1]["content"])

    def test_graph_message_summary_uses_cached(self):
        msg = {"content": "<physics>超长正文</physics>" + ("很长" * 5000), "summary": "缓存的摘要"}
        self.assertEqual(context_mod._graph_message_summary(msg), "缓存的摘要")



    def test_recent_context_digest_pairs_roles(self):
        msgs = [
            {"role": "user", "content": "u0"},
            {"role": "assistant", "content": "<summary>a0</summary>"},
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "<summary>a1</summary>"},
            {"role": "user", "content": "u2"},
        ]
        result = context_mod._recent_context_messages(msgs, max_rounds=1, summary_rounds=2)
        roles = [m["role"] for m in result]
        self.assertEqual(roles, ["user", "assistant", "user", "assistant", "user"])
        self.assertEqual(result[0]["content"], "（更早对话）用户：u0")
        self.assertIn("a0", result[1]["content"])
        self.assertEqual(result[2]["content"], "（更早对话）用户：u1")
        self.assertIn("a1", result[3]["content"])
        self.assertEqual(result[4]["content"], "u2")

    def test_recent_context_budget_applied(self):
        msgs = [{"role": "user", "content": "问题%d" % i + "很长" * 30} for i in range(20)]
        result = context_mod._recent_context_messages(msgs, max_rounds=3, budget_tokens=100)
        total = sum(context_mod.estimate_tokens(m["content"]) for m in result)
        self.assertLessEqual(total, 100)
        self.assertEqual(result[-1]["content"], "问题19" + "很长" * 30)

    def test_shrink_history_to_budget(self):
        msgs = [
            {"role": "user", "content": "u0"},
            {"role": "assistant", "content": "a0 " + "很长" * 500},
            {"role": "user", "content": "u1"},
            {"role": "assistant", "content": "<summary>最近摘要</summary>" + ("很长" * 5000)},
        ]
        result = context_mod._shrink_history_to_budget(msgs, 400)
        total = sum(context_mod.estimate_tokens(m["content"]) for m in result)
        self.assertLessEqual(total, 400)
        self.assertEqual(result[-1]["role"], "assistant")

    def test_shrink_history_to_budget_protected(self):
        protected = "当前模块正文" + ("很长" * 200)
        msgs = [
            {"role": "user", "content": "u0"},
            {"role": "assistant", "content": "旧回答" + ("很长" * 300)},
            {"role": "assistant", "content": protected},
        ]
        result = context_mod._shrink_history_to_budget(msgs, 150, {protected})
        self.assertEqual(result, [{"role": "assistant", "content": protected}])

    def test_graph_message_summary_cuts_at_sentence(self):
        long_run = "没有标点的补充" * 40
        msg = {"content": "第一句话是物理直觉的完整说明并且足够长超过四十个字符还加了一些额外内容保证句号位置靠后。" + long_run}
        s = context_mod._graph_message_summary(msg)
        self.assertTrue(s.endswith("…"))
        self.assertNotIn("没有标点的补充", s)

    def test_resolve_context_budget(self):
        self.assertEqual(context_mod.resolve_context_budget("deepseek-chat"), 16000)
        self.assertEqual(context_mod.resolve_context_budget("gpt-4o"), 16000)
        self.assertGreaterEqual(context_mod.resolve_context_budget("unknown-model"), 2048)

    def test_path_dedupe_by_ts_and_content(self):
        msgs = [
            {"role": "user", "content": "第一个问题", "timestamp": 1},
            {"role": "assistant", "content": "<summary>回答一</summary>物理正文", "timestamp": 2},
            {"role": "user", "content": "第一个问题", "timestamp": 3},
            {"role": "assistant", "content": "<summary>回答二</summary>数学正文", "timestamp": 4},
        ]
        path = [
            {"kind": "user", "timestamp": 1},
            {"kind": "answer", "timestamp": 2},
            {"kind": "user", "timestamp": 3},
            {"kind": "answer", "timestamp": 4},
        ]
        orig_resolve = context_mod._resolve_messages_path
        orig_read = context_mod._read_json
        context_mod._resolve_messages_path = lambda sid: "fake"
        context_mod._read_json = lambda path_, default: msgs
        try:
            result = context_mod._load_session_context_from_path("s1", path)
        finally:
            context_mod._resolve_messages_path = orig_resolve
            context_mod._read_json = orig_read
        contents = [m["content"] for m in result]
        self.assertEqual(contents.count("第一个问题"), 2)
        self.assertTrue(any("回答一" in c for c in contents))
        self.assertTrue(any("回答二" in c for c in contents))

    def test_path_dedupe_same_ts_same_content(self):
        msgs = [{"role": "user", "content": "重复问题", "timestamp": 1}]
        path = [
            {"kind": "user", "timestamp": 1},
            {"kind": "user", "timestamp": 1},
        ]
        orig_resolve = context_mod._resolve_messages_path
        orig_read = context_mod._read_json
        context_mod._resolve_messages_path = lambda sid: "fake"
        context_mod._read_json = lambda path_, default: msgs
        try:
            result = context_mod._load_session_context_from_path("s1", path)
        finally:
            context_mod._resolve_messages_path = orig_resolve
            context_mod._read_json = orig_read
        contents = [m["content"] for m in result]
        self.assertEqual(contents.count("重复问题"), 1)


class DocumentTest(unittest.TestCase):
    def test_sanitize_filename(self):
        self.assertEqual(documents_mod._sanitize_filename("../evil/name.txt"), "name.txt")
        self.assertEqual(documents_mod._sanitize_filename(""), "upload")
        self.assertEqual(len(documents_mod._sanitize_filename("x" * 300)), 120)

    def test_extract_text_utf8_and_gbk(self):
        self.assertEqual(documents_mod._extract_document_text("a.md", "你好".encode("utf-8")), "你好")
        self.assertEqual(documents_mod._extract_document_text("a.md", "中文".encode("gbk")), "中文")

    def test_extract_unsupported_returns_empty(self):
        self.assertEqual(documents_mod._extract_document_text("a.xyz", b"data"), "")


class BackupTest(unittest.TestCase):
    def test_restore_sessions_merge(self):
        with tempfile.TemporaryDirectory() as td:
            old_path = backup_mod.SESSIONS_PATH
            backup_mod.SESSIONS_PATH = Path(td) / "sessions.json"
            try:
                backup_mod._write_json(backup_mod.SESSIONS_PATH, {"s1": {"id": "s1", "title": "旧"}})
                count = backup_mod._restore_sessions({"s2": {"id": "s2", "title": "新"}}, replace=False)
                self.assertEqual(count, 1)
                data = backup_mod._read_json(backup_mod.SESSIONS_PATH)
                self.assertIn("s1", data)
                self.assertIn("s2", data)
            finally:
                backup_mod.SESSIONS_PATH = old_path


class ContextOptimizationTest(unittest.TestCase):
    def test_recent_context_digest_for_old_rounds(self):
        msgs = []
        for i in range(10):
            msgs.append({"role": "user", "content": "问题" + str(i), "timestamp": "u" + str(i)})
            msgs.append({"role": "assistant", "content": "<summary>答案摘要" + str(i) + "</summary>", "timestamp": "a" + str(i)})
        out = context_mod._recent_context_messages(msgs, max_rounds=3)
        self.assertIn("答案摘要9", out[-1]["content"])
        self.assertEqual(out[-2]["content"], "问题9")
        full_count = sum(1 for m in out if "（更早对话）" not in m["content"])
        digest_count = sum(1 for m in out if "（更早对话）" in m["content"])
        self.assertEqual(full_count, 6)
        # 每个更早轮次拆成「用户一行 + AI 一行」摘要对：7 轮 * 2 = 14 条
        self.assertEqual(digest_count, 14)
        self.assertIn("问题0", out[0]["content"])
        self.assertIn("答案摘要0", out[1]["content"])

    def test_from_path_skips_upstream_when_workflow_context(self):
        msgs = [
            {"role": "user", "content": "q1", "timestamp": "t1"},
            {"role": "assistant", "content": "<physics>A1正文</physics><summary>摘要1</summary>", "timestamp": "t2"},
            {"role": "user", "content": "q2", "timestamp": "t3"},
            {"role": "assistant", "content": "<physics>active正文</physics><summary>摘要2</summary>", "timestamp": "t4"},
        ]
        path = [
            {"timestamp": "t1", "kind": "user"},
            {"timestamp": "t2", "kind": "answer", "module": "physics"},
            {"timestamp": "t3", "kind": "user"},
            {"timestamp": "t4", "kind": "answer", "module": "physics"},
        ]
        orig = context_mod._read_json
        orig_resolve6 = context_mod._resolve_messages_path
        context_mod._read_json = lambda _path, default=None: msgs
        context_mod._resolve_messages_path = lambda sid: "fake"
        try:
            out = context_mod._load_session_context_from_path(
                "sess_x", path, workflow_context={"upstream": [{"label": "x", "content": "..."}]}
            )
        finally:
            context_mod._read_json = orig
            context_mod._resolve_messages_path = orig_resolve6
        contents = [item["content"] for item in out]
        self.assertIn("q1", contents)
        self.assertIn("q2", contents)
        self.assertIn("active正文", contents)
        self.assertNotIn("A1正文", contents)

        context_mod._read_json = lambda _path, default=None: msgs
        context_mod._resolve_messages_path = lambda sid: "fake"
        try:
            out2 = context_mod._load_session_context_from_path("sess_x", path)
        finally:
            context_mod._read_json = orig
            context_mod._resolve_messages_path = orig_resolve6
        contents2 = [item["content"] for item in out2]
        self.assertTrue(any("A1正文" in c for c in contents2))

    def test_module_system_prompt_has_formula_rules(self):
        from server import prompts as prompts_mod
        self.assertTrue(prompts_mod.MODULE_SYSTEM_PROMPT)
        self.assertIn("<formula>", prompts_mod.MODULE_SYSTEM_PROMPT)
        self.assertIn("不输出完整探索卡片", prompts_mod.MODULE_SYSTEM_PROMPT)
        self.assertLess(len(prompts_mod.MODULE_SYSTEM_PROMPT), 1200)




class WorkflowAnalysisInstructionTest(unittest.TestCase):
    def test_analysis_mode_lists_suggested_modules(self):
        inst = context_mod._workflow_context_instruction({"mode": "analysis", "target": {"kind": "answer", "label": "AI 回答"}, "question": "解释简谐运动"})
        self.assertIn("只输出简洁问题概要", inst)
        self.assertIn("建议模块：", inst)
        self.assertIn("物理视角/数学视角", inst)

    def test_module_mode_keeps_analysis_injection(self):
        inst = context_mod._workflow_context_instruction({"mode": "module", "target": {"kind": "module", "module": "physics", "label": "物理视角"}, "analysis": "核心是回复力与位移成正比", "question": "简谐运动"})
        self.assertIn("隐藏问题分析", inst)
        self.assertIn("核心是回复力与位移成正比", inst)



class Wave2OptimizationTest(unittest.TestCase):
    def test_trim_context_keeps_viz_digest(self):
        big = "<viz>```html\n<div>真实页面</div><script>let a=1; /*逻辑*/</script><p>这张图展示简谐运动</p>```</viz><summary>摘要</summary>" + ("很长" * 4000)
        out = context_mod._trim_context_content(big, keep_viz=True)
        self.assertIn("[交互可视化摘要]", out)
        self.assertIn("页面文字", out)
        self.assertIn("脚本片段", out)
        self.assertNotIn("<div>真实页面", out)
        self.assertLess(len(out), len(big))
        self.assertLess(len(out), 9000)

    def test_viz_digest_no_script(self):
        big = "<viz>```html\n<p>只有文字说明</p>```</viz>"
        out = context_mod._viz_digest(big)
        self.assertIn("页面文字", out)
        self.assertIn("只有文字说明", out)

    def test_read_json_cached_invalidation(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / "msg.json"
            storage_mod._write_json(path, {"n": 1})
            first = storage_mod._read_json_cached(path)
            second = storage_mod._read_json_cached(path)
            self.assertIs(first, second)
            storage_mod._write_json(path, {"n": 2})
            third = storage_mod._read_json_cached(path)
            self.assertIsNot(first, third)
            self.assertEqual(third["n"], 2)

    def test_socratic_state_expired(self):
        import time as _time
        now = int(_time.time())
        self.assertFalse(context_mod._socratic_state_expired({"active": True, "updatedAt": now}, now))
        self.assertTrue(context_mod._socratic_state_expired({"active": True, "updatedAt": now - 25 * 3600}, now))
        self.assertFalse(context_mod._socratic_state_expired({"active": True}, now))
        self.assertFalse(context_mod._socratic_state_expired(None, now))

    def test_read_socratic_state_expired_is_read_only(self):
        # 读路径不再有写副作用：过期状态返回 None 但不删除，
        # TTL 清理职责在 _resolve_socratic_branch（见 test_resolve_socratic_branch_skips_expired）
        import time as _time
        orig_read = context_mod._read_json
        orig_delete = context_mod._delete_socratic_state
        deleted = []
        context_mod._read_json = lambda path, default=None: {context_mod._socratic_key("br_x"): {"active": True, "updatedAt": int(_time.time()) - 25 * 3600}}
        context_mod._delete_socratic_state = lambda ref: deleted.append(ref)
        try:
            state = context_mod._read_socratic_state("br_x")
        finally:
            context_mod._read_json = orig_read
            context_mod._delete_socratic_state = orig_delete
        self.assertIsNone(state)
        self.assertEqual(deleted, [])

    def test_resolve_socratic_branch_skips_expired(self):
        import time as _time
        orig_read = context_mod._read_json
        orig_mutate = context_mod._mutate_json
        orig_resolve = context_mod._resolve_messages_path
        kv = {"socratic:br_sess_1234567890abc_1": {"active": True, "updatedAt": int(_time.time()) - 25 * 3600}}
        mutated = []
        context_mod._read_json = lambda path, default=None: kv if str(path) == str(context_mod.KV_PATH) else (default if default is not None else [])
        context_mod._mutate_json = lambda path, updater: mutated.append(updater(dict(kv)))
        context_mod._resolve_messages_path = lambda sid: "fake"
        try:
            ref = context_mod._resolve_socratic_branch("sess_1234567890abcdef123456")
        finally:
            context_mod._read_json = orig_read
            context_mod._mutate_json = orig_mutate
            context_mod._resolve_messages_path = orig_resolve
        self.assertEqual(ref, "")
        self.assertTrue(mutated)
        self.assertNotIn("socratic:br_sess_1234567890abc_1", mutated[0])

    def test_socratic_delete_no_cross_session_prefix_collision(self):
        # 旧版按「会话标识前 18 个安全字符」匹配分支前缀：前缀相同的两个会话
        # 会互相误删状态；现按完整标识精确匹配（18 截断旧格式仍单独兼容）
        orig_mutate = context_mod._mutate_json
        results = []

        def fake_mutate(path, updater):
            data = {
                "socratic:br_sess_1234567890abcdef123456_aa11bb22cc": {"active": True, "updatedAt": 1},
                "socratic:br_sess_1234567890abcdefZZZZZZ_bb22cc33dd": {"active": True, "updatedAt": 1},
            }
            results.append(updater(data))

        context_mod._mutate_json = fake_mutate
        try:
            context_mod._delete_socratic_state("sess_1234567890abcdef123456")
        finally:
            context_mod._mutate_json = orig_mutate
        self.assertNotIn("socratic:br_sess_1234567890abcdef123456_aa11bb22cc", results[0])
        self.assertIn("socratic:br_sess_1234567890abcdefZZZZZZ_bb22cc33dd", results[0])




class RollingMemoryTest(unittest.TestCase):
    def test_write_rolling_memory(self):
        orig_mutate = context_mod._mutate_json
        captured = {}
        context_mod._mutate_json = lambda path, updater: captured.update(updater({}))
        try:
            context_mod._write_rolling_memory("sess_abc", "用户学过简谐运动", 20)
        finally:
            context_mod._mutate_json = orig_mutate
        self.assertIn("mem:sess_abc", captured)
        self.assertEqual(captured["mem:sess_abc"]["summary"], "用户学过简谐运动")
        self.assertEqual(captured["mem:sess_abc"]["messageCount"], 20)

    def test_rolling_summary_due(self):
        orig_load = context_mod._load_messages
        orig_read = context_mod._read_rolling_memory
        context_mod._load_messages = lambda sid: [{"role": "user", "content": "x"}] * 20
        context_mod._read_rolling_memory = lambda sid: None
        try:
            self.assertEqual(context_mod._rolling_summary_due("sess_abc"), 20)
            context_mod._read_rolling_memory = lambda sid: {"summary": "旧", "messageCount": 18}
            self.assertEqual(context_mod._rolling_summary_due("sess_abc"), 0)
            context_mod._read_rolling_memory = lambda sid: {"summary": "旧", "messageCount": 10}
            self.assertEqual(context_mod._rolling_summary_due("sess_abc"), 20)
        finally:
            context_mod._load_messages = orig_load
            context_mod._read_rolling_memory = orig_read

    def test_rolling_memory_input(self):
        orig_load = context_mod._load_messages
        orig_read = context_mod._read_rolling_memory
        context_mod._load_messages = lambda sid: [
            {"role": "user", "content": "问题%d" % i, "timestamp": i}
            for i in range(10)
        ]
        context_mod._read_rolling_memory = lambda sid: {"summary": "旧记忆内容", "messageCount": 10}
        try:
            text = context_mod._rolling_memory_input("sess_abc", max_old_pairs=3)
        finally:
            context_mod._load_messages = orig_load
            context_mod._read_rolling_memory = orig_read
        self.assertIn("旧记忆内容", text)
        self.assertIn("问题0", text)

    def test_load_session_context_injects_memory(self):
        msgs = [
            {"role": "user", "content": "问题1", "timestamp": 1},
            {"role": "assistant", "content": "回答1", "timestamp": 2},
        ]
        orig_read = context_mod._read_json
        orig_resolve = context_mod._resolve_messages_path
        orig_rm = context_mod._read_rolling_memory
        context_mod._read_json = lambda path, default=None: msgs
        context_mod._resolve_messages_path = lambda sid: "fake"
        context_mod._read_rolling_memory = lambda sid: {"summary": "之前聊过简谐运动", "messageCount": 2}
        try:
            result = context_mod._load_session_context("sess_abc", max_rounds=2)
        finally:
            context_mod._read_json = orig_read
            context_mod._resolve_messages_path = orig_resolve
            context_mod._read_rolling_memory = orig_rm
        self.assertEqual(result[0]["content"], "（会话记忆）之前聊过简谐运动")


if __name__ == "__main__":
    unittest.main()
