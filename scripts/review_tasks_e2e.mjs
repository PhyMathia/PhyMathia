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

  // ⑥c 面板停整条工作流必须真停（T285）：旧行为是行上「停」只结账（工作流任务行
  // 没绑 canceller，直接落「已停止」），节点在后台继续生成、mock 继续被打。判真停的
  // 尺子是 mock 上游的请求计数——行落账之后观察窗内零新请求才算数，账面动作骗不过它。
  // 开跑前先等 mock 静默 2.5s：上一轮**跑完**的工作流有收尾提取（合法流量），
  // 别让它串进这一拍的基线或观察窗。
  const waitMockQuiet = async () => {
    const dl = Date.now() + 30000;
    let last = mockHits, since = Date.now();
    while (Date.now() < dl) {
      await wait(500);
      if (mockHits !== last) { last = mockHits; since = Date.now(); continue; }
      if (Date.now() - since >= 2500) return;
    }
  };
  try {
    await waitMockQuiet();
    await page.evaluate(() => { window.startQuestionWorkflow('第四条（行上停掉的）'); });
    const rowState = async (tag) => page.evaluate((t) => {
      const item = [...document.querySelectorAll('#taskPanelBody .task-item')]
        .find(el => new RegExp(t).test(el.textContent));
      return item ? (item.className.match(/state-([a-z]+)/) || [])[1] : '';
    }, tag);
    const dl = Date.now() + 30000;
    let st = '';
    while (Date.now() < dl) {
      st = await rowState('第四条');
      if (st === 'running') break;
      await wait(500);
    }
    if (st !== 'running') throw new Error('停前任务行没进进行中：' + st);
    await wait(3000);   // 让分析＋若干模块真发出去（mock 流速 400ms/片）
    if (!(await panelOpen())) { await page.click('#taskPanelBtn'); await wait(300); }
    const hitsBefore = mockHits;
    const clicked = await page.evaluate(() => {
      const item = [...document.querySelectorAll('#taskPanelBody .task-item')]
        .find(el => /第四条/.test(el.textContent));
      if (!item) return 'no-item';
      const btn = item.querySelector('[data-task-action="cancel"]');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    });
    if (clicked !== 'clicked') throw new Error('找不到工作流任务行的停止按钮：' + clicked);
    const dl2 = Date.now() + 30000;
    let settled = '';
    while (Date.now() < dl2) {
      settled = await page.evaluate(() => {
        const h = _taskHistory.find(t => /第四条/.test(t.title));
        return h ? h.state + '|' + h.note : '';
      });
      if (/^stopped\|/.test(settled)) break;
      await wait(500);
    }
    if (settled !== 'stopped|手动停止') throw new Error('行没落「已停止/手动停止」：' + settled);
    await wait(6000);   // 观察窗：后台若还有节点在排/在发，mockHits 必涨
    if (mockHits !== hitsBefore) throw new Error('行上停了但后台还在发请求：' + hitsBefore + ' -> ' + mockHits);
    if (await page.evaluate(() => workflowRunActive)) throw new Error('总闸没收：workflowRunActive 仍为 true');
    ok('行上停整条工作流（T285）：行落已停止/手动停止，停后 6s mock 零新请求（基线 ' + hitsBefore + '），总闸已收');
  } catch (e) { bad('行上停整条工作流（T285）', e); }

  // ⑥d 「全部清空」同闸（T285 的「含全部清空」）：_tasksClearAll 对在跑的也走
  // canceller；清完两本账全空、被掐停的工作流稍后结账找不到活账自然空转（手册口径）。
  try {
    await page.evaluate(() => { window.startQuestionWorkflow('第五条（清空停掉的）'); });
    const dl = Date.now() + 30000;
    let st = '';
    while (Date.now() < dl) {
      st = await page.evaluate(() => {
        const item = [...document.querySelectorAll('#taskPanelBody .task-item')]
          .find(el => /第五条/.test(el.textContent));
        return item ? (item.className.match(/state-([a-z]+)/) || [])[1] : '';
      });
      if (st === 'running') break;
      await wait(500);
    }
    if (st !== 'running') throw new Error('清空前任务行没进进行中：' + st);
    await wait(2500);
    if (!(await panelOpen())) { await page.click('#taskPanelBtn'); await wait(300); }
    const hitsBefore = mockHits;
    const btnState = await page.evaluate(() => {
      const b = document.getElementById('taskPanelClearAll');
      if (!b) return 'no-btn';
      if (b.disabled) return 'disabled';
      b.click();
      return 'clicked';
    });
    if (btnState !== 'clicked') throw new Error('全部清空按钮点不了（' + btnState + '）');
    await wait(800);
    const left = await page.evaluate(() => ({
      active: _taskActive.length,
      hist: _taskHistory.length,
      row: [...document.querySelectorAll('#taskPanelBody .task-item')].filter(el => /第五条/.test(el.textContent)).length,
    }));
    if (left.active || left.hist || left.row) throw new Error('清空后账没清干净：' + JSON.stringify(left));
    await wait(6000);
    if (mockHits !== hitsBefore) throw new Error('清空后后台还在发请求：' + hitsBefore + ' -> ' + mockHits);
    if (await page.evaluate(() => workflowRunActive)) throw new Error('总闸没收：workflowRunActive 仍为 true');
    ok('全部清空真停（T285）：两本账全空、停后 6s mock 零新请求（基线 ' + hitsBefore + '），总闸已收');
  } catch (e) { bad('全部清空停整条工作流（T285）', e); }

  // ⑥e 分析段停止（T299）：问题分析这一段（_generateAnalysis，全程最长的一段）过去
  // 整段在停止伞之外——顶栏停止按钮要等 _executeParallelWorkflow 开工才启用，用户原话
  // 「停止生成按钮似乎失效了」首先就是它。判尺：analysis 已出字时顶栏按钮必须是可点的，
  // 点了之后 analysis 长度冻住、节点落 waiting（只有 AbortError 走这条，跑完是 done），
  // 伞收掉按钮回禁用态。分析段被停时模块还没建、工作流行还没开，面板无行属预期语义。
  try {
    await waitMockQuiet();
    await page.evaluate(() => { window.startQuestionWorkflow('第六条（停分析段）'); });
    const dl = Date.now() + 30000;
    let picked = null;
    while (Date.now() < dl) {
      picked = await page.evaluate(() => {
        const n = graphView.nodes.find(x => x.kind === 'answer' && x.busy && (x.analysis || '').length > 0);
        return n ? { id: n.id, len: n.analysis.length, stopDisabled: document.getElementById('stopBtn').disabled } : null;
      });
      if (picked) break;
      await wait(400);
    }
    if (!picked) throw new Error('等不到 analysis 流式出字——工作流没跑起来');
    if (picked.stopDisabled !== false) throw new Error('分析跑着顶栏停止按钮却是禁用态：用户点不到（伞没撑到分析段）');
    const nodeId = picked.id;
    const hitsBefore = mockHits;
    await page.evaluate(() => { document.getElementById('stopBtn').click(); });
    const dl2 = Date.now() + 20000;
    let st = '';
    while (Date.now() < dl2) {
      st = await page.evaluate((id) => {
        const n = graphView.nodes.find(x => String(x.id) === String(id));
        return n ? n.status + '|' + (n.analysis || '').length : 'gone';
      }, nodeId);
      if (st !== 'running' && st !== 'gone') break;
      await wait(300);
    }
    if (!/^waiting\|/.test(st)) throw new Error('点了顶栏停止，在跑的 analysis 没被掐断（落 ' + st + '，跑完才是 done）');
    const frozenLen = Number(st.split('|')[1]);
    await wait(3000);   // 流若还活着，3s 按 400ms/片至少再吐 7 片≈70 字
    const afterLen = await page.evaluate((id) => {
      const n = graphView.nodes.find(x => String(x.id) === String(id));
      return n ? (n.analysis || '').length : -1;
    }, nodeId);
    if (afterLen !== frozenLen) throw new Error('停止后 analysis 还在长：被停的流没断（' + frozenLen + ' -> ' + afterLen + '）');
    if (!(await panelOpen())) { await page.click('#taskPanelBtn'); await wait(300); }
    const umb = await page.evaluate(() => ({
      stopDisabled: document.getElementById('stopBtn').disabled,
      runActive: workflowRunActive,
      reg: workflowInFlightControllers.size,
      row: [...document.querySelectorAll('#taskPanelBody .task-item')].filter(el => /第六条/.test(el.textContent)).length,
    }));
    if (umb.stopDisabled !== true) throw new Error('停完伞没收：顶栏停止按钮还亮着（没有在跑的活儿了）');
    if (umb.runActive) throw new Error('停完 busy 标志没收：workflowRunActive 仍为 true');
    if (umb.reg !== 0) throw new Error('在跑登记簿没收干净：剩 ' + umb.reg + ' 颗');
    if (umb.row !== 0) throw new Error('分析段被停不该留下工作流行（模块还没建、行还没开），实际 ' + umb.row + ' 行');
    await wait(4000);   // 观察窗：总闸真收了才零新请求
    if (mockHits !== hitsBefore) throw new Error('停了但后台还在发请求：' + hitsBefore + ' -> ' + mockHits);
    ok('分析段可停（T299）：按钮可点、analysis 冻在 ' + frozenLen + ' 字、节点落 waiting、伞收起、停后 4s mock 零新请求');
  } catch (e) { bad('分析段可停（T299）', e); }

  // ⑥f 模块段在跑流（T299 的另一半）：总闸过去只断 workflowAbortController，正在流的
  // 节点各拿自己的 controller，各自跑完才收工。判尺同 ⑥e，但这趟行真的开了（分析跑完、
  // 模块开工），停完必须落「已停止/手动停止」，抓到的那颗 busy 模块必须落 waiting 且
  // 正文冻住——不是 done（自己跑完的）。
  try {
    await waitMockQuiet();
    await page.evaluate(() => { window.startQuestionWorkflow('第七条（停模块段）'); });
    if (!(await panelOpen())) { await page.click('#taskPanelBtn'); await wait(300); }
    const dl = Date.now() + 40000;
    let picked = null;
    while (Date.now() < dl) {
      picked = await page.evaluate(() => {
        const item = [...document.querySelectorAll('#taskPanelBody .task-item')]
          .find(el => /第七条/.test(el.textContent));
        const running = item ? /state-running/.test(item.className) : false;
        const n = graphView.nodes.find(x => x.kind === 'module' && x.busy && (x.content || '').length > 0);
        return (running && n)
          ? { id: n.id, len: n.content.length, stopDisabled: document.getElementById('stopBtn').disabled }
          : null;
      });
      if (picked) break;
      await wait(400);
    }
    if (!picked) throw new Error('等不到模块开工（行 running + 模块流式出字）');
    if (picked.stopDisabled !== false) throw new Error('模块跑着顶栏停止按钮却是禁用态');
    const nodeId = picked.id;
    const hitsBefore = mockHits;
    await page.evaluate(() => { document.getElementById('stopBtn').click(); });
    const dl2 = Date.now() + 25000;
    let st = '';
    while (Date.now() < dl2) {
      st = await page.evaluate((id) => {
        const n = graphView.nodes.find(x => String(x.id) === String(id));
        return n ? n.status + '|' + (n.content || '').length : 'gone';
      }, nodeId);
      if (st !== 'running' && st !== 'gone') break;
      await wait(300);
    }
    if (!/^waiting\|/.test(st)) throw new Error('点了顶栏停止，在跑的模块流没被掐断（落 ' + st + '，跑完才是 done）');
    const frozenLen = Number(st.split('|')[1]);
    await wait(3000);
    const afterLen = await page.evaluate((id) => {
      const n = graphView.nodes.find(x => String(x.id) === String(id));
      return n ? (n.content || '').length : -1;
    }, nodeId);
    if (afterLen !== frozenLen) throw new Error('停止后模块正文还在长：被停的流没断（' + frozenLen + ' -> ' + afterLen + '）');
    const dl3 = Date.now() + 20000;
    let settled = '';
    while (Date.now() < dl3) {
      settled = await page.evaluate(() => {
        const h = _taskHistory.find(t => /第七条/.test(t.title));
        return h ? h.state + '|' + h.note : '';
      });
      if (/^stopped\|/.test(settled)) break;
      await wait(300);
    }
    if (settled !== 'stopped|手动停止') throw new Error('行没落「已停止/手动停止」：' + settled);
    await wait(4000);   // 观察窗
    if (mockHits !== hitsBefore) throw new Error('停了但后台还在发请求：' + hitsBefore + ' -> ' + mockHits);
    if (await page.evaluate(() => workflowRunActive)) throw new Error('总闸没收：workflowRunActive 仍为 true');
    const leftReg = await page.evaluate(() => workflowInFlightControllers.size);
    if (leftReg !== 0) throw new Error('在跑登记簿没收干净：剩 ' + leftReg + ' 颗（泄漏会让之后的总闸 abort 到旧 controller）');
    ok('模块段在跑流可停（T299）：正文冻在 ' + frozenLen + ' 字、节点落 waiting、行落已停止/手动停止、停后 4s mock 零新请求、登记簿清零');
  } catch (e) { bad('模块段在跑流可停（T299）', e); }


  // ⑦ 忙的时候点节点生成 = 排队（2026-10-11；用户：「设置了任务列表就是想要可以排队」）
  // 旧行为是 toast 挡回去「稍候再单独生成这个节点」——点了等于没点，也没有账。
  try {
    await page.evaluate(async () => {
      if (typeof _clearSendQueue === 'function') _clearSendQueue('');
      // 等干净：没有在跑的活儿、没有在写的流
      const dl = Date.now() + 60000;
      while (Date.now() < dl && (isStreaming || workflowRunActive )) await new Promise(r => setTimeout(r, 500));
    });
    const picked = await page.evaluate(() => {
      const node = graphView.nodes.find(n => n.messageIndex < 0 && n.kind === 'module' && !n.busy);
      if (!node) return null;
      const label = (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
      // 「别处正忙」这个位真机上由工作流/流式回答持有；这里直接摆位，省得赌时序。
      // 摆的是同一个词法绑定，走的是同一条守卫（_isSendBusy → _enqueueNodeJob）。
      workflowRunActive = true;
      window.runWorkflowNode(node.id, true);
      return { id: node.id, label: label, sid: window.getCurrentSessionId() };
    });
    if (!picked) throw new Error('画布上找不到可单独生成的模块节点');
    const st = await page.evaluate(() => ({
      n: _sendQueue.length,
      pending: _hasPendingSend(),
      running: _taskActive.filter(t => t.state === 'running').length,
      rows: _taskActive.map(t => t.title + '|' + t.state + '|' + t.sessionId),
    }));
    if (!st.pending || st.n !== 1) throw new Error('忙时点生成没有进队列（又被拒绝了）：' + JSON.stringify(st));
    if (st.running !== 0) throw new Error('排队的那条不该当场开跑：' + JSON.stringify(st));
    if (!st.rows.some(r => r.indexOf(picked.label) >= 0 && r.indexOf('waiting') >= 0)) {
      throw new Error('任务列表里没有「等待中」的那条：' + JSON.stringify(st.rows));
    }
    if (!st.rows.some(r => r.indexOf(picked.sid) >= 0)) {
      throw new Error('排队那条没记下它属于哪张画布（自带来处）：' + JSON.stringify(st.rows));
    }
    if (!(await panelOpen())) { await page.click('#taskPanelBtn'); }
    await wait(600);   // 面板是 120ms 防抖重渲染的，读早了看到的是上一版内容
    const queuedView = await panelText();
    if (!queuedView.includes(picked.label) || !/等待中/.test(queuedView)) {
      throw new Error('面板上看不到排队的那条：' + queuedView);
    }
    ok('忙时点节点生成 → 收进队列（' + picked.label + ' · 等待中 · 记在它自己那张画布上）');

    // 放行：忙位一撤，队列把它跑起来，节点上出内容
    await page.evaluate(() => { workflowRunActive = false; _flushSendQueue(); });
    const dl = Date.now() + 120000;
    let got = '';
    while (Date.now() < dl) {
      got = await page.evaluate((id) => {
        const node = graphView.nodes.find(n => n.id === id);
        return node && node.content ? String(node.content) : '';
      }, picked.id);
      if (got.trim().length > 20) break;
      await wait(1000);
    }
    if (got.trim().length <= 20) throw new Error('放行之后排队的节点生成没跑起来（内容仍为空）');
    const hist = await page.evaluate(() => _taskHistory.filter(t => t.kind === 'workflow')
      .map(t => t.title + '|' + t.state).slice(0, 3));
    ok('放行：队列自己把它跑完（节点出内容 ' + got.trim().length + ' 字，历史 ' + hist.join(' / ') + '）');
  } catch (e) { bad('忙时排队（节点生成）', e); }

  // ⑦b 排队跨画布：在 A 排的节点活儿，人切到新画布之后轮到自己时把视图带回 A（自带来处）
  try {
    await page.evaluate(async () => {
      if (typeof _clearSendQueue === 'function') _clearSendQueue('');
      const dl = Date.now() + 60000;
      while (Date.now() < dl && (isStreaming || workflowRunActive)) await new Promise(r => setTimeout(r, 500));
    });
    const setup = await page.evaluate(() => {
      const node = graphView.nodes.find(n => n.messageIndex < 0 && n.kind === 'module' && !n.busy);
      if (!node) return null;
      const sidA = window.getCurrentSessionId();
      workflowRunActive = true;                       // 摆上「别处正忙」
      window.runWorkflowNode(node.id, true);
      return { id: node.id, sidA: sidA, queued: _hasPendingSend() };
    });
    if (!setup) throw new Error('画布上找不到可单独生成的模块节点');
    if (!setup.queued) throw new Error('忙时点生成没有进队列');
    const went = await page.evaluate(async (sidA) => {
      window.createNewSession();
      const dl = Date.now() + 15000;
      while (Date.now() < dl) {
        await new Promise(r => setTimeout(r, 200));
        const sid = window.getCurrentSessionId();
        if (sid && sid !== sidA) return sid;
      }
      return window.getCurrentSessionId();
    }, setup.sidA);
    if (went === setup.sidA) throw new Error('没能切到新画布');
    // 放行：排队的活儿应当自己把视图带回 A 再跑
    await page.evaluate(() => { workflowRunActive = false; _flushSendQueue(); });
    const dl = Date.now() + 120000;
    let back = '';
    while (Date.now() < dl) {
      back = await page.evaluate(() => window.getCurrentSessionId());
      if (back === setup.sidA) break;
      await wait(500);
    }
    if (back !== setup.sidA) throw new Error('轮到时没有切回它所属的画布：现在在 ' + String(back).slice(0, 12));
    let content = '';
    const dl2 = Date.now() + 120000;
    while (Date.now() < dl2) {
      content = await page.evaluate((id) => {
        const node = graphView.nodes.find(n => n.id === id);
        return node && node.content ? String(node.content) : '';
      }, setup.id);
      if (content.trim().length > 20) break;
      await wait(1000);
    }
    if (content.trim().length <= 20) throw new Error('切回原画布后那条活儿没跑出内容');
    ok('排队跨画布：在 A 排的活儿，人切走后轮到自己把视图带回 A 并跑完（' + content.trim().length + ' 字）');
  } catch (e) { bad('排队跨画布', e); }

  // ⑧ 流式回答进行中切画布：切得过去，回答写回原来那张（用户报的核心症状）
  // 旧行为：switchToSession 头一行 `if (isStreaming) return;` —— 点侧栏毫无反应（静默）。
  try {
    const started = await page.evaluate(async () => {
      const dl = Date.now() + 60000;
      while (Date.now() < dl && (isStreaming || workflowRunActive)) await new Promise(r => setTimeout(r, 500));
      // 锚点只要一颗画布上的节点即可（工作流建的模块节点是自定义节点，messageIndex=-1，
      // 所以不能只挑消息节点——buildGraphPathForAnchor 认不出父节点时会给个占位路径）
      const anchorNode = graphView.nodes.find(n => n.kind === 'module') || graphView.nodes[0];
      if (!anchorNode) return null;
      const sidA = window.getCurrentSessionId();
      window.sendBranchQuick('追问测试：简谐运动的周期由什么决定？', {
        parentId: String(anchorNode.timestamp || ''),
        sourceModule: anchorNode.moduleKey || '',
        branchType: 'branch',
        branchId: '',
        branchLabel: '追问测试',
      });
      return { sidA: sidA };
    });
    if (!started) throw new Error('画布上没有消息节点，造不出追问锚点');
    await page.waitForFunction(() => isStreaming === true, null, { timeout: 30000 });
    const switched = await page.evaluate(async (sidA) => {
      window.createNewSession();          // 用户点侧栏「新建画布」走的就是这一条
      const dl = Date.now() + 15000;
      while (Date.now() < dl) {
        await new Promise(r => setTimeout(r, 200));
        if (!isStreaming) break;          // 生成已经结束了，这条用例就失去意义
        const sid = window.getCurrentSessionId();
        if (sid && sid !== sidA) return sid;
      }
      return window.getCurrentSessionId();
    }, started.sidA);
    if (!switched || switched === started.sidA) throw new Error('生成中没能切到新画布（切画布被拦了）');
    const phantom = await page.evaluate(() => _getChatHistory().length);
    if (phantom !== 0) throw new Error('新画布上冒出了别处那条正在写的回答（幽灵节点）：' + phantom + ' 条');
    ok('生成中切画布：切得过去（' + String(started.sidA).slice(0, 12) + '… → ' + String(switched).slice(0, 12) + '…），新画布干净');

    await page.waitForFunction(() => isStreaming === false, null, { timeout: 180000 });
    await wait(1500);
    const stored = await page.evaluate(async (sid) => {
      const r = await fetch('/api/sessions/' + sid + '/messages', { cache: 'no-cache' });
      const j = await r.json();
      const msgs = Array.isArray(j) ? j : (j.messages || []);
      return msgs.map(m => m.role + ':' + String(m.content || '').slice(0, 12));
    }, started.sidA);
    const answerBack = stored.filter(m => m.startsWith('assistant:')).length;
    if (!answerBack) throw new Error('切走之后那条回答没写回原画布（消息：' + JSON.stringify(stored) + '）');
    const sendTask = await page.evaluate(() => _taskHistory.filter(t => t.kind === 'send')
      .map(t => t.state + '|' + t.sessionId).slice(0, 3));
    ok('切走之后回答照样落回原画布（' + answerBack + ' 条 assistant；发送任务 ' + sendTask.join(' / ') + '）');

    await page.evaluate((sid) => window.switchToSession(sid), started.sidA);
    await wait(2000);
    const back = await page.evaluate(() => {
      const nodes = graphView.nodes.filter(n => n.messageIndex >= 0 && n.branchType === 'branch');
      return { n: nodes.length, hasText: nodes.some(n => /追问|周期|回复力|正文/.test(String(n.content || ''))) };
    });
    if (!back.n) throw new Error('切回原画布看不到那条追问的产出（节点没了）');
    ok('切回原画布：产出在（' + back.n + ' 个追问节点，带正文=' + back.hasText + '）');
  } catch (e) { bad('生成中切画布', e); }

  // ⑨ 页面无异常
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
