// ====== 探索网版本对比高亮与幽灵层（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）=====
// 调用方：graph.js（window.* typeof 守卫）、harness-apply.js 同守卫；graph-workflow.js
// 尾部导出块照旧导出 window.applyGraphDiffHighlights/clearGraphDiffHighlights。
function clearGraphDiffHighlights() {
  graphInner?.querySelectorAll('.graph-diff-add, .graph-diff-update, .graph-diff-delete').forEach(el => {
    el.classList.remove('graph-diff-add', 'graph-diff-update', 'graph-diff-delete');
  });
  graphCanvas?.querySelector('.graph-diff-ghost-layer')?.remove();
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
  if (kind === 'hub' || kind === 'summary' || kind === 'note' || kind === 'knowledge' || kind === 'human_note' || kind === 'source') return 260;
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

function _graphDiffGhostTranslate(node, state) {
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const width = node.w || node.customWidth || _graphDiffGhostWidth(node);
  const height = node.h || node.customHeight || 72;
  return 'translate(' + (pan.x + (node.x - width / 2) * zoom) + 'px, '
    + (pan.y + (node.y - height / 2) * zoom) + 'px)';
}

function _graphDiffGhostPath(edge, ghostById, state) {
  const from = graphView.nodeById?.[edge.from] || ghostById.get(edge.from);
  const to = graphView.nodeById?.[edge.to] || ghostById.get(edge.to);
  if (!from || !to) return '';
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const fromWidth = from.w || from.customWidth || _graphDiffGhostWidth(from);
  const toWidth = to.w || to.customWidth || _graphDiffGhostWidth(to);
  const x1 = pan.x + (from.x + fromWidth / 2) * zoom;
  const y1 = pan.y + from.y * zoom;
  const x2 = pan.x + (to.x - toWidth / 2) * zoom;
  const y2 = pan.y + to.y * zoom;
  const offset = Math.max(60, Math.min(180, Math.abs(x2 - x1) * 0.45));
  return 'M' + x1.toFixed(1) + ' ' + y1.toFixed(1)
    + ' C' + (x1 + offset).toFixed(1) + ' ' + y1.toFixed(1)
    + ', ' + (x2 - offset).toFixed(1) + ' ' + y2.toFixed(1)
    + ', ' + x2.toFixed(1) + ' ' + y2.toFixed(1);
}

function _renderGraphDiffGhost(ghostNodes, ghostEdges) {
  if (!graphCanvas) return;
  graphCanvas.querySelector('.graph-diff-ghost-layer')?.remove();
  const nodes = Array.isArray(ghostNodes) ? ghostNodes : [];
  const edges = Array.isArray(ghostEdges) ? ghostEdges : [];
  if (!nodes.length && !edges.length) return;
  const state = _graphState();
  const layer = document.createElement('div');
  layer.className = 'graph-diff-ghost-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-diff-ghost-layer-edges');
  layer.appendChild(svg);
  const ghostById = new Map(nodes.map(node => [node.id, node]));
  edges.forEach(edge => {
    const d = _graphDiffGhostPath(edge, ghostById, state);
    if (!d) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'graph-diff-ghost-edge');
    path.setAttribute('data-diff-ghost-edge', _edgeKey(edge));
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  nodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'graph-diff-ghost-node';
    el.dataset.ghostNodeId = node.id;
    const width = node.w || node.customWidth || _graphDiffGhostWidth(node);
    el.style.width = Math.max(160, width * (state.zoom || 0.9)) + 'px';
    el.style.transform = _graphDiffGhostTranslate(node, state);
    const label = String((node && (node.label || node.title || node.content)) || node.id || '节点');
    el.innerHTML = '<span class="graph-diff-ghost-badge">该版本存在</span>'
      + '<span class="graph-diff-ghost-label">' + escapeHtml(label) + '</span>';
    layer.appendChild(el);
  });
  graphCanvas.appendChild(layer);
}
