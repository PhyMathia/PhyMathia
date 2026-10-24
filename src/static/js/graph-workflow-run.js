// ===== 工作流：图执行与节点版本历史（2026-10-24 自 graph-workflow.js 拆出，T397 纯搬家）=====
// 依赖子图/就绪波次/并发调度（上限 6）与节点版本切换（T339）。
async function _processWorkflowChainItem(current, force, nodeSignal) {
  if (!current) return false;
  if (current.messageIndex >= 0) return true;
  if (_workflowNodeAborted(nodeSignal)) return false;

  if (current.kind === 'hub') {
    const hasInput = _workflowEdgeTable().some(edge => String(edge.to) === current.id && !edge.draft);
    current.status = hasInput ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'source') {
    current.status = current.items && current.items.length ? 'done' : 'waiting';
    return true;
  }
  if (current.kind === 'relation' && !current.recipeId) {
    current.status = (current.content || '').trim() ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'answer' && !current.manual) {
    // T361：苏格拉底反馈节点重生成走闭环口径（_generateCustomNode 的 socratic 分支），
    // 不是问题分析——否则点「重新生成」会把闭环反馈换成一张问题分析。
    if (current.socraticMeta) {
      await _generateCustomNode(current, nodeSignal);
      return !_workflowNodeAborted(nodeSignal);
    }
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
    // force（T330：分析卡三角「从头生成」/面板留空直发）＝用户点名重跑，不做 hash 短路
    if (force || !current.analysis || current.analysisHash !== analysisHash) {
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

  // 空白节点（2026-10-24 T403）：卡上要求是唯一的生成目标——空要求不跑。闸门放在
  // hash 判定之前：没有要求的卡即使上游变了也不该发请求；状态落「等待输入」，让卡面
  // 徽章/任务行说清为什么没跑（与「user 卡没填内容」同口径：上游缺料就挡住下游）。
  if (current.kind === 'blank' && !String(current.requirements || '').trim()) {
    current.status = 'waiting';
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(current);
    if (typeof showToast === 'function') showToast('空白节点要先写要求：在卡上写「要生成什么」，再点生成');
    return false;
  }
  const inputHash = _nodeInputHash(current);
  // 人工定稿护栏（T355）：整链跑动会拉上游依赖进子图，人工定稿节点即使 hash 因上游
  // 重生成而失配，也不许在这里被 _generateCustomNode 静默覆盖。force（显式从头生成
  // 这颗）例外——那是用户点名要换掉这颗的内容
  if (!force && current.humanDone && (current.content || '').trim()) {
    current.status = 'done';
    return true;
  }
  if (!force && (current.content || '').trim() && current.inputHash === inputHash && current.status === 'done') return true;
  await _generateCustomNode(current, nodeSignal);
  return !_workflowNodeAborted(nodeSignal);
}

function _workflowDependencyEdges() {
  const seen = new Set();
  return _workflowEdgeTable().filter(edge => {
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
  // 并发重复触发兜底：busy＝已有一份在途请求在生成这颗节点（手动点重生成撞上
  // 自动工作流、两条入口同一 tick 派发等）。本 worker 直接空转不归档——失败/
  // 完成/进度都由在途请求自己的 worker 收尾，两次记账不会互相覆盖。正常路径
  // _workflowReadyNodes/入口 busy 门挡在前面，这里是双保险
  if (node.busy) return;
  const shouldForce = force && (node.kind === 'module' || node.kind === 'summary' || node.kind === 'blank');
  const shouldCount = _workflowItemNeedsProgress(node) || shouldForce;
  const taskId = runtime ? runtime.taskId : null;
  if (shouldCount) _markWorkflowCurrentNode(node);
  // 每颗节点一个 controller：面板上的「停」只掐这一颗，不惊动同轮的其他节点
  const nodeController = new AbortController();
  // 登记进登记簿：总闸按下时 stopWorkflowRun 要能连这颗在跑的节点一起掐断（T299）
  workflowInFlightControllers.add(nodeController);
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
  // 摘登记（正常完成/失败/被单停都走这儿；被总闸掐断的也走这儿——见上面 catch 后直落）
  workflowInFlightControllers.delete(nodeController);
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

// 工作流运行级统计（2026-10-14 T326）：每轮开跑生成 runId、按拓扑深度给节点
// 编波次，随记账请求带 wfStats {run, node, wave, hash} 上后端（usage JSONL →
// 用量面板「波」列）。只做观测——不进 prompt、不进 inputHash 判定；wave 标签
// 与调度推进顺序天然一致（_workflowReadyNodes 逐层放行），不改调度本身。
let _wfRunStats = null;

// 请求上带的统计标签。run 外调用（手动单节点模板链等）返回 null，后端据此
// 记普通明细行。hash 复用去重判定同源的 _nodeInputHash——同一份输入口径，
// 面板上「哪次调用其实发的是同一份输入」肉眼可查
function _wfStatsForNode(node) {
  if (!node || !_wfRunStats) return null;
  const wave = _wfRunStats.waves && typeof _wfRunStats.waves.get === 'function'
    ? _wfRunStats.waves.get(node.id) : undefined;
  return {
    run: _wfRunStats.run,
    node: String(node.id || ''),
    wave: Number.isFinite(wave) ? wave : 0,
    hash: String(_nodeInputHash(node) || ''),
  };
}

// wave = 到源节点的最长依赖深度：问题/分析为 0，同层兄弟同号，汇聚/总结 +1。
// 迭代式拓扑求深（节点不动员 DFS 递归，深链也不爆栈）
function _workflowWaveMap(subgraph) {
  const depths = new Map();
  const indeg = new Map();
  const outgoing = new Map();
  for (const id of subgraph.ids) { indeg.set(id, 0); outgoing.set(id, []); }
  for (const edge of subgraph.edges) {
    if (!indeg.has(edge.from) || !indeg.has(edge.to)) continue;
    indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [];
  for (const [id, deg] of indeg) { if (deg === 0) { depths.set(id, 0); queue.push(id); } }
  let settled = 0;
  while (queue.length) {
    const id = queue.shift();
    settled++;
    const depth = depths.get(id) || 0;
    for (const to of (outgoing.get(id) || [])) {
      const next = Math.max(depths.get(to) || 0, depth + 1);
      depths.set(to, next);
      indeg.set(to, (indeg.get(to) || 0) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  // 环形依赖的遗留节点（调度层会报「循环依赖」拦住）：发 -1 之前给个 0 兜底
  if (settled < subgraph.ids.size) {
    for (const id of subgraph.ids) { if (!depths.has(id)) depths.set(id, 0); }
  }
  return depths;
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
  // 运行级统计上下文（T326）：runId 每轮唯一——手动重跑/排队重放/刷新后重来
  // 天然分成不同轮，面板上各自归组；wave 拓扑深度在本轮图定形后一次算好
  _wfRunStats = {
    run: 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    waves: _workflowWaveMap(subgraph),
  };
  window.__wfLogs = [];
  workflowRunActive = true;
  workflowLastAborted = false;
  workflowAbortController = new AbortController();
  _setWorkflowStopButton(true);
  const countedNodes = [...subgraph.ids]
    .map(id => _findGraphNode(id))
    .filter(node => node && (_workflowItemNeedsProgress(node)
      || (force && forceTargets.has(node.id) && (node.kind === 'module' || node.kind === 'summary' || node.kind === 'blank'))));
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
  // T285：开场就把这条任务行的 canceller 绑到总闸 stopWorkflowRun()——绑之前面板上的
  // 「停」/「全部停止」/「全部清空」对工作流行只是账面动作（无 canceller 直接结成
  // 「已停止」），节点在后台继续生成。三入口自此与画布进度条同一闸；收尾 finally
  // 按 wasAborted 落「已停止/手动停止」。
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => stopWorkflowRun());
  }
  const runtime = (taskId && typeof _taskActiveCtx !== 'undefined' && _taskActiveCtx
      && _taskActiveCtx.taskId === taskId)
    ? Object.assign({ taskId }, _taskActiveCtx.runtime)
    : null;
  // 排队中的那条任务（「提问」/节点生成）被这一轮接手了：**开跑前**就地结掉，面板上
  // 从始至终只有一行活账（那条「等待中」直接变成这行的「进行中」）。2026-10-11 从
  // finally 挪到这儿：留在 finally 的话整轮跑动期间面板上会吊着一条永远「等待中」的行，
  // 用户以为它还没轮到。
  if (meta && meta.handoffTaskId && typeof _taskFinish === 'function') {
    _taskFinish(meta.handoffTaskId, 'done', '已交给工作流');
  }
  _showWorkflowProgress(totalWork);
  let completed = false;
  try {
    completed = await _runWorkflowGraph(subgraph, force, runtime, forceTargets);
  } finally {
    const wasAborted = _workflowGlobalAborted();
    workflowLastAborted = wasAborted;
    const userCancelled = runtime ? runtime.userCancelled.size : 0;
    const userStopped = runtime ? (runtime.userStopped || 0) : 0;
    workflowRunActive = false;
    workflowAbortController = null;
    _wfRunStats = null;
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
    // 排队那条任务的结账在开跑前已经做过（见上面 handoffTaskId 处）：放行它的队列
    // 收尾那发 _taskFinish 找不到活账，自然空转，不会把这一轮的账搅乱。
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

// ===== 节点版本历史（2026-10-15 T339）：重新生成/从头生成保留旧版本，可 ‹› 切换、可删 =====
// 账本住在节点对象上（node.versions + node.activeVersion），随 _saveCustomNodes 的整对象
// 快照自动落盘、随撤销 checkpoint（JSON 深克隆）自动入历史。不变量：node.content 恒等于
// node.versions[node.activeVersion].content——凡是绕过账本直接改 content 的路（Φ 改图、
// 人工编辑、旧数据），都会在下一次生成开跑时被 _commitWorkflowNodeVersion 收编，旧内容不丢。
// 流式/修订写到一半的草稿不算版本：失败/中止由 _restoreWorkflowNodeVersion 兜回上一版。
var GRAPH_NODE_VERSION_MAX = 10;

function _nodeVersionsOf(node) {
  if (!node) return [];
  if (!Array.isArray(node.versions)) node.versions = [];
  return node.versions;
}

function _nodeActiveVersionIndex(node, versions) {
  const total = versions.length;
  if (!total) return -1;
  if (typeof node.activeVersion === 'number' && node.activeVersion >= 0 && node.activeVersion < total) {
    return node.activeVersion;
  }
  return total - 1;
}

// 把节点当前 content 收进版本账本；与 activeVersion 指的那版逐字相同则不重收
function _commitWorkflowNodeVersion(node) {
  if (!node || node.messageIndex >= 0) return;
  const content = String(node.content || '');
  if (!content.trim()) return;
  const versions = _nodeVersionsOf(node);
  const av = _nodeActiveVersionIndex(node, versions);
  if (versions[av] && versions[av].content === content) {
    node.activeVersion = av;
    versions[av].humanDone = !!node.humanDone;
    return;
  }
  // humanDone（T355）随版本入账：切版/回滚时标记跟着内容走，不会出现「内容是人工
  // 定稿、标记却丢在工作流重写里」的错位
  versions.push({ content: content, at: Date.now(), humanDone: !!node.humanDone });
  if (versions.length > GRAPH_NODE_VERSION_MAX) versions.splice(0, versions.length - GRAPH_NODE_VERSION_MAX);
  node.activeVersion = versions.length - 1;
}

// 生成开跑前：旧内容先收账、立刻清空 content——新内容从空白流式写出（2026-10-15 用户拍板：
// 不许旧文压着新流）。失败/中止由 _restoreWorkflowNodeVersion 兜回上一版。
function _beginWorkflowNodeVersionCycle(node) {
  if (!node || node.messageIndex >= 0) return;
  _commitWorkflowNodeVersion(node);
  node.content = '';
  // 人工定稿就此交棒给 AI 重写（T355）：旧版已入账且带着标记，失败回滚或 ‹› 切回
  // 时标记随内容恢复；生成成功则节点回到 AI 内容口径
  node.humanDone = false;
}

// 失败/中止结算：content 兜回 activeVersion 那一版（草稿不算数）；账上没版本就清空回未生成态
function _restoreWorkflowNodeVersion(node) {
  if (!node || node.messageIndex >= 0) return;
  const versions = _nodeVersionsOf(node);
  if (!versions.length) {
    node.activeVersion = undefined;
    node.humanDone = false;
    if ((node.content || '') !== '') {
      node.content = '';
      node.summary = '';
    }
    return;
  }
  const av = _nodeActiveVersionIndex(node, versions);
  node.activeVersion = av;
  node.humanDone = !!versions[av].humanDone;
  if (String(node.content || '') !== versions[av].content) {
    node.content = versions[av].content;
    node.summary = typeof _graphSummary === 'function' ? _graphSummary(node.content) : node.content.slice(0, 120);
  }
}

// ‹› 切版本：切到的版本就是节点内容——下游取材、导出、全屏读到的都是它（显示即内容）
function graphNodeVersionStep(nodeId, dir) {
  const node = _findGraphNode(nodeId);
  if (!node || node.busy) return;
  if (typeof _regeneratingNodes !== 'undefined' && _regeneratingNodes.has(nodeId)) return;
  const versions = _nodeVersionsOf(node);
  if (!versions.length) return;
  const av = _nodeActiveVersionIndex(node, versions);
  const next = Math.min(versions.length - 1, Math.max(0, av + (dir < 0 ? -1 : 1)));
  if (next === av) return;
  node.activeVersion = next;
  node.content = versions[next].content;
  node.summary = typeof _graphSummary === 'function' ? _graphSummary(node.content) : node.content.slice(0, 120);
  node.humanDone = !!versions[next].humanDone;
  _saveCustomNodes();
  if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
  renderGraphCanvas();
}

// 删掉当前看到的这个版本：删完看邻位（同位次的新版优先，删末版看前版）；删到最后一版＝
// 节点回到未生成态（内容清空、动作区回「生成」键），再想要就从「从头生成」重跑
function graphNodeVersionDelete(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.busy) return;
  if (typeof _regeneratingNodes !== 'undefined' && _regeneratingNodes.has(nodeId)) return;
  const versions = _nodeVersionsOf(node);
  if (!versions.length) return;
  const av = _nodeActiveVersionIndex(node, versions);
  versions.splice(av, 1);
  if (versions.length) {
    node.activeVersion = Math.min(av, versions.length - 1);
    node.content = versions[node.activeVersion].content;
    node.summary = typeof _graphSummary === 'function' ? _graphSummary(node.content) : node.content.slice(0, 120);
    node.humanDone = !!versions[node.activeVersion].humanDone;
  } else {
    node.activeVersion = undefined;
    node.content = '';
    node.summary = '';
    node.humanDone = false;
  }
  _saveCustomNodes();
  if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
  renderGraphCanvas();
  if (typeof showToast === 'function') showToast(versions.length ? '已删除该版本，现显示相邻版本' : '已删除该版本，节点内容已清空');
}

