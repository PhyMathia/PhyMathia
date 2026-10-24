// ===== 工作流：入口与空白节点（2026-10-24 自 graph-workflow.js 拆出，T397 纯搬家）=====
// runWorkflowNode/Nodes/runAll/stop 与空白节点草稿生成；window 导出集中在主件 graph-workflow.js 尾部块。
// 单个节点的「生成/重新生成」。忙的时候不再拒绝，改成排队（2026-10-11）：
// 用户把任务列表当"多任务排队台"用，点一下就该有回音——收进队列、面板上看得见、
// 轮到它时自动切回这张画布跑起来。fromQueue 是放行旁路（同 sendMessage 的 force /
// startQuestionWorkflow 的 fromQueue，见 send-queue.js 的 T225 注）。
async function runWorkflowNode(nodeId, force = false, fromQueue = false, handoffTaskId = null, confirmed = false) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0) return;
  // busy=这颗节点已有在途生成（自动工作流/另一次手动触发）：静默 return 用户
  // 看不出所以然， toe 一下让人知道点了有反应。进 _isSendBusy 队列的是发送
  // 总线忙的场景，与本分支不同
  if (node.busy) {
    if (typeof showToast === 'function') showToast('「' + _workflowProgressLabel(node) + '」正在生成中，稍候');
    return;
  }
  // 重生成预警（T303）：改写内容前确认下游可能失效。排队轮到/任务重试
  // （fromQueue/handoffTaskId）视为用户已确认过，不再二次弹窗；2026-10-13 起面板路
  // （带要求重生成）提示写在面板里、发送即确认，走 confirmed=true 旁路
  if (force && !fromQueue && !handoffTaskId && !confirmed && !_warnDownstreamBeforeRegenerate(node)) return;
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const capturedForce = !!force;
    const label = '生成' + _workflowProgressLabel(node);
    _enqueueNodeJob(label, function(taskId) {
      // 轮到它时先看那颗节点还在不在（等待期间可能被删/被撤销）：不在就地把账结失败，
      // 别让队列收尾顺手记成「已完成」
      if (typeof _queuedJobNodeGuard === 'function' && !_queuedJobNodeGuard(taskId, nodeId)) return;
      return runWorkflowNode(nodeId, capturedForce, true, taskId);
    }, {
      kind: 'workflow',
      // 重试语义与工作流任务同型：记下要跑哪几颗，失败后能从面板上重跑
      replay: { nodeIds: [nodeId], force: capturedForce },
    });
    return;
  }
  // 3.1 事件点（2026-10-24）：生成/重生成在改写内容之前落一个历史点——撤销粒度
  // ＝这一颗节点的这一轮生成。摘要挂在「当前状态」行，条目差异由自动投影生成。
  if (typeof _pushGraphUndo === 'function') {
    _pushGraphUndo(false, {
      source: 'ai',
      summary: (force ? '重新生成：' : '生成：') + _workflowProgressLabel(node),
    });
  }
  await _executeParallelWorkflow([nodeId], force, {
    title: '生成' + _workflowProgressLabel(node),
    handoffTaskId,
  });
}

// 一组节点的重生成（任务列表「重试」走这里）。忙时同样收进队列，返回 true 表示
// 「已经安排上了」——调用方（_taskRegenerate）靠它区分「排队了」与「节点没了」。
// anchorSid（T313）：排队条目自带来处用——工作流跑动期间配方 on_generated 建出的
// 子节点属于世界画布，放行时要把视图带回世界；用户手点的活儿不传（默认按当前画布
// 记账，_sendQueueReady 本来就会把视图带回它那边）。
async function runWorkflowNodes(nodeIds, force = false, fromQueue = false, handoffTaskId = null, anchorSid = '') {
  const ids = (Array.isArray(nodeIds) ? nodeIds : []).filter(id => {
    const node = _findGraphNode(id);
    return node && node.messageIndex < 0 && !node.busy
      && (node.kind === 'module' || node.kind === 'blank' || node.kind === 'summary' || node.kind === 'answer' || node.kind === 'direct');
  });
  if (!ids.length) {
    // busy 滤空（或节点已删除）也给个回音，别让按钮看起来没点上
    if (typeof showToast === 'function') showToast('所选节点都在生成中或已不在画布上');
    return false;
  }
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const capturedForce = !!force;
    _enqueueNodeJob('生成 ' + ids.length + ' 个节点', function(taskId) {
      return runWorkflowNodes(ids, capturedForce, true, taskId).then(function(ran) {
        // 等待期间节点可能被删/被改动，轮到它时一颗都不剩：就地结失败，别记成「已完成」
        if (ran === false && typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '节点已不在画布上');
      });
    }, {
      kind: 'workflow',
      replay: { nodeIds: ids.slice(), force: capturedForce },
      sessionId: anchorSid || undefined,
    });
    return true;
  }
  // 3.1 事件点：一组节点的重生成同样一整次入栈
  if (typeof _pushGraphUndo === 'function') {
    _pushGraphUndo(false, { source: 'ai', summary: '重新生成 ' + ids.length + ' 个节点' });
  }
  await _executeParallelWorkflow(ids, !!force, { title: '生成 ' + ids.length + ' 个节点', handoffTaskId });
  return true;
}

async function runAllWorkflowNodes() {
  // 防重跑：只运行空节点/依赖发生变化的节点，已生成且未变化的直接跳过
  const targets = graphView.nodes.filter(node => node.messageIndex < 0 && (node.kind === 'module' || node.kind === 'summary' || node.kind === 'direct') && _workflowItemNeedsProgress(node));
  if (!targets.length) {
    if (typeof showToast === 'function') showToast('没有需要生成的模块/总结/直接回答节点');
    return;
  }
  const ids = targets.map(node => node.id);
  if (typeof _isSendBusy === 'function' && _isSendBusy()) {
    _enqueueNodeJob('全部生成', function(taskId) {
      // 轮到它时重新筛一遍：刚才忙的那一轮可能已经把其中几颗干完了，别白重跑一遍
      const pending = ids.filter(id => {
        const node = _findGraphNode(id);
        return node && !node.busy && _workflowItemNeedsProgress(node);
      });
      if (!pending.length) {
        if (typeof _taskFinish === 'function') _taskFinish(taskId, 'done', '轮到它时已经没有要生成的节点了');
        return;
      }
      return runWorkflowNodes(pending, false, true, taskId).then(function(ran) {
        if (ran === false && typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '节点已不在画布上');
      });
    }, {
      kind: 'workflow',
      replay: { nodeIds: ids, force: false },
    });
    return;
  }
  await _executeParallelWorkflow(ids, false, { title: '全部生成' });
}

function stopWorkflowRun() {
  if (workflowAbortController) workflowAbortController.abort();
  // T299：在跑的节点一起掐断。总闸只断自己的话，这最多 6 颗并行节点会各自把当前这
  // 一流式跑完（免费模型一颗几十秒到几分钟），用户点了「停止生成」还在出字——
  // 按钮全程有反应、活儿不停，就是按钮失灵的样子。
  workflowInFlightControllers.forEach(function(controller) { controller.abort(); });
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
    setTimeout(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      _renderBlankNodeLive(node, content);
      _scheduleGraphSync();
    }, GRAPH_STREAM_RENDER_MS);
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      _saveCustomNodes();
    }, 400);
  }

  try {
    for await (const piece of _sseContentFrames(resp)) {
      content += piece;
      _scheduleWorkflowStreamProgress(content.length);
      scheduleRender();
      scheduleSave();
    }
  } catch (err) {
    // 半成品随错误一起交出去（T359）：见 _streamCustomNodeResponse 同注
    if (err && typeof err === 'object') err.streamPartial = content;
    throw err;
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
    // 版本账（T339）：空白节点流式成品收作新版本
    _commitWorkflowNodeVersion(live);
  }
  _saveCustomNodes();
  _renderBlankNodeLive(node, content);
  _syncBlankNodeControls(node);
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

async function generateBlankNode(nodeId, fromQueue = false, handoffTaskId = null) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank') return;
  if (node.busy) {
    if (typeof showToast === 'function') showToast('这个空白节点正在生成中，稍候');
    return;
  }
  // 重生成预警（T303）：首次生成不弹（下游没基于任何旧内容）；重生成且有下游才确认
  if (!fromQueue && !handoffTaskId && (node.content || '').trim() && !_warnDownstreamBeforeRegenerate(node)) return;
  // 忙时排队（2026-10-11，同 runWorkflowNode）：过去这里是「工作流跑着就不许再起一条」的
  // 硬闸，用户点了只得到一句「稍候再单独生成这个节点」。现在收进队列等着，轮到它时
  // 队列把视图带回这张画布再跑——互斥仍然成立，只是把「拒绝」换成了「排队」。
  // 这道闸同时保住下面任务自带的 AbortController 不与工作流总闸共用——
  // 面板上的「停止」必须只掐这一条流，不能顺着共用 signal 把整轮工作流带走。
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const label = '生成' + ((GRAPH_MODULE_META[node.moduleKey] || {}).label || '空白节点');
    _enqueueNodeJob(label, function(taskId) {
      if (typeof _queuedJobNodeGuard === 'function' && !_queuedJobNodeGuard(taskId, nodeId)) return;
      return generateBlankNode(nodeId, true, taskId);
    }, {
      kind: 'node',
      replay: { nodeJob: { id: nodeId, kind: 'blank' } },
    });
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
  // 版本账（T339）：重跑有内容的空白节点时旧内容先收账，再清空流式重写
  _beginWorkflowNodeVersionCycle(node);
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
  // 排队的那条任务被这笔真账接手：就地结掉，面板上不留两行（同「提问」的 handoffTaskId）
  if (handoffTaskId && typeof _taskFinish === 'function') _taskFinish(handoffTaskId, 'done', '已交给生成');
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => jobAbort.abort());
  }
  if (typeof showProgress === 'function') showProgress('tool', 5, '正在生成' + meta.label);
  const graphPath = _blankNodeGraphPath(current);
  // T340：链上问题取最近一次追问（数组是根→目标序，反向扫）——旧 find 取到根问题，
  // 深链空白节点生成跟着最初的问题跑（与 _collectWorkflowContext 的 question 同修）
  const pathQuestion = _nearestUserInPath(graphPath);
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
        // T364：闭环身份标签与上游条目映射同口径（_workflowUpstreamEntry）；
        // socraticAnswer/socraticFeedback 两标记由 _blankNodeGraphPath 随副本带出
        label: item.kind === 'user'
          ? (item.socraticAnswer ? '我的作答' : '问题')
          : item.kind === 'answer'
            ? (item.socraticFeedback ? '苏格拉底反馈' : '问题分析')
            : ((GRAPH_MODULE_META[item.module] || {}).label || item.module || '上游节点'),
        summary: _graphSummary(_stripSocraticAnswerMarker(rawContent)) || '',
        content: _stripSocraticAnswerMarker(rawContent).slice(0, 800),
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
        // 取材附图（T381）：空白节点走单父链上下文（graphPath 同一条链），图片
        // 收集也必须按 'inbound' 走——用全祖先会把链外的兄弟素材图塞进来
        const images = await _workflowImageDataUrls(current, 'inbound');
        resp = await _sendWithImagesFallback(images, imgs => proxyChat(
          prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          true,
          signal,
          branchMeta,
          imgs ? { images: imgs } : {}
        ));
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
    const live = _findGraphNode(nodeId);
    const partial = String((err && err.streamPartial) || '');
    // 超时断流的半成品兜底（T359）：与 _generateCustomNode 同口径——字已经收到就留住，
    // 按「未跑完」入账（状态失败），viz 之外不留空卡也不吞掉屏幕上出现过的内容。
    if (!aborted && live && err && err.name === 'TimeoutError' && partial.trim()) {
      live.content = partial;
      live.summary = _graphSummary(partial);
      live.busy = false;
      live.status = 'error';
      _commitWorkflowNodeVersion(live);
      if (taskId && typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '连接超时，已保留收到的内容');
      _saveCustomNodes();
      renderGraphCanvas();
      if (typeof showToast === 'function') showToast('连接超时、生成没跑完：已保留收到的内容，可重新生成');
      if (typeof hideProgress === 'function') hideProgress();
      return;
    }
    if (taskId && typeof _taskFinish === 'function') {
      _taskFinish(taskId, aborted ? 'stopped' : 'error',
        aborted ? '已停止' : (((err && err.message) || String(err) || '生成失败')));
    }
    if (live) {
      live.busy = false;
      // 版本账（T339）：流式草稿不算数，兜回上一版
      _restoreWorkflowNodeVersion(live);
    }
    _saveCustomNodes();
    renderGraphCanvas();
    // 面板上的「停止」不算失败，别再弹「生成失败」吓人
    if (!aborted && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
    if (typeof hideProgress === 'function') hideProgress();
  }
}

