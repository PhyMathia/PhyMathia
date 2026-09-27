#!/usr/bin/env node
// 发送通道真机验证（AGENTS.md 硬规则 6）：把幸存的每条通道**真发一次**并逐条记录。
//
// 这不是单元测试，也不是 mock——它配好真实模型、走真实 UI 路径发真请求。存在的
// 理由是 isCasual 事故（2026-09-25，分支/苏格拉底整整一周发不出请求，而静态回归
// 全绿）：回归沙箱没配模型走不到发送段，静态绿不等于真机能发。
//
// 2026-09-27 那一轮是为了验证 graph-workflow.js 的 SSE 读取口抽取（三处合一）。
// 抽出共用读取口最容易出的错是「某一类节点不更新了」——静态断言看不出来，只有
// 真发才知道。
//
// 用法：node scripts/verify_send_channels.mjs
// 前置：服务在 5050 起着，且 opencode 网关可达（脚本会先探，不通就直接退出而不是
// 假装通过）。真实 data/ 只读不碰——全程在临时数据目录里跑。

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5079;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

// 模型可用环境变量换（默认走 .env 里的 opencode 免费网关）：
//   VERIFY_PROVIDER / VERIFY_MODEL / VERIFY_BASE_URL / VERIFY_API_KEY
// **2026-09-27 实测记录**：本机 .env 里的 opencode key 对**所有**模型都被上游拒了
// （Invalid credential / Model is unavailable / 免费层限 OpenCode 内部客户端），
// DeepSeek 的 key 也是 invalid。所以那天这脚本没能真正跑通五条通道——见
// docs/backlog.md T37。换一把可用 key 后直接重跑本脚本即可补上那次验证。
const MODEL = {
  id: 'verify-model', name: '验证用模型',
  provider: process.env.VERIFY_PROVIDER || 'opencode',
  model: process.env.VERIFY_MODEL || 'deepseek-v4-flash-free',
  apiKey: process.env.VERIFY_API_KEY || '',
  baseUrl: process.env.VERIFY_BASE_URL || 'https://opencode.ai/zen/v1',
};
const SLOTS = ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'];

const results = [];
function ok(name) { results.push([true, name]); console.log('✓ ' + name); }
function bad(name, err) {
  results.push([false, name]);
  console.log('❌ ' + name + ' -> ' + (err && err.message || err));
}

async function waitHealth(base, ms = 30000) {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    try { if ((await fetch(base + '/health')).ok) return true; } catch (e) {}
    await wait(300);
  }
  throw new Error('服务未就绪');
}

/** 等某个节点从 busy 变成 done（或超时）。流式是否真的把内容灌进去了，看这里。 */
async function waitNodeSettled(page, nodeId, timeoutMs) {
  const dl = Date.now() + timeoutMs;
  let lastLen = -1;
  while (Date.now() < dl) {
    const st = await page.evaluate((id) => {
      const n = (typeof graphView !== 'undefined' && graphView) ? graphView.nodeById[id] : null;
      return n ? { busy: !!n.busy, status: n.status, len: String(n.content || n.analysis || '').length } : null;
    }, nodeId);
    if (st && !st.busy && st.status === 'done') return st;
    lastLen = st ? st.len : -1;
    await wait(700);
  }
  throw new Error('节点 ' + nodeId + ' 超时未完成（最后长度 ' + lastLen + '）');
}

async function main() {
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-verify-send-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  for (const f of ['http_client.py', 'llm_common.py', 'usage_stats.py']) {
    cpSync(join(ROOT, f), join(workDir, f));
  }
  const server = spawn('python3', ['src/main.py', '-p', String(PORT)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', d => { log += d; });
  server.stderr.on('data', d => { log += d; });

  let browser = null;
  try {
    await waitHealth(BASE);

    // 先探网关：不通就明说，别让「没发成」看起来像「发失败了」
    if (MODEL.provider === 'opencode') {
      const listed = await (await fetch(BASE + '/api/models/list', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'opencode' }),
      })).json();
      if (!listed.models || !listed.models.length) throw new Error('网关列不出模型，验证无从谈起');
      if (!listed.models.includes(MODEL.model)) {
        throw new Error('网关没有模型 ' + MODEL.model + '（可用：' + listed.models.slice(0, 5).join(', ') + ' …）');
      }
    }
    console.log('网关就绪，模型：' + MODEL.provider + '/' + MODEL.model + '\n');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    // 配好模型 + 跳过引导，否则发不出去（这正是硬规则 6 强调的那一点）
    // 参数传**对象**不传数组：playwright 的 addInitScript 会把数组实参再包一层，
    // 于是 `([model, slots]) => {}` 解出来 slots 是 undefined，模型静默配不上
    //（第一版就这么栽的：报的是「槽位读到 null」，看不出是种子没写进去）。
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
        const act = {};
        for (const s of cfg.slots) act[s] = cfg.model.id;
        localStorage.setItem('phymathia_active_models', JSON.stringify(act));
        localStorage.setItem('phymathia_onboarding_done', '1');
        localStorage.setItem('phymathia_guide_seen', '1');
      } catch (e) { console.error('[verify] 模型种子写入失败：' + e.message); }
    }, { model: MODEL, slots: SLOTS });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function'
      || typeof window.sendGraphNewSession === 'function', null, { timeout: 20000 });
    await page.waitForTimeout(1200);

    const modelLive = await page.evaluate(() => {
      const m = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('agent') : null;
      return m ? m.model : null;
    });
    if (modelLive !== MODEL.model) throw new Error('模型没配上（槽位读到 ' + modelLive + '）');

    // 上游探针：模型「列得出来」不等于「调得动」——2026-09-27 那天就是列得出、
    // 一发就 502（上游 Model is unavailable）。先探一发，别把上游挂了记成产品回归。
    const probe = await page.evaluate(async (m) => {
      try {
        const r = await proxyChat('说三个字', 'university', '', true, new AbortController().signal,
          { workflowContext: { mode: 'analysis', question: '探针' } });
        if (!r) return { err: 'proxyChat 返回空（模型没配上）' };
        if (!r.ok) return { err: 'HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160) };
        return { ok: true };
      } catch (e) { return { err: e.message }; }
    });
    if (!probe.ok) {
      throw new Error('上游调不动（' + probe.err + '）——这是凭证/模型的问题，不是产品回归。'
        + '换一把可用 key 后重跑：VERIFY_MODEL=... VERIFY_API_KEY=... node scripts/verify_send_channels.mjs');
    }
    console.log('模型已就位：' + modelLive + '\n');

    // ===== 1. 工作流首问 =====
    let rootId = null;
    try {
      rootId = await page.evaluate(async () => {
        const ta = document.querySelector('.graph-new-session-input');
        if (ta) {
          ta.value = '用一句话说明简谐运动的定义';
          await window.sendGraphNewSession(ta);
        } else {
          await window.startQuestionWorkflow('用一句话说明简谐运动的定义');
        }
        for (let i = 0; i < 120; i++) {
          const n = graphView.nodes.find(x => x.kind === 'module' || x.kind === 'answer');
          if (n) return n.id;
          await new Promise(r => setTimeout(r, 500));
        }
        return null;
      });
      if (!rootId) throw new Error('首问后没长出节点');
      const st = await waitNodeSettled(page, rootId, 180000);
      if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）——SSE 读取口可能断了');
      ok('通道① 工作流首问：已发通，流式收到 ' + st.len + ' 字');
    } catch (e) { bad('通道① 工作流首问', e); }

    // ===== 2. 节点追问 / 3. 没看懂 / 4. 苏格拉底回答 =====
    if (rootId) {
      for (const [label, portLabel] of [['② 节点追问', '追问'], ['③ 没看懂', '没看懂'], ['④ 苏格拉底回答', '回答练习']]) {
        try {
          const created = await page.evaluate(async ([srcId, plabel]) => {
            const src = graphView.nodeById[srcId];
            if (!src) return { err: '源节点不在了' };
            const port = (src.outputPorts || []).find(p => String(p.label || '').includes(plabel))
              || (src.outputPorts || [])[0];
            if (!port) return { err: '源节点没有可用输出端口：' + JSON.stringify((src.outputPorts || []).map(p => p.label)) };
            const before = graphView.nodes.length;
            await window._createBranchNodeFromOutput(srcId, port.id || 'out-0', port,
              (src.x || 0) + 460, (src.y || 0) + 240);
            await new Promise(r => setTimeout(r, 800));
            const fresh = graphView.nodes.slice(before);
            return { n: fresh.length, id: fresh.length ? fresh[0].id : null };
          }, [rootId, portLabel]);
          if (created.err) throw new Error(created.err);
          if (!created.id) throw new Error('没有新建出节点（' + created.n + ' 个）');
          const st = await waitNodeSettled(page, created.id, 180000);
          if (st.len < 20) throw new Error('流式内容为空或过短（' + st.len + ' 字）');
          ok(label + '：已发通，流式收到 ' + st.len + ' 字');
        } catch (e) { bad(label, e); }
      }

      // ===== 5. 重试（重新生成）=====
      try {
        const regen = await page.evaluate(async (id) => {
          const n = graphView.nodeById[id];
          if (!n) return { err: '节点不在了' };
          const before = String(n.content || '');
          const p = window.submitRegenerateNode(id);
          if (p && p.then) await p;
          return { beforeLen: before.length, node: id };
        }, rootId);
        if (regen.err) throw new Error(regen.err);
        const st = await waitNodeSettled(page, regen.node, 180000);
        if (st.len < 20) throw new Error('重生成后内容为空（' + st.len + ' 字）');
        ok('⑤ 重试：已发通，重生成后 ' + st.len + ' 字（原 ' + regen.beforeLen + ' 字）');
      } catch (e) { bad('⑤ 重试', e); }
    } else {
      ['② 节点追问', '③ 没看懂', '④ 苏格拉底回答', '⑤ 重试'].forEach(n =>
        bad(n, new Error('首问未通，依赖它的通道没法验')));
    }

    if (pageErrors.length) console.log('\n页面异常：' + pageErrors.slice(0, 3).join(' | '));
  } catch (e) {
    bad('环境', e);
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill('SIGTERM'); } catch (e) {}
    await wait(600);
    try { server.kill('SIGKILL'); } catch (e) {}
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }

  const passed = results.filter(r => r[0]).length;
  console.log(`\n发送通道真机验证：${passed} / ${results.length} 条已发通`);
  if (passed !== results.length) {
    console.log('\n--- 服务日志尾部 ---\n' + log.split('\n').slice(-30).join('\n'));
    process.exit(1);
  }
}

main().catch(e => { console.error('运行失败：' + (e && e.message || e)); process.exit(1); });
