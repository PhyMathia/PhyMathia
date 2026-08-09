// ===== PhyMathia 知识网络画布：节点渲染、端口、高亮与布局 =====

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
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  const content = _cleanBlankNodeContent(node, node.content || '');
  const contentHtml = content
    ? '<div class="graph-blank-content">' + (typeof renderMarkdown === 'function' ? renderMarkdown(content, { sourceModule: node.moduleKey }) : escapeHtml(content)) + '</div>'
    : '';
  const generateLabel = content ? '重新生成' : '生成';
  const deleteBtn = '<button class="graph-node-delete-toggle" onclick="deleteBlankNode(\'' + node.id + '\')" title="删除空白节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>';
  return '<div class="graph-node graph-node-blank graph-node-module graph-module-' + node.moduleKey + attrClass + selectedClass + busyClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span><span class="graph-node-badge">空白节点</span>' + _graphMinimizeToggleHtml(node) + deleteBtn + '</div>'
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

function _customNodeHeaderHtml(node, attr, extraButtons) {
  const sub = _nodeSub(node);
  const statusText = node.messageIndex < 0 ? _customNodeStatusText(node) : '';
  const statusHtml = statusText
    ? '<span class="graph-node-status status-' + (node.busy ? 'running' : node.status || 'empty') + '">' + escapeHtml(statusText) + '</span>'
    : '';
  return '<div class="graph-node-header"><span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">' + escapeHtml(attr.label) + '</span>'
    + (sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '')
    + statusHtml
    + _graphMinimizeToggleHtml(node)
    + (extraButtons || '')
    + '<button class="graph-node-delete-toggle" onclick="deleteCustomNode(\'' + node.id + '\')" title="删除节点"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg></button>'
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
  const minimizedClass = node.minimized ? ' minimized' : '';
  const sizeStyle = node.minimized ? '' : customWidth + customHeight;
  return '<div class="graph-node graph-node-human-note graph-attr-human_note' + selectedClass + minimizedClass + '" data-node-id="' + node.id + '" style="transform:translate(' + node.x + 'px,' + node.y + 'px);--node-attr:' + attr.color + ';' + sizeStyle + '">'
    + _renderInputPorts(node, state)
    + '<div class="graph-node-main">'
    + '<div class="graph-node-header">'
    + '<span class="graph-node-attribute" style="color:' + attr.color + ';border-color:' + attr.color + ';">我的理解</span>'
    + '<span class="graph-node-badge">人工</span>'
    + _graphMinimizeToggleHtml(node)
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
  const body = node.kind === 'module'
    ? (customBody || (typeof renderMarkdown === 'function' ? renderMarkdown(_nodeContent(message, node), { parentId: String(message.timestamp || ''), sourceModule: node.moduleKey }) : escapeHtml(_nodeContent(message, node))))
    : ((node.kind === 'answer' || node.kind === 'summary' || node.kind === 'note') ? customBody : '');
  const sub = _nodeSub(node);
  const subHtml = sub ? '<span class="graph-node-sub">' + escapeHtml(sub) + '</span>' : '';
  const statusText = node.messageIndex < 0 ? _customNodeStatusText(node) : '';
  const statusHtml = statusText
    ? '<span class="graph-node-status status-' + (node.busy ? 'running' : node.status || 'empty') + '">' + escapeHtml(statusText) + '</span>'
    : '';
  const minimizeToggle = _graphMinimizeToggleHtml(node);
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
  _pushGraphUndo(false, { layout: true });
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
