// 真机回归：导入写满浏览器本地存储（2026-11-24 用户实测，配 ui-backup.js 同轮修复）。
// 场景：账号数据超过 localStorage 配额（浏览器上限约 5MB）时导入备份——
//   修前：本机缓存回放写满即抛，整次导入被误报「导入失败：The quota has been exceeded.」
//        （服务端其实早已收下，刷新后数据都在）；
//   修后：回执「导入完成」＋一句缓存说明，服务端数据完整，页面刷新后画布可用。
// 手法：隔离实例（scripts/lib/test_server.mjs，临时数据目录，绝不碰真实 data/）＋
// Playwright 真浏览器，addInitScript 给 localStorage 实例打「超 30KB 即抛
// QuotaExceededError」的桩——小键照常写、画布大块写必失败，精确复现配额将满形态。
// 跑法：node scripts/verify_backup_quota.mjs（约半分钟）。改导入/备份回放链路时必跑。
import { writeFileSync, rmSync } from 'node:fs';
import { startIsolatedServer } from './lib/test_server.mjs';
import { chromium } from 'playwright';

const SID = 'bq_s1';
const PORT = 5087; // 避开 5050/5051/5060/5061/5073/5077-5079/5081/5082/5084/5085/5098/5099
const fail = (msg) => { console.error('❌ ' + msg); process.exitCode = 1; };

const srv = await startIsolatedServer({ port: PORT, label: 'phymathia-bq' });
process.on('exit', () => srv.stop());

// 备份文件：小数据照常写入；画布状态塞 200KB 内容，必超 30KB 阈值（配额满的元凶形态）
const now = Date.now();
const backup = {
  version: 3,
  exportedAt: now,
  sessions: { [SID]: { id: SID, title: '配额真机画布', createdAt: now, updatedAt: now } },
  messages: { [SID]: [
    { id: 'm1', role: 'user', content: '什么是动量守恒？', timestamp: now },
    { id: 'm2', role: 'assistant', content: '动量守恒：p=mv……', timestamp: now + 1 },
  ] },
  knowledge: { ki_bq1: { id: 'ki_bq1', concept: '动量守恒', meaning: 'p=mv', createdAt: now, updatedAt: now } },
  formulas: { f_bq1: { id: 'f_bq1', latex: 'p=mv', concept: '动量', createdAt: now, updatedAt: now } },
  graphs: { [SID]: { version: 1, updatedAt: now, customNodes: [
    { id: 'n1', kind: 'note', title: '大节点', content: 'x'.repeat(200 * 1024), x: 0, y: 0 },
  ] } },
  settings: { phymathia_theme: 'dark' },
  theme: 'dark',
  quizStats: { total: 1 },
};
const backupPath = '/tmp/phymathia-backup-quota.json';
writeFileSync(backupPath, JSON.stringify(backup));

const browser = await chromium.launch();
const ctx = await browser.newContext();
// 配额桩：挂在 localStorage 实例上（sessionStorage 不受影响），每次导航后仍生效。
// 整体 try/catch：页面里的沙箱 iframe 本来就不许摸 localStorage（SecurityError），
// 那些帧直接跳过，别把桩自己的异常算进页面未捕获异常。
await ctx.addInitScript(`
  (function () {
    try {
      const raw = window.localStorage;
      const orig = raw.setItem.bind(raw);
      raw.setItem = function (k, v) {
        if (String(v).length > 30000) {
          const e = new Error('The quota has been exceeded.');
          e.name = 'QuotaExceededError';
          throw e;
        }
        return orig(k, v);
      };
    } catch (e) { /* 沙箱帧等拿不到 localStorage 的场合：不打桩、不报错 */ }
  })();
`);
const page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

try {
  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.confirmImport === 'function', null, { timeout: 30000 });

  // 走真实 UI 链路：选文件 → 预览 → 确认合并
  await page.setInputFiles('#importFileInput', backupPath);
  await page.waitForFunction(() => {
    const b = document.getElementById('importPreview');
    return !!(b && !b.hidden);
  }, null, { timeout: 20000 });
  // 数据管理面板默认收起，按钮在 DOM 里但不可见——直接 JS 触发（面板可见性与本回归无关）
  await page.evaluate(() => document.getElementById('importConfirmBtn').click());
  await page.waitForFunction(() => {
    const el = document.getElementById('importPreviewResult');
    return !!(el && el.textContent && el.textContent.indexOf('导入完成') >= 0);
  }, null, { timeout: 30000 });
  const resultText = await page.evaluate(() => document.getElementById('importPreviewResult').textContent);
  console.log('回执：' + resultText.replace(/\n/g, ' ⏎ '));
  if (!resultText.includes('浏览器本地空间不足')) fail('回执缺缓存说明（应说明本地空间不足但不影响使用）：' + resultText);
  if (resultText.includes('导入失败')) fail('服务端已收下却报了导入失败：' + resultText);

  // 等自动刷新（3.6s）落定，再核对「服务端真相已落、本机缓存按预期没写大块」
  await page.waitForTimeout(5200);
  const after = await page.evaluate(async (sid) => {
    const sessions = JSON.parse(localStorage.getItem('phymathia_sessions') || '{}');
    const graphCached = !!localStorage.getItem('phymathia_graph_' + sid);
    const sessResp = await fetch('/api/sessions');
    const serverSessions = await sessResp.json();
    const kvResp = await fetch('/api/kv/' + encodeURIComponent('graph:' + sid));
    let kvOk = false, kvStatus = 0, kvHint = '';
    try {
      kvStatus = kvResp.status;
      const body = await kvResp.json();
      kvOk = !!(body && body.value);
      if (body && body.value && typeof body.value === 'object') kvHint = Object.keys(body.value).slice(0, 5).join(',');
    } catch (e) { kvHint = String(e); }
    const snapResp = await fetch('/api/backup/snapshots');
    const snaps = await snapResp.json();
    return {
      localSids: Object.keys(sessions),
      graphCached,
      serverSids: Object.keys(serverSessions || {}),
      kvOk, kvStatus, kvHint,
      snapCount: (snaps && snaps.snapshots ? snaps.snapshots : []).length,
    };
  }, SID);
  if (!after.localSids.includes(SID)) fail('本机会话名单没有导入的画布：' + after.localSids.join(','));
  if (after.graphCached) fail('画布大块不该写进本机缓存（配额桩应拦下）');
  if (!after.serverSids.includes(SID)) fail('服务端没有收到导入的画布：' + after.serverSids.join(','));
  if (!after.kvOk) fail('服务端画布状态（kv graph:' + SID + '）没有落盘：status=' + after.kvStatus + ' hint=' + after.kvHint);
  if (after.snapCount < 1) fail('导入前的自动备份没有生成');
  if (pageErrors.length) fail('页面抛了未捕获异常：' + pageErrors.join(' | '));
  console.log('核对：本机名单[' + after.localSids.join(',') + '] 画布缓存=' + (after.graphCached ? '有' : '无（配额满，符合预期）')
    + ' · 服务端画布=' + (after.serverSids.includes(SID) ? '已落盘' : '缺失')
    + ' · 自动备份=' + after.snapCount + ' 份 · 页面未捕获异常=' + pageErrors.length);
  if (!process.exitCode) console.log('✅ 真机回归全绿：配额满时导入照常完成，数据在电脑存档，回执如实说明缓存情况');
} catch (e) {
  fail('真机流程中断：' + ((e && e.message) || e));
} finally {
  await browser.close().catch(() => {});
  srv.stop();
  try { rmSync(backupPath, { force: true }); } catch (e) {}
}
