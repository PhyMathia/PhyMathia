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
    offsetWidth: 0, _rect: null,
    _classes: new Set(),
    addEventListener() {},
    appendChild(child) { node.children.push(child); return child; },
    contains() { return false; },
    closest() { return null; },
    getAttribute() { return null; },
    querySelector() { return null; },
    getBoundingClientRect() { return node._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
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

// anchor: 可选。传 { width, left, top, bottom } 就在页面里放一个进度胶囊，
// 用来跑停靠路径；不传就没有胶囊，_dockTaskPanel 必须退回 _positionPanel。
function fixture(opts = {}) {
  const panelBody = makeEl('div');
  const panel = makeEl('div');
  panel.querySelector = sel => (sel === '.task-panel-body' ? panelBody : null);
  const btn = makeEl('button');
  const stopAll = makeEl('button');
  const els = { taskPanel: panel, taskPanelBody: panelBody, taskPanelBtn: btn, taskPanelStopAll: stopAll };
  if (opts.anchor) {
    const anchor = makeEl('div');
    anchor._rect = {
      left: opts.anchor.left, top: opts.anchor.top,
      right: opts.anchor.left + opts.anchor.width,
      bottom: opts.anchor.bottom, width: opts.anchor.width, height: 40,
    };
    anchor.offsetWidth = opts.anchor.width;
    anchor.offsetHeight = 40;
    els.progressStatus = anchor;
  }

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
    _positionCalls: [],
    showToast() {},
    _positionPanel(...args) { s._positionCalls.push(args); },
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
  s.innerWidth = 1280;
  s.innerHeight = 900;
  vm.createContext(s);
  // 面板的图标按钮取 config.js 的 UI_ICON_SVG，沙箱要按真实顺序先加载它
  // （浏览器里两者是同一份全局词法环境，vm.runInContext 之间同样共享）
  vm.runInContext(readSrc('src/static/js/config.js'), s, { filename: 'config.js' });
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

// 播放控制改成图标按钮（用户 2026-09-27）：文字不能少——title/aria-label 保住可读名，
// 但按钮正文里只剩图标；时长一律 m/s/h 字母单位，不再出现「分/秒」。
test('面板按钮：暂停/停止/节点停是图标，名字在 title 里；时长用 m/s 字母', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '戊', workNodes: [{ id: 'n1', label: '数学视角' }], allIds: ['n1'] });`);
  run(`_taskNodeStart(_taskActive[0].id, 'n1', '数学视角', null);`);
  run('_taskExpanded[_taskActive[0].id] = true;');
  const html = panelHtml(s);
  assert.match(html, /class="task-btn task-btn--icon"[^>]*data-task-action="pause"[^>]*title="暂停"/, '暂停键是图标 + title');
  assert.match(html, /task-btn--warn[^>]*data-task-action="cancel"[^>]*title="停止"/, '停止键是图标 + title');
  assert.match(html, /data-task-action="cancel-node"[^>]*title="停掉「数学视角」"/, '节点停键带节点名的 title');
  assert.doesNotMatch(html, />暂停<|>停止<|>停</, '按钮正文里不该再有这三个文字');
  // 起点拨到 3 分 4 秒前：行上应出现 3m04s
  run(`_taskActive[0].startedAt = Date.now() - 184000; _taskActive[0].nodes[0].startedAt = Date.now() - 184000;`);
  const timed = panelHtml(s);
  assert.match(timed, /3m04s/);
  assert.doesNotMatch(timed, /分|秒/, '时长不再用中文单位');
  // 暂停后按钮翻成「继续」：图标也跟着换，读屏名不能丢
  run('_taskPauseToggle(_taskActive[0].id);');
  assert.match(panelHtml(s), /data-task-action="pause"[^>]*title="继续"/);
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

test('结账：没干成的进「未完成」并给一键重试；重开页面看到的「已中断」保留可重放内容', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '丁', workNodes: [{ id: 'n1', label: '物理视角' }], allIds: ['n1'] });`);
  const taskId = run('_taskActive[0].id');
  run(`_tasksEndWorkflow('${taskId}', 'stopped', '手动停止');`);
  assert.equal(run('_taskActive.length'), 0);
  assert.equal(run('_taskHistory.length'), 1);
  const html = panelHtml(s);
  assert.match(html, /重试/, '没干成的任务应该给一条一键重试的路');
  assert.match(html, /data-task-action="forget"/, '历史记录该能单条删掉');
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
  assert.match(panelHtml(s), /暂无/);
  assert.match(panelHtml(s), /data-task-tab="active"/);
  assert.match(panelHtml(s), /data-task-tab="done"/);
});


test('任务面板提供对话框与页签语义，动态重绘前后保留焦点锚点', () => {
  const html = readSrc('src/static/index.html');
  const src = readSrc('src/static/js/tasks.js');
  assert.match(html, /id="taskPanel"[^>]*role="dialog"[^>]*aria-labelledby="taskPanelTitle"/);
  assert.match(html, /id="taskPanelTitle"/);
  assert.match(html, /id="taskPanelBtn"[^>]*aria-controls="taskPanel"[^>]*aria-expanded="false"/);
  assert.match(html, /id="progressTaskBtn"[^>]*aria-controls="taskPanel"[^>]*aria-expanded="false"/);
  assert.match(src, /role="tab"/);
  assert.match(src, /role="tablist" aria-label="任务状态"/);
  assert.match(src, /function _taskFocusSnapshot\(panel\)/);
  assert.match(src, /function _taskRestoreFocus\(panel, snapshot\)/);
  assert.match(src, /const focus = _taskFocusSnapshot\(panel\)/);
  assert.match(src, /_taskRestoreFocus\(panel, focus\)/);
});

test('两个页签分开：没干成的在「未完成」，干成的才进「已完成」（用户 2026-09-27 要求）', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '干成的活儿', workNodes: [{ id: 'n1', label: '物理视角' }], allIds: ['n1'] });
       _tasksEndWorkflow(_taskActive[0].id, 'done', '');`);
  run(`_taskCreate({ kind: 'send', title: '失败的那条', state: 'running' });
       _taskFinish(_taskActive[0].id, 'error', '模型返回了空内容');`);
  run(`_taskCreate({ kind: 'send', title: '还在跑的那条', state: 'running' });`);
  const unfinished = panelHtml(s);
  assert.match(unfinished, /还在跑的那条/);
  assert.match(unfinished, /失败的那条/);
  assert.match(unfinished, /重试/, '失败的要能一键重试');
  assert.doesNotMatch(unfinished, /干成的活儿/, '干成的不能混在未完成里');
  run(`_taskTab = 'done';`);
  const doneTab = panelHtml(s);
  assert.match(doneTab, /干成的活儿/);
  assert.doesNotMatch(doneTab, /失败的那条/, '失败的不该进已完成页签');
  assert.doesNotMatch(doneTab, /还在跑的那条/);
});

test('一键清除记录：只清干成的，失败与在跑的必须留着（清记录不是清待办）', () => {
  const { s, run } = fixture();
  run(`_tasksBeginWorkflow({ title: '干成的甲', workNodes: [{ id: 'n1', label: '物理视角' }], allIds: ['n1'] });
       _tasksEndWorkflow(_taskActive[0].id, 'done', '');
       _tasksBeginWorkflow({ title: '失败的乙', workNodes: [{ id: 'n2', label: '数学视角' }], allIds: ['n2'] });
       _tasksEndWorkflow(_taskActive[0].id, 'error', '模型返回了空内容');
       _taskCreate({ kind: 'send', title: '在跑的丙', state: 'running' });
       _tasksClearDone();`);
  assert.equal(run('_taskDoneRecords().length'), 0, '干成的该被清掉');
  assert.equal(run('_taskHistory.length'), 1, '失败的留在历史里等重试');
  assert.equal(run('_taskActive.length'), 1, '在跑的不许被清');
  run(`_taskForget(_taskHistory[0].id);`);
  assert.equal(run('_taskHistory.length'), 0, '单条删除要生效');
});

test('进行中的转圈是 CSS 圆环，不是 ⟳ 字符（字符旋转偏心、会跳，用户反馈过）', () => {
  const { s, run } = fixture();
  run(`_taskCreate({ kind: 'send', title: '跑着的', state: 'running' });`);
  const html = panelHtml(s);
  assert.match(html, /class="task-spin"/, '进行中要画圆环');
  assert.doesNotMatch(html, /⟳/, '不许再用 ⟳ 字符');
  const css = readSrc('src/static/css/styles.css');
  assert.match(css, /\.task-spin \{[\s\S]{0,400}border-radius: 50%/, '圆环必须是正圆');
  assert.match(css, /\.task-spin \{[\s\S]{0,400}animation: taskSpin/, '圆环要匀速转');
  assert.doesNotMatch(css, /state-running \.task-glyph \{[^}]*animation/, '字形不许再带旋转动画');
});

test('胶囊上也有一个入口（用户 2026-09-27 要求）：干活时胶囊常驻，列表随手可开', () => {
  const html = readSrc('src/static/index.html');
  assert.match(html, /id="progressTaskBtn"/, '胶囊上要有一个打开任务列表的按钮');
  assert.match(html, /id="progressTaskBtn"[\s\S]{0,600}toggleTaskPanel\(event\)/, '它要能开面板');
  assert.match(readSrc('src/static/js/tasks.js'), /\['taskPanelBtn', 'progressTaskBtn'\]/, '两个入口的徽标要一起更新');
});

// ===== 挂接胶囊（用户 2026-09-27：「我希望这个任务列表就像是这个栏扩展出来的」）=====

test('源码契约：面板挂在胶囊下沿，接缝零缝隙，且不借用共用的 _positionPanel', () => {
  const src = readSrc('src/static/js/tasks.js');
  const toggle = src.slice(src.indexOf('function toggleTaskPanel'), src.indexOf('function _taskPanelClick'));
  assert.match(toggle, /_dockTaskPanel\(\)/, '开面板要先试着停靠到胶囊');
  assert.match(toggle, /!_dockTaskPanel\(\)[\s\S]{0,120}_positionPanel/, '停靠不上才退回通用路径');
  assert.match(toggle, /_undockTaskPanel\(\)/, '关面板要撤停靠');
  // 通用路径必须留着手：难度/模型/数据三个面板还靠它，删了就是连带事故
  const ui = readSrc('src/static/js/ui.js');
  assert.match(ui, /function _positionPanel\(panelId, triggerEl\)/, '共用的通用定位函数不许被改掉');
  assert.doesNotMatch(src, /function _positionPanel\(/, 'tasks.js 不许自己重定义通用定位');
  // 缝隙是 0：top 直接取胶囊 rect.bottom，不带任何 +N 偏移
  const dock = src.slice(src.indexOf('function _dockTaskPanel'), src.indexOf('function _undockTaskPanel'));
  assert.match(dock, /const top = Math\.max\(8, rect\.bottom\);/, '面板顶部就是胶囊下沿，不留缝');
  assert.doesNotMatch(dock, /rect\.bottom\)\s*\+\s*\d/, '接缝不许留偏移（旧路径的 +6 会露馅）');
  // 拖胶囊时面板要跟过去
  assert.match(src, /window\._taskPanelDockFollow = _dockTaskPanel/, '要暴露跟随钩子给 chat.js');
  const chat = readSrc('src/static/js/chat.js');
  assert.match(chat, /_taskPanelDockFollow/, '胶囊拖动要回调面板重新贴位');
});

test('停靠几何：等宽时左右边缘对齐胶囊、零缝隙地吊在下沿', () => {
  // 胶囊 550 宽、居中于 1280 视口 → left 365，底沿 y=150
  const { s, run, els } = fixture({ anchor: { width: 550, left: 365, top: 110, bottom: 150 } });
  run('toggleTaskPanel();');
  assert.ok(els.taskPanel.classList.contains('show'), '面板要打开');
  assert.ok(els.taskPanel.classList.contains('task-panel--docked'), '要进停靠态');
  assert.ok(els.taskPanel.classList.contains('aurora-glass--attached'), '玻璃要降档，否则和胶囊差一道深浅台阶');
  assert.ok(els.progressStatus.classList.contains('aurora-glass--dock-host'), '胶囊也要让底角收投影');
  assert.equal(els.taskPanel.style.width, '550px', '胶囊 550 时面板同宽');
  assert.equal(els.taskPanel.style.left, '365px', '等宽时左边缘与胶囊对齐');
  assert.equal(els.taskPanel.style.top, '150px', '顶部就是胶囊下沿，零缝隙');
  assert.equal(s._positionCalls.length, 0, '停靠成功就不该再走通用路径');
});

test('胶囊闲时只有 250px：面板撑到 360 底线并按胶囊中线居中（不照抄压扁列表）', () => {
  // 闲时恒 250px 是 Chrome 对可缩 flex 子项固有宽度的坑，拍板见 canvas-modules.md 2026-09-26
  const { run, els } = fixture({ anchor: { width: 250, left: 515, top: 110, bottom: 150 } });
  run('toggleTaskPanel();');
  assert.equal(els.taskPanel.style.width, '360px', '不能被压到 250，列表装不下');
  // 胶囊中线 = 515 + 125 = 640 → 面板 360 宽 → left = 460
  assert.equal(els.taskPanel.style.left, '460px', '比胶囊宽时按中线居中，吊在它下面');
  assert.equal(els.taskPanel.style.top, '150px');
});

test('关面板要把停靠态撤干净，否则胶囊底角永远回不来', () => {
  const { run, els } = fixture({ anchor: { width: 550, left: 365, top: 110, bottom: 150 } });
  run('toggleTaskPanel(); toggleTaskPanel();');
  assert.ok(!els.taskPanel.classList.contains('show'));
  assert.ok(!els.taskPanel.classList.contains('task-panel--docked'), '停靠类要摘');
  assert.ok(!els.taskPanel.classList.contains('aurora-glass--attached'), '玻璃降档要撤');
  assert.ok(!els.progressStatus.classList.contains('aurora-glass--dock-host'), '胶囊要让回底角');
  assert.equal(els.taskPanel.style.width, '', '内联宽度要清，别把停靠几何漏给下一次通用打开');
});

test('面板关着时拖胶囊不许动它的停靠态（真机踩过：胶囊底角被拉直像被切掉一块）', () => {
  // 胶囊拖动每帧回调 _taskPanelDockFollow（= _dockTaskPanel），而拖胶囊与面板
  // 开合无关。少了开合闸，收起状态下拖一下也会给面板套上 dock-host，
  // 胶囊底角被 CSS 拉直成方的，而面板根本看不见。
  const { run, els } = fixture({ anchor: { width: 550, left: 365, top: 110, bottom: 150 } });
  run('toggleTaskPanel(); toggleTaskPanel();');   // 开一次再关，回到收起态
  assert.ok(!els.taskPanel.classList.contains('show'), '先确认面板确实是收起的');
  run('window._taskPanelDockFollow();');          // 模拟拖动一帧
  assert.ok(!els.taskPanel.classList.contains('task-panel--docked'), '收着时不该进停靠态');
  assert.ok(!els.taskPanel.classList.contains('aurora-glass--attached'), '玻璃降档不该生效');
  assert.ok(!els.progressStatus.classList.contains('aurora-glass--dock-host'), '胶囊底角要留着');
  assert.equal(els.taskPanel.style.width, '', '不该写内联几何');
  // 开着的时候跟随仍然要生效（这条闸不能把正常路径也堵掉）
  run('toggleTaskPanel(); window._taskPanelDockFollow();');
  assert.ok(els.taskPanel.classList.contains('task-panel--docked'), '开着时拖动要跟过去');
  assert.ok(els.progressStatus.classList.contains('aurora-glass--dock-host'), '开着时胶囊才让底角');
});

test('页面里没有胶囊时退回通用路径，不能整个面板开不出来', () => {
  const { s, run, els } = fixture();
  run('toggleTaskPanel();');
  assert.ok(els.taskPanel.classList.contains('show'), '没有锚点也必须能打开');
  assert.equal(s._positionCalls.length, 1, '要退回 _positionPanel 挂到触发器下方');
  assert.ok(!els.taskPanel.classList.contains('task-panel--docked'));
});

test('胶囊被拖到屏幕下沿：头部按钮必须还在屏内（真机踩过：清除记录点不到）', () => {
  // 胶囊底沿 y=820，视口 900 → 缝隙以下只剩 72px，放不下 120 的最小高度
  const { run, els } = fixture({ anchor: { width: 550, left: 365, top: 780, bottom: 820 } });
  run('toggleTaskPanel();');
  assert.ok(els.taskPanel.classList.contains('show'));
  assert.ok(els.taskPanel.style.maxHeight, '要限高并内部滚动，不能让面板翻出视口');
  const top = parseInt(els.taskPanel.style.top, 10);
  assert.ok(top + parseInt(els.taskPanel.style.maxHeight, 10) <= 900, '面板底不能超出视口');
});

test('CSS：接缝两边圆角同时拉直 + 胶囊让底角（否则读起来还是两块）', () => {
  const css = readSrc('src/static/css/styles.css');
  assert.match(css, /\.task-panel--docked \{[\s\S]{0,400}border-radius: 0 0 var\(--r-2xl\) var\(--r-2xl\)/,
    '面板上圆角切掉、底弧度用 --r-2xl 加大（用户反馈 12px 不好看；走令牌不写裸值）');
  assert.match(css, /\.task-panel--docked \{[\s\S]{0,400}border-top: none/, '缝里不留框线');
  assert.match(css, /\.task-panel--docked \{[\s\S]{0,400}max-width: none/, '停靠时宽度交给 JS 算（胶囊最长 550 > 默认上限 480）');
  assert.match(css, /\.aurora-glass--attached \{[\s\S]{0,400}--glass-tint/, '玻璃降档只能改变量，不许写 background 简写');
  const override = readSrc('src/static/css/graph-override.css');
  assert.match(override, /\.progress-status\.aurora-glass--dock-host \{[\s\S]{0,200}border-bottom-left-radius: 0/,
    '胶囊底角要拉直');
});

test('纯玻璃档：面板取消渐变但保留颜色（底色与胶囊同色系，不能退回中性黑）', () => {
  // 用户 2026-09-27 两句连读：「取消渐变，但是要有颜色啊」+「和胶囊用同一个色」。
  // 第一版只把色斑归零、底色不动 → 留下 rgba(4,7,18) 中性近黑，胶囊有蓝紫极光、
  // 面板是死黑，用户报「颜色对不上了啊」。**去渐变 ≠ 去色**。
  const css = readSrc('src/static/css/styles.css');
  const html = readSrc('src/static/index.html');
  assert.match(html, /class="task-panel aurora-glass aurora-glass--dialog aurora-glass--plain"/,
    '任务面板要挂 aurora-glass--plain');
  const i = css.indexOf('.aurora-glass--plain {');
  assert.ok(i > 0, '缺少 .aurora-glass--plain 变体');
  const block = css.slice(i, css.indexOf('}', i));
  // 渐变确实去掉了
  for (const n of ['--aurora-1', '--aurora-2', '--aurora-3']) {
    assert.match(block, new RegExp(n + ':\\s*transparent'), n + ' 要归零（去掉彩色渐变）');
  }
  assert.match(block, /animation:\s*none/, '无色斑可漂，auroraDrift 要停');
  // **颜色必须由底色接管**：--glass-tint 要被这一档改写成带色相的值，而不是沿用中性
  // rgba(4,7,18)。判据是「蓝分量明显大于红分量」——胶囊极光是蓝紫family，
  // 等效实色也该是蓝紫family；写成灰调（r≈g≈b）就是退回第一版那个死黑。
  const tint = block.match(/--glass-tint:\s*rgba\((\d+),\s*(\d+),\s*(\d+)/);
  assert.ok(tint, '纯玻璃档必须自己给 --glass-tint（颜色由底色接管）');
  const [r, g, b] = [ +tint[1], +tint[2], +tint[3] ];
  assert.ok(b > r + 20, `深色底色要偏蓝（b 明显大于 r），当前 rgb(${r},${g},${b}) 是灰调——` +
    '用户要的是「取消渐变但要有颜色」，不是取消颜色');
  // 玻璃本体其余部分不许动：用户说过磨砂模糊、薄纱、描边投影先不动
  for (const keep of ['--glass-veil', 'backdrop-filter', 'box-shadow']) {
    assert.doesNotMatch(block, new RegExp(keep.replace(/-/g, '\\-')),
      '用户说过玻璃观感先不动，纯玻璃档不该改 ' + keep);
  }
  // **浅色分支必须存在**：浅色的 `html[data-theme="light"] .aurora-glass--attached` 是
  // (0,2,0)，压得住 (0,1,0) 的深色规则——少了这条，深色下已归零、浅色下暖色斑又回来。
  // 浅色同样要给带色相的底色（暖米，不能是中性白）。
  const li = css.indexOf('html[data-theme="light"] .aurora-glass--plain,');
  assert.ok(li > 0, '缺少浅色分支的 .aurora-glass--plain（浅色 --attached 会压过深色规则）');
  const lblock = css.slice(li, css.indexOf('}', li));
  for (const n of ['--aurora-1', '--aurora-2', '--aurora-3']) {
    assert.match(lblock, new RegExp(n + ':\\s*transparent'), '浅色下 ' + n + ' 也要归零');
  }
  const ltint = lblock.match(/--glass-tint:\s*rgba\((\d+),\s*(\d+),\s*(\d+)/);
  assert.ok(ltint, '浅色分支也要给 --glass-tint');
  const [lr, lg, lb] = [ +ltint[1], +ltint[2], +ltint[3] ];
  assert.ok(lr > lb + 10, `浅色底色要偏暖（r 明显大于 b），当前 rgb(${lr},${lg},${lb}) 是中性白`);
});

test('高度下限 CSS 与 JS 两处数值必须一致（用户「高度变成两倍」）', () => {
  const css = readSrc('src/static/css/styles.css');
  const src = readSrc('src/static/js/tasks.js');
  // 规则块里夹着长注释，按花括号切出整条规则再取值，别拿 [\s\S]{0,N} 猜窗口长度。
  // 用行首缩进定位那条**独立**规则——`.task-panel.show.task-panel--docked` 是另一条
  // （只管 display:flex），indexOf 会先撞上它。
  const at = css.search(/\n\s{4}\.task-panel--docked \{/);
  const rule = at < 0 ? '' : css.slice(at, css.indexOf('}', at) + 1);
  const cssVal = rule.match(/min-height: (\d+)px/);
  const jsVal = src.match(/_TASK_DOCK_PANEL_MIN_H = (\d+)/);
  assert.ok(cssVal, '停靠态要声明高度下限（空面板原本只有 135px，吊在胶囊下像矮墩子）');
  assert.ok(jsVal, 'JS 要有同一个常量的副本');
  assert.equal(Number(jsVal[1]), Number(cssVal[1]),
    '两处数值必须相等：JS 那份只在可用高度不够时压低，CSS 那份管体量，岔开了就有一边形同虚设');
  assert.ok(Number(cssVal[1]) >= 240, '下限要真的把面板撑到约两倍（135 → 268）');
});

test('空间不够时把高度下限压低（CSS 的 min-height 会盖过 max-height）', () => {
  // 胶囊底沿 820 / 视口 900 → 可用不足 268，必须压低，否则面板直接顶出视口
  const { run, els } = fixture({ anchor: { width: 550, left: 365, top: 780, bottom: 820 } });
  run('toggleTaskPanel();');
  const minH = parseInt(els.taskPanel.style.minHeight, 10);
  const top = parseInt(els.taskPanel.style.top, 10);
  assert.ok(minH <= 900 - 16, '下限不许超过视口高度');
  assert.ok(top + minH <= 900, '面板底不能超出视口（头部按钮点不到是真机踩过的）');
  // 正常位置不该被压
  const { run: run2, els: els2 } = fixture({ anchor: { width: 550, left: 365, top: 110, bottom: 150 } });
  run2('toggleTaskPanel();');
  assert.equal(els2.taskPanel.style.minHeight, '268px', '空间够时下限照常生效');
});

test('撑高的空白要还给内容：body 吃剩余高度、空状态居中', () => {
  const css = readSrc('src/static/css/styles.css');
  assert.match(css, /\.task-panel--docked \.task-panel-body \{[\s\S]{0,200}flex: 1 1 auto/, 'body 要吃掉剩余高度');
  assert.match(css, /\.task-panel--docked \.task-empty \{ margin: auto 0/, '空面板时「暂无」要居中，不能吊在顶上');
  assert.match(css, /\.task-panel\.show\.task-panel--docked \{[\s\S]{0,120}display: flex/,
    '变 flex 必须带 .show，否则类先到会闪一个空面板');
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
