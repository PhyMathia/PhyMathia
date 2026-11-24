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

check('落座插入: 满列下拖到 B 下方 → 插到 B 正下、下方卡让位，不再弹回旧位', () => {
  const prev = capture();
  try {
    seed({
      nodes: [
        { id: 'a', x: 190, y: -548, w: 300, h: 500 },
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
        { id: 'c', x: 190, y: 548, w: 300, h: 500 },
      ],
      layerOf: { a: 1, b: 1, c: 1 },
    });
    // 与 _endPointerDrag 单卡分支同构：a 松手在 b 下方 100px（用户想要「a 到 b 下面」）。
    // 修前实测：弹回 -560（自己腾出的旧位），c 不动——「能挪到 B 上面、挪不到 B 下面」。
    const ret = JSON.parse(vm.runInContext(`
      JSON.stringify((function(){
        const node = graphView.nodeById['a'];
        node.x = 190; node.y = 100;
        const committed = _commitGraphNodeOwnership([node], { mode: 'single' });
        const assigned = committed.assigned[0];
        const targetMap = _graphLayerIndexMap(graphView.nodes.filter(n => n.kind !== 'draft'), graphView.edges || [], _graphLayerOverrides());
        const col = _graphColumns({ layerMap: targetMap }).find(c => c.layer === assigned.layer);
        if (col) node.x = col.cx;
        node.y = Math.round(node.y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP;
        _realignGraphColumns({ layerMap: targetMap, force: true });
        const movedIds = _settleNodeIntoLayer(node, assigned.layer, targetMap);
        return { movedIds: movedIds, ys: graphView.nodes.reduce(function(ac,n){ ac[n.id]=n.y; return ac; }, {}) };
      })())
    `, sandbox));
    if (JSON.stringify(ret.movedIds) !== '["c"]') throw new Error('应只有 c 让位：' + JSON.stringify(ret.movedIds));
    if (ret.ys.b !== 0 || ret.ys.a !== 548 || ret.ys.c !== 1096) throw new Error('应插到 b 正下方、c 下移一条缝：' + JSON.stringify(ret.ys));
    if (ret.ys.a - ret.ys.b !== 548 || ret.ys.c - ret.ys.a !== 548) throw new Error('让位后缝应保持 48：' + JSON.stringify(ret.ys));
    return true;
  } finally { restore(prev); }
});

check('落座插入: 满列上拖到 B 上方 → 镜像成立（b 让位下移）', () => {
  const prev = capture();
  try {
    seed({
      nodes: [
        { id: 'a', x: 190, y: -548, w: 300, h: 500 },
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
        { id: 'c', x: 190, y: 548, w: 300, h: 500 },
      ],
      layerOf: { a: 1, b: 1, c: 1 },
    });
    const ret = JSON.parse(vm.runInContext(`
      JSON.stringify((function(){
        const node = graphView.nodeById['c'];
        node.x = 190; node.y = -100;
        const committed = _commitGraphNodeOwnership([node], { mode: 'single' });
        const assigned = committed.assigned[0];
        const targetMap = _graphLayerIndexMap(graphView.nodes.filter(n => n.kind !== 'draft'), graphView.edges || [], _graphLayerOverrides());
        const col = _graphColumns({ layerMap: targetMap }).find(c => c.layer === assigned.layer);
        if (col) node.x = col.cx;
        node.y = Math.round(node.y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP;
        _realignGraphColumns({ layerMap: targetMap, force: true });
        const movedIds = _settleNodeIntoLayer(node, assigned.layer, targetMap);
        return { movedIds: movedIds, ys: graphView.nodes.reduce(function(ac,n){ ac[n.id]=n.y; return ac; }, {}) };
      })())
    `, sandbox));
    if (JSON.stringify(ret.movedIds) !== '["b"]') throw new Error('应只有 b 让位：' + JSON.stringify(ret.movedIds));
    if (!(ret.ys.a < ret.ys.c && ret.ys.c < ret.ys.b)) throw new Error('列内顺序应为 a、c、b：' + JSON.stringify(ret.ys));
    return true;
  } finally { restore(prev); }
});

check('落座插入: 空缝松手不落座；占到行但缝够 → 夹到窗沿、邻居一个不动', () => {
  const prev = capture();
  try {
    seed({
      nodes: [
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
        { id: 'c', x: 190, y: 1200, w: 300, h: 500 },
      ],
      layerOf: { b: 1, c: 1 },
    });
    const ret = JSON.parse(vm.runInContext(`
      JSON.stringify((function(){
        __gcState.layerOf.a = 1;
        const node = { id: 'a', x: 190, y: 600, w: 300, h: 500 };
        graphView.nodes.push(node);
        graphView.nodeById['a'] = node;
        const targetMap = _graphLayerIndexMap(graphView.nodes.filter(n => n.kind !== 'draft'), graphView.edges || [], _graphLayerOverrides());
        // ① 落点在宽缝中央（距两张卡都超过 547.5 判距）＝没占到行：不落座、坐标原样
        const r1 = _settleNodeIntoLayer(node, 1, targetMap);
        const y1 = node.y;
        // ② 落点压到 b 身上（|600-100|=500 < 547.5）：缝够 → 夹进窗沿 [548, 652.5]
        node.y = 100;
        const r2 = _settleNodeIntoLayer(node, 1, targetMap);
        return { r1: r1, y1: y1, r2: r2, y2: node.y,
          ys: graphView.nodes.reduce(function(ac,n){ ac[n.id]=n.y; return ac; }, {}) };
      })())
    `, sandbox));
    if (ret.r1 !== false || ret.y1 !== 600) throw new Error('空缝松手不该落座：' + JSON.stringify(ret));
    if (JSON.stringify(ret.r2) !== '[]') throw new Error('缝够时不应让位：' + JSON.stringify(ret.r2));
    if (ret.y2 !== 548) throw new Error('占到行应夹到窗沿 548：' + ret.y2);
    if (ret.ys.b !== 0 || ret.ys.c !== 1200) throw new Error('邻居不该动：' + JSON.stringify(ret.ys));
    return true;
  } finally { restore(prev); }
});

check('落座插入: 让位的钉住卡同步 fixedY（存档读 fixedY 不读 y）', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: -548, w: 300, h: 500 },
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
        { id: 'c', x: 190, y: 548, w: 300, h: 500 },
      ],
      layerOf: { a: 1, b: 1, c: 1 },
    });
    nodes[2].pinned = true;
    nodes[2].fixedX = 190;
    nodes[2].fixedY = 548;
    const ys = JSON.parse(vm.runInContext(`
      JSON.stringify((function(){
        const node = graphView.nodeById['a'];
        node.x = 190; node.y = 100;
        const committed = _commitGraphNodeOwnership([node], { mode: 'single' });
        const targetMap = _graphLayerIndexMap(graphView.nodes.filter(n => n.kind !== 'draft'), graphView.edges || [], _graphLayerOverrides());
        const col = _graphColumns({ layerMap: targetMap }).find(c => c.layer === committed.assigned[0].layer);
        if (col) node.x = col.cx;
        node.y = Math.round(node.y / GRAPH_LAYER_ROW_STEP) * GRAPH_LAYER_ROW_STEP;
        _realignGraphColumns({ layerMap: targetMap, force: true });
        _settleNodeIntoLayer(node, committed.assigned[0].layer, targetMap);
        return { y: graphView.nodeById['c'].y, fixedY: graphView.nodeById['c'].fixedY };
      })())
    `, sandbox));
    if (ys.y !== 1096 || ys.fixedY !== 1096) throw new Error('钉住卡让位后 fixedY 必须同步：' + JSON.stringify(ys));
    return true;
  } finally { restore(prev); }
});

check('多选落座: 自由卡拖进有卡列逐颗落座，不再三卡叠一摞', () => {
  const prev = capture();
  try {
    seed({
      nodes: [
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
        { id: 'e1', x: 150, y: 100, w: 300, h: 500 },
        { id: 'e2', x: 160, y: 200, w: 300, h: 500 },
      ],
      layerOf: { b: 1 },
      freeNodes: { e1: 1, e2: 1 },
    });
    const ret = JSON.parse(vm.runInContext(`
      JSON.stringify((function(){
        const list = ['e1','e2'].map(function(id){ return graphView.nodeById[id]; });
        const committed = _commitGraphNodeOwnership(list, { mode: 'multi', forceFree: false });
        _realignGraphColumns({ force: true });
        const touched = _settleAssignedNodesIntoColumns(committed);
        const ns = graphView.nodes;
        const minDy = Math.min.apply(null, ns.map(function(n, i){
          return ns.filter(function(m){ return m !== n; }).map(function(m){ return Math.abs(m.y - n.y); });
        }).reduce(function(a,b){ return a.concat(b); }, []));
        return { touched: touched, ys: ns.reduce(function(ac,n){ ac[n.id]=n.y; return ac; }, {}), minDy: minDy };
      })())
    `, sandbox));
    if (ret.minDy < (500 + 500) / 2 + 47.5) throw new Error('多选落进列后仍有重叠：' + JSON.stringify(ret));
    if (ret.ys.b !== 0 || ret.ys.e1 !== 548 || ret.ys.e2 !== 1096) throw new Error('应按松手 y 逐颗让位排开：' + JSON.stringify(ret.ys));
    if (!ret.touched || ret.touched.indexOf('e1') < 0 || ret.touched.indexOf('e2') < 0) throw new Error('落座卡 id 应返回供刷 transform：' + JSON.stringify(ret.touched));
    return true;
  } finally { restore(prev); }
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
  // 落座插序（2026-11-21）：满列插入让位 + 多选/整组接线
  if (!layout.includes('function _settleNodeIntoLayer(node, depth, layerOf)')) throw new Error('纵向落座函数缺失');
  if (layout.includes('整列都排满') || layout.includes('const startY')) throw new Error('旧「弹回最近空槽/垫底」落座仍残留');
  if (!layout.includes('function _settleAssignedNodesIntoColumns(committed)')) throw new Error('多选/整组落座口缺失');
  if (!interact.includes('_settleAssignedNodesIntoColumns(committed)')) throw new Error('多选落点未接纵向落座');
  if (!interact.includes('_settleAssignedNodesIntoColumns(groupCommitted)')) throw new Error('整组落点未接纵向落座');
  if (!interact.includes('_updateNodeTransforms(settledIds ? [node.id].concat(settledIds) : [node.id])')) throw new Error('让位邻居的 transform 未随落座补刷');
  return true;
});

// ====== 实体落座（2026-11-24）：卡片当实体，任何两张卡不许压在一起 ======
// 与自动整理并存：整理管列（成员回列心、按 y 排、48 缝居中），落座只管「别压着」。
// 期望值全是手算整数：单列时列框从 0 起、列宽 = 最宽 + 80（300 宽卡 → 列心 190）。
function overlapFree(list) {
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const p = list[i];
      const q = list[j];
      if (Math.abs(p.x - q.x) < (p.w + q.w) / 2 + 16 - 0.5
        && Math.abs(p.y - q.y) < (p.h + q.h) / 2 + 16 - 0.5) return false;
    }
  }
  return true;
}
function posOf(list) { return JSON.stringify(list.map(n => [n.id, n.x, n.y])); }
function resolveWith(opts) {
  return JSON.parse(vm.runInContext('JSON.stringify(_resolveGraphNodeOverlaps(' + JSON.stringify(opts || {}) + '))', sandbox));
}

check('实体落座: 没压叠就一个不动（同列 20px 紧缝、自由卡贴着 16 净距都算合法）', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 520, w: 300, h: 500 },
        { id: 'f', x: 506, y: 0, w: 300, h: 200 },
      ],
      layerOf: { a: 1, b: 1 },
      freeNodes: { f: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    const before = posOf(nodes);
    const moved = resolveWith({});
    if (moved.length) throw new Error('不该动任何卡：' + JSON.stringify(moved));
    if (posOf(nodes) !== before) throw new Error('坐标被动了：' + posOf(nodes));
    return true;
  } finally { restore(prev); }
});

check('实体落座: 同列两张卡压着 → 后落座的沿列滑开（缝回 48），x 不离列心', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 100, w: 300, h: 500 },
      ],
      layerOf: { a: 1, b: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    const moved = resolveWith({});
    if (JSON.stringify(moved) !== '["b"]') throw new Error('应只动 b：' + JSON.stringify(moved));
    if (nodes[0].y !== 0 || nodes[1].y !== 548 || nodes[1].x !== 190) {
      throw new Error('a 应不动、b 应落到 a 正下方 48 缝（y=548）：' + posOf(nodes));
    }
    if (!overlapFree(nodes)) throw new Error('落座后仍压着');
    return true;
  } finally { restore(prev); }
});

check('实体落座: 刚长高的卡先落座原地不动，上下邻居对称让位、缝保持 48', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: -548, w: 300, h: 500 },
        { id: 'n', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 548, w: 300, h: 500 },
      ],
      layerOf: { a: 1, n: 1, b: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].h = 700; // n 长高 200：上下各压进 52
    const moved = resolveWith({ prior: ['n'], grown: ['n'] });
    if (JSON.stringify(moved) !== '["a","b"]') throw new Error('应只动上下邻居：' + JSON.stringify(moved));
    if (nodes[1].y !== 0) throw new Error('长高的卡自己不动：' + nodes[1].y);
    if (nodes[0].y !== -648 || nodes[2].y !== 648) throw new Error('邻居应各让 100：' + posOf(nodes));
    if (!overlapFree(nodes)) throw new Error('落座后仍压着');
    return true;
  } finally { restore(prev); }
});

check('实体落座: 让位是链式下推、不越过下面的卡（列内上下顺序不变）；再跑一遍是空操作', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: -548, w: 300, h: 500 },
        { id: 'n', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 548, w: 300, h: 500 },
        { id: 'c', x: 190, y: 1096, w: 300, h: 500 },
      ],
      layerOf: { a: 1, n: 1, b: 1, c: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].h = 700;
    const moved = resolveWith({ prior: ['n'], grown: ['n'] });
    if (JSON.stringify(moved) !== '["a","b","c"]') throw new Error('应动三张邻居：' + JSON.stringify(moved));
    if (nodes[0].y !== -648 || nodes[2].y !== 648 || nodes[3].y !== 1196) {
      throw new Error('b、c 应整体各下推 100（不越过）：' + posOf(nodes));
    }
    if (!(nodes[0].y < nodes[1].y && nodes[1].y < nodes[2].y && nodes[2].y < nodes[3].y)) {
      throw new Error('列内顺序被改：' + posOf(nodes));
    }
    const again = resolveWith({ prior: ['n'], grown: ['n'] });
    if (again.length) throw new Error('已落座不该再动：' + JSON.stringify(again));
    return true;
  } finally { restore(prev); }
});

check('实体落座: 自由卡最后落座 → 压到列成员就自己滑到最近空位，四向取最近、列成员不动', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'b', x: 190, y: 0, w: 300, h: 100 },
        { id: 'f', x: 190, y: 0, w: 300, h: 100 },
      ],
      layerOf: { b: 1 },
      freeNodes: { f: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    // ① 完全重合：四向平手 → 纵向优先、先下（后落的卡落到下方，合阅读顺序）→ b 脚下 16 净距
    let moved = resolveWith({ last: ['f'] });
    if (JSON.stringify(moved) !== '["f"]' || nodes[1].y !== 116 || nodes[1].x !== 190) {
      throw new Error('重合时应滑到正下方：' + posOf(nodes) + JSON.stringify(moved));
    }
    // ② 压进 b 六成：往回退 76 最短（往下要整张越过 b）
    nodes[1].y = -40;
    resolveWith({ last: ['f'] });
    if (nodes[1].y !== -116) throw new Error('压六成应退回 76：' + nodes[1].y);
    // ③ 大半在 b 右侧：横向只需 68 → 往右滑到贴着 16 净距
    nodes[1].y = 0;
    nodes[1].x = 438;
    resolveWith({ last: ['f'] });
    if (nodes[1].x !== 506 || nodes[1].y !== 0) throw new Error('侧压应横滑 68：' + posOf(nodes));
    if (nodes[0].x !== 190 || nodes[0].y !== 0) throw new Error('先落座的列成员被动了：' + posOf(nodes));
    return true;
  } finally { restore(prev); }
});

check('实体落座: 列成员给自由卡让位时只沿列上下滑，x 恒为列心', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'b', x: 190, y: 0, w: 300, h: 100 },
        { id: 'f', x: 190, y: 0, w: 300, h: 100 },
      ],
      layerOf: { b: 1 },
      freeNodes: { f: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    nodes[1].x = 240; // 自由卡偏右压着 b
    const moved = resolveWith({ prior: ['f'] });
    if (JSON.stringify(moved) !== '["b"]') throw new Error('应只动 b：' + JSON.stringify(moved));
    if (nodes[0].x !== 190 || Math.abs(nodes[0].y) !== 116) {
      throw new Error('b 只许沿列滑（x=190、y=±116）：' + posOf(nodes));
    }
    if (nodes[1].x !== 240) throw new Error('先落座的自由卡被动了：' + posOf(nodes));
    return true;
  } finally { restore(prev); }
});

check('实体落座: 一摞自由卡按给定顺序逐张落座，最终两两不压且是定点', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'f1', x: 0, y: 0, w: 300, h: 200 },
        { id: 'f2', x: 20, y: 30, w: 260, h: 180 },
        { id: 'f3', x: -15, y: -10, w: 320, h: 240 },
        { id: 'f4', x: 40, y: 60, w: 200, h: 300 },
        { id: 'f5', x: 0, y: 0, w: 300, h: 200 },
      ],
      layerOf: {},
      freeNodes: { f1: 1, f2: 1, f3: 1, f4: 1, f5: 1 },
    });
    const moved = resolveWith({});
    if (JSON.stringify(moved) !== '["f2","f3","f4","f5"]') throw new Error('首张不动、其余逐张落座：' + JSON.stringify(moved));
    if (nodes[0].x !== 0 || nodes[0].y !== 0) throw new Error('最先落座的 f1 不该动');
    if (!overlapFree(nodes)) throw new Error('落座后仍有压叠：' + posOf(nodes));
    const settled = posOf(nodes);
    if (resolveWith({}).length || posOf(nodes) !== settled) throw new Error('再跑一遍不是空操作');
    return true;
  } finally { restore(prev); }
});

check('实体落座: 让位的钉住卡同步 fixedX/fixedY；skip 的卡不挡路也不被推', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: 100, w: 300, h: 500 },
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
      ],
      layerOf: {},
      freeNodes: { a: 1, b: 1 },
    });
    nodes[0].pinned = true;
    nodes[0].fixedX = 190;
    nodes[0].fixedY = 100;
    const moved = resolveWith({ prior: ['b'] });
    if (JSON.stringify(moved) !== '["a"]') throw new Error('应只动 a：' + JSON.stringify(moved));
    // 两张都是自由卡：横滑 316（贴 16 净距）比纵向 416/616 都近；左右平手取先列的右
    if (nodes[0].x !== 506 || nodes[0].y !== 100 || nodes[0].fixedX !== 506 || nodes[0].fixedY !== 100) {
      throw new Error('钉住卡让位后 fixedX/fixedY 必须同步：' + JSON.stringify([nodes[0].x, nodes[0].y, nodes[0].fixedX, nodes[0].fixedY]));
    }
    // skip：正在拖着的卡不算实体
    const nodes2 = seed({
      nodes: [
        { id: 'a', x: 190, y: 100, w: 300, h: 500 },
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
      ],
      layerOf: {},
      freeNodes: { a: 1, b: 1 },
    });
    const skipped = resolveWith({ skip: ['b'] });
    if (skipped.length || posOf(nodes2) !== JSON.stringify([['a', 190, 100], ['b', 190, 0]])) {
      throw new Error('被 skip 的卡不该挡路也不该被推：' + JSON.stringify(skipped) + posOf(nodes2));
    }
    return true;
  } finally { restore(prev); }
});

check('实体落座: 被推的组员 → 组框当场贴回成员，包含同步不掉组；noRefitFor 的照旧掉组', () => {
  const prev = capture();
  try {
    const mk = () => seed({
      nodes: [
        { id: 'n', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 548, w: 300, h: 500 },
      ],
      groups: [{ id: 'g1', name: 'g', nodeIds: ['b'], x: 0, y: 0, width: 100, height: 100 }],
      layerOf: { n: 1, b: 1 },
    });
    // ① 默认：组员 b 被推走，框跟过去，同步后仍在组里
    let nodes = mk();
    vm.runInContext('_realignGraphColumns({ force: true }); _fitAllGroupsToMembers();', sandbox);
    const frameBefore = JSON.stringify(vm.runInContext('graphView.groups[0]', sandbox));
    nodes[0].h = 700;
    const moved = resolveWith({ prior: ['n'], grown: ['n'] });
    if (JSON.stringify(moved) !== '["b"]' || nodes[1].y !== 648) throw new Error('b 应被推到 648：' + posOf(nodes));
    const g1 = vm.runInContext('_syncGroupMembersByContainment(); graphView.groups[0]', sandbox);
    if (JSON.stringify(g1.nodeIds) !== '["b"]') throw new Error('被推的组员掉组了：' + JSON.stringify(g1.nodeIds));
    if (JSON.stringify(vm.runInContext('graphView.groups[0]', sandbox)) === frameBefore) throw new Error('组框没贴回成员');
    // ② noRefitFor（用户亲手拖出组的卡）：框不贴，同步照旧按「拖出组框」减成员
    nodes = mk();
    vm.runInContext('_realignGraphColumns({ force: true }); _fitAllGroupsToMembers();', sandbox);
    const frameKept = JSON.stringify(vm.runInContext('graphView.groups[0]', sandbox));
    nodes[0].h = 700;
    resolveWith({ prior: ['n'], grown: ['n'], noRefitFor: ['b'] });
    if (JSON.stringify(vm.runInContext('graphView.groups[0]', sandbox)) !== frameKept) throw new Error('noRefitFor 的组框不该被贴');
    vm.runInContext('_syncGroupMembersByContainment()', sandbox);
    const g2 = vm.runInContext('graphView.groups[0]', sandbox);
    if (g2.nodeIds.length !== 0) throw new Error('noRefitFor 的卡应照旧掉组：' + JSON.stringify(g2.nodeIds));
    return true;
  } finally { restore(prev); }
});

check('实体落座: 挪了人 → 内存态存档位当场跟上（不等存盘）', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 100, w: 300, h: 500 },
      ],
      layerOf: { a: 1, b: 1 },
    });
    resolveWith({});
    const st = vm.runInContext('__gcState', sandbox);
    if (!st.positions.b || st.positions.b.y !== 548 || st.positions.b.x !== 190) {
      throw new Error('存档位没跟上落座：' + JSON.stringify(st.positions));
    }
    return true;
  } finally { restore(prev); }
});

check('实体落座: 一小步一小步长高，同列的缝每一步都保持 48（grown 名单）；不长高时同列 20px 紧缝不碰', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'n', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 520, w: 300, h: 500 },
      ],
      layerOf: { n: 1, b: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    // ① 没人长高：同列 20px 紧缝是旧档里的合法摆法，一个不动
    const idle = resolveWith({});
    if (idle.length || nodes[1].y !== 520) throw new Error('不长高时不该动紧缝的卡：' + JSON.stringify(idle) + posOf(nodes));
    // ② 从 48 缝起，每次只长 10px、长 20 次：每一步之后缝都必须还是 48
    nodes[1].y = 548;
    for (let step = 1; step <= 20; step++) {
      nodes[0].h += 10;
      resolveWith({ prior: ['n'], grown: ['n'] });
      const gap = (nodes[1].y - nodes[1].h / 2) - (nodes[0].y + nodes[0].h / 2);
      if (Math.abs(gap - 48) > 0.01) {
        throw new Error('第 ' + step + ' 步长高后缝变成 ' + gap + '（应保持 48）：' + posOf(nodes));
      }
    }
    if (nodes[0].y !== 0 || nodes[1].y !== 648) throw new Error('终态应是 n 不动、b=648：' + posOf(nodes));
    return true;
  } finally { restore(prev); }
});

function clearHomes() {
  vm.runInContext('Object.keys(_graphPushedHome).forEach(function(k){ delete _graphPushedHome[k]; });', sandbox);
}
function homes() { return JSON.parse(vm.runInContext('JSON.stringify(_graphPushedHome)', sandbox)); }
// 改尺寸松手那一下：原位表当期望位
function resolveHome(prior) {
  return JSON.parse(vm.runInContext('JSON.stringify(_resolveGraphNodeOverlaps({ prior: ' + JSON.stringify(prior)
    + ', grown: ' + JSON.stringify(prior) + ', restore: _graphPushedHome }))', sandbox));
}

check('实体落座: 改尺寸弹性回位——被推开的卡记住原位，松手时路让开了就弹回（跨手势也行）；亲手拖过后原位作废', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'n', x: 190, y: 100, w: 300, h: 100 },
        { id: 'b', x: 190, y: 300, w: 300, h: 100 },
      ],
      layerOf: {},
      freeNodes: { n: 1, b: 1 },
    });
    // 手势一：n 长高压到 b → b 让到 316，并记下原位 300
    nodes[0].h = 300;
    resolveWith({ prior: ['n'], grown: ['n'], rememberHome: true });
    if (nodes[1].y !== 316) throw new Error('b 应让到 316：' + nodes[1].y);
    if (JSON.stringify(homes()) !== '{"b":{"x":190,"y":300}}') throw new Error('被推开的卡应记下原位：' + JSON.stringify(homes()));
    // 松手（n 还是大卡）：想回也回不去 → 留在 316 且不算动过；原位记录保留
    let moved = resolveHome(['n']);
    if (moved.length || nodes[1].y !== 316) throw new Error('回不去应原位不动：' + JSON.stringify(moved) + nodes[1].y);
    if (!homes().b) throw new Error('没回到原位，记录不该作废');
    // 又推远一步：原位只记头一次（仍是 300）
    nodes[0].h = 400;
    resolveWith({ prior: ['n'], grown: ['n'], rememberHome: true });
    if (!homes().b || homes().b.y !== 300) throw new Error('原位只该记头一次：' + JSON.stringify(homes()));
    // 手势二（另一次改尺寸）：n 缩回去了 → 松手时 b 弹回 300，记录作废
    nodes[0].h = 100;
    moved = resolveHome(['n']);
    if (JSON.stringify(moved) !== '["b"]' || nodes[1].y !== 300) throw new Error('缩回去后 b 应弹回 300：' + posOf(nodes));
    if (homes().b) throw new Error('回到原位后记录应作废：' + JSON.stringify(homes()));
    // 用户亲手拖过 b 之后：原位作废，之后即使路让开了也不弹回
    nodes[0].h = 300;
    resolveWith({ prior: ['n'], grown: ['n'], rememberHome: true });
    vm.runInContext('_forgetGraphNodeHome(["b"])', sandbox);
    nodes[0].h = 100;
    moved = resolveHome(['n']);
    if (moved.length || nodes[1].y !== 316) throw new Error('原位作废后不该弹回：' + JSON.stringify(moved) + posOf(nodes));
    // AI 长高（不带 rememberHome）不记原位
    nodes[0].h = 300;
    resolveWith({ prior: ['n'], grown: ['n'] });
    if (Object.keys(homes()).length) throw new Error('长高推开的卡不该记原位：' + JSON.stringify(homes()));
    return true;
  } finally { clearHomes(); restore(prev); }
});

check('接线·自动整理: 列成员按整理结果一格不动，压到它的自由卡让位；不压的自由卡不动；连整理两次是定点', () => {
  const prev = capture();
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 140, y: 0, w: 200, h: 80 },
        { id: 'b', x: 502, y: 0, w: 300, h: 500 },
        { id: 'c', x: 502, y: 548, w: 300, h: 500 },
        { id: 'e', x: 502, y: 100, w: 300, h: 200 },  // 自由卡压在 b、c 身上
        { id: 'k', x: 502, y: 1500, w: 300, h: 200 }, // 自由卡离得远
      ],
      layerOf: { a: 0, b: 1, c: 1 },
      freeNodes: { e: 1, k: 1 },
    });
    vm.runInContext('autoArrangeGraph()', sandbox);
    // 列成员＝纯整理结果：列1 总高 1048 居中 → b=-274、c=274
    if (nodes[1].y !== -274 || nodes[2].y !== 274 || nodes[1].x !== 502 || nodes[2].x !== 502) {
      throw new Error('列成员应是整理结果（b=-274、c=274、x=502）：' + posOf(nodes));
    }
    // e 四向里横滑 316 最近（上 740、下 540、左要越过 a 列 628）→ 落到列1 右侧贴 16 净距
    if (nodes[3].x !== 818 || nodes[3].y !== 100) throw new Error('e 应横滑到 (818,100)：' + posOf(nodes));
    if (nodes[4].x !== 502 || nodes[4].y !== 1500) throw new Error('不压的自由卡不该动：' + posOf(nodes));
    if (!overlapFree(nodes)) throw new Error('整理后仍有压叠');
    const once = posOf(nodes);
    vm.runInContext('autoArrangeGraph()', sandbox);
    if (posOf(nodes) !== once) throw new Error('第二次整理改了坐标：' + posOf(nodes) + ' vs ' + once);
    return true;
  } finally { restore(prev); }
});

function dragSetup(node, from, to, alt) {
  node.x = to.x;
  node.y = to.y;
  vm.runInContext([
    '_syncGraphSelectionClasses = function(){};',
    'graphView.dragNodeId = ' + JSON.stringify(node.id) + ';',
    'graphView.dragStartPositions = ' + JSON.stringify({ [node.id]: from }) + ';',
    'graphView.pointerId = 7; graphView.moved = true; graphView.dragWasSelected = true;',
    'graphView.dragModifier = false; graphView.altFree = ' + (alt ? 'true' : 'false') + ';',
    'graphView.selectedNodeIds = new Set([' + JSON.stringify(node.id) + ']);',
    'graphView.linkDrag = null; graphView.boxSelect = null;',
    'graphView.resizeNodeId = null; graphView.resizeGroupId = null;',
    'graphView.paintRaf = 0; graphView.paintPending = false; graphView.symbolsPausedForDrag = false;',
    '_endPointerDrag({ pointerId: 7, target: null });',
  ].join('\n'), sandbox);
}
function dragCleanup(prevSync) {
  vm.runInContext([
    '_syncGraphSelectionClasses = __gcPrevSync;',
    'graphView.dragStartPositions = {}; graphView.dragWasSelected = false;',
    'graphView.dragModifier = false; graphView.altFree = false;',
    'graphView.pointerId = null; graphView.moved = false; graphView.selectedNodeIds = new Set();',
  ].join('\n'), Object.assign(sandbox, { __gcPrevSync: prevSync }));
}

check('接线·拖拽: Alt 落成自由的卡压到列成员 → 自己往上滑开 166，列成员一格不动、落盘记新位', () => {
  const prev = capture();
  let prevSync;
  try {
    const nodes = seed({
      nodes: [
        { id: 'a', x: 140, y: 0, w: 200, h: 80 },
        { id: 'b', x: 502, y: 0, w: 300, h: 500 },
        { id: 'e', x: 1500, y: 0, w: 300, h: 200 },
      ],
      layerOf: { a: 0, b: 1 },
      freeNodes: { e: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    prevSync = vm.runInContext('_syncGraphSelectionClasses', sandbox);
    vm.runInContext('__gcUpdates.length = 0;', sandbox);
    dragSetup(nodes[2], { x: 1500, y: 0 }, { x: 502, y: -200 }, true);
    if (nodes[2].x !== 502 || nodes[2].y !== -366) throw new Error('e 应滑到 b 上方 16 净距（y=-366）：' + posOf(nodes));
    if (nodes[1].x !== 502 || nodes[1].y !== 0) throw new Error('列成员 b 被动了：' + posOf(nodes));
    if (!vm.runInContext('__gcState.freeNodes.e', sandbox)) throw new Error('Alt 落点应仍是自由卡');
    const updates = JSON.parse(vm.runInContext('JSON.stringify(__gcUpdates)', sandbox));
    if (!updates.some(u => u.indexOf('e') !== -1)) throw new Error('让位后没刷 transform：' + JSON.stringify(updates));
    const saved = vm.runInContext('__gcSavedState', sandbox);
    if (!saved || !saved.positions.e || saved.positions.e.y !== -366) {
      throw new Error('存档应记让位后的坐标：' + JSON.stringify(saved && saved.positions.e));
    }
    return true;
  } finally { dragCleanup(prevSync); restore(prev); }
});

check('接线·拖拽: 单卡拖进列 → 卡落在松手位（先落座），挡路的自由卡让位', () => {
  const prev = capture();
  let prevSync;
  try {
    const nodes = seed({
      nodes: [
        { id: 'b', x: 190, y: 0, w: 300, h: 500 },
        { id: 'f', x: 190, y: 548, w: 300, h: 100 },
        { id: 'a', x: 1200, y: 548, w: 300, h: 250 },
      ],
      layerOf: { b: 1 },
      freeNodes: { f: 1, a: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    prevSync = vm.runInContext('_syncGraphSelectionClasses', sandbox);
    // 把自由卡 a 拖进列框、正好落在自由卡 f 停着的位置
    dragSetup(nodes[2], { x: 1200, y: 548 }, { x: 190, y: 548 }, false);
    if (vm.runInContext('__gcState.layerOf.a', sandbox) !== 1) throw new Error('a 应归列');
    // a 落在行槽 560 原地不动；f 上滑 179 让出位置（下滑 203、横滑 316 都更远）
    if (nodes[2].x !== 190 || nodes[2].y !== 560) throw new Error('a 应留在松手位：' + posOf(nodes));
    if (nodes[1].x !== 190 || nodes[1].y !== 369) throw new Error('f 应让到 369：' + posOf(nodes));
    if (nodes[0].y !== 0) throw new Error('同列的 b 不该动：' + posOf(nodes));
    if (!overlapFree(nodes)) throw new Error('落座后仍压着');
    return true;
  } finally { dragCleanup(prevSync); restore(prev); }
});

check('接线·卡片长高: 尺寸真变的卡先落座、下面的卡被推走；首测的新节点不算长高（给老卡让位）', () => {
  const prev = capture();
  const realMeasure = vm.runInContext('_measureNodes', sandbox);
  const prevRaf = vm.runInContext('requestAnimationFrame', sandbox);
  const prevZoom = vm.runInContext('graphView.zoom', sandbox);
  try {
    const nodes = seed({
      nodes: [
        { id: 'n', x: 190, y: 0, w: 300, h: 500 },
        { id: 'b', x: 190, y: 548, w: 300, h: 500 },
        { id: 'm', x: 190, y: 0, w: 0, h: 0 },
      ],
      layerOf: { n: 1, b: 1, m: 1 },
    });
    vm.runInContext('_realignGraphColumns({ force: true })', sandbox);
    // 假 DOM：只有 n 一张卡的矩形，量出来 700 高；真 _measureNodes 记「尺寸真变过」名单
    const fakeEl = { dataset: { nodeId: 'n' }, getBoundingClientRect: () => ({ width: 300, height: 700 }) };
    sandbox.__gcFakeInner = { offsetWidth: 0, querySelectorAll: () => [fakeEl] };
    sandbox.__gcRealMeasure = realMeasure;
    vm.runInContext([
      'graphInner = __gcFakeInner;',
      '_graphCompositeScaleCache.valid = false;',
      '_measureNodes = __gcRealMeasure;',
      'graphView.zoom = 1;',
    ].join('\n'), sandbox);
    vm.runInContext('_measureNodes()', sandbox);
    if (nodes[0].h !== 700) throw new Error('测量应把 n 量成 700 高');
    if (!vm.runInContext('_graphResizedNodeIds.has("n")', sandbox)) throw new Error('尺寸真变的卡应进先落座名单');
    // 首测的 m（0→真身）不算长高
    fakeEl.dataset.nodeId = 'm';
    fakeEl.getBoundingClientRect = () => ({ width: 300, height: 60 });
    vm.runInContext('_measureNodes()', sandbox);
    if (vm.runInContext('_graphResizedNodeIds.has("m")', sandbox)) throw new Error('首测不该算长高');
    fakeEl.dataset.nodeId = 'n';
    fakeEl.getBoundingClientRect = () => ({ width: 300, height: 700 });
    vm.runInContext([
      '__gcUpdates.length = 0;',
      'requestAnimationFrame = function(cb){ cb(); return 1; };',
      '_nodeGeomPending.add("n");',
      '_scheduleEdgeResync();',
    ].join('\n'), sandbox);
    if (nodes[1].y !== 648) throw new Error('长高后 b 应被推到 648：' + posOf(nodes));
    if (nodes[0].y !== 0) throw new Error('长高的卡自己不动：' + posOf(nodes));
    if (vm.runInContext('_graphResizedNodeIds.size', sandbox) !== 0) throw new Error('名单取走后应清空');
    const st = vm.runInContext('__gcState', sandbox);
    if (!st.positions.b || st.positions.b.y !== 648) throw new Error('存档位应跟上：' + JSON.stringify(st.positions));
    return true;
  } finally {
    vm.runInContext([
      'requestAnimationFrame = __gcPrevRaf;',
      'graphView.zoom = __gcPrevZoom;',
      '_nodeGeomPending.clear();',
      '_graphResizedNodeIds.clear();',
    ].join('\n'), Object.assign(sandbox, { __gcPrevRaf: prevRaf, __gcPrevZoom: prevZoom }));
    restore(prev);
  }
});

check('接线·画布重建: 有存档位的先落座，新节点给老节点让位；挪了人就落盘', () => {
  const prev = capture();
  const prevCanvas = vm.runInContext('typeof graphCanvas !== "undefined" ? graphCanvas : null', sandbox);
  const prevRaf = vm.runInContext('requestAnimationFrame', sandbox);
  const prevMarked = vm.runInContext('typeof marked !== "undefined" ? marked : null', sandbox);
  const prevPurify = vm.runInContext('typeof DOMPurify !== "undefined" ? DOMPurify : null', sandbox);
  const prevKatexPass = vm.runInContext('typeof _graphKatexVisiblePass !== "undefined" ? _graphKatexVisiblePass : null', sandbox);
  const prevVizInit = vm.runInContext('typeof _initVizIframes !== "undefined" ? _initVizIframes : null', sandbox);
  try {
    seed({ nodes: [], layerOf: {}, freeNodes: {} });
    vm.runInContext([
      'var __raf = []; requestAnimationFrame = function(cb){ __raf.push(cb); return __raf.length; };',
      'marked = { parse: function(s){ return String(s == null ? "" : s); } };',
      'DOMPurify = { sanitize: function(s){ return String(s == null ? "" : s); } };',
      // n1 有存档位（老节点）；n2 没存过位（新节点，建在 n1 身上）
      '__gcState.customNodes = [',
      '  { id: "n1", kind: "blank", x: 190, y: 0, content: "甲", customWidth: 300, customHeight: 500 },',
      '  { id: "n2", kind: "blank", x: 190, y: 100, content: "乙", customWidth: 300, customHeight: 500 }];',
      '__gcState.positions = { n1: { x: 190, y: 0 } }; __gcState.layoutVersion = ' + vm.runInContext('LAYOUT_VERSION', sandbox) + ';',
      '__gcState.layerOf = { n1: 1, n2: 1 };',
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
      'JSON.stringify({ model: graphView.nodes.map(function(n){ return [n.id, n.x, n.y]; }),',
      '  saved: __gcState.positions, snaps: __gcSnaps })',
    ].join('\n'), sandbox));
    const byId = Object.fromEntries(r.model.map(([id, x, y]) => [id, [x, y]]));
    if (JSON.stringify(byId.n1) !== '[190,0]') throw new Error('老节点不该动：' + JSON.stringify(r.model));
    if (JSON.stringify(byId.n2) !== '[190,548]') throw new Error('新节点应给老节点让位（落到 48 缝下 548）：' + JSON.stringify(r.model));
    if (!r.saved.n2 || r.saved.n2.y !== 548) throw new Error('让位结果应落盘：' + JSON.stringify(r.saved));
    const last = r.snaps[r.snaps.length - 1];
    if (JSON.stringify(last) !== JSON.stringify(r.model)) throw new Error('DOM 最后快照与模型脱节：' + JSON.stringify({ last, model: r.model }));
    return true;
  } finally {
    vm.runInContext([
      'requestAnimationFrame = __gcPrevRaf;',
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

check('接线: 实体落座六处全接上（整理/拖拽三分支/改尺寸/长高/重建）＋存盘节流', () => {
  const layout = fs.readFileSync('src/static/js/graph-render-layout.js', 'utf8');
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const render = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!layout.includes('function _resolveGraphNodeOverlaps(opts)')) throw new Error('实体落座函数缺失');
  if (!layout.includes('const GRAPH_NODE_CLEARANCE = 16;')) throw new Error('净距常量缺失');
  if (layout.includes('_resolveLayoutRectOverlaps')) throw new Error('旧矩形碰撞又回来了（别按「各让一半」推开，那会把整理好的列拆散）');
  const arrangeAt = layout.indexOf('_resolveGraphNodeOverlaps({ prior: arrangedIds })');
  const fitAt = layout.lastIndexOf('_fitAllGroupsToMembers();');
  if (arrangeAt < 0 || fitAt < 0 || arrangeAt > fitAt) throw new Error('整理未在重算组框前接实体落座');
  // 整理里列成员先落座：名单必须取自 _graphColumns（列是唯一事实源）
  if (!layout.includes('_graphColumns().forEach(col => col.members.forEach(n => arrangedIds.push(n.id)))')) throw new Error('整理的先落座名单没取自列清单');
  if (!layout.includes('function _scheduleGraphPositionsSave()')) throw new Error('落座存盘节流缺失');
  if (!interact.includes('_resolveGraphNodeOverlaps({ prior: Object.keys(savedPositions) })')) throw new Error('画布重建未接实体落座（存档位优先）');
  if (!interact.includes("_resolveGraphNodeOverlaps({ last: draggedIds, noRefitFor: draggedIds })")) throw new Error('自由落点未接实体落座');
  if (!interact.includes('prior: committed.assigned.map(item => item.id).concat(touched),')) throw new Error('多选落点未接实体落座');
  if (!interact.includes('prior: groupCommitted.assigned.map(item => item.id).concat(groupTouched),')) throw new Error('整组落点未接实体落座');
  if (!interact.includes("_resolveGraphNodeOverlaps({ prior: settledIds ? [node.id].concat(settledIds) : [node.id] })")) throw new Error('单卡进列未接实体落座');
  if (!interact.includes('_resolveGraphNodeOverlaps({ prior: [node.id], grown: [node.id], rememberHome: true })')) throw new Error('改尺寸每帧未接实体落座/未记原位');
  if (!interact.includes('restore: _graphPushedHome')) throw new Error('改尺寸松手未接弹性回位');
  if (interact.includes('graphView.resizeStartPositions')) throw new Error('旧的单手势回位基准仍残留');
  if (!interact.includes('_forgetGraphNodeHome(draggedIds)') || !interact.includes('_forgetGraphNodeHome(movedIds)')) throw new Error('亲手拖过的卡未作废原位');
  if (!layout.includes('_forgetGraphNodeHome(arrangedIds)')) throw new Error('整理未作废列成员原位');
  if (!layout.includes('const pairGap = (idA, colA, idB, colB) => (')) throw new Error('压到判距（同列长高按 48、其余按 16）缺失');
  // （弹性回位断言见上）
  // （弹性回位断言见上）
  if (!render.includes('_resolveGraphNodeOverlaps({ prior: grown, grown, skip: _graphNodesInGesture() })')) throw new Error('尺寸测量后未接实体落座（或没把长高名单交给它）');
  if (!render.includes('_noteGraphNodeResized(node.id)')) throw new Error('测量未记「尺寸真变过」名单');
  if (!render.includes('if (prevW > 0 && prevH > 0 &&')) throw new Error('首测不该算长高');
  return true;
});

await drain();
}
