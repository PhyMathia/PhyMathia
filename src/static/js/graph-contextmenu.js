// ===== PhyMathia 知识网络画布：右键菜单（空白画布 + 节点 + 联系线） =====
// 仿 graph-export.js 的单例弹层模式：同一时刻至多一个菜单实例；DOM 挂 document.body
// （renderGraphCanvas() 会 graphCanvas.innerHTML='' 整体重建，挂在画布里会被重渲摧毁）。
// 菜单零新业务逻辑：每一项都复用既有动作函数，本文件只做目标定位、按节点能力裁剪与弹层生命周期。
// 依赖：运行期用到 graph*/chat-features/knowledge/utils 的全局函数与 showToast；全部惰性调用。
// 联系线（.graph-edge-link）菜单：编辑联系 / 曲线精调 / 删除联系（原第二期 P5，M1 承接落地）。
// M2 语义补强：撤销/重做禁用态（栈顶判空 + 跨会话守卫）、多选感知（已选 N 语境）、
// 目标节点临时高亮、居中/复制节点、新建分组/缩放复位/全选节点、导出菜单锚点跟随光标。

// ---------- 单例弹层状态 ----------
let _graphCtxMenuEl = null;
let _graphCtxOutsideCloser = null;
let _graphCtxEscCloser = null;
let _graphCtxTargetEls = []; // 菜单打开期间加 .graph-ctx-target 高亮的目标节点元素（M2）

function _graphCtxToast(msg) {
  if (typeof showToast === 'function') showToast(String(msg || ''));
}

// ---------- 单例生命周期 ----------

function closeGraphContextMenu() {
  if (_graphCtxMenuEl && _graphCtxMenuEl.parentNode) _graphCtxMenuEl.parentNode.removeChild(_graphCtxMenuEl);
  _graphCtxMenuEl = null;
  if (_graphCtxOutsideCloser) {
    document.removeEventListener('pointerdown', _graphCtxOutsideCloser, true);
    _graphCtxOutsideCloser = null;
  }
  if (_graphCtxEscCloser) {
    document.removeEventListener('keydown', _graphCtxEscCloser, true);
    _graphCtxEscCloser = null;
  }
  _graphCtxUnmarkTarget();
}

// ---------- 目标节点临时高亮（M2） ----------
// 菜单打开期间给目标节点元素加 .graph-ctx-target（多选语境高亮整个选择集），
// 关闭时移除；元素可能已被 renderGraphCanvas() 重渲脱离 DOM，移除时判空容错跳过。
function _graphCtxUnmarkTarget() {
  _graphCtxTargetEls.forEach(el => {
    try {
      if (el && el.classList && typeof el.classList.remove === 'function') el.classList.remove('graph-ctx-target');
    } catch (e) { /* 已被重渲的元素忽略 */ }
  });
  _graphCtxTargetEls = [];
}

function _graphCtxMarkTarget(nodeIds) {
  _graphCtxUnmarkTarget();
  if (!graphInner || typeof graphInner.querySelector !== 'function') return;
  (nodeIds || []).forEach(id => {
    const el = graphInner.querySelector('[data-node-id="' + id + '"]');
    if (el && el.classList && typeof el.classList.add === 'function') {
      el.classList.add('graph-ctx-target');
      _graphCtxTargetEls.push(el);
    }
  });
}

// ---------- 菜单项构造（纯描述，供弹层渲染与静态回归） ----------
// item: { key, label, danger?, disabled?, title?, run? }；{ key: 'sep' } 为分隔线。

// 目标三分支分类：'node' | 'link' | 'canvas'。
// 空态「新问题」卡等带 .graph-node 类但查不到数据的元素按画布菜单处理。
function _graphContextTargetKind(target) {
  if (!target || typeof target.closest !== 'function') return 'canvas';
  if (target.closest('.graph-edge-link, .graph-edge-link-label')) return 'link';
  const nodeEl = target.closest('.graph-node');
  const nodeId = nodeEl && nodeEl.dataset ? nodeEl.dataset.nodeId : '';
  if (nodeId && typeof _findGraphNode === 'function' && _findGraphNode(nodeId)) return 'node';
  return 'canvas';
}

// A 类节点菜单：按节点能力白名单裁剪（门控复用渲染层与动作函数的同一判定）。
// 右键目标已属于多选集（size > 1）时改走多选语境（M2）——见 _graphCtxMultiSelection。
// point：右键光标的画布坐标（可选，「追问」草稿落点用；缺省回落节点右下）。
function _graphContextItemsForNode(node, point) {
  const items = [];
  if (!node || !node.id) return items;
  const multi = _graphCtxMultiSelection(node);
  if (multi) return _graphContextItemsForMultiNodes(multi);
  // 追问（T47）：复用端口拖拽的同一落地函数 _createBranchNodeFromOutput——从节点已渲染的
  // 输出端口 DOM 反查「追问」族端口（label 口径与拖拽 questionLike 判定一致），portMeta 按
  // 拖拽手势同一构造逐字段读 dataset，零新业务逻辑。没有追问族输出端口的节点（draft 草稿、
  // 空白节点等）不显示该项；viewer 只读页按 label 白名单自动剪掉（与「存为配方」同口径）。
  const followupPort = _graphCtxFollowupPortEl(node.id);
  if (followupPort) {
    items.push({
      key: 'followup',
      label: '追问',
      run: () => _graphCtxFollowupNode(node, followupPort, point),
    });
  }
  const content = typeof _nodeStoredContent === 'function'
    ? _nodeStoredContent(node)
    : (node.content || node.summary || '');
  const hasContent = String(content || '').trim().length > 0;

  if (hasContent && node.kind !== 'draft') {
    items.push({ key: 'bookmark', label: '收藏为知识点', run: () => _graphCtxBookmarkNode(node, content) });
  }
  if (hasContent) {
    items.push({ key: 'copy', label: '复制全文', run: () => _graphCtxCopyText(String(content || '')) });
  }
  // 居中：focusGraphNodeById 内部重渲 + 测量 + _centerGraphOnNode（任何节点可用）
  items.push({
    key: 'focus',
    label: '居中此节点',
    run: () => { if (typeof focusGraphNodeById === 'function') focusGraphNodeById(node.id); },
  });
  // 复制节点：复用「粘贴为节点」同一条落地链路（draft 不提供，与收藏同口径）
  if (hasContent && node.kind !== 'draft') {
    items.push({
      key: 'duplicate',
      label: '复制节点',
      run: () => _graphCtxDuplicateNode(node, content),
    });
  }
  // 存为配方（P1）：从现有节点提炼可复用类型。只读查看页（viewer）没有配方库与
  // 编辑入口，该项在 viewer 的 READONLY_MENU_LABELS 白名单外会被静默剪掉——刻意为之
  // （与「复制节点」同口径），改文案时注意别把它加进白名单。
  const recipeBaseOk = ['module', 'summary', 'knowledge', 'relation', 'note', 'human_note', 'user']
    .includes(node.kind) || (node.kind === 'answer' && node.manual);
  if (recipeBaseOk && typeof recipeFromNode === 'function') {
    items.push({
      key: 'save-recipe',
      label: '存为配方',
      run: () => recipeFromNode(node.id),
    });
  }
  if (typeof _canMinimizeGraphNode === 'function' && _canMinimizeGraphNode(node)) {
    items.push({
      key: 'minimize',
      label: node.minimized ? '展开节点' : '折叠节点',
      run: () => { if (typeof _toggleGraphNodeMinimize === 'function') _toggleGraphNodeMinimize(node); },
    });
  }
  // 输出端口白名单与 graphAddOutputPort 的守卫一致；输入端口白名单与 graphAddInputPort 一致
  const canOutput = (typeof _moduleCanExpandOutputs === 'function' && _moduleCanExpandOutputs(node))
    || node.kind === 'source' || node.kind === 'knowledge';
  const canInput = node.kind === 'user' || node.kind === 'hub' || node.kind === 'relation'
    || node.kind === 'module' || node.kind === 'blank';
  if (canInput) {
    items.push({ key: 'add-input-port', label: '添加输入端口', run: () => graphAddInputPort(node.id) });
  }
  if (canOutput) {
    items.push({ key: 'add-output-port', label: '添加输出端口', run: () => graphAddOutputPort(node.id) });
  }
  items.push({ key: 'sep' });
  // 删除沿用 _deleteSelectedGraphNodes 的确认路径（消息节点 confirm、blank/draft/自定义静默）。
  // 派生追问节点（sq- 前缀自定义节点）也走原生删除——deleteCustomNode 记 harnessDeleted
  // 墓碑防止下次构建复活。
  items.push({
    key: 'delete',
    label: '删除节点',
    danger: true,
    run: () => { if (typeof _deleteSelectedGraphNodes === 'function') _deleteSelectedGraphNodes([node.id]); },
  });
  return items;
}

// 多选语境判定（M2）：右键目标 ∈ graphView.selectedNodeIds 且选择集不止一个节点时返回选择集
// 节点数组；未选中/单选/选择集混入查不到数据的节点（空态卡等）一律返回 null（退回单目标语境，
// 行为与现状完全一致）。右键本身不改变选择——不做自动改选，保持 P1 以来的现状。
function _graphCtxMultiSelection(node) {
  if (!node || !node.id || typeof _findGraphNode !== 'function') return null;
  const sel = graphView && graphView.selectedNodeIds;
  if (!sel || typeof sel.has !== 'function' || typeof sel.size !== 'number') return null;
  if (!sel.has(node.id) || sel.size <= 1) return null;
  const nodes = [];
  for (const id of sel) {
    const item = _findGraphNode(id);
    if (!item) return null;
    nodes.push(item);
  }
  return nodes.length > 1 ? nodes : null;
}

// 多选语境菜单（M2）：删除作用于整个选择集（_deleteSelectedGraphNodes 本就接受 id 数组，
// 沿用其确认路径）；折叠/展开在集内全部满足 _canMinimizeGraphNode 时作用于选择集，否则隐藏
// （混合状态统一方向：任一未折叠即「折叠节点」，仅切换不在目标态的节点）；收藏/复制全文/
// 居中/复制节点/端口等单目标项在多选语境隐藏，避免歧义。
function _graphContextItemsForMultiNodes(nodes) {
  const items = [];
  const canToggleAll = (typeof _canMinimizeGraphNode === 'function')
    && nodes.every(n => _canMinimizeGraphNode(n));
  if (canToggleAll) {
    const anyExpanded = nodes.some(n => !n.minimized);
    items.push({
      key: 'minimize',
      label: anyExpanded ? '折叠节点' : '展开节点',
      run: () => {
        if (typeof _toggleGraphNodeMinimize !== 'function') return;
        nodes.forEach(n => { if (!!n.minimized !== anyExpanded) _toggleGraphNodeMinimize(n); });
      },
    });
  }
  items.push({ key: 'sep' });
  items.push({
    key: 'delete',
    label: '删除 ' + nodes.length + ' 个节点',
    danger: true,
    // 作用于菜单打开时捕获的选择集（与 label 计数同源）：菜单存活期间的外部重渲
    // （流式回答/定时同步）会经 renderGraphCanvas 清空 selectedNodeIds，届时再读
    // 活选择集会静默一个都删不掉；节点 id 跨重渲稳定，_deleteSelectedGraphNodes
    // 内部按 id 重新解析，选择集未变时与读活集行为完全一致
    run: () => {
      if (typeof _deleteSelectedGraphNodes !== 'function') return;
      _deleteSelectedGraphNodes(nodes.map(n => n.id));
    },
  });
  return items;
}

// 撤销/重做可用性（M2）：栈顶判空 + 会话一致性守卫——对齐 _undoGraphAction（graph.js）的
// no-op 条件（栈顶快照属其他会话时动作本身就是静默返回），菜单提前禁用并给 title 提示。
// graphUndoStack/graphRedoStack 为 graph.js 顶层 let，打包同域可直接引用（graphView 先例）。
function _graphCtxCurrentSessionId() {
  if (typeof _currentSessionId !== 'function') return '';
  try { return String(_currentSessionId() || ''); } catch (e) { return ''; }
}

function _graphCtxHistoryUsable(stack) {
  if (!Array.isArray(stack) || !stack.length) return false;
  const top = stack[stack.length - 1];
  if (!top) return false;
  const sid = _graphCtxCurrentSessionId();
  if (top.sessionId && sid && String(top.sessionId) !== sid) return false;
  return true;
}

// C 类空白画布菜单。client 为右键光标的视口坐标（缩放复位锚点 / 导出菜单锚点用），可缺省。
function _graphContextItemsForCanvas(point, client) {
  const pt = point || { x: 0, y: 0 };
  const canReadClipboard = typeof navigator !== 'undefined'
    && navigator.clipboard && typeof navigator.clipboard.readText === 'function';
  const items = [];
  items.push({
    key: 'add-node',
    label: '新建节点…',
    run: () => { if (typeof openAddBlankNodeModal === 'function') openAddBlankNodeModal(pt.x, pt.y); },
  });
  items.push({
    key: 'paste-node',
    label: '粘贴为节点',
    disabled: !canReadClipboard,
    title: canReadClipboard ? '把剪贴板文本粘贴为空白节点' : '当前环境不可读取剪贴板',
    run: () => _graphCtxPasteNode(pt),
  });
  items.push({ key: 'sep' });
  items.push({ key: 'fit', label: '适配画布', run: () => fitGraph() });
  // 缩放复位 100%：zoomGraph(1/当前zoom) 口径——zoomGraph 自行读写 state.zoom 并受
  // GRAPH_MIN/MAX_ZOOM 钳制，光标为锚保持该点视口位置不动
  items.push({
    key: 'zoom-reset',
    label: '缩放复位 100%',
    run: () => {
      if (typeof zoomGraph !== 'function') return;
      const state = typeof _graphState === 'function' ? _graphState() : null;
      const zoom = Number(state && state.zoom) || 0.9;
      zoomGraph(1 / zoom, client ? client.x : null, client ? client.y : null);
    },
  });
  items.push({ key: 'arrange', label: '自动整理', run: () => autoArrangeGraph() });
  items.push({
    key: 'create-group',
    label: '新建分组',
    run: () => { if (typeof graphCreateGroup === 'function') graphCreateGroup(); },
  });
  // 全选节点：纯组合既有原语（选择集赋值 + _syncGraphSelectionClasses），
  // 同时清掉分组选择，避免「全选节点后按 Del 误删分组」的歧义
  items.push({
    key: 'select-all',
    label: '全选节点',
    run: () => {
      const nodes = (graphView && Array.isArray(graphView.nodes)) ? graphView.nodes : [];
      graphView.selectedNodeIds = new Set(nodes.map(n => n.id));
      graphView.selectedGroupIds = new Set();
      if (typeof _syncGraphSelectionClasses === 'function') _syncGraphSelectionClasses();
    },
  });
  items.push({ key: 'sep' });
  items.push({
    key: 'export',
    // 只写「导出」，不写死格式：点开是导出菜单（缩略知识海报 / 屏幕所见整图 /
    // 单文件网页 / 快照），不止 PNG 一种（2026-09-27 用户指出）。
    label: '导出…',
    // 有光标坐标时把导出菜单锚到光标附近（M2）；无参调用 = 工具栏入口现状不变
    run: () => {
      if (typeof window.toggleGraphExportMenu !== 'function') return;
      window.toggleGraphExportMenu(client ? { x: client.x, y: client.y } : undefined);
    },
  });
  items.push({ key: 'sep' });
  // 判读前先按当前会话同步撤销栈——与 _undoGraphAction/_redoGraphAction 首行的
  // _ensureGraphHistory 同一步：刚启动/刚切换会话时内存栈还是空的或旧会话的，而
  // localStorage 里可能已有本会话历史（Ctrl+Z 实际可撤销），不同步会把可撤销误判成
  // 「没有可撤销的操作」；同步后栈顶判空 + 会话守卫即与动作函数的 no-op 条件严格对齐
  if (typeof _ensureGraphHistory === 'function') {
    try { _ensureGraphHistory(); } catch (e) { /* localStorage 不可用时按原栈判读 */ }
  }
  const canUndo = _graphCtxHistoryUsable(graphUndoStack);
  items.push({
    key: 'undo',
    label: '撤销',
    disabled: !canUndo,
    title: canUndo ? '' : '没有可撤销的操作',
    run: () => { if (typeof window.undoGraphAction === 'function') window.undoGraphAction(); },
  });
  const canRedo = _graphCtxHistoryUsable(graphRedoStack);
  items.push({
    key: 'redo',
    label: '重做',
    disabled: !canRedo,
    title: canRedo ? '' : '没有可重做的操作',
    run: () => { if (typeof window.redoGraphAction === 'function') window.redoGraphAction(); },
  });
  return items;
}

// ---------- B 类联系线菜单（M1，承接旧计划 P5） ----------

// 右键目标 → 联系线边数据：边 <g>、标签组 <g> 与标签 <text> 都携带 data-edge-key
// （graph-render.js _redrawEdges），宽命中路径 .graph-edge-hit 也在边 <g> 内；
// 键 → graphView.edges 用 _edgeKey（graph.js）比对。查不到边数据返回 null（静默不弹菜单）。
function _graphCtxLinkFromTarget(target) {
  if (!target || typeof target.closest !== 'function') return null;
  const keyEl = target.closest('[data-edge-key]');
  const edgeKey = keyEl && keyEl.dataset ? keyEl.dataset.edgeKey : '';
  if (!edgeKey || typeof _edgeKey !== 'function') return null;
  const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
  return edge && edge.link ? edge : null;
}

// 菜单标题：联系线 label 截断 24 字，无 label 用「联系线」
function _graphCtxLinkTitle(edge) {
  const raw = String((edge && (edge.relation || edge.label)) || '').trim();
  return raw ? raw.slice(0, 24) : '联系线';
}

// B 类联系线菜单：三个动作函数（openLinkEdgeModal/enterLinkCurveEdit/deleteLinkEdge）
// 均为 graph-custom.js 既有暴露，直接复用；删除项内部自带 _pushGraphUndo 撤销。
function _graphContextItemsForLink(edge) {
  const items = [];
  if (!edge || typeof _edgeKey !== 'function') return items;
  const edgeKey = _edgeKey(edge);
  if (!edgeKey) return items;
  items.push({
    key: 'edit-link',
    label: '编辑联系…',
    // openLinkEdgeModal：edgeKey 命中边时 fromId/toId 由边自身覆盖（参数仅新建路径使用），
    // 此处按计划传入解析所得两端，语义自文档化
    run: () => {
      if (typeof openLinkEdgeModal === 'function') openLinkEdgeModal(edgeKey, edge.from, edge.to);
    },
  });
  // 曲线精调的编辑态互斥：enterLinkCurveEdit 对已在编辑态的同一条线是静默 no-op，
  // 此时该项改呈「退出精调」，run 走 exitLinkCurveEdit（M1 实现者决策）
  if (graphView.edgeCurveEditKey === edgeKey) {
    items.push({
      key: 'curve-edit',
      label: '退出精调',
      run: () => { if (typeof exitLinkCurveEdit === 'function') exitLinkCurveEdit(); },
    });
  } else {
    items.push({
      key: 'curve-edit',
      label: '曲线精调',
      run: () => { if (typeof enterLinkCurveEdit === 'function') enterLinkCurveEdit(edgeKey); },
    });
  }
  items.push({ key: 'sep' });
  items.push({
    key: 'delete-link',
    label: '删除联系',
    danger: true,
    run: () => { if (typeof deleteLinkEdge === 'function') deleteLinkEdge(edgeKey); },
  });
  return items;
}

// 去掉首尾与连续的分隔线（裁剪后可能只剩分隔线相邻）
function _graphCtxCleanSeparators(items) {
  const out = [];
  for (const item of items) {
    if (item && item.key === 'sep') {
      if (!out.length || out[out.length - 1].key === 'sep') continue;
    }
    out.push(item);
  }
  while (out.length && out[out.length - 1].key === 'sep') out.pop();
  return out;
}

// ---------- 视觉层（M2 细化）：按键名取线性图标 + 快捷键提示 ----------
// 图标全部复用 config.js 的 UI_ICON_SVG；缺失即静默留白（不阻断菜单）。
const GRAPH_CTX_ICONS = {
  followup: 'question',
  bookmark: 'book',
  copy: 'copy',
  focus: 'target',
  duplicate: 'clipboard',
  minimize: 'collapse',
  'add-input-port': 'plus',
  'add-output-port': 'plus',
  'add-node': 'plus',
  'paste-node': 'clipboard',
  fit: 'frame',
  'zoom-reset': 'reset',
  arrange: 'layout',
  'create-group': 'group',
  'select-all': 'selectAll',
  export: 'download',
  undo: 'undo',
  redo: 'redo',
  'edit-link': 'link',
  'curve-edit': 'curve',
  delete: 'trash',
  'delete-link': 'trash',
};

// 与 _handleGraphKeydown 真实支持的快捷键一致（不写不存在的提示）
const GRAPH_CTX_KEYS = {
  undo: 'Ctrl+Z',
  redo: 'Ctrl+Y',
  delete: 'Del',
};

function _graphCtxIconSvg(key) {
  const iconName = GRAPH_CTX_ICONS[key];
  if (!iconName || typeof UI_ICON_SVG === 'undefined' || !UI_ICON_SVG[iconName]) return '';
  return UI_ICON_SVG[iconName];
}

// ---------- 动作适配（均只组合既有函数，零新业务逻辑） ----------

// 节点的「追问」族输出端口元素：从画布 DOM 反查（菜单打开时节点元素在场，渲染重渲后
// 端口 dataset 仍可读——追问 run 只取 dataset 值与节点 id，不依赖元素留在 DOM）。
// label 口径对齐拖拽落点的 questionLike 判定（graph-interact.js）：'追问' 或以「追问」开头。
function _graphCtxFollowupPortEl(nodeId) {
  if (!graphInner || typeof graphInner.querySelector !== 'function') return null;
  const el = graphInner.querySelector('[data-node-id="' + String(nodeId).replace(/"/g, '') + '"]');
  if (!el || typeof el.querySelectorAll !== 'function') return null;
  let ports = null;
  try { ports = Array.prototype.slice.call(el.querySelectorAll('.graph-output-port')); } catch (e) { return null; }
  for (const port of (ports || [])) {
    let label = '';
    try { label = decodeURIComponent(port.dataset.portLabel || ''); } catch (e) { label = port.dataset.portLabel || ''; }
    if (label === '追问' || /^追问/.test(label)) return port;
  }
  return null;
}

// 右键追问：与拖拽手势（graph-interact.js 端口 pointerdown）逐字段同构的 portMeta 构造 +
// 同一落地函数 _createBranchNodeFromOutput（内部自建 draft 卡、连线、测量重画；草稿按既有
// 口径不入撤销栈）。落点用右键光标的画布坐标，缺省回落节点右下。
function _graphCtxFollowupNode(node, portEl, point) {
  const decodeAttr = v => { try { return v ? decodeURIComponent(v) : ''; } catch (e) { return v || ''; } };
  let itemMeta = null;
  if (portEl.dataset.portItem) {
    try { itemMeta = JSON.parse(decodeAttr(portEl.dataset.portItem)); } catch (e) { itemMeta = null; }
  }
  const portMeta = {
    type: portEl.dataset.portType || 'branch',
    branchType: portEl.dataset.portBranch || 'followup',
    attribute: portEl.dataset.attribute || '',
    question: decodeAttr(portEl.dataset.portQuestion),
    level: portEl.dataset.portLevel || '',
    label: decodeAttr(portEl.dataset.portLabel),
    item: itemMeta,
    dragCreates: portEl.dataset.portDrag ? decodeAttr(portEl.dataset.portDrag) : '',
  };
  if (typeof _createBranchNodeFromOutput !== 'function') {
    _graphCtxToast('追问组件未就绪');
    return;
  }
  const at = (point && Number.isFinite(point.x)) ? point : { x: (Number(node.x) || 0) + 380, y: Number(node.y) || 0 };
  _createBranchNodeFromOutput(node.id, portEl.dataset.portId || 'out-0', portMeta, at.x, at.y);
}

function _graphCtxNodeTitle(node) {
  const raw = String((node && (node.label || node.title)) || '').trim();
  if (raw) return raw.slice(0, 24);
  const meta = (typeof GRAPH_MODULE_META === 'object' && GRAPH_MODULE_META)
    ? GRAPH_MODULE_META[node.moduleKey] : null;
  if (meta && meta.label) return String(meta.label).slice(0, 24);
  const content = typeof _nodeStoredContent === 'function'
    ? _nodeStoredContent(node) : (node.content || '');
  const plain = String(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return plain.slice(0, 24) || '节点';
}

// 复制全文
function _graphCtxCopyText(text) {
  if (!text) return;
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(() => {
      _graphCtxToast('已复制节点全文');
    }).catch(() => {
      _graphCtxToast('复制失败：浏览器拒绝了剪贴板写入');
    });
  } else {
    _graphCtxToast('当前环境不支持复制到剪贴板');
  }
}

// 收藏为知识点：持久化路径 100% 复用消息卡收藏流程（书签弹窗表单 → 既有 saveBookmark）。
// 这里只做节点语境的表单预填：标题=节点标题、摘要=内容纯文本前 100 字、
// 公式复用 extractLocalFormulas 过滤链；「保存并替换 AI 提取」在节点语境下不提供。
function _graphCtxBookmarkNode(node, content) {
  const modal = document.getElementById('bookmarkModal');
  if (!modal || typeof saveBookmark !== 'function') {
    _graphCtxToast('收藏组件未就绪');
    return;
  }
  const text = String(content || '');
  const stripped = typeof stripXmlTags === 'function' ? stripXmlTags(text) : text.replace(/<[^>]+>/g, ' ');
  const plainText = String(stripped || '').replace(/\s+/g, ' ').trim();
  const moduleKey = String(node.moduleKey || '');

  const titleEl = document.getElementById('bmTitle');
  if (titleEl) titleEl.value = String(node.label || node.title || '').trim() || plainText.slice(0, 40);
  const categoryEl = document.getElementById('bmCategory');
  if (categoryEl) categoryEl.value = moduleKey === 'math' ? 'math' : moduleKey === 'physics' ? 'physics' : 'other';
  const summaryEl = document.getElementById('bmSummary');
  if (summaryEl) summaryEl.value = plainText.slice(0, 100);
  const tagsEl = document.getElementById('bmTags');
  if (tagsEl) tagsEl.value = moduleKey === 'math' ? '数学' : moduleKey === 'physics' ? '物理' : '';
  const formulasEl = document.getElementById('bmFormulas');
  if (formulasEl) {
    formulasEl.value = (typeof extractLocalFormulas === 'function' && node.kind !== 'draft')
      ? extractLocalFormulas(text).join('\n')
      : '';
  }
  const contentEl = document.getElementById('bmContent');
  if (contentEl) contentEl.value = text;
  const sessionEl = document.getElementById('bmSessionId');
  if (sessionEl) {
    sessionEl.value = (typeof window.getCurrentSessionId === 'function'
      ? window.getCurrentSessionId() : '') || '';
  }
  const messageEl = document.getElementById('bmMessageId');
  if (messageEl) messageEl.value = node.messageIndex >= 0 ? String(node.timestamp || '') : '';
  const replaceEl = document.getElementById('bmReplaceIds');
  if (replaceEl) replaceEl.value = '';
  const replaceBtn = document.getElementById('bmBtnReplace');
  if (replaceBtn) replaceBtn.style.display = 'none';

  modal.classList.add('active');
}

// 粘贴为节点：复用 createManualNode('blank') 建节点（含撤销栈/持久化/重渲），
// 再用 updateCustomNodeContent 写入剪贴板文本（复用其 summary 提炼与保存）。
function _graphCtxCreateBlankNodeWithText(point, text) {
  if (typeof createManualNode !== 'function') return;
  if (typeof addBlankNodePoint !== 'undefined' && addBlankNodePoint) {
    addBlankNodePoint.x = point.x;
    addBlankNodePoint.y = point.y;
  }
  const before = new Set((graphView.nodes || []).map(n => n.id));
  createManualNode('blank');
  const created = (graphView.nodes || []).find(n => !before.has(n.id));
  if (!created) return;
  if (typeof updateCustomNodeContent === 'function') {
    updateCustomNodeContent(created.id, text);
    if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
  }
}

function _graphCtxPasteNode(point) {
  if (!(navigator.clipboard && typeof navigator.clipboard.readText === 'function')) return;
  navigator.clipboard.readText().then(text => {
    const clean = String(text || '').trim();
    if (!clean) {
      _graphCtxToast('剪贴板没有可用的文本');
      return;
    }
    _graphCtxCreateBlankNodeWithText(point, clean);
  }).catch(() => {
    _graphCtxToast('读取剪贴板失败（浏览器权限限制）');
  });
}

// 复制节点（M2）：复用「粘贴为节点」同一条落地链路——createManualNode('blank') 建节点
// （含撤销栈/持久化/重渲）+ updateCustomNodeContent 写入原节点内容（_nodeStoredContent 同源）；
// 落点为原节点旁偏移 +24/+24。
function _graphCtxDuplicateNode(node, content) {
  _graphCtxCreateBlankNodeWithText(
    { x: (Number(node.x) || 0) + 24, y: (Number(node.y) || 0) + 24 },
    String(content || ''),
  );
}

// ---------- 弹层渲染 ----------

function openGraphContextMenu(event) {
  closeGraphContextMenu();
  if (!event) return;
  const target = event.target && typeof event.target.closest === 'function' ? event.target : null;
  const kind = _graphContextTargetKind(target);
  if (kind === 'link' && !_graphCtxLinkFromTarget(target)) return; // 查不到边数据：静默回落（不弹菜单，口径同空态容错）

  const point = (typeof _clientToGraphLocal === 'function')
    ? _clientToGraphLocal(event.clientX, event.clientY)
    : { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };
  // 光标视口坐标（画布菜单的缩放复位锚点 / 导出菜单锚点用）
  const client = { x: Number(event.clientX) || 0, y: Number(event.clientY) || 0 };

  let title = '画布';
  let items;
  let markIds = null; // 确认弹菜单后再给目标加高亮（items 意外为空时不留无人清理的类）
  if (kind === 'node') {
    const nodeEl = target.closest('.graph-node');
    const node = _findGraphNode(nodeEl.dataset.nodeId);
    const multi = _graphCtxMultiSelection(node);
    title = multi ? '已选 ' + multi.length + ' 个节点' : _graphCtxNodeTitle(node);
    items = _graphContextItemsForNode(node, point);
    markIds = multi ? multi.map(n => n.id) : [node.id];
  } else if (kind === 'link') {
    const edge = _graphCtxLinkFromTarget(target);
    title = _graphCtxLinkTitle(edge);
    items = _graphContextItemsForLink(edge);
  } else {
    items = _graphContextItemsForCanvas(point, client);
  }
  items = _graphCtxCleanSeparators((items || []).filter(item => item && (item.key === 'sep' || item.label)));
  if (!items.length) return;
  // 菜单打开期间高亮目标节点（多选语境高亮整个选择集，M2）
  if (markIds) _graphCtxMarkTarget(markIds);

  const menu = document.createElement('div');
  menu.className = 'graph-context-menu aurora-glass';
  menu.setAttribute('role', 'menu');
  const head = document.createElement('div');
  head.className = 'graph-context-menu-title';
  head.textContent = title; // textContent 防注入
  menu.appendChild(head);
  items.forEach((item, index) => {
    if (item.key === 'sep') {
      const sep = document.createElement('div');
      sep.className = 'graph-context-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'graph-context-menu-item' + (item.danger ? ' danger' : '');
    const icon = _graphCtxIconSvg(item.key);
    if (icon) {
      const iconEl = document.createElement('span');
      iconEl.className = 'graph-context-menu-icon';
      iconEl.innerHTML = icon; // 图标来自本地常量表，非用户输入
      btn.appendChild(iconEl);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'graph-context-menu-icon is-empty';
      btn.appendChild(spacer);
    }
    const labelEl = document.createElement('span');
    labelEl.className = 'graph-context-menu-label';
    labelEl.textContent = item.label;
    btn.appendChild(labelEl);
    const keyHint = GRAPH_CTX_KEYS[item.key];
    if (keyHint) {
      const kbd = document.createElement('kbd');
      kbd.className = 'graph-context-menu-kbd';
      kbd.textContent = keyHint;
      btn.appendChild(kbd);
    }
    btn.dataset.itemIndex = String(index);
    if (item.disabled) btn.disabled = true;
    if (item.title) btn.title = item.title;
    menu.appendChild(btn);
  });

  menu.addEventListener('click', ev => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('.graph-context-menu-item') : null;
    if (!btn || btn.disabled) return;
    const item = items[Number(btn.dataset.itemIndex)];
    closeGraphContextMenu();
    if (item && typeof item.run === 'function') item.run();
  });
  // 菜单上的右键不应再触发任何 contextmenu 链路
  menu.addEventListener('contextmenu', ev => {
    ev.preventDefault();
    ev.stopPropagation();
  });

  document.body.appendChild(menu);
  _graphCtxMenuEl = menu;

  // 视口边缘翻转定位
  const menuW = menu.offsetWidth || 0;
  const menuH = menu.offsetHeight || 0;
  let x = Number(event.clientX) || 0;
  let y = Number(event.clientY) || 0;
  const vw = window.innerWidth || 1280;
  const vh = window.innerHeight || 800;
  if (x + menuW > vw - 8) x = Math.max(8, vw - menuW - 8);
  if (y + menuH > vh - 8) y = Math.max(8, vh - menuH - 8);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  // 点击外部（捕获）与 Esc 关闭——注册延后一拍，避免打开手势自身误关
  _graphCtxOutsideCloser = ev => {
    if (_graphCtxMenuEl && !_graphCtxMenuEl.contains(ev.target)) closeGraphContextMenu();
  };
  _graphCtxEscCloser = ev => {
    if (ev.key === 'Escape') closeGraphContextMenu();
  };
  setTimeout(() => {
    if (!_graphCtxMenuEl) return;
    document.addEventListener('pointerdown', _graphCtxOutsideCloser, true);
    document.addEventListener('keydown', _graphCtxEscCloser, true);
  }, 0);
}

// 全局暴露（graph-workflow 的 contextmenu 监听调用；smoke 静态回归断言符号存在）
window.openGraphContextMenu = openGraphContextMenu;
window.closeGraphContextMenu = closeGraphContextMenu;
