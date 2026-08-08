// ===== PhyMathia 知识网络画布：自定义/输入/文档节点 =====

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
