// T365 画布撤销历史游标化（2026-10-18）：单列表＋游标替代双栈（graphUndoStack＋游标＋
// 「最新」锚点，Photoshop 式时间旅行）。本域钉五件事：
//   ①持久化 v2 信封 {v:2,e,c,l}——游标与「最新」锚点随盘，刷新后重做链不再蒸发；
//   ②旧裸数组兼容装载（游标视作末尾、无锚点）；
//   ③跳转非破坏——「回到此版本」只挪游标不删条目，「未来」常驻可重做；
//   ④时间旅行位落真编辑才截断未来；无变化/纯布局推送不截（不因误触丢重做链）；
//   ⑤撤销/重做沿游标双向走，游标归 0 后历史条目一条不少。
// 本文件唯一异步用例（端到端链）放最后：异步让出微任务期间不得有同步用例重置共享沙箱
//（AGENTS 冒烟混排坑），同步三例都排在它前面、且各自 try/finally 自清理。
import fs from 'node:fs';
import { check, drain, sandbox, vm, storageData, restoreWindowStub } from './_runner.mjs';

const SID = 'sess_history_cursor';
const HIST_KEY = 'phymathia_graph_history_' + SID;

function _node(id) {
  return { id: id, kind: 'note', manual: true, messageIndex: -1, timestamp: 100, content: id, title: '', status: 'done' };
}

export async function run() {
  const prevSid = sandbox.window.getCurrentSessionId, prevGet = sandbox.window.getGraphState;
  const prevSave = sandbox.window.saveGraphState, prevChat = sandbox.window.getChatHistory;
  const prevReplace = sandbox.window.replaceChatHistory, prevToast = sandbox.showToast;
  const prevDoc = sandbox.document, prevEsc = sandbox.escapeHtml;
  const prevHist = storageData[HIST_KEY];
  delete storageData[HIST_KEY];
  let mem = null;
  let chatHistory = [];
  sandbox.window.getCurrentSessionId = () => SID;
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, state); };
  sandbox.window.getChatHistory = () => chatHistory.slice();
  sandbox.window.replaceChatHistory = async (msgs) => { chatHistory = JSON.parse(JSON.stringify(msgs)); };
  sandbox.showToast = () => {};   // 跳转提示在沙箱里静音（真实现吃 DOM）
  sandbox.document = {
    createElement: () => ({ className: '', innerHTML: '', hidden: false, style: {}, listeners: {},
      addEventListener() {}, remove() {} }),
    getElementById: id => (els[id]
      ? els[id]
      : (sandbox.__field && sandbox.__field[id] !== undefined ? { value: sandbox.__field[id] } : null)),
    body: { appendChild: () => {} },
  };
  sandbox.escapeHtml = t => String(t == null ? '' : t);
  const runCtx = code => vm.runInContext(code, sandbox, { filename: 'graph-history-cursor.mjs' });
  const tick = () => new Promise(r => setTimeout(r, 10));
  const els = {};   // 历史面板渲染检查用：getElementById 供给面板内部件
  const reset = () => {
    mem = { customNodes: [], marker: '' };
    chatHistory = [];
    runCtx('graphHistorySession = ' + JSON.stringify(SID) + '; graphUndoStack = [];'
      + ' graphHistoryCursor = 0; graphHistoryLive = null; graphPendingLiveMeta = null;');
    delete storageData[HIST_KEY];
  };
  const edit = (nodes) => { mem.customNodes = nodes; };
  try {
    check('T365: 持久化 v2 信封——游标与「最新」锚点随盘，锚点带全量实体', () => {
      reset();
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: { a: 1 }, messages: null, meta: { source: "user", summary: "一", ts: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: { a: 2 }, messages: null, meta: { source: "user", summary: "二", ts: 2 } } ];'
        + 'graphHistoryCursor = 1;'
        + 'graphHistoryLive = { sessionId: ' + JSON.stringify(SID) + ', state: { z: 9 }, messages: null, meta: { source: "now", summary: "最新状态", ts: 3 } };');
      runCtx('_persistGraphHistory();');
      const raw = JSON.parse(storageData[HIST_KEY]);
      if (raw.v !== 2 || !Array.isArray(raw.e)) throw new Error('不是 v2 信封：' + JSON.stringify(Object.keys(raw)));
      if (raw.e.length !== 2 || raw.c !== 1) throw new Error('条目/游标不对：' + raw.e.length + '/' + raw.c);
      if (!raw.l || raw.l.state.z !== 9 || raw.l.meta.summary !== '最新状态') throw new Error('最新锚点没随盘');
      // 时间旅行位归零后锚点必须清掉，不许把过期锚点写进存档
      runCtx('graphHistoryCursor = 2; graphHistoryLive = null;');
      runCtx('_persistGraphHistory();');
      const raw2 = JSON.parse(storageData[HIST_KEY]);
      if (raw2.c !== 2 || raw2.l !== null) throw new Error('回 到最新后锚点应清空：c=' + raw2.c + ' l=' + JSON.stringify(raw2.l));
      return true;
    });

    check('T365: 装载两吃——旧裸数组＝游标在末尾无锚点；v2 信封＝游标与锚点原样恢复', () => {
      reset();
      storageData[HIST_KEY] = JSON.stringify([
        { sessionId: SID, state: { a: 1 }, meta: null },
        { sessionId: SID, state: { a: 2 }, meta: null },
      ]);
      runCtx('graphHistorySession = "stale_旧会话"; graphUndoStack = [];');  // 逼 _ensureGraphHistory 真装载
      runCtx('_ensureGraphHistory();');
      if (runCtx('graphUndoStack.length') !== 2) throw new Error('裸数组没装载');
      if (runCtx('graphHistoryCursor') !== 2) throw new Error('旧格式游标应在末尾：' + runCtx('graphHistoryCursor'));
      if (runCtx('graphHistoryLive') !== null) throw new Error('旧格式不应有锚点');
      // v2 信封：游标 0 ＋ 锚点在位（=刷新前正停在历史中位的现场还原）
      const env = JSON.stringify({ v: 2, e: [{ sessionId: SID, state: { b: 1 }, meta: null }], c: 0,
        l: { sessionId: SID, state: { z: 1 }, meta: { source: 'now', summary: '最新状态', ts: 5 } } });
      storageData[HIST_KEY] = env;
      runCtx('graphHistorySession = "stale_旧会话"; graphUndoStack = [];');
      runCtx('_ensureGraphHistory();');
      if (runCtx('graphUndoStack.length') !== 1 || runCtx('graphHistoryCursor') !== 0) {
        throw new Error('v2 信封装载不对：' + runCtx('graphUndoStack.length') + '/' + runCtx('graphHistoryCursor'));
      }
      const live = JSON.parse(runCtx('JSON.stringify(graphHistoryLive)'));
      if (!live || live.state.z !== 1) throw new Error('v2 锚点没恢复');
      // 越界游标钳回末尾（防手改/旧版本脏数据炸面板）
      storageData[HIST_KEY] = JSON.stringify({ v: 2, e: [{ sessionId: SID, state: { b: 1 }, meta: null }], c: 99, l: null });
      runCtx('graphHistorySession = "stale_旧会话"; graphUndoStack = [];');
      runCtx('_ensureGraphHistory();');
      if (runCtx('graphHistoryCursor') !== 1) throw new Error('越界游标没钳回末尾');
      return true;
    });

    check('T365: 静态契约——跳转不再截断条目、推送带时间旅行分支、双栈符号零残留', () => {
      // T397 拆分：撤销链在 graph-history-diff.js，_jumpGraphVersion 是该件末函数（切到文件尾）
      const src = fs.readFileSync('src/static/js/graph-history-diff.js', 'utf8');
      const jump = src.slice(src.indexOf('async function _jumpGraphVersion'));
      if (/slice\(0,\s*versionIndex\)/.test(jump)) throw new Error('跳转还在截断历史（非破坏契约被破）');
      if (!/graphHistoryCursor = versionIndex/.test(jump)) throw new Error('跳转没挪游标');
      const push = src.slice(src.indexOf('function _pushGraphUndo('), src.indexOf('async function _restoreGraphVersion'));
      if (!/graphHistoryCursor < graphUndoStack\.length/.test(push)) throw new Error('_pushGraphUndo 没有时间旅行截断分支');
      if (['graph.js', 'graph-history.js', 'graph-history-diff.js', 'graph-history-panel.js']
        .some(f => fs.readFileSync('src/static/js/' + f, 'utf8').includes('graphRedoStack'))) {
        throw new Error('双栈符号 graphRedoStack 残留');
      }
      return true;
    });

    check('T365: 历史面板渲染——位置指示／当前位置标记／未来区段／回到最新都在', () => {
      reset();
      for (const k of Object.keys(els)) delete els[k];
      els.graphHistoryList = { className: '', innerHTML: '', hidden: false };
      els.graphHistoryDiffText = { className: '', innerHTML: '', hidden: false };
      els.graphHistoryPos = { className: '', textContent: '', hidden: false };
      // 三条历史＋游标停在 1（时间旅行中）：锚点补在历史顶
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: { a: 1 }, messages: null, meta: { source: "user", summary: "一", ts: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: { a: 2 }, messages: null, meta: { source: "user", summary: "二", ts: 2 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: { a: 3 }, messages: null, meta: { source: "user", summary: "三", ts: 3 } } ];'
        + 'graphHistoryCursor = 1;'
        + 'graphHistoryLive = { sessionId: ' + JSON.stringify(SID) + ', state: { z: 1 }, messages: null, meta: { source: "now", summary: "最新状态", ts: 4 } };');
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel();');
      const list = els.graphHistoryList.innerHTML;
      try {
        if (els.graphHistoryPos.textContent !== '位置 2 / 4') {
          throw new Error('位置指示不对：' + els.graphHistoryPos.textContent);
        }
        if (!list.includes('以下为未来') || !list.includes('可重做 2 步')) throw new Error('未来区段分隔条缺失');
        if (!list.includes('当前位置')) throw new Error('游标位没有「当前位置」标记');
        if (!list.includes('回到最新')) throw new Error('「最新状态」行没有回到最新按钮');
        if (!list.includes('回到此版本')) throw new Error('历史行没有回到此版本按钮');
        // 回到最新位渲染：锚点行消失、未来分隔条消失、位置到末尾
        runCtx('graphHistoryCursor = 3; graphHistoryLive = null; graphHistoryLastSignature = ""; _refreshGraphHistoryPanel();');
        if (els.graphHistoryPos.textContent !== '位置 4 / 4') {
          throw new Error('最新位位置指示不对：' + els.graphHistoryPos.textContent);
        }
        if (els.graphHistoryList.innerHTML.includes('以下为未来')) throw new Error('最新位不应有未来区段');
      } finally {
        runCtx('closeGraphHistoryPanel();');
      }
      return true;
    });

    check('T365: 端到端——撤销/重做沿游标走、跳转非破坏、跳回最新、无变化不截断、真编辑才截断', async () => {
      reset();
      // 三次「编辑前推送」，每次 state 真变化（customNodes 是 diff 认得的字段）
      edit([]);
      runCtx('_pushGraphUndo();');                    // entries[0] = []
      edit([_node('n1')]);
      runCtx('_pushGraphUndo();');                    // entries[1] = [n1]
      edit([_node('n1'), _node('n2')]);
      runCtx('_pushGraphUndo();');                    // entries[2] = [n1,n2]
      if (runCtx('graphHistoryCursor + "/" + graphUndoStack.length') !== '3/3') {
        throw new Error('三次推送后游标/条目不对');
      }
      // 撤销 ×2：游标 3→2→1，恢复对应条目；锚点在第一次离开最新时懒捕获
      await runCtx('_undoGraphAction()'); await tick();
      if (runCtx('graphHistoryCursor') !== 2) throw new Error('第一次撤销游标没到 2');
      if (JSON.parse(runCtx('JSON.stringify(_graphState().customNodes.map(n=>n.id))')).join() !== 'n1,n2') {
        throw new Error('第一次撤销恢复的不是 entries[2]');
      }
      if (!JSON.parse(runCtx('JSON.stringify(!!graphHistoryLive)'))) throw new Error('离开最新位没锚定当前状态');
      await runCtx('_undoGraphAction()'); await tick();
      if (runCtx('graphHistoryCursor') !== 1) throw new Error('第二次撤销游标没到 1');
      if (JSON.parse(runCtx('JSON.stringify(_graphState().customNodes.map(n=>n.id))')).join() !== 'n1') {
        throw new Error('第二次撤销恢复的不是 entries[1]');
      }
      // 重做 ×2：走条目 → 走锚点回最新，锚点消费掉
      await runCtx('_redoGraphAction()'); await tick();
      if (runCtx('graphHistoryCursor') !== 2) throw new Error('第一次重做游标没到 2');
      await runCtx('_redoGraphAction()'); await tick();
      if (runCtx('graphHistoryCursor') !== 3) throw new Error('重做没一步到最新（应恢复锚点）');
      if (JSON.parse(runCtx('JSON.stringify(graphHistoryLive)')) !== null) throw new Error('回到最新后锚点没消费');
      // 跳转非破坏：回到最初版本，三条历史一条不少
      await runCtx('_jumpGraphVersion(0)'); await tick();
      if (runCtx('graphHistoryCursor') !== 0) throw new Error('跳转游标没到 0');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('跳转删了历史条目（非破坏契约被破）');
      if (JSON.parse(runCtx('JSON.stringify(_graphState().customNodes)')).length !== 0) {
        throw new Error('跳转后恢复的不是最初版本');
      }
      // 点「最新状态」＝撤销回退：恢复锚点、游标回末尾
      await runCtx('_jumpGraphVersion(3)'); await tick();
      if (runCtx('graphHistoryCursor') !== 3) throw new Error('回到最新游标没到末尾');
      if (JSON.parse(runCtx('JSON.stringify(graphHistoryLive)')) !== null) throw new Error('回到最新后锚点应清空');
      // 时间旅行位推送：无变化（state+messages 全同）不截断未来
      await runCtx('_jumpGraphVersion(1)'); await tick();
      const entriesBefore = runCtx('graphUndoStack.length');
      edit([_node('n1')]);                            // 与 entries[1] 逐字相同
      runCtx('_pushGraphUndo();');
      if (runCtx('graphUndoStack.length') !== entriesBefore) throw new Error('无变化推送也截断了未来');
      if (runCtx('graphHistoryCursor') !== 1) throw new Error('无变化推送不该挪游标');
      if (!JSON.parse(runCtx('JSON.stringify(!!graphHistoryLive)'))) throw new Error('无变化推送不该丢锚点');
      // 时间旅行位真编辑：截断未来＋按常规定条目，游标落回最新位
      edit([_node('n9')]);
      runCtx('_pushGraphUndo();');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('截断后应剩 2 条旧条目＋1 条新条目');
      if (runCtx('graphHistoryCursor') !== 3) throw new Error('真编辑后游标应回最新位');
      if (JSON.parse(runCtx('JSON.stringify(graphHistoryLive)')) !== null) throw new Error('真编辑后锚点应清空');
      const tail = JSON.parse(runCtx('JSON.stringify(graphUndoStack[2].state.customNodes.map(n=>n.id))'));
      if (tail.join() !== 'n9') throw new Error('新条目不是编辑前状态：' + tail.join());
      // 落盘信封的游标与条目数一致
      runCtx('_persistGraphHistory();');
      const raw = JSON.parse(storageData[HIST_KEY]);
      if (raw.c !== 3 || raw.e.length !== 3 || raw.l !== null) {
        throw new Error('落盘信封不对：c=' + raw.c + ' e=' + raw.e.length + ' l=' + JSON.stringify(raw.l));
      }
      return true;
    });

    await drain();
  } finally {
    restoreWindowStub('getCurrentSessionId', prevSid);
    restoreWindowStub('getGraphState', prevGet);
    restoreWindowStub('saveGraphState', prevSave);
    restoreWindowStub('getChatHistory', prevChat);
    restoreWindowStub('replaceChatHistory', prevReplace);
    if (prevToast === undefined) delete sandbox.showToast; else sandbox.showToast = prevToast;
    sandbox.document = prevDoc;
    sandbox.escapeHtml = prevEsc;
    delete sandbox.__field;
    if (prevHist === undefined) delete storageData[HIST_KEY]; else storageData[HIST_KEY] = prevHist;
  }
}
