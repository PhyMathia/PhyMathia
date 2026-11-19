// 画布节点数自动降级（509，2026-11-19）：节点多的大画布平移时，卡片磨砂 backdrop-filter＋
// box-shadow 在平移每帧重算，合成代价随节点数线性涨（真机量测帧间隔中位数 10 节点 16.6ms→
// 80 节点 30.6ms＝肉眼高频抖动；全关特效回 19.9ms）。节点数达到 GRAPH_HEAVY_NODES_THRESHOLD
// (60) 挂 .graph-heavy-nodes，CSS 关磨砂＋投影＋过渡（观感口径同 node-blur-lite 慢机降级，
// styles.css）。回归两面：_syncGraphHeavyClasses 行为（阈值两界＋zoom 类互不干扰＋删节点
// 回落＋canvas 缺席守卫）＋接线（pan/zoom 每帧与渲染尾部两处）与降级块/查看器载入静态契约。
import { check, drain, sandbox, vm, fs } from './_runner.mjs';

export async function run() {
check('509: _syncGraphHeavyClasses——60 挂 heavy-nodes、59 不挂、与 heavy-zoom 互不干扰、删节点回落', () => {
  const prevCanvas = vm.runInContext('typeof graphCanvas !== "undefined" ? graphCanvas : null', sandbox);
  const prevNodes = vm.runInContext('graphView.nodes', sandbox);
  try {
    vm.runInContext([
      'var __hcv = { canvas: { classList: (function(){ var s = new Set(); return { toggle: function(n, f){ if (f === undefined) f = !s.has(n); if (f) s.add(n); else s.delete(n); return f; }, contains: function(n){ return s.has(n); } }; })() } };',
      'graphCanvas = __hcv.canvas;',
    ].join('\n'), sandbox);
    const setNodes = (n) => vm.runInContext(
      'graphView.nodes = Array.from({ length: ' + n + ' }, function(_, i){ return { id: "n" + i }; });', sandbox);
    const probe = () => JSON.parse(vm.runInContext(
      'JSON.stringify({ hz: __hcv.canvas.classList.contains("graph-heavy-zoom"), hn: __hcv.canvas.classList.contains("graph-heavy-nodes") })', sandbox));

    setNodes(60);
    vm.runInContext('_syncGraphHeavyClasses(1);', sandbox);
    let r = probe();
    if (!r.hn || r.hz) throw new Error('60 节点（达阈值）应只挂 heavy-nodes：' + JSON.stringify(r));

    setNodes(59);
    vm.runInContext('_syncGraphHeavyClasses(1);', sandbox);
    r = probe();
    if (r.hn || r.hz) throw new Error('59 节点应两类都不挂：' + JSON.stringify(r));

    setNodes(10);
    vm.runInContext('_syncGraphHeavyClasses(2.3);', sandbox);
    r = probe();
    if (!r.hz || r.hn) throw new Error('zoom 2.3 + 10 节点应只挂 heavy-zoom：' + JSON.stringify(r));

    setNodes(60);
    vm.runInContext('_syncGraphHeavyClasses(2.3);', sandbox);
    r = probe();
    if (!r.hz || !r.hn) throw new Error('zoom 2.3 + 60 节点应两类都挂：' + JSON.stringify(r));

    setNodes(30);
    vm.runInContext('_syncGraphHeavyClasses(1);', sandbox);
    r = probe();
    if (r.hn || r.hz) throw new Error('缩回 30 节点 + zoom 1 应两类都摘（删节点回落）：' + JSON.stringify(r));

    // graphCanvas 缺席（画布未初始化的调用时机）不得抛
    vm.runInContext('graphCanvas = null; _syncGraphHeavyClasses(2.5);', sandbox);
    return true;
  } finally {
    vm.runInContext('graphCanvas = __hvPrevCanvas; graphView.nodes = __hvPrevNodes;', Object.assign(sandbox, {
      __hvPrevCanvas: prevCanvas,
      __hvPrevNodes: prevNodes,
    }));
  }
});

check('509: _applyGraphTransform 接线——state.zoom 与节点数共同驱动两类（pan/zoom 每帧路径）', () => {
  const prevCanvas = vm.runInContext('typeof graphCanvas !== "undefined" ? graphCanvas : null', sandbox);
  const prevInner = vm.runInContext('graphInner', sandbox);
  const prevState = vm.runInContext('_graphState', sandbox);
  const prevNodes = vm.runInContext('graphView.nodes', sandbox);
  try {
    vm.runInContext([
      'var __hcv2 = { canvas: { classList: (function(){ var s = new Set(); return { toggle: function(n, f){ if (f === undefined) f = !s.has(n); if (f) s.add(n); else s.delete(n); return f; }, contains: function(n){ return s.has(n); } }; })(), scrollTop: 0, scrollLeft: 0 } };',
      'graphCanvas = __hcv2.canvas;',
      'graphInner = { style: {} };',
      '_graphState = function(){ return { pan: { x: 0, y: 0 }, zoom: 1.5 }; };',
      'graphView.nodes = Array.from({ length: 60 }, function(_, i){ return { id: "n" + i }; });',
      '_applyGraphTransform();',
    ].join('\n'), sandbox);
    const r1 = JSON.parse(vm.runInContext('JSON.stringify({ hz: __hcv2.canvas.classList.contains("graph-heavy-zoom"), hn: __hcv2.canvas.classList.contains("graph-heavy-nodes") })', sandbox));
    if (!r1.hn || r1.hz) throw new Error('zoom 1.5 + 60 节点应只挂 heavy-nodes：' + JSON.stringify(r1));
    vm.runInContext('_graphState = function(){ return { pan: { x: 0, y: 0 }, zoom: 2.5 }; }; _applyGraphTransform();', sandbox);
    const r2 = JSON.parse(vm.runInContext('JSON.stringify({ hz: __hcv2.canvas.classList.contains("graph-heavy-zoom"), hn: __hcv2.canvas.classList.contains("graph-heavy-nodes") })', sandbox));
    if (!r2.hz || !r2.hn) throw new Error('zoom 2.5 + 60 节点应两类都挂：' + JSON.stringify(r2));
    return true;
  } finally {
    vm.runInContext([
      'graphCanvas = __hvPrevCanvas2; graphInner = __hvPrevInner2; _graphState = __hvPrevState2; graphView.nodes = __hvPrevNodes2;',
    ].join('\n'), Object.assign(sandbox, {
      __hvPrevCanvas2: prevCanvas,
      __hvPrevInner2: prevInner,
      __hvPrevState2: prevState,
      __hvPrevNodes2: prevNodes,
    }));
  }
});

check('509: 静态契约——阈值常量/两处接线/降级块三条特效/candy 悬停阴影源序/查看器载入在位', () => {
  const src = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!/const GRAPH_HEAVY_NODES_THRESHOLD = 60;/.test(src)) throw new Error('阈值常量缺失或被改值');
  if (!src.includes('_syncGraphHeavyClasses(state.zoom);')) throw new Error('_applyGraphTransform 接线缺失');
  if (!src.includes('_syncGraphHeavyClasses(state && state.zoom);')) throw new Error('_patchGraphStreaming 渲染尾部接线缺失');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const i = css.indexOf('.graph-canvas.graph-heavy-nodes .graph-node {');
  if (i < 0) throw new Error('降级块缺失');
  const block = css.slice(i, css.indexOf('}', i));
  for (const need of ['backdrop-filter: none !important', 'box-shadow: none !important', 'transition: none !important']) {
    if (!block.includes(need)) throw new Error('降级块缺 ' + need);
  }
  // candy 悬停/选中阴影与降级块同特异性 (0,3,0)，靠源序胜出保留悬停反馈——必须排在降级块后面
  const hover = css.indexOf('[data-node-skin="candy"] .graph-node:hover');
  const selected = css.indexOf('[data-node-skin="candy"] .graph-node.selected');
  if (hover < 0 || hover < i) throw new Error('candy hover 规则必须在降级块之后（源序胜出保留悬停反馈）');
  if (selected < 0 || selected < i) throw new Error('candy selected 规则必须在降级块之后（同上）');
  const viewer = fs.readFileSync('scripts/build_viewer.mjs', 'utf8');
  if (!viewer.includes("'graph-render.js'")) throw new Error('查看器构建未载 graph-render.js（降级不会进 viewer）');
  return true;
});

await drain();
}
