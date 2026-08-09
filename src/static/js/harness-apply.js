// ===== PhyMathia 图编辑 harness：应用操作与建议（含 window 导出）=====

  function _applyOneHarnessOp(op, state, nodeKindById) {
    const name = op.op || op.type || '';
    if (name === 'create_eval_node') {
      const id = op.assigned_id || op.id || op.temp_id;
      if (!_prepareHarnessNodeReuse(id, state)) return;
      const pos = _previewNodePosition(id) || _nextNodePosition(state.customNodes.length);
      state.customNodes.push(_newAiEvalNode(id, op, pos));
      const parts = _edgeParts(op.edge_key || op.key);
      const from = parts ? parts.from : (op.target_node_id || op.target || op.from);
      const to = parts ? parts.to : id;
      if (from && to) {
        const fromPort = (parts ? parts.fromPort : op.fromPort) || 'out-0';
        const toPort = (parts ? parts.toPort : op.toPort) || 'in-0';
        const key = _edgeKey({ from, fromPort, to, toPort });
        if (!state.connections.some(edge => _edgeKey(edge) === key)) {
          state.connections.push({
            from,
            fromPort,
            to,
            toPort,
            type: 'custom',
            custom: true,
            relation: '评价',
            label: '评价',
          });
          state.removedEdges = (state.removedEdges || []).filter(item => item !== key);
        }
      }
      return;
    }
    if (name === 'create_node') {
      const id = op.assigned_id || op.id || op.temp_id;
      if (!_prepareHarnessNodeReuse(id, state)) return;
      const pos = _previewNodePosition(id) || _nextNodePosition(state.customNodes.length);
      state.customNodes.push(_newHarnessNode(id, op, pos));
      return;
    }
    if (name === 'update_node') {
      const patch = op.patch || {};
      const customNode = state.customNodes.find(item => item.id === op.id);
      if (customNode) {
        if (patch.label != null || patch.title != null) {
          const label = String((patch.label ?? patch.title) || customNode.label || customNode.title || '');
          customNode.label = label;
          if (customNode.kind === 'knowledge') customNode.title = label;
        }
        if (patch.content != null) {
          customNode.content = String(patch.content || '');
          customNode.summary = customNode.content.slice(0, 120);
        }
        if (patch.formula != null) {
          customNode.formula = String(patch.formula || '');
          customNode.formulas = customNode.formula ? [customNode.formula] : [];
        }
        if (patch.status != null) customNode.status = String(patch.status || '');
        return;
      }
      const allNodes = typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : [];
      const target = allNodes.find(item => item.id === op.id);
      if (target) {
        state.harnessNodeOverrides = state.harnessNodeOverrides || {};
        const ov = state.harnessNodeOverrides[op.id] || {};
        if (patch.label != null || patch.title != null) {
          ov.label = String((patch.label ?? patch.title) || target.label || target.title || ov.label || '');
        }
        if (patch.content != null) ov.content = String(patch.content || '');
        if (patch.formula != null) ov.formula = String(patch.formula || '');
        if (patch.status != null) ov.status = String(patch.status || '');
        state.harnessNodeOverrides[op.id] = ov;
      }
      return;
    }
    if (name === 'delete_node') {
      const id = op.id;
      state.customNodes = state.customNodes.filter(node => node.id !== id);
      state.connections = state.connections.filter(edge => edge.from !== id && edge.to !== id);
      state.harnessDeleted[id] = true;
      if (state.harnessNodeOverrides) delete state.harnessNodeOverrides[id];
      delete state.positions[id];
      delete state.sizes[id];
      delete state.pinned[id];
      delete state.inputPortCounts[id];
      return;
    }
    if (name === 'add_edge') {
      const parts = _edgeParts(op.edge_key || op.key);
      const from = parts ? parts.from : op.from;
      const to = parts ? parts.to : op.to;
      if (!from || !to) return;
      const fromPort = (parts ? parts.fromPort : op.fromPort) || 'out-0';
      let toPort = (parts ? parts.toPort : op.toPort) || 'in-0';
      const targetKind = nodeKindById.get(to);
      if (targetKind === 'module' && typeof window.freeModuleInputPort === 'function') {
        const free = window.freeModuleInputPort(state, to, toPort);
        toPort = free.port;
        state.inputPortCounts = state.inputPortCounts || {};
        state.inputPortCounts[to] = Math.max(state.inputPortCounts[to] || 0, free.index);
      }
      const key = _edgeKey({ from, fromPort, to, toPort });
      if (state.connections.some(edge => _edgeKey(edge) === key)) return;
      state.connections.push({
        from,
        fromPort,
        to,
        toPort,
        type: 'custom',
        custom: true,
        relation: String(op.relation || ''),
        label: String(op.label || ''),
      });
      state.removedEdges = (state.removedEdges || []).filter(item => item !== key);
      return;
    }
    if (name === 'remove_edge') {
      const key = op.edge_key || op.key;
      if (!key) return;
      state.connections = state.connections.filter(edge => _edgeKey(edge) !== key);
      state.removedEdges = Array.from(new Set([...(state.removedEdges || []), key]));
      return;
    }
    if (name === 'update_edge') {
      const key = op.edge_key || op.key;
      const edge = state.connections.find(item => _edgeKey(item) === key);
      if (!edge) return;
      const patch = op.patch || {};
      if (patch.relation != null) edge.relation = String(patch.relation || '');
      if (patch.label != null) edge.label = String(patch.label || '');
    }
  }

  async function _generateHarnessCreatedContent(ops) {
    const ids = (ops || []).filter(op => (op.op || op.type) === 'create_node').map(op => op.assigned_id || op.id || op.temp_id).filter(Boolean);
    for (const id of ids) {
      const node = (typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : []).find(item => item.id === id);
      if (!node) continue;
      if (node.kind === 'knowledge' && typeof window.generateKnowledgeNode === 'function') {
        window.generateKnowledgeNode(id);
      } else if (node.kind === 'relation' && typeof window.generateRelationNode === 'function') {
        window.generateRelationNode(id);
      } else if ((node.kind === 'module' || node.kind === 'blank' || node.kind === 'summary' || (node.kind === 'answer' && !node.manual)) && typeof window.runWorkflowNode === 'function') {
        await window.runWorkflowNode(id, true);
      }
    }
  }

  async function _applyOps(ops, cleanupEval) {
    if (!ops.length) return;
    const sessionId = _sessionId();
    const state = _graphState();
    if (!state) return;
    const before = JSON.parse(JSON.stringify(state));
    harnessLastAppliedOps = Array.isArray(ops) ? ops.slice() : [];
    harnessLastAppliedBeforeSnapshot = harnessSnapshot ? JSON.parse(JSON.stringify(harnessSnapshot)) : null;
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo();
    const nodeKindById = new Map(_graphNodes().map(node => [node.id, node.kind]));
    state.customNodes = Array.isArray(state.customNodes) ? state.customNodes : [];
    state.connections = Array.isArray(state.connections) ? state.connections : [];
    state.harnessDeleted = state.harnessDeleted || {};
    state.harnessNodeOverrides = state.harnessNodeOverrides || {};
    state.removedEdges = Array.isArray(state.removedEdges) ? state.removedEdges : [];
    state.positions = state.positions || {};
    state.sizes = state.sizes || {};
    state.pinned = state.pinned || {};
    state.inputPortCounts = state.inputPortCounts || {};
    ops.forEach(op => _applyOneHarnessOp(op, state, nodeKindById));
    if (harnessPhase === 'apply' && cleanupEval) {
      const evalIds = state.customNodes.filter(node => node.kind === 'ai_eval').map(node => node.id);
      evalIds.forEach(id => {
        state.customNodes = state.customNodes.filter(node => node.id !== id);
        state.connections = state.connections.filter(edge => edge.from !== id && edge.to !== id);
        state.harnessDeleted[id] = true;
        delete state.positions[id];
        delete state.sizes[id];
        delete state.pinned[id];
        delete state.inputPortCounts[id];
      });
    }
    state.harnessCheckpoint = {
      before,
      operations: ops,
      summary: harnessResult?.summary || '',
      appliedAt: Date.now(),
    };
    if (typeof window.saveGraphState === 'function') window.saveGraphState(sessionId, state);
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof window.autoArrangeGraph === 'function') {
      setTimeout(() => window.autoArrangeGraph(true), 0);
    }
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessStatus(
      harnessPhase === 'apply'
        ? '已应用建议并清理 AI 评价节点'
        : '已应用 ' + ops.length + ' 条修改',
      'ok'
    );
    harnessPhiCelebrate = true;
    _setPhiMode('celebrate');
    window.setTimeout(() => {
      if (!harnessBusy) _setPhiMode(harnessPhiError ? 'error' : 'idle');
    }, 2600);
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '<div class="graph-harness-summary">已应用修改，可点击“撤销本次”恢复。</div>';
    setTimeout(() => { _generateHarnessCreatedContent(ops); }, 100);
  }

  function applyGraphHarness() {
    const ops = Array.isArray(harnessResult?.operations) ? harnessResult.operations : [];
    _applyOps(ops, true);
  }

  function applySelectedGraphHarness() {
    _applyOps(_selectedOps(), false);
  }

  function undoGraphHarness() {
    harnessLastAppliedOps = [];
    harnessLastAppliedBeforeSnapshot = null;
    const state = _graphState();
    const checkpoint = state?.harnessCheckpoint;
    if (!checkpoint?.before) {
      _setHarnessStatus('没有可撤销的 harness 修改', 'error');
      return;
    }
    if (typeof window.saveGraphState === 'function') window.saveGraphState(_sessionId(), checkpoint.before);
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessStatus('已撤销本次修改', 'ok');
    harnessPhiCelebrate = true;
    _setPhiMode('celebrate');
    window.setTimeout(() => {
      if (!harnessBusy) _setPhiMode(harnessPhiError ? 'error' : 'idle');
    }, 2600);
  }

  function _removeAllEvalNodes() {
    const state = _graphState();
    if (!state) return;
    const evalIds = (state.customNodes || [])
      .filter(node => node.kind === 'ai_eval')
      .map(node => node.id);
    if (!evalIds.length) return;
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo();
    state.customNodes = state.customNodes.filter(node => node.kind !== 'ai_eval');
    state.connections = state.connections.filter(edge => !evalIds.includes(edge.from) && !evalIds.includes(edge.to));
    evalIds.forEach(id => {
      state.harnessDeleted[id] = true;
      delete state.positions[id];
      delete state.sizes[id];
      delete state.pinned[id];
      delete state.inputPortCounts[id];
    });
    if (typeof window.saveGraphState === 'function') window.saveGraphState(_sessionId(), state);
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
  }

  function keepHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry || entry.decision !== 'pending') return;
    _applyOps(entry.operations || [], entry.phase === 'apply');
    entry.decision = 'keep';
    entry.appliedAt = Date.now();
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function discardHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry || entry.decision !== 'pending') return;
    if (entry.phase === 'apply') _removeAllEvalNodes();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    entry.decision = 'discard';
    entry.discardedAt = Date.now();
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function reapplyHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry) return;
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl) instructionEl.value = entry.instruction || entry.content || '';
    runGraphHarness(entry.phase || 'normal');
  }

  function previewHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry || typeof window.showGraphHarnessPreview !== 'function') return;
    const preview = _buildHarnessPreview(entry.operations || []);
    const _previewSwitched = window.showGraphHarnessPreview(preview.nodes, preview.edges);
    _setHarnessStatus('已显示 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线' + (_previewSwitched ? '（已切换到画布视图）' : ''), 'ok');
  }

  function restoreHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry || entry.decision !== 'discard') return;
    entry.decision = 'pending';
    delete entry.appliedAt;
    delete entry.discardedAt;
    _saveHarnessHistory().then(_renderHarnessChat);
    _setHarnessStatus('已恢复为待处理', 'ok');
  }

  function deleteHarnessHistoryEntry(entryId) {
    harnessHistory = harnessHistory.filter(item => item.id !== entryId);
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  async function acceptAiEvalNode(nodeId) {
    const state = _graphState() || {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const evalNode = _graphNodes().find(node => node.kind === 'ai_eval' && node.id === nodeId && !deleted.has(node.id));
    if (!evalNode) {
      _setHarnessStatus('没有找到这条 AI 评价节点', 'error');
      return;
    }
    harnessSingleEvalId = nodeId;
    openGraphHarness();
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl) instructionEl.value = '只应用这个 AI 评价节点的建议';
    await runGraphHarness('apply');
  }

  function ignoreAiEvalNode(nodeId) {
    if (typeof window.deleteCustomNode === 'function') window.deleteCustomNode(nodeId);
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
  }

  window.openGraphHarness = openGraphHarness;
  window.closeGraphHarness = closeGraphHarness;
  window.toggleGraphHarnessWindow = toggleGraphHarnessWindow;
  window.runGraphHarness = runGraphHarness;
window.runGraphHarnessWithText = runGraphHarnessWithText;
window.undoLastHarnessEdit = undoLastHarnessEdit;
  window.runGraphHarnessWithFocus = runGraphHarnessWithFocus;
  window.chooseHarnessClarifyNode = chooseHarnessClarifyNode;
  window.confirmHarnessClarifyInput = confirmHarnessClarifyInput;
  window.acceptAiEvalNode = acceptAiEvalNode;
  window.ignoreAiEvalNode = ignoreAiEvalNode;
  window.keepHarnessSuggestion = keepHarnessSuggestion;
  window.discardHarnessSuggestion = discardHarnessSuggestion;
  window.reapplyHarnessSuggestion = reapplyHarnessSuggestion;
  window.previewHarnessSuggestion = previewHarnessSuggestion;
  window.restoreHarnessSuggestion = restoreHarnessSuggestion;
  window.deleteHarnessHistoryEntry = deleteHarnessHistoryEntry;
  window.retryHarnessLastRequest = retryHarnessLastRequest;
  window.applyGraphHarness = applyGraphHarness;
  window.applySelectedGraphHarness = applySelectedGraphHarness;
  window.undoGraphHarness = undoGraphHarness;
  window.buildHarnessSnapshot = buildHarnessSnapshot;
