// ====== Φ 预览画布层：待确认节点/边的虚化渲染与居中（2026-10-10 自 graph-render.js 拆出，T261 纯搬家）=====
// 独立成件不归 harness-preview.js：stage0/f3b 沙箱只装 Φ 面板模块不带 graph.js，
// 画布侧函数须缺席让 typeof 守卫跳过（今日实测搬进面板件即在缺 graphView 的沙箱炸）。
// 主包加载于 graph-render 族末尾；viewer 不带（viewer-shims 桩兜住公开入口）。
function clearGraphHarnessPreview() {
  graphView.previewNodes = [];
  graphView.previewEdges = [];
  graphCanvas?.querySelector('.graph-harness-preview-layer')?.remove();
}

function _renderGraphHarnessPreview() {
  if (!graphCanvas) return;
  graphCanvas.querySelector('.graph-harness-preview-layer')?.remove();
  if (!graphView.previewNodes.length && !graphView.previewEdges.length) return;

  const state = _graphState();
  const layer = document.createElement('div');
  layer.className = 'graph-harness-preview-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'graph-harness-preview-layer-edges');
  layer.appendChild(svg);
  const previewById = new Map(graphView.previewNodes.map(node => [node.id, node]));

  graphView.previewEdges.forEach(edge => {
    const d = _harnessPreviewEdgePath(edge, previewById, state);
    if (!d) return;
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'graph-harness-preview-edge');
    path.setAttribute('data-preview-edge', _edgeKey(edge));
    path.setAttribute('d', d);
    svg.appendChild(path);
  });

  graphView.previewNodes.forEach(node => {
    const el = document.createElement('div');
    el.className = 'graph-harness-preview-node' + (node.kind === 'ai_eval' ? ' graph-harness-preview-eval' : '');
    el.dataset.previewId = node.id;
    const width = node.w || 220;
    const height = node.h || 80;
    el.style.width = Math.max(160, width * (state.zoom || 0.9)) + 'px';
    el.style.transform = _harnessPreviewNodeTranslate(node, state);
    el.innerHTML = '<span class="graph-harness-preview-badge">待确认</span>'
      + '<span class="graph-harness-preview-label">' + escapeHtml(node.label || '新节点') + '</span>';
    const startDrag = event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      el._harnessDrag = {
        node,
        zoom: state.zoom || 0.9,
        startX: node.x,
        startY: node.y,
        startClientX: event.clientX,
        startClientY: event.clientY,
      };
      el.classList.add('dragging');
      try { el.setPointerCapture(event.pointerId); } catch (e) {}
    };
    const moveDrag = event => {
      const drag = el._harnessDrag;
      if (!drag) return;
      event.stopPropagation();
      event.preventDefault();
      drag.node.x = drag.startX + (event.clientX - drag.startClientX) / drag.zoom;
      drag.node.y = drag.startY + (event.clientY - drag.startClientY) / drag.zoom;
      _updateHarnessPreviewPositions();
    };
    const endDrag = event => {
      if (!el._harnessDrag) return;
      event.stopPropagation();
      el.classList.remove('dragging');
      el._harnessDrag = null;
    };
    el.addEventListener('pointerdown', startDrag);
    el.addEventListener('pointermove', moveDrag);
    el.addEventListener('pointerup', endDrag);
    el.addEventListener('pointercancel', endDrag);
    layer.appendChild(el);
  });
  graphCanvas.appendChild(layer);
}

function _harnessPreviewEdgePath(edge, previewById, state) {
  const from = graphView.nodeById[edge.from] || previewById.get(edge.from);
  const to = graphView.nodeById[edge.to] || previewById.get(edge.to);
  if (!from || !to) return '';
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const fromWidth = from.w || 220;
  const toWidth = to.w || 220;
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

function _harnessPreviewNodeTranslate(node, state) {
  const zoom = state.zoom || 0.9;
  const pan = state.pan || { x: 0, y: 0 };
  const width = node.w || 220;
  const height = node.h || 80;
  return 'translate(' + (pan.x + (node.x - width / 2) * zoom) + 'px, '
    + (pan.y + (node.y - height / 2) * zoom) + 'px)';
}

function _updateHarnessPreviewPositions() {
  if (!graphCanvas) return;
  const state = _graphState();
  const previewById = new Map(graphView.previewNodes.map(node => [node.id, node]));
  graphCanvas.querySelectorAll('.graph-harness-preview-node').forEach(el => {
    const node = previewById.get(el.dataset.previewId);
    if (node) el.style.transform = _harnessPreviewNodeTranslate(node, state);
  });
  const svg = graphCanvas.querySelector('.graph-harness-preview-layer-edges');
  if (svg) {
    graphView.previewEdges.forEach(edge => {
      const d = _harnessPreviewEdgePath(edge, previewById, state);
      const path = svg.querySelector('[data-preview-edge="' + _edgeKey(edge) + '"]');
      if (path && d) path.setAttribute('d', d);
    });
  }
}

function _harnessVisibleCanvasRect() {
  const canvasRect = graphCanvas?.getBoundingClientRect();
  if (!canvasRect || !canvasRect.width || !canvasRect.height) {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  const rect = {
    left: canvasRect.left,
    top: canvasRect.top,
    right: canvasRect.right,
    bottom: canvasRect.bottom,
    width: canvasRect.width,
    height: canvasRect.height,
  };
  const panel = document.querySelector('.graph-harness-window');
  if (panel && !panel.hidden) {
    const p = panel.getBoundingClientRect();
    const overlapLeft = Math.max(rect.left, p.left);
    const overlapRight = Math.min(rect.right, p.right);
    const overlapTop = Math.max(rect.top, p.top);
    const overlapBottom = Math.min(rect.bottom, p.bottom);
    if (overlapRight > overlapLeft && overlapBottom > overlapTop) {
      const leftW = overlapLeft - rect.left;
      const rightW = rect.right - overlapRight;
      const topH = overlapTop - rect.top;
      const bottomH = rect.bottom - overlapBottom;
      if (leftW >= rightW) rect.right = overlapLeft; else rect.left = overlapRight;
      if (topH >= bottomH) rect.bottom = overlapTop; else rect.top = overlapBottom;
      rect.width = Math.max(0, rect.right - rect.left);
      rect.height = Math.max(0, rect.bottom - rect.top);
    }
  }
  return rect;
}

function showGraphHarnessPreview(nodes, edges) {
  graphView.previewNodes = Array.isArray(nodes) ? nodes : [];
  graphView.previewEdges = Array.isArray(edges) ? edges : [];
  _renderGraphHarnessPreview();
  _centerGraphOnPreview();
}

function _centerGraphOnPreview() {
  if (!graphView.previewNodes.length || !graphCanvas) return;
  const state = _graphState();
  const canvasRect = graphCanvas.getBoundingClientRect();
  const rect = _harnessVisibleCanvasRect();
  const avgX = graphView.previewNodes.reduce((sum, node) => sum + (node.x || 0), 0) / graphView.previewNodes.length;
  const avgY = graphView.previewNodes.reduce((sum, node) => sum + (node.y || 0), 0) / graphView.previewNodes.length;
  const zoom = state.zoom || 0.9;
  state.pan.x = (rect.left - canvasRect.left) + rect.width / 2 - avgX * zoom;
  state.pan.y = (rect.top - canvasRect.top) + rect.height / 2 - avgY * zoom;
  _saveGraphState(state);
  _applyGraphTransform();
  _updateNodeTransforms();
  if (typeof _redrawEdges === 'function') _redrawEdges();
}
