// 串行边界：backlog 567 余项——Φ 改图请求在途时切画布（2026-11-24）。
// 背景：567 的主体（切画布后 harnessBusy 永久为 true）11-20 已修（4c604cc），但同一族
// 早退还留了两件事没收：①忙位归零后没人放行队列，Φ 生成期间在别的画布上排的消息
// 要等下一个任务跑完才被动开跑（「等待中」不会自己开始）；②状态行停在「审阅中…」
// 且仍是 running 样式，指令被收走却没换来回答。11-20 那次也没带回归用例。
// 本域真跑 runGraphHarness：闸门卡住请求 → 切画布 → 排一条队 → 放闸，断言作废收尾
// （settleAbandonedRun）把三件事都做完。三个场景串行跑完，各自 try/finally 还原：
//   S1 请求已发出后被切走（finally 早退，567 主场景）
//   S2 请求还没发出就被切走（拉大陆共享点那一瞬的早退；焦点解析后那处与之同一函数）
//   S3 不切画布的对照（正常路径行为不变：回答入历史、指令不回填）
// 期间独占 fetch / document.getElementById 与一批 window 桩；域尾 await drain() 收口。
import { check, drain, sandbox, storageData, restoreWindowStub, vm } from './_runner.mjs';

const A = 'sess_phi_switch_a';
const B = 'sess_phi_switch_b';
const PHI = 'phi_switch_fix';
// 指令里带上 A 画布那颗节点的名字：焦点唯一命中，跳过「正在理解目标」那次模型调用
const INSTRUCTION = '修改便签一的内容';
const MODEL = { provider: 'test', model: 'isolated', baseUrl: 'http://unused' };
const SESSIONS = {
  [A]: { id: A, title: '画布 A', sessionId: 'p_' + A, createdAt: 1, updatedAt: 1 },
  [B]: { id: B, title: '画布 B', sessionId: 'p_' + B, createdAt: 2, updatedAt: 2 },
};
const PHI_SESSIONS = { [PHI]: { id: PHI, title: 'Φ 会话', boundSid: A, createdAt: 0, updatedAt: 0 } };
const NODES = {
  [A]: [{ id: 'n1', kind: 'human_note', label: '便签一', content: 'A 的便签' }],
  [B]: [{ id: 'n2', kind: 'human_note', label: '便签二', content: 'B 的便签' }],
};
const REVIEW_RESULT = {
  status: 'ok', summary: 'A edit',
  operations: [{ op: 'update_node', id: 'n1', patch: { content: 'A-only edit' } }],
};
const STORAGE_KEYS = ['phymathia_sessions', 'phymathia_current_session', 'phymathia_phi_sessions',
  'phymathia_current_phi_session', 'phymathia_phi_migration_done', 'phymathia_harness_history_' + PHI];
const WINDOW_STUBS = ['getCurrentSessionId', 'getGraphState', 'getGraphViewNodes', 'getGraphViewEdges',
  'getSessionById', 'getActiveModelForRole'];
const GLOBAL_STUBS = ['_taskCreate', '_taskMarkRunning', '_taskFinish', '__phiSwitchProbe'];
// harness 家族的顶层 let/var 词法绑定（同 recipes.mjs 口径）：经 vm.runInContext 读写，
// 才能既改到真状态、又原样还原（JSON 往返只带纯数据）。
const HARNESS_BINDINGS = ['phiSessions', 'currentPhiId', 'harnessSessionEpoch', 'harnessHistoryLoad',
  'harnessHistory', 'harnessBusy', 'harnessResult', 'harnessSnapshot', 'harnessPendingClarify',
  'harnessSingleEvalId', 'harnessResultApplied', 'harnessLastAppliedOps', 'harnessLastAppliedBeforeSnapshot',
  'harnessLastAppliedReport', 'harnessLastInstruction', 'harnessLastPhase', 'harnessPhiError',
  'harnessPhiCelebrate', 'harnessModelOverride', 'harnessLastError', 'harnessRunStartTs',
  'harnessStatusTickId', 'harnessStatusBaseText', 'harnessPhase', 'harnessMode', '_harnessRunSeq',
  'sessions', 'currentSessionId'];

function _stateSnapshot() {
  const pairs = HARNESS_BINDINGS.map(k => JSON.stringify(k) + ':' + k).join(',');
  return JSON.parse(vm.runInContext('JSON.stringify({' + pairs + '})', sandbox));
}
function _stateRestore(state) {
  sandbox.__phiSwitchTmp = JSON.stringify(state);
  try {
    const code = HARNESS_BINDINGS.map(k => k + ' = JSON.parse(__phiSwitchTmp)[' + JSON.stringify(k) + '];').join('');
    vm.runInContext(code, sandbox);
  } finally {
    delete sandbox.__phiSwitchTmp;
  }
}
const _eval = (expr) => vm.runInContext(expr, sandbox);
const _ticks = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 一个场景：Φ 在画布 A 上改图 →（switchTo：切到另一张画布）→ 排一条队 → 放闸。
// gateUrl＝卡住的请求：/api/harness/graph/review（已发出）或 /api/continent（还没发出）。
async function _runScenario({ gateUrl, switchTo }) {
  const prevStorage = {};
  for (const k of STORAGE_KEYS) prevStorage[k] = storageData[k];
  const prevStubs = {};
  for (const k of WINDOW_STUBS) prevStubs[k] = sandbox.window[k];
  const prevGlobals = {};
  for (const k of GLOBAL_STUBS) prevGlobals[k] = sandbox[k];
  const prevReadonly = sandbox.window.PHYMATHIA_READONLY;
  const prevFetch = sandbox.fetch;
  const savedGEBI = sandbox.document.getElementById;
  const prevState = _stateSnapshot();
  if (_eval('_sendQueue.length') !== 0) throw new Error('前置不成立：进场景前发送队列应为空');
  let releaseGate = () => {};
  let markGateHit = () => {};
  try {
    storageData['phymathia_sessions'] = JSON.stringify(SESSIONS);
    storageData['phymathia_current_session'] = A;
    storageData['phymathia_phi_sessions'] = JSON.stringify(PHI_SESSIONS);
    storageData['phymathia_current_phi_session'] = PHI;
    storageData['phymathia_phi_migration_done'] = '1';
    _eval('sessions = ' + JSON.stringify(SESSIONS) + '; currentSessionId = ' + JSON.stringify(A) + ';'
      + ' phiSessions = ' + JSON.stringify(PHI_SESSIONS) + '; currentPhiId = ' + JSON.stringify(PHI) + ';'
      + ' harnessSessionEpoch++; harnessHistoryLoad++; harnessHistory = []; harnessBusy = false;'
      + ' harnessResult = null; harnessSnapshot = null; harnessPendingClarify = null; harnessSingleEvalId = null;'
      + ' harnessResultApplied = false; harnessLastAppliedOps = []; harnessLastAppliedBeforeSnapshot = null;'
      + ' harnessLastAppliedReport = null; harnessLastInstruction = ""; harnessModelOverride = null;'
      + ' harnessLastError = null; harnessPhiError = false; harnessPhiCelebrate = false; harnessMode = "edit";'
      + ' harnessAbortController = null; _sendQueueFlushing = false;');

    // 「切画布」＝当前画布指针换成 B（stillCurrent 第三段读的就是它）。不真跑
    // switchToSession：那条链的图状态加载另有 T356 用例盯着，这里只要 Φ 侧看到画布换了。
    const curSid = () => storageData['phymathia_current_session'] || '';
    sandbox.window.PHYMATHIA_READONLY = false;
    sandbox.window.getCurrentSessionId = () => curSid();
    const graphState = (sid) => ({
      collapsed: {}, hidden: {}, positions: {}, pinned: {}, sizes: {},
      pan: { x: 80, y: 80 }, zoom: 0.9, layoutVersion: 1, connections: null, removedEdges: [],
      portCounts: {}, inputPortCounts: {}, groups: [], customNodes: NODES[sid] || [],
      harnessDeleted: {}, harnessCheckpoint: null,
    });
    sandbox.window.getGraphState = (sid) => graphState(sid);
    sandbox.window.getGraphViewNodes = () => NODES[curSid()] || [];
    sandbox.window.getGraphViewEdges = () => [];
    sandbox.window.getSessionById = (id) => SESSIONS[id] || null;
    sandbox.window.getActiveModelForRole = () => MODEL;
    // 任务面板记账不在被测范围：桩掉，队列项 taskId 为空，面板账本不被探针污染
    sandbox._taskCreate = () => null;
    sandbox._taskMarkRunning = () => {};
    sandbox._taskFinish = () => {};
    let probeRuns = 0;
    sandbox.__phiSwitchProbe = () => { probeRuns++; };

    const statusEl = {
      textContent: '', className: 'graph-harness-status',
      classList: { contains(c) { return statusEl.className.split(/\s+/).indexOf(c) >= 0; } },
    };
    const inputEl = { value: INSTRUCTION };
    sandbox.document.getElementById = (id) => {
      if (id === 'graphHarnessStatus') return statusEl;
      if (id === 'graphHarnessInstruction') return inputEl;
      // 对话区容器给 null：_renderHarnessChat 首行即 return（渲染边界不进被测链路——
      // 沙箱没装 marked/KaTeX，真渲染会在 renderMarkdown 上抛，且那条重渲是发完不管的
      // promise，一抛整个冒烟进程就退）。同 recipes.mjs 的 _domStub 口径。
      if (id === 'graphHarnessChat') return null;
      return savedGEBI(id);
    };

    const gateHit = new Promise((resolve) => { markGateHit = resolve; });
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const counts = { review: 0, continent: 0 };
    const okJson = (body) => ({
      ok: true, status: 200, headers: { get: () => 'application/json' },
      json: async () => body, text: async () => JSON.stringify(body),
    });
    sandbox.fetch = async (url) => {
      const u = String(url || '');
      if (u === '/api/harness/graph/review') counts.review++;
      if (u === '/api/continent') counts.continent++;
      if (u === gateUrl) {
        markGateHit();
        await gate;
        return okJson(u === '/api/continent' ? {} : REVIEW_RESULT);
      }
      return okJson({ value: null });
    };

    const running = sandbox.runGraphHarness();
    await Promise.race([
      gateHit,
      _ticks(1500).then(() => { throw new Error('Φ 请求没有发出，前置链路已断（状态行：' + statusEl.textContent + '）'); }),
    ]);
    await _ticks(5); // 让请求稳稳停在闸门上
    const busyInFlight = _eval('harnessBusy');

    if (switchTo) {
      storageData['phymathia_current_session'] = switchTo;
      _eval('currentSessionId = ' + JSON.stringify(switchTo) + ';');
    }
    // 用户此刻在 switchTo（没切则仍在 A）发了一条消息：Φ 还在忙，这条只能排队
    const queuedFor = switchTo || A;
    _eval("_enqueueSend('探针', function () { __phiSwitchProbe(); }, { title: '探针', sessionId: "
      + JSON.stringify(queuedFor) + ' })');
    const queuedLen = _eval('_sendQueue.length');
    const stillQueuedBeforeGate = probeRuns;

    releaseGate();
    await running;
    await _ticks(30); // 放行发生在本轮收尾返回后的微任务里

    const history = JSON.parse(_eval('JSON.stringify(harnessHistory.map(function (e) {'
      + ' return { role: e.role, summary: e.summary || "" }; }))'));
    return {
      busyInFlight, queuedLen, stillQueuedBeforeGate, probeRuns, counts, history,
      statusText: String(statusEl.textContent || ''),
      statusRunning: statusEl.className.split(/\s+/).indexOf('graph-harness-status-running') >= 0,
      inputValue: String(inputEl.value || ''),
      busy: _eval('harnessBusy'),
      actuallyBusy: sandbox._isActuallyBusy(),
      queueLeft: _eval('_sendQueue.length'),
    };
  } finally {
    releaseGate();
    sandbox.fetch = prevFetch;
    sandbox.document.getElementById = savedGEBI;
    for (const k of WINDOW_STUBS) restoreWindowStub(k, prevStubs[k]);
    sandbox.window.PHYMATHIA_READONLY = prevReadonly;
    for (const k of GLOBAL_STUBS) {
      if (prevGlobals[k] === undefined) delete sandbox[k];
      else sandbox[k] = prevGlobals[k];
    }
    for (const k of STORAGE_KEYS) {
      if (prevStorage[k] === undefined) delete storageData[k];
      else storageData[k] = prevStorage[k];
    }
    _eval('_sendQueue.length = 0; _sendQueueFlushing = false; harnessAbortController = null;');
    _stateRestore(prevState);
  }
}

export async function run() {
check('567 余项：Φ 请求在途切画布——忙位归零＋排队消息自动放行＋状态行落终态＋指令还回（已发出/未发出两处早退）＋不切画布对照', async () => {
  const failures = [];
  const expect = (ok, message) => { if (!ok) failures.push(message); };
  const assistantSummaries = (r) => r.history.filter(e => e.role === 'assistant').map(e => e.summary);

  // S1：请求已发出，等回答期间切到 B 并在 B 排了一条——回答不落笔，但收尾三件事都要做
  let s1 = null;
  try {
    s1 = await _runScenario({ gateUrl: '/api/harness/graph/review', switchTo: B });
  } catch (e) {
    failures.push('S1 场景没跑完：' + (e && e.message));
  }
  if (s1) {
    const tag = 'S1（已发出后切走）：';
    expect(s1.busyInFlight === true, tag + '前置不成立——请求在途时应在忙');
    expect(s1.queuedLen === 1 && s1.stillQueuedBeforeGate === 0, tag + '前置不成立——忙时那条应进队且未跑');
    expect(s1.counts.review === 1, tag + '评审请求应恰好发出 1 次');
    expect(s1.busy === false, tag + '请求结束后忙位应归零（11-20 主修复）');
    expect(s1.actuallyBusy === false, tag + '队列闸 _isActuallyBusy 不应再读到忙位');
    expect(s1.probeRuns === 1, tag + '排队那条应自动开跑（实际跑 ' + s1.probeRuns + ' 次）');
    expect(s1.queueLeft === 0, tag + '队列应已清空（剩 ' + s1.queueLeft + ' 条）');
    expect(!s1.statusRunning, tag + '状态行不应仍是 running 样式（实际：' + s1.statusText + '）');
    expect(s1.statusText === '生成时已切走画布，本轮回答未显示', tag + '状态行应落终态说明（实际：' + s1.statusText + '）');
    expect(s1.inputValue === INSTRUCTION, tag + '指令应还回输入框（实际：' + JSON.stringify(s1.inputValue) + '）');
    expect(assistantSummaries(s1).length === 0, tag + '切走后的回答不得落进对话（跨画布落笔红线）');
    expect(s1.history.filter(e => e.role === 'user').length === 1, tag + '用户消息应恰好 1 条');
  }

  // S2：请求还没发出（卡在拉大陆共享点）就切走——同样放行＋落终态＋还指令，且评审请求不得发出
  let s2 = null;
  try {
    s2 = await _runScenario({ gateUrl: '/api/continent', switchTo: B });
  } catch (e) {
    failures.push('S2 场景没跑完：' + (e && e.message));
  }
  if (s2) {
    const tag = 'S2（未发出就切走）：';
    expect(s2.counts.continent === 1 && s2.counts.review === 0, tag + '评审请求不应发出（review ' + s2.counts.review + ' 次）');
    expect(s2.busyInFlight === true && s2.queuedLen === 1, tag + '前置不成立——在途应在忙、那条应进队');
    expect(s2.busy === false && s2.actuallyBusy === false, tag + '作废后忙位应归零');
    expect(s2.probeRuns === 1, tag + '排队那条应自动开跑（实际跑 ' + s2.probeRuns + ' 次）');
    expect(!s2.statusRunning && s2.statusText === '已切走画布，本轮未发出', tag + '状态行应落终态说明（实际：' + s2.statusText + '）');
    expect(s2.inputValue === INSTRUCTION, tag + '指令应还回输入框（实际：' + JSON.stringify(s2.inputValue) + '）');
    expect(s2.history.filter(e => e.role === 'assistant').length === 0, tag + '没发出的请求不该有回答入历史');
  }

  // S3 对照：不切画布——回答照常入历史、排队照常放行、指令不回填、状态行不出现作废说明
  let s3 = null;
  try {
    s3 = await _runScenario({ gateUrl: '/api/harness/graph/review', switchTo: '' });
  } catch (e) {
    failures.push('S3 场景没跑完：' + (e && e.message));
  }
  if (s3) {
    const tag = 'S3（不切画布对照）：';
    expect(s3.probeRuns === 1 && s3.queueLeft === 0, tag + '正常收尾应放行排队那条');
    expect(assistantSummaries(s3).join(',') === 'A edit', tag + '回答应照常进对话（实际：' + assistantSummaries(s3).join(',') + '）');
    expect(s3.busy === false && s3.actuallyBusy === false, tag + '收尾后忙位应归零');
    expect(s3.statusText.indexOf('切走画布') < 0, tag + '正常收尾不该出现作废说明（实际：' + s3.statusText + '）');
    expect(s3.inputValue === '', tag + '正常收尾不该把指令回填输入框（实际：' + JSON.stringify(s3.inputValue) + '）');
  }

  if (failures.length) throw new Error(failures.join('；'));
  return true;
});
await drain();
}
