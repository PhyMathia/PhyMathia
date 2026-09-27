// ===== PhyMathia Utopia 快照反向导入（主应用侧，不进 viewer 包） =====
// 把 .pmu 快照恢复成一张「新画布」：新建会话身份 + 消息 + 图状态三写（localStorage
// 与服务端 KV 都落），再走公开入口 syncFromServer + switchToSession 切换过去。
// 绝不覆盖任何现有会话——导入永远新建；重名没关系，列表按时间区分。
// 入口两个：① 把 .pmu 文件拖进页面任意位置（source 节点自己的投递区除外）；
//           ② 数据管理面板「导入快照」按钮（见 index.html）。
// 快照 messages 是导出时会话消息的完整拷贝，nodes.messageIndex 在快照内重映射过——
// 恢复后会话 chatHistory = snapshot.messages，节点下标天然对上（导出格式为此预留）。

(function () {
  var SESSIONS_KEY = 'phymathia_sessions';

  // 纯函数：是否接受该文件为快照候选（.pmu 一律收；.json 需解析成功才算，见导入内部）
  function utopiaImportAccept(file) {
    if (!file) return false;
    return /\.pmu$/i.test(String(file.name || ''));
  }

  function importUtopiaSnapshotFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      importUtopiaSnapshotText(String(reader.result || ''), file && file.name);
    };
    reader.onerror = function () { toastMsg('读取快照文件失败'); };
    reader.readAsText(file);
  }

  async function importUtopiaSnapshotText(text, fileName) {
    var parse = (typeof window.parseUtopiaSnapshot === 'function')
      ? window.parseUtopiaSnapshot(text)
      : { ok: false, error: '解析器未加载（请硬刷新页面）' };
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
      title: String(snap.title || '导入的探索网').slice(0, 40),
      sessionId: sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      importedFrom: String(fileName || ''),
    };
    var msgs = Array.isArray(snap.messages) ? snap.messages : [];
    var state = (snap.graph && typeof snap.graph === 'object') ? snap.graph : {};
    state.updatedAt = Date.now();

    // 本地三写（读改写 sessions 列表 + 消息 + 图状态）
    try {
      var all = {};
      try { all = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}') || {}; } catch (e) { all = {}; }
      all[id] = meta;
      if (typeof safeLocalStorageSet === 'function') {
        safeLocalStorageSet(SESSIONS_KEY, JSON.stringify(all));
        safeLocalStorageSet('phymathia_msgs_' + id, JSON.stringify(msgs));
        safeLocalStorageSet('phymathia_graph_' + id, JSON.stringify(state));
      } else {
        localStorage.setItem(SESSIONS_KEY, JSON.stringify(all));
        localStorage.setItem('phymathia_msgs_' + id, JSON.stringify(msgs));
        localStorage.setItem('phymathia_graph_' + id, JSON.stringify(state));
      }
    } catch (e) { /* 本地写失败不阻断：服务端为主，切换时服务端兜底 */ }

    // 服务端三写（全部 fire-and-forget，失败时本地仍在）
    var jsonHead = { 'Content-Type': 'application/json' };
    await Promise.allSettled([
      fetch('/api/sessions', { method: 'POST', headers: jsonHead, body: JSON.stringify({ ...meta, id: id }) }),
      fetch('/api/sessions/' + encodeURIComponent(id) + '/messages', { method: 'POST', headers: jsonHead, body: JSON.stringify({ messages: msgs }) }),
      fetch('/api/kv/' + encodeURIComponent('graph:' + id), { method: 'POST', headers: jsonHead, body: JSON.stringify({ value: state }) }),
    ]);

    // 刷新会话内存（loadSessions 重读 localStorage）再切换
    try { if (typeof window.syncFromServer === 'function') await window.syncFromServer(); } catch (e) {}
    if (typeof window.switchToSession !== 'function') { toastMsg('导入完成，但切换模块未加载——请刷新页面查看新画布'); return true; }
    await window.switchToSession(id);
    var sum = (typeof window.utopiaSnapshotSummary === 'function') ? window.utopiaSnapshotSummary(snap) : { nodes: '?', edges: '?' };
    toastMsg('快照已恢复为新画布「' + meta.title + '」：' + sum.nodes + ' 节点 / ' + sum.edges + ' 连线 / ' + msgs.length + ' 条消息', TOAST_MS_LONG);
    return true;
  }

  // ---------- 拖放：只收 .pmu，其余放行（source 节点投递区 / 浏览器默认） ----------

  function _hasFilePayload(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
  }

  function _inSourceDropzone(e) {
    return !!(e.target && e.target.closest && e.target.closest('.graph-source-body'));
  }

  document.addEventListener('dragover', function (e) {
    if (!_hasFilePayload(e) || _inSourceDropzone(e)) return;
    e.preventDefault(); // 收下拖放，否则 drop 事件到不了页面
  });

  document.addEventListener('drop', function (e) {
    if (!_hasFilePayload(e)) return;
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f || !utopiaImportAccept(f)) return; // 非快照文件放行：source 节点 / 数据导入自己处理
    if (_inSourceDropzone(e)) return;
    e.preventDefault();
    importUtopiaSnapshotFile(f);
  });

  // 数据管理面板入口（index.html 按钮触发）
  window.utopiaImportPick = function () {
    var input = document.getElementById('utopiaImportFileInput');
    if (input) { input.value = ''; input.click(); }
  };

  window.utopiaImportAccept = utopiaImportAccept;
  window.importUtopiaSnapshotText = importUtopiaSnapshotText;
  window.importUtopiaSnapshotFile = importUtopiaSnapshotFile;
})();
