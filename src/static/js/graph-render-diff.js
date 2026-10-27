// ====== 探索网版本对比高亮（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）=====
// 调用方：graph.js（window.* typeof 守卫）、harness-apply.js 同守卫；graph-workflow.js
// 尾部导出块照旧导出 window.applyGraphDiffHighlights/clearGraphDiffHighlights。
// 2026-10-24：新增「修改历史对比」一套（applyGraphHistoryDiff / flashGraphHistoryDiff）——
// 方向是「回到那一步会怎样」，与 Φ 的「向前改」不是一回事，故分开，不共用一个入口。
// 同日简化批次：历史对比支持两向（opts.dir 'back'|'step'），历史侧幽灵虚影退役
//（用户看不懂旧坐标虚影卡）；_renderGraphDiffGhost 一族仍服务 Φ 的「向前改」对比。
const GRAPH_DIFF_EXTRA_CLASSES = [
  'graph-diff-will-vanish', 'graph-diff-will-return', 'graph-diff-will-change',
  'graph-diff-dim', 'graph-diff-flash',
];

// T395：T376 的 content-visibility:auto 自带 paint 包含，会把挂在卡左上角
// （top/left:-10px）的红圈角标裁进圆角边框盒，只剩一个小三角。打角标的节点
// 临时关掉 c-v（记原值），对比清除时还原——与 ai_eval 例外同一逻辑。
const _graphDiffCvRestore = [];

function _graphDiffUnclipNode(el) {
  if (!el || !el.style || !el.style.contentVisibility) return;
  _graphDiffCvRestore.push({ el, value: el.style.contentVisibility });
  el.style.contentVisibility = 'visible';
}

function _graphDiffRestoreCv() {
  while (_graphDiffCvRestore.length) {
    const saved = _graphDiffCvRestore.pop();
    saved.el.style.contentVisibility = saved.value;
  }
}

function _graphDiffGhostLayerHost() {
  // 幽灵层必须挂进 graphInner（真正被 translate/scale 的那层）。挂 graphCanvas 时
  // 坐标把 pan/zoom 算死了，一平移/缩放就和节点错位（R6）。
  return (typeof graphInner !== 'undefined' && graphInner) ? graphInner : graphCanvas;
}

function clearGraphDiffHighlights() {
  _graphDiffRestoreCv();
  graphInner?.querySelectorAll('.graph-diff-add, .graph-diff-update, .graph-diff-delete')
    .forEach(el => el.classList.remove('graph-diff-add', 'graph-diff-update', 'graph-diff-delete'));
  graphInner?.querySelectorAll('.' + GRAPH_DIFF_EXTRA_CLASSES.join(', .'))
    .forEach(el => el.classList.remove(...GRAPH_DIFF_EXTRA_CLASSES));
  graphInner?.querySelectorAll('.graph-diff-badge').forEach(el => el.remove());
  graphCanvas?.querySelector('.graph-diff-ghost-layer')?.remove();
  graphInner?.querySelector('.graph-diff-ghost-layer')?.remove();
}

function applyGraphDiffHighlights(ops, history) {
  clearGraphDiffHighlights();
  const addNodes = new Set();
  const updateNodes = new Set();
  const deleteNodes = new Set();
  const addEdges = new Set();
  const updateEdges = new Set();
  const deleteEdges = new Set();
  (ops || []).forEach(op => {
    const name = op.op || op.type || '';
    const nodeId = op.assigned_id || op.id;
    if (name === 'create_node' || name === 'create_eval_node') {
      if (nodeId) addNodes.add(nodeId);
    } else if (name === 'update_node') {
      if (nodeId) updateNodes.add(nodeId);
    } else if (name === 'delete_node') {
      if (nodeId) deleteNodes.add(nodeId);
    }
    const edgeKey = op.edge_key || op.key;
    if (name === 'add_edge') {
      if (edgeKey) addEdges.add(edgeKey);
    } else if (name === 'update_edge') {
      if (edgeKey) updateEdges.add(edgeKey);
    } else if (name === 'remove_edge') {
      if (edgeKey) deleteEdges.add(edgeKey);
    }
  });
  graphView.nodes.forEach(node => {
    const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
    if (!el) return;
    if (deleteNodes.has(node.id)) el.classList.add('graph-diff-delete');
    else if (updateNodes.has(node.id)) el.classList.add('graph-diff-update');
    else if (addNodes.has(node.id)) el.classList.add('graph-diff-add');
  });
  graphView.edges.forEach(edge => {
    const el = graphEdgeLayer?.querySelector('[data-edge-key="' + _edgeKey(edge) + '"]');
    if (!el) return;
    const key = _edgeKey(edge);
    if (deleteEdges.has(key)) el.classList.add('graph-diff-delete');
    else if (updateEdges.has(key)) el.classList.add('graph-diff-update');
    else if (addEdges.has(key)) el.classList.add('graph-diff-add');
  });

  // 历史版本里有、当前版本已不存在（被删除/被移除）的节点与连线，
  // 当前画布渲染不出对应元素，需要以虚化“幽灵”标记补出来，让对比结果完整可见。
  if (history && history.state) {
    let oldData = null;
    try {
      oldData = _buildGraphData(history.messages || [], history.state);
    } catch (e) {
      oldData = null;
    }
    if (oldData) {
      const liveState = _graphState();
      const currentIds = new Set(graphView.nodes.map(n => String(n.id)));
      const currentKeys = new Set(graphView.edges.map(e => _edgeKey(e)));
      const hiddenNow = (liveState && liveState.hidden) || {};
      // _buildGraphData 只返回默认连线，需再用 _resolveGraphEdges 合并自定义联系，
      // 才能拿到历史版本的完整边集合（含用户新增/移除的联系箭头）。
      const oldEdges = _resolveGraphEdges(history.state, oldData.edges, oldData.nodeById);
      // 节点：历史里有、当前没有，且不是「当前只是被隐藏」→ 视为被删除的虚化节点
      const ghostNodes = oldData.nodes.filter(n => {
        if (currentIds.has(String(n.id))) return false;
        if (_graphDiffNodeHidden(hiddenNow, n)) return false;
        return true;
      });
      // 连线：历史里有、当前画布没有（其端点若在当前只被隐藏，则无法落点会被自动跳过）
      const ghostEdges = oldEdges.filter(e => !currentKeys.has(_edgeKey(e)));
      _renderGraphDiffGhost(ghostNodes, ghostEdges);
    }
  }
}

function _graphDiffGhostWidth(node) {
  const kind = node && node.kind;
  // junction（2026-10-11）：走线锚点小卡，比常规卡窄一半
  if (kind === 'junction') return 120;
  if (kind === 'hub' || kind === 'summary' || kind === 'note' || kind === 'human_note' || kind === 'source') return 260;
  return 220;
}

// 画布 hidden 表可能用 node.id 或 “timestamp:kind” 两种键，这里统一判断当前是否被隐藏
function _graphDiffNodeHidden(hiddenMap, node) {
  if (!node) return false;
  const keys = [String(node.id)];
  const ts = node.timestamp != null ? String(node.timestamp) : '';
  if (node.kind === 'module' && node.moduleKey) keys.push(ts + ':' + node.moduleKey);
  if (node.kind === 'answer') keys.push(ts + ':answer');
  return keys.some(key => !!hiddenMap[key]);
}

// 幽灵挂在 graphInner 里，坐标就是图坐标（不再预乘 pan/zoom）——平移缩放由祖先
// transform 带着一起走（R6）。
function _graphDiffGhostTranslate(node) {
  const width = node.w || node.customWidth || _graphDiffGhostWidth(node);
  const height = node.h || node.customHeight || 72;
  return 'translate(' + (node.x - width / 2) + 'px, ' + (node.y - height / 2) + 'px)';
}

function _graphDiffGhostPath(edge, ghostById) {
  const from = graphView.nodeById?.[edge.from] || ghostById.get(edge.from);
  const to = graphView.nodeById?.[edge.to] || ghostById.get(edge.to);
  if (!from || !to) return '';
  const fromWidth = from.w || from.customWidth || _graphDiffGhostWidth(from);
  const toWidth = to.w || to.customWidth || _graphDiffGhostWidth(to);
  const x1 = from.x + fromWidth / 2;
  const y1 = from.y;
  const x2 = to.x - toWidth / 2;
  const y2 = to.y;
  const offset = Math.max(60, Math.min(180, Math.abs(x2 - x1) * 0.45));
  return 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1)
    + ' C' + (x1 + offset).toFixed(1) + ' ' + y1.toFixed(1)
    + ', ' + (x2 - offset).toFixed(1) + ' ' + y2.toFixed(1)
    + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1);
}

function _renderGraphDiffGhost(ghostNodes, ghostEdges, opts) {
  const host = _graphDiffGhostLayerHost();
  if (!host) return;
  host.querySelector('.graph-diff-ghost-layer')?.remove();
  const nodes = Array.isArray(ghostNodes) ? ghostNodes : [];
  const edges = Array.isArray(ghostEdges) ? ghostEdges : [];
  if (!nodes.length && !edges.length) return;
  const layer = document.createElement('div');
  layer.className = 'graph-diff-ghost-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-diff-ghost-layer-edges');
  layer.appendChild(svg);
  const ghostById = new Map(nodes.map(node => [String(node.id), node]));
  edges.forEach(edge => {
    const d = _graphDiffGhostPath(edge, ghostById);
    if (!d) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'graph-diff-ghost-edge');
    path.setAttribute('data-diff-ghost-edge', _edgeKey(edge));
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  const badgeText = (opts && opts.badge) || '该版本存在';
  nodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'graph-diff-ghost-node' + (opts && opts.willReturn ? ' graph-diff-will-return' : '');
    el.dataset.ghostNodeId = String(node.id);
    const width = node.w || node.customWidth || _graphDiffGhostWidth(node);
    el.style.width = Math.max(120, width) + 'px';
    el.style.transform = _graphDiffGhostTranslate(node);
    const label = (typeof _graphNodeLabelOf === 'function' ? _graphNodeLabelOf(node, node.id) : '')
      || String((node && (node.label || node.title || node.content)) || node.id || '节点');
    el.innerHTML = '<span class="graph-diff-ghost-badge">' + badgeText + '</span>'
      + '<span class="graph-diff-ghost-label">' + escapeHtml(label) + '</span>';
    layer.appendChild(el);
  });
  host.appendChild(layer);
}

// ===== 修改历史对比（2026-10-24）：两向，默认「回到这一步会发生什么」（R5/2.2/2.3） =====
function _graphDiffAddBadge(el, text, cls) {
  if (!el || !el.appendChild) return;
  const badge = document.createElement('span');
  badge.className = 'graph-diff-badge ' + cls;
  badge.textContent = text;
  el.appendChild(badge);
}

function applyGraphHistoryDiff(diff, opts) {
  clearGraphDiffHighlights();
  const ops = (diff && diff.ops) || [];
  // step 方向（这一步改了什么）：这一步新出现的上绿（will-return）；被删的当前画布
  // 本来就没有、不上描边。back 方向＝原口径（现在有的会消失、内容不同的会改写）。
  const step = !!(opts && opts.dir === 'step');
  const vanish = new Set(); // back：现在有、那一步没有 → 回去会消失；step：这一步删掉的边
  const appear = new Set(); // step：这一步新出现的
  const change = new Set(); // 两边都有、内容不同 → 会改写／被改了
  const addEdges = new Set(); // back：现在有、那一步没有的边 → 回去会消失
  const appearEdges = new Set(); // step：这一步新接的边
  const remEdges = new Set(); // back：那一步有、现在没有的边 → 会回来
  ops.forEach(op => {
    const id = op.id != null ? String(op.id) : '';
    if (op.op === 'create_node' && id) { if (step) appear.add(id); else vanish.add(id); }
    else if (op.op === 'update_node' && id) change.add(id);
    const key = op.edge_key || op.key;
    if (op.op === 'add_edge' && key) { if (step) appearEdges.add(String(key)); else addEdges.add(String(key)); }
    else if (op.op === 'remove_edge' && key) remEdges.add(String(key));
  });
  const changedNodes = new Set([...vanish, ...appear, ...change]);
  const hasNodeDiff = changedNodes.size > 0;
  const hasEdgeDiff = addEdges.size || remEdges.size || appearEdges.size;
  // 聚光灯：有差异时未变化的节点降到 35%（2.3），只有位置变化时不压暗。
  const spotlight = !!(hasNodeDiff || hasEdgeDiff);
  graphView.nodes.forEach(node => {
    const id = String(node.id);
    const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
    if (!el) return;
    if (!changedNodes.has(id)) {
      if (spotlight) el.classList.add('graph-diff-dim');
      return;
    }
    _graphDiffUnclipNode(el);
    if (vanish.has(id)) {
      el.classList.add('graph-diff-will-vanish');
      _graphDiffAddBadge(el, '−', 'will-vanish');
    } else if (appear.has(id)) {
      el.classList.add('graph-diff-will-return');
      _graphDiffAddBadge(el, '＋', 'will-return');
    } else if (change.has(id)) {
      el.classList.add('graph-diff-will-change');
      _graphDiffAddBadge(el, '✎', 'will-change');
    }
  });
  graphView.edges.forEach(edge => {
    const key = _edgeKey(edge);
    const el = graphEdgeLayer?.querySelector('[data-edge-key="' + key + '"]');
    if (!el) return;
    if (addEdges.has(key) || (step && remEdges.has(key))) {
      el.classList.add('graph-diff-will-vanish');
      _graphDiffAddBadge(el, '−', 'will-vanish');
    } else if (remEdges.has(key)) {
      el.classList.add('graph-diff-will-change');
    } else if (appearEdges.has(key)) {
      el.classList.add('graph-diff-will-return');
    } else if (spotlight) {
      el.classList.add('graph-diff-dim');
    }
  });
}

let _graphHistoryFlashTimer = null;
function flashGraphHistoryDiff(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String);
  if (!list.length) return;
  list.forEach(id => {
    const el = graphInner?.querySelector('[data-node-id="' + id + '"]');
    if (!el) return;
    el.classList.remove('graph-diff-flash');
    void el.offsetWidth;
    el.classList.add('graph-diff-flash');
  });
  if (_graphHistoryFlashTimer) clearTimeout(_graphHistoryFlashTimer);
  _graphHistoryFlashTimer = setTimeout(function () {
    _graphHistoryFlashTimer = null;
    graphInner?.querySelectorAll('.graph-diff-flash').forEach(el => el.classList.remove('graph-diff-flash'));
  }, 2600);
}
