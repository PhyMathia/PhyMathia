    // ====== 多会话管理 ======
    let sessions = {};
    let currentSessionId = null;
    let isStreaming = false;
    let chatHistory = [];
    let lastFailedMessage = '';
    let abortController = null;

    // ====== 服务端持久化存储层 ======
    let _serverAvailable = null;
    let _pendingSaves = []; // 跟踪未完成的服务端保存

    async function _checkServer() {
      if (_serverAvailable !== null) return _serverAvailable;
      try {
        const resp = await fetch('/api/sessions', { cache: 'no-cache', signal: AbortSignal.timeout(3000) });
        _serverAvailable = resp.ok;
      } catch {
        _serverAvailable = false;
      }
      console.log('[Storage] Server available:', _serverAvailable);
      return _serverAvailable;
    }

    // 页面加载时从服务端同步数据到 localStorage（合并策略：取消息更多的一方）
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

          // 合并消息：对每个 session，取消息更多的那一方
          const allSessionIds = new Set([...localSessionIds, ...serverSessionIds]);
          for (const sid of allSessionIds) {
            try {
              const localMsgsRaw = localStorage.getItem('phymathia_msgs_' + sid);
              const localMsgs = localMsgsRaw ? JSON.parse(localMsgsRaw) : [];

              if (serverSessionIds.includes(sid)) {
                // 服务端有这个 session，尝试获取服务端消息
                const msgsResp = await fetch(`/api/sessions/${sid}/messages`, { cache: 'no-cache' });
                if (msgsResp.ok) {
                  const serverMsgs = await msgsResp.json();
                  // 取消息更多的那一方
                  if (serverMsgs.length >= localMsgs.length) {
                    localStorage.setItem('phymathia_msgs_' + sid, JSON.stringify(serverMsgs));
                  }
                  // 否则保留本地更多的消息，但把多出的消息补录到服务端
                  if (localMsgs.length > serverMsgs.length) {
                    console.log(`[Storage] Local has more messages for ${sid}: ${localMsgs.length} vs server ${serverMsgs.length}, uploading`);
                    try { await _saveMessagesToServer(sid, localMsgs); } catch(e) { console.warn('[Storage] Upload failed:', e); }
                  }
                }
              }
              // 服务端不存在的 session（本地独有），保留本地数据，同时上传到服务端
              if (!serverSessionIds.includes(sid) && localMsgs.length > 0) {
                console.log(`[Storage] Uploading local-only session ${sid} to server`);
                try {
                  await _postToServer('/api/sessions', localSessions[sid] || { id: sid, title: '未命名对话', sessionId: sid });
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
    window.addEventListener('beforeunload', () => {
      // beforeunload 中不能用 async/await，用 sync XHR 尝试保存
      try {
        if (currentSessionId && chatHistory.length > 0) {
          const data = JSON.stringify({ messages: chatHistory });
          const xhr = new XMLHttpRequest();
          xhr.open('POST', `/api/sessions/${currentSessionId}/messages`, false); // sync
          xhr.setRequestHeader('Content-Type', 'application/json');
          xhr.send(data);
        }
        // 保存所有会话元数据
        for (const [sid, sdata] of Object.entries(sessions)) {
          const xhr2 = new XMLHttpRequest();
          xhr2.open('POST', '/api/sessions', false);
          xhr2.setRequestHeader('Content-Type', 'application/json');
          xhr2.send(JSON.stringify({ ...sdata, id: sid }));
        }
        // 保存当前会话 ID
        if (currentSessionId) {
          const xhr3 = new XMLHttpRequest();
          xhr3.open('POST', '/api/kv/phymathia_current_session', false);
          xhr3.setRequestHeader('Content-Type', 'application/json');
          xhr3.send(JSON.stringify({ value: currentSessionId }));
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
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
      // 逐个 upsert 到服务端（不阻塞）
      for (const [sid, sdata] of Object.entries(sessions)) {
        _saveSessionToServer(sid, sdata); // fire-and-forget 但用了单个 upsert
      }
    }

    function _saveSessionMeta(sid) {
      const s = sessions[sid];
      if (!s) return;
      s.updatedAt = Date.now();
      localStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(sessions));
      _saveSessionToServer(sid, s);
    }

    function _maybeAutoTitleSession(sid) {
      const s = sessions[sid];
      if (!s) return;
      if (s.title && s.title !== '新对话' && s.title !== '未命名对话') return;
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
      localStorage.setItem('phymathia_msgs_' + sessionId, JSON.stringify(msgs));
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
            linear: !!parsed.linear,
            layoutVersion: parsed.layoutVersion || 1,
            connections: Object.prototype.hasOwnProperty.call(parsed, 'connections') ? parsed.connections : null,
            removedEdges: parsed.removedEdges || [],
            portCounts: parsed.portCounts || {},
            inputPortCounts: parsed.inputPortCounts || {},
            groups: Array.isArray(parsed.groups) ? parsed.groups : [],
            customNodes: Array.isArray(parsed.customNodes) ? parsed.customNodes : [],
            harnessDeleted: parsed.harnessDeleted || {},
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
        linear: false,
        layoutVersion: 1,
        connections: null,
        removedEdges: [],
        portCounts: {},
        inputPortCounts: {},
        groups: [],
        customNodes: [],
        harnessDeleted: {},
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
          localStorage.setItem('phymathia_graph_' + sid, JSON.stringify({ ...local, ...serverState }));
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
      localStorage.setItem('phymathia_graph_' + sid, JSON.stringify(snap));
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
      if (document.querySelector('.app-container')?.classList.contains('linear-mode') && typeof window.refreshMessageBubbles === 'function') {
        window.refreshMessageBubbles();
      }
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
      _saveCurrentSessionToServer(id);
    }

    // 创建新会话
    function createNewSession() {
      const id = 'sess_' + crypto.randomUUID().replace(/-/g, '');
      const sessionId = 'phymathia_' + crypto.randomUUID().replace(/-/g, '');
      sessions[id] = {
        id: id,
        title: '新对话',
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
      if (!confirm('确定删除此对话？')) return;

      // 删除消息
      localStorage.removeItem('phymathia_msgs_' + id);
      localStorage.removeItem('phymathia_graph_' + id);
      await _deleteGraphStateOnServer(id);
      await deleteKnowledgeBySession(id);
      await deleteFormulasBySession(id);
      if (typeof window.deleteQuizStatsBySession === 'function') window.deleteQuizStatsBySession(id);
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

    // 渲染会话列表
    function renderSessionList() {
      const list = document.getElementById('sessionList');
      if (!list) return;
      const keys = Object.keys(sessions);
      keys.sort((a, b) => (sessions[b].updatedAt || 0) - (sessions[a].updatedAt || 0));

      if (keys.length === 0) {
        list.innerHTML = '<div style="font-size:11px;color:var(--text-secondary);opacity:0.5;text-align:center;padding:8px;">暂无对话</div>';
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
      const doSave = () => {
        if (saved || cancelled) return;
        saved = true;
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
      panel.className = 'icon-picker-panel';
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

    // HTML 转义
    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    // 相对时间
    function formatRelativeTime(ts) {
      const diff = Date.now() - ts;
      const min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return min + '分钟前';
      const hr = Math.floor(min / 60);
      if (hr < 24) return hr + '小时前';
      const day = Math.floor(hr / 24);
      if (day < 7) return day + '天前';
      return formatTime(ts);
    }

    // ====== 初始化会话 ======
    let SESSION_ID = '';

    // 初始化入口 —— 由 ui.js 的 load 事件调用（确保所有模块已加载）
    async function initApp() {
      initSmartScroll();
      setInterval(() => {
        if (document.querySelector('.session-item')) renderSessionList();
      }, 60000);
      await _syncFromServer();
      loadSessions();
      await initSessionState();
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
          title: '新对话',
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
        const sections = parseXmlSections(content);
        if (Object.keys(sections).length > 0) {
          renderModuleSections(contentDiv, sections, content);
        } else {
          contentDiv.innerHTML = renderMarkdown(content);
          _initVizIframes(contentDiv);
          renderMath(contentDiv);
          wrapDualDomainSections(contentDiv);
          renderMath(contentDiv);
        }
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
        bookmarkBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>';
        bookmarkBtn.onclick = function() { openBookmarkModal(this); };
        body.appendChild(bookmarkBtn);

        // 重新生成按钮
        const regenBtn = document.createElement('button');
        regenBtn.className = 'regenerate-btn';
        regenBtn.title = '重新生成';
        regenBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><polyline points="23 20 23 14 17 14"></polyline><path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"></path></svg> 重新生成';
        regenBtn.onclick = function() { regenerateResponse(this); };
        body.appendChild(regenBtn);
      }

      msg.appendChild(avatar);
      msg.appendChild(body);
      messages.appendChild(msg);
    }

    async function clearChat() {
      if (isStreaming) return;
      if (!confirm('确定清空当前对话记录吗？')) return;
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
      if (!confirm('确定清空所有会话吗？此操作不可撤销！')) return;

      // 1. 批量删除服务端所有会话、消息和知识条目
      await _deleteOnServer('/api/sessions');

      // 2. 清空内存
      sessions = {};
      if (typeof window.resetSocraticBranch === 'function') window.resetSocraticBranch();
      chatHistory = [];

      // 3. 清空 localStorage 中所有 phymathia 相关数据
      const keys = Object.keys(localStorage).filter(k =>
        k.startsWith('phymathia_session_') ||
        k.startsWith('phymathia_msgs_') ||
        k.startsWith('phymathia_graph_') ||
        k === STORAGE_KEY_SESSIONS ||
        k === STORAGE_KEY_CURRENT ||
        k === STORAGE_KEY_KNOWLEDGE ||
        k === 'phymathia_formulas' ||
        k === 'phymathia_quiz_stats'
      );
      keys.forEach(k => localStorage.removeItem(k));
      if (typeof setFormulaCache === 'function') setFormulaCache({});
      if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
      if (typeof window.clearAllQuizStats === 'function') window.clearAllQuizStats();

      // 4. 创建新会话并刷新 UI
      createNewSession();
      renderSessionList();
    }
