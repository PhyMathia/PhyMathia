// 右键菜单（graph-contextmenu）＋导出概览图/海报
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 1025–1598 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
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

check('graph-contextmenu: 节点菜单裁剪（端口统一门 2026-10-10/折叠/删除 + M2 居中/复制节点）', () => {
  const keysFor = (node) => sandbox._graphContextItemsForNode(node).map(i => i.key);
  // draft：无收藏/折叠/端口/复制节点，有居中与删除
  const draft = keysFor({ id: 'd1', kind: 'draft' });
  if (draft.includes('bookmark') || draft.includes('minimize')) return false;
  if (draft.includes('add-input-port') || draft.includes('add-output-port')) return false;
  if (draft.includes('duplicate')) return false;
  if (!draft.includes('delete') || !draft.includes('focus')) return false;
  // source：素材篮（2026-10-22）出口=条目（out-i ↔ items[i]），手加口会打破
  // 索引对应——加口两侧都关（统一门的例外之一；旧口径「有输出端口」随素材篮退役）
  const source = keysFor({ id: 's1', kind: 'source', items: [{}] });
  if (source.includes('add-output-port') || source.includes('add-input-port')) return false;
  if (!source.includes('focus')) return false;
  // 端口机制统一（2026-10-10）：hub/summary 等常驻节点两侧都开放加口
  const hub = keysFor({ id: 'h1', kind: 'hub' });
  if (!hub.includes('add-input-port') || !hub.includes('add-output-port')) return false;
  const summary = keysFor({ id: 'sum1', kind: 'summary' });
  if (!summary.includes('add-input-port') || !summary.includes('add-output-port')) return false;
  // 例外口径：动态出口配方锁出口（输入侧仍开放）；answer 底座配方未声明静态出口同锁（T263）
  const dynRecipe = keysFor({ id: 'm3', kind: 'module', moduleKey: 'physics', messageIndex: -1, content: '内容', recipeId: 'r1', recipe: { ports: { dynamic: { parser: 'numbered_list' } } } });
  if (!dynRecipe.includes('add-input-port') || dynRecipe.includes('add-output-port')) return false;
  const bareAnswerRecipe = keysFor({ id: 'a1', kind: 'answer', manual: true, recipeId: 'r2', recipe: {} });
  if (!bareAnswerRecipe.includes('add-input-port') || bareAnswerRecipe.includes('add-output-port')) return false;
  // module（physics）：输入/输出端口都有；折叠项按 minimized 切换文案（M2 标签统一）
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
  for (const k of ['add-node', 'paste-node', 'paste-clip', 'fit', 'zoom-reset', 'arrange', 'create-group', 'select-all', 'export', 'undo', 'redo']) {
    if (!keys.includes(k)) return false;
  }
  const paste0 = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-node');
  if (paste0.disabled !== true) return false;
  // 「粘贴节点」（ComfyUI 式剪贴板，2026-10-15）：空剪贴板 → 禁用；有载荷 → 可用
  const realReadonly = sandbox.phyIsReadonly; // 沙箱 window 是宽松代理：不打桩 phyIsReadonly() 恒真会把粘贴项锁死
  sandbox.phyIsReadonly = () => false;
  vm.runInContext('graphNodeClipboard = null', sandbox);
  delete storageData['phymathia_node_clipboard'];
  let clip = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-clip');
  if (clip.disabled !== true) return false;
  storageData['phymathia_node_clipboard'] = JSON.stringify({ nodes: [{ oid: 'n1', kind: 'module', moduleKey: 'physics', x: 0, y: 0 }], edges: [], at: 1 });
  vm.runInContext('graphNodeClipboard = null', sandbox); // 逼它走 localStorage 镜像装载
  clip = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-clip');
  if (clip.disabled === true) return false;
  if (String(clip.title || '').indexOf('1 个节点') < 0) return false;
  sandbox.navigator.clipboard.readText = async () => 'E = mc^2';
  const paste1 = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-node');
  const ok = paste1.disabled === false;
  delete sandbox.navigator.clipboard.readText;
  sandbox.phyIsReadonly = realReadonly;
  vm.runInContext('graphNodeClipboard = null', sandbox);
  delete storageData['phymathia_node_clipboard'];
  return ok;
});

check('graph-contextmenu: 撤销/重做禁用态（T365 游标口径：空栈 / 可撤销 / 可重做 / 跨会话目标 / 存档同步）', () => {
  // graphUndoStack/graphHistoryCursor/graphHistoryLive 是打包产物顶层 let（非全局对象属性），
  // 只能经 vm.runInContext 改同一上下文的词法绑定；当前会话经 window.getCurrentSessionId 桩
  sandbox.window.getCurrentSessionId = () => 'sess_ctx';
  const itemOf = (key) => sandbox._graphContextItemsForCanvas().find(i => i.key === key);
  // 1) 栈空：禁用 + title 提示（M2 交付范围 1）
  vm.runInContext("graphHistorySession = 'sess_ctx'; graphUndoStack = []; graphHistoryCursor = 0; graphHistoryLive = null;", sandbox);
  let undo = itemOf('undo');
  let redo = itemOf('redo');
  if (undo.disabled !== true || undo.title !== '没有可撤销的操作') return false;
  if (redo.disabled !== true || redo.title !== '没有可重做的操作') return false;
  // 2) 游标在末尾（停在最新）：撤销可用、重做不可用（没有未来）
  vm.runInContext("graphHistorySession = 'sess_ctx'; graphUndoStack = [{ sessionId: 'sess_ctx', state: {} }]; graphHistoryCursor = 1; graphHistoryLive = null;", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled === true) return false;
  if (redo.disabled !== true || redo.title !== '没有可重做的操作') return false;
  // 2b) 游标在历史中位（时间旅行）：重做可用——下一步是条目，或「最新」锚点
  vm.runInContext("graphHistorySession = 'sess_ctx'; graphUndoStack = [{ sessionId: 'sess_ctx', state: {} }, { sessionId: 'sess_ctx', state: { b: 1 } }]; graphHistoryCursor = 0; graphHistoryLive = null;", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled !== true) return false;   // 游标 0：无可撤销
  if (redo.disabled === true) return false;   // 下一格是条目 1
  vm.runInContext("graphHistorySession = 'sess_ctx'; graphUndoStack = [{ sessionId: 'sess_ctx', state: {} }]; graphHistoryCursor = 0;"
    + "graphHistoryLive = { sessionId: 'sess_ctx', state: { z: 1 } };", sandbox);
  redo = itemOf('redo');
  if (redo.disabled === true) return false;   // 下一格是最新锚点
  // 3) 目标属其他会话：同样禁用（会话一致性守卫，对齐 _undoGraphAction/_redoGraphAction 的 no-op 条件）
  vm.runInContext("graphHistorySession = 'sess_ctx'; graphUndoStack = [{ sessionId: 'sess_other', state: {} }]; graphHistoryCursor = 1; graphHistoryLive = null;", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled !== true || redo.disabled !== true) return false;
  vm.runInContext("graphHistorySession = 'sess_ctx'; graphUndoStack = [{ sessionId: 'sess_other', state: {} }, { sessionId: 'sess_other', state: {} }]; graphHistoryCursor = 0;"
    + "graphHistoryLive = { sessionId: 'sess_other', state: {} };", sandbox);
  redo = itemOf('redo');
  if (redo.disabled !== true) return false;   // 重做目标（锚点）跨会话同样禁用
  // 4) 刚启动/刚切换会话：内存栈为空（或属旧会话）但 localStorage 已有本会话历史——
  //    判读前须先按当前会话同步撤销栈（_undoGraphAction 首行 _ensureGraphHistory 同步），
  //    否则 Ctrl+Z 实际可撤销而菜单误禁用（审查修复回归）
  storageData['phymathia_graph_history_sess_ctx'] = JSON.stringify([
    { sessionId: 'sess_ctx', state: { customNodes: [] }, meta: null },
  ]);
  vm.runInContext("graphHistorySession = 'sess_stale'; graphUndoStack = []; graphHistoryCursor = 0; graphHistoryLive = null;", sandbox);
  undo = itemOf('undo');
  if (undo.disabled === true) return false; // 须装载持久化历史后判可用
  delete storageData['phymathia_graph_history_sess_ctx'];
  vm.runInContext('graphUndoStack = []; graphHistoryCursor = 0; graphHistoryLive = null;', sandbox);
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
    // 单目标项在多选语境隐藏（收藏/复制全文/居中/端口）——复制节点反而是多选主场
    // （2026-10-15 剪贴板化：一次复制整组，含组内连线）
    for (const k of ['bookmark', 'copy', 'focus', 'add-input-port', 'add-output-port']) {
      if (keys.includes(k)) return false;
    }
    if (!keys.includes('duplicate')) return false;
    const dup = items.find(i => i.key === 'duplicate');
    if (dup.label !== '复制 2 个节点') return false;
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

check('graph-contextmenu: 节点右键「追问」复用拖拽链路（T47）', () => {
  const realInner = vm.runInContext('graphInner', sandbox);
  const realCreate = sandbox._createBranchNodeFromOutput;
  vm.runInContext('graphInner = null', sandbox);
  // graphInner 为 null（未初始化/无端口反查）→ 追问项不出现（能力门控不误显）
  const plain = sandbox._graphContextItemsForNode({ id: 'x1', kind: 'module', moduleKey: 'physics' });
  if (plain.some(i => i.key === 'followup')) return false;
  let called = null;
  const portEl = {
    dataset: {
      portId: 'out-2', portType: 'branch', portBranch: 'followup',
      portLabel: encodeURIComponent('追问'), attribute: '',
      portQuestion: '', portLevel: '', portDrag: '',
    },
  };
  const nodeEl = { querySelectorAll: (sel) => (sel === '.graph-output-port' ? [portEl] : []) };
  try {
    sandbox.__smokeFollowupNodeEl = nodeEl;
    vm.runInContext('graphInner = { querySelector: function (s) { return s.indexOf("[data-node-id=") === 0 ? __smokeFollowupNodeEl : null; } };', sandbox);
    sandbox._createBranchNodeFromOutput = (id, portId, meta, x, y) => { called = { id, portId, meta, x, y }; };
    const items = sandbox._graphContextItemsForNode({ id: 'm9', kind: 'module', moduleKey: 'physics' }, { x: 111, y: 222 });
    const fu = items.find(i => i.key === 'followup');
    if (!fu || fu.label !== '追问') return false;
    fu.run();
    if (!called || called.id !== 'm9' || called.portId !== 'out-2') return false;
    if (called.meta.label !== '追问' || called.meta.branchType !== 'followup') return false;
    if (called.x !== 111 || called.y !== 222) return false;
    // 非追问族端口（label 不匹配）不显示该项
    nodeEl.querySelectorAll = (sel) => (sel === '.graph-output-port'
      ? [{ dataset: { portId: 'out-0', portType: 'branch', portLabel: encodeURIComponent('回答练习') } }] : []);
    const items2 = sandbox._graphContextItemsForNode({ id: 'm10', kind: 'module', moduleKey: 'physics' });
    if (items2.some(i => i.key === 'followup')) return false;
    return true;
  } finally {
    sandbox._createBranchNodeFromOutput = realCreate;
    delete sandbox.__smokeFollowupNodeEl;
    vm.runInContext('graphInner = ' + JSON.stringify(realInner === undefined ? null : realInner), sandbox);
  }
});

check('graph history: harnessCheckpoint 相邻去重 roundtrip（T53）', () => {
  if (typeof sandbox._graphHistoryDedupe !== 'function' || typeof sandbox._graphHistoryHydrate !== 'function') {
    throw new Error('_graphHistoryDedupe/_graphHistoryHydrate 未暴露');
  }
  const cp1 = { seq: 1, nodes: { a: { label: 'x' } } };
  const cp2 = { seq: 2, nodes: { a: { label: 'y' } } };
  const arr = [
    { sessionId: 's', state: { customNodes: [], harnessCheckpoint: cp1 }, meta: null },
    { sessionId: 's', state: { customNodes: [], harnessCheckpoint: JSON.parse(JSON.stringify(cp1)) }, meta: null },
    { sessionId: 's', state: { customNodes: [], harnessCheckpoint: cp2 }, meta: null },
    { sessionId: 's', state: { customNodes: [] }, meta: null }, // 无 checkpoint：不参与去重
  ];
  const slim = sandbox._graphHistoryDedupe(arr);
  if (slim.length !== 4) return false;
  if (!slim[0].state.harnessCheckpoint) return false; // 首条保持实体
  if (slim[1].checkpointRef !== true || slim[1].state.harnessCheckpoint !== null) return false; // 相邻相同打引用
  if (!slim[2].state.harnessCheckpoint) return false; // checkpoint 变更回实体
  if (slim[3].checkpointRef) return false; // null 不参与去重
  if (JSON.stringify(arr[1].state.harnessCheckpoint) !== JSON.stringify(cp1)) return false; // 入参不被污染
  // 序列化 → 读回重建：内存态恢复完整
  const back = sandbox._graphHistoryHydrate(JSON.parse(JSON.stringify(slim)));
  const want = JSON.stringify([cp1, cp1, cp2, null]);
  if (JSON.stringify(back.map(x => x.state.harnessCheckpoint)) !== want) return false;
  if (back.some(x => 'checkpointRef' in x)) return false; // 标记不残留
  // 旧格式（无标记）原样通过
  const legacyBack = sandbox._graphHistoryHydrate([{ sessionId: 's', state: { harnessCheckpoint: cp1 }, meta: null }]);
  if (JSON.stringify(legacyBack[0].state.harnessCheckpoint) !== JSON.stringify(cp1)) return false;
  // 引用链实体源被截断（头部砍掉首条）：重建留空不抛错（既有降级）
  const cut = sandbox._graphHistoryHydrate(JSON.parse(JSON.stringify(slim.slice(1))));
  if (cut[0].state.harnessCheckpoint !== null) return false;
  return true;
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
  const wf = fs.readFileSync('src/static/js/graph-events.js', 'utf8');
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

check('graph-contextmenu: M2 语义补强接线（新增项 / 高亮 / 导出锚点 / 多选标题 / 剪贴板复制）静态+行为断言', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  // 节点菜单新增两项：居中此节点（focusGraphNodeById）/ 复制节点（剪贴板化）
  if (!src.includes("focusGraphNodeById(node.id)")) throw new Error('居中此节点缺 focusGraphNodeById 接线');
  if (!src.includes('function graphCopySelectedNodes') || !src.includes('function graphPasteNodeClipboard')) {
    throw new Error('复制/粘贴未落在 graphCopySelectedNodes/graphPasteNodeClipboard 剪贴板链路');
  }
  // 复制节点 run 接线：单选传 [node]、多选传整组；draft 不进剪贴板
  if (!src.includes("run: () => graphCopySelectedNodes([node]),")) throw new Error('节点菜单「复制节点」未接剪贴板入口');
  if (!src.includes("run: () => graphCopySelectedNodes(nodes),")) throw new Error('多选菜单「复制 N 个节点」未接剪贴板入口');
  if (!src.includes("key: 'paste-clip'")) throw new Error('画布菜单缺「粘贴节点」项');
  // 物化取材：answer 派生节点吃整段正文，其余走 _nodeStoredContent
  if (!src.includes('_graphAnswerExpandRaw(node, msg)')) throw new Error('复制取材缺 answer 整段正文分支');
  // localStorage 镜像键名集中一处（phymathia_ 前缀，硬规则 3）
  if (!src.includes("const GRAPH_CLIP_LS_KEY = 'phymathia_node_clipboard';")) throw new Error('剪贴板镜像键缺失或非集中定义');
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
  for (const sym of ['_graphCtxMultiSelection', '_graphContextItemsForMultiNodes', '_graphCtxHistoryUsable', '_graphCtxMarkTarget', '_graphCtxUnmarkTarget',
                     'graphCopySelectedNodes', 'graphPasteNodeClipboard', '_graphClipCount', '_graphClipLoad', '_graphClipSave']) {
    if (!code.includes(sym)) throw new Error('打包产物缺符号: ' + sym);
  }
  if (!code.includes('phymathia_node_clipboard')) throw new Error('打包产物缺剪贴板镜像键');
  // 快捷键接线（graph-events.js 的 _handleGraphKeydown）：Ctrl+C/Ctrl+V 分支 +
  // 文字选择期/输入框放行 + selectMode 早退在前
  const wf = fs.readFileSync('src/static/js/graph-events.js', 'utf8');
  const kh = wf.indexOf('function _handleGraphKeydown');
  if (kh < 0) throw new Error('_handleGraphKeydown 未找到');
  const khBody = wf.slice(kh, wf.indexOf('function _initGraphCanvasEvents'));
  for (const frag of [
    "event.key === 'c' || event.key === 'C'",
    "event.key === 'v' || event.key === 'V'",
    'graphCopySelectedNodes(picked)',
    'graphPasteNodeClipboard(',
    "String(window.getSelection() || '').trim()",
  ]) {
    if (!khBody.includes(frag)) throw new Error('Ctrl+C/Ctrl+V 接线缺: ' + frag);
  }
  const selModeAt = khBody.indexOf('if (graphView.selectMode) return;');
  const copyAt = khBody.indexOf("event.key === 'c' || event.key === 'C'");
  if (selModeAt < 0 || copyAt < 0 || copyAt < selModeAt) {
    throw new Error('复制分支必须排在 selectMode 早退之后（选文字模式不劫持 Ctrl+C）');
  }
  return true;
});

check('graph-contextmenu: 节点剪贴板复制→粘贴 roundtrip（类型/内容/相对布局/组内连线/撤销一步）', () => {
  const realReadonly = sandbox.phyIsReadonly;
  sandbox.phyIsReadonly = () => false;
  vm.runInContext('graphNodeClipboard = null', sandbox);
  delete storageData['phymathia_node_clipboard'];
  const realState = sandbox._graphState;
  const realUndo = sandbox._pushGraphUndo;
  const realSave = sandbox._saveGraphState;
  const realRender = sandbox.renderGraphCanvas;
  const realWorld = sandbox._workflowWorldMessages;
  const realExpandRaw = sandbox._graphAnswerExpandRaw; // 先存原引用：answer 分支要打桩，finally 原样还回去
  let undoCount = 0;
  const state = {
    customNodes: [],
    connections: [
      { from: 'n_a', fromPort: 'out-0', to: 'n_b', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'n_a', fromPort: 'link-0', to: 'n_x', toPort: 'link-0', type: 'custom', custom: true, link: true, label: '有关' },
    ],
  };
  try {
    sandbox._graphState = () => state;
    sandbox._pushGraphUndo = () => { undoCount += 1; };
    sandbox._saveGraphState = () => {};
    sandbox.renderGraphCanvas = () => {};
    sandbox._workflowWorldMessages = () => [{ role: 'assistant', content: '<physics>## 物理视角\n回复力与摆幅成正比。</physics>' }];
    // 复制：两颗节点（module 派生 + knowledge 手填），line-0 两端都在集内 → 带走；
    // 联系线另一端 n_x 不在集内 → 不带
    const copied = sandbox.graphCopySelectedNodes([
      { id: 'n_a', kind: 'module', moduleKey: 'physics', messageIndex: 0, x: 100, y: 40, content: '' },
      { id: 'n_b', kind: 'human_note', messageIndex: -1, label: '简谐运动', content: 'kb 正文', x: 460, y: 40 },
      { id: 'n_draft', kind: 'draft', x: 0, y: 0 },
    ]);
    if (copied !== 2) throw new Error('draft 应被过滤，复制数=2：' + copied);
    let clip = vm.runInContext('graphNodeClipboard', sandbox);
    if (!clip || clip.nodes.length !== 2 || clip.edges.length !== 1) throw new Error('剪贴板载荷形状错');
    if (clip.nodes[0].kind !== 'module' || clip.nodes[0].moduleKey !== 'physics') throw new Error('module 类型/moduleKey 未保留');
    if (!clip.nodes[0].content || clip.nodes[0].content.indexOf('回复力与摆幅成正比') < 0) throw new Error('模块内容未物化：' + clip.nodes[0].content);
    if (clip.nodes[1].label !== '简谐运动' || clip.nodes[1].content !== 'kb 正文') throw new Error('knowledge 未保留');
    // localStorage 镜像：memory → 空后仍可从镜像装载（跨画布/刷新）
    if (!storageData['phymathia_node_clipboard']) throw new Error('localStorage 镜像未写');
    vm.runInContext('graphNodeClipboard = null', sandbox);
    if (sandbox._graphClipCount() !== 2) throw new Error('镜像装载失败');
    // 粘贴：包围盒中心落在光标点，组内相对布局不变
    const pasted = sandbox.graphPasteNodeClipboard({ x: 800, y: 300 });
    if (pasted !== 2) throw new Error('粘贴数=2：' + pasted);
    if (state.customNodes.length !== 2) throw new Error('customNodes 未追加');
    if (undoCount !== 1) throw new Error('整组粘贴只推一次撤销：' + undoCount);
    const [na, nb] = state.customNodes;
    if (na.kind !== 'module' || na.moduleKey !== 'physics' || na.messageIndex !== -1) throw new Error('粘贴节点类型/下标错');
    if (!na.content || na.content.indexOf('回复力与摆幅成正比') < 0) throw new Error('粘贴内容丢失');
    if (na.status !== 'done' || na.generated !== true) throw new Error('粘贴节点应即「完成」态');
    if (nb.kind !== 'human_note' || nb.label !== '简谐运动') throw new Error('human_note 粘贴形态错');
    // 原跨度 x 100..460（中心 280）、y 同为 40（中心 40）→ 平移 (+520, +260)
    if (na.x !== 620 || nb.x !== 980 || na.y !== 300 || nb.y !== 300) {
      throw new Error('相对布局/落点错：' + JSON.stringify({ ax: na.x, bx: nb.x, ay: na.y, by: nb.y }));
    }
    // 组内连线重映射：旧 from/to 换成新 id，port 与 type 原样
    const remapped = state.connections.filter(e => e.from === na.id && e.to === nb.id);
    if (remapped.length !== 1 || remapped[0].fromPort !== 'out-0' || remapped[0].custom !== true) throw new Error('组内连线未重映射');
    if (state.connections.length !== 3) throw new Error('集外联系线不应带入：' + state.connections.length);
    // answer 非 manual 复制：analysis/content 双写（渲染取 analysis，_nodeStoredContent 取 content）
    state.customNodes.length = 0;
    sandbox._graphAnswerExpandRaw = (node, msg) => String((msg && msg.content) || '') + '｜展开全文';
    sandbox._workflowWorldMessages = () => [{ role: 'assistant', content: '<summary>一句话</summary>分析正文……' }];
    sandbox.graphCopySelectedNodes([{ id: 'n_ans', kind: 'answer', messageIndex: 0, x: 0, y: 0 }]);
    sandbox.graphPasteNodeClipboard({ x: 500, y: 500 });
    const ans = state.customNodes[0];
    if (ans.kind !== 'answer' || ans.manual !== false) throw new Error('answer 复制形态错');
    if (ans.content !== '<summary>一句话</summary>分析正文……｜展开全文') throw new Error('answer 未吃整段正文');
    if (ans.analysis !== ans.content) throw new Error('answer 非 manual 卡应在 analysis 双写');
    // 只读查看页：粘贴被禁断（菜单项被 viewer 白名单剪掉，快捷键入口在此设防）
    sandbox.phyIsReadonly = () => true;
    const before = state.customNodes.length;
    const blocked = sandbox.graphPasteNodeClipboard({ x: 0, y: 0 });
    if (blocked !== 0 || state.customNodes.length !== before) throw new Error('只读页粘贴未被禁断');
    return true;
  } finally {
    sandbox._graphState = realState;
    sandbox._pushGraphUndo = realUndo;
    sandbox._saveGraphState = realSave;
    sandbox.renderGraphCanvas = realRender;
    sandbox._workflowWorldMessages = realWorld;
    sandbox._graphAnswerExpandRaw = realExpandRaw;
    sandbox.phyIsReadonly = realReadonly;
    vm.runInContext('graphNodeClipboard = null', sandbox);
    delete storageData['phymathia_node_clipboard'];
  }
});

check('graph-contextmenu: 复制补捕 AI 结构边＋粘贴物化为普通连线（T343）', () => {
  const realReadonly = sandbox.phyIsReadonly;
  sandbox.phyIsReadonly = () => false;
  vm.runInContext('graphNodeClipboard = null', sandbox);
  delete storageData['phymathia_node_clipboard'];
  const realState = sandbox._graphState;
  const realUndo = sandbox._pushGraphUndo;
  const realSave = sandbox._saveGraphState;
  const realRender = sandbox.renderGraphCanvas;
  const realWorld = sandbox._workflowWorldMessages;
  const state = { customNodes: [], connections: [] };
  try {
    sandbox._graphState = () => state;
    sandbox._pushGraphUndo = () => {};
    sandbox._saveGraphState = () => {};
    sandbox.renderGraphCanvas = () => {};
    sandbox._workflowWorldMessages = () => [];
    // 视图边＝_resolveGraphEdges 合并产物：前三条是消息派生结构边（不带 custom 标记），
    // 模拟「问题→问题分析→两模块」；第四条一端在集外不带；第五条带 custom 标记
    // ＝connections 成员（补捕必须跳过，否则与 connections 路径重复收）
    vm.runInContext("graphView.edges = [\n" +
      "  { from: 'u1', to: 'a1', type: 'primary', fromPort: 'out-0', toPort: 'in-0' },\n" +
      "  { from: 'a1', to: 'm1', type: 'primary', fromPort: 'out-0', toPort: 'in-0' },\n" +
      "  { from: 'a1', to: 'm2', type: 'primary', fromPort: 'out-1', toPort: 'in-0' },\n" +
      "  { from: 'm1', to: 'n_out', type: 'primary', fromPort: 'out-0', toPort: 'in-0' },\n" +
      "  { from: 'u1', to: 'a1', type: 'custom', custom: true, fromPort: 'out-0', toPort: 'in-0' },\n" +
      "]", sandbox);
    const copied = sandbox.graphCopySelectedNodes([
      { id: 'u1', kind: 'user', messageIndex: -1, x: 0, y: 0, content: '什么是简谐运动？' },
      { id: 'a1', kind: 'answer', messageIndex: -1, x: 200, y: 0, content: '分析' },
      { id: 'm1', kind: 'module', moduleKey: 'physics', messageIndex: -1, x: 400, y: -100, content: '物理' },
      { id: 'm2', kind: 'module', moduleKey: 'math', messageIndex: -1, x: 400, y: 100, content: '数学' },
    ]);
    if (copied !== 4) throw new Error('复制数=4：' + copied);
    const clip = vm.runInContext('graphNodeClipboard', sandbox);
    if (!clip || clip.edges.length !== 3) {
      throw new Error('结构边应补捕 3 条（集外/custom 不带）：' + JSON.stringify(clip && clip.edges));
    }
    // 粘贴：结构边物化成普通连线，id 重映射、端口与 type 原样（primary 保 320 弹簧张力）
    const pasted = sandbox.graphPasteNodeClipboard({ x: 1000, y: 500 });
    if (pasted !== 4) throw new Error('粘贴数=4：' + pasted);
    if (state.connections.length !== 3) throw new Error('物化连线应 3 条：' + state.connections.length);
    const [pu, pa, pm1, pm2] = state.customNodes;
    const findEdge = (from, to) => state.connections.find(e => e.from === from.id && e.to === to.id);
    const eUA = findEdge(pu, pa);
    if (!eUA || eUA.type !== 'primary' || eUA.fromPort !== 'out-0' || eUA.toPort !== 'in-0') {
      throw new Error('问题→问题分析 边未物化：' + JSON.stringify(eUA));
    }
    const eAM2 = findEdge(pa, pm2);
    if (!eAM2 || eAM2.type !== 'primary' || eAM2.fromPort !== 'out-1') {
      throw new Error('问题分析→math 边未保 out-1：' + JSON.stringify(eAM2));
    }
    if (!findEdge(pa, pm1)) throw new Error('问题分析→physics 边丢失');
    return true;
  } finally {
    sandbox._graphState = realState;
    sandbox._pushGraphUndo = realUndo;
    sandbox._saveGraphState = realSave;
    sandbox.renderGraphCanvas = realRender;
    sandbox._workflowWorldMessages = realWorld;
    sandbox.phyIsReadonly = realReadonly;
    vm.runInContext('graphView.edges = []', sandbox);
    vm.runInContext('graphNodeClipboard = null', sandbox);
    delete storageData['phymathia_node_clipboard'];
  }
});

check('graph-contextmenu: 粘贴端口钳制——附加口自长、顺延避让、hub 同口多线、非标口原样（T344）', () => {
  const realReadonly = sandbox.phyIsReadonly;
  sandbox.phyIsReadonly = () => false;
  vm.runInContext('graphNodeClipboard = null', sandbox);
  vm.runInContext('graphView.edges = []', sandbox);
  delete storageData['phymathia_node_clipboard'];
  const realState = sandbox._graphState;
  const realUndo = sandbox._pushGraphUndo;
  const realSave = sandbox._saveGraphState;
  const realRender = sandbox.renderGraphCanvas;
  const state = { customNodes: [], connections: [] };
  try {
    sandbox._graphState = () => state;
    sandbox._pushGraphUndo = () => {};
    sandbox._saveGraphState = () => {};
    sandbox.renderGraphCanvas = () => {};
    // 直接塞剪贴板（粘贴侧隔离验证）：B 原有附加输入口 in-1；J 是 junction（同口多线
    // 合法）；N 是 note（基础出口 0）；A 落 in-0 不应长附加口；link-N 非标口原样
    storageData['phymathia_node_clipboard'] = JSON.stringify({
      nodes: [
        { oid: 'A', kind: 'module', moduleKey: 'physics', x: 0, y: 0 },
        { oid: 'B', kind: 'answer', x: 200, y: 0 },
        { oid: 'J', kind: 'junction', x: 400, y: 0 },
        { oid: 'N', kind: 'note', x: 600, y: 0 },
      ],
      edges: [
        { from: 'A', to: 'B', fromPort: 'out-0', toPort: 'in-1', type: 'custom' },
        { from: 'A', to: 'B', fromPort: 'out-1', toPort: 'in-1', type: 'custom' },
        { from: 'A', to: 'J', fromPort: 'out-0', toPort: 'in-0', type: 'custom' },
        { from: 'B', to: 'J', fromPort: 'out-0', toPort: 'in-0', type: 'custom' },
        { from: 'N', to: 'B', fromPort: 'out-3', toPort: 'in-0', type: 'custom' },
        { from: 'N', to: 'A', fromPort: 'link-0', toPort: 'link-0', type: 'custom', link: true, label: '有关' },
      ],
      at: 1,
    });
    const pasted = sandbox.graphPasteNodeClipboard({ x: 0, y: 0 });
    if (pasted !== 4) throw new Error('粘贴数=4：' + pasted);
    const [pa, pb, pj, pn] = state.customNodes;
    if (pb.inputPortCounts !== 2) throw new Error('answer 附加输入口应长到 2：' + pb.inputPortCounts);
    if (pa.inputPortCounts !== undefined) throw new Error('in-0 落口不应长附加口：' + pa.inputPortCounts);
    if (pj.inputPortCounts !== undefined) throw new Error('junction 同口多线不应长口：' + pj.inputPortCounts);
    if (pn.portCounts !== 4) throw new Error('note 出口应长到 4（绝对口径）：' + pn.portCounts);
    const bPorts = state.connections.filter(e => e.to === pb.id).map(e => e.toPort).sort();
    if (bPorts.join(',') !== 'in-0,in-1,in-2') throw new Error('B 落口应为 in-0/in-1/in-2：' + bPorts.join(','));
    const jPorts = state.connections.filter(e => e.to === pj.id).map(e => e.toPort);
    if (jPorts.length !== 2 || jPorts.some(p => p !== 'in-0')) throw new Error('junction 两条应同落 in-0：' + jPorts.join(','));
    const lk = state.connections.find(e => e.link);
    if (!lk || lk.fromPort !== 'link-0' || lk.toPort !== 'link-0' || lk.label !== '有关') {
      throw new Error('联系线非标口应原样落：' + JSON.stringify(lk));
    }
    return true;
  } finally {
    sandbox._graphState = realState;
    sandbox._pushGraphUndo = realUndo;
    sandbox._saveGraphState = realSave;
    sandbox.renderGraphCanvas = realRender;
    sandbox.phyIsReadonly = realReadonly;
    vm.runInContext('graphView.edges = []', sandbox);
    vm.runInContext('graphNodeClipboard = null', sandbox);
    delete storageData['phymathia_node_clipboard'];
  }
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

check('graph-poster: 缩略知识海报纯函数（纯文本/标题摘要/断行/锚点/布局过滤）', () => {
  const dbg = sandbox.window.graphPosterDebug;
  if (!dbg || typeof dbg.layout !== 'function') throw new Error('graphPosterDebug 未暴露');
  // 纯文本：代码块按语言给占位说明、模块标签/井号/星号剥除、$ 定界符剥壳
  const plain = dbg.plainText('<physics>## 动量守恒\n$mv=MV$ 与 **碰撞**</physics>\n```html\n<div/>\n```');
  if (plain.includes('$') || plain.includes('#') || plain.includes('```') || plain.includes('*')) {
    throw new Error('纯文本仍带标记：' + plain);
  }
  if (!plain.includes('动量守恒') || !plain.includes('mv=MV') || !plain.includes('交互可视化')) {
    throw new Error('纯文本丢内容：' + plain);
  }
  // 标题摘要：首行为题、截断余量并入摘要（整段无换行文本不许被标题吃光）、more 记原始长度
  const ts = dbg.titleSummary('第一行标题很长\n第二行内容继续\n第三行', 6, 10);
  if (ts.title !== '第一行标题…') throw new Error('标题截断错误：' + ts.title);
  if (!ts.summary.endsWith('…') || ts.summary.length !== 10) throw new Error('摘要截断错误：' + ts.summary);
  if (!ts.summary.startsWith('很长')) throw new Error('标题截断余量应并入摘要：' + ts.summary);
  if (ts.more !== 14) throw new Error('more 应记原始长度 14：' + ts.more);
  // 单行整段（AI 摘要的真实形态）：标题吃前 26 字，摘要是余下内容而非空
  const ts2 = dbg.titleSummary('单摆在小角度时回复力是线性的因此做简谐运动而且周期与摆幅无关这就是等时性', 26, 40);
  if (!ts2.title.endsWith('…')) throw new Error('长单行应有省略号：' + ts2.title);
  if (!ts2.summary) throw new Error('单行整段文本的摘要不能为空（被标题吃光）');
  // LaTeX 轻转换：常见命令转可读符号，不是源码
  const lt = dbg.plainText('周期 $T = 2\\pi\\sqrt{L/g}$ 与 $\\ddot{\\theta} + \\omega\\theta$');
  if (lt.includes('\\pi') || lt.includes('\\theta') || lt.includes('\\sqrt') || lt.includes('\\ddot')) {
    throw new Error('LaTeX 源码未转换：' + lt);
  }
  if (!lt.includes('π') || !lt.includes('θ') || !lt.includes('√')) throw new Error('希腊字母/根号缺失：' + lt);
  // 嵌套 \frac（\lambda 在参数里还有 {}）也必须转——定点迭代
  const lt2 = dbg.plainText('$P(X=k)=\\frac{\\lambda^k e^{-\\lambda}}{k!}$');
  if (lt2.includes('\\frac') || lt2.includes('\\lambda')) throw new Error('嵌套 frac 未转换：' + lt2);
  if (!lt2.includes('λ') || !lt2.includes('/(k!)')) throw new Error('嵌套 frac 应转 (…)/(k!)：' + lt2);
  // mermaid 代码块：提取节点文本当摘要（知识图谱卡显示概念词，不是占位词）
  const mm = dbg.plainText('```mermaid\ngraph TD\nA[泊松分布] --> B[稀疏事件]\nB --> C[计数分布]\n```');
  if (!mm.includes('泊松分布') || !mm.includes('稀疏事件') || mm.includes('graph TD')) {
    throw new Error('mermaid 节点文本未提取：' + mm);
  }
  // 断行：等宽假 measure（每字符 10px），50px 预算 → 每行 5 字符，两行封顶加省略
  const lines = dbg.wrapLines((t) => t.length * 10, 'aaa bbb ccc', 50, 2);
  if (lines.length !== 2 || !lines[1].endsWith('…')) throw new Error('断行错误：' + JSON.stringify(lines));
  // 矩形锚点：右向射线交右边界、上向射线交上边界
  let p = dbg.rectAnchor(0, 0, 100, 50, 200, 0);
  if (Math.abs(p.x - 50) > 0.01 || Math.abs(p.y) > 0.01) throw new Error('右边界锚点错误：' + JSON.stringify(p));
  p = dbg.rectAnchor(0, 0, 100, 50, 0, -100);
  if (Math.abs(p.x) > 0.01 || Math.abs(p.y + 25) > 0.01) throw new Error('上边界锚点错误：' + JSON.stringify(p));
  // 布局：分层紧凑网格——draft/hidden 节点滤除、其边一并滤除；下游节点落在更深层；
  // 卡高按内容自适应（有摘要的卡更高）；标题剥「物理视角：」重复前缀；
  // 手工 answer 节点内容在 analysis 字段也要取到（_nodeContent 不看它，实测踩过）
  const layout = dbg.layout({
    nodes: [
      { id: 'a', kind: 'user', isRoot: true, x: 0, y: 0, w: 260, h: 140, messageIndex: 0 },
      { id: 'b', kind: 'module', moduleKey: 'physics', x: 500, y: 0, w: 260, h: 140,
        content: '物理视角：单摆的回复力与摆幅正弦近似成正比，小角度下为线性回复力，因此做简谐运动，周期与摆幅无关这就是等时性。' },
      { id: 'd', kind: 'draft', x: 250, y: 0, w: 260, h: 140, label: '草稿' },
      { id: 'h', kind: 'user', hidden: true, x: -500, y: -500, w: 260, h: 140, label: '隐藏' },
      { id: 'an', kind: 'answer', x: 250, y: 300, w: 260, h: 140, messageIndex: -1,
        analysis: 'AI 回答正文在 analysis 字段（非 manual 生成节点的实际存储位置），海报必须取到。' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'an' }, { from: 'a', to: 'd' }, { from: 'a', to: 'h' }],
    groups: [
      { x: -50, y: -50, width: 700, height: 300, name: '组', color: '#38bdf8', nodeIds: ['a', 'b'] },
      { x: 0, y: 0, width: 100, height: 100, name: '空组', nodeIds: ['d'] },
    ],
  });
  if (!layout) throw new Error('布局返回空');
  if (layout.cards.length !== 3) throw new Error('draft/hidden 节点应被滤除：' + layout.cards.length);
  if (layout.edges.length !== 2) throw new Error('指向已滤除节点的边应被滤除：' + layout.edges.length);
  if (layout.groups.length !== 1) throw new Error('无成员分组应被丢弃：' + layout.groups.length);
  const cardA = layout.cards.find((c) => c.id === 'a');
  const cardB = layout.cards.find((c) => c.id === 'b');
  const cardAn = layout.cards.find((c) => c.id === 'an');
  if (cardB.attrLabel !== '物理视角') throw new Error('模块节点属性标签错误：' + cardB.attrLabel);
  if (!cardB.title.startsWith('单摆的回复力')) throw new Error('标题应剥「物理视角：」前缀取正文首句：' + cardB.title);
  if (!cardB.summary) throw new Error('模块卡摘要不应为空');
  if (!(cardB.w >= 240 && cardB.w <= 300)) throw new Error('分层网格卡宽应统一：' + cardB.w);
  if (!(cardA.cy < cardB.cy && cardA.cy < cardAn.cy)) throw new Error('下游节点应在更深层（cy 递增）');
  if (!(cardB.h > cardA.h)) throw new Error('有摘要的卡应更高（自适应）：' + cardB.h + ' vs ' + cardA.h);
  if (!cardAn.summary) {
    throw new Error('analysis 字段取文回退失败（摘要为空）：' + cardAn.title);
  }
  // a 行只有一张卡应居中
  if (Math.abs(cardA.cx - layout.width / 2) > 1) throw new Error('单卡行应水平居中：' + cardA.cx);
  // 同层同行：两者共享同一行 y（顶对齐）、按原画布 x 排序、内容多者更高
  const layout2 = dbg.layout({
    nodes: [
      { id: 'a', kind: 'user', isRoot: true, x: 0, y: 0, w: 260, h: 140, messageIndex: 0 },
      { id: 'm1', kind: 'module', moduleKey: 'physics', x: 300, y: 100, w: 260, h: 140,
        content: '物理视角：内容一的内容一的内容一的内容一的内容一的内容一的内容一的内容一的内容一。' },
      { id: 'm2', kind: 'module', moduleKey: 'math', x: 900, y: -60, w: 260, h: 140, content: '数学视角：短内容' },
    ],
    edges: [{ from: 'a', to: 'm1' }, { from: 'a', to: 'm2' }],
    groups: [],
  });
  const M1 = layout2.cards.find((c) => c.id === 'm1');
  const M2 = layout2.cards.find((c) => c.id === 'm2');
  if (M1.y !== M2.y) throw new Error('同层节点应对齐同一行（顶对齐）：' + M1.y + ' vs ' + M2.y);
  if (!(M1.cx < M2.cx)) throw new Error('同层内应按原画布 x 排序');
  if (!(M1.h > M2.h)) throw new Error('同行内内容多的卡应更高：' + M1.h + ' vs ' + M2.h);
  // 边端点必须落在卡片矩形边界上（锚点裁剪生效）
  const e = layout.edges[0];
  if (Math.abs(Math.abs(e.x1 - cardA.cx) - cardA.w / 2) > 0.01 && Math.abs(Math.abs(e.y1 - cardA.cy) - cardA.h / 2) > 0.01) {
    throw new Error('边起点未锚到卡片边界');
  }
  return true;
});

check('graph-poster: 导出接线（菜单海报段 + 主包/查看器双注册）', () => {
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!ge.includes('data-poster-scale')) throw new Error('导出菜单缺海报倍数行');
  if (!ge.includes('exportGraphPoster')) throw new Error('菜单未接海报导出');
  if (!ge.includes('graphExportHtml')) throw new Error('导出菜单缺单文件网页入口');
  if (!ge.includes("typeof window.exportUtopiaStandaloneHtml === 'function'")) {
    throw new Error('单文件网页入口必须按模块可用性守卫（查看器包不显示该行）');
  }
  // 一键预览行：主应用显示、查看器（window.__UTOPIA__ 存在）不渲染；接 previewUtopiaInViewer
  if (!ge.includes('graphExportPreview')) throw new Error('导出菜单缺「在查看器中预览」行');
  if (!ge.includes('previewUtopiaInViewer')) throw new Error('预览行未接 previewUtopiaInViewer');
  const previewGuard = ge.slice(ge.indexOf('graphExportPreview') - 200, ge.indexOf('graphExportPreview'));
  if (!previewGuard.includes('__UTOPIA__')) throw new Error('预览行必须按查看器环境守卫（查看器里不该再显示预览入口）');
  if (typeof sandbox.window.previewUtopiaInViewer !== 'function') throw new Error('主包未暴露 previewUtopiaInViewer');
  const u = fs.readFileSync('src/static/js/utopia.js', 'utf8');
  if (!/previewUtopiaInViewer[\s\S]{0,900}buildUtopiaSnapshot/.test(u) && !u.includes('_utopiaOpenHandoffViewer(snapshot)')) {
    throw new Error('预览应现建快照（不依赖「刚导出过」的缓存）');
  }
  if (typeof sandbox.window.exportGraphPoster !== 'function') throw new Error('主包未暴露 exportGraphPoster');
  const bf = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  const bv = fs.readFileSync('scripts/build_viewer.mjs', 'utf8');
  if (!bf.includes("'graph-poster.js'")) throw new Error('主包缺 graph-poster.js');
  if (!bv.includes("'graph-poster.js'")) throw new Error('查看器包缺 graph-poster.js（查看器再导出同样可选海报）');
  if (bv.includes("'utopia-import.js'") || bv.includes("'utopia-html.js'")) {
    throw new Error('导入/单文件导出是主应用能力，不该进只读查看器包');
  }
  return true;
});

// ===== 分组 × 自动整理：成员归属稳定性（2026-10-16 用户实测「多次整理后节点莫名进出组」）=====
check('canvas 分组: 多次自动整理成员不漂移（不吞人不掉组）且组框随整理落档', () => {
  const run = (js) => vm.runInContext(js, sandbox);
  // 存档打桩：沙箱无真 DOM、session.js 初始化没跑，现搭一个最小存储让 _graphState 可用
  const realGet = sandbox.window.getGraphState;
  const realSave = sandbox.window.saveGraphState;
  const realSid = sandbox.window.getCurrentSessionId;
  const snapshot = run(`JSON.stringify({
    nodes: graphView.nodes, edges: graphView.edges, groups: graphView.groups,
    nodeById: graphView.nodeById, selectedNodeIds: [...graphView.selectedNodeIds],
    selectedGroupIds: [...graphView.selectedGroupIds],
  })`);
  try {
    run(`
      window.__grpStore = {};
      window.getCurrentSessionId = () => 'smoke-grp';
      window.getGraphState = (sid) => {
        if (!window.__grpStore[sid]) window.__grpStore[sid] = _normalizeGraphState(null);
        return { ...window.__grpStore[sid] };
      };
      window.saveGraphState = (sid, state) => { window.__grpStore[sid] = state; };
      graphView.nodes = []; graphView.edges = []; graphView.groups = [];
      graphView.nodeById = {}; graphView.selectedNodeIds = new Set(); graphView.selectedGroupIds = new Set();
      const mk = (id, kind, x, y, w, h, ts) => {
        const n = { id, kind, label: id, x, y, w, h, timestamp: ts, depth: 0, isRoot: false };
        graphView.nodes.push(n); graphView.nodeById[id] = n; return n;
      };
      const root = mk('q', 'question', 0, 0, 300, 140, 't0'); root.isRoot = true;
      for (let i = 0; i < 4; i++) {
        const pfx = 'm' + i;
        const n = mk(pfx, 'physics', 700, (i - 1.5) * 1100, 340, 220, 't' + i); n.depth = 1;
        graphView.edges.push({ from: 'q', to: pfx, type: 'primary' });
        for (let k = 0; k < 5; k++) {
          const c = mk(pfx + '-f' + k, 'followup', 1400 + (k % 2) * 120, (i - 1.5) * 1100 + (k - 2) * 330, 240, 160, 't' + pfx + k);
          c.depth = 2; graphView.edges.push({ from: pfx, to: c.id, type: 'primary' });
        }
      }
      // 用户只框了 m0 与它的前两颗追问；同列 m0-f2/m0-f3 仍应是自由节点
      const ids = ['m0', 'm0-f0', 'm0-f1'];
      const b = _graphGroupBounds(ids);
      graphView.groups = [{ id: 'grp', name: 'g1', color: 'c', nodeIds: ids, x: b.x, y: b.y, width: b.width, height: b.height }];
      _saveGraphState(Object.assign(_graphState(), { groups: graphView.groups.map(g => ({ ...g })) }));
    `);
    const seq = [];
    for (let round = 0; round < 3; round++) {
      run('autoArrangeGraph()');
      seq.push(run('JSON.stringify(graphView.groups[0].nodeIds)'));
      // 整理后的组框/成员必须落档：重渲（renderGraphCanvas:149）按存档重建 graphView.groups，
      // 只存 positions 会把整理前的旧框当现役框，成员随即被整批置换
      const saved = JSON.parse(run('JSON.stringify((_graphState().groups || [])[0] || null)'));
      const live = JSON.parse(run('JSON.stringify(graphView.groups[0])'));
      if (!saved) throw new Error('整理后存档里没有分组');
      if (saved.x !== live.x || saved.y !== live.y || saved.width !== live.width || saved.height !== live.height
        || JSON.stringify(saved.nodeIds) !== JSON.stringify(live.nodeIds)) {
        throw new Error('整理后的组框/成员没落档：存档 ' + JSON.stringify(saved) + ' vs 实际 ' + JSON.stringify(live));
      }
      // 成员必须整块留在组框内（整理把成员当原子块搬）
      const escaped = JSON.parse(run(`JSON.stringify(graphView.groups[0].nodeIds.filter(id => {
        const n = graphView.nodes.find(x => x.id === id);
        const g = graphView.groups[0];
        return !(n.x - n.w / 2 >= g.x - 0.01 && n.y - n.h / 2 >= g.y - 0.01
          && n.x + n.w / 2 <= g.x + g.width + 0.01 && n.y + n.h / 2 <= g.y + g.height + 0.01);
      }))`));
      if (escaped.length) throw new Error('成员被整理搬出组框：' + JSON.stringify(escaped));
      // 模拟一次重渲：按存档重建 + _measureNodes 收尾的包含同步
      run(`graphView.groups = (_graphState().groups || []).map(g => ({...g}))`);
      run('_syncGroupMembersByContainment()');
    }
    if (!(seq[0] === seq[1] && seq[1] === seq[2])) {
      throw new Error('成员随整理次数漂移：' + seq.join(' → '));
    }
    if (seq[0] !== '["m0","m0-f0","m0-f1"]') {
      throw new Error('分组吞入了用户没框选的节点（同列兄弟被静默吸进组）：' + seq[0]);
    }
    return true;
  } finally {
    const prev = JSON.parse(snapshot);
    run(`graphView.nodes = ${JSON.stringify(prev.nodes.filter(Boolean))};`);
    run(`graphView.edges = ${JSON.stringify(prev.edges)};`);
    run(`graphView.groups = ${JSON.stringify(prev.groups)};`);
    run(`graphView.nodeById = ${JSON.stringify(prev.nodeById || {})};`);
    run(`graphView.selectedNodeIds = new Set(${JSON.stringify(prev.selectedNodeIds || [])});`);
    run(`graphView.selectedGroupIds = new Set(${JSON.stringify(prev.selectedGroupIds || [])});`);
    run('delete window.__grpStore;');
    sandbox.window.getGraphState = realGet;
    sandbox.window.saveGraphState = realSave;
    sandbox.window.getCurrentSessionId = realSid;
  }
});
}

