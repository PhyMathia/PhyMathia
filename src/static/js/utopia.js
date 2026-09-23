// ===== PhyMathia Utopia 快照（.pmu）：单张探索网的可分享产物 =====
// 命名：Physics + Mathematics + Utopia = PhyMath Utopia，扩展名取三元素首字母 .pmu。
// 定位：PNG 是「一页概览图」，装不下长回答；.pmu 是「可交互快照」——节点内可滚动（翻页语义），
//       由 viewer.html + js/viewer.js 只读打开，离线、不需要后端；携带完整会话消息（查看器
//       「会话记录」面板渲染、拖回主应用恢复整场对话都靠它），meta.messagesComplete 标记口径。
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

// 摘要：给菜单/查看器头部显示（纯函数，便于断言）
function utopiaSnapshotSummary(snapshot) {
  const nodes = Array.isArray(snapshot && snapshot.nodes) ? snapshot.nodes : [];
  const edges = Array.isArray(snapshot && snapshot.edges) ? snapshot.edges : [];
  const groups = Array.isArray(snapshot && snapshot.groups) ? snapshot.groups : [];
  const messages = Array.isArray(snapshot && snapshot.messages) ? snapshot.messages : [];
  let chars = 0;
  nodes.forEach(function (n) { chars += String((n && n.content) || '').length; });
  return {
    title: String((snapshot && snapshot.title) || '未命名探索网'),
    nodes: nodes.length,
    edges: edges.length,
    groups: groups.length,
    messages: messages.length,
    chars: chars,
  };
}

// 解析与校验：只认本格式；版本高于当前 → 明确报错（不猜）
function parseUtopiaSnapshot(input) {
  let data = input;
  if (typeof input === 'string') {
    try { data = JSON.parse(input); } catch (e) { return { ok: false, error: '不是合法的 JSON 文件' }; }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: '文件内容为空' };
  if (data.format !== UTOPIA_FORMAT) {
    return { ok: false, error: '不是 PhyMath Utopia 快照（format=' + String(data.format || '缺失') + '）' };
  }
  const version = Number(data.version);
  if (!isFinite(version) || version < 1) return { ok: false, error: '缺少 version 字段' };
  if (version > UTOPIA_VERSION) {
    return { ok: false, error: '快照版本 v' + version + ' 高于当前查看器支持的 v' + UTOPIA_VERSION + '，请更新 PhyMathia' };
  }
  if (!Array.isArray(data.nodes)) return { ok: false, error: '缺少 nodes 数组' };
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

function buildUtopiaSnapshot() {
  const rawNodes = (typeof graphView !== 'undefined' && graphView && graphView.nodes) || [];
  const rawEdges = (typeof graphView !== 'undefined' && graphView && graphView.edges) || [];
  const history = (typeof _getChatHistory === 'function' ? _getChatHistory() : []) || [];

  // 完整会话随文件携带（2026-09-22 起）：查看器的「会话记录」面板按全量 messages 渲染，
  // .pmu 拖回主应用也靠它恢复整场对话。老快照只带被节点引用的消息——查看器对两种都兼容
  // （meta.messagesComplete 缺省视为按需子集），messageIndex 重映射逻辑保持不变：
  // 全量时映射是恒等，将来若再裁剪（比如超大会话），映射自动回到「重排到新下标」。
  const messages = [];
  const indexMap = {};
  history.forEach(function (msg, idx) {
    const copy = (msg && typeof msg === 'object') ? _utopiaClone(msg) : null;
    indexMap[idx] = messages.length;
    if (copy) messages.push(copy);
  });

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
      messagesComplete: true,
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

// 导出成功浮卡：给一条明确的「下一步」——一键在查看器里打开刚导出的快照。
// 只在主应用弹（查看器里再导出没有主应用的会话上下文，也没有交接通道）。
var _utopiaCardTimer = null;

function _utopiaIsViewer() {
  return typeof window.__UTOPIA__ !== 'undefined';
}

function showUtopiaExportCard(summary) {
  if (_utopiaIsViewer()) return;
  var old = document.getElementById('utopiaExportCard');
  if (old) old.remove();
  clearTimeout(_utopiaCardTimer);
  var card = document.createElement('div');
  card.id = 'utopiaExportCard';
  card.className = 'aurora-glass aurora-glass--dialog';
  card.innerHTML = '<div class="utopia-export-card-title">Utopia 快照已导出</div>'
    + '<div class="utopia-export-card-sub">' + summary.nodes + ' 节点 · ' + summary.edges + ' 连线 · '
    + summary.messages + ' 条会话消息（' + Math.max(1, Math.round(summary.bytes / 1024)) + ' KB）</div>'
    + '<div class="utopia-export-card-actions">'
    + '<button type="button" class="utopia-export-card-btn primary" id="utopiaOpenViewerBtn">在查看器中打开</button>'
    + '<button type="button" class="utopia-export-card-btn" id="utopiaDismissCardBtn">知道了</button>'
    + '</div>';
  document.body.appendChild(card);
  card.querySelector('#utopiaDismissCardBtn').addEventListener('click', function () {
    card.remove();
    clearTimeout(_utopiaCardTimer);
  });
  card.querySelector('#utopiaOpenViewerBtn').addEventListener('click', function () {
    card.remove();
    clearTimeout(_utopiaCardTimer);
    _utopiaOpenHandoffViewer();
  });
  _utopiaCardTimer = setTimeout(function () {
    if (card.isConnected) card.remove();
  }, 20000);
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

function exportUtopiaSnapshot() {
  if (typeof graphView === 'undefined' || !graphView || !(graphView.nodes || []).length) {
    if (typeof showToast === 'function') showToast('画布还没有内容，先提问生成一张探索网吧');
    return false;
  }
  let snapshot;
  try { snapshot = buildUtopiaSnapshot(); } catch (e) {
    if (typeof showToast === 'function') showToast('快照生成失败：' + (e && e.message ? e.message : e));
    return false;
  }
  window.__utopiaLastSnapshot = snapshot; // handoff 交接用（仅本次会话内存）
  const json = JSON.stringify(snapshot, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = utopiaSnapshotFilename(snapshot.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  const sum = utopiaSnapshotSummary(snapshot);
  sum.bytes = json.length;
  if (typeof showToast === 'function') {
    showToast('已导出 Utopia 快照 ' + sum.nodes + ' 节点 / ' + sum.edges + ' 连线 / '
      + sum.messages + ' 条会话消息——用查看器打开可滚动看长内容');
  }
  showUtopiaExportCard(sum);
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
