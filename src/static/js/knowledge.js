// ====== Knowledge Overview System ======
let kpFilterCategory = 'all';
let kpFilterSource = 'all';
let kpKnowledgeCache = null;

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
  } catch { kpKnowledgeCache = {}; }
  return kpKnowledgeCache;
}

async function saveKnowledgeItems(items) {
  kpKnowledgeCache = items;
  localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(items));
  _saveKnowledgeToServer(items);
}

// 面板打开时的快速刷新通道：直接 fetch 知识+公式（不经 _checkServer/全量同步），
// 与服务端做并集合并（服务端优先、本地独有不丢），更新缓存与 localStorage。
// 链路最短最可靠——打开面板后几百毫秒内即为服务端最新数据。
async function _quickRefreshKnowledge() {
  try {
    const [knowResp, formulaResp] = await Promise.all([
      fetch('/api/knowledge', { cache: 'no-cache' }),
      fetch('/api/formulas', { cache: 'no-cache' }),
    ]);
    if (knowResp.ok) {
      const serverMap = await knowResp.json();
      if (serverMap && typeof serverMap === 'object' && !Array.isArray(serverMap)) {
        const local = getKnowledgeItems() || {};
        const merged = { ...local, ...serverMap };
        kpKnowledgeCache = merged;
        localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(merged));
      }
    }
    if (formulaResp.ok) {
      const data = await formulaResp.json();
      const serverFormulas = {};
      for (const it of (data.items || [])) serverFormulas[it.id] = it;
      const localFormulas = getFormulaCache() || {};
      const mergedFormulas = { ...localFormulas, ...serverFormulas };
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
  const overlay = document.getElementById('knowledgeOverlay');
  const isOpen = panel.classList.contains('active');
  if (isOpen) {
    closeKnowledgePanel();
  } else {
    panel.classList.add('active');
    overlay.classList.add('active');
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

// ====== 公式速查库 ======
const FORMULAS_STORAGE_KEY = 'phymathia_formulas';
let kpFormulaCache = null;

// KaTeX renderToString 不识别 $ 定界符（$ 会作为文本渲染），渲染前剥离
function _stripFormulaDelimiters(latex) {
  return String(latex || '').replace(/^\$+|\$+$/g, '').trim();
}

// 与后端 _looks_like_formula 一致：排除单字符/纯短字母/纯命令/纯 \text{}/单位斜杠
function _looksLikeFormula(latex) {
  const s = String(latex || '').trim();
  if (!s) return false;
  if (s.length === 1) return false;                        // 单字符：m、k
  if (/^[A-Za-z]{1,3}$/.test(s)) return false;             // 纯短字母：rad、Hz
  if (/^\\[A-Za-z]+$/.test(s)) return false;               // 纯符号命令：\omega
  if (/^\\text\{[^{}]*\}$/.test(s)) return false;          // 纯 \text{...}：\text{rad/s}
  if (/^[A-Za-z]{1,4}(\/[A-Za-z]{1,4})+$/.test(s)) return false; // 单位：rad/s、m/s
  return true;
}

// 与后端 _normalize_formula 一致：\$→$、去首尾 $、统一包 $..$，并清洗 \= 等无效命令
function _normalizeFormulaLatex(latex) {
  let s = String(latex || '').trim();
  s = s.replace(/\\\$/g, '$').trim();
  s = s.replace(/^\$+|\$+$/g, '').trim();
  s = s.replace(/\\([=,;:])/g, '$1');
  return s ? '$' + s + '$' : '';
}

function getFormulaCache() {
  if (kpFormulaCache) return kpFormulaCache;
  try {
    const raw = localStorage.getItem(FORMULAS_STORAGE_KEY);
    kpFormulaCache = raw ? JSON.parse(raw) : {};
    // 清洗旧坏缓存（含 \= 等异常转义的历史脏数据）
    let dirty = false;
    for (const id in kpFormulaCache) {
      const it = kpFormulaCache[id];
      if (it && typeof it.latex === 'string') {
        const normalized = _normalizeFormulaLatex(it.latex);
        if (normalized && normalized !== it.latex) {
          it.latex = normalized;
          dirty = true;
        }
      }
    }
    if (dirty) setFormulaCache(kpFormulaCache);
  } catch { kpFormulaCache = {}; }
  return kpFormulaCache;
}

function setFormulaCache(items) {
  kpFormulaCache = items;
  try { localStorage.setItem(FORMULAS_STORAGE_KEY, JSON.stringify(items)); } catch (e) {}
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
  try {
    await fetch('/api/formulas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: formulas })
    });
  } catch (err) {
    console.warn('Save formulas to server failed:', err);
  }
}

function switchKpTab(tab) {
  document.querySelectorAll('.kp-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('kpKnowledgeView').style.display = tab === 'knowledge' ? '' : 'none';
  document.getElementById('kpFormulasView').style.display = tab === 'formulas' ? '' : 'none';
  if (tab === 'formulas') loadFormulas();
}

async function loadFormulas() {
  const cache = getFormulaCache();
  try {
    const resp = await fetch('/api/formulas');
    if (resp.ok) {
      const data = await resp.json();
      const merged = {};
      for (const it of (data.items || [])) merged[it.id] = it;
      // 保留本地有而服务端没有的（离线收藏兜底）
      for (const id in cache) if (!merged[id]) merged[id] = cache[id];
      setFormulaCache(merged);
    }
  } catch (err) {
    console.warn('Load formulas failed, use local cache:', err);
  }
  renderFormulaList();
}

function filterFormulas() { renderFormulaList(); }

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
    listEl.innerHTML = `<div class="kp-empty"><div class="kp-empty-icon">📋</div><div class="kp-empty-text">${search ? '没有找到匹配的公式' : '还没有公式，对话回答会自动收集公式，收藏回复时也可手动填写'}</div></div>`;
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
    const relatedHtml = (it.related || []).map(t => `<span class="kp-tag">${escapeHtml(String(t))}</span>`).join('');
    const timeStr = it.createdAt ? new Date(it.createdAt).toLocaleDateString('zh-CN') : '';
    // 来源会话：存在则显示可点击定位（跳转到产生该公式的对话）
    const srcSession = it.sessionId && typeof window.getSessionById === 'function' ? window.getSessionById(it.sessionId) : null;
    const srcHtml = srcSession
      ? `<div class="kp-formula-src" onclick="locateFormulaSession('${it.sessionId}')" title="点击跳转到来源会话">📌 ${escapeHtml(srcSession.title || '来源会话')}</div>`
      : '';
    html += `
      <div class="kp-formula-card">
        <div class="kp-formula-latex">${latexHtml}</div>
        <div class="kp-formula-info">
          <div class="kp-formula-concept">${escapeHtml(it.concept || '')}</div>
          ${srcHtml}
          <div class="kp-formula-meta">${escapeHtml(it.topic || '')}${it.topic ? ' · ' : ''}${timeStr}</div>
          ${it.meaning ? `<div class="kp-formula-meaning">${escapeHtml(it.meaning)}</div>` : ''}
          ${relatedHtml ? `<div class="kp-card-tags">${relatedHtml}</div>` : ''}
        </div>
        <button class="kp-action-btn kp-btn-danger" onclick="confirmDeleteFormula('${it.id}')">删除</button>
      </div>`;
  }
  listEl.innerHTML = html;
}

// 公式定位到来源会话：切换会话并关闭知识面板
function locateFormulaSession(sessionId) {
  const session = typeof window.getSessionById === 'function' ? window.getSessionById(sessionId) : null;
  if (!session) {
    alert('来源会话已删除，无法定位');
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
