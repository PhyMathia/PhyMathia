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
function noteFileName(sessionTitle, dateStr, ext) {
  const safe = String(sessionTitle == null ? '' : sessionTitle).replace(/[\\/:*?"<>|\r\n]/g, '_').trim();
  return safe
    ? 'PhyMathia笔记-' + safe + '-' + dateStr + '.' + ext
    : 'PhyMathia笔记-' + dateStr + '.' + ext;
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
    toastMsg('本会话暂无知识条目可导出（条目由 AI 回答自动提取）');
    return;
  }
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const timeStr = dateStr + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  let text;
  if (kind === 'html') {
    try {
      const res = await fetch('/vendor/katex/katex.min.css');
      if (!res.ok) throw new Error('katex.min.css ' + res.status);
      text = noteHtmlDocument(items, sessionTitle, dateStr, timeStr, await _inlineKatexCss(await res.text()));
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
