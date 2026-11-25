#!/usr/bin/env node
// 撤假成果真机验证（2026-11-25 用户拍板）：viz 走后台通道后，工作流任务行不再在
// run 收尾那一拍写 done（旧行为实测 216ms「完成」、可视化颗粒无收——2026-11-25 夜
// 齿轮节点六连败全被这块假「完成」盖住）。行等最后一个条目经 onSettle 落地再聚合
// 结账。验四件静态契约验不了的事：
//   ① run 收尾时工作流行还是「进行中」、条目 running——不再当场 done
//   ② viz 成品落地：行聚合 done、补发「工作流完成」通知、viz-bg 行 done
//   ③ viz 失败（上游不吐 HTML）：行聚合 error「有节点未生成成功」
//   ④ defer 期间行的「停止」真能停：行内 viz 被取消、行结 stopped「已取消」
// 跑法：node scripts/verify_viz_row_defer.mjs（约 30s；临时实例用完即杀，不碰 data/）
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const APP_PORT = 5088;   // 避开 5050/5051/5060/5061/5087 与其它脚本常量口
const MOCK_PORT = 5098;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let hits = 0;
let mockMode = 'html';   // 'html'＝吐完整小页面；'text'＝只吐纯文字（逼失败+自动重试）
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  for await (const _ of req) { /* drain */ }
  hits++;
  const body = mockMode === 'html'
    ? '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><title>齿轮啮合参数演示 ' + hits + '</title></head><body><h1>渐开线齿轮啮合交互演示</h1><p>拖动滑块改变模数与齿数，观察基圆、节圆与啮合线的变化；中心距改变时传动比保持不变，这就是渐开线齿廓的可分性。</p><button id="run">运行</button><script>document.getElementById("run").onclick=function(){document.querySelector("p").style.color="teal"};</script></body></html>'
    : '这对齿轮的齿廓啮合满足齿廓啮合基本定律，传动比恒定，但没有按要求的格式输出 HTML 页面。';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const piece of body.match(/[\s\S]{1,24}/g) || []) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    await wait(120);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const srv = await startIsolatedServer({ port: APP_PORT, label: 'phymathia-vizrow' });
process.on('exit', () => srv.stop());

const results = [];
const ok = (n) => { results.push([true, n]); console.log('✓ ' + n); };
const bad = (n, e) => { results.push([false, n + ' —— ' + ((e && e.message) || e)]); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

const browser = await chromium.launch({ headless: true });
const probeLogs = [];
try {
  const page = await browser.newPage();
  page.on('console', msg => {
    const t = String(msg.text() || '');
    if (t.indexOf('[570]') >= 0 || t.indexOf('Viz module') >= 0 || t.indexOf('AI 流式') >= 0) probeLogs.push(t.slice(0, 220));
  });
  // 开跑前种模型（与 review_tasks_e2e.mjs 同款）：html 槽回落主模型即可
  await page.addInitScript((cfg) => {
    try {
      localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
      const act = {};
      for (const s of cfg.slots) act[s] = cfg.model.id;
      localStorage.setItem('phymathia_active_models', JSON.stringify(act));
      localStorage.setItem('phymathia_onboarding_done', '1');
      localStorage.setItem('phymathia_guide_seen', '1');
      localStorage.setItem('phymathia_570_probe', '1');   // 结算链插桩：内容丢在哪一拍当场交代
    } catch (e) { /* 沙盒没有 localStorage：不种也不算异常 */ }
  }, {
    model: { id: 'defer-model', name: 'Defer mock', provider: 'opencode', model: 'defer-mock', apiKey: 'defer', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` },
    slots: ['agent_model', 'html_model', 'graph_model', 'branch_model'],
  });
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window._executeParallelWorkflow === 'function', null, { timeout: 20000 });
  await wait(800);

  const seedViz = (id) => page.evaluate((nid) => {
    const node = {
      id: nid, kind: 'module', moduleKey: 'viz', timestamp: Date.now(),
      messageIndex: -1,   // 自定义节点标记：_saveCustomNodes 只收 messageIndex<0 的
      content: '', busy: false, status: 'waiting',
    };
    graphView.nodes.push(node);
    graphView.nodeById[nid] = node;   // _findGraphNode 认的是这张索引表
    _saveCustomNodes();               // 收尾寻址/流式落盘都认 KV 里的 customNodes
    return _findGraphNode(nid) ? nid : null;
  }, id);

  const runViz = (id) => page.evaluate(async (nid) => {
    window.__notifyCount = 0;
    window.notifyTaskCompleted = function () { window.__notifyCount++; };
    await _executeParallelWorkflow([nid], false, { title: '生成交互可视化' });
    const row = _taskActive.find(t => t.kind === 'workflow' && t.nodes.some(n => n.id === nid));
    return {
      rowState: row ? row.state : null,
      entryState: row && Array.isArray(row.nodes) && row.nodes[0] ? row.nodes[0].state : null,
      bgRowRunning: !!_taskActive.find(t => t.kind === 'viz-bg' && t.nodes.some(n => n.id === nid)),
      notify: window.__notifyCount,
    };
  }, id);

  const waitRowDone = (id, timeout) => page.waitForFunction((nid) => {
    return !_taskActive.some(t => (t.kind === 'workflow' || t.kind === 'viz-bg')
      && t.nodes.some(n => n.id === nid));
  }, id, { timeout }).then(() => true).catch(() => false);

  const rowOf = (id, kind) => page.evaluate(({ nid, kind: k }) => {
    const row = _taskHistory.find(t => (!k || t.kind === k) && t.nodes && t.nodes.some(n => n.id === nid));
    return row ? { state: row.state, note: row.note } : null;
  }, { nid: id, kind });

  // ①② 成功路：run 收尾行不结账（旧行为这里是 done＝假成果），成品落地后聚合 done＋补通知
  try {
    mockMode = 'html';
    await seedViz('vizdef-a');
    const r1 = await runViz('vizdef-a');
    if (r1.rowState === 'running' && r1.entryState === 'running' && r1.bgRowRunning && r1.notify === 0) {
      ok('① run 收尾行保持「进行中」、条目 running、不发完成通知（不再秒报 done）');
    } else {
      bad('① run 收尾行状态', JSON.stringify(r1));
    }
    if (!(await waitRowDone('vizdef-a', 20000))) throw new Error('20s 内两行都没落地');
    const r2 = await page.evaluate(async (nid) => {
      const h = _taskHistory.find(t => t.kind === 'workflow' && t.nodes && t.nodes.some(n => n.id === nid));
      const bg = _taskHistory.find(t => t.kind === 'viz-bg' && t.nodes && t.nodes.some(n => n.id === nid));
      const node = _findGraphNode(nid) || {};
      return { state: h ? h.state : null, note: h ? h.note : null, bgState: bg ? bg.state : null,
               notify: window.__notifyCount, nodeStatus: node.status, clen: String(node.content || '').length };
    }, 'vizdef-a');
    if (r2.state === 'done' && r2.note === '' && r2.bgState === 'done' && r2.notify >= 1
        && r2.nodeStatus === 'done' && r2.clen > 100) {
      ok('② 成品落地：行聚合 done＋补「工作流完成」通知、viz-bg 行 done、节点真有货');
    } else {
      bad('② 成品落地聚合结算', JSON.stringify(r2));
    }
  } catch (e) { bad('成功路（①②）', e); }

  // ③ 失败路：上游只吐纯文字（自动重试一次后仍无 HTML）→ 行聚合 error
  try {
    mockMode = 'text';
    await seedViz('vizdef-b');
    await runViz('vizdef-b');
    if (!(await waitRowDone('vizdef-b', 40000))) throw new Error('40s 内失败路没落地（自动重试未收口？）');
    const r3 = await rowOf('vizdef-b', 'workflow');
    if (r3 && r3.state === 'error' && r3.note === '有节点未生成成功') {
      ok('③ 失败落地：行聚合 error「有节点未生成成功」（不再报完成）');
    } else {
      bad('③ 失败落地聚合结算', JSON.stringify(r3));
    }
  } catch (e) { bad('失败路（③）', e); }

  // ④ defer 期间行「停止」真能停：行内 viz 被取消、行结 stopped「已取消」
  try {
    mockMode = 'html';
    await seedViz('vizdef-c');
    await runViz('vizdef-c');
    await wait(500); // 让后台 viz 进流式中段
    const stopped = await page.evaluate(() => {
      const row = _taskActive.find(t => t.kind === 'workflow' && t.nodes.some(n => n.id === 'vizdef-c'));
      if (!row) return { err: 'defer 期间找不到 running 行' };
      if (typeof row.canceller !== 'function') return { err: '行没有 canceller' };
      row.canceller();
      return { ok: true };
    });
    if (!stopped || stopped.err) throw new Error(stopped ? stopped.err : 'canceller 调用失败');
    if (!(await waitRowDone('vizdef-c', 10000))) throw new Error('10s 内停止路没落地');
    const r4 = await rowOf('vizdef-c', 'workflow');
    const jobs = await page.evaluate(() => ({ jobs: vizBgActiveCount(), busy: !!(_findGraphNode('vizdef-c') || {}).busy }));
    if (r4 && r4.state === 'stopped' && r4.note === '已取消' && jobs.jobs === 0 && !jobs.busy) {
      ok('④ defer 期间行停止：viz 取干净（名额 0、节点摘忙）、行结 stopped「已取消」');
    } else {
      bad('④ 停止路聚合结算', JSON.stringify({ r4, jobs }));
    }
  } catch (e) { bad('停止路（④）', e); }
} finally {
  await browser.close();
  srv.stop();
  mock.close();
}

const failed = results.filter(r => !r[0]);
if (failed.length && probeLogs.length) console.log('—— 结算链插桩尾 ——\n' + probeLogs.slice(-14).join('\n'));
console.log('\n—— verify_viz_row_defer：' + (results.length - failed.length) + '/' + results.length + ' ✓ ——');
process.exit(failed.length ? 1 : 0);
