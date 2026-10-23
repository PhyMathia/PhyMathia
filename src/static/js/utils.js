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
// **只合并了 _edgeKey，没合并 _graphState**：那两份不是重复实现——graph.js 在
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

// 公式：与后端 _normalize_formula 一致（\$→$、去首尾 $、统一包 $..$，清洗 \= 等无效命令）
function _normalizeFormulaLatex(latex) {
  let s = String(latex || '').trim();
  s = s.replace(/\\\$/g, '$').trim();
  s = s.replace(/^\$+|\$+$/g, '').trim();
  s = s.replace(/\\([=,;:])/g, '$1');
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
