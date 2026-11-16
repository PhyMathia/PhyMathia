import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// 用法：node scripts/review_settings_panel.mjs
// 纯离线 DOM 桩检查：不开服务、不发请求、不依赖 playwright，只验 settings.js 的
// 导航渲染 / setter 接线 / 记忆停留页 / 只读闸门 / 事件注册，故不受本机
// undici WASM OOM 与 Chromium rc=133 限制影响。

const results = [];
const ok = (n) => { results.push(true); console.log('✓ ' + n); };
const bad = (n, e) => { results.push(false); console.log('❌ ' + n + ' -> ' + e); };

const listeners = {};
const els = new Map();
function mkEl(id) {
  const set = new Set();
  return {
    id, innerHTML: '', textContent: '', value: '', checked: false, disabled: false, style: {},
    // 2026-11-11 四轮：内嵌机制会真的 appendChild / insertBefore 原面板节点，
    // 桩里补一套最小父子关系，才能验证「临时挂载 → 原位置归位」而非只看字符串。
    parentNode: null, nextSibling: null, children: [],
    classList: {
      add: (c) => set.add(c), remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; on ? set.add(c) : set.delete(c); return on; }
    },
    setAttribute(k, v) { this[k] = v; }, contains: () => false,
    querySelector: () => null, click: () => {},
    appendChild(n) {
      if (n.parentNode && Array.isArray(n.parentNode.children)) {
        const i = n.parentNode.children.indexOf(n);
        if (i !== -1) n.parentNode.children.splice(i, 1);
      }
      this.children.push(n);
      n.parentNode = this; n.nextSibling = null;
      return n;
    },
    insertBefore(n, ref) {
      if (n.parentNode && Array.isArray(n.parentNode.children)) {
        const i = n.parentNode.children.indexOf(n);
        if (i !== -1) n.parentNode.children.splice(i, 1);
      }
      const at = ref ? this.children.indexOf(ref) : -1;
      if (at === -1) this.children.push(n); else this.children.splice(at, 0, n);
      n.parentNode = this; n.nextSibling = ref || null;
      return n;
    }
  };
}
const store = new Map();
const calls = [];
const timers = [];
let readonly = false;
let theme = 'dark';
let level = 'university';
let quizSource = 'ai';

const ctx = {
  console,
  Promise,
  document: {
    getElementById(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
    querySelector() { return null; },
    addEventListener(t, fn, opts) { (listeners[t] = listeners[t] || []).push({ fn, opts }); },
    contains: () => false
  },
  localStorage: {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  },
  escapeHtml: (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  toastMsg: (m) => calls.push('toast:' + m),
  safeLocalStorageSet: (k, v) => store.set(k, String(v)),
  phyIsReadonly: () => readonly,
  _rawLsGet: () => '',
  UI_ICON_SVG: new Proxy({}, { get: () => '<svg></svg>' }),
  WALLPAPER_SETS: [
    { id: 'night', name: '星夜', dark: { land: '/a.jpg' }, light: { land: '/a.jpg' } },
    { id: 'paper', name: '素纸', dark: { land: '/b.jpg' }, light: { land: '/b.jpg' } },
    { id: 'mountain', name: '山影', dark: { land: '/c.jpg' }, light: { land: '/c.jpg' } },
    { id: 'neon', name: '霓虹', dark: { land: '/d.jpg' }, light: { land: '/d.jpg' } },
    { id: 'candy', name: '糖果', dark: { land: '/e.jpg' }, light: { land: '/e.jpg' } }
  ],
  STYLE_FAMILIES: [
    { key: 'aurora', label: '极光磨砂', desc: '默认' }, { key: 'blueprint', label: '蓝图制图', desc: '' },
    { key: 'inkstone', label: '砚石·墨韵', desc: '' }, { key: 'neon', label: '霓虹夜光', desc: '' },
    { key: 'candy', label: '糖果磨砂', desc: '' }
  ],
  LEVEL_LABELS: { middle: '中学', university: '大学', research: '科研' },
  THEME_DEFAULT_FAMILY: { night: 'aurora' },
  APP_VERSION: '1.5.1',
  STORAGE_KEY_SETTINGS_TAB: 'phymathia_settings_tab',
  STORAGE_KEY_HARNESS_THINKING: 'phymathia_harness_thinking',
  STORAGE_KEY_HARNESS_FALLBACK: 'phymathia_harness_fallback',
  STORAGE_KEY_QUIZ_SOURCE: 'phymathia_quiz_source',
  STORAGE_KEY_FOLLOWUP_AUTO_ROUTE: 'phymathia_followup_auto_route',
  STORAGE_KEY_TRASH_RETENTION: 'phymathia_trash_retention',
  STORAGE_KEY_ACCOUNT_NAME: 'phymathia_account_name',
  STORAGE_KEY_THEME: 'phymathia_theme',
  currentTheme: theme,
  currentLevel: level,
  quizSourcePreference: quizSource,
  getWallpaperId: () => 'night',
  currentStyleFamily: () => 'aurora',
  themeSplitEnabled: () => false,
  applyTheme(t) { theme = t; ctx.currentTheme = t; calls.push('applyTheme:' + t); },
  pickTheme(id) { calls.push('pickTheme:' + id); },
  pickStyleFamily(k) { calls.push('pickStyle:' + k); },
  setThemeSplit(v) { calls.push('setThemeSplit:' + v); },
  setLevel(v) { level = v; ctx.currentLevel = v; calls.push('setLevel:' + v); },
  changeQuizSourcePreference(v) { quizSource = v; ctx.quizSourcePreference = v; store.set('phymathia_quiz_source', v); calls.push('changeQuizSource:' + v); },
  memoryImpactAreas: () => [{ key: 'chat', label: '对话回答风格', desc: '调整详略' }],
  memoryGetProfile: () => Promise.resolve({ enabled: true }),
  memorySetEnabled: (v) => { calls.push('memorySetEnabled:' + v); return Promise.resolve({}); },
  saveTrashRetention: () => calls.push('saveTrashRetention'),
  // T451：保留天数控件的唯一写入口（trash.js），settings 的兼容函数直接转交它
  setTrashRetentionDays: (v) => calls.push('setTrashRetentionDays:' + v),
  _setPanelTriggerState: () => {},
  _closeHeaderMenus: () => {},
  _closeKnowledgeQuizSubmenu: () => {},
  toggleModelPanel: () => calls.push('toggleModelPanel'),
  toggleDataPanel: () => calls.push('toggleDataPanel'),
  openMemoryPanel: () => calls.push('openMemoryPanel'),
  openAccountsPanel: () => calls.push('openAccountsPanel'),
  openTrashPanel: () => calls.push('openTrashPanel'),
  startOnboarding: () => calls.push('startOnboarding'),
  // 2026-11-11 五轮：帮助/检测页「常用入口」的转发目标桩（window.open 挂 ctx.open）
  openQuiz: () => calls.push('openQuiz'),
  openQuizGlobalDashboard: () => calls.push('openQuizGlobalDashboard'),
  toggleKnowledgePanel: () => calls.push('toggleKnowledgePanel'),
  open: (u) => { calls.push('open:' + u); return {}; },
  exportData: () => calls.push('exportData'),
  // 2026-11-11 四轮：内嵌原面板时由 settings.js 调的现有渲染函数（真实环境在
  // memory.js / ui-backup.js / accounts.js / trash.js，桩里只记调用）
  memoryRenderPanel: () => { calls.push('memoryRenderPanel'); return Promise.resolve(); },
  updateDataStats: () => calls.push('updateDataStats'),
  renderAccountsList: () => { calls.push('renderAccountsList'); return Promise.resolve(); },
  renderTrashList: () => { calls.push('renderTrashList'); return Promise.resolve(); },
  // 2026-11-11 二轮：模型设置页的桩（只读检查，不加载 models.js）
  setTimeout: (fn) => { timers.push(fn); if (typeof fn === 'function') fn(); return 0; },
  // 2026-11-15 快捷键页：这个 vm 单跑 settings.js（不载 hotkeys.js），给只读桩。
  // 键位表的唯一事实源在 hotkeys.js，桩只负责让新页能渲染出真实结构。
  phyHotkeyList: () => [
    { id: 'undo', combo: 'Ctrl+Z', label: '撤销上一步', scope: '全局', source: '所有编辑器', action: 'undo', editable: true, custom: false, defaultCombo: 'Ctrl+Z' },
    { id: 'search', combo: 'Ctrl+F', label: '打开画布搜索', scope: '全局', source: '浏览器', action: 'search', editable: true, custom: false, defaultCombo: 'Ctrl+F' },
    { id: 'escape', combo: 'Esc', label: '关闭当前浮层', scope: '全局', source: '所有软件', action: '', editable: false, custom: false, defaultCombo: 'Esc' }
  ],
  phyHotkeyCustomCount: () => 0,
  phyHotkeyEventCombo: () => '',
  phyHotkeyApplyCombo: () => ({ ok: true, combo: 'Ctrl+Alt+D' }),
  phyHotkeyOverrides: () => ({}),
  phyHotkeyRestoreCombo: () => {},
  phyHotkeyClearOverride: () => {},
  phyHotkeyResetAllOverrides: () => {},
  phyHotkeyDefaultCombo: (id) => (id === 'undo' ? 'Ctrl+Z' : 'Ctrl+F'),
  MODEL_PRESETS: { zhipu: { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' } },
  getAllModels: () => [
    { id: 'm1', name: '智谱 GLM · GLM-5.3', desc: '智谱 GLM', tags: ['GLM-5.3'], provider: 'zhipu', hasKey: true, enabled: true },
    // m2＝停用态；m3 不带 enabled 字段，覆盖「旧配置缺省＝启用」
    { id: 'm2', name: '智谱 GLM · GLM-5.3-Flash', desc: '智谱 GLM', tags: ['GLM-5.3-Flash'], provider: 'zhipu', hasKey: true, enabled: false },
    { id: 'm3', name: 'JLU · jlu-1', desc: 'JLU', tags: ['jlu-1'], provider: 'JLU', hasKey: false }
  ],
  setModelEnabled: (id, on) => calls.push('setModelEnabled:' + id + ':' + !!on),
  getGroupKey: () => 'sk-test',
  showAddModelDialog: () => calls.push('showAddModelDialog'),
  openModelConfig: (id) => calls.push('openModelConfig:' + id),
  confirmDeleteModel: (id) => calls.push('confirmDeleteModel:' + id),
  openModelListUpdate: (p) => calls.push('openModelListUpdate:' + p),
  confirmDeleteModelGroup: (p) => calls.push('confirmDeleteModelGroup:' + p)
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(ROOT + 'src/static/js/settings.js', 'utf8'), ctx);

const nav = ctx.document.getElementById('settingsNav');
const content = ctx.document.getElementById('settingsContent');
const overlay = ctx.document.getElementById('settingsOverlay');
// 四个原面板节点在真页面里天然挂在 body 下；桩里给它们一个共同的「原父」，
// 归位断言才有可核对的落点。
const embedHome = ctx.document.getElementById('fakeHome');
const embedNodes = {
  memory: ctx.document.getElementById('memoryPanel'),
  data: ctx.document.getElementById('dataPanel'),
  account: ctx.document.getElementById('accountsDialog'),
  trash: ctx.document.getElementById('trashDialog')
};
Object.values(embedNodes).forEach(n => embedHome.appendChild(n));

try {
  ctx.openSettingsDrawer();
  overlay.classList.contains('show') ? ok('打开抽屉：show 类就位') : bad('打开抽屉', '缺 show');
  const navItems = (nav.innerHTML.match(/settings-nav-item/g) || []).length;
  navItems === 14 ? ok('左栏渲染 14 个入口（含快捷键与技能）') : bad('左栏入口数', String(navItems));
  content.innerHTML.includes('外观') ? ok('默认停在「外观」页') : bad('默认页', content.innerHTML.slice(0, 80));

  const expect = {
    appearance: '深浅模式', level: '难度等级', model: '模型设置', memory: '记忆与画像',
    phi: '深度思考', quiz: '出题素材源', canvas: '允许 AI 自动判断回答方式',
    skills: '技能',
    hotkeys: '只读浏览',
    data: '数据管理', account: '账号与查阅',
    trash: '自动保留', about: '版本', help: '新手引导'
  };
  for (const [tab, keyword] of Object.entries(expect)) {
    ctx.settingsSelectTab(tab);
    content.innerHTML.includes(keyword) ? ok('页 ' + tab + ' → ' + keyword) : bad('页 ' + tab, '缺关键词 ' + keyword);
  }

  // 2026-11-11 二轮：模型设置页＝截图式两栏面板，旧说明文字与跳转按钮必须消失
  ctx.settingsSelectTab('model');
  const mhtml = content.innerHTML;
  mhtml.includes('添加供应商') && mhtml.includes('模型列表') && mhtml.includes('预设供应商') && mhtml.includes('自定义供应商')
    ? ok('模型页：两栏面板 + 供应商分组 + 模型列表') : bad('模型页面板结构', mhtml.slice(0, 140));
  !mhtml.includes('这里不复制那份表单') && !mhtml.includes('打开模型设置') && !mhtml.includes('settingsOpenLegacy')
    ? ok('模型页：旧说明文字与「打开模型设置」跳转按钮已删除') : bad('模型页旧文案', '仍残留');
  ctx.settingsModelSelect('JLU');
  content.innerHTML.includes('jlu-1') && content.innerHTML.includes('密钥未配置') && !content.innerHTML.includes('GLM-5.3-Flash')
    ? ok('模型页：切换供应商后右侧详情跟着变') : bad('切换供应商', content.innerHTML.slice(0, 140));
  ctx.settingsModelAction('add');
  calls.includes('showAddModelDialog') ? ok('模型页：添加供应商走原弹窗') : bad('添加供应商', '未调用');
  ctx.settingsModelAction('edit', 'm1');
  calls.includes('openModelConfig:m1') ? ok('模型页：配置走原 openModelConfig') : bad('配置模型', '未调用');
  ctx.settingsModelAction('refresh', 'zhipu');
  calls.includes('openModelListUpdate:zhipu') ? ok('模型页：更新列表走原 openModelListUpdate') : bad('更新列表', '未调用');
  ctx.settingsModelAction('delGroup', 'JLU');
  calls.includes('confirmDeleteModelGroup:JLU') ? ok('模型页：删除分组走原函数') : bad('删除分组', '未调用');

  // 2026-11-11 三轮：模型行右侧「启用/停用」开关（用户截图红箭头所指）
  // 此刻停在 JLU 页（桩里 m3 不带 enabled 字段）→ 验旧配置缺省＝启用
  content.innerHTML.includes('aria-label="启用该模型" checked')
    ? ok('模型页：旧配置无 enabled 字段按启用处理') : bad('开关缺省态', content.innerHTML.slice(-220));
  ctx.settingsModelSelect('zhipu');
  const swHtml = content.innerHTML;
  const swCount = (swHtml.match(/class="settings-model-switch"/g) || []).length;
  swCount === 2 && swHtml.includes('role="switch"')
    ? ok('模型页：每个模型行都有启用/停用开关') : bad('模型行开关数量', String(swCount));
  // 只数 checked 属性本身；onchange 里的 this.checked 不算（否则停用行会被误数）
  const checkedCount = (swHtml.match(/aria-label="启用该模型" checked/g) || []).length;
  checkedCount === 1
    ? ok('模型页：启用态勾上、停用态不勾') : bad('开关选中态', 'checked 属性数 ' + checkedCount);
  swHtml.includes('settings-model-row is-off') ? ok('模型页：停用行有 is-off 视觉态') : bad('停用行视觉态', '缺 is-off');
  swHtml.includes("settingsModelAction('toggle'") ? ok('模型页：开关走统一动作转发') : bad('开关转发', '缺 toggle');
  ctx.settingsModelAction('toggle', 'm1', false);
  calls.includes('setModelEnabled:m1:false') ? ok('关开关：转发 setModelEnabled(id,false)') : bad('关开关', '未转发');
  ctx.settingsModelAction('toggle', 'm2', true);
  calls.includes('setModelEnabled:m2:true') ? ok('开开关：转发 setModelEnabled(id,true)') : bad('开开关', '未转发');
  const changeHandlers = listeners['phymathia:models-changed'] || [];
  changeHandlers.length >= 1 ? ok('模型变更事件监听已注册（与顶栏面板同源）') : bad('模型变更监听', '未注册');

  // 2026-11-11 四轮：四页不再放「打开…」跳转按钮，直接把原面板节点挂进抽屉。
  const refreshNames = {
    memory: 'memoryRenderPanel', data: 'updateDataStats',
    account: 'renderAccountsList', trash: 'renderTrashList'
  };
  const slotEl = ctx.document.getElementById('settingsEmbedSlot');
  for (const [tab, node] of Object.entries(embedNodes)) {
    ctx.settingsSelectTab(tab);
    const h = content.innerHTML;
    h.includes('settingsEmbedSlot') && !h.includes('settingsOpenLegacy') && !h.includes('settings-action-arrow')
      ? ok('页 ' + tab + '：内嵌挂载位就位、跳转入口已删') : bad('页 ' + tab + ' 内嵌', h.slice(0, 140));
    node.classList.contains('settings-embedded') && node.parentNode === slotEl
      ? ok('页 ' + tab + '：原面板节点已临时挂进抽屉') : bad('页 ' + tab + ' 挂载', String(node.parentNode && node.parentNode.id));
    calls.includes(refreshNames[tab])
      ? ok('页 ' + tab + '：挂载后调现有渲染函数拉数据') : bad('页 ' + tab + ' 刷新', '未调用 ' + refreshNames[tab]);
  }
  ctx.settingsSelectTab('about');
  Object.values(embedNodes).every(n => !n.classList.contains('settings-embedded') && n.parentNode === embedHome)
    ? ok('切到普通页：四个原面板节点全部归位到原父') : bad('切页归位', '仍有节点留在抽屉里');
  const cnt0 = calls.filter(c => c === 'renderAccountsList').length;
  ctx.settingsSelectTab('account');
  const cnt1 = calls.filter(c => c === 'renderAccountsList').length;
  ctx.renderSettingsPage();
  const cnt2 = calls.filter(c => c === 'renderAccountsList').length;
  cnt1 === cnt0 + 1 && cnt2 === cnt1
    ? ok('同页 setter 重画不重复拉数据（不打断正在输入的表单）') : bad('同页重画', cnt0 + '/' + cnt1 + '/' + cnt2);
  ctx.settingsSelectTab('trash');
  ctx.closeSettingsDrawer();
  embedNodes.trash.parentNode === embedHome && !embedNodes.trash.classList.contains('settings-embedded')
    ? ok('关闭抽屉：内嵌节点归位（旧顶栏入口仍能打开完整面板）') : bad('关闭归位', '节点未回原位');
  ctx.openSettingsDrawer();

  ctx.settingsSelectTab('appearance');
  ctx.settingsSetTheme('light');
  theme === 'light' && content.innerHTML.includes('浅色') ? ok('切浅色：走 applyTheme 且重画') : bad('切浅色', theme + ' / ' + content.innerHTML.slice(0, 60));
  ctx.settingsPickTheme('candy');
  calls.includes('pickTheme:candy') ? ok('换主题卡：调现有 pickTheme') : bad('换主题卡', '未调用');
  ctx.settingsPickStyle('neon');
  calls.includes('pickStyle:neon') ? ok('换风格：调现有 pickStyleFamily') : bad('换风格', '未调用');
  ctx.settingsSetThemeSplit(true);
  calls.includes('setThemeSplit:true') ? ok('深浅独立开关：调现有 setThemeSplit') : bad('深浅独立开关', '未调用');

  ctx.settingsSetLevel('research');
  level === 'research' ? ok('难度：调现有 setLevel 并同步全局档位') : bad('难度', level);
  ctx.settingsSetThinking('high');
  store.get('phymathia_harness_thinking') === 'high' ? ok('Φ 思考档位写现有存储键') : bad('Φ 思考档位', String(store.get('phymathia_harness_thinking')));
  ctx.settingsSetFallback(true);
  store.get('phymathia_harness_fallback') === '1' ? ok('Φ 备用模型开关写现有存储键') : bad('Φ 备用模型', String(store.get('phymathia_harness_fallback')));
  // 2026-11-13：追问自动判断总开关（默认关；开/关都写同一个键并重画开关态）
  ctx.settingsSelectTab('canvas');
  const canvasOff = content.innerHTML;
  !canvasOff.includes(' checked') ? ok('画布与追问：默认关闭（开关未勾）') : bad('追问开关默认态', '不该默认勾选');
  ctx.settingsSetFollowupAutoRoute(true);
  const canvasOn = content.innerHTML;
  store.get('phymathia_followup_auto_route') === '1' && canvasOn.includes(' checked')
    ? ok('追问自动判断：开启写键并重画为勾选态') : bad('追问自动判断开', String(store.get('phymathia_followup_auto_route')));
  ctx.settingsSetFollowupAutoRoute(false);
  store.get('phymathia_followup_auto_route') === '0'
    ? ok('追问自动判断：关闭写 0') : bad('追问自动判断关', String(store.get('phymathia_followup_auto_route')));
  ctx.settingsSetQuizSource('mixed');
  quizSource === 'mixed' && store.get('phymathia_quiz_source') === 'mixed'
    ? ok('检测出题源：调现有 changeQuizSourcePreference') : bad('检测出题源', quizSource);
  ctx.settingsSaveTrashRetention('30');
  calls.includes('setTrashRetentionDays:30')
    ? ok('回收站天数：转交唯一写入口 setTrashRetentionDays（T451 自绘下拉）') : bad('回收站天数', calls.join(','));

  ctx.settingsOpenLegacy('model');
  calls.includes('toggleModelPanel') && !overlay.classList.contains('show')
    ? ok('兼容入口：先收抽屉再开原面板') : bad('兼容入口', '抽屉/调用异常');
  timers.length >= 1 ? ok('兼容入口：延迟到 click 冒泡结束后开面板（修闪退坏链）') : bad('兼容入口延迟', '无 setTimeout');

  ctx.openSettingsDrawer();
  ctx.settingsSelectTab('phi');
  ctx.closeSettingsDrawer();
  ctx.openSettingsDrawer();
  content.innerHTML.includes('深度思考')
    ? ok('记住上次停留页（重开仍是 Φ 助手）') : bad('记住上次停留页', content.innerHTML.slice(0, 60));

  // 2026-11-11 五轮：深浅图标钮 / 卡片式档位 / Φ 五档 / 关于 GitHub / 帮助常用入口
  ctx.settingsSelectTab('appearance');
  const ahtml = content.innerHTML;
  (ahtml.match(/settings-choice--icon/g) || []).length === 2 && ahtml.includes('aria-label="深色模式"') && ahtml.includes('aria-label="浅色模式"')
    ? ok('外观页：深浅模式是月/日图标钮（文案在 aria 标签里）') : bad('深浅图标钮', ahtml.slice(0, 120));
  ctx.settingsSelectTab('level');
  content.innerHTML.includes('settings-card-desc') && content.innerHTML.includes('推导不跳步')
    ? ok('难度页：三档升级为带说明的卡片（与 LEVEL_PROMPTS 同口径）') : bad('难度卡片', content.innerHTML.slice(0, 120));
  ctx.settingsSelectTab('quiz');
  content.innerHTML.includes('本地先出，不足再让 AI 补') && content.innerHTML.includes('settingsOpenQuiz')
    ? ok('检测页：素材源卡片说明可见＋开始检测入口') : bad('检测页卡片', content.innerHTML.slice(0, 120));
  ctx.settingsSelectTab('phi');
  const phtml = content.innerHTML;
  ['>跟随<', '>低<', '>中<', '>高<', '>最高<'].every(k => phtml.includes(k))
    ? ok('Φ 页：思考挡位五档文案（跟随/低/中/高/最高）') : bad('Φ 挡位文案', phtml.slice(0, 160));
  ctx.settingsSetThinking('medium');
  store.get('phymathia_harness_thinking') === 'medium'
    ? ok('Φ 思考档位：medium 写现有存储键') : bad('medium 档', String(store.get('phymathia_harness_thinking')));
  ctx.settingsSelectTab('about');
  content.innerHTML.includes('href="https://github.com/PhyMathia/PhyMathia"') && content.innerHTML.includes('settings-github-link')
    ? ok('关于页：GitHub 仓库链接行就位') : bad('关于 GitHub', content.innerHTML.slice(0, 160));
  ctx.settingsSelectTab('help');
  content.innerHTML.includes('settingsOpenKnowledge') && content.innerHTML.includes('issues')
    ? ok('帮助页：知识总览与 GitHub 反馈入口') : bad('帮助页入口', content.innerHTML.slice(0, 160));
  // 2026-11-15 用户拍板：一页一把锁（默认锁定、不落盘）＋ 点框即录 ＋ 恢复默认
  ctx.settingsSelectTab('hotkeys');
  const kh0 = content.innerHTML;
  // 2026-11-15 二轮：锁条按钮改图标（unlock/lock SVG＋aria-label），判定不再认按钮文字
  kh0.includes('aria-label="解锁编辑"') && kh0.includes('settings-hk-lockbtn') && !kh0.includes('onfocus="settingsHotkeyFocus')
    ? ok('快捷键页：默认锁定只读（unlock 图标钮），键位框不可聚焦') : bad('快捷键默认锁定', kh0.slice(0, 160));
  kh0.includes('恢复全部默认') && kh0.includes('系统固定')
    ? ok('快捷键页：恢复全部默认入口与系统固定说明就位') : bad('快捷键页骨架', kh0.slice(0, 160));
  ctx.settingsHotkeyToggleLock();
  const kh1 = content.innerHTML;
  kh1.includes('aria-label="重新锁定"') && kh1.includes('onfocus="settingsHotkeyFocus')
    ? ok('快捷键页：解锁后键位框可聚焦（点框即录）') : bad('快捷键解锁', kh1.slice(0, 160));
  ctx.settingsSelectTab('about');
  ctx.settingsSelectTab('hotkeys');
  content.innerHTML.includes('aria-label="解锁编辑"')
    ? ok('快捷键页：切走再切回自动重新上锁') : bad('切页回锁', '仍停在解锁态');
  // 入口转发（会收抽屉，放最后；收完重开给只读段用）
  ctx.settingsOpenKnowledge();
  calls.includes('toggleKnowledgePanel') ? ok('帮助入口：知识总览调现有 toggleKnowledgePanel') : bad('知识总览', '未调用');
  ctx.settingsOpenQuiz();
  calls.includes('openQuiz') ? ok('检测入口：画布检测调现有 openQuiz') : bad('画布检测', '未调用');
  ctx.settingsOpenExternal('https://github.com/PhyMathia/PhyMathia');
  calls.includes('open:https://github.com/PhyMathia/PhyMathia') ? ok('外链：window.open 新窗打开') : bad('外链', '未调用');
  ctx.settingsOpenExternal('https://evil.example.com');
  !calls.some(c => String(c).indexOf('open:https://evil') === 0)
    ? ok('外链白名单：非 GitHub/PhyMathia 域拒开') : bad('外链白名单', '放行了外域');
  ctx.openSettingsDrawer();

  readonly = true;
  ctx.renderSettingsPage();
  content.innerHTML.includes('查阅模式') && overlay.classList.contains('is-readonly')
    ? ok('只读查阅态：提示条 + is-readonly 就位') : bad('只读查阅态', content.innerHTML.slice(0, 60));
  ctx.settingsModelAction('del', 'm1');
  !calls.includes('confirmDeleteModel:m1') ? ok('只读查阅态：模型页动作也被拦截') : bad('只读模型页拦截', '仍调用');
  ctx.settingsSelectTab('model');
  ctx.settingsModelSelect('zhipu');
  content.innerHTML.includes('aria-label="启用该模型" disabled')
    ? ok('只读查阅态：模型开关禁用（不会出现假切换）') : bad('只读开关禁用', content.innerHTML.slice(-220));
  ctx.settingsModelAction('toggle', 'm1', true);
  !calls.includes('setModelEnabled:m1:true') ? ok('只读查阅态：开关动作被闸门拦截') : bad('只读开关拦截', '仍调用');
  ctx.settingsSetThinking('max');
  store.get('phymathia_harness_thinking') === 'medium'
    ? ok('只读查阅态：setter 拒绝写入') : bad('只读查阅态写入拦截', String(store.get('phymathia_harness_thinking')));
  readonly = false;

  const clickHandlers = listeners.click || [];
  clickHandlers.length >= 1 ? ok('抽屉外点关闭监听已注册（' + clickHandlers.length + ' 个）') : bad('外点关闭监听', '未注册');
  clickHandlers.length >= 1 && clickHandlers[0].opts === true
    ? ok('外点关闭监听挂在捕获相（先于 onclick 重画判定）') : bad('外点关闭监听捕获相', String(clickHandlers.length && clickHandlers[0].opts));
  const keyHandlers = listeners.keydown || [];
  keyHandlers.length >= 1 ? ok('Esc 关闭监听已注册') : bad('Esc 监听', '未注册');

  // 回归（2026-11-11 用户实踩）：抽屉内点「浅色」不得把抽屉关掉。真浏览器时序：
  // 捕获相监听先跑（按钮还挂在树上，contains 为真）→ inline onclick 的 setter 同步
  // 重画内容区（按钮变游离节点）→ 若监听挂冒泡相，contains 误判抽屉外就关了抽屉。
  // 这里按同序手放：先发 click、再调 setter，抽屉必须保持开；抽屉外点仍要关。
  ctx.openSettingsDrawer();
  ctx.settingsSelectTab('appearance');
  const lightBtn = ctx.document.getElementById('settings-choice-light');
  overlay.contains = (n) => n === lightBtn;
  clickHandlers.forEach(r => r.fn({ target: lightBtn }));
  ctx.settingsSetTheme('dark');
  overlay.classList.contains('show') ? ok('抽屉内点浅色：抽屉保持开（2026-11-11 回归）') : bad('抽屉内点浅色', '抽屉被误关');
  const outside = ctx.document.getElementById('fake-outside');
  clickHandlers.forEach(r => r.fn({ target: outside }));
  !overlay.classList.contains('show') ? ok('抽屉外点：抽屉关闭') : bad('抽屉外点', '抽屉未关');
} catch (e) {
  bad('执行过程', String(e && e.stack || e));
}

// 静态契约（2026-11-11 二轮）：顶栏设置按钮的图标/tooltip + 模型变更同步事件
try {
  const html = readFileSync(ROOT + 'src/static/index.html', 'utf8');
  const line = (html.match(/<button[^>]*id="settingsBtn"[^>]*>[\s\S]*?<\/button>/) || [''])[0];
  line.includes('title="设置"') && !line.includes('设置（')
    ? ok('设置按钮 tooltip 只写「设置」') : bad('设置按钮 tooltip', line.slice(0, 140));
  line.includes('M12 2.4 20.6 7.2') && line.includes('<circle cx="12" cy="12" r="3.2"')
    ? ok('设置按钮图标＝六边形外框 + 内圆') : bad('设置按钮图标', line.slice(0, 160));
  const modelsSrc = readFileSync(ROOT + 'src/static/js/models.js', 'utf8');
  modelsSrc.includes("new CustomEvent('phymathia:models-changed')")
    ? ok('models.js 配置变更后派发同步事件') : bad('模型同步事件', '缺派发');
  // 三轮：开关的数据与生效链（只存一份配置，停用会真的从聊天下拉里消失）
  modelsSrc.includes('function setModelEnabled(') ? ok('models.js 有统一启用/停用写出口') : bad('统一写出口', '缺 setModelEnabled');
  modelsSrc.includes('enabled: cfg.enabled !== false') ? ok('getAllModels 带出 enabled（缺省按启用）') : bad('enabled 出参', '缺字段');
  modelsSrc.includes('getAllModels().filter(m => m.enabled !== false)') ? ok('槽位下拉过滤停用模型（开关真生效）') : bad('下拉过滤', '缺过滤');
  modelsSrc.includes('已停用（设置→模型 里可重新启用）') ? ok('旧式模型面板也标注停用态（两处一致）') : bad('旧面板标注', '缺标记');
  const settingsSrc = readFileSync(ROOT + 'src/static/js/settings.js', 'utf8');
  settingsSrc.includes("kind === 'toggle'") ? ok('设置抽屉把开关转发给 setModelEnabled') : bad('开关转发契约', '缺 toggle 分支');
  // 五轮：图标钮取 UI_ICON_SVG 的 moon/sun；关于页真 <a> 指向仓库；外链带域名白名单；
  // 挡位文案两处（settings.js / harness.js）必须一字不差。
  settingsSrc.includes("_settingsIcon('moon')") && settingsSrc.includes("_settingsIcon('sun')")
    ? ok('深浅模式选择用月/日图标（无文字钮）') : bad('深浅图标钮', '缺 moon/sun 引用');
  settingsSrc.includes('href="https://github.com/PhyMathia/PhyMathia"')
    ? ok('关于页 GitHub 仓库行指向真实仓库') : bad('GitHub 链接', '缺 href');
  settingsSrc.includes("u.indexOf('https://github.com/PhyMathia/') !== 0")
    ? ok('外链入口有 GitHub 域名白名单') : bad('外链白名单', '缺前缀校验');
  const harnessSrc = readFileSync(ROOT + 'src/static/js/harness.js', 'utf8');
  harnessSrc.includes("HARNESS_THINKING_LABELS = { '': '跟随', low: '低', medium: '中', high: '高', max: '最高' }")
    ? ok('harness.js 挡位文案与设置抽屉一致（跟随/低/中/高/最高）') : bad('挡位文案同步', '标签表不一致');
  const cfgSrc = readFileSync(ROOT + 'src/static/js/config.js', 'utf8');
  cfgSrc.includes('github:') && cfgSrc.includes('viewBox="0 0 16 16"')
    ? ok('config.js 有 GitHub 实心章鱼猫标') : bad('GitHub 图标', '缺 github 条目');
  const css = readFileSync(ROOT + 'src/static/css/styles-panels.css', 'utf8');
  css.includes('.settings-model-switch input:checked + .settings-switch-track')
    ? ok('开关样式复用抽屉轨道与 --accent 令牌') : bad('开关样式', '缺选中态规则');
  // 四轮：原面板节点仍在页面原位（只是抽屉打开时临时挂进来），旧入口没删。
  ['memoryPanel', 'dataPanel', 'accountsDialog', 'trashDialog'].every(id => html.includes('id="' + id + '"'))
    ? ok('四个原面板 DOM 仍在页面原位（旧入口未删）') : bad('原面板 DOM', '缺节点');
  const segStart = css.indexOf('.settings-content .settings-embedded {');
  const segEnd = css.indexOf('.settings-content .settings-embedded::before');
  const seg = segStart !== -1 && segEnd > segStart ? css.slice(segStart, segEnd) : '';
  seg.includes('position: static') && !seg.includes('pointer-events')
    ? ok('内嵌 CSS：卸掉浮层定位且不捅穿只读禁点闸门') : bad('内嵌 CSS', seg.slice(0, 120));
  css.includes('body:has(.settings-overlay.show) .memory-dialog-overlay')
    ? ok('内嵌 CSS：清除记忆确认框抬到抽屉之上') : bad('清除记忆弹窗层级', '缺规则');
} catch (e) { bad('静态契约', String(e)); }

const failed = results.filter(r => !r).length;
console.log('\n结果：' + (results.length - failed) + ' ✓ / ' + failed + ' ❌');
process.exit(failed ? 1 : 0);
