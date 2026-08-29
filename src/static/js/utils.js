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

// 探索网分支 ID
function _genBranchId() {
  const sessionPart = (typeof currentSessionId !== 'undefined' ? currentSessionId : 'sess').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 18);
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
