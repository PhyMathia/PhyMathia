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
// T432（2026-11-05）：只在「内存账本＝当前视图」时结算——人切走了的话 last 与
// _graphLiveProjection() 根本不是同一张画布，diff 出来的计数是垃圾；此时什么都不动，
// 发起会话槽里的挂起元数据原样保留（人回来后面板照样读得到，计数晚一步无妨）。
function _graphHistoryLiveEventDone() {
  if (graphHistorySession && _currentSessionId() && graphHistorySession !== _currentSessionId()) return;
  const pending = _graphPendingLiveMetaOf(graphHistorySession);
  if (!pending) return;
  const last = graphUndoStack[graphUndoStack.length - 1];
  if (last) {
    const diff = _graphDiffFromProjections(_graphVersionProjection(last), _graphLiveProjection());
    if (!diff.layoutOnly) _graphPendingLiveMetaSet(graphHistorySession, Object.assign({}, pending, { counts: diff.counts }));
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
    ? "第 " + (versionIndex + 1) + " 步改了什么：" + model.diff.summary
    : "回到第 " + (versionIndex + 1) + " 步会怎样：" + model.diff.summary;
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

// T219 补刀：footer 的「上次灌进去的 HTML」。预览态下 800ms 一拍都会走到
// _renderGraphHistoryFooter——内容没变就别整份重灌（打断文本选中、白付一次重排）。
let graphHistoryFooterLastHtml = "";

function _renderGraphHistoryFooter() {
  const footer = document.getElementById("graphHistoryDiffText");
  if (!footer) return;
  if (graphHistoryPreviewing < 0 || !graphHistoryDiffModel) {
    if (graphHistoryFooterLastHtml !== '') { graphHistoryFooterLastHtml = ''; footer.innerHTML = ''; }
    return;
  }
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  const model = graphHistoryDiffModel;
  const counts = model.counts || {};
  const step = model.dir === "step";
  const cntLabel = function (will) { return _graphDiffWillLabel(will, model.dir); };
  // 头部说人话（2026-11-15）：主标题只认步序号「对比：第 N 步」，版本的时间＋摘要
  // 降为副标题；方向由底部分段胶囊与计数措辞表达，不再挤进标题长句。
  const title = '对比：第 ' + (model.index + 1) + ' 步';
  const head = '<div class="graph-history-diff-head">'
    + '<div class="graph-history-diff-title">' + title + '</div>'
    + '<div class="graph-history-diff-counts">'
    + '<span class="g-hd-count will-vanish">' + cntLabel('vanish') + ' ' + (counts.vanish || 0) + '</span>'
    + '<span class="g-hd-count will-return">' + cntLabel('return') + ' ' + (counts.ret || 0) + '</span>'
    + '<span class="g-hd-count will-change">' + cntLabel('change') + ' ' + (counts.change || 0) + '</span>'
    + '</div>'
    + '<div class="graph-history-diff-sub">' + esc(_graphHistoryVersionTitle(model)) + '</div>'
    + '</div>';
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
  // 底部固定操作条（2026-11-15）：两向切换改分段胶囊（T451 自绘分段同款语言），
  // 主按钮「回到这一步」accent 实底突出，「退出对比」次级。函数与 onclick 全沿用。
  const stepDisabled = model.index < 1 ? ' disabled title="第一步没有更早版本"' : '';
  const actions = '<div class="graph-history-diff-actions">'
    + '<div class="g-hd-seg" role="group" aria-label="对比方向">'
    + '<button type="button" class="g-hd-dir' + (step ? '' : ' active') + '" onclick="setGraphHistoryCompareDir(\'back\')">回到这里会怎样</button>'
    + '<button type="button" class="g-hd-dir' + (step ? ' active' : '') + '"' + stepDisabled + ' onclick="setGraphHistoryCompareDir(\'step\')">这一步改了什么</button>'
    + '</div>'
    + '<div class="g-hd-actions-row">'
    + '<button type="button" class="g-hd-jump" onclick="jumpGraphVersion(' + model.index + ')">回到这一步</button>'
    + '<button type="button" class="graph-history-exit-preview" onclick="exitGraphVersionPreview()">✕ 退出对比</button>'
    + '</div></div>';
  const html = head + legend + list + actions;
  if (html === graphHistoryFooterLastHtml) return;
  graphHistoryFooterLastHtml = html;
  footer.innerHTML = html;
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

// 日期感知时间（2026-11-15 表达层重做）：今天 HH:MM:SS／昨天 HH:MM／更早 MM-DD HH:MM。
// 旧版只有 HH:MM:SS，跨天的步骤分不清是哪天；行时间仍是「形成这一版的上一动作启动
// 时间」（3.3 口径不变），这里只改展示格式。时钟偏差导致的「未来」时间按今天读。
function _graphHistoryTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = function (n) { return n < 10 ? "0" + n : String(n); };
  const dayStart = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
  const days = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  const hm = pad(d.getHours()) + ":" + pad(d.getMinutes());
  if (days <= 0) return hm + ":" + pad(d.getSeconds());
  if (days === 1) return "昨天 " + hm;
  return pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + hm;
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
      + '<button type="button" class="graph-history-settle" onclick="requestGraphHistoryClear(event)" title="清空历史，图保留">清空历史</button>'
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
  disarmGraphHistoryClear();   // 确认态不跨次打开残留（2026-11-15）
}

// ===== 退出结算（1.3 / §6）：正常关闭只写标记，下次打开时结算 =====
// 仓库既有拍板（session.js）：清理点不放在 beforeunload——崩溃/强杀不触发。所以这里
// 只落一个轻量标记（条数＋末条时间戳＋游标），下次打开对指纹、看是不是刷新、看当时
// 是不是停在最新，全部对上才清。宁可留着，不清错。
function _graphHistoryExitKeyFor(sid) {
  return GRAPH_HISTORY_EXIT_KEY + (sid || "default");
}

// 全局 sweep 标记（2026-11-18）：每个画布各自的退出标记只结算"最后打开那一张"，其余画布
// 的历史键永远清不到（本机实测 22 键 / 6.37 MB 存量）。正常退出时再写这一个全局标记，
// 下次打开据此批量清所有带标记的画布。存在 localStorage 键 phymathia_graph_history_sweep，
// 值是一批 sid 的数组。F5 刷新会在结算侧作废它；强杀/崩溃不发 beforeunload → 标记不写。
const GRAPH_HISTORY_SWEEP_KEY = "phymathia_graph_history_sweep";
function _graphHistorySweepRead() {
  try {
    const raw = localStorage.getItem(GRAPH_HISTORY_SWEEP_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    return Array.isArray(arr) ? arr.filter(Boolean) : [];
  } catch (e) { return []; }
}
function _graphHistorySweepWrite(sids) {
  try { localStorage.setItem(GRAPH_HISTORY_SWEEP_KEY, JSON.stringify(sids || [])); } catch (e) { /* 配额异常不阻断退出 */ }
}
function _graphHistorySweepClear() {
  try { localStorage.removeItem(GRAPH_HISTORY_SWEEP_KEY); } catch (e) { /* best effort */ }
}

// 502 兜底用（2026-11-18）：探测 localStorage 此刻还写不写得进。写得进＝退出侧的名单
// 写入当时也写得进（关机期间存储不会自己变少）＝名单空是真的（强杀/崩溃），维持不清；
// 写不进＝配额已满，名单多半是退出时写失败丢的（「越满越清不动」自锁）——调用侧据此
// 绕过名单全量清。探测键特意避开 phymathia_graph_history_ 前缀，不会被历史扫描误伤。
function _graphHistoryQuotaProbe() {
  const PROBE_KEY = "phymathia_storage_probe";
  try {
    localStorage.setItem(PROBE_KEY, "1");
    localStorage.removeItem(PROBE_KEY);
    return true;
  } catch (e) {
    try { localStorage.removeItem(PROBE_KEY); } catch (e2) { /* 残留也无关紧要 */ }
    return false;
  }
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
    // 2026-11-18：把本次正常退出的画布登记进全局 sweep 名单（去重、保留顺序）。
    // 下次打开时 settleGraphHistoryBatchOnOpen 据此批量清所有画布，而不只最后那一张。
    const sweep = _graphHistorySweepRead();
    if (sweep.indexOf(sid) < 0) { sweep.push(sid); _graphHistorySweepWrite(sweep); }
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
  _graphPendingLiveMetaSet(graphHistorySession, null);
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
  _graphPendingLiveMetaSet(sid, null);
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

// 2026-11-18 退出后批量结算（v2，全量扫描回收存量）：
// 原 v1 只清 sweep 名单里登记的 sid，但名单由 markGraphHistoryCleanExit 在 beforeunload
// 写入、只登记"关闭瞬间正打开的那一张"（本机实测 22 键 / 6.37 MB 存量，其余 21 张从没
// 进过名单，也没有 per-sid 标记）→ v1 对存量一张都清不到。v2 改为：名单"非空"即代表
// "上次是正常退出"（只有 beforeunload 会写它），此时全量枚举所有历史键、清掉除当前画布
// 外的全部，不再逐个依赖名单内容／per-sid 标记。撤销历史是过程快照，正常退出即可回收，
// 画布内容／对话／图状态都原样保留。守卫口径：
//   · F5 刷新（nav=reload）：名单作废，一张不清（刷新不该丢撤销）；
//   · 强杀/崩溃：不发 beforeunload → 名单不写 → 下次打开名单为空 → 不清；
//   · 配额满自锁兜底（502，2026-11-18）：名单空且写入探测失败 → 绕过名单全量清
//     （连 F5 也清，牺牲 F5 守卫已拍板——解锁比守卫重要，清一次下次即恢复）；
//   · 只读态：不清且不消费名单（免得查阅态把别人的清理标记吃掉）；
//   · 当前画布：跳过，留给 settleGraphHistoryOnOpen 做指纹校验的精细结算。
// 名单消费（2026-11-18 复审修正）：不再无条件先清空。内核 _batchDiscardGraphHistories
// 只有 DELETE 成功才删本地键（失败则原样保留），这里据此决定是否消费名单——全部删成功
// 才清空；有失败就保留名单，下次启动的全量扫描会把残留的键再纳入重试，避免"删失败+
// 名单已消费"导致服务端旧栈复活且再也扫不到的死局。
async function settleGraphHistoryBatchOnOpen() {
  if (typeof phyIsReadonly === "function" && phyIsReadonly()) return 0;
  const nav = _graphHistoryNavType();
  const sids = _graphHistorySweepRead();
  // 502 兜底（2026-11-18 拍板）：名单空通常＝上次非正常退出，不清；但配额满时退出侧的
  // 名单写入本身会失败（catch 吞掉），「越满越清不动」自锁——恰是存储最满、最该清的
  // 时候清不动。探测写得进＝名单空是真的（强杀/崩溃），维持不清；探测失败＝配额已满，
  // 绕过名单直接全量清。此路径连 F5 也清（牺牲 F5 守卫已拍板）：清一次即解锁，
  // 下次刷新恢复正常守卫。
  const bypassList = !sids.length && !_graphHistoryQuotaProbe();
  if (nav === "reload" && !bypassList) { _graphHistorySweepClear(); return 0; }
  if (!sids.length && !bypassList) return 0; // 名单为空＝上次非正常退出，什么都不清
  const current = _currentSessionId();
  if (!current) return 0; // 503：排除集失效，宁可不清（纯理论边界）
  const HIST_PREFIX = "phymathia_graph_history_";
  const targets = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || key.indexOf(HIST_PREFIX) !== 0) continue;
      // exit_ 标记键与 sweep 名单键同前缀，排除；只认真正的历史载荷键
      if (key.indexOf(GRAPH_HISTORY_EXIT_KEY) === 0 || key === GRAPH_HISTORY_SWEEP_KEY) continue;
      const sid = key.slice(HIST_PREFIX.length);
      if (!sid || sid === current) continue;
      targets.push(sid);
    }
  } catch (e) { return 0; } // 枚举失败：宁可不清，保留名单待下次重试，绝不误伤
  if (!targets.length) { _graphHistorySweepClear(); return 0; } // 无可清键＝任务完成，消费名单
  if (typeof window._batchDiscardGraphHistories !== "function") return 0; // 内核缺席：保留名单
  let cleared = 0;
  try { cleared = await window._batchDiscardGraphHistories(targets); }
  catch (e) { return 0; } // 执行异常：保留名单待下次重试
  if (cleared >= targets.length) _graphHistorySweepClear(); // 全删成功才消费；有失败则保留重试
  return cleared;
}

// 面板里的手动口（§6.1.4「定稿并清空历史」）：随时可清，和自动结算走同一条路。
async function settleGraphHistoryNow() {
  if (typeof phyIsReadonly === "function" && phyIsReadonly()) {
    if (typeof phyReadonlyBlock === "function") phyReadonlyBlock("清空修改历史");
    return false;
  }
  return _settleClearGraphHistory("历史已清空（定稿）· 当前图状态保留");
}

// ===== 「清空历史」内联二次确认（2026-11-15 表达层重做，仿 Φ 清空对话条 T92/T118）=====
// armed 态由变量持有（不只活 DOM）：面板重渲染/切画布不会把确认态冲掉；armed 期间
// 换了画布立即解除——确认态不许跨画布误清。settleGraphHistoryNow 内核一字不动，
// 冒烟直接调内核的用例保持绿；包装只管「点两下才真清」的表达层。
let graphHistoryClearArmed = false;
let graphHistoryClearArmTimer = null;
let graphHistoryClearArmedSid = "";

function _renderGraphHistorySettleBtn() {
  // 只改真 DOM 里的按钮：冒烟沙箱里面板是宽松代理，querySelector 不存在或返回 null，
  // nodeType 守卫直接跳过（Φ 同款）；armed 变量照常驱动两步逻辑。
  const btn = (graphHistoryPanel && typeof graphHistoryPanel.querySelector === "function")
    ? graphHistoryPanel.querySelector(".graph-history-settle") : null;
  if (!btn || btn.nodeType !== 1) return;
  if (graphHistoryClearArmed) {
    btn.classList.add("armed");
    btn.textContent = "再点一次确认清空";
    btn.title = "再点一次确认";
  } else {
    btn.classList.remove("armed");
    btn.textContent = "清空历史";
    btn.title = "清空历史，图保留";
  }
}

function disarmGraphHistoryClear() {
  graphHistoryClearArmed = false;
  graphHistoryClearArmedSid = "";
  if (graphHistoryClearArmTimer) { clearTimeout(graphHistoryClearArmTimer); graphHistoryClearArmTimer = null; }
  _renderGraphHistorySettleBtn();
}

// onclick 包装：第一下武装（按钮变红、4 秒不点自动解除），第二下才真清。
function requestGraphHistoryClear(event) {
  if (event && typeof event.stopPropagation === "function") event.stopPropagation();
  if (!graphHistoryClearArmed) {
    graphHistoryClearArmed = true;
    graphHistoryClearArmedSid = graphHistorySession || _currentSessionId();
    _renderGraphHistorySettleBtn();
    if (graphHistoryClearArmTimer) clearTimeout(graphHistoryClearArmTimer);
    graphHistoryClearArmTimer = setTimeout(disarmGraphHistoryClear, 4000);
    return false;
  }
  disarmGraphHistoryClear();
  return settleGraphHistoryNow();
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

// comparing 类（2026-11-15）：进入对比后列表收成顶部窄条、差异区接管剩余高度（CSS 负责）。
// className 整串写：冒烟沙箱的宽松元素没有 classList，字符串比较两边都稳。
function _syncGraphHistoryPanelMode() {
  if (!graphHistoryPanel) return;
  const base = "graph-history-panel aurora-glass aurora-glass--dialog";
  const want = (graphHistoryPreviewing >= 0 && graphHistoryDiffModel) ? base + " comparing" : base;
  if (graphHistoryPanel.className !== want) graphHistoryPanel.className = want;
}

function _refreshGraphHistoryPanel() {
  if (!graphHistoryPanel || graphHistoryPanel.hidden) return;
  const versions = _graphVersions();
  // armed 期间换了画布立即解除：确认态不许跨画布误清（_graphVersions 已把内存账本
  // 切到当前会话，这里对的是切换后的 graphHistorySession）
  if (graphHistoryClearArmed && graphHistoryClearArmedSid && graphHistorySession !== graphHistoryClearArmedSid) {
    disarmGraphHistoryClear();
  }
  _syncGraphHistoryPanelMode();
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
  // 说人话（2026-11-15）：「位置 3 / 8」→「第 3 步 · 共 8 步」；空历史读「暂无记录」
  if (posEl) {
    posEl.textContent = graphUndoStack.length
      ? "第 " + (graphHistoryCursor + 1) + " 步 · 共 " + (graphUndoStack.length + 1) + " 步"
      : "暂无记录";
  }
  // 容量提示（4.3）：已记几条、本地存档多大、更早的有多少被挤出
  const capEl = document.getElementById("graphHistoryCap");
  if (capEl) {
    // 简化批次：只说滚出条数（条数/KB 仪表与排版开关已退役）
    capEl.textContent = graphHistoryDropped ? "更早的 " + graphHistoryDropped + " 步已移出" : "";
  }
  if (!listEl) return;
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  // 空历史引导（2026-11-15）：不留白面板——告诉用户记录怎么产生、可以回退。
  // 此时 _graphVersions 仍会补一行「当前状态」，但它没有信息量，用引导整块替掉。
  if (!graphUndoStack.length) {
    listEl.innerHTML = '<div class="graph-history-empty">'
      + '<div class="graph-history-empty-title">还没有修改记录</div>'
      + '<div class="graph-history-empty-text">提问、编辑或让 Φ 改图后，每一步都会记在这里，可随时回退。</div>'
      + '</div>';
    _renderGraphHistoryFooter();
    return;
  }
  const futureCount = graphUndoStack.length - graphHistoryCursor; // 游标之后的可重做步数
  listEl.innerHTML = versions.map(function (v) {
    const label = _graphHistorySourceLabel(v.meta && v.meta.source);
    // 旧数据起的名字照显示（起名收藏已退役）
    const summary = esc((v.meta && (v.meta.name || v.meta.summary)) || "");
    const time = _graphHistoryTime(v.meta && v.meta.ts);
    const counts = v.counts ? _graphDiffCountText(v.counts) : "";
    // T365：游标所在行＝「你在这里」；isLive 行（停在最新时的当前状态行）同样标
    const atCursor = (v.index === graphHistoryCursor) || v.isLive;
    // 未来行（2026-11-15）：游标之后的行整体淡化＋虚线轨道，分隔条说「后面还有 N 步」
    const isFuture = !atCursor && v.index > graphHistoryCursor;
    let cls = "graph-history-item";
    if (atCursor) cls += " current";
    if (isFuture) cls += " future";
    if (graphHistoryPreviewing === v.index) cls += " previewing";
    const srcCls = "src-" + ((v.meta && v.meta.source) || "user");
    // 每行都能「另开」（4.1）；收藏与「与上一步对比」已随简化批次退役（对比面板内两向切换）
    const forkBtn = '<button type="button" class="graph-history-branch" onclick="forkGraphHistoryVersion(' + v.index + ')"'
      + ' title="另开一张画布">⧉ 另开</button>';
    let actions = '';
    if (!atCursor) {
      actions = '<div class="graph-history-actions">'
        + '<button type="button" onclick="previewGraphVersion(' + v.index + ')" title="看看差在哪">对比</button>'
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
      ? '<div class="graph-history-future-divider">后面还有 ' + futureCount + ' 步 · 可重做</div>'
      : '';
    const cursorTag = atCursor
      ? '<span class="graph-history-badge graph-history-cursor-tag">你在这里</span>' : '';
    // 时间线行（2026-11-15）：步序号＋来源徽标＋日期感知时间／两行摘要／计数＋悬停动作。
    // 轨道与圆点由 CSS 伪元素画（::before 竖线、::after 步骤点），不加 DOM。
    return divider + '<div class="' + cls + '">'
      + '<div class="graph-history-head">'
      + '<span class="graph-history-step">第 ' + (v.index + 1) + ' 步</span>'
      + '<span class="graph-history-badge ' + srcCls + '">' + label + '</span>'
      + cursorTag
      + '<span class="graph-history-time">' + time + '</span></div>'
      + '<div class="graph-history-summary">' + summary + '</div>'
      + '<div class="graph-history-foot">'
      + (counts ? '<span class="graph-history-counts">' + esc(counts) + '</span>' : '')
      + actions
      + '</div></div>';
  }).join('');
  if (graphHistoryLastScrollCursor !== graphHistoryCursor) {
    graphHistoryLastScrollCursor = graphHistoryCursor;
    _scrollGraphHistoryToCurrent();
  }
  _renderGraphHistoryFooter();
}

// Esc（2026-11-15，侧栏多选同款守卫写法）：面板开着时先退对比、再关面板；
// 面板没开不劫持这个键（Esc 在别处还有别的含义），焦点在输入面时让给输入面自己。
document.addEventListener("keydown", function (e) {
  if (e.key !== "Escape" || !graphHistoryPanel || graphHistoryPanel.hidden) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
  e.preventDefault();
  if (graphHistoryPreviewing >= 0) { exitGraphVersionPreview(); return; }
  closeGraphHistoryPanel();
});

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
// 2026-11-15 表达层重做：清空历史的内联二次确认包装（内核 settleGraphHistoryNow 不动）
window.requestGraphHistoryClear = requestGraphHistoryClear;
window.disarmGraphHistoryClear = disarmGraphHistoryClear;
window.markGraphHistoryCleanExit = markGraphHistoryCleanExit;
window.settleGraphHistoryOnOpen = settleGraphHistoryOnOpen;
// 2026-11-18 退出后批量结算：清掉其余画布从没被单画布结算到的历史存量
window.settleGraphHistoryBatchOnOpen = settleGraphHistoryBatchOnOpen;
window._graphHistorySweepRead = _graphHistorySweepRead;
window._graphHistorySweepWrite = _graphHistorySweepWrite;
window._graphHistorySweepClear = _graphHistorySweepClear;
window.getGraphHistoryFingerprint = _graphHistoryExitFingerprint;
window.graphHistoryLiveEventDone = _graphHistoryLiveEventDone;
window.graphEventText = function (text) { return _graphShorten(String(text || ""), 30); };

