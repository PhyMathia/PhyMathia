/* ====== 统一设置面板（收编式，2026-11-11）======
 * 只做「分组导航 + 轻量控件」：所有写入一律调用现有全局函数或现有 localStorage 键，
 * 复杂表单（模型/数据/记忆/账号/回收站）仍由原面板承载，抽屉里只给「打开」入口——
 * 不复制表单、不造第二份状态，顶栏旧按钮与侧栏磁贴全部照常可用。
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
    { id: 'quiz', label: '知识检测', icon: 'check' }
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

// 打开原有复杂面板：先收抽屉，避免两层浮层叠在一起。
function settingsOpenLegacy(which) {
  closeSettingsDrawer();
  try {
    if (which === 'model' && typeof toggleModelPanel === 'function') toggleModelPanel();
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

// ====== 各页 ======
function _settingsPageAppearance() {
  const t = _settingsCurrentTheme();
  let wall = 'night', fam = 'aurora', split = false;
  try { if (typeof getWallpaperId === 'function') wall = getWallpaperId(t); } catch (e) {}
  try { if (typeof currentStyleFamily === 'function') fam = currentStyleFamily(); } catch (e) {}
  try { if (typeof themeSplitEnabled === 'function') split = themeSplitEnabled(); } catch (e) {}

  let html = _sHead('外观', '深浅模式、壁纸和整体风格，改动即时生效，刷新后保留。');
  html += _sSection('深浅模式', _sChoices([
    { label: '深色', active: t === 'dark', onclick: "settingsSetTheme('dark')" },
    { label: '浅色', active: t === 'light', onclick: "settingsSetTheme('light')" }
  ]));

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
  const list = [];
  try {
    for (const k of ['middle', 'university', 'research']) {
      list.push({ label: LEVEL_LABELS[k], active: cur === k, onclick: "settingsSetLevel('" + k + "')" });
    }
  } catch (e) {}
  return _sHead('难度等级', '决定 AI 讲解的深度、术语与推导详略；顶栏按钮与这里同步。') +
    _sSection('当前档位', _sChoices(list)) +
    '<div class="settings-note">切换后新回答立即生效，已生成的画布内容不会改写。</div>';
}

function _settingsPageModel() {
  return _sHead('模型', 'API 密钥、服务商与主模型槽位都在原来的「模型设置」面板里管理。') +
    '<div class="settings-note">这里不复制那份表单，避免两处配置不同步。点下面的按钮会收起设置抽屉、打开完整模型面板。</div>' +
    _sSection('模型配置', _sActions([
      { label: '打开模型设置', onclick: "settingsOpenLegacy('model')" }
    ]));
}

function _settingsPageMemory() {
  let impact = '';
  try {
    if (typeof memoryImpactAreas === 'function') {
      impact = memoryImpactAreas().map(a => '<span class="settings-chip">' + _settingsEsc(a.label) + ' — ' + _settingsEsc(a.desc) + '</span>').join('');
    }
  } catch (e) {}
  return _sHead('记忆与画像', '它记着你的学段、目标、兴趣、薄弱点和回答偏好，下次回答与出题照这个来。') +
    _sSwitch('画像总开关', '关掉后 AI 不再读取画像，已有记录不清空', false, 'settingsSetMemoryEnabled(this.checked)', 'settingsMemoryToggle') +
    (impact ? _sSection('会影响这些地方', '<div class="settings-chips">' + impact + '</div>') : '') +
    _sSection('详细管理', _sActions([
      { label: '管理记忆与画像', onclick: "settingsOpenLegacy('memory')" }
    ]));
}

function _settingsPagePhi() {
  const levels = [
    { v: '', label: '自动' }, { v: 'low', label: '浅' },
    { v: 'high', label: '深' }, { v: 'max', label: '最深' }
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
    _sSection('出题素材源', _sChoices(opts.map(x => ({
      label: x.label, title: x.desc, active: cur === x.v, onclick: "settingsSetQuizSource('" + x.v + "')"
    })))) +
    '<div class="settings-note">若检测面板正开着，切换后会按当前范围重建一次卷面。</div>';
}

function _settingsPageData() {
  return _sHead('数据管理', '画布与知识数据自动存在服务端，刷新不会丢；换设备或备份用导出／导入。') +
    _sSection('备份与恢复', _sActions([
      { label: '导出全部数据', onclick: 'exportData()' },
      { label: '导入数据（.json）', onclick: "document.getElementById('importFileInput').click()" },
      { label: '打开完整数据管理', onclick: "settingsOpenLegacy('data')" }
    ])) +
    '<div class="settings-note">导入模式（合并／替换）仍在原数据管理面板里选择，避免导错覆盖。</div>';
}

function _settingsPageAccount() {
  let name = '';
  try { if (typeof _rawLsGet === 'function') name = _rawLsGet(STORAGE_KEY_ACCOUNT_NAME) || ''; } catch (e) {}
  const readonly = _settingsReadonly();
  return _sHead('账号与查阅', readonly ? '正在只读查阅别人的空间，所有设置都不可修改。' : '本机多账号各自独立：偏好、模型、画像、回收站都按账号分开。') +
    _sRow('当前空间', name || '我的空间（默认账号）', '<span class="settings-badge">' + (readonly ? '只读查阅' : '可编辑') + '</span>') +
    _sSection('管理', _sActions([
      { label: '管理账号与查阅', onclick: "settingsOpenLegacy('account')" }
    ]));
}

function _settingsPageTrash() {
  let cur = '7';
  try { cur = _settingsLsGet(STORAGE_KEY_TRASH_RETENTION, '7') || '7'; } catch (e) {}
  const days = ['0', '1', '3', '7', '14', '30', '90'];
  const labels = { '0': '不保留', '1': '1 天', '3': '3 天', '7': '7 天', '14': '14 天', '30': '30 天', '90': '90 天' };
  let opts = '';
  for (const d of days) {
    opts += '<option value="' + d + '"' + (String(cur) === d ? ' selected' : '') + '>' + labels[d] + '</option>';
  }
  // 复用原面板的 select + saveTrashRetention()：把值写回原控件再调原函数，
  // 不复制一份 /api/trash/settings 请求逻辑，也自动继承它的只读态闸门。
  return _sHead('回收站', '删掉的画布在保留期内可以一键恢复；天数对之后删除的画布生效。') +
    _sRow('自动保留', '0 天＝删除即彻底清除',
      '<select class="settings-select" onchange="settingsSaveTrashRetention(this.value)">' + opts + '</select>') +
    _sSection('详细管理', _sActions([
      { label: '打开回收站', onclick: "settingsOpenLegacy('trash')" }
    ]));
}

function _settingsPageAbout() {
  let ver = '';
  try { if (typeof APP_VERSION !== 'undefined') ver = APP_VERSION; } catch (e) {}
  return _sHead('关于', 'PhyMathia · 物理数学双域解释与可视化助手') +
    _sRow('版本', '本机离线运行，无云端账号体系', '<span class="settings-badge">v' + _settingsEsc(ver) + '</span>') +
    _sRow('依赖', 'KaTeX / Marked / Mermaid / DOMPurify 均为本地副本', '<span class="settings-badge">零 CDN</span>') +
    '<div class="settings-note">设置项按账号分别保存在本机；换设备请用「数据管理」导出后导入。</div>';
}

function _settingsPageHelp() {
  return _sHead('帮助与引导', '第一次用或想重新认识界面，可以从这里再走一遍。') +
    _sSection('引导', _sActions([
      { label: '重看新手引导', onclick: 'settingsRestartOnboarding()' }
    ])) +
    '<div class="settings-note">画布右键菜单里会标出该操作对应的快捷键；快捷键目前是内置的，不能自定义。</div>';
}

const _SETTINGS_PAGES = {
  appearance: _settingsPageAppearance, level: _settingsPageLevel, model: _settingsPageModel,
  memory: _settingsPageMemory, phi: _settingsPagePhi, quiz: _settingsPageQuiz,
  data: _settingsPageData, account: _settingsPageAccount, trash: _settingsPageTrash,
  about: _settingsPageAbout, help: _settingsPageHelp
};

function renderSettingsPage() {
  if (!_settingsOpen) return;
  const overlay = document.getElementById('settingsOverlay');
  const nav = document.getElementById('settingsNav');
  const content = document.getElementById('settingsContent');
  if (!overlay || !nav || !content) return;
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
  overlay.classList.toggle('is-readonly', _settingsReadonly());
  if (_settingsTab === 'memory') _settingsLoadMemoryEnabled();
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
  if (['', 'low', 'high', 'max'].indexOf(value) === -1) return;
  _settingsLsSet(STORAGE_KEY_HARNESS_THINKING, value);
  _settingsToast('深度思考已设为「' + ({ '': '自动', low: '浅', high: '深', max: '最深' }[value]) + '」');
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

// ====== 全局事件（加载期只挂监听，零副作用）======
try {
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', function (e) {
      if (!_settingsOpen) return;
      const overlay = document.getElementById('settingsOverlay');
      const btn = document.getElementById('settingsBtn');
      if (!overlay) return;
      if (e && e.target === overlay) { closeSettingsDrawer(); return; }
      if (e && e.target && overlay.contains(e.target)) return;
      if (e && e.target && btn && btn.contains(e.target)) return;
      closeSettingsDrawer();
    });
    document.addEventListener('keydown', function (e) {
      if (_settingsOpen && e && e.key === 'Escape') closeSettingsDrawer();
    });
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
  }
} catch (e) {}
