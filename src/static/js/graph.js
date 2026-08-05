// ===== PhyMathia 知识网络画布 =====
const GRAPH_MODULE_META = {
  physics: { label: '物理视角', color: '#f59e0b' },
  math: { label: '数学视角', color: '#3b82f6' },
  graph: { label: '知识图谱', color: '#0891b2' },
  viz: { label: '交互可视化', color: '#f472b6' },
  extend: { label: '延伸思考', color: '#a855f7' },
  socratic: { label: '苏格拉底追问', color: '#f43f5e' },
  learn: { label: '进阶学习', color: '#a855f7' },
};

const GRAPH_MODULE_DEFAULT_OUTPUTS = {
  physics: ['追问'],
  math: ['追问'],
  graph: ['追问'],
  viz: ['追问'],
  extend: ['追问', '直接问AI'],
  socratic: ['回答练习', '直接问AI', '追问'],
  learn: ['进阶学习', '追问'],
};

const GRAPH_NODE_ATTRIBUTES = {
  question: { key: 'question', label: '问题', color: '#64748b' },
  followup: { key: 'followup', label: '追问', color: '#4a9eff' },
  answer: { key: 'answer', label: 'AI 回答', color: '#10b981' },
  physics: { key: 'physics', label: '物理视角', color: '#f59e0b' },
  math: { key: 'math', label: '数学视角', color: '#3b82f6' },
  graph: { key: 'graph', label: '知识图谱', color: '#0891b2' },
  viz: { key: 'viz', label: '交互可视化', color: '#f472b6' },
  extend: { key: 'extend', label: '延伸思考', color: '#a855f7' },
  socratic: { key: 'socratic', label: '苏格拉底追问', color: '#f43f5e' },
  learn: { key: 'learn', label: '进阶学习', color: '#a855f7' },
};

const ANSWER_OUTPUT_SCHEMA = ['physics', 'math', 'graph', 'viz', 'extend', 'socratic'];
const ANSWER_OUTPUT_INDEX = { physics: 0, math: 1, graph: 2, viz: 3, extend: 4, socratic: 5 };

let graphCanvas = null;
let graphInner = null;
let graphEdgeLayer = null;

const graphView = {
  nodes: [],
  edges: [],
  defaultEdges: [],
  nodeById: {},
  selectedNodeIds: new Set(),
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

const GRAPH_UNDO_LIMIT = 10;
const graphUndoStack = [];

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
    groups: [],
    customNodes: [],
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
  if (sections.extend && !sections.socratic && !sections.learn) keys.push('extend');
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

function _buildGraphData(messages, state) {
  const nodes = [];
  const edges = [];
  const nodeById = {};
  const hiddenMap = state.hidden || {};
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
      let depth = 0;
      let targetAngle = 0;
      let parentQuestionId = null;

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
        depth = parentNode ? parentNode.depth + 1 : 2;
        const count = branchCounter[parentId] || 0;
        branchCounter[parentId] = count + 1;
        targetAngle = parentNode ? parentNode.targetAngle + ((count % 7) - 3) * 0.18 : (i % 8) * Math.PI / 4;
        const parentAnswerId = _graphNodeId('a', parentTs);
        parentQuestionId = answerParentQuestion[parentAnswerId] || null;
      }

      const saved = savedPositions[id];
      const node = {
        id,
        kind: 'user',
        x: saved ? saved.x : (isRoot ? 0 : (TARGET_R[depth] || 400) * Math.cos(targetAngle)),
        y: saved ? saved.y : (isRoot ? 0 : (TARGET_R[depth] || 400) * Math.sin(targetAngle)),
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
        if (parentId) _pushEdge(edges, parentId, id, 'primary');
      } else {
        if (lastMainAnswerId) _pushEdge(edges, lastMainAnswerId, id, 'primary');
      }
    } else {
      const parentQuestionId = lastUserNode ? lastUserNode.id : (rootQuestionId || null);
      const parentQuestion = parentQuestionId ? nodeById[parentQuestionId] : null;
      const id = _graphNodeId('a', msg.timestamp);
      const depth = parentQuestion ? parentQuestion.depth + 1 : 1;
      const targetAngle = parentQuestion ? parentQuestion.targetAngle + 0.04 : -Math.PI / 2;
      const saved = savedPositions[id];
      const node = {
        id,
        kind: 'answer',
        x: saved ? saved.x : (TARGET_R[depth] || 400) * Math.cos(targetAngle),
        y: saved ? saved.y : (TARGET_R[depth] || 400) * Math.sin(targetAngle),
        depth,
        targetAngle,
        isRoot: false,
        isBranch: !!(msg.branchType && msg.branchType !== 'main'),
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
        const mDepth = depth + 1;
        const mAngle = targetAngle + (idx - (keys.length - 1) / 2) * spread;
        const savedM = savedPositions[moduleId];
        const mNode = {
          id: moduleId,
          kind: 'module',
          x: savedM ? savedM.x : (TARGET_R[mDepth] || 400) * Math.cos(mAngle),
          y: savedM ? savedM.y : (TARGET_R[mDepth] || 400) * Math.sin(mAngle),
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
    const saved = savedPositions[cn.id] || {};
    const size = savedSizes[cn.id] || {};
    const node = {
      ...cn,
      id: cn.id,
      kind: 'blank',
      x: saved.x != null ? saved.x : (cn.x || 0),
      y: saved.y != null ? saved.y : (cn.y || 0),
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
      isRoot: false,
      isBranch: false,
      messageIndex: -1,
      timestamp: cn.timestamp || 0,
      moduleKey: cn.moduleKey || '',
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
    if (occupiedInputs.has(inputKey)) continue;
    edges.push({ ...customEdge, type: customEdge.type || 'custom', custom: true });
    occupiedInputs.add(inputKey);
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
  if (!message) return '';
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

function _nodeSub(node) {
  if (node.isRoot) return '核心问题';
  if (node.kind === 'user') return node.isBranch ? (node.branchLabel || '延伸追问') : '问题';
  if (node.kind === 'answer') return node.branchLabel || 'AI 回答簇';
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
  if (node.kind === 'answer') return GRAPH_NODE_ATTRIBUTES.answer;
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
  const messages = _getChatHistory();
  const fromAttr = _portAttribute(fromNode, fromPort, messages);
  const toAttr = _nodeAttribute(toNode).key;
  if (toNode.kind === 'blank') {
    return fromNode.kind === 'answer' && fromAttr === toAttr;
  }
  if (fromNode.kind === 'answer' && toNode.kind === 'module') return fromAttr === toAttr;
  if ((fromNode.kind === 'user' || fromNode.kind === 'draft') && toNode.kind === 'answer') return true;
  if (fromNode.kind === 'module' && (toNode.kind === 'user' || toNode.kind === 'draft')) {
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
  if (node.kind === 'module' && node.moduleKey !== 'socratic') {
    const label = node.moduleKey === 'graph' ? '重新生成' : '没看懂';
    return '<div class="graph-node-actions">'
      + '<button class="graph-regen-btn" onclick="graphOpenRegenerate(\'' + node.id + '\')" title="输入没看懂的地方并重新生成此节点">' + label + '</button>'
      + '</div>';
  }
  return '';
}

function _shortLabel(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? value.slice(0, max) + '…' : value;
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
  if (node.kind === 'answer') return '问题';
  if (node.kind === 'module') return '回答簇';
  if (node.kind === 'blank') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || '网络输入';
  return '来源';
}

function _nodeOutputLabels(node, messages) {
  if (node.kind === 'draft') return [];
  if (node.kind === 'blank') return ['追问'];
  if (node.kind === 'user') return ['AI 回答'];
  if (node.kind === 'module') {
    return _moduleOutputPorts(node, messages[node.messageIndex]).map(item => item.label);
  }
  if (node.kind === 'answer') {
    return _answerOutputPorts(node, messages).map(item => item.label);
  }
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

function _portAttribute(node, portId, messages) {
  const isOutput = /^out-/.test(String(portId || ''));
  if (isOutput) {
    const index = parseInt(String(portId).replace('out-', ''), 10);
    if (node.kind === 'blank') return node.moduleKey || 'followup';
    if (node.kind === 'module') {
      const ports = _moduleOutputPorts(node, messages[node.messageIndex]);
      return (ports[index] && ports[index].attribute) || 'followup';
    }
    if (node.kind === 'answer') {
      const ports = _answerOutputPorts(node, messages);
      return (ports[index] && ports[index].attribute) || 'answer';
    }
    if (node.kind === 'user') return 'answer';
    return 'followup';
  }
  return _nodeAttribute(node).key;
}

function _nodeOutputCount(node, messages, state) {
  if (node.kind === 'draft') return 0;
  const savedCount = state.portCounts && state.portCounts[node.id];
  return Math.max(1, _nodeOutputLabels(node, messages).length, savedCount || 0);
}

function _renderInputPorts(node) {
  if (node.isRoot) return '';
  const attr = _nodeAttribute(node);
  return '<div class="graph-port-col graph-input-col">'
    + '<div class="graph-port graph-input-port" data-node-id="' + node.id + '" data-port-id="in-0" data-attribute="' + attr.key + '" style="--port-color:' + attr.color + ';" title="输入端口：拖到右侧输出可重连来源">'
    + '<span class="graph-port-dot"></span><span class="graph-port-label">' + escapeHtml(_nodeInputLabel(node)) + '</span>'
    + '</div>'
    + '</div>';
}

function _renderOutputPorts(node, messages, state) {
  if (node.kind === 'draft') return '';
  let ports = [];
  if (node.kind === 'blank') {
    ports = [{
      label: '追问',
      type: 'branch',
      branchType: 'followup',
      attribute: node.moduleKey || 'followup',
      question: '',
    }];
  } else if (node.kind === 'answer') {
    ports = _answerOutputPorts(node, messages);
  } else if (node.kind === 'module') {
    ports = _moduleOutputPorts(node, messages[node.messageIndex]);
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
  const canAddPort = node.kind === 'module' && node.moduleKey === 'socratic';
  const savedCount = canAddPort && state.portCounts && state.portCounts[node.id] ? state.portCounts[node.id] : 0;
  const count = Math.max(ports.length, savedCount);
  let html = '<div class="graph-port-col graph-output-col">';
  for (let i = 0; i < count; i++) {
    const meta = ports[i] || {
      label: '追问 ' + (i - ports.length + 1),
      type: 'custom',
      branchType: 'followup',
      attribute: 'followup',
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
    + _renderInputPorts(node)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">空白节点</span>' + deleteBtn + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(meta.label) + '</div>'
    + contentHtml
    + '<div class="graph-blank-requirement">'
    + '<textarea class="graph-blank-input" rows="2" placeholder="输入额外要求" ' + (node.busy ? 'disabled' : '') + '>' + escapeHtml(node.requirements || '') + '</textarea>'
    + '<button class="graph-blank-generate-btn" onclick="generateBlankNode(\'' + node.id + '\')" ' + (node.busy ? 'disabled' : '') + '>' + (node.busy ? '生成中' : generateLabel) + '</button>'
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
  }
  return text;
}

function _renderNodeHtml(node, messages, state) {
  if (node.kind === 'blank') return _renderBlankNodeHtml(node, state);
  if (node.kind === 'draft') return _renderDraftNodeHtml(node);
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
  const badge = node.isRoot ? '核心问题' : (node.isBranch ? '延伸追问' : (node.kind === 'answer' ? 'AI 回答簇' : ''));
  const badgeHtml = badge ? '<span class="graph-node-badge">' + escapeHtml(badge) + '</span>' : '';
  const label = node.kind === 'module' ? ((GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey) : _nodeContent(message, node);
  const body = node.kind === 'module' ? (typeof renderMarkdown === 'function' ? renderMarkdown(_nodeContent(message, node), { parentId: String(message.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(_nodeContent(message, node))) : '';
  const sub = _nodeSub(node);
  const subHtml = sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '';
  const minimizeToggle = (node.kind === 'module' || node.kind === 'answer')
    ? '<button class="graph-node-minimize-toggle" onclick="graphModuleAction(\'minimize\',\'' + node.id + '\')" title="' + (node.minimized ? '展开' : '最小化') + '">' + (node.minimized ? '+' : '−') + '</button>'
    : '';
  const deleteBtn = node.isRoot ? '' : '<button class="graph-node-delete-toggle" onclick="graphModuleAction(\'delete\',\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const graphState = state || _graphState();
  const inputHtml = _renderInputPorts(node);
  const outputHtml = _renderOutputPorts(node, messages, graphState);
  return '<div class="' + baseClass + modClass + attrClass + rootClass + branchClass + selectedClass + dimmedClass + minimizedClass + resizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + inputHtml
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>' + badgeHtml + subHtml + minimizeToggle + deleteBtn + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(label) + '</div>'
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
  });
  _syncGroupMembersByContainment();
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
    return '<path d="' + d + '" class="' + cls + '" data-edge-key="' + _edgeKey(edge) + '" title="双击删除连线"></path>';
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
  state.customNodes = graphView.nodes.filter(node => node.kind === 'blank').map(node => ({ ...node }));
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
  nodes.forEach(node => {
    byId[node.id] = node;
    children[node.id] = [];
  });
  edges.forEach(edge => {
    const from = byId[edge.from];
    const to = byId[edge.to];
    if (!from || !to || from.kind === 'draft' || to.kind === 'draft') return;
    if (!children[edge.from].includes(edge.to)) children[edge.from].push(edge.to);
  });
  return { byId, children };
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
  placed
) {
  const node = byId[nodeId];
  if (!node || placed.has(nodeId) || node.kind === 'draft') return;
  placed.add(nodeId);
  node.x = x;
  node.y = (top + bottom) / 2;

  const kids = (children[nodeId] || [])
    .filter(childId => byId[childId] && !placed.has(childId))
    .sort((a, b) => (byId[a].timestamp || 0) - (byId[b].timestamp || 0));
  const totalWeight = kids.reduce((sum, childId) => sum + (weights[childId] || 1), 0) || 1;
  const verticalSpan = bottom - top;
  let cursor = top;
  for (const childId of kids) {
    const childWeight = weights[childId] || 1;
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
      placed
    );
    cursor = childBottom;
  }
}

function _resolveLayoutCollisions(nodes, preservePinned) {
  const active = nodes.filter(node => node.kind !== 'draft' && !node.isRoot && !(preservePinned && node.pinned));
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i];
        const b = active[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const minX = ((a.w || 120) + (b.w || 120)) / 2;
        const minY = ((a.h || 60) + (b.h || 60)) / 2;
        const overlapX = minX - Math.abs(dx);
        const overlapY = minY - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const signX = dx >= 0 ? 1 : -1;
        const signY = dy >= 0 ? 1 : -1;
        if (overlapX < overlapY) {
          const push = overlapX * 0.5;
          if (!a.pinned) { a.x -= signX * push; moved = true; }
          if (!b.pinned) { b.x += signX * push; moved = true; }
        } else {
          const push = overlapY * 0.5;
          if (!a.pinned) { a.y -= signY * push; moved = true; }
          if (!b.pinned) { b.y += signY * push; moved = true; }
        }
      }
    }
    if (!moved) break;
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

  const { byId, children } = _layoutChildMap(graphView.nodes, graphView.edges);
  const roots = graphView.nodes.filter(node => node.isRoot && node.kind !== 'draft');
  if (!roots.length) {
    const firstUser = graphView.nodes.find(node => node.kind === 'user');
    if (firstUser) roots.push(firstUser);
  }
  if (!roots.length && graphView.nodes.length) roots.push(graphView.nodes[0]);
  const depths = _layoutBfsDepths(roots, children, byId);

  const weights = {};
  roots.forEach(root => {
    _layoutSubtreeWeight(root.id, children, weights, new Set());
  });

  const maxNodeW = Math.max(
    160,
    ...graphView.nodes
      .filter(node => node.kind !== 'draft')
      .map(node => node.w || 120)
  );
  const colGap = Math.max(420, maxNodeW + 140);
  const maxSubtreeWeight = Math.max(1, ...roots.map(root => weights[root.id] || 1));
  const verticalSpan = Math.max(900, Math.min(2600, maxSubtreeWeight * 320));

  const placed = new Set();
  roots.forEach((root, index) => {
    const rootCount = roots.length;
    const top = -verticalSpan / 2 + (index / rootCount) * verticalSpan;
    const bottom = -verticalSpan / 2 + ((index + 1) / rootCount) * verticalSpan;
    _placeTreeSubtree(
      root.id,
      0,
      top,
      bottom,
      colGap,
      children,
      weights,
      byId,
      placed
    );
  });

  const remaining = graphView.nodes.filter(node =>
    !placed.has(node.id)
    && node.kind !== 'draft'
  );
  const maxDepth = Math.max(0, ...Object.values(depths));
  const remainingX = (maxDepth + 1) * colGap;
  const remainingRows = Math.max(1, Math.ceil(Math.sqrt(remaining.length)));
  remaining.forEach((node, index) => {
    node.x = remainingX + Math.floor(index / remainingRows) * colGap;
    node.y = ((index % remainingRows) - (remainingRows - 1) / 2) * 320;
  });

  _resolveLayoutCollisions(graphView.nodes, false);
  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = {};
  state.pinned = {};
  graphView.nodes.forEach(node => {
    if (node.kind === 'draft') return;
    state.positions[node.id] = { x: node.x, y: node.y };
  });
  _saveGraphState(state);
  _syncGroupMembersByContainment();
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

function renderGraphCanvas(streaming) {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
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
  toolbar.innerHTML = '<button class="graph-tool-btn" onclick="zoomGraph(1.2)" title="放大">+</button>'
    + '<button class="graph-tool-btn" onclick="zoomGraph(0.85)" title="缩小">−</button>'
    + '<button class="graph-tool-btn" onclick="fitGraph()" title="适配画布">⌂</button>'
    + '<button class="graph-tool-btn graph-select-btn" onclick="graphToggleTextSelection()" title="选择文字">文</button>'
    + '<button class="graph-tool-btn" onclick="graphCreateGroup()" title="将选中节点创建为分组">组</button>'
    + '<button class="graph-tool-btn" onclick="autoArrangeGraph()" title="自动整理">⌗</button>'
    + '<button class="graph-tool-btn" onclick="resetGraphLayout()" title="全部重排">↻</button>';
  graphCanvas.appendChild(toolbar);
  _applyGraphTextSelectionMode();

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
    if (typeof renderMermaidInElement === 'function') setTimeout(() => renderMermaidInElement(graphInner), 0);
  });

  if (state.layoutVersion !== LAYOUT_VERSION) {
    state.layoutVersion = LAYOUT_VERSION;
    _saveGraphState(state);
  }
}

function resetGraphLayout() {
  autoArrangeGraph(false);
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
  state.connections = state.connections.filter(c =>
    !(c.from === fromNodeId && (c.fromPort || 'out-0') === fromPort)
    && !(c.to === toNodeId && (c.toPort || 'in-0') === toPort)
  );
  const edge = {
    from: fromNodeId,
    fromPort: fromPort || 'out-0',
    to: toNodeId,
    toPort: toPort || 'in-0',
    type: 'custom',
    custom: true,
  };
  state.removedEdges = state.removedEdges.filter(key => key !== _edgeKey(edge));
  state.connections.push(edge);
  _saveGraphState(state);
  graphView.edges = _resolveGraphEdges(state, graphView.defaultEdges || [], graphView.nodeById);
  _redrawEdges();
}

function _createBranchNodeFromOutput(sourceNodeId, sourcePortId, portMeta, x, y) {
  const sourceNode = graphView.nodeById[sourceNodeId];
  if (!sourceNode || sourceNode.kind !== 'module' || !portMeta) return;
  const messages = _getChatHistory();
  const sourceMessage = messages[sourceNode.messageIndex];
  const sourceModule = sourceNode.moduleKey || '';
  const meta = {
    ...portMeta,
    sourceModule,
    parentId: String(sourceMessage?.timestamp || ''),
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
    + '<button class="graph-draft-btn graph-draft-send" onclick="submitRegenerateNode(\'' + nodeId + '\')">重新生成此节点</button>'
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
  if (!node || node.kind !== 'module' || node.moduleKey !== 'socratic') return;
  _pushGraphUndo();
  const state = _graphState();
  state.portCounts = state.portCounts || {};
  state.portCounts[nodeId] = (state.portCounts[nodeId] || 0) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function _baseOutputPortCount(node) {
  if (!node) return 0;
  const messages = _getChatHistory();
  if (node.kind === 'module') return _moduleOutputPorts(node, messages[node.messageIndex]).length;
  if (node.kind === 'user') return 1;
  if (node.kind === 'answer') return _nodeOutputLabels(node, messages).length;
  return 0;
}

function graphRemoveOutputPort(nodeId, portIndex) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'module' || node.moduleKey !== 'socratic') return;
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
  graphView.selectedNodeIds.forEach(id => {
    const el = graphInner.querySelector('[data-node-id="' + id + '"]');
    if (el) el.classList.add('selected');
  });
}

function _clearGraphSelection() {
  graphView.selectedNodeIds = new Set();
  _syncGraphSelectionClasses();
}

function _setGraphSelection(ids, additive) {
  const next = additive ? new Set(graphView.selectedNodeIds) : new Set();
  ids.forEach(id => next.add(id));
  graphView.selectedNodeIds = next;
  _syncGraphSelectionClasses();
}

function _toggleGraphSelection(id) {
  const next = new Set(graphView.selectedNodeIds);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  graphView.selectedNodeIds = next;
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
    const message = _getChatHistory()[node.messageIndex];
    if (message) timestamps.add(String(message.timestamp || ''));
  }
  if (!timestamps.size) {
    _pushGraphUndo();
    drafts.forEach(id => removeDraftNode(id));
    blanks.forEach(id => deleteBlankNode(id, false));
    graphView.selectedNodeIds = new Set();
    _syncGraphSelectionClasses();
    return;
  }
  if (!confirm('确定删除选中的 ' + timestamps.size + ' 个节点及其子分支吗？')) return;
  _pushGraphUndo(true);
  drafts.forEach(id => removeDraftNode(id));
  blanks.forEach(id => deleteBlankNode(id, false));
  if (typeof window.deleteGraphMessagesByTimestamps === 'function') {
    await window.deleteGraphMessagesByTimestamps(Array.from(timestamps));
  } else if (typeof window.deleteGraphMessageByTimestamp === 'function') {
    for (const ts of timestamps) await window.deleteGraphMessageByTimestamp(ts);
  }
}

function _saveCustomNodes() {
  const state = _graphState();
  state.customNodes = graphView.nodes.filter(node => node.kind === 'blank').map(node => ({ ...node }));
  _saveGraphState(state);
}

function openAddBlankNodeModal(x, y) {
  addBlankNodePoint = { x, y };
  closeAddBlankNodeModal();
  const overlay = document.createElement('div');
  overlay.className = 'graph-add-node-overlay';
  const items = Object.keys(GRAPH_MODULE_META).map(moduleKey => {
    const meta = GRAPH_MODULE_META[moduleKey] || {};
    return '<button class="graph-add-node-item" style="--node-color:' + (meta.color || '#38bdf8') + '" onclick="createBlankNode(\'' + moduleKey + '\')">'
      + '<span class="graph-add-node-dot"></span>'
      + escapeHtml(meta.label || moduleKey)
      + '</button>';
  }).join('');
  overlay.innerHTML = '<div class="graph-add-node-dialog">'
    + '<div class="graph-add-node-head">'
    + '<div class="graph-add-node-title">添加空白节点</div>'
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

function createBlankNode(moduleKey) {
  if (!GRAPH_MODULE_META[moduleKey]) return;
  _pushGraphUndo();
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: 'blank-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    kind: 'blank',
    moduleKey,
    x: addBlankNodePoint.x,
    y: addBlankNodePoint.y,
    w: 0,
    h: 0,
    content: '',
    requirements: '',
    busy: false,
    generated: false,
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: null,
    customHeight: null,
    timestamp: Date.now(),
  });
  _saveGraphState(state);
  closeAddBlankNodeModal();
  renderGraphCanvas();
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
  }));
}

function _renderBlankNodeLive(node, content) {
  const el = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-blank-content');
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
  const btn = root?.querySelector('.graph-blank-generate-btn');
  const input = root?.querySelector('.graph-blank-input');
  if (btn) {
    btn.disabled = false;
    btn.textContent = node.content ? '重新生成' : '生成';
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

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      _renderBlankNodeLive(node, content);
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
  const prompt = '请基于当前探索路径生成「' + meta.label + '」空白节点的完整内容。\n'
    + '用户额外要求：' + (requirements || '无') + '\n\n'
    + '只输出' + meta.label + '正文，不要输出 XML 标签，不要重复其他模块内容。';
  const graphPath = _blankNodeGraphPath(current);
  const pathParent = graphPath[graphPath.length - 1];
  const branchMeta = {
    parentId: pathParent ? String(pathParent.timestamp || '') : String(parent.timestamp || ''),
    sourceModule: current.moduleKey,
    branchType: 'blank',
    branchId: '',
    branchLabel: meta.label,
    graphPath,
  };
  const signal = new AbortController().signal;

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
        }),
        signal,
      });
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamBlankNodeResponse(resp, current);
  } catch (err) {
    const live = _findGraphNode(nodeId);
    if (live) live.busy = false;
    _saveCustomNodes();
    renderGraphCanvas();
    if (typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
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
  if (!graphCanvas || !graphView.selectedNodeIds.size) return;
  if (inTextInput) return;
  const app = document.querySelector('.app-container');
  if (app && app.classList.contains('linear-mode')) return;
  event.preventDefault();
  _deleteSelectedGraphNodes(Array.from(graphView.selectedNodeIds));
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
window.buildGraphPathForAnchor = buildGraphPathForAnchor;
window.graphAddOutputPort = graphAddOutputPort;
window.graphRemoveOutputPort = graphRemoveOutputPort;
window.resetGraphConnections = resetGraphConnections;
window.graphCreateGroup = graphCreateGroup;
window.graphRenameGroup = graphRenameGroup;
window.graphSetGroupColor = graphSetGroupColor;
window.graphAddSelectedToGroup = graphAddSelectedToGroup;
window.graphDeleteGroup = graphDeleteGroup;
window.openAddBlankNodeModal = openAddBlankNodeModal;
window.closeAddBlankNodeModal = closeAddBlankNodeModal;
window.createBlankNode = createBlankNode;
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
window.graphToggleTextSelection = graphToggleTextSelection;
window.resetGraphLayout = resetGraphLayout;
window.autoArrangeGraph = autoArrangeGraph;
window.toggleLinearMode = toggleLinearMode;
window.applyLinearMode = applyLinearMode;
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
