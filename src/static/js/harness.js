// ===== PhyMathia 图编辑 harness：状态、面板与基础工具 =====

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