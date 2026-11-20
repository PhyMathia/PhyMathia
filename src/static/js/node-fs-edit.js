// ===== 节点全屏渲染态直接编辑（2026-11-18）=====
// 用户要的是「像 Word 一样在渲染状态下改」：点头部「✎ 编辑」进入，正文直接打字/删除，
// 点「保存」把编辑后的 DOM 重新拼成 Markdown 原文写回，点「取消」丢弃。写回走划词
// 加粗同一条链路（_nodeFsBoldWrite：撤销记账／customNodes·harnessNodeOverrides 双轨／
// 读回自检回滚／renderGraphCanvas 同步／落盘）。
// 与加粗的根本区别：加粗是「在原文里定位一小段插 **」，需要字符级偏移映射；整篇编辑
// 不需要定位——退出时从 DOM 单向遍历重新生成全文。原文在编辑期间全程不动，DOM 就是
// 活编辑面（打字/删除/中文输入法/Ctrl+Z 全是浏览器原生行为，无逐键重渲染、无光标跳动）。
// 口径（2026-11-18 用户拍板，2026-11-20 补全）：本页全屏层（11-18）＋新窗口预览页
// （11-20，见文件尾「新窗口渲染态编辑」节——预览窗是哑编辑面，序列化/自检/写回全在
// 主应用，action:'edit' 过桥）；画布卡片不做。显式按钮切换；公式/mermaid/viz 是原子块
// （contenteditable=false：进不去、删就整删，TeX/源码从 annotation 与 data-mermaid-src、
// _vizStore 还原——与加粗的拒绝口径一脉相承）。
// 加载期零副作用（只挂 Esc capture 一个监听）；画布函数运行期 typeof 守卫调用。

let _nodeFsEditSession = null;

// ---------- 资格 ----------

// 与划词加粗同闸（只读／双轨目标／围栏模块都拒绝），额外排除 blank：blank 全屏显示的
// 是剥 XML 分节后的文本，整篇写回会把清洗文本存成 content 丢掉分节结构——加粗的小拼接
// 可以接受（2026-11-17 拍板），整篇重写不行
function _nodeFsEditAvailable(node) {
  if (!node) return false;
  if (node.kind === 'blank') return false;
  if (typeof _nodeFsBoldAvailable !== 'function' || !_nodeFsBoldAvailable(node)) return false;
  return true;
}

function _nodeFsEditActive() {
  return !!_nodeFsEditSession;
}

// ---------- DOM → Markdown 序列化 ----------
// 只遍历、不定位：块级元素按 tag 拼语法，行内元素包定界符，原子块从自身属性还原源码。

// KaTeX → $tex$ / $$tex$$。display 判定与 _nodeFsKatexFragmentText 同口径
// （类名／祖先 .katex-display／MathML <math display="block"> 三认——半截扩整条的
// 克隆片段里没有祖先，只能靠 MathML 认，2026-10-31 T420 实锤）
function _nodeFsEditKatexMd(k) {
  const tex = typeof _nodeFsKatexTex === 'function' ? String(_nodeFsKatexTex(k) || '') : String((k && k.textContent) || '');
  if (!tex) return String((k && k.textContent) || '');
  const display = (k.classList && k.classList.contains('katex-display'))
    || !!(k.closest && k.closest('.katex-display'))
    || !!(k.querySelector && k.querySelector('math[display="block"]'));
  return (display ? '$$' : '$') + tex + (display ? '$$' : '$');
}

// 行内序列化：文本原样、强调包定界、链接/图片保属性、<br> 是 GFM 硬断行
// （marked 默认 breaks:false，单 \n 渲染回软换行会变空格，硬断行必须双空格收尾）
function _nodeFsEditInline(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.nodeValue || '');
  if (node.nodeType !== 1) return '';
  if (node.classList && (node.classList.contains('katex') || node.classList.contains('katex-display'))) {
    return _nodeFsEditKatexMd(node);
  }
  const tag = String(node.tagName || '').toUpperCase();
  if (tag === 'BR') return '  \n';
  if (tag === 'INPUT' || tag === 'SVG' || tag === 'BUTTON') return ''; // UI 件不进正文（勾选框由 li 分支认）
  const inner = _nodeFsEditInlineChildren(node);
  if (tag === 'STRONG' || tag === 'B') return inner ? '**' + inner + '**' : '';
  if (tag === 'EM' || tag === 'I') return inner ? '*' + inner + '*' : '';
  if (tag === 'DEL' || tag === 'S') return inner ? '~~' + inner + '~~' : '';
  if (tag === 'CODE') {
    const t = String(node.textContent || '');
    if (!t) return '';
    // 内容自带反引号时换双反引号围（与 CommonMark 行内代码串同口径）
    return (t.indexOf('`') >= 0 ? '`` ' + t + ' ``' : '`' + t + '`');
  }
  if (tag === 'A') {
    const href = node.getAttribute ? String(node.getAttribute('href') || '') : '';
    return '[' + inner + '](' + href + ')';
  }
  if (tag === 'IMG') {
    const alt = node.getAttribute ? String(node.getAttribute('alt') || '') : '';
    const src = node.getAttribute ? String(node.getAttribute('src') || '') : '';
    return '![' + alt + '](' + src + ')';
  }
  return inner; // P/SPAN/未知元素：拆壳取内容
}

function _nodeFsEditInlineChildren(node) {
  let out = '';
  const kids = (node && node.childNodes) || [];
  for (let i = 0; i < kids.length; i++) out += _nodeFsEditInline(kids[i]);
  return out;
}

// mermaid 原码：渲染管线把源码挂在 pre.mermaid-source 的 data-mermaid-src
// （encodeURIComponent(escapeHtml(源码))——render.js 构造时先转实体再编码，数学比较符
// &gt; 这类实体在 mermaid 里会呛 KaTeX，2026-10-01 实锤），还原时反向两步。
function _nodeFsEditMermaidMd(el) {
  const srcEl = el && el.querySelector ? el.querySelector('.mermaid-source') : null;
  let code = '';
  try {
    code = srcEl ? decodeURIComponent(String(srcEl.getAttribute('data-mermaid-src') || '')) : '';
  } catch (e) { code = ''; }
  if (!code) return '';
  if (typeof _unescapeHtmlEntities === 'function') {
    try { code = _unescapeHtmlEntities(code); } catch (e) { /* 保持原样 */ }
  }
  return '```mermaid\n' + code.replace(/\n+$/, '') + '\n```';
}

// viz 源码：卡片 id 就是 _vizStore 的键。_vizStore 里存的是「净化原码＋桥接脚本」的
// 成品 iframe 源（公式/主题/检查三座桥由 buildVizCard 注入），写回原文必须剥掉桥——
// 不然保存的源码里长出桥接脚本，下次渲染再注入一遍就是双重桥。
function _nodeFsEditVizMd(el) {
  const id = el && el.id;
  let html = (typeof _vizStore !== 'undefined' && id && _vizStore[id]) || '';
  if (!html) return '';
  // 桥接常量是 render.js 顶层 const（词法全局，不在 window 上），直接按名引用；
  // 沙箱/降级环境下 typeof 兜底跳过
  const strip = (v) => { if (typeof v === 'string' && v) html = html.split(v).join(''); };
  try {
    if (typeof _VIZ_MATH_BRIDGE === 'string') strip(_VIZ_MATH_BRIDGE);
    if (typeof _VIZ_THEME_BRIDGE === 'string') strip(_VIZ_THEME_BRIDGE);
    if (typeof _VIZ_CHECK_BRIDGE === 'string') strip(_VIZ_CHECK_BRIDGE);
  } catch (e) { /* 认不出桥就整段原样 */ }
  return html.trim() ? '```html\n' + html.replace(/\n+$/, '') + '\n```' : '';
}

// 代码块：语言从 code 的 language-* 类认；内容取 textContent（首尾各去一个换行，
// 围栏自带的换行不回写）
function _nodeFsEditCodeMd(el) {
  const codeEl = el && el.querySelector ? el.querySelector('code') : null;
  let lang = '';
  const m = /language-([\w#+-]+)/.exec(String((codeEl && codeEl.className) || ''));
  if (m) lang = m[1];
  const text = String(((codeEl || el) && (codeEl || el).textContent) || '').replace(/^\n/, '').replace(/\n$/, '');
  return '```' + lang + '\n' + text + '\n```';
}

function _nodeFsEditTableAlign(el) {
  const style = el && el.getAttribute ? String(el.getAttribute('style') || '') : '';
  const m = /text-align\s*:\s*(center|right|left)/i.exec(style);
  return m ? m[1].toLowerCase() : '';
}

// 管道表：首行（thead 的 tr，没有 thead 就第一行）当表头，对齐从 th 的 style 认
function _nodeFsEditTableMd(el) {
  const rows = [];
  const headAligns = [];
  const kids = (el && el.childNodes) || [];
  for (let i = 0; i < kids.length; i++) {
    const seg = kids[i];
    if (!seg || seg.nodeType !== 1) continue;
    const segTag = String(seg.tagName || '').toUpperCase();
    if (segTag !== 'THEAD' && segTag !== 'TBODY' && segTag !== 'TR') continue;
    const trs = segTag === 'TR' ? [seg] : Array.prototype.filter.call(seg.childNodes || [], c => c && c.nodeType === 1 && String(c.tagName || '').toUpperCase() === 'TR');
    for (let r = 0; r < trs.length; r++) {
      const isHeadRow = segTag === 'THEAD' || (segTag !== 'TBODY' && rows.length === 0);
      const cells = [];
      const trKids = (trs[r].childNodes || []);
      for (let c = 0; c < trKids.length; c++) {
        const td = trKids[c];
        if (!td || td.nodeType !== 1) continue;
        const tdTag = String(td.tagName || '').toUpperCase();
        if (tdTag !== 'TD' && tdTag !== 'TH') continue;
        cells.push(_nodeFsEditInlineChildren(td).replace(/\s*\n\s*/g, ' ').trim());
        if (isHeadRow) headAligns.push(_nodeFsEditTableAlign(td));
      }
      if (cells.length) rows.push(cells);
    }
  }
  if (!rows.length) return '';
  const width = Math.max.apply(null, rows.map(r => r.length));
  const pad = (row) => { while (row.length < width) row.push(''); return row; };
  const sep = [];
  for (let i = 0; i < width; i++) {
    const a = headAligns[i] || '';
    sep.push(a === 'center' ? ':---:' : (a === 'right' ? '---:' : '---'));
  }
  const lines = [pad(rows[0]).map(c => c).join(' | ')];
  lines[0] = '| ' + lines[0] + ' |';
  lines.push('| ' + sep.join(' | ') + ' |');
  for (let r = 1; r < rows.length; r++) lines.push('| ' + pad(rows[r]).join(' | ') + ' |');
  return lines.join('\n');
}

// 列表：li 内容拼一行（嵌套 UL/OL 拆出去按层级缩进，缩进量对齐标记宽——CommonMark
// 要求续行/子级缩到内容列，`1. ` 三字符就缩三格）
function _nodeFsEditListMd(el) {
  const ordered = String((el && el.tagName) || '').toUpperCase() === 'OL';
  let idx = 1;
  const startAttr = el && el.getAttribute ? parseInt(el.getAttribute('start') || '1', 10) : 1;
  if (Number.isFinite(startAttr) && startAttr > 0) idx = startAttr;
  const lines = [];
  const kids = (el && el.childNodes) || [];
  for (let i = 0; i < kids.length; i++) {
    const li = kids[i];
    if (!li || li.nodeType !== 1 || String(li.tagName || '').toUpperCase() !== 'LI') continue;
    const parts = [];
    const nested = [];
    let task = '';
    const liKids = (li.childNodes || []);
    for (let j = 0; j < liKids.length; j++) {
      const c = liKids[j];
      if (c && c.nodeType === 1) {
        const t = String(c.tagName || '').toUpperCase();
        if (t === 'UL' || t === 'OL') { nested.push(c); continue; }
        if (t === 'INPUT') {
          const isBox = (c.getAttribute && c.getAttribute('type')) === 'checkbox';
          if (isBox) task = (c.checked === true || (c.getAttribute && c.getAttribute('checked') != null)) ? '[x] ' : '[ ] ';
          continue;
        }
      }
      parts.push(_nodeFsEditInline(c));
    }
    const marker = (ordered ? idx + '. ' : '- ') + task;
    idx++;
    const content = parts.join('').replace(/^\s+/, '').replace(/\s+$/, '');
    const itemLines = [marker + content];
    const pad = ' '.repeat(marker.length);
    for (let n = 0; n < nested.length; n++) {
      const nl = _nodeFsEditListMd(nested[n]).split('\n');
      for (let l = 0; l < nl.length; l++) itemLines.push(pad + nl[l]);
    }
    for (let l = 0; l < itemLines.length; l++) lines.push(itemLines[l]);
  }
  return lines.join('\n');
}

// 单个块级元素 → markdown
function _nodeFsEditBlockMd(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.classList && el.classList.contains('mermaid-container')) return _nodeFsEditMermaidMd(el);
  if (el.classList && el.classList.contains('viz-card')) return _nodeFsEditVizMd(el);
  const tag = String(el.tagName || '').toUpperCase();
  if (/^H[1-6]$/.test(tag)) {
    const inner = _nodeFsEditInlineChildren(el).replace(/\s+$/, '');
    return inner ? '#'.repeat(parseInt(tag.charAt(1), 10)) + ' ' + inner : '';
  }
  if (tag === 'P' || tag === 'DIV') return _nodeFsEditFlowMd(el);
  if (tag === 'UL' || tag === 'OL') return _nodeFsEditListMd(el);
  if (tag === 'BLOCKQUOTE') {
    const inner = _nodeFsEditFlowMd(el);
    if (!inner) return '';
    // 内层若是嵌套引用（已带 '> '），外层只加一格前缀，避免出现 '> > '
    return inner.split('\n').map(l => (l.indexOf('> ') === 0 ? '>' + l : '> ' + l)).join('\n');
  }
  if (tag === 'PRE') return _nodeFsEditCodeMd(el);
  if (tag === 'TABLE') return _nodeFsEditTableMd(el);
  if (tag === 'HR') return '---';
  return _nodeFsEditInlineChildren(el);
}

const NODE_FS_EDIT_BLOCK_TAGS = /^P$|^DIV$|^H[1-6]$|^UL$|^OL$|^BLOCKQUOTE$|^PRE$|^TABLE$|^HR$/;

// 容器的子节点流 → markdown：块级展开、行内攒段、空段丢弃，块间空行分隔
function _nodeFsEditFlowMd(container) {
  const out = [];
  let buf = [];
  const flush = () => {
    const t = buf.join('').replace(/^\s+/, '').replace(/\s+$/, '');
    if (t) out.push(t);
    buf = [];
  };
  const kids = (container && container.childNodes) || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    const isBlock = c && c.nodeType === 1
      && (NODE_FS_EDIT_BLOCK_TAGS.test(String(c.tagName || '').toUpperCase())
        || (c.classList && (c.classList.contains('mermaid-container') || c.classList.contains('viz-card'))));
    if (!isBlock) { buf.push(_nodeFsEditInline(c)); continue; }
    flush();
    const md = _nodeFsEditBlockMd(c);
    if (md) out.push(md);
  }
  flush();
  return out.join('\n\n');
}

// 入口＝整篇序列化
function _nodeFsSerializeContent(root) {
  return _nodeFsEditFlowMd(root);
}

// ---------- 落盘前的两道自检 ----------

// ①入场往返校验：入场前先拿「当前 DOM 拼回的 markdown」与原文各过一遍 renderMarkdown，
// 块级签名逐点比对——序列化器不认识的构造当场现形，宁可不让进编辑，不许「改完存出来
// 缺一块」。渲染器缺席（沙箱/降级）返回 ''＝放行（宁宽进严出：保存侧还有可见文本自检）
function _nodeFsEditSigNorm(text) {
  return String(text || '').replace(/\s+/g, ' ').replace(/\${1,2}/g, '$').trim();
}

function _nodeFsEditSigWalk(el) {
  const out = [];
  const walk = (node) => {
    const kids = (node && node.childNodes) || [];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === 3) {
        const t = _nodeFsEditSigNorm(c.nodeValue);
        if (t) out.push('#' + t);
        continue;
      }
      if (c.nodeType !== 1) continue;
      const cls = c.classList || { contains: () => false };
      if (cls.contains('mermaid-container')) {
        const srcEl = c.querySelector ? c.querySelector('.mermaid-source') : null;
        out.push('MERMAID|' + (srcEl ? String(srcEl.getAttribute('data-mermaid-src') || '') : ''));
        continue;
      }
      if (cls.contains('viz-card')) {
        const v = (typeof _vizStore !== 'undefined' && c.id && _vizStore[c.id]) || '';
        out.push('VIZ|' + String(v).length);
        continue;
      }
      if (cls.contains('katex') || cls.contains('katex-display')) {
        const tex = typeof _nodeFsKatexTex === 'function' ? (_nodeFsKatexTex(c) || '') : '';
        out.push('K|' + _nodeFsEditSigNorm(tex || c.textContent));
        continue;
      }
      out.push(String(c.tagName || '?').toUpperCase());
      walk(c);
    }
  };
  walk(el);
  return out.join('\u0001');
}

function _nodeFsEditSignature(src) {
  let html = '';
  try { html = renderMarkdown(String(src || ''), {}); } catch (e) { return null; }
  if (!html) return null;
  const holder = document.createElement('div');
  holder.innerHTML = html;
  return _nodeFsEditSigWalk(holder);
}

function _nodeFsEditRoundTripDiff(src, domMd) {
  if (typeof renderMarkdown !== 'function') return '';
  const a = _nodeFsEditSignature(src);
  const b = _nodeFsEditSignature(domMd);
  if (a === null || b === null) return '';
  return a === b ? '' : 'round-trip';
}

// ②保存可见文本自检：防序列化静默丢块。两边都取「渲染后的可见文字」再按加粗那套
// 同管归一比对——左边＝拼回的 markdown 重渲一遍（renderMath 落定后折公式），右边＝
// 编辑后 DOM 克隆（同管处理）。md 语法记号（#/-/>/表格管道）只活在左边原文里，拿原文
// 直接撞 DOM 纯文本会把含结构的保存整批拒掉（真机实锤 2026-11-20：本页全屏与新窗口
// 同病，标题/列表/引用/公式一进自检就「有内容没能对上」）；KaTeX 不折的话 MathML×2＋
// 视觉层三份文本也永远对不上。原子块（mermaid/viz/pre/img）文本两边同摘、家数单独
// 比对——序列化把整块弄丢时家数先现形。渲染器缺席放行（宁宽进严出，同入场口径）。
// 不一致就拒存、留在编辑态自己改
function _nodeFsEditAtomicCounts(el) {
  const c = (sel) => { try { return el.querySelectorAll(sel).length; } catch (e) { return 0; } };
  return [c('.mermaid-container'), c('.viz-card'), c('pre'), c('img')].join('/');
}

// 右侧/左侧共用的取文管：整树克隆由调用方负责（本函数吃克隆，绝不碰活 DOM）——
// 折公式成 $tex$/$$tex$$，摘掉 mermaid/viz/pre/img/svg/input/button 的渲染字形，取 textContent
function _nodeFsEditFoldVisible(clone) {
  if (typeof _nodeFsKatexFragmentText === 'function') _nodeFsKatexFragmentText(clone, true);
  const nodes = clone.querySelectorAll('.mermaid-container, .viz-card, pre, img, input, svg, button');
  for (let i = nodes.length - 1; i >= 0; i--) {
    try { if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]); } catch (e) { /* 沙箱兜底 */ }
  }
  return String(clone.textContent || '');
}

function _nodeFsEditVisibleFacts(container) {
  if (!container || typeof container.cloneNode !== 'function' || typeof _nodeFsKatexFragmentText !== 'function') return null;
  let clone = null;
  try { clone = container.cloneNode(true); } catch (e) { return null; }
  let text = '';
  try { text = _nodeFsEditFoldVisible(clone); } catch (e) { text = ''; }
  return { text, counts: _nodeFsEditAtomicCounts(clone) };
}

function _nodeFsEditVisibleMismatch(next, domContainer) {
  if (typeof _nodeFsBoldScan !== 'function' || typeof renderMarkdown !== 'function' || typeof renderMath !== 'function') return false;
  let left = null;
  try {
    const holder = document.createElement('div');
    holder.innerHTML = renderMarkdown(String(next || ''), {});
    try { renderMath(holder); } catch (e0) { /* 公式折不动：放行，宁宽进严出 */ }
    left = _nodeFsEditVisibleFacts(holder);
  } catch (e) { return false; }
  const right = _nodeFsEditVisibleFacts(domContainer);
  if (!left || !right) return false;
  return left.counts !== right.counts
    || _nodeFsBoldScan(left.text).text !== _nodeFsBoldScan(right.text).text;
}

// ---------- 编辑会话 ----------

function _nodeFsEditToast(msg) {
  if (typeof showToast === 'function') showToast(msg);
}

function openNodeFsEdit(nodeId) {
  if (_nodeFsEditSession) return; // 已在编辑：不叠会话
  const overlay = document.querySelector('.graph-node-fs-overlay');
  const container = overlay && overlay.querySelector ? overlay.querySelector('.graph-node-fs-content') : null;
  if (!overlay || !container) { _nodeFsEditToast('请先打开节点全屏再编辑'); return; }
  const node = typeof _findGraphNode === 'function' ? _findGraphNode(nodeId) : null;
  if (!node) { _nodeFsEditToast('源节点已不在画布上'); return; }
  if (!_nodeFsEditAvailable(node)) { _nodeFsEditToast('这个节点不支持渲染态编辑'); return; }
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const src = typeof _nodeFsSourceText === 'function' ? String(_nodeFsSourceText(node, message) || '') : '';
  if (!src.trim()) return;
  // 入场往返校验：序列化器对这篇内容必须能原样拼回，才放行进入编辑
  const domNow = _nodeFsSerializeContent(container);
  if (_nodeFsEditRoundTripDiff(src, domNow)) {
    _nodeFsEditToast('这种内容暂时不支持渲染态编辑（有不认识的写法）');
    return;
  }
  const scroller = overlay.querySelector ? overlay.querySelector('.graph-node-fs-body') : null;
  const body = overlay.querySelector ? overlay.querySelector('.graph-node-fs-body') : null;
  const actions = overlay.querySelector ? overlay.querySelector('.graph-node-fs-head-actions') : null;
  const session = { nodeId: node.id, overlay, container, scroller, origSrc: src, dirty: false, handlers: [], headHtml: null };
  // 正文开编辑
  container.setAttribute('contenteditable', 'true');
  container.setAttribute('data-editing', '1');
  // 原子块：公式/图/代码/图片进不去（删就整删，与加粗拒绝口径一致）
  const atomSel = '.katex, .katex-display, .mermaid-container, .viz-card, pre, img, input';
  if (container.querySelectorAll) {
    const atoms = container.querySelectorAll(atomSel);
    for (let i = 0; i < atoms.length; i++) {
      try { atoms[i].setAttribute('contenteditable', 'false'); } catch (e) { /* 沙箱兜底 */ }
    }
  }
  // 一行 hint（硬规则 9 口径：这是什么＋一句怎么用）
  if (body && typeof document.createElement === 'function') {
    try {
      const hint = document.createElement('div');
      hint.className = 'graph-node-fs-edit-hint';
      hint.textContent = '直接改正文，公式与图整块保留；改完点「保存」写回节点';
      body.insertBefore(hint, container);
    } catch (e) { /* 沙箱无真 DOM：没有 hint 不挡编辑 */ }
  }
  // 头部换成保存/取消（其余动作收起，编辑期间不误触）
  if (actions) {
    session.headHtml = actions.innerHTML;
    actions.innerHTML = '<button type="button" class="graph-node-fs-edit-btn" onclick="saveNodeFsEdit()" title="保存并写回节点">✓ 保存</button>'
      + '<button type="button" class="graph-node-fs-edit-btn" onclick="cancelNodeFsEdit()" title="放弃这次改动">× 取消</button>';
  }
  // 会话监听：dirty 标记 / 粘贴只收纯文本 / 编辑态点链接只放光标不跳转
  const onInput = () => { session.dirty = true; };
  const onPaste = (ev) => {
    let text = '';
    try { text = ev.clipboardData ? String(ev.clipboardData.getData('text/plain') || '') : ''; } catch (e) { text = ''; }
    if (ev && ev.preventDefault) ev.preventDefault();
    if (!text) return;
    try {
      if (document.execCommand) document.execCommand('insertText', false, text);
      else throw new Error('no execCommand');
    } catch (e) {
      try {
        const sel = window.getSelection ? window.getSelection() : null;
        if (sel && sel.rangeCount) {
          const r = sel.getRangeAt(0);
          r.deleteContents();
          r.insertNode(document.createTextNode(text));
          r.collapse(false);
        }
      } catch (e2) { /* 真插不进去就丢这一下，用户重试 */ }
    }
    session.dirty = true;
  };
  const onClick = (ev) => {
    const a = ev && ev.target && ev.target.closest ? ev.target.closest('a') : null;
    if (a && container.contains(a) && ev && ev.preventDefault) ev.preventDefault();
  };
  try { container.addEventListener('input', onInput); session.handlers.push([container, 'input', onInput]); } catch (e) {}
  try { container.addEventListener('paste', onPaste); session.handlers.push([container, 'paste', onPaste]); } catch (e) {}
  try { container.addEventListener('click', onClick); session.handlers.push([container, 'click', onClick]); } catch (e) {}
  _nodeFsEditSession = session;
  try { container.focus(); } catch (e) { /* 聚焦失败不挡编辑 */ }
}

// 退出会话：收监听/摘标记/还原头部/去 hint，并按当前原文重渲正文（保存与取消两路
// 都从这里走——保存时原文已被写回，取消时原文没动过，取材口径天然一致）。
// 滚动位置留住：重渲前后都是同一篇内容，阅读位置不该被甩回顶部
function _nodeFsEditExit(reRender) {
  const session = _nodeFsEditSession;
  if (!session) return;
  _nodeFsEditSession = null;
  const hs = session.handlers || [];
  for (let i = 0; i < hs.length; i++) {
    try { hs[i][0].removeEventListener(hs[i][1], hs[i][2]); } catch (e) { /* 沙箱兜底 */ }
  }
  const container = session.container;
  try { container.removeAttribute('contenteditable'); container.removeAttribute('data-editing'); } catch (e) {}
  try {
    const hint = session.overlay && session.overlay.querySelector ? session.overlay.querySelector('.graph-node-fs-edit-hint') : null;
    if (hint) hint.remove();
  } catch (e) {}
  try {
    const actions = session.overlay && session.overlay.querySelector ? session.overlay.querySelector('.graph-node-fs-head-actions') : null;
    if (actions && session.headHtml != null) actions.innerHTML = session.headHtml;
  } catch (e) {}
  if (!reRender || typeof _findGraphNode !== 'function') return;
  const node = _findGraphNode(session.nodeId);
  if (!node) return;
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const src = typeof _nodeFsSourceText === 'function' ? String(_nodeFsSourceText(node, message) || '') : session.origSrc;
  const keep = session.scroller ? session.scroller.scrollTop : 0;
  try {
    container.innerHTML = typeof _nodeFsRenderedHtml === 'function'
      ? _nodeFsRenderedHtml(src, { parentId: String((message && message.timestamp) || node.timestamp || ''), sourceModule: node.moduleKey || '' })
      : '';
  } catch (e) { /* 渲染器缺席：正文保持编辑后的 DOM */ }
  // 字数/时长跟着正文走（头部那枚 meta 是开屏时按当时的原文算的）
  try {
    const meta = session.overlay.querySelector('.graph-node-fs-meta');
    if (meta && typeof _nodeFsReadingMeta === 'function') meta.textContent = _nodeFsReadingMeta(src);
  } catch (e) { /* 沙箱兜底 */ }
  if (session.scroller) { try { session.scroller.scrollTop = keep; } catch (e) {} }
  if (typeof _renderNotebookRich === 'function') { try { _renderNotebookRich(container); } catch (e) {} }
}

function saveNodeFsEdit() {
  const session = _nodeFsEditSession;
  if (!session) return;
  const node = typeof _findGraphNode === 'function' ? _findGraphNode(session.nodeId) : null;
  if (!node) { _nodeFsEditToast('源节点已不在画布上'); _nodeFsEditExit(false); return; }
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const next = _nodeFsSerializeContent(session.container);
  if (!String(next || '').trim()) { _nodeFsEditToast('正文全空就不保存了——要删节点请在画布上操作'); return; }
  // 可见文本自检：拼回的 markdown 重渲与编辑后 DOM 同形才放行（防静默丢块）
  if (_nodeFsEditVisibleMismatch(next, session.container)) {
    _nodeFsEditToast('这次改动保存不了：有内容没能对上，检查刚改的部分');
    return;
  }
  const result = (typeof _nodeFsBoldWrite === 'function')
    ? _nodeFsBoldWrite(node, message, next, { summary: '渲染态编辑', okMessage: '已保存，并写回节点', verb: '编辑' })
    : { ok: false, message: '写回链路不可用' };
  if (!result || !result.ok) { _nodeFsEditToast((result && result.message) || '保存失败'); return; }
  // 人工定稿（T355 口径）：亲手改过正文＝全部开始不再收编这颗节点；只对自有节点生效
  //（函数内部自带 messageIndex 守卫），覆盖轨道的重生成行为与划词加粗一致
  if (typeof _markNodeHumanFinalized === 'function') {
    try { _markNodeHumanFinalized(node); } catch (e) { /* 标记失败不挡保存 */ }
  }
  if (typeof _saveCustomNodes === 'function') { try { _saveCustomNodes(); } catch (e) { /* 落盘失败不挡保存 */ } }
  _nodeFsEditExit(true);
  _nodeFsEditToast(result.message || '已保存，并写回节点');
}

function cancelNodeFsEdit() {
  if (!_nodeFsEditSession) return;
  _nodeFsEditExit(true);
  _nodeFsEditToast('已取消编辑，改动已还原');
}

// 关闭全屏的守卫（graph-custom.closeNodeFullscreen 开头调用）：编辑中且有未保存改动
// → 拦下并指路；干净 → 顺手收会话放行
function _nodeFsEditCloseGuard() {
  const session = _nodeFsEditSession;
  if (!session) return false;
  if (!session.dirty) { _nodeFsEditExit(true); return false; }
  _nodeFsEditToast('有未保存的修改——点「保存」写回或「取消」放弃');
  return true;
}

// Esc capture（与浮条同口径：先收编辑、ui.js 的「Esc 关全屏」这轮不触发）：
// 有改动先拦下指路，干净则退出编辑、全屏留着（第二次 Esc 才是关全屏）
document.addEventListener('keydown', (ev) => {
  if (!ev || ev.key !== 'Escape' || !_nodeFsEditSession) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  if (_nodeFsEditSession.dirty) { _nodeFsEditToast('有未保存的修改——点「保存」写回或「取消」放弃'); return; }
  _nodeFsEditExit(true);
  _nodeFsEditToast('已退出编辑');
}, true);

// ---------- 新窗口渲染态编辑（2026-11-20，2026-11-18 三拍的第三块）----------
// 预览页只有快照 DOM（无渲染器、无主应用函数），分工与全屏层不同：预览窗＝哑编辑面
// （contenteditable＋原子块＋纯文本粘贴＋Esc 守卫，全在 node-fs-toolbar.js 的内嵌脚本里），
// 这里＝全部脑子。交接面：预览页把编辑后的容器 innerHTML 过桥（action:'edit'），本端
// 解析成离散 DOM 后走全屏保存同款四步（空检查→可见文本自检→_nodeFsBoldWrite→人工
// 定稿＋落盘）；成功后 ack 带回成品 HTML（_nodeFsEditRenderFresh 离屏重渲），预览页
// 直接换上＝所见即所存，预览页零渲染逻辑的红线不破。
// 校验段刻意做成同步函数（冒烟只写同步用例的域约束）：异步的只有成品重渲，由接收端
// （node-fs-toolbar.js _nodeFsPreviewAction）在 ok 时另调。

// 开窗时对原文打的指纹（djb2＋长度）：整篇写回没有加粗那套「在现原文里定位」的
// 自校准，开窗后原文若被更新过（重新生成／另一处已保存），旧窗整篇覆盖会静默冲掉
// 新内容——签名对不上就拒绝，让用户关窗重开。
function _nodeFsEditSrcSig(src) {
  const s = String(src || '');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((((h << 5) + h) + s.charCodeAt(i)) >>> 0);
  return h.toString(36) + '_' + s.length.toString(36);
}

// 桥来的 HTML 只在主应用解析一次、只读不回注（序列化器与自检全部只读遍历）。
// 收口成独立函数：真浏览器真解析，冒烟换桩给假根（域文件只写同步用例、无 HTML 解析器）
function _nodeFsEditParseProbe(html) {
  const probe = document.createElement('div');
  probe.innerHTML = String(html || '');
  return probe;
}

// 预览页整篇写回上限：innerHTML 带 KaTeX 渲染产物，比 markdown 肥一个量级——
// 截断＝静默损坏，这里不截、超限直接拒（正常节点远够不着；file:// 场景无桥本就不给编辑）
const NODE_FS_EDIT_HTML_MAX = 2000000;

// 桥上保存（同步段）：资格闸重查（开窗后可能进了查阅/生成）→ 开窗后原文指纹对账 →
// 全屏层同节点编辑冲突拒 → 序列化 → 空检查 → 可见文本自检 → _nodeFsBoldWrite →
// 人工定稿＋自有节点落盘 → 全屏层开着同一节点就重渲。与 saveNodeFsEdit 同一把尺，
// 仅差「DOM 来自桥上解析」与指纹对账两处。
function _nodeFsEditFromBridge(node, html, srcSig, probeRoot) {
  if (typeof _nodeFsBoldWrite !== 'function' || typeof _nodeFsSerializeContent !== 'function') {
    return { ok: false, message: '写回链路不可用' };
  }
  if (!_nodeFsEditAvailable(node)) return { ok: false, message: '这个节点不支持渲染态编辑' };
  if (String(html || '').length > NODE_FS_EDIT_HTML_MAX) return { ok: false, message: '内容过大，保存不了' };
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  // 开窗后原文被更新过（重新生成／另一处已保存）：旧窗整篇覆盖＝冲掉新内容，拒绝
  const srcNow = typeof _nodeFsSourceText === 'function' ? String(_nodeFsSourceText(node, message) || '') : '';
  if (!srcSig || String(srcSig) !== _nodeFsEditSrcSig(srcNow)) {
    return { ok: false, message: '节点内容在开窗后有更新，请关掉这个窗口重新打开再编辑' };
  }
  // 本页全屏层正在编辑同一节点：桥上写回会让那边基于旧 DOM 的保存把这次改动整篇冲掉
  if (_nodeFsEditSession && String(_nodeFsEditSession.nodeId || '') === String(node.id)) {
    return { ok: false, message: '本页全屏层正在编辑这个节点：先在那边保存或取消' };
  }
  const probe = probeRoot || _nodeFsEditParseProbe(html);
  const next = _nodeFsSerializeContent(probe);
  if (!String(next || '').trim()) return { ok: false, message: '正文全空就不保存了——要删节点请在画布上操作' };
  // 可见文本自检与全屏保存同一把尺（序列化器不认识桥来的构造时在这里现形）
  if (_nodeFsEditVisibleMismatch(next, probe)) {
    return { ok: false, message: '这次改动保存不了：有内容没能对上，检查刚改的部分' };
  }
  const result = _nodeFsBoldWrite(node, message, next, { summary: '渲染态编辑（新窗口）', okMessage: '已保存，并写回节点', verb: '编辑' });
  if (!result || !result.ok) return { ok: false, message: (result && result.message) || '保存失败' };
  // 人工定稿（T355 口径）＋自有节点落盘——与全屏保存同款双守卫
  if (typeof _markNodeHumanFinalized === 'function') { try { _markNodeHumanFinalized(node); } catch (e) { /* 标记失败不挡保存 */ } }
  if (typeof _saveCustomNodes === 'function') { try { _saveCustomNodes(); } catch (e) { /* 落盘失败不挡保存 */ } }
  _nodeFsEditRefreshOverlayBody(node.id);
  return { ok: true, message: result.message || '已保存，并写回节点', src: next };
}

// 成品重渲（ok 后给 ack 用）：离屏 holder 走 openNodeNewWindow 同一条管线
// （renderMath／mermaid promise／viz force 全部落定）。渲染器缺席返回 null——
// 预览页保持编辑后的 DOM（降级可接受：正文语义已落盘，重开窗口即成品）
async function _nodeFsEditRenderFresh(node, src) {
  if (typeof _nodeFsRenderedHtml !== 'function') return null;
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node && node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const holder = document.createElement('div');
  holder.className = 'graph-node-fs-offscreen';
  holder.innerHTML = _nodeFsRenderedHtml(src, { parentId: String((message && message.timestamp) || (node && node.timestamp) || ''), sourceModule: node.moduleKey || '' });
  document.body.appendChild(holder);
  let out = '';
  try {
    if (typeof renderMath === 'function') { try { renderMath(holder); } catch (e) { /* 静态兜底 */ } }
    if (typeof renderMermaidInElement === 'function') { try { await renderMermaidInElement(holder); } catch (e) { /* 静态兜底 */ } }
    if (typeof _initVizIframes === 'function') { try { _initVizIframes(holder, { force: true }); } catch (e) { /* 静态兜底 */ } }
    out = String(holder.innerHTML || '');
  } catch (e) { out = ''; }
  try { holder.remove(); } catch (e2) { /* 沙箱兜底 */ }
  return out || null;
}

// 全屏层正开着同一节点时的就地重渲（桥上保存后那边还是开屏快照）：与 _nodeFsEditExit
// 的重渲段同款——滚动位置留住，meta 跟着新原文走。编辑中不动（入口已拒，这里双保险）
function _nodeFsEditRefreshOverlayBody(nodeId) {
  const overlay = document.querySelector('.graph-node-fs-overlay');
  if (!overlay || !overlay.querySelector) return;
  if (String((overlay.dataset && overlay.dataset.nodeFsId) || '') !== String(nodeId)) return;
  if (_nodeFsEditSession) return;
  const node = typeof _findGraphNode === 'function' ? _findGraphNode(nodeId) : null;
  if (!node || typeof _nodeFsRenderedHtml !== 'function') return;
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  const src = typeof _nodeFsSourceText === 'function' ? String(_nodeFsSourceText(node, message) || '') : '';
  const container = overlay.querySelector('.graph-node-fs-content');
  if (!container) return;
  const scroller = overlay.querySelector('.graph-node-fs-body');
  const keep = scroller ? scroller.scrollTop : 0;
  try {
    container.innerHTML = _nodeFsRenderedHtml(src, { parentId: String((message && message.timestamp) || node.timestamp || ''), sourceModule: node.moduleKey || '' });
  } catch (e) { return; }
  try {
    const meta = overlay.querySelector('.graph-node-fs-meta');
    if (meta && typeof _nodeFsReadingMeta === 'function') meta.textContent = _nodeFsReadingMeta(src);
  } catch (e) { /* 沙箱兜底 */ }
  if (scroller) { try { scroller.scrollTop = keep; } catch (e) {} }
  if (typeof _renderNotebookRich === 'function') { try { _renderNotebookRich(container); } catch (e) {} }
}
