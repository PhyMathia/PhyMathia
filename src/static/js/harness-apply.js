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
  // 配方依赖预检（2026-10-09，全路径守卫）：按操作顺序在「实时配方库」上推演——
  // create_recipe 入册、delete_recipe 出册，任何 create_node.recipe_id /
  // update_recipe.recipe_id 不在当前册上就整批拒绝（返回失败文案；空串＝通过）。
  // 覆盖图指纹管不到的两件事：建议生成后配方被外部编辑/删除；同批「先删后建」的引用。
  // 只在 _applyOps 一处调用，所有应用路径（应用全部/应用所选/历史保留/撤销回放）统一生效。
  function _harnessRecipePreflight(ops) {
    const list = (ops || []).filter(op => op
      && ['create_recipe', 'update_recipe', 'delete_recipe', 'create_node'].includes(op.op || op.type || ''));
    if (!list.length) return '';
    if (typeof getUserRecipes !== 'function') return '配方库不可用，无法应用配方相关操作';
    const available = new Set(getUserRecipes().map(recipe => String((recipe && recipe.id) || '')));
    for (const op of list) {
      const name = op.op || op.type || '';
      if (name === 'create_recipe') {
        const createdId = String(op.recipe_id || op.recipeId || (op.recipe && op.recipe.id) || '');
        if (createdId) available.add(createdId);
        continue;
      }
      if (name === 'create_node') {
        const ref = String(op.recipe_id || op.recipeId || '');
        if (!ref) continue; // 普通节点（后端会给空 recipe_id）：与配方无关
        if (!available.has(ref)) return '要放置的配方不存在或已被删除，请重新生成建议后再应用';
        continue;
      }
      const rid = String(op.recipe_id || op.recipeId || (op.recipe && op.recipe.id) || '');
      if (!rid) return '操作缺少配方 ID，无法应用';
      if (name === 'delete_recipe') {
        if (!available.has(rid)) return '要删除的配方已不存在，请重新生成建议后再应用';
        available.delete(rid);
        continue;
      }
      // update_recipe：目标必须在实时库里（本批 create_recipe 创建的也算）
      if (!available.has(rid)) return '要修改的配方不存在或已被删除，请重新生成建议后再应用';
    }
    return '';
  }

  // reportMode（T96 会话事件日志）：'all' 应用全部 / 'selected' 应用所选 /
  // 'keep' 历史建议「保留修改」——要上报成 applied 批次；null＝调用方明确不上报
  // （对话式撤销应用的 inverse 操作，是回滚不是应用）。默认 'all' 兜住所有旧调用点。
  // eventIdOverride：从历史条目应用（keep）时传该条的 eventId——harnessResult 是
  // 「当前」结果，套在旧条目上会把归因错挂到别次请求（T96 归因链不能静默断/错）。
  async function _applyOps(ops, cleanupEval, reportMode = 'all', eventIdOverride = '') {
    if (!ops.length) return;
    const sessionId = _sessionId();
    const state = _harnessGraphState();
    if (!state) return;
    // T88 防重入（校验之后、动图之前）：本批建议已应用过就挡住——同批 ops 再空跑一次
    // 会把单槽 harnessCheckpoint 覆盖成已应用态，「撤销本次」从此失效。要重来先撤销
    // 或重新生成建议。标志由应用成功/撤销/新结果渲染/Φ 会话重置/新一轮生成负责复位。
    if (harnessResultApplied) {
      _setHarnessStatus('这条建议已经应用过：需要重来请先点「撤销本次」，或重新生成建议', 'error');
      return;
    }
    // 配方依赖预检（全路径，2026-10-09）：必须在动图/动配方库之前，对实时配方库按序
    // 判定（含 update/delete 目标缺失＝明确报错而不是静默空转）；失败整批拒绝。
    const recipeBlock = _harnessRecipePreflight(ops);
    if (recipeBlock) {
      _setHarnessStatus(recipeBlock, 'error');
      return;
    }
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
    // T96：图已落盘且已推服务端，异步上报这条应用批次（before＝上面的应用前深拷贝，
    // 是时间线「撤回到此」的恢复数据源）。fire-and-forget：事件日志是审计副产物，
    // 失败只 console.warn，绝不打扰应用主流程。
    if (reportMode) {
      _reportHarnessApplied({
        reportMode,
        ops,
        before,
        // T101：配方库前态随批次上报（该批动过配方才非 null）——跨批次时间线
        // 回滚据此还原配方库，与单槽 checkpoint 的 recipesBefore 兜底同口径
        recipesBefore,
        summary: (harnessResult && harnessResult.summary) || '',
        // review 响应里是 snake_case 的 event_id（harnessResult 直接存原始 result），
        // 驼峰 eventId 留给注入/旧形态，两者都认，别让归因链静默断掉
        eventId: eventIdOverride || (harnessResult && (harnessResult.eventId || harnessResult.event_id)) || '',
      });
    }
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
    // T122：独立结果区已取消。「已应用修改」改由状态行承担（上面 _setHarnessStatus），
    // 操作按钮行的禁用态与防重入标志在下面照旧处理。
    // T88：本批已应用——置位防重入标志并禁用两个应用按钮（「撤销本次」保持可用，
    // 用户撤销后可重新应用同批建议）。只用 getElementById＋属性赋值：回归脚本的
    // element() 桩没有 toggleAttribute/closest。
    harnessResultApplied = true;
    const applySelectedBtn = document.getElementById('graphHarnessApplySelectedBtn');
    if (applySelectedBtn) applySelectedBtn.disabled = true;
    const applyAllBtn = document.getElementById('graphHarnessApplyAllBtn');
    if (applyAllBtn) applyAllBtn.disabled = true;
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
    _applyOps(ops, true, 'all');
  }

  function applySelectedGraphHarness() {
    if (!_harnessCanApply(harnessResult?._binding)) return;
    const selected = _selectedOps();
    // null＝依赖缺失：_selectedOps 已给出「补勾依赖配方」的具体报错，这里必须原样
    // 返回，绝不能用下方「没有勾选任何操作」把它盖掉（空数组仍保留旧的空选语义）。
    if (selected === null) return;
    if (!selected.length) {
      _setHarnessStatus('没有勾选任何操作：勾选想保留的条目再点「应用所选」，或改用「应用全部」', 'error');
      return;
    }
    _applyOps(selected, false, 'selected');
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
    // T88 复位：撤销成功＝本批建议回到未应用态，重新放开两个应用按钮（同批可再应用）。
    // T122：过去还往独立结果区改口成「已撤销本次修改…」，该容器已取消，状态行承担。
    harnessResultApplied = false;
    const applySelectedBtn = document.getElementById('graphHarnessApplySelectedBtn');
    if (applySelectedBtn) applySelectedBtn.disabled = false;
    const applyAllBtn = document.getElementById('graphHarnessApplyAllBtn');
    if (applyAllBtn) applyAllBtn.disabled = false;
    // T96：撤销的是「当前有效批次里最后一条」，从服务端事件列表折算它的 seq 后上报
    //（单槽 harnessCheckpoint 对应的就是最后应用的那批）。查不到就不报，不硬造 seq。
    _harnessEffectiveAppliedBatches().then(batches => {
      const last = batches.length ? batches[batches.length - 1] : null;
      if (last && Number(last.seq) > 0) return _reportHarnessUndo(Number(last.seq));
      return null;
    }).catch(() => {});
  }

  // ===== T96 会话事件日志：应用/撤销上报与撤销时间线（2026-09-30）=====
  // 后端按 Φ 会话把事件逐行追加到 logs/harness_events/<phiId>.jsonl，seq＝行号（稳定）。
  // 前端这里负责三件事：把应用批次（含无损前态）与撤销动作上报；从事件列表折叠出
  // 「当前有效批次」；时间线面板支持撤回到任意批次之前。上报一律 fire-and-forget：
  // 事件日志是审计副产物，失败只 console.warn，绝不打扰画布主流程。
  async function _reportHarnessApplied(opts) {
    const info = opts || {};
    const mode = info.reportMode || '';
    const phiId = (typeof _phiId === 'function' ? _phiId() : '') || '';
    if (!mode || !phiId) return; // 无 Φ 会话（匿名/旧数据）或调用方明确不上报
    try {
      await harnessFetchJson('/api/harness/graph/apply_report', {
        session_id: phiId,
        event_id: info.eventId || '',
        applied_ops: Array.isArray(info.ops) ? info.ops : [],
        before_snapshot: info.before || null,
        // T101：配方三件套批次的前态副本；空/非数组发 null（后端守卫同款，不落字段）
        recipes_before: Array.isArray(info.recipesBefore) && info.recipesBefore.length ? info.recipesBefore : null,
        mode,
        summary: info.summary || '',
      });
      // apply_report 不返回 seq（seq 是落盘后的行号），这里只留「已上报」标记；
      // 撤销折算一律现查 _harnessEffectiveAppliedBatches()，不依赖这个全局。
      harnessLastAppliedReport = { eventId: info.eventId || '' };
    } catch (err) {
      console.warn('[Harness] 应用批次上报失败（不影响画布）：', (err && err.message) || err);
    }
  }

  // undoneFromSeq＝被回滚的第一条 applied 事件的 seq。缺省（对话式「↩ 撤销上一条」
  // 的调用形态）时折算当前最后一条有效 applied——它回滚的就是那批；不折出来就不报，
  // 绝不硬造 seq（时间线宁可多等一次刷新，也不要假 undo 事件）。
  async function _reportHarnessUndo(undoneFromSeq) {
    const phiId = (typeof _phiId === 'function' ? _phiId() : '') || '';
    if (!phiId) return;
    let seq = Number(undoneFromSeq) || 0;
    if (seq <= 0) {
      try {
        const batches = await _harnessEffectiveAppliedBatches();
        seq = batches.length ? Number(batches[batches.length - 1].seq) || 0 : 0;
      } catch (err) {
        seq = 0;
      }
    }
    if (seq <= 0) return;
    try {
      await harnessFetchJson('/api/harness/graph/undo_report', { session_id: phiId, undone_from_seq: seq });
    } catch (err) {
      console.warn('[Harness] 撤销上报失败（不影响画布）：', (err && err.message) || err);
    }
  }

  // GET applied+undo 事件，按 seq 升序折叠出「当前有效批次」：applied 压栈；undo 把
  // seq >= undone_from_seq 的批次全弹出（后端口径：undo 之后新应用的批次 seq 更大，
  // 自然重新入栈）。返回数组按 seq 升序＝时间线从上到下的渲染顺序。
  async function _harnessEffectiveAppliedBatches() {
    const phiId = (typeof _phiId === 'function' ? _phiId() : '') || '';
    if (!phiId) return [];
    const url = '/api/harness/graph/events?session_id=' + encodeURIComponent(phiId)
      + '&types=applied,undo&limit=200';
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    if (!data || data.status === 'error' || !Array.isArray(data.events)) throw new Error('响应缺 events');
    const stack = [];
    data.events.forEach(evt => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'applied') {
        stack.push(evt);
      } else if (evt.type === 'undo') {
        const from = Number(evt.undone_from_seq) || 0;
        for (let i = stack.length - 1; i >= 0; i--) {
          if ((Number(stack[i].seq) || 0) >= from) stack.splice(i, 1);
        }
      }
    });
    return stack;
  }

  // 事件 ts：服务端落的是 epoch 秒（events.py 的 round(time.time(), 3)）；ISO 串
  // 也照收（防手写/旧数据）。坏值返回空串，行里就不显示时间。
  function _harnessUndoTimeText(ts) {
    let d = null;
    if (typeof ts === 'number' && isFinite(ts)) d = new Date(ts * 1000);
    else if (typeof ts === 'string' && ts) d = new Date(ts);
    if (!d || isNaN(d.getTime())) return '';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function _harnessUndoTimelineRowHtml(evt) {
    const seq = Number(evt.seq) || 0;
    const count = Number(evt.ops_count) || 0;
    const summary = String(evt.summary || '').trim();
    const time = _harnessUndoTimeText(evt.ts);
    const meta = '#' + seq
      + (time ? ' · ' + time : '')
      + ' · ' + count + ' 条修改 · ' + _escapeHtml(summary ? summary.slice(0, 30) : '（无摘要）');
    return '<div class="graph-harness-undo-row">'
      + '<span class="graph-harness-undo-row-meta">' + meta + '</span>'
      + '<button type="button" class="graph-harness-undo-rollback" onclick="_harnessUndoTimelineRollback(\''
      + _escapeHtml(String(evt.id || '')) + '\', ' + seq
      + ')" title="回滚到这一批次应用之前的画布">撤回到此</button>'
      + '</div>';
  }

  async function _refreshHarnessUndoTimeline() {
    const box = document.getElementById('graphHarnessUndoTimeline');
    if (!box || box.hidden) return;
    box.innerHTML = '<div class="graph-harness-undo-empty">正在加载撤销历史…</div>';
    let batches = [];
    try {
      batches = await _harnessEffectiveAppliedBatches();
    } catch (err) {
      box.innerHTML = '<div class="graph-harness-undo-empty">撤销历史加载失败，请重试</div>';
      return;
    }
    box.innerHTML = batches.length
      ? batches.map(_harnessUndoTimelineRowHtml).join('')
      : '<div class="graph-harness-undo-empty">还没有已应用的批次</div>';
  }

  // 时间线显隐（getElementById＋hidden 属性赋值，T88 口径：回归脚本的 element 桩
  // 没有 toggleAttribute/closest）。每次打开都重新拉一次事件，列表与服务端状态对齐。
  async function toggleHarnessUndoTimeline() {
    if (!((typeof _phiId === 'function' ? _phiId() : '') || '')) {
      _setHarnessStatus('当前没有 Φ 会话', 'error');
      return;
    }
    const box = document.getElementById('graphHarnessUndoTimeline');
    if (!box) return;
    if (!box.hidden) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    await _refreshHarnessUndoTimeline();
  }

  // 「撤回到此」：用该行事件 id 精确取回它自己的 before_snapshot（GET 单条事件隐含
  // 带快照），拿不到就不动画布——没有无损前态的整图回滚等于毁图。
  async function _harnessUndoTimelineRollback(eventId, seq) {
    const phiId = (typeof _phiId === 'function' ? _phiId() : '') || '';
    if (!phiId) {
      _setHarnessStatus('当前没有 Φ 会话', 'error');
      return;
    }
    let before = null;
    let recipesBefore = null;
    try {
      const url = '/api/harness/graph/events?session_id=' + encodeURIComponent(phiId)
        + '&event_id=' + encodeURIComponent(String(eventId || ''));
      const resp = await fetch(url);
      const data = resp.ok ? await resp.json() : null;
      const evt = data && Array.isArray(data.events) ? data.events[0] : null;
      before = evt && evt.before_snapshot ? evt.before_snapshot : null;
      recipesBefore = evt && Array.isArray(evt.recipes_before) ? evt.recipes_before : null;
    } catch (err) {
      before = null;
    }
    if (!before) {
      _setHarnessStatus('找不到该批次的无损前态，无法回滚', 'error');
      return;
    }
    // T101：先把「将被回滚的批次」对应的历史条目 decision 翻成已忽略（必须在
    // 上报 undo 之前取批次列表——undo 事件落盘后这批就不在有效栈里了）
    try { await _harnessFlipHistoryDecisionsFromSeq(Number(seq) || 0); } catch (err) {}
    _restoreHarnessBeforeSnapshot(before, Number(seq) || 0, recipesBefore);
  }

  // 时间线回滚的语义补全（T101）：被回滚批次（seq >= undone_from_seq 的有效批次，
  // 对应关系＝applied 事件的 event_id 就是产生那批 ops 的 review 事件 id）如果
  // 历史条目还挂着 decision='keep'，一律翻成 discard——画布已回到批次之前，历史
  // 里再标「已保留」就是在说谎。fire-and-forget，失败只走 catch 静默。
  async function _harnessFlipHistoryDecisionsFromSeq(seq) {
    if (!(Number(seq) > 0)) return;
    const batches = await _harnessEffectiveAppliedBatches();
    const poppedIds = new Set(batches
      .filter(b => (Number(b.seq) || 0) >= seq && b.event_id)
      .map(b => String(b.event_id)));
    if (!poppedIds.size) return;
    let changed = false;
    (harnessHistory || []).forEach(entry => {
      if (entry && entry.role === 'assistant' && entry.decision === 'keep'
        && poppedIds.has(String(entry.eventId || ''))) {
        entry.decision = 'discard';
        entry.discardedAt = Date.now();
        changed = true;
      }
    });
    if (changed) _saveHarnessHistory().then(_renderHarnessChat);
  }

  // 时间线整图回滚：恢复语义与 undoGraphHarness 同口径（快照整份写回当前画布，
  // 与 undoGraphHarness 一样用 _sessionId()——改图只落在当前打开的画布上）。
  // 回滚后面板回到「未应用」态，并上报 undo 事件（上报完再刷新时间线，别让列表
  // 抢在读请求前拿到旧状态）。recipesBefore（T101）：批次动过配方库时随前态
  // 还原——不带就说明该批次没动配方，别碰当前配方库。
  function _restoreHarnessBeforeSnapshot(before, undoneFromSeq, recipesBefore) {
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo(false, { source: 'undo', summary: '撤销时间线回滚' });
    if (typeof window.saveGraphState === 'function') window.saveGraphState(_sessionId(), before);
    if (Array.isArray(recipesBefore) && typeof setUserRecipes === 'function') {
      setUserRecipes(recipesBefore);
      if (typeof _recipeRefreshAddPanel === 'function') _recipeRefreshAddPanel();
    }
    if (typeof window.flushGraphStateServerSave === 'function') window.flushGraphStateServerSave();
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    harnessLastAppliedOps = [];
    harnessLastAppliedBeforeSnapshot = null;
    harnessLastAppliedReport = null;
    harnessResultApplied = false;
    const applySelectedBtn = document.getElementById('graphHarnessApplySelectedBtn');
    if (applySelectedBtn) applySelectedBtn.disabled = false;
    const applyAllBtn = document.getElementById('graphHarnessApplyAllBtn');
    if (applyAllBtn) applyAllBtn.disabled = false;
    // T122：过去这里往独立结果区写一句「已回滚到所选批次之前」。结果区已取消，
    // 这句话由上面的 _setHarnessStatus 承担（状态行不会被对话流冲走）。
    _setHarnessStatus('已回滚到所选批次之前', 'ok');
    _reportHarnessUndo(undoneFromSeq).then(() => { _refreshHarnessUndoTimeline(); });
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
    _applyOps(entry.operations || [], entry.phase === 'apply', 'keep', entry.eventId || '');
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
  // T99：中断条目上的「▶ 从中断处继续」内联 onclick 走这里
  window.continueHarnessInterrupted = continueHarnessInterrupted;
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
  // T96：撤销时间线（composer 的「🕘 撤销历史」内联 onclick 走这里；折叠折算与
  // 整图回滚一并导出，冒烟/真机脚本可直接取证）
  window.toggleHarnessUndoTimeline = toggleHarnessUndoTimeline;
  window._harnessEffectiveAppliedBatches = _harnessEffectiveAppliedBatches;
  window._restoreHarnessBeforeSnapshot = _restoreHarnessBeforeSnapshot;
  window._harnessUndoTimelineRollback = _harnessUndoTimelineRollback;
  window.syncHarnessNodesToKnowledge = _syncHarnessNodesToKnowledge;
  // smoke 专用出口（P3）：配方三件套 op 的应用路径——配方分支不碰图状态，传空即可
  window._applyHarnessOpsForTest = ops => (ops || []).forEach(op => _applyOneHarnessOp(op, null, new Map()));
  window.buildHarnessSnapshot = buildHarnessSnapshot;
  window._harnessContinentShared = _harnessContinentShared; // 大陆 v3：跨画布共享点口径（smoke 断言用）
