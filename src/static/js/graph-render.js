// ===== PhyMathia 知识网络画布：节点渲染、端口、高亮与布局 =====

function _nodeAttribute(node) {
  // 节点配方（P1）：配方节点的外观（名称标签＋色板令牌）优先于底座默认值
  const recipeAttr = typeof _recipeNodeAttribute === 'function' ? _recipeNodeAttribute(node) : null;
  if (recipeAttr) return recipeAttr;
  if (node.kind === 'draft') {
    return GRAPH_NODE_ATTRIBUTES[node.portMeta && node.portMeta.attribute] || GRAPH_NODE_ATTRIBUTES.followup;
  }
  if (node.kind === 'module') {
    return GRAPH_NODE_ATTRIBUTES[node.moduleKey] || GRAPH_NODE_ATTRIBUTES.question;
  }
  if (node.kind === 'blank') {
    return GRAPH_NODE_ATTRIBUTES[node.moduleKey] || GRAPH_NODE_ATTRIBUTES.any;
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
  // 知识点节点输入为通用入口：任意来源都可接入（须在 hub 出口白名单之前判断）
  if (toNode.kind === 'knowledge') return true;
  if (toNode.kind === 'hub') return fromNode.kind !== 'hub';
  if (toNode.kind === 'summary') return fromNode.kind === 'hub' && String(fromPort || 'out-0') === 'out-0';
  if (toNode.kind === 'note') return fromNode.kind === 'hub' && String(fromPort || 'out-1') === 'out-1';
  if (fromNode.kind === 'hub') {
    const hubPort = String(fromPort || 'out-0');
    if (hubPort === 'out-0' || hubPort === 'out-1') return false;
    return ['user', 'blank', 'module', 'answer'].includes(toNode.kind);
  }
  if (toNode.kind === 'human_note') return fromNode.kind !== 'summary' && fromNode.kind !== 'note';
  if (toNode.kind === 'user') return fromNode.kind !== 'summary' && fromNode.kind !== 'note';
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
    return fromNode.kind !== 'draft' && fromNode.kind !== 'blank';
  }
  if (fromNode.kind === 'answer' && toNode.kind === 'module') return toNode.recipeId ? true : fromAttr === toAttr;
  if ((fromNode.kind === 'user' || fromNode.kind === 'knowledge') && toNode.kind === 'answer') {
    const isAiOutput = fromNode.kind === 'user'
      ? isUserAiOutput
      : String(fromPort || 'out-0') === 'out-0';
    return isAiOutput ? !toNode.manual : !!toNode.manual;
  }
  if (fromNode.kind === 'blank') return ['user', 'answer', 'module', 'hub', 'summary', 'note'].includes(toNode.kind);
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
    if (node.moduleKey === 'viz') {
      const messages = _getChatHistory();
      const message = messages[node.messageIndex];
      const vizContent = _nodeContent(message, node);
      const hasVisualization = typeof _hasVisualizationHtml === 'function' && _hasVisualizationHtml(vizContent);
      if (!hasVisualization) {
        return '<div class="graph-node-actions">'
          + _iconRegenButton('generateVizNode(\'' + node.id + '\')', '生成可视化', false)
          + '</div>';
      }
    }
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
  // 节点配方（P1）：配方静态出口表优先；底座为 module 时不再走内置默认表
  if (node.recipeId) {
    const recipePorts = typeof _recipeStaticPorts === 'function' ? _recipeStaticPorts(node) : [];
    if (recipePorts.length) return recipePorts;
    if ((node.recipe && node.recipe.base && node.recipe.base.kind) === 'module') return [];
  }
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
  if (node.recipeId && node.recipe && node.recipe.name) return node.recipe.name;
  if (node.kind === 'human_note') return '任意输入';
  if (node.kind === 'answer') return node.manual ? '我的回答' : 'AI 回答';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  if (node.kind === 'blank') return '任意输入';
  if (node.kind === 'hub') return '汇聚输入';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '我的总结';
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
  if (node.kind === 'user') return ['AI 回答', '我的回答'];
  if (node.kind === 'source') return (node.items || []).map(item => item.title || '知识点 ' + ((node.items || []).indexOf(item) + 1));
  if (node.kind === 'knowledge') return ['AI 回答', '问题'];
  if (node.kind === 'relation') return [];
  if (node.kind === 'module') {
    return _moduleOutputPorts(node, messages[node.messageIndex]).map(item => item.label);
  }
  if (node.kind === 'answer') {
    return _answerOutputPorts(node, messages).map(item => item.label);
  }
  if (node.kind === 'hub') return ['AI 总结', '我的总结', '追问'];
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
    if (node.kind === 'hub') return index === 0 ? 'summary' : (index === 1 ? 'note' : 'followup');
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
  const canAddInput = node.kind === 'user' || node.kind === 'hub' || node.kind === 'relation' || node.kind === 'blank';
  const baseCount = node.kind === 'relation' ? 2 : 1;
  const count = node.kind === 'module'
    ? baseCount + savedCount
    : canAddInput
      ? baseCount + savedCount
      : (node.isRoot ? 0 : 1);
  let html = '<div class="graph-port-col graph-input-col">';
  const isAnyInput = node.kind === 'user' || node.kind === 'human_note' || node.kind === 'blank' || node.kind === 'knowledge';
  for (let i = 0; i < count; i++) {
    const label = node.kind === 'module' && i >= 1 ? '人工内容输入' : _nodeInputLabel(node);
    const anyClass = isAnyInput ? ' graph-port-any-input' : '';
    const portAttr = (canAddInput || isAnyInput) ? 'any' : attr.key;
    const portColor = isAnyInput ? '#94a3b8' : attr.color;
    const canRemove = (canAddInput || node.kind === 'module') && i >= baseCount;
    html += '<div class="graph-port graph-input-port' + anyClass + '" data-node-id="' + node.id + '" data-port-id="in-' + i + '" data-attribute="' + portAttr + '" style="--port-color:' + portColor + ';" title="' + (node.kind === 'user' || node.kind === 'human_note' || node.kind === 'knowledge' ? '任意输入端口：可连接任意来源' : '输入端口：拖到右侧输出可重连来源') + '">'
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
      { label: '我的回答', type: 'manual', branchType: 'manual', attribute: 'manual', group: 'manual', question: '' },
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
    // 配方节点（manual 底座）：声明了静态出口就替代默认 6 出口
    const recipePorts = node.recipeId && typeof _recipeStaticPorts === 'function' ? _recipeStaticPorts(node) : [];
    ports = recipePorts.length ? recipePorts : _answerOutputPorts(node, messages);
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
    }, {
      label: '我的总结',
      type: 'branch',
      branchType: 'note',
      attribute: 'note',
      question: '',
    }, {
      label: '追问',
      type: 'branch',
      branchType: 'followup',
      attribute: 'question',
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
  const canAddPort = _moduleCanExpandOutputs(node) || node.kind === 'source' || node.kind === 'knowledge';
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
      + (meta.dragCreates ? ' data-port-drag="' + encodeURIComponent(meta.dragCreates) + '"' : '')
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
  const meta = GRAPH_MODULE_META[node.moduleKey] || { label: node.moduleKey || 'AI 生成空白', color: attr.color };
  const attrClass = ' graph-attr-' + attr.key;
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const busyClass = node.busy ? ' graph-blank-busy' : '';
  const customWidth = node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '';
  const customHeight = node.customHeight
    ? 'min-height:' + node.customHeight + 'px !important;height:' + node.customHeight + 'px !important;'
    : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const content = _cleanBlankNodeContent(node, node.content || '');
  const contentHtml = content
    ? '<div class="graph-blank-content">' + (typeof renderMarkdown === 'function' ? renderMarkdown(content, { parentId: String(node.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(content)) + '</div>'
    : '';
  const generateLabel = content ? '重新生成' : '生成';
  const deleteBtn = '<button class="graph-node-delete-toggle" onclick="deleteBlankNode(\'' + node.id + '\')" title="删除空白节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  const pendingClass = _graphNodePending(node) ? ' graph-node-pending' : '';
  return '<div class="graph-node graph-node-blank graph-node-module graph-module-' + node.moduleKey + attrClass + selectedClass + busyClass + minimizedClass + pendingClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">AI 生成</span>' + _graphMinimizeToggleHtml(node) + deleteBtn + '</div>'
    + '<div class="graph-node-label">' + escapeHtml(meta.label) + '</div>'
    + contentHtml
    + (content ? '' : '<div class="graph-blank-hint">连上游（可选）→ 写要求 → 点生成</div>')
    + '<div class="graph-blank-requirement">'
    + '<textarea class="graph-blank-input" rows="2" placeholder="写要求，例如：写一个反例 / 用比喻解释 / 整理时间线" ' + (node.busy ? 'disabled' : '') + '>' + escapeHtml(node.requirements || '') + '</textarea>'
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
  // 配方声明 plain 载体（P1）：不解析 Markdown，纯转义渲染（human_note 同口径）
  if (node.recipeId && node.recipe && node.recipe.content_kind === 'plain') {
    return '<div class="graph-custom-node-render">' + escapeHtml(text) + '</div>';
  }
  if (typeof renderMarkdown === 'function') {
    // 传 parentId：自定义节点内容里的苏格拉底“我来回答”按钮需要能解析回父节点，
    // 否则回答生成的新节点会成为无连线的孤儿（_findCustomBranchParent 按 timestamp 匹配）。
    return renderMarkdown(text, { parentId: String(node.timestamp || ''), sourceModule: node.moduleKey || '' });
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
    if (typeof _initVizIframes === 'function') _initVizIframes(nextEl);
    if (typeof renderMath === 'function') renderMath(nextEl);
    if (node && node.kind === 'module' && node.moduleKey === 'graph' && typeof renderMermaidInElement === 'function') {
      setTimeout(() => { renderMermaidInElement(nextEl).catch(() => {}); }, 60);
    }
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
  if (node.status === 'blocked') return '上游缺失';
  if (node.status === 'waiting') return '等待输入';
  if (node.status === 'error') return '失败';
  if (node.status === 'done' || ((node.content || '').trim() && !node.status)) return '完成';
  return '待生成';
}

// 状态徽章。blocked 是任务列表带来的新状态（用户 2026-09-27 拍板 #10）：它上游的节点
// 被停掉或失败了，内容永远凑不齐——徽章只放得下四个字，完整说法挂在 title 上。
function _customNodeStatusHtml(node, force) {
  if (!node) return '';
  if (!force && node.messageIndex >= 0) return '';
  const statusText = _customNodeStatusText(node);
  if (!statusText) return '';
  const stateKey = node.busy ? 'running' : (node.status || 'empty');
  const title = stateKey === 'blocked' ? ' title="上游缺失，无法生成"' : '';
  return '<span class="graph-node-status status-' + stateKey + '"' + title + '>' + escapeHtml(statusText) + '</span>';
}

function _canMinimizeGraphNode(node) {
  if (!node) return false;
  if (node.kind === 'draft' || node.kind === 'ai_eval' || node.kind === 'relation') return false;
  if (node.kind === 'blank' || node.kind === 'source' || node.kind === 'knowledge' || node.kind === 'human_note') return true;
  return node.kind === 'module' || node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note' || node.kind === 'hub';
}

function _graphMinimizeToggleHtml(node) {
  if (!_canMinimizeGraphNode(node)) return '';
  return '<button class="graph-node-minimize-toggle" onclick="graphModuleAction(\'minimize\',\'' + node.id + '\')" title="' + (node.minimized ? '展开' : '最小化') + '">' + (node.minimized ? '+' : '−') + '</button>';
}

// 还没出内容的大卡（空白/模块/总结/汇聚）先按内容收缩，出内容后再撑回原尺寸。
// 与 graph-override.css「第 7 轮 7.2」配套；用户手动拖过尺寸的节点走内联样式，不受影响。
function _graphNodePending(node) {
  if (!node || node.messageIndex >= 0) return false;
  if (node.busy || node.status === 'running') return false;
  if (!['blank', 'module', 'summary', 'note', 'hub'].includes(node.kind)) return false;
  return !(String(node.content || '').trim() || String(node.analysis || '').trim() || String(node.summary || '').trim());
}

function _customNodeHeaderHtml(node, attr, extraButtons) {
  const sub = _nodeSub(node);
  const statusHtml = _customNodeStatusHtml(node);
  return '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>'
    + (sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '')
    + statusHtml
    + _graphMinimizeToggleHtml(node)
    + (extraButtons || '')
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>'
    + '</div>';
}

function _renderSourceNodeHtml(node, state) {
  const attr = _nodeAttribute(node);
  const selectedClass = graphView.selectedNodeIds.has(node.id) ? ' selected' : '';
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : (node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '');
  const fileName = node.fileName ? '<div class="graph-source-filename">' + escapeHtml(node.fileName) + '</div>' : '';
  const itemCount = node.items && node.items.length ? '<div class="graph-source-count">' + node.items.length + ' 个知识点</div>' : '';
  const body = node.busy
    ? '<div class="graph-source-busy"><span class="graph-source-spinner"></span>正在解析文件...</div>'
    : '<div class="graph-source-body" ondragover="event.preventDefault();this.classList.add(\'graph-source-drag\')" ondragleave="this.classList.remove(\'graph-source-drag\')" ondrop="handleSourceNodeDrop(event,\'' + node.id + '\')">'
      + '<label class="graph-source-file-btn">选择/拖入文件<input type="file" class="graph-source-file-input" onchange="handleSourceNodeFile(this,\'' + node.id + '\')"></label>'
      + '<textarea class="graph-source-text-input" rows="2" placeholder="或直接粘贴文本/题目/讲义内容..."></textarea>'
      + '<button type="button" class="graph-source-paste-btn" onclick="pasteSourceNodeText(\'' + node.id + '\')">粘贴文本解析</button>'
      + '<div class="graph-source-controls"><label>最多 <input type="number" class="graph-source-max-input" min="1" max="50" value="' + (node.maxItems || 5) + '" onchange="updateSourceNodeMax(\'' + node.id + '\',this.value)"></label>'
      + (node.fileId ? _iconRegenButton('reparseSourceNode(\'' + node.id + '\')', '重新解析', false) : '')
      + (node.items && node.items.length ? '<button type="button" class="graph-source-organize-btn" onclick="openHarnessOrganizeRelations(\'' + node.id + '\')">🤖 AI 整理关系</button>' : '')
      + '</div>' + fileName + itemCount
      + '</div>';
  return '<div class="graph-node graph-node-source graph-attr-source' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
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
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : (node.customWidth ? 'width:' + node.customWidth + 'px !important;min-width:' + node.customWidth + 'px !important;max-width:' + node.customWidth + 'px !important;' : '');
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
  return '<div class="graph-node graph-node-knowledge graph-attr-knowledge' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
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
  const statusHtml = _customNodeStatusHtml(node, true);
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
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  return '<div class="graph-node graph-node-human-note graph-attr-human_note' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header">'
    + '<span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">我的理解</span>'
    + '<span class="graph-node-badge">人工</span>'
    // 三个按钮包一层：窄卡（260–340）里头部必然折行，整组一起折才不至于剩一个删除键孤零零挂在第二行
    + '<span class="graph-node-head-actions">'
    + _graphMinimizeToggleHtml(node)
    + '<button class="graph-node-edit-toggle" onclick="editHumanNoteNode(\'' + node.id + '\')" title="编辑我的理解"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></button>'
    + '</span>'
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

    // ====== 节点公式渲染记忆 ======
    // 全量重建（切会话/切回旧画布/撤销）会把每个节点 HTML 原样重建，然后 rAF 里对整图
    // 无条件跑 renderMath——切回看过的画布时，所有没变的节点都要重新铺一遍公式。
    // 按「节点 HTML 签名」缓存 KaTeX 铺完的 body 片段（_graphNodeHtmlSig 覆盖全部
    // HTML 相关输入：内容/标签/端口/尺寸/消息正文……内容一变键就变，天然失效，无需主动清）：
    // 命中直接铺定形 HTML（里面已无 $..$ 文本，后续整图 renderMath 对它是空扫描）；
    // 未命中走原路径并登记待回填，rAF 铺完公式后按签名回填缓存。
    // 三条硬边界：① body 含 <textarea / data-viz-id / <iframe 不缓存——用户可编辑态与
    // viz 槽位是有状态 DOM（viz 内容还在 _vizStore 里，会被 prune）；② KaTeX 未就绪
    // （window.renderMathInElement 缺失，app.js 先于 defer 厂商库执行的首帧）不缓存——
    // 防把未渲染中间态钉进缓存；③ 单条 >256KB 不缓存，LRU 上限 200 条防内存失控。
    const _NODE_BODY_CACHE_MAX = 200;
    const _nodeBodyKatexCache = new Map();
    let _katexPendingCaptures = []; // [{id, sig}] 本轮全量重建中「待回填」的节点
    function _nodeBodyKatexGet(sig) {
      if (!_nodeBodyKatexCache.has(sig)) return null;
      const v = _nodeBodyKatexCache.get(sig);
      _nodeBodyKatexCache.delete(sig);
      _nodeBodyKatexCache.set(sig, v); // Map 插入序即 LRU 序：命中挪到最新端
      return v;
    }
    function _nodeBodyKatexPut(sig, html) {
      if (!window.renderMathInElement || !html || html.length > 262144) return;
      if (/<textarea|data-viz-id|<iframe/i.test(html)) return;
      if (_nodeBodyKatexCache.has(sig)) _nodeBodyKatexCache.delete(sig);
      _nodeBodyKatexCache.set(sig, html);
      while (_nodeBodyKatexCache.size > _NODE_BODY_CACHE_MAX) {
        _nodeBodyKatexCache.delete(_nodeBodyKatexCache.keys().next().value);
      }
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
  const badge = node.isRoot ? '核心问题' : (node.isBranch ? '延伸追问' : (node.kind === 'answer' ? (node.manual ? '我的回答' : 'AI 回答簇') : ''));
  const badgeHtml = badge ? '<span class="graph-node-badge">' + escapeHtml(badge) + '</span>' : '';
  const label = node.recipeId && node.recipe && node.recipe.name
    ? node.recipe.name
    : node.kind === 'module'
    ? ((GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey)
    : node.kind === 'hub'
      ? '汇聚'
      : node.kind === 'summary'
        ? 'AI 总结'
        : node.kind === 'note'
          ? '我的总结'
          : (node.kind === 'answer' && node.messageIndex < 0
            ? (node.manual ? '我的回答' : 'AI 回答')
            : (node.label || _nodeContent(message, node)));
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
  let body = node.kind === 'module'
    ? (customBody || (typeof renderMarkdown === 'function' ? renderMarkdown(_nodeContent(message, node), { parentId: String(message.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(_nodeContent(message, node))))
    : ((node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note') ? customBody : '');
  // 渲染记忆：命中直接铺上次定形的 body；未命中登记待回填（textarea/viz 有状态不登记）
  if (body) {
    const _bodySig = _graphNodeHtmlSig(node, messages, state);
    const _cachedBody = _nodeBodyKatexGet(_bodySig);
    if (_cachedBody != null) body = _cachedBody;
    else if (!/<textarea|data-viz-id|<iframe/i.test(body)) _katexPendingCaptures.push({ id: node.id, sig: _bodySig });
  }
  const sub = _nodeSub(node);
  const subHtml = sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '';
  const statusHtml = _customNodeStatusHtml(node);
  const minimizeToggle = _graphMinimizeToggleHtml(node);
  const editBtn = node.kind === 'module'
    ? '<button class="graph-node-edit-toggle" onclick="editModuleNode(\'' + node.id + '\')" title="人工编辑模块"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
    : (((node.kind === 'summary' || node.kind === 'note') && !(node.messageIndex >= 0))
      ? '<button class="graph-node-edit-toggle" onclick="editCustomNodeContent(\'' + node.id + '\')" title="编辑总结内容"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg></button>'
      : '');
  const deleteAction = node.messageIndex < 0
    ? 'deleteCustomNode(\'' + node.id + '\')'
    : 'graphModuleAction(\'delete\',\'' + node.id + '\')';
  const deleteBtn = node.isRoot ? '' : '<button class="graph-node-delete-toggle" onclick="' + deleteAction + '" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  const quickConnectBtn = node.kind === 'hub'
    ? '<button class="graph-hub-connect-btn" onclick="event.stopPropagation();quickConnectToHub(\'' + node.id + '\')" title="一键接入选中节点输出"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22v-5"></path><path d="M9 8V2"></path><path d="M15 8V2"></path><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"></path></svg></button>'
    : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const pendingClass = _graphNodePending(node) ? ' graph-node-pending' : '';
  const graphState = state || _graphState();
  const inputHtml = _renderInputPorts(node, graphState);
  const outputHtml = _renderOutputPorts(node, messages, graphState);
  const labelHtml = (node.kind === 'user' && node.messageIndex < 0)
    ? '<textarea class="graph-custom-question-input" rows="2" placeholder="输入问题..." onchange="updateCustomNodeContent(\'' + node.id + '\', this.value)">' + escapeHtml(label) + '</textarea>'
    : '<div class="graph-node-label">' + escapeHtml(label) + '</div>';
  return '<div class="' + baseClass + modClass + attrClass + rootClass + branchClass + selectedClass + dimmedClass + minimizedClass + resizedClass + pendingClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
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
  // 一次 querySelectorAll 建 id->元素映射：旧实现对每个节点各做一次全子树
  // querySelector（O(n²) 次子树扫描）。同时读写分离——矩形读取（触发布局）全部
// 先做完，zigzag 等写操作挪到后面，不再每节点交替「写样式→读矩形」强制重排。
  const elById = new Map();
  graphInner.querySelectorAll('.graph-node[data-node-id]').forEach(el => {
    elById.set(el.dataset.nodeId, el);
  });
  const zigzagNodes = [];
  graphView.nodes.forEach(node => {
    const el = elById.get(String(node.id));
    if (!el) return;
    const r = el.getBoundingClientRect();
    node.w = r.width / (graphView.zoom || 1);
    node.h = r.height / (graphView.zoom || 1);
    if (node.kind === 'ai_eval') zigzagNodes.push(node);
  });
  for (const node of zigzagNodes) _updateAiEvalZigzag(node);
  _syncGroupMembersByContainment();
}

function clearGraphDiffHighlights() {
  graphInner?.querySelectorAll('.graph-diff-add, .graph-diff-update, .graph-diff-delete').forEach(el => {
    el.classList.remove('graph-diff-add', 'graph-diff-update', 'graph-diff-delete');
  });
  graphCanvas?.querySelector('.graph-diff-ghost-layer')?.remove();
}

function applyGraphDiffHighlights(ops, history) {
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

  // 历史版本里有、当前版本已不存在（被删除/被移除）的节点与连线，
  // 当前画布渲染不出对应元素，需要以虚化“幽灵”标记补出来，让对比结果完整可见。
  if (history && history.state) {
    let oldData = null;
    try {
      oldData = _buildGraphData(history.messages || [], history.state);
    } catch (e) {
      oldData = null;
    }
    if (oldData) {
      const liveState = _graphState();
      const currentIds = new Set(graphView.nodes.map(n => String(n.id)));
      const currentKeys = new Set(graphView.edges.map(e => _edgeKey(e)));
      const hiddenNow = (liveState && liveState.hidden) || {};
      // _buildGraphData 只返回默认连线，需再用 _resolveGraphEdges 合并自定义联系，
      // 才能拿到历史版本的完整边集合（含用户新增/移除的联系箭头）。
      const oldEdges = _resolveGraphEdges(history.state, oldData.edges, oldData.nodeById);
      // 节点：历史里有、当前没有，且不是「当前只是被隐藏」→ 视为被删除的虚化节点
      const ghostNodes = oldData.nodes.filter(n => {
        if (currentIds.has(String(n.id))) return false;
        if (_graphDiffNodeHidden(hiddenNow, n)) return false;
        return true;
      });
      // 连线：历史里有、当前画布没有（其端点若在当前只被隐藏，则无法落点会被自动跳过）
      const ghostEdges = oldEdges.filter(e => !currentKeys.has(_edgeKey(e)));
      _renderGraphDiffGhost(ghostNodes, ghostEdges);
    }
  }
}

function _graphDiffGhostWidth(node) {
  const kind = node && node.kind;
  if (kind === 'hub' || kind === 'summary' || kind === 'note' || kind === 'knowledge' || kind === 'human_note' || kind === 'source') return 260;
  return 220;
}

// 画布 hidden 表可能用 node.id 或 “timestamp:kind” 两种键，这里统一判断当前是否被隐藏
function _graphDiffNodeHidden(hiddenMap, node) {
  if (!node) return false;
  const keys = [String(node.id)];
  const ts = node.timestamp != null ? String(node.timestamp) : '';
  if (node.kind === 'module' && node.moduleKey) keys.push(ts + ':' + node.moduleKey);
  if (node.kind === 'answer') keys.push(ts + ':answer');
  return keys.some(key => !!hiddenMap[key]);
}

function _graphDiffGhostTranslate(node, state) {
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const width = node.w || node.customWidth || _graphDiffGhostWidth(node);
  const height = node.h || node.customHeight || 72;
  return 'translate(' + (pan.x + (node.x - width / 2) * zoom) + 'px, '
    + (pan.y + (node.y - height / 2) * zoom) + 'px)';
}

function _graphDiffGhostPath(edge, ghostById, state) {
  const from = graphView.nodeById?.[edge.from] || ghostById.get(edge.from);
  const to = graphView.nodeById?.[edge.to] || ghostById.get(edge.to);
  if (!from || !to) return '';
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const fromWidth = from.w || from.customWidth || _graphDiffGhostWidth(from);
  const toWidth = to.w || to.customWidth || _graphDiffGhostWidth(to);
  const x1 = pan.x + (from.x + fromWidth / 2) * zoom;
  const y1 = pan.y + from.y * zoom;
  const x2 = pan.x + (to.x - toWidth / 2) * zoom;
  const y2 = pan.y + to.y * zoom;
  const offset = Math.max(60, Math.min(180, Math.abs(x2 - x1) * 0.45));
  return 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1)
    + ' C' + (x1 + offset).toFixed(1) + ' ' + y1.toFixed(1)
    + ', ' + (x2 - offset).toFixed(1) + ' ' + y2.toFixed(1)
    + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1);
}

function _renderGraphDiffGhost(ghostNodes, ghostEdges) {
  if (!graphCanvas) return;
  graphCanvas.querySelector('.graph-diff-ghost-layer')?.remove();
  const nodes = Array.isArray(ghostNodes) ? ghostNodes : [];
  const edges = Array.isArray(ghostEdges) ? ghostEdges : [];
  if (!nodes.length && !edges.length) return;
  const state = _graphState();
  const layer = document.createElement('div');
  layer.className = 'graph-diff-ghost-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-diff-ghost-layer-edges');
  layer.appendChild(svg);
  const ghostById = new Map(nodes.map(node => [node.id, node]));
  edges.forEach(edge => {
    const d = _graphDiffGhostPath(edge, ghostById, state);
    if (!d) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'graph-diff-ghost-edge');
    path.setAttribute('data-diff-ghost-edge', _edgeKey(edge));
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  nodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'graph-diff-ghost-node';
    el.dataset.ghostNodeId = node.id;
    const width = node.w || node.customWidth || _graphDiffGhostWidth(node);
    el.style.width = Math.max(160, width * (state.zoom || 0.9)) + 'px';
    el.style.transform = _graphDiffGhostTranslate(node, state);
    const label = String((node && (node.label || node.title || node.content)) || node.id || '节点');
    el.innerHTML = '<span class="graph-diff-ghost-badge">该版本存在</span>'
      + '<span class="graph-diff-ghost-label">' + escapeHtml(label) + '</span>';
    layer.appendChild(el);
  });
  graphCanvas.appendChild(layer);
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
  const layer = document.createElement('div');
  layer.className = 'graph-harness-preview-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-harness-preview-layer-edges');
  layer.appendChild(svg);
  const previewById = new Map(graphView.previewNodes.map(node => [node.id, node]));

  graphView.previewEdges.forEach(edge => {
    const d = _harnessPreviewEdgePath(edge, previewById, state);
    if (!d) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'graph-harness-preview-edge');
    path.setAttribute('data-preview-edge', _edgeKey(edge));
    path.setAttribute('d', d);
    svg.appendChild(path);
  });

  graphView.previewNodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'graph-harness-preview-node' + (node.kind === 'ai_eval' ? ' graph-harness-preview-eval' : '');
    el.dataset.previewId = node.id;
    const width = node.w || 220;
    const height = node.h || 80;
    el.style.width = Math.max(160, width * (state.zoom || 0.9)) + 'px';
    el.style.transform = _harnessPreviewNodeTranslate(node, state);
    el.innerHTML = '<span class="graph-harness-preview-badge">待确认</span>'
      + '<span class="graph-harness-preview-label">' + escapeHtml(node.label || '新节点') + '</span>';
    const startDrag = event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      el._harnessDrag = {
        node,
        zoom: state.zoom || 0.9,
        startX: node.x,
        startY: node.y,
        startClientX: event.clientX,
        startClientY: event.clientY,
      };
      el.classList.add('dragging');
      try { el.setPointerCapture(event.pointerId); } catch (e) {}
    };
    const moveDrag = event => {
      const drag = el._harnessDrag;
      if (!drag) return;
      event.stopPropagation();
      event.preventDefault();
      drag.node.x = drag.startX + (event.clientX - drag.startClientX) / drag.zoom;
      drag.node.y = drag.startY + (event.clientY - drag.startClientY) / drag.zoom;
      _updateHarnessPreviewPositions();
    };
    const endDrag = event => {
      if (!el._harnessDrag) return;
      event.stopPropagation();
      el.classList.remove('dragging');
      el._harnessDrag = null;
    };
    el.addEventListener('pointerdown', startDrag);
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    layer.appendChild(el);
  });
  graphCanvas.appendChild(layer);
}

function _harnessPreviewEdgePath(edge, previewById, state) {
  const from = graphView.nodeById[edge.from] || previewById.get(edge.from);
  const to = graphView.nodeById[edge.to] || previewById.get(edge.to);
  if (!from || !to) return '';
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const fromWidth = from.w || 220;
  const toWidth = to.w || 220;
  const x1 = pan.x + (from.x + fromWidth / 2) * zoom;
  const y1 = pan.y + from.y * zoom;
  const x2 = pan.x + (to.x - toWidth / 2) * zoom;
  const y2 = pan.y + to.y * zoom;
  const offset = Math.max(60, Math.min(180, Math.abs(x2 - x1) * 0.45));
  return 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1)
    + ' C' + (x1 + offset).toFixed(1) + ' ' + y1.toFixed(1)
    + ', ' + (x2 - offset).toFixed(1) + ' ' + y2.toFixed(1)
    + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1);
}

function _harnessPreviewNodeTranslate(node, state) {
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const width = node.w || 220;
  const height = node.h || 80;
  return 'translate(' + (pan.x + (node.x - width / 2) * zoom) + 'px, '
    + (pan.y + (node.y - height / 2) * zoom) + 'px)';
}

function _updateHarnessPreviewPositions() {
  if (!graphCanvas) return;
  const state = _graphState();
  const previewById = new Map(graphView.previewNodes.map(node => [node.id, node]));
  graphCanvas.querySelectorAll('.graph-harness-preview-node').forEach(el => {
    const node = previewById.get(el.dataset.previewId);
    if (node) el.style.transform = _harnessPreviewNodeTranslate(node, state);
  });
  const svg = graphCanvas.querySelector('.graph-harness-preview-layer-edges');
  if (svg) {
    graphView.previewEdges.forEach(edge => {
      const d = _harnessPreviewEdgePath(edge, previewById, state);
      const path = svg.querySelector('[data-preview-edge="' + _edgeKey(edge) + '"]');
      if (path && d) path.setAttribute('d', d);
    });
  }
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
  _renderGraphHarnessPreview();
  _centerGraphOnPreview();
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

// ===== 拖拽流畅度：元素缓存与快速几何更新 =====
// 缓存按 graphInner 实例失效：全量重建（graphCanvas.innerHTML=''）会换掉
// graphInner，WeakMap 自动换新表；层内局部重建（_redrawEdges）只清 edges 表。
const _graphElCacheByInner = new WeakMap();

function _graphElCache() {
  if (!graphInner) return null;
  let cache = _graphElCacheByInner.get(graphInner);
  if (!cache) {
    cache = { nodes: new Map(), ports: new Map(), edges: new Map() };
    _graphElCacheByInner.set(graphInner, cache);
  }
  return cache;
}

function _graphNodeEl(id) {
  if (!graphInner) return null;
  const cache = _graphElCache();
  let el = cache.nodes.get(id);
  if (el && el.isConnected) return el;
  el = graphInner.querySelector('[data-node-id="' + id + '"]');
  if (el) cache.nodes.set(id, el); else cache.nodes.delete(id);
  return el || null;
}

function _graphPortEl(nodeId, portId) {
  if (!graphInner) return null;
  const cache = _graphElCache();
  const key = nodeId + ':' + portId;
  let el = cache.ports.get(key);
  if (el && el.isConnected) return el;
  el = graphInner.querySelector('[data-node-id="' + nodeId + '"][data-port-id="' + portId + '"]');
  if (el) cache.ports.set(key, el); else cache.ports.delete(key);
  return el || null;
}

function _updateNodeTransforms(onlyIds) {
  if (!graphInner) return;
  // onlyIds：拖拽时只写被拖节点的 transform（省掉全量 querySelector+写）；
  // 不传保持旧行为全量刷新（renderGraphCanvas、撤销等路径用）。
  const ids = (onlyIds && onlyIds.length) ? onlyIds : null;
  const list = ids || graphView.nodes.map(node => node.id);
  for (const id of list) {
    const node = graphView.nodeById[id];
    const el = _graphNodeEl(id);
    if (node && el) el.style.transform = 'translate(' + (node.x - (node.w || 0) / 2) + 'px, ' + (node.y - (node.h || 0) / 2) + 'px)';
  }
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

function _portAnchor(node, portEl, isOutput, innerRect) {
  if (portEl && graphInner) {
    const rect = portEl.getBoundingClientRect();
    // innerRect 由调用方一次读取传入（一帧一次布局读），不再每条边重复读
    const box = innerRect || graphInner.getBoundingClientRect();
    const zoom = graphView.zoom || 1;
    return {
      x: (rect.left + rect.width / 2 - box.left) / zoom,
      y: (rect.top + rect.height / 2 - box.top) / zoom,
    };
  }
  const halfW = (node.w || 120) / 2;
  return {
    x: node.x + (isOutput ? halfW : -halfW),
    y: node.y,
  };
}

// 边路径 d 属性的唯一拼装（全量重建与拖拽快速路径共用，保证形状一致）
function _edgePathD(p1, p2, cp) {
  return 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + cp.c1x.toFixed(1) + ' ' + cp.c1y.toFixed(1)
    + ', ' + cp.c2x.toFixed(1) + ' ' + cp.c2y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
}

function _linkDragPathHtml(innerRect) {
  const drag = graphView.linkDrag;
  if (!drag || drag.currentX == null) return '';
  const sourceNode = graphView.nodeById[drag.nodeId];
  if (!sourceNode) return '';
  const sourceEl = _graphPortEl(drag.nodeId, drag.portId);
  const p1 = _portAnchor(sourceNode, sourceEl, drag.mode !== 'input', innerRect);
  const p2 = { x: drag.currentX, y: drag.currentY };
  const offset = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  const d = 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + (p1.x + offset).toFixed(1) + ' ' + p1.y.toFixed(1)
    + ', ' + (p2.x - offset).toFixed(1) + ' ' + p2.y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
  return '<path d="' + d + '" class="graph-edge graph-link-drag"></path>';
}

// 联系线控制点求解：优先用户自定义 curve（相对端点的偏移），否则默认横向贝塞尔
function _linkEdgeControlPoints(p1, p2, edge) {
  const curve = edge && edge.curve;
  if (curve && curve.shape === 'straight') {
    return {
      c1x: p1.x + (p2.x - p1.x) / 3,
      c1y: p1.y + (p2.y - p1.y) / 3,
      c2x: p1.x + (p2.x - p1.x) * 2 / 3,
      c2y: p1.y + (p2.y - p1.y) * 2 / 3,
    };
  }
  if (curve && Number.isFinite(curve.dx1) && Number.isFinite(curve.dy1)
    && Number.isFinite(curve.dx2) && Number.isFinite(curve.dy2)) {
    return {
      c1x: p1.x + curve.dx1,
      c1y: p1.y + curve.dy1,
      c2x: p2.x + curve.dx2,
      c2y: p2.y + curve.dy2,
    };
  }
  const o = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  return { c1x: p1.x + o, c1y: p1.y, c2x: p2.x - o, c2y: p2.y };
}

function _linkDefaultCurveOffsets(p1, p2) {
  const o = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  return { dx1: o, dy1: 0, dx2: -o, dy2: 0 };
}

function _redrawEdges() {
  if (!graphEdgeLayer) return;
  // 布局读一次（graphInner 的 rect），整批边共用——不再每条边读两次
  const innerRect = graphInner ? graphInner.getBoundingClientRect() : null;
  const defs = '<defs><marker id="graph-link-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="graph-edge-link-arrow"></path></marker></defs>';
  const html = graphView.edges.map(edge => {
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) return '';
    const sourceEl = _graphPortEl(edge.from, edge.fromPort);
    const targetEl = _graphPortEl(edge.to, edge.toPort);
    const p1 = _portAnchor(a, sourceEl, true, innerRect);
    const p2 = _portAnchor(b, targetEl, false, innerRect);
    const cp = _linkEdgeControlPoints(p1, p2, edge);
    const d = _edgePathD(p1, p2, cp);
    const isLink = !!edge.link;
    const cls = 'graph-edge' + (edge.custom ? ' graph-edge-custom' : '') + (isLink ? ' graph-edge-link' : '')
      + (isLink && graphView.edgeCurveEditKey === _edgeKey(edge) ? ' graph-edge-editing' : '');
    const arrow = isLink ? String(edge.arrow || 'right') : '';
    let markerStart = '';
    let markerEnd = '';
    if (isLink) {
      if (arrow === 'left' || arrow === 'both') markerStart = ' marker-start="url(#graph-link-arrow)"';
      if (arrow === 'right' || arrow === 'both') markerEnd = ' marker-end="url(#graph-link-arrow)"';
    }
    // 联系线的宽透明命中路径：细线难点，加一条便于点选/双击
    const hitHtml = isLink
      ? '<path class="graph-edge-hit" pointer-events="stroke" d="' + d + '"></path>'
      : '';
    let handlesHtml = '';
    if (isLink && graphView.edgeCurveEditKey === _edgeKey(edge)) {
      handlesHtml = '<line class="graph-edge-guide" x1="' + p1.x.toFixed(1) + '" y1="' + p1.y.toFixed(1) + '" x2="' + cp.c1x.toFixed(1) + '" y2="' + cp.c1y.toFixed(1) + '"></line>'
        + '<line class="graph-edge-guide" x1="' + p2.x.toFixed(1) + '" y1="' + p2.y.toFixed(1) + '" x2="' + cp.c2x.toFixed(1) + '" y2="' + cp.c2y.toFixed(1) + '"></line>'
        // 每个手柄配一个更大的隐形命中圆，缩放后也容易抓到
        + '<circle class="graph-curve-knob-hit" data-edge-key="' + _edgeKey(edge) + '" data-handle="c1" cx="' + cp.c1x.toFixed(1) + '" cy="' + cp.c1y.toFixed(1) + '" r="16" pointer-events="all"></circle>'
        + '<circle class="graph-curve-knob-hit" data-edge-key="' + _edgeKey(edge) + '" data-handle="c2" cx="' + cp.c2x.toFixed(1) + '" cy="' + cp.c2y.toFixed(1) + '" r="16" pointer-events="all"></circle>'
        + '<circle class="graph-edge-handle" data-edge-key="' + _edgeKey(edge) + '" data-handle="c1" cx="' + cp.c1x.toFixed(1) + '" cy="' + cp.c1y.toFixed(1) + '" r="9"></circle>'
        + '<circle class="graph-edge-handle" data-edge-key="' + _edgeKey(edge) + '" data-handle="c2" cx="' + cp.c2x.toFixed(1) + '" cy="' + cp.c2y.toFixed(1) + '" r="9"></circle>';
    }
    const label = (edge.relation || edge.label || '').toString().trim();
    let labelHtml = '';
    if (isLink && label) {
      const c1 = { x: cp.c1x, y: cp.c1y };
      const c2 = { x: cp.c2x, y: cp.c2y };
      const mx = (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8;
      const my = (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8;
      const textW = Array.from(label).length * 12 + 16;
      labelHtml = '<g class="graph-edge-link-label-group" data-edge-key="' + _edgeKey(edge) + '">'
        + '<rect class="graph-edge-link-bg" x="' + (mx - textW / 2).toFixed(1) + '" y="' + (my - 15.5).toFixed(1) + '" width="' + textW.toFixed(1) + '" height="17" rx="8.5"></rect>'
        + '<text class="graph-edge-label graph-edge-link-label" x="' + mx.toFixed(1) + '" y="' + (my - 2.5).toFixed(1) + '" text-anchor="middle" data-edge-key="' + _edgeKey(edge) + '">' + escapeHtml(label) + '</text>'
        + '</g>';
    }
    const hintHtml = label && !isLink
      ? '<title>' + escapeHtml(label) + '</title>'
      : '';
    return '<g class="' + cls + '" data-edge-key="' + _edgeKey(edge) + '" title="双击删除连线">'
      + hitHtml
      + '<path d="' + d + '"' + markerStart + markerEnd + '></path>'
      + labelHtml
      + handlesHtml
      + hintHtml
      + '</g>';
  }).join('');
  graphEdgeLayer.innerHTML = defs + html + _linkDragPathHtml(innerRect);
  // 全量重建后旧边元素全部失效：清边缓存与联系线拖拽路径缓存
  const cache = _graphElCache();
  if (cache) cache.edges.clear();
  _linkDragPathEl = null;
}

// ===== 拖拽快速路径：只改被涉及边的 d/标签位置，不重建 SVG 子树 =====
// 返回 false 表示结构不在缓存里（新边/未渲染/曲线编辑中），调用方退回 _redrawEdges 全量。

let _linkDragPathEl = null;

function _refreshLinkDragPath() {
  const drag = graphView.linkDrag;
  if (!drag || drag.currentX == null || !graphEdgeLayer) return false;
  if (!_linkDragPathEl || !_linkDragPathEl.isConnected) {
    _linkDragPathEl = graphEdgeLayer.querySelector('.graph-link-drag');
    if (!_linkDragPathEl) return false;
  }
  const sourceNode = graphView.nodeById[drag.nodeId];
  if (!sourceNode) return false;
  const innerRect = graphInner ? graphInner.getBoundingClientRect() : null;
  const p1 = _portAnchor(sourceNode, _graphPortEl(drag.nodeId, drag.portId), drag.mode !== 'input', innerRect);
  const p2 = { x: drag.currentX, y: drag.currentY };
  const offset = Math.max(50, Math.min(180, Math.abs(p2.x - p1.x) * 0.45));
  _linkDragPathEl.setAttribute('d', 'M' + p1.x.toFixed(1) + ' ' + p1.y.toFixed(1)
    + ' C' + (p1.x + offset).toFixed(1) + ' ' + p1.y.toFixed(1)
    + ', ' + (p2.x - offset).toFixed(1) + ' ' + p2.y.toFixed(1)
    + ', ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1));
  return true;
}

function _edgesTouchingNodeIds(ids) {
  const set = ids instanceof Set ? ids : new Set(ids);
  return graphView.edges
    .filter(edge => set.has(edge.from) || set.has(edge.to))
    .map(edge => _edgeKey(edge));
}

function _refreshEdgeGeometry(edgeKeys) {
  if (!graphEdgeLayer || !graphInner) return false;
  const cache = _graphElCache();
  if (!cache) return false;
  const keySet = new Set(edgeKeys);
  // 曲线编辑手柄也依赖端点坐标，走全量保证 guides/knobs 一起更新
  if (graphView.edgeCurveEditKey && keySet.has(graphView.edgeCurveEditKey)) return false;
  const innerRect = graphInner.getBoundingClientRect();
  for (const edge of graphView.edges) {
    const key = _edgeKey(edge);
    if (!keySet.has(key)) continue;
    const a = graphView.nodeById[edge.from];
    const b = graphView.nodeById[edge.to];
    if (!a || !b) continue;
    let entry = cache.edges.get(key);
    if (!entry || !entry.g || !entry.g.isConnected) {
      const g = graphEdgeLayer.querySelector('[data-edge-key="' + key + '"]');
      if (!g) return false;
      entry = {
        g,
        path: g.querySelector('path:not(.graph-edge-hit)'),
        hit: g.querySelector('.graph-edge-hit'),
        labelBg: g.querySelector('.graph-edge-link-label-group > .graph-edge-link-bg'),
        labelText: g.querySelector('.graph-edge-link-label-group > text'),
      };
      cache.edges.set(key, entry);
    }
    const p1 = _portAnchor(a, _graphPortEl(edge.from, edge.fromPort), true, innerRect);
    const p2 = _portAnchor(b, _graphPortEl(edge.to, edge.toPort), false, innerRect);
    const cp = _linkEdgeControlPoints(p1, p2, edge);
    const d = _edgePathD(p1, p2, cp);
    if (entry.path) entry.path.setAttribute('d', d);
    if (entry.hit) entry.hit.setAttribute('d', d);
    if (entry.labelBg && entry.labelText) {
      const label = (edge.relation || edge.label || '').toString().trim();
      const mx = (p1.x + 3 * cp.c1x + 3 * cp.c2x + p2.x) / 8;
      const my = (p1.y + 3 * cp.c1y + 3 * cp.c2y + p2.y) / 8;
      const textW = Array.from(label).length * 12 + 16;
      entry.labelBg.setAttribute('x', (mx - textW / 2).toFixed(1));
      entry.labelBg.setAttribute('y', (my - 15.5).toFixed(1));
      entry.labelText.setAttribute('x', mx.toFixed(1));
      entry.labelText.setAttribute('y', (my - 2.5).toFixed(1));
    }
  }
  return true;
}

function _savePositions() {
  _syncGroupMembersByContainment();
  const state = _graphState();
  state.layoutVersion = LAYOUT_VERSION;
  state.positions = state.positions || {};
  state.sizes = state.sizes || {};
  graphView.nodes.forEach(n => {
    state.positions[n.id] = n.pinned && n.fixedX != null ? { x: n.fixedX, y: n.fixedY } : { x: n.x, y: n.y };
    // u=1 只认「用户手动拖过尺寸」这一个信号（_applyPointerDrag 里设置），
    // 绝不由 customHeight 反推——否则历史污染值会被当成用户意图永久冻结。
    // 旧数据无 u 字段 → 全部回到自适应，这是有意的自愈。
    state.sizes[n.id] = {
      w: n.customWidth || n.w || 120,
      h: n.customHeight || n.h || 60,
      u: n.userResized ? 1 : 0,
    };
  });
  state.groups = graphView.groups.map(group => ({ ...group }));
  // custom 节点高度不持久化（除非用户手动拖过）：创建期高度一律为 null，
  // 任何非零值都是「测量值被兜底成 custom」的历史污染——留着就会冻死节点。
  // userResized 标记随 spread 一起持久化，重载后仍能认出手动尺寸。
  state.customNodes = graphView.nodes
    .filter(node => node.messageIndex < 0 && GRAPH_CUSTOM_NODE_KINDS.includes(node.kind))
    .map(node => {
      const copy = { ...node };
      if (!copy.userResized) copy.customHeight = null;
      return copy;
    });
  _saveGraphState(state);
  if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
}

function _tick() {
  const nodes = graphView.nodes;
  const edges = graphView.edges;
  if (!nodes.length) return 0;
  let totalMove = 0;

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
    // 联系箭头是纯视觉标注：不参与力学布局，避免自动整理时把两端节点拉近
    if (edge.link) continue;
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
    totalMove += Math.abs(n.vx) + Math.abs(n.vy);
  }
  return totalMove;
}

function _runLayout(needsFit) {
  if (!graphView.nodes.length) return;
  // 120 轮 × O(n²) 两两斥力在单帧内跑完，是打开大画布时首帧冻结的根源。
  // 按节点数压缩迭代上限（总工作量近似守恒），并在整体位移收敛后提前退出——
  // 中小图通常 40~60 轮就已静止；大图宁可布局粗一点，也不能把主线程卡住数秒。
  const n = graphView.nodes.length;
  const maxIter = n > 400 ? 30 : n > 150 ? 60 : MAX_ITERATIONS;
  let stagnant = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    const movement = _tick();
    if (movement < n * 0.05) {
      if (++stagnant >= 3) break;
    } else {
      stagnant = 0;
    }
  }
  _updateNodeTransforms();
  _fitAllGroupsToMembers();
  _redrawEdges();
  _savePositions();
  if (needsFit) fitGraph();
}

function _layoutNodeSize(node) {
  return {
    w: node.w || node.customWidth || 120,
    h: node.h || node.customHeight || 60,
  };
}

// 层级由连线的“父子”结构推导（不信任节点上硬编码的 depth）：
//   · 每个节点认第一条入边为父 → 构成一棵树（森林）；
//   · BFS 深度 = 根到该节点的边数 → 同一深度同一横坐标（x = depth*colGap）；
//   · 纵向用 tidy 中序排名 → 每个分支（如“物理视角 → 追问 → 追问回答 → 追问模块”）
//     占据一条连续纵带，物理的追问与数学的追问各自的走廊互不混杂，并随深度逐级右移。
function _arrangeTreeLayout(nodes, edges, colGap, rowUnit) {
  if (!nodes.length) return;
  const byId = {};
  nodes.forEach(n => { byId[n.id] = n; });
  const children = {};
  const parent = {};
  const portOf = {};
  nodes.forEach(n => { children[n.id] = []; });
  edges.forEach((e, ei) => {
    if (e.draft || e.link) return; // 忽略草稿与“联系”横连，避免串层
    const from = byId[e.from];
    const to = byId[e.to];
    if (!from || !to) return;
    if (parent[to.id] == null) { // 每个节点只认第一条入边，保证无环森林
      parent[to.id] = from.id;
      portOf[to.id] = e.fromPort || ei;
    }
  });
  nodes.forEach(n => {
    if (parent[n.id] != null) children[parent[n.id]].push(n.id);
  });

  const parentless = nodes.filter(n => parent[n.id] == null);
  let roots = parentless.filter(n => n.isRoot);
  if (!roots.length) roots = parentless.filter(n => n.kind === 'user');
  if (!roots.length) roots = parentless.slice();

  // BFS 深度
  const depth = {};
  const queue = [];
  roots.forEach(r => { depth[r.id] = 0; queue.push(r.id); });
  while (queue.length) {
    const id = queue.shift();
    (children[id] || []).forEach(cid => {
      if (depth[cid] == null) { depth[cid] = depth[id] + 1; queue.push(cid); }
    });
  }
  let maxDepth = 0;
  nodes.forEach(n => { if (depth[n.id] != null && depth[n.id] > maxDepth) maxDepth = depth[n.id]; });

  // tidy 中序排名：叶节点顺序编号，内部节点取子节点排名中点 → 纵向坐标
  const rank = {};
  let leafCounter = 0;
  function visit(id) {
    const kids = (children[id] || []).map(cid => ({ id: cid })).sort((a, b) => {
      const pa = String(portOf[a.id] != null ? portOf[a.id] : a.id);
      const pb = String(portOf[b.id] != null ? portOf[b.id] : b.id);
      const d = pa.localeCompare(pb, undefined, { numeric: true });
      return d || (byId[a.id].timestamp || 0) - (byId[b.id].timestamp || 0);
    });
    if (!kids.length) { rank[id] = leafCounter++; return rank[id]; }
    let lo = Infinity;
    let hi = -Infinity;
    kids.forEach(k => {
      const rk = visit(k.id);
      if (rk < lo) lo = rk;
      if (rk > hi) hi = rk;
    });
    rank[id] = (lo + hi) / 2;
    return rank[id];
  }
  roots.forEach(r => visit(r.id));

  const miscNodes = nodes.filter(n => rank[n.id] == null);
  const totalLeaves = leafCounter || 1;
  const nodeDepthOf = n => (depth[n.id] != null ? depth[n.id] : maxDepth + 1);

  // 自适应列宽：统计每列最大节点宽度，列中心 x 按“前一列最大宽/2 + 本列最大宽/2 + 边距”累进。
  // 小列保持约 colGap(420) 的默认间距；宽模块/巨可视化所在列自动加宽，跨列不再压叠，
  // 且不放大其它列 —— 修掉“巨节点把同簇组框撑大、把相邻游离节点挤进边界”的残留。
  const colMaxW = {};
  nodes.forEach(n => {
    const dd = nodeDepthOf(n);
    const w = _layoutNodeSize(n).w;
    colMaxW[dd] = Math.max(colMaxW[dd] || 0, w);
  });
  const colX = {};
  const cols = Object.keys(colMaxW).map(Number).sort((a, b) => a - b);
  cols.forEach((d, idx) => {
    if (idx === 0) { colX[d] = 0; return; }
    const prevD = cols[idx - 1];
    colX[d] = colX[prevD] + Math.max(colGap, (colMaxW[prevD] || 0) / 2 + (colMaxW[d] || 0) / 2 + 48);
  });

  nodes.forEach(n => {
    if (rank[n.id] == null) return;
    n.x = colX[nodeDepthOf(n)];
    n.y = (rank[n.id] - (totalLeaves - 1) / 2) * rowUnit;
  });
  // 游离/杂散节点（无父边且非主根，或仅被杂散节点引用）→ 最右侧竖排
  if (miscNodes.length) {
    const miscX = colX[maxDepth + 1] || 0;
    miscNodes.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    const startY = -((miscNodes.length - 1) / 2) * rowUnit;
    miscNodes.forEach((node, i) => {
      node.x = miscX;
      node.y = startY + i * rowUnit;
    });
  }

  // 同列纵向自适应：同一列（同一 x）成员按 tidy 顺序排列，间距按“半高之和+边距”撑开，
  // 让高模块/大可视化节点只撑开它所在那一列，不放大其它列间距，且保持走廊的纵向顺序。
  _resolveColumnVerticalSpacing(nodes, 48);
}

// 同列节点纵向防重叠：按当前 y 排序（≈tidy 顺序），相邻两节点之间强制满足
// (h_a+h_b)/2 + gap 的垂直间距，迭代至收敛；顺序不变、走廊排序不破坏，仅撑开同列间距。
function _resolveColumnVerticalSpacing(nodes, gap) {
  const cols = {};
  nodes.forEach(n => { const c = Math.round(n.x); (cols[c] = cols[c] || []).push(n); });
  Object.keys(cols).forEach(c => {
    const list = cols[c].slice().sort((a, b) => a.y - b.y);
    if (list.length < 2) return;
    let guard = 0;
    while (guard++ < 100) {
      let moved = false;
      for (let k = 0; k < list.length - 1; k++) {
        const a = list[k];
        const b = list[k + 1];
        const minY = (a.h + b.h) / 2 + gap;
        const dy = b.y - a.y;
        if (dy < minY) {
          const push = (minY - dy) * 0.5;
          a.y -= push;
          b.y += push;
          moved = true;
        }
      }
      if (!moved) break;
    }
  });
}

// 分组：成员保持树状/走廊位置不再重排成网格，整组作为原子矩形交给碰撞处理。
function _groupBlockFor(group) {
  const members = (group.nodeIds || [])
    .map(id => graphView.nodeById[id])
    .filter(node => node && node.kind !== 'draft');
  if (!members.length) return null;
  const bounds = _graphGroupBounds(members.map(m => m.id));
  group.x = bounds.x;
  group.y = bounds.y;
  group.width = bounds.width;
  group.height = bounds.height;
  return {
    cx: bounds.x + bounds.width / 2,
    cy: bounds.y + bounds.height / 2,
    w: bounds.width,
    h: bounds.height,
    group,
    members,
  };
}

// 把自由节点与各分组块合成统一矩形碰撞集（大节点作为普通矩形参与局部让位）。
function _collectLayoutBlocks(freeNodes, groupBlocks) {
  const blocks = [];
  freeNodes.forEach(node => {
    const s = _layoutNodeSize(node);
    blocks.push({
      cx: node.x, cy: node.y, w: s.w, h: s.h,
      move: (dx, dy) => { node.x += dx; node.y += dy; },
    });
  });
  groupBlocks.forEach(gb => {
    blocks.push({
      cx: gb.cx, cy: gb.cy, w: gb.w, h: gb.h,
      move: (dx, dy) => {
        gb.group.x += dx;
        gb.group.y += dy;
        gb.members.forEach(m => { m.x += dx; m.y += dy; });
      },
    });
  });
  return blocks;
}

// 矩形重叠消除：自由节点与分组块一律可推（整理=全面重置，不保留固定），
// 分组之间、大节点与相邻列都不互相压叠；按“局部让位”推开，不放大全局间距。
function _resolveLayoutRectOverlaps(blocks, maxPasses) {
  const gap = 24;
  let pass = 0;
  while (pass < (maxPasses || 80)) {
    let moved = false;
    for (let i = 0; i < blocks.length; i++) {
      for (let j = i + 1; j < blocks.length; j++) {
        const a = blocks[i];
        const b = blocks[j];
        const dx = b.cx - a.cx;
        const dy = b.cy - a.cy;
        const minX = (a.w + b.w) / 2 + gap;
        const minY = (a.h + b.h) / 2 + gap;
        const ox = minX - Math.abs(dx);
        const oy = minY - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const sx = dx >= 0 ? 1 : -1;
        const sy = dy >= 0 ? 1 : -1;
        let pushX = 0;
        let pushY = 0;
        if (ox < oy) pushX = ox * 0.5;
        else pushY = oy * 0.5;
        a.cx -= sx * pushX; a.cy -= sy * pushY;
        b.cx += sx * pushX; b.cy += sy * pushY;
        if (a.move) a.move(-sx * pushX, -sy * pushY);
        if (b.move) b.move(sx * pushX, sy * pushY);
        moved = true;
      }
    }
    if (!moved) break;
    pass++;
  }
}

function autoArrangeGraph(preservePinned) {
  if (!graphView.nodes.length) return;
  _pushGraphUndo(false, { layout: true });
  _measureNodes();
  // 整理 = 全面重置：不保留手动固定/尺寸（保持原有语义）
  graphView.nodes.forEach(node => {
    node.pinned = false;
    node.fixedX = null;
    node.fixedY = null;
  });

  const COL_GAP = 420;   // 默认列间距档，不随大节点放大
  const ROW_STEP = 300;  // 默认行距档

  const groupOf = {};
  (graphView.groups || []).forEach(g => (g.nodeIds || []).forEach(id => { groupOf[id] = g; }));
  const usable = graphView.nodes.filter(node => node.kind !== 'draft');
  const usableIds = new Set(usable.map(n => n.id));

  // 1) 树状层级排布：层级=连线父子深度，追问逐级右移成分支走廊
  _arrangeTreeLayout(usable, graphView.edges, COL_GAP, ROW_STEP);

  // 2) 自由节点 + 分组块 统一矩形碰撞，避免组/大节点/相邻列互相压叠
  const freeNodes = usable.filter(n => !groupOf[n.id]);
  const groups = (graphView.groups || [])
    .filter(g => (g.nodeIds || []).some(id => usableIds.has(id)));
  const groupBlocks = groups.map(g => _groupBlockFor(g)).filter(Boolean);
  const blocks = _collectLayoutBlocks(freeNodes, groupBlocks);
  _resolveLayoutRectOverlaps(blocks, 80);

  // 3) 收尾：解固定、按最终成员重算组边界、落位
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

// 高倍缩放降级阈值：超过后图层纹理面积随 zoom 平方膨胀，重型特效（边光晕/节点投影/过渡）
// 极易耗尽显存，产生灰白瓦片伪影与卡顿。此时画布挂 .graph-heavy-zoom，由 CSS 关闭重型特效。
const GRAPH_HEAVY_ZOOM_THRESHOLD = 2.2;

function _applyGraphTransform() {
  if (!graphInner) return;
  const state = _graphState();
  graphInner.style.transform = 'translate(' + state.pan.x + 'px, ' + state.pan.y + 'px) scale(' + state.zoom + ')';
  graphView.zoom = state.zoom;
  if (typeof graphCanvas !== 'undefined' && graphCanvas) {
    graphCanvas.classList.toggle('graph-heavy-zoom', (state.zoom || 1) > GRAPH_HEAVY_ZOOM_THRESHOLD);
  }
  if (graphView.previewNodes.length || graphView.previewEdges.length) _renderGraphHarnessPreview();
}

// ===== 流式补丁的节点签名：内容没变的节点整体跳过 =====
// 旧行为每个补丁帧对每个节点都跑一次 _renderNodeHtml（内含完整 renderMarkdown）再逐段
// 字符串比对；流式期间通常只有一个节点在变，其余全是白算。签名覆盖渲染 HTML 会用到的
// 全部输入（节点字段 + 该节点引用的消息正文/分支标签 + 该节点的端口计数）。
// x/y/w/h 故意不进签名：位置由 _updateNodeTransforms 负责、尺寸由 _measureNodes 负责，
// 与旧补丁路径「保留旧几何」的语义一致。签名存在节点对象上，全量重建换新对象自动失效。
function _graphNodeHtmlSig(node, messages, state) {
  const message = node.messageIndex >= 0 ? (messages || [])[node.messageIndex] : null;
  const parts = [
    node.id, node.kind, node.moduleKey, node.messageIndex, node.isRoot, node.isBranch,
    node.minimized, node.hidden, node.manual, node.busy, node.status,
    node.customWidth, node.customHeight, node.content, node.analysis, node.label, node.items,
    message ? message.content : null,
    message ? message.branchLabel : null,
    state.portCounts ? state.portCounts[node.id] : null,
    state.inputPortCounts ? state.inputPortCounts[node.id] : null,
  ];
  let sigSrc = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    sigSrc += '\u0001' + (p == null ? '' : (typeof p === 'object' ? JSON.stringify(p) : String(p)));
  }
  return _vizHash(sigSrc);
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
      const nextSig = _graphNodeHtmlSig(next, messages, state);
      if (old._patchSig === nextSig) {
        nextNodes.push(old);
        continue;
      }
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
      old._patchSig = nextSig;
      nextNodes.push(old);
    } else {
      graphInner.insertAdjacentHTML('beforeend', _renderNodeHtml(next, messages, state));
      next._patchSig = _graphNodeHtmlSig(next, messages, state);
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

