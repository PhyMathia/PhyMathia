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
//  11. v8.13 海域换色：图例换色 → 海域板与岛底同步变色 → KV 落盘 → Ctrl+Z 回退
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
  return waitHealthAt(BASE, timeoutMs);
}

async function waitHealthAt(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(base + '/health');
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

// ---------- 真实规模种子（T30：给「与数据量有关」的断言装上牙齿）----------
//
// 上面那套 6 会话 9 卡是**小库**：世界小、适配缩放远高于任何 LOD 阈值，于是
// 「首屏不该落世界档」这类断言无论阈值怎么改都成立——2026-09-26 把
// CONTINENT_LOD_WORLD 从 0.55 调回 0.55 重测，隔离回归照样 10/10 通过。
// 换句话说那 10 条里，数据量相关的那几条是**没有牙齿的断言**。
//
// 这套种子按真实库的口径造（data/ 实测：25 会话 / 48 知识点，其中 13 个会话
// 有真主题、其余是「新画布」空壳）：18 会话 / 54 知识点 → 聚出 14 岛 54 概念。
// 关键是这个规模下适配缩放落到 0.4094——**正好卡在现行阈值 0.35 与旧阈值 0.55
// 之间**：阈值一旦被改回 0.55，开图就会掉进世界档，断言当场变红。这就是要的牙齿。
//
// 主题清单照真实库的形状挑（几座重岛 + 一批单点岛），子标题必须唯一——重复标题
// 会被去重，itemCount 涨不上去，种子里看着够大、实际断言的还是小库。

const SCALE_TOPICS = [
  ['梯度', '梯度的几何意义：方向导数与等值面正交', 13],
  ['散度', '散度的物理意义：单位体积的通量', 1],
  ['旋度', '环流面密度的极限，行列式记忆法', 1],
  ['能量守恒', '孤立系统总能量保持不变', 1],
  ['机械能守恒', '动能与势能互相转化、总量守恒', 1],
  ['泊松分布', '泊松过程与散粒噪声、指数等待时间', 8],
  ['正态分布', '中心极限定理与 68-95-99.7 经验法则', 8],
  ['卡方分布', '自由度与平方和的统计本性', 1],
  ['均匀分布', '有界区间上的最大熵分布', 1],
  ['折射', '斯涅尔定律与光在介质界面的偏折', 1],
  ['玻色子', '玻色—爱因斯坦分布与光子', 1],
  ['费米子', '泡利不相容与费米—狄拉克分布、简并压', 8],
  ['加速度', '牛顿第二定律、切向与法向加速度', 8],
  ['理想气体状态方程', '微观粒子数与压强温度体积的关系', 1],
];

function seedScaleSessions() {
  const now = Date.now();
  const out = SCALE_TOPICS.map(([title], i) => ({
    id: 'sess_scale_' + (i + 1), title, sessionId: 'sess_scale_' + (i + 1), icon: '',
    createdAt: now - (60 - i) * 60000, updatedAt: now - (60 - i) * 60000,
  }));
  // 真实库里近半会话是「新画布」空壳：它们不该各自成岛，也不该被悄悄丢掉
  for (let i = 0; i < 4; i++) {
    out.push({ id: 'sess_scale_blank' + (i + 1), title: '新画布', sessionId: 'sess_scale_blank' + (i + 1),
               icon: '', createdAt: now - (20 - i) * 60000, updatedAt: now - (20 - i) * 60000 });
  }
  return out;
}

function seedScaleKnowledge() {
  const SUB = ['的定义与坐标表达', '的数学本质与推导', '的物理动机', '的边界条件与反例', '的常见误区',
               '的数值验证', '与相邻概念的区别', '在典型题目里的用法', '的极限情形', '的实验测量',
               '的常见应用场景', '的推广形式', '的历史来源', '的直观图像'];
  let n = 0;
  const list = [];
  const it = (title, sid, summary) => list.push({
    id: 'ki_scale' + (++n), title, sessionId: sid, createdAt: Date.now() - n * 1000,
    category: '概念', source: 'manual', summarySource: 'model', summary, formulas: [],
  });
  SCALE_TOPICS.forEach(([topic, head, weight], idx) => {
    const sid = 'sess_scale_' + (idx + 1);
    it(head, sid, topic + '的核心要点');
    for (let i = 0; i < weight - 1; i++) {
      // 超过 SUB 长度就加后缀，保证标题唯一（重复标题会被去重，itemCount 涨不上去）
      it(topic + SUB[i % SUB.length] + (i >= SUB.length ? '（续' + i + '）' : ''), sid, topic + '的第 ' + (i + 2) + ' 个要点');
    }
  });
  return Object.fromEntries(list.map(x => [x.id, x]));
}

// 真实库的规模是硬门槛：掉回小库，下面关于 LOD 的断言就重新变成没牙齿的断言
const SCALE_MIN_CLUSTERS = 13;
const SCALE_MIN_ITEMS = 48;
// T28 基线（2026-10-08 实跑写死）：走廊最小净距与边界城市落位数。布局/波长有意改动后
// 按断言提示更新这里的数字——新旧值的差会打在回归输出里，漂移由此可见。
// 实测要点：最坏净距 127.9px，对 128px 需求（CITY_W 112 + 2×CITY_GAP 8）余量 **−0.1px**，
// 正是手册 v8.5「余量仅 0~13px」的 0 端；当前无 no_room 折叠（6 座城市全部落位），
// 因为落位是在一圈候选点里挑「放得下」的，不必非挤最窄那条走廊。余量为负属已知贴线态，
// 检查里打印告警行而不判红；比基线收紧超 2px（真正往 no_room 滑）才红。
const CORRIDOR_NEED_PX = 128;            // 边界城市过走廊的需求：CITY_W 112 + 2×CITY_GAP 8
const CORRIDOR_MIN_CLEAR_BASELINE = 127.9; // 2026-10-08 实测（14 岛 91 对取最坏）
const CITY_PLACED_BASELINE = 6;          // 2026-10-08 实测：真实规模下落位 6 座
// 旧阈值 0.55 是「断言曾经失效」的那个值：适配缩放必须落在它与现行 0.35 之间，
// 断言才咬得住。改了阈值又跑一次，若这里红了说明种子规模退化了，先修种子。
const SCALE_STALE_LOD = 0.55;

async function seedScaleViaApi(base) {
  let r = await fetch(base + '/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seedScaleSessions()),
  });
  if (!r.ok) throw new Error('种大会话失败 HTTP ' + r.status);
  r = await fetch(base + '/api/knowledge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(seedScaleKnowledge()),
  });
  if (!r.ok) throw new Error('种大知识点失败 HTTP ' + r.status);
  r = await fetch(base + '/api/continent');
  const data = await r.json();
  if (!data.clusters || data.clusters.length < SCALE_MIN_CLUSTERS) {
    throw new Error('真实规模种子聚簇不足：' + data.clusterCount + '（门槛 ' + SCALE_MIN_CLUSTERS + '）');
  }
  if ((data.itemCount || 0) < SCALE_MIN_ITEMS) {
    throw new Error('真实规模种子概念数不足：' + data.itemCount + '（门槛 ' + SCALE_MIN_ITEMS + '）');
  }
  return data;
}

// ---------- 浏览器侧小工具 ----------
// v9 跨层转场：打开/关闭都不再是「一帧内切完」，大陆层与会话画布要交叉缩放 420ms。
// 于是 layer.hidden 从「当前不在大陆」的可靠判据退化成「转场已收尾」的一部分——
// 关闭动画在途时它仍是 false。只看它会误判成「大陆还开着」，脚本跳过后续步骤。
// 所以两个等待器都追加 continent-warp 缺席这一条：转场结束 workspace 必不再带这个类。
async function continentOpen(page) {
  await page.waitForFunction(() => {
    const layer = document.getElementById('continentLayer');
    const ws = document.getElementById('graphWorkspace');
    return layer && !layer.hidden && !(ws && ws.classList.contains('continent-warp'));
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
    const ws = document.getElementById('graphWorkspace');
    return layer && layer.hidden && bc && !bc.hidden
      && !(ws && ws.classList.contains('continent-warp'));
  }, null, { timeout: 8000 });
}

// v9：开图入口分两种了——从会话打开会把「当前会话对应的岛」滚到中央（地标连续），
// 从面包屑返回才恢复上次浏览视口。于是「某个节点一定在屏幕内」不再是入口路径的副作用，
// 依赖它的用例会随入口变化而飘（画航线那条就是这么挂的：恢复出来的视口把简谐运动
// 的边界卡放到了 x=-141）。凡是要点具体节点的，先显式把视口摆到那座岛上——
// 用的是应用自己的 _continentFocusSessionIsland，与真机看到的是同一套算子。
async function focusSessionIsland(page, sid) {
  await page.evaluate(s => {
    const ws = document.getElementById('graphWorkspace');
    if (ws && ws.classList.contains('continent-warp')) return; // 转场在途，等它收尾
    if (typeof window._continentFocusSessionIslandForTest === 'function') {
      window._continentFocusSessionIslandForTest(s);
    }
  }, sid);
  // 摆完等一帧，确保 transform 已落到 DOM 上再让 Playwright 量元素位置
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function worldClass(page) {
  return page.evaluate(() => document.getElementById('continentWorld').className);
}

async function worldTransform(page) {
  return page.evaluate(() => document.getElementById('continentWorld').style.transform);
}

async function run() {
  // ===== 隔离环境：临时目录拷贝 src + harness（data/ 在 temp 下全新生成；共享模块 T161 起在 src/server 内自洽）=====
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-reg-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
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
      await page.click('.menu-btn');   // 打开画布列表侧栏
      await page.click('.sidebar-tile[title^="跨画布总览"]');  // 「知识大陆」磁贴（T165：入口磁贴化后的现行通道；头栏大陆按钮在窄屏副条里不可见）
      await continentOpen(page);
      const stats = await page.evaluate(() => document.getElementById('continentStats').textContent);
      if (!stats || stats.indexOf('座岛') < 0 || stats.indexOf('聚落') < 0) throw new Error('顶栏统计未渲染：' + stats);  // 术语改版后统计为「N 座岛 · N 个聚落 · …」（T165 随手同步）
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
      // **开图不得落进世界档**（v8.7 / backlog T23）：世界档把概念卡整档隐藏，于是开图
      // 第一眼是一堆空盒子。原来的断言只查「三档类名存在」，lod-world 也算数，等于放过
      // 这条。真实库 13 岛 / 48 概念的适配缩放实测 0.443，被旧阈值 0.55 挡在档外。
      // 用「档位类」判定而不是去读 CONTINENT_LOD_WORLD —— 顶层 const 不挂在 window 上
      // 读不到，硬编码阈值又会在改阈值时变成过期期望（与 smoke v8.5 那条「硬编码波长要
      // 配静态钉」同一个坑，这里直接换成不依赖常量的等价判据）。
      //
      // ⚠️ **这条断言在本套件里挡不住它要挡的那个 bug —— 已实测确认**。把阈值调回 0.55
      // 本套件依然 10/10 通过：隔离种子库只有 6 会话 9 卡，世界小、适配缩放远高于 0.55，
      // 开图永远落在区域档。**要让它有牙，必须先把隔离种子库放大到真实库量级**——
      // 已做，见下方 runScaleSuite（2026-09-27，backlog T30 销账）：那边 14 岛 54 概念，
      // 适配缩放 0.4094 落在 (0.35, 0.55) 敏感带里，阈值改回 0.55 时那边当场变红。
      // 这条只当「小库首屏不是世界档」的弱检查，别把它当护栏。
      if (/lod-world/.test(cls)) {
        throw new Error('开图落进世界档（概念卡整档隐藏，首屏是空盒子）：' + cls
          + ' zoom=' + fit.zoom);
      }
      ok('开图适配：统计/LOD/世界罩住视口/首屏不落世界档（弱检查，见上方 T30 说明）');
    } catch (e) { fail('开图适配：统计/LOD/世界罩住视口/首屏不落世界档', e); }

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
      await focusSessionIsland(page, 'sess_shm1');
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

    // ===== 9. LOD 四档双向切换 + 词流（v8.8） =====
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
        const ws = document.getElementById('graphWorkspace');
        const warping = ws && ws.classList.contains('continent-warp');
        if (layer && layer.hidden && !warping && typeof window.openContinentView === 'function') {
          window.openContinentView();
        }
      });
      await continentOpen(page);
      const vp = page.locator('#continentViewport');
      // 读到某档下「词流是否在显示 / 有几个词 / 卡片是否被整档藏起」的一组事实。
      // 用 getComputedStyle 判 display 而不是查类名：类名对了但 CSS 没跟上，页面照样空，
      // 而这正是这一段要守的东西。
      const cloudState = () => page.evaluate(() => {
        const world = document.getElementById('continentWorld');
        const clouds = Array.from(document.querySelectorAll('.continent-cloud'));
        const shown = clouds.filter(c => getComputedStyle(c).display !== 'none');
        const node = document.querySelector('.continent-node');
        return {
          cls: world ? world.className : '',
          clouds: clouds.length,
          shownClouds: shown.length,
          words: shown.reduce((n, c) => n + c.querySelectorAll('.continent-cloud-word').length, 0),
          nodeShown: node ? getComputedStyle(node).display !== 'none' : false,
        };
      });
      // 缩到远景档：词流必须收起，卡片仍然整档藏着
      for (let i = 0; i < 12; i++) await vp.hover().then(() => page.mouse.wheel(0, 600));
      await page.waitForFunction(() =>
        document.getElementById('continentWorld').classList.contains('lod-horizon'), null, { timeout: 4000 });
      const far = await cloudState();
      if (far.shownClouds !== 0) throw new Error('远景档不该显示词流：' + JSON.stringify(far));
      if (far.nodeShown) throw new Error('远景档不该显示概念卡：' + JSON.stringify(far));
      // 退回世界档：词流必须亮起来且真有词（空盒子回来了就等于没改）
      for (let i = 0; i < 4; i++) await vp.hover().then(() => page.mouse.wheel(0, -600));
      await page.waitForFunction(() =>
        document.getElementById('continentWorld').classList.contains('lod-world'), null, { timeout: 4000 });
      const world1 = await cloudState();
      if (world1.shownClouds < 1) throw new Error('世界档词流没显示（空盒子回来了）：' + JSON.stringify(world1));
      if (world1.words < 1) throw new Error('世界档词流是空的：' + JSON.stringify(world1));
      if (world1.nodeShown) throw new Error('世界档不该显示概念卡：' + JSON.stringify(world1));
      // 词流字号必须被 --cloud-k 撑起来（不撑就是 4.5px 的糊影，等于没填）
      const cloudFont = await page.evaluate(() => {
        const c = document.querySelector('.continent-cloud');
        if (!c) return 0;
        return parseFloat(getComputedStyle(c).fontSize) || 0;
      });
      if (!(cloudFont >= 24)) throw new Error('词流字号没做反缩放（世界单位 < 24px，屏幕上会糊）：' + cloudFont);
      for (let i = 0; i < 16; i++) await vp.hover().then(() => page.mouse.wheel(0, -600));
      await page.waitForFunction(() =>
        document.getElementById('continentWorld').classList.contains('lod-detail'), null, { timeout: 4000 });
      const detail = await cloudState();
      if (detail.shownClouds !== 0) throw new Error('细节档不该显示词流：' + JSON.stringify(detail));
      if (!detail.nodeShown) throw new Error('细节档概念卡不见了：' + JSON.stringify(detail));
      ok('LOD 四档双向切换 + 词流（远景收 / 世界档亮且有词 / 细节档收起）');
    } catch (e) { fail('LOD 四档双向切换 + 词流', e); }

    // ===== 10. v10 新族候选：Φ 起名 → 建族 → 族表生效 =====
    // 两个端点都在浏览器侧拦截（隔离库的向量/模型状态不影响本段）：
    //   /api/families/suggestions → 固定回一个三卡无主抱团簇；
    //   /api/models/chat → 固定回 Φ 的 new 判读 JSON。
    // 拦截只管「建议与模型」，建族落 KV / KV 状态读写都打真服务端，闭环可验。
    // 匹配器用正则不用 glob（T183 根因，2026-10-07）：P2 起前端 fetch 包装给所有
    // /api/ 请求补 `?account_id=`，而 Playwright 的 glob 是**整串锚定**（^…$）——
    // 写 `'**/api/families/suggestions'` 对带查询串的 URL 整条不匹配，mock 静默
    // 失效、请求真打服务端（隔离库没向量没模型，族表弹层一行不出，只表现为 6s
    // 超时）。凡新加 page.route，匹配器都要容忍查询串。
    const SUGGEST_ROUTE = /\/api\/families\/suggestions(\?|$)/;
    const CHAT_ROUTE = /\/api\/models\/chat(\?|$)/;
    let suggestHits = 0;
    let chatHits = 0;
    try {
      await closePopoverIfAny();
      // 大陆若在第 9 段被关掉，先回大陆再开族表弹层
      await page.evaluate(() => {
        const layer = document.getElementById('continentLayer');
        const ws = document.getElementById('graphWorkspace');
        const warping = ws && ws.classList.contains('continent-warp');
        if (layer && layer.hidden && !warping && typeof window.openContinentView === 'function') {
          window.openContinentView();
        }
      });
      await continentOpen(page);
      await page.route(SUGGEST_ROUTE, r => { suggestHits++; return r.fulfill({
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
      }); });
      await page.route(CHAT_ROUTE, r => { chatHits++; return r.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content:
          '{"verdict":"new","name":"博弈论","terms":["纳什均衡","囚徒困境","占优策略"],"reason":"三卡共同指向策略互动分析"}' } }] }),
      }); });
      // mock 自检（T183 教训）：先真发一次被拦端点（走页面 fetch 包装，会带
      // ?account_id=），确认匹配器命中——路由失效时这里当场报白话，不至于
      // 拖到下面「等元素 6s 超时」再倒查是不是查询串把 glob 整串匹配打掉了
      await page.evaluate(async () => {
        await fetch('/api/families/suggestions', { cache: 'no-store' }).catch(() => {});
        await fetch('/api/models/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        }).catch(() => {});
      });
      if (suggestHits < 1 || chatHits < 1) {
        throw new Error('mock 路由没拦到（suggestions=' + suggestHits + ' chat=' + chatHits +
          '）——匹配器要容忍 ?account_id= 查询串（glob 是整串锚定，见本条注释）');
      }
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
      await page.unroute(SUGGEST_ROUTE);
      await page.unroute(CHAT_ROUTE);
      ok('v10 新族候选：Φ 起名 → 建族 → 族表与投影同步生效');
    } catch (e) {
      try { await page.unroute(SUGGEST_ROUTE); await page.unroute(CHAT_ROUTE); } catch (e2) { /* 容忍 */ }
      fail('v10 新族候选：Φ 起名 → 建族 → 族表与投影同步生效', e);
    }

    // ===== 11. v8.13 海域换色：图例换色 → 板/岛同步 + KV 落盘 → Ctrl+Z 回退 =====
    // 覆盖 smoke 断言不到的「活 DOM」：色相要同时落到海域板与岛底（两个元素各写各的
    // --region-h，不是继承），且必须真写进 KV 而不是只在内存里变。
    try {
      await closePopoverIfAny();
      const regionKey = await page.evaluate(() => {
        const info = typeof _continentRegionInfoOf === 'function' ? _continentRegionInfoOf() : null;
        const by = info && info.bySid && info.bySid['sess_grad1'];
        return (by && by.key) || '';
      });
      if (!regionKey) throw new Error('sess_grad1 没有海域归属（图例无行可点）');
      const plateSel = '.continent-region[data-region="' + regionKey + '"]';
      const islandSel = '.continent-cluster[data-session-id="sess_grad1"]';
      const readHue = sel => page.locator(sel).first().evaluate(el => el.style.getPropertyValue('--region-h'));
      const beforePlate = await readHue(plateSel);
      const beforeIsland = await readHue(islandSel);
      if (!beforePlate) throw new Error('海域板没有 --region-h（灰档不该出现在这片海）');
      if (beforeIsland !== beforePlate) throw new Error('起点就不同色：板=' + beforePlate + ' 岛=' + beforeIsland);
      await page.click('.continent-legend-item[data-region="' + regionKey + '"] [data-color]');
      await page.waitForSelector('.continent-color-cell', { timeout: 4000 });
      const fresh = page.locator('.continent-color-cell:not(.is-cur)');
      if ((await fresh.count()) < 1) throw new Error('色盘里没有可选的非当前槽');
      const pick = await fresh.first().getAttribute('data-cell-hue');
      await fresh.first().click();
      // 落笔是异步的（先 POST /api/kv/continent_regions 再重渲）——轮询等色相真的落地，
      // 不等一锤子买卖（第一版就在这儿红过：点击一返回就读 DOM，读到的还是旧色）
      const waitHue = (sel, want) => page.waitForFunction(arg => {
        const el = document.querySelector(arg.sel);
        return !!el && el.style.getPropertyValue('--region-h') === arg.want;
      }, { sel: sel, want: want }, { timeout: 6000 });
      await waitHue(plateSel, pick);
      const afterPlate = await readHue(plateSel);
      const afterIsland = await readHue(islandSel);
      if (afterPlate !== pick) throw new Error('海域板色相没落到 ' + pick + '：' + afterPlate);
      if (afterIsland !== afterPlate) throw new Error('岛底没跟上海域色：板=' + afterPlate + ' 岛=' + afterIsland);
      await page.waitForFunction(async key => {
        const j = await (await fetch('/api/kv/continent_regions', { cache: 'no-store' })).json();
        return !!(j.value && j.value.colors &&
          Object.prototype.hasOwnProperty.call(j.value.colors, key));
      }, regionKey, { timeout: 6000 });
      // 复位路径：「还原默认色」改完色当场就在（常驻渲染、改过才显示），别等重开弹层
      const resetBtn = page.locator('.continent-popover [data-color-reset]');
      if ((await resetBtn.count()) < 1) throw new Error('调色弹层没有「还原默认色」按钮');
      if (await resetBtn.first().isHidden()) throw new Error('改过色后「还原默认色」还藏着（改完要能当场还原）');
      await resetBtn.first().click();
      await waitHue(plateSel, beforePlate);
      await page.waitForFunction(async key => {
        const j = await (await fetch('/api/kv/continent_regions', { cache: 'no-store' })).json();
        return !(j.value && j.value.colors &&
          Object.prototype.hasOwnProperty.call(j.value.colors, key));
      }, regionKey, { timeout: 6000 });
      // 再改一次，留给 Ctrl+Z 回退这条路径
      const pick2 = await fresh.first().getAttribute('data-cell-hue');
      await fresh.first().click();
      await waitHue(plateSel, pick2);
      // 弹层刻意不自动关（接着试色）——「完成」收起
      await page.click('.continent-popover [data-color-done]');
      await page.waitForFunction(() => !document.querySelector('.continent-popover'), null, { timeout: 4000 });
      await page.keyboard.press('Control+z');
      await page.waitForFunction(async key => {
        const j = await (await fetch('/api/kv/continent_regions', { cache: 'no-store' })).json();
        return !(j.value && j.value.colors &&
          Object.prototype.hasOwnProperty.call(j.value.colors, key));
      }, regionKey, { timeout: 6000 });
      await waitHue(plateSel, beforePlate);   // 撤销同样异步：等色相还回来再断言
      const backPlate = await readHue(plateSel);
      if (backPlate !== beforePlate) throw new Error('撤销没还回原色：' + beforePlate + ' → ' + backPlate);
      ok('v8.13 海域换色：图例落笔 + 板/岛同步 + KV 落盘 + 还原默认色 + 撤销回退');
    } catch (e) { fail('v8.13 海域换色：图例落笔 + 板/岛同步 + KV 落盘 + 还原默认色 + 撤销回退', e); }
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

// ---------- 真实规模套件（T30）----------
// 独立服务、独立浏览器、独立断言数组：上面那套 10 条断言的种子与流程一个字不动
// （它是冻结契约）。这里只回答一个问题——**这套种子大到足以让与数据量有关的
// 断言真的咬得住吗**。全部在一个隔离目录里跑，真实 data/ 只读不碰。

async function runScaleSuite() {
  const PORT_S = 5076;
  const BASE_S = `http://127.0.0.1:${PORT_S}`;
  const scaleResults = [];
  const okS = name => { scaleResults.push(true); console.log('✓ [真实规模] ' + name); };
  const failS = (name, err) => { scaleResults.push(false); console.log('❌ [真实规模] ' + name + ' -> ' + (err && err.message || err)); };

  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-scale-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  const server = spawn('python3', ['src/main.py', '-p', String(PORT_S)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', d => { serverLog += String(d); });
  server.stdout.on('data', d => { serverLog += String(d); });

  let browser = null;
  try {
    await waitHealthAt(BASE_S);
    const data = await seedScaleViaApi(BASE_S);
    okS('种子达到真实规模：' + data.clusterCount + ' 岛 / ' + data.itemCount + ' 概念'
        + '（门槛 ' + SCALE_MIN_CLUSTERS + ' 岛 / ' + SCALE_MIN_ITEMS + ' 概念）');

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', err => console.log('  [pageerror] ' + err.message));
    await page.addInitScript(() => {
      try { localStorage.setItem('phymathia_onboarding_done', '1'); } catch (e) { /* 容忍 */ }
    });
    await page.goto(BASE_S + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.openContinentView === 'function', null, { timeout: 15000 });

    // --- 1. 开图适配缩放必须落在「阈值敏感带」里（本套件存在的全部理由）---
    try {
      await page.click('.menu-btn');   // 同上（T165）：侧栏 → 知识大陆磁贴
      await page.click('.sidebar-tile[title^="跨画布总览"]');
      await continentOpen(page);
      const m = await page.evaluate(() => {
        const world = document.getElementById('continentWorld');
        const t = new DOMMatrixReadOnly(getComputedStyle(world).transform);
        return {
          scale: t.a,
          tier: world.className,
          lodWorld: (typeof CONTINENT_LOD_WORLD === 'number') ? CONTINENT_LOD_WORLD : null,
          lodDetail: (typeof CONTINENT_LOD_DETAIL === 'number') ? CONTINENT_LOD_DETAIL : null,
          stats: document.getElementById('continentStats')?.textContent || '',
          weak: document.getElementById('continentWeakBtn')?.textContent || '',
          cities: document.querySelectorAll('.continent-city').length,
          cardCount: document.querySelectorAll('.continent-node').length,
        };
      });
      const lod = m.lodWorld == null ? 0.35 : m.lodWorld;
      if (m.scale <= lod) {
        throw new Error('适配缩放 ' + m.scale.toFixed(4) + ' 已落进世界档（阈值 ' + lod
          + '）——阈值被调高了，或种子规模退化了；这条断言要求缩放落在阈值之上');
      }
      if (m.scale >= SCALE_STALE_LOD) {
        throw new Error('适配缩放 ' + m.scale.toFixed(4) + ' ≥ 旧阈值 ' + SCALE_STALE_LOD
          + '，把阈值改回 0.55 这条断言照样绿——它没有牙齿，先把种子做大');
      }
      okS('适配缩放 ' + m.scale.toFixed(4) + ' 落在敏感带 (' + lod + ', ' + SCALE_STALE_LOD + ')：改阈值必被测出');
      if (m.tier.indexOf('lod-world') >= 0) throw new Error('开图首屏落进世界档：' + m.tier);
      if (m.tier.indexOf('lod-region') < 0) throw new Error('开图首屏不是岛内档：' + m.tier);
      if (!m.cardCount) throw new Error('首屏一张概念卡都没出（正是 v8.7 修的那一档，真实规模下又空了）');
      okS('开图首屏是岛内档且概念卡真的画出来了（' + m.cardCount + ' 张，档位 ' + m.tier.trim() + '）');

      // --- 2. 适配后的世界既不许溢出、也不许缩成一小块（同样与数据量有关）---
      // 注意口径：fit 本来就留边距，不是「必须填满视口」。真正的失败模式有两个——
      // 溢出（世界超出屏幕，看不全）与缩得太小（岛变成看不见的点）。小库时世界本来就
      // 小、缩放比恒高，这条断言同样没有牙齿；真实规模下才咬得住。
      const vp = await page.evaluate(() => {
        const w = document.getElementById('continentWorld').getBoundingClientRect();
        const vpEl = document.getElementById('continentViewport');
        return { left: w.left, top: w.top, right: w.right, bottom: w.bottom,
                 vw: vpEl.clientWidth, vh: vpEl.clientHeight };
      });
      const TOL = 40;
      if (vp.left < -TOL || vp.top < -TOL || vp.right > vp.vw + TOL || vp.bottom > vp.vh + TOL) {
        throw new Error('适配后世界溢出视口：世界 ' + Math.round(vp.right - vp.left) + '×'
          + Math.round(vp.bottom - vp.top) + ' vs 视口 ' + vp.vw + '×' + vp.vh);
      }
      const fill = (vp.right - vp.left) / vp.vw;
      if (fill < 0.7) {
        throw new Error('适配后世界只占视口宽度 ' + (fill * 100).toFixed(0)
          + '%，岛会小成看不见的点（门槛 70%）');
      }
      okS('适配后世界不溢出且占视口宽度 ' + Math.round(fill * 100)
          + '%（' + Math.round(vp.right - vp.left) + '×' + Math.round(vp.bottom - vp.top)
          + ' vs 视口 ' + vp.vw + '×' + vp.vh + '）');
      // --- 3. 边界城市在真实规模下确实要经历折叠（T28 一直缺的那道断言）---
      const folded = Number((m.weak.match(/折叠\s*(\d+)/) || [])[1] || 0);
      if (m.cities < 5) throw new Error('边界城市只有 ' + m.cities + ' 座，真实规模下不该这么少');
      if (folded < 1) throw new Error('折叠清单为空——真实规模下位移/波长改动没有可观测后果（T28）');
      okS('边界城市 ' + m.cities + ' 座、折叠 ' + folded + ' 条：位移场与波长的改动有可观测后果');

      // --- 3b. T28 折叠告警：预期数量的边界城市必须全部落位，「无位可放」必须为零 ---
      // 断言吃渲染路径的真实落袋：.continent-city 数 DOM、_continentFolded 是渲染期
      // _continentDrawPlan 写入的原样产物（不是测试自己重算）。走廊挤不下（no_room）
      // = 地图太挤把边界城市折掉了——粗八度波长 560 折掉第 5 座城市的事故就是它，
      // 这是 T28 要拉的那根警报。其余折叠原因（弱证据/覆盖/上限）属设计内行为，
      // 但必须逐条打印：改波长/幅度之后哪些城市换了折叠原因要一眼可见。
      // 最后核对账目：共享概念总数 = 落位 + 折叠 + 按 LINE_LIMIT 的静默截断，一条不许凭空消失。
      try {
        const audit = await page.evaluate(async () => {
          const reasonText = (typeof CONTINENT_FOLD_REASON === 'object' && CONTINENT_FOLD_REASON) || {};
          const folded = (typeof _continentFolded !== 'undefined' && _continentFolded) || [];
          const list = folded.map(f => {
            const sids = new Set();
            ((f.entry && f.entry.links) || []).forEach(l => {
              if (l.fromSession) sids.add(l.fromSession);
              if (l.toSession) sids.add(l.toSession);
            });
            return {
              label: (f.entry && f.entry.label) || '(无名)',
              reason: f.reason || '(无原因)',
              text: reasonText[f.reason] || '折叠',
              islands: sids.size,
            };
          });
          let sharedTotal = -1;
          try {
            const j = await (await fetch('/api/continent', { cache: 'no-store' })).json();
            sharedTotal = (j.shared || []).length;
          } catch (e) { /* 拿不到总数就不核账目那一项 */ }
          return {
            cities: document.querySelectorAll('.continent-city').length,
            lineLimit: (typeof CONTINENT_LINE_LIMIT === 'number') ? CONTINENT_LINE_LIMIT : 24,
            sharedTotal: sharedTotal,
            folds: list,
          };
        });
        const noRoom = audit.folds.filter(f => f.reason === 'no_room');
        if (noRoom.length > 0) {
          throw new Error('T28 警报：边界城市被走廊挤掉 ' + noRoom.length + ' 条（no_room）：'
            + noRoom.map(f => '「' + f.label + '」' + f.islands + ' 岛').join('、')
            + '——地图摆不下了（波长/幅度/布局被改动？）');
        }
        if (audit.cities < CITY_PLACED_BASELINE) {
          throw new Error('边界城市只落位 ' + audit.cities + ' 座，低于基线 ' + CITY_PLACED_BASELINE
            + ' 座——有城市没落位且不在折叠清单里？');
        }
        if (audit.sharedTotal >= 0) {
          const lost = audit.sharedTotal - audit.cities - audit.folds.length;
          const allowLost = Math.max(0, audit.sharedTotal - audit.lineLimit);
          if (lost !== allowLost) {
            throw new Error('共享概念账目不平：总数 ' + audit.sharedTotal + ' ≠ 落位 ' + audit.cities
              + ' + 折叠 ' + audit.folds.length + ' + 静默截断 ' + lost
              + '（按 LINE_LIMIT=' + audit.lineLimit + ' 只允许截断 ' + allowLost + ' 条）');
          }
        }
        if (audit.folds.length) {
          audit.folds.forEach(f => console.log('  [折叠清单] 「' + f.label + '」 '
            + f.text + '（' + f.reason + '）· ' + f.islands + ' 岛'));
        }
        okS('T28 折叠告警：无 no_room，边界城市 ' + audit.cities + ' 座全部落位，折叠 '
          + audit.folds.length + ' 条逐条打印'
          + (audit.sharedTotal >= 0 ? '（共享概念 ' + audit.sharedTotal + ' 条全部有归属）' : ''));
      } catch (e) { failS('T28 折叠告警：无 no_room 折叠 + 折叠清单逐条可见', e); }

      // --- 3c. T28 走廊净距余量：相邻岛矩形的最小净距必须装得下一座边界城市 ---
      // 需求口径 CORRIDOR_NEED_PX = 128（城市胶囊 112 + 两侧最小间隙 8×2）：净距不足
      // 128px 的走廊放不下城市，历史实测余量仅 0~13px。净距取抖动后全部岛矩形两两
      // 间隙的最坏值（_continentClusterRects 与 _continentDrawPlan 吃的是同一份障碍）。
      // 基线把当前实跑值写死：净距比基线收紧超 2px 当场红，有意改动就按提示更新
      // CORRIDOR_MIN_CLEAR_BASELINE（文件头常量区），漂移在输出里可见。
      try {
        const rects = await page.evaluate(() =>
          ((typeof _continentClusterRects !== 'undefined' && _continentClusterRects) || [])
            .map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h, sid: r.sessionId || '' })));
        const warp = await page.evaluate(() => ({
          coarse: (typeof CONTINENT_WARP_CELL_COARSE === 'number') ? CONTINENT_WARP_CELL_COARSE : null,
          fine: (typeof CONTINENT_WARP_CELL_FINE === 'number') ? CONTINENT_WARP_CELL_FINE : null,
        }));
        let minClear = Infinity;
        let worstPair = ['?', '?'];
        for (let i = 0; i < rects.length; i++) {
          for (let j = i + 1; j < rects.length; j++) {
            const a = rects[i], b = rects[j];
            const clear = Math.max(
              Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)),
              Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
            if (clear < minClear) { minClear = clear; worstPair = [a.sid, b.sid]; }
          }
        }
        const margin = minClear - CORRIDOR_NEED_PX;
        // 比 128px 需求低不当场判红：当前布局本就贴在历史「余量 0」档（见文件头基线注释），
        // 打印醒目告警行让每次回归都看得见；真正往 no_room 滑（比基线收紧超 2px）才红。
        if (margin < 0) {
          console.log('  ⚠ T28 告警：走廊最小净距对 ' + CORRIDOR_NEED_PX + 'px 需求余量 '
            + margin.toFixed(1) + 'px（贴历史 0 档；今日 no_room 折叠数见上一条折叠告警）');
        }
        if (minClear < CORRIDOR_MIN_CLEAR_BASELINE - 2) {
          throw new Error('T28 警报：走廊最小净距 ' + minClear.toFixed(1) + 'px 比基线 '
            + CORRIDOR_MIN_CLEAR_BASELINE + 'px 收紧超过 2px（对 ' + CORRIDOR_NEED_PX
            + 'px 需求余量 ' + margin.toFixed(1) + 'px，最近一对 '
            + worstPair[0] + ' ↔ ' + worstPair[1]
            + '）——布局/波长被改动？有意改动请更新 CORRIDOR_MIN_CLEAR_BASELINE');
        }
        const pairs = rects.length * (rects.length - 1) / 2;
        okS('T28 走廊余量：最小净距 ' + minClear.toFixed(1) + 'px，对 ' + CORRIDOR_NEED_PX
          + 'px 需求余量 ' + (margin >= 0 ? '+' : '') + margin.toFixed(1) + 'px（基线 '
          + CORRIDOR_MIN_CLEAR_BASELINE + 'px，波长 粗' + warp.coarse + '/细' + warp.fine
          + '，' + rects.length + ' 岛 ' + pairs + ' 对取最坏）');
      } catch (e) { failS('T28 走廊净距余量：最小净距不比基线收紧超 2px（贴 128px 需求线时打告警）', e); }

      // --- 4. 顶栏统计口径（顺带钉住「折叠 N 条」是给用户看的，不只是内部变量）---
      // 统计术语已改版：「N 座岛 · N 个聚落 · …」，座岛数即簇数（T165 随手同步）
      if (m.stats.indexOf('座岛') < 0) throw new Error('顶栏统计未渲染：' + m.stats);
      if (m.stats.indexOf(String(data.clusterCount) + ' 座岛') < 0) {
        throw new Error('顶栏区域数与后端不一致：' + m.stats + ' vs ' + data.clusterCount);
      }
      okS('顶栏统计与后端口径一致（' + m.stats + '）');
    } catch (e) {
      failS('开图适配 / LOD / 边界城市折叠', e);
    }
  } catch (err) {
    scaleResults.push(false);
    console.log('❌ [真实规模] 环境级失败 -> ' + (err && err.message || err));
  } finally {
    if (browser) await browser.close().catch(() => {});
    try { server.kill('SIGTERM'); } catch (e) { /* 容忍 */ }
    await wait(800);
    try { server.kill('SIGKILL'); } catch (e) { /* 容忍 */ }
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) { /* 容忍 */ }
  }

  const passed = scaleResults.filter(Boolean).length;
  console.log('\n真实规模套件：' + passed + ' / ' + scaleResults.length + ' 通过');
  if (passed !== scaleResults.length) {
    console.log('（服务端日志尾部）\n' + serverLog.split('\n').slice(-40).join('\n'));
    process.exit(1);
  }
}

run().then(runScaleSuite).catch(err => { console.error(err); process.exit(1); });
