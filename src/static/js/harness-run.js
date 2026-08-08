// ===== PhyMathia 图编辑 harness：评审运行与澄清 =====

  async function runGraphHarness(phase = 'normal') {
    const instruction = String(document.getElementById('graphHarnessInstruction')?.value || '').trim();
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = '';
    const model = typeof window.getActiveModelForRole === 'function'
      ? window.getActiveModelForRole('agent')
      : null;
    if (!model) {
      _setHarnessStatus('请先配置主模型', 'error');
      return;
    }
    const state = _graphState() || {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const evalNodes = _graphNodes().filter(node => node.kind === 'ai_eval' && !deleted.has(node.id));
    const requestedPhase = phase || 'normal';
    harnessPhase = requestedPhase === 'normal'
      ? _detectHarnessPhase(instruction, evalNodes)
      : requestedPhase;
    harnessLastInstruction = instruction;
    harnessLastPhase = harnessPhase;
    _appendHarnessHistory({
      id: _historyId(),
      role: 'user',
      content: instruction,
      phase: harnessPhase,
      timestamp: Date.now(),
    });
    if (harnessPhase === 'evaluate' && evalNodes.length) {
      _setHarnessStatus('请先应用或删除现有 AI 评价节点', 'error');
      return;
    }
    if (harnessPhase === 'apply' && !evalNodes.length) {
      _setHarnessStatus('当前没有 AI 评价节点', 'error');
      return;
    }
    let focusIds = [];
    if (!harnessSingleEvalId) {
      const candidateFocusIds = _detectFocusNodeIds(instruction, _graphNodes().filter(node => !deleted.has(node.id)));
      if (candidateFocusIds.length > 1) {
        _setHarnessBusy(true);
        _setHarnessStatus('正在理解目标...', 'running');
        let resolved = null;
        try {
          resolved = await _resolveHarnessFocus(candidateFocusIds, instruction);
        } catch (err) {
          resolved = null;
          focusIds = [];
          _setHarnessStatus('目标解析失败，已按当前图继续：' + err.message, 'running');
        }
        if (resolved && resolved.status === 'error') {
          focusIds = [];
          const reason = resolved.errors?.[0]?.reason || resolved.question || '目标解析失败';
          _setHarnessStatus('目标解析失败，已按当前图继续：' + reason, 'running');
        } else if (resolved && resolved.question && !(resolved.candidates || []).length) {
          focusIds = [];
          _setHarnessStatus('模型未能确定目标，已按当前图继续：' + resolved.question, 'running');
        } else if (resolved && resolved.ambiguous && (resolved.candidates || []).length) {
          _setHarnessBusy(false);
          _startHarnessClarify(resolved.candidates, instruction, harnessPhase);
          return;
        } else if (resolved) {
          focusIds = resolved.focus_node_ids || [];
        }
      } else if (candidateFocusIds.length === 1) {
        focusIds = candidateFocusIds;
      }
    }
    const snapshot = buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId);
    harnessSnapshot = snapshot;
    if (!snapshot.nodes.length) {
      _setHarnessStatus('当前没有可审阅节点', 'error');
      return;
    }
    harnessResult = null;
    _setHarnessStatus(
      harnessPhase === 'evaluate' ? '生成评价节点中...' : harnessPhase === 'apply' ? '应用建议中...' : '审阅中...',
      'running'
    );
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessBusy(true);

    try {
      const resp = await fetch(HARNESS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot,
          instruction,
          model: {
            provider: model.provider,
            api_key: model.apiKey,
            model: model.model,
            base_url: model.baseUrl,
          },
          max_tokens: 4000,
          phase: harnessPhase,
          level: localStorage.getItem('phymathia_level') || 'university',
          focus_node_ids: focusIds,
          conversation_context: _buildConversationContext(),
          retries: 2,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.errors?.[0]?.reason || 'harness 请求失败');
      }
      harnessResult = data;
      renderHarnessResult(data);
      _appendHarnessHistory({
        id: _historyId(),
        role: 'assistant',
        content: (data.summary || '模型没有提出可执行修改')
          + ((data.operations || []).length
            ? '\n\n' + data.operations.map(op => '• ' + _opDescription(op)).join('\n')
            : ''),
        instruction,
        summary: data.summary || '',
        operations: data.operations || [],
        phase: harnessPhase,
        decision: 'pending',
        timestamp: Date.now(),
      });
      if (typeof window.applyGraphDiffHighlights === 'function') {
        setTimeout(() => window.applyGraphDiffHighlights(data.operations || []), 0);
      }
      if (typeof window.showGraphHarnessPreview === 'function') {
        const preview = _buildHarnessPreview(data.operations || []);
        window.__lastHarnessPreview = preview;
        const _previewSwitched = window.showGraphHarnessPreview(preview.nodes, preview.edges);
        if (preview.nodes.length || preview.edges.length) {
          _setHarnessStatus('已生成 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线' + (_previewSwitched ? '（已切换到画布视图）' : ''), 'ok');
        }
      }
    } catch (err) {
      _setHarnessStatus('审阅失败：' + err.message, 'error');
      _showHarnessRetry('审阅失败：' + err.message);
      if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
      if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    } finally {
      _setHarnessBusy(false);
      harnessSingleEvalId = null;
    }
  }


  function _startHarnessClarify(focusIds, instruction, phase) {
    const list = (focusIds || []).map(item => {
      if (typeof item === 'string') {
        const node = _graphNodes().find(n => n.id === item);
        return { id: item, label: node ? (_nodeLabel(node) || item) : item, hint: '' };
      }
      return { id: item.id, label: item.label || item.id, hint: item.hint || '' };
    });
    harnessPendingClarify = { candidates: list, instruction, phase };
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    chat.innerHTML = '<div class="graph-harness-clarify"><div>发现多个匹配节点，请选择：</div>'
      + list.map(candidate => '<div class="graph-harness-clarify-item"><button type="button" onclick="chooseHarnessClarifyNode(\'' + candidate.id + '\')">'
        + _escapeHtml(candidate.label) + '</button>'
        + (candidate.hint ? '<span class="graph-harness-clarify-hint">' + _escapeHtml(candidate.hint) + '</span>' : '')
        + '</div>').join('')
      + '<div class="graph-harness-clarify-input"><input id="graphHarnessClarifyInput" placeholder="输入节点名称或ID">'
      + '<button type="button" onclick="confirmHarnessClarifyInput()">确认</button></div>'
      + '</div>';
    chat.scrollTop = chat.scrollHeight;
    _setHarnessStatus('请选择目标节点', 'running');
  }

  function chooseHarnessClarifyNode(nodeId) {
    const pending = harnessPendingClarify;
    if (!pending) return;
    harnessPendingClarify = null;
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl) instructionEl.value = pending.instruction;
    runGraphHarnessWithFocus(pending.phase, [nodeId]);
  }

  function confirmHarnessClarifyInput() {
    const input = document.getElementById('graphHarnessClarifyInput');
    const pending = harnessPendingClarify;
    if (!pending || !input) return;
    const text = input.value.trim();
    if (!text) return;
    const nodes = _graphNodes();
    const node = nodes.find(item => item.id === text || _nodeLabel(item) === text);
    harnessPendingClarify = null;
    if (node) {
      runGraphHarnessWithFocus(pending.phase, [node.id]);
    } else {
      _setHarnessStatus('未找到该节点，请选择列表中的节点或检查名称', 'error');
    }
  }

  async function runGraphHarnessWithFocus(phase, focusIds) {
    const instruction = String(document.getElementById('graphHarnessInstruction')?.value || '').trim();
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) inputEl.value = '';
    const model = typeof window.getActiveModelForRole === 'function'
      ? window.getActiveModelForRole('agent')
      : null;
    if (!model) {
      _setHarnessStatus('请先配置主模型', 'error');
      return;
    }
    const state = _graphState() || {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const evalNodes = _graphNodes().filter(node => node.kind === 'ai_eval' && !deleted.has(node.id));
    harnessPhase = phase || 'normal';
    harnessLastInstruction = instruction;
    harnessLastPhase = harnessPhase;
    _appendHarnessHistory({
      id: _historyId(),
      role: 'user',
      content: instruction,
      phase: harnessPhase,
      timestamp: Date.now(),
    });
    const snapshot = buildHarnessSnapshot(harnessPhase === 'evaluate', focusIds, harnessSingleEvalId);
    harnessSnapshot = snapshot;
    if (!snapshot.nodes.length) {
      _setHarnessStatus('当前没有可审阅节点', 'error');
      return;
    }
    harnessResult = null;
    _setHarnessStatus(harnessPhase === 'evaluate' ? '生成评价节点中...' : '应用建议中...', 'running');
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _setHarnessBusy(true);
    try {
      const resp = await fetch(HARNESS_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          snapshot,
          instruction,
          model: {
            provider: model.provider,
            api_key: model.apiKey,
            model: model.model,
            base_url: model.baseUrl,
          },
          max_tokens: 4000,
          phase: harnessPhase,
          level: localStorage.getItem('phymathia_level') || 'university',
          focus_node_ids: focusIds,
          conversation_context: _buildConversationContext(),
          retries: 2,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.errors?.[0]?.reason || 'harness 请求失败');
      }
      harnessResult = data;
      renderHarnessResult(data);
      _appendHarnessHistory({
        id: _historyId(),
        role: 'assistant',
        content: (data.summary || '模型没有提出可执行修改')
          + ((data.operations || []).length
            ? '\n\n' + data.operations.map(op => '• ' + _opDescription(op)).join('\n')
            : ''),
        instruction,
        summary: data.summary || '',
        operations: data.operations || [],
        phase: harnessPhase,
        decision: 'pending',
        timestamp: Date.now(),
      });
      if (typeof window.applyGraphDiffHighlights === 'function') {
        setTimeout(() => window.applyGraphDiffHighlights(data.operations || []), 0);
      }
      if (typeof window.showGraphHarnessPreview === 'function') {
        const preview = _buildHarnessPreview(data.operations || []);
        window.__lastHarnessPreview = preview;
        const _previewSwitched = window.showGraphHarnessPreview(preview.nodes, preview.edges);
        if (preview.nodes.length || preview.edges.length) {
          _setHarnessStatus('已生成 ' + preview.nodes.length + ' 个预览节点、' + preview.edges.length + ' 条预览连线' + (_previewSwitched ? '（已切换到画布视图）' : ''), 'ok');
        }
      }
    } catch (err) {
      _setHarnessStatus('审阅失败：' + err.message, 'error');
      _showHarnessRetry('审阅失败：' + err.message);
      if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
      if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    } finally {
      _setHarnessBusy(false);
    }
  }

  function _opDescription(op) {
    const name = op.op || op.type || '';
    if (name === 'create_node') {
      const moduleKey = op.module_key || op.moduleKey || '';
      const nodeName = op.label || op.title || (moduleKey ? _moduleLabel(moduleKey) : '') || op.temp_id || '';
      return '新增' + (moduleKey ? _moduleLabel(moduleKey) : _kindLabel(op.kind)) + '「' + nodeName + '」';
    }
    if (name === 'create_eval_node') {
      const target = op.target_label || op.target_node_id || op.target || '目标节点';
      return '为「' + target + '」生成 AI 评价节点';
    }
    if (name === 'update_node') {
      return '修改节点「' + (op.label || op.id || '') + '」';
    }
    if (name === 'delete_node') {
      return '删除节点「' + (op.label || op.id || '') + '」';
    }
    if (name === 'add_edge') {
      return '新增连线：' + (op.from || '') + ' → ' + (op.to || '') + (op.relation ? '（' + op.relation + '）' : '');
    }
    if (name === 'remove_edge') {
      return '删除连线：' + (op.edge_key || op.key || '');
    }
    if (name === 'update_edge') {
      return '修改连线：' + (op.edge_key || op.key || '');
    }
    return name || '未知操作';
  }
