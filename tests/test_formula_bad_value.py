"""公式库 value 非 dict 脏条目的写路径自愈回归。

脏条目（JSON 语法合法但 value 是 null/字符串/数字/数组）混进 formulas.json 后，
AI 提取入库与「删画布清公式」的 updater 里裸 v.get 抛 AttributeError，
_mutate_json 不写回 → 两条写路径一直 500、不自愈，只有手动保存一次才顺带修好。
本文件钉死三条写路径（AI 入库 / 按会话删除 / 手动保存）统一在 updater 入口
经 _dedupe_formula_map 全量重写跳过坏条目；GET 仍保持只读视图不回写。

与 test_formula_timestamps.py 的 T224 字符串 createdAt 型脏数据是两种形态：
那种触发排序 TypeError 且手动保存同样 500，不属于本文件声明的机制。
"""

import asyncio
import os
import sys

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
    """直调 api_save_formulas 的假请求：只提供 json()。"""

    def __init__(self, body):
        self._body = body

    async def json(self):
        return self._body


@pytest.fixture
def acc_env(tmp_path, monkeypatch):
    monkeypatch.setattr(config_mod, "DATA_DIR", tmp_path)
    accounts._ENSURED.clear()
    yield accounts.ensure_account("default")
    accounts._ENSURED.clear()


# 四种 value 非 dict 形态：null / 字符串 / 数字 / 数组
_BAD_ENTRIES = {
    "f_null": None,
    "f_str": "脏数据",
    "f_num": 12345,
    "f_arr": ["F=ma"],
}


def _seed(path):
    storage._write_json(path, {
        "f_good": {
            "id": "f_good", "latex": "E=hf", "concept": "光电效应",
            "sessionId": "s1", "createdAt": 1700000000000,
        },
        **_BAD_ENTRIES,
    })


def _assert_clean(path):
    """整库最终一致性：所有 value 都是 dict，且四种坏条目物理清除。"""
    data = storage._read_json(path, {})
    assert all(isinstance(v, dict) for v in data.values()), data
    assert all(k not in data for k in _BAD_ENTRIES), data
    return data


# ====== AI 提取入库写路径 ======

def test_ai_extract_add_sanitizes_bad_values(acc_env):
    _seed(acc_env.formulas_path)
    added = knowledge._add_formulas_from_items(
        [{"title": "胡克定律", "summary": "", "formulas": ["F=-kx"]}],
        session_id="s2",
    )
    assert added == 1
    data = _assert_clean(acc_env.formulas_path)
    assert any("F=-kx" in str(v.get("latex") or "") for v in data.values()), data


def test_ai_extract_add_sanitizes_even_without_new_formula(acc_env):
    """本轮提取全是闸外内容（count=0）时坏条目也必须落盘清除——
    钉死「清洗造成的变化计入写回条件」这条，否则 updater 返回 None 不自愈。"""
    _seed(acc_env.formulas_path)
    added = knowledge._add_formulas_from_items(
        [{"title": "能量守恒", "summary": "", "formulas": ["能量守恒"]}],
        session_id="s2",
    )
    assert added == 0
    _assert_clean(acc_env.formulas_path)


# ====== 按会话删除写路径（删画布清公式） ======

def test_delete_by_session_sanitizes_bad_values(acc_env):
    _seed(acc_env.formulas_path)
    result = asyncio.run(knowledge_routes.api_delete_formulas_by_session(session_id="s1"))
    assert result == {"ok": True, "count": 1}
    data = _assert_clean(acc_env.formulas_path)
    assert "f_good" not in data


def test_delete_by_session_no_match_still_sanitizes(acc_env):
    """坏库 + session_id 不匹配任何正常条目：removed 为空也要写回清洗结果。"""
    _seed(acc_env.formulas_path)
    result = asyncio.run(knowledge_routes.api_delete_formulas_by_session(session_id="s_none"))
    assert result == {"ok": True, "count": 0}
    data = _assert_clean(acc_env.formulas_path)
    assert "f_good" in data


def test_delete_all_with_session_id_empty_sanitizes(acc_env):
    """session_id 为空删全库：清洗与清空都不该被坏条目打断。"""
    _seed(acc_env.formulas_path)
    result = asyncio.run(knowledge_routes.api_delete_formulas_by_session(session_id=""))
    assert result["count"] == 1  # 坏条目在 dedupe 阶段已跳过，不计入删除数
    assert storage._read_json(acc_env.formulas_path, {}) == {}


# ====== 手动保存写路径（自愈能力的原始对照） ======

def test_manual_save_sanitizes_bad_values(acc_env):
    _seed(acc_env.formulas_path)
    result = asyncio.run(knowledge_routes.api_save_formulas(_FakeRequest({"items": [
        {"id": "f_new", "latex": "p=mv", "sessionId": "s2", "createdAt": 1700000000001},
    ]})))
    assert result["count"] == 1
    _assert_clean(acc_env.formulas_path)


# ====== GET 只读视图口径不变 ======

def test_get_formulas_readonly_keeps_bad_values_on_disk(acc_env):
    _seed(acc_env.formulas_path)
    payload = asyncio.run(knowledge_routes.api_get_formulas())
    assert payload["count"] == 1  # 坏条目在只读视图里被跳过，不进 items
    data = storage._read_json(acc_env.formulas_path, {})
    assert all(k in data for k in _BAD_ENTRIES), data  # 磁盘原样不动
