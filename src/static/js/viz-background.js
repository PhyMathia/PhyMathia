// ===== viz 后台通道（2026-11-22，backlog 504 的可回退子集）=====
//
// 为什么有这个文件：
// 队列放行只看 workflowRunActive（send-queue.js 的 _isActuallyBusy），而那把锁要等
// 整轮工作流收尾才落——viz 是整轮最长的一根（10-30 分钟），于是「提问/生成」后面
// 排的活儿全被它一个人挡住。完整并行化要改 6 个全局开关 + 27 处世界观调用（方案
// docs/任务并行化方案-v2-2026-11-18.md §3），成本 6-8 天；本通道只接管 viz 一种
// 叶子任务：viz 开跑即从前台账本摘出去，转成本文件的后台任务，队列当场放行。
//
// 三条不变量（用户 2026-11-22 拍板的技术约束）：
// ① 快照：开跑瞬间冻结 prompt/workflowContext/sessionId/模型槽——下一条任务改了画布
//    或换了模型，都不影响这条在跑的 viz。冻结结果写进 job，续跑也读它。
// ② 隔离：viz 用自己的 AbortController、自己的任务行（kind='viz-bg'）、自己的进度
//    口径（不算进前台胶囊），不碰 workflowRunActive / workflowAbortController /
//    workflowLastAborted / _wfRunStats / 停止按钮 / 进度胶囊这 6 个前台全局位。
// ③ 取消旧任务：同一节点重开 viz 前先 DELETE 它的旧 484 任务，杜绝两边同时烧 token。
//
// 上限 2 条（VIZ_BG_MAX）：用户连点十下不能把模型打爆。超限的 viz 退回旧同步路径
// （进队列排队），不新开后台任务——所以本通道是「最多并行 2 条 viz」，不是无限开。
//
// 刷新恢复：viz 节点落盘带 genTaskId/busy，484 的 _reattachOneNode 照旧探活重接；
// 本文件在 launch 时把 viz-bg 任务 id 写进节点（vizBgTaskId），收编器据此把那条
// 被刷新打断成 interrupted 的任务行翻回进行中、结终态（见 tasks.js 的 viz-bg 联动）。
// 服务重启/任务过期 → 484 旧口径结算，viz-bg 行按失败记，不虚报完成。

const VIZ_BG_MAX = 2;
const VIZ_BG_TASK_LIMIT = 20;
// 开关：'0' 关（退回旧同步 viz，逐字节等于本通道上线前）；缺省/其它值＝开。
const VIZ_BG_ENABLED_KEY = 'phymathia_viz_background_enabled';

// nodeId -> { nodeId, taskId, genTaskId, controller, startedAt, snapshot, settled }
// 这张表本身就是活跃计数——上限判断直接读 size，不另维护一份会漂移的计数器。
const _vizBgJobs = new Map();

// 刷新/导航卸载标记：pagehide 之后在途 fetch 会被掐死（TypeError），这属于
// 「页面走了」而不是「生成失败」——不能结算成 error，留给下次加载按 interrupted
// 收编（E2E 2026-11-22 复现：节点最终生成成功，任务行却永远停在「可视化未生成成功」）。
let _vizBgPageUnloading = false;
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('pagehide', (event) => {
    if (!event || event.persisted !== true) _vizBgPageUnloading = true;
  });
  window.addEventListener('pageshow', () => { _vizBgPageUnloading = false; });
}

function vizBgEnabled() {
  try { return localStorage.getItem(VIZ_BG_ENABLED_KEY) !== '0'; } catch (e) { return true; }
}
function vizBgSetEnabled(on) {
  try { localStorage.setItem(VIZ_BG_ENABLED_KEY, on ? '1' : '0'); } catch (e) {}
}
function vizBgActiveCount() { return _vizBgJobs.size; }
function vizBgHas(nodeId) { return _vizBgJobs.has(String(nodeId)); }

// 节点是不是 viz 载体：官方「交互可视化」模块，或配方声明的 html_iframe 载体。
// 与 graph-workflow-generate.js 的 vizLike 判定同一口径（两处必须同步）。
function _vizBgIsVizNode(node) {
  if (!node) return false;
  if (node.kind === 'module' && node.moduleKey === 'viz') return true;
  return !!(node.recipeId && node.recipe && node.recipe.content_kind === 'html_iframe');
}

// 开跑快照：prompt/上下文/会话/模型槽一次性冻结进 job。后续任何全局状态变化都
// 不影响在跑的这条——这是「世界观隔离」的落点，不是靠约定，是靠复制值。
function _vizBgSnapshot(node) {
  const sid = (typeof _workflowSessionId === 'function' && _workflowSessionId())
    || (typeof getCurrentSessionId === 'function' && getCurrentSessionId()) || '';
  const socratic = node.socraticMeta && typeof node.socraticMeta === 'object' ? node.socraticMeta : null;
  const recipe = node.recipeId && node.recipe ? node.recipe : null;
  const workflowContext = socratic ? {} : (typeof _buildWorkflowContextForNode === 'function'
    ? _buildWorkflowContextForNode(node) : {});
  const prompt = socratic ? String(socratic.prompt || '')
    : (typeof _workflowPromptForNode === 'function' ? _workflowPromptForNode(node, workflowContext) : '');
  const slotCall = typeof _slotCallForWorkflowNode === 'function' ? _slotCallForWorkflowNode(node) : null;
  const slotRole = slotCall ? slotCall.role : 'html';
  const cloneModel = (m) => (m && typeof m === 'object' ? { ...m } : null);
  return {
    sid, prompt, workflowContext,
    branchMeta: {
      parentId: (() => {
        const path = typeof _blankNodeGraphPath === 'function' ? _blankNodeGraphPath(node) : [];
        const parent = path[path.length - 1];
        return parent ? String(parent.timestamp || '') : String(node.timestamp || '');
      })(),
      sourceModule: node.moduleKey || '',
      branchType: node.kind === 'direct' ? 'direct' : 'blank',
      branchId: '', branchLabel: (workflowContext.target && workflowContext.target.label) || '交互可视化',
      graphPath: typeof _blankNodeGraphPath === 'function' ? _blankNodeGraphPath(node) : [],
      wfStats: typeof _wfStatsForNode === 'function' ? _wfStatsForNode(node) : undefined,
    },
    slotRole,
    // 约束①：模型对象本身也在开跑瞬间冻结。只存 role 的话，生成链会实时读槽，
    // 用户开跑后换模型就会改到在跑的这条（E2E 2026-11-22 复现：mock-1 → mock-b）。
    slotModel: slotCall ? cloneModel(slotCall.model) : null,
    slotThinking: typeof getSlotThinkingForRole === 'function' ? getSlotThinkingForRole(slotRole) : undefined,
    // viz 自动重试（_requestVisualizationHtml）走 html/agent 双模型，也一并冻结。
    htmlModel: typeof getActiveModelForRole === 'function' ? cloneModel(getActiveModelForRole('html')) : null,
    agentModel: typeof getActiveModelForRole === 'function' ? cloneModel(getActiveModelForRole('agent')) : null,
    level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
  };
}

// 建 viz-bg 任务行。标题带「（后台）」——用户要的就是面板上一眼能分出前台/后台。
function _vizBgBeginTask(node, snapshot) {
  if (typeof _taskCreate !== 'function') return null;
  const task = _taskCreate({
    kind: 'viz-bg',
    title: '生成交互可视化（后台）',
    state: 'running',
    sessionId: snapshot.sid || undefined,
    replay: { nodeJob: { id: String(node.id), kind: 'viz' } },
    // nodes 里带 nodeId 是关键：484 刷新后 _taskHasNodeId 靠它认领这条被中断的行，
    // _taskResumeGenerationForNode 翻回进行中、_taskResumeSettleForNode 结终态——
    // 现成的收编链直接把 viz-bg 行接上，不用另写一套恢复逻辑。
    nodes: [{ id: String(node.id), label: '交互可视化', state: 'running', startedAt: Date.now() }],
  });
  return task ? task.id : null;
}

// 取消指定节点的旧 484 服务端任务（约束③）。同节点重开前必调。
function _vizBgCancelOldServerTask(node) {
  if (!node || !node.genTaskId || typeof _cancelServerGeneration !== 'function') return;
  _cancelServerGeneration(node.genTaskId);
}

// 发射一条 viz 后台任务。返回 true＝已由后台接管（调用方必须立刻返回，不再 await）；
// false＝未接管（开关关/超限/非 viz），调用方走旧同步路径。
function vizBgLaunch(node, opts) {
  const o = opts || {};
  if (!vizBgEnabled()) return false;
  if (!_vizBgIsVizNode(node)) return false;
  const nodeId = String(node.id);
  if (_vizBgJobs.has(nodeId) || _vizBgJobs.size >= VIZ_BG_MAX) return false;
  // 被显式停掉的 viz 有 tombstone：同节点重开是用户的新意图，放行（旧任务已被取消）
  const controller = new AbortController();
  // 约束③：重开前先取消旧 484 任务，避免两路同时烧 token。
  _vizBgCancelOldServerTask(node);
  const snapshot = _vizBgSnapshot(node);
  const taskId = o.taskId || _vizBgBeginTask(node, snapshot);
  const job = {
    nodeId, taskId, controller, snapshot,
    genTaskId: '', startedAt: Date.now(), settled: false,
    // 工作流任务行的节点条目靠它收尾（E2E 2026-11-22 case 2：后台分支早退后
    // 条目永远停在 waiting）。
    onSettle: typeof o.onSettle === 'function' ? o.onSettle : null,
  };
  // 同步占住 busy：发射与生成链之间隔着一个微任务，不占的话这一瞬手动重生成会
  // 开出第二条、两边烧 token。后台链凭 vizBgJob 认自己的 busy（见 generate.js）。
  node.busy = true;
  node.status = 'running';
  if (typeof _saveCustomNodes === 'function') _saveCustomNodes();
  _vizBgJobs.set(nodeId, job);
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => vizBgCancel(nodeId, '手动停止'));
  }
  if (typeof _taskMarkRunning === 'function' && taskId) _taskMarkRunning(taskId);
  // 真正的生成走共享链（与前台完全同一把尺子：流式/版本账/归一/重试/484），
  // 只是用 opts.foreground=false 把它从前台 6 开关与胶囊进度里摘出去。
  Promise.resolve().then(async () => {
    if (typeof _generateCustomNode !== 'function') throw new Error('viz 生成链未加载');
    return await _generateCustomNode(node, controller.signal, { foreground: false, snapshot, vizBgJob: job });
  }).then((result) => {
    // 页面正在卸载（刷新/关标签）：在途 fetch 被掐死不是「生成失败」，不能把任务行
    // 写成 error——留 running 进盘，下次加载由 484 按 interrupted 收编（E2E 6c）。
    if (_vizBgPageUnloading) return;
    // 连接死亡已交给 484 延时探活（_maybeDeferOnConnectionDeath 返回 deferred）：
    // 这里结算会把还活着的服务端任务提前记成失败，续跑路就再也翻不回来。
    if (result && result.deferred) return;
    // _generateCustomNode 内部吞错误（失败时只改节点 status 不抛），所以不能凭
    // Promise resolve 就记完成——读节点终态判成败，避免任务行虚报「已完成」。
    const live = (typeof _findGraphNodeTail === 'function' ? _findGraphNodeTail(nodeId) : null);
    const ok = !!(live && live.status === 'done' && String(live.content || '').trim());
    _vizBgSettle(nodeId, ok ? 'done' : 'error', ok ? '' : '可视化未生成成功');
  }).catch(err => {
    if (_vizBgPageUnloading) return;
    if (controller.signal.aborted) { _vizBgSettle(nodeId, 'stopped', '已停止'); return; }
    _vizBgSettle(nodeId, 'error', (err && err.message) || '后台可视化失败');
  });
  return true;
}

// 后台 viz 结终态：只动自己的任务行，不碰前台账本。
function _vizBgSettle(nodeId, state, note) {
  const job = _vizBgJobs.get(String(nodeId));
  if (!job || job.settled) return;
  // 失败账不得压过已完成的活儿：节点/消息里已有完整可视化时，这条后台任务实际
  // 是成功的（E2E 6c 的另一半——旧页写下的 error 不该盖住已落地的成品）。
  if (state === 'error' && typeof vizNodeAlreadyGenerated === 'function'
      && vizNodeAlreadyGenerated(String(nodeId))) {
    state = 'done';
    note = '';
  }
  job.settled = true;
  if (job.taskId && typeof _taskFinish === 'function') _taskFinish(job.taskId, state, note);
  if (typeof job.onSettle === 'function') {
    try { job.onSettle(state); } catch (e) { /* 回调只管 UI 置灰，坏了不影响结账 */ }
  }
  _vizBgJobs.delete(String(nodeId));
}

// 停止一条后台 viz：abort 流 + DELETE 服务端 484 任务（订阅断开≠取消）。
function vizBgCancel(nodeId, note) {
  const job = _vizBgJobs.get(String(nodeId));
  if (!job) return false;
  try { job.controller.abort(); } catch (e) {}
  if (job.genTaskId && typeof _cancelServerGeneration === 'function') {
    _cancelServerGeneration(job.genTaskId);
  }
  _vizBgSettle(String(nodeId), 'stopped', note || '已停止');
  return true;
}

// 总闸：停掉全部后台 viz（与前台 stopWorkflowRun 分开扫，互不串台）。
function vizBgCancelAll() {
  const ids = [..._vizBgJobs.keys()];
  for (const id of ids) vizBgCancel(id, '全部停止');
  return ids.length;
}

// 刷新续跑收编：484 的 _reattachOneNode 探到服务端任务还活着时调用。
// 让续跑也占住上限名额（_vizBgJobs.size），并把任务行的「停止」重新绑到
// vizBgCancel——否则刷新后这两件事都只是账面动作（E2E 2026-11-22 case 6b）。
function vizBgAdopt(node, opts) {
  if (!node) return null;
  const o = opts || {};
  const id = String(node.id);
  let job = _vizBgJobs.get(id);
  if (job) {
    if (o.genTaskId) job.genTaskId = String(o.genTaskId);
    if (o.taskId && !job.taskId) job.taskId = o.taskId;
    if (o.controller) job.controller = o.controller;
    job.adopted = true;
    return job;
  }
  job = {
    nodeId: id,
    taskId: o.taskId || node.vizBgTaskId || null,
    genTaskId: o.genTaskId || node.genTaskId || '',
    controller: o.controller || new AbortController(),
    // 刷新后快照没进盘：续跑只重接服务端流，不再发新请求，因此不重建快照。
    snapshot: null,
    startedAt: Date.now(),
    settled: false,
    adopted: true,
    onSettle: null,
  };
  _vizBgJobs.set(id, job);
  if (job.taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(job.taskId, () => vizBgCancel(id, '手动停止'));
  }
  return job;
}

// 续跑收编结束（成功/失败/用户停都走）：只摘登记，不结账——任务行由
// _taskResumeSettleForNode / vizBgCancel 各自结。
function vizBgRelease(nodeId) {
  const job = _vizBgJobs.get(String(nodeId));
  if (!job || !job.adopted) return false;
  _vizBgJobs.delete(String(nodeId));
  return true;
}

// 484 收编联动：viz-bg 行靠 nodes 里的 nodeId 被现成的 _taskResumeGenerationForNode /
// _taskResumeSettleForNode 认领（见 tasks.js:291/309），无需本文件另写恢复函数。
// 节点上的 vizBgTaskId 仅作诊断留痕（刷新后哪条行接管了这颗 viz）。

// 单节点「生成可视化」按钮（消息链 viz，写 message.content 而非节点）的后台发射。
// 与 vizBgLaunch 同口径：独立 controller / viz-bg 任务行 / 不进前台队列与胶囊。
// run(abortSignal) 是一个返回 Promise 的闭包（调用方把 ensureVisualization 整套包好传进来）。
// 返回 true＝已接管，调用方必须立刻返回；false＝调用方走旧路径（排队 + 同步）。
function vizBgLaunchMessage(nodeId, run, onSettle) {
  if (!vizBgEnabled() || typeof run !== 'function') return false;
  const id = String(nodeId);
  if (_vizBgJobs.has(id) || _vizBgJobs.size >= VIZ_BG_MAX) return false;
  const controller = new AbortController();
  const sid = (typeof _taskSessionInfo === 'function' ? _taskSessionInfo() : {}).sessionId || '';
  // 约束①：消息链的后台 viz 同样在开跑瞬间冻结 html/agent 双模型与思考档位。
  // 生成器内部（_requestVisualizationHtml）会实时读槽，不冻结的话开跑后换模型
  // 就会改到这条在跑的任务（E2E 2026-11-22 case 9）。
  const cloneModel = (m) => (m && typeof m === 'object' ? { ...m } : null);
  const snapshot = {
    sid,
    htmlModel: typeof getActiveModelForRole === 'function' ? cloneModel(getActiveModelForRole('html')) : null,
    agentModel: typeof getActiveModelForRole === 'function' ? cloneModel(getActiveModelForRole('agent')) : null,
    htmlThinking: typeof getSlotThinkingForRole === 'function' ? getSlotThinkingForRole('html') : undefined,
    agentThinking: typeof getSlotThinkingForRole === 'function' ? getSlotThinkingForRole('agent') : undefined,
  };
  const task = (typeof _taskCreate === 'function') ? _taskCreate({
    kind: 'viz-bg', title: '生成交互可视化（后台）', state: 'running',
    sessionId: sid || undefined, replay: { nodeJob: { id, kind: 'viz' } },
    // 与节点链同口径：带 nodeId 才能在刷新后被 484 的 _taskHasNodeId 认领。
    nodes: [{ id, label: '交互可视化', state: 'running', startedAt: Date.now() }],
  }) : null;
  const taskId = task ? task.id : null;
  const job = { nodeId: id, taskId, genTaskId: '', controller, snapshot,
    startedAt: Date.now(), settled: false,
    onSettle: typeof onSettle === 'function' ? onSettle : null };
  _vizBgJobs.set(id, job);
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => vizBgCancel(id, '手动停止'));
  }
  if (taskId && typeof _taskMarkRunning === 'function') _taskMarkRunning(taskId);
  // 第二参数告诉调用方「这是后台」：进度胶囊与终态文案一律不许写（E2E case 1）。
  Promise.resolve().then(() => run(controller.signal, true, job.snapshot)).then(() => {
    if (_vizBgPageUnloading) return;
    _vizBgSettle(id, 'done', '');
  }).catch(err => {
    if (_vizBgPageUnloading) return;
    if (controller.signal.aborted) { _vizBgSettle(id, 'stopped', '已停止'); return; }
    _vizBgSettle(id, 'error', (err && err.message) || '后台可视化失败');
  });
  return true;
}

// 供冒烟静态契约检查的纯函数：受否可发射（不改状态）。
function vizBgCanLaunch(node) {
  return vizBgEnabled() && _vizBgIsVizNode(node)
    && !_vizBgJobs.has(String(node && node.id)) && _vizBgJobs.size < VIZ_BG_MAX;
}
