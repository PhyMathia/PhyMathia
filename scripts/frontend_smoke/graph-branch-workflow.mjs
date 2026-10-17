// 分支拓展单链路化（T361/T362/T363，2026-10-17 用户拍板退役「一次生成再拆开」）：
// ① 三个活入口（方向钮/追问没看懂/苏格拉底闭环）一律落工作流链路，不再产生消息簇；
// ② 苏格拉底反馈落自定义节点后把建议追问派生成 sq 节点、闭环状态与画像记账随迁；
// ③ 存量消息簇的删除确认按「真正会消失的节点」报数（同簇并列＋parentId 级联），
//    不再拿去重消息数冒充节点数。
// 本域全部同步用例在前、唯一一条 async 用例殿后把两条含 await 的用例串起来跑
//（硬规则 4：异步用例的让出窗口里别的用例若重置共享沙箱会假红——见 graph-human-finalize
// 的同款说明；这里 2026-10-17 实踩过一次：多选删除的 await 让出时后一条同步用例
// _seed() 重置了图，恢复后读到空夹具假红）。
import fs from 'node:fs';
import { check, drain, sandbox, vm } from './_runner.mjs';

function _emptyState() {
  return { collapsed: {}, hidden: {}, positions: {}, pinned: {}, sizes: {}, pan: { x: 80, y: 80 }, zoom: 0.9,
    layoutVersion: 1, connections: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, groups: [],
    customNodes: [], harnessDeleted: {}, harnessCheckpoint: null };
}

// 夹具：两颗工作流模块节点（learn/socratic，messageIndex<0）＋一棵存量消息簇
// （ts=1001 的整卡回答派生 3 颗并列节点，ts=1002 是挂在它下面的下游拓展）
function _seed() {
  const mem = _emptyState();
  mem.customNodes = [
    { id: 'lm1', kind: 'module', moduleKey: 'learn', messageIndex: -1, timestamp: 100, content: '### 进阶学习方向\n1. 方向甲\n2. 方向乙', status: 'done' },
    { id: 'sm1', kind: 'module', moduleKey: 'socratic', messageIndex: -1, timestamp: 200, content: '### 苏格拉底追问\n1. [基础] 甲题', status: 'done' },
  ];
  const history = [
    { role: 'user', content: '主问题', timestamp: 1000 },
    { role: 'assistant', content: '整卡回答', timestamp: 1001 },
    { role: 'assistant', content: '下游拓展', timestamp: 1002, parentId: '1001' },
  ];
  const nodes = [
    mem.customNodes[0], mem.customNodes[1],
    { id: 'm-1001-physics', kind: 'module', moduleKey: 'physics', messageIndex: 1, timestamp: 1001, content: '物理' },
    { id: 'm-1001-math', kind: 'module', moduleKey: 'math', messageIndex: 1, timestamp: 1001, content: '数学' },
    { id: 'a-1001', kind: 'answer', messageIndex: 1, timestamp: 1001, content: '整卡回答' },
    { id: 'm-1002-learn', kind: 'module', moduleKey: 'learn', messageIndex: 2, timestamp: 1002, content: '下游' },
  ];
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, state); };
  sandbox.window.getCurrentSessionId = () => 'sess_branch_wf';
  sandbox.window.getChatHistory = () => history.slice();
  sandbox.window.saveCurrentSession = async () => {};
  vm.runInContext('graphView.nodes = ' + JSON.stringify(nodes) + ';', sandbox);
  vm.runInContext('graphView.nodeById = {}; graphView.nodes.forEach(function (n) { graphView.nodeById[n.id] = n; });'
    + 'graphView.edges = []; graphView.defaultEdges = []; graphView.selectedNodeIds = new Set();', sandbox);
  return { mem: mem, history: history };
}

function _fakeButton(attrs) {
  return { attrs: attrs, getAttribute: function (name) { return this.attrs[name] != null ? this.attrs[name] : null; } };
}

function _read(path) { return fs.readFileSync('src/static/js/' + path, 'utf8'); }
function _body(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) return null;
  let depth = 0, started = false;
  for (let j = src.indexOf('{', i); j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j); }
  }
  return null;
}

export async function run() {
  const prevGet = sandbox.window.getGraphState, prevSave = sandbox.window.saveGraphState;
  const prevSid = sandbox.window.getCurrentSessionId, prevHist = sandbox.window.getChatHistory;
  const prevConfirm = sandbox.confirm;
  const prevDelMulti = sandbox.window.deleteGraphMessagesByTimestamps, prevDelOne = sandbox.window.deleteGraphMessageByTimestamp;
  const prevSocWf = sandbox.window.startSocraticWorkflow, prevQwf = sandbox.window.startQuestionWorkflow;
  const prevQuick = sandbox.window.sendBranchQuick, prevRecord = sandbox.window.recordSocraticAnswer;
  // 渲染在沙箱里跑不起来（vendor marked 不在沙箱，T329），本域只验路由与范围——把画布重渲换空转
  const prevRender = vm.runInContext('renderGraphCanvas', sandbox);
  sandbox.__smokePrevRender = prevRender;
  vm.runInContext('renderGraphCanvas = function () {};', sandbox);
  try {
    check('T361 方向钮：宿主节点解析成功 → 走 startQuestionWorkflow（不再 sendBranchQuick）', () => {
      _seed();
      const calls = { wf: null, quick: null };
      sandbox.window.startQuestionWorkflow = (text, opts) => { calls.wf = { text: text, opts: opts }; };
      sandbox.window.sendBranchQuick = () => { calls.quick = true; };
      const btn = _fakeButton({
        'data-send': encodeURIComponent('请详细讲解：方向甲'),
        'data-branch-type': 'learn',
        'data-parent-msg': '100',
        'data-source-module': 'learn',
      });
      const ok = sandbox._submitBranchQuickButton(btn);
      if (ok !== true) throw new Error('方向钮没有走到发送分支');
      if (!calls.wf) throw new Error('方向钮没有走工作流链路');
      if (calls.quick) throw new Error('方向钮仍在走消息簇链路（sendBranchQuick）');
      if (calls.wf.text !== '请详细讲解：方向甲') throw new Error('问题文本没带过去');
      if (!calls.wf.opts || calls.wf.opts.sourceNodeId !== 'lm1') {
        throw new Error('工作流来源节点解析错了：' + JSON.stringify(calls.wf.opts));
      }
      if (calls.wf.opts.sourcePort !== 'out-0') throw new Error('来源端口应为基础第一口，实得 ' + calls.wf.opts.sourcePort);
      return true;
    });

    check('T361 追问/没看懂：锚点带宿主节点 id（弹窗提交即可落工作流）', () => {
      _seed();
      const btn = _fakeButton({
        'data-socratic-answer': encodeURIComponent('甲题'),
        'data-socratic-level': 'basic',
        'data-parent-msg': '200',
        'data-socratic-source': 'socratic',
      });
      const info = sandbox._branchEntryHost(btn);
      if (!info.host || info.host.id !== 'sm1') throw new Error('苏格拉底宿主节点解析失败');
      const anchor = sandbox._branchAnchorFor(null, '200', 'socratic', 'socratic', '苏格拉底：基础');
      if (anchor.nodeId !== 'sm1') throw new Error('锚点没带宿主节点 id');
      if (!anchor.sourcePort) throw new Error('锚点没带来源端口');
      return true;
    });

    check('T361 分支弹窗：submitBranchModal 落工作流（宿主节点存在时），不走消息簇通道', () => {
      _seed();
      const calls = { wf: null, quick: null };
      sandbox.window.startQuestionWorkflow = (text, opts) => { calls.wf = { text: text, opts: opts }; };
      sandbox.window.sendBranchQuick = () => { calls.quick = true; };
      const prevDoc = sandbox.document;
      sandbox.document = { getElementById: id => (id === 'branchModalText' ? { value: '请进一步解释知识图谱中的概念关系' } : null) };
      try {
        vm.runInContext('pendingBranchModal = { parentId: "1001", sourceModule: "graph", branchType: "confused", nodeId: "m-1001-physics", sourcePort: "out-0" };', sandbox);
        vm.runInContext('submitBranchModal();', sandbox);
      } finally {
        sandbox.document = prevDoc;
      }
      if (!calls.wf) throw new Error('弹窗提交没有走工作流链路');
      if (calls.quick) throw new Error('弹窗提交仍在走消息簇链路');
      if (calls.wf.opts.sourceNodeId !== 'm-1001-physics') throw new Error('来源节点没带过去');
      return true;
    });

    check('T361 苏格拉底反馈：建议追问派生成 sq 节点（items＋连线到 socratic 出口），同一颗不重复建/不重复记账', () => {
      const fx = _seed();
      const recordCalls = [];
      sandbox.window.recordSocraticAnswer = spec => { recordCalls.push(spec); };
      const answer = {
        id: 'a-soc-1', kind: 'answer', messageIndex: -1, timestamp: 900, x: 100, y: 200, depth: 2, status: 'done',
        content: '答得不错。\n\n1. [基础] 下一题甲\n2. [进阶] 下一题乙\n<socratic_meta correct="correct" done="false" />',
        socraticMeta: { prompt: '[苏格拉底回答]', mode: 'answer', question: '甲题', level: 'basic', branchId: 'br_x' },
      };
      vm.runInContext('graphView.nodes.push(' + JSON.stringify(answer) + '); graphView.nodeById["a-soc-1"] = graphView.nodes[graphView.nodes.length - 1];', sandbox);
      vm.runInContext('_materializeSocraticFollowup(graphView.nodeById["a-soc-1"]);', sandbox);
      const sq = (fx.mem.customNodes || []).find(cn => cn.sqAuto && String(cn.parentId) === 'a-soc-1');
      if (!sq) throw new Error('没有派生出苏格拉底追问节点');
      if (!Array.isArray(sq.items) || sq.items.length !== 2) throw new Error('建议追问没进 items');
      const edge = (fx.mem.connections || []).find(e => String(e.from) === 'a-soc-1' && String(e.to) === sq.id);
      if (!edge) throw new Error('派生节点没有连到反馈节点');
      if (edge.fromPort !== 'out-5') throw new Error('派生节点应从苏格拉底出口连出，实得 ' + edge.fromPort);
      if (recordCalls.length !== 1 || recordCalls[0].correct !== true) throw new Error('答题记账没随迁（应记一次答对）');
      // 同一颗反馈节点再结算一次（重生成出同样判定）：不重复建点、不重复记账
      vm.runInContext('_materializeSocraticFollowup(graphView.nodeById["a-soc-1"]);', sandbox);
      const sqCount = (fx.mem.customNodes || []).filter(cn => cn.sqAuto).length;
      if (sqCount !== 1) throw new Error('重复结算长出了第二颗派生节点');
      if (recordCalls.length !== 1) throw new Error('同样判定被重复记账');
      return true;
    });

    check('T361 闭环结束：<socratic_meta done="true"> 复位内存里的闭环指针', () => {
      _seed();
      sandbox.window.recordSocraticAnswer = () => {};
      vm.runInContext('currentBranch = "socratic"; currentBranchId = "br_x";', sandbox);
      const answer = {
        id: 'a-soc-2', kind: 'answer', messageIndex: -1, timestamp: 901, x: 0, y: 0, depth: 2, status: 'done',
        content: '小结完毕。<socratic_meta correct="partial" done="true" />',
        socraticMeta: { prompt: '[苏格拉底回答]', mode: 'answer', question: '甲题', level: 'basic', branchId: 'br_x' },
      };
      vm.runInContext('graphView.nodes.push(' + JSON.stringify(answer) + '); graphView.nodeById["a-soc-2"] = graphView.nodes[graphView.nodes.length - 1];', sandbox);
      vm.runInContext('_materializeSocraticFollowup(graphView.nodeById["a-soc-2"]);', sandbox);
      if (vm.runInContext('currentBranch', sandbox) !== null) throw new Error('闭环结束后 currentBranch 没复位');
      if (vm.runInContext('currentBranchId', sandbox) !== null) throw new Error('闭环结束后 currentBranchId 没复位');
      return true;
    });

    check('T362 删除范围真值：同簇并列＋parentId 级联都算进「将删节点」', () => {
      _seed();
      const removed = JSON.parse(vm.runInContext('JSON.stringify(Array.from(_deletionScopeForTimestamps(["1001"]).messages))', sandbox));
      if (removed.sort().join(',') !== '1001,1002') throw new Error('级联消息没算全：' + removed.join(','));
      const nodeIds = JSON.parse(vm.runInContext('JSON.stringify(_deletionScopeForTimestamps(["1001"]).nodes.map(function (n) { return n.id; }))', sandbox));
      for (const id of ['m-1001-physics', 'm-1001-math', 'a-1001', 'm-1002-learn']) {
        if (!nodeIds.includes(id)) throw new Error('将删节点漏了 ' + id + '：' + nodeIds.join(','));
      }
      return true;
    });

    check('T362 单删确认文案：点名同簇并列颗数，不再只说「这个节点及其子分支」；自定义节点逐颗删不弹确认', () => {
      _seed();
      let confirmText = '';
      sandbox.confirm = text => { confirmText = String(text); return false; };
      sandbox.window.deleteGraphMessageByTimestamp = () => {};
      sandbox._deleteSingleGraphNode(vm.runInContext('graphView.nodeById["m-1001-math"]', sandbox));
      if (confirmText.indexOf('4 颗并列节点') < 0) throw new Error('单删文案没报同簇颗数：' + confirmText);
      if (confirmText.indexOf('另外 3 颗') < 0) throw new Error('单删文案没报未点名颗数：' + confirmText);
      let confirmAgain = false;
      sandbox.confirm = () => { confirmAgain = true; return true; };
      sandbox.window.deleteGraphMessageByTimestamp = () => { throw new Error('自定义节点删除不该走消息表'); };
      sandbox._deleteSingleGraphNode(vm.runInContext('graphView.nodeById["lm1"]', sandbox));
      if (confirmAgain) throw new Error('自定义节点删除不该弹消息簇确认');
      return true;
    });

    check('T363 静态契约：三个活入口都落工作流链路（源码级）', () => {
      const branch = _read('chat-branch.js');
      const runSoc = _body(branch, '_runSocraticAnswer');
      if (!runSoc || runSoc.indexOf('startSocraticWorkflow') < 0) throw new Error('苏格拉底作答没走工作流链路');
      if (/sendQuick\(/.test(runSoc)) throw new Error('苏格拉底作答仍在往消息表写分支消息');
      const exit = _body(branch, '_queueOrRunSocraticExit');
      if (!exit || exit.indexOf('startSocraticWorkflow') < 0) throw new Error('提示/讲解没走工作流链路');
      const submit = _body(branch, 'submitBranchModal');
      if (!submit || submit.indexOf('startQuestionWorkflow') < 0) throw new Error('分支弹窗没走工作流链路');
      const quick = _body(_read('render.js'), '_submitBranchQuickButton');
      if (!quick || quick.indexOf('startQuestionWorkflow') < 0) throw new Error('方向钮没走工作流链路');
      const gen = _body(_read('graph-workflow.js'), '_generateCustomNode');
      if (!gen || gen.indexOf('socraticMeta') < 0 || gen.indexOf('_materializeSocraticFollowup') < 0) {
        throw new Error('苏格拉底反馈节点的生成口径没接上（socraticMeta / 派生追问）');
      }
      const renderNode = _body(_read('graph-render.js'), '_renderCustomNodeContentHtml');
      if (!renderNode || renderNode.indexOf('_graphStripSuggestedFollowups') < 0) {
        throw new Error('苏格拉底反馈卡没剥建议追问（会与派生节点重复渲染）');
      }
      return true;
    });

    // 唯一含 await 的用例殿后：两条 await 用例在同一个 async 体里顺序跑，互不抢夹具
    check('T361/T362 含 await 两条：多选删除按真实节点数报＋苏格拉底作答落 startSocraticWorkflow', async () => {
      // ① 多选删除：确认文案按真实将删节点数报，确认后删的是整条消息
      _seed();
      let confirmText = '';
      sandbox.confirm = text => { confirmText = String(text); return false; };
      const deleted = [];
      sandbox.window.deleteGraphMessagesByTimestamps = async list => { deleted.push.apply(deleted, list); };
      await sandbox._deleteSelectedGraphNodes(['m-1001-physics', 'm-1001-math', 'a-1001']);
      if (confirmText.indexOf('1 个节点') >= 0) throw new Error('计数仍按去重消息数报：' + confirmText);
      if (confirmText.indexOf('4 个节点') < 0) throw new Error('确认文案没报真实将删节点数：' + confirmText);
      if (confirmText.indexOf('未点名') < 0) throw new Error('确认文案没点名同簇并列节点：' + confirmText);
      if (deleted.length !== 0) throw new Error('取消确认后不应删除任何消息');
      sandbox.confirm = () => true;
      await sandbox._deleteSelectedGraphNodes(['m-1001-physics', 'm-1001-math', 'a-1001']);
      if (deleted.join(',') !== '1001') throw new Error('删除消息集不对：' + deleted.join(','));

      // ② 苏格拉底作答：prompt 前缀/分支 ref/宿主节点/模式四件随迁
      _seed();
      let call = null;
      sandbox.window.startSocraticWorkflow = (text, meta) => { call = { text: text, meta: meta }; return Promise.resolve(); };
      await vm.runInContext('_runSocraticAnswer(' + JSON.stringify({
        question: '甲题', level: 'basic', parentMsg: '200', sourceModule: 'socratic',
        confidence: 'ok', newLoop: false, fromPort: 'out-0', branchId: 'br_sess_branch_wf_0123456789',
        position: null, answer: '我的作答',
      }) + ')', sandbox);
      if (!call) throw new Error('作答没有落到工作流入口');
      if (call.text.indexOf('[苏格拉底回答]') !== 0) throw new Error('prompt 前缀不对（服务端闭环状态机认它）：' + call.text.slice(0, 30));
      if (call.text.indexOf('追问问题：甲题') < 0) throw new Error('prompt 没带追问问题');
      if (call.meta.mode !== 'answer' || call.meta.branchId !== 'br_sess_branch_wf_0123456789') throw new Error('闭环元数据没随迁');
      if (call.meta.sourceNodeId !== 'sm1') throw new Error('宿主节点没解析到：' + JSON.stringify(call.meta));
      if (vm.runInContext('currentBranch', sandbox) !== 'socratic') throw new Error('闭环指针没立起来');

      // ③ 队列放行旁路：排队闭包必须把 fromQueue 带进工作流入口——放行期间
      // _isSendBusy 仍含 _sendQueueFlushing，不带旁路入口会再收一条，flush 每圈收
      // 一条、事件循环被饿死（T225 同型，2026-10-17 自查发现的真 bug）
      _seed();
      const wfArgs = [];
      sandbox.window.startSocraticWorkflow = (text, meta, taskId, fromQueue) => {
        wfArgs.push({ fromQueue: !!fromQueue, taskId: taskId || null });
        return Promise.resolve();
      };
      const snap2 = { question: '甲题', level: 'basic', parentMsg: '200', sourceModule: 'socratic',
        confidence: 'ok', newLoop: false, fromPort: 'out-0', branchId: 'br_x', position: null, answer: '作答' };
      await vm.runInContext('_runSocraticAnswer(' + JSON.stringify(snap2) + ', true)', sandbox);
      if (!wfArgs.length || wfArgs[0].fromQueue !== true) {
        throw new Error('排队放行的作答没带 fromQueue 旁路（会自我入队死循环）');
      }
      // 队列收件箱放沙箱全局的**真数组**（window 在冒烟沙箱是 loose 代理，
      // 未知属性读出来是代理、length 恒 0，记在 window 上读不到）
      sandbox.__queued = [];
      vm.runInContext('window.__origBusy = _isSendBusy; window.__origEnqueue = _enqueueSend;'
        + '_isSendBusy = function () { return true; };'
        + '_enqueueSend = function (label, run) { __queued.push({ label: label, run: run }); return true; };', sandbox);
      vm.runInContext('startSocraticHint("甲题", "basic", "200", "socratic", { sourceNodeId: "sm1", sourcePort: "out-0" })', sandbox);
      if (sandbox.__queued.length !== 1) throw new Error('忙时提示没有进队列');
      await vm.runInContext('__queued[0].run("task-y")', sandbox);
      const last = wfArgs[wfArgs.length - 1];
      if (!last || !last.fromQueue || last.taskId !== 'task-y') {
        throw new Error('队列放行的提示没把 taskId/fromQueue 带进工作流入口：' + JSON.stringify(last));
      }
      vm.runInContext('_isSendBusy = window.__origBusy; _enqueueSend = window.__origEnqueue;', sandbox);
      delete sandbox.__queued;
      return true;
    });

    await drain();
  } finally {
    sandbox.window.getGraphState = prevGet;
    sandbox.window.saveGraphState = prevSave;
    sandbox.window.getCurrentSessionId = prevSid;
    sandbox.window.getChatHistory = prevHist;
    sandbox.window.deleteGraphMessagesByTimestamps = prevDelMulti;
    sandbox.window.deleteGraphMessageByTimestamp = prevDelOne;
    sandbox.window.startSocraticWorkflow = prevSocWf;
    sandbox.window.startQuestionWorkflow = prevQwf;
    sandbox.window.sendBranchQuick = prevQuick;
    sandbox.window.recordSocraticAnswer = prevRecord;
    sandbox.confirm = prevConfirm;
    vm.runInContext('renderGraphCanvas = __smokePrevRender;', sandbox);
    delete sandbox.__smokePrevRender;
    vm.runInContext('graphView.nodes = []; graphView.edges = []; graphView.nodeById = {}; graphView.defaultEdges = [];', sandbox);
  }
}
