// ====== Knowledge Overview System ======
let kpFilterCategory = 'all';
let kpFilterSource = 'all';
let kpKnowledgeCache = null;

function getKnowledgeItems() {
  if (kpKnowledgeCache) return kpKnowledgeCache;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_KNOWLEDGE);
    kpKnowledgeCache = raw ? JSON.parse(raw) : {};
  } catch { kpKnowledgeCache = {}; }
  return kpKnowledgeCache;
}

async function saveKnowledgeItems(items) {
  kpKnowledgeCache = items;
  localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(items));
  _saveKnowledgeToServer(items);
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
  const overlay = document.getElementById('knowledgeOverlay');
  const isOpen = panel.classList.contains('active');
  if (isOpen) {
    closeKnowledgePanel();
  } else {
    panel.classList.add('active');
    overlay.classList.add('active');
    renderKnowledgePanel();
  }
}

function closeKnowledgePanel() {
  document.getElementById('knowledgePanel').classList.remove('active');
  document.getElementById('knowledgeOverlay').classList.remove('active');
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
    timeline.innerHTML = `<div class="kp-empty"><div class="kp-empty-icon">📚</div><div class="kp-empty-text">${search ? '没有找到匹配的知识条目' : '还没有知识条目，开始对话或收藏回复吧'}</div></div>`;
    return;
  }

  let html = '';
  for (const label of allLabels) {
    const groupItems = groups[label];
    html += `<div class="kp-date-group"><div class="kp-date-label">${label}</div>`;
    for (const item of groupItems) {
      const catClass = item.category || 'other';
      const sourceIcon = item.source === 'ai_extract' ? '🤖' : '⭐';
      const sourceText = item.source === 'ai_extract' ? 'AI提取' : '手动收藏';
      const tagsHtml = (item.tags || []).map(t => `<span class="kp-tag">${escapeHtml(t)}</span>`).join('');
      const formulasHtml = (item.formulas || []).map(f => {
        try {
          return `<div class="kp-formula-item">${katex.renderToString(f, { throwOnError: false, displayMode: true })}</div>`;
        } catch(e) {
          return `<div class="kp-formula-item">${escapeHtml(f)}</div>`;
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
                <button class="kp-action-btn kp-btn-primary" onclick="event.stopPropagation(); goToOriginalMessage('${item.sessionId}','${item.messageId || ''}')">查看原对话</button>
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

function goToOriginalMessage(sessionId, messageId) {
  closeKnowledgePanel();
  if (sessionId && sessionId !== currentSessionId) {
    switchToSession(sessionId);
  }
  // Scroll to message after a short delay
  setTimeout(() => {
    if (messageId) {
      const msgEl = document.querySelector(`[data-message-id="${messageId}"]`);
      if (msgEl) {
        msgEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msgEl.style.outline = '2px solid var(--accent)';
        setTimeout(() => { msgEl.style.outline = ''; }, 2000);
      }
    }
  }, 500);
}
