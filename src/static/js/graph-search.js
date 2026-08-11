// ===== PhyMathia 知识网络画布：全局搜索 =====

function _graphNodeSearchText(message, node) {
  const parts = [];
  const base = _nodeContent(message, node);
  if (base) parts.push(base);
  if (message && node.kind === 'answer') parts.push(message.content || '');
  if (message && node.kind === 'module') {
    const sections = _splitGraphSections((typeof parseXmlSections === 'function') ? parseXmlSections(message.content || '') : {});
    if (sections[node.moduleKey]) parts.push(sections[node.moduleKey]);
  }
  if (node.content) parts.push(node.content);
  if (node.summary) parts.push(node.summary);
  if (node.suggestion) parts.push(node.suggestion);
  if (node.target_label) parts.push(node.target_label);
  if (node.requirements) parts.push(node.requirements);
  if (node.label) parts.push(node.label);
  if (node.title) parts.push(node.title);
  if (node.branchLabel) parts.push(node.branchLabel);
  const attr = _nodeAttribute(node);
  if (attr && attr.label) parts.push(attr.label);
  const sub = _nodeSub(node);
  if (sub) parts.push(sub);
  return _graphSearchPlainText(parts.join('\n'));
}

function _graphSearchResultLabel(node, message) {
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || { label: '模块' }).label;
  if (node.kind === 'answer') return node.manual ? '我的回答' : 'AI 回答簇';
  if (node.kind === 'hub') return '汇聚';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '我的总结';
  if (node.kind === 'source') return '输入';
  if (node.kind === 'knowledge') return '知识点';
  if (node.kind === 'relation') return '联系';
  if (node.kind === 'ai_eval') return 'AI 评价';
  if (node.kind === 'user') return node.isRoot ? '核心问题' : (node.isBranch ? (node.branchLabel || '延伸追问') : '问题');
  if (node.kind === 'blank') return 'AI 生成空白';
  if (node.kind === 'draft') return '待提交追问';
  return node.label || '节点';
}

function _graphSearchSnippet(text, query, width) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  const q = String(query || '').trim().toLowerCase();
  const max = width || 120;
  if (!q) return clean.slice(0, max);
  const idx = clean.toLowerCase().indexOf(q);
  if (idx < 0) return clean.slice(0, max);
  const start = Math.max(0, idx - Math.floor(max * 0.35));
  const end = Math.min(clean.length, start + max);
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '');
}

function _graphSearchHighlight(text, query) {
  const snippet = _graphSearchSnippet(text, query, 130);
  const q = String(query || '').trim();
  const highlighted = q
    ? snippet.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>')
    : snippet;
  return escapeHtml(highlighted)
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>');
}

function _graphSearchIndexVersion(messages, state) {
  return String(messages.length)
    + ':' + (state.updatedAt || 0)
    + ':' + ((state.customNodes || []).length)
    + ':' + (state.positions ? Object.keys(state.positions).length : 0);
}

function _buildGraphSearchIndex(sessionId) {
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  const sid = sessionId || currentId;
  if (!sid) return [];
  const messages = sid === currentId
    ? _getChatHistory()
    : (typeof window.getSessionMessages === 'function' ? window.getSessionMessages(sid) : []);
  const state = typeof window.getGraphState === 'function' ? window.getGraphState(sid) : _graphState();
  const version = _graphSearchIndexVersion(messages, state);
  const cached = graphSearchIndexCache.get(sid);
  if (cached && cached.version === version) return cached.entries;

  const data = _buildGraphData(messages, state);
  const entries = [];
  for (const node of data.nodes) {
    const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
    const text = _graphNodeSearchText(message, node);
    if (!text) continue;
    entries.push({
      sessionId: sid,
      nodeId: node.id,
      kind: node.kind,
      moduleKey: node.moduleKey || '',
      timestamp: String(node.timestamp || ''),
      custom: node.messageIndex < 0,
      label: _graphSearchResultLabel(node, message),
      sub: _nodeSub(node),
      text,
    });
  }
  graphSearchIndexCache.set(sid, { version, entries });
  return entries;
}

function _graphSearchAllEntries() {
  const allSessions = typeof window.getAllSessions === 'function' ? window.getAllSessions() : [];
  const entries = [];
  for (const sess of allSessions) {
    const sid = sess.id || sess.sessionId;
    if (sid) entries.push(..._buildGraphSearchIndex(sid));
  }
  return entries;
}

function _renderGraphSearchResults(matches, query, showSession) {
  const resultsEl = document.getElementById('graphSearchResults');
  if (!resultsEl) return;
  if (!matches.length) {
    resultsEl.innerHTML = '<div class="graph-search-empty">未找到匹配节点</div>';
    return;
  }
  resultsEl.innerHTML = matches.map(entry => {
    const sess = showSession && typeof window.getSessionById === 'function' ? window.getSessionById(entry.sessionId) : null;
    const sessName = sess ? sess.title : '';
    return '<button class="graph-search-result"'
      + ' data-session-id="' + escapeHtml(entry.sessionId) + '"'
      + ' data-node-id="' + escapeHtml(entry.nodeId) + '"'
      + ' data-timestamp="' + escapeHtml(entry.timestamp) + '"'
      + ' data-module-key="' + escapeHtml(entry.moduleKey) + '"'
      + ' data-node-kind="' + escapeHtml(entry.kind) + '"'
      + ' data-custom="' + (entry.custom ? '1' : '0') + '"'
      + ' onclick="focusGraphSearchResult(this)">'
      + '<span class="graph-search-result-main">'
      + '<span class="graph-search-result-label">' + escapeHtml(entry.label || '节点') + '</span>'
      + (entry.sub ? '<span class="graph-search-result-sub">' + escapeHtml(entry.sub) + '</span>' : '')
      + (sessName ? '<span class="graph-search-result-session">' + escapeHtml(sessName) + '</span>' : '')
      + '</span>'
      + '<span class="graph-search-result-snippet">' + _graphSearchHighlight(entry.text, query) + '</span>'
      + '</button>';
  }).join('');
}

function _performGraphSearch() {
  if (!graphSearchOpen) return;
  const q = String(graphSearchQuery || '').trim();
  const resultsEl = document.getElementById('graphSearchResults');
  if (!q) {
    if (resultsEl) resultsEl.innerHTML = '<div class="graph-search-empty">输入关键词搜索节点</div>';
    return;
  }
  const all = graphSearchScope === 'all';
  const entries = all ? _graphSearchAllEntries() : _buildGraphSearchIndex();
  const lower = q.toLowerCase();
  const matches = [];
  for (const entry of entries) {
    if (String(entry.text || '').toLowerCase().includes(lower)) {
      matches.push(entry);
      if (matches.length >= 50) break;
    }
  }
  _renderGraphSearchResults(matches, q, all);
}

function _syncGraphSearchButtonState() {
  const btn = document.querySelector('.graph-search-btn');
  if (btn) btn.classList.toggle('active', graphSearchOpen);
}

function openGraphSearchPanel() {
  const panel = document.getElementById('graphSearchPanel');
  if (!panel) return;
  graphSearchOpen = true;
  panel.hidden = false;
  const input = document.getElementById('graphSearchInput');
  if (input) {
    input.value = graphSearchQuery;
    input.focus();
    input.select();
  }
  _syncGraphSearchButtonState();
  _performGraphSearch();
}

function closeGraphSearchPanel() {
  const panel = document.getElementById('graphSearchPanel');
  graphSearchOpen = false;
  if (panel) panel.hidden = true;
  _syncGraphSearchButtonState();
}

function toggleGraphSearchPanel() {
  if (graphSearchOpen) closeGraphSearchPanel();
  else openGraphSearchPanel();
}

function graphSearchInputChanged(value) {
  graphSearchQuery = String(value || '');
  clearTimeout(graphSearchDebounce);
  graphSearchDebounce = setTimeout(_performGraphSearch, 140);
}

function graphSearchKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeGraphSearchPanel();
  } else if (event.key === 'Enter') {
    const first = document.querySelector('.graph-search-result');
    if (first) {
      event.preventDefault();
      focusGraphSearchResult(first);
    }
  }
}

function setGraphSearchScope(scope, btn) {
  if (scope !== 'current' && scope !== 'all') return;
  graphSearchScope = scope;
  document.querySelectorAll('#graphSearchScope .graph-search-scope-btn').forEach(b => {
    b.classList.toggle('active', b === btn || b.dataset.scope === scope);
  });
  if (scope === 'all' && !graphSearchAllSynced && typeof window.syncFromServer === 'function') {
    graphSearchAllSynced = true;
    window.syncFromServer().finally(() => {
      if (graphSearchOpen && graphSearchScope === 'all') _performGraphSearch();
    });
  }
  _performGraphSearch();
}

async function focusGraphSearchResult(btn) {
  if (!btn) return;
  const sessionId = btn.dataset.sessionId || '';
  const nodeId = btn.dataset.nodeId || '';
  const timestamp = btn.dataset.timestamp || '';
  const moduleKey = btn.dataset.moduleKey || '';
  const nodeKind = btn.dataset.nodeKind || '';
  const isCustom = btn.dataset.custom === '1';
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  let ok = false;
  let failed = false;
  try {
    if (sessionId && sessionId !== currentId && typeof window.switchToSession === 'function') {
      await window.switchToSession(sessionId);
      if (typeof window.getCurrentSessionId === 'function' && window.getCurrentSessionId() !== sessionId) {
        if (typeof showToast === 'function') showToast('当前正在生成，暂不能跳转');
        return;
      }
    }
    if (isCustom) {
      ok = await focusGraphNodeById(nodeId);
    } else if (timestamp) {
      ok = await focusGraphNode(sessionId || currentId, timestamp, moduleKey, nodeKind);
    }
  } catch (err) {
    failed = true;
    console.error('Graph search jump failed:', err);
    if (typeof showToast === 'function') showToast('跳转失败，请稍后重试');
  } finally {
    closeGraphSearchPanel();
  }
  if (!failed && !ok && typeof showToast === 'function') showToast('未找到该节点，请刷新后重试');
}

function _nodeSub(node) {
  if (node.isRoot) return '核心问题';
  if (node.kind === 'user') return node.isBranch ? (node.branchLabel || '延伸追问') : '问题';
  if (node.kind === 'answer') return node.manual ? '我的回答' : (node.branchLabel || 'AI 回答簇');
  if (node.kind === 'hub') return '汇聚节点';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'note') return '我的总结';
  if (node.kind === 'source') return '文件解析入口';
  if (node.kind === 'knowledge') return '知识点节点';
  if (node.kind === 'relation') return '知识联系';
  if (node.kind === 'ai_eval') return 'AI 评价';
  if (node.kind === 'human_note') return '我的理解';
  if (node.kind === 'module') return '';
  if (node.kind === 'blank') return 'AI 生成空白';
  return '';
}
