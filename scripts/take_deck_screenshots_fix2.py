#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补拍第二轮：05（取画布节点里真实的 viz）+ 08（等知识提取充分，本地题兜底）。"""

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


def log(m):
    print("[fix2] %s" % m, flush=True)


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
        log("画布 %s" % session_key)

        # Q1：要求可视化
        page.evaluate("sendQuick('讲解单摆运动，并生成一个可调摆长和重力加速度的交互可视化演示')")
        wait_stream(page)
        log("Q1 完成")

        # 从画布节点里找真实 viz iframe 的 id
        deadline = time.time() + 200
        viz_id = None
        while time.time() < deadline and not viz_id:
            viz_id = page.evaluate("""() => {
                const f = document.querySelector('#graphCanvas iframe[data-viz-id], #graphCanvas iframe[id^="viz_"]');
                if (!f) return null;
                return f.getAttribute('data-viz-id') || f.id || null;
            }""")
            if not viz_id:
                time.sleep(4)
        log("画布内 viz id: %s" % viz_id)
        if viz_id:
            ok = page.evaluate("!!(_vizStore && _vizStore[%s])" % json.dumps(viz_id))
            log("vizStore 含该条目: %s" % ok)
            page.evaluate("toggleVizFullscreen(%s)" % json.dumps(viz_id))
            page.wait_for_timeout(3500)
            page.screenshot(path=os.path.join(OUT, "05-viz-iframe.png"))
            log("已截图 05-viz-iframe")
            page.evaluate("closeVizFullscreen()")
        else:
            log("05 仍未找到节点内 viz")

        # Q2：丰富知识池
        page.evaluate("sendQuick('阻尼振动和受迫振动有什么区别？共振发生的条件是什么？')")
        wait_stream(page)
        log("Q2 完成")

        # 等知识提取到足够条目
        deadline = time.time() + 240
        cnt = 0
        while time.time() < deadline:
            cnt = page.evaluate("""async () => {
                try {
                    const r = await fetch('/api/knowledge');
                    const d = await r.json();
                    return Object.values(d).filter(i => i.sessionId === SESSION_ID).length;
                } catch (e) { return 0; }
            }""")
            if cnt >= 5:
                break
            time.sleep(5)
        log("本画布知识点：%d" % cnt)

        # 打开检测 → intro → 开始
        page.evaluate("openQuiz()")
        deadline = time.time() + 90
        ph = ""
        while time.time() < deadline:
            ph = page.evaluate("quizState ? quizState.phase : ''")
            if ph == "intro":
                break
            time.sleep(2)
        # 等 AI 出题结束（或失败）
        deadline = time.time() + 200
        while time.time() < deadline:
            st = page.evaluate("""() => ({
                pending: !!(quizState && quizState.aiPending),
                n: quizState && quizState.questions ? quizState.questions.length : 0,
                notice: quizState && quizState.aiNotice || ''
            })""")
            log("quiz: pending=%s n=%s notice=%s" % (st["pending"], st["n"], st["notice"][:40]))
            if not st["pending"]:
                break
            time.sleep(6)
        # AI 无题则切本地题
        have_q = page.evaluate("quizState && quizState.questions ? quizState.questions.length : 0")
        if not have_q:
            log("AI 无题，切换本地题…")
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
            return { phase: quizState && quizState.phase, text: b ? b.innerText.slice(0, 150) : '' };
        }""")
        log("quiz phase=%s | %s" % (info["phase"], info["text"][:100].replace(chr(10), ' / ')))
        if info["phase"] == "question" or "A" in info["text"]:
            page.wait_for_timeout(600)
            page.screenshot(path=os.path.join(OUT, "08-quiz.png"))
            log("已截图 08-quiz")
        else:
            log("08 仍非题目页，保留现状")

        try:
            page.evaluate("async (k) => { await fetch('/api/sessions/' + k, { method: 'DELETE' }); }", session_key)
            log("已清理 %s" % session_key)
        except Exception as e:
            log("清理失败：%s" % e)
        browser.close()
    log("第二轮补拍完成")


if __name__ == "__main__":
    main()
