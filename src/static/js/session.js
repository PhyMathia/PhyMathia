    // ====== 多会话管理 ======
    let sessions = {};
    let currentSessionId = null;
    let isStreaming = false;
    let chatHistory = [];
    let abortController = null;

    // ====== 服务端持久化存储层 ======
    let _serverAvailable = null;
    let _serverAvailableCheckedAt = 0;
    const SERVER_CHECK_TTL_MS = 30000; // 失败结果 30 秒后允许重试，避免首轮探测失败被永久缓存

    async function _checkServer() {
      if (_serverAvailable === true) return true;
      if (_serverAvailable === false && (Date.now() - _serverAvailableCheckedAt) < SERVER_CHECK_TTL_MS) return false;
      try {
        const resp = await fetch('/api/sessions', { cache: 'no-cache', signal: AbortSignal.timeout(3000) });
        _serverAvailable = resp.ok;
      } catch {
        _serverAvailable = false;
      }
      _serverAvailableCheckedAt = Date.now();
      console.log('[Storage] Server available:', _serverAvailable);
      return _serverAvailable;
    }

    async function _fetchServerMessagesBatch(sessionIds) {
      if (!sessionIds || sessionIds.length === 0) return {};
      try {
        const resp = await fetch('/api/sessions/messages-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session_ids: sessionIds }),
          cache: 'no-cache'
        });
        if (resp.ok) {
          const data = await resp.json();
          const map = data && data.messages && typeof data.messages === 'object' && !Array.isArray(data.messages)
            ? data.messages
            : {};
          return map;
        }
      } catch (e) {
        console.warn('[Storage] Batch message fetch failed, falling back to parallel fetches:', e);
      }
      // 旧服务端/异常时退回并行单会话请求，仍比串行快一个数量级
      const entries = await Promise.all(sessionIds.map(async (sid) => {
        try {
          const msgsResp = await fetch(`/api/sessions/${sid}/messages`, { cache: 'no-cache' });
          const msgs = msgsResp.ok ? await msgsResp.json() : [];
          return [sid, Array.isArray(msgs) ? msgs : []];
        } catch (e) {
          console.warn('[Storage] Failed to fetch messages for', sid, e);
          return [sid, []];
        }
      }));
      return Object.fromEntries(entries);
    }

    // 页面加载时从服务端同步数据到 localStorage（合并策略：取消息更多的一方）
    // ===== 消息逐条合并（与服务端 msgs_updater 同口径；唯一定义在 server/context.py） =====
    function _messageKey(msg) {
      const ts = msg && msg.timestamp;
      if (typeof ts === 'number' && ts) return 'ts:' + ts;
      // 整条 JSON 不能当身份：服务端保存时会回填 summary，JSON 一变身份就变
      return 'raw:' + ((msg && msg.role) || '') + '|' + ((msg && msg.content) || '');
    }
    function _mergeMessageFields(base, extra) {
      const merged = { ...base };
      for (const [key, value] of Object.entries(extra || {})) {
        const cur = merged[key];
        const empty = cur === undefined || cur === null || cur === '' ||
          (Array.isArray(cur) && cur.length === 0);
        if (empty && value !== null && value !== '') merged[key] = value;
      }
      return merged;
    }
    function _mergeMessageLists(primary, secondary) {
      const byKey = new Map();
      const order = [];
      for (const msg of [...(primary || []), ...(secondary || [])]) {
        if (!msg || typeof msg !== 'object') continue;
        const key = _messageKey(msg);
        if (!byKey.has(key)) { byKey.set(key, { ...msg }); order.push(key); }
        else byKey.set(key, _mergeMessageFields(byKey.get(key), msg));
      }
      const merged = order.map(k => byKey.get(k));
      if (merged.length && merged.every(m => typeof m.timestamp === 'number' && m.timestamp)) {
        merged.sort((a, b) => a.timestamp - b.timestamp);
      }
      return merged;
    }

    async function _syncFromServer() {
      // T70：不再先 _checkServer() 单独探活（它自己也 GET /api/sessions）再全量拉
      // 一遍——首个请求本身就是探活。启动与 15 秒轮询各少一次重复请求（此前
      // /api/sessions 每轮 ×2）。服务端可用性沿用 _checkServer 的结果缓存字段，
      // 其余调用方（_postToServer 等）行为不变。
      if (typeof window.waitForKnowledgeSave === 'function') {
        await window.waitForKnowledgeSave();
      }
      if (typeof window.waitForFormulaSave === 'function') {
        await window.waitForFormulaSave();
      }
      try {
        const [sessResp, knowResp, currResp] = await Promise.all([
          fetch('/api/sessions', { cache: 'no-cache', signal: AbortSignal.timeout(3000) }),
          fetch('/api/knowledge', { cache: 'no-cache' }),
          fetch('/api/kv/phymathia_current_session', { cache: 'no-cache' }),
        ]);
        _serverAvailable = sessResp.ok;
        _serverAvailableCheckedAt = Date.now();
        if (!_serverAvailable) {
          console.log('[Storage] Server available:', false);
          return false;
        }
        if (sessResp.ok) {
          const serverSessions = await sessResp.json();
          const localSessionsRaw = localStorage.getItem(STORAGE_KEY_SESSIONS);
          const localSessions = localSessionsRaw ? JSON.parse(localSessionsRaw) : {};
          const localSessionIds = Object.keys(localSessions);
          const serverSessionIds = Object.keys(serverSessions);

          // 合并策略：session 取并集，同 ID 以 updatedAt 更新的为准
          const merged = { ...localSessions };
          for (const sid of serverSessionIds) {
            if (!merged[sid]) {
              merged[sid] = serverSessions[sid];
            } else {
              const localTime = merged[sid].updatedAt || 0;
              const serverTime = serverSessions[sid].updatedAt || 0;
              if (serverTime > localTime) merged[sid] = serverSessions[sid];
            }
          }
          localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(merged));

          // 合并消息：一次批量拉取所有服务端会话消息，再按会话逐条合并
          const serverMessages = await _fetchServerMessagesBatch(serverSessionIds);
          const allSessionIds = new Set([...localSessionIds, ...serverSessionIds]);
          for (const sid of allSessionIds) {
            try {
              const localMsgsRaw = localStorage.getItem('phymathia_msgs_' + sid);
              const localMsgs = localMsgsRaw ? JSON.parse(localMsgsRaw) : [];

              if (serverSessionIds.includes(sid)) {
                const serverMsgs = Array.isArray(serverMessages[sid]) ? serverMessages[sid] : [];
                // 逐条合并（按 timestamp 身份）：两边各自独有的消息都保留、
                // 字段互补——不再「条数多者胜」整份丢掉少的一边独有的消息
                const mergedMsgs = _mergeMessageLists(localMsgs, serverMsgs);
                const mergedJson = JSON.stringify(mergedMsgs);
                if (mergedJson !== JSON.stringify(localMsgs)) {
                  safeLocalStorageSet('phymathia_msgs_' + sid, mergedJson);
                }
                // 并集推回服务端，两边收敛一致
                if (mergedJson !== JSON.stringify(serverMsgs)) {
                  try { await _saveMessagesToServer(sid, mergedMsgs); } catch(e) { console.warn('[Storage] Upload failed:', e); }
                }
              }
              // 服务端不存在的 session（本地独有），保留本地数据，同时上传到服务端
              if (!serverSessionIds.includes(sid) && localMsgs.length > 0) {
                console.log(`[Storage] Uploading local-only session ${sid} to server`);
                try {
                  await _postToServer('/api/sessions', localSessions[sid] || { id: sid, title: '未命名画布', sessionId: sid });
                  await _saveMessagesToServer(sid, localMsgs);
                } catch(e) { console.warn('[Storage] Upload local session failed:', e); }
              }
            } catch (e) { console.warn('[Storage] Failed to sync messages for', sid, e); }
          }

          // 清理：本地没有但服务端也没有的（两边都删了的）残留
          for (const sid of localSessionIds) {
            if (!allSessionIds.has(sid) || (!serverSessionIds.includes(sid) && !merged[sid])) {
              localStorage.removeItem('phymathia_msgs_' + sid);
            }
          }

          console.log('[Storage] Merged sessions:', Object.keys(merged).length, '(local:', localSessionIds.length, 'server:', serverSessionIds.length, ')');
        }
        if (knowResp.ok) {
          const kItems = await knowResp.json();
          const localKnowRaw = localStorage.getItem(STORAGE_KEY_KNOWLEDGE);
          const localKnow = localKnowRaw ? JSON.parse(localKnowRaw) : {};
          // 服务端返回 id->item 映射（后端已归一化）；防御性兜底：非对象时视为空
          const serverMap = (kItems && typeof kItems === 'object' && !Array.isArray(kItems)) ? kItems : {};
          // 并集合并：服务端优先、本地独有不丢（避免"取更多一方"覆盖本地独有数据）
          const merged = (typeof dedupeKnowledgeItems === 'function')
            ? dedupeKnowledgeItems({ ...(localKnow || {}), ...serverMap })
            : { ...(localKnow || {}), ...serverMap };
          const serverCount = Object.keys(serverMap).length;
          const localCount = Object.keys(localKnow || {}).length;
          if (serverCount > 0) {
            localStorage.setItem(STORAGE_KEY_KNOWLEDGE, JSON.stringify(merged));
          } else if (localCount > 0) {
            // 本地有数据但服务端为空：上传补全服务端
            try { await _postToServer('/api/knowledge', { items: localKnow }); } catch(e) { console.warn('[Storage] Upload knowledge failed:', e); }
          }
        }
        if (currResp.ok) {
          const cv = await currResp.json();
          // 只有服务端有值时才覆盖本地
          if (cv.value) {
            localStorage.setItem(STORAGE_KEY_CURRENT, cv.value);
          }
        }
        return true;
      } catch (e) {
        console.warn('[Storage] Sync failed:', e);
        return false;
      }
    }

    // 可靠地保存到服务端（返回 Promise，可 await）
    async function _postToServer(url, body) {
      if (!(await _checkServer())) return false;
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          console.error('[Storage] Server save failed:', url, resp.status);
          return false;
        }
        return true;
      } catch (e) {
        console.error('[Storage] Server save error:', url, e);
        return false;
      }
    }

    async function _deleteOnServer(url) {
      if (!(await _checkServer())) return false;
      try {
        // 超时兜底（2026-09-30）：删除链无 signal 时一次挂住的 fetch 会让整条链静默停在半路
        // （服务端已删、本地名单还在）；多选批量删除会把这个问题放大成「整批卡死」。
        const resp = await fetch(url, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
        return resp.ok;
      } catch (e) {
        console.error('[Storage] Server delete error:', url, e);
        return false;
      }
    }

    // 保存会话到服务端（upsert 单个会话，不再用 bulk DELETE+INSERT）
    async function _saveSessionToServer(sid, sessData) {
      return _postToServer('/api/sessions', { ...sessData, id: sid });
    }

    // 保存消息到服务端
    async function _saveMessagesToServer(sessionId, msgs) {
      return _postToServer(`/api/sessions/${sessionId}/messages`, { messages: msgs || [] });
    }

    // 保存知识条目到服务端
    async function _saveKnowledgeToServer(items) {
      return _postToServer('/api/knowledge', { items: items || {} });
    }

    // 保存当前会话 ID 到服务端
    async function _saveCurrentSessionToServer(id) {
      return _postToServer('/api/kv/phymathia_current_session', { value: id });
    }

    // 定期自动同步（每 15 秒）：推送当前消息 + 全量拉取 + 刷新界面
    // （根治跨标签页/服务端变化时"要刷新才出现"的问题）
    setInterval(async () => {
      try {
        // 流式生成期间不推不拉：此时 assistant 消息尚未完整入 history，
        // 推送会把"只有 user 消息"的半截状态写上服务端；拉取刷新则会打断渲染
        if (isStreaming) return;
        if (currentSessionId && chatHistory.length > 0) {
          await _saveMessagesToServer(currentSessionId, chatHistory);
        }
        const synced = await _syncFromServer();
        if (synced) {
          // 服务端有更新则刷新界面
          loadSessions();
          renderSessionList();
          const panel = document.getElementById('knowledgePanel');
          if (panel && panel.classList.contains('active')) {
            if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
            if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
            const activeTab = document.querySelector('.kp-tab.active');
            if (activeTab && activeTab.dataset.tab === 'formulas' && typeof loadFormulas === 'function') {
              loadFormulas();
            }
          }
        }
      } catch (e) {
        console.warn('[Storage] Periodic sync failed:', e);
      }
    }, 15000);

    // 页面关闭前保护
    // 注意：同步 XHR 在 Chrome 88+ 的卸载阶段会被丢弃，改用 sendBeacon
    // （fire-and-forget、不受卸载打断影响）；不可用时退回 fetch keepalive
    window.addEventListener('beforeunload', () => {
      // 画布状态本地写是防抖的（150ms），卸载前同步冲刷——localStorage 同步写在卸载阶段仍有效
      _flushGraphStateLocalSave();
      const beacon = (url, payload) => {
        try {
          const body = JSON.stringify(payload);
          if (navigator.sendBeacon) {
            navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
          } else {
            fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
          }
        } catch (e) { /* best effort */ }
      };
      try {
        if (currentSessionId && chatHistory.length > 0) {
          beacon(`/api/sessions/${currentSessionId}/messages`, { messages: chatHistory });
        }
        // 保存所有会话元数据
        for (const [sid, sdata] of Object.entries(sessions)) {
          beacon('/api/sessions', { ...sdata, id: sid });
        }
        // 保存当前会话 ID
        if (currentSessionId) {
          beacon('/api/kv/phymathia_current_session', { value: currentSessionId });
        }
      } catch (e) { /* best effort */ }
    });

    // 加载所有会话元数据
    function loadSessions() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_SESSIONS);
        if (raw) sessions = JSON.parse(raw);
      } catch(e) { sessions = {}; }
    }
    function saveSessions() {
      safeLocalStorageSet(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
      // 逐个 upsert 到服务端（不阻塞）
      for (const [sid, sdata] of Object.entries(sessions)) {
        _saveSessionToServer(sid, sdata); // fire-and-forget 但用了单个 upsert
      }
    }

    function _saveSessionMeta(sid) {
      const s = sessions[sid];
      if (!s) return;
      s.updatedAt = Date.now();
      safeLocalStorageSet(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
      _saveSessionToServer(sid, s);
    }

    function _maybeAutoTitleSession(sid) {
      const s = sessions[sid];
      if (!s) return;
      if (s.title && !['新对话', '新画布', '未命名对话', '未命名画布'].includes(s.title)) return;
      const firstUser = chatHistory.find(m => m.role === 'user');
      if (firstUser) {
        s.title = firstUser.content.substring(0, 30) + (firstUser.content.length > 30 ? '...' : '');
      }
    }

    // 加载当前会话的消息
    function loadSessionMessages(sessionId) {
      try {
        const raw = localStorage.getItem('phymathia_msgs_' + sessionId);
        if (raw) return JSON.parse(raw);
      } catch(e) {}
      return [];
    }
    async function saveSessionMessages(sessionId, msgs) {
      // 本地快速缓存写失败（配额满）不阻断：下一行的服务端同步照常执行，数据不丢
      safeLocalStorageSet('phymathia_msgs_' + sessionId, JSON.stringify(msgs));
      return _saveMessagesToServer(sessionId, msgs); // 传入消息数据而非从 localStorage 重读
    }

    // ====== 探索网 UI 状态 ======
    // 内存缓存层：拖拽/缩放每帧都会 getGraphState（旧实现每次全量 JSON.parse），
    // saveGraphState 每次交互都 stringify + 同步写 localStorage（滚轮一格一次）。
    // 现在读走缓存（浅拷贝返回，语义与旧实现一致），写只更新缓存并防抖落盘。
    // 直接绕过缓存写这个键的地方（服务端合并、备份导入）必须同步/失效缓存。
    const _graphStateMemCache = new Map(); // sid -> 标准化 state 对象
    let _graphLocalSaveTimer = null;
    let _graphLocalSavePending = null;     // { sid, snap }

    function _normalizeGraphState(parsed) {
      const p = parsed || {};
      return {
        collapsed: p.collapsed || {},
        hidden: p.hidden || {},
        positions: p.positions || {},
        pinned: p.pinned || {},
        sizes: p.sizes || {},
        pan: p.pan || { x: 80, y: 80 },
        zoom: typeof p.zoom === 'number' ? p.zoom : 0.9,
        focus: p.focus || null,
        layoutVersion: p.layoutVersion || 1,
        connections: Object.prototype.hasOwnProperty.call(p, 'connections') ? p.connections : null,
        removedEdges: p.removedEdges || [],
        portCounts: p.portCounts || {},
        inputPortCounts: p.inputPortCounts || {},
        groups: Array.isArray(p.groups) ? p.groups : [],
        customNodes: Array.isArray(p.customNodes) ? p.customNodes : [],
        harnessDeleted: p.harnessDeleted || {},
        harnessNodeOverrides: p.harnessNodeOverrides || {},
        harnessCheckpoint: p.harnessCheckpoint || null,
        updatedAt: p.updatedAt || 0,
      };
    }

    function _invalidateGraphStateCache(sid) {
      if (sid) _graphStateMemCache.delete(sid);
      else _graphStateMemCache.clear();
    }

    // T52：清扫历史坏键——曾有用调用点把对象当 sessionId 拼进键名，留下
    // '…[object Object]' 垃圾键（本地 graph_ 前缀与 kv_store 服务端各有同源一条，
    // 服务端那份已随手清）。启动时全库扫一次，见即删。
    (function _sweepCorruptedKeys() {
      try {
        const bad = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.indexOf('[object Object]') !== -1) bad.push(k);
        }
        for (const k of bad) {
          console.warn('[Storage] 移除坏键（对象误拼进键名）:', k);
          localStorage.removeItem(k);
        }
      } catch (e) { /* 存储不可用：清扫只是兜底，不阻断 */ }
    })();

    // T52：sessionId 被传成对象的调用点守卫——对象拼进键名会产生
    // 'phymathia_graph_[object Object]' 与服务端 'graph:[object Object]' 坏键。
    // 守卫拦下并 warn（开发期控制台可查调用栈），不再写坏键。
    function _isBadGraphSid(sid) {
      if (sid && typeof sid === 'object') {
        console.warn('[GraphState] sessionId 传成了对象（调用点参数错位？）：', sid);
        return true;
      }
      return false;
    }

    function getGraphState(sessionId) {
      const sid = sessionId || currentSessionId || '';
      if (_isBadGraphSid(sid)) return { ..._normalizeGraphState(null) };
      let state = _graphStateMemCache.get(sid);
      if (!state) {
        let parsed = null;
        try {
          const raw = localStorage.getItem('phymathia_graph_' + sid);
          if (raw) parsed = JSON.parse(raw);
        } catch (e) {}
        state = _normalizeGraphState(parsed);
        _graphStateMemCache.set(sid, state);
      }
      return { ...state };
    }

    let _graphStateSyncTimer = null;
    let _graphStatePendingSave = null;

    async function _postGraphState(sid, state) {
      if (_isBadGraphSid(sid)) return;
      try {
        await fetch('/api/kv/' + encodeURIComponent('graph:' + sid), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ value: state }),
        });
      } catch (err) {
        console.warn('[GraphState] Failed to save server state:', err);
      }
    }

    async function _loadGraphStateFromServer(sessionId) {
      const sid = sessionId || currentSessionId || '';
      if (_isBadGraphSid(sid)) return;
      if (!sid) return;
      try {
        const resp = await fetch('/api/kv/' + encodeURIComponent('graph:' + sid));
        if (!resp.ok) return;
        const data = await resp.json();
        const serverState = data.value;
        if (!serverState || typeof serverState !== 'object') return;
        const local = getGraphState(sid);
        const useServer = !local.updatedAt || !serverState.updatedAt || serverState.updatedAt >= local.updatedAt;
        if (useServer) {
          const merged = _normalizeGraphState({ ...local, ...serverState });
          _graphStateMemCache.set(sid, merged);
          safeLocalStorageSet('phymathia_graph_' + sid, JSON.stringify(merged));
        }
      } catch (err) {
        console.warn('[GraphState] Failed to load server state:', err);
      }
    }

    function _scheduleGraphStateServerSave(sid, state) {
      _graphStatePendingSave = { sid, state };
      clearTimeout(_graphStateSyncTimer);
      _graphStateSyncTimer = setTimeout(async () => {
        const pending = _graphStatePendingSave;
        _graphStatePendingSave = null;
        if (pending) await _postGraphState(pending.sid, pending.state);
      }, 400);
    }

    async function _flushGraphStateServerSave() {
      clearTimeout(_graphStateSyncTimer);
      _graphStateSyncTimer = null;
      const pending = _graphStatePendingSave;
      _graphStatePendingSave = null;
      if (pending) await _postGraphState(pending.sid, pending.state);
    }

    // 本地落盘：默认同步写——回归脚本与备份导出会在 save 后立即直接读 localStorage，
    // 这是既有可观察契约。只有高频调用方（滚轮缩放）显式传 deferLocalWrite 走防抖，
    // 防抖中的写可用 flushGraphStateLocalSave 冲刷。
    function _flushGraphStateLocalSave() {
      clearTimeout(_graphLocalSaveTimer);
      _graphLocalSaveTimer = null;
      const pending = _graphLocalSavePending;
      _graphLocalSavePending = null;
      if (!pending) return;
      try {
        localStorage.setItem('phymathia_graph_' + pending.sid, JSON.stringify(pending.snap));
      } catch (e) { /* 配额满等写失败：缓存仍在，下次 save 重试 */ }
    }

    function saveGraphState(sessionId, state, opts) {
      const sid = sessionId || currentSessionId || '';
      if (_isBadGraphSid(sid)) return;
      if (!sid) return;
      const snap = { ...state, updatedAt: Date.now() };
      _graphStateMemCache.set(sid, snap);
      _scheduleGraphStateServerSave(sid, snap);
      if (opts && opts.deferLocalWrite) {
        _graphLocalSavePending = { sid, snap };
        if (!_graphLocalSaveTimer) {
          _graphLocalSaveTimer = setTimeout(_flushGraphStateLocalSave, 150);
        }
        return;
      }
      if (_graphLocalSavePending && _graphLocalSavePending.sid === sid) {
        clearTimeout(_graphLocalSaveTimer);
        _graphLocalSaveTimer = null;
        _graphLocalSavePending = null;
      }
      try {
        localStorage.setItem('phymathia_graph_' + sid, JSON.stringify(snap));
      } catch (e) { /* 本地写失败不阻断：服务端同步照常 */ }
    }

    async function _deleteGraphStateOnServer(sid) {
      if (_isBadGraphSid(sid)) return;
      if (!sid) return;
      if (sid === currentSessionId) clearTimeout(_graphStateSyncTimer);
      _graphStatePendingSave = null;
      // 会话删除/清空：撤销待落盘的本地写，防止防抖定时器把已删除的键写回去
      if (_graphLocalSavePending && _graphLocalSavePending.sid === sid) _graphLocalSavePending = null;
      clearTimeout(_graphLocalSaveTimer);
      _graphLocalSaveTimer = null;
      _graphStateMemCache.delete(sid);
      try {
        await fetch('/api/kv/' + encodeURIComponent('graph:' + sid), { method: 'DELETE' });
      } catch (err) {
        console.warn('[GraphState] Failed to delete server state:', err);
      }
    }

    function setModuleVisibility(messageId, moduleKey, type, visible) {
      if (!messageId || !moduleKey) return;
      const state = getGraphState();
      const bucket = type === 'hidden' ? state.hidden : state.collapsed;
      const key = String(messageId) + ':' + String(moduleKey);
      if (visible) delete bucket[key];
      else bucket[key] = true;
      saveGraphState(currentSessionId, state);
    }

    window.getGraphState = getGraphState;
    window.saveGraphState = saveGraphState;
    window.flushGraphStateServerSave = _flushGraphStateServerSave;
    window.flushGraphStateLocalSave = _flushGraphStateLocalSave;
    window.setModuleVisibility = setModuleVisibility;
    window.getCurrentSessionId = () => currentSessionId;

    // 获取当前会话ID
    function getCurrentSessionId() {
      return localStorage.getItem(STORAGE_KEY_CURRENT);
    }
    function setCurrentSessionId(id) {
      localStorage.setItem(STORAGE_KEY_CURRENT, id);
      currentSessionId = id;
      // Φ 会话与画布解耦（2026-09-30）：切画布不再重置 Φ 对话，只轻量刷新 Φ 侧显示
      // （清旧画布预览/差异高亮、刷新绑定信息与菜单）
      if (typeof window.notifyHarnessCanvasChanged === 'function') window.notifyHarnessCanvasChanged();
      _saveCurrentSessionToServer(id);
    }

    // 创建新会话
    function createNewSession() {
      const id = 'sess_' + crypto.randomUUID().replace(/-/g, '');
      const sessionId = 'phymathia_' + crypto.randomUUID().replace(/-/g, '');
      sessions[id] = {
        id: id,
        title: '新画布',
        sessionId: sessionId,
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
      saveSessions();
      switchToSession(id);
      closeSidebar();
    }

    // 切换到指定会话
    async function switchToSession(id) {
      if (isStreaming) return;
      if (!sessions[id]) return;

      // 保存当前会话的消息
      if (currentSessionId && sessions[currentSessionId]) {
        await saveSessionMessages(currentSessionId, chatHistory);
        sessions[currentSessionId].updatedAt = Date.now();
        _maybeAutoTitleSession(currentSessionId);
        saveSessions();
      }

      // 保存期间可能已开始发送，不能再切换到另一份聊天历史。
      if (isStreaming) return;
      // 队列里的待发送**不再跟着切会话一起丢弃**（2026-09-27 任务列表）：每条队列项
      // 创建时就记下了自己的会话（send-queue.js），轮到它时会把视图带回去再发，
      // 所以切走这件事不再会把它发错画布，也没有理由再把它扔掉。
      // 切换
      setCurrentSessionId(id);
      if (typeof window.resetSocraticBranch === 'function') window.resetSocraticBranch();
      if (typeof window.clearBranchAnchor === 'function') window.clearBranchAnchor();
      chatHistory = loadSessionMessages(id);
      SESSION_ID = sessions[id].sessionId;
      await _loadGraphStateFromServer(id);

      // 重新渲染。renderCurrentChat 内部已触发一次 renderGraphCanvas（聊天容器退役后
      // 它的唯一职责就是这一次画布渲染），这里不再重复调——曾经每次切会话全图
      // insertAdjacentHTML + 整图 KaTeX 跑两遍，实测 18 节点画布白烧 ~30-60ms
      renderCurrentChat();
      renderSessionList();
    }

    // 单个画布的删除内核（单删与多选批量共用同一条路径，清理口径不分叉）：
    // 只清资料不动名单，返回 { ok, offline } —— 名单移除与 UI 刷新交给调用方，
    // 批量删除才能把 saveSessions() 收成一次（逐条调用是 O(n²) 次 upsert 请求）。
    async function _purgeSessionData(id) {
      // 先删服务端、成功后再动本地（09-23 教训：旧顺序先删本地名单再调服务端，
      // 服务端失败时画布已从列表消失、无法重试，15 秒同步还会把会话并集推回服务端）
      const serverOk = await _deleteOnServer('/api/sessions/' + id);
      if (!serverOk && (await _checkServer())) return { ok: false, offline: false };

      // 删除消息
      localStorage.removeItem('phymathia_msgs_' + id);
      localStorage.removeItem('phymathia_graph_' + id);
      await _deleteGraphStateOnServer(id);
      await deleteKnowledgeBySession(id);
      await deleteFormulasBySession(id);
      if (typeof window.deleteQuizStatsBySession === 'function') window.deleteQuizStatsBySession(id);
      if (typeof window.deleteQuizBankBySession === 'function') window.deleteQuizBankBySession(id);
      return { ok: true, offline: !serverOk };
    }

    // 名单已移除之后的收尾：Φ 解绑 + 知识/公式面板刷新
    function _afterSessionRemoval(ids) {
      // Φ 会话解耦（2026-09-30）：删画布不动 Φ 对话，只解绑（对话保留、可换绑）
      for (const id of ids) {
        if (typeof window.phiCanvasDeleted === 'function') window.phiCanvasDeleted(id);
      }
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
      if (typeof loadFormulas === 'function') loadFormulas();
    }

    // 当前画布被删掉后的落点：最近的画布，没有就新建一个
    function _switchAfterCurrentDeleted() {
      const keys = Object.keys(sessions);
      if (keys.length > 0) {
        // 按更新时间排序，切换到最近的
        keys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
        switchToSession(keys[0]);
      } else {
        createNewSession();
      }
    }

    // 删除会话
    async function deleteSession(id, e) {
      if (e) e.stopPropagation();
      // T58：生成中静默 return 观感等同按钮失灵——补提示
      if (isStreaming) {
        if (typeof showToast === 'function') showToast('正在生成回答，稍候再删除画布');
        return;
      }
      if (!confirm('确定删除此画布？')) return;

      const r = await _purgeSessionData(id);
      if (!r.ok) {
        if (typeof showToast === 'function') showToast('服务器删除失败，画布未删除，请稍后重试', TOAST_MS_LONG);
        return;
      }
      if (r.offline && typeof showToast === 'function') {
        showToast('当前离线，仅从本机删除；服务器上的资料可能残留', TOAST_MS_LONG);
      }

      delete sessions[id];
      saveSessions();
      _afterSessionRemoval([id]);
      if (currentSessionId === id) _switchAfterCurrentDeleted();
      renderSessionList();
    }

    // ====== 画布多选（批量删除）======
    // 状态存在模块级：15 秒定时同步会整份重画列表，选中态必须跨重绘存活（按 sid 存，不存 DOM）
    let _sessionMultiSelect = false;
    const _sessionSelected = new Set();
    let _sessionBulkBusy = false;

    function isSessionMultiSelect() { return _sessionMultiSelect; }
    function getSelectedSessionIds() {
      return Array.from(_sessionSelected).filter(id => !!sessions[id]);
    }

    function toggleSessionMultiSelect() {
      _sessionMultiSelect = !_sessionMultiSelect;
      _sessionSelected.clear();
      if (typeof closeIconPicker === 'function') closeIconPicker();
      renderSessionList();
    }

    function exitSessionMultiSelect() {
      if (!_sessionMultiSelect) return;
      _sessionMultiSelect = false;
      _sessionSelected.clear();
      renderSessionList();
    }

    function toggleSessionSelect(id) {
      if (!_sessionMultiSelect) return;
      if (_sessionSelected.has(id)) _sessionSelected.delete(id);
      else _sessionSelected.add(id);
      renderSessionList();
    }

    function selectAllSessions() {
      if (!_sessionMultiSelect) return;
      _sessionSelected.clear();
      for (const id of Object.keys(sessions)) _sessionSelected.add(id);
      renderSessionList();
    }

    function clearSessionSelection() {
      _sessionSelected.clear();
      renderSessionList();
    }

    // 批量删除选中的画布。逐条走 _purgeSessionData 主路径：
    // 名单与面板刷新各只做一次；失败的画布留在选中态里，可直接重试。
    async function deleteSelectedSessions() {
      // T58：生成中要拦且要说（批量删除期间按钮本就隐藏，_sessionBulkBusy 保持静默）
      if (isStreaming) {
        if (typeof showToast === 'function') showToast('正在生成回答，稍候再批量删除画布');
        return;
      }
      if (_sessionBulkBusy) return;
      const ids = getSelectedSessionIds();
      if (ids.length === 0) {
        if (typeof showToast === 'function') showToast('请先勾选要删除的画布', TOAST_MS_LONG);
        return;
      }
      if (!confirm(`确定删除选中的 ${ids.length} 个画布？\n它们的知识、公式与检测记录会一并清除，且不可撤销。`)) return;

      _sessionBulkBusy = true;
      // 当前画布排最后：删它会触发切换，先把其余删完，落点才不像是被删的那一个
      const ordered = ids.filter(id => id !== currentSessionId).concat(ids.filter(id => id === currentSessionId));
      const removed = [];
      const failed = [];
      let offlineAny = false;
      try {
        for (const id of ordered) {
          const r = await _purgeSessionData(id);
          if (!r.ok) { failed.push(id); continue; }
          if (r.offline) offlineAny = true;
          removed.push(id);
          delete sessions[id];
          _sessionSelected.delete(id);
          renderSessionList(); // 逐条出列，大批量时能看到进度而不是干等
        }
      } finally {
        _sessionBulkBusy = false;
      }

      if (removed.length > 0) {
        saveSessions();
        _afterSessionRemoval(removed);
        if (removed.includes(currentSessionId)) _switchAfterCurrentDeleted();
      }

      if (typeof showToast === 'function') {
        if (failed.length === 0) {
          showToast(offlineAny
            ? `已删除 ${removed.length} 个画布（离线：服务器可能残留）`
            : `已删除 ${removed.length} 个画布`, TOAST_MS_LONG);
        } else {
          showToast(`已删除 ${removed.length} 个，${failed.length} 个失败（已保留勾选，可重试）`, TOAST_MS_LONG);
        }
      }
      if (failed.length === 0) _sessionMultiSelect = false;
      renderSessionList();
    }

    // 多选态下 Esc 退出（而不是关侧栏）：多选里点错了先按 Esc 补救最自然。
    // 侧栏没开时不劫持这个键——Esc 在别处还有别的含义。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !_sessionMultiSelect) return;
      const sidebar = document.getElementById('sidebar');
      if (!sidebar || !sidebar.classList.contains('open')) return;
      exitSessionMultiSelect();
    });

    // 渲染当前画布（2026-09-25 线性主聊天退役：chatMessages 气泡容器已随聊天 UI
    // 移除，线性消息恢复分支 restoreMessage 及其渲染缓存一并删除，本函数只剩画布刷新）
    async function renderCurrentChat() {
      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    }

    // 渲染会话图标
    function getSessionIconHtml(icon) {
      const option = (ICON_OPTIONS || []).find(o => o.id === icon);
      return option ? option.svg : escapeHtml(icon);
    }

    // ====== 侧栏列表：日期分组 + 标题搜索（2026-09-30 改版）======
    // 分档顺序＝渲染顺序，列表里从「今天」往「更早」排。
    const SESSION_BUCKETS = ['今天', '昨天', '近 7 天', '本月', '更早'];

    // 归档口径：按本地日历日切，不按滚动 24 小时（今天 0 点到此刻都算今天）。
    // 无效时间戳（旧数据/服务端导入缺字段）一律落「更早」——绝不能因此抛错打断整份列表。
    function sessionDateBucket(ts) {
      const t = Number(ts);
      if (!Number.isFinite(t) || t <= 0) return '更早';
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      if (t >= todayStart) return '今天';
      if (t >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return '昨天';
      if (t >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6).getTime()) return '近 7 天';
      if (t >= new Date(now.getFullYear(), now.getMonth(), 1).getTime()) return '本月';
      return '更早';
    }

    let _sessionQuery = '';

    // 搜索命中高亮：先按原文定位命中区间，再**分段**转义——整体 escapeHtml 之后
    // 再切片会因 &amp; 之类多出字符而下标错位。命中片段本身也要转义，防注入。
    function _highlightSessionTitle(raw, q) {
      if (!q) return escapeHtml(raw);
      const i = String(raw).toLowerCase().indexOf(q);
      if (i < 0) return escapeHtml(raw);
      return escapeHtml(raw.slice(0, i))
        + '<mark class="session-hit">' + escapeHtml(raw.slice(i, i + q.length)) + '</mark>'
        + escapeHtml(raw.slice(i + q.length));
    }

    function onSessionSearchInput(value) {
      _sessionQuery = String(value || '').trim().toLowerCase();
      const clearBtn = document.getElementById('sessionSearchClear');
      if (clearBtn) clearBtn.hidden = !_sessionQuery;
      _clearSessionKbCursor();
      renderSessionList();
    }

    function clearSessionSearch() {
      const input = document.getElementById('sessionSearch');
      if (input) input.value = '';
      onSessionSearchInput('');
      if (input) input.focus();
    }

    // 键盘补全：输入框 ↑↓ 走结果行，Enter 切换，Esc 先清搜索（Esc 退多选的老监听不动，
    // 这里 stopPropagation 避免两件事一起触发）。
    function onSessionSearchKey(e) {
      if (e.key === 'Escape') {
        if (!_sessionQuery) return;
        e.stopPropagation();
        clearSessionSearch();
        return;
      }
      if (e.key === 'ArrowDown') { e.preventDefault(); _moveSessionKbCursor(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); _moveSessionKbCursor(-1); return; }
      if (e.key === 'Enter') {
        const cur = document.querySelector('#sessionList .session-item.kb-cursor');
        if (cur) { e.preventDefault(); cur.click(); }
      }
    }

    function _sessionKbItems() {
      return Array.prototype.slice.call(document.querySelectorAll('#sessionList .session-item'));
    }
    function _clearSessionKbCursor() {
      for (const el of _sessionKbItems()) el.classList.remove('kb-cursor');
    }
    function _moveSessionKbCursor(delta) {
      const items = _sessionKbItems();
      if (items.length === 0) return;
      let idx = -1;
      for (let i = 0; i < items.length; i++) {
        if (items[i].classList.contains('kb-cursor')) { idx = i; break; }
      }
      const next = Math.max(0, Math.min(items.length - 1, idx < 0 ? (delta > 0 ? 0 : items.length - 1) : idx + delta));
      for (let i = 0; i < items.length; i++) items[i].classList.toggle('kb-cursor', i === next);
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: 'nearest' });
    }

    // 多选钮的两态图标（线性描边，与全站图标同一套画法，不写字）
    const MS_ICON_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2"></path><path d="M16 4h2a2 2 0 0 1 2 2v2"></path><path d="M20 16v2a2 2 0 0 1-2 2h-2"></path><path d="M8 20H6a2 2 0 0 1-2-2v-2"></path><path d="M9 12h6"></path></svg>';
    const MS_ICON_ON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>';

    // 重命名进行中标志：置位期间推迟 renderSessionList，
    // 防止 15s 定时同步重建侧栏 DOM 把正在输入的重命名框销毁（输入被打断）
    let _sessionRenameActive = false;

    // 渲染会话列表
    function renderSessionList() {
      const list = document.getElementById('sessionList');
      if (!list) return;
      if (_sessionRenameActive) {
        // 自愈兜底：输入框已不在 DOM 却仍处于改名态（异常路径未触发 blur），解除冻结
        if (!document.querySelector('.session-rename-input')) _sessionRenameActive = false;
        else return; // 改名进行中：推迟重绘，结束后由 doSave/取消 统一刷新
      }
      // 已被别处删掉的画布（清空全部/服务端同步并集变化）不留悬空勾选
      for (const id of Array.from(_sessionSelected)) {
        if (!sessions[id]) _sessionSelected.delete(id);
      }
      const keys = Object.keys(sessions);
      keys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));

      // 搜索：只按标题过滤（内容在浏览器本地存储里，几十个画布全文扫会卡）
      const q = _sessionQuery;
      const shown = q ? keys.filter(id => String(sessions[id].title || '').toLowerCase().includes(q)) : keys;

      const bulkBar = document.getElementById('sessionBulkBar');
      if (bulkBar) {
        bulkBar.hidden = !_sessionMultiSelect;
        const countEl = document.getElementById('sessionBulkCount');
        if (countEl) countEl.textContent = `已选 ${_sessionSelected.size} / ${shown.length}`;
        const delBtn = document.getElementById('sessionBulkDeleteBtn');
        if (delBtn) {
          delBtn.disabled = _sessionSelected.size === 0 || _sessionBulkBusy;
          delBtn.textContent = _sessionBulkBusy ? '正在删除…' : '删除选中';
        }
      }
      const msBtn = document.getElementById('sessionMultiSelectBtn');
      if (msBtn) {
        msBtn.classList.toggle('on', _sessionMultiSelect);
        msBtn.title = _sessionMultiSelect ? '完成选择' : '多选画布：勾选后可一次性删除';
        msBtn.innerHTML = _sessionMultiSelect ? MS_ICON_ON : MS_ICON_OFF;
      }

      if (keys.length === 0) {
        list.innerHTML = '<div class="session-empty">暂无画布</div>';
        return;
      }
      if (shown.length === 0) {
        list.innerHTML = `<div class="session-empty">没有匹配「${escapeHtml(q)}」的画布`
          + '<button class="session-empty-clear" onclick="clearSessionSearch()">清空搜索</button></div>';
        return;
      }

      const multi = _sessionMultiSelect;
      const renderItem = (id) => {
        const s = sessions[id];
        const isActive = id === currentSessionId;
        const time = formatRelativeTime(s.updatedAt || s.createdAt);
        const icon = getSessionIconHtml(s.icon || 'wave');
        const title = q ? _highlightSessionTitle(s.title, q) : escapeHtml(s.title);
        if (multi) {
          // 多选态：整行点击＝切换勾选，行内单画布按钮（改名/删除/换图标）全部收掉，
          // 免得批量操作时误触单条路径
          const picked = _sessionSelected.has(id);
          return `
          <div class="session-item multi-select-item ${picked ? 'picked' : ''} ${isActive ? 'current' : ''}" onclick="toggleSessionSelect('${id}')" title="${picked ? '取消选择' : '选择此画布'}">
            <span class="session-check">${picked ? UI_ICON_SVG.check : ''}</span>
            <span class="session-icon session-icon-static">${icon}</span>
            <div class="session-info">
              <div class="session-title">${title}</div>
              <div class="session-time">${time}</div>
            </div>
          </div>`;
        }
        return `
          <div class="session-item ${isActive ? 'active' : ''}" onclick="switchToSession('${id}'); closeSidebar();">
            <span class="session-icon" onclick="toggleIconPicker(event, '${id}')" title="切换图标">${icon}</span>
            <div class="session-info">
              <div class="session-title">${title}</div>
              <div class="session-time">${time}</div>
            </div>
            <button class="session-rename-btn" onclick="startRenameSession(event, '${id}')" title="重命名">${UI_ICON_SVG.pencil}</button>
            <button class="session-delete" onclick="deleteSession('${id}', event)" title="删除">${UI_ICON_SVG.trash}</button>
          </div>`;
      };

      // 按日期分档渲染：档内保持 updatedAt 降序（上面已排好），档间按 SESSION_BUCKETS 顺序
      const groups = new Map();
      for (const id of shown) {
        const bucket = sessionDateBucket(sessions[id].updatedAt || sessions[id].createdAt);
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket).push(id);
      }
      list.innerHTML = SESSION_BUCKETS.filter(b => groups.has(b)).map(bucket => `
        <div class="session-group">
          <div class="session-group-head"><span class="session-group-title">${bucket}</span><span class="session-group-count">${groups.get(bucket).length}</span></div>
          ${groups.get(bucket).map(renderItem).join('')}
        </div>`).join('');
    }

    // ====== 对话重命名 ======
    function startRenameSession(event, sessionId) {
      event.stopPropagation();
      _sessionRenameActive = true;
      // 从按钮向上找到 session-item，再找到 session-title
      const itemEl = event.currentTarget.closest('.session-item');
      const titleEl = itemEl?.querySelector('.session-title');
      if (!titleEl) return;
      const currentTitle = sessions[sessionId]?.title || '';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentTitle;
      input.className = 'session-rename-input';
      input.onclick = (e) => e.stopPropagation();
      titleEl.innerHTML = '';
      titleEl.appendChild(input);
      input.focus();
      input.select();

      let saved = false;
      let cancelled = false;
      const finishRename = () => { _sessionRenameActive = false; };
      const doSave = () => {
        if (saved || cancelled) return;
        saved = true;
        finishRename();
        const newTitle = input.value.trim() || currentTitle;
        if (sessions[sessionId]) {
          sessions[sessionId].title = newTitle;
          _saveSessionMeta(sessionId);
          // 同步到服务端
          fetch(`/api/sessions/${sessionId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: newTitle })
          }).catch(() => {});
        }
        renderSessionList();
      };

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); doSave(); }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelled = true;
          finishRename();
          renderSessionList();
        }
      });
      input.addEventListener('blur', doSave);
    }

    // ====== 对话图标切换 ======

    let activeIconPicker = null;

    function toggleIconPicker(event, sessionId) {
      event.stopPropagation();
      // 关闭已有面板
      closeIconPicker();
      const iconEl = event.currentTarget;
      const panel = document.createElement('div');
      panel.className = 'icon-picker-panel aurora-glass aurora-glass--dialog';
      // 挂载到 body，避免被 sidebar overflow 裁剪
      document.body.appendChild(panel);
      activeIconPicker = { panel, sessionId, iconEl, page: 0, icons: ICON_OPTIONS };
      renderIconPickerPage();

      // 点击外部关闭
      setTimeout(() => document.addEventListener('click', closeIconPicker), 0);
    }

    function positionIconPicker(panel, iconEl) {
      const rect = iconEl.getBoundingClientRect();
      panel.style.position = 'fixed';
      panel.style.zIndex = '9999';
      // 先设 top 再算 left，确保 offsetWidth 正确
      panel.style.top = rect.bottom + 4 + 'px';
      let left = rect.left + rect.width / 2 - panel.offsetWidth / 2;
      // 边界检查：确保面板不超出屏幕左侧和右侧
      if (left < 8) left = 8;
      if (left + panel.offsetWidth > window.innerWidth - 8) left = window.innerWidth - panel.offsetWidth - 8;
      // 下溢检查：如果面板超出屏幕底部，改为在图标上方显示
      if (rect.bottom + 4 + panel.offsetHeight > window.innerHeight - 8) {
        panel.style.top = rect.top - panel.offsetHeight - 4 + 'px';
      }
      panel.style.left = left + 'px';
    }

    function renderIconPickerPage(reposition = true) {
      if (!activeIconPicker) return;
      const { panel, sessionId, icons, page } = activeIconPicker;
      const totalPages = Math.max(1, Math.ceil(icons.length / ICON_PAGE_SIZE));
      const start = page * ICON_PAGE_SIZE;
      const pageIcons = icons.slice(start, start + ICON_PAGE_SIZE);
      const grid = pageIcons.map(ic => {
        const escapedId = escapeHtml(ic.id);
        const escapedLabel = escapeHtml(ic.label);
        const content = ic.svg || escapeHtml(ic.id);
        return `<span class="icon-picker-item" data-icon="${escapedId}" title="${escapedLabel}" onclick="selectSessionIcon(event, '${sessionId}', '${escapedId}')">${content}</span>`;
      }).join('');
      const nav = `
        <button class="icon-picker-nav" onclick="pageIconPicker(-1, event)" ${page === 0 ? 'disabled' : ''}>‹</button>
        <span class="icon-picker-page">${page + 1}/${totalPages}</span>
        <button class="icon-picker-nav" onclick="pageIconPicker(1, event)" ${page >= totalPages - 1 ? 'disabled' : ''}>›</button>
      `;
      panel.innerHTML = `
        <div class="icon-picker-grid">${grid}</div>
        <div class="icon-picker-footer">${nav}<span class="icon-picker-item icon-picker-reset" title="恢复默认" onclick="selectSessionIcon(event, '${sessionId}', '')">${UI_ICON_SVG.reset}</span></div>
      `;
      if (reposition) positionIconPicker(panel, activeIconPicker.iconEl);
    }

    function pageIconPicker(delta, event) {
      event.stopPropagation();
      if (!activeIconPicker) return;
      const totalPages = Math.max(1, Math.ceil(activeIconPicker.icons.length / ICON_PAGE_SIZE));
      activeIconPicker.page = Math.min(totalPages - 1, Math.max(0, activeIconPicker.page + delta));
      renderIconPickerPage(false);
    }

    function closeIconPicker() {
      if (activeIconPicker) {
        activeIconPicker.panel.remove();
        document.removeEventListener('click', closeIconPicker);
        activeIconPicker = null;
      }
    }

    function selectSessionIcon(event, sessionId, icon) {
      event.stopPropagation();
      if (sessions[sessionId]) {
        sessions[sessionId].icon = icon || undefined;
        _saveSessionMeta(sessionId);
        // 同步到服务端
        fetch(`/api/sessions/${sessionId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ icon: icon || '' })
        }).catch(() => {});
      }
      closeIconPicker();
      renderSessionList();
    }

    // ====== 侧边栏开关 ======
    function toggleSidebar() {
      const sidebar = document.getElementById('sidebar');
      const overlay = document.getElementById('sidebarOverlay');
      const isOpen = sidebar.classList.contains('open');
      if (isOpen) {
        closeSidebar();
      } else {
        renderSessionList();
        sidebar.classList.add('open');
        overlay.classList.add('show');
      }
    }
    function closeSidebar() {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarOverlay').classList.remove('show');
      // 收起时清掉搜索词：下次开侧栏要看到全部画布，否则只剩上次的命中结果，
      // 用户会以为别的画布丢了
      if (_sessionQuery) {
        const input = document.getElementById('sessionSearch');
        if (input) input.value = '';
        onSessionSearchInput('');
      }
    }

    // ====== 初始化会话 ======
    let SESSION_ID = '';

    // 初始化入口 —— 由 ui.js 的 load 事件调用（确保所有模块已加载）
    async function initApp() {
      setInterval(() => {
        if (document.querySelector('.session-item')) renderSessionList();
      }, 60000);

      loadSessions();
      const hasLocalData = Object.keys(sessions).length > 0 || !!getCurrentSessionId();

      if (!hasLocalData) {
        // 首次访问：本地没有任何画布，先等一次服务端同步，避免创建重复会话
        await _syncFromServer();
        loadSessions();
        await initSessionState();
      } else {
        // 本地已有数据：先立即渲染本地会话（首屏不阻塞），再后台同步服务端
        await initSessionState();
        _syncFromServer().then((synced) => {
          if (!synced) return;
          loadSessions();
          renderSessionList();
        }).catch(() => {});
      }
    }

    // 暴露给其他模块（如知识面板打开时即时拉取最新数据）
    window.syncFromServer = async () => {
      const ok = await _syncFromServer();
      loadSessions();
      return ok;
    };
    window.updateChatHistoryMessage = (timestamp, updater) => {
      const idx = chatHistory.findIndex(item => String(item.timestamp) === String(timestamp));
      if (idx < 0) return false;
      const next = updater(chatHistory[idx]);
      if (next !== undefined) chatHistory[idx] = next;
      return true;
    };
    // 暴露给知识面板（公式定位会话）：切换会话 + 查询会话信息
    window.switchToSession = switchToSession;
    window.getSessionById = (id) => sessions[id] || null;
    window.getAllSessions = () => Object.keys(sessions).map(id => ({ ...sessions[id], id }));
    // Φ 面板删除画布也走这里（主路径自带 confirm 与「先服务端后本地」顺序）
    window.deleteSession = deleteSession;
    // Φ 面板一键清空也走这里（主路径自带「不可撤销」confirm 与全量清理）
    window.clearAllSessions = clearAllSessions;
    window.getSessionMessages = (sessionId) => loadSessionMessages(sessionId);
    window.getSessionIdVariants = (sessionId) => {
      const ids = new Set([sessionId]);
      for (const [localId, item] of Object.entries(sessions)) {
        if (!item) continue;
        if (localId === sessionId || item.sessionId === sessionId) {
          ids.add(localId);
          if (item.sessionId) ids.add(item.sessionId);
        }
      }
      const direct = sessions[sessionId];
      if (direct && direct.sessionId) ids.add(direct.sessionId);
      return Array.from(ids);
    };

    async function initSessionState() {
      const savedCurrent = getCurrentSessionId();
      const sessionKeys = Object.keys(sessions);
      console.log('[Init] savedCurrent:', savedCurrent, 'sessions count:', sessionKeys.length);

      if (savedCurrent && sessions[savedCurrent]) {
        currentSessionId = savedCurrent;
        SESSION_ID = sessions[savedCurrent].sessionId;
        chatHistory = loadSessionMessages(savedCurrent);
        console.log('[Init] Restored session', savedCurrent, 'messages:', chatHistory.length);
      } else if (sessionKeys.length > 0) {
        // savedCurrent 丢失但 sessions 存在，切换到最新的
        sessionKeys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
        const latestId = sessionKeys[0];
        currentSessionId = latestId;
        SESSION_ID = sessions[latestId].sessionId;
        chatHistory = loadSessionMessages(latestId);
        setCurrentSessionId(latestId);
        console.log('[Init] Recovered to latest session', latestId, 'messages:', chatHistory.length);
      } else {
        // 首次使用或数据丢失，创建新会话
        console.log('[Init] No sessions found, creating new');
        const id = 'sess_' + crypto.randomUUID().replace(/-/g, '');
        SESSION_ID = 'phymathia_' + crypto.randomUUID().replace(/-/g, '');
        sessions[id] = {
          id: id,
          title: '新画布',
          sessionId: SESSION_ID,
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        saveSessions();
        setCurrentSessionId(id);
        chatHistory = [];
      }

      await _loadGraphStateFromServer(currentSessionId);

      // 渲染
      renderCurrentChat();
      renderSessionList();
      updateDataStats();
    }


    async function saveCurrentSession() {
      if (currentSessionId && sessions[currentSessionId]) {
        await saveSessionMessages(currentSessionId, chatHistory);
        sessions[currentSessionId].updatedAt = Date.now();
        _maybeAutoTitleSession(currentSessionId);
        saveSessions();
      }
    }

    // ====== 会话切换渲染缓存与线性消息恢复 restoreMessage 已随线性主聊天退役
    // （2026-09-25）：chatMessages 容器不存在后 restoreMessage 真机不可达，
    // 其 LRU 缓存（_msgHtmlCache*）仅服务该死分支，一并删除。恢复方式见
    // docs/dev/linear-chat-retired.md。

    async function clearChat() {
      // T58：生成中清空会静默丢掉在途结果，拦下并告知
      if (isStreaming) {
        if (typeof showToast === 'function') showToast('正在生成回答，稍候再清空当前画布');
        return;
      }
      if (!confirm('确定清空当前画布吗？')) return;
      chatHistory = [];
      if (typeof window.resetSocraticBranch === 'function') window.resetSocraticBranch();
      // 清除 localStorage
      localStorage.removeItem('phymathia_msgs_' + currentSessionId);
      localStorage.removeItem('phymathia_graph_' + currentSessionId);
      await _deleteGraphStateOnServer(currentSessionId);
      // 直接调用 DELETE 清除服务端消息
      try {
        await fetch(`/api/sessions/${currentSessionId}/messages`, { method: 'DELETE' });
      } catch(e) { console.warn('[Clear] Failed to delete messages from server:', e); }
      await deleteKnowledgeBySession(currentSessionId);
      await deleteFormulasBySession(currentSessionId);
      if (typeof window.deleteQuizStatsBySession === 'function') window.deleteQuizStatsBySession(currentSessionId);
      if (typeof window.deleteQuizBankBySession === 'function') window.deleteQuizBankBySession(currentSessionId);
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
      if (typeof loadFormulas === 'function') loadFormulas();
      if (sessions[currentSessionId]) {
        sessions[currentSessionId].title = '新对话';
        sessions[currentSessionId].updatedAt = Date.now();
        saveSessions();
      }
      renderCurrentChat();
    }

    async function clearAllSessions() {
      // T58：同 clearChat——生成中清空全部必须可见地拦住
      if (isStreaming) {
        if (typeof showToast === 'function') showToast('正在生成回答，稍候再清空所有画布');
        return;
      }
      if (!confirm('确定清空所有画布吗？此操作不可撤销！')) return;

      // 1. 批量删除服务端所有会话、消息和知识条目
      await _deleteOnServer('/api/sessions');

      // 2. 清空内存
      sessions = {};
      if (typeof window.resetSocraticBranch === 'function') window.resetSocraticBranch();
      chatHistory = [];

      // 3. 清空 localStorage 中所有 phymathia 相关数据
      // 键清单与 memory.js memoryConfirmClear 对齐：题库 phymathia_quiz_bank 与
      // 检测素材源偏好 phymathia_quiz_source 此前漏清，清空后仍残留在全局题库
      // 注意：Φ 会话键（phi_sessions / current_phi_session / harness_history_phi_*）
      // 刻意不在清单里——清画布不动 Φ 对话（2026-09-30 解耦），只解绑
      const keys = Object.keys(localStorage).filter(k =>
        k.startsWith('phymathia_session_') ||
        k.startsWith('phymathia_msgs_') ||
        k.startsWith('phymathia_graph_') ||
        k === STORAGE_KEY_SESSIONS ||
        k === STORAGE_KEY_CURRENT ||
        k === STORAGE_KEY_KNOWLEDGE ||
        k === 'phymathia_formulas' ||
        k === 'phymathia_quiz_stats' ||
        k === 'phymathia_quiz_bank' ||
        k === 'phymathia_quiz_source'
      );
      keys.forEach(k => localStorage.removeItem(k));
      // 图状态缓存与待落盘写一并清掉，防止防抖定时器把已删除的键写回去
      _graphLocalSavePending = null;
      clearTimeout(_graphLocalSaveTimer);
      _graphLocalSaveTimer = null;
      _invalidateGraphStateCache();
      if (typeof setFormulaCache === 'function') setFormulaCache({});
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof window.clearAllQuizStats === 'function') window.clearAllQuizStats();
      try { fetch('/api/kv/phymathia_quiz_bank', { method: 'DELETE' }).catch(() => {}); } catch (e) {}

      // 4. 创建新会话并刷新 UI
      if (typeof window.phiCanvasesCleared === 'function') window.phiCanvasesCleared();
      createNewSession();
      renderSessionList();
    }
