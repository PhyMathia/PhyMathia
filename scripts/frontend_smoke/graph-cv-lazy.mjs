// 画布屏外卡免布局（T376，2026-10-23）：首屏布局成本大半来自全量内联的内容卡
// （2026-10-23 实测 87 卡 LayoutDuration 0.39s），content-visibility:auto 让浏览器
// 跳过视口外卡的布局，占位尺寸来自持久化 sizes（_savePositions 测量后存盘）。
// 回归两面：helper 行为（挂/不挂名单＋占位尺寸）、静态契约（接线位置＋导出克隆归位）。
//
// T394（2026-10-24 用户报「连线在卡外悬空」）并入本域：占位尺寸只在「卡还没排真身」时
// 成立，而边锚点是画线那一刻现读端口矩形的——卡进视口补排真身之后没人重画，线端就停在
// 空中（实测 28/37 条边错位，最大 150.7px）。这里补两面：_observeNodeGeometry 的行为
// （尺寸一变→合并一帧→只刷受影响的边）与三处接线/增量刷新契约。
//
// T452（2026-11-25）补盲区：流式补丁新增的卡原先一条都不挂 c-v。这里钉三件事——
// 挑人口径（两例外＋必须有持久化尺寸）、挂载只作用于本轮新建元素（已有卡一个不碰）、
// 接线位置（挂载必须在 _measureNodes 之前，且全量重建仍是 _applyNodeLazyLayout 唯一调用点）。
import { check, drain, sandbox, vm, fs } from './_runner.mjs';

export async function run() {
check('T376: _applyNodeLazyLayout——有尺寸卡挂 c-v＋占位尺寸，ai_eval/minimized/无尺寸除外', () => {
  if (typeof sandbox._applyNodeLazyLayout !== 'function') throw new Error('helper 未暴露');
  // graphInner/graphView 是 app.js 顶层词法绑定，只能 vm 进去钉桩；CSS 沙箱里没有，补最小 supports
  vm.runInContext('var __prevCSS = (typeof CSS === "undefined") ? null : CSS;', sandbox);
  vm.runInContext('CSS = { supports: function(){ return true; } };', sandbox);
  const prevInner = vm.runInContext('graphInner', sandbox);
  const prevNodes = vm.runInContext('graphView.nodes', sandbox);
  try {
    vm.runInContext([
      'var __els = ["n-ok","n-eval","n-mini","n-nosize","n-zero"].map(function(id){ return { dataset: { nodeId: id }, style: {}, offsetWidth: 700, offsetHeight: 920 }; });',
      'graphInner = { offsetWidth: 1200, querySelectorAll: function(){ return __els; } };',
      'graphView.nodes = [',
      "  { id: 'n-ok', kind: 'note' },",
      "  { id: 'n-eval', kind: 'ai_eval' },",
      "  { id: 'n-mini', kind: 'note', minimized: true },",
      "  { id: 'n-nosize', kind: 'note' },",
      "  { id: 'n-zero', kind: 'note' },",
      '];',
      'var __state = { sizes: {',
      '  "n-ok": { w: 640.4, h: 880.6, u: 0 },',
      '  "n-eval": { w: 300, h: 200, u: 0 },',
      '  "n-mini": { w: 300, h: 100, u: 0 },',
      '  "n-zero": { w: 0, h: 0, u: 0 },',
      '} };',
      '_applyNodeLazyLayout(__state);',
    ].join('\n'), sandbox);
    const styles = vm.runInContext('JSON.stringify(__els.map(function(e){ return { cv: e.style.contentVisibility || null, cis: e.style.containIntrinsicSize || null, ph: e.__cvPlaceholder || null }; }))', sandbox);
    const arr = JSON.parse(styles);
    // 有尺寸：挂 auto，占位尺寸取整（Math.round）
    if (arr[0].cv !== 'auto' || arr[0].cis !== 'auto 640px auto 881px') {
      throw new Error('有尺寸卡没挂上或占位尺寸不对：' + JSON.stringify(arr[0]));
    }
    // T393：挂完样式当场记下占位盒（offsetWidth/Height 是布局盒，不受缩放影响）
    if (!arr[0].ph || arr[0].ph.w !== 700 || arr[0].ph.h !== 920) {
      throw new Error('占位盒没记在元素上：' + JSON.stringify(arr[0].ph));
    }
    // ai_eval（锯齿描边外扩 6px，paint 包含会裁）、minimized（本就无内容子树）、
    // 无尺寸（占位会污染 _measureNodes）、零尺寸：一律不挂
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].cv !== null) throw new Error('不该挂的卡挂上了：index ' + i + ' -> ' + JSON.stringify(arr[i]));
      if (arr[i].ph !== null) throw new Error('不挂的卡不该记占位盒：index ' + i);
    }
    return true;
  } finally {
    vm.runInContext('graphInner = __prevInner;', Object.assign(sandbox, { __prevInner: prevInner }));
    vm.runInContext('graphView.nodes = __prevNodes;', Object.assign(sandbox, { __prevNodes: prevNodes }));
    vm.runInContext('if (__prevCSS) { CSS = __prevCSS; } else { try { delete CSS; } catch (e) {} }', sandbox);
  }
});

check('T393: _measureNodes 把占位读数挡在存盘外——屏外卡占位没变保留旧尺寸，真身变了才收', () => {
  if (typeof sandbox._measureNodes !== 'function') throw new Error('helper 未暴露');
  const keep = ['graphInner', 'graphView', 'graphCanvas', '_graphCompositeScale', '_syncGroupMembersByContainment'];
  const prev = {};
  for (const k of keep) prev[k] = vm.runInContext('typeof ' + k + ' === "undefined" ? undefined : ' + k, sandbox);
  try {
    vm.runInContext([
      // 画布盒 1200×800；2026-11-25 判据加「整盒在视口外」前提，假卡都给足坐标
      'graphCanvas = { getBoundingClientRect: function(){ return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }; } };',
      // 占位盒：contain-intrinsic-size 的内容尺寸 + padding/border（320×934），量到的仍是它；整盒在视口外
      'var __elPh = { dataset: { nodeId: "n-ph" }, __cvPlaceholder: { w: 320, h: 934 }, getBoundingClientRect: function(){ return { left: 0, top: 5000, right: 320, bottom: 5934, width: 320, height: 934 }; } };',
      // 同一张卡已经排过真身：读数离开占位盒，必须收
      'var __elReal = { dataset: { nodeId: "n-real" }, __cvPlaceholder: { w: 320, h: 934 }, getBoundingClientRect: function(){ return { left: 40, top: 100, right: 560, bottom: 1300, width: 520, height: 1200 }; } };',
      // 没挂 c-v 的新卡：照旧全收
      'var __elPlain = { dataset: { nodeId: "n-plain" }, getBoundingClientRect: function(){ return { left: 100, top: 100, right: 380, bottom: 240, width: 280, height: 140 }; } };',
      'var __els = [__elPh, __elReal, __elPlain];',
      'graphInner = { querySelectorAll: function(){ return __els; } };',
      'graphView.nodes = [',
      '  { id: "n-ph", kind: "module", w: 151, h: 900 },',
      '  { id: "n-real", kind: "module", w: 151, h: 900 },',
      '  { id: "n-plain", kind: "answer", w: 0, h: 0 },',
      '];',
      '_graphCompositeScale = function(){ return 1; };',
      '_syncGroupMembersByContainment = function(){};',
      '_measureNodes();',
    ].join('\n'), sandbox);
    const got = JSON.parse(vm.runInContext('JSON.stringify(graphView.nodes.map(function(n){ return [n.w, n.h]; }))', sandbox));
    if (got[0][0] !== 151 || got[0][1] !== 900) throw new Error('占位读数不该覆盖旧尺寸：' + JSON.stringify(got[0]));
    if (got[1][0] !== 520 || got[1][1] !== 1200) throw new Error('真身读数没被收下：' + JSON.stringify(got[1]));
    if (got[2][0] !== 280 || got[2][1] !== 140) throw new Error('普通卡测量被误挡：' + JSON.stringify(got[2]));
    return true;
  } finally {
    vm.runInContext([
      'graphInner = __prev_graphInner;',
      'graphCanvas = __prev_graphCanvas;',
      'graphView.nodes = __prev_graphView_nodes;',
      '_graphCompositeScale = __prev__graphCompositeScale;',
      '_syncGroupMembersByContainment = __prev__syncGroupMembersByContainment;',
    ].join('\n'), Object.assign(sandbox, {
      __prev_graphInner: prev.graphInner,
      __prev_graphCanvas: prev.graphCanvas,
      __prev_graphView_nodes: prev.graphView ? prev.graphView.nodes : undefined,
      __prev__graphCompositeScale: prev._graphCompositeScale,
      __prev__syncGroupMembersByContainment: prev._syncGroupMembersByContainment,
    }));
  }
});

check('T393b: 视口内插入的卡 __cvPlaceholder 记到的就是真身盒——读数==戳也必须收并记入长高名单（2026-11-25 viz 压叠根因）', () => {
  if (typeof sandbox._measureNodes !== 'function') throw new Error('helper 未暴露');
  const keep = ['graphInner', 'graphView', 'graphCanvas', '_graphCompositeScale', '_syncGroupMembersByContainment'];
  const prev = {};
  for (const k of keep) prev[k] = vm.runInContext('typeof ' + k + ' === "undefined" ? undefined : ' + k, sandbox);
  try {
    vm.runInContext([
      'graphCanvas = { getBoundingClientRect: function(){ return { left: 0, top: 0, right: 1200, bottom: 800, width: 1200, height: 800 }; } };',
      // 视口内的 viz 卡：插入即强制布局，戳里记的是真身盒（594），与后续每次读数都相同
      'var __elOn = { dataset: { nodeId: "v1" }, __cvPlaceholder: { w: 682, h: 594 }, getBoundingClientRect: function(){ return { left: 40, top: 100, right: 722, bottom: 694, width: 682, height: 594 }; } };',
      // 屏外的卡：c-v 真跳过，读数=占位盒，照旧跳过不收
      'var __elOff = { dataset: { nodeId: "f1" }, __cvPlaceholder: { w: 342, h: 234 }, getBoundingClientRect: function(){ return { left: 0, top: 5000, right: 342, bottom: 5234, width: 342, height: 234 }; } };',
      'var __els = [__elOn, __elOff];',
      'graphInner = { querySelectorAll: function(){ return __els; } };',
      'graphView.nodes = [',
      '  { id: "v1", kind: "module", w: 640, h: 234 },',
      '  { id: "f1", kind: "note", w: 300, h: 200 },',
      '];',
      '_graphCompositeScale = function(){ return 1; };',
      '_syncGroupMembersByContainment = function(){};',
      '_takeGraphResizedNodeIds();', // 清掉前面用例的残留，长高名单只看本轮
      '_measureNodes();',
    ].join('\n'), sandbox);
    const got = JSON.parse(vm.runInContext('JSON.stringify(graphView.nodes.map(function(n){ return [n.w, n.h]; }))', sandbox));
    if (got[0][0] !== 682 || got[0][1] !== 594) throw new Error('视口内的卡读数==戳没被收下（陈旧 234 永不自愈的根因）：' + JSON.stringify(got[0]));
    if (got[1][0] !== 300 || got[1][1] !== 200) throw new Error('屏外卡的占位读数被误收：' + JSON.stringify(got[1]));
    const grown = JSON.parse(vm.runInContext('JSON.stringify(_takeGraphResizedNodeIds())', sandbox));
    if (JSON.stringify(grown) !== '["v1"]') throw new Error('长高名单应为 [v1]（f1 没变尺寸不该进）：' + grown);
    return true;
  } finally {
    vm.runInContext([
      'graphInner = __prev_graphInner;',
      'graphCanvas = __prev_graphCanvas;',
      'graphView.nodes = __prev_graphView_nodes;',
      '_graphCompositeScale = __prev__graphCompositeScale;',
      '_syncGroupMembersByContainment = __prev__syncGroupMembersByContainment;',
    ].join('\n'), Object.assign(sandbox, {
      __prev_graphInner: prev.graphInner,
      __prev_graphCanvas: prev.graphCanvas,
      __prev_graphView_nodes: prev.graphView ? prev.graphView.nodes : undefined,
      __prev__graphCompositeScale: prev._graphCompositeScale,
      __prev__syncGroupMembersByContainment: prev._syncGroupMembersByContainment,
    }));
  }
});

check('T393: _buildGraphData 用持久化 sizes 垫首帧 w/h（占位读数被跳过时布局仍有尺寸可用）', () => {
  if (typeof sandbox._buildGraphData !== 'function') throw new Error('_buildGraphData 未暴露');
  const msgs = [
    { role: 'user', content: '单摆周期为什么与质量无关？', timestamp: 100 },
    { role: 'assistant', content: '<analysis>\n简谐运动\n</analysis>\n\n回复正文。', timestamp: 200 },
  ];
  const probe = sandbox._buildGraphData(msgs, {});
  const sizes = {};
  probe.nodes.forEach((n, i) => { sizes[n.id] = { w: 200 + i * 7.5, h: 120 + i * 3.25, u: 0 }; });
  // custom 节点也走同一份垫底（215.3 vs 151 就是 backlog 里记的那条实锤脏值）
  const customId = 'user-custom-1792229471400-lb46m';
  sizes[customId] = { w: 215.3, h: 151.2, u: 0 };
  const state = {
    sizes,
    customNodes: [{ id: customId, kind: 'user', x: 10, y: 20, timestamp: 1 }],
  };
  const data = sandbox._buildGraphData(msgs, state);
  if (data.nodes.length !== probe.nodes.length + 1) throw new Error('节点数不对：' + data.nodes.length);
  const bad = data.nodes.filter(n => !(Math.abs(n.w - sizes[n.id].w) < 1e-9 && Math.abs(n.h - sizes[n.id].h) < 1e-9));
  if (bad.length) {
    throw new Error('首帧 w/h 没垫上持久化尺寸：' + bad.map(n => n.id + '=' + n.w + 'x' + n.h).join(', '));
  }
  // custom 节点带 customWidth/Height（用户手动尺寸）时优先它，sizes 测量值不覆盖用户意图
  const st2 = { sizes: { 'c-1': { w: 215, h: 151, u: 0 } }, customNodes: [{ id: 'c-1', kind: 'user', customWidth: 300, customHeight: 260, x: 0, y: 0 }] };
  const c = sandbox._buildGraphData([], st2).nodeById['c-1'];
  if (!c || c.w !== 300 || c.h !== 260) throw new Error('customWidth/Height 没优先：' + JSON.stringify(c && [c.w, c.h]));
  return true;
});

check('T376: 接线与克隆归位——渲染链插入后首帧前挂、导出克隆剥掉 c-v', () => {
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const insertAt = interact.indexOf("graphInner.insertAdjacentHTML('beforeend', html)");
  const cvAt = interact.indexOf('_applyNodeLazyLayout(state)');
  const transformAt = interact.indexOf('_applyGraphTransform();');
  if (insertAt < 0 || cvAt < 0 || transformAt < 0) throw new Error('renderGraphCanvas 关键锚点缺失');
  if (!(insertAt < cvAt && cvAt < transformAt)) throw new Error('c-v 挂载不在「插入后、_applyGraphTransform 前」——赶不上首帧布局就白挂');
  const render = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!render.includes('function _applyNodeLazyLayout')) throw new Error('graph-render.js 缺 helper 定义');
  if (!render.includes("node.kind === 'ai_eval'")) throw new Error('锯齿描边卡（ai_eval）没有排除——paint 包含常开会裁掉外扩 6px 的描边');
  const exporter = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!/contentVisibility\s*=\s*'visible'/.test(exporter)) throw new Error('导出克隆没有把 content-visibility 归位为 visible——快照栅格化没有视口，屏外卡会以占位尺寸出图');
  return true;
});

check('T394: 卡换尺寸就重锚边——RO 合并一帧、只刷受影响的边，增量失败才整层重建', () => {
  if (typeof sandbox._observeNodeGeometry !== 'function') throw new Error('_observeNodeGeometry 未暴露');
  // graphInner/ResizeObserver/rAF 与三个被调 helper 都是沙箱里要钉桩的：RO 沙箱没有、
  // rAF 被 _runner 打成空函数（不钉桩就永远看不到重锚那一帧）
  const keep = ['graphInner', 'ResizeObserver', 'requestAnimationFrame', '_measureNodes', '_updateNodeTransforms', '_edgesTouchingNodeIds', '_refreshEdgeGeometry', '_redrawEdges'];
  const prev = {};
  for (const k of keep) prev[k] = vm.runInContext('typeof ' + k + ' === "undefined" ? undefined : ' + k, sandbox);
  try {
    vm.runInContext([
      'var __els = [{ dataset: { nodeId: "n-a" } }, { dataset: { nodeId: "n-b" } }];',
      'var __calls = { measure: 0, transforms: 0, touch: null, refresh: null, redraw: 0, refreshRet: true };',
      'var __ro = null;',
      'ResizeObserver = function (cb) { this.cb = cb; this.targets = []; __ro = this; };',
      'ResizeObserver.prototype.observe = function (el) { this.targets.push(el); };',
      'ResizeObserver.prototype.disconnect = function () { this.targets = []; };',
      'requestAnimationFrame = function (cb) { cb(); return 1; };',
      'graphInner = { querySelectorAll: function () { return __els; } };',
      '_measureNodes = function () { __calls.measure++; };',
      '_updateNodeTransforms = function () { __calls.transforms++; };',
      '_edgesTouchingNodeIds = function (ids) { __calls.touch = ids.slice(); return ["k1"]; };',
      '_refreshEdgeGeometry = function (keys) { __calls.refresh = keys.slice(); return __calls.refreshRet; };',
      '_redrawEdges = function () { __calls.redraw++; };',
      '_nodeGeomPending = new Set(); _nodeGeomRaf = 0;',
      '_observeNodeGeometry();',
    ].join('\n'), sandbox);
    const observed = vm.runInContext('__ro ? __ro.targets.length : -1', sandbox);
    if (observed !== 2) throw new Error('观察目标没挂全：' + observed + '（应 2）');
    // 一次尺寸变化：合并到一帧里只重扫这一个节点，走增量、不整层重建
    vm.runInContext('__ro.cb([{ target: { dataset: { nodeId: "n-a" } } }]);', sandbox);
    const got = JSON.parse(vm.runInContext('JSON.stringify(__calls)', sandbox));
    if (got.measure !== 1 || got.transforms !== 1) throw new Error('没重扫几何：' + JSON.stringify(got));
    if (JSON.stringify(got.touch) !== '["n-a"]') throw new Error('只该重扫受影响的节点，实际 ' + JSON.stringify(got.touch));
    if (JSON.stringify(got.refresh) !== '["k1"]') throw new Error('边几何没走增量刷新：' + JSON.stringify(got.refresh));
    if (got.redraw !== 0) throw new Error('增量可用时不该整层重建 SVG');
    // 增量不可用（边表变了/曲线编辑中）：退回整层重建
    vm.runInContext('__calls.refreshRet = false; _nodeGeomPending = new Set(); _nodeGeomRaf = 0; __ro.cb([{ target: { dataset: { nodeId: "n-b" } } }]);', sandbox);
    const got2 = JSON.parse(vm.runInContext('JSON.stringify(__calls)', sandbox));
    if (got2.redraw !== 1) throw new Error('增量失败时没退回 _redrawEdges：' + JSON.stringify(got2));
    return true;
  } finally {
    for (const k of keep) sandbox['__prev_' + k] = prev[k];
    vm.runInContext([
      'graphInner = __prev_graphInner;',
      '_measureNodes = __prev__measureNodes;',
      '_updateNodeTransforms = __prev__updateNodeTransforms;',
      '_edgesTouchingNodeIds = __prev__edgesTouchingNodeIds;',
      '_refreshEdgeGeometry = __prev__refreshEdgeGeometry;',
      '_redrawEdges = __prev__redrawEdges;',
      'requestAnimationFrame = __prev_requestAnimationFrame;',
      'if (__prev_ResizeObserver) { ResizeObserver = __prev_ResizeObserver; } else { try { delete ResizeObserver; } catch (e) { ResizeObserver = undefined; } }',
      '_nodeGeomRO = null; _nodeGeomPending = new Set(); _nodeGeomRaf = 0;',
    ].join('\n'), sandbox);
  }
});

check('T394: 接线契约——三处重挂观察器（首帧/流式补丁/单卡重渲）＋增量刷新落点', () => {
  const render = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!render.includes('function _observeNodeGeometry')) throw new Error('graph-render.js 缺 _observeNodeGeometry 定义');
  const fnBody = (src, name) => {
    const i = src.indexOf('function ' + name);
    if (i < 0) throw new Error('缺函数 ' + name);
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? src.length : j);
  };
  // 卡的 DOM 会被这三处换掉：观察目标不重挂＝尺寸后到就再也不重锚
  for (const name of ['_patchGraphStreaming', '_refreshWorkflowNodeUi']) {
    if (!fnBody(render, name).includes('_observeNodeGeometry()')) throw new Error(name + ' 换过卡 DOM 却没重挂观察器');
  }
  if (!fnBody(interact, 'renderGraphCanvas').includes('_observeNodeGeometry()')) throw new Error('renderGraphCanvas 首帧没挂观察器');
  const resync = fnBody(render, '_scheduleEdgeResync');
  if (!resync.includes('_refreshEdgeGeometry') || !resync.includes('_redrawEdges')) {
    throw new Error('_scheduleEdgeResync 没走「增量优先、整层兜底」');
  }
  if (!render.includes('function _edgesTouchingNodeIds')) throw new Error('缺 _edgesTouchingNodeIds（只刷受影响的边靠它）');
  return true;
});

check('T452: _nodeLazyLayoutPairs——只收「有持久化尺寸且非两例外」的新元素', () => {
  const pairs = sandbox._nodeLazyLayoutPairs(
    [
      { id: 'n-new', kind: 'note' },
      { id: 'n-eval', kind: 'ai_eval' },
      { id: 'n-mini', kind: 'note', minimized: true },
      { id: 'n-nosize', kind: 'answer' },
      { id: 'n-zero', kind: 'note' },
      { id: 'n-noel', kind: 'note' },
    ],
    new Map([
      ['n-new', { el: 'new' }], ['n-eval', { el: 'eval' }], ['n-mini', { el: 'mini' }],
      ['n-nosize', { el: 'nosize' }], ['n-zero', { el: 'zero' }],
    ]),
    {
      'n-new': { w: 640.4, h: 880.6 }, 'n-eval': { w: 300, h: 200 }, 'n-mini': { w: 300, h: 100 },
      'n-zero': { w: 0, h: 0 }, 'n-noel': { w: 100, h: 100 },
    }
  );
  // loose 代理下缺失的全局会返回同款假对象——非数组即说明 helper 没进产物
  if (!Array.isArray(pairs)) throw new Error('返回的不是数组：helper 未进打包产物');
  if (pairs.length !== 1) throw new Error('够格名单不对：' + JSON.stringify(pairs.map(p => p.el.el)));
  if (pairs[0].el.el !== 'new' || pairs[0].size.w !== 640.4) throw new Error('挑中的不是 n-new：' + JSON.stringify(pairs[0]));
  return true;
});

check('T452: 新建卡挂 c-v＋当场记占位；已有卡不动；面板隐藏只挂样式不记占位', () => {
  if (typeof sandbox._mountNodeLazyLayout !== 'function') throw new Error('挂载原语未暴露');
  const keep = ['graphInner', 'CSS'];
  const prev = {};
  for (const k of keep) prev[k] = vm.runInContext('typeof ' + k + ' === "undefined" ? undefined : ' + k, sandbox);
  try {
    vm.runInContext([
      'var __prevCSS2 = (typeof CSS === "undefined") ? null : CSS;',
      'CSS = { supports: function(){ return true; } };',
      // 刚插进去的新卡：还没进过布局，量到的就是占位盒
      'var __fresh = { style: {}, offsetWidth: 700, offsetHeight: 920 };',
      // 已在画布上的老卡：带着上一轮的 c-v 与占位标记，本轮不该被碰
      'var __old = { style: { contentVisibility: "auto", containIntrinsicSize: "auto 100px auto 100px" }, __cvPlaceholder: { w: 100, h: 100 }, offsetWidth: 100, offsetHeight: 100 };',
      'graphInner = { offsetWidth: 1200 };',
      'var __sizes = { "n-new": { w: 640.4, h: 880.6 } };',
      'var __pairs = _nodeLazyLayoutPairs([{ id: "n-new", kind: "note" }], new Map([["n-new", __fresh]]), __sizes);',
      '_mountNodeLazyLayout(__pairs);',
    ].join('\n'), sandbox);
    const fresh = JSON.parse(vm.runInContext('JSON.stringify({ cv: __fresh.style.contentVisibility || null, cis: __fresh.style.containIntrinsicSize || null, ph: __fresh.__cvPlaceholder || null })', sandbox));
    if (fresh.cv !== 'auto' || fresh.cis !== 'auto 640px auto 881px') throw new Error('新卡没挂上或占位尺寸不对：' + JSON.stringify(fresh));
    if (!fresh.ph || fresh.ph.w !== 700 || fresh.ph.h !== 920) throw new Error('新卡没当场记占位盒：' + JSON.stringify(fresh.ph));
    const old = JSON.parse(vm.runInContext('JSON.stringify({ cv: __old.style.contentVisibility, cis: __old.style.containIntrinsicSize, ph: __old.__cvPlaceholder })', sandbox));
    if (old.cv !== 'auto' || old.cis !== 'auto 100px auto 100px' || old.ph.w !== 100 || old.ph.h !== 100) {
      throw new Error('已有卡被重记了（红线）: ' + JSON.stringify(old));
    }
    // 面板隐藏：量不到占位（offsetWidth 为 0 时浏览器布局宽也是 0），只挂样式不记标记
    vm.runInContext([
      'var __fresh2 = { style: {}, offsetWidth: 0, offsetHeight: 0 };',
      'graphInner = { offsetWidth: 0 };',
      '_mountNodeLazyLayout(_nodeLazyLayoutPairs([{ id: "n-new", kind: "note" }], new Map([["n-new", __fresh2]]), __sizes));',
    ].join('\n'), sandbox);
    const hidden = JSON.parse(vm.runInContext('JSON.stringify({ cv: __fresh2.style.contentVisibility || null, ph: __fresh2.__cvPlaceholder || null })', sandbox));
    if (hidden.cv !== 'auto') throw new Error('隐藏面板下样式也没挂：' + JSON.stringify(hidden));
    if (hidden.ph !== null) throw new Error('隐藏面板下不该记占位盒（量不到）: ' + JSON.stringify(hidden.ph));
    return true;
  } finally {
    vm.runInContext([
      'graphInner = __prev_graphInner;',
      'if (__prevCSS2) { CSS = __prevCSS2; } else { try { delete CSS; } catch (e) { CSS = undefined; } }',
    ].join('\n'), Object.assign(sandbox, { __prev_graphInner: prev.graphInner }));
  }
});

check('T452: _patchGraphStreaming 端到端——新建卡挂 c-v、无尺寸的新卡不挂、已有卡一个不动', () => {
  if (typeof sandbox._patchGraphStreaming !== 'function') throw new Error('_patchGraphStreaming 未暴露');
  const keep = ['graphInner', 'graphView', 'CSS', '_buildGraphData', '_renderNodeHtml', '_measureNodes', '_redrawEdges',
    '_updateNodeTransforms', '_observeNodeGeometry', '_syncGraphHeavyClasses', '_resolveGraphEdges'];
  const prev = {};
  for (const k of keep) prev[k] = vm.runInContext('typeof ' + k + ' === "undefined" ? undefined : ' + k, sandbox);
  try {
    // 老卡：已在画布上、上一轮全量重建挂过 c-v 并记过占位盒——补丁跑完必须原样不动
    vm.runInContext([
      'var __prevCSS3 = (typeof CSS === "undefined") ? null : CSS;',
      'CSS = { supports: function(){ return true; } };',
      'var __kids = [];',
      'var __mkEl = function(id, w, h){ return { dataset: { nodeId: id }, style: {}, offsetWidth: w, offsetHeight: h, remove: function(){ var i = __kids.indexOf(this); if (i >= 0) __kids.splice(i, 1); } }; };',
      'var __oldEl = __mkEl("n-old", 320, 434);',
      '__oldEl.style.contentVisibility = "auto";',
      '__oldEl.style.containIntrinsicSize = "auto 300px auto 400px";',
      '__oldEl.__cvPlaceholder = { w: 320, h: 434 };',
      '__kids.push(__oldEl);',
      // 假画布：只实现补丁真正用到的那几个成员；insertAdjacentHTML 从 HTML 里取回 id 建替身
      'graphInner = {',
      '  offsetWidth: 1200,',
      '  get lastElementChild(){ return __kids.length ? __kids[__kids.length - 1] : null; },',
      '  insertAdjacentHTML: function(pos, html){ var m = /data-node-id="([^"]+)"/.exec(html); __kids.push(__mkEl(m ? m[1] : "", 700, 900)); },',
      '  querySelectorAll: function(){ return __kids.slice(); },',
      '  querySelector: function(sel){ var m = /data-node-id="([^"]+)"/.exec(sel); if (!m) return null; for (var i = 0; i < __kids.length; i++) { if (__kids[i].dataset.nodeId === m[1]) return __kids[i]; } return null; },',
      '};',
      'var __old = { id: "n-old", kind: "answer", messageIndex: -1, timestamp: 1, analysis: "旧卡", w: 300, h: 400 };',
      'var __fresh = { id: "n-fresh", kind: "answer", messageIndex: -1, timestamp: 2, analysis: "有尺寸的新卡", x: 0, y: 0 };',
      'var __plain = { id: "n-plain", kind: "answer", messageIndex: -1, timestamp: 3, analysis: "没尺寸的新卡", x: 0, y: 0 };',
      'var __state = { sizes: { "n-fresh": { w: 640.4, h: 880.6 }, "n-old": { w: 300, h: 400 } } };',
      '__old._patchSig = _graphNodeHtmlSig(__old, [], __state);',
      'graphView.nodeById = { "n-old": __old };',
      'graphView.nodes = [__old];',
      '_buildGraphData = function(){ return { nodes: [__old, __fresh, __plain], edges: [], nodeById: { "n-old": __old, "n-fresh": __fresh, "n-plain": __plain } }; };',
      // 渲染模板换最小桩：本用例只验「哪张卡被挂 c-v」，真 renderMarkdown 要 marked 库（沙箱没有）
      '_renderNodeHtml = function(node){ return "<div class=\\"graph-node\\" data-node-id=\\"" + node.id + "\\"></div>"; };',
      // _measureNodes 那一刻的现场＝补丁尾部；挂载若排在它之后，这里就看不到 c-v
      'var __atMeasure = null;',
      '_measureNodes = function(){ __atMeasure = __kids.map(function(el){ return { id: el.dataset.nodeId, cv: el.style.contentVisibility || null, cis: el.style.containIntrinsicSize || null, ph: el.__cvPlaceholder || null }; }); };',
      '_redrawEdges = function(){}; _updateNodeTransforms = function(){}; _observeNodeGeometry = function(){}; _syncGraphHeavyClasses = function(){}; _resolveGraphEdges = function(){ return []; };',
      '_patchGraphStreaming([], __state);',
    ].join('\n'), sandbox);
    const snap = JSON.parse(vm.runInContext('JSON.stringify(__atMeasure)', sandbox));
    const byId = {};
    snap.forEach(r => { byId[r.id] = r; });
    if (!byId['n-fresh']) throw new Error('新卡没插进画布：' + JSON.stringify(snap.map(r => r.id)));
    if (byId['n-fresh'].cv !== 'auto' || byId['n-fresh'].cis !== 'auto 640px auto 881px') {
      throw new Error('新建卡没挂上 c-v（盲区还在）：' + JSON.stringify(byId['n-fresh']));
    }
    if (!byId['n-fresh'].ph || byId['n-fresh'].ph.w !== 700 || byId['n-fresh'].ph.h !== 900) {
      throw new Error('新建卡没记占位盒：' + JSON.stringify(byId['n-fresh'].ph));
    }
    if (byId['n-plain'].cv !== null || byId['n-plain'].ph !== null) {
      throw new Error('无 sizes 的新卡不该挂（占位会污染测量）：' + JSON.stringify(byId['n-plain']));
    }
    if (byId['n-old'].cv !== 'auto' || byId['n-old'].cis !== 'auto 300px auto 400px'
      || byId['n-old'].ph.w !== 320 || byId['n-old'].ph.h !== 434) {
      throw new Error('已有卡被重记了（红线：真身会被记成占位高）: ' + JSON.stringify(byId['n-old']));
    }
    return true;
  } finally {
    vm.runInContext([
      'graphInner = __prev_graphInner;',
      '_buildGraphData = __prev__buildGraphData;',
      '_renderNodeHtml = __prev__renderNodeHtml;',
      '_measureNodes = __prev__measureNodes;',
      '_redrawEdges = __prev__redrawEdges;',
      '_updateNodeTransforms = __prev__updateNodeTransforms;',
      '_observeNodeGeometry = __prev__observeNodeGeometry;',
      '_syncGraphHeavyClasses = __prev__syncGraphHeavyClasses;',
      '_resolveGraphEdges = __prev__resolveGraphEdges;',
      'graphView.nodeById = __prev_nodeById;',
      'graphView.nodes = __prev_nodes;',
      'graphView.edges = __prev_edges;',
      'graphView.defaultEdges = __prev_defaultEdges;',
      'if (__prevCSS3) { CSS = __prevCSS3; } else { try { delete CSS; } catch (e) { CSS = undefined; } }',
    ].join('\n'), Object.assign(sandbox, {
      __prev_graphInner: prev.graphInner,
      __prev__buildGraphData: prev._buildGraphData,
      __prev__renderNodeHtml: prev._renderNodeHtml,
      __prev__measureNodes: prev._measureNodes,
      __prev__redrawEdges: prev._redrawEdges,
      __prev__updateNodeTransforms: prev._updateNodeTransforms,
      __prev__observeNodeGeometry: prev._observeNodeGeometry,
      __prev__syncGraphHeavyClasses: prev._syncGraphHeavyClasses,
      __prev__resolveGraphEdges: prev._resolveGraphEdges,
      __prev_nodeById: prev.graphView ? prev.graphView.nodeById : undefined,
      __prev_nodes: prev.graphView ? prev.graphView.nodes : undefined,
      __prev_edges: prev.graphView ? prev.graphView.edges : undefined,
      __prev_defaultEdges: prev.graphView ? prev.graphView.defaultEdges : undefined,
    }));
  }
});

check('T452: 接线契约——补丁只挂本轮新建卡（在 _measureNodes 之前），全量重建仍是唯一 _applyNodeLazyLayout 调用点', () => {
  const render = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  const fnBody = (src, name) => {
    const i = src.indexOf('function ' + name);
    if (i < 0) throw new Error('缺函数 ' + name);
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? src.length : j);
  };
  const patch = fnBody(render, '_patchGraphStreaming');
  const mountAt = patch.indexOf('_mountNodeLazyLayout(');
  const measureAt = patch.indexOf('_measureNodes()');
  if (mountAt < 0) throw new Error('流式补丁没挂 c-v——盲区还在');
  if (measureAt < 0 || mountAt > measureAt) throw new Error('挂载跑到 _measureNodes 之后了：首帧布局一过就量不到占位盒');
  // 红线：补丁只处理新建元素，绝不对已在渲染的卡二次调用全量挂载（真身会被记成占位）
  if (patch.includes('_applyNodeLazyLayout(')) throw new Error('补丁里二次调用 _applyNodeLazyLayout——可见卡会把真身记成占位高');
  if (fnBody(render, '_refreshWorkflowNodeUi').includes('_mountNodeLazyLayout(')) {
    throw new Error('_refreshWorkflowNodeUi 换的是已排过版的卡，不是新建节点，不该挂');
  }
  // 全量重建仍是唯一调用点：graph-render.js 里只剩函数定义那一处，其它文件只有 graph-interact 那一处
  if ((render.match(/_applyNodeLazyLayout\(/g) || []).length !== 1) throw new Error('graph-render.js 里出现了定义之外的 _applyNodeLazyLayout 调用');
  if ((interact.match(/_applyNodeLazyLayout\(/g) || []).length !== 1) throw new Error('graph-interact.js 应恰好一处 _applyNodeLazyLayout 调用');
  const stray = fs.readdirSync('src/static/js')
    .filter(f => f.endsWith('.js') && f !== 'graph-render.js' && f !== 'graph-interact.js')
    .filter(f => fs.readFileSync('src/static/js/' + f, 'utf8').includes('_applyNodeLazyLayout('));
  if (stray.length) throw new Error('冒出了第三处调用点：' + stray.join(', '));
  return true;
});

await drain();
}
