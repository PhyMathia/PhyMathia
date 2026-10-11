// ===== PhyMathia 排队台：AI 忙的时候先收下，轮到它再跑 =====
//
// 为什么有这个东西（docs/backlog.md T42）：
// 发送入口过去一律是裸 `if (正在生成) return;`——不弹提示、不置灰、不留痕。
// 一次工作流在免费模型上要跑 2-8 分钟，这个「忙」窗口长得离谱，撞上的概率很高；
// 用户看到的就是弹窗原样留着、节点毫无变化，于是以为按钮坏了，反复点。
// 真发验证脚本只能靠「每条通道前等工作流空闲」绕开，**但用户没有这个绕法**。
//
// 2026-10-11 扩成通用队列（用户：「我给他设置任务列表就是想要可以启动多个任务排队的」）：
// 过去只有「发送」这一条链排队，画布上点节点生成撞上忙碌一律拒绝（toast 挡回去）。
// 现在**所有会占住 AI 的入口**都从这里过——发送（提问/追问/苏格拉底/Φ）与画布上的
// 节点活儿（生成/重新生成/空白节点/可视化/全部生成）。忙的时候点什么都当场有回音：
// 收进队列、任务列表上看得见（等待中）、轮到自己时把视图带回它所属的画布再原样跑一遍。
// 一次仍然只跑一件（用户 2026-09-27 拍板），队列只是让"排在后面"成为可能。
//
// 为什么选「排队」而不是「置灰」：
// 置灰宣告的是「这功能不可用」，可这里按钮是可用的——只是要等。纯置灰的结果是
// 用户的字仍然悬在输入框里、仍然得自己再点一次，症状只从「像坏了」变成「像坏了
// 而且不让我点」。排队让点击当场有回音：弹窗立刻关、字有去处、底部看得见还剩几条。
// 这是 ChatGPT / Claude 的做法。
//
// 为什么不改发送锁的语义：
// `isStreaming` 一行动没动，队列逻辑全部排在锁**之前**同步完成，因此
// 「发送锁覆盖首个异步等待」这条冻结契约（docs/dev/linear-chat-retired.md）原样成立。
// 改的只是撞上锁之后发生什么：从「静默丢弃」变成「排队」。
//
// 队列里存的不是「消息体」而是**闭包**：每个入口把自己的活儿整个包成 run()，
// 空闲后原样再跑一遍。这样各入口原有的收尾动作（苏格拉底的 kv 落盘、分支锚点
// 消费、弹窗关闭时序）不用拆开重写——没走排队那条路时行为一字不变。

var _sendQueue = [];
// 队列正在放行中。真实忙碌位（isStreaming / workflowRunActive）要到第一条发送
// 真正开跑才置上，而那之前隔着模板构建、首个节点分析等若干 await——用户在这个
// 空窗里再点一次「提问」就会并发开出第二个工作流。这个标志把空窗也堵上。
var _sendQueueFlushing = false;

// 真实的忙碌状态：只看业务标志位，不含本文件自己的放行标志。
// Φ（harness）也在这个语义里：它同样在「生成本轮回答」，且它也支持排队（T90），
// 漏掉它会让 Φ 跑着的时候队列被误判成空闲、并发开跑。typeof 守卫是因为沙箱
// 可能只加载本文件（没加载 harness.js），那里它应当被当作「不忙」。
function _isActuallyBusy() {
  if (typeof isStreaming !== 'undefined' && isStreaming) return true;
  if (typeof workflowRunActive !== 'undefined' && workflowRunActive) return true;
  if (typeof harnessBusy !== 'undefined' && harnessBusy) return true;
  return false;
}

// 忙碌判定集中在这里，因为「忙」有两个来源：分支/苏格拉底流式回答（isStreaming）
// 和画布工作流（workflowRunActive）。过去 startQuestionWorkflow 只查 isStreaming，
// 而工作流全程不碰 isStreaming（它走 _generateAnalysis → proxyChat，不经过 sendMessage），
// 于是那个守卫对它自己的通道形同虚设——工作流跑着还能再点一次「提问」，
// 并发开出第二个工作流、两棵节点树打架。收敛到这里，两条路都覆盖。
function _isSendBusy() {
  if (_sendQueueFlushing) return true;
  return _isActuallyBusy();
}

function _hasPendingSend() {
  return _sendQueue.length > 0;
}

// 收下一次发送请求。label 只用于提示文案（「苏格拉底回答」「追问」…），
// run 必须返回 promise：flush 靠 await 它来保证下一条等上一条真的发出去了。
// meta（可选）：{ text, title, kind, replay, sessionId, sessionTitle }。
//   · text   = 用户那句话，给任务列表当标题与重放内容；
//   · title  = 显式标题（节点生成这类活儿没有"用户那句话"，用它写「生成数学视角」）；
//   · kind   = 任务种类（'send' / 'workflow' / 'node'），决定面板上的重试语义；
//   · replay = 显式重放描述（节点活儿要给 nodeIds / nodeJob，重试才找得到地方重跑）。
// 不传会话时按当前会话记账（任务列表那条「自带来处」的约定，见 tasks.js）。
//
// 2026-10-11（用户：「设置了任务列表就是想要可以启动多个任务排队」）：这台队列过去只服务
// 「发送」那一条链，画布上点节点生成撞上忙碌一律拒绝（toast「稍候再单独生成这个节点」）。
// 现在它是通用的活儿队列——发送、工作流、单节点生成全从这儿过，忙时一律收下，
// 轮到自己时把视图带回它所属的画布再原样跑一遍。
function _enqueueSend(label, run, meta) {
  if (typeof run !== 'function') return false;
  const name = label || '请求';
  const opts = meta || {};
  const info = (typeof _taskSessionInfo === 'function')
    ? _taskSessionInfo()
    : { sessionId: '', sessionTitle: '' };
  // 排队中的每一条也是一条任务（用户拍板 #6），并且**自带来处**：排队期间切到别的画布，
  // 轮到它时能自己找回去（会话寻址），不再像过去那样「一换画布整队被丢弃」。
  const task = (typeof _taskCreate === 'function')
    ? _taskCreate({
        kind: opts.kind || 'send',
        title: opts.title ? String(opts.title) : (opts.text ? String(opts.text) : name),
        state: 'waiting',
        sessionId: opts.sessionId || info.sessionId,
        sessionTitle: opts.sessionTitle || info.sessionTitle,
        replay: opts.replay || (opts.text ? { text: String(opts.text).slice(0, 500) } : null),
      })
    : null;
  _sendQueue.push({
    label: name,
    run,
    taskId: task ? task.id : null,
    sessionId: task ? task.sessionId : info.sessionId,
    dedupeKey: opts.dedupeKey || null,
  });
  _renderQueueChip();
  toastMsg('已收到「' + name + '」，当前任务完成后自动开始');
  return true;
}

// 画布上的活儿（单节点/工作流）排队入口。与发送的区别只有两点：
//   · 标题用活儿自己的名字（这类活儿没有"用户那句话"）；
//   · 记下节点 id 与种类，面板上的「重试」才找得到地方重跑（tasks.js 的 replay 约定）。
// 闭包必须把「放行」标志一路带下去（runWorkflowNode/generateBlankNode 的 fromQueue）：
// 放行时 _isSendBusy() 仍含着 _sendQueueFlushing（队列正在放行）这个空窗标志，
// 没有旁路会原地自我重入、事件循环被饿死、页面假死（T225）。
// 连点去重（T280，2026-10-11）：同一颗节点的同一动作在「等待中」已有排队时不再收第二条。
// 不去重的代价：节点排队期间自身不 busy，各入口的 busy 闸门拦不住第二下，「重新生成」
// 连点两下＝两条都进队，轮到后连跑两遍——第二遍烧一次模型钱，买回来的还是同样的产出。
// 去重键从 meta.replay 派生（两种既有形状都够用，调用点零改动）：
//   · replay.nodeJob = {id, kind} → '<kind>|job|<动作>|<节点id>'（viz / 重新生成 / 空白节点）；
//   · replay.nodeIds = [...]     → '<kind>|ids|<排序后的 id 表>'（工作流单颗/多颗、知识/联系）。
// 派生不出键（两者都没有）就放行＝行为同旧。重新生成不看要求文本：同颗节点等待中只收
// 一条，想换要求先在任务列表把等待那条取消。只看等待中（_sendQueue）：正在跑的那条已
// 出队且节点自身 busy，此刻再点是「跑完再改一遍」的明确意图，照旧收下；取消/整队丢弃
// 之后键自动解除，可以重排。
function _nodeJobDedupeKey(opts) {
  const replay = opts.replay || {};
  if (replay.nodeJob && replay.nodeJob.id != null) {
    return (opts.kind || 'node') + '|job|' + (replay.nodeJob.kind || '') + '|' + replay.nodeJob.id;
  }
  if (Array.isArray(replay.nodeIds) && replay.nodeIds.length) {
    return (opts.kind || 'node') + '|ids|' + replay.nodeIds.map(String).sort().join(',');
  }
  return null;
}

function _enqueueNodeJob(label, run, meta) {
  const opts = meta || {};
  const dedupeKey = _nodeJobDedupeKey(opts);
  if (dedupeKey && _sendQueue.some(item => item.dedupeKey === dedupeKey)) {
    toastMsg('「' + (opts.title || label) + '」已经在排队了，轮到后会自动跑');
    return false;
  }
  return _enqueueSend(label, run, {
    title: opts.title || label,
    kind: opts.kind || 'node',
    replay: opts.replay || null,
    sessionId: opts.sessionId,
    sessionTitle: opts.sessionTitle,
    dedupeKey: dedupeKey,
  });
}

// 排队任务轮到执行时的兜底：它盯的那颗节点已经不在了（换过画布、被删、被撤销回放）。
// 就地结账标「失败」，别让队列放行后那条「等待中」被 flush 顺手记成「已完成」——
// 活儿根本没干，账不能平（run 里先结掉的话，flush 那次 _taskFinish 找不到活账、自然空转）。
function _queuedJobNodeGuard(taskId, nodeId) {
  if (typeof _findGraphNode === 'function' && _findGraphNode(nodeId)) return true;
  if (typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '节点已不在画布上');
  if (typeof showToast === 'function') showToast('轮到这条时，那颗节点已经不在画布上了');
  return false;
}

// 单条取消（任务列表面板上的「取消」）。返回 true 表示确实从队里摘掉了一条。
function _removeQueuedSend(taskId) {
  const index = _sendQueue.findIndex(item => item.taskId && item.taskId === taskId);
  if (index < 0) return false;
  const item = _sendQueue.splice(index, 1)[0];
  _renderQueueChip();
  if (typeof _taskFinish === 'function') _taskFinish(item.taskId, 'stopped', '已取消');
  return true;
}

// 轮到自己时先把视图带回它所属的画布。任务自带来处，而发送这条通道（分支/苏格拉底）
// 与画布上的节点活儿（生成/重新生成）都只能落在"当前画布"上，所以只能这样兑现；
// 工作流那条长通道不切视图，它自带上下文。
async function _sendQueueReady(item) {
  const sid = item.sessionId;
  const current = (typeof getCurrentSessionId === 'function') ? getCurrentSessionId() : '';
  if (!sid || sid === current) {
    if (typeof _taskMarkRunning === 'function') _taskMarkRunning(item.taskId);
    return true;
  }
  const exists = (typeof getSessionById === 'function') && getSessionById(sid);
  if (!exists || typeof switchToSession !== 'function') {
    if (typeof _taskFinish === 'function') _taskFinish(item.taskId, 'error', '它所属的画布已被删除');
    toastMsg('已跳过一条排队的活儿：它所属的画布已被删除');
    return false;
  }
  await switchToSession(sid);
  if (typeof getCurrentSessionId === 'function' && getCurrentSessionId() !== sid) {
    if (typeof _taskFinish === 'function') _taskFinish(item.taskId, 'error', '切回画布失败');
    return false;
  }
  toastMsg('轮到「' + item.label + '」了，已切回它所在的画布');
  if (typeof _taskMarkRunning === 'function') _taskMarkRunning(item.taskId);
  return true;
}

// 空闲时把队列逐条发出去。**必须依次 await，不能并发**：苏格拉底那条要先落一次
// kv 才真正发送，如果并发发，第二条会在第一条还没占上发送锁时挤进去，两个流撞在一起。
// 循环条件看的是 _isActuallyBusy（不含放行标志），一条发起来后它立刻为真，循环自然收尾。
async function _flushSendQueue() {
  if (!_sendQueue.length) return;
  if (_sendQueueFlushing || _isActuallyBusy()) return;
  _sendQueueFlushing = true;
  try {
    while (_sendQueue.length && !_isActuallyBusy()) {
      const item = _sendQueue.shift();
      _renderQueueChip();
      if (!(await _sendQueueReady(item))) continue;
      try {
        await item.run(item.taskId);
        if (typeof _taskFinish === 'function') _taskFinish(item.taskId, 'done');
      } catch (err) {
        console.warn('Queued send failed:', item.label, err);
        if (typeof _taskFinish === 'function') {
          _taskFinish(item.taskId, 'error', (err && err.message) || '发送失败');
        }
      }
    }
  } finally {
    _sendQueueFlushing = false;
    _renderQueueChip();
  }
}

function _clearSendQueue(reason) {
  if (!_sendQueue.length) return;
  const n = _sendQueue.length;
  const items = _sendQueue;
  _sendQueue = [];
  _renderQueueChip();
  // 队伍被整队丢掉 = 那些等待中的任务也结束了，在面板上留个痕，别凭空消失
  if (typeof _taskFinish === 'function') {
    for (const item of items) _taskFinish(item.taskId, 'stopped', reason || '已丢弃');
  }
  if (reason) toastMsg(reason + '（已丢弃 ' + n + ' 条排队的活儿）');
}

// 「排队 N」标记挂在进度胶囊里——那是用户盯着等的时候本来就在看的地方，
// 不用去学一个全新的位置。点它 = 全部丢弃，反悔的唯一出口。
// 2026-10-11 文案从「待发送」改成「排队」：这台队列现在也装画布上的节点活儿，
// 「待发送」会把「等一张图生成」说成「等一条消息」。
function _renderQueueChip() {
  const chip = document.getElementById('sendQueueChip');
  if (!chip) return;
  const n = _sendQueue.length;
  chip.textContent = n > 0 ? '排队 ' + n : '';
  chip.hidden = n === 0;
  if (n === 0) {
    chip.removeAttribute('title');
    return;
  }
  chip.title = '点击丢弃全部排队任务';
  // 队列非空却不在生成中（正常只发生在收队与 flush 之间的那一瞬），
  // 胶囊可能正处在 hideProgress 的延迟退场倒计时里——把标记露出来，别让它跟着一起消失。
  const capsule = document.getElementById('progressStatus');
  if (capsule && !capsule.classList.contains('active')) capsule.classList.add('active');
}

function _initSendQueue() {
  const chip = document.getElementById('sendQueueChip');
  if (chip && !chip.dataset.bound) {
    chip.dataset.bound = '1';
    chip.addEventListener('click', function() {
      _clearSendQueue('已丢弃排队任务');
    });
  }
  _renderQueueChip();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initSendQueue);
  } else {
    _initSendQueue();
  }
}
