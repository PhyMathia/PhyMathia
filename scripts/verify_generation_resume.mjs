// 真机验证（484 生成断点续跑）：node scripts/verify_generation_resume.mjs（约 1 分半，
// 自带临时数据目录第二实例 scripts/lib/test_server.mjs ＋慢速 mock 上游，用完即杀不碰 data/）。
// 拍板口径（用户 2026-11-19）：后台跑完＋限时自动停——服务端持任务，刷新凭 task id 重接流。
// 场景：真浏览器 + 真服务端 + 慢速 mock 上游（每 130ms 一片、60 片约 8 秒收尾），看四件事：
//   ① 流中刷新＝重接：刷新后节点 busy 保持、内容越过刷新前长度、最终 done 且含尾段标记；
//   ② 服务重启＝回落旧口径：种一颗带任务 id 的「生成中」残留（重启后注册表必空），
//      重载后探活 404 → 旧中断结算（剥 busy、草稿入账、标失败）；
//   ③ 重接中点「停止生成」＝双掐：本地 abort＋DELETE 后台任务，上游连接被服务端关掉
//      （mock 的 completions 不涨＝不是自然跑完）、节点回等待态（与调度路 abort 口径一致）；
//   ④ 宽限自动停：关页不再回来，宽限到点服务端自动掐上游（completions 不涨）；
//      再开页探到 interrupted → 旧口径结算，半成品保留。
// 宽限/清扫间隔经 PHYMATHIA_GEN_GRACE_SECONDS / PHYMATHIA_GEN_SWEEP_SECONDS 调到秒级。
// 注意：重启的实例必须带上同款 env（常量随进程，env 丢了宽限就回 600s 默认）。
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const APP_PORT = 5090;
const MOCK_PORT = 5091;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const TEST_ENV = { PHYMATHIA_GEN_GRACE_SECONDS: '3', PHYMATHIA_GEN_SWEEP_SECONDS: '1' };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const results = [];
const ok = n => { results.push(true); console.log('✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };
// 轮询撞上页面导航时 evaluate 会抛：按「这一拍没拿到」处理，别把等待本身炸掉
const until = async (fn, ms, what) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    let got = null;
    try { got = await fn(); } catch (e) { got = null; }
    if (got) return got;
    await wait(200);
  }
  throw new Error('等 ' + what + ' 超时（' + ms + 'ms）');
};

// ---- 慢速 mock 上游：分析请求正常收尾；模块正文 60 片、每 130ms 一片（约 8 秒），收尾带标记 ----
let chatSeen = 0;
let upstreamCloses = 0;   // 上游连接关闭（正常跑完与被掐都算）
let completions = 0;      // 只有 mock 自然吐完全部片段才算——分辨「跑完了」与「被掐了」
const mock = createServer((req, res) => {
  if (req.url === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ chatSeen, upstreamCloses, completions }));
    return;
  }
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    chatSeen++;
    let promptText = '';
    try {
      const parsed = JSON.parse(body);
      promptText = (parsed.messages || []).map(m => String(m.content || '')).join('\n');
    } catch (e) { promptText = String(body); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.on('close', () => { upstreamCloses++; });
    const chunk = text => res.write('data: ' + JSON.stringify({ id: 'm' + chatSeen, choices: [{ delta: { content: text } }] }) + '\n\n');
    if (/请分析用户问题|问题概要/.test(promptText)) {
      chunk('分析：Mock 分析，核心是回复力与位移成正比。建议模块：物理视角、数学视角\n');
      res.write('data: [DONE]\n\n');
      completions++;
      res.end();
      return;
    }
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) { clearInterval(timer); return; }
      i++;
      if (i < 60) { chunk('第' + i + '段：Mock 正文' + (i % 3 === 0 ? '，公式 $E=mc^2$。' : '。')); return; }
      clearInterval(timer);
      chunk('，收尾标记TAIL');
      res.write('data: [DONE]\n\n');
      completions++;
      res.end();
    }, 130);
    res.on('close', () => clearInterval(timer));
  });
});
await new Promise(r => mock.listen(MOCK_PORT, '127.0.0.1', r));

const srv = await startIsolatedServer({
  port: APP_PORT,
  label: 'phymathia-484',
  env: TEST_ENV,
});
process.on('exit', () => srv.stop());

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
// initScript 挂 context：后面每个新页（④ 重开页）都自动带上模型配置
await context.addInitScript((cfg) => {
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
  } catch (e) { /* 沙盒 iframe（opaque origin）没有 localStorage：不种也不算异常 */ }
}, { model: { id: 'mock-slow', name: 'mock', provider: 'opencode', model: 'mock-1', apiKey: 'x', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1` } });
const page = await context.newPage();
const pageErrors = [];
const watchErrors = pg => pg.on('pageerror', e => pageErrors.push(String((e && e.message) || e)));
watchErrors(page);
const stats = async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/__stats`)).json();

// 开一个新问题工作流（不 await：整条跑完才 resolve，等它就错过「生成中」窗口），
// 等模块节点流到指定长度（模块卡由 mock 分析回复的「建议模块」行派生）
async function startGeneration(pg, question, minLen) {
  await pg.evaluate(q => { window.startQuestionWorkflow(q); }, question);
  return until(async () => {
    return pg.evaluate(min => {
      const n = graphView.nodes.find(x => x.kind === 'module' && x.busy && (x.content || '').length > min);
      return n ? { id: n.id, len: (n.content || '').length } : null;
    }, minLen);
  }, 25000, '模块节点流式起来');
}
const nodeState = (pg, id) => pg.evaluate(nid => {
  const n = graphView.nodes.find(x => x.id === nid);
  return n ? { id: n.id, busy: n.busy, status: n.status, len: (n.content || '').length, content: n.content || '' } : null;
}, id);
async function reloadApp(pg) {
  await pg.reload({ waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
}

try {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  await wait(1200);
  const sid = await page.evaluate(() => window.getCurrentSessionId());

  // —— ① 流中刷新＝重接续跑，最终 done 且含尾段 ——
  const mid = await startGeneration(page, '用一句话说明简谐运动', 40);
  await reloadApp(page);
  const resumed = await until(async () => {
    const st = await nodeState(page, mid.id);
    return st && st.len > mid.len + 60 ? st : null;
  }, 25000, '重接后内容越过刷新前长度');
  if (!resumed.busy) bad('① 流中刷新重接', new Error('重接后节点竟然已不 busy'));
  else ok('① 流中刷新重接：内容越过刷新前长度（' + mid.len + '→' + resumed.len + '，重接续跑不是重跑）');
  const finished = await until(async () => {
    const st = await nodeState(page, mid.id);
    return st && !st.busy ? st : null;
  }, 40000, '重接的生成跑完收尾');
  if (finished.status === 'done' && finished.content.includes('收尾标记TAIL')) {
    ok('① 续跑收尾：status=done、含尾段标记（没标失败）');
  } else {
    bad('① 续跑收尾', new Error('status=' + finished.status + ' content尾=' + finished.content.slice(-60)));
  }

  // —— ② 服务重启＝回落旧口径（注册表随进程消失）——
  await srv.proc.kill('SIGKILL');
  await wait(800);
  await page.evaluate(s => {
    const key = 'phymathia_graph_' + s;
    const raw = JSON.parse(localStorage.getItem(key) || '{}');
    raw.customNodes = raw.customNodes || [];
    raw.customNodes.push({
      id: 'stale1', kind: 'module', moduleKey: 'learn', messageIndex: -1, timestamp: Date.now(),
      busy: true, status: 'running', content: '重启前的半截草稿',
      genTaskId: '44444444-4444-4444-4444-444444444444', genTaskKind: 'content',
      versions: [{ content: '旧版内容', at: 1 }], activeVersion: 0, x: 120, y: 120,
    });
    raw.updatedAt = Date.now();
    localStorage.setItem(key, JSON.stringify(raw));
  }, sid);
  const proc2 = spawn('python3', ['src/main.py', '-p', String(APP_PORT)], {
    cwd: srv.workDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...TEST_ENV },
  });
  process.on('exit', () => { try { proc2.kill('SIGKILL'); } catch (e) { /* 已退 */ } });
  await until(async () => {
    try { return (await fetch(BASE + '/health', { signal: AbortSignal.timeout(900) })).ok ? true : null; } catch (e) { return null; }
  }, 45000, '重启的服务实例就绪');
  await reloadApp(page);
  const stale = await until(async () => {
    return page.evaluate(() => {
      const n = graphView.nodes.find(x => x.id === 'stale1');
      return n && !n.busy ? { status: n.status, vLen: (n.versions || []).length, content: n.content || '' } : null;
    });
  }, 25000, '残留节点被旧口径结算');
  if (stale.status === 'error' && stale.vLen >= 2 && stale.content.includes('半截草稿')) {
    ok('② 服务重启回落：探活 404 → 旧中断结算（error＋草稿入账 v' + stale.vLen + '＋内容保留）');
  } else {
    bad('② 服务重启回落', new Error(JSON.stringify(stale)));
  }

  // —— ③ 重接中点「停止生成」＝双掐（本地 abort＋DELETE，上游连接被关）——
  // 基线在重接确认后采集：startGeneration 里的分析请求会自然跑完一次 completions，
  // 不能算进「模块被掐没跑完」的判定
  const mid3 = await startGeneration(page, '第三问：说明动量守恒', 40);
  await reloadApp(page);
  await until(async () => {
    const st = await nodeState(page, mid3.id);
    return st && st.len > mid3.len + 40 ? st : null;
  }, 25000, '重接续流中');
  const statsBefore = await stats();
  await page.evaluate(() => { window.stopGeneration(); });
  const stopped = await until(async () => {
    const st = await nodeState(page, mid3.id);
    return st && !st.busy ? st : null;
  }, 10000, '重接的节点停止收账');
  const s3 = await until(async () => {
    const s = await stats();
    return s.upstreamCloses > statsBefore.upstreamCloses ? s : null;
  }, 8000, '服务端掐掉上游连接');
  if (stopped.status === 'waiting' && s3.completions === statsBefore.completions) {
    ok('③ 停止双掐：节点回等待态（abort 口径）、上游被关且没自然跑完（closes→' + s3.upstreamCloses + '）');
  } else {
    bad('③ 停止双掐', new Error('status=' + stopped.status + ' busy=' + stopped.busy
      + ' completions=' + s3.completions + '/' + statsBefore.completions));
  }

  // —— ④ 宽限自动停：关页不回来，宽限到点服务端自动掐上游；再开页旧口径结算 ——
  const stats4 = await stats();
  const mid4 = await startGeneration(page, '第四问：说明波的叠加', 40);
  const len4 = mid4.len;
  const busyIds = await page.evaluate(() =>
    graphView.nodes.filter(n => n.busy && n.genTaskId).map(n => ({ id: n.id.slice(0, 14), t: n.genTaskId })));
  console.log('  ④ 关页时在跑任务：', JSON.stringify(busyIds));
  await page.close();
  // 宽限的硬证据：关页时在跑的全部任务在宽限窗口（3s＋清扫 1s＋余量）内变成
  // interrupted。不再看 closes/completions——别的画布遗留任务可能在窗口内自然
  // 跑完，它的正常收尾连接与完成计数会跟宽限判定纠缠（实测踩过）。
  let graceDone = false;
  for (let k = 0; k < 14; k++) {
    await wait(1000);
    const states = [];
    for (const b of busyIds) {
      try {
        const r = await fetch(`${BASE}/api/generations/${b.t}`);
        states.push(r.ok ? `${b.id.slice(0, 8)}:${(await r.json()).state}` : `${b.id.slice(0, 8)}:http${r.status}`);
      } catch (e) { states.push(`${b.id.slice(0, 8)}:err`); }
    }
    const allInterrupted = states.length > 0 && states.every(s => s.endsWith('interrupted'));
    if (k >= 3 || allInterrupted) console.log(`  ④ t+${k + 1}s ${states.join(' ')}`);
    if (allInterrupted) { graceDone = true; break; }
  }
  if (!graceDone) throw new Error('关页后在跑的任务没有全部被宽限掐成 interrupted');
  ok('④ 宽限自动停：关页约 4 秒后上游被关且没自然跑完（宽限 3s＋清扫 1s）');
  const page2 = await context.newPage();
  watchErrors(page2);
  await page2.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page2.waitForFunction(() => typeof window.startQuestionWorkflow === 'function', null, { timeout: 20000 });
  const resumed4 = await until(async () => {
    return page2.evaluate(nid => {
      const n = graphView.nodes.find(x => x.id === nid);
      return n && !n.busy ? { status: n.status, content: n.content || '' } : null;
    }, mid4.id);
  }, 25000, '回来后中断节点结算');
  if (!resumed4.busy && resumed4.content.length >= len4) {
    ok('④ 回来结算：探到 interrupted → 重放补内容后旧口径落地（status=' + (resumed4.status || '空串(首生成不标失败)')
      + '，内容 ' + resumed4.content.length + ' 字 ≥ 关页前 ' + len4 + '）');
  } else {
    bad('④ 回来结算', new Error('status=' + resumed4.status + ' len=' + resumed4.content.length + '（关页前 ' + len4 + '）'));
  }

  if (pageErrors.length) {
    bad('页面 JS 零报错', new Error(pageErrors[0]));
  } else {
    ok('页面 JS 零报错');
  }
} catch (e) {
  bad('真机验证中途失败', e);
  console.error('服务端日志尾：\n' + srv.logTail(1800));
} finally {
  await browser.close();
  mock.close();
  srv.stop();
}
const passed = results.filter(Boolean).length;
console.log('\n' + (passed === results.length
  ? `✓ 全部 ${results.length} 例通过`
  : `✗ ${results.length - passed}/${results.length} 例失败`));
process.exit(passed === results.length ? 0 : 1);
