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

function _graphNodeSearchText(message, node) {
  const parts = [];
  const base = _nodeContent(message, node);
  if (base) parts.push(base);
  if (message && node.kind === 'answer') parts.push(message.content || '');
  if (message && node.kind === 'module') {
    const sections = _splitGraphSections((typeof parseXmlSections === 'function') ? parseXmlSections(message.content || '') : {});
    if (sections[node.moduleKey]) parts.push(sections[node.moduleKey]);
  }
  if (node.content) parts.push(node.content);
  if (node.summary) parts.push(node.summary);
  if (node.suggestion) parts.push(node.suggestion);
  if (node.target_label) parts.push(node.target_label);
  if (node.requirements) parts.push(node.requirements);
  if (node.label) parts.push(node.label);
  if (node.title) parts.push(node.title);
  if (node.branchLabel) parts.push(node.branchLabel);
  const attr = _nodeAttribute(node);
  if (attr && attr.label) parts.push(attr.label);
  const sub = _nodeSub(node);
  if (sub) parts.push(sub);
  return _graphSearchPlainText(parts.join('\n'));
}

function _graphSearchResultLabel(node, message) {
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || { label: '模块' }).label;
  if (node.kind === 'answer') return node.manual ? '非 AI 回答' : 'AI 回答簇';
  if (node.kind === 'hub') return '汇聚';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '人工总结';
  if (node.kind === 'source') return '输入';
  if (node.kind === 'knowledge') return '知识点';
  if (node.kind === 'relation') return '联系';
  if (node.kind === 'ai_eval') return 'AI 评价';
  if (node.kind === 'user') return node.isRoot ? '核心问题' : (node.isBranch ? (node.branchLabel || '延伸追问') : '问题');
  if (node.kind === 'blank') return '空白节点';
  if (node.kind === 'draft') return '待提交追问';
  return node.label || '节点';
}

function _graphSearchSnippet(text, query, width) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const q = String(query || '').trim().toLowerCase();
  const max = width || 120;
  if (!q) return clean.slice(0, max);
  const idx = clean.toLowerCase().indexOf(q);
  if (idx < 0) return clean.slice(0, max);
  const start = Math.max(0, idx - Math.floor(max * 0.35));
  const end = Math.min(clean.length, start + max);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}

function _graphSearchHighlight(text, query) {
  const snippet = _graphSearchSnippet(text, query, 130);
  const q = String(query || '').trim();
  const highlighted = q
    ? snippet.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>')
    : snippet;
  return escapeHtml(highlighted)
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

function _graphSearchIndexVersion(messages, state) {
  return String(messages.length)
    + ':' + (state.updatedAt || 0)
    + ':' + ((state.customNodes || []).length)
    + ':' + (state.positions ? Object.keys(state.positions).length : 0);
}

function _buildGraphSearchIndex(sessionId) {
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  const sid = sessionId || currentId;
  if (!sid) return [];
  const messages = sid === currentId
    ? _getChatHistory()
    : (typeof window.getSessionMessages === 'function' ? window.getSessionMessages(sid) : []);
  const state = typeof window.getGraphState === 'function' ? window.getGraphState(sid) : _graphState();
  const version = _graphSearchIndexVersion(messages, state);
  const cached = graphSearchIndexCache.get(sid);
  if (cached && cached.version === version) return cached.entries;

  const data = _buildGraphData(messages, state);
  const entries = [];
  for (const node of data.nodes) {
    const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
    const text = _graphNodeSearchText(message, node);
    if (!text) continue;
    entries.push({
      sessionId: sid,
      nodeId: node.id,
      kind: node.kind,
      moduleKey: node.moduleKey || '',
      timestamp: String(node.timestamp || ''),
      custom: node.messageIndex < 0,
      label: _graphSearchResultLabel(node, message),
      sub: _nodeSub(node),
      text,
    });
  }
  graphSearchIndexCache.set(sid, { version, entries });
  return entries;
}

function _graphSearchAllEntries() {
  const allSessions = typeof window.getAllSessions === 'function' ? window.getAllSessions() : [];
  const entries = [];
  for (const sess of allSessions) {
    const sid = sess.id || sess.sessionId;
    if (sid) entries.push(..._buildGraphSearchIndex(sid));
  }
  return entries;
}

function _renderGraphSearchResults(matches, query, showSession) {
  const resultsEl = document.getElementById('graphSearchResults');
  if (!resultsEl) return;
  if (!matches.length) {
    resultsEl.innerHTML = '<div class="graph-search-empty">未找到匹配节点</div>';
    return;
  }
  resultsEl.innerHTML = matches.map(entry => {
    const sess = showSession && typeof window.getSessionById === 'function' ? window.getSessionById(entry.sessionId) : null;
    const sessName = sess ? sess.title : '';
    return '<button class="graph-search-result"'
      + ' data-session-id="' + escapeHtml(entry.sessionId) + '"'
      + ' data-node-id="' + escapeHtml(entry.nodeId) + '"'
      + ' data-timestamp="' + escapeHtml(entry.timestamp) + '"'
      + ' data-module-key="' + escapeHtml(entry.moduleKey) + '"'
      + ' data-node-kind="' + escapeHtml(entry.kind) + '"'
      + ' data-custom="' + (entry.custom ? '1' : '0') + '"'
      + ' onclick="focusGraphSearchResult(this)">'
      + '<span class="graph-search-result-main">'
      + '<span class="graph-search-result-label">' + escapeHtml(entry.label || '节点') + '</span>'
      + (entry.sub ? '<span class="graph-search-result-sub">' + escapeHtml(entry.sub) + '</span>' : '')
      + (sessName ? '<span class="graph-search-result-session">' + escapeHtml(sessName) + '</span>' : '')
      + '</span>'
      + '<span class="graph-search-result-snippet">' + _graphSearchHighlight(entry.text, query) + '</span>'
      + '</button>';
  }).join('');
}

function _performGraphSearch() {
  if (!graphSearchOpen) return;
  const q = String(graphSearchQuery || '').trim();
  const resultsEl = document.getElementById('graphSearchResults');
  if (!q) {
    if (resultsEl) resultsEl.innerHTML = '<div class="graph-search-empty">输入关键词搜索节点</div>';
    return;
  }
  const all = graphSearchScope === 'all';
  const entries = all ? _graphSearchAllEntries() : _buildGraphSearchIndex();
  const lower = q.toLowerCase();
  const matches = [];
  for (const entry of entries) {
    if (String(entry.text || '').toLowerCase().includes(lower)) {
      matches.push(entry);
      if (matches.length >= 50) break;
    }
  }
  _renderGraphSearchResults(matches, q, all);
}

function _syncGraphSearchButtonState() {
  const btn = document.querySelector('.graph-search-btn');
  if (btn) btn.classList.toggle('active', graphSearchOpen);
}

function openGraphSearchPanel() {
  const panel = document.getElementById('graphSearchPanel');
  if (!panel) return;
  graphSearchOpen = true;
  panel.hidden = false;
  const input = document.getElementById('graphSearchInput');
  if (input) {
    input.value = graphSearchQuery;
    input.focus();
    input.select();
  }
  _syncGraphSearchButtonState();
  _performGraphSearch();
}

function closeGraphSearchPanel() {
  const panel = document.getElementById('graphSearchPanel');
  graphSearchOpen = false;
  if (panel) panel.hidden = true;
  _syncGraphSearchButtonState();
}

function toggleGraphSearchPanel() {
  if (graphSearchOpen) closeGraphSearchPanel();
  else openGraphSearchPanel();
}

function graphSearchInputChanged(value) {
  graphSearchQuery = String(value || '');
  clearTimeout(graphSearchDebounce);
  graphSearchDebounce = setTimeout(_performGraphSearch, 140);
}

function graphSearchKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeGraphSearchPanel();
  } else if (event.key === 'Enter') {
    const first = document.querySelector('.graph-search-result');
    if (first) {
      event.preventDefault();
      focusGraphSearchResult(first);
    }
  }
}

function setGraphSearchScope(scope, btn) {
  if (scope !== 'current' && scope !== 'all') return;
  graphSearchScope = scope;
  document.querySelectorAll('#graphSearchScope .graph-search-scope-btn').forEach(b => {
    b.classList.toggle('active', b === btn || b.dataset.scope === scope);
  });
  if (scope === 'all' && !graphSearchAllSynced && typeof window.syncFromServer === 'function') {
    graphSearchAllSynced = true;
    window.syncFromServer().finally(() => {
      if (graphSearchOpen && graphSearchScope === 'all') _performGraphSearch();
    });
  }
  _performGraphSearch();
}

async function focusGraphSearchResult(btn) {
  if (!btn) return;
  const sessionId = btn.dataset.sessionId || '';
  const nodeId = btn.dataset.nodeId || '';
  const timestamp = btn.dataset.timestamp || '';
  const moduleKey = btn.dataset.moduleKey || '';
  const nodeKind = btn.dataset.nodeKind || '';
  const isCustom = btn.dataset.custom === '1';
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  let ok = false;
  let failed = false;
  try {
    if (sessionId && sessionId !== currentId && typeof window.switchToSession === 'function') {
      await window.switchToSession(sessionId);
      if (typeof window.getCurrentSessionId === 'function' && window.getCurrentSessionId() !== sessionId) {
        if (typeof showToast === 'function') showToast('当前正在生成，暂不能跳转');
        return;
      }
    }
    if (isCustom) {
      ok = await focusGraphNodeById(nodeId);
    } else if (timestamp) {
      ok = await focusGraphNode(sessionId || currentId, timestamp, moduleKey, nodeKind);
    }
  } catch (err) {
    failed = true;
    console.error('Graph search jump failed:', err);
    if (typeof showToast === 'function') showToast('跳转失败，请稍后重试');
  } finally {
    closeGraphSearchPanel();
  }
  if (!failed && !ok && typeof showToast === 'function') showToast('未找到该节点，请刷新后重试');
}

function _nodeSub(node) {
  if (node.isRoot) return '核心问题';
  if (node.kind === 'user') return node.isBranch ? (node.branchLabel || '延伸追问') : '问题';
  if (node.kind === 'answer') return node.manual ? '非 AI 回答' : (node.branchLabel || 'AI 回答簇');
  if (node.kind === 'hub') return '汇聚节点';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '人工总结';
  if (node.kind === 'source') return '文件解析入口';
  if (node.kind === 'knowledge') return '知识点节点';
  if (node.kind === 'relation') return '知识联系';
  if (node.kind === 'ai_eval') return 'AI 评价';
  if (node.kind === 'human_note') return '我的理解';
  if (node.kind === 'module') return '';
  if (node.kind === 'blank') return '空白节点';
  return '';
}

function _nodeAttribute(node) {
  if (node.kind === 'draft') {
    return GRAPH_NODE_ATTRIBUTES[node.portMeta && node.portMeta.attribute] || GRAPH_NODE_ATTRIBUTES.followup;
  }
  if (node.kind === 'module') {
    return GRAPH_NODE_ATTRIBUTES[node.moduleKey] || GRAPH_NODE_ATTRIBUTES.question;
  }
  if (node.kind === 'blank') {
    return GRAPH_NODE_ATTRIBUTES[node.moduleKey] || GRAPH_NODE_ATTRIBUTES.question;
  }
  if (node.kind === 'human_note') return GRAPH_NODE_ATTRIBUTES.human_note;
  if (node.kind === 'ai_eval') return GRAPH_NODE_ATTRIBUTES.ai_eval;
  if (node.kind === 'answer') return node.manual ? GRAPH_NODE_ATTRIBUTES.manual : GRAPH_NODE_ATTRIBUTES.answer;
  if (node.kind === 'hub' || node.kind === 'summary' || node.kind === 'note') {
    return GRAPH_NODE_ATTRIBUTES[node.kind] || GRAPH_NODE_ATTRIBUTES.manual;
  }
  if (node.kind === 'source' || node.kind === 'knowledge' || node.kind === 'relation') {
    return GRAPH_NODE_ATTRIBUTES[node.kind] || GRAPH_NODE_ATTRIBUTES.question;
  }
  if (node.kind === 'user') {
    if (node.attribute && GRAPH_NODE_ATTRIBUTES[node.attribute]) return GRAPH_NODE_ATTRIBUTES[node.attribute];
    if (node.moduleKey && GRAPH_NODE_ATTRIBUTES[node.moduleKey]) return GRAPH_NODE_ATTRIBUTES[node.moduleKey];
    if (node.branchType === 'socratic') return GRAPH_NODE_ATTRIBUTES.socratic;
    if (node.branchType === 'learn') return GRAPH_NODE_ATTRIBUTES.learn;
    if (node.branchType === 'followup') return GRAPH_NODE_ATTRIBUTES.followup;
    return GRAPH_NODE_ATTRIBUTES.question;
  }
  return GRAPH_NODE_ATTRIBUTES.question;
}

function _canConnect(fromNode, fromPort, toNode) {
  if (!fromNode || !toNode || fromNode.id === toNode.id) return false;
  if (toNode.kind === 'hub') return fromNode.kind !== 'hub';
  if (toNode.kind === 'summary' || toNode.kind === 'note') return fromNode.kind === 'hub';
  if (toNode.kind === 'human_note') return fromNode.kind !== 'hub' && fromNode.kind !== 'summary' && fromNode.kind !== 'note';
  if (toNode.kind === 'user') return fromNode.kind !== 'hub' && fromNode.kind !== 'summary' && fromNode.kind !== 'note';
  if (toNode.kind === 'relation') return fromNode.kind !== 'hub' && fromNode.kind !== 'summary' && fromNode.kind !== 'note' && fromNode.kind !== 'relation';
  if (toNode.kind === 'knowledge') return fromNode.kind === 'source' || fromNode.kind === 'knowledge';
  if (fromNode.kind === 'hub') return false;
  if (fromNode.kind === 'human_note') {
    return ['human_note', 'module', 'answer', 'blank', 'relation', 'hub', 'user'].includes(toNode.kind);
  }
  const messages = _getChatHistory();
  const fromAttr = _portAttribute(fromNode, fromPort, messages);
  const toAttr = _nodeAttribute(toNode).key;
  const fromPortKey = String(fromPort || 'out-0');
  const isUserAiOutput = fromNode.kind === 'user' && fromPortKey === 'out-0';
  const isUserManualOutput = fromNode.kind === 'user' && fromPortKey !== 'out-0';
  if (toNode.kind === 'blank') {
    if (fromNode.kind === 'answer') return fromAttr === toAttr;
    if (fromNode.kind === 'knowledge') return true;
    return isUserManualOutput;
  }
  if (fromNode.kind === 'answer' && toNode.kind === 'module') return fromAttr === toAttr;
  if ((fromNode.kind === 'user' || fromNode.kind === 'knowledge') && toNode.kind === 'answer') {
    const isAiOutput = fromNode.kind === 'user'
      ? isUserAiOutput
      : String(fromPort || 'out-0') === 'out-0';
    return isAiOutput ? !toNode.manual : !!toNode.manual;
  }
  if (fromNode.kind === 'draft' && toNode.kind === 'answer') return true;
  if (fromNode.kind === 'module' && toNode.kind === 'user') return true;
  if (fromNode.kind === 'module' && toNode.kind === 'draft') {
    return fromAttr === toAttr;
  }
  return false;
}

function _flashInvalidConnection() {
  if (!graphCanvas) return;
  graphCanvas.classList.remove('invalid-link');
  void graphCanvas.offsetWidth;
  graphCanvas.classList.add('invalid-link');
  setTimeout(() => graphCanvas.classList.remove('invalid-link'), 500);
}

function _nodeActions(node) {
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) return '';
  if (node.messageIndex < 0 && (node.manual || node.kind === 'hub')) return '';
  if (node.messageIndex < 0) {
    const isBusy = !!node.busy;
    const label = isBusy ? '生成中...' : node.content ? '重新生成' : '生成';
    return '<div class="graph-node-actions">'
      + _iconRegenButton('runWorkflowNode(\'' + node.id + '\',' + (node.content ? 'true' : 'false') + ')', isBusy ? '生成中...' : (node.content ? '重新生成' : '生成'), isBusy)
      + '</div>';
  }
  if (node.kind === 'module' && node.moduleKey !== 'socratic') {
    const label = node.moduleKey === 'graph' ? '重新生成' : '没看懂';
    return '<div class="graph-node-actions">'
      + _iconRegenButton('graphOpenRegenerate(\'' + node.id + '\')', label, false)
      + '</div>';
  }
  return '';
}

function _shortLabel(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
}

function _regenIconHtml() {
  return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.5-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.5 6.4L3 16"/><path d="M3 21v-5h5"/></svg>';
}

function _iconRegenButton(onclick, title, disabled) {
  return '<button class="graph-regen-btn graph-icon-btn" onclick="' + onclick + '" title="' + escapeHtml(title) + '"' + (disabled ? ' disabled' : '') + '>' + _regenIconHtml() + '</button>';
}

function _parsePortQuestions(content, withLevel) {
  const items = [];
  const re = /(?:^|\n)\s*(?:[-*+]|\d+[.)])\s*(?:\[([^\]]+)\])?\s*([^\n]+)/g;
  let match;
  while ((match = re.exec(content || '')) && items.length < 12) {
    const rawLevel = (match[1] || '').trim();
    const question = (match[2] || '').trim();
    if (!question) continue;
    if (withLevel && !/^(基础|进阶|拓展)/.test(rawLevel)) continue;
    items.push({
      question,
      level: /^基础/.test(rawLevel) ? 'basic' : /^进阶/.test(rawLevel) ? 'advanced' : 'expand',
    });
  }
  return items;
}

function _moduleOutputPorts(node, message) {
  const content = _nodeContent(message, node) || '';
  if (node.moduleKey === 'socratic') {
    const questions = _parsePortQuestions(content, true);
    if (!questions.length) {
      return ['问题1', '问题2', '问题3'].map((label, index) => ({
        label,
        type: 'socratic',
        branchType: 'socratic',
        attribute: 'socratic',
        question: '',
        level: index === 0 ? 'basic' : index === 1 ? 'advanced' : 'expand',
      }));
    }
    return questions.map((item, index) => ({
      label: '问题' + (index + 1),
      type: 'socratic',
      branchType: 'socratic',
      attribute: 'socratic',
      question: item.question,
      level: item.level || (index === 0 ? 'basic' : index === 1 ? 'advanced' : 'expand'),
    }));
  }
  if (node.moduleKey === 'learn') {
    const directions = _parsePortQuestions(content, false);
    if (!directions.length) {
      return ['进阶方向 1', '进阶方向 2', '进阶方向 3'].map(label => ({
        label,
        type: 'learn',
        branchType: 'learn',
        attribute: 'learn',
        question: '',
      }));
    }
    return directions.map(item => ({
      label: _shortLabel(item.question, 12),
      type: 'learn',
      branchType: 'learn',
      attribute: 'learn',
      question: item.question,
    }));
  }
  const defaults = GRAPH_MODULE_DEFAULT_OUTPUTS[node.moduleKey] || ['追问'];
  return defaults.map(label => ({
    label,
    type: 'branch',
    branchType: label === '没看懂' ? 'confused' : label === '直接问AI' ? 'continue' : 'followup',
    attribute: node.moduleKey,
    question: '',
  }));
}

function _draftPrefill(meta) {
  if (meta.type === 'custom' || !meta.sourceModule) return meta.question || '';
  if (meta.type === 'confused' && typeof _modulePrompt === 'function') {
    return _modulePrompt(meta.sourceModule, 'confused', meta.question || '当前问题');
  }
  if (meta.branchType === 'followup' && typeof _modulePrompt === 'function') {
    return _modulePrompt(meta.sourceModule, 'followup', meta.question || '当前问题');
  }
  return meta.question || '';
}

function _renderDraftNodeHtml(node) {
  const meta = node.portMeta || {};
  const attr = _nodeAttribute(node);
  const isSocratic = meta.type === 'socratic';
  const isLearn = meta.type === 'learn';
  let body = '';
  if (isSocratic) {
    body = '<div class="graph-draft-body socratic">'
      + '<div class="graph-draft-question">' + escapeHtml(meta.question || '') + '</div>'
      + '<div class="graph-draft-actions graph-socratic-actions">'
      + '<button class="graph-draft-btn graph-socratic-btn graph-socratic-answer" onclick="draftSocraticAnswer(\'' + node.id + '\')">我来回答</button>'
      + '<button class="graph-draft-btn graph-socratic-btn graph-socratic-ai" onclick="draftAskAi(\'' + node.id + '\')">直接问AI</button>'
      + '</div></div>';
  } else {
    const prefill = isLearn
      ? '请详细讲解：' + (meta.question || '')
      : _draftPrefill(meta);
    body = '<div class="graph-draft-body">'
      + '<textarea class="graph-draft-input" rows="3">' + escapeHtml(prefill) + '</textarea>'
      + '<button class="graph-draft-btn graph-draft-send" onclick="submitDraftQuestion(\'' + node.id + '\')">发送提问</button>'
      + '</div>';
  }
  const label = isSocratic ? '苏格拉底问题' : isLearn ? '进阶学习' : '提问节点';
  return '<div class="graph-node graph-node-draft graph-node-branch graph-attr-' + attr.key + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';">'
    + _renderInputPorts(node)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">' + label + '</span>'
    + '<button class="graph-draft-close" onclick="removeDraftNode(\'' + node.id + '\')" title="取消">×</button></div>'
    + body
    + '</div></div>';
}

function _nodeInputLabel(node) {
  if (node.kind === 'human_note') return '任意输入';
  if (node.kind === 'answer') return node.manual ? '非 AI 回答' : 'AI 回答';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  if (node.kind === 'blank') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || '空白节点';
  if (node.kind === 'hub') return '汇聚输入';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '人工总结';
  if (node.kind === 'user') return '任意输入';
  if (node.kind === 'source') return '文件输入';
  if (node.kind === 'knowledge') return '知识点来源';
  if (node.kind === 'relation') return '联系输入';
  return '来源';
}

function _nodeOutputLabels(node, messages) {
  if (node.kind === 'draft') return [];
  if (node.kind === 'blank') return ['追问'];
  if (node.kind === 'human_note') return ['人工内容'];
  if (node.kind === 'user') return ['AI 回答', '非 AI 回答'];
  if (node.kind === 'source') return (node.items || []).map(item => item.title || '知识点 ' + ((node.items || []).indexOf(item) + 1));
  if (node.kind === 'knowledge') return ['AI 回答', '问题', '联系'];
  if (node.kind === 'relation') return [];
  if (node.kind === 'module') {
    return _moduleOutputPorts(node, messages[node.messageIndex]).map(item => item.label);
  }
  if (node.kind === 'answer') {
    return _answerOutputPorts(node, messages).map(item => item.label);
  }
  if (node.kind === 'hub') return ['AI 总结'];
  if (node.kind === 'summary' || node.kind === 'note') return [];
  return ['输出'];
}

function _answerOutputPorts(node, messages) {
  return ANSWER_OUTPUT_SCHEMA.map(key => ({
    label: (GRAPH_MODULE_META[key] || {}).label || key,
    type: 'branch',
    branchType: 'followup',
    attribute: key,
    question: '',
  }));
}

function _knowledgeOutputPorts(node) {
  return [
    { label: 'AI 回答', type: 'answer', branchType: '', attribute: 'answer', group: 'ai', question: '' },
    { label: '问题', type: 'branch', branchType: 'followup', attribute: 'question', group: 'question', question: '' },
    { label: '联系', type: 'relation', branchType: '', attribute: 'relation', group: 'relation', question: '' },
  ];
}

function _portAttribute(node, portId, messages) {
  const isOutput = /^out-/.test(String(portId || ''));
  if (isOutput) {
    const index = parseInt(String(portId).replace('out-', ''), 10);
    if (node.kind === 'blank') return node.moduleKey || 'followup';
    if (node.kind === 'source') return 'knowledge';
    if (node.kind === 'module') {
      const ports = _moduleOutputPorts(node, messages[node.messageIndex]);
      return (ports[index] && ports[index].attribute) || 'followup';
    }
    if (node.kind === 'answer') {
      const ports = _answerOutputPorts(node, messages);
      return (ports[index] && ports[index].attribute) || 'answer';
    }
    if (node.kind === 'human_note') return 'human_note';
    if (node.kind === 'knowledge') {
      const ports = _knowledgeOutputPorts(node);
      return (ports[index] && ports[index].attribute) || 'question';
    }
    if (node.kind === 'user') return index === 0 ? 'answer' : 'manual';
    if (node.kind === 'hub') return index === 0 ? 'summary' : 'followup';
    return 'followup';
  }
  return _nodeAttribute(node).key;
}

function _nodeOutputCount(node, messages, state) {
  if (node.kind === 'draft') return 0;
  if (node.kind === 'summary' || node.kind === 'note') return 0;
  if (node.kind === 'relation') return 0;
  if (node.kind === 'source') {
    const savedCount = state.portCounts && state.portCounts[node.id] ? state.portCounts[node.id] : 0;
    return Math.max((node.items || []).length, savedCount || 0);
  }
  const savedCount = state.portCounts && state.portCounts[node.id];
  return Math.max(1, _nodeOutputLabels(node, messages).length, savedCount || 0);
}

function _renderInputPorts(node, state) {
  const attr = _nodeAttribute(node);
  if (node.kind === 'source') return '';
  const savedCount = state && state.inputPortCounts && state.inputPortCounts[node.id]
    ? state.inputPortCounts[node.id]
    : 0;
  const canAddInput = node.kind === 'user' || node.kind === 'hub' || node.kind === 'relation';
  const baseCount = node.kind === 'relation' ? 2 : 1;
  const count = node.kind === 'module'
    ? baseCount + savedCount
    : canAddInput
      ? baseCount + savedCount
      : (node.isRoot ? 0 : 1);
  let html = '<div class="graph-port-col graph-input-col">';
  for (let i = 0; i < count; i++) {
    const label = node.kind === 'module' && i >= 1 ? '人工内容输入' : _nodeInputLabel(node);
    const anyClass = node.kind === 'user' || node.kind === 'human_note' ? ' graph-port-any-input' : '';
    const portAttr = canAddInput ? 'any' : (node.kind === 'human_note' ? 'any' : attr.key);
    const portColor = node.kind === 'user' || node.kind === 'human_note' ? '#94a3b8' : attr.color;
    const canRemove = (canAddInput || node.kind === 'module') && i >= baseCount;
    html += '<div class="graph-port graph-input-port' + anyClass + '" data-node-id="' + node.id + '" data-port-id="in-' + i + '" data-attribute="' + portAttr + '" style="--port-color:' + portColor + ';" title="' + (node.kind === 'user' || node.kind === 'human_note' ? '任意输入端口：可连接任意来源' : '输入端口：拖到右侧输出可重连来源') + '">'
      + '<span class="graph-port-dot"></span><span class="graph-port-label">' + escapeHtml(label) + '</span>'
      + (canRemove
        ? '<button class="graph-port-remove" onclick="event.stopPropagation();graphRemoveInputPort(\'' + node.id + '\',' + i + ')" title="删除输入端口">×</button>'
        : '')
      + '</div>';
  }
  if (canAddInput) {
    html += '<button class="graph-add-port-btn graph-add-input-btn" onclick="event.stopPropagation();graphAddInputPort(\'' + node.id + '\')" title="添加输入端口">+</button>';
  }
  html += '</div>';
  return html;
}

function _renderOutputPorts(node, messages, state) {
  if (node.kind === 'draft') return '';
  if (node.kind === 'summary' || node.kind === 'note') return '';
  let ports = [];
  if (node.kind === 'user') {
    ports = [
      { label: 'AI 回答', type: 'answer', branchType: '', attribute: 'answer', group: 'ai', question: '' },
      { label: '非 AI 回答', type: 'manual', branchType: 'manual', attribute: 'manual', group: 'manual', question: '' },
    ];
  } else if (node.kind === 'blank') {
    ports = [{
      label: '追问',
      type: 'branch',
      branchType: 'followup',
      attribute: node.moduleKey || 'followup',
      question: '',
    }];
  } else if (node.kind === 'human_note') {
    ports = [{
      label: '人工内容',
      type: 'custom',
      branchType: '',
      attribute: 'human_note',
      group: 'human',
      question: '',
    }];
  } else if (node.kind === 'answer') {
    ports = _answerOutputPorts(node, messages);
  } else if (node.kind === 'module') {
    ports = _moduleOutputPorts(node, messages[node.messageIndex]);
  } else if (node.kind === 'source') {
    ports = (node.items || []).map((item, index) => ({
      label: item.title || '知识点 ' + (index + 1),
      type: 'knowledge',
      branchType: '',
      attribute: 'knowledge',
      group: 'knowledge',
      question: '',
      item: item,
    }));
  } else if (node.kind === 'knowledge') {
    ports = _knowledgeOutputPorts(node);
  } else if (node.kind === 'relation') {
    return '';
  } else if (node.kind === 'hub') {
    ports = [{
      label: 'AI 总结',
      type: 'branch',
      branchType: 'summary',
      attribute: 'summary',
      question: '',
    }];
  } else {
    const labels = _nodeOutputLabels(node, messages);
    ports = labels.map((label, index) => ({
      label,
      type: node.kind === 'user' ? 'answer' : 'branch',
      branchType: node.kind === 'user' ? '' : 'followup',
      attribute: node.kind === 'user' ? 'answer' : node.kind === 'answer' ? 'answer' : 'followup',
      question: '',
    }));
  }
  const canAddPort = (node.kind === 'module' && node.moduleKey === 'socratic') || node.kind === 'source' || node.kind === 'knowledge';
  const savedCount = canAddPort && state.portCounts && state.portCounts[node.id] ? state.portCounts[node.id] : 0;
  const count = Math.max(ports.length, savedCount);
  if (count <= 0) return '';
  let html = '<div class="graph-port-col graph-output-col">';
  for (let i = 0; i < count; i++) {
    const meta = ports[i] || {
      label: node.kind === 'source'
        ? '知识点 ' + (i + 1)
        : node.kind === 'knowledge'
          ? '问题 ' + (i - ports.length + 1)
          : '追问 ' + (i - ports.length + 1),
      type: node.kind === 'source' ? 'knowledge' : node.kind === 'knowledge' ? 'branch' : 'custom',
      branchType: 'followup',
      attribute: node.kind === 'source' ? 'knowledge' : node.kind === 'knowledge' ? 'question' : 'followup',
      question: '',
      custom: true,
    };
    const label = meta.label || ('输出 ' + (i + 1));
    const attr = GRAPH_NODE_ATTRIBUTES[meta.attribute] || GRAPH_NODE_ATTRIBUTES.followup;
    html += '<div class="graph-port graph-output-port" data-node-id="' + node.id + '" data-port-id="out-' + i + '"'
      + ' data-port-type="' + (meta.type || 'branch') + '"'
      + ' data-port-branch="' + (meta.branchType || 'followup') + '"'
      + ' data-attribute="' + attr.key + '"'
      + ' data-port-question="' + encodeURIComponent(meta.question || '') + '"'
      + ' data-port-level="' + (meta.level || '') + '"'
      + ' data-port-label="' + encodeURIComponent(label) + '"'
      + ' data-port-group="' + (meta.group || '') + '"'
      + (meta.item ? ' data-port-item="' + encodeURIComponent(JSON.stringify(meta.item)) + '"' : '')
      + ' style="--port-color:' + attr.color + ';"'
      + ' title="输出端口：拖到空处创建提问节点，或拖到输入端口重连">'
      + '<span class="graph-port-label">' + escapeHtml(label) + '</span>'
      + '<span class="graph-port-dot"></span>'
      + (meta.custom
        ? '<button class="graph-port-remove" onclick="event.stopPropagation();graphRemoveOutputPort(\'' + node.id + '\',' + i + ')" title="删除输出端口">×</button>'
        : '')
      + '</div>';
  }
  if (canAddPort) {
    html += '<button class="graph-add-port-btn" onclick="event.stopPropagation();graphAddOutputPort(\'' + node.id + '\')" title="添加输出端口">+</button>';
  }
  html += '</div>';
  return html;
}

function _renderBlankNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const meta = GRAPH_MODULE_META[node.moduleKey] || { label: node.moduleKey || '空白节点', color: attr.color };
  const attrClass = ' graph-attr-' + attr.key;
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const busyClass = node.busy ? ' graph-blank-busy' : '';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const content = _cleanBlankNodeContent(node, node.content || '');
  const contentHtml = content
    ? '<div class="graph-blank-content">' + (typeof renderMarkdown === 'function' ? renderMarkdown(content, { sourceModule: node.moduleKey }) : escapeHtml(content)) + '</div>'
    : '';
  const generateLabel = content ? '重新生成' : '生成';
  const deleteBtn = '<button class="graph-node-delete-toggle" onclick="deleteBlankNode(\'' + node.id + '\')" title="删除空白节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  return '<div class="graph-node graph-node-blank graph-node-module graph-module-' + node.moduleKey + attrClass + selectedClass + busyClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + customWidth + customHeight + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">空白节点</span>' + deleteBtn + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(meta.label) + '</div>'
    + contentHtml
    + '<div class="graph-blank-requirement">'
    + '<textarea class="graph-blank-input" rows="2" placeholder="输入额外要求" ' + (node.busy ? 'disabled' : '') + '>' + escapeHtml(node.requirements || '') + '</textarea>'
    + _iconRegenButton('generateBlankNode(\'' + node.id + '\')', node.busy ? '生成中' : generateLabel, node.busy)
    + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _cleanBlankNodeContent(node, rawContent) {
  const text = String(rawContent || '');
  if (typeof parseXmlSections === 'function') {
    const sections = parseXmlSections(text);
    if (sections && sections[node.moduleKey]) return _stripModuleHeading(sections[node.moduleKey], node.moduleKey);
    if ((node.moduleKey === 'socratic' || node.moduleKey === 'learn') && sections && sections.extend) {
      const split = _splitExtendSections(sections.extend);
      if (split[node.moduleKey]) return _stripModuleHeading(split[node.moduleKey], node.moduleKey);
    }
  }
  return text;
}

function _renderCustomNodeContentHtml(node) {
  let text = String(node.kind === 'answer' && !node.manual ? (node.analysis || node.content || '') : (node.content || ''));
  if (node.kind === 'module') text = _cleanBlankNodeContent(node, text);
  else if ((node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note') && typeof stripXmlTags === 'function') text = stripXmlTags(text);
  if (typeof renderMarkdown === 'function') {
    return renderMarkdown(text, { sourceModule: node.moduleKey || '' });
  }
  return escapeHtml(text);
}

function _refreshWorkflowNodeUi(node) {
  if (!node || !graphInner) return;
  const currentEl = graphInner.querySelector('[data-node-id="' + node.id + '"]');
  if (!currentEl) return;
  const nextHtml = _renderNodeHtml(node, _getChatHistory(), _graphState());
  const temp = document.createElement('div');
  temp.innerHTML = nextHtml;
  const nextEl = temp.firstElementChild;
  if (nextEl) {
    currentEl.replaceWith(nextEl);
    _measureNodes();
    _updateNodeTransforms();
    _redrawEdges();
  }
}

function _customNodeStatusText(node) {
  if (node.kind === 'ai_eval') {
    return node.status === 'applied' ? '已采纳' : '待采纳';
  }
  if (node.kind === 'source') {
    if (node.busy || node.status === 'running') return '解析中';
    return node.items && node.items.length ? '已解析' : '待解析';
  }
  if (node.kind === 'knowledge') {
    if (node.busy || node.status === 'running') return '生成中';
    return (node.content || '').trim() ? '已填写' : '待填写';
  }
  if (node.kind === 'relation') {
    if (node.busy || node.status === 'running') return '生成联系中';
    return (node.content || '').trim() ? '已编辑' : '待编辑';
  }
  if (node.kind === 'hub') {
    const connected = (graphView.edges || []).some(edge => edge.to === node.id && !edge.draft);
    return connected ? '已汇聚' : '等待连接';
  }
  if (node.manual) return (node.content || '').trim() ? '完成' : '待填写';
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) {
    if (node.busy || node.status === 'running') return '分析中';
    return '分发';
  }
  if (node.busy || node.status === 'running') return '生成中';
  if (node.status === 'waiting') return '等待输入';
  if (node.status === 'error') return '失败';
  if (node.status === 'done' || ((node.content || '').trim() && !node.status)) return '完成';
  return '待生成';
}

function _customNodeHeaderHtml(node, attr, extraButtons) {
  const sub = _nodeSub(node);
  const statusText = node.messageIndex < 0 ? _customNodeStatusText(node) : '';
  const statusHtml = statusText
    ? '<span class="graph-node-status status-' + (node.busy ? 'running' : node.status || 'empty') + '">' + escapeHtml(statusText) + '</span>'
    : '';
  return '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>'
    + (sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '')
    + statusHtml
    + (extraButtons || '')
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>'
    + '</div>';
}

function _renderSourceNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const sizeStyle = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const fileName = node.fileName ? '<div class="graph-source-filename">' + escapeHtml(node.fileName) + '</div>' : '';
  const itemCount = node.items && node.items.length ? '<div class="graph-source-count">' + node.items.length + ' 个知识点</div>' : '';
  const body = node.busy
    ? '<div class="graph-source-busy"><span class="graph-source-spinner"></span>正在解析文件...</div>'
    : '<div class="graph-source-body" ondragover="event.preventDefault();this.classList.add(\'graph-source-drag\')" ondragleave="this.classList.remove(\'graph-source-drag\')" ondrop="handleSourceNodeDrop(event,\'' + node.id + '\')">'
      + '<label class="graph-source-file-btn">选择/拖入文件<input type="file" class="graph-source-file-input" onchange="handleSourceNodeFile(this,\'' + node.id + '\')"></label>'
      + '<div class="graph-source-controls"><label>最多 <input type="number" class="graph-source-max-input" min="1" max="50" value="' + (node.maxItems || 5) + '" onchange="updateSourceNodeMax(\'' + node.id + '\',this.value)"></label>'
      + (node.fileId ? _iconRegenButton('reparseSourceNode(\'' + node.id + '\')', '重新解析', false) : '')
      + '</div>' + fileName + itemCount
      + '</div>';
  return '<div class="graph-node graph-node-source graph-attr-source' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + _customNodeHeaderHtml(node, attr, '')
    + '<div class="graph-node-label">输入</div>'
    + (body ? '<div class="graph-node-full-content">' + body + '</div>' : '')
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderKnowledgeNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const sizeStyle = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const formulas = (node.formulas || []).slice(0, 4).map(f => {
    const latex = String(f || '').replace(/^\$+|\$+$/g, '').trim();
    let latexHtml = escapeHtml(latex);
    try {
      if (window.katex) latexHtml = katex.renderToString(latex, { throwOnError: false, displayMode: false });
    } catch (e) {}
    return '<div class="graph-knowledge-formula">' + latexHtml + '</div>';
  }).join('');
  const body = '<div class="graph-knowledge-body">'
    + (formulas ? '<div class="graph-knowledge-formulas">' + formulas + '</div>' : '')
    + '<textarea class="graph-custom-node-content" rows="3" onchange="updateCustomNodeContent(\'' + node.id + '\',this.value)">' + escapeHtml(node.content || node.summary || '') + '</textarea>'
    + '<div class="graph-knowledge-actions">' + _iconRegenButton('generateKnowledgeNode(\'' + node.id + '\')', node.busy ? '生成中' : '重新生成', node.busy) + '</div>'
    + '</div>';
  return '<div class="graph-node graph-node-knowledge graph-attr-knowledge' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + _customNodeHeaderHtml(node, attr, '')
    + '<div class="graph-node-label">' + escapeHtml(node.title || '知识点') + '</div>'
    + '<div class="graph-node-full-content">' + body + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderRelationNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const sizeStyle = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const statusText = _customNodeStatusText(node);
  const statusHtml = '<span class="graph-node-status status-' + (node.busy ? 'running' : node.status || 'empty') + '">' + escapeHtml(statusText) + '</span>';
  const body = '<div class="graph-relation-body">'
    + '<textarea class="graph-custom-node-content" rows="2" onchange="updateCustomNodeContent(\'' + node.id + '\',this.value)" placeholder="联系说明">' + escapeHtml(node.content || '') + '</textarea>'
    + '<div class="graph-relation-actions">'
    + statusHtml
    + _iconRegenButton('generateRelationNode(\'' + node.id + '\')', node.busy ? '生成中' : '生成联系', node.busy)
    + '</div></div>';
  return '<div class="graph-node graph-node-relation graph-attr-relation graph-node-compact' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-full-content">' + body + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderHumanNoteNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const statusText = (node.content || '').trim() ? '已填写' : '待填写';
  const body = (node.content || node.formula)
    ? '<div class="graph-custom-node-render">' + escapeHtml(node.content || '')
      + (node.formula ? '<div class="graph-human-note-formula">' + escapeHtml(node.formula) + '</div>' : '')
      + '</div>'
    : '<div class="graph-custom-node-empty">双击编辑</div>';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  return '<div class="graph-node graph-node-human-note graph-attr-human_note' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + customWidth + customHeight + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header">'
    + '<span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">我的理解</span>'
    + '<span class="graph-node-badge">人工</span>'
    + '<button class="graph-node-edit-toggle" onclick="editHumanNoteNode(\'' + node.id + '\')" title="编辑我的理解"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>'
    + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(node.label || '我的理解') + '</div>'
    + '<div class="graph-node-sub">' + escapeHtml(statusText) + '</div>'
    + (body ? '<div class="graph-node-full-content">' + body + '</div>' : '')
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state)
    + '</div>';
}

function _renderAiEvalNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const targetLabel = node.target_label || node.label || '目标节点';
  const priorityMap = { high: '高优先级', medium: '中优先级', low: '低优先级' };
  const priorityLabel = priorityMap[node.priority] || '';
  const priorityHtml = priorityLabel
    ? '<span class="graph-ai-eval-priority priority-' + escapeHtml(node.priority || 'medium') + '">' + escapeHtml(priorityLabel) + '</span>'
    : '';
  const body = '<div class="graph-ai-eval-suggestion">' + escapeHtml(node.suggestion || node.content || '') + '</div>' + priorityHtml;
  const evalActions = '<button class="graph-ai-eval-accept" onclick="acceptAiEvalNode(\'' + node.id + '\')" title="采纳这条建议">采纳</button>'
    + '<button class="graph-ai-eval-ignore" onclick="ignoreAiEvalNode(\'' + node.id + '\')" title="忽略这条建议">忽略</button>';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const zigzag = '<svg class="graph-ai-eval-zigzag" width="100%" height="100%" aria-hidden="true">'
    + '<polygon class="graph-ai-eval-zigzag-shape" points="0 0"></polygon>'
    + '</svg>';
  return '<div class="graph-node graph-node-ai-eval graph-attr-ai_eval' + selectedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + customWidth + customHeight + '">'
    + zigzag
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + _customNodeHeaderHtml(node, attr, evalActions)
    + '<div class="graph-node-label">对「' + escapeHtml(targetLabel) + '」的建议</div>'
    + '<div class="graph-node-full-content">' + body + '</div>'
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + _renderOutputPorts(node, [], state || _graphState())
    + '</div>';
}

function _renderNodeHtml(node, messages, state) {
  if (node.kind === 'blank') return _renderBlankNodeHtml(node, state);
  if (node.kind === 'draft') return _renderDraftNodeHtml(node);
  if (node.kind === 'source') return _renderSourceNodeHtml(node, state);
  if (node.kind === 'knowledge') return _renderKnowledgeNodeHtml(node, state);
  if (node.kind === 'relation') return _renderRelationNodeHtml(node, state);
  if (node.kind === 'human_note') return _renderHumanNoteNodeHtml(node, state);
  if (node.kind === 'ai_eval') return _renderAiEvalNodeHtml(node, state);
  const message = messages[node.messageIndex];
  const baseClass = 'graph-node graph-node-' + node.kind;
  const attr = _nodeAttribute(node);
  const attrClass = ' graph-attr-' + attr.key;
  const modClass = node.moduleKey ? ' graph-node-module graph-module-' + node.moduleKey : '';
  const rootClass = node.isRoot ? ' graph-node-root' : '';
  const branchClass = node.isBranch ? ' graph-node-branch' : '';
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const dimmedClass = node.hidden ? ' dimmed' : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const resizedClass = node.customHeight ? ' resized' : '';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const badge = node.isRoot ? '核心问题' : (node.isBranch ? '延伸追问' : (node.kind === 'answer' ? (node.manual ? '非 AI 回答' : 'AI 回答簇') : ''));
  const badgeHtml = badge ? '<span class="graph-node-badge">' + escapeHtml(badge) + '</span>' : '';
  const label = node.kind === 'module'
    ? ((GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey)
    : node.kind === 'hub'
      ? '汇聚'
      : node.kind === 'summary'
        ? 'AI 总结'
        : node.kind === 'note'
          ? '人工总结'
          : (node.kind === 'answer' && node.messageIndex < 0
            ? (node.manual ? '非 AI 回答' : 'AI 回答')
            : _nodeContent(message, node));
  const hasCustomContent = !!((node.content || '').trim() || (node.kind === 'answer' && !node.manual && (node.analysis || '').trim()));
  const customFill = node.messageIndex < 0 && node.manual && !hasCustomContent
    ? '<textarea class="graph-custom-node-content" rows="5" onchange="updateCustomNodeContent(\'' + node.id + '\', this.value)">' + escapeHtml(_nodeContent(message, node)) + '</textarea>'
    : '';
  const customBody = node.messageIndex < 0
    ? (customFill
        || ((node.kind === 'module' || node.kind === 'summary')
          ? (hasCustomContent
              ? '<div class="graph-custom-node-render">' + _renderCustomNodeContentHtml(node) + '</div>'
              : (node.busy || node.status === 'running'
                  ? '<div class="graph-custom-node-render"></div>'
                  : '<div class="graph-custom-node-empty">等待生成</div>'))
          : (node.kind === 'answer' && !node.manual
              ? (hasCustomContent
                  ? '<div class="graph-custom-node-render">' + _renderCustomNodeContentHtml(node) + '</div>'
                  : (node.busy || node.status === 'running'
                      ? '<div class="graph-custom-node-render"></div>'
                      : '<div class="graph-custom-node-empty">等待分析</div>'))
              : ((node.kind === 'answer' || node.kind === 'note') && node.manual
              ? (hasCustomContent
                  ? '<div class="graph-custom-node-render">' + _renderCustomNodeContentHtml(node) + '</div>'
                  : '')
              : ''))))
    : '';
  const body = node.kind === 'module'
    ? (customBody || (typeof renderMarkdown === 'function' ? renderMarkdown(_nodeContent(message, node), { parentId: String(message.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(_nodeContent(message, node))))
    : ((node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note') ? customBody : '');
  const sub = _nodeSub(node);
  const subHtml = sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '';
  const statusText = node.messageIndex < 0 ? _customNodeStatusText(node) : '';
  const statusHtml = statusText
    ? '<span class="graph-node-status status-' + (node.busy ? 'running' : node.status || 'empty') + '">' + escapeHtml(statusText) + '</span>'
    : '';
  const minimizeToggle = node.messageIndex >= 0 && (node.kind === 'module' || node.kind === 'answer')
    ? '<button class="graph-node-minimize-toggle" onclick="graphModuleAction(\'minimize\',\'' + node.id + '\')" title="' + (node.minimized ? '展开' : '最小化') + '">' + (node.minimized ? '+' : '−') + '</button>'
    : '';
  const editBtn = node.kind === 'module'
    ? '<button class="graph-node-edit-toggle" onclick="editModuleNode(\'' + node.id + '\')" title="人工编辑模块"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
    : '';
  const deleteAction = node.messageIndex < 0
    ? 'deleteCustomNode(\'' + node.id + '\')'
    : 'graphModuleAction(\'delete\',\'' + node.id + '\')';
  const deleteBtn = node.isRoot ? '' : '<button class="graph-node-delete-toggle" onclick="' + deleteAction + '" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  const quickConnectBtn = node.kind === 'hub'
    ? '<button class="graph-hub-connect-btn" onclick="event.stopPropagation();quickConnectToHub(\'' + node.id + '\')" title="一键接入选中节点输出"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path></svg></button>'
    : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const graphState = state || _graphState();
  const inputHtml = _renderInputPorts(node, graphState);
  const outputHtml = _renderOutputPorts(node, messages, graphState);
  const labelHtml = (node.kind === 'user' && node.messageIndex < 0)
    ? '<textarea class="graph-custom-question-input" rows="2" placeholder="输入问题..." onchange="updateCustomNodeContent(\'' + node.id + '\', this.value)">' + escapeHtml(label) + '</textarea>'
    : '<div class="graph-node-label">' + escapeHtml(label) + '</div>';
  return '<div class="' + baseClass + modClass + attrClass + rootClass + branchClass + selectedClass + dimmedClass + minimizedClass + resizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + inputHtml
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>' + badgeHtml + subHtml + statusHtml + minimizeToggle + editBtn + quickConnectBtn + deleteBtn + '</div>'
    + labelHtml
    + (body ? '<div class="graph-node-full-content">' + body + '</div>' : '')
    + _nodeActions(node)
    + '<span class="graph-resize-handle" title="调整尺寸"></span>'
    + '</div>'
    + outputHtml
    + '</div>';
}

function _measureNodes() {
  if (!graphInner) return;
  graphView.nodes.forEach(node => {
    const el = graphInner.querySelector('[data-node-id="' + node.id + '"]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    node.w = r.width / (graphView.zoom || 1);
    node.h = r.height / (graphView.zoom || 1);
    if (node.kind === 'ai_eval') _updateAiEvalZigzag(node);
  });
  _syncGroupMembersByContainment();
}

function clearGraphDiffHighlights() {
  graphInner?.querySelectorAll('.graph-diff-add, .graph-diff-update, .graph-diff-delete').forEach(el => {
    el.classList.remove('graph-diff-add', 'graph-diff-update', 'graph-diff-delete');
  });
}

function applyGraphDiffHighlights(ops) {
  clearGraphDiffHighlights();
  const addNodes = new Set();
  const updateNodes = new Set();
  const deleteNodes = new Set();
  const addEdges = new Set();
  const updateEdges = new Set();
  const deleteEdges = new Set();
  (ops || []).forEach(op => {
    const name = op.op || op.type || '';
    const nodeId = op.assigned_id || op.id;
    if (name === 'create_node' || name === 'create_eval_node') {
      if (nodeId) addNodes.add(nodeId);
    } else if (name === 'update_node') {
      if (nodeId) updateNodes.add(nodeId);
    } else if (name === 'delete_node') {
      if (nodeId) deleteNodes.add(nodeId);
    }
    const edgeKey = op.edge_key || op.key;
    if (name === 'add_edge') {
      if (edgeKey) addEdges.add(edgeKey);
    } else if (name === 'update_edge') {
      if (edgeKey) updateEdges.add(edgeKey);
    } else if (name === 'remove_edge') {
      if (edgeKey) deleteEdges.add(edgeKey);
    }
  });
  graphView.nodes.forEach(node => {
    const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
    if (!el) return;
    if (deleteNodes.has(node.id)) el.classList.add('graph-diff-delete');
    else if (updateNodes.has(node.id)) el.classList.add('graph-diff-update');
    else if (addNodes.has(node.id)) el.classList.add('graph-diff-add');
  });
  graphView.edges.forEach(edge => {
    const el = graphEdgeLayer?.querySelector('[data-edge-key="' + _edgeKey(edge) + '"]');
    if (!el) return;
    const key = _edgeKey(edge);
    if (deleteEdges.has(key)) el.classList.add('graph-diff-delete');
    else if (updateEdges.has(key)) el.classList.add('graph-diff-update');
    else if (addEdges.has(key)) el.classList.add('graph-diff-add');
  });
}

function clearGraphHarnessPreview() {
  graphView.previewNodes = [];
  graphView.previewEdges = [];
  graphCanvas?.querySelector('.graph-harness-preview-layer')?.remove();
}

function _renderGraphHarnessPreview() {
  if (!graphCanvas) return;
  graphCanvas.querySelector('.graph-harness-preview-layer')?.remove();
  if (!graphView.previewNodes.length && !graphView.previewEdges.length) return;

  const state = _graphState();
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const layer = document.createElement('div');
  layer.className = 'graph-harness-preview-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-harness-preview-layer-edges');
  layer.appendChild(svg);
  const previewById = new Map(graphView.previewNodes.map(node => [node.id, node]));

  graphView.previewEdges.forEach(edge => {
    const from = graphView.nodeById[edge.from] || previewById.get(edge.from);
    const to = graphView.nodeById[edge.to] || previewById.get(edge.to);
    if (!from || !to) return;
    const fromWidth = from.w || 220;
    const toWidth = to.w || 220;
    const x1 = pan.x + (from.x + fromWidth / 2) * zoom;
    const y1 = pan.y + from.y * zoom;
    const x2 = pan.x + (to.x - toWidth / 2) * zoom;
    const y2 = pan.y + to.y * zoom;
    const offset = Math.max(60, Math.min(180, Math.abs(x2 - x1) * 0.45));
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'graph-harness-preview-edge');
    path.setAttribute('data-preview-edge', _edgeKey(edge));
    path.setAttribute('d', 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1)
      + ' C' + (x1 + offset).toFixed(1) + ' ' + y1.toFixed(1)
      + ', ' + (x2 - offset).toFixed(1) + ' ' + y2.toFixed(1)
      + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1));
    svg.appendChild(path);
  });

  graphView.previewNodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'graph-harness-preview-node' + (node.kind === 'ai_eval' ? ' graph-harness-preview-eval' : '');
    el.dataset.previewId = node.id;
    const width = node.w || 220;
    const height = node.h || 80;
    el.style.width = Math.max(160, width * zoom) + 'px';
    el.style.transform = 'translate(' + (pan.x + (node.x - width / 2) * zoom) + 'px, '
      + (pan.y + (node.y - height / 2) * zoom) + 'px)';
    el.innerHTML = '<span class="graph-harness-preview-badge">待确认</span>'
      + '<span class="graph-harness-preview-label">' + escapeHtml(node.label || '新节点') + '</span>';
    layer.appendChild(el);
  });
  graphCanvas.appendChild(layer);
}

function _ensureGraphModeForPreview() {
  const app = document.querySelector('.app-container');
  if (!app || !app.classList.contains('linear-mode')) return false;
  const state = _graphState();
  state.linear = false;
  _saveGraphState(state);
  if (typeof applyLinearMode === 'function') applyLinearMode();
  if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
  return true;
}

function _harnessVisibleCanvasRect() {
  const canvasRect = graphCanvas?.getBoundingClientRect();
  if (!canvasRect || !canvasRect.width || !canvasRect.height) {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  const rect = {
    left: canvasRect.left,
    top: canvasRect.top,
    right: canvasRect.right,
    bottom: canvasRect.bottom,
    width: canvasRect.width,
    height: canvasRect.height,
  };
  const panel = document.querySelector('.graph-harness-window');
  if (panel && !panel.hidden) {
    const p = panel.getBoundingClientRect();
    const overlapLeft = Math.max(rect.left, p.left);
    const overlapRight = Math.min(rect.right, p.right);
    const overlapTop = Math.max(rect.top, p.top);
    const overlapBottom = Math.min(rect.bottom, p.bottom);
    if (overlapRight > overlapLeft && overlapBottom > overlapTop) {
      const leftW = overlapLeft - rect.left;
      const rightW = rect.right - overlapRight;
      const topH = overlapTop - rect.top;
      const bottomH = rect.bottom - overlapBottom;
      if (leftW >= rightW) rect.right = overlapLeft; else rect.left = overlapRight;
      if (topH >= bottomH) rect.bottom = overlapTop; else rect.top = overlapBottom;
      rect.width = Math.max(0, rect.right - rect.left);
      rect.height = Math.max(0, rect.bottom - rect.top);
    }
  }
  return rect;
}

function showGraphHarnessPreview(nodes, edges) {
  graphView.previewNodes = Array.isArray(nodes) ? nodes : [];
  graphView.previewEdges = Array.isArray(edges) ? edges : [];
  const switched = _ensureGraphModeForPreview();
  _renderGraphHarnessPreview();
  _centerGraphOnPreview();
  return switched;
}

function _centerGraphOnPreview() {
  if (!graphView.previewNodes.length || !graphCanvas) return;
  const state = _graphState();
  const canvasRect = graphCanvas.getBoundingClientRect();
  const rect = _harnessVisibleCanvasRect();
  const avgX = graphView.previewNodes.reduce((sum, node) => sum + (node.x || 0), 0) / graphView.previewNodes.length;
  const avgY = graphView.previewNodes.reduce((sum, node) => sum + (node.y || 0), 0) / graphView.previewNodes.length;
  const zoom = state.zoom || 0.9;
  state.pan.x = (rect.left - canvasRect.left) + rect.width / 2 - avgX * zoom;
  state.pan.y = (rect.top - canvasRect.top) + rect.height / 2 - avgY * zoom;
  _saveGraphState(state);
  _applyGraphTransform();
  _updateNodeTransforms();
  if (typeof _redrawEdges === 'function') _redrawEdges();
}
function _aiEvalZigzagPoints(w, h) {
  const step = 7;
  const depth = 6;
  const points = [];
  function edge(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const ux = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
    const uy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
    const ox = uy;
    const oy = -ux;
    const length = Math.abs(dx) + Math.abs(dy);
    let t = 0;
    points.push([x1, y1]);
    while (t < length) {
      const t1 = Math.min(t + step / 2, length);
      const t2 = Math.min(t + step, length);
      points.push([Math.round(x1 + ux * t1 + ox * depth), Math.round(y1 + uy * t1 + oy * depth)]);
      if (t2 > t1) points.push([x1 + ux * t2, y1 + uy * t2]);
      t = t2;
    }
  }
  edge(0, 0, w, 0);
  edge(w, 0, w, h);
  edge(w, h, 0, h);
  edge(0, h, 0, 0);
  return points.map(point => point.join(',')).join(' ');
}

function _updateAiEvalZigzag(node) {
  if (!node || !graphInner) return;
  const shape = graphInner.querySelector('[data-node-id="' + node.id + '"] .graph-ai-eval-zigzag-shape');
  if (!shape) return;
  shape.setAttribute('points', _aiEvalZigzagPoints(node.w || 260, node.h || 140));
}

function _updateNodeTransforms() {
  if (!graphInner) return;
  graphView.nodes.forEach(node => {
    const el = graphInner.querySelector('[data-node-id="' + node.id + '"]');
    if (el) el.style.transform = 'translate(' + (node.x - (node.w || 0) / 2) + 'px, ' + (node.y - (node.h || 0) / 2) + 'px)';
  });
}

function _clientToGraphLocal(clientX, clientY) {
  if (!graphInner) return { x: 0, y: 0 };
  const rect = graphInner.getBoundingClientRect();
  const zoom = graphView.zoom || 1;
  return {
    x: (clientX - rect.left) / zoom,
    y: (clientY - rect.top) / zoom,
  };
}

function _portAnchor(node, portEl, isOutput) {
  if (portEl && graphInner) {
    const rect = portEl.getBoundingClientRect();
    const innerRect = graphInner.getBoundingClientRect();
    const zoom = graphView.zoom || 1;
    return {
      x: (rect.left + rect.width / 2 - innerRect.left) / zoom,
      y: (rect.top + rect.height / 2 - innerRect.top) / zoom,
    };
  }
  const halfW = (node.w || 120) / 2;
  return {
    x: node.x + (isOutput ? halfW : -halfW),
    y: node.y,
  };
}

function _linkDragPathHtml() {
  const drag = graphView.linkDrag;
  if (!drag || drag.currentX == null) return '';
  const sourceNode = graphView.nodeById[drag.nodeId];
  if (!sourceNode) return '';
  const sourceEl = graphInner?.querySelector('[data-node-id="' + drag.nodeId + '"][data-port-id="' + drag.portId + '"]');
  const p1 = _portAnchor(sourceNode, sourceEl, drag.mode !== 'input');
  const p2 = { x: drag.currentX, y: drag.currentY };
  const offset = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  const d = 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + (p1.x + offset).toFixed(1) + ' ' + p1.y.toFixed(1)
    + ', ' + (p2.x - offset).toFixed(1) + ' ' + p2.y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
  return '<path d="' + d + '" class="graph-edge graph-link-drag"></path>';
}

function _redrawEdges() {
  if (!graphEdgeLayer) return;
  const html = graphView.edges.map(edge => {
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) return '';
    const sourceEl = graphInner?.querySelector('[data-node-id="' + edge.from + '"][data-port-id="' + edge.fromPort + '"]');
    const targetEl = graphInner?.querySelector('[data-node-id="' + edge.to + '"][data-port-id="' + edge.toPort + '"]');
    const p1 = _portAnchor(a, sourceEl, true);
    const p2 = _portAnchor(b, targetEl, false);
    const offset = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
    const d = 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
      + ' C' + (p1.x + offset).toFixed(1) + ' ' + p1.y.toFixed(1)
      + ', ' + (p2.x - offset).toFixed(1) + ' ' + p2.y.toFixed(1)
      + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
    const cls = 'graph-edge' + (edge.custom ? ' graph-edge-custom' : '');
    const label = (edge.relation || edge.label || '').toString().trim();
    const hintHtml = label
      ? '<title>' + escapeHtml(label) + '</title>'
      : '';
    return '<g class="' + cls + '" data-edge-key="' + _edgeKey(edge) + '" title="双击删除连线">'
      + '<path d="' + d + '"></path>'
      + hintHtml
      + '</g>';
  }).join('');
  graphEdgeLayer.innerHTML = html + _linkDragPathHtml();
}

function _savePositions() {
  _syncGroupMembersByContainment();
  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = state.positions || {};
  state.sizes = state.sizes || {};
  graphView.nodes.forEach(n => {
    state.positions[n.id] = n.pinned && n.fixedX != null ? { x: n.fixedX, y: n.fixedY } : { x: n.x, y: n.y };
    state.sizes[n.id] = { w: n.customWidth || n.w || 120, h: n.customHeight || n.h || 60 };
  });
  state.groups = graphView.groups.map(group => ({ ...group }));
  state.customNodes = graphView.nodes
    .filter(node => node.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(node.kind))
    .map(node => ({ ...node }));
  _saveGraphState(state);
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
}

function _tick() {
  const nodes = graphView.nodes;
  const edges = graphView.edges;
  if (!nodes.length) return;

  const kRepulse = 9000;
  const kAttract = 0.05;
  const kRadial = 0.006;
  const kCenter = 0.0002;
  const damping = 0.88;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.isRoot) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      const area = Math.max(1, Math.sqrt(((a.w || 120) * (a.h || 60)) * ((b.w || 120) * (b.h || 60))) / 1200);
      const f = kRepulse * Math.max(1, area) / (d * d);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  for (const edge of edges) {
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) continue;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let d = Math.sqrt(dx * dx + dy * dy) || 1;
    const target = edge.type === 'primary' ? 320 : 420;
    const f = (d - target) * kAttract;
    const fx = (dx / d) * f;
    const fy = (dy / d) * f;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }

  for (const n of nodes) {
    if (n.isRoot || n.pinned) continue;
    const targetR = TARGET_R[n.depth] || 1800;
    const ix = targetR * Math.cos(n.targetAngle);
    const iy = targetR * Math.sin(n.targetAngle);
    n.vx += (ix - n.x) * kRadial;
    n.vy += (iy - n.y) * kRadial;
    n.vx -= n.x * kCenter;
    n.vy -= n.y * kCenter;
  }

  const root = nodes.find(n => n.isRoot);
  if (root) { root.vx = 0; root.vy = 0; root.x = 0; root.y = 0; }

  for (const n of nodes) {
    if (n.isRoot) continue;
    if (n.id === graphView.dragNodeId) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    if (n.pinned) {
      n.x = n.fixedX;
      n.y = n.fixedY;
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx *= damping;
    n.vy *= damping;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 14) { n.vx = (n.vx / speed) * 14; n.vy = (n.vy / speed) * 14; }
    n.x += n.vx;
    n.y += n.vy;
  }
}

function _runLayout(needsFit) {
  if (!graphView.nodes.length) return;
  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    _tick();
  }
  _updateNodeTransforms();
  _fitAllGroupsToMembers();
  _redrawEdges();
  _savePositions();
  if (needsFit) fitGraph();
}

function _layoutChildMap(nodes, edges) {
  const byId = {};
  const children = {};
  const childPorts = {};
  nodes.forEach(node => {
    byId[node.id] = node;
    children[node.id] = [];
  });
  edges.forEach(edge => {
    const from = byId[edge.from];
    const to = byId[edge.to];
    if (!from || !to || from.kind === 'draft' || to.kind === 'draft') return;
    if (!children[edge.from].includes(edge.to)) children[edge.from].push(edge.to);
    childPorts[edge.from] = childPorts[edge.from] || {};
    childPorts[edge.from][edge.to] = edge.fromPort || 'out-0';
  });
  return { byId, children, childPorts };
}

function _layoutBfsDepths(roots, children, byId) {
  const depths = {};
  const queue = [];
  roots.forEach(root => {
    depths[root.id] = 0;
    queue.push(root.id);
  });
  while (queue.length) {
    const id = queue.shift();
    const nextDepth = (depths[id] || 0) + 1;
    for (const childId of (children[id] || [])) {
      if (!byId[childId]) continue;
      if (depths[childId] == null || nextDepth < depths[childId]) {
        depths[childId] = nextDepth;
        queue.push(childId);
      }
    }
  }
  return depths;
}

function _layoutSubtreeWeight(nodeId, children, weights, visited) {
  if (visited.has(nodeId)) return 0;
  visited.add(nodeId);
  let weight = 1;
  for (const childId of (children[nodeId] || [])) {
    weight += _layoutSubtreeWeight(childId, children, weights, visited);
  }
  weights[nodeId] = weight;
  return weight;
}

function _placeTreeSubtree(
  nodeId,
  x,
  top,
  bottom,
  colGap,
  children,
  weights,
  byId,
  placed,
  childPorts
) {
  const node = byId[nodeId];
  if (!node || placed.has(nodeId) || node.kind === 'draft') return;
  placed.add(nodeId);
  node.x = x;
  node.y = (top + bottom) / 2;

  const kids = (children[nodeId] || [])
    .filter(childId => byId[childId] && !placed.has(childId))
    .sort((a, b) => {
      const portA = String(childPorts?.[nodeId]?.[a] || 'out-0');
      const portB = String(childPorts?.[nodeId]?.[b] || 'out-0');
      const portDiff = portA.localeCompare(portB, undefined, { numeric: true });
      return portDiff || ((byId[a].timestamp || 0) - (byId[b].timestamp || 0));
    });
  const totalWeight = kids.length || 1;
  const verticalSpan = bottom - top;
  let cursor = top;
  for (const childId of kids) {
    const childWeight = 1;
    const childTop = cursor;
    const childBottom = cursor + verticalSpan * (childWeight / totalWeight);
    _placeTreeSubtree(
      childId,
      x + colGap,
      childTop,
      childBottom,
      colGap,
      children,
      weights,
      byId,
      placed,
      childPorts
    );
    cursor = childBottom;
  }
}

function _resolveLayoutCollisions(nodes, preservePinned) {
  const active = nodes.filter(node => node.kind !== 'draft' && !node.isRoot && !(preservePinned && node.pinned));
  const gap = 20;
  for (let pass = 0; pass < 40; pass++) {
    let moved = false;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minX = ((a.w || 120) + (b.w || 120)) / 2 + gap;
        const minY = ((a.h || 60) + (b.h || 60)) / 2 + gap;
        const overlapX = minX - Math.abs(dx);
        const overlapY = minY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const signX = dx >= 0 ? 1 : -1;
        const signY = dy >= 0 ? 1 : -1;
        if (overlapX < overlapY) {
          const push = overlapX * 0.8;
          if (!a.pinned) { a.x -= signX * push; moved = true; }
          if (!b.pinned) { b.x += signX * push; moved = true; }
        } else {
          const push = overlapY * 0.8;
          if (!a.pinned) { a.y -= signY * push; moved = true; }
          if (!b.pinned) { b.y += signY * push; moved = true; }
        }
      }
    }
    if (!moved) break;
  }
}

function _arrangeGroupMembers() {
  for (const group of (graphView.groups || [])) {
    const members = (group.nodeIds || [])
      .map(id => graphView.nodeById[id])
      .filter(node => node && node.kind !== 'draft');
    if (!members.length) continue;
    const centerX = members.reduce((sum, node) => sum + node.x, 0) / members.length;
    const centerY = members.reduce((sum, node) => sum + node.y, 0) / members.length;
    const maxW = Math.max(140, ...members.map(node => node.w || 120));
    const maxH = Math.max(80, ...members.map(node => node.h || 60));
    const cols = Math.max(1, Math.ceil(Math.sqrt(members.length)));
    const rows = Math.ceil(members.length / cols);
    const gapX = 36;
    const gapY = 48;
    const gridW = cols * maxW + (cols - 1) * gapX;
    const gridH = rows * maxH + (rows - 1) * gapY;
    const startX = centerX - gridW / 2;
    const startY = centerY - gridH / 2;
    members.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    members.forEach((node, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      node.x = startX + col * (maxW + gapX) + maxW / 2;
      node.y = startY + row * (maxH + gapY) + maxH / 2;
      node.pinned = true;
      node.fixedX = node.x;
      node.fixedY = node.y;
    });
    _fitGroupToMembers(group);
  }
}

function _layoutByLevel(nodes, edges, depths, colGap, rowHeight) {
  const parentByNode = {};
  const portByNode = {};
  edges.forEach(edge => {
    if (!parentByNode[edge.to]) {
      parentByNode[edge.to] = edge.from;
      portByNode[edge.to] = edge.fromPort || 'out-0';
    }
  });
  const levels = {};
  nodes.forEach(node => {
    if (node.kind === 'draft') return;
    const depth = depths[node.id] != null ? depths[node.id] : -1;
    (levels[depth] = levels[depth] || []).push(node);
  });
  const levelKeys = Object.keys(levels)
    .filter(key => Number(key) >= 0)
    .sort((a, b) => Number(a) - Number(b));
  const maxDepth = levelKeys.length ? Number(levelKeys[levelKeys.length - 1]) : 0;
  for (const key of levelKeys) {
    const level = levels[key].slice().sort((a, b) => {
      const parentA = parentByNode[a.id] || '';
      const parentB = parentByNode[b.id] || '';
      if (parentA !== parentB) return parentA < parentB ? -1 : 1;
      const portA = String(portByNode[a.id] || 'out-0');
      const portB = String(portByNode[b.id] || 'out-0');
      const portDiff = portA.localeCompare(portB, undefined, { numeric: true });
      return portDiff || ((a.timestamp || 0) - (b.timestamp || 0));
    });
    level.forEach((node, index) => {
      node.x = Number(key) * colGap;
      node.y = (index - (level.length - 1) / 2) * rowHeight;
    });
  }
  const disconnected = levels[-1] || [];
  if (disconnected.length) {
    const rows = Math.max(1, Math.ceil(Math.sqrt(disconnected.length)));
    const startX = (maxDepth + 1) * colGap;
    disconnected
      .slice()
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .forEach((node, index) => {
        node.x = startX + Math.floor(index / rows) * colGap;
        node.y = ((index % rows) - (rows - 1) / 2) * rowHeight;
      });
  }
}

function autoArrangeGraph(preservePinned = false) {
  if (!graphView.nodes.length) return;
  _pushGraphUndo();
  _measureNodes();
  graphView.nodes.forEach(node => {
    node.pinned = false;
    node.fixedX = null;
    node.fixedY = null;
  });

  const { byId, children, childPorts } = _layoutChildMap(graphView.nodes, graphView.edges);
  const roots = graphView.nodes.filter(node => node.isRoot && node.kind !== 'draft');
  if (!roots.length) {
    const firstUser = graphView.nodes.find(node => node.kind === 'user');
    if (firstUser) roots.push(firstUser);
  }
  if (!roots.length && graphView.nodes.length) roots.push(graphView.nodes[0]);
  const depths = _layoutBfsDepths(roots, children, byId);

  const maxNodeW = Math.max(
    160,
    ...graphView.nodes
      .filter(node => node.kind !== 'draft')
      .map(node => node.w || 120)
  );
  const maxNodeH = Math.max(
    120,
    ...graphView.nodes
      .filter(node => node.kind !== 'draft')
      .map(node => node.h || 60)
  );
  const colGap = Math.max(420, maxNodeW + 140);
  const rowHeight = Math.max(300, maxNodeH * 0.55 + 60);
  _layoutByLevel(graphView.nodes, graphView.edges, depths, colGap, rowHeight);

  _resolveLayoutCollisions(graphView.nodes, false);
  _arrangeGroupMembers();
  _resolveLayoutCollisions(graphView.nodes, false);
  graphView.nodes.forEach(node => {
    node.pinned = false;
    node.fixedX = null;
    node.fixedY = null;
  });
  _fitAllGroupsToMembers();
  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = {};
  state.pinned = {};
  graphView.nodes.forEach(node => {
    if (node.kind === 'draft') return;
    state.positions[node.id] = { x: node.x, y: node.y };
  });
  _saveGraphState(state);
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
  _updateNodeTransforms();
  _redrawEdges();
  fitGraph();
}

function _applyGraphTransform() {
  if (!graphInner) return;
  const state = _graphState();
  graphInner.style.transform = 'translate(' + state.pan.x + 'px, ' + state.pan.y + 'px) scale(' + state.zoom + ')';
  graphView.zoom = state.zoom;
  if (graphView.previewNodes.length || graphView.previewEdges.length) _renderGraphHarnessPreview();
}

function _patchGraphStreaming(messages, state) {
  if (!graphInner) return;
  const data = _buildGraphData(messages, state);
  const nextIds = new Set(data.nodes.map(n => n.id));
  const oldById = graphView.nodeById || {};

  graphInner.querySelectorAll('.graph-node').forEach(el => {
    if (!nextIds.has(el.dataset.nodeId)) el.remove();
  });

  const nextNodes = [];
  const nextById = {};
  for (const next of data.nodes) {
    const old = oldById[next.id];
    const existingEl = graphInner.querySelector('[data-node-id="' + next.id + '"]');
    if (old && existingEl) {
      const oldX = old.x;
      const oldY = old.y;
      const oldW = old.w;
      const oldH = old.h;
      const oldFixedX = old.fixedX;
      const oldFixedY = old.fixedY;
      const oldPinned = old.pinned;
      const oldCustomWidth = old.customWidth;
      const oldCustomHeight = old.customHeight;
      Object.assign(old, next, {
        x: oldX,
        y: oldY,
        w: oldW,
        h: oldH,
        fixedX: oldFixedX,
        fixedY: oldFixedY,
        pinned: oldPinned,
        customWidth: oldCustomWidth,
        customHeight: oldCustomHeight,
      });

      const nextHtml = _renderNodeHtml(old, messages, state);
      const tmp = document.createElement('div');
      tmp.innerHTML = nextHtml;
      const nextEl = tmp.firstElementChild;
      const bodyChanged = (nextEl.querySelector('.graph-node-full-content')?.innerHTML || '')
        !== (existingEl.querySelector('.graph-node-full-content')?.innerHTML || '');
      const labelChanged = (nextEl.querySelector('.graph-node-label')?.innerHTML || '')
        !== (existingEl.querySelector('.graph-node-label')?.innerHTML || '');
      const subChanged = (nextEl.querySelector('.graph-node-sub')?.innerHTML || '')
        !== (existingEl.querySelector('.graph-node-sub')?.innerHTML || '');
      const nextInputHtml = nextEl.querySelector('.graph-input-col')?.outerHTML || '';
      const oldInputHtml = existingEl.querySelector('.graph-input-col')?.outerHTML || '';
      const nextOutputHtml = nextEl.querySelector('.graph-output-col')?.outerHTML || '';
      const oldOutputHtml = existingEl.querySelector('.graph-output-col')?.outerHTML || '';
      if (nextInputHtml !== oldInputHtml) {
        existingEl.querySelector('.graph-input-col')?.remove();
        if (nextInputHtml) existingEl.insertAdjacentHTML('afterbegin', nextInputHtml);
      }
      if (nextOutputHtml !== oldOutputHtml) {
        existingEl.querySelector('.graph-output-col')?.remove();
        if (nextOutputHtml) existingEl.insertAdjacentHTML('beforeend', nextOutputHtml);
      }
      if (labelChanged) {
        const labelEl = existingEl.querySelector('.graph-node-label');
        const nextLabelEl = nextEl.querySelector('.graph-node-label');
        if (labelEl && nextLabelEl) labelEl.innerHTML = nextLabelEl.innerHTML;
      }
      if (subChanged) {
        const subEl = existingEl.querySelector('.graph-node-sub');
        const nextSubEl = nextEl.querySelector('.graph-node-sub');
        if (subEl && nextSubEl) subEl.innerHTML = nextSubEl.innerHTML;
      }
      if (bodyChanged) {
        const bodyEl = existingEl.querySelector('.graph-node-full-content');
        const nextBodyEl = nextEl.querySelector('.graph-node-full-content');
        if (nextBodyEl) {
          if (bodyEl) bodyEl.innerHTML = nextBodyEl.innerHTML;
          else existingEl.insertAdjacentHTML('beforeend', nextBodyEl.outerHTML);
        } else if (bodyEl) {
          bodyEl.remove();
        }
      }
      const nextBlankContent = nextEl.querySelector('.graph-blank-content');
      const oldBlankContent = existingEl.querySelector('.graph-blank-content');
      if (nextBlankContent && oldBlankContent && nextBlankContent.innerHTML !== oldBlankContent.innerHTML) {
        oldBlankContent.innerHTML = nextBlankContent.innerHTML;
      } else if (nextBlankContent && !oldBlankContent) {
        existingEl.querySelector('.graph-blank-requirement')?.insertAdjacentHTML('beforebegin', nextBlankContent.outerHTML);
      } else if (!nextBlankContent && oldBlankContent) {
        oldBlankContent.remove();
      }
      const nextBlankInput = nextEl.querySelector('.graph-blank-input');
      const oldBlankInput = existingEl.querySelector('.graph-blank-input');
      if (nextBlankInput && oldBlankInput && nextBlankInput.value !== oldBlankInput.value) {
        oldBlankInput.value = nextBlankInput.value;
      }
      if (existingEl.className !== nextEl.className) {
        existingEl.className = nextEl.className;
      }
      nextNodes.push(old);
    } else {
      graphInner.insertAdjacentHTML('beforeend', _renderNodeHtml(next, messages, state));
      nextNodes.push(next);
    }
  }

  nextNodes.forEach(n => { nextById[n.id] = n; });
  graphView.nodes = nextNodes;
  graphView.nodeById = nextById;
  graphView.defaultEdges = data.edges;
  graphView.edges = _resolveGraphEdges(state, data.edges, nextById);
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function _scheduleGraphMermaidRender() {
  clearTimeout(_graphMermaidTimer);
  _graphMermaidTimer = setTimeout(() => {
    _graphMermaidTimer = null;
    if (typeof renderMermaidInElement === 'function') renderMermaidInElement(graphInner);
  }, 500);
}

function renderGraphCanvas(streaming) {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
  if (streaming) {
    clearTimeout(_graphMermaidTimer);
    _graphMermaidTimer = null;
  }
  const state = _graphState();
  const messages = _getChatHistory();
  graphView.selectedNodeIds = new Set();
  graphView.boxSelect = null;
  if (streaming && graphInner && graphView.nodes.length && messages.length) {
    _patchGraphStreaming(messages, state);
    return;
  }
  const appContainer = document.querySelector('.app-container');

  _removeSelectionBox();
  graphCanvas.innerHTML = '';
  graphView.nodes = [];
  graphView.edges = [];
  graphView.nodeById = {};
  if (!messages.length) {
    if (!(state.customNodes || []).length) {
      appContainer?.classList.add('graph-empty-active');
      graphView.selectMode = false;
      graphCanvas.innerHTML = `
        <div class="graph-new-session-wrap">
          <div class="graph-node graph-node-root graph-new-session-node">
            <div class="graph-node-header"><span class="graph-node-badge">新对话</span></div>
            <div class="graph-node-label">PhyMathia 探索网</div>
            <textarea class="graph-new-session-input" placeholder="问一个物理或数学问题..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();window.sendGraphNewSession(this)}"></textarea>
            <div class="graph-new-session-actions">
              <button class="graph-new-session-btn" onclick="sendGraphNewSession(this)">提问</button>
            </div>
          </div>
        </div>`;
      _applyGraphTextSelectionMode();
      return;
    }
    appContainer?.classList.remove('graph-empty-active');
  }
  appContainer?.classList.remove('graph-empty-active');

  const toolbar = document.createElement('div');
  toolbar.className = 'graph-canvas-toolbar';
  toolbar.innerHTML = '<button class="graph-tool-btn graph-search-btn" onclick="toggleGraphSearchPanel()" title="搜索节点" aria-label="搜索节点" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="zoomGraph(1.2)" title="放大">+</button>'
    + '<button class="graph-tool-btn" onclick="zoomGraph(0.85)" title="缩小">−</button>'
    + '<button class="graph-tool-btn" onclick="fitGraph()" title="适配画布">⌂</button>'
    + '<button class="graph-tool-btn graph-select-btn" onclick="graphToggleTextSelection()" title="选择文字" aria-label="选择文字" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8 4v16"></path><path d="M16 4v16"></path><path d="M12 2v20"></path>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="graphCreateGroup()" title="将选中节点创建为分组" aria-label="将选中节点创建为分组">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>'
    + '<line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-harness-btn" onclick="openGraphHarness()" title="AI 网络助手" aria-label="AI 网络助手">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="5" cy="6" r="2"></circle><circle cx="13" cy="5" r="2"></circle><circle cx="9" cy="13" r="2"></circle>'
    + '<path d="M6.7 7.2 11 11.6M7 5.9 11 5.2M10.8 12.2 13 6.9"></path>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="autoArrangeGraph()" title="自动整理">⌗</button>';
  graphCanvas.appendChild(toolbar);
  _applyGraphTextSelectionMode();
  _syncGraphSearchButtonState();
  if (graphSearchOpen) requestAnimationFrame(_performGraphSearch);

  graphInner = document.createElement('div');
  graphInner.className = 'graph-canvas-inner';
  graphCanvas.appendChild(graphInner);

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-edge-layer');
  svg.setAttribute('width', 1);
  svg.setAttribute('height', 1);
  graphEdgeLayer = svg;
  graphInner.appendChild(svg);

  const savedPositions = state.layoutVersion === LAYOUT_VERSION ? (state.positions || {}) : {};
  const needsFit = state.layoutVersion !== LAYOUT_VERSION || Object.keys(savedPositions).length === 0;

  const data = _buildGraphData(messages, state);
  graphView.defaultEdges = data.edges;
  graphView.nodes = data.nodes;
  graphView.nodeById = data.nodeById;
  graphView.edges = _resolveGraphEdges(state, data.edges, data.nodeById);
  graphView.groups = Array.isArray(state.groups) ? state.groups.map(group => ({ ...group })) : [];
  _syncGroupMembers();

  const html = graphView.groups.map(group => _renderGroupHtml(group)).join('')
    + graphView.nodes.map(n => _renderNodeHtml(n, messages, state)).join('');
  graphInner.insertAdjacentHTML('beforeend', html);

  _applyGraphTransform();

  requestAnimationFrame(() => {
    if (typeof renderMath === 'function') renderMath(graphInner);
    if (typeof _initVizIframes === 'function') _initVizIframes(graphInner);
    _measureNodes();
    if (needsFit) _runLayout(true);
    else _updateNodeTransforms();
    _redrawEdges();
    _renderGraphHarnessPreview();
    _scheduleGraphMermaidRender();
  });

  if (state.layoutVersion !== LAYOUT_VERSION) {
    state.layoutVersion = LAYOUT_VERSION;
    _saveGraphState(state);
  }
}

function sendGraphNewSession(el) {
  const node = el && el.closest ? el.closest('.graph-new-session-node') : null;
  const input = node && node.querySelector('.graph-new-session-input');
  const text = input ? input.value.trim() : '';
  if (text && typeof window.sendQuick === 'function') window.sendQuick(text);
}

function graphModuleAction(action, nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node) return;
  const messages = _getChatHistory();
  const message = messages[node.messageIndex];
  if (!message) return;
  const parentId = String(message.timestamp || '');
  if (action === 'followup') {
    if (typeof followUpModule === 'function') followUpModule(node.moduleKey, parentId);
  } else if (action === 'confused') {
    if (typeof dontUnderstandModule === 'function') dontUnderstandModule(node.moduleKey, parentId);
  } else if (action === 'delete') {
    if (confirm('确定删除这个节点及其子分支吗？') && typeof window.deleteGraphMessageByTimestamp === 'function') {
      _pushGraphUndo(true);
      window.deleteGraphMessageByTimestamp(message.timestamp);
    }
  } else if (action === 'minimize' && (node.kind === 'module' || node.kind === 'answer')) {
    const nextMinimized = !node.minimized;
    const moduleKey = node.kind === 'module' ? node.moduleKey : 'answer';
    if (typeof window.setModuleVisibility === 'function') {
      window.setModuleVisibility(parentId, moduleKey, 'collapsed', nextMinimized);
    }
    node.minimized = nextMinimized;
    const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
    if (el) {
      el.classList.toggle('minimized', nextMinimized);
      if (nextMinimized) {
        el.style.removeProperty('width');
        el.style.removeProperty('min-width');
        el.style.removeProperty('max-width');
        el.style.removeProperty('height');
        el.style.removeProperty('min-height');
      } else {
        if (node.customWidth) {
          el.style.setProperty('width', node.customWidth + 'px', 'important');
          el.style.setProperty('min-width', node.customWidth + 'px', 'important');
          el.style.setProperty('max-width', node.customWidth + 'px', 'important');
        }
        if (node.customHeight) {
          el.style.setProperty('height', node.customHeight + 'px', 'important');
          el.style.setProperty('min-height', node.customHeight + 'px', 'important');
        }
      }
      const toggle = el.querySelector('.graph-node-minimize-toggle');
      if (toggle) {
        toggle.textContent = nextMinimized ? '+' : '−';
        toggle.title = nextMinimized ? '展开' : '最小化';
      }
      _measureNodes();
      _updateNodeTransforms();
      _redrawEdges();
    }
  }
}

function _startLinkDrag(event, portEl) {
  event.preventDefault();
  event.stopPropagation();
  const nodeEl = portEl.closest('.graph-node');
  const node = nodeEl ? _findGraphNode(nodeEl.dataset.nodeId) : null;
  if (!node) return;
  const isInput = portEl.classList.contains('graph-input-port');
  const decodeAttr = (value) => {
    try { return value ? decodeURIComponent(value) : ''; } catch (e) { return value || ''; }
  };
  let itemMeta = null;
  if (portEl.dataset.portItem) {
    try { itemMeta = JSON.parse(decodeAttr(portEl.dataset.portItem)); } catch (e) { itemMeta = null; }
  }
  graphView.linkDrag = {
    mode: isInput ? 'input' : 'output',
    nodeId: node.id,
    portId: portEl.dataset.portId,
    portMeta: {
      type: portEl.dataset.portType || (isInput ? 'input' : 'branch'),
      branchType: portEl.dataset.portBranch || (isInput ? '' : 'followup'),
      attribute: portEl.dataset.attribute || '',
      question: decodeAttr(portEl.dataset.portQuestion),
      level: portEl.dataset.portLevel || '',
      label: decodeAttr(portEl.dataset.portLabel),
      item: itemMeta,
    },
    pointerId: event.pointerId,
    currentX: null,
    currentY: null,
  };
  graphView.pointerId = event.pointerId;
  graphView.moved = false;
  graphCanvas?.classList.add('linking');
  _redrawEdges();
}

function _connectPorts(fromNodeId, fromPort, toNodeId, toPort) {
  if (!fromNodeId || !toNodeId || fromNodeId === toNodeId) return;
  const fromNode = _findGraphNode(fromNodeId);
  const toNode = _findGraphNode(toNodeId);
  if (!_canConnect(fromNode, fromPort, toNode)) {
    _flashInvalidConnection();
    return;
  }
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  state.removedEdges = state.removedEdges || [];
  state.connections = state.connections.filter(c => {
    const sameSource = c.from === fromNodeId && (c.fromPort || 'out-0') === fromPort;
    const sameInput = c.to === toNodeId && (c.toPort || 'in-0') === toPort;
    return !sameSource && (toNode.kind !== 'hub' || !sameInput);
  });
  let resolvedToPort = toPort || 'in-0';
  if (toNode.kind === 'module') {
    const free = _freeModuleInputPort(state, toNodeId, resolvedToPort);
    resolvedToPort = free.port;
    state.inputPortCounts = state.inputPortCounts || {};
    state.inputPortCounts[toNodeId] = Math.max(state.inputPortCounts[toNodeId] || 0, free.index);
  }
  const edge = {
    from: fromNodeId,
    fromPort: fromPort || 'out-0',
    to: toNodeId,
    toPort: resolvedToPort,
    type: 'custom',
    custom: true,
  };
  state.removedEdges = state.removedEdges.filter(key => key !== _edgeKey(edge));
  state.connections.push(edge);
  _saveGraphState(state);
  graphView.edges = _resolveGraphEdges(state, graphView.defaultEdges || [], graphView.nodeById);
  _redrawEdges();
}

function _createKnowledgeNodeFromPort(sourceNode, sourcePortId, portMeta, x, y) {
  const item = portMeta.item || {};
  const state = _graphState();
  _pushGraphUndo();
  const nodeId = 'knowledge-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: nodeId,
    kind: 'knowledge',
    moduleKey: 'knowledge',
    manual: true,
    content: item.summary || item.title || '',
    status: 'done',
    summary: item.summary || '',
    analysis: '',
    analysisHash: '',
    inputHash: '',
    generatedAt: 0,
    requirements: '',
    busy: false,
    generated: false,
    maxItems: 0,
    items: [],
    edges: [],
    fileId: sourceNode.fileId || '',
    fileName: sourceNode.fileName || '',
    generatedNodeIds: [],
    title: item.title || '知识点',
    category: item.category || 'other',
    tags: item.tags || [],
    formulas: item.formulas || [],
    knowledgeKey: item.id || item.title || nodeId,
    sourceNodeId: sourceNode.id,
    x,
    y,
    depth: 3,
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 260,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNode.id,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _createQuestionNodeFromPort(sourceNode, sourcePortId, portMeta, x, y) {
  const state = _graphState();
  _pushGraphUndo();
  const nodeId = 'question-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const sourceText = sourceNode.title || sourceNode.summary || _nodeStoredContent(sourceNode) || '该知识点';
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: nodeId,
    kind: 'user',
    moduleKey: '',
    manual: true,
    content: '请讲解：' + sourceText,
    status: 'done',
    summary: '',
    analysis: '',
    analysisHash: '',
    inputHash: '',
    generatedAt: 0,
    requirements: '',
    busy: false,
    generated: false,
    maxItems: 0,
    items: [],
    edges: [],
    fileId: sourceNode.fileId || '',
    fileName: sourceNode.fileName || '',
    generatedNodeIds: [],
    category: sourceNode.category || 'other',
    formulas: sourceNode.formulas || [],
    knowledgeKey: sourceNode.knowledgeKey || '',
    sourceNodeId: sourceNode.id,
    x,
    y,
    depth: 2,
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 300,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNode.id,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _createRelationNodeFromPort(sourceNode, sourcePortId, portMeta, x, y) {
  const state = _graphState();
  _pushGraphUndo();
  const nodeId = 'relation-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: nodeId,
    kind: 'relation',
    moduleKey: 'relation',
    manual: true,
    content: '',
    status: 'empty',
    summary: '',
    analysis: '',
    analysisHash: '',
    inputHash: '',
    generatedAt: 0,
    requirements: '',
    busy: false,
    generated: false,
    maxItems: 0,
    items: [],
    edges: [],
    fileId: sourceNode.fileId || '',
    fileName: sourceNode.fileName || '',
    generatedNodeIds: [],
    category: '',
    formulas: [],
    knowledgeKey: '',
    x,
    y,
    depth: 4,
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 280,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNode.id,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _createBranchNodeFromOutput(sourceNodeId, sourcePortId, portMeta, x, y) {
  const sourceNode = graphView.nodeById[sourceNodeId];
  if (!sourceNode || !portMeta) return;

  const label = String(portMeta.label || '');
  const type = String(portMeta.type || '');
  const branchType = String(portMeta.branchType || '');
  const option = _findManualOptionByPort(portMeta);
  if (type === 'knowledge') {
    _createKnowledgeNodeFromPort(sourceNode, sourcePortId, portMeta, x, y);
    return;
  }
  if (type === 'relation' || label === '联系') {
    _createRelationNodeFromPort(sourceNode, sourcePortId, portMeta, x, y);
    return;
  }
  if (sourceNode.kind === 'knowledge' && (label === '问题' || portMeta.attribute === 'question')) {
    _createQuestionNodeFromPort(sourceNode, sourcePortId, portMeta, x, y);
    return;
  }
  const questionLike = label === '追问' || label === '直接问AI' || label === '没看懂' || label === '回答练习'
    || /^追问/.test(label)
    || type === 'socratic'
    || type === 'learn'
    || branchType === 'confused'
    || branchType === 'continue'
    || branchType === 'learn';

  if (option && !questionLike) {
    _createConnectedManualNode(option.key, x, y, sourceNodeId, sourcePortId);
    return;
  }

  const messages = _getChatHistory();
  const sourceMessage = sourceNode.messageIndex >= 0 ? messages[sourceNode.messageIndex] : null;
  const sourceModule = sourceNode.moduleKey || '';
  const meta = {
    ...portMeta,
    sourceModule,
    parentId: String(sourceMessage?.timestamp || sourceNode.timestamp || ''),
    fromPort: sourcePortId || '',
  };
  const nodeId = 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  const draftNode = {
    id: nodeId,
    kind: 'draft',
    x,
    y,
    w: 340,
    h: 180,
    vx: 0,
    vy: 0,
    isRoot: false,
    isBranch: true,
    messageIndex: -1,
    timestamp: Date.now(),
    moduleKey: sourceModule,
    branchType: meta.branchType || 'followup',
    portMeta: meta,
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: 340,
    customHeight: null,
    minimized: false,
  };
  graphView.nodes.push(draftNode);
  graphView.nodeById[nodeId] = draftNode;
  graphView.edges.push({
    from: sourceNodeId,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'draft',
    custom: true,
    draft: true,
  });
  graphInner.insertAdjacentHTML('beforeend', _renderDraftNodeHtml(draftNode));
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function _findManualOptionByPort(portMeta) {
  const candidates = [portMeta?.label, portMeta?.attribute, portMeta?.type].filter(Boolean);
  return MANUAL_NODE_OPTIONS.find(option =>
    candidates.some(candidate => candidate === option.key || candidate === option.label)
  ) || null;
}

function _createConnectedManualNode(optionKey, x, y, sourceNodeId, sourcePortId) {
  const option = MANUAL_NODE_OPTIONS.find(item => item.key === optionKey);
  if (!option) return;
  _pushGraphUndo();
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  const nodeId = option.key + '-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  state.customNodes.push({
    id: nodeId,
    kind: option.kind,
    moduleKey: option.kind === 'module' || option.kind === 'hub' || option.kind === 'summary' || option.kind === 'note' ? option.key : '',
    manual: option.key === 'manual' || option.key === 'human_note' || option.key === 'note' || option.key === 'relation' || option.key === 'source' || option.key === 'knowledge',
    nodeType: option.key === 'human_note' ? 'understanding' : '',
    label: option.key === 'human_note' ? option.label : '',
    formula: '',
    source: option.key === 'manual' || option.key === 'human_note' || option.key === 'note' ? 'human' : 'ai',
    content: '',
    status: 'empty',
    summary: '',
    analysis: '',
    analysisHash: '',
    inputHash: '',
    generatedAt: 0,
    requirements: '',
    busy: false,
    generated: false,
    maxItems: option.key === 'source' ? 5 : 0,
    items: [],
    edges: [],
    fileId: '',
    fileName: '',
    generatedNodeIds: [],
    category: '',
    formulas: [],
    knowledgeKey: '',
    x,
    y,
    depth: option.kind === 'user' ? 1 : option.kind === 'answer' ? 2 : (option.key === 'summary' || option.key === 'note' ? 4 : 3),
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: option.key === 'human_note' ? 280 : null,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  state.connections = state.connections || [];
  state.connections.push({
    from: sourceNodeId,
    fromPort: sourcePortId || 'out-0',
    to: nodeId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphState(state);
  renderGraphCanvas();
}

function _findDraftNode(nodeId) {
  return graphView.nodeById[nodeId] || null;
}

function buildGraphPathForAnchor(anchor) {
  const parentId = String(anchor?.parentId || '');
  if (!parentId) return [];
  const sourceModule = anchor?.sourceModule || '';
  let current = null;
  const candidates = [];
  if (sourceModule) candidates.push(_graphNodeId('m', parentId, sourceModule));
  candidates.push(_graphNodeId('a', parentId));
  for (const id of candidates) {
    current = _findGraphNode(id);
    if (current) break;
  }
  if (!current) {
    return [{ kind: 'answer', timestamp: parentId, module: sourceModule || '' }];
  }
  const ordered = [];
  const visited = new Set();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    ordered.push(current);
    const incoming = (graphView.edges || []).find(edge => String(edge.to) === current.id);
    current = incoming ? _findGraphNode(incoming.from) : null;
  }
  ordered.reverse();
  return ordered.map(node => ({
    kind: node.kind,
    timestamp: node.timestamp || '',
    module: node.moduleKey || '',
    branchType: node.branchType || '',
  }));
}

function submitDraftQuestion(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const input = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-draft-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  const meta = node.portMeta || {};
  const branchType = meta.branchType === 'learn' ? 'learn' : meta.branchType === 'confused' ? 'confused' : 'followup';
  const anchor = {
    parentId: meta.parentId || '',
    sourceModule: meta.sourceModule || '',
    attribute: meta.attribute || '',
    branchType,
    branchId: typeof window._genBranchId === 'function' ? window._genBranchId() : 'br_' + Date.now(),
    branchLabel: branchType === 'learn'
      ? '进阶学习：' + (meta.question || meta.label || text)
      : branchType === 'confused'
        ? '没看懂：' + (meta.label || text)
        : '追问：' + (meta.label || text),
    fromPort: meta.fromPort || '',
  };
  if (typeof window.sendBranchQuick === 'function') window.sendBranchQuick(text, anchor);
}

function draftSocraticAnswer(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const meta = node.portMeta || {};
  if (typeof window.startSocraticAnswer === 'function') {
    window.startSocraticAnswer(meta.question || '', meta.level || 'basic', meta.parentId || '', meta.sourceModule || 'extend');
  }
}

function draftAskAi(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const meta = node.portMeta || {};
  const question = meta.question || '';
  if (!question) return;
  const anchor = {
    parentId: meta.parentId || '',
    sourceModule: meta.sourceModule || '',
    attribute: meta.attribute || '',
    branchType: 'continue',
    branchId: typeof window._genBranchId === 'function' ? window._genBranchId() : 'br_' + Date.now(),
    branchLabel: '直接问AI：' + question,
    fromPort: meta.fromPort || '',
  };
  if (typeof window.sendBranchQuick === 'function') window.sendBranchQuick(question, anchor);
}

function removeDraftNode(nodeId) {
  const node = graphView.nodeById[nodeId];
  if (!node || node.kind !== 'draft') return;
  graphView.nodes = graphView.nodes.filter(item => item.id !== nodeId);
  delete graphView.nodeById[nodeId];
  graphView.edges = graphView.edges.filter(edge => edge.to !== nodeId && edge.from !== nodeId);
  graphInner?.querySelector('[data-node-id="' + nodeId + '"]')?.remove();
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function _extractRawModuleSection(content, moduleKey) {
  const text = String(content || '');
  if (moduleKey === 'socratic' || moduleKey === 'learn') {
    const extendMatch = text.match(/<extend>([\s\S]*?)<\/extend>/i);
    return extendMatch ? _stripModuleHeading(extendMatch[1], moduleKey) : '';
  }
  const re = new RegExp('<' + moduleKey + '>([\\s\\S]*?)</' + moduleKey + '>', 'i');
  const match = text.match(re);
  return match ? match[1].trim() : '';
}

function _replaceExtendSubsection(extendContent, moduleKey, newSection) {
  const header = moduleKey === 'socratic' ? '苏格拉底追问' : '进阶学习方向';
  const re = new RegExp('(^|\\n)(#{1,6}\\s*[^\\n]*' + header + '[^\\n]*\\n?)([\\s\\S]*?)(?=\\n#{1,6}\\s*[^\\n]*(?:苏格拉底追问|进阶学习方向)[^\\n]*|$)', 'i');
  if (re.test(String(extendContent || ''))) {
    return String(extendContent || '').replace(re, (match, pre, heading, oldContent) => {
      return pre + heading + String(newSection || '').trim();
    });
  }
  return String(extendContent || '') + '\n\n## ' + header + '\n' + String(newSection || '').trim();
}

function _replaceModuleContent(content, moduleKey, reply) {
  const text = String(content || '');
  let newSection = String(reply || '').trim();
  const tagRe = new RegExp('<' + moduleKey + '>([\\s\\S]*?)</' + moduleKey + '>', 'i');
  const tagMatch = newSection.match(tagRe);
  if (tagMatch) newSection = tagMatch[1].trim();

  if (moduleKey === 'socratic' || moduleKey === 'learn') {
    const innerExtend = newSection.match(/<extend>([\s\S]*?)<\/extend>/i);
    if (innerExtend) newSection = _stripModuleHeading(innerExtend[1], moduleKey);
    else newSection = _stripModuleHeading(newSection, moduleKey);
    const extendMatch = text.match(/<extend>([\s\S]*?)<\/extend>/i);
    if (extendMatch) {
      const updated = _replaceExtendSubsection(extendMatch[1], moduleKey, newSection);
      return text.replace(/<extend>[\s\S]*?<\/extend>/i, '<extend>\n' + updated.trim() + '\n</extend>');
    }
  }

  const escaped = String(moduleKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<' + escaped + '>[\\s\\S]*?</' + escaped + '>', 'i');
  if (re.test(text)) {
    return text.replace(re, () => '<' + moduleKey + '>\n' + newSection.trim() + '\n</' + moduleKey + '>');
  }
  return text + '\n<' + moduleKey + '>\n' + newSection.trim() + '\n</' + moduleKey + '>';
}

async function _regenerateModuleContent(message, moduleKey, confusion) {
  const moduleLabel = (GRAPH_MODULE_META[moduleKey] || {}).label || moduleKey;
  const original = _extractRawModuleSection(message?.content || '', moduleKey) || '（没有原内容）';
  const prompt = '用户对下面「' + moduleLabel + '」中的内容有没看懂的地方。'
    + '请只重新生成这个模块，不改变其他模块。'
    + '要求：用更简单、更慢、更生活化的语言重讲；保留公式和 Markdown；'
    + '如果是苏格拉底追问或进阶学习，只输出该小节内容，不要输出整个学习卡片。\n\n'
    + '原内容：\n' + original + '\n\n用户没看懂：\n' + confusion;
  let reply = '';

  if (typeof getActiveModelForRole === 'function') {
    const agentModel = getActiveModelForRole('agent');
    if (agentModel && typeof proxyChatWithModel === 'function' && typeof collectStreamText === 'function') {
      const resp = await proxyChatWithModel(agentModel, {
        messages: [
          { role: 'system', content: getLevelPrompt() },
          { role: 'user', content: prompt }
        ],
        stream: true,
      });
      reply = await collectStreamText(resp);
      if (reply.trim()) return _replaceModuleContent(message?.content || '', moduleKey, reply);
    }
  }

  const fallbackResp = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'agent',
      prompt,
      level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
      session_id: typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
      stream: false,
    }),
  });
  if (!fallbackResp.ok) throw new Error('重新生成请求失败：' + fallbackResp.status);
  const data = await fallbackResp.json();
  reply = data.choices?.[0]?.message?.content || '';
  if (!reply.trim()) throw new Error('AI 未返回可用的重新生成内容');
  return _replaceModuleContent(message?.content || '', moduleKey, reply);
}

function graphOpenRegenerate(nodeId) {
  const node = _findGraphNode(nodeId);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  if (!node || !el) return;
  const existing = el.querySelector('.graph-regenerate-panel');
  if (existing) {
    existing.remove();
    _measureNodes();
    _updateNodeTransforms();
    return;
  }
  const main = el.querySelector('.graph-node-main');
  if (!main) return;
  main.insertAdjacentHTML('beforeend',
    '<div class="graph-regenerate-panel">'
    + '<textarea class="graph-regenerate-input" rows="3" placeholder="哪里没看懂？例如：第三步推导跳步了"></textarea>'
    + '<div class="graph-regenerate-actions">'
    + '<button class="graph-draft-btn" onclick="closeRegeneratePanel(\'' + nodeId + '\')">取消</button>'
    + '<button class="graph-draft-btn graph-draft-send graph-icon-btn" onclick="submitRegenerateNode(\'' + nodeId + '\')" title="重新生成此节点">' + _regenIconHtml() + '</button>'
    + '</div></div>'
  );
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

function closeRegeneratePanel(nodeId) {
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  el?.querySelector('.graph-regenerate-panel')?.remove();
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

async function submitRegenerateNode(nodeId) {
  const node = _findGraphNode(nodeId);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  const panel = el?.querySelector('.graph-regenerate-panel');
  const input = panel?.querySelector('.graph-regenerate-input');
  if (!node || !el || !panel || !input) return;
  const confusion = input.value.trim();
  if (!confusion) return;
  const messages = _getChatHistory();
  const message = messages[node.messageIndex];
  if (!message) return;

  const buttons = panel.querySelectorAll('button');
  buttons.forEach(btn => { btn.disabled = true; });
  input.disabled = true;
  panel.classList.add('busy');
  try {
    const newContent = await _regenerateModuleContent(message, node.moduleKey, confusion);
    const updated = typeof window.updateChatHistoryMessage === 'function'
      ? window.updateChatHistoryMessage(message.timestamp, item => ({ ...item, content: newContent }))
      : false;
    if (!updated) throw new Error('未找到对应的回答消息');
    if (typeof saveCurrentSession === 'function') await saveCurrentSession();
    else if (typeof saveSessionMessages === 'function') {
      await saveSessionMessages(currentSessionId, typeof chatHistory !== 'undefined' ? chatHistory : _getChatHistory());
    }
    if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    if (typeof renderCurrentChat === 'function') await renderCurrentChat();
  } catch (err) {
    console.warn('Regenerate module failed:', err);
    const errorEl = panel.querySelector('.graph-regenerate-error');
    if (errorEl) errorEl.textContent = '重新生成失败：' + (err.message || err);
    else panel.insertAdjacentHTML('beforeend', '<div class="graph-regenerate-error">重新生成失败：' + escapeHtml(err.message || String(err)) + '</div>');
    buttons.forEach(btn => { btn.disabled = false; });
    input.disabled = false;
    panel.classList.remove('busy');
  }
}

function _disconnectInputPort(toNodeId, toPort) {
  if (!toNodeId) return;
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  state.removedEdges = state.removedEdges || [];
  state.connections = state.connections.filter(c => !(c.to === toNodeId && (c.toPort || 'in-0') === toPort));
  const removed = new Set(state.removedEdges);
  for (const edge of (graphView.defaultEdges || [])) {
    if (edge.to === toNodeId && (edge.toPort || 'in-0') === toPort) removed.add(_edgeKey(edge));
  }
  state.removedEdges = Array.from(removed);
  _saveGraphState(state);
  graphView.edges = _resolveGraphEdges(state, graphView.defaultEdges || [], graphView.nodeById);
  _redrawEdges();
}

function _removeGraphEdge(edgeKey) {
  const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
  if (!edge) return;
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  state.removedEdges = state.removedEdges || [];
  state.connections = state.connections.filter(item => _edgeKey(item) !== edgeKey);
  if (!edge.custom) {
    state.removedEdges.push(edgeKey);
    state.removedEdges = Array.from(new Set(state.removedEdges));
  }
  _saveGraphState(state);
  graphView.edges = _resolveGraphEdges(state, graphView.defaultEdges || [], graphView.nodeById);
  _redrawEdges();
}

function graphAddOutputPort(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || !((node.kind === 'module' && node.moduleKey === 'socratic') || node.kind === 'source' || node.kind === 'knowledge')) return;
  _pushGraphUndo();
  const state = _graphState();
  state.portCounts = state.portCounts || {};
  state.portCounts[nodeId] = (state.portCounts[nodeId] || 0) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphAddInputPort(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || (node.kind !== 'user' && node.kind !== 'hub' && node.kind !== 'relation' && node.kind !== 'module')) return;
  _pushGraphUndo();
  const state = _graphState();
  state.inputPortCounts = state.inputPortCounts || {};
  state.inputPortCounts[nodeId] = (state.inputPortCounts[nodeId] || 0) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRemoveInputPort(nodeId, portIndex) {
  const node = _findGraphNode(nodeId);
  if (!node || (node.kind !== 'user' && node.kind !== 'hub' && node.kind !== 'relation' && node.kind !== 'module')) return;
  const minPort = node.kind === 'relation' ? 2 : 1;
  if (portIndex < minPort) return;
  _pushGraphUndo();
  const state = _graphState();
  state.inputPortCounts = state.inputPortCounts || {};
  state.connections = state.connections || [];
  state.inputPortCounts[nodeId] = Math.max(0, (state.inputPortCounts[nodeId] || 0) - 1);
  state.connections = state.connections
    .map(c => {
      if (c.to !== nodeId || !/^in-\d+$/.test(String(c.toPort || ''))) return c;
      const idx = parseInt(String(c.toPort).replace('in-', ''), 10);
      if (idx === portIndex) return null;
      if (idx > portIndex) return { ...c, toPort: 'in-' + (idx - 1) };
      return c;
    })
    .filter(Boolean);
  _saveGraphState(state);
  renderGraphCanvas();
}

function _baseOutputPortCount(node) {
  if (!node) return 0;
  const messages = _getChatHistory();
  if (node.kind === 'module') return _moduleOutputPorts(node, messages[node.messageIndex]).length;
  if (node.kind === 'human_note') return 1;
  if (node.kind === 'user') return 1;
  if (node.kind === 'answer') return _nodeOutputLabels(node, messages).length;
  if (node.kind === 'hub') return 1;
  if (node.kind === 'source') return (node.items || []).length;
  if (node.kind === 'knowledge') return _nodeOutputLabels(node, messages).length;
  if (node.kind === 'summary' || node.kind === 'note') return 0;
  return 0;
}

function graphRemoveOutputPort(nodeId, portIndex) {
  const node = _findGraphNode(nodeId);
  if (!node || !((node.kind === 'module' && node.moduleKey === 'socratic') || node.kind === 'source' || node.kind === 'knowledge')) return;
  const baseCount = _baseOutputPortCount(node);
  if (portIndex < baseCount) return;
  const state = _graphState();
  state.portCounts = state.portCounts || {};
  const current = state.portCounts[nodeId] || 0;
  if (current <= baseCount) return;

  _pushGraphUndo();
  const portKey = 'out-' + portIndex;
  const removedDrafts = [];
  state.connections = (state.connections || [])
    .map(connection => {
      if (connection.from !== nodeId) return connection;
      const idx = parseInt(String(connection.fromPort || 'out-0').replace('out-', ''), 10);
      if (String(connection.fromPort || 'out-0') === portKey) return null;
      if (idx > portIndex) return { ...connection, fromPort: 'out-' + (idx - 1) };
      return connection;
    })
    .filter(Boolean);

  graphView.edges = (graphView.edges || [])
    .map(edge => {
      if (edge.from !== nodeId) return edge;
      const idx = parseInt(String(edge.fromPort || 'out-0').replace('out-', ''), 10);
      if (String(edge.fromPort || 'out-0') === portKey) {
        if (edge.draft && edge.to) removedDrafts.push(edge.to);
        return null;
      }
      if (idx > portIndex) return { ...edge, fromPort: 'out-' + (idx - 1) };
      return edge;
    })
    .filter(Boolean);

  removedDrafts.forEach(id => removeDraftNode(id));
  state.portCounts[nodeId] = Math.max(baseCount, current - 1);
  _saveGraphState(state);
  renderGraphCanvas();
}

// 恢复默认连线按钮已从工具栏移除；函数保留，后续如需恢复 UI 入口可直接调用。
function resetGraphConnections() {
  if (!confirm('恢复默认连线？新增的输出端口也会一并重置。')) return;
  _pushGraphUndo();
  const state = _graphState();
  delete state.connections;
  delete state.removedEdges;
  delete state.portCounts;
  _saveGraphState(state);
  renderGraphCanvas();
}

function zoomGraph(factor, centerX, centerY) {
  const state = _graphState();
  const oldZoom = state.zoom || 0.9;
  const newZoom = Math.min(2.5, Math.max(0.25, oldZoom * factor));
  if (!graphCanvas) return;
  const rect = graphCanvas.getBoundingClientRect();
  const cx = (centerX != null ? centerX : rect.left + rect.width / 2) - rect.left;
  const cy = (centerY != null ? centerY : rect.top + rect.height / 2) - rect.top;
  const wx = (cx - state.pan.x) / oldZoom;
  const wy = (cy - state.pan.y) / oldZoom;
  state.pan.x = cx - wx * newZoom;
  state.pan.y = cy - wy * newZoom;
  state.zoom = newZoom;
  _saveGraphState(state);
  _applyGraphTransform();
}

function fitGraph() {
  if (!graphView.nodes.length || !graphCanvas) return;
  const state = _graphState();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of graphView.nodes) {
    minX = Math.min(minX, n.x - (n.w || 120) / 2);
    minY = Math.min(minY, n.y - (n.h || 60) / 2);
    maxX = Math.max(maxX, n.x + (n.w || 120) / 2);
    maxY = Math.max(maxY, n.y + (n.h || 60) / 2);
  }
  const width = maxX - minX + 200;
  const height = maxY - minY + 200;
  const rect = graphCanvas.getBoundingClientRect();
  const zoom = Math.min((rect.width - 120) / width, (rect.height - 160) / height, 1.1);
  state.zoom = Math.max(0.2, zoom);
  state.pan.x = (rect.width - width * state.zoom) / 2 - minX * state.zoom;
  state.pan.y = (rect.height - height * state.zoom) / 2 - minY * state.zoom;
  _saveGraphState(state);
  _applyGraphTransform();
}

function _isGraphModifier(event) {
  return !!(event && (event.ctrlKey || event.metaKey));
}

function _syncGraphSelectionClasses() {
  if (!graphInner) return;
  graphInner.querySelectorAll('.graph-node.selected').forEach(el => el.classList.remove('selected'));
  graphInner.querySelectorAll('.graph-group.selected').forEach(el => el.classList.remove('selected'));
  graphView.selectedNodeIds.forEach(id => {
    const el = graphInner.querySelector('[data-node-id="' + id + '"]');
    if (el) el.classList.add('selected');
  });
  graphView.selectedGroupIds.forEach(id => {
    const el = graphInner.querySelector('[data-group-id="' + id + '"]');
    if (el) el.classList.add('selected');
  });
}

function _clearGraphSelection() {
  graphView.selectedNodeIds = new Set();
  graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
}

function _setGraphSelection(ids, additive) {
  const next = additive ? new Set(graphView.selectedNodeIds) : new Set();
  ids.forEach(id => next.add(id));
  graphView.selectedNodeIds = next;
  if (!additive) graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
}

function _toggleGraphSelection(id) {
  const next = new Set(graphView.selectedNodeIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  graphView.selectedNodeIds = next;
  _syncGraphSelectionClasses();
}

function _setGraphGroupSelection(ids, additive) {
  const next = additive ? new Set(graphView.selectedGroupIds) : new Set();
  ids.forEach(id => next.add(id));
  graphView.selectedGroupIds = next;
  if (!additive) graphView.selectedNodeIds = new Set();
  _syncGraphSelectionClasses();
}

function _toggleGraphGroupSelection(id) {
  const next = new Set(graphView.selectedGroupIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  graphView.selectedGroupIds = next;
  _syncGraphSelectionClasses();
}

function _getSelectionRect() {
  const box = graphView.boxSelect;
  if (!box) return null;
  return {
    left: Math.min(box.startX, box.currentX),
    top: Math.min(box.startY, box.currentY),
    right: Math.max(box.startX, box.currentX),
    bottom: Math.max(box.startY, box.currentY),
    width: Math.abs(box.currentX - box.startX),
    height: Math.abs(box.currentY - box.startY),
  };
}

function _renderSelectionBox() {
  if (!graphInner) return;
  let box = graphInner.querySelector('.graph-selection-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'graph-selection-box';
    graphInner.appendChild(box);
  }
  const rect = _getSelectionRect();
  if (!rect) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  box.style.left = rect.left + 'px';
  box.style.top = rect.top + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';
}

function _removeSelectionBox() {
  graphInner?.querySelector('.graph-selection-box')?.remove();
}

function _nodesInSelectionRect(rect) {
  const result = [];
  for (const node of graphView.nodes) {
    const w = node.w || 120;
    const h = node.h || 60;
    const left = node.x - w / 2;
    const top = node.y - h / 2;
    const right = left + w;
    const bottom = top + h;
    if (right >= rect.left && left <= rect.right && bottom >= rect.top && top <= rect.bottom) {
      result.push(node.id);
    }
  }
  return result;
}

function _startNodeResize(event, nodeEl) {
  const node = _findGraphNode(nodeEl.dataset.nodeId);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.resizeNodeId = node.id;
  graphView.pointerId = event.pointerId;
  graphView.resizeStartX = event.clientX;
  graphView.resizeStartY = event.clientY;
  graphView.resizeStartW = node.customWidth || node.w || 320;
  graphView.resizeStartH = node.customHeight || node.h || 120;
  graphView.moved = false;
}

function _startNodeDrag(event, nodeEl) {
  const node = _findGraphNode(nodeEl.dataset.nodeId);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  const isSelected = graphView.selectedNodeIds.has(node.id);
  const modifier = _isGraphModifier(event);
  const moveIds = new Set();
  if (isSelected) {
    graphView.selectedNodeIds.forEach(id => moveIds.add(id));
  } else if (modifier) {
    graphView.selectedNodeIds.forEach(id => moveIds.add(id));
    moveIds.add(node.id);
  } else {
    moveIds.add(node.id);
  }
  graphView.dragNodeId = node.id;
  graphView.dragWasSelected = isSelected;
  graphView.dragModifier = modifier;
  graphView.dragStartPositions = {};
  moveIds.forEach(id => {
    const n = _findGraphNode(id);
    if (n) graphView.dragStartPositions[id] = { x: n.x, y: n.y };
    const el = graphInner?.querySelector('[data-node-id="' + id + '"]');
    el?.classList.add('dragging');
  });
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.moved = false;
}

function _startGroupDrag(event, groupEl) {
  const group = _graphGroupById(groupEl.dataset.groupId);
  if (!group) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.dragGroupId = group.id;
  graphView.dragGroupStartX = group.x;
  graphView.dragGroupStartY = group.y;
  graphView.dragGroupNodeStartPositions = {};
  (group.nodeIds || []).forEach(id => {
    const node = _findGraphNode(id);
    if (node) graphView.dragGroupNodeStartPositions[id] = { x: node.x, y: node.y };
  });
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.moved = false;
  graphInner?.querySelectorAll('.graph-group').forEach(el => el.classList.remove('dragging'));
  groupEl.classList.add('dragging');
}

function _startGroupResize(event, groupEl) {
  const group = _graphGroupById(groupEl.dataset.groupId);
  if (!group) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.resizeGroupId = group.id;
  graphView.resizeGroupStartX = group.x;
  graphView.resizeGroupStartY = group.y;
  graphView.resizeGroupStartW = group.width || 320;
  graphView.resizeGroupStartH = group.height || 180;
  graphView.resizeGroupStartClientX = event.clientX;
  graphView.resizeGroupStartClientY = event.clientY;
  graphView.pointerId = event.pointerId;
  graphView.moved = false;
}

function _startCanvasPan(event) {
  event.preventDefault();
  _clearGraphTextSelection();
  if (_isGraphModifier(event)) {
    const point = _clientToGraphLocal(event.clientX, event.clientY);
    graphView.boxSelect = {
      startX: point.x,
      startY: point.y,
      currentX: point.x,
      currentY: point.y,
      additive: true,
    };
    graphView.pointerId = event.pointerId;
    graphView.moved = false;
    graphCanvas?.classList.add('box-selecting');
    _renderSelectionBox();
    return;
  }
  const state = _graphState();
  graphView.panning = true;
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.panStartX = state.pan.x;
  graphView.panStartY = state.pan.y;
  graphView.moved = false;
  graphCanvas?.classList.add('panning');
}

function _clearGraphTextSelection() {
  const selection = document.getSelection();
  if (selection && typeof selection.removeAllRanges === 'function') {
    selection.removeAllRanges();
  }
}

function _handlePointerMove(event) {
  if (graphView.pointerId !== event.pointerId) return;
  const dx = event.clientX - graphView.startX;
  const dy = event.clientY - graphView.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
    graphView.moved = true;
    _clearGraphTextSelection();
  }
  const state = _graphState();
  if (graphView.linkDrag) {
    const point = _clientToGraphLocal(event.clientX, event.clientY);
    graphView.linkDrag.currentX = point.x;
    graphView.linkDrag.currentY = point.y;
    _redrawEdges();
    return;
  }
  if (graphView.boxSelect) {
    const point = _clientToGraphLocal(event.clientX, event.clientY);
    graphView.boxSelect.currentX = point.x;
    graphView.boxSelect.currentY = point.y;
    _renderSelectionBox();
    return;
  }
  if (graphView.resizeNodeId) {
    const node = _findGraphNode(graphView.resizeNodeId);
    const el = graphInner?.querySelector('[data-node-id="' + graphView.resizeNodeId + '"]');
    if (node && el) {
      const resizeDx = (event.clientX - graphView.resizeStartX) / (graphView.zoom || 1);
      const resizeDy = (event.clientY - graphView.resizeStartY) / (graphView.zoom || 1);
      const nextW = Math.max(260, graphView.resizeStartW + resizeDx);
      const nextH = Math.max(90, graphView.resizeStartH + resizeDy);
      node.customWidth = Math.round(nextW);
      node.customHeight = Math.round(nextH);
      el.style.setProperty('width', node.customWidth + 'px', 'important');
      el.style.setProperty('min-width', node.customWidth + 'px', 'important');
      el.style.setProperty('max-width', node.customWidth + 'px', 'important');
      el.style.setProperty('min-height', node.customHeight + 'px', 'important');
      el.style.setProperty('height', node.customHeight + 'px', 'important');
      el.classList.add('resized');
      node.w = node.customWidth;
      node.h = el.getBoundingClientRect().height / (graphView.zoom || 1);
      if (node.kind === 'ai_eval') _updateAiEvalZigzag(node);
      _redrawEdges();
    }
    return;
  }
  if (graphView.resizeGroupId) {
    const group = _graphGroupById(graphView.resizeGroupId);
    if (group) {
      const resizeDx = (event.clientX - graphView.resizeGroupStartClientX) / (graphView.zoom || 1);
      const resizeDy = (event.clientY - graphView.resizeGroupStartClientY) / (graphView.zoom || 1);
      group.width = Math.max(220, graphView.resizeGroupStartW + resizeDx);
      group.height = Math.max(140, graphView.resizeGroupStartH + resizeDy);
      _updateGroupElement(group);
      graphView.moved = true;
    }
    return;
  }
  if (graphView.dragGroupId) {
    const group = _graphGroupById(graphView.dragGroupId);
    if (group) {
      const offsetX = dx / (graphView.zoom || 1);
      const offsetY = dy / (graphView.zoom || 1);
      group.x = graphView.dragGroupStartX + offsetX;
      group.y = graphView.dragGroupStartY + offsetY;
      _updateGroupElement(group);
      for (const [id, start] of Object.entries(graphView.dragGroupNodeStartPositions || {})) {
        const node = _findGraphNode(id);
        if (node) {
          node.x = start.x + offsetX;
          node.y = start.y + offsetY;
        }
      }
      _updateNodeTransforms();
      _redrawEdges();
    }
    return;
  }
  if (graphView.dragNodeId) {
    const offsetX = dx / (graphView.zoom || 1);
    const offsetY = dy / (graphView.zoom || 1);
    for (const id of Object.keys(graphView.dragStartPositions || {})) {
      const n = _findGraphNode(id);
      const start = graphView.dragStartPositions[id];
      if (n && start) {
        n.x = start.x + offsetX;
        n.y = start.y + offsetY;
      }
    }
    _updateNodeTransforms();
    _redrawEdges();
  } else if (graphView.panning) {
    state.pan.x = graphView.panStartX + dx;
    state.pan.y = graphView.panStartY + dy;
    _saveGraphState(state);
    _applyGraphTransform();
  }
}

function _endPointerDrag(event) {
  if (graphView.pointerId !== event.pointerId) return;
  if (graphView.moved) graphView.suppressClick = true;
  setTimeout(() => { graphView.suppressClick = false; }, 0);
  if (graphView.linkDrag) {
    const drag = graphView.linkDrag;
    const dropPort = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.graph-port')
      : null;
    if (drag.mode === 'output' && dropPort && dropPort.classList.contains('graph-input-port')) {
      const targetNodeId = dropPort.closest('.graph-node')?.dataset.nodeId;
      _connectPorts(drag.nodeId, drag.portId, targetNodeId, dropPort.dataset.portId);
    } else if (drag.mode === 'input' && dropPort && dropPort.classList.contains('graph-output-port')) {
      const sourceNodeId = dropPort.closest('.graph-node')?.dataset.nodeId;
      _connectPorts(sourceNodeId, dropPort.dataset.portId, drag.nodeId, drag.portId);
    } else if (drag.mode === 'input' && graphView.moved) {
      _disconnectInputPort(drag.nodeId, drag.portId);
    } else if (drag.mode === 'output' && graphView.moved
      && (!event.target || typeof event.target.closest !== 'function' || !event.target.closest('.graph-node'))) {
      const point = _clientToGraphLocal(event.clientX, event.clientY);
      _createBranchNodeFromOutput(drag.nodeId, drag.portId, drag.portMeta, point.x, point.y);
    }
    graphView.linkDrag = null;
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('linking');
    _redrawEdges();
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    return;
  }
  if (graphView.resizeNodeId) {
    const node = _findGraphNode(graphView.resizeNodeId);
    if (node && graphView.moved) {
      _pushGraphUndo();
      _syncGroupMembersByContainment();
      _savePositions();
    }
    graphView.resizeNodeId = null;
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    return;
  }
  if (graphView.resizeGroupId) {
    const group = _graphGroupById(graphView.resizeGroupId);
    if (group && graphView.moved) {
      _pushGraphUndo();
      _syncGroupMembersByContainment();
      const state = _graphState();
      state.groups = graphView.groups.map(item => ({ ...item }));
      _saveGraphState(state);
    }
    graphView.resizeGroupId = null;
    graphView.resizeGroupStartX = 0;
    graphView.resizeGroupStartY = 0;
    graphView.resizeGroupStartW = 0;
    graphView.resizeGroupStartH = 0;
    graphView.resizeGroupStartClientX = 0;
    graphView.resizeGroupStartClientY = 0;
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    return;
  }
  if (graphView.dragGroupId) {
    const group = _graphGroupById(graphView.dragGroupId);
    if (group && graphView.moved) {
      _pushGraphUndo();
      _syncGroupMembersByContainment();
      const state = _graphState();
      state.groups = graphView.groups.map(item => ({ ...item }));
      state.positions = state.positions || {};
      state.pinned = state.pinned || {};
      for (const [id, start] of Object.entries(graphView.dragGroupNodeStartPositions || {})) {
        const node = _findGraphNode(id);
        if (!node) continue;
        node.pinned = true;
        node.fixedX = node.x;
        node.fixedY = node.y;
        state.positions[id] = { x: node.x, y: node.y };
        state.pinned[id] = true;
      }
      _saveGraphState(state);
      _syncGroupMembersByContainment();
      _savePositions();
    }
    graphInner?.querySelectorAll('.graph-group.dragging').forEach(el => el.classList.remove('dragging'));
    graphView.dragGroupId = null;
    graphView.dragGroupStartX = 0;
    graphView.dragGroupStartY = 0;
    graphView.dragGroupNodeStartPositions = {};
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    return;
  }
  if (graphView.boxSelect) {
    const rect = _getSelectionRect();
    if (rect && graphView.moved) {
      _setGraphSelection(_nodesInSelectionRect(rect), !!graphView.boxSelect.additive);
    } else if (!graphView.moved) {
      _clearGraphSelection();
    }
    graphView.boxSelect = null;
    _removeSelectionBox();
    graphView.pointerId = null;
    graphView.panning = false;
    graphView.moved = false;
    graphCanvas?.classList.remove('box-selecting', 'panning');
    return;
  }
  if (graphView.dragNodeId) {
    const node = _findGraphNode(graphView.dragNodeId);
    if (node && graphView.moved) {
      if (!graphView.dragWasSelected) {
        if (graphView.dragModifier) {
          graphView.selectedNodeIds.add(node.id);
        } else {
          graphView.selectedNodeIds = new Set([node.id]);
        }
        _syncGraphSelectionClasses();
      }
      _pushGraphUndo();
      const state = _graphState();
      state.positions = state.positions || {};
      state.pinned = state.pinned || {};
      for (const id of Object.keys(graphView.dragStartPositions || {})) {
        const n = _findGraphNode(id);
        if (!n) continue;
        n.pinned = true;
        n.fixedX = n.x;
        n.fixedY = n.y;
        state.positions[id] = { x: n.x, y: n.y };
        state.pinned[id] = true;
      }
      _saveGraphState(state);
      _syncGroupMembersByContainment();
      _savePositions();
    }
    let droppedIntoGroup = false;
    const dropGroupEl = event.target && typeof event.target.closest === 'function'
      ? event.target.closest('.graph-group')
      : null;
    if (dropGroupEl && !event.target.closest('.graph-group input, .graph-group button')) {
      droppedIntoGroup = _addNodeIdsToGroup(dropGroupEl.dataset.groupId, Object.keys(graphView.dragStartPositions || {}));
    }
    graphInner?.querySelectorAll('.graph-node.dragging').forEach(el => el.classList.remove('dragging'));
    graphView.dragNodeId = null;
    graphView.dragStartPositions = {};
    graphView.dragWasSelected = false;
    graphView.dragModifier = false;
    graphView.panning = false;
    graphView.pointerId = null;
    graphView.moved = false;
    graphCanvas?.classList.remove('panning');
    if (droppedIntoGroup) renderGraphCanvas();
    return;
  }
  graphView.panning = false;
  graphView.pointerId = null;
  graphView.moved = false;
  graphCanvas?.classList.remove('panning');
}

async function _deleteSelectedGraphNodes(ids) {
  const timestamps = new Set();
  const drafts = [];
  const blanks = [];
  const customs = [];
  for (const id of ids) {
    const node = _findGraphNode(id);
    if (!node) continue;
    if (node.kind === 'blank') {
      blanks.push(id);
      continue;
    }
    if (node.kind === 'draft') {
      drafts.push(id);
      continue;
    }
    if (node.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(node.kind)) {
      customs.push(id);
      continue;
    }
    const message = _getChatHistory()[node.messageIndex];
    if (message) timestamps.add(String(message.timestamp || ''));
  }
  if (!timestamps.size) {
    _pushGraphUndo();
    drafts.forEach(id => removeDraftNode(id));
    blanks.forEach(id => deleteBlankNode(id, false));
    customs.forEach(id => deleteCustomNode(id, false));
    graphView.selectedNodeIds = new Set();
    _syncGraphSelectionClasses();
    return;
  }
  if (!confirm('确定删除选中的 ' + timestamps.size + ' 个节点及其子分支吗？')) return;
  _pushGraphUndo(true);
  drafts.forEach(id => removeDraftNode(id));
  blanks.forEach(id => deleteBlankNode(id, false));
  customs.forEach(id => deleteCustomNode(id, false));
  if (typeof window.deleteGraphMessagesByTimestamps === 'function') {
    await window.deleteGraphMessagesByTimestamps(Array.from(timestamps));
  } else if (typeof window.deleteGraphMessageByTimestamp === 'function') {
    for (const ts of timestamps) await window.deleteGraphMessageByTimestamp(ts);
  }
}

function quickConnectToHub(hubId) {
  const hub = _findGraphNode(hubId);
  if (!hub || hub.kind !== 'hub') return;
  const selectedIds = Array.from(graphView.selectedNodeIds || []);
  if (!selectedIds.length) {
    if (typeof showToast === 'function') showToast('请先选中要接入的节点');
    return;
  }

  const messages = _getChatHistory();
  const state = _graphState();
  const existingExtraPorts = (state.inputPortCounts && state.inputPortCounts[hubId]) || 0;
  const usedHubPorts = new Set(
    (state.connections || [])
      .filter(c => c.to === hubId)
      .map(c => String(c.toPort || 'in-0'))
  );
  let totalHubPorts = 1 + existingExtraPorts;
  const newConnections = [];

  for (const id of selectedIds) {
    const source = _findGraphNode(id);
    if (!source || source.kind === 'hub' || source.kind === 'draft') continue;
    const outputCount = _nodeOutputCount(source, messages, state);
    for (let i = 0; i < outputCount; i++) {
      const fromPort = 'out-' + i;
      const alreadyConnected = (state.connections || []).some(c =>
        c.from === id
        && (c.fromPort || 'out-0') === fromPort
        && c.to === hubId
      );
      if (alreadyConnected) continue;
      newConnections.push({
        from: id,
        fromPort,
        to: hubId,
        toPort: '',
        type: 'custom',
        custom: true,
      });
    }
  }

  if (!newConnections.length) {
    const hasOutput = selectedIds.some(id => {
      const source = _findGraphNode(id);
      return source && _nodeOutputCount(source, messages, state) > 0;
    });
    if (typeof showToast === 'function') {
      showToast(hasOutput ? '选中的输出已全部接入' : '选中的节点没有可连接的输出端口');
    }
    return;
  }

  for (const connection of newConnections) {
    let portIndex = 0;
    while (usedHubPorts.has('in-' + portIndex)) portIndex++;
    if (portIndex >= totalHubPorts) totalHubPorts = portIndex + 1;
    connection.toPort = 'in-' + portIndex;
    usedHubPorts.add('in-' + portIndex);
  }

  _pushGraphUndo();
  state.connections = state.connections || [];
  state.connections.push(...newConnections);
  state.inputPortCounts = state.inputPortCounts || {};
  state.inputPortCounts[hubId] = Math.max(existingExtraPorts, totalHubPorts - 1);
  _saveGraphState(state);
  renderGraphCanvas();
  if (typeof showToast === 'function') showToast('已接入 ' + newConnections.length + ' 个输出，并按需补齐输入端口');
}

function _saveCustomNodes() {
  const state = _graphState();
  state.customNodes = graphView.nodes
    .filter(node => node.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(node.kind))
    .map(node => ({ ...node }));
  _saveGraphState(state);
}

function openAddBlankNodeModal(x, y) {
  addBlankNodePoint = { x, y };
  closeAddBlankNodeModal();
  const overlay = document.createElement('div');
  overlay.className = 'graph-add-node-overlay';
  const items = MANUAL_NODE_OPTIONS.map(option => {
    return '<button class="graph-add-node-item" style="--node-color:' + option.color + '" onclick="createManualNode(\'' + option.key + '\')">'
      + '<span class="graph-add-node-dot"></span>'
      + escapeHtml(option.label)
      + '</button>';
  }).join('');
  overlay.innerHTML = '<div class="graph-add-node-dialog">'
    + '<div class="graph-add-node-head">'
    + '<div class="graph-add-node-title">添加节点</div>'
    + '<button class="graph-add-node-close" onclick="closeAddBlankNodeModal()" title="关闭">×</button>'
    + '</div>'
    + '<div class="graph-add-node-grid">' + items + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) closeAddBlankNodeModal();
  });
  document.body.appendChild(overlay);
  addBlankNodeOverlay = overlay;
}

function closeAddBlankNodeModal() {
  if (addBlankNodeOverlay) {
    addBlankNodeOverlay.remove();
    addBlankNodeOverlay = null;
  }
}

function _replaceModuleSection(content, moduleKey, newText) {
  const tag = String(moduleKey || '').trim();
  if (!tag) return content;
  const text = String(newText || '').trim();
  const regex = new RegExp('(<' + tag + '[^>]*>)([\\s\\S]*?)(</' + tag + '>)', 'i');
  if (regex.test(content || '')) {
    return String(content || '').replace(regex, '$1\n' + text + '\n$3');
  }
  return String(content || '') + '\n<' + tag + '>\n' + text + '\n</' + tag + '>';
}

let humanNoteModalOverlay = null;
let moduleNodeModalOverlay = null;

function editHumanNoteNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'human_note') return;
  closeHumanNoteNodeModal();
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal">'
    + '<div class="graph-network-modal-head"><span>编辑我的理解</span><button onclick="closeHumanNoteNodeModal()" title="关闭">×</button></div>'
    + '<label>标题</label>'
    + '<input id="humanNoteTitle" value="' + escapeHtml(node.label || '我的理解') + '">'
    + '<label>内容</label>'
    + '<textarea id="humanNoteContent" rows="6">' + escapeHtml(node.content || '') + '</textarea>'
    + '<label>公式</label>'
    + '<input id="humanNoteFormula" value="' + escapeHtml(node.formula || '') + '">'
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="saveHumanNoteNode(\'' + node.id + '\')">保存</button>'
    + '<button onclick="closeHumanNoteNodeModal()">取消</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(overlay);
  humanNoteModalOverlay = overlay;
}

function closeHumanNoteNodeModal() {
  if (humanNoteModalOverlay) {
    humanNoteModalOverlay.remove();
    humanNoteModalOverlay = null;
  }
}

function saveHumanNoteNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node) return;
  node.label = document.getElementById('humanNoteTitle')?.value?.trim() || '我的理解';
  node.content = document.getElementById('humanNoteContent')?.value || '';
  node.formula = document.getElementById('humanNoteFormula')?.value?.trim() || '';
  node.status = 'done';
  node.summary = node.content.slice(0, 120);
  _saveCustomNodes();
  closeHumanNoteNodeModal();
  renderGraphCanvas();
}

function editModuleNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'module') return;
  closeModuleNodeModal();
  const messages = _getChatHistory();
  const msg = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const current = node.messageIndex >= 0 ? _nodeContent(msg, node) : (node.content || '');
  const label = (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey || '模块';
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal">'
    + '<div class="graph-network-modal-head"><span>人工编辑：' + escapeHtml(label) + '</span><button onclick="closeModuleNodeModal()" title="关闭">×</button></div>'
    + '<label>模块内容</label>'
    + '<textarea id="moduleNodeContent" rows="8">' + escapeHtml(current) + '</textarea>'
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="saveModuleNode(\'' + node.id + '\')">保存</button>'
    + '<button onclick="closeModuleNodeModal()">取消</button>'
    + '</div>'
    + '</div>';
  document.body.appendChild(overlay);
  moduleNodeModalOverlay = overlay;
}

function closeModuleNodeModal() {
  if (moduleNodeModalOverlay) {
    moduleNodeModalOverlay.remove();
    moduleNodeModalOverlay = null;
  }
}

function saveModuleNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'module') return;
  const content = document.getElementById('moduleNodeContent')?.value || '';
  if (node.messageIndex >= 0) {
    const messages = _getChatHistory();
    const msg = messages[node.messageIndex];
    if (!msg) return;
    msg.content = _replaceModuleSection(msg.content, node.moduleKey, content);
    if (typeof window.updateChatHistoryMessage === 'function') {
      window.updateChatHistoryMessage(String(msg.timestamp || ''), () => msg);
    }
    if (typeof window.saveCurrentSession === 'function') window.saveCurrentSession();
  } else {
    node.content = content;
    node.status = 'done';
    node.summary = content.slice(0, 120);
    _saveCustomNodes();
  }
  closeModuleNodeModal();
  renderGraphCanvas();
}

function createManualNode(nodeKind) {
  const option = MANUAL_NODE_OPTIONS.find(item => item.key === nodeKind);
  if (!option) return;
  _pushGraphUndo();
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: option.key + '-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    kind: option.kind,
    moduleKey: option.kind === 'module' || option.kind === 'hub' || option.kind === 'summary' || option.kind === 'note' ? option.key : '',
    manual: option.key === 'manual' || option.key === 'note' || option.key === 'relation' || option.key === 'source' || option.key === 'knowledge',
    content: '',
    status: 'empty',
    summary: '',
    analysis: '',
    analysisHash: '',
    inputHash: '',
    generatedAt: 0,
    requirements: '',
    busy: false,
    generated: false,
    maxItems: option.key === 'source' ? 5 : 0,
    items: [],
    edges: [],
    fileId: '',
    fileName: '',
    generatedNodeIds: [],
    category: '',
    formulas: [],
    knowledgeKey: '',
    x: addBlankNodePoint.x,
    y: addBlankNodePoint.y,
    depth: option.kind === 'user' ? 1 : option.kind === 'answer' ? 2 : (option.key === 'summary' || option.key === 'note' ? 4 : 3),
    targetAngle: 0,
    isRoot: false,
    timestamp: Date.now(),
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: null,
    customHeight: null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  });
  _saveGraphState(state);
  closeAddBlankNodeModal();
  renderGraphCanvas();
}

function createBlankNode(moduleKey) {
  return createManualNode(moduleKey);
}

function deleteBlankNode(nodeId, pushUndo = true) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank') return;
  if (pushUndo) _pushGraphUndo();
  graphView.nodes = graphView.nodes.filter(item => item.id !== nodeId);
  delete graphView.nodeById[nodeId];
  graphView.edges = graphView.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
  const state = _graphState();
  state.customNodes = (state.customNodes || []).filter(item => item.id !== nodeId);
  state.connections = (state.connections || []).filter(edge => edge.from !== nodeId && edge.to !== nodeId);
  _saveGraphState(state);
  renderGraphCanvas();
}

function deleteCustomNode(nodeId, pushUndo = true) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0) return;
  if (pushUndo) _pushGraphUndo();
  graphView.nodes = graphView.nodes.filter(item => item.id !== nodeId);
  delete graphView.nodeById[nodeId];
  graphView.edges = graphView.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId);
  const state = _graphState();
  state.customNodes = (state.customNodes || []).filter(item => item.id !== nodeId);
  state.connections = (state.connections || []).filter(edge => edge.from !== nodeId && edge.to !== nodeId);
  _saveGraphState(state);
  renderGraphCanvas();
}

function updateCustomNodeContent(nodeId, value) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0) return;
  node.content = String(value || '');
  node.summary = _graphSummary(node.content);
  const state = _graphState();
  state.customNodes = graphView.nodes
    .filter(item => item.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(item.kind))
    .map(item => ({ ...item }));
  _saveGraphState(state);
}

function updateSourceNodeMax(nodeId, value) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'source') return;
  const next = Math.max(1, Math.min(50, parseInt(value, 10) || 5));
  node.maxItems = next;
  _saveCustomNodes();
  renderGraphCanvas();
}

function _clearSourceGeneratedNodes(node) {
  const state = _graphState();
  const oldIds = new Set(node.generatedNodeIds || []);
  state.customNodes = (state.customNodes || []).filter(item => !oldIds.has(item.id));
  state.connections = (state.connections || []).filter(edge => !oldIds.has(edge.from) && !oldIds.has(edge.to));
  if (state.positions) {
    for (const id of oldIds) delete state.positions[id];
  }
  if (state.inputPortCounts) {
    for (const id of oldIds) delete state.inputPortCounts[id];
  }
  node.generatedNodeIds = [];
  _saveGraphState(state);
}

function _sourceNodePosition(node, index, count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count))));
  const row = Math.floor(index / cols);
  const col = index % cols;
  const colSpan = Math.max(1, count - 1);
  return {
    x: node.x + 430 + (col - (cols - 1) / 2) * Math.min(240, 900 / cols),
    y: node.y + (row - Math.max(0, Math.ceil(count / cols) - 1) / 2) * 170,
  };
}

function _saveDocumentKnowledgeToPanel(node, items, knowledgeNodes) {
  if (!items || !items.length || typeof saveKnowledgeItems !== 'function') return;
  const current = typeof getKnowledgeItems === 'function' ? getKnowledgeItems() : {};
  const now = Date.now();
  const pending = { ...current };
  items.forEach((item, index) => {
    const knowledgeNode = knowledgeNodes[index];
    const id = 'kf_' + (item.id || item.title || index) + '_' + _simpleHash(node.id + ':' + index);
    pending[id] = {
      id,
      title: item.title || '知识点',
      category: item.category || 'other',
      tags: item.tags || [],
      summary: item.summary || '',
      formulas: item.formulas || [],
      source: 'file',
      sourceType: 'file',
      fileId: node.fileId || '',
      fileName: node.fileName || '',
      sessionId: typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '',
      messageId: '',
      moduleKey: 'knowledge',
      nodeId: knowledgeNode ? knowledgeNode.id : '',
      createdAt: now,
    };
  });
  saveKnowledgeItems(pending);
  if (typeof saveFormulasToServer === 'function') {
    const formulas = [];
    items.forEach((item, index) => {
      for (const latex of item.formulas || []) {
        formulas.push({
          latex,
          concept: item.title || '知识点',
          meaning: '',
          meaningSource: 'local',
          topic: '',
          related: item.tags || [],
          sessionId: typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '',
          messageId: '',
          moduleKey: item.category === 'math' ? 'math' : item.category === 'physics' ? 'physics' : 'knowledge',
          nodeId: knowledgeNodes[index] ? knowledgeNodes[index].id : '',
          createdAt: now,
        });
      }
    });
    if (formulas.length) saveFormulasToServer(formulas);
  }
}

function _relationScore(rel, fallback) {
  const score = Number(rel && rel.score);
  if (Number.isFinite(score)) return Math.max(0, Math.min(1, score));
  return fallback == null ? 0.75 : fallback;
}

function _isWeakRelationText(value) {
  return /^(相关|有联系|关联|联系|有关|包含|关系|本质联系)$/i.test(String(value || '').trim());
}

function _relationGroupsFromData(relations, edges) {
  const groups = [];
  if (Array.isArray(relations)) {
    for (const rel of relations) {
      if (!rel || typeof rel !== 'object') continue;
      const label = String(rel.label || rel.meaning || rel.type || '').trim();
      if (_isWeakRelationText(label)) continue;
      const nodes = Array.isArray(rel.nodes)
        ? rel.nodes.map(item => String(item || '')).filter(Boolean)
        : [];
      if (!nodes.length && rel.from && rel.to) nodes.push(String(rel.from), String(rel.to));
      const unique = Array.from(new Set(nodes));
      if (unique.length < 2) continue;
      groups.push({
        nodes: unique.slice(0, 4),
        label,
        type: String(rel.type || '本质联系') || '本质联系',
        score: _relationScore(rel, label ? 0.75 : 0.5),
      });
    }
  }
  if (!groups.length && Array.isArray(edges)) {
    for (const edge of edges) {
      if (!edge || typeof edge !== 'object') continue;
      const label = String(edge.label || edge.type || '').trim();
      if (_isWeakRelationText(label)) continue;
      const from = String(edge.from || '');
      const to = String(edge.to || '');
      if (!from || !to || from === to) continue;
      groups.push({
        nodes: [from, to],
        label,
        type: String(edge.type || '本质联系') || '本质联系',
        score: _relationScore(edge, label ? 0.7 : 0.5),
      });
    }
  }
  groups.sort((a, b) => b.score - a.score);
  return groups.filter(group => group.score >= 0.6).slice(0, 3);
}

function _applyParsedDocumentToNode(node, data) {
  if (!node) return;
  node = _findGraphNode(node.id) || node;
  _clearSourceGeneratedNodes(node);
  const items = Array.isArray(data.nodes) ? data.nodes.slice(0, Math.max(1, node.maxItems || 5)) : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  const relationGroups = _relationGroupsFromData(data.relations, edges);
  node.items = items;
  node.edges = edges;
  node.relations = relationGroups;
  node.fileId = data.fileId || node.fileId;
  node.fileName = data.fileName || node.fileName;
  node.status = 'done';
  node.busy = false;

  const state = _graphState();
  state.customNodes = (state.customNodes || []).map(item => item.id === node.id ? ({ ...node }) : item);
  state.connections = state.connections || [];
  const itemToNode = {};
  const knowledgeNodes = [];
  const createdIds = [];

  items.forEach((item, index) => {
    const pos = _sourceNodePosition(node, index, items.length);
    const nodeId = 'knowledge-custom-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 7);
    const knowledgeNode = {
      id: nodeId,
      kind: 'knowledge',
      moduleKey: 'knowledge',
      manual: true,
      content: item.summary || item.title || '',
      status: 'done',
      summary: item.summary || '',
      analysis: '',
      analysisHash: '',
      inputHash: '',
      generatedAt: Date.now(),
      requirements: '',
      busy: false,
      generated: false,
      maxItems: 0,
      items: [],
      edges: [],
      fileId: node.fileId || '',
      fileName: node.fileName || '',
      generatedNodeIds: [],
      title: item.title || '知识点',
      category: item.category || 'other',
      tags: item.tags || [],
      formulas: item.formulas || [],
      knowledgeKey: item.id || item.title || nodeId,
      sourceNodeId: node.id,
      x: pos.x,
      y: pos.y,
      depth: 3,
      targetAngle: 0,
      isRoot: false,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: 260,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
    state.customNodes.push(knowledgeNode);
    knowledgeNodes.push(knowledgeNode);
    itemToNode[String(item.id || item.title || index)] = nodeId;
    createdIds.push(nodeId);
    state.connections.push({
      from: node.id,
      fromPort: 'out-' + index,
      to: nodeId,
      toPort: 'in-0',
      type: 'knowledge',
      custom: true,
    });
  });

  const relationInputCounts = {};
  relationGroups.forEach((rel, index) => {
    const nodeIds = (rel.nodes || [])
      .map(raw => itemToNode[String(raw)])
      .filter(Boolean);
    const uniqueNodeIds = Array.from(new Set(nodeIds));
    if (uniqueNodeIds.length < 2) return;
    const relationId = 'relation-custom-' + Date.now() + '-' + index + '-' + Math.random().toString(36).slice(2, 7);
    const pos = _sourceNodePosition(node, items.length + index, items.length + relationGroups.length);
    const relationNode = {
      id: relationId,
      kind: 'relation',
      moduleKey: 'relation',
      manual: true,
      content: rel.label || rel.type || '',
      status: rel.label || rel.type ? 'done' : 'empty',
      summary: '',
      analysis: '',
      analysisHash: '',
      inputHash: '',
      generatedAt: Date.now(),
      requirements: '',
      busy: false,
      generated: false,
      maxItems: 0,
      items: [],
      edges: [],
      fileId: node.fileId || '',
      fileName: node.fileName || '',
      generatedNodeIds: [],
      category: '',
      formulas: [],
      knowledgeKey: '',
      x: pos.x,
      y: pos.y + 60,
      depth: 4,
      targetAngle: 0,
      isRoot: false,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: 280,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
    state.customNodes.push(relationNode);
    createdIds.push(relationId);
    uniqueNodeIds.forEach((fromId, portIndex) => {
      const toPort = 'in-' + (relationInputCounts[relationId] || 0);
      relationInputCounts[relationId] = (relationInputCounts[relationId] || 0) + 1;
      state.connections.push({
        from: fromId,
        fromPort: 'out-2',
        to: relationId,
        toPort,
        type: rel.type || '本质联系',
        custom: true,
      });
    });
  });

  for (const [relationId, count] of Object.entries(relationInputCounts)) {
    state.inputPortCounts = state.inputPortCounts || {};
    state.inputPortCounts[relationId] = Math.max(0, count - 2);
  }
  node.generatedNodeIds = createdIds;
  _saveGraphState(state);
  _saveDocumentKnowledgeToPanel(node, items, knowledgeNodes);
  renderGraphCanvas();
  if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
  if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
  if (typeof showToast === 'function') {
    showToast('已解析 ' + items.length + ' 个知识点' + (relationGroups.length ? '，' + relationGroups.length + ' 条本质联系' : ''));
  }
}

async function _parseSourceNodeFile(node, fileName, contentBase64, maxItems) {
  if (!node || node.busy) return;
  node.busy = true;
  node.status = 'running';
  node.fileName = fileName || node.fileName;
  node.maxItems = Math.max(1, Math.min(50, maxItems || node.maxItems || 5));
  _saveCustomNodes();
  renderGraphCanvas();
  node = _findGraphNode(node.id) || node;
  if (typeof showProgress === 'function') showProgress('tool', 12, '正在读取文件并解析知识点...');

  const agentModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('agent') : null;
  const payload = {
    fileName: node.fileName,
    maxItems: node.maxItems,
    level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
    provider: agentModel ? agentModel.provider : '',
    api_key: agentModel ? agentModel.apiKey : '',
    model: agentModel ? agentModel.model : '',
    base_url: agentModel ? agentModel.baseUrl : '',
  };
  if (node.fileId) payload.fileId = node.fileId;
  else if (contentBase64) payload.contentBase64 = contentBase64;

  try {
    if (typeof showProgress === 'function') showProgress('tool', 40, '正在调用解析服务...');
    const resp = await fetch('/api/documents/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (resp.status === 404 || resp.status === 405) {
      throw new Error('后端未加载文件解析接口，请先重启 python src/main.py');
    }
    const data = await resp.json();
    if (!resp.ok || !data.ok) throw new Error(data.detail || data.error || '文件解析失败');
    if (!data.nodes || !data.nodes.length) throw new Error('未提取到知识点，请调整文件内容或数量限制');
    if (typeof showProgress === 'function') showProgress('tool', 85, '正在生成知识网络...');
    _applyParsedDocumentToNode(node, data);
    if (typeof hideProgress === 'function') hideProgress('文件解析完成');
  } catch (err) {
    node.busy = false;
    node.status = 'error';
    _saveCustomNodes();
    renderGraphCanvas();
    if (typeof hideProgress === 'function') hideProgress('文件解析失败');
    if (typeof showToast === 'function') showToast('解析失败：' + (err.message || err));
  }
}

function _loadSourceNodeFile(node, file, maxItems) {
  if (!node || !file) return;
  node.fileId = '';
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result || '').split(',')[1] || '';
    _parseSourceNodeFile(node, file.name, base64, maxItems);
  };
  reader.readAsDataURL(file);
}

function handleSourceNodeFile(inputEl, nodeId) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  const node = _findGraphNode(nodeId);
  if (!node) return;
  const maxEl = inputEl.closest('.graph-node')?.querySelector('.graph-source-max-input');
  const maxItems = maxEl ? parseInt(maxEl.value, 10) || 5 : (node.maxItems || 5);
  _loadSourceNodeFile(node, file, maxItems);
  if (inputEl) inputEl.value = '';
}

function handleSourceNodeDrop(event, nodeId) {
  event.preventDefault();
  const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;
  const node = _findGraphNode(nodeId);
  if (!node) return;
  const maxEl = event.target.closest('.graph-node')?.querySelector('.graph-source-max-input');
  const maxItems = maxEl ? parseInt(maxEl.value, 10) || 5 : (node.maxItems || 5);
  _loadSourceNodeFile(node, file, maxItems);
}

function reparseSourceNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'source' || !node.fileId) return;
  _parseSourceNodeFile(node, node.fileName, '', node.maxItems);
}

function generateKnowledgeNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'knowledge' || node.busy) return;
  _generateCustomNode(node);
}

function generateRelationNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'relation') return;
  const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft);
  if (incoming.length < 2) {
    if (typeof showToast === 'function') showToast('请先连接至少两个上游节点');
    return;
  }
  _generateCustomNode(node);
}

function _blankNodeGraphPath(node) {
  const ordered = [];
  const visited = new Set();
  let current = node;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.kind !== 'blank') ordered.push(current);
    const incoming = (graphView.edges || []).find(edge => String(edge.to) === current.id);
    current = incoming ? _findGraphNode(incoming.from) : null;
  }
  ordered.reverse();
  return ordered.map(item => ({
    kind: item.kind,
    timestamp: item.timestamp || '',
    module: item.moduleKey || '',
    branchType: item.branchType || '',
    content: item.messageIndex >= 0
      ? _nodeContent(_getChatHistory()[item.messageIndex] || null, item)
      : (item.content || ''),
  }));
}

function _simpleHash(value) {
  let hash = 5381;
  const text = String(value || '');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(36);
}

function _nodeStoredContent(node) {
  if (!node) return '';
  if (node.messageIndex >= 0) {
    const msg = _getChatHistory()[node.messageIndex] || null;
    if (node.kind === 'user') return msg?.content || '';
    if (node.kind === 'answer') return _graphSummary(msg?.content || '') || '';
    if (node.kind === 'module') return _nodeContent(msg, node);
  }
  return node.summary || node.content || '';
}

function _findQuestionContentUpstream(node) {
  const visited = new Set();
  function walk(current) {
    if (!current || visited.has(current.id)) return '';
    visited.add(current.id);
    if (current.kind === 'user') return _nodeStoredContent(current);
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === current.id && !edge.draft);
    for (const edge of incoming) {
      const source = _findGraphNode(edge.from);
      const found = walk(source);
      if (found) return found;
    }
    return '';
  }
  return walk(node);
}

function _nodeOutputContent(node, seen) {
  if (!node) return '';
  seen = seen || new Set();
  if (seen.has(node.id)) return '';
  seen.add(node.id);
  if (node.kind === 'hub') {
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft);
    return incoming
      .map(edge => _nodeOutputContent(_findGraphNode(edge.from), seen))
      .filter(Boolean)
      .join('\n\n');
  }
  if (node.kind === 'answer' && !node.manual && node.messageIndex < 0) {
    return node.analysis || _findQuestionContentUpstream(node) || '';
  }
  return _nodeStoredContent(node);
}

function _collectUpstreamPath(node) {
  const ordered = [];
  const orderedIds = new Set();
  function collect(current) {
    if (!current || orderedIds.has(current.id)) return;
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === current.id && !edge.draft);
    for (const edge of incoming) {
      const source = _findGraphNode(edge.from);
      if (source) collect(source);
    }
    if (!orderedIds.has(current.id)) {
      orderedIds.add(current.id);
      ordered.push(current);
    }
  }
  collect(node);
  return ordered.map(item => {
    const raw = _nodeOutputContent(item);
    return {
      kind: item.kind,
      timestamp: item.timestamp || '',
      module: item.moduleKey || '',
      manual: !!item.manual,
      analysis: item.kind === 'answer' && !item.manual ? (item.analysis || '') : '',
      summary: _graphSummary(raw) || '',
      content: raw,
    };
  });
}

function _buildWorkflowContextForNode(node) {
  const meta = node.kind === 'module'
    ? (GRAPH_MODULE_META[node.moduleKey] || { label: node.moduleKey || '模块节点' })
    : node.kind === 'answer'
      ? { label: node.manual ? '非 AI 回答' : 'AI 回答' }
      : node.kind === 'hub'
        ? { label: '汇聚' }
        : node.kind === 'summary'
          ? { label: 'AI 总结' }
      : node.kind === 'note'
          ? { label: '人工总结' }
          : node.kind === 'source'
            ? { label: '输入' }
            : node.kind === 'knowledge'
              ? { label: '知识点' }
              : node.kind === 'relation'
                ? { label: '知识联系' }
            : { label: '问题' };
  const allUpstream = _collectUpstreamPath(node);
  const analysisNode = allUpstream.find(item => item.kind === 'answer' && !item.manual);
  const upstream = allUpstream.filter(item => !(item.kind === 'answer' && !item.manual));
  const questionNode = upstream.find(item => item.kind === 'user');
  return {
    target: { kind: node.kind, module: node.moduleKey || '', label: meta.label || node.moduleKey || '节点' },
    question: questionNode ? questionNode.content : '',
    analysis: analysisNode ? analysisNode.analysis : '',
    mode: 'module',
    requirements: node.requirements || '',
    upstream: upstream.map(item => ({
      kind: item.kind,
      module: item.module,
      label: item.kind === 'user'
        ? '问题'
        : item.kind === 'knowledge'
          ? '知识点'
          : item.kind === 'relation'
            ? '知识联系'
            : item.kind === 'source'
              ? '输入'
        : item.kind === 'answer'
          ? (item.manual ? '非 AI 回答' : 'AI 回答')
          : ((GRAPH_MODULE_META[item.module] || {}).label || item.module || '上游节点'),
      summary: item.summary,
      analysis: item.analysis || '',
      content: (item.content || '').slice(0, 800),
    })),
  };
}

function _collectDependencyChain(nodeId) {
  const chain = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const node = _findGraphNode(id);
    if (!node) return;
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === id && !edge.draft);
    for (const edge of incoming) visit(edge.from);
    chain.push(node);
  }
  visit(nodeId);
  return chain;
}

function _nodeInputHash(node) {
  const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft);
  const parts = incoming
    .map(edge => (edge.fromPort || 'out-0') + '=' + _nodeOutputContent(_findGraphNode(edge.from)))
    .sort();
  return _simpleHash((node.moduleKey || '') + '|' + (node.requirements || '') + '|' + parts.join('|'));
}

function _workflowPromptForNode(node, workflowContext) {
  const targetLabel = workflowContext.target.label || '节点';
  if (node.kind === 'hub') {
    return '这是汇聚节点，由上游连线收集内容，不需要 AI 生成。';
  }
  if (node.kind === 'summary') {
    const upstreamText = (workflowContext.upstream || [])
      .map(item => (item.content ? item.label + '：\n' + item.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);
    return '请根据以下已连接内容生成一份简明、结构化的 AI 总结。'
      + '要求：提炼物理直觉、数学本质、关键结论、公式和后续建议；只输出总结正文；不要输出完整学习卡片 XML，不要输出 <summary> 标签，不要输出其他模块正文；如出现公式仍按 <formula> 规范标注。\n\n'
      + (upstreamText || '（暂无已连接的上游内容）');
  }
  if (node.kind === 'relation') {
    const upstreamText = (workflowContext.upstream || [])
      .map(item => (item.content ? item.label + '：\n' + item.content : ''))
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);
    return '请基于以下已连接节点，用一句简短中文说明它们之间的联系。'
      + '要求：内容简短，最好不超过100字；如果涉及多个节点，说明它们之间共同的知识关系；不要输出XML标签，不要重复完整节点内容；如出现公式仍按 <formula> 规范标注。\n\n'
      + (upstreamText || '（暂无已连接的上游内容）');
  }
  if (node.kind === 'knowledge') {
    const sourceText = [
      node.title || '知识点',
      node.summary || '',
      (node.formulas || []).join('\n'),
    ].filter(Boolean).join('\n\n');
    return '请为以下知识点生成一段准确、简洁的中文解释。'
      + '要求：说明核心含义、物理或数学本质、适用条件；不要输出XML标签；如出现公式仍按 <formula> 规范标注；不要重复来源文件全文。\n\n'
      + (sourceText || '（暂无知识点内容）');
  }
  if (node.kind === 'answer' && !node.manual) {
    return '请根据用户问题生成 AI 回答节点的完整内容。'
      + '按 PhyMathia 系统提示词输出完整学习卡片 XML，包含 physics/math/graph/viz/learn/socratic 等标签，末尾输出 <summary>。';
  }
  if (node.kind === 'module') {
    const strictInstruction = _strictModuleOutputInstruction(node.moduleKey || workflowContext.target.module || '');
    return '请基于工作流上下文中的隐藏问题分析保持一致性，但不要重复分析内容。'
      + '请生成「' + targetLabel + '」节点内容。'
      + '只输出该模块正文，不要输出完整学习卡片的 XML 标签，不要重复其他模块内容。'
      + (strictInstruction ? '\n\n' + strictInstruction : '');
  }
  if (node.manual) {
    return '这是非 AI 回答节点，由用户手动填写即可，不需要 AI 生成。';
  }
  return '请生成问题节点内容。';
}

function _strictModuleOutputInstruction(moduleKey) {
  if (moduleKey === 'socratic') {
    return '严格按以下格式输出，不得增加前言、答案、解释或任何其他模块：\n'
      + '### 苏格拉底追问\n'
      + '1. [基础] 只写一个基础引导问题\n'
      + '2. [进阶] 只写一个进阶引导问题\n'
      + '3. [拓展] 只写一个拓展引导问题\n'
      + '不要使用 XML 标签，不要输出“进阶学习方向”，不要展开问题背景，不要写“想一想”等引导语。';
  }
  if (moduleKey === 'learn') {
    return '严格按以下格式输出，不得增加前言、公式段、步骤讲解或任何其他模块：\n'
      + '### 进阶学习方向\n'
      + '1. 方向1\n'
      + '2. 方向2\n'
      + '3. 方向3\n'
      + '不要使用 XML 标签，不要输出“苏格拉底追问”，每条方向只保留一个短句，不要展开学习步骤。';
  }
  return '';
}

async function _streamCustomNodeResponse(resp, node) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let renderPending = false;
  let streamChunkCount = 0;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      if (renderBox && live) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
      }
      const textarea = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-content');
      if (textarea) textarea.value = content;
      if (node.kind === 'blank') _renderBlankNodeLive(node, content);
      _measureNodes();
      _updateNodeTransforms();
      _redrawEdges();
    });
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices && data.choices[0] && data.choices[0].delta;
          if (delta && delta.content) {
            content += delta.content;
            _scheduleWorkflowStreamProgress(content.length);
            streamChunkCount++;
            if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            scheduleRender();
          }
        } catch (e) {}
      }
    }
  }

  let cleaned = node.kind === 'module' ? _cleanBlankNodeContent(node, content) : content;
  if (!cleaned.trim()) cleaned = content;
  const live = _findGraphNode(node.id);
  if (live) {
    live.content = cleaned;
    live.summary = _graphSummary(cleaned);
    live.status = 'done';
    live.generatedAt = Date.now();
    live.inputHash = _nodeInputHash(live);
    live.busy = false;
  }
  _saveCustomNodes();
  if (node.kind === 'blank') _renderBlankNodeLive(node, cleaned);
  if (!workflowRunActive) renderGraphCanvas();
}

async function _readStreamText(resp) {
  if (!resp || !resp.body) return '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let streamChunkCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices && data.choices[0] && data.choices[0].delta;
          if (delta && delta.content) {
            content += delta.content;
            _scheduleWorkflowStreamProgress(content.length);
            streamChunkCount++;
            if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          }
        } catch (e) {}
      }
    }
  }
  return content;
}

async function _streamAnalysisResponse(resp, node, question) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let analysis = '';
  let renderPending = false;
  let streamChunkCount = 0;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (!live) return;
      live.analysis = analysis;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      if (renderBox) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
      }
      _measureNodes();
      _updateNodeTransforms();
      _redrawEdges();
    });
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices && data.choices[0] && data.choices[0].delta;
          if (delta && delta.content) {
            analysis += delta.content;
            _scheduleWorkflowStreamProgress(analysis.length);
            streamChunkCount++;
            if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            scheduleRender();
          }
        } catch (e) {}
      }
    }
  }

  let cleaned = analysis.trim();
  if (typeof stripXmlTags === 'function') cleaned = stripXmlTags(cleaned).trim();
  if (cleaned.length > 1200) cleaned = cleaned.slice(0, 1200);
  const live = _findGraphNode(node.id);
  if (live) {
    live.analysis = cleaned;
    live.analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
    live.status = 'done';
    live.busy = false;
  }
  const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
  if (renderBox && live) {
    renderBox.innerHTML = _renderCustomNodeContentHtml(live);
    if (typeof renderMath === 'function') renderMath(renderBox);
  }
  _saveCustomNodes();
  if (!workflowRunActive) renderGraphCanvas();
}

async function _generateAnalysis(node) {
  if (!node || node.busy) return;
  const question = _findQuestionContentUpstream(node);
  if (!question.trim()) {
    node.status = 'waiting';
    _saveCustomNodes();
    if (!workflowRunActive) renderGraphCanvas();
    if (typeof showToast === 'function') showToast('请先连接并填写问题节点');
    return;
  }
  node.busy = true;
  node.status = 'running';
  _saveCustomNodes();
  if (workflowRunActive) _refreshWorkflowNodeUi(node);
  else renderGraphCanvas();

  const workflowContext = {
    mode: 'analysis',
    target: { kind: 'answer', label: 'AI 回答' },
    question,
    requirements: node.requirements || '',
  };
  const prompt = '请分析用户问题，只输出简洁的问题概要。'
    + '要求：1) 核心物理概念；2) 核心数学结构；3) 物理与数学的关系；4) 相关知识点。'
    + '不要输出完整答案，不要输出 XML 标签，不要生成任何模块内容，控制在300字以内。';
  const branchMeta = {
    parentId: String(node.timestamp || ''),
    sourceModule: '',
    branchType: '',
    branchId: '',
    branchLabel: '问题分析',
    graphPath: [],
    workflowContext,
  };
  const signal = workflowAbortController ? workflowAbortController.signal : new AbortController().signal;
  const blankStartedAt = Date.now();

  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        resp = await proxyChat(
          prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          true,
          signal,
          branchMeta
        );
      }
    }
    if (!resp) {
      resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'agent',
          prompt,
          level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          session_id: typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          stream: true,
          workflow_context: branchMeta.workflowContext || {},
        }),
        signal,
      });
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamAnalysisResponse(resp, node, question);
  } catch (err) {
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
    }
    _saveCustomNodes();
    if (!workflowRunActive) renderGraphCanvas();
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('问题分析失败：' + (err.message || err));
  }
}

async function _generateCustomNode(node) {
  if (!node || node.busy) return;
  if (node.kind === 'answer' && !node.manual) return;
  if (node.kind === 'hub') return;
  node.busy = true;
  node.status = 'running';
  _saveCustomNodes();
  if (workflowRunActive) _refreshWorkflowNodeUi(node);
  else renderGraphCanvas();

  const workflowContext = _buildWorkflowContextForNode(node);
  const prompt = _workflowPromptForNode(node, workflowContext);
  const graphPath = _blankNodeGraphPath(node);
  const pathParent = graphPath[graphPath.length - 1];
  const branchMeta = {
    parentId: pathParent ? String(pathParent.timestamp || '') : String(node.timestamp || ''),
    sourceModule: node.moduleKey || '',
    branchType: 'blank',
    branchId: '',
    branchLabel: workflowContext.target.label,
    graphPath,
    workflowContext,
  };
  const signal = workflowAbortController ? workflowAbortController.signal : new AbortController().signal;

  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        resp = await proxyChat(
          prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          true,
          signal,
          branchMeta
        );
      }
    }
    if (!resp) {
      resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'agent',
          prompt,
          level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          session_id: typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          stream: true,
          branch_id: branchMeta.branchId || '',
          branch_type: branchMeta.branchType || '',
          source_module: branchMeta.sourceModule || '',
          parent_id: branchMeta.parentId || '',
          branch_label: branchMeta.branchLabel || '',
          graph_path: branchMeta.graphPath || [],
          workflow_context: branchMeta.workflowContext || {},
        }),
        signal,
      });
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamCustomNodeResponse(resp, node);
  } catch (err) {
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
    }
    _saveCustomNodes();
    if (!workflowRunActive) renderGraphCanvas();
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
  }
}

function _workflowProgressLabel(node) {
  if (!node) return '';
  if (node.kind === 'source') return '输入';
  if (node.kind === 'knowledge') return '知识点';
  if (node.kind === 'relation') return '知识联系';
  if (node.manual) return node.kind === 'note' ? '人工总结' : '非 AI 回答';
  if (node.kind === 'hub') return '汇聚';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'answer') return 'AI 回答';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  return node.kind;
}

function _workflowItemNeedsProgress(node) {
  if (!node) return false;
  if (node.messageIndex >= 0) return false;
  if (node.manual) return false;
  if (node.kind === 'user') return false;
  if (node.kind === 'hub') return false;
  if (node.kind === 'summary') {
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash && node.status === 'done');
  }
  if (node.kind === 'answer' && !node.manual) {
    const question = _findQuestionContentUpstream(node);
    const analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
    return !node.analysis || node.analysisHash !== analysisHash;
  }
  if (node.kind === 'module') {
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash && node.status === 'done');
  }
  return false;
}

function _markWorkflowCurrentNode(current) {
  const label = _workflowProgressLabel(current);
  if (label) workflowProgressActive.add(label);
  workflowProgressCurrentLabel = label ? '正在生成' + label : '正在运行工作流';
  const statusText = _workflowProgressStatusText();
  const pct = workflowProgressTotal ? Math.round(workflowProgressDone / workflowProgressTotal * 100) : 0;
  if (typeof showProgress === 'function') {
    showProgress('tool', pct, '工作流 ' + statusText);
  }
}

function _workflowProgressStatusText() {
  const active = Array.from(workflowProgressActive).filter(Boolean);
  let text = workflowProgressDone + '/' + workflowProgressTotal;
  if (active.length) text += ' · 运行中 ' + active.length + ' · ' + active.slice(0, 3).join('、');
  return text;
}

let workflowProgressTimer = null;
let workflowProgressLength = 0;
let workflowProgressTotal = 0;
let workflowProgressDone = 0;
let workflowProgressCurrentLabel = '';

function _applyWorkflowStreamProgress() {
  workflowProgressTimer = null;
  const total = workflowProgressTotal;
  const done = workflowProgressDone;
  if (!total) return;
  const streamFraction = Math.min(0.85, workflowProgressLength / 20000);
  const pct = Math.round((done / total) * 100 + streamFraction * (100 / total));
  const target = Math.max((done / total) * 100, Math.min(99, pct));
  const current = typeof window.getCurrentProgress === 'function' ? window.getCurrentProgress() : 0;
  if (target < current) return;
  if (typeof showProgress === 'function') {
    showProgress('tool', target, '工作流 ' + _workflowProgressStatusText());
  }
}

function _scheduleWorkflowStreamProgress(length) {
  workflowProgressLength = Math.max(workflowProgressLength, length || 0);
  if (workflowProgressTimer) return;
  workflowProgressTimer = setTimeout(_applyWorkflowStreamProgress, 120);
}

function _setWorkflowStopButton(active) {
  const btn = document.getElementById('stopBtn');
  if (btn) btn.disabled = !active;
  const runBtn = document.getElementById('runAllBtn');
  if (runBtn) runBtn.disabled = active;
  const miniRunBtn = document.getElementById('statusRunBtn');
  const miniStopBtn = document.getElementById('statusStopBtn');
  if (miniRunBtn) miniRunBtn.disabled = active;
  if (miniStopBtn) miniStopBtn.disabled = !active;
}

function _showWorkflowProgress(total) {
  if (workflowProgressTimer) {
    clearTimeout(workflowProgressTimer);
    workflowProgressTimer = null;
  }
  workflowProgressLength = 0;
  workflowProgressTotal = total || 0;
  workflowProgressDone = 0;
  workflowProgressActive.clear();
  workflowProgressCurrentLabel = '准备运行工作流';
  if (typeof showProgress === 'function') showProgress('tool', 0, '准备运行工作流 · 0/' + workflowProgressTotal);
}

function _advanceWorkflowProgress(label) {
  if (workflowProgressTimer) {
    clearTimeout(workflowProgressTimer);
    workflowProgressTimer = null;
  }
  workflowProgressLength = 0;
  if (workflowProgressActive.has(label)) workflowProgressActive.delete(label);
  workflowProgressDone = Math.min(workflowProgressTotal, workflowProgressDone + 1);
  workflowProgressCurrentLabel = label ? '正在生成' + label : '正在运行工作流';
  const total = workflowProgressTotal;
  const done = workflowProgressDone;
  const statusText = _workflowProgressStatusText();
  if (typeof showProgress === 'function') {
    const pct = total ? Math.round(done / total * 100) : 0;
    showProgress('tool', pct, '工作流 ' + statusText);
  }
}

function _hideWorkflowProgress() {
  workflowProgressTotal = 0;
  workflowProgressDone = 0;
  workflowProgressActive.clear();
  workflowProgressCurrentLabel = '';
  if (workflowProgressTimer) {
    clearTimeout(workflowProgressTimer);
    workflowProgressTimer = null;
  }
  if (typeof hideProgress === 'function') hideProgress();
}

async function _processWorkflowChainItem(current, force) {
  if (!current) return false;
  if (current.messageIndex >= 0) return true;
  if (workflowAbortController?.signal.aborted) return false;

  if (current.kind === 'hub') {
    const hasInput = (graphView.edges || []).some(edge => String(edge.to) === current.id && !edge.draft);
    current.status = hasInput ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'source') {
    current.status = current.items && current.items.length ? 'done' : 'waiting';
    return true;
  }
  if (current.kind === 'knowledge' || current.kind === 'relation') {
    current.status = (current.content || '').trim() ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'answer' && !current.manual) {
    if (current.busy) return false;
    const question = _findQuestionContentUpstream(current);
    if (!question.trim()) {
      current.status = 'waiting';
      _saveCustomNodes();
      if (!workflowRunActive) renderGraphCanvas();
      if (typeof showToast === 'function') showToast('请先连接并填写问题节点');
      return false;
    }
    const analysisHash = _simpleHash(question + '|' + (current.requirements || ''));
    if (!current.analysis || current.analysisHash !== analysisHash) {
      await _generateAnalysis(current);
    } else {
      current.status = 'done';
    }
    return !workflowAbortController?.signal.aborted;
  }

  if (current.kind === 'user' || current.manual) {
    if (!(current.content || '').trim()) {
      current.status = 'waiting';
      _saveCustomNodes();
      if (!workflowRunActive) renderGraphCanvas();
      if (typeof showToast === 'function') showToast('请先填写 ' + (current.kind === 'note' ? '人工总结' : current.manual ? '非 AI 回答' : '问题') + ' 内容');
      return false;
    }
    current.status = 'done';
    return true;
  }

  const inputHash = _nodeInputHash(current);
  if (!force && (current.content || '').trim() && current.inputHash === inputHash && current.status === 'done') return true;
  await _generateCustomNode(current);
  return !workflowAbortController?.signal.aborted;
}

function _workflowDependencyEdges() {
  const seen = new Set();
  return (graphView.edges || []).filter(edge => {
    if (edge.draft || !edge.from || !edge.to || edge.from === edge.to) return false;
    const key = String(edge.from) + '|' + String(edge.to);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _buildWorkflowSubgraph(targetIds) {
  const allEdges = _workflowDependencyEdges();
  const ids = new Set();
  const stack = (targetIds || []).filter(id => _findGraphNode(id));
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const edge of allEdges) {
      if (edge.to === id && !ids.has(edge.from)) stack.push(edge.from);
    }
  }
  const edges = allEdges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  return { ids, edges };
}

function _workflowReadyNodes(subgraph, processed, failed, blocked) {
  const ready = [];
  for (const id of subgraph.ids) {
    if (processed.has(id) || failed.has(id) || blocked.has(id)) continue;
    const node = _findGraphNode(id);
    if (!node || node.busy) continue;
    const deps = subgraph.edges.filter(edge => edge.to === id);
    if (deps.every(edge => processed.has(edge.from))) ready.push(node);
  }
  ready.sort((a, b) => {
    const pa = a.moduleKey === 'viz' ? 0 : 1;
    const pb = b.moduleKey === 'viz' ? 0 : 1;
    return pa - pb;
  });
  return ready;
}

function _workflowPendingNodeIds(subgraph, processed, failed, blocked) {
  return [...subgraph.ids].filter(id => !processed.has(id) && !failed.has(id) && !blocked.has(id));
}

function _markWorkflowDependentsBlocked(failedId, subgraph, processed, blocked) {
  const stack = [failedId];
  while (stack.length) {
    const id = stack.pop();
    for (const edge of subgraph.edges) {
      if (edge.from !== id || processed.has(edge.to) || blocked.has(edge.to)) continue;
      blocked.add(edge.to);
      const node = _findGraphNode(edge.to);
      if (node && node.status !== 'done') node.status = 'waiting';
      stack.push(edge.to);
    }
  }
}

async function _runWorkflowNodeConcurrent(node, subgraph, force, processed, failed, blocked) {
  const shouldForce = force && (node.kind === 'module' || node.kind === 'summary');
  const shouldCount = _workflowItemNeedsProgress(node) || shouldForce;
  if (shouldCount) _markWorkflowCurrentNode(node);
  let ok = false;
  try {
    ok = await _processWorkflowChainItem(node, shouldForce);
  } catch (err) {
    console.error('Workflow node failed:', err);
    const live = _findGraphNode(node.id);
    if (live && live.status !== 'error') live.status = 'error';
  }
  const live = _findGraphNode(node.id);
  const errored = !!(live && live.status === 'error');
  const aborted = !!workflowAbortController?.signal.aborted;
  if (errored || (!ok && !aborted)) {
    failed.add(node.id);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked);
  } else {
    processed.add(node.id);
  }
  if (shouldCount && !aborted) _advanceWorkflowProgress(_workflowProgressLabel(node));
}

async function _runWorkflowGraph(subgraph, force) {
  const processed = new Set();
  const failed = new Set();
  const blocked = new Set();
  const pendingQueue = [];
  const inFlight = new Set();
  let runningWorkers = 0;
  let completed = true;

  function enqueueReadyNodes() {
    const ready = _workflowReadyNodes(subgraph, processed, failed, blocked);
    for (const node of ready) {
      if (!inFlight.has(node.id) && !pendingQueue.some(item => item.id === node.id)) {
        pendingQueue.push(node);
      }
    }
  }

  async function runWorker() {
    runningWorkers++;
    try {
      while (true) {
        if (workflowAbortController?.signal.aborted) {
          completed = false;
          break;
        }
        const node = pendingQueue.shift();
        if (!node) {
          if (inFlight.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
            enqueueReadyNodes();
            continue;
          }
          const pending = _workflowPendingNodeIds(subgraph, processed, failed, blocked);
          if (pending.length) {
            completed = false;
            if (typeof showToast === 'function') {
              const hasCycle = pending.some(id =>
                subgraph.edges.some(edge =>
                  edge.to === id
                  && !processed.has(edge.from)
                  && !failed.has(edge.from)
                  && !blocked.has(edge.from)
                )
              );
              showToast(hasCycle ? '检测到循环依赖，已停止' : '存在失败依赖，已跳过相关节点');
            }
          }
          break;
        }
        inFlight.add(node.id);
        try {
          await _runWorkflowNodeConcurrent(node, subgraph, force, processed, failed, blocked);
        } finally {
          inFlight.delete(node.id);
          enqueueReadyNodes();
        }
      }
    } finally {
      runningWorkers--;
    }
  }

  enqueueReadyNodes();
  const workerCount = Math.min(WORKFLOW_MAX_CONCURRENCY, Math.max(1, subgraph.ids.size));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return completed && failed.size === 0 && blocked.size === 0;
}

async function _executeParallelWorkflow(targetIds, force) {
  const subgraph = _buildWorkflowSubgraph(targetIds);
  if (!subgraph.ids.size) {
    if (typeof showToast === 'function') showToast('没有可运行的节点');
    return;
  }
  const workflowStartedAt = Date.now();
  workflowRunActive = true;
  workflowAbortController = new AbortController();
  _setWorkflowStopButton(true);
  const totalWork = [...subgraph.ids].filter(id => {
    const node = _findGraphNode(id);
    return _workflowItemNeedsProgress(node) || (force && node && (node.kind === 'module' || node.kind === 'summary'));
  }).length;
  _showWorkflowProgress(totalWork);
  let completed = false;
  try {
    completed = await _runWorkflowGraph(subgraph, force);
  } finally {
    const wasAborted = !!(workflowAbortController && workflowAbortController.signal.aborted);
    workflowRunActive = false;
    workflowAbortController = null;
    _setWorkflowStopButton(false);
    _hideWorkflowProgress();
    _saveCustomNodes();
    renderGraphCanvas();
    if (!wasAborted && completed && typeof notifyTaskCompleted === 'function') {
      notifyTaskCompleted(Date.now() - workflowStartedAt, '工作流完成');
    }
  }
}

async function runWorkflowNode(nodeId, force = false) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0 || node.busy || workflowRunActive) return;
  await _executeParallelWorkflow([nodeId], force);
}

async function runAllWorkflowNodes() {
  if (workflowRunActive) return;
  const targets = graphView.nodes.filter(node => node.messageIndex < 0 && (node.kind === 'module' || node.kind === 'summary'));
  if (!targets.length) {
    if (typeof showToast === 'function') showToast('没有可运行的模块/总结节点');
    return;
  }
  await _executeParallelWorkflow(targets.map(node => node.id), true);
}

function stopWorkflowRun() {
  if (workflowAbortController) workflowAbortController.abort();
}

function _renderBlankNodeLive(node, content) {
  let el = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-blank-content');
  if (!el && graphInner && node) {
    const host = graphInner.querySelector('[data-node-id="' + node.id + '"] .graph-node-main');
    const requirement = host?.querySelector('.graph-blank-requirement');
    if (host) {
      el = document.createElement('div');
      el.className = 'graph-blank-content';
      if (requirement) host.insertBefore(el, requirement);
      else host.appendChild(el);
    }
  }
  if (!el || !content) return;
  const cleaned = _cleanBlankNodeContent(node, content);
  el.innerHTML = typeof renderMarkdown === 'function'
    ? renderMarkdown(cleaned, { sourceModule: node.moduleKey })
    : escapeHtml(cleaned);
  if (typeof renderMath === 'function') renderMath(el);
  if (typeof _initVizIframes === 'function') _initVizIframes(el);
}

function _syncBlankNodeControls(node) {
  const root = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
  const btn = root?.querySelector('.graph-blank-generate-btn, .graph-regen-btn.graph-icon-btn');
  const input = root?.querySelector('.graph-blank-input');
  if (btn) {
    btn.disabled = false;
    btn.title = node.content ? '重新生成' : '生成';
  }
  if (input) input.disabled = false;
}

async function _streamBlankNodeResponse(resp, node) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let renderPending = false;
  let saveTimer = null;
  let streamChunkCount = 0;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      _renderBlankNodeLive(node, content);
      _measureNodes();
      _updateNodeTransforms();
      _redrawEdges();
    });
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      _saveCustomNodes();
    }, 400);
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        try {
          const data = JSON.parse(dataStr);
          const delta = data.choices && data.choices[0] && data.choices[0].delta;
          if (delta && delta.content) {
            content += delta.content;
            _scheduleWorkflowStreamProgress(content.length);
            streamChunkCount++;
            if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
            scheduleRender();
            scheduleSave();
          }
        } catch (e) {}
      }
    }
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const live = _findGraphNode(node.id);
  if (live) {
    live.content = content;
    live.summary = _graphSummary(content);
    live.busy = false;
    live.generated = true;
  }
  _saveCustomNodes();
  _renderBlankNodeLive(node, content);
  _syncBlankNodeControls(node);
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

async function generateBlankNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank' || node.busy) return;
  const input = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-blank-input');
  const requirements = (input?.value || '').trim();
  const incoming = (graphView.edges || []).find(edge => String(edge.to) === nodeId && !edge.draft);
  if (!incoming) {
    if (typeof showToast === 'function') showToast('请先将这个空白节点连接到问题、回答或模块节点');
    return;
  }
  const parent = _findGraphNode(incoming.from);
  if (!parent) {
    if (typeof showToast === 'function') showToast('连线来源节点不存在');
    return;
  }

  node.requirements = requirements;
  node.content = '';
  node.busy = true;
  node.generated = true;
  _saveCustomNodes();
  renderGraphCanvas();
  const current = _findGraphNode(nodeId);
  if (!current) return;

  const meta = GRAPH_MODULE_META[current.moduleKey] || { label: current.moduleKey || '空白节点' };
  if (typeof showProgress === 'function') showProgress('tool', 5, '正在生成' + meta.label);
  const graphPath = _blankNodeGraphPath(current);
  const pathQuestion = graphPath.find(item => item.kind === 'user');
  const question = pathQuestion ? pathQuestion.content || '' : '';
  const strictInstruction = _strictModuleOutputInstruction(current.moduleKey || '');
  const prompt = '用户问题：' + (question || '未填写') + '\n'
    + '请基于当前探索路径生成「' + meta.label + '」空白节点的完整内容。\n'
    + '用户额外要求：' + (requirements || '无') + '\n\n'
    + '只输出' + meta.label + '正文，不要输出 XML 标签，不要重复其他模块内容。'
    + (strictInstruction ? '\n\n' + strictInstruction : '');
  const upstreamNodes = graphPath
    .filter(item => item.kind !== 'blank' && item.kind !== 'draft')
    .map(item => {
      const rawContent = item.content || '';
      return {
        kind: item.kind,
        module: item.module || '',
        label: item.kind === 'user'
          ? '问题'
          : item.kind === 'answer'
            ? 'AI 回答'
            : ((GRAPH_MODULE_META[item.module] || {}).label || item.module || '上游节点'),
        summary: _graphSummary(rawContent) || '',
        content: rawContent.slice(0, 800),
      };
    });
  const workflowContext = {
    target: { kind: current.kind, module: current.moduleKey, label: meta.label },
    question,
    requirements,
    upstream: upstreamNodes,
  };
  const pathParent = graphPath[graphPath.length - 1];
  const branchMeta = {
    parentId: pathParent ? String(pathParent.timestamp || '') : String(parent.timestamp || ''),
    sourceModule: current.moduleKey,
    branchType: 'blank',
    branchId: '',
    branchLabel: meta.label,
    graphPath,
    workflowContext,
  };
  const signal = workflowAbortController ? workflowAbortController.signal : new AbortController().signal;

  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        resp = await proxyChat(
          prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          true,
          signal,
          branchMeta
        );
      }
    }
    if (!resp) {
      resp = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'agent',
          prompt,
          level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          session_id: typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          stream: true,
          branch_id: branchMeta.branchId || '',
          branch_type: branchMeta.branchType || '',
          source_module: branchMeta.sourceModule || '',
          parent_id: branchMeta.parentId || '',
          branch_label: branchMeta.branchLabel || '',
          graph_path: branchMeta.graphPath || [],
          workflow_context: branchMeta.workflowContext || {},
        }),
        signal,
      });
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamBlankNodeResponse(resp, current);
    if (typeof notifyTaskCompleted === 'function') {
      notifyTaskCompleted(Date.now() - blankStartedAt, meta.label + '生成完成');
    }
    if (typeof hideProgress === 'function') hideProgress();
  } catch (err) {
    const live = _findGraphNode(nodeId);
    if (live) live.busy = false;
    _saveCustomNodes();
    renderGraphCanvas();
    if (typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
    if (typeof hideProgress === 'function') hideProgress();
  }
}

function _addNodeIdsToGroup(groupId, nodeIds) {
  const group = _graphGroupById(groupId);
  if (!group) return false;
  _syncGroupMembersByContainment();
  const current = _graphGroupById(groupId);
  if (!current) return false;
  const ids = (nodeIds || []).filter(id => _findGraphNode(id) && !current.nodeIds.includes(id));
  if (!ids.length) return false;
  _pushGraphUndo();
  current.nodeIds = Array.from(new Set([...(current.nodeIds || []), ...ids]));
  _fitGroupToMembers(current);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  return true;
}

function graphCreateGroup() {
  const selected = Array.from(graphView.selectedNodeIds || [])
    .map(id => _findGraphNode(id))
    .filter(Boolean);
  const bounds = _graphGroupBounds(selected.map(node => node.id));
  const root = graphView.nodes.find(node => node.isRoot);
  const group = {
    id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: '分组 ' + (graphView.groups.length + 1),
    color: '#38bdf8',
    nodeIds: selected.map(node => node.id),
    x: root && !selected.length ? root.x + 90 : bounds.x,
    y: root && !selected.length ? root.y + 60 : bounds.y,
    width: selected.length ? bounds.width : 320,
    height: selected.length ? bounds.height : 180,
  };
  _pushGraphUndo();
  graphView.groups.push(group);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRenameGroup(groupId, name) {
  const group = _graphGroupById(groupId);
  if (!group) return;
  const nextName = String(name || '').trim() || '分组';
  if (group.name === nextName) return;
  _pushGraphUndo();
  group.name = nextName;
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  const input = graphInner?.querySelector('[data-group-id="' + groupId + '"] .graph-group-name-input');
  if (input) input.value = group.name;
}

function graphSetGroupColor(groupId, color) {
  const group = _graphGroupById(groupId);
  if (!group || !color) return;
  if (group.color === color) return;
  _pushGraphUndo();
  group.color = color;
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  _updateGroupElement(group);
}

function graphAddSelectedToGroup(groupId) {
  _syncGroupMembersByContainment();
  const group = _graphGroupById(groupId);
  if (!group) return;
  const selected = Array.from(graphView.selectedNodeIds || [])
    .filter(id => !group.nodeIds.includes(id))
    .filter(id => _findGraphNode(id));
  if (!selected.length) {
    if (typeof showToast === 'function') showToast('请先框选要加入分组的节点');
    return;
  }
  _pushGraphUndo();
  group.nodeIds = Array.from(new Set([...(group.nodeIds || []), ...selected]));
  _fitGroupToMembers(group);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphDeleteGroup(groupId) {
  const group = _graphGroupById(groupId);
  if (!group) return;
  if (!confirm('确定删除这个分组吗？节点不会被删除。')) return;
  _pushGraphUndo();
  graphView.groups = graphView.groups.filter(item => item.id !== groupId);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function _deleteSelectedGraphGroups(groupIds) {
  const ids = (groupIds || []).filter(id => _graphGroupById(id));
  if (!ids.length) return;
  if (!confirm('确定删除选中的 ' + ids.length + ' 个分组吗？节点不会被删除。')) return;
  _pushGraphUndo();
  graphView.groups = graphView.groups.filter(group => !ids.includes(group.id));
  const state = _graphState();
  state.groups = graphView.groups.map(group => ({ ...group }));
  _saveGraphState(state);
  graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
  renderGraphCanvas();
}

function _handleGraphKeydown(event) {
  const target = event.target;
  const inTextInput = target && typeof target.closest === 'function'
    && target.closest('input, textarea, [contenteditable], iframe');
  if ((event.ctrlKey || event.metaKey) && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    _undoGraphAction();
    return;
  }
  if (graphView.selectMode) return;
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (!graphCanvas || (!graphView.selectedNodeIds.size && !graphView.selectedGroupIds.size)) return;
  if (inTextInput) return;
  const app = document.querySelector('.app-container');
  if (app && app.classList.contains('linear-mode')) return;
  event.preventDefault();
  if (graphView.selectedGroupIds.size) {
    _deleteSelectedGraphGroups(Array.from(graphView.selectedGroupIds));
  } else {
    _deleteSelectedGraphNodes(Array.from(graphView.selectedNodeIds));
  }
}

function _initGraphCanvasEvents() {
  if (!graphCanvas) return;
  graphCanvas.addEventListener('wheel', e => {
    const scroller = e.target.closest('.graph-node-full-content, .graph-node .mermaid-container');
    if (scroller) return;
    e.preventDefault();
    zoomGraph(e.deltaY < 0 ? 1.08 : 0.92, e.clientX, e.clientY);
  }, { passive: false });
  graphCanvas.addEventListener('pointerdown', e => {
    graphView.suppressClick = false;
    if (graphView.selectMode) {
      if (e.target.closest('.graph-canvas-toolbar')) return;
      if (e.target.closest('button, a, input, textarea, iframe, .graph-port, .graph-add-port-btn, .graph-port-remove')) return;
      if (e.target.closest('.graph-node, .graph-group, .graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub, .graph-draft-body, .graph-regenerate-panel')) return;
      _clearGraphTextSelection();
      _startCanvasPan(e);
      return;
    }
    if (!e.target.closest || !e.target.closest('input, textarea')) {
      _clearGraphTextSelection();
    }
    if (e.target.closest('.graph-canvas-toolbar')) return;
    if (e.target.closest('.graph-port-remove')) return;
    if (e.target.closest('.graph-output-port, .graph-input-port')) {
      _startLinkDrag(e, e.target.closest('.graph-port'));
      return;
    }
    if (e.target.closest('.graph-add-port-btn')) return;
    if (e.target.closest('button, a, input, textarea, iframe, .graph-regen-btn')) return;
    if (e.target.closest('.graph-group input, .graph-group button')) return;
    if (e.target.closest('.graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub')) return;
    if (e.target.closest('.graph-group-resize-handle')) {
      const groupEl = e.target.closest('.graph-group');
      if (groupEl) _startGroupResize(e, groupEl);
      return;
    }
    const groupEl = e.target.closest('.graph-group');
    if (groupEl) {
      _startGroupDrag(e, groupEl);
      return;
    }
    if (e.target.closest('.graph-resize-handle')) {
      const nodeEl = e.target.closest('.graph-node');
      if (nodeEl) _startNodeResize(e, nodeEl);
      return;
    }
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl && !e.target.closest('button, a, input, textarea, iframe')) _startNodeDrag(e, nodeEl);
    else _startCanvasPan(e);
  });
  graphCanvas.addEventListener('pointermove', _handlePointerMove);
  window.addEventListener('pointerup', _endPointerDrag);
  graphCanvas.addEventListener('selectstart', e => {
    if (graphView.selectMode) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('input, textarea')) return;
    e.preventDefault();
  });
  if (!graphView.keyHandlerBound) {
    window.addEventListener('keydown', _handleGraphKeydown);
    graphView.keyHandlerBound = true;
  }
  graphCanvas.addEventListener('click', e => {
    if (graphView.suppressClick) {
      graphView.suppressClick = false;
      return;
    }
    if (graphView.selectMode) return;
    if (graphView.moved) return;
    if (e.target.closest('button, a, input, textarea, iframe, .graph-port')) return;
    const groupEl = e.target.closest('.graph-group');
    if (groupEl) {
      const id = groupEl.dataset.groupId;
      if (_isGraphModifier(e)) {
        _toggleGraphGroupSelection(id);
      } else if (graphView.selectedGroupIds.has(id)) {
        graphView.selectedGroupIds.delete(id);
        _syncGraphSelectionClasses();
      } else {
        _setGraphGroupSelection([id], false);
      }
      return;
    }
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId;
      if (_isGraphModifier(e)) {
        _toggleGraphSelection(id);
      } else if (graphView.selectedNodeIds.has(id)) {
        graphView.selectedNodeIds.delete(id);
        _syncGraphSelectionClasses();
      } else {
        _setGraphSelection([id], false);
      }
    } else {
      _clearGraphSelection();
    }
  });
  graphCanvas.addEventListener('dblclick', e => {
    if (graphView.selectMode) return;
    const edgeEl = e.target.closest('.graph-edge');
    if (edgeEl && edgeEl.dataset.edgeKey) {
      e.preventDefault();
      e.stopPropagation();
      _removeGraphEdge(edgeEl.dataset.edgeKey);
      return;
    }
    if (e.target.closest('.graph-node, .graph-group, .graph-port, .graph-canvas-toolbar')) return;
    const point = _clientToGraphLocal(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    openAddBlankNodeModal(point.x, point.y);
  });
}

function applyLinearMode() {
  const app = document.querySelector('.app-container');
  if (!app) return;
  const state = _graphState();
  app.classList.toggle('linear-mode', !!state.linear);
  const btn = document.getElementById('linearModeBtn');
  if (btn) btn.textContent = state.linear ? '画布' : '线性';
}

function _applyGraphTextSelectionMode() {
  if (!graphCanvas) return;
  graphCanvas.classList.toggle('graph-select-mode', !!graphView.selectMode);
  const btn = graphCanvas.querySelector('.graph-select-btn');
  if (btn) {
    btn.classList.toggle('active', !!graphView.selectMode);
    btn.title = graphView.selectMode ? '退出文字选择' : '选择文字';
    btn.setAttribute('aria-pressed', String(!!graphView.selectMode));
  }
  if (!graphView.selectMode) _clearGraphTextSelection();
}

function graphToggleTextSelection() {
  graphView.selectMode = !graphView.selectMode;
  _applyGraphTextSelectionMode();
}

function toggleLinearMode() {
  const state = _graphState();
  state.linear = !state.linear;
  _saveGraphState(state);
  applyLinearMode();
  if (!state.linear) setTimeout(renderGraphCanvas, 0);
}

function _unhideGraphNodeForFocus(node) {
  if (!node) return;
  const state = _graphState();
  let changed = false;
  const keys = [];
  const timestamp = String(node.timestamp || '');
  if (node.kind === 'module' && node.moduleKey) keys.push(timestamp + ':' + node.moduleKey);
  if (node.kind === 'answer') keys.push(timestamp + ':answer');
  if (node.id) keys.push(String(node.id));
  for (const key of keys) {
    if (state.hidden[key]) {
      delete state.hidden[key];
      node.hidden = false;
      changed = true;
    }
    if (state.collapsed[key]) {
      delete state.collapsed[key];
      node.minimized = false;
      changed = true;
    }
  }
  if (changed) _saveGraphState(state);
  const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
  if (el) {
    el.classList.remove('dimmed', 'minimized');
    const toggle = el.querySelector('.graph-node-minimize-toggle');
    if (toggle) {
      toggle.textContent = node.minimized ? '+' : '−';
      toggle.title = node.minimized ? '展开' : '最小化';
    }
  }
}

function _centerGraphOnNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || !graphCanvas) return false;
  _unhideGraphNodeForFocus(node);
  const state = _graphState();
  const rect = graphCanvas.getBoundingClientRect();
  const zoom = Math.max(0.7, state.zoom || 0.9);
  state.zoom = zoom;
  state.pan.x = rect.width / 2 - node.x * zoom;
  state.pan.y = rect.height / 2 - node.y * zoom;
  _saveGraphState(state);
  _applyGraphTransform();
  _setGraphSelection([nodeId]);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  if (el) {
    el.classList.remove('graph-node-located');
    void el.offsetWidth;
    el.classList.add('graph-node-located');
    clearTimeout(el._focusTimer);
    el._focusTimer = setTimeout(() => el.classList.remove('graph-node-located'), 2600);
  }
  return true;
}

function focusGraphNode(sessionId, messageId, moduleKey, nodeKind) {
  if (!messageId) return Promise.resolve(false);
  const state = _graphState();
  if (state.linear) {
    state.linear = false;
    _saveGraphState(state);
  }
  applyLinearMode();
  renderGraphCanvas();
  return new Promise(resolve => {
    const kind = nodeKind || (moduleKey === 'question' ? 'user' : '');
    const hasModule = kind !== 'user' && !!moduleKey && moduleKey !== 'answer';
    const focusId = kind === 'user'
      ? _graphNodeId('q', messageId)
      : hasModule
        ? _graphNodeId('m', messageId, moduleKey)
        : _graphNodeId('a', messageId);
    const fallbackId = kind === 'user' ? '' : (hasModule ? _graphNodeId('a', messageId) : '');
    const run = () => {
      _measureNodes();
      if (_centerGraphOnNode(focusId)) {
        resolve(true);
        return;
      }
      if (fallbackId && _centerGraphOnNode(fallbackId)) {
        resolve(true);
        return;
      }
      resolve(false);
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  });
}

function focusGraphNodeById(nodeId) {
  if (!nodeId) return Promise.resolve(false);
  const state = _graphState();
  if (state.linear) {
    state.linear = false;
    _saveGraphState(state);
  }
  applyLinearMode();
  renderGraphCanvas();
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      _measureNodes();
      resolve(_centerGraphOnNode(nodeId));
    }));
  });
}

function initGraphCanvas() {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
  _initGraphCanvasEvents();
  applyLinearMode();
  renderGraphCanvas();
}

window.renderGraphCanvas = renderGraphCanvas;
window.sendGraphNewSession = sendGraphNewSession;
window.graphModuleAction = graphModuleAction;
window.quickConnectToHub = quickConnectToHub;
window.buildGraphPathForAnchor = buildGraphPathForAnchor;
window.graphAddOutputPort = graphAddOutputPort;
window.graphRemoveOutputPort = graphRemoveOutputPort;
window.graphAddInputPort = graphAddInputPort;
window.graphRemoveInputPort = graphRemoveInputPort;
window.deleteCustomNode = deleteCustomNode;
window.updateCustomNodeContent = updateCustomNodeContent;
window.updateSourceNodeMax = updateSourceNodeMax;
window.handleSourceNodeFile = handleSourceNodeFile;
window.handleSourceNodeDrop = handleSourceNodeDrop;
window.reparseSourceNode = reparseSourceNode;
window.generateKnowledgeNode = generateKnowledgeNode;
window.generateRelationNode = generateRelationNode;
window.resetGraphConnections = resetGraphConnections;
window.graphCreateGroup = graphCreateGroup;
window.graphRenameGroup = graphRenameGroup;
window.graphSetGroupColor = graphSetGroupColor;
window.graphAddSelectedToGroup = graphAddSelectedToGroup;
window.graphDeleteGroup = graphDeleteGroup;
window.openAddBlankNodeModal = openAddBlankNodeModal;
window.closeAddBlankNodeModal = closeAddBlankNodeModal;
window.createBlankNode = createBlankNode;
window.createManualNode = createManualNode;
window.runWorkflowNode = runWorkflowNode;
window.runAllWorkflowNodes = runAllWorkflowNodes;
window.stopWorkflowRun = stopWorkflowRun;
window.deleteBlankNode = deleteBlankNode;
window.generateBlankNode = generateBlankNode;
window.submitDraftQuestion = submitDraftQuestion;
window.draftSocraticAnswer = draftSocraticAnswer;
window.draftAskAi = draftAskAi;
window.removeDraftNode = removeDraftNode;
window.graphOpenRegenerate = graphOpenRegenerate;
window.closeRegeneratePanel = closeRegeneratePanel;
window.submitRegenerateNode = submitRegenerateNode;
window.zoomGraph = zoomGraph;
window.fitGraph = fitGraph;
window.focusGraphNode = focusGraphNode;
window.focusGraphNodeById = focusGraphNodeById;
window.toggleGraphSearchPanel = toggleGraphSearchPanel;
window.closeGraphSearchPanel = closeGraphSearchPanel;
window.graphSearchInputChanged = graphSearchInputChanged;
window.graphSearchKeydown = graphSearchKeydown;
window.setGraphSearchScope = setGraphSearchScope;
window.focusGraphSearchResult = focusGraphSearchResult;
window.graphToggleTextSelection = graphToggleTextSelection;
window.autoArrangeGraph = autoArrangeGraph;
window.toggleLinearMode = toggleLinearMode;
window.applyLinearMode = applyLinearMode;
window.getGraphViewNodes = () => graphView.nodes.map(node => ({ ...node }));
window.getGraphViewEdges = () => graphView.edges.map(edge => ({ ...edge }));
window.getGraphViewDefaultEdges = () => (graphView.defaultEdges || []).map(edge => ({ ...edge }));
window.getSelectedGraphNodeIds = () => Array.from(graphView.selectedNodeIds || []);
window.freeModuleInputPort = _freeModuleInputPort;
window.pushGraphUndo = _pushGraphUndo;
window.applyGraphDiffHighlights = applyGraphDiffHighlights;
window.clearGraphDiffHighlights = clearGraphDiffHighlights;
window.showGraphHarnessPreview = showGraphHarnessPreview;
window.clearGraphHarnessPreview = clearGraphHarnessPreview;
window.toggleGraphView = () => {
  const state = _graphState();
  state.linear = false;
  _saveGraphState(state);
  applyLinearMode();
  renderGraphCanvas();
};
window.closeGraphView = () => {};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraphCanvas);
} else {
  initGraphCanvas();
}
