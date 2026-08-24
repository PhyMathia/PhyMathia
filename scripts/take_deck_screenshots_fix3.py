#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补拍第三轮：05（generateVizNode 正规生成流程）+ 08（种子知识点 → 本地出题）。"""

import json
import os
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5055"
OUT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "html", "PhyMathia-参赛介绍", "images", "_staging"))

SEED = """
(() => {
  localStorage.setItem('phymathia_theme', 'dark');
  localStorage.setItem('phymathia_level', 'university');
  localStorage.setItem('phymathia_onboarding_done', '1');
  const uid = 'model_autoshot01';
  localStorage.setItem('phymathia_user_models', JSON.stringify([{
    id: uid, provider: 'opencode-go', apiKey: '', model: 'hy3',
    label: 'OpenCode Go · hy3', baseUrl: 'https://opencode.ai/zen/go/v1', createdAt: Date.now()
  }]));
  localStorage.setItem('phymathia_active_models', JSON.stringify({
    agent_model: uid, html_model: uid, descriptor_model: uid,
    quiz_model: uid, graph_model: uid, branch_model: uid
  }));
})();
"""

# 种子知识点（结构化、题面干净，本地出题直接可用）
def seed_items(sid):
    now = int(time.time() * 1000)
    def it(i, title, cat, tags, summary, formulas):
        return {"id": "ki_shot%02d" % i, "title": title, "category": cat, "tags": tags,
                "summary": summary, "formulas": formulas, "source": "manual",
                "sessionId": sid, "createdAt": now + i}
    out = []
    out.append(it(1, "单摆的周期公式", "physics", ["物理"], "小角度下单摆周期只由摆长和重力加速度决定，与摆球质量和振幅无关。",
                  ["T = 2\\pi\\sqrt{\\frac{L}{g}}"]))
    out.append(it(2, "小角度近似", "math", ["数学"], "当摆角很小时，sinθ ≈ θ（弧度制），非线性方程近似为简谐运动方程。",
                  ["\\sin\\theta \\approx \\theta"]))
    out.append(it(3, "简谐运动方程", "physics", ["物理"], "小角度单摆的角位移满足简谐运动，回复力矩与角位移成正比且反向。",
                  ["\\frac{d^2\\theta}{dt^2} + \\frac{g}{L}\\theta = 0"]))
    out.append(it(4, "单摆的角频率", "physics", ["物理"], "角频率由摆长与重力加速度决定，等效于摆长 L 的“弹簧”系统。",
                  ["\\omega = \\sqrt{\\frac{g}{L}}"]))
    out.append(it(5, "阻尼振动", "physics", ["物理"], "存在空气阻力时振幅随时间指数衰减，系统做减幅振荡，周期近似不变。",
                  ["A(t) = A_0 e^{-\\gamma t}"]))
    out.append(it(6, "受迫振动与共振", "physics", ["物理"], "周期性驱动力下系统稳态振幅在驱动频率接近固有频率时达到峰值，即共振。",
                  ["\\omega_{drive} \\approx \\omega_0"]))
    out.append(it(7, "机械能守恒", "physics", ["物理"], "无阻尼单摆摆动中动能与重力势能相互转化，总机械能保持不变。",
                  ["E = \\frac{1}{2}mv^2 + mgh"]))
    out.append(it(8, "微分方程的解", "math", ["数学"], "二阶常系数线性微分方程的通解为余弦形式，由初始条件确定振幅与相位。",
                  ["\\theta(t) = \\theta_0\\cos(\\omega t + \\varphi)"]))
    return out


def log(m):
    print("[fix3] %s" % m, flush=True)


def wait_stream(page, timeout_s=420):
    deadline = time.time() + timeout_s
    stable, prev = 0, -1
    while time.time() < deadline:
        st = page.evaluate("""() => ({
            progress: !!document.querySelector('#progressBar.active, #progressStatus.active'),
            n: (typeof getChatHistory==='function') ? getChatHistory().filter(m=>m.role==='assistant').length : 0
        })""")
        if not st["progress"] and st["n"] > 0 and st["n"] == prev:
            stable += 1
            if stable >= 4:
                return
        else:
            stable = 0
        prev = st["n"]
        time.sleep(1.5)
    raise TimeoutError("流式超时")


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--force-color-profile=srgb"])
        ctx = browser.new_context(viewport={"width": 1280, "height": 800},
                                  device_scale_factor=1.25, locale="zh-CN")
        ctx.add_init_script(SEED)
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.evaluate("createNewSession()")
        page.wait_for_timeout(1000)
        session_key = page.evaluate("getCurrentSessionId()")
        sid = page.evaluate("SESSION_ID")
        log("画布 %s / %s" % (session_key, sid))

        # ---- Q1 ----
        page.evaluate("sendQuick('讲解单摆运动，并生成一个可调摆长和重力加速度的交互可视化演示')")
        wait_stream(page)
        log("Q1 完成")

        # ---- 05：viz 节点正规生成（已有成品则跳过）----
        if os.path.exists(os.path.join(OUT, "05-viz-iframe.png")):
            log("05 已存在，跳过 viz 生成")
        else:
            node_id = page.evaluate(
                """() => {
                    const n = (typeof graphView !== 'undefined' && graphView.nodes || [])
                        .find(n => n.kind === 'module' && n.moduleKey === 'viz');
                    return n ? n.id : null;
                }"""
            )
            log("viz 节点：%s" % node_id)
            if node_id:
                try:
                    page.evaluate("generateVizNode(%s)" % json.dumps(node_id))
                except Exception as e:
                    log("generateVizNode 返回（可能异步继续）：%s" % e)
                # 等画布出现 viz 卡片/iframe
                deadline = time.time() + 300
                card_id = None
                while time.time() < deadline and not card_id:
                    card_id = page.evaluate(
                        """() => {
                            const card = document.querySelector('#graphCanvas .viz-card[id]');
                            if (card) return card.id;
                            const f = document.querySelector('#graphCanvas iframe[data-viz-id]');
                            return f ? f.getAttribute('data-viz-id') : null;
                        }"""
                    )
                    if not card_id:
                        time.sleep(5)
                log("viz 卡片 id：%s" % card_id)
                if card_id:
                    page.evaluate("toggleVizFullscreen(%s)" % json.dumps(card_id))
                    page.wait_for_timeout(4000)  # 等 iframe 动画渲染
                    page.screenshot(path=os.path.join(OUT, "05-viz-iframe.png"))
                    log("已截图 05-viz-iframe")
                    page.evaluate("closeVizFullscreen()")
                    page.wait_for_timeout(500)
                else:
                    log("05 失败：生成后仍未出现 viz 卡片")

        # ---- 种知识 ----
        items = seed_items(sid)
        page.evaluate(
            """async (items) => {
                const payload = {};
                items.forEach(it => payload[it.id] = it);
                const r = await fetch('/api/knowledge', { method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload) });
                return r.status;
            }""",
            items,
        )
        log("已注入 %d 条种子知识点" % len(items))
        if isinstance(page.evaluate("typeof invalidateKnowledgeCache === 'function'"), bool):
            page.evaluate("typeof invalidateKnowledgeCache === 'function' && invalidateKnowledgeCache()")

        # ---- 08：本地题 ----
        page.evaluate("openQuiz()")
        deadline = time.time() + 90
        while time.time() < deadline:
            ph = page.evaluate("quizState ? quizState.phase : ''")
            if ph in ("intro", "question"):
                break
            time.sleep(2)
        # 等 AI 出题尝试结束
        deadline = time.time() + 200
        while time.time() < deadline:
            st = page.evaluate("""() => ({
                pending: !!(quizState && quizState.aiPending),
                n: quizState && quizState.questions ? quizState.questions.length : 0
            })""")
            if not st["pending"]:
                break
            time.sleep(6)
        have_q = page.evaluate("quizState && quizState.questions ? quizState.questions.length : 0")
        if not have_q:
            log("AI 无题 → 切本地题")
            page.evaluate("""() => {
                const btns = [...document.querySelectorAll('#quizBody button')];
                const b = btns.find(x => /本地题/.test(x.innerText));
                if (b) b.click();
            }""")
            page.wait_for_timeout(2500)
        page.evaluate("typeof startQuiz === 'function' && startQuiz()")
        page.wait_for_timeout(1800)
        info = page.evaluate("""() => {
            const b = document.getElementById('quizBody');
            return { phase: quizState && quizState.phase, text: b ? b.innerText : '' };
        }""")
        clean = ("A" in info["text"] and "B" in info["text"]
                 and "构思" not in info["text"] and "摘要" not in info["text"])
        log("quiz phase=%s 干净=%s | %s" % (info["phase"], clean, info["text"][:90].replace(chr(10), ' / ')))
        if clean:
            page.wait_for_timeout(500)
            page.screenshot(path=os.path.join(OUT, "08-quiz.png"))
            log("已截图 08-quiz")
        else:
            log("08 题面仍不干净，不覆盖")

        # ---- 清理 ----
        try:
            page.evaluate("async (k) => { await fetch('/api/sessions/' + k, { method: 'DELETE' }); }", session_key)
            for it in items:
                page.evaluate(
                    "async (i) => { await fetch('/api/knowledge/' + i, { method: 'DELETE' }); }", it["id"])
            log("已清理画布与种子知识")
        except Exception as e:
            log("清理失败：%s" % e)
        browser.close()
    log("第三轮完成")


if __name__ == "__main__":
    main()
