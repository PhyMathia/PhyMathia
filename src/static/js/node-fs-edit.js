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
  // STRIKE 一并认（591①，2026-11-25）：浏览器原生删除线命令（工具条与右键菜单走同一条）
  // 吐的是 <strike>，此前拆壳取内容＝存完静默丢，与下划线同一类
  if (tag === 'DEL' || tag === 'S' || tag === 'STRIKE') return inner ? '~~' + inner + '~~' : '';
  // 下划线与上下标（591，2026-11-24）：此前走「拆壳取内容」＝存完静默丢。markdown 无
  // 原生记号，走 HTML 直写——marked 原样透传、DOMPurify 默认白名单放行 u/ins/sup/sub，
  // 存回后重开往返校验两侧同形（sig walk 本就认未知 tag，两侧一致）
  if (tag === 'U' || tag === 'INS') return inner ? '<u>' + inner + '</u>' : '';
  if (tag === 'SUP') return inner ? '<sup>' + inner + '</sup>' : '';
  if (tag === 'SUB') return inner ? '<sub>' + inner + '</sub>' : '';
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
        // 单元格里的 | 与 \ 必须转义（591，2026-11-24）：多出的管道会被当列分隔撑坏
        // 表格（绝对值 |x| 手打进单元格即中招），自检②只比可见文本拦不住；转义后
        // marked 按字面还原（\| → |），往返同形
        cells.push(_nodeFsEditInlineChildren(td).replace(/\s*\n\s*/g, ' ').trim()
          .replace(/\\/g, '\\\\').replace(/\|/g, '\\|'));
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
  const items = []; // 每个 li 的行数组（591③：松散列表要按项插空行，先攒再拼）
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
    items.push(itemLines);
  }
  // 松散列表（591③）：li 里直接包 p/div 的（AI 写的空行分隔列表、marked 的产物）按
  // markdown 松散口径拼——项与项之间空一行。紧排会渲染回 li 包 p（入场往返校验两侧
  // 不同形、进不了编辑）；空行分隔 marked 才认回「松散」，两侧同形
  let loose = false;
  for (let i = 0; i < kids.length; i++) {
    const li = kids[i];
    if (!li || li.nodeType !== 1 || String(li.tagName || '').toUpperCase() !== 'LI') continue;
    const lk = li.childNodes || [];
    for (let j = 0; j < lk.length; j++) {
      const t = lk[j] && lk[j].nodeType === 1 ? String(lk[j].tagName || '').toUpperCase() : '';
      if (t === 'P' || t === 'DIV') { loose = true; break; }
    }
    if (loose) break;
  }
  for (let i = 0; i < items.length; i++) {
    if (loose && i > 0) lines.push('');
    for (let l = 0; l < items[i].length; l++) lines.push(items[i][l]);
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
// 折公式成 $tex$/$$tex$$，摘掉 mermaid/viz/pre/img/svg/input/button 的渲染字形，再按
// _nodeFsEditBlockText 取字（2026-11-25 起不再直接取 textContent，见该函数注释）
function _nodeFsEditFoldVisible(clone) {
  if (typeof _nodeFsKatexFragmentText === 'function') _nodeFsKatexFragmentText(clone, true);
  const nodes = clone.querySelectorAll('.mermaid-container, .viz-card, pre, img, input, svg, button');
  for (let i = nodes.length - 1; i >= 0; i--) {
    try { if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]); } catch (e) { /* 沙箱兜底 */ }
  }
  return _nodeFsEditBlockText(clone);
}

// 块边界＝分隔（591①，2026-11-25 真机实锤的老 bug）：对账两侧的「可见文字」此前直接取
// textContent，块与块之间有没有空白全看渲染器当时吐没吐换行——marked 的产物块间带 \n，
// 而浏览器编辑时新造的块（段落中回车、列表项末回车、标题后回车）彼此之间没有空白节点：
// 右侧「甲乙」对左侧「甲 乙」，一回车就「有内容没能对上」存不了。空白文本节点不是内容、
// 块边界才是——这里在进/出块级元素处各补一个换行，两侧同一把尺，块间有没有空白节点
// 不再影响结论；块内行内文字的空格照旧逐字比（真丢了空格仍然拦）。
// 假 DOM（冒烟）没有 childNodes 时退回 textContent
const NODE_FS_EDIT_BLOCK_SEP = /^(P|DIV|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TR|TH|TD|HR|DL|DT|DD|BR)$/;
function _nodeFsEditBlockText(node) {
  if (!node) return '';
  if (node.nodeType === 3) return String(node.nodeValue != null ? node.nodeValue : (node.textContent || ''));
  if (node.nodeType !== 1) return '';
  const kids = node.childNodes;
  if (!kids) return String(node.textContent || '');
  const sep = NODE_FS_EDIT_BLOCK_SEP.test(String(node.tagName || '').toUpperCase());
  let out = sep ? '\n' : '';
  for (let i = 0; i < kids.length; i++) out += _nodeFsEditBlockText(kids[i]);
  if (sep) out += '\n';
  return out;
}

function _nodeFsEditVisibleFacts(container) {
  if (!container || typeof container.cloneNode !== 'function' || typeof _nodeFsKatexFragmentText !== 'function') return null;
  let clone = null;
  try { clone = container.cloneNode(true); } catch (e) { return null; }
  let text = '';
  try { text = _nodeFsEditFoldVisible(clone); } catch (e) { text = ''; }
  return { text, counts: _nodeFsEditAtomicCounts(clone) };
}

// 逐块取事实（591④，2026-11-25）：把容器的顶层子节点逐个套 _nodeFsEditVisibleFacts 同款
// 管道（折公式、摘原子块、块边界取字、原子家数），返回数组供逐块对账。ei＝元素序号
// （container.children 的下标）：childNodes 里夹着渲染器吐的空白文本节点，按 childNodes
// 计数会和修补器取元素的 children 错位（实锤：轻则查错块、重则 undefined 崩保存）。
// 空段（没文字也没原子）记 empty——序列化器本来就不产出空块，两侧先滤空再对齐
function _nodeFsEditChildFactsList(container) {
  if (!container || !container.childNodes || typeof document.createElement !== 'function') return null;
  const out = [];
  const kidsArr = container.childNodes;
  let ei = 0;
  for (let i = 0; i < kidsArr.length; i++) {
    const c = kidsArr[i];
    let facts = null;
    if (c.nodeType === 1) {
      const holder = document.createElement('div');
      try { holder.appendChild(c.cloneNode(true)); } catch (e) { return null; }
      facts = _nodeFsEditVisibleFacts(holder);
    } else if (c.nodeType === 3) {
      facts = { text: String(c.nodeValue != null ? c.nodeValue : ''), counts: '0/0/0/0' };
    } else continue;
    if (!facts) return null;
    const text = (typeof _nodeFsBoldScan === 'function') ? _nodeFsBoldScan(facts.text).text : facts.text;
    const isEl = c.nodeType === 1;
    out.push({ text, counts: String(facts.counts || ''), ei: isEl ? ei : -1, empty: !text && String(facts.counts || '') === '0/0/0/0' });
    if (isEl) ei++;
  }
  return out;
}

// 首个对不上的块（591④「拒存指明哪段」）：两侧＝拼回 md 重渲的顶层块流 vs 编辑 DOM 的
// 顶层块流，滤空后逐块比对可见文字与原子家数，返回 { domIndex, quote }——domIndex 是
// DOM 侧子节点序号（转义修补要用），quote 是那块开头的可见文字（toast 里指路用）。
// 全对上返回 null。渲染器缺席返回 null（宁宽进严出，与旧口径一致）
function _nodeFsEditMismatchBlock(next, domContainer) {
  if (typeof _nodeFsBoldScan !== 'function' || typeof renderMarkdown !== 'function' || typeof renderMath !== 'function') return null;
  let left = null;
  try {
    const holder = document.createElement('div');
    holder.innerHTML = renderMarkdown(String(next || ''), {});
    try { renderMath(holder); } catch (e0) { /* 公式折不动：放行，宁宽进严出 */ }
    left = _nodeFsEditChildFactsList(holder);
  } catch (e) { return null; }
  const right = _nodeFsEditChildFactsList(domContainer);
  if (!left || !right) return null;
  const L = left.filter((x) => !x.empty);
  const R = right.filter((x) => !x.empty);
  const n = Math.max(L.length, R.length);
  for (let i = 0; i < n; i++) {
    const a = L[i];
    const b = R[i];
    if (!a || !b || a.text !== b.text || a.counts !== b.counts) {
      const src = b || a;
      // domIndex 用元素序号 ei（修补器按 container.children 取块）；行内碎片/顶层裸文本＝-1
      const domIndex = b ? b.ei : -1;
      let ordinal = 1;
      for (let k = 0; k < right.length && right[k] !== b; k++) { if (!right[k].empty) ordinal++; }
      return { domIndex, ordinal, quote: String((src && src.text) || '').replace(/\s+/g, ' ').trim().slice(0, 12) };
    }
  }
  return null;
}

// 按字面转义（591④ 拍板：结构操作全走工具条，手打记号就是普通文字）。mode：
// 'struct'＝行首结构记号（#/引用/列表/序号/围栏）前加反斜杠；'inline'＝成对的行内记号
// （*_~`）逐个转义；'both'＝两样都来。shell＝这个块自己的结构壳（'list'/'quote'/'head'，
// 正文块传 ''）——为非空时行首的壳记号先剥掉、只转义壳后面的内容：壳是结构本身不能动，
// 且壳型按块的 tag 一层一层传，不用贪心正则猜（猜会把内容里的 `#` 误当成壳）。产出是否
// 真的「渲染回去和 DOM 同形」由调用方重跑对账判定——这里只管生成候选。
function _nodeFsEditEscapeChunkMd(md, mode, shell) {
  const lines = String(md || '').split('\n');
  const shellRe = shell === 'list' ? /^(\s*(?:[-+*]\s+|\d{1,9}[.)]\s+))/
    : shell === 'quote' ? /^(\s*(?:>\s?)+)/
      : shell === 'head' ? /^(#{1,6}\s)/
        : null;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let prefix = '';
    let rest = lines[i];
    if (shellRe) {
      const pm = shellRe.exec(rest);
      prefix = pm ? pm[1] : '';
      rest = rest.slice(prefix.length);
    }
    if (mode === 'struct' || mode === 'both') {
      rest = rest.replace(/^(#{1,6})(?=\s)/, (m0) => '\\' + m0.split('').join('\\'));
      rest = rest.replace(/^>/, '\\>');
      rest = rest.replace(/^([-+*])(?=\s)/, '\\$1');
      rest = rest.replace(/^(\d{1,9})([.)])(?=\s)/, '$1\\$2');
      rest = rest.replace(/^```/, '\\`\\`\\`');
    }
    if (mode === 'inline' || mode === 'both') {
      rest = rest.replace(/([*_~`])/g, '\\$1');
    }
    out.push(prefix + rest);
  }
  return out.join('\n');
}

// 逐子节点的序列化（转义修补的落点）：与 _nodeFsEditFlowMd 同一趟走法，但每个顶层子节点
// 各产一块（行内碎片并进同一段、owner 记它属于哪个元素的序号，与 _nodeFsEditChildFactsList
// 的 ei 同一把尺），md 拼法与整篇序列化一致
function _nodeFsSerializeAligned(container) {
  const chunks = [];
  const owner = [];
  let buf = [];
  let bufOwner = -1;
  const flush = () => {
    const t = buf.join('').replace(/^\s+/, '').replace(/\s+$/, '');
    if (t) { chunks.push(t); owner.push(bufOwner); }
    buf = [];
  };
  const kidsArr = (container && container.childNodes) || [];
  let ei = 0;
  for (let i = 0; i < kidsArr.length; i++) {
    const c = kidsArr[i];
    const isBlock = c && c.nodeType === 1
      && (NODE_FS_EDIT_BLOCK_TAGS.test(String(c.tagName || '').toUpperCase())
        || (c.classList && (c.classList.contains('mermaid-container') || c.classList.contains('viz-card'))));
    if (!isBlock) {
      if (c.nodeType === 1 && bufOwner < 0) bufOwner = ei;
      buf.push(_nodeFsEditInline(c));
      if (c.nodeType === 1) ei++;
      continue;
    }
    flush();
    const md = _nodeFsEditBlockMd(c);
    if (md) { chunks.push(md); owner.push(ei); }
    ei++;
  }
  flush();
  return { chunks, owner, md: chunks.join('\n\n') };
}

// 序列化＋按字面修补一条龙（591④）：先照常拼回，对不上账就定位那一块、按「结构记号→
// 行内记号→双管齐下」三档顺序生成转义候选、真变了 md 才收、收完立刻重跑对账——同一块
// 还有别的记号下一轮接着转，别的块也轮得到（一篇里可以有多个坏块，比如同时手打了 -
// 和 1.：修补档位必须按块轮转，不能挂在全局轮数上，否则第二块永远等不到自己的档）。
// inline/both 不是幂等转义（已转过的 * 再转会双反斜杠），收过就不重复试。外层带预算，
// 六轮修不动才如实报 bad（带块位置与开头文字）。转义只落在正文/列表/引用这类「可修」
// 的块上；代码块/图/可视化是逐字还原的原子块，对不上＝结构性问题，转义只会越修越坏，
// 直接拒。渲染器缺席（沙箱）＝不修补直接放行，旧口径不变
function _nodeFsSerializeVerified(container) {
  const base = _nodeFsSerializeContent(container);
  if (typeof renderMarkdown !== 'function' || typeof _nodeFsBoldScan !== 'function'
    || typeof renderMath !== 'function' || typeof document.createElement !== 'function') {
    return { md: base, bad: null };
  }
  const al = _nodeFsSerializeAligned(container);
  let md = al.md;
  let bad = _nodeFsEditMismatchBlock(md, container);
  const modes = ['struct', 'inline', 'both'];
  const triedByChunk = {}; // 块序 → 已收过的档（防 inline/both 叠转）
  for (let round = 0; round < 6 && bad; round++) {
    let ci = -1;
    for (let k = 0; k < al.owner.length; k++) { if (al.owner[k] === bad.domIndex) { ci = k; break; } }
    if (ci < 0) break; // 对不上的是行内碎片/顶层裸节点：转义落不进去，如实拒
    const el = container.children[bad.domIndex];
    const tag = el && el.nodeType === 1 ? String(el.tagName || '').toUpperCase() : '';
    if (tag === 'PRE' || (el.classList && (el.classList.contains('mermaid-container') || el.classList.contains('viz-card')))) break;
    // 壳型按块的 tag 定（一层壳一套正则，转义只打壳后内容）；正文块（P/DIV）行首即内容
    const shell = /^(UL|OL)$/.test(tag) ? 'list'
      : tag === 'BLOCKQUOTE' ? 'quote'
        : /^H[1-6]$/.test(tag) ? 'head'
          : ''; // 表格/其余：行首多是管道/无壳，转义记号不命中，无害
    const tried = triedByChunk[ci] || (triedByChunk[ci] = []);
    const inlineSpent = tried.indexOf('inline') >= 0 || tried.indexOf('both') >= 0; // inline 不幂等：收过（含 both 里捎带的）就封死，防越转越多
    let adopted = null;
    for (let mi = 0; mi < modes.length && !adopted; mi++) {
      const mode = modes[mi];
      if (mode !== 'struct' && inlineSpent) continue;
      const cand = al.chunks.slice();
      cand[ci] = _nodeFsEditEscapeChunkMd(al.chunks[ci], mode, shell);
      const joined = cand.join('\n\n');
      if (joined === md) continue; // 这档变不出新 md（多半已转过/没这种记号）：换下一档
      tried.push(mode);
      al.chunks = cand; // 收下这档，同块下一轮在它基础上加码
      md = joined;
      adopted = true;
    }
    if (!adopted) break; // 三档都变不出新 md：这一块修不动，如实拒
    bad = _nodeFsEditMismatchBlock(md, container);
  }
  return { md, bad };
}

// 拒存指路的文案（两处编辑面同一句式）：第 N 段＝滤空后的内容块序号，引开头文字帮定位
function _nodeFsEditBadMessage(bad) {
  if (!bad) return '这次改动保存不了：有内容没能对上，检查刚改的部分';
  const where = bad.ordinal ? '第 ' + bad.ordinal + ' 段' : '';
  const quote = bad.quote ? '「' + bad.quote + '…」' : '';
  return '这次改动保存不了：' + (where || '有一段') + quote + '对不上——试试删掉这段重打';
}

// （旧 _nodeFsEditVisibleMismatch 整批对账已于 2026-11-25 拆成 _nodeFsEditMismatchBlock
// 逐块定位＋_nodeFsSerializeVerified 转义修补一条龙，全屏保存/桥上保存/入场校验同一把尺）

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
  // 入场往返校验：序列化器对这篇内容必须能原样拼回，才放行进入编辑（591④ 起拼回带
  // 按字面转义修补——手打记号的内容也进得来了）
  const domNow = _nodeFsSerializeVerified(container).md;
  if (_nodeFsEditRoundTripDiff(src, domNow)) {
    _nodeFsEditToast('这种内容暂时不支持渲染态编辑（有不认识的写法）');
    return;
  }
  const scroller = overlay.querySelector ? overlay.querySelector('.graph-node-fs-body') : null;
  const body = overlay.querySelector ? overlay.querySelector('.graph-node-fs-body') : null;
  const actions = overlay.querySelector ? overlay.querySelector('.graph-node-fs-head-actions') : null;
  const session = { nodeId: node.id, overlay, container, scroller, origSrc: src, dirty: false, handlers: [], headHtml: null, fmt: null };
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
      hint.textContent = '直接改正文；双击公式改 TeX，「＋ 公式」可插新公式；改完点「保存」写回节点';
      body.insertBefore(hint, container);
    } catch (e) { /* 沙箱无真 DOM：没有 hint 不挡编辑 */ }
  }
  // 格式工具条（591①，2026-11-25）：加粗/斜体/删除线/行内代码/链接＋段落类型＋引用＋插入
  // 分隔线/表格。DOM 与行为全在自包含 kit（node-fs-fmt.js，新窗口预览页嵌同一份源码），
  // 这里只负责挂上去、给它 dirty 回调；退出时 destroy 会连工具条一起摘掉
  if (body && typeof document.createElement === 'function' && typeof _nodeFsFmtKit === 'function') {
    try {
      const fmt = _nodeFsFmtKit();
      const fmtBar = fmt.build();
      fmtBar.classList.add('aurora-glass', 'aurora-glass--compact');
      body.insertBefore(fmtBar, container);
      session.fmt = fmt.mount({ container, bar: fmtBar, onDirty: () => { session.dirty = true; }, toast: _nodeFsEditToast });
    } catch (e) { /* 工具条起不来不挡编辑 */ }
  }
  // 头部换成保存/取消（其余动作收起，编辑期间不误触）
  if (actions) {
    session.headHtml = actions.innerHTML;
    actions.innerHTML = '<button type="button" class="graph-node-fs-edit-btn" onclick="saveNodeFsEdit()" title="保存并写回节点">✓ 保存</button>'
      + '<button type="button" class="graph-node-fs-edit-btn" onclick="cancelNodeFsEdit()" title="放弃这次改动">× 取消</button>';
  }
  // 会话监听：dirty 标记 / 粘贴先走 kit 的保格式转换（591③），转不动回纯文本 / 编辑态点链接只放光标不跳转
  const onInput = () => { session.dirty = true; };
  const onPaste = (ev) => {
    if (session.fmt && typeof session.fmt.paste === 'function') {
      let handled = false;
      try { handled = !!session.fmt.paste(ev); } catch (e) { handled = false; }
      if (handled) { session.dirty = true; return; }
    }
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
  _nodeFsEditConfirmHide(); // 三选条开着的话一起收（保存/取消各路都会走到这）
  _nodeFsEditSession = null;
  const hs = session.handlers || [];
  for (let i = 0; i < hs.length; i++) {
    try { hs[i][0].removeEventListener(hs[i][1], hs[i][2]); } catch (e) { /* 沙箱兜底 */ }
  }
  if (session.fmt) { try { session.fmt.destroy(); } catch (e) { /* 沙箱兜底 */ } session.fmt = null; }
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

function saveNodeFsEdit(stay) {
  const session = _nodeFsEditSession;
  if (!session) return;
  const node = typeof _findGraphNode === 'function' ? _findGraphNode(session.nodeId) : null;
  if (!node) { _nodeFsEditToast('源节点已不在画布上'); _nodeFsEditExit(false); return; }
  const messages = typeof _getChatHistory === 'function' ? _getChatHistory() : [];
  const message = node.messageIndex >= 0 ? messages[node.messageIndex] : null;
  // 序列化＋按字面修补一条龙：手打 `#`/`-` 等记号自动转义成普通文字（591④ 拍板）；
  // 三档转义都对不上才拒存，且指明是哪一段
  const ser = _nodeFsSerializeVerified(session.container);
  const next = ser.md;
  if (!String(next || '').trim()) { _nodeFsEditToast('正文全空就不保存了——要删节点请在画布上操作'); return; }
  if (ser.bad) {
    _nodeFsEditToast(_nodeFsEditBadMessage(ser.bad));
    _nodeFsEditFlashBad(session.container, ser.bad);
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
  if (stay) _nodeFsEditStay(session, node, message, next);
  else _nodeFsEditExit(true);
  _nodeFsEditToast(stay ? '已保存，仍在编辑（Ctrl+S 快存）' : (result.message || '已保存，并写回节点'));
}

function cancelNodeFsEdit() {
  if (!_nodeFsEditSession) return;
  _nodeFsEditConfirmHide();
  _nodeFsEditExit(true);
  _nodeFsEditToast('已取消编辑，改动已还原');
}

// ---------- 存完留编辑态（591④，Ctrl+S）＋关闭三选（591④）＋拒存指段闪烁 ----------

// 对不上的那块闪一下红框（拒存指路的视觉落点；预览窗跨 iframe 闪不了，只全屏层用）
let _nodeFsEditFlashTimer = null;
function _nodeFsEditFlashBad(container, bad) {
  if (!container || !bad || bad.domIndex < 0 || typeof document.createElement !== 'function') return;
  try {
    const el = container.children[bad.domIndex];
    if (!el || !el.classList) return;
    container.querySelectorAll('.nfs-edit-badblock').forEach((x) => { try { x.classList.remove('nfs-edit-badblock'); } catch (e) {} });
    el.classList.add('nfs-edit-badblock');
    if (_nodeFsEditFlashTimer) clearTimeout(_nodeFsEditFlashTimer);
    _nodeFsEditFlashTimer = setTimeout(() => {
      try { el.classList.remove('nfs-edit-badblock'); } catch (e) {}
      _nodeFsEditFlashTimer = null;
    }, 2600);
  } catch (e) { /* 假 DOM 闪不了不挡保存 */ }
}

// 三选条（改动未保存时关编辑面给出路：保存并退出／放弃修改／继续编辑）。
// 全屏层挂在全屏 body 上；预览页同款在内嵌脚本里各写一份（DOM 与行为不跨框）
let _nodeFsEditConfirmEl = null;
function _nodeFsEditConfirmHide() {
  if (_nodeFsEditConfirmEl) {
    try { _nodeFsEditConfirmEl.remove(); } catch (e) {}
    _nodeFsEditConfirmEl = null;
  }
}
function _nodeFsEditConfirmShow() {
  const session = _nodeFsEditSession;
  if (!session || _nodeFsEditConfirmEl || typeof document.createElement !== 'function') return;
  const host = (session.overlay && session.overlay.querySelector) ? session.overlay.querySelector('.graph-node-fs-body') : null;
  if (!host || !host.appendChild) return;
  const bar = document.createElement('div');
  bar.className = 'graph-node-fs-edit-confirm aurora-glass aurora-glass--compact';
  bar.innerHTML = '<span class="graph-node-fs-edit-confirm-msg">改动还没保存</span>'
    + '<button type="button" data-c="save" title="保存并退出编辑">保存并退出</button>'
    + '<button type="button" data-c="discard" title="不保存，退出编辑">放弃修改</button>'
    + '<button type="button" data-c="stay" title="回到编辑">继续编辑</button>';
  bar.addEventListener('click', (ev) => {
    const b = ev && ev.target && ev.target.closest ? ev.target.closest('[data-c]') : null;
    if (!b) return;
    if (ev.preventDefault) ev.preventDefault();
    const c = String(b.getAttribute('data-c') || '');
    _nodeFsEditConfirmHide();
    if (c === 'save') saveNodeFsEdit(false);
    else if (c === 'discard') cancelNodeFsEdit();
    // stay：只收条子，编辑态不动
  });
  host.appendChild(bar);
  _nodeFsEditConfirmEl = bar;
}

// 保存后不退出：按新原文重渲正文、锁原子块、session 基线跟着新原文走（origSrc 不更新的话
// 下次保存的对账就会拿旧文比新文），撤销栈重开一页（旧栈的快照对着已被换掉的 DOM）。
// 与 _nodeFsEditExit 的重渲段同一套取材口径，只是不收会话
function _nodeFsEditStay(session, node, message, src) {
  _nodeFsEditConfirmHide();
  const container = session.container;
  const keep = session.scroller ? session.scroller.scrollTop : 0;
  try {
    container.innerHTML = (typeof _nodeFsRenderedHtml === 'function')
      ? _nodeFsRenderedHtml(src, { parentId: String((message && message.timestamp) || node.timestamp || ''), sourceModule: node.moduleKey || '' })
      : '';
  } catch (e) { /* 渲染器缺席：正文保持编辑后的 DOM */ }
  try {
    const atoms = container.querySelectorAll('.katex, .katex-display, .mermaid-container, .viz-card, pre, img, input');
    for (let i = 0; i < atoms.length; i++) { try { atoms[i].setAttribute('contenteditable', 'false'); } catch (e) {} }
  } catch (e) {}
  session.origSrc = src;
  session.dirty = false;
  if (session.fmt && typeof session.fmt.reset === 'function') { try { session.fmt.reset(); } catch (e) {} }
  try {
    const meta = session.overlay && session.overlay.querySelector ? session.overlay.querySelector('.graph-node-fs-meta') : null;
    if (meta && typeof _nodeFsReadingMeta === 'function') meta.textContent = _nodeFsReadingMeta(src);
  } catch (e) {}
  if (session.scroller) { try { session.scroller.scrollTop = keep; } catch (e) {} }
  if (typeof _renderNotebookRich === 'function') { try { _renderNotebookRich(container); } catch (e) {} }
}

// 关闭全屏的守卫（graph-custom.closeNodeFullscreen 开头调用）：编辑中且有未保存改动
// → 弹三选条拦下（591④）；干净 → 顺手收会话放行
function _nodeFsEditCloseGuard() {
  const session = _nodeFsEditSession;
  if (!session) return false;
  if (!session.dirty) { _nodeFsEditExit(true); return false; }
  _nodeFsEditConfirmShow();
  return true;
}

// Esc capture（与浮条同口径：先收编辑、ui.js 的「Esc 关全屏」这轮不触发）：
// 有改动先弹三选条，干净则退出编辑、全屏留着（第二次 Esc 才是关全屏）
document.addEventListener('keydown', (ev) => {
  if (!ev || ev.key !== 'Escape' || !_nodeFsEditSession) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  // 三选条开着：这一下 Esc 只收条子，编辑态不动
  if (_nodeFsEditConfirmEl) { _nodeFsEditConfirmHide(); return; }
  // 工具条的链接输入行开着：这一下 Esc 只收输入行，编辑态不动
  if (_nodeFsEditSession.fmt && _nodeFsEditSession.fmt.escape()) return;
  if (_nodeFsEditSession.dirty) { _nodeFsEditConfirmShow(); return; }
  _nodeFsEditExit(true);
  _nodeFsEditToast('已退出编辑');
}, true);

// Ctrl+S＝快存不退出（591④）：存完留在编辑态继续改；✓ 保存按钮照旧存完退出。
// 输入行（链接/公式）开着时这一下只收行——带未定稿输入去保存会拿旧 DOM 存
document.addEventListener('keydown', (ev) => {
  if (!ev || ev.key !== 's' && ev.key !== 'S' || !(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
  if (!_nodeFsEditSession) return;
  if (ev.preventDefault) ev.preventDefault();
  if (ev.stopPropagation) ev.stopPropagation();
  if (_nodeFsEditSession.fmt && _nodeFsEditSession.fmt.escape()) return;
  saveNodeFsEdit(true);
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
  // 序列化＋按字面修补一条龙（与全屏保存同一把尺，591④）：手打记号自动转义；
  // 三档都对不上才拒，文案指明哪一段（预览窗闪不了框，文字里带开头几个字帮定位）
  const ser = _nodeFsSerializeVerified(probe);
  const next = ser.md;
  if (!String(next || '').trim()) return { ok: false, message: '正文全空就不保存了——要删节点请在画布上操作' };
  if (ser.bad) return { ok: false, message: _nodeFsEditBadMessage(ser.bad) };
  const result = _nodeFsBoldWrite(node, message, next, { summary: '渲染态编辑（新窗口）', okMessage: '已保存，并写回节点', verb: '编辑' });
  if (!result || !result.ok) return { ok: false, message: (result && result.message) || '保存失败' };
  // 人工定稿（T355 口径）＋自有节点落盘——与全屏保存同款双守卫
  if (typeof _markNodeHumanFinalized === 'function') { try { _markNodeHumanFinalized(node); } catch (e) { /* 标记失败不挡保存 */ } }
  if (typeof _saveCustomNodes === 'function') { try { _saveCustomNodes(); } catch (e) { /* 落盘失败不挡保存 */ } }
  _nodeFsEditRefreshOverlayBody(node.id);
  // sig＝保存后的新原文指纹：预览窗 Ctrl+S 快存（存完留编辑态）要用它过下一轮对账
  return { ok: true, message: result.message || '已保存，并写回节点', src: next, sig: _nodeFsEditSrcSig(next) };
}

// 预览窗公式渲染查询（591②，2026-11-25）：预览页零渲染逻辑，渲染全在主应用——预览窗
// 「确定」时把 TeX 过桥，这里渲好把成品 HTML 随 ack 的 html 字段带回（纯只读，不写回，
// 节点/会话都不强求）。先按严格模式验一遍（有错如实回话，预览窗留在编辑态），过了再出成品
function _nodeFsTexRenderBridge(tex, display) {
  if (typeof window.katex === 'undefined' || !window.katex.renderToString) return { ok: false, message: '主应用的公式渲染器不可用' };
  const t = String(tex || '').replace(/^\s+|\s+$/g, '');
  if (!t) return { ok: false, message: '公式是空的' };
  if (t.length > 8000) return { ok: false, message: '这条公式太长了' };
  try { window.katex.renderToString(t, { throwOnError: true, displayMode: !!display }); }
  catch (e) { return { ok: false, message: 'TeX 写错了，改一改再确定' }; }
  try { return { ok: true, html: window.katex.renderToString(t, { throwOnError: false, displayMode: !!display }) }; }
  catch (e) { return { ok: false, message: '主应用的公式渲染器不可用' }; }
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
