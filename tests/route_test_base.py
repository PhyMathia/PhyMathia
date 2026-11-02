"""RouteTestBase：TestClient 路由级测试共享夹具（2026-11-02 T221 收口）。

此前 test_routes / test_review_backend_20260920 / test_health_fixes_t230_t234
三份手拷 _patched_paths＋setUp/tearDown，另有十余个文件 `from test_routes
import RouteTestBase` 借道——口径曾漂移过一次（T271 缺 DATA_DIR，夹具写目标与
路由 resolve_paths 读目标分家，真机会话被写进回收站，见 2026-10-11 日志
「夹具缺口插曲」节）。收成一份：改口径只改这里。

语义取三份的超集：
- patch config.DATA_DIR 一处（accounts.resolve_paths 调用期读它），路径值按
  账号域布局（data/users/default/…），「夹具写入的目标」与「路由经
  resolve_paths 读到的目标」是同一份文件；
- main/storage/backup/profile 四模块命名空间同补（from-import 各持一份引用，
  路由本体已不读这些常量，纯兼容既有夹具写法）；属性原本不存在（_MISSING）
  则 tearDown 删而非赋 None；
- accounts._ENSURED 与 storage._JSON_READ_CACHE 双清（setUp/tearDown 各一次）；
- MESSAGES_DIR/PROFILES_DIR 预建；TestClient 统一绑 127.0.0.1（Host 白名单口径）。
conftest 的 autouse _isolate_data_dir 只兜 config.DATA_DIR，本基类是它的超集，
幂等叠加无害（setUp 晚于 fixture、后到者胜）。
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for _p in (ROOT, SRC):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from fastapi.testclient import TestClient  # noqa: E402

import main as main_mod  # noqa: E402
from server import accounts as accounts_mod  # noqa: E402
from server import backup as backup_mod  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import profile as profile_mod  # noqa: E402
from server import storage as storage_mod  # noqa: E402

_MISSING = object()


def patched_paths(td):
    """账号域布局下的真实路径（原三份 _patched_paths 的合体，去下划线＝公开共享）。"""
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


class RouteTestBase(unittest.TestCase):
    """数据路径重定向到临时目录，测试后恢复；路由级测试统一继承这里。"""

    def setUp(self):
        self._td = tempfile.TemporaryDirectory()
        paths = patched_paths(self._td.name)
        accounts_mod._ENSURED.clear()
        paths["MESSAGES_DIR"].mkdir(parents=True, exist_ok=True)
        # 画像写入走 storage 的临时文件落盘，父目录必须先存在
        paths["PROFILES_DIR"].mkdir(parents=True, exist_ok=True)
        # backup/profile 模块是 from-import，命名空间里有自己的路径引用，需一并补丁
        self._orig_modules = {}
        for mod in (main_mod, storage_mod, backup_mod, profile_mod):
            for name, value in paths.items():
                self._orig_modules[(id(mod), name)] = getattr(mod, name, _MISSING)
                setattr(mod, name, value)
        self._orig_config = {}
        for name, value in paths.items():
            self._orig_config[name] = getattr(config_mod, name, _MISSING)
            setattr(config_mod, name, value)
        storage_mod._JSON_READ_CACHE.clear()
        self.client = TestClient(main_mod.app, base_url="http://127.0.0.1")

    def tearDown(self):
        for (mid, name), value in self._orig_modules.items():
            for mod in (main_mod, storage_mod, backup_mod, profile_mod):
                if id(mod) == mid:
                    if value is _MISSING:
                        if hasattr(mod, name):
                            delattr(mod, name)
                    else:
                        setattr(mod, name, value)
        for name, value in self._orig_config.items():
            if value is _MISSING:
                if hasattr(config_mod, name):
                    delattr(config_mod, name)
            else:
                setattr(config_mod, name, value)
        accounts_mod._ENSURED.clear()
        storage_mod._JSON_READ_CACHE.clear()
        self._td.cleanup()
