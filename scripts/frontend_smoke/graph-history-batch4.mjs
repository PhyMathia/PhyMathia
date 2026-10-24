// 修改历史 · 批次 4（T389，2026-10-25）：另开探索线 + 打磨五件
//   ①合并连续编辑：1.2s 内对同一颗节点的连续改动只记一次；
//   ②起名收藏：钉住的步骤不被 30 条上限挤掉，名字随条目落盘；
//   ③容量提示：已记 X/30 步 · 体积 · 更早的 N 步已滚出；
//   ④单节点恢复：差异清单里只把这一颗换回那一步的版本；
//   ⑤恢复排版开关：恢复时保留当前排版（只换内容）；
//   ⑥另开探索线：从任意一步复制成新画布，标题带来源，历史从「分叉自…」开始。
// 执行顺序：同步例在前、异步例进串行队列（check 注册即开跑，异步例会让出给下一条）。
import fs from 'node:fs';
import { check, drain, sandbox, vm, storageData } from './_runner.mjs';

const SID = 'sess_history_b4';
const HIST_KEY = 'phymathia_graph_history_' + SID;
const SESSIONS_KEY = 'phymathia_sessions';
const CURRENT_KEY = 'phymathia_current_session';

function _note(id, extra) {
  return Object.assign({ id: id, kind: 'note', manual: true, messageIndex: -1, timestamp: 100, content: '正文 ' + id, title: '', status: 'done', x: 100, y: 100 }, extra || {});
}
function _state(nodes, extra) {
  return Object.assign({ hidden: {}, connections: [], removedEdges: [], groups: [], customNodes: nodes || [] }, extra || {});
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
  const prevDoc = sandbox.document, prevEsc = sandbox.escapeHtml;
  const prevReadonly = sandbox.window.PHYMATHIA_READONLY;
  const prevFetch = sandbox.fetch;
  const prevFork = sandbox.window.forkSessionFromSnapshot;
  const prevGetSession = sandbox.window.getSessionById;
  const prevPrompt = sandbox.window.prompt;
  const prevHist = storageData[HIST_KEY];
  delete storageData[HIST_KEY];
  let mem = _state([]);
  let chat = [];
  const els = {};
  const toasts = [];
  sandbox.window.getCurrentSessionId = () => SID;
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, JSON.parse(JSON.stringify(state))); };
  sandbox.window.getChatHistory = () => chat.slice();
  sandbox.window.replaceChatHistory = async msgs => { chat = JSON.parse(JSON.stringify(msgs)); };
  sandbox.showToast = text => { toasts.push(String(text)); };
  sandbox.toastMsg = text => { toasts.push(String(text)); };
  sandbox.escapeHtml = t => String(t == null ? '' : t);
  // 宽松 window 代理对任何属性都返回可调用代理（truthy）——只读闸门必须显式置 false
  sandbox.window.PHYMATHIA_READONLY = false;
  sandbox.document = {
    createElement: tag => _mkEl(tag),
    createElementNS: (_ns, tag) => _mkEl(tag),
    getElementById: id => els[id] || null,
    getSelection: () => null,
    body: { appendChild: () => {} },
  };
  const runCtx = code => vm.runInContext(code, sandbox);
  const reset = () => {
    mem = _state([]);
    chat = [];
    toasts.length = 0;
    Object.keys(els).forEach(k => delete els[k]);
    runCtx('graphCanvas = null; graphInner = null; graphHistoryPanel = null;'
      + 'graphHistorySession = ' + JSON.stringify(SID) + '; graphUndoStack = [];'
      + ' graphHistoryCursor = 0; graphHistoryLive = null; graphHistorySlot = null;'
      + ' graphPendingLiveMeta = null; graphHistoryPendingTruncate = false;'
      + ' graphHistoryPreviewing = -1; graphHistoryDiffModel = null; graphHistoryLiveDirty = true;'
      + ' graphHistoryLiveMetaCache = null; graphHistorySavedAt = 0; graphHistoryDropped = 0;'
      + ' graphHistoryBytes = 0; graphHistoryLastEffect = { op: "", touch: "", at: 0 };'
      + ' graphHistoryKeepLayout = false; graphHistoryLastSignature = "";');
    delete storageData[HIST_KEY];
  };
  const push = () => runCtx('_pushGraphUndo();');
  const panelEls = () => {
    els.graphHistoryList = _mkEl('div');
    els.graphHistoryPos = _mkEl('span');
    els.graphHistoryCap = _mkEl('span');
    els.graphHistoryLayoutToggle = _mkEl('button');
    els.graphHistorySlot = _mkEl('div');
    els.graphHistoryDiffText = _mkEl('div');
  };
  try {
    check('①合并连续编辑：1.2s 内同一颗节点连续改动只记一次，换节点/隔超时断开', () => {
      reset();
      mem = _state([_note('n1', { content: 'A' })]);
      push();                                   // 初始状态进栈（E0）
      mem = _state([_note('n1', { content: 'B' })]);
      push();                                   // 第一次编辑前：E1（锚点＝改 n1）
      const lenBefore = runCtx('graphUndoStack.length');
      if (lenBefore !== 2) throw new Error('前置：前两次推送应落两条：' + lenBefore);
      mem = _state([_note('n1', { content: 'C' })]);
      push();                                   // 同一节点 1.2s 内：并进上一步
      if (runCtx('graphUndoStack.length') !== 2) {
        throw new Error('同一节点连续编辑没合并：' + runCtx('graphUndoStack.length'));
      }
      // 换一颗节点：不合并，照常落条目
      mem = _state([_note('n1', { content: 'C' }), _note('n2', { content: 'X' })]);
      push();
      if (runCtx('graphUndoStack.length') !== 3) throw new Error('换节点的编辑被误合并');
      // 隔了 1.2 秒以上：不合并
      mem = _state([_note('n1', { content: 'C' }), _note('n2', { content: 'Y' })]);
      runCtx('graphHistoryLastEffect = { op: "update_node", touch: "' + 'n2' + '", at: 0 };');
      push();
      if (runCtx('graphUndoStack.length') !== 4) throw new Error('超时的连续编辑被误合并');
      return true;
    });

    check('②起名收藏：钉住的步骤不被 30 步上限挤掉，名字随条目走', () => {
      reset();
      for (let i = 0; i < 30; i++) {
        mem = _state(Array.from({ length: i + 1 }, (_, k) => _note('n' + k)));
        push();
      }
      if (runCtx('graphUndoStack.length') !== 30) throw new Error('前置：没到 30 条：' + runCtx('graphUndoStack.length'));
      sandbox.window.prompt = () => ' 起点 ';
      runCtx('toggleGraphHistoryPin(0);');
      const pinned = JSON.parse(runCtx('JSON.stringify(graphUndoStack[0].meta)'));
      if (!pinned.pinned || pinned.name !== '起点') throw new Error('收藏没记上：' + JSON.stringify(pinned));
      // 再推一条：超上限时先挤掉最老的「没钉住」的那条（下标 1），收藏的那条留下
      mem = _state(Array.from({ length: 31 }, (_, k) => _note('n' + k)));
      push();
      if (runCtx('graphUndoStack.length') !== 30) throw new Error('上限没顶住：' + runCtx('graphUndoStack.length'));
      if (!runCtx('graphUndoStack[0].meta.pinned')) throw new Error('收藏的那一步被挤掉了');
      if (runCtx('graphHistoryDropped') !== 1) throw new Error('滚出计数不对：' + runCtx('graphHistoryDropped'));
      const raw = JSON.parse(storageData[HIST_KEY]);
      if (!raw.d || !raw.e[0].meta.pinned || raw.e[0].meta.name !== '起点') throw new Error('收藏与滚出计数没落盘');
      runCtx('toggleGraphHistoryPin(0);');
      if (runCtx('graphUndoStack[0].meta.pinned')) throw new Error('再点一次没取消收藏');
      return true;
    });

    check('③容量提示：面板写清已记条数 / 体积 / 更早的滚出', () => {
      reset();
      for (let i = 0; i < 3; i++) {
        mem = _state(Array.from({ length: i + 1 }, (_, k) => _note('n' + k)));
        push();
      }
      runCtx('_persistGraphHistory();');
      runCtx('graphHistoryDropped = 7;');
      panelEls();
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel();');
      const cap = els.graphHistoryCap.textContent;
      if (!/已记 3\/30 步/.test(cap)) throw new Error('容量提示缺条数：' + cap);
      if (!/KB/.test(cap)) throw new Error('容量提示缺体积：' + cap);
      if (!/更早的 7 步已滚出/.test(cap)) throw new Error('容量提示缺滚出条数：' + cap);
      runCtx('closeGraphHistoryPanel();');
      return true;
    });

    check('④单节点恢复：只把这一颗换回那一步，别的节点/位置不动', () => {
      reset();
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: '
        + JSON.stringify(_state([_note('n1', { content: '旧文' }), _note('n2', { content: '原样' })], { positions: { n1: { x: 100, y: 100 }, n2: { x: 300, y: 300 } } }))
        + ', messages: null, meta: { source: "user", summary: "上一步", ts: 1, pushedAt: 1 } }];'
        + 'graphHistoryCursor = 1; graphHistoryLive = null; graphHistoryLiveDirty = true; graphHistoryLiveMetaCache = null;');
      mem = _state([_note('n1', { content: '新文' }), _note('n2', { content: '原样' })], { positions: { n1: { x: 700, y: 700 }, n2: { x: 900, y: 900 } } });
      panelEls();
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel(); _previewGraphVersion(0);');
      const model = JSON.parse(runCtx('JSON.stringify({ items: graphHistoryDiffModel.items, will: graphHistoryDiffModel.items.map(i => i.will) })'));
      const at = model.items.findIndex(it => it.nodeId === 'n1');
      if (at < 0 || model.items[at].will !== 'change' || !model.items[at].canRecover) throw new Error('改写项没标可恢复');
      runCtx('recoverGraphHistoryNode(' + at + ');');
      const n1 = (mem.customNodes || []).find(n => n.id === 'n1');
      const n2 = (mem.customNodes || []).find(n => n.id === 'n2');
      if (!n1 || n1.content !== '旧文') throw new Error('这一颗没恢复成那一步的版本：' + JSON.stringify(n1));
      if (!n2 || n2.content !== '原样') throw new Error('恢复一颗动了别的节点');
      if (!mem.positions || mem.positions.n1.x !== 700) throw new Error('单节点恢复搬了位置');
      if (runCtx('graphUndoStack.length') !== 2) throw new Error('单节点恢复没进撤销历史');
      runCtx('exitGraphVersionPreview(); closeGraphHistoryPanel();');
      return true;
    });

    check('④单节点恢复：那一步有、现在没有的节点能接回来，连线一并接', () => {
      reset();
      const target = _state([_note('n1'), _note('back', { content: '回来的' })], {
        connections: [{ from: 'n1', fromPort: 'out-0', to: 'back', toPort: 'in-0', type: 'custom' }],
      });
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(target)
        + ', messages: null, meta: { source: "user", summary: "两步前", ts: 1, pushedAt: 1 } }];'
        + 'graphHistoryCursor = 1; graphHistoryLive = null; graphHistoryLiveDirty = true; graphHistoryLiveMetaCache = null;');
      mem = _state([_note('n1')]);
      panelEls();
      runCtx('openGraphHistoryPanel(); graphHistoryLastSignature = ""; _refreshGraphHistoryPanel(); _previewGraphVersion(0);');
      const items = JSON.parse(runCtx('JSON.stringify(graphHistoryDiffModel.items)'));
      const at = items.findIndex(it => it.nodeId === 'back');
      if (at < 0 || items[at].will !== 'return' || !items[at].canRecover) throw new Error('会回来的节点没标可恢复');
      runCtx('recoverGraphHistoryNode(' + at + ');');
      if (!(mem.customNodes || []).some(n => n.id === 'back')) throw new Error('节点没接回来');
      if (!(mem.connections || []).length) throw new Error('连线没一起接回来');
      runCtx('exitGraphVersionPreview(); closeGraphHistoryPanel();');
      return true;
    });

    check('⑥另开探索线：那一步没有消息快照时，按投影从当前对话还原到那一刻', () => {
      reset();
      chat = [
        { role: 'user', content: '第一问', timestamp: 11 },
        { role: 'assistant', content: '第一答', timestamp: 12 },
        { role: 'user', content: '第二问', timestamp: 13 },
      ];
      const state = _state([_note('n1')]);
      const proj = runCtx('JSON.stringify(_graphProjectionOf(' + JSON.stringify(state) + ', '
        + JSON.stringify(chat.slice(0, 2)) + '))');
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(state)
        + ', _proj: ' + proj + ', meta: { source: "user", summary: "那一步", ts: 5, pushedAt: 5 } }];'
        + 'graphHistoryCursor = 1; graphHistoryLive = null; graphHistoryLiveDirty = true;');
      const kept = JSON.parse(runCtx('JSON.stringify(_graphMessagesForVersion(_graphVersions()[0], ' + JSON.stringify(chat) + '))'));
      if (kept.length !== 2 || kept[0].timestamp !== 11 || kept[1].timestamp !== 12) {
        throw new Error('没按那一版投影还原对话：' + JSON.stringify(kept.map(m => m.timestamp)));
      }
      // 旧条目没有投影（降级）：只复制图状态，对话留空
      runCtx('graphUndoStack[0]._proj = null; graphUndoStack[0].messages = null;'
        + ' graphUndoStack[0].meta.proj = { n: {}, e: [], g: "[]", p: "[]", degraded: true };');
      const empty = JSON.parse(runCtx('JSON.stringify(_graphMessagesForVersion(_graphVersions()[0], ' + JSON.stringify(chat) + '))'));
      if (empty.length) throw new Error('降级旧条目不该硬塞对话：' + empty.length);
      return true;
    });

    // ===== 异步例：串行队列逐个 await =====
    const serial = [];
    serial.push(['⑤恢复排版开关（默认/打开两条路）', async () => {
      reset();
      const s0 = _state([_note('n1', { content: '旧' })], { positions: { n1: { x: 100, y: 100 } } });
      const s1 = _state([_note('n1', { content: '中' })], { positions: { n1: { x: 300, y: 300 } } });
      runCtx('graphUndoStack = ['
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(s0) + ', messages: null, meta: { source: "user", summary: "一步前", ts: 1, pushedAt: 1 } },'
        + '{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(s1) + ', messages: null, meta: { source: "user", summary: "上一步", ts: 2, pushedAt: 2 } }'
        + ']; graphHistoryCursor = 2; graphHistoryLive = null; graphHistoryLiveDirty = true; graphHistoryLastEffect = { op: "", touch: "", at: 0 };');
      mem = _state([_note('n1', { content: '新' })], { positions: { n1: { x: 500, y: 500 } } });
      // 默认：整张恢复（排版也回历史）
      await runCtx('_jumpGraphVersion(1)');
      if (mem.positions.n1.x !== 300) throw new Error('默认恢复没还原历史排版：' + mem.positions.n1.x);
      // 打开开关：内容回去、坐标留现状
      runCtx('toggleGraphHistoryKeepLayout();');
      if (!runCtx('graphHistoryKeepLayout')) throw new Error('开关没打开');
      await runCtx('_jumpGraphVersion(0)');
      if (mem.customNodes[0].content !== '旧') throw new Error('内容没恢复：' + mem.customNodes[0].content);
      if (mem.positions.n1.x !== 300) throw new Error('保留排版没生效：' + mem.positions.n1.x);
      if (storageData['phymathia_graph_history_keep_layout'] !== '1') throw new Error('开关偏好没落盘');
      runCtx('toggleGraphHistoryKeepLayout();');
      if (runCtx('graphHistoryKeepLayout')) throw new Error('开关关不掉');
      return true;
    }]);

    serial.push(['⑥另开探索线：传那一步的图与消息，历史从「分叉自…」开始', async () => {
      reset();
      chat = [{ role: 'user', content: '问题', timestamp: 11 }, { role: 'assistant', content: '回答', timestamp: 12 }];
      const s0 = _state([_note('n1')], { positions: { n1: { x: 10, y: 10 } } });
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(s0)
        + ', messages: ' + JSON.stringify(chat) + ', meta: { source: "user", summary: "那一步", ts: 5, pushedAt: 5 } }];'
        + 'graphHistoryCursor = 1; graphHistoryLive = null; graphHistoryLiveDirty = true;');
      let captured = null;
      sandbox.window.forkSessionFromSnapshot = async opts => {
        captured = JSON.parse(JSON.stringify(opts));
        return { id: 'sess_new', title: '原画布 · 分支 2', sessionId: 'pnew' };
      };
      sandbox.window.getSessionById = () => ({ title: '原画布' });
      // 面板里点「另开」→ 版本 0（图与消息都取那一步的快照）
      runCtx('graphUndoStack = [{ sessionId: ' + JSON.stringify(SID) + ', state: ' + JSON.stringify(s0)
        + ', messages: ' + JSON.stringify(chat) + ', meta: { source: "user", summary: "那一步", ts: 5, pushedAt: 5 } }]; graphHistoryCursor = 1;');
      const ok = await runCtx('forkGraphHistoryVersion(0)');
      if (!ok) throw new Error('另开探索线返回失败');
      if (!captured) throw new Error('没把那一版交给分叉函数');
      if (String(captured.state.customNodes[0].id) !== 'n1') throw new Error('图状态没取那一步的');
      if ((captured.messages || []).length !== 2) throw new Error('消息没取那一步的');
      if (captured.step !== 1) throw new Error('步骤号不对：' + captured.step);
      // 种子：新画布历史首行是「分叉自「原画布」第 1 步」
      runCtx('seedForkedGraphHistory("sess_new", { sourceTitle: "原画布", step: 1, state: ' + JSON.stringify(s0) + ', messages: ' + JSON.stringify(chat) + ' });');
      const env = JSON.parse(storageData['phymathia_graph_history_sess_new']);
      if (!env || env.e.length !== 1 || env.c !== 1) throw new Error('种子信封不对：' + JSON.stringify(env && { c: env.c, n: env.e && env.e.length }));
      if (env.e[0].meta.source !== 'fork' || env.e[0].meta.summary !== '分叉自「原画布」第 1 步') {
        throw new Error('种子摘要不对：' + JSON.stringify(env.e[0].meta));
      }
      if (!env.e[0].meta.proj) throw new Error('种子条目没带投影');
      // 还原被替换的真函数（下一个例要真跑 session.js 的分叉通道）
      sandbox.window.forkSessionFromSnapshot = prevFork;
      sandbox.window.getSessionById = prevGetSession;
      return true;
    }]);

    serial.push(['⑥分叉真跑：新画布落名单/消息/图状态/历史种子，原画布一字不动', async () => {
      // 这一条走真实的 session.js 通道：syncFromServer 装载名单 → forkSessionFromSnapshot
      // → switchToSession。fetch 全部就地应答（不碰网络），断言落盘结果。
      const prevSessions = storageData[SESSIONS_KEY];
      const prevCurrent = storageData[CURRENT_KEY];
      const prevMsgs = storageData['phymathia_msgs_s1'];
      const prevGraph = storageData['phymathia_graph_s1'];
      const prevRealSid = sandbox.window.getCurrentSessionId;
      const prevFetchImpl = sandbox.fetch;
      const srcMsgs = [{ role: 'user', content: '原问题', timestamp: 101 }, { role: 'assistant', content: '原回答', timestamp: 102 }];
      const srcGraph = _state([_note('n1')], { positions: { n1: { x: 42, y: 43 } } });
      storageData[SESSIONS_KEY] = JSON.stringify({ s1: { id: 's1', title: '原画布', sessionId: 'p1', createdAt: 1, updatedAt: 2 } });
      storageData[CURRENT_KEY] = 's1';
      storageData['phymathia_msgs_s1'] = JSON.stringify(srcMsgs);
      storageData['phymathia_graph_s1'] = JSON.stringify(srcGraph);
      sandbox.window.getCurrentSessionId = prevRealSid;
      sandbox.fetch = async (url, opts) => {
        const u = String(url || '');
        const method = (opts && opts.method) || 'GET';
        let body = {};
        if (u.indexOf('/api/sessions/messages-batch') === 0) body = { messages: {} };
        else if (u.indexOf('/api/sessions/deleted-ids') === 0) body = { deleted: {} };
        else if (u.indexOf('/api/knowledge') === 0) body = {};
        else if (u.indexOf('/api/kv/') === 0) body = { value: null };
        else if (u.indexOf('/api/sessions') === 0 && method === 'GET') body = {};
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      };
      await sandbox.window.syncFromServer();
      const res = await sandbox.window.forkSessionFromSnapshot({
        sourceId: 's1', step: 3, state: srcGraph, messages: srcMsgs,
      });
      if (!res || !res.id || res.id === 's1') throw new Error('分叉没返回新画布：' + JSON.stringify(res));
      if (res.title !== '原画布 · 分支 2') throw new Error('标题没带来源/分支号：' + res.title);
      const sess = JSON.parse(storageData[SESSIONS_KEY] || '{}');
      if (!sess[res.id] || sess[res.id].forkOf !== 's1') throw new Error('新画布没进名单或没记来源：' + JSON.stringify({ id: res.id, keys: Object.keys(sess), got: sess[res.id] }));
      const msgs = JSON.parse(storageData['phymathia_msgs_' + res.id] || '[]');
      if (msgs.length !== 2 || msgs[0].content !== '原问题') throw new Error('消息没复制过去');
      const g = JSON.parse(storageData['phymathia_graph_' + res.id] || 'null');
      if (!g || !g.customNodes || g.customNodes[0].id !== 'n1') throw new Error('图状态没复制过去');
      const env = JSON.parse(storageData['phymathia_graph_history_' + res.id] || 'null');
      if (!env || !env.e || !env.e.length || env.e[0].meta.summary !== '分叉自「原画布」第 3 步') {
        throw new Error('历史种子没写：' + JSON.stringify(env && env.e && env.e[0] && env.e[0].meta));
      }
      // 原画布：消息/图/名字一字未动
      if (storageData['phymathia_msgs_s1'] !== JSON.stringify(srcMsgs)) throw new Error('原画布消息被改了');
      if (sess.s1.title !== '原画布') throw new Error('原画布标题被改了');
      if (storageData[CURRENT_KEY] !== res.id) throw new Error('没切到新画布');
      sandbox.window.getCurrentSessionId = prevRealSid;
      sandbox.fetch = prevFetchImpl;
      if (prevSessions === undefined) delete storageData[SESSIONS_KEY]; else storageData[SESSIONS_KEY] = prevSessions;
      if (prevCurrent === undefined) delete storageData[CURRENT_KEY]; else storageData[CURRENT_KEY] = prevCurrent;
      if (prevMsgs === undefined) delete storageData['phymathia_msgs_s1']; else storageData['phymathia_msgs_s1'] = prevMsgs;
      if (prevGraph === undefined) delete storageData['phymathia_graph_s1']; else storageData['phymathia_graph_s1'] = prevGraph;
      return true;
    }]);

    serial.push(['⑥分叉通道：session.js 只用现成接口，不新增路由', async () => {
      const src = fs.readFileSync('src/static/js/session.js', 'utf8');
      const at = src.indexOf('async function forkSessionFromSnapshot');
      if (at < 0) throw new Error('session.js 没有 forkSessionFromSnapshot');
      const body = src.slice(at, src.indexOf('window.forkSessionFromSnapshot = forkSessionFromSnapshot;'));
      ['saveSessionMessages(id', 'saveGraphState(id', 'window.seedForkedGraphHistory', 'await switchToSession(id)']
        .forEach(needle => { if (body.indexOf(needle) < 0) throw new Error('分叉链缺一环：' + needle); });
      if (/fetch\(/.test(body)) throw new Error('分叉不该自己发请求（走既有保存通道）');
      if (body.indexOf('forkOf') < 0) throw new Error('没记来源画布');
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
    sandbox.window.getCurrentSessionId = prevSid;
    sandbox.window.getGraphState = prevGet;
    sandbox.window.saveGraphState = prevSave;
    sandbox.window.getChatHistory = prevChat;
    sandbox.window.replaceChatHistory = prevReplace;
    if (prevToast === undefined) delete sandbox.showToast; else sandbox.showToast = prevToast;
    delete sandbox.toastMsg;
    sandbox.document = prevDoc;
    sandbox.escapeHtml = prevEsc;
    sandbox.fetch = prevFetch;
    sandbox.window.forkSessionFromSnapshot = prevFork;
    sandbox.window.getSessionById = prevGetSession;
    sandbox.window.prompt = prevPrompt;
    sandbox.window.PHYMATHIA_READONLY = prevReadonly;
    if (prevHist === undefined) delete storageData[HIST_KEY]; else storageData[HIST_KEY] = prevHist;
  }
}
