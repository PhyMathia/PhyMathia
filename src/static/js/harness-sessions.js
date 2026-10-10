// ====== Φ 会话管理：多会话/绑定画布/迁移与菜单（2026-10-10 自 harness.js 拆出，T261 纯搬家）=====
// 域内 let（phiSessions/currentPhiId）与 23 个 window 导出随段迁移；文件尾的
// _initPhiSessions() 是原顶层立即调用随域搬家（其同步前缀读 phiSessions，必须
// 在本 chunk 内 let 声明之后执行）。共享状态块仍在 harness.js 顶部。
  function resetHarnessSession(opts) {
    // Φ 会话切换/清空/删除当前时重置。epoch 只在这里递增——解耦后切画布
    // 不再触发本函数（session.js setCurrentSessionId 改调 notifyHarnessCanvasChanged），
    // 在途的纯问答请求不会被切画布打断。
    // 切换提示只在用户真实切换 Φ 会话时显示（opts.showNotice）——页面加载/
    // 新建/清空也走这里，不该每次都往聊天区插「已切换」横幅。
    harnessSessionEpoch++;
    harnessHistoryLoad++;
    if (harnessAbortController) harnessAbortController.abort();
    harnessAbortController = null;
    harnessResult = null;
    harnessSnapshot = null;
    harnessPendingClarify = null;
    harnessSingleEvalId = null;
    harnessHistory = [];
    harnessLastAppliedOps = [];
    harnessLastAppliedBeforeSnapshot = null;
    harnessLastAppliedReport = null;
    // 配方目标选择是「这次请求的上下文」：切/清/删 Φ 会话后必须清掉，否则下一句
    // preset 消息会静默带上上一个会话选的配方（把 A 会话的目标改到 B 会话去）。
    // 面板 DOM 常驻，getElementById 直接改值即可；面板未创建时 getElementById 返回 null。
    const recipeTargetResetEl = document.getElementById('graphHarnessRecipeTarget');
    if (recipeTargetResetEl) recipeTargetResetEl.value = '';
    // T96：撤销时间线是会话级视图——切/清/删 Φ 会话时收起并清空，别残留上一个
    // 会话的批次行（行里的快照只能在对应会话里取，留着只会点了报「找不到前态」）
    const undoTimelineBox = document.getElementById('graphHarnessUndoTimeline');
    if (undoTimelineBox) { undoTimelineBox.hidden = true; undoTimelineBox.innerHTML = ''; }
    // T88：会话切换/清空/删除当前后旧建议不再算已应用；两个应用按钮同步放开
    // （否则切走再切回会看到能点却点了报错的禁用态，直到下一条结果渲染才恢复）
    harnessResultApplied = false;
    const _rs1 = document.getElementById('graphHarnessApplySelectedBtn');
    if (_rs1) _rs1.disabled = false;
    const _rs2 = document.getElementById('graphHarnessApplyAllBtn');
    if (_rs2) _rs2.disabled = false;
    _setHarnessBusy(false);
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    _loadHarnessHistory().then(() => {
      _renderHarnessChat();
      if (opts && opts.showNotice) _showHarnessSessionSwitchNotice();
      _syncHarnessSessionBtn();
    });
  }
  window.resetHarnessSession = resetHarnessSession;

  // ===== Φ 独立会话（2026-09-30 与画布解耦）=====
  // 旧设计「Φ 对话按画布会话隔离存储、Φ 侧零会话数据」自此废止：Φ 有自己的会话
  // id 空间（phi_<uuid>），名单存 phymathia_phi_sessions（镜像服务端 KV 全局键
  // phi_sessions），当前指针存 phymathia_current_phi_session，历史键挂 phi id。
  // 会话可选绑定一张画布：绑定后可改图（写回绑定的画布），未绑定只能问答。
  // 删 Φ 会话 / 清 Φ 对话只动对话，画布永远不动——删画布入口只在左侧栏。
  let phiSessions = {};
  let currentPhiId = '';

  function _phiId() { return currentPhiId; }

  function _phiList() {
    return Object.values(phiSessions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  function _currentPhiSession() {
    return phiSessions[currentPhiId] || null;
  }

  function _phiLocalKey(id) { return 'phymathia_harness_history_' + id; }

  function _newPhiId() {
    return 'phi_' + (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replace(/-/g, '')
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }

  function _phiCanvasInfo(sid) {
    let info = typeof window.getSessionById === 'function' ? window.getSessionById(sid) : null;
    if (!info) {
      // 会话名单可能尚未装载进内存（页面加载时序：迁移先于 session.js 的 loadSessions），
      // 直接查名单存储兜底——迁移出的旧会话必须拿到画布标题与绑定
      try {
        const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_SESSIONS) || '{}');
        info = (raw && typeof raw === 'object' && raw[sid]) || null;
      } catch (e) {}
    }
    return info || null;
  }

  function _phiCanvasTitle(sid) {
    return (_phiCanvasInfo(sid) && _phiCanvasInfo(sid).title) || '';
  }

  function _phiCanvasAlive(sid) {
    if (!sid) return false;
    // 会话模块未就绪（极端时序/沙箱）时先假定存在；真删画布由 phiCanvasDeleted 钩子解绑兜底
    if (typeof window.getSessionById !== 'function') return true;
    return !!_phiCanvasInfo(sid);
  }

  // 当前 Φ 会话绑定的画布（绑定的画布已删则视为未绑定——对话保留，可换绑）
  function _harnessBoundSid() {
    const s = _currentPhiSession();
    if (!s || !s.boundSid || !_phiCanvasAlive(s.boundSid)) return '';
    return s.boundSid;
  }

  function _loadPhiSessionsSync() {
    phiSessions = {};
    currentPhiId = '';
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_PHI_SESSIONS) || '{}');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) phiSessions = raw;
    } catch (e) {}
    try { currentPhiId = localStorage.getItem(STORAGE_KEY_PHI_CURRENT) || ''; } catch (e) {}
    if (currentPhiId && !phiSessions[currentPhiId]) currentPhiId = '';
  }

  async function _savePhiSessions() {
    try { localStorage.setItem(STORAGE_KEY_PHI_SESSIONS, JSON.stringify(phiSessions)); } catch (e) {}
    try { localStorage.setItem(STORAGE_KEY_PHI_CURRENT, currentPhiId); } catch (e) {}
    // 名单镜像服务端 KV 全局键 phi_sessions：换浏览器/清缓存不丢名单（历史本就在服务端）
    try {
      await fetch('/api/kv/phi_sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: phiSessions }),
      });
    } catch (e) {}
  }

  async function _mergePhiSessionsFromServer() {
    try {
      const resp = await fetch('/api/kv/phi_sessions');
      if (!resp.ok) return;
      const data = await resp.json();
      const remote = data && data.value;
      if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;
      let changed = false;
      Object.values(remote).forEach(item => {
        if (!item || !item.id) return;
        const local = phiSessions[item.id];
        if (!local || (item.updatedAt || 0) > (local.updatedAt || 0)) {
          phiSessions[item.id] = item;
          changed = true;
        }
      });
      if (changed) await _savePhiSessions();
    } catch (e) {}
  }

  function createPhiSession(bindCurrent) {
    const id = _newPhiId();
    const canvasSid = _sessionId();
    phiSessions[id] = {
      id,
      title: '新 Φ 会话',
      // 默认绑当前画布（改图开箱即用）；bindCurrent === false 或无画布时不绑
      boundSid: bindCurrent !== false && _phiCanvasAlive(canvasSid) ? canvasSid : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    currentPhiId = id;
    _savePhiSessions();
    resetHarnessSession();
    return id;
  }

  function switchPhiSession(id) {
    if (!id || id === currentPhiId || !phiSessions[id]) return;
    currentPhiId = id;
    phiSessions[id].updatedAt = Date.now();
    _savePhiSessions();
    resetHarnessSession({ showNotice: true });
  }

  function _refreshHarnessSessionMenuIfOpen() {
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (menu && menu.hidden === false) _renderHarnessSessionMenu();
  }

  function notifyHarnessCanvasChanged() {
    // 画布切换不再重置 Φ 会话（解耦后对话独立）；只清上一张画布的预览与差异高亮
    // （幽灵节点残留在新画布上是事故）、刷新绑定显示与打开着的菜单
    if (typeof window.clearGraphHarnessPreview === 'function') window.clearGraphHarnessPreview();
    if (typeof window.clearGraphDiffHighlights === 'function') window.clearGraphDiffHighlights();
    // 画布换了，上一张画布上选的修改目标不再适用（详见 resetHarnessSession 同款注释）
    const recipeTargetEl = document.getElementById('graphHarnessRecipeTarget');
    if (recipeTargetEl) recipeTargetEl.value = '';
    _refreshHarnessSessionMenuIfOpen();
    _syncHarnessSessionBtn();
  }
  window.notifyHarnessCanvasChanged = notifyHarnessCanvasChanged;

  // 画布被删/被清空（session.js deleteSession / clearAllSessions 回调）：解绑对应
  // Φ 会话——对话保留、变成纯问答，可随时换绑到别的画布
  function phiCanvasDeleted(sid) {
    let changed = false;
    Object.values(phiSessions).forEach(s => {
      if (s.boundSid === sid) { s.boundSid = null; s.updatedAt = Date.now(); changed = true; }
    });
    if (changed) {
      _savePhiSessions();
      _refreshHarnessSessionMenuIfOpen();
      _syncHarnessSessionBtn();
    }
  }
  window.phiCanvasDeleted = phiCanvasDeleted;

  function phiCanvasesCleared() {
    let changed = false;
    Object.values(phiSessions).forEach(s => {
      if (s.boundSid) { s.boundSid = null; s.updatedAt = Date.now(); changed = true; }
    });
    if (changed) {
      _savePhiSessions();
      _refreshHarnessSessionMenuIfOpen();
      _syncHarnessSessionBtn();
    }
  }
  window.phiCanvasesCleared = phiCanvasesCleared;

  function _syncHarnessSessionBtn() {
    const btn = document.getElementById('graphHarnessSessionBtn');
    if (!btn) return;
    const s = _currentPhiSession();
    const title = (s && s.title) || 'Φ 会话';
    btn.textContent = '《' + title + '》';
    btn.title = s && s.boundSid
      ? 'Φ 会话「' + title + '」· 绑定画布《' + (_phiCanvasTitle(s.boundSid) || '未知') + '》，点击管理 Φ 会话'
      : 'Φ 会话「' + title + '」· 未绑定画布（只能问答），点击管理 Φ 会话';
  }

  function _showHarnessSessionSwitchNotice() {
    const s = _currentPhiSession();
    if (!s) return;
    const chat = document.getElementById('graphHarnessChat');
    // prepend 守卫：装饰性横幅不配让异常冒泡（异步链跑到桩 DOM/异常环境时静默放弃）
    if (!chat || typeof chat.prepend !== 'function') return;
    const notice = document.createElement('div');
    notice.className = 'graph-harness-session-notice';
    notice.textContent = '已切换到 Φ 会话「' + (s.title || 'Φ 会话') + '」';
    chat.prepend(notice);
  }

  // 菜单底部的危险区（新建钮下方那条）。抽成独立函数是因为 armed 切换**只能**
  // 重渲染 footer 自身，绝不能整块重建 menu.innerHTML——那会把用户刚点的那颗按钮
  // 从文档里摘出去，同一个点击继续冒泡到 document 时，ensureHarnessPanel 的
  // 「点菜单外收起」监听器看到 target.closest('#graphHarnessSession') 已是 null，
  // 当场把菜单关掉：确认条进了 DOM，用户却什么都看不见（2026-09-30 真机复现）。
  function _renderHarnessClearAllFooter() {
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (!menu) return;
    let footer = menu.querySelector('.graph-harness-session-menu-footer');
    if (!footer) {
      footer = document.createElement('div');
      footer.className = 'graph-harness-session-menu-footer';
      menu.appendChild(footer);
    }
    const icons = typeof UI_ICON_SVG !== 'undefined' ? UI_ICON_SVG : {};
    const trashSvg = icons.trash || '✕';
    // armed 态在变量里，所以菜单因为切画布/删画布/换绑而重渲染时确认条会被复原
    footer.innerHTML = clearAllArmed
      ? '<div class="graph-harness-clearall-confirm">'
        + '<span>清空所有 Φ 对话？画布全部保留，不可撤销</span>'
        + '<button type="button" onclick="confirmClearAllHarnessSessions(true, event)">确认清空</button>'
        + '<button type="button" onclick="confirmClearAllHarnessSessions(false, event)">取消</button>'
        + '</div>'
      : '<button type="button" class="graph-harness-session-clearall" onclick="clearAllHarnessSessions(event)" title="删除全部 Φ 对话记录，画布全部保留，不可撤销">' + trashSvg + ' 清空所有 Φ 对话</button>';
  }

  function _renderHarnessSessionMenu() {
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (!menu) return;
    const icons = typeof UI_ICON_SVG !== 'undefined' ? UI_ICON_SVG : {};
    const plusSvg = icons.plus || '＋';
    menu.innerHTML = ''
      + '<button type="button" class="graph-harness-session-new" onclick="newHarnessPhiSession()" title="新建一段 Φ 对话（默认绑定当前画布）">' + plusSvg + ' 新建 Φ 会话</button>'
      // T104：会话搜索——过滤只重渲染下方列表容器（_renderHarnessSessionList），
      // 搜索框自身不重建，输入焦点不丢；过滤词存变量，菜单整体重渲染后回填
      + '<div class="graph-harness-session-search">'
      + '<input type="text" id="graphHarnessSessionSearch" placeholder="搜索 Φ 会话标题…" value="' + _escapeHtml(harnessSessionFilter) + '" oninput="filterHarnessSessions(this.value)">'
      + '</div>'
      + '<div class="graph-harness-session-list" id="graphHarnessSessionList"></div>'
      + '<div class="graph-harness-session-menu-footer"></div>';
    _renderHarnessSessionList();
    _renderHarnessClearAllFooter();
  }

  // 会话列表体（搜索过滤＋行内改名都在这里重渲染；列表容器 id 稳定供上面引用）
  function _renderHarnessSessionList() {
    const box = document.getElementById('graphHarnessSessionList');
    if (!box) return;
    const icons = typeof UI_ICON_SVG !== 'undefined' ? UI_ICON_SVG : {};
    const trashSvg = icons.trash || '✕';
    const linkSvg = icons.link || '⛓';
    const penSvg = icons.pen || '✎';
    const filter = String(harnessSessionFilter || '').trim().toLowerCase();
    const list = _phiList().filter(item => !filter
      || String(item.title || '').toLowerCase().indexOf(filter) >= 0);
    const rows = list.map(item => {
      // T104：行内改名态（与清空内联确认同款范式：临时态只在变量/DOM 里，重渲染即复位）
      if (item.id === renamingPhiId) {
        return '<div class="graph-harness-session-row graph-harness-session-row-rename">'
          + '<input type="text" id="graphHarnessRenameInput" maxlength="30" value="' + _escapeHtml(item.title || '') + '" onkeydown="renameSessionKeydown(event)">'
          + '<button type="button" class="graph-harness-session-rename-ok" onclick="confirmRenameHarnessSession(true)">确定</button>'
          + '<button type="button" class="graph-harness-session-rename-cancel" onclick="confirmRenameHarnessSession(false)">取消</button>'
          + '</div>';
      }
      const boundAlive = item.boundSid && _phiCanvasAlive(item.boundSid);
      const bindLabel = item.boundSid
        ? (boundAlive ? '绑定：' + (_phiCanvasTitle(item.boundSid) || '未知画布') : '绑定的画布已删除')
        : '未绑定';
      return '<div class="graph-harness-session-row">'
        + '<button type="button" class="graph-harness-session-item' + (item.id === currentPhiId ? ' current' : '') + '" onclick="chooseHarnessSession(\'' + item.id + '\')" title="切换到这段 Φ 对话">'
        + '<span class="graph-harness-session-item-title">' + _escapeHtml(item.title || 'Φ 会话') + '</span>'
        + '<span class="graph-harness-session-item-bind">' + _escapeHtml(bindLabel) + '</span>'
        + '</button>'
        + '<button type="button" class="graph-harness-session-rename" onclick="renameHarnessSession(\'' + item.id + '\')" title="重命名该 Φ 会话">' + penSvg + '</button>'
        + '<button type="button" class="graph-harness-session-bind" onclick="toggleHarnessSessionBinding(\'' + item.id + '\')" title="'
        + (item.boundSid ? '解绑画布（解绑后这段对话只能问答）' : '绑定到当前打开的画布（绑定后可改图）') + '">' + linkSvg + '</button>'
        + '<button type="button" class="graph-harness-session-del" onclick="deleteHarnessSession(\'' + item.id + '\')" title="删除该 Φ 会话（画布不受影响）">' + trashSvg + '</button>'
        + '</div>';
    }).join('');
    box.innerHTML = rows
      || '<div class="graph-harness-session-empty">' + (filter ? '没有匹配的 Φ 会话' : '暂无 Φ 会话') + '</div>';
    const renameInput = document.getElementById('graphHarnessRenameInput');
    if (renameInput && typeof renameInput.focus === 'function') { renameInput.focus(); renameInput.select(); }
  }

  // T104：搜索/改名的三个入口（内联 onclick 用，均 window 导出）
  function filterHarnessSessions(value) {
    harnessSessionFilter = String(value || '');
    _renderHarnessSessionList();
  }

  function renameHarnessSession(id) {
    if (!id || !phiSessions[id]) return;
    renamingPhiId = id;
    _renderHarnessSessionList();
  }

  function renameSessionKeydown(event) {
    if (!event) return;
    if (event.key === 'Enter') { event.preventDefault(); confirmRenameHarnessSession(true); }
    else if (event.key === 'Escape') { event.preventDefault(); confirmRenameHarnessSession(false); }
  }

  function confirmRenameHarnessSession(proceed) {
    const id = renamingPhiId;
    renamingPhiId = '';
    const s = id ? phiSessions[id] : null;
    if (proceed && s) {
      const input = document.getElementById('graphHarnessRenameInput');
      const title = String((input && input.value) || '').trim().slice(0, 30);
      if (title && title !== s.title) {
        s.title = title;
        s.updatedAt = Date.now();
        _savePhiSessions();
        _syncHarnessSessionBtn();
      }
    }
    _renderHarnessSessionList();
  }

  function toggleHarnessSessionMenu(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (!menu) return;
    // 「=== false 才收起」而非「!hidden 就收起」：冒烟沙箱的宽松 DOM 代理读 hidden
    // 得到真值对象，=== false 的写法让真实 DOM 语义不变、沙箱能走到建菜单分支
    if (menu.hidden === false) { menu.hidden = true; return; }
    _renderHarnessSessionMenu();
    menu.hidden = false;
  }

  // T119：生成中的守卫原本只往状态行写一句（提示在菜单外面，用户看不见），
  // 观感等同按钮失灵——守卫命中时补一颗 toast，至少知道「为什么没反应」
  function _harnessBusyToast(action) {
    if (typeof toastMsg === 'function') toastMsg('正在生成中，稍候再' + action);
  }

  function chooseHarnessSession(id) {
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (menu) menu.hidden = true;
    // T89：生成中切 Φ 会话会经 switchPhiSession → resetHarnessSession → abort 静默掐断
    // 在途请求，这里与新建/删除/清空/换绑同款守卫挡住
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等任务完成后再切换 Φ 会话', 'error'); _harnessBusyToast('切换 Φ 会话'); return; }
    clearAllArmed = false;
    switchPhiSession(id);
  }

  function newHarnessPhiSession() {
    const menu = document.getElementById('graphHarnessSessionMenu');
    if (menu) menu.hidden = true;
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等任务完成后再新建 Φ 会话', 'error'); _harnessBusyToast('新建 Φ 会话'); return; }
    clearAllArmed = false;
    createPhiSession(true);
  }

  // 删除 Φ 会话：只删这段对话（本地历史键＋服务端 harness_history:phi_*＋事件日志），
  // 画布与图内容完全不碰。删当前会话自动切最近的，一个不剩就新建。
  function deleteHarnessSession(id) {
    if (!id || !phiSessions[id]) return;
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等任务完成后再删除 Φ 会话', 'error'); _harnessBusyToast('删除 Φ 会话'); return; }
    const info = phiSessions[id];
    if (typeof window.confirm === 'function' && !window.confirm('删除 Φ 会话「' + (info.title || 'Φ 会话') + '」？\n只删除这段对话记录，画布不受影响。')) return;
    clearAllArmed = false;
    try { localStorage.removeItem(_phiLocalKey(id)); } catch (e) {}
    try { fetch('/api/kv/' + encodeURIComponent(_historyKey(id)), { method: 'DELETE' }).catch(() => {}); } catch (e) {}
    // T127：事件日志（logs/harness_events/phi_*.jsonl）存着完整 prompt 与模型原话，
    // 删对话必须连磁盘一起清，否则「以为删了其实还在」
    try { fetch('/api/harness/graph/events?session_id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {}); } catch (e) {}
    delete phiSessions[id];
    if (currentPhiId === id) {
      const rest = _phiList();
      if (rest.length) {
        currentPhiId = rest[0].id;
        _savePhiSessions();
        resetHarnessSession();
      } else {
        createPhiSession(true);
      }
    } else {
      _savePhiSessions();
    }
    _refreshHarnessSessionMenuIfOpen();
    _syncHarnessSessionBtn();
    _setHarnessStatus('已删除 Φ 会话「' + (info.title || 'Φ 会话') + '」（画布不受影响）', 'ok');
  }
  window.toggleHarnessSessionMenu = toggleHarnessSessionMenu;
  window.chooseHarnessSession = chooseHarnessSession;
  window.newHarnessPhiSession = newHarnessPhiSession;
  window.deleteHarnessSession = deleteHarnessSession;
  // T104：搜索与行内改名的内联 onclick 入口
  window.filterHarnessSessions = filterHarnessSessions;
  window.renameHarnessSession = renameHarnessSession;
  window.renameSessionKeydown = renameSessionKeydown;
  window.confirmRenameHarnessSession = confirmRenameHarnessSession;
  // T105：空态示例问题按钮
  window.sendHarnessExample = sendHarnessExample;
  // T103：重试气泡的「复制错误详情」
  window._copyHarnessErrorDetails = _copyHarnessErrorDetails;

  // 一键清空：只删 Φ 对话（历史本地键＋服务端），画布一律不动——session.js
  // clearAllSessions 的清空键清单刻意不含 phi_* 键，两个「清空」互不越界。
  // 清空后自动新建一个绑当前画布的空白 Φ 会话，面板不落空态。
  // T92：原生 confirm 换成菜单内联二次确认条。T118：两处修正——
  // ①armed 态改由 clearAllArmed 变量持有，扛得住切画布/删画布/换绑引起的菜单重渲染
  // ②切换 armed 只重渲染 footer（_renderHarnessClearAllFooter），不碰菜单外壳：
  //   整块重建 menu.innerHTML 会把用户刚点的按钮自己摘出文档，同一个点击冒泡到
  //   document 时被「点菜单外收起」监听器判成外部点击、当场关掉菜单——确认条进了
  //   DOM，用户却什么都看不见，表现为「点了完全没变化」（2026-09-30 真机复现）
  function clearAllHarnessSessions(event) {
    // 关键：armed 切换必然换掉这颗按钮自己（footer 内容变了），若放任事件继续冒泡
    // 到 document，ensureHarnessPanel 的「点菜单外收起」监听器看到的 target 已是脱离
    // 文档的旧按钮，closest('#graphHarnessSession') 返回 null，当场把菜单关掉——确认条
    // 进了 DOM 而用户什么都看不见。事件止步于按钮，菜单不会被误收。
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等任务完成后再清空 Φ 对话', 'error'); _harnessBusyToast('清空 Φ 对话'); return; }
    const menu = document.getElementById('graphHarnessSessionMenu');
    const footer = menu && typeof menu.querySelector === 'function'
      ? menu.querySelector('.graph-harness-session-menu-footer')
      : null;
    // 只在真 DOM 的菜单里挂确认条；nodeType 守卫让没有真实菜单载体的调用
    // （冒烟沙箱的宽松 DOM 代理、程序化调用）直接走清空主体
    if (footer && footer.nodeType === 1) {
      clearAllArmed = true;
      _renderHarnessClearAllFooter();
      return;
    }
    _doClearAllHarnessSessions();
  }

  // 内联确认条的落点（全局给 onclick 用）：false＝取消，解除 armed 并复原 footer；
  // true＝先解除 armed、复原 footer 再执行清空主体（无残留 armed 态）
  function confirmClearAllHarnessSessions(proceed, event) {
    // 同 clearAllHarnessSessions：确认/取消两颗钮点完也会被重渲染换掉，事件不能
    // 再冒到 document 去把菜单收走（cancel 尤其重要——用户点了「取消」却连菜单
    // 一起消失，观感上等同按钮失灵）
    if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    if (!proceed) { clearAllArmed = false; _renderHarnessClearAllFooter(); return; }
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等任务完成后再清空 Φ 对话', 'error'); _harnessBusyToast('清空 Φ 对话'); return; }
    clearAllArmed = false;
    _renderHarnessClearAllFooter();
    _doClearAllHarnessSessions();
  }

  // 清空主体（T92 从 clearAllHarnessSessions 拆出，供内联确认条复用）
  function _doClearAllHarnessSessions() {
    const ids = Object.keys(phiSessions);
    ids.forEach(id => { try { localStorage.removeItem(_phiLocalKey(id)); } catch (e) {} });
    ids.forEach(id => {
      try { fetch('/api/kv/' + encodeURIComponent(_historyKey(id)), { method: 'DELETE' }).catch(() => {}); } catch (e) {}
    });
    // T127：事件日志含完整 prompt 与模型原话，清空必须连磁盘一起清；
    // all=1 顺带扫掉 phiSessions 已丢失的孤儿事件文件（换浏览器/清缓存后的残留）
    try { fetch('/api/harness/graph/events?all=1', { method: 'DELETE' }).catch(() => {}); } catch (e) {}
    phiSessions = {};
    currentPhiId = '';
    createPhiSession(true);
    _refreshHarnessSessionMenuIfOpen();
    _syncHarnessSessionBtn();
    _setHarnessStatus('已清空所有 Φ 对话（画布全部保留，磁盘日志一并清除）', 'ok');
  }
  window.clearAllHarnessSessions = clearAllHarnessSessions;
  window.confirmClearAllHarnessSessions = confirmClearAllHarnessSessions;

  // 行内换绑钮：已绑定 → 解绑（变纯问答）；未绑定/绑定的画布已删 → 绑当前画布
  function toggleHarnessSessionBinding(id) {
    const s = phiSessions[id];
    if (!s) return;
    if (harnessBusy) { _setHarnessStatus('当前正在生成，等任务完成后再换绑', 'error'); return; }
    clearAllArmed = false;
    const canvasSid = _sessionId();
    if (s.boundSid && _harnessBoundSid()) {
      s.boundSid = null;
      _setHarnessStatus('Φ 会话「' + (s.title || '') + '」已解绑画布，只能问答', 'ok');
    } else {
      if (!canvasSid || !_phiCanvasAlive(canvasSid)) {
        _setHarnessStatus('当前没有画布可绑定', 'error');
        return;
      }
      s.boundSid = canvasSid;
      _setHarnessStatus('Φ 会话「' + (s.title || '') + '」已绑定当前画布《' + (_phiCanvasTitle(canvasSid) || '未命名画布') + '》', 'ok');
    }
    s.updatedAt = Date.now();
    _savePhiSessions();
    _refreshHarnessSessionMenuIfOpen();
    _syncHarnessSessionBtn();
  }
  window.toggleHarnessSessionBinding = toggleHarnessSessionBinding;
  // ===== Φ 会话初始化与旧数据迁移（2026-09-30 解耦）=====
  const PHI_MIGRATION_FLAG = 'phymathia_phi_migration_done';

  // 旧数据形态：Φ 对话按画布 sid 存（phymathia_harness_history_<sess_…>）。逐份搬进
  // 独立 phi 会话（标题取画布名、绑该画布），搬完删旧本地键＋旧服务端键——顺带修掉
  // 「删画布后 harness_history 孤儿」的旧漏洞（旧 deleteSession/clearAllSessions 都不清它）。
  // 幂等：迁移一次即落标记；中途失败不落标记，下次页面加载自动重试。
  async function _migrateLegacyPhiHistory() {
    let done = false;
    try { done = localStorage.getItem(PHI_MIGRATION_FLAG) === '1'; } catch (e) {}
    if (done) return;
    const legacySids = {};
    try {
      lsKeys().forEach(k => {
        if (!k.startsWith('phymathia_harness_history_')) return;
        const sid = k.slice('phymathia_harness_history_'.length);
        if (sid && !sid.startsWith('phi_')) legacySids[sid] = true;
      });
    } catch (e) {}
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY_SESSIONS) || '{}');
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        Object.keys(raw).forEach(sid => { legacySids[sid] = true; });
      }
    } catch (e) {}
    for (const sid of Object.keys(legacySids)) {
      let entries = null;
      try {
        const local = JSON.parse(localStorage.getItem('phymathia_harness_history_' + sid) || 'null');
        if (Array.isArray(local) && local.length) entries = local;
      } catch (e) {}
      if (!entries) {
        // 本地没有不代表没数据（可能来自别的浏览器）：对每个旧画布补一次服务端兜底
        try {
          const resp = await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)));
          if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data.value) && data.value.length) entries = data.value;
          }
        } catch (e) {}
      }
      if (!entries) continue;
      const phiId = _newPhiId();
      phiSessions[phiId] = {
        id: phiId,
        title: _phiCanvasTitle(sid) || 'Φ 会话',
        boundSid: _phiCanvasAlive(sid) ? sid : null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const migrated = _migrateHarnessHistory(entries, sid);
      try { localStorage.setItem(_phiLocalKey(phiId), JSON.stringify(migrated.entries)); } catch (e) {}
      try {
        await fetch('/api/kv/' + encodeURIComponent(_historyKey(phiId)), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: migrated.entries }),
        });
      } catch (e) {}
      try { localStorage.removeItem('phymathia_harness_history_' + sid); } catch (e) {}
      try { await fetch('/api/kv/' + encodeURIComponent(_historyKey(sid)), { method: 'DELETE' }); } catch (e) {}
    }
    await _savePhiSessions();
    try { localStorage.setItem(PHI_MIGRATION_FLAG, '1'); } catch (e) {}
  }

  async function _initPhiSessions() {
    _loadPhiSessionsSync();
    try { await _migrateLegacyPhiHistory(); } catch (e) {}
    try { await _mergePhiSessionsFromServer(); } catch (e) {}
    if (!currentPhiId || !phiSessions[currentPhiId]) {
      const list = _phiList();
      if (list.length) {
        // 优先绑当前画布的会话（迁移后打开面板，看到的就是这张画布的那段对话）
        const canvasSid = _sessionId();
        const bound = list.find(s => s.boundSid && s.boundSid === canvasSid);
        currentPhiId = (bound || list[0]).id;
        _savePhiSessions();
        resetHarnessSession();
      } else {
        createPhiSession(true);
      }
    }
    _syncHarnessSessionBtn();
  }
  _initPhiSessions();
