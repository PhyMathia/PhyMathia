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
    installReadOnlyCanvasGestures();
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
      '.graph-canvas-toolbar',
      '{display:none !important;}',
      // 只读：节点内滚动 + 文本可选择
      '.graph-node{cursor:default !important;}',
    ].join('');
    document.head.appendChild(css);
  }

  // 只读护栏：双击打开的面板 + 拖拽/连线写路径一律禁掉
  // 面板类：双击画布空白 → openAddBlankNodeModal（添加节点面板）；双击「我的理解」节点 → editHumanNoteNode；
  // 另外把编辑类入口一并封住（它们经由已隐藏的编辑按钮，但双击/快捷键路径仍可能摸到）。
  // 拖拽类（2026-09-26 用户实测「拖动节点还是可以增加节点」）：从输出端口拖出落在空白处
  // 会走 _createBranchNodeFromOutput 新建分支节点——手势路径此前完全没设防，桩完面板也不管用；
  // 连同端口连线/断开/增删端口、双击连线删除、联系线编辑、复制粘贴建节点一起封。
  // 不做静默无反应：给一句 toast，否则用户会以为双击坏了（本仓库有过"无声消失被当成 bug"的教训）。
  var READONLY_BLOCKED = {
    openAddBlankNodeModal: '只读快照：不能添加节点',
    editHumanNoteNode: '只读快照：节点内容不可编辑',
    editCustomNodeContent: '只读快照：节点内容不可编辑',
    editModuleNode: '只读快照：模块内容不可编辑',
    createManualNode: '只读快照：不能新建节点',
    _createBranchNodeFromOutput: '只读快照：不能通过拖拽新增节点',
    _connectPorts: '只读快照：不能新增连线',
    _disconnectInputPort: '只读快照：不能断开连线',
    _removeGraphEdge: '只读快照：不能删除连线',
    openLinkEdgeModal: '只读快照：联系线不可编辑',
    graphAddOutputPort: '只读快照：不能增删端口',
    graphAddInputPort: '只读快照：不能增删端口',
    _graphCtxDuplicateNode: '只读快照：不能复制出新节点',
    _graphCtxPasteNode: '只读快照：不能粘贴成新节点',
    _graphCtxCreateBlankNodeWithText: '只读快照：不能新建节点',
    // Delete/Backspace 删节点：监听在 window 上的 _handleGraphKeydown（graph-workflow.js），
    // 选中即删、不经右键菜单——用户 2026-09-26 实测「Delete 还是可以删除节点」。
    // 键盘事件不经画布，捕获期 dblclick 那道拦不住，只能靠函数桩。
    _deleteSelectedGraphNodes: '只读快照：不能删除节点',
    _deleteSelectedGraphGroups: '只读快照：不能删除分组',
    deleteBlankNode: '只读快照：不能删除节点',
    deleteCustomNode: '只读快照：不能删除节点',
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

  // ---------- 只读兜网：拓扑冻结（默认拒绝） ----------
  // 上面的 READONLY_BLOCKED 是函数名黑名单，靠「有人发现漏网 → 补一条」维护，
  // 已经漏过两次：拖拽建节点（_createBranchNodeFromOutput）、Delete 键删节点
  // （_handleGraphKeydown 挂在 window 上，捕获期 dblclick 那道拦不住）。
  // 这里补第二层，方向相反：不问「哪些写入口要堵」，只立一条不变量——
  // 两次渲染之间，节点集合 / 连线集合 / 分组集合 / 节点索引一律不许变。
  // 位置、尺寸、折叠、选中、平移缩放全部放行：那些是查看器本来就要给的能力。
  // 于是任何写路径都被兜住，包括将来新增的、还没人来得及补进黑名单的那些。
  //
  // 为什么要守 graphView 而不是 __UTOPIA__.state：写路径落的不是快照。
  // _createBranchNodeFromOutput 写的是 graphView.nodes / .edges / .nodeById
  // （graph-interact.js:448 起）。graphView 是 graph.js:98 的 const 绑定，
  // 换不了对象本身，所以在它身上装访问器属性拦截读写。

  var TOPOLOGY_ARMED = false;
  var TOPOLOGY_BASE = null;

  function _fpNodes(arr) {
    return (arr || []).map(function (n) { return n && n.id; }).filter(Boolean).sort().join('|');
  }
  function _fpEdges(arr) {
    return (arr || []).map(function (e) {
      return e ? [e.from, e.fromPort || '', e.to, e.toPort || ''].join('>') : '';
    }).sort().join('|');
  }
  function _fpGroups(arr) {
    return (arr || []).map(function (g) { return g && g.id; }).filter(Boolean).sort().join('|');
  }
  function _fpIndex(obj) {
    return obj ? Object.keys(obj).sort().join('|') : '';
  }

  var TOPOLOGY_FP = {
    nodes: _fpNodes,
    edges: _fpEdges,
    groups: _fpGroups,
    nodeById: _fpIndex,
  };

  function _noteBlocked(what) {
    U.blockedWrites = U.blockedWrites || [];
    U.blockedWrites.push(what);
    if (window.console && console.warn) console.warn('[viewer] 只读快照：已拒绝写入 ' + what);
    toast('只读快照：不能改动画布内容');
  }

  // 数组只装 set / deleteProperty 两个陷阱，不装 get：
  // 读走的是默认内部方法，零 JS 层开销（拖拽与连线刷新每帧都在读这两个数组）。
  // push/unshift/sort/fill 靠「写下标」被拦，splice 靠 delete 被拦。
  //
  // 陷阱一律「返回 true 但不写」，不返回 false：产物是严格模式（esbuild 打包后
  // 带 use strict），返回 false 会让 push/splice 直接抛 TypeError——用户看到的是
  // 一条红字报错，而不是我们那句「只读快照：不能改动画布内容」。这里宁可让调用方
  // 误以为写成功了（写入的操作本来就是禁路，调用方是 READONLY_BLOCKED 那一层，
  // 由它负责把调用方整个拦下来，兜网只保证数据没变）。
  function _sealArray(arr, label) {
    if (!arr || typeof arr !== 'object') return arr;
    try {
      return new Proxy(arr, {
        set: function (t, k) {
          _noteBlocked(label + '.' + String(k));
          return true;
        },
        deleteProperty: function (t, k) {
          _noteBlocked(label + '.delete(' + String(k) + ')');
          return true;
        },
      });
    } catch (e) {
      return arr;
    }
  }

  // 节点索引是普通对象：只允许改已有键的值（拖拽/测量写不进这里，写的是节点对象本身），
  // 不许新增键（那是「凭空多一个节点」）、不许删键（那是「删掉一个节点」）。
  function _sealIndex(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    try {
      return new Proxy(obj, {
        set: function (t, k, v) {
          if (!Object.prototype.hasOwnProperty.call(t, k)) { _noteBlocked('nodeById[' + String(k) + '] 新增'); return true; }
          t[k] = v;
          return true;
        },
        deleteProperty: function (t, k) {
          _noteBlocked('nodeById 删除 ' + String(k));
          return true;
        },
      });
    } catch (e) {
      return obj;
    }
  }

  function armTopologyGuard() {
    if (typeof graphView === 'undefined' || !graphView) return;
    TOPOLOGY_ARMED = false;
    TOPOLOGY_BASE = {
      nodes: _fpNodes(graphView.nodes),
      edges: _fpEdges(graphView.edges),
      groups: _fpGroups(graphView.groups),
      nodeById: _fpIndex(graphView.nodeById),
    };
    ['nodes', 'edges', 'groups', 'nodeById'].forEach(function (prop) {
      var backing = graphView[prop];
      var seal = prop === 'nodeById' ? _sealIndex : _sealArray;
      var label = 'graphView.' + prop;
      backing = seal(backing, label);
      Object.defineProperty(graphView, prop, {
        configurable: true,
        enumerable: true,
        get: function () { return backing; },
        set: function (next) {
          // 拓扑变了就整个拒绝：这次赋值多半就是「加节点 / 删节点 / 改连线」
          if (TOPOLOGY_ARMED && TOPOLOGY_BASE && TOPOLOGY_FP[prop](next) !== TOPOLOGY_BASE[prop]) {
            _noteBlocked(label + ' 整体替换（拓扑变化）');
            return;
          }
          backing = seal(next, label);
        },
      });
    });
    TOPOLOGY_ARMED = true;
  }

  // 渲染是唯一被允许重新定义拓扑的时刻：进渲染前解除，装完按新拓扑重新立基线。
  function installTopologyGuard() {
    if (typeof graphView === 'undefined' || !graphView) return;
    var origRender = window.renderGraphCanvas;
    if (typeof origRender !== 'function' || origRender.__utopiaTopologyWrapped) return;
    var wrapped = function () {
      TOPOLOGY_ARMED = false;
      try {
        return origRender.apply(this, arguments);
      } finally {
        armTopologyGuard();
      }
    };
    wrapped.__utopiaTopologyWrapped = true;
    window.renderGraphCanvas = wrapped;
    armTopologyGuard();
  }

  // 只读画布手势：捕获期拦下画布上的双击（双击连线=删连线、双击空白=加节点面板、
  // 双击「我的理解」= 编辑）。函数桩已挡住实际写入，但调用方那句「已删除连线（Ctrl+Z
  // 可撤销）」是无条件弹的——桩生效时它照样弹，用户会以为真删了（实测踩过）。
  // 拦在捕获期让整个处理器不执行，提示也一并消失。
  function installReadOnlyCanvasGestures() {
    var canvas = document.getElementById('graphCanvas');
    if (!canvas || canvas.__utopiaReadonlyGestures) return;
    canvas.__utopiaReadonlyGestures = true;
    canvas.addEventListener('dblclick', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toast('只读快照：不能删除连线，也不能添加节点');
    }, true);
  }

  // 只读右键菜单：open 之后按白名单剪枝——查看器不提供新建/删除/端口增删/收藏知识点等写操作。
  // 用标签白名单而不是改 graph-contextmenu.js：菜单定义跟着主应用走，查看器只做减法。
  // 白名单里刻意没有「复制节点」：它的落地是 _graphCtxDuplicateNode → 真的多一个节点（用户要求只读）。
  //
  // ⚠️ 这份白名单是**按标签文本**匹配的，所以主应用那边一改菜单文案，这里必须同步——
  // 不同步的后果是查看器里那个菜单项被**静默剪掉**（整张菜单都空了还会顺手 close 掉），
  // 症状是「只读页右键少了一项」而不是任何报错。smoke 有一条交叉断言盯着这个。
  //
  // 顺带修掉一处**一直存在的错**（2026-09-27 交叉断言上线时暴露）：这里原先写的是
  // 「折叠此节点 / 展开此节点」，而菜单里的真实文案是「折叠节点 / 展开节点」
  // （graph-contextmenu.js:109，前缀匹配对不上）——所以只读页从来就没出现过这两项，
  // 而看长内容时折叠节点恰恰是最该给的。已改成真实文案。
  var READONLY_MENU_LABELS = [
    '复制全文', '居中此节点', '折叠节点', '展开节点',
    '适配画布', '缩放复位 100%', '导出',
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
    // 兜网要装在第一次渲染之前：applySnapshot 会调 renderGraphCanvas
    installTopologyGuard();
    installReadOnlyPanels();
    installReadOnlyCanvasGestures();
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
