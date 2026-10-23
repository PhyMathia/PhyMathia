// T380 高频回流入口治理（2026-10-23）：_applyGraphTransform 每次无条件写
// graphCanvas.scrollTop/scrollLeft、_graphCompositeScale 每次读 offsetWidth＋gBCR，
// 单次极便宜但 3s profile 合计 155ms（高频＋布局脏态强制同步布局）。修法：scroll
// 非零才写；复合缩放帧级缓存（zoom 作键＋rAF 整帧失效，大陆转场 CSS transition
// 逐帧插值靠跨帧重测保 T298 语义）。回归两面：缓存行为（同帧复用/键变即测/rAF 失效）、
// scroll 守卫（非零写、零不写、transform 照落）。
import { check, drain, sandbox, vm, fs } from './_runner.mjs';

export async function run() {
check('T380: _graphCompositeScale 帧缓存——同帧复用一次布局读、zoom 键变立即重测、rAF 到点整帧失效', () => {
  if (typeof sandbox._graphCompositeScale !== 'function') throw new Error('函数未暴露');
  const setup = vm.runInContext([
    'var __prevRAF = requestAnimationFrame; var __prevInner = graphInner; var __prevZoom = graphView.zoom;',
    'var __rafCbs = [];',
    'requestAnimationFrame = function(cb){ __rafCbs.push(cb); return __rafCbs.length; };',
    'var __rectW = 500;',
    'graphInner = { offsetWidth: 1000, getBoundingClientRect: function(){ return { width: __rectW }; } };',
    'graphView.zoom = 1;',
    '_graphCompositeScaleCache.valid = false; _graphCompositeScaleRafPending = false;',
    'var __seq = [];',
    '__seq.push(_graphCompositeScale());',            // 首次：测量 500/1000，填缓存＋排一次 rAF
    'var __scheduled1 = __rafCbs.length;',
    '__rectW = 750;',
    '__seq.push(_graphCompositeScale());',            // 同帧（rAF 未到）：必须仍 0.5，不得重测
    'var __scheduled2 = __rafCbs.length;',
    '__seq.push(_graphCompositeScale({ width: 900 }));', // 同帧带 rect：缓存仍有效，忽略 rect
    'graphView.zoom = 2;',
    '__seq.push(_graphCompositeScale());',            // zoom 键变：立即重测 750/1000（不等 rAF）
    '__rectW = 250;',
    '__rafCbs.splice(0).forEach(function(cb){ cb(); });', // 跨帧：rAF 到点整帧失效
    '__seq.push(_graphCompositeScale());',            // 重测 250/1000
    'JSON.stringify({ seq: __seq, scheduled1: __scheduled1, scheduled2: __scheduled2 });',
  ].join('\n'), sandbox);
  const r = JSON.parse(setup);
  if (r.seq[0] !== 0.5) throw new Error('首次测量应为 0.5：' + JSON.stringify(r.seq));
  if (r.seq[1] !== 0.5 || r.seq[2] !== 0.5) throw new Error('同帧内不得重测（祖先转场同帧恒定，缓存必须复用）：' + JSON.stringify(r.seq));
  if (r.scheduled1 !== 1 || r.scheduled2 !== 1) throw new Error('缓存有效期内不得重复排 rAF：' + JSON.stringify(r));
  if (r.seq[3] !== 0.75) throw new Error('zoom 键变应立即重测为 0.75：' + JSON.stringify(r.seq));
  if (r.seq[4] !== 0.25) throw new Error('rAF 到点后应整帧失效并重测为 0.25：' + JSON.stringify(r.seq));
  // display:none（offsetWidth 0）退回 zoom 且不落缓存：下一次有布局宽立即恢复正常测量
  const hidden = vm.runInContext([
    '_graphCompositeScaleCache.valid = false; _graphCompositeScaleRafPending = false; __rafCbs.length = 0;',
    'graphView.zoom = 1;',
    'graphInner = { offsetWidth: 0, getBoundingClientRect: function(){ return { width: 0 }; } };',
    'var __h = _graphCompositeScale();',
    'var __cacheStillInvalid = !_graphCompositeScaleCache.valid;',
    'graphInner = { offsetWidth: 1000, getBoundingClientRect: function(){ return { width: 500 }; } };',
    'var __recov = _graphCompositeScale();',
    'JSON.stringify({ h: __h, cacheStillInvalid: __cacheStillInvalid, recov: __recov });',
  ].join('\n'), sandbox);
  const h = JSON.parse(hidden);
  if (h.h !== 1 || !h.cacheStillInvalid) throw new Error('offsetWidth=0 应退回 zoom 且不落缓存：' + hidden);
  if (h.recov !== 0.5) throw new Error('布局宽恢复后应立即正常测量：' + hidden);
  vm.runInContext([
    'graphInner = __prevInner; graphView.zoom = __prevZoom; requestAnimationFrame = __prevRAF;',
    '_graphCompositeScaleCache.valid = false; _graphCompositeScaleRafPending = false;',
  ].join('\n'), sandbox);
  return true;
});

check('T380: _applyGraphTransform scroll 守卫——非零才写、已零零写、transform 照常落', () => {
  const prevCanvas = vm.runInContext('typeof graphCanvas !== "undefined" ? graphCanvas : null', sandbox);
  const prevInner = vm.runInContext('graphInner', sandbox);
  const prevState = vm.runInContext('_graphState', sandbox);
  const prevZoom = vm.runInContext('graphView.zoom', sandbox);
  vm.runInContext([
    'var __st = 5, __sl = 0, __writes = { top: 0, left: 0 };',
    'graphCanvas = { classList: { toggle: function(){} } };',
    'Object.defineProperty(graphCanvas, "scrollTop", { get: function(){ return __st; }, set: function(v){ __writes.top++; __st = v; }, configurable: true });',
    'Object.defineProperty(graphCanvas, "scrollLeft", { get: function(){ return __sl; }, set: function(v){ __writes.left++; __sl = v; }, configurable: true });',
    'graphInner = { style: {} };',
    '_graphState = function(){ return { pan: { x: 10, y: 20 }, zoom: 1.5 }; };',
    '_applyGraphTransform();',
    '_applyGraphTransform();',
  ].join('\n'), sandbox);
  const r = JSON.parse(vm.runInContext('JSON.stringify({ writes: __writes, st: __st, sl: __sl, transform: graphInner.style.transform })', sandbox));
  if (r.writes.top !== 1) throw new Error('scrollTop 非零应只写一次归零，实测写 ' + r.writes.top + ' 次（第二次调用已为零不得再写）');
  if (r.writes.left !== 0) throw new Error('scrollLeft 已为零不得写，实测写 ' + r.writes.left + ' 次');
  if (r.st !== 0) throw new Error('scrollTop 未归零');
  if (!/translate\(10px, ?20px\) scale\(1\.5\)/.test(r.transform)) throw new Error('transform 未按状态落：' + r.transform);
  vm.runInContext([
    'graphCanvas = __prevCanvas; graphInner = __prevInnerG; _graphState = __prevStateG; graphView.zoom = __prevZoomG;',
  ].join('\n'), Object.assign(sandbox, { __prevCanvas: prevCanvas, __prevInnerG: prevInner, __prevStateG: prevState, __prevZoomG: prevZoom }));
  return true;
});

check('T380: 源码契约——守卫与帧缓存在位、无条件 scroll 写法未回潮', () => {
  const src = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!src.includes('if (graphCanvas.scrollTop) graphCanvas.scrollTop = 0;')) {
    throw new Error('scrollTop 非零才写守卫缺失');
  }
  if (/graphCanvas\.scrollTop = 0;/.test(src.replace('if (graphCanvas.scrollTop) graphCanvas.scrollTop = 0;', ''))) {
    throw new Error('存在无条件 scrollTop=0 写法');
  }
  if (!/cache\.zoom !== zoom/.test(src)) throw new Error('复合缩放缓存缺 zoom 键校验');
  if (!/requestAnimationFrame\(\(\) => \{ _graphCompositeScaleRafPending = false; cache\.valid = false; \}\)/.test(src)) {
    throw new Error('复合缩放缓存缺 rAF 整帧失效');
  }
  // innerRect 参数仍被接受（调用方已付过一次布局读的路径不退化为强制再读）
  if (!/\(innerRect \|\| graphInner\.getBoundingClientRect\(\)\)/.test(src)) throw new Error('innerRect 直通路径缺失');
  return true;
});

await drain();
}
