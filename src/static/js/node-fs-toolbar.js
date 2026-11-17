// ===== 节点全屏划词快捷工具（2026-10-25 计划落地）=====
// 两层结构：动作层只此一份（本文件，在主应用里执行）；浮条 UI 两份——
// ①本页全屏阅读层（.graph-node-fs-overlay）一份，选区提取＋动作就地执行；
// ②新窗口预览页一份自包含脚本（_buildNodeFsPreviewScript 生成字符串，由
//   graph-custom._buildContentPreviewPage 塞进页面），按钮不直接干活，
//   postMessage 送回主应用执行同一套动作。
// 加载期零副作用：只注册监听，不读画布状态；画布函数全部运行期 typeof 守卫调用。
// 拍板记录：追问＝A 先预填再发；工具条三件＝追问/复制/查找（2026-10-25 真机反馈后
// 收窄，收藏公式与复制为引用已删；浏览器不允许后台页抢焦点——新窗口的追问输入行
// 落回预览页本地展开，拼好整句再过桥直发，不再假装「跳转回主应用」）。

const NODE_FS_BRIDGE_ACTIONS = ['followup', 'search']; // 复制在页内完成，不过桥（2026-10-25 拍板收窄为三件）
const NODE_FS_FOLLOWUP_DEFAULT = '请把这段再展开讲讲';
const NODE_FS_EXCERPT_MAX = 2000;   // 追问引文截断（超出标注「已取前 2000 字」）
const NODE_FS_EXCERPT_LINES = 3;    // 引文最多带 3 行
const NODE_FS_BRIDGE_TEXT_MAX = 20000; // 桥上文本上限（超限截断不报错）
const NODE_FS_SEARCH_SNIPPET_MAX = 120; // 在画布中查找：取选段前 120 字（整条公式的 LaTeX 本体常超 40，截半截必搜不中）

let _nfsBar = null;         // 浮条单例（出现即重建，收起即移除，不做显隐切换）
let _nfsState = null;       // { overlay, container, nodeId, nodeTitle, fullText, hasFormula, rect, expanded, quoteDropped }
let _nfsSelTimer = 0;
// 新窗口桥的接收端上下文：{ token, prevToken, nodeId, sessionId, title, win }，最近的在最前。
// 快照进 sessionStorage（不是 localStorage）：只在本标签页有效、刷新后仍在——
// 主应用一刷新就把预览窗全忘掉的话，那扇窗里所有追问都只能超时（2026-11-17 用户报）。
const NODE_FS_PREVIEW_CTX_STORE = 'phymathia_node_fs_preview_ctx';
const NODE_FS_PREVIEW_CTX_MAX = 4;
let _nfsPreviewCtxs = [];

// 追问「回答方式」（2026-11-17 用户报：浮条追问没有「直接回答／问题分析」可挑）：
// 与画布追问卡同一套口径（graph-interact.submitDraftQuestion → startQuestionWorkflow 的
// followupRoute），三档 auto/analysis/direct；auto 只在总开关开时露面。选择沿用上一次
// （config.STORAGE_KEY_NODE_FS_ROUTE，跟账号走），省得每次划词都要重挑。
const NODE_FS_ROUTE_FALLBACK = 'phymathia_node_fs_followup_route';
let _nfsRoute = '';         // 本页懒加载一次，之后读这里（浮条出现即沿用，不反复读盘）

function _nodeFsRouteAutoEnabled() {
  return (typeof followupAutoRouteEnabled === 'function') ? followupAutoRouteEnabled() : false;
}

function _nodeFsRouteStoreKey() {
  return (typeof STORAGE_KEY_NODE_FS_ROUTE === 'string' && STORAGE_KEY_NODE_FS_ROUTE)
    ? STORAGE_KEY_NODE_FS_ROUTE : NODE_FS_ROUTE_FALLBACK;
}

// 当前该用哪一档：存过的手动档照用；auto 档在总开关关掉后自动降级 analysis
// （与画布追问卡「关时不出现自动判断」同一口径，别让旧值把人锁在判断请求上）
function _nodeFsRouteCurrent() {
  const auto = _nodeFsRouteAutoEnabled();
  if (_nfsRoute === 'direct' || _nfsRoute === 'analysis') return _nfsRoute;
  if (_nfsRoute === 'auto') return auto ? 'auto' : 'analysis';
  let saved = '';
  try { saved = String(localStorage.getItem(_nodeFsRouteStoreKey()) || '').toLowerCase(); } catch (e) { saved = ''; }
  if (saved === 'direct' || saved === 'analysis') _nfsRoute = saved;
  else if (saved === 'auto' && auto) _nfsRoute = 'auto';
  else _nfsRoute = auto ? 'auto' : 'analysis';
  return _nfsRoute;
}

function _nodeFsRouteSet(route) {
  const next = String(route || '').toLowerCase();
  if (next !== 'direct' && next !== 'analysis' && !(next === 'auto' && _nodeFsRouteAutoEnabled())) return _nodeFsRouteCurrent();
  _nfsRoute = next;
  try { localStorage.setItem(_nodeFsRouteStoreKey(), next); } catch (e) { /* 配额满就只记在本页 */ }
  return _nfsRoute;
}

// 三枚胶囊的 HTML（本页浮条与预览页内嵌脚本同款文案／同款 title；类名各自前缀）
function _nodeFsRouteButtonsHtml(cls) {
  const cur = _nodeFsRouteCurrent();
  const btn = (route, label, hint) => '<button type="button" class="' + cls + '-btn' + (cur === route ? ' is-current' : '')
    + '" data-route="' + route + '" aria-pressed="' + (cur === route ? 'true' : 'false')
    + '" title="' + _nodeFsEscAttr(hint) + '">' + label + '</button>';
  return '<div class="' + cls + '" role="group" aria-label="回答方式">'
    + '<span class="' + cls + '-label">回答方式</span>'
    + (_nodeFsRouteAutoEnabled() ? btn('auto', '自动判断', '由 AI 判断：一句话能答清就直接回答') : '')
    + btn('analysis', '问题分析', '先拆成子问题铺开分析')
    + btn('direct', '直接回答', '一次成文，不铺模块')
    + '</div>';
}

// ---------- 选区提取（KaTeX 还原 LaTeX） ----------

function _nodeFsClosestKatex(node) {
  let el = node && node.nodeType === 1 ? node : (node && node.parentElement);
  while (el) {
    if (el.classList && el.classList.contains('katex')) return el;
    el = el.parentElement;
  }
  return null;
}

function _nodeFsKatexTex(k) {
  const ann = k && k.querySelector ? k.querySelector('annotation[encoding="application/x-tex"]') : null;
  return ann ? String(ann.textContent || '') : '';
}

// 选区端点落在公式中间（半截 DOM）时扩成整条公式——宁可多带一个符号，不复制出
// 「a2+b2」这种残废（2026-10-25 拍板）。复制/追问引文与查找共用这一个扩公式口径。
function _nodeFsExpandRangeToFormulas(range) {
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
  return r;
}

// fragment 里的 .katex 全换成 LaTeX 文本：withDollar=true → $...$ / $$...$$（复制与
// 追问引文，与胶囊「复制」同口径）；false → tex 本体不带定界符（查找用——索引侧
// _graphSearchPlainText 建索引时把 $ 剥成空格，只是「选区碰公式」时这里喂的两种口径
// 唯一的区别）。display 判定要看克隆节点自己：半截公式扩到 .katex 起止时片段里没有
// 祖先 .katex-display，只能靠 KaTeX MathML 的 <math display="block"> 认（否则 display
// 公式会被降级成 $...$）。
function _nodeFsKatexFragmentText(frag, withDollar) {
  if (frag && frag.querySelectorAll) {
    const ks = frag.querySelectorAll('.katex');
    for (let i = ks.length - 1; i >= 0; i--) {
      const k = ks[i];
      const tex = _nodeFsKatexTex(k);
      let repl = k.textContent || '';
      if (tex) {
        if (!withDollar) repl = tex;
        else {
          const display = (k.classList && k.classList.contains('katex-display'))
            || !!(k.closest && k.closest('.katex-display'))
            || !!(k.querySelector && k.querySelector('math[display="block"]'));
          repl = (display ? '$$' : '$') + tex + (display ? '$$' : '$');
        }
      }
      const tn = document.createTextNode(repl);
      if (k.replaceWith) k.replaceWith(tn);
      else if (k.parentNode) k.parentNode.replaceChild(tn, k);
    }
  }
  return String(frag ? frag.textContent || '' : '');
}

// 查找查询：选区碰到公式就喂 LaTeX 本体（整条公式；不带 $，与索引同形）。渲染字形
// （如「Ω→R2」＝\Omega\to\mathbb R^2 压平）与索引里的 LaTeX 子串匹配必然失配——
// 2026-10-31 T420 用户追问答疑时发现的洞。没碰公式的选段原样返回所选可见字符。
function _nodeFsPickSearchText(range) {
  let frag;
  try { frag = _nodeFsExpandRangeToFormulas(range).cloneContents(); } catch (e) { return ''; }
  if (!frag) return '';
  return _nodeFsKatexFragmentText(frag, false);
}

// 选区克隆成纯文本；.katex 用 annotation 里的 x-tex 还原成 $...$ / $$...$$。
// 返回 { text, searchText, rect }，rect 取最后一行（多行锚点）。
function _nodeFsPickSelection(container) {
  if (!container || !container.contains) return null;
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;
  const r = _nodeFsExpandRangeToFormulas(range);
  let frag;
  try { frag = r.cloneContents(); } catch (e) { return null; }
  const text = _nodeFsKatexFragmentText(frag, true).replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 2) return null; // 至少 2 个字
  // 查找查询另提一份（碰公式扩整条取 tex 本体，见 _nodeFsPickSearchText），取不到再退复制文本
  const searchText = _nodeFsPickSearchText(range).replace(/\s+/g, ' ').trim() || text;
  let rect = null;
  try {
    const rects = r.getClientRects ? r.getClientRects() : [];
    rect = (rects && rects.length) ? rects[rects.length - 1] : r.getBoundingClientRect();
  } catch (e) { rect = null; }
  return { text, searchText, rect };
}

// 系统复制（Ctrl+C / 右键复制）：此前全站没有 copy 拦截，浏览器把 KaTeX 压扁成渲染
// 文本（`Ω→R2`），贴进画布搜索（索引存 LaTeX 本体）必然失配——2026-10-31 T420。
// 选区碰到 `.katex` 就按胶囊「复制」同款口径重写剪贴板纯文本（完整 $tex$/$$tex$$、
// 半截扩整条）；没碰公式返回空串＝不拦截，默认复制零变化。
function _nodeFsCopySelectionText() {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || !sel.rangeCount || sel.isCollapsed) return '';
  const range = sel.getRangeAt(0);
  try {
    if (!range.commonAncestorContainer || !document.contains(range.commonAncestorContainer)) return '';
  } catch (e) { return ''; }
  let frag = null;
  try { frag = range.cloneContents(); } catch (e) { return ''; }
  const hasFormula = !!(_nodeFsClosestKatex(range.startContainer)
    || _nodeFsClosestKatex(range.endContainer)
    || (frag && frag.querySelector && frag.querySelector('.katex')));
  if (!hasFormula) return '';
  let out = '';
  try { out = _nodeFsKatexFragmentText(_nodeFsExpandRangeToFormulas(range).cloneContents(), true); } catch (e) { return ''; }
  return out.replace(/\n{3,}/g, '\n\n').trim();
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

function _nodeFsButtonHtml(act, label, icon, primary, title) {
  const t = title || label;
  return '<button type="button" class="node-fs-btn' + (primary ? ' node-fs-btn--primary' : '')
    + '" data-act="' + act + '" data-icon="' + icon + '" aria-label="' + t + '" title="' + t + '">'
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
    searchText: picked.searchText || picked.text,
    rect: picked.rect,
    expanded: false,
    quoteDropped: false,
  };
  const readonly = typeof phyIsReadonly === 'function' && phyIsReadonly();
  const bar = document.createElement('div');
  bar.className = 'node-fs-bar aurora-glass aurora-glass--compact';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', '划词快捷工具');
  // 三件平铺（2026-10-25 拍板收窄）：追问（主色，只读隐藏）/ 复制 / 查找（只读保留，
  // 搜索面板是读操作）
  let html = '';
  if (!readonly) html += _nodeFsButtonHtml('followup', '追问', '？', true);
  html += _nodeFsButtonHtml('copy', '复制', '⧉', false);
  html += _nodeFsButtonHtml('search', '查找', '⌕', false, '在画布中查找');
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
  // 首版漏写这枚分支：点「追问」整条落空、毫无反应（2026-10-25 真机事故）——
  // 冒烟已加回归断言（本文件与预览页脚本双端都必须把 followup 接到展开输入行）
  if (act === 'followup') { _nodeFsExpandInput(); return; }
  if (act === 'delquote') {
    st.quoteDropped = true;
    const row = bar.querySelector('.node-fs-quote-row');
    if (row) row.remove();
    return;
  }
  if (act === 'send') { _nodeFsSendFollowup(); return; }
  if (act === 'copy') { _nodeFsCopyText(st.fullText); _nodeFsHideBar(); return; }
  if (act === 'search') {
    _nodeFsSearchCanvas(st.searchText || st.fullText); // 查找用未扩公式选段（见 _nodeFsPickSearchText）
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
    + '</div>'
    + _nodeFsRouteButtonsHtml('node-fs-route');
  // 回答方式就地切换（不重建浮条：重画会把输入框里已打的字和焦点一起弄丢）
  const routeGroup = bar.querySelector('.node-fs-route');
  if (routeGroup) {
    routeGroup.addEventListener('click', ev => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('[data-route]') : null;
      if (!btn || !routeGroup.contains(btn)) return;
      ev.preventDefault();
      const next = _nodeFsRouteSet(btn.getAttribute('data-route'));
      routeGroup.querySelectorAll('[data-route]').forEach(item => {
        const on = item.getAttribute('data-route') === next;
        item.classList.toggle('is-current', on);
        item.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      // 点胶囊不该把光标从输入框里赶走（按钮默认会拿到焦点）
      const back = bar.querySelector('.node-fs-input');
      if (back) back.focus();
    });
  }
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
  // 回答方式：与画布追问卡同一条 opts 通道（startQuestionWorkflow 侧还有一道
  // 总开关闸，auto 关时降级 analysis）——浮条这条追问过去不带 routeMode，
  // 一律按 analysis 走，用户没法在这里要「直接回答」（2026-11-17 补）
  const route = _nodeFsRouteCurrent();
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(composed, { sourceNodeId: node.id, sourcePort: port, queueLabel: '追问', followupRoute: route });
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

// ---------- 主应用侧：新窗口桥接收端 ----------

function _nodeFsMintPreviewToken() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return 'nfs_' + crypto.randomUUID().replace(/-/g, '');
  } catch (e) { /* 非安全上下文走兜底 */ }
  return 'nfs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

// 桥上下文表：按 token 认窗，不再只留一条。
// 2026-11-17 用户报「预览窗里追问，回我『主应用未响应，当前只能复制』」——两处病根：
// ①上下文只活在内存里，主应用一刷新（F5）就全丢，预览窗此后所有动作只能超时；
// ②单槽：开第二个预览窗会把第一个顶掉，先开的那个窗静默失效。
// 现在：最近 4 条并存、按 token 找回；快照写 sessionStorage（同标签页，刷新仍在），
// 刷新后第一条消息把窗口认回来（win=null 时不比对 source，只认 token）。
function _nodeFsPersistPreviewCtx() {
  try {
    if (typeof sessionStorage === 'undefined') return;
    const slim = _nfsPreviewCtxs.map(c => ({ token: c.token, nodeId: c.nodeId, sessionId: c.sessionId, title: c.title }));
    sessionStorage.setItem(NODE_FS_PREVIEW_CTX_STORE, JSON.stringify(slim));
  } catch (e) { /* 存储被禁：退回纯内存，行为同旧版 */ }
}

function _nodeFsRestorePreviewCtx() {
  if (_nfsPreviewCtxs.length) return;
  try {
    if (typeof sessionStorage === 'undefined') return;
    const raw = sessionStorage.getItem(NODE_FS_PREVIEW_CTX_STORE);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return;
    _nfsPreviewCtxs = arr.filter(c => c && typeof c.token === 'string' && c.token)
      .slice(0, NODE_FS_PREVIEW_CTX_MAX)
      .map(c => ({
        token: c.token, prevToken: '',
        nodeId: String(c.nodeId || ''), sessionId: String(c.sessionId || ''),
        title: String(c.title || ''), win: null,
      }));
  } catch (e) { /* 坏快照当没有 */ }
}

// openNodeNewWindow（graph-custom.js）在开窗前登记上下文，开窗成功后补 win 引用
function _setNodeFsPreviewCtx(ctx) {
  if (!ctx || typeof ctx.token !== 'string' || !ctx.token) {
    // 只丢弃刚登记的那一条（graph-custom 在弹窗被拦时紧跟着调用）：多窗并存时
    // 清空整表会把还开着的别的预览窗一起废掉
    _nfsPreviewCtxs = _nfsPreviewCtxs.slice(1);
    _nodeFsPersistPreviewCtx();
    return;
  }
  const token = ctx.token;
  const rest = _nfsPreviewCtxs.filter(c => c.token !== token);
  _nfsPreviewCtxs = [{
    token,
    prevToken: '',
    nodeId: String(ctx.nodeId || ''),
    sessionId: String(ctx.sessionId || ''),
    title: String(ctx.title || ''),
    win: ctx.win || null,
  }].concat(rest).slice(0, NODE_FS_PREVIEW_CTX_MAX);
  _nodeFsPersistPreviewCtx();
}

function _attachNodeFsPreviewWin(win) {
  const target = _nfsPreviewCtxs.find(c => !c.win) || _nfsPreviewCtxs[0];
  if (target) target.win = win || null;
}

// 按 token 找上下文：已绑过窗口的只认那一个窗口；刷新后重建的（win=null）用第一条消息认窗。
// prevToken 也认——预览页没收到 ack 里的 nextToken 时会继续用上一枚，不放行就等于永久失效。
function _nodeFsPreviewCtxFor(msgToken, source) {
  const t = typeof msgToken === 'string' ? msgToken : '';
  if (!t) return null;
  for (let i = 0; i < _nfsPreviewCtxs.length; i++) {
    const c = _nfsPreviewCtxs[i];
    if (c.token !== t && c.prevToken !== t) continue;
    if (c.win && c.win !== source) continue;
    if (!c.win) c.win = source || null;
    return c;
  }
  return null;
}

// 预览窗关掉后上下文失效（轮询兜底）
setInterval(() => {
  const alive = _nfsPreviewCtxs.filter(c => !(c.win && c.win.closed));
  if (alive.length !== _nfsPreviewCtxs.length) {
    _nfsPreviewCtxs = alive;
    _nodeFsPersistPreviewCtx();
  }
}, 3000);

window.addEventListener('message', ev => {
  const d = ev.data;
  if (!d || d.__phymathia !== 1 || d.kind !== 'node-fs-action') return;
  if (NODE_FS_BRIDGE_ACTIONS.indexOf(d.action) < 0) return; // 动作白名单
  _nodeFsRestorePreviewCtx(); // 刷新后的第一发：从 sessionStorage 把窗认回来
  const ctx = _nodeFsPreviewCtxFor(d.token, ev.source);
  if (!ctx) return; // 认不出这扇窗：不执行、不应答（预览侧会提示重开窗口）
  const text = String(d.text || '').slice(0, NODE_FS_BRIDGE_TEXT_MAX);
  // 预览页选的回答方式：白名单外的值一律当没选（老预览窗的脚本根本不带这字段，
  // 那种情况回落到主应用这边记住的那一档）
  const route = (d.route === 'direct' || d.route === 'analysis'
    || (d.route === 'auto' && _nodeFsRouteAutoEnabled())) ? d.route : '';
  const node = (ctx.nodeId && typeof _findGraphNode === 'function') ? _findGraphNode(ctx.nodeId) : null;
  let ok = true;
  let message = '';
  if (!node) { ok = false; message = '源节点已不在画布上'; }
  else if (String(ctx.sessionId || '') !== String((typeof currentSessionId !== 'undefined' && currentSessionId) || '')) {
    ok = false; message = '请先切回原画布再继续'; // 不跨会话建点
  }
  if (ok) {
    // 不抢焦点：后台标签页的 window.focus() 被浏览器一律忽略（2026-10-25 真机实测），
    // 动作就地执行、用户自己切回主应用看结果；ack 文案照实说，不写「已转到主应用」
    try {
      if (d.action === 'followup') { _nodeFsBridgedFollowup(node, text, route); message = '追问已发到主画布'; }
      else if (d.action === 'search') { _nodeFsBridgedSearch(text); message = '已在主应用打开画布搜索'; }
    } catch (e) { ok = false; message = '主应用执行失败'; }
  }
  // token 轮换：本轮消费掉，随 ack 发新的一枚；上一枚留作 prevToken 兜底
  // （预览页若没收到 ack，下一发仍用旧 token，不放行就等于自己把自己锁死）
  const nextToken = _nodeFsMintPreviewToken();
  ctx.prevToken = ctx.token;
  ctx.token = nextToken;
  _nodeFsPersistPreviewCtx();
  try {
    ev.source.postMessage(
      { kind: 'node-fs-ack', __phymathia: 1, token: d.token, ok, message, nextToken },
      location.origin,
    );
  } catch (e2) { /* 预览窗已关，无从应答 */ }
});

// 桥上追问：预览页里已把「问题＋【聚焦选段】引文」拼成整句送来——浏览器不允许后台
// 页抢焦点（「跳转回主应用」真机实测做不到，2026-10-25），追问输入行因此落回预览页
// 本地展开；这里收到整句后直接从源节点长链，不开全屏层、不抢屏
function _nodeFsBridgedFollowup(node, text, route) {
  const port = (typeof _branchSourcePort === 'function') ? _branchSourcePort(node, 'followup') : 'out-0';
  if (typeof window.startQuestionWorkflow === 'function') {
    window.startQuestionWorkflow(String(text || ''), {
      sourceNodeId: node.id,
      sourcePort: port,
      queueLabel: '追问',
      followupRoute: route || _nodeFsRouteCurrent(),
    });
  }
}

function _nodeFsBridgedSearch(text) {
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

// 系统复制拦截：只在选区碰公式时改写纯文本，其余复制不碰（event 不 preventDefault）
document.addEventListener('copy', ev => {
  if (!ev.clipboardData) return;
  const text = _nodeFsCopySelectionText();
  if (!text) return;
  try {
    ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
  } catch (e) { /* 不支持改写就让默认复制照旧 */ }
});

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

// scroll 不冒泡但 capture 能收到：正文滚动即收，浮条不遮刚读的那一行。
// 但浮条自己也会滚：追问输入框的字符一旦超过框宽，光标跟随会把 input 自身横向滚一下，
// 这枚 capture 监听照样收到（target 是 input），浮条当场自己关掉、打了一半的字全丢
// （2026-11-17 用户报「输入超过框长就自动关」）——来自浮条内部的滚动一律不算正文滚动。
document.addEventListener('scroll', ev => {
  if (!_nfsBar) return;
  const t = ev.target;
  if (t && t.nodeType === 1 && _nfsBar.contains(t)) return;
  _nodeFsHideBar();
}, true);
// 同理，软键盘／窗口尺寸变化也收浮条；但**输入行展开时不收**（2026-11-17 同批排查）：
// 手机上点开追问输入框，键盘一弹就是一次 resize，一收浮条字都打不进去——改成跟一次摆位。
window.addEventListener('resize', () => {
  if (!_nfsBar) return;
  if (_nfsState && _nfsState.expanded) { _nodeFsPlaceBar(_nfsState.rect); return; }
  _nodeFsHideBar();
});
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



// 内嵌脚本＝主应用浮条的过桥版：选区提取与 LaTeX 还原同款（查找查询 pickSearchText
// 与主应用 _nodeFsPickSearchText 一致——选区碰公式喂 tex 本体不带 $，索引侧 $ 已剥；
// 系统复制的 copy 拦截也在这里双胞胎一份）。三件工具（2026-10-25
// 用户拍板收窄）：追问＝本页展开输入行（引文 chip 可删）、拼好整句 postMessage 过桥
// 直发——浏览器不允许后台页抢焦点（「跳转回主应用」真机实测做不到），输入行只能
// 落在本页；复制页内完成；查找过桥回主应用开搜索面板。file:// 单文件（bridge:false）
// 没有壳中转只留复制。token 一次性，ack 里轮换的新 token 接着用。
function _buildNodeFsPreviewScript(cfg) {
  const conf = {
    bridge: !!(cfg && cfg.bridge),
    readonly: !!(cfg && cfg.readonly),
    token: String((cfg && cfg.token) || ''),
    nodeId: String((cfg && cfg.nodeId) || ''),
    title: String((cfg && cfg.title) || ''),
    // 回答方式（2026-11-17）：预览页读不到主应用的账号命名空间（非默认账号的键带
    // u<id8>_ 前缀），所以初始值由主应用生成脚本时带过去；窗内再切只记在本窗内存，
    // 不回写——回写会落到无前缀的裸键上，与主应用那份对不上，反而像「没记住」
    route: (cfg && typeof cfg.route === 'string' && cfg.route) ? String(cfg.route) : _nodeFsRouteCurrent(),
    auto: _nodeFsRouteAutoEnabled(),
  };
  const json = JSON.stringify(conf).replace(/<\//g, '<\\/'); // 防标题带 </script> 提前闭合
  return '(function(){'
    + 'var CFG=' + json + ';'
    + 'var TOKEN=CFG.token||"";'
    + 'var BRIDGE=!!CFG.bridge;'
    + 'var READONLY=!!CFG.readonly;'
    + 'var MAX_TEXT=' + NODE_FS_BRIDGE_TEXT_MAX + ',EXCERPT_MAX=' + NODE_FS_EXCERPT_MAX + ',EXCERPT_LINES=' + NODE_FS_EXCERPT_LINES + ';'
    + 'var DEFAULT_Q=' + JSON.stringify(NODE_FS_FOLLOWUP_DEFAULT) + ';'
    // 回答方式：主应用带过来的初始值（见上方 conf.route 注释）；窗内可再切
    + 'var ROUTE=(CFG.route==="direct"||CFG.route==="analysis"||(CFG.route==="auto"&&CFG.auto))?CFG.route:(CFG.auto?"auto":"analysis");'
    + 'var ROUTE_AUTO=!!CFG.auto;'
    + 'var bar=null,picked=null,state=null,selTimer=0;'
    + 'var style=document.createElement("style");'
    + 'style.textContent=".cp-nfs-bar{position:fixed;z-index:60;display:flex;align-items:center;gap:2px;padding:4px;'
    + 'border-radius:999px;background:rgba(15,21,48,.92);border:1px solid rgba(139,147,184,.28);'
    + 'box-shadow:0 10px 30px rgba(2,6,23,.5);font-size:12.5px;-webkit-backdrop-filter:blur(14px) saturate(140%);backdrop-filter:blur(14px) saturate(140%);}'
    + '.cp-nfs-bar--expanded{flex-direction:column;align-items:stretch;gap:6px;border-radius:12px;padding:8px;min-width:min(420px,calc(100vw - 24px));}'
    + '.cp-nfs-btn{height:28px;padding:0 10px;border:0;background:transparent;color:#a7b0d6;border-radius:999px;'
    + 'font-size:12.5px;cursor:pointer;display:inline-flex;align-items:center;gap:4px;white-space:nowrap;}'
    + '.cp-nfs-btn:hover{color:#e6ebff;background:rgba(139,147,184,.14);}'
    + '.cp-nfs-btn--primary{color:#fff;background:#0e74e9;}'
    + '.cp-nfs-btn--primary:hover{background:#2b86f2;color:#fff;}'
    + '.cp-nfs-quote-row{display:flex;align-items:center;gap:6px;min-width:0;}'
    + '.cp-nfs-quote-chip{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;'
    + 'color:#8b93b8;background:rgba(139,147,184,.14);border-radius:999px;padding:3px 10px;}'
    + '.cp-nfs-quote-del{flex:none;width:20px;height:20px;border:0;border-radius:50%;background:transparent;color:#8b93b8;cursor:pointer;font-size:13px;line-height:1;}'
    + '.cp-nfs-quote-del:hover{color:#e6ebff;background:rgba(139,147,184,.18);}'
    + '.cp-nfs-input-row{display:flex;align-items:center;gap:6px;}'
    + '.cp-nfs-input{flex:1;min-width:0;height:30px;border-radius:8px;border:1px solid rgba(139,147,184,.3);'
    + 'background:rgba(9,13,32,.6);color:#e6ebff;font-size:13px;padding:0 10px;outline:none;}'
    + '.cp-nfs-input:focus{border-color:rgba(45,212,191,.55);}'
    + '.cp-nfs-trunc{flex:none;font-size:11px;color:#8b93b8;white-space:nowrap;}'
    + '.cp-nfs-route{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-top:2px;}'
    + '.cp-nfs-route-label{font-size:11px;color:#8b93b8;margin-right:2px;}'
    + '.cp-nfs-route-btn{height:24px;padding:0 9px;border:1px solid transparent;border-radius:999px;background:transparent;'
    + 'color:#a7b0d6;font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;}'
    + '.cp-nfs-route-btn:hover{color:#e6ebff;background:rgba(139,147,184,.14);}'
    + '.cp-nfs-route-btn.is-current{color:#e6ebff;background:rgba(139,147,184,.26);border-color:rgba(139,147,184,.5);font-weight:600;}'
    + '.cp-nfs-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(8px);'
    + 'background:rgba(15,21,48,.95);border:1px solid rgba(139,147,184,.3);color:#e6ebff;font-size:12.5px;'
    + 'padding:8px 16px;border-radius:999px;opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;z-index:70;}'
    + '.cp-nfs-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
    + '@media (max-width:520px){.cp-nfs-bar .cp-nfs-label{display:none;}'
    + '.cp-nfs-bar .cp-nfs-btn::before{content:attr(data-icon);font-size:13px;}}'
    // 阅读页跟随主应用明暗后（2026-11-14），浮条改吃页面 --cp-* 令牌：fallback 就是
    // 原来的深色定值，file:// 单文件（无页面令牌）视觉与从前一致
    + '.cp-nfs-bar{background:var(--cp-bar-bg,rgba(15,21,48,.92));border-color:var(--cp-line,rgba(139,147,184,.28));'
    + 'box-shadow:0 10px 30px var(--cp-shadow,rgba(2,6,23,.5));}'
    + '.cp-nfs-btn{color:var(--cp-ink-2,#a7b0d6);}'
    + '.cp-nfs-btn:hover{color:var(--cp-ink-strong,#e6ebff);background:var(--cp-chip-bg,rgba(139,147,184,.14));}'
    + '.cp-nfs-btn--primary{background:var(--cp-primary,#0e74e9);color:#fff;}'
    + '.cp-nfs-btn--primary:hover{background:var(--cp-primary-hover,#2b86f2);color:#fff;}'
    + '.cp-nfs-quote-chip{color:var(--cp-mute,#8b93b8);background:var(--cp-chip-bg,rgba(139,147,184,.14));}'
    + '.cp-nfs-quote-del{color:var(--cp-mute,#8b93b8);}'
    + '.cp-nfs-quote-del:hover{color:var(--cp-ink-strong,#e6ebff);background:var(--cp-chip-bg,rgba(139,147,184,.14));}'
    + '.cp-nfs-input{background:var(--cp-input-bg,rgba(9,13,32,.6));border-color:var(--cp-line,rgba(139,147,184,.3));'
    + 'color:var(--cp-ink-strong,#e6ebff);}'
    + '.cp-nfs-input:focus{border-color:var(--cp-focus,rgba(45,212,191,.55));}'
    + '.cp-nfs-trunc{color:var(--cp-mute,#8b93b8);}'
    + '.cp-nfs-route-label{color:var(--cp-mute,#8b93b8);}'
    + '.cp-nfs-route-btn{color:var(--cp-ink-2,#a7b0d6);}'
    + '.cp-nfs-route-btn:hover{color:var(--cp-ink-strong,#e6ebff);background:var(--cp-chip-bg,rgba(139,147,184,.14));}'
    // 选中态吃主题主色（--cp-primary 深浅两套都有），只染底与描边、不抢「发送」那颗实心钮
    + '.cp-nfs-route-btn.is-current{color:var(--cp-primary,#e6ebff);'
    + 'background:color-mix(in srgb,var(--cp-primary,#8b93b8) 16%,transparent);'
    + 'border-color:color-mix(in srgb,var(--cp-primary,#8b93b8) 45%,transparent);font-weight:600;}'
    + '.cp-nfs-route-btn:focus-visible{outline:2px solid var(--cp-focus,rgba(139,147,184,.7));outline-offset:1px;}'
    + '.cp-nfs-toast{background:var(--cp-bar-bg,rgba(15,21,48,.95));border-color:var(--cp-line,rgba(139,147,184,.3));'
    + 'color:var(--cp-ink-strong,#e6ebff);}'
    + '";'
    + 'document.head.appendChild(style);'
    + 'function toast(msg){var t=document.getElementById("cp-nfs-toast");'
    + 'if(!t){t=document.createElement("div");t.id="cp-nfs-toast";t.className="cp-nfs-toast";document.body.appendChild(t);}'
    + 't.textContent=String(msg||"");t.classList.add("show");'
    + 'clearTimeout(t._timer);t._timer=setTimeout(function(){t.classList.remove("show");},2400);}'
    + 'function escHtml(s){var d=document.createElement("div");d.textContent=String(s==null?"":s);return d.innerHTML;}'
    + 'function escAttr(s){return escHtml(s).replace(/"/g,"&quot;").replace(/\'/g,"&#39;");}'
    + 'function oneLine(s){return String(s||"").replace(/\\s+/g," ").slice(0,60);}'
    + 'function closestKatex(n){var el=n&&n.nodeType===1?n:(n&&n.parentElement);'
    + 'while(el){if(el.classList&&el.classList.contains("katex"))return el;el=el.parentElement;}return null;}'
    + 'function katexTex(k){var ann=k&&k.querySelector?k.querySelector(\'annotation[encoding="application/x-tex"]\'):null;'
    + 'return ann?String(ann.textContent||""):"";}'
    + 'function expandRange(range){var r=range;try{var sk=closestKatex(range.startContainer),ek=closestKatex(range.endContainer);'
    + 'if(sk||ek){r=range.cloneRange();if(sk)r.setStartBefore(sk);if(ek)r.setEndAfter(ek);}}catch(e){}return r;}'
    + 'function fragText(frag,withDollar){if(frag&&frag.querySelectorAll){var ks=frag.querySelectorAll(".katex");'
    + 'for(var i=ks.length-1;i>=0;i--){var k=ks[i];var tex=katexTex(k);var repl=k.textContent||"";'
    + 'if(tex){if(!withDollar)repl=tex;else{var display=k.classList.contains("katex-display")||!!(k.closest&&k.closest(".katex-display"))||!!(k.querySelector&&k.querySelector(\'math[display="block"]\'));'
    + 'repl=(display?"$$":"$")+tex+(display?"$$":"$");}}'
    + 'var tn=document.createTextNode(repl);'
    + 'if(k.replaceWith)k.replaceWith(tn);else if(k.parentNode)k.parentNode.replaceChild(tn,k);}}'
    + 'return String(frag?frag.textContent||"":"");}'
    + 'function pickSearchText(range){var frag;try{frag=expandRange(range).cloneContents();}catch(e){return"";}'
    + 'if(!frag)return"";return fragText(frag,false);}'
    + 'function pickSelection(){var container=document.querySelector(".cp-body");if(!container)return null;'
    + 'var sel=window.getSelection?window.getSelection():null;if(!sel||!sel.rangeCount||sel.isCollapsed)return null;'
    + 'var range=sel.getRangeAt(0);if(!container.contains(range.commonAncestorContainer))return null;'
    + 'var r=expandRange(range);'
    + 'var frag;try{frag=r.cloneContents();}catch(e){return null;}'
    + 'var text=fragText(frag,true).replace(/\\n{3,}/g,"\\n\\n").trim();'
    + 'if(text.length<2)return null;'
    + 'var rect=null;try{var rects=r.getClientRects?r.getClientRects():[];'
    + 'rect=(rects&&rects.length)?rects[rects.length-1]:r.getBoundingClientRect();}catch(e){}'
    + 'var searchText=pickSearchText(range).replace(/\\s+/g," ").replace(/^\\s+|\\s+$/g,"")||text;'
    + 'return {text:text,searchText:searchText,rect:rect};}'
    + 'function copySelectionText(){var sel=window.getSelection?window.getSelection():null;'
    + 'if(!sel||!sel.rangeCount||sel.isCollapsed)return"";var range=sel.getRangeAt(0);'
    + 'try{if(!range.commonAncestorContainer||!document.contains(range.commonAncestorContainer))return"";}catch(e){return"";}'
    + 'var frag=null;try{frag=range.cloneContents();}catch(e){return"";}'
    + 'var has=!!(closestKatex(range.startContainer)||closestKatex(range.endContainer)||(frag&&frag.querySelector&&frag.querySelector(".katex")));'
    + 'if(!has)return"";var out="";'
    + 'try{out=fragText(expandRange(range).cloneContents(),true);}catch(e){return"";}'
    + 'return out.replace(/\\n{3,}/g,"\\n\\n").replace(/^\\s+|\\s+$/g,"");}'
    + 'document.addEventListener("copy",function(ev){if(!ev.clipboardData)return;var text=copySelectionText();if(!text)return;'
    + 'try{ev.clipboardData.setData("text/plain",text);ev.preventDefault();}catch(e){}});'
    + 'function buildExcerpt(text){var lines=String(text||"").split("\\n");'
    + 'while(lines.length&&!lines[0].replace(/\\s/g,""))lines.shift();'
    + 'while(lines.length&&!lines[lines.length-1].replace(/\\s/g,""))lines.pop();'
    + 'var truncated=lines.length>EXCERPT_LINES;'
    + 'var excerpt=lines.slice(0,EXCERPT_LINES).join("\\n");'
    + 'if(excerpt.length>EXCERPT_MAX){excerpt=excerpt.slice(0,EXCERPT_MAX);truncated=true;}'
    + 'return {excerpt:excerpt,truncated:truncated};}'
    + 'function hideBar(){if(bar){if(bar.remove)bar.remove();else if(bar.parentNode)bar.parentNode.removeChild(bar);bar=null;}state=null;}'
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
    + 'function btnHtml(act,label,icon,primary,title){var t=title||label;'
    + 'return "<button type=\\"button\\" class=\\"cp-nfs-btn"+(primary?" cp-nfs-btn--primary":"")'
    + '+"\\" data-act=\\""+act+"\\" data-icon=\\""+icon+"\\" aria-label=\\""+t+"\\" title=\\""+t+"\\">"'
    + '+"<span class=\\"cp-nfs-label\\">"+label+"</span></button>";}'
    // 回答方式三枚胶囊（2026-11-17）：主应用浮条的同款文案与 title，类名换成 cp- 前缀
    + 'function routeHtml(){var html="<div class=\\"cp-nfs-route\\" role=\\"group\\" aria-label=\\"回答方式\\">'
    + '<span class=\\"cp-nfs-route-label\\">回答方式</span>";'
    + 'var b=function(r,label,hint){var on=ROUTE===r;'
    + 'return "<button type=\\"button\\" class=\\"cp-nfs-route-btn"+(on?" is-current":"")+"\\" data-route=\\""+r+"\\"'
    + ' aria-pressed=\\""+(on?"true":"false")+"\\" title=\\""+escAttr(hint)+"\\">"+label+"</button>";};'
    + 'if(ROUTE_AUTO)html+=b("auto","自动判断","由 AI 判断：一句话能答清就直接回答");'
    + 'html+=b("analysis","问题分析","先拆成子问题铺开分析");'
    + 'html+=b("direct","直接回答","一次成文，不铺模块");'
    + 'return html+"</div>";}'
    // 窗内就地切换（不重建浮条：重画会丢输入框里的字与焦点）
    + 'function setRoute(r){if(r!=="direct"&&r!=="analysis"&&!(r==="auto"&&ROUTE_AUTO))return;ROUTE=r;'
    + 'var btns=bar?bar.querySelectorAll("[data-route]"):[];'
    + 'for(var i=0;i<btns.length;i++){var on=btns[i].getAttribute("data-route")===ROUTE;'
    + 'btns[i].className="cp-nfs-route-btn"+(on?" is-current":"");'
    + 'btns[i].setAttribute("aria-pressed",on?"true":"false");}'
    + 'var inp=bar?bar.querySelector(".cp-nfs-input"):null;if(inp)inp.focus();}'
    + 'function showBar(pk){hideBar();picked=pk;state={expanded:false,quoteDropped:false};'
    + 'bar=document.createElement("div");bar.className="cp-nfs-bar";bar.setAttribute("role","toolbar");'
    + 'var html="";'
    + 'if(BRIDGE&&!READONLY)html+=btnHtml("followup","追问","？",true);'
    + 'html+=btnHtml("copy","复制","⧉",false);'
    + 'if(BRIDGE)html+=btnHtml("search","查找","⌕",false,"在画布中查找");'
    + 'bar.innerHTML=html;bar.style.visibility="hidden";document.body.appendChild(bar);'
    + 'placeBar(pk.rect);bar.style.visibility="";}'
    + 'function expandInput(){if(!state||state.expanded||!picked)return;state.expanded=true;'
    + 'bar.className="cp-nfs-bar cp-nfs-bar--expanded";'
    + 'var q=buildExcerpt(picked.text);var html="";'
    + 'if(q.excerpt&&!state.quoteDropped)html+="<div class=\\"cp-nfs-quote-row\\"><span class=\\"cp-nfs-quote-chip\\" title=\\""+escAttr(q.excerpt)+"\\">【聚焦选段】"+escHtml(oneLine(q.excerpt))+"</span>"'
    + '+"<button type=\\"button\\" class=\\"cp-nfs-quote-del\\" data-act=\\"delquote\\" aria-label=\\"移除引文\\" title=\\"发送时不带这段引文\\">×</button></div>";'
    + 'html+="<div class=\\"cp-nfs-input-row\\"><input type=\\"text\\" class=\\"cp-nfs-input\\" aria-label=\\"追问内容\\" placeholder=\\"想追问什么？（留空用默认问句）\\">"'
    + '+(q.truncated?"<span class=\\"cp-nfs-trunc\\">已取前 2000 字</span>":"")'
    + '+"<button type=\\"button\\" class=\\"cp-nfs-btn cp-nfs-btn--primary\\" data-act=\\"send\\">发送</button></div>";'
    // 回答方式（2026-11-17）：与主应用浮条、画布追问卡同一套三档口径
    + 'html+=routeHtml();'
    + 'bar.innerHTML=html;'
    + 'var input=bar.querySelector(".cp-nfs-input");'
    + 'if(input){input.addEventListener("keydown",function(ev){if(ev.key==="Enter"){ev.preventDefault();sendFollowup();}});input.focus();}'
    + 'placeBar(picked.rect);}'
    + 'function sendFollowup(){if(!state||!picked)return;'
    + 'var input=bar?bar.querySelector(".cp-nfs-input"):null;'
    + 'var question=((input&&input.value)||"").replace(/^\\s+|\\s+$/g,"")||DEFAULT_Q;'
    + 'var quote=state.quoteDropped?"":buildExcerpt(picked.text).excerpt;'
    + 'var composed=quote?question+"\\n\\n【聚焦选段】\\n"+quote.split("\\n").map(function(l){return "> "+l;}).join("\\n"):question;'
    + 'hideBar();postAction("followup",composed,ROUTE);}'
    + 'function copyText(text){var fallback=function(){try{var ta=document.createElement("textarea");'
    + 'ta.value=String(text||"");ta.style.cssText="position:fixed;left:-9999px;top:0;";'
    + 'document.body.appendChild(ta);ta.select();'
    + 'var ok=document.execCommand&&document.execCommand("copy");'
    + 'ta.parentNode.removeChild(ta);return !!ok;}catch(e){return false;}};'
    + 'var done=function(ok){toast(ok?"已复制":"复制失败，请手动选择复制");};'
    + 'if(navigator.clipboard&&navigator.clipboard.writeText){'
    + 'navigator.clipboard.writeText(String(text||"")).then(function(){done(true);},function(){done(fallback());});}'
    + 'else done(fallback());}'
    + 'function postAction(action,text,route){'
    + 'if(!BRIDGE){toast("此窗口未连接主应用，只能复制");return;}'
    + 'var msg={kind:"node-fs-action",__phymathia:1,token:TOKEN,action:action,'
    + 'text:String(text||"").slice(0,MAX_TEXT),title:CFG.title||"",route:String(route||"")};'
    + 'var notified=false;'
    + 'var onAck=function(ev){var d=ev.data;'
    + 'if(!d||d.__phymathia!==1||d.kind!=="node-fs-ack")return;'
    + 'if(d.nextToken)TOKEN=d.nextToken;'
    // 迟到的 ack（超时后才到）只用来把 token 追平，不再弹第二次话——token 追不上的话，
    // 这扇窗此后每一发都会被主应用当成陌生 token 丢掉，只能一直超时
    + 'if(notified){window.removeEventListener("message",onAck);return;}'
    + 'notified=true;window.removeEventListener("message",onAck);'
    + 'toast(d.ok?(d.message||"已发送到主应用"):(d.message||"主应用未能执行该操作"));};'
    + 'window.addEventListener("message",onAck);'
    + 'try{window.parent.postMessage(msg,"*");}catch(e){notified=true;toast("发送失败");}'
    + 'setTimeout(function(){if(notified)return;notified=true;'
    + 'toast("主应用没回应，再点一次发送");},2500);}'
    + 'function runAction(act){'
    + 'if(!state)return;'
    + 'if(act==="followup"){expandInput();return;}'
    + 'if(act==="delquote"){state.quoteDropped=true;var row=bar.querySelector(".cp-nfs-quote-row");'
    + 'if(row&&row.parentNode)row.parentNode.removeChild(row);return;}'
    + 'if(act==="send"){sendFollowup();return;}'
    + 'if(!picked)return;'
    + 'if(act==="copy"){copyText(picked.text);hideBar();return;}'
    + 'if(act==="search"){postAction("search",picked.searchText||picked.text);hideBar();return;}}'
    + 'document.addEventListener("pointerdown",function(ev){if(!bar)return;'
    + 'if(!bar.contains(ev.target))hideBar();},true);'
    + 'document.addEventListener("click",function(ev){if(!bar)return;var t=ev.target;'
    // 回答方式胶囊不是「动作」，先认掉（data-act 那条只跑追问/复制/查找）
    + 'var rb=t&&t.closest?t.closest("[data-route]"):null;'
    + 'if(rb&&bar.contains(rb)){ev.preventDefault();setRoute(rb.getAttribute("data-route"));return;}'
    + 'var btn=t&&t.closest?t.closest("[data-act]"):null;'
    + 'if(btn&&bar.contains(btn)){ev.preventDefault();runAction(btn.getAttribute("data-act"));}});'
    + 'document.addEventListener("keydown",function(ev){'
    + 'if(ev.key!=="Escape"||!bar)return;ev.preventDefault();ev.stopPropagation();hideBar();},true);'
    // 浮条内部滚动（输入框字符超宽后光标跟随横滚）不收，口径同主应用侧
    + 'document.addEventListener("scroll",function(ev){if(!bar)return;var t=ev.target;'
    + 'if(t&&t.nodeType===1&&bar.contains(t))return;hideBar();},true);'
    // 软键盘会带来 resize：展开态跟着摆位，不收起（口径同主应用侧）
    + 'window.addEventListener("resize",function(){if(!bar)return;'
    + 'if(state&&state.expanded){placeBar(picked?picked.rect:null);return;}hideBar();});'
    + 'document.addEventListener("selectionchange",function(){clearTimeout(selTimer);'
    + 'selTimer=setTimeout(function(){if(state&&state.expanded)return;var pk=pickSelection();'
    + 'if(pk)showBar(pk);else hideBar();},180);});'
    + '})();';
}
