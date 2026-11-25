// 真机复现（backlog 570，2026-11-23）：viz 后台通道收尾结算是否进持久层。
// node scripts/verify_backlog570_viz_settle.mjs（约 2 分钟；自带隔离实例＋扣流上游，
// 用完即杀不碰 data/）。探针 flag phymathia_570_probe='1' 随页种入，[570] 行收进报告。
//
// 场景（每场景独立浏览器上下文＝独立画布）：
//   S1 基线      全程不切画布：结算后服务端 KV 必须有成品（对照路，必须绿）
//   S2a 先切后断 看门狗掐断前就切走并停留：T419 兜底寻址的正路（对照路，必须绿）
//   S2b 窗内切回 重试窗口内切走又切回（视图重建）：结算应写回重建后的视图对象
//   S4 窗内切走  结算入口还在画布上、重试窗口内切走并停留——570 定罪候选：
//                结算写进已 detach 的视图对象，_saveCustomNodes 序列化的是当前画布
//   S3  双标签   第二标签页持旧状态，在结算推送前后整包推回：T360 三方合并应挡住
//
// 看门狗 120s→6s（addInitScript 钳制，只改测试环境）。math 零帧 6s 到点；viz 先在
// 1.5s 滴一帧把看门狗错后到 ~7.5s——保证 math 先结算、工作流任务上下文先清，
// viz 结算发生在 ctx=null 的口径上（与真机时间线一致）。
import { startIsolatedServer } from './lib/test_server.mjs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const APP_PORT = 5090;
const MOCK_PORT = 5091;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = n => { results.push(true); console.log('  ✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('  ✗ ' + n + ' —— ' + ((e && e.message) || e)); };

// ---- 扣流上游：分析正常收尾；math 零帧挂死；viz 滴一帧后挂死；viz 重试扣住等放行 ----
const stats = { seen: 0, math: 0, viz: 0, retry: 0 };
let heldRetry = null;
const mock = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(stats)); return; }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    stats.seen++;
    let promptText = '';
    try { const p = JSON.parse(body); promptText = (p.messages || []).map(m => String(m.content || '')).join('\n'); } catch (e) { promptText = String(body); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const chunk = t => res.write('data: ' + JSON.stringify({ id: 'm' + stats.seen, choices: [{ delta: { content: t } }] }) + '\n\n');
    if (/请分析用户问题|问题概要/.test(promptText)) {
      chunk('分析：夫琅禾费单缝衍射的核心是波前上无数子波的相干叠加。\n建议模块：数学视角、交互可视化\n');
      res.write('data: [DONE]\n\n'); res.end(); return;
    }
    if (/DOCTYPE html|完整页面/.test(promptText)) {   // viz 自动重试：扣住，等 /__release
      stats.retry++;
      heldRetry = { res, chunk };
      return;   // 不写不 end
    }
    if (/可视化/.test(promptText)) {                  // viz 第一跳：1.5s 滴一帧再挂死
      stats.viz++;
      setTimeout(() => { try { chunk('…'); } catch (e) { /* 页面已走 */ } }, 1500);
      return;
    }
    if (/数学/.test(promptText)) {                    // math：零帧挂死，看门狗 6s 到点
      stats.math++;
      return;
    }
    chunk('正文。'); res.write('data: [DONE]\n\n'); res.end();
  });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const srv = await startIsolatedServer({ port: APP_PORT, label: 'phymathia-570' });
process.on('exit', () => srv.stop());

async function waitForRetryHeld(timeoutMs) {
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl && !heldRetry) await wait(150);
  if (!heldRetry) throw new Error('viz 自动重试请求没来（看门狗/重试链没走到）');
}
function releaseRetry() {
  const h = heldRetry; heldRetry = null;
  if (!h) return;
  const html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>PM570</title></head><body><div id="root">PM570PROD-夫琅禾费衍射</div></body></html>';
  h.chunk(html.slice(0, 60));
  h.chunk(html.slice(60));
  h.res.write('data: [DONE]\n\n');
  h.res.end();
}
async function kvRead(sid) {
  const r = await fetch(BASE + '/api/kv/' + encodeURIComponent('graph:' + sid), { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  return (j.value && Array.isArray(j.value.customNodes)) ? j.value.customNodes : [];
}
async function kvDump(sid, vizId, label) {
  const nodes = await kvRead(sid).catch(() => []);
  const viz = nodes.find(n => String(n.id) === vizId);
  console.log('    [kv@' + label + '] viz=' + (viz
    ? JSON.stringify({ busy: !!viz.busy, st: viz.status || '', len: String(viz.content || '').length, head: String(viz.content || '').slice(0, 30) })
    : '(不在)'));
}
const PROBE_KINDS = ['hop1-clear', 'settle-entry', 'retry-begin', 'settle-write', 'settle-fail-write', 'catch-settle', 'tail-fallback', 'tail-save', 'bg-launch', 'bg-settle-read', 'ctx-merge', 'sched', 'sched-fire', 'save', 'post', 'pull'];
const printProbe = (lines, onlyKey) => {
  for (const l of lines) {
    const kind = (l.split(' ')[1] || '');
    if (!onlyKey || PROBE_KINDS.includes(kind)) console.log('    ' + l.slice(0, 260));
  }
};
const viewDump = (page, vizId, label) => page.evaluate((args) => {
  const n = (typeof graphView !== 'undefined' && graphView.nodeById) ? graphView.nodeById[args[0]] : null;
  return args[1] + ' cur=' + String(window.getCurrentSessionId()).slice(0, 12)
    + ' view=' + (n ? (window.__pm570Tag ? __pm570Tag(n) : '?') + ' busy=' + !!n.busy + ' st=' + (n.status || '') + ' len=' + String(n.content || '').length : '(不在视图)');
}, [vizId, label]).then(s => console.log('    [dump] ' + s));

const browser = await chromium.launch();
let worldSid = '';

async function runScenario(name, mode) {
  console.log('\n—— ' + name + ' ——');
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  const probeA = [];
  page.on('console', m => { const t = m.text(); if (t.indexOf('[570]') >= 0) probeA.push(t); });
  const errs = [];
  page.on('pageerror', e => errs.push(String((e && e.message) || e)));
  await page.addInitScript((cfg) => {
    // 573（2026-11-25）：init script 会随沙盒 iframe 注入 opaque origin 帧，读 localStorage
    // 抛 SecurityError 成 pageerror——沙盒内静默跳过（种子只属主文档），体例同 572。
    try {
      localStorage.setItem('phymathia_user_models', JSON.stringify([cfg.model]));
      localStorage.setItem('phymathia_active_models', JSON.stringify({
        agent_model: cfg.model.id, html_model: cfg.model.id, descriptor_model: cfg.model.id,
        quiz_model: cfg.model.id, graph_model: cfg.model.id, branch_model: cfg.model.id,
      }));
      localStorage.setItem('phymathia_onboarding_done', '1');
      localStorage.setItem('phymathia_guide_seen', '1');
      localStorage.setItem('phymathia_570_probe', '1');
    } catch (e) { /* 沙盒 iframe（opaque origin）没有 localStorage：不种也不算异常 */ }
    // 看门狗 120s → 6s（只改测试环境）
    const realSetTimeout = window.setTimeout.bind(window);
    window.setTimeout = function (fn, ms, ...rest) {
      if (typeof ms === 'number' && ms >= 120000) ms = 6000;
      return realSetTimeout(fn, ms, ...rest);
    };
  }, { model: { id: 'mock-570', name: 'mock', provider: 'opencode', model: 'mock-1', apiKey: 'x', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` } });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  await wait(1200);
  // 场景隔离：首屏会从服务端收养上一个场景的最新画布（同步拉取）——先开一张自己的
  // 干净画布再提问，KV 断言按这张画布的 sid 读，绝不碰前面场景的落盘
  await page.evaluate(() => {
    if (typeof window.createNewSession === 'function') { window.createNewSession(); return 'api'; }
    return 'none';
  }).catch(() => 'none');
  await wait(600);
  heldRetry = null;
  page.evaluate(() => { window.startQuestionWorkflow('用一句话说明夫琅禾费单缝衍射'); });
  const sid = await page.evaluate(() => window.getCurrentSessionId());

  // 等 viz 节点长出来（后台通道发射）
  let vizId = '';
  const dl1 = Date.now() + 25000;
  while (Date.now() < dl1 && !vizId) {
    vizId = await page.evaluate(() => {
      const n = (typeof graphView !== 'undefined' && graphView.nodes || []).find(x => x.moduleKey === 'viz');
      return n ? String(n.id) : '';
    }).catch(() => '');
    if (!vizId) await wait(200);
  }
  if (!vizId) { bad(name + '·viz 节点', new Error('25s 内 viz 模块节点没长出来（建议模块行没被接住？）')); await ctx.close(); return; }
  worldSid = sid;

  // —— 看门狗前的动作（决定结算入口寻址那一拍人在哪）——
  const switchAway = async () => {
    // createNewSession 在 index.html 是 inline onclick 调用＝全局可达；按钮点击只作兜底
    const via = await page.evaluate(() => {
      if (typeof window.createNewSession === 'function') { window.createNewSession(); return 'api'; }
      return 'none';
    }).catch(() => 'none');
    if (via !== 'api') {
      try { await page.locator('.sidebar-icon-btn[title="新建画布"]').click({ timeout: 5000 }); } catch (e) { throw new Error('切画布失败（API 与按钮都不可达）：' + e.message); }
    }
    await wait(800);
  };
  if (mode === 'S2a') await switchAway();

  // 等重试请求被扣住＝看门狗已到点、收尾已寻址（live 已捕获）
  try { await waitForRetryHeld(25000); } catch (e) { bad(name + '·重试扣住', e); printProbe(probeA, false); await ctx.close(); return; }

  // —— 重试窗口内的动作（结算入口之后、成品落账之前的身份破坏窗口）——
  if (mode === 'S2b') {
    await switchAway();
    await page.evaluate(s => window.switchToSession(s), sid);
    await wait(800);
  } else if (mode === 'S4') {
    await switchAway();
  } else if (mode === 'S3') {
    const pageB = await ctx.newPage();
    await pageB.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await pageB.waitForFunction(() => typeof window.saveGraphState === 'function', null, { timeout: 20000 });
    await wait(1500);   // 等 tab B 水合（拉到 math 结算后、viz 还 busy 的那版）
    globalThis.__pageB = pageB;
  }

  if (mode === 'S4') {
    await viewDump(page, vizId, 'release前');
    await kvDump(sid, vizId, 'release前');
  }
  releaseRetry();
  if (mode === 'S4') await kvDump(sid, vizId, '+0.6s');
  await wait(1200);   // 结算写账 + 400ms 调度推送
  if (mode === 'S4') { await viewDump(page, vizId, 'release后1.2s'); await kvDump(sid, vizId, '+1.8s'); }
  if (mode === 'S3') {
    // 第一发：结算推送落地后，旧状态标签页整包推回（base 过期 → 三方合并应挡）
    await globalThis.__pageB.evaluate(() => {
      const s = window.getCurrentSessionId();
      window.saveGraphState(s, window.getGraphState(s));
    });
    await wait(900);
  }
  await wait(600);
  if (mode === 'S4') await kvDump(sid, vizId, '+2.6s');

  // —— 断言：服务端 KV ——
  try {
    const nodes = await kvRead(sid);
    const viz = nodes.find(n => String(n.id) === vizId);
    const math = nodes.find(n => n.moduleKey === 'math');
    const vizStr = viz ? JSON.stringify({ busy: !!viz.busy, st: viz.status || '', len: String(viz.content || '').length }) : '(节点不在 KV)';
    const hasProd = !!(viz && String(viz.content || '').includes('PM570PROD'));
    console.log('    KV viz: ' + vizStr + '；math ' + (math ? 'busy=' + !!math.busy : '(不在)'));
    if (mode === 'S4') {
      // 定罪候选：预期成品丢失（修复前红＝定罪；修复后必须绿）
      if (!hasProd) bad(name + '·成品进持久层', new Error('重试成品没进服务端 KV（' + vizStr + '）——570 机制复现'));
      else ok(name + '·成品进持久层（PM570PROD 在盘上）');
      if (viz && viz.busy) ok(name + '·节点仍 busy=true（与真机「卡生成中」一致）');
      else if (viz && !hasProd) ok(name + '·busy 已清但成品丢失（switch 保存把清账落了盘）');
    } else {
      if (hasProd && viz && !viz.busy && viz.status === 'done') ok(name + '·成品进持久层（PM570PROD 在盘上、busy=false、done）');
      else bad(name + '·成品进持久层', new Error('viz 终态不对：' + vizStr));
    }
    if (math && !math.busy) ok(name + '·math 已结算落盘（busy=false）');
    else bad(name + '·math 结算', new Error(math ? 'math 还在 busy=true' : 'math 节点不在 KV'));
  } catch (e) { bad(name + '·KV 断言', e); }

  printProbe(probeA, true);
  if (errs.length) console.log('    页面 JS 错误：' + errs.slice(0, 3).join(' | '));
  console.log('    [mock] ' + JSON.stringify(stats));
  await ctx.close();
}

try {
  await runScenario('S1 基线（全程不切画布）', 'S1');
  await runScenario('S4 重试窗内切走并停留（570 定罪候选）', 'S4');
  await runScenario('S2a 看门狗前切走并停留（T419 正路）', 'S2a');
  await runScenario('S2b 重试窗内切走又切回', 'S2b');
  await runScenario('S3 双标签旧状态整包推回', 'S3');
} catch (e) {
  bad('场景执行', e);
} finally {
  await browser.close().catch(() => {});
  releaseRetry();
  mock.close();
  srv.stop();
}
console.log(results.every(Boolean) ? '\n570 复现：全部场景按预期' : '\n570 复现：存在非预期结果（见上）');
process.exit(results.every(Boolean) ? 0 : 1);
