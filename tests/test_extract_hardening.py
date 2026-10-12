"""2026-10-12 提取链加固回归：标记优先＋回退扫描安全化＋前后端闸门对齐。

背景（复现脚本坐实的六个洞，修复过程见 docs/日志/2026-10-12.md）：
- 前端 _looksLikeFormula 缺后端独有的两条中文闸门 → $能量守恒$ 概念名进本地公式
  缓存，POST /api/formulas 按后端闸门拒收 → 永远同步不上的僵尸条目；
- 回退 $..$ 扫描直接跑全文 → viz HTML 的 JS 模板串 $${x}、shell $HOME、美元散文
  「$5 一个，支架 $」被当公式提走（中文＋数字那条后端也放行——\d 曾算「结构」）；
- $$..$$ / \\[..\\] 回退正则不跨行 → 多行块公式整块漏提；
- 未闭合 <formula>（流式截断）公式整条丢失——渲染层已有截断防御，提取层没有。

本文件钉死后端口径（前端同口径逻辑由 scripts/frontend_smoke/knowledge-summary.mjs
的沙箱用例钉）：
- _looks_like_formula：纯中文/中文无 LaTeX 结构（数字不算结构）拒收；
- _local_extract_knowledge：viz/代码围栏不参与回退扫描、多行块公式可提、
  未闭合 <formula> 按行补捞且残缺 LaTeX（花括号不配平/悬空命令尾）不捞；
- _dedupe_formula_map / _dedupe_knowledge：存量闸门失败「公式」在写入口径化清除。
"""

import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
for p in (ROOT, SRC):
    if p not in sys.path:
        sys.path.insert(0, p)

os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
os.environ.setdefault("PHYMATHIA_EMBEDDING", "0")

from server import knowledge  # noqa: E402


def _extract_formulas(content: str) -> list:
    """跑完整本地提取（含标题闸门），返回公式列表；整轮被标题闸门拒收时
    公式同样干净，视作空列表——安全类断言只关心「没有垃圾公式」。"""
    items = knowledge._local_extract_knowledge([
        {"role": "user", "content": "问题"},
        {"role": "assistant", "content": content},
    ])
    return items[0]["formulas"] if items else []


class TestLooksLikeFormulaChineseGate:
    def test_pure_chinese_concept_rejected(self):
        assert not knowledge._looks_like_formula("能量守恒")
        assert not knowledge._looks_like_formula("$动量定理$")

    def test_chinese_with_digit_prose_rejected(self):
        # 数字不再算「结构」：美元金额/编号混进正文的前后端一致拒收
        assert not knowledge._looks_like_formula("5 一个，支架 ")
        assert not knowledge._looks_like_formula("$5 一个，支架 $")

    def test_chinese_with_real_latex_structure_passes(self):
        # 真带中文的公式总有 \ ^ _ { } = 等结构
        assert knowledge._looks_like_formula("力 F=ma")
        assert knowledge._looks_like_formula("v_{初}")

    def test_plain_formulas_still_pass(self):
        for s in ("F=-kx", "E=\\frac{1}{2}mv^2", "\\omega=2\\pi f", "9.8"):
            assert knowledge._looks_like_formula(s), s


class TestFallbackScanSafety:
    def test_viz_html_js_template_not_captured(self):
        content = (
            "先看正文说明。\n\n```html\n<script>\n"
            "rows.forEach(r => el.innerHTML += `<b>$${r.p}</b> 和 $${r.n} 项`);\n"
            "</script>\n```\n\n正文没有公式标签。"
        )
        assert _extract_formulas(content) == []

    def test_shell_code_fence_not_captured(self):
        content = "安装步骤：\n\n```bash\necho $HOME 和 $PATH 要先设置\n```\n\n完成。"
        assert _extract_formulas(content) == []

    def test_dollar_prose_not_captured(self):
        content = "实验器材预算：传感器 $5 一个，支架 $10 一套，超预算了。"
        assert _extract_formulas(content) == []

    def test_unclosed_fence_tail_not_scanned(self):
        content = '说明如下：\n\n```\nconst a = "$x$"; const b = "$y$";\n'
        assert _extract_formulas(content) == []

    def test_multiline_block_formulas_now_captured(self):
        content = (
            "## 牛顿第二定律\n由牛顿第二定律：\n$$\nF = ma\n$$\n同时能量：\n"
            "\\[\nE = \\frac{1}{2}mv^2\n\\]\n完毕。"
        )
        formulas = _extract_formulas(content)
        assert formulas == ["$F = ma$", "$E = \\frac{1}{2}mv^2$"]


class TestUnclosedFormulaSalvage:
    def test_unclosed_tag_salvaged_to_end_of_line(self):
        content = "## 胡克定律\n恢复力与位移成正比：\n<formula>F=-kx\n\n后续内容被截断。"
        assert _extract_formulas(content) == ["$F=-kx$"]

    def test_unclosed_complete_formula_without_newline_salvaged(self):
        content = "## 能量\n弹性势能 <formula>E=\\frac{1}{2}kx^2\n后面还有正文"
        assert _extract_formulas(content) == ["$E=\\frac{1}{2}kx^2$"]

    def test_truncated_mid_formula_not_salvaged(self):
        # 截断发生在公式中间：悬空 ^ / 花括号不配平的残缺 LaTeX 宁可不收
        assert knowledge._salvage_unclosed_formula("## 能量\n<formula>E=\\frac{1}{2}mv^") == ""
        assert knowledge._salvage_unclosed_formula("## 能量\n<formula>E=\\frac{1}{2") == ""
        assert knowledge._salvage_unclosed_formula("## 能量\n<formula>E=\\frac") == ""

    def test_unclosed_tag_inside_code_fence_is_literal_text(self):
        # 与渲染层同款围栏保护：围栏内的 <formula> 是字面文本
        assert knowledge._salvage_unclosed_formula("```\n<formula>F=-kx\n```") == ""

    def test_closed_tags_still_win_over_salvage(self):
        content = "## 胡克定律\n<formula>F=-kx</formula> 还有 <formula>E=kx^2/2"
        assert _extract_formulas(content) == ["$F=-kx$"]


class TestTaggedPathRegression:
    def test_normal_tagged_extraction(self):
        content = (
            "## 胡克定律\n恢复力 <formula>F=-kx</formula>，"
            "能量 <formula>E=\\frac{1}{2}kx^2</formula>。\n"
            "<summary>胡克定律恢复力与位移成正比</summary>"
        )
        assert _extract_formulas(content) == ["$F=-kx$", "$E=\\frac{1}{2}kx^2$"]

    def test_tagged_inside_dollar_wrapper(self):
        # 渲染层兼容 <formula> 被 $$..$$ 包裹的输出，提取层同口径
        content = "## 弹性势能\n$$<formula>E=\\frac{1}{2}kx^2</formula>$$ 是标量。"
        assert _extract_formulas(content) == ["$E=\\frac{1}{2}kx^2$"]


class TestStockZombieSweep:
    def test_dedupe_formula_map_drops_gate_failures(self):
        data = {
            "f1": {"id": "f1", "latex": "$能量守恒$", "sessionId": "s1"},
            "f2": {"id": "f2", "latex": "$F=-kx$", "sessionId": "s1"},
            "f3": {"id": "f3", "latex": "$5 一个，支架 $", "sessionId": "s1"},
        }
        result = knowledge._dedupe_formula_map(data)
        assert set(result.keys()) == {"f2"}

    def test_dedupe_knowledge_filters_item_formulas(self):
        data = {
            "k1": {"id": "k1", "title": "胡克定律", "sessionId": "s1", "summarySource": "local",
                   "summary": "s", "formulas": ["$F=-kx$", "$能量守恒$", "$5 一个，支架 $"]},
        }
        result = knowledge._dedupe_knowledge(data)
        assert result["k1"]["formulas"] == ["$F=-kx$"]
