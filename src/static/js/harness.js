(function () {
  const HARNESS_API = '/api/harness/graph/review';
  let harnessPanel = null;
  let harnessPet = null;
  let harnessResult = null;
  let harnessSnapshot = null;
  let harnessPhase = 'normal';
  let harnessSingleEvalId = null;
  let harnessPendingClarify = null;
  let harnessHistory = [];
  let harnessBusy = false;
  let harnessLastInstruction = '';
  let harnessLastPhase = 'normal';

  function _escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function _sessionId() {
    return typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  }

  function _graphState() {
    return typeof window.getGraphState === 'function' ? window.getGraphState(_sessionId()) : null;
  }

  function _graphNodes() {
    return typeof window.getGraphViewNodes === 'function' ? window.getGraphViewNodes() : [];
  }

  function _graphEdges() {
    return typeof window.getGraphViewEdges === 'function' ? window.getGraphViewEdges() : [];
  }

  function _edgeKey(edge) {
    return (edge.from || '') + ':' + (edge.fromPort || 'out-0') + '->' + (edge.to || '') + ':' + (edge.toPort || 'in-0');
  }

  function _edgeParts(key) {
    const match = String(key || '').match(/^(.+?):(out-\d+)->(.+?):(in-\d+)$/);
    return match
      ? { from: match[1], fromPort: match[2], to: match[3], toPort: match[4] }
      : null;
  }

  function _moduleLabel(moduleKey) {
    const labels = {
      physics: '物理视角',
      math: '数学视角',
      graph: '知识图谱',
      viz: '交互可视化',
      socratic: '苏格拉底追问',
      learn: '进阶学习',
      manual: '非 AI 回答',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '人工总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
    };
    return labels[moduleKey] || moduleKey || '节点';
  }

  function _nodeLabel(node) {
    if (!node) return '';
    if (node.label) return node.label;
    if (node.title) return node.title;
    if (node.kind === 'user') return node.isRoot ? '核心问题' : (node.branchLabel || '问题');
    if (node.kind === 'answer') return node.branchLabel || node.summary || 'AI 回答';
    if (node.kind === 'module') return _moduleLabel(node.moduleKey);
    return node.summary || node.content || '节点';
  }

  function _nodeContent(node) {
    if (!node) return '';
    return node.content || node.summary || '';
  }

  function _detectHarnessPhase(instruction, evalNodes) {
    const text = String(instruction || '');
    const hasApply = /应用建议|采纳建议|按建议|执行建议/.test(text);
    const hasEval = /评价|建议|反馈|点评|指出|哪里需要改进|如何完善|帮我完善|改进/.test(text);
    if (hasApply && evalNodes.length) return 'apply';
    if (hasEval) return 'evaluate';
    return 'normal';
  }

  function _detectFocusNodeIds(instruction, nodes) {
    const text = String(instruction || '');
    const matches = [];
    for (const node of nodes) {
      if (node.kind === 'ai_eval') continue;
      const label = String(_nodeLabel(node) || '').trim();
      if (!label || label.length < 2) continue;
      if (text.includes(label)) matches.push(node.id);
    }
    return Array.from(new Set(matches));
  }

  function _connectedNodeIds(nodes, edges, seedIds) {
    const seeds = new Set(seedIds || []);
    const nodeById = new Map(nodes.map(node => [node.id, node]));
    const adjacency = new Map();
    nodes.forEach(node => adjacency.set(node.id, []));
    edges.forEach(edge => {
      if (adjacency.has(edge.from) && adjacency.has(edge.to)) {
        adjacency.get(edge.from).push(edge.to);
        adjacency.get(edge.to).push(edge.from);
      }
    });
    const seen = new Set(seeds);
    const queue = Array.from(seeds);
    while (queue.length) {
      const current = queue.shift();
      for (const next of adjacency.get(current) || []) {
        if (!seen.has(next) && nodeById.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return Array.from(seen);
  }

  function _kindLabel(kind) {
    const labels = {
      blank: '空白节点',
      user: '问题',
      answer: 'AI 回答',
      module: '模块',
      hub: '汇聚',
      summary: 'AI 总结',
      note: '人工总结',
      source: '输入',
      knowledge: '知识点',
      relation: '联系',
      human_note: '我的理解',
      ai_eval: 'AI 评价',
    };
    return labels[kind] || kind || '节点';
  }

  function buildHarnessSnapshot(excludeEval, focusIds, singleEvalId) {
    const state = _graphState() || {};
    const deleted = new Set(Object.keys(state.harnessDeleted || {}));
    const nodes = _graphNodes().filter(node => !deleted.has(node.id) && !(excludeEval && node.kind === 'ai_eval'));
    const selected = new Set(
      typeof window.getSelectedGraphNodeIds === 'function' ? window.getSelectedGraphNodeIds() : []
    );
    let scopeNodes = selected.size ? nodes.filter(node => selected.has(node.id)) : nodes;
    if (singleEvalId) {
      const evalNode = nodes.find(node => node.id === singleEvalId);
      if (evalNode) {
        const targetId = evalNode.target_node_id || '';
        const seedIds = [singleEvalId, targetId].filter(Boolean);
        const connected = _connectedNodeIds(nodes, _graphEdges(), seedIds);
        scopeNodes = nodes.filter(node => connected.includes(node.id));
      }
    } else if (focusIds && focusIds.length) {
      const connected = _connectedNodeIds(nodes, _graphEdges(), focusIds);
      scopeNodes = nodes.filter(node => connected.includes(node.id));
    }
    const nodeIds = new Set(scopeNodes.map(node => node.id));
    const edges = _graphEdges().filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));

    return {
      version: 1,
      nodes: scopeNodes.map(node => ({
        id: node.id,
        kind: node.kind,
        module_key: node.moduleKey || '',
        manual: !!node.manual,
        read_only: node.messageIndex >= 0,
        label: _nodeLabel(node).slice(0, 80),
        content: _nodeContent(node).slice(0, 600),
        formula: String(node.formula || '').slice(0, 200),
        target_node_id: node.target_node_id || '',
        target_label: node.target_label || '',
        suggestion: node.suggestion || '',
        priority: node.priority || '',
      })),
      edges: edges.map(edge => ({
        key: _edgeKey(edge),
        from: edge.from,
        to: edge.to,
        relation: String(edge.relation || ''),
        label: String(edge.label || ''),
        custom: !!edge.custom,
      })),
      available_node_types: [
        { kind: 'module', module_key: 'physics', label: '物理视角' },
        { kind: 'module', module_key: 'math', label: '数学视角' },
        { kind: 'module', module_key: 'graph', label: '知识图谱' },
        { kind: 'module', module_key: 'viz', label: '交互可视化' },
        { kind: 'module', module_key: 'socratic', label: '苏格拉底追问' },
        { kind: 'module', module_key: 'learn', label: '进阶学习' },
        { kind: 'knowledge', label: '知识点' },
        { kind: 'relation', label: '联系' },
        { kind: 'human_note', label: '我的理解' },
        { kind: 'note', label: '人工总结' },
        { kind: 'hub', label: '汇聚' },
        { kind: 'summary', label: 'AI 总结' },
        { kind: 'source', label: '输入' },
        { kind: 'blank', label: '空白节点' },
        { kind: 'user', label: '问题' },
        { kind: 'answer', label: 'AI 回答' },
        { kind: 'ai_eval', label: 'AI 评价' },
      ],
      scope_node_ids: Array.from(selected),
    };
  }

  function ensureHarnessPanel() {
    if (harnessPanel) return harnessPanel;
    harnessPet = document.createElement('div');
    harnessPet.className = 'graph-harness-pet';
    harnessPet.title = 'AI 网络助手';
    harnessPet.innerHTML = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
      + '<circle cx="12" cy="12" r="10"></circle>'
      + '<path d="M8 9h.01M16 9h.01"></path>'
      + '<path d="M9 15c1.8 1.2 4.2 1.2 6 0"></path>'
      + '</svg>';
    harnessPanel = document.createElement('div');
    harnessPanel.className = 'graph-harness-window';
    harnessPanel.hidden = true;
    harnessPanel.innerHTML = ''
      + '<div class="graph-harness-head" id="graphHarnessWindowHead"><span>AI 网络助手</span>'
      + '<button type="button" onclick="closeGraphHarness()" aria-label="关闭">&times;</button></div>'
      + '<div class="graph-harness-chat" id="graphHarnessChat"></div>'
      + '<div class="graph-harness-composer">'
      + '<textarea id="graphHarnessInstruction" rows="2" placeholder="对 harness 说话..."></textarea>'
      + '<div class="graph-harness-actions">'
      + '<button id="graphHarnessSendBtn" type="button" onclick="runGraphHarness()">发送</button>'
      + '</div>'
      + '<div id="graphHarnessStatus" class="graph-harness-status"></div>'
      + '</div>'
      + '</div>'
      + '</div>';
    document.body.appendChild(harnessPet);
    document.body.appendChild(harnessPanel);
    _initHarnessDrag();
    const inputEl = document.getElementById('graphHarnessInstruction');
    if (inputEl) {
      inputEl.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          if (!harnessBusy) runGraphHarness();
        }
      });
    }
    return harnessPanel;
  }

  function _setHarnessStatus(text, kind) {
    const status = document.getElementById('graphHarnessStatus');
    if (!status) return;
    status.textContent = text || '';
    status.className = 'graph-harness-status' + (kind ? ' graph-harness-status-' + kind : '');
  }

  function _setHarnessBusy(busy) {
    harnessBusy = busy;
    if (harnessPanel) harnessPanel.classList.toggle('busy', busy);
    const send = document.getElementById('graphHarnessSendBtn');
    if (send) send.disabled = busy;
  }

  function _historyKey(sid) {
    return 'harness_history:' + sid;
  }

  function _historyId() {
    return 'h_' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  async function _loadHarnessHistory() {
    const sid = _sessionId();
    harnessHistory = [];
    if (!sid) return;
    const localKey = 'phymathia_harness_history_' + sid;
    try {
      const local = JSON.parse(localStorage.getItem(localKey) || '[]');
      if (Array.isArray(local)) harnessHistory = local;
    } catch (e) {}
    try {
      const resp = await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)));
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data.value)) {
          harnessHistory = data.value;
          localStorage.setItem(localKey, JSON.stringify(harnessHistory));
        }
      }
    } catch (e) {}
  }

  async function _saveHarnessHistory() {
    const sid = _sessionId();
    if (!sid) return;
    const localKey = 'phymathia_harness_history_' + sid;
    localStorage.setItem(localKey, JSON.stringify(harnessHistory));
    try {
      await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: harnessHistory }),
      });
    } catch (e) {}
  }

  function _renderHarnessChat() {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    chat.innerHTML = harnessHistory.length
      ? harnessHistory.map(entry => _historyMessageHtml(entry)).join('')
      : '<div class="graph-harness-empty">还没有 harness 对话记录</div>';
    chat.scrollTop = chat.scrollHeight;
  }

  function _historyMessageHtml(entry) {
    let actions = '';
    if (entry.role === 'assistant' && entry.decision === 'pending' && (entry.operations || []).length) {
      actions += '<button type="button" onclick="previewHarnessSuggestion(\'' + entry.id + '\')">查看预览</button>'
        + '<button type="button" onclick="keepHarnessSuggestion(\'' + entry.id + '\')">保留修改</button>'
        + '<button type="button" onclick="discardHarnessSuggestion(\'' + entry.id + '\')">不保留修改</button>';
    }
    if (entry.role === 'assistant' && (entry.decision === 'keep' || entry.decision === 'discard')) {
      actions += '<span class="graph-harness-decision">' + (entry.decision === 'keep' ? '已保留' : '已忽略') + '</span>';
    }
    if (entry.role === 'assistant' && entry.decision === 'discard') {
      actions += '<button type="button" onclick="reapplyHarnessSuggestion(\'' + entry.id + '\')">重新应用</button>'
        + '<button type="button" onclick="restoreHarnessSuggestion(\'' + entry.id + '\')">恢复为待处理</button>';
    }
    actions += '<button type="button" onclick="deleteHarnessHistoryEntry(\'' + entry.id + '\')">删除记录</button>';
    const meta = entry.role === 'assistant'
      ? '<div class="graph-harness-meta">' + (entry.phase || '') + '</div>'
      : '';
    return '<div class="graph-harness-message graph-harness-message-' + (entry.role || 'system') + '">'
      + '<div class="graph-harness-message-content">' + _escapeHtml(entry.content || '') + '</div>'
      + meta
      + (actions ? '<div class="graph-harness-message-actions">' + actions + '</div>' : '')
      + '</div>';
  }

  function _appendHarnessHistory(entry) {
    harnessHistory.push(entry);
    _saveHarnessHistory().then(_renderHarnessChat);
  }

  function _buildConversationContext() {
    return harnessHistory.slice(-10).map(entry => {
      const role = entry.role === 'user' ? '用户' : 'Harness';
      const content = String(entry.content || '').slice(0, 600);
      return role + '：' + content;
    }).join('\n');
  }

  function _showHarnessRetry(text) {
    const chat = document.getElementById('graphHarnessChat');
    if (!chat) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'graph-harness-message graph-harness-message-system';
    wrapper.innerHTML = '<div class="graph-harness-message-content">' + _escapeHtml(text) + '</div>'
      + '<div class="graph-harness-message-actions"><button type="button" onclick="retryHarnessLastRequest()">重试</button></div>';
    chat.appendChild(wrapper);
    chat.scrollTop = chat.scrollHeight;
  }

  function retryHarnessLastRequest() {
    const instructionEl = document.getElementById('graphHarnessInstruction');
    if (instructionEl && harnessLastInstruction) instructionEl.value = harnessLastInstruction;
    runGraphHarness(harnessLastPhase);
  }

  async function _resolveHarnessFocus(candidates, instruction) {
    const model = typeof window.getActiveModelForRole === 'function'
      ? window.getActiveModelForRole('agent')
      : null;
    if (!model) {
      return { status: 'error', focus_node_ids: [], ambiguous: false, question: '请先配置主模型', candidates: [] };
    }
    const snapshot = buildHarnessSnapshot(false, candidates, null);
    const resp = await fetch('/api/harness/graph/resolve', {
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
        level: localStorage.getItem('phymathia_level') || 'university',
        retries: 2,
        conversation_context: _buildConversationContext(),
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.errors?.[0]?.reason || '目标解析失败');
    return data;
  }

  function _initHarnessDrag() {
    if (!harnessPet || !harnessPanel) return;
    let petMoved = false;
    harnessPet.addEventListener('pointerdown', event => {
      event.preventDefault();
      const rect = harnessPet.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      petMoved = false;
      const move = ev => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (Math.abs(dx) + Math.abs(dy) > 4) petMoved = true;
        harnessPet.style.left = (rect.left + dx) + 'px';
        harnessPet.style.top = (rect.top + dy) + 'px';
        harnessPet.style.right = 'auto';
        harnessPet.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        setTimeout(() => { petMoved = false; }, 0);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up, { once: true });
    });
    harnessPet.addEventListener('click', () => {
      if (!petMoved) toggleGraphHarnessWindow();
    });
    const head = document.getElementById('graphHarnessWindowHead');
    if (head) {
      let winMoved = false;
      head.addEventListener('pointerdown', event => {
        if (event.target.closest('button')) return;
        event.preventDefault();
        const rect = harnessPanel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        winMoved = false;
        const move = ev => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.abs(dx) + Math.abs(dy) > 3) winMoved = true;
          harnessPanel.style.left = (rect.left + dx) + 'px';
          harnessPanel.style.top = (rect.top + dy) + 'px';
          harnessPanel.style.right = 'auto';
          harnessPanel.style.bottom = 'auto';
        };
        const up = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up, { once: true });
      });
    }
  }

  async function openGraphHarness() {
    const panel = ensureHarnessPanel();
    panel.hidden = false;
    if (harnessPet) harnessPet.classList.add('active');
    _setHarnessStatus('');
    const resultBox = document.getElementById('graphHarnessResult');
    if (resultBox) resultBox.innerHTML = '';
    document.getElementById('graphHarnessApplyActions')?.setAttribute('hidden', '');
    await _loadHarnessHistory();
    _renderHarnessChat();
  }

  function toggleGraphHarnessWindow() {
    if (!harnessPanel || harnessPanel.hidden) openGraphHarness();
    else closeGraphHarness();
  }

  function closeGraphHarness() {
    if (harnessPanel) harnessPanel.hidden = true;
    if (harnessPet) harnessPet.classList.remove('active');
    harnessSingleEvalId = null;
    harnessPendingClarify = null;
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
  }

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

  function _applyOneHarnessOp(op, state, nodeKindById) {
    const name = op.op || op.type || '';
    if (name === 'create_eval_node') {
      const id = op.assigned_id || op.id || op.temp_id;
      if (!_prepareHarnessNodeReuse(id, state)) return;
      const pos = _nextNodePosition(state.customNodes.length);
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
      const pos = _nextNodePosition(state.customNodes.length);
      state.customNodes.push(_newHarnessNode(id, op, pos));
      return;
    }
    if (name === 'update_node') {
      const node = state.customNodes.find(item => item.id === op.id);
      if (!node) return;
      const patch = op.patch || {};
      if (patch.label != null || patch.title != null) {
        const label = String((patch.label ?? patch.title) || node.label || node.title || '');
        node.label = label;
        if (node.kind === 'knowledge') node.title = label;
      }
      if (patch.content != null) {
        node.content = String(patch.content || '');
        node.summary = node.content.slice(0, 120);
      }
      if (patch.formula != null) {
        node.formula = String(patch.formula || '');
        node.formulas = node.formula ? [node.formula] : [];
      }
      if (patch.status != null) node.status = String(patch.status || '');
      return;
    }
    if (name === 'delete_node') {
      const id = op.id;
      state.customNodes = state.customNodes.filter(node => node.id !== id);
      state.connections = state.connections.filter(edge => edge.from !== id && edge.to !== id);
      state.harnessDeleted[id] = true;
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
    if (typeof window.pushGraphUndo === 'function') window.pushGraphUndo();
    const nodeKindById = new Map(_graphNodes().map(node => [node.id, node.kind]));
    state.customNodes = Array.isArray(state.customNodes) ? state.customNodes : [];
    state.connections = Array.isArray(state.connections) ? state.connections : [];
    state.harnessDeleted = state.harnessDeleted || {};
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
})();

















