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
let __smokeUuid = 0;
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
    randomUUID: () => 'uu-' + (++__smokeUuid).toString(16).padStart(10, '0'),
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
const pendingChecks = [];
const check = (name, fn) => {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // 异步断言（如批量任务中止行为）：等待完成后才统计与退出。
      // 兑现值 false 同步口径一致视为失败——否则断言函数里 return false 的
      // 行为检查会被静默当作通过（审查修复：此前 6 条写回/不触碰断言因此失效）
      pendingChecks.push(result.then(
        (r) => {
          if (r === false) { failed++; console.error('❌', name, '-> 断言未通过'); }
          else console.log('✓', name);
        },
        (e) => { failed++; console.error('❌', name, '->', (e && e.message) || e); },
      ));
      return;
    }
    if (result === false) throw new Error('断言未通过');
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
  // 节点目标分支（M2：多选判定 + 标题 + 目标高亮路径，沙箱 graphInner 为 null 须容忍）
  const realFind = sandbox._findGraphNode;
  try {
    sandbox._findGraphNode = () => ({ id: 'n1', kind: 'blank', content: 'x' });
    sandbox.openGraphContextMenu({
      clientX: 30, clientY: 30,
      target: { closest: (sel) => (sel === '.graph-node' ? { dataset: { nodeId: 'n1' } } : null) },
    });
  } finally {
    sandbox._findGraphNode = realFind;
  }
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

check('graph-contextmenu: 节点菜单按 kind 裁剪（端口/折叠/删除白名单 + M2 居中/复制节点）', () => {
  const keysFor = (node) => sandbox._graphContextItemsForNode(node).map(i => i.key);
  // draft：无收藏/折叠/端口/复制节点，有居中与删除
  const draft = keysFor({ id: 'd1', kind: 'draft' });
  if (draft.includes('bookmark') || draft.includes('minimize')) return false;
  if (draft.includes('add-input-port') || draft.includes('add-output-port')) return false;
  if (draft.includes('duplicate')) return false;
  if (!draft.includes('delete') || !draft.includes('focus')) return false;
  // source：有输出端口、无输入端口
  const source = keysFor({ id: 's1', kind: 'source', items: [{}] });
  if (!source.includes('add-output-port') || source.includes('add-input-port')) return false;
  if (!source.includes('focus')) return false;
  // hub：有输入端口、无输出端口
  const hub = keysFor({ id: 'h1', kind: 'hub' });
  if (!hub.includes('add-input-port') || hub.includes('add-output-port')) return false;
  // module（白名单键 physics）：输入/输出端口都有；折叠项按 minimized 切换文案（M2 标签统一）
  const folded = sandbox._graphContextItemsForNode({ id: 'm1', kind: 'module', moduleKey: 'physics', messageIndex: -1, minimized: true, content: '内容' });
  const mini = folded.find(i => i.key === 'minimize');
  if (!mini || mini.label !== '展开节点') return false;
  if (!folded.some(i => i.key === 'add-input-port') || !folded.some(i => i.key === 'add-output-port')) return false;
  // 有内容的 module：居中/复制节点齐备（M2 新增两项）
  if (!folded.some(i => i.key === 'focus') || !folded.some(i => i.key === 'duplicate')) return false;
  const expanded = sandbox._graphContextItemsForNode({ id: 'm2', kind: 'module', moduleKey: 'math', messageIndex: -1, content: '内容' });
  const mini2 = expanded.find(i => i.key === 'minimize');
  if (!mini2 || mini2.label !== '折叠节点') return false;
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

check('graph-contextmenu: 画布菜单项齐备且「粘贴为节点」受剪贴板能力门控（M2 补三项）', () => {
  const keys = sandbox._graphContextItemsForCanvas().map(i => i.key);
  // 既有七 key 不回退 + M2 新增：新建分组 / 缩放复位 / 全选节点
  for (const k of ['add-node', 'paste-node', 'fit', 'zoom-reset', 'arrange', 'create-group', 'select-all', 'export', 'undo', 'redo']) {
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

check('graph-contextmenu: 撤销/重做禁用态三态（栈空 / 栈顶属当前会话 / 栈顶跨会话）', () => {
  // graphUndoStack/graphRedoStack 是打包产物顶层 let（非全局对象属性），
  // 只能经 vm.runInContext 改同一上下文的词法绑定；当前会话经 window.getCurrentSessionId 桩
  sandbox.window.getCurrentSessionId = () => 'sess_ctx';
  const itemOf = (key) => sandbox._graphContextItemsForCanvas().find(i => i.key === key);
  // 1) 栈空：禁用 + title 提示（M2 交付范围 1）
  vm.runInContext('graphUndoStack = []; graphRedoStack = [];', sandbox);
  let undo = itemOf('undo');
  let redo = itemOf('redo');
  if (undo.disabled !== true || undo.title !== '没有可撤销的操作') return false;
  if (redo.disabled !== true || redo.title !== '没有可重做的操作') return false;
  // 2) 栈顶属当前会话：可用
  vm.runInContext("graphUndoStack = [{ sessionId: 'sess_ctx', state: {} }]; graphRedoStack = [{ sessionId: 'sess_ctx', state: {} }];", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled === true || redo.disabled === true) return false;
  // 3) 栈非空但栈顶属其他会话：同样禁用（会话一致性守卫，对齐 _undoGraphAction 的 no-op 条件）
  vm.runInContext("graphUndoStack = [{ sessionId: 'sess_other', state: {} }]; graphRedoStack = [{ sessionId: 'sess_other', state: {} }];", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled !== true || redo.disabled !== true) return false;
  // 4) 刚启动/刚切换会话：内存栈为空（或属旧会话）但 localStorage 已有本会话历史——
  //    判读前须先按当前会话同步撤销栈（_undoGraphAction 首行 _ensureGraphHistory 同步），
  //    否则 Ctrl+Z 实际可撤销而菜单误禁用（审查修复回归）
  storageData['phymathia_graph_history_sess_ctx'] = JSON.stringify([
    { sessionId: 'sess_ctx', state: { customNodes: [] }, meta: null },
  ]);
  vm.runInContext("graphHistorySession = 'sess_stale'; graphUndoStack = []; graphRedoStack = [];", sandbox);
  undo = itemOf('undo');
  if (undo.disabled === true) return false; // 须装载持久化历史后判可用
  delete storageData['phymathia_graph_history_sess_ctx'];
  vm.runInContext('graphUndoStack = []; graphRedoStack = [];', sandbox);
  return true;
});

check('graph-contextmenu: 多选感知（已选 N 语境：删除选择集 / 折叠集语义 / 单目标项隐藏）', () => {
  const realFind = sandbox._findGraphNode;
  const realToggle = sandbox._toggleGraphNodeMinimize;
  try {
    const nodes = [
      { id: 'n_a', kind: 'module', moduleKey: 'physics', messageIndex: -1, content: '甲内容' },
      { id: 'n_b', kind: 'blank', messageIndex: -1, content: '乙内容' },
    ];
    sandbox._findGraphNode = (id) => nodes.find(n => n.id === id) || null;
    // 多选语境：目标 ∈ 选择集且 size > 1
    vm.runInContext('graphView.selectedNodeIds = new Set(["n_a", "n_b"])', sandbox);
    if (typeof sandbox._graphCtxMultiSelection !== 'function') throw new Error('_graphCtxMultiSelection 未暴露');
    if (sandbox._graphCtxMultiSelection(nodes[0]).length !== 2) return false;
    const items = sandbox._graphContextItemsForNode(nodes[0]);
    const keys = items.map(i => i.key);
    if (!keys.includes('minimize') || !keys.includes('delete')) return false;
    // 单目标项在多选语境隐藏（收藏/复制全文/居中/复制节点/端口）
    for (const k of ['bookmark', 'copy', 'focus', 'duplicate', 'add-input-port', 'add-output-port']) {
      if (keys.includes(k)) return false;
    }
    const del = items.find(i => i.key === 'delete');
    if (del.label !== '删除 2 个节点' || del.danger !== true) return false;
    // 折叠/展开作用于整个选择集：混合状态统一方向（任一未折叠 → 全部折叠，已折叠的跳过）
    let toggled = [];
    sandbox._toggleGraphNodeMinimize = (n) => { toggled.push(n.id); };
    const mini = items.find(i => i.key === 'minimize');
    if (mini.label !== '折叠节点') return false;
    mini.run();
    if (toggled.length !== 2 || !toggled.includes('n_a') || !toggled.includes('n_b')) return false;
    nodes[1].minimized = true; // 混合状态：只切换未折叠的 n_a
    toggled = [];
    mini.run();
    if (toggled.length !== 1 || toggled[0] !== 'n_a') return false;
    // 全部已折叠：label 翻转为「展开节点」，动作只作用于已折叠节点
    nodes[0].minimized = true;
    const items2 = sandbox._graphContextItemsForNode(nodes[0]);
    const mini2 = items2.find(i => i.key === 'minimize');
    if (mini2.label !== '展开节点') return false;
    toggled = [];
    mini2.run();
    if (toggled.length !== 2) return false;
    // 删除项作用于菜单打开时捕获的选择集（审查修复回归）：菜单存活期间 renderGraphCanvas
    // 重渲会清空 selectedNodeIds，届时读活选择集 = 点「删除 N 个节点」却一个都删不掉
    const realDelete = sandbox._deleteSelectedGraphNodes;
    let deletedIds = null;
    try {
      sandbox._deleteSelectedGraphNodes = (ids) => { deletedIds = ids; };
      vm.runInContext('graphView.selectedNodeIds = new Set(["n_a", "n_b"])', sandbox);
      const itemsDel = sandbox._graphContextItemsForNode(nodes[0]);
      vm.runInContext('graphView.selectedNodeIds = new Set()', sandbox); // 模拟重渲清空选择
      itemsDel.find(i => i.key === 'delete').run();
      if (!Array.isArray(deletedIds) || deletedIds.join(',') !== 'n_a,n_b') return false;
    } finally {
      sandbox._deleteSelectedGraphNodes = realDelete;
    }
    // 选择集含查不到数据的节点（空态卡）：退回单目标语境
    vm.runInContext('graphView.selectedNodeIds = new Set(["n_a", "ghost"])', sandbox);
    if (sandbox._graphCtxMultiSelection(nodes[0]) !== null) return false;
    // 未选中 / 单选语境：行为与现状完全一致（收藏/复制/居中/复制节点/端口齐备）
    vm.runInContext('graphView.selectedNodeIds = new Set(["n_a"])', sandbox);
    const single = sandbox._graphContextItemsForNode(nodes[0]).map(i => i.key);
    for (const k of ['bookmark', 'copy', 'focus', 'duplicate', 'add-input-port', 'add-output-port', 'delete']) {
      if (!single.includes(k)) return false;
    }
    vm.runInContext('graphView.selectedNodeIds = new Set()', sandbox);
    const none = sandbox._graphContextItemsForNode(nodes[0]).map(i => i.key);
    if (!none.includes('bookmark') || !none.includes('focus')) return false;
    return true;
  } finally {
    sandbox._findGraphNode = realFind;
    sandbox._toggleGraphNodeMinimize = realToggle;
    vm.runInContext('graphView.selectedNodeIds = new Set()', sandbox);
  }
});

check('graph-contextmenu: 联系线菜单三动作齐备（M1：编辑联系/曲线精调/删除联系）', () => {
  if (typeof sandbox._graphContextItemsForLink !== 'function') throw new Error('_graphContextItemsForLink 未暴露');
  if (typeof sandbox._graphCtxLinkFromTarget !== 'function') throw new Error('_graphCtxLinkFromTarget 未暴露');
  if (typeof sandbox._graphCtxLinkTitle !== 'function') throw new Error('_graphCtxLinkTitle 未暴露');
  const edge = { from: 'n1', fromPort: 'out-0', to: 'n2', toPort: 'in-0', link: true, relation: '都描述局部变化率' };
  const items = sandbox._graphContextItemsForLink(edge);
  const keys = items.map(i => i.key);
  for (const k of ['edit-link', 'curve-edit', 'delete-link']) {
    if (!keys.includes(k)) throw new Error('联系线菜单缺 key: ' + k);
  }
  // 三项 label 全部锁定（审查补强：edit-link 带省略号，与「新建节点…」等弹窗类菜单项同风格）
  const edit = items.find(i => i.key === 'edit-link');
  if (edit.label !== '编辑联系…') return false;
  // 删除项 danger；曲线精调默认分支文案（沙箱 graphView.edgeCurveEditKey 为空）
  const del = items.find(i => i.key === 'delete-link');
  if (del.danger !== true || del.label !== '删除联系') return false;
  const curve = items.find(i => i.key === 'curve-edit');
  if (curve.label !== '曲线精调') return false;
  // 编辑联系/曲线精调的动作在空图沙箱下安全 no-op（openLinkEdgeModal/enterLinkCurveEdit
  // 查不到边数据即返回）；删除联系会走真实 _pushGraphUndo/renderGraphCanvas 链路，不做沙箱执行
  items.forEach(i => { if (i.key === 'edit-link' || i.key === 'curve-edit') i.run(); });
  // 空/坏输入守卫
  if (sandbox._graphContextItemsForLink(null).length !== 0) return false;
  // 标题：label 截断 24 字 + 无 label 兜底「联系线」
  if (sandbox._graphCtxLinkTitle(edge) !== '都描述局部变化率') return false;
  if (sandbox._graphCtxLinkTitle({ link: true }) !== '联系线') return false;
  if (sandbox._graphCtxLinkTitle({ link: true, label: '很'.repeat(30) }).length !== 24) return false;
  // 边定位：data-edge-key 解析 + 查不到边数据返回 null（静默回落口径）
  if (sandbox._graphCtxLinkFromTarget({ closest: () => null }) !== null) return false;
  const ghost = sandbox._graphCtxLinkFromTarget({ closest: () => ({ dataset: { edgeKey: 'ghost:out-0->nobody:in-0' } }) });
  if (ghost !== null) return false;
  return true;
});

check('graph-contextmenu: 联系线菜单接线静态断言（data-edge-key 定位 + 编辑态互斥 + 双击检测按按键细化）', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  // openGraphContextMenu 接入 link 分支：查不到边数据静默回落 + 三动作 + 删除 danger
  if (!src.includes("if (kind === 'link' && !_graphCtxLinkFromTarget(target)) return;")) {
    throw new Error('openGraphContextMenu 缺联系线边数据回落守卫');
  }
  if (!src.includes('danger: true,\n    run: () => { if (typeof deleteLinkEdge')) {
    throw new Error('删除联系项缺 danger 标记或动作接线');
  }
  // 曲线精调编辑态互斥：已在编辑态的同一条线改呈「退出精调」（enterLinkCurveEdit 对此是 no-op）
  if (!src.includes('graphView.edgeCurveEditKey === edgeKey') || !src.includes("label: '退出精调'")) {
    throw new Error('曲线精调缺编辑态互斥分支');
  }
  if (!code.includes('_graphContextItemsForLink')) throw new Error('打包产物缺 _graphContextItemsForLink');
  // M1 双击检测按按键细化：graph-custom.js 的 document 捕获 pointerdown 入口必须先按
  // button 过滤，才轮到手柄拖拽与 450ms 双击检测（右键按压不计入，快速右双击不再误开弹窗）
  const gc = fs.readFileSync('src/static/js/graph-custom.js', 'utf8');
  const pd = gc.indexOf("document.addEventListener('pointerdown'");
  if (pd < 0) throw new Error('graph-custom.js document 捕获 pointerdown 未找到');
  const head = gc.slice(pd, pd + 800);
  const filterAt = head.indexOf('if (event.button !== 0) return;');
  if (filterAt < 0) throw new Error('双击检测入口缺 event.button 过滤');
  const detectAt = head.indexOf('_lastLinkEdgePress');
  const handleAt = head.indexOf(".graph-edge-handle, .graph-curve-knob-hit");
  if (detectAt >= 0 && detectAt < filterAt) throw new Error('button 过滤晚于双击检测');
  if (handleAt >= 0 && handleAt < filterAt) throw new Error('button 过滤晚于手柄拖拽');
  return true;
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

check('graph-contextmenu: M2 语义补强接线（新增项 / 高亮 / 导出锚点 / 多选标题 / 复制落点）静态+行为断言', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  // 节点菜单新增两项：居中此节点（focusGraphNodeById）/ 复制节点（复用 _graphCtxCreateBlankNodeWithText）
  if (!src.includes("focusGraphNodeById(node.id)")) throw new Error('居中此节点缺 focusGraphNodeById 接线');
  if (!src.includes('function _graphCtxDuplicateNode') || !src.includes('_graphCtxCreateBlankNodeWithText(')) {
    throw new Error('复制节点未复用 _graphCtxCreateBlankNodeWithText 链路');
  }
  // 复制节点落点：原节点旁 +24/+24，内容为 _nodeStoredContent 同源文本（行为断言）
  const realCreate = sandbox._graphCtxCreateBlankNodeWithText;
  let captured = null;
  try {
    sandbox._graphCtxCreateBlankNodeWithText = (pt, text) => { captured = { pt, text }; };
    sandbox._graphCtxDuplicateNode({ id: 'n1', x: 100, y: 50 }, '节点内容');
    if (!captured || captured.pt.x !== 124 || captured.pt.y !== 74) {
      throw new Error('复制节点落点不是原节点旁 +24/+24: ' + JSON.stringify(captured && captured.pt));
    }
    if (captured.text !== '节点内容') throw new Error('复制节点内容未透传');
  } finally {
    sandbox._graphCtxCreateBlankNodeWithText = realCreate;
  }
  // 多选标题 + 目标高亮 + 关联生命周期
  if (!src.includes("'已选 ' + multi.length + ' 个节点'")) throw new Error('多选标题缺失');
  if (!src.includes("el.classList.add('graph-ctx-target')") || !src.includes("el.classList.remove('graph-ctx-target')")) {
    throw new Error('.graph-ctx-target 高亮加/除不配平');
  }
  if (!src.includes('_graphCtxUnmarkTarget();')) throw new Error('关闭菜单未移除目标高亮');
  // 撤销/重做禁用态走 _graphCtxHistoryUsable（栈顶判空 + 跨会话守卫）
  if (!src.includes('function _graphCtxHistoryUsable')) throw new Error('_graphCtxHistoryUsable 缺失');
  if (src.indexOf("key: 'fit'") > src.indexOf("key: 'zoom-reset'") || src.indexOf("key: 'zoom-reset'") > src.indexOf("key: 'arrange'")) {
    throw new Error('缩放复位未放在「适配画布」旁');
  }
  if (src.indexOf("key: 'arrange'") > src.indexOf("key: 'create-group'") || src.indexOf("key: 'create-group'") > src.indexOf("key: 'select-all'")) {
    throw new Error('新建分组/全选节点插入位置不对（应在自动整理之后）');
  }
  // 导出锚点：右键菜单传当时光标坐标；无坐标时保持无参现状
  if (!src.includes('window.toggleGraphExportMenu(client ? { x: client.x, y: client.y } : undefined);')) {
    throw new Error('导出项未传锚点坐标');
  }
  // 导出菜单锚点实现：可选参数 + 视口钳制 + 画布局部坐标换算 + 清 right/bottom
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!ge.includes('function toggleGraphExportMenu(anchor)')) throw new Error('toggleGraphExportMenu 缺锚点参数');
  if (!ge.includes('if (anchor && isFinite(anchor.x) && isFinite(anchor.y))')) throw new Error('锚点分支缺失');
  if (!ge.includes('graphCanvas.getBoundingClientRect()')) throw new Error('锚点未换算画布局部坐标');
  if (!ge.includes("menu.style.right = 'auto';") || !ge.includes("menu.style.bottom = 'auto';")) {
    throw new Error('锚点模式未清除 CSS 的 right/bottom 定位');
  }
  // 高亮样式落位 + 打包产物符号
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.graph-node.graph-ctx-target')) throw new Error('styles-panels.css 缺 .graph-ctx-target');
  for (const sym of ['_graphCtxMultiSelection', '_graphContextItemsForMultiNodes', '_graphCtxHistoryUsable', '_graphCtxMarkTarget', '_graphCtxUnmarkTarget']) {
    if (!code.includes(sym)) throw new Error('打包产物缺符号: ' + sym);
  }
  if (!code.includes('graph-ctx-target')) throw new Error('打包产物缺 graph-ctx-target');
  return true;
});

check('graph-export: 一页概览图（完整内容模式已按用户要求移除）+ 画框纯函数', () => {
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  // 「完整内容」整条链路必须干净移除（长内容交给 .pmu 快照，PNG 回到"按屏幕所见"）
  for (const gone of ['_fullContent', 'full-content', '_expandCloneFullContent', '_measureExpandedClone',
                      '_previewExpandedBounds', 'graphExportFullContent']) {
    if (ge.includes(gone)) throw new Error('完整内容模式残留：' + gone);
  }
  // 菜单仍要有 Utopia 快照入口（PNG 的替代出口）
  if (!ge.includes('graphExportUtopia')) throw new Error('导出菜单缺 Utopia 快照入口');
  // 纯函数：包围盒并集
  const union = sandbox.window.graphExportDebug && sandbox.window.graphExportDebug.unionRects;
  if (typeof union !== 'function') throw new Error('unionRects 未暴露');
  const r = union([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 30, w: 100, h: 500 }]);
  if (r.w !== 300 || r.h !== 530) throw new Error('包围盒并集错误：' + JSON.stringify(r));
  if (union([{ x: NaN, y: 0, w: 10, h: 10 }]) !== null) throw new Error('非法矩形应被忽略');
  return true;
});

check('节点皮肤与弹窗：blank/我的理解 玻璃分层 + 双击节点面板走 aurora-glass', () => {
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  // 玻璃节点底座深浅两套
  const baseCount = (css.match(/--node-glass-base:/g) || []).length;
  if (baseCount < 2) throw new Error('--node-glass-base 需深浅各一套，实际 ' + baseCount);
  for (const [name, sel] of [['blank（AI 生成）', '.graph-node-blank {'], ['human_note（我的理解）', '.graph-node-human-note {']]) {
    const i = css.indexOf(sel);
    if (i < 0) throw new Error('缺 ' + name + ' 规则');
    const block = css.slice(i, css.indexOf('}', i));
    if (!block.includes('--node-glass-base')) throw new Error(name + ' 未用玻璃底座（仍是纯色）');
    if (!/gradient\(/.test(block)) throw new Error(name + ' 缺渐变分层');
  }
  // 我的理解：不能再靠 opacity 压暗（旧版发灰的根因）
  const hn = css.slice(css.indexOf('.graph-node-human-note {'), css.indexOf('}', css.indexOf('.graph-node-human-note {')));
  if (/opacity:\s*0\.9/.test(hn)) throw new Error('我的理解仍用 opacity 压暗');
  // 双击节点/连线面板：四个创建点都挂 aurora-glass，且弹窗规则不得再写 background 简写（会盖掉极光）
  const gc = fs.readFileSync('src/static/js/graph-custom.js', 'utf8');
  if ((gc.match(/graph-network-modal aurora-glass/g) || []).length < 4) {
    throw new Error('节点弹窗未全部挂 aurora-glass');
  }
  const modalRule = css.slice(css.indexOf('.graph-network-modal {'), css.indexOf('}', css.indexOf('.graph-network-modal {')));
  if (/background:\s*var\(--bg-panel\)/.test(modalRule)) throw new Error('节点弹窗规则仍在写 background 简写（会盖掉极光层）');
  if (!/backdrop-filter/.test(modalRule)) throw new Error('节点弹窗缺磨砂');
  return true;
});

check('utopia: .pmu 快照格式（解析校验/摘要/文件名 + 导出接线 + 查看器只读边界）', () => {
  const u = fs.readFileSync('src/static/js/utopia.js', 'utf8');
  if (!u.includes("const UTOPIA_FORMAT = 'phymath-utopia/graph';")) throw new Error('格式 id 不符合约定');
  if (!u.includes("const UTOPIA_EXT = '.pmu';")) throw new Error('扩展名应为 .pmu');
  // 解析：正常 + 四类拒绝（非法 JSON / 非本格式 / 版本过高 / 缺 nodes）
  const parse = sandbox.parseUtopiaSnapshot;
  if (typeof parse !== 'function') throw new Error('parseUtopiaSnapshot 未暴露');
  if (!parse(JSON.stringify({ format: 'phymath-utopia/graph', version: 1, nodes: [] })).ok) throw new Error('合法快照被判失败');
  if (parse('{not json').ok !== false) throw new Error('非法 JSON 应被拒');
  if (parse(JSON.stringify({ format: 'other/graph', version: 1, nodes: [] })).ok !== false) throw new Error('非本格式应被拒');
  if (parse(JSON.stringify({ format: 'phymath-utopia/graph', version: 99, nodes: [] })).ok !== false) throw new Error('版本过高应被拒');
  if (parse(JSON.stringify({ format: 'phymath-utopia/graph', version: 1 })).ok !== false) throw new Error('缺 nodes 应被拒');
  // 摘要素函数
  const sum = sandbox.utopiaSnapshotSummary({
    title: 'T', nodes: [{ content: 'abcd' }, { content: 'ef' }], edges: [1], groups: [1, 2], messages: [1],
  });
  if (sum.nodes !== 2 || sum.edges !== 1 || sum.groups !== 2 || sum.messages !== 1 || sum.chars !== 6) {
    throw new Error('摘要统计错误：' + JSON.stringify(sum));
  }
  // 文件名：带非法字符的标题必须被洗净且以 .pmu 结尾
  const fn = sandbox.utopiaSnapshotFilename('会话 名/带*字符?');
  if (!fn.endsWith('.pmu')) throw new Error('文件名缺扩展名');
  if (/[\\/:*?"<>|]/.test(fn)) throw new Error('文件名残留非法字符：' + fn);
  // 主应用接线：产物含 utopia.js、导出菜单有入口
  if (!code.includes('buildUtopiaSnapshot') || !code.includes('exportUtopiaSnapshot')) throw new Error('主包未注册快照模块');
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!ge.includes('graphExportUtopia')) throw new Error('导出菜单缺 Utopia 快照入口');
  if (!ge.includes('window.exportUtopiaSnapshot')) throw new Error('入口未调快照导出');
  // 查看器只读边界：打包子集含渲染子系统与桩，且绝不含会话/AI/检测/Φ 包
  const bv = fs.readFileSync('scripts/build_viewer.mjs', 'utf8');
  for (const need of ['viewer-shims.js', 'graph-render.js', 'graph-workflow.js', 'utopia.js', 'viewer-main.js']) {
    if (!bv.includes(`'${need}'`)) throw new Error('查看器打包缺 ' + need);
  }
  for (const banned of ['session.js', 'chat.js', 'chat-features.js', 'quiz.js', 'harness.js', 'models.js', 'ui.js', 'knowledge.js']) {
    if (bv.includes(`'${banned}'`)) throw new Error('只读查看器不该打包 ' + banned);
  }
  const shims = fs.readFileSync('src/static/js/viewer-shims.js', 'utf8');
  if (!/window\.saveGraphState = function \(\) \{\};/.test(shims)) throw new Error('查看器 saveGraphState 必须是空操作');
  if (!shims.includes("Object.defineProperty(window, 'localStorage'")) throw new Error('查看器缺 localStorage 只读门面');
  // 只读化：右下角工具栏整个隐藏 + 右键菜单白名单剪枝（不提供新建/删除/端口增删/收藏知识点）
  const vmSrc = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  if (!vmSrc.includes('.graph-canvas-toolbar')) throw new Error('查看器未隐藏画布工具栏');
  if (!vmSrc.includes('READONLY_MENU_LABELS')) throw new Error('查看器缺右键菜单白名单');
  for (const banned of ['新建节点', '删除节点', '添加输出端口', '收藏为知识点']) {
    if (new RegExp("READONLY_MENU_LABELS[\\s\\S]{0,400}" + banned).test(vmSrc)) {
      throw new Error('只读白名单里混入了写操作：' + banned);
    }
  }
  // 界面语言：顶栏/拖放卡/提示条都用极光玻璃
  const vhtml = fs.readFileSync('src/static/viewer.html', 'utf8');
  for (const need of ['utopia-bar aurora-glass', 'utopia-drop aurora-glass', 'utopia-toast aurora-glass']) {
    if (!vhtml.includes(need)) throw new Error('查看器界面缺玻璃载体：' + need);
  }
  if (!['viewer.html'].every(f => fs.existsSync('src/static/' + f))) throw new Error('缺 src/static/viewer.html');
  return true;
});

check('graph-contextmenu: 打包注册与产物符号（静态断言）', () => {
  const buildSrc = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  // 注册的相对顺序：graph-export.js → utopia.js → graph-contextmenu.js → knowledge.js
  // （utopia.js 与 graph-export.js 同属导出族；右键菜单须在 graph-export 之后注册）
  let last = -1;
  for (const f of ['graph-export.js', 'utopia.js', 'graph-contextmenu.js', 'knowledge.js']) {
    const i = buildSrc.indexOf("'" + f + "'");
    if (i < 0 || i < last) return false;
    last = i;
  }
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

// ===== 存量摘要优化入口（P3：方案 B 批量重述 + 可停止注册表）静态/沙箱回归 =====

check('knowledge: P3 isLegacyCardSummaryItem 判定边界（manual 永不触碰、锚点比对、file/harness 不碰）', () => {
  const is = sandbox.isLegacyCardSummaryItem;
  if (typeof is !== 'function') throw new Error('isLegacyCardSummaryItem 未暴露');
  // 目标：旧数据（source=ai_extract，无 summarySource/anchorSummary）——旧提取链路必写整卡摘要
  if (is({ id: 'a', title: '导数', summary: '整卡摘要原文', source: 'ai_extract' }) !== true) return false;
  // 目标：P2 local 条目且 summary 等于 anchorSummary
  if (is({ id: 'b', title: '导数', summary: '整卡摘要', summarySource: 'local', anchorSummary: '整卡摘要', source: 'ai_extract' }) !== true) return false;
  // 非目标：summary 已与锚点不同（已优化/模板化）
  if (is({ id: 'c', title: '导数', summary: '具体摘要', summarySource: 'local', anchorSummary: '整卡摘要', source: 'ai_extract' }) !== false) return false;
  // 非目标：summarySource=model / manual
  if (is({ id: 'd', title: '导数', summary: 'x', summarySource: 'model', source: 'ai_extract' }) !== false) return false;
  if (is({ id: 'e', title: '导数', summary: 'x', summarySource: 'manual' }) !== false) return false;
  // 非目标：旧数据手动收藏（无 summarySource，source=manual）也不得触碰
  if (is({ id: 'f', title: '导数', summary: '手写摘要', source: 'manual' }) !== false) return false;
  // 非目标：file/harness 是文档/节点内容摘要，无锚点回退不适用
  if (is({ id: 'g', title: '导数', summary: '文档段落摘要', source: 'file' }) !== false) return false;
  if (is({ id: 'h', title: '导数', summary: '节点内容', source: 'harness' }) !== false) return false;
  // 非目标：空摘要 / 空值
  if (is({ id: 'i', title: '导数', summary: '   ', source: 'ai_extract' }) !== false) return false;
  if (is(null) !== false) return false;
  return true;
});

check('knowledge: P3 重述提示词按 (title, formulas, meaning) 组装 + 公式含义同会话优先 + 回复清洗', () => {
  const meaningsOf = sandbox._knowledgeFormulaMeanings;
  const build = sandbox._buildSummaryRestatePrompt;
  const clean = sandbox._cleanRestatedSummaryText;
  if (typeof meaningsOf !== 'function' || typeof build !== 'function' || typeof clean !== 'function') {
    throw new Error('P3 提示词/清洗函数未暴露');
  }
  // 公式含义查找：同会话优先，跨会话同名公式兜底（_formulaKey 忽略空格差异）
  storageData['phymathia_formulas'] = JSON.stringify({
    f1: { id: 'f1', latex: '$F = -kx$', meaning: '回复力与位移成正比', sessionId: 'sessA', meaningSource: 'model' },
    f2: { id: 'f2', latex: '$G=mg$', meaning: '重力与质量成正比', sessionId: 'sessB', meaningSource: 'model' },
  });
  const m1 = meaningsOf({ sessionId: 'sessA', formulas: ['F=-kx'] });
  const m2 = meaningsOf({ sessionId: 'sessC', formulas: ['G = mg'] });
  if (m1.length !== 1 || m1[0].meaning !== '回复力与位移成正比') return false;
  if (m2.length !== 1 || m2[0].meaning !== '重力与质量成正比') return false;
  // 提示词含标题/公式/含义/旧摘要/60 字约束
  const prompt = build(
    { title: '简谐运动', category: 'physics', summary: '整卡摘要原文', formulas: ['F=-kx'] },
    m1,
  );
  for (const frag of ['简谐运动', 'F=-kx', '回复力与位移成正比', '整卡摘要原文', '60 字']) {
    if (!prompt.includes(frag)) throw new Error('重述提示词缺: ' + frag);
  }
  // 回复清洗：思考块/前缀/引号/多行解释
  if (clean('<think>推理</think>摘要：**重述摘要正文**') !== '重述摘要正文') return false;
  if (clean('“带引号的模型回复”') !== '带引号的模型回复') return false;
  if (clean('第一行摘要\n第二行解释') !== '第一行摘要') return false;
  if (clean('好的，以下是摘要：\n真正摘要行') !== '真正摘要行') return false;
  delete storageData['phymathia_formulas'];
  return true;
});

check('knowledge: P3 批量任务中止后不再发后续请求 + 目标写回 + 非目标不触碰（沙箱行为断言）', async () => {
  const realProxy = sandbox.proxyChatWithModel;
  const realGetActive = sandbox.getActiveModelForRole;
  const RealAbortController = sandbox.AbortController;
  // 宽松 DOM 代理对任意属性都返回代理（含 Symbol.match），真实字符串 .includes(代理)
  // 会被当成 RegExp 抛 TypeError——批量路径涉及的 getElementById 换成哑元素，
  // knowledgePanel 视为未打开（跳过重渲），结束后还原。
  const realGetElementById = sandbox.document.getElementById;
  const fakeEl = () => ({
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    style: {}, textContent: '', innerHTML: '',
  });
  sandbox.document.getElementById = () => fakeEl();
  try {
    // 三条 local 整卡摘要目标 + 一条手动条目（必须不触碰）
    storageData['phymathia_knowledge'] = JSON.stringify({
      ki_a: { id: 'ki_a', title: '简谐运动', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要A', summarySource: 'local', anchorSummary: '整卡摘要A', formulas: [], createdAt: 1 },
      ki_b: { id: 'ki_b', title: '胡克定律', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要B', summarySource: 'local', anchorSummary: '整卡摘要B', formulas: [], createdAt: 2 },
      ki_c: { id: 'ki_c', title: '导数', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要C', summarySource: 'local', anchorSummary: '整卡摘要C', formulas: [], createdAt: 3 },
      ki_m: { id: 'ki_m', title: '手动条目', sessionId: 's1', source: 'manual', summary: '手动摘要', summarySource: 'manual', formulas: [], createdAt: 4 },
    });
    sandbox.invalidateKnowledgeCache();
    sandbox.getActiveModelForRole = (role) => (role === 'descriptor'
      ? { id: 'desc', provider: 'test', model: 'test-model', baseUrl: 'https://example.test', apiKey: 'k' }
      : null); // descriptor 槽位优先
    let proxyCalls = 0;
    sandbox.proxyChatWithModel = async (model, body, signal) => {
      proxyCalls++;
      if (proxyCalls === 1) {
        const prompt = body.messages.map(m => m.content).join('\n');
        if (!prompt.includes('简谐运动')) throw new Error('第一条请求应针对目标条目');
        if (body.stream !== false) throw new Error('重述调用应走 stream:false');
        return { json: async () => ({ choices: [{ message: { content: '重述后的摘要A' } }] }) };
      }
      // 第二条请求进行中被用户中止：置 aborted（模拟 AbortController.abort 效果）并拒绝在途 fetch
      signal.aborted = true;
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };
    sandbox.AbortController = class {
      constructor() { this.signal = { aborted: false }; this.abort = () => { this.signal.aborted = true; }; }
    };
    await sandbox.optimizeKnowledgeSummaries();
    if (proxyCalls !== 2) throw new Error('中止后应不再发出后续请求，实际调用 ' + proxyCalls + ' 次（应为 2）');
    const after = JSON.parse(storageData['phymathia_knowledge']);
    if (after.ki_a.summary !== '重述后的摘要A' || after.ki_a.summarySource !== 'model') return false; // 完成条目写回
    if (after.ki_a.anchorSummary !== '整卡摘要A') return false; // 定位锚点保留
    if (after.ki_b.summary !== '整卡摘要B' || after.ki_b.summarySource !== 'local') return false; // 失败条目不写回
    if (after.ki_c.summary !== '整卡摘要C' || after.ki_c.summarySource !== 'local') return false; // 中止后未触碰
    if (after.ki_m.summary !== '手动摘要' || after.ki_m.summarySource !== 'manual') return false; // manual 不触碰
    return true;
  } finally {
    sandbox.proxyChatWithModel = realProxy;
    sandbox.getActiveModelForRole = realGetActive;
    sandbox.AbortController = RealAbortController;
    sandbox.document.getElementById = realGetElementById;
    delete storageData['phymathia_knowledge'];
    sandbox.invalidateKnowledgeCache();
  }
});

check('knowledge: P3 中断注册表接线（关闭面板/再次点击/Esc 三路径 + 循环前查 signal）与入口静态断言', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  for (const frag of [
    'let _kpSummaryOptimizeAbort',                                    // 模块级注册表：中断路径的唯一持有者
    'function abortKnowledgeSummaryOptimize',                         // 统一中断入口
    "if (event.key === 'Escape') abortKnowledgeSummaryOptimize()",    // Esc 路径
    'abortKnowledgeSummaryOptimize();\n  document.getElementById(\'knowledgePanel\').classList.remove', // 关闭面板路径
    'if (_knowledgeSummaryTaskRunning())',                            // 再次点击 = 中断（批量入口首行分流）
    'if (controller.signal.aborted) { aborted = true; break; } // 中止后不再发出后续请求',   // 循环每轮先查
    'if (controller.signal.aborted) { aborted = true; break; } // 用户中断不计为失败',       // 在途 fetch 拒绝后 break
    "restatKnowledgeItemSummary('${item.id}')",                       // 卡片单条入口（渲染层接线）
    "isLegacyCardSummaryItem(item) ? `<button class=\"kp-action-btn kp-btn-primary\" onclick=\"event.stopPropagation(); restatKnowledgeItemSummary", // 非目标条目不渲染入口
  ]) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺中断/入口接线: ' + frag);
  }
  for (const frag of ['optimizeKnowledgeSummaries', 'isLegacyCardSummaryItem', 'restatKnowledgeItemSummary', '_kpSummaryOptimizeAbort']) {
    if (!code.includes(frag)) throw new Error('打包产物缺符号: ' + frag);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('kpOptimizeBtn') || !html.includes('optimizeKnowledgeSummaries()')) return false;
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  return css.includes('.kp-tool-btn');
});

check('knowledge: P4 extractLocalKnowledge 模板化摘要（多公式回答逐条互异 + anchor 保整卡 + 前后端同文案）', () => {
  // 与 pytest test_local_extract_summaries_differ_for_multi_formula_answers 同一组输入：
  // 期望文案两侧逐字一致（前端 _buildLocalKnowledgeSummary / 后端 _local_knowledge_summary）
  const answers = [
    '# 简谐运动\n回复力让物体振动。\n<formula>F=-kx</formula>\n'
      + '<formula>T=2\\pi\\sqrt{\\frac{m}{k}}</formula>\n<summary>甲卡整卡摘要</summary>',
    '# 傅里叶级数\n周期信号可分解为谐波叠加。\n'
      + '<formula>\\sum_{n=1}^{\\infty}a_n e^{inx}</formula>\n<summary>乙卡整卡摘要</summary>',
    '# 傅里叶变换\n把信号分解为连续频率分量。\n'
      + '<formula>\\int_0^{T}f(t)dt</formula>\n<summary>丙卡整卡摘要</summary>',
    '# 简谐运动能量\n总机械能与振幅平方成正比。\n'
      + '<formula>E=\\frac{1}{2}kA^2</formula>\n<summary>丁卡整卡摘要</summary>',
    '# 导数\n刻画函数的瞬时变化率，本卡没有公式。',
  ];
  const anchorParts = ['甲卡整卡摘要', '乙卡整卡摘要', '丙卡整卡摘要', '丁卡整卡摘要', '瞬时变化率'];
  const expected = [
    '「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）',
    '「傅里叶级数」：傅里叶级数/变换：用指数基元把信号分解为频率成分（物理）',
    '「傅里叶变换」：傅里叶变换：把信号分解为连续频率分量的积分表示（其他）',
    '「简谐运动能量」：简谐运动总机械能与振幅平方成正比（物理）',
    '「导数」：数学知识点',
  ];
  const items = answers.map(c => sandbox.extractLocalKnowledge([{ role: 'assistant', content: c }])[0]);
  if (items.some(it => !it || it.summarySource !== 'local')) return false;
  for (let i = 0; i < expected.length; i++) {
    if (items[i].summary !== expected[i]) {
      throw new Error('模板文案偏离（须与后端 _local_knowledge_summary 同口径）: ' + items[i].summary);
    }
    if (items[i].anchorSummary === items[i].summary) return false; // 整卡摘要仍是锚点，不再充当展示摘要
    if (!String(items[i].anchorSummary).includes(anchorParts[i])) return false; // 锚点保留整卡摘要原文
  }
  const summaries = items.map(it => it.summary);
  if (new Set(summaries).size !== summaries.length) return false; // 各条互不相同
  // 多公式回答取首个公式的规则含义（胡克定律），不串到第二公式（周期）含义
  if (!summaries[0].includes('胡克定律') || summaries[0].includes('周期')) return false;
  // 超长标题（审查修复回归）：预算压缩标题保结构——「」/含义/分类括注完整、≤120，
  // 期望串与 pytest test_local_knowledge_summary_long_title_keeps_structure 同口径
  const unit = '很长的知识点标题';
  const longAns = [{ role: 'assistant', content: `# ${unit.repeat(15)}\n受力分析如下。\n<formula>F=ma</formula>` }];
  const longItem = sandbox.extractLocalKnowledge(longAns)[0];
  const longExpected = `「${unit.repeat(6)}很长的」：${unit.repeat(3)}相关公式：用于描述${unit.repeat(3)}的定量关系（物理）`;
  if (!longItem || longItem.summary !== longExpected) {
    throw new Error('超长标题模板偏离（须与后端 _local_knowledge_summary 同口径）: ' + (longItem && longItem.summary));
  }
  const longNoFormula = sandbox.extractLocalKnowledge(
    [{ role: 'assistant', content: `# ${unit.repeat(15)}\n本卡没有公式。` }])[0];
  if (!longNoFormula || !longNoFormula.summary.startsWith('「')) return false;
  if (!longNoFormula.summary.endsWith('」：其他知识点') || longNoFormula.summary.length > 120) return false;
  if (!code.includes('_buildLocalKnowledgeSummary')) throw new Error('打包产物缺 _buildLocalKnowledgeSummary');
  return true;
});

check('chat：推理通道不混进正文（混进去 → 整轮知识提取被「思维链泄漏」闸门拒收 → 大陆永远没有这座岛）', () => {
  // 真机事故（2026-09-15）：推理型模型先吐 reasoning_content 再吐 content，前端旧写法
  // `assistantContent += delta.content || delta.reasoning_content` 把思维链灌进正文，
  // 正文以「用户要求：…当前分支类型…必须只输出…」开头 → 前后端同判的 _looksLikeReasoningLeak
  // 命中 → 整轮不提取 → 用户问过「旋度」，知识库与大陆里却永远没有旋度。
  const src = fs.readFileSync('src/static/js/chat.js', 'utf8');
  if (/assistantContent \+= delta\.content \|\| delta\.reasoning_content/.test(src)) {
    throw new Error('思维链又被灌进正文了（知识提取会被闸门整轮拒收）');
  }
  if (!/if \(delta\.content\) assistantContent \+= delta\.content;/.test(src)) {
    throw new Error('正文累加口径缺失（只认 delta.content）');
  }
  if (!src.includes('assistantReasoning')) throw new Error('推理通道未单独攒');
  if (!src.includes('assistantContent = assistantReasoning')) {
    throw new Error('模型只吐推理、正文为空时的兜底缺失（会留一个空气泡）');
  }
  // 被闸门跳过时必须让用户知道原因：静默正是这场事故最坑的地方
  const feat = fs.readFileSync('src/static/js/chat-features.js', 'utf8');
  if (!feat.includes("_knowledgeSkipReason = 'reasoning_leak'")) throw new Error('提取被跳过时未记录原因');
  if (!feat.includes('混进了模型的思考过程')) throw new Error('跳过原因未告知用户（不许静默）');
  if (!code.includes('混进了模型的思考过程')) throw new Error('打包产物缺提示文案（未 build:js？）');
  return true;
});

// ===== M1 可视化数值实验自动校验 =====
check('viz-check：三桥注入与桥体打包存在', () => {
  if (!code.includes('_VIZ_CHECK_BRIDGE')) throw new Error('打包产物缺 _VIZ_CHECK_BRIDGE');
  // 压缩产物会去掉加号两侧空格，用空白容忍匹配三桥拼接
  if (!/_VIZ_MATH_BRIDGE\s*\+\s*_VIZ_THEME_BRIDGE\s*\+\s*_VIZ_CHECK_BRIDGE/.test(code)) throw new Error('buildVizCard 未注入第三桥');
  if (!code.includes('"phymathia-viz-check"')) throw new Error('校验消息类型缺失（桥回传或 parent 监听）');
  if (!code.includes('__PHYMATHIA_VIZ__')) throw new Error('约定对象探测缺失');
  return true;
});

check('viz-check：角标三态文案与重生成意图', () => {
  for (const t of ['校验通过 ✓', '守恒漂移 ⚠ 建议重新生成', '与解析解偏差 ⚠', '校验中…', '重新生成可视化：']) {
    if (!code.includes(t)) throw new Error('缺文案：' + t);
  }
  return true;
});

check('viz-check：_vizCheckEnergyTotals 分量求和与 NaN 计数', () => {
  const r = sandbox._vizCheckEnergyTotals([
    { t: 0, energy: { kinetic: 1, potential: 1 } },
    { t: 0.25, energy: { kinetic: NaN, potential: 1 } },
    { t: 0.5, energy: { kinetic: 2, potential: 2 } },
    { t: 0.75, energy: {} },            // 分量缺失 → 整点跳过
  ]);
  if (r.totals.length !== 2 || r.totals[0] !== 2 || r.totals[1] !== 4) throw new Error('求和错误: ' + JSON.stringify(r));
  if (r.nonFinite !== 1) throw new Error('nonFinite 应为 1');
  return true;
});

check('viz-check：_vizCheckComputeDrift 漂移口径', () => {
  if (sandbox._vizCheckComputeDrift([1, 1, 1, 1]) !== 0) return false;
  if (sandbox._vizCheckComputeDrift([1, 2, 3]) !== null) return false;          // <4 点
  if (sandbox._vizCheckComputeDrift([0, 0, 0, 0]) !== null) return false;       // 均值≈0 → 跳过守恒项
  const d = sandbox._vizCheckComputeDrift([10, 10.5, 10.2, 10.4, 10.3]);        // (10.5−10)/10.28≈4.9%
  if (!(d > 0.045 && d < 0.055)) throw new Error('漂移计算偏离: ' + d);
  return true;
});

check('viz-check：_vizCheckEstimatePeriod 由 KE 序列恢复周期', () => {
  // 解析 KE：C(1−cos2ωt)，ω=2 → 振子周期 T=2π/ω≈3.1416；250ms×40 点（真实采样节奏）
  const T = 2 * Math.PI / 2, dt = 0.25, samples = [];
  for (let i = 0; i < 40; i++) {
    const t = i * dt;
    samples.push({ t: t, energy: { kinetic: 0.5 * (1 - Math.cos(4 * t)), potential: 0.5 * (1 + Math.cos(4 * t)) } });
  }
  const est = sandbox._vizCheckEstimatePeriod(samples);
  if (est == null || Math.abs(est - T) / T > 0.005) throw new Error('周期估计偏离: ' + est);
  return true;
});

check('viz-check：_vizCheckTheoryPeriod v1 两张标准模型表', () => {
  const sm = sandbox._vizCheckTheoryPeriod('spring-mass', { m: 0.5, k: 2 });
  const pd = sandbox._vizCheckTheoryPeriod('pendulum', { L: 1, g: 9.8 });
  if (Math.abs(sm - Math.PI) > 1e-9) return false;
  if (Math.abs(pd - 2 * Math.PI * Math.sqrt(1 / 9.8)) > 1e-9) return false;
  if (sandbox._vizCheckTheoryPeriod('damped-oscillation', {}) !== null) return false;  // 非标准模型不猜
  if (sandbox._vizCheckTheoryPeriod('spring-mass', { m: 0, k: 2 }) !== null) return false;  // 参数非法不猜
  return true;
});

check('viz-check：_vizCheckVerdict 四态判定', () => {
  const synth = (w) => {
    const arr = [];
    for (let i = 0; i < 40; i++) {
      const t = i * 0.25;
      arr.push({ t: t, energy: { kinetic: 0.5 * (1 - Math.cos(2 * w * t)), potential: 0.5 * (1 + Math.cos(2 * w * t)) } });
    }
    return arr;
  };
  const vp = sandbox._vizCheckVerdict(synth(2), 'spring-mass', { m: 0.5, k: 2 });      // 周期与守恒均合
  if (vp.status !== 'pass') throw new Error('恒能应为 pass: ' + JSON.stringify(vp));
  const driftSamples = synth(2).map((s, i) => ({ t: s.t, energy: { kinetic: 1 + i * 0.2, potential: 1 } }));
  const vd = sandbox._vizCheckVerdict(driftSamples, null, null);
  if (vd.status !== 'fail' || vd.kind !== 'drift') throw new Error('漂移应 fail: ' + JSON.stringify(vd));
  const nanSamples = synth(2).map((s, i) => ({ t: s.t, energy: { kinetic: i % 3 === 0 ? NaN : 1, potential: 2 } }));
  const vn = sandbox._vizCheckVerdict(nanSamples, null, null);
  if (vn.status !== 'fail' || vn.kind !== 'diverge') throw new Error('NaN 多发应 diverge: ' + JSON.stringify(vn));
  const vw = sandbox._vizCheckVerdict(synth(2.2), 'spring-mass', { m: 0.5, k: 2 });    // 模拟 ω=2.2 vs 理论 ω=2 → 偏差 ~9%
  if (vw.status !== 'warn') throw new Error('周期偏差应 warn: ' + JSON.stringify(vw));
  const vq = sandbox._vizCheckVerdict(synth(2.2), null, null);                          // 未声明 model → 不比对解析解
  if (vq.status !== 'pass') throw new Error('未声明 model 不应 warn: ' + JSON.stringify(vq));
  if (sandbox._vizCheckVerdict(synth(2).slice(0, 2), 'spring-mass', { m: 0.5, k: 2 }).status !== 'none') return false;
  return true;
});

// ===== 模型分组与分组密钥 =====
check('model-group：分组接线（组头渲染/组密钥输入/折叠/optgroup 下拉）静态断言', () => {
  for (const t of ['phymathia_model_group_keys', 'saveGroupKey', 'toggleModelGroup', 'model-group-key', '<optgroup label=', 'data-provider']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  // 点外关闭监听须跳过已脱离 DOM 的点击目标（分组折叠就地切换的前提）
  if (!code.includes('isConnected')) throw new Error('点外关闭缺少 detached-target 守卫');
  return true;
});

check('model-add：双模式添加接线（预设/手动选项卡 + 勾选清单 + 在线拉取）静态断言', () => {
  // 打包产物经 esbuild 压缩（键名引号/空白会被改写），只能断言裸标识符存在
  for (const t of ['switchAddModelTab', 'am-model-check', 'addModelsForProvider', 'api/models/list', 'fetchProviderModelList', 'fetchManualModelList', 'confirmDeleteModelGroup', '_parseExtraModelInput']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  // 自动预置必须已移除：列表里只允许出现用户主动加过的模型（用户反馈的根因）
  for (const gone of ['_ensureOpencodeGoModels', '_ensureOpencodeFreeModels', '_ensureDeepseekModels']) {
    if (code.includes(gone)) throw new Error('自动预置函数仍在：' + gone);
  }
  // 预设注册表覆盖主流供应商（新增口径的最低门槛；注册表挂 window 供运行时读取）
  if (!code.includes('window.MODEL_PRESETS')) throw new Error('注册表未挂 window');
  for (const p of ['zhipu', 'moonshot', 'dashscope', 'bigmodel', 'minimaxi', 'siliconflow', 'generativelanguage', 'anthropic', 'openrouter', 'groq', '11434', '1234']) {
    if (!code.includes(p)) throw new Error('预设注册表缺供应商特征串：' + p);
  }
  return true;
});

check('model-add：无自动预置（loadUserModels 后列表为空）+ 预设添加核心（勾选入库 + 组密钥同步 + 重复跳过）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  if (sandbox.getAllModels().length !== 0) throw new Error('loadUserModels 不得自动预置任何模型');
  const preset = sandbox.window.MODEL_PRESETS.deepseek; // const 声明只挂 window，不在沙箱全局
  if (!preset || !Array.isArray(preset.models) || preset.models.length < 2) throw new Error('deepseek 预设应 ≥2 个模型');
  const entries = preset.models.map(m => ({ model: m.id, label: m.label }));
  const n = sandbox.addModelsForProvider('deepseek', 'sk-ds-group', preset.baseUrl, entries);
  if (n !== preset.models.length) throw new Error('应新增 ' + preset.models.length + ' 个，实际 ' + n);
  const ds = sandbox.getAllModels().filter(m => m.provider === 'deepseek');
  if (ds.length !== preset.models.length) throw new Error('入库条数不符: ' + ds.length);
  if (!ds.every(m => m.hasKey)) throw new Error('组密钥未同步到条目');
  if (!ds.map(m => m.name).some(s => s.includes('Chat'))) throw new Error('label 未带入: ' + ds.map(m => m.name).join(','));
  const again = sandbox.addModelsForProvider('deepseek', 'sk-ds-group', preset.baseUrl, entries);
  if (again !== 0) throw new Error('重复添加应全部跳过，实际新增 ' + again);
  // 清理组密钥与条目缓存，避免污染后续用例的「组外不触碰」断言
  sandbox.saveGroupKey('deepseek', '');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  return true;
});

check('model-add：组密钥写入同步到组内全部条目（组外不触碰）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  const goPreset = sandbox.window.MODEL_PRESETS['opencode-go'];
  const picked = goPreset.models.slice(0, 3);
  const n = sandbox.addModelsForProvider('opencode-go', '', goPreset.baseUrl, picked.map(m => ({ model: m.id, label: m.label })));
  if (n !== 3) throw new Error('手动勾选 3 个应入库 3 个，实际 ' + n);
  if (sandbox.getAllModels().filter(m => m.provider === 'opencode-go').some(m => m.hasKey)) throw new Error('未填密钥不应误标已配置');
  sandbox.saveGroupKey('opencode-go', 'sk-group-test');
  const after = sandbox.getAllModels();
  if (!after.filter(m => m.provider === 'opencode-go').every(m => m.hasKey)) return false;
  if (after.filter(m => m.provider !== 'opencode-go').some(m => m.hasKey)) return false; // 组外不得被污染
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys'))['opencode-go'] !== 'sk-group-test') return false;
  // 组密钥存在时，后加的条目自动继承（空密钥不覆盖组里已有密钥）
  const extra = sandbox.addModelsForProvider('opencode-go', '', goPreset.baseUrl, [{ model: 'late-added-model', label: '后加模型' }]);
  if (extra !== 1) throw new Error('后加条目应入库');
  // getAllModels 的行项不带 model 原文（只有拼好的 name），按显示名匹配
  const late = sandbox.getAllModels().find(m => m.provider === 'opencode-go' && m.name.includes('后加模型'));
  if (!late || !late.hasKey) throw new Error('后加条目未继承组密钥');
  sandbox.saveGroupKey('opencode-go', '');
  if (sandbox.getAllModels().filter(m => m.provider === 'opencode-go').some(m => m.hasKey)) return false; // 清空也同步
  // 整组删除：条目、组密钥一并清
  const removed = sandbox.deleteModelGroup('opencode-go');
  if (removed !== 4) throw new Error('整组删除应清 4 条，实际 ' + removed);
  if (sandbox.getAllModels().some(m => m.provider === 'opencode-go')) throw new Error('整组删除后仍有残留');
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys') || '{}')['opencode-go'] !== undefined) throw new Error('组密钥未一并删除');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  return true;
});

// ===== M2 检测闭环收口（quiz-relearn.js）：建议复习动作 / 同主题重测 / 重学引导 =====
const M2_TOPIC_KEY = 'topic-HM';
const M2_SESSION = 'sess_test';

function m2SeedQuizStats(extra) {
  const now = Date.now();
  const stats = {
    _meta: { version: 2, updatedAt: now, wrongQuestions: [] },
    know_hm: {
      title: '简谐运动', correct: 0, wrong: 2, topicKey: M2_TOPIC_KEY,
      sessionId: M2_SESSION, dueAt: now - 3600000, history: [{ correct: false }],
    },
    know_hk: {
      title: '胡克定律', correct: 0, wrong: 3, topicKey: 'topic-HK',
      sessionId: M2_SESSION, dueAt: now - 3600000, history: [{ correct: false }],
    },
  };
  if (extra) Object.assign(stats, extra);
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  return stats;
}

function m2WrongQuestion() {
  return {
    id: 'w_hm', title: '简谐运动', prompt: '简谐运动的周期由什么决定？',
    options: [{ key: 'A', text: 'm 与 k' }, { key: 'B', text: '振幅' }],
    correctIndex: 0, refId: 'kp_hm', sourceRef: 'kp_hm', sourceType: 'knowledge',
    topicKey: M2_TOPIC_KEY, sessionId: M2_SESSION, wrongAt: Date.now(),
  };
}

check('quiz-relearn：建议复习动作接线（两按钮 + 打包注册）静态断言', () => {
  if (!code.includes('/* quiz-relearn.js */')) throw new Error('打包未注册 quiz-relearn.js');
  if (!code.includes('quiz-weak-item-actions')) throw new Error('建议复习条目缺动作容器');
  if (!code.includes("quizLocateTopic('")) throw new Error('缺「定位到画布」按钮接线');
  if (!code.includes("quizRetestTopic('")) throw new Error('缺「重测同类题」按钮接线');
  if (typeof sandbox.quizLocateTopic !== 'function' || typeof sandbox.quizRetestTopic !== 'function') {
    throw new Error('入口未挂 window');
  }
  return true;
});

check('quiz-relearn：主题→定位目标解析（错题 sourceRef 优先，回退按标题匹配知识条目）', () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    kp_hm: { id: 'kp_hm', title: '简谐运动', sessionId: M2_SESSION },
  }));
  // A：主题有错题快照且带 sourceRef → 直接用错题的落点
  m2SeedQuizStats();
  const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
  stats._meta.wrongQuestions = [m2WrongQuestion()];
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  const viaWrong = sandbox._quizResolveTopicTarget(encodeURIComponent(M2_TOPIC_KEY));
  if (!viaWrong || viaWrong.refId !== 'kp_hm' || viaWrong.isFormula !== false) {
    throw new Error('错题 sourceRef 未优先生效: ' + JSON.stringify(viaWrong));
  }
  if (viaWrong.title !== '简谐运动') throw new Error('应带主题标题，实际 ' + viaWrong.title);
  // B：无该主题错题 → 回退按标题匹配知识条目
  m2SeedQuizStats();
  const viaTitle = sandbox._quizResolveTopicTarget(encodeURIComponent(M2_TOPIC_KEY));
  if (!viaTitle || viaTitle.refId !== 'kp_hm') throw new Error('标题回退未命中: ' + JSON.stringify(viaTitle));
  // C：主题在该画布不存在 → null（查空是正常路径）
  if (sandbox._quizResolveTopicTarget(encodeURIComponent('topic-none')) !== null) {
    throw new Error('未知主题应返回 null');
  }
  return true;
});

check('quiz-relearn：同主题重测组卷（素材收缩 + 错题打头 + 去重截断，不动全量 pool）', () => {
  const pool = {
    knowledge: [
      { id: 'kp_hm', title: '简谐运动', topicKey: M2_TOPIC_KEY, summary: 's' },
      { id: 'kp_hk', title: '胡克定律', topicKey: 'topic-HK', summary: 's' },
    ],
    formulas: [{ id: 'f_zq', latex: 'T=2\\pi\\sqrt{m/k}', topicKey: M2_TOPIC_KEY }],
  };
  const scoped = sandbox._quizPoolForTopic(M2_TOPIC_KEY, pool);
  if (scoped.knowledge.length !== 1 || scoped.knowledge[0].id !== 'kp_hm') throw new Error('知识条目未按主题收缩');
  if (scoped.formulas.length !== 1 || scoped.formulas[0].id !== 'f_zq') throw new Error('公式条目未按主题收缩');
  if (pool.knowledge.length !== 2) throw new Error('不得改动传入的全量素材');
  // 组卷：2 道原错题打头，新题补齐到目标题数，同题干同答案去重（题型不同也算同一题）
  const m2Opts = () => [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }];
  const wrong = [
    { id: 'w1', prompt: 'p1', options: m2Opts(), correctIndex: 0 },
    { id: 'w2', prompt: 'p2', options: m2Opts(), correctIndex: 0 },
    { id: 'w3', prompt: 'p3', options: m2Opts(), correctIndex: 0 },
  ];
  const generated = [
    { id: 'g1', type: 'concept', prompt: 'p1', options: m2Opts(), correctIndex: 0 }, // 与 w1 同题干同答案 → 去重
    { id: 'g2', type: 'concept', prompt: 'p2x', options: m2Opts(), correctIndex: 0 },
    { id: 'g3', type: 'concept', prompt: 'p3x', options: m2Opts(), correctIndex: 0 },
    { id: 'g4', type: 'concept', prompt: 'p4x', options: m2Opts(), correctIndex: 0 },
  ];
  const composed = sandbox._quizComposeTopicQuestions(wrong, generated, 4);
  if (composed.length !== 4) throw new Error('应截断到目标题数 4，实际 ' + composed.length);
  if (composed[0].id !== 'w1' || composed[1].id !== 'w2') throw new Error('同主题原错题应打头');
  if (composed.some(q => q.id === 'g1')) throw new Error('同签名新题未去重');
  if (composed.some(q => q.id === 'w3')) throw new Error('原错题最多取 2 道');
  // 无选项的脏题不得进卷
  if (sandbox._quizComposeTopicQuestions([{ id: 'bad', prompt: 'x' }], [], 4).length !== 0) {
    throw new Error('无选项的题应被过滤');
  }
  return true;
});

check('quiz-relearn：重学引导（浮卡两动作 + 我的理解节点 + 落点 + 联系模式预选起点）', () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  // 并发段的 knowledge 用例会把 getElementById 换成哑元素（无 querySelector/appendChild）；
  // 本检查是同步用例，自己钉住一个宽松元素，避免被别人的桩带崩。
  const realGetById = sandbox.document.getElementById;
  sandbox.document.getElementById = () => loose('smokeEl');
  let ctx = null;
  let html = '';
  let near = null;
  let fallback = null;
  let created = [];
  let edited = null;
  try {
    sandbox.showQuizRelearnGuide({ title: '简谐运动', nodeId: 'n1' });
    ctx = sandbox._quizRelearnCtxGet();
    if (!ctx || ctx.title !== '简谐运动' || ctx.nodeId !== 'n1') throw new Error('引导上下文未建立');
    html = sandbox.quizRelearnPillHtml();
    if (!html.includes('quizRelearnCreateNote()') || !html.includes('quizRelearnConnect()')) {
      throw new Error('浮卡缺两个建议动作');
    }
    if (!html.includes('写下总结节点') || !html.includes('连接先导概念')) throw new Error('动作文案缺失');
    if (sandbox._quizRelearnNoteLabel('简谐运动') !== '我的理解：简谐运动') throw new Error('总结节点标题不符');
    // 落点：定位节点旁 +24/+24；节点未知时退回画布默认落点（不抛错）
    const realFind = sandbox._findGraphNode;
    try {
      sandbox._findGraphNode = id => (id === 'n1' ? { id: 'n1', x: 100, y: 200 } : null);
      near = sandbox._quizRelearnAnchorPoint('n1');
      fallback = sandbox._quizRelearnAnchorPoint('');
    } finally {
      sandbox._findGraphNode = realFind;
    }
    if (near.x !== 124 || near.y !== 224) throw new Error('落点应为源节点 +24/+24，实际 ' + JSON.stringify(near));
    if (!Number.isFinite(fallback.x) || !Number.isFinite(fallback.y)) throw new Error('退化落点应仍为有效坐标');
    // 真建节点：必须是 kind=human_note（「我的理解」，有手写弹窗）——blank 是「写要求→AI 生成」
    // 的 AI 节点，没有手写路径，不能用来表达「我自己懂了的证据」
    const store = { customNodes: [], connections: [], positions: {}, collapsed: {}, hidden: {}, groups: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, harnessDeleted: {}, pan: { x: 0, y: 0 }, zoom: 0.9 };
    const realGetState = sandbox.window.getGraphState;
    const realSaveState = sandbox.window.saveGraphState;
    const realGetChat = sandbox.window.getChatHistory;
    const realEdit = sandbox.editHumanNoteNode;
    try {
      sandbox.window.getGraphState = () => store;
      sandbox.window.saveGraphState = (sid, next) => Object.assign(store, next);
      sandbox.window.getChatHistory = () => [];
      sandbox.editHumanNoteNode = (id) => { edited = id; };
      sandbox.quizRelearnCreateNote();
      created = (vm.runInContext('graphView.nodes', sandbox) || []).filter(n => n.kind === 'human_note');
      if (created.length !== 1) throw new Error('应创建 1 个「我的理解」节点，实际 ' + created.length);
      if (created[0].label !== '我的理解：简谐运动') throw new Error('节点标题未带主题：' + created[0].label);
      if (edited !== created[0].id) throw new Error('未打开「编辑我的理解」弹窗');
      if (sandbox._quizRelearnCtxGet().noteNodeId !== created[0].id) throw new Error('引导未记住总结节点');
      if (!sandbox.quizRelearnPillHtml().includes('继续写总结')) throw new Error('浮卡文案未切到续写态');
      // 连接：把总结节点设为既有联系模式起点
      sandbox.quizRelearnConnect();
      if (vm.runInContext('graphView.linkMode', sandbox) !== true) throw new Error('未进入联系模式');
      if (vm.runInContext('graphView.linkFirstNodeId', sandbox) !== created[0].id) throw new Error('未预选总结节点为起点');
      // 再点一次不重复建节点，改为聚焦 + 打开编辑器
      sandbox.quizRelearnCreateNote();
      if ((vm.runInContext('graphView.nodes', sandbox) || []).filter(n => n.kind === 'human_note').length !== 1) {
        throw new Error('重复点击不应再建节点');
      }
      if (edited !== created[0].id) throw new Error('重复点击应重新打开编辑器');
    } finally {
      sandbox.window.getGraphState = realGetState;
      sandbox.window.saveGraphState = realSaveState;
      sandbox.window.getChatHistory = realGetChat;
      sandbox.editHumanNoteNode = realEdit;
    }
    // 落点未知时「连接先导概念」走既有联系模式兜底分支（不崩、不预设起点）
    sandbox.clearQuizRelearnGuide();
    sandbox.showQuizRelearnGuide({ title: '简谐运动', nodeId: '' });
    sandbox.quizRelearnConnect();
    sandbox.clearQuizRelearnGuide();
    if (sandbox.quizRelearnPillHtml() !== '') throw new Error('清空引导后浮卡不应再出动作');
  } finally {
    sandbox.document.getElementById = realGetById;
  }
  return true;
});

check('harness：quiz_weak 快照注入（当前会话 Top3，空则不注入）', () => {
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.window.getGraphViewNodes = () => [{ id: 'A', kind: 'knowledge', label: '简谐运动', content: '往复运动' }];
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.window.getSelectedGraphNodeIds = () => [];
  m2SeedQuizStats();
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  if (!Array.isArray(snap.quiz_weak)) throw new Error('quiz_weak 未注入');
  if (snap.quiz_weak.length !== 2) throw new Error('应注入当前会话 2 条薄弱点，实际 ' + snap.quiz_weak.length);
  for (const key of ['title', 'wrong', 'mastery', 'sessionId']) {
    if (!(key in snap.quiz_weak[0])) throw new Error('薄弱点字段缺 ' + key);
  }
  // Top3 截断
  const many = { _meta: { version: 2, wrongQuestions: [] } };
  for (let i = 0; i < 5; i++) {
    many['k' + i] = { title: '薄弱' + i, correct: 0, wrong: 2, topicKey: 'topic-' + i, sessionId: M2_SESSION, dueAt: 1 };
  }
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(many));
  const capped = sandbox.buildHarnessSnapshot(false, [], null);
  if (capped.quiz_weak.length !== 3) throw new Error('应截断到 Top3，实际 ' + capped.quiz_weak.length);
  // 无薄弱点 → 不带该字段（避免空数组噪声）
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify({ _meta: { version: 2, wrongQuestions: [] } }));
  const clean = sandbox.buildHarnessSnapshot(false, [], null);
  if ('quiz_weak' in clean) throw new Error('无薄弱点时应省略 quiz_weak');
  // 清理污染
  sandbox.localStorage.removeItem('phymathia_quiz_stats');
  sandbox.localStorage.removeItem('phymathia_knowledge');
  sandbox.invalidateKnowledgeCache();
  return true;
});

// ===== 知识大陆（graph-continent.js，大陆计划 v1）静态/沙箱回归 =====
// 分层不变量：主图是投影层，前端零写路径——绝不写 phymathia_graph_ 会话键；
// 下钻复用 switchToSession + goToKnowledgeNode，不自建切会话协议。

check('graph-continent: 打包块在场且零会话键写路径', () => {
  const marker = code.indexOf('/* graph-continent.js */');
  if (marker < 0) throw new Error('app.js 缺少 graph-continent.js 块（build_frontend.mjs 未注册？）');
  let end = code.indexOf('/* ', marker + 5);
  if (end < 0) end = code.length;
  const chunk = code.slice(marker, end);
  if (chunk.indexOf('/api/continent') < 0) throw new Error('块内没有 /api/continent 拉取');
  if (/phymathia_graph_/.test(chunk)) throw new Error('大陆模块不得读写会话图键 phymathia_graph_*');
  if (chunk.indexOf('phymathia_continent_view') < 0) throw new Error('视口记忆键缺失');
  if (chunk.indexOf('switchToSession') < 0 || chunk.indexOf('goToKnowledgeNode') < 0) {
    throw new Error('下钻必须复用既有 switchToSession/goToKnowledgeNode 通道');
  }
  // v2：主图唯一写路径是 KV continent_edges（现成端点），别的地方不许落笔
  if (chunk.indexOf('/api/kv/continent_edges') < 0) throw new Error('大陆边必须走 /api/kv/continent_edges');
  return true;
});

check('graph-continent: v2/v3 静态契约（撤销栈只记边操作 / 边界城市 / 确认落笔口 / 透明层底）', () => {
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('CONTINENT_EDGES_API')) throw new Error('KV 端点常量缺失');
  if (!src.includes('_continentEdgeUndo')) throw new Error('边操作撤销栈缺失');
  if (!/undoEntry\)\s*_continentEdgeUndo\.push\((undoEntry)\)/.test(src)) throw new Error('提交必须带 undoEntry 才入栈（视口不入栈）');
  if (!src.includes('continent-node--boundary')) throw new Error('边界城市皮肤类缺失');
  if (!src.includes('画成大陆边')) throw new Error('共享弹层缺「确认落笔」按钮');
  if (!src.includes('same_session')) throw new Error('同会话无效边未按断桥通道处理');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-user-link')) throw new Error('我的大陆边样式缺失');
  if (!css.includes('.continent-dangle-link')) throw new Error('断桥样式缺失');
  if (!css.includes('.continent-popover')) throw new Error('大陆弹层样式缺失');
  // 用户拍板：大陆层透明，壁纸与星轨粒子从画布一直透到大陆
  const layerRule = css.match(/\.continent-layer\s*\{[^}]*\}/);
  if (!layerRule || !/background:\s*transparent/.test(layerRule[0])) {
    throw new Error('大陆层底必须透明（保留全局壁纸与粒子）');
  }
  return true;
});

check('graph-continent: v3 Φ 摆渡口径（_harnessContinentShared 只挑当前会话的共享点）', () => {
  if (typeof sandbox._harnessContinentShared !== 'function' && typeof sandbox.window._harnessContinentShared !== 'function') {
    throw new Error('_harnessContinentShared 未暴露');
  }
  const fn = sandbox._harnessContinentShared || sandbox.window._harnessContinentShared;
  const data = {
    clusters: [
      { sessionId: 'sess_a', title: '波与振动', items: [{ itemId: 'i1', title: '阻尼振动' }] },
      { sessionId: 'sess_b', title: '傅里叶分析', items: [{ itemId: 'i2', title: '非线性振动' }, { itemId: 'i3', title: '频谱' }] },
      { sessionId: 'sess_c', title: ' unrelated', items: [{ itemId: 'i4', title: '矩阵' }] },
    ],
    shared: [
      { kind: 'title', label: '振动', sessions: ['sess_a', 'sess_b'],
        links: [{ from: 'i1', to: 'i2', fromSession: 'sess_a', toSession: 'sess_b' }] },
      { kind: 'formula', label: 'grad', sessions: ['sess_b', 'sess_c'],
        links: [{ from: 'i3', to: 'i4', fromSession: 'sess_b', toSession: 'sess_c' }] },
      { kind: 'title', label: '振动', sessions: ['sess_a', 'sess_b'],  // 同名共享词：去重
        links: [{ from: 'i2', to: 'i1', fromSession: 'sess_b', toSession: 'sess_a' }] },
    ],
  };
  const realSid = sandbox.window.getCurrentSessionId;
  sandbox.window.getCurrentSessionId = () => 'sess_a';
  try {
    const out = fn(data);
    if (out.length !== 1) throw new Error('只应留下涉及当前会话的 1 条（跨会话那条不算、同名去重），实际 ' + out.length);
    const row = out[0];
    if (row.my_title !== '阻尼振动' || row.peer_title !== '非线性振动' || row.peer_session !== '傅里叶分析') {
      throw new Error('共享点字段口径错: ' + JSON.stringify(row));
    }
    if (row.kind !== 'title') throw new Error('kind 应原样传递');
    // 查空是正常路径：当前会话不在任何共享点里 → 空数组
    sandbox.window.getCurrentSessionId = () => 'sess_zzz';
    if (fn(data).length !== 0) throw new Error('无共享点时应返回空数组');
  } finally {
    sandbox.window.getCurrentSessionId = realSid;
  }
  // 快照注入口径：harness.js 必须把 continent_shared 放进快照与 token 估算
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!hsrc.includes('snapshot.continent_shared')) throw new Error('快照未注入 continent_shared');
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!rsrc.includes('_harnessFetchContinent')) throw new Error('审阅路径未拉取大陆投影');
  return true;
});

check('graph-continent: v5.1 边界城市（一概念三画布=1 城 3 辐条 / 不叠岛 / 四种折叠原因 / 重逢清单）', () => {
  const plan = sandbox._continentDrawPlan;
  const layout = sandbox._continentLayoutClusters;
  const rows = sandbox._continentReunionRows;
  const fits = sandbox._continentFits;
  if (typeof plan !== 'function' || typeof layout !== 'function'
      || typeof rows !== 'function' || typeof fits !== 'function') {
    throw new Error('v5.1 纯函数未暴露（drawPlan / layoutClusters / reunionRows / fits）');
  }
  // 真布局：三座岛（s1 两张卡，s2/s3 各一张）→ 2×2 网格，岛之间留 CONTINENT_CLUSTER_GAP 走廊
  const clusters = [
    { sessionId: 's1', title: '波与振动', items: [{ itemId: 'a1' }, { itemId: 'a2' }] },
    { sessionId: 's2', title: '傅里叶分析', items: [{ itemId: 'b1' }] },
    { sessionId: 's3', title: '梯度', items: [{ itemId: 'c1' }] },
  ];
  const lay = layout(clusters);
  const entry = {
    kind: 'title', label: '简谐运动', strength: 'strong',
    owners: ['a1', 'a2', 'b1', 'c1'],
    links: [
      { from: 'a1', to: 'b1', fromSession: 's1', toSession: 's2' },
      { from: 'a1', to: 'c1', fromSession: 's1', toSession: 's3' },
      { from: 'b1', to: 'c1', fromSession: 's2', toSession: 's3' },
    ],
  };
  const weak = { kind: 'title', label: '振动', strength: 'weak', owners: ['a1', 'b1'],
    links: [{ from: 'a1', to: 'b1', fromSession: 's1', toSession: 's2' }] };
  // 验收口径：一个概念跨三座岛 = 1 座城 + 3 根辐条（不是 3 条弧线围三角）
  const out = plan([weak, entry], lay.placements, lay.clusterRects, 3, 12);
  if (out.cityCount !== 1 || out.cities.length !== 1) throw new Error('应是 1 座城，实际 ' + out.cityCount);
  const city = out.cities[0];
  if (city.reps.length !== 3 || out.spokeCount !== 3) {
    throw new Error('应是 3 根辐条（每岛一根），实际 ' + city.reps.length + '/' + out.spokeCount);
  }
  if (city.entry.label !== '简谐运动') throw new Error('城市挂错了共享概念');
  if (!(city.x > 0) || !(city.y > 0) || !city.box) throw new Error('城市坐标缺失');
  // 铁律：城市绝不叠在岛上，也不压在别的城上
  if (!fits(city.box, lay.clusterRects, 0)) throw new Error('城市叠到了岛上');
  // 碰撞检测自检：与自身重叠 → 不放行；隔开 50px（远大于间隙 8）→ 放行
  if (fits(city.box, [city.box], 0)) throw new Error('碰撞检测漏判重叠');
  if (!fits({ x: city.box.x + city.box.w + 50, y: city.box.y, w: 10, h: 10 }, [city.box], 8)) {
    throw new Error('碰撞检测误判：隔开 50px 应当放得下');
  }
  // 辐条另一端必须是各岛代表卡（岛内最早学的那张：s1 → a1，不是 a2）
  const reps = city.reps.map(r => r.sessionId + ':' + r.itemId).sort().join(',');
  if (reps !== 's1:a1,s2:b1,s3:c1') throw new Error('代表卡口径错：' + reps);
  // 代表卡挂 ◈ 徽标；同岛的第二张卡（a2）不做端点
  if (!out.boundary.a1 || !out.boundary.b1 || !out.boundary.c1) throw new Error('代表卡徽标缺失');
  if (out.boundary.a2) throw new Error('非代表卡不该当辐条端点');
  // 弱证据不上图（照报，原因可分辨）
  if (out.folded.map(f => f.reason).join(',') !== 'weak') {
    throw new Error('弱证据折叠口径错：' + JSON.stringify(out.folded.map(f => f.reason)));
  }
  // 每对区域上限：上限 1 时，同一对岛的第二座城进清单（原因 capped）
  const second = Object.assign({}, entry, { label: '简谐运动方程', score: 1 });
  const capped = plan([entry, second], lay.placements, lay.clusterRects, 1, 12);
  if (capped.cityCount !== 1) throw new Error('每对上限未生效：' + capped.cityCount);
  if (capped.folded.map(f => f.reason).join(',') !== 'capped') {
    throw new Error('超每对上限的折叠原因错：' + capped.folded.map(f => f.reason).join(','));
  }
  // 全图上限：上限 1 时第二座城进清单（原因 map_capped）
  const cappedAll = plan([entry, second], lay.placements, lay.clusterRects, 3, 1);
  if (cappedAll.cityCount !== 1
      || cappedAll.folded.map(f => f.reason).join(',') !== 'map_capped') {
    throw new Error('全图上限口径错：' + cappedAll.folded.map(f => f.reason).join(','));
  }
  // 无位可放：两岛之间只有 100px 走廊（城市 112 宽摆不进去）→ 折叠而不是叠在岛上
  const tight = [
    { sessionId: 's1', title: 'A', x: 0, y: 0, w: 200, h: 200, cx: 100, cy: 100, itemCount: 1 },
    { sessionId: 's2', title: 'B', x: 300, y: 0, w: 200, h: 200, cx: 400, cy: 100, itemCount: 1 },
  ];
  const tightPlace = {
    a1: { x: 20, y: 20, w: 160, h: 46, cx: 100, cy: 43 },
    b1: { x: 320, y: 20, w: 160, h: 46, cx: 400, cy: 43 },
  };
  const noRoom = plan([entry], tightPlace, tight, 3, 12);
  if (noRoom.cityCount !== 0) throw new Error('挤不下时不该硬塞城市');
  if (noRoom.folded.map(f => f.reason).join(',') !== 'no_room') {
    throw new Error('无位可放的折叠原因错：' + noRoom.folded.map(f => f.reason).join(','));
  }
  // 重逢清单：一岛一行 + 同岛多卡缩进次行，每行自带「去看」（跳转不猜）
  const idx = {
    items: { a1: '简谐运动', a2: '简谐运动的相位', b1: '简谐运动方程', c1: '简谐运动的能量' },
    clusterTitles: { s1: '波与振动', s2: '傅里叶分析', s3: '梯度' },
    itemSession: { a1: 's1', a2: 's1', b1: 's2', c1: 's3' },
    itemCreated: { a1: 1000, a2: 2000, b1: 3000, c1: 4000 },
    rel: () => '3 天前',
  };
  const html = (() => {
    // 沙箱的 document 是宽松代理，utils.escapeHtml 的产物会退化成 '0'：断言行文案前
    // 换成恒等转义（这条测的是本模块的行拼装，转义实现由 utils 自己的用例守）
    const realEsc = sandbox.escapeHtml;
    sandbox.escapeHtml = t => (t == null ? '' : String(t));
    try { return rows(city, idx); } finally { sandbox.escapeHtml = realEsc; }
  })();
  if ((html.match(/data-go=/g) || []).length !== 4) throw new Error('重逢清单行数错（应 3 岛 4 卡）');
  if ((html.match(/>去看</g) || []).length !== 4) throw new Error('每行都要有「去看」');
  if (html.indexOf('波与振动') < 0 || html.indexOf('傅里叶分析') < 0) throw new Error('清单未写画布名');
  if (html.indexOf('同岛还有') < 0) throw new Error('同岛多卡未缩进列出');
  if (html.indexOf('3 天前') < 0) throw new Error('清单未写学习时间');
  if (html.indexOf('data-go="s1" data-item="a1"') < 0) throw new Error('「去看」缺跳转目标');
  // 静态契约：城市弹层 + 复用既有下钻通道（不自建切会话协议）+ 样式
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('_continentCityPopover')) throw new Error('城市弹层缺失');
  if (!src.includes('enterContinentSession(sid, iid)')) throw new Error('「去看」未复用下钻转场');
  if (!src.includes('continent-city')) throw new Error('城市节点类缺失');
  if (!src.includes('画成大陆边')) throw new Error('共享弹层缺「确认落笔」按钮');
  if (!src.includes('_continentFoldedPopover')) throw new Error('折叠清单弹层缺失');
  if (!src.includes('continentWeakBtn')) throw new Error('顶栏折叠入口按钮缺失');
  if (!src.includes('data-link=')) throw new Error('落笔按钮缺失');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-city')) throw new Error('城市样式缺失');
  if (!css.includes('.continent-spoke')) throw new Error('辐条样式缺失');
  if (!css.includes('.continent-pop-place')) throw new Error('重逢清单画布名样式缺失');
  if (!css.includes('.continent-pop-when')) throw new Error('重逢清单时间样式缺失');
  if (!css.includes('.continent-pop-row')) throw new Error('弹层行样式缺失');
  if (!css.includes('.continent-pop-reason')) throw new Error('折叠原因样式缺失');
  if (!css.includes('.continent-tool.is-quiet')) throw new Error('折叠入口样式缺失');
  // 折叠清单行必须写清「为什么被折叠」，否则用户没法判断该不该管它
  const foldedRows = sandbox._continentFoldedRows;
  if (typeof foldedRows !== 'function') throw new Error('_continentFoldedRows 未暴露');
  const foldedHtml = foldedRows(out.folded, idx);
  if (foldedHtml.indexOf('弱证据') < 0) throw new Error('折叠原因未标注');
  if (foldedHtml.indexOf('data-fold="0"') < 0) throw new Error('折叠清单缺逐条入口');
  // 四种折叠原因都要能翻译成人话（用户才知道该不该管它）
  const allReasons = foldedRows([
    { entry: entry, reason: 'weak' },
    { entry: entry, reason: 'capped' },
    { entry: entry, reason: 'map_capped' },
    { entry: entry, reason: 'no_room' },
  ], idx);
  ['弱证据', '超出每对上限', '超出全图上限', '无位可放'].forEach(label => {
    if (allReasons.indexOf(label) < 0) throw new Error('折叠原因缺人话标注：' + label);
  });
  return true;
});

check('graph-continent: 纯布局（空数据合法 / 坐标契约 / 世界尺寸）', () => {
  const layout = sandbox._continentLayoutClusters;
  if (typeof layout !== 'function') throw new Error('_continentLayoutClusters 未暴露');
  const empty = layout([], { w: 1200, h: 800 });
  if (!empty || !(empty.worldW > 0) || !(empty.worldH > 0)) throw new Error('空数据布局非法');
  const out = layout([
    { sessionId: 's1', title: 'A', items: [{ itemId: 'i1' }, { itemId: 'i2' }] },
    { sessionId: 's2', title: 'B', items: [{ itemId: 'i3' }] },
  ]);
  const ids = Object.keys(out.placements);
  if (ids.length !== 3) throw new Error('placements 数量错');
  for (const id of ids) {
    const p = out.placements[id];
    if (!(p.cx > p.x && p.cy > p.y && p.w > 0 && p.h > 0)) throw new Error('中心点/尺寸非法');
  }
  if (out.clusterRects.length !== 2) throw new Error('clusterRects 数量错');
  if (!(out.worldW > 300 && out.worldH > 100)) throw new Error('世界尺寸可疑');
  // 世界尺寸必须真的罩得住所有岛（回归：worldW 曾错用行的累加值 worldW===worldH，
  // 多列布局下世界宽度算小 → 适配画布按假宽度算，地图一开就被裁掉右半边）
  const right = Math.max(...out.clusterRects.map(r => r.x + r.w));
  const bottom = Math.max(...out.clusterRects.map(r => r.y + r.h));
  if (out.worldW < right || out.worldH < bottom) {
    throw new Error('世界尺寸罩不住岛：' + out.worldW + 'x' + out.worldH + ' < ' + right + 'x' + bottom);
  }
  // 3 岛 2 列布局：宽必须大于高（专守上面那个复制粘贴 bug）
  const wide = layout([
    { sessionId: 's1', title: 'A', items: [{ itemId: 'i1' }, { itemId: 'i2' }] },
    { sessionId: 's2', title: 'B', items: [{ itemId: 'i3' }] },
    { sessionId: 's3', title: 'C', items: [{ itemId: 'i4' }, { itemId: 'i5' }, { itemId: 'i6' }] },
  ]);
  if (!(wide.worldW > wide.worldH)) {
    throw new Error('多列布局的世界宽度错（worldW 用了行的累加值）：' + wide.worldW + 'x' + wide.worldH);
  }
  if (wide.worldW < Math.max(...wide.clusterRects.map(r => r.x + r.w))) {
    throw new Error('世界宽度罩不住最右的岛');
  }
  return true;
});

check('graph-continent: 开合冒烟（幂等 + 全程不写存储键）', async () => {
  if (typeof sandbox.openContinentView !== 'function' || typeof sandbox.closeContinentView !== 'function') {
    throw new Error('开合入口未暴露');
  }
  const graphKeys = () => Object.keys(storageData).filter(k => k.indexOf('phymathia_graph_') === 0).length;
  const before = graphKeys();
  sandbox.closeContinentView(); // 未开先关必须幂等
  sandbox.closeContinentView();
  await sandbox.openContinentView(); // 沙箱 fetch 兜底 {} → 失败分支收场，不抛
  sandbox.closeContinentView();
  if (graphKeys() !== before) throw new Error('出现会话图键写入');
  return true;
});


await Promise.all(pendingChecks).catch(() => {});
// 串行边界用例：proxyChatWithModel 需替换全局 fetch，放到全部并发检查结束后单独跑
try {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  const seeded = sandbox.addModelsForProvider('opencode-go', 'sk-group-e2e', 'https://opencode.ai/zen/go/v1', [{ model: 'hy3', label: '混元 Hy3' }]);
  if (seeded !== 1) throw new Error('种入测试条目失败');
  const entry = sandbox.getAllModels().find(m => m.provider === 'opencode-go');
  const cfg = sandbox.getModelById(entry.id);
  if (!cfg || cfg.provider !== 'opencode-go') throw new Error('getModelById 未命中 opencode-go 条目');
  let captured = null;
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  try {
    await sandbox.proxyChatWithModel(cfg, { prompt: 'p' });
  } finally {
    sandbox.fetch = origFetch;
  }
  if (!captured) throw new Error('fetch 未被调用');
  if (captured.body.api_key !== 'sk-group-e2e') throw new Error('请求应携带组密钥，实际 ' + captured.body.api_key);
  if (captured.body.model !== cfg.model) throw new Error('请求 model 与条目不符');
  console.log('✓ model-group：请求边界携带同步后的组密钥');
} catch (e) {
  failed++;
  console.error('❌ model-group：请求边界携带同步后的组密钥 ->', e.message);
}
// 串行边界（依赖替换全局 fetch）：思考程度必须随模型条目走到请求边界；
// 未设置的条目必须发空串（后端零参数，保持现状行为）
try {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  if (sandbox.addModelsForProvider('deepseek', 'sk-think', 'https://api.deepseek.com', [{ model: 'deepseek-chat', label: 'DeepSeek Chat' }, { model: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }]) !== 2) {
    throw new Error('种入测试条目失败');
  }
  const withThinking = sandbox.getAllModels().find(m => m.provider === 'deepseek' && m.name.includes('Chat'));
  sandbox.updateUserModel(withThinking.id, { thinking: 'max' }); // 与配置弹窗「保存」同一写入口
  const withoutThinking = sandbox.getAllModels().find(m => m.provider === 'deepseek' && m.name.includes('Reasoner'));
  const bodies = [];
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  try {
    await sandbox.proxyChatWithModel(sandbox.getModelById(withThinking.id), { prompt: 'p' });
    await sandbox.proxyChatWithModel(sandbox.getModelById(withoutThinking.id), { prompt: 'p' });
  } finally {
    sandbox.fetch = origFetch;
  }
  if (bodies[0].thinking !== 'max') throw new Error('设置的条目应携带 thinking=max，实际 ' + JSON.stringify(bodies[0].thinking));
  if (bodies[1].thinking !== '') throw new Error('未设置的条目应发空串，实际 ' + JSON.stringify(bodies[1].thinking));
  console.log('✓ model-thinking：请求边界携带条目思考程度（未设置为空串）');
} catch (e) {
  failed++;
  console.error('❌ model-thinking：请求边界携带条目思考程度 ->', e.message);
}
check('model-thinking：出题四处自带请求体与配置弹窗下拉就位', () => {
  for (const f of ['src/static/js/quiz-ai.js', 'src/static/js/quiz-ui.js']) {
    const src = fs.readFileSync(f, 'utf8');
    const n = (src.match(/thinking: model\.thinking \|\| ''/g) || []).length;
    if (n !== 2) throw new Error(f + ' 应有 2 处请求体携带 thinking，实际 ' + n);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="mcThinking"')) throw new Error('配置模型弹窗缺「思考程度」下拉');
  return true;
});
check('quiz-relearn：结果页正确率环形图按真实比例（旧版是与分数无关的静态圈）', () => {
  const good = sandbox._quizScoreRingHtml(80, 4, 1);
  if (!good.includes('--p:80')) throw new Error('扇形角度未绑定正确率');
  if (!good.includes('tone-good')) throw new Error('80% 应用绿档');
  if (!good.includes('答对 4') || !good.includes('答错 1')) throw new Error('对/错分段缺失');
  if (!good.includes('aria-label="正确率 80%')) throw new Error('缺无障碍标签');
  const low = sandbox._quizScoreRingHtml(0, 0, 3);
  if (!low.includes('--p:0') || !low.includes('tone-low')) throw new Error('0% 应落在红档且扇形为 0');
  const mid = sandbox._quizScoreRingHtml(60, 3, 2);
  if (!mid.includes('tone-mid')) throw new Error('60% 应落在黄档');
  const clamped = sandbox._quizScoreRingHtml(140, 7, 0);
  if (!clamped.includes('--p:100')) throw new Error('越界分值应夹到 100');
  if (!sandbox._quizScoreRingHtml(Number.NaN, 0, 0).includes('--p:0')) throw new Error('NaN 应兜底为 0');
  // 全局概览：会话卡小环 + 饼图口径说明（旧版饼图标题写「正确率分布」但角度编码的是答题量）
  const mini = sandbox._quizSessionRateRingHtml(45);
  if (!mini.includes('is-mini') || !mini.includes('--p:45') || !mini.includes('tone-low')) {
    throw new Error('会话卡小环未按正确率画');
  }
  const src = fs.readFileSync('src/static/js/quiz-render.js', 'utf8');
  if (!src.includes('各画布答题量占比')) throw new Error('饼图标题未纠正为答题量口径');
  if (!src.includes('已测 ${segment.value} 题')) throw new Error('饼图图例未标注已测题数');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!/conic-gradient/.test(css)) throw new Error('CSS 未用 conic-gradient 画扇形');
  if (!/quizRingSweep/.test(css)) throw new Error('缺扇形填充动画');
  if (!/\.quiz-score-ring\.is-mini/.test(css)) throw new Error('缺小号环样式');
  return true;
});

check('quiz-relearn：引导浮卡的可见倒计时与生命周期（旧版 60 秒无声消失）', () => {
  const uiSrc = fs.readFileSync('src/static/js/quiz-ui.js', 'utf8');
  for (const frag of [
    'QUIZ_RETURN_PILL_TTL',
    'quiz-return-pill-bar',                    // 倒计时条
    'quiz-return-pill-count',                  // 秒数文案
    '悬停暂停',                                 // 悬停暂停提示
    '秒后收起',                                 // 剩余时间文案
    '引导卡已自动收起（60 秒未操作）',            // 自动收起时说明原因
    "document.querySelector('.graph-network-modal-overlay')", // 编辑弹窗打开时暂停
  ]) {
    if (!uiSrc.includes(frag)) throw new Error('浮卡生命周期缺: ' + frag);
  }
  const cssSrc = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!cssSrc.includes('.quiz-return-pill-bar')) throw new Error('CSS 缺倒计时条');
  if (!cssSrc.includes('quizReturnPillIn')) throw new Error('CSS 缺入场动画');
  if (cssSrc.includes('background: var(--accent, #4f8cff);')) throw new Error('旧版纯蓝胶囊样式未移除');
  // 行为：启动倒计时后剩余 = TTL，隐藏后定时器清空（不泄漏）
  const realGetById = sandbox.document.getElementById;
  sandbox.document.getElementById = () => loose('smokePillEl');
  try {
    sandbox.showQuizReturnPill();
    if (vm.runInContext('_quizReturnPillLeft', sandbox) !== 60000) throw new Error('倒计时未从 60 秒起算');
    sandbox.hideQuizReturnPill();
    // 沙箱的 setInterval 桩返回 0（真浏览器返回正数 id）——按「假值」判停止
    if (vm.runInContext('_quizReturnPillTick', sandbox)) throw new Error('隐藏后倒计时应停止');
  } finally {
    sandbox.document.getElementById = realGetById;
  }
  return true;
});

check('graph-contextmenu：菜单视觉层（图标列 + 快捷键提示 + 静态断言）', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  for (const frag of ["iconEl.className = 'graph-context-menu-icon'", 'graph-context-menu-kbd', 'GRAPH_CTX_ICONS', 'GRAPH_CTX_KEYS']) {
    if (!src.includes(frag)) throw new Error('菜单视觉层缺: ' + frag);
  }
  // 图标取自 config.js 的线性图标表；未知键静默留白（不阻断菜单）
  const del = sandbox._graphCtxIconSvg('delete');
  if (!del || !del.includes('<svg')) throw new Error('删除项未取到图标');
  if (sandbox._graphCtxIconSvg('不存在的键') !== '') throw new Error('未知键应留白');
  // GRAPH_CTX_KEYS 是顶层 const（不挂沙箱全局），走词法读取
  if (vm.runInContext('GRAPH_CTX_KEYS.delete', sandbox) !== 'Del') throw new Error('删除项快捷键提示应对齐真实键位');
  if (vm.runInContext('GRAPH_CTX_ICONS.delete', sandbox) !== 'trash') throw new Error('删除项应映射到 trash 图标');
  const cssSrc = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const frag of ['.graph-context-menu-icon', '.graph-context-menu-kbd', 'graphCtxMenuIn', 'backdrop-filter']) {
    if (!cssSrc.includes(frag)) throw new Error('菜单 CSS 缺: ' + frag);
  }
  return true;
});

check('aurora-glass 载体扩编：侧边栏/顶栏/二级栏 + 画布工具栏单胶囊（载体不得自带实底）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const [name, sel] of [
    ['侧边栏', 'class="sidebar aurora-glass aurora-glass--panel"'],
    ['顶栏', 'class="chat-header aurora-glass aurora-glass--panel"'],
    ['二级栏', 'class="header-secondary-bar aurora-glass aurora-glass--panel"'],
  ]) {
    if (!html.includes(sel)) throw new Error(name + '未挂玻璃载体类');
  }
  // 大面积变体：深浅两套 + 更浅的模糊（全高/全宽玻璃每帧重采样整片背景，且可读性优先）
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!/\.aurora-glass--panel \{/.test(css)) throw new Error('缺 --panel 大面积变体');
  if (!/\[data-theme="light"\] \.aurora-glass--panel/.test(css)) throw new Error('--panel 缺浅色一套');
  const panel = css.slice(css.indexOf('.aurora-glass--panel {'), css.indexOf('}', css.indexOf('.aurora-glass--panel {')));
  if (!/blur\(14px\)/.test(panel)) throw new Error('--panel 应比基础档更浅的模糊');
  // 载体自身不得再写 background（简写会重置 background-image 盖掉极光；graph-override 那层特指性最高）
  const strip = (file, sel) => {
    const text = fs.readFileSync(file, 'utf8');
    const i = text.indexOf(sel);
    if (i < 0) return null;
    return text.slice(i, text.indexOf('}', i));
  };
  for (const [file, sel, name] of [
    ['src/static/css/styles.css', '.sidebar {', '侧边栏'],
    ['src/static/css/styles.css', '.chat-header {', '顶栏'],
    ['src/static/css/styles.css', '.header-secondary-bar {', '二级栏'],
    ['src/static/css/styles-panels.css', '    .app-container .chat-header,\n    .app-container .header-secondary-bar {', '顶栏(panels)'],
    ['src/static/css/graph-override.css', '.app-container .chat-header,\n.app-container .header-secondary-bar {', '顶栏(override)'],
  ]) {
    const block = strip(file, sel);
    if (block === null) throw new Error('找不到规则：' + name + ' @ ' + file);
    if (/background(-color)?\s*:/.test(block)) throw new Error(name + ' 仍自带 background，会盖掉极光层');
  }
  // 画布工具栏：整条一个玻璃胶囊；按钮自身透明且无框（描边在 hover/激活态才出现）
  const gi = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!gi.includes("'graph-canvas-toolbar aurora-glass aurora-glass--compact'")) {
    throw new Error('画布工具栏未做成单个玻璃胶囊');
  }
  const gcss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const bar = gcss.slice(gcss.indexOf('.graph-canvas-toolbar {'), gcss.indexOf('}', gcss.indexOf('.graph-canvas-toolbar {')));
  if (!/border-radius:\s*\d+px !important;/.test(bar)) throw new Error('工具栏容器缺圆角（会呈现直角方板）');
  if (!/padding:\s*\d+px !important;/.test(bar)) throw new Error('工具栏容器缺内边距（胶囊会贴边）');
  const btn = gcss.slice(gcss.indexOf('.graph-tool-btn {'), gcss.indexOf('}', gcss.indexOf('.graph-tool-btn {')));
  if (!/background: transparent !important;/.test(btn)) throw new Error('工具按钮应自身透明（磨砂归整条工具栏）');
  if (!/border: 1px solid transparent !important;/.test(btn)) throw new Error('工具按钮默认不该有描边（胶囊内会碎成一格格）');
  // 查看器：双击打开的面板一律封住（含编辑面板），且必须给提示而不是静默无反应
  const vm = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  for (const fn of ['openAddBlankNodeModal', 'editHumanNoteNode', 'editCustomNodeContent', 'editModuleNode']) {
    if (!vm.includes(fn + ':')) throw new Error('查看器未封住双击面板入口：' + fn);
  }
  if (!vm.includes('只读快照：不能添加节点')) throw new Error('查看器封禁面板时缺用户提示');
  return true;
});

check('aurora-glass：极光磨砂玻璃语言（三处共用 + 深浅两套 + 降级）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  for (const frag of [
    '.aurora-glass {',
    '--aurora-1', '--aurora-2', '--aurora-3', '--glass-tint', '--glass-veil',
    'backdrop-filter: blur(18px) saturate(150%)',
    '@keyframes auroraDrift',
    '.aurora-glass--compact',
    'prefers-reduced-motion',                       // 减弱动效：停止漂移
    '@supports not ((backdrop-filter',              // 不支持磨砂时加深底色
  ]) {
    if (!css.includes(frag)) throw new Error('极光玻璃 CSS 缺: ' + frag);
  }
  // 浅色主题必须走应用的暖色系（--bg-panel #faf6ee / --accent #8b6914），不能塞冷蓝紫
  const lightBase = css.slice(
    css.indexOf('html[data-theme="light"] .aurora-glass,'),
    css.indexOf('.aurora-glass--compact {')
  );
  const lightCompact = css.slice(
    css.indexOf('html[data-theme="light"] .aurora-glass--compact'),
    css.indexOf('@keyframes auroraDrift')
  );
  for (const [name, block] of [['基础', lightBase], ['紧凑', lightCompact]]) {
    if (!/rgba\(251, 191, 36,/.test(block)) throw new Error(name + '浅色极光未走暖调（琥珀）');
    // 用户明确否掉浅色的蓝调：冷紫/天蓝/青都不许再出现在浅色极光里
    for (const cold of ['168, 85, 247', '96, 165, 250', '34, 211, 238']) {
      if (block.includes(cold)) throw new Error(name + '浅色极光残留冷色 ' + cold + '，与暖米色主题冲突');
    }
  }
  // 载体自带的 background 简写会重置 background-image 并盖住极光层——
  // .progress-status 就栽在这（用户截图里胶囊没极光），基础规则必须让位
  const baseCapsule = css.slice(css.indexOf('.progress-status {'), css.indexOf('.progress-status.active'));
  if (/background:\s*var\(--panel-bg\)/.test(baseCapsule)) {
    throw new Error('基础 .progress-status 自带 background，会盖住极光层');
  }
  // 三处载体：引导浮卡 / 右键菜单（JS 加类）+ 生成进度胶囊 / 知识面板胶囊（静态 HTML 加类）
  const quizUi = fs.readFileSync('src/static/js/quiz-ui.js', 'utf8');
  if (!quizUi.includes("'quiz-return-pill aurora-glass'")) throw new Error('引导浮卡未挂极光玻璃');
  const menu = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  if (!menu.includes("'graph-context-menu aurora-glass'")) throw new Error('右键菜单未挂极光玻璃');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('class="progress-status aurora-glass aurora-glass--compact"')) throw new Error('进度胶囊未挂极光玻璃');
  if (!html.includes('class="kp-tool-btn aurora-glass aurora-glass--compact"')) throw new Error('知识面板胶囊未挂极光玻璃');
  // 载体自带的底色不能盖住极光层（kp 胶囊踩过这个坑：background-image: inherit 会抹掉渐变）
  const panels = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  const kpRuleRaw = panels.slice(panels.indexOf('.kp-tool-btn.aurora-glass {'), panels.indexOf('.kp-tool-btn.aurora-glass.running'));
  const kpRule = kpRuleRaw.replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里会提到这个坑，断言只看声明
  if (/background-image:\s*inherit/.test(kpRule)) throw new Error('kp 胶囊的 background-image: inherit 会抹掉极光层');
  if (!/background-color:\s*transparent/.test(kpRule)) throw new Error('kp 胶囊需置空自身底色让极光透出');
  // animation 是简写：载体的入场动画必须与 auroraDrift 并列为两项，否则漂移被覆盖掉
  for (const [name, file, key] of [
    ['引导浮卡', 'src/static/css/styles-panels.css', 'quizReturnPillIn'],
    ['右键菜单', 'src/static/css/styles-panels.css', 'graphCtxMenuIn'],
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    const i = src.indexOf(key + ' 0.');
    const block = src.slice(i, src.indexOf('}', i));
    if (!/auroraDrift/.test(block)) throw new Error(name + '的入场动画覆盖了极光漂移（需并列）');
  }
  return true;
});

check('aurora-glass：浅色极光纯暖调（第三轮：连青玉也删掉，禁任何蓝绿）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  // 四档变体各一块浅色极光。切块末端必须落在**下一个变体的深色规则**之前：
  // 若用「下一个浅色选择器」当末端，中间夹着的那档深色声明会被一起吃进来——
  // 第 4 轮新增 --dialog 时基础块就这么把深色 rgba(14,116,233) 吃进来，误判成「浅色有蓝」。
  const lightBlocks = [
    ['基础', css.slice(css.indexOf('/* 浅色模式：白玻璃'), css.indexOf('    .aurora-glass--compact {'))],
    ['紧凑', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--compact,'), css.indexOf('    .aurora-glass--dialog {'))],
    ['弹窗', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--dialog,'), css.indexOf('    .aurora-glass--panel {'))],
    ['大面积', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--panel,'), css.indexOf('@keyframes auroraDrift'))],
  ];
  // 用户否掉的青玉/冷色（45,212,191 青玉、34,211,238 天蓝、96,165,250 冷蓝、168,85,247 冷紫、120,150,220 蓝灰描边）
  const cold = ['45, 212, 191', '34, 211, 238', '96, 165, 250', '168, 85, 247', '120, 150, 220', '13, 148, 136', '8, 145, 178'];
  const hexCold = ['#22d3ee', '#60a5fa', '#a78bfa', '#2dd4bf', '#14b8a6', '#0ea5e9'];
  for (const [name, raw] of lightBlocks) {
    if (!raw) throw new Error(name + '：取不到浅色极光块（选择器被改名？）');
    const block = raw.replace(/\/\*[\s\S]*?\*\//g, ''); // 断言只看声明：注释里会提到被否掉的颜色
    for (const c of [...cold, ...hexCold]) {
      if (block.includes(c)) throw new Error(name + '浅色极光残留冷色/青绿 ' + c + '（用户已两轮否掉蓝绿调）');
    }
    // 三团色斑 + 内描边都必须落在暖色相区间（R > G > B），青绿必然 G > R
    const rgbas = block.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g) || [];
    if (rgbas.length < 3) throw new Error(name + '浅色极光缺色斑声明');
    for (const decl of rgbas) {
      const [r, g, b] = decl.match(/\d+/g).slice(0, 3).map(Number);
      if (g > r && g > b) throw new Error(name + '浅色极光出现绿/青主导色 ' + decl + '（暖调应是 R 最高）');
      if (b > r) throw new Error(name + '浅色极光出现蓝主导色 ' + decl + '（暖调应是 R 最高）');
    }
  }
  // 浅色三团的暖色家族：琥珀（--domain-physics 系）+ 蜜桃 + 暖陶土
  const base = lightBlocks[0][1];
  if (!/rgba\(251, 191, 36,/.test(base)) throw new Error('浅色极光丢了琥珀主色');
  if (!/rgba\(214, 148, 96,/.test(base)) throw new Error('浅色极光第三团未换成暖陶土（青玉已删）');
  return true;
});

check('aurora-glass 载体全覆盖：全部面板/弹窗都挂玻璃（第 4 轮：模型配置等所有面板统一极光磨砂）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const cssAll = {
    'styles.css': fs.readFileSync('src/static/css/styles.css', 'utf8'),
    'styles-panels.css': fs.readFileSync('src/static/css/styles-panels.css', 'utf8'),
    'graph-override.css': fs.readFileSync('src/static/css/graph-override.css', 'utf8'),
  };
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

  // ① 静态载体：index.html 里的面板根元素必须挂 aurora-glass（缺一个就是「还有面板是实底」）
  const carriers = [
    ['模型面板', 'class="model-panel aurora-glass aurora-glass--dialog" id="modelPanel"'],
    ['数据管理面板', 'class="model-panel aurora-glass aurora-glass--dialog" id="dataPanel"'],
    ['难度面板', 'class="level-panel aurora-glass aurora-glass--compact" id="levelPanel"'],
    ['知识面板', 'class="knowledge-panel aurora-glass aurora-glass--panel" id="knowledgePanel"'],
    ['记忆面板', 'class="knowledge-panel memory-panel aurora-glass aurora-glass--panel" id="memoryPanel"'],
    ['添加/配置模型弹窗', 'class="model-dialog model-dialog-add aurora-glass aurora-glass--dialog"'],
    ['模型配置弹窗', 'class="model-dialog aurora-glass aurora-glass--dialog"'],
    ['清除记忆弹窗', 'class="memory-dialog aurora-glass aurora-glass--dialog"'],
    ['收藏弹窗', 'class="bookmark-modal aurora-glass aurora-glass--dialog"'],
    ['苏格拉底弹窗', 'class="socratic-modal aurora-glass aurora-glass--dialog" role="dialog" aria-modal="true" aria-labelledby="socraticModalTitle"'],
    ['追问弹窗', 'class="socratic-modal aurora-glass aurora-glass--dialog" role="dialog" aria-modal="true"'],
    ['知识检测弹窗', 'class="quiz-modal aurora-glass aurora-glass--dialog"'],
    ['节点搜索面板', 'class="graph-search-panel aurora-glass aurora-glass--compact" id="graphSearchPanel"'],
    ['引导浮卡', 'class="onboarding-card aurora-glass aurora-glass--dialog" id="onboardingCard"'],
    ['示例图讲解', 'class="example-guide-dialog aurora-glass aurora-glass--panel"'],
    ['可视化全屏栏', 'class="viz-fullscreen-bar aurora-glass aurora-glass--panel"'],
  ];
  for (const [name, sel] of carriers) {
    if (!html.includes(sel)) throw new Error(name + ' 未挂玻璃载体类（第 4 轮要求全部面板统一极光磨砂）');
  }

  // ② JS 动态建的面板同样挂类（JS 里 className 是整串赋值，漏了就整块实底）
  for (const [file, key, name] of [
    ['src/static/js/graph.js', 'graphHistoryPanel.className = "graph-history-panel aurora-glass aurora-glass--dialog"', '修改历史面板'],
    ['src/static/js/graph.js', 'graphConsistencyPanel.className = "graph-consistency-panel aurora-glass aurora-glass--dialog"', '图体检面板'],
    ['src/static/js/graph-export.js', "menu.className = 'graph-export-menu aurora-glass aurora-glass--dialog'", '导出菜单'],
    ['src/static/js/graph-continent.js', "el.className = 'continent-popover aurora-glass aurora-glass--dialog'", '大陆弹层'],
    ['src/static/js/session.js', "panel.className = 'icon-picker-panel aurora-glass aurora-glass--dialog'", '图标选择面板'],
    // 引导浮卡内容每次重渲都会整串重写 className——漏一处就会退回实底（本处踩过）
    ['src/static/js/ui.js', "card.className = 'onboarding-card aurora-glass aurora-glass--dialog'", '引导浮卡(步骤)'],
    ['src/static/js/ui.js', "card.className = 'onboarding-card ob-welcome aurora-glass aurora-glass--dialog'", '引导浮卡(欢迎页)'],
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(key)) throw new Error(name + ' 未挂玻璃载体类 @ ' + file);
  }

  // ③ 载体自身的规则不得再写实底：background 简写会重置 background-image，
  //    把极光层整块盖掉（同特指性且规则在后时必现）。允许显式 transparent（那是让位）。
  //    这里手写一个极小的 CSS 规则扫描器——正则吃不下「选择器组里夹 {}」这类写法，
  //    而漏判的代价正是这轮修的那批 bug（载体实底把极光整块盖掉）。
  const scanRules = (text, inheritedAt = null) => {
    const out = [];
    // 去注释 + 去字符串（content: "{" 之类），避免把引号里的花括号当块
    const clean = strip(text).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    let i = 0, buf = '';
    while (i < clean.length) {
      const ch = clean[i];
      if (ch === '{') {
        // 找配对的 '}'
        let depth = 1, j = i + 1;
        for (; j < clean.length && depth > 0; j++) {
          if (clean[j] === '{') depth++;
          else if (clean[j] === '}') depth--;
        }
        const body = clean.slice(i + 1, j - 1);
        const selector = buf.trim();
        if (selector.startsWith('@')) out.push(...scanRules(body, selector));
        else out.push({ selector, body, at: inheritedAt });
        buf = '';
        i = j;
      } else if (ch === '}') {
        i++; buf = '';
      } else {
        buf += ch; i++;
      }
    }
    return out;
  };
  const offenders = [];
  const roots = [
    '.model-panel', '.level-panel', '.model-dialog', '.socratic-modal', '.quiz-modal',
    '.bookmark-modal', '.memory-dialog', '.knowledge-panel', '.onboarding-card',
    '.example-guide-dialog', '.viz-fullscreen-bar', '.graph-search-panel', '.graph-export-menu',
    '.graph-history-panel', '.graph-consistency-panel', '.continent-popover', '.icon-picker-panel',
  ];
  for (const [file, css] of Object.entries(cssAll)) {
    for (const { selector, body } of scanRules(css)) {
      if (/^@/.test(selector)) continue; // @media/@supports 外壳，内层规则会被单独扫到
      // 只看「最右一个复合选择器就是载体本身」的规则（如 '.model-panel' / '[data-theme=x] .model-dialog'）：
      // 后代规则（'.socratic-modal textarea'）本来就是内部控件，不属于载体自身的底色
      const lastCompound = selector.split(',').pop().trim().split(/[\s>+~]+/).filter(Boolean).pop() || '';
      const hit = roots.find((root) => new RegExp('(^|[^\\w-])' + root.replace(/\./g, '\\.') + '(?![-\\w])').test(lastCompound));
      if (!hit) continue;
      const decl = body.match(/(?:^|;)\s*background(?:-color|-image)?\s*:\s*([^;]+)/);
      if (!decl) continue;
      const val = decl[1].trim();
      if (val === 'transparent' || val === 'none') continue; // 显式让位
      offenders.push(`${file} 「${selector.replace(/\s+/g, ' ').slice(0, 60)}」 -> background: ${val.slice(0, 48)}`);
    }
  }
  if (offenders.length) {
    throw new Error('载体自带实底会盖掉极光层（须删掉 background 或显式 transparent）：\n  ' + offenders.join('\n  '));
  }
  return true;
});

check('aurora-glass--dialog：表单类弹窗档（深浅两套 + 可读性优先的底色 + 降级）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!/\.aurora-glass--dialog \{/.test(css)) throw new Error('缺 --dialog 弹窗变体');
  if (!/\[data-theme="light"\] \.aurora-glass--dialog/.test(css)) throw new Error('--dialog 缺浅色一套');
  const dialog = css.slice(css.indexOf('.aurora-glass--dialog {'), css.indexOf('}', css.indexOf('.aurora-glass--dialog {')));
  const panel = css.slice(css.indexOf('.aurora-glass--panel {'), css.indexOf('}', css.indexOf('.aurora-glass--panel {')));
  const tintOf = (block) => {
    const m = block.match(/--glass-tint:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)/);
    return m ? Number(m[1]) : NaN;
  };
  // 弹窗里全是表单与密集列表：底色必须比大面积 chrome 更实（可读性优先），否则透出画布会花
  if (!(tintOf(dialog) > tintOf(panel))) {
    throw new Error(`--dialog 底色应比 --panel 更实（弹窗可读性优先），当前 ${tintOf(dialog)} vs ${tintOf(panel)}`);
  }
  if (!/blur\(16px\)/.test(dialog)) throw new Error('--dialog 应是居中的 16px 模糊（基础档 18 / 大面积 14）');
  // 降级：不支持 backdrop-filter 时弹窗底色要更实（比基础档更深），否则文字压在透底上读不清
  const supports = css.slice(css.indexOf('@supports not ((backdrop-filter'), css.indexOf('/* ====== 进度指示器'));
  if (!/\.aurora-glass--dialog \{ --glass-tint: rgba\(9, 13, 30, 0\.9/.test(supports)) {
    throw new Error('降级段缺 --dialog 加深底色');
  }
  if (!/\[data-theme="light"\] \.aurora-glass--dialog,\s*\n\s*\[data-theme="light"\] \.aurora-glass--dialog \{ --glass-tint: rgba\(252, 249, 243, 0\.9/.test(supports)) {
    throw new Error('降级段缺 --dialog 浅色加深底色');
  }
  return true;
});

check('画布工具栏图标：浅色走暖棕墨（不再是近黑，且不低于 4.5:1 对比度）', () => {
  const gcss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const rootBlock = gcss.slice(gcss.indexOf(':root {', gcss.indexOf('@property --graph-edge-glow')), gcss.indexOf('}', gcss.indexOf(':root {', gcss.indexOf('@property --graph-edge-glow'))));
  const lightBlock = gcss.slice(gcss.indexOf('[data-theme="light"] {', gcss.indexOf('--node-glass-base')), gcss.indexOf('}', gcss.indexOf('[data-theme="light"] {', gcss.indexOf('--node-glass-base'))));
  if (!/--graph-tool-ink:\s*#[0-9a-f]{6}/i.test(rootBlock)) throw new Error('缺 --graph-tool-ink（深色一套），图标墨色无法随主题切换');
  const lightInk = (lightBlock.match(/--graph-tool-ink:\s*(#[0-9a-f]{6})/i) || [])[1];
  if (!lightInk) throw new Error('浅色缺 --graph-tool-ink（浅色一套）');
  const btn = gcss.slice(gcss.indexOf('.graph-tool-btn {'), gcss.indexOf('}', gcss.indexOf('.graph-tool-btn {')));
  if (!/color:\s*var\(--graph-tool-ink\)\s*!important/.test(btn)) throw new Error('工具按钮图标未接 --graph-tool-ink');
  // 浅色覆盖层（[data-theme="light"] .graph-tool-btn，特指性高于基础 :hover）只能收窄描边：
  // 一旦在这里写 background / color，就会把 hover 与 .active 的底板、字色一起压掉
  const lightBtn = gcss.slice(gcss.indexOf('[data-theme="light"] .graph-tool-btn {'), gcss.indexOf('}', gcss.indexOf('[data-theme="light"] .graph-tool-btn {')));
  for (const banned of [/background/, /(^|[^-])color\s*:/m]) {
    if (banned.test(lightBtn.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      throw new Error('浅色工具按钮规则写了 background/color，会压掉 :hover 与 .active 的状态样式');
    }
  }
  // hover 底板走主题变量（原来是写死的深墨蓝，浅色下悬停会突兀发黑）
  const hover = gcss.slice(gcss.indexOf('.graph-tool-btn:hover {'), gcss.indexOf('}', gcss.indexOf('.graph-tool-btn:hover {')));
  if (!/background:\s*var\(--btn-active-bg\)/.test(hover)) throw new Error('工具按钮 hover 底板未接主题变量（浅色会发黑）');
  // 对比度：暖棕墨须压在暖米色玻璃上可读（WCAG 相对亮度）
  const lum = (hex) => {
    const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const onGlass = ratio(lightInk, '#f7f2e6'); // 工具栏玻璃胶囊的暖米底色
  if (onGlass < 4.5) throw new Error('浅色图标墨色对比度不足：' + onGlass.toFixed(2) + ':1');
  if (onGlass > 12) throw new Error('浅色图标仍是近黑（对比度 ' + onGlass.toFixed(2) + ':1），与暖米色环境违和');
  const [lr, lg, lb] = [1, 3, 5].map(i => parseInt(lightInk.slice(i, i + 2), 16));
  if (!(lr > lg && lg > lb)) throw new Error('浅色图标墨色不是暖色相（应 R > G > B）');
  return true;
});

// ===== 串行边界：以下用例改共享状态（localStorage 知识/统计键）且会 await，
// 必须放在全部并发检查之后——否则会与在途的 knowledge/quiz 异步用例互相踩键 =====

check('quiz-relearn：quizRetestTopic 全链路（真实检测态按主题组卷，不改全量素材池）', async () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  // 顶层 let（quizSourcePreference/quizState）不是沙箱全局属性，用同 context 的词法读/写访问
  const prevPref = vm.runInContext('quizSourcePreference', sandbox);
  vm.runInContext('quizSourcePreference = "local"', sandbox); // 只走本地出题，不触发 AI 链路
  try {
    await sandbox.openQuiz('session'); // 真实建立 quizState（沙箱 fetch 返回空数据）
    m2SeedQuizStats();
    const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
    stats._meta.wrongQuestions = [m2WrongQuestion()];
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
    const ok = await sandbox.quizRetestTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('重测应返回 true');
    const phase = vm.runInContext('quizState && quizState.phase', sandbox);
    const qlen = vm.runInContext('quizState && quizState.questions ? quizState.questions.length : -1', sandbox);
    const filter = vm.runInContext('typeof quizFilterTopic === "string" ? quizFilterTopic : ""', sandbox);
    const poolLen = vm.runInContext('quizState && quizState.pool ? quizState.pool.knowledge.length : -1', sandbox);
    if (phase !== 'question') throw new Error('应进入答题相位，实际 ' + phase);
    if (qlen < 1) throw new Error('同主题原错题应进卷，实际 ' + qlen);
    if (filter !== M2_TOPIC_KEY) throw new Error('主题过滤未生效：' + filter);
    if (poolLen !== 0) throw new Error('不得改动全量素材池，实际 ' + poolLen);
    // 无素材又无错题的主题：优雅返回 false（不抛错、不改相位）
    const miss = await sandbox.quizRetestTopic(encodeURIComponent('topic-none'));
    if (miss !== false) throw new Error('无素材主题应返回 false');
    const phaseAfter = vm.runInContext('quizState && quizState.phase', sandbox);
    if (phaseAfter !== 'question') throw new Error('查空路径不应改相位，实际 ' + phaseAfter);
  } finally {
    vm.runInContext(`quizSourcePreference = ${JSON.stringify(prevPref)}`, sandbox);
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
  }
  return true;
});

check('quiz-relearn：quizLocateTopic 全链路（主题解析 → 定位内核 → 重学引导带落点）', async () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    kp_hm: { id: 'kp_hm', title: '简谐运动', sessionId: M2_SESSION },
  }));
  m2SeedQuizStats();
  const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
  stats._meta.wrongQuestions = [m2WrongQuestion()];
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  const realGoTo = sandbox.window.goToKnowledgeNode;
  const realLocate = sandbox.window.locateFormulaNode;
  const realGetLast = sandbox.window.getLastLocatedGraphNodeId;
  const calls = [];
  try {
    sandbox.window.goToKnowledgeNode = async (refId) => {
      calls.push({ kind: 'knowledge', refId });
      sandbox._rememberLocatedGraphNode('node_kp_hm'); // 模拟定位内核回填落点
      return true;
    };
    sandbox.window.locateFormulaNode = async (refId) => {
      calls.push({ kind: 'formula', refId });
      return true;
    };
    const ok = await sandbox.quizLocateTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('定位应成功');
    if (!calls.length || calls[0].kind !== 'knowledge' || calls[0].refId !== 'kp_hm') {
      throw new Error('应按错题 sourceRef 走知识点定位，实际 ' + JSON.stringify(calls));
    }
    const ctx = sandbox._quizRelearnCtxGet();
    if (!ctx || ctx.title !== '简谐运动' || ctx.nodeId !== 'node_kp_hm') {
      throw new Error('引导上下文未带标题/落点: ' + JSON.stringify(ctx));
    }
    if (sandbox.window.getLastLocatedGraphNodeId() !== 'node_kp_hm') throw new Error('落点回填未生效');
    if (!sandbox.quizRelearnPillHtml().includes('quizRelearnCreateNote()')) throw new Error('pill 缺引导动作');
    // 公式类主题走公式定位分支
    const fStats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
    fStats._meta.wrongQuestions = [Object.assign(m2WrongQuestion(), {
      id: 'w_f', sourceRef: 'f_zq', sourceType: 'formula', formulaText: 'T=2\\pi\\sqrt{m/k}', topicKey: 'topic-F',
    })];
    fStats.k_f = { title: '弹簧振子周期', correct: 0, wrong: 2, topicKey: 'topic-F', sessionId: M2_SESSION, dueAt: 1 };
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(fStats));
    const okF = await sandbox.quizLocateTopic(encodeURIComponent('topic-F'));
    if (okF !== true) throw new Error('公式主题定位应成功');
    if (!calls.some(c => c.kind === 'formula' && c.refId === 'f_zq')) {
      throw new Error('公式主题应走 locateFormulaNode，实际 ' + JSON.stringify(calls));
    }
    // 未知主题：静默失败，不跳转
    const before = calls.length;
    const miss = await sandbox.quizLocateTopic(encodeURIComponent('topic-none'));
    if (miss !== false || calls.length !== before) throw new Error('未知主题不应触发跳转');
  } finally {
    sandbox.window.goToKnowledgeNode = realGoTo;
    sandbox.window.locateFormulaNode = realLocate;
    if (realGetLast) sandbox.window.getLastLocatedGraphNodeId = realGetLast;
    sandbox.clearQuizRelearnGuide();
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
    sandbox.localStorage.removeItem('phymathia_knowledge');
    sandbox.invalidateKnowledgeCache();
  }
  return true;
});

// 串行段里的异步用例同样进 pendingChecks——必须再收一次，否则断言结果赶不上退出判定
await Promise.all(pendingChecks).catch(() => {});

console.log(failed ? '\n冒烟失败' : '\n前端冒烟全部通过');
process.exit(failed ? 1 : 0);
