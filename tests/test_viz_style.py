"""viz_style 三维触发词（backlog 489/490，2026-11-19）。

489：THREE_HINTS 弱词（立体/换个角度/换个视角）在比喻句与立体几何里子串误触，
抢等距题白付 3D 载荷——弱词必须与交互/可视化共现词同句才算；强词（三维/3d/
转起来 等）单独命中不变。
490：THREE_PAYLOAD 与 src/skills/three-3d.md 两处同源（viz-three.md 明令同步），
「不合格的样子」清单此前漂移一条。
Run: python3 -m pytest tests/test_viz_style.py -q
"""

from pathlib import Path

from src.server import viz_style

ROOT = Path(__file__).resolve().parent.parent


def _hint(q):
    return viz_style._three_hint(q)


# ── 强词：单独命中，行为不变 ──

def test_strong_words_hit_alone():
    for q in ("把发动机做成3d模型", "这个装置能转起来给我看吗",
              "三维展示齿轮啮合", "从背面看这台泵的结构"):
        assert _hint(q), q


# ── 弱词：无共现不再误触（489 的实锤句式）──

def test_weak_words_alone_no_longer_hit():
    for q in ("立体几何里怎么求二面角",
              "换个角度看这道题的解法",
              "换个视角重新分析这句话的语法结构",
              "请换个角度阐述这个观点",
              "立体主义绘画的特点是什么"):
        assert not _hint(q), q


def test_weak_words_with_partner_hit():
    for q in ("这个机构能不能立体旋转演示",
              "把凸轮换个角度展示给我看",
              "立体呈现发动机内部的运转动画",
              "换个视角可视化这个联轴器的结构"):
        assert _hint(q), q


# ── 490：载荷与同源 skill 的「不合格清单」一致 ──

def test_three_payload_mentions_function_surface():
    assert "把函数图像做成 3D 曲面" in viz_style.THREE_PAYLOAD


def test_payload_and_skill_doc_stay_in_sync():
    """viz-three.md 明令：改 THREE_PAYLOAD 要同步 src/skills/three-3d.md。
    两处「不合格的样子」逐条一致（顿号分隔清单）。"""
    skill = (ROOT / "src" / "skills" / "three-3d.md").read_text(encoding="utf-8")
    for text, name in ((viz_style.THREE_PAYLOAD, "THREE_PAYLOAD"), (skill, "three-3d.md")):
        idx = text.rindex("不合格的样子")
        assert "把函数图像做成 3D 曲面" in text[idx:], name
    # 契约条目数一致（除编号列表外两处同源段落的结构对齐）
    import re
    payload_items = len(re.findall(r"^\d+\. ", viz_style.THREE_PAYLOAD, re.M))
    skill_items = len(re.findall(r"^\d+\. ", skill, re.M))
    assert payload_items == skill_items == 10
