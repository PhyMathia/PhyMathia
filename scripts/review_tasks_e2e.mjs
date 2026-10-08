#!/usr/bin/env node
// 任务列表真机回归（AGENTS.md 硬规则 6 的落地）：mock 上游 + 临时数据目录 + 真实 UI 路径。
//
// 为什么不是纯静态回归：任务列表的三件事只有真发才看得出来——工作流跑起来节点条目
// 会不会动、面板上的「停」是否只掐被点的那一颗、跑着时切会话产出会不会丢。
// 2026-09-27 首次跑就当场抓出两个产品缺陷（排队那条标题认不出是哪句问题、停节点后
// 收尾文案不对），静态断言看不出来。
//
// 与 verify_send_channels.mjs 的分工：那个验「每条通道发得出去」，这个验「发出去的活儿
// 在任务列表里对得上」。
//   node scripts/review_tasks_e2e.mjs     （约 1-3 分钟；用完即杀，不碰 data/）
import { fileURLToPath } from 'node:url';
// 任务列表真机自测（临时脚本，不入库）：mock 上游 + 临时数据目录 + 真实 UI 路径。
// 覆盖：面板开关 / 工作流任务与节点条目 / 停单个节点 / 排队项=任务且可单条取消 /
//       工作流跑着时切会话（任务照跑、列表照看）。
import { createServer } from 'node:http';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const APP_PORT = 5078;
const MOCK_PORT = 5098;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

let mockHits = 0;
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let body = '';
  for await (const c of req) body += c;
  mockHits++;
  const n = mockHits;
  const text = '问题概要（第' + n + '次）：简谐运动的回复力与振动方程。\n'
    + '建议模块：物理视角、数学视角、苏格拉底追问、进阶学习\n'
    + '正文（第' + n + '次）：这一版说明简谐运动的物理直觉与数学结构，内容每次不同。\n';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const piece of (text.match(/[\s\S]{1,10}/g) || [])) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    await wait(400);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const workDir = mkdtempSync(join(tmpdir(), 'phymathia-e2e-tasks-'));
cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });

const server = spawn('python3', ['src/main.py', '-p', String(APP_PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });

const results = [];
const ok = (n) => { results.push([true, n]); console.log('✓ ' + n); };
const bad = (n, e) => { results.push([false, n + ' —— ' + ((e && e.message) || e)]); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

let browser = null;
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + '/health')).ok) break; } catch (e) {} await wait(300); }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const pageErrors = [];
  page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
  page.on('console', m => { if (m.type() === 'error' && /任务|Tasks/.test(m.text())) pageErrors.push('console: ' + m.text()); });
  page.on('crash', () => { console.log('!!! 页面崩溃（renderer crash）'); });
  page.on('close', () => { console.log('!!! 页面被关闭'); });

  await page.addInitScript((cfg) => {
    localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
    const act = {};
    for (const s of cfg.slots) act[s] = cfg.model.id;
    localStorage.setItem('phymathia_active_models', JSON.stringify(act));
    localStorage.setItem('phymathia_onboarding_done', '1');
    localStorage.setItem('phymathia_guide_seen', '1');
  }, {
    model: { id: 'e2e-model', name: 'E2E mock', provider: 'opencode', model: 'e2e-mock', apiKey: 'e2e', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` },
    slots: ['agent_model', 'html_model', 'descriptor_model', 'quiz_model', 'graph_model', 'branch_model'],
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  await page.waitForTimeout(1000);
  const alive = async (tag) => { if (page.isClosed()) { console.log('!!! 页面已关闭，发生在：' + tag); return false; } return true; };
  const pageText = (sel) => page.$eval(sel, el => el.innerText.replace(/\s+/g, ' ').trim());
  const panelText = () => page.$eval('#taskPanelBody', el => el.innerText.replace(/\s+/g, ' ').trim());
  const panelOpen = () => page.$eval('#taskPanel', el => el.classList.contains('show'));

  // ① 面板：平时就在，点开有内容
  try {
    const btnVisible = await page.isVisible('#taskPanelBtn');
    if (!btnVisible) throw new Error('顶栏三角不可见');
    await page.click('#taskPanelBtn');
    await wait(300);
    if (!(await panelOpen())) throw new Error('点了三角面板没打开');
    const t = await panelText();
    if (!/暂无/.test(t)) throw new Error('空面板文案不对：' + t);  // 314227c 空态文案收敛后渲染「暂无」（T62 同步断言）
    ok('面板：顶栏三角常驻，点开显示空态');
  } catch (e) { bad('面板开关', e); }

  // ② 真发一次提问 → 任务列表长出「工作流 + 节点条目」
  try {
    await page.evaluate(() => { window.startQuestionWorkflow('用一句话说明简谐运动'); });
    let t = '';
    const dl = Date.now() + 30000;
    while (Date.now() < dl) {
      t = await panelText();
      if (/用一句话说明简谐运动/.test(t) && /生成中|等待|完成/.test(t)) break;
      await wait(500);
    }
    if (!/用一句话说明简谐运动/.test(t)) throw new Error('面板里没有这条任务：' + t);
    if (!/进行中/.test(t)) throw new Error('任务状态不是进行中：' + t);
    ok('真发提问：面板立刻出现这条工作流任务（进行中）');
    const label = await page.evaluate(() => {
      const item = document.querySelector('#taskPanelBody .task-item');
      item.querySelector('.task-caret').click();
      return document.querySelector('#taskPanelBody').innerText.replace(/\s+/g, ' ').trim();
    });
    for (const want of ['物理视角', '数学视角', '苏格拉底追问', '进阶学习']) {
      if (!label.includes(want)) throw new Error('节点条目缺 ' + want + '：' + label);
    }
    if (!/已完成|等待|生成中/.test(label)) throw new Error('节点条目没有状态：' + label);
    ok('两级结构：展开后看到 4 个节点条目与各自状态');
  } catch (e) { bad('工作流任务与节点条目', e); }


  // ②b 胶囊上的入口（用户 2026-09-27 要求）：干活时胶囊常驻，列表随手可开
  try {
    const spun = await page.evaluate(() => {
      const el = document.querySelector('#taskPanelBody .task-spin');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { w: cs.width, h: cs.height, anim: cs.animationName, radius: cs.borderRadius };
    });
    if (!spun) throw new Error('进行中的行上没有圆环元素');
    if (spun.w !== spun.h) throw new Error('圆环不是正圆：' + spun.w + 'x' + spun.h);
    if (!/taskSpin/.test(spun.anim)) throw new Error('圆环没有转动动画：' + spun.anim);
    ok('进行中画的是 CSS 圆环（' + spun.w + 'x' + spun.h + '，靠 ' + spun.anim + ' 匀速转），不是 ⟳ 字符');
  } catch (e) { bad('进行中的圆环', e); }

  try {
    await page.click('#taskPanelBtn');           // 先收起（面板此刻是开的）
    await wait(300);
    if (await panelOpen()) throw new Error('再点一次没收起');
    const visible = await page.isVisible('#progressTaskBtn');
    if (!visible) throw new Error('干活时胶囊上找不到入口按钮');
    await page.click('#progressTaskBtn');
    await wait(400);
    if (!(await panelOpen())) throw new Error('点胶囊上的入口没打开面板');
    ok('胶囊上的入口：干活时点它就能展开任务列表');
  } catch (e) { bad('胶囊入口', e); }

  // ③ 停单个节点（面板上那一颗的「停」）
  try {
    const clicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#taskPanelBody .task-node-row')];
      const row = rows.find(r => /生成中/.test(r.textContent)) || rows.find(r => /等待/.test(r.textContent));
      if (!row) return null;
      const btn = row.querySelector('[data-task-action="cancel-node"]');
      if (!btn) return null;
      const label = row.querySelector('.task-node-label').textContent;
      btn.click();
      return label;
    });
    if (!clicked) throw new Error('没有可停的节点按钮（可能已经全跑完了）');
    await wait(800);
    const t = await panelText();
    if (!/已取消/.test(t)) throw new Error('停了节点但面板没有「已取消」：' + t);
    ok('停单个节点：面板上就地变「已取消」（停的是 ' + clicked + '）');
    const blocked = await page.evaluate(() => graphView.nodes.filter(n => n.status === 'blocked').map(n => n.id));
    ok('下游标记：画布上 status=blocked 的节点 ' + blocked.length + ' 颗（' + (blocked.length ? '上游缺失已传播' : '这条链没有下游，属正常') + '）');
  } catch (e) { bad('停单个节点', e); }

  // ④ 排队项 = 一条任务，且可单条取消
  try {
    await page.evaluate(() => { window.startQuestionWorkflow('第二个问题（这条例队）'); });
    await wait(700);
    let t = await panelText();
    if (!/第二个问题/.test(t)) throw new Error('排队那条没进列表：' + t);
    if (!/等待中/.test(t)) throw new Error('排队那条的状态不是等待中：' + t);
    ok('排队中的发送也算任务（等待中）：' + /第二个问题/.test(t));
    const cancelled = await page.evaluate(() => {
      const item = [...document.querySelectorAll('#taskPanelBody .task-item')].find(el => /第二个问题/.test(el.textContent));
      if (!item) return 'no-item';
      const btn = item.querySelector('[data-task-action="cancel"]');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    });
    if (cancelled !== 'clicked') throw new Error('找不到单条取消按钮：' + cancelled);
    await wait(600);
    t = await panelText();
    const stillWaiting = await page.evaluate(() => [...document.querySelectorAll('#taskPanelBody .task-item')]
      .filter(el => /第二个问题/.test(el.textContent) && /等待中/.test(el.textContent)).length);
    if (stillWaiting > 0) throw new Error('取消了但还在等待队列里：' + t);
    ok('单条取消：排队那条从"进行中"区消失（进历史，标已停止）');
  } catch (e) { bad('排队项单条取消', e); }

  // ⑤ 工作流跑着时切会话：任务照跑，列表照看（T59 的场景）
  try {
    const firstSid = await page.evaluate(() => window.getCurrentSessionId());
    await page.evaluate(() => { window.createNewSession(); });
    await wait(900);
    const nowSid = await page.evaluate(() => window.getCurrentSessionId());
    if (nowSid === firstSid) throw new Error('没有切到新会话');
    // 面板此刻是开着的：**别盲点**——那个按钮是开关，再点一下正好把它关了，
    // 后面读到的是上一次渲染的旧内容（第一版就这么误报了一次）
    if (!(await panelOpen())) { await page.click('#taskPanelBtn'); await wait(300); }
    const t = await panelText();
    if (!/用一句话说明简谐运动/.test(t)) throw new Error('切走之后列表里看不到那条任务了：' + t);
    const running = await page.evaluate(() => _taskActive.some(x => x.state === 'running' || x.state === 'partial'));
    ok('跑着时切会话：任务不受影响，列表照看（新会话 ' + nowSid.slice(0, 12) + '…，仍在跑=' + running + '）');
    await page.evaluate((sid) => { window.switchToSession(sid); }, firstSid);
    await wait(1200);
    const backOnCanvas = await page.evaluate(() => {
      const nodes = graphView.nodes.filter(n => ['physics', 'math', 'socratic', 'learn'].includes(n.moduleKey));
      return { n: nodes.length, states: nodes.map(n => n.busy ? 'running' : n.status) };
    });
    if (backOnCanvas.n === 0) throw new Error('切回来画布上没有模块节点了（产出丢了？）');
    ok('切回原画布：产出还在（' + backOnCanvas.n + ' 个模块节点，状态 ' + backOnCanvas.states.join('/') + '）');
  } catch (e) { bad('跑着时切会话', e); }

  // ⑥ 收尾：等任务跑完，进历史
  try {
    const dl = Date.now() + 90000;
    let t = '';
    while (Date.now() < dl) {
      t = await panelText();
      const idle = await page.evaluate(() => _taskUnfinished().every(x => x.state !== 'running' && x.state !== 'waiting'));
      if (idle && /部分完成|已完成|已停止/.test(t)) break;
      await wait(1000);
    }
    if (!/部分完成|已完成|已停止/.test(t)) throw new Error('跑完了但状态没收口：' + t);
    ok('收尾：任务结束后进历史区（' + (t.match(/部分完成|已完成|已停止/) || ['?'])[0] + '）');
    const persisted = await page.evaluate(async () => {
      const r = await fetch('/api/kv/' + encodeURIComponent('tasks:global'));
      const j = await r.json();
      return j && j.value ? { n: (j.value.tasks || []).length, first: (j.value.tasks || [])[0] } : null;
    });
    if (!persisted || !persisted.n) throw new Error('服务端没有 tasks:global 记录');
    ok('落盘：服务端 tasks:global 有 ' + persisted.n + ' 条（含会话号 ' + persisted.first.sessionId + '）');
  } catch (e) { bad('任务收尾与落盘', e); }


  // ⑥b 两个页签 + 一键清除记录（用户 2026-09-27 要求）
  try {
    await page.evaluate(() => { window.startQuestionWorkflow('第三条（要跑完的）'); });
    const dl = Date.now() + 90000;
    let done = false;
    while (Date.now() < dl) {
      done = await page.evaluate(() => window._taskDoneRecords().length > 0);
      if (done) break;
      await wait(1000);
    }
    if (!done) {
      const diag = await page.evaluate(() => ({
        active: _taskActive.map(x => x.title + ':' + x.state),
        history: _taskHistory.map(x => x.title + ':' + x.state),
      }));
      throw new Error('等不到一条干完的任务；账本=' + JSON.stringify(diag));
    }
    const tabs = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('#taskPanelBody .task-tab')];
      const labels = btns.map(b => b.textContent.trim());
      btns.find(b => /已完成/.test(b.textContent)).click();
      return labels;
    });
    await wait(400);
    const doneView = await pageText('#taskPanelBody');
    if (!(await panelOpen())) throw new Error('点了页签面板被关掉了');
    if (!/第三条/.test(doneView)) throw new Error('已完成页签里没有那条跑完的：' + doneView);
    // 按行状态判，别按文本判：会话名会自动取自第一个问题，文本里出现「用一句话说明简谐运动」
    // 是**会话标题**，不是任务行（第一版就这么误报过）
    const statesInDoneTab = await page.evaluate(() => [...document.querySelectorAll('#taskPanelBody .task-item')]
      .map(el => (el.className.match(/state-([a-z]+)/) || [])[1]));
    if (statesInDoneTab.some(st => st !== 'done')) {
      throw new Error('已完成页签里混进了没干成的行：' + statesInDoneTab.join(','));
    }
    ok('两个页签分开：' + tabs.join(' / ') + '，跑完的只在「已完成」');

    const before = await page.evaluate(async () => {
      const r = await fetch('/api/kv/' + encodeURIComponent('tasks:global'));
      const j = await r.json();
      return (j.value.tasks || []).length;
    });
    await page.click('#taskPanelClearDone');
    await wait(1200);
    const after = await page.evaluate(async () => {
      const r = await fetch('/api/kv/' + encodeURIComponent('tasks:global'));
      const j = await r.json();
      const tasks = j.value.tasks || [];
      return { total: tasks.length, done: tasks.filter(t => t.state === 'done').length };
    });
    if (after.done !== 0) throw new Error('清除后服务端还有干完的记录：' + after.done);
    if (after.total >= before) throw new Error('清除没生效：' + before + ' -> ' + after.total);
    const activeView = await page.evaluate(() => {
      document.querySelector('#taskPanelBody .task-tab').click();
      return document.querySelector('#taskPanelBody').innerText.replace(/\s+/g, ' ').trim();
    });
    if (/第三条/.test(activeView)) throw new Error('清除后未完成页签还留着已清的那条');
    ok('一键清除记录：只清干成的（服务端 ' + before + ' -> ' + after.total + ' 条），未完成的不动');
  } catch (e) { bad('两个页签与一键清除', e); }

  // ⑦ 页面无异常
  try {
    if (pageErrors.length) throw new Error(pageErrors.slice(0, 3).join(' | '));
    ok('全程无页面异常（pageerror / 任务相关 console.error）');
  } catch (e) { bad('页面异常', e); }
} catch (e) {
  bad('脚本本身出错', e);
} finally {
  if (browser) await browser.close();
  server.kill('SIGKILL');
  mock.close();
}

const failed = results.filter(r => !r[0]);
console.log('\n真机自测：' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) { console.log('失败明细：'); for (const f of failed) console.log('  - ' + f[1]); }
process.exit(failed.length ? 1 : 0);
