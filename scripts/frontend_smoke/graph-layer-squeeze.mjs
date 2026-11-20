// 画布宽节点让位（2026-11-20）：宽节点松手归层成功后，若它让本层节点右缘「长宽了」，
// 右侧各层整块同量右移给它的宽度让位（用户拍板「只往右推」，墙左边的层绝不推）。
// 推移量按节点缝算（48+24），不按色带（左右各 56 呼吸边会把空隙多算 112px）；
// 2026-11-20 晚补三处：①同层重复松手不再按「摘掉自己」算 growth（preX 口径）；
// ②首个邻层补到 72px 节点缝、右侧整块平移同量（旧式把 growth 算两遍且逐列压 8px）；
// ③组框随成员整块走，不被踢出组。
// 回归七例（八个面）：①挤进宽节点→右邻层2/层3整列平移＋钉住节点 fixedX 同步＋transform/补画线被调用；
// ②窄节点加入（色带右缘没生长）不动任何人；③节点只从左边探出（右缘反而缩）不触发；
// ④接线静态契约；⑤同一层里原样再放一次（preX＝起手 x）不推；⑥分组成员随组整块右移且留在组内；
// ⑦落点行槽被占时纵向落座到最近空位；⑧改尺寸也接线让位（resize 松手读起始几何）。
import { check, drain, sandbox, vm, fs } from './_runner.mjs';

export async function run() {
const SEED = {
  nodes: [
    { id: 'root', x: 0, y: 0, w: 200, h: 80 },            // 层0
    { id: 'mid', x: 420, y: 0, w: 200, h: 80 },           // 层1（root 之子）
    { id: 'wide', x: 420, y: 300, w: 500, h: 120 },       // 刚被吸附进层1（模拟松手后的 state）
    { id: 'right', x: 840, y: 0, w: 200, h: 80, pinned: true, fixedX: 840, fixedY: 0 },  // 层2
    { id: 'deep', x: 1260, y: 0, w: 200, h: 80 },         // 层3
    { id: 'free', x: 100, y: 600, w: 160, h: 80 },        // 层4（deep 之子，但被用户拖到最左边）
  ],
  edges: [
    { from: 'root', to: 'mid' },
    { from: 'mid', to: 'right' },
    { from: 'right', to: 'deep' },
    { from: 'deep', to: 'free' },
  ],
};

function capture() {
  return {
    nodes: vm.runInContext('graphView.nodes', sandbox),
    edges: vm.runInContext('graphView.edges', sandbox),
    groups: vm.runInContext('graphView.groups', sandbox),
    byId: vm.runInContext('graphView.nodeById', sandbox),
    state: vm.runInContext('_graphState', sandbox),
    upd: vm.runInContext('typeof _updateNodeTransforms !== "undefined" ? _updateNodeTransforms : null', sandbox),
    redraw: vm.runInContext('typeof _redrawEdges !== "undefined" ? _redrawEdges : null', sandbox),
    inner: vm.runInContext('graphInner', sandbox),
  };
}
function restore(prev) {
  // 无条件全字段还原：seedWith 换过 groups/nodeById（工坊落图链路会读 nodeById），
  // 漏一个就跨域传染——T411 的教训在模块全局上同样成立。
  vm.runInContext([
    'graphView.nodes = __sqPrevNodes;',
    'graphView.edges = __sqPrevEdges;',
    'graphView.groups = __sqPrevGroups;',
    'graphView.nodeById = __sqPrevById;',
    '_graphState = __sqPrevState;',
    '_updateNodeTransforms = __sqPrevUpd;',
    '_redrawEdges = __sqPrevRedraw;',
    'graphInner = __sqPrevInner;',
  ].join(' '), Object.assign(sandbox, {
    __sqPrevNodes: prev.nodes, __sqPrevEdges: prev.edges, __sqPrevGroups: prev.groups,
    __sqPrevById: prev.byId, __sqPrevState: prev.state, __sqPrevUpd: prev.upd,
    __sqPrevRedraw: prev.redraw, __sqPrevInner: prev.inner,
  }));
}

function seedWith(wide, opts) {
  const options = opts || {};
  const nodes = SEED.nodes.map(n => Object.assign({}, n, n.id === 'wide' ? wide : {}));
  vm.runInContext([
    'graphView.nodes = __sqSeed.nodes;',
    'graphView.edges = __sqSeed.edges;',
    'graphView.groups = __sqSeed.groups;',
    'graphView.nodeById = {};',
    'graphView.nodes.forEach(function(n){ graphView.nodeById[n.id] = n; });',
    '__sqState = { layerOf: { wide: 1 }, groups: [] };',
    'graphInner = null;',
    '__sqUpd = []; _updateNodeTransforms = function(ids){ __sqUpd.push((ids || []).slice()); return []; };',
    '__sqRedraw = 0; _redrawEdges = function(){ __sqRedraw++; };',
    '_graphState = function(){ return __sqState; };',
    '_saveGraphState = function(){};',
    '_squeezeLayersRightForNode(graphView.nodes[2], __sqOpts);',
  ].join('\n'), Object.assign(sandbox, {
    __sqSeed: { nodes: nodes, edges: SEED.edges, groups: options.groups || [] },
    __sqOpts: options.squeeze || {},
  }));
}
const probe = () => JSON.parse(vm.runInContext(
  'JSON.stringify(graphView.nodes.reduce(function(a, n){ a[n.id] = { x: n.x, fixedX: n.fixedX, pinned: !!n.pinned }; return a; }, {}))',
  sandbox));

check('让位: 宽节点挤进层1→右邻层2/层3整列连锁右移、钉住 fixedX 同步、墙左边的层4不动', () => {
  const prev = capture();
  try {
    // 700 宽的卡挤进层1：本层节点右缘 520→770（growth 150），层2 节点左缘 740 已被压到 -30；
    // 补到「正常缝 48＋富余 24」＝推 102，右侧所有层整块同量平移（列距不变）。
    seedWith({ w: 700, x: 420 });
    const r = probe();
    if (r.right.x !== 942 || r.right.fixedX !== 942 || !r.right.pinned) throw new Error('层2 应整列右移 102 且 fixedX 同步：' + JSON.stringify(r.right));
    if (r.deep.x !== 1362) throw new Error('层3 应与层2 同量右移 102（相对间距不变）：' + JSON.stringify(r.deep));
    if (r.free.x !== 100) throw new Error('层4 在墙左边，绝不能被推：' + JSON.stringify(r.free));
    if (r.mid.x !== 420 || r.root.x !== 0 || r.wide.x !== 420) throw new Error('本层成员与被拖节点不该动：' + JSON.stringify(r));
    const upd = vm.runInContext('JSON.stringify(__sqUpd)', sandbox);
    if (upd.indexOf('right') < 0 || upd.indexOf('deep') < 0) throw new Error('_updateNodeTransforms 应收到被挪节点的 id：' + upd);
    if (vm.runInContext('__sqRedraw', sandbox) !== 1) throw new Error('挪了别人必须补一次画线');
    return true;
  } finally {
    restore(prev);
  }
});

check('让位: 窄节点加入（色带右缘没生长）→ 任何人都一动不动', () => {
  const prev = capture();
  try {
    seedWith({ w: 200, x: 420 });
    const r = probe();
    if (r.right.x !== 840 || r.deep.x !== 1260 || r.free.x !== 100) throw new Error('窄节点加入不该挤开任何人：' + JSON.stringify(r));
    if (vm.runInContext('__sqUpd.length', sandbox) !== 0 || vm.runInContext('__sqRedraw', sandbox) !== 0) throw new Error('没挪人就不该写 transform/补画线');
    return true;
  } finally {
    restore(prev);
  }
});

check('让位: 节点只从左边探出（色带右缘没长反缩）→ 只往右推的拍板口径，不推任何人', () => {
  const prev = capture();
  try {
    // w=400 落在 x=300：右缘 576 < 原右缘 580，色带右缘没长宽（left-stick）
    seedWith({ w: 400, x: 300 });
    const r = probe();
    if (r.right.x !== 840 || r.deep.x !== 1260 || r.free.x !== 100) throw new Error('左侧探出不触发右推：' + JSON.stringify(r));
    return true;
  } finally {
    restore(prev);
  }
});

check('让位: 同一层里原样再放一次（preX＝起手 x）→ 不把右邻列再推一遍', () => {
  const prev = capture();
  try {
    // 500 宽的卡本来就在层1、起手也在 x=420：右缘一点没长，growth=0
    seedWith({ w: 700, x: 420 }, { squeeze: { preX: 420, preW: 700 } });
    const r = probe();
    if (r.right.x !== 840 || r.deep.x !== 1260 || r.free.x !== 100) throw new Error('同层原样松手不该推任何人：' + JSON.stringify(r));
    if (vm.runInContext('__sqUpd.length', sandbox) !== 0) throw new Error('不该写 transform');
    return true;
  } finally {
    restore(prev);
  }
});

check('让位: 组框随成员整块右移，松手后的包含同步不会把成员踢出组', () => {
  const prev = capture();
  try {
    seedWith({ w: 700, x: 420 }, { groups: [{ id: 'g1', x: 660, y: -140, width: 360, height: 280, nodeIds: ['right'] }] });
    const r = probe();
    const g = JSON.parse(vm.runInContext('JSON.stringify(graphView.groups[0])', sandbox));
    if (r.right.x !== 942) throw new Error('成员应随让位右移：' + JSON.stringify(r.right));
    if (Math.round(g.x) !== 762) throw new Error('组框应与成员同移 102：' + JSON.stringify(g));
    if (!vm.runInContext("_isNodeFullyInsideGroup(graphView.nodeById.right, graphView.groups[0])", sandbox)) throw new Error('组框没罩住成员');
    vm.runInContext('_syncGroupMembersByContainment()', sandbox);
    const ids = JSON.parse(vm.runInContext('JSON.stringify(graphView.groups[0].nodeIds)', sandbox));
    if (ids.indexOf('right') < 0) throw new Error('包含同步把成员踢出组了：' + JSON.stringify(ids));
    return true;
  } finally {
    restore(prev);
  }
});

check('落座: 落点行槽已被同列邻居占住→只挪新来的那颗到最近空位，邻居不动', () => {
  const prev = capture();
  try {
    vm.runInContext([
      'graphView.nodes = [',
      '  { id:"m", x:420, y:0, w:200, h:80 },',
      '  { id:"n", x:420, y:0, w:500, h:120 }',
      '];',
      'graphView.nodeById = { m: graphView.nodes[0], n: graphView.nodes[1] };',
      'graphView.groups = [];',
      '__sqLayer = { m: 1, n: 1 };',
    ].join('\n'), sandbox);
    const moved = vm.runInContext('_settleNodeIntoLayer(graphView.nodes[1], 1, __sqLayer)', sandbox);
    const y = vm.runInContext('graphView.nodes[1].y', sandbox);
    const mx = vm.runInContext('graphView.nodes[0].x', sandbox);
    if (!moved) throw new Error('应触发纵向落座');
    if (Math.abs(y) < (80 + 120) / 2 + 48 - 0.5) throw new Error('落座后仍与邻居重叠：' + y);
    if (mx !== 420) throw new Error('邻居不该动：' + mx);
    return true;
  } finally {
    restore(prev);
  }
});

check('接线: 落座在写 layerOf 之前；拖拽与改尺寸都按 pre 几何调让位；改尺寸同步中心', () => {
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const settle = interact.indexOf('_settleNodeIntoLayer(node, snap.depth, layerOfBefore);');
  const layerOfWrite = interact.indexOf('state.layerOf[node.id] = snap.depth;');
  if (settle < 0) throw new Error('松手段缺少纵向落座');
  if (layerOfWrite < 0 || settle > layerOfWrite) throw new Error('落座必须在写 layerOf 之前（按目标层成员避让）');
  if (interact.indexOf('_squeezeLayersRightForNode(node, { preX: wasInLayer ? startX : null });') < 0) throw new Error('拖拽让位缺 preX 口径');
  if (interact.indexOf('if (!graphView.altFree && !graphView.dragWasSelected)') >= 0) throw new Error('先点选再单拖又被拦在归层之外（吸附/落座/让位会静默失效）');
  if (interact.indexOf('if (!graphView.altFree) {') < 0) throw new Error('单节点归层入口缺失');
  if (interact.indexOf('_squeezeLayersRightForNode(node, { preX: graphView.resizeStartNodeX, preW: graphView.resizeStartW });') < 0) throw new Error('改尺寸松手未接让位');
  if (interact.indexOf('node.x = startCx + (node.customWidth - graphView.resizeStartW) / 2;') < 0) throw new Error('改尺寸未同步中心');
  if (interact.indexOf('const group = (graphView.groups || []).find(g => (g.nodeIds || []).includes(node.id));') < 0) throw new Error('改尺寸未贴合所属组框');
  const layout = fs.readFileSync('src/static/js/graph-render-layout.js', 'utf8');
  if (!layout.includes('function _squeezeLayersRightForNode(node, opts)')) throw new Error('让位函数缺 opts');
  if (!layout.includes('function _settleNodeIntoLayer(node, depth, layerOf)')) throw new Error('落座函数缺失');
  if (!layout.includes('const GRAPH_LAYER_PUSH_MARGIN = 24;')) throw new Error('富余常量缺失或被改值');
  if (!layout.includes('const GRAPH_LAYER_NODE_GAP = 48;')) throw new Error('横向正常节点缝常量缺失或被改值');
  if (!layout.includes('const GRAPH_LAYER_BAND_PADX = 56;') || !layout.includes('const GRAPH_LAYER_BAND_MINW = 320;')) throw new Error('层带共用常量缺失');
  if (!layout.includes('Math.max(GRAPH_LAYER_BAND_MINW, g.maxX - g.minX + padX * 2)')) throw new Error('_graphLayerBands 未换用共用常量（两处带宽口径会漂移）');
  return true;
});

await drain();
}
