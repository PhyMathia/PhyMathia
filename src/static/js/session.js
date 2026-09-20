    // ====== 多会话管理 ======
    let sessions = {};
    let currentSessionId = null;
    let isStreaming = false;
    let chatHistory = [];
    let lastFailedMessage = '';
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
      if (!(await _checkServer())) return false;
      if (typeof window.waitForKnowledgeSave === 'function') {
        await window.waitForKnowledgeSave();
      }
      if (typeof window.waitForFormulaSave === 'function') {
        await window.waitForFormulaSave();
      }
      try {
        const [sessResp, knowResp, currResp] = await Promise.all([
          fetch('/api/sessions', { cache: 'no-cache' }),
          fetch('/api/knowledge', { cache: 'no-cache' }),
          fetch('/api/kv/phymathia_current_session', { cache: 'no-cache' }),
        ]);
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
        const resp = await fetch(url, { method: 'DELETE' });
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

    // 页面关闭前刷新所有数据到服务端
    async function _flushToServer() {
      try {
        // 保存当前会话消息
        if (currentSessionId && chatHistory.length > 0) {
          await _saveMessagesToServer(currentSessionId, chatHistory);
        }
        // 保存会话元数据（逐个 upsert）
        for (const [sid, sdata] of Object.entries(sessions)) {
          await _saveSessionToServer(sid, sdata);
        }
        // 保存当前会话 ID
        if (currentSessionId) {
          await _saveCurrentSessionToServer(currentSessionId);
        }
      } catch (e) {
        console.error('[Storage] Flush error:', e);
      }
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
    function getGraphState(sessionId) {
      const sid = sessionId || currentSessionId || '';
      try {
        const raw = localStorage.getItem('phymathia_graph_' + sid);
        if (raw) {
          const parsed = JSON.parse(raw);
          return {
            collapsed: parsed.collapsed || {},
            hidden: parsed.hidden || {},
            positions: parsed.positions || {},
            pinned: parsed.pinned || {},
            sizes: parsed.sizes || {},
            pan: parsed.pan || { x: 80, y: 80 },
            zoom: typeof parsed.zoom === 'number' ? parsed.zoom : 0.9,
            focus: parsed.focus || null,
            layoutVersion: parsed.layoutVersion || 1,
            connections: Object.prototype.hasOwnProperty.call(parsed, 'connections') ? parsed.connections : null,
            removedEdges: parsed.removedEdges || [],
            portCounts: parsed.portCounts || {},
            inputPortCounts: parsed.inputPortCounts || {},
            groups: Array.isArray(parsed.groups) ? parsed.groups : [],
            customNodes: Array.isArray(parsed.customNodes) ? parsed.customNodes : [],
            harnessDeleted: parsed.harnessDeleted || {},
            harnessNodeOverrides: parsed.harnessNodeOverrides || {},
            harnessCheckpoint: parsed.harnessCheckpoint || null,
            updatedAt: parsed.updatedAt || 0,
          };
        }
      } catch (e) {}
      return {
        collapsed: {},
        hidden: {},
        positions: {},
        pinned: {},
        sizes: {},
        pan: { x: 80, y: 80 },
        zoom: 0.9,
        focus: null,
        layoutVersion: 1,
        connections: null,
        removedEdges: [],
        portCounts: {},
        inputPortCounts: {},
        groups: [],
        customNodes: [],
        harnessDeleted: {},
        harnessNodeOverrides: {},
        harnessCheckpoint: null,
        updatedAt: 0,
      };
    }

    let _graphStateSyncTimer = null;
    let _graphStatePendingSave = null;

    async function _postGraphState(sid, state) {
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
          safeLocalStorageSet('phymathia_graph_' + sid, JSON.stringify({ ...local, ...serverState }));
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

    function saveGraphState(sessionId, state) {
      const sid = sessionId || currentSessionId || '';
      if (!sid) return;
      const snap = { ...state, updatedAt: Date.now() };
      safeLocalStorageSet('phymathia_graph_' + sid, JSON.stringify(snap));
      _scheduleGraphStateServerSave(sid, snap);
    }

    async function _deleteGraphStateOnServer(sid) {
      if (!sid) return;
      if (sid === currentSessionId) clearTimeout(_graphStateSyncTimer);
      _graphStatePendingSave = null;
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
    window.setModuleVisibility = setModuleVisibility;
    window.getCurrentSessionId = () => currentSessionId;

    // 获取当前会话ID
    function getCurrentSessionId() {
      return localStorage.getItem(STORAGE_KEY_CURRENT);
    }
    function setCurrentSessionId(id) {
      localStorage.setItem(STORAGE_KEY_CURRENT, id);
      currentSessionId = id;
      if (typeof window.resetHarnessSession === 'function') window.resetHarnessSession();
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
      // 切换
      setCurrentSessionId(id);
      if (typeof window.resetSocraticBranch === 'function') window.resetSocraticBranch();
      if (typeof window.clearBranchAnchor === 'function') window.clearBranchAnchor();
      chatHistory = loadSessionMessages(id);
      SESSION_ID = sessions[id].sessionId;
      await _loadGraphStateFromServer(id);

      // 重新渲染
      renderCurrentChat();
      renderSessionList();
      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    }

    // 删除会话
    async function deleteSession(id, e) {
      if (e) e.stopPropagation();
      if (isStreaming) return;
      if (!confirm('确定删除此画布？')) return;

      // 删除消息
      localStorage.removeItem('phymathia_msgs_' + id);
      localStorage.removeItem('phymathia_graph_' + id);
      await _deleteGraphStateOnServer(id);
      await deleteKnowledgeBySession(id);
      await deleteFormulasBySession(id);
      if (typeof window.deleteQuizStatsBySession === 'function') window.deleteQuizStatsBySession(id);
      if (typeof window.deleteQuizBankBySession === 'function') window.deleteQuizBankBySession(id);
      delete sessions[id];
      saveSessions();
      await _deleteOnServer('/api/sessions/' + id);
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
      if (typeof loadFormulas === 'function') loadFormulas();

      if (currentSessionId === id) {
        // 删除的是当前会话，切换到最近的或新建
        const keys = Object.keys(sessions);
        if (keys.length > 0) {
          // 按更新时间排序，切换到最近的
          keys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));
          switchToSession(keys[0]);
        } else {
          createNewSession();
        }
      }
      renderSessionList();
    }

    // 渲染当前聊天
    async function renderCurrentChat() {
      const container = document.getElementById('chatMessages');
      if (!container) {
        if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
        return;
      }
      container.innerHTML = '';

      if (chatHistory.length === 0) {
        container.innerHTML += `
          <div class="welcome-tip" id="welcomeTip">
            <h2>欢迎来到 PhyMathia</h2>
            <p>我是你的物理数学双域解释与可视化助手。<br>我会同时用物理直觉和数学本质来解释，并生成交互式可视化让你亲手探索。</p>
            <div class="quick-actions">
              <button class="quick-btn" onclick="sendQuick('请解释简谐运动的物理和数学本质，并生成交互式可视化')">简谐运动</button>
              <button class="quick-btn" onclick="sendQuick('请解释抛体运动的物理和数学本质，并生成交互式可视化')">抛体运动</button>
              <button class="quick-btn" onclick="sendQuick('请用物理直觉和数学推导解释傅里叶变换的本质')">傅里叶变换</button>
              <button class="quick-btn" onclick="sendQuick('请解释热力学第二定律的物理意义和数学表述')">热力学第二定律</button>
            </div>
            <div style="margin-top:20px;font-size:11px;color:var(--tip-color);display:flex;align-items:center;justify-content:center;gap:20px;">
              ${UI_ICON_SVG.monitor} 推荐使用电脑端访问，获得最佳交互体验
            </div>
          </div>`;
      } else {
        for (const msg of chatHistory) {
          restoreMessage(msg.role, msg.content, msg.timestamp, msg.duration, msg.aborted, msg);
        }
        // 渲染 Mermaid（串行执行避免并发冲突）
        setTimeout(async () => {
          const contents = document.querySelectorAll('.message.assistant .message-content');
          for (const el of contents) {
            await renderMermaidInElement(el);
          }
        }, 200);
      }
      scrollToBottom();
      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
    }

    // 渲染会话图标
    function getSessionIconHtml(icon) {
      const option = (ICON_OPTIONS || []).find(o => o.id === icon);
      return option ? option.svg : escapeHtml(icon);
    }

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
      const keys = Object.keys(sessions);
      keys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));

      if (keys.length === 0) {
        list.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);opacity:0.5;text-align:center;padding:8px;">暂无画布</div>';
        return;
      }

      list.innerHTML = keys.map(id => {
        const s = sessions[id];
        const isActive = id === currentSessionId;
        const time = formatRelativeTime(s.updatedAt || s.createdAt);
        const icon = getSessionIconHtml(s.icon || 'wave');
        return `
          <div class="session-item ${isActive ? 'active' : ''}" onclick="switchToSession('${id}'); closeSidebar();">
            <span class="session-icon" onclick="toggleIconPicker(event, '${id}')" title="切换图标">${icon}</span>
            <div class="session-info">
              <div class="session-title">${escapeHtml(s.title)}</div>
              <div class="session-time">${time}</div>
            </div>
            <button class="session-rename-btn" onclick="startRenameSession(event, '${id}')" title="重命名">${UI_ICON_SVG.pencil}</button>
            <button class="session-delete" onclick="deleteSession('${id}', event)" title="删除">${UI_ICON_SVG.trash}</button>
          </div>`;
      }).join('');
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
    }

    // ====== 初始化会话 ======
    let SESSION_ID = '';

    // 初始化入口 —— 由 ui.js 的 load 事件调用（确保所有模块已加载）
    async function initApp() {
      initSmartScroll();
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

    function restoreMessage(role, content, timestamp, duration, aborted, branchMeta) {
      const messages = document.getElementById('chatMessages');
      if (!messages) return;
      const msg = document.createElement('div');
      msg.className = 'message ' + role;

      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      avatar.textContent = role === 'user' ? '👤' : ''; if (role === 'assistant') { avatar.innerHTML = '<img src="/logo.png" alt="PhyMathia">'; }

      const body = document.createElement('div');
      body.className = 'message-body';
      if (timestamp) body.dataset.messageId = String(timestamp);

      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      if (role === 'user') {
        contentDiv.textContent = content;
      } else if (content) {
        contentDiv.innerHTML = renderMarkdown(content, { parentId: String(timestamp || ''), socraticFallback: true });
        _initVizIframes(contentDiv);
        renderMath(contentDiv);
      }
      const branchMetaObj = branchMeta || {};
      if (branchMetaObj.branchLabel) {
        const branchTag = document.createElement('div');
        branchTag.className = 'branch-tag ' + (branchMetaObj.branchType || 'branch');
        branchTag.textContent = branchMetaObj.branchLabel;
        contentDiv.prepend(branchTag);
      }

      body.appendChild(contentDiv);

      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.style.color = '#909090';
      meta.innerHTML = `<span>${formatTime(timestamp || Date.now())}</span>${duration ? '<span class="msg-duration">⏱ ' + formatDuration(duration) + '</span>' : ''}${aborted ? '<span class="msg-aborted">已中止</span>' : ''}`;
      body.appendChild(meta);

      // Add bookmark button for assistant messages
      if (role === 'assistant') {
        const msgId = String(timestamp || Date.now());
        body.dataset.messageId = msgId;
        const bookmarkBtn = document.createElement('button');
        bookmarkBtn.className = 'bookmark-btn';
        bookmarkBtn.title = '收藏到知识总览';
        bookmarkBtn.dataset.bookmarkMsg = msgId;
        bookmarkBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
        bookmarkBtn.onclick = function() { openBookmarkModal(this); };
        body.appendChild(bookmarkBtn);

        // 重新生成按钮
        const regenBtn = document.createElement('button');
        regenBtn.className = 'regenerate-btn';
        regenBtn.title = '重新生成';
        regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg> 重新生成';
        regenBtn.onclick = function() { regenerateResponse(this); };
        body.appendChild(regenBtn);
      }

      msg.appendChild(avatar);
      msg.appendChild(body);
      messages.appendChild(msg);
    }

    async function clearChat() {
      if (isStreaming) return;
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
      if (isStreaming) return;
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
      if (typeof setFormulaCache === 'function') setFormulaCache({});
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof window.clearAllQuizStats === 'function') window.clearAllQuizStats();
      try { fetch('/api/kv/phymathia_quiz_bank', { method: 'DELETE' }).catch(() => {}); } catch (e) {}

      // 4. 创建新会话并刷新 UI
      createNewSession();
      renderSessionList();
    }
