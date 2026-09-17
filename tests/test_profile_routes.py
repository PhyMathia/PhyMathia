"""画像采集与注入的路由/服务回归（从 test_routes.py 拆出，逐步瘦身大文件）。

运行：python3 -m pytest tests/test_profile_routes.py -q
数据路径仍由 RouteTestBase 重定向到临时目录；不触网、不碰真实画像。
"""

import json
import time

from test_routes import RouteTestBase
import main as main_mod
from server import profile as profile_mod


class ProfileMemoryTest(RouteTestBase):
    """v2 合并式画像采集与契约化注入的回归。

    旧版病根（真机三份画像 0 固化）：候选按原文逐字节比对、出现两次才固化、
    提取只看最后一轮——同一陈述换个措辞就永远卡在 pending。v2 改为
    new/confirm/update/remove 合并操作 + 规范化查重 + stage/goal 一次直入。
    """

    def _dev(self):
        return "dev_test_profile"

    def test_stage_goal_new_direct_solid(self):
        r = profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "我是高二学生", "category": "stage"},
            {"op": "new", "fact": "喜欢天体物理", "category": "interest"},
        ])
        p = profile_mod.get_profile(self._dev())
        self.assertEqual([f["category"] for f in p["facts"]], ["stage"])
        self.assertEqual([x["fact"] for x in p["pending"]], ["喜欢天体物理"])
        self.assertEqual(r["promoted"], ["我是高二学生"])

    def test_pending_confirms_via_normalized_repeat(self):
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "喜欢天体物理", "category": "interest"}])
        r = profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "用户是喜欢天体物理的", "category": "interest"}])
        p = profile_mod.get_profile(self._dev())
        self.assertEqual(len(p["pending"]), 0)
        self.assertEqual(r["promoted"], ["喜欢天体物理"])

    def test_confirm_by_id_promotes_pending(self):
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "薄弱：电磁感应", "category": "weakness"}])
        pid = profile_mod.get_profile(self._dev())["pending"][0]["id"]
        profile_mod.apply_profile_ops(self._dev(), [{"op": "confirm", "id": pid}])
        p = profile_mod.get_profile(self._dev())
        self.assertEqual([f["fact"] for f in p["facts"]], ["薄弱：电磁感应"])

    def test_update_supersedes_with_history(self):
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        fid = profile_mod.get_profile(self._dev())["facts"][0]["id"]
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "update", "id": fid, "fact": "我上高三了", "category": "stage"}])
        f = profile_mod.get_profile(self._dev())["facts"][0]
        self.assertEqual(f["fact"], "我上高三了")
        self.assertEqual(f["history"][0]["fact"], "我是高二学生")

    def test_update_to_known_fact_merges(self):
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "薄弱：电磁感应", "category": "weakness"},
            {"op": "new", "fact": "薄弱：微分方程", "category": "weakness"},
        ])
        p = profile_mod.get_profile(self._dev())
        w1 = next(x for x in p["pending"] if "电磁感应" in x["fact"])
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "update", "id": w1["id"], "fact": "薄弱：微分方程", "category": "weakness"}])
        p = profile_mod.get_profile(self._dev())
        self.assertTrue(all("电磁感应" not in x["fact"] for x in p["pending"] + p["facts"]))
        merged = next(x for x in p["facts"] if "微分方程" in x["fact"])
        self.assertEqual(merged["occurrences"], 2)

    def test_remove_archives(self):
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        fid = profile_mod.get_profile(self._dev())["facts"][0]["id"]
        profile_mod.apply_profile_ops(self._dev(), [{"op": "remove", "id": fid}])
        p = profile_mod.get_profile(self._dev())
        self.assertEqual(p["facts"], [])
        self.assertEqual(p["archive"][0]["fact"], "我是高二学生")

    def test_legacy_add_fact_candidates_still_works(self):
        self.assertEqual(
            profile_mod.add_fact_candidates(self._dev(),
                                            [{"fact": "薄弱：电磁感应", "category": "weakness"}]),
            1)
        self.assertEqual(len(profile_mod.get_profile(self._dev())["pending"]), 1)

    def test_context_contract_sections_and_idle_excluded(self):
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "我是高二学生", "category": "stage"},
            {"op": "new", "fact": "目标：高考物理90分", "category": "goal"},
            {"op": "new", "fact": "薄弱：电磁感应", "category": "weakness"},
        ])
        # 手动确认薄弱候选，使其固化参与注入
        p = profile_mod.get_profile(self._dev())
        pid = p["pending"][0]["id"]
        profile_mod.apply_profile_ops(self._dev(), [{"op": "confirm", "id": pid}])
        ctx = profile_mod.profile_context(self._dev())
        for token in ("【学段】", "【目标】", "【薄弱】", "使用规则", "</user_profile>"):
            self.assertIn(token, ctx["text"])
        self.assertTrue(ctx["text"].rstrip().endswith("</user_profile>"))
        # 注入回写 → 事实变「在用」；把时间拨到 31 天前再空注入 → 休眠且不再注入
        profile_mod.mark_profile_used(self._dev(), ctx["factIds"])
        raw = profile_mod.get_profile(self._dev())
        old = time.time() - 31 * 86400
        for f in raw["facts"]:
            f["lastUsedAt"] = old
        profile_mod.save_profile(self._dev(), raw)
        profile_mod.mark_profile_used(self._dev(), [])
        raw = profile_mod.get_profile(self._dev())
        self.assertTrue(all(f["status"] == "idle" for f in raw["facts"]))
        self.assertNotIn("高考物理90分", profile_mod.profile_context(self._dev())["text"])

    def test_disabled_ignores_ops_and_injection(self):
        profile_mod.update_profile(self._dev(), {"enabled": False})
        self.assertEqual(
            profile_mod.apply_profile_ops(self._dev(),
                                          [{"op": "new", "fact": "考研备考", "category": "goal"}])["changed"],
            0)
        self.assertEqual(profile_mod.profile_context(self._dev())["text"], "")
        self.assertEqual(profile_mod.profile_ops_digest(self._dev()), "")

    def test_candidates_endpoint_roundtrip(self):
        resp = self.client.post("/api/profile/candidates", json={
            "device_id": self._dev(),
            "candidates": [{"fact": "检测多次答错：简谐运动", "category": "weakness", "source": "quiz"}],
            "source": "signal",
        })
        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertEqual(body["changed"], 1)
        p = profile_mod.get_profile(self._dev())
        self.assertEqual(p["pending"][0]["source"], "quiz")

    def test_candidates_endpoint_requires_device(self):
        resp = self.client.post("/api/profile/candidates", json={"candidates": []})
        self.assertEqual(resp.status_code, 400)

    def test_extract_returns_profile_promoted(self):
        """提取链路：模型输出的 profile_ops 合并进画像，响应带 promoted 供前端提示。"""
        async def _fake_extract(messages, provider, api_key, model, base_url, level,
                                profile_digest=""):
            self.assertIn("pf_", profile_digest)  # 既有画像摘要必须随提取请求下发
            return ([
                {"title": "简谐运动", "category": "physics", "tags": [],
                 "summary": "回复力与位移成正比的振动", "formulas": ["$F=-kx$"]},
            ], [], [
                {"op": "new", "fact": "我是高二学生", "category": "stage"},
                {"op": "confirm", "id": "pf_missing"},  # 未知 id 应被安全忽略
            ])
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "喜欢天体物理", "category": "interest"}])
        orig = main_mod._ai_extract_knowledge
        main_mod._ai_extract_knowledge = _fake_extract
        try:
            resp = self.client.post("/api/extract_knowledge", json={
                "sessionId": "sess_prof",
                "device_id": self._dev(),
                "provider": "deepseek", "api_key": "k", "model": "m",
                "messages": [
                    {"role": "user", "content": "解释简谐运动"},
                    {"role": "assistant", "content": "# 简谐运动\n回复力与位移成正比。"},
                ],
            })
        finally:
            main_mod._ai_extract_knowledge = orig
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["profile"]["promoted"], ["我是高二学生"])
        self.assertTrue(any(f["fact"] == "我是高二学生"
                            for f in profile_mod.get_profile(self._dev())["facts"]))

    def test_style_fact_injected_into_style_section(self):
        """style 类别事实须并入【偏好】段：否则记了永不注入，却一直被 lastUsedAt 刷新成死数据。"""
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "偏好简洁的回答", "category": "style"}])
        pid = profile_mod.get_profile(self._dev())["pending"][0]["id"]
        profile_mod.apply_profile_ops(self._dev(), [{"op": "confirm", "id": pid}])
        ctx = profile_mod.profile_context(self._dev())
        self.assertIn("【偏好】", ctx["text"])
        self.assertIn("偏好简洁的回答", ctx["text"])
        self.assertIn(pid, ctx["factIds"])  # 被注入的事实须回写 lastUsedAt

    def test_legacy_and_ops_same_fact_not_double_counted(self):
        """模型同时输出新旧两种格式时，同一句陈述不能被计两次（否则一击即固化）。"""
        async def _fake_extract(messages, provider, api_key, model, base_url, level,
                                profile_digest=""):
            return ([], [
                {"fact": "我是高二学生", "category": "stage"},   # 旧格式 profile_facts
            ], [
                {"op": "new", "fact": "我是高二学生", "category": "stage"},  # 新格式同文本
            ])
        orig = main_mod._ai_extract_knowledge
        main_mod._ai_extract_knowledge = _fake_extract
        try:
            resp = self.client.post("/api/extract_knowledge", json={
                "sessionId": "sess_dup", "device_id": self._dev(),
                "provider": "deepseek", "api_key": "k", "model": "m",
                "messages": [{"role": "user", "content": "问"},
                             {"role": "assistant", "content": "答"}],
            })
        finally:
            main_mod._ai_extract_knowledge = orig
        self.assertEqual(resp.status_code, 200)
        p = profile_mod.get_profile(self._dev())
        stage_facts = [f for f in p["facts"] if f["fact"] == "我是高二学生"]
        self.assertEqual(len(stage_facts), 1)
        self.assertEqual(stage_facts[0]["occurrences"], 1)

    def test_candidates_endpoint_caps_batch(self):
        resp = self.client.post("/api/profile/candidates", json={
            "device_id": self._dev(),
            "candidates": [{"fact": f"薄弱主题{i}", "category": "weakness"} for i in range(60)],
        })
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["changed"], 50)  # 超出单批上限的部分丢弃

    def test_mark_used_skips_disabled_profile(self):
        """停用画像不因回写路径产生任何写盘（休眠转移也停）。"""
        profile_mod.apply_profile_ops(self._dev(), [
            {"op": "new", "fact": "我是高二学生", "category": "stage"}])
        fid = profile_mod.get_profile(self._dev())["facts"][0]["id"]
        profile_mod.update_profile(self._dev(), {"enabled": False})
        profile_mod.mark_profile_used(self._dev(), [fid])
        raw = profile_mod.get_profile(self._dev())
        self.assertTrue(raw["enabled"] is False)
        self.assertEqual(raw["facts"][0]["lastUsedAt"], 0)  # 未被回写
