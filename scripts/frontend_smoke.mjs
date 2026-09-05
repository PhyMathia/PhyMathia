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

await Promise.all(pendingChecks).catch(() => {});
console.log(failed ? '\n冒烟失败' : '\n前端冒烟全部通过');
process.exit(failed ? 1 : 0);
