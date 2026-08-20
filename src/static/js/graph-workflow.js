// ===== PhyMathia 知识网络画布：工作流、分组、事件与启动 =====

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
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
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
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft && !edge.link);
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
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === current.id && !edge.draft && !edge.link);
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
      ? { label: node.manual ? '我的回答' : 'AI 回答' }
      : node.kind === 'hub'
        ? { label: '汇聚' }
        : node.kind === 'summary'
          ? { label: 'AI 总结' }
      : node.kind === 'note'
          ? { label: '我的总结' }
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
          ? (item.manual ? '我的回答' : 'AI 回答')
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
    const incoming = (graphView.edges || []).filter(edge => String(edge.to) === id && !edge.draft && !edge.link);
    for (const edge of incoming) visit(edge.from);
    chain.push(node);
  }
  visit(nodeId);
  return chain;
}

function _nodeInputHash(node) {
  const incoming = (graphView.edges || []).filter(edge => String(edge.to) === node.id && !edge.draft && !edge.link);
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
    return '这是“我的回答”节点，由用户手动填写即可，不需要 AI 生成。';
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
  if (moduleKey === 'graph') {
    return '严格输出知识图谱 Mermaid 代码，不要输出其他模块、不要输出 XML 标签：\n'
      + '用 ```mermaid ... ``` 代码块包裹；至少 3 个上游 + 3 个下游概念，中文标注，箭头表示关系，节点文字避免括号（可用下划线替代）。';
  }
  if (moduleKey === 'viz') {
    return '严格输出 ```html ... ``` 完整 HTML 交互可视化页面，禁止只输出文字描述而不输出 HTML：\n'
      + '页面内顶部必须包含图说四段（用页面内可见标题/提示框呈现，缺一不可）：\n'
      + '**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n'
      + '**怎么看这张图**：1. 2. 3. 编号观察步骤，每步“操作 → 会看到什么”；\n'
      + '**和公式的联系**：图中现象与公式如何互相印证；\n'
      + '**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n'
      + '每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n'
      + '不要输出 XML 标签，不要输出其他模块内容。';
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
        if (typeof _initVizIframes === 'function') _initVizIframes(renderBox);
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
        let data = null;
        try { data = JSON.parse(dataStr); } catch (e) {}
        if (data && data.error) {
          const message = data.detail || data.error.detail || data.error.message || JSON.stringify(data.error);
          throw new Error('AI 流式返回错误：' + message);
        }
        const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && delta.content) {
          content += delta.content;
          _scheduleWorkflowStreamProgress(content.length);
          streamChunkCount++;
          if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          scheduleRender();
        }
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
  _refreshWorkflowNodeStatusUi(live);
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
        let data = null;
        try { data = JSON.parse(dataStr); } catch (e) {}
        if (data && data.error) {
          const message = data.detail || data.error.detail || data.error.message || JSON.stringify(data.error);
          throw new Error('AI 流式返回错误：' + message);
        }
        const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && delta.content) {
          content += delta.content;
          _scheduleWorkflowStreamProgress(content.length);
          streamChunkCount++;
          if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
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
        let data = null;
        try { data = JSON.parse(dataStr); } catch (e) {}
        if (data && data.error) {
          const message = data.detail || data.error.detail || data.error.message || JSON.stringify(data.error);
          throw new Error('AI 流式返回错误：' + message);
        }
        const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && delta.content) {
          analysis += delta.content;
          _scheduleWorkflowStreamProgress(analysis.length);
          streamChunkCount++;
          if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          scheduleRender();
        }
      }
    }
  }

  let cleaned = analysis.trim();
  if (typeof stripXmlTags === 'function') cleaned = stripXmlTags(cleaned).trim();
  if (!cleaned) throw new Error('问题分析返回空内容');
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
  _refreshWorkflowNodeStatusUi(live);
}

function _refreshWorkflowNodeStatusUi(node) {
  if (!node) return;
  if (workflowRunActive) {
    if (typeof _refreshWorkflowNodeUi === 'function') _refreshWorkflowNodeUi(node);
  } else {
    renderGraphCanvas();
  }
}

async function _generateAnalysis(node) {
  if (!node || node.busy) return;
  const question = _findQuestionContentUpstream(node);
  if (!question.trim()) {
    node.status = 'waiting';
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(node);
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
      throw new Error('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
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
    _refreshWorkflowNodeStatusUi(live);
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('问题分析失败：' + (err.message || err));
  }
}

function _modelForWorkflowNode(node) {
  if (node && node.kind === 'module' && (node.moduleKey === 'socratic' || node.moduleKey === 'learn') && typeof getActiveModelForRole === 'function') {
    // 苏格拉底追问/进阶学习优先使用单独配置的 branch 模型，未配置时再跟随主模型。
    const branchModel = getActiveModelForRole('branch');
    if (branchModel) return branchModel;
  }
  if (node && node.kind === 'module' && node.moduleKey === 'viz' && typeof getActiveModelForRole === 'function') {
    // 交互可视化优先使用专门配置的 HTML 生成模型，避免弱主模型反复输出空内容。
    const htmlModel = getActiveModelForRole('html');
    if (htmlModel) return htmlModel;
  }
  if (typeof getActiveModelForRole === 'function') return getActiveModelForRole('agent');
  return null;
}

function _normalizeWorkflowVizContent(content) {
  const html = typeof extractHtmlFromModelReply === 'function' ? extractHtmlFromModelReply(content) : '';
  if (html && (typeof _looksLikeCompleteHtml === 'function' ? _looksLikeCompleteHtml(html) : html)) {
    return '```html\n' + html + '\n```';
  }
  return '';
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
    const model = _modelForWorkflowNode(node);
    if (model && typeof proxyChatWithModel === 'function') {
      resp = await proxyChatWithModel(model, {
        prompt,
        level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
        session_id: typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
        stream: true,
        parent_id: branchMeta.parentId,
        source_module: branchMeta.sourceModule,
        branch_type: branchMeta.branchType,
        branch_id: branchMeta.branchId,
        branch_label: branchMeta.branchLabel,
        graph_path: branchMeta.graphPath,
        workflow_context: branchMeta.workflowContext,
      }, signal);
    }
    if (!resp) {
      throw new Error('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    let streamError = null;
    try {
      await _streamCustomNodeResponse(resp, node);
    } catch (err) {
      streamError = err;
      console.warn('Viz module direct stream failed, will try fallback:', err);
      const failedLive = _findGraphNode(node.id);
      if (failedLive) {
        failedLive.content = '';
        failedLive.busy = false;
      }
    }

    const live = _findGraphNode(node.id);
    if (node.kind === 'module' && node.moduleKey === 'viz' && live) {
      let normalized = _normalizeWorkflowVizContent(live.content || '');
      let vizRetryMessage = streamError && streamError.message ? streamError.message : '';
      if (!normalized && typeof _requestVisualizationHtml === 'function') {
        // 自动重试一次：改用更严格的独立 HTML 生成提示词，减少“节点为空/只有文字”的情况。
        const sourceText = [
          workflowContext.question,
          workflowContext.analysis,
          ...(workflowContext.upstream || []).map(item => item.label + '：' + (item.summary || item.content || '')),
        ].filter(Boolean).join('\n\n').slice(0, 12000);
        try {
          const retryHtml = await _requestVisualizationHtml(
            sourceText || prompt,
            signal,
            '上一次尝试没有返回完整 HTML。请务必只输出从 <!DOCTYPE html> 到 </html> 的完整页面。'
          );
          normalized = '```html\n' + retryHtml + '\n```';
        } catch (retryErr) {
          vizRetryMessage = retryErr && retryErr.message ? retryErr.message : String(retryErr || '');
          console.warn('Viz module automatic retry failed:', retryErr);
        }
      }
      if (!normalized) {
        const wasAborted = !!(workflowAbortController && workflowAbortController.signal.aborted);
        live.content = '';
        live.summary = '';
        live.status = wasAborted ? 'waiting' : 'error';
        live.busy = false;
        _saveCustomNodes();
        if (workflowRunActive) _refreshWorkflowNodeUi(live);
        else renderGraphCanvas();
        if (!wasAborted && typeof showToast === 'function') {
          showToast('交互可视化生成失败：' + (vizRetryMessage || '模型未返回完整 HTML，请点击该节点重试'));
        }
        return;
      }
      live.content = normalized;
      live.summary = _graphSummary(normalized);
      live.status = 'done';
      live.busy = false;
      _saveCustomNodes();
      if (workflowRunActive) _refreshWorkflowNodeUi(live);
      else renderGraphCanvas();
      return;
    }
    if (streamError) throw streamError;
    if (live && !(live.content || '').trim()) {
      live.status = 'error';
      live.busy = false;
      _saveCustomNodes();
      _refreshWorkflowNodeStatusUi(live);
      if (typeof showToast === 'function') showToast('生成失败：模型返回了空内容，请点击该节点重试');
      return;
    }
  } catch (err) {
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
    }
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(live);
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
  }
}

// ===== 主页面提问 → 工作流模板（替代旧聊天全卡路径） =====

const WORKFLOW_MODULE_KEY_BY_LABEL = {
  '物理视角': 'physics',
  '数学视角': 'math',
  '知识图谱': 'graph',
  '交互可视化': 'viz',
  '苏格拉底追问': 'socratic',
  '进阶学习': 'learn',
};

function _parseSuggestedModules(analysisText) {
  const match = String(analysisText || '').match(/建议模块[：:]\s*([^\n]+)/);
  const keys = [];
  if (match) {
    for (const part of match[1].split(/[、,，;；\s]+/)) {
      const label = part.replace(/[（(][^）)]*[)）]/g, '').trim();
      const key = WORKFLOW_MODULE_KEY_BY_LABEL[label];
      if (key && !keys.includes(key)) keys.push(key);
    }
  }
  if (!keys.length) keys.push('physics', 'math');
  return keys;
}

function _createQuestionWorkflowTemplate(questionText, sourceNodeId, sourcePort, placement) {
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  state.connections = state.connections || [];
  const now = Date.now();
  const uid = () => Math.random().toString(36).slice(2, 7);
  let baseX = 120;
  let baseY = sourceNodeId ? 120 : 40;
  if (placement && Number.isFinite(placement.x) && Number.isFinite(placement.y)) {
    baseX = placement.x;
    baseY = placement.y;
  } else if (sourceNodeId) {
    const sourceNode = _findGraphNode(sourceNodeId);
    if (sourceNode) {
      const sourceW = sourceNode.w || sourceNode.customWidth || 300;
      baseX = (Number.isFinite(sourceNode.x) ? sourceNode.x : 120) + sourceW / 2 + 240;
      baseY = Number.isFinite(sourceNode.y) ? sourceNode.y : 120;
    }
  }
  const userNode = {
    id: 'user-custom-' + now + '-' + uid(),
    kind: 'user', moduleKey: '', manual: true, nodeType: '', label: '', formula: '',
    source: 'human', content: questionText, status: 'done', summary: '', analysis: '',
    analysisHash: '', inputHash: '', generatedAt: 0, requirements: '', busy: false,
    generated: false, maxItems: 0, items: [], edges: [], fileId: '', fileName: '',
    generatedNodeIds: [], category: 'other', formulas: [], knowledgeKey: '',
    x: baseX, y: baseY, depth: 1, targetAngle: 0, isRoot: false, timestamp: now,
    pinned: false, fixedX: null, fixedY: null, customWidth: 300, customHeight: null,
    w: 0, h: 0, vx: 0, vy: 0,
  };
  const answerNode = {
    id: 'answer-custom-' + now + '-' + uid(),
    kind: 'answer', moduleKey: '', manual: false, nodeType: '', label: '', formula: '',
    source: 'ai', content: '', status: 'empty', summary: '', analysis: '',
    analysisHash: '', inputHash: '', generatedAt: 0, requirements: '', busy: false,
    generated: false, maxItems: 0, items: [], edges: [], fileId: '', fileName: '',
    generatedNodeIds: [], category: '', formulas: [], knowledgeKey: '',
    x: baseX, y: baseY + 170, depth: 2, targetAngle: 0, isRoot: false, timestamp: now + 1,
    pinned: false, fixedX: null, fixedY: null, customWidth: 300, customHeight: null,
    w: 0, h: 0, vx: 0, vy: 0,
  };
  state.customNodes.push(userNode, answerNode);
  if (sourceNodeId) {
    state.connections.push({ from: sourceNodeId, fromPort: sourcePort || 'out-0', to: userNode.id, toPort: 'in-0', type: 'custom', custom: true });
  }
  state.connections.push({ from: userNode.id, fromPort: 'out-0', to: answerNode.id, toPort: 'in-0', type: 'custom', custom: true });
  _saveGraphState(state);
  renderGraphCanvas();
  return { userNode, answerNode };
}

function _nodeRectForPlacement(node) {
  const w = node.w || node.customWidth || 320;
  const h = node.h || node.customHeight || 120;
  return { x: node.x || 0, y: node.y || 0, w, h };
}

function _rectsOverlap(a, b, gap = 40) {
  return !(
    a.x + a.w / 2 + gap <= b.x - b.w / 2 ||
    a.x - a.w / 2 - gap >= b.x + b.w / 2 ||
    a.y + a.h / 2 + gap <= b.y - b.h / 2 ||
    a.y - a.h / 2 - gap >= b.y + b.h / 2
  );
}

function _workflowModulePositions(moduleKeys, answerNodeId) {
  const answer = _findGraphNode(answerNodeId);
  const ax = answer ? answer.x : 120;
  const ay = answer ? answer.y : 200;
  const aw = answer ? (answer.w || answer.customWidth || 300) : 300;
  const ah = answer ? (answer.h || answer.customHeight || 120) : 120;
  const count = moduleKeys.length;
  const gapY = 230;
  const startY = Math.max(60, ay - ((count - 1) * gapY) / 2);
  const baseX = ax + aw / 2 + 420;
  const positions = moduleKeys.map((_, i) => ({
    x: baseX,
    y: startY + i * gapY,
    w: 640,
    h: 120,
  }));

  const existing = (graphView.nodes || []).filter(n =>
    n.kind !== 'draft' && !n.isRoot
  );
  if (!existing.length) return positions.map(p => ({ x: p.x, y: p.y }));

  // 先尝试右侧，再尝试左侧，找到一块不与已有节点重叠的空白区域。
  const offsets = [];
  for (let i = 0; i <= 15; i++) {
    offsets.push(i * 80);
    if (i > 0) offsets.push(-i * 80);
  }
  for (const offset of offsets) {
    const candidate = positions.map(p => ({ ...p, x: p.x + offset }));
    const hasOverlap = candidate.some(c =>
      existing.some(e => _rectsOverlap(c, _nodeRectForPlacement(e)))
    );
    if (!hasOverlap) return candidate.map(p => ({ x: p.x, y: p.y }));
  }

  return positions.map(p => ({ x: p.x, y: p.y }));
}

function _createWorkflowModuleNodes(moduleKeys, answerNodeId) {
  const state = _graphState();
  state.customNodes = state.customNodes || [];
  state.connections = state.connections || [];
  const now = Date.now();
  const ids = [];
  const positions = _workflowModulePositions(moduleKeys, answerNodeId);
  moduleKeys.forEach((key, i) => {
    const meta = GRAPH_MODULE_META[key] || { label: key };
    const id = key + '-custom-' + now + '-' + Math.random().toString(36).slice(2, 7);
    ids.push(id);
    state.customNodes.push({
      id, kind: 'module', moduleKey: key, manual: false, nodeType: '', label: meta.label || key, formula: '',
      source: 'ai', content: '', status: 'empty', summary: '', analysis: '',
      analysisHash: '', inputHash: '', generatedAt: 0, requirements: '', busy: false,
      generated: false, maxItems: 0, items: [], edges: [], fileId: '', fileName: '',
      generatedNodeIds: [], category: '', formulas: [], knowledgeKey: '',
      x: positions[i].x, y: positions[i].y, depth: 3, targetAngle: 0, isRoot: false, timestamp: now + i,
      pinned: false, fixedX: null, fixedY: null, customWidth: 640, customHeight: null,
      w: 0, h: 0, vx: 0, vy: 0,
    });
    const outIndex = Math.max(0, ANSWER_OUTPUT_SCHEMA.indexOf(key));
    state.connections.push({ from: answerNodeId, fromPort: 'out-' + outIndex, to: id, toPort: 'in-0', type: 'custom', custom: true });
  });
  _saveGraphState(state);
  renderGraphCanvas();
  return ids;
}

function _workflowNodesToExtractionMessages(question, moduleIds) {
  const userMsg = { role: 'user', content: String(question || ''), timestamp: Date.now() };
  const parts = [];
  const nodeIdByModuleKey = {};
  for (const id of moduleIds || []) {
    const node = _findGraphNode(id);
    if (!node || !(node.content || '').trim()) continue;
    const meta = GRAPH_MODULE_META[node.moduleKey] || {};
    const label = meta.label || node.moduleKey || '内容';
    parts.push('### ' + label + '\n\n' + node.content);
    if (node.moduleKey && !nodeIdByModuleKey[node.moduleKey]) {
      nodeIdByModuleKey[node.moduleKey] = node.id;
    }
  }
  if (!parts.length) return { messages: [], nodeIdByModuleKey };
  return {
    messages: [userMsg, { role: 'assistant', content: parts.join('\n\n'), timestamp: Date.now() + 1 }],
    nodeIdByModuleKey,
  };
}

async function _extractKnowledgeFromWorkflow(question, moduleIds) {
  const { messages, nodeIdByModuleKey } = _workflowNodesToExtractionMessages(question, moduleIds);
  if (!messages || messages.length < 2) return;
  try {
    if (typeof autoExtractKnowledge === 'function') {
      await autoExtractKnowledge(typeof currentSessionId !== 'undefined' ? currentSessionId : SESSION_ID, messages, { nodeIdByModuleKey });
    }
  } catch (err) {
    console.warn('Workflow knowledge extraction failed:', err);
  }
}

async function startQuestionWorkflow(text, opts) {
  const question = String((text || '').trim());
  if (!question) return;
  if (typeof isStreaming !== 'undefined' && isStreaming) return;
  const options = opts || {};
  let draftPlacement = null;
  if (options.draftNodeId && typeof _findDraftNode === 'function') {
    const draft = _findDraftNode(options.draftNodeId);
    if (draft && Number.isFinite(draft.x) && Number.isFinite(draft.y)) {
      draftPlacement = { x: draft.x, y: draft.y };
    }
  }
  if (options.draftNodeId && typeof removeDraftNode === 'function') removeDraftNode(options.draftNodeId);

  if (typeof sessions !== 'undefined' && sessions && currentSessionId && sessions[currentSessionId]) {
    const s = sessions[currentSessionId];
    if (!s.title || ['新对话', '新画布', '未命名对话', '未命名画布'].includes(s.title)) {
      s.title = question.substring(0, 30) + (question.length > 30 ? '...' : '');
    }
    s.updatedAt = Date.now();
    if (typeof saveSessions === 'function') saveSessions();
  }

  const template = _createQuestionWorkflowTemplate(question, options.sourceNodeId || '', options.sourcePort || '', draftPlacement);
  const liveAnswer = _findGraphNode(template.answerNode.id) || template.answerNode;
  await _generateAnalysis(liveAnswer);

  const liveAnswer2 = _findGraphNode(template.answerNode.id);
  if (!liveAnswer2 || !(liveAnswer2.analysis || '').trim()) {
    if (liveAnswer2) {
      liveAnswer2.status = 'error';
      liveAnswer2.busy = false;
    }
    _saveCustomNodes();
    if (typeof showToast === 'function') showToast('问题分析为空，请检查模型配置或重试');
    return;
  }
  const moduleKeys = _parseSuggestedModules(liveAnswer2.analysis);
  if (!moduleKeys.length) return;
  // 主界面直接提问：必定生成 进阶学习 + 苏格拉底追问（画布手动追问不强制）
  if (!options.sourceNodeId) {
    if (!moduleKeys.includes('learn')) moduleKeys.push('learn');
    if (!moduleKeys.includes('socratic')) moduleKeys.push('socratic');
  }
  const moduleIds = _createWorkflowModuleNodes(moduleKeys, liveAnswer2.id);
  await _executeParallelWorkflow(moduleIds, true);
  await _extractKnowledgeFromWorkflow(question, moduleIds);
}

function _workflowProgressLabel(node) {
  if (!node) return '';
  if (node.kind === 'source') return '输入';
  if (node.kind === 'knowledge') return '知识点';
  if (node.kind === 'relation') return '知识联系';
  if (node.manual) return node.kind === 'note' ? '我的总结' : '我的回答';
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
      _refreshWorkflowNodeStatusUi(current);
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
      _refreshWorkflowNodeStatusUi(current);
      if (typeof showToast === 'function') showToast('请先填写 ' + (current.kind === 'note' ? '我的总结' : current.manual ? '我的回答' : '问题') + ' 内容');
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
      _refreshWorkflowNodeStatusUi(node);
      stack.push(edge.to);
    }
  }
}

async function _runWorkflowNodeConcurrent(node, subgraph, force, processed, failed, blocked) {
  const shouldForce = force && (node.kind === 'module' || node.kind === 'summary');
  const shouldCount = _workflowItemNeedsProgress(node) || shouldForce;
  if (shouldCount) _markWorkflowCurrentNode(node);
  (window.__wfLogs = window.__wfLogs || []).push({ type: 'start', label: _workflowProgressLabel(node), t: Date.now() });
  console.log('[Workflow] start', _workflowProgressLabel(node), Date.now());
  let ok = false;
  try {
    ok = await _processWorkflowChainItem(node, shouldForce);
  } catch (err) {
    console.error('Workflow node failed:', err);
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      if (live.status !== 'error') live.status = 'error';
    }
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(live);
  }
  (window.__wfLogs = window.__wfLogs || []).push({ type: 'done', label: _workflowProgressLabel(node), t: Date.now() });
  console.log('[Workflow] done ', _workflowProgressLabel(node), Date.now());
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
  window.__wfLogs = [];
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
      let parallelInfo = '';
      const wfLogs = window.__wfLogs || [];
      const moduleStarts = wfLogs
        .filter(e => e.type === 'start' && e.label && e.label !== '我的回答' && e.label !== 'AI 回答')
        .map(e => e.t);
      if (moduleStarts.length > 1) {
        const spread = Math.max.apply(null, moduleStarts) - Math.min.apply(null, moduleStarts);
        parallelInfo = ' · 并行开始 ' + moduleStarts.length + ' 个 · 时间差 ' + spread + 'ms';
      }
      notifyTaskCompleted(Date.now() - workflowStartedAt, '工作流完成' + parallelInfo);
    }
  }
}

async function runWorkflowNode(nodeId, force = false) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0 || node.busy || workflowRunActive) return;
  await _executeParallelWorkflow([nodeId], force);
}

async function runWorkflowNodes(nodeIds, force = false) {
  if (workflowRunActive) return false;
  const targets = (Array.isArray(nodeIds) ? nodeIds : []).filter(id => {
    const node = _findGraphNode(id);
    return node && node.messageIndex < 0 && !node.busy
      && (node.kind === 'module' || node.kind === 'blank' || node.kind === 'summary' || node.kind === 'answer');
  });
  if (!targets.length) return false;
  await _executeParallelWorkflow(targets, !!force);
  return true;
}

async function runAllWorkflowNodes() {
  if (workflowRunActive) return;
  // 防重跑：只运行空节点/依赖发生变化的节点，已生成且未变化的直接跳过
  const targets = graphView.nodes.filter(node => node.messageIndex < 0 && (node.kind === 'module' || node.kind === 'summary') && _workflowItemNeedsProgress(node));
  if (!targets.length) {
    if (typeof showToast === 'function') showToast('没有需要生成的模块/总结节点');
    return;
  }
  await _executeParallelWorkflow(targets.map(node => node.id), false);
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
        let data = null;
        try { data = JSON.parse(dataStr); } catch (e) {}
        if (data && data.error) {
          const message = data.detail || data.error.detail || data.error.message || JSON.stringify(data.error);
          throw new Error('AI 流式返回错误：' + message);
        }
        const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && delta.content) {
          content += delta.content;
          _scheduleWorkflowStreamProgress(content.length);
          streamChunkCount++;
          if (streamChunkCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
          scheduleRender();
          scheduleSave();
        }
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

  const meta = GRAPH_MODULE_META[current.moduleKey] || { label: current.moduleKey || 'AI 生成空白' };
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
      throw new Error('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
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
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    if (typeof window.redoGraphAction === 'function') window.redoGraphAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
    if (inTextInput) return;
    event.preventDefault();
    if (typeof window.redoGraphAction === 'function') window.redoGraphAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    _undoGraphAction();
    return;
  }
  if (graphView.selectMode) return;
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (!graphCanvas || (!graphView.selectedNodeIds.size && !graphView.selectedGroupIds.size)) return;
  if (inTextInput) return;
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
    if (nodeEl && !e.target.closest('button, a, input, textarea, iframe')) {
      if (graphView.linkMode) return;
      _startNodeDrag(e, nodeEl);
    } else _startCanvasPan(e);
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
    const linkEdgeEl = e.target.closest('.graph-edge-link, .graph-edge-link-label');
    if (linkEdgeEl && linkEdgeEl.dataset.edgeKey) {
      openLinkEdgeModal(linkEdgeEl.dataset.edgeKey);
      return;
    }
    if (graphView.linkMode) {
      const linkNodeEl = e.target.closest('.graph-node');
      if (linkNodeEl) _graphLinkPickNode(linkNodeEl.dataset.nodeId);
      return;
    }
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
    if (graphView.selectMode || graphView.linkMode) return;
    const edgeEl = e.target.closest('.graph-edge');
    if (edgeEl && edgeEl.dataset.edgeKey) {
      e.preventDefault();
      e.stopPropagation();
      _removeGraphEdge(edgeEl.dataset.edgeKey);
      return;
    }
    const dblNodeEl = e.target.closest('.graph-node');
    if (dblNodeEl) {
      const dblNode = _findGraphNode(dblNodeEl.dataset.nodeId);
      if (dblNode && dblNode.kind === 'human_note') {
        e.preventDefault();
        e.stopPropagation();
        editHumanNoteNode(dblNode.id);
        return;
      }
    }
    if (e.target.closest('.graph-node, .graph-group, .graph-port, .graph-canvas-toolbar')) return;
    const point = _clientToGraphLocal(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    openAddBlankNodeModal(point.x, point.y);
  });
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
  // 自定义节点的最小化状态存在 customNodes 里，定位时一并清除
  if (node.messageIndex < 0 && Array.isArray(state.customNodes)) {
    const cn = state.customNodes.find(function (x) { return String(x.id) === String(node.id); });
    if (cn && cn.minimized) {
      cn.minimized = false;
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
window.startQuestionWorkflow = startQuestionWorkflow;
window.runWorkflowNodes = runWorkflowNodes;

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

window.getGraphPreviewNodes = () => graphView.previewNodes.map(node => ({ ...node }));

window.toggleGraphView = () => {
  renderGraphCanvas();
};

window.closeGraphView = () => {};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraphCanvas);
} else {
  initGraphCanvas();
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
window.startQuestionWorkflow = startQuestionWorkflow;
window.runAllWorkflowNodes = runAllWorkflowNodes;
window.stopWorkflowRun = stopWorkflowRun;
window.deleteBlankNode = deleteBlankNode;
window.generateBlankNode = generateBlankNode;
window.submitDraftQuestion = submitDraftQuestion;
window.draftSocraticAnswer = draftSocraticAnswer;
window.draftAskAi = draftAskAi;
window.removeDraftNode = removeDraftNode;
window.graphOpenRegenerate = graphOpenRegenerate;
window.generateVizNode = generateVizNode;
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
window.getGraphPreviewNodes = () => graphView.previewNodes.map(node => ({ ...node }));
window.toggleGraphView = () => {
  renderGraphCanvas();
};
window.closeGraphView = () => {};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraphCanvas);
} else {
  initGraphCanvas();
}
