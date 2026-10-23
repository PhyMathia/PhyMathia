// 画布屏外卡免布局（T376，2026-10-23）：首屏布局成本大半来自全量内联的内容卡
// （2026-10-23 实测 87 卡 LayoutDuration 0.39s），content-visibility:auto 让浏览器
// 跳过视口外卡的布局，占位尺寸来自持久化 sizes（_savePositions 测量后存盘）。
// 回归两面：helper 行为（挂/不挂名单＋占位尺寸）、静态契约（接线位置＋导出克隆归位）。
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
      'var __els = ["n-ok","n-eval","n-mini","n-nosize","n-zero"].map(function(id){ return { dataset: { nodeId: id }, style: {} }; });',
      'graphInner = { querySelectorAll: function(){ return __els; } };',
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
    const styles = vm.runInContext('JSON.stringify(__els.map(function(e){ return { cv: e.style.contentVisibility || null, cis: e.style.containIntrinsicSize || null }; }))', sandbox);
    const arr = JSON.parse(styles);
    // 有尺寸：挂 auto，占位尺寸取整（Math.round）
    if (arr[0].cv !== 'auto' || arr[0].cis !== 'auto 640px auto 881px') {
      throw new Error('有尺寸卡没挂上或占位尺寸不对：' + JSON.stringify(arr[0]));
    }
    // ai_eval（锯齿描边外扩 6px，paint 包含会裁）、minimized（本就无内容子树）、
    // 无尺寸（占位会污染 _measureNodes）、零尺寸：一律不挂
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].cv !== null) throw new Error('不该挂的卡挂上了：index ' + i + ' -> ' + JSON.stringify(arr[i]));
    }
    return true;
  } finally {
    vm.runInContext('graphInner = __prevInner;', Object.assign(sandbox, { __prevInner: prevInner }));
    vm.runInContext('graphView.nodes = __prevNodes;', Object.assign(sandbox, { __prevNodes: prevNodes }));
    vm.runInContext('if (__prevCSS) { CSS = __prevCSS; } else { try { delete CSS; } catch (e) {} }', sandbox);
  }
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

await drain();
}
