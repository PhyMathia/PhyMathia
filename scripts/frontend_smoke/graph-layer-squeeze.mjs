// 画布宽节点让位（2026-11-20）：宽节点松手归层成功后，若它让本层色带右缘「长宽了」，
// 右侧各层整列连锁右移给它的宽度让位（用户拍板「只往右推」，墙左边的层绝不推）。
// 推移量＝色带右缘生长量＋富余；前层挪走后自己还有富余的层少挪甚至不挪（按实际几何传导）。
// 回归四面：①挤进宽节点→右邻层2/层3整列平移＋钉住节点 fixedX 同步＋transform/补画线被调用；
// ②窄节点加入（色带右缘没生长）不动任何人；③节点只从左边探出（右缘反而缩）不触发；
// ④接线静态契约（松手段在 layerOf 写入之后调用；共用常量在位、_graphLayerBands 换用常量）。
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
function seedWith(wide) {
  const nodes = SEED.nodes.map(n => Object.assign({}, n, n.id === 'wide' ? wide : {}));
  vm.runInContext([
    'graphView.nodes = __sqSeed.nodes;',
    'graphView.edges = __sqSeed.edges;',
    'graphView.groups = [];',
    'graphView.nodeById = {};',
    '__sqState = { layerOf: { wide: 1 } };',
    'graphInner = null;',
    '__sqUpd = []; _updateNodeTransforms = function(ids){ __sqUpd.push((ids || []).slice()); return []; };',
    '__sqRedraw = 0; _redrawEdges = function(){ __sqRedraw++; };',
    '_graphState = function(){ return __sqState; };',
    '_squeezeLayersRightForNode(graphView.nodes[2]);',
  ].join('\n'), Object.assign(sandbox, { __sqSeed: { nodes: nodes, edges: SEED.edges } }));
}
const probe = () => JSON.parse(vm.runInContext(
  'JSON.stringify(graphView.nodes.reduce(function(a, n){ a[n.id] = { x: n.x, fixedX: n.fixedX, pinned: !!n.pinned }; return a; }, {}))',
  sandbox));

check('让位: 宽节点挤进层1→右邻层2/层3整列连锁右移、钉住 fixedX 同步、墙左边的层4不动', () => {
  const prev = capture();
  try {
    seedWith({ w: 500, x: 420 });
    const r = probe();
    // 色带右缘 580→726（长宽 146）；层2 左缘 680 < 904 → 平移 224；层3 被传导再挪 132；层4 在墙左边→不动
    if (r.right.x !== 1064 || r.right.fixedX !== 1064 || !r.right.pinned) throw new Error('层2 应整列右移 224 且 fixedX 同步：' + JSON.stringify(r.right));
    if (r.deep.x !== 1392) throw new Error('层3 应被连锁传导右移 132：' + JSON.stringify(r.deep));
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

check('让位: 接线静态契约——松手段在 layerOf 写入之后调用；常量在位、层带换用共用常量', () => {
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const call = interact.indexOf('_squeezeLayersRightForNode(node);');
  const layerOfWrite = interact.indexOf('state.layerOf[node.id] = snap.depth;');
  if (call < 0) throw new Error('松手段缺少让位调用');
  if (layerOfWrite < 0 || layerOfWrite > call) throw new Error('让位必须发生在 layerOf 写入之后（squeeze 读 state.layerOf 定墙）');
  const layout = fs.readFileSync('src/static/js/graph-render-layout.js', 'utf8');
  if (!layout.includes('function _squeezeLayersRightForNode(node)')) throw new Error('让位函数缺失');
  if (!layout.includes('const GRAPH_LAYER_PUSH_MARGIN = 24;')) throw new Error('富余常量缺失或被改值');
  if (!layout.includes('const GRAPH_LAYER_BAND_GAP = 8;')) throw new Error('最小缝常量缺失或被改值');
  if (!layout.includes('const GRAPH_LAYER_BAND_PADX = 56;') || !layout.includes('const GRAPH_LAYER_BAND_MINW = 320;')) throw new Error('层带共用常量缺失');
  if (!layout.includes('Math.max(GRAPH_LAYER_BAND_MINW, g.maxX - g.minX + padX * 2)')) throw new Error('_graphLayerBands 未换用共用常量（两处带宽口径会漂移）');
  return true;
});

await drain();
}
