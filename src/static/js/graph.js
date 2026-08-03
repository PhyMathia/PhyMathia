// ===== PhyMathia 知识网络画布 =====
const GRAPH_MODULE_META = {
  physics: { label: '物理视角', color: '#f59e0b' },
  math: { label: '数学视角', color: '#3b82f6' },
  graph: { label: '知识图谱', color: '#0891b2' },
  viz: { label: '交互可视化', color: '#10b981' },
  extend: { label: '延伸思考', color: '#a855f7' },
};

let graphCanvas = null;
let graphInner = null;
let graphEdgeLayer = null;

const graphView = {
  nodes: [],
  edges: [],
  nodeById: {},
  selectedNodeId: null,
  dragNodeId: null,
  panning: false,
  moved: false,
  pointerId: null,
  startX: 0,
  startY: 0,
  panStartX: 0,
  panStartY: 0,
  nodeStartX: 0,
  nodeStartY: 0,
};

const LAYOUT_VERSION = 3;
const TARGET_R = [0, 420, 940, 1460, 2000, 2560, 3120, 3680];
const MAX_ITERATIONS = 120;

function _graphState() {
  if (typeof window.getGraphState === 'function') {
    return window.getGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : '');
  }
  return { collapsed: {}, hidden: {}, positions: {}, pan: { x: 80, y: 80 }, zoom: 0.9, linear: false, layoutVersion: 1 };
}

function _saveGraphState(state) {
  if (typeof window.saveGraphState === 'function') {
    window.saveGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : '', state);
  }
}

function _getChatHistory() {
  return typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
}

function _graphNodeId(kind, timestamp, moduleKey) {
  const ts = String(timestamp || '').replace(/[^0-9]/g, '') || Math.random().toString(36).slice(2, 8);
  return kind + '-' + ts + (moduleKey ? '-' + moduleKey : '');
}

function _graphSummary(content) {
  const match = String(content || '').match(/<summary>([\s\S]*?)<\/summary>/i);
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
}

function _graphModuleKeys(sections) {
  const keys = [];
  if (sections.physics) keys.push('physics');
  if (sections.math) keys.push('math');
  if (sections.graph) {
    if (sections.graph.indexOf('```html') !== -1) keys.push('viz');
    keys.push('graph');
  }
  if (sections.extend) keys.push('extend');
  return keys;
}

function _findGraphNode(nodeId) {
  return graphView.nodeById[nodeId] || null;
}

function _pushEdge(edges, from, to, type) {
  if (!from || !to || from === to) return;
  if (edges.some(e => e.from === from && e.to === to)) return;
  edges.push({ from, to, type: type || 'primary' });
}

function _buildGraphData(messages, state) {
  const nodes = [];
  const edges = [];
  const nodeById = {};
  const hiddenMap = state.hidden || {};
  const savedPositions = state.layoutVersion === LAYOUT_VERSION ? (state.positions || {}) : {};

  const mainUsers = messages.filter(m => m.role === 'user' && (!m.branchType || m.branchType === 'main'));
  const mainCount = Math.max(1, mainUsers.length);
  let mainIndex = 0;
  let rootQuestionId = null;
  let lastAnswerId = null;
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
        depth = 1;
        mainIndex = Math.max(0, mainUsers.findIndex(m => m.timestamp === msg.timestamp));
        targetAngle = -Math.PI / 2 + (mainIndex / mainCount) * Math.PI * 2;
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
        branchType: msg.branchType || 'main',
        branchLabel: msg.branchLabel || '',
        parentId: msg.parentId || '',
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
        if (parentQuestionId) _pushEdge(edges, parentQuestionId, id, 'secondary');
      } else {
        if (rootQuestionId && rootQuestionId !== id) _pushEdge(edges, rootQuestionId, id, 'secondary');
        if (lastAnswerId) _pushEdge(edges, lastAnswerId, id, 'secondary');
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
        w: 0, h: 0, vx: 0, vy: 0,
      };
      nodes.push(node);
      nodeById[id] = node;
      answerParentQuestion[id] = parentQuestionId;
      if (parentQuestionId) _pushEdge(edges, parentQuestionId, id, 'primary');
      lastAnswerId = id;

      const sections = (typeof parseXmlSections === 'function') ? parseXmlSections(msg.content || '') : {};
      const keys = _graphModuleKeys(sections);
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
          w: 0, h: 0, vx: 0, vy: 0,
        };
        nodes.push(mNode);
        nodeById[moduleId] = mNode;
        _pushEdge(edges, id, moduleId, 'primary');
        if (parentQuestionId) _pushEdge(edges, moduleId, parentQuestionId, 'secondary');
      });
    }
  }

  return { nodes, edges, nodeById };
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
    const sections = (typeof parseXmlSections === 'function') ? parseXmlSections(message.content || '') : {};
    if (node.moduleKey === 'viz' && sections.graph) {
      const idx = sections.graph.indexOf('```html');
      if (idx !== -1) {
        const end = sections.graph.indexOf('```', idx + 7);
        return end === -1 ? sections.graph.slice(idx) : sections.graph.slice(idx, end + 3);
      }
      return sections.graph;
    }
    return sections[node.moduleKey] || '';
  }
  return '';
}

function _nodeSub(node) {
  if (node.isRoot) return '核心问题';
  if (node.kind === 'user') return node.isBranch ? (node.branchLabel || '延伸追问') : '问题';
  if (node.kind === 'answer') return node.branchLabel || 'AI 回答簇';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  return '';
}

function _nodeActions(node) {
  if (node.kind === 'module') {
    const hidden = node.hidden;
    return '<div class="graph-node-actions">'
      + '<button onclick="graphModuleAction(\'followup\',\'' + node.id + '\')">追问</button>'
      + '<button onclick="graphModuleAction(\'confused\',\'' + node.id + '\')">没看懂</button>'
      + '<button onclick="graphModuleAction(\'continue\',\'' + node.id + '\')">继续问</button>'
      + '<button onclick="graphModuleAction(\'hide\',\'' + node.id + '\')">' + (hidden ? '恢复' : '隐藏') + '</button>'
      + '</div>';
  }
  if (node.kind === 'answer') {
    return '<div class="graph-node-actions"><button onclick="graphModuleAction(\'continue\',\'' + node.id + '\')">围绕回答继续问</button></div>';
  }
  return '';
}

function _renderNodeHtml(node, messages) {
  const message = messages[node.messageIndex];
  const baseClass = 'graph-node graph-node-' + node.kind;
  const modClass = node.moduleKey ? ' graph-node-module graph-module-' + node.moduleKey : '';
  const rootClass = node.isRoot ? ' graph-node-root' : '';
  const branchClass = node.isBranch ? ' graph-node-branch' : '';
  const selectedClass = node.id === graphView.selectedNodeId ? ' selected' : '';
  const dimmedClass = node.hidden ? ' dimmed' : '';
  const badge = node.isRoot ? '核心问题' : (node.isBranch ? '延伸追问' : (node.kind === 'answer' ? 'AI 回答簇' : ''));
  const badgeHtml = badge ? '<span class="graph-node-badge">' + escapeHtml(badge) + '</span>' : '';
  const label = node.kind === 'module' ? ((GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey) : _nodeContent(message, node);
  const body = node.kind === 'module' ? (typeof renderMarkdown === 'function' ? renderMarkdown(_nodeContent(message, node)) : escapeHtml(_nodeContent(message, node))) : '';
  return '<div class="' + baseClass + modClass + rootClass + branchClass + selectedClass + dimmedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);">'
    + '<div class="graph-node-header">' + badgeHtml + '<span class="graph-node-sub">' + escapeHtml(_nodeSub(node)) + '</span></div>'
    + '<div class="graph-node-label">' + escapeHtml(label) + '</div>'
    + (body ? '<div class="graph-node-full-content">' + body + '</div>' : '')
    + _nodeActions(node)
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
}

function _updateNodeTransforms() {
  if (!graphInner) return;
  graphView.nodes.forEach(node => {
    const el = graphInner.querySelector('[data-node-id="' + node.id + '"]');
    if (el) el.style.transform = 'translate(' + node.x + 'px, ' + node.y + 'px)';
  });
}

function _redrawEdges() {
  if (!graphEdgeLayer) return;
  const html = graphView.edges.map(edge => {
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) return '';
    const x1 = a.x + (a.w || 120) / 2;
    const y1 = a.y + (a.h || 60) / 2;
    const x2 = b.x + (b.w || 120) / 2;
    const y2 = b.y + (b.h || 60) / 2;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const offset = Math.min(70, d * 0.22);
    const cx = mx - (dy / d) * offset;
    const cy = my + (dx / d) * offset;
    const cls = edge.type === 'secondary' ? 'graph-edge graph-edge-secondary' : 'graph-edge';
    return '<path d="M' + x1.toFixed(1) + ' ' + y1.toFixed(1) + ' Q' + cx.toFixed(1) + ' ' + cy.toFixed(1) + ' ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + '" class="' + cls + '"></path>';
  }).join('');
  graphEdgeLayer.innerHTML = html;
}

function _savePositions() {
  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = state.positions || {};
  graphView.nodes.forEach(n => {
    state.positions[n.id] = { x: n.x, y: n.y };
  });
  _saveGraphState(state);
}

function _tick() {
  const nodes = graphView.nodes;
  const edges = graphView.edges;
  if (!nodes.length) return;

  const kRepulse = 12000;
  const kAttract = 0.06;
  const kRadial = 0.009;
  const kCenter = 0.0003;
  const damping = 0.82;
  const margin = 44;

  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (a.isRoot) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let d = Math.sqrt(dx * dx + dy * dy) || 1;
      const half = ((a.w || 120) + (b.w || 120)) / 2 + margin;
      if (d < half) {
        const overlap = half - d;
        const fx = (dx / d) * overlap * 0.5;
        const fy = (dy / d) * overlap * 0.5;
        a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
      }
      const area = Math.max(1, Math.sqrt(((a.w || 120) * (a.h || 60)) * ((b.w || 120) * (b.h || 60))) / 1200);
      const f = kRepulse * Math.max(1, area) / (d * d);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
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
    a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
  }

  for (const n of nodes) {
    if (n.isRoot) continue;
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
    n.vx *= damping;
    n.vy *= damping;
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > 40) { n.vx = (n.vx / speed) * 40; n.vy = (n.vy / speed) * 40; }
    n.x += n.vx;
    n.y += n.vy;
  }
}

function _runLayout(needsFit) {
  if (!graphView.nodes.length) return;
  let iter = 0;
  function step() {
    if (iter++ >= MAX_ITERATIONS) {
      _savePositions();
      if (needsFit) setTimeout(fitGraph, 0);
      return;
    }
    _tick();
    _updateNodeTransforms();
    _redrawEdges();
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function _applyGraphTransform() {
  if (!graphInner) return;
  const state = _graphState();
  graphInner.style.transform = 'translate(' + state.pan.x + 'px, ' + state.pan.y + 'px) scale(' + state.zoom + ')';
  graphView.zoom = state.zoom;
}

function renderGraphCanvas() {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
  const state = _graphState();
  const messages = _getChatHistory();
  graphView.selectedNodeId = null;

  graphCanvas.innerHTML = '';
  if (!messages.length) {
    graphCanvas.innerHTML = '<div class="graph-empty" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);font-size:15px;color:var(--text-secondary);padding:24px;text-align:center;">从下方输入框开始提问，答案会以知识网络铺展。</div>';
    return;
  }

  const toolbar = document.createElement('div');
  toolbar.className = 'graph-canvas-toolbar';
  toolbar.innerHTML = '<button class="graph-tool-btn" onclick="zoomGraph(1.2)" title="放大">+</button>'
    + '<button class="graph-tool-btn" onclick="zoomGraph(0.85)" title="缩小">−</button>'
    + '<button class="graph-tool-btn" onclick="fitGraph()" title="适配画布">⌂</button>'
    + '<button class="graph-tool-btn" onclick="resetGraphLayout()" title="重新布局">↻</button>';
  graphCanvas.appendChild(toolbar);

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
  graphView.nodes = data.nodes;
  graphView.edges = data.edges;
  graphView.nodeById = data.nodeById;

  const html = graphView.nodes.map(n => _renderNodeHtml(n, messages)).join('');
  graphInner.insertAdjacentHTML('beforeend', html);

  _applyGraphTransform();

  requestAnimationFrame(() => {
    if (typeof renderMath === 'function') renderMath(graphInner);
    if (typeof _initVizIframes === 'function') _initVizIframes(graphInner);
    _measureNodes();
    _redrawEdges();
    _runLayout(needsFit);
    if (typeof renderMermaidInElement === 'function') setTimeout(() => renderMermaidInElement(graphInner), 0);
  });

  if (state.layoutVersion !== LAYOUT_VERSION) {
    state.layoutVersion = LAYOUT_VERSION;
    _saveGraphState(state);
  }
}

function resetGraphLayout() {
  const state = _graphState();
  state.layoutVersion = 0;
  state.positions = {};
  _saveGraphState(state);
  renderGraphCanvas();
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
  } else if (action === 'continue') {
    if (typeof window.setActiveBranchAnchor === 'function') {
      window.setActiveBranchAnchor({
        parentId,
        sourceModule: node.moduleKey || '',
        branchType: 'continue',
        branchId: (typeof _genBranchId === 'function') ? _genBranchId() : ('br_' + Date.now()),
        branchLabel: '继续询问：' + ((GRAPH_MODULE_META[node.moduleKey] || {}).label || '回答簇'),
      });
      const input = document.getElementById('userInput');
      if (input) input.focus();
    }
  } else if (action === 'hide' && node.moduleKey) {
    if (typeof window.setModuleVisibility === 'function') {
      window.setModuleVisibility(parentId, node.moduleKey, 'hidden', !!node.hidden);
    }
    setTimeout(renderGraphCanvas, 0);
  }
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
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + (n.w || 120));
    maxY = Math.max(maxY, n.y + (n.h || 60));
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


function _startNodeDrag(event, nodeEl) {
  const node = _findGraphNode(nodeEl.dataset.nodeId);
  if (!node) return;
  event.preventDefault();
  event.stopPropagation();
  graphView.dragNodeId = node.id;
  graphView.pointerId = event.pointerId;
  graphView.startX = event.clientX;
  graphView.startY = event.clientY;
  graphView.nodeStartX = node.x;
  graphView.nodeStartY = node.y;
  graphView.moved = false;
  nodeEl.classList.add('dragging');
}

function _startCanvasPan(event) {
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

function _handlePointerMove(event) {
  if (graphView.pointerId !== event.pointerId) return;
  const dx = event.clientX - graphView.startX;
  const dy = event.clientY - graphView.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) graphView.moved = true;
  const state = _graphState();
  if (graphView.dragNodeId) {
    const node = _findGraphNode(graphView.dragNodeId);
    if (node) {
      node.x = graphView.nodeStartX + dx / (graphView.zoom || 1);
      node.y = graphView.nodeStartY + dy / (graphView.zoom || 1);
      _updateNodeTransforms();
      _redrawEdges();
    }
  } else if (graphView.panning) {
    state.pan.x = graphView.panStartX + dx;
    state.pan.y = graphView.panStartY + dy;
    _saveGraphState(state);
    _applyGraphTransform();
  }
}

function _endPointerDrag(event) {
  if (graphView.pointerId !== event.pointerId) return;
  if (graphView.dragNodeId) {
    const node = _findGraphNode(graphView.dragNodeId);
    if (node) {
      const state = _graphState();
      state.positions = state.positions || {};
      state.positions[node.id] = { x: node.x, y: node.y };
      _saveGraphState(state);
    }
    graphInner?.querySelectorAll('.graph-node.dragging').forEach(el => el.classList.remove('dragging'));
  }
  graphView.dragNodeId = null;
  graphView.panning = false;
  graphView.pointerId = null;
  graphView.moved = false;
  graphCanvas?.classList.remove('panning');
}

function _initGraphCanvasEvents() {
  if (!graphCanvas) return;
  graphCanvas.addEventListener('wheel', e => {
    e.preventDefault();
    zoomGraph(e.deltaY < 0 ? 1.08 : 0.92, e.clientX, e.clientY);
  }, { passive: false });
  graphCanvas.addEventListener('pointerdown', e => {
    if (e.target.closest('.graph-canvas-toolbar')) return;
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl && !e.target.closest('button, a, input, textarea, iframe')) _startNodeDrag(e, nodeEl);
    else _startCanvasPan(e);
  });
  graphCanvas.addEventListener('pointermove', _handlePointerMove);
  window.addEventListener('pointerup', _endPointerDrag);
  graphCanvas.addEventListener('click', e => {
    if (graphView.moved) return;
    if (e.target.closest('button, a, input, textarea, iframe')) return;
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId;
      graphView.selectedNodeId = graphView.selectedNodeId === id ? null : id;
      graphInner?.querySelectorAll('.graph-node.selected').forEach(el => el.classList.remove('selected'));
      if (graphView.selectedNodeId) nodeEl.classList.add('selected');
    } else {
      graphView.selectedNodeId = null;
      graphInner?.querySelectorAll('.graph-node.selected').forEach(el => el.classList.remove('selected'));
    }
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
window.graphModuleAction = graphModuleAction;
window.zoomGraph = zoomGraph;
window.fitGraph = fitGraph;
window.resetGraphLayout = resetGraphLayout;
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
