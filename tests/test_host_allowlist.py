"""T289：Host 白名单中间件——本地服务只认本机 Host，其余 403。

防 DNS rebinding：恶意网页把攻击域名解析到 127.0.0.1，借浏览器对本地 API 发
「简单请求」（不经 CORS 预检，POST 写动作真实执行）。中间件按 Host 主机名
白名单（localhost/127.0.0.1/::1，任意端口写法都认）放行，其余 403。
RouteTestBase 的客户端 base_url 已统一指到 127.0.0.1（真实 localhost 语义）。
Run: python3 -m pytest tests/test_host_allowlist.py -q
"""

import unittest

from test_routes import RouteTestBase

from main import _host_hostname


class HostHostnameTest(unittest.TestCase):
    """_host_hostname 纯函数：端口剥离与 IPv6 方括号两种写法都要认对。"""

    def test_cases(self):
        cases = {
            "localhost:5050": "localhost",
            "localhost": "localhost",
            "127.0.0.1:5050": "127.0.0.1",
            "127.0.0.1": "127.0.0.1",
            "[::1]:5050": "::1",
            "[::1]": "::1",
            "::1": "::1",  # 裸 IPv6 不带端口：不能被 rsplit 误拆
            "evil.com:5050": "evil.com",
            "evil.com": "evil.com",
        }
        for raw, want in cases.items():
            self.assertEqual(_host_hostname(raw), want, raw)


class HostAllowlistRouteTest(RouteTestBase):
    def test_foreign_host_403(self):
        resp = self.client.get("/health", headers={"Host": "evil.com"})
        self.assertEqual(resp.status_code, 403)

    def test_rebinding_style_post_403_before_route(self):
        # 简单请求不经预检——写动作必须在进路由前就被 Host 闸拦下
        resp = self.client.post("/api/models/config", json={}, headers={"Host": "attacker.example.com"})
        self.assertEqual(resp.status_code, 403)

    def test_localhost_with_port_ok(self):
        self.assertEqual(self.client.get("/health", headers={"Host": "localhost:5050"}).status_code, 200)

    def test_loopback_ipv4_and_ipv6_ok(self):
        self.assertEqual(self.client.get("/health", headers={"Host": "127.0.0.1:5050"}).status_code, 200)
        self.assertEqual(self.client.get("/health", headers={"Host": "[::1]:5050"}).status_code, 200)
        self.assertEqual(self.client.get("/health", headers={"Host": "::1"}).status_code, 200)

    def test_host_case_insensitive(self):
        self.assertEqual(self.client.get("/health", headers={"Host": "LOCALHOST:5050"}).status_code, 200)
        self.assertEqual(self.client.get("/health", headers={"Host": "Evil.Com"}).status_code, 403)

    def test_missing_host_header_allowed(self):
        # HTTP/1.0 式无 Host：放行（浏览器必带 Host，无头请求构不成 rebinding 面）
        resp = self.client.get("/health", headers={"Host": ""})
        self.assertEqual(resp.status_code, 200)
