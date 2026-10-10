// ====== 主页面提问 → 工作流模板（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家）=====
// startQuestionWorkflow 是发送链入口（硬规则 6 的「工作流首问」）；模板建点/
// 摆位/知识提取同段。window 导出仍集中在 graph-workflow.js 尾部块。
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

async function startQuestionWorkflow(text, opts, handoffTaskId, fromQueue) {
  // 只读查阅（P3）：工作流首问不经过 sendMessage，必须在它自己的入口拦
  if (phyIsReadonly()) { phyReadonlyBlock('发起提问'); return; }
  const question = String((text || '').trim());
  if (!question) return;
  // T42：这条守卫过去只查 isStreaming，而工作流全程不碰 isStreaming（它走
  // _generateAnalysis → proxyChat，不经过 sendMessage），于是对它自己的通道形同虚设——
  // 工作流正跑着还能再点一次「提问」，并发开出第二个工作流、两棵节点树打架。
  // 忙碌判定统一收敛到 _isSendBusy()（send-queue.js），分支/苏格拉底与工作流两条路都覆盖。
  // 整个函数原样重入即可，所以排队闭包不需要拆解它的收尾动作。
  //
  // T225：_isSendBusy() 把 _sendQueueFlushing（队列正在放行）也算忙，而 flush 的循环
  // 条件是 _isActuallyBusy()（刻意不含放行标志，见 send-queue.js:124-132）。没有旁路时，
  // flush 取出排队的「提问」→ 执行 → 守卫命中 → 原样再入队 → 循环再取出……同会话场景
  // （_sendQueueReady 无切画布 await）全程只有已 resolve 的 Promise 微任务，事件循环被饿死、
  // 页面假死，且每圈 _taskCreate 新开一行任务 + toastMsg 弹窗，内存无上限增长。
  // fromQueue 与 sendMessage 的 force（chat.js:278 `!force && …`）同型：只有排队放行那条
  // 闭包传 true，正常三参调用一律 undefined 走守卫，行为不变。
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const capturedQuestion = question;
    const capturedOpts = opts;
    // handoffTaskId：排队那条「提问」任务的 id。轮到它跑起来时，工作流任务接手，
    // 面板上就地把它结掉——不然同一个动作会留两行（等待中的提问 + 进行中的工作流）。
    // text 给面板当标题：只写「提问」两个字，用户认不出等的是哪句问题。
    _enqueueSend('提问', function(taskId) { return startQuestionWorkflow(capturedQuestion, capturedOpts, taskId, true); },
      { text: capturedQuestion });
    return;
  }
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
  await _executeParallelWorkflow(moduleIds, true, { title: question, handoffTaskId: handoffTaskId || '' });
  await _extractKnowledgeFromWorkflow(question, moduleIds);
}
