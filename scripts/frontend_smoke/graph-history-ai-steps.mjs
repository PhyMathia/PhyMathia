// 修改历史的事件点与截断（2026-10-24，R1/3.1/3.2/3.3/1.2/1.3；同日简化批次改口）：
//   ①提问/重生成在建点之前落一个历史点——撤销粒度＝一整次提问；
//   ②行时间＝形成这个状态的上一动作启动时间（摘要与时间对齐，治 R1b）；
//   ③回退后落真编辑＝按业界惯例直接丢弃被跳过的「未来」（原单槽「另一条路」退役），
//     toast 指路「⧉ 另开」；旧信封的 s 字段读回静默忽略、不再写出；
//   ④退出结算：正常关闭才清，F5/强杀/指纹不一致/多标签都不清。
// 执行顺序：同步例在前、异步例全部排到最后。异步 check 注册即开跑（跑到第一个 await
// 前是同步的），与后面的同步例共用沙箱会互相拆台（AGENTS 冒烟混排坑实锤）。
import fs from 'node:fs';
import { check, drain, sandbox, vm, storageData, restoreWindowStub } from './_runner.mjs';

const SID = 'sess_history_ai';
const HIST_KEY = 'phymathia_graph_history_' + SID;
const EXIT_KEY = 'phymathia_graph_history_exit_' + SID;

function _note(id, extra) {
  return Object.assign({ id: id, kind: 'note', manual: true, messageIndex: -1, timestamp: 100, content: '正文 ' + id, title: '', status: 'done', x: 100, y: 100 }, extra || {});
}
function _state(nodes) {
  return { hidden: {}, connections: [], removedEdges: [], groups: [], customNodes: nodes || [] };
}
function _mkEl(tag) {
  return {
    tagName: tag, className: '', innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {}, children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { this.children.push(c); return c; }, remove() {},
    addEventListener() {}, setAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { width: 1200, height: 900, left: 0, top: 0 }; },
    scrollIntoView() {},
  };
}

export async function run() {
  const prevSid = sandbox.window.getCurrentSessionId, prevGet = sandbox.window.getGraphState;
  const prevSave = sandbox.window.saveGraphState, prevChat = sandbox.window.getChatHistory;
  const prevReplace = sandbox.window.replaceChatHistory, prevToast = sandbox.showToast;
  const prevToastMsg = sandbox.toastMsg;
  const prevDoc = sandbox.document, prevEsc = sandbox.escapeHtml;
  const prevPerf = sandbox.performance;
  const prevReadonly = sandbox.window.PHYMATHIA_READONLY;
  const prevHist = storageData[HIST_KEY], prevExit = storageData[EXIT_KEY];
  delete storageData[HIST_KEY];
  delete storageData[EXIT_KEY];
  let mem = _state([]);
  let chat = [];
  const els = {};
  const toasts = [];
  sandbox.window.getCurrentSessionId = () => SID;
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, JSON.parse(JSON.stringify(state))); };
  sandbox.window.getChatHistory = () => chat.slice();
  sandbox.window.replaceChatHistory = async (msgs) => { chat = JSON.parse(JSON.stringify(msgs)); };
  sandbox.showToast = text => { toasts.push(String(text)); };
  sandbox.toastMsg = text => { toasts.push(String(text)); };  // 截断指路 toast 走 toastMsg
  sandbox.escapeHtml = t => String(t == null ? '' : t);
  sandbox.document = {
    createElement: tag => _mkEl(tag),
    createElementNS: (_ns, tag) => _mkEl(tag),
    getElementById: id => els[id] || null,
    getSelection: () => null,
    body: { appendChild: () => {} },
  };
  sandbox.performance = { now: () => Date.now() };
  // 宽松 window 代理对任何属性都返回可调用的代理（truthy）——只读闸门必须显式置 false，
  // 否则退出结算/定稿清空全被 phyIsReadonly() 拦下（本域实踩）。
  sandbox.window.PHYMATHIA_READONLY = false;
  const runCtx = code => vm.runInContext(code, sandbox);
  const reset = () => {
    mem = _state([]);
    chat = [];
    toasts.length = 0;
    Object.keys(els).forEach(k => delete els[k]);
    runCtx('graphCanvas = null; graphInner = null; graphHistoryPanel = null;'
      + 'graphHistorySession = ' + JSON.stringify(SID) + '; graphUndoStack = [];'
      + ' graphHistoryCursor = 0; graphHistoryLive = null;'
      + ' graphPendingLiveMeta = null; graphHistoryPendingTruncate = false;'
      + ' graphHistoryPreviewing = -1; graphHistoryDiffModel = null; graphHistoryLiveDirty = true;'
      + ' graphHistoryLiveMetaCache = null; graphHistorySavedAt = 0;');
    delete storageData[HIST_KEY];
    delete storageData[EXIT_KEY];
  };
  const pushState = (nodes) => { mem = _state(nodes); runCtx('_pushGraphUndo();'); };
  const seed = (count) => {
    reset();
    for (let i = 0; i < count; i++) pushState(Array.from({ length: i + 1 }, (_, k) => _note('n' + k)));
  };
  try {
    check('3.1/3.2 提问事件点：动作挂在当前行，落库条目粒度＝一整次提问', () => {
      reset();
      pushState([_note('n1')]);                       // 第一次编辑前的空状态
      runCtx('_pushGraphUndo(false, { source: "ai", summary: "提问：为什么会这样" });');
      const pending = JSON.parse(runCtx('JSON.stringify(graphPendingLiveMeta)'));
      if (!pending || pending.source !== 'ai' || !/^提问：/.test(pending.summary)) {
        throw new Error('提问事件没挂到当前行：' + JSON.stringify(pending));
      }
      if (runCtx('graphUndoStack.length') !== 1) throw new Error('无变化推送不该落新条目');
      // 提问跑完（问题＋回答＋模块落进图）→ 事件收尾补计数
      mem = _state([_note('n1'), _note('q1'), _note('a1'), _note('m1')]);
      runCtx('_graphHistoryLiveEventDone();');
      const live = JSON.parse(runCtx('JSON.stringify(graphPendingLiveMeta)'));
      if (!live || !live.counts || live.counts.vanish !== 3) throw new Error('事件收尾没给当前行补计数：' + JSON.stringify(live));
      // 下一次推送把提问结果记成条目：AI 来源 + 差异摘要 + 计数 + 投影
      runCtx('_pushGraphUndo();');
      const entries = JSON.parse(runCtx('JSON.stringify(graphUndoStack)'));
      if (entries.length !== 2) throw new Error('提问结果没落成条目：' + entries.length);
      const last = entries[1];
      if (last.meta.source !== 'ai') throw new Error('条目没继承 AI 来源：' + last.meta.source);
      if (!/新增节点/.test(last.meta.summary)) throw new Error('条目摘要没描述提问效果：' + last.meta.summary);
      if (!last.meta.counts || last.meta.counts.vanish !== 3) throw new Error('条目计数不对：' + JSON.stringify(last.meta.counts));
      if (!last.meta.proj || !last.meta.proj.n) throw new Error('条目没带内容投影（旧数据兼容会降级）');
      return true;
    });

    check('3.3 时间对齐：行时间＝上一动作启动时间，摘要与时间不是两步错位', () => {
      reset();
      pushState([_note('n1')]);
      runCtx('graphUndoStack[0].meta.pushedAt = 1111; graphUndoStack[0].meta.ts = 1111;');
      mem = _state([_note('n1'), _note('n2')]);
      runCtx('_pushGraphUndo();');
      const e = JSON.parse(runCtx('JSON.stringify(graphUndoStack[1])'));
      if (e.meta.ts !== 1111) throw new Error('新行时间没取上一动作启动时间：' + e.meta.ts);
      if (!(e.meta.pushedAt > 1111)) throw new Error('pushedAt 没记录本次动作启动时间');
      return true;
    });

    check('1.2 持久化（简化批次）：信封不再写 s；旧信封的 s 读回被静默忽略', () => {
      seed(3);
      runCtx('_persistGraphHistory();');
      const raw = JSON.parse(storageData[HIST_KEY]);
      if ('s' in raw) throw new Error('信封还在写 s 字段：' + JSON.stringify(Object.keys(raw)));
      if (!raw.t) throw new Error('信封没带落盘时间（12h 兜底要用）');
      if (runCtx('typeof graphHistorySlot') !== 'undefined') throw new Error('单槽符号还有残留');
      // 旧格式（带 s 的存量信封）读回：条目/游标照常装载，s 一眼不看、不炸不接
      const legacy = JSON.parse(JSON.stringify(raw));
      legacy.s = { b: 1, at: 9, e: [{ sessionId: SID, state: _state([_note('old')]), meta: null }], l: null };
      storageData[HIST_KEY] = JSON.stringify(legacy);
      runCtx('graphHistorySession = "stale_旧会话"; graphUndoStack = [];');
      runCtx('_ensureGraphHistory();');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('旧信封的条目没装载：' + runCtx('graphUndoStack.length'));
      if (runCtx('typeof graphHistorySlot') !== 'undefined') throw new Error('旧信封的 s 竟然活了');
      return true;
    });

    check('静态契约：提问/苏格拉底/重生成都在改写内容之前落历史点', () => {
      const tpl = fs.readFileSync('src/static/js/graph-workflow-template.js', 'utf8');
      const qStart = tpl.indexOf('async function startQuestionWorkflow');
      const qEnd = tpl.indexOf('const SOCRATIC_USER_NODE_LABELS');
      const q = tpl.slice(qStart, qEnd);
      if (q.indexOf('_pushGraphUndo') < 0) throw new Error('提问入口没落历史点');
      if (q.indexOf('_pushGraphUndo') > q.indexOf('_createQuestionWorkflowTemplate(question')) throw new Error('提问历史点在建节点之后（粒度过细）');
      const s = tpl.slice(tpl.indexOf('async function startSocraticWorkflow'));
      if (s.indexOf('_pushGraphUndo') < 0) throw new Error('苏格拉底入口没落历史点');
      const wf = fs.readFileSync('src/static/js/graph-workflow-entry.js', 'utf8');
      const regen = wf.slice(wf.indexOf('async function runWorkflowNode'), wf.indexOf('async function runWorkflowNodes'));
      if (regen.indexOf('_pushGraphUndo') < 0) throw new Error('重生成入口没落历史点');
      if (regen.indexOf('_pushGraphUndo') > regen.indexOf('await _executeParallelWorkflow([nodeId]')) throw new Error('重生成历史点在改写之后');
      return true;
    });

    // ===== 异步例：串行队列逐个 await =====
    // 不能写成多个 async check——check 注册即调用，函数跑到第一个 await 就让出，
    // 下一个例的 seed() 会当场把上一个例的沙箱重置（AGENTS 冒烟混排坑）。
    const serial = [];
    serial.push(['1.2 截断即丢弃（简化批次）：真编辑后未来直接没了，toast 指路另开', async () => {
      seed(8);
      await runCtx('_jumpGraphVersion(4)');
      runCtx('_pushGraphUndo();');                    // 编辑前的推送：相同→挂待截断
      if (!runCtx('graphHistoryPendingTruncate')) throw new Error('时间旅行位没挂待截断标记');
      // 第一笔真编辑落盘＝立即截断：未来 3 步直接丢弃（不再存槽），游标回最新位
      toasts.length = 0;
      mem = _state(Array.from({ length: 5 }, (_, k) => _note('n' + k, { content: 'edited' })));
      runCtx('_saveGraphState(_graphState());');
      if (runCtx('graphUndoStack.length') !== 5 || runCtx('graphHistoryCursor') !== 5) {
        throw new Error('第一次编辑没截断未来：' + runCtx('graphHistoryCursor + "/" + graphUndoStack.length'));
      }
      const notice = toasts.find(t => t.indexOf('已舍去后面的 3 步') >= 0 && t.indexOf('另开') >= 0);
      if (!notice) throw new Error('截断没弹指路 toast：' + JSON.stringify(toasts));
      // 重做到头即 no-op（未来没了）；信封也不带 s
      await runCtx('_redoGraphAction()');
      if (runCtx('graphHistoryCursor') !== 5) throw new Error('截断后竟然还能重做');
      const raw = JSON.parse(storageData[HIST_KEY]);
      if ('s' in raw) throw new Error('截断后的信封还写 s');
      // 再回退再编辑：丢弃计数按新一次算（没有旁路可以捡回来）
      await runCtx('_jumpGraphVersion(3)');
      runCtx('_pushGraphUndo();');
      toasts.length = 0;
      mem = _state([_note('n0'), _note('n1', { content: 'again' })]);
      runCtx('_saveGraphState(_graphState());');
      if (runCtx('graphUndoStack.length') !== 4) throw new Error('第二次截断条目不对：' + runCtx('graphUndoStack.length'));
      if (!toasts.some(t => t.indexOf('已舍去后面的 1 步') >= 0)) throw new Error('第二次截断没提示：' + JSON.stringify(toasts));
      return true;
    }]);

    serial.push(['1.3 退出结算：正常关闭清三处；F5 不清；指纹不一致不清', async () => {
      seed(3);
      runCtx('_persistGraphHistory(); markGraphHistoryCleanExit();');
      if (!storageData[EXIT_KEY]) throw new Error('正常关闭没写标记');
      // F5：只作废标记，历史原样
      sandbox.performance.getEntriesByType = () => [{ type: 'reload' }];
      await runCtx('settleGraphHistoryOnOpen()');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('F5 把历史清了');
      if (storageData[EXIT_KEY]) throw new Error('F5 后标记没清（下次会误判）');
      // 指纹不一致（模拟多标签改了游标）：不清
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      runCtx('markGraphHistoryCleanExit(); graphHistoryCursor = 1;');
      await runCtx('settleGraphHistoryOnOpen()');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('指纹不一致却清了历史');
      // 正常关闭：清内存栈/本地/服务端镜像
      runCtx('graphHistoryCursor = 3; markGraphHistoryCleanExit();');
      await runCtx('settleGraphHistoryOnOpen()');
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('正常退出后历史没清');
      if (storageData[HIST_KEY]) throw new Error('本地历史键没删');
      if (storageData[EXIT_KEY]) throw new Error('标记没清');
      return true;
    }]);

    serial.push(['1.3 退出时停在历史版本：先用锚点回最新，再结算', async () => {
      seed(4);
      runCtx('_persistGraphHistory();');
      await runCtx('_jumpGraphVersion(1)');            // 停在历史中位，锚点＝最新
      runCtx('markGraphHistoryCleanExit();');
      await runCtx('settleGraphHistoryOnOpen()');
      if ((mem.customNodes || []).length !== 4) throw new Error('结算前没回到最新（图状态停在旧版本）');
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('回到最新后历史没清');
      return true;
    }]);

    serial.push(['面板手动口：定稿清空只清历史，不动当前图', async () => {
      seed(3);
      els.graphHistoryList = _mkEl('div');
      els.graphHistoryPos = _mkEl('span');
      els.graphHistoryDiffText = _mkEl('div');
      runCtx('openGraphHistoryPanel();');
      await runCtx('settleGraphHistoryNow()');
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('定稿清空没清掉历史');
      if ((mem.customNodes || []).length !== 3) throw new Error('定稿清空把图状态也动了');
      runCtx('closeGraphHistoryPanel();');
      return true;
    }]);

    for (const [name, fn] of serial) {
      let result;
      try { result = await fn(); }
      catch (e) { check(name, () => { throw e; }); continue; }
      check(name, () => {
        if (result === false) throw new Error('断言未通过');
        return true;
      });
    }

    await drain();
  } finally {
    restoreWindowStub('getCurrentSessionId', prevSid);
    restoreWindowStub('getGraphState', prevGet);
    restoreWindowStub('saveGraphState', prevSave);
    restoreWindowStub('getChatHistory', prevChat);
    restoreWindowStub('replaceChatHistory', prevReplace);
    if (prevToast === undefined) delete sandbox.showToast; else sandbox.showToast = prevToast;
    if (prevToastMsg === undefined) delete sandbox.toastMsg; else sandbox.toastMsg = prevToastMsg;
    sandbox.document = prevDoc;
    sandbox.escapeHtml = prevEsc;
    sandbox.performance = prevPerf;
    sandbox.window.PHYMATHIA_READONLY = prevReadonly;
    if (prevHist === undefined) delete storageData[HIST_KEY]; else storageData[HIST_KEY] = prevHist;
    if (prevExit === undefined) delete storageData[EXIT_KEY]; else storageData[EXIT_KEY] = prevExit;
  }
}
