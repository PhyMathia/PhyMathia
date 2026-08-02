    // ====== 进度指示器 ======
    let progressTimer = null;
    let waitingTipTimer = null;
    let progressStartTime = 0;
    let lastChunkTime = 0;
    let currentStage = '';

    function showProgress(stage) {
      currentStage = stage;
      const bar = document.getElementById('progressBar');
      const statusEl = document.getElementById('progressStatus');
      if (bar) bar.classList.add('active');
      if (statusEl) { statusEl.classList.add('active'); updateProgressText(stage); }
      if (!progressTimer) {
        progressStartTime = Date.now();
        lastChunkTime = Date.now();
        progressTimer = setInterval(() => {
          updateElapsedTime();
          if (Date.now() - lastChunkTime > 5000 && currentStage !== 'waiting') {
            updateProgressText('waiting');
            currentStage = 'waiting';
            waitingTipTimer = setInterval(() => updateProgressText('waiting'), 8000);
          }
        }, 500);
      }
    }
    function updateProgressText(stage) {
      const textEl = document.querySelector('#progressStatus .status-text');
      if (!textEl) return;
      const msgs = { 'thinking':'PhyMathia 正在深度思考，可能需要一点时间...', 'tool':'正在调用工具进行计算和可视化生成，请耐心等待...', 'generating':'正在精心组织回复...', 'waiting':'', 'done':'回复完成' };
      if (stage === 'waiting') {
        waitingTipIndex = (waitingTipIndex + 1) % waitingTips.length;
        textEl.textContent = waitingTips[waitingTipIndex];
      } else {
        textEl.textContent = msgs[stage] || msgs['thinking'];
      }
    }
    var waitingTipIndex = -1;
    function updateElapsedTime() {
      const timeEl = document.querySelector('#progressStatus .elapsed-time');
      if (!timeEl) return;
      const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      timeEl.textContent = min > 0 ? `${min}m${sec.toString().padStart(2,'0')}s` : `${sec}s`;
    }
    function hideProgress() {
      const bar = document.getElementById('progressBar');
      const statusEl = document.getElementById('progressStatus');
      if (bar) bar.classList.remove('active');
      if (statusEl && statusEl.classList.contains('active')) {
        updateProgressText('done');
        setTimeout(() => { statusEl.classList.remove('active'); }, 1500);
      }
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      if (waitingTipTimer) { clearInterval(waitingTipTimer); waitingTipTimer = null; }
    }

    function handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    }
    function autoResize(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
    document.getElementById('userInput').addEventListener('input', function() { autoResize(this); });

    function formatTime(ts) {
      const d = new Date(ts);
      return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
    }

    function formatDuration(ms) {
      const sec = Math.floor(ms / 1000);
      if (sec < 60) return sec + 's';
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      return min + 'm' + (remSec < 10 ? '0' : '') + remSec + 's';
    }

    // ===== Regenerate Response =====
    function regenerateResponse(btnEl) {
      if (isStreaming) { alert('正在生成回复，请稍候'); return; }
      const bodyEl = btnEl.closest('.message-body');
      const messageEl = bodyEl?.closest('.message');
      if (!messageEl) return;

      // Find the index of this assistant message in the DOM
      const allMsgEls = Array.from(document.querySelectorAll('#chatMessages .message'));
      const domIndex = allMsgEls.indexOf(messageEl);
      if (domIndex === -1) return;

      // Map DOM index to chatHistory index (they should be 1:1)
      // chatHistory and DOM messages should have the same order
      if (domIndex >= chatHistory.length) {
        alert('消息索引不匹配，请刷新页面');
        return;
      }

      const targetEntry = chatHistory[domIndex];
      if (targetEntry.role !== 'assistant') {
        alert('无法重新生成该消息');
        return;
      }

      // Find the user message immediately before this assistant message
      let userMsg = '';
      let userMsgIndex = -1;
      for (let i = domIndex - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'user') {
          userMsg = chatHistory[i].content;
          userMsgIndex = i;
          break;
        }
      }

      if (!userMsg) {
        alert('未找到对应的问题，请手动输入后重新发送');
        return;
      }

      // Remove this assistant message and all after it from chatHistory
      chatHistory = chatHistory.slice(0, domIndex);
      saveSessionMessages(currentSessionId, chatHistory);

      // Remove the DOM element and all after it
      let el = messageEl;
      while (el) {
        const next = el.nextElementSibling;
        el.remove();
        el = next;
      }

      // Re-send the user message
      document.getElementById('userInput').value = userMsg;
      sendMessage();
    }

    // ===== Auto Extract after AI response =====
    function extractLocalFormulas(content) {
      const formulas = [];
      const addFormula = (expr) => {
        const normalized = _normalizeFormulaLatex(expr);
        const latex = _stripFormulaDelimiters(normalized);
        if (latex && _looksLikeFormula(latex) && !formulas.includes(normalized)) {
          formulas.push(normalized);
        }
      };

      const tagged = content.match(/<formula>[\s\S]*?<\/formula>/gi) || [];
      for (const match of tagged) addFormula(match.replace(/<\/?formula>/gi, ''));
      if (formulas.length === 0) {
        const fallback = /\$\$([^$\n]+)\$\$|\\\((.+?)\\\)|\\\[(.+?)\\\]|\$([^$\n]+)\$/g;
        let match;
        while ((match = fallback.exec(content)) && formulas.length < 8) {
          addFormula(match.slice(1).find(Boolean) || '');
        }
      }
      return formulas.slice(0, 8);
    }

    function extractLocalKnowledge(messages) {
      const assistant = [...messages].reverse().find(message =>
        message.role === 'assistant' && (message.content || '').trim()
      );
      if (!assistant) return [];

      const content = String(assistant.content || '');
      const formulas = extractLocalFormulas(content);
      const allTitles = [...content.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)]
        .map(match => match[1].trim())
        .filter(Boolean);
      const usefulTitles = allTitles.filter(title =>
        !/(物理直觉|数学本质|知识图谱|延伸思考|学习卡片|PhyMathia)/.test(title)
      );
      let title = (usefulTitles[0] || allTitles[0] || '')
        .replace(/的?(物理直觉|数学本质|知识图谱|延伸思考)$/, '')
        .replace(/^.*?PhyMathia\s*学习卡片\s*[:：]\s*/i, '')
        .trim();
      title = title || content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!title) return [];

      const sample = content.slice(0, 2000);
      const hasMath = /(方程|函数|导数|积分|矩阵|几何|代数|微分|定理|证明|数学)/.test(sample);
      const hasPhysics = /(物理|力学|电磁|光学|热|振动|波|场|力|能量|实验)/.test(sample);
      const category = hasPhysics && !hasMath ? 'physics' : hasMath && !hasPhysics ? 'math' : hasMath ? 'math' : 'other';
      const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/i);
      const summary = (summaryMatch ? summaryMatch[1] : content)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

      return [{
        title: title.slice(0, 80),
        category,
        tags: [category === 'physics' ? '物理' : category === 'math' ? '数学' : '其他'],
        summary,
        formulas,
      }];
    }

    function saveExtractedFormulas(sessionId, items) {
      const formulas = [];
      for (const item of items || []) {
        for (const latex of item.formulas || []) {
          formulas.push({
            latex,
            concept: item.title,
            meaning: item.summary,
            topic: '',
            related: item.tags || [],
            sessionId,
            createdAt: Date.now(),
          });
        }
      }
      if (formulas.length > 0) saveFormulasToServer(formulas);
    }

    async function requestKnowledgeExtraction(payload) {
      const resp = await fetch('/api/extract_knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return data.items || [];
    }

    function saveExtractedKnowledgeItems(sessionId, messages, items, updateExisting = false) {
      if (!items || items.length === 0) return;

      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      const messageId = lastAssistant ? (lastAssistant.timestamp || '') : '';
      const existingItems = getKnowledgeItems();
      let changed = false;
      const messageItems = Object.values(existingItems).filter(e =>
        e.sessionId === sessionId && String(e.messageId || '') === String(messageId)
      );

      for (const item of items) {
        const existing = Object.values(existingItems).find(e =>
          e.sessionId === sessionId && e.title === item.title
        ) || (updateExisting && items.length === 1 && messageItems.length === 1 ? messageItems[0] : null);
        if (existing) {
          // 本地快速结果先展示，AI 结果回来后用更完整的内容覆盖它。
          if (updateExisting && existing.source === 'ai_extract') {
            Object.assign(existing, {
              category: item.category || existing.category,
              tags: item.tags || existing.tags,
              summary: item.summary || existing.summary,
              formulas: item.formulas && item.formulas.length ? item.formulas : existing.formulas,
            });
            changed = true;
          }
          continue;
        }

        const id = 'ki_' + crypto.randomUUID().replace(/-/g, '');
        existingItems[id] = {
          id: id,
          title: item.title,
          category: item.category || 'other',
          tags: item.tags || [],
          summary: item.summary || '',
          formulas: item.formulas || [],
          source: 'ai_extract',
          sessionId: sessionId,
          messageId: String(messageId),
          createdAt: Date.now()
        };
        changed = true;
      }

      if (changed) saveKnowledgeItems(existingItems);
    }

    function refreshKnowledgePanelIfOpen() {
      try {
        const panel = document.getElementById('knowledgePanel');
        if (!panel || !panel.classList.contains('active')) return;
        if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
        if (typeof renderKnowledgePanel === 'function') renderKnowledgePanel();
        const activeTab = document.querySelector('.kp-tab.active');
        if (activeTab && activeTab.dataset.tab === 'formulas' && typeof loadFormulas === 'function') {
          loadFormulas();
        }
      } catch (e) {
        console.warn('Refresh knowledge panel failed:', e);
      }
    }

    async function autoExtractKnowledge(sessionId, messages) {
      if (!messages || messages.length === 0) return;
      if (messages.length < 2) return; // Need at least 1 exchange

      const extractingEl = document.getElementById('kpExtracting');
      // 后台增强可能跨越下一轮对话，固定本轮消息避免结果串入新回答。
      const extractionMessages = messages.map(message => ({ ...message }));
      try {
        extractingEl?.classList.add('active');
        const agentModel = getActiveModelForRole('agent');
        const descriptorModel = getActiveModelForRole('descriptor');
        const basePayload = { messages: extractionMessages, sessionId: sessionId };

        // 浏览器本地先提取，不等待消息保存或任何模型响应。
        const localItems = extractLocalKnowledge(extractionMessages);
        saveExtractedKnowledgeItems(sessionId, extractionMessages, localItems);
        saveExtractedFormulas(sessionId, localItems);
        refreshKnowledgePanelIfOpen();

        const payload = { ...basePayload };
        if (agentModel) {
          payload.provider = agentModel.provider;
          payload.api_key = agentModel.apiKey;
          payload.model = agentModel.model;
          payload.base_url = agentModel.baseUrl;
        }
        // 公式描述模型（可选）：为公式速查库中的公式生成简要描述
        if (descriptorModel) {
          payload.descriptor_provider = descriptorModel.provider;
          payload.descriptor_api_key = descriptorModel.apiKey;
          payload.descriptor_model = descriptorModel.model;
          payload.descriptor_base_url = descriptorModel.baseUrl;
        }

        // AI 提取作为后台增强，不再阻塞本地知识条目的首次显示。
        if (agentModel || descriptorModel) {
          let aiItems = [];
          try {
            aiItems = await requestKnowledgeExtraction(payload);
          } catch (err) {
            console.warn('AI knowledge extraction failed:', err);
          }
          saveExtractedKnowledgeItems(sessionId, extractionMessages, aiItems, true);
          saveExtractedFormulas(sessionId, aiItems);
          refreshKnowledgePanelIfOpen();
        }
      } catch (err) {
        console.warn('Auto extract knowledge failed:', err);
      } finally {
        extractingEl?.classList.remove('active');
      }
    }

    // ===== Bookmark (manual collection) =====
    function openBookmarkModal(messageEl) {
      const msgBody = messageEl.closest('.message-body');
      if (!msgBody) return;
      const msgContent = msgBody.querySelector('.message-content');
      const text = msgContent ? msgContent.textContent.trim() : '';
      const msgId = msgBody.dataset.messageId || '';
      const sessionId = currentSessionId;

      // 查找该会话中 AI 自动提取的知识条目，用于预填
      const allItems = getKnowledgeItems();
      const aiItems = Object.values(allItems).filter(
        it => it.source === 'ai_extract' && it.sessionId === sessionId
      );

      // 如果有 AI 提取条目，用第一条预填表单
      let prefill = null;
      let aiItemIds = [];
      if (aiItems.length > 0) {
        prefill = aiItems[0];
        aiItemIds = aiItems.map(it => it.id);
      }

      document.getElementById('bmContent').value = text;
      document.getElementById('bmSessionId').value = sessionId;
      document.getElementById('bmMessageId').value = msgId;

      // 预填：有 AI 提取则用 AI 内容，否则留空
      document.getElementById('bmTitle').value = prefill ? prefill.title : '';
      document.getElementById('bmSummary').value = prefill ? prefill.summary : text.substring(0, 100);
      document.getElementById('bmTags').value = prefill ? prefill.tags.join('，') : '';
      document.getElementById('bmFormulas').value = prefill ? (prefill.formulas || []).join('\n') : '';
      document.getElementById('bmCategory').value = prefill ? prefill.category : 'physics';

      // 记录要替换的 AI 条目 ID 列表
      document.getElementById('bmReplaceIds').value = aiItemIds.join(',');

      // 显示/隐藏"保存并替换"按钮
      const replaceBtn = document.getElementById('bmBtnReplace');
      if (replaceBtn) {
        replaceBtn.style.display = aiItemIds.length > 0 ? '' : 'none';
      }

      document.getElementById('bookmarkModal').classList.add('active');
    }

    function closeBookmarkModal() {
      document.getElementById('bookmarkModal').classList.remove('active');
    }

    function saveBookmark(andReplace) {
      const title = document.getElementById('bmTitle').value.trim();
      if (!title) { document.getElementById('bmTitle').focus(); return; }

      const item = {
        id: 'ki_' + crypto.randomUUID().replace(/-/g, ''),
        title: title,
        category: document.getElementById('bmCategory').value,
        summary: document.getElementById('bmSummary').value.trim(),
        tags: document.getElementById('bmTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
        formulas: document.getElementById('bmFormulas').value.split('\n').map(s => s.trim()).filter(Boolean),
        source: 'manual',
        sessionId: document.getElementById('bmSessionId').value,
        messageId: document.getElementById('bmMessageId').value,
        createdAt: Date.now()
      };
      addKnowledgeItem(item);

      // 同步公式到公式库
      if (item.formulas && item.formulas.length > 0) {
        saveFormulasToServer(item.formulas.map(f => ({
          latex: f,
          concept: item.title,
          meaning: item.summary,
          topic: '',
          related: item.tags,
          sessionId: item.sessionId,
          createdAt: Date.now()
        })));
      }

      // 如果选择了"保存并替换"，删除该会话中 AI 自动提取的条目
      if (andReplace) {
        const replaceIds = document.getElementById('bmReplaceIds').value;
        if (replaceIds) {
          replaceIds.split(',').filter(Boolean).forEach(id => deleteKnowledgeItem(id));
        }
      }

      closeBookmarkModal();

      // Update bookmark button state
      const msgId = item.messageId;
      if (msgId) {
        const btn = document.querySelector(`[data-bookmark-msg="${msgId}"]`);
        if (btn) btn.classList.add('bookmarked');
      }
    }

    function sendQuick(text) {
      document.getElementById('userInput').value = text;
      autoResize(document.getElementById('userInput'));
      sendMessage();
    }

    // URL 参数自动提问
    (function() {
      const params = new URLSearchParams(window.location.search);
      const question = params.get('question');
      if (question) {
        window.history.replaceState({}, '', window.location.pathname);
        setTimeout(() => sendQuick(decodeURIComponent(question)), 500);
      }
    })();

    async function sendMessage() {
      const input = document.getElementById('userInput');
      const btn = document.getElementById('sendBtn');
      const text = input.value.trim();
      if (!text || isStreaming) return;

      userScrolledUp = false; // 用户发送消息时重置滚动状态

      document.getElementById('welcomeTip')?.remove();

      const now = Date.now();
      addMessage('user', text, now);
      chatHistory.push({ role: 'user', content: text, timestamp: now });
      await saveCurrentSession();
      input.value = '';
      input.style.height = 'auto';
      isStreaming = true;
      lastFailedMessage = text;

      // 切换为停止按钮
      btn.disabled = false;
      btn.classList.add('stop-btn');
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      btn.onclick = () => { if (abortController) abortController.abort(); };

      abortController = new AbortController();
      showProgress('thinking');

      try {
        const agentModel = getActiveModelForRole('agent');
        let resp;
        if (agentModel) {
          showProgress('tool');
          resp = await proxyChat(text, currentLevel, SESSION_ID);
          if (!resp) throw new Error('无法连接到 AI 服务');
        } else {
          resp = await fetch('/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'agent',
              prompt: text,
              level: currentLevel,
              session_id: SESSION_ID,
              stream: true,
            }),
            signal: abortController.signal
          });
        }

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText.substring(0, 200)}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let assistantContent = '';
        let assistantDiv = null;
        let buffer = '';
        let streamRenderPending = false;

        function scheduleStreamRender() {
          if (streamRenderPending) return;
          streamRenderPending = true;
          requestAnimationFrame(() => {
            if (assistantDiv && assistantContent) {
              assistantDiv.innerHTML = renderMarkdown(assistantContent);
              _initVizIframes(assistantDiv);
              renderMath(assistantDiv);
            }
            streamRenderPending = false;
          });
        }

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split('\n\n');
          buffer = parts.pop();

          for (const part of parts) {
            const lines = part.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const dataStr = line.slice(6).trim();
              if (dataStr === '[DONE]') continue;

              try {
                const data = JSON.parse(dataStr);
                if (data.error) {
                  const errMsg = data.error.message || JSON.stringify(data.error);
                  if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
                  assistantContent += '\n\n⚠️ ' + errMsg;
                  assistantDiv.textContent = assistantContent;
                  scrollToBottom();
                  continue;
                }
                const choice = data.choices?.[0];
                const delta = choice?.delta;
                if (!delta) continue;

                if (delta.role === 'tool') {
                  lastChunkTime = Date.now();
                  if (currentStage !== 'tool') showProgress('tool');
                  continue;
                }
                if (delta.tool_calls) {
                  lastChunkTime = Date.now();
                  if (currentStage !== 'tool') showProgress('tool');
                  continue;
                }
                if (delta.role === 'tool_done') {
                  // 处理生成的文件（如交互式HTML）
                  lastChunkTime = Date.now();
                  const fileMatch = delta.content?.match(/__PHYMATHIA_FILE__:(.+)__/);
                  if (fileMatch) {
                    try {
                      const fileInfo = JSON.parse(fileMatch[1]);
                      if (fileInfo.file_url) {
                        assistantContent += `\n\n📊 [交互式可视化](${fileInfo.file_url})\n`;
                        if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
              assistantDiv.innerHTML = renderMarkdown(stripXmlTags(assistantContent));
                        _initVizIframes(assistantDiv);
                        renderMathInElement(assistantDiv);
                        scrollToBottom();
                      }
                      console.log('[ToolDone] File info:', fileInfo);
                    } catch(e) { console.warn('[ToolDone] Parse error:', e); }
                  }
                  continue;
                }
                if (delta.content) {
                  lastChunkTime = Date.now();
                  if (currentStage !== 'generating') showProgress('generating');
                  if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
                  assistantContent += delta.content;
                  // 实时渲染 Markdown 和 LaTeX（节流）
                  scheduleStreamRender();
                  scrollToBottom();
                }
              } catch (e) {}
            }
          }
        }

        // 最终渲染：优先 XML 标签解析，兜底 heading 正则
        if (assistantDiv && assistantContent) {
          const sections = parseXmlSections(assistantContent);
          if (Object.keys(sections).length > 0) {
            renderModuleSections(assistantDiv, sections);
            await renderMermaidInElement(assistantDiv);
            renderMath(assistantDiv);
          } else {
            assistantDiv.innerHTML = renderMarkdown(assistantContent);
            _initVizIframes(assistantDiv);
            renderMath(assistantDiv);
            await renderMermaidInElement(assistantDiv);
            wrapDualDomainSections(assistantDiv);
            renderMath(assistantDiv);
          }
          const ts = Date.now();
          const duration = progressStartTime ? (ts - progressStartTime) : null;
          chatHistory.push({ role: 'assistant', content: assistantContent, timestamp: ts, duration });

          // 先生成本地知识条目，消息上传继续在后台进行。
          autoExtractKnowledge(currentSessionId, chatHistory);

          await saveCurrentSession();
          renderSessionList(); // 更新侧边栏时间显示
          const metaEl = assistantDiv.closest('.message-body')?.querySelector('.message-meta');
          if (metaEl) {
            const elapsed = progressStartTime ? Date.now() - progressStartTime : 0;
            const durationStr = elapsed > 0 ? `<span class="msg-duration" title="回答耗时">⏱ ${formatDuration(elapsed)}</span>` : '';
            metaEl.innerHTML = `<span>${formatTime(ts)}</span>${durationStr}<button class="regenerate-btn" onclick="regenerateLast()" title="重新生成">🔄</button>`;
          }
          scrollToBottom(); // 最终渲染后滚动
        }

      } catch (err) {
        hideProgress();
        if (err.name === 'AbortError') {
          // 用户主动中止，保留已接收的内容
          const msgs = document.querySelectorAll('.message.assistant .message-content');
          const lastContent = msgs[msgs.length - 1];
          if (lastContent && !lastContent.textContent.trim()) {
            lastContent.closest('.message.assistant').remove();
          } else if (lastContent) {
            // 已有部分内容，在 meta 中标记已中止
            const metaEl = lastContent.closest('.message-body')?.querySelector('.message-meta');
            if (metaEl) {
              const elapsed = progressStartTime ? Date.now() - progressStartTime : 0;
              if (elapsed > 0) {
                const durTag = document.createElement('span');
                durTag.className = 'msg-duration';
                durTag.title = '回答耗时';
                durTag.textContent = '⏱ ' + formatDuration(elapsed);
                metaEl.appendChild(durTag);
              }
              const stopTag = document.createElement('span');
              stopTag.style.cssText = 'color:var(--accent);font-style:italic;';
              stopTag.textContent = '已中止';
              metaEl.appendChild(stopTag);
            }
          }
          // 保存已接收的部分内容（含耗时）
          const abortDuration = progressStartTime ? (Date.now() - progressStartTime) : null;
          if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant') {
            chatHistory[chatHistory.length - 1].duration = abortDuration;
          }
          saveCurrentSession();
        } else {
          const errDiv = addMessage('assistant', '', Date.now());
          errDiv.innerHTML = `
            <div style="color:#ff6b6b">⚠️ 请求失败: ${escapeHtml(err.message)}</div>
            <div class="error-actions">
              <button class="error-retry-btn" onclick="retryLast()">🔄 重新发送</button>
            </div>`;
          console.error('Chat error:', err);
        }
      } finally {
        hideProgress();
        isStreaming = false;
        abortController = null;
        // 恢复发送按钮
        btn.classList.remove('stop-btn');
        btn.disabled = false;
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
        btn.onclick = sendMessage;
        input.focus();
      }
    }

    function retryLast() {
      if (!lastFailedMessage || isStreaming) return;
      const msgs = document.querySelectorAll('.message.assistant');
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.querySelector('.error-actions')) lastMsg.remove();
      if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant') {
        if (chatHistory[chatHistory.length - 1].content.includes('请求失败')) chatHistory.pop();
      }
      document.getElementById('userInput').value = lastFailedMessage;
      sendMessage();
    }

    function regenerateLast() {
      if (isStreaming) return;
      // 找到最后一条助手消息并删除
      const msgs = document.querySelectorAll('.message.assistant');
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg) lastMsg.remove();
      // 从 chatHistory 中删掉最后的助手消息
      if (chatHistory.length > 0 && chatHistory[chatHistory.length - 1].role === 'assistant') {
        chatHistory.pop();
      }
      // 找到最后一条用户消息
      let userMsg = '';
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'user') { userMsg = chatHistory[i].content; break; }
      }
      if (userMsg) {
        lastFailedMessage = userMsg;
        document.getElementById('userInput').value = userMsg;
        sendMessage();
      }
    }

    function addMessage(role, content, timestamp) {
      const messages = document.getElementById('chatMessages');
      const msg = document.createElement('div');
      msg.className = 'message ' + role;

      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      if (role === 'user') { avatar.textContent = '👤'; } else if (role === 'assistant') { avatar.innerHTML = '<img src="/logo.png" alt="PhyMathia">'; }
      const body = document.createElement('div');
      body.className = 'message-body';

      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      if (role === 'user') {
        contentDiv.textContent = content;
      } else if (content) {
        contentDiv.innerHTML = renderMarkdown(content);
        _initVizIframes(contentDiv);
      }

      body.appendChild(contentDiv);

      const meta = document.createElement('div');
      meta.className = 'message-meta';
      meta.style.color = '#909090';
      meta.innerHTML = `<span>${formatTime(timestamp || Date.now())}</span>`;
      body.appendChild(meta);

      // 收藏按钮（仅助手消息）
      if (role === 'assistant') {
        const bookmarkBtn = document.createElement('button');
        bookmarkBtn.className = 'bookmark-btn';
        bookmarkBtn.title = '收藏到知识总览';
        bookmarkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
        bookmarkBtn.onclick = function() {
          openBookmarkModal(this);
        };
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
      scrollToBottom();
      return contentDiv;
    }
