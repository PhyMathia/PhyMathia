// ===== PhyMathia 知识网络画布：核心状态、分组与图数据构建 =====

// ===== PhyMathia 知识网络画布 =====
const GRAPH_MODULE_META = {
  physics: { label: '物理视角', color: '#f59e0b' },
  math: { label: '数学视角', color: '#3b82f6' },
  graph: { label: '知识图谱', color: '#0891b2' },
  viz: { label: '交互可视化', color: '#f472b6' },
  socratic: { label: '苏格拉底追问', color: '#f43f5e' },
  learn: { label: '进阶学习', color: '#a855f7' },
  manual: { label: '非 AI 回答', color: '#64748b' },
  hub: { label: '汇聚', color: '#eab308' },
  summary: { label: 'AI 总结', color: '#0d9488' },
  note: { label: '人工总结', color: '#f97316' },
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
  manual: { key: 'manual', label: '非 AI 回答', color: '#64748b' },
  human_note: { key: 'human_note', label: '我的理解', color: '#64748b' },
  ai_eval: { key: 'ai_eval', label: 'AI 评价', color: '#f59e0b' },
  hub: { key: 'hub', label: '汇聚', color: '#eab308' },
  summary: { key: 'summary', label: 'AI 总结', color: '#0d9488' },
  note: { key: 'note', label: '人工总结', color: '#f97316' },
  source: { key: 'source', label: '输入', color: '#06b6d4' },
  knowledge: { key: 'knowledge', label: '知识点', color: '#84cc16' },
  relation: { key: 'relation', label: '联系', color: '#f43f5e' },
  any: { key: 'any', label: '任意输入', color: '#94a3b8' },
};

const ANSWER_OUTPUT_SCHEMA = ['physics', 'math', 'graph', 'viz', 'learn', 'socratic'];
const ANSWER_OUTPUT_INDEX = { physics: 0, math: 1, graph: 2, viz: 3, learn: 4, socratic: 5 };

const MANUAL_NODE_OPTIONS = [
  { key: 'source', kind: 'source', label: '输入', color: '#06b6d4' },
  { key: 'knowledge', kind: 'knowledge', label: '知识点', color: '#84cc16' },
  { key: 'question', kind: 'user', label: '问题', color: '#4a9eff' },
  { key: 'answer', kind: 'answer', label: 'AI 回答', color: '#10b981' },
  { key: 'manual', kind: 'answer', label: '非 AI 回答', color: '#64748b' },
  { key: 'human_note', kind: 'human_note', label: '我的理解', color: '#64748b' },
  { key: 'physics', kind: 'module', label: '物理视角', color: '#f59e0b' },
  { key: 'math', kind: 'module', label: '数学视角', color: '#3b82f6' },
  { key: 'graph', kind: 'module', label: '知识图谱', color: '#0891b2' },
  { key: 'viz', kind: 'module', label: '交互可视化', color: '#f472b6' },
  { key: 'learn', kind: 'module', label: '进阶学习', color: '#a855f7' },
  { key: 'socratic', kind: 'module', label: '苏格拉底追问', color: '#f43f5e' },
  { key: 'hub', kind: 'hub', label: '汇聚', color: '#eab308' },
  { key: 'summary', kind: 'summary', label: 'AI 总结', color: '#0d9488' },
  { key: 'note', kind: 'note', label: '人工总结', color: '#f97316' },
  { key: 'relation', kind: 'relation', label: '联系', color: '#f43f5e' },
];

const GRAPH_CUSTOM_NODE_KINDS = ['blank', 'user', 'answer', 'module', 'hub', 'summary', 'note', 'source', 'knowledge', 'relation', 'human_note', 'ai_eval'];

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
const WORKFLOW_MAX_CONCURRENCY = 3;
let workflowProgressActive = new Set();
let _graphMermaidTimer = null;

const GRAPH_UNDO_LIMIT = 10;
const graphUndoStack = [];

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

function _graphState() {
  if (typeof window.getGraphState === 'function') {
    return window.getGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : '');
  }
  return {
    collapsed: {},
    hidden: {},
    positions: {},
    pinned: {},
    sizes: {},
    pan: { x: 80, y: 80 },
    zoom: 0.9,
    linear: false,
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

function _saveGraphState(state) {
  if (typeof window.saveGraphState === 'function') {
    window.saveGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : '', state);
  }
}

function _pushGraphUndo(withMessages) {
  const snapshot = {
    sessionId: typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '',
    state: JSON.parse(JSON.stringify(_graphState())),
    messages: null,
  };
  if (withMessages && typeof window.getChatHistory === 'function') {
    snapshot.messages = JSON.parse(JSON.stringify(window.getChatHistory()));
  }
  const last = graphUndoStack[graphUndoStack.length - 1];
  if (last && JSON.stringify(last) === JSON.stringify(snapshot)) return;
  graphUndoStack.push(snapshot);
  if (graphUndoStack.length > GRAPH_UNDO_LIMIT) graphUndoStack.shift();
}

async function _undoGraphAction() {
  const currentSessionId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  const snapshot = graphUndoStack[graphUndoStack.length - 1];
  if (!snapshot) return;
  if (snapshot.sessionId && currentSessionId && snapshot.sessionId !== currentSessionId) return;
  graphUndoStack.pop();

  graphView.selectMode = false;
  _applyGraphTextSelectionMode();
  graphView.selectedNodeIds = new Set();
  graphView.selectedGroupIds = new Set();

  if (snapshot.messages && typeof window.replaceChatHistory === 'function') {
    await window.replaceChatHistory(snapshot.messages);
  }
  if (snapshot.state) {
    _saveGraphState(snapshot.state);
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
  }
  renderGraphCanvas();
}

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
      (cn.kind === 'module' || cn.kind === 'blank') &&
      String(cn.moduleKey || '') === String(sourceModule || '')
    ) || null;
  }
  if (!match) match = list.find(cn => cn.kind === 'answer') || null;
  if (!match) match = list.find(cn => cn.kind === 'user' || cn.kind === 'module' || cn.kind === 'blank') || null;
  return match;
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
        let parentId = null;
        let parentNode = null;
        if (msg.sourceModule) {
          const moduleId = _graphNodeId('m', parentTs, msg.sourceModule);
          parentNode = nodeById[moduleId] || null;
          parentId = moduleId;
        }
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
      const branchX = branchParentNode && branchParentNode.x != null
        ? branchParentNode.x + 420
        : radialX;
      const branchY = branchParentNode && branchParentNode.y != null
        ? branchParentNode.y + ((branchCount % 7) - 3) * 130
        : radialY;
      const node = {
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
        customWidth: savedSizes[id] ? savedSizes[id].w : null,
        customHeight: savedSizes[id] ? savedSizes[id].h : null,
        w: 0, h: 0, vx: 0, vy: 0,
      };
      nodes.push(node);
      nodeById[id] = node;
      lastUserNode = node;

      if (isRoot) {
        // 锚点
      } else if (isBranch) {
        const parentTs = String(msg.parentId || '');
        let parentId = null;
        if (msg.sourceModule) {
          const moduleId = _graphNodeId('m', parentTs, msg.sourceModule);
          if (nodeById[moduleId]) parentId = moduleId;
        }
        if (!parentId) {
          const answerId = _graphNodeId('a', parentTs);
          if (nodeById[answerId]) parentId = answerId;
        }
        if (!parentId) {
          const customParent = _findCustomBranchParent(state.customNodes, parentTs, msg.sourceModule);
          if (customParent) parentId = customParent.id;
        }
        if (parentId) _pushEdge(edges, parentId, id, 'primary', msg.fromPort || '');
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
      const branchX = isBranchAnswer && parentQuestion && parentQuestion.x != null
        ? parentQuestion.x + 360
        : radialX;
      const branchY = isBranchAnswer && parentQuestion && parentQuestion.y != null
        ? parentQuestion.y + 150
        : radialY;
      const node = {
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
        customWidth: savedSizes[id] ? savedSizes[id].w : null,
        customHeight: savedSizes[id] ? savedSizes[id].h : null,
        w: 0, h: 0, vx: 0, vy: 0,
      };
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
        const mNode = {
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
          customWidth: savedSizes[moduleId] ? savedSizes[moduleId].w : null,
          customHeight: savedSizes[moduleId] ? savedSizes[moduleId].h : null,
          w: 0, h: 0, vx: 0, vy: 0,
        };
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
    const node = {
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
      customWidth: cn.customWidth || size.w || null,
      customHeight: cn.customHeight || size.h || null,
      minimized: !!cn.minimized,
      hidden: !!cn.hidden,
    };
    nodes.push(node);
    nodeById[node.id] = node;
  });

  return { nodes, edges: _mapAnswerDefaultPorts(_assignDefaultPorts(edges), nodeById), nodeById };
}

function _edgeKey(edge) {
  return (edge.from || '') + ':' + (edge.fromPort || 'out-0') + '->' + (edge.to || '') + ':' + (edge.toPort || 'in-0');
}

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
    const isHubInput = toNode && toNode.kind === 'hub';
    if (!isHubInput && occupiedInputs.has(inputKey)) continue;
    edges.push({ ...customEdge, type: customEdge.type || 'custom', custom: true });
    if (!isHubInput) occupiedInputs.add(inputKey);
    occupiedOutputs.add(customEdge.from + ':' + customEdge.fromPort);
  }

  for (const defaultEdge of (defaults || [])) {
    const edge = _normalizeGraphEdge(defaultEdge);
    if (!nodeById[edge.from] || !nodeById[edge.to] || edge.from === edge.to) continue;
    if (removed.has(_edgeKey(edge))) continue;
    if (occupiedInputs.has(edge.to + ':' + edge.toPort)) continue;
    if (occupiedOutputs.has(edge.from + ':' + edge.fromPort)) continue;
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
    if (node.moduleKey === 'viz' && sections.viz) return _stripModuleHeading(sections.viz, 'viz');
    if (node.moduleKey === 'viz') return '暂未生成交互式可视化内容';
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
