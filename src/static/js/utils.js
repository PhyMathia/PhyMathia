// ===== PhyMathia 共享工具函数（避免多文件重复定义）=====

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
// 后端 harness 已剥离，这里做前端兜底（主聊天/旧缓存响应仍可能含思考文本）。
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
        showToast('浏览器本地空间已满：记录已完整保存在电脑存档中，仅本机快速加载暂不可用', 'error');
      } else {
        console.warn('[storage] localStorage 写入失败（配额满？）：', key);
      }
    }
    return false;
  }
}
window.safeLocalStorageSet = safeLocalStorageSet;
