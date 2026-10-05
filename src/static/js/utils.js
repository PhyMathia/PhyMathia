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
  const sessionPart = (typeof currentSessionId !== 'undefined' ? currentSessionId : 'sess').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  return 'br_' + (sessionPart || 'sess') + '_' + crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// 公式：KaTeX renderToString 不识别 $ 定界符，渲染前剥离
function _stripFormulaDelimiters(latex) {
  return String(latex || '').replace(/^\$+|\$+$/g, '').trim();
}

// 公式：与后端 _looks_like_formula 一致（排除单字符/纯短字母/纯命令/纯 \text{}/单位斜杠）
function _looksLikeFormula(latex) {
  const s = String(latex || '').trim();
  if (!s) return false;
  if (s.length === 1) return false;                        // 单字符：m、k
  if (/^[A-Za-z]{1,3}$/.test(s)) return false;             // 纯短字母：rad、Hz
  if (/^\\[A-Za-z]+$/.test(s)) return false;               // 纯符号命令：\omega
  if (/^\\text\{[^{}]*\}$/.test(s)) return false;          // 纯 \text{...}：\text{rad/s}
  if (/^[A-Za-z]{1,4}(\/[A-Za-z]{1,4})+$/.test(s)) return false; // 单位：rad/s、m/s
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
