"""T147 回归：GET /api/knowledge、/api/formulas 的 ETag/304 缓存协商。

前端 15 秒轮询此前每轮全量重算去重＋全表传输，库越大越卡。现在：
- 200 响应带 ETag 与 Cache-Control: no-cache（存但每次回源验证）；
- 带 If-None-Match 回源：内容没变 → 304 空体（ETag 原样带回）；
- 文件被写（mtime/size 变）→ ETag 变、200 新内容（写路径免主动清缓存）；
- /api/formulas?q= 搜索变体与整表互不串键（缓存键带 q）。
"""

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402


class KnowledgeEtagTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main_mod.app)
        main_mod._json_get_cache.clear()
        # 多账号 P1：路由经 accounts.resolve_paths 读库，patch DATA_DIR 一处
        from server import accounts as accounts_mod
        from server import config as config_mod
        self._config_mod = config_mod
        self._accounts_mod = accounts_mod
        self._orig_data_dir = config_mod.DATA_DIR
        self._td = tempfile.TemporaryDirectory()
        config_mod.DATA_DIR = Path(self._td.name)
        accounts_mod._ENSURED.clear()
        self.kp = Path(self._td.name) / "users" / "default" / "knowledge.json"
        self.fp = Path(self._td.name) / "users" / "default" / "formulas.json"
        self.kp.parent.mkdir(parents=True, exist_ok=True)
        self.kp.write_text("{}", encoding="utf-8")
        self.fp.write_text("{}", encoding="utf-8")

    def tearDown(self):
        self._config_mod.DATA_DIR = self._orig_data_dir
        self._accounts_mod._ENSURED.clear()
        main_mod._json_get_cache.clear()
        self._td.cleanup()

    @staticmethod
    def _write_json(path: Path, obj):
        # 两次写可能落进同一 mtime 刻度：显式 utime 拨 1ms，指纹必变
        path.write_text(json.dumps(obj, ensure_ascii=False), encoding="utf-8")
        ns = time.time_ns() + 1_000_000
        os.utime(path, ns=(ns, ns))

    def test_knowledge_etag_roundtrip(self):
        r1 = self.client.get("/api/knowledge")
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.headers.get("Cache-Control"), "no-cache")
        etag = r1.headers.get("ETag")
        self.assertTrue(etag and etag.startswith('"'))
        # 内容没变：回源命中 → 304 空体，ETag 原样带回
        r2 = self.client.get("/api/knowledge", headers={"If-None-Match": etag})
        self.assertEqual(r2.status_code, 304)
        self.assertEqual(r2.content, b"")
        self.assertEqual(r2.headers.get("ETag"), etag)
        # 文件被写 → 指纹变 → ETag 变、200 新内容
        self._write_json(self.kp, {
            "k1": {"id": "k1", "title": "牛顿第二定律", "sessionId": "s1",
                   "formulas": [], "createdAt": 1},
        })
        r3 = self.client.get("/api/knowledge", headers={"If-None-Match": etag})
        self.assertEqual(r3.status_code, 200)
        self.assertNotEqual(r3.headers.get("ETag"), etag)
        self.assertIn("牛顿第二定律", r3.text)
        # 新 ETag 同样可协商
        r4 = self.client.get("/api/knowledge", headers={"If-None-Match": r3.headers["ETag"]})
        self.assertEqual(r4.status_code, 304)

    def test_formulas_etag_and_q_variants(self):
        # 两条公式（f2 不含「牛顿」）：整表与 q=牛顿 的内容必然不同，ETag 必然不同
        self._write_json(self.fp, {
            "f1": {"id": "f1", "latex": "F=ma", "concept": "牛顿第二定律",
                   "meaning": "", "topic": "", "related": [], "createdAt": 1},
            "f2": {"id": "f2", "latex": "E=hf", "concept": "光电效应",
                   "meaning": "", "topic": "", "related": [], "createdAt": 2},
        })
        r1 = self.client.get("/api/formulas")
        self.assertEqual(r1.status_code, 200)
        self.assertEqual(r1.json()["count"], 2)
        etag = r1.headers["ETag"]
        self.assertEqual(
            self.client.get("/api/formulas", headers={"If-None-Match": etag}).status_code, 304)
        # q 变体独立键：同一份文件，不同 q 各自协商，互不串
        rq1 = self.client.get("/api/formulas", params={"q": "牛顿"})
        self.assertEqual(rq1.status_code, 200)
        self.assertEqual(rq1.json()["count"], 1)
        rq2 = self.client.get("/api/formulas", params={"q": "牛顿"},
                              headers={"If-None-Match": rq1.headers["ETag"]})
        self.assertEqual(rq2.status_code, 304)
        rq3 = self.client.get("/api/formulas", params={"q": "量子"},
                              headers={"If-None-Match": rq1.headers["ETag"]})
        self.assertEqual(rq3.status_code, 200)  # 不同 q 内容不同，绝不能 304
        # 整表的 ETag 不能顶替 q 变体的判断（q 过滤后的内容与整表不同）
        rq4 = self.client.get("/api/formulas", params={"q": "牛顿"},
                              headers={"If-None-Match": etag})
        self.assertEqual(rq4.status_code, 200)

    def test_formulas_write_invalidates(self):
        r1 = self.client.get("/api/formulas")
        etag = r1.headers["ETag"]
        self._write_json(self.fp, {
            "f1": {"id": "f1", "latex": "E=mc^2", "concept": "质能方程",
                   "meaning": "", "topic": "", "related": [], "createdAt": 2},
        })
        r2 = self.client.get("/api/formulas", headers={"If-None-Match": etag})
        self.assertEqual(r2.status_code, 200)
        self.assertEqual(r2.json()["count"], 1)
        self.assertIn("质能方程", r2.text)


class ModelPricingFreeTest(unittest.TestCase):
    """T60：/api/models/list 的免费/付费标注判定（形态各家不一，统一 float 再比）。"""

    def test_pricing_flags(self):
        f = main_mod._model_pricing_free
        self.assertIsNone(f({"id": "x"}))                      # 无定价字段：不标注
        self.assertIsNone(f({"id": "x", "pricing": {}}))       # 空定价：不标注
        self.assertIsNone(f({"id": "x", "pricing": {"prompt": "abc"}}))  # 读不了：不标注
        self.assertIs(f({"id": "x", "pricing": {"prompt": "0", "completion": "0"}}), True)
        self.assertIs(f({"id": "x", "pricing": {"prompt": 0.0, "completion": 0}}), True)
        self.assertIs(f({"id": "x", "pricing": {"prompt": "0.000001", "completion": "0"}}), False)


if __name__ == "__main__":
    unittest.main()
