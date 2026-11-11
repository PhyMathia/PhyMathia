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
    classList: {
      add: (c) => set.add(c), remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: (c, f) => { const on = f === undefined ? !set.has(c) : !!f; on ? set.add(c) : set.delete(c); return on; }
    },
    setAttribute(k, v) { this[k] = v; }, contains: () => false,
    querySelector: () => null, click: () => {}
  };
}
const store = new Map();
const calls = [];
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
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
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
  _setPanelTriggerState: () => {},
  _closeHeaderMenus: () => {},
  _closeKnowledgeQuizSubmenu: () => {},
  toggleModelPanel: () => calls.push('toggleModelPanel'),
  toggleDataPanel: () => calls.push('toggleDataPanel'),
  openMemoryPanel: () => calls.push('openMemoryPanel'),
  openAccountsPanel: () => calls.push('openAccountsPanel'),
  openTrashPanel: () => calls.push('openTrashPanel'),
  startOnboarding: () => calls.push('startOnboarding'),
  exportData: () => calls.push('exportData')
};
ctx.window = ctx;
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(ROOT + 'src/static/js/settings.js', 'utf8'), ctx);

const nav = ctx.document.getElementById('settingsNav');
const content = ctx.document.getElementById('settingsContent');
const overlay = ctx.document.getElementById('settingsOverlay');

try {
  ctx.openSettingsDrawer();
  overlay.classList.contains('show') ? ok('打开抽屉：show 类就位') : bad('打开抽屉', '缺 show');
  const navItems = (nav.innerHTML.match(/settings-nav-item/g) || []).length;
  navItems === 11 ? ok('左栏渲染 11 个入口') : bad('左栏入口数', String(navItems));
  content.innerHTML.includes('外观') ? ok('默认停在「外观」页') : bad('默认页', content.innerHTML.slice(0, 80));

  const expect = {
    appearance: '深浅模式', level: '难度等级', model: '模型', memory: '记忆与画像',
    phi: '深度思考', quiz: '出题素材源', data: '数据管理', account: '账号与查阅',
    trash: '自动保留', about: '版本', help: '新手引导'
  };
  for (const [tab, keyword] of Object.entries(expect)) {
    ctx.settingsSelectTab(tab);
    content.innerHTML.includes(keyword) ? ok('页 ' + tab + ' → ' + keyword) : bad('页 ' + tab, '缺关键词 ' + keyword);
  }

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
  ctx.settingsSetQuizSource('mixed');
  quizSource === 'mixed' && store.get('phymathia_quiz_source') === 'mixed'
    ? ok('检测出题源：调现有 changeQuizSourcePreference') : bad('检测出题源', quizSource);
  ctx.settingsSaveTrashRetention('30');
  const trashSel = ctx.document.getElementById('trashRetentionSelect');
  trashSel.value === '30' && calls.includes('saveTrashRetention')
    ? ok('回收站天数：回写原控件并复用 saveTrashRetention') : bad('回收站天数', trashSel.value);

  ctx.settingsOpenLegacy('model');
  calls.includes('toggleModelPanel') && !overlay.classList.contains('show')
    ? ok('「打开模型设置」：先收抽屉再开原面板') : bad('打开模型设置', '抽屉/调用异常');

  ctx.openSettingsDrawer();
  ctx.settingsSelectTab('phi');
  ctx.closeSettingsDrawer();
  ctx.openSettingsDrawer();
  content.innerHTML.includes('深度思考')
    ? ok('记住上次停留页（重开仍是 Φ 助手）') : bad('记住上次停留页', content.innerHTML.slice(0, 60));

  readonly = true;
  ctx.renderSettingsPage();
  content.innerHTML.includes('查阅模式') && overlay.classList.contains('is-readonly')
    ? ok('只读查阅态：提示条 + is-readonly 就位') : bad('只读查阅态', content.innerHTML.slice(0, 60));
  ctx.settingsSetThinking('max');
  store.get('phymathia_harness_thinking') === 'high'
    ? ok('只读查阅态：setter 拒绝写入') : bad('只读查阅态写入拦截', String(store.get('phymathia_harness_thinking')));
  readonly = false;

  const clickHandlers = listeners.click || [];
  clickHandlers.length >= 1 ? ok('抽屉外点关闭监听已注册（' + clickHandlers.length + ' 个）') : bad('外点关闭监听', '未注册');
  const keyHandlers = listeners.keydown || [];
  keyHandlers.length >= 1 ? ok('Esc 关闭监听已注册') : bad('Esc 监听', '未注册');
} catch (e) {
  bad('执行过程', String(e && e.stack || e));
}

const failed = results.filter(r => !r).length;
console.log('\n结果：' + (results.length - failed) + ' ✓ / ' + failed + ' ❌');
process.exit(failed ? 1 : 0);
