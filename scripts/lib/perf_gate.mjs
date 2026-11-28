// 性能门禁核心（2026-11-25，P0）：把 debug_canvas_flicker.mjs／debug_zoom_flicker.mjs
// 两支诊断的「输出给人看＋末尾打勾」升级成会失败的闸门。那两支没有断言、没有 exit
// code、也不在任何验证档里——400 MP 遮罩层（11-20）那种「层面积魔数」「阈值翻转」
// 事故回归了，只能等用户再报一次。
//
// 断言五项硬指标（门限＝11-20/11-21 修复后实测基线＋一档余量）：
//   指标                    基线              上限     挡的是什么事故
//   单层最大面积            30.2–30.6 MP      ≤45 MP   遮罩/背景再写 9999px 类魔数（11-20 两个 400 MP 层，9× 余量）
//   层总数（48 节点）       131（11-25）      ≤240     逐节点成层之外无界长新层
//   手势期 heavy-zoom 翻转  2                 ≤3       滞回带/滚轮手势窗失效，阈值附近反复拆装特效（11-21 修前翻转 10 次）
//   边层 filter 抖动        3                 ≤4       边层整层 drop-shadow 被反复拆装（11-21 修前 11 次）
//   静止帧间隔 p95          66.7 ms（11-25）  ≤100 ms  静止成灾难级卡顿（同步布局风暴/失控动画）
// 前四项与渲染后端无关（层几何与类翻转是产品侧确定性事实），但**单层最大面积的光栅
// 范围随合成器启发式波动**：2026-11-25 健康树实测 30.2–30.6 MP（graph-canvas-inner），
// 11-20 修后是 9.2 MP——期间产品侧只发生了「摘层」（023236d，514 关闭面板 visibility，
// 层总数 231→131），没有增层回归；节点层光栅范围也在 4–8 MP 波动。故门限对齐当下
// 健康值（45＝健康值 1.5 倍），不再对齐 11-20 的 9.2——按 12 上限会把今天的健康树
// 永久打红。若日后再见 100 MP 量级＝真回归（20000² 元素级），45–400 之间仍留全判断空间。
// 第五项同理对齐当下：2026-11-25 健康树静止 p95＝66.7 ms（中位同值，逐次复测稳定，
// 负载 4.5/24 核不变）——机理：023236d 摘面板层后 SwiftShader 给世界层的光栅范围涨
// 3.3×，可见磨砂（页头/侧栏等 backdrop-filter）每帧重采样的大底图随之涨价，去掉全部
// backdrop-filter 即回 16.7 ms/0 长帧（与 11-20 对照组一致）。SwiftShader 绝对帧成本
// 不外推真机 GPU（11-20 口径），故 p95 门限是「灾难探针」（>100 ms＝同步布局风暴/
// 失控动画级事故）而非 60fps 保证；详见 backlog 609。
//
// 场景与量法完全照搬两支诊断（改场景＝改基线，必须两支诊断与 LIMITS 一起重定）：
//   层检＋静止帧段：48 节点／6 列长文本、无连线（11-20 用户截图场景，基线都出自
//     这个配置——连线会加边层，别混进层检段）；注入的 zoom 0.17 会被新画布自动
//     fit 压到 ≈0.113，层检前用 zoomGraph 钉回 0.17（钉与不钉层总数差 ~10 层）；
//   手势段：追加 46 连线、zoom 基线 ≈1.6 起摆 ×1.12^7↔×0.88^7 跨 2.0–2.2 滞回带
//     （2/3 两个基线出自 debug_zoom_flicker.mjs 这个配置）。
//
// 用法：npm run perf:gate（入口 scripts/perf_gate.mjs 薄壳）。不并入 verify（要
// 浏览器、近一分钟），按 AGENTS 硬规则 4「性能档」口径在改画布 CSS/JS 时手动跑一次。
// 隔离实例口径（T415）：自带临时数据目录第二实例，绝不连真机 5050。
import { chromium } from 'playwright';
import { startIsolatedServer } from './test_server.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 门限表（唯一事实源）。改门限先读 docs/dev/canvas-modules.md 当日节——门限跟着
// 基线走，基线跟着场景走，别单方面动一边。
export const PERF_GATE_LIMITS = [
  { key: 'maxLayerMp', name: '单层最大面积', unit: 'MP', limit: 45, baseline: '30.2–30.6（2026-11-25 健康树；SwiftShader 光栅范围有波动，9999px 类事故是 400）' },
  { key: 'layerTotal', name: '层总数（48 节点）', unit: '层', limit: 240, baseline: '131（2026-11-25，514 摘关闭面板层后；11-20 修后是 231）' },
  { key: 'flips', name: '手势期 heavy-zoom 翻转', unit: '次', limit: 3, baseline: '2（11-21 滞回带＋手势窗修后＝挂起一次＋复原一次）' },
  { key: 'filterChanges', name: '边层 filter 抖动', unit: '次', limit: 4, baseline: '3（同上）' },
  { key: 'idleP95Ms', name: '静止帧间隔 p95', unit: 'ms', limit: 100, baseline: '66.7（2026-11-25 健康树，逐次稳定；去全部磨砂即回 16.7）' },
];

// —— 场景造景（照搬 debug_canvas_flicker.mjs，两支诊断同款 48 节点长文本）——
const COLS = 6, ROWS = 8, NW = 920, NH = 700, GAP = 120;
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

// 图状态注入（两支诊断同款：走应用自己的 saveGraphState＋renderGraphCanvas，
// 不走会话切换避开服务端覆盖）。顶层函数＋数据全走 arg——page.evaluate 按
// toString() 序列化函数，工厂闭包里捕获的变量到不了页面（会 ReferenceError）。
function injectInPage({ zoom, conns, nodes }) {
  const sid = (window.getCurrentSessionId && window.getCurrentSessionId()) || '';
  if (!sid) return { ok: false, why: 'no current session' };
  window.saveGraphState(sid, {
    collapsed: {}, hidden: {}, positions: {}, layerOf: {}, freeNodes: {}, pinned: {}, sizes: {},
    pan: { x: 20, y: 20 }, zoom, layoutVersion: 1, connections: conns, removedEdges: [],
    portCounts: {}, inputPortCounts: {}, groups: [], customNodes: nodes,
    harnessDeleted: {}, harnessCheckpoint: null,
  });
  window.renderGraphCanvas();
  return { ok: true };
}

// rAF 帧间隔探针（照搬 debug_canvas_flicker.mjs 的 __perfProbe/__stats；
// stats 函数必须整体内联进页面：page.evaluate 不携带 Node 侧闭包）
const STATS_SRC = `(gaps) => { const s = gaps.slice().sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))] || 0;
  return { n: s.length, median: +q(0.5).toFixed(1), p95: +q(0.95).toFixed(1),
    over33: s.filter((x) => x > 33).length, over100: s.filter((x) => x > 100).length }; }`;
const PROBE_SRC = `(frames) => new Promise((resolve) => {
  const gaps = []; let last = 0;
  const tick = (t) => {
    if (last) { const g = t - last; if (g > 0 && g < 500) gaps.push(g); }
    last = t;
    if (gaps.length < frames) requestAnimationFrame(tick); else resolve(gaps);
  };
  requestAnimationFrame(tick);
})`;

// 合成滚轮一档（照搬 debug_zoom_flicker.mjs：WheelEvent 直发 graphCanvas 元素，
// 走真实 handler→rAF→zoomGraph 链；dispatchEvent 直达元素不落节点拾取，不会被
// .graph-node-full-content 守卫吞掉——11-21 首跑 260 tick 全被吞的实踩）
const wheelTick = (page, dy) => page.evaluate((deltaY) => {
  graphCanvas.dispatchEvent(new WheelEvent('wheel', {
    deltaY, clientX: 720, clientY: 450, bubbles: true, cancelable: true,
  }));
}, dy);

export async function runPerfGate({ port = 5091 } = {}) {
  const srv = await startIsolatedServer({ port, label: 'phymathia-perf-gate' });
  let browser;
  const metrics = {};
  const invalid = [];  // 量测有效性问题：场景没搭起来，数字不可信（也算失败）
  const failures = []; // 真超门限
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message)));

    await page.goto(srv.base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.renderGraphCanvas === 'function', null, { timeout: 20000 });
    await wait(1500);

    // ——段一：层检＋静止帧（11-20 配置：无连线、zoom 0.17，三个基线出自这里）——
    const injected = await page.evaluate(injectInPage, { zoom: 0.17, conns: [], nodes: makeNodes() });
    await wait(3000);
    if (!injected.ok) invalid.push('图状态注入失败：' + injected.why);

    const counts = await page.evaluate(() => ({
      nodes: document.querySelectorAll('.graph-node').length,
      edges: document.querySelectorAll('.graph-edge').length,
    }));
    if (counts.nodes !== 48) invalid.push('节点数 ' + counts.nodes + ' ≠ 48，层指标与基线不可比');
    if (counts.edges !== 0) invalid.push('层检段不该有连线（实测 ' + counts.edges + ' 条），231 基线是无连线配置');

    // 静止帧 p95（先量帧再开 CDP，层事件流不掺进帧段）
    await page.evaluate(`(() => { window.__perfProbe = ${PROBE_SRC}; })()`);
    const still = await page.evaluate((src) => window.__perfProbe(150).then((g) => eval('(' + src + ')')(g)), STATS_SRC);
    metrics.idleP95Ms = still.p95;
    metrics.idleMedianMs = still.median;
    if (still.n < 100) invalid.push('静止帧样本只有 ' + still.n + '/150（机器太慢或掉帧过多），p95 不可信');

    // 层检前把 zoom 钉回 0.17（注入值被新画布 needsFit 自动 fit 压到 ≈0.113，
    // 实测钉与不钉层总数差 ~10 层；钉住才与场景口径自洽。_graphState() 是浅拷贝，
    // 直接改 .zoom 不落缓存——必须走 zoomGraph，11-21 实踩）
    metrics.layerPhaseZoom = +(await page.evaluate(() => {
      const z0 = (typeof _graphState === 'function' && _graphState().zoom) || 0;
      if (z0 > 0 && typeof zoomGraph === 'function') zoomGraph(0.17 / z0, null, null);
      return (typeof _graphState === 'function' && _graphState().zoom) || 0;
    })).toFixed(3);
    if (Math.abs(metrics.layerPhaseZoom - 0.17) > 0.01) invalid.push('层检段 zoom 钉制失败（实测 ' + metrics.layerPhaseZoom + '），层指标口径漂移');

    // 合成层体检（CDP LayerTree；照搬 debug_canvas_flicker.mjs measureLayers：
    // clear → 全量重渲 → 等 1200ms → 数 layerTreeDidChange 累积到的层）
    const cdp = await ctx.newCDPSession(page);
    const layers = new Map();
    cdp.on('LayerTree.layerTreeDidChange', (e) => {
      for (const l of (e.layers || [])) layers.set(l.layerId, l);
    });
    await cdp.send('LayerTree.enable');
    await cdp.send('DOM.enable');
    layers.clear();
    await page.evaluate(() => { if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas(); });
    await wait(1200);
    const all = [...layers.values()].filter((l) => l.width * l.height > 1);
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
    if (!all.length) invalid.push('层表为空（本轮没收到 layerTreeDidChange），层指标无效');
    const sorted = all.map((l) => ({ w: l.width, h: l.height, mp: l.width * l.height / 1e6, node: l.backendNodeId }))
      .sort((a, b) => b.mp - a.mp);
    metrics.layerTotal = all.length;
    metrics.maxLayerMp = sorted.length ? +sorted[0].mp.toFixed(1) : 0;
    if (sorted.length) metrics.maxLayerEl = await layerName(sorted[0].node) + ' ' + sorted[0].w + '×' + sorted[0].h;
    await cdp.send('LayerTree.disable');
    await cdp.send('DOM.disable');

    // ——段二：手势（11-21 配置：追加 46 连线、zoom 基线 ≈1.6 起摆跨滞回带）——
    const injected2 = await page.evaluate(injectInPage, { zoom: 0.17, conns: makeConnections(makeNodes()), nodes: makeNodes() });
    if (!injected2.ok) invalid.push('手势段连线注入失败：' + injected2.why);
    await wait(1500);
    const edgeCount = await page.evaluate(() => document.querySelectorAll('.graph-edge').length);
    if (edgeCount !== 46) invalid.push('连线数 ' + edgeCount + ' ≠ 46，手势段场景不对');

    // 仪表：heavy-zoom 类翻转（MutationObserver）＋边层 computed filter 逐帧采样＋zoom 摆幅
    await page.evaluate(() => {
      const canvas = document.querySelector('.graph-canvas');
      window.__flips = [];
      window.__mo = new MutationObserver(() => {
        const on = canvas.classList.contains('graph-heavy-zoom');
        const last = window.__flips[window.__flips.length - 1];
        if (!last || last.to !== on) window.__flips.push({ t: performance.now(), to: on });
      });
      window.__mo.observe(canvas, { attributes: true, attributeFilter: ['class'] });
      window.__filterChanges = 0;
      window.__lastFilter = '';
      window.__zoomMin = Infinity; window.__zoomMax = -Infinity;
      const tick = () => {
        const el = document.querySelector('.graph-edge-layer');
        if (el) {
          const f = getComputedStyle(el).filter;
          if (f !== window.__lastFilter) { window.__filterChanges++; window.__lastFilter = f; }
        }
        if (typeof _graphState === 'function') {
          const z = _graphState().zoom || 0;
          if (z < window.__zoomMin) window.__zoomMin = z;
          if (z > window.__zoomMax) window.__zoomMax = z;
        }
        window.__rafId = requestAnimationFrame(tick);
      };
      window.__rafId = requestAnimationFrame(tick);
    });
    // 手势基线 ≈1.6（自动 fit 可能已把 zoom 压到 fit 值，按当前值折算倍率；
    // 必须走应用自己的 zoomGraph——_graphState() 返回浅拷贝，直接改 .zoom 不落缓存）
    await page.evaluate(() => {
      const z0 = (typeof _graphState === 'function' && _graphState().zoom) || 0;
      if (z0 > 0 && typeof zoomGraph === 'function') zoomGraph(1.6 / z0, null, null);
    });
    // 8 周期单摆：1.6 ×1.12^7≈3.54、×0.88^7≈0.65——每周期都跨 2.0–2.2 滞回带
    //（同 11-21 探针口径；摆幅故意不到 zoom 4，无头 SwiftShader 高倍缩放一帧数秒）
    const TICKS_PER_SWING = 7;
    for (let cycle = 0; cycle < 8; cycle++) {
      for (let i = 0; i < TICKS_PER_SWING; i++) { await wheelTick(page, -120); await wait(28); } // 放大
      for (let i = 0; i < TICKS_PER_SWING; i++) { await wheelTick(page, 120); await wait(28); } // 缩小
    }
    // 手势窗（180ms）＋复原定时器（+30ms）必须在这段等待里走完，复原翻转才算得全
    await wait(1000);
    const gesture = await page.evaluate(() => {
      cancelAnimationFrame(window.__rafId);
      window.__mo.disconnect();
      return {
        flips: window.__flips.length,
        filterChanges: window.__filterChanges,
        zoomMin: window.__zoomMin, zoomMax: window.__zoomMax,
      };
    });
    metrics.flips = gesture.flips;
    metrics.filterChanges = gesture.filterChanges;
    metrics.swingMin = +gesture.zoomMin.toFixed(2);
    metrics.swingMax = +gesture.zoomMax.toFixed(2);
    if (!(gesture.zoomMin < 2.0 && gesture.zoomMax > 2.2)) {
      invalid.push('手势摆幅 ' + metrics.swingMin + '↔' + metrics.swingMax + ' 没跨 2.0–2.2 滞回带——滚轮没进缩放链，翻转/滤镜指标无效（11-21 实踩：坐标落卡面会被守卫吞、置基线必须走 zoomGraph）');
    }
    if (errors.length) invalid.push('页面报错 ' + errors.length + ' 条：' + errors.slice(0, 2).join(' | '));
  } finally {
    if (browser) await browser.close();
    srv.stop();
  }

  // ——断言——
  const lines = [];
  for (const spec of PERF_GATE_LIMITS) {
    const v = metrics[spec.key];
    if (v === undefined) { invalid.push('指标 ' + spec.key + ' 没量到（前段崩溃？）'); continue; }
    const ok = v <= spec.limit;
    lines.push((ok ? '✓' : '✗') + ' ' + spec.name.padEnd(14, '　') + ' ' + String(v).padStart(6) + ' ' + spec.unit
      + '　（≤' + spec.limit + '，基线 ' + spec.baseline + '）');
    if (!ok) failures.push(spec.name + ' 实测 ' + v + ' ' + spec.unit + ' 超上限 ' + spec.limit + '（基线 ' + spec.baseline + '）');
  }

  console.log('\n== perf:gate 性能门禁（48 节点／6 列长文本场景，隔离实例 ' + srv.port + '）==');
  console.log('层检＋静止帧段：无连线 zoom 0.17（11-20 配置）｜手势段：46 连线，zoom ' + metrics.swingMin + '↔' + metrics.swingMax + ' 跨 2.0–2.2 滞回带（11-21 配置）');
  for (const l of lines) console.log(l);
  if (metrics.maxLayerEl) console.log('  最大层：' + metrics.maxLayerEl);
  console.log('  静止帧中位 ' + metrics.idleMedianMs + ' ms');
  const allProblems = [...invalid.map((s) => '〔量测无效〕' + s), ...failures.map((s) => '〔超门限〕' + s)];
  if (allProblems.length) {
    console.log('\n未过（' + allProblems.length + ' 项）：');
    for (const p of allProblems) console.log('  ✗ ' + p);
    console.log('\n层面积/翻转类红灯＝真回归，改法先读 docs/dev/canvas-modules.md 层归属与缩放降级两节；');
    if (failures.some((s) => s.startsWith('单层最大面积'))) {
      console.log('单层面积红灯先看上表「最大层」元素名：遮罩/背景类元素＋百 MP 量级＝9999px 类魔数回归；');
      console.log('graph-canvas-inner 45–60 MP 量级＝SwiftShader 光栅范围波动（先重跑一次再定）。');
    }
    console.log('静止帧 p95 红灯＝静止时出现 >100ms 级长帧（同步布局风暴/失控动画量级），');
    console.log('先对照 debug_canvas_flicker.mjs 的对照组段（去 will-change/边滤镜/磨砂）定位涨价来源。');
  } else {
    console.log('\n性能门禁全绿（5/5）。');
  }
  return { ok: allProblems.length === 0, metrics, failures: allProblems };
}
