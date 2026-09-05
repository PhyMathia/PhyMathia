#!/usr/bin/env node
// 前端冒烟：Node 沙箱真实执行 app.js（宽松 DOM 代理），并对关键函数做行为断言。
// 目标：抓住"语法正确但运行时 ReferenceError/TypeError"这类 node --check 漏网问题。
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync('src/static/js/app.js', 'utf8');

// 宽松对象：任意属性访问返回同款代理；可调用；可赋值。不用 has/trap 避免死循环。
function loose(name) {
  const store = {};
  const fn = function () { return loose(name + '()'); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then' || p === 'catch' || p === 'finally') return undefined;
      if (p === 'length') return 0;
      if (!(p in t)) t[p] = loose(name + '.' + String(p));
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
    apply: () => loose(name + '()'),
    construct: () => loose('new ' + name),
  });
}

const storageData = { phymathia_level: 'university' };
const localStorage = {
  getItem: (k) => (k in storageData ? storageData[k] : null),
  setItem: (k, v) => { storageData[k] = String(v); },
  removeItem: (k) => { delete storageData[k]; },
};

const sandbox = {
  console,
  setTimeout: () => 0, clearTimeout: () => 0,
  setInterval: () => 0, clearInterval: () => 0,
  requestAnimationFrame: () => 0,
  localStorage,
  navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
  location: { href: 'http://localhost:5050/', search: '', protocol: 'http:', pathname: '/', reload: () => {} },
  history: {},
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' }),
  alert: () => {}, confirm: () => true, prompt: () => '',
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  performance: { now: () => Date.now() },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  IntersectionObserver: class { observe() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  URLSearchParams, URL, TextEncoder, TextDecoder,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  Image: class { set src(v) {} addEventListener() {} },
  Audio: class {},
  FormData: class { append() {} },
  Blob: class {},
  File: class {},
  FileReader: class { readAsDataURL() {} readAsText() {} },
  WebSocket: class { close() {} send() {} addEventListener() {} },
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} },
  AbortController: class { constructor(){ this.signal = {}; } abort() {} },
  requestIdleCallback: (f) => 0,
  cancelAnimationFrame: () => {},
  scrollTo: () => {}, scrollBy: () => {}, print: () => {},
  crypto: {
    getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
    randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }),
  },
};
sandbox.window = loose('window');
sandbox.document = loose('document');
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
} catch (e) {
  console.error('❌ app.js 顶层执行失败:', e.message);
  process.exit(1);
}

let failed = 0;
const check = (name, fn) => {
  try {
    if (fn() === false) throw new Error('断言未通过');
    console.log('✓', name);
  } catch (e) {
    failed++;
    console.error('❌', name, '->', e.message);
  }
};

check('buildHarnessSnapshot 可调用且回结构（回归：rawCount 未定义事故）', () => {
  // 注入两个画布节点，其中一个标记软删除
  sandbox.window.getGraphState = () => ({ harnessDeleted: { B: true } });
  sandbox.window.getCurrentSessionId = () => 'sess_test';
  sandbox.window.getGraphViewNodes = () => [
    { id: 'A', kind: 'knowledge', label: '导数', content: '瞬时变化率' },
    { id: 'B', kind: 'module', label: '物理视角', moduleKey: 'physics' },
  ];
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.window.getSelectedGraphNodeIds = () => [];
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  if (!snap || !Array.isArray(snap.nodes)) throw new Error('快照结构错误');
  if (snap.nodes.length !== 1) throw new Error('应过滤掉软删除的 B，剩 1 个节点，实际 ' + snap.nodes.length);
  if (typeof snap.snapshot_meta.deleted_filtered !== 'number') throw new Error('meta.deleted_filtered 缺失');
  if (snap.snapshot_meta.deleted_filtered !== 1) throw new Error('deleted_filtered 应为 1');
  return true;
});

check('_isHarnessPureQuestion 分类边界', () => {
  if (sandbox._isHarnessPureQuestion('评价一下我的理解') !== false) return false; // 改图意图
  // 注：「…怎么样」会被标为纯问答——无害，因 R4 后快照一律发真实画布内容，
  // 分类器只影响状态文案与焦点解析跳过，不再决定快照空实。
  return sandbox._isHarnessPureQuestion('什么是牛顿第二定律') === true;
});
check('纯问答也携带真实快照（回归：拒绝建议后全空事故）', () => {
  // 模拟用户有 35 节点画布：即便分类为纯问答，快照也应包含真实节点而非空数组
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getGraphViewNodes = () => Array.from({ length: 35 }, (_, i) => ({
    id: 'n' + i, kind: 'knowledge', label: '节点' + i, content: '内容' + i,
  }));
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.buildHarnessSnapshot(true, [], null); // excludeEval=true 也不应清空非 eval 节点
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  return snap.nodes.length === 35 && snap.edges.length === 0;
});

check('_detectHarnessPhase 分类', () => {
  const nodes = [{ id: 'D', kind: 'human_note', label: '我的理解' }];
  if (sandbox._detectHarnessPhase('评价一下我对导数的理解', nodes) !== 'evaluate') return false;
  if (sandbox._detectHarnessPhase('应用建议', nodes) !== 'apply') return false;
  return true;
});

check('_stripThinkText 思考块剥离（回归：推理模型刷屏事故）', () => {
  const strip = sandbox._stripThinkText;
  if (typeof strip !== 'function') throw new Error('_stripThinkText 未暴露');
  // 成对块：整段删除，保留正式回答
  if (strip('<think>先想想 {"op": "bad"</think>\n{"summary": "s"}') !== '{"summary": "s"}') return false;
  // 未闭合块（max_tokens 截断）：从开标签截断
  if (strip('{"summary": "ok"} <think>被截断……') !== '{"summary": "ok"}') return false;
  // 纯文本不受影响
  if (strip('正常回答') !== '正常回答') return false;
  // 空值
  if (strip('') !== '') return false;
  return true;
});

// ===== 右键菜单（graph-contextmenu.js，P1）静态/沙箱回归 =====

check('graph-contextmenu: open/close 沙箱冒烟（单例开关不抛错）', () => {
  if (typeof sandbox.openGraphContextMenu !== 'function') throw new Error('openGraphContextMenu 未暴露');
  if (typeof sandbox.closeGraphContextMenu !== 'function') throw new Error('closeGraphContextMenu 未暴露');
  // 宽松 DOM 下走完整弹层构建/定位/关闭路径（构建期只做描述与 DOM 代理操作）
  sandbox.openGraphContextMenu({ clientX: 12, clientY: 12, target: { closest: () => null } });
  sandbox.openGraphContextMenu({ clientX: 20, clientY: 20, target: { closest: () => null } }); // 开新先关旧
  sandbox.closeGraphContextMenu();
  sandbox.closeGraphContextMenu(); // 重复关闭必须幂等（监听清理路径不抛错）
  return true;
});

check('graph-contextmenu: 目标三分支分类（node/link/canvas）', () => {
  const kindOf = (t) => sandbox._graphContextTargetKind(t);
  if (kindOf(null) !== 'canvas') return false;
  if (kindOf({ closest: () => null }) !== 'canvas') return false;
  if (kindOf({ closest: (sel) => (sel.indexOf('.graph-edge-link') === 0 ? {} : null) }) !== 'link') return false;
  const realFind = sandbox._findGraphNode;
  try {
    sandbox._findGraphNode = () => ({ id: 'n1', kind: 'blank' });
    if (kindOf({ closest: (sel) => (sel === '.graph-node' ? { dataset: { nodeId: 'n1' } } : null) }) !== 'node') return false;
    sandbox._findGraphNode = () => null; // 空态「新问题」卡等查不到数据 → 画布菜单
    if (kindOf({ closest: (sel) => (sel === '.graph-node' ? { dataset: { nodeId: 'ghost' } } : null) }) !== 'canvas') return false;
  } finally {
    sandbox._findGraphNode = realFind;
  }
  return true;
});

check('graph-contextmenu: 节点菜单按 kind 裁剪（端口/折叠/删除白名单）', () => {
  const keysFor = (node) => sandbox._graphContextItemsForNode(node).map(i => i.key);
  // draft：无收藏/折叠/端口，仅删除
  const draft = keysFor({ id: 'd1', kind: 'draft' });
  if (draft.includes('bookmark') || draft.includes('minimize')) return false;
  if (draft.includes('add-input-port') || draft.includes('add-output-port')) return false;
  if (!draft.includes('delete')) return false;
  // source：有输出端口、无输入端口
  const source = keysFor({ id: 's1', kind: 'source', items: [{}] });
  if (!source.includes('add-output-port') || source.includes('add-input-port')) return false;
  // hub：有输入端口、无输出端口
  const hub = keysFor({ id: 'h1', kind: 'hub' });
  if (!hub.includes('add-input-port') || hub.includes('add-output-port')) return false;
  // module（白名单键 physics）：输入/输出端口都有；折叠项按 minimized 切换文案
  const folded = sandbox._graphContextItemsForNode({ id: 'm1', kind: 'module', moduleKey: 'physics', messageIndex: -1, minimized: true, content: '内容' });
  const mini = folded.find(i => i.key === 'minimize');
  if (!mini || mini.label !== '展开') return false;
  if (!folded.some(i => i.key === 'add-input-port') || !folded.some(i => i.key === 'add-output-port')) return false;
  return true;
});

check('graph-contextmenu: 收藏为知识点走书签弹窗预填（复用 saveBookmark 持久化路径）', () => {
  const items = sandbox._graphContextItemsForNode({
    id: 'a1', kind: 'module', moduleKey: 'math', messageIndex: -1,
    content: '傅里叶变换 <formula>\\int f(x)e^{i\\omega x}\\,dx</formula>',
  });
  const bm = items.find(i => i.key === 'bookmark');
  if (!bm) throw new Error('module 节点应有收藏项');
  bm.run(); // 沙箱宽松 DOM 下执行预填，不应抛错
  const copy = items.find(i => i.key === 'copy');
  if (!copy) return false;
  copy.run(); // 复制全文走 navigator.clipboard.writeText（沙箱已有桩），不应抛错
  return true;
});

check('graph-contextmenu: 画布菜单项齐备且「粘贴为节点」受剪贴板能力门控', () => {
  const keys = sandbox._graphContextItemsForCanvas().map(i => i.key);
  for (const k of ['add-node', 'paste-node', 'fit', 'arrange', 'export', 'undo', 'redo']) {
    if (!keys.includes(k)) return false;
  }
  const paste0 = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-node');
  if (paste0.disabled !== true) return false; // 沙箱 navigator.clipboard 无 readText → 禁用
  sandbox.navigator.clipboard.readText = async () => 'E = mc^2';
  const paste1 = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-node');
  const ok = paste1.disabled === false;
  delete sandbox.navigator.clipboard.readText;
  return ok;
});

check('graph-contextmenu: 画布事件接线（pointerdown 右键过滤 + contextmenu 三分支放行）', () => {
  const wf = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  // 防冲突（P1 核心修复回归）：pointerdown 处理器入口必须先按 button 过滤，
  // 才轮到 _startCanvasPan/_startNodeDrag/_startGroupDrag 等手势入口
  const pd = wf.indexOf("graphCanvas.addEventListener('pointerdown'");
  if (pd < 0) throw new Error('pointerdown 监听未找到');
  const head = wf.slice(pd, pd + 700);
  const filterAt = head.indexOf('if (e.button !== 0) return;');
  if (filterAt < 0) throw new Error('pointerdown 入口缺 e.button 过滤（右键会误入拖拽）');
  const firstGesture = head.search(/_startCanvasPan\(|_startNodeDrag\(|_startGroupDrag\(/);
  if (firstGesture >= 0 && firstGesture < filterAt) throw new Error('button 过滤晚于手势入口');
  // 三分支放行后 preventDefault + openGraphContextMenu
  const cm = wf.indexOf("graphCanvas.addEventListener('contextmenu'");
  if (cm < 0) throw new Error('contextmenu 监听未找到');
  const body = wf.slice(cm, cm + 900);
  for (const frag of [
    "closest('input, textarea, [contenteditable], iframe')",
    'graphView.selectMode', 'graphView.moved', 'e.preventDefault()', 'openGraphContextMenu(e)',
  ]) {
    if (!body.includes(frag)) throw new Error('contextmenu 三分支接线缺: ' + frag);
  }
  return true;
});

check('graph-contextmenu: 打包注册与产物符号（静态断言）', () => {
  const buildSrc = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  // 注册位置：graph-export.js 之后（graph-workflow.js 在实际构建顺序中位于 graph-export.js 之前）
  if (!/'graph-export\.js',\s*'graph-contextmenu\.js',\s*'knowledge\.js'/.test(buildSrc)) return false;
  if (!code.includes('function openGraphContextMenu')) return false;
  if (!code.includes('graph-context-menu')) return false;
  if (!code.includes('if(e.button!==0)return;')) return false; // 产物含 pointerdown 右键过滤
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  return css.includes('.graph-context-menu');
});

// ===== 知识点摘要（P2：summarySource/anchorSummary 契约）静态/沙箱回归 =====

check('knowledge: dedupeKnowledgeItems 按 summarySource 保优（manual > model > local，长度仅同源 tie-break）', () => {
  const d = sandbox.dedupeKnowledgeItems;
  if (typeof d !== 'function') throw new Error('dedupeKnowledgeItems 未暴露');
  // model 摘要短于 local 整卡摘要也不被拉回去：来源等级优先
  const r1 = d({
    a: { id: 'a', title: '简谐运动', sessionId: 's1', summary: '很长的本地整卡摘要，比模型摘要长得多', summarySource: 'local', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '简谐运动', sessionId: 's1', summary: '回复力与位移成正比的周期性振动', summarySource: 'model', formulas: [], createdAt: 1 },
  });
  if (!r1.b || r1.a) return false;
  if (r1.b.summary !== '回复力与位移成正比的周期性振动') return false;
  // 同源才比长度：local 更长者胜
  const r2 = d({
    a: { id: 'a', title: '导数', sessionId: 's1', summary: '短', summarySource: 'local', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '导数', sessionId: 's1', summary: '更长的同源摘要', summarySource: 'local', formulas: [], createdAt: 1 },
  });
  if (!r2.b || r2.a) return false;
  // 旧数据（无 summarySource）视为 local：manual 仍胜出
  const r3 = d({
    a: { id: 'a', title: '动量', sessionId: 's1', summary: '旧数据无来源字段的很长摘要', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '动量', sessionId: 's1', summary: '手动摘要', summarySource: 'manual', formulas: [], createdAt: 1 },
  });
  return !!(r3.b && !r3.a && r3.b.summary === '手动摘要');
});

check('knowledge: 定位锚点优先 anchorSummary、旧数据回退 summary（契约两侧字段齐备）', () => {
  if (!code.includes('summarySource') || !code.includes('anchorSummary')) {
    throw new Error('打包产物缺 summarySource/anchorSummary 字段');
  }
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  const at = src.indexOf('_summaryFragmentsForMatch(item.anchorSummary');
  if (at < 0) throw new Error('_focusKnowledgeNodeByContent 未优先使用 anchorSummary');
  return src.slice(at, at + 120).includes('item.summary');
});

console.log(failed ? '\n冒烟失败' : '\n前端冒烟全部通过');
process.exit(failed ? 1 : 0);
