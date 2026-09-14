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
    installReadOnlyContextMenu();
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

  function loadFromUrl(url) {
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (text) {
      loadText(text, url.split('/').pop());
    }).catch(function (e) { showError('载入 ' + url + ' 失败：' + (e && e.message ? e.message : e)); });
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
    installReadOnlyContextMenu();
    initToolbar();
    initDropZone();
    var src = new URLSearchParams(location.search).get('src');
    if (src) loadFromUrl(src);
    else toast('拖入 .pmu 快照，或点「打开快照」');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.utopiaViewer = {
    loadText: loadText,
    loadFile: loadFile,
    applySnapshot: applySnapshot,
    state: U,
  };
})();
