#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
截图 v2：针对 v1 反馈（太小/结构不合理/不清晰）
  - 元素贴合裁切：每个功能截其面板/卡片本体，自动补边到 1.6:1
  - 2 倍超采样：viewport 1152×720 @ dsf 2.0（原始 2304×1440），后期缩回 1600×1000 更锐
  - 05 复用已导出的 viz HTML 直开渲染，不再跑 AI
"""

import json
import os
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5055"
OUT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "html", "PhyMathia-参赛介绍", "images", "_staging"))
VIZ_DUMP = os.path.join(OUT, "_viz_dump.html")

VW, VH = 1152, 720

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


def log(m):
    print("[v2] %s" % m, flush=True)


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


def clip_16_10(page, selector=None, pad=0.045):
    """取元素矩形，补边并裁成 1.6:1，返回 playwright clip 或 None。"""
    r = page.evaluate(
        """(sel) => {
            const e = document.querySelector(sel);
            if (!e) return null;
            const b = e.getBoundingClientRect();
            if (b.width < 20 || b.height < 20) return null;
            return { x: b.left, y: b.top, w: b.width, h: b.height };
        }""",
        selector,
    )
    if not r:
        return None
    px, py = r["w"] * pad, r["h"] * pad
    x0, y0, w, h = r["x"] - px, r["y"] - py, r["w"] + 2 * px, r["h"] + 2 * py
    if w / h < 1.6:
        dw = 1.6 * h - w
        x0 -= dw / 2
        w += dw
    else:
        dh = w / 1.6 - h
        y0 -= dh / 2
        h += dh
    x0 = max(0, min(x0, VW - w))
    y0 = max(0, min(y0, VH - h))
    w = min(w, VW)
    h = min(h, VH)
    if w / h > 1.6:
        w = h * 1.6
    else:
        h = w / 1.6
    return {"x": round(x0, 1), "y": round(y0, 1), "width": round(w, 1), "height": round(h, 1)}


def shoot_clip(page, name, selector, pad=0.045):
    c = clip_16_10(page, selector, pad)
    if not c:
        log("%s 裁切失败（元素未找到）" % name)
        return False
    page.screenshot(path=os.path.join(OUT, name + ".png"), clip=c)
    log("已截图 %s  clip=%s" % (name, c))
    return True


def seed_knowledge(page, sid):
    now = int(time.time() * 1000)

    def it(i, title, cat, tags, summary, formulas):
        return {"id": "ki_shot%02d" % i, "title": title, "category": cat, "tags": tags,
                "summary": summary, "formulas": formulas, "source": "manual",
                "sessionId": sid, "createdAt": now + i}
    items = [
        it(1, "单摆的周期公式", "physics", ["物理"], "小角度下单摆周期只由摆长和重力加速度决定，与摆球质量和振幅无关。",
           ["T = 2\\pi\\sqrt{\\frac{L}{g}}"]),
        it(2, "小角度近似", "math", ["数学"], "当摆角很小时，sinθ ≈ θ（弧度制），非线性方程近似为简谐运动方程。",
           ["\\sin\\theta \\approx \\theta"]),
        it(3, "简谐运动方程", "physics", ["物理"], "小角度单摆的角位移满足简谐运动，回复力矩与角位移成正比且反向。",
           ["\\frac{d^2\\theta}{dt^2} + \\frac{g}{L}\\theta = 0"]),
        it(4, "单摆的角频率", "physics", ["物理"], "角频率由摆长与重力加速度决定，等效于摆长 L 的“弹簧”系统。",
           ["\\omega = \\sqrt{\\frac{g}{L}}"]),
        it(5, "阻尼振动", "physics", ["物理"], "存在空气阻力时振幅随时间指数衰减，系统做减幅振荡，周期近似不变。",
           ["A(t) = A_0 e^{-\\gamma t}"]),
        it(6, "受迫振动与共振", "physics", ["物理"], "周期性驱动力下系统稳态振幅在驱动频率接近固有频率时达到峰值，即共振。",
           ["\\omega_{drive} \\approx \\omega_0"]),
        it(7, "机械能守恒", "physics", ["物理"], "无阻尼单摆摆动中动能与重力势能相互转化，总机械能保持不变。",
           ["E = \\frac{1}{2}mv^2 + mgh"]),
        it(8, "微分方程的解", "math", ["数学"], "二阶常系数线性微分方程的通解为余弦形式，由初始条件确定振幅与相位。",
           ["\\theta(t) = \\theta_0\\cos(\\omega t + \\varphi)"]),
    ]
    page.evaluate(
        """async (items) => {
            const payload = {};
            items.forEach(it => payload[it.id] = it);
            await fetch('/api/knowledge', { method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload) });
        }""",
        items,
    )
    return items


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--force-color-profile=srgb"])
        ctx = browser.new_context(viewport={"width": VW, "height": VH},
                                  device_scale_factor=2.0, locale="zh-CN")
        ctx.add_init_script(SEED)
        page = ctx.new_page()
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)
        page.evaluate("createNewSession()")
        page.wait_for_timeout(1000)
        session_key = page.evaluate("getCurrentSessionId()")
        sid = page.evaluate("SESSION_ID")
        log("画布 %s" % session_key)

        # ---- Q1 ----
        page.evaluate("sendQuick('讲解单摆运动，并生成一个可调摆长和重力加速度的交互可视化演示')")
        wait_stream(page)
        log("Q1 完成")
        page.wait_for_timeout(1500)

        # ---- 03：第一个回答簇（模块气泡本体）----
        ok = page.evaluate(
            """() => {
                const h = getChatHistory();
                const asst = h.find(m => m.role === 'assistant');
                if (!asst) return null;
                const T = asst.timestamp;
                const mods = ['physics', 'math', 'graph', 'viz', 'extend'];
                const els = mods.map(m => document.querySelector('[data-node-id="m-' + T + '-' + m + '"]'))
                                 .filter(Boolean);
                if (!els.length) return null;
                let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
                for (const e of els) {
                    const b = e.getBoundingClientRect();
                    x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top);
                    x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
                }
                // 放大到约占视口宽 66%
                const uw = x1 - x0, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
                const f = Math.min(1.9, Math.max(0.35, (innerWidth * 0.66) / uw));
                zoomGraph(f, cx, cy);
                return true;
            }"""
        )
        page.wait_for_timeout(900)
        if ok:
            # 用 physics 节点作锚重新取整簇矩形
            c = page.evaluate(
                """() => {
                    const h = getChatHistory();
                    const T = h.find(m => m.role === 'assistant').timestamp;
                    const els = ['physics','math','graph','viz','extend']
                        .map(m => document.querySelector('[data-node-id="m-' + T + '-' + m + '"]'))
                        .filter(Boolean);
                    if (!els.length) return null;
                    let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;
                    for (const e of els) {
                        const b = e.getBoundingClientRect();
                        x0=Math.min(x0,b.left); y0=Math.min(y0,b.top);
                        x1=Math.max(x1,b.right); y1=Math.max(y1,b.bottom);
                    }
                    return {x:x0,y:y0,w:x1-x0,h:y1-y0};
                }"""
            )
            if c:
                px, py = c["w"] * 0.05, c["h"] * 0.05
                x0, y0, w, h = c["x"] - px, c["y"] - py, c["w"] + 2 * px, c["h"] + 2 * py
                if w / h < 1.6:
                    dw = 1.6 * h - w
                    x0 -= dw / 2
                    w += dw
                else:
                    dh = w / 1.6 - h
                    y0 -= dh / 2
                    h += dh
                x0 = max(0, min(x0, VW - w))
                y0 = max(0, min(y0, VH - h))
                w = min(w, VW)
                h = min(h, VH)
                if w / h > 1.6:
                    w = h * 1.6
                else:
                    h = w / 1.6
                page.screenshot(path=os.path.join(OUT, "03-dual-domain.png"),
                                clip={"x": round(x0,1), "y": round(y0,1),
                                      "width": round(w,1), "height": round(h,1)})
                log("已截图 03-dual-domain")
        else:
            log("03 簇定位失败")

        # ---- Q2 ----
        page.evaluate("sendQuick('阻尼振动和受迫振动有什么区别？共振发生的条件是什么？')")
        wait_stream(page)
        log("Q2 完成")

        # ---- 04：全景（fitGraph 后取画布工作区）----
        page.evaluate("typeof fitGraph === 'function' && fitGraph()")
        page.wait_for_timeout(1000)
        if not shoot_clip(page, "04-graph-net", "#graphWorkspace", pad=0.01):
            page.screenshot(path=os.path.join(OUT, "04-graph-net.png"))

        # ---- 05：直开 viz HTML（复用 dump，无需 AI）----
        if os.path.exists(VIZ_DUMP):
            html = open(VIZ_DUMP, encoding="utf-8").read()
            html = html.replace("</style>", """
  html, body { background: #f7f9fc; }
  body { zoom: 1.7; padding-top: 40px !important; }
  h2 { text-align: center; }
</style>""")
            p2 = ctx.new_page()
            p2.set_viewport_size({"width": VW, "height": VH})
            p2.set_content(html, wait_until="load")
            p2.wait_for_timeout(1200)
            p2.evaluate("""() => {
                const L = document.getElementById('L');
                if (L) { L.value = 1.75; L.dispatchEvent(new Event('input')); }
            }""")
            p2.wait_for_timeout(2300)
            p2.screenshot(path=os.path.join(OUT, "05-viz-iframe.png"))
            log("已截图 05-viz-iframe")
            p2.close()
        else:
            log("05 跳过：无 dump")

        # ---- 06/07：知识面板 ----
        page.evaluate("toggleKnowledgePanel()")
        page.wait_for_timeout(2500)
        shoot_clip(page, "06-knowledge", "#knowledgePanel", pad=0.02)
        page.evaluate("switchKpTab('formulas')")
        page.wait_for_timeout(1500)
        shoot_clip(page, "07-formulas", "#knowledgePanel", pad=0.02)
        page.evaluate("typeof closeKnowledgePanel === 'function' && closeKnowledgePanel()")
        page.wait_for_timeout(500)

        # ---- 08：检测题（种子知识 → 本地题）----
        try:
            seed_knowledge(page, sid)
            log("已注入种子知识点")
            page.evaluate("openQuiz()")
            deadline = time.time() + 90
            while time.time() < deadline:
                ph = page.evaluate("quizState ? quizState.phase : ''")
                if ph in ("intro", "question"):
                    break
                time.sleep(2)
            deadline = time.time() + 200
            while time.time() < deadline:
                st = page.evaluate("""() => ({
                    pending: !!(quizState && quizState.aiPending),
                    n: quizState && quizState.questions ? quizState.questions.length : 0 })""")
                if not st["pending"]:
                    break
                time.sleep(6)
            have_q = page.evaluate("quizState && quizState.questions ? quizState.questions.length : 0")
            if not have_q:
                page.evaluate("""() => {
                    const b = [...document.querySelectorAll('#quizBody button')]
                        .find(x => /本地题/.test(x.innerText));
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
                     and "构思" not in info["text"])
            log("quiz phase=%s 干净=%s" % (info["phase"], clean))
            if clean:
                shoot_clip(page, "08-quiz", ".quiz-modal", pad=0.015)
            page.evaluate("typeof closeQuiz === 'function' && closeQuiz()")
        except Exception as e:
            log("08 失败：%s" % e)

        # ---- 09：Φ 助手窗口 ----
        try:
            page.evaluate("window.toggleGraphPet && window.toggleGraphPet()")
            page.wait_for_timeout(2200)
            if not shoot_clip(page, "09-phi-harness", ".graph-harness-window", pad=0.03):
                page.screenshot(path=os.path.join(OUT, "09-phi-harness.png"))
        except Exception as e:
            log("09 失败：%s" % e)

        # ---- 10：模型配置面板（四槽位）----
        try:
            page.evaluate("window.toggleGraphPet && window.toggleGraphPet()")
            page.wait_for_timeout(400)
            page.evaluate("toggleModelPanel({ stopPropagation(){} })")
            page.wait_for_timeout(1500)
            if not shoot_clip(page, "10-sessions", "#modelPanel", pad=0.03):
                log("10 modelPanel 未找到，回退侧栏")
                page.evaluate("toggleSidebar()")
                page.wait_for_timeout(1000)
                page.screenshot(path=os.path.join(OUT, "10-sessions.png"))
        except Exception as e:
            log("10 失败：%s" % e)

        # ---- 清理 ----
        try:
            page.evaluate("async (k) => { await fetch('/api/sessions/' + k, { method: 'DELETE' }); }", session_key)
            page.evaluate("""async () => {
                for (let i = 1; i <= 8; i++)
                    await fetch('/api/knowledge/ki_shot0' + i, { method: 'DELETE' });
            }""")
            log("已清理")
        except Exception as e:
            log("清理失败：%s" % e)
        browser.close()
    log("v2 完成")


if __name__ == "__main__":
    main()
