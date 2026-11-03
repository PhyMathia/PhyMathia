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

// ===== 追问自动选路（2026-11-03）=====
// 从「追问」出口拖出的提问卡，先让模型判断走「问题分析＋模块」还是「直接回答」。
// 本地规则判不准（用户已拍板不用规则），模型判断才是主路；超时/调用失败/未配置/
// 模型没给出有效结论一律回落 analysis——问题分析多跑一遍仍能得到答案，静默少答不行。
// 只有追问草稿的调用方（submitDraftQuestion 带 followupRoute）才走这条路，
// 方向钮/进阶学习/苏格拉底闭环/首问的行为一字不变。
const FOLLOWUP_ROUTE_TIMEOUT_MS = 15000;

const FOLLOWUP_ROUTE_SYSTEM_PROMPT = '你是物理数学画布里的「回答方式」判断器。用户在某个节点的「追问」出口拖出了一张提问卡，判断这次追问适合哪种回答方式。\n'
  + '两种方式：\n'
  + '- direct：一个聚焦、可独立回答的问题。一段完整的话、几句解释、一个计算或一条推导就能答清，不需要拆成物理视角/数学视角等多个模块分别展开。\n'
  + '- analysis：需要先梳理概念关系，再分物理视角/数学视角/知识图谱/可视化等多个方向分别展开；或者问题包含多个子问题；或者需要系统梳理一整块知识。\n'
  + '只输出一个 JSON 对象，不要输出任何其他内容：{"route": "direct"} 或 {"route": "analysis"}';

// 从模型回复里抠出路由结论：优先 JSON 对象（允许前后夹杂文字/代码围栏），
// 抠不到再按中英文关键词兜底取最早出现的那个；都没有则返回 ''（上层回落 analysis）。
function _parseFollowupRouteReply(reply) {
  const raw = String(reply || '').trim();
  if (!raw) return '';
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const obj = JSON.parse(m[0]);
      const r = String((obj && (obj.route || obj.mode || obj.answer_mode || obj.way)) || '').trim().toLowerCase();
      if (r === 'direct' || r.indexOf('direct') === 0) return 'direct';
      if (r === 'analysis' || r.indexOf('analysis') === 0) return 'analysis';
    }
  } catch (err) { /* 回复根本不是 JSON，落到关键词兜底 */ }
  const low = raw.toLowerCase();
  const zh = raw;
  const iDirect = low.indexOf('direct') >= 0 ? low.indexOf('direct') : zh.indexOf('直接');
  const iAnalysis = low.indexOf('analysis') >= 0 ? low.indexOf('analysis') : zh.indexOf('分析');
  if (iDirect >= 0 && (iAnalysis < 0 || iDirect < iAnalysis)) return 'direct';
  if (iAnalysis >= 0) return 'analysis';
  return '';
}

// 判断用的背景摘录：只取上游节点正文/概要/分析的前 limit 字，不把整卡问题大纲塞进判断请求。
function _followupSourceExcerpt(sourceNodeId, limit) {
  const node = sourceNodeId && typeof _findGraphNode === 'function' ? _findGraphNode(sourceNodeId) : null;
  if (!node) return '';
  let text = String(node.content || '').trim();
  if (!text) text = String(node.analysis || '').trim();
  if (!text) text = String(node.summary || '').trim();
  if (!text && node.messageIndex >= 0 && typeof _getChatHistory === 'function') {
    const history = _getChatHistory() || [];
    const msg = history[node.messageIndex];
    text = msg ? String(msg.content || '').trim() : '';
  }
  return text.slice(0, limit || 1200);
}

async function _classifyFollowupQuestion(question, sourceNodeId) {
  const fallback = 'analysis';
  const text = String(question || '').trim();
  if (!text) return fallback;
  if (typeof getActiveModelForRole !== 'function' || typeof proxyChatWithModel !== 'function') return fallback;
  const model = getActiveModelForRole('agent');
  if (!model) return fallback;
  const excerpt = _followupSourceExcerpt(sourceNodeId, 1200);
  const userContent = '这次追问：' + text
    + (excerpt ? '\n\n背景（上游节点内容，仅供判断参考，判断对象是这次追问本身）：\n' + excerpt : '');
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, FOLLOWUP_ROUTE_TIMEOUT_MS);
  try {
    const resp = await proxyChatWithModel(model, {
      messages: [
        { role: 'system', content: FOLLOWUP_ROUTE_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      stream: false,
      max_tokens: 64,
      thinking: 'off',
      session_bucket: 'phymathia-followup-route',
    }, controller.signal);
    const data = await resp.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message
      ? data.choices[0].message.content
      : '';
    return _parseFollowupRouteReply(reply) || fallback;
  } catch (err) {
    console.warn('Followup route classification failed, fallback to analysis:', err);
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function _createQuestionWorkflowTemplate(questionText, sourceNodeId, sourcePort, placement, worldSid, route) {
  // T313：worldSid＝工作流所属画布。提问入口建点是同步的（人必然还在那张画布上），
  // 传不传结果一样；统一走世界寻址的读写，后续建模块点（异步，人可能已切走）同款。
  // route（2026-11-03 追问自动选路）：'direct' 时第二颗落「直接回答」节点（与问题节点
  // 走 user out-2 → direct in-0 连线），不建问题分析卡；其余一律问题分析（answer）。
  const isDirectRoute = String(route || '').toLowerCase() === 'direct';
  const state = _graphStateFor(worldSid);
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
    generatedNodeIds: [], category: 'other', formulas: [],
    x: baseX, y: baseY, depth: 1, targetAngle: 0, isRoot: false, timestamp: now,
    pinned: false, fixedX: null, fixedY: null, customWidth: 300, customHeight: null,
    w: 0, h: 0, vx: 0, vy: 0,
  };
  const answerNode = {
    id: (isDirectRoute ? 'direct-custom-' : 'answer-custom-') + now + '-' + uid(),
    kind: isDirectRoute ? 'direct' : 'answer', moduleKey: '', manual: false, nodeType: '', label: '', formula: '',
    source: 'ai', content: '', status: 'empty', summary: '', analysis: '',
    analysisHash: '', inputHash: '', generatedAt: 0, requirements: '', busy: false,
    generated: false, maxItems: 0, items: [], edges: [], fileId: '', fileName: '',
    generatedNodeIds: [], category: '', formulas: [],
    x: baseX, y: baseY + 170, depth: 2, targetAngle: 0, isRoot: false, timestamp: now + 1,
    pinned: false, fixedX: null, fixedY: null, customWidth: 300, customHeight: null,
    w: 0, h: 0, vx: 0, vy: 0,
  };
  state.customNodes.push(userNode, answerNode);
  if (sourceNodeId) {
    state.connections.push({ from: sourceNodeId, fromPort: sourcePort || 'out-0', to: userNode.id, toPort: 'in-0', type: 'custom', custom: true });
  }
  // direct 走问题节点 out-2「直接回答」口（存量图 out-0/out-1 语义不动），answer 仍走 out-0「问题分析」
  state.connections.push({ from: userNode.id, fromPort: isDirectRoute ? 'out-2' : 'out-0', to: answerNode.id, toPort: 'in-0', type: 'custom', custom: true });
  _saveGraphStateFor(worldSid, state);
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

function _createWorkflowModuleNodes(moduleKeys, answerNodeId, worldSid) {
  // T313：模块点在问题分析**之后**才建——免费模型几十秒的分析窗口里人早可能切到
  // 别的画布了，过去现场读 _graphState() 会把模块点建进别人家的 state
  const state = _graphStateFor(worldSid);
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
      generatedNodeIds: [], category: '', formulas: [],
      x: positions[i].x, y: positions[i].y, depth: 3, targetAngle: 0, isRoot: false, timestamp: now + i,
      pinned: false, fixedX: null, fixedY: null, customWidth: 640, customHeight: null,
      w: 0, h: 0, vx: 0, vy: 0,
    });
    const outIndex = Math.max(0, ANSWER_OUTPUT_SCHEMA.indexOf(key));
    state.connections.push({ from: answerNodeId, fromPort: 'out-' + outIndex, to: id, toPort: 'in-0', type: 'custom', custom: true });
  });
  _saveGraphStateFor(worldSid, state);
  renderGraphCanvas();
  return ids;
}

function _workflowNodesToExtractionMessages(question, moduleIds, worldSid) {
  const userMsg = { role: 'user', content: String(question || ''), timestamp: Date.now() };
  const parts = [];
  const nodeIdByModuleKey = {};
  for (const id of moduleIds || []) {
    // T314：结账提取跑在工作流 ctx 结掉之后——人切走了的话视图上没有这些节点，
    // 从世界会话的持久 state 捞（工作流收尾已把最终内容合并进去），两处都没有才算空
    const node = _findGraphNode(id) || (worldSid ? _worldCustomNodeById(worldSid, id) : null);
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

async function _extractKnowledgeFromWorkflow(question, moduleIds, worldSid) {
  const { messages, nodeIdByModuleKey } = _workflowNodesToExtractionMessages(question, moduleIds, worldSid);
  if (!messages || messages.length < 2) return;
  try {
    if (typeof autoExtractKnowledge === 'function') {
      // T314：知识记进**工作流所属的那张画布**——过去现场读 currentSessionId，
      // 工作流属 A、人在 B 时会记进 B 的知识库（正文根本不在那儿）
      await autoExtractKnowledge(worldSid
        || (typeof currentSessionId !== 'undefined' ? currentSessionId : SESSION_ID),
        messages, { nodeIdByModuleKey });
    }
  } catch (err) {
    console.warn('Workflow knowledge extraction failed:', err);
  }
}

// ===== 深入模块一次性提示（T265，2026-10-27）=====
// 聊天心智的用户读完问题分析概要就直接问下一题，画布右侧的深入模块一枚都没点开过。
// 起新「根」问题（不带 sourceNodeId 的首问/画布草稿提问）时，若本画布已有带正文的
// 模块节点且一枚都没被点开过（state.openedModules 空，写入口见 graph-custom.js
// _markModuleOpened），弹一次 toast 指路；弹过即落 STORAGE_KEY_MODULE_HINT_DONE，
// 终身一次。追问/方向钮/苏格拉底支线（带 sourceNodeId）不算新问题，不弹。
function _maybeHintUnreadModules(worldSid) {
  try {
    if (localStorage.getItem(STORAGE_KEY_MODULE_HINT_DONE)) return;
    const state = _graphStateFor(worldSid);
    const opened = (state && state.openedModules) || {};
    const mods = ((state && state.customNodes) || []).filter(n => n && n.kind === 'module'
      && !n.manual && !n.busy && (n.content || '').trim());
    // 没有上一簇（首问）不提示；点开过任意一枚说明功能已被发现，也不再打扰
    if (!mods.length || mods.some(n => opened[n.id])) return;
    localStorage.setItem(STORAGE_KEY_MODULE_HINT_DONE, '1');
    if (typeof showToast === 'function') {
      showToast('旁边的深入模块还没打开过，点模块卡右上角的全屏按钮可细读', 9000);
    }
  } catch (err) { /* 提示属锦上添花，localStorage 异常不打扰提问主流程 */ }
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
    // queueLabel（T361）：画布按钮来的追问/方向钮在任务列表上仍叫「追问/进阶学习」，
    // 不一律显示成「提问」
    _enqueueSend((capturedOpts && capturedOpts.queueLabel) || '提问',
      function(taskId) { return startQuestionWorkflow(capturedQuestion, capturedOpts, taskId, true); },
      { text: capturedQuestion });
    return;
  }
  const options = opts || {};
  // T313：先钉世界再建点。工作流所属画布从这一刻起固定——问题分析、建模块点、
  // 模块生成、知识提取全部对着它读写，人切到别的画布不再换世界观（T313 三个窗口
  // 的总根：画布工作流的世界观过去＝当前显示的画布，切画布即换）。
  // 钉世界必须在第一个 await 之前（2026-11-03 审查修复）：auto 追问的分类要挂最长
  // 15s，worldSid 若留到分类之后再取，判断窗口里切画布会把问题/连线/会话标题全落
  // 到切换后的画布（旧版点击发送到建点全程同步，没有这个窗口）。
  const worldSid = ((typeof getCurrentSessionId === 'function' && getCurrentSessionId())
    || (typeof currentSessionId !== 'undefined' ? currentSessionId : '') || '');
  // 追问自动选路（2026-11-03）：只有追问草稿的调用方带 followupRoute（submitDraftQuestion 传）。
  // auto 先调模型判断；手动 direct/analysis 直接跳过判断、不烧模型调用；没带（方向钮/
  // 苏格拉底闭环/首问等）一律 analysis＝旧行为。
  let followupRoute = '';
  if (options.followupRoute) {
    const requested = String(options.followupRoute).trim().toLowerCase();
    if (requested === 'direct' || requested === 'analysis') {
      followupRoute = requested;
    } else if (requested === 'auto') {
      // 伞只盖住「模型判断」这一段：finally 归零，任何异常（含判断段本身）
      // 都不会把 workflowRunActive 永久留在 true——那会让此后所有发送只排队不放行（须刷新页面）。
      // 正式生成段各自撑伞（分析段自己置位、直接回答交给 _executeParallelWorkflow）。
      try {
        workflowRunActive = true;
        if (typeof showToast === 'function') showToast('正在判断回答方式…', 2000);
        let decided = 'analysis';
        try {
          decided = await _classifyFollowupQuestion(question, options.sourceNodeId || '');
        } catch (classifyErr) {
          console.warn('Followup route classification failed unexpectedly:', classifyErr);
        }
        followupRoute = decided === 'direct' ? 'direct' : 'analysis';
        if (typeof showToast === 'function') {
          showToast(followupRoute === 'direct' ? '自动判断：直接回答' : '自动判断：拆分分析', 2200);
        }
      } catch (err) {
        console.warn('Followup route setup failed, fallback to analysis:', err);
        followupRoute = 'analysis';
      } finally {
        workflowRunActive = false;
      }
    }
  }
  let draftPlacement = null;
  if (options.draftNodeId && typeof _findDraftNode === 'function') {
    const draft = _findDraftNode(options.draftNodeId);
    if (draft && Number.isFinite(draft.x) && Number.isFinite(draft.y)) {
      draftPlacement = { x: draft.x, y: draft.y };
    }
  }
  if (options.draftNodeId && typeof removeDraftNode === 'function') removeDraftNode(options.draftNodeId);

  // 会话标题/时间戳也用钉死的 worldSid——分类窗口里切画布后 currentSessionId 已是新画布
  if (typeof sessions !== 'undefined' && sessions && worldSid && sessions[worldSid]) {
    const s = sessions[worldSid];
    if (!s.title || ['新对话', '新画布', '未命名对话', '未命名画布'].includes(s.title)) {
      s.title = question.substring(0, 30) + (question.length > 30 ? '...' : '');
    }
    s.updatedAt = Date.now();
    if (typeof saveSessions === 'function') saveSessions();
  }

  // T265：新根问题开工前看一眼上一簇模块是否零点开，没发现过深入内容就指一次路
  if (!options.sourceNodeId) _maybeHintUnreadModules(worldSid);
  // 3.1 事件点（2026-10-24）：提问在建节点之前落一个历史点——撤销粒度＝一整次提问
  // （问题＋回答＋模块一起退）。摘要挂在「当前状态」行；条目自己的摘要仍由自动差异
  // 生成（见 graph-history-diff.js _pushGraphUndo 的口径说明）。
  if (typeof _pushGraphUndo === 'function') {
    _pushGraphUndo(false, {
      source: 'ai',
      summary: '提问：' + (typeof _graphShorten === 'function' ? _graphShorten(question, 30) : String(question).slice(0, 30)),
    });
  }
  const template = _createQuestionWorkflowTemplate(question, options.sourceNodeId || '', options.sourcePort || '', draftPlacement, worldSid, followupRoute);
  const liveAnswer = _findGraphNode(template.answerNode.id) || template.answerNode;
  // T299：问题分析这一段过去整段在停止伞之外——顶栏停止按钮要等 _executeParallelWorkflow
  // 开工才启用，而分析恰恰是全程最长的一段（免费模型动辄几十秒），用户点了没反应；
  // analysis 的 fetch 也没接任何可被总闸 abort 的 signal，按钮即便可用也停不掉。
  // 开工先撑伞：busy 标志＋控制器＋停止按钮三件与 _executeParallelWorkflow 同一套口径，
  // 分析被停就止步——不建模块、不收尾提取，画布上留下半截分析待用户重试。
  if (worldSid && typeof _taskBeginWorkflowWorld === 'function') {
    // 世界在分析开跑前立起来：_findGraphNode/_saveCustomNodes 从第一毫秒起就锚定
    // 所属会话（任务行要等 _executeParallelWorkflow 才建，分析阶段靠它顶住窗口 A）
    _taskBeginWorkflowWorld(worldSid, [template.userNode.id, template.answerNode.id]);
  }
  try {
    if (followupRoute === 'direct') {
      // 直接回答：不建问题分析、不建模块——把「直接回答」节点直接交给工作流执行，
      // 任务行/停止按钮/版本账/排队结账与模块路径共用 _executeParallelWorkflow。
      // workflowRunActive 由 _executeParallelWorkflow 自己撑起（它自己的 finally 归零）；
      // 分类段已在 finally 归零，不在这儿再造第一把伞
      await _executeParallelWorkflow([template.answerNode.id], false, { title: question, handoffTaskId: handoffTaskId || '' });
      // T285：被停掉的那轮不再做收尾提取——与分析路径同口径
      if (!workflowLastAborted) await _extractKnowledgeFromWorkflow(question, [template.answerNode.id], worldSid);
      return; // 跳过分析段，但不跳过 finally（收世界/事件收尾）
    }
    workflowRunActive = true;
    workflowAbortController = new AbortController();
    _setWorkflowStopButton(true);
    const analysisController = new AbortController();
    workflowInFlightControllers.add(analysisController);
    try {
      await _generateAnalysis(liveAnswer, analysisController.signal);
    } finally {
      workflowInFlightControllers.delete(analysisController);
    }
    const analysisStopped = analysisController.signal.aborted;
    // 收伞：没被停的话 _executeParallelWorkflow 会另起一把（模块阶段自己的闸）
    workflowAbortController = null;
    workflowRunActive = false;
    _setWorkflowStopButton(false);
    if (analysisStopped) {
      workflowLastAborted = true;
      // 排队那条「提问」若在（handoffTaskId），就地结掉——不然永远挂在等待中
      if (handoffTaskId && typeof _taskFinish === 'function') _taskFinish(handoffTaskId, 'stopped', '已停止');
      return;
    }

    // T419：分析跑的几十秒里人常切走画布，按生成收尾寻址拿节点＋落盘
    const liveAnswer2 = _findGraphNodeTail(template.answerNode.id);
    if (!liveAnswer2 || !(liveAnswer2.analysis || '').trim()) {
      if (liveAnswer2) {
        liveAnswer2.status = 'error';
        liveAnswer2.busy = false;
      }
      _saveGraphNodeTail(liveAnswer2);
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
    const moduleIds = _createWorkflowModuleNodes(moduleKeys, liveAnswer2.id, worldSid);
    // 模块点补登进世界：人在原地时 _taskSyncCtxNodes 直接绑到新视图的活对象，
    // 人切走了由 _taskNodeOverride 的 state 兜底从世界会话的持久 state 收编
    if (typeof _taskExtendWorkflowWorld === 'function') _taskExtendWorkflowWorld(moduleIds);
    await _executeParallelWorkflow(moduleIds, true, { title: question, handoffTaskId: handoffTaskId || '' });
    // T285：被停掉的那轮不再做收尾提取——用户喊停之后还烧一次模型调用去提取半截
    // 画布，与「停止＝不再花钱」矛盾；部分产出留在画布上，想要可手动再提取。
    if (!workflowLastAborted) await _extractKnowledgeFromWorkflow(question, moduleIds, worldSid);
  } finally {
    // 收世界：任务行已接手的话 ctx 已由 _tasksEndWorkflow 结掉，这里对 null 空转；
    // 分析阶段就早退（被停/分析为空）的世界 ctx 在这儿收掉，不外溢到下一轮。
    if (typeof _taskEndWorkflowWorld === 'function') _taskEndWorkflowWorld();
    // 异常早退兜底：正常路径（分析段/工作流执行）都已归零，这里重复归零无害；
    // 分类段撑起的忙碌伞若在早退里漏了，至少不会把页面卡成永远「忙」
    workflowRunActive = false;
    workflowAbortController = null;
    if (typeof _setWorkflowStopButton === 'function') _setWorkflowStopButton(false);
    // 事件收尾（3.1）：给「当前状态」行补上这次提问的差异计数（+N −M ✎K），
    // 刷新后面板也能靠最后一条与当前状态的差异读出来。
    if (typeof _graphHistoryLiveEventDone === 'function') _graphHistoryLiveEventDone();
  }
}

// ===== 苏格拉底闭环 → 工作流承载（T361，2026-10-17 用户拍板退役「一次生成再拆开」）=====
// 作答/提示/讲解过去走 sendQuick 落一条 assistant 消息、画布再按消息切片成簇（同簇连坐删）；
// 现在建「我的回答/提示/讲解（user-custom）＋苏格拉底反馈（answer-custom，带 socraticMeta）」
// 两颗自定义节点，逐颗生成、逐颗删除。服务端口径一字未改：prompt 仍以 [苏格拉底回答]/
// [苏格拉底提示]/[苏格拉底讲解] 开头、branch_id 仍传分支 ref——/api/models/chat 的闭环
// 状态机（_socratic_state_instruction、<socratic_meta> 记账）原样接住，变的只是落点：
// 从消息表换成画布节点（不写 chatHistory，也不再派生消息簇）。
const SOCRATIC_USER_NODE_LABELS = { answer: '我的回答', hint: '苏格拉底提示', explain: '苏格拉底讲解' };

function _socraticUserNodeLabel(mode) {
  return SOCRATIC_USER_NODE_LABELS[mode] || SOCRATIC_USER_NODE_LABELS.answer;
}

function _socraticTaskTitle(mode) {
  return mode === 'hint' ? '苏格拉底提示' : mode === 'explain' ? '苏格拉底讲解' : '苏格拉底反馈';
}

function _createSocraticWorkflowTemplate(promptText, meta, worldSid) {
  const state = _graphStateFor(worldSid);
  state.customNodes = state.customNodes || [];
  state.connections = state.connections || [];
  const now = Date.now();
  const uid = () => Math.random().toString(36).slice(2, 7);
  const m = meta || {};
  const sourceNodeId = String(m.sourceNodeId || '');
  const sourcePort = String(m.sourcePort || 'out-0');
  const sourceNode = sourceNodeId ? _findGraphNode(sourceNodeId) : null;
  let baseX = 120;
  let baseY = 40;
  if (m.position && Number.isFinite(m.position.x) && Number.isFinite(m.position.y)) {
    baseX = m.position.x;
    baseY = m.position.y;
  } else if (sourceNode) {
    const sourceW = sourceNode.w || sourceNode.customWidth || 300;
    baseX = (Number.isFinite(sourceNode.x) ? sourceNode.x : 120) + sourceW / 2 + 240;
    baseY = Number.isFinite(sourceNode.y) ? sourceNode.y : 120;
  }
  const userNode = {
    id: 'user-custom-' + now + '-' + uid(),
    kind: 'user', moduleKey: '', manual: true, nodeType: '', label: '', formula: '',
    source: 'human', content: promptText, status: 'done', summary: '', analysis: '',
    analysisHash: '', inputHash: '', generatedAt: 0, requirements: '', busy: false,
    generated: false, maxItems: 0, items: [], edges: [], fileId: '', fileName: '',
    generatedNodeIds: [], category: 'other', formulas: [],
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
    generatedNodeIds: [], category: '', formulas: [],
    x: baseX, y: baseY + 170, depth: 2, targetAngle: 0, isRoot: false, timestamp: now + 1,
    pinned: false, fixedX: null, fixedY: null, customWidth: 300, customHeight: null,
    w: 0, h: 0, vx: 0, vy: 0,
    // 生成口径随节点走：重生成（runWorkflowNode）也吃这一份，不再回落到问题分析提示词。
    // prompt 是提交瞬间定稿的原文——上游 user 节点被人工编辑不影响闭环指令与状态同步。
    socraticMeta: {
      prompt: promptText,
      mode: m.mode || 'answer',
      question: m.question || '',
      level: m.level || 'basic',
      branchId: m.branchId || '',
      sourceModule: m.sourceModule || 'socratic',
      parentId: m.parentId || '',
      branchLabel: m.branchLabel || '',
    },
  };
  state.customNodes.push(userNode, answerNode);
  if (sourceNodeId) {
    state.connections.push({ from: sourceNodeId, fromPort: sourcePort, to: userNode.id, toPort: 'in-0', type: 'custom', custom: true });
  }
  state.connections.push({ from: userNode.id, fromPort: 'out-0', to: answerNode.id, toPort: 'in-0', type: 'custom', custom: true });
  _saveGraphStateFor(worldSid, state);
  renderGraphCanvas();
  return { userNode, answerNode };
}

// 苏格拉底闭环的工作流入口（T361 起是唯一入口）：忙碌口径与 startQuestionWorkflow 同款
// （统一 _isSendBusy + fromQueue 放行旁路——排队放行时 _sendQueueFlushing 仍算忙，没有
// 旁路会原地自我重入）。返回生成 promise：send-queue 的 flush 靠 await 它确认真跑完。
async function startSocraticWorkflow(promptText, meta, handoffTaskId, fromQueue) {
  if (phyIsReadonly()) { phyReadonlyBlock('作答追问'); return; }
  const text = String(promptText || '').trim();
  if (!text) return;
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const capturedText = text;
    const capturedMeta = meta ? { ...meta } : null;
    const queueLabel = (capturedMeta && _socraticTaskTitle(capturedMeta.mode)) || '苏格拉底作答';
    _enqueueSend(queueLabel, function(taskId) {
      return startSocraticWorkflow(capturedText, capturedMeta, taskId, true);
    }, { text: (capturedMeta && capturedMeta.question) || text, kind: 'workflow' });
    return;
  }
  const m = meta || {};
  const worldSid = ((typeof getCurrentSessionId === 'function' && getCurrentSessionId())
    || (typeof currentSessionId !== 'undefined' ? currentSessionId : '') || '');
  // 3.1 事件点：苏格拉底作答同样是「一整次提问」，建点之前落点
  if (typeof _pushGraphUndo === 'function') {
    _pushGraphUndo(false, {
      source: 'ai',
      summary: _socraticTaskTitle(m.mode) + '：' + (typeof _graphShorten === 'function' ? _graphShorten(text, 30) : String(text).slice(0, 30)),
    });
  }
  const template = _createSocraticWorkflowTemplate(text, m, worldSid);
  const liveAnswer = _findGraphNode(template.answerNode.id) || template.answerNode;
  // T313：先钉世界再生成——人切走之后读写仍落苏格拉底所属的那张画布
  if (worldSid && typeof _taskBeginWorkflowWorld === 'function') {
    _taskBeginWorkflowWorld(worldSid, [template.userNode.id, liveAnswer.id]);
  }
  const title = _socraticTaskTitle(m.mode);
  const controller = new AbortController();
  const taskId = handoffTaskId || ((typeof _taskBeginNodeJob === 'function')
    ? _taskBeginNodeJob({ title, nodeId: liveAnswer.id, nodeKind: 'answer' })
    : null);
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, function() { controller.abort(); });
  }
  try {
    workflowRunActive = true;
    workflowAbortController = new AbortController();
    _setWorkflowStopButton(true);
    workflowInFlightControllers.add(controller);
    if (typeof showProgress === 'function') showProgress('thinking', 8, '正在' + title);
    try {
      await _generateCustomNode(liveAnswer, controller.signal);
    } finally {
      workflowInFlightControllers.delete(controller);
    }
    if (taskId && typeof _taskFinish === 'function') {
      const live = _findGraphNode(liveAnswer.id) || liveAnswer;
      if (controller.signal.aborted) _taskFinish(taskId, 'stopped', '已停止');
      else if (live.status === 'done') _taskFinish(taskId, 'done');
      else _taskFinish(taskId, 'error', '生成失败');
    }
  } finally {
    workflowAbortController = null;
    workflowRunActive = false;
    _setWorkflowStopButton(false);
    if (typeof hideProgress === 'function') hideProgress();
    if (typeof _taskEndWorkflowWorld === 'function') _taskEndWorkflowWorld();
    if (typeof _graphHistoryLiveEventDone === 'function') _graphHistoryLiveEventDone();
  }
}

