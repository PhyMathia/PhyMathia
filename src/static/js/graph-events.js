// ===== 画布事件与分组操作（2026-10-24 自 graph-workflow.js 拆出，T397 纯搬家）=====
// 键盘（Ctrl+C/V 等）、画布 DOM 事件初始化、文本选择模式、聚焦导航，与分组的增删改名入组
//（分组框渲染在 graph-data.js）。window 导出集中在 graph-workflow.js 尾部块。
function _addNodeIdsToGroup(groupId, nodeIds) {
  const group = _graphGroupById(groupId);
  if (!group) return false;
  _syncGroupMembersByContainment();
  const current = _graphGroupById(groupId);
  if (!current) return false;
  const ids = (nodeIds || []).filter(id => _findGraphNode(id) && !current.nodeIds.includes(id));
  if (!ids.length) return false;
  _pushGraphUndo();
  current.nodeIds = Array.from(new Set([...(current.nodeIds || []), ...ids]));
  _fitGroupToMembers(current);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  return true;
}

function graphCreateGroup() {
  const selected = Array.from(graphView.selectedNodeIds || [])
    .map(id => _findGraphNode(id))
    .filter(Boolean);
  const bounds = _graphGroupBounds(selected.map(node => node.id));
  const root = graphView.nodes.find(node => node.isRoot);
  const group = {
    id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: '分组 ' + (graphView.groups.length + 1),
    color: graphDefaultGroupColor(),
    nodeIds: selected.map(node => node.id),
    x: root && !selected.length ? root.x + 90 : bounds.x,
    y: root && !selected.length ? root.y + 60 : bounds.y,
    width: selected.length ? bounds.width : 320,
    height: selected.length ? bounds.height : 180,
  };
  _pushGraphUndo();
  graphView.groups.push(group);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRenameGroup(groupId, name) {
  const group = _graphGroupById(groupId);
  if (!group) return;
  const nextName = String(name || '').trim() || '分组';
  if (group.name === nextName) return;
  _pushGraphUndo();
  group.name = nextName;
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  const input = graphInner?.querySelector('[data-group-id="' + groupId + '"] .graph-group-name-input');
  if (input) input.value = group.name;
}

function graphSetGroupColor(groupId, color) {
  const group = _graphGroupById(groupId);
  if (!group || !color) return;
  if (group.color === color) return;
  _pushGraphUndo();
  group.color = color;
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  _updateGroupElement(group);
}

function graphAddSelectedToGroup(groupId) {
  _syncGroupMembersByContainment();
  const group = _graphGroupById(groupId);
  if (!group) return;
  const selected = Array.from(graphView.selectedNodeIds || [])
    .filter(id => !group.nodeIds.includes(id))
    .filter(id => _findGraphNode(id));
  if (!selected.length) {
    if (typeof showToast === 'function') showToast('请先框选要加入分组的节点');
    return;
  }
  _pushGraphUndo();
  group.nodeIds = Array.from(new Set([...(group.nodeIds || []), ...selected]));
  _fitGroupToMembers(group);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphDeleteGroup(groupId) {
  const group = _graphGroupById(groupId);
  if (!group) return;
  if (!confirm('确定删除这个分组吗？节点不会被删除。')) return;
  _pushGraphUndo();
  graphView.groups = graphView.groups.filter(item => item.id !== groupId);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function _deleteSelectedGraphGroups(groupIds) {
  const ids = (groupIds || []).filter(id => _graphGroupById(id));
  if (!ids.length) return;
  if (!confirm('确定删除选中的 ' + ids.length + ' 个分组吗？节点不会被删除。')) return;
  _pushGraphUndo();
  graphView.groups = graphView.groups.filter(group => !ids.includes(group.id));
  const state = _graphState();
  state.groups = graphView.groups.map(group => ({ ...group }));
  _saveGraphState(state);
  graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
  renderGraphCanvas();
}

function _handleGraphKeydown(event) {
  const target = event.target;
  const inTextInput = target && typeof target.closest === 'function'
    && target.closest('input, textarea, [contenteditable], iframe');
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    if (typeof window.redoGraphAction === 'function') window.redoGraphAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
    if (inTextInput) return;
    event.preventDefault();
    if (typeof window.redoGraphAction === 'function') window.redoGraphAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    _undoGraphAction();
    return;
  }
  if (graphView.selectMode) return;
  // 节点复制/粘贴（ComfyUI 式剪贴板，2026-10-15）：图谱选择集 ↔ 节点剪贴板
  // （localStorage 镜像，跨画布/刷新都在）。有文字选择期放行给浏览器复制文本；
  // 输入框内一律不劫持（inTextInput 已先返回）；只读查看页的粘贴禁断在落地函数内。
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'c' || event.key === 'C')) {
    if (inTextInput) return;
    if (typeof window.getSelection === 'function' && String(window.getSelection() || '').trim()) return;
    if (!graphView.selectedNodeIds || !graphView.selectedNodeIds.size) return;
    event.preventDefault();
    const picked = Array.from(graphView.selectedNodeIds)
      .map(id => graphView.nodeById[id])
      .filter(Boolean);
    if (typeof graphCopySelectedNodes === 'function') graphCopySelectedNodes(picked);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'v' || event.key === 'V')) {
    if (inTextInput) return;
    if (typeof _graphClipCount !== 'function' || !_graphClipCount()) return;
    event.preventDefault();
    if (typeof graphPasteNodeClipboard !== 'function') return;
    const rect = (graphCanvas && typeof graphCanvas.getBoundingClientRect === 'function')
      ? graphCanvas.getBoundingClientRect() : null;
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    graphPasteNodeClipboard(
      typeof _clientToGraphLocal === 'function' ? _clientToGraphLocal(cx, cy) : { x: 0, y: 0 });
    return;
  }
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (!graphCanvas || (!graphView.selectedNodeIds.size && !graphView.selectedGroupIds.size)) return;
  if (inTextInput) return;
  event.preventDefault();
  if (graphView.selectedGroupIds.size) {
    _deleteSelectedGraphGroups(Array.from(graphView.selectedGroupIds));
  } else {
    _deleteSelectedGraphNodes(Array.from(graphView.selectedNodeIds));
  }
}

function _initGraphCanvasEvents() {
  if (!graphCanvas) return;
  // 滚轮缩放按帧合并：触控板/高分辨率滚轮一次手势会连发多个 wheel 事件，逐事件同步缩放
  // 每发都做一次 getBoundingClientRect + transform 写入 + save 记账。改为「最新优先」——
  // 事件里只累乘系数、记最新光标锚点，rAF 每帧最多执行一次 zoomGraph（与拖拽
  // _handlePointerMove 的每帧一次口径一致）。preventDefault 必须同步，不能挪进 rAF。
  let _graphWheelRaf = 0, _graphWheelFactor = 1, _graphWheelX = 0, _graphWheelY = 0;
  graphCanvas.addEventListener('wheel', e => {
    const scroller = e.target.closest('.graph-node-full-content, .graph-node .mermaid-container');
    if (scroller) return;
    e.preventDefault();
    _graphWheelFactor *= e.deltaY < 0 ? 1.08 : 0.92;
    _graphWheelX = e.clientX;
    _graphWheelY = e.clientY;
    if (!_graphWheelRaf) {
      _graphWheelRaf = requestAnimationFrame(() => {
        _graphWheelRaf = 0;
        const factor = _graphWheelFactor;
        _graphWheelFactor = 1;
        zoomGraph(factor, _graphWheelX, _graphWheelY);
      });
    }
  }, { passive: false });
  graphCanvas.addEventListener('pointerdown', e => {
    // 右键/中键不进入拖拽与点选链路（右键菜单由 contextmenu 监听单独处理）：
    // 过滤必须在本处理器入口生效，_startNodeDrag/_startGroupDrag/_startCanvasPan 才不会被
    // 右键按下误触发；graph-custom.js 的 document 捕获 pointerdown（曲线拖拽 + 联系线
    // 450ms 双击检测）同样已在入口按 button 过滤（已随联系线菜单 M1 落地细化）——右键按压
    // 不再计入双击检测，快速右双击不会误开联系线弹窗。
    if (e.button !== 0) return;
    graphView.suppressClick = false;
    if (graphView.selectMode) {
      if (e.target.closest('.graph-canvas-toolbar')) return;
      if (e.target.closest('button, a, input, textarea, iframe, .graph-port, .graph-add-port-btn, .graph-port-remove')) return;
      if (e.target.closest('.graph-node, .graph-group, .graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub, .graph-draft-body, .graph-regenerate-panel')) return;
      _clearGraphTextSelection();
      _startCanvasPan(e);
      return;
    }
    if (!e.target.closest || !e.target.closest('input, textarea')) {
      _clearGraphTextSelection();
    }
    if (e.target.closest('.graph-canvas-toolbar')) return;
    if (e.target.closest('.graph-port-remove')) return;
    if (e.target.closest('.graph-output-port, .graph-input-port')) {
      _startLinkDrag(e, e.target.closest('.graph-port'));
      return;
    }
    if (e.target.closest('.graph-add-port-btn')) return;
    if (e.target.closest('button, a, input, textarea, iframe, .graph-regen-btn')) return;
    if (e.target.closest('.graph-group input, .graph-group button')) return;
    if (e.target.closest('.graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub')) return;
    if (e.target.closest('.graph-group-resize-handle')) {
      const groupEl = e.target.closest('.graph-group');
      if (groupEl) _startGroupResize(e, groupEl);
      return;
    }
    const groupEl = e.target.closest('.graph-group');
    if (groupEl) {
      _startGroupDrag(e, groupEl);
      return;
    }
    if (e.target.closest('.graph-resize-handle')) {
      const nodeEl = e.target.closest('.graph-node');
      if (nodeEl) _startNodeResize(e, nodeEl);
      return;
    }
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl && !e.target.closest('button, a, input, textarea, iframe')) {
      if (graphView.linkMode) return;
      _startNodeDrag(e, nodeEl);
    } else _startCanvasPan(e);
  });
  graphCanvas.addEventListener('contextmenu', e => {
    // 自绘右键菜单（graph-contextmenu.js）。只在图谱画布内接管，画布外仍是浏览器原生菜单。
    // 1) 输入类元素放行：节点内 textarea/输入框保留粘贴、拼写等原生编辑菜单
    if (e.target && typeof e.target.closest === 'function'
      && e.target.closest('input, textarea, [contenteditable], iframe')) return;
    // 2) 文字选择模式放行：不与「选择文字/复制」抢交互
    if (graphView.selectMode) return;
    // 3) 拖动/框选过的手势不弹菜单（graphView.moved 由现有拖拽链路维护）
    if (graphView.moved) return;
    e.preventDefault();
    openGraphContextMenu(e);
  });
  graphCanvas.addEventListener('pointermove', _handlePointerMove);
  window.addEventListener('pointerup', _endPointerDrag);
  // 拖拽被系统手势/浏览器接管时 pointerup 不来：至少把装饰粒子的暂停标志恢复掉
  window.addEventListener('pointercancel', () => {
    if (graphView.symbolsPausedForDrag) {
      graphView.symbolsPausedForDrag = false;
      if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(false);
    }
  });
  graphCanvas.addEventListener('selectstart', e => {
    if (graphView.selectMode) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('input, textarea')) return;
    e.preventDefault();
  });
  if (!graphView.keyHandlerBound) {
    window.addEventListener('keydown', _handleGraphKeydown);
    graphView.keyHandlerBound = true;
  }
  graphCanvas.addEventListener('click', e => {
    if (graphView.suppressClick) {
      graphView.suppressClick = false;
      return;
    }
    if (graphView.selectMode) return;
    if (graphView.moved) return;
    if (e.target.closest('button, a, input, textarea, iframe, .graph-port')) return;
    const linkEdgeEl = e.target.closest('.graph-edge-link, .graph-edge-link-label');
    if (linkEdgeEl && linkEdgeEl.dataset.edgeKey) {
      // 单击联系线：进入手柄精调（钢笔式拖拽）。
      // 双击必须手动检测：进/出精调态都会 _redrawEdges() 替换 SVG 元素，
      // 浏览器原生 dblclick 会落在公共祖先容器上，closest('.graph-edge') 永远失配。
      const linkKey = linkEdgeEl.dataset.edgeKey;
      const now = Date.now();
      const last = graphView._lastLinkEdgeClick || null;
      if (last && last.key === linkKey && (now - last.t) < 450
          && Math.abs(last.cx - e.clientX) < 10 && Math.abs(last.cy - e.clientY) < 10) {
        graphView._lastLinkEdgeClick = null;
        graphView.edgeCurveEditKey = null;
        openLinkEdgeModal(linkKey);
        return;
      }
      graphView._lastLinkEdgeClick = { key: linkKey, t: now, cx: e.clientX, cy: e.clientY };
      if (typeof window.enterLinkCurveEdit === 'function') window.enterLinkCurveEdit(linkKey);
      return;
    }
    if (graphView.linkMode) {
      const linkNodeEl = e.target.closest('.graph-node');
      if (linkNodeEl) _graphLinkPickNode(linkNodeEl.dataset.nodeId);
      return;
    }
    const groupEl = e.target.closest('.graph-group');
    if (groupEl) {
      const id = groupEl.dataset.groupId;
      if (_isGraphModifier(e)) {
        _toggleGraphGroupSelection(id);
      } else if (graphView.selectedGroupIds.has(id)) {
        graphView.selectedGroupIds.delete(id);
        _syncGraphSelectionClasses();
      } else {
        _setGraphGroupSelection([id], false);
      }
      return;
    }
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId;
      if (_isGraphModifier(e)) {
        _toggleGraphSelection(id);
      } else if (graphView.selectedNodeIds.has(id)) {
        graphView.selectedNodeIds.delete(id);
        _syncGraphSelectionClasses();
      } else {
        _setGraphSelection([id], false);
      }
    } else {
      _clearGraphSelection();
    }
  });
  graphCanvas.addEventListener('dblclick', e => {
    if (graphView.selectMode || graphView.linkMode) {
      // 静默返回会让用户误以为双击编辑坏了；给出原因提示
      if (typeof showToast === 'function') {
        showToast(graphView.linkMode
          ? '联系模式中：完成连线或再次点击工具栏退出后，才能双击编辑'
          : '文字选择模式中：先点击「选择文字」按钮退出，再双击编辑');
      }
      return;
    }
    const edgeEl = e.target.closest('.graph-edge');
    if (edgeEl && edgeEl.dataset.edgeKey) {
      e.preventDefault();
      e.stopPropagation();
      // 联系线（联系模式创建的注释性箭头）：双击打开编辑弹窗；
      // 其余连线（端口拖出的父子关系）：双击=删除（tooltip 有说明）
      const edgeKey = edgeEl.dataset.edgeKey;
      const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
      if (edge && edge.link) {
        openLinkEdgeModal(edgeKey);
        return;
      }
      _removeGraphEdge(edgeKey);
      if (typeof showToast === 'function') showToast('已删除连线（Ctrl+Z 可撤销）');
      return;
    }
    const dblNodeEl = e.target.closest('.graph-node');
    if (dblNodeEl) {
      const dblNode = _findGraphNode(dblNodeEl.dataset.nodeId);
      if (dblNode && dblNode.kind === 'human_note') {
        e.preventDefault();
        e.stopPropagation();
        editHumanNoteNode(dblNode.id);
        return;
      }
    }
    if (e.target.closest('.graph-node, .graph-group, .graph-port, .graph-canvas-toolbar')) return;
    const point = _clientToGraphLocal(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    openAddBlankNodeModal(point.x, point.y);
  });
}

function _applyGraphTextSelectionMode() {
  if (!graphCanvas) return;
  graphCanvas.classList.toggle('graph-select-mode', !!graphView.selectMode);
  const btn = graphCanvas.querySelector('.graph-select-btn');
  if (btn) {
    btn.classList.toggle('active', !!graphView.selectMode);
    btn.title = graphView.selectMode ? '退出文字选择' : '选择文字';
    btn.setAttribute('aria-pressed', String(!!graphView.selectMode));
  }
  if (!graphView.selectMode) _clearGraphTextSelection();
}

function graphToggleTextSelection() {
  graphView.selectMode = !graphView.selectMode;
  _applyGraphTextSelectionMode();
}

function _unhideGraphNodeForFocus(node) {
  if (!node) return;
  const state = _graphState();
  let changed = false;
  const keys = [];
  const timestamp = String(node.timestamp || '');
  if (node.kind === 'module' && node.moduleKey) keys.push(timestamp + ':' + node.moduleKey);
  if (node.kind === 'answer') keys.push(timestamp + ':answer');
  if (node.id) keys.push(String(node.id));
  for (const key of keys) {
    if (state.hidden[key]) {
      delete state.hidden[key];
      node.hidden = false;
      changed = true;
    }
    if (state.collapsed[key]) {
      delete state.collapsed[key];
      node.minimized = false;
      changed = true;
    }
  }
  // 自定义节点的最小化状态存在 customNodes 里，定位时一并清除
  if (node.messageIndex < 0 && Array.isArray(state.customNodes)) {
    const cn = state.customNodes.find(function (x) { return String(x.id) === String(node.id); });
    if (cn && cn.minimized) {
      cn.minimized = false;
      node.minimized = false;
      changed = true;
    }
  }
  if (changed) _saveGraphState(state);
  // T69：折叠壳没有内容子树（占位符）——定位跳转展开它时先整卡重建，
  // 否则跳过去是一张空壳卡
  const phEl = graphInner && graphInner.querySelector
    ? graphInner.querySelector('[data-node-id="' + node.id + '"] [data-body-ph]') : null;
  if (phEl && !node.minimized && typeof _refreshWorkflowNodeUi === 'function') {
    _refreshWorkflowNodeUi(node);
  }
  const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
  if (el) {
    el.classList.remove('dimmed', 'minimized');
    const toggle = el.querySelector('.graph-node-minimize-toggle');
    if (toggle) {
      toggle.textContent = node.minimized ? '+' : '−';
      toggle.title = node.minimized ? '展开' : '最小化';
    }
  }
}

function _centerGraphOnNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || !graphCanvas) return false;
  _unhideGraphNodeForFocus(node);
  const state = _graphState();
  const rect = graphCanvas.getBoundingClientRect();
  const zoom = Math.max(0.7, state.zoom || 0.9);
  state.zoom = zoom;
  state.pan.x = rect.width / 2 - node.x * zoom;
  state.pan.y = rect.height / 2 - node.y * zoom;
  _saveGraphState(state);
  _applyGraphTransform();
  _setGraphSelection([nodeId]);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  if (el) {
    el.classList.remove('graph-node-located');
    void el.offsetWidth;
    el.classList.add('graph-node-located');
    clearTimeout(el._focusTimer);
    el._focusTimer = setTimeout(() => el.classList.remove('graph-node-located'), 2600);
  }
  return true;
}

function focusGraphNode(sessionId, messageId, moduleKey, nodeKind) {
  if (!messageId) return Promise.resolve(false);
  renderGraphCanvas();
  return new Promise(resolve => {
    const kind = nodeKind || (moduleKey === 'question' ? 'user' : '');
    const hasModule = kind !== 'user' && !!moduleKey && moduleKey !== 'answer';
    const focusId = kind === 'user'
      ? _graphNodeId('q', messageId)
      : hasModule
        ? _graphNodeId('m', messageId, moduleKey)
        : _graphNodeId('a', messageId);
    const fallbackId = kind === 'user' ? '' : (hasModule ? _graphNodeId('a', messageId) : '');
    const run = () => {
      _measureNodes();
      if (_centerGraphOnNode(focusId)) {
        resolve(true);
        return;
      }
      if (fallbackId && _centerGraphOnNode(fallbackId)) {
        resolve(true);
        return;
      }
      resolve(false);
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  });
}

function focusGraphNodeById(nodeId) {
  if (!nodeId) return Promise.resolve(false);
  renderGraphCanvas();
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      _measureNodes();
      resolve(_centerGraphOnNode(nodeId));
    }));
  });
}

