#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
PhyMathia 参赛介绍 · 演示截图驱动脚本

启动前置（由调用方保证）:
  - 服务已在 127.0.0.1:5055 运行
  - 环境变量: LD_LIBRARY_PATH / PLAYWRIGHT_BROWSERS_PATH / PYTHONPATH 指向 .tools/*

流程:
  1. 无痕浏览器 + 预置 localStorage（深色主题 / deepseek 模型六槽位 / 跳过引导 / 大学难度）
  2. 新建画布 → 提问"单摆" → 等完整探索流式结束 → 截 03
  3. 追问阻尼 → 截 04（全景）→ 截 05（可视化全屏）
  4. 知识面板 → 06；公式页签 → 07；知识检测 → 08；Φ 助手 → 09；会话侧栏 → 10
  5. 全部输出 PNG 到 images/_staging/（1600×1000，后续脚本转 JPG 挂载）
"""

import json
import os
import sys
import time

from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:5055"
OUT = os.path.join(os.path.dirname(__file__), "..", "html", "PhyMathia-参赛介绍", "images", "_staging")
OUT = os.path.abspath(OUT)
os.makedirs(OUT, exist_ok=True)

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


def log(msg):
    print("[shot] %s" % msg, flush=True)


def wait_stream_done(page, timeout_s=420):
    """等流式结束：进度条消失 + 助手消息数不再增长，双确认；并校验内容非错误页。"""
    deadline = time.time() + timeout_s
    stable = 0
    prev_len = -1
    while time.time() < deadline:
        st = page.evaluate(
            """() => ({
                progress: !!document.querySelector('#progressBar.active, #progressStatus.active'),
                assistants: (typeof getChatHistory === 'function') ? getChatHistory().filter(m => m.role === 'assistant').length : 0,
            })"""
        )
        if not st["progress"] and st["assistants"] > 0 and st["assistants"] == prev_len:
            stable += 1
            if stable >= 4:  # 4 次 × 1.5s 无变化 = 结束
                _assert_real_content(page)
                return st["assistants"]
        else:
            stable = 0
        prev_len = st["assistants"]
        time.sleep(1.5)
    raise TimeoutError("流式生成超时")


def _assert_real_content(page):
    """守卫：最后一条助手回答必须像完整探索（够长、无 401/错误标记）。"""
    info = page.evaluate(
        """() => {
            const h = getChatHistory().filter(m => m.role === 'assistant');
            const last = h[h.length - 1] || {};
            return { len: String(last.content || '').length, head: String(last.content || '').slice(0, 120) };
        }"""
    )
    if info["len"] < 400 or "401" in info["head"] or "⚠" in info["head"]:
        raise RuntimeError("回答疑似错误页（len=%d）：%s" % (info["len"], info["head"]))


def wait_extract(page, timeout_s=40):
    """等知识提取落库（公式/知识点面板有数据）。"""
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        n = page.evaluate(
            """async () => {
                try {
                    const r = await fetch('/api/formulas');
                    const data = await r.json();
                    return Object.values(data || {}).filter(f => f.sessionId === SESSION_ID).length;
                } catch (e) { return -1; }
            }"""
        )
        if n > 0:
            return n
        time.sleep(2)
    return 0


def fit_graph(page, margin=90, max_iter=30):
    """把画布节点包络盒缩放平移到视口内（用应用自己的 fitGraph / zoomGraph）。"""
    return page.evaluate(
        """(margin) => {
            if (typeof fitGraph === 'function') { fitGraph(); return 'fitGraph'; }
            return 'no-fit';
        }""",
        margin,
    )


def shot(page, name):
    path = os.path.join(OUT, name + ".png")
    page.screenshot(path=path)
    log("已截图 %s" % name)
    return path


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--no-sandbox", "--force-color-profile=srgb"])
        ctx = browser.new_context(
            viewport={"width": 1280, "height": 800},
            device_scale_factor=1.25,  # 125% 缩放感 → 输出 1600×1000
            locale="zh-CN",
        )
        ctx.add_init_script(SEED)
        page = ctx.new_page()
        page.set_default_timeout(20000)

        log("打开应用…")
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # 干净画布
        page.evaluate("createNewSession()")
        page.wait_for_timeout(1200)
        session_key = page.evaluate("getCurrentSessionId()")
        log("测试画布：%s" % session_key)

        # ---- Q1：单摆（完整探索）----
        log("提问 Q1：单摆…")
        page.evaluate("sendQuick('单摆的运动规律是什么？')")
        n1 = wait_stream_done(page, 360)
        log("Q1 完成，助手消息 %d 条" % n1)
        page.wait_for_timeout(2000)
        if wait_extract(page) == 0:
            log("警告：公式提取未见数据（继续）")

        # ---- 03：聚焦第一个回答簇 ----
        page.evaluate(
            """() => {
                const nodes = [...document.querySelectorAll('#graphCanvas .graph-node')];
                if (!nodes.length || typeof zoomGraph !== 'function') return;
                const rects = nodes.map(n => n.getBoundingClientRect());
                const bx = Math.min(...rects.map(r => r.left)), ax = Math.max(...rects.map(r => r.right));
                const by = Math.min(...rects.map(r => r.top)), ay = Math.max(...rects.map(r => r.bottom));
                const vw = innerWidth - 160, vh = innerHeight - 140;
                const f = Math.min(vw / (ax - bx), vh / (ay - by), 1.6);
                zoomGraph(Math.max(0.25, f), (bx + ax) / 2, (by + ay) / 2);
            }"""
        )
        page.wait_for_timeout(900)
        shot(page, "03-dual-domain")

        # ---- Q2：阻尼（第二个簇 + 连线）----
        log("提问 Q2：阻尼…")
        page.evaluate("sendQuick('如果摆角很大，或者存在空气阻力，单摆会怎么运动？')")
        wait_stream_done(page, 360)
        page.wait_for_timeout(2000)

        # ---- 04：全景 ----
        log("fitGraph 全景…")
        page.evaluate("typeof fitGraph === 'function' && fitGraph()")
        page.wait_for_timeout(1200)
        shot(page, "04-graph-net")

        # ---- 05：可视化全屏 ----
        try:
            viz_id = page.evaluate(
                """() => {
                    const f = document.querySelector('#graphCanvas iframe[id]');
                    return f ? f.id : null;
                }"""
            )
            if viz_id:
                page.evaluate("toggleVizFullscreen(%s)" % json.dumps(viz_id))
                page.wait_for_timeout(2500)
                shot(page, "05-viz-iframe")
                page.evaluate("closeVizFullscreen()")
            else:
                log("05 跳过：未发现可视化 iframe")
        except Exception as e:
            log("05 失败：%s" % e)

        # ---- 06 知识总览 ----
        page.evaluate("toggleKnowledgePanel()")
        page.wait_for_timeout(2500)
        shot(page, "06-knowledge")

        # ---- 07 公式速查 ----
        page.evaluate("switchKpTab('formulas')")
        page.wait_for_timeout(1500)
        shot(page, "07-formulas")
        page.evaluate("typeof closeKnowledgePanel === 'function' && closeKnowledgePanel()")
        page.wait_for_timeout(600)

        # ---- 08 知识检测 ----
        try:
            page.evaluate("openQuiz()")
            deadline = time.time() + 240
            ok = False
            while time.time() < deadline:
                st = page.evaluate(
                    """() => {
                        const b = document.getElementById('quizBody');
                        return {
                            visible: b && b.offsetParent !== null,
                            text: b ? b.innerText.length : 0,
                            generating: b ? /生成|加载|出题中/.test(b.innerText.slice(0, 80)) : true
                        };
                    }"""
                )
                if st["visible"] and st["text"] > 120 and not st["generating"]:
                    ok = True
                    break
                time.sleep(3)
            page.wait_for_timeout(1200)
            shot(page, "08-quiz")
            page.evaluate("typeof closeQuiz === 'function' && closeQuiz()")
        except Exception as e:
            log("08 失败：%s" % e)

        # ---- 09 Φ 助手 ----
        try:
            page.evaluate("window.toggleGraphPet && window.toggleGraphPet()")
            page.wait_for_timeout(2000)
            shot(page, "09-phi-harness")
        except Exception as e:
            log("09 失败：%s" % e)

        # ---- 10 会话侧栏 ----
        try:
            page.evaluate("window.toggleGraphPet && window.toggleGraphPet()")  # 关 Φ 面板
            page.wait_for_timeout(500)
            page.evaluate("toggleSidebar()")
            page.wait_for_timeout(1200)
            shot(page, "10-sessions")
        except Exception as e:
            log("10 失败：%s" % e)

        # ---- 清理测试画布（对称删除：会话+知识+公式）----
        try:
            page.evaluate(
                "async (k) => { await fetch('/api/sessions/' + k, { method: 'DELETE' }); }",
                session_key,
            )
            log("已清理测试画布 %s" % session_key)
        except Exception as e:
            log("清理失败（可手动删）：%s" % e)

        browser.close()
    log("全部完成 → %s" % OUT)


if __name__ == "__main__":
    sys.exit(main())
