#!/usr/bin/env node
// 任务列表回归（2026-09-27）：账本语义 + 三条接线契约，真实源码 + 隔离 VM，无网络。
//
// 为什么要有它：任务列表这件事的难点不在画界面，而在三条接线——
//   ① 任务自带来处（T59）：工作流跑动期间切会话，产出必须写回**任务所属会话**；
//   ② 单节点可停：每颗节点自己的 AbortController + 下游标「上游缺失」；
//   ③ 排队项按会话寻址：切会话不再整队丢弃，轮到自己时把视图带回去。
// 这三条静态绿看不出问题（跑错画布、丢队列都是静默的），所以既要跑账本行为，
// 也要按源码咬住接线点，防止后人改回去。
//   node scripts/review_tasks_frontend.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const readSrc = rel => fs.readFileSync(new URL(rel, root), 'utf8');
const tests = [];
const test = (name, run) => tests.push({ name, run });

// ===== 迷你 DOM：只做这个模块真正用到的那几个面 =====
function makeEl(tag) {
  const node = {
    tagName: tag, className: '', textContent: '', innerHTML: '', title: '', hidden: false,
    disabled: false, children: [], style: {}, dataset: {}, offsetHeight: 0, isConnected: true,
    _classes: new Set(),
    addEventListener() {},
    appendChild(child) { node.children.push(child); return child; },
    contains() { return false; },
    closest() { return null; },
    getAttribute() { return null; },
    querySelector() { return null; },
  };
  node.classList = {
    add: c => node._classes.add(c),
    remove: c => node._classes.delete(c),
    contains: c => node._classes.has(c),
    toggle: (c, on) => {
      if (on === undefined) { node._classes.has(c) ? node._classes.delete(c) : node._classes.add(c); }
      else if (on) node._classes.add(c);
      else node._classes.delete(c);
      return node._classes.has(c);
    },
  };
  return node;
}

function fixture() {
  const panelBody = makeEl('div');
  const panel = makeEl('div');
  panel.querySelector = sel => (sel === '.task-panel-body' ? panelBody : null);
  const btn = makeEl('button');
  const stopAll = makeEl('button');
  const els = { taskPanel: panel, taskPanelBody: panelBody, taskPanelBtn: btn, taskPanelStopAll: stopAll };

  const s = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    AbortController,
    document: {
      readyState: 'complete',
      getElementById: id => els[id] || null,
      createElement: makeEl,
      addEventListener() {},
      body: makeEl('body'),
      querySelector: () => null,
      querySelectorAll: () => [],
      visibilityState: 'visible',
    },
    escapeHtml: v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    GRAPH_CUSTOM_NODE_KINDS: ['blank', 'user', 'answer', 'module', 'hub', 'summary', 'note', 'source', 'knowledge', 'human_note', 'ai_eval'],
    graphView: { nodeById: {}, nodes: [], edges: [] },
    _currentSid: 'sess_A',
    _sessions: { sess_A: { id: 'sess_A', title: '简谐运动 1' }, sess_B: { id: 'sess_B', title: '信号处理 2' } },
    _switched: [],
    _saved: [],
    _graphStates: {},
    _fetchCalls: [],
    showToast() {},
    _positionPanel() {},
    fetch: async (url, init) => {
      s._fetchCalls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
    getCurrentSessionId: () => s._currentSid,
    getSessionById: id => s._sessions[id] || null,
    switchToSession: async id => { s._switched.push(id); s._currentSid = id; },
    getGraphState: sid => s._graphStates[sid] || { customNodes: [] },
    saveGraphState: (sid, state) => { s._graphStates[sid] = state; s._saved.push(sid); },
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(readSrc('src/static/js/tasks.js'), s, { filename: 'tasks.js' });
  const run = code => vm.runInContext(code, s);
  return { s, run, els, panelBody };
}

// 面板里那一行文字：直接问渲染函数，不去抠 DOM
const panelHtml = (s) => s._taskPanelHtml();

// ===== 账本行为 =====

test('排队中的一条也算任务（用户拍板 #6）：等待中 + 面板里看得见 + 会话号带上了', () => {
  const { s, run } = fixture();
  run(`_taskCreate({ kind: 'send', title: '追问：请详细讲讲振幅和周期', state: 'waiting', replay: { text: '请详细讲讲振幅和周期' } });`);
  const html = panelHtml(s);
  assert.match(html, /追问：请详细讲讲振幅和周期/);
  assert.match(html, /等待中/);
  assert.match(html, /会话：简谐运动 1/);
  assert.match(html, /data-task-action="cancel"/);
});

test('工作流任务：两级结构——外层是组，里层是节点条目，带「N/M 已完成」', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({
    title: '用一句话说明简谐运动',
    workNodes: [{ id: 'n1', label: '物理视角' }, { id: 'n2', label: '数学视角' }],
    allIds: ['n1', 'n2'],
  });`);
  run(`_taskNodeStart(_taskActiveCtx.taskId, 'n1', '物理视角', null);
       _taskNodeFinish(_taskActiveCtx.taskId, 'n1', 'done');`);
  const html = panelHtml(s);
  assert.match(html, /用一句话说明简谐运动/);
  assert.match(html, /1\/2 已完成/);
  // 收起时不铺节点明细（面板默认折叠，展开才渲染）
  assert.doesNotMatch(html, /物理视角/);
  run(`_taskExpanded[_taskActive[0].id] = true;`);
  const open = panelHtml(s);
  assert.match(open, /物理视角/);
  assert.match(open, /数学视角/);
  assert.match(open, /等待/);
});

test('暂停是软暂停：面板上的开关就是调度口那道闸门读的那个标志', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '甲', workNodes: [{ id: 'n1', label: '物理视角' }], allIds: ['n1'] });`);
  assert.equal(run('_taskCtxPaused()'), false);
  run(`_taskPauseToggle(_taskActive[0].id);`);
  assert.equal(run('_taskCtxPaused()'), true, '暂停后调度口必须停下派发');
  assert.match(panelHtml(s), /已暂停/);
  assert.match(panelHtml(s), /继续/, '暂停后按钮要变成「继续」');
  run(`_taskPauseToggle(_taskActive[0].id);`);
  assert.equal(run('_taskCtxPaused()'), false);
});

test('停单个节点：正在跑的那颗掐自己的 controller；还没轮到的进「用户停掉」名单', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '乙', workNodes: [{ id: 'n1', label: '物理视角' }, { id: 'n2', label: '数学视角' }], allIds: ['n1','n2'] });`);
  const taskId = run('_taskActive[0].id');
  // 正在跑的那颗：controller 挂上去，停 = abort 它自己
  const controller = run('new AbortController()');
  s.__ac = controller;
  run(`_taskNodeStart('${taskId}', 'n1', '物理视角', __ac);`);
  assert.equal(run(`_taskCancelNode('${taskId}', 'n1')`), true);
  assert.equal(controller.signal.aborted, true, '停正在跑的节点必须只掐它自己的 signal');
  // 还没轮到的：登记进名单，条目立刻显示已取消
  assert.equal(run(`_taskCancelNode('${taskId}', 'n2')`), true);
  assert.equal(run(`_taskWasNodeCancelled('n2')`), true);
  run('_taskExpanded[_taskActive[0].id] = true;');
  assert.match(panelHtml(s), /已取消/);
});

test('下游「上游缺失」的文案与状态词：blocked 不再混用 waiting（用户拍板 #10）', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '丙', workNodes: [{ id: 'n1', label: '物理视角' }, { id: 'n2', label: 'AI 总结' }], allIds: ['n1','n2'] });`);
  const taskId = run('_taskActive[0].id');
  run(`_taskNodeFinish('${taskId}', 'n2', 'blocked', '上游缺失', true);
       _taskExpanded[_taskActive[0].id] = true;`);
  const html = panelHtml(s);
  assert.match(html, /上游缺失/);
  assert.match(html, /state-blocked/);
  // 画布上的徽章：状态词也必须是「上游缺失」，且带完整说法的 title
  const renderSrc = readSrc('src/static/js/graph-render.js');
  assert.match(renderSrc, /node\.status === 'blocked'\) return '上游缺失'/);
  assert.match(renderSrc, /上游缺失，无法生成/);
});

test('结账：结束的任务从「进行中」挪进历史，重开页面看到的「已中断」保留可重放内容', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '丁', workNodes: [{ id: 'n1', label: '物理视角' }], allIds: ['n1'] });`);
  const taskId = run('_taskActive[0].id');
  run(`_tasksEndWorkflow('${taskId}', 'stopped', '手动停止');`);
  assert.equal(run('_taskActive.length'), 0);
  assert.equal(run('_taskHistory.length'), 1);
  const html = panelHtml(s);
  assert.match(html, /历史/);
  assert.match(html, /重新生成/, '被停掉的任务应该给一条重新生成的路');
  // 重开页面：跑着/等着的标已中断，节点跟着收口
  const restored = run(`_taskSplitLoaded(${JSON.stringify([
    { id: 'task_h1', kind: 'workflow', title: '用一句话说明傅里叶变换', state: 'running', sessionId: 'sess_B', sessionTitle: '信号处理 2', createdAt: 1, nodes: [{ id: 'n9', label: '物理视角', state: 'running' }], replay: { nodeIds: ['n9'] } },
  ])})`);
  assert.equal(restored.history[0].state, 'interrupted');
  assert.equal(restored.history[0].nodes[0].state, 'stopped');
  assert.deepEqual(JSON.parse(JSON.stringify(restored.history[0].replay.nodeIds)), ['n9'], '重新生成靠的是留下的节点清单');
});

test('落盘走服务端 kv 全局键，不碰 localStorage（T53：localStorage 已经占掉 34%）', () => {
  const { s, run } = fixture();
  run(`_taskCreate({ kind: 'send', title: '甲', state: 'waiting' });
       _taskPersistNow();`);
  const call = s._fetchCalls.filter(c => c.body).pop();
  assert.ok(call, '必须有一条落盘请求');
  assert.match(call.url, /tasks%3Aglobal|tasks:global/);
  assert.ok(call.body && call.body.value && Array.isArray(call.body.value.tasks));
  assert.equal(call.body.value.tasks[0].sessionId, 'sess_A', '任务要记下自己的会话号（用户拍板 #1）');
  assert.equal(s.localStorage.getItem('phymathia_tasks'), null);
});

// ===== 三条接线契约（源码级，防改回去）=====

test('接线① 任务自带来处：有任务在跑时，画布查找与保存都走任务自己的会话（T59）', () => {
  const { s, run } = fixture();
  const canvasNode = { id: 'n1', kind: 'module', messageIndex: -1, content: '甲', status: 'done' };
  s.graphView.nodeById = { n1: canvasNode };
  assert.equal(run(`_taskNodeOverride('n1')`), null, '没有任务在跑时不许劫持画布的查找');
  assert.equal(run(`_taskSaveNodesOverride()`), false, '没有任务在跑时不许劫持画布的保存');
  run(`_tasksBeginWorkflow({ title: '甲', workNodes: [{ id: 'n1', label: '物理视角' }], allIds: ['n1'] });`);
  assert.equal(run(`_taskNodeOverride('n1')`), canvasNode);
  // 用户切到会话 B 再让任务保存：必须写进 A，不是当前画布 B
  s._currentSid = 'sess_B';
  s.graphView.nodeById = { other: { id: 'other', kind: 'module', messageIndex: -1 } };
  const taskNode = run(`_taskActiveCtx.nodes.get('n1')`);
  taskNode.content = '甲（新产出）';
  assert.equal(run(`_taskSaveNodesOverride()`), true);
  assert.deepEqual(s._saved, ['sess_A'], '产出必须写回任务所属的 sess_A');
  const savedState = s._graphStates.sess_A;
  assert.equal(savedState.customNodes.find(n => n.id === 'n1').content, '甲（新产出）');
  assert.ok(!s._graphStates.sess_B || !s._graphStates.sess_B.customNodes, '不能顺手把会话 B 的画布改掉');
});

test('接线① 源码：_findGraphNode 与 _saveCustomNodes 各留了一个任务上下文出口', () => {
  const graphSrc = readSrc('src/static/js/graph.js');
  assert.match(graphSrc, /_taskNodeOverride/);
  const customSrc = readSrc('src/static/js/graph-custom.js');
  assert.match(customSrc, /_taskSaveNodesOverride/);
});

test('接线② 源码：每颗节点自己的 controller，signal 传进链内；暂停闸门在调度口', () => {
  const src = readSrc('src/static/js/graph-workflow.js');
  const start = src.indexOf('async function _runWorkflowNodeConcurrent(');
  const body = src.slice(start, src.indexOf('\nasync function _runWorkflowGraph('));
  assert.ok(body.includes('new AbortController()'), '每颗节点要有自己的 controller');
  assert.ok(body.includes('nodeController.signal'), 'signal 要真传进去，不能只是建了不用');
  assert.ok(body.includes("_taskNodeFinish(taskId, node.id, 'stopped'"), '被停掉的节点要记账');
  assert.match(src, /_taskCtxPaused\(\)/, '调度口要有暂停闸门');
  assert.match(src, /function _markWorkflowDependentsBlocked[\s\S]{0,900}status = 'blocked'/, '下游要标上游缺失');
  assert.doesNotMatch(src, /function _markWorkflowDependentsBlocked[\s\S]{0,900}status = 'waiting'/, '上游缺失不许退回 waiting');
});

test('接线③ 排队项按会话寻址：切会话不再整队丢弃，轮到自己时把视图带回去', () => {
  const sessionSrc = readSrc('src/static/js/session.js');
  assert.doesNotMatch(sessionSrc, /_clearSendQueue\('已切换会话'\)/, '切会话丢队列这条兜底该撤了');
  const queueSrc = readSrc('src/static/js/send-queue.js');
  assert.match(queueSrc, /_sendQueueReady/, '放行前要先回到它所属的画布');
  assert.match(queueSrc, /await item\.run\(item\.taskId\)/, '任务 id 要交给闭包（提问那条要交接给工作流）');
});

test('面板入口在顶栏（不挂会淡出的胶囊上），且没有任务时也不消失', () => {
  const html = readSrc('src/static/index.html');
  assert.match(html, /id="taskPanelBtn"/);
  assert.match(html, /id="taskPanel"/);
  const btnIdx = html.indexOf('id="taskPanelBtn"');
  const runIdx = html.indexOf('id="runAllBtn"');
  assert.ok(btnIdx > runIdx && btnIdx - runIdx < 1200, '三角要在「▶ 全部开始」右边（用户草图的位置）');
  const { s, run } = fixture();
  assert.match(panelHtml(s), /还没有任务/);
});

let failed = 0;
for (const t of tests) {
  try {
    t.run();
    console.log('✓ ' + t.name);
  } catch (err) {
    failed++;
    console.error('✗ ' + t.name + '\n    ' + ((err && err.message) || err));
  }
}
console.log(failed ? `\n任务列表回归失败 ${failed}/${tests.length}` : `\n任务列表回归全部通过（${tests.length}）`);
process.exit(failed ? 1 : 0);
