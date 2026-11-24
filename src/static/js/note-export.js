// ===== 学习笔记导出（顶栏「知识」菜单 → 导出笔记 · HTML / Markdown） =====
// 把当前会话的知识条目（标题＋摘要＋公式）蒸馏成一份笔记文件下载。不变量：
// - HTML 版必须单文件离线可看：KaTeX 样式文本 fetch 进来内联，字体 url 只保留
//   woff2 源并转 data URL（woff/ttf 只是回退源，现代浏览器全支持 woff2，全留着
//   体积翻三倍）；成品文档不出现任何 http(s):// 与非 data: 的 url(。
// - 两版正文同构（h1 标题＋生成元信息＋每概念一节），不带提问清单、画布截图等附录。
// - 正文/文件名全部由纯函数生成，日期时间一律走参数注入（冒烟沙箱里可确定断言），
//   真正取系统时间的只有入口 exportSessionNote 一处。
// - 公式取自 item.formulas，存的是带 $...$ 定界符的原文，渲染/包 $$ 前必须先
//   _stripFormulaDelimiters 剥掉（utils.js 口径，与知识面板渲染一致）。
// 文件后半（2026-11-24）是会话历史导出，不变量见该段头注释；两个导出共用样式内联与下载。

// 本会话知识条目过滤：sessionIds 数组（新口径，条目可能跨会话复用）或 legacy
// 单值 sessionId 命中即算本会话的；摘要与公式全空的壳条目跳过（AI 回答中途打断
// 会留下只有标题的残条，导出它们只会产出空节）。按 createdAt 升序＝探索顺序，
// 缺时间戳当 0；Array#sort 在现代引擎稳定，同刻不换位。
function filterSessionKnowledgeItems(map, sid) {
  if (!map || typeof map !== 'object' || !sid) return [];
  const out = [];
  for (const item of Object.values(map)) {
    if (!item) continue;
    const hit = (Array.isArray(item.sessionIds) && item.sessionIds.includes(sid)) || item.sessionId === sid;
    if (!hit) continue;
    const hasBody = String(item.summary || '').trim() || (Array.isArray(item.formulas) && item.formulas.length);
    if (!hasBody) continue;
    out.push(item);
  }
  out.sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
  return out;
}

// 下载文件名：会话名清洗掉 Windows/常见文件系统保留字符（\ / : * ? " < > | 与换行）
// 后拼在中间；清洗 trim 后为空（无标题会话）则整段省略，得到 PhyMathia笔记-2026-10-06.md 形态。
// prefix 是「PhyMathia笔记」／「PhyMathia会话历史」，两个导出共用这一套清洗。
function noteFileName(sessionTitle, dateStr, ext) {
  return _exportFileName('PhyMathia笔记', sessionTitle, dateStr, ext);
}

function _exportFileName(prefix, sessionTitle, dateStr, ext) {
  const safe = String(sessionTitle == null ? '' : sessionTitle).replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
  return safe
    ? prefix + '-' + safe + '-' + dateStr + '.' + ext
    : prefix + '-' + dateStr + '.' + ext;
}

// 概念标题防逃逸：开头的连续 # 剥掉（防止「#1 定律」这类标题在 md 里冒充层级、
// 在 html 里虽无害但两版口径要一致），剥空回退占位名。
function _noteTitle(title) {
  const t = String(title == null ? '' : title).replace(/^#+\s*/, '').trim();
  return t || '未命名概念';
}

// 条目公式清单：剥 $ 定界符 → 剥后为空跳过 → 按剥后文本条目内去重
// （同一条目里摘要重复收集同一公式是常态），返回可直接渲染的 latex 数组。
function _noteItemFormulas(item) {
  const seen = new Set();
  const out = [];
  for (const f of (item && Array.isArray(item.formulas) ? item.formulas : [])) {
    const latex = _stripFormulaDelimiters(f);
    if (!latex || seen.has(latex)) continue;
    seen.add(latex);
    out.push(latex);
  }
  return out;
}

// Markdown 版正文。dateStr 仅为与 noteHtmlDocument 调用点签名对齐而保留，
// md 头部元信息只用 timeStr（含日期）；结构：# 标题 / > 元信息 / 每概念一节
// （## 标题＋摘要＋每条公式一个 $$ 块），节间空行分隔。
function noteMarkdown(items, sessionTitle, dateStr, timeStr) {
  const list = Array.isArray(items) ? items : [];
  const name = String(sessionTitle == null ? '' : sessionTitle).trim() || '未命名会话';
  const lines = [
    '# PhyMathia 学习笔记 · ' + name,
    '> ' + timeStr + ' 生成 · 共 ' + list.length + ' 个概念',
  ];
  for (const item of list) {
    lines.push('', '## ' + _noteTitle(item && item.title), '');
    const summary = String((item && item.summary) || '').trim();
    if (summary) lines.push(summary);
    for (const latex of _noteItemFormulas(item)) {
      lines.push('', '$$', latex, '$$');
    }
  }
  return lines.join('\n') + '\n';
}

// 公式渲染：页面环境有 KaTeX 就 renderToString 成品（displayMode：笔记公式独立
// 成块），渲染抛错或无 KaTeX 环境（如冒烟沙箱）降级为转义后的 <code>——保证
// 任何环境都有确定产物，绝不因渲染失败丢公式。
function noteFormulaHtml(latex) {
  if (typeof katex !== 'undefined' && katex && typeof katex.renderToString === 'function') {
    try {
      return katex.renderToString(latex, { throwOnError: false, displayMode: true });
    } catch (e) { /* 落到降级分支 */ }
  }
  return '<code class="note-tex">' + escapeHtml(latex) + '</code>';
}

// 笔记自身样式（约 60 行，浅底暖纸感、正文 780px 居中、公式块可横向滚动）。
// 不变量：这里不得出现任何 url( —— 单文件契约要求成品里唯一的 url 是
// katexCss 参数带来的 data: 字体。
const _NOTE_EXPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #f6f4ee;
  color: #2c2a26;
  font-family: "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
  line-height: 1.75;
}
main.note {
  max-width: 780px;
  margin: 0 auto;
  padding: 48px 28px 32px;
}
.note h1 {
  margin: 0 0 10px;
  font-size: 26px;
  letter-spacing: 0.5px;
}
.note-meta {
  margin: 0 0 40px;
  color: #8b8577;
  font-size: 13px;
}
.note-item { margin: 0 0 42px; }
.note-item h2 {
  margin: 0 0 12px;
  padding-bottom: 6px;
  font-size: 19px;
  border-bottom: 1px solid #ddd5c4;
}
.note-summary p { margin: 0 0 10px; }
.note-formula {
  margin: 14px 0;
  padding: 12px 10px;
  text-align: center;
  overflow-x: auto;
  background: #fffdf7;
  border-radius: 8px;
}
code.note-tex {
  font-family: Consolas, "Courier New", monospace;
  font-size: 14px;
  padding: 2px 6px;
  border-radius: 4px;
  background: #efebe0;
}
.note-footer {
  margin-top: 48px;
  text-align: center;
  color: #a39d8e;
  font-size: 12px;
}
@media print {
  body { background: #fff; }
  main.note { max-width: none; padding: 0; }
  .note-item { break-inside: avoid; }
  .note-formula { break-inside: avoid; }
  @page { margin: 18mm 16mm; }
}
`;

// HTML 版整档：单文件、零 JS、零外部引用。katexCss 参数必须已是内联版
// （_inlineKatexCss 的产物，字体为 data URL）——本函数只负责拼装不做网络请求。
// 摘要按 \n 切多段 <p>；公式走 noteFormulaHtml；一切用户文本经 escapeHtml。
function noteHtmlDocument(items, sessionTitle, dateStr, timeStr, katexCss) {
  const list = Array.isArray(items) ? items : [];
  const name = String(sessionTitle == null ? '' : sessionTitle).trim() || '未命名会话';
  const title = 'PhyMathia 学习笔记 · ' + name;
  const sections = [];
  for (const item of list) {
    const summary = String((item && item.summary) || '').trim();
    const paras = summary
      ? summary.split('\n').map((p) => p.trim()).filter(Boolean).map((p) => '<p>' + escapeHtml(p) + '</p>').join('')
      : '';
    const formulas = _noteItemFormulas(item)
      .map((latex) => '<div class="note-formula">' + noteFormulaHtml(latex) + '</div>')
      .join('\n      ');
    sections.push(
      '    <section class="note-item">\n' +
      '      <h2>' + escapeHtml(_noteTitle(item && item.title)) + '</h2>\n' +
      (paras ? '      <div class="note-summary">' + paras + '</div>\n' : '') +
      (formulas ? '      ' + formulas + '\n' : '') +
      '    </section>'
    );
  }
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>' + escapeHtml(title) + '</title>\n' +
    '  <style>\n' +
    '/* KaTeX 样式（已内联，字体为 data URL，单文件离线可看） */\n' +
    String(katexCss || '') + '\n' +
    '/* 笔记样式 */\n' +
    _NOTE_EXPORT_CSS +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <main class="note">\n' +
    '    <h1>' + escapeHtml(title) + '</h1>\n' +
    '    <p class="note-meta">' + escapeHtml(timeStr) + ' 生成 · 共 ' + list.length + ' 个概念</p>\n' +
    sections.join('\n') + '\n' +
    '    <footer class="note-footer">由 PhyMathia 导出 · ' + escapeHtml(dateStr) + '</footer>\n' +
    '  </main>\n' +
    '</body>\n' +
    '</html>\n';
}

// 字体 url 解析：绝对 url（http(s)/协议相对/根相对/data:）原样；相对 url
// （katex.min.css 里的 fonts/xxx.woff2）按**样式表位置** /vendor/katex/ 为基
// 解析——CSS 相对 url 的标准语义是对样式表解析而非对页面，字体不在站点根上。
function _katexFontAbsUrl(u) {
  const raw = String(u || '').trim().replace(/^["']|["']$/g, '');
  if (!raw || raw.startsWith('data:') || /^(https?:)?\/\//.test(raw) || raw.startsWith('/')) return raw;
  return new URL(raw, new URL('vendor/katex/katex.min.css', location.href)).href;
}

// blob → base64 data URL（FileReader 口径，与浏览器原生 readAsDataURL 一致）
function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('字体文件读取失败'));
    reader.readAsDataURL(blob);
  });
}

// 把 katex.min.css 文本内联成单文件版：只处理 @font-face 块的 src 声明，
// 候选源里丢掉非 woff2（回退源只是体积），保留的 woff2 url 换成 fetch →
// blob → data URL。同一字体文件只取一次（按原始 url 记忆 Promise）。
// 无 woff2 候选的脸族原样保留（vendored KaTeX css 每个脸族都有 woff2，走不到）。
async function _inlineKatexCss(cssText) {
  const text = String(cssText || '');
  if (!text) return '';
  const cache = new Map();
  const fontDataUrl = (u) => {
    if (cache.has(u)) return cache.get(u);
    const p = fetch(_katexFontAbsUrl(u))
      .then((r) => {
        if (!r.ok) throw new Error('KaTeX 字体读取失败：' + u);
        return r.blob();
      })
      .then(_blobToDataUrl);
    cache.set(u, p);
    return p;
  };
  let out = text;
  for (const block of text.match(/@font-face\s*\{[^}]*\}/g) || []) {
    const m = block.match(/src:([^;}]+)/);
    if (!m) continue;
    const kept = [];
    for (const part of m[1].split(',')) {
      if (!/woff2/i.test(part)) continue;
      const um = part.match(/url\(([^)]+)\)/);
      if (!um) continue;
      kept.push('url(' + await fontDataUrl(um[1]) + ') format("woff2")');
    }
    if (!kept.length) continue;
    // replace 用函数形式：替换串里是 base64/CSS，避免 $& 等模式字符被误解释
    const newBlock = block.replace(m[1], () => kept.join(','));
    out = out.replace(block, () => newBlock);
  }
  return out;
}

// 落盘：与 knowledge.js 的 _kpDownloadTextFile 同款（Blob → a[download] →
// click → revoke）——那是其模块内私有 helper 不跨模块可见，本地留一份同款。
function _noteDownloadTextFile(text, filename, mime) {
  const blob = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// 入口：知识菜单「导出笔记 · HTML / Markdown」。空会话（0 条可用条目）只 toast
// 不下载；HTML 版在此 fetch 并内联 KaTeX 样式（md 版零网络请求）。
async function exportSessionNote(format) {
  const kind = format === 'md' ? 'md' : 'html';
  const sid = (typeof window.getCurrentSessionId === 'function' && window.getCurrentSessionId()) || '';
  const session = sid && typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
  const sessionTitle = (session && session.title) || '';
  // 导出前先走知识面板同款快速刷新（服务端并集合并＋排空待保存队列）：刚提取
  // 还没落盘的条目、跨会话同概念在服务端合并出的 sessionIds 都能补进本次导出。
  // 刷新失败不阻断——离线时退回 localStorage 口径（每次回答都即时写入，不空）。
  if (typeof _quickRefreshKnowledge === 'function') {
    try { await _quickRefreshKnowledge(); } catch (e) { /* 退回本地口径 */ }
  }
  const items = filterSessionKnowledgeItems(getKnowledgeItems(), sid);
  if (!items.length) {
    toastMsg('本会话暂无知识条目可导出（条目由每轮回答自动提取）');
    return;
  }
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const timeStr = dateStr + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  let text;
  if (kind === 'html') {
    try {
      text = noteHtmlDocument(items, sessionTitle, dateStr, timeStr, await _inlinedKatexCss());
    } catch (e) {
      toastMsg('导出失败：无法读取本地 KaTeX 样式');
      return;
    }
  } else {
    text = noteMarkdown(items, sessionTitle, dateStr, timeStr);
  }
  _noteDownloadTextFile(text, noteFileName(sessionTitle, dateStr, kind), kind === 'md' ? 'text/markdown' : 'text/html');
  toastMsg('笔记已导出（' + items.length + ' 个概念）', TOAST_MS_LONG);
}
window.exportSessionNote = exportSessionNote;

// 取 KaTeX 样式表的「可内联版」：文本 fetch 进来、字体换成 data URL（笔记导出与会话
// 历史导出共用）。失败抛错，由调用方决定提示语。
async function _inlinedKatexCss() {
  const res = await fetch('/vendor/katex/katex.min.css');
  if (!res.ok) throw new Error('katex.min.css ' + res.status);
  return _inlineKatexCss(await res.text());
}

// ===== 会话历史导出（2026-11-24，backlog 575；知识菜单 → 导出会话历史 · HTML / Markdown） =====
// 把当前会话的提问、回答、画布节点与支线对话按时间排成一份可读文件下载。不变量：
// - 当场按内存态生成：节点取 _graphState().customNodes、消息取 _getChatHistory()，导出的
//   就是此刻的画布（含还没落盘的修改）。服务端 data/history/ 的自动归档只在消息保存链
//   重写、会滞后——要「现在」的可读副本走这里；别给归档加改画布触发（2026-11-24 拍板）。
// - 正文口径与归档一字对齐（storage.py 的 _history_text／_HISTORY_KIND_LABEL／
//   _archive_entries）：改一侧必须同步改另一侧，冒烟与单测钉同一组夹具。差别只有一处：
//   导出不截断（用户主动要的完整记录；归档 8000 字上限是为了「翻得动」）。
// - 网页版沿用上面学习笔记的单文件契约：零 JS、零外部引用。正文走页面自己的
//   renderMarkdown（marked＋DOMPurify），公式在页面里 katex.renderToString 预排好再写进
//   文件；会自动联网的 img／媒体／style url( 一律摘掉（外链图片换成链接）。成品允许
//   <a href>——点了才走，不算自动联网。
// - 正文全是纯函数；读内存态只有 _historyCollect，取系统时间只有入口 exportSessionHistory。

// 节点类型 → 时间线上的叫法。名字跟画布叫法走（GRAPH_NODE_ATTRIBUTES／graph-recipes.js）；
// 存量 7 个不改名——既有归档已用它。
const _HISTORY_KIND_LABEL = {
  user: '我', human_note: '我的笔记', module: '模块', direct: 'AI',
  source: '素材', answer: '回答', analysis: '分析',
  note: '我的总结', summary: 'AI 总结', relation: '联系', blank: 'AI 生成空白',
  hub: '汇聚', junction: '中转', ai_eval: 'AI 评价', draft: '草稿',
  manual: '我的回答', question: '问题', followup: '追问', recipe: '配方',
  viz: '交互可视化', image: '图片', mermaid: '图表', html_iframe: '网页',
};
const _HISTORY_ROLE_LABEL = { user: '我', assistant: 'AI', system: '系统' };
// 「问题分析」卡正文在 node.analysis 不在 node.content（graph-render.js 同口径）
const _HISTORY_ANALYSIS_HEAD = '问题分析';
const _HISTORY_ITEM_KIND_LABEL = { image: '图片', text: '文本', file: '文件' };
const _HISTORY_HTML_RE = /^\s*(```html|<!DOCTYPE\s+html|<html[\s>])/i;
// 正文规范化（口径对齐 renderMarkdown：思考块／结构标签不显示给用户）
const _HISTORY_THINK_RE = /<(think|thinking|reasoning|thought)>[\s\S]*?<\/\s*\1\s*>/gi;
const _HISTORY_THINK_OPEN_RE = /<(think|thinking|reasoning|thought)>/i;
const _HISTORY_SOCRATIC_META_RE = /<socratic_meta\b[^>]*>[\s\S]*?<\/socratic_meta>|<socratic_meta\b[^>]*\/?>/gi;
const _HISTORY_SUMMARY_RE = /<summary>[\s\S]*?<\/summary>/gi;
const _HISTORY_VIZ_SECTION_RE = /<viz\b[^>]*>([\s\S]*?)<\/viz\s*>/gi;
const _HISTORY_HTML_FENCE_RE = /```html\s*\n([\s\S]*?)```/gi;
// 完整网页才算可视化（renderMarkdown 转可视化卡的同一道闸：太短的片段保留为代码块）
const _HISTORY_PAGE_RE = /<!doctype|<html[\s>]|<body[\s>]/i;
const _HISTORY_STRUCT_TAG_RE = /<\/?(?:physics|math|graph|extend|analysis)\b[^>]*>/gi;
// AI 把 <formula> 包在 $$..$$ 里的双层定界
const _HISTORY_FORMULA_WRAPPED_RE = /\${1,2}\s*<formula>([\s\S]*?)<\/formula>\s*\${1,2}/gi;
const _HISTORY_FORMULA_RE = /<formula>([\s\S]*?)<\/formula>/gi;
const _HISTORY_FORMULA_OPEN_RE = /<formula>(?![\s\S]*<\/formula>)/i;

function historyKindLabel(kind) {
  const k = String(kind || '');
  return Object.prototype.hasOwnProperty.call(_HISTORY_KIND_LABEL, k) ? _HISTORY_KIND_LABEL[k] : (k || '节点');
}

function _historyVizNote(code) {
  return '（交互可视化，' + String(code.length).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' 字代码，正文见画布）';
}

// <formula> → Markdown 数学定界符。独占一行的是 display（$$ 块），夹在句中的是 inline（$）：
// 所有阅读器都认这两种，<formula> 原样落盘只会显示成带尖括号的 LaTeX 源码。
function _historyFormulaSub(src, inner, start, end) {
  const latex = _cleanFormulaLatex(inner);
  if (!latex) return '';
  const before = src.slice(0, start);
  const after = src.slice(end);
  const lineAfter = after.slice(0, after.indexOf('\n') === -1 ? after.length : after.indexOf('\n'));
  if (before.slice(before.lastIndexOf('\n') + 1).trim() || lineAfter.trim()) {
    return '$' + latex.replace(/\s+/g, ' ') + '$';
  }
  // 独占一行：前后补足空行，display 块在严格按段落判定的阅读器里才不会粘进上一段
  const padBefore = before && !before.endsWith('\n\n') ? '\n\n' : '';
  const padAfter = after && !after.startsWith('\n\n') ? '\n\n' : '';
  return padBefore + '$$\n' + latex + '\n$$' + padAfter;
}

// 正文规范化（服务端 storage.py 的 _history_text 是同一份口径）：整条是可视化网页的只留
// 一句说明；剥思考块、socratic_meta、<summary> 与分节标签；<viz> 段和完整网页代码块换成
// 说明；<formula> 转成 $$／$。未闭合的 <formula>（流式截断）从标签起截掉。
function _historyText(text) {
  let s = String(text == null ? '' : text).trim();
  if (!s) return '';
  if (_HISTORY_HTML_RE.test(s)) return _historyVizNote(s);
  s = s.replace(_HISTORY_THINK_RE, '');
  const thinkOpen = s.match(_HISTORY_THINK_OPEN_RE);
  if (thinkOpen) s = s.slice(0, thinkOpen.index);
  s = s.replace(_HISTORY_SOCRATIC_META_RE, '').replace(_HISTORY_SUMMARY_RE, '');
  s = s.replace(_HISTORY_VIZ_SECTION_RE, (m, inner) => _historyVizNote(inner));
  s = s.replace(_HISTORY_HTML_FENCE_RE, (m, code) => (code.trim().length >= 100 && _HISTORY_PAGE_RE.test(code) ? _historyVizNote(code) : m));
  s = s.replace(_HISTORY_STRUCT_TAG_RE, '');
  s = s.replace(_HISTORY_FORMULA_WRAPPED_RE, (m, inner) => '<formula>' + inner + '</formula>');
  const unclosed = _HISTORY_FORMULA_OPEN_RE.exec(s);
  if (unclosed && (s.slice(0, unclosed.index).match(/```/g) || []).length % 2 === 0) s = s.slice(0, unclosed.index);
  const src = s;
  let cursor = 0;
  return s.replace(_HISTORY_FORMULA_RE, (m, inner) => {
    const start = src.indexOf(m, cursor);
    cursor = start + m.length;
    return _historyFormulaSub(src, inner, start, cursor);
  }).trim();
}

// 清单类节点的条目（建议追问、素材附件）压成无序列表——正文为空时才用它。
function _historyItemsText(items) {
  const lines = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const question = String(item.question || '').trim();
    const name = String(item.fileName || item.name || '').trim();
    const body = String(item.text || '').trim();
    if (question) {
      const level = String(item.levelName || '').trim();
      lines.push('- ' + (level ? '[' + level + '] ' : '') + question);
    } else if (name || body) {
      const kind = Object.prototype.hasOwnProperty.call(_HISTORY_ITEM_KIND_LABEL, item.kind) ? _HISTORY_ITEM_KIND_LABEL[item.kind] : '素材';
      lines.push('- ' + kind + '「' + name + '」' + (body ? '：' + body : ''));
    }
  }
  return lines.join('\n');
}

// 没有时间戳的排最后
function _historyTs(value) {
  if (value == null || value === '') return Infinity;
  const n = Number(value);
  return Number.isFinite(n) ? n : Infinity;
}

function _historyNorm(text) {
  return String(text || '').replace(/\s+/g, '');
}

function _historyClock(ts) {
  if (!Number.isFinite(ts)) return '';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// 消息与画布节点合成一条按时间排的条目表 [{ts, head, label, content}]。与某个节点正文
// （去空白后）完全相同的消息不重复列——节点就是它在画布上的样子。
function historyEntries(messages, nodes) {
  const entries = [];
  const nodeEntries = [];
  const nodeNorm = new Set();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const kind = String(node.kind || '');
    let head = historyKindLabel(kind);
    let content = _historyText(node.content);
    if (!content && kind === 'answer' && !node.manual) {
      content = _historyText(node.analysis);
      if (content) head = _HISTORY_ANALYSIS_HEAD;
    }
    if (!content) content = _historyText(_historyItemsText(node.items));
    const label = String(node.label || '').trim();
    if (!content && !label) continue;
    nodeNorm.add(_historyNorm(content));
    nodeEntries.push({ ts: _historyTs(node.timestamp), head: head, label: label, content: content });
  }
  for (const msg of Array.isArray(messages) ? messages : []) {
    if (!msg || typeof msg !== 'object') continue;
    const role = String(msg.role || '');
    if (role === 'system') continue;
    const content = _historyText(msg.content);
    if (!content || nodeNorm.has(_historyNorm(content))) continue;
    const head = Object.prototype.hasOwnProperty.call(_HISTORY_ROLE_LABEL, role) ? _HISTORY_ROLE_LABEL[role] : (role || '记录');
    entries.push({ ts: _historyTs(msg.timestamp), head: head, label: '', content: content });
  }
  return entries.concat(nodeEntries).sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? -1 : 1));
}

// Markdown 版正文。collected＝{entries, nodes, messages}（_historyCollect 的产物），头部
// 元信息只用注入的 timeStr，不取系统时间；结构：# 标题 / 元信息列表 / --- / 每条目一节
// （## 序号. 类型[ · 小标题][ · 时间]＋正文），节间空行分隔。正文原样、不截断。
function historyMarkdown(sessionId, sessionTitle, collected, timeStr) {
  const entries = (collected && Array.isArray(collected.entries)) ? collected.entries : [];
  const nodes = (collected && Array.isArray(collected.nodes)) ? collected.nodes : [];
  const messages = (collected && Array.isArray(collected.messages)) ? collected.messages : [];
  const clocks = entries.map((e) => _historyClock(e.ts)).filter(Boolean);
  const lines = [
    '# ' + (String(sessionTitle == null ? '' : sessionTitle).trim() || '未命名画布'), '',
    '- 会话 ID：`' + sessionId + '`',
    '- 条目：' + entries.length + ' 条（画布节点 ' + nodes.length + ' 个、聊天消息 ' + messages.length + ' 条，空条目已略）',
  ];
  if (clocks.length) lines.push('- 时间跨度：' + clocks[0] + ' → ' + clocks[clocks.length - 1]);
  lines.push('- 导出时间：' + timeStr, '', '---', '');
  entries.forEach((e, i) => {
    const label = String(e.label || '').trim();
    const clock = _historyClock(e.ts);
    let line = '## ' + (i + 1) + '. ' + e.head;
    if (label && label !== e.head) line += ' · ' + label;
    if (clock) line += ' · ' + clock;
    lines.push(line, '');
    if (e.content) lines.push(e.content, '');
  });
  return lines.join('\n').replace(/\s+$/, '') + '\n';
}

// renderMarkdown 的产物里公式是 <span class="math-raw" data-mmode="…">原文</span>（原文经
// escapeHtml）。导出文件没有脚本、auto-render 跑不了——这里逐个换成 KaTeX 预排结果；
// 没有 KaTeX 或公式本身坏了，退成转义后的 <code>（宁丑不丢）。
function _historyUnescape(text) {
  return String(text || '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function _historyMathHtml(html) {
  return String(html || '').replace(/<span class="math-raw" data-mmode="(display|inline)">([\s\S]*?)<\/span>/g, (m, mode, escaped) => {
    const latex = _stripMathBlockDelimiters(_historyUnescape(escaped));
    if (!latex || /^\$+$/.test(latex)) return '';
    if (typeof katex !== 'undefined' && katex && typeof katex.renderToString === 'function') {
      try {
        const out = katex.renderToString(latex, { throwOnError: true, displayMode: mode === 'display' });
        if (typeof out === 'string') return out;
      } catch (e) { /* 落到降级分支 */ }
    }
    return '<code class="note-tex">' + escapeHtml(latex) + '</code>';
  });
}

const _HISTORY_MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/g;

// 一条正文 → 零脚本 HTML：mermaid 围栏先摘出来（renderMarkdown 会把它换成要靠页面脚本
// 才画得出的容器），其余走 renderMarkdown，再把公式预排、mermaid 以源码块放回。摘联网
// 资源在整档函数里对成品收口（historyTameHtml）。没有 Markdown 渲染环境（或渲染抛错）
// 退成转义原文，宁丑不丢。
function historyBodyHtml(text) {
  const src = String(text == null ? '' : text);
  const mermaid = [];
  const body = src.replace(_HISTORY_MERMAID_FENCE_RE, (m, code) => {
    mermaid.push(String(code || '').trim());
    return '\n\nHISTORYMERMAIDPH' + (mermaid.length - 1) + 'END\n\n';
  });
  let html = '';
  try {
    if (typeof renderMarkdown === 'function') html = renderMarkdown(body);
  } catch (e) { html = ''; }
  if (typeof html !== 'string' || !html.trim()) {
    return '<pre class="history-raw">' + escapeHtml(src) + '</pre>';
  }
  const putMermaid = (idx) => '<pre class="history-mermaid"><code>' + escapeHtml(mermaid[Number(idx)] || '') + '</code></pre>';
  return _historyMathHtml(html)
    .replace(/<p>\s*HISTORYMERMAIDPH(\d+)END\s*<\/p>/g, (m, idx) => putMermaid(idx))
    .replace(/HISTORYMERMAIDPH(\d+)END/g, (m, idx) => putMermaid(idx));
}

// 单文件契约的收口（纯字符串，整档函数对每条正文恰好过一次——标题降级不幂等，别过两遍）：
// 摘掉会自动联网的资源——媒体标签整只删、外链图片换成链接（data: 的留着）、内联 style 里的
// url( 去掉；正文标题整体降两级（条目头是 h2，正文标题从 h3 起才不乱大纲）。
function historyTameHtml(html) {
  let out = String(html || '');
  out = out.replace(/<\/?(?:video|audio|source|track|picture|iframe|object|embed)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '');
  out = out.replace(/<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    const src = (tag.match(/\bsrc\s*=\s*"([^"]*)"/i) || tag.match(/\bsrc\s*=\s*'([^']*)'/i) || [])[1] || '';
    const noSrcset = tag.replace(/\ssrcset\s*=\s*"[^"]*"/i, '');
    if (!src || /^data:/i.test(src)) return noSrcset;
    // 属性值在净化后的 HTML 里是实体编码的：先解码再转义，免得说明文字双重转义
    const alt = (tag.match(/\balt\s*=\s*"([^"]*)"/i) || [])[1] || '';
    return '<a href="' + src + '" target="_blank" rel="noopener">' + escapeHtml(_historyUnescape(alt ? '图片：' + alt : src)) + '</a>';
  });
  out = out.replace(/\sstyle\s*=\s*"[^"]*url\([^"]*"/gi, '');
  return out.replace(/<(\/?)h([1-6])(?=[\s>])/g, (m, slash, level) => '<' + slash + 'h' + Math.min(6, Number(level) + 2));
}

// 会话历史样式：接在笔记样式后面（同一个 main.note 版心），只补条目头、类型徽标与
// Markdown 正文的排版。同样不得出现任何 url(（单文件契约）。
const _HISTORY_EXPORT_CSS = `
.note-item h2 .history-kind {
  display: inline-block;
  margin-right: 10px;
  padding: 1px 9px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: #fffdf7;
  background: #8a7f66;
  vertical-align: 2px;
}
.note-item h2 .history-time {
  margin-left: 10px;
  font-size: 13px;
  font-weight: 400;
  color: #a39d8e;
}
.note-body {
  font-size: 15.5px;
}
.note-body p, .note-body li {
  overflow-wrap: anywhere;
}
.note-body > :first-child { margin-top: 0; }
.note-body > :last-child { margin-bottom: 0; }
.note-body p { margin: 0 0 12px; }
.note-body h3, .note-body h4, .note-body h5, .note-body h6 {
  margin: 22px 0 10px;
  font-size: 17px;
}
.note-body h4, .note-body h5, .note-body h6 { font-size: 15.5px; }
.note-body ul, .note-body ol { margin: 0 0 12px; padding-left: 24px; }
.note-body li { margin: 3px 0; }
.note-body blockquote {
  margin: 0 0 12px;
  padding: 6px 14px;
  border-left: 3px solid #ddd5c4;
  color: #6b6558;
  background: #fbf9f3;
}
.note-body pre, pre.history-raw, pre.history-mermaid {
  margin: 0 0 12px;
  padding: 12px 14px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.55;
  background: #f1ede3;
  border-radius: 8px;
}
.note-body :not(pre) > code {
  padding: 2px 6px;
  border-radius: 4px;
  background: #efebe0;
  font-size: 0.9em;
}
.note-body img { max-width: 100%; }
.note-body table {
  display: block;
  margin: 0 0 12px;
  overflow-x: auto;
  border-collapse: collapse;
}
.note-body th, .note-body td {
  padding: 6px 10px;
  border: 1px solid #ddd5c4;
}
.note-body th { background: #fbf9f3; }
.note-body a { color: #7a5c1e; }
.note-body hr {
  margin: 18px 0;
  border: 0;
  border-top: 1px solid #ddd5c4;
}
.note-body .katex-display {
  margin: 14px 0;
  overflow-x: auto;
  overflow-y: hidden;
}
@media print {
  .history-item { break-inside: auto; }
  .note-body pre, pre.history-raw, pre.history-mermaid { white-space: pre-wrap; }
}
`;

// HTML 版整档：单文件、零 JS、零外部引用（契约同 noteHtmlDocument）。katexCss 必须已是
// 内联版；renderBody 把一条正文转成 HTML，缺省 historyBodyHtml（纯函数用例可注入）。
// 每条正文过一遍 historyTameHtml 收口单文件契约；一切用户文本经 escapeHtml；
// 条目头＝类型徽标＋小标题＋时间。
function historyHtmlDocument(sessionTitle, collected, timeStr, dateStr, katexCss, renderBody) {
  const entries = (collected && Array.isArray(collected.entries)) ? collected.entries : [];
  const render = typeof renderBody === 'function' ? renderBody : historyBodyHtml;
  const name = String(sessionTitle == null ? '' : sessionTitle).trim() || '未命名会话';
  const title = 'PhyMathia 会话历史 · ' + name;
  const clocks = entries.map((e) => _historyClock(e.ts)).filter(Boolean);
  const span = clocks.length ? ' · ' + clocks[0] + ' → ' + clocks[clocks.length - 1] : '';
  const sections = entries.map((e) => {
    const label = String(e.label || '').trim();
    const clock = _historyClock(e.ts);
    return '    <section class="note-item history-item">\n' +
      '      <h2><span class="history-kind">' + escapeHtml(e.head) + '</span>' + escapeHtml(label) +
      (clock ? '<span class="history-time">' + clock + '</span>' : '') + '</h2>\n' +
      '      <div class="note-body">\n      ' + historyTameHtml(render(e.content)) + '\n      </div>\n' +
      '    </section>';
  });
  return '<!DOCTYPE html>\n' +
    '<html lang="zh-CN">\n' +
    '<head>\n' +
    '  <meta charset="utf-8">\n' +
    '  <meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '  <title>' + escapeHtml(title) + '</title>\n' +
    '  <style>\n' +
    '/* KaTeX 样式（已内联，字体为 data URL，单文件离线可看） */\n' +
    String(katexCss || '') + '\n' +
    '/* 笔记样式 */\n' +
    _NOTE_EXPORT_CSS +
    '/* 会话历史样式 */\n' +
    _HISTORY_EXPORT_CSS +
    '  </style>\n' +
    '</head>\n' +
    '<body>\n' +
    '  <main class="note">\n' +
    '    <h1>' + escapeHtml(title) + '</h1>\n' +
    '    <p class="note-meta">' + escapeHtml(timeStr + ' 导出 · 共 ' + entries.length + ' 条' + span) + '</p>\n' +
    sections.join('\n') + '\n' +
    '    <footer class="note-footer">由 PhyMathia 导出 · ' + escapeHtml(dateStr) + '</footer>\n' +
    '  </main>\n' +
    '</body>\n' +
    '</html>\n';
}

function historyFileName(sessionTitle, dateStr, ext) {
  return _exportFileName('PhyMathia会话历史', sessionTitle, dateStr, ext);
}

// 取材（唯一读内存态的地方）：节点取当前图状态的自建节点（内存态＝此刻的画布，含还没
// 落盘的修改），消息取当前会话聊天流（支线对话；主流程的提问与回答都在节点里）。
function _historyCollect() {
  let nodes = [];
  try {
    const st = (typeof _graphState === 'function' ? _graphState() : null) || {};
    nodes = Array.isArray(st.customNodes) ? st.customNodes : [];
  } catch (e) { nodes = []; }
  let messages = [];
  try {
    messages = (typeof _getChatHistory === 'function' ? _getChatHistory() : []) || [];
  } catch (e) { messages = []; }
  return { entries: historyEntries(messages, nodes), nodes: nodes, messages: messages };
}

// 入口：知识菜单「导出会话历史 · HTML / Markdown」。空会话只 toast 不下载；HTML 版在此
// fetch 并内联 KaTeX 样式（md 版零网络请求）。
async function exportSessionHistory(format) {
  const kind = format === 'md' ? 'md' : 'html';
  const sid = (typeof window.getCurrentSessionId === 'function' && window.getCurrentSessionId()) || '';
  const session = sid && typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
  const sessionTitle = (session && session.title) || '';
  const collected = _historyCollect();
  if (!collected.entries.length) {
    toastMsg('本会话还没有可导出的内容');
    return;
  }
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const timeStr = dateStr + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  let text;
  if (kind === 'html') {
    try {
      text = historyHtmlDocument(sessionTitle, collected, timeStr, dateStr, await _inlinedKatexCss());
    } catch (e) {
      toastMsg('导出失败：无法读取本地 KaTeX 样式');
      return;
    }
  } else {
    text = historyMarkdown(sid, sessionTitle, collected, timeStr);
  }
  _noteDownloadTextFile(text, historyFileName(sessionTitle, dateStr, kind), kind === 'md' ? 'text/markdown' : 'text/html');
  toastMsg('会话历史已导出（' + collected.entries.length + ' 条）', TOAST_MS_LONG);
}
window.exportSessionHistory = exportSessionHistory;
