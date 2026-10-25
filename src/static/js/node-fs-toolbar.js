// ===== 节点全屏划词快捷工具（2026-10-25 计划落地）=====
// 两层结构：动作层只此一份（本文件，在主应用里执行）；浮条 UI 两份——
// ①本页全屏阅读层（.graph-node-fs-overlay）一份，选区提取＋动作就地执行；
// ②新窗口预览页一份自包含脚本（_buildNodeFsPreviewScript 生成字符串，由
//   graph-custom._buildContentPreviewPage 塞进页面），按钮不直接干活，
//   postMessage 送回主应用执行同一套动作。
// 加载期零副作用：只注册监听，不读画布状态；画布函数全部运行期 typeof 守卫调用。
// 拍板记录（计划第 9 节）：追问＝A 先预填再发；「⋯」保留（查找＋引用两枚）。

const NODE_FS_BRIDGE_ACTIONS = ['followup', 'collectFormula', 'search']; // quote/copy 页内完成，不过桥
const NODE_FS_FOLLOWUP_DEFAULT = '请把这段再展开讲讲';
const NODE_FS_EXCERPT_MAX = 2000;   // 追问引文截断（超出标注「已取前 2000 字」）
const NODE_FS_EXCERPT_LINES = 3;    // 引文最多带 3 行
const NODE_FS_BRIDGE_TEXT_MAX = 20000; // 桥上文本上限（超限截断不报错）
const NODE_FS_SEARCH_SNIPPET_MAX = 40; // 在画布中查找：取选段前 40 字

let _nfsBar = null;         // 浮条单例（出现即重建，收起即移除，不做显隐切换）
let _nfsState = null;       // { overlay, container, nodeId, nodeTitle, fullText, hasFormula, rect, expanded, quoteDropped }
let _nfsSelTimer = 0;
let _nfsPreviewCtx = null;  // { token, nodeId, sessionId, title, win }（新窗口桥的接收端上下文）

// ---------- 选区提取（KaTeX 还原 LaTeX） ----------

function _nodeFsClosestKatex(node) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
  while (el) {
    if (el.classList && el.classList.contains('katex')) return el;
    el = el.parentElement;
  }
  return null;
}

// 选区克隆成纯文本；.katex 用 annotation 里的 x-tex 还原成 $...$ / $$...$$。
// 端点落在公式中间（半截 DOM、annotation 丢失）时扩成整条公式——宁可多带一个符号，
// 不复制出「a2+b2」这种残废。返回 { text, hasFormula, rect }，rect 取最后一行（多行锚点）。
function _nodeFsPickSelection(container) {
  if (!container || !container.contains) return null;
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  let r = range;
  try {
    const sk = _nodeFsClosestKatex(range.startContainer);
    const ek = _nodeFsClosestKatex(range.endContainer);
    if (sk || ek) {
      r = range.cloneRange();
      if (sk) r.setStartBefore(sk);
      if (ek) r.setEndAfter(ek);
    }
  } catch (e) { /* 拿不到就按原样提取 */ }
  let frag;
  try { frag = r.cloneContents(); } catch (e) { return null; }
  const hasKatex = !!(frag.querySelector && frag.querySelector('.katex'));
  if (frag.querySelectorAll) {
    const ks = frag.querySelectorAll('.katex');
    for (let i = ks.length - 1; i >= 0; i--) {
      const k = ks[i];
      const ann = k.querySelector ? k.querySelector('annotation[encoding="application/x-tex"]') : null;
      const tex = ann ? ann.textContent : '';
      const display = k.classList.contains('katex-display') || !!k.closest('.katex-display');
      const repl = tex ? (display ? '$$' + tex + '$$' : '$' + tex + '$') : (k.textContent || '');
      const tn = document.createTextNode(repl);
      if (k.replaceWith) k.replaceWith(tn);
      else if (k.parentNode) k.parentNode.replaceChild(tn, k);
    }
  }
  const text = String(frag.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 2) return null; // 至少 2 个字
  const hasFormula = hasKatex || /\$\$[\s\S]+?\$\$|\$[^$\n]+?\$/.test(text);
  let rect = null;
  try {
    const rects = r.getClientRects ? r.getClientRects() : [];
    rect = (rects && rects.length) ? rects[rects.length - 1] : r.getBoundingClientRect();
  } catch (e) { rect = null; }
  return { text, hasFormula, rect };
}

// 追问引文：掐头去尾空行 → 最多 3 行 → 最多 2000 字，返回 { excerpt, truncated }
function _nodeFsBuildExcerpt(text) {
  const lines = String(text || '').split('\n');
  while (lines.length && !lines[0].replace(/\s/g, '')) lines.shift();
  while (lines.length && !lines[lines.length - 1].replace(/\s/g, '')) lines.pop();
  let truncated = lines.length > NODE_FS_EXCERPT_LINES;
  let excerpt = lines.slice(0, NODE_FS_EXCERPT_LINES).join('\n');
  if (excerpt.length > NODE_FS_EXCERPT_MAX) {
    excerpt = excerpt.slice(0, NODE_FS_EXCERPT_MAX);
    truncated = true;
  }
  return { excerpt, truncated };
}

// ---------- 浮条（本页全屏层用；预览页有自己的一份内嵌实现） ----------

function _nodeFsHideBar() {
  if (_nfsSelTimer) { clearTimeout(_nfsSelTimer); _nfsSelTimer = 0; }
  if (_nfsBar) { _nfsBar.remove(); _nfsBar = null; }
  _nfsState = null;
}

function _nodeFsButtonHtml(act, label, icon, primary) {
  return '<button type="button" class="node-fs-btn' + (primary ? ' node-fs-btn--primary' : '')
    + '" data-act="' + act + '" data-icon="' + icon + '" aria-label="' + label + '" title="' + label + '">'
    + '<span class="node-fs-btn-label">' + label + '</span></button>';
}

function _nodeFsShowBar(overlay, container, picked) {
  _nodeFsHideBar();
  const overlayNode = overlay || document.querySelector('.graph-node-fs-overlay');
  if (!overlayNode) return;
  const nodeId = (overlayNode.dataset && overlayNode.dataset.nodeFsId) || '';
  const nodeTitle = (overlayNode.dataset && overlayNode.dataset.nodeFsTitle) || '';
  _nfsState = {
    overlay: overlayNode,
    container,
    nodeId,
    nodeTitle,
    fullText: picked.text,
    hasFormula: !!picked.hasFormula,
    rect: picked.rect,
    expanded: false,
    quoteDropped: false,
  };
  const readonly = typeof phyIsReadonly === 'function' && phyIsReadonly();
  const bar = document.createElement('div');
  bar.className = 'node-fs-bar aurora-glass aurora-glass--compact';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '划词快捷工具');
  let html = '';
  if (!readonly) html += _nodeFsButtonHtml('followup', '追问', '？', true);
  html += _nodeFsButtonHtml('copy', '复制', '⧉', false);
  if (!readonly && picked.hasFormula) html += _nodeFsButtonHtml('collectFormula', '收藏公式', '★', false);
  html += '<button type="button" class="node-fs-btn node-fs-btn--more" data-act="more" aria-label="更多操作" title="更多操作" aria-haspopup="true">⋯</button>';
  html += '<div class="node-fs-more" hidden>'
    + '<button type="button" class="node-fs-btn node-fs-menu-item" data-act="search">在画布中查找</button>'
    + '<button type="button" class="node-fs-btn node-fs-menu-item" data-act="quote">复制为引用</button>'
    + '</div>';
  bar.innerHTML = html;
  bar.style.visibility = 'hidden';
  overlayNode.appendChild(bar);
  _nfsBar = bar;
  _nodeFsPlaceBar(picked.rect);
  bar.style.visibility = '';
}

function _nodeFsPlaceBar(rect) {
  const bar = _nfsBar;
  if (!bar) return;
  const vw = window.innerWidth || 1200;
  const vh = window.innerHeight || 800;
  const bw = bar.offsetWidth || 160;
  const bh = bar.offsetHeight || 36;
  const anchorLeft = rect && Number.isFinite(rect.left) ? rect.left : 12;
  const anchorTop = rect && Number.isFinite(rect.top) ? rect.top : 24;
  const anchorBottom = rect && Number.isFinite(rect.bottom) ? rect.bottom : anchorTop + 24;
  let touch = false;
  try { touch = typeof matchMedia === 'function' && matchMedia('(hover: none)').matches; } catch (e) { /* 桌面口径 */ }
  // 触摸端放选区上方，避开系统选择手柄；桌面优先下方 8px，空间不足翻上方；左右夹视口 8px
  let left = Math.min(Math.max(8, anchorLeft), Math.max(8, vw - bw - 8));
  let top = touch ? Math.max(8, anchorTop - bh - 8) : anchorBottom + 8;
  if (!touch && top + bh > vh - 8) top = Math.max(8, anchorTop - bh - 8);
  bar.style.left = left + 'px';
  bar.style.top = top + 'px';
}

function _nodeFsRunAction(act) {
  const st = _nfsState;
  const bar = _nfsBar;
  if (!st || !bar) return;
  if (act === 'more') {
    const menu = bar.querySelector('.node-fs-more');
    if (menu) menu.hidden = !menu.hidden;
    return;
  }
  if (act === 'delquote') {
    st.quoteDropped = true;
    const row = bar.querySelector('.node-fs-quote-row');
    if (row) row.remove();
    return;
  }
  if (act === 'send') { _nodeFsSendFollowup(); return; }
  const node = (st.nodeId && typeof _findGraphNode === 'function') ? _findGraphNode(st.nodeId) : null;
  if (act === 'copy') { _nodeFsCopyText(st.fullText); _nodeFsHideBar(); return; }
  if (act === 'quote') {
    const body = String(st.fullText || '').split('\n').map(l => '> ' + l).join('\n');
    _nodeFsCopyText(body + '\n\n—— 《' + (st.nodeTitle || '节点') + '》');
    _nodeFsHideBar();
    return;
  }
  if (act === 'collectFormula') {
    _nodeFsCollectFormulas(st.fullText, node, st.nodeTitle);
    _nodeFsHideBar();
    return;
  }
  if (act === 'search') {
    _nodeFsSearchCanvas(st.fullText);
    _nodeFsHideBar();
    return;
  }
}

// 追问（A 拍板：先预填再发）——浮条原地展开输入行，不重建浮条（避免失焦）。
// 输入行是浮条的一部分：Esc/点外仍按「先收浮条再关全屏」整体收。
function _nodeFsExpandInput() {
  const st = _nfsState;
  const bar = _nfsBar;
  if (!st || !bar || st.expanded) return;
  st.expanded = true;
  bar.classList.add('node-fs-bar--expanded');
  const q = _nodeFsBuildExcerpt(st.fullText);
  const chip = q.excerpt
    ? '<div class="node-fs-quote-row"><span class="node-fs-quote-chip" title="'
      + _nodeFsEscAttr(q.excerpt) + '">【聚焦选段】' + _nodeFsEscHtml(String(q.excerpt).replace(/\s+/g, ' ').slice(0, 60)) + '</span>'
      + '<button type="button" class="node-fs-quote-del" data-act="delquote" aria-label="移除引文" title="发送时不带这段引文">×</button></div>'
    : '';
  bar.innerHTML = chip
    + '<div class="node-fs-input-row">'
    + '<input type="text" class="node-fs-input" aria-label="追问内容" placeholder="想追问什么？（留空用默认问句）">'
    + (q.truncated ? '<span class="node-fs-trunc">已取前 2000 字</span>' : '')
    + '<button type="button" class="node-fs-btn node-fs-btn--primary" data-act="send">发送</button>'
    + '</div>';
  const input = bar.querySelector('.node-fs-input');
  if (input) {
    input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') { ev.preventDefault(); _nodeFsSendFollowup(); }
    });
    input.focus();
  }
  _nodeFsPlaceBar(st.rect);
}

function _nodeFsComposeFollowup(question, quote) {
  if (!quote) return question;
  return question + '\n\n【聚焦选段】\n' + String(quote).split('\n').map(l => '> ' + l).join('\n');
}

function _nodeFsSendFollowup() {
  const st = _nfsState;
  const bar = _nfsBar;
  if (!st) return;
  const input = bar ? bar.querySelector('.node-fs-input') : null;
  const question = (((input && input.value) || '').trim()) || NODE_FS_FOLLOWUP_DEFAULT;
  const quote = st.quoteDropped ? '' : _nodeFsBuildExcerpt(st.fullText).excerpt;
  const composed = _nodeFsComposeFollowup(question, quote);
  const nodeId = st.nodeId;
  _nodeFsHideBar();
  if (typeof closeNodeFullscreen === 'function') closeNodeFullscreen(); // 镜头要回到画布
  const node = (nodeId && typeof _findGraphNode === 'function') ? _findGraphNode(nodeId) : null;
  if (!node) {
    if (typeof showToast === 'function') showToast('源节点已不在画布上，追问没有落点');
    return;
  }
  // 端口优先取「追问」族输出口（_branchSourcePort 同分支拓展口径），没有退 out-0
  const port = (typeof _branchSourcePort === 'function') ? _branchSourcePort(node, 'followup') : 'out-0';
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(composed, { sourceNodeId: node.id, sourcePort: port, queueLabel: '追问' });
  } else if (typeof showToast === 'function') {
    showToast('发送链暂不可用');
  }
}

// ---------- 动作层共用件（本页与桥接收端两路共用） ----------

function _nodeFsCopyText(text) {
  const value = String(text || '');
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      return !!ok;
    } catch (e) { return false; }
  };
  const done = ok => { if (typeof showToast === 'function') showToast(ok ? '已复制' : '复制失败，请手动选择复制'); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(value).then(() => done(true), () => done(fallback()));
  } else {
    done(fallback());
  }
}

function _nodeFsSearchCanvas(text) {
  const q = String(text || '').replace(/\s+/g, ' ').trim().slice(0, NODE_FS_SEARCH_SNIPPET_MAX);
  if (typeof closeNodeFullscreen === 'function') closeNodeFullscreen(); // 搜索面板在画布层，别被全屏盖住
  if (typeof openGraphSearchPanel !== 'function') {
    if (typeof showToast === 'function') showToast('搜索面板未就绪');
    return;
  }
  openGraphSearchPanel();
  const input = document.getElementById('graphSearchInput');
  if (input) input.value = q;
  if (typeof graphSearchInputChanged === 'function') graphSearchInputChanged(q); // 140ms 防抖后当场搜
}

// 收藏公式：选段文本里成对的 $...$ / $$...$$（katex 已在提取时还原成同款文本），
// 去重后走 saveFormulasToServer（语义归一＋入缓存＋排队 POST，与服务端闸门同款过滤）
function _nodeFsFormulaItems(text, node, nodeTitle) {
  const title = nodeTitle || (node ? ((typeof _nodeFsTitle === 'function' ? _nodeFsTitle(node) : (node.label || '节点内容'))) : '');
  const items = [];
  const seen = new Set();
  const src = String(text || '');
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let m;
  while ((m = re.exec(src))) {
    const latex = String(m[1] || m[2] || '').trim();
    if (!latex || seen.has(latex)) continue;
    if (typeof _looksLikeFormula === 'function' && !_looksLikeFormula(latex)) continue;
    seen.add(latex);
    items.push({
      latex,
      concept: title,
      meaning: '划词收藏',
      meaningSource: 'local',
      sessionId: (typeof currentSessionId !== 'undefined' && currentSessionId) || '',
      nodeId: node ? String(node.id || '') : '',
    });
  }
  return items;
}

function _nodeFsCollectFormulas(text, node, nodeTitle) {
  if (typeof phyIsReadonly === 'function' && phyIsReadonly()) {
    if (typeof phyReadonlyBlock === 'function') phyReadonlyBlock('收藏公式');
    return;
  }
  const items = _nodeFsFormulaItems(text, node, nodeTitle);
  if (!items.length) {
    if (typeof showToast === 'function') showToast('选区里没有可解析的公式');
    return;
  }
  if (typeof saveFormulasToServer !== 'function') {
    if (typeof showToast === 'function') showToast('公式库暂不可用');
    return;
  }
  saveFormulasToServer(items);
  if (typeof renderFormulaList === 'function') { try { renderFormulaList(); } catch (e) { /* 面板未开不打断 */ } }
  if (typeof showToast === 'function') showToast('已收藏 ' + items.length + ' 条公式到公式速查');
}

// ---------- 主应用侧：新窗口桥接收端 ----------

function _nodeFsMintPreviewToken() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'nfs_' + crypto.randomUUID().replace(/-/g, '');
  } catch (e) { /* 非安全上下文走兜底 */ }
  return 'nfs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// openNodeNewWindow（graph-custom.js）在开窗前登记上下文，开窗成功后补 win 引用
function _setNodeFsPreviewCtx(ctx) { _nfsPreviewCtx = ctx || null; }

function _attachNodeFsPreviewWin(win) {
  if (_nfsPreviewCtx) _nfsPreviewCtx.win = win || null;
}

// 预览窗关掉后上下文失效（轮询兜底；收消息时也会用 win.closed 复核）
setInterval(() => {
  if (_nfsPreviewCtx && _nfsPreviewCtx.win && _nfsPreviewCtx.win.closed) _nfsPreviewCtx = null;
}, 3000);

window.addEventListener('message', ev => {
  const ctx = _nfsPreviewCtx;
  if (!ctx || !ctx.win || ev.source !== ctx.win) return; // 只认当前预览窗口
  const d = ev.data;
  if (!d || d.__phymathia !== 1 || d.kind !== 'node-fs-action') return;
  if (NODE_FS_BRIDGE_ACTIONS.indexOf(d.action) < 0) return; // 动作白名单
  if (typeof d.token !== 'string' || d.token !== ctx.token) return; // 一次性 token
  const text = String(d.text || '').slice(0, NODE_FS_BRIDGE_TEXT_MAX);
  const node = (ctx.nodeId && typeof _findGraphNode === 'function') ? _findGraphNode(ctx.nodeId) : null;
  let ok = true;
  let message = '已转到主应用';
  if (!node) { ok = false; message = '源节点已不在画布上'; }
  else if (String(ctx.sessionId || '') !== String((typeof currentSessionId !== 'undefined' && currentSessionId) || '')) {
    ok = false; message = '请先切回原画布再继续'; // 不跨会话建点
  }
  if (ok) {
    try { window.focus(); } catch (e) { /* 聚焦尽力而为 */ }
    try {
      if (d.action === 'followup') _nodeFsBridgedFollowup(node, text);
      else if (d.action === 'collectFormula') _nodeFsBridgedCollect(node, text);
      else if (d.action === 'search') _nodeFsBridgedSearch(node, text);
    } catch (e) { ok = false; message = '主应用执行失败'; }
  }
  // token 一次性：本轮消费掉，随 ack 轮换新 token 发回（重放的旧消息不再被认）
  const nextToken = _nodeFsMintPreviewToken();
  ctx.token = nextToken;
  try {
    ev.source.postMessage(
      { kind: 'node-fs-ack', __phymathia: 1, token: d.token, ok, message, nextToken },
      location.origin,
    );
  } catch (e2) { /* 预览窗已关，无从应答 */ }
});

// 桥上追问：主应用聚焦 → 打开同一节点的全屏层 → 原地展开追问输入行（引文预填），
// 用户补一句再发——「先预填再发」的 A 口径在主应用这侧收口
function _nodeFsBridgedFollowup(node, text) {
  if (typeof closeNodeFullscreen === 'function') closeNodeFullscreen();
  if (typeof openNodeFullscreen === 'function') openNodeFullscreen(node.id);
  const overlay = document.querySelector('.graph-node-fs-overlay');
  if (!overlay) {
    if (typeof showToast === 'function') showToast('全屏层打开失败，请直接在画布上追问');
    return;
  }
  const content = overlay.querySelector('.graph-node-fs-content');
  if (!content) return;
  const vw = window.innerWidth || 1200;
  const picked = {
    text: String(text || ''),
    hasFormula: false,
    rect: { left: Math.max(8, Math.round(vw / 2 - 180)), top: 96, bottom: 120 },
  };
  _nodeFsShowBar(overlay, content, picked);
  _nodeFsExpandInput();
}

function _nodeFsBridgedCollect(node, text) {
  // 收藏直接落公式速查（开全屏反而盖住结果面板），toast 确认
  _nodeFsCollectFormulas(text, node, '');
}

function _nodeFsBridgedSearch(node, text) {
  _nodeFsSearchCanvas(text);
}

// ---------- 本页全屏层接线（graph-custom.openNodeFullscreen 调用） ----------

function attachNodeFsSelectionBar(overlay) {
  // 监听是全局常驻的，这里只清上一轮残留（浮条随旧 overlay 移除，状态跟着清）
  _nodeFsHideBar();
}

function _nodeFsOnSelectionSettled() {
  const overlay = document.querySelector('.graph-node-fs-overlay');
  if (!overlay) { _nodeFsHideBar(); return; }
  if (_nfsState && _nfsState.expanded) return; // 输入行展开时不重判（用户在打字）
  const content = overlay.querySelector('.graph-node-fs-content');
  if (!content) return;
  const picked = _nodeFsPickSelection(content);
  if (!picked) { _nodeFsHideBar(); return; }
  _nodeFsShowBar(overlay, content, picked);
}

document.addEventListener('selectionchange', () => {
  if (_nfsSelTimer) clearTimeout(_nfsSelTimer);
  _nfsSelTimer = setTimeout(_nodeFsOnSelectionSettled, 180); // 停止变化 180ms 再查，拖选多行不闪
});

document.addEventListener('pointerdown', ev => {
  if (_nfsBar && !_nfsBar.contains(ev.target)) _nodeFsHideBar();
}, true);

document.addEventListener('click', ev => {
  if (!_nfsBar) return;
  const t = ev.target;
  const btn = t && t.closest ? t.closest('[data-act]') : null;
  if (btn && _nfsBar.contains(btn)) {
    ev.preventDefault();
    _nodeFsRunAction(btn.getAttribute('data-act'));
  }
});

// Esc capture：先收浮条并断掉传播，ui.js 的「Esc 关全屏」这一轮就不触发——
// 第二次按 Esc 浮条已不在，才轮到关全屏
document.addEventListener('keydown', ev => {
  if (ev.key !== 'Escape' || !_nfsBar) return;
  ev.preventDefault();
  ev.stopPropagation();
  _nodeFsHideBar();
}, true);

// scroll 不冒泡但 capture 能收到：正文滚动即收，浮条不遮刚读的那一行
document.addEventListener('scroll', () => { if (_nfsBar) _nodeFsHideBar(); }, true);
window.addEventListener('resize', () => { if (_nfsBar) _nodeFsHideBar(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && _nfsBar) _nodeFsHideBar(); });

// ---------- 预览页内嵌自包含脚本（字符串生成，不放 /js/ 外链） ----------
// file:// 单文件（bridge:false）与新窗口沙箱 iframe（bridge:true）两种场景都能跑，
// 不受构建改名影响。页面是深色定版，样式由脚本注入，与主应用浮条同类名视觉。

function _nodeFsEscHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function _nodeFsEscAttr(s) {
  return _nodeFsEscHtml(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


// 内嵌脚本＝主应用浮条的过桥精简版：选区提取与 LaTeX 还原同款，按钮只两栖——
// 复制/复制为引用在页内完成；追问/收藏公式/在画布中查找 postMessage 送回主应用
// （追问不内嵌输入行：点追问即过桥，主应用打开全屏层展开预填输入行，
// A 口径的输入实现只有一份）。token 一次性，ack 里轮换回来的新 token 接着用。
function _buildNodeFsPreviewScript(cfg) {
  const conf = {
    bridge: !!(cfg && cfg.bridge),
    token: String((cfg && cfg.token) || ''),
    nodeId: String((cfg && cfg.nodeId) || ''),
    title: String((cfg && cfg.title) || ''),
  };
  const json = JSON.stringify(conf).replace(/<\//g, '<\\/'); // 防标题带 </script> 提前闭合
  return '(function(){'
    + 'var CFG=' + json + ';'
    + 'var TOKEN=CFG.token||"";'
    + 'var BRIDGE=!!CFG.bridge;'
    + 'var MAX_TEXT=' + NODE_FS_BRIDGE_TEXT_MAX + ';'
    + 'var bar=null,picked=null,selTimer=0;'
    + 'var style=document.createElement("style");'
    + 'style.textContent=".cp-nfs-bar{position:fixed;z-index:60;display:flex;align-items:center;gap:2px;padding:4px;'
    + 'border-radius:999px;background:rgba(15,21,48,.92);border:1px solid rgba(139,147,184,.28);'
    + 'box-shadow:0 10px 30px rgba(2,6,23,.5);font-size:12.5px;-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);}'
    + '.cp-nfs-btn{height:28px;padding:0 10px;border:0;background:transparent;color:#a7b0d6;border-radius:999px;'
    + 'font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}'
    + '.cp-nfs-btn:hover{color:#e6ebff;background:rgba(139,147,184,.14);}'
    + '.cp-nfs-btn--primary{color:#fff;background:#0e74e9;}'
    + '.cp-nfs-btn--primary:hover{background:#2b86f2;color:#fff;}'
    + '.cp-nfs-btn--more{padding:0 8px;font-size:14px;letter-spacing:1px;}'
    + '.cp-nfs-more{position:absolute;top:calc(100% + 6px);right:0;display:flex;flex-direction:column;gap:2px;padding:4px;'
    + 'border-radius:10px;background:rgba(15,21,48,.96);border:1px solid rgba(139,147,184,.28);box-shadow:0 10px 30px rgba(2,6,23,.5);}'
    + '.cp-nfs-menu-item{justify-content:flex-start;}'
    + '.cp-nfs-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);'
    + 'background:rgba(15,21,48,.95);border:1px solid rgba(139,147,184,.3);color:#e6ebff;font-size:12.5px;'
    + 'padding:8px 16px;border-radius:999px;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;z-index:70;}'
    + '.cp-nfs-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
    + '@media (max-width:520px){.cp-nfs-bar .cp-nfs-label{display:none;}'
    + '.cp-nfs-bar .cp-nfs-btn::before{content:attr(data-icon);font-size:13px;}}";'
    + 'document.head.appendChild(style);'
    + 'function toast(msg){var t=document.getElementById("cp-nfs-toast");'
    + 'if(!t){t=document.createElement("div");t.id="cp-nfs-toast";t.className="cp-nfs-toast";document.body.appendChild(t);}'
    + 't.textContent=String(msg||"");t.classList.add("show");'
    + 'clearTimeout(t._timer);t._timer=setTimeout(function(){t.classList.remove("show");},2200);}'
    + 'function closestKatex(n){var el=n&&n.nodeType===1?n:(n&&n.parentElement);'
    + 'while(el){if(el.classList&&el.classList.contains("katex"))return el;el=el.parentElement;}return null;}'
    + 'function pickSelection(){var container=document.querySelector(".cp-body");if(!container)return null;'
    + 'var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount||sel.isCollapsed)return null;'
    + 'var range=sel.getRangeAt(0);if(!container.contains(range.commonAncestorContainer))return null;'
    + 'var r=range;try{var sk=closestKatex(range.startContainer),ek=closestKatex(range.endContainer);'
    + 'if(sk||ek){r=range.cloneRange();if(sk)r.setStartBefore(sk);if(ek)r.setEndAfter(ek);}}catch(e){}'
    + 'var frag;try{frag=r.cloneContents();}catch(e){return null;}'
    + 'var hasKatex=!!(frag.querySelector&&frag.querySelector(".katex"));'
    + 'if(frag.querySelectorAll){var ks=frag.querySelectorAll(".katex");'
    + 'for(var i=ks.length-1;i>=0;i--){var k=ks[i];'
    + 'var ann=k.querySelector?k.querySelector(\'annotation[encoding="application/x-tex"]\'):null;'
    + 'var tex=ann?ann.textContent:"";'
    + 'var display=k.classList.contains("katex-display")||!!(k.closest&&k.closest(".katex-display"));'
    + 'var repl=tex?(display?"$$"+tex+"$$":"$"+tex+"$"):(k.textContent||"");'
    + 'var tn=document.createTextNode(repl);'
    + 'if(k.replaceWith)k.replaceWith(tn);else if(k.parentNode)k.parentNode.replaceChild(tn,k);}}'
    + 'var text=(frag.textContent||"").replace(/\\n{3,}/g,"\\n\\n").trim();'
    + 'if(text.length<2)return null;'
    + 'var hasFormula=hasKatex||/\\$\\$[\\s\\S]+?\\$\\$|\\$[^$\\n]+?\\$/.test(text);'
    + 'var rect=null;try{var rects=r.getClientRects?r.getClientRects():[];'
    + 'rect=(rects&&rects.length)?rects[rects.length-1]:r.getBoundingClientRect();}catch(e){}'
    + 'return {text:text,hasFormula:hasFormula,rect:rect};}'
    + 'function hideBar(){if(bar){if(bar.remove)bar.remove();else if(bar.parentNode)bar.parentNode.removeChild(bar);bar=null;}}'
    + 'function placeBar(rect){if(!bar)return;'
    + 'var vw=window.innerWidth||1200,vh=window.innerHeight||800;'
    + 'var bw=bar.offsetWidth||160,bh=bar.offsetHeight||36;'
    + 'var touch=false;try{touch=window.matchMedia&&window.matchMedia("(hover: none)").matches;}catch(e){}'
    + 'var al=rect&&isFinite(rect.left)?rect.left:12;'
    + 'var at=rect&&isFinite(rect.top)?rect.top:24;'
    + 'var ab=rect&&isFinite(rect.bottom)?rect.bottom:at+24;'
    + 'var left=Math.min(Math.max(8,al),Math.max(8,vw-bw-8));'
    + 'var top=touch?Math.max(8,at-bh-8):(ab+8);'
    + 'if(!touch&&top+bh>vh-8)top=Math.max(8,at-bh-8);'
    + 'bar.style.left=left+"px";bar.style.top=top+"px";}'
    + 'function btnHtml(act,label,icon,primary){return "<button type=\\"button\\" class=\\"cp-nfs-btn"+(primary?" cp-nfs-btn--primary":"")'
    + '+"\\" data-act=\\""+act+"\\" data-icon=\\""+icon+"\\" aria-label=\\""+label+"\\" title=\\""+label+"\\">"'
    + '+"<span class=\\"cp-nfs-label\\">"+label+"</span></button>";}'
    + 'function showBar(pk){hideBar();picked=pk;'
    + 'bar=document.createElement("div");bar.className="cp-nfs-bar";bar.setAttribute("role","toolbar");'
    + 'var html="";'
    + 'if(BRIDGE)html+=btnHtml("followup","追问","？",true);'
    + 'html+=btnHtml("copy","复制","⧉",false);'
    + 'if(BRIDGE&&pk.hasFormula)html+=btnHtml("collectFormula","收藏公式","★",false);'
    + 'html+="<button type=\\"button\\" class=\\"cp-nfs-btn cp-nfs-btn--more\\" data-act=\\"more\\" aria-label=\\"更多操作\\" title=\\"更多操作\\">⋯</button>";'
    + 'html+="<div class=\\"cp-nfs-more\\" hidden>"+(BRIDGE?"<button type=\\"button\\" class=\\"cp-nfs-btn cp-nfs-menu-item\\" data-act=\\"search\\">在画布中查找</button>":"")'
    + '+"<button type=\\"button\\" class=\\"cp-nfs-btn cp-nfs-menu-item\\" data-act=\\"quote\\">复制为引用</button></div>";'
    + 'bar.innerHTML=html;bar.style.visibility="hidden";document.body.appendChild(bar);'
    + 'placeBar(pk.rect);bar.style.visibility="";}'
    + 'function copyText(text){var fallback=function(){try{var ta=document.createElement("textarea");'
    + 'ta.value=String(text||"");ta.style.cssText="position:fixed;left:-9999px;top:0;";'
    + 'document.body.appendChild(ta);ta.select();'
    + 'var ok=document.execCommand&&document.execCommand("copy");'
    + 'ta.parentNode.removeChild(ta);return !!ok;}catch(e){return false;}};'
    + 'var done=function(ok){toast(ok?"已复制":"复制失败，请手动选择复制");};'
    + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
    + 'navigator.clipboard.writeText(String(text||"")).then(function(){done(true);},function(){done(fallback());});}'
    + 'else done(fallback());}'
    + 'function postAction(action,text){'
    + 'if(!BRIDGE){toast("此窗口未连接主应用，只能复制");return;}'
    + 'var msg={kind:"node-fs-action",__phymathia:1,token:TOKEN,action:action,'
    + 'text:String(text||"").slice(0,MAX_TEXT),title:CFG.title||""};'
    + 'var got=false;'
    + 'var onAck=function(ev){var d=ev.data;'
    + 'if(!d||d.__phymathia!==1||d.kind!=="node-fs-ack")return;'
    + 'got=true;window.removeEventListener("message",onAck);'
    + 'if(d.nextToken)TOKEN=d.nextToken;'
    + 'toast(d.ok?(d.message||"已转到主应用"):(d.message||"主应用未能执行该操作"));};'
    + 'window.addEventListener("message",onAck);'
    + 'try{window.parent.postMessage(msg,"*");}catch(e){got=true;toast("发送失败");}'
    + 'setTimeout(function(){if(got)return;window.removeEventListener("message",onAck);'
    + 'toast("主应用未响应，当前只能复制");},800);}'
    + 'function runAction(act){'
    + 'if(act==="more"){var menu=bar.querySelector(".cp-nfs-more");if(menu)menu.hidden=!menu.hidden;return;}'
    + 'if(!picked)return;'
    + 'if(act==="copy"){copyText(picked.text);hideBar();return;}'
    + 'if(act==="quote"){var body=String(picked.text||"").split("\\n").map(function(l){return "> "+l;}).join("\\n");'
    + 'copyText(body+"\\n\\n—— 《"+(CFG.title||"节点")+"》");hideBar();return;}'
    + 'if(act==="followup"){postAction("followup",picked.text);hideBar();return;}'
    + 'if(act==="collectFormula"){postAction("collectFormula",picked.text);hideBar();return;}'
    + 'if(act==="search"){postAction("search",picked.text);hideBar();return;}}'
    + 'document.addEventListener("pointerdown",function(ev){if(!bar)return;'
    + 'if(!bar.contains(ev.target))hideBar();},true);'
    + 'document.addEventListener("click",function(ev){if(!bar)return;var t=ev.target;'
    + 'var btn=t&&t.closest?t.closest("[data-act]"):null;'
    + 'if(btn&&bar.contains(btn)){ev.preventDefault();runAction(btn.getAttribute("data-act"));}});'
    + 'document.addEventListener("keydown",function(ev){'
    + 'if(ev.key!=="Escape"||!bar)return;ev.preventDefault();ev.stopPropagation();hideBar();},true);'
    + 'document.addEventListener("scroll",function(){if(bar)hideBar();},true);'
    + 'window.addEventListener("resize",function(){if(bar)hideBar();});'
    + 'document.addEventListener("selectionchange",function(){clearTimeout(selTimer);'
    + 'selTimer=setTimeout(function(){var pk=pickSelection();'
    + 'if(pk)showBar(pk);else{picked=null;hideBar();}},180);});'
    + '})();';
}
