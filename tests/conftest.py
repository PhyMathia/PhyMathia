"""tests/conftest.py：全测试进程的公共环境。

v9 向量证据（server/embedding.py）在本机存在模型文件时会真加载 613MB 模型——
路由级测试（TestClient 打 /api/continent）绝不能烧这个：统一在此关掉向量证据，
投影自动退回纯词面口径（这正是设计好的降级路径）。需要测向量模块本身的用例
在各自文件里 monkeypatch 环境变量或注入假向量，不碰真模型。
"""

import os

os.environ.setdefault("PYMATHIA_EMBEDDING", "0")
