// ===== PhyMathia 知识网络画布：核心状态、分组与图数据构建 =====

// ===== PhyMathia 知识网络画布 =====
const GRAPH_MODULE_META = {
  physics: { label: '物理视角', color: '#f59e0b' },
  math: { label: '数学视角', color: '#3b82f6' },
  graph: { label: '知识图谱', color: '#0891b2' },
  viz: { label: '交互可视化', color: '#f472b6' },
  socratic: { label: '苏格拉底追问', color: '#f43f5e' },
  learn: { label: '进阶学习', color: '#a855f7' },
  manual: { label: '我的回答', color: 'var(--ink-human)' },
  hub: { label: '汇聚', color: '#eab308' },
  summary: { label: 'AI 总结', color: '#0d9488' },
  note: { label: '我的总结', color: 'var(--ink-human)' },
  source: { label: '输入', color: '#06b6d4' },
  knowledge: { label: '知识点', color: '#84cc16' },
  relation: { label: '联系', color: '#f43f5e' },
};

const GRAPH_MODULE_DEFAULT_OUTPUTS = {
  physics: ['追问'],
  math: ['追问'],
  graph: ['追问'],
  viz: ['追问'],
  socratic: ['回答练习', '直接问AI', '追问'],
  learn: ['进阶学习', '追问'],
};

// 允许手工增加/删除输出端口的模块节点白名单（物理/数学/知识图谱/可视化/苏格拉底/进阶学习），
// 渲染门控与增删动作共用此判定（source/knowledge 节点的能力另行判断）。
const GRAPH_MODULE_OUTPUT_EXPANDABLE = Object.keys(GRAPH_MODULE_DEFAULT_OUTPUTS);

function _moduleCanExpandOutputs(node) {
  return !!node && node.kind === 'module' && GRAPH_MODULE_OUTPUT_EXPANDABLE.includes(node.moduleKey);
}

const GRAPH_NODE_ATTRIBUTES = {
  question: { key: 'question', label: '问题', color: '#4a9eff' },
  followup: { key: 'followup', label: '追问', color: '#6366f1' },
  answer: { key: 'answer', label: 'AI 回答', color: '#10b981' },
  physics: { key: 'physics', label: '物理视角', color: '#f59e0b' },
  math: { key: 'math', label: '数学视角', color: '#3b82f6' },
  graph: { key: 'graph', label: '知识图谱', color: '#0891b2' },
  viz: { key: 'viz', label: '交互可视化', color: '#f472b6' },
  socratic: { key: 'socratic', label: '苏格拉底追问', color: '#f43f5e' },
  learn: { key: 'learn', label: '进阶学习', color: '#a855f7' },
  manual: { key: 'manual', label: '我的回答', color: 'var(--ink-human)' },
  human_note: { key: 'human_note', label: '我的理解', color: 'var(--ink-note)' },
  ai_eval: { key: 'ai_eval', label: 'AI 评价', color: '#f59e0b' },
  hub: { key: 'hub', label: '汇聚', color: '#eab308' },
  summary: { key: 'summary', label: 'AI 总结', color: '#0d9488' },
  note: { key: 'note', label: '我的总结', color: 'var(--ink-human)' },
  source: { key: 'source', label: '输入', color: '#06b6d4' },
  knowledge: { key: 'knowledge', label: '知识点', color: '#84cc16' },
  relation: { key: 'relation', label: '联系', color: '#f43f5e' },
  any: { key: 'any', label: '任意输入', color: '#94a3b8' },
  // 配方节点的属性键（P1）：颜色按节点内嵌快照的色板令牌注入 --node-attr，
  // 这里只是 draft/端口兜底用的中性条目——具体颜色永远以 _recipeNodeAttribute 为准
  recipe: { key: 'recipe', label: '配方', color: 'var(--accent)' },
};

const ANSWER_OUTPUT_SCHEMA = ['physics', 'math', 'graph', 'viz', 'learn', 'socratic'];
const ANSWER_OUTPUT_INDEX = { physics: 0, math: 1, graph: 2, viz: 3, learn: 4, socratic: 5 };

// 16 入口由节点配方注册表派生（graph-recipes.js，P0 起单一事实源），字段与形状
// 与原字面量逐项一致；GRAPH_MODULE_META / GRAPH_NODE_ATTRIBUTES / GRAPH_MODULE_DEFAULT_OUTPUTS
// 是渲染细节表，P1 随配方行为挂载一起并入注册表。
const MANUAL_NODE_OPTIONS = deriveManualNodeOptions();

// 自定义节点 kind 白名单（含 relation：创建口径已移除，但旧会话数据里的 relation 节点
// 不能在保存/恢复时被静默抹掉——backlog T75，2026-09-29 修复）
const GRAPH_CUSTOM_NODE_KINDS = deriveGraphCustomNodeKinds();

// 族别形状：面板色点用这一套，画布上的属性标签用同一套（graph-override.css 第 7 轮，
// 按 graph-node-* / graph-attr-* 类名上形状）。圆＝AI 产出、方＝人工书写、菱＝结构、环＝原始素材。
// 之所以有形状而不是只靠颜色：知识图谱↔输入、数学视角↔问题这些配对色相只差 3°–5°，1px 描边上看不出来。
function _nodeFamilyShape(option) {
  const group = (option && option.group) || 'ai';
  if (group === 'human') return 'is-square';
  if (group === 'structure') return 'is-diamond';
  if (group === 'data') return 'is-ring';
  return 'is-round';
}

let graphCanvas = null;
let graphInner = null;
let graphEdgeLayer = null;

const graphView = {
  nodes: [],
  edges: [],
  defaultEdges: [],
  nodeById: {},
  previewNodes: [],
  previewEdges: [],
  selectedNodeIds: new Set(),
  selectedGroupIds: new Set(),
  dragNodeId: null,
  linkDrag: null,
  dragStartPositions: {},
  dragWasSelected: false,
  dragModifier: false,
  boxSelect: null,
  suppressClick: false,
  selectMode: false,
  linkMode: false,
  linkFirstNodeId: null,
  keyHandlerBound: false,
  resizeNodeId: null,
  resizeStartX: 0,
  resizeStartY: 0,
  resizeStartW: 0,
  resizeStartH: 0,
  panning: false,
  moved: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  panStartX: 0,
  panStartY: 0,
  nodeStartX: 0,
  nodeStartY: 0,
  groups: [],
  dragGroupId: null,
  dragGroupStartX: 0,
  dragGroupStartY: 0,
  dragGroupNodeStartPositions: {},
  resizeGroupId: null,
  resizeGroupStartX: 0,
  resizeGroupStartY: 0,
  resizeGroupStartW: 0,
  resizeGroupStartH: 0,
  resizeGroupStartClientX: 0,
  resizeGroupStartClientY: 0,
};

let workflowAbortController = null;
let workflowRunActive = false;
const WORKFLOW_MAX_CONCURRENCY = 6;
let workflowProgressActive = new Set();
let _graphMermaidTimer = null;

const GRAPH_UNDO_LIMIT = 30;
const GRAPH_HISTORY_STORAGE_MAX = 1500000;
let graphUndoStack = [];
let graphRedoStack = [];
let graphHistorySession = "";
let graphHistoryPanel = null;
let graphHistoryPreviewing = -1;
let graphHistoryDiffSummary = "";
let graphPendingLiveMeta = null;
let graphHistoryTimer = null;
let graphHistoryLastSignature = "";
let graphSearchOpen = false;
let graphSearchScope = 'current';
let graphSearchQuery = '';
let graphSearchIndexCache = new Map();
let graphSearchDebounce = null;
let graphSearchAllSynced = false;

const LAYOUT_VERSION = 4;
const TARGET_R = [0, 420, 940, 1460, 2000, 2560, 3120, 3680];
const MAX_ITERATIONS = 120;
let addBlankNodePoint = { x: 0, y: 0 };
let addBlankNodeOverlay = null;


const GRAPH_LAYOUT_FIELDS = ["positions", "sizes", "pan", "zoom", "collapsed", "hidden", "pinned", "layoutVersion", "groups", "portCounts", "inputPortCounts"];

function _graphHistoryKey(sessionId) {
  return "phymathia_graph_history_" + (sessionId || "default");
}

function _currentSessionId() {
  return typeof window.getCurrentSessionId === "function" ? window.getCurrentSessionId() : "";
}

function _ensureGraphHistory() {
  const sid = _currentSessionId();
  if (graphHistorySession === sid && graphUndoStack.length) return;
  if (graphHistorySession !== sid) _flushGraphHistoryMirror();
  graphHistorySession = sid;
  graphUndoStack = [];
  graphRedoStack = [];
  try {
    const raw = localStorage.getItem(_graphHistoryKey(sid));
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) graphUndoStack = _graphHistoryHydrate(arr);
    }
  } catch (e) { graphUndoStack = []; }
  _upgradeGraphHistoryFromServer(sid);
}

// ===== 撤销历史的相邻去重（T53）：快照里整份拷贝的 harnessCheckpoint（Φ 改图回滚点，
// 实测单条 ~9.5KB、相邻重复率 87.5%）常态在相邻快照间一字不差。内存栈（graphUndoStack）
// 永远保持完整快照、撤销行为零变化；只在持久化/镜像序列化时把「与最近一份实体相同」的
// checkpoint 置空并打 checkpointRef 标记，读回（本地 localStorage / 服务端镜像 / 备份导入）
// 统一经 _graphHistoryHydrate 向前借用最近一份实体补回。
// 本地超限截断（_persistGraphHistory 的 slice(-keep)）砍掉引用链实体源时，重建找不到就留空：
// 该条撤销恢复后 checkpoint 为空，Φ「撤销本次」不再可用——属本地截断的既有降级，服务端
// 全量镜像不受影响。旧数据（无标记）经 hydrate 原样通过；备份导出/导入（ui.js 原样搬运
// JSON 字符串）零适配。customNodes（占快照 77%、相邻整体相同率仅 31%）本轮不做去重，
// 节点级池化需换持久化格式，另行评估。
function _graphHistoryDedupe(arr) {
  const out = [];
  let prevCp = '';
  arr.forEach(function (x) {
    if (!x || !x.state || x.state.harnessCheckpoint == null) { out.push(x); return; }
    const cp = JSON.stringify(x.state.harnessCheckpoint);
    if (out.length && cp === prevCp) {
      const state = {};
      Object.keys(x.state).forEach(function (k) { state[k] = x.state[k]; });
      state.harnessCheckpoint = null;
      out.push({ sessionId: x.sessionId, state: state, meta: x.meta || null, checkpointRef: true });
      return;
    }
    prevCp = cp; // 首条实体也在此记录指纹，后续相邻比较以它为基准
    out.push(x);
  });
  return out;
}

function _graphHistoryHydrate(arr) {
  const out = (Array.isArray(arr) ? arr : []).filter(function (x) { return x && x.state; });
  let lastCp = null;
  out.forEach(function (x) {
    if (x.checkpointRef && x.state.harnessCheckpoint == null && lastCp != null) {
      x.state.harnessCheckpoint = JSON.parse(JSON.stringify(lastCp));
    } else if (x.state.harnessCheckpoint != null) {
      lastCp = x.state.harnessCheckpoint;
    }
    delete x.checkpointRef; // 读回即还原成无标记格式，内存态不携带序列化细节
  });
  return out;
}

function _persistGraphHistory() {
  const sid = graphHistorySession;
  const arr = graphUndoStack.map(function (x) {
    return { sessionId: x.sessionId, state: x.state, meta: x.meta || null };
  });
  const slim = _graphHistoryDedupe(arr);
  let s = JSON.stringify(slim);
  if (s.length > GRAPH_HISTORY_STORAGE_MAX) {
    const per = Math.max(1, Math.floor(s.length / (slim.length || 1)));
    const keep = Math.max(5, Math.floor(GRAPH_HISTORY_STORAGE_MAX / per));
    // 本地格子有限可截断；全量数组交给下面的服务端镜像，历史一条不丢
    s = JSON.stringify(slim.slice(-keep));
  }
  safeLocalStorageSet(_graphHistoryKey(sid), s);
  // 硬盘保险：全量（不截断）镜像到服务端 KV——KV 拆分后每会话一文件，写它很便宜。
  // 本地配额满或被截断时服务端是完整副本，换设备/清浏览器数据也能从存档读回。
  _scheduleGraphHistoryMirror(sid, slim);
}

// ===== 探索网历史的服务端镜像（图历史上限 30 步撤销是既有设计，这里只保存储安全） =====
let _graphHistoryMirrorTimer = null;
let _graphHistoryMirrorPending = null;

function _scheduleGraphHistoryMirror(sid, arr) {
  if (!sid || !arr.length) return;
  _graphHistoryMirrorPending = { sid: sid, value: arr };
  if (_graphHistoryMirrorTimer) clearTimeout(_graphHistoryMirrorTimer);
  _graphHistoryMirrorTimer = setTimeout(_flushGraphHistoryMirror, 800);
}

function _flushGraphHistoryMirror() {
  if (_graphHistoryMirrorTimer) {
    clearTimeout(_graphHistoryMirrorTimer);
    _graphHistoryMirrorTimer = null;
  }
  const pending = _graphHistoryMirrorPending;
  _graphHistoryMirrorPending = null;
  if (!pending) return;
  try {
    fetch('/api/kv/graph_history:' + pending.sid, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: pending.value }),
    }).catch(function () { /* 镜像失败静默：下次保存会再镜像 */ });
  } catch (e) { /* 同上 */ }
}

// 切回会话时用存档补齐本地被截断/丢失的历史（只在存档更长时采纳——它按时间
// 是更早开始积累的全量副本；本地更新则不动，避免回退撤销栈）
function _upgradeGraphHistoryFromServer(sid) {
  if (!sid) return;
  fetch('/api/kv/graph_history:' + sid)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      const arr = data && data.value;
      if (!Array.isArray(arr) || !arr.length) return;
      if (graphHistorySession !== sid) return;
      if (arr.length <= graphUndoStack.length) return;
      graphUndoStack = _graphHistoryHydrate(arr);
      if (typeof _refreshGraphHistoryPanel === 'function') _refreshGraphHistoryPanel();
    })
    .catch(function () { /* 无存档/离线：本地为准 */ });
}

function _graphVersionNodeIndex(state) {
  const idx = {};
  (state && state.customNodes || []).forEach(function (n, i) { idx[String(n.id)] = { index: i, node: n }; });
  return idx;
}

function _graphEdgeKeyOf(e) {
  // removedEdges 里存的是 _edgeKey 产出的完整字符串（from:port->to:port），
  // connections 里是带 from/to/fromPort/toPort 的对象；统一转成带端口的关键字，
  // 才能与画布 DOM 的 data-edge-key / _edgeKey 匹配。
  if (typeof e === 'string') return e;
  if (e && (e.key || e.edge_key)) return String(e.key || e.edge_key);
  return _edgeKey(e || {});
}

function _graphNodeLabelOf(node, id) {
  return String((node && (node.label || node.title || node.summary)) || "") || "节点" + String(id || "").slice(0, 12);
}

function _graphShortList(items) {
  const arr = items.slice(0, 5);
  let s = "「" + arr.join("」「") + "」";
  if (items.length > 5) s += " 等" + items.length + "个";
  return s;
}

function _graphDiffSummary(diff) {
  const parts = [];
  const created = (diff.ops || []).filter(function (o) { return o.op === "create_node"; }).map(function (o) { return o.label || o.id; });
  const updated = (diff.ops || []).filter(function (o) { return o.op === "update_node"; }).map(function (o) { return o.label || o.id; });
  const deleted = (diff.ops || []).filter(function (o) { return o.op === "delete_node"; }).map(function (o) { return o.label || o.id; });
  const addEdges = (diff.ops || []).filter(function (o) { return o.op === "add_edge"; }).length;
  const remEdges = (diff.ops || []).filter(function (o) { return o.op === "remove_edge"; }).length;
  if (created.length) parts.push("新增节点" + _graphShortList(created));
  if (deleted.length) parts.push("删除节点" + _graphShortList(deleted));
  if (updated.length) parts.push("修改节点" + _graphShortList(updated));
  if (diff.newDeleted && diff.newDeleted.length) parts.push("隐藏节点" + _graphShortList(diff.newDeleted));
  if (diff.unDeleted && diff.unDeleted.length) parts.push("恢复节点" + _graphShortList(diff.unDeleted));
  if (addEdges) parts.push("新增连线" + addEdges + "条");
  if (remEdges) parts.push("删除连线" + remEdges + "条");
  return parts.join("；") || "修改了图";
}

function _diffGraphStates(prev, next) {
  const layoutOnly = { value: true };
  const ops = [];
  const prevNodes = _graphVersionNodeIndex(prev);
  const nextNodes = _graphVersionNodeIndex(next);
  const prevIds = Object.keys(prevNodes);
  const nextIds = Object.keys(nextNodes);
  const seen = {};
  nextIds.forEach(function (id) {
    seen[id] = true;
    const pn = prevNodes[id];
    const nn = nextNodes[id];
    if (!pn) {
      layoutOnly.value = false;
      ops.push({ op: "create_node", id: id, label: _graphNodeLabelOf(nn.node, id) });
    } else if (JSON.stringify(pn.node) !== JSON.stringify(nn.node)) {
      layoutOnly.value = false;
      ops.push({ op: "update_node", id: id, label: _graphNodeLabelOf(nn.node, id) });
    }
  });
  prevIds.forEach(function (id) {
    if (seen[id]) return;
    layoutOnly.value = false;
    ops.push({ op: "delete_node", id: id, label: _graphNodeLabelOf(prevNodes[id].node, id) });
  });
  const prevDel = Object.keys((prev && prev.harnessDeleted) || {});
  const nextDel = Object.keys((next && next.harnessDeleted) || {});
  const newDeleted = nextDel.filter(function (k) { return prevDel.indexOf(k) < 0; });
  const unDeleted = prevDel.filter(function (k) { return nextDel.indexOf(k) < 0; });
  if (newDeleted.length || unDeleted.length) layoutOnly.value = false;
  const prevRem = {};
  ((prev && prev.removedEdges) || []).forEach(function (e) { prevRem[_graphEdgeKeyOf(e)] = true; });
  const nextRem = {};
  ((next && next.removedEdges) || []).forEach(function (e) { nextRem[_graphEdgeKeyOf(e)] = true; });
  Object.keys(nextRem).forEach(function (k) { if (!prevRem[k]) { layoutOnly.value = false; ops.push({ op: "remove_edge", edge_key: k }); } });
  Object.keys(prevRem).forEach(function (k) { if (!nextRem[k]) { layoutOnly.value = false; ops.push({ op: "add_edge", edge_key: k }); } });
  const prevConn = {};
  ((prev && prev.connections) || []).forEach(function (e) { prevConn[_graphEdgeKeyOf(e)] = true; });
  const nextConn = {};
  ((next && next.connections) || []).forEach(function (e) { nextConn[_graphEdgeKeyOf(e)] = true; });
  Object.keys(nextConn).forEach(function (k) { if (!prevConn[k]) { layoutOnly.value = false; ops.push({ op: "add_edge", edge_key: k }); } });
  Object.keys(prevConn).forEach(function (k) { if (!nextConn[k]) { layoutOnly.value = false; ops.push({ op: "remove_edge", edge_key: k }); } });
  ["groups", "portCounts", "inputPortCounts"].forEach(function (f) {
    if (JSON.stringify((prev || {})[f] || null) !== JSON.stringify((next || {})[f] || null)) layoutOnly.value = false;
  });
  return { layoutOnly: layoutOnly.value, ops: ops, newDeleted: newDeleted, unDeleted: unDeleted, summary: _graphDiffSummary({ ops: ops, newDeleted: newDeleted, unDeleted: unDeleted }) };
}

function _graphState() {
  if (typeof window.getGraphState === "function") {
    return window.getGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : "");
  }
  return {
    collapsed: {},
    hidden: {},
    positions: {},
    pinned: {},
    sizes: {},
    pan: { x: 80, y: 80 },
    zoom: 0.9,
    layoutVersion: 1,
    connections: null,
    removedEdges: [],
    portCounts: {},
    inputPortCounts: {},
    groups: [],
    customNodes: [],
    harnessDeleted: {},
    harnessCheckpoint: null,
  };
}

function _saveGraphState(state, opts) {
  if (typeof window.saveGraphState === "function") {
    window.saveGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : "", state, opts);
  }
}

function _pushGraphUndo(withMessages, meta) {
  if (meta && meta.layout === true) return;
  const state = _graphState();
  if (!state) return;
  _ensureGraphHistory();
  graphPendingLiveMeta = null;
  const sid = _currentSessionId();
  const snapshot = {
    sessionId: sid,
    state: JSON.parse(JSON.stringify(state)),
    messages: null,
    meta: null,
  };
  if (withMessages && typeof window.getChatHistory === "function") {
    snapshot.messages = JSON.parse(JSON.stringify(window.getChatHistory()));
  }
  const last = graphUndoStack[graphUndoStack.length - 1];
  if (last && last.sessionId && sid && last.sessionId !== sid) {
    graphUndoStack = [];
    graphRedoStack = [];
  }
  if (last && last.sessionId === snapshot.sessionId) {
    if (JSON.stringify(last.state) === JSON.stringify(snapshot.state)) return;
    const diff = _diffGraphStates(last.state, snapshot.state);
    if (diff.layoutOnly) {
      // 布局变化不占版本：直接忽略，保持栈顶为“上次编辑前”的完整快照
      return;
    }
  }
  let source = "user";
  let summary = "";
  if (meta && typeof meta === "object" && (meta.summary || meta.source)) {
    graphPendingLiveMeta = { source: meta.source || "user", summary: String(meta.summary || "修改"), ts: Date.now() };
  }
  // 显式 meta（如 harness 摘要）只作为“即将发生的编辑”描述，供 live 版本展示；
  // 落库条目的 meta 始终由自动 diff 生成，避免错位。
  if (!summary) {
    if (last) {
      const diff = _diffGraphStates(last.state, snapshot.state);
      summary = diff.summary;
      source = diff.layoutOnly ? "user" : source;
    } else {
      summary = "初始状态";
      source = "init";
    }
  }
  snapshot.meta = { source: source, summary: summary, ts: Date.now() };
  graphRedoStack = [];
  graphUndoStack.push(snapshot);
  if (graphUndoStack.length > GRAPH_UNDO_LIMIT) graphUndoStack.shift();
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

async function _restoreGraphVersion(snapshot) {
  graphView.selectMode = false;
  _applyGraphTextSelectionMode();
  graphView.selectedNodeIds = new Set();
  graphView.selectedGroupIds = new Set();
  if (snapshot.messages && typeof window.replaceChatHistory === "function") {
    await window.replaceChatHistory(snapshot.messages);
  }
  if (snapshot.state) {
    _saveGraphState(snapshot.state);
    if (typeof window.flushGraphStateServerSave === "function") window.flushGraphStateServerSave();
  }
  renderGraphCanvas();
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
}

async function _undoGraphAction() {
  _ensureGraphHistory();
  const currentSessionId = _currentSessionId();
  const snapshot = graphUndoStack[graphUndoStack.length - 1];
  if (!snapshot) return;
  if (snapshot.sessionId && currentSessionId && snapshot.sessionId !== currentSessionId) return;
  graphUndoStack.pop();
  graphPendingLiveMeta = null;
  const liveState = _graphState();
  const liveMessages = typeof window.getChatHistory === "function" ? JSON.parse(JSON.stringify(window.getChatHistory())) : null;
  graphRedoStack.push({
    sessionId: currentSessionId,
    state: liveState ? JSON.parse(JSON.stringify(liveState)) : null,
    messages: liveMessages,
    meta: { source: "undo", summary: "撤销：" + ((snapshot.meta && snapshot.meta.summary) || "上一步修改"), ts: Date.now() },
    prev: snapshot,
  });
  if (graphRedoStack.length > GRAPH_UNDO_LIMIT) graphRedoStack.shift();
  await _restoreGraphVersion(snapshot);
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

async function _redoGraphAction() {
  _ensureGraphHistory();
  const currentSessionId = _currentSessionId();
  const entry = graphRedoStack[graphRedoStack.length - 1];
  if (!entry) return;
  if (entry.sessionId && currentSessionId && entry.sessionId !== currentSessionId) return;
  graphRedoStack.pop();
  graphPendingLiveMeta = null;
  if (entry.prev && entry.prev.sessionId === currentSessionId) {
    graphUndoStack.push(entry.prev);
    if (graphUndoStack.length > GRAPH_UNDO_LIMIT) graphUndoStack.shift();
  }
  await _restoreGraphVersion(entry);
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

function _graphVersions() {
  _ensureGraphHistory();
  const sid = _currentSessionId();
  const list = graphUndoStack.map(function (entry, i) {
    return {
      index: i,
      isLive: false,
      state: entry.state,
      messages: entry.messages,
      meta: entry.meta || { source: "user", summary: "", ts: 0 },
      sessionId: entry.sessionId,
    };
  });
  let liveMeta = graphPendingLiveMeta;
  if (!liveMeta) {
    const last = graphUndoStack[graphUndoStack.length - 1];
    const liveState = _graphState();
    if (last && liveState) {
      const diff = _diffGraphStates(last.state, liveState);
      if (!diff.layoutOnly) liveMeta = { source: "user", summary: diff.summary, ts: Date.now() };
    }
  }
  if (!liveMeta) liveMeta = { source: "now", summary: "当前状态", ts: Date.now() };
  list.push({
    index: graphUndoStack.length,
    isLive: true,
    state: null,
    messages: null,
    meta: liveMeta,
    sessionId: sid,
  });
  return list;
}

async function _jumpGraphVersion(versionIndex) {
  _ensureGraphHistory();
  const currentSessionId = _currentSessionId();
  if (versionIndex === graphUndoStack.length) return;
  if (versionIndex < 0 || versionIndex >= graphUndoStack.length) return;
  const target = graphUndoStack[versionIndex];
  if (target.sessionId && currentSessionId && target.sessionId !== currentSessionId) return;

  // 保留跳转前的新版本，允许用户“回退错了”后再重做回来。
  const liveState = _graphState();
  const liveMessages = typeof window.getChatHistory === 'function'
    ? JSON.parse(JSON.stringify(window.getChatHistory()))
    : null;
  const discarded = graphUndoStack.slice(versionIndex + 1);
  const lastDiscarded = discarded.length ? discarded[discarded.length - 1] : null;

  const newRedo = [];
  // 最新 live 状态放在 redo 栈底，最后重做时恢复。
  newRedo.push({
    sessionId: currentSessionId,
    state: liveState ? JSON.parse(JSON.stringify(liveState)) : null,
    messages: liveMessages,
    meta: { source: 'redo', summary: '回到最新版本', ts: Date.now() },
    prev: lastDiscarded || target,
  });
  // 被跳过的历史快照按从新到旧依次放入 redo，保证重做顺序正确。
  // 每个 redo 条目的 prev 是“恢复该版本后应放回 undo 栈的上一个快照”。
  for (let i = discarded.length - 1; i >= 0; i--) {
    const snap = discarded[i];
    const prevSnap = i === 0 ? target : discarded[i - 1];
    newRedo.push({
      sessionId: currentSessionId,
      state: snap.state ? JSON.parse(JSON.stringify(snap.state)) : null,
      messages: snap.messages ? JSON.parse(JSON.stringify(snap.messages)) : null,
      meta: { source: 'redo', summary: '前进到：' + ((snap.meta && snap.meta.summary) || '历史版本'), ts: Date.now() },
      prev: prevSnap,
    });
  }

  graphUndoStack = graphUndoStack.slice(0, versionIndex);
  graphRedoStack = newRedo;
  graphPendingLiveMeta = null;
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
  await _restoreGraphVersion(target);
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

function _previewGraphVersion(versionIndex) {
  _ensureGraphHistory();
  const versions = _graphVersions();
  const target = versions[versionIndex];
  const live = _graphState();
  if (!target || !live) return;
  // 再次点击正在对比的版本（或点击当前版本）→ 退出对比
  if (target.isLive || graphHistoryPreviewing === versionIndex) {
    exitGraphVersionPreview();
    return;
  }
  // 语义对齐：把「选中的历史版本」作为旧版本、当前状态作为新版本做 diff，
  // 这样 create=当前新增、delete=相对该版本已被删除、update=被修改，
  // 与 _graphVersions/_pushGraphUndo 里 live summary 的方向一致。
  const diff = _diffGraphStates(target.state, live);
  graphHistoryPreviewing = versionIndex;
  graphHistoryDiffSummary = "版本 " + (versionIndex + 1) + " 与当前差异：" + diff.summary;
  if (typeof window.applyGraphDiffHighlights === "function") {
    window.applyGraphDiffHighlights(diff.ops, {
      state: target.state,
      messages: target.messages || [],
    });
  }
  _renderGraphHistoryFooter();
  _refreshGraphHistoryPanel();
}

function _renderGraphHistoryFooter() {
  const footer = document.getElementById("graphHistoryDiffText");
  if (!footer) return;
  if (graphHistoryPreviewing >= 0 && graphHistoryDiffSummary) {
    const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
    footer.innerHTML = '<span class="graph-history-diff-summary">' + esc(graphHistoryDiffSummary) + '</span>'
      + '<button type="button" class="graph-history-exit-preview" onclick="exitGraphVersionPreview()">✕ 退出对比</button>';
  } else {
    footer.innerHTML = '';
  }
}

function exitGraphVersionPreview() {
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
  _renderGraphHistoryFooter();
  _refreshGraphHistoryPanel();
}

function _graphHistorySourceLabel(source) {
  if (source === "harness") return "AI";
  if (source === "undo") return "撤销";
  if (source === "init") return "初始";
  if (source === "now") return "现在";
  return "手动";
}

function _graphHistoryTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = function (n) { return n < 10 ? "0" + n : String(n); };
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function openGraphHistoryPanel() {
  _ensureGraphHistory();
  if (!graphHistoryPanel) {
    graphHistoryPanel = document.createElement("div");
    graphHistoryPanel.className = "graph-history-panel aurora-glass aurora-glass--dialog";
    graphHistoryPanel.innerHTML = ''
      + '<div class="graph-history-head-row"><span class="graph-history-title">修改历史</span>'
      + '<button type="button" class="graph-history-close" onclick="closeGraphHistoryPanel()" aria-label="关闭">✕</button></div>'
      + '<div class="graph-history-tools">'
      + '<button type="button" onclick="undoGraphAction()" title="Ctrl+Z">↩ 撤销</button>'
      + '<button type="button" onclick="redoGraphAction()" title="Ctrl+Y">↪ 重做</button>'
      + '</div>'
      + '<div class="graph-history-list" id="graphHistoryList"></div>'
      + '<div class="graph-history-diff" id="graphHistoryDiffText"></div>';
    document.body.appendChild(graphHistoryPanel);
  }
  graphHistoryPanel.hidden = false;
  if (graphHistoryTimer) clearInterval(graphHistoryTimer);
  graphHistoryTimer = setInterval(function () { _refreshGraphHistoryPanel(); }, 800);
  _refreshGraphHistoryPanel();
}

function toggleGraphHistoryPanel() {
  if (graphHistoryPanel && !graphHistoryPanel.hidden) { closeGraphHistoryPanel(); return; }
  openGraphHistoryPanel();
}
function closeGraphHistoryPanel() {
  if (graphHistoryTimer) { clearInterval(graphHistoryTimer); graphHistoryTimer = null; }
  if (graphHistoryPanel) graphHistoryPanel.hidden = true;
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
}

function _refreshGraphHistoryPanel() {
  if (!graphHistoryPanel || graphHistoryPanel.hidden) return;
  const versions = _graphVersions();
  const sig = graphHistoryPreviewing + "|" + versions.map(function (v) { return v.index + "|" + (v.isLive ? 1 : 0) + "|" + (v.meta && v.meta.source) + "|" + ((v.meta && v.meta.summary) || ""); }).join("~");
  if (sig === graphHistoryLastSignature) return;
  graphHistoryLastSignature = sig;
  const listEl = document.getElementById("graphHistoryList");
  if (!listEl) return;
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  listEl.innerHTML = versions.map(function (v) {
    const label = _graphHistorySourceLabel(v.meta && v.meta.source);
    const summary = esc((v.meta && v.meta.summary) || "");
    const time = _graphHistoryTime(v.meta && v.meta.ts);
    const cls = v.isLive ? "graph-history-item current" : "graph-history-item";
    const srcCls = "src-" + ((v.meta && v.meta.source) || "user");
    const previewCls = (graphHistoryPreviewing === v.index) ? " previewing" : "";
    let actions = '';
    if (!v.isLive) {
      actions = '<div class="graph-history-actions">'
        + '<button type="button" onclick="previewGraphVersion(' + v.index + ')">对比</button>'
        + '<button type="button" onclick="jumpGraphVersion(' + v.index + ')">回到此版本</button>'
        + '</div>';
    }
    return '<div class="' + cls + previewCls + '">'
      + '<div class="graph-history-head"><span class="graph-history-badge ' + srcCls + '">' + label + '</span>'
      + '<span class="graph-history-summary">' + summary + '</span>'
      + '<span class="graph-history-time">' + time + '</span></div>'
      + actions
      + '</div>';
  }).join('');
  _renderGraphHistoryFooter();
}

window.undoGraphAction = _undoGraphAction;
window.redoGraphAction = _redoGraphAction;
window.jumpGraphVersion = _jumpGraphVersion;
window.previewGraphVersion = _previewGraphVersion;
window.exitGraphVersionPreview = exitGraphVersionPreview;
window.openGraphHistoryPanel = openGraphHistoryPanel;
window.toggleGraphHistoryPanel = toggleGraphHistoryPanel;
window.closeGraphHistoryPanel = closeGraphHistoryPanel;
window.getGraphVersionList = _graphVersions;

function _getChatHistory() {
  const base = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
  const live = typeof window.getStreamingAssistant === 'function' ? window.getStreamingAssistant() : null;
  return live ? base.concat([live]) : base;
}

function _graphNodeId(kind, timestamp, moduleKey) {
  const ts = String(timestamp || '').replace(/[^0-9]/g, '') || Math.random().toString(36).slice(2, 8);
  return kind + '-' + ts + (moduleKey ? '-' + moduleKey : '');
}

function _graphGroupById(groupId) {
  return graphView.groups.find(group => group.id === groupId) || null;
}

function _graphGroupBounds(nodeIds) {
  const nodes = (nodeIds || []).map(id => _findGraphNode(id)).filter(Boolean);
  if (!nodes.length) return { x: 120, y: 120, width: 320, height: 180 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    const w = node.w || 120;
    const h = node.h || 60;
    minX = Math.min(minX, node.x - w / 2);
    minY = Math.min(minY, node.y - h / 2);
    maxX = Math.max(maxX, node.x + w / 2);
    maxY = Math.max(maxY, node.y + h / 2);
  }
  const pad = 34;
  return {
    x: Math.round(minX - pad),
    y: Math.round(minY - pad),
    width: Math.round(maxX - minX + pad * 2),
    height: Math.round(maxY - minY + pad * 2),
  };
}

function _renderGroupHtml(group) {
  const color = group.color || '#38bdf8';
  return '<div class="graph-group" data-group-id="' + group.id + '" style="left:' + group.x + 'px;top:' + group.y + 'px;width:' + group.width + 'px;height:' + group.height + 'px;--group-color:' + color + ';">'
    + '<div class="graph-group-header">'
    + '<input class="graph-group-name-input" value="' + escapeHtml(group.name || '分组') + '" title="重命名分组" onchange="graphRenameGroup(\'' + group.id + '\', this.value)">'
    + '<input class="graph-group-color-input" type="color" value="' + escapeHtml(color) + '" title="调整分组颜色" onchange="graphSetGroupColor(\'' + group.id + '\', this.value)">'
    + '<button class="graph-group-add-btn" title="将选中节点加入此组" onclick="graphAddSelectedToGroup(\'' + group.id + '\')">+</button>'
    + '<button class="graph-group-delete-btn" title="删除分组" onclick="graphDeleteGroup(\'' + group.id + '\')">×</button>'
    + '</div>'
    + '<span class="graph-group-resize-handle" title="调整分组尺寸"></span>'
    + '</div>';
}

function _updateGroupElement(group) {
  const el = graphInner?.querySelector('[data-group-id="' + group.id + '"]');
  if (!el) return;
  el.style.left = group.x + 'px';
  el.style.top = group.y + 'px';
  el.style.width = group.width + 'px';
  el.style.height = group.height + 'px';
  el.style.setProperty('--group-color', group.color || '#38bdf8');
}

function _fitGroupToMembers(group) {
  if (!group || !group.nodeIds || !group.nodeIds.length) return;
  const bounds = _graphGroupBounds(group.nodeIds);
  Object.assign(group, bounds);
  _updateGroupElement(group);
}

function _fitAllGroupsToMembers() {
  (graphView.groups || []).forEach(group => _fitGroupToMembers(group));
}

function _isNodeFullyInsideGroup(node, group) {
  if (!node || !group) return false;
  const w = Number(node.w) || 0;
  const h = Number(node.h) || 0;
  if (!w || !h) return false;
  const gx = Number(group.x) || 0;
  const gy = Number(group.y) || 0;
  const gw = Number(group.width) || 0;
  const gh = Number(group.height) || 0;
  const epsilon = 0.01;
  return node.x - w / 2 >= gx - epsilon
    && node.y - h / 2 >= gy - epsilon
    && node.x + w / 2 <= gx + gw + epsilon
    && node.y + h / 2 <= gy + gh + epsilon;
}

function _syncGroupMembers() {
  const validIds = new Set(graphView.nodes.map(node => node.id));
  let changed = false;
  graphView.groups = (graphView.groups || []).map(group => {
    const nextIds = (group.nodeIds || []).filter(id => validIds.has(id));
    if (nextIds.length !== (group.nodeIds || []).length) changed = true;
    const normalized = { ...group, nodeIds: nextIds };
    if (normalized.x == null || normalized.y == null || !normalized.width || !normalized.height) {
      _fitGroupToMembers(normalized);
      changed = true;
    }
    return normalized;
  });
  if (changed) {
    const state = _graphState();
    state.groups = graphView.groups.map(group => ({ ...group }));
    _saveGraphState(state);
  }
}

function _syncGroupMembersByContainment() {
  const validIds = new Set(graphView.nodes.map(node => node.id));
  let changed = false;
  graphView.groups = (graphView.groups || []).map(group => {
    const originalIds = group.nodeIds || [];
    const nextIds = originalIds.filter(id => validIds.has(id));
    if (nextIds.length !== originalIds.length) changed = true;
    const normalized = { ...group, nodeIds: nextIds };
    if (normalized.x == null || normalized.y == null || !normalized.width || !normalized.height) {
      _fitGroupToMembers(normalized);
      changed = true;
    }
    const containedIds = graphView.nodes
      .filter(node => _isNodeFullyInsideGroup(node, normalized))
      .map(node => node.id);
    if (containedIds.length !== nextIds.length) changed = true;
    normalized.nodeIds = containedIds;
    return normalized;
  });
  if (changed) {
    const state = _graphState();
    state.groups = graphView.groups.map(group => ({ ...group }));
    _saveGraphState(state);
  }
  return changed;
}

function _graphSummary(content) {
  const match = String(content || '').match(/<summary>([\s\S]*?)<\/summary>/i);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function _graphModuleKeys(sections) {
  const keys = [];
  if (sections.physics) keys.push('physics');
  if (sections.math) keys.push('math');
  if (sections.graph) keys.push('graph');
  if (sections.viz) keys.push('viz');
  if (sections.socratic) keys.push('socratic');
  if (sections.learn) keys.push('learn');
  return keys;
}

function _splitExtendSections(content) {
  const text = String(content || '').trim();
  if (!text) return {};
  const markers = [
    { key: 'socratic', pattern: /^#{1,6}\s*[^\n]*苏格拉底追问[^\n]*\n?/im },
    { key: 'learn', pattern: /^#{1,6}\s*[^\n]*进阶学习方向[^\n]*\n?/im },
  ];
  const found = [];
  for (const marker of markers) {
    const match = text.match(marker.pattern);
    if (match) found.push({ key: marker.key, index: match.index });
  }
  if (!found.length) return {};
  found.sort((a, b) => a.index - b.index);
  const out = {};
  for (let i = 0; i < found.length; i++) {
    const start = found[i].index;
    const end = i + 1 < found.length ? found[i + 1].index : text.length;
    out[found[i].key] = text.slice(start, end).trim();
  }
  return out;
}

function _splitGraphSections(sections) {
  const out = { ...(sections || {}) };
  if (out.graph && typeof _splitVizFromGraph === 'function') {
    const split = _splitVizFromGraph(out.graph);
    out.graph = split.graphContent;
    if (!out.viz || !out.viz.trim()) out.viz = split.vizContent;
  }
  const extendSplit = _splitExtendSections(out.extend || '');
  if (extendSplit.socratic || extendSplit.learn) {
    if (extendSplit.socratic) out.socratic = extendSplit.socratic;
    if (extendSplit.learn) out.learn = extendSplit.learn;
    delete out.extend;
  }
  return out;
}

function _findGraphNode(nodeId) {
  // 任务列表：工作流任务跑动期间优先看任务自己那批节点（任务自带来处，见 tasks.js）。
  // 用户切到别的画布之后，任务不再改画布上这批人，而是改自己那份工作副本。
  if (typeof _taskNodeOverride === 'function') {
    const owned = _taskNodeOverride(nodeId);
    if (owned) return owned;
  }
  return graphView.nodeById[nodeId] || null;
}

function _pushEdge(edges, from, to, type, fromPort, toPort) {
  if (!from || !to || from === to) return;
  if (edges.some(e =>
    e.from === from
    && e.to === to
    && (e.fromPort || 'out-0') === (fromPort || 'out-0')
    && (e.toPort || 'in-0') === (toPort || 'in-0')
  )) return;
  edges.push({ from, to, type: type || 'primary', fromPort, toPort });
}

function _assignDefaultPorts(edges) {
  const outCounts = {};
  const inCounts = {};
  return edges.map(edge => {
    if (!edge.fromPort) {
      const idx = outCounts[edge.from] || 0;
      edge.fromPort = 'out-' + idx;
      outCounts[edge.from] = idx + 1;
    }
    if (!edge.toPort) {
      const idx = inCounts[edge.to] || 0;
      edge.toPort = 'in-' + idx;
      inCounts[edge.to] = idx + 1;
    }
    return edge;
  });
}

function _mapAnswerDefaultPorts(edges, nodeById) {
  return edges.map(edge => {
    const from = nodeById[edge.from];
    const to = nodeById[edge.to];
    if (from && from.kind === 'answer' && to && to.kind === 'module') {
      const key = to.moduleKey;
      if (key === 'learn') edge.fromPort = 'out-4';
      if (Object.prototype.hasOwnProperty.call(ANSWER_OUTPUT_INDEX, key)) edge.fromPort = 'out-' + ANSWER_OUTPUT_INDEX[key];
    }
    return edge;
  });
}

function _findCustomBranchParent(customNodes, parentTs, sourceModule) {
  const list = (customNodes || []).filter(cn => String(cn.timestamp || '') === String(parentTs || ''));
  let match = null;
  if (sourceModule) {
    match = list.find(cn =>
      (cn.kind === 'module' || cn.kind === 'blank' || cn.kind === 'hub') &&
      String(cn.moduleKey || '') === String(sourceModule || '')
    ) || null;
  }
  if (!match) match = list.find(cn => cn.kind === 'answer') || null;
  if (!match) match = list.find(cn => cn.kind === 'user' || cn.kind === 'module' || cn.kind === 'blank' || cn.kind === 'hub') || null;
  return match;
}

// 分支消息的父模块解析：sourceModule 可能是旧版伪模块键 'extend'（画布上已拆分为
// socratic/learn 两个模块，永远查不到），也可能与 branchType 同名。按候选顺序解析，
// 全部未命中返回 null（由调用方回退答案节点/自定义节点）。
function _resolveBranchModuleId(nodeById, msg) {
  const parentTs = String(msg.parentId || '');
  if (!parentTs) return null;
  const seen = new Set();
  const candidates = [];
  const push = modKey => {
    if (!modKey) return;
    const id = _graphNodeId('m', parentTs, modKey);
    if (!seen.has(id)) { seen.add(id); candidates.push(id); }
  };
  const srcMod = String(msg.sourceModule || '');
  if (srcMod && srcMod !== 'extend') push(srcMod);
  if (msg.branchType === 'socratic' || msg.branchType === 'learn') push(msg.branchType);
  if (srcMod === 'extend') { push('socratic'); push('learn'); }
  for (const id of candidates) {
    if (nodeById[id]) return id;
  }
  return null;
}

// 无显式 fromPort 时，用消息里的“追问问题：…”（或进阶方向按钮文案）匹配
// 苏格拉底/进阶学习模块的问题端口，得到 'out-K'；匹配不上返回 ''。
function _inferBranchFromPort(parentNode, msg, messages) {
  if (!parentNode || parentNode.kind !== 'module') return '';
  if (parentNode.moduleKey !== 'socratic' && parentNode.moduleKey !== 'learn') return '';
  const message = parentNode.messageIndex >= 0 ? messages[parentNode.messageIndex] : null;
  const content = _nodeContent(message, parentNode) || '';
  const ports = _parsePortQuestions(content, parentNode.moduleKey === 'socratic');
  if (!ports.length) return '';
  const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
  let question = '';
  const qMatch = String(msg.content || '').match(/追问问题[：:]\s*([^\n]+)/);
  if (qMatch) question = norm(qMatch[1]);
  if (question) {
    const exact = ports.findIndex(item => item.question && norm(item.question) === question);
    if (exact >= 0) return 'out-' + exact;
    const loose = ports.findIndex(item => item.question
      && (norm(item.question).includes(question) || question.includes(norm(item.question))));
    if (loose >= 0) return 'out-' + loose;
  }
  // 进阶学习等没有“追问问题”行的消息：看端口问题是否出现在消息正文里
  const body = norm(msg.content);
  const byBody = ports.findIndex(item => item.question && body.includes(norm(item.question)));
  return byBody >= 0 ? 'out-' + byBody : '';
}

function _applyHarnessOverrides(node, state) {
  const overrides = (state && state.harnessNodeOverrides) || {};
  const ov = overrides[node.id];
  if (!ov) return node;
  if (ov.label != null && node.kind !== 'module' && node.kind !== 'hub' && node.kind !== 'summary' && node.kind !== 'note') {
    node.label = String(ov.label);
  }
  if (ov.content != null) node.content = String(ov.content);
  if (ov.formula != null) node.formula = String(ov.formula);
  return node;
}

function _buildGraphData(messages, state) {
  const nodes = [];
  const edges = [];
  const nodeById = {};
  const hiddenMap = state.hidden || {};
  const harnessDeleted = state.harnessDeleted || {};
  const collapsedMap = state.collapsed || {};
  const savedPositions = state.layoutVersion === LAYOUT_VERSION ? (state.positions || {}) : {};
  const pinnedMap = state.pinned || {};
  const savedSizes = state.sizes || {};

  let rootQuestionId = null;
  let lastMainAnswerId = null;
  let lastUserNode = null;
  const answerParentQuestion = {};
  const branchCounter = {};

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      const isBranch = msg.branchType && msg.branchType !== 'main';
      const isRoot = !isBranch && !rootQuestionId;
      const id = _graphNodeId('q', msg.timestamp);
      if (harnessDeleted[id]) continue;
      let depth = 0;
      let targetAngle = 0;
      let parentQuestionId = null;
      let branchParentNode = null;
      let branchCount = 0;

      if (isRoot) {
        rootQuestionId = id;
      } else if (!isBranch) {
        const prevAnswer = lastMainAnswerId ? nodeById[lastMainAnswerId] : null;
        depth = prevAnswer ? prevAnswer.depth + 1 : 1;
        targetAngle = prevAnswer ? prevAnswer.targetAngle + 0.04 : -Math.PI / 2;
      } else {
        const parentTs = String(msg.parentId || '');
        let parentId = _resolveBranchModuleId(nodeById, msg);
        let parentNode = parentId ? nodeById[parentId] : null;
        if (!parentNode) {
          const answerId = _graphNodeId('a', parentTs);
          parentNode = nodeById[answerId] || null;
          parentId = answerId;
        }
        if (!parentNode) {
          const customParent = _findCustomBranchParent(state.customNodes, parentTs, msg.sourceModule);
          if (customParent) {
            parentNode = customParent;
            parentId = customParent.id;
          }
        }
        depth = parentNode ? parentNode.depth + 1 : 2;
        const count = branchCounter[parentId] || 0;
        branchCounter[parentId] = count + 1;
        targetAngle = parentNode ? parentNode.targetAngle + ((count % 7) - 3) * 0.18 : (i % 8) * Math.PI / 4;
        branchParentNode = parentNode;
        branchCount = count;
        const parentAnswerId = _graphNodeId('a', parentTs);
        parentQuestionId = answerParentQuestion[parentAnswerId] || null;
      }

      const saved = savedPositions[id];
      const radialX = (TARGET_R[depth] || 400) * Math.cos(targetAngle);
      const radialY = (TARGET_R[depth] || 400) * Math.sin(targetAngle);
      const positioned = isBranch && msg.position && Number.isFinite(msg.position.x) && Number.isFinite(msg.position.y);
      const branchX = positioned
        ? msg.position.x
        : (branchParentNode && branchParentNode.x != null ? branchParentNode.x + 420 : radialX);
      const branchY = positioned
        ? msg.position.y
        : (branchParentNode && branchParentNode.y != null ? branchParentNode.y + ((branchCount % 7) - 3) * 130 : radialY);
      let node = {
        id,
        kind: 'user',
        x: saved ? saved.x : (isRoot ? 0 : branchX),
        y: saved ? saved.y : (isRoot ? 0 : branchY),
        depth,
        targetAngle,
        isRoot,
        isBranch,
        messageIndex: i,
        timestamp: msg.timestamp,
        moduleKey: msg.sourceModule || '',
        attribute: msg.attribute || '',
        branchType: msg.branchType || 'main',
        branchLabel: msg.branchLabel || '',
        parentId: msg.parentId || '',
        minimized: !!collapsedMap[String(msg.timestamp) + ':answer'],
        pinned: !!(saved && pinnedMap[id]),
        fixedX: saved ? saved.x : null,
        fixedY: saved ? saved.y : null,
        customWidth: savedSizes[id] && savedSizes[id].u ? savedSizes[id].w : null,
        customHeight: savedSizes[id] && savedSizes[id].u ? savedSizes[id].h : null,
        userResized: !!(savedSizes[id] && savedSizes[id].u),
        w: 0, h: 0, vx: 0, vy: 0,
      };
      node = _applyHarnessOverrides(node, state);
      nodes.push(node);
      nodeById[id] = node;
      lastUserNode = node;

      if (isRoot) {
        // 锚点
      } else if (isBranch) {
        const parentTs = String(msg.parentId || '');
        let parentId = _resolveBranchModuleId(nodeById, msg);
        if (!parentId) {
          const answerId = _graphNodeId('a', parentTs);
          if (nodeById[answerId]) parentId = answerId;
        }
        if (!parentId) {
          const customParent = _findCustomBranchParent(state.customNodes, parentTs, msg.sourceModule);
          if (customParent) parentId = customParent.id;
        }
        if (parentId) {
          const parentNode = nodeById[parentId];
          // 端口优先级：消息显式 fromPort（新数据）> 按问题文本推断（旧数据）> 顺延分配
          let fromPort = String(msg.fromPort || '');
          if (!fromPort) fromPort = _inferBranchFromPort(parentNode, msg, messages);
          _pushEdge(edges, parentId, id, 'primary', fromPort);
        }
      } else {
        if (lastMainAnswerId) _pushEdge(edges, lastMainAnswerId, id, 'primary');
      }
    } else {
      const parentQuestionId = lastUserNode ? lastUserNode.id : (rootQuestionId || null);
      const parentQuestion = parentQuestionId ? nodeById[parentQuestionId] : null;
      const id = _graphNodeId('a', msg.timestamp);
      if (harnessDeleted[id]) continue;
      const isBranchAnswer = !!(msg.branchType && msg.branchType !== 'main');
      const depth = parentQuestion ? parentQuestion.depth + 1 : 1;
      const targetAngle = parentQuestion ? parentQuestion.targetAngle + 0.04 : -Math.PI / 2;
      const saved = savedPositions[id];
      const radialX = (TARGET_R[depth] || 400) * Math.cos(targetAngle);
      const radialY = (TARGET_R[depth] || 400) * Math.sin(targetAngle);
      const positionedAnswer = isBranchAnswer && msg.position && Number.isFinite(msg.position.x) && Number.isFinite(msg.position.y);
      const branchX = positionedAnswer
        ? msg.position.x
        : (isBranchAnswer && parentQuestion && parentQuestion.x != null ? parentQuestion.x + 360 : radialX);
      const branchY = positionedAnswer
        ? msg.position.y + 170
        : (isBranchAnswer && parentQuestion && parentQuestion.y != null ? parentQuestion.y + 150 : radialY);
      let node = {
        id,
        kind: 'answer',
        x: saved ? saved.x : branchX,
        y: saved ? saved.y : branchY,
        depth,
        targetAngle,
        isRoot: false,
        isBranch: isBranchAnswer,
        messageIndex: i,
        timestamp: msg.timestamp,
        moduleKey: '',
        branchType: msg.branchType || 'main',
        branchLabel: msg.branchLabel || '',
        parentId: msg.parentId || '',
        pinned: !!(saved && pinnedMap[id]),
        fixedX: saved ? saved.x : null,
        fixedY: saved ? saved.y : null,
        customWidth: savedSizes[id] && savedSizes[id].u ? savedSizes[id].w : null,
        customHeight: savedSizes[id] && savedSizes[id].u ? savedSizes[id].h : null,
        userResized: !!(savedSizes[id] && savedSizes[id].u),
        w: 0, h: 0, vx: 0, vy: 0,
      };
      node = _applyHarnessOverrides(node, state);
      nodes.push(node);
      nodeById[id] = node;
      answerParentQuestion[id] = parentQuestionId;
      if (parentQuestionId) _pushEdge(edges, parentQuestionId, id, 'primary');
      if (!(msg.branchType && msg.branchType !== 'main')) lastMainAnswerId = id;

      const sections = _splitGraphSections((typeof parseXmlSections === 'function') ? parseXmlSections(msg.content || '') : {});
      const keys = _graphModuleKeys(sections);
      if (keys.length && !keys.includes('viz')) keys.push('viz');
      const spread = Math.max(0.28, 0.36 * keys.length / 5);
      keys.forEach((key, idx) => {
        const moduleId = _graphNodeId('m', msg.timestamp, key);
        if (harnessDeleted[moduleId]) return;
        const mDepth = depth + 1;
        const mAngle = targetAngle + (idx - (keys.length - 1) / 2) * spread;
        const savedM = savedPositions[moduleId];
        const mRadialX = (TARGET_R[mDepth] || 400) * Math.cos(mAngle);
        const mRadialY = (TARGET_R[mDepth] || 400) * Math.sin(mAngle);
        const mBranchX = node.isBranch && node.x != null
          ? node.x + (idx - (keys.length - 1) / 2) * 160
          : mRadialX;
        const mBranchY = node.isBranch && node.y != null
          ? node.y + 250
          : mRadialY;
        let mNode = {
          id: moduleId,
          kind: 'module',
          x: savedM ? savedM.x : mBranchX,
          y: savedM ? savedM.y : mBranchY,
          depth: mDepth,
          targetAngle: mAngle,
          isRoot: false,
          isBranch: node.isBranch,
          messageIndex: i,
          timestamp: msg.timestamp,
          moduleKey: key,
          branchType: msg.branchType || 'main',
          branchLabel: msg.branchLabel || '',
          parentId: msg.parentId || '',
          hidden: !!hiddenMap[String(msg.timestamp) + ':' + key],
          minimized: !!collapsedMap[String(msg.timestamp) + ':' + key],
          pinned: !!(savedM && pinnedMap[moduleId]),
          fixedX: savedM ? savedM.x : null,
          fixedY: savedM ? savedM.y : null,
          customWidth: savedSizes[moduleId] && savedSizes[moduleId].u ? savedSizes[moduleId].w : null,
          customHeight: savedSizes[moduleId] && savedSizes[moduleId].u ? savedSizes[moduleId].h : null,
          userResized: !!(savedSizes[moduleId] && savedSizes[moduleId].u),
          w: 0, h: 0, vx: 0, vy: 0,
        };
        mNode = _applyHarnessOverrides(mNode, state);
        nodes.push(mNode);
        nodeById[moduleId] = mNode;
        _pushEdge(edges, id, moduleId, 'primary');
      });
    }
  }

  (state.customNodes || []).forEach(cn => {
    if (harnessDeleted[cn.id] || cn.hidden) return;
    const saved = savedPositions[cn.id] || {};
    const size = savedSizes[cn.id] || {};
    const kind = GRAPH_CUSTOM_NODE_KINDS.includes(cn.kind) ? cn.kind : 'blank';
    let node = {
      ...cn,
      id: cn.id,
      kind,
      x: saved.x != null ? saved.x : (cn.x || 0),
      y: saved.y != null ? saved.y : (cn.y || 0),
      depth: cn.depth != null ? cn.depth : ((kind === 'blank' || kind === 'module' || kind === 'hub') ? 3 : kind === 'answer' ? 2 : (kind === 'summary' || kind === 'note' ? 4 : 1)),
      targetAngle: cn.targetAngle != null ? cn.targetAngle : 0,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
      isRoot: !!cn.isRoot,
      isBranch: false,
      messageIndex: -1,
      timestamp: cn.timestamp || 0,
      moduleKey: cn.moduleKey || '',
      content: cn.content || '',
      branchType: cn.branchType || '',
      pinned: !!(saved && pinnedMap[cn.id]),
      fixedX: saved && pinnedMap[cn.id] ? saved.x : (cn.fixedX || null),
      fixedY: saved && pinnedMap[cn.id] ? saved.y : (cn.fixedY || null),
      // u=1 才允许把保存的测量尺寸兜底成 custom 尺寸（同消息节点口径）：
      // 否则首次保存的即时测量值会在下次重建时冻结住，内容一变就空余/内滚
      customWidth: cn.customWidth || (size.u ? size.w : null) || null,
      customHeight: cn.customHeight || (size.u ? size.h : null) || null,
      userResized: !!(cn.userResized || size.u),
      minimized: !!cn.minimized,
      hidden: !!cn.hidden,
    };
    nodes.push(node);
    nodeById[node.id] = node;
  });

  return { nodes, edges: _mapAnswerDefaultPorts(_assignDefaultPorts(edges), nodeById), nodeById };
}

// _edgeKey 已上移到 utils.js（与 harness.js 共用一份，见那里的说明）

function _normalizeGraphEdge(edge) {
  return {
    ...edge,
    fromPort: edge.fromPort || 'out-0',
    toPort: edge.toPort || 'in-0',
  };
}

function _freeModuleInputPort(state, toNodeId, preferredPort) {
  const used = new Set([
    ...(state.connections || []),
    ...(graphView.defaultEdges || []),
  ]
    .filter(edge => String(edge.to) === String(toNodeId))
    .map(edge => edge.toPort || 'in-0'));
  let index = parseInt(String(preferredPort || 'in-0').replace('in-', ''), 10) || 0;
  while (used.has('in-' + index)) index += 1;
  return { port: 'in-' + index, index };
}

function _resolveGraphEdges(state, defaults, nodeById) {
  const removed = new Set(state.removedEdges || []);
  const custom = (state.connections || [])
    .map(_normalizeGraphEdge)
    .filter(edge => nodeById[edge.from] && nodeById[edge.to] && edge.from !== edge.to);
  const edges = [];
  const occupiedInputs = new Set();
  const occupiedOutputs = new Set();

  for (const customEdge of custom) {
    const inputKey = customEdge.to + ':' + customEdge.toPort;
    const toNode = nodeById[customEdge.to];
    // hub 与 knowledge 的输入允许多路汇入：多条连线可指向同一输入端口
    const isFanInInput = toNode && (toNode.kind === 'hub' || toNode.kind === 'knowledge');
    if (!isFanInInput && occupiedInputs.has(inputKey)) continue;
    edges.push({ ...customEdge, type: customEdge.type || 'custom', custom: true });
    if (!isFanInInput) occupiedInputs.add(inputKey);
    occupiedOutputs.add(customEdge.from + ':' + customEdge.fromPort);
  }

  for (const defaultEdge of (defaults || [])) {
    const edge = _normalizeGraphEdge(defaultEdge);
    if (!nodeById[edge.from] || !nodeById[edge.to] || edge.from === edge.to) continue;
    if (removed.has(_edgeKey(edge))) continue;
    if (occupiedInputs.has(edge.to + ':' + edge.toPort)) continue;
    const fromNode = nodeById[edge.from];
    // 苏格拉底/进阶学习模块的问题端口允许一对多（同一问题可被多次回答），
    // 不参与输出端口占用去重。
    const multiOutFrom = fromNode.kind === 'module'
      && (fromNode.moduleKey === 'socratic' || fromNode.moduleKey === 'learn');
    if (!multiOutFrom && occupiedOutputs.has(edge.from + ':' + edge.fromPort)) continue;
    edges.push(edge);
    occupiedOutputs.add(edge.from + ':' + edge.fromPort);
  }

  return edges;
}

function _stripModuleHeading(content, moduleKey) {
  let text = String(content || '').trim();
  text = text.replace(/^#{1,6}\s*[^\n]*PhyMathia\s*学习卡片\s*[:：]?\s*[^\n]*\n?/i, '').trim();
  const patterns = {
    physics: /^#{1,6}\s*[^\n]*(物理直觉|物理视角)[^\n]*\n?/i,
    math: /^#{1,6}\s*[^\n]*(数学本质|数学视角)[^\n]*\n?/i,
    graph: /^#{1,6}\s*[^\n]*知识图谱[^\n]*\n?/i,
    viz: /^#{1,6}\s*[^\n]*(交互探索|交互式可视化)[^\n]*\n?/i,
    extend: /^#{1,6}\s*[^\n]*延伸思考[^\n]*\n?/i,
    socratic: /^#{1,6}\s*[^\n]*(苏格拉底追问|延伸思考)[^\n]*\n?/i,
    learn: /^#{1,6}\s*[^\n]*(进阶学习方向|进阶学习)[^\n]*\n?/i,
  };
  const pattern = patterns[moduleKey];
  return pattern ? text.replace(pattern, '').trim() : text;
}

function _nodeContent(message, node) {
  if (!message) return node.content || '';
    const _state = typeof _graphState === 'function' ? _graphState() : {};
    const _ov = ((_state && _state.harnessNodeOverrides) || {})[node.id];
    if (_ov && _ov.content != null) {
      const _text = String(_ov.content);
      if (node.kind === 'answer') return _text.slice(0, 240) + (_text.length > 240 ? '...' : '');
      return _text;
    }
  if (node.kind === 'user') return message.content || '';
  if (node.kind === 'answer') {
    const summary = _graphSummary(message.content);
    if (summary) return summary;
    const plain = (typeof stripXmlTags === 'function') ? stripXmlTags(message.content || '') : (message.content || '');
    const p = plain.replace(/\s+/g, ' ').trim();
    return p.slice(0, 240) + (p.length > 240 ? '...' : '');
  }
  if (node.kind === 'module') {
    const sections = _splitGraphSections((typeof parseXmlSections === 'function') ? parseXmlSections(message.content || '') : {});
    if (node.moduleKey === 'viz') {
      const section = sections.viz ? _stripModuleHeading(sections.viz, 'viz') : '';
      if (section && (typeof _hasVisualizationHtml === 'function' ? _hasVisualizationHtml(section) : /```html[\s\S]*?```/i.test(section))) {
        return section;
      }
      // 兼容旧消息：主模型生成/补齐的 HTML 可能不在 <viz> 内，画布节点回退显示完整 HTML 块。
      const fallback = typeof _findCompleteHtmlBlock === 'function' ? _findCompleteHtmlBlock(message.content || '') : '';
      if (fallback) return fallback;
      if (section) return section;
      return '暂未生成交互式可视化内容';
    }
    return _stripModuleHeading(sections[node.moduleKey] || '', node.moduleKey);
  }
  return '';
}

function _graphSearchPlainText(text) {
  let out = String(text || '');
  if (typeof stripXmlTags === 'function') out = stripXmlTags(out);
  out = out.replace(/<[^>]+>/g, ' ');
  out = out.replace(/```[\s\S]*?```/g, ' ');
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  out = out.replace(/\$\$?/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

// ===== 图一致性体检（C） =====
let graphConsistencyPanel = null;
let graphConsistencyTarget = "";

function _scanGraphConsistency() {
  const issues = [];
  const nodes = (graphView && graphView.nodes) || [];
  const edges = (graphView && graphView.edges) || [];
  const nodeById = {};
  nodes.forEach(function (n) { nodeById[String(n.id)] = n; });
  const incident = {};
  const pushBroken = function (edgeKey, nodeId) {
    if (!nodeId) return;
    const tag = "broken|" + edgeKey + "|" + nodeId;
    if (issues.some(function (i) { return i.type === "broken_edge" && i.nodeId === nodeId; })) return;
    issues.push({ type: "broken_edge", severity: "error", edgeKey: edgeKey, nodeId: nodeId, label: nodeId, message: "连线指向不存在的节点「" + nodeId + "」" });
  };
  edges.forEach(function (e) {
    const from = String(e.from || "");
    const to = String(e.to || "");
    if (from) incident[from] = true;
    if (to) incident[to] = true;
    if (from && !nodeById[from]) pushBroken(e.key || "", from);
    if (to && !nodeById[to]) pushBroken(e.key || "", to);
  });
  const state = _graphState();
  ((state && state.connections) || []).forEach(function (e) {
    const from = String(e.from || "");
    const to = String(e.to || "");
    if (from && !nodeById[from]) pushBroken("", from);
    if (to && !nodeById[to]) pushBroken("", to);
  });
  nodes.forEach(function (n) {
    const id = String(n.id);
    if (n.kind === "blank") return;
    if (incident[id]) return;
    issues.push({ type: "orphan", severity: "warning", nodeId: id, label: String(n.label || n.title || id), message: "节点没有任何连线（孤儿）" });
  });
  // 重复检测：知识点按“标签+内容”判定，避免同名但内容不同的节点被误报
  const _nodeContentSig = function (n) {
    return String(n.content || n.summary || n.analysis || n.label || n.title || "").replace(/\s+/g, " ").trim();
  };
  const byLabel = {};
  nodes.forEach(function (n) {
    if (n.kind !== "knowledge") return;
    const label = String(n.label || n.title || "").trim();
    if (!label) return;
    const sig = _nodeContentSig(n);
    const key = label + "\u0000" + sig;
    (byLabel[key] = byLabel[key] || []).push(n);
  });
  Object.keys(byLabel).forEach(function (key) {
    const list = byLabel[key];
    if (list.length > 1) {
      const label = String(list[0].label || list[0].title || "").trim();
      const sig = _nodeContentSig(list[0]);
      issues.push({ type: "duplicate_label", severity: "info", nodeId: String(list[0].id), label: label, message: "存在 " + list.length + " 个" + (sig ? "内容相同" : "同名") + "的知识点「" + label + "」" });
    }
  });
  // 模块重复按“来源回答（消息索引）+ 模块键”判定：不同回答各自带物理/数学视角不算重复；
  // 自定义模块则额外比较内容，仅内容也相同时才判重复。
  const byModule = {};
  nodes.forEach(function (n) {
    if (n.kind !== "module") return;
    const key = String(n.moduleKey || n.module_key || "").trim();
    if (!key) return;
    const group = n.messageIndex >= 0 ? "msg:" + n.messageIndex : "custom:" + _nodeContentSig(n);
    const gkey = group + "\u0000" + key;
    (byModule[gkey] = byModule[gkey] || []).push(n);
  });
  Object.keys(byModule).forEach(function (gkey) {
    const list = byModule[gkey];
    if (list.length > 1) {
      const key = String(list[0].moduleKey || list[0].module_key || "").trim();
      const isMsg = list[0].messageIndex >= 0;
      const metaLabel = (GRAPH_MODULE_META[key] || {}).label || key;
      issues.push({ type: "duplicate_module", severity: "info", nodeId: String(list[0].id), label: key, message: "存在 " + list.length + " 个" + (isMsg ? "「" + metaLabel + "」模块（同一回答）" : "内容相同的「" + metaLabel + "」模块") });
    }
  });
  return issues;
}

function _consistencySeverityLabel(severity) {
  if (severity === "error") return "断链";
  if (severity === "warning") return "孤儿";
  return "重复";
}

function _clearConsistencyTarget() {
  if (!graphConsistencyTarget) return;
  const el = document.querySelector('[data-node-id="' + graphConsistencyTarget + '"]');
  if (el) el.classList.remove("graph-consistency-target");
  graphConsistencyTarget = "";
}

function openGraphConsistencyPanel() {
  if (!graphConsistencyPanel) {
    graphConsistencyPanel = document.createElement("div");
    graphConsistencyPanel.className = "graph-consistency-panel aurora-glass aurora-glass--dialog";
    graphConsistencyPanel.innerHTML = ''
      + '<div class="graph-consistency-head"><span class="graph-consistency-title">图体检</span>'
      + '<button type="button" class="graph-consistency-close" onclick="closeGraphConsistencyPanel()" aria-label="关闭">✕</button></div>'
      + '<div class="graph-consistency-tools">'
      + '<button type="button" onclick="refreshGraphConsistency()">重新体检</button>'
      + '</div>'
      + '<div class="graph-consistency-summary" id="graphConsistencySummary"></div>'
      + '<div class="graph-consistency-list" id="graphConsistencyList"></div>';
    document.body.appendChild(graphConsistencyPanel);
  }
  graphConsistencyPanel.hidden = false;
  _refreshGraphConsistencyPanel();
}

function toggleGraphConsistencyPanel() {
  if (graphConsistencyPanel && !graphConsistencyPanel.hidden) { closeGraphConsistencyPanel(); return; }
  openGraphConsistencyPanel();
}
function closeGraphConsistencyPanel() {
  if (graphConsistencyPanel) graphConsistencyPanel.hidden = true;
  _clearConsistencyTarget();
}

function _refreshGraphConsistencyPanel() {
  if (!graphConsistencyPanel || graphConsistencyPanel.hidden) return;
  const issues = _scanGraphConsistency();
  const summaryEl = document.getElementById("graphConsistencySummary");
  const listEl = document.getElementById("graphConsistencyList");
  if (!summaryEl || !listEl) return;
  const errors = issues.filter(function (i) { return i.severity === "error"; }).length;
  const warnings = issues.filter(function (i) { return i.severity === "warning"; }).length;
  const infos = issues.length - errors - warnings;
  summaryEl.textContent = issues.length ? "发现 " + issues.length + " 个问题（断链 " + errors + " / 孤儿 " + warnings + " / 重复 " + infos + "），点击条目可定位" : "一切正常，没有发现问题";
  summaryEl.className = "graph-consistency-summary" + (errors ? " has-error" : (issues.length ? " has-warning" : " ok"));
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  listEl.innerHTML = issues.map(function (issue, idx) {
    const label = _consistencySeverityLabel(issue.severity);
    return '<div class="graph-consistency-item sev-' + issue.severity + '" onclick="focusConsistencyIssue(' + idx + ')">'
      + '<span class="graph-consistency-badge">' + label + '</span>'
      + '<span class="graph-consistency-msg">' + esc(issue.message) + '</span>'
      + '</div>';
  }).join("");
}

function focusConsistencyIssue(index) {
  const issues = _scanGraphConsistency();
  const issue = issues[index];
  if (!issue) return;
  _clearConsistencyTarget();
  graphConsistencyTarget = String(issue.nodeId || "");
  if (graphConsistencyTarget && typeof window.focusGraphNodeById === "function") {
    window.focusGraphNodeById(graphConsistencyTarget).then(function () {
      const el = document.querySelector('[data-node-id="' + graphConsistencyTarget + '"]');
      if (el) el.classList.add("graph-consistency-target");
    });
  }
}

function refreshGraphConsistency() {
  _refreshGraphConsistencyPanel();
}

window.scanGraphConsistency = _scanGraphConsistency;
window.openGraphConsistencyPanel = openGraphConsistencyPanel;
window.toggleGraphConsistencyPanel = toggleGraphConsistencyPanel;
window.closeGraphConsistencyPanel = closeGraphConsistencyPanel;
window.refreshGraphConsistency = refreshGraphConsistency;
window.focusConsistencyIssue = focusConsistencyIssue;
