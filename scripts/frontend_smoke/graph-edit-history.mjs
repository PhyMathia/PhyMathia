// 人工编辑节点内容进撤销历史＋代码围栏编辑态往返（2026-10-16 用户实测两条）：
//   ①「编辑交互可视化时 textarea 里带着 ```html 包夹」——围栏是渲染层分发到
//     iframe/SVG 的凭据（render.js 认围栏＋完整标记才转），存储态必须留着，但对人是
//     纯噪音（误删一行反引号保存后节点退回代码块显示）。修法：编辑态剥掉、保存时按
//     载体语言补回，viz（html）与知识图谱/配方（mermaid、html_iframe）都覆盖。
//   ②「编辑节点内容不进修改历史」——四处内容编辑入口（saveModuleNode /
//     saveCustomNodeContent / saveHumanNoteNode / updateCustomNodeContent）都没记
//     撤销点，改写是隐形的。根因有两层：入口没接 _pushGraphUndo；_pushGraphUndo 的
//     同异比对只比 state，messageIndex≥0 的模块编辑只写 msg.content（图状态一字未动），
//     快照会被整个吞掉。反向同样成立：消息编辑之后紧接一次状态编辑也会被吞。
import fs from 'node:fs';
import { check, drain, sandbox, vm, storageData } from './_runner.mjs';

const FULL_HTML = '<!DOCTYPE html><html><head><title>t</title></head><body>hello viz</body></html>';
const MERMAID = 'graph TD\n  A[力] --> B[加速度]';

function _emptyState() {
  return { collapsed: {}, hidden: {}, positions: {}, pinned: {}, sizes: {}, pan: { x: 80, y: 80 }, zoom: 0.9,
    layoutVersion: 1, connections: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, groups: [],
    customNodes: [], harnessDeleted: {}, harnessCheckpoint: null };
}

// 一套最小夹具：挂在 assistant 消息上的 viz/知识图谱两颗模块节点＋自绘 note＋我的理解
function _seed() {
  const mem = _emptyState();
  let chatHistory = [
    { role: 'user', content: '问题', timestamp: 1 },
    { role: 'assistant', content: '<physics>物理正文</physics>'
      + '<viz>\n## 交互探索\n\n```html\n' + FULL_HTML + '\n```\n</viz>'
      + '<graph>\n## 知识图谱\n\n```mermaid\n' + MERMAID + '\n```\n</graph>', timestamp: 2 },
  ];
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, state); };
  sandbox.window.getCurrentSessionId = () => 'sess_edit_history';
  sandbox.window.getChatHistory = () => chatHistory.slice();
  sandbox.window.replaceChatHistory = async (msgs) => { chatHistory = JSON.parse(JSON.stringify(msgs)); };
  sandbox.window.updateChatHistoryMessage = (ts, updater) => {
    const i = chatHistory.findIndex(m => String(m.timestamp) === String(ts));
    if (i < 0) return false;
    const next = updater(chatHistory[i]);
    if (next !== undefined) chatHistory[i] = next;
    return true;
  };
  sandbox.window.saveCurrentSession = async () => {};
  vm.runInContext('graphView.nodes = ['
    + JSON.stringify({ id: 'viz1', kind: 'module', moduleKey: 'viz', messageIndex: 1, timestamp: 0, content: '', status: 'done' }) + ','
    + JSON.stringify({ id: 'gr1', kind: 'module', moduleKey: 'graph', messageIndex: 1, timestamp: 0, content: '', status: 'done' }) + ','
    + JSON.stringify({ id: 'nt1', kind: 'note', manual: true, messageIndex: -1, timestamp: 3, content: '旧总结', title: '', status: 'done' }) + ','
    + JSON.stringify({ id: 'hn1', kind: 'human_note', manual: true, messageIndex: -1, timestamp: 4, content: '旧理解', label: '我的理解', status: 'done' })
    + '];', sandbox);
  vm.runInContext('graphView.nodeById = { viz1: graphView.nodes[0], gr1: graphView.nodes[1], nt1: graphView.nodes[2], hn1: graphView.nodes[3] };'
    + 'graphView.edges = []; graphView.defaultEdges = []; graphView.selectedNodeIds = new Set();', sandbox);
  // 真实应用里 _saveCustomNodes 会把 live 节点同步进图状态缓存，夹具不能跳过这步
  vm.runInContext('_saveCustomNodes();', sandbox);
  const fx = {
    mem: mem,
    chat: () => chatHistory,
    field: obj => { sandbox.__field = obj; },
    section: tag => (chatHistory[1].content.match(new RegExp('<' + tag + '>[\\s\\S]*?</' + tag + '>', 'i')) || [''])[0],
  };
  sandbox.__fx = fx;
  return fx;
}

export async function run() {
  const prevGet = sandbox.window.getGraphState, prevSave = sandbox.window.saveGraphState, prevSid = sandbox.window.getCurrentSessionId;
  const prevDoc = sandbox.document, prevEsc = sandbox.escapeHtml;
  const histKey = 'phymathia_graph_history_sess_edit_history';
  const prevHist = storageData[histKey];
  delete storageData[histKey];
  sandbox.document = {
    createElement: () => ({ className: '', innerHTML: '', style: {}, listeners: {},
      addEventListener() {}, remove() {} }),
    getElementById: id => (sandbox.__field && sandbox.__field[id] !== undefined ? { value: sandbox.__field[id] } : null),
    body: { appendChild: () => {} },
  };
  sandbox.escapeHtml = t => String(t == null ? '' : t);
  const runCtx = code => vm.runInContext(code, sandbox, { filename: 'graph-edit-history.mjs' });
  const stateContent = id => runCtx('(_graphState().customNodes.find(n => String(n.id) === "' + id + '") || {}).content');
  const undo = () => runCtx('_undoGraphAction()');
  const tick = () => new Promise(r => setTimeout(r, 25));
  try {
    check('人工编辑 viz 模块：编辑框只给 HTML 本体（无 ```html 围栏），保存补回＋入撤销历史', () => {
      _seed();
      runCtx('_pushGraphUndo();');                       // 先垫一条既有历史，摘要别与「初始」混
      sandbox.editModuleNode('viz1');
      const html = String(runCtx('moduleNodeModalOverlay.innerHTML'));
      if (/```/.test(html.split('rows="8">')[1] || '')) throw new Error('编辑框预填仍带 ``` 围栏');
      if (!html.includes(FULL_HTML)) throw new Error('编辑框预填丢了 HTML 本体');
      if (/围栏保存时自动补回/.test(html)) throw new Error('编辑框不应再带围栏自动补回提示');
      sandbox.__fx.field({ moduleNodeContent: FULL_HTML.replace('hello viz', 'hello viz v2') });
      sandbox.saveModuleNode('viz1');
      if (!/```html[\s\S]*?```/.test(sandbox.__fx.chat()[1].content)) throw new Error('保存后没补回 ```html 围栏');
      if (!sandbox.__fx.chat()[1].content.includes('hello viz v2')) throw new Error('保存后改动丢了');
      if (runCtx('graphUndoStack.length') !== 2) throw new Error('模块编辑未入撤销栈');
      if (!runCtx('graphUndoStack[1].messages')) throw new Error('消息型快照没带 messages');
      if (runCtx('graphUndoStack[1].messages[1].content').includes('v2')) throw new Error('快照存的不是改前版本');
      if (runCtx('graphUndoStack[1].meta.summary') !== '人工编辑：交互可视化') {
        throw new Error('历史摘要不对：' + runCtx('graphUndoStack[1].meta.summary'));
      }
      return true;
    });

    check('人工编辑 viz 模块：无改动直接保存不入栈、围栏不重复包', () => {
      const before = runCtx('graphUndoStack.length');
      sandbox.__fx.field({ moduleNodeContent: FULL_HTML.replace('hello viz', 'hello viz v2') });
      sandbox.saveModuleNode('viz1');
      if (runCtx('graphUndoStack.length') !== before) throw new Error('无改动保存也记了一条历史');
      if ((sandbox.__fx.chat()[1].content.match(/```html/g) || []).length !== 1) throw new Error('围栏被重复包了一层');
      return true;
    });

    check('连续两次模块编辑各入栈（同异比对不再把第二次吞掉）', () => {
      sandbox.__fx.field({ moduleNodeContent: FULL_HTML.replace('hello viz', 'hello viz v3') });
      sandbox.saveModuleNode('viz1');
      const after1 = runCtx('graphUndoStack.length');
      sandbox.__fx.field({ moduleNodeContent: FULL_HTML.replace('hello viz', 'hello viz v4') });
      sandbox.saveModuleNode('viz1');
      const after2 = runCtx('graphUndoStack.length');
      if (after1 !== 3 || after2 !== 4) throw new Error('连续编辑入栈数不对：' + after1 + '/' + after2);
      if (!runCtx('graphUndoStack[3].messages[1].content').includes('v3')) throw new Error('v3 中间版本没留住');
      if (!runCtx('graphUndoStack[2].messages[1].content').includes('v2')) throw new Error('v2 中间版本没留住');
      return true;
    });

    check('知识图谱模块同样往返围栏；消息编辑后紧接状态编辑也入栈（反向不被吞）', () => {
      sandbox.__fx.field({ moduleNodeContent: '新的图谱源码' });
      sandbox.saveModuleNode('gr1');
      if (!/<graph>\s*```mermaid\s*\n新的图谱源码\s*\n```\s*<\/graph>/i.test(sandbox.__fx.section('graph'))) {
        throw new Error('mermaid 围栏往返不对：' + sandbox.__fx.section('graph'));
      }
      const afterGraph = runCtx('graphUndoStack.length');
      sandbox.__fx.field({ customNodeTitleBox: '光学', customNodeContentBox: '新总结' });
      sandbox.saveCustomNodeContent('nt1');             // 状态型编辑跟在后头
      if (runCtx('graphUndoStack.length') !== afterGraph + 1) throw new Error('消息编辑后的状态编辑被吞');
      if (stateContent('nt1') !== '新总结') throw new Error('笔记本内容没写回');
      return true;
    });

    check('我的理解 / 卡内联编辑同样入栈，值未变不重复记', () => {
      sandbox.__fx.field({ humanNoteTitle: '我的理解', humanNoteContent: '新理解', humanNoteFormula: 'E=mc^2' });
      sandbox.saveHumanNoteNode('hn1');
      const afterNote = runCtx('graphUndoStack.length');
      if (stateContent('hn1') !== '新理解') throw new Error('我的理解内容没写回');
      sandbox.updateCustomNodeContent('nt1', '联改内容');
      if (runCtx('graphUndoStack.length') !== afterNote + 1) throw new Error('卡内联编辑未入栈');
      sandbox.updateCustomNodeContent('nt1', '联改内容'); // 值没变：不重复记
      if (runCtx('graphUndoStack.length') !== afterNote + 1) throw new Error('值未变却重复记了一条');
      return true;
    });

    // ===== T353：message 型快照的持久化增量（2026-10-17）=====
    // 此前 _persistGraphHistory 丢 messages，刷新后 viz 人工编辑/删消息节点只能退图退不了消息。
    // 本组用例插在「撤销链」用例之前且共用同一沙箱：逐例备份/还原撤销链现场（不得调 _seed——
    // 它会重绑 getChatHistory/__fx 等闭包，把撤销链用例的断言对象换掉），消息一律用
    // replaceChatHistory 灌确定性内容。
    const normRows = arr => JSON.stringify((arr || []).map(r => JSON.stringify(
      [r.sessionId, r.state, r.messages || null, r.meta || null])));
    const _baseMsgs = () => [
      { role: 'user', content: '问题', timestamp: 1 },
      { role: 'assistant', content: '<viz>\n## 交互探索\n\n```html\n' + FULL_HTML + '\n```\n</viz>', timestamp: 2 },
    ];
    const _histBackup = () => ({
      h: JSON.parse(runCtx('JSON.stringify({ s: graphHistorySession, u: graphUndoStack, r: graphRedoStack, m: graphPendingLiveMeta })')),
      chat: JSON.parse(JSON.stringify(sandbox.__fx.chat())),
    });
    const _histRestore = (b, rawKey) => {
      vm.runInContext('graphHistorySession = ' + JSON.stringify(b.h.s) + ';'
        + 'graphUndoStack = ' + JSON.stringify(b.h.u) + ';'
        + 'graphRedoStack = ' + JSON.stringify(b.h.r) + ';'
        + 'graphPendingLiveMeta = ' + JSON.stringify(b.h.m) + ';'
        + '_graphHistoryMirrorPending = null;', sandbox);
      sandbox.window.replaceChatHistory(b.chat);   // chatHistory 也得还回去：撤销链用例按它断言
      if (rawKey === undefined) delete storageData[histKey]; else storageData[histKey] = rawKey;
    };
    const _histStart = () => {  // 每例从确定状态起步：空栈＋确定性消息＋无本地存档
      runCtx('graphHistorySession = "sess_edit_history"; graphUndoStack = []; graphRedoStack = []; graphPendingLiveMeta = null;');
      delete storageData[histKey];
      sandbox.window.replaceChatHistory(_baseMsgs());
    };
    const _hydratedEqualsStack = () => {
      const hydrated = JSON.parse(runCtx('JSON.stringify(_graphHistoryHydrate(JSON.parse(localStorage.getItem("' + histKey + '"))))'));
      const stack = JSON.parse(runCtx('JSON.stringify(graphUndoStack)'));
      return normRows(hydrated) === normRows(stack);
    };

    check('T353: 持久化带消息增量——链头全量＋后续增量，读回重建与内存栈逐字一致', () => {
      const backup = _histBackup(); const rawKey = storageData[histKey];
      try {
        _histStart();
        runCtx('_pushGraphUndo();');                     // 状态型垫底（无 messages）
        sandbox.__fx.field({ moduleNodeContent: FULL_HTML.replace('hello viz', 'hello viz v2') });
        sandbox.saveModuleNode('viz1');                  // 消息型第一条（推送在改写前，存改前内容）
        sandbox.__fx.field({ moduleNodeContent: FULL_HTML.replace('hello viz', 'hello viz v3') });
        sandbox.saveModuleNode('viz1');                  // 消息型第二条（应走增量）
        runCtx('_persistGraphHistory();');
        const raw = JSON.parse(storageData[histKey]);
        if (!raw[1].messages) throw new Error('链头消息型条目未存全量');
        if (!raw[2].msgDelta) throw new Error('后续消息型条目未走增量');
        if (raw[2].messages) throw new Error('增量条目不应同时带全量');
        if (!raw[2].msgDelta.sets.length || raw[2].msgDelta.adds.length || raw[2].msgDelta.dels.length) {
          throw new Error('纯改写形态的增量不对：' + JSON.stringify(raw[2].msgDelta));
        }
        if (!_hydratedEqualsStack()) throw new Error('读回重建结果与内存栈不一致');
        return true;
      } finally { _histRestore(backup, rawKey); }
    });

    check('T353: 删＋追混合形态（删消息节点）也走增量且重建一致', () => {
      const backup = _histBackup(); const rawKey = storageData[histKey];
      try {
        _histStart();
        runCtx('_pushGraphUndo(true);');                 // 全量链头
        const msgs = _baseMsgs();
        msgs.splice(1, 1);                               // 删掉 assistant 消息（删消息节点同形态）
        msgs.push({ role: 'user', content: '追问一句', timestamp: 9 });
        sandbox.window.replaceChatHistory(msgs);
        runCtx('_pushGraphUndo(true);');
        runCtx('_persistGraphHistory();');
        const raw = JSON.parse(storageData[histKey]);
        if (!raw[0].messages) throw new Error('链头未存全量');
        if (!raw[1].msgDelta) throw new Error('删＋追形态未走增量');
        if (!raw[1].msgDelta.dels.includes('2')) throw new Error('被删消息未进增量');
        if (raw[1].msgDelta.adds.length !== 1 || raw[1].msgDelta.adds[0].at !== 1) throw new Error('追加未进增量');
        if (!_hydratedEqualsStack()) throw new Error('混合形态重建与内存栈不一致');
        return true;
      } finally { _histRestore(backup, rawKey); }
    });

    check('T353: 链头被砍（本地截断/镜像 pruned 同形态）时增量条目退化为只退图、不炸', () => {
      const backup = _histBackup(); const rawKey = storageData[histKey];
      try {
        _histStart();
        runCtx('_pushGraphUndo(true);');                 // 全量链头
        const msgs = _baseMsgs();
        msgs[1].content = msgs[1].content.replace('hello viz', 'hello viz v2');
        sandbox.window.replaceChatHistory(msgs);
        runCtx('_pushGraphUndo(true);');                 // 消息已变：增量条目
        runCtx('_persistGraphHistory();');
        const raw = JSON.parse(storageData[histKey]);
        if (!raw[1] || !raw[1].msgDelta) throw new Error('前置：第二条应走增量');
        const cut = JSON.stringify(raw.slice(1));        // 砍掉链头（全量条目），只留增量
        const hydrated = JSON.parse(runCtx('JSON.stringify(_graphHistoryHydrate(JSON.parse(' + JSON.stringify(cut) + ')))'));
        const row = hydrated[0];
        if (!row || !row.state) throw new Error('断链降级不应丢条目');
        if (row.messages) throw new Error('断链后不应重建出消息');
        if ('msgDelta' in row) throw new Error('读回不应残留序列化标记');
        return true;
      } finally { _histRestore(backup, rawKey); }
    });

    check('T353: checkpoint 去重不剪断消息增量链（两标记共存读回双还原）', () => {
      const backup = _histBackup(); const rawKey = storageData[histKey];
      try {
        _histStart();
        const cp = JSON.stringify({ step: 1 });
        const msgsA = JSON.stringify([{ role: 'user', content: 'q1', timestamp: 1 }]);
        const msgsB = JSON.stringify([{ role: 'user', content: 'q2', timestamp: 1 }]);
        vm.runInContext('(function () {' +
          'graphHistorySession = "sess_edit_history"; graphRedoStack = [];' +
          'const mk = () => Object.assign(_graphState(), { harnessCheckpoint: ' + cp + ' });' +
          'graphUndoStack = [' +
          '{ sessionId: "sess_edit_history", state: mk(), messages: ' + msgsA + ', meta: { source: "user", summary: "一", ts: 1 } },' +
          '{ sessionId: "sess_edit_history", state: mk(), messages: ' + msgsB + ', meta: { source: "user", summary: "二", ts: 2 } }' +
          '];})();', sandbox);
        runCtx('_persistGraphHistory();');
        const raw = JSON.parse(storageData[histKey]);
        if (raw[0].checkpointRef) throw new Error('首条应作为 checkpoint 实体原样落盘');
        if (!raw[1].checkpointRef || !raw[1].msgDelta) throw new Error('去重条目未同时携带 checkpointRef 与 msgDelta');
        const hydrated = JSON.parse(runCtx('JSON.stringify(_graphHistoryHydrate(JSON.parse(localStorage.getItem("' + histKey + '"))))'));
        if (hydrated[1].state.harnessCheckpoint == null) throw new Error('checkpoint 没补回');
        if (!hydrated[1].messages || hydrated[1].messages[0].content !== 'q2') throw new Error('消息增量没重建');
        if ('msgDelta' in hydrated[1] || 'checkpointRef' in hydrated[1]) throw new Error('读回残留序列化标记');
        return true;
      } finally { _histRestore(backup, rawKey); }
    });

    check('撤销链：逐步回退内联编辑→我的理解→笔记本→图谱模块→两次 viz 编辑', async () => {
      await undo(); await tick();
      if (stateContent('nt1') !== '新总结') throw new Error('撤销内联编辑失败：' + stateContent('nt1'));
      await undo(); await tick();
      if (stateContent('hn1') !== '旧理解') throw new Error('撤销我的理解失败');
      await undo(); await tick();
      if (stateContent('nt1') !== '旧总结') throw new Error('撤销笔记本编辑失败');
      await undo(); await tick();
      if (!sandbox.__fx.section('graph').includes(MERMAID)) throw new Error('撤销图谱模块编辑失败，围栏也没回来');
      await undo(); await tick();
      if (!sandbox.__fx.chat()[1].content.includes('v3') || sandbox.__fx.chat()[1].content.includes('v4')) {
        throw new Error('撤销第四次 viz 编辑失败');
      }
      await undo(); await tick();
      if (!sandbox.__fx.chat()[1].content.includes('v2') || sandbox.__fx.chat()[1].content.includes('v3')) {
        throw new Error('撤销第三次 viz 编辑失败');
      }
      await undo(); await tick();
      if (sandbox.__fx.chat()[1].content.includes('v2')) throw new Error('撤销第二次 viz 编辑失败');
      await undo(); await tick();
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('撤销栈没退干净，剩 ' + runCtx('graphUndoStack.length'));
      return true;
    });

    check('静态契约：_pushGraphUndo 同异比对必须连 messages 一起看', () => {
      const src = fs.readFileSync('src/static/js/graph.js', 'utf8');
      const body = src.slice(src.indexOf('function _pushGraphUndo('), src.indexOf('async function _restoreGraphVersion'));
      if (!/const messagesSame =/.test(body)) throw new Error('_pushGraphUndo 没有 messagesSame 判定');
      if (!/stateSame && messagesSame\) return;/.test(body)) throw new Error('状态型去重没并上 messages 条件');
      if (!/diff\.layoutOnly && messagesSame/.test(body)) throw new Error('布局型去重没并上 messages 条件');
      return true;
    });

    // 收口必须放在 finally 之前：异步用例（撤销链）要在夹具还原前跑完，否则沙箱桩
    // 已复位、用例对着真链表空转
    await drain();
  } finally {
    sandbox.window.getGraphState = prevGet;
    sandbox.window.saveGraphState = prevSave;
    sandbox.window.getCurrentSessionId = prevSid;
    sandbox.document = prevDoc;
    sandbox.escapeHtml = prevEsc;
    delete sandbox.__field;
    delete sandbox.__fx;
    if (prevHist === undefined) delete storageData[histKey]; else storageData[histKey] = prevHist;
    vm.runInContext('graphView.nodes = []; graphView.edges = []; graphView.nodeById = {}; graphView.defaultEdges = [];'
      + 'moduleNodeModalOverlay = null;', sandbox);
  }
}
