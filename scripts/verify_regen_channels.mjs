#!/usr/bin/env node
// 一次性真发验证（2026-10-13 带要求重生成，硬规则 6）：mock 上游 + 临时数据目录 + 真机 UI。
// 三条通道：
//   A 工作流节点带字修订：点「重新生成」→ 面板写字 → 发送（走 _applyWorkflowNodeRegenerate）
//   B 工作流节点留空直发：面板不写字直接发（回 runWorkflowNode 原管线整体重跑）
//   C 消息模块面板路：真发 _regenerateModuleContent（没看懂/带要求 prompt 泛化后的通道）
// 常驻：改重生成发送链后跑一次（硬规则 6）——node scripts/verify_regen_channels.mjs（约 2 分钟，用完即杀不碰 data/）
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const APP_PORT = 5077;
const MOCK_PORT = 5081;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const ok = n => { results.push(true); console.log('✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

const mock = spawn('node', ['scripts/mock_upstream.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(MOCK_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let mockLog = '';
mock.stdout.on('data', d => { mockLog += d; });
mock.stderr.on('data', d => { mockLog += d; });
mock.on('exit', (code, sig) => { mockLog += '\n[mock exited code=' + code + ' sig=' + sig + ']'; });
const workDir = mkdtempSync(join(tmpdir(), 'phymathia-verify-regen-'));
cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
const server = spawn('python3', ['src/main.py', '-p', String(APP_PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

const stats = async () => {
  const r = await (await fetch(MOCK + '/__stats')).json();
  return Number(r.chat_requests ?? r.chatRequests ?? 0);
};

let browser = null;
try {
  let mockUp = false;
  for (let i = 0; i < 40; i++) { try { if ((await fetch(MOCK + '/health')).ok) { mockUp = true; break; } } catch (e) {} await wait(250); }
  if (!mockUp) throw new Error('mock 上游 10s 内没起来（端口 ' + MOCK_PORT + '）');
  let appUp = false;
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) { appUp = true; break; } } catch (e) {} await wait(300); }
  if (!appUp) throw new Error('临时应用 20s 内没起来（端口 ' + APP_PORT + '）');

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const pageErrors = [];
  const netLog = [];
  page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
  page.on('console', m => { if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 220)); });
  page.on('response', r => { if (r.url().includes('/api/models/chat')) netLog.push('models/chat → HTTP ' + r.status()); });
  page.on('requestfailed', r => { if (r.url().includes('/api/')) netLog.push('REQ FAILED: ' + r.url().slice(-40) + ' ' + ((r.failure() && r.failure().errorText) || '')); });
  await page.addInitScript((cfg) => {
    localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
    const act = {};
    for (const s of cfg.slots) act[s] = cfg.model.id;
    localStorage.setItem('phymathia_active_models', JSON.stringify(act));
    localStorage.setItem('phymathia_onboarding_done', '1');
    localStorage.setItem('phymathia_guide_seen', '1');
  }, {
    model: { id: 'mock-1', name: 'mock', provider: "opencode", model: "mock-1", apiKey: 'x', baseUrl: MOCK + '/v1' },
    slots: ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'],
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1000);

  // 发起工作流，等物理视角节点长出内容
  await page.evaluate(() => window.startQuestionWorkflow('用一句话说明简谐运动'));
  const waitPhys = async (timeoutMs) => {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      const c = await page.evaluate(() => {
        const n = (typeof graphView !== 'undefined' ? graphView.nodes : []).find(n => n.kind === 'module' && n.moduleKey === 'physics');
        return n ? (n.content || '') : '';
      });
      if (c.trim()) return c;
      await wait(600);
    }
    return '';
  };
  const content0 = await waitPhys(150000);
  if (!content0) {
    const dump = await page.evaluate(() => ({
      nodes: (typeof graphView !== 'undefined' ? graphView.nodes : []).map(n => ({ kind: n.kind, mk: n.moduleKey, busy: n.busy, st: n.status, len: (n.content || '').length })),
      tasks: (document.querySelector('#taskPanelBody') || {}).innerText || '',
      mockHits: window.__mockHits || 0,
    })).catch(e => ({ dumpErr: String(e) }));
    console.log('  诊断 dump：' + JSON.stringify(dump).slice(0, 800));
    console.log('  mockLog：' + mockLog.slice(-500));
    console.log('  网络日志：' + (netLog.join(' | ') || '（无 models/chat 流量）'));
    console.log('  页面 JS 错误：' + (pageErrors.slice(0, 5).join(' | ') || '无'));
    try { console.log('  mock 计数：' + await stats()); } catch (e) { console.log('  mock 计数取不到（mock 已死）'); }
    throw new Error("物理视角节点 150s 内没有内容 | serverLog尾: " + serverLog.slice(-200));
  }
  await wait(2500);
  const physId = await page.evaluate(() => graphView.nodes.find(n => n.kind === 'module' && n.moduleKey === 'physics').id);
  console.log('  物理视角节点就绪：' + physId + '（内容 ' + content0.length + ' 字）');

  const openPanel = async (id) => {
    // 上一轮生成收尾的画布重建可能恰好把刚弹出的面板擦掉：重试弹，弹不出才算失败
    for (let i = 0; i < 4; i++) {
      await page.evaluate((nid) => {
        const b = document.querySelector('[data-node-id="' + nid + '"] .graph-node-actions button');
        if (b) b.click();
      }, id);
      try {
        await page.waitForSelector('[data-node-id="' + id + '"] .graph-regenerate-panel', { timeout: 2500 });
        return;
      } catch (e) { await wait(1200); }
    }
    throw new Error('重试 4 次面板都没弹出（按钮可能在置灰或画布重建竞态）');
  };
  const physContent = async (id) => page.evaluate((nid) => {
    const n = graphView.nodes.find(n => n.id === nid);
    return (n && n.content) || '';
  }, id);

  // —— 通道 A：带字修订 ——
  try {
    const s0 = await stats();
    await openPanel(physId);
    await page.evaluate((nid) => {
      const node = document.querySelector('[data-node-id="' + nid + '"]');
      node.querySelector('.graph-regenerate-input').value = '再加一个生活里的例子';
      node.querySelector('.graph-regenerate-actions .graph-draft-send').click();
    }, physId);
    let contentA = '';
    const dl = Date.now() + 90000;
    while (Date.now() < dl) {
      await wait(900);
      const c = await physContent(physId);
      if (c && c !== content0) { contentA = c; break; }
    }
    const s1 = await stats();
    if (!contentA) throw new Error('90s 内节点内容没有变化');
    if (s1 <= s0) throw new Error('mock 请求数没有增加（s0=' + s0 + ' s1=' + s1 + '）——修订没真发');
    ok('通道 A 工作流节点带字修订：内容已换新（mock 第 ' + s1 + ' 次请求），真发 ✓');
  } catch (e) { bad('通道 A 工作流节点带字修订', e); }

  // —— 通道 B：留空直发（回原管线整体重跑）——
  try {
    const contentA = await physContent(physId);
    const s0 = await stats();
    await wait(3000);
    const diag = await page.evaluate((nid) => {
      const el = document.querySelector('[data-node-id="' + nid + '"]');
      const btn = el && el.querySelector('.graph-node-actions button');
      let directCall = 'not-tried';
      try {
        if (typeof graphOpenRegenerate === 'function') { graphOpenRegenerate(nid); directCall = el && el.querySelector('.graph-regenerate-panel') ? 'panel-opened' : 'no-panel'; }
        else directCall = 'no-fn';
      } catch (e) { directCall = 'threw: ' + e.message; }
      return {
        elExists: !!el,
        btnHtml: btn ? btn.outerHTML.slice(0, 140) : null,
        regenSet: (typeof _regeneratingNodes !== 'undefined') ? [..._regeneratingNodes] : null,
        nodeBusy: (graphView.nodes.find(n => n.id === nid) || {}).busy,
        directCall,
      };
    }, physId);
    console.log('  B 前诊断：' + JSON.stringify(diag));
    if (diag.directCall !== 'panel-opened') {
      // 直调都没弹就别再点了，直接把断言指向这个根因
      throw new Error('graphOpenRegenerate 直调未弹面板：' + JSON.stringify(diag));
    }
    await page.evaluate((nid) => {
      document.querySelector('[data-node-id="' + nid + '"] .graph-regenerate-actions .graph-draft-send').click();
    }, physId);
    let contentB = '';
    const dl = Date.now() + 90000;
    while (Date.now() < dl) {
      await wait(900);
      const c = await physContent(physId);
      if (c && c !== contentA) { contentB = c; break; }
    }
    const s1 = await stats();
    if (!contentB) throw new Error('90s 内节点内容没有变化');
    if (s1 <= s0) throw new Error('mock 请求数没有增加——留空直发没真发');
    ok('通道 B 工作流节点留空直发：原管线重跑出新内容（mock 第 ' + s1 + ' 次请求），真发 ✓');
  } catch (e) { bad('通道 B 工作流节点留空直发', e); }

  // —— 通道 C：消息模块面板路 prompt（没看懂/带要求）真发 ——
  try {
    const s0 = await stats();
    const msg = await page.evaluate(async () => {
      return await window._regenerateModuleContent({ content: '<physics>旧内容ABC</physics>' }, 'physics', '太抽象了，加个例子');
    });
    const s1 = await stats();
    if (!msg || !String(msg).trim()) throw new Error('返回空');
    if (s1 <= s0) throw new Error('mock 请求数没有增加——模块路没真发');
    if (String(msg).includes('旧内容ABC')) throw new Error('模块替换没生效（仍含旧内容）');
    ok('通道 C 消息模块面板路（泛化 prompt）：真发 ✓（mock 第 ' + s1 + ' 次请求），旧模块已被替换');
  } catch (e) { bad('通道 C 消息模块面板路', e); }

  if (pageErrors.length) console.log('!! 页面 JS 错误：' + pageErrors.slice(0, 3).join(' | '));
} catch (e) {
  bad('验证脚本整体', e);
  console.log('serverLog 尾部：' + serverLog.slice(-500));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill();
  mock.kill();
}
const pass = results.filter(Boolean).length;
console.log(pass === results.length ? '全部通道真发通过（' + pass + '/' + results.length + '）' : '有通道失败（' + pass + '/' + results.length + '）');
process.exit(pass === results.length ? 0 : 1);
