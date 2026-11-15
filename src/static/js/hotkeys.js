// 快捷键注册表（2026-11-15，backlog #468 / #469）：全站唯一事实源。
//
// 设计口径：
// 1) 只登记「代码里真实存在」的键。速查面板、右键菜单按键提示都从这张表渲染，
//    不许再手写第二份字符串——提示一旦与实现分家，用户就再也不信快捷键了。
// 2) combo 里的 Mod 代表 Ctrl / ⌘，渲染时按平台替换；同一动作全应用只写一个键。
// 3) 分层借力：通用层照抄所有软件、画布层借 Figma/Miro/ComfyUI、应用特有层才自创。
//    自创键不靠死记，统一由 Ctrl+K 类入口兜底（本轮未实现命令面板，先立 ? 速查）。
// 4) 本文件只进 app.js 主包（viewer 子集不载）；所有对外函数以 typeof 守卫被调用，
//    viewer / 冒烟沙箱里行为自动退回原样，不改一处既有交互。

const PHY_HOTKEYS = [
  { id: 'undo',       combo: 'Mod+Z',               label: '撤销上一步',             scope: '画布',   source: '所有编辑器' },
  { id: 'redo',       combo: 'Mod+Y / Mod+Shift+Z', short: 'Mod+Y', label: '重做',   scope: '画布',   source: '所有编辑器' },
  { id: 'copy',       combo: 'Mod+C',               label: '复制选中节点到剪贴板',   scope: '画布',   source: 'Figma / ComfyUI' },
  { id: 'paste',      combo: 'Mod+V',               label: '粘贴节点',               scope: '画布',   source: 'Figma / ComfyUI' },
  { id: 'delete',     combo: 'Del / Backspace',     short: 'Del',   label: '删除选中节点或分组', scope: '画布',   source: '所有编辑器' },
  { id: 'escape',     combo: 'Esc',                 label: '关闭当前浮层 / 取消',    scope: '全局',   source: '所有软件' },
  { id: 'fullscreen', combo: 'F11',                 label: '整页全屏',               scope: '全局',   source: '浏览器' },
  { id: 'submit',     combo: 'Mod+Enter',           label: '提交当前回答',           scope: '输入框', source: 'Slack / Gmail' },
  { id: 'send',       combo: 'Enter',               label: '发送（Shift+Enter 换行）', scope: '输入框', source: '聊天应用' },
  { id: 'fit',        combo: 'F',                   label: '适配画布到窗口',         scope: '查看页', source: '看图器' },
  { id: 'search',     combo: '/',                   label: '打开画布搜索',           scope: '查看页', source: 'GitHub / Gmail' },
  { id: 'help',       combo: '?',                   label: '打开本速查表',           scope: '全局',   source: 'GitHub / Slack' },
];

function phyHotkeyIsMac() {
  try {
    if (typeof navigator === 'undefined') return false;
    const p = navigator.platform || navigator.userAgent || '';
    return typeof p === 'string' && /Mac|iPhone|iPad|iPod/.test(p);
  } catch (e) { return false; }
}

// Mod → Ctrl / ⌘；Mac 上 Shift 用 ⇧。注册表之外的字符串原样返回。
function phyHotkeyMod(combo) {
  const s = String(combo || '');
  if (phyHotkeyIsMac()) return s.replace(/Mod\+/g, '⌘').replace(/Shift\+/g, '⇧');
  return s.replace(/Mod\+/g, 'Ctrl+');
}

// brief=true 用于右键菜单这类窄容器（只显示主写法）；速查面板始终列全。
function phyHotkeyKey(id, brief) {
  const row = PHY_HOTKEYS.find(function (r) { return r.id === id; });
  if (!row) return '';
  return phyHotkeyMod(brief && row.short ? row.short : row.combo);
}

function phyHotkeyList() {
  return PHY_HOTKEYS.map(function (r) {
    return { id: r.id, combo: phyHotkeyMod(r.combo), label: r.label, scope: r.scope, source: r.source };
  });
}

// 输入框内一律让行：物理公式里的 / 、字母 f、Esc 取消输入都属于用户文本。
// graph-events.js 早有同款判定，这里收成公用口径给查看页与新入口复用。
function phyIsTypingTarget(e) {
  const t = e && e.target;
  if (!t || typeof t.closest !== 'function') return false;
  try { return !!t.closest('input, textarea, select, [contenteditable], iframe'); }
  catch (err) { return false; }
}

// 同一次 Esc 只允许一个浮层响应。捕获阶段的临时菜单（右键/导出菜单）天然先到，
// 本来就是最上层；大面板监听用 typeof 守卫接入本函数，避免一次按连关两层。
let _phyHotkeyEscEvent = null;
function phyEscClaim(e) {
  if (!e || e.key !== 'Escape') return false;
  if (_phyHotkeyEscEvent === e) return false;
  _phyHotkeyEscEvent = e;
  return true;
}

// 启动自检：同一范围内登记了两次同一组合键＝提示与实现会打架，开发期直接报出来。
function phyHotkeySelfCheck() {
  const seen = new Map();
  const dup = [];
  PHY_HOTKEYS.forEach(function (r) {
    const k = r.scope + '|' + r.combo;
    if (seen.has(k)) dup.push(r.id + ' 与 ' + seen.get(k) + ' 重复：' + r.combo);
    else seen.set(k, r.id);
  });
  if (dup.length && typeof console !== 'undefined' && console.warn) {
    console.warn('[phymathia] 快捷键注册表冲突：' + dup.join('；'));
  }
  return dup;
}

// ===== ? 速查面板（DOM 按需创建，不改 index.html / 不改 CSS 文件）=====
// 全部内容来自上面的常量表，没有用户输入；配色走全站主题令牌，五套主题自动跟随。
let _phyHotkeyHelpEl = null;

function phyCloseHotkeyHelp() {
  if (_phyHotkeyHelpEl && typeof _phyHotkeyHelpEl.remove === 'function') _phyHotkeyHelpEl.remove();
  _phyHotkeyHelpEl = null;
}

function phyOpenHotkeyHelp() {
  if (typeof document === 'undefined' || !document.createElement) return;
  if (_phyHotkeyHelpEl) { phyCloseHotkeyHelp(); return; }
  const scopes = ['全局', '画布', '输入框', '查看页'];
  const rows = phyHotkeyList();
  let body = '';
  scopes.forEach(function (s) {
    const list = rows.filter(function (r) { return r.scope === s; });
    if (!list.length) return;
    body += '<div class="phk-group"><div class="phk-group-title">' + s + '</div>';
    list.forEach(function (r) {
      body += '<div class="phk-row"><span class="phk-label">' + r.label + '</span>'
        + '<span class="phk-src">' + r.source + '</span>'
        + '<kbd class="phk-key">' + r.combo + '</kbd></div>';
    });
    body += '</div>';
  });
  const style = '<style id="phyHotkeyHelpStyle">'
    + '#phyHotkeyHelpOverlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);font-family:inherit}'
    + '#phyHotkeyHelpOverlay .phk-card{width:min(640px,calc(100vw - 32px));max-height:min(82vh,760px);overflow:auto;box-sizing:border-box;background:var(--bg-panel,#151b2e);color:var(--text-primary,#eef2f8);border:1px solid var(--border,rgba(255,255,255,.16));border-radius:var(--r-lg,12px);padding:18px 20px 14px}'
    + '#phyHotkeyHelpOverlay .phk-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}'
    + '#phyHotkeyHelpOverlay .phk-title{font-size:16px;font-weight:500}'
    + '#phyHotkeyHelpOverlay .phk-sub{font-size:12px;color:var(--text-secondary,rgba(255,255,255,.6));flex:1}'
    + '#phyHotkeyHelpOverlay .phk-close{border:0;background:none;color:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.7;padding:0 4px}'
    + '#phyHotkeyHelpOverlay .phk-close:hover{opacity:1}'
    + '#phyHotkeyHelpOverlay .phk-group{margin-bottom:14px}'
    + '#phyHotkeyHelpOverlay .phk-group-title{font-size:12px;color:var(--accent,#4a9eff);margin-bottom:6px}'
    + '#phyHotkeyHelpOverlay .phk-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-top:1px solid var(--border,rgba(255,255,255,.1));font-size:13px}'
    + '#phyHotkeyHelpOverlay .phk-label{flex:1;min-width:0}'
    + '#phyHotkeyHelpOverlay .phk-src{flex:0 0 132px;text-align:right;font-size:11px;color:var(--text-secondary,rgba(255,255,255,.55));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '#phyHotkeyHelpOverlay .phk-key{flex:0 0 auto;min-width:96px;text-align:center;font-family:inherit;font-size:12px;padding:3px 8px;border-radius:6px;background:var(--panel-bg,rgba(255,255,255,.08));border:1px solid var(--border,rgba(255,255,255,.18));color:var(--text-primary,#eef2f8)}'
    + '#phyHotkeyHelpOverlay .phk-foot{font-size:11px;color:var(--text-secondary,rgba(255,255,255,.55));border-top:1px solid var(--border,rgba(255,255,255,.1));padding-top:10px}'
    + '</style>';
  const overlay = document.createElement('div');
  overlay.id = 'phyHotkeyHelpOverlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '快捷键速查');
  overlay.innerHTML = style
    + '<div class="phk-card" role="document">'
    + '<div class="phk-head"><span class="phk-title">快捷键速查</span>'
    + '<span class="phk-sub">按 ? 或 Esc 关闭</span>'
    + '<button class="phk-close" type="button" aria-label="关闭">×</button></div>'
    + '<div class="phk-body">' + body + '</div>'
    + '<div class="phk-foot">只列程序里真实支持的键 · 输入框内不抢键 · 按键写法随系统自动切换</div>'
    + '</div>';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay || (e.target && e.target.className === 'phk-close')) phyCloseHotkeyHelp();
  });
  if (document.body && document.body.appendChild) document.body.appendChild(overlay);
  _phyHotkeyHelpEl = overlay;
}

if (typeof document !== 'undefined' && document.addEventListener) {
  // 捕获阶段：帮助面板开着时 Esc 由它独占，别的浮层不会跟着一起关。
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _phyHotkeyHelpEl) {
      phyEscClaim(e);
      phyCloseHotkeyHelp();
      // 捕获阶段拦下：速查面板开着时按 Esc 只关它，底下的面板不跟着一起关。
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      return;
    }
    if (e.key !== '?' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (phyIsTypingTarget(e)) return;
    if (_phyHotkeyHelpEl) { phyCloseHotkeyHelp(); return; }
    e.preventDefault();
    phyOpenHotkeyHelp();
  }, true);
  phyHotkeySelfCheck();
}

window.PHY_HOTKEYS = PHY_HOTKEYS;
window.phyHotkeyKey = phyHotkeyKey;
window.phyHotkeyList = phyHotkeyList;
window.phyHotkeyMod = phyHotkeyMod;
window.phyHotkeySelfCheck = phyHotkeySelfCheck;
window.phyIsTypingTarget = phyIsTypingTarget;
window.phyEscClaim = phyEscClaim;
window.phyOpenHotkeyHelp = phyOpenHotkeyHelp;
window.phyCloseHotkeyHelp = phyCloseHotkeyHelp;
