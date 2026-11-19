// ===== 修改历史：信封持久化与服务端镜像（2026-10-24 自 graph.js 拆出，T397 纯搬家）=====
// 信封去重/水合/message 增量与 12h 兜底结算的落盘侧，服务端镜像瘦身（keep 60）与按会话作废。
// 投影差异与撤销链在 graph-history-diff.js；面板、对比模型与分叉在 graph-history-panel.js。
function _graphHistoryKey(sessionId) {
  return "phymathia_graph_history_" + (sessionId || "default");
}

function _currentSessionId() {
  return typeof window.getCurrentSessionId === "function" ? window.getCurrentSessionId() : "";
}

// 历史载荷装载（T365）：v2 信封 {v:2, e:条目, c:游标, l:最新锚点} 与旧裸数组两吃。
// 旧格式＝游标在末尾、无锚点；游标越界一律钳回合法区间，锚点只在时间旅行位才有意义。
function _adoptGraphHistoryPayload(parsed) {
  const isEnv = !!(parsed && !Array.isArray(parsed) && Array.isArray(parsed.e));
  if (!Array.isArray(parsed) && !isEnv) return false;
  const entries = _graphHistoryHydrate(isEnv ? parsed.e : parsed);
  // A 方案（2026-11-18）：步数上限改硬顶。push 侧的 30 步上限只管新编辑，而服务端
  // 镜像 keep 60（存档窗口宽于本地），「更长才采纳」会把内存栈棘轮抬到 60 步绕开
  // 上限。所有采纳路径（本地读回/服务端补回/备份导入）统一在此钳回 30 步窗口：
  // 砍最老、游标同步重定基、被钳掉的条数并入滚出计数。本地信封写侧已保证 ≤30，
  // 这里的钳对它幂等空转；超幅残余只剩体积上限单条保底的极端图（见 _persistGraphHistory）。
  let capCut = 0;
  if (entries.length > GRAPH_UNDO_LIMIT) {
    capCut = entries.length - GRAPH_UNDO_LIMIT;
    entries.splice(0, capCut);
  }
  graphUndoStack = entries;
  const cRaw = isEnv ? Number(parsed.c) : NaN;
  const c = Number.isFinite(cRaw) ? Math.max(0, cRaw - capCut) : NaN;
  graphHistoryCursor = (Number.isFinite(c) && c >= 0 && c <= entries.length) ? c : entries.length;
  if (graphHistoryCursor >= entries.length) {
    graphHistoryCursor = entries.length;
    graphHistoryLive = null;
  } else {
    const l = (isEnv && parsed.l) ? _graphHistoryHydrate([parsed.l]) : null;
    graphHistoryLive = (l && l[0]) || null;
  }
  graphHistorySavedAt = (isEnv && Number(parsed.t)) ? Number(parsed.t) : 0;
  // T389：容量提示的「更早的已滚出」计数随信封走（可选字段 d，旧数据按 0）。
  // 单槽可选字段 s 已随简化批次退役：读回静默忽略、不再写出（见文件头注释）。
  graphHistoryDropped = (isEnv && Number(parsed.d)) ? Math.max(0, Math.floor(Number(parsed.d))) : 0;
  if (capCut > 0) graphHistoryDropped += capCut; // 步数钳掉的条数并入「更早的 N 步已移出」
  graphHistoryLastEffect = { op: "", touch: "", at: 0 };
  graphHistoryLiveDirty = true;
  return true;
}

function _ensureGraphHistory() {
  const sid = _currentSessionId();
  if (graphHistorySession === sid && graphUndoStack.length) return;
  if (graphHistorySession !== sid) _flushGraphHistoryMirror();
  graphHistorySession = sid;
  graphUndoStack = [];
  graphHistoryCursor = 0;
  graphHistoryLive = null;
  graphHistorySavedAt = 0;
  graphHistoryPendingTruncate = false;
  graphHistoryLiveDirty = true;
  graphHistoryDropped = 0;
  graphHistoryLastEffect = { op: "", touch: "", at: 0 };
  try {
    const raw = localStorage.getItem(_graphHistoryKey(sid));
    if (raw) {
      _adoptGraphHistoryPayload(JSON.parse(raw));
    }
  } catch (e) { graphUndoStack = []; graphHistoryCursor = 0; graphHistoryLive = null; }
  _upgradeGraphHistoryFromServer(sid);
}

// ===== 撤销历史的相邻去重（T53）：快照里整份拷贝的 harnessCheckpoint（Φ 改图回滚点，
// 实测单条 ~9.5KB、相邻重复率 87.5%）常态在相邻快照间一字不差。内存栈（graphUndoStack）
// 永远保持完整快照、撤销行为零变化；只在持久化/镜像序列化时把「与最近一份实体相同」的
// checkpoint 置空并打 checkpointRef 标记，读回（本地 localStorage / 服务端镜像 / 备份导入）
// 统一经 _graphHistoryHydrate 向前借用最近一份实体补回。
// 本地超限截断（_persistGraphHistory 的 slice(-keep)）砍掉引用链实体源时，重建找不到就留空：
// 该条撤销恢复后 checkpoint 为空，Φ「撤销本次」不再可用——属本地截断的既有降级，服务端
// 全量镜像不受影响。旧数据（无标记）经 hydrate 原样通过；备份导出/导入（ui.js 原样搬运
// JSON 字符串）零适配。customNodes（占快照 77%、相邻整体相同率仅 31%）本轮不做去重，
// 节点级池化需换持久化格式，另行评估。
function _graphHistoryDedupe(arr) {
  const out = [];
  let prevCp = '';
  arr.forEach(function (x) {
    if (!x || !x.state || x.state.harnessCheckpoint == null) { out.push(x); return; }
    const cp = JSON.stringify(x.state.harnessCheckpoint);
    if (out.length && cp === prevCp) {
      const state = {};
      Object.keys(x.state).forEach(function (k) { state[k] = x.state[k]; });
      state.harnessCheckpoint = null;
      // T353：messages/msgDelta 跟行带走——checkpoint 去重不得顺手把消息增量链剪断
      const row = { sessionId: x.sessionId, state: state, meta: x.meta || null, checkpointRef: true };
      if (x.messages) row.messages = x.messages;
      if (x.msgDelta) row.msgDelta = x.msgDelta;
      out.push(row);
      return;
    }
    prevCp = cp; // 首条实体也在此记录指纹，后续相邻比较以它为基准
    out.push(x);
  });
  return out;
}

function _graphHistoryHydrate(arr) {
  // T365：统一入口两吃——v2 信封 {v:2,e,...} 就地解包（游标/锚点由 _adoptGraphHistoryPayload 消费）
  if (arr && !Array.isArray(arr) && Array.isArray(arr.e)) arr = arr.e;
  const out = (Array.isArray(arr) ? arr : []).filter(function (x) { return x && x.state; });
  let lastCp = null;
  let lastMsgs = null; // T353：消息增量链的重建基准＝前一个 message 型条目的消息
  out.forEach(function (x) {
    if (x.checkpointRef && x.state.harnessCheckpoint == null && lastCp != null) {
      x.state.harnessCheckpoint = JSON.parse(JSON.stringify(lastCp));
    } else if (x.state.harnessCheckpoint != null) {
      lastCp = x.state.harnessCheckpoint;
    }
    delete x.checkpointRef; // 读回即还原成无标记格式，内存态不携带序列化细节
    // T353：message 型条目的增量沿链重建。链头（首个全量条目）被本地截断/镜像
    // pruned 砍掉时重建不到，保持无 messages——该条撤销只退图状态，与 checkpointRef
    // 断链同一降级口径（T353 之前所有条目本来就是这个形态）。
    if (x.messages) {
      lastMsgs = x.messages;
    } else if (x.msgDelta) {
      const rebuilt = _applyMsgDelta(lastMsgs, x.msgDelta);
      if (rebuilt) { x.messages = rebuilt; lastMsgs = rebuilt; }
    }
    delete x.msgDelta;
  });
  return out;
}

// ===== T353：message 型快照的持久化增量 =====
// _pushGraphUndo(true) 的快照（viz 模块人工编辑、删消息节点）messages 此前只活在
// 内存栈——持久化/镜像一律丢弃（T53 体量口径：整份会话消息动辄数百 KB，30 步栈
// 全量复写会把 localStorage 与服务端镜像顶爆），刷新后这类条目只能退图状态、退不了
// 消息内容。改法：序列化时 message 型条目按「与前一个 message 型条目的差量」落盘
// （sets=改写内容、adds=新追加、dels=被删，全按消息 timestamp 作键；本应用的消息
// 数组只追加/原位改/删、不重排），栈内首个 message 型条目存全量作链头；读回统一经
// _graphHistoryHydrate 沿链重建。序列化时就地回验（重建结果逐字比对），对不上
// （未预见的形态）整条回退全量，宁大勿错。内存栈与撤销行为零变化，减重只发生在
// 持久化/镜像这一条路径上（与 T53 checkpoint 去重、T212 镜像 pruned 同一口径）。
// 每份序列化数组至多一个链头全量，链头被截断/pruned 的降级见 _graphHistoryHydrate。
function _msgDeltaFrom(base, target) {
  const delta = { sets: [], adds: [], dels: [] };
  const baseAt = new Map();
  (base || []).forEach(function (m, i) { baseAt.set(String(m && m.timestamp), i); });
  const keptTs = new Set();
  (target || []).forEach(function (m) { keptTs.add(String(m && m.timestamp)); });
  baseAt.forEach(function (i, ts) { if (!keptTs.has(ts)) delta.dels.push(ts); });
  (target || []).forEach(function (m, i) {
    const ts = String(m && m.timestamp);
    if (!baseAt.has(ts)) { delta.adds.push({ at: i, msg: m }); return; }
    if (JSON.stringify(base[baseAt.get(ts)]) !== JSON.stringify(m)) delta.sets.push({ ts: ts, msg: m });
  });
  return delta;
}

function _applyMsgDelta(base, delta) {
  if (!base || !delta) return null;
  const arr = JSON.parse(JSON.stringify(base));
  (delta.dels || []).forEach(function (ts) {
    const i = arr.findIndex(function (m) { return String(m && m.timestamp) === String(ts); });
    if (i >= 0) arr.splice(i, 1);
  });
  (delta.sets || []).forEach(function (s) {
    const i = arr.findIndex(function (m) { return String(m && m.timestamp) === String(s.ts); });
    if (i >= 0) arr[i] = JSON.parse(JSON.stringify(s.msg));
  });
  (delta.adds || []).slice().sort(function (a, b) { return a.at - b.at; }).forEach(function (a) {
    arr.splice(Math.min(a.at, arr.length), 0, JSON.parse(JSON.stringify(a.msg)));
  });
  return arr;
}

function _persistGraphHistory() {
  const sid = graphHistorySession;
  // T353：message 型条目按增量落盘，链基准沿栈向上传递；内存栈保持全量不动
  const arr = [];
  let chainMsgs = null;
  graphUndoStack.forEach(function (x) {
    const row = { sessionId: x.sessionId, state: x.state, meta: x.meta || null };
    if (x.messages) {
      let stored = false;
      if (chainMsgs) {
        const delta = _msgDeltaFrom(chainMsgs, x.messages);
        const rebuilt = _applyMsgDelta(chainMsgs, delta);
        if (rebuilt && JSON.stringify(rebuilt) === JSON.stringify(x.messages)) {
          row.msgDelta = delta;
          stored = true;
        }
      }
      if (!stored) row.messages = x.messages;
      chainMsgs = x.messages;
    }
    arr.push(row);
  });
  const slim = _graphHistoryDedupe(arr);
  // T365：游标与「最新」锚点随盘——刷新后时间旅行位与重做能力都不丢。锚点单独
  // 序列化成全量实体（不进条目数组，checkpoint 不置引用标记，体量最多多一份快照）。
  let liveRow = null;
  if (graphHistoryLive) {
    liveRow = { sessionId: graphHistoryLive.sessionId, state: graphHistoryLive.state, meta: graphHistoryLive.meta || null };
    if (graphHistoryLive.messages) liveRow.messages = graphHistoryLive.messages;
  }
  const envelope = {
    v: 2, e: slim, c: Math.min(graphHistoryCursor, slim.length), l: liveRow, t: Date.now(),
    d: graphHistoryDropped || 0, // T389 容量提示：被上限挤掉的条数（A 方案后含体积截断与步数钳制）
  };
  let s = JSON.stringify(envelope);
  if (s.length > GRAPH_HISTORY_STORAGE_MAX) {
    // A 方案（2026-11-18）：体积上限改硬顶。旧口径 keep 保底 5 条，单条快照 ≥300KB
    // 时 5 条就破 1.5MB 预算——实测单键 2.9MB ≈ 5×580KB，双上限里体积那半形同虚设。
    // 现在保底 1 条：常规图在预算内能留多少留多少；单条本身超预算的极端图保留 1 条
    // （快照体量来自 customNodes 等内容字段，无损缩小不可得、砍字段破坏撤销语义，
    // 残余超幅＝单条体量，接受）。截断的条数并入滚出计数，面板口径一致。
    const per = Math.max(1, Math.floor(s.length / (slim.length || 1)));
    const keep = Math.max(1, Math.floor(GRAPH_HISTORY_STORAGE_MAX / per));
    // 本地格子有限可截断（砍头部，游标同步重定基）；全量交给下面的服务端镜像
    const cut = Math.max(0, slim.length - keep);
    if (cut > 0) {
      envelope.e = slim.slice(cut);
      envelope.c = Math.max(0, envelope.c - cut);
      graphHistoryDropped += cut;
      envelope.d = graphHistoryDropped;
      s = JSON.stringify(envelope);
    }
  }
  graphHistorySavedAt = envelope.t;
  safeLocalStorageSet(_graphHistoryKey(sid), s);
  // 硬盘保险：镜像到服务端 KV——KV 拆分后每会话一文件，写它很便宜。本地配额满
  // 或被截断时服务端是更宽的存档窗口（体量治理见下节：最新窗口全量＋更老占位），
  // 换设备/清浏览器数据也能从存档读回整个撤销窗口。
  _scheduleGraphHistoryMirror(sid, envelope);
}

// ===== 探索网历史的服务端镜像（图历史上限 30 步撤销是既有设计，这里只保存储安全） =====
// 体量治理（T212，平移 T209 的「只减重、绝不删条目」口径）：镜像原本无上限——
// 本地 30 步/1.5MB 截断后服务端仍全量照收，且撤销栈采纳更长的服务端存档后长度
// 只升不降（棘轮），用久了又占盘又拖慢每次防抖写。改法：最新 _GRAPH_HISTORY_MIRROR_KEEP
// 条保全量（存档窗口，宽于本地截断上限），更老的原位换成 pruned 占位（sessionId/meta
// 保留、条数与顺序不动——_upgradeGraphHistoryFromServer「更长才采纳」契约不受影响）；
// 读回 hydrate 天然丢弃无 state 的占位，等价回落到「只留撤销窗口」语义，存量棘轮
// 在下次读回时自然泄掉。减重只发生在镜像序列化这一条路径上，内存栈与 localStorage
// 形状原样。
const _GRAPH_HISTORY_MIRROR_KEEP = 60;

function _graphHistoryMirrorSlim(arr) {
  if (!Array.isArray(arr) || arr.length <= _GRAPH_HISTORY_MIRROR_KEEP) return arr;
  const cut = arr.length - _GRAPH_HISTORY_MIRROR_KEEP;
  return arr.map(function (x, i) {
    if (i >= cut || !x || x.pruned) return x;
    return { sessionId: x.sessionId, meta: x.meta || null, pruned: true };
  });
}

// T365：信封级减重——条目走既有 _graphHistoryMirrorSlim（保持其数组级冒烟契约不动）。
// 注意 T212 口径是「只减重、绝不删条目」：头部换成 pruned 占位、条数不变，但读回
// hydrate 会丢占位——游标落在（或越过）占位区段时按头部占位数重定基，防读回后越界。
function _graphHistoryMirrorEnvelopeSlim(envelope) {
  if (!envelope || !Array.isArray(envelope.e)) return envelope;
  const e = _graphHistoryMirrorSlim(envelope.e);
  if (e === envelope.e) return envelope;
  const cut = (envelope.e.length > _GRAPH_HISTORY_MIRROR_KEEP)
    ? envelope.e.length - _GRAPH_HISTORY_MIRROR_KEEP : 0;
  return {
    v: 2, e: e, c: Math.max(0, (Number(envelope.c) || 0) - cut), l: envelope.l || null,
    t: envelope.t || 0, d: Number(envelope.d) || 0,
  };
}

let _graphHistoryMirrorTimer = null;
let _graphHistoryMirrorPending = null;

function _scheduleGraphHistoryMirror(sid, envelope) {
  if (!sid || !envelope || !Array.isArray(envelope.e) || !envelope.e.length) return;
  _graphHistoryMirrorPending = { sid: sid, value: _graphHistoryMirrorEnvelopeSlim(envelope) };
  if (_graphHistoryMirrorTimer) clearTimeout(_graphHistoryMirrorTimer);
  _graphHistoryMirrorTimer = setTimeout(_flushGraphHistoryMirror, 800);
}

function _flushGraphHistoryMirror() {
  if (_graphHistoryMirrorTimer) {
    clearTimeout(_graphHistoryMirrorTimer);
    _graphHistoryMirrorTimer = null;
  }
  const pending = _graphHistoryMirrorPending;
  _graphHistoryMirrorPending = null;
  if (!pending) return;
  try {
    fetch('/api/kv/graph_history:' + pending.sid, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: pending.value }),
    }).catch(function () { /* 镜像失败静默：下次保存会再镜像 */ });
  } catch (e) { /* 同上 */ }
}

// 清空在途窗口（2026-11-15 真机实踩）：discardGraphHistoryForSession 先清内存再发
// DELETE，而清内存触发的面板刷新会走 _ensureGraphHistory（栈空→重装路径）当场起飞
// 一个 GET——GET 先于 DELETE 到达服务端时，旧镜像会被「更长才采纳」整段接回来，
// 表现为「清空了又复活」（隔离实例两步清空验收当场复现）。wipeEpoch 只挡「起飞后
// 才清空」，挡不住这条「清空后才起飞」；这里给在途 DELETE 的会话挂一个窗口标记，
// 窗口内旧存档一律不采纳，DELETE 落地（成败都算）即撤标记。
let _graphHistoryWipeInFlight = Object.create(null);

// 切回会话时用存档补齐本地被截断/丢失的历史（只在存档更长时采纳——它按时间
// 是更早开始积累的全量副本；本地更新则不动，避免回退撤销栈）。T365：游标随存档
// 一并采纳（另一台设备停在哪就到哪）；T365 后跳转不再截断条目，本地/服务端条数
// 只因新编辑产生差异，「更长才采纳」棘轮口径不变。
function _upgradeGraphHistoryFromServer(sid) {
  if (!sid) return;
  const wipeEpoch = _graphHistoryWipeEpoch; // T349：起飞后发生过清空/删除，旧存档作废
  // 起飞时清空已在途：服务端可能先处理这个 GET 再处理 DELETE，响应哪怕落在 DELETE
  // 完成之后（连接池不保证响应顺序）也是旧账——按「起飞时刻」定格，落地一律不采纳。
  // 只挡在途窗口不够：窗口随 DELETE 响应关闭，迟到的旧 GET 响应会穿过去（真机实踩）。
  const wipeInFlightAtLaunch = !!_graphHistoryWipeInFlight[sid];
  fetch('/api/kv/graph_history:' + sid)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (wipeEpoch !== _graphHistoryWipeEpoch) return;
      if (wipeInFlightAtLaunch || _graphHistoryWipeInFlight[sid]) return; // 清空在途：旧存档不许复活
      const value = data && data.value;
      const count = (value && !Array.isArray(value) && Array.isArray(value.e)) ? value.e.length
        : (Array.isArray(value) ? value.length : 0);
      if (!count) return;
      if (graphHistorySession !== sid) return;
      if (count <= graphUndoStack.length) return;
      _adoptGraphHistoryPayload(value);
      if (typeof _refreshGraphHistoryPanel === 'function') _refreshGraphHistoryPanel();
    })
    .catch(function () { /* 无存档/离线：本地为准 */ });
}

// ===== T349：清空当前画布同步作废撤销历史 =====
// clearChat 此前只删 msgs_/graph_：撤销历史的三个落点全留着——内存栈（本页 Ctrl+Z
// 直接退回清空前快照）、localStorage 键、服务端镜像 graph_history:<sid>（刷新后
// _upgradeGraphHistoryFromServer「存档更长才采纳」会把旧栈整段接回来）。与 T342
// 删除画布口径对齐：清空＝这张画布的撤销历史一并作废。在途镜像必须一并作废，否则
// 800ms 防抖会在下面的 DELETE 之后把旧栈又 POST 回服务端。
function discardGraphHistoryForSession(sid) {
  if (!sid) return Promise.resolve();
  if (_graphHistoryMirrorPending && _graphHistoryMirrorPending.sid === sid) {
    _graphHistoryMirrorPending = null;
  }
  if (_graphHistoryMirrorTimer) { clearTimeout(_graphHistoryMirrorTimer); _graphHistoryMirrorTimer = null; }
  _graphHistoryWipeEpoch++;
  _graphHistoryWipeInFlight[sid] = true; // 在途窗口：下面的刷新起飞的 GET 不许采纳旧镜像
  // 先删本地键再清内存：清空后的面板刷新会走 _ensureGraphHistory，此时栈已空而键还在，
  // 会被当场从 localStorage 重新装载回来（2026-10-24 定稿清空实踩）。
  try { localStorage.removeItem(_graphHistoryKey(sid)); } catch (e) { /* 配额异常不阻断清空 */ }
  try { localStorage.removeItem(GRAPH_HISTORY_EXIT_KEY + sid); } catch (e) { /* 同上 */ }
  if (graphHistorySession === sid) {
    graphUndoStack = [];
    graphHistoryCursor = 0;
    graphHistoryLive = null;
    _graphPendingLiveMetaSet(sid, null);
    graphHistoryPendingTruncate = false;
    graphHistoryDropped = 0;
    graphHistoryLastEffect = { op: "", touch: "", at: 0 };
    graphHistoryLiveDirty = true;
    if (typeof _refreshGraphHistoryPanel === "function") _refreshGraphHistoryPanel();
  }
  return fetch('/api/kv/' + encodeURIComponent('graph_history:' + sid), {
    method: 'DELETE',
    // 旧运行时/测试沙箱没有 AbortSignal.timeout：缺了也不该让清空链在这里断掉
    signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
      ? AbortSignal.timeout(10000) : undefined,
  }).catch(function () { /* 镜像删除失败静默：清空主流程不被它卡住 */ })
    .then(function () { delete _graphHistoryWipeInFlight[sid]; },
          function () { delete _graphHistoryWipeInFlight[sid]; });
}
window.discardGraphHistoryForSession = discardGraphHistoryForSession;

// ===== 2026-11-18 退出后批量结算：把所有"上次正常退出"画布的历史一起清 =====
// 背景：退出结算 markGraphHistoryCleanExit 按 sid 逐个写标记，但用户平时只关一个页面、
// 只结算"上次最后打开的那一张"（settleGraphHistoryOnOpen 只认 _currentSessionId）。其余
// 画布的历史键（本机实测 22 个键 / 6.37 MB）永远等不到那一次结算，成了清不动的存量。
// 做法：正常退出时额外写一个全局 sweep 标记（见 graph-history-panel.js），下次打开时在此
// 一次性清掉所有带标记的画布历史。清本地键必须连服务端镜像一起 DELETE，否则
// _upgradeGraphHistoryFromServer「存档更长才采纳」会把旧栈灌回（白清）；这里复用上面的
// 防复活三件套：wipeEpoch 作废在途 GET、wipeInFlight 挡迟到响应、DELETE landing 后撤标记。
// 只在启动、服务端可达时跑；F5/强杀/只读由标记写入侧把关（标记本就不写）。
function _batchDiscardGraphHistories(sids) {
  const list = Array.isArray(sids) ? sids.filter(Boolean) : [];
  if (!list.length) return Promise.resolve(0);
  _graphHistoryWipeEpoch++; // 一次性作废所有在途镜像 GET（批量清期间谁都不许采纳旧存档）
  list.forEach(function (sid) { _graphHistoryWipeInFlight[sid] = true; });
  const jobs = list.map(function (sid) {
    // 本地键的删除时机（2026-11-18 复审修正）：必须在服务端镜像 DELETE 确认成功之后。
    // 否则 delete 静默失败时本地键已删、服务端旧栈还在，下次打开该画布会被
    // _upgradeGraphHistoryFromServer「存档更长才采纳」整段灌回＝白清且再也扫不到。
    // 失败时保留本地键与原样标记：既不留复活缺口，下次启动全量扫描还能把它纳入重试。
    return fetch('/api/kv/' + encodeURIComponent('graph_history:' + sid), {
      method: 'DELETE',
      signal: (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function')
        ? AbortSignal.timeout(10000) : undefined,
    }).then(function (r) {
      // 只有「请求走到且 HTTP 2xx」才算删除成功：reject（网络断/超时/沙箱注入失败）
      // 与 r.ok === false（非 2xx）一律当失败——本地键保留、标记原样，留给下次全量
      // 扫描重试。当前服务端 DELETE /api/kv 恒 200，这条 ok 闸平时走不到（501
      // 修正注释：此前注释写「resolve 即成功」，与代码不符）；万一哪天服务端改了
      // 状态码口径，这里的失败处理也已经是对的。
      if (r && r.ok === false) return false;
      try { localStorage.removeItem(_graphHistoryKey(sid)); } catch (e) { /* 配额异常不阻断 */ }
      try { localStorage.removeItem(GRAPH_HISTORY_EXIT_KEY + sid); } catch (e) { /* 同上 */ }
      return true;
    }).catch(function () { return false; /* 删除失败：本地键保留，等下次全量扫描重试 */ })
      .then(function (ok) { delete _graphHistoryWipeInFlight[sid]; return ok; },
            function () { delete _graphHistoryWipeInFlight[sid]; return false; });
  });
  return Promise.all(jobs).then(function (results) {
    return results.filter(Boolean).length; // 返回真正删成功的张数，调用侧据此决定是否消费名单
  });
}
window._batchDiscardGraphHistories = _batchDiscardGraphHistories;
