// ===== 工作流：入口与空白节点（2026-10-24 自 graph-workflow.js 拆出，T397 纯搬家）=====
// runWorkflowNode/Nodes/runAll/stop 与空白节点生成入口（2026-10-24 T403 起为薄封装，
// 内部走同一条工作流管线）；window 导出集中在主件 graph-workflow.js 尾部块。
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
  // 防重跑：只运行空节点/依赖发生变化的节点，已生成且未变化的直接跳过。
  // 空白节点（2026-10-24 T400）：白名单补进 blank——接进工作流后吹「全部开始」也会
  // 照顾到它；空要求卡由 _workflowItemNeedsProgress 挡在名单外（没有生成目标）。
  const targets = graphView.nodes.filter(node => node.messageIndex < 0 && (node.kind === 'module' || node.kind === 'summary' || node.kind === 'direct' || node.kind === 'blank') && _workflowItemNeedsProgress(node));
  if (!targets.length) {
    // 空要求空白卡不算「没有节点」——用户眼前明明有一张卡，只是缺生成目标，说清差什么
    const awaitingRequirement = graphView.nodes.some(node => node.messageIndex < 0 && node.kind === 'blank'
      && !String(node.requirements || '').trim());
    if (typeof showToast === 'function') {
      showToast(awaitingRequirement
        ? '空白节点要先写要求：在卡上写「要生成什么」，再点生成'
        : '没有需要生成的模块/总结/直接回答/空白节点');
    }
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

// 空白节点要求框 → 节点字段（2026-10-24 T403）：卡上要求框是「改要求重写」的快捷入口，
// 但要求值不能只在点按钮那一刻从 DOM 读——反馈面板（留空＝按卡上要求重跑）、「全部开始」、
// Φ/任务重试都可能绕过这颗按钮。输入即同步，任何生成路读 node.requirements 都是最新的。
let _blankRequirementSaveTimer = null;
function updateBlankNodeRequirements(nodeId, value) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank') return;
  const next = String(value || '');
  if (next === String(node.requirements || '')) return;
  node.requirements = next;
  if (_blankRequirementSaveTimer) return;
  _blankRequirementSaveTimer = setTimeout(() => {
    _blankRequirementSaveTimer = null;
    _saveCustomNodes();
  }, 400);
}

// 点生成/重写时再兜一次 DOM（输入法组合结束、脚本改值等不触发 input 的边角）
function _syncBlankRequirementsFromCard(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank') return '';
  const input = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-blank-input');
  if (input) {
    const value = String(input.value || '').trim();
    if (value !== String(node.requirements || '')) {
      node.requirements = value;
      _saveCustomNodes();
    }
  }
  return String(node.requirements || '').trim();
}

// 空白节点生成入口（2026-10-24 T400/T401/T402 收口）：薄封装——卡上按钮、任务重试、
// Φ 应用、反馈面板留空直发全部走同一条 _executeParallelWorkflow 管线（排队/任务账/
// 版本账/提示词/附图/进度统计都在那边），这里只做两件空白专属的事：
//   ① 要求框同步进节点（改要求＝改输入，inputHash 随之失配）；
//   ② 空要求就地拦（不开一条空任务；工作流内部同一道闸仍在，管绕过按钮的入口）；
//   ③ force 口径：有内容＝重生成（走 T303 下游预警），没内容＝首次生成；
//      forceOverride 给「从头生成」三角用（有内容也强制重跑，不问 hash）。
// 旧实现自带一套提示词/流式/记账，与工作流路生成两种内容（T401）；两条路合一后
// 同一张卡不管从哪儿触发，输入相同就产出相同。
async function generateBlankNode(nodeId, fromQueue = false, handoffTaskId = null, forceOverride = false) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank') return;
  _syncBlankRequirementsFromCard(nodeId);
  const live = _findGraphNode(nodeId);
  if (!live) return;
  // 空要求就地在门口拦：别为一张没有生成目标的卡开一条空工作流任务（工作流内部同一道闸
  // 仍在，管「全部开始」/Φ/重试这些绕过按钮的入口）
  if (!String(live.requirements || '').trim()) {
    if (typeof showToast === 'function') showToast('空白节点要先写要求：在卡上写「要生成什么」，再点生成');
    return;
  }
  const force = !!forceOverride || !!(live.content || '').trim();
  await runWorkflowNode(nodeId, force, fromQueue, handoffTaskId);
}
