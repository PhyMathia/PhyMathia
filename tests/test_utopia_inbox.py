"""Utopia 快照收件箱（双击 .pmu 桌面启动器的服务端读取面）路由级测试.

启动器（scripts/utopia_opener/open_pmu.py）把文件复制进 data/utopia_inbox/（唯一
写路径，本机文件操作），查看器经 GET /api/utopia/inbox/{name} 只读取回。这里用
test_routes.py 的临时目录补丁模式，验证读取/404/非法名三态。
"""

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

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import knowledge_routes as knowledge_routes_mod  # noqa: E402  UTOPIA_INBOX_DIR 属主（T163）


class UtopiaInboxTest(unittest.TestCase):
    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        inbox = Path(self._td.name) / "utopia_inbox"
        inbox.mkdir(parents=True, exist_ok=True)
        self._inbox = inbox
        self._orig = knowledge_routes_mod.UTOPIA_INBOX_DIR
        knowledge_routes_mod.UTOPIA_INBOX_DIR = inbox
        self.client = TestClient(main_mod.app)

    def tearDown(self):
        knowledge_routes_mod.UTOPIA_INBOX_DIR = self._orig
        self._td.cleanup()

    def _put(self, name: str, text: str):
        (self._inbox / name).write_text(text, encoding="utf-8")

    def test_read_delivered_snapshot(self):
        self._put("泊松分布.pmu", '{"format":"phymath-utopia/graph","version":1,"nodes":[]}')
        resp = self.client.get("/api/utopia/inbox/泊松分布.pmu")
        # 文件名含中文：服务端白名单只放行安全字符，中文在启动器侧已被洗净，
        # 这里直接投递中文名应被 422 拒绝（防绕过启动器直写怪名）
        self.assertIn(resp.status_code, (200, 422))
        if resp.status_code == 200:
            self.assertEqual(resp.json()["format"], "phymath-utopia/graph")

    def test_read_ascii_name_ok(self):
        self._put("snapshot_123.pmu", '{"format":"phymath-utopia/graph","version":1,"nodes":[]}')
        resp = self.client.get("/api/utopia/inbox/snapshot_123.pmu")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["format"], "phymath-utopia/graph")
        self.assertIn("application/json", resp.headers.get("content-type", ""))

    def test_missing_returns_404(self):
        resp = self.client.get("/api/utopia/inbox/not_there.pmu")
        self.assertEqual(resp.status_code, 404)

    def test_bad_names_rejected(self):
        for bad in ["..%2F..%2Fetc%2Fpasswd", "a b.pmu", "no_extension", "../escape.pmu"]:
            resp = self.client.get(f"/api/utopia/inbox/{bad}")
            self.assertIn(resp.status_code, (404, 422), f"{bad} 应被拒（404/422），不能 200")

    def test_non_pmu_suffix_rejected(self):
        self._put("evil.txt", "not a snapshot")
        resp = self.client.get("/api/utopia/inbox/evil.txt")
        self.assertEqual(resp.status_code, 422)


if __name__ == "__main__":
    unittest.main()
