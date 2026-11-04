// ===== PhyMathia Utopia 快照反向导入（主应用侧，不进 viewer 包） =====
// 把 .pmu 快照恢复成一张「新画布」：新建会话身份 + 消息 + 图状态三写（localStorage
// 与服务端 KV 都落），再走公开入口 syncFromServer + switchToSession 切换过去。
// 绝不覆盖任何现有会话——导入永远新建；重名没关系，列表按时间区分。
// 入口两个：① 把 .pmu 文件拖进页面任意位置（source 节点自己的投递区除外）；
//           ② 数据管理面板「导入快照」按钮（见 index.html）。
// 快照 messages 是导出时会话消息的完整拷贝，nodes.messageIndex 在快照内重映射过——
// 恢复后会话 chatHistory = snapshot.messages，节点下标天然对上（导出格式为此预留）。
//
// 2026-11-01：两个入口都先弹确认卡（标题可改、节点/消息数、导出时间、体积），确认后
// 才写数据——此前拖进去就直接新建画布，同名/重复导入也照建，用户没有任何反悔机会。
// 确认卡只挡文件入口；importUtopiaSnapshotText 直调（smoke/程序化恢复）仍保持原语义。

(function () {
  var SESSIONS_KEY = 'phymathia_sessions';

  function _esc(text) {
    if (typeof escapeHtml === 'function') return escapeHtml(text);
    return String(text == null ? '' : text).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function _fmtBytes(bytes) {
    var n = Number(bytes) || 0;
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function _fmtExportedAt(iso) {
    var s = String(iso || '').replace('T', ' ');
    return s ? s.slice(0, 16) : '';
  }

  // 纯函数：是否接受该文件为快照候选（.pmu 一律收；.json 需解析成功才算，见导入内部）
  function utopiaImportAccept(file) {
    if (!file) return false;
    return /\.pmu$/i.test(String(file.name || ''));
  }

  // ---------- 导入前确认卡 ----------

  var _importConfirmEl = null;
  var _importConfirmKeyHandler = null;

  function closeUtopiaImportConfirm() {
    if (_importConfirmKeyHandler) {
      document.removeEventListener('keydown', _importConfirmKeyHandler);
      _importConfirmKeyHandler = null;
    }
    if (_importConfirmEl && _importConfirmEl.parentNode) _importConfirmEl.parentNode.removeChild(_importConfirmEl);
    _importConfirmEl = null;
  }

  function openUtopiaImportConfirm(snap, text, fileName) {
    var streaming = (typeof isStreaming !== 'undefined') ? isStreaming : false;
    if (streaming) {
      toastMsg('AI 正在生成回答，请等这轮结束后再导入快照');
      return false;
    }
    closeUtopiaImportConfirm();
    var sum = (typeof window.utopiaSnapshotSummary === 'function')
      ? window.utopiaSnapshotSummary(snap)
      : { nodes: (snap.nodes || []).length, edges: (snap.edges || []).length, messages: (snap.messages || []).length };
    var bytes = 0;
    try { bytes = new Blob([text]).size; } catch (e) { bytes = String(text || '').length; }
    var meta = snap.meta || {};
    var title = String(snap.title || '导入的探索网').slice(0, 40);
    var lines = [
      sum.nodes + ' 节点 · ' + sum.edges + ' 连线 · ' + sum.messages + ' 条会话消息',
      '文件 ' + _fmtBytes(bytes),
      meta.level ? ('难度 ' + meta.level) : '',
      snap.exportedAt ? ('导出于 ' + _fmtExportedAt(snap.exportedAt)) : '',
      snap.app ? ('来自 ' + String(snap.app)) : '',
    ].filter(Boolean);
    var warns = [];
    if (bytes > 4 * 1024 * 1024) warns.push('文件较大，浏览器本地缓存可能放不下；会优先保存在服务端。');
    if (meta.exportMode === 'light') {
      var omitted = Number(meta.omittedMessages) || 0;
      warns.push('轻量存档：对话不完整' + (omitted ? '（省略 ' + omitted + ' 条未被画布引用的消息）' : '') + '，导入后只能恢复这部分对话。');
    } else if (meta.messagesComplete !== true) {
      warns.push('这份快照没有标记「完整会话」，导入后对话记录可能不全。');
    }

    var overlay = document.createElement('div');
    overlay.className = 'utopia-import-overlay';
    overlay.id = 'utopiaImportConfirm';
    overlay.innerHTML = '<div class="utopia-import-card aurora-glass aurora-glass--dialog" role="dialog" aria-modal="true" aria-labelledby="utopiaImportTitle">'
      + '<div class="utopia-import-card-title" id="utopiaImportTitle">导入快照</div>'
      + '<div class="utopia-import-card-sub">将新建一张画布，不影响现有内容。</div>'
      + '<label class="utopia-import-label">画布名称'
      + '<input type="text" class="utopia-import-input" id="utopiaImportName" maxlength="40" value="' + _esc(title) + '">'
      + '</label>'
      + '<div class="utopia-import-meta">' + lines.map(_esc).join('<br>') + '</div>'
      + (warns.length ? '<div class="utopia-import-warn">' + warns.map(_esc).join('<br>') + '</div>' : '')
      + '<div class="utopia-import-actions">'
      + '<button type="button" class="utopia-import-btn" id="utopiaImportCancel">取消</button>'
      + '<button type="button" class="utopia-import-btn primary" id="utopiaImportOk">创建画布</button>'
      + '</div></div>';
    document.body.appendChild(overlay);
    _importConfirmEl = overlay;

    var input = overlay.querySelector('#utopiaImportName');
    var okBtn = overlay.querySelector('#utopiaImportOk');
    var cancelBtn = overlay.querySelector('#utopiaImportCancel');

    function cancel() { closeUtopiaImportConfirm(); }
    function confirm() {
      var name = String(input && input.value || '').trim().slice(0, 40) || title;
      closeUtopiaImportConfirm();
      Promise.resolve(importUtopiaSnapshotText(text, fileName, { snapshot: snap, title: name }))
        .catch(function (e) { toastMsg('导入失败：' + (e && e.message ? e.message : e)); });
    }

    cancelBtn.addEventListener('click', cancel);
    okBtn.addEventListener('click', confirm);
    overlay.addEventListener('pointerdown', function (e) { if (e.target === overlay) cancel(); });
    _importConfirmKeyHandler = function (e) {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); confirm(); }
    };
    document.addEventListener('keydown', _importConfirmKeyHandler);
    if (input) {
      input.focus();
      input.select();
    }
    return true;
  }

  // ---------- 文件入口：先解析 + 确认，再写 ----------

  function importUtopiaSnapshotFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var text = String(reader.result || '');
      var parse = (typeof window.parseUtopiaSnapshot === 'function')
        ? window.parseUtopiaSnapshot(text)
        : { ok: false, error: '解析器未加载（请硬刷新页面）' };
      if (!parse.ok) { toastMsg('导入失败：' + parse.error); return; }
      openUtopiaImportConfirm(parse.snapshot, text, file && file.name);
    };
    reader.onerror = function () { toastMsg('读取快照文件失败'); };
    reader.readAsText(file);
  }

  async function importUtopiaSnapshotText(text, fileName, options) {
    var opts = options || {};
    // 写前检查：空文件/解析失败/流式生成中 → 直接返回，不写任何数据
    if (!text || !String(text).trim()) { toastMsg('快照文件为空'); return false; }
    var parse = opts.snapshot
      ? { ok: true, snapshot: opts.snapshot }
      : ((typeof window.parseUtopiaSnapshot === 'function')
        ? window.parseUtopiaSnapshot(text)
        : { ok: false, error: '解析器未加载（请硬刷新页面）' });
    if (!parse.ok) { toastMsg('导入失败：' + parse.error); return false; }
    var snap = parse.snapshot;
    // isStreaming 是主包顶层的 let（拼接产物同作用域可见）；不要经 window 读——
    // 部分环境 window 是代理对象，任何属性都"存在"且 truthy，会永远误判在生成中
    var streaming = (typeof isStreaming !== 'undefined') ? isStreaming : false;
    if (streaming) {
      toastMsg('AI 正在生成回答，请等这轮结束后再导入快照');
      return false;
    }

    var id = 'sess_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now() + Math.random().toString(36).slice(2));
    var sessionId = 'phymathia_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now() + Math.random().toString(36).slice(2));
    var meta = {
      id: id,
      title: String(opts.title || snap.title || '导入的探索网').slice(0, 40),
      sessionId: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      importedFrom: String(fileName || ''),
    };
    var msgs = Array.isArray(snap.messages) ? snap.messages : [];
    var state = (snap.graph && typeof snap.graph === 'object') ? snap.graph : {};
    state.updatedAt = Date.now();

    // 本地三写（读改写 sessions 列表 + 消息 + 图状态）——逐项记录成败；
    // 单项失败不中断整体（服务端仍可能成功），失败明细汇总到导入结果与提示
    var localOk = { sessions: false, msgs: false, graph: false };
    try {
      var all = {};
      try { all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {}; } catch (e) { all = {}; }
      all[id] = meta;
      var allJson = JSON.stringify(all);
      var msgsJson = JSON.stringify(msgs);
      var graphJson = JSON.stringify(state);
      if (typeof safeLocalStorageSet === 'function') {
        localOk.sessions = safeLocalStorageSet(SESSIONS_KEY, allJson) === true;
        localOk.msgs = safeLocalStorageSet('phymathia_msgs_' + id, msgsJson) === true;
        localOk.graph = safeLocalStorageSet('phymathia_graph_' + id, graphJson) === true;
      } else {
        try { localStorage.setItem(SESSIONS_KEY, allJson); localOk.sessions = true; } catch (e) {}
        try { localStorage.setItem('phymathia_msgs_' + id, msgsJson); localOk.msgs = true; } catch (e) {}
        try { localStorage.setItem('phymathia_graph_' + id, graphJson); localOk.graph = true; } catch (e) {}
      }
    } catch (e) { /* 本地写整体异常：三项按未成功计入 localFailed */ }
    var localFailed = ['sessions', 'msgs', 'graph']
      .filter(function (k) { return !localOk[k]; })
      .map(function (k) { return k === 'msgs' ? 'messages' : k; });

    // 服务端三写——逐个检查 res.ok（allSettled 之外还要看响应状态，不能假装成功）
    var jsonHead = { 'Content-Type': 'application/json' };
    var serverReqs = [
      { key: 'sessions', req: fetch('/api/sessions', { method: 'POST', headers: jsonHead, body: JSON.stringify({ ...meta, id: id }) }) },
      { key: 'messages', req: fetch('/api/sessions/' + encodeURIComponent(id) + '/messages', { method: 'POST', headers: jsonHead, body: JSON.stringify({ messages: msgs }) }) },
      { key: 'graph', req: fetch('/api/kv/' + encodeURIComponent('graph:' + id), { method: 'POST', headers: jsonHead, body: JSON.stringify({ value: state }) }) },
    ];
    var serverOk = { sessions: false, messages: false, graph: false };
    var serverResults = await Promise.allSettled(serverReqs.map(function (r) { return r.req; }));
    serverResults.forEach(function (r, i) {
      serverOk[serverReqs[i].key] = r.status === 'fulfilled' && !!(r.value && r.value.ok);
    });
    var serverFailed = ['sessions', 'messages', 'graph'].filter(function (k) { return !serverOk[k]; });

    // 决定是否切换：本地 sessions 或服务端 sessions 至少一处成功才切；都失败则不切换、不留空画布
    var result = {
      ok: false, id: id, title: meta.title,
      localOk: localOk, serverOk: serverOk,
      localFailed: localFailed, serverFailed: serverFailed,
    };
    var finish = function (value) {
      result.ok = value;
      window.__lastUtopiaImportResult = result;
      if (typeof opts.onResult === 'function') { try { opts.onResult(result); } catch (e) {} }
      return value;
    };
    if (!localOk.sessions && !serverOk.sessions) {
      toastMsg('画布没有创建成功：本机浏览器存储失败，服务端也写不进去（请检查浏览器存储空间或服务是否在运行）', TOAST_MS_LONG);
      result.reason = 'sessions-both-failed';
      return finish(false);
    }

    // 刷新会话内存（loadSessions 重读 localStorage）再切换
    try { if (typeof window.syncFromServer === 'function') await window.syncFromServer(); } catch (e) {}
    if (typeof window.switchToSession !== 'function') {
      toastMsg('导入完成，但切换模块未加载——请刷新页面查看新画布');
      result.switched = false;
      return finish(true);
    }
    await window.switchToSession(id);
    result.switched = true;
    var sum = (typeof window.utopiaSnapshotSummary === 'function') ? window.utopiaSnapshotSummary(snap) : { nodes: '?', edges: '?' };
    var suffix = '';
    if (serverFailed.length && localFailed.length) {
      suffix = '（云端同步失败：' + serverFailed.join('/') + '；本机缓存失败：' + localFailed.join('/') + '）';
    } else if (serverFailed.length) {
      suffix = '（已保存在本机，云端同步失败：' + serverFailed.join('/') + '）';
    } else if (localFailed.length) {
      suffix = '（已保存在服务端，本机缓存失败：' + localFailed.join('/') + '）';
    }
    toastMsg('快照已恢复为新画布「' + meta.title + '」：' + sum.nodes + ' 节点 / ' + sum.edges + ' 连线 / ' + msgs.length + ' 条消息' + suffix, TOAST_MS_LONG);
    return finish(true);
  }

  // ---------- 拖放：全屏提示 + 只收 .pmu，其余放行 ----------

  var _dropHintEl = null;

  function _hasFilePayload(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
  }

  function _inSourceDropzone(e) {
    return !!(e.target && e.target.closest && e.target.closest('.graph-source-body'));
  }

  function _dragLooksLikePmu(e) {
    var dt = e.dataTransfer;
    if (!dt) return false;
    var items = dt.items;
    if (!items || !items.length) return true; // 读不到名单时按「可能是」处理
    var named = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || (it.kind && it.kind !== 'file')) continue;
      var f = null;
      try { f = it.getAsFile ? it.getAsFile() : null; } catch (err) { f = null; }
      var name = f && f.name ? String(f.name) : '';
      if (!name) continue;
      named++;
      if (/\.pmu$/i.test(name)) return true;
    }
    return named === 0;
  }

  function _showDropHint() {
    if (!_dropHintEl) {
      _dropHintEl = document.createElement('div');
      _dropHintEl.className = 'utopia-import-hint';
      _dropHintEl.id = 'utopiaImportHint';
      _dropHintEl.innerHTML = '<div class="utopia-import-hint-card"><b>松开以导入 .pmu 快照</b>'
        + '<span>会新建一张画布，不影响现有内容</span></div>';
      document.body.appendChild(_dropHintEl);
    }
    _dropHintEl.classList.add('show');
  }

  function _hideDropHint() {
    if (_dropHintEl) _dropHintEl.classList.remove('show');
  }

  document.addEventListener('dragover', function (e) {
    if (!_hasFilePayload(e) || _inSourceDropzone(e)) { _hideDropHint(); return; }
    e.preventDefault(); // 收下拖放，否则 drop 事件到不了页面
    if (_dragLooksLikePmu(e)) _showDropHint();
    else _hideDropHint();
  });

  document.addEventListener('dragleave', function (e) {
    if (!e.relatedTarget) _hideDropHint();
  });

  document.addEventListener('drop', function (e) {
    _hideDropHint();
    if (!_hasFilePayload(e)) return;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !utopiaImportAccept(f)) return; // 非快照文件放行：source 节点 / 数据导入自己处理
    if (_inSourceDropzone(e)) return;
    e.preventDefault();
    importUtopiaSnapshotFile(f);
  });

  document.addEventListener('dragend', _hideDropHint);
  window.addEventListener('blur', _hideDropHint);

  // 数据管理面板入口（index.html 按钮触发）
  window.utopiaImportPick = function () {
    var input = document.getElementById('utopiaImportFileInput');
    if (input) { input.value = ''; input.click(); }
  };

  window.utopiaImportAccept = utopiaImportAccept;
  window.openUtopiaImportConfirm = openUtopiaImportConfirm;
  window.closeUtopiaImportConfirm = closeUtopiaImportConfirm;
  window.importUtopiaSnapshotText = importUtopiaSnapshotText;
  window.importUtopiaSnapshotFile = importUtopiaSnapshotFile;
})();
