// ===== PhyMathia Utopia 查看器：装载与界面 =====
// 只读打开 .pmu（PhyMath Utopia 快照）：平移/缩放、节点内滚动（长回答不再被裁）、搜索、
// 折叠展开、再导出一张 PNG。不联网、不写 localStorage、不改任何真实数据。

(function () {
  var U = window.__UTOPIA__;

  function el(id) { return document.getElementById(id); }

  function toast(msg) { if (typeof window.showToast === 'function') window.showToast(msg); }

  // ---------- 装载 ----------

  function applySnapshot(snapshot, fileName) {
    U.snapshot = snapshot;
    U.fileName = fileName || '';
    U.state = snapshot.graph || {};
    // 兜底：渲染路径直接读 state.pan/state.zoom，缺了就补默认值（老快照兼容）
    if (!U.state.pan || !isFinite(Number(U.state.pan.x))) U.state.pan = { x: 80, y: 80 };
    if (!isFinite(Number(U.state.zoom)) || Number(U.state.zoom) <= 0) U.state.zoom = 0.9;
    U.sessionId = 'utopia_' + Math.random().toString(36).slice(2, 10);

    // 主题：跟随快照导出时的主题（查看器本身不提供主题切换，保持产物原貌）
    var theme = (snapshot.meta && snapshot.meta.theme) === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);

    // 视口：优先用快照记录
    try {
      if (typeof graphView !== 'undefined' && graphView) {
        if (snapshot.viewport && snapshot.viewport.pan) {
          graphView.pan = { x: Number(snapshot.viewport.pan.x) || 80, y: Number(snapshot.viewport.pan.y) || 80 };
        }
        if (snapshot.viewport && isFinite(Number(snapshot.viewport.zoom))) {
          graphView.zoom = Math.max(0.2, Math.min(2.5, Number(snapshot.viewport.zoom)));
        }
        graphView.selectMode = false;
        graphView.linkMode = false;
        graphView.previewNodes = [];
        graphView.previewEdges = [];
      }
    } catch (e) {}

    renderHeader(snapshot);
    el('utopiaDrop') && el('utopiaDrop').classList.add('hidden');
    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    try { if (typeof window.fitGraph === 'function') window.fitGraph(); } catch (e) {}
    readOnlyGuard();
    installReadOnlyPanels();
    installReadOnlyContextMenu();
    // 换装新快照：会话面板标记为待重渲（下次打开按新 messages 重建）
    var panel = el('utopiaMsgsPanel');
    if (panel) { delete panel.dataset.rendered; panel.classList.remove('open'); }
    var msgsBtn = el('utopiaMsgsBtn');
    if (msgsBtn) msgsBtn.classList.remove('primary');
    toast('已载入 ' + summaryText(snapshot));
  }

  function summaryText(snapshot) {
    var s = (typeof window.utopiaSnapshotSummary === 'function')
      ? window.utopiaSnapshotSummary(snapshot)
      : { nodes: (snapshot.nodes || []).length, edges: (snapshot.edges || []).length };
    return s.nodes + ' 节点 / ' + s.edges + ' 连线';
  }

  function renderHeader(snapshot) {
    var title = el('utopiaTitle');
    if (title) title.textContent = snapshot.title || '未命名探索网';
    var meta = el('utopiaMeta');
    if (meta) {
      var s = (typeof window.utopiaSnapshotSummary === 'function') ? window.utopiaSnapshotSummary(snapshot) : null;
      var when = String(snapshot.exportedAt || '').replace('T', ' ').slice(0, 16);
      var m = snapshot.meta || {};
      meta.textContent = [
        s ? (s.nodes + ' 节点 · ' + s.edges + ' 连线 · ' + s.groups + ' 分组') : '',
        m.level ? ('难度 ' + m.level) : '',
        when ? ('导出于 ' + when) : '',
      ].filter(Boolean).join(' · ');
    }
    document.title = (snapshot.title || '探索网') + ' · Utopia 查看器';
  }

  // 只读护栏：隐藏所有会改动画布的控件（新建/生成/删除/端口增删/联系模式/分组/Φ）
  function readOnlyGuard() {
    var css = document.createElement('style');
    css.textContent = [
      '.graph-node-actions,.graph-node-delete-toggle,.graph-node-edit-toggle,.graph-node-minimize-toggle,',
      '.graph-port-remove,.graph-add-port-btn,.graph-add-input-btn,.graph-resize-handle,',
      '.graph-hub-connect-btn,.graph-regen-btn,.graph-blank-actions,.graph-source-controls,',
      '.graph-source-file-btn,.graph-source-paste-btn,.graph-knowledge-actions,.graph-relation-actions,',
      '.graph-ai-eval-accept,.graph-ai-eval-ignore,.graph-link-btn,.graph-tool-btn[title*="新建"],',
      '.graph-tool-btn[title*="整理"],.graph-tool-btn[title*="分组"],.graph-tool-btn[title*="联系"],',
      // 右下角画布工具栏整个不要（查看器只保留顶栏那几个动作）
      '.graph-canvas-toolbar,.graph-empty-active .input-area',
      '{display:none !important;}',
      // 只读：节点内滚动 + 文本可选择
      '.graph-node{cursor:default !important;}',
    ].join('');
    document.head.appendChild(css);
  }

  // 只读护栏：双击打开的面板一律禁掉
  // 双击画布空白 → openAddBlankNodeModal（添加节点面板）；双击「我的理解」节点 → editHumanNoteNode；
  // 另外把编辑类入口一并封住（它们经由已隐藏的编辑按钮，但双击/快捷键路径仍可能摸到）。
  // 不做静默无反应：给一句 toast，否则用户会以为双击坏了（本仓库有过"无声消失被当成 bug"的教训）。
  var READONLY_BLOCKED = {
    openAddBlankNodeModal: '只读快照：不能添加节点',
    editHumanNoteNode: '只读快照：节点内容不可编辑',
    editCustomNodeContent: '只读快照：节点内容不可编辑',
    editModuleNode: '只读快照：模块内容不可编辑',
    createManualNode: '只读快照：不能新建节点',
  };

  function installReadOnlyPanels() {
    Object.keys(READONLY_BLOCKED).forEach(function (name) {
      var orig = window[name];
      if (typeof orig !== 'function' || orig.__utopiaBlocked) return;
      var blocked = function () { toast(READONLY_BLOCKED[name]); return false; };
      blocked.__utopiaBlocked = true;
      blocked.__utopiaOriginal = orig;
      window[name] = blocked;
    });
  }

  // 只读右键菜单：open 之后按白名单剪枝——查看器不提供新建/删除/端口增删/收藏知识点等写操作。
  // 用标签白名单而不是改 graph-contextmenu.js：菜单项定义跟着主应用走，查看器只做减法。
  var READONLY_MENU_LABELS = [
    '复制全文', '复制节点', '居中此节点', '折叠此节点', '展开此节点',
    '适配画布', '缩放复位 100%', '导出超高清 PNG…',
  ];

  function _labelOf(itemEl) {
    var labelEl = itemEl.querySelector ? itemEl.querySelector('.graph-context-menu-label') : null;
    return String((labelEl || itemEl).textContent || '').trim();
  }

  function installReadOnlyContextMenu() {
    var origOpen = window.openGraphContextMenu;
    if (typeof origOpen !== 'function' || origOpen.__utopiaWrapped) return;
    var wrapped = function (event) {
      origOpen(event);
      var menu = document.querySelector('.graph-context-menu');
      if (!menu) return;
      Array.prototype.forEach.call(menu.querySelectorAll('.graph-context-menu-item'), function (item) {
        var label = _labelOf(item);
        var keep = READONLY_MENU_LABELS.some(function (l) { return label === l || label.indexOf(l) === 0; });
        if (!keep) item.remove();
      });
      // 整张菜单都被剪掉（联系线/多选菜单）→ 直接收起，别留一个空壳
      if (!menu.querySelector('.graph-context-menu-item')) {
        if (typeof window.closeGraphContextMenu === 'function') window.closeGraphContextMenu();
        menu.remove();
      }
    };
    wrapped.__utopiaWrapped = true;
    window.openGraphContextMenu = wrapped;
  }

  // ---------- 会话记录面板（只读） ----------
  // 快照 2026-09-22 起携带完整会话消息：面板按时间序渲染对话气泡（Markdown+公式照渲），
  // 气泡可「定位到画布」——按 messageIndex 反查节点并聚焦。老快照只带被节点引用的
  // 子集消息：有多少显示多少，meta.messagesComplete 标记口径，面板不猜不补。

  function messagesOfSnapshot() {
    var snap = (window.__UTOPIA__ && window.__UTOPIA__.snapshot) || {};
    return Array.isArray(snap.messages) ? snap.messages : [];
  }

  function _msgNodeForIndex(idx) {
    try {
      var nodes = (typeof graphView !== 'undefined' && graphView && graphView.nodes) || [];
      for (var i = 0; i < nodes.length; i++) {
        if (Number(nodes[i] && nodes[i].messageIndex) === idx) return nodes[i];
      }
    } catch (e) {}
    return null;
  }

  function _msgTimeHtml(msg) {
    var ts = Number(msg && msg.timestamp);
    if (!isFinite(ts) || !ts) return '';
    var d = new Date(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function _msgBranchLabel(msg) {
    var m = msg || {};
    if (m.branchType === 'socratic') return '苏格拉底支线';
    if (m.branchLabel) return String(m.branchLabel).slice(0, 16);
    return '';
  }

  function renderMessagesPanel() {
    var list = el('utopiaMsgsList');
    if (!list) return;
    var msgs = messagesOfSnapshot();
    var snap = (window.__UTOPIA__ && window.__UTOPIA__.snapshot) || {};
    var complete = !!(snap.meta && snap.meta.messagesComplete);
    var count = el('utopiaMsgsCount');
    if (count) {
      count.textContent = msgs.length ? (msgs.length + ' 条' + (complete ? '' : '（老快照：仅画布引用的消息）')) : '快照未携带会话消息';
    }
    list.textContent = '';
    msgs.forEach(function (msg, idx) {
      if (!msg || typeof msg !== 'object') return;
      var isUser = msg.role === 'user';
      var item = document.createElement('div');
      item.className = 'utopia-msg ' + (isUser ? 'utopia-msg-user' : 'utopia-msg-ai');
      var branch = _msgBranchLabel(msg);
      var head = '<div class="utopia-msg-head"><span class="utopia-msg-role">' + (isUser ? '提问' : 'AI 回答') + '</span>'
        + (branch ? '<span class="utopia-msg-branch">' + branch + '</span>' : '')
        + '<span class="utopia-msg-time">' + _msgTimeHtml(msg) + '</span></div>';
      var bodyText = isUser ? String(msg.content || '') : String(msg.content || '');
      if (!isUser && typeof stripXmlTags === 'function') bodyText = stripXmlTags(bodyText);
      var body = '';
      if (typeof renderMarkdown === 'function') {
        body = renderMarkdown(bodyText, { parentId: 'utopiaMsg' + idx });
      } else {
        body = '<div class="utopia-msg-plain"></div>';
      }
      var node = _msgNodeForIndex(idx);
      var locate = node
        ? '<button type="button" class="utopia-msg-locate" data-node-id="' + node.id + '">定位到画布</button>'
        : '';
      item.innerHTML = head + '<div class="utopia-msg-body">' + body + '</div>'
        + '<div class="utopia-msg-foot">' + locate + '</div>';
      var plain = item.querySelector('.utopia-msg-plain');
      if (plain) plain.textContent = bodyText;
      list.appendChild(item);
    });
    // 公式是「事后扫描」机制（renderMarkdown 只产出 $..$ 原文）：面板挂载后对整个列表跑一遍
    if (typeof renderMath === 'function') {
      try { renderMath(list); } catch (e) {}
    }
    list.addEventListener('click', function (event) {
      var btn = event.target.closest ? event.target.closest('.utopia-msg-locate') : null;
      if (!btn) return;
      if (typeof window.focusGraphNodeById === 'function') {
        if (!window.focusGraphNodeById(btn.getAttribute('data-node-id'))) toast('没找到对应节点');
      }
    });
  }

  function toggleMessagesPanel(force) {
    var panel = el('utopiaMsgsPanel');
    if (!panel) return;
    var open = (typeof force === 'boolean') ? force : !panel.classList.contains('open');
    if (open && !panel.dataset.rendered) {
      renderMessagesPanel();
      panel.dataset.rendered = '1';
    }
    panel.classList.toggle('open', open);
    var btn = el('utopiaMsgsBtn');
    if (btn) btn.classList.toggle('primary', open);
  }

  // ---------- 打开文件 ----------

  function loadText(text, fileName) {
    var res = (typeof window.parseUtopiaSnapshot === 'function')
      ? window.parseUtopiaSnapshot(text)
      : { ok: false, error: '解析器未加载（请硬刷新）' };
    if (!res.ok) { showError(res.error); return false; }
    showError('');
    applySnapshot(res.snapshot, fileName);
    return true;
  }

  function showError(msg) {
    var box = el('utopiaError');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  function loadFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadText(String(reader.result || ''), file.name); };
    reader.onerror = function () { showError('读取文件失败'); };
    reader.readAsText(file);
  }

  function loadFromUrl(url, name) {
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      loadText(text, name || url.split('/').pop());
    }).catch(function (e) { showError('载入 ' + url + ' 失败：' + (e && e.message ? e.message : e)); });
  }

  // 桌面启动器通道：双击 .pmu → open_pmu.py 把文件复制进服务端 data/utopia_inbox/
  // 并打开本页 ?from=inbox&id=<文件名> → 从收件箱取回（收件箱由启动器负责清理）。
  function loadFromInbox(id) {
    loadFromUrl('/api/utopia/inbox/' + encodeURIComponent(id), id);
  }

  // ---------- 工具栏 ----------

  function initToolbar() {
    var picker = el('utopiaFile');
    picker && picker.addEventListener('change', function () { loadFile(picker.files && picker.files[0]); });

    el('utopiaOpenBtn') && el('utopiaOpenBtn').addEventListener('click', function () { picker && picker.click(); });
    el('utopiaFitBtn') && el('utopiaFitBtn').addEventListener('click', function () {
      if (typeof window.fitGraph === 'function') window.fitGraph();
    });
    el('utopiaZoomInBtn') && el('utopiaZoomInBtn').addEventListener('click', function () {
      if (typeof window.zoomGraph === 'function') window.zoomGraph(1.2);
    });
    el('utopiaZoomOutBtn') && el('utopiaZoomOutBtn').addEventListener('click', function () {
      if (typeof window.zoomGraph === 'function') window.zoomGraph(1 / 1.2);
    });
    el('utopiaSearchBtn') && el('utopiaSearchBtn').addEventListener('click', function () {
      if (typeof window.toggleGraphSearchPanel === 'function') window.toggleGraphSearchPanel();
    });
    el('utopiaPngBtn') && el('utopiaPngBtn').addEventListener('click', function () {
      if (typeof window.toggleGraphExportMenu === 'function') window.toggleGraphExportMenu();
    });
    el('utopiaThemeBtn') && el('utopiaThemeBtn').addEventListener('click', function () {
      // 只切查看器当前显示，快照里的 meta.theme 不动
      var now = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', now);
      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    });
    el('utopiaExpandBtn') && el('utopiaExpandBtn').addEventListener('click', function () {
      // 一键展开所有折叠节点：只改内存视图（saveGraphState 是空操作，不回写）
      var n = 0;
      try {
        (graphView.nodes || []).forEach(function (node) { if (node.minimized) { node.minimized = false; n++; } });
        window.renderGraphCanvas();
      } catch (e) {}
      toast(n ? ('已展开 ' + n + ' 个折叠节点（仅本次查看）') : '没有折叠的节点');
    });
    el('utopiaMsgsBtn') && el('utopiaMsgsBtn').addEventListener('click', function () {
      toggleMessagesPanel();
    });
    el('utopiaMsgsClose') && el('utopiaMsgsClose').addEventListener('click', function () {
      toggleMessagesPanel(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var p = el('utopiaMsgsPanel');
        if (p && p.classList.contains('open')) toggleMessagesPanel(false);
      }
    });
  }

  // ---------- 拖放与快捷键 ----------

  function initDropZone() {
    var drop = el('utopiaDrop');
    ['dragenter', 'dragover'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        drop && drop.classList.add('active');
      });
    });
    ['dragleave', 'drop'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        if (!e.dataTransfer) return;
        e.preventDefault();
        if (evt === 'dragleave' && e.relatedTarget) return;
        drop && drop.classList.remove('active');
      });
    });
    document.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) loadFile(f);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'f' && !e.ctrlKey && !e.metaKey) { if (typeof window.fitGraph === 'function') window.fitGraph(); }
      if (e.key === '/' ) { e.preventDefault(); if (typeof window.toggleGraphSearchPanel === 'function') window.toggleGraphSearchPanel(); }
    });
  }

  function boot() {
    installReadOnlyPanels();
    installReadOnlyContextMenu();
    initToolbar();
    initDropZone();
    // 装载优先级：① 单文件网页内嵌快照（window.__UTOPIA_EMBEDDED__，无网络依赖）
    // ② 主应用导出后的 sessionStorage 交接（?from=handoff） ③ ?src=<url> ④ 拖入文件
    var embedded = window.__UTOPIA_EMBEDDED__;
    if (embedded && embedded.format) {
      loadText(JSON.stringify(embedded), '内嵌快照');
      return;
    }
    var qs = new URLSearchParams(location.search);
    if (qs.get('from') === 'handoff') {
      // opener 直传：主应用导出浮卡 → window.open 前挂 __utopiaTakeUtopiaHandoff，
      // 这里取走（一次性）。不经 storage——本页 storage 已是内存门面。
      var payload = null;
      try {
        if (window.opener && typeof window.opener.__utopiaTakeUtopiaHandoff === 'function') {
          payload = window.opener.__utopiaTakeUtopiaHandoff();
        }
      } catch (e) {}
      if (payload && payload.format && loadText(JSON.stringify(payload), '刚导出的快照')) return;
      showError('没接到导出的快照（新标签页可能没继承数据）——请直接把刚下载的 .pmu 拖进来');
      return;
    }
    if (qs.get('from') === 'inbox') {
      var inboxId = qs.get('id');
      if (inboxId) { loadFromInbox(inboxId); return; }
      showError('缺少快照文件名（?from=inbox&id=<文件名>）');
      return;
    }
    var src = qs.get('src');
    if (src) { loadFromUrl(src); return; }
    toast('拖入 .pmu 快照，或点「打开快照」');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.utopiaViewer = {
    loadText: loadText,
    loadFile: loadFile,
    applySnapshot: applySnapshot,
    toggleMessagesPanel: toggleMessagesPanel,
    renderMessagesPanel: renderMessagesPanel,
    state: U,
  };
})();
