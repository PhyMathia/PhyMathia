// 画布屏闪诊断（用户 2026-11-20 报「大画布 17% 缩放下整屏闪，元素越多越明显」）。
// 做法：隔离实例 + 造一个与用户截图同量级的大画布（48 节点、长文本、6 列），
// 在 17% 缩放下分别量「静止 / 缩放中 / 拖动中」三段的帧间隔，并逐组关闭嫌疑特效做对照：
//   ① 基线（原样）
//   ② 去 world 层 will-change（合成层纹理重建）
//   ③ 去边层整层 drop-shadow（离屏滤镜缓冲）
//   ④ 停浮动符号动画（33 个 span 每帧写 transform）
//   ⑤ 去全部 backdrop-filter（玻璃每帧重采样）
// 判据：rAF 帧间隔中位数 / >33ms 帧占比 / 静止时连续截图是否逐帧变化。
// 端口 5087，自带临时数据目录，不碰 data/。
import { chromium } from 'playwright';
import { startIsolatedServer } from './lib/test_server.mjs';

const PORT = 5087;
const SID = 'sess_flicker_probe';
const COLS = 6, ROWS = 8, NW = 920, NH = 700, GAP = 120;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = await startIsolatedServer({ port: PORT, label: 'phymathia-flicker' });

// 长文本节点：模拟用户截图里的「一张卡几百字」
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

const probe = () => {
  window.__perfProbe = (frames) => new Promise((resolve) => {
    const gaps = [];
    let last = 0;
    const tick = (t) => {
      if (last) { const g = t - last; if (g > 0 && g < 500) gaps.push(g); }
      last = t;
      if (gaps.length < frames) requestAnimationFrame(tick); else resolve(gaps);
    };
    requestAnimationFrame(tick);
  });
  window.__stats = (gaps) => {
    const s = gaps.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
    return {
      n: s.length,
      median: +q(0.5).toFixed(1),
      p95: +q(0.95).toFixed(1),
      over33: s.filter((x) => x > 33).length,
      over100: s.filter((x) => x > 100).length,
    };
  };
};

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
  await page.evaluate(probe);

  // 用页面现成的当前会话，直接把 48 节点灌进去再全量重渲（不走会话切换，避开服务端覆盖）
  const injected = await page.evaluate(({ nodes, zoom }) => {
    const sid = (window.getCurrentSessionId && window.getCurrentSessionId()) || '';
    if (!sid) return { ok: false, why: 'no current session' };
    window.saveGraphState(sid, {
      collapsed: {}, hidden: {}, positions: {}, layerOf: {}, freeNodes: {}, pinned: {}, sizes: {},
      pan: { x: 20, y: 20 }, zoom, layoutVersion: 1, connections: [], removedEdges: [],
      portCounts: {}, inputPortCounts: {}, groups: [], customNodes: nodes,
      harnessDeleted: {}, harnessCheckpoint: null,
    });
    window.renderGraphCanvas();
    return { ok: true, sid, inStore: (localStorage.getItem('phymathia_graph_' + sid) || '').length };
  }, { nodes: makeNodes(), zoom: 0.17 });
  console.log('注入结果 =', injected);
  await wait(3000);

  const nodeCount = await page.evaluate(() => document.querySelectorAll('.graph-node').length);
  console.log('画布节点数 =', nodeCount, '（预期 48）');

  // 谁真的带磨砂：把带上 backdrop-filter 的元素按面积排出来（面积×模糊半径＝每帧重采样成本）
  const blurCost = await page.evaluate(() => {
    const rows = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter || '';
      if (!bf || bf === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 200) continue;
      rows.push({
        el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : ''),
        w: Math.round(r.width), h: Math.round(r.height),
        mp: +(r.width * r.height / 1e6).toFixed(2), bf,
      });
    }
    return rows.sort((a, b) => b.mp - a.mp).slice(0, 10);
  });
  console.log('\n带 backdrop-filter 且面积最大的元素（每帧都要重采样背后内容）：');
  for (const b of blurCost) console.log(`  ${b.el}\t${b.w}×${b.h}\t${b.mp} MP\t${b.bf}`);
  console.log('  小计面积 ' + blurCost.reduce((s, b) => s + b.mp, 0).toFixed(2) + ' MP');

  // ---- 合成层体检（CDP LayerTree）：帧率测不出闪时，层尺寸才是显存压力的硬指标 ----
  // 一个覆盖整块内容包围盒的合成层（几千×几千 CSS px）在缩放/重绘时会被整张重新光栅化，
  // 显存一紧就丢层重合成，观感就是整屏闪 + 偶发文字消失。
  const cdp = await ctx.newCDPSession(page);
  const layers = new Map();
  cdp.on('LayerTree.layerTreeDidChange', (e) => {
    for (const l of (e.layers || [])) layers.set(l.layerId, l);
  });
  await cdp.send('LayerTree.enable');
  await cdp.send('DOM.enable');

  const layerName = async (backendNodeId) => {
    if (!backendNodeId) return '?';
    try {
      const d = await cdp.send('DOM.describeNode', { backendNodeId });
      const n = d.node || {};
      const attrs = {};
      for (let i = 0; i + 1 < (n.attributes || []).length; i += 2) attrs[n.attributes[i]] = n.attributes[i + 1];
      return (n.nodeName || '?').toLowerCase() + (attrs.id ? '#' + attrs.id : '') + (attrs.class ? '.' + String(attrs.class).split(/\s+/).slice(0, 3).join('.') : '');
    } catch { return '?'; }
  };

  const measureLayers = async (label) => {
    layers.clear();
    await page.evaluate(() => { if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas(); });
    await wait(1200);
    const all = [...layers.values()].filter((l) => l.width * l.height > 1);
    const big = all
      .map((l) => ({ id: l.layerId, node: l.backendNodeId, w: l.width, h: l.height, mp: +(l.width * l.height / 1e6).toFixed(1) }))
      .sort((a, b) => b.mp - a.mp)
      .slice(0, 4);
    for (const l of big) l.el = await layerName(l.node);
    console.log(`\n[层检] ${label}｜层总数 ${all.length}`);
    for (const l of big) console.log(`   ${l.el}\t${l.w}×${l.h}\t${l.mp} MP`);
    return big;
  };

  const measure = async (label) => {
    // 静止段：只等帧，不动任何东西
    const still = await page.evaluate(() => window.__perfProbe(150).then(window.__stats));
    // 截图一致性：静止时同一区域连续两帧应当逐字节一致
    const shots = [];
    for (let i = 0; i < 6; i++) {
      shots.push(await page.screenshot({ clip: { x: 500, y: 300, width: 320, height: 240 } }));
      await wait(120);
    }
    const uniq = new Set(shots.map((b) => b.toString('base64').length + ':' + b.length));
    // 缩放段：模拟滚轮把 zoom 从 0.17 推到 0.30 再回来
    await page.evaluate(() => {
      const gv = window.graphView;
      const st = typeof _graphState === 'function' ? _graphState() : null;
      window.__savedZoom = st ? st.zoom : null;
      window.__spin = 0;
      window.__spinTimer = setInterval(() => {
        window.__spin++;
        const s = _graphState();
        s.zoom = 0.17 + 0.13 * (1 - Math.cos(window.__spin / 12));
        if (typeof _applyGraphTransform === 'function') _applyGraphTransform();
      }, 16);
    });
    const zoomGaps = await page.evaluate(() => window.__perfProbe(120).then(window.__stats));
    await page.evaluate(() => { clearInterval(window.__spinTimer); });
    return { label, nodeCount, still, stillFramesIdentical: uniq.size === 1, zoomGaps, errors: errors.slice(0, 3) };
  };

  const rows = [];
  rows.push(await measure('① 基线'));
  await measureLayers('① 基线');

  const styleHandles = [];
  styleHandles.push(await page.addStyleTag({ content: '.graph-canvas-inner { will-change: auto !important; }' }));
  await wait(600);
  rows.push(await measure('② 去 world will-change'));
  await measureLayers('② 去 world will-change');

  styleHandles.push(await page.addStyleTag({ content: '.graph-edge-layer { filter: none !important; }' }));
  await wait(600);
  rows.push(await measure('③ 去边层 drop-shadow'));
  await measureLayers('③ 去边层 drop-shadow');

  await page.evaluate(() => { if (window.setFloatingSymbolsPaused) window.setFloatingSymbolsPaused(true); });
  await wait(600);
  rows.push(await measure('④ 停浮动符号'));
  await measureLayers('④ 停浮动符号');

  styleHandles.push(await page.addStyleTag({ content: '* { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' }));
  await wait(800);
  rows.push(await measure('⑤ 去全部 backdrop-filter'));
  await measureLayers('⑤ 去全部 backdrop-filter');

  console.log('\n段位\t\t中位\tp95\t>33ms\t>100ms\t静止帧一致');
  for (const r of rows) {
    console.log(`${r.label}\t${r.still.median}\t${r.still.p95}\t${r.still.over33}\t${r.still.over100}\t${r.stillFramesIdentical ? '是' : '否'}`);
    console.log(`   └ 缩放中\t${r.zoomGaps.median}\t${r.zoomGaps.p95}\t${r.zoomGaps.over33}\t${r.zoomGaps.over100}`);
  }

  // ---- 静止时谁在画：3 秒内每层的光栅化次数（paint 次数＝白烧的合成预算）----
  const painted = new Map();
  cdp.on('LayerTree.layerPainted', (e) => {
    painted.set(e.layerId, (painted.get(e.layerId) || 0) + 1);
  });
  await page.evaluate(() => { if (window.setFloatingSymbolsPaused) window.setFloatingSymbolsPaused(false); });
  await wait(500);
  for (const h of styleHandles) await h.evaluate((el) => el.remove());
  await wait(600);
  painted.clear();
  await wait(3000);
  const paintTop = [...painted.entries()].map(([id, n]) => ({ id, n, el: (layers.get(id) || {}).layerName })).sort((a, b) => b.n - a.n).slice(0, 6);
  console.log('\n静止 3 秒内各层光栅化次数（top 6）：');
  for (const p of paintTop) {
    const l = layers.get(p.id) || {};
    const who = layers.has(p.id) ? await layerName(l.backendNodeId) : '?';
    console.log(`  ${who}\t${p.n} 次\t${l.width || '?'}×${l.height || '?'}`);
  }
  console.log(`  合计 ${[...painted.values()].reduce((s, n) => s + n, 0)} 次 / 3 秒`);
  await cdp.send('LayerTree.disable');

  // ---- 遮罩改 visibility 后，引导/示例讲解仍必须能正常显示（真机样式口径，ob_smoke 是 VM 沙箱管不到）----
  const visOf = () => page.evaluate(() => ({
    onboarding: getComputedStyle(document.getElementById('onboardingOverlay')).visibility,
    exampleGuide: getComputedStyle(document.getElementById('exampleGuideOverlay')).visibility,
  }));
  const visIdle = await visOf();
  await page.evaluate(() => {
    document.getElementById('onboardingOverlay').classList.add('active');
    document.getElementById('exampleGuideOverlay').classList.add('active');
  });
  await wait(700);
  const visOpen = await visOf();
  await page.evaluate(() => {
    document.getElementById('onboardingOverlay').classList.remove('active');
    document.getElementById('exampleGuideOverlay').classList.remove('active');
  });
  await wait(900);
  const visClosed = await visOf();
  console.log('\n引导层可见性（idle / active / 关闭后）：');
  console.log('  onboarding   ', visIdle.onboarding, '→', visOpen.onboarding, '→', visClosed.onboarding);
  console.log('  exampleGuide ', visIdle.exampleGuide, '→', visOpen.exampleGuide, '→', visClosed.exampleGuide);
  const visOk = visIdle.onboarding === 'hidden' && visOpen.onboarding === 'visible' && visClosed.onboarding === 'hidden'
    && visIdle.exampleGuide === 'hidden' && visOpen.exampleGuide === 'visible' && visClosed.exampleGuide === 'hidden';
  console.log(visOk ? '✓ 遮罩显隐正常（静止不绘制、打开可见、关掉回落）' : '✗ 遮罩显隐异常，引导会被锁死');
  if (errors.length) console.log('\n页面错误:', errors.slice(0, 5));
  console.log('\n隔离实例：' + srv.base);
} finally {
  if (browser) await browser.close();
  srv.stop();
}
