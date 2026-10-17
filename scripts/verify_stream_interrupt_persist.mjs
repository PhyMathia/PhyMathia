// 真机验证（T359 流式中途断流）：node scripts/verify_stream_interrupt_persist.mjs（约 40 秒，
// 自带临时数据目录与挂死上游，用完即杀不碰 data/）。一条命令跑完全部用例，失败打印服务端日志尾。
// 场景：真浏览器 + 真服务端 + 临时数据目录，
// 上游「吐几片就挂住不断连」，看两件事：
//   ① 屏幕上已经出现的字在流还没收尾时就已落盘（module 路的 400ms 周期落盘）；
//   ② 看门狗到点后不是丢内容，而是把收到的半成品按「未跑完」入账（状态失败、内容留着）。
// 看门狗 120s 对测试太长：用 addInitScript 把 ≥120s 的定时器提前到 3s（只改测试环境）。
import { fileURLToPath } from 'node:url';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const APP_PORT = 5084;
const MOCK_PORT = 5085;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = n => { results.push(true); console.log('✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

// ---- 挂死上游：第 1 次请求（问题分析）正常收尾；之后每次吐 3 片就挂住不断连 ----
let chatSeen = 0;
const prompts = [];
const mock = createServer((req, res) => {
  if (req.url === '/__stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ chatSeen })); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    chatSeen++;
    let promptText = '';
    try {
      const parsed = JSON.parse(body);
      promptText = (parsed.messages || []).map(m => String(m.content || '')).join('\n');
    } catch (e) { promptText = String(body); }
    prompts.push({ n: chatSeen, head: promptText.slice(0, 90).replace(/\s+/g, ' ') });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = (text) => res.write('data: ' + JSON.stringify({ id: 'm' + chatSeen, choices: [{ delta: { content: text } }] }) + '\n\n');
    if (/请分析用户问题|问题概要/.test(promptText)) {
      // 问题分析：正常一段（带建议模块行，才会长出模块节点）并收尾
      chunk('分析：简谐运动的核心是回复力与位移成正比。建议模块：物理视角、数学视角\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    // 模块正文：吐三片（屏幕可见）后挂住——不收尾、不断连
    chunk('第一段：');
    chunk('屏幕上已经出现的内容');
    chunk('，上游到这里就不再发帧、也不结束连接。');
    // 故意不 end()：模拟「字出完了但连接不断」的挂死
  });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const workDir = mkdtempSync(join(tmpdir(), 'phymathia-t359-'));
cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
const server = spawn('python3', ['src/main.py', '-p', String(APP_PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', d => { serverLog += d; });
server.stderr.on('data', d => { serverLog += d; });
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(BASE + '/health')).ok) break; } catch (e) { /* 等启动 */ }
  await wait(500);
}

let snapshot = null;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const pageErrors = [];
page.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));

try {
  await page.addInitScript((cfg) => {
    localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
    localStorage.setItem('phymathia_active_models', JSON.stringify({
      agent_model: cfg.model.id, html_model: cfg.model.id, descriptor_model: cfg.model.id,
      quiz_model: cfg.model.id, graph_model: cfg.model.id, branch_model: cfg.model.id,
    }));
    localStorage.setItem('phymathia_onboarding_done', '1');
    localStorage.setItem('phymathia_guide_seen', '1');
    // 看门狗 120s → 3s（只为把真机上等不到的超时压进测试时长；逻辑一行不改）
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = function (fn, ms, ...rest) {
      if (typeof ms === 'number' && ms >= 120000) ms = 6000;
      return realSetTimeout(fn, ms, ...rest);
    };
  }, { model: { id: 'mock-hang', name: 'mock', provider: 'opencode', model: 'mock-1', apiKey: 'x', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` } });

  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  await wait(1200);
  // 不 await：startQuestionWorkflow 会把整条工作流跑完才 resolve，等它就错过了
  // 「正在生成中」这个窗口（①要的正是那一拍）
  await page.evaluate(() => { window.startQuestionWorkflow('用一句话说明简谐运动'); });

  const sid = await page.evaluate(() => window.getCurrentSessionId());
  const kvPath = join(workDir, 'data', 'users', 'default', 'kv', sid + '.json');
  const diskNode = (nodeId) => {
    try {
      const raw = JSON.parse(readFileSync(kvPath, 'utf8'))['graph:' + sid];
      const n = (raw && raw.customNodes || []).find(x => x.id === nodeId);
      return n ? n.content || '' : '';
    } catch (e) { return ''; }
  };

  // —— ① 流还没收尾时，屏幕上的字必须已经在盘上 ——
  let midNodeId = null;
  let midContent = '';
  let diskMid = '';
  const midDeadline = Date.now() + 25000;
  while (Date.now() < midDeadline && !midNodeId) {
    const live = await page.evaluate(() => {
      const n = graphView.nodes.find(x => x.kind === 'module' && (x.content || '').trim() && x.busy);
      return n ? { id: n.id, content: n.content } : null;
    });
    if (live) {
      await wait(800);   // 等过 400ms 落盘防抖
      const onDisk = diskNode(live.id);
      const stillLive = await page.evaluate((nid) => {
        const n = graphView.nodes.find(x => x.id === nid);
        return n ? { busy: !!n.busy, len: (n.content || '').length } : null;
      }, live.id);
      // 落盘那一拍这颗节点还得在生成中（收尾后的保存不算「周期落盘」）
      if (onDisk && onDisk.trim() && stillLive && stillLive.busy) {
        midNodeId = live.id; midContent = live.content; diskMid = onDisk;
      }
    }
    if (!midNodeId) await wait(150);
  }
  if (midNodeId) ok('① 流未收尾时内容已落盘：' + midNodeId + '（屏上 ' + midContent.length + ' 字 / 盘上 ' + diskMid.length + ' 字）');
  else bad('① 流中周期落盘', new Error('25s 内没等到「有内容且仍在生成中」的节点落盘'));

  // —— ② 看门狗到点：半成品留着、状态失败 ——
  let settled = null;
  const dl2 = Date.now() + 30000;
  while (Date.now() < dl2 && !settled) {
    settled = await page.evaluate((nid) => {
      const pool = graphView.nodes.filter(x => x.kind === 'module' && (x.content || '').trim());
      const n = (nid && graphView.nodes.find(x => x.id === nid)) || pool.find(x => !x.busy);
      if (!n || n.busy) return null;
      return { id: n.id, content: n.content || '', status: n.status, versions: (n.versions || []).length };
    }, midNodeId);
    if (!settled) await wait(400);
  }
  if (!settled) bad('② 看门狗到点', new Error('30s 内节点仍停在生成中（看门狗没生效）'));
  else {
    if (settled.content.trim()) ok('② 看门狗掐断后内容仍在（' + settled.content.length + ' 字）');
    else bad('② 半成品保留', new Error('内容被清空了'));
    if (settled.status === 'error') ok('② 状态标失败（这次生成没跑完，可重跑）');
    else bad('② 状态口径', new Error('status=' + settled.status));
    if (settled.versions >= 1) ok('② 半成品已入版本账（' + settled.versions + ' 版，‹› 可回）');
    else bad('② 入账', new Error('versions=' + settled.versions));
    const after = diskNode(settled.id);
    if (after.trim()) ok('② 收尾后盘上仍有内容（' + after.length + ' 字）');
    else bad('② 收尾落盘', new Error('盘上为空'));
    // 跨「换设备」：另开一个干净上下文读服务端，看到的应当还是这份内容
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    const seen = await page2.evaluate(async (args) => {
      const r = await fetch('/api/kv/' + encodeURIComponent('graph:' + args.sid));
      const j = await r.json();
      const n = (j.value && j.value.customNodes || []).find(x => x.id === args.id);
      return n ? (n.content || '') : '';
    }, { sid, id: settled.id });
    await ctx2.close();
    if (seen.trim() === settled.content.trim()) ok('② 「换设备」读回的是屏幕上那一版（' + seen.length + ' 字）');
    else bad('② 换设备读回', new Error('读到 ' + seen.length + ' 字，屏上 ' + settled.content.length + ' 字'));
  }
} catch (e) {
  bad('真机流程异常', e);
} finally {
  try {
    snapshot = await page.evaluate(() => (typeof graphView !== 'undefined' ? graphView.nodes : []).map(n => ({ kind: n.kind, mk: n.moduleKey, busy: !!n.busy, st: n.status, len: (n.content || '').length })));
  } catch (e) { snapshot = 'dump failed: ' + ((e && e.message) || e); }
  await browser.close();
  server.kill();
  mock.close();
}

if (pageErrors.length) console.log('页面 JS 错误：' + pageErrors.slice(0, 3).join(' | '));
if (!results.every(Boolean)) {
  console.log('mock 请求数：' + chatSeen);
  console.log('mock 请求：' + JSON.stringify(prompts.slice(0, 10), null, 1));
  console.log('画布节点：' + JSON.stringify(snapshot));
}
console.log(results.every(Boolean) ? '\nT359 真机验证全部通过' : '\nT359 真机验证失败');
if (!results.every(Boolean)) console.log(serverLog.slice(-2500));
process.exit(results.every(Boolean) ? 0 : 1);
