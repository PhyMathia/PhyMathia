"""T224 回归：公式库对 createdAt 的「全程数值假设」被一条字符串脏数据打成 500。

背景：continent 侧 2026-09-20 修过同型事故（`_num_or_zero`），knowledge 侧漏修——
公式排序 key 上 int/str 混比抛 TypeError，GET/POST 读写全 500。本文件钉死：
- 读侧兜底：GET /api/formulas、_dedupe_formula_map、_dedupe_knowledge 遇字符串
  createdAt 照常返回不报错（GET 是只读视图，不回写自愈）；
- 写入入口收敛：POST /api/formulas 不再把字符串 createdAt 原样收进库。
"""

import asyncio
import os
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server import accounts  # noqa: E402
from server import config as config_mod  # noqa: E402
from server import knowledge  # noqa: E402
from server import knowledge_routes  # noqa: E402
from server import storage  # noqa: E402


class _FakeRequest:
    """直调路由层函数的假请求：只提供 json()。_account_id_raw 取
    query_params 的 AttributeError 被它自己的 try/except 吞掉，账号落 default。"""

    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    """DATA_DIR 指向临时目录 + 清账号缓存（test_accounts 同款隔离姿势）；
    yield default 账号的路径组（ensure_account 幂等建目录）。"""
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    yield accounts.ensure_account("default")
    accounts._ENSURED.clear()


# ====== 读侧兜底 ======

def test_get_formulas_tolerates_string_created_at(acc_env):
    # 库里一条字符串 createdAt＋其余数值：GET 必须 200 形状正常返回，排序不炸；
    # 字符串按数值语义参与降序（1788010733166 < 1788010771879 > 1）
    storage._write_json(acc_env.formulas_path, {
        "f_old": {"id": "f_old", "latex": "F=ma", "concept": "牛顿第二定律",
                  "createdAt": 1},
        "f_str": {"id": "f_str", "latex": "E=hf", "concept": "光电效应",
                  "createdAt": "1788010733166"},
        "f_new": {"id": "f_new", "latex": "p=mv", "concept": "动量定理",
                  "createdAt": 1788010771879},
    })
    payload = asyncio.run(knowledge_routes.api_get_formulas())
    assert payload["count"] == 3
    assert [it["id"] for it in payload["items"]] == ["f_new", "f_str", "f_old"]
    # 只读视图拍板：GET 不做写回自愈——磁盘上的字符串原样保留
    raw = acc_env.formulas_path.read_text(encoding="utf-8")
    assert '"createdAt": "1788010733166"' in raw


def test_dedupe_formula_map_tolerates_string_created_at():
    # 直接喂含字符串 createdAt 的重复组（同公式三条）：不抛异常，
    # model 优先、组内按数值 created_at 取新
    data = {
        "f1": {"id": "f1", "latex": "F=-kx", "meaningSource": "local",
               "sessionId": "s1", "createdAt": "1788010733166"},
        "f2": {"id": "f2", "latex": "$F=-kx$", "meaningSource": "model",
               "sessionId": "s2", "createdAt": 1788010771879},
        "f3": {"id": "f3", "latex": "F=-kx", "meaningSource": "model",
               "sessionId": "s3", "createdAt": "坏时间戳"},
    }
    result = knowledge._dedupe_formula_map(data)
    assert list(result.keys()) == ["f2"]
    # 同源组内纯数字字符串按数值比大小（1000000000000 > 999999999999，
    # 字典序则相反）：Newer 字符串胜
    local_only = {
        "g_old": {"id": "g_old", "latex": "a=b", "meaningSource": "local",
                  "sessionId": "s1", "createdAt": 999999999999},
        "g_new": {"id": "g_new", "latex": "a=b", "meaningSource": "local",
                  "sessionId": "s2", "createdAt": "1000000000000"},
    }
    assert list(knowledge._dedupe_formula_map(local_only).keys()) == ["g_new"]


def test_dedupe_knowledge_tolerates_string_created_at():
    # _dedupe_knowledge 的保优排序末位同样是 createdAt or 0：重复组里
    # int/字符串混比一样 TypeError。三条同题知识点（摘要长度错开让前两个
    # key 打平，把比较逼到 createdAt 上）
    data = {
        "k1": {"id": "k1", "title": "简谐运动", "summary": "本地摘要",
               "summarySource": "local", "sessionId": "s1",
               "createdAt": 1788010733166},
        "k2": {"id": "k2", "title": "简谐 运动", "summary": "本地摘要",
               "summarySource": "local", "sessionId": "s2",
               "createdAt": "1788010771879"},
        "k3": {"id": "k3", "title": "简谐运动", "summary": "短",
               "summarySource": "local", "sessionId": "s3",
               "createdAt": "坏时间戳"},
    }
    result = knowledge._dedupe_knowledge(data)
    assert len(result) == 1
    # 升序排序取组尾作保留条：同 rank/同摘要长度下 createdAt 最新的赢
    assert next(iter(result.values()))["id"] == "k2"


# ====== 写入入口收敛 ======

def test_save_formulas_coerces_created_at(acc_env):
    now = int(time.time() * 1000)
    asyncio.run(knowledge_routes.api_save_formulas(_FakeRequest({"items": [
        {"id": "f_str", "latex": "F=ma", "sessionId": "s1",
         "createdAt": "1788010733166"},
        {"id": "f_bad", "latex": "E=hf", "sessionId": "s1",
         "createdAt": "坏时间戳"},
        {"id": "f_float", "latex": "p=mv", "sessionId": "s1",
         "createdAt": 1500000000000.5},
    ]})))
    data = storage._read_json(acc_env.formulas_path, {})
    # 纯数字字符串 → int 原值
    assert data["f_str"]["createdAt"] == 1788010733166
    assert isinstance(data["f_str"]["createdAt"], int)
    # 坏字符串 → 服务端当前时间（数值）
    assert isinstance(data["f_bad"]["createdAt"], int)
    assert abs(data["f_bad"]["createdAt"] - now) < 60_000
    # int/float 原样收
    assert data["f_float"]["createdAt"] == 1500000000000.5
