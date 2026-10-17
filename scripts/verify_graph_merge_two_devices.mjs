// 真机验证（T360 跨设备节点级合并）：node scripts/verify_graph_merge_two_devices.mjs（约 30 秒，
// 自带临时数据目录，用完即杀不碰 data/）。两个浏览器上下文＝两台设备，验证「旧设备（本地
// 空内容副本）一次触碰不再抹掉另一台设备刚生成的内容，而它自己的视口/坐标照常同步」。
// 2026-10-17 首跑抓到一处真 bug：快路径只看 updatedAt 时，合并过的服务端版本号等于本端
// 那次保存的值 → 下一拍整图把对方内容盖掉。判据因此改成「签名表逐项一致」（pytest 有对应
// 用例 test_fast_path_requires_agreement_not_timestamp）。
import { fileURLToPath } from 'node:url';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const APP_PORT = 5086;
const BASE = `http://127.0.0.1:${APP_PORT}`;
const wait = ms => new Promise(r => setTimeout(r, ms));

const workDir = mkdtempSync(join(tmpdir(), 'phymathia-t360-'));
cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
const server = spawn('python3', ['src/main.py', '-p', String(APP_PORT)], { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', d => { log += d; });
server.stderr.on('data', d => { log += d; });

const results = [];
const ok = n => { results.push(true); console.log('✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('✗ ' + n + ' —— ' + ((e && e.message) || e)); };

const SID = 'sess_t360_e2e';
const kvPath = join(workDir, 'data', 'users', 'default', 'kv', SID + '.json');
const readStored = () => JSON.parse(readFileSync(kvPath, 'utf8'))['graph:' + SID];

for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(BASE + '/health');
    if (r.ok) break;
  } catch (e) { /* 还没起来 */ }
  await wait(500);
}

const browser = await chromium.launch();
const openDevice = async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.saveGraphState === 'function', null, { timeout: 20000 });
  return { ctx, page };
};

try {
  // ---- 设备 A：建画布并落一章「旧内容」 ----
  const A = await openDevice();
  await A.page.evaluate(async (sid) => {
    window.saveGraphState(sid, {
      customNodes: [{ id: 'node-1', kind: 'module', moduleKey: 'physics', content: '旧内容', generatedAt: 1000, x: 10, y: 20, status: 'done' }],
      connections: [], pan: { x: 0, y: 0 }, zoom: 0.9, updatedAt: Date.now(),
    });
    await window.flushGraphStateServerSave();
  }, SID);
  await wait(400);
  const step1 = readStored();
  if (step1 && step1.customNodes[0].content === '旧内容') ok('设备 A 首存：服务端已落「旧内容」');
  else bad('设备 A 首存', new Error('服务端内容=' + JSON.stringify(step1 && step1.customNodes)));

  // ---- 设备 B：一份「屏幕见过、盘上回空」的旧副本（T359 坏节点的形态） ----
  const B = await openDevice();
  await B.page.evaluate((sid) => {
    localStorage.setItem('phymathia_graph_' + sid, JSON.stringify({
      customNodes: [{ id: 'node-1', kind: 'module', moduleKey: 'physics', content: '', generatedAt: 0, x: 999, y: 888, status: '' }],
      connections: [], pan: { x: 0, y: 0 }, zoom: 0.9, updatedAt: Date.now(),
    }));
  }, SID);

  // ---- 设备 A：生成出新内容并保存（快路径：base 版本对得上） ----
  await A.page.evaluate(async (sid) => {
    const st = window.getGraphState(sid);
    st.customNodes[0].content = 'A 设备刚生成的新内容';
    st.customNodes[0].generatedAt = Date.now();
    window.saveGraphState(sid, st);
    await window.flushGraphStateServerSave();
  }, SID);
  await wait(400);
  const step2 = readStored();
  if (step2 && step2.customNodes[0].content === 'A 设备刚生成的新内容') ok('设备 A 生成并保存：服务端是新内容');
  else bad('设备 A 生成保存', new Error('服务端内容=' + JSON.stringify(step2 && step2.customNodes[0])));

  // ---- 设备 B：触碰画布（平移）→ 本地空内容副本整图保存 ----
  await B.page.evaluate(async (sid) => {
    const st = window.getGraphState(sid);
    st.pan = { x: 123, y: 45 };
    window.saveGraphState(sid, st);
    await window.flushGraphStateServerSave();
  }, SID);
  await wait(400);
  const step3 = readStored();
  if (step3.customNodes[0].content === 'A 设备刚生成的新内容') ok('设备 B 旧副本一次触碰：A 的内容没被抹掉（节点级合并生效）');
  else bad('T360 内容保护', new Error('服务端内容变成=' + JSON.stringify(step3.customNodes[0].content)));
  if (step3.customNodes[0].x === 999 && step3.customNodes[0].y === 888) ok('设备 B 的节点坐标照常生效（视图字段仍听本次保存）');
  else bad('视图字段合并', new Error('坐标=' + step3.customNodes[0].x + ',' + step3.customNodes[0].y));
  if (step3.pan && step3.pan.x === 123 && step3.pan.y === 45) ok('设备 B 的视口照常同步');
  else bad('视口同步', new Error('pan=' + JSON.stringify(step3.pan)));
  if (step3.nodeSigs && typeof step3.nodeSigs['node-1'] === 'string') ok('服务端存下了节点签名（下一次保存能继续判「谁改过」）');
  else bad('签名落库', new Error('nodeSigs=' + JSON.stringify(step3.nodeSigs)));

  // ---- 设备 B 再保存一次：base 已更新，不应把 A 的内容换回来 ----
  await B.page.evaluate(async (sid) => {
    const st = window.getGraphState(sid);
    st.zoom = 1.1;
    window.saveGraphState(sid, st);
    await window.flushGraphStateServerSave();
  }, SID);
  await wait(400);
  const step4 = readStored();
  if (step4.customNodes[0].content === 'A 设备刚生成的新内容') ok('设备 B 连续保存：内容仍未被回退');
  else bad('连续保存', new Error('内容=' + JSON.stringify(step4.customNodes[0].content)));
} catch (e) {
  bad('真机流程异常', e);
} finally {
  await browser.close();
  server.kill();
}

console.log(results.every(Boolean) ? '\nT360 真机验证全部通过' : '\nT360 真机验证失败');
if (!results.every(Boolean)) console.log(log.slice(-3000));
process.exit(results.every(Boolean) ? 0 : 1);
