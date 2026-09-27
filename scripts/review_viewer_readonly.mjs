#!/usr/bin/env node
// 只读外发页真机回归（playwright 驱动真浏览器，隔离数据目录）：
// 验的是 viewer-main.js 的「拓扑冻结」兜网——两次渲染之间节点/连线/分组/节点索引
// 一律不许变，位置与尺寸放行。
//
// 为什么要它：兜网之前的护栏是函数名黑名单，靠「有人实测发现漏网 → 补一条」维护，
// 已经漏过两次（拖拽建节点、Delete 键删节点）。黑名单管体验（弹 toast），兜网管
// 正确性（写不进去），所以兜网必须自己有一条能证明「拦得住」的回归——
// 尤其要同时证明它没把查看器本来该给的拖拽/平移/缩放一起拦掉。
//
// 用法：node scripts/review_viewer_readonly.mjs
// 隔离口径：临时目录里拷贝 src/（DATA_DIR 在导入期从 config.py 解析，必须真拷贝）；
// 真实 data/ 全程只读不碰。本脚本不种会话、不调模型——快照是手工造的合法 .pmu，
// 节点由 _buildGraphData 从 messages 真实派生，不是塞进 graphView 的假节点。

import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = 5078;
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

// ---- 快照：形状照 buildUtopiaSnapshot（utopia.js:117）----

function makeSnapshot() {
  const t0 = 1789300000000;
  const messages = [
    { role: 'user', content: '请详细讲解简谐振动', timestamp: t0 },
    {
      role: 'assistant', timestamp: t0 + 1000,
      content: [
        '## 物理直觉',
        '回复力与位移成正比且方向相反，于是往复运动。',
        '',
        '## 数学本质',
        '方程 $m\\ddot{x}+kx=0$，解为简谐振动。',
        '',
        '## 苏格拉底追问',
        '如果回复力不与位移成正比，运动还简谐吗？',
      ].join('\n'),
    },
  ];
  return {
    format: 'phymath-utopia/graph',
    version: 1,
    exportedAt: new Date().toISOString(),
    app: 'PhyMathia/1.4.1',
    title: '只读护栏回归用快照',
    meta: { sessionId: '', level: 'university', theme: 'dark', messagesComplete: true,
            counts: { nodes: 0, edges: 0, groups: 0, messages: messages.length } },
    viewport: { pan: { x: 80, y: 80 }, zoom: 0.9 },
    graph: { layoutVersion: 4, positions: {}, sizes: {}, collapsed: {}, hidden: {},
             pinned: {}, portCounts: {}, inputPortCounts: {}, groups: [], customNodes: [] },
    nodes: [], edges: [], groups: [],
    messages,
  };
}

async function run() {
  // ===== 隔离环境：临时目录拷贝 src + harness + 根层共享模块（data/ 在 temp 下全新生成）=====
  // main.py 把 src 与项目根都塞进 sys.path（http_client/llm_common/usage_stats 在根层），两处都要有
  const workDir = mkdtempSync(join(tmpdir(), 'phymathia-viewer-ro-'));
  cpSync(join(ROOT, 'src'), join(workDir, 'src'), { recursive: true });
  cpSync(join(ROOT, 'harness'), join(workDir, 'harness'), { recursive: true });
  for (const f of ['http_client.py', 'llm_common.py', 'usage_stats.py']) {
    cpSync(join(ROOT, f), join(workDir, f));
  }
  const proc = spawn('python3', ['src/main.py', '-p', String(PORT)], {
    cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  proc.stdout.on('data', d => { serverLog += d; });
  proc.stderr.on('data', d => { serverLog += d; });

  const browser = await chromium.launch();
  try {
    await waitHealth();

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', e => pageErrors.push(String(e && e.message || e)));
    await page.goto(BASE + '/viewer.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.utopiaViewer, null, { timeout: 15000 });

    // 装载快照
    const loaded = await page.evaluate(snap => window.utopiaViewer.loadText(JSON.stringify(snap), 'regression.pmu'),
                                      makeSnapshot());
    if (!loaded) throw new Error('快照装载失败：' + (await page.textContent('#utopiaError').catch(() => '')));
    await page.waitForTimeout(600);

    // --- 前置：兜网没把画布本身搞坏 ---
    const shape = await page.evaluate(() => ({
      nodes: (graphView.nodes || []).length,
      edges: (graphView.edges || []).length,
      rendered: document.querySelectorAll('.graph-node').length,
    }));
    if (shape.nodes < 2) throw new Error('快照没派生出节点（' + JSON.stringify(shape) + '），测的不是真画布');
    if (shape.rendered < 2) throw new Error('画布 DOM 节点数异常：' + shape.rendered);
    ok('快照装载并渲染出真实节点（' + shape.nodes + ' 节点 / ' + shape.edges + ' 连线）');

    const armed = await page.evaluate(() => typeof window.renderGraphCanvas.__utopiaTopologyWrapped === 'boolean');
    if (!armed) throw new Error('拓扑兜网没装上（renderGraphCanvas 未被包裹）');
    ok('拓扑兜网已安装（renderGraphCanvas 已包裹）');

    // --- 放行项：位置 / 平移 / 缩放必须照常 ---
    // 三项分开量：fitGraph 会把 zoom 重算回适配值，和 zoomGraph 串一起量会互相抵消
    const viewOps = await page.evaluate(() => {
      window.__UTOPIA__.blockedWrites = [];
      const node = graphView.nodes[0];
      const before = { x: node.x, y: node.y, zoom: graphView.zoom, panX: graphView.pan && graphView.pan.x };

      node.x = (node.x || 0) + 37;   // 模拟拖拽落点
      node.y = (node.y || 0) + 21;

      const zoomBefore = graphView.zoom;
      if (typeof zoomGraph === 'function') zoomGraph(1.2);
      const zoomAfter = graphView.zoom;

      graphView.pan.x = (graphView.pan.x || 0) + 53;   // 模拟平移落点
      return {
        moved: graphView.nodes[0].x === before.x + 37 && graphView.nodes[0].y === before.y + 21,
        zoomBefore, zoomAfter,
        panMoved: (graphView.pan && graphView.pan.x) === before.panX + 53,
        blocked: (window.__UTOPIA__.blockedWrites || []).slice(),
      };
    });
    if (!viewOps.moved) throw new Error('拖拽被兜网误伤：节点位置写不进去');
    if (viewOps.zoomAfter === viewOps.zoomBefore) {
      throw new Error('缩放没生效（' + viewOps.zoomBefore + ' → ' + viewOps.zoomAfter + '）');
    }
    if (!viewOps.panMoved) throw new Error('平移被兜网误伤：pan 写不进去');
    if (viewOps.blocked.length) throw new Error('视角类操作被误拦：' + viewOps.blocked.join(', '));
    ok('放行项：拖拽位置 / 缩放 / 平移都不受兜网影响，且没触发任何拦截');

    // --- 拦截项：拓扑一律写不进去 ---
    const blocked = await page.evaluate(() => {
      const U = window.__UTOPIA__;
      U.blockedWrites = [];
      const baseNodes = graphView.nodes.length;
      const baseEdges = graphView.edges.length;
      const baseKeys = Object.keys(graphView.nodeById).length;
      const firstId = graphView.nodes[0].id;
      const captured = [];

      // 1. 凭空 push 一个节点（_createBranchNodeFromOutput 走的就是这条）
      try { graphView.nodes.push({ id: 'x-injected', kind: 'draft' }); } catch (e) { captured.push('push-threw:' + e.message); }
      // 2. 整体替换成更短的数组（删除路径：graphView.nodes = nodes.filter(...)）
      try { graphView.nodes = graphView.nodes.filter(n => n.id !== firstId); } catch (e) { captured.push('reassign-threw:' + e.message); }
      // 3. splice 删节点
      try { graphView.nodes.splice(0, 1); } catch (e) { captured.push('splice-threw:' + e.message); }
      // 4. 往索引里塞新键
      try { graphView.nodeById['x-injected'] = { id: 'x-injected' }; } catch (e) { captured.push('index-set-threw:' + e.message); }
      // 5. 从索引里删键
      try { delete graphView.nodeById[firstId]; } catch (e) { captured.push('index-del-threw:' + e.message); }
      // 6. 加连线
      try { graphView.edges.push({ from: firstId, to: firstId, type: 'x' }); } catch (e) { captured.push('edge-threw:' + e.message); }
      // 7. 加分组
      try { graphView.groups.push({ id: 'g-injected', nodeIds: [] }); } catch (e) { captured.push('group-threw:' + e.message); }

      return {
        baseNodes, baseEdges, baseKeys,
        nodes: graphView.nodes.length,
        edges: graphView.edges.length,
        keys: Object.keys(graphView.nodeById).length,
        firstStillThere: !!graphView.nodeById[firstId],
        blockedWrites: (U.blockedWrites || []).slice(),
        captured,
      };
    });

    if (blocked.nodes !== blocked.baseNodes) throw new Error('节点数被改：' + blocked.baseNodes + ' → ' + blocked.nodes);
    if (blocked.edges !== blocked.baseEdges) throw new Error('连线数被改：' + blocked.baseEdges + ' → ' + blocked.edges);
    if (blocked.keys !== blocked.baseKeys) throw new Error('节点索引键数被改：' + blocked.baseKeys + ' → ' + blocked.keys);
    if (!blocked.firstStillThere) throw new Error('节点索引里的节点被删了');
    if (blocked.captured.length) throw new Error('拦截时抛了异常（应静默拒绝）：' + blocked.captured.join(', '));
    if (blocked.blockedWrites.length < 5) {
      throw new Error('拦截计数偏少（' + blocked.blockedWrites.length + '），兜网可能没生效：' + blocked.blockedWrites.join(', '));
    }
    ok('拦截项：7 条拓扑写路径全部静默拒绝并留痕（' + blocked.blockedWrites.length + ' 条）');

    // --- 用户真实手势路径：界面层也不能出变化（数据没变 ≠ 界面上没幽灵节点）---
    // 直接调被黑名单包裹的写入口，等价于用户真的拖了一下端口 / 按了 Delete。
    const gestures = await page.evaluate(() => {
      const before = document.querySelectorAll('.graph-node').length;
      const errs = [];
      const attempt = (name, fn) => {
        try { fn(); } catch (e) { errs.push(name + ':' + e.message); }
      };
      const src = graphView.nodes[0];
      const portEl = document.querySelector('.graph-node .graph-port');
      attempt('拖拽建节点', () => window._createBranchNodeFromOutput(
        src.id, 'out-0', { label: '追问', type: 'followup' }, (src.x || 0) + 400, (src.y || 0) + 200));
      attempt('Delete 删节点', () => window._deleteSelectedGraphNodes([src.id]));
      attempt('加连线', () => window._connectPorts(src.id, 'out-0', src.id, 'in-0'));
      return {
        before, after: document.querySelectorAll('.graph-node').length,
        errs,
        toastText: (document.getElementById('utopiaToast') || {}).textContent || '',
      };
    });
    if (gestures.after !== gestures.before) {
      throw new Error('界面上多/少了节点：' + gestures.before + ' → ' + gestures.after);
    }
    if (gestures.errs.length) throw new Error('手势路径抛错：' + gestures.errs.join(' | '));
    if (gestures.toastText.indexOf('只读') < 0) {
      throw new Error('没有给只读提示，用户会以为功能坏了（toast="' + gestures.toastText + '"）');
    }
    ok('手势层：拖拽建节点 / Delete / 加连线都被拦下并弹了只读提示，画面零变化');

    // --- 重渲后基线要跟着走，不能卡死 ---
    const afterRerender = await page.evaluate(() => {
      window.__UTOPIA__.blockedWrites = [];
      window.renderGraphCanvas();
      const n = graphView.nodes.length;
      let extra = 'none';
      try {
        graphView.nodes.push({ id: 'x-after' });
        if (graphView.nodes.length === n + 1) extra = 'LEAKED';
      } catch (e) { extra = 'threw:' + e.message; }
      return { n, extra, blocked: (window.__UTOPIA__.blockedWrites || []).length };
    });
    if (afterRerender.extra !== 'none') throw new Error('重渲后兜网失效：' + afterRerender.extra);
    if (afterRerender.blocked < 1) throw new Error('重渲后兜网没留痕');
    ok('重渲后基线重建，兜网继续生效');

    // --- localStorage 零污染（原有不变量，别被新代码碰坏）---
    const pollution = await page.evaluate(() => Object.keys(window.__utopiaRealLocalStorage || {}).length);
    if (pollution !== 0) throw new Error('真实 localStorage 被污染 ' + pollution + ' 键');
    ok('真实 localStorage 零污染');

    if (pageErrors.length) throw new Error('页面抛错：' + pageErrors.slice(0, 3).join(' | '));
    ok('全程无未捕获异常');
  } finally {
    await browser.close();
    proc.kill('SIGTERM');
    await wait(400);
    try { rmSync(workDir, { recursive: true, force: true }); } catch (e) {}
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} 通过`);
  if (passed !== results.length) {
    console.log('\n--- 服务日志尾部 ---\n' + serverLog.split('\n').slice(-25).join('\n'));
    process.exit(1);
  }
}

run().catch(err => { console.error('运行失败：' + (err && err.message || err)); process.exit(1); });
