"""T230–T234 批修（健康修复）回归。

- T230 concept.explicit_pairs 回落拆分层时漏传 account（跨号读到默认账号会话文件）
- T231 /api/models/chat 的 graph_path 项非 dict 时 _graph_path_instruction 逐项
  item.get 触发 500（路由守卫只挡了非 list）
- T232 profile_implicit.assign_topic 文档称「最长包含匹配」，实现是词表序首个命中
- T233 storage.kv_delete 的「mutate＋空判＋unlink」在锁外，窗口期内并发 kv_write
  写入的新键会被误删
- T234 harness.review_ops._focus_subgraph 降采样时丢 user_recipes（提示词参考字段）

fixture 姿势沿 tests/test_kv_split.py / tests/test_routes.py：patch config.DATA_DIR
与账号域路径到临时目录，不触碰真实 data/。
"""

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for _p in (ROOT, SRC):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import accounts as accounts_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import http_client as http_client_mod  # noqa: E402  出网口补丁单点（T163）
from server import profile_implicit as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402


def _patched_paths(td):
    """同 tests/test_routes._patched_paths：账号域布局下的真实路径（storage/
    concept 均经 accounts.resolve_paths 调用期读取 DATA_DIR）。"""
    td = Path(td)
    root = td / "users" / "default"
    return {
        "DATA_DIR": td,
        "MESSAGES_DIR": root / "messages",
        "SESSIONS_PATH": root / "sessions.json",
        "KNOWLEDGE_PATH": root / "knowledge.json",
        "FORMULAS_PATH": root / "formulas.json",
        "KV_PATH": root / "kv_store.json",
        "KV_DIR": root / "kv",
        "PROFILES_DIR": td / "profiles",
    }


class _DataDirBase(unittest.TestCase):
    """多账号 P1 夹具：patch config.DATA_DIR 一处，按 users/<account>/ 布局建目录。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        self.root = Path(self._td.name)
        self._orig_data_dir = config_mod.DATA_DIR
        config_mod.DATA_DIR = self.root
        accounts_mod._ENSURED.clear()
        storage_mod._JSON_READ_CACHE.clear()

    def tearDown(self):
        config_mod.DATA_DIR = self._orig_data_dir
        accounts_mod._ENSURED.clear()
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()

    def account_dir(self, account):
        path = self.root / "users" / account
        path.mkdir(parents=True, exist_ok=True)
        return path


class ConceptAccountFallbackTest(_DataDirBase):
    """T230：主文件没命中时回落拆分层，必须读同一账号的会话文件。"""

    def _state(self, suffix):
        return {
            "customNodes": [
                {"id": f"knowledge-custom-{suffix}1", "knowledgeKey": f"k{suffix}1"},
                {"id": f"knowledge-custom-{suffix}2", "knowledgeKey": f"k{suffix}2"},
            ],
            "connections": [
                {"from": f"knowledge-custom-{suffix}1", "to": f"knowledge-custom-{suffix}2",
                 "relation": "依赖"},
            ],
        }

    def test_fallback_reads_requested_account(self):
        from server import concept as concept_mod

        self.account_dir("alice")
        storage_mod.kv_write("graph:sess_c", self._state("a"), account="alice")
        # kv_write 把 graph:<sid> 路由到拆分层，主文件里没有该键——回落路径才会被走
        main_file = self.root / "users" / "alice" / "kv_store.json"
        self.assertFalse(main_file.exists())
        self.assertEqual(concept_mod.explicit_pairs("sess_c", account="alice"),
                         [("ka1", "ka2", "依赖")])

    def test_fallback_does_not_leak_default_account(self):
        # 两个账号的同名会话文件各有一条不同连线：实现若漏传 account 会串号
        for account, suffix in (("default", "d"), ("alice", "a")):
            self.account_dir(account)
            storage_mod.kv_write("graph:sess_c", self._state(suffix), account=account)
        from server import concept as concept_mod

        self.assertEqual(concept_mod.explicit_pairs("sess_c", account="default"),
                         [("kd1", "kd2", "依赖")])
        self.assertEqual(concept_mod.explicit_pairs("sess_c", account="alice"),
                         [("ka1", "ka2", "依赖")])

    def test_empty_when_account_has_no_state(self):
        from server import concept as concept_mod

        self.account_dir("default")
        storage_mod.kv_write("graph:sess_c", self._state("d"))
        # alice 域空 → 回落读不到任何东西（而不是默默拿到 default 的图）
        self.assertEqual(concept_mod.explicit_pairs("sess_c", account="alice"), [])


class GraphPathItemGuardTest(unittest.TestCase):
    """T231：graph_path 项非 dict 时路由守卫必须 400（此前是 _graph_path_instruction
    里 item.get 的 500）。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        paths = _patched_paths(self._td.name)
        accounts_mod._ENSURED.clear()
        paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
        paths["PROFILES_DIR"].mkdir(parents=True, exist_ok=True)
        self._orig = {}
        self._orig_config = {}
        for mod in (main_mod,):
            for name, value in paths.items():
                self._orig[(id(mod), name)] = getattr(mod, name, None)
                setattr(mod, name, value)
        for name, value in paths.items():
            self._orig_config[name] = getattr(config_mod, name, None)
            setattr(config_mod, name, value)
        storage_mod._JSON_READ_CACHE.clear()
        self.client = TestClient(main_mod.app)

    def tearDown(self):
        for (mid, name), value in self._orig.items():
            setattr(main_mod, name, value)
        for name, value in self._orig_config.items():
            setattr(config_mod, name, value)
        accounts_mod._ENSURED.clear()
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()

    def _post(self, payload):
        return self.client.post("/api/models/chat", json={
            "provider": "deepseek", "api_key": "sk-test",
            "model": "test-model", "stream": False, **payload})

    def test_non_dict_item_rejected_400(self):
        for bad in (["x"], [1], [None], [{"kind": "user"}, "oops"]):
            resp = self._post({"prompt": "继续讲", "graph_path": bad, "session_id": "s-t231"})
            self.assertEqual(resp.status_code, 400, f"graph_path={bad!r}")
            self.assertIn("graph_path", resp.json()["detail"])

    def test_non_list_still_rejected_400(self):
        resp = self._post({"prompt": "继续讲", "graph_path": "x", "session_id": "s-t231"})
        self.assertEqual(resp.status_code, 400)

    def test_valid_items_still_accepted(self):
        # 守卫收紧不能把合法路径挡掉（走 mock 上游到 200）
        def handler(request):
            return httpx.Response(200, json={"choices": [{"message": {"content": "ok"}}]})

        client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        with mock.patch.object(http_client_mod, "get_http_client", return_value=client):
            resp = self._post({
                "prompt": "继续讲",
                "graph_path": [{"kind": "user", "timestamp": 1}],
                "session_id": "s-t231-ok",
            })
        self.assertEqual(resp.status_code, 200)


class AssignTopicLongestMatchTest(unittest.TestCase):
    """T232：命中项里取最长（同长取词表序在先），空文本/无命中返回空串。"""

    def test_longer_term_wins_over_shorter(self):
        self.assertEqual(profile_mod.assign_topic("求偏导数", ["导数", "偏导数"]), "偏导数")
        # 词表倒序同样成立（实现不能依赖词表顺序）
        self.assertEqual(profile_mod.assign_topic("求偏导数", ["偏导数", "导数"]), "偏导数")

    def test_shortest_prefix_vocab_no_longer_hijacks(self):
        # 文本同时含三个词表项时取最长（原实现会停在词表序第一个「导数」）
        self.assertEqual(
            profile_mod.assign_topic("偏导数的应用与导数的区别",
                                     ["导数", "偏导数", "偏导数的应用"]),
            "偏导数的应用")

    def test_same_length_keeps_vocab_order(self):
        self.assertEqual(
            profile_mod.assign_topic("数学分析与高等数学", ["数学分析", "高等数学", "线性代数"]),
            "数学分析")
        self.assertEqual(
            profile_mod.assign_topic("数学分析与高等数学", ["高等数学", "数学分析"]),
            "高等数学")

    def test_empty_and_miss_unchanged(self):
        self.assertEqual(profile_mod.assign_topic("", ["导数"]), "")
        self.assertEqual(profile_mod.assign_topic("   ", ["导数"]), "")
        self.assertEqual(profile_mod.assign_topic("求积分", ["导数", "偏导数"]), "")
        self.assertEqual(profile_mod.assign_topic(None, ["导数"]), "")

    def test_single_hit_unchanged(self):
        self.assertEqual(profile_mod.assign_topic("讲讲电磁感应", ["电磁感应", "导数"]), "电磁感应")

    def test_truncation_applies_after_match(self):
        # 截断到 60 字发生在比对之后，短截断不能抢走长词
        long_term = "长" * 80
        self.assertEqual(profile_mod.assign_topic("含" + long_term, [long_term]),
                         long_term[:60])


class KvDeleteEmptyFileTest(_DataDirBase):
    """T233：删键后空文件才移除；删非最后键文件必须在。"""

    def test_last_key_removes_file(self):
        self.account_dir("default")
        storage_mod.kv_write("socratic:s1", {"active": True})
        target = self.root / "users" / "default" / "kv" / "meta" / "socratic.json"
        self.assertTrue(target.exists())
        storage_mod.kv_delete("socratic:s1")
        self.assertFalse(target.exists())

    def test_non_last_key_keeps_file(self):
        self.account_dir("default")
        storage_mod.kv_write("socratic:s1", {"a": 1})
        storage_mod.kv_write("socratic:s2", {"b": 2})
        target = self.root / "users" / "default" / "kv" / "meta" / "socratic.json"
        storage_mod.kv_delete("socratic:s1")
        self.assertTrue(target.exists())
        self.assertIsNone(storage_mod.kv_read("socratic:s1"))
        self.assertEqual(storage_mod.kv_read("socratic:s2"), {"b": 2})

    def test_main_file_key_delete_keeps_file(self):
        # 非拆分层（主文件）键删后不 unlink 文件本身（契约未变）
        self.account_dir("default")
        storage_mod.kv_write("ui:theme", "dark")
        storage_mod.kv_delete("ui:theme")
        self.assertTrue((self.root / "users" / "default" / "kv_store.json").exists())
        self.assertIsNone(storage_mod.kv_read("ui:theme"))

    def test_delete_missing_key_noop(self):
        self.account_dir("default")
        storage_mod.kv_delete("socratic:none")
        self.assertIsNone(storage_mod.kv_read("socratic:none"))

    def test_concurrent_write_between_mutate_and_unlink_survives(self):
        """锁窗竞态回归：删空判定与 unlink 必须在同一把锁内。

        用 _mutate_json 包装把删除方暂停在「mutate 刚返回、unlink 未执行」的
        窗口里，同时另一线程往同一拆分层写新键：
        - 修复前：对方写成功落盘，删除方仍按旧的空结果 unlink → 新键被误删；
        - 修复后：删除方持锁，对方阻塞，删除方先落 unlink 再放锁，新键落盘。
        """
        self.account_dir("default")
        storage_mod.kv_write("socratic:s1", {"a": 1})
        target = self.root / "users" / "default" / "kv" / "meta" / "socratic.json"
        orig_mutate = storage_mod._mutate_json
        paused = threading.Event()
        resume = threading.Event()
        gate = {"used": False}

        def pausing_mutate(path, updater, default=None):
            result = orig_mutate(path, updater, default)
            if not gate["used"]:
                gate["used"] = True
                paused.set()
                resume.wait(2.0)  # 窗口期：给并发写一个插入机会
            return result

        def writer():
            paused.wait(2.0)
            storage_mod.kv_write("socratic:s2", {"b": 2})
            resume.set()

        storage_mod._mutate_json = pausing_mutate
        try:
            thread = threading.Thread(target=writer, daemon=True)
            thread.start()
            storage_mod.kv_delete("socratic:s1")
            thread.join(5.0)
        finally:
            storage_mod._mutate_json = orig_mutate

        self.assertEqual(storage_mod.kv_read("socratic:s2"), {"b": 2},
                         "并发写入的新键被删除空的 unlink 误删")
        self.assertTrue(target.exists())


class FocusSubgraphRecipesTest(unittest.TestCase):
    """T234：大图降采样必须透传提示词参考字段 user_recipes。"""

    def test_user_recipes_pass_through_downsampling(self):
        from harness.review_ops import _focus_subgraph

        nodes = [{"id": "n0", "kind": "knowledge", "label": "焦点"}]
        for i in range(1, 60):
            nodes.append({"id": f"n{i}", "kind": "knowledge", "label": f"节点{i}"})
        recipes = [{"id": "r1", "name": "我的错题本", "base_kind": "module",
                    "content_kind": "quiz", "desc": "错题本", "ports": []}]
        snapshot = {
            "nodes": nodes,
            "edges": [],
            "user_recipes": recipes,
            "quiz_weak": ["偏导数"],
        }
        sub = _focus_subgraph(snapshot, ["n0"])
        self.assertIsNotNone(sub)
        self.assertLess(len(sub["nodes"]), len(nodes))
        self.assertEqual(sub["user_recipes"], recipes)
        self.assertEqual(sub["quiz_weak"], ["偏导数"])

    def test_user_recipes_absent_when_snapshot_has_none(self):
        from harness.review_ops import _focus_subgraph

        snapshot = {"nodes": [{"id": "n0", "kind": "knowledge"}], "edges": []}
        sub = _focus_subgraph(snapshot, ["n0"])
        self.assertNotIn("user_recipes", sub)


if __name__ == "__main__":
    unittest.main()
