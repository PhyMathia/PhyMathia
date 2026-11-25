// ===== 渲染态编辑·格式工具条（2026-11-25，backlog 591①②）=====
// 全屏层（node-fs-edit.js）与新窗口预览页（node-fs-toolbar.js 内嵌脚本）共用：本文件只有一个
// 自包含工厂 _nodeFsFmtKit——函数体不引用本文件之外的名字（只用 document/window 这类真全局；
// window.katex／window.nodeFsTexBridge 也算：主应用有前者，后者由预览页内嵌脚本注入作桥）。
// 主应用直接调用；预览页由 _buildNodeFsPreviewScript 把它的源码（toString）原样嵌进内嵌脚本，
// 改这里＝两处同时生效。也因此函数体里不能出现脚本闭合标签与 HTML 注释起头（嵌进 script
// 会提前收尾，生成侧有守卫、冒烟有契约）。
// 哪些走浏览器原生命令、哪些手改 DOM——2026-11-25 真机探针定案：
// · 能走原生的都走原生，Ctrl+Z 是浏览器自己的撤销栈、最稳：加粗/斜体/删除线（styleWithCSS
//   关着吐 <b>/<i>/<strike>，序列化器都认）；正文↔标题（formatBlock，只在单块内用——跨块
//   会把两段并成一段）；链接（createLink/unlink，先把整条链接选中，否则会把一条链接劈成
//   两条）；顶层正文/标题里插分隔线（insertHTML，落点逐次校验，不对就回滚改手插）。
// · 原生命令产出是坏的这一档手改：列表命令会把段落掏空成 <p><ul>…、把邻段并进列表、撤列表
//   时留下裸 span＋<br>；formatBlock 在列表项里会把整张表包进 <h3>；insertHTML 会把 <pre>
//   揉进下一个标题、在文末落错位置。手改＝只搬节点不复制（Range 跟着节点走，光标不丢）。
// · 手改之后浏览器撤销栈就跟 DOM 对不上了（实测一次 Ctrl+Z 抹掉两段打字）——第一次手改起
//   「接管撤销」：此后 Ctrl+Z/Y 走本 kit 的快照栈（打字停顿算一步、工具条一步），原生撤销
//   不再放行（键盘拦 keydown、右键菜单拦 beforeinput）；手改之前的打字不可再撤销。
// 加载期零副作用；工具条按钮走 data-fmt（与画布 data-act／data-mact 不同名，互不相认）。

function _nodeFsFmtKit() {
  // 原子块清单＝node-fs-edit.js 开编辑时锁的那串（冒烟有契约，改一处必改另一处）
  const ATOMS = '.katex, .katex-display, .mermaid-container, .viz-card, pre, img, input';
  const LEAF = 'p, div, h1, h2, h3, h4, h5, h6, li';
  const HEAD = /^H[1-6]$/;
  const BLOCKY = /^(UL|OL|P|DIV|H[1-6]|PRE|TABLE|BLOCKQUOTE)$/;
  const TEXTBLOCK = /^(P|DIV|H[1-6]|LI)$/;
  const NO_CARET = '先在正文里点一下，选定要改的位置';
  const ONE_LEAF = '一次只改一段，请只在一段里选字';
  const BAD = '这个位置暂时改不了';
  const IDLE_MS = 600;
  const LINK_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';

  let container = null; // 编辑面（mount 时定）
  let bar = null; // 工具条
  let blockSel = null; // 段落类型下拉
  let linkRow = null; // 链接地址输入行
  let urlInput = null;
  let linkEdit = null; // 输入行开着时正在改的那条链接（null＝新建）
  let texRow = null; // 公式编辑行（591②）
  let texInput = null;
  let texMode = null; // 行内／独立下拉
  let texPv = null; // 实时预览区（无本地渲染器时藏掉）
  let texTarget = null; // 正在改的那条公式（null＝插入新公式）
  let texSpot = null; // 插入点＝开行时记下的选区（编辑期间正文不动，节点引用一直有效）
  let texTimer = 0;
  let texPending = false; // 桥上渲染中（预览页异步路，ack 回来才落 DOM）
  let saved = null; // 最近一次落在编辑面里的选区（点工具条时焦点会离开编辑面）
  let hist = null; // 接管后的撤销栈
  let histTimer = 0;
  let refreshTimer = 0;
  let cssWas = false;
  let onDirty = () => {};
  let toast = () => {};

  // ---------- 小工具 ----------

  const tagOf = (el) => (el && el.nodeType === 1 ? String(el.tagName || '').toUpperCase() : '');
  const elOf = (node) => {
    if (!node) return null;
    return node.nodeType === 1 ? node : (node.parentElement || null);
  };
  const kids = (list) => Array.prototype.slice.call(list || []);
  const inside = (root, node) => {
    try { return node === root || root.contains(node); } catch (e) { return false; }
  };
  const atom = (el) => !!(el && el.matches && el.matches(ATOMS));
  const blocky = (el) => {
    for (const c of kids(el.children)) if (BLOCKY.test(tagOf(c))) return true;
    return false;
  };
  // 叶子块＝直接装行内内容的块；P/DIV 里若装的是块级子元素就不算（列表项带子列表仍算叶子）
  const isLeaf = (el) => !!el.matches && el.matches(LEAF) && !atom(el) && (tagOf(el) === 'LI' || !blocky(el));
  const up = (root, el, pred) => {
    let e = el;
    while (e && e !== root) {
      if (pred(e)) return e;
      e = e.parentElement;
    }
    return null;
  };
  const leafOf = (root, node) => {
    let el = elOf(node);
    while (el && el !== root) {
      if (isLeaf(el)) return el;
      el = el.parentElement;
    }
    return null;
  };
  const cellOf = (root, node) => {
    const el = elOf(node);
    return el === root ? null : up(root, el, (e) => /^(TD|TH)$/.test(tagOf(e)));
  };
  const quoteOf = (root, el) => up(root, el, (e) => tagOf(e) === 'BLOCKQUOTE');
  // 顶层块＝编辑面的直接子元素
  const unitOf = (root, el) => {
    let e = el;
    while (e && e.parentElement && e.parentElement !== root) e = e.parentElement;
    return e && e !== root ? e : null;
  };
  // node 所在的、匹配 sel 的元素（限编辑面内）；没有＝null
  const inEl = (node, sel) => {
    const el = elOf(node);
    if (!el || !el.closest) return null;
    const m = el.closest(sel);
    return m && inside(container, m) ? m : null;
  };
  const lock = (el) => { try { el.setAttribute('contenteditable', 'false'); } catch (e) { /* 沙箱兜底 */ } };
  const emptyP = () => {
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    return p;
  };
  // 与 marked 的任务项同形：<input disabled type="checkbox"> 后跟一个空格
  const checkbox = () => {
    const i = document.createElement('input');
    i.type = 'checkbox';
    i.disabled = true;
    lock(i);
    return i;
  };
  const isTextBlock = (el) => !!el && TEXTBLOCK.test(tagOf(el)) && !atom(el);
  const unwrap = (el) => {
    const p = el.parentNode;
    if (!p) return;
    while (el.firstChild) p.insertBefore(el.firstChild, el);
    p.removeChild(el);
    if (p.normalize) p.normalize();
  };
  const listStart = (list) => {
    const n = parseInt(list.getAttribute('start') || '1', 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  };
  const listKind = (list) => {
    const t = tagOf(list);
    if (t !== 'UL' && t !== 'OL') return 'ul';
    for (const li of kids(list.children)) {
      if (tagOf(li) !== 'LI') continue;
      if (kids(li.children).some((c) => tagOf(c) === 'INPUT')) return 'task';
      break;
    }
    return t === 'OL' ? 'ol' : 'ul';
  };
  const leafKind = (el) => {
    const t = tagOf(el);
    if (HEAD.test(t)) return t.toLowerCase();
    if (t === 'LI') return listKind(el.parentElement);
    return 'p';
  };

  // ---------- 选区 ----------

  const selOf = () => (window.getSelection ? window.getSelection() : null);
  const selRange = () => {
    const sel = selOf();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    if (!r || !inside(container, r.commonAncestorContainer)) return null;
    return r;
  };
  const select = (r) => {
    const sel = selOf();
    if (!sel) return;
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const point = (node, offset) => {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    return r;
  };
  const snapRange = (r) => ({ a: r.startContainer, b: r.startOffset, c: r.endContainer, d: r.endOffset });
  const rangeFrom = (s) => {
    if (!s || !inside(container, s.a) || !inside(container, s.c)) return null;
    try {
      const r = document.createRange();
      r.setStart(s.a, s.b);
      r.setEnd(s.c, s.d);
      return r;
    } catch (e) { return null; }
  };
  const focusRoot = () => {
    try { container.focus({ preventScroll: true }); } catch (e) { try { container.focus(); } catch (e2) { /* 聚焦失败不挡 */ } }
  };
  const remember = () => {
    const r = selRange();
    if (r) saved = snapRange(r);
  };
  // 编辑面里的现选区；焦点在工具条上时把记住的那份放回去
  const live = () => {
    const r = selRange();
    if (r) return r;
    const s = rangeFrom(saved);
    if (s) select(s);
    return s;
  };
  const ensure = () => {
    const r = live();
    if (r) focusRoot();
    return r;
  };
  const textNodes = () => {
    const out = [];
    const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) out.push(n);
    return out;
  };
  const textOffset = (node, offset) => {
    try {
      const r = document.createRange();
      r.setStart(container, 0);
      r.setEnd(node, offset);
      return r.toString().length;
    } catch (e) { return -1; }
  };
  // 选区书签＝按字符序记落点（正文重排后按同一字符数找回去；原子块里的字算数，落点会让开）
  const bookmark = () => {
    const r = selRange();
    if (!r) return null;
    return { s: textOffset(r.startContainer, r.startOffset), e: textOffset(r.endContainer, r.endOffset) };
  };
  const editableText = (n) => !inEl(n, ATOMS) && !(n.parentNode === container && !String(n.nodeValue || '').trim());
  const pointAt = (k) => {
    const tns = textNodes();
    let off = 0;
    let pick = -1;
    let at = 0;
    for (let i = 0; i < tns.length; i++) {
      const len = tns[i].nodeValue.length;
      if (k <= off + len) { pick = i; at = k - off; break; }
      off += len;
    }
    if (pick < 0) {
      pick = tns.length - 1;
      at = pick >= 0 ? tns[pick].nodeValue.length : 0;
    }
    for (let i = pick; i < tns.length; i++) {
      if (editableText(tns[i])) return point(tns[i], i === pick ? at : 0);
    }
    for (let i = pick - 1; i >= 0; i--) {
      if (editableText(tns[i])) return point(tns[i], tns[i].nodeValue.length);
    }
    return null;
  };
  const restoreBookmark = (bm) => {
    if (!bm || bm.s < 0) return false;
    const a = pointAt(bm.s);
    const b = bm.e === bm.s ? a : pointAt(bm.e);
    if (!a || !b) return false;
    try {
      const r = document.createRange();
      r.setStart(a.startContainer, a.startOffset);
      r.setEnd(b.startContainer, b.startOffset);
      select(r);
      focusRoot();
      return true;
    } catch (e) { return false; }
  };
  // 光标落到 el 的开头（start）／末尾
  const caretAt = (el, start) => {
    const tns = textNodes().filter((n) => inside(el, n) && !inEl(n, ATOMS));
    const p = tns.length
      ? point(tns[start ? 0 : tns.length - 1], start ? 0 : tns[tns.length - 1].nodeValue.length)
      : point(el, start ? 0 : el.childNodes.length);
    select(p);
    focusRoot();
  };
  // 点 p 是否在点 q 之前。折叠区间 p 的 comparePoint(q)：q 在 p 前＝－1、重合＝0、在后＝1
  // （只用严格的前后，不碰边界点比较——那套常量各家口径 historically 相反）
  const before = (p, q) => p.comparePoint(q.startContainer, q.startOffset) > 0;
  // 选区是否真的切到元素 el（贴边不算）
  const hits = (r, el) => {
    try {
      const s = point(el, 0);
      const e = point(el, el.childNodes.length);
      return before(point(r.startContainer, r.startOffset), e) && before(s, point(r.endContainer, r.endOffset));
    } catch (err) {
      try { return r.intersectsNode(el); } catch (e2) { return false; }
    }
  };
  // 选区碰到的叶子块（文档序）；折叠光标＝光标所在叶子
  const touched = (r) => {
    if (r.collapsed) {
      const l = leafOf(container, r.startContainer);
      return l ? [l] : [];
    }
    return kids(container.querySelectorAll(LEAF)).filter((el) => isLeaf(el) && hits(r, el));
  };
  // 选区正好框住一个代码块（编辑态点代码块会整块选中）→ 那个 pre
  const soloPre = (r) => {
    if (r.collapsed) return null;
    let hit = null;
    for (const p of kids(container.querySelectorAll('pre'))) {
      if (!hits(r, p)) continue;
      if (hit) return null;
      hit = p;
    }
    if (!hit) return null;
    return kids(container.querySelectorAll('.mermaid-container, .viz-card, img')).some((el) => hits(r, el)) ? null : hit;
  };

  // ---------- 接管后的撤销／重做（快照栈）----------

  const snap = () => ({ html: container.innerHTML, bm: bookmark() });
  const restore = (s) => {
    container.innerHTML = s.html;
    focusRoot();
    restoreBookmark(s.bm);
  };
  const takeOver = () => {
    if (!hist) hist = { undo: [], redo: [], base: snap(), clean: true };
  };
  // 把「上一边界之后的改动」记成一步，当前状态成为新边界
  const commit = () => {
    if (!hist || hist.clean) return;
    hist.undo.push(hist.base);
    hist.base = snap();
    hist.clean = true;
  };
  const onInput = () => {
    if (!hist) return;
    hist.clean = false;
    hist.redo = [];
    clearTimeout(histTimer);
    histTimer = setTimeout(commit, IDLE_MS);
  };
  const undo = () => {
    if (!hist) return false;
    clearTimeout(histTimer);
    const cur = snap();
    if (!hist.clean) {
      restore(hist.base);
      hist.redo.push(cur);
      hist.clean = true;
    } else if (hist.undo.length) {
      restore(hist.undo.pop());
      hist.base = snap();
      hist.redo.push(cur);
    }
    return true;
  };
  const redo = () => {
    if (!hist) return false;
    clearTimeout(histTimer);
    if (hist.redo.length && hist.clean) {
      restore(hist.redo.pop());
      hist.undo.push(hist.base);
      hist.base = snap();
    }
    return true;
  };
  // 手改 DOM 的操作统一从这里走：先接管撤销，操作前后的状态各记一步。
  // 节点被搬走时浏览器把选区留在原地（DOM 规定如此，不跟着节点走）——所以按操作前记下的
  // 书签把光标放回去；fn 自己摆好光标的（包代码、插表格…）返回 'keep' 表示不用放
  const manual = (fn) => {
    takeOver();
    commit();
    const bm = bookmark();
    let res = false;
    try { res = fn(); } catch (e) { res = false; }
    if (res !== 'keep') restoreBookmark(bm);
    if (container.innerHTML !== hist.base.html) { hist.clean = false; commit(); }
    return res === 'keep' ? true : res;
  };
  // 原生命令做成了一半／做坏了：整份退回操作前（未接管走原生撤销；退不干净就退回并就此接管）
  const rollback = (pre) => {
    if (container.innerHTML === pre.html) { restoreBookmark(pre.bm); return; }
    if (!hist) { try { document.execCommand('undo'); } catch (e) { /* 撤不动就按现状走 */ } }
    if (container.innerHTML !== pre.html) {
      takeOver();
      container.innerHTML = pre.html;
    }
    focusRoot();
    restoreBookmark(pre.bm);
    if (hist) { hist.base = snap(); hist.clean = true; }
  };

  // ---------- 行内格式 ----------

  const inline = (name) => {
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    const label = name === 'bold' ? '加粗' : name === 'italic' ? '斜体' : '删除线';
    if (r.collapsed) return { ok: false, msg: '先选中文字，再点' + label };
    if (inEl(r.startContainer, 'pre, code') || inEl(r.endContainer, 'pre, code')) return { ok: false, msg: '代码里不加格式' };
    const leaves = touched(r);
    if (leaves.length !== 1) return { ok: false, msg: leaves.length ? ONE_LEAF : NO_CARET };
    // 标题在浏览器里本来就是粗体：在标题里点加粗＝把选中的字变「不粗」（吐 style 的 span），
    // 而 markdown 的标题没有「不粗」——存完就悄悄变回去，干脆不做
    if (name === 'bold' && HEAD.test(tagOf(leaves[0]))) return { ok: false, msg: '标题本来就是粗体' };
    const pre = snap();
    const text = container.textContent;
    let ok = false;
    try { ok = document.execCommand(name === 'strike' ? 'strikeThrough' : name, false, null); } catch (e) { ok = false; }
    if (!ok || container.textContent !== text) { rollback(pre); return { ok: false, msg: BAD }; }
    return { ok: true };
  };

  const toggleCode = () => {
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    const code = inEl(r.startContainer, 'code');
    if (code) {
      if (code.closest('pre')) return { ok: false, msg: '代码块里不加格式' };
      if (inEl(r.endContainer, 'code') !== code) return { ok: false, msg: ONE_LEAF };
      // 已在行内代码里：拆壳
      return manual(() => { unwrap(code); return true; }) ? { ok: true } : { ok: false, msg: BAD };
    }
    if (r.collapsed) return { ok: false, msg: '先选中要设成代码的文字' };
    const leaves = touched(r);
    if (leaves.length !== 1) return { ok: false, msg: leaves.length ? ONE_LEAF : NO_CARET };
    if (inEl(r.endContainer, 'code')) return { ok: false, msg: '代码里不加格式' };
    let frag = null;
    try { frag = r.cloneContents(); } catch (e) { frag = null; }
    if (frag && frag.querySelector && frag.querySelector(ATOMS)) return { ok: false, msg: '代码只能包纯文字，选里有公式或图片' };
    return manual(() => {
      const el = document.createElement('code');
      el.appendChild(r.extractContents());
      r.insertNode(el);
      const rr = document.createRange();
      rr.selectNodeContents(el);
      select(rr);
      focusRoot();
      return 'keep';
    }) ? { ok: true } : { ok: false, msg: BAD };
  };

  // 地址归一：空＝去掉链接；危险协议＝null；没写协议的补 https://
  const safeUrl = (u) => {
    const s = String(u == null ? '' : u).replace(/^\s+|\s+$/g, '');
    if (!s) return '';
    if (/^(javascript|data|vbscript)\s*:/i.test(s)) return null;
    let out = s;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && s.charAt(0) !== '#' && s.charAt(0) !== '/') out = 'https://' + s;
    // 地址里的空格与括号会把 [文字](地址) 撑断：转成百分号编码，往返同形
    return out.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  };
  // 光标／选区所在的那条链接（两头都在里面才算）
  const linkAnchor = (r) => {
    const a = inEl(r.startContainer, 'a');
    return a && a === inEl(r.endContainer, 'a') ? a : null;
  };
  const closeLink = (refocus) => {
    linkEdit = null;
    if (linkRow) linkRow.hidden = true;
    if (refocus) ensure();
  };
  const openLink = () => {
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    const a = linkAnchor(r);
    if (!a && r.collapsed) return { ok: false, msg: '先选中要做成链接的文字' };
    linkEdit = a;
    urlInput.value = a ? String(a.getAttribute('href') || '') : '';
    linkRow.hidden = false;
    urlInput.focus();
    return { ok: true, noop: true };
  };
  // 原生命令没做成时的手改兜底
  const linkManual = (r, a, url) => {
    if (a && inside(container, a)) {
      if (url) a.setAttribute('href', url);
      else unwrap(a);
      return true;
    }
    if (!r || r.collapsed) return false;
    const olds = kids(container.querySelectorAll('a')).filter((x) => hits(r, x));
    for (const x of olds) unwrap(x);
    if (!url) return olds.length > 0;
    const el = document.createElement('a');
    el.setAttribute('href', url);
    el.appendChild(r.extractContents());
    r.insertNode(el);
    const rr = document.createRange();
    rr.selectNodeContents(el);
    select(rr);
    focusRoot();
    return 'keep';
  };
  const applyLink = () => {
    const url = safeUrl(urlInput.value);
    if (url === null) { toast('这个链接地址不支持'); urlInput.focus(); return { ok: true, noop: true }; }
    // 目标链接先记下：closeLink 会把它清掉
    const a = linkEdit && inside(container, linkEdit) ? linkEdit : null;
    closeLink(false);
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    if (inEl(r.startContainer, 'pre, code')) return { ok: false, msg: '代码里不加链接' };
    if (!a && r.collapsed) return { ok: false, msg: '先选中要做成链接的文字' };
    const pre = snap();
    const text = container.textContent;
    let ok = false;
    try {
      if (a) {
        // 整条选中再改地址：只选半截会把一条链接劈成两条
        const rr = document.createRange();
        rr.selectNodeContents(a);
        select(rr);
        ok = document.execCommand(url ? 'createLink' : 'unlink', false, url || null);
      } else if (url) {
        document.execCommand('unlink', false, null); // 选区里已有的链接先拆掉
        ok = document.execCommand('createLink', false, url);
      } else {
        ok = document.execCommand('unlink', false, null); // 清空地址＝去掉选区里的链接
      }
    } catch (e) { ok = false; }
    const linked = !url || kids(container.querySelectorAll('a')).some((x) => x.getAttribute('href') === url);
    const gone = !a || !!url || !inside(container, a);
    if (!ok || container.textContent !== text || !linked || !gone) {
      rollback(pre);
      const r2 = ensure();
      return manual(() => linkManual(r2, a, url)) ? { ok: true } : { ok: false, msg: BAD };
    }
    const now = selRange();
    if (now) { now.collapse(false); select(now); }
    return { ok: true };
  };

  // ---------- 段落类型 ----------

  // 把叶子里的行内内容搬进 to；返回被摘出的子列表（keepLists＝留在里面）
  const fill = (from, to, keepLists) => {
    const subs = [];
    for (const n of kids(from.childNodes)) {
      const t = tagOf(n);
      if (t === 'UL' || t === 'OL') {
        if (keepLists) to.appendChild(n);
        else subs.push(n);
        continue;
      }
      if (t === 'INPUT') continue; // 勾选框不带走
      if (t === 'P' || t === 'DIV') { // 松散包着的块拆壳
        for (const c of kids(n.childNodes)) to.appendChild(c);
        continue;
      }
      to.appendChild(n);
    }
    return subs;
  };
  // 列表项离开列表：前后两截断开（有序列表续上编号），新块落在原位，子列表跟在后面
  const takeOut = (li, el, subs) => {
    const list = li.parentElement;
    const parent = list && list.parentNode;
    if (!parent) { li.replaceWith(el); return el; }
    const lis = kids(list.children).filter((c) => tagOf(c) === 'LI');
    const i = Math.max(0, lis.indexOf(li));
    let rest = null;
    if (i < lis.length - 1) {
      rest = document.createElement(tagOf(list) === 'OL' ? 'ol' : 'ul');
      if (tagOf(list) === 'OL') rest.setAttribute('start', String(listStart(list) + i + 1));
      parent.insertBefore(rest, list.nextSibling);
      for (let j = i + 1; j < lis.length; j++) rest.appendChild(lis[j]);
    }
    parent.insertBefore(el, rest || list.nextSibling);
    let anchor = el;
    for (const s of subs) {
      parent.insertBefore(s, anchor.nextSibling);
      anchor = s;
    }
    list.removeChild(li);
    if (!kids(list.children).some((c) => tagOf(c) === 'LI')) list.remove();
    // 拆出来的子列表之间、子列表与后半截之间若同标签，本来就会被渲染器并成一张
    for (const s of subs) mergeLists(s);
    return el;
  };
  // 非 LI 的叶子换成另一块：子列表跟在后面
  const swapIn = (leaf, el) => {
    const subs = fill(leaf, el);
    leaf.replaceWith(el);
    let anchor = el;
    for (const s of subs) {
      anchor.parentNode.insertBefore(s, anchor.nextSibling);
      anchor = s;
    }
    return el;
  };
  const makeBlock = (leaf, tag) => {
    const el = document.createElement(tag);
    if (tagOf(leaf) === 'LI') return takeOut(leaf, el, fill(leaf, el));
    return swapIn(leaf, el);
  };
  const toTagManual = (leaves, target) => {
    for (const l of leaves) makeBlock(l, target);
    return true;
  };
  // 这一片叶子能不能交给原生 formatBlock：顶层或引用里的正文/标题/空壳 div，且不带块级子元素
  const nativeOk = (l) => {
    const t = tagOf(l);
    if (t !== 'P' && t !== 'DIV' && !HEAD.test(t)) return false;
    if (blocky(l)) return false;
    const p = l.parentElement;
    return !!p && (p === container || tagOf(p) === 'BLOCKQUOTE');
  };
  const toTagNative = (leaves, target) => {
    const pre = snap();
    const text = container.textContent;
    let good = true;
    for (const l of leaves) {
      const parent = l.parentNode;
      const prev = l.previousSibling;
      const t = String(l.textContent || '');
      try {
        const rr = document.createRange();
        rr.selectNodeContents(l);
        select(rr);
        document.execCommand('formatBlock', false, '<' + target + '>');
      } catch (e) { good = false; break; }
      const n = prev ? prev.nextSibling : parent.firstChild;
      // 新块须落在原位、文字一个不少
      if (!n || tagOf(n) !== target.toUpperCase() || String(n.textContent || '') !== t || container.textContent !== text) { good = false; break; }
    }
    if (good) { restoreBookmark(pre.bm); return true; } // 原生 formatBlock 换的是整块元素，光标也留在原地
    rollback(pre);
    return false;
  };
  // 同标签的相邻列表并成一张（前后各看一眼）。Markdown 里两张同类列表挨着，渲染器会并成
  // 一张松散列表（项间多出空行、编号续下去），而序列化器不认松散列表——存完就进不了编辑
  // （2026-11-25 真机实锤）。编辑面里先并好：所见即所存，也不给存档留陷阱
  const mergeLists = (list) => {
    const tag = tagOf(list);
    let cur = list;
    const prev = cur.previousElementSibling;
    if (prev && tagOf(prev) === tag) {
      // 并进前一张（留在原位）：新项接在末尾
      while (cur.firstChild) prev.appendChild(cur.firstChild);
      cur.remove();
      cur = prev;
    }
    const next = cur.nextElementSibling;
    if (next && tagOf(next) === tag) {
      while (next.firstChild) cur.appendChild(next.firstChild);
      next.remove();
    }
    return cur;
  };
  // 叶子变成列表项（连着转的几段归成一张表）
  const promote = (leaf, target) => {
    const li = document.createElement('li');
    if (target === 'task') {
      li.appendChild(checkbox());
      li.appendChild(document.createTextNode(' '));
    }
    fill(leaf, li, true);
    const list = document.createElement(target === 'ol' ? 'ol' : 'ul');
    list.appendChild(li);
    leaf.replaceWith(list);
    mergeLists(list);
    return li;
  };
  // 整张表换类型（加／去勾选框、换 ul/ol）
  const convertList = (list, target) => {
    if (listKind(list) === target) return false;
    const nl = document.createElement(target === 'ol' ? 'ol' : 'ul');
    for (const li of kids(list.children)) {
      if (tagOf(li) !== 'LI') continue;
      const boxes = kids(li.children).filter((c) => tagOf(c) === 'INPUT');
      if (target === 'task' && !boxes.length) {
        li.insertBefore(checkbox(), li.firstChild);
        li.insertBefore(document.createTextNode(' '), li.childNodes[1]);
      } else if (target !== 'task') {
        for (const b of boxes) li.removeChild(b);
      }
      nl.appendChild(li);
    }
    list.replaceWith(nl);
    mergeLists(nl);
    return true;
  };
  const toList = (leaves, target) => {
    let changed = false;
    for (const l of leaves) {
      if (tagOf(l) === 'LI') {
        if (convertList(l.parentElement, target)) changed = true;
      } else {
        promote(l, target);
        changed = true;
      }
    }
    return changed;
  };
  // 叶子的纯文字（换行记成 \n；子列表与勾选框不算）
  const leafText = (el) => {
    let out = '';
    const walk = (n) => {
      if (n.nodeType === 3) { out += String(n.nodeValue || ''); return; }
      const t = tagOf(n);
      if (t === 'BR') { out += '\n'; return; }
      if (t === 'UL' || t === 'OL' || t === 'INPUT') return;
      for (const c of kids(n.childNodes)) walk(c);
    };
    for (const c of kids(el.childNodes)) walk(c);
    return out;
  };
  // 代码块后面得有能落光标的正文块，没有就补一个空段
  const afterBlock = (block) => {
    let next = block.nextElementSibling;
    if (!isTextBlock(next)) {
      const p = emptyP();
      block.parentNode.insertBefore(p, block.nextSibling);
      next = p;
    }
    caretAt(next, true);
  };
  // 相邻的同级正文/标题并成一个代码块；列表项各自成一个（先从列表里拆出来）
  const toCode = (leaves) => {
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = group.map(leafText).join('\n');
      pre.appendChild(code);
      lock(pre);
      if (tagOf(group[0]) === 'LI') takeOut(group[0], pre, []);
      else swapIn(group[0], pre);
      for (let i = 1; i < group.length; i++) group[i].remove();
      group = [];
      afterBlock(pre);
    };
    for (const l of leaves) {
      const prev = group[group.length - 1];
      if (prev && tagOf(l) !== 'LI' && prev.parentElement === l.parentElement && prev.nextElementSibling === l) group.push(l);
      else { flush(); group = [l]; }
    }
    flush();
    return 'keep';
  };
  // 代码块转回正文：行间换行记成 <br>（硬断行），光标落段末
  const preToP = (pre) => {
    const p = document.createElement('p');
    String(pre.textContent || '').replace(/\n$/, '').split('\n').forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(line));
    });
    pre.replaceWith(p);
    caretAt(p, false);
    return 'keep';
  };
  const setBlock = (target) => {
    if (!target) return { ok: true, noop: true };
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    if (cellOf(container, r.startContainer)) return { ok: false, msg: '表格里的文字只改内容，不换段落类型' };
    const leaves = touched(r);
    if (!leaves.length) {
      const pre = soloPre(r);
      if (!pre) return { ok: false, msg: NO_CARET };
      if (target === 'code') return { ok: true, noop: true };
      // 代码块先转回正文，再按需换过去
      if (!manual(() => preToP(pre))) return { ok: false, msg: BAD };
      return target === 'p' ? { ok: true } : setBlock(target);
    }
    if (target === 'code') {
      if (leaves.some((l) => l.querySelector(ATOMS))) return { ok: false, msg: '代码块只能放纯文字，这段里有公式或图片' };
      return manual(() => toCode(leaves)) ? { ok: true } : { ok: false, msg: BAD };
    }
    if (target === 'ul' || target === 'ol' || target === 'task') {
      const lists = [];
      let allLi = true;
      for (const l of leaves) {
        if (tagOf(l) !== 'LI') { allLi = false; continue; }
        if (lists.indexOf(l.parentElement) < 0) lists.push(l.parentElement);
      }
      if (allLi && lists.every((x) => listKind(x) === target)) return { ok: true, noop: true, msg: '已经是这种列表了' };
      return manual(() => toList(leaves, target)) ? { ok: true } : { ok: false, msg: BAD };
    }
    const tag = String(target).toLowerCase();
    if (tag !== 'p' && !HEAD.test(tag.toUpperCase())) return { ok: false };
    if (leaves.every(nativeOk) && toTagNative(leaves, tag)) return { ok: true };
    const r2 = ensure();
    const ls = r2 ? touched(r2) : [];
    if (!ls.length) return { ok: false, msg: NO_CARET };
    return manual(() => toTagManual(ls, tag)) ? { ok: true } : { ok: false, msg: BAD };
  };
  // 引用＝容器：整段（列表整表）包进 blockquote／再点一次拆出来
  const toggleQuote = () => {
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    if (cellOf(container, r.startContainer)) return { ok: false, msg: '表格里不加引用' };
    const leaves = touched(r);
    if (!leaves.length) return { ok: false, msg: NO_CARET };
    const allIn = leaves.every((l) => !!quoteOf(container, l));
    return manual(() => {
      if (allIn) {
        const qs = [];
        for (const l of leaves) {
          const q = quoteOf(container, l);
          if (q && qs.indexOf(q) < 0) qs.push(q);
        }
        for (const q of qs) {
          const parent = q.parentNode;
          while (q.firstChild) parent.insertBefore(q.firstChild, q);
          q.remove();
        }
        return true;
      }
      const units = [];
      for (const l of leaves) {
        const u = unitOf(container, l);
        if (u && units.indexOf(u) < 0) units.push(u);
      }
      if (!units.length) return false;
      const q = document.createElement('blockquote');
      units[0].parentNode.insertBefore(q, units[0]);
      for (const u of units) q.appendChild(u);
      // 前一个块也是引用就并进去（Markdown 里相邻两段引用本来就是一段）
      const prev = q.previousElementSibling;
      if (prev && tagOf(prev) === 'BLOCKQUOTE') {
        while (q.firstChild) prev.appendChild(q.firstChild);
        q.remove();
      }
      return true;
    }) ? { ok: true } : { ok: false, msg: BAD };
  };

  // ---------- 插入 ----------

  // 顶层正文／标题里走原生（可撤销）：段落从光标处分开，分隔线落在中间，后面跟一个空段。
  // 落点逐次校验（线前／线后的文字要与光标前／后一致）——insertHTML 在文末会落错位置
  const insertHr = () => {
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    if (cellOf(container, r.startContainer)) return { ok: false, msg: '表格里不插分隔线' };
    const leaves = touched(r);
    if (!leaves.length) return { ok: false, msg: NO_CARET };
    const leaf = leaves[0];
    if (!hist && nativeOk(leaf) && unitOf(container, leaf) === leaf) {
      if (!r.collapsed) { r.collapse(false); select(r); }
      const pre = snap();
      const strip = (s) => String(s || '').replace(/\s+/g, '');
      const orig = strip(container.textContent);
      const cr = document.createRange();
      cr.setStart(container, 0);
      cr.setEnd(r.startContainer, r.startOffset);
      const k = strip(cr.toString()).length;
      let ok = false;
      try { ok = document.execCommand('insertHTML', false, '<hr><p><br></p>'); } catch (e) { ok = false; }
      let done = false;
      if (ok) {
        for (const hr of kids(container.querySelectorAll('hr'))) {
          if (hr.parentElement !== container) continue;
          const np = hr.nextElementSibling;
          const filler = np && tagOf(np) === 'P' && !np.textContent ? np : null;
          const a = document.createRange();
          a.setStart(container, 0);
          a.setEndBefore(hr);
          const b = document.createRange();
          b.setStartAfter(filler || hr);
          b.setEnd(container, container.childNodes.length);
          if (strip(a.toString()) !== orig.slice(0, k) || strip(b.toString()) !== orig.slice(k)) continue;
          let target = filler;
          if (!target) {
            target = emptyP();
            container.insertBefore(target, hr.nextSibling);
          }
          caretAt(target, true);
          done = true;
          break;
        }
      }
      if (done) return { ok: true };
      rollback(pre);
    }
    // 其余位置（列表项／引用里／文末落错回滚后）：插在所在顶层块的后面
    return manual(() => {
      const now = live();
      const ls = now ? touched(now) : [];
      const u = unitOf(container, ls[0] || leaf) || leaf;
      if (!u || !u.parentNode) return false;
      const hr = document.createElement('hr');
      lock(hr);
      const p = emptyP();
      u.parentNode.insertBefore(hr, u.nextSibling);
      u.parentNode.insertBefore(p, hr.nextSibling);
      caretAt(p, true);
      return 'keep';
    }) ? { ok: true } : { ok: false, msg: BAD };
  };
  // 表格：3 列（表头＋两行，空格子）插在所在顶层块的后面，光标落进第一格
  const insertTable = () => {
    const r = ensure();
    if (!r) return { ok: false, msg: NO_CARET };
    const leaves = touched(r);
    if (!leaves.length) return { ok: false, msg: NO_CARET };
    return manual(() => {
      const u = unitOf(container, leaves[0]) || leaves[0];
      if (!u || !u.parentNode) return false;
      const tb = document.createElement('table');
      // 空格子（不放「列 1」占位字——一打字就得先删它）；格线由表格样式自己画
      tb.innerHTML = '<thead><tr><th></th><th></th><th></th></tr></thead><tbody>'
        + '<tr><td></td><td></td><td></td></tr>'.repeat(2) + '</tbody>';
      u.parentNode.insertBefore(tb, u.nextSibling);
      if (!isTextBlock(tb.nextElementSibling)) tb.parentNode.insertBefore(emptyP(), tb.nextSibling);
      const th = tb.querySelector('th');
      if (th) caretAt(th, true);
      return 'keep';
    }) ? { ok: true } : { ok: false, msg: BAD };
  };

  // ---------- 公式（591②，2026-11-25）----------
  // 双击公式（或「＋ 公式」）开编辑行：TeX 输入＋实时预览＋常用符号面板＋行内/独立档。
  // 有本地渲染器（主应用 vendor 的 window.katex）同步渲同步落；没有（预览页）走
  // window.nodeFsTexBridge 过桥渲一回、ack 回来再落 DOM——「预览页零渲染逻辑」红线不破。

  // TeX 从 KaTeX 的 annotation 还原（自包含，不引文件外的 _nodeFsKatexTex）
  const texOf = (el) => {
    const ann = el.querySelector ? el.querySelector('annotation[encoding="application/x-tex"]') : null;
    return ann ? String(ann.textContent || '') : '';
  };
  // 双击落在 .katex-display 内层 .katex 时归到外层：整条才是替换单位，display 不丢
  const texNorm = (el) => {
    const d = el && el.closest ? el.closest('.katex-display') : null;
    return d && inside(container, d) ? d : el;
  };
  const texIsDisplay = (el) => !!(el.classList && el.classList.contains('katex-display'));
  // strict=true 时抛错＝TeX 有误；无渲染器返回 null
  const texRender = (tex, display, strict) => {
    if (typeof window.katex === 'undefined' || !window.katex.renderToString) return null;
    try { return window.katex.renderToString(tex, { throwOnError: !!strict, displayMode: !!display }); }
    catch (e) { return null; }
  };
  // 三态验证：true＝合法（本地渲得出）、false＝有错、null＝无本地渲染器（走桥）。
  // 别拿渲染产物字符串当布尔用——成功时它恒为 truthy，=== true 永远不成立（真机实锤）
  const texValid = (tex, display) => {
    if (typeof window.katex === 'undefined' || !window.katex.renderToString) return null;
    try { window.katex.renderToString(tex, { throwOnError: true, displayMode: !!display }); return true; }
    catch (e) { return false; }
  };
  const texBuildEl = (tex, display) => {
    const html = texRender(tex, display, false);
    if (!html) return null;
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const el = tmp.firstElementChild;
    if (!el || !el.classList || (!el.classList.contains('katex') && !el.classList.contains('katex-display'))) return null;
    lock(el);
    return el;
  };
  // 光标落到公式之后（继续打字）
  const caretAfterEl = (el) => {
    const p = el.parentNode;
    if (!p) return;
    let i = 0;
    while (i < p.childNodes.length && p.childNodes[i] !== el) i++;
    select(point(p, i + 1));
    focusRoot();
  };
  const texHighlight = (el) => {
    const prev = container.querySelector ? container.querySelector('.nfs-fmt-texing') : null;
    if (prev) { try { prev.classList.remove('nfs-fmt-texing'); } catch (e) { /* 沙箱兜底 */ } }
    if (el) { try { el.classList.add('nfs-fmt-texing'); } catch (e) { /* 沙箱兜底 */ } }
  };
  // 预览区：有本地渲染器渲真公式；没有就把预览区藏掉（textarea 本身就在眼前，只摆源码没意义）
  const texPreviewRender = () => {
    if (!texPv) return;
    const tex = String(texInput.value || '');
    const html = tex ? texRender(tex, texMode.value === 'display', false) : null;
    if (html) { texPv.hidden = false; texPv.innerHTML = html; }
    else texPv.hidden = true;
  };
  const closeTex = (refocus) => {
    texHighlight(null);
    texTarget = null;
    texSpot = null;
    texPending = false;
    clearTimeout(texTimer);
    const okBtn = bar && bar.querySelector ? bar.querySelector('[data-fmt="tex-ok"]') : null;
    if (okBtn) okBtn.disabled = false;
    if (texRow) texRow.hidden = true;
    if (refocus) ensure();
  };
  const openTex = (target) => {
    if (!texRow) return { ok: false, msg: BAD };
    closeLink(false);
    texTarget = target || null;
    texSpot = null;
    if (!texTarget) {
      const r = ensure();
      if (!r) { texTarget = null; return { ok: false, msg: NO_CARET }; }
      // 渲染管线对 pre/code 不渲公式（auto-render 默认忽略表），插进去存回来必掉
      if (inEl(r.startContainer, 'pre, code')) { texTarget = null; return { ok: false, msg: '代码里插不了公式' }; }
      if (inEl(r.startContainer, ATOMS)) { texTarget = null; return { ok: false, msg: NO_CARET }; }
      if (!r.collapsed) { r.collapse(false); select(r); } // 有选区＝替换语义（同打字）
      texSpot = snapRange(r);
    }
    texInput.value = texTarget ? texOf(texTarget) : '';
    texMode.value = texTarget && texIsDisplay(texTarget) ? 'display' : 'inline';
    texHighlight(texTarget);
    texPending = false;
    texRow.hidden = false;
    texPreviewRender();
    try { texInput.focus(); texInput.setSelectionRange(texInput.value.length, texInput.value.length); } catch (e) { /* 聚焦失败不挡 */ }
    return { ok: true, noop: true };
  };
  // 应用（确定）：改＝整条换新；插＝落在开行时记下的位置。落 DOM 统一走 manual
  // （接管撤销、快照记步），光标自己摆＝'keep'
  const texDoApply = (tex, display, buildEl) => manual(() => {
    const fresh = buildEl();
    if (!fresh) return false;
    if (texTarget) {
      if (!inside(container, texTarget)) return false; // 保存/撤销后节点已被换掉
      texTarget.replaceWith(fresh);
    } else {
      const r = rangeFrom(texSpot);
      if (!r) return false;
      r.insertNode(fresh);
    }
    caretAfterEl(fresh);
    return 'keep';
  });
  const texApply = () => {
    const tex = String(texInput.value || '').replace(/^\s+|\s+$/g, '');
    const display = texMode.value === 'display';
    if (!tex) {
      // 清空＝删掉这条公式（与链接行「清空地址＝去掉链接」同语）；插入开行清空＝不插了
      if (!texTarget) { closeTex(true); return { ok: true, noop: true }; }
      const gone = manual(() => {
        if (!texTarget || !inside(container, texTarget)) return false;
        texTarget.parentNode.removeChild(texTarget);
        return true;
      });
      closeTex(false);
      return gone ? { ok: true } : { ok: false, msg: BAD };
    }
    const local = texValid(tex, display); // true＝合法；false＝有错；null＝无本地渲染器
    if (local === false) { texPreviewRender(); return { ok: false, msg: 'TeX 写错了，改一改再确定' }; }
    if (local === true) {
      const done = texDoApply(tex, display, () => texBuildEl(tex, display));
      closeTex(false);
      return done ? { ok: true } : { ok: false, msg: BAD };
    }
    // 无本地渲染器（预览页）：过桥渲一回再落 DOM；渲染成败全在主应用那边判
    if (typeof window.nodeFsTexBridge === 'function') {
      texPending = true;
      const okBtn = bar && bar.querySelector ? bar.querySelector('[data-fmt="tex-ok"]') : null;
      if (okBtn) okBtn.disabled = true;
      try {
        window.nodeFsTexBridge(tex, display, (ok, html, msg) => {
          texPending = false;
          if (okBtn) okBtn.disabled = false;
          if (!ok) { toast(msg || '公式渲染不了'); return; }
          const done = texDoApply(tex, display, () => {
            const tmp = document.createElement('div');
            tmp.innerHTML = String(html || '');
            const el = tmp.firstElementChild;
            if (!el) return null;
            lock(el);
            return el;
          });
          if (!done) { toast(BAD); return; }
          closeTex(false);
          onDirty();
          remember();
          refresh();
        });
      } catch (e) { texPending = false; if (okBtn) okBtn.disabled = false; toast(BAD); }
      return { ok: true, noop: true };
    }
    toast('这边渲染不了公式');
    return { ok: true, noop: true };
  };
  // 符号插进 textarea 光标处；tex 带 {} 模板的落在第一个空组里（\frac{}{} 进分子）
  const symIns = (raw) => {
    if (!texInput) return { ok: true, noop: true };
    const tex = String(raw || '');
    if (!tex) return { ok: true, noop: true };
    const v = String(texInput.value || '');
    const st = texInput.selectionStart == null ? v.length : texInput.selectionStart;
    const en = texInput.selectionEnd == null ? st : texInput.selectionEnd;
    texInput.value = v.slice(0, st) + tex + v.slice(en);
    let at = st + tex.length;
    const brace = tex.indexOf('{}');
    if (brace >= 0) at = st + brace + 1;
    try { texInput.focus(); texInput.setSelectionRange(at, at); } catch (e) { /* 摆不进就摆末尾 */ }
    texPreviewRender();
    return { ok: true, noop: true };
  };
  // 常用符号表：字形当按钮面（两处编辑面都不需要渲染器）；[字形, TeX, 中文名(可省)]
  const SYMS = [
    ['希腊', [
      ['α', '\\alpha'], ['β', '\\beta'], ['γ', '\\gamma'], ['δ', '\\delta'],
      ['ε', '\\epsilon'], ['θ', '\\theta'], ['λ', '\\lambda'], ['μ', '\\mu'],
      ['π', '\\pi'], ['ρ', '\\rho'], ['σ', '\\sigma'], ['φ', '\\varphi'],
      ['ω', '\\omega'], ['Δ', '\\Delta'], ['Ω', '\\Omega'],
    ]],
    ['运算', [
      ['×', '\\times'], ['÷', '\\div'], ['±', '\\pm'], ['∓', '\\mp'],
      ['·', '\\cdot'], ['≤', '\\leq'], ['≥', '\\geq'], ['≠', '\\neq'],
      ['≈', '\\approx'], ['≡', '\\equiv'], ['∞', '\\infty'], ['∝', '\\propto'],
    ]],
    ['微积分', [
      ['∑', '\\sum'], ['∏', '\\prod'], ['∫', '\\int'], ['∬', '\\iint'],
      ['∮', '\\oint'], ['∂', '\\partial'], ['∇', '\\nabla'], ['lim', '\\lim', '极限'],
    ]],
    ['集合', [
      ['∈', '\\in'], ['∉', '\\notin'], ['⊂', '\\subset'], ['∪', '\\cup'],
      ['∩', '\\cap'], ['∅', '\\emptyset'], ['∀', '\\forall'], ['∃', '\\exists'], ['¬', '\\neg'],
    ]],
    ['箭头', [
      ['→', '\\to'], ['⇒', '\\Rightarrow'], ['↔', '\\leftrightarrow'], ['↦', '\\mapsto'],
    ]],
    ['结构', [
      ['x/y', '\\frac{}{}', '分式'], ['x²', '^{}', '上标'], ['x₂', '_{}', '下标'],
      ['√', '\\sqrt{}', '根号'], ['→x', '\\vec{}', '矢量'], ['x̂', '\\hat{}', '尖帽'],
      ['x̄', '\\bar{}', '上横线'], ['ẋ', '\\dot{}', '一点'], ['x̃', '\\tilde{}', '波浪'],
      ['°', '^{\circ}', '度数'], ['ℝ', '\\mathbb{R}', '实数集'], ['ℱ', '\\mathcal{F}', '花体字母'],
    ]],
    ['物理', [
      ['ℏ', '\\hbar', '约化普朗克常数'], ['⟨⟩', '\\langle\\rangle', '期望值尖括号'],
      ['≪', '\\ll', '远小于'], ['≫', '\\gg', '远大于'],
    ]],
  ];
  const buildTexRow = (root) => {
    const row = document.createElement('div');
    row.className = 'nfs-fmt-tex';
    row.setAttribute('hidden', '');
    const ta = document.createElement('textarea');
    ta.className = 'nfs-fmt-tex-in';
    ta.rows = 2;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', '公式 TeX');
    ta.setAttribute('placeholder', 'LaTeX，如 \\frac{h}{2\\pi}；改已有公式时留空＝删掉它');
    row.appendChild(ta);
    const pv = document.createElement('div');
    pv.className = 'nfs-fmt-tex-pv';
    pv.setAttribute('hidden', '');
    row.appendChild(pv);
    const syms = document.createElement('div');
    syms.className = 'nfs-fmt-tex-syms';
    for (const grp of SYMS) {
      const label = document.createElement('span');
      label.className = 'nfs-fmt-tex-grp';
      label.textContent = grp[0];
      syms.appendChild(label);
      for (const it of grp[1]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'nfs-fmt-tex-sym';
        b.textContent = it[0];
        b.setAttribute('data-sym', it[1]);
        b.setAttribute('title', it[2] || it[1]);
        b.setAttribute('aria-label', it[2] || it[1]);
        syms.appendChild(b);
      }
    }
    row.appendChild(syms);
    const foot = document.createElement('div');
    foot.className = 'nfs-fmt-tex-foot';
    const mode = document.createElement('select');
    mode.className = 'nfs-fmt-tex-mode';
    mode.setAttribute('title', '行内或独立');
    mode.setAttribute('aria-label', '行内或独立');
    for (const [v, name] of [['inline', '行内公式'], ['display', '独立公式']]) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = name;
      mode.appendChild(o);
    }
    foot.appendChild(mode);
    const note = document.createElement('span');
    note.className = 'nfs-fmt-tex-note';
    note.textContent = '双击正文里的公式也能改';
    foot.appendChild(note);
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'nfs-fmt-b nfs-fmt-txt';
    no.setAttribute('data-fmt', 'tex-no');
    no.textContent = '取消';
    no.setAttribute('title', '放弃公式改动');
    no.setAttribute('aria-label', '放弃公式改动');
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'nfs-fmt-b nfs-fmt-txt nfs-fmt-ok';
    ok.setAttribute('data-fmt', 'tex-ok');
    ok.textContent = '确定';
    ok.setAttribute('title', '应用公式改动');
    ok.setAttribute('aria-label', '应用公式改动');
    foot.appendChild(ok); // 确定在先（与链接行 link-ok/link-no 同约定）
    foot.appendChild(no);
    row.appendChild(foot);
    root.appendChild(row);
    return row;
  };

  // ---------- 状态与工具条 ----------

  // 选区切到的字是否全在匹配 sel 的元素里——沿活 DOM 走，不用 cloneContents：
  // 选区恰好整段选中时克隆片段里没有外层标签（<b> 的 contents 选中＝片段里只剩文字），会误判
  const rangeAll = (r, sel) => {
    let any = false;
    let all = true;
    const w = document.createTreeWalker(elOf(r.commonAncestorContainer) || container, NodeFilter.SHOW_TEXT);
    const rs = point(r.startContainer, r.startOffset);
    const re = point(r.endContainer, r.endOffset);
    let n;
    while ((n = w.nextNode())) {
      if (!n.nodeValue) continue;
      const ns = point(n, 0);
      const ne = point(n, n.nodeValue.length);
      // 交集＝起点取靠后的、终点取靠前的；空交集（贴边）不算切到
      const lo = before(rs, ns) ? ns : rs;
      const hi = before(ne, re) ? ne : re;
      if (!before(lo, hi)) continue;
      any = true;
      if (!inEl(n, sel)) all = false;
    }
    return any && all;
  };
  // 按祖先认，不问 queryCommandState（Chrome 里标题内恒报「已加粗」）
  const inlineState = (r) => {
    const has = (sel) => (r.collapsed ? !!inEl(r.startContainer, sel) : rangeAll(r, sel));
    return { bold: has('b, strong'), italic: has('i, em'), strike: has('strike, s, del'), code: has('code'), link: has('a') };
  };
  const blockState = (r) => {
    if (cellOf(container, r.startContainer)) return { kind: 'cell', inQuote: false };
    const leaves = touched(r);
    if (!leaves.length) return { kind: soloPre(r) ? 'code' : '', inQuote: false };
    const kinds = {};
    let inQuote = true;
    for (const l of leaves) {
      kinds[leafKind(l)] = true;
      if (!quoteOf(container, l)) inQuote = false;
    }
    const ks = Object.keys(kinds);
    return { kind: ks.length === 1 ? ks[0] : 'mixed', inQuote };
  };
  const setPressed = (name, on) => {
    const el = bar.querySelector('[data-fmt="' + name + '"]');
    if (el) el.setAttribute('aria-pressed', on ? 'true' : 'false');
  };
  // 光标在哪就亮哪：五个行内钮的按下态、引用钮、段落类型下拉（输入行开着时不判）
  const refresh = () => {
    if (!bar || !blockSel || !linkRow || !texRow || !linkRow.hidden || !texRow.hidden) return;
    const r = selRange() || rangeFrom(saved);
    const st = r ? inlineState(r) : {};
    const bs = r ? blockState(r) : { kind: '', inQuote: false };
    for (const k of ['bold', 'italic', 'strike', 'code', 'link']) setPressed(k, !!st[k]);
    setPressed('quote', !!bs.inQuote);
    blockSel.value = /^(p|h[1-6]|ul|ol|task|code)$/.test(bs.kind) ? bs.kind : '';
  };

  const run = (name) => {
    // 行内两个输入行的自家人不收行（sym 按钮压根不带 data-fmt，走不到这里）
    const rowless = name === 'link-ok' || name === 'link-no' || name === 'tex-ok' || name === 'tex-no';
    if (!rowless) {
      if (linkRow && !linkRow.hidden) closeLink(false);
      if (texRow && !texRow.hidden) closeTex(false);
    }
    let res;
    try {
      if (name === 'bold' || name === 'italic' || name === 'strike') res = inline(name);
      else if (name === 'code') res = toggleCode();
      else if (name === 'link') res = openLink();
      else if (name === 'link-ok') res = applyLink();
      else if (name === 'link-no') { closeLink(true); res = { ok: true, noop: true }; }
      else if (name === 'quote') res = toggleQuote();
      else if (name === 'hr') res = insertHr();
      else if (name === 'table') res = insertTable();
      else if (name === 'formula') res = openTex(null);
      else if (name === 'tex-ok') res = texApply();
      else if (name === 'tex-no') { closeTex(true); res = { ok: true, noop: true }; }
      else if (name.slice(0, 6) === 'block:') res = setBlock(name.slice(6));
      else res = { ok: false };
    } catch (e) { res = { ok: false, msg: BAD }; }
    // 接管后原生命令（加粗等）的 input 只标了脏：这里立刻记步，一次点击＝一步
    if (hist) { clearTimeout(histTimer); commit(); }
    if (!res || !res.ok) { toast((res && res.msg) || BAD); refresh(); return; }
    if (res.msg) toast(res.msg);
    if (!res.noop) { onDirty(); focusRoot(); remember(); }
    refresh();
  };

  // 工具条 DOM（类名 nfs-fmt-*；样式两处各写一份：graph-override.css 与预览页内嵌）
  const build = () => {
    const root = document.createElement('div');
    root.className = 'nfs-fmt';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', '格式');
    const btn = (name, title, inner, cls, toggle) => '<button type="button" class="nfs-fmt-b' + (cls ? ' ' + cls : '') + '" data-fmt="' + name
      + '" title="' + title + '" aria-label="' + title + '"' + (toggle ? ' aria-pressed="false"' : '') + '>' + inner + '</button>';
    root.innerHTML = '<div class="nfs-fmt-row">'
      + btn('bold', '加粗', 'B', 'nfs-fmt-g nfs-fmt-bold', true)
      + btn('italic', '斜体', 'I', 'nfs-fmt-g nfs-fmt-italic', true)
      + btn('strike', '删除线', 'S', 'nfs-fmt-g nfs-fmt-strike', true)
      + btn('code', '行内代码', '&lt;/&gt;', 'nfs-fmt-mono', true)
      + btn('link', '链接', LINK_SVG, 'nfs-fmt-icon', true)
      + '<span class="nfs-fmt-sep"></span>'
      + '<select class="nfs-fmt-block" title="段落类型" aria-label="段落类型">'
      + '<option value="">段落类型</option><option value="p">正文</option>'
      + '<option value="h1">标题 1</option><option value="h2">标题 2</option><option value="h3">标题 3</option>'
      + '<option value="h4">标题 4</option><option value="h5">标题 5</option><option value="h6">标题 6</option>'
      + '<option value="ul">无序列表</option><option value="ol">有序列表</option><option value="task">待办列表</option>'
      + '<option value="code">代码块</option></select>'
      + btn('quote', '引用（再点取消）', '引用', 'nfs-fmt-txt', true)
      + '<span class="nfs-fmt-sep"></span>'
      + btn('hr', '插入分隔线', '＋ 分隔线', 'nfs-fmt-txt', false)
      + btn('table', '插入表格', '＋ 表格', 'nfs-fmt-txt', false)
      + btn('formula', '插入公式', '＋ 公式', 'nfs-fmt-txt', false)
      + '</div>'
      + '<div class="nfs-fmt-link" hidden>'
      + '<input type="text" class="nfs-fmt-url" placeholder="链接地址，如 example.com；留空＝去掉链接" aria-label="链接地址" spellcheck="false">'
      + btn('link-ok', '确定', '确定', 'nfs-fmt-txt nfs-fmt-ok', false)
      + btn('link-no', '取消', '取消', 'nfs-fmt-txt', false)
      + '</div>';
    buildTexRow(root); // 公式编辑行（591②）：DOM 程序化搭（符号表 60+ 枚，拼串没意义）
    return root;
  };

  // 两处编辑面的接线：返回 { destroy, refresh, escape }
  const mount = (o) => {
    container = o.container;
    bar = o.bar;
    onDirty = o.onDirty || onDirty;
    toast = o.toast || toast;
    saved = null;
    hist = null;
    linkEdit = null;
    blockSel = bar.querySelector('.nfs-fmt-block');
    linkRow = bar.querySelector('.nfs-fmt-link');
    urlInput = bar.querySelector('.nfs-fmt-url');
    texRow = bar.querySelector('.nfs-fmt-tex');
    texInput = bar.querySelector('.nfs-fmt-tex-in');
    texMode = bar.querySelector('.nfs-fmt-tex-mode');
    texPv = bar.querySelector('.nfs-fmt-tex-pv');
    // 关着 styleWithCSS：加粗吐 <b> 不吐 <span style>（序列化器只认前者）
    try {
      cssWas = document.queryCommandState('styleWithCSS');
      document.execCommand('styleWithCSS', false, false);
    } catch (e) { cssWas = false; }
    const hands = [];
    const on = (el, ev, fn) => { el.addEventListener(ev, fn); hands.push([el, ev, fn]); };
    // 按钮按下不抢焦点：选区留在编辑面里，命令才有落点
    on(bar, 'mousedown', (ev) => {
      remember();
      const b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (b && ev.preventDefault) ev.preventDefault();
    });
    on(bar, 'pointerdown', () => { remember(); });
    on(bar, 'click', (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-fmt]') : null;
      if (!b) return;
      if (ev.preventDefault) ev.preventDefault();
      run(String(b.getAttribute('data-fmt') || ''));
    });
    on(blockSel, 'change', () => { run('block:' + String(blockSel.value || '')); });
    on(urlInput, 'keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); run('link-ok'); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeLink(true); }
    });
    // 公式行（591②）：预览跟着打字走（250ms 收敛）；Enter 不接确认——TeX 要多行，
    // 确定只认按钮；Esc 收行让编辑态不动
    on(texInput, 'input', () => { clearTimeout(texTimer); texTimer = setTimeout(texPreviewRender, 250); });
    on(texMode, 'change', () => { texPreviewRender(); });
    on(texInput, 'keydown', (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeTex(true); }
    });
    // 符号面板：往 textarea 光标处插 TeX（data-sym 与 data-fmt 不同名，互不相认）
    on(texRow, 'click', (ev) => {
      const b = ev.target && ev.target.closest ? ev.target.closest('[data-sym]') : null;
      if (!b) return;
      if (ev.preventDefault) ev.preventDefault();
      symIns(String(b.getAttribute('data-sym') || ''));
    });
    // 双击公式＝改 TeX（.katex-display 归到外层整条）；单击照旧只摆光标
    on(container, 'dblclick', (ev) => {
      const k = ev.target && ev.target.closest ? ev.target.closest('.katex, .katex-display') : null;
      if (!k || !inside(container, k)) return;
      if (ev.preventDefault) ev.preventDefault();
      openTex(texNorm(k));
    });
    // 编辑面按键：接管后的撤销／重做；表格里 Tab／Shift+Tab 换格
    on(container, 'keydown', (ev) => {
      const k = String(ev.key || '');
      if (hist && (k === 'z' || k === 'Z' || k === 'y' || k === 'Y') && (ev.ctrlKey || ev.metaKey) && !ev.altKey) {
        const isRedo = (k.toLowerCase() === 'z' && ev.shiftKey) || k.toLowerCase() === 'y';
        ev.preventDefault();
        ev.stopPropagation();
        if (isRedo) { if (redo()) { onDirty(); remember(); } refresh(); }
        else { if (undo()) { onDirty(); remember(); } refresh(); }
        return;
      }
      if (k !== 'Tab' || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const r = selRange();
      const cell = r ? cellOf(container, r.startContainer) : null;
      const table = cell && cell.closest ? cell.closest('table') : null;
      if (!table) return;
      ev.preventDefault();
      ev.stopPropagation();
      const cells = kids(table.querySelectorAll('th, td'));
      const next = cells[cells.indexOf(cell) + (ev.shiftKey ? -1 : 1)];
      if (next) caretAt(next, true);
    });
    // 右键菜单的「撤销」也走接管栈（浏览器原生撤销栈此刻已对不上 DOM）
    on(container, 'beforeinput', (ev) => {
      if (!hist || (ev.inputType !== 'historyUndo' && ev.inputType !== 'historyRedo')) return;
      ev.preventDefault();
      if (ev.inputType === 'historyUndo') undo();
      else redo();
      onDirty();
      remember();
      refresh();
    });
    on(container, 'input', onInput);
    // 编辑态点代码块＝整块选中（下拉里就能看到「代码块」，再选「正文」转回去）
    on(container, 'click', (ev) => {
      const pre = ev.target && ev.target.closest ? ev.target.closest('pre') : null;
      if (!pre || !inside(container, pre) || pre === container) return;
      const r = document.createRange();
      r.selectNode(pre);
      select(r);
      remember();
      refresh();
    });
    on(document, 'selectionchange', () => {
      remember();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 60);
    });
    remember();
    refresh();
    return {
      destroy() {
        clearTimeout(histTimer);
        clearTimeout(refreshTimer);
        clearTimeout(texTimer);
        for (const h of hands) { try { h[0].removeEventListener(h[1], h[2]); } catch (e) { /* 沙箱兜底 */ } }
        try { document.execCommand('styleWithCSS', false, !!cssWas); } catch (e) { /* 沙箱兜底 */ }
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        hist = null;
        saved = null;
        linkEdit = null;
        texTarget = null;
        texSpot = null;
        texPending = false;
        container = null;
      },
      refresh,
      // Esc 先收公式行／链接输入行；都没开着返回 false（调用方照常处理 Esc）
      escape() {
        if (texRow && !texRow.hidden) { closeTex(true); return true; }
        if (!linkRow || linkRow.hidden) return false;
        closeLink(true);
        return true;
      },
    };
  };

  return { atoms: ATOMS, build, mount, safeUrl };
}
