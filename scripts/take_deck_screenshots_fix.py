#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""补拍脚本：05 交互可视化全屏 + 08 知识检测题目页（前置同主脚本）。"""

import json
import os
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5055"
OUT = os.path.abspath(os.path.join(
    os.path.dirname(__file__), "..", "html", "PhyMathia-参赛介绍", "images", "_staging"))

MODEL_ID = "model_autoshot01"
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
    print("[fix] %s" % m, flush=True)


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

        # ---- 提问（明确要求可视化）----
        page.evaluate("sendQuick('讲解一下单摆运动，并务必生成一个可以调整摆长和重力的交互可视化演示')")
        # 等流式结束
        deadline = time.time() + 420
        stable, prev = 0, -1
        while time.time() < deadline:
            st = page.evaluate("""() => ({
                progress: !!document.querySelector('#progressBar.active, #progressStatus.active'),
                n: (typeof getChatHistory==='function') ? getChatHistory().filter(m=>m.role==='assistant').length : 0
            })""")
            if not st["progress"] and st["n"] > 0 and st["n"] == prev:
                stable += 1
                if stable >= 4:
                    break
            else:
                stable = 0
            prev = st["n"]
            time.sleep(1.5)
        log("回答流式结束")

        # ---- 等 HTML 模型异步补齐可视化（_vizStore 出现条目）----
        deadline = time.time() + 240
        viz_keys = []
        while time.time() < deadline:
            viz_keys = page.evaluate("typeof _vizStore !== 'undefined' ? Object.keys(_vizStore) : []")
            if viz_keys:
                break
            time.sleep(4)
        log("_vizStore keys: %s" % viz_keys)
        if not viz_keys:
            log("05 失败：可视化始终未生成")
        else:
            page.evaluate("toggleVizFullscreen(%s)" % json.dumps(viz_keys[0]))
            page.wait_for_timeout(3500)  # 等 iframe 渲染动画
            page.screenshot(path=os.path.join(OUT, "05-viz-iframe.png"))
            log("已截图 05-viz-iframe")
            page.evaluate("closeVizFullscreen()")
            page.wait_for_timeout(600)

        # ---- 等知识提取（给 quiz 攒题池）----
        time.sleep(12)

        # ---- 08 知识检测：进到题目页再截 ----
        try:
            page.evaluate("openQuiz()")
            # 等 intro 就绪（pool 构建完）
            deadline = time.time() + 120
            while time.time() < deadline:
                ph = page.evaluate("typeof quizState !== 'undefined' && quizState ? quizState.phase : ''")
                if ph in ("intro", "question"):
                    break
                time.sleep(2)
            log("quiz phase=%s" % ph)
            # 若 AI 题在生成，等它完成（最多 180s），超时就用本地题
            deadline = time.time() + 180
            while time.time() < deadline:
                st = page.evaluate("""() => ({
                    pending: quizState && !!quizState.aiPending,
                    q: quizState && quizState.questions ? quizState.questions.length : 0
                })""")
                if not st["pending"] or st["q"] == 0:
                    break
                time.sleep(4)
            page.evaluate("typeof startQuiz === 'function' && startQuiz()")
            page.wait_for_timeout(1500)
            info = page.evaluate("""() => {
                const b = document.getElementById('quizBody');
                return { phase: quizState && quizState.phase, text: b ? b.innerText.slice(0, 200) : '' };
            }""")
            log("quiz 现在 phase=%s | 正文预览: %s" % (info["phase"], info["text"][:80].replace(chr(10), ' / ')))
            page.wait_for_timeout(800)
            page.screenshot(path=os.path.join(OUT, "08-quiz.png"))
            log("已截图 08-quiz")
            page.evaluate("typeof closeQuiz === 'function' && closeQuiz()")
        except Exception as e:
            log("08 失败：%s" % e)

        # ---- 清理测试画布 ----
        try:
            page.evaluate("async (k) => { await fetch('/api/sessions/' + k, { method: 'DELETE' }); }", session_key)
            log("已清理 %s" % session_key)
        except Exception as e:
            log("清理失败：%s" % e)

        browser.close()
    log("补拍完成")


if __name__ == "__main__":
    main()
