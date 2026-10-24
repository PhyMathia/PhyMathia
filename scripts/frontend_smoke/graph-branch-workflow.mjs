// 分支拓展单链路化（T361/T362/T363，2026-10-17 用户拍板退役「一次生成再拆开」）：
// ① 三个活入口（方向钮/追问/苏格拉底闭环）一律落工作流链路，不再产生消息簇；
// ② 苏格拉底反馈落自定义节点后把建议追问派生成 sq 节点、闭环状态与画像记账随迁；
// ③ 存量消息簇的删除确认按「真正会消失的节点」报数（同簇并列＋parentId 级联），
//    不再拿去重消息数冒充节点数。
// ④「没看懂」（confused）分支已随 T335 整体退役（同日）：入口/提示词/端口臂全拆，
//    本域尾部有退役钉死契约；检测页「这题没看懂」是 T174 独立功能，不在退役范围。
// ⑤ T364（2026-10-18）：闭环链上下文语义——「向前找问题节点」跳过作答卡（作答是
//    kind:'user' 但内容是 [苏格拉底回答] 定稿，不是问题）；标签分设「我的作答/
//    苏格拉底反馈」；最近反馈卡给 6000 全文额度（作答卡正文剥机器前缀）。
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

// T364 夹具：一条闭环链（根问题 → 分析 → socratic 模块 → 作答 user-custom →
// 反馈 answer-custom（socraticMeta，正文 >800 字）→ sq 下一题），验证上下文取材
// 在链上的语义。在 _seed() 之上追加，复用其沙箱接线。
function _seedSocraticLoop() {
  _seed();
  const feedbackBody = '判定：正确。\n\n<讲解>' + '单摆周期公式逐段推导，从小角度近似到恢复力。'.repeat(40) + '</讲解>\n<socratic_meta correct="correct" done="false" />';
  const loopNodes = [
    { id: 'u-root', kind: 'user', messageIndex: -1, timestamp: 10, content: '主问题：单摆周期怎么算', status: 'done' },
    { id: 'a-root', kind: 'answer', messageIndex: -1, timestamp: 20, content: '', analysis: '单摆分析', status: 'done' },
    { id: 'sm-loop', kind: 'module', moduleKey: 'socratic', messageIndex: -1, timestamp: 30, content: '### 苏格拉底追问\n1. [基础] 甲题', status: 'done' },
    { id: 'u-ans', kind: 'user', manual: true, messageIndex: -1, timestamp: 40, content: '[苏格拉底回答] 目标问题：甲题\n把握程度：basic\n我的回答：周期与小球质量无关。', status: 'done' },
    { id: 'a-fb', kind: 'answer', messageIndex: -1, timestamp: 50, content: feedbackBody, status: 'done',
      socraticMeta: { prompt: '[苏格拉底回答]', mode: 'answer', question: '甲题', level: 'basic', branchId: 'br_x' } },
    { id: 'sq-1', kind: 'module', moduleKey: 'socratic', messageIndex: -1, timestamp: 60, content: '### 苏格拉底追问\n1. [基础] 下一题', status: 'done' },
  ];
  const edges = [
    { from: 'u-root', fromPort: 'out-0', to: 'a-root', toPort: 'in-0' },
    { from: 'a-root', fromPort: 'out-0', to: 'sm-loop', toPort: 'in-0' },
    { from: 'sm-loop', fromPort: 'out-0', to: 'u-ans', toPort: 'in-0' },
    { from: 'u-ans', fromPort: 'out-0', to: 'a-fb', toPort: 'in-0' },
    { from: 'a-fb', fromPort: 'out-5', to: 'sq-1', toPort: 'in-0' },
  ];
  vm.runInContext('(function () { const __loop = ' + JSON.stringify(loopNodes) + ';'
    + '__loop.forEach(function (n) { graphView.nodes.push(n); graphView.nodeById[n.id] = n; });'
    + 'graphView.edges = ' + JSON.stringify(edges) + '; })();', sandbox);
  return { feedbackBody: feedbackBody };
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

    check('T361 追问/苏格拉底：锚点带宿主节点 id（弹窗提交即可落工作流）', () => {
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
        vm.runInContext('pendingBranchModal = { parentId: "1001", sourceModule: "graph", branchType: "followup", nodeId: "m-1001-physics", sourcePort: "out-0" };', sandbox);
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

    check('T364 闭环链取材：question 锚回真问题不作答卡；标签分设「我的作答/苏格拉底反馈」；最近反馈卡拿全文额度', () => {
      const fx = _seedSocraticLoop();
      const ctx = JSON.parse(vm.runInContext(
        'JSON.stringify(_collectWorkflowContext(graphView.nodeById["sq-1"], null, {}))', sandbox));
      if (ctx.question !== '主问题：单摆周期怎么算') {
        throw new Error('question 槽没锚到根问题（可能锚到作答原文）：' + String(ctx.question).slice(0, 40));
      }
      const rows = ctx.upstream || [];
      const ansRow = rows.find(r => r.label === '我的作答');
      if (!ansRow) throw new Error('作答卡没有「我的作答」标签：' + JSON.stringify(rows.map(r => r.label)));
      if (String(ansRow.content).indexOf('[苏格拉底回答]') === 0) throw new Error('作答卡正文没剥机器前缀');
      if ((ansRow.summary || '').indexOf('[苏格拉底回答]') === 0) throw new Error('作答卡摘要没剥机器前缀');
      if (ansRow.full) throw new Error('作答卡不该拿 full 额度');
      if (String(ansRow.content).length > 800) throw new Error('作答卡应维持 800 字摘要额度');
      const fbRow = rows.find(r => r.label === '苏格拉底反馈');
      if (!fbRow) throw new Error('反馈卡没有「苏格拉底反馈」标签');
      if (!fbRow.full) throw new Error('最近反馈卡没拿 full 额度');
      if ((fbRow.summary || '') !== '') throw new Error('full 条目 summary 没置空（后端渲染 summary 优先会截胡）');
      if (String(fbRow.content).indexOf('判定：正确') !== 0) throw new Error('反馈卡正文不是判定/讲解原文（_nodeOutputContent 回退没修）');
      if (String(fbRow.content).length < 900) throw new Error('反馈卡全文额度没生效（仍按 800 截）：' + String(fbRow.content).length);
      if (!rows.some(r => r.label === '问题')) throw new Error('根问题的「问题」标签丢了');
      if (String(vm.runInContext('_followupSourceNodeId(graphView.nodeById["sq-1"])', sandbox)) !== '') {
        throw new Error('闭环链来源卡应为空（根问题无上游），实得非空');
      }
      if (!fx.feedbackBody.startsWith('判定：正确')) throw new Error('夹具自身坏了');
      return true;
    });

    check('T364 闭环链空白节点生成：问题取根问题而非最近作答；路径副本带闭环身份标记', () => {
      _seedSocraticLoop();
      const picked = JSON.parse(vm.runInContext(
        'JSON.stringify(_nearestUserInPath(_blankNodeGraphPath(graphView.nodeById["a-fb"])))', sandbox));
      if (!picked || picked.content !== '主问题：单摆周期怎么算') {
        throw new Error('空白节点生成的问题没跳过作答卡：' + JSON.stringify(picked && picked.content).slice(0, 40));
      }
      const flags = JSON.parse(vm.runInContext(
        'JSON.stringify(_blankNodeGraphPath(graphView.nodeById["a-fb"]).map(function (i) {'
        + ' return { id: i.kind + (i.socraticAnswer ? "!" : "") + (i.socraticFeedback ? "?" : ""), c: (i.content || "").slice(0, 6) }; }))', sandbox));
      if (!flags.some(f => f.id === 'user!')) throw new Error('路径副本没带 socraticAnswer 标记');
      if (!flags.some(f => f.id === 'answer?')) throw new Error('路径副本没带 socraticFeedback 标记');
      return true;
    });

    check('T364 源码契约：三处问题节点判定都跳过闭环作答卡（_isSocraticLoopAnswer）', () => {
      const src = _read('graph-workflow-prompt.js');
      for (const fn of ['_findQuestionContentUpstream', '_nearestUserInPath', '_nearestQuestionNodeUpstream']) {
        const body = _body(src, fn);
        if (!body || body.indexOf('_isSocraticLoopAnswer') < 0) throw new Error(fn + ' 没接闭环作答守卫');
      }
      if (!src.includes('_nearestSocraticFeedbackUpstream')) throw new Error('最近反馈卡全文额度入口缺失');
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
      const gen = _body(_read('graph-workflow-generate.js'), '_generateCustomNode');
      if (!gen || gen.indexOf('socraticMeta') < 0 || gen.indexOf('_materializeSocraticFollowup') < 0) {
        throw new Error('苏格拉底反馈节点的生成口径没接上（socraticMeta / 派生追问）');
      }
      const renderNode = _body(_read('graph-render.js'), '_renderCustomNodeContentHtml');
      if (!renderNode || renderNode.indexOf('_graphStripSuggestedFollowups') < 0) {
        throw new Error('苏格拉底反馈卡没剥建议追问（会与派生节点重复渲染）');
      }
      return true;
    });

    check('T335 退役钉死：「没看懂」入口/confused 分支/配方槽位全拆（源码级，2026-10-17）', () => {
      const renderSrc = _read('render.js');
      if (renderSrc.includes('dontUnderstandModule') || renderSrc.includes('dontUnderstandViz')) {
        throw new Error('render.js 还留着「没看懂」入口函数');
      }
      if (renderSrc.includes('viz-dontget')) throw new Error('viz 工具栏还挂着「没看懂」按钮');
      const mp = _body(renderSrc, '_modulePrompt');
      if (mp && /['"]confused['"]/.test(mp)) throw new Error('_modulePrompt 还留着 confused 提示词槽');
      const act = _body(_read('graph-interact.js'), 'graphModuleAction');
      if (act && /['"]confused['"]/.test(act)) throw new Error('graphModuleAction 还收 confused action');
      const gr = _read('graph-render.js');
      if (/label === '没看懂'/.test(gr)) throw new Error('端口 branchType 三元还有「没看懂」臂');
      const prefill = _body(gr, '_draftPrefill');
      if (prefill && /['"]confused['"]/.test(prefill)) {
        throw new Error('_draftPrefill 还留 confused 预填分支');
      }
      const obSrc = _read('ui-onboarding.js');
      if (obSrc.includes('没看懂')) throw new Error('新手引导还在教「没看懂」按钮（检测页 T174 同名功能在 quiz-ui/quiz-render，不受此契约管）');
      const recipeEdit = _read('graph-recipe-edit.js');
      if (recipeEdit.includes('recipeConfused') || recipeEdit.includes('confused_prompt')) {
        throw new Error('配方编辑表单还留着 confused_prompt 槽');
      }
      const recipeNorm = _read('graph-recipes.js');
      if (recipeNorm.includes('confused_prompt')) throw new Error('配方归一/校验还带 confused_prompt');
      const recipesPy = fs.readFileSync('harness/recipes.py', 'utf8');
      if (recipesPy.includes('confused_prompt')) throw new Error('后端配方 schema 还带 confused_prompt');
      const ctxPy = fs.readFileSync('src/server/context.py', 'utf8');
      if (/branch_type == "confused"/.test(ctxPy)) throw new Error('context.py 还留 confused 分支指令（知识提取守卫里的 branchType 比对是存量兼容，不算）');
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
