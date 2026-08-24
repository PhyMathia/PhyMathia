#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
截图 v3（终版）：
  - AI 回答自动清洗（剥离 hy3 推理前导）+ 失败自动重试（500/错误页）
  - 03 回答簇放大贴合；04 节点并集贴合；06/07 知识面板加宽后全幅；
    08 检测弹窗贴合；09 Φ 桌宠点击开窗贴合；10 浅色主题+侧栏全幅
  - dsf 2.0 超采样，输出 2304×1440，后期缩回 1600×1000
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

SANITIZE = """() => {
  const h = getChatHistory();
  const a = [...h].reverse().find(m => m.role === 'assistant');
  if (!a) return { ok: false, reason: 'no-assistant' };
  const c = String(a.content || '');
  if (c.includes('⚠') || c.length < 400) return { ok: false, reason: 'bad:' + c.slice(0, 40) };
  const m = c.search(/<physics>|<math>/i);
  let out = c;
  if (m > 0 && /<summary>|<\\/extend>/i.test(c)) out = c.slice(m);
  else if (m === -1 && !/<summary>/i.test(c)) return { ok: false, reason: 'no-sections' };
  if (out !== c) {
    window.updateChatHistoryMessage(a.timestamp, mm => ({ ...mm, content: out }));
    if (typeof saveCurrentSession === 'function') saveCurrentSession();
    if (window.renderGraphCanvas) window.renderGraphCanvas(true);
    return { ok: true, stripped: true };
  }
  return { ok: true, stripped: false };
}"""


def log(m):
    print("[v3] %s" % m, flush=True)


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


def ask(page, text, retries=2):
    for attempt in range(retries + 1):
        page.evaluate("sendQuick(%s)" % json.dumps(text))
        wait_stream(page)
        st = page.evaluate(SANITIZE)
        log("回答检查：%s" % st)
        if st.get("ok"):
            page.wait_for_timeout(1200)
            return True
        ts = page.evaluate(
            "() => { const u = getChatHistory().filter(m => m.role === 'user').pop(); return u ? u.timestamp : null; }")
        if ts:
            page.evaluate("window.deleteGraphMessageByTimestamp(%d)" % ts)
        page.wait_for_timeout(5000)
        log("第 %d 次失败，重试…" % (attempt + 1))
    return False


def rect_to_clip(r, pad=0.045):
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


def shoot(page, name, clip=None):
    kw = {"clip": clip} if clip else {}
    page.screenshot(path=os.path.join(OUT, name + ".png"), **kw)
    log("已截图 %s %s" % (name, clip or "(全幅)"))


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
        }""", items)
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

        # ---- Q1 + Q2（带清洗重试）----
        if not ask(page, "讲解单摆运动，并生成一个可调摆长和重力加速度的交互可视化演示"):
            log("Q1 最终失败")
        if not ask(page, "阻尼振动和受迫振动有什么区别？共振发生的条件是什么？"):
            log("Q2 最终失败")

        # ---- 03：第一答簇（模块气泡）----
        r = page.evaluate(
            """() => {
                const h = getChatHistory();
                const a = h.find(m => m.role === 'assistant');
                if (!a) return null;
                const T = a.timestamp;
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
                return {x:x0,y:y0,w:x1-x0,h:y1-y0,T:T};
            }"""
        )
        if r:
            f = max(0.35, min(1.9, (VW * 0.66) / max(r["w"], 1)))
            page.evaluate("zoomGraph(%f, %f, %f)" % (f, r["x"] + r["w"] / 2, r["y"] + r["h"] / 2))
            page.wait_for_timeout(800)
            r2 = page.evaluate(
                """(T) => {
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
                }""", r["T"])
            if r2:
                shoot(page, "03-dual-domain", rect_to_clip(r2, 0.05))
        else:
            log("03 失败：无簇")

        # ---- 04：全部节点并集 ----
        page.evaluate("typeof fitGraph === 'function' && fitGraph()")
        page.wait_for_timeout(900)
        r = page.evaluate(
            """() => {
                const els = [...document.querySelectorAll('#graphCanvas .graph-node')];
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
        shoot(page, "04-graph-net", rect_to_clip(r, 0.04) if r else None)

        # ---- 05：直开 viz HTML ----
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

        # ---- 06/07：知识面板（加宽到 78%）----
        page.evaluate("""() => {
            const st = document.createElement('style');
            st.id = '_shotWiden';
            st.textContent = '.knowledge-panel{width:78vw !important;}';
            document.head.appendChild(st);
        }""")
        page.evaluate("toggleKnowledgePanel()")
        page.wait_for_timeout(2600)
        shoot(page, "06-knowledge")
        page.evaluate("switchKpTab('formulas')")
        page.wait_for_timeout(1600)
        shoot(page, "07-formulas")
        page.evaluate("typeof closeKnowledgePanel === 'function' && closeKnowledgePanel()")
        page.evaluate("document.getElementById('_shotWiden')?.remove()")
        page.wait_for_timeout(400)

        # ---- 08：检测题 ----
        try:
            seed_knowledge(page, sid)
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
            clean = ("A" in info["text"] and "B" in info["text"] and "构思" not in info["text"])
            log("quiz phase=%s 干净=%s" % (info["phase"], clean))
            if clean:
                c = rect_to_clip(page.evaluate(
                    """() => {
                        const e = document.querySelector('.quiz-modal');
                        if (!e) return null;
                        const b = e.getBoundingClientRect();
                        return {x:b.left,y:b.top,w:b.width,h:b.height};
                    }"""), 0.012)
                shoot(page, "08-quiz", c)
            page.evaluate("typeof closeQuiz === 'function' && closeQuiz()")
        except Exception as e:
            log("08 失败：%s" % e)

        # ---- 09：Φ 桌宠点击开窗 ----
        try:
            clicked = page.evaluate(
                """() => {
                    const pet = document.querySelector('.phi-pet, .graph-pet, [id*="graphPet"], [class*="pet"]');
                    if (!pet) return null;
                    pet.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return pet.className || pet.id;
                }"""
            )
            log("点击桌宠：%s" % clicked)
            page.wait_for_timeout(2200)
            win = page.evaluate(
                """() => {
                    const w = [...document.querySelectorAll('.graph-harness-window')]
                        .find(e => !e.hidden && e.offsetParent !== null);
                    if (!w) return null;
                    const b = w.getBoundingClientRect();
                    return {x:b.left,y:b.top,w:b.width,h:b.height};
                }"""
            )
            if win:
                shoot(page, "09-phi-harness", rect_to_clip(win, 0.03))
            else:
                log("09 窗口未现，退全幅")
                shoot(page, "09-phi-harness")
        except Exception as e:
            log("09 失败：%s" % e)

        # ---- 10：浅色主题 + 侧栏 ----
        try:
            page.evaluate("""() => {
                const w = document.querySelector('.graph-harness-window');
                if (w) w.hidden = true;
                if (typeof applyTheme === 'function') applyTheme('light');
                else localStorage.setItem('phymathia_theme', 'light');
            }""")
            page.wait_for_timeout(1200)
            page.evaluate("toggleSidebar()")
            page.wait_for_timeout(1300)
            shoot(page, "10-sessions")
            page.evaluate("closeSidebar()")
            page.evaluate("typeof applyTheme === 'function' && applyTheme('dark')")
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
    log("v3 完成")


if __name__ == "__main__":
    main()
