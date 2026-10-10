// ===== PhyMathia 知识网络画布：工作流、分组、事件与启动 =====

// 流式渲染节流：多路并行流式时，把“全图 measure + 节点 transform + 边重绘”合并为
// 最长 ~150ms 一次，避免每个流式块都全图强刷（原实现每帧对全部节点/全部边做同步布局
// 与整层 SVG 重建，图越大越闪烁）。流式内容本身仍即时局部更新。
let _graphSyncTimer = null;
function _scheduleGraphSync() {
  if (_graphSyncTimer) return;
  _graphSyncTimer = setTimeout(() => {
    _graphSyncTimer = null;
    if (typeof _measureNodes === 'function') _measureNodes();
    if (typeof _updateNodeTransforms === 'function') _updateNodeTransforms();
    if (typeof _redrawEdges === 'function') _redrawEdges();
  }, 150);
}

// （chat.js / chat-features.js / quiz-ui.js / harness-run.js，后者是变体），
// 本轮只合并了本文件这 3 份。那 4 处的合并见 docs/backlog.md，同样卡在硬规则 6
// 的真发验证上（要动发送链路，没有可用凭证时不能合）。
//
// **只吐正文增量，绝不碰 reasoning_content。** 思维链与正文必须分两条通道攒；
// `delta.content || delta.reasoning_content` 那种写法会把思维链灌进正文，
// 那是 2026-09-15「旋度那座岛全程静默消失」的根因（docs/dev/knowledge-pipeline.md）。
// 将来真要思维链，在这里显式加第二个 yield，不许改回或的那个。
//
// 每 4 帧让出一次事件循环：流式期间合成 DOM 渲染有帧预算，别让读流饿死它。
// （让出的时机从「渲染前」挪到了「渲染后」——两者都是每 4 帧喘一次，语义等价。）
async function* _sseContentFrames(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frameCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();   // 最后一段可能不完整，留到下一轮再拼
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
          yield delta.content;
          frameCount++;
          if (frameCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }
}

async function _streamCustomNodeResponse(resp, node) {
  let content = '';
  let renderPending = false;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      // 可视化卡片一旦挂载就不再每帧重建 iframe（巨型可视化反复重载 = “全屏节点不停闪”的直接来源），
      // 流式中只更新源码文本框；内容完成时由统一渲染一次性重新挂载。
      const vizMounted = renderBox && (renderBox.querySelector('.viz-card') || renderBox.querySelector('.viz-iframe'));
      if (renderBox && live && !vizMounted) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
        if (typeof _initVizIframes === 'function') _initVizIframes(renderBox);
      }
      const textarea = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-content');
      if (textarea) textarea.value = content;
      if (node.kind === 'blank') _renderBlankNodeLive(node, content);
      _scheduleGraphSync();
    });
  }

  for await (const piece of _sseContentFrames(resp)) {
    content += piece;
    _scheduleWorkflowStreamProgress(content.length);
    scheduleRender();
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

async function _streamAnalysisResponse(resp, node, question) {
  let analysis = '';
  let renderPending = false;

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
      _scheduleGraphSync();
    });
  }

  for await (const piece of _sseContentFrames(resp)) {
    analysis += piece;
    _scheduleWorkflowStreamProgress(analysis.length);
    scheduleRender();
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
  if (typeof hideProgress === 'function') hideProgress();
}

function _refreshWorkflowNodeStatusUi(node) {
  if (!node) return;
  if (workflowRunActive) {
    if (typeof _refreshWorkflowNodeUi === 'function') _refreshWorkflowNodeUi(node);
  } else {
    renderGraphCanvas();
  }
}

// ===== 节点级中断信号（任务列表「停单个节点」的底座） =====
// 全局停止仍旧是 workflowAbortController 那条总闸；per-node 取消走每个节点自己的
// controller。没传信号的老调用点自动退回总闸，行为一字不变。
function _workflowAbortSignal() {
  return workflowAbortController ? workflowAbortController.signal : null;
}

function _workflowGlobalAborted() {
  const signal = _workflowAbortSignal();
  return !!(signal && signal.aborted);
}

function _workflowNodeSignal(nodeSignal) {
  if (nodeSignal) return nodeSignal;
  return _workflowAbortSignal() || new AbortController().signal;
}

function _workflowNodeAborted(nodeSignal) {
  if (nodeSignal && nodeSignal.aborted) return true;
  return _workflowGlobalAborted();
}

// 面板里节点条目的排列顺序：干活模块按画布位置从左到右，总结/汇聚这类收口的排最后
// （与用户给的面板草图一致：物理视角 → 数学视角 → 交互可视化 → 总结）。
function _taskWorkNodeOrder(a, b) {
  const rank = node => (node.kind === 'summary' || node.kind === 'hub') ? 1 : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const ax = Number.isFinite(a.x) ? a.x : 0;
  const bx = Number.isFinite(b.x) ? b.x : 0;
  if (ax !== bx) return ax - bx;
  const ay = Number.isFinite(a.y) ? a.y : 0;
  const by = Number.isFinite(b.y) ? b.y : 0;
  return ay - by;
}

async function _generateAnalysis(node, nodeSignal) {
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
  if (typeof showProgress === 'function') showProgress('thinking', 8, '正在分析问题');

  const workflowContext = {
    mode: 'analysis',
    target: { kind: 'answer', label: '问题分析' },
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
  const signal = _workflowNodeSignal(nodeSignal);
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
      throw new Error('未配置 AI 模型，请在模型设置中配置');
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
    if (typeof hideProgress === 'function') hideProgress();
  }
}

function _modelForWorkflowNode(node) {
  // 配方声明模型槽位（P2，model_role）：优先用指定槽（html/branch/graph/quiz/descriptor），
  // 槽位没配模型时回落主模型——与官方 viz 的 html 槽回落口径一致
  const recipeRole = node && node.recipeId && node.recipe && node.recipe.generate
    ? String(node.recipe.generate.model_role || '') : '';
  if (recipeRole && recipeRole !== 'agent' && typeof getActiveModelForRole === 'function') {
    const roleModel = getActiveModelForRole(recipeRole);
    if (roleModel) return roleModel;
  }
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

async function _generateCustomNode(node, nodeSignal) {
  if (!node || node.busy) return;
  if (node.kind === 'answer' && !node.manual) return;
  if (node.kind === 'hub') return;
  node.busy = true;
  node.status = 'running';
  _saveCustomNodes();
  if (workflowRunActive) _refreshWorkflowNodeUi(node);
  else renderGraphCanvas();

  const recipe = node.recipeId && node.recipe ? node.recipe : null;
  // 配方双阶段（P2，analysis_phase＝问题分析式）：正文生成前先产出问题概要，写进
  // 自身 analysis——提示词与 workflow_context 拿到与官方 answer 同款的「隐藏分析」
  if (recipe && recipe.analysis_phase) {
    await _recipeGenerateAnalysis(node, nodeSignal);
  }
  const workflowContext = _buildWorkflowContextForNode(node);
  if (recipe && recipe.analysis_phase && node.analysis) workflowContext.analysis = node.analysis;
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
  const signal = _workflowNodeSignal(nodeSignal);

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
      throw new Error('未配置 AI 模型，请在模型设置中配置');
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
    // viz 式收口（官方交互可视化＋P2 配方 html_iframe 载体）：内容必须归一成完整
    // HTML 代码块；不合格时按配方声明的重试预算（on_incomplete.max_retries，官方 1 次）
    // 与重试提示词（retry_prompt）走独立 HTML 生成通道重试
    const vizLike = live && ((node.kind === 'module' && node.moduleKey === 'viz') || (recipe && recipe.content_kind === 'html_iframe'));
    if (vizLike) {
      let normalized = _normalizeWorkflowVizContent(live.content || '');
      let vizRetryMessage = streamError && streamError.message ? streamError.message : '';
      const maxRetries = recipe && recipe.generate && recipe.generate.on_incomplete
        ? Math.max(0, Math.min(2, Number(recipe.generate.on_incomplete.max_retries) || 0))
        : 1;
      const retryHint = recipe && recipe.generate && recipe.generate.retry_prompt
        ? recipe.generate.retry_prompt
        : '上一次尝试没有返回完整 HTML。请务必只输出从 <!DOCTYPE html> 到 </html> 的完整页面。';
      if (!normalized && typeof _requestVisualizationHtml === 'function') {
        // 自动重试：改用更严格的独立 HTML 生成提示词，减少“节点为空/只有文字”的情况。
        const sourceText = [
          workflowContext.question,
          workflowContext.analysis,
          ...(workflowContext.upstream || []).map(item => item.label + '：' + (item.summary || item.content || '')),
        ].filter(Boolean).join('\n\n').slice(0, 12000);
        for (let attempt = 0; attempt < maxRetries && !normalized; attempt++) {
          try {
            const retryHtml = await _requestVisualizationHtml(sourceText || prompt, signal, retryHint);
            normalized = '```html\n' + retryHtml + '\n```';
          } catch (retryErr) {
            vizRetryMessage = retryErr && retryErr.message ? retryErr.message : String(retryErr || '');
            console.warn('Viz module automatic retry failed:', retryErr);
          }
        }
      }
      if (!normalized) {
        const wasAborted = _workflowNodeAborted(nodeSignal);
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
      if (recipe && recipe.on_generated) _recipeAfterGenerated(live);
      return;
    }
    // mermaid 载体归一（P2）：模型没按代码块围栏输出时补一层 ```mermaid，
    // 渲染层就能走官方知识图谱同一条路（renderMarkdown → renderMermaidInElement）
    if (live && recipe && recipe.content_kind === 'mermaid' && !streamError) {
      const raw = String(live.content || '').trim();
      if (raw && raw.indexOf('```mermaid') < 0) {
        const bare = raw.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/```\s*$/, '').trim();
        live.content = '```mermaid\n' + bare + '\n```';
        live.summary = _graphSummary(live.content);
      }
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
    // on_generated 编排钩子（P2）：生成成功后按声明自动建链（进阶学习四步链的数据版）
    if (live && recipe && recipe.on_generated) _recipeAfterGenerated(live);
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

async function _processWorkflowChainItem(current, force, nodeSignal) {
  if (!current) return false;
  if (current.messageIndex >= 0) return true;
  if (_workflowNodeAborted(nodeSignal)) return false;

  if (current.kind === 'hub') {
    const hasInput = (graphView.edges || []).some(edge => String(edge.to) === current.id && !edge.draft);
    current.status = hasInput ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'source') {
    current.status = current.items && current.items.length ? 'done' : 'waiting';
    return true;
  }
  if ((current.kind === 'knowledge' || current.kind === 'relation') && !current.recipeId) {
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
      await _generateAnalysis(current, nodeSignal);
    } else {
      current.status = 'done';
    }
    return !_workflowNodeAborted(nodeSignal);
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
  await _generateCustomNode(current, nodeSignal);
  return !_workflowNodeAborted(nodeSignal);
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

// 上游没了（失败，或被用户从面板上停掉）的下游：标成「上游缺失」（用户拍板 #10）。
// 只写 blocked、不写 waiting——waiting 是「等输入」，这两种「等」在画布上必须分得开。
function _markWorkflowDependentsBlocked(failedId, subgraph, processed, blocked, runtime) {
  const stack = [failedId];
  const taskId = runtime && runtime.taskId;
  while (stack.length) {
    const id = stack.pop();
    for (const edge of subgraph.edges) {
      if (edge.from !== id || processed.has(edge.to) || blocked.has(edge.to)) continue;
      blocked.add(edge.to);
      const node = _findGraphNode(edge.to);
      if (node && node.status !== 'done') node.status = 'blocked';
      _refreshWorkflowNodeStatusUi(node);
      if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, edge.to, 'blocked', '上游缺失', true);
      stack.push(edge.to);
    }
  }
  // 立刻落盘：不然「上游缺失」只在屏幕上活着，切走再回来就又变回待生成了
  _saveCustomNodes();
}

async function _runWorkflowNodeConcurrent(node, subgraph, force, processed, failed, blocked, runtime) {
  const shouldForce = force && (node.kind === 'module' || node.kind === 'summary');
  const shouldCount = _workflowItemNeedsProgress(node) || shouldForce;
  const taskId = runtime ? runtime.taskId : null;
  if (shouldCount) _markWorkflowCurrentNode(node);
  // 每颗节点一个 controller：面板上的「停」只掐这一颗，不惊动同轮的其他节点
  const nodeController = new AbortController();
  if (runtime) {
    runtime.nodeControllers.set(node.id, nodeController);
    if (_workflowGlobalAborted()) nodeController.abort();
  }
  const label = _workflowProgressLabel(node);
  if (shouldCount && typeof _taskNodeStart === 'function') _taskNodeStart(taskId, node.id, label, nodeController);
  (window.__wfLogs = window.__wfLogs || []).push({ type: 'start', label, t: Date.now() });
  console.log('[Workflow] start', label, Date.now());
  let ok = false;
  try {
    ok = await _processWorkflowChainItem(node, shouldForce, nodeController.signal);
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
  (window.__wfLogs = window.__wfLogs || []).push({ type: 'done', label, t: Date.now() });
  console.log('[Workflow] done ', label, Date.now());
  const live = _findGraphNode(node.id);
  const errored = !!(live && live.status === 'error');
  const globalAborted = _workflowGlobalAborted();
  const nodeStopped = nodeController.signal.aborted && !globalAborted;
  const aborted = globalAborted || nodeStopped;
  if (runtime) runtime.nodeControllers.delete(node.id);
  if (nodeStopped) {
    // 用户停掉了这一颗：它自己算失败（不再重试），下游按「上游缺失」传播
    if (runtime) runtime.userStopped = (runtime.userStopped || 0) + 1;
    if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, node.id, 'stopped', '已取消', true);
    failed.add(node.id);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked, runtime);
  } else if (errored || (!ok && !aborted)) {
    if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, node.id, 'error', '失败', true);
    failed.add(node.id);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked, runtime);
  } else {
    if (shouldCount && typeof _taskNodeFinish === 'function') {
      _taskNodeFinish(taskId, node.id, globalAborted ? 'stopped' : (ok ? 'done' : 'error'),
        globalAborted ? '已停止' : (ok ? '' : '未生成'));
    }
    processed.add(node.id);
  }
  if (shouldCount && !aborted) _advanceWorkflowProgress(label);
}

async function _runWorkflowGraph(subgraph, force, runtime, forceTargets) {
  const processed = new Set();
  const failed = new Set();
  const blocked = new Set();
  const pendingQueue = [];
  const inFlight = new Set();
  const userCancelled = (runtime && runtime.userCancelled) ? runtime.userCancelled : new Set();
  const taskId = runtime ? runtime.taskId : null;
  let runningWorkers = 0;
  let completed = true;

  // 用户在面板上停掉了还没轮到的节点：跳过它，并把「上游缺失」传下去
  function skipCancelled(node) {
    if (!node || !userCancelled.has(node.id) || processed.has(node.id) || failed.has(node.id)) return false;
    failed.add(node.id);
    if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, node.id, 'stopped', '已取消', true);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked, runtime);
    return true;
  }

  function enqueueReadyNodes() {
    const ready = _workflowReadyNodes(subgraph, processed, failed, blocked);
    for (const node of ready) {
      if (skipCancelled(node)) continue;
      if (!inFlight.has(node.id) && !pendingQueue.some(item => item.id === node.id)) {
        pendingQueue.push(node);
      }
    }
  }

  async function runWorker() {
    runningWorkers++;
    try {
      while (true) {
        if (_workflowGlobalAborted()) {
          completed = false;
          break;
        }
        // 软暂停（用户拍板 #3）：不再派新节点，已经在跑的跑完。没有剩余活儿时照常
        // 收尾——不然工作流会卡在这道闸门前，永远等不到「继续」的那一天。
        if (typeof _taskCtxPaused === 'function' && _taskCtxPaused()) {
          if (inFlight.size === 0) {
            enqueueReadyNodes();
            if (!pendingQueue.length) break;
          }
          await new Promise(resolve => setTimeout(resolve, 120));
          continue;
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
        if (skipCancelled(node)) {
          enqueueReadyNodes();
          continue;
        }
        inFlight.add(node.id);
        try {
          await _runWorkflowNodeConcurrent(node, subgraph,
            force && (!forceTargets || forceTargets.has(node.id)), processed, failed, blocked, runtime);
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

async function _executeParallelWorkflow(targetIds, force, meta) {
  const subgraph = _buildWorkflowSubgraph(targetIds);
  if (!subgraph.ids.size) {
    if (typeof showToast === 'function') showToast('没有可运行的节点');
    return;
  }
  // force 只许作用在显式指定的目标节点上，不许跟着子图传染：子图会沿连线上溯把来源
  // 节点圈进来（追问/重新生成的目标正好挂在上游），force 若对全子图生效，用户正要
  // 追问的那颗模块/总结节点会被整颗重写、原内容丢失（2026-10-02 用户实测：追问数学
  // 视角节点，数学视角内容被重新生成）。上游节点靠「内容没变就不重跑」的既有口径自然跳过。
  const forceTargets = new Set(targetIds || []);
  const workflowStartedAt = Date.now();
  window.__wfLogs = [];
  workflowRunActive = true;
  workflowAbortController = new AbortController();
  _setWorkflowStopButton(true);
  const countedNodes = [...subgraph.ids]
    .map(id => _findGraphNode(id))
    .filter(node => node && (_workflowItemNeedsProgress(node)
      || (force && forceTargets.has(node.id) && (node.kind === 'module' || node.kind === 'summary'))));
  const totalWork = countedNodes.length;
  // 任务列表：这一轮工作流 = 一条任务，节点明细 = 组里的条目（用户拍板的两级结构）。
  // 开跑前就把「要干哪几颗」记全，面板因此一眼能看到「3/6 已完成」这样的总数。
  const workNodes = countedNodes
    .slice()
    .sort(_taskWorkNodeOrder)
    .map(node => ({ id: node.id, label: _workflowProgressLabel(node) }));
  const taskId = (typeof _tasksBeginWorkflow === 'function')
    ? _tasksBeginWorkflow({
        title: (meta && meta.title) || '生成工作流',
        force: !!force,
        workNodes,
        allIds: [...subgraph.ids],
      })
    : null;
  const runtime = (taskId && typeof _taskActiveCtx !== 'undefined' && _taskActiveCtx
      && _taskActiveCtx.taskId === taskId)
    ? Object.assign({ taskId }, _taskActiveCtx.runtime)
    : null;
  _showWorkflowProgress(totalWork);
  let completed = false;
  try {
    completed = await _runWorkflowGraph(subgraph, force, runtime, forceTargets);
  } finally {
    const wasAborted = _workflowGlobalAborted();
    const userCancelled = runtime ? runtime.userCancelled.size : 0;
    const userStopped = runtime ? (runtime.userStopped || 0) : 0;
    workflowRunActive = false;
    workflowAbortController = null;
    _setWorkflowStopButton(false);
    _hideWorkflowProgress();
    _saveCustomNodes();
    renderGraphCanvas();
    // 任务列表结账。**必须排在 _flushSendQueue 之前**：放行排队请求可能切会话
    // （队列项自带来处），而结账用的还是这一轮任务的账本与上下文。
    if (taskId && typeof _tasksEndWorkflow === 'function') {
      const taskState = wasAborted ? 'stopped' : (completed ? 'done' : 'partial');
      const taskNote = wasAborted ? '手动停止'
        : ((userCancelled || userStopped) ? '有节点被停掉' : (completed ? '' : '有节点没跑完'));
      _tasksEndWorkflow(taskId, taskState, taskNote);
    }
    // 排队中的「提问」被这一轮接手了：把那条等待任务就地结掉，别在面板上留两行
    if (meta && meta.handoffTaskId && typeof _taskFinish === 'function') {
      _taskFinish(meta.handoffTaskId, 'done', '已交给工作流');
    }
    // 队列里还有东西时不报「工作流完成」：这轮完了但活儿没完，而且下一条马上
    // 自动开跑，完成卡片会跟新进度撞在一起（chat.js 的「回复完成」同此口径）。
    if (!wasAborted && completed && typeof notifyTaskCompleted === 'function'
        && !(typeof _hasPendingSend === 'function' && _hasPendingSend())) {
      let parallelInfo = '';
      const wfLogs = window.__wfLogs || [];
      const moduleStarts = wfLogs
        .filter(e => e.type === 'start' && e.label && e.label !== '我的回答' && e.label !== '问题分析')
        .map(e => e.t);
      if (moduleStarts.length > 1) {
        const spread = Math.max.apply(null, moduleStarts) - Math.min.apply(null, moduleStarts);
        parallelInfo = ' · 并行开始 ' + moduleStarts.length + ' 个 · 时间差 ' + spread + 'ms';
      }
      notifyTaskCompleted(Date.now() - workflowStartedAt, '工作流完成' + parallelInfo);
    }
    // 排队请求在这条最长的通道上等得最久（免费模型一次工作流 2-8 分钟），
    // 放行点必须挂在工作流的 finally 上，不能只靠 sendMessage 那侧。
    if (typeof _flushSendQueue === 'function') await _flushSendQueue();
  }
}

async function runWorkflowNode(nodeId, force = false) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0 || node.busy) return;
  // T58：工作流生成中再点单个节点的生成钮原先只是静默 return——补一句提示，
  // 别让用户以为按钮失灵（排队语义只在发送链，这里语义是「不允许并行起跑」）
  if (workflowRunActive) {
    if (typeof showToast === 'function') showToast('工作流正在生成中，稍候再单独生成这个节点');
    return;
  }
  await _executeParallelWorkflow([nodeId], force, { title: '生成' + _workflowProgressLabel(node) });
}

async function runWorkflowNodes(nodeIds, force = false) {
  if (workflowRunActive) return false;
  const targets = (Array.isArray(nodeIds) ? nodeIds : []).filter(id => {
    const node = _findGraphNode(id);
    return node && node.messageIndex < 0 && !node.busy
      && (node.kind === 'module' || node.kind === 'blank' || node.kind === 'summary' || node.kind === 'answer');
  });
  if (!targets.length) return false;
  await _executeParallelWorkflow(targets, !!force, { title: '生成 ' + targets.length + ' 个节点' });
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
  await _executeParallelWorkflow(targets.map(node => node.id), false, { title: '全部生成' });
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
      _scheduleGraphSync();
    });
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      _saveCustomNodes();
    }, 400);
  }

  for await (const piece of _sseContentFrames(resp)) {
    content += piece;
    _scheduleWorkflowStreamProgress(content.length);
    scheduleRender();
    scheduleSave();
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
  // T58 同款闸门：工作流跑着时不许再单独起一条生成（排队语义只在发送链）。
  // 这道闸同时保住下面任务自带的 AbortController 不与工作流总闸共用——
  // 面板上的「停止」必须只掐这一条流，不能顺着共用 signal 把整轮工作流带走。
  if (workflowRunActive) {
    if (typeof showToast === 'function') showToast('工作流正在生成中，稍候再单独生成这个节点');
    return;
  }
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
  // T61：空白节点的独立生成也记一笔任务账——面板看得见、停得掉、失败可重试。
  // signal 用任务自己那颗 controller，不再借 workflowAbortController（上面已有互斥闸）。
  const jobAbort = new AbortController();
  const jobStartedAt = Date.now();
  const taskId = (typeof _taskBeginNodeJob === 'function')
    ? _taskBeginNodeJob({ title: '生成' + meta.label, nodeId: nodeId, nodeKind: 'blank' })
    : null;
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => jobAbort.abort());
  }
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
            ? '问题分析'
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
  const signal = jobAbort.signal;

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
      throw new Error('未配置 AI 模型，请在模型设置中配置');
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamBlankNodeResponse(resp, current);
    if (taskId && typeof _taskFinish === 'function') _taskFinish(taskId, 'done');
    if (typeof notifyTaskCompleted === 'function') {
      notifyTaskCompleted(Date.now() - jobStartedAt, meta.label + '生成完成');
    }
    if (typeof hideProgress === 'function') hideProgress();
  } catch (err) {
    const aborted = jobAbort.signal.aborted || (err && err.name === 'AbortError');
    if (taskId && typeof _taskFinish === 'function') {
      _taskFinish(taskId, aborted ? 'stopped' : 'error',
        aborted ? '已停止' : (((err && err.message) || String(err) || '生成失败')));
    }
    const live = _findGraphNode(nodeId);
    if (live) live.busy = false;
    _saveCustomNodes();
    renderGraphCanvas();
    // 面板上的「停止」不算失败，别再弹「生成失败」吓人
    if (!aborted && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
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
    color: graphDefaultGroupColor(),
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
  // 滚轮缩放按帧合并：触控板/高分辨率滚轮一次手势会连发多个 wheel 事件，逐事件同步缩放
  // 每发都做一次 getBoundingClientRect + transform 写入 + save 记账。改为「最新优先」——
  // 事件里只累乘系数、记最新光标锚点，rAF 每帧最多执行一次 zoomGraph（与拖拽
  // _handlePointerMove 的每帧一次口径一致）。preventDefault 必须同步，不能挪进 rAF。
  let _graphWheelRaf = 0, _graphWheelFactor = 1, _graphWheelX = 0, _graphWheelY = 0;
  graphCanvas.addEventListener('wheel', e => {
    const scroller = e.target.closest('.graph-node-full-content, .graph-node .mermaid-container');
    if (scroller) return;
    e.preventDefault();
    _graphWheelFactor *= e.deltaY < 0 ? 1.08 : 0.92;
    _graphWheelX = e.clientX;
    _graphWheelY = e.clientY;
    if (!_graphWheelRaf) {
      _graphWheelRaf = requestAnimationFrame(() => {
        _graphWheelRaf = 0;
        const factor = _graphWheelFactor;
        _graphWheelFactor = 1;
        zoomGraph(factor, _graphWheelX, _graphWheelY);
      });
    }
  }, { passive: false });
  graphCanvas.addEventListener('pointerdown', e => {
    // 右键/中键不进入拖拽与点选链路（右键菜单由 contextmenu 监听单独处理）：
    // 过滤必须在本处理器入口生效，_startNodeDrag/_startGroupDrag/_startCanvasPan 才不会被
    // 右键按下误触发；graph-custom.js 的 document 捕获 pointerdown（曲线拖拽 + 联系线
    // 450ms 双击检测）同样已在入口按 button 过滤（已随联系线菜单 M1 落地细化）——右键按压
    // 不再计入双击检测，快速右双击不会误开联系线弹窗。
    if (e.button !== 0) return;
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
  graphCanvas.addEventListener('contextmenu', e => {
    // 自绘右键菜单（graph-contextmenu.js）。只在图谱画布内接管，画布外仍是浏览器原生菜单。
    // 1) 输入类元素放行：节点内 textarea/输入框保留粘贴、拼写等原生编辑菜单
    if (e.target && typeof e.target.closest === 'function'
      && e.target.closest('input, textarea, [contenteditable], iframe')) return;
    // 2) 文字选择模式放行：不与「选择文字/复制」抢交互
    if (graphView.selectMode) return;
    // 3) 拖动/框选过的手势不弹菜单（graphView.moved 由现有拖拽链路维护）
    if (graphView.moved) return;
    e.preventDefault();
    openGraphContextMenu(e);
  });
  graphCanvas.addEventListener('pointermove', _handlePointerMove);
  window.addEventListener('pointerup', _endPointerDrag);
  // 拖拽被系统手势/浏览器接管时 pointerup 不来：至少把装饰粒子的暂停标志恢复掉
  window.addEventListener('pointercancel', () => {
    if (graphView.symbolsPausedForDrag) {
      graphView.symbolsPausedForDrag = false;
      if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(false);
    }
  });
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
      // 单击联系线：进入手柄精调（钢笔式拖拽）。
      // 双击必须手动检测：进/出精调态都会 _redrawEdges() 替换 SVG 元素，
      // 浏览器原生 dblclick 会落在公共祖先容器上，closest('.graph-edge') 永远失配。
      const linkKey = linkEdgeEl.dataset.edgeKey;
      const now = Date.now();
      const last = graphView._lastLinkEdgeClick || null;
      if (last && last.key === linkKey && (now - last.t) < 450
          && Math.abs(last.cx - e.clientX) < 10 && Math.abs(last.cy - e.clientY) < 10) {
        graphView._lastLinkEdgeClick = null;
        graphView.edgeCurveEditKey = null;
        openLinkEdgeModal(linkKey);
        return;
      }
      graphView._lastLinkEdgeClick = { key: linkKey, t: now, cx: e.clientX, cy: e.clientY };
      if (typeof window.enterLinkCurveEdit === 'function') window.enterLinkCurveEdit(linkKey);
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
    if (graphView.selectMode || graphView.linkMode) {
      // 静默返回会让用户误以为双击编辑坏了；给出原因提示
      if (typeof showToast === 'function') {
        showToast(graphView.linkMode
          ? '联系模式中：完成连线或再次点击工具栏退出后，才能双击编辑'
          : '文字选择模式中：先点击「选择文字」按钮退出，再双击编辑');
      }
      return;
    }
    const edgeEl = e.target.closest('.graph-edge');
    if (edgeEl && edgeEl.dataset.edgeKey) {
      e.preventDefault();
      e.stopPropagation();
      // 联系线（联系模式创建的注释性箭头）：双击打开编辑弹窗；
      // 其余连线（端口拖出的父子关系）：双击=删除（tooltip 有说明）
      const edgeKey = edgeEl.dataset.edgeKey;
      const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
      if (edge && edge.link) {
        openLinkEdgeModal(edgeKey);
        return;
      }
      _removeGraphEdge(edgeKey);
      if (typeof showToast === 'function') showToast('已删除连线（Ctrl+Z 可撤销）');
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
  // T69：折叠壳没有内容子树（占位符）——定位跳转展开它时先整卡重建，
  // 否则跳过去是一张空壳卡
  const phEl = graphInner && graphInner.querySelector
    ? graphInner.querySelector('[data-node-id="' + node.id + '"] [data-body-ph]') : null;
  if (phEl && !node.minimized && typeof _refreshWorkflowNodeUi === 'function') {
    _refreshWorkflowNodeUi(node);
  }
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
