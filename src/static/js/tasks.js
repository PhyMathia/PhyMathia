// ===== PhyMathia 任务列表：把「正在跑的活儿」与「排队的活儿」变成一等公民 =====
//
// 为什么有这个东西（docs/backlog.md T55）：
// 底部进度胶囊只回答「这一轮跑到哪了」，答不了三件事：排队里还有几条、刚才那条跑完没有、
// 活儿属于哪个画布。工作流在免费模型上要跑 2-8 分钟，用户会去别的画布继续干活，回来就
// 找不到刚才那轮了。任务列表把两件事分开：
//   · 任务（本文件）= 一件活儿的账：谁发起的、发到哪个会话、现在什么状态、能不能停；
//   · 画布节点 = 活儿落地的产物。
//
// 三条硬约定（用户 2026-09-27 拍板，勿改）：
//   1) **任务自带来处**：创建时快照会话上下文（currentSessionId + 标题），运行期间不再
//      现场读全局——切会话因此不会把产出写进别的画布（T59 的修复就落在这条上）。
//   2) **一次只跑一个任务**：本文件不引入并发，只做账；排队与互斥仍由 send-queue.js 与
//      workflowRunActive 把守。
//   3) **暂停 = 软暂停**：不再派新节点，已经在跑的跑完（闸门在工作流调度口）。
//
// 落盘走服务端 kv 全局键 `tasks:global`，**不落 localStorage**——T53 记着「修改历史」已
// 吃掉 34%，画布快照会把它撑爆；全局键不落会话级文件（src/server/storage.py 的前缀白名单
// 只认 graph: / harness_history: / graph_history:），正好是「一张全局任务台」要的语义。

const TASK_KV_KEY = 'tasks:global';
const TASK_HISTORY_LIMIT = 40;   // 历史最多留 40 条（面板底部）
const TASK_NODE_LIMIT = 24;      // 单个任务的节点条目上限（防超大工作流把落盘撑肥）
const TASK_TITLE_LIMIT = 60;

const TASK_STATE_TEXT = {
  waiting: '等待中',
  running: '进行中',
  paused: '已暂停',
  done: '已完成',
  partial: '部分完成',
  error: '失败',
  stopped: '已停止',
  interrupted: '已中断',
};

const TASK_NODE_TEXT = {
  waiting: '等待',
  running: '生成中',
  done: '完成',
  error: '失败',
  stopped: '已取消',
  blocked: '上游缺失',
};

// 状态字形与用户给的面板草图对齐：⋯ 等待 / ⟳ 生成中 / ✓ 完成 / ✕ 失败 / ■ 已停 / ⚠ 中断
const TASK_STATE_GLYPH = {
  waiting: '⋯',
  running: '⟳',
  paused: '⏸',
  done: '✓',
  partial: '◑',
  error: '✕',
  stopped: '■',
  interrupted: '⚠',
};

const TASK_NODE_GLYPH = {
  waiting: '⋯',
  running: '⟳',
  done: '✓',
  error: '✕',
  stopped: '■',
  blocked: '⚠',
};

let _taskActive = [];      // 未结束的任务，新在前
let _taskHistory = [];     // 已结束的任务，新在前
let _taskSeq = 0;
let _taskLoaded = false;   // 服务端历史读过一次没有
let _taskPanelOpen = false;
let _taskRenderTimer = null;
let _taskPersistTimer = null;
let _taskTickTimer = null;
let _taskExpanded = {};    // taskId -> 是否展开节点明细（纯 UI 态，不落盘）
let _taskTab = 'active';   // 面板页签：'active' = 未完成（在跑/排队/失败），'done' = 已完成
                           // 用户 2026-09-27 要求两个分开：一边是"要盯的"，一边是"账本"。

// 运行中的工作流任务上下文。**一次只跑一个任务**（用户拍板），所以一个模块级指针就够，
// 不需要每任务各持一份。它的职责就两件：
//   · 给画布层当查找覆盖：`_findGraphNode` 优先看这里（任务自带它那一批节点）；
//   · 给画布层当保存出口：`_saveCustomNodes` 改写成「写进任务所属会话的 state」。
// ctx.nodes 在每一跳开始前重新绑定（_taskSyncCtxNodes），所以「用户正看着这个会话」时
// 拿到的就是画布上的同一批对象，画面照样实时刷新；切走之后任务改的是自己那份工作副本，
// 以 state 为交换介质，切回来就能看到产出。
let _taskActiveCtx = null;

function _taskSessionInfo() {
  if (typeof getCurrentSessionId !== 'function') return { sessionId: '', sessionTitle: '' };
  const sid = getCurrentSessionId() || '';
  const s = (sid && typeof getSessionById === 'function') ? getSessionById(sid) : null;
  return { sessionId: sid, sessionTitle: (s && s.title) || '' };
}

function _taskEsc(value) {
  const text = String(value == null ? '' : value);
  if (typeof escapeHtml === 'function') return escapeHtml(text);
  return text.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function _taskClip(text, limit) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function _taskFind(id) {
  return _taskActive.find(t => t.id === id) || _taskHistory.find(t => t.id === id) || null;
}

// 「未完成」= 还在手上 + 没干成的（失败/部分完成/被停/被中断）。
// 干成的（done）才进「已完成」页签——用户要的就是这一刀切干净。
function _taskUnfinished() {
  return _taskActive.concat(_taskHistory.filter(t => t.state !== 'done'));
}

function _taskDoneRecords() {
  return _taskHistory.filter(t => t.state === 'done');
}

function _taskNodeFind(task, nodeId) {
  return (task.nodes || []).find(n => n.id === nodeId) || null;
}

// ===== 账本：创建 / 更新 / 结束 =====

function _taskCreate(spec) {
  const opts = spec || {};
  const info = opts.sessionId
    ? { sessionId: opts.sessionId, sessionTitle: opts.sessionTitle || '' }
    : _taskSessionInfo();
  const task = {
    id: 'task_' + Date.now().toString(36) + '_' + (++_taskSeq).toString(36),
    kind: opts.kind || 'send',
    title: _taskClip(opts.title || '任务', TASK_TITLE_LIMIT),
    state: opts.state || 'waiting',
    sessionId: info.sessionId || '',
    sessionTitle: info.sessionTitle || '',
    createdAt: Date.now(),
    startedAt: opts.state === 'running' ? Date.now() : 0,
    endedAt: 0,
    note: '',
    paused: false,
    nodes: [],
    replay: opts.replay || null,
    canceller: null,
    cancelRequested: false,
  };
  _taskActive.unshift(task);
  _taskChanged();
  return task;
}

function _taskPatch(id, patch) {
  const task = _taskFind(id);
  if (!task || !patch) return task;
  Object.assign(task, patch);
  _taskChanged();
  return task;
}

function _taskBindCancel(id, canceller) {
  const task = _taskFind(id);
  if (task) task.canceller = typeof canceller === 'function' ? canceller : null;
}

function _taskMarkRunning(id) {
  const task = _taskFind(id);
  if (!task) return;
  task.state = 'running';
  task.startedAt = task.startedAt || Date.now();
  _taskChanged();
}

// 结束一条任务：从「进行中」挪进历史。重复调用安全（第二次找不到就什么都不做）。
function _taskFinish(id, state, note) {
  const task = _taskActive.find(t => t.id === id);
  if (!task) return;
  task.state = state || 'done';
  task.endedAt = Date.now();
  task.note = note ? _taskClip(note, 120) : '';
  task.paused = false;
  task.canceller = null;
  task.cancelRequested = false;
  _taskActive = _taskActive.filter(t => t.id !== id);
  _taskHistory.unshift(task);
  if (_taskHistory.length > TASK_HISTORY_LIMIT) _taskHistory.length = TASK_HISTORY_LIMIT;
  if (_taskActiveCtx && _taskActiveCtx.taskId === id) _taskActiveCtx = null;
  _taskChanged();
}

// ===== 节点条目 =====

function _taskNodeEnsure(task, nodeId, label) {
  let entry = _taskNodeFind(task, nodeId);
  if (entry) {
    if (label && !entry.label) entry.label = label;
    return entry;
  }
  if ((task.nodes || []).length >= TASK_NODE_LIMIT) return null;
  entry = {
    id: nodeId,
    label: label || '节点',
    state: 'waiting',
    startedAt: 0,
    endedAt: 0,
    note: '',
  };
  task.nodes.push(entry);
  return entry;
}

function _taskNodeStart(taskId, nodeId, label, canceller) {
  const ctx = _taskActiveCtx;
  const task = _taskActive.find(t => t.id === taskId);
  if (!task) return;
  const entry = _taskNodeEnsure(task, nodeId, label);
  if (entry) {
    entry.state = 'running';
    entry.startedAt = entry.startedAt || Date.now();
    entry.endedAt = 0;
    entry.note = '';
  }
  if (ctx && ctx.taskId === taskId && ctx.runtime && canceller) {
    ctx.runtime.nodeControllers.set(nodeId, canceller);
  }
  _taskChanged();
}

function _taskNodeFinish(taskId, nodeId, state, note) {
  const task = _taskActive.find(t => t.id === taskId);
  const ctx = _taskActiveCtx;
  if (ctx && ctx.taskId === taskId && ctx.runtime) ctx.runtime.nodeControllers.delete(nodeId);
  if (!task) return;
  const entry = _taskNodeEnsure(task, nodeId, '');
  if (!entry) return;
  entry.state = state || 'done';
  entry.endedAt = Date.now();
  if (note) entry.note = _taskClip(note, 80);
  _taskChanged();
}

function _taskCancelNode(taskId, nodeId) {
  const ctx = _taskActiveCtx;
  if (!ctx || ctx.taskId !== taskId || !ctx.runtime) return false;
  const controller = ctx.runtime.nodeControllers.get(nodeId);
  if (controller) {
    controller.abort();
    return true;
  }
  // 还没轮到的节点：登记进「用户停掉的」，调度口扫到它就跳过并把下游标成上游缺失
  ctx.runtime.userCancelled.add(nodeId);
  _taskNodeFinish(taskId, nodeId, 'stopped', '已取消');
  return true;
}

function _taskWasNodeCancelled(nodeId) {
  const ctx = _taskActiveCtx;
  return !!(ctx && ctx.runtime && ctx.runtime.userCancelled.has(nodeId));
}

// ===== 工作流任务：开场 / 收尾 / 会话上下文 =====

// 工作流任务开场。meta: { title, workNodes:[{id,label}], allIds:[...] }
// 返回 taskId；随后画布层的查找与保存都会走本任务的上下文。
function _tasksBeginWorkflow(meta) {
  const opts = meta || {};
  const workNodes = Array.isArray(opts.workNodes) ? opts.workNodes : [];
  const task = _taskCreate({
    kind: 'workflow',
    title: opts.title || '生成工作流',
    state: 'running',
    replay: { nodeIds: workNodes.map(n => n.id).slice(0, TASK_NODE_LIMIT), force: !!opts.force },
  });
  task.startedAt = Date.now();
  const ctx = {
    taskId: task.id,
    sessionId: task.sessionId,
    nodes: new Map(),
    ids: new Set(Array.isArray(opts.allIds) ? opts.allIds : workNodes.map(n => n.id)),
    runtime: {
      nodeControllers: new Map(),
      userCancelled: new Set(),
    },
  };
  for (const item of workNodes) _taskNodeEnsure(task, item.id, item.label);
  _taskActiveCtx = ctx;
  _taskSyncCtxNodes();
  _taskChanged();
  return task.id;
}

function _tasksEndWorkflow(taskId, state, note) {
  if (_taskActiveCtx && _taskActiveCtx.taskId === taskId) _taskActiveCtx = null;
  _taskFinish(taskId, state, note);
}

// 把任务上下文的节点重新绑到画布上的活对象。用户正看着任务所属会话时，两边是同一批
// 对象（画面实时）；切走之后任务改自己那份副本，靠 _taskSaveCtxNodes 落到会话 state。
function _taskSyncCtxNodes() {
  const ctx = _taskActiveCtx;
  if (!ctx) return;
  for (const id of ctx.ids) {
    const live = _taskLiveNode(id);
    if (live) ctx.nodes.set(id, live);
  }
}

function _taskLiveNode(nodeId) {
  if (typeof graphView !== 'undefined' && graphView && graphView.nodeById) {
    return graphView.nodeById[nodeId] || null;
  }
  return null;
}

// 画布层的查找覆盖：工作流任务跑动期间优先看任务自己的节点表（其余节点照旧走画布）。
function _taskNodeOverride(nodeId) {
  const ctx = _taskActiveCtx;
  if (!ctx) return null;
  return ctx.nodes.get(nodeId) || null;
}

// 画布层的保存出口覆盖：任务上下文活着时，_saveCustomNodes 改写到这里，落进
// **任务所属会话**的 state（按 id 合并，不碰该会话的其他节点）。切会话之所以不再
// 把产出写错画布，就是这一处 + _taskNodeOverride 顶住的（T59）。
function _taskSaveNodesOverride() {
  const ctx = _taskActiveCtx;
  if (!ctx) return false;
  _taskSaveCtxNodes(ctx);
  return true;
}

function _taskSaveCtxNodes(ctx) {
  if (!ctx.sessionId) return;
  if (typeof window.getGraphState !== 'function' || typeof window.saveGraphState !== 'function') return;
  const state = window.getGraphState(ctx.sessionId);
  if (!state || typeof state !== 'object') return;
  const kinds = (typeof GRAPH_CUSTOM_NODE_KINDS !== 'undefined') ? GRAPH_CUSTOM_NODE_KINDS : null;
  const mine = [];
  for (const node of ctx.nodes.values()) {
    if (!node || node.messageIndex >= 0) continue;
    if (kinds && !kinds.includes(node.kind)) continue;
    mine.push(Object.assign({}, node));
  }
  if (!mine.length) return;
  const existing = Array.isArray(state.customNodes) ? state.customNodes : [];
  const byId = new Map(existing.map(item => [String(item && item.id), item]));
  for (const node of mine) byId.set(String(node.id), node);
  state.customNodes = [...byId.values()];
  window.saveGraphState(ctx.sessionId, state);
}

function _taskCtxPaused() {
  const ctx = _taskActiveCtx;
  if (!ctx) return false;
  const task = _taskActive.find(t => t.id === ctx.taskId);
  return !!(task && task.paused);
}

// ===== 暂停 / 停止 =====

function _taskPauseToggle(id) {
  const task = _taskActive.find(t => t.id === id);
  if (!task || task.kind !== 'workflow' || task.state === 'waiting') return;
  task.paused = !task.paused;
  task.state = task.paused ? 'paused' : 'running';
  task.note = task.paused ? '不再派新节点，已在跑的跑完' : '';
  _taskChanged();
}

function _taskCancel(id) {
  const task = _taskFind(id);
  if (!task) return;
  if (task.state === 'waiting') {
    // 排队中没发出去的：单条取消就是直接从队里拿掉（send-queue.js 提供摘除钩子）
    if (typeof _removeQueuedSend === 'function' && _removeQueuedSend(id)) return;
    _taskFinish(id, 'stopped', '已取消');
    return;
  }
  if (task.canceller) {
    task.cancelRequested = true;
    task.note = '停止中…';
    _taskChanged();
    try {
      task.canceller();
    } catch (err) {
      console.warn('[Tasks] cancel failed:', err);
    }
    return;
  }
  _taskFinish(id, 'stopped', '已取消');
}

function _tasksStopAll() {
  const active = [..._taskActive];
  if (!active.length) return;
  for (const task of active) _taskCancel(task.id);
  if (typeof showToast === 'function') showToast('已停止 ' + active.length + ' 条任务');
}

// 一键清除「已完成」记录（用户 2026-09-27 要求）。只动干成的那些：
// 失败/中断的留在「未完成」页签上，等用户重试或自己删掉——清记录不该把待办也清了。
function _tasksClearDone() {
  const before = _taskHistory.length;
  _taskHistory = _taskHistory.filter(t => t.state !== 'done');
  const removed = before - _taskHistory.length;
  if (!removed) {
    if (typeof showToast === 'function') showToast('没有可清除的完成记录');
    return;
  }
  _taskChanged();
  if (typeof showToast === 'function') showToast('已清除 ' + removed + ' 条完成记录');
}

// 删单条记录（历史里的那些）。在跑的活儿删不掉——要删先停。
function _taskForget(id) {
  const before = _taskHistory.length;
  _taskHistory = _taskHistory.filter(t => t.id !== id);
  if (_taskHistory.length !== before) _taskChanged();
}

// ===== 重新生成（关页面后重开那条路） =====

async function _taskRegenerate(id) {
  const task = _taskFind(id);
  if (!task) return;
  const replay = task.replay || null;
  if (!task.sessionId || typeof getSessionById !== 'function' || !getSessionById(task.sessionId)) {
    if (typeof showToast === 'function') showToast('它所属的画布已经删掉了，没法重新生成');
    return;
  }
  if (typeof switchToSession === 'function' && typeof getCurrentSessionId === 'function'
      && getCurrentSessionId() !== task.sessionId) {
    await switchToSession(task.sessionId);
  }
  if (typeof getCurrentSessionId === 'function' && getCurrentSessionId() !== task.sessionId) {
    if (typeof showToast === 'function') showToast('没能切到它所属的画布，请先手动切过去再试');
    return;
  }
  if (task.kind === 'workflow' && replay && replay.nodeIds && replay.nodeIds.length) {
    if (typeof runWorkflowNodes !== 'function') return;
    const ok = await runWorkflowNodes(replay.nodeIds, !!replay.force);
    if (!ok && typeof showToast === 'function') showToast('那些节点已经不在画布上了，没法重新生成');
    return;
  }
  if (replay && replay.text) {
    // 发送类任务的锚点没法跨重载还原（锚在画布节点上），所以只能把内容交回给用户
    if (typeof showToast === 'function') {
      showToast('这条依赖画布上的锚点，没法自动重发；上次的内容是：' + _taskClip(replay.text, 60), 6000);
    }
    return;
  }
  if (typeof showToast === 'function') showToast('这条任务没有留下可重放的内容');
}

// ===== 变更通知 / 落盘 =====

function _taskChanged() {
  _taskRenderSoon();
  _taskPersistSoon();
}

// 落盘：服务端 kv 全局键。防抖 400ms；页面隐藏/关闭时立即冲刷（否则「已中断」
// 标记要等下一次打开才知道该标谁）。
function _taskPersistSoon() {
  if (_taskPersistTimer) return;
  _taskPersistTimer = setTimeout(() => {
    _taskPersistTimer = null;
    _taskPersistNow();
  }, 400);
}

function _taskSnapshot() {
  const all = _taskActive.concat(_taskHistory);
  return {
    version: 1,
    updatedAt: Date.now(),
    tasks: all.map(t => ({
      id: t.id,
      kind: t.kind,
      title: t.title,
      state: t.state,
      sessionId: t.sessionId,
      sessionTitle: t.sessionTitle,
      createdAt: t.createdAt,
      startedAt: t.startedAt,
      endedAt: t.endedAt,
      note: t.note,
      paused: t.paused,
      replay: t.replay,
      nodes: (t.nodes || []).map(n => ({
        id: n.id,
        label: n.label,
        state: n.state,
        startedAt: n.startedAt,
        endedAt: n.endedAt,
        note: n.note,
      })),
    })),
  };
}

function _taskPersistNow() {
  if (typeof fetch !== 'function' || !TASK_KV_KEY) return;
  try {
    fetch('/api/kv/' + encodeURIComponent(TASK_KV_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: _taskSnapshot() }),
    }).catch(() => {});
  } catch (err) { /* 离线/被拦时静默：任务列表是账本，不能因为它挂了就影响干活 */ }
}

function _taskPersistBeacon() {
  if (_taskPersistTimer) {
    clearTimeout(_taskPersistTimer);
    _taskPersistTimer = null;
  }
  if (typeof fetch !== 'function') return;
  try {
    fetch('/api/kv/' + encodeURIComponent(TASK_KV_KEY), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: _taskSnapshot() }),
      keepalive: true,
    }).catch(() => {});
  } catch (err) { /* 同上 */ }
}

// 重开页面：上一轮没跑完的任务标「已中断」（页面关掉就等于活儿断了），历史照旧留着。
function _taskSplitLoaded(raw) {
  const tasks = Array.isArray(raw) ? raw : [];
  const active = [];
  const history = [];
  for (const item of tasks) {
    if (!item || !item.id) continue;
    const task = {
      id: String(item.id),
      kind: item.kind === 'workflow' ? 'workflow' : 'send',
      title: _taskClip(item.title || '任务', TASK_TITLE_LIMIT),
      state: item.state || 'done',
      sessionId: item.sessionId || '',
      sessionTitle: item.sessionTitle || '',
      createdAt: Number(item.createdAt) || 0,
      startedAt: Number(item.startedAt) || 0,
      endedAt: Number(item.endedAt) || 0,
      note: _taskClip(item.note || '', 120),
      paused: false,
      replay: item.replay || null,
      nodes: Array.isArray(item.nodes) ? item.nodes.slice(0, TASK_NODE_LIMIT).map(n => ({
        id: n && n.id, label: (n && n.label) || '节点', state: (n && n.state) || 'waiting',
        startedAt: Number(n && n.startedAt) || 0, endedAt: Number(n && n.endedAt) || 0,
        note: (n && n.note) || '',
      })) : [],
      canceller: null,
      cancelRequested: false,
    };
    if (task.state === 'running' || task.state === 'waiting' || task.state === 'paused') {
      task.state = 'interrupted';
      task.endedAt = task.endedAt || Date.now();
      task.note = '页面已关闭，这轮没跑完';
      task.nodes.forEach(n => {
        if (n.state === 'running' || n.state === 'waiting') n.state = 'stopped';
      });
    }
    history.push(task);
  }
  history.sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
  return { active, history: history.slice(0, TASK_HISTORY_LIMIT) };
}

async function _taskLoadFromServer() {
  if (_taskLoaded || typeof fetch !== 'function') return;
  _taskLoaded = true;
  try {
    const resp = await fetch('/api/kv/' + encodeURIComponent(TASK_KV_KEY), { cache: 'no-cache' });
    if (!resp || !resp.ok) return;
    const data = await resp.json();
    const value = data && data.value;
    if (!value || !Array.isArray(value.tasks)) return;
    // 页面刚打开、内存账本还是空的：服务端那份就是全部历史
    const split = _taskSplitLoaded(value.tasks);
    if (!_taskActive.length && !_taskHistory.length) {
      _taskActive = split.active;
      _taskHistory = split.history;
    } else {
      // 页面已经自己开了活儿（用户在加载回来之前就发了请求）：只补历史里没见过的，
      // **绝不动活账本**——把正在进行中的任务标成「已中断」是「页面被关掉」的意思，
      // 不是「回填晚了一步」的意思（这个竞态真机上真会踩到：点开面板就是一次回填）。
      for (const task of split.history) {
        if (!_taskHistory.some(t => t.id === task.id)) _taskHistory.push(task);
      }
      _taskHistory.sort((a, b) => (b.endedAt || b.createdAt) - (a.endedAt || a.createdAt));
      if (_taskHistory.length > TASK_HISTORY_LIMIT) _taskHistory.length = TASK_HISTORY_LIMIT;
    }
    _taskRenderSoon();
  } catch (err) {
    console.warn('[Tasks] load failed:', err);
  }
}

// ===== 面板渲染 =====

function _taskAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const hh = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return '今天 ' + hh;
  const yesterday = new Date(today.getTime() - 86400000);
  if (d.toDateString() === yesterday.toDateString()) return '昨天 ' + hh;
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hh;
}

function _taskElapsed(from, to) {
  const start = from || 0;
  if (!start) return '';
  const end = to || Date.now();
  const sec = Math.max(0, Math.round((end - start) / 1000));
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + ' 分 ' + (sec % 60) + ' 秒';
  return Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分';
}

function _taskStateLine(task) {
  const text = TASK_STATE_TEXT[task.state] || task.state;
  const parts = [text];
  if (task.state === 'running') parts.push(_taskElapsed(task.startedAt, 0));
  if (task.note) parts.push(task.note);
  return parts.filter(Boolean).join(' · ');
}

// 状态字形。**进行中不用 ⟳ 字符**：字符的墨迹中心与字形盒中心不重合，
// rotate 起来看着偏心、还会一跳一跳（用户 2026-09-27 反馈）。改成 CSS 画的圆环，
// 同圆心、匀速，和画布上「生成中」徽章那个圈是同一套视觉。
function _taskGlyphHtml(state) {
  if (state === 'running') return '<span class="task-spin"></span>';
  return TASK_STATE_GLYPH[state] || '⋯';
}

function _taskNodeGlyphHtml(state) {
  if (state === 'running') return '<span class="task-spin task-spin--sm"></span>';
  return TASK_NODE_GLYPH[state] || '⋯';
}

function _taskActionsHtml(task) {
  const buttons = [];
  if (task.state === 'waiting') {
    buttons.push('<button type="button" class="task-btn" data-task-action="cancel">取消</button>');
  } else if (task.state === 'running' || task.state === 'paused') {
    if (task.kind === 'workflow') {
      buttons.push('<button type="button" class="task-btn" data-task-action="pause">'
        + (task.paused ? '继续' : '暂停') + '</button>');
    }
    buttons.push('<button type="button" class="task-btn task-btn--warn" data-task-action="cancel"'
      + (task.cancelRequested ? ' disabled' : '') + '>'
      + (task.cancelRequested ? '停止中' : '停止') + '</button>');
  }
  return buttons.join('');
}

function _taskNodeRowHtml(task, entry) {
  const text = TASK_NODE_TEXT[entry.state] || entry.state;
  const timing = entry.state === 'running'
    ? ' ' + _taskElapsed(entry.startedAt, 0)
    : (entry.endedAt && entry.startedAt ? ' ' + _taskElapsed(entry.startedAt, entry.endedAt) : '');
  const cancelable = (task.state === 'running' || task.state === 'paused') && entry.state !== 'done';
  const note = entry.note ? '<span class="task-node-note">' + _taskEsc(entry.note) + '</span>' : '';
  return '<div class="task-node-row state-' + _taskEsc(entry.state) + '">'
    + '<span class="task-node-glyph">' + _taskNodeGlyphHtml(entry.state) + '</span>'
    + '<span class="task-node-label">' + _taskEsc(entry.label) + '</span>'
    + '<span class="task-node-state">' + _taskEsc(text + timing) + '</span>'
    + note
    + (cancelable ? '<button type="button" class="task-btn task-btn--mini" data-task-action="cancel-node" data-node-id="'
        + _taskEsc(entry.id) + '">停</button>' : '')
    + '</div>';
}

function _taskRowHtml(task, options) {
  const opts = options || {};
  const expanded = !!_taskExpanded[task.id];
  const hasNodes = task.kind === 'workflow' && (task.nodes || []).length > 0;
  const doneCount = (task.nodes || []).filter(n => n.state === 'done').length;
  const caret = hasNodes
    ? '<button type="button" class="task-caret' + (expanded ? ' open' : '') + '" data-task-action="expand" title="'
      + (expanded ? '收起' : '展开') + '节点">' + (expanded ? '▾' : '▸') + '</button>'
    : '<span class="task-caret task-caret--empty"></span>';
  const meta = [];
  if (task.sessionTitle || task.sessionId) meta.push('会话：' + _taskEsc(task.sessionTitle || task.sessionId));
  if (hasNodes) meta.push(doneCount + '/' + task.nodes.length + ' 已完成');
  const stateLine = _taskEsc(_taskStateLine(task));
  const time = opts.history ? _taskAgo(task.endedAt || task.createdAt) : '';
  const buttons = [];
  // 没干成的（失败/部分完成/被停/被中断）：一键重试。工作流类能真重跑它那几颗节点。
  // 一律给按钮、不按「有没有可重放内容」藏起来——失败行上没有重试入口，用户只会
  // 以为功能没做；真重放不了时 `_taskRegenerate` 会当面说清楚为什么。
  if (opts.history && task.state !== 'done') {
    buttons.push('<button type="button" class="task-btn" data-task-action="retry">重试</button>');
  }
  // 历史记录可以单条删掉（在跑的删不掉——要删先停）
  if (opts.history) {
    buttons.push('<button type="button" class="task-btn task-btn--mini" data-task-action="forget" title="删除这条记录">✕</button>');
  }
  const nodes = (hasNodes && expanded)
    ? '<div class="task-node-list">' + task.nodes.map(entry => _taskNodeRowHtml(task, entry)).join('') + '</div>'
    : '';
  return '<div class="task-item state-' + _taskEsc(task.state) + (opts.history ? ' task-item--history' : '')
    + '" data-task-id="' + _taskEsc(task.id) + '">'
    + '<div class="task-row-main">'
    + caret
    + '<span class="task-glyph">' + _taskGlyphHtml(task.state) + '</span>'
    + '<span class="task-title" title="' + _taskEsc(task.title) + '">' + _taskEsc(task.title) + '</span>'
    + '<span class="task-btns">' + (buttons.join('') + _taskActionsHtml(task)) + '</span>'
    + '</div>'
    + '<div class="task-row-sub">' + (meta.length ? '<span>' + meta.join(' · ') + '</span>' : '')
    + '<span class="task-state-text">' + stateLine + (time ? ' · ' + time : '') + '</span></div>'
    + nodes
    + '</div>';
}

function _taskTabsHtml() {
  const unfinished = _taskUnfinished().length;
  const done = _taskDoneRecords().length;
  const tab = (key, label, count) => '<button type="button" class="task-tab'
    + (_taskTab === key ? ' active' : '') + '" data-task-tab="' + key + '">' + label
    + (count ? '<span class="task-tab-count">' + count + '</span>' : '') + '</button>';
  return '<div class="task-tabs">'
    + tab('active', '未完成', unfinished)
    + tab('done', '已完成', done)
    + '</div>';
}

function _taskPanelHtml() {
  const body = [_taskTabsHtml()];
  if (_taskTab === 'active') {
    const rows = _taskActive.map(t => _taskRowHtml(t, {}))
      .concat(_taskHistory.filter(t => t.state !== 'done').map(t => _taskRowHtml(t, { history: true })));
    body.push(rows.length
      ? rows.join('')
      : '<div class="task-empty">暂无</div>');
  } else {
    const rows = _taskDoneRecords().map(t => _taskRowHtml(t, { history: true }));
    body.push(rows.length
      ? rows.join('')
      : '<div class="task-empty">暂时没有已完成的任务记录</div>');
  }
  return body.join('');
}

function _renderTaskPanel() {
  _taskRenderTimer = null;
  if (!_taskPanelOpen) return;
  const panel = document.getElementById('taskPanel');
  if (!panel) return;
  const body = panel.querySelector('.task-panel-body') || document.getElementById('taskPanelBody');
  if (body) body.innerHTML = _taskPanelHtml();
  // 两个入口（顶栏三角 / 胶囊上的列表按钮）同步徽标：数的是「未完成」，
  // 失败/中断的那些留在计数里，直到用户重试或删掉——账不能自己消失。
  const count = _taskUnfinished().length;
  const hasRunning = _taskActive.some(t => t.state === 'running');
  for (const id of ['taskPanelBtn', 'progressTaskBtn']) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.classList.toggle('has-active', count > 0);
    btn.classList.toggle('is-running', hasRunning);
    const badge = btn.querySelector('.task-panel-badge');
    if (badge) {
      badge.textContent = count ? String(count) : '';
      badge.hidden = count === 0;
    }
  }
  const stopAll = document.getElementById('taskPanelStopAll');
  if (stopAll) {
    stopAll.hidden = _taskTab !== 'active';
    stopAll.disabled = _taskActive.length === 0;
  }
  const clearDone = document.getElementById('taskPanelClearDone');
  if (clearDone) {
    clearDone.hidden = _taskTab !== 'done';
    clearDone.disabled = _taskDoneRecords().length === 0;
  }
}

function _taskRenderSoon() {
  if (_taskRenderTimer) return;
  _taskRenderTimer = setTimeout(_renderTaskPanel, 120);
}

function _taskTickStart() {
  if (_taskTickTimer) return;
  _taskTickTimer = setInterval(() => {
    if (!_taskPanelOpen) return;
    if (_taskActive.some(t => t.state === 'running')) _renderTaskPanel();
  }, 1000);
}

function _taskTickStop() {
  if (_taskTickTimer) {
    clearInterval(_taskTickTimer);
    _taskTickTimer = null;
  }
}

function toggleTaskPanel(e) {
  if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
  const panel = document.getElementById('taskPanel');
  if (!panel) return;
  const willShow = !panel.classList.contains('show');
  panel.classList.toggle('show', willShow);
  _taskPanelOpen = willShow;
  if (willShow) {
    if (typeof _positionPanel === 'function') {
      void panel.offsetHeight;
      _positionPanel('taskPanel', (e && e.currentTarget) || document.getElementById('taskPanelBtn'));
      // 胶囊停在屏幕下方时，面板挂在它下面会有一截探出视口——头部那排按钮就点不到了
      // （真机自测逮到的：playwright 点「清除记录」一直等不到元素可点）。整块往上挪回来：
      // 宁可盖住胶囊，也不能让面板的头掉出屏幕。
      const rect = panel.getBoundingClientRect();
      const overflow = rect.bottom - ((window.innerHeight || 0) - 8);
      if (overflow > 0) panel.style.top = Math.max(8, rect.top - overflow) + 'px';
    }
    _taskLoadFromServer();
    _renderTaskPanel();
    _taskTickStart();
  } else {
    _taskTickStop();
  }
}

function _taskPanelClick(e) {
  const target = e.target;
  if (!target || typeof target.closest !== 'function') return;
  const tabEl = target.closest('[data-task-tab]');
  if (tabEl) {
    e.preventDefault();
    e.stopPropagation();
    _taskTab = tabEl.getAttribute('data-task-tab') === 'done' ? 'done' : 'active';
    _renderTaskPanel();
    return;
  }
  const actionEl = target.closest('[data-task-action]');
  if (!actionEl) return;
  const action = actionEl.getAttribute('data-task-action');
  const item = actionEl.closest('.task-item');
  const taskId = item ? item.getAttribute('data-task-id') : '';
  if (!taskId) return;
  e.preventDefault();
  e.stopPropagation();
  if (action === 'expand') {
    _taskExpanded[taskId] = !_taskExpanded[taskId];
    _renderTaskPanel();
    return;
  }
  if (action === 'pause') { _taskPauseToggle(taskId); return; }
  if (action === 'cancel') { _taskCancel(taskId); return; }
  if (action === 'cancel-node') { _taskCancelNode(taskId, actionEl.getAttribute('data-node-id')); return; }
  if (action === 'retry') { _taskRegenerate(taskId); return; }
  if (action === 'forget') { _taskForget(taskId); return; }
}

function _initTaskPanel() {
  const panel = document.getElementById('taskPanel');
  if (!panel || panel.dataset.bound) return;
  panel.dataset.bound = '1';
  panel.addEventListener('click', _taskPanelClick);
  _renderTaskPanel();
  _taskLoadFromServer();
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('click', (e) => {
      if (!_taskPanelOpen) return;
      // 事件处理器里重建过 DOM（面板每次刷新都重写 innerHTML）时，e.target 可能已脱离
      // 文档——此时 contains 恒为 false，会把「面板内点击」误判成「点外部」而把面板
      // 自己关掉（真机自测逮到的：点页签后面板消失）。ui.js:457 早记过同一个坑。
      if (!e.target || !e.target.isConnected) return;
      const btn = document.getElementById('taskPanelBtn');
      if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
      panel.classList.remove('show');
      _taskPanelOpen = false;
      _taskTickStop();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') _taskPersistBeacon();
    });
    if (typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', _taskPersistBeacon);
    }
  }
  _taskTickStart();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initTaskPanel);
  } else {
    _initTaskPanel();
  }
}

// 行内 onclick 只用到这三个；面板内部的按钮走事件委托，不往全局撒函数。
window.toggleTaskPanel = toggleTaskPanel;
window.stopAllTasks = _tasksStopAll;
window.clearDoneTasks = _tasksClearDone;
