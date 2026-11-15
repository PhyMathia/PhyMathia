// 快捷键注册表（2026-11-15，backlog #468 / #469；同日第二步扩充）：全站唯一事实源。
//
// 设计口径：
// 1) 只登记「代码里真实存在」的键。速查面板、右键菜单按键提示、命令面板都从这张表渲染，
//    不许再手写第二份字符串——提示一旦与实现分家，用户就再也不信快捷键了。
// 2) combo 里的 Mod 代表 Ctrl / ⌘，渲染时按平台替换；同一动作全应用只写一个键。
// 3) 分层借力：通用层照抄所有软件、画布层借 Figma/Miro/ComfyUI、应用特有层才自创，
//    自创键成族（Ctrl+Shift+1/2/3）且全部能在 Ctrl+K 命令面板里搜到。
// 4) 输入框内一律让行；浏览器保留键（Ctrl+N/T/W/L/R/P、Ctrl+Shift+I）一律不碰。
// 5) 本文件只进 app.js 主包（viewer 子集不载）；所有对外函数以 typeof 守卫被调用，
//    viewer / 冒烟沙箱里行为自动退回原样，不改一处既有交互。

const PHY_HOTKEYS = [
  // 通用层：所有软件都一样，照抄，零学习成本
  { id: 'undo',           combo: 'Mod+Z',               label: '撤销上一步',                   scope: '全局' },
  { id: 'redo',           combo: 'Mod+Y / Mod+Shift+Z', short: 'Mod+Y', label: '重做',         scope: '全局' },
  { id: 'copy',           combo: 'Mod+C',               label: '复制选中节点到剪贴板',         scope: '画布', action: 'copy' },
  { id: 'paste',          combo: 'Mod+V',               label: '粘贴节点',                     scope: '画布', action: 'paste' },
  { id: 'delete',         combo: 'Del / Backspace',     short: 'Del', label: '删除选中节点或分组', scope: '画布', action: 'delete' },
  { id: 'escape',         combo: 'Esc',                 label: '关闭当前浮层 / 取消',          scope: '全局' },
  { id: 'fullscreen',     combo: 'F11',                 label: '整页全屏',                     scope: '全局' },
  { id: 'send',           combo: 'Enter / Mod+Enter',   label: '发送或提交当前回答（Shift+Enter 换行）', scope: '输入框' },
  // 画布层：向同类软件借肌肉记忆
  { id: 'selectAll',      combo: 'Mod+A',               label: '全选节点（输入框内仍是全选文字）', scope: '画布', action: 'selectAll' },
  { id: 'duplicate',      combo: 'Mod+D',               label: '原地复制一份选中节点',         scope: '画布', action: 'duplicate' },
  { id: 'group',          combo: 'Mod+G',               label: '把选中节点设为分组',           scope: '画布', action: 'group' },
  { id: 'ungroup',        combo: 'Mod+Shift+G',         label: '取消选中的分组（不删节点）',   scope: '画布', action: 'ungroup' },
  { id: 'fit',            combo: 'F',                   label: '适配画布到窗口',               scope: '全局', action: 'fit' },
  { id: 'zoomReset',      combo: '0',                   label: '缩放复位到 100%',              scope: '画布', action: 'zoomReset' },
  { id: 'search',         combo: 'Mod+F',               label: '打开画布搜索',                 scope: '全局', action: 'search' },
  { id: 'export',         combo: 'Mod+S',               label: '打开导出菜单',                 scope: '全局', action: 'export' },
  { id: 'pan',            combo: 'Space + 拖拽',        label: '按住空格拖动画布（节点上也能平移）', scope: '画布' },
  { id: 'search_viewer',  combo: '/',                   label: '打开画布搜索',                 scope: '查看页' },
  // 同一个键在不同作用域做不同的事，如实登记，不硬把两套撤销栈并成一套
  { id: 'undo_continent', combo: 'Mod+Z',               label: '撤销上一次航线操作（仅大陆内）', scope: '知识大陆' },
  // 应用特有层：本项目独有，才自创，成族且全部能在命令面板搜到
  { id: 'viewCanvas',     combo: 'Mod+Shift+1',         label: '回到探索网画布',               scope: '视图', action: 'viewCanvas' },
  { id: 'viewContinent',  combo: 'Mod+Shift+2',         label: '打开 / 关闭知识大陆',          scope: '视图', action: 'viewContinent' },
  { id: 'viewKnowledge',  combo: 'Mod+Shift+3',         label: '打开 / 关闭知识总览',          scope: '视图', action: 'viewKnowledge' },
  // 兜底：记不住就搜
  { id: 'help',           combo: '?',                   label: '打开快捷键速查',               scope: '全局', action: 'help' },
  { id: 'palette',        combo: 'Mod+K',               label: '打开命令面板（可搜全部动作）', scope: '全局', action: 'palette' },
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

// ===== 用户自定义键位（2026-11-15）：唯一事实源仍是上面这张表 =====
// 只存「改过的那几条」，形状 { [id]: 'Mod+Alt+D' }；没改过的行永远读出厂默认，
// 程序升级调整默认键位时自动跟上。恢复默认＝把这张表清空。
// 可改范围＝带 Ctrl/⌘ 的组合键；单字符键、按住型操作与浏览器/输入框职责键固定。
const PHY_HOTKEY_EDITABLE = [
  'undo', 'redo', 'copy', 'paste',
  'selectAll', 'duplicate', 'group', 'ungroup', 'search', 'export',
  'viewCanvas', 'viewContinent', 'viewKnowledge', 'palette'
];
// hotkeys.js 自己派发的动作；undo/redo/copy/paste/delete 让给 graph-events.js，
// escape/fullscreen/send 等由各自既有链路处理，绝不重复接管。
const PHY_HOTKEY_OWNED = [
  'help', 'fit', 'zoomReset', 'pan',
  'selectAll', 'duplicate', 'group', 'ungroup', 'search', 'export',
  'viewCanvas', 'viewContinent', 'viewKnowledge', 'palette'
];
const PHY_HOTKEY_RESERVED = [
  'Mod+N', 'Mod+T', 'Mod+W', 'Mod+L', 'Mod+R', 'Mod+P', 'Mod+Q', 'Mod+I',
  'Mod+Shift+N', 'Mod+Shift+T', 'Mod+Shift+Q', 'Mod+Shift+I', 'Mod+Shift+W',
  'Mod+Alt+I', 'Mod+Alt+J'
];
const _PHY_COMBO_RE = /^Mod\+(?:Alt\+)?(?:Shift\+)?[A-Z0-9]$/;
const _PHY_SHIFT_DIGITS = { '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7', '*': '8', '(': '9', ')': '0' };

function _phyHotkeyStoreKey() {
  try {
    if (typeof STORAGE_KEY_HOTKEY_OVERRIDES !== 'undefined') return STORAGE_KEY_HOTKEY_OVERRIDES;
  } catch (e) {}
  return 'phymathia_hotkey_overrides';
}
function phyHotkeyOverrides() {
  try {
    const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(_phyHotkeyStoreKey()) : null;
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out = {};
    PHY_HOTKEYS.forEach(function (r) {
      const v = obj[r.id];
      if (typeof v === 'string' && _PHY_COMBO_RE.test(v) && PHY_HOTKEY_EDITABLE.indexOf(r.id) !== -1) out[r.id] = v;
    });
    return out;
  } catch (e) { return {}; }
}
function _phyHotkeySaveOverrides(ov) {
  try {
    const s = JSON.stringify(ov || {});
    if (typeof safeLocalStorageSet === 'function') safeLocalStorageSet(_phyHotkeyStoreKey(), s);
    else if (typeof localStorage !== 'undefined') localStorage.setItem(_phyHotkeyStoreKey(), s);
  } catch (e) {}
}
function phyHotkeyEffective(id) {
  const ov = phyHotkeyOverrides()[id];
  if (ov) return ov;
  const row = PHY_HOTKEYS.find(function (r) { return r.id === id; });
  return row ? row.combo : '';
}
function phyHotkeyCandidates(id) {
  return String(phyHotkeyEffective(id)).split(' / ').map(function (s) { return s.trim(); }).filter(Boolean);
}
// 事件 → 规范组合。无修饰的单键不计 Shift（Shift+/ 就是 '?'，Shift+F 就是 'F'）；
// 带修饰键时 Shift+数字给的是 !@#…，按物理键还原成数字，Ctrl+Shift+1 才认得出来。
function phyHotkeyEventCombo(e) {
  if (!e) return '';
  const k = String(e.key || '');
  if (!k || /^(Control|Shift|Alt|Meta|Ctrl|AltGraph|CapsLock)$/.test(k)) return '';
  const mod = !!(e.ctrlKey || e.metaKey);
  const alt = !!e.altKey;
  let main;
  if (k === ' ') main = 'Space';
  else if (k === 'Escape') main = 'Esc';
  else if (k === 'Delete') main = 'Del';
  else if (k === 'Backspace') main = 'Backspace';
  else if (k === 'Enter') main = 'Enter';
  else if (k.length === 1) main = k.toUpperCase();
  else main = k;
  if ((mod || alt) && e.shiftKey && _PHY_SHIFT_DIGITS[main]) main = _PHY_SHIFT_DIGITS[main];
  const parts = [];
  if (mod) parts.push('Mod');
  if (alt) parts.push('Alt');
  if ((mod || alt) && e.shiftKey) parts.push('Shift');
  parts.push(main);
  return parts.join('+');
}
function phyHotkeyMatchCombo(id, combo) {
  if (!id || !combo) return false;
  return phyHotkeyCandidates(id).indexOf(combo) !== -1;
}
function phyHotkeyMatch(e, id) {
  return phyHotkeyMatchCombo(id, phyHotkeyEventCombo(e));
}
function phyHotkeyApplyCombo(id, combo) {
  const row = PHY_HOTKEYS.find(function (r) { return r.id === id; });
  if (!row || PHY_HOTKEY_EDITABLE.indexOf(id) === -1) {
    return { ok: false, reason: '这条快捷键由系统固定，不能修改' };
  }
  const c = String(combo || '').trim();
  if (!_PHY_COMBO_RE.test(c)) {
    return { ok: false, reason: '请用 Ctrl / ⌘ 加一个字母或数字（可再配 Alt、Shift）' };
  }
  if (PHY_HOTKEY_RESERVED.indexOf(c) !== -1) {
    return { ok: false, reason: '这个组合被浏览器占用了，换一个' };
  }
  const hit = PHY_HOTKEYS.filter(function (r) {
    return r.id !== id && phyHotkeyCandidates(r.id).indexOf(c) !== -1;
  })[0];
  if (hit) return { ok: false, reason: '已被「' + hit.label + '」占用，换一个组合键' };
  const ov = phyHotkeyOverrides();
  ov[id] = c;
  _phyHotkeySaveOverrides(ov);
  return { ok: true, combo: phyHotkeyMod(c) };
}
// 回滚到已知合法状态，绕过校验（撤销／单条还原／全部恢复都走这里）
function phyHotkeyRestoreCombo(id, combo) {
  const ov = phyHotkeyOverrides();
  if (combo) ov[id] = combo; else delete ov[id];
  _phyHotkeySaveOverrides(ov);
}
function phyHotkeyClearOverride(id) {
  phyHotkeyRestoreCombo(id, null);
}
function phyHotkeyResetAllOverrides() {
  _phyHotkeySaveOverrides({});
}
function phyHotkeyCustomCount() {
  return Object.keys(phyHotkeyOverrides()).length;
}
function phyHotkeyDefaultCombo(id) {
  const row = PHY_HOTKEYS.find(function (r) { return r.id === id; });
  return row ? phyHotkeyMod(row.combo) : '';
}

// brief=true 用于右键菜单这类窄容器（只显示主写法）；速查面板始终列全。
function phyHotkeyKey(id, brief) {
  const row = PHY_HOTKEYS.find(function (r) { return r.id === id; });
  if (!row) return '';
  // 自定义键只有一个写法，short（默认写法的窄容器缩写）不再适用。
  const custom = !!phyHotkeyOverrides()[id];
  return phyHotkeyMod(custom ? phyHotkeyEffective(id) : (brief && row.short ? row.short : row.combo));
}

function phyHotkeyList() {
  const ov = phyHotkeyOverrides();
  return PHY_HOTKEYS.map(function (r) {
    return {
      id: r.id, combo: phyHotkeyMod(phyHotkeyEffective(r.id)), label: r.label,
      scope: r.scope, action: r.action || '',
      editable: PHY_HOTKEY_EDITABLE.indexOf(r.id) !== -1,
      custom: !!ov[r.id],
      defaultCombo: phyHotkeyMod(r.combo),
    };
  });
}

// 输入框内一律让行：物理公式里的 / 、字母 f、Esc 取消输入都属于用户文本。
function phyIsTypingTarget(e) {
  const t = e && e.target;
  if (!t || typeof t.closest !== 'function') return false;
  try { return !!t.closest('input, textarea, select, [contenteditable], iframe'); }
  catch (err) { return false; }
}

// 同一次 Esc 只允许一个浮层响应。速查/命令面板在捕获阶段先认领。
let _phyHotkeyEscEvent = null;
function phyEscClaim(e) {
  if (!e || e.key !== 'Escape') return false;
  if (_phyHotkeyEscEvent === e) return false;
  _phyHotkeyEscEvent = e;
  return true;
}

// 启动自检：同一范围内登记两次同一组合键＝提示与实现会打架，开发期直接报出来。
// 同时校验每条可执行动作都在动作表里，杜绝速查表列出根本跑不了的键。
function phyHotkeySelfCheck() {
  const seen = new Map();
  const problems = [];
  PHY_HOTKEYS.forEach(function (r) {
    phyHotkeyCandidates(r.id).forEach(function (combo) {
      const k = r.scope + '|' + combo;
      if (seen.has(k)) problems.push(r.id + ' 与 ' + seen.get(k) + ' 重复：' + combo);
      else seen.set(k, r.id);
    });
    if (r.action && typeof PHY_HOTKEY_ACTIONS[r.action] !== 'function') {
      problems.push(r.id + ' 的动作未实现：' + r.action);
    }
  });
  if (problems.length && typeof console !== 'undefined' && console.warn) {
    console.warn('[phymathia] 快捷键注册表自检未通过：' + problems.join('；'));
  }
  return problems;
}

// ===== 动作表：全部只组合既有全局函数，零新业务逻辑 =====
function _phyToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
  else if (typeof _graphCtxToast === 'function') _graphCtxToast(msg);
}

function _phySelectedNodes() {
  if (typeof graphView === 'undefined' || !graphView) return [];
  const ids = graphView.selectedNodeIds;
  if (!ids || !ids.size || !graphView.nodeById) return [];
  return Array.from(ids).map(function (id) { return graphView.nodeById[id]; }).filter(Boolean);
}

function _phyGraphCenter() {
  const hasCanvas = typeof graphCanvas !== 'undefined' && graphCanvas
    && typeof graphCanvas.getBoundingClientRect === 'function';
  const rect = hasCanvas ? graphCanvas.getBoundingClientRect() : null;
  const cx = rect ? rect.left + rect.width / 2 : (typeof window !== 'undefined' ? window.innerWidth / 2 : 0);
  const cy = rect ? rect.top + rect.height / 2 : (typeof window !== 'undefined' ? window.innerHeight / 2 : 0);
  return typeof _clientToGraphLocal === 'function' ? _clientToGraphLocal(cx, cy) : { x: 0, y: 0 };
}

const PHY_HOTKEY_ACTIONS = {
  help: function () { phyOpenHotkeyHelp(); },
  palette: function () { phyOpenCommandPalette(); },
  undo: function () { if (typeof window.undoGraphAction === 'function') window.undoGraphAction(); },
  redo: function () { if (typeof window.redoGraphAction === 'function') window.redoGraphAction(); },
  copy: function () {
    const picked = _phySelectedNodes();
    if (!picked.length) { _phyToast('先选中节点再复制'); return; }
    if (typeof graphCopySelectedNodes === 'function') graphCopySelectedNodes(picked);
  },
  paste: function () {
    if (typeof graphPasteNodeClipboard === 'function') graphPasteNodeClipboard(_phyGraphCenter());
  },
  delete: function () {
    if (typeof graphView === 'undefined' || !graphView) return;
    const gids = graphView.selectedGroupIds;
    if (gids && gids.size && typeof _deleteSelectedGraphGroups === 'function') {
      _deleteSelectedGraphGroups(Array.from(gids));
      return;
    }
    const nodes = _phySelectedNodes();
    if (nodes.length && typeof _deleteSelectedGraphNodes === 'function') {
      _deleteSelectedGraphNodes(nodes.map(function (n) { return n.id; }));
    }
  },
  selectAll: function () {
    if (typeof graphView === 'undefined' || !graphView || !Array.isArray(graphView.nodes)) return;
    graphView.selectedNodeIds = new Set(graphView.nodes.map(function (n) { return n.id; }));
    if (graphView.selectedGroupIds) graphView.selectedGroupIds = new Set();
    if (typeof _syncGraphSelectionClasses === 'function') _syncGraphSelectionClasses();
  },
  duplicate: function () {
    const picked = _phySelectedNodes();
    if (!picked.length) { _phyToast('先选中节点再复制一份'); return; }
    if (typeof graphCopySelectedNodes !== 'function' || typeof graphPasteNodeClipboard !== 'function') return;
    // 借现成的复制/粘贴链路（自带结构边补捕、撤销与落盘），再偏移 24 落回原处旁边。
    // 用完把剪贴板还原——Ctrl+D 不该悄悄覆盖用户先前的 Ctrl+C。
    const prev = typeof _graphClipLoad === 'function' ? _graphClipLoad() : null;
    graphCopySelectedNodes(picked);
    const xs = picked.map(function (n) { return Number(n.x) || 0; });
    const ys = picked.map(function (n) { return Number(n.y) || 0; });
    const cx = (Math.min.apply(null, xs) + Math.max.apply(null, xs)) / 2 + 24;
    const cy = (Math.min.apply(null, ys) + Math.max.apply(null, ys)) / 2 + 24;
    graphPasteNodeClipboard({ x: cx, y: cy });
    if (prev && typeof _graphClipSave === 'function') _graphClipSave(prev);
  },
  group: function () { if (typeof graphCreateGroup === 'function') graphCreateGroup(); },
  ungroup: function () {
    if (typeof graphView === 'undefined' || !graphView || !graphView.selectedGroupIds
      || !graphView.selectedGroupIds.size) { _phyToast('先选中分组再取消'); return; }
    if (typeof _deleteSelectedGraphGroups === 'function') {
      _deleteSelectedGraphGroups(Array.from(graphView.selectedGroupIds));
    }
  },
  fit: function () { if (typeof fitGraph === 'function') fitGraph(); },
  zoomReset: function () { if (typeof graphZoomReset === 'function') graphZoomReset(); },
  search: function () { if (typeof openGraphSearchPanel === 'function') openGraphSearchPanel(); },
  export: function () { if (typeof toggleGraphExportMenu === 'function') toggleGraphExportMenu(); },
  viewCanvas: function () {
    if (typeof closeContinentView === 'function') closeContinentView();
    if (typeof closeKnowledgePanel === 'function') closeKnowledgePanel();
  },
  viewContinent: function () {
    if (typeof document !== 'undefined' && document.querySelector('.continent-open')) {
      if (typeof closeContinentView === 'function') closeContinentView();
    } else if (typeof openKnowledgeContinentView === 'function') {
      openKnowledgeContinentView();
    }
  },
  viewKnowledge: function () {
    if (typeof closeContinentView === 'function') closeContinentView();
    if (typeof toggleKnowledgePanel === 'function') toggleKnowledgePanel();
  },
};

function phyHotkeyRun(id) {
  const fn = PHY_HOTKEY_ACTIONS[id];
  if (typeof fn !== 'function') return false;
  try { fn(); } catch (err) {
    if (typeof console !== 'undefined' && console.warn) console.warn('[phymathia] 快捷键动作执行失败：' + id, err);
  }
  return true;
}

// 纯映射：按键事件 → 动作 id，不改状态、不执行，便于冒烟精确断言。
// 2026-11-15 起由写死的 if 链改成查「出厂默认表 ＋ 用户改键」：设置页改完
// 立刻生效，速查面板／右键提示／命令面板读的是同一份 effective 值。
// 已有的 Ctrl+Z/Y/C/V 仍由 graph-events.js 处理（它也查同一张表），这里不重复接管。
function phyHotkeyResolve(e) {
  if (!e) return '';
  if (phyIsTypingTarget(e)) return '';
  const combo = phyHotkeyEventCombo(e);
  if (!combo) return '';
  if (combo === 'Space') return 'pan';
  for (const id of PHY_HOTKEY_OWNED) {
    if (id === 'pan') continue;
    if (phyHotkeyMatchCombo(id, combo)) return id;
  }
  return '';
}

// Space 平移状态：graph-events.js 的 pointerdown 读它，按住空格时拖节点也走画布平移。
let _phySpaceDown = false;
function phyIsSpacePanning() { return _phySpaceDown; }

function phyHotkeyDispatch(e) {
  const id = phyHotkeyResolve(e);
  if (!id) return false;
  if (id === 'pan') {
    // 按钮/链接上的空格要留给原生激活（无障碍），不抢。
    if (e.target && typeof e.target.closest === 'function'
      && e.target.closest('button, a, [role="button"]')) return false;
    _phySpaceDown = true;
    e.preventDefault();
    return true;
  }
  // Ctrl+F/S/K/D/A/G 都有浏览器默认行为，接管必须挡掉，否则会弹查找框/另存为/收藏。
  e.preventDefault();
  if (id === 'palette') { phyOpenCommandPalette(); return true; }
  if (id === 'help') { phyOpenHotkeyHelp(); return true; }
  phyHotkeyRun(id);
  return true;
}

// ===== 浮层：速查表与命令面板共用一套样式（主题令牌，五套主题自动跟随）=====
function _phyHotkeyStyleTag() {
  return '<style id="phyHotkeyHelpStyle">'
    + '.phy-hotkey-overlay{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);font-family:inherit}'
    + '.phy-hotkey-overlay .phk-card{width:min(680px,calc(100vw - 32px));max-height:min(82vh,760px);overflow:auto;box-sizing:border-box;background:var(--bg-panel,#151b2e);color:var(--text-primary,#eef2f8);border:1px solid var(--border,rgba(255,255,255,.16));border-radius:var(--r-lg,12px);padding:18px 20px 14px}'
    + '.phy-hotkey-overlay .phk-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}'
    + '.phy-hotkey-overlay .phk-title{font-size:16px;font-weight:500}'
    + '.phy-hotkey-overlay .phk-sub{font-size:12px;color:var(--text-secondary,rgba(255,255,255,.6));flex:1}'
    + '.phy-hotkey-overlay .phk-close{border:0;background:none;color:inherit;font-size:20px;line-height:1;cursor:pointer;opacity:.7;padding:0 4px}'
    + '.phy-hotkey-overlay .phk-close:hover{opacity:1}'
    + '.phy-hotkey-overlay .phk-group{margin-bottom:14px}'
    + '.phy-hotkey-overlay .phk-group-title{font-size:12px;color:var(--accent,#4a9eff);margin-bottom:6px}'
    + '.phy-hotkey-overlay .phk-row{display:flex;align-items:center;gap:10px;padding:5px 0;border-top:1px solid var(--border,rgba(255,255,255,.1));font-size:13px}'
    + '.phy-hotkey-overlay .phk-label{flex:1;min-width:0}'
    + '.phy-hotkey-overlay .phk-scope{flex:0 0 132px;text-align:right;font-size:11px;color:var(--text-secondary,rgba(255,255,255,.55));white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
    + '.phy-hotkey-overlay .phk-key{flex:0 0 auto;min-width:96px;text-align:center;font-family:inherit;font-size:12px;padding:3px 8px;border-radius:6px;background:var(--panel-bg,rgba(255,255,255,.08));border:1px solid var(--border,rgba(255,255,255,.18));color:var(--text-primary,#eef2f8)}'
    + '.phy-hotkey-overlay .phk-search{width:100%;box-sizing:border-box;margin-bottom:10px;padding:9px 12px;font-size:14px;font-family:inherit;color:var(--text-primary,#eef2f8);background:var(--panel-bg,rgba(255,255,255,.08));border:1px solid var(--border,rgba(255,255,255,.18));border-radius:8px;outline:none}'
    + '.phy-hotkey-overlay .phk-palette-row{cursor:pointer;padding:7px 8px;border-radius:6px}'
    + '.phy-hotkey-overlay .phk-palette-row.is-active,.phy-hotkey-overlay .phk-palette-row:hover{background:var(--panel-bg,rgba(255,255,255,.1))}'
    + '.phy-hotkey-overlay .phk-empty{font-size:13px;color:var(--text-secondary,rgba(255,255,255,.55));padding:12px 0}'
    + '.phy-hotkey-overlay .phk-foot{font-size:11px;color:var(--text-secondary,rgba(255,255,255,.55));border-top:1px solid var(--border,rgba(255,255,255,.1));padding-top:10px}'
    + '</style>';
}

function _phyHotkeyEnsureStyle() {
  if (typeof document === 'undefined' || !document.getElementById) return;
  if (document.getElementById('phyHotkeyHelpStyle')) return;
  const holder = document.createElement('span');
  holder.innerHTML = _phyHotkeyStyleTag();
  const node = holder.firstChild;
  if (node && document.head && document.head.appendChild) document.head.appendChild(node);
}

let _phyHotkeyHelpEl = null;
function phyCloseHotkeyHelp() {
  if (_phyHotkeyHelpEl && typeof _phyHotkeyHelpEl.remove === 'function') _phyHotkeyHelpEl.remove();
  _phyHotkeyHelpEl = null;
}

function phyOpenHotkeyHelp() {
  if (typeof document === 'undefined' || !document.createElement) return;
  if (_phyHotkeyHelpEl) { phyCloseHotkeyHelp(); return; }
  phyCloseCommandPalette();
  const scopes = ['全局', '画布', '输入框', '视图', '查看页', '知识大陆'];
  const rows = phyHotkeyList();
  let body = '';
  scopes.forEach(function (s) {
    const list = rows.filter(function (r) { return r.scope === s; });
    if (!list.length) return;
    body += '<div class="phk-group"><div class="phk-group-title">' + s + '</div>';
    list.forEach(function (r) {
      body += '<div class="phk-row"><span class="phk-label">' + r.label + '</span>'
        + '<kbd class="phk-key">' + r.combo + '</kbd></div>';
    });
    body += '</div>';
  });
  _phyHotkeyEnsureStyle();
  const overlay = document.createElement('div');
  overlay.id = 'phyHotkeyHelpOverlay';
  overlay.className = 'phy-hotkey-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '快捷键速查');
  overlay.innerHTML = '<div class="phk-card" role="document">'
    + '<div class="phk-head"><span class="phk-title">快捷键速查</span>'
    + '<span class="phk-sub">按 ? 或 Esc 关闭 · 记不住就按 Ctrl+K 搜</span>'
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

// ===== Ctrl+K 命令面板：所有登记了 action 的条目都能搜到，记不住也不用背 =====
let _phyPaletteEl = null;
let _phyPaletteRows = [];
let _phyPaletteIndex = 0;

function phyCloseCommandPalette() {
  if (_phyPaletteEl && typeof _phyPaletteEl.remove === 'function') _phyPaletteEl.remove();
  _phyPaletteEl = null;
  _phyPaletteRows = [];
  _phyPaletteIndex = 0;
}

function _phyPaletteRender(query) {
  if (!_phyPaletteEl) return;
  const q = String(query || '').trim().toLowerCase();
  const all = phyHotkeyList().filter(function (r) { return !!r.action; });
  _phyPaletteRows = all.filter(function (r) {
    return !q || (r.label + ' ' + r.combo + ' ' + r.scope).toLowerCase().indexOf(q) >= 0;
  });
  if (_phyPaletteIndex >= _phyPaletteRows.length) _phyPaletteIndex = 0;
  const list = _phyPaletteEl.querySelector('.phk-palette-list');
  if (!list) return;
  if (!_phyPaletteRows.length) {
    list.innerHTML = '<div class="phk-empty">没有匹配的动作</div>';
    return;
  }
  list.innerHTML = _phyPaletteRows.map(function (r, i) {
    return '<div class="phk-row phk-palette-row' + (i === _phyPaletteIndex ? ' is-active' : '') + '" data-index="' + i + '">'
      + '<span class="phk-label">' + r.label + '</span>'
      + '<span class="phk-scope">' + r.scope + '</span>'
      + '<kbd class="phk-key">' + r.combo + '</kbd></div>';
  }).join('');
  Array.prototype.forEach.call(list.querySelectorAll('.phk-palette-row'), function (el) {
    el.addEventListener('click', function () {
      _phyPaletteIndex = Number(el.dataset.index) || 0;
      _phyPaletteCommit();
    });
  });
}

function _phyPaletteCommit() {
  const row = _phyPaletteRows[_phyPaletteIndex];
  if (!row) return;
  phyCloseCommandPalette();
  phyHotkeyRun(row.action);
}

function phyOpenCommandPalette() {
  if (typeof document === 'undefined' || !document.createElement) return;
  if (_phyPaletteEl) { phyCloseCommandPalette(); return; }
  phyCloseHotkeyHelp();
  _phyHotkeyEnsureStyle();
  const overlay = document.createElement('div');
  overlay.id = 'phyHotkeyPaletteOverlay';
  overlay.className = 'phy-hotkey-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-label', '命令面板');
  overlay.innerHTML = '<div class="phk-card" role="document">'
    + '<div class="phk-head"><span class="phk-title">命令面板</span>'
    + '<span class="phk-sub">输入筛选 · ↑↓ 选择 · Enter 执行 · Esc 关闭</span>'
    + '<button class="phk-close" type="button" aria-label="关闭">×</button></div>'
    + '<input class="phk-search" type="text" placeholder="搜索动作或按键…" autocomplete="off" aria-label="搜索动作">'
    + '<div class="phk-palette-list"></div>'
    + '<div class="phk-foot">只列程序里真实能执行的动作 · 记不住快捷键就搜这里</div>'
    + '</div>';
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay || (e.target && e.target.className === 'phk-close')) phyCloseCommandPalette();
  });
  const input = overlay.querySelector('.phk-search');
  if (input) {
    input.addEventListener('input', function () { _phyPaletteRender(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); _phyPaletteIndex = Math.min(_phyPaletteIndex + 1, _phyPaletteRows.length - 1); _phyPaletteRender(input.value); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); _phyPaletteIndex = Math.max(_phyPaletteIndex - 1, 0); _phyPaletteRender(input.value); }
      else if (e.key === 'Enter') { e.preventDefault(); _phyPaletteCommit(); }
    });
  }
  if (document.body && document.body.appendChild) document.body.appendChild(overlay);
  _phyPaletteEl = overlay;
  _phyPaletteRender('');
  if (input && typeof input.focus === 'function') input.focus();
}

if (typeof document !== 'undefined' && document.addEventListener) {
  // 捕获阶段：浮层开着时 Esc 由它独占，别的面板不跟着一起关。
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && (_phyHotkeyHelpEl || _phyPaletteEl)) {
      phyEscClaim(e);
      phyCloseHotkeyHelp();
      phyCloseCommandPalette();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      return;
    }
    phyHotkeyDispatch(e);
  }, true);
  document.addEventListener('keyup', function (e) {
    if (e.key === ' ' || e.code === 'Space') _phySpaceDown = false;
  }, true);
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('blur', function () { _phySpaceDown = false; });
  }
  phyHotkeySelfCheck();
}

window.PHY_HOTKEYS = PHY_HOTKEYS;
window.PHY_HOTKEY_ACTIONS = PHY_HOTKEY_ACTIONS;
window.phyHotkeyKey = phyHotkeyKey;
window.phyHotkeyList = phyHotkeyList;
window.phyHotkeyMod = phyHotkeyMod;
window.phyHotkeySelfCheck = phyHotkeySelfCheck;
window.phyHotkeyResolve = phyHotkeyResolve;
window.phyHotkeyDispatch = phyHotkeyDispatch;
window.phyHotkeyRun = phyHotkeyRun;
window.phyHotkeyEffective = phyHotkeyEffective;
window.phyHotkeyCandidates = phyHotkeyCandidates;
window.phyHotkeyEventCombo = phyHotkeyEventCombo;
window.phyHotkeyMatch = phyHotkeyMatch;
window.phyHotkeyMatchCombo = phyHotkeyMatchCombo;
window.phyHotkeyOverrides = phyHotkeyOverrides;
window.phyHotkeyApplyCombo = phyHotkeyApplyCombo;
window.phyHotkeyRestoreCombo = phyHotkeyRestoreCombo;
window.phyHotkeyClearOverride = phyHotkeyClearOverride;
window.phyHotkeyResetAllOverrides = phyHotkeyResetAllOverrides;
window.phyHotkeyCustomCount = phyHotkeyCustomCount;
window.phyHotkeyDefaultCombo = phyHotkeyDefaultCombo;
window.phyIsTypingTarget = phyIsTypingTarget;
window.phyIsSpacePanning = phyIsSpacePanning;
window.phyEscClaim = phyEscClaim;
window.phyOpenHotkeyHelp = phyOpenHotkeyHelp;
window.phyCloseHotkeyHelp = phyCloseHotkeyHelp;
window.phyOpenCommandPalette = phyOpenCommandPalette;
window.phyCloseCommandPalette = phyCloseCommandPalette;
