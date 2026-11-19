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
const SWEEP_KEY = 'phymathia_graph_history_sweep';
// 500 双标签守卫：活标签页在场登记（tabId≠本页的他牌，本页自己的牌由 vm 内部写、读侧自排除）
const TAB_OTHER_KEY = 'phymathia_open_tab_tab_other';
const OTHER_SID = 'sess_history_other';
const OTHER_HIST_KEY = 'phymathia_graph_history_' + OTHER_SID;
const OTHER_EXIT_KEY = 'phymathia_graph_history_exit_' + OTHER_SID;
// v2 全量扫描：多张存量画布（有历史键但从没进过名单、也没有 per-sid 标记＝真实存量形状）
const STOCK_SIDS = ['sess_stock_a', 'sess_stock_b', 'sess_stock_c', 'sess_stock_d', 'sess_stock_nomark'];
const STOCK_HIST_KEYS = STOCK_SIDS.map(sid => 'phymathia_graph_history_' + sid);
const STOCK_EXIT_KEYS = STOCK_SIDS.map(sid => 'phymathia_graph_history_exit_' + sid);

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
  const prevSweep = storageData[SWEEP_KEY], prevOtherH = storageData[OTHER_HIST_KEY], prevOtherE = storageData[OTHER_EXIT_KEY];
  const prevTabOther = storageData[TAB_OTHER_KEY];
  const prevStock = STOCK_HIST_KEYS.map(k => storageData[k]);
  const prevStockExit = STOCK_EXIT_KEYS.map(k => storageData[k]);
  delete storageData[HIST_KEY];
  delete storageData[EXIT_KEY];
  delete storageData[SWEEP_KEY];
  delete storageData[OTHER_HIST_KEY];
  delete storageData[OTHER_EXIT_KEY];
  delete storageData[TAB_OTHER_KEY];
  STOCK_HIST_KEYS.forEach(k => { delete storageData[k]; });
  STOCK_EXIT_KEYS.forEach(k => { delete storageData[k]; });
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
      + ' _graphPendingLiveMetaSet(graphHistorySession, null); graphHistoryPendingTruncate = false;'
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
      const pending = JSON.parse(runCtx('JSON.stringify(_graphPendingLiveMetaOf(graphHistorySession))'));
      if (!pending || pending.source !== 'ai' || !/^提问：/.test(pending.summary)) {
        throw new Error('提问事件没挂到当前行：' + JSON.stringify(pending));
      }
      if (runCtx('graphUndoStack.length') !== 1) throw new Error('无变化推送不该落新条目');
      // 提问跑完（问题＋回答＋模块落进图）→ 事件收尾补计数
      mem = _state([_note('n1'), _note('q1'), _note('a1'), _note('m1')]);
      runCtx('_graphHistoryLiveEventDone();');
      const live = JSON.parse(runCtx('JSON.stringify(_graphPendingLiveMetaOf(graphHistorySession))'));
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

    serial.push(['2026-11-18 v2 全量回收：名单只登记当前画布，5 张从没登记过的存量历史（含无标记的）照样全清，exit/sweep 标记键不误伤', async () => {
      seed(2);
      runCtx('_persistGraphHistory();'); // 当前画布历史键＝HIST_KEY，必须保留
      // 真实存量形状：有历史载荷键，但从没进过名单、也大多没有 per-sid 退出标记
      STOCK_HIST_KEYS.forEach(k => {
        storageData[k] = JSON.stringify({ v: 2, e: [{ id: 'o1', kind: 'note', manual: true, messageIndex: -1, timestamp: 1, content: 'x', title: '', status: 'done', x: 0, y: 0 }], c: 1, t: Date.now() });
      });
      // list 里只有当前画布自己——这正是 v1 清 0 张、v2 清全部的分水岭
      runCtx('_graphHistorySweepWrite(["' + SID + '"]);');
      // 同前缀的标记键：扫历史键时必须排除，不能被当成画布历史 DELETE
      storageData[OTHER_EXIT_KEY] = JSON.stringify({ sid: OTHER_SID, at: Date.now() });
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      const cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
      // 共享沙箱里别的域也留着历史键，会被一并扫到——只断言本例造的 5 张确实被清
      if (cleared < STOCK_SIDS.length) throw new Error('全量回收至少应清 ' + STOCK_SIDS.length + ' 张存量，实际 ' + cleared);
      STOCK_HIST_KEYS.forEach((k, i) => { if (storageData[k]) throw new Error('存量 ' + STOCK_SIDS[i] + ' 本地键没删'); });
      if (!storageData[HIST_KEY]) throw new Error('当前画布历史被批量错误清掉（应留给单画布结算）');
      if (!storageData[OTHER_EXIT_KEY]) throw new Error('exit 标记键被误当成历史键清掉');
      if (runCtx('_graphHistorySweepRead().length') !== 0) throw new Error('sweep 名单没消费清空');
      return true;
    }]);

    serial.push(['2026-11-18 批量结算：F5 刷新作废 sweep 名单，一张都不清', async () => {
      seed(2);
      runCtx('_persistGraphHistory();');
      storageData[OTHER_HIST_KEY] = JSON.stringify({ v: 2, e: [], c: 0, t: Date.now() });
      storageData[OTHER_EXIT_KEY] = JSON.stringify({ sid: 'sess_history_other', at: Date.now() });
      runCtx('_graphHistorySweepWrite(["sess_history_other"]);');
      sandbox.performance.getEntriesByType = () => [{ type: 'reload' }];
      const cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
      if (cleared !== 0) throw new Error('F5 不该批量清');
      if (!storageData[OTHER_HIST_KEY]) throw new Error('F5 把其余画布历史清了');
      if (runCtx('_graphHistorySweepRead().length') !== 0) throw new Error('F5 后 sweep 名单没作废');
      return true;
    }]);

    serial.push(['2026-11-18 DELETE 失败：本地键与名单都保留（不白清、不丢重试机会）', async () => {
      seed(2);
      runCtx('_persistGraphHistory();'); // 当前画布 HIST_KEY 保留
      const failKey = STOCK_HIST_KEYS[0], failSid = STOCK_SIDS[0];
      storageData[failKey] = JSON.stringify({ v: 2, e: [{ id: 'o1', kind: 'note', manual: true, messageIndex: -1, timestamp: 1, content: 'x', title: '', status: 'done', x: 0, y: 0 }], c: 1, t: Date.now() });
      storageData['phymathia_graph_history_exit_' + failSid] = JSON.stringify({ sid: failSid, at: Date.now() });
      runCtx('_graphHistorySweepWrite(["' + SID + '"]);');
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      const prevFetch = sandbox.fetch;
      let deletes = 0;
      sandbox.fetch = async (url, opts) => {
        if ((opts && opts.method) === 'DELETE') { deletes++; throw new Error('net down'); }
        return prevFetch(url, opts);
      };
      try {
        const cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
        if (cleared !== 0) throw new Error('DELETE 全失败不该有成功数，实际 ' + cleared);
        if (deletes < 1) throw new Error('没有发出 DELETE 请求');
        // 关键两条：本地键保留（否则服务端旧栈会复活且再也扫不到）；名单保留（下次重试）
        if (!storageData[failKey]) throw new Error('DELETE 失败却删了本地键——下次会被服务端旧栈灌回');
        if (!storageData['phymathia_graph_history_exit_' + failSid]) throw new Error('DELETE 失败却删了退出标记');
        if (runCtx('_graphHistorySweepRead().length') === 0) throw new Error('DELETE 失败却消费了名单——丢失重试机会');
      } finally { sandbox.fetch = prevFetch; }
      return true;
    }]);

    serial.push(['2026-11-18 DELETE 失败后重试成功：残留键被清且名单消费', async () => {
      seed(2);
      runCtx('_persistGraphHistory();');
      const retryKey = STOCK_HIST_KEYS[1], retrySid = STOCK_SIDS[1];
      storageData[retryKey] = JSON.stringify({ v: 2, e: [{ id: 'o2', kind: 'note', manual: true, messageIndex: -1, timestamp: 2, content: 'y', title: '', status: 'done', x: 0, y: 0 }], c: 1, t: Date.now() });
      storageData['phymathia_graph_history_exit_' + retrySid] = JSON.stringify({ sid: retrySid, at: Date.now() });
      runCtx('_graphHistorySweepWrite(["' + SID + '"]);');
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      const cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
      if (cleared < 1) throw new Error('恢复后重试应至少清 1 张，实际 ' + cleared);
      if (storageData[retryKey]) throw new Error('重试成功但残留键没删');
      if (storageData['phymathia_graph_history_exit_' + retrySid]) throw new Error('重试成功但退出标记没删');
      if (runCtx('_graphHistorySweepRead().length') !== 0) throw new Error('全部成功后名单没消费');
      return true;
    }]);

    serial.push(['2026-11-18 强杀/崩溃（名单空）不清：没写过正常退出名单，一张都不清', async () => {
      seed(2);
      runCtx('_persistGraphHistory();');
      storageData[STOCK_HIST_KEYS[0]] = JSON.stringify({ v: 2, e: [], c: 0, t: Date.now() });
      runCtx('_graphHistorySweepWrite([]);'); // 没发过 beforeunload → 名单空
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      const cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
      if (cleared !== 0) throw new Error('名单空却批量清了 ' + cleared + ' 张');
      if (!storageData[STOCK_HIST_KEYS[0]]) throw new Error('名单空却把存量清了');
      return true;
    }]);

    serial.push(['2026-11-18 502 兜底：名单空＋配额写失败 → 绕过名单全量清（自锁解锁）', async () => {
      seed(2);
      runCtx('_persistGraphHistory();'); // 当前画布 HIST_KEY 保留
      storageData[STOCK_HIST_KEYS[0]] = JSON.stringify({ v: 2, e: [{ id: 'o1', kind: 'note', manual: true, messageIndex: -1, timestamp: 1, content: 'x', title: '', status: 'done', x: 0, y: 0 }], c: 1, t: Date.now() });
      runCtx('_graphHistorySweepWrite([]);'); // 退出时名单写失败（配额满）→ 名单空的形状
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      const prevSet = sandbox.localStorage.setItem;
      sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
      try {
        const cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
        if (cleared < 1) throw new Error('配额满却没绕过名单清存量（自锁没解开）');
        if (storageData[STOCK_HIST_KEYS[0]]) throw new Error('502 兜底没清存量键');
        if (!storageData[HIST_KEY]) throw new Error('当前画布历史被误清（应留给单画布结算）');
      } finally { sandbox.localStorage.setItem = prevSet; }
      return true;
    }]);

    serial.push(['2026-11-18 502 兜底：F5＋配额写失败也全量清（牺牲 F5 守卫已拍板），探测正常时 F5 仍守卫', async () => {
      seed(2);
      runCtx('_persistGraphHistory();');
      storageData[STOCK_HIST_KEYS[0]] = JSON.stringify({ v: 2, e: [], c: 0, t: Date.now() });
      runCtx('_graphHistorySweepWrite([]);');
      sandbox.performance.getEntriesByType = () => [{ type: 'reload' }];
      const prevSet = sandbox.localStorage.setItem;
      sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
      let cleared = 0;
      try {
        cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
      } finally { sandbox.localStorage.setItem = prevSet; }
      if (cleared < 1) throw new Error('F5＋配额满没触发兜底清');
      if (storageData[STOCK_HIST_KEYS[0]]) throw new Error('F5＋配额满兜底没清存量键');
      // 对照：探测正常（setItem 已恢复）的 F5 仍守卫，一张不清
      const guarded = await runCtx('settleGraphHistoryBatchOnOpen()');
      if (guarded !== 0) throw new Error('探测正常时 F5 却清了 ' + guarded + ' 张');
      return true;
    }]);

    serial.push(['2026-11-18 502 兜底 v2：名单非空＋F5＋配额满也全量清（兜底不看名单；探测改 1MB 同量级）', async () => {
      seed(2);
      runCtx('_persistGraphHistory();');
      storageData[STOCK_HIST_KEYS[0]] = JSON.stringify({ v: 2, e: [], c: 0, t: Date.now() });
      runCtx('_graphHistorySweepWrite(["' + SID + '"]);'); // 名单非空：小写入成功过、大写入放不下的真实形状
      sandbox.performance.getEntriesByType = () => [{ type: 'reload' }];
      const prevSet = sandbox.localStorage.setItem;
      sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
      let cleared = 0;
      try {
        cleared = await runCtx('settleGraphHistoryBatchOnOpen()');
      } finally { sandbox.localStorage.setItem = prevSet; }
      if (cleared < 1) throw new Error('名单非空＋F5＋配额满没触发兜底清（v2 口径：兜底不看名单）');
      if (storageData[STOCK_HIST_KEYS[0]]) throw new Error('兜底没清存量键');
      if (!storageData[HIST_KEY]) throw new Error('当前画布历史被误清');
      return true;
    }]);

    serial.push(['2026-11-18 双标签守卫（backlog 500）：另一标签页正开着的画布批量不清、名单保留；残牌 TTL 过期照清', async () => {
      seed(2);
      runCtx('_persistGraphHistory();'); // 当前画布 HIST_KEY 保留
      const liveSid = STOCK_SIDS[2], liveKey = STOCK_HIST_KEYS[2];
      storageData[liveKey] = JSON.stringify({ v: 2, e: [], c: 0, t: Date.now() });
      // 另一个标签页（tabId≠本页）刚续过牌：正开着 liveSid——双开时一边退出、这边启动的形状
      storageData[TAB_OTHER_KEY] = JSON.stringify({ sid: liveSid, at: Date.now() });
      runCtx('_graphHistorySweepWrite(["' + SID + '"]);');
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      await runCtx('settleGraphHistoryBatchOnOpen()');
      if (!storageData[liveKey]) throw new Error('另一标签页正开着的画布历史被批量清了（编辑过能自愈，没编辑就丢）');
      if (runCtx('_graphHistorySweepRead().length') === 0) throw new Error('有跳过却消费了名单（那些画布关了就再也扫不到）');
      // 残牌按 TTL 判活：过期（崩溃/强杀没摘牌的残渣）不该把批量清挡死
      storageData[TAB_OTHER_KEY] = JSON.stringify({ sid: liveSid, at: Date.now() - 11 * 60 * 1000 });
      await runCtx('settleGraphHistoryBatchOnOpen()');
      if (storageData[liveKey]) throw new Error('TTL 过期的残牌把批量清挡死了');
      if (runCtx('_graphHistorySweepRead().length') !== 0) throw new Error('无可跳过且全清成功后名单没消费');
      return true;
    }]);

    serial.push(['2026-11-18 双标签守卫（backlog 500）：同画布双开，另一边没编辑指纹也对得上——开着就不结算；自牌不挡自己', async () => {
      seed(3);
      runCtx('_persistGraphHistory(); markGraphHistoryCleanExit();');
      storageData[TAB_OTHER_KEY] = JSON.stringify({ sid: SID, at: Date.now() }); // 另一标签页开着同一张
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      await runCtx('settleGraphHistoryOnOpen()');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('另一标签页开着这张画布却清了历史');
      if (!storageData[EXIT_KEY]) throw new Error('守卫跳过却把退出标记吃了（下次指纹就对不上了）');
      // 他牌退场后，本页自己的登记不该挡自己的结算（读侧按 tabId 自排除）
      delete storageData[TAB_OTHER_KEY];
      runCtx('_graphHistoryTabsRegister();');
      await runCtx('settleGraphHistoryOnOpen()');
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('自己的在场牌把自己的结算挡住了');
      if (storageData[EXIT_KEY]) throw new Error('结算后标记没清');
      return true;
    }]);

    serial.push(['2026-11-18 502 兜底也认双标签守卫：配额满绕名单清时，另一标签页正开着的画布保留', async () => {
      seed(2);
      runCtx('_persistGraphHistory();');
      const liveSid = STOCK_SIDS[3], liveKey = STOCK_HIST_KEYS[3];
      storageData[liveKey] = JSON.stringify({ v: 2, e: [], c: 0, t: Date.now() });
      storageData[TAB_OTHER_KEY] = JSON.stringify({ sid: liveSid, at: Date.now() });
      runCtx('_graphHistorySweepWrite([]);'); // 配额满退出名单写失败的形状
      sandbox.performance.getEntriesByType = () => [{ type: 'navigate' }];
      const prevSet = sandbox.localStorage.setItem;
      sandbox.localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
      try {
        await runCtx('settleGraphHistoryBatchOnOpen()');
        if (!storageData[liveKey]) throw new Error('502 兜底把另一标签页正开着的画布清了');
        // 残牌过期 → 照常兜底清（解锁优先的拍板只让给「正被看着」）
        storageData[TAB_OTHER_KEY] = JSON.stringify({ sid: liveSid, at: Date.now() - 11 * 60 * 1000 });
        await runCtx('settleGraphHistoryBatchOnOpen()');
        if (storageData[liveKey]) throw new Error('残牌过期后兜底没清（解锁被幽灵牌挡死）');
      } finally { sandbox.localStorage.setItem = prevSet; }
      return true;
    }]);

    serial.push(['面板手动口：清空历史内核只清历史，不动当前图（直接调内核，绕过武装）', async () => {
      seed(3);
      els.graphHistoryList = _mkEl('div');
      els.graphHistoryPos = _mkEl('span');
      els.graphHistoryDiffText = _mkEl('div');
      runCtx('openGraphHistoryPanel();');
      await runCtx('settleGraphHistoryNow()');
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('清空历史内核没清掉历史');
      if ((mem.customNodes || []).length !== 3) throw new Error('清空历史内核把图状态也动了');
      runCtx('closeGraphHistoryPanel();');
      return true;
    }]);

    serial.push(['2026-11-15 两步确认：第一下只武装、第二下才真清，关面板解除武装', async () => {
      seed(3);
      els.graphHistoryList = _mkEl('div');
      els.graphHistoryPos = _mkEl('span');
      els.graphHistoryDiffText = _mkEl('div');
      runCtx('openGraphHistoryPanel();');
      // 第一下：armed 态立起，历史一条不少（沙箱无真按钮，武装逻辑由变量驱动）
      runCtx('requestGraphHistoryClear();');
      if (!runCtx('graphHistoryClearArmed')) throw new Error('第一下没进 armed 态');
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('第一下就把历史清了');
      // 第二下：真清，armed 解除，图状态不动
      await runCtx('requestGraphHistoryClear();');
      if (runCtx('graphUndoStack.length') !== 0) throw new Error('第二下没清掉历史');
      if (runCtx('graphHistoryClearArmed')) throw new Error('清空后 armed 没解除');
      if ((mem.customNodes || []).length !== 3) throw new Error('两步清空把图状态也动了');
      // 再武装后关面板：确认态不跨次打开残留
      runCtx('requestGraphHistoryClear();');
      if (!runCtx('graphHistoryClearArmed')) throw new Error('再武装失败');
      runCtx('closeGraphHistoryPanel();');
      if (runCtx('graphHistoryClearArmed')) throw new Error('关面板没解除武装');
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
    if (prevSweep === undefined) delete storageData[SWEEP_KEY]; else storageData[SWEEP_KEY] = prevSweep;
    if (prevOtherH === undefined) delete storageData[OTHER_HIST_KEY]; else storageData[OTHER_HIST_KEY] = prevOtherH;
    if (prevOtherE === undefined) delete storageData[OTHER_EXIT_KEY]; else storageData[OTHER_EXIT_KEY] = prevOtherE;
    if (prevTabOther === undefined) delete storageData[TAB_OTHER_KEY]; else storageData[TAB_OTHER_KEY] = prevTabOther;
    STOCK_HIST_KEYS.forEach((k, i) => { if (prevStock[i] === undefined) delete storageData[k]; else storageData[k] = prevStock[i]; });
    STOCK_EXIT_KEYS.forEach((k, i) => { if (prevStockExit[i] === undefined) delete storageData[k]; else storageData[k] = prevStockExit[i]; });
  }
}
