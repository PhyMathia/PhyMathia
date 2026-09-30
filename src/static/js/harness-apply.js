// ===== PhyMathia 图编辑 harness：应用操作与建议（含 window 导出）=====

  function _applyOneHarnessOp(op, state, nodeKindById) {
    const opName = op.op || op.type || '';
    // ---- 配方库操作（P3 创造模式）：落前端配方库（localStorage＋服务端镜像），不动图 ----
    if (opName === 'create_recipe' || opName === 'update_recipe' || opName === 'delete_recipe') {
      if (typeof getUserRecipes !== 'function' || typeof setUserRecipes !== 'function') return;
      const list = getUserRecipes();
      if (opName === 'create_recipe' && op.recipe) {
        const created = { ...op.recipe, createdAt: Date.now(), updatedAt: Date.now() };
        setUserRecipes([...list.filter(item => item.id !== created.id), created]);
      } else if (opName === 'update_recipe' && op.recipe && op.recipe_id) {
        const prev = list.find(item => item.id === op.recipe_id);
        const updated = { ...op.recipe, id: op.recipe_id,
          createdAt: (prev && prev.createdAt) || Date.now(), updatedAt: Date.now() };
        setUserRecipes(list.map(item => item.id === op.recipe_id ? updated : item));
      } else if (opName === 'delete_recipe' && op.recipe_id) {
        setUserRecipes(list.filter(item => item.id !== op.recipe_id));
      }
      if (typeof _recipeRefreshAddPanel === 'function') _recipeRefreshAddPanel();
      return;
    }
    const name = op.op || op.type || '';
    if (name === 'restore_node') {
      const node = JSON.parse(JSON.stringify(op.node || {}));
      const id = op.id || node.id;
      const local = node._undoLocal;
      delete node._undoLocal;
      node.id = id;
      state.customNodes = (state.customNodes || []).filter(item => item.id !== id);
      if (!local || local.custom) state.customNodes.push(node);
      if (local) {
        for (const key of ['harnessNodeOverrides', 'harnessDeleted', 'positions', 'sizes', 'pinned', 'inputPortCounts']) {
          state[key] = state[key] || {};
          const saved = local.fields[key] || {};
          if (Object.prototype.hasOwnProperty.call(saved, 'value')) state[key][id] = saved.value;
          else delete state[key][id];
        }
      } else {
        delete state.harnessDeleted[id];
      }
      return;
    }
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
    const workflowIds = [];
    for (const id of ids) {
      const node = (typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : []).find(item => item.id === id);
      if (!node) continue;
      if (node.kind === 'knowledge' && typeof window.generateKnowledgeNode === 'function') {
        window.generateKnowledgeNode(id);
      } else if (node.kind === 'relation' && typeof window.generateRelationNode === 'function') {
        window.generateRelationNode(id);
      } else if (node.kind === 'module' || node.kind === 'blank' || node.kind === 'summary' || (node.kind === 'answer' && !node.manual)) {
        workflowIds.push(id);
      }
    }
    if (workflowIds.length) {
      if (typeof window.runWorkflowNodes === 'function') {
        await window.runWorkflowNodes(workflowIds);
      } else if (typeof window.runWorkflowNode === 'function') {
        for (const id of workflowIds) await window.runWorkflowNode(id, true);
      }
    }
  }

  function _collectHarnessKnowledgeOps(ops) {
    const map = {};
    for (const op of ops || []) {
      const name = op.op || op.type || '';
      if (name === 'create_node') {
        const id = op.assigned_id || op.id || op.temp_id;
        if (!id) continue;
        map[id] = { kind: op.kind || '', label: op.label || '', content: op.content || op.summary || '', formula: op.formula || '', moduleKey: op.module_key || op.moduleKey || '' };
      } else if (name === 'update_node') {
        const id = op.id;
        if (!id) continue;
        const patch = op.patch || {};
        const cur = map[id] || { kind: '', label: '', content: '', formula: '', moduleKey: '' };
        if (patch.label != null) cur.label = String(patch.label);
        if (patch.title != null && !cur.label) cur.label = String(patch.title);
        if (patch.content != null) cur.content = String(patch.content);
        if (patch.formula != null) cur.formula = String(patch.formula);
        if (patch.module_key != null) cur.moduleKey = String(patch.module_key);
        map[id] = cur;
      }
    }
    return map;
  }

  function _syncHarnessNodesToKnowledge(ops) {
    try {
      const sessionId = _sessionId();
      const touched = _collectHarnessKnowledgeOps(ops);
      const ids = Object.keys(touched);
      if (!ids.length) return;
      const nodes = (typeof window.getGraphViewNodes === 'function') ? window.getGraphViewNodes() : [];
      const byId = {};
      nodes.forEach(n => { byId[String(n.id)] = n; });
      const state = _harnessGraphState() || {};
      const overrides = state.harnessNodeOverrides || {};
      const finalData = {};
      ids.forEach(id => {
        const n = byId[id] || {};
        const ov = overrides[id] || {};
        const t = touched[id] || {};
        finalData[id] = {
          kind: n.kind || t.kind || '',
          label: String(n.label || n.title || ov.label || t.label || ''),
          content: String(n.content || n.summary || ov.content || t.content || ''),
          formula: String(n.formula || ov.formula || t.formula || ''),
          moduleKey: String(n.moduleKey || n.module_key || ov.module_key || t.moduleKey || ''),
        };
      });
      const existing = (typeof getKnowledgeItems === 'function') ? getKnowledgeItems() : {};
      const formulas = [];
      let changed = false;
      const dedup = (title) => (typeof _knowledgeDedupKey === 'function') ? _knowledgeDedupKey(title) : String(title || '').trim().toLowerCase();
      Object.keys(finalData).forEach(id => {
        const d = finalData[id];
        if (d.kind === 'knowledge' && d.label) {
          const key = dedup(d.label);
          const found = Object.values(existing).find(e => e.sessionId === sessionId && dedup(e.title) === key);
          if (found) {
            if (d.content && d.content.length > (found.summary || '').length) found.summary = d.content;
            if (d.formula && !(found.formulas || []).includes(d.formula)) found.formulas = (found.formulas || []).concat([d.formula]);
            changed = true;
          } else {
            const id2 = 'ki_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : String(Date.now()) + Math.random().toString(36).slice(2, 8));
            existing[id2] = {
              id: id2,
              title: d.label,
              category: 'other',
              tags: [],
              summary: d.content || '',
              content: d.content || '',
              formulas: d.formula ? [d.formula] : [],
              source: 'harness',
              sessionId: sessionId,
              messageId: '',
              moduleKey: d.moduleKey || 'knowledge',
              createdAt: Date.now(),
            };
            changed = true;
          }
        }
        if (d.formula) {
          formulas.push({ latex: d.formula, concept: d.label || d.kind || '知识点', meaning: '', meaningSource: 'local', topic: '', related: [], sessionId: sessionId, messageId: '', moduleKey: d.moduleKey || d.kind || '', createdAt: Date.now() });
        }
      });
      if (changed && typeof saveKnowledgeItems === 'function') saveKnowledgeItems(existing);
      if (formulas.length && typeof saveFormulasToServer === 'function') saveFormulasToServer(formulas);
      if (typeof window.invalidateKnowledgeCache === 'function') window.invalidateKnowledgeCache();
      if (typeof refreshKnowledgePanelIfOpen === 'function') refreshKnowledgePanelIfOpen();
    } catch (e) {
      console.warn('Harness knowledge sync failed:', e);
    }
  }
  async function _applyOps(ops, cleanupEval) {
    if (!ops.length) return;
    const sessionId = _sessionId();
    const state = _harnessGraphState();
    if (!state) return;
    const before = JSON.parse(JSON.stringify(state));
    const preIssues = (typeof window.scanGraphConsistency === 'function') ? window.scanGraphConsistency() : [];
    harnessLastAppliedOps = Array.isArray(ops) ? ops.slice() : [];
    harnessLastAppliedBeforeSnapshot = _harnessUndoSnapshot(state);
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo(false, { source: 'harness', summary: (harnessResult && harnessResult.summary) || 'AI 修改' });
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
    const hasRecipeOps = ops.some(op => ['create_recipe', 'update_recipe', 'delete_recipe'].includes(op.op || op.type || ''));
    const recipesBefore = hasRecipeOps && typeof getUserRecipes === 'function' ? getUserRecipes().slice() : null;
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
      // 配方库操作的前态副本（P3）：图状态 checkpoint 不含配方库，单独存这里，
      // 「撤销本次」时一并还原（对话式逆操作只覆盖 create_recipe，这里兜住全部三类）
      ...(recipesBefore ? { recipesBefore } : {}),
    };
    if (typeof window.saveGraphState === 'function') window.saveGraphState(sessionId, state);
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
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
    setTimeout(() => {
      if (sessionId !== _sessionId()) return;
      Promise.resolve(_generateHarnessCreatedContent(ops)).catch(() => {}).then(() => {
        if (sessionId === _sessionId()) _syncHarnessNodesToKnowledge(ops);
      });
    }, 100);
    if (typeof window.scanGraphConsistency === 'function') {
      const postIssues = window.scanGraphConsistency();
      const sig = function (i) { return i.type + '|' + (i.nodeId || '') + '|' + (i.edgeKey || '') + '|' + (i.message || ''); };
      const preSigs = preIssues.map(sig);
      const newIssues = postIssues.filter(function (i) { return preSigs.indexOf(sig(i)) < 0; });
      if (newIssues.length) {
        _setHarnessStatus('⚠ 体检：本次修改后新增 ' + newIssues.length + ' 个问题（孤儿/断链/重复），可点工具栏体检查看', 'warning');
      }
    }
  }

  function applyGraphHarness() {
    if (!_harnessCanApply(harnessResult?._binding)) return;
    const ops = Array.isArray(harnessResult?.operations) ? harnessResult.operations : [];
    _applyOps(ops, true);
  }

  function applySelectedGraphHarness() {
    if (!_harnessCanApply(harnessResult?._binding)) return;
    const selected = _selectedOps();
    if (!selected.length) {
      _setHarnessStatus('没有勾选任何操作：勾选想保留的条目再点「应用所选」，或改用「应用全部」', 'error');
      return;
    }
    _applyOps(selected, false);
  }

  function undoGraphHarness() {
    harnessLastAppliedOps = [];
    harnessLastAppliedBeforeSnapshot = null;
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo(false, { source: 'undo', summary: '撤销整张画布的修改' });
    const state = _harnessGraphState();
    const checkpoint = state?.harnessCheckpoint;
    if (!checkpoint?.before) {
      _setHarnessStatus('没有可撤销的 harness 修改', 'error');
      return;
    }
    if (typeof window.saveGraphState === 'function') window.saveGraphState(_sessionId(), checkpoint.before);
    if (checkpoint.recipesBefore && typeof setUserRecipes === 'function') {
      setUserRecipes(checkpoint.recipesBefore);
      if (typeof _recipeRefreshAddPanel === 'function') _recipeRefreshAddPanel();
    }
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessStatus('已撤销本次修改' + (checkpoint.recipesBefore ? '（配方库已一并还原）' : ''), 'ok');
    harnessPhiCelebrate = true;
    _setPhiMode('celebrate');
    window.setTimeout(() => {
      if (!harnessBusy) _setPhiMode(harnessPhiError ? 'error' : 'idle');
    }, 2600);
  }

  // 按 id 精确移除节点（只动传入的 id，不做全局清扫）
  function _removeEvalNodesByIds(evalIds) {
    const state = _harnessGraphState();
    if (!state || !evalIds || !evalIds.length) return;
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo(false, { source: 'undo', summary: '移除全部 AI 评价节点' });
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
    if (!_harnessCanApply(entry._binding)) return;
    _applyOps(entry.operations || [], entry.phase === 'apply');
    entry.decision = 'keep';
    entry.appliedAt = Date.now();
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function discardHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry || entry.decision !== 'pending') return;
    // 拒绝只清理"本条建议自己创建"的评价节点，不动画布上其他内容（此前全局清场会误伤已保留的图）
    const ownEvalIds = (entry.operations || [])
      .filter(op => op && op.op === 'create_eval_node')
      .map(op => op.assigned_id || op.id)
      .filter(Boolean);
    if (entry.phase === 'apply' && ownEvalIds.length) {
      const alive = (_harnessGraphState()?.customNodes || [])
        .filter(node => node.kind === 'ai_eval' && ownEvalIds.includes(node.id))
        .map(node => node.id);
      _removeEvalNodesByIds(alive);
    }
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
    window.showGraphHarnessPreview(preview.nodes, preview.edges);
    _setHarnessStatus('已显示 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线', 'ok');
  }

  // 把某条历史建议创建过的节点从 harnessDeleted 软删除集中解除（恢复出口）
  function _undeleteEntryNodes(entry) {
    const state = _harnessGraphState();
    if (!state || !entry) return;
    const ids = (entry.operations || [])
      .filter(op => op && String(op.op || '').indexOf('create') === 0)
      .map(op => op.assigned_id || op.id || op.temp_id)
      .filter(Boolean);
    let restored = 0;
    ids.forEach(id => {
      if (state.harnessDeleted && state.harnessDeleted[id]) {
        delete state.harnessDeleted[id];
        restored++;
      }
    });
    if (restored) {
      if (typeof window.saveGraphState === 'function') window.saveGraphState(_sessionId(), state);
      if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    }
    return restored;
  }

  function restoreHarnessSuggestion(entryId) {
    const entry = harnessHistory.find(item => item.id === entryId);
    if (!entry || entry.decision !== 'discard') return;
    _undeleteEntryNodes(entry);
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
    const state = _harnessGraphState() || {};
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
  window.syncHarnessNodesToKnowledge = _syncHarnessNodesToKnowledge;
  // smoke 专用出口（P3）：配方三件套 op 的应用路径——配方分支不碰图状态，传空即可
  window._applyHarnessOpsForTest = ops => (ops || []).forEach(op => _applyOneHarnessOp(op, null, new Map()));
  window.buildHarnessSnapshot = buildHarnessSnapshot;
  window._harnessContinentShared = _harnessContinentShared; // 大陆 v3：跨画布共享点口径（smoke 断言用）
