// ===== 修改历史：内容投影差异与撤销链（2026-10-24 自 graph.js 拆出，T397 纯搬家）=====
// 投影/差异模型（2026-10-24 R2/R3/R5）、快照口径与 undo/redo/jump；_graphEdgeKeyOf 随唯一
// 调用方 _graphProjectionOf 自持久化件尾部移到本件头部（纯函数声明，跨文件提升安全）。
function _graphEdgeKeyOf(e) {
  // removedEdges 里存的是 _edgeKey 产出的完整字符串（from:port->to:port），
  // connections 里是带 from/to/fromPort/toPort 的对象；统一转成带端口的关键字，
  // 才能与画布 DOM 的 data-edge-key / _edgeKey 匹配。
  if (typeof e === 'string') return e;
  if (e && (e.key || e.edge_key)) return String(e.key || e.edge_key);
  return _edgeKey(e || {});
}

// ===== 内容投影差异（2026-10-24 R2/R3/R5）=====
// 旧口径拿整颗节点 JSON 逐字比：拖动（x/y）、自动整理、生成中的 busy 都会变成
// 「修改节点」，真正的正文改动被噪声淹没；而且只比 state.customNodes，消息派生的
// 回答/模块节点根本不参与（R3）。新口径先把一个版本投影成「用户读得懂的内容」：
//   节点＝id / 类型 / 可读名 / 正文前 64 字 / 内容签名（排除坐标、尺寸、忙闲、时间戳）
//   边＝解析后的边键集合；分组与端口各压一串签名
// 几何差异单独计「仅位置变化」，不进主清单。旧条目没有投影也没有消息时降级为
// 「只比自定义节点」并打 degraded 标——不迁移、不报错（§8 旧数据兼容）。
const GRAPH_PROJ_VIEW_KEYS = {
  x: 1, y: 1, w: 1, h: 1, vx: 1, vy: 1, customWidth: 1, customHeight: 1,
  minimized: 1, pinned: 1, fixedX: 1, fixedY: 1, busy: 1, status: 1,
  depth: 1, targetAngle: 1, angle: 1, generatedAt: 1, analysisHash: 1, inputHash: 1,
  id: 1, timestamp: 1, messageIndex: 1, _patchSig: 1, _proj: 1, nodeSigs: 1,
};
const GRAPH_PROJ_PREVIEW_MAX = 64;

function _graphProjHash(text) {
  let hash = 2166136261;
  const source = String(text == null ? "" : text);
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function _graphShorten(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  return s.slice(0, max) + "…";
}

// 节点可读名（R9）：显式 label/title → 模块中文名 → 正文/摘要前 22 字 → 类型名。
// 提问/回答节点的 label 常为空，旧口径会吐出「节点user-custom-1697…」这种不可读 ID。
const GRAPH_PROJ_KIND_LABELS = {
  user: "提问", answer: "回答", module: "模块", note: "我的总结", summary: "AI 总结",
  human_note: "我的理解", source: "输入", hub: "汇聚", junction: "中转", blank: "AI 节点",
  relation: "联系", draft: "草稿", ai_eval: "评审建议",
};

function _graphNodeLabelOf(node, id) {
  if (!node) return "节点" + String(id || "").slice(0, 8);
  const explicit = String(node.label || node.title || "").trim();
  if (explicit) return _graphShorten(explicit, 22);
  if (node.kind === "module" && node.moduleKey && typeof GRAPH_MODULE_META !== "undefined") {
    const meta = GRAPH_MODULE_META[node.moduleKey];
    if (meta && meta.label) return String(meta.label);
  }
  const text = String(node.content || node.analysis || node.summary || "")
    .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (text) return _graphShorten(text, 22);
  return GRAPH_PROJ_KIND_LABELS[node.kind] || ("节点" + String(id || "").slice(0, 8));
}

function _graphShortList(items) {
  const arr = items.slice(0, 5).map(function (x) { return _graphShorten(x, 12); });
  let s = "「" + arr.join("」「") + "」";
  if (items.length > 5) s += " 等" + items.length + "个";
  return s;
}

// 内容签名：键排序后逐字段序列化，排除纯视图字段；正文另外显式并入（消息派生节点的
// 正文不落在 node.content 上，得由 _nodeContent 算出来再传进来）。
function _graphNodeContentSig(node, text) {
  if (!node) return "";
  const parts = [];
  const keys = Object.keys(node).sort();
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (GRAPH_PROJ_VIEW_KEYS[key]) continue;
    let value = "";
    try { const json = JSON.stringify(node[key]); value = json === undefined ? "" : json; } catch (e) { value = ""; }
    parts.push(key + "=" + value);
  }
  if (text != null) parts.push("__content=" + String(text));
  return _graphProjHash(parts.join("|"));
}

function _graphProjPreview(text) {
  let s = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > GRAPH_PROJ_PREVIEW_MAX) s = s.slice(0, GRAPH_PROJ_PREVIEW_MAX) + "…";
  return s;
}

// 消息派生节点的正文：口径与画布展示一致（_nodeContent），但 overrides 取快照自己的
// state——旧实现读 _graphState() 会拿当前画布的覆盖去比历史版本，比出来的差异是假的。
function _graphProjNodeText(node, message, state) {
  if (message && typeof _nodeContent === "function") {
    try { return String(_nodeContent(message, node, state) || ""); } catch (e) { return ""; }
  }
  return String((node && (node.content || node.analysis || node.summary)) || "");
}

function _graphProjectionOf(state, messages) {
  const safeState = (state && typeof state === "object") ? state : {};
  // _buildGraphData 会往 state.customNodes 里补自动派生的苏格拉底节点并顺手存盘
  // （渲染路径的既有行为）。投影只读：传浅拷贝，存盘用 _graphProjQuiet 掐掉。
  const clone = Object.assign({}, safeState);
  clone.customNodes = Array.isArray(safeState.customNodes) ? safeState.customNodes.map(function (n) { return n; }) : [];
  clone.connections = Array.isArray(safeState.connections) ? safeState.connections.slice() : [];
  const msgs = Array.isArray(messages) ? messages : [];
  let data = { nodes: [], edges: [], nodeById: {} };
  _graphProjQuiet++;
  try { data = _buildGraphData(msgs, clone); }
  catch (e) { data = { nodes: [], edges: [], nodeById: {} }; }
  finally { _graphProjQuiet--; }
  const nodes = {};
  (data.nodes || []).forEach(function (n) {
    if (!n || n.id == null) return;
    const id = String(n.id);
    const msg = (n.messageIndex >= 0 && msgs[n.messageIndex]) ? msgs[n.messageIndex] : null;
    const text = _graphProjNodeText(n, msg, clone);
    nodes[id] = {
      id: id,
      k: String(n.kind || ""),
      l: _graphNodeLabelOf(n, id),
      p: _graphProjPreview(text || n.summary || n.label || ""),
      s: _graphNodeContentSig(n, text),
      v: n.hidden ? 1 : 0,
      m: n.messageIndex >= 0 ? 1 : 0,
      x: Math.round(Number(n.x) || 0),
      y: Math.round(Number(n.y) || 0),
    };
  });
  const edges = [];
  try {
    _resolveGraphEdges(clone, data.edges || [], data.nodeById || {}).forEach(function (e) {
      const key = _graphEdgeKeyOf(e);
      if (key && edges.indexOf(key) < 0) edges.push(key);
    });
  } catch (e) { /* 旧脏数据：边集合留空，节点差异照报 */ }
  edges.sort();
  const groups = (Array.isArray(clone.groups) ? clone.groups : []).map(function (g) {
    return [String(g.id || ""), String(g.name || ""), (Array.isArray(g.nodeIds) ? g.nodeIds.map(String).sort() : []), String(g.color || "")];
  });
  return {
    n: nodes,
    e: edges,
    g: JSON.stringify(groups),
    p: JSON.stringify([clone.portCounts || {}, clone.inputPortCounts || {}]),
  };
}

function _graphVersionProjection(entry) {
  if (!entry) return null;
  if (entry.meta && entry.meta.proj) return entry.meta.proj;
  if (entry._proj) return entry._proj;
  let proj;
  if (Array.isArray(entry.messages)) {
    proj = _graphProjectionOf(entry.state, entry.messages);
  } else {
    // 本功能上线前落盘的旧条目：没有投影、通常也没有消息——只能比自定义节点。
    proj = _graphProjectionOf(entry.state, []);
    proj.degraded = true;
  }
  entry._proj = proj;
  return proj;
}

function _graphVersionProjectionOf(obj) {
  if (!obj) return null;
  if (obj.meta && obj.meta.proj) return obj.meta.proj;
  if (obj.state) return _graphVersionProjection(obj);
  return _graphProjectionOf(obj, []);
}

function _graphLiveProjection() {
  return _graphProjectionOf(_graphState(), typeof _getChatHistory === "function" ? _getChatHistory() : []);
}

// prev → next 的差异。ops 保持旧词表（create_node/delete_node/update_node/add_edge/
// remove_edge），另加 will 字段说明「回到 prev 会怎样」：vanish=会消失、return=会回来、
// change=会改写——面板与描边只认 will，不再让用户自己换算方向（R5）。
function _graphDiffFromProjections(prevProj, nextProj) {
  const a = prevProj || { n: {}, e: [], g: "", p: "" };
  const b = nextProj || { n: {}, e: [], g: "", p: "" };
  const aNodes = a.n || {};
  const bNodes = b.n || {};
  const degraded = !!(a.degraded || b.degraded);
  const ops = [];
  let layoutChanges = 0;
  const ids = {};
  Object.keys(aNodes).forEach(function (id) { ids[id] = true; });
  Object.keys(bNodes).forEach(function (id) { ids[id] = true; });
  Object.keys(ids).forEach(function (id) {
    const pa = aNodes[id];
    const pb = bNodes[id];
    // 降级对比：派生节点在无消息的一侧必然缺席，别把它报成新增/删除。
    if (degraded && ((pa && pa.m) || (pb && pb.m))) return;
    if (!pa) {
      ops.push({ op: "create_node", id: id, label: pb.l, kind: pb.k, preview: pb.p, will: "vanish" });
      return;
    }
    if (!pb) {
      ops.push({ op: "delete_node", id: id, label: pa.l, kind: pa.k, preview: pa.p, will: "return" });
      return;
    }
    if (pa.s !== pb.s) {
      ops.push({ op: "update_node", id: id, label: pb.l || pa.l, kind: pb.k || pa.k, before: pa.p, after: pb.p, will: "change" });
    } else if (pa.x !== pb.x || pa.y !== pb.y) {
      layoutChanges++;
    }
  });
  const aEdges = {};
  (a.e || []).forEach(function (k) { aEdges[k] = true; });
  const bEdges = {};
  (b.e || []).forEach(function (k) { bEdges[k] = true; });
  Object.keys(bEdges).forEach(function (k) { if (!aEdges[k]) ops.push({ op: "add_edge", edge_key: k, will: "vanish" }); });
  Object.keys(aEdges).forEach(function (k) { if (!bEdges[k]) ops.push({ op: "remove_edge", edge_key: k, will: "return" }); });
  if ((a.g || "") !== (b.g || "")) ops.push({ op: "update_groups", label: "分组", will: "change" });
  if ((a.p || "") !== (b.p || "")) ops.push({ op: "update_ports", label: "端口", will: "change" });
  const counts = _graphDiffCounts(ops);
  return {
    ops: ops,
    counts: counts,
    layoutOnly: !ops.length && layoutChanges > 0,
    layoutChanges: layoutChanges,
    degraded: degraded,
    newDeleted: ops.filter(function (o) { return o.op === "delete_node"; }).map(function (o) { return o.id; }),
    unDeleted: ops.filter(function (o) { return o.op === "create_node"; }).map(function (o) { return o.id; }),
    summary: _graphDiffSummary({ ops: ops, layoutChanges: layoutChanges, degraded: degraded }),
  };
}

function _graphDiffCounts(ops) {
  const counts = { vanish: 0, ret: 0, change: 0, addEdge: 0, remEdge: 0 };
  (ops || []).forEach(function (o) {
    if (o.op === "create_node") counts.vanish++;
    else if (o.op === "delete_node") counts.ret++;
    else if (o.op === "update_node" || o.op === "update_groups" || o.op === "update_ports") counts.change++;
    else if (o.op === "add_edge") counts.addEdge++;
    else if (o.op === "remove_edge") counts.remEdge++;
  });
  return counts;
}

function _graphDiffCountText(counts) {
  if (!counts) return "";
  const bits = [];
  if (counts.vanish) bits.push("−" + counts.vanish);
  if (counts.ret) bits.push("+" + counts.ret);
  if (counts.change) bits.push("✎" + counts.change);
  if (counts.addEdge) bits.push("连线−" + counts.addEdge);
  if (counts.remEdge) bits.push("连线+" + counts.remEdge);
  return bits.join(" ");
}

function _graphDiffSummary(diff) {
  const ops = diff.ops || [];
  const created = ops.filter(function (o) { return o.op === "create_node"; }).map(function (o) { return o.label || o.id; });
  const updated = ops.filter(function (o) { return o.op === "update_node"; }).map(function (o) { return o.label || o.id; });
  const deleted = ops.filter(function (o) { return o.op === "delete_node"; }).map(function (o) { return o.label || o.id; });
  const addEdges = ops.filter(function (o) { return o.op === "add_edge"; }).length;
  const remEdges = ops.filter(function (o) { return o.op === "remove_edge"; }).length;
  const groups = ops.some(function (o) { return o.op === "update_groups"; });
  const ports = ops.some(function (o) { return o.op === "update_ports"; });
  const parts = [];
  if (created.length) parts.push("新增节点" + _graphShortList(created));
  if (deleted.length) parts.push("删除节点" + _graphShortList(deleted));
  if (updated.length) parts.push("改写节点" + _graphShortList(updated));
  if (addEdges) parts.push("新增连线" + addEdges + "条");
  if (remEdges) parts.push("删除连线" + remEdges + "条");
  if (groups) parts.push("分组变化");
  if (ports) parts.push("端口变化");
  if (parts.length) return parts.join("；");
  if (diff.layoutChanges) return "仅位置变化";
  return "修改了图";
}

function _diffGraphStates(prev, next) {
  return _graphDiffFromProjections(_graphProjectionOf(prev, []), _graphProjectionOf(next, []));
}

function _diffGraphVersions(prevEntry, nextEntry) {
  return _graphDiffFromProjections(_graphVersionProjectionOf(prevEntry), _graphVersionProjectionOf(nextEntry));
}

function _graphState() {
  if (typeof window.getGraphState === "function") {
    return window.getGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : "");
  }
  return {
    collapsed: {},
    hidden: {},
    positions: {},
    pinned: {},
    sizes: {},
    pan: { x: 80, y: 80 },
    zoom: 0.9,
    layoutVersion: 1,
    connections: null,
    removedEdges: [],
    portCounts: {},
    inputPortCounts: {},
    groups: [],
    customNodes: [],
    harnessDeleted: {},
    harnessCheckpoint: null,
  };
}

// 时间旅行位的第一笔真编辑（1.2/R7）：推送早退后等这次存盘来确认「确实改了内容」，
// 当场截断未来存进单槽——用户改完立刻看到「原来的第 X–Y 步已存起来」。
function _graphHistoryTruncateOnEdit(state) {
  if (!graphHistoryPendingTruncate) return;
  if (graphHistoryCursor >= graphUndoStack.length) { graphHistoryPendingTruncate = false; return; }
  const atCursor = graphUndoStack[graphHistoryCursor];
  if (!atCursor) { graphHistoryPendingTruncate = false; return; }
  let diff = null;
  try { diff = _graphDiffFromProjections(_graphVersionProjection(atCursor), _graphProjectionOf(state, _getChatHistory())); }
  catch (e) { return; }
  if (!diff || !diff.ops.length) return; // 只挪位置/缩放：不算编辑，未来原样保留
  graphHistoryPendingTruncate = false;
  graphHistoryLastEffect = { op: "", touch: "", at: 0 }; // 截断后是新的一条路，连续编辑窗口重开
  // 简化批次（2026-10-24）：被跳过的「未来」直接丢弃（业界惯例），不再存单槽。
  // 想两条线并行的正确姿势＝事前点那一行的「⧉ 另开」，这里 toast 把路指过去。
  const discarded = graphUndoStack.length - (graphHistoryCursor + 1);
  graphUndoStack = graphUndoStack.slice(0, graphHistoryCursor + 1);
  graphHistoryLive = null;
  graphHistoryCursor = graphUndoStack.length;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryLastSignature = "";
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
  if (discarded > 0 && typeof toastMsg === "function") {
    toastMsg("已舍去后面的 " + discarded + " 步 · 想两条线并行，可先在那一行点「⧉ 另开」", 5200);
  }
}

function _saveGraphState(state, opts) {
  if (_graphProjQuiet > 0) return; // 投影构建只读：派生节点的存盘副作用掐掉
  if (graphHistoryPendingTruncate) _graphHistoryTruncateOnEdit(state);
  graphHistoryLiveDirty = true;    // 图真被写过：面板的「当前状态」摘要下次刷新重算
  if (typeof window.saveGraphState === "function") {
    window.saveGraphState(window.getCurrentSessionId ? window.getCurrentSessionId() : "", state, opts);
  }
}

// 一次编辑改的是哪颗节点（T389 合并连续编辑用）：只有「单颗节点的改写/新建」才算
// 可合并的效果；一次动多颗、加删连线、分组/端口变化都返回空——不同性质的动作绝不合并。
function _graphHistoryEffectOf(diff, at) {
  const ops = (diff && diff.ops) || [];
  const op = ops.length === 1 ? ops[0] : null;
  if (op && (op.op === "update_node" || op.op === "create_node") && op.id) {
    return { op: op.op, touch: String(op.id), at: at };
  }
  return { op: "", touch: "", at: at };
}

function _pushGraphUndo(withMessages, meta) {
  if (meta && meta.layout === true) return;
  const state = _graphState();
  if (!state) return;
  _ensureGraphHistory();
  const sid = _currentSessionId();
  const now = Date.now();
  const explicitMeta = (meta && typeof meta === "object" && (meta.summary || meta.source))
    ? { source: meta.source || "user", summary: String(meta.summary || "修改"), ts: now, pushedAt: now }
    : null;
  const carried = graphPendingLiveMeta; // 上一个动作（提问/重生成/Φ）的描述
  // 本次动作的描述挂在「当前状态」行（3.1）：动作才开始，还没形成新版本；条目自己的
  // 摘要仍由自动差异生成。早退分支也先挂上——点了提问至少当前行能看到「提问：…」。
  graphPendingLiveMeta = explicitMeta;
  const snapshot = {
    sessionId: sid,
    state: JSON.parse(JSON.stringify(state)),
    messages: null,
    meta: null,
    _proj: null,
  };
  const chat = typeof window.getChatHistory === "function" ? window.getChatHistory() : [];
  if (withMessages) snapshot.messages = JSON.parse(JSON.stringify(chat));
  // 投影在推送时定格（2.1/R3）：快照只存图状态，消息派生的节点不在里面；此刻消息
  // 还没被这次编辑改写，正好是快照对应那一版的内容。持久化时随 meta 落盘。
  snapshot._proj = _graphProjectionOf(snapshot.state, chat);
  const last = graphUndoStack[graphUndoStack.length - 1];
  if (last && last.sessionId && sid && last.sessionId !== sid) {
    graphUndoStack = [];
    graphHistoryCursor = 0;
    graphHistoryLive = null;
  }
  let discardedSteps = 0;
  // T365 游标在历史中位（时间旅行后落新编辑）：被跳过的「未来」在此截断（业界惯例，
  // 面板会有截断提示）。但无变化／纯布局漂移的推送不算编辑——照旧早退，未来版本
  // 原样保留（与 live 位「值未变不记」同一口径，不许因误触推送白丢重做链）。
  if (graphHistoryCursor < graphUndoStack.length) {
    const atCursor = graphUndoStack[graphHistoryCursor];
    const ttMessagesSame = JSON.stringify(atCursor.messages || null) === JSON.stringify(snapshot.messages || null);
    const ttDiff = _diffGraphVersions(atCursor, snapshot);
    // 推送在编辑之前：内容投影没变（含纯布局漂移——恢复固定「保留当前排版」后 state
    // 的视图字段与游标条目天然不同，判据必须是投影而不是裸 state 全等）＝还没改。
    // 先挂「待截断」，等存盘确认内容真的变了再截断——不能凭无变化推送白丢重做链（T365）。
    if (ttMessagesSame && !ttDiff.ops.length) { graphHistoryPendingTruncate = true; return; }
    graphHistoryPendingTruncate = false;
    // 简化批次（2026-10-24）：被跳过的「未来」直接丢弃，收尾 toast 指路「⧉ 另开」
    discardedSteps = graphUndoStack.length - (graphHistoryCursor + 1);
    graphUndoStack = graphUndoStack.slice(0, graphHistoryCursor + 1);
    graphHistoryLive = null;
  }
  const last2 = graphUndoStack[graphUndoStack.length - 1];
  // 同异比对要连 messages 一起看。messageIndex≥0 的模块节点编辑只写回 msg.content、
  // 图状态一字未动，此前只比 state，整次编辑被判重吞掉——历史面板看不到条目、Ctrl+Z
  // 也恢复不了（2026-10-16 用户实测「编辑节点内容不进修改历史」）。反向同样成立：
  // 消息编辑之后紧接一次状态编辑（推送发生在变更前，两者 state 同为变更前那份），只看
  // state 会把后者也吞掉。带 messages 的快照与不带的之间按「不可证同」处理（旧持久化
  // 格式不进 messages、读回是 undefined；T353 起增量重建让读回条目也带 messages，
  // 比对随之更准），宁多记不漏记。
  const messagesSame = !last2 || last2.sessionId !== snapshot.sessionId
    || JSON.stringify(last2.messages || null) === JSON.stringify(snapshot.messages || null);
  let diff = null;
  if (last2 && last2.sessionId === snapshot.sessionId) {
    diff = _diffGraphVersions(last2, snapshot);
    // 内容投影没变（含纯布局漂移、以及「保留当前排版」带来的视图字段差）＝这一笔
    // 不算版本：直接忽略，保持栈顶为“上次编辑前”的完整快照。消息单独变了不算没变
    // （messagesSame 拦着），消息派生节点的内容差异会出现在投影 ops 里。
    if (!diff.ops.length && messagesSame) return;
  }
  // ===== T389 合并连续编辑（4.3）=====
  // 推送发生在编辑之前，所以这个 diff 描述的是「上一次编辑」的效果，而 lastEffect 记的是
  // 再上一条的效果：两笔都落在同一颗节点、且间隔 ≤1.2s，就把这一次推送并进上一步——
  // 连续输入不再一个字符一条历史。合并后把锚点的时刻推到本次（滑动窗口），所以整段
  // 连续输入只占一步；换了节点、隔了 1.2s 或夹了 AI/Φ 动作就自动断开。
  // 注：第一笔编辑仍留一步（推送时还不知道这一笔会改哪颗），其后同节点的连续改动并进
  // 上一步——面板里表现为「改一次 + 余下全算一次」，而不是每个字符一行。
  const effect = _graphHistoryEffectOf(diff, now);
  const mergeAi = !!((carried && (carried.source === "ai" || carried.source === "harness"))
    || (meta && (meta.source === "ai" || meta.source === "harness")));
  if (last2 && effect.op === "update_node" && effect.touch
    && graphHistoryLastEffect.touch === effect.touch
    && now - graphHistoryLastEffect.at <= GRAPH_HISTORY_MERGE_MS
    && !mergeAi && !graphHistoryPendingTruncate) {
    graphHistoryLastEffect = effect;
    last2.meta.pushedAt = now;
    graphHistoryLiveDirty = true;
    graphHistoryLiveMetaCache = null;
    _persistGraphHistory();
    _refreshGraphHistoryPanel();
    return;
  }
  graphHistoryLastEffect = effect;
  let source = "user";
  let summary = "";
  if (last2) {
    if (!diff) diff = _diffGraphVersions(last2, snapshot);
    if (!messagesSame && !diff.ops.length && meta && meta.summary) {
      // 纯消息编辑（图状态一字未动，投影 diff 一个 op 都没有）：摘要只能取自调用点，
      // 否则条目挂一句「修改了图」，用户在历史面板里看不出改了什么
      summary = String(meta.summary);
      source = (meta && meta.source) || (carried && carried.source) || "user";
    } else {
      summary = diff.summary;
      // 形成这个状态的上一动作是谁：AI 提问/重生成、Φ 改图、还是手动
      const prevSource = (carried && carried.source) || "user";
      if (diff.ops.length && (prevSource === "harness" || prevSource === "ai")) source = prevSource;
    }
  } else {
    summary = "初始状态";
    source = "init";
  }
  // 3.3 时间与摘要对齐：这一版是上一个动作启动时开始形成的，行的时间就用上一个
  // 动作的启动时间（旧口径用本次推送时间，行时间与行摘要总差一步——R1b）。
  const formedAt = (last2 && last2.meta && (last2.meta.pushedAt || last2.meta.ts)) || now;
  snapshot.meta = { source: source, summary: summary, ts: formedAt, pushedAt: now };
  if (diff) snapshot.meta.counts = diff.counts;
  snapshot.meta.proj = snapshot._proj;
  graphUndoStack.push(snapshot);
  if (graphUndoStack.length > GRAPH_UNDO_LIMIT) {
    // 简化批次（2026-10-24）：起名收藏退役，挤出＝最老的先走（勿回填收藏择优逻辑）。
    graphUndoStack.splice(0, 1);
    graphHistoryDropped++;
  }
  // T365：新编辑落定即停在最新位；时间旅行分支截断掉的「未来」到此正式丢弃
  graphHistoryCursor = graphUndoStack.length;
  graphHistoryLive = null;
  graphHistoryPendingTruncate = false;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
  if (discardedSteps > 0 && typeof toastMsg === "function") {
    toastMsg("已舍去后面的 " + discardedSteps + " 步 · 想两条线并行，可先在那一行点「⧉ 另开」", 5200);
  }
}

// 恢复排版（T389 4.3 引入开关，简化批次固定为常开）：恢复只换内容——两边都有的节点
// 留在当前位置，只在历史里有的节点保留它当年的坐标（否则会叠在一起）。别改回
// 「按历史整张还原排版」：恢复时整图坐标乱跳是用户实测的主要困惑。
function _graphHistoryKeepCurrentLayout(state) {
  const cur = _graphState();
  if (!cur) return state;
  const merged = Object.assign({}, state);
  merged.positions = Object.assign({}, state.positions || {}, cur.positions || {});
  merged.sizes = Object.assign({}, state.sizes || {}, cur.sizes || {});
  if (cur.pan && typeof cur.pan === "object") merged.pan = Object.assign({}, cur.pan);
  if (Number.isFinite(Number(cur.zoom))) merged.zoom = cur.zoom;
  return merged;
}

async function _restoreGraphVersion(snapshot) {
  // 撤销/重做/跳转都从这里过：换了一条路，连续编辑的合并窗口重开
  graphHistoryLastEffect = { op: "", touch: "", at: 0 };
  graphView.selectMode = false;
  _applyGraphTextSelectionMode();
  graphView.selectedNodeIds = new Set();
  graphView.selectedGroupIds = new Set();
  if (snapshot.messages && typeof window.replaceChatHistory === "function") {
    await window.replaceChatHistory(snapshot.messages);
  }
  if (snapshot.state) {
    // T275：快照可能在生成进行中被拍下（busy 已随 _saveCustomNodes 持久化），
    // 事后回放会让转圈复活——落盘前洗一次。同页生成仍在跑时回放会提前摘转圈，
    // 可接受：生成结果照常经 _findGraphNode 落到节点上。
    let restoredState = {
      ...snapshot.state,
      customNodes: _sanitizeStaleBusyCustomNodes(snapshot.state.customNodes),
    };
    // 恢复只换内容，节点/视口留在当前位置（原排版开关已固定为常开）
    restoredState = _graphHistoryKeepCurrentLayout(restoredState);
    _saveGraphState(restoredState);
    if (typeof window.flushGraphStateServerSave === "function") window.flushGraphStateServerSave();
  }
  renderGraphCanvas();
  if (typeof window.clearGraphDiffHighlights === "function") window.clearGraphDiffHighlights();
}

// _captureGraphLiveMeta（T365）：离开 live 位（撤销/回退）前把当前状态锚在历史顶，
// 作为「最新」一格留给人/面板/持久化——这是重做链不再随刷新蒸发的前提。
function _captureGraphLive(sid) {
  const liveState = _graphState();
  graphHistoryLive = {
    sessionId: sid,
    state: liveState ? JSON.parse(JSON.stringify(liveState)) : null,
    messages: typeof window.getChatHistory === "function" ? JSON.parse(JSON.stringify(window.getChatHistory())) : null,
    meta: { source: "now", summary: "最新状态", ts: Date.now() },
  };
}

async function _undoGraphAction() {
  _ensureGraphHistory();
  const currentSessionId = _currentSessionId();
  if (graphHistoryCursor <= 0) return;
  const target = graphUndoStack[graphHistoryCursor - 1];
  if (!target) return;
  if (target.sessionId && currentSessionId && target.sessionId !== currentSessionId) return;
  if (graphHistoryCursor >= graphUndoStack.length) _captureGraphLive(currentSessionId);
  graphHistoryCursor--;
  graphPendingLiveMeta = null;
  graphHistoryPendingTruncate = false;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
  await _restoreGraphVersion(target);
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

async function _redoGraphAction() {
  _ensureGraphHistory();
  const currentSessionId = _currentSessionId();
  if (graphHistoryCursor >= graphUndoStack.length) return;
  const next = graphHistoryCursor + 1;
  const target = next >= graphUndoStack.length ? graphHistoryLive : graphUndoStack[next];
  if (!target) return;
  if (target.sessionId && currentSessionId && target.sessionId !== currentSessionId) return;
  graphHistoryCursor = next;
  graphPendingLiveMeta = null;
  graphHistoryPendingTruncate = false;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
  if (graphHistoryCursor >= graphUndoStack.length) graphHistoryLive = null; // 回到最新，锚点消费掉
  await _restoreGraphVersion(target);
  _persistGraphHistory();
  _refreshGraphHistoryPanel();
}

function _graphVersions() {
  _ensureGraphHistory();
  const sid = _currentSessionId();
  const list = graphUndoStack.map(function (entry, i) {
    return {
      index: i,
      isLive: false,
      state: entry.state,
      messages: entry.messages,
      meta: entry.meta || { source: "user", summary: "", ts: 0 },
      counts: (entry.meta && entry.meta.counts) || null,
      raw: entry,
      sessionId: entry.sessionId,
    };
  });
  if (graphHistoryCursor < graphUndoStack.length) {
    // T365：时间旅行中——历史顶补上「最新状态」锚点行（可重做的未来终点），
    // 游标之后的所有行都属「未来 · 可重做」区段，由面板渲染层分组
    const liveMeta = (graphHistoryLive && graphHistoryLive.meta)
      ? graphHistoryLive.meta
      : { source: "now", summary: "最新状态", ts: Date.now() };
    list.push({
      index: graphUndoStack.length,
      isLive: false,
      state: graphHistoryLive ? graphHistoryLive.state : null,
      messages: graphHistoryLive ? graphHistoryLive.messages : null,
      meta: liveMeta,
      counts: null,
      raw: graphHistoryLive,
      sessionId: sid,
    });
    return list;
  }
  // 当前状态行：T219/R9——过去每 800ms 做一次全图深比较。现在只有图真被写过
  // （_saveGraphState / 推送 / 时间旅行）才重算，其余时候吃缓存。
  let liveMeta = graphPendingLiveMeta;
  let liveCounts = (graphPendingLiveMeta && graphPendingLiveMeta.counts) || null;
  if (!liveMeta) {
    if (graphHistoryLiveDirty || !graphHistoryLiveMetaCache) {
      graphHistoryLiveDirty = false;
      let computed = null;
      const last = graphUndoStack[graphUndoStack.length - 1];
      if (last) {
        const diff = _graphDiffFromProjections(_graphVersionProjection(last), _graphLiveProjection());
        if (!diff.layoutOnly) {
          computed = { meta: { source: "user", summary: diff.summary, ts: Date.now() }, counts: diff.counts };
        }
      }
      graphHistoryLiveMetaCache = computed || { meta: null, counts: null };
    }
    liveMeta = graphHistoryLiveMetaCache.meta;
    liveCounts = graphHistoryLiveMetaCache.counts;
  }
  if (!liveMeta) liveMeta = { source: "now", summary: "当前状态", ts: Date.now() };
  list.push({
    index: graphUndoStack.length,
    isLive: true,
    state: null,
    messages: null,
    meta: liveMeta,
    counts: liveCounts,
    raw: null,
    sessionId: sid,
  });
  return list;
}

async function _jumpGraphVersion(versionIndex) {
  _ensureGraphHistory();
  const currentSessionId = _currentSessionId();
  if (versionIndex === graphHistoryCursor) return;
  if (versionIndex < 0 || versionIndex > graphUndoStack.length) return;
  // T365 非破坏跳转：只挪游标，一条历史都不删——被跳过的版本常驻面板「未来」区段，
  // 随时可以重做回来（或经「回到最新」一键返回）。跳转后落新编辑才截断（_pushGraphUndo）。
  let target;
  const goingBack = versionIndex < graphUndoStack.length;
  if (goingBack) {
    target = graphUndoStack[versionIndex];
  } else {
    // 点「最新状态」行＝撤销刚才的回退（time-travel 回 live 位）
    target = graphHistoryLive;
    if (!target) return;
  }
  if (target.sessionId && currentSessionId && target.sessionId !== currentSessionId) return;
  if (goingBack && graphHistoryCursor >= graphUndoStack.length) _captureGraphLive(currentSessionId);
  graphHistoryCursor = versionIndex;
  if (!goingBack) graphHistoryLive = null; // 回到最新＝锚点消费掉
  graphPendingLiveMeta = null;
  graphHistoryLiveDirty = true;
  graphHistoryLiveMetaCache = null;
  graphHistoryPreviewing = -1;
  graphHistoryDiffSummary = "";
  await _restoreGraphVersion(target);
  _persistGraphHistory();
  if (goingBack && typeof toastMsg === "function") {
    toastMsg("已回到「" + ((target.meta && target.meta.summary) || "历史版本") + "」· 按 Ctrl+Y 或点「最新状态」可回来");
  }
  _refreshGraphHistoryPanel();
}

