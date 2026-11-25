// ===== 渲染态编辑·格式工具条（2026-11-25，backlog 591①）=====
// 全屏层（node-fs-edit.js）与新窗口预览页（node-fs-toolbar.js 内嵌脚本）共用：本文件只有一个
// 自包含工厂 _nodeFsFmtKit——函数体不引用本文件之外的名字（只用 document/window 这类真全局）。
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
  // 光标在哪就亮哪：五个行内钮的按下态、引用钮、段落类型下拉
  const refresh = () => {
    if (!bar || !blockSel || !linkRow || !linkRow.hidden) return;
    const r = selRange() || rangeFrom(saved);
    const st = r ? inlineState(r) : {};
    const bs = r ? blockState(r) : { kind: '', inQuote: false };
    for (const k of ['bold', 'italic', 'strike', 'code', 'link']) setPressed(k, !!st[k]);
    setPressed('quote', !!bs.inQuote);
    blockSel.value = /^(p|h[1-6]|ul|ol|task|code)$/.test(bs.kind) ? bs.kind : '';
  };

  const run = (name) => {
    if (name !== 'link-ok' && name !== 'link-no' && linkRow && !linkRow.hidden) closeLink(false);
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
      + '</div>'
      + '<div class="nfs-fmt-link" hidden>'
      + '<input type="text" class="nfs-fmt-url" placeholder="链接地址，如 example.com；留空＝去掉链接" aria-label="链接地址" spellcheck="false">'
      + btn('link-ok', '确定', '确定', 'nfs-fmt-txt nfs-fmt-ok', false)
      + btn('link-no', '取消', '取消', 'nfs-fmt-txt', false)
      + '</div>';
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
        for (const h of hands) { try { h[0].removeEventListener(h[1], h[2]); } catch (e) { /* 沙箱兜底 */ } }
        try { document.execCommand('styleWithCSS', false, !!cssWas); } catch (e) { /* 沙箱兜底 */ }
        if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
        hist = null;
        saved = null;
        linkEdit = null;
        container = null;
      },
      refresh,
      // Esc 先收链接输入行；没开着返回 false（调用方照常处理 Esc）
      escape() {
        if (!linkRow || linkRow.hidden) return false;
        closeLink(true);
        return true;
      },
    };
  };

  return { atoms: ATOMS, build, mount, safeUrl };
}
