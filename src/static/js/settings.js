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
  // 图标语义（2026-11-17 用户：图标不合适）：一语义一图标，全栏不重复。
  // 「Φ 助手」改用机器人、钥匙整条下线（快捷键＝键盘、账号＝人像卡）、技能改用拼图块；
  // 学士帽还给难度档位（LEVEL_ICON_SVG 仍在用），侧栏难度改用表盘。
  // ✦ 不在侧栏出现：它在 knowledge.js 是 ai_extract 来源标记、新手引导拿它当「AI」记号。
  { label: '设置', items: [
    { id: 'appearance', label: '外观', icon: 'sun' },
    { id: 'level', label: '难度等级', icon: 'gauge' },
    { id: 'model', label: '模型', icon: 'sliders' }
  ]},
  { label: '功能', items: [
    { id: 'memory', label: '记忆与画像', icon: 'brain' },
    { id: 'phi', label: 'Φ 助手', icon: 'bot' },
    { id: 'quiz', label: '知识检测', icon: 'clipboardCheck' },
    { id: 'canvas', label: '画布与追问', icon: 'layers' },
    { id: 'skills', label: '技能', icon: 'puzzle' },
    { id: 'hotkeys', label: '快捷键', icon: 'keyboard' }
  ]},
  { label: '数据', items: [
    { id: 'data', label: '数据管理', icon: 'database' },
    { id: 'account', label: '账号与查阅', icon: 'idCard' },
    { id: 'trash', label: '回收站', icon: 'trash' }
  ]},
  { label: '', items: [
    { id: 'about', label: '关于', icon: 'info' },
    { id: 'help', label: '帮助与引导', icon: 'question' }
  ]}
];
const SETTINGS_TAB_IDS = SETTINGS_GROUPS.reduce((a, g) => a.concat(g.items.map(i => i.id)), []);

let _settingsOpen = false;
let _settingsTab = 'appearance';
let _settingsModelProvider = '';   // 模型设置页左栏当前选中的供应商（只存内存，不落盘）
let _settingsModelAddOpen = false; // 「手动添加模型」行内输入行的展开态（只存内存，切供应商时收回）

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
  _settingsHotkeyReset();
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
  _settingsHotkeyReset();
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
  if (id !== 'hotkeys') _settingsHotkeyReset();
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
    // 供应商级停用（models.js 的 disabledProviders，行上以 providerOn 带出）：整组关掉
    // 时左列表也弱化标记，不另造第二份状态
    const off = !(list[0] && list[0].providerOn !== false);
    const item = '<button type="button" class="settings-model-vendor' + (p === cur ? ' active' : '') + (off ? ' is-off' : '') +
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
  // 供应商级总开关（2026-11-19，模仿 zcode）：当前组的行都带 providerOn（同一供应商
  // 同值）；关掉＝聊天模型列表整组隐藏，各模型自己的开关保持不变。设置页恒列出整组，
  // 好让人重新打开。
  const providerOn = !(rows[0] && rows[0].providerOn === false);
  const ro = _settingsReadonly();
  let detail = '<div class="settings-model-card' + (providerOn ? '' : ' is-provider-off') + '">' +
    '<div class="settings-model-card-head">' +
      '<div class="settings-model-card-title">' + _settingsEsc(_settingsModelName(cur)) +
        '<span class="settings-model-count">' + rows.length + ' 个模型</span></div>' +
      '<div class="settings-model-card-ops">' +
        '<label class="settings-model-switch settings-model-pswitch" title="供应商总开关：关掉后聊天模型列表不再显示该供应商，各模型自己的开关保持不变">' +
          '<input type="checkbox" role="switch" aria-label="启用该供应商"' + (providerOn ? ' checked' : '') + (ro ? ' disabled' : '') +
          ' onchange="settingsModelAction(\'toggleProvider\', \'' + jsCur + '\', this.checked)">' +
          '<span class="settings-switch-track"><span class="settings-switch-knob"></span></span>' +
        '</label>' +
        '<button type="button" class="settings-model-mini" onclick="settingsModelAction(\'refresh\', \'' + jsCur + '\')" title="从上游对比新增／已下线的模型">↻ 更新列表</button>' +
        '<button type="button" class="settings-model-mini" onclick="settingsModelAction(\'delGroup\', \'' + jsCur + '\')" title="删除该供应商的全部模型">删除分组</button>' +
      '</div></div>' +
    '<div class="settings-model-card-meta">' +
      '<span class="settings-model-badge ' + (hasKey ? 'ok' : 'warn') + '">' + (hasKey ? '密钥已配置' : '密钥未配置') + '</span>' +
      (base ? '<span class="settings-model-baseurl" title="' + _settingsEsc(base) + '">' + _settingsEsc(base) + '</span>' : '') +
      (providerOn ? '' : '<span class="settings-model-offnote">已停用：聊天模型列表不显示该供应商的任何模型</span>') +
    '</div></div>';
  detail += '<div class="settings-model-subhead"><span>模型列表</span>' +
    '<button type="button" class="settings-model-mini" onclick="settingsModelToggleAdd()" title="添加到当前供应商">' + (_settingsModelAddOpen ? '收起' : '手动添加模型') + '</button></div>';
  // 行内补模型：两个框各管一件事——左框模型 ID（可逗号批量），右框显示名（留空＝用 ID）。
  // 解析与写入全在 models.js 的 addModelToGroup（重复跳过、密钥沿用该供应商组密钥）。
  if (_settingsModelAddOpen) {
    detail += '<div class="settings-model-addrow">' +
      '<input type="text" id="settingsAddModelInput" placeholder="模型 ID，多个用逗号分隔" title="发给上游的真实名称" onkeydown="if(event.key===\'Enter\')settingsModelAddSubmit()">' +
      '<input type="text" id="settingsAddModelLabelInput" class="settings-model-addname" placeholder="显示名（留空＝ID）" title="多个按逗号顺序对应" onkeydown="if(event.key===\'Enter\')settingsModelAddSubmit()">' +
      '<button type="button" class="settings-model-mini" onclick="settingsModelAddSubmit()">添加</button>' +
      '<span class="settings-model-addhint" id="settingsModelAddHint"></span></div>';
  }
  // 整组停用时的弱化态挂在 rows 容器上：行内开关仍可操作（写的是各模型自己的
  // enabled，重开供应商后原样生效），只是视觉上整体降下去，别让人以为没生效
  detail += '<div class="settings-model-rows' + (providerOn ? '' : ' is-provider-off') + '">' + rows.map(m => {
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
  // T453（2026-11-16）：页面原本不说 Φ 现在用哪个模型，要自己去「模型」页找 Φ 槽。
  // 这里读同一份槽位状态就地展示；槽空＝与主模型相同（getActiveModelForRole 返回 null
  // 即槽空），口径与 models.js 的 getSlotThinkingForRole 一致。
  let phiName = '', mainName = '', phiOwn = false;
  try {
    if (typeof getActiveModelForRole === 'function') {
      const phiM = getActiveModelForRole('graph');
      const mainM = getActiveModelForRole('agent');
      if (phiM) { phiOwn = true; phiName = String(phiM.model || phiM.name || ''); }
      if (mainM) mainName = String(mainM.model || mainM.name || '');
    }
  } catch (e) {}
  const phiModelDesc = phiOwn ? phiName
    : (mainName ? '与主模型相同 · ' + mainName : '还没配模型——先去「模型」页添加一个才能用 Φ');
  return _sHead('Φ 助手', 'Φ 用的模型、思考深度与备用策略都在这里；改动下次 Φ 回答生效。') +
    _sSection('Φ 正在用的模型',
      _sRow('回答用的模型', phiModelDesc, '') +
      _sActions([{ label: '去「模型」页调整 Φ 槽位', onclick: "settingsSelectTab('model')" }])) +
    _sSection('深度思考档位', _sChoices(levels.map(x => ({
      label: x.label, active: x.v === cur, onclick: "settingsSetThinking('" + x.v + "')"
    }))) +
      // 2026-11-13 有过「思考强度不联动」误解先例：这里写明 Φ 档位与主模型思考强度各自独立
      '<div class="settings-note">思考档位与「模型」页主模型的思考强度相互独立、互不联动：选了具体档位以这里为准（覆盖 Φ 槽位自己的设置），选「跟随」才照 Φ 槽位走（槽位为空时跟主模型）。</div>') +
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
    '<div class="settings-note">画布右键菜单里会标出该操作对应的快捷键；想改键位去「功能 → 快捷键」，先解锁再点键位框。</div>';
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

// ====== 快捷键（2026-11-15 用户拍板：一页一把锁 ＋ 点框即录）======
// 锁只管「能不能改」，不管「能不能用」：锁着时快捷键照常生效，列表也能看能搜。
// 解锁态只活在内存里，关抽屉／切页自动回锁，防误触改坏。
// 录制＝点键位框聚焦后直接按组合键；window 捕获相把这次按键全拦下，
// 不让 hotkeys.js 的 document 捕获、graph-events.js 的 window 冒泡、抽屉 Esc 收到。
// 数据一律取自 hotkeys.js 的唯一事实源（phyHotkeyList / phyHotkeyApplyCombo），
// 本文件不复制第二份键位表；离线 DOM 桩里没有这些函数时页面自动退成空列表。
let _settingsHotkeyUnlocked = false;
let _settingsHotkeyRecording = '';
let _settingsHotkeyConfirm = false;
let _settingsHotkeyQuery = '';
let _settingsHotkeyToast = null;
let _settingsHotkeyCaptureOn = false;

function _settingsHotkeyRows() {
  try { if (typeof phyHotkeyList === 'function') return phyHotkeyList(); } catch (e) {}
  return [];
}
function _settingsHotkeyCount() {
  try { if (typeof phyHotkeyCustomCount === 'function') return phyHotkeyCustomCount(); } catch (e) {}
  return _settingsHotkeyRows().filter(function (r) { return r.custom; }).length;
}
function _settingsHotkeyReset() {
  _settingsHotkeyUnlocked = false;
  _settingsHotkeyRecording = '';
  _settingsHotkeyConfirm = false;
  _settingsHotkeyToast = null;
  _settingsHotkeyEnsureCapture(false);
}
function _settingsHotkeyEnsureCapture(on) {
  try {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    if (on && !_settingsHotkeyCaptureOn) {
      window.addEventListener('keydown', _settingsHotkeyOnKey, true);
      _settingsHotkeyCaptureOn = true;
    } else if (!on && _settingsHotkeyCaptureOn) {
      window.removeEventListener('keydown', _settingsHotkeyOnKey, true);
      _settingsHotkeyCaptureOn = false;
    }
  } catch (e) { _settingsHotkeyCaptureOn = false; }
}
function _settingsHotkeyDropFocus() {
  try {
    const a = document.activeElement;
    if (a && typeof a.blur === 'function') a.blur();
  } catch (e) {}
}
function _settingsHotkeyPaintRecording() {
  try {
    const list = document.getElementById('settingsHotkeyList');
    if (!list || typeof list.querySelectorAll !== 'function') return;
    Array.prototype.forEach.call(list.querySelectorAll('.settings-hk-key'), function (el) {
      const on = el.getAttribute('data-hk-id') === _settingsHotkeyRecording;
      if (el.classList && el.classList.toggle) el.classList.toggle('is-recording', on);
      el.textContent = on ? '请按下组合键…' : (el.getAttribute('data-hk-combo') || '');
    });
  } catch (e) {}
}
function _settingsHotkeyRenderRows() {
  try {
    const list = document.getElementById('settingsHotkeyList');
    if (list) list.innerHTML = _settingsHotkeyRowsHtml();
  } catch (e) {}
  _settingsHotkeyPaintRecording();
}
function _settingsHotkeyRenderToast() {
  try {
    const box = document.getElementById('settingsHotkeyToast');
    if (box) box.innerHTML = _settingsHotkeyToastHtml();
  } catch (e) {}
}
function _settingsHotkeyOnKey(e) {
  if (!_settingsHotkeyRecording) return;
  try {
    if (e.preventDefault) e.preventDefault();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    if (e.stopPropagation) e.stopPropagation();
  } catch (err) {}
  const id = _settingsHotkeyRecording;
  if (e.key === 'Escape') {
    settingsHotkeyBlur();
    _settingsHotkeyDropFocus();
    _settingsHotkeyToast = { msg: '已取消录制，键位没变', bad: false };
    _settingsHotkeyRenderToast();
    return;
  }
  let combo = '';
  try { if (typeof phyHotkeyEventCombo === 'function') combo = phyHotkeyEventCombo(e); } catch (err) {}
  if (!combo) return;
  let prev = null;
  try { if (typeof phyHotkeyOverrides === 'function') prev = phyHotkeyOverrides()[id] || null; } catch (err) {}
  let res = { ok: false, reason: '快捷键功能未加载' };
  try { if (typeof phyHotkeyApplyCombo === 'function') res = phyHotkeyApplyCombo(id, combo); } catch (err) {}
  if (!res || !res.ok) {
    _settingsHotkeyToast = { msg: (res && res.reason) || '这个组合不能用', bad: true };
    _settingsHotkeyPaintRecording();
    _settingsHotkeyRenderToast();
    return;
  }
  _settingsHotkeyToast = {
    msg: '已改为 ' + res.combo + '，速查面板与右键提示会一起变',
    bad: false, undoId: id, undoPrev: prev
  };
  settingsHotkeyBlur();
  _settingsHotkeyDropFocus();
  renderSettingsPage();
}
function settingsHotkeyToggleLock() {
  if (_settingsGuard()) return;
  _settingsHotkeyUnlocked = !_settingsHotkeyUnlocked;
  if (!_settingsHotkeyUnlocked) settingsHotkeyBlur();
  _settingsHotkeyConfirm = false;
  _settingsHotkeyToast = null;
  renderSettingsPage();
}
function settingsHotkeyFocus(el) {
  if (!_settingsHotkeyUnlocked || _settingsGuard()) return;
  const id = (typeof el === 'string') ? el
    : (el && typeof el.getAttribute === 'function' ? el.getAttribute('data-hk-id') : '');
  const row = _settingsHotkeyRows().filter(function (r) { return r.id === id; })[0];
  if (!row || !row.editable || _settingsHotkeyRecording === id) return;
  _settingsHotkeyRecording = id;
  _settingsHotkeyToast = null;
  _settingsHotkeyEnsureCapture(true);
  _settingsHotkeyPaintRecording();
  _settingsHotkeyRenderToast();
}
function settingsHotkeyBlur() {
  if (!_settingsHotkeyRecording) return;
  _settingsHotkeyRecording = '';
  _settingsHotkeyEnsureCapture(false);
  _settingsHotkeyPaintRecording();
}
function settingsHotkeyFilter(v) {
  _settingsHotkeyQuery = String(v || '');
  if (_settingsHotkeyRecording) settingsHotkeyBlur();
  _settingsHotkeyRenderRows();
}
function settingsHotkeyResetOne(el) {
  if (!_settingsHotkeyUnlocked || _settingsGuard()) return;
  const id = (typeof el === 'string') ? el
    : (el && typeof el.getAttribute === 'function' ? el.getAttribute('data-hk-id') : '');
  let def = '';
  try { if (typeof phyHotkeyDefaultCombo === 'function') def = phyHotkeyDefaultCombo(id); } catch (e) {}
  try { if (typeof phyHotkeyClearOverride === 'function') phyHotkeyClearOverride(id); } catch (e) {}
  _settingsHotkeyToast = { msg: '已还原为默认 ' + def, bad: false };
  renderSettingsPage();
}
function settingsHotkeyResetAllAsk() {
  if (!_settingsHotkeyUnlocked || _settingsGuard()) return;
  _settingsHotkeyConfirm = true;
  renderSettingsPage();
}
function settingsHotkeyResetAllCancel() {
  _settingsHotkeyConfirm = false;
  renderSettingsPage();
}
function settingsHotkeyResetAllConfirm() {
  if (!_settingsHotkeyUnlocked || _settingsGuard()) return;
  try { if (typeof phyHotkeyResetAllOverrides === 'function') phyHotkeyResetAllOverrides(); } catch (e) {}
  _settingsHotkeyConfirm = false;
  _settingsHotkeyToast = { msg: '已恢复全部默认键位', bad: false };
  renderSettingsPage();
}
function settingsHotkeyUndo() {
  if (_settingsGuard()) return;
  const t = _settingsHotkeyToast;
  if (!t || !t.undoId) return;
  try { if (typeof phyHotkeyRestoreCombo === 'function') phyHotkeyRestoreCombo(t.undoId, t.undoPrev || null); } catch (e) {}
  _settingsHotkeyToast = { msg: '已撤销刚才的修改', bad: false };
  renderSettingsPage();
}
function _settingsHotkeyToastHtml() {
  const t = _settingsHotkeyToast;
  if (!t) return '';
  return '<div class="settings-hk-toast' + (t.bad ? ' is-bad' : '') + '"><span>' + _settingsEsc(t.msg) + '</span>'
    + (t.undoId ? '<button type="button" onclick="settingsHotkeyUndo()">撤销</button>' : '')
    + '</div>';
}
function _settingsHotkeyConfirmHtml() {
  if (!_settingsHotkeyConfirm) return '';
  return '<div class="settings-hk-confirm"><span>把所有快捷键恢复成出厂设置？你改过的 '
    + _settingsHotkeyCount() + ' 条会全部丢失。</span>'
    + '<button type="button" onclick="settingsHotkeyResetAllConfirm()">确认恢复</button>'
    + '<button type="button" onclick="settingsHotkeyResetAllCancel()">取消</button></div>';
}
function _settingsHotkeyRowsHtml() {
  const rows = _settingsHotkeyRows();
  const q = _settingsHotkeyQuery.trim().toLowerCase();
  let html = '', last = '';
  rows.forEach(function (r) {
    if (q && (r.label + ' ' + r.combo + ' ' + r.scope).toLowerCase().indexOf(q) < 0) return;
    if (r.scope !== last) {
      html += '<div class="settings-hk-group">' + _settingsEsc(r.scope) + '</div>';
      last = r.scope;
    }
    const id = _settingsEsc(r.id), combo = _settingsEsc(r.combo);
    const keyHtml = (r.editable && _settingsHotkeyUnlocked)
      ? '<button type="button" class="settings-hk-key" data-hk-id="' + id + '" data-hk-combo="' + combo + '"'
        + ' onfocus="settingsHotkeyFocus(this)" onclick="settingsHotkeyFocus(this)"'
        + ' onblur="settingsHotkeyBlur()" title="点这里，然后按下新的组合键">' + combo + '</button>'
      : '<span class="settings-hk-key is-locked" data-hk-id="' + id + '" data-hk-combo="' + combo + '">' + combo + '</span>';
    const tag = r.custom ? '<span class="settings-hk-tag">已改</span>' : '';
    const fixed = r.editable ? '' : '<span class="settings-hk-fixed">系统固定</span>';
    const reset = (r.custom && _settingsHotkeyUnlocked)
      ? '<button type="button" class="settings-hk-mini" data-hk-id="' + id + '"'
        + ' onclick="settingsHotkeyResetOne(this)">还原</button>' : '';
    html += '<div class="settings-hk-row"><div class="settings-hk-info">'
      + '<div class="settings-hk-label">' + _settingsEsc(r.label) + tag + '</div>'
      + '<div class="settings-hk-desc">' + _settingsEsc(r.scope) + fixed + '</div></div>'
      + keyHtml + '<div class="settings-hk-ops">' + reset + '</div></div>';
  });
  return html || '<div class="settings-hk-empty">没有匹配的快捷键</div>';
}
function _settingsPageHotkeys() {
  const n = _settingsHotkeyCount();
  return _sHead('快捷键', '查看和自定义全站快捷键。改动立即生效，速查面板与右键菜单提示会一起变。')
    + '<div class="settings-hk-lockbar' + (_settingsHotkeyUnlocked ? ' is-unlocked' : '') + '">'
      + '<span class="settings-hk-lockbar-text">' + (_settingsHotkeyUnlocked
        ? '编辑中 · 点键位框后直接按下新组合键，按 Esc 取消。改完点右侧锁图标重新锁定。'
        : '只读浏览 · 快捷键照常能用，只是不能改。要修改键位，先点右侧锁图标解锁编辑。') + '</span>'
      + '<button type="button" class="settings-hk-lockbtn" onclick="settingsHotkeyToggleLock()"'
      + ' title="' + (_settingsHotkeyUnlocked ? '重新锁定' : '解锁编辑') + '"'
      + ' aria-label="' + (_settingsHotkeyUnlocked ? '重新锁定' : '解锁编辑') + '">'
      + _settingsIcon(_settingsHotkeyUnlocked ? 'lock' : 'unlock') + '</button></div>'
    + '<div class="settings-hk-tools">'
      + '<input class="settings-hk-search" type="text" placeholder="搜索功能或键位" value="'
      + _settingsEsc(_settingsHotkeyQuery) + '" oninput="settingsHotkeyFilter(this.value)" aria-label="搜索快捷键">'
      + '<span class="settings-hk-count">' + (n ? '已修改 ' + n + ' 条' : '全部为默认键位') + '</span></div>'
    + '<div class="settings-hk-list" id="settingsHotkeyList">' + _settingsHotkeyRowsHtml() + '</div>'
    + '<div id="settingsHotkeyConfirm">' + _settingsHotkeyConfirmHtml() + '</div>'
    + '<div id="settingsHotkeyToast">' + _settingsHotkeyToastHtml() + '</div>'
    + '<div class="settings-hk-foot"><button type="button" class="settings-hk-resetall"'
      + ' onclick="settingsHotkeyResetAllAsk()"' + (_settingsHotkeyUnlocked && n ? '' : ' disabled') + '>恢复全部默认</button>'
      + '<span>只保存你改过的那几条；没动过的行随程序升级自动更新。关掉设置页自动重新上锁。</span></div>'
    + '<div class="settings-note">系统固定的键不参与修改：Esc 关浮层、Space 平移、F11 全屏、输入框里的 Enter 发送，以及不带 Ctrl / ⌘ 的单字符键。浏览器保留组合（Ctrl+N/T/W/R/L/P 等）录制时也会被拦下。</div>';
}

// ====== 技能页（2026-11-16 skill 系统第 2 版：用户自己加技能）======
// 三条规矩：
// ① 内置技能可编辑——保存会写一份同 id 的用户副本（覆盖内置），随时能「恢复默认」；
// ② 正文原样拼进模型请求，所以有长度/条数上限，超限由服务端 400 回中文原因，直接展示；
// ③ 读写在服务端做账号隔离，前端只负责「列 / 建 / 改 / 删 / 开关 / 导入」，不参与判定。
// 第 5 版（2026-11-16 夜）：总开关 + 单条开关 + 导入 + 内置可改，状态见 _skillsPage。
const _skillsPage = {
  loaded: false, loading: false, error: '', message: '',
  items: [], byModule: {}, limits: { name: 40, desc: 256, body: 20000, skills: 40 }, draft: null,
  routerEnabled: true, counts: null,
  // 第 8 版：装进来的主流技能包普遍没写适用节点，这里攒「这次点了哪些节点」再提交
  // （键是 id，值是模块键数组；提交成功后清掉，跟着列表重载）
  scopeDraft: {},
  // 「试一条」的状态：question 存着是为了整页重画后输入框不丢字
  preview: { open: false, question: '', loading: false, data: null, error: '' },
  // 导入区：entries 是服务端解析出来的待确认条目（改名字/节点/id 都在本地先攒着）
  importer: { open: false, loading: false, error: '', text: '', entries: [], picked: {}, result: '' }
};
const SKILL_SCOPE_OPTIONS = [
  ['physics', '物理视角'], ['math', '数学视角'], ['graph', '知识图谱'],
  ['viz', '交互可视化'], ['socratic', '苏格拉底追问'], ['learn', '进阶学习']
];

function settingsSkillsLoad(force) {
  if (_skillsPage.loading) return;
  if (_skillsPage.loaded && !force) return;
  if (typeof fetch !== 'function') {
    _skillsPage.loaded = true;
    _skillsPage.error = '当前环境不能读取技能列表';
    return;
  }
  _skillsPage.loading = true;
  fetch('/api/skills')
    .then(resp => (resp.ok ? resp.json() : Promise.reject(new Error('HTTP ' + resp.status))))
    .then(data => {
      _skillsPage.items = Array.isArray(data.skills) ? data.skills : [];
      _skillsPage.byModule = (data.byModule && typeof data.byModule === 'object') ? data.byModule : {};
      if (data.limits) _skillsPage.limits = data.limits;
      if (typeof data.enabled === 'boolean') _skillsPage.routerEnabled = data.enabled;
      _skillsPage.counts = (data.counts && typeof data.counts === 'object') ? data.counts : null;
      _skillsPage.loaded = true;
      _skillsPage.error = '';
    })
    .catch(err => {
      _skillsPage.loaded = true;
      _skillsPage.error = '技能列表读取失败（' + ((err && err.message) || '网络错误') + '）';
    })
    .then(() => {
      _skillsPage.loading = false;
      if (_settingsTab === 'skills') renderSettingsPage();
    });
}

function _settingsSkillScopeLabels(scope) {
  const map = {};
  SKILL_SCOPE_OPTIONS.forEach(pair => { map[pair[0]] = pair[1]; });
  return (scope || []).map(key => map[key] || key).join(' · ');
}

function _settingsSkillRowHtml(item) {
  const isUser = item.source === 'user' || (!item.builtin && item.source !== 'builtin');
  // 第 6 版：目录型（skills/<id>/）。
  // needsAdapt＝目录里只有上游原版 SKILL.md，缺 phymathia.md 适配层 → 看得见、用不上。
  const isDir = item.layout === 'dir';
  const needsAdapt = !!item.needsAdapt;
  // 第 8 版：主流技能包里没有「适用节点」这个概念，装进来往往缺 scope。
  // needsScope＝此刻完全没有生效（候选、投递都拿不到），但要人指定节点，不是去改文件。
  const needsScope = !!item.needsScope;
  const adapted = item.adapted !== false;
  const tags = [];
  if (item.overridden) tags.push('改过的内置');
  else if (item.builtin) tags.push('内置');
  else tags.push('自建');
  if (isDir) tags.push('目录型');
  // 原版 SKILL.md 直接可用（没有本地适配层）：正文会带一句宿主能力声明
  if (isDir && !adapted && !needsAdapt) tags.push('原版直用');
  // 开关状态不再做成「已启用/已关闭」徽标或按钮字样：滑块颜色＋整行降透明度已经说明（2026-11-17 用户拍板）
  const badges = tags.map((text, index) => {
    const dim = index === 0 && item.builtin && !item.overridden;
    return '<span style="margin-left:6px;font-size:11px;opacity:' + (dim ? '.7' : '.85') + ';'
      + 'border:1px solid var(--border);border-radius:var(--r-pill);padding:0 6px">' + _settingsEsc(text) + '</span>';
  }).join('');
  // 「待适配 / 超限 / 待指定」必须显眼：它不是状态瑕疵，而是「这条技能此刻完全没有生效」
  const warn = (needsAdapt || needsScope)
    ? '<span style="margin-left:6px;font-size:11px;color:var(--accent);'
      + 'border:1px solid var(--accent);border-radius:var(--r-pill);padding:0 6px">'
      + (needsAdapt ? (item.oversize ? '正文超限' : '缺正文') : '待指定节点') + '</span>'
    : '';
  const id = _settingsEsc(item.id);
  // 开关＝模型列表同款滑块（settings-model-switch），2026-11-17 用户拍板：不要「已启用/已关闭」字样按钮
  const toggle = '<label class="settings-model-switch"'
    + ' title="' + (item.enabled ? '不再让任何节点用它' : '重新让它参与判定') + '">'
    + '<input type="checkbox" role="switch" aria-label="启用该技能"' + (item.enabled ? ' checked' : '')
    + ' onchange="settingsSkillToggle(\'' + id + '\', ' + (item.enabled ? 'false' : 'true') + ')">'
    + '<span class="settings-switch-track"><span class="settings-switch-knob"></span></span>'
    + '</label>';
  // 目录型不给「编辑」：改的是目录里的 phymathia.md，设置页存不进去（后端会拒，避免用户白改）
  const edit = (needsAdapt || isDir)
    ? ''
    : '<button type="button" class="settings-hk-reset" onclick="settingsSkillEdit(\'' + id + '\')">编辑</button>';
  // 自建/改过的内置能删；纯内置只能关（它随程序发布）；目录型只能去文件管理器删整个文件夹
  const del = (!isDir && isUser)
    ? '<button type="button" class="settings-hk-reset" onclick="settingsSkillDelete(\'' + id + '\', '
      + (item.overridden ? 'true' : 'false') + ')">' + (item.overridden ? '恢复默认' : '删除') + '</button>'
    : '';
  const scopeText = (item.scope && item.scope.length)
    ? _settingsSkillScopeLabels(item.scope)
    : (needsScope ? '未指定' : '未挂节点');
  const where = isDir && item.dir ? ' · 目录 ' + _settingsEsc(item.dir) + '/' : '';
  let hint = '';
  if (needsScope && !item.oversize) {
    // 第 8 版：不让人去改别人的文件——选完写进 skills_state.json，md 一个字节不动
    const draft = _settingsSkillScopeDraft(item.id);
    const chips = SKILL_SCOPE_OPTIONS.map(pair => {
      const on = draft.indexOf(pair[0]) >= 0;
      return '<button type="button" class="settings-hk-reset" style="font-size:11px;'
        + (on ? 'border-color:var(--accent);color:var(--accent);' : '')
        + '" onclick="settingsSkillScopePick(\'' + id + '\',\'' + pair[0] + '\')">'
        + _settingsEsc(pair[1]) + '</button>';
    }).join('');
    hint = '<div style="font-size:11px;margin-top:3px;color:var(--accent);line-height:1.5">'
      + '这条没有声明适用节点，所以现在不会被任何节点用上。选一个或多个节点后点「用这几个」'
      + '——只记在本机，不改动它的文件。</div>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;align-items:center">'
      + chips
      + (draft.length
        ? '<button type="button" class="settings-hk-reset" style="font-size:11px;color:var(--accent);'
          + 'border-color:var(--accent)" onclick="settingsSkillScopeSave(\'' + id + '\')">用这几个</button>'
        : '')
      + '</div>';
  } else if (needsAdapt) {
    hint = '<div style="font-size:11px;margin-top:3px;color:var(--accent);line-height:1.5">'
      + (item.oversize
        ? '正文超过上限（' + (_skillsPage.limits.body || 20000) + ' 字），不会注入——请精简后重存。'
        : '这个入口文件里没有可用的正文，所以不会注入。')
      + '</div>';
  } else if (item.shadowed) {
    hint = '<div style="font-size:11px;margin-top:3px;opacity:.7;line-height:1.5">'
      + '账号目录里的 ' + _settingsEsc(item.shadowed.dir || '同名目录') + '/ 只有原版入口，'
      + '缺 phymathia.md，已按上面这份适配版生效。</div>';
  } else if (isDir && isUser) {
    hint = '<div style="font-size:11px;margin-top:3px;opacity:.55">要删就在文件管理器里删掉整个目录，'
      + '设置页不代删（里面可能有你放进去的参考资料）。</div>';
  }
  return '<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border)'
    + (item.enabled ? '' : ';opacity:.62') + '">'
    + '<div style="flex:1;min-width:0">'
    + '<div style="font-size:13px;color:var(--text-primary)">' + _settingsEsc(item.name) + badges + warn + '</div>'
    + '<div style="font-size:12px;opacity:.75;margin-top:2px">' + _settingsEsc(item.desc || '（没有描述）') + '</div>'
    + '<div style="font-size:11px;opacity:.55;margin-top:2px">id：' + id
    + ' · 适用：' + _settingsEsc(scopeText) + ' · 正文 ' + (item.chars || 0) + ' 字' + where + '</div>'
    + hint
    + '</div><div style="display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end">'
    + toggle + edit + del + '</div></div>';
}

// 按节点分组（2026-11-16 第 4 步）：接口一直在回 byModule，前端原先平铺没用上。
// 一条技能勾了几个节点，就在几个组里各出现一次——这正是它真实的生效范围（每个节点
// 生成时各挂一次），合并成一行反而看不出「这个节点上有哪些候选」。
// 2026-11-17 用户拍板：开关不挪位置——关掉的条目留在原节点组里（整行降透明度＋滑块
// 变灰已经说明它不在候选里），不再单独归「已关闭」组挪到页底（第 5 版的做法，当天即废）。
// 后端 byModule 只回开着的（skill_registry.list_for_ui 分组只算开着的），前端把
// 关掉条目按 scope 补回原组；组内顺序一律跟 items 全表走（服务端顺序开/关不重排），
// 不然关一条会把它挤到组尾，等于换了个位置。
// 纯函数：传 items/byModule 就能算，不依赖页面状态（冒烟直接用样本喂它）。
function _settingsSkillGroups(items, byModule) {
  const list = Array.isArray(items) ? items : [];
  // 旧接口/异常时按 scope 现算一份，别让整页退化成「没有分组」；后端有就拷一份再补
  const map = {};
  if (byModule && typeof byModule === 'object' && Object.keys(byModule).length) {
    for (const key in byModule) map[key] = byModule[key].slice();
  } else {
    list.forEach(item => {
      (item.scope || []).forEach(key => { (map[key] = map[key] || []).push(item.id); });
    });
  }
  list.forEach(item => {
    if (item.enabled !== false) return;
    (item.scope || []).forEach(key => {
      if ((map[key] || []).indexOf(item.id) < 0) (map[key] = map[key] || []).push(item.id);
    });
  });
  const groups = SKILL_SCOPE_OPTIONS.map(pair => ({
    key: pair[0],
    label: pair[1],
    items: list.filter(item => (map[pair[0]] || []).indexOf(item.id) >= 0)
  })).filter(group => group.items.length);
  const emptyLabels = SKILL_SCOPE_OPTIONS
    .filter(pair => !(map[pair[0]] || []).length)
    .map(pair => pair[1]);
  const disabled = list.filter(item => item.enabled === false);
  return {
    groups: groups,
    emptyLabels: emptyLabels,
    known: list.length,
    disabled: disabled,
    active: list.length - disabled.length,
    total: list.length
  };
}

function _settingsSkillRowsHtml() {
  if (_skillsPage.error) return '<div class="settings-note">' + _settingsEsc(_skillsPage.error) + '</div>';
  if (!_skillsPage.items.length) {
    return '<div class="settings-note">还没有技能：新建一条，或导入现成的 .md。</div>';
  }
  const split = _settingsSkillGroups(_skillsPage.items, _skillsPage.byModule);
  let html = '<div class="settings-note" style="font-size:11px">一条技能挂了几个节点，就在几个组里各出现一次。</div>'
    // 用户是外行，这里把「怎么装一个现成技能包」直接写出来（第 6 版目录型）
    + '<div class="settings-note" style="font-size:11px;margin-top:6px">'
    + '装现成的技能包：把整个文件夹放进 <code>data/users/&lt;账号&gt;/skills/</code>，'
    + '再往里放一份 <code>phymathia.md</code>（本项目格式，见内置 anatomy 那份的样子）；'
    + '存盘即生效，不用重启。只有原版 <code>SKILL.md</code> 的会标「待适配」，不会注入。'
    + '</div>';
  if (split.groups.length) {
    html += split.groups.map(group => '<div style="margin-top:14px">'
      + '<div style="display:flex;align-items:baseline;gap:8px;margin-bottom:2px">'
      + '<span style="font-size:13px;font-weight:700;color:var(--text-primary)">' + _settingsEsc(group.label) + '</span>'
      + '<span style="font-size:11px;opacity:.55">' + group.items.length + ' 条</span></div>'
      + group.items.map(_settingsSkillRowHtml).join('')
      + '</div>').join('');
  } else {
    // 组空只可能是「条目的 scope 不含已知节点」（关掉的也留在组里，见 _settingsSkillGroups）
    html += '<div class="settings-note">这些技能没有挂到任何已知节点。</div>';
  }
  html += split.emptyLabels.length
    ? '<div class="settings-note" style="font-size:11px;margin-top:12px">还没有技能可挂的节点：'
      + _settingsEsc(split.emptyLabels.join(' · ')) + '</div>'
    : '';
  return html;
}

function _settingsSkillEditorHtml() {
  const draft = _skillsPage.draft || {};
  const editing = !!draft.id;
  const checks = SKILL_SCOPE_OPTIONS.map(pair => {
    const on = (draft.scope || []).indexOf(pair[0]) >= 0;
    return '<label style="display:inline-flex;align-items:center;gap:4px;margin:0 12px 6px 0;font-size:12px">'
      + '<input type="checkbox" class="skillScope" value="' + pair[0] + '"' + (on ? ' checked' : '') + '>'
      + _settingsEsc(pair[1]) + '</label>';
  }).join('');
  return '<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0 16px">'
    + '<div style="font-size:13px;margin-bottom:8px">' + (editing ? '编辑技能' : '新建技能') + '</div>'
    + (editing
      ? '<div class="settings-note" style="font-size:11px;margin-bottom:8px">'
        + (draft.source === 'builtin'
          ? '内置技能：保存会生成你的副本，原版不动，可随时「恢复默认」。'
          : (draft.overridden
            ? '这是覆盖内置的副本，可「恢复默认」退回原版。'
            : '保存后下一次提问生效。'))
        + '</div>'
      : '')
    + '<div style="display:flex;gap:8px;flex-wrap:wrap">'
    + '<input id="skillDraftName" class="settings-hk-search" style="flex:1;min-width:160px" placeholder="技能名，例如 受力分析七步" value="' + _settingsEsc(draft.name || '') + '">'
    + '<input id="skillDraftId" class="settings-hk-search" style="flex:1;min-width:160px" placeholder="id：小写字母/数字/连字符，建好不可改" value="' + _settingsEsc(draft.id || '') + '"' + (editing ? ' readonly' : '') + '>'
    + '</div>'
    + '<input id="skillDraftDesc" class="settings-hk-search" style="width:100%;margin-top:8px" placeholder="一句话：什么题用它" value="' + _settingsEsc(draft.desc || '') + '">'
    + '<div style="margin-top:10px;font-size:12px;opacity:.75">给哪些节点用（至少选一个）：</div>'
    + '<div style="margin-top:4px">' + checks + '</div>'
    + '<div style="margin-top:6px;font-size:12px;opacity:.75">正文（会原样交给模型）：</div>'
    + '<textarea id="skillDraftBody" style="width:100%;min-height:180px;margin-top:4px;background:transparent;color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:12px;line-height:1.6" placeholder="写清三件事：什么情况适用、按什么步骤做、哪些做法算不合格">' + _settingsEsc(draft.body || '') + '</textarea>'
    + '<div style="display:flex;gap:8px;margin-top:8px;align-items:center">'
    + '<button type="button" class="settings-hk-resetall" onclick="settingsSkillSave()">保存</button>'
    + '<button type="button" class="settings-hk-reset" onclick="settingsSkillCancel()">取消</button>'
    + '<span style="font-size:11px;opacity:.6">正文最多 ' + _skillsPage.limits.body + ' 字</span>'
    + '</div>'
    + _settingsSkillPreviewHtml()
    + '</div>';
}

// ====== 试一条（2026-11-16 第 3 版）======
// 只回答「会不会进候选卡 / 注入多少字 / 注入什么」，不跑模型、不花额度。
// 判定口径以**已保存**的技能为准（服务端读的是磁盘），所以提示里要说清「先保存再试」。
function _settingsSkillPreviewHtml() {
  const st = _skillsPage.preview || {};
  let body = '<div class="settings-note" style="font-size:12px">只算会不会进候选，不花额度；以已保存的版本为准，先保存再试。</div>'
    + '<div style="display:flex;gap:8px;margin-top:8px">'
    + '<input id="skillPreviewQuestion" class="settings-hk-search" style="flex:1;min-width:160px" placeholder="例如：四冲程发动机怎么工作" value="' + _settingsEsc(st.question || '') + '" oninput="settingsSkillPreviewInput(this.value)">'
    + '<button type="button" class="settings-hk-resetall" onclick="settingsSkillPreview()">试一条</button>'
    + '</div>';
  if (st.loading) body += '<div class="settings-note" style="font-size:12px;margin-top:8px">正在试…</div>';
  else if (st.error) body += '<div class="settings-note" style="font-size:12px;margin-top:8px;color:var(--accent)">' + _settingsEsc(st.error) + '</div>';
  else if (st.data) body += _settingsSkillPreviewResultHtml(st.data);
  return '<details class="skill-preview" style="margin-top:12px;border-top:1px solid var(--border);padding-top:10px"'
    + (st.open ? ' open' : '') + ' ontoggle="settingsSkillPreviewToggle(this.open)">'
    + '<summary style="cursor:pointer;font-size:12px;opacity:.8">试一条：会不会被挂上、注入多少字</summary>'
    + '<div style="padding-top:8px">' + body + '</div></details>';
}

function _settingsSkillPreviewResultHtml(data) {
  const modules = (data.modules || []).map(key => {
    const pair = SKILL_SCOPE_OPTIONS.filter(item => item[0] === key)[0];
    return pair ? pair[1] : key;
  });
  const candidates = data.candidates || [];
  let html = '<div style="margin-top:10px;font-size:12.5px">'
    + '<b>候选 ' + candidates.length + ' 条</b>'
    + (candidates.length ? ' · 挂上共注入 <b>' + (data.totalChars || 0) + '</b> 字' : '')
    + '</div>'
    + '<div style="font-size:11px;opacity:.6;margin-top:2px">认出节点：' + _settingsEsc(modules.join(' · ') || '无') + '</div>';
  // 正在编辑的这条到底进没进候选——这是「试一条」最直接的答案
  const editingId = (_skillsPage.draft && _skillsPage.draft.id) || '';
  if (editingId) {
    const hit = candidates.some(item => item.id === editingId);
    html += '<div style="font-size:12px;margin-top:6px;color:' + (hit ? 'var(--accent)' : 'inherit') + '">'
      + (hit ? '这条（' + _settingsEsc(editingId) + '）会在候选里。'
             : '这条（' + _settingsEsc(editingId) + '）不在候选里：节点对不上，或被别的技能挤掉。')
      + '</div>';
  }
  html += candidates.map(item => {
    return '<div style="border-top:1px solid var(--border);padding:8px 0">'
      + '<div style="font-size:12px;color:var(--text-primary)">' + _settingsEsc(item.name)
      + '<span style="margin-left:6px;font-size:11px;opacity:.55">id：' + _settingsEsc(item.id) + '</span></div>'
      + '<div style="font-size:11px;opacity:.65;margin-top:2px">挂到：' + _settingsEsc((item.usableLabels || []).join(' · '))
      + ' · 注入 ' + (item.chars || 0) + ' 字</div>'
      + '<details style="margin-top:4px"><summary style="cursor:pointer;font-size:11px;opacity:.7">看实际注入的正文</summary>'
      + '<pre style="white-space:pre-wrap;word-break:break-word;font-size:11px;line-height:1.6;opacity:.85;'
      + 'border:1px solid var(--border);border-radius:8px;padding:8px;margin-top:4px;max-height:260px;overflow:auto">'
      + _settingsEsc(item.text || '') + '</pre></details></div>';
  }).join('');
  const notes = (data.notes || []).map(line => '<div style="font-size:11px;opacity:.6;margin-top:4px">' + _settingsEsc(line) + '</div>').join('');
  return html + notes;
}

function settingsSkillPreviewInput(value) {
  if (!_skillsPage.preview) _skillsPage.preview = { open: true, question: '', loading: false, data: null, error: '' };
  _skillsPage.preview.question = String(value || '');
}

function settingsSkillPreviewToggle(open) {
  if (!_skillsPage.preview) return;
  _skillsPage.preview.open = !!open;
}

function settingsSkillPreview() {
  if (!_skillsPage.preview) _skillsPage.preview = { open: true, question: '', loading: false, data: null, error: '' };
  const st = _skillsPage.preview;
  const box = document.getElementById('skillPreviewQuestion');
  const question = String((box && box.value) || st.question || '').trim();
  if (!question) {
    st.error = '先写一个问题，例如「四冲程发动机怎么工作」';
    st.data = null;
    st.open = true;
    renderSettingsPage();
    return;
  }
  st.question = question;
  st.loading = true;
  st.error = '';
  st.data = null;
  st.open = true;
  renderSettingsPage();
  fetch('/api/skills/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: question })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '预览失败');
      st.data = result.data;
    })
    .catch(err => {
      st.error = '试不了：' + ((err && err.message) || '网络错误');
      st.data = null;
    })
    .then(() => {
      st.loading = false;
      if (_settingsTab === 'skills') renderSettingsPage();
    });
}

function _settingsPageSkills() {
  if (!_skillsPage.loaded) {
    settingsSkillsLoad();
    return '<div class="settings-page-title">技能</div><div class="settings-note">正在读取技能列表…</div>';
  }
  const msg = _skillsPage.message
    ? '<div class="settings-note" style="color:var(--accent)">' + _settingsEsc(_skillsPage.message) + '</div>' : '';
  const counts = _skillsPage.counts || {};
  const userCount = typeof counts.user === 'number' ? counts.user : _skillsPage.items.filter(i => i.source === 'user').length;
  const offCount = typeof counts.disabled === 'number' ? counts.disabled : _skillsPage.items.filter(i => i.enabled === false).length;
  const routerOn = _skillsPage.routerEnabled !== false;
  return '<div class="settings-page-title">技能</div>'
    + '<div class="settings-note">技能是「做法」：提问时自动挂到合适的节点，生成时才把正文交给它。</div>'
    + '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0;padding:10px 12px;'
    + 'border:1px solid var(--border);border-radius:10px">'
    + '<label class="settings-model-switch" title="技能总开关">'
    + '<input type="checkbox" role="switch" aria-label="技能总开关"' + (routerOn ? ' checked' : '')
    + ' onchange="settingsSkillToggleRouter()">'
    + '<span class="settings-switch-track"><span class="settings-switch-knob"></span></span>'
    + '</label>'
    + '<span style="font-size:13px;color:var(--text-primary)">总开关</span>'
    + '<span style="font-size:12px;opacity:.7;flex:1;min-width:180px">'
    + (routerOn ? '关掉后所有技能都不参与判定。' : '现在没有任何技能会被挂上。')
    + '</span></div>'
    + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:10px 0">'
    + '<button type="button" class="settings-hk-resetall" onclick="settingsSkillNew()">新建技能</button>'
    + '<button type="button" class="settings-hk-reset" onclick="settingsSkillImportOpen()">导入技能</button>'
    + '<span style="font-size:12px;opacity:.6">自建 ' + userCount + ' / ' + _skillsPage.limits.skills + ' 条'
    + (offCount ? ' · 已关闭 ' + offCount + ' 条' : '') + '</span></div>'
    + msg
    + (_skillsPage.draft ? _settingsSkillEditorHtml() : '')
    + (_skillsPage.importer.open ? _settingsSkillImportHtml() : '')
    + _settingsSkillRowsHtml();
}

// ====== 总开关 / 单条开关（2026-11-16 第 5 版）======
function settingsSkillToggleRouter() {
  if (_settingsGuard && _settingsGuard()) return;
  const next = _skillsPage.routerEnabled === false; // 取反
  _skillsPage.routerEnabled = next;
  _skillsPage.message = next ? '正在打开技能路由…' : '正在关闭技能路由…';
  renderSettingsPage();
  fetch('/api/skills/router', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: next })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '保存失败');
      _skillsPage.routerEnabled = result.data.enabled !== false;
      _skillsPage.message = _skillsPage.routerEnabled ? '技能路由已打开' : '技能路由已关闭';
      if (result.data && result.data.notes) _skillsPage.message += ' ' + result.data.notes;
      _skillsPage.loaded = false;
      settingsSkillsLoad(true);
    })
    .catch(err => {
      _skillsPage.routerEnabled = !next;
      _skillsPage.message = '总开关保存失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

// ====== 指定适用节点（第 8 版，2026-11-17）======
// 主流技能包没有「适用节点」字段，装进来普遍缺 scope。旧规则会把它们整条丢掉（悄悄不生效），
// 现在列表里给一条「待指定节点」，人点几个节点再提交，结果写 skills_state.json——
// 不改动别人的 md（那份文件升级时还要用），卸载不会把人家的内容改脏。

function _settingsSkillScopeDraft(id) {
  if (!_skillsPage.scopeDraft || typeof _skillsPage.scopeDraft !== 'object') _skillsPage.scopeDraft = {};
  if (!Array.isArray(_skillsPage.scopeDraft[id])) _skillsPage.scopeDraft[id] = [];
  return _skillsPage.scopeDraft[id];
}

function settingsSkillScopePick(id, key) {
  if (_settingsGuard && _settingsGuard()) return;
  const draft = _settingsSkillScopeDraft(id);
  const at = draft.indexOf(key);
  if (at >= 0) draft.splice(at, 1);
  else draft.push(key);
  _skillsPage.scopeDraft[id] = draft;
  renderSettingsPage();
}

function settingsSkillScopeSave(id) {
  if (_settingsGuard && _settingsGuard()) return;
  const draft = _settingsSkillScopeDraft(id).slice();
  if (!draft.length) return;
  const item = (_skillsPage.items || []).find(row => row.id === id);
  _skillsPage.message = '正在保存适用节点…';
  renderSettingsPage();
  fetch('/api/skills/scope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, scope: draft })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '保存失败');
      const labels = _settingsSkillScopeLabels((result.data && result.data.scope) || draft);
      _skillsPage.message = '已指定：' + ((item && item.name) || id) + ' → ' + labels;
      if (_skillsPage.scopeDraft) delete _skillsPage.scopeDraft[id];
      _skillsPage.loaded = false;
      settingsSkillsLoad(true);
    })
    .catch(err => {
      _skillsPage.message = '保存适用节点失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

function settingsSkillToggle(id, on) {
  if (_settingsGuard && _settingsGuard()) return;
  const item = (_skillsPage.items || []).find(row => row.id === id);
  _skillsPage.message = on ? ('正在启用 ' + id + '…') : ('正在关闭 ' + id + '…');
  renderSettingsPage();
  fetch('/api/skills/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, enabled: !!on })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '保存失败');
      _skillsPage.message = (on ? '已启用：' : '已关闭：') + ((item && item.name) || id);
      _skillsPage.loaded = false;
      settingsSkillsLoad(true);
    })
    .catch(err => {
      _skillsPage.message = '开关保存失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

// ====== 导入（2026-11-16 第 5 版）======
// 两步：① 选文件/粘贴 → 服务端解析成条目（`dryRun`，不落盘）；② 在这里改名字/id/节点、
// 勾掉不要的，再点「导入」才真正写盘。解析规则只在 Python 一份（skill_registry.parse_import），
// 前端不抄第二套，否则「导入看到的」和「保存后的」会分叉。
function _settingsSkillImportHtml() {
  const st = _skillsPage.importer;
  let body = '<div class="settings-note" style="font-size:12px">'
    + '支持 .md / .txt，一次最多 ' + 20 + ' 条；无 front-matter 会自动猜（导入前可改）；同 id 覆盖已有条目（含内置）。</div>'
    + '<div style="display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap">'
    + '<input type="file" id="skillImportFiles" accept=".md,.markdown,.txt,text/markdown,text/plain" multiple'
    + ' onchange="settingsSkillImportFiles(this)" style="font-size:12px;max-width:100%">'
    + '<span style="font-size:11px;opacity:.6">选完自动解析</span></div>'
    + '<div style="margin-top:10px;font-size:12px;opacity:.75">或者直接粘贴一段 md：</div>'
    + '<textarea id="skillImportText" style="width:100%;min-height:110px;margin-top:4px;background:transparent;'
    + 'color:var(--text-primary);border:1px solid var(--border);border-radius:8px;padding:8px;font-size:12px;'
    + 'line-height:1.6" placeholder="---&#10;id: my-skill&#10;name: 我的技能&#10;desc: 什么题用它&#10;scope: physics&#10;---&#10;&#10;正文…"'
    + ' oninput="settingsSkillImportTextInput(this.value)">' + _settingsEsc(st.text || '') + '</textarea>'
    + '<div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">'
    + '<button type="button" class="settings-hk-resetall" onclick="settingsSkillImportParse()">' + (st.loading ? '正在解析…' : '解析粘贴内容') + '</button>'
    + '<button type="button" class="settings-hk-reset" onclick="settingsSkillImportClose()">收起</button>'
    + (st.entries.length ? '<button type="button" class="settings-hk-reset" onclick="settingsSkillImportReset()">清空结果</button>' : '')
    + '</div>';
  if (st.error) body += '<div class="settings-note" style="font-size:12px;margin-top:8px;color:var(--accent)">' + _settingsEsc(st.error) + '</div>';
  if (st.result) body += '<div class="settings-note" style="font-size:12px;margin-top:8px;color:var(--accent)">' + _settingsEsc(st.result) + '</div>';
  if (st.entries.length) {
    const picked = _settingsSkillImportPicked().length;
    body += '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:8px">'
      + '<div style="font-size:12px;opacity:.75">解析出 ' + st.entries.length + ' 条，勾选要导入的：</div>'
      + st.entries.map(_settingsSkillImportEntryHtml).join('')
      + '<div style="display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap">'
      + '<button type="button" class="settings-hk-resetall" id="skillImportConfirmBtn" onclick="settingsSkillImportConfirm()">导入选中的 ' + picked + ' 条</button>'
      + '<span style="font-size:11px;opacity:.6">导入后立即生效</span></div></div>';
  }
  return '<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin:10px 0 16px">'
    + '<div style="font-size:13px;margin-bottom:6px">导入技能</div>' + body + '</div>';
}

function _settingsSkillImportEntryHtml(entry, index) {
  const st = _skillsPage.importer;
  const picked = !!st.picked[index];
  const head = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
    + '<label style="display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-primary)">'
    + '<input type="checkbox"' + (picked ? ' checked' : '') + (entry.ok ? '' : ' disabled')
    + ' onchange="settingsSkillImportPick(' + index + ', this.checked)">'
    + _settingsEsc(entry.filename || entry.name || ('条目 ' + (index + 1))) + '</label>'
    + '<span style="font-size:11px;opacity:.55">正文 ' + (entry.chars || 0) + ' 字</span>'
    + (entry.conflict
      ? '<span style="font-size:11px;color:var(--accent)">会覆盖现有「'
        + _settingsEsc(entry.conflictName || entry.id) + '」（' + (entry.conflict === 'builtin' ? '内置' : '自建') + '）</span>'
      : '');
  if (!entry.ok) {
    return '<div style="border-top:1px solid var(--border);padding:10px 0">' + head
      + '<div style="font-size:11px;color:var(--accent);margin-top:4px">'
      + _settingsEsc((entry.problems || ['解析失败']).join('；')) + '</div></div>';
  }
  const scopes = SKILL_SCOPE_OPTIONS.map(pair => {
    const on = (entry.scope || []).indexOf(pair[0]) >= 0;
    return '<label style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 4px 0;font-size:12px">'
      + '<input type="checkbox"' + (on ? ' checked' : '')
      + ' onchange="settingsSkillImportScope(' + index + ', \'' + pair[0] + '\', this.checked)">'
      + _settingsEsc(pair[1]) + '</label>';
  }).join('');
  const field = (key, value, placeholder, width) =>
    '<input value="' + _settingsEsc(value || '') + '" placeholder="' + _settingsEsc(placeholder) + '"'
    + ' class="settings-hk-search" style="' + width + '"'
    + ' oninput="settingsSkillImportField(' + index + ', \'' + key + '\', this.value)">';
  return '<div style="border-top:1px solid var(--border);padding:10px 0">' + head
    + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">'
    + field('name', entry.name, '技能名', 'flex:1;min-width:150px')
    + field('id', entry.id, 'id（小写字母/数字/连字符）', 'flex:1;min-width:170px')
    + '</div>'
    + field('desc', entry.desc, '一句话：什么题用它', 'width:100%;margin-top:6px')
    + '<div style="margin-top:8px;font-size:12px;opacity:.7">给哪些节点用：</div>'
    + '<div style="margin-top:2px">' + scopes + '</div>'
    + ((entry.warnings || []).length
      ? '<div style="font-size:11px;opacity:.6;margin-top:2px">' + _settingsEsc(entry.warnings.join('；')) + '</div>' : '')
    + '</div>';
}

function settingsSkillImportOpen() {
  if (_settingsGuard && _settingsGuard()) return;
  _skillsPage.importer.open = true;
  _skillsPage.importer.error = '';
  _skillsPage.message = '';
  renderSettingsPage();
}

function settingsSkillImportClose() {
  const st = _skillsPage.importer;
  st.open = false;
  st.error = '';
  st.entries = [];
  st.picked = {};
  st.text = '';
  st.result = '';
  renderSettingsPage();
}

function settingsSkillImportTextInput(value) {
  _skillsPage.importer.text = String(value || '');
}

function settingsSkillImportReset() {
  const st = _skillsPage.importer;
  st.entries = [];
  st.picked = {};
  st.error = '';
  st.result = '';
  st.text = '';
  renderSettingsPage();
}

function settingsSkillImportFiles(input) {
  if (_settingsGuard && _settingsGuard()) return;
  const st = _skillsPage.importer;
  const files = Array.prototype.slice.call((input && input.files) || []);
  if (!files.length) return;
  if (files.length > 20) {
    st.error = '一次最多导入 20 条，这次选了 ' + files.length + ' 个文件';
    renderSettingsPage();
    return;
  }
  st.loading = true;
  st.error = '';
  st.result = '';
  st.entries = [];
  st.picked = {};
  renderSettingsPage();
  if (typeof FileReader !== 'function') {
    st.loading = false;
    st.error = '当前环境不能读本地文件，请把内容粘贴到下面的文本框';
    renderSettingsPage();
    return;
  }
  const reads = files.map(file => new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, text: String(reader.result || '') });
    reader.onerror = () => resolve({ name: file.name, text: '', readError: true });
    reader.readAsText(file, 'utf-8');
  }));
  Promise.all(reads)
    .then(rows => {
      const bad = rows.filter(row => row.readError).map(row => row.name);
      if (bad.length) st.error = '读不出来：' + bad.join('、');
      return _settingsSkillImportPreview(rows);
    })
    .catch(err => {
      st.loading = false;
      st.error = '读文件失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

function _settingsSkillImportPreview(texts) {
  const st = _skillsPage.importer;
  st.loading = true;
  renderSettingsPage();
  return fetch('/api/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dryRun: true, texts: texts })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '解析失败');
      st.entries = Array.isArray(result.data.entries) ? result.data.entries : [];
      st.picked = {};
      st.entries.forEach((entry, index) => { if (entry.ok) st.picked[index] = true; });
    })
    .catch(err => {
      st.error = '解析失败：' + ((err && err.message) || '网络错误');
      st.entries = [];
    })
    .then(() => {
      st.loading = false;
      renderSettingsPage();
    });
}

function settingsSkillImportParse() {
  if (_settingsGuard && _settingsGuard()) return;
  const st = _skillsPage.importer;
  const box = document.getElementById('skillImportText');
  const text = String((box && box.value) || st.text || '');
  if (!text.trim()) {
    st.error = '先选一个 .md 文件，或把内容粘进上面的框';
    renderSettingsPage();
    return;
  }
  st.text = text;
  st.error = '';
  st.result = '';
  _settingsSkillImportPreview([{ name: '', text: text }]);
}

function settingsSkillImportField(index, key, value) {
  const entry = _skillsPage.importer.entries[index];
  if (!entry) return;
  entry[key] = String(value == null ? '' : value);
  if (key === 'id') entry.id = entry.id.trim().toLowerCase();
}

function settingsSkillImportScope(index, key, on) {
  const entry = _skillsPage.importer.entries[index];
  if (!entry) return;
  const scope = (entry.scope || []).filter(item => item !== key);
  if (on) scope.push(key);
  entry.scope = scope;
}

function settingsSkillImportPick(index, picked) {
  _skillsPage.importer.picked[index] = !!picked;
  const btn = document.getElementById('skillImportConfirmBtn');
  if (btn) btn.textContent = '导入选中的 ' + _settingsSkillImportPicked().length + ' 条';
}

function _settingsSkillImportPicked() {
  const st = _skillsPage.importer;
  return (st.entries || []).filter((entry, index) => entry.ok && st.picked[index]);
}

function settingsSkillImportConfirm() {
  if (_settingsGuard && _settingsGuard()) return;
  const st = _skillsPage.importer;
  const rows = _settingsSkillImportPicked().map(entry => ({
    id: entry.id, name: entry.name, desc: entry.desc, scope: entry.scope || [], body: entry.body
  }));
  if (!rows.length) {
    st.error = '先勾选至少一条能导入的（红字那几条要先把问题补上）';
    renderSettingsPage();
    return;
  }
  st.loading = true;
  st.error = '';
  st.result = '';
  renderSettingsPage();
  fetch('/api/skills/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skills: rows })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '导入失败');
      const imported = result.data.imported || [];
      const failed = result.data.failed || [];
      const names = imported.map(row => row.name || row.id).join('、');
      _skillsPage.message = imported.length
        ? '已导入 ' + imported.length + ' 条：' + names + '（下一次提问就会参与判定）'
        : '';
      if (failed.length) {
        st.result = '有 ' + failed.length + ' 条没导进去：'
          + failed.map(row => (row.id || '（无 id）') + ' → ' + row.reason).join('；');
      }
      st.entries = [];
      st.picked = {};
      st.text = '';
      st.loading = false;
      _skillsPage.loaded = false;
      settingsSkillsLoad(true);
    })
    .catch(err => {
      st.loading = false;
      st.error = '导入失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

function settingsSkillNew() {
  if (_settingsGuard && _settingsGuard()) return;
  _skillsPage.draft = { id: '', name: '', desc: '', scope: [], body: '' };
  _skillsPage.message = '';
  renderSettingsPage();
}

function settingsSkillEdit(id) {
  if (_settingsGuard && _settingsGuard()) return;
  const item = (_skillsPage.items || []).find(row => row.id === id);
  if (!item) return;
  _skillsPage.draft = {
    id: item.id, name: item.name, desc: item.desc, scope: (item.scope || []).slice(), body: item.body || '',
    // 只用于编辑器里的说明条：改内置会写一份副本，别让用户以为原版被改坏了
    source: item.source || (item.builtin ? 'builtin' : 'user'),
    overridden: !!item.overridden
  };
  _skillsPage.message = '';
  _skillsPage.importer.open = false;
  renderSettingsPage();
}

function settingsSkillCancel() {
  _skillsPage.draft = null;
  _skillsPage.message = '';
  renderSettingsPage();
}

function settingsSkillSave() {
  if (_settingsGuard && _settingsGuard()) return;
  const val = sel => { const el = document.getElementById(sel); return el ? el.value : ''; };
  const scope = Array.prototype.slice.call(document.querySelectorAll('.skillScope'))
    .filter(box => box.checked).map(box => box.value);
  const payload = {
    id: String(val('skillDraftId') || '').trim().toLowerCase(),
    name: val('skillDraftName'),
    desc: val('skillDraftDesc'),
    scope: scope,
    body: val('skillDraftBody')
  };
  _skillsPage.message = '正在保存…';
  renderSettingsPage();
  fetch('/api/skills/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '保存失败');
      const saved = result.data.skill || {};
      _skillsPage.draft = null;
      _skillsPage.message = '已保存：' + (saved.name || payload.name) + '（下一次提问就会参与判定）'
        + (saved.overridden ? '——这条现在是你的副本，覆盖着同名内置技能，随时可「恢复默认」。' : '');
      _skillsPage.loaded = false;
      settingsSkillsLoad(true);
    })
    .catch(err => {
      _skillsPage.message = '保存失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

function settingsSkillDelete(id, isOverride) {
  if (_settingsGuard && _settingsGuard()) return;
  const ask = isOverride
    ? '恢复「' + id + '」的出厂版本？你自己的改动会被删掉，内置那份重新生效（别的技能不受影响）。'
    : '删除技能「' + id + '」？删掉后不会再被挂上，已生成的内容不受影响。';
  if (typeof confirm === 'function' && !confirm(ask)) return;
  _skillsPage.message = isOverride ? '正在恢复默认…' : '正在删除…';
  renderSettingsPage();
  fetch('/api/skills/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id })
  })
    .then(resp => resp.json().then(data => ({ ok: resp.ok, data: data })))
    .then(result => {
      if (!result.ok) throw new Error((result.data && result.data.detail) || '删除失败');
      _skillsPage.message = isOverride ? ('已恢复默认：' + id) : ('已删除：' + id);
      _skillsPage.loaded = false;
      settingsSkillsLoad(true);
    })
    .catch(err => {
      _skillsPage.message = '删除失败：' + ((err && err.message) || '网络错误');
      renderSettingsPage();
    });
}

const _SETTINGS_PAGES = {
  appearance: _settingsPageAppearance, level: _settingsPageLevel, model: _settingsPageModel,
  memory: _settingsPageMemory, phi: _settingsPagePhi, quiz: _settingsPageQuiz,
  canvas: _settingsPageCanvas, hotkeys: _settingsPageHotkeys, skills: _settingsPageSkills,
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
// 兼容保留：回收站页的保留天数控件 T451 起是自绘下拉（#trashRetentionPicker），
// 唯一写入口是 trash.js 的 setTrashRetentionDays（同步控件外观 → saveTrashRetention）。
// 本函数不再被页面调用，保留给旧代码／回归脚本。
function settingsSaveTrashRetention(value) {
  if (_settingsGuard()) return;
  if (typeof setTrashRetentionDays === 'function') { setTrashRetentionDays(value); return; }
  // 控件/模块缺席时退回原链路（回归脚本按需桩掉上面那个）
  try { if (typeof saveTrashRetention === 'function') saveTrashRetention(value); } catch (e) {}
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
  _settingsModelAddOpen = false; // 换供应商＝换组，行内输入行不跨组带着走
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
    // 供应商总开关（卡片右上）：写入逻辑在 models.js 的 setProviderEnabled
    else if (kind === 'toggleProvider' && typeof setProviderEnabled === 'function') setProviderEnabled(a, val !== false);
  } catch (e) {}
  // 保存/删除后 models.js 会 renderModelList() 派发 phymathia:models-changed 让本页重画；
  // 打开弹窗类动作无需重画，抽屉由捕获相监听保持打开。
}
// 「手动添加模型」行内展开/收起：只切本页状态，不转发到添加供应商大弹窗
function settingsModelToggleAdd() {
  if (_settingsGuard()) return;
  _settingsModelAddOpen = !_settingsModelAddOpen;
  renderSettingsPage();
  if (_settingsModelAddOpen) {
    const input = document.getElementById('settingsAddModelInput');
    if (input && typeof input.focus === 'function') input.focus();
  }
}
// 行内提交：解析与写入全在 models.js 的 addModelToGroup（重复跳过、密钥继承组）；
// renderModelList 派发 phymathia:models-changed 让本页重画（展开态已先收掉）。
// 空输入／ID 框带「|」／显示名数量对不上就地提示、不关行。
function settingsModelAddSubmit() {
  if (_settingsGuard()) return;
  const input = document.getElementById('settingsAddModelInput');
  const nameInput = document.getElementById('settingsAddModelLabelInput');
  const hint = document.getElementById('settingsModelAddHint');
  const raw = input ? String(input.value || '') : '';
  const rawNames = nameInput ? String(nameInput.value || '') : '';
  const say = (text, el) => { if (hint) hint.textContent = text; if (el && typeof el.focus === 'function') el.focus(); };
  if (!raw.trim()) { say('先填个模型 ID', input); return; }
  if (raw.includes('|')) { say('显示名请填右边的框——ID 框不用「|」', input); return; }
  const idCount = raw.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean).length;
  const nameCount = rawNames.split(/[,，\n]+/).map(s => s.trim()).filter(Boolean).length;
  if (nameCount && nameCount !== idCount) { say('显示名要和 ID 一一对应（' + idCount + ' 个），或整个留空', nameInput); return; }
  _settingsModelAddOpen = false;
  try {
    if (typeof addModelToGroup === 'function') { addModelToGroup(_settingsModelProvider, raw, rawNames); return; }
  } catch (e) {}
  renderSettingsPage();
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
    window.settingsModelToggleAdd = settingsModelToggleAdd;
    window.settingsModelAddSubmit = settingsModelAddSubmit;
    window.settingsModelRefresh = settingsModelRefresh;
    window.settingsHotkeyToggleLock = settingsHotkeyToggleLock;
    window.settingsHotkeyFocus = settingsHotkeyFocus;
    window.settingsHotkeyBlur = settingsHotkeyBlur;
    window.settingsHotkeyFilter = settingsHotkeyFilter;
    window.settingsHotkeyResetOne = settingsHotkeyResetOne;
    window.settingsHotkeyResetAllAsk = settingsHotkeyResetAllAsk;
    window.settingsHotkeyResetAllCancel = settingsHotkeyResetAllCancel;
    window.settingsHotkeyResetAllConfirm = settingsHotkeyResetAllConfirm;
    window.settingsHotkeyUndo = settingsHotkeyUndo;
  }
} catch (e) {}
