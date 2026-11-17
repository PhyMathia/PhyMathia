// ===== PhyMathia 共享工具函数（避免多文件重复定义）=====

// ---------- Toast：全仓唯一口径 ----------
// 曾经的 zoo：全局默认 2500，散在别处的 2600 / 3200 / 3600 / 4000 / 4e3，
// 外加 graph-export、graph-poster、utopia-html、utopia-import 四个文件各写一份
// 私有 `_toast` 包装（差别只在传 3200 还是 3600）。结果是同一次操作里提示停留
// 时间会随机不同，且每加一个导出入口就要再抄一份。
//
// 现在只有两个值，且都带理由。别再加第三个——要更长的文案就把文案缩短。
const TOAST_MS = 2500;       // 短提示：一句话，说完就走
const TOAST_MS_LONG = 3600;  // 长文案：带尺寸/体积/条数的完成通知，得留时间读完

// 转发到全局 showToast。加载顺序上它比 ui.js 的 showToast 早（ui.js 在主包
// 倒数第三位），所以查找必须发生在**调用时**而不是定义时——这正是那几个模块
// 当初各写一份包装的原因。守卫保留：查看器包与某些子集构建里 showToast 可能不存在。
function toastMsg(msg, ms) {
  if (typeof showToast !== 'function') return;
  if (ms == null) showToast(msg, TOAST_MS);
  else showToast(msg, ms);
}

// ---------- 全局 JS 异常兜底（T378，2026-10-23）----------
// 用户是编程外行：未捕获异常在用户侧只表现为「点了没反应」，而且收不到任何
// 堆栈。这里统一接住：①toast 告知（文案含「异常」二字，吃 T300 报错 toast 的
// 复制钮与悬停暂停口径）；②POST /api/log 把位置与堆栈落进服务端日志
// （logs/server-<端口>.log，随轮转，不落任何持久存储；坐标可用
// scripts/decode_client_error.mjs 解回源文件行号）。
// 限流：同（消息+位置）30 秒只报一次、单页生命周期最多 10 条——rAF 里的一处
// 错不该每帧刷屏。上报自身全程 try/catch＋fetch 失败静默：file:// 直开、离线、
// 无服务端的外发查看器页都不许因为兜底再抛新错。
const _ERR_GUARD_DEDUPE_MS = 30000;
const _ERR_GUARD_MAX_REPORTS = 10;
const _errGuardSeen = Object.create(null);
let _errGuardReports = 0;
function _clientAssetVersion() {
  try {
    const el = document.querySelector('script[src*=".js?v="]');
    const m = el && el.src.match(/[?&]v=([0-9A-Za-z]+)/);
    return m ? m[1] : '';
  } catch (e) { return ''; }
}
function _reportClientError(kind, msg, src, line, col, stack) {
  try {
    const key = kind + '|' + msg + '|' + src + ':' + line + ':' + col;
    const now = Date.now();
    if (_errGuardSeen[key] && now - _errGuardSeen[key] < _ERR_GUARD_DEDUPE_MS) return;
    _errGuardSeen[key] = now;
    if (_errGuardReports >= _ERR_GUARD_MAX_REPORTS) return;
    _errGuardReports++;
    const payload = {
      kind: kind,
      msg: String(msg || '').slice(0, 500),
      src: String(src || '').slice(0, 200),
      line: line || 0,
      col: col || 0,
      stack: String(stack || '').slice(0, 2000),
      v: _clientAssetVersion(),
      href: String((typeof location !== 'undefined' && location.href) || '').slice(0, 200),
      ua: String((typeof navigator !== 'undefined' && navigator.userAgent) || '').slice(0, 200),
    };
    if (typeof fetch === 'function') {
      fetch('/api/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    }
    const brief = payload.msg.split('\n')[0].slice(0, 80);
    toastMsg('页面脚本异常：' + brief + '（详情已记录）', TOAST_MS_LONG);
  } catch (e) { /* 兜底自身绝不抛 */ }
}
(function _installGlobalErrorGuard() {
  try {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    window.addEventListener('error', function (e) {
      if (!e || (!e.message && e.target)) return;  // 资源加载失败（img/script）不算脚本异常
      _reportClientError('error', e.message, e.filename, e.lineno, e.colno, e.error && e.error.stack);
    });
    window.addEventListener('unhandledrejection', function (e) {
      const r = e && e.reason;
      _reportClientError('unhandledrejection', (r && r.message) || String(r || ''), '', 0, 0, r && r.stack);
    });
  } catch (e) { /* 冒烟沙箱等缺 window.addEventListener：静默跳过 */ }
})();

// ---------- 连线键 ----------
// 曾经 graph.js 与 harness.js 各写一份逐字节相同的 _edgeKey。Φ 的预览态与主画布
// 态各算一遍连线键，两份实现只要有一份漂了，「预览里看得到、应用后没了」这类
// 症状就查不出根因。收到这里，两个包都加载、都早于它们，调用点一个字不用改。
//
// **只合并了 _edgeKey，没合并 _graphState**：那两份不是重复实现——graph-history-diff.js 在
// getGraphState 缺失时返回一份默认状态，harness.js 返回 null（表示「还没有状态」）。
// 合成一份会静默改掉 Φ 的空态语义，那是行为变更不是清理，要改单独立一轮。
function _edgeKey(edge) {
  return (edge.from || '') + ':' + (edge.fromPort || 'out-0') + '->' + (edge.to || '') + ':' + (edge.toPort || 'in-0');
}

// ---------- 问题分析文本清洗 ----------
// 「建议模块：…」是模型按分析提示词附在问题分析末尾的**内部控制行**——
// _parseSuggestedModules 靠它决定建哪些模块节点，同一信息也由回答节点底部
// 带名字的输出端口表达，从来不是给用户看的正文。在渲染层剥而不是存盘时：
// 存量图的 node.analysis 里也躺着这行，渲染时剥一次全覆盖，且原字段不动、
// 解析建点链路零影响。只用于 answer（非 manual）节点的展示取文。
function stripSuggestedModulesLine(text) {
  return String(text == null ? '' : text).replace(/\n?[ \t]*建议模块[ \t]*[：:][^\n]*/g, '');
}

// HTML 转义（DOM 方式 + 引号补齐）
// 引号必须转义：结果会被拼进 value="..." 属性与 onclick 单引号字符串，
// 不转义会造成属性逃逸注入
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text == null ? '' : String(text);
  return div.innerHTML
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 相对时间：超过 7 天回退到全局 formatTime（chat.js 提供）
function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + '分钟前';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + '小时前';
  const day = Math.floor(hr / 24);
  if (day < 7) return day + '天前';
  return formatTime(ts);
}

// 探索网分支 ID：内嵌完整会话标识（后端 _socratic_branch_prefixes 按完整标识
// 精确匹配；旧版截 18 字符会让前缀相同的两个会话互相误删/误认苏格拉底状态）
function _genBranchId() {
  // currentSessionId 在会话尚未立起来时是 null（启动早期/沙箱），空值兜底别抛
  const raw = (typeof currentSessionId !== 'undefined' && currentSessionId) ? currentSessionId : 'sess';
  const sessionPart = String(raw).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return 'br_' + (sessionPart || 'sess') + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// 公式：KaTeX renderToString 不识别 $ 定界符，渲染前剥离
function _stripFormulaDelimiters(latex) {
  return String(latex || '').replace(/^\$+|\$+$/g, '').trim();
}

// 公式：与后端 _looks_like_formula 一致（排除单字符/纯短字母/纯命令/纯 \text{}/单位斜杠/
// 纯中文/中文散文无 LaTeX 结构）。2026-10-12 前缺后端独有的两条中文闸门——$能量守恒$
// 这类概念名能进本地公式缓存，而 POST /api/formulas 按后端闸门拒收，本地条目永远
// 同步不上去，面板里就成了清不掉的僵尸条目；入参带 $ 定界符时先剥（与后端同口径）。
function _looksLikeFormula(latex) {
  const s = String(latex || '').trim().replace(/^\$+|\$+$/g, '').trim();
  if (!s) return false;
  if (s.length === 1) return false;                        // 单字符：m、k
  if (/^[A-Za-z]{1,3}$/.test(s)) return false;             // 纯短字母：rad、Hz
  if (/^\\[A-Za-z]+$/.test(s)) return false;               // 纯符号命令：\omega
  if (/^\\text\{[^{}]*\}$/.test(s)) return false;          // 纯 \text{...}：\text{rad/s}
  if (/^[A-Za-z]{1,4}(\/[A-Za-z]{1,4})+$/.test(s)) return false; // 单位：rad/s、m/s
  if (/^[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+$/.test(s)) return false; // 纯中文：能量守恒
  // 含中文但没有真实 LaTeX 结构（命令/上下标/花括号/关系符；数字不算——「$5 一个，支架$」
  // 这类中文＋数字散文前后端一致拒收）＝回显的正文片段，不是公式
  if (/[\u4e00-\u9fff]/.test(s) && !/[\\^_={}<>±≤≥→]/.test(s)) return false;
  return true;
}

// 公式：与后端 _normalize_formula 一致（\$→$、去首尾 $、统一包 $..$，清洗 \= 无效命令）
function _normalizeFormulaLatex(latex) {
  let s = String(latex || '').trim();
  s = s.replace(/\\\$/g, '$').trim();
  s = s.replace(/^\$+|\$+$/g, '').trim();
  // 只清 \=；\, \; \: 合法间距命令不剥（T422，与后端 _normalize_formula 同步）
  s = s.replace(/\\=/g, '=');
  return s ? '$' + s + '$' : '';
}

window._genBranchId = _genBranchId;

// 推理模型（deepseek-v4-flash 等）正文常带 <think>…</think> 思考块；
// 后端 harness 已剥离，这里做前端兜底（旧缓存响应仍可能含思考文本）。
function _stripThinkText(text) {
  let s = String(text || '');
  s = s.replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\s*\1\s*>/gi, '');
  const open = s.match(/<(think|thinking|reasoning|thought)>/i);
  if (open) s = s.slice(0, open.index);
  return s.trim();
}
window._stripThinkText = _stripThinkText;

// localStorage 安全写：配额满/不可用时返回 false，不抛异常、不清理任何已存
// 数据（「都存着」原则——本地格子只影响快不快，不决定丢不丢，数据安全由各
// 写点的服务端同步兜底）。写失败给用户一次明确提示，内存节流一天最多一次。
let _storageWarnedAt = 0;

function safeLocalStorageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (Date.now() - _storageWarnedAt > 24 * 3600 * 1000) {
      _storageWarnedAt = Date.now();
      if (typeof showToast === 'function') {
        toastMsg('浏览器本地空间已满：记录已完整保存在电脑存档中，仅本机快速加载暂不可用', TOAST_MS_LONG);
      } else {
        console.warn('[storage] localStorage 写入失败（配额满？）：', key);
      }
    }
    return false;
  }
}
window.safeLocalStorageSet = safeLocalStorageSet;

// ---------- CSS 令牌取值（T166）----------
// JS 需要「真值」的场合（canvas 取色、SVG 属性、input[type=color] 的 value）用本函数
// 读 :root 令牌：颜色的唯一事实源留在 CSS，JS 源码里不再出现颜色字面量
// （style_debt 的 jsColorLiterals 口径，同 config.js RECIPE_PALETTE 的既有做法）。
function cssVarValue(name) {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch (e) { return ''; }
}

// 'var(--x)' 引用 → 计算值；传入真值原样返回（给需要 #rrggbb 的控件/属性用）
function resolveCssColor(value) {
  const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(String(value || '').trim());
  return m ? (cssVarValue(m[1]) || value) : value;
}

// 分组框默认色：读一次缓存（新建分组与兜底渲染共用，避免渲染路径反复触发样式计算）
let _graphGroupDefaultColorCache = '';
function graphDefaultGroupColor() {
  if (!_graphGroupDefaultColorCache) _graphGroupDefaultColorCache = cssVarValue('--graph-group-default');
  return _graphGroupDefaultColorCache;
}

// ===== 浏览器全屏共享把手（2026-10-16 全屏普适化）=====
// 知识大陆 ⤢ 与全局 F11（ui.js）同用一套：判态/进/退带 -webkit- 前缀兜底，promise
// 拒绝静默（全屏可被浏览器策略拒绝，静默但调用方按钮仍在——原大陆实现同口径）。
function phyBrowserFullscreenTarget() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function phyIsBrowserFullscreen() {
  return !!phyBrowserFullscreenTarget();
}

function phyRequestBrowserFullscreen(el) {
  if (!el) return;
  try {
    if (el.requestFullscreen) {
      const p = el.requestFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  } catch (e) { /* 全屏被策略拒绝：静默 */ }
}

function phyExitBrowserFullscreen() {
  try {
    if (document.exitFullscreen) {
      const p = document.exitFullscreen();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  } catch (e) { /* 静默 */ }
}

// el 缺省整页（documentElement）：可视化全屏/节点阅读层这些页内遮罩天然跟着整页走
function phyToggleBrowserFullscreen(el) {
  if (phyIsBrowserFullscreen()) phyExitBrowserFullscreen();
  else phyRequestBrowserFullscreen(el || document.documentElement);
}

window.phyBrowserFullscreenTarget = phyBrowserFullscreenTarget;
window.phyIsBrowserFullscreen = phyIsBrowserFullscreen;
window.phyRequestBrowserFullscreen = phyRequestBrowserFullscreen;
window.phyExitBrowserFullscreen = phyExitBrowserFullscreen;
window.phyToggleBrowserFullscreen = phyToggleBrowserFullscreen;

// ===== 自绘下拉（T451，2026-11-14）=====
// 原生 <select> 的弹层列表由浏览器自己渲染，不吃页面 CSS——深色主题里会弹出一层
// 系统亮色列表，跟抽屉的磨砂/胶囊语言完全是两套（2026-10-08 统计范围那次已踩过，
// 当时在 token-usage.js 单做了一份；本组件是通用版，样式见 styles.css「自绘下拉」段）。
//
// 标记契约（静态写在 index.html，不许 JS 现拼）：外层 .pm-select 带
//   id            控件 id（各 API 的第一个参数）
//   data-pm-value 当前值（字符串；单一事实源，替代原生 select.value）
//   data-pm-change 改值后要调的回调函数名（可省；以「选项值字符串」为唯一实参，
//                 与原生 onchange 读 e.target.value 同语义）
// 内部固定三层：.pm-select-btn（含 .pm-select-label 文案位 + .pm-select-caret 箭头）
// 与 .pm-select-menu > .pm-select-item[data-value]。选中态＝.pm-select-item.active
// ＋ aria-selected，展开态＝外层 .open（箭头翻转靠它）。
function _pmSelectEls(id) {
  const wrap = document.getElementById(id);
  if (!wrap) return null;
  return {
    wrap: wrap,
    btn: wrap.querySelector ? wrap.querySelector('.pm-select-btn') : null,
    label: wrap.querySelector ? wrap.querySelector('.pm-select-label') : null,
    menu: wrap.querySelector ? wrap.querySelector('.pm-select-menu') : null
  };
}

function _pmSelectItems(els) {
  if (!els || !els.menu || !els.menu.querySelectorAll) return [];
  return Array.prototype.slice.call(els.menu.querySelectorAll('.pm-select-item'));
}

function pmSelectValue(id) {
  const els = _pmSelectEls(id);
  return els ? String(els.wrap.dataset ? els.wrap.dataset.pmValue : '') : '';
}

// 收起所有（含自己）：exceptId 传自己＝「只收别人」，传 null/省略＝全收
function pmSelectCloseAll(exceptId) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  Array.prototype.slice.call(document.querySelectorAll('.pm-select')).forEach(wrap => {
    if (!wrap || wrap.id === exceptId) return;
    if (wrap.classList) wrap.classList.remove('open');
    const menu = wrap.querySelector ? wrap.querySelector('.pm-select-menu') : null;
    if (menu) menu.hidden = true;
    const btn = wrap.querySelector ? wrap.querySelector('.pm-select-btn') : null;
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
  });
}

let _pmSelectDismissBound = false;
// 点面板外 / Esc 收起。绑一次即可，逻辑上看「点在不在任意 .pm-select 里」，
// 所以在按钮上点击不会先开后立刻被收（toggle 的冒泡顺序同 token-range 先例）。
function _pmSelectBindDismiss() {
  if (_pmSelectDismissBound || typeof document === 'undefined' || !document.addEventListener) return;
  _pmSelectDismissBound = true;
  document.addEventListener('click', (e) => {
    const t = e && e.target;
    if (typeof Node !== 'undefined' && t instanceof Node && t.closest && t.closest('.pm-select')) return;
    pmSelectCloseAll(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape') pmSelectCloseAll(null);
  });
}

function pmSelectToggle(id) {
  const els = _pmSelectEls(id);
  if (!els || !els.menu) return;
  const willOpen = !!els.menu.hidden;
  _pmSelectBindDismiss();
  pmSelectCloseAll(willOpen ? id : null);
  els.menu.hidden = !willOpen;
  if (els.wrap.classList) els.wrap.classList[willOpen ? 'add' : 'remove']('open');
  if (els.btn && els.btn.setAttribute) els.btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
}

// 只改控件外观与 data-pm-value，不触发回调——服务端回读校正、只读回滚、失败还原
// 都该走这里（否则会把「校正」当成用户改值再存一次）。
function pmSelectSetValue(id, value, labelText) {
  const els = _pmSelectEls(id);
  if (!els) return;
  const v = String(value == null ? '' : value);
  if (els.wrap.dataset) els.wrap.dataset.pmValue = v;
  let matched = null;
  _pmSelectItems(els).forEach(item => {
    const on = String((item.dataset || {}).value) === v;
    if (on) matched = item;
    if (item.classList) item.classList.toggle('active', on);
    if (item.setAttribute) item.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  if (els.label) {
    // 优先用选项自身文案（单一事实源在 index.html），兜底用调用方给的 labelText，
    // 都没有就保留原样——宁可不换字，也别把值当文案印出去。
    const text = labelText != null ? String(labelText)
      : (matched && matched.textContent != null ? String(matched.textContent) : '');
    if (text) els.label.textContent = text;
  }
}

// 用户点选：先落 UI 再回调（回调里可能起网络请求；UI 不该等它）
function pmSelectPick(id, value) {
  const els = _pmSelectEls(id);
  if (!els) return;
  pmSelectSetValue(id, value);
  pmSelectCloseAll(null);
  const cb = els.wrap.dataset ? els.wrap.dataset.pmChange : '';
  if (!cb) return;
  let fn = null;
  try { if (typeof window !== 'undefined' && typeof window[cb] === 'function') fn = window[cb]; } catch (e) {}
  if (!fn) {
    try { if (typeof globalThis !== 'undefined' && typeof globalThis[cb] === 'function') fn = globalThis[cb]; } catch (e) {}
  }
  if (fn) fn(String(value));
}

window.pmSelectValue = pmSelectValue;
window.pmSelectToggle = pmSelectToggle;
window.pmSelectSetValue = pmSelectSetValue;
window.pmSelectPick = pmSelectPick;
window.pmSelectCloseAll = pmSelectCloseAll;

// ====== 主题内自绘选择器（T456，2026-11-17）======
// 与上面 pm-select 同一动机（原生弹层不吃页面 CSS），但解决的是另一类控件：
// 带 optgroup 分组、条目会动态重建、调用点已经在读 .value / 挂 onchange 的 <select>。
// 做法是不替换它，而是「包」起来——select 留在 DOM 里当数据源与事件源（.value 读写、
// onchange 全照旧，隐藏但可编程），上层只画按钮 + 菜单；菜单每次开合/同步都从
// select 的 optgroup/option 现读，所以任何「重建 options」的调用点收尾调一次
// pmPickerSync 即可，不维护第二份数据。
// 分组标题、组内去前缀、选中打勾、超长省略都由这层负责（原生 select 做不到）。

let _pmPickerDismissBound = false;

function _pmPickerWrap(selectEl) {
  if (!selectEl) return null;
  const p = selectEl.parentNode;
  return (p && p.classList && p.classList.contains('pm-picker')) ? p : null;
}

function pmPickerAttach(selectEl) {
  if (!selectEl || typeof document === 'undefined') return null;
  const existing = _pmPickerWrap(selectEl);
  if (existing) return existing;
  const parent = selectEl.parentNode;
  if (!parent) return null;
  const wrap = document.createElement('div');
  wrap.className = 'pm-picker';
  parent.insertBefore(wrap, selectEl);
  wrap.appendChild(selectEl);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'pm-picker-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="pm-picker-label"></span>'
    + '<svg class="pm-picker-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>';

  const menu = document.createElement('div');
  menu.className = 'pm-picker-menu aurora-glass aurora-glass--compact';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  wrap.appendChild(btn);
  wrap.appendChild(menu);
  btn.addEventListener('click', (e) => {
    if (e && e.stopPropagation) e.stopPropagation();
    pmPickerToggle(selectEl);
  });
  menu.addEventListener('click', (e) => {
    const item = (e && e.target && e.target.closest) ? e.target.closest('.pm-picker-item') : null;
    if (!item) return;
    pmPickerPick(selectEl, item.dataset ? item.dataset.value : '');
  });
  // 只有在包装成功后 r 才隐藏原生控件：万一这层脚本挂了，原生下拉仍在
  wrap.classList.add('is-enhanced');
  _pmPickerBindDismiss();
  return wrap;
}

function pmPickerCloseAll(exceptWrap) {
  if (typeof document === 'undefined' || !document.querySelectorAll) return;
  Array.prototype.slice.call(document.querySelectorAll('.pm-picker.open')).forEach(wrap => {
    if (wrap === exceptWrap) return;
    wrap.classList.remove('open');
    const menu = wrap.querySelector ? wrap.querySelector('.pm-picker-menu') : null;
    if (menu) menu.hidden = true;
    const btn = wrap.querySelector ? wrap.querySelector('.pm-picker-btn') : null;
    if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', 'false');
  });
}

// 点面板外 / Esc 收起；绑一次即可（判断「点在不在任意 .pm-picker 里」）
function _pmPickerBindDismiss() {
  if (_pmPickerDismissBound || typeof document === 'undefined' || !document.addEventListener) return;
  _pmPickerDismissBound = true;
  document.addEventListener('click', (e) => {
    const t = e && e.target;
    if (typeof Node !== 'undefined' && t instanceof Node && t.closest && t.closest('.pm-picker')) return;
    pmPickerCloseAll(null);
  });
  document.addEventListener('keydown', (e) => {
    if (e && e.key === 'Escape') pmPickerCloseAll(null);
  });
}

function pmPickerToggle(selectEl) {
  const wrap = _pmPickerWrap(selectEl);
  if (!wrap) return;
  const menu = wrap.querySelector ? wrap.querySelector('.pm-picker-menu') : null;
  const btn = wrap.querySelector ? wrap.querySelector('.pm-picker-btn') : null;
  if (!menu) return;
  const willOpen = !!menu.hidden;
  pmPickerCloseAll(willOpen ? wrap : null);
  menu.hidden = !willOpen;
  if (wrap.classList) wrap.classList[willOpen ? 'add' : 'remove']('open');
  if (btn && btn.setAttribute) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  if (!willOpen) return;
  pmPickerSync(selectEl);
  // 打开时把当前选中项滚进可视区（长列表里别让人自己找）
  const active = menu.querySelector ? menu.querySelector('.pm-picker-item.active') : null;
  if (active && active.scrollIntoView) {
    try { active.scrollIntoView({ block: 'nearest' }); } catch (e) {}
  }
}

// 从 select 的 optgroup/option 现读重画菜单与按钮文案；
// option 的 data-label 优先（去掉「供应商 · 」前缀的纯模型名），没有就退回 option 文本
function pmPickerSync(selectEl) {
  const wrap = _pmPickerWrap(selectEl);
  if (!wrap || typeof escapeHtml !== 'function') return;
  const menu = wrap.querySelector ? wrap.querySelector('.pm-picker-menu') : null;
  const labelEl = wrap.querySelector ? wrap.querySelector('.pm-picker-label') : null;
  if (!menu) return;
  const current = String(selectEl.value == null ? '' : selectEl.value);
  const html = [];
  let currentText = '';
  const nodes = Array.prototype.slice.call(selectEl.children || []);
  const pushItem = (opt) => {
    const value = String(opt.value == null ? '' : opt.value);
    const text = (opt.dataset && opt.dataset.label) ? opt.dataset.label : (opt.textContent || '');
    const full = opt.textContent || text;
    const on = value === current;
    if (on) currentText = text;
    html.push('<button type="button" class="pm-picker-item' + (on ? ' active' : '')
      + '" role="option" aria-selected="' + (on ? 'true' : 'false')
      + '" data-value="' + escapeHtml(value) + '"'
      + (full && full !== text ? ' title="' + escapeHtml(full) + '"' : '') + '>'
      + '<span class="pm-picker-item-label">' + escapeHtml(text) + '</span>'
      + '<svg class="pm-picker-check" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
      + '</button>');
  };
  nodes.forEach(node => {
    if (!node) return;
    if (node.tagName === 'OPTGROUP') {
      const groupLabel = node.getAttribute ? (node.getAttribute('label') || '') : '';
      if (groupLabel) html.push('<div class="pm-picker-group">' + escapeHtml(groupLabel) + '</div>');
      Array.prototype.slice.call(node.children || []).forEach(pushItem);
      return;
    }
    if (node.tagName === 'OPTION') pushItem(node);
  });
  menu.innerHTML = html.join('');
  if (labelEl) {
    let text = currentText;
    if (!text && selectEl.selectedIndex >= 0 && selectEl.options && selectEl.options[selectEl.selectedIndex]) {
      const sel = selectEl.options[selectEl.selectedIndex];
      text = (sel.dataset && sel.dataset.label) ? sel.dataset.label : (sel.textContent || '');
    }
    labelEl.textContent = text || '';
    if (labelEl.classList) labelEl.classList.toggle('is-empty', !current);
  }
}

// 用户点选：先落 select.value，再派发 change（原生 onchange / 监听器全照旧走一次）
function pmPickerPick(selectEl, value) {
  const wrap = _pmPickerWrap(selectEl);
  if (!wrap) return;
  const v = String(value == null ? '' : value);
  pmPickerCloseAll(null);
  if (selectEl.value === v) return;
  selectEl.value = v;
  pmPickerSync(selectEl);
  try {
    selectEl.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (e) {
    if (typeof selectEl.onchange === 'function') selectEl.onchange();
  }
}

window.pmPickerAttach = pmPickerAttach;
window.pmPickerSync = pmPickerSync;
window.pmPickerToggle = pmPickerToggle;
window.pmPickerPick = pmPickerPick;
window.pmPickerCloseAll = pmPickerCloseAll;
