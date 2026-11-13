/* ====== 统一设置面板（收编式，2026-11-11）======
 * 只做「分组导航 + 轻量控件」：所有写入一律调用现有全局函数或现有 localStorage 键。
 * 复杂表单（数据/记忆/账号/回收站）由原面板承载——2026-11-11 四轮起不再给「打开」
 * 跳转入口，而是把原面板的同一个 DOM 节点临时挂进抽屉内容区，用户就地查看与修改；
 * 切页／关抽屉时按原位置归位，顶栏旧按钮与侧栏磁贴因此照常可用。
 * 不复制表单、不 clone 节点、不造第二份状态（同一份 id、同一套写入函数）。
 * 「模型」页例外（2026-11-11 二轮）：按用户截图做成左右两栏「模型设置」面板，
 * 只读 models.js 的同一份 userModelConfigs（经 getAllModels），编辑一律调原弹窗
 * （addModelDialog / modelConfigDialog / updateModelsDialog），抽屉里没有第二份表单。
 * 五轮（2026-11-11）：深浅模式改月／日图标钮（用户「不要文字」）；难度与检测升级
 * 「标题＋说明」卡片；Φ 思考挡位改五档（自动/低/中/高/最高，medium 由后端 effort 族
 * 同名直发，文案与 harness.js 一字不差）；关于页加 GitHub 仓库行；帮助／检测页补
 * 「常用入口」——一律是「收抽屉＋调现有函数」，不复制面板逻辑。
 * 2026-11-13：Φ 首档「自动」改「跟随」，六功能思考强度统一（T97 相位默认退役）。
 *
 * 面板互斥：打开抽屉先收掉顶栏四面板与两个小菜单；点遮罩／按 Esc／点抽屉外自动关闭，
 * 此时旧按钮被点击会照常打开自己的面板（节点已不在抽屉里，天然无冲突）。
 * 只读查阅态：内容区 CSS 整体禁点 + 每个 setter 入口再判一次 phyIsReadonly()。
 * 上次停留页写 STORAGE_KEY_SETTINGS_TAB（经 config.js 账号垫片自然分账号）。
 */
const SETTINGS_GROUPS = [
  { label: '设置', items: [
    { id: 'appearance', label: '外观', icon: 'sun' },
    { id: 'level', label: '难度等级', icon: 'cap' },
    { id: 'model', label: '模型', icon: 'sliders' }
  ]},
  { label: '功能', items: [
    { id: 'memory', label: '记忆与画像', icon: 'user' },
    { id: 'phi', label: 'Φ 助手', icon: 'sparkles' },
    { id: 'quiz', label: '知识检测', icon: 'check' },
    { id: 'canvas', label: '画布与追问', icon: 'curve' }
  ]},
  { label: '数据', items: [
    { id: 'data', label: '数据管理', icon: 'database' },
    { id: 'account', label: '账号与查阅', icon: 'key' },
    { id: 'trash', label: '回收站', icon: 'trash' }
  ]},
  { label: '', items: [
    { id: 'about', label: '关于', icon: 'question' },
    { id: 'help', label: '帮助与引导', icon: 'book' }
  ]}
];
const SETTINGS_TAB_IDS = SETTINGS_GROUPS.reduce((a, g) => a.concat(g.items.map(i => i.id)), []);

let _settingsOpen = false;
let _settingsTab = 'appearance';
let _settingsModelProvider = '';   // 模型设置页左栏当前选中的供应商（只存内存，不落盘）

// ====== 复杂表单内嵌（2026-11-11 四轮：用户「不要只是一个跳转入口」）======
// 四页各对应一个原面板节点。挂载＝把同一节点 append 进 #settingsEmbedSlot（不 clone），
// 归位＝按记录的原父节点／nextSibling 插回去并摘掉 .settings-embedded。
// 归位必须发生在每次 renderSettingsPage() 重画内容区之前：innerHTML 赋值会销毁
// 挂进来的节点，不先搬走就等于把原面板整个删了（旧顶栏入口随后会打开空面板）。
const _SETTINGS_EMBEDS = {
  memory:  { nodeId: 'memoryPanel',    refresh: 'memoryRenderPanel' },
  data:    { nodeId: 'dataPanel',      refresh: 'updateDataStats' },
  account: { nodeId: 'accountsDialog', refresh: 'renderAccountsList' },
  trash:   { nodeId: 'trashDialog',    refresh: 'renderTrashList' }
};
let _settingsEmbeddedTab = '';
const _settingsEmbedHome = new Map();

// 打包产物里各文件与 settings.js 同作用域；typeof 守卫让缺桩的冒烟沙箱安静跳过。
function _settingsEmbedRefreshFn(name) {
  try {
    if (name === 'memoryRenderPanel' && typeof memoryRenderPanel === 'function') return memoryRenderPanel;
    if (name === 'updateDataStats' && typeof updateDataStats === 'function') return updateDataStats;
    if (name === 'renderAccountsList' && typeof renderAccountsList === 'function') return renderAccountsList;
    if (name === 'renderTrashList' && typeof renderTrashList === 'function') return renderTrashList;
  } catch (e) {}
  return null;
}

function _settingsRestoreEmbedded() {
  for (const [id, home] of _settingsEmbedHome) {
    try {
      const node = document.getElementById(id);
      if (!node) continue;
      node.classList.remove('settings-embedded');
      if (home.parent && typeof home.parent.insertBefore === 'function') {
        const next = (home.next && home.next.parentNode === home.parent) ? home.next : null;
        home.parent.insertBefore(node, next);
      }
    } catch (e) {}
  }
  _settingsEmbedHome.clear();
  _settingsEmbeddedTab = '';
}

function _settingsMountEmbedded(tab, skipRefresh) {
  const cfg = _SETTINGS_EMBEDS[tab];
  if (!cfg) return;
  try {
    const slot = document.getElementById('settingsEmbedSlot');
    const node = document.getElementById(cfg.nodeId);
    // 冒烟沙箱的 DOM 桩没有 appendChild：静默降级，页面的标题／分区文字照样可断言。
    if (!slot || !node || typeof slot.appendChild !== 'function') return;
    if (node.parentNode) _settingsEmbedHome.set(cfg.nodeId, { parent: node.parentNode, next: node.nextSibling });
    slot.appendChild(node);
    node.classList.add('settings-embedded');
    _settingsEmbeddedTab = tab;
    // 同一页内的 setter 重画会先归位再挂回，此时不重复拉数据／重画表单，
    // 免得用户在输入框里打到一半被异步渲染刷掉。
    if (!skipRefresh) {
      const fn = _settingsEmbedRefreshFn(cfg.refresh);
      if (fn) Promise.resolve(fn()).catch(() => {});
    }
  } catch (e) {}
}

function _settingsIcon(name) {
  try {
    return (typeof UI_ICON_SVG !== 'undefined' && UI_ICON_SVG[name]) || '';
  } catch (e) { return ''; }
}
function _settingsEsc(s) {
  const v = String(s == null ? '' : s);
  if (typeof escapeHtml === 'function') { try { return escapeHtml(v); } catch (e) {} }
  return v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// provider / model id 是用户自由输入，进内联 onclick 的单引号串前必须转义（与 models.js 同口径）
function _settingsJsArg(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}
// 从抽屉点开的页面级浮层：模型编辑弹窗（--z-float 10001 > 抽屉 9000）与
// 内嵌记忆面板的「清除记忆」确认框（.memory-dialog-overlay，抽屉打开时提到它之上）。
// 它们不在 #settingsOverlay 内，捕获相外点关闭监听要当成「抽屉内」，否则一点编辑抽屉就消失。
function _settingsInModelDialog(node) {
  try {
    let n = node, steps = 0;
    while (n && steps++ < 12) {
      if (n.classList && typeof n.classList.contains === 'function' &&
          (n.classList.contains('model-dialog-overlay') || n.classList.contains('memory-dialog-overlay'))) return true;
      n = n.parentNode;
    }
  } catch (e) {}
  return false;
}
function _settingsLsGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function _settingsLsSet(key, value) {
  try {
    if (typeof safeLocalStorageSet === 'function') safeLocalStorageSet(key, String(value));
    else localStorage.setItem(key, String(value));
  } catch (e) {}
}
function _settingsReadonly() {
  try { return typeof phyIsReadonly === 'function' && phyIsReadonly(); } catch (e) { return false; }
}
function _settingsGuard() {
  if (!_settingsReadonly()) return false;
  try { if (typeof toastMsg === 'function') toastMsg('查阅模式：不能修改设置，退出查阅后重试', 2500); } catch (e) {}
  return true;
}
function _settingsToast(msg) {
  try { if (typeof toastMsg === 'function') toastMsg(msg, 2200); } catch (e) {}
}
function _settingsCurrentTheme() {
  try { return (typeof currentTheme !== 'undefined' && currentTheme) ? currentTheme : 'dark'; } catch (e) { return 'dark'; }
}

// ====== 开合 ======
function _settingsCloseLegacyPanels() {
  ['levelPanel', 'modelPanel', 'dataPanel', 'themePanel', 'knowledgeMenu', 'moreMenu'].forEach(id => {
    try {
      const p = document.getElementById(id);
      if (p) p.classList.remove('show');
      if (typeof _setPanelTriggerState === 'function') _setPanelTriggerState(id, false);
    } catch (e) {}
  });
  try { if (typeof _closeHeaderMenus === 'function') _closeHeaderMenus(); } catch (e) {}
  try { if (typeof _closeKnowledgeQuizSubmenu === 'function') _closeKnowledgeQuizSubmenu(); } catch (e) {}
}

function openSettingsDrawer(e) {
  try { if (e && e.stopPropagation) e.stopPropagation(); } catch (err) {}
  _settingsCloseLegacyPanels();
  const saved = _settingsLsGet(STORAGE_KEY_SETTINGS_TAB, 'appearance');
  _settingsTab = SETTINGS_TAB_IDS.indexOf(saved) !== -1 ? saved : 'appearance';
  const overlay = document.getElementById('settingsOverlay');
  if (!overlay) return;
  overlay.classList.add('show');
  _settingsOpen = true;
  try {
    const btn = document.getElementById('settingsBtn');
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'true');
  } catch (err) {}
  renderSettingsPage();
}

function closeSettingsDrawer() {
  // 先把临时挂进来的原面板归位：否则关掉抽屉后，顶栏／侧栏旧入口打开的是空面板。
  _settingsRestoreEmbedded();
  const overlay = document.getElementById('settingsOverlay');
  if (overlay) overlay.classList.remove('show');
  _settingsOpen = false;
  try {
    const btn = document.getElementById('settingsBtn');
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
  } catch (e) {}
}

function toggleSettingsDrawer(e) {
  try { if (e && e.stopPropagation) e.stopPropagation(); } catch (err) {}
  if (_settingsOpen) closeSettingsDrawer();
  else openSettingsDrawer(e);
}

function settingsSelectTab(id, e) {
  try { if (e && e.stopPropagation) e.stopPropagation(); } catch (err) {}
  if (SETTINGS_TAB_IDS.indexOf(id) === -1) return;
  _settingsTab = id;
  _settingsLsSet(STORAGE_KEY_SETTINGS_TAB, id);
  renderSettingsPage();
}

// 兼容入口（页面里已不再放跳转卡片，2026-11-11 四轮）：
// 外部／旧代码仍可能调用，先收抽屉（连带归位原面板节点）再开原面板，避免两层浮层叠在一起。
function settingsOpenLegacy(which) {
  closeSettingsDrawer();
  try {
    // 延迟到本次 click 冒泡结束后再开：ui.js 的外点关闭监听会在同一冒泡里把刚
    // show 的 modelPanel 立刻收掉（2026-11-11 用户实报「打开模型设置没反应」）。
    // 抽屉「模型」页现已内置面板，这里只作兼容入口，但病根一并修掉。
    if (which === 'model' && typeof toggleModelPanel === 'function') {
      setTimeout(function () {
        try {
          const btn = document.getElementById('modelBtn');
          toggleModelPanel(btn ? { currentTarget: btn, stopPropagation() {} } : undefined);
        } catch (e) {}
      }, 0);
    }
    else if (which === 'data' && typeof toggleDataPanel === 'function') {
      const btn = document.getElementById('moreBtn');
      toggleDataPanel(btn ? { currentTarget: btn, stopPropagation() {} } : undefined);
    } else if (which === 'memory' && typeof openMemoryPanel === 'function') openMemoryPanel();
    else if (which === 'account' && typeof openAccountsPanel === 'function') openAccountsPanel();
    else if (which === 'trash' && typeof openTrashPanel === 'function') openTrashPanel();
  } catch (e) {}
}

// ====== 小组件（只拼 HTML，不带状态）======
function _sHead(title, desc) {
  return '<div class="settings-page-head"><h3>' + _settingsEsc(title) + '</h3><p>' + _settingsEsc(desc) + '</p></div>';
}
function _sSection(title, inner) {
  return '<div class="settings-section"><div class="settings-section-title">' + _settingsEsc(title) + '</div>' + inner + '</div>';
}
function _sChoices(list) {
  return '<div class="settings-choices">' + list.map(x =>
    '<button type="button" class="settings-choice' + (x.active ? ' active' : '') + '"' +
    (x.title ? ' title="' + _settingsEsc(x.title) + '"' : '') +
    ' onclick="' + x.onclick + '">' + _settingsEsc(x.label) + '</button>'
  ).join('') + '</div>';
}
// 卡片式选择（五轮）：整宽「标题＋说明」两行，给难度/检测这类带解释的档位铺内容
function _sCards(list) {
  return '<div class="settings-cards">' + list.map(x =>
    '<button type="button" class="settings-card' + (x.active ? ' active' : '') + '"' +
    ' onclick="' + x.onclick + '"><span class="settings-card-label">' + _settingsEsc(x.label) + '</span>' +
    (x.desc ? '<span class="settings-card-desc">' + _settingsEsc(x.desc) + '</span>' : '') + '</button>'
  ).join('') + '</div>';
}
function _sSwitch(label, desc, checked, onchange, id) {
  return '<label class="settings-row settings-switch-row">' +
    '<span class="settings-row-text"><span class="settings-row-label">' + _settingsEsc(label) + '</span>' +
    (desc ? '<span class="settings-row-desc">' + _settingsEsc(desc) + '</span>' : '') + '</span>' +
    '<input type="checkbox"' + (id ? ' id="' + id + '"' : '') + (checked ? ' checked' : '') + ' onchange="' + onchange + '">' +
    '<span class="settings-switch-track"><span class="settings-switch-knob"></span></span></label>';
}
function _sRow(label, desc, controlHtml) {
  return '<div class="settings-row"><span class="settings-row-text"><span class="settings-row-label">' + _settingsEsc(label) + '</span>' +
    (desc ? '<span class="settings-row-desc">' + _settingsEsc(desc) + '</span>' : '') + '</span>' + controlHtml + '</div>';
}
function _sActions(list) {
  return '<div class="settings-actions">' + list.map(x =>
    '<button type="button" class="settings-action" onclick="' + x.onclick + '">' +
    _settingsEsc(x.label) + '<span class="settings-action-arrow">→</span></button>'
  ).join('') + '</div>';
}
// 复杂表单挂载位：renderSettingsPage() 写完 innerHTML 后把原面板节点接进来。
// 这里只留一个空壳，页面 HTML 字符串里不复制任何表单内容。
function _sSlot() {
  return '<div class="settings-embed" id="settingsEmbedSlot"></div>';
}

// ====== 各页 ======
function _settingsPageAppearance() {
  const t = _settingsCurrentTheme();
  let wall = 'night', fam = 'aurora', split = false;
  try { if (typeof getWallpaperId === 'function') wall = getWallpaperId(t); } catch (e) {}
  try { if (typeof currentStyleFamily === 'function') fam = currentStyleFamily(); } catch (e) {}
  try { if (typeof themeSplitEnabled === 'function') split = themeSplitEnabled(); } catch (e) {}

  let html = _sHead('外观', '深浅模式、壁纸和整体风格，改动即时生效，刷新后保留。');
  // 五轮：深浅选择改月／日图标钮（用户「不要文字」）；文案保留在 title／aria-label，
  // 键盘读屏与回归脚本都还认得出当前态（aria-pressed）。
  html += _sSection('深浅模式', '<div class="settings-choices">' +
    '<button type="button" id="settings-choice-dark" class="settings-choice settings-choice--icon' + (t === 'dark' ? ' active' : '') +
    '" title="深色模式" aria-label="深色模式" aria-pressed="' + (t === 'dark') + '" onclick="settingsSetTheme(\'dark\')">' + _settingsIcon('moon') + '</button>' +
    '<button type="button" id="settings-choice-light" class="settings-choice settings-choice--icon' + (t === 'light' ? ' active' : '') +
    '" title="浅色模式" aria-label="浅色模式" aria-pressed="' + (t === 'light') + '" onclick="settingsSetTheme(\'light\')">' + _settingsIcon('sun') + '</button>' +
    '</div>');

  let cards = '<div class="settings-theme-grid">';
  try {
    for (const s of WALLPAPER_SETS) {
      const thumb = (t === 'light' ? s.light : s.dark).land;
      cards += '<button type="button" class="settings-theme-card' + (s.id === wall ? ' active' : '') +
        '" title="换壁纸＋把风格重置为该主题的默认搭配" onclick="settingsPickTheme(\'' + s.id + '\')">' +
        '<span class="settings-theme-thumb" style="background-image:url(\'' + thumb + '\')"></span>' +
        '<span class="settings-theme-name">' + _settingsEsc(s.name) + '</span></button>';
    }
  } catch (e) {}
  cards += '</div>';
  html += _sSection('主题风格 · 点一张即换壁纸与搭配', cards);

  const famList = [];
  try {
    for (const f of STYLE_FAMILIES) {
      famList.push({ label: f.label, active: f.key === fam, title: f.desc, onclick: "settingsPickStyle('" + f.key + "')" });
    }
  } catch (e) {}
  html += _sSection('风格家族 · 面板与节点同进退', _sChoices(famList));
  html += _sSwitch('深浅模式各自挑主题', '关着时深浅共用一套；打开后两种模式各记各的', split, 'settingsSetThemeSplit(this.checked)');
  return html;
}

function _settingsPageLevel() {
  let cur = 'university';
  try { if (typeof currentLevel !== 'undefined' && currentLevel) cur = currentLevel; } catch (e) {}
  // 说明与 server config.py 的 LEVEL_PROMPTS 同口径（只压缩措辞，不改语义）
  const LEVEL_DESCS = {
    middle: '通俗易懂多类比，少用大学术语，公式从简、推导不跳步',
    university: '标准大学教学深度，专业术语会解释，推导步骤完整',
    research: '学术深度＋前沿研究视角，可用高级数学工具，推导抓关键'
  };
  const list = [];
  try {
    for (const k of ['middle', 'university', 'research']) {
      list.push({ label: LEVEL_LABELS[k], desc: LEVEL_DESCS[k], active: cur === k, onclick: "settingsSetLevel('" + k + "')" });
    }
  } catch (e) {}
  return _sHead('难度等级', '决定 AI 讲解的深度、术语与推导详略；顶栏按钮与这里同步。') +
    _sSection('当前档位', _sCards(list)) +
    '<div class="settings-note">切换后新回答立即生效，已生成的画布内容不会改写。</div>';
}

// ====== 模型设置页（2026-11-11 用户截图：左供应商列表 + 右详情）======
// 唯一数据源＝models.js 的 userModelConfigs（经 getAllModels），与顶栏 #modelPanel
// 的 renderModelList() 同一份；编辑全调原弹窗，抽屉里不放任何输入框／第二份表单。
function _settingsModelData() {
  let rows = [];
  try { if (typeof getAllModels === 'function') rows = getAllModels() || []; } catch (e) { rows = []; }
  const order = [], groups = {};
  for (const m of rows) {
    const p = String((m && m.provider) || '');
    if (!groups[p]) { groups[p] = []; order.push(p); }
    groups[p].push(m);
  }
  return { order, groups };
}
function _settingsModelPreset(provider) {
  try {
    if (typeof MODEL_PRESETS !== 'undefined' && MODEL_PRESETS && MODEL_PRESETS[provider]) return MODEL_PRESETS[provider];
  } catch (e) {}
  return null;
}
function _settingsModelName(provider) {
  const p = _settingsModelPreset(provider);
  return (p && p.name) || provider || '未命名供应商';
}
function _settingsModelBaseUrl(provider) {
  try {
    if (typeof userModelConfigs !== 'undefined' && Array.isArray(userModelConfigs)) {
      const cfg = userModelConfigs.find(x => x && x.provider === provider && x.baseUrl);
      if (cfg) return String(cfg.baseUrl);
    }
  } catch (e) {}
  const p = _settingsModelPreset(provider);
  return (p && p.baseUrl) ? String(p.baseUrl) : '';
}
function _settingsModelRowName(m) {
  return (m && m.tags && m.tags[0]) || (m && m.name) || '未命名模型';
}

function _settingsPageModel() {
  const data = _settingsModelData();
  const head = '<div class="settings-model-top">' +
    '<div><h3>模型设置</h3><p>管理自定义模型供应商，配置后可在聊天时选择使用。</p></div>' +
    '<button type="button" class="settings-model-primary" onclick="settingsModelAction(\'add\')">＋ 添加供应商</button>' +
    '</div>';
  if (!data.order.length) {
    return '<div class="settings-model-page">' + head +
      '<div class="settings-model-empty">还没有配置模型供应商。点「添加供应商」从预设清单勾选模型，或手动填写 API 地址。</div>' +
      '</div>';
  }
  if (data.order.indexOf(_settingsModelProvider) === -1) _settingsModelProvider = data.order[0];
  const cur = _settingsModelProvider;
  const rows = data.groups[cur] || [];

  let presetItems = '', customItems = '';
  for (const p of data.order) {
    const list = data.groups[p] || [];
    const ok = list.some(m => m && m.hasKey);
    const item = '<button type="button" class="settings-model-vendor' + (p === cur ? ' active' : '') +
      '" onclick="settingsModelSelect(\'' + _settingsJsArg(p) + '\', event)" title="' + _settingsEsc(_settingsModelName(p)) + '">' +
      '<span class="settings-model-vendor-icon">' + _settingsIcon('hex') + '</span>' +
      '<span class="settings-model-vendor-name">' + _settingsEsc(_settingsModelName(p)) + '</span>' +
      '<span class="settings-model-vendor-count">' + list.length + '</span>' +
      '<span class="settings-model-dot' + (ok ? ' ok' : '') + '"></span></button>';
    if (_settingsModelPreset(p)) presetItems += item; else customItems += item;
  }
  const side = (presetItems ? '<div class="settings-model-group-label">预设供应商</div>' + presetItems : '') +
    (customItems ? '<div class="settings-model-group-label">自定义供应商</div>' + customItems : '');

  const hasKey = rows.some(m => m && m.hasKey);
  const base = _settingsModelBaseUrl(cur);
  const jsCur = _settingsJsArg(cur);
  let detail = '<div class="settings-model-card">' +
    '<div class="settings-model-card-head">' +
      '<div class="settings-model-card-title">' + _settingsEsc(_settingsModelName(cur)) +
        '<span class="settings-model-count">' + rows.length + ' 个模型</span></div>' +
      '<div class="settings-model-card-ops">' +
        '<button type="button" class="settings-model-mini" onclick="settingsModelAction(\'refresh\', \'' + jsCur + '\')" title="从上游对比新增／已下线的模型">↻ 更新列表</button>' +
        '<button type="button" class="settings-model-mini" onclick="settingsModelAction(\'delGroup\', \'' + jsCur + '\')" title="删除该供应商的全部模型">删除分组</button>' +
      '</div></div>' +
    '<div class="settings-model-card-meta">' +
      '<span class="settings-model-badge ' + (hasKey ? 'ok' : 'warn') + '">' + (hasKey ? '密钥已配置' : '密钥未配置') + '</span>' +
      (base ? '<span class="settings-model-baseurl" title="' + _settingsEsc(base) + '">' + _settingsEsc(base) + '</span>' : '') +
    '</div></div>';
  detail += '<div class="settings-model-subhead"><span>模型列表</span>' +
    '<button type="button" class="settings-model-mini" onclick="settingsModelAction(\'add\')">＋ 添加模型</button></div>';
  const ro = _settingsReadonly();
  detail += '<div class="settings-model-rows">' + rows.map(m => {
    const mid = _settingsJsArg(m && m.id);
    // enabled 缺省＝启用（旧配置无该字段）；停用条目仍显示，好让开关能重新启用
    const on = !m || m.enabled !== false;
    return '<div class="settings-model-row' + (on ? '' : ' is-off') + '">' +
      '<div class="settings-model-row-main">' +
        '<span class="settings-model-row-name">' + _settingsEsc(_settingsModelRowName(m)) + '</span>' +
        '<span class="settings-model-row-sub">' + (m && m.hasKey ? '密钥已配置' : '密钥未配置（后端环境变量可留空）') + '</span>' +
      '</div>' +
      '<div class="settings-model-row-ops">' +
        '<button type="button" class="settings-model-icon-btn" onclick="settingsModelAction(\'edit\', \'' + mid + '\')" title="配置密钥与地址">' + _settingsIcon('sliders') + '</button>' +
        '<button type="button" class="settings-model-icon-btn" onclick="settingsModelAction(\'del\', \'' + mid + '\')" title="删除该模型">' + _settingsIcon('trash') + '</button>' +
        '<label class="settings-model-switch" title="启用后可在聊天模型列表里选它；停用会隐藏并清空正在使用它的槽位">' +
          '<input type="checkbox" role="switch" aria-label="启用该模型"' + (on ? ' checked' : '') + (ro ? ' disabled' : '') +
          ' onchange="settingsModelAction(\'toggle\', \'' + mid + '\', this.checked)">' +
          '<span class="settings-switch-track"><span class="settings-switch-knob"></span></span>' +
        '</label>' +
      '</div></div>';
  }).join('') + '</div>';
  return '<div class="settings-model-page">' + head +
    '<div class="settings-model-board"><div class="settings-model-side">' + side + '</div>' +
    '<div class="settings-model-detail">' + detail + '</div></div></div>';
}

function _settingsPageMemory() {
  // 画像总开关、影响面、表单与四类记忆列表全在原 #memoryPanel 里，直接挂进来。
  // 不在抽屉里另做一份开关／chips：两份控件各自缓存状态会互相不同步。
  return _sHead('记忆与画像', '它记着你的学段、目标、兴趣、薄弱点和回答偏好，下次回答与出题照这个来。') +
    _sSection('我的画像与记忆 · 在这里直接查看和修改', _sSlot());
}

function _settingsPagePhi() {
  // 五轮：档位文案「低/中/高/最高」＋ medium 档（后端 effort 族同名直发；布尔开关族
  // 退化＝默认档）。2026-11-13：首档「自动」改「跟随」——'' 现在只表示「不额外指定，
  // 跟随 Φ 槽位」，Φ 不再按相位自动调深度；文案与 harness.js 的 LABELS 一字不差。
  const levels = [
    { v: '', label: '跟随', desc: '不额外指定；跟随「模型」页 Φ 槽位的思考设置（默认跟随主模型）' },
    { v: 'low', label: '低', desc: '最浅推理，最快' },
    { v: 'medium', label: '中', desc: '速度与深度折中' },
    { v: 'high', label: '高', desc: '更完整的推理链' },
    { v: 'max', label: '最高', desc: '最深推理，最慢' }
  ];
  let cur = '';
  try { cur = _settingsLsGet(STORAGE_KEY_HARNESS_THINKING, ''); } catch (e) {}
  if (levels.map(x => x.v).indexOf(cur) === -1) cur = '';
  let fallback = false;
  try { fallback = _settingsLsGet(STORAGE_KEY_HARNESS_FALLBACK, '0') === '1'; } catch (e) {}
  return _sHead('Φ 助手', '这两个开关原本藏在 Φ 面板的模式菜单里，收编到此处；下次 Φ 回答生效。') +
    _sSection('深度思考档位', _sChoices(levels.map(x => ({
      label: x.label, active: x.v === cur, onclick: "settingsSetThinking('" + x.v + "')"
    })))) +
    _sSwitch('失败自动换备用模型', '默认关；模型报错时自动换一个再试一次', fallback, 'settingsSetFallback(this.checked)');
}

function _settingsPageQuiz() {
  let cur = 'ai';
  try { if (typeof quizSourcePreference !== 'undefined' && quizSourcePreference) cur = quizSourcePreference; } catch (e) {}
  const opts = [
    { v: 'ai', label: 'AI 出题', desc: '每题都让模型现出，质量高、耗 token' },
    { v: 'local', label: '本地出题', desc: '只用知识点与公式现算，不耗 token' },
    { v: 'mixed', label: '混合', desc: '本地先出，不足再让 AI 补' }
  ];
  return _sHead('知识检测', '出题素材从哪来，影响速度、花费与题目风格。') +
    _sSection('出题素材源', _sCards(opts.map(x => ({
      label: x.label, desc: x.desc, active: cur === x.v, onclick: "settingsSetQuizSource('" + x.v + "')"
    })))) +
    _sSection('开始检测', _sActions([
      { label: '打开画布知识检测', onclick: 'settingsOpenQuiz()' },
      { label: '检测总览 · 跨画布错题与统计', onclick: 'settingsOpenQuizDashboard()' }
    ])) +
    '<div class="settings-note">若检测面板正开着，切换出题源后会按当前范围重建一次卷面。</div>';
}

function _settingsPageData() {
  // 导入模式（合并／替换）、导出／导入按钮、存储统计全在原 #dataPanel 里，
  // 就地铺开后不再需要「打开完整数据管理」跳转，也不复制一份按钮。
  return _sHead('数据管理', '画布与知识数据自动存在服务端，刷新不会丢；换设备或备份用导出／导入。') +
    _sSection('备份与恢复 · 导入模式、导出与统计', _sSlot());
}

function _settingsPageAccount() {
  let name = '';
  try { if (typeof _rawLsGet === 'function') name = _rawLsGet(STORAGE_KEY_ACCOUNT_NAME) || ''; } catch (e) {}
  const readonly = _settingsReadonly();
  return _sHead('账号与查阅', readonly ? '正在只读查阅别人的空间，所有设置都不可修改。' : '本机多账号各自独立：偏好、模型、画像、回收站都按账号分开。') +
    _sRow('当前空间', name || '我的空间（默认账号）', '<span class="settings-badge">' + (readonly ? '只读查阅' : '可编辑') + '</span>') +
    _sSection('账号管理 · 新建、切换、改名与查阅权限', _sSlot());
}

function _settingsPageTrash() {
  // 保留天数下拉、已删画布/账号列表与「清空回收站」全在原 #trashDialog 里，
  // 就地铺开后不再另放一份 select（两处天数会各自缓存、互不同步）。
  return _sHead('回收站', '删掉的画布在保留期内可以一键恢复；天数对之后删除的画布生效。') +
    _sSection('自动保留与已删画布', _sSlot());
}

function _settingsPageAbout() {
  let ver = '';
  try { if (typeof APP_VERSION !== 'undefined') ver = APP_VERSION; } catch (e) {}
  return _sHead('关于', 'PhyMathia · 物理数学双域解释与可视化助手') +
    _sRow('版本', '本机离线运行，无云端账号体系', '<span class="settings-badge">v' + _settingsEsc(ver) + '</span>') +
    _sRow('依赖', 'KaTeX / Marked / Mermaid / DOMPurify 均为本地副本', '<span class="settings-badge">零 CDN</span>') +
    _sRow('开源许可', 'MIT · 源码托管在 GitHub', '<span class="settings-badge">MIT</span>') +
    // 五轮：开源仓库行（用户「加上 GitHub 的点击跳转链接和图标」）。真 <a> 而非
    // onclick，右键可复制链接；只读查阅态靠内容区 pointer-events:none 天然禁点。
    _sSection('开源仓库', '<a class="settings-github-link" href="https://github.com/PhyMathia/PhyMathia" target="_blank" rel="noopener noreferrer" title="在浏览器打开 GitHub 仓库">' +
      '<span class="settings-github-icon">' + _settingsIcon('github') + '</span>' +
      '<span class="settings-github-text"><span class="settings-github-repo">PhyMathia / PhyMathia</span>' +
      '<span class="settings-github-desc">源码、更新与 Issue 反馈都在这里，觉得好用去点个 Star</span></span>' +
      '<span class="settings-action-arrow">↗</span></a>') +
    '<div class="settings-note">设置项按账号分别保存在本机；换设备请用「数据管理」导出后导入。</div>';
}

function _settingsPageHelp() {
  return _sHead('帮助与引导', '第一次用或想重新认识界面，可以从这里再走一遍。') +
    _sSection('引导', _sActions([
      { label: '重看新手引导', onclick: 'settingsRestartOnboarding()' }
    ])) +
    _sSection('常用入口', _sActions([
      { label: '知识总览 · 知识点与公式速查', onclick: 'settingsOpenKnowledge()' },
      { label: '到 GitHub 提问题或建议', onclick: "settingsOpenExternal('https://github.com/PhyMathia/PhyMathia/issues')" }
    ])) +
    '<div class="settings-note">画布右键菜单里会标出该操作对应的快捷键；快捷键目前是内置的，不能自定义。</div>';
}

// ====== 画布与追问（2026-11-13 用户拍板）======
// 总开关管住「追问自动选路」：关＝追问卡只给两枚手动胶囊、绝不发模型判断请求；
// 开＝恢复三枚胶囊。读侧与 config.js 的 followupAutoRouteEnabled() 同一个键、同一个
// '1' 口径；本文件在离线 DOM 桩里单独执行（不加载 config.js），故走 _settingsLsGet。
function _settingsPageCanvas() {
  const on = _settingsLsGet(STORAGE_KEY_FOLLOWUP_AUTO_ROUTE, '0') === '1';
  return _sHead('画布与追问', '从节点「追问」出口拖出的提问卡，要不要为挑回答方式多花一次模型调用。') +
    _sSection('回答方式', _sSwitch(
      '允许 AI 自动判断回答方式',
      '开启：追问卡多一枚「自动判断」，发送时先问一次模型该直接答还是拆开分析（每次追问多一次模型调用）；关闭：只留「拆分分析／直接回答」两枚手动选项，不花这笔钱',
      on, 'settingsSetFollowupAutoRoute(this.checked)'
    )) +
    '<div class="settings-note">默认关闭。改动对之后拖出的追问卡立即生效，已在画布上的旧卡也会按当前开关重新渲染。</div>';
}
function settingsSetFollowupAutoRoute(on) {
  if (_settingsGuard()) return;
  _settingsLsSet(STORAGE_KEY_FOLLOWUP_AUTO_ROUTE, on ? '1' : '0');
  _settingsToast('追问自动判断：' + (on ? '开' : '关'));
  renderSettingsPage();
}

const _SETTINGS_PAGES = {
  appearance: _settingsPageAppearance, level: _settingsPageLevel, model: _settingsPageModel,
  memory: _settingsPageMemory, phi: _settingsPagePhi, quiz: _settingsPageQuiz,
  canvas: _settingsPageCanvas,
  data: _settingsPageData, account: _settingsPageAccount, trash: _settingsPageTrash,
  about: _settingsPageAbout, help: _settingsPageHelp
};

function renderSettingsPage() {
  if (!_settingsOpen) return;
  const overlay = document.getElementById('settingsOverlay');
  const nav = document.getElementById('settingsNav');
  const content = document.getElementById('settingsContent');
  if (!overlay || !nav || !content) return;
  // 内容区整块重画前必须先归位：innerHTML 赋值会连挂进来的原面板节点一起销毁。
  const prevEmbeddedTab = _settingsEmbeddedTab;
  _settingsRestoreEmbedded();
  let navHtml = '';
  for (const g of SETTINGS_GROUPS) {
    if (g.label) navHtml += '<div class="settings-group-label">' + _settingsEsc(g.label) + '</div>';
    else navHtml += '<div class="settings-nav-sep"></div>';
    for (const item of g.items) {
      navHtml += '<button type="button" class="settings-nav-item' + (item.id === _settingsTab ? ' active' : '') +
        '" onclick="settingsSelectTab(\'' + item.id + '\', event)">' +
        '<span class="settings-nav-icon">' + _settingsIcon(item.icon) + '</span>' +
        '<span>' + _settingsEsc(item.label) + '</span></button>';
    }
  }
  nav.innerHTML = navHtml;
  const page = _SETTINGS_PAGES[_settingsTab] || _settingsPageAppearance;
  const readonlyTip = _settingsReadonly()
    ? '<div class="settings-readonly-tip">查阅模式：可以浏览设置，不能修改</div>' : '';
  content.innerHTML = readonlyTip + page();
  content.classList.toggle('is-model-page', _settingsTab === 'model');
  overlay.classList.toggle('is-readonly', _settingsReadonly());
  // 挂在 innerHTML 之后：slot 此刻才存在。同页重画不重复拉数据／重画表单。
  _settingsMountEmbedded(_settingsTab, prevEmbeddedTab === _settingsTab);
  // 画像开关状态由挂载后的 memoryRenderPanel() 自己写回原控件，不再另查一遍。
}

// ====== setter：一律走现有函数／现有键，不造第二份状态 ======
function settingsSetTheme(target) {
  if (_settingsGuard()) return;
  if (target !== 'dark' && target !== 'light') return;
  if (_settingsCurrentTheme() === target) return;
  try {
    if (typeof applyTheme === 'function') applyTheme(target);
    else if (typeof toggleTheme === 'function') toggleTheme();
  } catch (e) {}
  renderSettingsPage();
}
function settingsPickTheme(id) {
  if (_settingsGuard()) return;
  try { if (typeof pickTheme === 'function') pickTheme(id); } catch (e) {}
  renderSettingsPage();
}
function settingsPickStyle(key) {
  if (_settingsGuard()) return;
  try { if (typeof pickStyleFamily === 'function') pickStyleFamily(key); } catch (e) {}
  renderSettingsPage();
}
function settingsSetThemeSplit(on) {
  if (_settingsGuard()) return;
  try { if (typeof setThemeSplit === 'function') setThemeSplit(!!on); } catch (e) {}
  renderSettingsPage();
}
function settingsSetLevel(key) {
  if (_settingsGuard()) return;
  if (['middle', 'university', 'research'].indexOf(key) === -1) return;
  try {
    if (typeof setLevel === 'function') setLevel(key);
    // setLevel 尾部会 toggle 原难度小面板；这里立刻收掉，避免设置抽屉背后弹出一层。
    const p = document.getElementById('levelPanel');
    if (p) p.classList.remove('show');
    if (typeof _setPanelTriggerState === 'function') _setPanelTriggerState('levelPanel', false);
  } catch (e) {}
  renderSettingsPage();
}
function settingsSetThinking(value) {
  if (_settingsGuard()) return;
  if (['', 'low', 'medium', 'high', 'max'].indexOf(value) === -1) return;
  _settingsLsSet(STORAGE_KEY_HARNESS_THINKING, value);
  _settingsToast('深度思考已设为「' + ({ '': '跟随', low: '低', medium: '中', high: '高', max: '最高' }[value]) + '」');
  renderSettingsPage();
}
function settingsSetFallback(on) {
  if (_settingsGuard()) return;
  _settingsLsSet(STORAGE_KEY_HARNESS_FALLBACK, on ? '1' : '0');
  _settingsToast('失败自动换备用模型：' + (on ? '开' : '关'));
}
function settingsSetQuizSource(value) {
  if (_settingsGuard()) return;
  if (['ai', 'local', 'mixed'].indexOf(value) === -1) return;
  try {
    if (typeof changeQuizSourcePreference === 'function') changeQuizSourcePreference(value);
    else _settingsLsSet(STORAGE_KEY_QUIZ_SOURCE, value);
  } catch (e) { _settingsLsSet(STORAGE_KEY_QUIZ_SOURCE, value); }
  renderSettingsPage();
}
// 兼容保留：记忆页改用原面板自带的 #memoryEnabledToggle（onchange→memoryToggleChanged），
// 抽屉里不再放第二份开关；这两个函数仅供旧代码／回归脚本调用。
function settingsSetMemoryEnabled(on) {
  if (_settingsGuard()) return;
  try {
    if (typeof memorySetEnabled === 'function') {
      Promise.resolve(memorySetEnabled(!!on)).catch(() => _settingsToast('记忆开关保存失败，请重试'));
      _settingsToast(on ? '已开启画像' : '已关闭画像');
    }
  } catch (e) {}
}
function _settingsLoadMemoryEnabled() {
  const el = document.getElementById('settingsMemoryToggle');
  if (!el) return;
  if (typeof memoryGetProfile !== 'function') { el.disabled = true; return; }
  try {
    Promise.resolve(memoryGetProfile()).then(p => {
      const cur = document.getElementById('settingsMemoryToggle');
      if (cur) cur.checked = !!(p && p.enabled);
    }).catch(() => {});
  } catch (e) {}
}
// 兼容保留：回收站页直接铺开原 #trashRetentionSelect，改值走它自己的 onchange→
// saveTrashRetention()。本函数不再被页面调用，但保留给旧代码／回归脚本。
function settingsSaveTrashRetention(value) {
  if (_settingsGuard()) return;
  const sel = document.getElementById('trashRetentionSelect');
  if (!sel) return;
  sel.value = String(value);
  // 不重画本页：saveTrashRetention 是异步写服务端后才落本地键，立刻重画会把
  // 下拉框弹回旧值；用户当前选中的值保持可见，失败由原函数的 renderTrashList 兜底。
  try { if (typeof saveTrashRetention === 'function') saveTrashRetention(); } catch (e) {}
}
function settingsRestartOnboarding() {
  closeSettingsDrawer();
  try { if (typeof startOnboarding === 'function') startOnboarding(true); } catch (e) {}
}
// 五轮「常用入口」：先收抽屉再调现有函数——检测/知识面板的层级低于抽屉（9000），
// 不收抽屉会被盖住；各自内部的只读拦截（phyIsReadonly）原样生效。
function settingsOpenQuiz() {
  closeSettingsDrawer();
  try { if (typeof openQuiz === 'function') openQuiz(); } catch (e) {}
}
function settingsOpenQuizDashboard() {
  closeSettingsDrawer();
  try { if (typeof openQuizGlobalDashboard === 'function') openQuizGlobalDashboard(); } catch (e) {}
}
function settingsOpenKnowledge() {
  closeSettingsDrawer();
  try {
    // 知识面板是 toggle 语义：它在抽屉背后开着时再 toggle 会把它关掉，先判 active
    const panel = document.getElementById('knowledgePanel');
    if (panel && panel.classList && typeof panel.classList.contains === 'function' && panel.classList.contains('active')) return;
    if (typeof toggleKnowledgePanel === 'function') toggleKnowledgePanel();
  } catch (e) {}
}
// 外链白名单：只放行本仓库 GitHub 域名下的地址，入口写死，不当任意跳板
function settingsOpenExternal(url) {
  const u = String(url || '');
  if (u.indexOf('https://github.com/PhyMathia/') !== 0) return;
  try { if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(u, '_blank', 'noopener'); } catch (e) {}
}

// ====== 模型设置页交互：只切选中项 / 转发给现有函数，不复制任何写入逻辑 ======
function settingsModelSelect(provider, e) {
  try { if (e && e.stopPropagation) e.stopPropagation(); } catch (err) {}
  _settingsModelProvider = String(provider || '');
  renderSettingsPage();
}
function settingsModelAction(kind, arg, val) {
  if (_settingsGuard()) return;
  const a = String(arg == null ? '' : arg);
  try {
    if (kind === 'add' && typeof showAddModelDialog === 'function') showAddModelDialog();
    else if (kind === 'edit' && typeof openModelConfig === 'function') openModelConfig(a);
    else if (kind === 'del' && typeof confirmDeleteModel === 'function') confirmDeleteModel(a);
    else if (kind === 'refresh' && typeof openModelListUpdate === 'function') openModelListUpdate(a);
    else if (kind === 'delGroup' && typeof confirmDeleteModelGroup === 'function') confirmDeleteModelGroup(a);
    // 行右侧开关：写入逻辑全在 models.js 的 setModelEnabled，抽屉只转发当前状态
    else if (kind === 'toggle' && typeof setModelEnabled === 'function') setModelEnabled(a, val !== false);
  } catch (e) {}
  // 保存/删除后 models.js 会 renderModelList() 派发 phymathia:models-changed 让本页重画；
  // 打开弹窗类动作无需重画，抽屉由捕获相监听保持打开。
}
function settingsModelRefresh() {
  if (_settingsOpen && _settingsTab === 'model') renderSettingsPage();
}

// ====== 全局事件（加载期只挂监听，零副作用）======
try {
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    // 必须挂捕获相：外观/难度等选择钮的 onclick 会同步 renderSettingsPage() 重画内容区，
    // 被点的按钮当场被替换成游离节点；若等冒泡到 document 再判 overlay.contains(e.target)
    // 拿到的是 false，抽屉内的点击会被误判成「点在抽屉外」而自动关抽屉（2026-11-11 实踩）。
    // 捕获相在任何 onclick／重画发生前判定，contains 结果天然可靠。关闭路径不变：
    // 点遮罩本体、点抽屉外、Esc、顶栏开关、settingsOpenLegacy（显式收抽屉）。
    document.addEventListener('click', function (e) {
      if (!_settingsOpen) return;
      const overlay = document.getElementById('settingsOverlay');
      const btn = document.getElementById('settingsBtn');
      if (!overlay || !e) return;
      if (e.target === overlay) { closeSettingsDrawer(); return; }
      // 模型编辑弹窗是页面级浮层（不在抽屉 DOM 内），点它不算「点在抽屉外」。
      if (e.target && _settingsInModelDialog(e.target)) return;
      if (e.target && overlay.contains(e.target)) return;
      if (e.target && btn && btn.contains(e.target)) return;
      closeSettingsDrawer();
    }, true);
    document.addEventListener('keydown', function (e) {
      if (_settingsOpen && e && e.key === 'Escape') closeSettingsDrawer();
    });
  }
} catch (e) {}

// 模型配置变更信号（models.js 的 renderModelList 派发）：抽屉停在模型页时重画，
// 数据源与顶栏 #modelPanel 是同一份 userModelConfigs，天然不会两处不同步。
try {
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('phymathia:models-changed', settingsModelRefresh);
  }
} catch (e) {}

// 显式挂 window：内联 onclick 与冒烟沙箱都按项目惯例从这里取函数。
try {
  if (typeof window !== 'undefined') {
    window.openSettingsDrawer = openSettingsDrawer;
    window.closeSettingsDrawer = closeSettingsDrawer;
    window.toggleSettingsDrawer = toggleSettingsDrawer;
    window.settingsSelectTab = settingsSelectTab;
    window.renderSettingsPage = renderSettingsPage;
    window.settingsOpenLegacy = settingsOpenLegacy;
    window.settingsSetTheme = settingsSetTheme;
    window.settingsPickTheme = settingsPickTheme;
    window.settingsPickStyle = settingsPickStyle;
    window.settingsSetThemeSplit = settingsSetThemeSplit;
    window.settingsSetLevel = settingsSetLevel;
    window.settingsSetThinking = settingsSetThinking;
    window.settingsSetFallback = settingsSetFallback;
    window.settingsSetQuizSource = settingsSetQuizSource;
    window.settingsSetMemoryEnabled = settingsSetMemoryEnabled;
    window.settingsSaveTrashRetention = settingsSaveTrashRetention;
    window.settingsRestartOnboarding = settingsRestartOnboarding;
    window.settingsOpenQuiz = settingsOpenQuiz;
    window.settingsOpenQuizDashboard = settingsOpenQuizDashboard;
    window.settingsOpenKnowledge = settingsOpenKnowledge;
    window.settingsOpenExternal = settingsOpenExternal;
    window.settingsModelSelect = settingsModelSelect;
    window.settingsModelAction = settingsModelAction;
    window.settingsModelRefresh = settingsModelRefresh;
  }
} catch (e) {}
