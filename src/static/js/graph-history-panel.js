// ===== 修改历史：对比模型、分叉与面板（2026-10-24 自 graph.js 拆出，T397 纯搬家）=====
// 「回到这一步会多什么/少什么/改什么」对比模型、另开探索线（T389）、退出结算与面板 UI；
// 文末 window 导出块随件（引用前两件的函数，函数声明全脚本提升）。
// ===== 对比模型（2.2）：把 diff 翻成「回到这一步会多什么、少什么、改什么」=====
// 方向固定为「回到那一步」：create=现在有、那时没有 → 会消失；delete=那时有、现在
// 没有 → 会回来；update=两边都有但内容不同 → 会改写（R5）。
function _graphDiffWillIcon(will) {
  if (will === "vanish") return "−";
  if (will === "return") return "＋";
  return "✎";
}

function _graphDiffWillLabel(will, dir) {
  // step 方向（这一步改了什么）的措辞与 back 相反：return＝新出现、vanish＝被删掉
  if (dir === "step") {
    if (will === "vanish") return "被删掉";
    if (will === "return") return "新出现";
    return "被改了";
  }
  if (will === "vanish") return "会消失";
  if (will === "return") return "会回来";
  return "会改写";
}

function _graphHistoryCompareModel(versionIndex, dir) {
  const target = _graphHistoryVersionOf(versionIndex);
  if (!target || target.isLive || !target.state) return null;
  const raw = target.raw || { state: target.state, messages: target.messages, meta: target.meta };
  const targetProj = _graphVersionProjection(raw);
  let diff = null;
  if (dir === "step") {
    // 「这一步改了什么」（简化批次合并原「与上一步对比」）：形成这一版的编辑
    // ＝上一条快照 → 这一条快照；第一步之前没有更早的版本，调用方负责回落 back。
    const prevEntry = graphUndoStack[versionIndex - 1];
    if (!prevEntry) return null;
    diff = _graphDiffFromProjections(_graphVersionProjection(prevEntry), targetProj);
  } else {
    // 「回到这里会怎样」：那一版 → 当前（R5 固定方向）。
    diff = _graphDiffFromProjections(targetProj, _graphLiveProjection());
  }
  const step = dir === "step";
  const items = [];
  diff.ops.forEach(function (op) {
    if (op.op === "create_node") {
      items.push({
        will: step ? "return" : "vanish", nodeId: op.id, label: op.label || op.id,
        detail: step
          ? (op.preview ? ("内容：" + op.preview) : "这一步新出现")
          : (op.preview ? ("现在：" + op.preview) : "现在有、那一步没有"),
      });
    } else if (op.op === "delete_node") {
      items.push({
        will: step ? "vanish" : "return", nodeId: op.id, label: op.label || op.id,
        detail: op.preview ? ("当年：" + op.preview) : (step ? "这一步删掉了" : "那一步有、现在没有"),
      });
    } else if (op.op === "update_node") {
      items.push({
        will: "change", nodeId: op.id, label: op.label || op.id,
        detail: "「" + _graphShorten(op.before || "（空）", 40) + "」→「" + _graphShorten(op.after || "（空）", 40) + "」",
      });
    } else if (op.op === "update_groups") {
      items.push({ will: "change", nodeId: "", label: "分组", detail: "分组归属或命名变了" });
    } else if (op.op === "update_ports") {
      items.push({ will: "change", nodeId: "", label: "端口", detail: "端口的数量或名字变了" });
    }
  });
  const order = { vanish: 0, change: 1, return: 2 };
  items.sort(function (a, b) { return (order[a.will] || 0) - (order[b.will] || 0); });
  // 计数从清单数（与展示一一对应；键名沿用 vanish/ret/change）；行的差异芯片仍吃
  // 推送时定格的 entry.meta.counts。
  const counts = { vanish: 0, ret: 0, change: 0 };
  items.forEach(function (it) { counts[it.will === "return" ? "ret" : it.will] = (counts[it.will === "return" ? "ret" : it.will] || 0) + 1; });
  return {
    index: versionIndex,
    dir: step ? "step" : "back",
    target: target,
    diff: diff,
    items: items,
    counts: counts,
    focusIndex: -1,
  };
}

function _graphHistoryVersionOf(versionIndex) {
  _ensureGraphHistory();
  const versions = _graphVersions();
  return versions[versionIndex] || null;
}

// 事件点收尾（3.1/3.4）：提问/重生成跑完后，把「当前状态」行的差异计数补上。
// 摘要仍是「提问：…」（动作名），计数告诉用户这一次到底加了/改了多少。
function _graphHistoryLiveEventDone() {
  if (!graphPendingLiveMeta) return;
  const last = graphUndoStack[graphUndoStack.length - 1];
  if (last) {
    const diff = _graphDiffFromProjections(_graphVersionProjection(last), _graphLiveProjection());
    if (!diff.layoutOnly) graphPendingLiveMeta = Object.assign({}, graphPendingLiveMeta, { counts: diff.counts });
  }
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryLastSignature = "";
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

function _graphHistoryVersionTitle(model) {
  const meta = (model && model.target && model.target.meta) || {};
  const time = _graphHistoryTime(meta.ts);
  // 旧数据起的名字照显示（起名收藏已随简化批次退役，新名字不再产生）
  const summary = meta.name || meta.summary || "历史版本";
  return (time ? time + " " : "") + summary;
}

// 拿到模型并上屏（对比的两向共用）：预览、切换方向都走这里。
function _showGraphHistoryCompare(versionIndex) {
  const model = _graphHistoryCompareModel(versionIndex, graphHistoryCompareDir);
  if (!model) return false;
  graphHistoryPreviewing = versionIndex;
  graphHistoryDiffModel = model;
  graphHistoryDiffSummary = (model.dir === "step")
    ? "版本 " + (versionIndex + 1) + " 这一步改了什么：" + model.diff.summary
    : "版本 " + (versionIndex + 1) + " 与当前差异：" + model.diff.summary;
  if (typeof window.applyGraphHistoryDiff === "function") {
    window.applyGraphHistoryDiff(model.diff, { dir: model.dir });
  }
  // 1.1：点对比就把镜头框到差异处（变化可能在屏外；全景缩放下 3px 描边≈1px）
  _graphFocusHistoryDiffModel(model);
  _renderGraphHistoryFooter();
  _refreshGraphHistoryPanel();
  return true;
}

function _previewGraphVersion(versionIndex) {
  _ensureGraphHistory();
  const target = _graphHistoryVersionOf(versionIndex);
  if (!target) return;
  // 再次点击正在对比的版本（或点击当前版本/无实体状态的锚点行）→ 退出对比
  if (target.isLive || !target.state || graphHistoryPreviewing === versionIndex) {
    exitGraphVersionPreview();
    return;
  }
  // 「这一步改了什么」在第一步没有上一版可比：自动回落到「回到这里会怎样」
  if (graphHistoryCompareDir === "step" && versionIndex < 1) graphHistoryCompareDir = "back";
  _showGraphHistoryCompare(versionIndex);
}

// 对比面板的两向切换（简化批次合并原「与上一步对比」行内按钮）：
// back＝回到这里会怎样（默认）；step＝这一步改了什么（第一步不可用）。
function setGraphHistoryCompareDir(dir) {
  if (dir !== "back" && dir !== "step") return false;
  if (dir === graphHistoryCompareDir) return true;
  if (dir === "step" && graphHistoryPreviewing >= 0 && graphHistoryPreviewing < 1) {
    if (typeof toastMsg === "function") toastMsg("第一步之前没有更早的版本可比", 3000);
    return false;
  }
  graphHistoryCompareDir = dir;
  if (graphHistoryPreviewing >= 0) {
    const idx = graphHistoryPreviewing;
    graphHistoryPreviewing = -1;   // 让 _showGraphHistoryCompare 不当成「再点退出」
    _showGraphHistoryCompare(idx);
  } else {
    graphHistoryLastSignature = "";
    _renderGraphHistoryFooter();
  }
  return true;
}
window.setGraphHistoryCompareDir = setGraphHistoryCompareDir;

// 镜头框到差异：变化节点（现在存在的）进包围盒（幽灵层已随简化批次退役，
// 「会回来」的节点当前画布上没有实体，不进包围盒）。
function _graphFocusHistoryDiffModel(model) {
  if (!model) return false;
  const ids = [];
  model.diff.ops.forEach(function (op) {
    if ((op.op === "create_node" || op.op === "update_node") && op.id) ids.push(String(op.id));
  });
  const bounds = _graphModelBounds(model, ids);
  if (!bounds) return false;
  _graphFocusBounds(bounds);
  if (typeof window.flashGraphHistoryDiff === "function" && ids.length) window.flashGraphHistoryDiff(ids);
  return true;
}

function _graphModelBounds(model, ids) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, found = 0;
  (ids || []).forEach(function (id) {
    const node = graphView.nodeById && graphView.nodeById[String(id)];
    if (!node) return;
    found++;
    const w = node.w || node.customWidth || 220;
    const h = node.h || node.customHeight || 72;
    minX = Math.min(minX, node.x - w / 2);
    minY = Math.min(minY, node.y - h / 2);
    maxX = Math.max(maxX, node.x + w / 2);
    maxY = Math.max(maxY, node.y + h / 2);
  });
  if (!found) return null;
  return { x1: minX, y1: minY, x2: maxX, y2: maxY, count: found };
}

function _graphFocusBounds(bounds) {
  if (!bounds || typeof graphCanvas === "undefined" || !graphCanvas) return false;
  let rect = { width: 0, height: 0 };
  try { rect = graphCanvas.getBoundingClientRect(); } catch (e) { return false; }
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  const state = _graphState();
  if (!state) return false;
  if (!state.pan || typeof state.pan !== "object") state.pan = { x: 0, y: 0 };
  const w = Math.max(180, bounds.x2 - bounds.x1);
  const h = Math.max(120, bounds.y2 - bounds.y1);
  const minZoom = typeof GRAPH_MIN_ZOOM === "number" ? GRAPH_MIN_ZOOM : 0.1;
  const maxZoom = typeof GRAPH_MAX_ZOOM === "number" ? GRAPH_MAX_ZOOM : 4;
  const zoom = Math.max(minZoom, Math.min(maxZoom, Math.min((rect.width - 120) / w, (rect.height - 160) / h, 1.3)));
  state.zoom = zoom;
  state.pan.x = rect.width / 2 - ((bounds.x1 + bounds.x2) / 2) * zoom;
  state.pan.y = rect.height / 2 - ((bounds.y1 + bounds.y2) / 2) * zoom;
  _saveGraphState(state, { deferLocalWrite: true });
  if (typeof _applyGraphTransform === "function") _applyGraphTransform();
  return true;
}

// 清单里点一行：镜头飞过去＋呼吸闪烁（2.2/2.3）。没有节点可定位的行（分组/端口）
// 只高亮清单项，不挪镜头。
function focusGraphHistoryDiff(index) {
  const model = graphHistoryDiffModel;
  if (!model) return;
  const item = (model.items || [])[index];
  if (!item) return;
  model.focusIndex = index;
  if (item.nodeId) {
    const bounds = _graphModelBounds(model, [item.nodeId]);
    if (bounds) _graphFocusBounds(bounds);
    if (typeof window.flashGraphHistoryDiff === "function") window.flashGraphHistoryDiff([item.nodeId]);
  }
  _renderGraphHistoryFooter();
}

function _renderGraphHistoryFooter() {
  const footer = document.getElementById("graphHistoryDiffText");
  if (!footer) return;
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  const model = graphHistoryDiffModel;
  if (graphHistoryPreviewing < 0 || !model) { footer.innerHTML = ''; return; }
  const counts = model.counts || {};
  const step = model.dir === "step";
  const cntLabel = function (will) { return _graphDiffWillLabel(will, model.dir); };
  const title = step
    ? '对比：这一步改了什么——「' + esc(_graphHistoryVersionTitle(model)) + '」'
    : '对比：回到「' + esc(_graphHistoryVersionTitle(model)) + '」会怎样';
  const head = '<div class="graph-history-diff-head">'
    + '<div class="graph-history-diff-title">' + title + '</div>'
    + '<div class="graph-history-diff-counts">'
    + '<span class="g-hd-count will-vanish">' + cntLabel('vanish') + ' ' + (counts.vanish || 0) + '</span>'
    + '<span class="g-hd-count will-return">' + cntLabel('return') + ' ' + (counts.ret || 0) + '</span>'
    + '<span class="g-hd-count will-change">' + cntLabel('change') + ' ' + (counts.change || 0) + '</span>'
    + '</div></div>';
  // 行保持 div（role=button）：别退回 button，嵌套按钮的教训在这里（T389 实踩）。
  const list = model.items.length
    ? '<div class="graph-history-diff-list">' + model.items.map(function (it, i) {
      const icon = _graphDiffWillIcon(it.will);
      const active = model.focusIndex === i ? " active" : "";
      const clickable = !!it.nodeId;
      return '<div class="graph-history-diff-item will-' + it.will + active + (clickable ? '' : ' no-focus') + '"'
        + (clickable ? ' role="button" tabindex="0" onclick="focusGraphHistoryDiff(' + i + ')"' : '')
        + '><span class="g-hd-icon">' + icon + '</span>'
        + '<span class="g-hd-will">' + _graphDiffWillLabel(it.will, model.dir) + '</span>'
        + '<span class="g-hd-label">' + esc(it.label) + '</span>'
        + '<span class="g-hd-detail">' + esc(it.detail) + '</span></div>';
    }).join('') + '</div>'
    : '<div class="graph-history-diff-empty">' + (model.diff.layoutChanges
      ? '只有位置变化（拖动/自动整理），内容没变'
      : (step ? '这一步什么都没改' : '这一步与现在一致')) + '</div>';
  const legend = '<div class="graph-history-diff-legend">'
    + '<span class="g-hd-legend will-return">＋ ' + cntLabel('return') + '</span>'
    + '<span class="g-hd-legend will-vanish">− ' + cntLabel('vanish') + '</span>'
    + '<span class="g-hd-legend will-change">✎ ' + cntLabel('change') + '</span>'
    + '</div>';
  // 两向切换（简化批次）：back＝回到这里会怎样（默认）／step＝这一步改了什么
  const stepDisabled = model.index < 1 ? ' disabled title="第一步之前没有更早的版本"' : '';
  const actions = '<div class="graph-history-diff-actions">'
    + '<button type="button" class="g-hd-dir' + (step ? '' : ' active') + '" onclick="setGraphHistoryCompareDir(\'back\')">回到这里会怎样</button>'
    + '<button type="button" class="g-hd-dir' + (step ? ' active' : '') + '"' + stepDisabled + ' onclick="setGraphHistoryCompareDir(\'step\')">这一步改了什么</button>'
    + '<button type="button" class="g-hd-jump" onclick="jumpGraphVersion(' + model.index + ')">回到这一步</button>'
    + '<button type="button" class="graph-history-exit-preview" onclick="exitGraphVersionPreview()">✕ 退出对比</button>'
    + '</div>';
  footer.innerHTML = head + legend + list + actions;
}

function exitGraphVersionPreview() {
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
  graphHistoryDiffModel = null;
  _renderGraphHistoryFooter();
  _refreshGraphHistoryPanel();
}

function _graphHistorySourceLabel(source) {
  if (source === "harness" || source === "ai") return "AI";
  if (source === "undo") return "撤销";
  if (source === "init") return "初始";
  if (source === "now") return "现在";
  if (source === "fork") return "分叉";
  return "手动";
}

// ===== T389 / 4.1 另开探索线 =====
// 由 session.js 的 forkSessionFromSnapshot 在切过去之前调用：把那一步的图状态与消息种成
// 新画布修改历史的起点行「分叉自「原画布」第 5 步」。写的是本模块自己的信封——切过去后
// _ensureGraphHistory 首读即装载；随后任何一次保存都照常补落盘与服务端镜像。不新增后端接口。
function seedForkedGraphHistory(sid, payload) {
  if (!sid) return false;
  const p = payload || {};
  const state = (p.state && typeof p.state === "object") ? JSON.parse(JSON.stringify(p.state)) : null;
  if (!state) return false;
  const messages = Array.isArray(p.messages) ? JSON.parse(JSON.stringify(p.messages)) : [];
  const sourceTitle = String(p.sourceTitle || "原画布");
  const step = Number(p.step) || 0;
  const entry = {
    sessionId: sid,
    state: state,
    messages: messages,
    meta: {
      source: "fork",
      summary: (step > 0 ? ("分叉自「" + sourceTitle + "」第 " + step + " 步") : ("分叉自「" + sourceTitle + "」"))
        + (messages.length ? "" : "（无对话快照）"),
      ts: Date.now(),
      pushedAt: Date.now(),
      forkOf: String(p.sourceId || ""),
      forkStep: step,
    },
  };
  entry._proj = _graphProjectionOf(entry.state, messages);
  entry.meta.proj = entry._proj;
  const envelope = { v: 2, e: [entry], c: 1, l: null, t: Date.now(), s: null, d: 0 };
  try { safeLocalStorageSet(_graphHistoryKey(sid), JSON.stringify(envelope)); } catch (e) { return false; }
  _scheduleGraphHistoryMirror(sid, envelope);
  if (graphHistorySession === sid) {
    graphUndoStack = [entry];
    graphHistoryCursor = 1;
    graphHistoryLive = null;
    graphHistoryDropped = 0;
    graphHistorySavedAt = envelope.t;
    graphHistoryLastEffect = { op: "", touch: "", at: 0 };
    graphHistoryLiveDirty = true;
    graphHistoryLiveMetaCache = null;
    graphHistoryLastSignature = "";
  }
  return true;
}
window.seedForkedGraphHistory = seedForkedGraphHistory;

// 目标版本对应的对话（4.1）：条目自己有消息快照就用它；绝大多数「图状态」条目都不带
// 消息（推送时只有消息编辑类才 withMessages），此时按那一版投影里的消息派生节点从当前
// 对话还原——消息只追加不重排，节点 id 的末段就是消息时间戳（q-/a-/m-/sq-<ts>），筛出来
// 的正好是「那一刻已经存在」的那些条。旧条目没有投影（degraded）就退回空对话，按计划
// 文档 4.1 的降级口径：只复制图状态，标题里注明。
function _graphMessagesForVersion(target, fallback) {
  if (!target) return Array.isArray(fallback) ? fallback.slice() : [];
  if (Array.isArray(target.messages) && target.messages.length) return target.messages.slice();
  const raw = target.raw || null;
  const proj = raw ? _graphVersionProjection(raw) : null;
  const all = Array.isArray(fallback) ? fallback : [];
  if (!proj || proj.degraded || !proj.n) return [];
  const stamps = new Set();
  Object.keys(proj.n).forEach(function (id) {
    const m = /^(?:q|a|m|sq)-([0-9]+)/.exec(String(id));
    if (m) stamps.add(m[1]);
  });
  return all.filter(function (msg) {
    return msg && stamps.has(String(msg.timestamp || "").replace(/[^0-9]/g, ""));
  });
}

// 历史面板每一行都能「另开」：从这一步复制出另一张画布，原画布一字不动，侧栏切换。
// 停在历史中位时另开的是「那一步」；当前行另开的是此刻的图（等同复制一张画布）。
async function forkGraphHistoryVersion(versionIndex) {
  if (typeof phyIsReadonly === "function" && phyIsReadonly()) {
    if (typeof phyReadonlyBlock === "function") phyReadonlyBlock("另开探索线");
    return false;
  }
  _ensureGraphHistory();
  const idx = Number(versionIndex);
  const target = _graphHistoryVersionOf(idx);
  let state = null;
  let messages = [];
  let step = graphUndoStack.length + 1;
  if (target && !target.isLive && target.state) {
    state = target.state;
    messages = _graphMessagesForVersion(target, _getChatHistory());
    step = idx + 1;
  } else {
    state = _graphState();
    messages = _getChatHistory();
  }
  if (!state || typeof window.forkSessionFromSnapshot !== "function") return false;
  const sid = _currentSessionId();
  const sess = (typeof window.getSessionById === "function") ? window.getSessionById(sid) : null;
  const res = await window.forkSessionFromSnapshot({
    sourceId: sid,
    sourceTitle: (sess && sess.title) || "",
    step: step,
    state: state,
    messages: messages,
  });
  if (!res) return false;
  graphHistoryPreviewing = -1;
  graphHistoryDiffModel = null;
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
  // 已经切到新画布：把内存历史切到它的种子（面板若开着，下一拍就是新画布的历史）
  graphHistoryLastSignature = "";
  _ensureGraphHistory();
  _refreshGraphHistoryPanel();
  if (typeof toastMsg === "function") toastMsg("已另开探索线「" + res.title + "」· 原画布一字未动", 5200);
  return true;
}
window.forkGraphHistoryVersion = forkGraphHistoryVersion;

// 起名收藏／恢复排版开关／单节点恢复（T389 4.3）已随 2026-10-24 简化批次整块退役：
// 收藏与 30 步上限的择优挤出、排版偏好键、差异清单「恢复这一颗」全部删除；恢复固定
// 「保留当前排版」（见 _restoreGraphVersion），旧数据里已起的名字仍照显示。

function _graphHistoryTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = function (n) { return n < 10 ? "0" + n : String(n); };
  return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
}

function openGraphHistoryPanel() {
  _ensureGraphHistory();
  if (!graphHistoryPanel) {
    graphHistoryPanel = document.createElement("div");
    graphHistoryPanel.className = "graph-history-panel aurora-glass aurora-glass--dialog";
    graphHistoryPanel.innerHTML = ''
      + '<div class="graph-history-head-row"><span class="graph-history-title">修改历史</span>'
      + '<span class="graph-history-pos" id="graphHistoryPos"></span>'
      + '<span class="graph-history-cap" id="graphHistoryCap" title="更早的步骤会随 30 步上限移出"></span>'
      + '<button type="button" class="graph-history-close" onclick="closeGraphHistoryPanel()" aria-label="关闭">✕</button></div>'
      + '<div class="graph-history-tools">'
      + '<button type="button" onclick="undoGraphAction()" title="Ctrl+Z">↩ 撤销</button>'
      + '<button type="button" onclick="redoGraphAction()" title="Ctrl+Y / Ctrl+Shift+Z">↪ 重做</button>'
      + '<button type="button" class="graph-history-settle" onclick="settleGraphHistoryNow()" title="清空修改历史，保留当前图状态（定稿）">定稿清空</button>'
      + '</div>'
      + '<div class="graph-history-list" id="graphHistoryList"></div>'
      + '<div class="graph-history-diff" id="graphHistoryDiffText"></div>';
    document.body.appendChild(graphHistoryPanel);
  }
  graphHistoryPanel.hidden = false;
  if (graphHistoryTimer) clearInterval(graphHistoryTimer);
  graphHistoryTimer = setInterval(function () { _refreshGraphHistoryPanel(); }, 800);
  _refreshGraphHistoryPanel();
}

function toggleGraphHistoryPanel() {
  if (graphHistoryPanel && !graphHistoryPanel.hidden) { closeGraphHistoryPanel(); return; }
  openGraphHistoryPanel();
}
function closeGraphHistoryPanel() {
  if (graphHistoryTimer) { clearInterval(graphHistoryTimer); graphHistoryTimer = null; }
  if (graphHistoryPanel) graphHistoryPanel.hidden = true;
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
}

// ===== 退出结算（1.3 / §6）：正常关闭只写标记，下次打开时结算 =====
// 仓库既有拍板（session.js）：清理点不放在 beforeunload——崩溃/强杀不触发。所以这里
// 只落一个轻量标记（条数＋末条时间戳＋游标），下次打开对指纹、看是不是刷新、看当时
// 是不是停在最新，全部对上才清。宁可留着，不清错。
function _graphHistoryExitKeyFor(sid) {
  return GRAPH_HISTORY_EXIT_KEY + (sid || "default");
}

function _graphHistoryExitFingerprint() {
  const last = graphUndoStack[graphUndoStack.length - 1];
  const ts = (last && last.meta && (last.meta.pushedAt || last.meta.ts)) || 0;
  return [graphUndoStack.length, ts, graphHistoryCursor].join("|");
}

function markGraphHistoryCleanExit() {
  if (typeof phyIsReadonly === "function" && phyIsReadonly()) return false;
  const sid = _currentSessionId();
  if (!sid) return false;
  try {
    // 同步读本地存档（不发网络）：卸载阶段只有同步 localStorage 写靠得住
    _ensureGraphHistory();
    localStorage.setItem(_graphHistoryExitKeyFor(sid), JSON.stringify({
      sid: sid,
      at: Date.now(),
      fp: _graphHistoryExitFingerprint(),
      atLatest: graphHistoryCursor >= graphUndoStack.length,
    }));
    return true;
  } catch (e) { return false; }
}

function _graphHistoryNavType() {
  try {
    const entries = performance.getEntriesByType && performance.getEntriesByType("navigation");
    return (entries && entries[0] && entries[0].type) || "";
  } catch (e) { return ""; }
}

async function _settleGraphHistoryToLive() {
  if (graphHistoryCursor >= graphUndoStack.length) return true;
  const live = graphHistoryLive;
  if (!live || !live.state) return false; // 回不到最新就不清（宁可留着）
  graphHistoryCursor = graphUndoStack.length;
  graphHistoryLive = null;
  graphPendingLiveMeta = null;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryPreviewing = -1;
  graphHistoryDiffModel = null;
  await _restoreGraphVersion(live);
  _persistGraphHistory();
  return true;
}

function _settleClearGraphHistory(reason) {
  const sid = _currentSessionId();
  if (!sid) return false;
  const had = graphUndoStack.length > 0;
  if (had && typeof discardGraphHistoryForSession === "function") {
    // 复用既有清空链：内存栈/游标/锚点＋本地键＋服务端镜像（含纪元号作废在途补回）
    discardGraphHistoryForSession(sid);
  } else {
    graphUndoStack = [];
    graphHistoryCursor = 0;
    graphHistoryLive = null;
    try { localStorage.removeItem(_graphHistoryKey(sid)); } catch (e) { /* 同上 */ }
  }
  graphPendingLiveMeta = null;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryPreviewing = -1;
  graphHistoryDiffModel = null;
  graphHistoryLastSignature = "";
  try { localStorage.removeItem(_graphHistoryExitKeyFor(sid)); } catch (e) { /* best effort */ }
  _refreshGraphHistoryPanel();
  if (had) {
    const text = reason || "历史已清空，从当前状态重新开始";
    if (typeof toastMsg === "function") toastMsg(text, 4200);
    else if (typeof showToast === "function") showToast(text, 4200);
  }
  return true;
}

async function settleGraphHistoryOnOpen() {
  if (typeof phyIsReadonly === "function" && phyIsReadonly()) return false;
  const sid = _currentSessionId();
  if (!sid) return false;
  _ensureGraphHistory();
  let marker = null;
  try { marker = JSON.parse(localStorage.getItem(_graphHistoryExitKeyFor(sid)) || "null"); } catch (e) { marker = null; }
  const nav = _graphHistoryNavType();
  if (nav === "reload") {
    // F5 刷新不丢撤销：清掉标记，历史原样
    try { localStorage.removeItem(_graphHistoryExitKeyFor(sid)); } catch (e) { /* best effort */ }
    return false;
  }
  if (marker) {
    if (marker.sid && marker.sid !== sid) return false;
    if (marker.fp !== _graphHistoryExitFingerprint()) {
      // 多标签改过历史 / 指纹对不上：不清，只把标记作废（否则下次会拿旧指纹误判）
      try { localStorage.removeItem(_graphHistoryExitKeyFor(sid)); } catch (e) { /* best effort */ }
      return false;
    }
    if (!marker.atLatest) {
      const back = await _settleGraphHistoryToLive();
      if (!back) return false;
    }
    if (graphHistoryCursor < graphUndoStack.length) return false;
    return _settleClearGraphHistory("上次已正常退出 · 历史已从当前状态重新开始");
  }
  // 无标记（崩溃/强杀/桌面端没发 pagehide）→ 不清；距上次活动超过 12 小时再按时间兜底
  if (graphUndoStack.length && graphHistorySavedAt
    && Date.now() - graphHistorySavedAt > GRAPH_HISTORY_STALE_SETTLE_MS) {
    return _settleClearGraphHistory("这张画布超过 12 小时没动 · 历史已从当前状态重新开始");
  }
  return false;
}

// 面板里的手动口（§6.1.4「定稿并清空历史」）：随时可清，和自动结算走同一条路。
async function settleGraphHistoryNow() {
  if (typeof phyIsReadonly === "function" && phyIsReadonly()) {
    if (typeof phyReadonlyBlock === "function") phyReadonlyBlock("清空修改历史");
    return false;
  }
  return _settleClearGraphHistory("历史已清空（定稿）· 当前图状态保留");
}

function _scrollGraphHistoryToCurrent() {
  // R9：打开面板默认停在最老一行，当前步在最下面。滚到「当前位置」那一行。
  const listEl = document.getElementById("graphHistoryList");
  if (!listEl || typeof listEl.querySelector !== "function") return;
  let row = null;
  try { row = listEl.querySelector(".graph-history-item.current"); } catch (e) { row = null; }
  if (row && typeof row.scrollIntoView === "function") {
    try { row.scrollIntoView({ block: "nearest" }); } catch (e) { /* 老浏览器只认无参 */ }
  }
}

function _refreshGraphHistoryPanel() {
  if (!graphHistoryPanel || graphHistoryPanel.hidden) return;
  const versions = _graphVersions();
  const sig = graphHistoryPreviewing + "|" + graphHistoryCursor + "|" + graphHistoryCompareDir + "|"
    + ((graphHistoryDiffModel && graphHistoryDiffModel.focusIndex) || -1) + "|"
    + graphHistoryDropped + "|"
    + versions.map(function (v) {
      return v.index + "|" + (v.isLive ? 1 : 0) + "|" + (v.meta && v.meta.source) + "|"
        + ((v.meta && v.meta.summary) || "") + "|" + (v.counts ? _graphDiffCountText(v.counts) : "");
    }).join("~");
  if (sig === graphHistoryLastSignature) {
    _renderGraphHistoryFooter();
    return;
  }
  graphHistoryLastSignature = sig;
  const listEl = document.getElementById("graphHistoryList");
  const posEl = document.getElementById("graphHistoryPos");
  if (posEl) posEl.textContent = "位置 " + (graphHistoryCursor + 1) + " / " + (graphUndoStack.length + 1);
  // 容量提示（4.3）：已记几条、本地存档多大、更早的有多少被挤出
  const capEl = document.getElementById("graphHistoryCap");
  if (capEl) {
    // 简化批次：只说滚出条数（条数/KB 仪表与排版开关已退役）
    capEl.textContent = graphHistoryDropped ? "更早的 " + graphHistoryDropped + " 步已移出" : "";
  }
  if (!listEl) return;
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  const futureCount = graphUndoStack.length - graphHistoryCursor; // 游标之后的可重做步数
  listEl.innerHTML = versions.map(function (v) {
    const label = _graphHistorySourceLabel(v.meta && v.meta.source);
    // 旧数据起的名字照显示（起名收藏已退役）
    const summary = esc((v.meta && (v.meta.name || v.meta.summary)) || "");
    const time = _graphHistoryTime(v.meta && v.meta.ts);
    const counts = v.counts ? _graphDiffCountText(v.counts) : "";
    // T365：游标所在行＝「你在这里」（历史行加当前标记、隐藏动作钮）；isLive 行沿用旧样式
    const atCursor = (v.index === graphHistoryCursor) || v.isLive;
    const cls = atCursor ? "graph-history-item current" : "graph-history-item";
    const srcCls = "src-" + ((v.meta && v.meta.source) || "user");
    const previewCls = (graphHistoryPreviewing === v.index) ? " previewing" : "";
    // 每行都能「另开」（4.1）；收藏与「与上一步对比」已随简化批次退役（对比面板内两向切换）
    const forkBtn = '<button type="button" class="graph-history-branch" onclick="forkGraphHistoryVersion(' + v.index + ')"'
      + ' title="从这一步另开一张画布，原画布一字不动">⧉ 另开</button>';
    let actions = '';
    if (!atCursor) {
      actions = '<div class="graph-history-actions">'
        + '<button type="button" onclick="previewGraphVersion(' + v.index + ')">对比</button>'
        + '<button type="button" onclick="jumpGraphVersion(' + v.index + ')">'
        + (v.index >= graphUndoStack.length ? '回到最新' : '回到此版本') + '</button>'
        + forkBtn
        + '</div>';
    } else {
      // 当前行/最新行也允许另开（＝复制此刻这张图）
      actions = '<div class="graph-history-actions graph-history-current-actions">' + forkBtn + '</div>';
    }
    // 未来区段分隔条：游标后第一行之前插入，把「可重做」的未来显式摆出来
    const divider = (v.index === graphHistoryCursor + 1 && futureCount > 0)
      ? '<div class="graph-history-future-divider">以下为未来 · 可重做 ' + futureCount + ' 步</div>'
      : '';
    const cursorTag = (v.index === graphHistoryCursor && !v.isLive)
      ? '<span class="graph-history-badge graph-history-cursor-tag">当前位置</span>' : '';
      return divider + '<div class="' + cls + previewCls + '">'
      + '<div class="graph-history-head"><span class="graph-history-badge ' + srcCls + '">' + label + '</span>'
      + cursorTag
      + '<span class="graph-history-summary">' + summary + '</span>'
      + (counts ? '<span class="graph-history-counts">' + esc(counts) + '</span>' : '')
      + '<span class="graph-history-time">' + time + '</span></div>'
      + actions
      + '</div>';
  }).join('');
  if (graphHistoryLastScrollCursor !== graphHistoryCursor) {
    graphHistoryLastScrollCursor = graphHistoryCursor;
    _scrollGraphHistoryToCurrent();
  }
  _renderGraphHistoryFooter();
}

window.undoGraphAction = _undoGraphAction;
window.redoGraphAction = _redoGraphAction;
window.jumpGraphVersion = _jumpGraphVersion;
window.previewGraphVersion = _previewGraphVersion;
window.exitGraphVersionPreview = exitGraphVersionPreview;
window.openGraphHistoryPanel = openGraphHistoryPanel;
window.toggleGraphHistoryPanel = toggleGraphHistoryPanel;
window.closeGraphHistoryPanel = closeGraphHistoryPanel;
window.getGraphVersionList = _graphVersions;
// 2026-10-24 修改历史增强：差异清单导航 / 两向对比切换（单槽恢复、步进、幽灵、收藏、
// 单节点恢复、排版开关已随同日简化批次退役）
window.focusGraphHistoryDiff = focusGraphHistoryDiff;
window.settleGraphHistoryNow = settleGraphHistoryNow;
window.markGraphHistoryCleanExit = markGraphHistoryCleanExit;
window.settleGraphHistoryOnOpen = settleGraphHistoryOnOpen;
window.getGraphHistoryFingerprint = _graphHistoryExitFingerprint;
window.graphHistoryLiveEventDone = _graphHistoryLiveEventDone;
window.graphEventText = function (text) { return _graphShorten(String(text || ""), 30); };

