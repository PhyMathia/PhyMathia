"""Stage-2 injection budgets and candidate acceptance; temporary profiles only."""
from unittest import mock

from test_routes import RouteTestBase
from server import profile


class ReviewProfileStage2Test(RouteTestBase):
    dev = "stage2-profile-only"

    def post_candidates(self, candidates):
        return self.client.post("/api/profile/candidates", json={
            "device_id": self.dev, "candidates": candidates, "source": "signal"})

    def test_m6_http_acceptance_preserves_original_indices(self):
        response = self.post_candidates([
            {}, {"fact": "检测多次答错：微积分", "category": "weakness"},
            {"fact": ""}, {"fact": "检测多次答错：力学", "category": "weakness"}])
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body.get("accepted"), True)
        self.assertEqual(body.get("acceptedIndices"), [1, 3])
        self.assertEqual(body["changed"], 2)
        self.assertEqual(body["promoted"], [])
        self.assertEqual(len(profile.get_profile(self.dev)["pending"]), 2)

    def test_m6_http_disabled_and_invalid_not_accepted(self):
        for disabled in (False, True):
            profile.update_profile(self.dev, {"enabled": not disabled})
            candidates = [{"fact": "检测多次答错：力学"}] if disabled else [{}]
            response = self.post_candidates(candidates)
            self.assertEqual(response.status_code, 200)
            body = response.json()
            self.assertIs(body.get("accepted"), False)
            self.assertEqual(body.get("acceptedIndices"), [])
            self.assertEqual(body["changed"], 0)
        self.assertEqual(profile.get_profile(self.dev)["pending"], [])

    def test_m6_http_storage_failure_is_not_success(self):
        with mock.patch.object(profile, "_mutate_json", side_effect=OSError("injected write failure")):
            response = self.post_candidates([{"fact": "检测多次答错：力学"}])
        self.assertGreaterEqual(response.status_code, 500)

    def test_m6_only_retained_candidates_are_acknowledged(self):
        candidates = [{"fact": f"检测多次答错：主题{i}", "category": "weakness"} for i in range(35)]
        result = profile.apply_profile_ops(self.dev, candidates, report_acceptance=True)
        self.assertEqual(result["acceptedIndices"], list(range(5, 35)))
        persisted = {f["fact"] for f in profile.get_profile(self.dev)["pending"]}
        self.assertEqual(persisted, {candidates[i]["fact"] for i in result["acceptedIndices"]})

    def seed_injection(self, count):
        facts = [{"id": f"pf_{i:02d}", "fact": f"主题{i:02d}的完整事实内容",
                  "category": ("stage", "goal", "weakness", "interest", "style", "other")[i % 6],
                  "occurrences": 100 - i, "updatedAt": 1800000000,
                  "createdAt": 1800000000, "status": "active"} for i in range(count)]
        profile.update_profile(self.dev, {"facts": facts})
        return facts

    def test_m4_twelve_thirteen_boundary(self):
        for count in (12, 13):
            facts = self.seed_injection(count)
            ctx = profile.profile_context(self.dev)
            self.assertEqual(len(ctx["factIds"]), 12)
            self.assertEqual(set(ctx["factIds"]), {f["id"] for f in facts[:12]})
            if count == 13:
                self.assertNotIn(facts[12]["fact"], ctx["text"])

    def test_m4_every_budget_keeps_whole_items_and_rules(self):
        facts = self.seed_injection(13)
        full = profile.profile_context(self.dev)
        for budget in range(len(full["text"]) + 2):
            with self.subTest(budget=budget):
                ctx = profile.profile_context(self.dev, max_chars=budget)
                text = ctx["text"]
                self.assertLessEqual(len(text), budget)
                if not text:
                    self.assertEqual(ctx["factIds"], [])
                    continue
                self.assertTrue(text.startswith("<user_profile>\n"))
                self.assertTrue(text.endswith("\n</user_profile>"))
                for rule in ("1. 学段/目标决定深度与素材", "2. 薄弱章节首次涉及", "3. 兴趣方向可用于举例", "4. 与本对话中最新陈述冲突"):
                    self.assertIn(rule, text)
                self.assertTrue(ctx["factIds"])
                self.assertEqual(set(ctx["factIds"]), {f["id"] for f in facts if f["fact"] in text})
        self.assertEqual(profile.profile_context(self.dev, max_chars=len(full["text"])), full)

    def test_m4_lastused_only_updates_rendered_ids(self):
        self.seed_injection(13)
        profile.update_profile(self.dev, {"explicit": {"stage": "主题00的完整事实内容"}})
        ctx = profile.profile_context(self.dev)
        with mock.patch.object(profile.time, "time", return_value=1800000100):
            profile.mark_profile_used(self.dev, ctx["factIds"])
        for fact in profile.get_profile(self.dev)["facts"]:
            self.assertEqual(fact["lastUsedAt"], 1800000100 if fact["id"] in ctx["factIds"] else 0)
