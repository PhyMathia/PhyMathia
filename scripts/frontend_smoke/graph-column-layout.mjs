// 画布列几何（2026-11-20 用户拍板，试验台验证后移植）：列是唯一事实源。
// 列宽 = 本列最宽节点 + 左右呼吸边 40；列缝 32；节点一律落列心；空列不建列；
// 层号可负数/超深度/半层（两端建列、中间插列）；变宽右移、变窄或最宽换人回移。
// 行为用例全同步钉桩，接线用例静态断言；冒烟收尾必须全字段还原全局。
import { check, drain, sandbox, vm, fs } from './_runner.mjs';

export async function run() {
const BASE = [
  { id: 'a', x: 0, y: 0, w: 200, h: 80 },   // 层0
  { id: 'b', x: 0, y: 0, w: 300, h: 90 },   // 层1（本列最宽）
  { id: 'c', x: 0, y: 200, w: 160, h: 70 }, // 层1
  { id: 'd', x: 0, y: 0, w: 220, h: 80 },   // 层2
];
const EDGES = [];
const LAYER_OF = { a: 0, b: 1, c: 1, d: 2 };

function capture() {
  return {
    nodes: vm.runInContext('graphView.nodes', sandbox),
    edges: vm.runInContext('graphView.edges', sandbox),
    groups: vm.runInContext('graphView.groups', sandbox),
    byId: vm.runInContext('graphView.nodeById', sandbox),
    state: vm.runInContext('_graphState', sandbox),
    upd: vm.runInContext('typeof _updateNodeTransforms !== "undefined" ? _updateNodeTransforms : null', sandbox),
    redraw: vm.runInContext('typeof _redrawEdges !== "undefined" ? _redrawEdges : null', sandbox),
    fit: vm.runInContext('typeof _fitAllGroupsToMembers !== "undefined" ? _fitAllGroupsToMembers : null', sandbox),
    measure: vm.runInContext('typeof _measureNodes !== "undefined" ? _measureNodes : null', sandbox),
    undo: vm.runInContext('typeof _pushGraphUndo !== "undefined" ? _pushGraphUndo : null', sandbox),
    saveState: vm.runInContext('typeof _saveGraphState !== "undefined" ? _saveGraphState : null', sandbox),
    fitGraph: vm.runInContext('typeof fitGraph !== "undefined" ? fitGraph : null', sandbox),
    bands: vm.runInContext('typeof _scheduleGraphLayerBands !== "undefined" ? _scheduleGraphLayerBands : null', sandbox),
    inner: vm.runInContext('graphInner', sandbox),
  };
}
function restore(prev) {
  vm.runInContext([
    'graphView.nodes = __gcPrevNodes;',
    'graphView.edges = __gcPrevEdges;',
    'graphView.groups = __gcPrevGroups;',
    'graphView.nodeById = __gcPrevById;',
    'graphView.dragNodeId = null; graphView.dragGroupId = null;',
    '_graphState = __gcPrevState;',
    '_updateNodeTransforms = __gcPrevUpd;',
    '_redrawEdges = __gcPrevRedraw;',
    '_fitAllGroupsToMembers = __gcPrevFit;',
    '_measureNodes = __gcPrevMeasure;',
    '_pushGraphUndo = __gcPrevUndo;',
    '_saveGraphState = __gcPrevSaveState;',
    'fitGraph = __gcPrevFitGraph;',
    '_scheduleGraphLayerBands = __gcPrevBands;',
    'graphInner = __gcPrevInner;',
  ].join(' '), Object.assign(sandbox, {
    __gcPrevNodes: prev.nodes, __gcPrevEdges: prev.edges, __gcPrevGroups: prev.groups,
    __gcPrevById: prev.byId, __gcPrevState: prev.state, __gcPrevUpd: prev.upd,
    __gcPrevRedraw: prev.redraw, __gcPrevFit: prev.fit, __gcPrevMeasure: prev.measure,
    __gcPrevUndo: prev.undo, __gcPrevSaveState: prev.saveState, __gcPrevFitGraph: prev.fitGraph,
    __gcPrevBands: prev.bands, __gcPrevInner: prev.inner,
  }));
}
function seed(opts) {
  const options = opts || {};
  const nodes = (options.nodes || BASE).map(n => ({ ...n }));
  const groups = options.groups || [];
  vm.runInContext([
    'graphView.nodes = __gcSeed.nodes;',
    'graphView.edges = __gcSeed.edges;',
    'graphView.groups = __gcSeed.groups;',
    'graphView.nodeById = {};',
    'graphView.nodes.forEach(function(n){ graphView.nodeById[n.id] = n; });',
    'graphView.dragNodeId = null; graphView.dragGroupId = null;',
    '__gcState = { layerOf: __gcSeed.layerOf, freeNodes: __gcSeed.freeNodes, positions: {}, sizes: {}, groups: [], pinned: {} };',    '_graphState = function(){ return __gcState; };',
    '__gcUpdates = []; __gcRedraws = 0; __gcFits = 0; __gcFitGraph = 0; __gcSavedState = null;',
    '_updateNodeTransforms = function(ids){ __gcUpdates.push((ids || []).slice()); };',
    '_redrawEdges = function(){ __gcRedraws++; };',
    '_fitAllGroupsToMembers = function(){ __gcFits++; (graphView.groups || []).forEach(function(g){ _fitGroupToMembers(g); }); };',
    '_measureNodes = function(){};',
    '_pushGraphUndo = function(){};',
    '_saveGraphState = function(st){ __gcSavedState = st; };',
    'fitGraph = function(){ __gcFitGraph++; };',
    '_scheduleGraphLayerBands = function(){};',
    'graphInner = null;',
  ].join('\n'), Object.assign(sandbox, {
    __gcSeed: {
      nodes, edges: options.edges || EDGES, groups,
      // 每轮都给新的归属表：提交口会原地改这些对象，共享常量会被前一个用例污染。
      layerOf: Object.assign({}, options.layerOf || LAYER_OF),
      freeNodes: Object.assign({}, options.freeNodes || {}),
    },
  }));
  return nodes;
}
function columns() {
  return JSON.parse(vm.runInContext('JSON.stringify(_graphColumns().map(function(c){ return { layer:c.layer, left:c.left, width:c.width, cx:c.cx, ids:c.members.map(function(n){ return n.id; }) }; }))', sandbox));
}
function target(id) {
  return JSON.parse(vm.runInContext('JSON.stringify(_graphColumnTargetForNode(graphView.nodeById["' + id + '"]))', sandbox));
}
function nodeXs() {
  return JSON.parse(vm.runInContext('JSON.stringify(graphView.nodes.reduce(function(a,n){ a[n.id] = n.x; return a; }, {}))', sandbox));
}

check('列几何: 列宽随最宽节点、窄节点居中、列缝 32 不放大', () => {
  const prev = capture();
  try {
    seed();
    const cols = columns();
    if (cols.length !== 3) throw new Error('应有 3 列：' + JSON.stringify(cols));
    if (cols[0].width !== 280 || cols[1].width !== 380 || cols[2].width !== 300) {
      throw new Error('列宽应 = 最宽节点 + 左右各 40：' + JSON.stringify(cols));
    }
    if (cols[1].left !== 312 || cols[2].left !== 724) throw new Error('列缝应为 32：' + JSON.stringify(cols));
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    const xs = nodeXs();
    if (xs.b !== 502 || xs.c !== 502) throw new Error('同列窄卡必须居中于列心 502：' + JSON.stringify(xs));
    if (xs.a !== 140 || xs.d !== 874) throw new Error('节点 x 一律列心：' + JSON.stringify(xs));
    return true;
  } finally { restore(prev); }
});

check('列判定: 框内回原列（偏左也行）/ 缝里插半层 / 两端外侧建列', () => {
  const prev = capture();
  try {
    const nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[2].x = 330; // 层1列框 [312,692] 内偏左
    let t = target('c');
    if (t.newCol || t.layer !== 1) throw new Error('框内偏左应回原列：' + JSON.stringify(t));
    nodes[2].x = 700; // 层1右缘 692 与层2左缘 724 之间
    t = target('c');
    if (!t.newCol || t.dir !== 'middle' || t.layer !== 1.5 || t.index !== 2) {
      throw new Error('缝里应插层号 1.5 的新列：' + JSON.stringify(t));
    }
    nodes[2].x = 1145; // 层2右缘 1024 + 121 > 120
    t = target('c');
    if (!t.newCol || t.dir !== 'right' || t.layer !== 3) throw new Error('右外侧应建层3：' + JSON.stringify(t));
    nodes[2].x = -121; // 层0左缘 0 - 121
    t = target('c');
    if (!t.newCol || t.dir !== 'left' || t.layer !== -1) throw new Error('左外侧应建层-1：' + JSON.stringify(t));
    return true;
  } finally { restore(prev); }
});

check('空列消失 + 覆盖层号不夹不取整：跳号排序、无占位列', () => {
  const prev = capture();
  try {
    seed({
      nodes: BASE.slice(0, 3),
      layerOf: { a: 0, b: 2, c: 2.5 },
    });
    const cols = columns();
    if (cols.length !== 3 || cols[0].layer !== 0 || cols[1].layer !== 2 || cols[2].layer !== 2.5) {
      throw new Error('空层1不该建列、层号不重编号也不取整：' + JSON.stringify(cols));
    }
    if (cols[1].left !== 312 || cols[2].left !== 724) {
      throw new Error('空列消失后右列应左移贴紧、半层排在 2 之后：' + JSON.stringify(cols));
    }
    const map = JSON.parse(vm.runInContext('JSON.stringify(_graphLayerIndexMap(graphView.nodes, graphView.edges, _graphLayerOverrides()))', sandbox));
    if (map.b !== 2 || map.c !== 2.5) throw new Error('覆盖值不得取整：' + JSON.stringify(map));
    return true;
  } finally { restore(prev); }
});

check('尺寸跟随: 最宽节点变窄到换人→列宽回收、右侧回移；再变宽→右移', () => {
  const prev = capture();
  try {
    const nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].w = 120; // 比同列 c(160) 还窄，最宽节点换人
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    let cols = columns();
    if (cols[1].width !== 240) throw new Error('列宽应回收到 160+80=240：' + JSON.stringify(cols));
    if (cols[2].left !== 584) throw new Error('右列应回移 140：' + JSON.stringify(cols));
    const xs = nodeXs();
    if (xs.d !== 734 || xs.b !== 432 || xs.c !== 432) throw new Error('列心应同步回收：' + JSON.stringify(xs));
    nodes[1].w = 500;
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    cols = columns();
    if (cols[1].width !== 580 || cols[2].left !== 924) throw new Error('变宽应重新撑列并右移：' + JSON.stringify(cols));
    if (vm.runInContext('__gcUpdates.length', sandbox) < 2) throw new Error('被挪节点必须写 transform');
    if (vm.runInContext('__gcRedraws', sandbox) < 2) throw new Error('挪了别人必须补画线');
    if (vm.runInContext('__gcFits', sandbox) < 2) throw new Error('组框必须随成员重算');
    return true;
  } finally { restore(prev); }
});

check('钉住节点与层带: fixedX 同步；层带读列宽，不再有 320 下限', () => {
  const prev = capture();
  try {
    const nodes = seed();
    nodes[3].pinned = true;
    nodes[3].fixedX = 874;
    nodes[3].fixedY = 0;
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].w = 120;
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    if (nodes[3].fixedX !== 734) throw new Error('钉住节点 fixedX 必须同步，否则下次存盘失忆：' + nodes[3].fixedX);
    const bands = JSON.parse(vm.runInContext('JSON.stringify(_graphLayerBands())', sandbox));
    if (bands.length !== 3) throw new Error('层带应随列，空列不画：' + JSON.stringify(bands));
    if (bands[2].width !== 300 || bands[2].left !== 584) throw new Error('层带左缘/宽度必须等于列几何：' + JSON.stringify(bands));
    if (bands[0].top === 0 || bands[0].height < 1) throw new Error('层带纵向范围应覆盖全图：' + JSON.stringify(bands));
    return true;
  } finally { restore(prev); }
});

check('旧让位别名: _squeezeLayersRightForNode 也走整列重算（变窄会回移）', () => {
  const prev = capture();
  try {
    const nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].w = 120;
    vm.runInContext('_squeezeLayersRightForNode(graphView.nodes[1], { preX: 420, preW: 300 })', sandbox);
    const xs = nodeXs();
    if (xs.d !== 734) throw new Error('旧别名不该再只往右推：' + JSON.stringify(xs));
    return true;
  } finally { restore(prev); }
});

check('自由节点: 不算列成员、不撑列宽、不被整列重算吸回列心', () => {
  const prev = capture();
  try {
    seed({
      nodes: BASE.concat([{ id: 'e', x: 1234, y: 777, w: 900, h: 120 }]),
      freeNodes: { e: 1 },
    });
    const cols = columns();
    if (cols.length !== 3) throw new Error('自由节点不该建列：' + JSON.stringify(cols));
    if (cols.some(c => c.ids.indexOf('e') !== -1)) throw new Error('自由节点被算进列成员：' + JSON.stringify(cols));
    if (cols[1].width !== 380) throw new Error('自由节点宽度撑大了列宽：' + JSON.stringify(cols));
    const map = JSON.parse(vm.runInContext('JSON.stringify(_graphLayerIndexMap(graphView.nodes, graphView.edges, _graphLayerOverrides()))', sandbox));
    if (Object.prototype.hasOwnProperty.call(map, 'e')) throw new Error('自由节点不该有层号：' + JSON.stringify(map));
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    const xs = nodeXs();
    if (xs.e !== 1234) throw new Error('自由节点被整列重算吸回列心：' + JSON.stringify(xs));
    return true;
  } finally { restore(prev); }
});

check('层带范围: 自由节点仍计入全图上下界', () => {
  const prev = capture();
  try {
    seed({
      nodes: BASE.concat([{ id: 'e', x: 3000, y: 5000, w: 200, h: 100 }]),
      freeNodes: { e: 1 },
    });
    const range = JSON.parse(vm.runInContext('JSON.stringify(_graphBandRange())', sandbox));
    if (range.top + range.height < 5000 + 50 + 96 - 1) {
      throw new Error('层带没覆盖自由节点：' + JSON.stringify(range));
    }
    return true;
  } finally { restore(prev); }
});

check('自动整理: 列归属/列内顺序不变、48 缝、整列居中、自由卡不动', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 140, y: 50, w: 200, h: 80 },
        { id: 'b', x: 502, y: 400, w: 300, h: 90 },
        { id: 'c', x: 502, y: -200, w: 160, h: 70 },
        { id: 'd', x: 874, y: -300, w: 220, h: 80 },
        { id: 'e', x: 1234, y: 777, w: 900, h: 120 },
      ],
      layerOf: { a: 0, b: 1, c: 1, d: 2 },
      freeNodes: { e: 1 },
    });
    nodes[0].pinned = true;
    nodes[4].pinned = true;
    vm.runInContext('autoArrangeGraph()', sandbox);
    const st = vm.runInContext('__gcState', sandbox);
    if (st.layerOf.a !== 0 || st.layerOf.b !== 1 || st.layerOf.c !== 1 || st.layerOf.d !== 2) {
      throw new Error('整理改了列归属：' + JSON.stringify(st.layerOf));
    }
    if (st.freeNodes.e !== 1) throw new Error('整理吞了自由标记：' + JSON.stringify(st.freeNodes));
    const cols = columns();
    if (cols.length !== 3) throw new Error('整理新建了列：' + JSON.stringify(cols));
    if (!(nodes[2].y < nodes[1].y)) throw new Error('列内上下顺序应保留 c 在上：' + JSON.stringify([nodes[2].y, nodes[1].y]));
    if (nodes[2].x !== 502 || nodes[1].x !== 502) throw new Error('同列成员应回列心：' + JSON.stringify([nodes[1].x, nodes[2].x]));
    const gap = (nodes[1].y - nodes[1].h / 2) - (nodes[2].y + nodes[2].h / 2);
    if (Math.abs(gap - 48) > 0.51) throw new Error('列内缝应统一 48：' + gap);
    const top = Math.min(nodes[1].y - 45, nodes[2].y - 35);
    const bottom = Math.max(nodes[1].y + 45, nodes[2].y + 35);
    if (Math.abs(top + bottom) > 1) throw new Error('整列应垂直居中到 y=0：' + JSON.stringify([top, bottom]));
    if (nodes[0].pinned || nodes[0].fixedX != null) throw new Error('列成员的钉住应被整理清掉');
    if (!nodes[4].pinned || nodes[4].x !== 1234 || nodes[4].y !== 777) throw new Error('自由节点被动过：' + JSON.stringify(nodes[4]));
    const saved = vm.runInContext('__gcSavedState', sandbox);
    if (!saved || !saved.positions || saved.positions.e.x !== 1234 || saved.positions.e.y !== 777) {
      throw new Error('自由节点坐标没落档：' + JSON.stringify(saved && saved.positions));
    }
    if (vm.runInContext('__gcFitGraph', sandbox) !== 1) throw new Error('整理收尾必须 fitGraph');
    return true;
  } finally { restore(prev); }
});

check('自动整理: 物理列框外归最近列，不新建列', () => {
  const prev = capture();
  try {
    const nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[3].x = 5000; // 层2 的卡被甩到最右
    vm.runInContext('autoArrangeGraph()', sandbox);
    const st = vm.runInContext('__gcState', sandbox);
    if (st.layerOf.d !== 2) throw new Error('框外节点应归最近列 2：' + JSON.stringify(st.layerOf));
    if (columns().length !== 3) throw new Error('整理不该新建列：' + JSON.stringify(columns()));
    if (nodes[3].x !== 874) throw new Error('最近列成员应回列心：' + nodes[3].x);
    return true;
  } finally { restore(prev); }
});

check('自动整理: 分组成员各归其列、组框随成员重算、不掉组', () => {
  const prev = capture();
  try {
    const b = { id: 'b', x: 502, y: 400, w: 300, h: 90 };
    const c = { id: 'c', x: 502, y: -200, w: 160, h: 70 };
    const group = { id: 'g1', name: 'g', nodeIds: ['b', 'c'], x: 0, y: 0, width: 100, height: 100 };
    const nodes = seed({
      nodes: [{ id: 'a', x: 140, y: 0, w: 200, h: 80 }, b, c, { id: 'd', x: 874, y: 0, w: 220, h: 80 }],
      groups: [group],
      layerOf: { a: 0, b: 1, c: 1, d: 2 },
    });
    vm.runInContext('autoArrangeGraph()', sandbox);
    const g = vm.runInContext('graphView.groups[0]', sandbox);
    if (JSON.stringify(g.nodeIds) !== '["b","c"]') throw new Error('整理改了分组成员：' + JSON.stringify(g.nodeIds));
    const escaped = g.nodeIds.filter(id => {
      const n = nodes.find(x => x.id === id);
      return !(n.x - n.w / 2 >= g.x - 0.01 && n.y - n.h / 2 >= g.y - 0.01
        && n.x + n.w / 2 <= g.x + g.width + 0.01 && n.y + n.h / 2 <= g.y + g.height + 0.01);
    });
    if (escaped.length) throw new Error('成员被整理搬出组框：' + JSON.stringify(escaped));
    return true;
  } finally { restore(prev); }
});

check('归属提交: 单卡框内归列、Alt 自由、多选框外自由、落列前先摘自由标记', () => {
  const prev = capture();
  try {
    // 单卡：列框内 → 归该列
    let nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    vm.runInContext('_commitGraphNodeOwnership([graphView.nodeById["c"]], { mode: "single" })', sandbox);
    let st = vm.runInContext('__gcState', sandbox);
    if (st.layerOf.c !== 1 || st.freeNodes.c) throw new Error('单卡框内应归列1：' + JSON.stringify(st));
    // 单卡 Alt：自由，坐标保留
    nodes[2].x = 1234;
    nodes[2].y = 321;
    vm.runInContext('_commitGraphNodeOwnership([graphView.nodeById["c"]], { mode: "single", forceFree: true })', sandbox);
    st = vm.runInContext('__gcState', sandbox);
    if (!st.freeNodes.c || st.layerOf.c != null) throw new Error('Alt 应自由且清层号：' + JSON.stringify(st));
    if (nodes[2].x !== 1234 || nodes[2].y !== 321) throw new Error('Alt 不该改坐标');
    // 多选：框内归列、缝里自由，不建新列
    nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].x = 502;
    nodes[2].x = 700; // b 在列1框内，c 在列1/2 缝里
    vm.runInContext('_commitGraphNodeOwnership([graphView.nodeById["b"], graphView.nodeById["c"]], { mode: "multi" })', sandbox);
    st = vm.runInContext('__gcState', sandbox);
    if (st.layerOf.b !== 1 || st.freeNodes.b) throw new Error('多选框内应归列1：' + JSON.stringify(st));
    if (!st.freeNodes.c || st.layerOf.c != null) throw new Error('多选缝里应自由：' + JSON.stringify(st));
    if (columns().length !== 3) throw new Error('多选落点不该新建列：' + JSON.stringify(columns()));
    // 多选 Alt：全部自由
    nodes = seed();
    vm.runInContext('_commitGraphNodeOwnership([graphView.nodeById["b"], graphView.nodeById["c"]], { mode: "multi", forceFree: true })', sandbox);
    st = vm.runInContext('__gcState', sandbox);
    if (!st.freeNodes.b || !st.freeNodes.c || st.layerOf.b != null || st.layerOf.c != null) {
      throw new Error('多选 Alt 应全部自由：' + JSON.stringify(st));
    }
    // 自由卡拖进列：先摘自由标记，宽度立即计入列宽
    nodes = seed({
      nodes: BASE.concat([{ id: 'e', x: 1234, y: 0, w: 900, h: 120 }]),
      freeNodes: { e: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[4].x = 502;
    vm.runInContext('_commitGraphNodeOwnership([graphView.nodeById["e"]], { mode: "single" })', sandbox);
    st = vm.runInContext('__gcState', sandbox);
    if (st.freeNodes.e || st.layerOf.e !== 1) throw new Error('自由卡落列后应摘自由标记：' + JSON.stringify(st));
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    const cols = columns();
    if (cols[1].width !== 980) throw new Error('落列后宽度必须计入列宽：' + JSON.stringify(cols));
    if (nodes[4].x !== 802 || nodes[1].x !== 802 || nodes[2].x !== 802) {
      throw new Error('落列后应回新列心 802：' + JSON.stringify([nodes[1].x, nodes[2].x, nodes[4].x]));
    }
    return true;
  } finally { restore(prev); }
});

check('重建收尾: needsFit 静默落列心后必须补刷 transform（首帧 DOM 不脱节）', () => {
  // renderGraphCanvas 的 rAF 收尾：needsFit（无存档坐标，新会话首渲必走）时
  // _runLayout(true) 先把 transform 写到力学模拟位，随后 realign 静默把模型
  // 挪到列心——挪了就必须有 transform 调用跟在后面，否则首帧 DOM 停在模拟位、
  // 模型/存档在列心，实测脱节 1200px+，fitGraph 还按模型坐标取景。
  const prev = capture();
  const prevCanvas = vm.runInContext('typeof graphCanvas !== "undefined" ? graphCanvas : null', sandbox);
  const prevRaf = vm.runInContext('requestAnimationFrame', sandbox);
  const prevMarked = vm.runInContext('typeof marked !== "undefined" ? marked : null', sandbox);
  const prevPurify = vm.runInContext('typeof DOMPurify !== "undefined" ? DOMPurify : null', sandbox);
  const prevKatexPass = vm.runInContext('typeof _graphKatexVisiblePass !== "undefined" ? _graphKatexVisiblePass : null', sandbox);
  const prevVizInit = vm.runInContext('typeof _initVizIframes !== "undefined" ? _initVizIframes : null', sandbox);
  try {
    seed({
      nodes: [],
      layerOf: {},
      freeNodes: {},
    });
    vm.runInContext([
      'var __raf = []; requestAnimationFrame = function(cb){ __raf.push(cb); return __raf.length; };',
      // vendor 库不在沙箱里（页面由 index.html 另行加载），给中性桩让真实渲染链跑通
      'marked = { parse: function(s){ return String(s == null ? "" : s); } };',
      'DOMPurify = { sanitize: function(s){ return String(s == null ? "" : s); } };',
      '__gcState.customNodes = [',
      '  { id: "n1", kind: "blank", x: 12, y: -8, content: "甲" },',
      '  { id: "n2", kind: "blank", x: 30, y: 5, content: "乙" },',
      '  { id: "n3", kind: "blank", x: 8, y: 20, content: "丙" }];',
      '__gcState.positions = {}; __gcState.layoutVersion = 1;',
      '__gcState.layerOf = { n1: 0, n2: 1, n3: 2 };',
      // seed 的字面量缺渲染链要读的字段（_applyGraphTransform 读 pan/zoom 等）
      '__gcState.pan = { x: 0, y: 0 }; __gcState.zoom = 1;',
      '__gcState.removedEdges = []; __gcState.collapsed = {}; __gcState.hidden = {};',
      '__gcState.connections = null; __gcState.portCounts = {}; __gcState.inputPortCounts = {};',
      '__gcState.harnessDeleted = {}; __gcState.harnessCheckpoint = null;',
      '__gcSnaps = [];',
      '_updateNodeTransforms = function(ids){ __gcSnaps.push(graphView.nodes.map(function(n){ return [n.id, n.x, n.y]; })); };',
      '_graphKatexVisiblePass = function(){};',
      '_initVizIframes = function(){};',
      'renderGraphCanvas();',
      '__raf.splice(0).forEach(function(cb){ cb(); });',
    ].join('\n'), sandbox);
    const r = JSON.parse(vm.runInContext([
      'JSON.stringify({ snaps: __gcSnaps.length,',
      '  last: __gcSnaps[__gcSnaps.length - 1],',
      '  model: graphView.nodes.map(function(n){ return [n.id, n.x, n.y]; }),',
      '  saved: __gcState.positions })',
    ].join('\n'), sandbox));
    // 模型/存档必须是列心：三列各宽 120+80，列心 100/332/564
    const cx = Object.fromEntries(r.model.map(([id, x]) => [id, x]));
    if (cx.n1 !== 100 || cx.n2 !== 332 || cx.n3 !== 564) {
      throw new Error('模型应落列心 100/332/564：' + JSON.stringify(r.model));
    }
    if (r.saved.n1.x !== 100 || r.saved.n2.x !== 332 || r.saved.n3.x !== 564) {
      throw new Error('存档应记列心坐标：' + JSON.stringify(r.saved));
    }
    // 回归核心：最后一次 transform 写入的坐标必须等于最终模型坐标
    if (r.snaps < 2) throw new Error('静默落列心后必须有 transform 补刷（实测仅 ' + r.snaps + ' 次写入）');
    if (JSON.stringify(r.last) !== JSON.stringify(r.model)) {
      throw new Error('DOM 最后快照与模型脱节：' + JSON.stringify({ last: r.last, model: r.model }));
    }
    return true;
  } finally {
    vm.runInContext([
      'requestAnimationFrame = __gcPrevRaf;',
      // marked/DOMPurify 本就未定义（vendor 不进沙箱）：还原成 null 会让后续
      // typeof 守卫误判「在场」，必须 delete 回到未定义原状
      'if (__gcPrevMarked) marked = __gcPrevMarked; else delete marked;',
      'if (__gcPrevPurify) DOMPurify = __gcPrevPurify; else delete DOMPurify;',
      '_graphKatexVisiblePass = __gcPrevKatexPass;',
      '_initVizIframes = __gcPrevVizInit;',
      'graphCanvas = __gcPrevCanvas;',
      'graphView.selectedNodeIds = new Set(); graphView.boxSelect = null;',
    ].join('\n'), Object.assign(sandbox, {
      __gcPrevRaf: prevRaf, __gcPrevMarked: prevMarked, __gcPrevPurify: prevPurify,
      __gcPrevKatexPass: prevKatexPass, __gcPrevVizInit: prevVizInit, __gcPrevCanvas: prevCanvas,
    }));
    restore(prev);
  }
});

check('落座刷新: 单卡拖进列、落点行没邻居也要刷 transform/补画线', () => {
  const prev = capture();
  let prevSync;
  try {
    const nodes = seed();
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    vm.runInContext('__gcUpdates.length = 0;', sandbox);
    // 把 a 拖进列2框内、落在没邻居的行（d 在 y=0）——settle 返回 false 的最常见情形
    nodes[0].x = 800;
    nodes[0].y = 400;
    prevSync = vm.runInContext('_syncGraphSelectionClasses', sandbox);
    vm.runInContext([
      '_syncGraphSelectionClasses = function(){};',
      'graphView.dragNodeId = "a";',
      'graphView.dragStartPositions = { a: { x: 140, y: 0 } };',
      'graphView.pointerId = 7; graphView.moved = true; graphView.dragWasSelected = true;',
      'graphView.dragModifier = false; graphView.altFree = false;',
      'graphView.selectedNodeIds = new Set(["a"]);',
      'graphView.linkDrag = null; graphView.boxSelect = null;',
      'graphView.resizeNodeId = null; graphView.resizeGroupId = null;',
      'graphView.paintRaf = 0; graphView.paintPending = false; graphView.symbolsPausedForDrag = false;',
      '_endPointerDrag({ pointerId: 7, target: null });',
    ].join('\n'), sandbox);
    if (vm.runInContext('__gcState.layerOf.a', sandbox) !== 2) {
      throw new Error('a 应归列2：' + JSON.stringify(vm.runInContext('__gcState.layerOf', sandbox)));
    }
    if (nodes[0].x !== 562) throw new Error('a 应吸到与 d 同列的列心 562：' + nodes[0].x);
    // 曾在此整段缺失：模型/存档已是列心坐标，DOM 的 transform 与连线却停在拖放原点
    const updates = JSON.parse(vm.runInContext('JSON.stringify(__gcUpdates)', sandbox));
    if (!updates.some(u => u.indexOf('a') !== -1)) {
      throw new Error('被拖卡片的 transform 刷新缺失：' + JSON.stringify(updates));
    }
    if (vm.runInContext('__gcRedraws', sandbox) < 1) throw new Error('连线必须补画');
    const saved = vm.runInContext('__gcSavedState', sandbox);
    if (!saved || !saved.positions || saved.positions.a.x !== 562 || saved.positions.a.y !== 400) {
      throw new Error('存档应记列心坐标：' + JSON.stringify(saved && saved.positions && saved.positions.a));
    }
    return true;
  } finally {
    vm.runInContext([
      '_syncGraphSelectionClasses = __gcPrevSync;',
      'graphView.dragStartPositions = {}; graphView.dragWasSelected = false;',
      'graphView.dragModifier = false; graphView.altFree = false;',
      'graphView.pointerId = null; graphView.moved = false; graphView.selectedNodeIds = new Set();',
    ].join('\n'), Object.assign(sandbox, { __gcPrevSync: prevSync }));
    restore(prev);
  }
});

check('持久化: _normalizeGraphState 保留 layerOf/freeNodes；存盘清理已删节点残留', () => {
  const prev = capture();
  try {
    const rawNorm = vm.runInContext('JSON.stringify(_normalizeGraphState({ layerOf: { a: 1.5 }, freeNodes: { b: 1 } }))', sandbox);
    const norm = JSON.parse(rawNorm);
    if (norm.layerOf.a !== 1.5) throw new Error('layerOf 被白名单丢掉：' + JSON.stringify(norm.layerOf));
    if (norm.freeNodes.b !== 1) throw new Error('freeNodes 被白名单丢掉：' + JSON.stringify(norm.freeNodes));
    const rawEmpty = vm.runInContext('JSON.stringify(_normalizeGraphState({}))', sandbox);
    const empty = JSON.parse(rawEmpty);
    if (!empty.layerOf || !empty.freeNodes) throw new Error('缺省应给空表：' + JSON.stringify(empty));
    seed();
    const pruned = JSON.parse(vm.runInContext([
      '(function(){',
      '  var st = { layerOf: { a: 0, gone: 1 }, freeNodes: { b: 1, gone: 1 } };',
      '  _pruneGraphNodeMarks(st);',
      '  return JSON.stringify(st);',
      '})()',
    ].join('\n'), sandbox));
    if (pruned.layerOf.gone != null || pruned.freeNodes.gone != null) throw new Error('已删节点残留没清：' + JSON.stringify(pruned));
    if (pruned.layerOf.a !== 0 || pruned.freeNodes.b !== 1) throw new Error('存活节点标记被误删：' + JSON.stringify(pruned));
    return true;
  } finally { restore(prev); }
});

check('.pmu 快照: 带出 layerOf/freeNodes', () => {
  const prev = capture();
  try {
    seed({ freeNodes: { d: 1 } });
    const snap = JSON.parse(vm.runInContext('JSON.stringify(_utopiaGraphState())', sandbox));
    if (snap.layerOf.b !== 1) throw new Error('layerOf 没进快照：' + JSON.stringify(snap.layerOf));
    if (snap.freeNodes.d !== 1) throw new Error('freeNodes 没进快照：' + JSON.stringify(snap.freeNodes));
    return true;
  } finally { restore(prev); }
});

check('接线: 拖动/改尺寸/测量全接列重算；归属提交与持久化接线就位', () => {
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const layout = fs.readFileSync('src/static/js/graph-render-layout.js', 'utf8');
  const render = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  const session = fs.readFileSync('src/static/js/session.js', 'utf8');
  const utopia = fs.readFileSync('src/static/js/utopia.js', 'utf8');
  const onboarding = fs.readFileSync('src/static/js/ui-onboarding.js', 'utf8');
  const history = fs.readFileSync('src/static/js/graph-history-diff.js', 'utf8');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!layout.includes('function _graphColumns(opts)')) throw new Error('列清单函数缺失');
  if (!layout.includes('const GRAPH_COL_PAD = 40;') || !layout.includes('const GRAPH_COL_GAP = 32;')) throw new Error('呼吸边/列缝常量缺失');
  if (!layout.includes('const GRAPH_COL_NEW_COL = 120;') || !layout.includes('const GRAPH_COL_MAX = 40;')) throw new Error('建列阈值/上限常量缺失');
  if (!layout.includes('const GRAPH_COL_STACK_GAP = 48;')) throw new Error('整理列内缝常量缺失');
  if (layout.includes('GRAPH_LAYER_SNAP_X') || layout.includes('GRAPH_LAYER_BAND_MINW')) throw new Error('旧中线吸附/最小列宽口径仍残留');
  if (layout.includes('Math.max(0, Math.min(maxDepth + 1')) throw new Error('层号覆盖仍在夹范围');
  if (!layout.includes('function _graphColumnTargetForNode(node, opts)')) throw new Error('列框/列缝判定缺失');
  if (!layout.includes('function _realignGraphColumns(opts)')) throw new Error('整列重算缺失');
  if (!layout.includes('function _highlightGraphColumnTarget(target)')) throw new Error('插列提示缺失');
  if (!layout.includes('function _commitGraphNodeOwnership(nodes, opts)')) throw new Error('归属提交口缺失');
  if (!layout.includes('function _pruneGraphNodeMarks(state)')) throw new Error('已删节点标记清理缺失');
  if (layout.includes('_arrangeTreeLayout') || layout.includes('_resolveLayoutRectOverlaps')) throw new Error('旧树状整理/矩形碰撞仍残留');
  if (!layout.includes('_fitAllGroupsToMembers();')) throw new Error('整理收尾未按成员重算组框');
  if (!layout.includes('_realignGraphColumns({ force: true, silentUpdate: true, silentEdges: true })')) throw new Error('整理未统一整列重算');
  if (!interact.includes("mode: draggedIds.length === 1 ? 'single' : 'multi'")) throw new Error('单卡/多选落点模式未接线');
  if (!interact.includes('forceFree: !!graphView.altFree')) throw new Error('Alt 自由落点未接线');
  if (!interact.includes('_fitDraggedGroups(draggedIds)')) throw new Error('多选落点未贴整组组框');
  if (!interact.includes('_commitGraphNodeOwnership(movedIds.map(_findGraphNode).filter(Boolean)')) throw new Error('整组拖拽未提交归属');
  if ((interact.match(/graphView\.altFree = !!event\.altKey;/g) || []).length < 2) throw new Error('整组拖拽未记录 Alt 状态');
  if (!interact.includes('_realignGraphColumns({ layerMap: targetMap, force: true })')) throw new Error('建列/插列后未整排落位');
  if (!interact.includes('_highlightGraphColumnTarget(target)')) throw new Error('拖动中未显示目标提示');
  if (!interact.includes('_highlightGraphColumnTarget(null)')) throw new Error('松手未清提示');
  if (interact.includes('_squeezeLayersRightForNode(node, { preX:')) throw new Error('旧单向让位调用仍残留');
  if (!interact.includes('_realignGraphColumns({ force: true, silentUpdate: true, silentEdges: true })')) throw new Error('改尺寸未实时跟列宽');
  if (!render.includes('_realignGraphColumns({ silentUpdate: true, silentEdges: true })')) throw new Error('尺寸测量后未重算列宽');
  if (!session.includes('layerOf: p.layerOf || {}') || !session.includes('freeNodes: p.freeNodes || {}')) {
    throw new Error('存档白名单没带 layerOf/freeNodes');
  }
  if (!history.includes('_pruneGraphNodeMarks(state)')) throw new Error('存盘漏斗没清理已删节点标记');
  if (!utopia.includes('layerOf: st.layerOf || {}') || !utopia.includes('freeNodes: st.freeNodes || {}')) {
    throw new Error('.pmu 快照没带 layerOf/freeNodes');
  }
  if (!onboarding.includes('state.freeNodes[id] = 1;') || !onboarding.includes('delete state.layerOf[id];')) {
    throw new Error('示例图素材/总结节点没标自由');
  }
  if (!css.includes('.graph-col-insert') || !css.includes('.graph-col-ghost')) throw new Error('插列竖线/幽灵列样式缺失');
  return true;
});

await drain();
}
