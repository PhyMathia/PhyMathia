// ===== PhyMathia 知识网络画布：自定义/输入/文档节点 =====

function _saveCustomNodes() {
  // 任务列表：有工作流任务在跑时，保存出口改写到**任务所属会话**的 state（T59）。
  // 否则切了会话之后，产出会跟着当前画布写进别人家（graphView 与 SESSION_ID 都是现场读的）。
  if (typeof _taskSaveNodesOverride === 'function' && _taskSaveNodesOverride()) return;
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
  const groups = ['ai', 'modules', 'data', 'human', 'structure'];
  const groupLabels = { ai: 'AI 生成', modules: '视角模块', data: '基础素材', human: '人工内容', structure: '结构' };
  const items = groups.map(group => {
    const opts = MANUAL_NODE_OPTIONS.filter(option => (option.group || 'ai') === group);
    if (!opts.length) return '';
    return '<div class="graph-add-node-group"><div class="graph-add-node-group-title">' + groupLabels[group] + '</div>'
      + '<div class="graph-add-node-grid">'
      + opts.map(option => {
          return '<button class="graph-add-node-item" style="--node-color:' + option.color + '" title="' + escapeHtml(option.desc || option.label) + '" onclick="createManualNode(\'' + option.key + '\')">'
            + '<span class="graph-add-node-dot ' + _nodeFamilyShape(option) + '"></span>'
            + escapeHtml(option.label)
            + '</button>';
        }).join('')
      + '</div></div>';
  }).join('');
  // 「我的配方」组（P1，D-R7）：默认空、绝不预置——空态只有「新建配方」引导入口
  const recipes = typeof getUserRecipes === 'function' ? getUserRecipes() : [];
  const recipeItems = recipes.map(recipe => {
    const shape = (recipe.appearance && recipe.appearance.shape) || 'is-round';
    return '<button class="graph-add-node-item" style="--node-color:' + recipeAppearanceColor(recipe.appearance) + '"'
      + ' title="' + escapeHtml(recipe.desc || recipe.name) + '" onclick="createRecipeNode(\'' + recipe.id + '\')">'
      + '<span class="graph-add-node-dot ' + shape + '"></span>'
      + escapeHtml(recipe.name)
      + '</button>';
  }).join('');
  const recipeGroup = '<div class="graph-add-node-group"><div class="graph-add-node-group-title recipe-group-title">我的配方'
    + '<button type="button" class="graph-recipe-manage-btn" onclick="openRecipeManage()" title="管理配方">管理</button></div>'
    + '<div class="graph-add-node-grid">'
    + recipeItems
    + '<button class="graph-add-node-item graph-recipe-guide" onclick="openRecipeForm(null)" title="创建自己的节点类型：起名、写提示词、配出口">'
    + '<span class="graph-add-node-dot is-round"></span>＋ 新建配方'
    + '</button>'
    + '</div></div>';
  overlay.innerHTML = '<div class="graph-add-node-dialog aurora-glass">'
    + '<div class="graph-add-node-head">'
    + '<div class="graph-add-node-title">添加节点</div>'
    + '<button class="graph-add-node-close" onclick="closeAddBlankNodeModal()" title="关闭">×</button>'
    + '</div>'
    + items
    + recipeGroup
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
  overlay.innerHTML = '<div class="graph-network-modal aurora-glass">'
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
  overlay.innerHTML = '<div class="graph-network-modal aurora-glass">'
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
    messageIndex: -1,
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

// 配方节点（P1，D-R3 覆盖层）：现有 kind 底座 + recipeId + 内嵌快照。
// 快照随节点落库（customNodes 整条透传：_normalizeGraphState / .pmu 导出导入 /
// Φ 指纹（customNodes 已含 recipeId）都不需要另开字段）——删配方不毁旧节点。
function createRecipeNode(recipeId) {
  const recipe = (typeof getUserRecipes === 'function' ? getUserRecipes() : []).find(item => item.id === recipeId);
  if (!recipe) {
    toastMsg('配方不存在或已删除');
    closeAddBlankNodeModal();
    return;
  }
  const embed = typeof recipeEmbedSnapshot === 'function' ? recipeEmbedSnapshot(recipe) : null;
  if (!embed) {
    toastMsg('配方数据不完整，无法创建');
    return;
  }
  const kindMap = { manual: 'answer', question: 'user' };
  const kind = kindMap[embed.base.kind] || embed.base.kind;
  _pushGraphUndo();
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  state.customNodes.push({
    id: 'recipe-custom-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    kind,
    moduleKey: '',
    manual: embed.base.kind === 'manual',
    recipeId: recipe.id,
    recipe: embed,
    label: kind === 'human_note' ? embed.name : '',
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
    fileId: '',
    fileName: '',
    generatedNodeIds: [],
    category: '',
    formulas: [],
    knowledgeKey: '',
    x: addBlankNodePoint.x,
    y: addBlankNodePoint.y,
    depth: kind === 'user' ? 1 : kind === 'answer' ? 2 : (kind === 'summary' || kind === 'note' ? 4 : 3),
    targetAngle: 0,
    isRoot: false,
    messageIndex: -1,
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

// ===== 总结类节点（AI 总结 / 我的总结）的人工编辑 =====
// 此前这两类节点一旦有内容即只读：我的总结的内联输入框只在空内容时出现，
// AI 总结生成完成后无任何修改入口。这里补一个与模块编辑一致的弹窗。
function editCustomNodeContent(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0 || (node.kind !== 'summary' && node.kind !== 'note')) return;
  closeModuleNodeModal();
  const title = node.kind === 'summary' ? '人工编辑：AI 总结' : '人工编辑：我的总结';
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal aurora-glass">'
    + '<div class="graph-network-modal-head"><span>' + escapeHtml(title) + '</span><button onclick="closeModuleNodeModal()" title="关闭">×</button></div>'
    + '<label>总结内容</label>'
    + '<textarea id="customNodeContentBox" rows="8">' + escapeHtml(node.content || '') + '</textarea>'
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="saveCustomNodeContent(\'' + node.id + '\')">保存</button>'
    + '<button onclick="closeModuleNodeModal()">取消</button>'
    + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', ev => { if (ev.target === overlay) closeModuleNodeModal(); });
  document.body.appendChild(overlay);
  moduleNodeModalOverlay = overlay;
}

function saveCustomNodeContent(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0 || (node.kind !== 'summary' && node.kind !== 'note')) return;
  node.content = document.getElementById('customNodeContentBox')?.value || '';
  node.summary = _graphSummary(node.content);
  node.status = (node.content || '').trim() ? 'done' : 'waiting';
  // 人工改写后同步 inputHash 为当前值，避免「全部开始」因上游未变化而误判需要重新生成
  if (typeof _nodeInputHash === 'function') {
    try { node.inputHash = _nodeInputHash(node); } catch (e) { /* 保持原值 */ }
  }
  _saveCustomNodes();
  closeModuleNodeModal();
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


function _applyParsedDocumentToNode(node, data) {
  if (!node) return;
  node = _findGraphNode(node.id) || node;
  _clearSourceGeneratedNodes(node);
  const items = Array.isArray(data.nodes) ? data.nodes.slice(0, Math.max(1, node.maxItems || 5)) : [];
  const edges = Array.isArray(data.edges) ? data.edges : [];
  node.items = items;
  node.edges = edges;
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

  node.generatedNodeIds = createdIds;
  _saveGraphState(state);
  _saveDocumentKnowledgeToPanel(node, items, knowledgeNodes);
  renderGraphCanvas();
  if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
  if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
  if (typeof showToast === 'function') {
    showToast('已解析 ' + items.length + ' 个知识点');
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
    if (typeof hideProgress === 'function') hideProgress();
  } catch (err) {
    node.busy = false;
    node.status = 'error';
    _saveCustomNodes();
    renderGraphCanvas();
    if (typeof hideProgress === 'function') hideProgress();
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

function pasteSourceNodeText(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'source') return;
  const inputEl = document.querySelector('.graph-node[data-node-id="' + nodeId + '"] .graph-source-text-input');
  const text = inputEl ? String(inputEl.value || '').trim() : '';
  if (!text) { if (typeof showToast === 'function') showToast('请先粘贴文本'); return; }
  const maxEl = document.querySelector('.graph-node[data-node-id="' + nodeId + '"] .graph-source-max-input');
  const maxItems = maxEl ? parseInt(maxEl.value, 10) || 5 : (node.maxItems || 5);
  try {
    const file = new File([text], '粘贴文本.txt', { type: 'text/plain' });
    _loadSourceNodeFile(node, file, maxItems);
  } catch (e) {
    if (typeof showToast === 'function') showToast('解析失败：' + (e.message || e));
  }
}

function openHarnessOrganizeRelations(sourceNodeId) {
  if (typeof window.openGraphHarness === 'function') window.openGraphHarness();
  const inputEl = document.getElementById('graphHarnessInstruction');
  if (inputEl) {
    inputEl.value = '请整理这些知识点之间的关系：删掉牵强的连线，补上遗漏的连线；每条连线都要用一句具体的话说明为什么有关，禁止“相关/有联系/关联”这类空泛关系；不要创建单独的“联系”节点，直接连线即可。';
  }
  const children = (graphView && graphView.edges || []).filter(e => String(e.from) === String(sourceNodeId)).map(e => String(e.to));
  const focusIds = [String(sourceNodeId)].concat(children).filter((v, i, a) => v && a.indexOf(v) === i);
  if (typeof window.runGraphHarnessWithFocus === 'function') {
    window.runGraphHarnessWithFocus('normal', focusIds);
  }
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

window.pasteSourceNodeText = pasteSourceNodeText;
window.openHarnessOrganizeRelations = openHarnessOrganizeRelations;


// ===== 联系箭头（改法 A）：节点之间的注释性连线 =====
let graphLinkModalOverlay = null;
// 曲线样式弹窗的待应用选择：null=保持当前形状；'default'|'straight'|'smooth'|'s'
let linkCurvePending = null;
// 曲率滑杆系数（0~0.6 倍连线长度）
let linkCurveBendFactor = 0.3;
// 曲线编辑态：当前正在编辑的联系线 edgeKey
let linkCurveDrag = null;
let linkCurveUndoPushed = false;
let linkCurveListenersBound = false;

function toggleGraphLinkMode() {
  graphView.linkMode = !graphView.linkMode;
  graphView.linkFirstNodeId = null;
  _applyGraphLinkMode();
}

function _applyGraphLinkMode() {
  if (!graphCanvas) return;
  graphCanvas.classList.toggle('graph-link-mode', !!graphView.linkMode);
  const btn = graphCanvas.querySelector('.graph-link-btn');
  if (btn) {
    btn.classList.toggle('active', !!graphView.linkMode);
    btn.title = graphView.linkMode ? '退出联系模式' : '联系模式（点两个节点添加联系箭头）';
    btn.setAttribute('aria-pressed', String(!!graphView.linkMode));
  }
  if (!graphView.linkMode) graphView.linkFirstNodeId = null;
}

function _graphLinkPickNode(nodeId) {
  if (!graphView.linkMode) return;
  if (!graphView.linkFirstNodeId) {
    graphView.linkFirstNodeId = nodeId;
    if (typeof showToast === 'function') showToast('已选起点，再点一个节点作为终点');
    return;
  }
  if (graphView.linkFirstNodeId === nodeId) {
    if (typeof showToast === 'function') showToast('不能连到同一个节点');
    return;
  }
  const fromId = graphView.linkFirstNodeId;
  graphView.linkFirstNodeId = null;
  toggleGraphLinkMode();
  openLinkEdgeModal(null, fromId, nodeId);
}

function openLinkEdgeModal(edgeKey, fromId, toId) {
  closeLinkEdgeModal();
  linkCurvePending = null;
  let edge = null;
  if (edgeKey) {
    edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
    if (!edge) return;
    fromId = edge.from;
    toId = edge.to;
  }
  const fromNode = _findGraphNode(fromId);
  const toNode = _findGraphNode(toId);
  if (!fromNode || !toNode) return;
  const fromLabel = _shortGraphNodeLabel(fromNode);
  const toLabel = _shortGraphNodeLabel(toNode);
  const text = edge ? String(edge.relation || edge.label || '') : '';
  let activeCurve = 'default';
  if (edge && edge.curve) {
    if (edge.curve.shape === 'straight') activeCurve = 'straight';
    else if (Number.isFinite(edge.curve.dx1)) activeCurve = '';
  }
  const overlay = document.createElement('div');
  overlay.className = 'graph-network-modal-overlay';
  overlay.innerHTML = '<div class="graph-network-modal aurora-glass">'
    + '<div class="graph-network-modal-head"><span>联系箭头</span><button onclick="closeLinkEdgeModal()" title="关闭">×</button></div>'
    + '<div class="graph-link-edge-info">' + escapeHtml(fromLabel) + ' <span class="graph-link-edge-arrow">↔</span> ' + escapeHtml(toLabel) + '</div>'
    + '<label>关系说明（一句话，为什么有关）</label>'
    + '<textarea id="linkEdgeRelation" rows="3" placeholder="例如：两者都描述局部变化率">' + escapeHtml(text) + '</textarea>'
    + '<label>箭头方向</label>'
    + '<div class="graph-link-arrow-options">'
    + '<button type="button" class="graph-link-arrow-option" data-arrow="right" onclick="selectLinkArrow(this)" title="向右箭头"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="19" y2="12"></line><polyline points="13 6 19 12 13 18"></polyline></svg></button>'
    + '<button type="button" class="graph-link-arrow-option" data-arrow="left" onclick="selectLinkArrow(this)" title="向左箭头"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="21" y1="12" x2="5" y2="12"></line><polyline points="11 6 5 12 11 18"></polyline></svg></button>'
    + '<button type="button" class="graph-link-arrow-option" data-arrow="both" onclick="selectLinkArrow(this)" title="双向箭头"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"></line><polyline points="11 6 5 12 11 18"></polyline><polyline points="13 6 19 12 13 18"></polyline></svg></button>'
    + '<button type="button" class="graph-link-arrow-option" data-arrow="none" onclick="selectLinkArrow(this)" title="无箭头"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="12" x2="21" y2="12"></line></svg></button>'
    + '</div>'
    + '<label>曲线样式</label>'
    + '<div class="graph-link-curve-options">'
    + '<button type="button" class="graph-link-curve-option" data-curve="default" onclick="selectLinkCurve(this)">默认</button>'
    + '<button type="button" class="graph-link-curve-option" data-curve="straight" onclick="selectLinkCurve(this)">直线</button>'
    + '<button type="button" class="graph-link-curve-option" data-curve="smooth" onclick="selectLinkCurve(this)">平滑弯</button>'
    + '<button type="button" class="graph-link-curve-option" data-curve="s" onclick="selectLinkCurve(this)">S 弯</button>'
    + '</div>'
    + '<label class="graph-link-bend-row">曲率 <input type="range" id="linkCurveBend" min="0" max="100" value="' + Math.round(linkCurveBendFactor * 100 / 0.6) + '" oninput="updateLinkCurveBend(this.value)"> <span id="linkCurveBendVal"></span></label>'
    + '<div class="graph-link-curve-hint">提示：单击连线进入手柄精调（拖动圆点调整弯曲）；双击连线打开此弹窗。</div>'
    + '<div class="graph-network-modal-actions">'
    + '<button class="graph-network-modal-save" onclick="saveLinkEdge(\'' + (edgeKey || '') + '\',\'' + fromId + '\',\'' + toId + '\')">' + (edge ? '保存修改' : '添加联系') + '</button>'
    + (edge ? '<button class="graph-link-edge-curve-btn" onclick="editLinkCurveFromModal(\'' + edgeKey + '\')" title="关闭弹窗，在线上拖动控制圆点精调曲线">手柄精调曲线</button>' : '')
    + (edge ? '<button class="graph-link-edge-delete" onclick="deleteLinkEdge(\'' + edgeKey + '\')">删除</button>' : '')
    + '<button onclick="closeLinkEdgeModal()">取消</button>'
    + '</div>'
    + '</div>';
  overlay.addEventListener('pointerdown', event => {
    if (event.target === overlay) closeLinkEdgeModal();
  });
  document.body.appendChild(overlay);
  const arrow = edge ? String(edge.arrow || 'right') : 'right';
  overlay.querySelector('[data-arrow="' + arrow + '"]')?.classList.add('active');
  if (activeCurve) overlay.querySelector('[data-curve="' + activeCurve + '"]')?.classList.add('active');
  updateLinkCurveBend(document.getElementById('linkCurveBend')?.value);
  graphLinkModalOverlay = overlay;
}

function _shortGraphNodeLabel(node) {
  return String(node && (node.label || node.title || node.summary || node.content || '')).trim().slice(0, 24) || '节点';
}

function selectLinkArrow(btn) {
  const parent = btn && btn.closest ? btn.closest('.graph-link-arrow-options') : null;
  if (!parent) return;
  parent.querySelectorAll('.graph-link-arrow-option').forEach(item => item.classList.remove('active'));
  btn.classList.add('active');
}

function closeLinkEdgeModal() {
  if (graphLinkModalOverlay) {
    graphLinkModalOverlay.remove();
    graphLinkModalOverlay = null;
  }
}

function saveLinkEdge(edgeKey, fromId, toId) {
  const text = (document.getElementById('linkEdgeRelation')?.value || '').trim();
  const fromNode = _findGraphNode(fromId);
  const toNode = _findGraphNode(toId);
  if (!fromNode || !toNode || fromId === toId) return;
  _pushGraphUndo();
  const state = _graphState();
  state.connections = state.connections || [];
  let conn = null;
  if (edgeKey) {
    conn = state.connections.find(item => _edgeKey(item) === edgeKey) || null;
  }
  if (!conn) {
    conn = state.connections.find(item => item.link && String(item.from) === String(fromId) && String(item.to) === String(toId)) || null;
  }
  if (!conn) {
    conn = { from: fromId, fromPort: 'link-0', to: toId, toPort: 'link-0', type: 'custom', custom: true, link: true };
    state.connections.push(conn);
  }
  conn.link = true;
  conn.relation = text;
  conn.label = text;
  conn.arrow = document.querySelector('.graph-link-arrow-option.active')?.dataset?.arrow || conn.arrow || 'right';
  // 曲线样式：仅在弹窗里明确选择了样式时才改写，保留手柄精调的自定义曲线
  if (linkCurvePending === 'default') {
    delete conn.curve;
  } else if (linkCurvePending === 'straight') {
    conn.curve = { shape: 'straight' };
  } else if (linkCurvePending === 'smooth' || linkCurvePending === 's') {
    const anchors = _linkCurveAnchors(_edgeKey(conn));
    if (anchors) {
      conn.curve = computeLinkCurveOffsets(linkCurvePending, anchors.p1, anchors.p2, linkCurveBendFactor);
    }
  }
  linkCurvePending = null;
  _saveGraphState(state);
  closeLinkEdgeModal();
  renderGraphCanvas();
}

function deleteLinkEdge(edgeKey) {
  if (!edgeKey) return;
  _pushGraphUndo();
  const state = _graphState();
  state.connections = (state.connections || []).filter(item => _edgeKey(item) !== edgeKey);
  if (graphView.edgeCurveEditKey === edgeKey) graphView.edgeCurveEditKey = null;
  linkCurveUndoPushed = false;
  _saveGraphState(state);
  closeLinkEdgeModal();
  renderGraphCanvas();
}

// ===== 单击/双击入口 =====
// 单击联系线：直接进入手柄精调（由画布 click 处理器调用 enterLinkCurveEdit）
// 双击联系线：打开本弹窗（由画布 dblclick 处理器调用 openLinkEdgeModal）

// 弹窗里的「手柄精调曲线」按钮：关弹窗并进入钢笔式编辑态
function editLinkCurveFromModal(edgeKey) {
  if (!edgeKey) return;
  closeLinkEdgeModal();
  enterLinkCurveEdit(edgeKey);
}

// ===== 联系线贝塞尔曲线：预设样式 + 钢笔式手柄编辑 =====

function selectLinkCurve(btn) {
  const parent = btn && btn.closest ? btn.closest('.graph-link-curve-options') : null;
  if (!parent) return;
  parent.querySelectorAll('.graph-link-curve-option').forEach(item => item.classList.remove('active'));
  btn.classList.add('active');
  linkCurvePending = btn.dataset.curve || null;
}

function updateLinkCurveBend(value) {
  const factor = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  linkCurveBendFactor = factor * 0.6;
  const valEl = document.getElementById('linkCurveBendVal');
  if (valEl) valEl.textContent = String(Math.round(factor * 100));
}

// 按预设形状生成控制点偏移（相对两端锚点），bend 为连线长度比例
function computeLinkCurveOffsets(shape, p1, p2, bend) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const bow = len * (Number.isFinite(bend) ? bend : 0.3);
  if (shape === 's') {
    // S 弯：两个控制点在法线的相反两侧
    return {
      dx1: dx * 0.3 + nx * bow,
      dy1: dy * 0.3 + ny * bow,
      dx2: -dx * 0.3 - nx * bow,
      dy2: -dy * 0.3 - ny * bow,
    };
  }
  // 平滑弯：同侧弓形
  return {
    dx1: dx * 0.35 + nx * bow,
    dy1: dy * 0.35 + ny * bow,
    dx2: -dx * 0.35 + nx * bow,
    dy2: -dy * 0.35 + ny * bow,
  };
}

// 取联系线两端的锚点与边对象（与 _redrawEdges 的取点方式一致）
function _linkCurveAnchors(edgeKey) {
  const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
  if (!edge) return null;
  const a = graphView.nodeById[edge.from];
  const b = graphView.nodeById[edge.to];
  if (!a || !b) return null;
  const sourceEl = graphInner?.querySelector('[data-node-id="' + edge.from + '"][data-port-id="' + edge.fromPort + '"]');
  const targetEl = graphInner?.querySelector('[data-node-id="' + edge.to + '"][data-port-id="' + edge.toPort + '"]');
  return { p1: _portAnchor(a, sourceEl, true), p2: _portAnchor(b, targetEl, false), edge };
}

function enterLinkCurveEdit(edgeKey) {
  const found = _linkCurveAnchors(edgeKey);
  if (!found || !found.edge || !found.edge.link) return;
  // 已处于同一条线的编辑态（如手柄拖拽结束后的 click 事件）时直接忽略
  if (graphView.edgeCurveEditKey === edgeKey) return;
  _ensureLinkCurveDragListeners();
  graphView.edgeCurveEditKey = edgeKey;
  linkCurveUndoPushed = false;
  // 尚无自定义曲线时，把当前默认形状物化为偏移，手柄才有合理的初始位置
  const curve = found.edge.curve;
  if (!curve || (!Number.isFinite(curve.dx1))) {
    if (curve && curve.shape === 'straight') {
      found.edge.curve = {
        dx1: (found.p2.x - found.p1.x) / 3,
        dy1: (found.p2.y - found.p1.y) / 3,
        dx2: (found.p2.x - found.p1.x) / 3,
        dy2: (found.p2.y - found.p1.y) / 3,
      };
    } else {
      found.edge.curve = _linkDefaultCurveOffsets(found.p1, found.p2);
    }
  }
  if (typeof showToast === 'function') showToast('拖动圆点调整曲线；点击空白处或按 Esc 退出');
  if (typeof _redrawEdges === 'function') _redrawEdges();
}

function exitLinkCurveEdit() {
  if (!graphView.edgeCurveEditKey) return;
  graphView.edgeCurveEditKey = null;
  linkCurveUndoPushed = false;
  if (typeof _redrawEdges === 'function') _redrawEdges();
}

function _beginLinkCurveDrag(edgeKey, which, event) {
  const found = _linkCurveAnchors(edgeKey);
  if (!found || !found.edge || !found.edge.link) return;
  if (!found.edge.curve || !Number.isFinite(found.edge.curve.dx1)) {
    found.edge.curve = _linkDefaultCurveOffsets(found.p1, found.p2);
  }
  if (!linkCurveUndoPushed) {
    if (typeof _pushGraphUndo === 'function') _pushGraphUndo();
    linkCurveUndoPushed = true;
  }
  // 记录画布本地坐标系下的起点与控制点绝对位置：
  // 之后每帧用实时变换(client→local)反推增量，拖拽中缩放/平移都不会让曲线跳变
  const startLocal = (typeof _clientToGraphLocal === 'function')
    ? _clientToGraphLocal(event.clientX, event.clientY)
    : { x: event.clientX, y: event.clientY };
  linkCurveDrag = {
    edgeKey,
    which,
    startLocal,
    startC1: { x: found.p1.x + (found.edge.curve.dx1 || 0), y: found.p1.y + (found.edge.curve.dy1 || 0) },
    startC2: { x: found.p2.x + (found.edge.curve.dx2 || 0), y: found.p2.y + (found.edge.curve.dy2 || 0) },
  };
  try { event.target.setPointerCapture(event.pointerId); } catch { /* ignore */ }
}

function _ensureLinkCurveDragListeners() {
  if (linkCurveListenersBound) return;
  linkCurveListenersBound = true;
  document.addEventListener('pointerdown', event => {
    // 右键/中键不计入双击检测、不进入手柄拖拽（与 graph-workflow.js 的 pointerdown
    // 入口过滤同口径，M1 细化）：快速右双击联系线不再误开编辑弹窗，右键只走菜单链路
    if (event.button !== 0) return;
    const handle = event.target && event.target.closest
      ? event.target.closest('.graph-edge-handle, .graph-curve-knob-hit')
      : null;
    if (handle && handle.dataset.edgeKey) {
      event.preventDefault();
      event.stopPropagation();
      _beginLinkCurveDrag(handle.dataset.edgeKey, handle.dataset.handle, event);
      return;
    }
    // 双击检测必须在 pointerdown 做（重渲染前、且不受 click 改派影响）：
    // 进/出精调态都会重绘替换 SVG 元素，第二次点击的 click 事件常被浏览器
    // 改派到公共祖先容器，导致原生 dblclick 与 click 分支都收不到连线目标。
    const linkEl = event.target && event.target.closest
      ? event.target.closest('.graph-edge-link, .graph-edge-link-label')
      : null;
    const pressNow = Date.now();
    const lastPress = graphView._lastLinkEdgePress || null;
    if (linkEl && linkEl.dataset.edgeKey) {
      const pressKey = linkEl.dataset.edgeKey;
      if (lastPress && lastPress.key === pressKey && (pressNow - lastPress.t) < 450
          && Math.abs(lastPress.cx - event.clientX) < 10 && Math.abs(lastPress.cy - event.clientY) < 10) {
        graphView._lastLinkEdgePress = null;
        graphView.suppressClick = true;      // 吞掉本次手势的 click，避免再次进入精调态
        graphView.edgeCurveEditKey = null;
        openLinkEdgeModal(pressKey);
        return;
      }
      graphView._lastLinkEdgePress = { key: pressKey, t: pressNow, cx: event.clientX, cy: event.clientY };
    } else {
      graphView._lastLinkEdgePress = null;
    }
    if (graphView.edgeCurveEditKey) exitLinkCurveEdit();
  }, true);
  document.addEventListener('pointermove', event => {
    if (!linkCurveDrag) return;
    const edge = (graphView.edges || []).find(item => _edgeKey(item) === linkCurveDrag.edgeKey);
    if (!edge) return;
    // 用实时变换把当前指针位置换算到画布本地坐标系：
    // 拖拽期间缩放/平移发生变化时，控制点仍严格跟随指针，不会跳变
    const cur = (typeof _clientToGraphLocal === 'function')
      ? _clientToGraphLocal(event.clientX, event.clientY)
      : { x: event.clientX, y: event.clientY };
    const ddx = cur.x - linkCurveDrag.startLocal.x;
    const ddy = cur.y - linkCurveDrag.startLocal.y;
    const anchors = _linkCurveAnchors(linkCurveDrag.edgeKey);
    if (!anchors) return;
    edge.curve = {
      dx1: (linkCurveDrag.startC1.x + (linkCurveDrag.which === 'c1' ? ddx : 0)) - anchors.p1.x,
      dy1: (linkCurveDrag.startC1.y + (linkCurveDrag.which === 'c1' ? ddy : 0)) - anchors.p1.y,
      dx2: (linkCurveDrag.startC2.x + (linkCurveDrag.which === 'c2' ? ddx : 0)) - anchors.p2.x,
      dy2: (linkCurveDrag.startC2.y + (linkCurveDrag.which === 'c2' ? ddy : 0)) - anchors.p2.y,
    };
    if (typeof requestAnimationFrame === 'function') {
      if (!linkCurveDrag.raf) {
        linkCurveDrag.raf = requestAnimationFrame(() => {
          linkCurveDrag && (linkCurveDrag.raf = 0);
          if (typeof _redrawEdges === 'function') _redrawEdges();
        });
      }
    } else if (typeof _redrawEdges === 'function') {
      _redrawEdges();
    }
  });
  document.addEventListener('pointerup', () => {
    if (!linkCurveDrag) return;
    const drag = linkCurveDrag;
    linkCurveDrag = null;
    const viewEdge = (graphView.edges || []).find(item => _edgeKey(item) === drag.edgeKey);
    const state = _graphState();
    state.connections = state.connections || [];
    const conn = state.connections.find(item => item.link && _edgeKey(item) === drag.edgeKey)
      || state.connections.find(item => _edgeKey(item) === drag.edgeKey);
    if (conn && viewEdge && viewEdge.curve) {
      conn.curve = { ...viewEdge.curve };
      conn.link = true;
      _saveGraphState(state);
    }
    if (typeof _redrawEdges === 'function') _redrawEdges();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && graphView.edgeCurveEditKey) exitLinkCurveEdit();
  });
}

window.selectLinkArrow = selectLinkArrow;
window.toggleGraphLinkMode = toggleGraphLinkMode;
window.openLinkEdgeModal = openLinkEdgeModal;
window.closeLinkEdgeModal = closeLinkEdgeModal;
window.saveLinkEdge = saveLinkEdge;
window.deleteLinkEdge = deleteLinkEdge;
window.selectLinkCurve = selectLinkCurve;
window.updateLinkCurveBend = updateLinkCurveBend;
window.enterLinkCurveEdit = enterLinkCurveEdit;
window.exitLinkCurveEdit = exitLinkCurveEdit;
window.editLinkCurveFromModal = editLinkCurveFromModal;
