"""T43 上游错误文案回归：llm_common.upstream_error_detail 的密钥引导。

401/403 与凭证类正文必须带「到模型设置检查或更换 API 密钥」的引导——此前密钥
失效全程只说「上游连接失败」，用户去查网络而不是换钥匙。普通 5xx 正文照旧
透传状态与原文，不提密钥（不把无关故障往密钥上引）。
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (ROOT, os.path.join(ROOT, "src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from server import llm_common  # noqa: E402


class UpstreamErrorDetailTest(unittest.TestCase):
    def test_401_always_guides_to_model_settings(self):
        # 状态码本身就是凭证信号：正文不带任何凭证字样也要给引导
        text = llm_common.upstream_error_detail(401, '{"error": "bad request"}')
        self.assertIn("上游返回 401", text)
        self.assertIn("密钥", text)
        self.assertIn("模型设置", text)

    def test_403_guides_to_key(self):
        text = llm_common.upstream_error_detail(403, "forbidden")
        self.assertIn("上游返回 403", text)
        self.assertIn("密钥", text)

    def test_500_body_with_credential_marker_guides_to_key(self):
        # 网关常回 200 前的其他码 + 凭证类正文：按正文判定
        text = llm_common.upstream_error_detail(500, '{"error": {"message": "invalid_api_key"}}')
        self.assertIn("上游返回 500", text)
        self.assertIn("invalid_api_key", text)  # 正文照旧透传
        self.assertIn("密钥", text)

    def test_500_plain_body_no_key_hint(self):
        text = llm_common.upstream_error_detail(500, "internal error")
        self.assertIn("上游返回 500", text)
        self.assertIn("internal error", text)
        self.assertNotIn("密钥", text)


if __name__ == "__main__":
    unittest.main()
