// 修改历史 · A 方案双上限硬顶（2026-11-18，backlog 502 治根）：
//   ①体积上限硬顶化：旧口径 keep 保底 5 条，单条快照 ≥300KB 时 5 条就破 1.5MB 预算
//     （实测单键 2.9MB ≈ 5×580KB）——改保底 1 条，截断条数并入滚出计数；
//   ②步数上限硬顶化：服务端镜像 keep 60＋「更长才采纳」会把内存栈棘轮抬到 60 步
//     绕开 push 侧 30 步上限——采纳路径（_adoptGraphHistoryPayload）统一钳回 30，
//     游标重定基、被钳条数并入滚出计数；
//   ③钳制不误伤：≤30 步与旧裸数组小信封原样通过。
// 全部纯同步（参照 graph-history-batch4 形态）：入口 await 本域后才继续，无跨域让出。
import { check, vm, sandbox, storageData } from './_runner.mjs';

const SID = 'sess_history_caps';
const HIST_KEY = 'phymathia_graph_history_' + SID;

function _row(i, contentLen) {
  return {
    sessionId: SID,
    state: { customNodes: [{ id: 'n' + i, content: new Array((contentLen || 0) + 1).join('x') }], connections: [], groups: [], hidden: {} },
    meta: { idx: i, summary: '第 ' + i + ' 步', ts: 1000 + i, pushedAt: 1000 + i },
  };
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
  const prevSid = sandbox.window.getCurrentSessionId;
  const prevFetch = sandbox.fetch;
  const prevHist = storageData[HIST_KEY];
  delete storageData[HIST_KEY];
  sandbox.window.getCurrentSessionId = () => SID;
  // 镜像调度桩：_persistGraphHistory 会排 800ms 后的 fetch，收口前在桩上冲掉
  sandbox.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ value: null }) });
  const runCtx = code => vm.runInContext(code, sandbox);
  const resetStack = rows => {
    runCtx('graphHistorySession = ' + JSON.stringify(SID) + '; graphHistoryCursor = 0;'
      + ' graphHistoryLive = null; graphHistoryDropped = 0; graphHistorySavedAt = 0;'
      + ' graphHistoryPendingTruncate = false; graphHistoryLiveDirty = true;');
    runCtx('graphUndoStack = ' + JSON.stringify(rows) + ';');
  };
  try {
    check('①A 体积硬顶：5 条肥快照（旧口径保底 5 条＝单键 2.9MB 事故现场）截到预算内', () => {
      resetStack([0, 1, 2, 3, 4].map(i => _row(i, 400000))); // 每条 ≈400KB，全量 ≈2MB > 1.5MB 预算
      runCtx('graphHistoryCursor = 5;');
      runCtx('_persistGraphHistory();');
      const raw = JSON.parse(storageData[HIST_KEY]);
      if (raw.e.length !== 3) throw new Error('保底 1 条后应保留 floor(1.5M/400K)=3 条，实际 ' + raw.e.length);
      if (storageData[HIST_KEY].length > 1500000) throw new Error('体积硬顶没顶住：' + storageData[HIST_KEY].length);
      if (raw.c !== 3) throw new Error('游标没随截断重定基：' + raw.c);
      if (raw.d !== 2) throw new Error('截断条数没并入滚出计数：' + JSON.stringify(raw.d));
      if (runCtx('graphHistoryDropped') !== 2) throw new Error('内存滚出计数没同步：' + runCtx('graphHistoryDropped'));
      if (raw.e[0].meta.idx !== 2) throw new Error('砍的不是最老：栈首应为 idx=2，实际 ' + raw.e[0].meta.idx);
      return true;
    });

    check('②A 体积硬顶：单条 ≈1.1MB 的极端肥图保底 1 条不再凑满 5 条', () => {
      resetStack([0, 1].map(i => _row(i, 1100000))); // 全量 ≈2.2MB，per≈1.1MB → keep=1
      runCtx('_persistGraphHistory();');
      const raw = JSON.parse(storageData[HIST_KEY]);
      if (raw.e.length !== 1) throw new Error('应保底 1 条，实际 ' + raw.e.length);
      if (raw.e[0].meta.idx !== 1) throw new Error('保留的不是最新一条：' + raw.e[0].meta.idx);
      if (raw.d !== 1) throw new Error('滚出计数不对：' + JSON.stringify(raw.d));
      return true;
    });

    check('③A 步数硬顶：60 步服务端存档（镜像 keep 60 的棘轮现场）采纳时钳回 30', () => {
      resetStack([]);
      const rows = Array.from({ length: 60 }, (_, i) => _row(i, 0));
      const env = JSON.stringify({ v: 2, e: rows, c: 60, l: null, t: Date.now(), d: 0 });
      runCtx('_adoptGraphHistoryPayload(JSON.parse(' + JSON.stringify(env) + '));');
      if (runCtx('graphUndoStack.length') !== 30) throw new Error('钳制没顶住：' + runCtx('graphUndoStack.length'));
      if (runCtx('graphHistoryCursor') !== 30) throw new Error('live 位游标应停在栈尾：' + runCtx('graphHistoryCursor'));
      if (runCtx('graphHistoryLive') !== null) throw new Error('live 位锚点应清空');
      if (runCtx('graphHistoryDropped') !== 30) throw new Error('被钳条数没并入滚出计数：' + runCtx('graphHistoryDropped'));
      const firstIdx = runCtx('graphUndoStack[0].meta.idx');
      if (firstIdx !== 30) throw new Error('砍的不是最老 30 条：栈首应为 idx=30，实际 ' + firstIdx);
      return true;
    });

    check('④A 步数硬顶：游标在中间（c=45）重定基到 15，不误跳 live 位', () => {
      resetStack([]);
      const rows = Array.from({ length: 60 }, (_, i) => _row(i, 0));
      const env = JSON.stringify({ v: 2, e: rows, c: 45, l: _row(59, 0).state, t: Date.now(), d: 0 });
      runCtx('_adoptGraphHistoryPayload(JSON.parse(' + JSON.stringify(env) + '));');
      if (runCtx('graphUndoStack.length') !== 30) throw new Error('钳制没顶住');
      if (runCtx('graphHistoryCursor') !== 15) throw new Error('游标应重定基 45-30=15，实际 ' + runCtx('graphHistoryCursor'));
      return true;
    });

    check('⑤A 钳制不误伤：≤30 步信封与滚出计数 d 原样通过', () => {
      resetStack([]);
      const rows = Array.from({ length: 20 }, (_, i) => _row(i, 0));
      const env = JSON.stringify({ v: 2, e: rows, c: 12, l: null, t: Date.now(), d: 7 });
      runCtx('_adoptGraphHistoryPayload(JSON.parse(' + JSON.stringify(env) + '));');
      if (runCtx('graphUndoStack.length') !== 20) throw new Error('不该钳：' + runCtx('graphUndoStack.length'));
      if (runCtx('graphHistoryCursor') !== 12) throw new Error('游标不该动：' + runCtx('graphHistoryCursor'));
      if (runCtx('graphHistoryDropped') !== 7) throw new Error('滚出计数被改：' + runCtx('graphHistoryDropped'));
      return true;
    });

    check('⑥A 兼容旧裸数组：35 条无信封格式照常采纳并钳到 30', () => {
      resetStack([]);
      const rows = Array.from({ length: 35 }, (_, i) => _row(i, 0));
      runCtx('_adoptGraphHistoryPayload(JSON.parse(' + JSON.stringify(JSON.stringify(rows)) + '));');
      if (runCtx('graphUndoStack.length') !== 30) throw new Error('旧格式没走钳制：' + runCtx('graphUndoStack.length'));
      if (runCtx('graphHistoryDropped') !== 5) throw new Error('滚出计数不对：' + runCtx('graphHistoryDropped'));
      if (runCtx('graphHistoryCursor') !== 30) throw new Error('旧格式游标应在栈尾：' + runCtx('graphHistoryCursor'));
      return true;
    });
  } finally {
    // 收口：在桩上冲掉在途镜像（真实 fetch 拿相对 URL 在 Node 下必炸），再还原桩位
    runCtx('graphUndoStack = []; graphHistorySession = ""; graphHistoryCursor = 0; graphHistoryLive = null;');
    runCtx('_flushGraphHistoryMirror();');
    sandbox.fetch = prevFetch;
    sandbox.window.getCurrentSessionId = prevSid;
    if (prevHist === undefined) delete storageData[HIST_KEY]; else storageData[HIST_KEY] = prevHist;
  }
}
