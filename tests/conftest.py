"""tests/conftest.py：全测试进程的公共环境。

v9 向量证据（server/embedding.py）在本机存在模型文件时会真加载 613MB 模型——
路由级测试（TestClient 打 /api/continent）绝不能烧这个：统一在此关掉向量证据，
投影自动退回纯词面口径（这正是设计好的降级路径）。需要测向量模块本身的用例
在各自文件里 monkeypatch 环境变量或注入假向量，不碰真模型。
"""

import os
import sys
from pathlib import Path

os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")  # 键名须与 embedding.py 的开关一致（曾少写 H 形同虚设）

# 全局补两个搜索路径（T161 收编后 harness.review 顶层 import server.http_client，
# 只插仓库根的旧口径不再够用；各测试文件自己的插入与此幂等，留着不碍事）：
# - 仓库根：harness 包
# - src/：server 包与 main 模块
_ROOT = str(Path(__file__).resolve().parent.parent)
for _p in (_ROOT, _ROOT + "/src"):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import pytest  # noqa: E402

from server import usage_stats as _usage_stats  # noqa: E402


@pytest.fixture(autouse=True)
def _isolate_usage_dir(tmp_path, monkeypatch):
    """用量记账（record_usage/record_failure）在测试里一律落 tmp 目录。

    2026-10-08 起失败调用也进账：打上游错误路径的用例（非 200/非 JSON/连接
    异常）会触发 record_failure，不隔离就会写真仓库的 data/usage。
    test_usage_stats 的 setUp 自设 USAGE_DIR，晚于本 fixture 生效，不受影响。
    """
    monkeypatch.setattr(_usage_stats, "USAGE_DIR", tmp_path / "usage")
