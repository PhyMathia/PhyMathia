// 缩放闪烁诊断（用户 2026-11-21 报「大会话快速来回滚轮缩放会闪，Edge 明显、IAB 不复现」）。
// 与 debug_canvas_flicker.mjs（11-20，静止整屏闪＝400MP 遮罩层）互补：那支量「层面积」，
// 本支量「缩放手势期间的产品侧抖动」——
//   ① .graph-heavy-zoom 类在 zoom 跨 2.2 阈值时的翻转次数（每次翻转＝边层滤镜与全部
//      节点阴影拆掉重装，是确定性的产品侧重光栅风暴源）
//   ② 边层 computed filter 的逐帧抖动次数（样式层证据，与渲染后端无关）
//   ③ 手势期 rAF 帧间隔 vs 静止段（SwiftShader 只作参考不作判据，同 11-20 口径）
// 手势用 CDP Input.dispatchMouseEvent(mouseWheel) 发真实滚轮事件，走生产同一条
// rAF 合帧缩放链（graph-events.js wheel → zoomGraph → _applyGraphTransform）。
// 端口 5088，自带临时数据目录，不碰 data/。
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const PORT = 5088;
const SID = 'sess_zoom_flicker_probe';
const COLS = 6, ROWS = 8, NW = 920, NH = 700, GAP = 120;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startIsolatedServer({ port: PORT, label: 'phymathia-zoomflicker' });

const PARA = '在这一视角下，系统的演化由最小作用量原理决定，而对称性通过诺特定理给出守恒量。' +
  '我们把拉格朗日量写成 $L=T-V$，并对广义坐标求变分，得到欧拉-拉格朗日方程。' +
  '值得注意的是，边界项并不影响运动方程，但它决定了能量的定义方式。';
function makeNodes() {
  const nodes = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const i = c * ROWS + r;
      nodes.push({
        id: 'n' + i,
        kind: 'module',
        moduleKey: c % 2 === 0 ? 'physics' : 'math',
        content: '## 视角 ' + i + '\n\n' + PARA + '\n\n' + PARA + '\n\n' +
          '- 守恒量：能量、动量\n- 约束：完整、定常\n\n' + PARA,
        generatedAt: 1700000000000 + i,
        x: c * (NW + GAP),
        y: r * (NH + GAP),
        status: 'done',
      });
    }
  }
  return nodes;
}
function makeConnections(nodes) {
  // 46 条连线（同真实齿轮会话规模）：每列纵向串 7 条＋列间横向 6 条×相邻列
  const conns = [];
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS - 1; r++) {
      const a = nodes[c * ROWS + r], b = nodes[c * ROWS + r + 1];
      conns.push({ from: a.id, fromPort: 'out-0', to: b.id, toPort: 'in-0', type: 'custom', custom: true });
    }
  }
  for (let c = 0; c < COLS - 1; c++) {
    const a = nodes[c * ROWS], b = nodes[(c + 1) * ROWS];
    conns.push({ from: a.id, fromPort: 'out-0', to: b.id, toPort: 'in-0', type: 'custom', custom: true });
  }
  return conns.slice(0, 46);
}

let browser;
try {
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));

  await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.renderGraphCanvas === 'function', null, { timeout: 20000 });
  await wait(1500);

  const injected = await page.evaluate(({ nodes, conns, zoom }) => {
    const sid = (window.getCurrentSessionId && window.getCurrentSessionId()) || '';
    if (!sid) return { ok: false, why: 'no current session' };
    window.saveGraphState(sid, {
      collapsed: {}, hidden: {}, positions: {}, layerOf: {}, freeNodes: {}, pinned: {}, sizes: {},
      pan: { x: 20, y: 20 }, zoom, layoutVersion: 1,
      connections: conns, removedEdges: [],
      portCounts: {}, inputPortCounts: {}, groups: [], customNodes: nodes,
      harnessDeleted: {}, harnessCheckpoint: null,
    });
    window.renderGraphCanvas();
    return { ok: true, sid };
  }, { nodes: makeNodes(), conns: makeConnections(makeNodes()), zoom: 1.6 });
  console.log('注入结果 =', injected, '（起始 zoom 1.6，振荡幅度横跨 2.2 阈值）');
  await wait(2500);

  const nodeCount = await page.evaluate(() => document.querySelectorAll('.graph-node').length);
  const edgeCount = await page.evaluate(() => document.querySelectorAll('.graph-edge').length);
  console.log('画布节点数 =', nodeCount, '连线数 =', edgeCount, '（预期 48/46）');

  // 仪表：heavy-zoom 类翻转计数＋边层 computed filter 逐帧采样＋zoom 实测摆幅
  const wheelPoint = await page.evaluate(() => {
    // 滚轮锚点：画布工具栏（右下角，常驻、绝不落节点卡）——卡面 wheel 被
    // .graph-node-full-content 守卫吞掉（首跑实踩：260 tick 全被吞，flips=0）
    const tb = document.querySelector('.graph-canvas-toolbar');
    if (!tb) return null;
    const r = tb.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  console.log('滚轮锚点（工具栏中心） =', JSON.stringify(wheelPoint));

  // 诊断：注入后 zoom 到底落没落进状态与 localStorage（上一轮全程钉 0.10，先验尸再发手势）
  const zoomAudit = await page.evaluate((sid) => {
    const lsRaw = localStorage.getItem('phymathia_graph_' + sid) || '';
    let lsZoom = null;
    try { lsZoom = JSON.parse(lsRaw).zoom; } catch (e) { /* 空串等 */ }
    const before = typeof _graphState === 'function' ? _graphState().zoom : null;
    return { inMemory: before, inLocalStorage: lsZoom, lsBytes: lsRaw.length,
      canvasTransform: (document.querySelector('.graph-canvas-inner') || {}).style?.transform || '' };
  }, injected.sid);
  console.log('zoom 审计（注入后） =', JSON.stringify(zoomAudit));

  await page.evaluate(() => {
    const canvas = document.querySelector('.graph-canvas');
    window.__flips = [];
    window.__mo = new MutationObserver(() => {
      const on = canvas.classList.contains('graph-heavy-zoom');
      const last = window.__flips[window.__flips.length - 1];
      if (!last || last.to !== on) window.__flips.push({ t: performance.now(), to: on });
    });
    window.__mo.observe(canvas, { attributes: true, attributeFilter: ['class'] });

    window.__gaps = [];
    window.__last = 0;
    window.__filterSamples = { drop: 0, none: 0 };
    window.__lastFilter = '';
    window.__filterChanges = 0;
    window.__zoomMin = Infinity; window.__zoomMax = -Infinity;
    window.__zoomTrail = [];
    const tick = (t) => {
      if (window.__last) { const g = t - window.__last; if (g > 0 && g < 500) window.__gaps.push(g); }
      window.__last = t;
      const el = document.querySelector('.graph-edge-layer');
      if (el) {
        const f = getComputedStyle(el).filter;
        if (f !== window.__lastFilter) { window.__filterChanges++; window.__lastFilter = f; }
        if (f === 'none') window.__filterSamples.none++; else window.__filterSamples.drop++;
      }
      if (typeof _graphState === 'function') {
        const z = _graphState().zoom || 0;
        if (z < window.__zoomMin) window.__zoomMin = z;
        if (z > window.__zoomMax) window.__zoomMax = z;
        if (window.__zoomTrail.length < 400) window.__zoomTrail.push(+z.toFixed(3));
      }
      window.__rafId = requestAnimationFrame(tick);
    };
    window.__rafId = requestAnimationFrame(tick);
  });

  const stats = (gaps) => {
    const s = gaps.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
    return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1),
      over33: s.filter((x) => x > 33).length, over100: s.filter((x) => x > 100).length };
  };

  // 静止段（参照）。统计函数必须整体内联进页面：page.evaluate 不携带 Node 侧闭包
  const pageStats = `(gaps) => { const s = gaps.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
    return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1),
      over33: s.filter((x) => x > 33).length, over100: s.filter((x) => x > 100).length }; }`;
  const idleGaps = await page.evaluate(({ statSrc }) => new Promise((res) => {
    const statFn = eval('(' + statSrc + ')');
    const g = window.__gaps.splice(0);
    setTimeout(() => res({ kept: g.length, now: statFn(window.__gaps.slice(0, 150)) }), 2500);
  }), { statSrc: pageStats });
  console.log('\n[静止段 2.5s] rAF 间隔 =', JSON.stringify(idleGaps.now));

  // 手势段：合成 WheelEvent 直接派发到 canvas 元素（走真实 handler→rAF→zoomGraph 链）。
  // 前两版实踩：①滚轮打在卡面被 .graph-node-full-content 守卫吞掉；②工具栏不在
  // canvas 子树里、CDP wheel 到不了监听器；③注入 zoom 1.6 被启动期自动 fit（≈0.101）盖掉，
  // 手势前先直接写状态置基线。摆幅故意不到 zoom 4：无头 SwiftShader 高倍缩放一帧要数秒，
  // 跨阈值的翻转机制量得到就行，量帧成本不是本支判据（同 11-20 口径）。
  const TICKS_PER_SWING = 7; // 1.6 ×1.08^7≈2.74 ；×0.92^7≈0.89 —— 跨 2.2 的单摆
  async function wheelTick(deltaY) {
    await page.evaluate((dy) => {
      graphCanvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: dy, clientX: 720, clientY: 450, bubbles: true, cancelable: true,
      }));
    }, deltaY);
  }
  // 手势前一次性置基线 zoom=1.6（自动 fit 已在注入期把它压到 ≈0.101）。
  // 必须走应用自己的 zoomGraph：_graphState() 返回浅拷贝，直接改 .zoom 不落缓存（实踩）。
  await page.evaluate(() => {
    if (typeof zoomGraph === 'function') zoomGraph(16, null, null); // 0.101×16≈1.62，钳制内
  });
  const t0 = performance.now();
  for (let cycle = 0; cycle < 8; cycle++) {
    for (let i = 0; i < TICKS_PER_SWING; i++) { await wheelTick(-120); await wait(28); } // 放大
    for (let i = 0; i < TICKS_PER_SWING; i++) { await wheelTick(120); await wait(28); }  // 缩小
  }
  const gestureMs = performance.now() - t0;
  await wait(800);

  const out = await page.evaluate(({ statSrc }) => {
    const statFn = eval('(' + statSrc + ')');
    cancelAnimationFrame(window.__rafId);
    window.__mo.disconnect();
    const span = window.__flips.length >= 2
      ? window.__flips[window.__flips.length - 1].t - window.__flips[0].t : 1;
    return {
      flips: window.__flips.length,
      flipRatePerSec: +(window.__flips.length / Math.max(span, 1) * 1000).toFixed(1),
      filterChanges: window.__filterChanges,
      filterSamples: window.__filterSamples,
      zoomMin: window.__zoomMin, zoomMax: window.__zoomMax,
      zoomTrailHead: window.__zoomTrail.slice(0, 24).join(','),
      zoomTrailTail: window.__zoomTrail.slice(-12).join(','),
      gaps: statFn(window.__gaps),
    };
  }, { statSrc: pageStats });
  console.log('[手势段 ' + (gestureMs / 1000).toFixed(1) + 's，16 次全幅摆动]');
  console.log('  实测 zoom 摆幅 =', out.zoomMin.toFixed(2), '↔', out.zoomMax.toFixed(2),
    '（跨 2.2 阈值 =', out.zoomMin < 2.2 && out.zoomMax > 2.2 ? '是' : '否——滚轮没进缩放链！', '）');
  console.log('  zoom 轨迹头 24 帧 =', out.zoomTrailHead);
  console.log('  zoom 轨迹尾 12 帧 =', out.zoomTrailTail);
  console.log('  .graph-heavy-zoom 翻转次数 =', out.flips, '（理论 ≤16——每周期上下各跨一次）');
  console.log('  边层 computed filter 抖动次数 =', out.filterChanges, '｜none 帧数 =', out.filterSamples.none, '｜drop-shadow 帧数 =', out.filterSamples.drop);
  console.log('  手势期 rAF 间隔 =', JSON.stringify(out.gaps));
  console.log('  页面错误 =', errors.slice(0, 3));

  console.log('\n判据口径：flips / filterChanges 是产品侧确定性事实（任何机器都成立）；');
  console.log('rAF 数字是 SwiftShader 软件光栅参考值，不外推到用户 GPU（同 11-20 日志口径）。');
} finally {
  srv.stop();
  if (browser) await browser.close();
}
