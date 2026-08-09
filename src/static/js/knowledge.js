// ====== Knowledge Overview System ======
let kpFilterCategory = 'all';
let kpFilterSource = 'all';
let kpKnowledgeCache = null;
let kpKnowledgeSaveQueue = Promise.resolve();
let kpFormulaSaveQueue = Promise.resolve();
let kpFormulaLoadSeq = 0;

function _normalizeKnowledgeKey(title) {
  return String(title || '')
    .replace(/^#+\s*/, '')
    .replace(/^.*?PhyMathia\s*学习卡片\s*[:：]\s*/i, '')
    .replace(/的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向)$/g, '')
    .replace(/的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$/g, '')
    .replace(/^[🔬📐🧠💡🗺️]+\s*/, '')
    .replace(/[，。；、：:()（）\[\]【】\s]+/g, '')
    .toLowerCase()
    .trim();
}

function dedupeKnowledgeItems(items) {
  const map = items && typeof items === 'object' && !Array.isArray(items) ? items : {};
  const groups = {};
  for (const id in map) {
    const item = map[id];
    if (!item || typeof item !== 'object') continue;
    const sessionId = item.sessionId || '';
    const key = _normalizeKnowledgeKey(item.title);
    if (!sessionId || !key) continue;
    const groupKey = sessionId + '|' + key;
    if (!groups[groupKey]) groups[groupKey] = [];
    groups[groupKey].push(id);
  }

  const removeIds = new Set();
  for (const ids of Object.values(groups)) {
    if (ids.length < 2) continue;
    const ranked = ids
      .map(id => ({ id, item: map[id] }))
      .sort((a, b) => {
        const score = item => (item.summary || '').length + (item.formulas || []).length * 5 + (item.createdAt || 0) / 100000;
        return score(b.item) - score(a.item);
      });
    const keep = ranked[0].item;
    const formulas = [];
    const seen = new Set();
    for (const entry of ranked) {
      for (const formula of entry.item.formulas || []) {
        const key = _canonicalFormulaText(formula);
        if (formula && key && !seen.has(key)) {
          seen.add(key);
          formulas.push(formula);
        }
      }
    }
    keep.formulas = formulas;
    for (const entry of ranked.slice(1)) {
      if (!keep.moduleKey && entry.item.moduleKey) keep.moduleKey = entry.item.moduleKey;
      if (!keep.messageId && entry.item.messageId) keep.messageId = entry.item.messageId;
      if ((!keep.tags || !keep.tags.length) && entry.item.tags && entry.item.tags.length) {
        keep.tags = entry.item.tags.slice();
      }
    }
    for (let i = 1; i < ranked.length; i++) removeIds.add(ranked[i].id);
  }

  if (removeIds.size) {
    for (const id of removeIds) delete map[id];
    try {
      localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(map));
    } catch (e) {}
  }
  return map;
}

// 强制失效知识缓存：下次 getKnowledgeItems() 重新读取 localStorage
// （_syncFromServer 等服务端同步只写 localStorage 不更新内存缓存，渲染前必须失效）
function invalidateKnowledgeCache() {
  kpKnowledgeCache = null;
}

function getKnowledgeItems() {
  if (kpKnowledgeCache) return kpKnowledgeCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_KNOWLEDGE);
    kpKnowledgeCache = raw ? JSON.parse(raw) : {};
    // 兼容旧数组格式 [item, ...] → 迁移为 id->item 映射
    if (Array.isArray(kpKnowledgeCache)) {
      const map = {};
      for (const it of kpKnowledgeCache) {
        if (it && it.id) map[it.id] = it;
      }
      kpKnowledgeCache = map;
      localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(map));
    }
    // 兼容 {"items": [...]} / {"items": {...}} 包装格式（历史服务端残留）
    if (kpKnowledgeCache && typeof kpKnowledgeCache === 'object' && !Array.isArray(kpKnowledgeCache) && 'items' in kpKnowledgeCache) {
      const inner = kpKnowledgeCache.items;
      if (Array.isArray(inner)) {
        const map = {};
        for (const it of inner) if (it && it.id) map[it.id] = it;
        kpKnowledgeCache = map;
        localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(map));
      } else if (inner && typeof inner === 'object') {
        kpKnowledgeCache = inner;
        localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(inner));
      } else {
        kpKnowledgeCache = {};
        localStorage.setItem(STORAGE_KEY_KNOWLEDGE, '{}');
      }
    }
    kpKnowledgeCache = dedupeKnowledgeItems(kpKnowledgeCache);
  } catch { kpKnowledgeCache = {}; }
  return kpKnowledgeCache;
}

async function saveKnowledgeItems(items) {
  items = dedupeKnowledgeItems(items);
  kpKnowledgeCache = items;
  localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(items));
  const snapshot = JSON.parse(JSON.stringify(items));
  kpKnowledgeSaveQueue = kpKnowledgeSaveQueue
    .catch(() => false)
    .then(() => _saveKnowledgeToServer(snapshot));
  return kpKnowledgeSaveQueue;
}

// 面板打开时的快速刷新通道：直接 fetch 知识+公式（不经 _checkServer/全量同步），
// 与服务端做并集合并（服务端优先、本地独有不丢），更新缓存与 localStorage。
// 链路最短最可靠——打开面板后几百毫秒内即为服务端最新数据。
async function _quickRefreshKnowledge() {
  try {
    const fetchPromise = Promise.all([
      fetch('/api/knowledge', { cache: 'no-cache' }),
      fetch('/api/formulas', { cache: 'no-cache' }),
    ]);
    await Promise.all([
      kpKnowledgeSaveQueue.catch(() => false),
      kpFormulaSaveQueue.catch(() => false),
    ]);
    const [knowResp, formulaResp] = await fetchPromise;
    if (knowResp.ok) {
      const serverMap = await knowResp.json();
      if (serverMap && typeof serverMap === 'object' && !Array.isArray(serverMap)) {
        const local = getKnowledgeItems() || {};
        const merged = dedupeKnowledgeItems({ ...local, ...serverMap });
        kpKnowledgeCache = merged;
        localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(merged));
      }
    }
    if (formulaResp.ok) {
      const data = await formulaResp.json();
      const serverFormulas = {};
      for (const it of (data.items || [])) serverFormulas[it.id] = it;
      const localFormulas = getFormulaCache() || {};
      const mergedFormulas = dedupeFormulaItems({ ...localFormulas, ...serverFormulas });
      setFormulaCache(mergedFormulas);
    }
  } catch (e) {
    console.warn('Quick refresh knowledge failed:', e);
  }
}

function addKnowledgeItem(item) {
  const items = getKnowledgeItems();
  items[item.id] = item;
  saveKnowledgeItems(items);
}

async function deleteKnowledgeItem(id) {
  const items = getKnowledgeItems();
  delete items[id];
  await saveKnowledgeItems(items);
}

async function deleteKnowledgeBySession(sessionId) {
  const items = getKnowledgeItems();
  let changed = false;
  for (const id in items) {
    if (items[id].sessionId === sessionId) {
      delete items[id];
      changed = true;
    }
  }
  if (changed) await saveKnowledgeItems(items);
}

// Toggle panel
function toggleKnowledgePanel() {
  const panel = document.getElementById('knowledgePanel');
  const isOpen = panel.classList.contains('active');
  if (isOpen) {
    closeKnowledgePanel();
  } else {
    panel.classList.add('active');
    // 清缓存强制重读 localStorage（内存缓存可能持有旧数据/空对象）
    invalidateKnowledgeCache();
    renderKnowledgePanel();
    // 打开面板时走快速刷新通道：直接拉取服务端最新知识+公式（不等 15 秒定时同步）
    _quickRefreshKnowledge().then(() => {
      invalidateKnowledgeCache();
      renderKnowledgePanel();
      const activeTab = document.querySelector('.kp-tab.active');
      if (activeTab && activeTab.dataset.tab === 'formulas' && typeof loadFormulas === 'function') {
        loadFormulas();
      }
    }).catch(() => {});
  }
}

function closeKnowledgePanel() {
  document.getElementById('knowledgePanel').classList.remove('active');
}

// Filter
function setKpFilter(btn) {
  const filter = btn.dataset.filter;
  const value = btn.dataset.value;
  const group = btn.parentElement;
  group.querySelectorAll('.kp-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  if (filter === 'category') kpFilterCategory = value;
  else if (filter === 'source') kpFilterSource = value;
  renderKnowledgePanel();
}

function filterKnowledge() { renderKnowledgePanel(); }

// Render
function renderKnowledgePanel() {
  const items = getKnowledgeItems();
  const arr = Object.values(items);
  const search = (document.getElementById('kpSearch')?.value || '').toLowerCase().trim();

  // Stats
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  document.getElementById('kpTotal').textContent = arr.length;
  document.getElementById('kpPhysics').textContent = arr.filter(i => i.category === 'physics').length;
  document.getElementById('kpMath').textContent = arr.filter(i => i.category === 'math').length;
  document.getElementById('kpThisWeek').textContent = arr.filter(i => i.createdAt >= weekAgo).length;

  // Filter
  let filtered = arr;
  if (kpFilterCategory !== 'all') filtered = filtered.filter(i => i.category === kpFilterCategory);
  if (kpFilterSource !== 'all') filtered = filtered.filter(i => i.source === kpFilterSource);
  if (search) {
    filtered = filtered.filter(i =>
      i.title.toLowerCase().includes(search) ||
      (i.tags || []).some(t => t.toLowerCase().includes(search)) ||
      (i.summary || '').toLowerCase().includes(search)
    );
  }

  // Sort by date desc
  filtered.sort((a, b) => b.createdAt - a.createdAt);

  // Group by date
  const groups = {};
  for (const item of filtered) {
    const d = new Date(item.createdAt);
    const today = new Date(); const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
    let label;
    if (d.toDateString() === today.toDateString()) label = '今天';
    else if (d.toDateString() === yesterday.toDateString()) label = '昨天';
    else {
      const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
      if (d >= weekStart) label = '本周';
      else label = `${d.getMonth() + 1}月${d.getDate()}日`;
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }

  // Order: 今天 > 昨天 > 本周 > older
  const orderedLabels = ['今天', '昨天', '本周'];
  const otherLabels = Object.keys(groups).filter(l => !orderedLabels.includes(l)).sort((a, b) => {
    // parse "X月Y日"
    const parseDate = s => { const m = s.match(/(\d+)月(\d+)日/); return m ? parseInt(m[1]) * 100 + parseInt(m[2]) : 0; };
    return parseDate(b) - parseDate(a);
  });
  const allLabels = [...orderedLabels.filter(l => groups[l]), ...otherLabels];

  const timeline = document.getElementById('kpTimeline');
  if (filtered.length === 0) {
      timeline.innerHTML = `<div class="kp-empty"><div class="kp-empty-icon">${UI_ICON_SVG.book}</div><div class="kp-empty-text">${search ? '没有找到匹配的知识条目' : '还没有知识条目，开始提问或收藏回复吧'}</div></div>`;
    return;
  }

  let html = '';
  for (const label of allLabels) {
    const groupItems = groups[label];
    html += `<div class="kp-date-group"><div class="kp-date-label">${label}</div>`;
    for (const item of groupItems) {
      const catClass = item.category || 'other';
      const sourceIcon = item.source === 'ai_extract' ? '🤖' : item.source === 'file' ? '📄' : item.source === 'harness' ? '🧩' : '⭐';
      const sourceText = item.source === 'ai_extract' ? 'AI提取' : item.source === 'file' ? '文件导入' : item.source === 'harness' ? 'AI 编辑' : '手动收藏';
      const tagsHtml = (item.tags || []).map(t => `<span class="kp-tag">${escapeHtml(t)}</span>`).join('');
      const formulasHtml = (item.formulas || [])
        .filter(f => _looksLikeFormula(_stripFormulaDelimiters(f)))
        .map(f => {
          try {
            const rendered = katex.renderToString(_stripFormulaDelimiters(f), { throwOnError: false, displayMode: true });
            if (/katex-error/.test(rendered)) return '';
            return `<div class="kp-formula-item">${rendered}</div>`;
          } catch(e) {
            return '';
          }
        }).join('');
      const timeStr = new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      html += `
        <div class="kp-card" data-id="${item.id}" onclick="toggleKpCard(this)">
          <div class="kp-card-header">
            <div class="kp-card-dot ${catClass}"></div>
            <div class="kp-card-info">
              <div class="kp-card-title">${escapeHtml(item.title)}</div>
              <div class="kp-card-meta"><span class="kp-source-icon">${sourceIcon}</span>${sourceText} · ${catClass === 'physics' ? '物理' : catClass === 'math' ? '数学' : '其他'} · ${timeStr}</div>
            </div>
          </div>
          <div class="kp-card-summary">${escapeHtml(item.summary || '')}</div>
          <div class="kp-card-tags">${tagsHtml}</div>
          <div class="kp-card-detail">
            <div class="kp-card-detail-inner">
              ${formulasHtml ? `<div class="kp-formulas">${formulasHtml}</div>` : ''}
              <div class="kp-detail-actions">
                <button class="kp-action-btn kp-btn-primary" onclick="event.stopPropagation(); goToKnowledgeNode('${item.id}')">跳转到节点</button>
                <button class="kp-action-btn kp-btn-danger" onclick="event.stopPropagation(); confirmDeleteKnowledge('${item.id}')">删除</button>
              </div>
            </div>
          </div>
        </div>`;
    }
    html += '</div>';
  }
  timeline.innerHTML = html;
}

function toggleKpCard(card) {
  card.classList.toggle('expanded');
}

async function confirmDeleteKnowledge(id) {
  if (!confirm('确定删除此知识条目？')) return;
  await deleteKnowledgeItem(id);
  renderKnowledgePanel();
}

function _messageByTimestamp(messages, messageId) {
  return (messages || []).find(m => String(m.timestamp) === String(messageId)) || null;
}

async function _ensureSessionMessages(sessionId) {
  if (typeof window.getChatHistory === 'function' && window.getChatHistory().length) return;
  try {
    const resp = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + '/messages', { cache: 'no-cache' });
    if (resp.ok && typeof window.replaceChatHistory === 'function') {
      const messages = await resp.json();
      await window.replaceChatHistory(messages);
    }
  } catch (e) {
    console.warn('Load session messages for knowledge jump failed:', e);
  }
}

function _contentContainsFormula(content, latex) {
  const target = _canonicalFormulaText(latex);
  if (!target || typeof extractLocalFormulas !== 'function') return false;
  return extractLocalFormulas(String(content || '')).some(f => _canonicalFormulaText(f) === target);
}

function _moduleKeyForFormulaInMessage(message, latex) {
  if (!message) return '';
  const sections = typeof parseXmlSections === 'function' ? parseXmlSections(message.content || '') : {};
  for (const key of ['physics', 'math', 'graph', 'viz']) {
    if (sections[key] && _contentContainsFormula(sections[key], latex)) return key;
  }
  return '';
}

function _resolveKnowledgeAnchor(item, messages) {
  const messageId = String(item.messageId || '');
  let moduleKey = '';
  const message = _messageByTimestamp(messages, messageId);
  for (const formula of (item.formulas || [])) {
    const key = _moduleKeyForFormulaInMessage(message, formula);
    if (key) {
      moduleKey = key;
      break;
    }
  }
  if (!moduleKey && item.moduleKey && item.moduleKey !== 'answer') moduleKey = item.moduleKey;
  if (!moduleKey) {
    const tags = item.tags || [];
    if (tags.includes('数学')) moduleKey = 'math';
    else if (tags.includes('物理')) moduleKey = 'physics';
    else if (item.category === 'math') moduleKey = 'math';
    else if (item.category === 'physics') moduleKey = 'physics';
  }
  return { sessionId: item.sessionId, messageId, moduleKey: moduleKey || '', nodeId: item.nodeId || '' };
}

function _showJumpError(message) {
  if (typeof showToast === 'function') {
    showToast(message);
  } else {
    alert(message);
  }
}

async function goToKnowledgeNode(itemId) {
  const item = getKnowledgeItems()[itemId];
  if (!item) {
    _showJumpError('找不到对应的知识点');
    return false;
  }
  const sessionId = item.sessionId;
  const session = typeof window.getSessionById === 'function' ? window.getSessionById(sessionId) : null;
  if (!session) {
    _showJumpError('来源画布已删除，无法定位');
    return false;
  }
  closeKnowledgePanel();
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  if (sessionId !== currentId && typeof window.switchToSession === 'function') {
    await window.switchToSession(sessionId);
  }
  await _ensureSessionMessages(sessionId);
  const messages = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
  const anchor = _resolveKnowledgeAnchor(item, messages);
  if (!anchor.messageId) {
    if (anchor.nodeId && typeof window.focusGraphNodeById === 'function') {
      const ok = await window.focusGraphNodeById(anchor.nodeId);
      if (ok) return true;
    }
    _showJumpError('对应节点不存在，无法定位');
    return false;
  }
  if (typeof window.focusGraphNode !== 'function') {
    _showJumpError('探索网节点定位功能暂不可用');
    return false;
  }
  const ok = await window.focusGraphNode(anchor.sessionId, anchor.messageId, anchor.moduleKey);
  if (!ok) {
    _showJumpError('对应节点不存在，无法定位');
    return false;
  }
  return true;
}

function goToOriginalMessage(sessionId, messageId, moduleKey) {
  const item = Object.values(getKnowledgeItems()).find(it =>
    it.sessionId === sessionId && String(it.messageId || '') === String(messageId || '')
  );
  if (item) {
    goToKnowledgeNode(item.id);
    return;
  }
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  if (sessionId && sessionId !== currentId && typeof window.switchToSession === 'function') {
    window.switchToSession(sessionId).then(() => {
      if (typeof window.focusGraphNode === 'function') window.focusGraphNode(sessionId, messageId, moduleKey);
    });
  } else if (typeof window.focusGraphNode === 'function') {
    window.focusGraphNode(sessionId, messageId, moduleKey);
  }
}

// ====== 公式速查库 ======
const FORMULAS_STORAGE_KEY = 'phymathia_formulas';
let kpFormulaCache = null;

function _formulaKey(latex) {
  return _canonicalFormulaText(latex);
}

function _canonicalFormulaText(latex) {
  let s = _stripFormulaDelimiters(_normalizeFormulaLatex(latex));
  s = s.replace(/\\qquad|\\quad|\\,/g, ' ');
  s = s.replace(/\\;/g, ' ').replace(/;/g, ' ');
  s = s.replace(/\\cdot/g, ' ');
  s = s.replace(/\s+/g, ' ').replace(/\s*([=,+\-*/])\s*/g, '$1');
  return s.trim();
}

function dedupeFormulaItems(items) {
  const map = items && typeof items === 'object' && !Array.isArray(items) ? items : {};
  const groups = {};
  for (const id in map) {
    const it = map[id];
    if (!it || typeof it.latex !== 'string') continue;
    const latex = _normalizeFormulaLatex(it.latex);
    if (latex) it.latex = latex;
    const key = _formulaKey(it.latex) + '|' + (it.sessionId || '');
    if (!groups[key]) groups[key] = [];
    groups[key].push([id, it]);
  }
  const normalized = {};
  const mergeFields = ['concept', 'meaning', 'meaningSource', 'topic', 'related', 'messageId', 'moduleKey'];
  for (const entries of Object.values(groups)) {
    const sourceRank = item => ((item.meaningSource || '') === 'model' ? 0 : 1);
    entries.sort((a, b) =>
      (sourceRank(a[1]) - sourceRank(b[1])) ||
      ((b[1].createdAt || 0) - (a[1].createdAt || 0))
    );
    const keepId = entries[0][0];
    const keep = entries[0][1];
    for (const [, other] of entries.slice(1)) {
      for (const field of mergeFields) {
        if (!keep[field] && other[field]) keep[field] = other[field];
      }
    }
    normalized[keepId] = keep;
  }
  return normalized;
}

function getFormulaCache() {
  if (kpFormulaCache) return kpFormulaCache;
  try {
    const raw = localStorage.getItem(FORMULAS_STORAGE_KEY);
    kpFormulaCache = dedupeFormulaItems(raw ? JSON.parse(raw) : {});
    setFormulaCache(kpFormulaCache);
  } catch { kpFormulaCache = {}; }
  return kpFormulaCache;
}

function setFormulaCache(items) {
  kpFormulaCache = items;
  try {
    const cleaned = dedupeFormulaItems(items);
    kpFormulaCache = cleaned;
    localStorage.setItem(FORMULAS_STORAGE_KEY, JSON.stringify(cleaned));
  } catch (e) {}
}

async function deleteFormulasBySession(sessionId) {
  const items = getFormulaCache();
  let changed = false;
  for (const id in items) {
    if (items[id].sessionId === sessionId) {
      delete items[id];
      changed = true;
    }
  }
  if (changed) setFormulaCache(items);
  // 服务端按会话删除
  try {
    await fetch('/api/formulas?session_id=' + encodeURIComponent(sessionId), { method: 'DELETE' });
  } catch (err) {
    console.warn('Delete formulas by session failed:', err);
  }
}

async function saveFormulasToServer(formulas) {
  if (!formulas || formulas.length === 0) return;
  const cache = getFormulaCache();
  const pending = [];
  let changed = false;
  for (const item of formulas) {
    const latex = _normalizeFormulaLatex(item.latex);
    const normalized = _stripFormulaDelimiters(latex);
    if (!_looksLikeFormula(normalized)) continue;
    const key = _formulaKey(latex);
    const existing = Object.values(cache).find(it =>
      it.sessionId === (item.sessionId || '') &&
      _formulaKey(it.latex) === key
    );
    if (existing) {
      let merged = false;
      const incomingSource = item.meaningSource || 'local';
      const existingSource = existing.meaningSource || 'local';
      if (
        item.meaning &&
        existing.meaning !== item.meaning &&
        (incomingSource === 'model' || existingSource !== 'model')
      ) {
        existing.meaning = item.meaning;
        existing.meaningSource = incomingSource;
        merged = true;
      }
      if (item.concept && (!existing.concept || /(相关公式|物理视角|数学视角)/.test(existing.concept))) {
        existing.concept = item.concept;
        merged = true;
      }
      if (item.messageId && !existing.messageId) {
        existing.messageId = item.messageId;
        merged = true;
      }
      if (item.moduleKey && !existing.moduleKey) {
        existing.moduleKey = item.moduleKey;
        merged = true;
      }
      if (merged) {
        changed = true;
        pending.push(existing);
      }
      continue;
    }

    const id = item.id || ('f_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12));
    const saved = {
      id,
      latex,
      concept: item.concept || '',
      meaning: item.meaning || '',
      meaningSource: item.meaningSource || 'local',
      topic: item.topic || '',
      related: item.related || [],
      sessionId: item.sessionId || '',
      messageId: item.messageId || '',
      moduleKey: item.moduleKey || '',
      nodeId: item.nodeId || '',
      createdAt: item.createdAt || Date.now(),
    };
    cache[id] = saved;
    pending.push(saved);
    changed = true;
  }
  if (changed) setFormulaCache(cache);
  if (!pending.length) return;

  const snapshot = pending.map(item => ({ ...item }));
  kpFormulaSaveQueue = kpFormulaSaveQueue
    .catch(() => false)
    .then(async () => {
      try {
        return await fetch('/api/formulas', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: snapshot })
        });
      } catch (err) {
        console.warn('Save formulas to server failed:', err);
        return false;
      }
    });
  return kpFormulaSaveQueue;
}

function switchKpTab(tab) {
  document.querySelectorAll('.kp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('kpKnowledgeView').style.display = tab === 'knowledge' ? '' : 'none';
  document.getElementById('kpFormulasView').style.display = tab === 'formulas' ? '' : 'none';
  if (tab === 'formulas') loadFormulas();
}

async function loadFormulas() {
  const requestSeq = ++kpFormulaLoadSeq;
  // 先显示本地缓存，服务端请求只负责补齐，避免保存期间界面为空。
  renderFormulaList();
  await kpFormulaSaveQueue.catch(() => false);
  try {
    const resp = await fetch('/api/formulas', { cache: 'no-cache' });
    if (resp.ok) {
      const data = await resp.json();
      if (requestSeq !== kpFormulaLoadSeq) return;
      const merged = {};
      for (const it of (data.items || [])) merged[it.id] = it;
      // 保留本地有而服务端没有的（离线收藏兜底）
      const cache = getFormulaCache();
      for (const id in cache) if (!merged[id]) merged[id] = cache[id];
      setFormulaCache(dedupeFormulaItems(merged));
    }
  } catch (err) {
    console.warn('Load formulas failed, use local cache:', err);
  }
  renderFormulaList();
}

function filterFormulas() { renderFormulaList(); }

function _cleanFormulaConcept(item) {
  const raw = String(item.concept || '')
    .replace(/^[🔬📐🧠💡🗺️]+\s*/, '')
    .trim();
  const moduleHeading = /(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|PhyMathia|学习卡片)/;
  if (!raw || moduleHeading.test(raw)) {
    const meaning = String(item.meaning || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const colonMatch = meaning.match(/^([^：，。；、]{2,24})[：:]/);
    if (colonMatch && !moduleHeading.test(colonMatch[1])) return colonMatch[1].trim();
    const match = meaning.match(/^([^，。；、]{2,24})是/);
    if (match && !moduleHeading.test(match[1])) return match[1].trim();
    return '相关公式';
  }
  return raw.replace(/的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$/, '').trim();
}

function renderFormulaList() {
  const listEl = document.getElementById('kpFormulaList');
  const items = Object.values(getFormulaCache());
  const search = (document.getElementById('kpFormulaSearch')?.value || '').toLowerCase().trim();
  let filtered = items;
  if (search) {
    filtered = filtered.filter(it =>
      (it.concept || '').toLowerCase().includes(search) ||
      (it.meaning || '').toLowerCase().includes(search) ||
      (it.topic || '').toLowerCase().includes(search) ||
      (it.latex || '').toLowerCase().includes(search) ||
      (it.related || []).some(t => String(t).toLowerCase().includes(search))
    );
  }
  filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (filtered.length === 0) {
      listEl.innerHTML = `<div class="kp-empty"><div class="kp-empty-icon">${UI_ICON_SVG.formula}</div><div class="kp-empty-text">${search ? '没有找到匹配的公式' : '还没有公式，提问回答会自动收集公式，收藏回复时也可手动填写'}</div></div>`;
    return;
  }

  let html = '';
  for (const it of filtered) {
    // 渲染前清洗兜底（服务端返回的条目也可能未标准化）
    const latex = _stripFormulaDelimiters(_normalizeFormulaLatex(it.latex));
    // 语义层：单字符/纯命令/纯单位等非公式自动隐藏（旧库已存的不再显示）
    if (!_looksLikeFormula(latex)) continue;
    let latexHtml = '';
    try {
      // 工具层：KaTeX 语法校验（throwOnError:false 时非法命令输出 katex-error 标记 → 跳过）
      latexHtml = katex.renderToString(latex, { throwOnError: false, displayMode: true });
      if (/katex-error/.test(latexHtml)) continue;
    } catch (e) {
      continue;
    }
    let relatedTags = (it.related || []).map(t => String(t).trim()).filter(Boolean);
    const rawConcept = String(it.concept || '');
    if (/物理视角|物理直觉/.test(rawConcept)) {
      relatedTags = relatedTags.filter(t => t !== '数学');
      if (!relatedTags.includes('物理')) relatedTags.unshift('物理');
    } else if (/数学视角|数学本质/.test(rawConcept)) {
      relatedTags = relatedTags.filter(t => t !== '物理');
      if (!relatedTags.includes('数学')) relatedTags.unshift('数学');
    }
    const relatedHtml = relatedTags.map(t => {
      const tag = t;
      const tagClass = tag === '物理' ? 'kp-tag kp-tag-physics' : tag === '数学' ? 'kp-tag kp-tag-math' : 'kp-tag';
      return `<span class="${tagClass}">${escapeHtml(tag)}</span>`;
    }).join('');
    const timeStr = it.createdAt ? new Date(it.createdAt).toLocaleDateString('zh-CN') : '';
    const concept = _cleanFormulaConcept(it);
    const meaning = String(it.meaning || '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const meaningHtml = meaning ? escapeHtml(meaning.length > 320 ? meaning.slice(0, 320) + '...' : meaning) : '';
    // 来源会话：存在则显示可点击定位（跳转到产生该公式的对话）
    const srcSession = it.sessionId && typeof window.getSessionById === 'function' ? window.getSessionById(it.sessionId) : null;
    const srcHtml = srcSession
      ? `<div class="kp-formula-src" onclick="locateFormulaNode('${it.id}')" title="点击跳转到对应节点">📌 ${escapeHtml(srcSession.title || '来源画布')}</div>`
      : '';
    html += `
      <div class="kp-formula-card">
        <div class="kp-formula-latex">${latexHtml}</div>
        <div class="kp-formula-info">
          <div class="kp-formula-concept">${escapeHtml(concept)}</div>
          ${srcHtml}
          <div class="kp-formula-meta">${escapeHtml(it.topic || '')}${it.topic ? ' · ' : ''}${timeStr}</div>
          ${meaningHtml ? `<div class="kp-formula-meaning">${meaningHtml}</div>` : ''}
          ${relatedHtml ? `<div class="kp-card-tags">${relatedHtml}</div>` : ''}
        </div>
        <div class="kp-formula-actions">
          <button class="kp-action-btn kp-btn-primary" onclick="locateFormulaNode('${it.id}')">定位节点</button>
          <button class="kp-action-btn kp-btn-danger" onclick="confirmDeleteFormula('${it.id}')">删除</button>
        </div>
      </div>`;
  }
  listEl.innerHTML = html;
}

function _resolveFormulaAnchor(item, messages) {
  let messageId = String(item.messageId || '');
  let moduleKey = '';
  let message = _messageByTimestamp(messages, messageId);

  if (!messageId) {
    const conceptKey = _normalizeKnowledgeKey(item.concept);
    if (conceptKey) {
      const knowledgeItem = Object.values(getKnowledgeItems()).find(k =>
        k.sessionId === item.sessionId && _normalizeKnowledgeKey(k.title) === conceptKey
      );
      if (knowledgeItem && knowledgeItem.messageId) {
        messageId = String(knowledgeItem.messageId);
        message = _messageByTimestamp(messages, messageId);
      }
    }
  }

  if (!messageId || !message) {
    for (const m of [...(messages || [])].reverse()) {
      if (m.role === 'assistant' && _contentContainsFormula(m.content, item.latex)) {
        message = m;
        messageId = String(m.timestamp);
        break;
      }
    }
  }

  if (!messageId) {
    if (item.nodeId) {
      return { sessionId: item.sessionId, messageId: '', moduleKey: moduleKey || '', nodeId: item.nodeId };
    }
    return null;
  }
  if (!moduleKey && message) moduleKey = _moduleKeyForFormulaInMessage(message, item.latex);
  if (!moduleKey && item.moduleKey && item.moduleKey !== 'answer') moduleKey = item.moduleKey;
  if (!moduleKey) {
    const tags = item.related || [];
    if (tags.includes('数学')) moduleKey = 'math';
    else if (tags.includes('物理')) moduleKey = 'physics';
  }
  return { sessionId: item.sessionId, messageId, moduleKey: moduleKey || '', nodeId: item.nodeId || '' };
}

async function locateFormulaNode(formulaId) {
  const item = getFormulaCache()[formulaId];
  if (!item) {
    _showJumpError('找不到对应的公式');
    return false;
  }
  const session = typeof window.getSessionById === 'function' ? window.getSessionById(item.sessionId) : null;
  if (!session) {
    _showJumpError('来源画布已删除，无法定位');
    return false;
  }
  closeKnowledgePanel();
  const currentId = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  if (item.sessionId !== currentId && typeof window.switchToSession === 'function') {
    await window.switchToSession(item.sessionId);
  }
  await _ensureSessionMessages(item.sessionId);
  const messages = typeof window.getChatHistory === 'function' ? window.getChatHistory() : [];
  const anchor = _resolveFormulaAnchor(item, messages);
  if (!anchor) {
    _showJumpError('找不到公式对应的节点');
    return false;
  }
  if (!anchor.messageId) {
    if (anchor.nodeId && typeof window.focusGraphNodeById === 'function') {
      const ok = await window.focusGraphNodeById(anchor.nodeId);
      if (ok) return true;
    }
    _showJumpError('找不到公式对应的节点');
    return false;
  }
  if (typeof window.focusGraphNode !== 'function') {
    _showJumpError('探索网节点定位功能暂不可用');
    return false;
  }
  const ok = await window.focusGraphNode(anchor.sessionId, anchor.messageId, anchor.moduleKey);
  if (!ok) {
    _showJumpError('对应节点不存在，无法定位');
    return false;
  }
  return true;
}

// 旧接口兼容：只切换会话并关闭知识面板
function locateFormulaSession(sessionId) {
  const session = typeof window.getSessionById === 'function' ? window.getSessionById(sessionId) : null;
  if (!session) {
    alert('来源画布已删除，无法定位');
    return;
  }
  if (typeof window.switchToSession === 'function') window.switchToSession(sessionId);
  closeKnowledgePanel();
}

async function confirmDeleteFormula(id) {
  if (!confirm('确定删除此公式？')) return;
  const items = getFormulaCache();
  delete items[id];
  setFormulaCache(items);
  try {
    await fetch('/api/formulas/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (err) {
    console.warn('Delete formula on server failed:', err);
  }
  renderFormulaList();
}

// 暴露缓存失效接口给其他模块（session.js 定时同步、chat.js 提取刷新使用）
window.invalidateKnowledgeCache = invalidateKnowledgeCache;
window.goToKnowledgeNode = goToKnowledgeNode;
window.locateFormulaNode = locateFormulaNode;
window.waitForKnowledgeSave = () => kpKnowledgeSaveQueue.catch(() => false);
window.waitForFormulaSave = () => kpFormulaSaveQueue.catch(() => false);
