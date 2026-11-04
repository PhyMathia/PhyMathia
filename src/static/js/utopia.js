// ===== PhyMathia Utopia 快照（.pmu）：单张探索网的可分享产物 =====
// 命名：Physics + Mathematics + Utopia = PhyMath Utopia，扩展名取三元素首字母 .pmu。
// 定位：PNG 是「一页概览图」，装不下长回答；.pmu 是「可交互快照」——节点内可滚动（翻页语义），
//       由 viewer.html + js/viewer.js 只读打开，离线、不需要后端；默认携带完整会话消息（查看器
//       「会话记录」面板渲染、拖回主应用恢复整场对话都靠它），meta.messagesComplete 标记口径；
//       2026-11-04 起可选「轻量存档」（只带画布引用的消息，meta.exportMode='light'＋omittedMessages）。
// 格式：纯 JSON（可被人读、可被别的程序解析）
//   { format:"phymath-utopia/graph", version:1, exportedAt, app, title,
//     meta:{ sessionId, level, theme, messagesComplete, counts }, viewport:{ pan, zoom },
//     graph:{ 布局状态（端口数/折叠/位置等渲染要用到的） },
//     nodes:[ 已构建好的画布节点（含 messageIndex 指向本文件 messages） ],
//     edges:[], groups:[],
//     messages:[ 完整会话消息（模块正文按消息内容复算，故必须随文件携带） ] }
// 只读：本文件只做「导出 + 解析校验」；渲染由查看器承担，主应用的编辑/AI 能力一律不进查看器。

const UTOPIA_FORMAT = 'phymath-utopia/graph';
const UTOPIA_VERSION = 1;
const UTOPIA_EXT = '.pmu';
const UTOPIA_APP = 'PhyMathia/1.4.1';

// ---------- 纯函数（smoke 断言 / 查看器复用） ----------

function _utopiaClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (e) { return null; }
}

// 摘要：给菜单/查看器头部/导出浮卡显示（纯函数，便于断言）
function utopiaSnapshotSummary(snapshot) {
  const nodes = Array.isArray(snapshot && snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
  const groups = Array.isArray(snapshot && snapshot.groups) ? snapshot.groups : [];
  const messages = Array.isArray(snapshot && snapshot.messages) ? snapshot.messages : [];
  const meta = (snapshot && snapshot.meta && typeof snapshot.meta === 'object') ? snapshot.meta : {};
  let chars = 0;
  nodes.forEach(function (n) { chars += String((n && n.content) || '').length; });
  return {
    title: String((snapshot && snapshot.title) || '未命名探索网'),
    nodes: nodes.length,
    edges: edges.length,
    groups: groups.length,
    messages: messages.length,
    chars: chars,
    // 模式标识：轻量存档（只带画布引用的消息）走 'light'，其余按完整处理
    mode: meta.exportMode === 'light' ? 'light' : 'full',
    omittedMessages: Number(meta.omittedMessages) || 0,
  };
}

// 解析与校验：只认本格式；版本高于当前 → 明确报错（不猜）。
// 加固口径（2026-11-04，.pmu 第二批）：坏文件必须在解析阶段被拒，错误文案可直接给用户看；
// 合法老快照（缺 edges/groups/messages/graph/meta）补齐缺省后照常放行；不修改合法快照的字段。
function parseUtopiaSnapshot(input) {
  let data = input;
  if (typeof input === 'string') {
    if (!input.trim()) return { ok: false, error: '文件内容为空' };
    try { data = JSON.parse(input); } catch (e) { return { ok: false, error: '不是合法的 JSON 文件' }; }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: '文件内容为空或不是对象' };
  if (data.format !== UTOPIA_FORMAT) {
    return { ok: false, error: '不是 PhyMathia 存档（format=' + String(data.format || '缺失') + '）' };
  }
  const version = Number(data.version);
  if (!isFinite(version) || version < 1) return { ok: false, error: '缺少 version 字段' };
  if (version > UTOPIA_VERSION) {
    return { ok: false, error: '快照版本 v' + version + ' 高于当前查看器支持的 v' + UTOPIA_VERSION + '，请更新 PhyMathia' };
  }
  // nodes：必须是数组；每项非 null 对象且有非空 id；重复 id 直接拒（查看器节点索引会错乱）
  if (!Array.isArray(data.nodes)) return { ok: false, error: '缺少 nodes 数组' };
  const seenIds = {};
  for (let i = 0; i < data.nodes.length; i++) {
    const n = data.nodes[i];
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      return { ok: false, error: 'nodes 第 ' + (i + 1) + ' 项不是对象' };
    }
    const id = (n.id === undefined || n.id === null) ? '' : String(n.id).trim();
    if (!id) return { ok: false, error: 'nodes 第 ' + (i + 1) + ' 项缺少 id' };
    if (Object.prototype.hasOwnProperty.call(seenIds, id)) {
      return { ok: false, error: '快照里有重复节点 id：' + id };
    }
    seenIds[id] = true;
  }
  // edges / groups / messages：缺省补 []，存在但不是数组 → 拒
  for (const key of ['edges', 'groups', 'messages']) {
    if (data[key] === undefined || data[key] === null) { data[key] = []; continue; }
    if (!Array.isArray(data[key])) return { ok: false, error: key + ' 不是数组' };
  }
  // messages 里的非对象条目过滤并计数（渲染路径会读 msg.content，不能带坏条目进去）
  const dropped = data.messages.filter(function (m) { return !m || typeof m !== 'object' || Array.isArray(m); }).length;
  if (dropped) data.messages = data.messages.filter(function (m) { return m && typeof m === 'object' && !Array.isArray(m); });
  // graph / meta：缺省补 {}，存在但不是对象 → 拒
  for (const key of ['graph', 'meta']) {
    if (data[key] === undefined || data[key] === null) { data[key] = {}; continue; }
    if (typeof data[key] !== 'object' || Array.isArray(data[key])) return { ok: false, error: key + ' 不是对象' };
  }
  if (dropped) {
    // 只增不改：记录被过滤的条数，供导入确认卡/日志排查用
    data.meta.filteredMessages = dropped;
  }
  return { ok: true, snapshot: data };
}

function utopiaSnapshotFilename(title) {
  const d = new Date();
  const p = function (n) { return String(n).padStart(2, '0'); };
  const stamp = '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  const safe = String(title || '').replace(/[\\/:*?"<>|\n\r]/g, '_').trim().slice(0, 40);
  return 'PhyMathUtopia_' + (safe || stamp) + (safe ? '_' + stamp : '') + UTOPIA_EXT;
}

// ---------- 导出（主应用侧） ----------

function _utopiaCurrentTitle() {
  try {
    const sid = (typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '') || '';
    const s = (sid && typeof window.getSessionById === 'function') ? window.getSessionById(sid) : null;
    const t = s && (s.title || '').trim();
    if (t) return t.slice(0, 40);
  } catch (e) {}
  return '探索网';
}

function _utopiaTheme() {
  try {
    const t = document.documentElement.getAttribute('data-theme');
    return t === 'light' ? 'light' : 'dark';
  } catch (e) { return 'dark'; }
}

// 取画布渲染真正读到的布局状态。**必须连 customNodes/connections 一起带**：
// 查看器走的是主应用同一条图构建路径（_buildGraphData(messages, state)），自建节点与自定义连线
// 都从 state 里长出来——裁掉它们，查看器就只剩空态节点（实测踩过）。
function _utopiaGraphState() {
  let st = {};
  try { st = (typeof _graphState === 'function' ? _graphState() : {}) || {}; } catch (e) { st = {}; }
  return {
    // pan/zoom 必须留在 state 里：渲染路径 _applyGraphTransform() 直接读 _graphState().pan.x
    // （viewport 那份是给查看器与元信息用的易读副本）
    pan: st.pan || { x: 80, y: 80 },
    zoom: (typeof st.zoom === 'number' && isFinite(st.zoom)) ? st.zoom : 0.9,
    positions: st.positions || {},
    pinned: st.pinned || {},
    sizes: st.sizes || {},
    collapsed: st.collapsed || {},
    hidden: st.hidden || {},
    portCounts: st.portCounts || {},
    inputPortCounts: st.inputPortCounts || {},
    groups: st.groups || [],
    customNodes: st.customNodes || [],
    connections: st.connections || null,
    removedEdges: st.removedEdges || [],
    layoutVersion: st.layoutVersion || 1,
    harnessNodeOverrides: st.harnessNodeOverrides || {},
  };
}

// options.includeAllMessages === false → 轻量存档：只带被节点 messageIndex 引用的消息（按原顺序去重，
// 下标重映射；无有效引用的节点写 -1），meta.exportMode='light'、meta.messagesComplete=false、
// meta.omittedMessages=省略条数。缺省（或 true）＝完整存档，与 2026-09-22 起的现状完全一致。
// 为什么轻量也必须带「引用到的消息」而不是零消息：查看器走 _buildGraphData(messages, state)
// 同一构建路径，模块节点正文要从消息复算，完全不带消息会只剩空画布（canvas-modules.md 硬约束）。
function buildUtopiaSnapshot(options) {
  const includeAll = !(options && options.includeAllMessages === false);
  const rawNodes = (typeof graphView !== 'undefined' && graphView && graphView.nodes) || [];
  const rawEdges = (typeof graphView !== 'undefined' && graphView && graphView.edges) || [];
  const history = (typeof _getChatHistory === 'function' ? _getChatHistory() : []) || [];

  const messages = [];
  const indexMap = {};
  if (includeAll) {
    // 完整会话随文件携带：查看器的「会话记录」面板按全量 messages 渲染，
    // .pmu 拖回主应用也靠它恢复整场对话。
    history.forEach(function (msg, idx) {
      const copy = (msg && typeof msg === 'object') ? _utopiaClone(msg) : null;
      indexMap[idx] = messages.length;
      if (copy) messages.push(copy);
    });
  } else {
    // 轻量：先收集被节点引用的消息下标（唯一、升序），再逐条复制并建映射
    const wanted = {};
    rawNodes.forEach(function (n) {
      const mi = Number(n && n.messageIndex);
      if (isFinite(mi) && mi >= 0 && mi < history.length) wanted[mi] = true;
    });
    Object.keys(wanted).map(Number).sort(function (a, b) { return a - b; }).forEach(function (idx) {
      const copy = (history[idx] && typeof history[idx] === 'object') ? _utopiaClone(history[idx]) : null;
      if (!copy) return; // 坏条目不入文件，引用它的节点 messageIndex 落到 -1
      indexMap[idx] = messages.length;
      messages.push(copy);
    });
  }

  const nodes = [];
  rawNodes.forEach(function (n) {
    const copy = _utopiaClone(n);
    if (!copy) return;
    const mi = Number(n.messageIndex);
    if (mi >= 0) copy.messageIndex = Object.prototype.hasOwnProperty.call(indexMap, mi) ? indexMap[mi] : -1;
    nodes.push(copy);
  });

  return {
    format: UTOPIA_FORMAT,
    version: UTOPIA_VERSION,
    exportedAt: new Date().toISOString(),
    app: UTOPIA_APP,
    title: _utopiaCurrentTitle(),
    meta: {
      sessionId: (typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '') || '',
      level: (typeof currentLevel !== 'undefined' ? currentLevel : '') || '',
      theme: _utopiaTheme(),
      messagesComplete: includeAll,
      ...(includeAll ? {} : { exportMode: 'light', omittedMessages: history.length - messages.length }),
      counts: { nodes: nodes.length, edges: rawEdges.length, groups: ((graphView && graphView.groups) || []).length, messages: messages.length },
    },
    viewport: {
      pan: (graphView && graphView.pan) ? { x: Number(graphView.pan.x) || 0, y: Number(graphView.pan.y) || 0 } : { x: 80, y: 80 },
      zoom: Number(graphView && graphView.zoom) || 0.9,
    },
    graph: _utopiaGraphState(),
    nodes: nodes,
    edges: (_utopiaClone(rawEdges) || []),
    groups: (_utopiaClone((graphView && graphView.groups) || []) || []),
    messages: messages,
  };
}

// 导出成功浮卡：给一条明确的「下一步」——一键在查看器里打开刚导出的存档。
// 只在主应用弹（查看器里再导出没有主应用的会话上下文，也没有交接通道）。
// 2026-11-01：不再同时弹 toast（两者都在底部，toast 会压住卡片顶沿）；
// 60 秒后自动收起，鼠标悬停/键盘聚焦时暂停计时。
var _utopiaCardTimer = null;
var UTOPIA_CARD_MS = 60000;

function _utopiaIsViewer() {
  return typeof window.__UTOPIA__ !== 'undefined';
}

// 文件体积按 Blob 实际字节显示（旧实现用 json.length，把 UTF-16 字符数当字节，
// 中文内容会少报 2–3 倍）
function _utopiaFmtSize(bytes) {
  var n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// 浮卡 innerHTML 里拼文件名/标题前的转义（主应用有 utils.js 的 escapeHtml，这里兜底一份）
function _utopiaEsc(text) {
  if (typeof escapeHtml === 'function') return escapeHtml(text);
  return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  });
}

// 复制文件名：优先 clipboard API，失败退 execCommand（与项目现有复制兜底同口径）
function _utopiaCopyText(text, done) {
  var t = String(text || '');
  var finish = function (ok) { if (typeof done === 'function') done(!!ok); };
  var viaExec = function () {
    try {
      var ta = document.createElement('textarea');
      ta.value = t;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      finish(ok);
    } catch (e) { finish(false); }
  };
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(t).then(function () { finish(true); }, viaExec);
    return;
  }
  viaExec();
}

function _utopiaArmCardTimer(card) {
  clearTimeout(_utopiaCardTimer);
  _utopiaCardTimer = setTimeout(function () {
    if (card.isConnected) card.remove();
  }, UTOPIA_CARD_MS);
}

function showUtopiaExportCard(summary) {
  if (_utopiaIsViewer()) return;
  var old = document.getElementById('utopiaExportCard');
  if (old) old.remove();
  clearTimeout(_utopiaCardTimer);
  var card = document.createElement('div');
  card.id = 'utopiaExportCard';
  card.className = 'aurora-glass aurora-glass--dialog';
  card.setAttribute('role', 'status');
  var isLight = summary.mode === 'light';
  var htmlRow = (typeof window.exportUtopiaStandaloneHtml === 'function')
    ? '<button type="button" class="utopia-export-card-btn" id="utopiaExportHtmlBtn">'
      + (isLight ? '再存网页版（完整对话）' : '再存网页版') + '</button>'
    : '';
  var subLine = summary.nodes + ' 节点 · ' + summary.edges + ' 连线 · '
    + summary.messages + ' 条会话消息 · ' + _utopiaFmtSize(summary.bytes)
    + (isLight && summary.omittedMessages ? ' · 省略 ' + summary.omittedMessages + ' 条未引用消息' : '');
  card.innerHTML = '<div class="utopia-export-card-title">' + (isLight ? '轻量存档已保存' : '存档已保存') + '</div>'
    + '<div class="utopia-export-card-sub">' + subLine + '</div>'
    + '<div class="utopia-export-card-hint">已存到「下载」：<b>' + _utopiaEsc(summary.fileName) + '</b><br>'
    + (isLight
      ? '轻量存档只带画布引用的消息，拖回只能恢复这部分对话；'
      : '拖回 PhyMathia 可继续编辑；')
    + '发给别人建议用单文件网页</div>'
    + '<div class="utopia-export-card-actions">'
    + '<button type="button" class="utopia-export-card-btn primary" id="utopiaOpenViewerBtn">在查看器中打开</button>'
    + htmlRow
    + '<button type="button" class="utopia-export-card-btn" id="utopiaCopyNameBtn">复制文件名</button>'
    + '<button type="button" class="utopia-export-card-btn" id="utopiaDismissCardBtn">知道了</button>'
    + '</div>';
  document.body.appendChild(card);
  card.querySelector('#utopiaDismissCardBtn').addEventListener('click', function () {
    card.remove();
    clearTimeout(_utopiaCardTimer);
  });
  var copyBtn = card.querySelector('#utopiaCopyNameBtn');
  if (copyBtn) copyBtn.addEventListener('click', function () {
    var fileName = String(summary.fileName || '');
    _utopiaCopyText(fileName, function (ok) {
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      if (ok) setTimeout(function () { if (copyBtn.isConnected) copyBtn.textContent = '复制文件名'; }, 1600);
    });
  });
  card.querySelector('#utopiaOpenViewerBtn').addEventListener('click', function () {
    card.remove();
    clearTimeout(_utopiaCardTimer);
    _utopiaOpenHandoffViewer();
  });
  var htmlBtn = card.querySelector('#utopiaExportHtmlBtn');
  if (htmlBtn) htmlBtn.addEventListener('click', function () {
    card.remove();
    clearTimeout(_utopiaCardTimer);
    window.exportUtopiaStandaloneHtml();
  });
  // 悬停/聚焦暂停自动收起，避免用户正要点击时卡片消失
  card.addEventListener('mouseenter', function () { clearTimeout(_utopiaCardTimer); });
  card.addEventListener('mouseleave', function () { _utopiaArmCardTimer(card); });
  card.addEventListener('focusin', function () { clearTimeout(_utopiaCardTimer); });
  card.addEventListener('focusout', function () { _utopiaArmCardTimer(card); });
  _utopiaArmCardTimer(card);
}

function _utopiaOpenHandoffViewer(snapshot) {
  // opener 直传：window.open 的新标签页与主应用同源，查看器 boot 时经 window.opener
  // 取走数据（一次性，取走即清）。不走 sessionStorage——查看器把 storage 换成了内存
  // 门面读不到真实的，且新标签页 sessionStorage 复制行为各浏览器不一致（实测踩过）。
  // snapshot 缺省时依次取「刚导出的缓存」→ 现建（预览入口不经过导出也能看）。
  var snap = snapshot || window.__utopiaLastSnapshot || null;
  if (!snap && typeof buildUtopiaSnapshot === 'function') {
    try { snap = buildUtopiaSnapshot(); } catch (e) { snap = null; }
  }
  if (!snap) {
    if (typeof showToast === 'function') showToast('画布还没有内容，先提问生成一张探索网吧');
    return false;
  }
  window.__utopiaLastSnapshot = snap;
  window.__utopiaTakeUtopiaHandoff = function () {
    var s = window.__utopiaLastSnapshot || null;
    window.__utopiaLastSnapshot = null;
    delete window.__utopiaTakeUtopiaHandoff;
    return s;
  };
  var win = window.open('/viewer.html?from=handoff', '_blank');
  if (!win) {
    delete window.__utopiaTakeUtopiaHandoff;
    if (typeof showToast === 'function') showToast('新窗口被浏览器拦截——请允许弹窗后再点一次，或手动打开 /viewer.html 拖入文件');
  }
  return !!win;
}

// 一键预览：不下载任何文件，当前画布+完整会话直接在查看器新标签打开。
// 「看效果」与「存文件」解耦——预览是高频零成本动作，导出才是低频动作。
function previewUtopiaInViewer() {
  if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
    if (typeof showToast === 'function') showToast('画布还没有内容，先提问生成一张探索网吧');
    return false;
  }
  return _utopiaOpenHandoffViewer(null);
}

// options 透传给 buildUtopiaSnapshot（目前只有 includeAllMessages）；
// 「在查看器中预览」不受影响（永远完整快照，零文件成本）。
function exportUtopiaSnapshot(options) {
  if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
    if (typeof showToast === 'function') showToast('画布还没有内容，先提问生成一张探索网吧');
    return false;
  }
  let snapshot;
  try { snapshot = buildUtopiaSnapshot(options); } catch (e) {
    if (typeof showToast === 'function') showToast('快照生成失败：' + (e && e.message ? e.message : e));
    return false;
  }
  window.__utopiaLastSnapshot = snapshot; // handoff 交接用（仅本次会话内存）
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const fileName = utopiaSnapshotFilename(snapshot.title);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  const sum = utopiaSnapshotSummary(snapshot);
  sum.bytes = blob.size;
  sum.fileName = fileName;
  // 浮卡本身已经交代了节点数/体积/文件名，再弹一条 toast 会在底部互相压住
  if (_utopiaIsViewer()) {
    if (typeof showToast === 'function') {
      showToast((snapshot.meta && snapshot.meta.exportMode === 'light' ? '已导出 Utopia 轻量存档 ' : '已导出 Utopia 存档 ')
        + sum.nodes + ' 节点 / ' + sum.edges + ' 连线 / '
        + sum.messages + ' 条会话消息');
    }
  } else {
    showUtopiaExportCard(sum);
  }
  return true;
}

if (typeof window !== 'undefined') {
  window.UTOPIA_FORMAT = UTOPIA_FORMAT;
  window.UTOPIA_VERSION = UTOPIA_VERSION;
  window.UTOPIA_EXT = UTOPIA_EXT;
  window.buildUtopiaSnapshot = buildUtopiaSnapshot;
  window.parseUtopiaSnapshot = parseUtopiaSnapshot;
  window.utopiaSnapshotSummary = utopiaSnapshotSummary;
  window.utopiaSnapshotFilename = utopiaSnapshotFilename;
  window.exportUtopiaSnapshot = exportUtopiaSnapshot;
  window.previewUtopiaInViewer = previewUtopiaInViewer;
}
