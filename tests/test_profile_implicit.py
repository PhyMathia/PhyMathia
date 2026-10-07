"""隐式用户画像层（profile_implicit）单元测试：数学口径对齐 docs/用户画像数学模型-2026-10-06.md。

全部走 tmp_path 与显式 path 参数，不触碰 data/profiles 真实画像。
"""

import json
import math
import os
import sys
import time

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

from server import profile, profile_implicit as pi  # noqa: E402
from server import storage as storage_mod  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_json_read_cache():
    """测试直接 write_text 落盘的场景必须先清 storage 读缓存，防读到旧值。"""
    storage_mod._JSON_READ_CACHE.clear()
    yield
    storage_mod._JSON_READ_CACHE.clear()


@pytest.fixture(autouse=True)
def _isolate_seed_sources(monkeypatch, tmp_path):
    """回填源隔离：ensure_seeded 只许碰测试造的 knowledge/kv，不许读真实数据。"""
    empty = tmp_path / "empty_kb.json"
    empty.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(pi, "KNOWLEDGE_PATH", empty)
    monkeypatch.setattr(pi, "kv_read", lambda key, default=None: None)


def _ev(etype, topic="", **kw):
    ev = {"type": etype, "topic": topic}
    ev.update(kw)
    return ev


def _fresh():
    return pi.default_implicit()


# ---- decay2 / maturity ----

def test_decay2_half_life():
    assert pi.decay2(0, 14) == pytest.approx(1.0)
    assert pi.decay2(14 * 86400, 14) == pytest.approx(0.5)
    assert pi.decay2(28 * 86400, 14) == pytest.approx(0.25)
    # 时钟偏差（负 Δt）按 0 处理
    assert pi.decay2(-100, 14) == pytest.approx(1.0)


def test_maturity_sigmoid():
    assert pi.maturity({"events": 0}) < 0.15
    assert pi.maturity({"events": 20}) == pytest.approx(0.5)
    assert pi.maturity({"events": 100}) > 0.99


# ---- 兴趣：衰减计数 + 自激时窗 ----

def test_interest_accumulates_with_lazy_decay():
    s = _fresh()
    day = 86400.0
    pi.apply_events(s, [_ev("ask", "电磁感应", ts=0)], now=0)
    assert s["topics"]["电磁感应"]["w"] == pytest.approx(1.0)
    pi.apply_events(s, [_ev("extract", "电磁感应", ts=day * 14)], now=day * 14)
    t = s["topics"]["电磁感应"]
    # 旧值衰减半个半衰期再叠加 1.5
    assert t["w"] == pytest.approx(0.5 + 1.5)


def test_streak_window_resets():
    s = _fresh()
    pi.apply_events(s, [_ev("ask", "A", ts=0)], now=0)
    pi.apply_events(s, [_ev("ask", "A", ts=3600)], now=3600)  # 1h 内：连问 n=2
    assert s["streak"]["n"] == 2
    pi.apply_events(s, [_ev("ask", "A", ts=3600 + 3 * 3600)], now=3600 + 3 * 3600)  # 超 2h 窗
    assert s["streak"]["n"] == 1


def test_streak_self_excitation_amplifies():
    s = _fresh()
    pi.apply_events(s, [_ev("ask", "A", ts=0)], now=0)
    pi.apply_events(s, [_ev("ask", "A", ts=60)], now=60)
    # 第 2 次：1 + 0.15×(2−1) = 1.15
    assert s["topics"]["A"]["w"] == pytest.approx(1.0 * pi.decay2(60, 14) + 1.0 * 1.15)


# ---- BKT + 半衰期校准 ----

def test_bkt_correct_answer_raises_mastery():
    s = _fresh()
    pi.apply_events(s, [_ev("quiz", "B", correct=True, ts=1000)], now=1000)
    t = s["topics"]["B"]
    # 后验 0.2·0.9/(0.2·0.9+0.8·0.2)≈0.529，学习步 +0.1·(1−0.529)≈0.576
    assert t["p"] > 0.5
    assert t["ans"] == 1 and t["ok"] == 1


def test_bkt_wrong_answer_lowers_but_not_to_zero():
    s = _fresh()
    pi.apply_events(s, [_ev("quiz", "B", correct=False, ts=1000)], now=1000)
    t = s["topics"]["B"]
    assert 0.1 < t["p"] < 0.2  # 后验≈0.03 + 学习步回拉


def test_half_life_calibration_directions():
    s = _fresh()
    now = 1_000_000.0
    # 意外答对（p̂ 低）→ H 大涨：H ← H·e^{γ(1−p̂)}
    pi.apply_events(s, [_ev("quiz", "C", correct=True, ts=now)], now=now)
    h_grew = s["topics"]["C"]["h"]
    assert h_grew > pi.H0_DAYS * math.e ** (pi.H_GAIN * (1 - 0.2) * 0.99)  # 至少接近 e^0.8 倍
    # 预期答对（刚答过、p̂ 高）→ H 微涨（远小于第一跳）
    pi.apply_events(s, [_ev("quiz", "C", correct=True, ts=now + 60)], now=now + 60)
    h2 = s["topics"]["C"]["h"]
    assert pi.H0_DAYS < h2 < h_grew * 1.6
    # 意外答错（p̂ 高）→ H 回落：H ← H·e^{−γp̂}
    h_before_wrong = h2
    pi.apply_events(s, [_ev("quiz", "C", correct=False, ts=now + 120)], now=now + 120)
    assert s["topics"]["C"]["h"] < h_before_wrong * math.e ** (-0.5)


def test_half_life_clamped():
    s = _fresh()
    now = 0.0
    for i in range(30):
        pi.apply_events(s, [_ev("quiz", "E", correct=False, ts=now + i)], now=now + i)
    assert s["topics"]["E"]["h"] >= pi.H_MIN_DAYS


# ---- 没看懂：弱负观测 + 24h 频率上限 ----

def test_confused_weak_negative_with_cap():
    s = _fresh()
    t0 = 1_000_000.0
    pi.apply_events(s, [_ev("quiz", "F", correct=True, ts=t0)], now=t0)
    p_before = s["topics"]["F"]["p"]
    h_before = s["topics"]["F"]["h"]
    pi.apply_events(s, [_ev("confused", "F", ts=t0 + 60)], now=t0 + 60)
    t = s["topics"]["F"]
    assert t["p"] < p_before          # 弱负观测拉低
    assert t["h"] == h_before         # 不动半衰期
    assert t["ans"] == 1              # 不算一次练习（无学习步的 ans 计数不增）
    p_after_one = t["p"]
    # 24h 内连点：不再拉低
    pi.apply_events(s, [_ev("confused", "F", ts=t0 + 3600)], now=t0 + 3600)
    assert s["topics"]["F"]["p"] == p_after_one
    # 超过 24h：再次生效
    pi.apply_events(s, [_ev("confused", "F", ts=t0 + 25 * 3600)], now=t0 + 25 * 3600)
    assert s["topics"]["F"]["p"] < p_after_one


# ---- 风格 EMA ----

def test_style_ema_moves_toward_evidence():
    s = _fresh()
    pi.apply_events(s, [_ev("socratic_answer", "G", correct=True, ts=0)], now=0)
    assert s["style"]["f1"] == pytest.approx(0.05 * 0.6)
    for i in range(1, 20):
        pi.apply_events(s, [_ev("expand", ts=i)], now=i)
    # 展开（形式侧 −0.4）反复出现会把 f1 拉向负区
    assert s["style"]["f1"] < 0


# ---- 节奏 ----

def test_rhythm_updates_all_24_slots():
    s = _fresh()
    now = time.time()
    h3 = time.localtime(now + 3 * 3600).tm_hour
    h10 = time.localtime(now + 10 * 3600).tm_hour
    pi.apply_events(s, [_ev("ask", "H", len=500, ts=now + 3 * 3600)], now=now + 3 * 3600)
    hours = s["rhythm"]["h"]
    assert len(hours) == 24
    assert hours[h3] == pytest.approx(0.02)
    assert hours[h10] == 0.0  # 未碰过的格子保持 0
    # ∀k 更新的关键证据：第二次落在别的格子时，旧格子也在衰减（0.02→0.0196）
    # 而不是停在 0.02 不动（只更新事件格的退化写法）
    pi.apply_events(s, [_ev("ask", "H", len=300, ts=now + 10 * 3600)], now=now + 10 * 3600)
    assert s["rhythm"]["h"][h3] == pytest.approx(0.02 * 0.98)
    assert s["rhythm"]["h"][h10] == pytest.approx(0.02)
    assert s["rhythm"]["avgLen"] == pytest.approx(0.02 * 300 + 0.98 * 0.02 * 500)


# ---- 持久化路径 ----

def test_record_events_persists_and_respects_enabled(tmp_path):
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true, "facts": []}', encoding="utf-8")
    # ts 用真实纪元：record_events 的剪枝按真实时钟算 w_now，假纪元事件会被当场剪掉
    assert pi.record_events(path, [_ev("ask", "I", ts=time.time())]) is True
    import json
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["implicit"]["topics"]["I"]["w"] > 0
    assert data["facts"] == []  # 兄弟字段不丢
    # 开关关闭：忽略（手写文件绕过了 _write_json 的缓存更新，先清缓存防读到旧值）
    storage_mod._JSON_READ_CACHE.clear()
    path.write_text('{"enabled": false, "implicit": {"events": 5}}', encoding="utf-8")
    storage_mod._JSON_READ_CACHE.clear()
    assert pi.record_events(path, [_ev("ask", "I", ts=0)]) is False
    assert json.loads(path.read_text(encoding="utf-8"))["implicit"]["events"] == 5


def test_normalize_roundtrip_keeps_unknown_topic_fields():
    raw = {"topics": {"X": {"w": 2.0, "wAt": 1.0, "p": 0.7, "h": 9.0, "hAt": 1.0,
                            "ans": 3, "ok": 2, "ledger": [{"type": "answer", "at": 1.0, "x": 1}]}}}
    state = pi.normalize_implicit(raw)
    assert state["topics"]["X"]["p"] == 0.7 and state["topics"]["X"]["ans"] == 3
    # 越界值夹取：负半衰期是垃圾输入，按 _ts 语义回退默认 H0
    bad = pi.normalize_implicit({"topics": {"Y": {"p": 5, "h": -3}}, "style": {"f1": 9}})
    assert bad["topics"]["Y"]["p"] == 1.0 and bad["topics"]["Y"]["h"] == pi.H0_DAYS
    assert bad["style"]["f1"] == 1.0


# ---- 回填 ----

def test_ensure_seeded_backfills_and_is_idempotent(tmp_path, monkeypatch):
    kb = tmp_path / "kb.json"
    kb.write_text('{"k1": {"topic": "振动与波动", "createdAt": 1700000000000},'
                  '"k2": {"concept": "微积分", "createdAt": 1700000000000}}', encoding="utf-8")
    monkeypatch.setattr(pi, "KNOWLEDGE_PATH", kb)
    # patch 的是 implicit 模块命名空间里的 kv_read 名字（from-import 绑定，patch
    # storage 模块属性不影响这里）
    monkeypatch.setattr(pi, "kv_read", lambda key, default=None, *a, **k: {
        "q1": {"title": "牛顿第二定律", "correct": 1, "wrong": 1,
               "history": [{"correct": True, "at": 1700000000000, "questionId": "q1"},
                           {"correct": False, "at": 1700000000000 + 86400000, "questionId": "q1"}]},
        "s1": {"title": "追问·惯性", "correct": 0, "wrong": 1,
               "history": [{"correct": False, "at": 1700000000000, "questionId": "socratic"}]},
        "_meta": {"version": 3},
    })
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true}', encoding="utf-8")
    assert pi.ensure_seeded(path) is True
    import json
    state = json.loads(path.read_text(encoding="utf-8"))["implicit"]
    assert state["seeded"] is True
    assert "振动与波动" in state["topics"] and "微积分" in state["topics"]
    assert state["topics"]["牛顿第二定律"]["ans"] == 2  # 回放了两条
    assert state["events"] >= 4
    # 幂等：第二次零写入
    before = path.read_text(encoding="utf-8")
    assert pi.ensure_seeded(path) is False
    assert path.read_text(encoding="utf-8") == before


# ---- KV 差分 ----

def test_quiz_stats_diff_emits_new_answers_only():
    old = {"k": {"correct": 1, "wrong": 0,
                 "history": [{"correct": True, "at": 1000, "questionId": "x"}], "title": "T"}}
    new = {"k": {"correct": 2, "wrong": 1,
                 "history": [{"correct": True, "at": 1000, "questionId": "x"},
                             {"correct": False, "at": 2000, "questionId": "x"},
                             {"correct": False, "at": 3000, "questionId": "socratic"}],
                 "title": "T"}}
    events = pi.quiz_stats_events(old, new)
    assert len(events) == 2
    assert events[0]["type"] == "quiz" and events[0]["correct"] is False
    assert events[1]["type"] == "socratic_answer"
    assert pi.quiz_stats_events(new, old) == []   # 回退不产生事件
    assert pi.quiz_stats_events(None, None) == []


# ---- 编译器 ----

def test_compile_gates_on_maturity():
    s = _fresh()
    assert pi.compile_user_model(s, {}) == []
    now = time.time()
    pi.apply_events(s, [_ev("ask", "Z", ts=now), _ev("ask", "Z", ts=now + 1),
                        _ev("ask", "Z", ts=now + 2)], now=now + 2)
    lines = pi.compile_user_model(s, {})
    assert any(line.startswith("举例：") for line in lines)
    assert any("成熟度" in line for line in lines)


def test_compile_dedupes_against_explicit_interests():
    s = _fresh()
    pi.apply_events(s, [_ev("ask", "天体物理", ts=i) for i in range(3)], now=3)
    profile_data = {"explicit": {"interests": "天体物理"}, "facts": []}
    lines = pi.compile_user_model(s, profile_data)
    assert not any("天体物理" in line for line in lines if line.startswith("举例："))


def test_compile_example_mixed_distribution_format():
    """§8.2：兴趣条目升级为举例混合分布；无探索候选时只出七成侧。"""
    s = _fresh()
    now = time.time()
    pi.apply_events(s, [_ev("ask", "电磁感应", ts=now), _ev("ask", "电磁感应", ts=now + 1),
                        _ev("ask", "电磁感应", ts=now + 2)], now=now + 2)
    lines = pi.compile_user_model(s, {})
    ex = next(line for line in lines if line.startswith("举例："))
    assert ex.startswith("举例：七成用 电磁感应")
    assert "三成带一步" not in ex
    assert not any(line.startswith("兴趣：") for line in lines)


def test_compile_example_fallback_takes_coldest_recorded():
    """拉伸侧退化路：知识库无归类时取候选中 W 最小的已归题主题。"""
    s = _fresh()
    now = time.time()
    evs = [_ev("ask", "电磁感应", ts=now) for _ in range(3)]
    evs += [_ev("ask", "微积分", ts=now) for _ in range(2)]
    evs += [_ev("ask", "光学", ts=now)]
    evs += [_ev("ask", "热学", ts=now - 2 * 86400)]
    evs += [_ev("ask", "数列", ts=now - 10 * 86400)]
    pi.apply_events(s, evs, now=now)
    lines = pi.compile_user_model(s, {})
    ex = next(line for line in lines if line.startswith("举例："))
    assert "七成用 电磁感应/微积分/光学" in ex
    assert "三成带一步 数列/热学" in ex


def test_compile_example_stretch_prefers_same_domain(tmp_path, monkeypatch):
    """拉伸侧主路：知识库 category 同域候选优先于更冷的异域候选。"""
    kb = tmp_path / "kb.json"
    kb.write_text('{"k1": {"topic": "电磁感应", "category": "physics"},'
                  '"k2": {"topic": "力学", "category": "physics"},'
                  '"k3": {"topic": "角动量", "category": "physics"},'
                  '"k4": {"topic": "化学键", "category": "chemistry"}}', encoding="utf-8")
    monkeypatch.setattr(pi, "KNOWLEDGE_PATH", kb)
    s = _fresh()
    now = time.time()
    evs = [_ev("ask", "电磁感应", ts=now) for _ in range(3)]
    evs += [_ev("ask", "微积分", ts=now) for _ in range(3)]
    evs += [_ev("ask", "原子物理", ts=now) for _ in range(2)]
    evs += [_ev("ask", "力学", ts=now - 86400)]          # 同域、w≈0.95
    evs += [_ev("ask", "角动量", ts=now - 3 * 86400)]    # 同域、更冷 w≈0.86
    evs += [_ev("ask", "化学键", ts=now - 22 * 86400)]   # 异域、最冷 w≈0.34
    pi.apply_events(s, evs, now=now)
    lines = pi.compile_user_model(s, {})
    ex = next(line for line in lines if line.startswith("举例："))
    stretch = ex.split("三成带一步 ", 1)[1]
    assert "化学键" not in stretch      # 同域有候选时，异域再冷也不进探索位
    assert stretch.index("角动量") < stretch.index("力学")  # 同域内冷的优先


def test_compile_example_stretch_respects_explicit_dedupe():
    """探索位同款 §8.1 去重：显式兴趣里已有的主题不占探索位。"""
    s = _fresh()
    now = time.time()
    evs = [_ev("ask", "电磁感应", ts=now) for _ in range(3)]
    evs += [_ev("ask", "微积分", ts=now) for _ in range(2)]
    evs += [_ev("ask", "光学", ts=now)]
    evs += [_ev("ask", "热学", ts=now - 86400)]
    pi.apply_events(s, evs, now=now)
    profile_data = {"explicit": {"interests": "热学"}, "facts": []}
    lines = pi.compile_user_model(s, profile_data)
    ex = next(line for line in lines if line.startswith("举例："))
    assert "热学" not in ex
    assert "三成带一步" not in ex   # 唯一候选被显式去重挡下，探索位空缺


def test_compile_interest_frozen_drops_example_line():
    """兴趣冻结：整条举例混合分布不注入（冻结维度不进注入段）。"""
    s = _fresh()
    now = time.time()
    pi.apply_events(s, [_ev("ask", "电磁感应", ts=now + i) for i in range(3)], now=now + 3)
    s["frozen"]["interest"] = True
    lines = pi.compile_user_model(s, {})
    assert not any(line.startswith("举例：") for line in lines)


def test_compile_depth_uses_retention_adjusted_mastery():
    s = _fresh()
    now = time.time()
    # 事件数要过编译门槛（≥3）
    pi.apply_events(s, [_ev("quiz", "微积分", correct=True, ts=now),
                        _ev("ask", "微积分", ts=now + 1),
                        _ev("ask", "微积分", ts=now + 2)], now=now + 2)
    lines = pi.compile_user_model(s, {})
    depth = next(line for line in lines if line.startswith("深度："))
    assert "微积分" in depth and "档" in depth


# ---- 剪枝 ----

def test_prune_removes_cold_topic_but_keeps_answered():
    s = _fresh()
    now = 100 * 86400.0
    pi.apply_events(s, [_ev("ask", "冷主题", ts=0), _ev("quiz", "热主题", correct=True, ts=now)],
                    now=now)
    # 冷主题：一次低权重事件 + 100 天衰减 → w_now ≈ 1×2^(-100/14) < 0.05
    pi.prune_topics(s, now)
    assert "冷主题" not in s["topics"]
    assert "热主题" in s["topics"]


def test_prune_skipped_when_any_dim_frozen():
    s = _fresh()
    now = 100 * 86400.0
    pi.apply_events(s, [_ev("ask", "冷主题", ts=0)], now=0)
    s["frozen"]["style"] = True
    pi.prune_topics(s, now)
    assert "冷主题" in s["topics"]


# ---- 管理操作 ----

def test_manage_freeze_stops_updates(tmp_path):
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true}', encoding="utf-8")
    pi.record_events(path, [_ev("expand", ts=0)])
    pi.manage_implicit(path, "freeze", dim="style")
    import json
    f1 = json.loads(path.read_text(encoding="utf-8"))["implicit"]["style"]["f1"]
    pi.record_events(path, [_ev("expand", ts=1), _ev("expand", ts=2)])
    assert json.loads(path.read_text(encoding="utf-8"))["implicit"]["style"]["f1"] == f1
    pi.manage_implicit(path, "unfreeze", dim="style")
    pi.record_events(path, [_ev("expand", ts=3)])
    assert json.loads(path.read_text(encoding="utf-8"))["implicit"]["style"]["f1"] != f1


def test_manage_set_and_reset(tmp_path):
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true}', encoding="utf-8")
    pi.record_events(path, [_ev("quiz", "M", correct=True, ts=0)])
    pi.manage_implicit(path, "set", dim="mastery", key="M", value=0.9)
    import json
    assert json.loads(path.read_text(encoding="utf-8"))["implicit"]["topics"]["M"]["p"] == 0.9
    with pytest.raises(ValueError):
        pi.manage_implicit(path, "set", dim="mastery", key="M", value="abc")
    pi.manage_implicit(path, "reset")
    state = json.loads(path.read_text(encoding="utf-8"))["implicit"]
    assert state["topics"] == {} and state["seeded"] is True


# ---- 与显式画像的整合 ----

def test_profile_context_includes_implicit_section(tmp_path, monkeypatch):
    monkeypatch.setattr(profile, "PROFILES_DIR", tmp_path)
    device = "test_implicit_ctx"
    # 显式事实为空，纯靠隐式：3 个事件后【画像】段出现
    now = time.time()
    profile.record_implicit_event(device, [
        _ev("ask", "电磁感应", ts=now), _ev("ask", "电磁感应", ts=now + 1),
        _ev("quiz", "电磁感应", correct=True, ts=now + 2)])
    ctx = profile.profile_context(device)
    assert "【画像】" in ctx["text"]
    assert "电磁感应" in ctx["text"]
    # 空画像（无事件）不出段
    ctx2 = profile.profile_context("test_implicit_empty")
    assert "【画像】" not in ctx2["text"]


def test_normalize_profile_preserves_implicit_through_update(tmp_path, monkeypatch):
    monkeypatch.setattr(profile, "PROFILES_DIR", tmp_path)
    device = "test_implicit_keep"
    profile.record_implicit_event(device, [_ev("ask", "守恒律", ts=time.time())])
    profile.update_profile(device, {"explicit": {"stage": "高二"}})
    data = profile.get_profile(device)
    assert "守恒律" in data["implicit"]["topics"]
    assert data["explicit"]["stage"] == "高二"


def test_dashboard_view_shape(tmp_path, monkeypatch):
    monkeypatch.setattr(profile, "PROFILES_DIR", tmp_path)
    device = "test_implicit_dash"
    now = time.time()
    profile.record_implicit_event(device, [
        _ev("ask", "电磁感应", ts=now), _ev("quiz", "电磁感应", correct=True, ts=now + 1),
        _ev("socratic_answer", "电磁感应", correct=False, ts=now + 2)])
    view = profile.implicit_dashboard(device)
    assert view["enabled"] is True
    assert view["topics"][0]["topic"] == "电磁感应"
    assert 0.0 <= view["topics"][0]["p"] <= 1.0
    assert "f1" in view["style"] and 0 <= view["maturity"] <= 1


# ---- T176：账本 answer 条目补存 pHat/Δt ----

def test_answer_ledger_stores_phat_and_dt():
    state = _fresh()
    t0 = 1_700_000_000.0
    pi.apply_events(state, [_ev("quiz", "波动", correct=True, ts=t0)], t0)
    first = state["topics"]["波动"]["ledger"][-1]
    assert first["type"] == "answer"
    assert first["pHat"] == pytest.approx(0.2, abs=1e-3)  # 首条：不衰减先验
    assert "dt" not in first  # 首条作答间隔不可得
    # 第二条：pHat = 当时 p 衰减到当前；dt = 距上次作答的间隔
    p0, h0 = state["topics"]["波动"]["p"], state["topics"]["波动"]["h"]
    pi.apply_events(state, [_ev("quiz", "波动", correct=False, ts=t0 + 3600)], t0 + 3600)
    second = state["topics"]["波动"]["ledger"][-1]
    assert second["dt"] == pytest.approx(3600.0, abs=0.1)
    assert second["pHat"] == pytest.approx(round(p0 * pi.decay2(3600.0, h0), 3), abs=1e-3)
    assert second["x"] == 0 and second["p"] > 0  # 更新后 p 照旧存


def test_normalize_preserves_phat_dt():
    raw = {"topics": {"X": {"w": 1.0, "wAt": 1.0, "p": 0.6, "h": 5.0, "hAt": 2.0,
                            "ans": 1, "ok": 1,
                            "ledger": [{"type": "answer", "at": 2.0, "x": 1,
                                        "p": 0.6, "pHat": 0.35, "dt": 3600.0}]}}}
    kept = pi.normalize_implicit(raw)["topics"]["X"]["ledger"][0]
    assert kept["pHat"] == 0.35 and kept["dt"] == 3600.0  # 白名单不洗掉新字段


# ---- T177：评估留痕 JSONL（append-only，回填不写，reset 同删） ----

def test_record_events_appends_eval_trace(tmp_path):
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true, "facts": []}', encoding="utf-8")
    t0 = time.time()
    assert pi.record_events(path, [_ev("quiz", "波动", correct=True, ts=t0),
                                   _ev("ask", "波动", ts=t0 + 1)]) is True
    trace_file = pi.eval_trace_path(path)
    assert trace_file.name == "p.eval.jsonl" and trace_file.exists()
    lines = [ln for ln in trace_file.read_text(encoding="utf-8").splitlines() if ln]
    assert len(lines) == 1  # 只有答题事件入留痕，ask 不入
    rec = json.loads(lines[0])
    assert rec["topic"] == "波动" and rec["x"] == 1 and "pHat" in rec
    # 非答题事件：applied 为真也不追加新行
    assert pi.record_events(path, [_ev("ask", "波动", ts=t0 + 2)]) is True
    assert len(trace_file.read_text(encoding="utf-8").splitlines()) == 1


def test_record_events_disabled_writes_no_trace(tmp_path):
    path = tmp_path / "p.json"
    path.write_text('{"enabled": false}', encoding="utf-8")
    assert pi.record_events(path, [_ev("quiz", "波动", correct=True, ts=time.time())]) is False
    assert not pi.eval_trace_path(path).exists()


def test_ensure_seeded_backfill_writes_no_trace(tmp_path, monkeypatch):
    monkeypatch.setattr(pi, "kv_read", lambda key, default=None: {
        "q1": {"title": "牛顿第二定律", "history": [
            {"correct": True, "at": 1700000000000, "questionId": "q1"}]}})
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true}', encoding="utf-8")
    assert pi.ensure_seeded(path) is True
    assert not pi.eval_trace_path(path).exists()  # 回填的历史不是实时观测，不入留痕


def test_manage_reset_removes_eval_trace(tmp_path):
    path = tmp_path / "p.json"
    path.write_text('{"enabled": true, "facts": []}', encoding="utf-8")
    pi.record_events(path, [_ev("quiz", "波动", correct=True, ts=time.time())])
    assert pi.eval_trace_path(path).exists()
    pi.manage_implicit(path, "reset")
    assert not pi.eval_trace_path(path).exists()  # §7 可控：重置不留行为数据底


def test_eval_script_prefers_jsonl_exact(tmp_path):
    """评估脚本：有留痕的设备走 JSONL 精确口径，无留痕走账本反解兜底。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "review_profile_eval", os.path.join(ROOT, "scripts", "review_profile_eval.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # 设备 A：有 JSONL 留痕（精确 p̂）；设备 B：只有账本（反解兜底）
    (tmp_path / "dev_a.json").write_text('{"enabled": true, "implicit": {"events": 1}}',
                                         encoding="utf-8")
    (tmp_path / "dev_a.eval.jsonl").write_text(
        json.dumps({"type": "answer", "at": 100.0, "x": 1, "p": 0.9, "pHat": 0.5,
                    "dt": 3600.0, "topic": "波动"}, ensure_ascii=False) + "\n"
        + "{bad line\n", encoding="utf-8")
    (tmp_path / "dev_b.json").write_text(json.dumps({
        "enabled": True, "implicit": {"topics": {"光学": {
            "w": 1.0, "wAt": 50.0, "p": 0.9, "h": 5.0, "hAt": 100.0, "ans": 1, "ok": 1,
            "ledger": [{"type": "answer", "at": 100.0, "x": 1, "p": 0.9}]}}}},
        ensure_ascii=False), encoding="utf-8")
    profiles = mod.load_profiles(tmp_path)
    records, bad, n_trace = mod.reconstruct_answers(profiles, tmp_path)
    assert n_trace == 1
    a = [r for r in records if r["where"].startswith("dev_a")]
    assert len(a) == 1 and bad  # 坏行被剔除计数
    assert a[0]["p_hat"] == 0.5 and a[0]["has_gap"] and a[0]["gap"] == 3600.0  # 精确值不反解
    b = [r for r in records if r["where"].startswith("dev_b")]
    assert len(b) == 1 and b[0]["prior"] is not None and not b[0]["has_gap"]  # 反解兜底


# ---- 路由级回归（走 RouteTestBase 临时目录，不碰真实画像/知识库） ----

import unittest  # noqa: E402

from test_routes import RouteTestBase  # noqa: E402
import main as main_mod  # noqa: E402


class ImplicitProfileRoutesTest(RouteTestBase):
    """事件上报 / 隐式管理 / 仪表盘 / kv 测验差分四条路由的行为。"""

    def setUp(self):
        super().setUp()
        # profile_implicit 的 KNOWLEDGE_PATH 是 from-import 绑定，基线不补丁它——
        # 手动同步到临时目录，防回填读到真实知识库
        self._pi_orig_kb = pi.KNOWLEDGE_PATH
        pi.KNOWLEDGE_PATH = main_mod.KNOWLEDGE_PATH

    def tearDown(self):
        pi.KNOWLEDGE_PATH = self._pi_orig_kb
        super().tearDown()

    def test_event_endpoint_records_and_dashboard_exposes(self):
        r = self.client.post('/api/profile/event', json={
            'device_id': 'dev_impl_a',
            'events': [{'type': 'difficulty', 'topic': 'university'}]})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['ok'])
        view = self.client.get('/api/profile/dashboard',
                               params={'device_id': 'dev_impl_a'}).json()
        self.assertTrue(view['enabled'])
        self.assertGreaterEqual(view['events'], 1)

    def test_event_endpoint_validation(self):
        self.assertEqual(self.client.post(
            '/api/profile/event', json={'events': []}).status_code, 400)
        self.assertEqual(self.client.post(
            '/api/profile/event', json={'device_id': 'd', 'events': 'x'}).status_code, 400)

    def test_implicit_manage_freeze_roundtrip(self):
        r = self.client.post('/api/profile/implicit', json={
            'device_id': 'dev_impl_b', 'action': 'freeze', 'dim': 'style'})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.json()['frozen']['style'])
        r2 = self.client.post('/api/profile/implicit', json={
            'device_id': 'dev_impl_b', 'action': 'unfreeze', 'dim': 'style'})
        self.assertFalse(r2.json()['frozen']['style'])
        self.assertEqual(self.client.post('/api/profile/implicit', json={
            'device_id': 'dev_impl_b', 'action': 'freeze', 'dim': 'bogus'}).status_code, 400)

    def test_kv_quiz_write_diff_records_answer(self):
        stats = {'k1': {'title': '测试主题', 'correct': 1, 'wrong': 0,
                        'history': [{'correct': True, 'at': int(time.time() * 1000),
                                     'questionId': 'q1'}]}}
        self.client.post('/api/kv/phymathia_quiz_stats',
                         json={'value': stats, 'device_id': 'dev_impl_c'})
        view = self.client.get('/api/profile/dashboard',
                               params={'device_id': 'dev_impl_c'}).json()
        self.assertIn('测试主题', [t['topic'] for t in view['topics']])
