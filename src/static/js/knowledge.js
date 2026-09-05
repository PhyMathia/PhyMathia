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

// 摘要来源保优等级：manual > model > local（与后端 _dedupe_knowledge 的
// _summary_source_rank 同一口径；旧数据无 summarySource 视为 local）
function _summarySourceRankOf(item) {
  const s = (item && item.summarySource) || 'local';
  return s === 'manual' ? 0 : s === 'model' ? 1 : 2;
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
      .sort((a, b) =>
        // 保优排序：summarySource 等级优先，长度仅作同源 tie-break
        // （与后端 _dedupe_knowledge 同步，保证 15 秒定时同步并集合并不来回覆盖）
        (_summarySourceRankOf(a.item) - _summarySourceRankOf(b.item)) ||
        ((b.item.summary || '').length - (a.item.summary || '').length) ||
        ((b.item.formulas || []).length - (a.item.formulas || []).length) ||
        ((b.item.createdAt || 0) - (a.item.createdAt || 0))
      );
    const keep = ranked[0].item;
    const formulas = [];
    const seen = new Set();
    for (const entry of ranked) {
      if (!keep.anchorSummary && entry.item.anchorSummary) keep.anchorSummary = entry.item.anchorSummary;
      for (const formula of entry.item.formulas || []) {
        const key = _canonicalFormulaText(formula);
        if (formula && key && !seen.has(key)) {
          seen.add(key);
          formulas.push(formula);
        }
      }
    }
    keep.formulas = formulas;
    // 保留条目摘要为空时不丢整组摘要：只继承摘要文本与锚点；
    // summarySource 保留保留条自身的标记（降级会让 manual 条目在下轮去重中被误删）
    if (!String(keep.summary || '').trim()) {
      const donor = ranked.find(e => String(e.item.summary || '').trim());
      if (donor) keep.summary = donor.item.summary;
    }
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

async function _deleteKnowledgeOnServer(ids) {
  // 后端 POST /api/knowledge 是纯 merge：本地删除必须逐条调 DELETE，
  // 否则 15 秒定时同步会把服务端残留条目整表拉回（“删了又复活”）
  const list = (ids || []).filter(Boolean);
  for (const id of list) {
    try {
      await fetch('/api/knowledge/' + encodeURIComponent(id), { method: 'DELETE' });
    } catch (err) {
      console.warn('Delete knowledge on server failed:', id, err);
    }
  }
}

async function deleteKnowledgeItem(id) {
  // 先删服务端再删本地，避免删除瞬间被定时同步的并集合并拉回
  await _deleteKnowledgeOnServer([id]);
  const items = getKnowledgeItems();
  delete items[id];
  await saveKnowledgeItems(items);
}

async function deleteKnowledgeBySession(sessionId) {
  const items = getKnowledgeItems();
  const removedIds = [];
  for (const id in items) {
    if (items[id].sessionId === sessionId) {
      removedIds.push(id);
    }
  }
  if (!removedIds.length) return;
  await _deleteKnowledgeOnServer(removedIds);
  for (const id of removedIds) {
    delete items[id];
  }
  await saveKnowledgeItems(items);
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
  // 中断进行中的批量摘要优化（可停止注册表：关闭面板即中止，不再发出后续请求）
  abortKnowledgeSummaryOptimize();
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
                ${isLegacyCardSummaryItem(item) ? `<button class="kp-action-btn kp-btn-primary" onclick="event.stopPropagation(); restatKnowledgeItemSummary('${item.id}')">重述摘要</button>` : ''}
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

// ===== 存量摘要优化（P3 方案 B：AI 重述入口） =====

// 摘要比对用的纯文本口径：剥标签 + 折叠空白（与提取侧 summary 的清洗口径一致）
function _normalizePlainSummaryText(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// 重述目标判定：summary 仍是「整卡摘要」的条目。
// 口径：summarySource 为空或 'local'，且 summary 等于整卡摘要——即 anchorSummary
//（保存时的 <summary> 原文 / 正文前 120 字，P2 anchor 契约语义）；
// 旧数据无 anchorSummary 时，仅聊天提取链路（source 缺省或 'ai_extract'）的摘要
// 必然是整卡摘要（旧提取两条路径都写整卡摘要）；file/harness 是文档/节点内容摘要不碰；
// 手动收藏（source='manual'，含旧数据无 summarySource 的手动条目）永不触碰。
function isLegacyCardSummaryItem(item) {
  if (!item || typeof item !== 'object') return false;
  if (item.source === 'manual') return false;
  if ((item.summarySource || 'local') !== 'local') return false;
  const summary = _normalizePlainSummaryText(item.summary);
  if (!summary) return false;
  const anchor = _normalizePlainSummaryText(item.anchorSummary);
  if (anchor) return summary === anchor;
  return !item.source || item.source === 'ai_extract';
}

// 从公式速查库取条目公式的 meaning（同会话优先，跨会话同名公式兜底）
function _knowledgeFormulaMeanings(item) {
  const cache = typeof getFormulaCache === 'function' ? getFormulaCache() : {};
  const out = [];
  for (const latex of (item.formulas || [])) {
    const key = _formulaKey(latex);
    if (!key) continue;
    let hit = null;
    for (const f of Object.values(cache)) {
      if (_formulaKey(f.latex) !== key) continue;
      if (f.sessionId === item.sessionId) { hit = f; break; }
      if (!hit) hit = f;
    }
    out.push({ latex, meaning: _normalizePlainSummaryText(hit && hit.meaning) });
  }
  return out;
}

// 重述提示词：按 (title, formulas, meaning) 组装（计划 §2 P3 口径）
function _buildSummaryRestatePrompt(item, meanings) {
  const lines = [];
  lines.push('请为下面的知识点重写一句摘要，替换掉旧的整卡复述摘要。');
  lines.push('');
  lines.push('知识点标题：' + String(item.title || '').trim());
  lines.push('分类：' + (item.category === 'physics' ? '物理' : item.category === 'math' ? '数学' : '其他'));
  if (meanings && meanings.length) {
    lines.push('关联公式：');
    for (const m of meanings) {
      lines.push('- ' + m.latex + (m.meaning ? '（含义：' + m.meaning + '）' : '（含义待补充）'));
    }
  }
  lines.push('旧摘要（整卡复述，必须替换，不要复用其中的措辞）：' + _normalizePlainSummaryText(item.summary));
  lines.push('');
  lines.push('要求：');
  lines.push('1. 摘要必须描述「该知识点本身」：它是什么、有什么物理/数学意义；');
  lines.push('2. 若有关联公式，需点出公式的物理/数学含义（可参考上面给出的含义说明）；');
  lines.push('3. 不超过 60 字，一句通顺的中文；');
  lines.push('4. 只输出摘要正文，不要任何解释或前缀。');
  return lines.join('\n');
}

// 模型回复清洗：剥思考块 → 丢解释行/前缀/引号 → 单行限长
function _cleanRestatedSummaryText(raw) {
  const text = (typeof _stripThinkText === 'function' ? _stripThinkText(String(raw || '')) : String(raw || ''))
    .replace(/<[^>]+>/g, ' ');
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean)
    .filter(s => !/[：:]$/.test(s)); // 丢「以下是摘要：」类引导行
  let out = lines[0] || '';
  out = out
    .replace(/^(摘要|总结|一句话摘要|知识点摘要)\s*[：:]\s*/, '')
    .replace(/^[\*\\"'“”‘’「『【（(]+/, '').replace(/[\*\\"'“”‘’」』】》）)]+$/, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return out.slice(0, 120);
}

// 重述单条调用：优先公式描述模型（descriptor 槽位），未配置回退主模型；
// 走既有 /api/models/chat 代理逐条调用（messages 直传旧格式，stream:false），不新增后端端点。
async function _requestRestatedSummary(item, model, signal) {
  const messages = [
    { role: 'system', content: '你是物理数学知识库的摘要助手。只输出一句知识点摘要正文，不要解释、前缀、引号或列表。' },
    { role: 'user', content: _buildSummaryRestatePrompt(item, _knowledgeFormulaMeanings(item)) },
  ];
  const resp = await proxyChatWithModel(model, { messages, stream: false }, signal);
  const data = await resp.json();
  const raw = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return _cleanRestatedSummaryText(raw);
}

// 写回：旧摘要先落为定位锚点（P2 契约：无锚点时替换前先保锚），再更新摘要与来源标记
function _applyRestatedSummary(item, text) {
  if (!String(item.anchorSummary || '').trim() && item.summary) item.anchorSummary = item.summary;
  item.summary = text;
  item.summarySource = 'model';
}

// === 批量任务可停止注册表 ===
// 吸取交接文档 A2「AbortController 无人持有无法中止」教训：控制器挂模块级注册表
// `_kpSummaryOptimizeAbort`，Esc 监听随任务注册/注销——关闭面板、再次点击、Esc
// 任一路径都经 abortKnowledgeSummaryOptimize() 中止；中止后批量循环不再发后续请求
//（循环每轮先查 signal + 在途 fetch 被拒后 break，双保险）。
let _kpSummaryOptimizeAbort = null;
let _kpSummaryOptimizeEscCloser = null;

function _knowledgeSummaryTaskRunning() {
  return !!_kpSummaryOptimizeAbort;
}

function abortKnowledgeSummaryOptimize() {
  const controller = _kpSummaryOptimizeAbort;
  _kpSummaryOptimizeAbort = null;
  if (controller) {
    try { controller.abort(); } catch (e) {}
  }
  if (_kpSummaryOptimizeEscCloser) {
    document.removeEventListener('keydown', _kpSummaryOptimizeEscCloser, true);
    _kpSummaryOptimizeEscCloser = null;
  }
  _setKpOptimizeButtonRunning(false);
}

function _setKpOptimizeButtonRunning(running) {
  const btn = document.getElementById('kpOptimizeBtn');
  if (!btn) return;
  btn.classList.toggle('running', running);
  btn.textContent = running ? '■ 停止优化' : '✦ 优化摘要';
}

function _activeModelForSummaryRestate() {
  if (typeof getActiveModelForRole !== 'function') return null;
  return getActiveModelForRole('descriptor') || getActiveModelForRole('agent');
}

// 批量入口（面板工具按钮）：再次点击即中断；目标逐条现判现发，manual/model 条目绝不触碰
async function optimizeKnowledgeSummaries() {
  if (_knowledgeSummaryTaskRunning()) {
    abortKnowledgeSummaryOptimize();
    showToast('已停止优化摘要，已完成条目保留');
    return;
  }
  const targetIds = Object.values(getKnowledgeItems())
    .filter(isLegacyCardSummaryItem)
    .map(it => it.id);
  if (!targetIds.length) {
    showToast('没有需要优化的旧摘要（均为手动/模型摘要或已优化）');
    return;
  }
  const model = _activeModelForSummaryRestate();
  if (!model) {
    showToast('未配置 AI 模型，请在模型设置中配置（公式描述模型或主模型均可）');
    return;
  }
  const controller = new AbortController();
  _kpSummaryOptimizeAbort = controller;
  _kpSummaryOptimizeEscCloser = (event) => {
    if (event.key === 'Escape') abortKnowledgeSummaryOptimize();
  };
  document.addEventListener('keydown', _kpSummaryOptimizeEscCloser, true);
  _setKpOptimizeButtonRunning(true);

  const total = targetIds.length;
  let done = 0, ok = 0, failed = 0, skipped = 0;
  let aborted = false;
  try {
    for (const id of targetIds) {
      if (controller.signal.aborted) { aborted = true; break; } // 中止后不再发出后续请求
      const currentMap = getKnowledgeItems();
      const current = currentMap[id] || null;
      // 任务期间数据可能变化（15 秒同步/手动编辑）：发送前现判，非目标条目直接跳过
      if (!current || !isLegacyCardSummaryItem(current)) { skipped++; continue; }
      done++;
      showToast('优化摘要 ' + done + '/' + total + '：' + String(current.title || '').slice(0, 16) + '...', 4000);
      try {
        const text = await _requestRestatedSummary(current, model, controller.signal);
        if (!text) { failed++; continue; }
        _applyRestatedSummary(current, text);
        await saveKnowledgeItems(currentMap);
        ok++;
      } catch (err) {
        if (controller.signal.aborted) { aborted = true; break; } // 用户中断不计为失败
        failed++;
        console.warn('Optimize knowledge summary failed:', (current && current.title) || id, err);
      }
    }
  } finally {
    const wasAborted = aborted || controller.signal.aborted;
    abortKnowledgeSummaryOptimize(); // 清注册表 + 注销 Esc 监听 + 复位按钮
    invalidateKnowledgeCache();
    const panel = document.getElementById('knowledgePanel');
    if (panel && panel.classList && panel.classList.contains('active')) renderKnowledgePanel();
    const skipText = skipped ? '，跳过 ' + skipped + ' 条（期间已变更）' : '';
    if (wasAborted) showToast('已停止：优化 ' + ok + ' 条，失败 ' + failed + ' 条' + skipText, 4000);
    else if (failed) showToast('优化完成：' + ok + '/' + total + ' 成功，失败 ' + failed + ' 条' + skipText, 4000);
    else showToast('优化完成：已重述 ' + ok + ' 条旧摘要' + skipText, 4000);
  }
}

// 单条入口（知识卡片按钮）：重验判定规则，manual/model 条目拒绝重述
async function restatKnowledgeItemSummary(itemId) {
  if (_knowledgeSummaryTaskRunning()) {
    showToast('批量优化进行中，请先点击「优化摘要」停止');
    return;
  }
  const items = getKnowledgeItems();
  const item = items[itemId];
  if (!item) { showToast('找不到对应的知识点'); return; }
  if (!isLegacyCardSummaryItem(item)) {
    showToast('该条目为手动/模型摘要，不自动重述');
    return;
  }
  const model = _activeModelForSummaryRestate();
  if (!model) {
    showToast('未配置 AI 模型，请在模型设置中配置（公式描述模型或主模型均可）');
    return;
  }
  showToast('正在重述摘要：' + String(item.title || '').slice(0, 16) + '...', 4000);
  try {
    const text = await _requestRestatedSummary(item, model, new AbortController().signal);
    if (!text) { showToast('模型未返回有效摘要，请稍后重试'); return; }
    _applyRestatedSummary(item, text);
    await saveKnowledgeItems(items);
    invalidateKnowledgeCache();
    renderKnowledgePanel();
    showToast('摘要已重述');
  } catch (err) {
    console.warn('Restate knowledge summary failed:', itemId, err);
    showToast('重述失败：' + ((err && err.message) || err));
  }
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
  if (anchor.nodeId && typeof window.focusGraphNodeById === 'function') {
    const ok = await window.focusGraphNodeById(anchor.nodeId);
    if (ok) return true;
  }
  if (anchor.messageId && typeof window.focusGraphNode === 'function') {
    const ok = await window.focusGraphNode(anchor.sessionId, anchor.messageId, anchor.moduleKey);
    if (ok) return true;
  }
  const matched = await _focusKnowledgeNodeByContent(item, anchor.moduleKey);
  if (matched) return true;
  _showJumpError('对应节点不存在，无法定位');
  return false;
}

function _summaryFragmentsForMatch(text) {
  const clean = String(text || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[#*`_>\[\]()\\$|~^+\-]/g, '')
    .replace(/\s+/g, '');
  const frags = [];
  for (let i = 0; i < clean.length; i++) {
    const frag = clean.slice(i, i + 6);
    if (frag.length >= 4) frags.push(frag);
  }
  return frags;
}

async function _focusKnowledgeNodeByContent(item, moduleKey) {
  if (typeof window.getGraphViewNodes !== 'function') return false;
  const formulas = (item.formulas && item.formulas.length) ? item.formulas
    : (item.latex ? [item.latex] : []);
  // 定位锚点：优先 anchorSummary（保存时的整卡摘要原文），旧数据无该字段回退
  // summary——摘要被保优合并改写后仍能按原文本匹配画布节点
  const frags = _summaryFragmentsForMatch(item.anchorSummary || item.summary || item.concept || item.title || '');
  const nodes = window.getGraphViewNodes().filter(n =>
    n && n.messageIndex === -1 && (!moduleKey || !n.moduleKey || n.moduleKey === moduleKey)
  );
  for (const node of nodes) {
    const text = String(node.content || node.label || '');
    if (formulas.length && formulas.some(f => _contentContainsFormula(text, f))) {
      if (await _tryFocusGraphNodeById(node.id)) return true;
    }
  }
  for (const node of nodes) {
    const text = String(node.content || node.label || '');
    if (frags.length && frags.some(f => text.includes(f))) {
      if (await _tryFocusGraphNodeById(node.id)) return true;
    }
  }
  return false;
}

async function _tryFocusGraphNodeById(nodeId) {
  if (!nodeId || typeof window.focusGraphNodeById !== 'function') return false;
  try {
    return !!await window.focusGraphNodeById(nodeId);
  } catch (e) {
    return false;
  }
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
  const mergeFields = ['concept', 'meaning', 'meaningSource', 'topic', 'related', 'messageId', 'moduleKey', 'nodeId'];
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
  // 「优化摘要」只作用于知识点，公式速查页隐藏入口
  const optimizeBtn = document.getElementById('kpOptimizeBtn');
  if (optimizeBtn) optimizeBtn.style.display = tab === 'knowledge' ? '' : 'none';
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
      for (const id in cache) {
        if (!merged[id]) {
          merged[id] = cache[id];
        } else if (!merged[id].nodeId && cache[id].nodeId) {
          merged[id].nodeId = cache[id].nodeId;
        }
      }
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
  if (anchor.nodeId && typeof window.focusGraphNodeById === 'function') {
    const ok = await window.focusGraphNodeById(anchor.nodeId);
    if (ok) return true;
  }
  if (anchor.messageId && typeof window.focusGraphNode === 'function') {
    const ok = await window.focusGraphNode(anchor.sessionId, anchor.messageId, anchor.moduleKey);
    if (ok) return true;
  }
  const matched = await _focusKnowledgeNodeByContent(item, anchor.moduleKey);
  if (matched) return true;
  _showJumpError('找不到公式对应的节点');
  return false;
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
