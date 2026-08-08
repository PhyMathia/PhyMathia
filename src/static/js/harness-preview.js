// ===== PhyMathia 图编辑 harness：结果渲染与图预览 =====

  function renderHarnessResult(data) {
    const resultBox = document.getElementById('graphHarnessResult');
    if (!resultBox) return;
    if (data.status === 'error' || data.status === 'parse_error' || data.status === 'invalid') {
      const errors = (data.errors || []).map(item => item.reason || '未知错误').join('<br>');
      resultBox.innerHTML = '<div class="graph-harness-error">' + _escapeHtml(errors || data.status) + '</div>';
      _setHarnessStatus('未执行任何图修改', 'error');
      _showHarnessRetry(errors || data.status);
      return;
    }

    const summary = String(data.summary || '').trim();
    const ops = Array.isArray(data.operations) ? data.operations : [];
    const errors = (data.errors || []).map(item => item.reason || '').filter(Boolean);
    let html = '';
    if (summary) html += '<div class="graph-harness-summary">' + _escapeHtml(summary) + '</div>';
    if (errors.length) {
      html += '<div class="graph-harness-errors"><strong>跳过的操作</strong>'
        + errors.map(item => '<div>' + _escapeHtml(item) + '</div>').join('') + '</div>';
    }
    if (!ops.length) {
      html += '<div class="graph-harness-empty">模型没有提出可执行修改</div>';
    } else {
      html += ops.map((op, index) => ''
        + '<label class="graph-harness-op graph-harness-op-' + _escapeHtml(op.op || op.type || '') + '">'
        + '<input type="checkbox" checked data-op-index="' + index + '">'
        + '<span class="graph-harness-op-main">' + _escapeHtml(_opDescription(op)) + '</span>'
        + '<span class="graph-harness-op-reason">' + _escapeHtml(op.reason || '') + '</span>'
        + '</label>').join('');
    }
    resultBox.innerHTML = html;
    const statusLabel = harnessPhase === 'evaluate'
      ? '评价节点生成候选'
      : harnessPhase === 'apply'
        ? '建议应用候选'
        : '审阅完成';
    _setHarnessStatus(statusLabel + '：' + (ops.length ? ops.length + ' 条操作' : '无修改'), 'ok');
    document.getElementById('graphHarnessApplyActions')?.toggleAttribute('hidden', !ops.length);
  }

  function _selectedOps() {
    if (!harnessResult) return [];
    const ops = Array.isArray(harnessResult.operations) ? harnessResult.operations : [];
    const boxes = harnessPanel?.querySelectorAll('.graph-harness-op input[type="checkbox"]') || [];
    const selected = Array.from(boxes)
      .filter(box => box.checked)
      .map(box => ops[Number(box.dataset.opIndex)])
      .filter(Boolean);
    return selected.length ? selected : ops;
  }

  function _nextNodePosition(count) {
    const angle = count * 2.399963;
    const ring = 220 + Math.floor(count / 8) * 150;
    return {
      x: Math.round(Math.cos(angle) * ring),
      y: Math.round(Math.sin(angle) * ring),
    };
  }

  function _previewNodePosition(id) {
    if (typeof window.getGraphPreviewNodes !== 'function') return null;
    const node = window.getGraphPreviewNodes().find(item => item.id === id);
    return node && Number.isFinite(node.x) && Number.isFinite(node.y)
      ? { x: node.x, y: node.y }
      : null;
  }

  function _newHarnessNode(id, op, pos) {
    const kind = op.kind || 'knowledge';
    const label = String(op.label || op.title || '节点');
    const content = String(op.content || '');
    const formula = String(op.formula || '');
    const isManual = ['knowledge', 'relation', 'human_note', 'note', 'source', 'blank'].includes(kind);
    return {
      id,
      kind,
      moduleKey: kind === 'module'
        ? String(op.module_key || op.moduleKey || '')
        : (kind === 'hub' || kind === 'summary' || kind === 'note' ? (op.module_key || op.moduleKey || '') : ''),
      manual: kind === 'answer' ? !!op.manual : (kind === 'user' ? false : isManual),
      content,
      status: 'done',
      summary: content.slice(0, 120),
      analysis: '',
      analysisHash: '',
      inputHash: '',
      generatedAt: 0,
      requirements: '',
      busy: false,
      generated: false,
      maxItems: kind === 'source' ? 5 : 0,
      items: [],
      edges: [],
      fileId: '',
      fileName: '',
      generatedNodeIds: [],
      category: '',
      formulas: formula ? [formula] : [],
      knowledgeKey: '',
      label,
      title: kind === 'knowledge' ? label : '',
      formula,
      x: pos.x,
      y: pos.y,
      depth: kind === 'summary' || kind === 'note' ? 4 : (kind === 'blank' || kind === 'hub' ? 3 : 2),
      targetAngle: 0,
      isRoot: false,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: kind === 'human_note' || kind === 'knowledge' ? 260 : null,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
  }

  function _newAiEvalNode(id, op, pos) {
    const parts = _edgeParts(op.edge_key || op.key);
    const targetId = parts ? parts.from : (op.target_node_id || op.target || '');
    const targetLabel = op.target_label || targetId || '目标节点';
    const suggestion = String(op.suggestion || op.content || '');
    const priority = ['high', 'medium', 'low'].includes(op.priority) ? op.priority : 'medium';
    return {
      id,
      kind: 'ai_eval',
      moduleKey: '',
      manual: false,
      content: suggestion,
      status: 'pending',
      summary: suggestion.slice(0, 120),
      analysis: '',
      analysisHash: '',
      inputHash: '',
      generatedAt: 0,
      requirements: '',
      busy: false,
      generated: false,
      maxItems: 0,
      items: [],
      edges: [],
      fileId: '',
      fileName: '',
      generatedNodeIds: [],
      category: '',
      formulas: [],
      knowledgeKey: '',
      label: op.label || ('对「' + targetLabel + '」的建议'),
      title: '',
      formula: '',
      target_node_id: targetId,
      target_label: targetLabel,
      suggestion,
      priority,
      x: pos.x,
      y: pos.y,
      depth: 4,
      targetAngle: 0,
      isRoot: false,
      timestamp: Date.now(),
      pinned: false,
      fixedX: null,
      fixedY: null,
      customWidth: 280,
      customHeight: null,
      w: 0,
      h: 0,
      vx: 0,
      vy: 0,
    };
  }

  function _buildHarnessPreview(ops) {
    const state = _graphState() || {};
    const existingNodes = _graphNodes();
    const existingById = new Map(existingNodes.map(node => [node.id, node]));
    const existingIds = new Set(existingById.keys());
    const canvas = document.getElementById('graphCanvas');
    const canvasRect = canvas?.getBoundingClientRect();
    const pan = state.pan || { x: 80, y: 80 };
    const zoom = state.zoom || 0.9;
    const centerX = canvasRect && canvasRect.width ? (canvasRect.width / 2 - pan.x) / zoom : 0;
    const centerY = canvasRect && canvasRect.height ? (canvasRect.height / 2 - pan.y) / zoom : 0;
    const center = { x: centerX, y: centerY };
    const newAnchorById = new Map();

    (ops || []).forEach(op => {
      const name = op.op || op.type || '';
      if (name === 'create_eval_node') {
        const newId = op.assigned_id || op.id || op.temp_id;
        const parts = _edgeParts(op.edge_key || op.key);
        const targetId = parts ? parts.from : (op.target_node_id || op.target || '');
        if (newId && targetId && existingById.has(targetId)) newAnchorById.set(newId, existingById.get(targetId));
      } else if (name === 'add_edge') {
        const parts = _edgeParts(op.edge_key || op.key);
        const from = parts ? parts.from : op.from;
        const to = parts ? parts.to : op.to;
        const anchorId = existingById.has(from) ? from : (existingById.has(to) ? to : '');
        const newEndpoint = !existingById.has(from) ? from : (!existingById.has(to) ? to : '');
        if (newEndpoint && anchorId) newAnchorById.set(newEndpoint, existingById.get(anchorId));
      }
    });

    const previewById = new Map();
    const previews = [];
    const edges = [];
    const seenEdgeKeys = new Set();

    function addPreview(id, op, kind) {
      if (!id || existingIds.has(id) || previewById.has(id)) return;
      const anchor = newAnchorById.get(id) || center;
      const angle = previews.length * 2.399963;
      const pos = {
        x: Math.round(anchor.x + Math.cos(angle) * 180),
        y: Math.round(anchor.y + Math.sin(angle) * 140),
      };
      const moduleKey = op.module_key || op.moduleKey || '';
      const fallbackLabel = kind === 'module' ? _moduleLabel(moduleKey) : _kindLabel(kind);
      previewById.set(id, {
        id,
        kind,
        label: String(op.label || op.title || fallbackLabel || '新节点'),
        x: pos.x,
        y: pos.y,
        w: 220,
        h: kind === 'ai_eval' ? 112 : 78,
      });
      previews.push(previewById.get(id));
    }

    function addEdge(from, to, fromPort, toPort, relation, label) {
      if (!from || !to) return;
      const key = _edgeKey({ from, fromPort, to, toPort });
      if (seenEdgeKeys.has(key)) return;
      seenEdgeKeys.add(key);
      edges.push({ from, to, fromPort, toPort, relation: String(relation || ''), label: String(label || '') });
    }

    (ops || []).forEach(op => {
      const name = op.op || op.type || '';
      if (name === 'create_node' || name === 'create_eval_node') {
        const kind = name === 'create_eval_node' ? 'ai_eval' : (op.kind || 'knowledge');
        addPreview(op.assigned_id || op.id || op.temp_id, op, kind);
      }
    });

    (ops || []).forEach(op => {
      const name = op.op || op.type || '';
      if (name === 'create_eval_node') {
        const id = op.assigned_id || op.id || op.temp_id;
        const parts = _edgeParts(op.edge_key || op.key);
        const from = parts ? parts.from : (op.target_node_id || op.target || op.from);
        const to = parts ? parts.to : id;
        const fromPort = (parts ? parts.fromPort : op.fromPort) || 'out-0';
        const toPort = (parts ? parts.toPort : op.toPort) || 'in-0';
        addEdge(from, to, fromPort, toPort, '评价', '评价');
      } else if (name === 'add_edge') {
        const parts = _edgeParts(op.edge_key || op.key);
        const from = parts ? parts.from : op.from;
        const to = parts ? parts.to : op.to;
        const fromPort = (parts ? parts.fromPort : op.fromPort) || 'out-0';
        const toPort = (parts ? parts.toPort : op.toPort) || 'in-0';
        addEdge(from, to, fromPort, toPort, op.relation, op.label);
      }
    });

    return { nodes: previews, edges };
  }

  function _prepareHarnessNodeReuse(id, state) {
    if (!id) return false;
    state.harnessDeleted = state.harnessDeleted || {};
    const existing = state.customNodes.find(node => node.id === id);
    if (existing && !state.harnessDeleted[id]) return false;
    if (existing) state.customNodes = state.customNodes.filter(node => node.id !== id);
    delete state.harnessDeleted[id];
    delete state.positions[id];
    delete state.sizes[id];
    delete state.pinned[id];
    delete state.inputPortCounts[id];
    state.connections = state.connections.filter(edge => edge.from !== id && edge.to !== id);
    return true;
  }
