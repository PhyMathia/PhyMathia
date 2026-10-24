// ===== 图一致性体检（2026-10-24 自 graph.js 拆出，T397 纯搬家）=====
// 图体检扫描与面板；文末 window 导出块随件。
// ===== 图一致性体检（C） =====
let graphConsistencyPanel = null;
let graphConsistencyTarget = "";

function _scanGraphConsistency() {
  const issues = [];
  const nodes = (graphView && graphView.nodes) || [];
  const edges = (graphView && graphView.edges) || [];
  const nodeById = {};
  nodes.forEach(function (n) { nodeById[String(n.id)] = n; });
  const incident = {};
  const pushBroken = function (edgeKey, nodeId) {
    if (!nodeId) return;
    const tag = "broken|" + edgeKey + "|" + nodeId;
    if (issues.some(function (i) { return i.type === "broken_edge" && i.nodeId === nodeId; })) return;
    issues.push({ type: "broken_edge", severity: "error", edgeKey: edgeKey, nodeId: nodeId, label: nodeId, message: "连线指向不存在的节点「" + nodeId + "」" });
  };
  edges.forEach(function (e) {
    const from = String(e.from || "");
    const to = String(e.to || "");
    if (from) incident[from] = true;
    if (to) incident[to] = true;
    if (from && !nodeById[from]) pushBroken(e.key || "", from);
    if (to && !nodeById[to]) pushBroken(e.key || "", to);
  });
  const state = _graphState();
  ((state && state.connections) || []).forEach(function (e) {
    const from = String(e.from || "");
    const to = String(e.to || "");
    if (from && !nodeById[from]) pushBroken("", from);
    if (to && !nodeById[to]) pushBroken("", to);
  });
  nodes.forEach(function (n) {
    const id = String(n.id);
    if (n.kind === "blank") return;
    if (incident[id]) return;
    issues.push({ type: "orphan", severity: "warning", nodeId: id, label: String(n.label || n.title || id), message: "节点没有任何连线（孤儿）" });
  });
  // 模块重复按“来源回答（消息索引）+ 模块键”判定：不同回答各自带物理/数学视角不算重复；
  // 自定义模块则额外比较内容，仅内容也相同时才判重复。
  const byModule = {};
  nodes.forEach(function (n) {
    if (n.kind !== "module") return;
    const key = String(n.moduleKey || n.module_key || "").trim();
    if (!key) return;
    const group = n.messageIndex >= 0 ? "msg:" + n.messageIndex : "custom:" + _nodeContentSig(n);
    const gkey = group + "\u0000" + key;
    (byModule[gkey] = byModule[gkey] || []).push(n);
  });
  Object.keys(byModule).forEach(function (gkey) {
    const list = byModule[gkey];
    if (list.length > 1) {
      const key = String(list[0].moduleKey || list[0].module_key || "").trim();
      const isMsg = list[0].messageIndex >= 0;
      const metaLabel = (GRAPH_MODULE_META[key] || {}).label || key;
      issues.push({ type: "duplicate_module", severity: "info", nodeId: String(list[0].id), label: key, message: "存在 " + list.length + " 个" + (isMsg ? "「" + metaLabel + "」模块（同一回答）" : "内容相同的「" + metaLabel + "」模块") });
    }
  });
  return issues;
}

function _consistencySeverityLabel(severity) {
  if (severity === "error") return "断链";
  if (severity === "warning") return "孤儿";
  return "重复";
}

function _clearConsistencyTarget() {
  if (!graphConsistencyTarget) return;
  const el = document.querySelector('[data-node-id="' + graphConsistencyTarget + '"]');
  if (el) el.classList.remove("graph-consistency-target");
  graphConsistencyTarget = "";
}

function openGraphConsistencyPanel() {
  if (!graphConsistencyPanel) {
    graphConsistencyPanel = document.createElement("div");
    graphConsistencyPanel.className = "graph-consistency-panel aurora-glass aurora-glass--dialog";
    graphConsistencyPanel.innerHTML = ''
      + '<div class="graph-consistency-head"><span class="graph-consistency-title">图体检</span>'
      + '<button type="button" class="graph-consistency-close" onclick="closeGraphConsistencyPanel()" aria-label="关闭">✕</button></div>'
      + '<div class="graph-consistency-tools">'
      + '<button type="button" onclick="refreshGraphConsistency()">重新体检</button>'
      + '</div>'
      + '<div class="graph-consistency-summary" id="graphConsistencySummary"></div>'
      + '<div class="graph-consistency-list" id="graphConsistencyList"></div>';
    document.body.appendChild(graphConsistencyPanel);
  }
  graphConsistencyPanel.hidden = false;
  _refreshGraphConsistencyPanel();
}

function toggleGraphConsistencyPanel() {
  if (graphConsistencyPanel && !graphConsistencyPanel.hidden) { closeGraphConsistencyPanel(); return; }
  openGraphConsistencyPanel();
}
function closeGraphConsistencyPanel() {
  if (graphConsistencyPanel) graphConsistencyPanel.hidden = true;
  _clearConsistencyTarget();
}

function _refreshGraphConsistencyPanel() {
  if (!graphConsistencyPanel || graphConsistencyPanel.hidden) return;
  const issues = _scanGraphConsistency();
  const summaryEl = document.getElementById("graphConsistencySummary");
  const listEl = document.getElementById("graphConsistencyList");
  if (!summaryEl || !listEl) return;
  const errors = issues.filter(function (i) { return i.severity === "error"; }).length;
  const warnings = issues.filter(function (i) { return i.severity === "warning"; }).length;
  const infos = issues.length - errors - warnings;
  summaryEl.textContent = issues.length ? "发现 " + issues.length + " 个问题（断链 " + errors + " / 孤儿 " + warnings + " / 重复 " + infos + "），点击条目可定位" : "一切正常，没有发现问题";
  summaryEl.className = "graph-consistency-summary" + (errors ? " has-error" : (issues.length ? " has-warning" : " ok"));
  const esc = typeof window.escapeHtml === "function" ? window.escapeHtml : function (s) { return String(s); };
  listEl.innerHTML = issues.map(function (issue, idx) {
    const label = _consistencySeverityLabel(issue.severity);
    return '<div class="graph-consistency-item sev-' + issue.severity + '" onclick="focusConsistencyIssue(' + idx + ')">'
      + '<span class="graph-consistency-badge">' + label + '</span>'
      + '<span class="graph-consistency-msg">' + esc(issue.message) + '</span>'
      + '</div>';
  }).join("");
}

function focusConsistencyIssue(index) {
  const issues = _scanGraphConsistency();
  const issue = issues[index];
  if (!issue) return;
  _clearConsistencyTarget();
  graphConsistencyTarget = String(issue.nodeId || "");
  if (graphConsistencyTarget && typeof window.focusGraphNodeById === "function") {
    window.focusGraphNodeById(graphConsistencyTarget).then(function () {
      const el = document.querySelector('[data-node-id="' + graphConsistencyTarget + '"]');
      if (el) el.classList.add("graph-consistency-target");
    });
  }
}

function refreshGraphConsistency() {
  _refreshGraphConsistencyPanel();
}

window.scanGraphConsistency = _scanGraphConsistency;
window.openGraphConsistencyPanel = openGraphConsistencyPanel;
window.toggleGraphConsistencyPanel = toggleGraphConsistencyPanel;
window.closeGraphConsistencyPanel = closeGraphConsistencyPanel;
window.refreshGraphConsistency = refreshGraphConsistency;
window.focusConsistencyIssue = focusConsistencyIssue;
