#!/usr/bin/env node
// viz 后台通道真机验证（2026-11-22，backlog 504 子集）：mock 上游 + 临时数据目录 +
// 真实浏览器页面。验三件静态契约验不了的事：
//   ① viz 后台发射后 _isActuallyBusy() 仍为 false（队列能立刻放行下一条）
//   ② viz 后台任务行出现且标题带「（后台）」，独立 controller/停止不碰前台闸
//   ③ 刷新后 viz-bg 行被 484 收编认领（genTaskId 落盘 → 暂缓登记 → 翻回）
// 跑法：node scripts/verify_viz_background.mjs（约 30s；临时实例用完即杀，不碰 data/）
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const APP_PORT = 5087;   // 避开 5050/5051/5060/5061 与其它脚本常量口
const MOCK_PORT = 5097;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let hits = 0;
const mock = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  for await (const _ of req) { /* drain */ }
  hits++;
  const html = '<!DOCTYPE html><html><body><h1>viz ' + hits + '</h1><p>交互可视化测试页</p></body></html>';
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const piece of html.match(/[\s\S]{1,24}/g) || []) {
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    await wait(120);
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const srv = await startIsolatedServer({ port: APP_PORT, label: 'phymathia-vizbg' });
process.on('exit', () => srv.stop());

const results = [];
const ok = (n) => { results.push([true, n]); console.log('✓ ' + n); };
const bad = (n, e) => { results.push([false, n + ' —— ' + ((e && e.message) || e)]); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await wait(1200);

  // ① 核心承诺：viz 后台发射后忙碌闸 false、 viz-bg 行出现、不进前台 6 开关
  const r1 = await page.evaluate(() => {
    const before = { busy: _isActuallyBusy(), run: workflowRunActive, tasks: _taskActive.length };
    const node = { id: 'viz-bg-test', kind: 'module', moduleKey: 'viz', timestamp: Date.now() };
    // 直接走后台发射器（真机页面里函数已加载），run 传一个假 Promise 不烧真上游
    let ran = false;
    const launched = vizBgLaunchMessage(node.id, async () => { ran = true; await new Promise(r => setTimeout(r, 50)); });
    const after = { busy: _isActuallyBusy(), run: workflowRunActive, tasks: _taskActive.length };
    window.__vizBgFirstJob = node.id;
    const row = _taskActive.find(t => t.kind === 'viz-bg');
    return {
      before, after, launched, ran,
      rowTitle: row ? row.title : null,
      rowNodeId: row && row.nodes && row.nodes[0] ? row.nodes[0].id : null,
      jobs: vizBgActiveCount(),
    };
  });
  if (!r1.launched) bad('viz 后台可发射', 'vizBgLaunchMessage 返回 false');
  else ok('viz 后台可发射');
  if (r1.after.busy !== false || r1.after.run !== false) {
    bad('viz 后台不挡队列', JSON.stringify(r1.after));
  } else ok('viz 后台不挡队列（_isActuallyBusy/workflowRunActive 均 false）');
  if (!/（后台）/.test(r1.rowTitle || '') || r1.rowNodeId !== 'viz-bg-test') {
    bad('后台任务行独立且带 nodeId', JSON.stringify(r1.rowTitle + '/' + r1.rowNodeId));
  } else ok('后台任务行标题带「（后台）」且带 nodeId（484 可认领）');

  // ② 上限 2：等①那条结算完，再连开三条，第三条必须被拒
  await wait(200);
  const r2 = await page.evaluate(() => {
    const a = vizBgLaunchMessage('limit-a', () => new Promise(r => setTimeout(r, 5000)));
    const b = vizBgLaunchMessage('limit-b', () => new Promise(r => setTimeout(r, 5000)));
    const c = vizBgLaunchMessage('limit-c', () => new Promise(r => setTimeout(r, 5000)));
    return { a, b, c, count: vizBgActiveCount(), firstGone: !vizBgHas(window.__vizBgFirstJob) };
  });
  if (r2.firstGone && r2.a && r2.b && r2.c === false && r2.count === 2) ok('并发上限 2 生效');
  else bad('并发上限 2', JSON.stringify(r2));

  // ③ 停止隔离：停一条 viz 不影响另一条、不碰前台闸
  const r3 = await page.evaluate(() => {
    vizBgCancel('limit-a', '测试停');
    return {
      aGone: !vizBgHas('limit-a'), bAlive: vizBgHas('limit-b'),
      busy: _isActuallyBusy(), run: workflowRunActive,
    };
  });
  if (r3.aGone && r3.bAlive && !r3.busy && !r3.run) ok('停止隔离：停 viz-A 不动 viz-B 与前台');
  else bad('停止隔离', JSON.stringify(r3));

  // ④ 刷新后 viz-bg 行被 484 认领：模拟 running 行落盘 → 刷新 → interrupted→ 翻回
  const r4 = await page.evaluate(async () => {
    vizBgCancel('limit-b', '清理');
    // 造一条带 nodeId 的 viz-bg running 行并落盘
    const t = _taskCreate({ kind: 'viz-bg', title: '生成交互可视化（后台）', state: 'running',
      nodes: [{ id: 'resume-node', label: '交互可视化', state: 'running' }] });
    _taskPersistNow();
    await new Promise(r => setTimeout(r, 300));
    // 模拟刷新：走 _taskSplitLoaded 的 interrupted 转换
    const raw = JSON.parse(JSON.stringify(_taskSnapshot()));
    const split = _taskSplitLoaded(raw.tasks);
    const row = split.history.find(x => x.id === t.id);
    return { state: row ? row.state : null, kind: row ? row.kind : null, hasNodeId: !!(row && row.nodes.some(n => n.id === 'resume-node')) };
  });
  if (r4.state === 'interrupted' && r4.kind === 'viz-bg' && r4.hasNodeId) {
    ok('刷新后 viz-bg 行保留 kind+nodeId（484 收编可认领）');
  } else bad('刷新认领前置', JSON.stringify(r4));

  // 清理：临时实例用完即杀，任务行留在内存里无所谓——不强依赖全局导出名。
} finally {
  await browser.close();
  mock.close();
  srv.stop();
}

const failed = results.filter(r => !r[0]);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
if (failed.length) process.exitCode = 1;
