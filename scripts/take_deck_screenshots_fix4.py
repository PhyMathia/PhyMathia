#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""05 专项诊断+补拍：导出 viz HTML，尝试全屏与直开两种截图路径。"""

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
    print("[fix4] %s" % m, flush=True)


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

        page.evaluate("sendQuick('讲解单摆运动，并生成一个可调摆长和重力加速度的交互可视化演示')")
        wait_stream(page)
        log("Q1 完成")

        node_id = page.evaluate(
            """() => {
                const n = (typeof graphView !== 'undefined' && graphView.nodes || [])
                    .find(n => n.kind === 'module' && n.moduleKey === 'viz');
                return n ? n.id : null;
            }"""
        )
        log("viz 节点：%s" % node_id)
        if not node_id:
            log("无 viz 节点，放弃")
            browser.close()
            return
        try:
            page.evaluate("generateVizNode(%s)" % json.dumps(node_id))
        except Exception as e:
            log("generateVizNode 异步：%s" % e)
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
        log("viz 卡片：%s" % card_id)
        if not card_id:
            browser.close()
            return

        # 导出 viz HTML 供诊断
        html = page.evaluate("_vizStore[%s] || ''" % json.dumps(card_id))
        dump = os.path.join(OUT, "_viz_dump.html")
        with open(dump, "w", encoding="utf-8") as f:
            f.write(html or "")
        log("viz HTML %d 字节 → %s" % (len(html or ""), dump))
        log("HTML 头部: %s" % (html or "")[:200].replace(chr(10), ' '))
        scripts = page.evaluate(
            """(id) => {
                const h = _vizStore[id] || '';
                return {
                    has_three: /three|THREE/.test(h),
                    has_canvas: /<canvas/.test(h),
                    has_cdn: /https?:\\/\\/(cdn|unpkg|jsdelivr)/.test(h),
                    has_requestAnimationFrame: /requestAnimationFrame/.test(h),
                    len: h.length
                };
            }""", card_id)
        log("viz 特征: %s" % scripts)

        # 路径 A：全屏 overlay，等更久（8s）
        page.evaluate("toggleVizFullscreen(%s)" % json.dumps(card_id))
        page.wait_for_timeout(8000)
        page.screenshot(path=os.path.join(OUT, "05-viz-iframe.png"))
        log("已截 05（全屏 8s 等待版）")
        page.evaluate("closeVizFullscreen()")

        # 路径 B：直接把 viz HTML 作为页面渲染后截图（保底）
        page2 = ctx.new_page()
        page2.set_viewport_size({"width": 1280, "height": 800})
        page2.set_content(html or "<html><body>EMPTY</body></html>", wait_until="load")
        page2.wait_for_timeout(6000)
        # 触发可能的交互启动
        page2.mouse.move(640, 400)
        page2.mouse.click(640, 400)
        page2.wait_for_timeout(2000)
        page2.screenshot(path=os.path.join(OUT, "05-viz-direct.png"))
        log("已截 05（直开保底版）")

        try:
            page.evaluate("async (k) => { await fetch('/api/sessions/' + k, { method: 'DELETE' }); }", session_key)
            log("已清理")
        except Exception as e:
            log("清理失败：%s" % e)
        browser.close()
    log("fix4 完成")


if __name__ == "__main__":
    main()
