// 画布屏外卡免布局（T376，2026-10-23）：首屏布局成本大半来自全量内联的内容卡
// （2026-10-23 实测 87 卡 LayoutDuration 0.39s），content-visibility:auto 让浏览器
// 跳过视口外卡的布局，占位尺寸来自持久化 sizes（_savePositions 测量后存盘）。
// 回归两面：helper 行为（挂/不挂名单＋占位尺寸）、静态契约（接线位置＋导出克隆归位）。
//
// T394（2026-10-24 用户报「连线在卡外悬空」）并入本域：占位尺寸只在「卡还没排真身」时
// 成立，而边锚点是画线那一刻现读端口矩形的——卡进视口补排真身之后没人重画，线端就停在
// 空中（实测 28/37 条边错位，最大 150.7px）。这里补两面：_observeNodeGeometry 的行为
// （尺寸一变→合并一帧→只刷受影响的边）与三处接线/增量刷新契约。
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

check('T393: _measureNodes 把占位读数挡在存盘外——占位没变保留旧尺寸，真身变了才收', () => {
  if (typeof sandbox._measureNodes !== 'function') throw new Error('helper 未暴露');
  const keep = ['graphInner', 'graphView', '_graphCompositeScale', '_syncGroupMembersByContainment'];
  const prev = {};
  for (const k of keep) prev[k] = vm.runInContext('typeof ' + k + ' === "undefined" ? undefined : ' + k, sandbox);
  try {
    vm.runInContext([
      // 占位盒：contain-intrinsic-size 的内容尺寸 + padding/border（320×934），量到的仍是它
      'var __elPh = { dataset: { nodeId: "n-ph" }, __cvPlaceholder: { w: 320, h: 934 }, getBoundingClientRect: function(){ return { width: 320, height: 934 }; } };',
      // 同一张卡已经排过真身：读数离开占位盒，必须收
      'var __elReal = { dataset: { nodeId: "n-real" }, __cvPlaceholder: { w: 320, h: 934 }, getBoundingClientRect: function(){ return { width: 520, height: 1200 }; } };',
      // 没挂 c-v 的新卡：照旧全收
      'var __elPlain = { dataset: { nodeId: "n-plain" }, getBoundingClientRect: function(){ return { width: 280, height: 140 }; } };',
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
      'graphView.nodes = __prev_graphView_nodes;',
      '_graphCompositeScale = __prev__graphCompositeScale;',
      '_syncGroupMembersByContainment = __prev__syncGroupMembersByContainment;',
    ].join('\n'), Object.assign(sandbox, {
      __prev_graphInner: prev.graphInner,
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

await drain();
}
