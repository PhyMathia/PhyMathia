// ===== PhyMathia 知识网络画布：画布渲染、交互动作、选择与拖拽 =====

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
            <div class="graph-node-header"><span class="graph-node-badge">新问题</span></div>
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
  // 整条工具栏作为一个极光玻璃胶囊（一次 backdrop-filter），按钮自身退成透明——
  // 逐个按钮套磨砂会让视觉变"碎"，且十来个 blur 层白烧性能。
  toolbar.className = 'graph-canvas-toolbar aurora-glass aurora-glass--compact';
  toolbar.innerHTML = '<button class="graph-tool-btn graph-search-btn" onclick="toggleGraphSearchPanel()" title="搜索节点" aria-label="搜索节点" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="toggleGraphConsistencyPanel()" title="图体检（孤儿/断链/重复标签）">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 2l8 3v6c0 5-3.5 8.5-8 11-4.5-2.5-8-6-8-11V5z"></path><polyline points="9 12 11 14 15 10"></polyline>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-tool-glyph-lg" onclick="zoomGraph(1.2)" title="放大">+</button>'
    + '<button class="graph-tool-btn graph-tool-glyph-lg" onclick="zoomGraph(0.85)" title="缩小">−</button>'
    + '<button class="graph-tool-btn graph-tool-glyph-lg graph-tool-fit-btn" onclick="fitGraph()" title="适配画布">⌂</button>'
    + '<button class="graph-tool-btn" onclick="toggleGraphHistoryPanel()" title="修改历史（撤销/重做/回到任意版本）">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">'
    + '<circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15.5 14"></polyline>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-select-btn" onclick="graphToggleTextSelection()" title="选择文字" aria-label="选择文字" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M8 4v16"></path><path d="M16 4v16"></path><path d="M12 2v20"></path>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-link-btn" onclick="toggleGraphLinkMode()" title="联系模式（点两个节点添加联系箭头）" aria-label="联系模式" aria-pressed="false">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M9 12h6"></path><path d="M9 12a3 3 0 1 1-3-3"></path><path d="M15 12a3 3 0 1 0 3-3"></path><line x1="12" y1="5" x2="12" y2="19"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn" onclick="graphCreateGroup()" title="将选中节点创建为分组" aria-label="将选中节点创建为分组">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>'
    + '<line x1="12" y1="11" x2="12" y2="17"></line><line x1="9" y1="14" x2="15" y2="14"></line>'
    + '</svg></button>'
    + '<button class="graph-tool-btn graph-harness-btn" onclick="toggleGraphPet()" title="Φ 网络助手" aria-label="Φ 网络助手" aria-pressed="true">'
    + '<span class="graph-harness-btn-phi">Φ</span></button>'
    + '<button class="graph-tool-btn" onclick="autoArrangeGraph()" title="自动整理">⌗</button>'
    + '<button class="graph-tool-btn graph-export-btn" onclick="toggleGraphExportMenu()" title="导出超高清图片（PNG）" aria-label="导出超高清图片">'
    + '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<path d="M12 3v12"></path><path d="m7 10 5 5 5-5"></path><path d="M5 21h14"></path>'
    + '</svg></button>';
  graphCanvas.appendChild(toolbar);
  _applyGraphTextSelectionMode();
  _applyGraphLinkMode();
  if (typeof window.syncGraphPetToggleButton === 'function') window.syncGraphPetToggleButton();
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
  if (text && typeof window.startQuestionWorkflow === 'function') window.startQuestionWorkflow(text);
}

function graphModuleAction(action, nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node) return;
  // 最小化对消息派生节点与自定义节点统一处理（自定义节点没有 messageIndex）
  if (action === 'minimize') {
    _toggleGraphNodeMinimize(node);
    return;
  }
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
  }
}

function _toggleGraphNodeMinimize(node) {
  const nextMinimized = !node.minimized;
  node.minimized = nextMinimized;
  const state = _graphState();
  if (node.messageIndex >= 0 && (node.kind === 'module' || node.kind === 'answer')) {
    // 消息派生模块/回答簇：沿用 collapsed 映射持久化
    const messages = _getChatHistory();
    const message = messages[node.messageIndex];
    const parentId = message ? String(message.timestamp || '') : '';
    const moduleKey = node.kind === 'module' ? node.moduleKey : 'answer';
    if (typeof window.setModuleVisibility === 'function') {
      window.setModuleVisibility(parentId, moduleKey, 'collapsed', nextMinimized);
    }
  } else if (state && Array.isArray(state.customNodes)) {
    // 自定义节点：minimized 状态直接写入 customNodes 并保存
    const idx = state.customNodes.findIndex(function (cn) { return String(cn.id) === String(node.id); });
    if (idx >= 0) {
      state.customNodes[idx].minimized = nextMinimized;
      _saveGraphState(state);
    }
  }
  const el = graphInner && graphInner.querySelector ? graphInner.querySelector('[data-node-id="' + node.id + '"]') : null;
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
  // 复用分支父模块解析（含 extend → socratic/learn 别名），再回退答案节点
  const modId = (typeof _resolveBranchModuleId === 'function')
    ? _resolveBranchModuleId(graphView.nodeById || {}, { parentId, sourceModule, branchType: anchor?.branchType || '' })
    : null;
  if (modId) candidates.push(modId);
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

function _findDraftSourceNodeId(nodeId) {
  const edge = (graphView.edges || []).find(e => String(e.to) === String(nodeId) && e.draft);
  return edge ? edge.from : '';
}

function submitDraftQuestion(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const input = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-draft-input');
  const text = (input?.value || '').trim();
  if (!text) return;
  const meta = node.portMeta || {};
  const sourceNodeId = _findDraftSourceNodeId(nodeId);
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(text, { sourceNodeId: sourceNodeId || '', sourcePort: meta.fromPort || '', draftNodeId: nodeId });
  }
}

function draftSocraticAnswer(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const meta = node.portMeta || {};
  if (typeof window.startSocraticAnswer === 'function') {
    // 第 7 参传来源端口：回答完成后新节点连回被拖出的那个问题端口
    window.startSocraticAnswer(meta.question || '', meta.level || 'basic', meta.parentId || '', meta.sourceModule || 'extend', node.x, node.y, meta.fromPort || '');
  }
}

function draftAskAi(nodeId) {
  const node = _findDraftNode(nodeId);
  if (!node) return;
  const meta = node.portMeta || {};
  const question = meta.question || '';
  if (!question) return;
  const sourceNodeId = _findDraftSourceNodeId(nodeId);
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(question, { sourceNodeId: sourceNodeId || '', sourcePort: meta.fromPort || '', draftNodeId: nodeId });
  }
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
  if (moduleKey === 'viz') {
    // 可视化模块必须返回完整 HTML 页面，优先使用专门的 HTML 模型，失败时回退主模型。
    if (typeof _requestVisualizationHtml !== 'function') throw new Error('可视化生成模块未加载，请刷新页面后重试');
    const html = await _requestVisualizationHtml(
      message?.content || '',
      new AbortController().signal,
      '用户没看懂/有新要求：' + confusion
    );
    return _replaceModuleContent(message?.content || '', moduleKey, '## 交互探索\n\n```html\n' + html + '\n```');
  }

  const moduleLabel = (GRAPH_MODULE_META[moduleKey] || {}).label || moduleKey;
  const original = _extractRawModuleSection(message?.content || '', moduleKey) || '（没有原内容）';
  const prompt = '用户对下面「' + moduleLabel + '」中的内容有没看懂的地方。'
    + '请只重新生成这个模块，不改变其他模块。'
    + '要求：用更简单、更慢、更生活化的语言重讲；保留公式和 Markdown；'
    + '如果是苏格拉底追问或进阶学习，只输出该小节内容，不要输出整个学习卡片。\n\n'
    + '原内容：\n' + original + '\n\n用户没看懂：\n' + confusion;
  let reply = '';

  if (typeof getActiveModelForRole === 'function') {
    let agentModel = getActiveModelForRole('agent');
    if ((moduleKey === 'socratic' || moduleKey === 'learn') && typeof getActiveModelForRole === 'function') {
      const branchModel = getActiveModelForRole('branch');
      if (branchModel) agentModel = branchModel;
    }
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

  if (typeof showToast === 'function') showToast('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
  throw new Error('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
}

const _generatingVizNodes = new Set();

async function generateVizNode(nodeId) {
  if (_generatingVizNodes.has(nodeId)) return;
  if (typeof isStreaming !== 'undefined' && isStreaming) return;
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'module' || node.moduleKey !== 'viz') return;
  const messages = _getChatHistory();
  const message = messages[node.messageIndex];
  if (!message) return;

  _generatingVizNodes.add(nodeId);
  try {
    const nextContent = await ensureVisualization(message.content || '', new AbortController().signal);
    if (nextContent === message.content) {
      throw new Error('模型未返回完整 HTML 页面，请检查模型配置后重试');
    }
    const updated = typeof window.updateChatHistoryMessage === 'function'
      ? window.updateChatHistoryMessage(message.timestamp, item => ({ ...item, content: nextContent }))
      : false;
    if (!updated) throw new Error('未找到对应的回答消息');
    if (typeof saveCurrentSession === 'function') await saveCurrentSession();
    if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
    if (typeof renderCurrentChat === 'function') await renderCurrentChat();
    else if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof hideProgress === 'function') hideProgress('交互可视化已生成');
    if (typeof showToast === 'function') showToast('交互可视化已生成');
  } catch (err) {
    console.warn('Generate visualization node failed:', err);
    if (typeof hideProgress === 'function') hideProgress('生成可视化失败');
    if (typeof showToast === 'function') showToast('生成可视化失败：' + (err.message || err));
  } finally {
    _generatingVizNodes.delete(nodeId);
  }
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
  if (graphView.edgeCurveEditKey === edgeKey) graphView.edgeCurveEditKey = null;
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
  if (!node || !(_moduleCanExpandOutputs(node) || node.kind === 'source' || node.kind === 'knowledge')) return;
  _pushGraphUndo();
  const state = _graphState();
  state.portCounts = state.portCounts || {};
  state.portCounts[nodeId] = (state.portCounts[nodeId] || 0) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphAddInputPort(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || (node.kind !== 'user' && node.kind !== 'hub' && node.kind !== 'relation' && node.kind !== 'module' && node.kind !== 'blank')) return;
  _pushGraphUndo();
  const state = _graphState();
  state.inputPortCounts = state.inputPortCounts || {};
  state.inputPortCounts[nodeId] = (state.inputPortCounts[nodeId] || 0) + 1;
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRemoveInputPort(nodeId, portIndex) {
  const node = _findGraphNode(nodeId);
  if (!node || (node.kind !== 'user' && node.kind !== 'hub' && node.kind !== 'relation' && node.kind !== 'module' && node.kind !== 'blank')) return;
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
  if (!node || !(_moduleCanExpandOutputs(node) || node.kind === 'source' || node.kind === 'knowledge')) return;
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

// 画布缩放限度：0.10 ~ 4.00（旧值 0.25 ~ 2.50 偏窄，放大不够细、缩小看不全大图）
const GRAPH_MIN_ZOOM = 0.1;
const GRAPH_MAX_ZOOM = 4;

function zoomGraph(factor, centerX, centerY) {
  const state = _graphState();
  const oldZoom = state.zoom || 0.9;
  const newZoom = Math.min(GRAPH_MAX_ZOOM, Math.max(GRAPH_MIN_ZOOM, oldZoom * factor));
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
  state.zoom = Math.max(GRAPH_MIN_ZOOM, zoom);
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
      _pushGraphUndo(false, { layout: true });
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
      _pushGraphUndo(false, { layout: true });
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
      _pushGraphUndo(false, { layout: true });
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
      _pushGraphUndo(false, { layout: true });
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

