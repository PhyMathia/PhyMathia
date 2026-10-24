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
  graphUndoStack = entries;
  const c = isEnv ? Number(parsed.c) : NaN;
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
    d: graphHistoryDropped || 0, // T389 容量提示：被 30 步上限挤掉的条数
  };
  let s = JSON.stringify(envelope);
  if (s.length > GRAPH_HISTORY_STORAGE_MAX) {
    const per = Math.max(1, Math.floor(s.length / (slim.length || 1)));
    const keep = Math.max(5, Math.floor(GRAPH_HISTORY_STORAGE_MAX / per));
    // 本地格子有限可截断（砍头部，游标同步重定基）；全量交给下面的服务端镜像
    const cut = Math.max(0, slim.length - keep);
    envelope.e = slim.slice(cut);
    envelope.c = Math.max(0, envelope.c - cut);
    s = JSON.stringify(envelope);
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

// 切回会话时用存档补齐本地被截断/丢失的历史（只在存档更长时采纳——它按时间
// 是更早开始积累的全量副本；本地更新则不动，避免回退撤销栈）。T365：游标随存档
// 一并采纳（另一台设备停在哪就到哪）；T365 后跳转不再截断条目，本地/服务端条数
// 只因新编辑产生差异，「更长才采纳」棘轮口径不变。
function _upgradeGraphHistoryFromServer(sid) {
  if (!sid) return;
  const wipeEpoch = _graphHistoryWipeEpoch; // T349：起飞后发生过清空/删除，旧存档作废
  fetch('/api/kv/graph_history:' + sid)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (wipeEpoch !== _graphHistoryWipeEpoch) return;
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
  // 先删本地键再清内存：清空后的面板刷新会走 _ensureGraphHistory，此时栈已空而键还在，
  // 会被当场从 localStorage 重新装载回来（2026-10-24 定稿清空实踩）。
  try { localStorage.removeItem(_graphHistoryKey(sid)); } catch (e) { /* 配额异常不阻断清空 */ }
  try { localStorage.removeItem(GRAPH_HISTORY_EXIT_KEY + sid); } catch (e) { /* 同上 */ }
  if (graphHistorySession === sid) {
    graphUndoStack = [];
    graphHistoryCursor = 0;
    graphHistoryLive = null;
    graphPendingLiveMeta = null;
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
  }).catch(function () { /* 镜像删除失败静默：清空主流程不被它卡住 */ });
}
window.discardGraphHistoryForSession = discardGraphHistoryForSession;
