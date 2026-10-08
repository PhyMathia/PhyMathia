// ====== Knowledge Overview System ======
let kpFilterCategory = 'all';
let kpFilterSource = 'all';
let kpKnowledgeCache = null;
let kpKnowledgeSaveQueue = Promise.resolve();
let kpFormulaSaveQueue = Promise.resolve();
let kpFormulaLoadSeq = 0;

// 标题卫生（与后端 knowledge._strip_knowledge_section / _is_junk_knowledge_title 同一
// 把尺子）：章节号（「1. 定义与坐标表达」「二、从微元…」）不该进去重键，指令句回显
// （「用户要求：…」）与整句根本不是知识点。两边口径分叉 = 15 秒并集同步来回覆盖。
const KP_SECTION_PREFIX_RE = /^\s*(?:\d+\s*[、.．)）]|[一二三四五六七八九十百]+[、.．)）]|第\s*[一二三四五六七八九十百\d]+\s*[节章讲部])/;
const KP_INSTRUCTION_PREFIX_RE = /^\s*(?:用户要求|用户|请|注意|当前|根据|我们|这里|这是|如上|下面|以上|要求|本题|本节|本章)/;
const KP_CONTINUATION_RE = /[（(]\s*续\s*[)）]|续\s*$/;

function _stripKnowledgeSection(title) {
  return String(title || '').trim()
    .replace(KP_SECTION_PREFIX_RE, '')
    .replace(KP_CONTINUATION_RE, '')
    .trim();
}

function _isJunkKnowledgeTitle(title) {
  const s = _stripKnowledgeSection(title);
  if (!s) return true;
  if (KP_INSTRUCTION_PREFIX_RE.test(s)) return true;
  return /[。！？]/.test(s);
}

function _normalizeKnowledgeKey(title) {
  return _stripKnowledgeSection(title)
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
    // T146：按规范化标题全局合并（不再按会话硬分区）——同名概念跨会话只留一条，
    // 全部归属写 sessionIds（大陆投影/按会话删除据此保住跨画布信号）
    const key = _normalizeKnowledgeKey(item.title);
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(id);
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
    // T146：跨会话归属合并（保留条自身 sessionId 恒在首位）
    const sids = [];
    const seenSids = new Set();
    for (const entry of ranked) {
      for (const sid of [entry.item.sessionId, ...(entry.item.sessionIds || [])]) {
        if (sid && !seenSids.has(sid)) { seenSids.add(sid); sids.push(sid); }
      }
    }
    if (sids.length > 1) keep.sessionIds = sids;
    if (!keep.sessionId && sids.length) keep.sessionId = sids[0];
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
  // 本地写失败（配额满）不阻断：队列里的服务端同步照常，数据不丢
  safeLocalStorageSet(STORAGE_KEY_KNOWLEDGE, JSON.stringify(items));
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
      // 超时兜底（T194）：无 signal 时挂死一条，循环里后续 id 全不执行、调用方整条删除链卡死
      const resp = await fetch('/api/knowledge/' + encodeURIComponent(id), { method: 'DELETE', signal: AbortSignal.timeout(10000) });
      if (!resp.ok) console.warn('Delete knowledge on server not ok:', id, resp.status);
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
  // T146：sessionIds 感知——同名概念跨会话合并后，删一个画布只摘除该归属，
  // 还有别的归属就改主会话留下，全没了才删（与后端 _delete_items_by_session 同口径）
  for (const id in items) {
    const it = items[id];
    const sids = [...new Set([it.sessionId, ...(it.sessionIds || [])].filter(Boolean))];
    if (!sids.includes(sessionId)) continue;
    const rest = sids.filter(s => s !== sessionId);
    if (rest.length) {
      it.sessionIds = rest;
      it.sessionId = rest[0];
    } else {
      removedIds.push(id);
    }
  }
  if (!removedIds.length) {
    await saveKnowledgeItems(items);
    return;
  }
  await _deleteKnowledgeOnServer(removedIds);
  for (const id of removedIds) {
    delete items[id];
  }
  await saveKnowledgeItems(items);
}

// KaTeX 渲染缓存：latex 原文 → renderToString 结果（displayMode 恒 true）。
// 面板重渲染频繁（搜索防抖/筛选/加载更多都整面重画），同一公式反复编译是最大热点。
// 上限 2000 条 FIFO：Map 保持插入序，超限删最早键。渲染抛异常的结果不入缓存
// （坏 latex 每次重试而非永久缓存失败输出），调用方各自的兜底逻辑不变。
const _KP_KATEX_CACHE_MAX = 2000;
const _katexCache = new Map();
function _katexHtml(latex) {
  const key = String(latex == null ? '' : latex);
  const hit = _katexCache.get(key);
  if (hit !== undefined) return hit;
  let html;
  try {
    html = katex.renderToString(key, { throwOnError: false, displayMode: true });
  } catch (e) {
    return '';
  }
  if (_katexCache.size >= _KP_KATEX_CACHE_MAX) {
    _katexCache.delete(_katexCache.keys().next().value);
  }
  _katexCache.set(key, html);
  return html;
}

// 长列表分批渲染上限：初次 60 条，「加载更多」每次 +60；筛选/搜索变化时重置。
// 知识时间线与公式速查各持一份（两页互不干扰）。
const KP_PAGE_SIZE = 60;
let kpRenderLimit = KP_PAGE_SIZE;
let kpFormulaRenderLimit = KP_PAGE_SIZE;

// 展开卡记忆（仅内存级，不落 localStorage）：15 秒定时同步触发的整面重渲染
// 不再把用户展开的卡收起。renderKnowledgePanel 重建 DOM 时对集合内的卡直接
// 恢复 expanded 类并当场填好详情（置 dataset.rendered，toggleKpCard 不再重复填充）。
const _kpExpandedIds = new Set();

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
    // 恢复上次停留的标签页（键见 config.js STORAGE_KEY_KP_TAB；公式页懒加载
    // 在 switchKpTab 内保持既有行为）
    let lastTab = '';
    try { lastTab = localStorage.getItem(STORAGE_KEY_KP_TAB) || ''; } catch (e) {}
    if (lastTab === 'knowledge' || lastTab === 'formulas') switchKpTab(lastTab);
    // 关面板不再中止批量优化（2026-10-01 设计变更）：重开时若批量仍在跑，
    // 恢复「■ 停止优化」按钮运行态并重填 n/N 进度显示（进度状态存模块级变量）
    _syncKpOptimizeWidgets();
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
  // 关面板不再中止批量摘要优化（2026-10-01 设计变更）：任务后台继续、toast 继续提示，
  // 重开面板恢复按钮运行态；中止路径＝再次点击「优化摘要」按钮 / Esc
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
  kpRenderLimit = KP_PAGE_SIZE; // 筛选变化重置分批上限
  renderKnowledgePanel();
}

// 搜索框 oninput 每键触发一次 renderKnowledgePanel：整面 innerHTML 重画，
// 时间线上每条公式还要跑 katex.renderToString——大知识库打字会一顿一顿。
// 200ms 防抖合并；清空搜索词立即出结果（回退场景不该等）。
let _kpFilterTimer = 0;
function filterKnowledge() {
  const input = document.getElementById('kpSearch');
  kpRenderLimit = KP_PAGE_SIZE; // 搜索词变化重置分批上限
  if (_kpFilterTimer) { clearTimeout(_kpFilterTimer); _kpFilterTimer = 0; }
  if (!input || !input.value.trim()) { renderKnowledgePanel(); return; }
  _kpFilterTimer = setTimeout(() => { _kpFilterTimer = 0; renderKnowledgePanel(); }, 200);
}

// 时间线「加载更多」：提高分批上限后整面重渲染（KaTeX 缓存令已渲染部分近乎免费）
function loadMoreKnowledge() {
  kpRenderLimit += KP_PAGE_SIZE;
  renderKnowledgePanel();
}

// 一键清除筛选/搜索（时间线空态按钮）：分类/来源重置为全部、清空搜索框、重渲染
function clearKpFilters() {
  kpFilterCategory = 'all';
  kpFilterSource = 'all';
  document.querySelectorAll('#kpKnowledgeView .kp-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.value === 'all'));
  const input = document.getElementById('kpSearch');
  if (input) input.value = '';
  kpRenderLimit = KP_PAGE_SIZE;
  renderKnowledgePanel();
}

// 搜索框 × 清除按钮：清空并立即重渲染（知识点页）
function clearKpSearch() {
  const input = document.getElementById('kpSearch');
  if (input) input.value = '';
  kpRenderLimit = KP_PAGE_SIZE;
  renderKnowledgePanel();
}

// 搜索框 × 清除按钮：清空并立即重渲染（公式速查页）
function clearKpFormulaSearch() {
  const input = document.getElementById('kpFormulaSearch');
  if (input) input.value = '';
  kpFormulaRenderLimit = KP_PAGE_SIZE;
  renderFormulaList();
}

// Render
function renderKnowledgePanel() {
  const items = getKnowledgeItems();
  const arr = Object.values(items);
  const search = (document.getElementById('kpSearch')?.value || '').toLowerCase().trim();

  // Stats（单趟遍历累加，替代原来 3 趟 filter——大库每次重渲染都要跑）
  // 「本周新增」统一为自然周口径（2026-10-01）：与时间线「本周」分组共用同一个
  // weekStart（原统计按滚动 7 天、分组按自然周，两边数字对不上）
  const today = new Date();
  const weekStart = new Date(today); weekStart.setDate(today.getDate() - today.getDay());
  const weekStartMs = weekStart.getTime();
  let physicsCount = 0, mathCount = 0, weekCount = 0;
  for (const it of arr) {
    if (it.category === 'physics') physicsCount++;
    else if (it.category === 'math') mathCount++;
    if (it.createdAt >= weekStartMs) weekCount++;
  }
  document.getElementById('kpTotal').textContent = arr.length;
  document.getElementById('kpPhysics').textContent = physicsCount;
  document.getElementById('kpMath').textContent = mathCount;
  document.getElementById('kpThisWeek').textContent = weekCount;

  // Filter
  let filtered = arr;
  if (kpFilterCategory !== 'all') filtered = filtered.filter(i => i.category === kpFilterCategory);
  if (kpFilterSource !== 'all') filtered = filtered.filter(i => i.source === kpFilterSource);
  if (search) {
    filtered = filtered.filter(i =>
      i.title.toLowerCase().includes(search) ||
      (i.tags || []).some(t => t.toLowerCase().includes(search)) ||
      (i.summary || '').toLowerCase().includes(search) ||
      // 公式内容也纳入搜索：剥掉 $ 定界符再匹配，用户不带 $ 也能搜中
      (i.formulas || []).some(f => _stripFormulaDelimiters(f).toLowerCase().includes(search))
    );
  }

  // 结果计数：仅筛选/搜索激活时显示（全库条数统计条已有，避免重复）
  const filtersActive = !!search || kpFilterCategory !== 'all' || kpFilterSource !== 'all';
  const countEl = document.getElementById('kpResultCount');
  if (countEl) countEl.textContent = filtersActive ? '共 ' + filtered.length + ' 条' : '';

  // Sort by date desc
  filtered.sort((a, b) => b.createdAt - a.createdAt);

  // 分批渲染：先切片再分组，组序逻辑不变；上限随「加载更多」增长（筛选/搜索时已重置）
  const totalCount = filtered.length;
  if (totalCount > kpRenderLimit) filtered = filtered.slice(0, kpRenderLimit);

  // Group by date（today/weekStart 复用统计段的计算——自然周口径已统一）；
  // yesterday 提到循环外同理
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const groups = {};
  for (const item of filtered) {
    const d = new Date(item.createdAt);
    let label;
    if (d.toDateString() === today.toDateString()) label = '今天';
    else if (d.toDateString() === yesterday.toDateString()) label = '昨天';
    else {
      if (d >= weekStart) label = '本周';
      else label = `${d.getMonth() + 1}月${d.getDate()}日`;
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  }

  // Order: 今天 > 昨天 > 本周 > older
  const orderedLabels = ['今天', '昨天', '本周'];
  const otherLabels = Object.keys(groups).filter(l => !orderedLabels.includes(l)).sort((a, b) => {
    // 按组内最新 createdAt 倒序（2026-10-01 修复跨年错序）：原先解析「M月D日」标签
    // 按 月*100+日 比较，12月31日=1231 会排在 1月1日=101 前/后颠倒
    const latestOf = l => Math.max(...groups[l].map(it => it.createdAt || 0));
    return latestOf(b) - latestOf(a);
  });
  const allLabels = [...orderedLabels.filter(l => groups[l]), ...otherLabels];

  const timeline = document.getElementById('kpTimeline');
  if (filtered.length === 0) {
    // 筛选/搜索激活且无结果：显示「无结果」+ 一键清除（重置分类/来源/搜索并重渲染）
    const clearBtn = filtersActive ? '<button class="kp-clear-btn" onclick="clearKpFilters()">清除筛选</button>' : '';
    timeline.innerHTML = `<div class="kp-empty"><div class="kp-empty-icon">${UI_ICON_SVG.book}</div><div class="kp-empty-text">${filtersActive ? '无结果' : '还没有知识条目，开始提问或收藏回复吧'}</div>${clearBtn}</div>`;
    return;
  }

  let html = '';
  for (const label of allLabels) {
    const groupItems = groups[label];
    html += `<div class="kp-date-group"><div class="kp-date-label">${label}</div>`;
    for (const item of groupItems) {
      const catClass = item.category || 'other';
      // 来源标记走 UI_ICON_SVG 线稿，跟面板其余线条图标同一套笔画（emoji 走系统彩色字体，
      // 与界面里其它线性图标不统一）。sparkles 区分于 star：一个是"AI 提取"，一个是"手动收藏"。
      const sourceIcon = item.source === 'ai_extract' ? UI_ICON_SVG.sparkles
        : item.source === 'file' ? UI_ICON_SVG.note
        : item.source === 'harness' ? UI_ICON_SVG.pencil
        : UI_ICON_SVG.star;
      const sourceText = item.source === 'ai_extract' ? 'AI提取' : item.source === 'file' ? '文件导入' : item.source === 'harness' ? 'AI 编辑' : '手动收藏';
      const tagsHtml = (item.tags || []).map(t => `<span class="kp-tag">${escapeHtml(t)}</span>`).join('');
      const timeStr = new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
      // 展开状态记忆：重渲染时对集合内的卡直接恢复 expanded 并当场填好详情
      //（置 data-rendered，避免 toggleKpCard 再填一遍）
      const isExpanded = _kpExpandedIds.has(item.id);
      const detailHtml = isExpanded ? _kpCardDetailHtml(item) : '';
      html += `
        <div class="kp-card${isExpanded ? ' expanded' : ''}" data-id="${item.id}" onclick="toggleKpCard(this)">
          <div class="kp-card-header">
            <div class="kp-card-dot ${catClass}"></div>
            <div class="kp-card-info">
              <div class="kp-card-title">${escapeHtml(item.title)}</div>
              <div class="kp-card-meta"><span class="kp-source-icon">${sourceIcon}</span>${sourceText} · ${catClass === 'physics' ? '物理' : catClass === 'math' ? '数学' : '其他'} · ${timeStr}</div>
            </div>
          </div>
          <div class="kp-card-summary">${escapeHtml(item.summary || '')}</div>
          <div class="kp-card-tags">${tagsHtml}</div>
          <div class="kp-card-detail"${isExpanded ? ' data-rendered="1"' : ''}>${detailHtml}</div>
        </div>`;
    }
    html += '</div>';
  }
  const remaining = totalCount - filtered.length;
  if (remaining > 0) {
    html += `<button class="kp-load-more" onclick="loadMoreKnowledge()">加载更多（还有 ${remaining} 条）</button>`;
  }
  timeline.innerHTML = html;
}

// 单张知识卡的详情 HTML（纯函数：传 item 返回字符串）。折叠卡懒渲染后主循环不再
// 调它，由 toggleKpCard 首次展开时调用；后续恢复展开态的会话同样复用。
// 行为与旧内联版逐字等价：公式过滤/清洗/KaTeX 路径、三个按钮及其 onclick、
// isLegacyCardSummaryItem 判定全部保持原样，仅 KaTeX 走缓存 helper。
function _kpCardDetailHtml(item) {
  const formulasHtml = (item.formulas || [])
    .filter(f => _looksLikeFormula(_stripFormulaDelimiters(f)))
    .map(f => {
      const rendered = _katexHtml(_stripFormulaDelimiters(f));
      if (!rendered || /katex-error/.test(rendered)) return '';
      return `<div class="kp-formula-item">${rendered}</div>`;
    }).join('');
  return `
    <div class="kp-card-detail-inner">
      ${formulasHtml ? `<div class="kp-formulas">${formulasHtml}</div>` : ''}
      <div class="kp-detail-actions">
        <button class="kp-action-btn kp-btn-primary" onclick="event.stopPropagation(); goToKnowledgeNode('${item.id}')">跳转到节点</button>
        ${isLegacyCardSummaryItem(item) ? `<button class="kp-action-btn kp-btn-primary" onclick="event.stopPropagation(); restatKnowledgeItemSummary('${item.id}')">重述摘要</button>` : ''}
        <button class="kp-action-btn kp-btn-danger" onclick="event.stopPropagation(); confirmDeleteKnowledge('${item.id}')">删除</button>
      </div>
    </div>`;
}

function toggleKpCard(card) {
  // 折叠卡懒渲染：折叠态详情只是空壳 div，首次展开才填 HTML（KaTeX 编译推迟到此刻）；
  // dataset.rendered 防重复填充（收起再展开直接复用已渲染内容）。
  // 展开态同步进 _kpExpandedIds：15 秒同步触发的整面重渲染据此恢复展开卡。
  if (!card.classList.contains('expanded')) {
    const detail = card.querySelector('.kp-card-detail');
    if (detail && !detail.dataset.rendered) {
      const item = getKnowledgeItems()[card.dataset.id];
      if (item) {
        detail.innerHTML = _kpCardDetailHtml(item);
        detail.dataset.rendered = '1';
      }
    }
    _kpExpandedIds.add(card.dataset.id);
  } else {
    _kpExpandedIds.delete(card.dataset.id);
  }
  card.classList.toggle('expanded');
}

// ===== 删除可撤销（删后 8 秒内一键写回） =====
// 服务端 DELETE 链路原样保留：撤销＝「删后把快照原样重写回」——知识点走
// saveKnowledgeItems（POST merge 天然推回服务端）、公式走 saveFormulasToServer 同款
// 写入路径（入缓存 + 排队 POST），都不绕过各自的保存队列。
// 快照只保最新一条：连续删第二条时前一条的撤销机会作废。取舍：撤销提示条只有
// 一个挂点，多条快照栈会把「撤销」变成「逐个恢复」，交互语义复杂化不划算。
const KP_UNDO_MS = 8000;
let _kpUndoSnapshot = null; // { kind: 'knowledge' | 'formula', item }
let _kpUndoTimer = 0;

function _hideKpUndoToast() {
  if (_kpUndoTimer) { clearTimeout(_kpUndoTimer); _kpUndoTimer = 0; }
  _kpUndoSnapshot = null;
  const el = document.getElementById('phymathia_kp_undo');
  if (el) el.remove();
}

// 专用撤销提示条：showToast 不支持按钮/回调（签名不能动，全仓调用点依赖纯文本），
// 这里做一个独立挂点；样式沿用全局 toast 的极光磨砂胶囊（aurora-glass--compact），
// 位置在 toast 上方错开，不互相遮挡
function _showKpUndoToast(label, snapshot) {
  _hideKpUndoToast(); // 连续删除：前一条的撤销机会作废（只保最新快照）
  _kpUndoSnapshot = snapshot;
  let el = document.getElementById('phymathia_kp_undo');
  if (!el) {
    el = document.createElement('div');
    el.id = 'phymathia_kp_undo';
    // 样式在 styles-panels.css（.kp-undo-toast）：与全局 toast 同套极光磨砂胶囊，
    // 位置在其上方错开，不互相遮挡
    el.className = 'kp-undo-toast aurora-glass aurora-glass--compact';
    document.body.appendChild(el);
  }
  el.innerHTML = '<span>已删除' + escapeHtml(label) + '</span><button class="kp-undo-toast-btn" onclick="_undoKpDelete()">撤销</button>';
  requestAnimationFrame(() => {
    el.style.opacity = '1';
    el.style.transform = 'translateX(-50%) translateY(0)';
  });
  _kpUndoTimer = setTimeout(_hideKpUndoToast, KP_UNDO_MS); // 8 秒超时自动消失
}

function _undoKpDelete() {
  const snap = _kpUndoSnapshot;
  _hideKpUndoToast();
  if (!snap || !snap.item) return;
  if (snap.kind === 'knowledge') {
    const items = getKnowledgeItems();
    items[snap.item.id] = snap.item;
    saveKnowledgeItems(items); // 走保存队列：本地写回 + POST merge 推回服务端
    showToast('已撤销删除：' + String(snap.item.title || '').slice(0, 16));
  } else {
    // 公式走 saveFormulasToServer 同款写入路径（语义归一 + 入缓存 + 排队 POST）
    saveFormulasToServer([snap.item]).then(() => {
      // 被语义校验（_looksLikeFormula）拦下的废条目不会经它入缓存：仅本地写回兜底
      if (!getFormulaCache()[snap.item.id]) {
        const cache = getFormulaCache();
        cache[snap.item.id] = snap.item;
        setFormulaCache(cache);
      }
      showToast('已撤销删除');
    });
  }
  renderKnowledgePanel();
  renderFormulaList();
}

async function confirmDeleteKnowledge(id) {
  if (!confirm('确定删除此知识条目？')) return;
  const snapshot = getKnowledgeItems()[id] || null; // 删除前快照（撤销＝原样写回）
  _kpExpandedIds.delete(id); // 展开记忆同步清理，防幽灵展开态
  await deleteKnowledgeItem(id);
  renderKnowledgePanel();
  if (snapshot) _showKpUndoToast('知识条目「' + String(snapshot.title || '').slice(0, 16) + '」', { kind: 'knowledge', item: snapshot });
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
  const resp = await proxyChatWithModel(model, { messages, stream: false, session_bucket: 'phymathia-knowledge' }, signal);
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
// `_kpSummaryOptimizeAbort`，Esc 监听随任务注册/注销——再次点击、Esc 两路径都经
// abortKnowledgeSummaryOptimize() 中止；关面板不中止（2026-10-01 设计变更，任务后台
// 继续、重开面板恢复按钮运行态）；中止后批量循环不再发后续请求
//（循环每轮先查 signal + 在途 fetch 被拒后 break，双保险）。
let _kpSummaryOptimizeAbort = null;
let _kpSummaryOptimizeEscCloser = null;

// 单条「重述摘要」的真控制器（同款注册表接线）：挂模块级变量 + 独立 Esc capture
// 监听，结束/中止后注销。批量与单条不会同时跑（两侧入口互斥防踩），故各持一份。
// （原实现传一次性即弃的匿名控制器，signal 永不置位，等于没有中止通道。）
let _kpRestateAbort = null;
let _kpRestateEscCloser = null;

// 单条重述运行中（供入口互斥判断；与批量互不相踩）
function _knowledgeRestateRunning() {
  return !!_kpRestateAbort;
}

// 批量运行中（按钮运行态 / 进度条显示只认批量）
function _knowledgeBatchRunning() {
  return !!_kpSummaryOptimizeAbort;
}

// 任一摘要/公式含义任务（批量或单条）在跑：ui.js 的全局 Esc 处理器据此把 Esc
// 让给 knowledge.js 各自的 capture 中止监听，不做关面板动作
function _knowledgeSummaryTaskRunning() {
  return _knowledgeBatchRunning() || _knowledgeRestateRunning() || _formulaBatchRunning();
}

// 运行态判断（供 ui.js 的全局 Esc 处理器分流：摘要任务运行中 Esc 让给中止监听，不关面板）
function isKnowledgeSummaryOptimizeRunning() {
  return _knowledgeSummaryTaskRunning();
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
  _syncKpOptimizeWidgets();
}

// 单条重述的中止清理：清注册表 + 注销 Esc capture 监听（中止与正常收尾都走这里）
function abortKnowledgeRestatement() {
  const controller = _kpRestateAbort;
  _kpRestateAbort = null;
  if (controller) {
    try { controller.abort(); } catch (e) {}
  }
  if (_kpRestateEscCloser) {
    document.removeEventListener('keydown', _kpRestateEscCloser, true);
    _kpRestateEscCloser = null;
  }
}

// === 批量优化进度（面板 header 内联 n/N + 2px 细进度条） ===
// 进度状态存模块级变量：关面板不中止批量（2026-10-01 设计变更），重开面板时
// _syncKpOptimizeWidgets 据此重填显示；批量结束（完成/中止/出错）置 null 并隐藏。
let _kpOptimizeProgressState = null; // { done, total } | null

function _syncKpOptimizeProgress() {
  const wrap = document.getElementById('kpOptimizeProgress');
  if (!wrap) return;
  const running = (_knowledgeBatchRunning() || _formulaBatchRunning()) && _kpOptimizeProgressState;
  wrap.hidden = !running;
  if (!running) return;
  const { done, total } = _kpOptimizeProgressState;
  const textEl = document.getElementById('kpOptimizeProgressText');
  const fillEl = document.getElementById('kpOptimizeProgressFill');
  if (textEl) textEl.textContent = done + '/' + total;
  if (fillEl) fillEl.style.width = (total > 0 ? Math.min(100, Math.round(done / total * 100)) : 0) + '%';
}

// 当前激活的 tab（'knowledge' | 'formulas'）——优化按钮的语义随 tab 切换
function _kpActiveTab() {
  const tab = document.querySelector('.kp-tab.active');
  return tab && tab.dataset.tab === 'formulas' ? 'formulas' : 'knowledge';
}

// 优化摘要/含义按钮运行态 + 进度条统一同步：
// 按钮运行态认两个批量之一；进度条在任一批量运行时显示（T148 起公式页也有批量）
function _syncKpOptimizeWidgets() {
  const running = _knowledgeBatchRunning() || _formulaBatchRunning();
  _setKpOptimizeButtonRunning(running);
  if (running) _syncKpOptimizeProgress();
  else {
    const wrap = document.getElementById('kpOptimizeProgress');
    if (wrap) wrap.hidden = true;
  }
}

function _setKpOptimizeButtonRunning(running) {
  const btn = document.getElementById('kpOptimizeBtn');
  if (!btn) return;
  btn.classList.toggle('running', running);
  btn.textContent = running ? '■ 停止优化' : (_kpActiveTab() === 'formulas' ? '✦ 优化含义' : '✦ 优化摘要');
}

// 优化按钮统一入口（T148）：知识点页批量优化摘要、公式页批量优化含义；
// 运行中点击交给各自的中止通道
function kpOptimizeBtnClicked() {
  if (_formulaBatchRunning()) {
    abortFormulaMeaningOptimize();
    return;
  }
  if (_knowledgeBatchRunning()) {
    abortKnowledgeSummaryOptimize();
    return;
  }
  if (_kpActiveTab() === 'formulas') optimizeFormulaMeanings();
  else optimizeKnowledgeSummaries();
}

function _activeModelForSummaryRestate() {
  if (typeof getActiveModelForRole !== 'function') return null;
  return getActiveModelForRole('descriptor') || getActiveModelForRole('agent');
}

// 批量入口（面板工具按钮）：再次点击即中断；目标逐条现判现发，manual/model 条目绝不触碰
async function optimizeKnowledgeSummaries() {
  if (_knowledgeSummaryTaskRunning()) {
    // 互斥防踩：批量在跑→按既有语义再次点击即停止；单条重述在跑→不接受批量
    if (_knowledgeBatchRunning()) {
      abortKnowledgeSummaryOptimize();
      showToast('已停止优化摘要，已完成条目保留');
    } else {
      showToast('单条重述摘要进行中，请等它完成');
    }
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
  _syncKpOptimizeWidgets();

  const total = targetIds.length;
  let done = 0, skipped = 0, ok = 0, failed = 0;
  let aborted = false;
  // 进度口径：n = 已消费的目标条数（含跳过），N = 目标总数。逐条更新 header 内联
  // 进度（替代原「优化摘要 n/total：标题…」逐条刷屏 toast——进度常驻可看、不抢视线）
  const _bumpProgress = () => {
    _kpOptimizeProgressState = { done: done + skipped, total };
    _syncKpOptimizeProgress();
  };
  try {
    for (const id of targetIds) {
      if (controller.signal.aborted) { aborted = true; break; } // 中止后不再发出后续请求
      const currentMap = getKnowledgeItems();
      const current = currentMap[id] || null;
      // 任务期间数据可能变化（15 秒同步/手动编辑）：发送前现判，非目标条目直接跳过
      if (!current || !isLegacyCardSummaryItem(current)) { skipped++; _bumpProgress(); continue; }
      done++;
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
      _bumpProgress();
    }
  } finally {
    const wasAborted = aborted || controller.signal.aborted;
    abortKnowledgeSummaryOptimize(); // 清注册表 + 注销 Esc 监听 + 复位按钮 + 隐藏进度
    _kpOptimizeProgressState = null;
    _syncKpOptimizeProgress();
    invalidateKnowledgeCache();
    const panel = document.getElementById('knowledgePanel');
    if (panel && panel.classList && panel.classList.contains('active')) renderKnowledgePanel();
    const skipText = skipped ? '，跳过 ' + skipped + ' 条（期间已变更）' : '';
    if (wasAborted) showToast('已停止：优化 ' + ok + ' 条，失败 ' + failed + ' 条' + skipText, TOAST_MS_LONG);
    else if (failed) showToast('优化完成：' + ok + '/' + total + ' 成功，失败 ' + failed + ' 条' + skipText, TOAST_MS_LONG);
    else showToast('优化完成：已重述 ' + ok + ' 条旧摘要' + skipText, TOAST_MS_LONG);
  }
}

// 单条入口（知识卡片按钮）：重验判定规则，manual/model 条目拒绝重述。
// 真 AbortController 接线（原实现传一次性即弃的匿名控制器，signal 永不置位、永不生效）：
// 控制器挂 _kpRestateAbort 注册表 + 独立 Esc capture 监听（与批量同款接线，各自独立），
// Esc / 收尾统一走 abortKnowledgeRestatement() 注销；批量在跑时入口直接拒绝（互斥防踩）
// ===== T148 公式含义批量优化（复用「优化摘要」批量通道的整套形态） =====
// 实测 316/325 条公式含义是本地模板兜底（「X相关公式：用于描述X的定量关系」），
// 向量通道把它当空串——质量差且无语义。目标=meaningSource 非 model 且文案为
// 模板形态（或为空）；逐条现判现发，model 结果绝不触碰。

let _kpFormulaOptimizeAbort = null;
let _kpFormulaOptimizeEscCloser = null;

function _formulaBatchRunning() {
  return !!_kpFormulaOptimizeAbort;
}

function abortFormulaMeaningOptimize() {
  const controller = _kpFormulaOptimizeAbort;
  _kpFormulaOptimizeAbort = null;
  if (controller) {
    try { controller.abort(); } catch (e) {}
  }
  if (_kpFormulaOptimizeEscCloser) {
    document.removeEventListener('keydown', _kpFormulaOptimizeEscCloser, true);
    _kpFormulaOptimizeEscCloser = null;
  }
  _syncKpOptimizeWidgets();
}

// 模板兜底判定：与后端 _local_formula_meaning 的两条兜底文案逐字对齐
// （「{concept}相关公式：用于描述{concept}的定量关系」与默认句），空含义也算
function isLegacyFormulaMeaningItem(it) {
  if (!it || typeof it !== 'object') return false;
  if ((it.meaningSource || 'local') === 'model') return false;
  const meaning = String(it.meaning || '').trim();
  if (!meaning) return true;
  if (meaning === '该公式用于描述物理量之间的定量关系') return true;
  if (/相关公式：用于描述.+的定量关系$/.test(meaning)) return true;
  return false;
}

function _buildFormulaMeaningPrompt(it) {
  const lines = [];
  lines.push('请为下面的公式写一句含义说明，替换掉旧的模板文案。');
  lines.push('');
  lines.push('公式（LaTeX）：' + String(it.latex || '').trim());
  if (it.concept) lines.push('来源知识点：' + String(it.concept).trim());
  if (it.topic) lines.push('主题：' + String(it.topic).trim());
  if (Array.isArray(it.related) && it.related.length) {
    lines.push('相关标签：' + it.related.join('、'));
  }
  lines.push('旧说明（模板文案，必须替换，不要复用其中的措辞）：' + String(it.meaning || '').trim());
  lines.push('');
  lines.push('要求：');
  lines.push('1. 说明这条公式「说的是什么」：各符号/各项的物理或数学含义、它刻画什么关系；');
  lines.push('2. 不超过 80 字，一句通顺的中文；');
  lines.push('3. 只输出说明正文，不要任何解释或前缀。');
  return lines.join('\n');
}

function _cleanFormulaMeaningText(raw) {
  let out = _cleanRestatedSummaryText(raw);
  out = out.replace(/^(含义|公式含义|说明)\s*[：:]\s*/, '').trim();
  return out.slice(0, 120);
}

async function _requestFormulaMeaning(it, model, signal) {
  const messages = [
    { role: 'system', content: '你是物理数学知识库的公式含义助手。只输出一句公式含义说明正文，不要解释、前缀、引号或列表。' },
    { role: 'user', content: _buildFormulaMeaningPrompt(it) },
  ];
  const resp = await proxyChatWithModel(model, { messages, stream: false, session_bucket: 'phymathia-knowledge' }, signal);
  const data = await resp.json();
  const raw = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : '';
  return _cleanFormulaMeaningText(raw);
}

async function optimizeFormulaMeanings() {
  if (_knowledgeSummaryTaskRunning()) {
    if (_formulaBatchRunning()) {
      abortFormulaMeaningOptimize();
      showToast('已停止优化公式含义，已完成条目保留');
    } else {
      showToast('另一项优化进行中，请等它完成');
    }
    return;
  }
  const targetIds = Object.values(getFormulaCache())
    .filter(isLegacyFormulaMeaningItem)
    .map(it => it.id);
  if (!targetIds.length) {
    showToast('没有需要优化的公式含义（均已由模型描述）');
    return;
  }
  const model = _activeModelForSummaryRestate();
  if (!model) {
    showToast('未配置 AI 模型，请在模型设置中配置（公式描述模型或主模型均可）');
    return;
  }
  const controller = new AbortController();
  _kpFormulaOptimizeAbort = controller;
  _kpFormulaOptimizeEscCloser = (event) => {
    if (event.key === 'Escape') abortFormulaMeaningOptimize();
  };
  document.addEventListener('keydown', _kpFormulaOptimizeEscCloser, true);
  _syncKpOptimizeWidgets();

  const total = targetIds.length;
  let done = 0, skipped = 0, ok = 0, failed = 0;
  let aborted = false;
  const _bumpProgress = () => {
    _kpOptimizeProgressState = { done: done + skipped, total };
    _syncKpOptimizeProgress();
  };
  try {
    for (const id of targetIds) {
      if (controller.signal.aborted) { aborted = true; break; }
      const cache = getFormulaCache();
      const current = cache[id] || null;
      // 任务期间数据可能变化（同步/删除）：发送前现判，非目标条目直接跳过
      if (!current || !isLegacyFormulaMeaningItem(current)) { skipped++; _bumpProgress(); continue; }
      done++;
      try {
        const text = await _requestFormulaMeaning(current, model, controller.signal);
        if (!text) { failed++; continue; }
        current.meaning = text;
        current.meaningSource = 'model';
        setFormulaCache(cache);
        await saveFormulasToServer([current]);
        ok++;
      } catch (err) {
        if (controller.signal.aborted) { aborted = true; break; } // 用户中断不计为失败
        failed++;
        console.warn('Optimize formula meaning failed:', id, err);
      }
      _bumpProgress();
    }
  } finally {
    const wasAborted = aborted || controller.signal.aborted;
    abortFormulaMeaningOptimize();
    _kpOptimizeProgressState = null;
    _syncKpOptimizeProgress();
    invalidateKnowledgeCache();
    const panel = document.getElementById('knowledgePanel');
    if (panel && panel.classList && panel.classList.contains('active')) renderKnowledgePanel();
    const skipText = skipped ? '，跳过 ' + skipped + ' 条（期间已变更）' : '';
    if (wasAborted) showToast('已停止：优化公式含义 ' + ok + ' 条，失败 ' + failed + ' 条' + skipText, TOAST_MS_LONG);
    else if (failed) showToast('公式含义优化完成：' + ok + '/' + total + ' 成功，失败 ' + failed + ' 条' + skipText, TOAST_MS_LONG);
    else showToast('公式含义优化完成：已重写 ' + ok + ' 条模板含义' + skipText, TOAST_MS_LONG);
  }
}
window.optimizeFormulaMeanings = optimizeFormulaMeanings;
window.kpOptimizeBtnClicked = kpOptimizeBtnClicked;
window.isLegacyFormulaMeaningItem = isLegacyFormulaMeaningItem;

async function restatKnowledgeItemSummary(itemId) {
  if (_knowledgeBatchRunning()) {
    showToast('批量优化进行中，请先点击「优化摘要」停止');
    return;
  }
  if (_knowledgeRestateRunning()) {
    showToast('该条目正在重述，请稍候');
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
  showToast('正在重述摘要：' + String(item.title || '').slice(0, 16) + '...', TOAST_MS_LONG);
  const controller = new AbortController();
  _kpRestateAbort = controller;
  _kpRestateEscCloser = (event) => {
    if (event.key === 'Escape') abortKnowledgeRestatement();
  };
  document.addEventListener('keydown', _kpRestateEscCloser, true);
  try {
    const text = await _requestRestatedSummary(item, model, controller.signal);
    if (controller.signal.aborted) return; // 中止路径已另行提示，不再走失败/成功提示
    if (!text) { showToast('模型未返回有效摘要，请稍后重试'); return; }
    _applyRestatedSummary(item, text);
    await saveKnowledgeItems(items);
    invalidateKnowledgeCache();
    renderKnowledgePanel();
    showToast('摘要已重述');
  } catch (err) {
    if (controller.signal.aborted) { // 用户中断不计为失败（文案沿用批量中止措辞风格）
      showToast('已停止重述摘要');
      return;
    }
    console.warn('Restate knowledge summary failed:', itemId, err);
    showToast('重述失败：' + ((err && err.message) || err));
  } finally {
    abortKnowledgeRestatement(); // 清注册表 + 注销 Esc 监听（正常完成与中止都要注销）
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

// M2（检测闭环）：最近一次成功定位到的画布节点 id——检测侧的「重学引导」拿它作落点与连线起点
// （goToKnowledgeNode/locateFormulaNode 的布尔返回契约保持不变，既有调用方零改动）
let _lastLocatedGraphNodeId = '';

function _rememberLocatedGraphNode(nodeId) {
  _lastLocatedGraphNodeId = String(nodeId || '');
}

function getLastLocatedGraphNodeId() {
  return _lastLocatedGraphNodeId;
}

async function goToKnowledgeNode(itemId) {
  _rememberLocatedGraphNode('');
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
    if (ok) {
      _rememberLocatedGraphNode(anchor.nodeId);
      return true;
    }
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
    const ok = !!await window.focusGraphNodeById(nodeId);
    if (ok) _rememberLocatedGraphNode(nodeId);
    return ok;
  } catch (e) {
    return false;
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
    // T146：按公式全局合并（不再按会话分区），归属写 sessionIds
    const key = _formulaKey(it.latex);
    if (!key) continue;
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
    // T146：跨会话归属合并（保留条自身 sessionId 恒在首位）
    const sids = [];
    const seenSids = new Set();
    for (const [, item] of entries) {
      for (const sid of [item.sessionId, ...(item.sessionIds || [])]) {
        if (sid && !seenSids.has(sid)) { seenSids.add(sid); sids.push(sid); }
      }
    }
    if (sids.length > 1) keep.sessionIds = sids;
    if (!keep.sessionId && sids.length) keep.sessionId = sids[0];
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
    const it = items[id];
    // T146：sessionIds 感知——还有别的归属就摘除该会话并改主会话，全没了才删
    const sids = [...new Set([it.sessionId, ...(it.sessionIds || [])].filter(Boolean))];
    if (!sids.includes(sessionId)) continue;
    const rest = sids.filter(s => s !== sessionId);
    if (rest.length) {
      it.sessionIds = rest;
      it.sessionId = rest[0];
    } else {
      delete items[id];
    }
    changed = true;
  }
  if (changed) setFormulaCache(items);
  // 服务端按会话删除（超时兜底 T195：无 signal 挂死会卡住清空/删会话链收尾）
  try {
    const resp = await fetch('/api/formulas?session_id=' + encodeURIComponent(sessionId), { method: 'DELETE', signal: AbortSignal.timeout(10000) });
    if (!resp.ok) console.warn('Delete formulas by session not ok:', resp.status);
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
    // T146：全局找同公式（不再限同会话），跨会话归属并入 sessionIds
    const existing = Object.values(cache).find(it => _formulaKey(it.latex) === key);
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
      // T146：并入本次会话归属（若尚不是它的归属之一）
      const inSid = item.sessionId || '';
      if (inSid && inSid !== existing.sessionId && !(existing.sessionIds || []).includes(inSid)) {
        existing.sessionIds = [...new Set([existing.sessionId, ...(existing.sessionIds || []), inSid].filter(Boolean))];
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
  // 优化按钮随 tab 换语义（T148：知识点页「优化摘要」/ 公式页「优化含义」），
  // 进度状态在模块级变量里，切 tab 即恢复显示
  _syncKpOptimizeWidgets();
  // 标签页记忆（仅 knowledge/formulas 两个合法值入 localStorage，键在 config.js）
  if (tab === 'knowledge' || tab === 'formulas') {
    try { localStorage.setItem(STORAGE_KEY_KP_TAB, tab); } catch (e) {}
  }
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

// 公式搜索与知识点页 filterKnowledge 同款 200ms 防抖（空输入立即执行，回退场景不等）
let _kpFormulaFilterTimer = 0;
function filterFormulas() {
  const input = document.getElementById('kpFormulaSearch');
  kpFormulaRenderLimit = KP_PAGE_SIZE; // 搜索词变化重置分批上限
  if (_kpFormulaFilterTimer) { clearTimeout(_kpFormulaFilterTimer); _kpFormulaFilterTimer = 0; }
  if (!input || !input.value.trim()) { renderFormulaList(); return; }
  _kpFormulaFilterTimer = setTimeout(() => { _kpFormulaFilterTimer = 0; renderFormulaList(); }, 200);
}

// 公式速查「加载更多」：与时间线同款分批（初始 60，每次 +60）
function loadMoreFormulas() {
  kpFormulaRenderLimit += KP_PAGE_SIZE;
  renderFormulaList();
}

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
  // 结果计数（公式页无统计条，常显）
  const formulaCountEl = document.getElementById('kpFormulaCount');
  if (formulaCountEl) formulaCountEl.textContent = '共 ' + filtered.length + ' 条';
  filtered.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (filtered.length === 0) {
      listEl.innerHTML = `<div class="kp-empty"><div class="kp-empty-icon">${UI_ICON_SVG.formula}</div><div class="kp-empty-text">${search ? '没有找到匹配的公式' : '还没有公式，提问回答会自动收集公式，收藏回复时也可手动填写'}</div></div>`;
    return;
  }

  // 分批渲染：上限随「加载更多」增长（搜索变化时已重置）
  const totalCount = filtered.length;
  if (totalCount > kpFormulaRenderLimit) filtered = filtered.slice(0, kpFormulaRenderLimit);

  // 先过滤后渲染：语义层不合格的条目（单字符/纯命令/纯单位等，旧库已存的不再显示）
  // 在进 KaTeX 编译与 HTML 构建之前剔除，不再为废条目白跑 renderToString
  const qualified = [];
  for (const it of filtered) {
    // 渲染前清洗兜底（服务端返回的条目也可能未标准化）
    const latex = _stripFormulaDelimiters(_normalizeFormulaLatex(it.latex));
    if (_looksLikeFormula(latex)) qualified.push({ it, latex });
  }

  let html = '';
  for (const { it, latex } of qualified) {
    // 工具层：KaTeX 语法校验（throwOnError:false 时非法命令输出 katex-error 标记 → 跳过）
    const latexHtml = _katexHtml(latex);
    if (!latexHtml || /katex-error/.test(latexHtml)) continue;
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
  const remaining = totalCount - filtered.length;
  if (remaining > 0) {
    html += `<button class="kp-load-more" onclick="loadMoreFormulas()">加载更多（还有 ${remaining} 条）</button>`;
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
  _rememberLocatedGraphNode('');
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
    if (ok) {
      _rememberLocatedGraphNode(anchor.nodeId);
      return true;
    }
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

async function confirmDeleteFormula(id) {
  if (!confirm('确定删除此公式？')) return;
  const snapshot = getFormulaCache()[id] || null; // 删除前快照（撤销＝原样写回）
  const items = getFormulaCache();
  delete items[id];
  setFormulaCache(items);
  try {
    const resp = await fetch('/api/formulas/' + encodeURIComponent(id), { method: 'DELETE', signal: AbortSignal.timeout(10000) });
    if (!resp.ok) console.warn('Delete formula on server not ok:', resp.status);
  } catch (err) {
    console.warn('Delete formula on server failed:', err);
  }
  renderFormulaList();
  if (snapshot) _showKpUndoToast('公式', { kind: 'formula', item: snapshot });
}

// ===== 导出 Markdown（header「⇩ 导出」按钮） =====
// 导出语义是整库备份/分享：导出当前 tab 的**全部**条目，忽略筛选/搜索；
// 数据源用既有缓存（getKnowledgeItems / getFormulaCache），不新拉接口，零后端改动。
// graph-export 的 _download 是其函数内私有 helper、不跨模块可见，这里按同款写法
// 本地实现一份（Blob → a[download] → click → revoke）。
function _kpDownloadTextFile(text, filename) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 导出时间线分组口径：今天/昨天/M月D日（与面板时间线一致的直观分组；导出是静态
// 快照，不需要「本周」中间档）
function _kpExportDateLabel(ts, today, yesterday) {
  const d = new Date(ts || 0);
  if (!ts || isNaN(d.getTime())) return '未标注日期';
  if (d.toDateString() === today.toDateString()) return '今天';
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  return (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

function _kpKnowledgeMarkdown() {
  const items = Object.values(getKnowledgeItems()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const groups = {};
  const order = [];
  for (const item of items) {
    const label = _kpExportDateLabel(item.createdAt, today, yesterday);
    if (!groups[label]) { groups[label] = []; order.push(label); }
    groups[label].push(item);
  }
  const lines = [];
  lines.push('# PhyMathia 知识点总览');
  lines.push('');
  lines.push('> 导出时间：' + new Date().toLocaleString('zh-CN') + ' ｜ 共 ' + items.length + ' 条');
  for (const label of order) {
    lines.push('');
    lines.push('## ' + label);
    for (const item of groups[label]) {
      lines.push('');
      lines.push('### ' + String(item.title || '（无标题）').trim());
      const catLabel = item.category === 'physics' ? '物理' : item.category === 'math' ? '数学' : '其他';
      const tagList = (item.tags || []).filter(Boolean);
      lines.push('');
      lines.push('- 分类：' + catLabel + (tagList.length ? ' ｜ 标签：' + tagList.join('、') : ''));
      const summary = _normalizePlainSummaryText(item.summary);
      if (summary) {
        lines.push('');
        lines.push(summary);
      }
      for (const f of (item.formulas || [])) {
        const latex = _stripFormulaDelimiters(f);
        if (!latex) continue;
        lines.push('');
        // $$ 数学块而非 ```latex 代码围栏：代码块在任何查看器都只按字面显示，
        // $$ 才能被 Typora/Obsidian/GitHub/VS Code 等数学渲染查看器画成公式
        //（latex 已剥定界符，不会生成 $$$$；空行会截断数学块，压成单行）
        lines.push('$$');
        lines.push(latex.replace(/\n\s*\n+/g, '\n').trim());
        lines.push('$$');
      }
    }
  }
  return lines.join('\n') + '\n';
}

function _kpFormulasMarkdown() {
  const items = Object.values(getFormulaCache())
    .filter(it => _looksLikeFormula(_stripFormulaDelimiters(_normalizeFormulaLatex(it.latex)))) // 与面板显示同一语义过滤口径
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const lines = [];
  lines.push('# PhyMathia 公式速查清单');
  lines.push('');
  lines.push('> 导出时间：' + new Date().toLocaleString('zh-CN') + ' ｜ 共 ' + items.length + ' 条');
  for (const it of items) {
    lines.push('');
    lines.push('## ' + (_cleanFormulaConcept(it) || '（未命名）'));
    lines.push('');
    // 同上：$$ 数学块而非代码围栏，数学渲染查看器才能画成公式
    lines.push('$$');
    lines.push(_stripFormulaDelimiters(_normalizeFormulaLatex(it.latex)).replace(/\n\s*\n+/g, '\n').trim());
    lines.push('$$');
    const meaning = _normalizePlainSummaryText(it.meaning);
    if (meaning) { lines.push('- 含义：' + meaning); }
    if (it.topic) { lines.push('- 主题：' + it.topic); }
    const related = (it.related || []).filter(Boolean);
    if (related.length) { lines.push('- 相关：' + related.join('、')); }
    if (it.createdAt) { lines.push('- 收录：' + new Date(it.createdAt).toLocaleDateString('zh-CN')); }
  }
  return lines.join('\n') + '\n';
}

function exportKnowledgeMarkdown() {
  const tab = document.querySelector('.kp-tab.active');
  const isFormulasTab = !!(tab && tab.dataset.tab === 'formulas');
  const md = isFormulasTab ? _kpFormulasMarkdown() : _kpKnowledgeMarkdown();
  const date = new Date().toISOString().slice(0, 10);
  _kpDownloadTextFile(md, 'PhyMathia-知识总览-' + date + '.md');
  showToast('已导出' + (isFormulasTab ? '公式清单' : '知识点') + ' Markdown（PhyMathia-知识总览-' + date + '.md）', TOAST_MS_LONG);
}

// 「去知识大陆」入口：大陆是全屏画布层（非面板），与知识面板叠开会互相挡操作——
// 沿记忆面板 openMemoryPanel 关知识面板的先例，先关面板再进大陆；批量优化若在跑
// 按既有设计后台继续，不受影响
function openKnowledgeContinentView() {
  closeKnowledgePanel();
  if (typeof window.openContinentView === 'function') {
    window.openContinentView();
  } else {
    showToast('知识大陆暂不可用');
  }
}

// 暴露缓存失效接口给其他模块（session.js 定时同步、chat.js 提取刷新使用）
window.invalidateKnowledgeCache = invalidateKnowledgeCache;
window.isKnowledgeSummaryOptimizeRunning = isKnowledgeSummaryOptimizeRunning;
window.goToKnowledgeNode = goToKnowledgeNode;
window.locateFormulaNode = locateFormulaNode;
window.getLastLocatedGraphNodeId = getLastLocatedGraphNodeId;
window.waitForKnowledgeSave = () => kpKnowledgeSaveQueue.catch(() => false);
window.waitForFormulaSave = () => kpFormulaSaveQueue.catch(() => false);
window.exportKnowledgeMarkdown = exportKnowledgeMarkdown;
window.openKnowledgeContinentView = openKnowledgeContinentView;
window._undoKpDelete = _undoKpDelete;
