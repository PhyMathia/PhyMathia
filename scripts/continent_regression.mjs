#!/usr/bin/env node
// 知识大陆真机回归（playwright 驱动真浏览器，隔离数据目录）：
// 历次大陆前端 bug（NaN 标签、worldW 错用行累加器、setPointerCapture 重定向、
// 样式白名单丢键）全是 smoke 纯函数断言的盲区，每次都靠手工 CDP 验收抓——本脚本
// 把那套验收固化成可重复的旅程断言，动 graph-continent.js 后跑一遍即可。
//
// 覆盖五条核心旅程 + 两个新功能：
//   1. 开图适配（世界尺寸罩住、LOD 档位、顶栏统计）
//   2. 顶栏搜索（多命中清单点行跳转 / 唯一命中回车直达）
//   3. 下钻 + 面包屑返回（离开时视口恢复）
//   4. 边界城市重逢清单（多目标逐行「去看」，跳转不猜）
//   5. 画航线 + Ctrl+Z 撤销
//   6. v8 归类纠正（指派 → KV 落盘 → 撤销回退）
//   7. v8 族表编辑（新增族 → /api/families 生效 → 地图重算）
//   8. LOD 三档双向切换（滚轮缩放）
//  10. v10 新族候选：Φ 起名 → 建族（浏览器侧拦截 mock 模型与建议端点）
//
// 用法：node scripts/continent_regression.mjs
// 隔离口径：临时目录里拷贝 src/（DATA_DIR 在导入期从 config.py 解析，symlink 会被
// resolve() 打回原目录，必须真拷贝）；真实 data/ 全程只读不碰。

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5077;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function ok(name) { results.push(true); console.log('✓ ' + name); }
function fail(name, err) { results.push(false); console.log('❌ ' + name + ' -> ' + (err && err.message || err)); }

const wait = ms => new Promise(r => setTimeout(r, ms));

async function waitHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch (e) { /* 服务还没起 */ }
    await wait(300);
  }
  throw new Error('服务 30s 内未就绪');
}

// 种子库：6 会话 9 卡——简谐运动跨 2 岛（强共享→城市）、梯度 2 岛同族（→海域板+徽标）
function seedSessions() {
  const now = Date.now();
  const s = (id, title, at) => ({ id, title, sessionId: id, icon: '', createdAt: now - at, updatedAt: now - at });
  return [
    s('sess_shm1', '简谐运动', 60000),
    s('sess_shm2', '阻尼振动与共振', 50000),
    s('sess_grad1', '梯度与散度', 40000),
    s('sess_grad2', '梯度与旋度', 30000),
    s('sess_energy', '能量守恒定律', 20000),
    s('sess_fourier', '傅里叶变换', 10000),
  ];
}

function seedKnowledge() {
  let n = 0;
  const it = (title, sid, age, summary, formulas) => ({
    id: 'ki_reg' + (++n), title, sessionId: sid, createdAt: Date.now() - age,
    category: '概念', source: 'manual', summarySource: 'model', summary,
    formulas: formulas || [],
  });
  const list = [
    it('简谐运动方程', 'sess_shm1', 50000, '回复力与位移成正比且方向相反的振动方程', ['x(t) = A \\cos(\\omega t + \\varphi)']),
    it('弹簧振子', 'sess_shm1', 48000, '弹簧小振动理想模型，做简谐运动'),
    it('简谐运动的能量', 'sess_shm2', 40000, '动能与势能互相转化、总量守恒'),
    it('单摆', 'sess_shm2', 38000, '小角度摆动近似为简谐运动'),
    it('阻尼振动', 'sess_shm2', 36000, '振幅随时间衰减的振动'),
    it('梯度的几何意义', 'sess_grad1', 28000, '函数增长最快的方向，等于等值面的法向'),
    it('散度的物理意义', 'sess_grad1', 26000, '矢量场在某点单位体积的通量'),
    it('梯度算符', 'sess_grad2', 18000, 'nabla 算符作用于标量场得到矢量场'),
    it('旋度的计算', 'sess_grad2', 16000, '环流面密度的极限，行列式记忆法'),
    it('能量守恒定律', 'sess_energy', 8000, '孤立系统总能量保持不变'),
    it('傅里叶变换', 'sess_fourier', 2000, '把信号从时域搬到频域的线性变换'),
  ];
  return Object.fromEntries(list.map(x => [x.id, x]));
}

async function seedViaApi() {
  let r = await fetch(BASE + '/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seedSessions()),
  });
  if (!r.ok) throw new Error('种会话失败 HTTP ' + r.status);
  r = await fetch(BASE + '/api/knowledge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seedKnowledge()),
  });
  if (!r.ok) throw new Error('种知识点失败 HTTP ' + r.status);
  r = await fetch(BASE + '/api/continent');
  const data = await r.json();
  if (!data.clusters || data.clusters.length < 5) {
    throw new Error('种子库聚簇不足：' + data.clusterCount);
  }
  const shm = (data.shared || []).find(x => x.label === '简谐运动');
  if (!shm || shm.strength !== 'strong') {
    throw new Error('种子库没有「简谐运动」强共享（城市无从建）');
  }
  return data;
}

// ---------- 浏览器侧小工具 ----------
async function continentOpen(page) {
  await page.waitForFunction(() => {
    const layer = document.getElementById('continentLayer');
    return layer && !layer.hidden;
  }, null, { timeout: 8000 });
  await page.waitForFunction(() => {
    const world = document.getElementById('continentWorld');
    return world && world.children.length > 0;
  }, null, { timeout: 8000 });
}

async function inSession(page) {
  await page.waitForFunction(() => {
    const layer = document.getElementById('continentLayer');
    const bc = document.getElementById('continentBreadcrumb');
    return layer && layer.hidden && bc && !bc.hidden;
  }, null, { timeout: 8000 });
}

async function worldClass(page) {
  return page.evaluate(() => document.getElementById('continentWorld').className);
}

async function worldTransform(page) {
  return page.evaluate(() => document.getElementById('continentWorld').style.transform);
}

async function run() {
  // ===== 隔离环境：临时目录拷贝 src + 根层共享模块（data/ 在 temp 下全新生成）=====
  // main.py 把 src 与项目根都塞进 sys.path（http_client/llm_common/usage_stats 在根层），两处都要有
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-reg-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  for (const f of ['http_client.py', 'llm_common.py', 'usage_stats.py']) {
    cpSync(join(ROOT, f), join(workDir, f));
  }
  const server = spawn('python3', ['src/main.py', '-p', String(PORT)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', d => { serverLog += String(d); });
  server.stdout.on('data', d => { serverLog += String(d); });

  let browser = null;
  try {
    await waitHealth();
    await seedViaApi();

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', err => console.log('  [pageerror] ' + err.message));
    // 新库会弹新手引导遮罩（onboarding-backdrop 全屏拦截点击）——按
    // config.ONBOARDING_KEY 的口径预设「已完成」，模拟老用户，旅程不被遮罩吃掉
    await page.addInitScript(() => {
      try { localStorage.setItem('phymathia_onboarding_done', '1'); } catch (e) { /* 容忍 */ }
    });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.openContinentView === 'function', null, { timeout: 15000 });

    // ===== 1. 开图适配 =====
    try {
      await page.click('.continent-btn');           // 应用头栏的地球入口（真用户路径）
      await continentOpen(page);
      const stats = await page.evaluate(() => document.getElementById('continentStats').textContent);
      if (!stats || stats.indexOf('个区域') < 0) throw new Error('顶栏统计未渲染：' + stats);
      const cls = await worldClass(page);
      if (!/lod-(world|region|detail)/.test(cls)) throw new Error('LOD 档位类缺失：' + cls);
      const fit = await page.evaluate(() => {
        const world = document.getElementById('continentWorld');
        const vp = document.getElementById('continentViewport');
        const zoom = parseFloat((world.style.transform.match(/scale\(([\d.]+)\)/) || [])[1] || '0');
        return { zoom, vw: vp.clientWidth, ww: parseFloat(world.style.width) };
      });
      if (!(fit.zoom >= 0.15 && fit.ww * fit.zoom <= fit.vw * 1.05 + 40)) {
        throw new Error('适配可疑：zoom=' + fit.zoom + ' worldW·zoom=' + (fit.ww * fit.zoom).toFixed(0));
      }
      ok('开图适配：统计/LOD/世界罩住视口');
    } catch (e) { fail('开图适配：统计/LOD/世界罩住视口', e); }

    // ===== 2. 顶栏搜索：多命中点行跳转 =====
    try {
      await page.fill('#continentSearch', '简谐');
      await page.waitForSelector('.continent-search-row', { timeout: 4000 });
      const rows = await page.locator('.continent-search-row').count();
      if (rows < 2) throw new Error('「简谐」应多命中（≥2 行），实际 ' + rows);
      const hits = await page.locator('.continent-node.is-search-hit').count();
      if (hits < 2) throw new Error('命中高亮缺失：' + hits);
      await page.locator('.continent-search-row').first().click();
      await inSession(page);
      ok('搜索：多命中清单 + 点行下钻（跳转不猜）');
    } catch (e) { fail('搜索：多命中清单 + 点行下钻（跳转不猜）', e); }

    // ===== 3. 返回大陆：视口恢复 =====
    try {
      await page.click('#continentBreadcrumb');
      await continentOpen(page);
      ok('面包屑返回大陆');
    } catch (e) { fail('面包屑返回大陆', e); }

    // ===== 4. 搜索唯一命中回车直达 =====
    try {
      await page.fill('#continentSearch', '旋度的计算');
      await page.waitForFunction(() =>
        document.querySelectorAll('.continent-search-row').length === 1, null, { timeout: 4000 });
      await page.press('#continentSearch', 'Enter');
      await inSession(page);
      ok('搜索：唯一命中回车直达');
    } catch (e) { fail('搜索：唯一命中回车直达', e); }

    // ===== 5. 城市重逢清单：多目标逐行去看 =====
    try {
      await page.click('#continentBreadcrumb');
      await continentOpen(page);
      const city = page.locator('.continent-city').first();
      if ((await city.count()) < 1) throw new Error('种子库应有「简谐运动」边界城市');
      await city.click();
      await page.waitForSelector('.continent-popover', { timeout: 4000 });
      const goBtns = await page.locator('.continent-popover [data-go]').count();
      if (goBtns < 2) throw new Error('重逢清单应两座岛各一行，实际 ' + goBtns + ' 个「去看」');
      await page.locator('.continent-popover [data-go]').first().click();
      await inSession(page);
      ok('边界城市重逢清单：多目标逐行「去看」');
    } catch (e) { fail('边界城市重逢清单：多目标逐行「去看」', e); }

    // ===== 6. 画航线 + Ctrl+Z 撤销 =====
    try {
      await page.click('#continentBreadcrumb');
      await continentOpen(page);
      await page.click('#continentLinkBtn');
      // 两座不同岛的节点：按 data-session-id 取第一座岛与第二座岛各一张卡
      const first = page.locator('.continent-node[data-session-id="sess_shm1"]').first();
      const second = page.locator('.continent-node[data-session-id="sess_grad1"]').first();
      await first.click();
      await second.click();
      await page.waitForSelector('svg.continent-links path.continent-route', { timeout: 4000 });
      const drawn = await page.locator('path.continent-route').count();
      if (drawn < 1) throw new Error('航线未画上');
      await page.keyboard.press('Control+z');
      await page.waitForFunction(() =>
        document.querySelectorAll('path.continent-route').length === 0, null, { timeout: 4000 });
      ok('画航线 + Ctrl+Z 撤销');
    } catch (e) { fail('画航线 + Ctrl+Z 撤销', e); }

    // ===== 7. v8 归类纠正：指派 → KV 落盘 → 撤销回退 =====
    try {
      const badge = page.locator('.continent-cluster[data-session-id="sess_grad1"] .continent-domain-badge');
      if ((await badge.count()) < 1) throw new Error('梯度岛没有领域徽标（归属未算出）');
      await badge.click();
      await page.waitForSelector('.continent-popover [data-assign]', { timeout: 4000 });
      // 点一个**不是当前领域**的选项（from===to 不算纠正，正确行为不记笔）
      await page.locator('.continent-popover [data-assign]:not(.is-current)').first().click();
      // 纠正落盘是异步的（先读后写）——轮询等它落 KV，不等一锤子买卖
      await page.waitForFunction(async () => {
        const r = await fetch('/api/kv/continent_gate_weights');
        const j = await r.json();
        return !!(j.value && Array.isArray(j.value.log) && j.value.log.length >= 1);
      }, null, { timeout: 6000 });
      await wait(300);
      const kv = await (await fetch(BASE + '/api/kv/continent_gate_weights', { cache: 'no-store' })).json();
      const log = kv && kv.value && Array.isArray(kv.value.log) ? kv.value.log : [];
      if (log.length !== 1) throw new Error('纠正记录应恰 1 条，实际 ' + log.length + ' 页内=' + JSON.stringify(await page.evaluate(async () => (await (await fetch('/api/kv/continent_gate_weights', { cache: 'no-store' })).json()))).slice(0, 300));
      if (log[0].from === log[0].to) throw new Error('纠正方向 from===to：' + JSON.stringify(log[0]));
      const regions = await (await fetch(BASE + '/api/kv/continent_regions')).json();
      const assign = regions && regions.value && regions.value.assign || {};
      if (!Object.keys(assign).includes('sess_grad1')) throw new Error('指派未落 continent_regions');
      await page.keyboard.press('Control+z');
      await page.waitForFunction(async () => {
        const r = await fetch('/api/kv/continent_regions');
        const j = await r.json();
        return !j.value || !j.value.assign || !Object.keys(j.value.assign).length;
      }, null, { timeout: 5000 });
      ok('v8 归类纠正：方向落 KV + 撤销回退');
    } catch (e) { fail('v8 归类纠正：方向落 KV + 撤销回退', e); }

    // ===== 8. v8 族表编辑：新增族 → 合并视图生效 =====
    // 注意：没有弹层时按 Esc 会关掉整张大陆——用「有才关」的口径清残留弹层
    const closePopoverIfAny = async () => {
      if (await page.locator('.continent-popover').count()) await page.keyboard.press('Escape');
    };
    try {
      await closePopoverIfAny();
      await page.click('#continentFamilyBtn');
      await page.waitForSelector('.continent-family-row', { timeout: 5000 });
      const rows = await page.locator('.continent-family-row').count();
      if (rows < 25) throw new Error('内置族应 ≥25 行，实际 ' + rows);
      await page.fill('[data-family-new-name]', '分析力学');
      await page.fill('[data-family-new-terms]', '拉格朗日方程、哈密顿正则方程');
      await page.click('[data-family-new-save]');
      await page.waitForFunction(async () => {
        const r = await fetch('/api/families');
        const j = await r.json();
        return (j.families || []).some(f => f.canonical === '分析力学' && f.source === 'user');
      }, null, { timeout: 6000 });
      const domainOk = await page.evaluate(async () => {
        const r = await fetch('/api/continent', { cache: 'no-store' });
        const j = await r.json();
        return (j.domainList || []).indexOf('分析力学') >= 0;
      });
      if (!domainOk) throw new Error('新增族未进 domainList（投影没重算）');
      ok('v8 族表编辑：新增族 → /api/families 与投影同步生效');
    } catch (e) { fail('v8 族表编辑：新增族 → /api/families 与投影同步生效', e); }

    // ===== 9. LOD 三档双向切换 =====
    try {
      await closePopoverIfAny();
      // 第 8 段保存后弹层会异步重开（persist → 重拉 → 重开）：等它真开出来（或确认
      // 不开了）再关掉并等它消失，否则迟到的弹层会挡住 viewport 的 hover/滚轮
      await page.waitForSelector('.continent-popover', { timeout: 5000 }).catch(() => {});
      await closePopoverIfAny();
      await page.waitForFunction(() => !document.querySelector('.continent-popover'),
        null, { timeout: 4000 }).catch(() => {});
      // 大陆若已在上面某步被关掉，先回到大陆再缩放
      await page.evaluate(() => {
        const layer = document.getElementById('continentLayer');
        if (layer && layer.hidden && typeof window.openContinentView === 'function') {
          window.openContinentView();
        }
      });
      await continentOpen(page);
      const vp = page.locator('#continentViewport');
      for (let i = 0; i < 8; i++) await vp.hover().then(() => page.mouse.wheel(0, 600));
      await page.waitForFunction(() =>
        document.getElementById('continentWorld').classList.contains('lod-world'), null, { timeout: 4000 });
      for (let i = 0; i < 14; i++) await vp.hover().then(() => page.mouse.wheel(0, -600));
      await page.waitForFunction(() =>
        document.getElementById('continentWorld').classList.contains('lod-detail'), null, { timeout: 4000 });
      ok('LOD 三档双向切换（滚轮）');
    } catch (e) { fail('LOD 三档双向切换（滚轮）', e); }

    // ===== 10. v10 新族候选：Φ 起名 → 建族 → 族表生效 =====
    // 两个端点都在浏览器侧拦截（隔离库的向量/模型状态不影响本段）：
    //   /api/families/suggestions → 固定回一个三卡无主抱团簇；
    //   /api/models/chat → 固定回 Φ 的 new 判读 JSON。
    // 拦截只管「建议与模型」，建族落 KV / KV 状态读写都打真服务端，闭环可验。
    try {
      await closePopoverIfAny();
      // 大陆若在第 9 段被关掉，先回大陆再开族表弹层
      await page.evaluate(() => {
        const layer = document.getElementById('continentLayer');
        if (layer && layer.hidden && typeof window.openContinentView === 'function') {
          window.openContinentView();
        }
      });
      await continentOpen(page);
      await page.route('**/api/families/suggestions', r => r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          embedEnabled: true,
          suggestions: [],
          clusters: [{
            key: 'regcluster1', size: 3,
            cards: [
              { id: 'rc1', title: '纳什均衡与策略选择', summary: '' },
              { id: 'rc2', title: '囚徒困境：合作与背叛的推演', summary: '' },
              { id: 'rc3', title: '占优策略与重复博弈', summary: '' },
            ],
          }],
        }),
      }));
      await page.route('**/api/models/chat', r => r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content:
          '{"verdict":"new","name":"博弈论","terms":["纳什均衡","囚徒困境","占优策略"],"reason":"三卡共同指向策略互动分析"}' } }] }),
      }));
      await page.click('#continentFamilyBtn');
      await page.waitForSelector('[data-cluster-key="regcluster1"]', { timeout: 6000 });
      // 隔离库没配模型槽位——起名按钮的守卫（getActiveModelForRole 为空就拒）是对的；
      // 测试里临时喂一个 mock 槽位，真实请求仍走 proxyChatWithModel → 被上面的路由拦截
      await page.evaluate(() => {
        window.getActiveModelForRole = () => ({
          id: 'mockgraph', provider: 'opencode', model: 'mock-model',
          label: 'Mock Φ', apiKey: 'mock-key',
        });
      });
      await page.click('[data-cluster-key="regcluster1"] [data-cluster-name]');
      await page.waitForSelector('[data-cluster-key="regcluster1"] [data-cluster-create]', { timeout: 8000 });
      const rowText = await page.locator('[data-cluster-key="regcluster1"]').textContent();
      if (!rowText || rowText.indexOf('博弈论') < 0 || rowText.indexOf('建族') < 0) {
        throw new Error('Φ 提议名/建族按钮没渲染：' + (rowText || '').slice(0, 120));
      }
      await page.click('[data-cluster-key="regcluster1"] [data-cluster-create]');
      await page.waitForFunction(async () => {
        const r = await fetch('/api/kv/continent_families', { cache: 'no-store' });
        const j = await r.json();
        const fams = (j.value && j.value.families) || [];
        const f = fams.find(x => x.canonical === '博弈论');
        return !!(f && f.source === 'user' && (f.terms || []).indexOf('纳什均衡') >= 0);
      }, null, { timeout: 8000 });
      // 投影收敛是「最终一致」（KV 落盘与并发请求的读写有毫秒级窗口）：
      // 轮询等 domainList 收录新族，单次 fetch 会偶发读到写前快照
      await page.waitForFunction(async () => {
        const r = await fetch('/api/continent', { cache: 'no-store' });
        const j = await r.json();
        return (j.domainList || []).indexOf('博弈论') >= 0;
      }, null, { timeout: 8000 });
      await page.unroute('**/api/families/suggestions');
      await page.unroute('**/api/models/chat');
      ok('v10 新族候选：Φ 起名 → 建族 → 族表与投影同步生效');
    } catch (e) {
      try { await page.unroute('**/api/families/suggestions'); await page.unroute('**/api/models/chat'); } catch (e2) { /* 容忍 */ }
      fail('v10 新族候选：Φ 起名 → 建族 → 族表与投影同步生效', e);
    }
  } catch (err) {
    results.push(false);
    console.log('❌ 环境级失败 -> ' + (err && err.message || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill('SIGTERM'); } catch (e) { /* 容忍 */ }
    await wait(800);
    try { server.kill('SIGKILL'); } catch (e) { /* 容忍 */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 容忍 */ }
  }

  const passed = results.filter(Boolean).length;
  console.log('\n大陆真机回归：' + passed + ' / ' + results.length + ' 通过');
  if (passed !== results.length) {
    console.log('（服务端日志尾部）\n' + serverLog.split('\n').slice(-60).join('\n'));
    process.exit(1);
  }
}

run().catch(err => { console.error(err); process.exit(1); });
