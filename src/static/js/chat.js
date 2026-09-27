// ===== PhyMathia 对话核心：进度指示与分支/苏格拉底流式发送 =====
// 2026-09-25 线性主聊天退役：sendMessage 瘦身为「强制带画布锚点的分支/苏格拉底
// 传输通道」——无锚请求一律拒绝；新话题提问走工作流 startQuestionWorkflow。
// 流式内容经 streamingAssistant 直驱画布节点（graph.js 读 getStreamingAssistant），
// 不再创建聊天气泡 DOM。被删的线性管线与恢复方式见 docs/dev/linear-chat-retired.md。

    // ====== 进度指示器 ======
    let progressTimer = null;
    let progressStartTime = 0;
    let currentStage = '';
    let streamingAssistant = null;
    let progressPercent = 0;
    let progressLabel = '';
    let progressHidden = false;
    let progressStatusHideTimer = null;

    const PROGRESS_PHASE = {
      thinking: { percent: 8, label: '正在理解问题' },
      tool: { percent: 32, label: '正在调用工具进行计算和可视化生成' },
      generating: { percent: 46, label: '正在生成回答' },
      waiting: { percent: null, label: '' },
      rendering: { percent: 92, label: '正在整理回答' },
      done: { percent: 100, label: '回复完成' }
    };
    const STREAM_SECTION_PROGRESS = [
      { key: 'physics', weight: 12, label: '物理直觉', open: /<physics>/i, close: /<\/physics>/i },
      { key: 'math', weight: 12, label: '数学本质', open: /<math>/i, close: /<\/math>/i },
      { key: 'graph', weight: 8, label: '知识图谱', open: /<graph>/i, close: /<\/graph>/i },
      { key: 'viz', weight: 8, label: '交互可视化', open: /<viz>/i, close: /<\/viz>/i },
      { key: 'extend', weight: 7, label: '进阶学习', open: /<extend>/i, close: /<\/extend>/i },
      { key: 'summary', weight: 3, label: '摘要', open: /<summary>/i, close: /<\/summary>/i }
    ];

    function _clampProgress(value) {
      const num = Number(value);
      if (!Number.isFinite(num)) return 0;
      return Math.max(0, Math.min(100, Math.round(num)));
    }

    function _setProgress(percent, label) {
      progressPercent = _clampProgress(percent);
      if (label) progressLabel = label;
      const statusFill = document.getElementById('statusProgressFill');
      if (statusFill) statusFill.style.width = progressPercent + '%';
      const textEl = document.querySelector('#progressStatus .status-text');
      if (textEl) {
        // 0% 后缀只在实际跑起来后出现（thinking 起步 8%）：闲时 0% 会读成卡死
        const suffix = progressPercent > 0 && progressPercent < 100 ? ' · ' + progressPercent + '%' : '';
        textEl.textContent = progressLabel + suffix;
      }
    }

    function _streamProgressFromContent(content) {
      let percent = PROGRESS_PHASE.generating.percent;
      let label = PROGRESS_PHASE.generating.label;
      let sawSection = false;
      for (const cfg of STREAM_SECTION_PROGRESS) {
        const opened = cfg.open.test(content);
        const closed = cfg.close.test(content);
        if (closed) {
          percent += cfg.weight;
          sawSection = true;
        } else if (opened) {
          percent += Math.round(cfg.weight * 0.35);
          sawSection = true;
        }
      }
      if (sawSection) {
        for (const cfg of STREAM_SECTION_PROGRESS) {
          if (cfg.open.test(content) && !cfg.close.test(content)) {
            label = '正在生成' + cfg.label;
            break;
          }
        }
      }
      return { percent: Math.min(90, percent), label };
    }

    function showProgress(stage, percent, label) {
      currentStage = stage;
      progressHidden = false;
      if (progressStatusHideTimer) { clearTimeout(progressStatusHideTimer); progressStatusHideTimer = null; }
      const statusEl = document.getElementById('progressStatus');
      if (statusEl) { statusEl.classList.add('active'); updateProgressText(stage, percent, label); }
      if (!progressTimer) {
        progressStartTime = Date.now();
        progressTimer = setInterval(() => {
          updateElapsedTime();
        }, 500);
      }
    }
    function updateProgressText(stage, percent, label) {
      const textEl = document.querySelector('#progressStatus .status-text');
      if (!textEl) return;
      const base = PROGRESS_PHASE[stage] || {};
      const pct = percent !== undefined && percent !== null
        ? _clampProgress(percent)
        : (base.percent !== undefined && base.percent !== null ? _clampProgress(base.percent) : progressPercent);
      const msgs = { 'thinking':'PhyMathia 正在深度思考，可能需要一点时间...', 'tool':'正在调用工具进行计算和可视化生成，请耐心等待...', 'generating':'正在精心组织回复...', 'waiting':'', 'done':'回复完成' };
      if (stage === 'waiting') {
        _setProgress(pct, '正在继续生成...');
      } else {
        _setProgress(pct, label || base.label || msgs[stage] || msgs['thinking']);
      }
    }
    function updateElapsedTime() {
      const timeEl = document.querySelector('#progressStatus .elapsed-time');
      if (!timeEl) return;
      const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      timeEl.textContent = min > 0 ? `${min}m${sec.toString().padStart(2,'0')}s` : `${sec}s`;
    }
    function hideProgress() {
      if (progressHidden) return;
      progressHidden = true;
      const statusEl = document.getElementById('progressStatus');
      if (statusEl && statusEl.classList.contains('active')) {
        progressStatusHideTimer = setTimeout(() => {
          statusEl.classList.remove('active');
          // 2026-09-25 用户拍板：胶囊常驻不当 bug 修，但闲时文案不得读成进行时/卡死
          _setProgress(0, '待命');
          const timeEl = document.querySelector('#progressStatus .elapsed-time');
          if (timeEl) timeEl.textContent = '';
          progressStatusHideTimer = null;
        }, 1500);
      }
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    }

    const PROGRESS_POS_KEY = 'phymathia_progress_pos';
    function _applySavedProgressPosition() {
      try {
        const raw = localStorage.getItem(PROGRESS_POS_KEY);
        const pos = raw ? JSON.parse(raw) : null;
        if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
        const status = document.getElementById('progressStatus');
        if (!status) return;
        status.classList.add('dragged');
        status.style.left = pos.x + 'px';
        status.style.top = pos.y + 'px';
        status.style.transform = 'none';
      } catch (e) {}
    }

    function initProgressDragging() {
      const status = document.getElementById('progressStatus');
      if (!status) return;
      _applySavedProgressPosition();
      const handle = status.querySelector('.status-drag-handle');
      if (!handle) return;
      let dragging = false;
      let startX = 0;
      let startY = 0;
      let originX = 0;
      let originY = 0;
      const onDown = (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = status.getBoundingClientRect();
        originX = rect.left;
        originY = rect.top;
        status.classList.add('dragging');
        status.setPointerCapture(e.pointerId);
        e.preventDefault();
      };
      const onMove = (e) => {
        if (!dragging) return;
        const nextX = Math.max(4, Math.min(window.innerWidth - status.offsetWidth - 4, originX + e.clientX - startX));
        const nextY = Math.max(4, Math.min(window.innerHeight - status.offsetHeight - 4, originY + e.clientY - startY));
        status.classList.add('dragged');
        status.style.left = nextX + 'px';
        status.style.top = nextY + 'px';
        status.style.transform = 'none';
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        status.classList.remove('dragging');
        try {
          const rect = status.getBoundingClientRect();
          localStorage.setItem(PROGRESS_POS_KEY, JSON.stringify({
            x: Math.round(rect.left),
            y: Math.round(rect.top)
          }));
        } catch (e) {}
      };
      handle.addEventListener('pointerdown', onDown);
      status.addEventListener('pointermove', onMove);
      status.addEventListener('pointerup', onUp);
      status.addEventListener('pointercancel', onUp);
    }
    initProgressDragging();

    function _syncProgressMiniButtons(running) {
      const runBtn = document.getElementById('statusRunBtn');
      const stopBtn = document.getElementById('statusStopBtn');
      if (runBtn) runBtn.disabled = running;
      if (stopBtn) stopBtn.disabled = !running;
    }
    window.getCurrentProgress = () => progressPercent;

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


    let pendingQuickText = '';
    function sendQuick(text) {
      pendingQuickText = String(text || '');
      return sendMessage();
    }

    function stopGeneration() {
      if (abortController) abortController.abort();
      if (typeof window.stopWorkflowRun === 'function') window.stopWorkflowRun();
    }

    // ====== 画布直驱流式：内容写入 streamingAssistant，graph.js 定时取走渲染 ======

    // force 仅供排队重放使用：flush 时把之前抓下来的正文与锚点还原成全局态再走一遍
    // 正常路径，而不是另开一条发送实现——这样各入口原有的收尾动作一处不漏。
    async function sendMessage(force) {
      const text = (pendingQuickText || '').trim();
      pendingQuickText = '';
      if (!text) return;
      // 无锚即拒绝（2026-09-25 线性主聊天退役）：分支/苏格拉底请求必须锚在画布
      // 节点上；新话题提问走工作流 startQuestionWorkflow，线性通道已删除。
      const branchMeta = _consumePendingBranch();
      if (!branchMeta) {
        if (typeof showToast === 'function') showToast('请先在画布节点上选择追问位置');
        return;
      }
      // 忙碌兜底（T42）：正常入口——苏格拉底回答/追问/直接问AI/给点提示/看讲解——
      // 都在自己那一层先收队，走不到这里；到这儿的是端口动作之类的直调。
      // 这里也排队而不是丢弃：静默丢弃是 T42 报告的原始症状，用户只会以为按钮坏了。
      // 收队必须排在发送锁之前、且整个过程同步，「发送锁覆盖首个异步等待」才仍成立。
      if (!force && typeof _isSendBusy === 'function' && _isSendBusy()) {
        const queuedText = text;
        const queuedMeta = branchMeta;
        _enqueueSend('追问', function() {
          setActiveBranchAnchor(queuedMeta);
          pendingQuickText = queuedText;
          return sendMessage(true);
        }, { text: queuedText });
        return;
      }
      isStreaming = true;
      const sourceSessionId = currentSessionId;
      const stopBtn = document.getElementById('stopBtn');
      // 任务列表：这条发送也是一件活儿（普通发送 / 追问 / 苏格拉底回答都从这儿过），
      // 面板上看得见、停得掉。只有"直接发"记账——排队重放那条已经由队列记过了，
      // 不记账就会出现两条一模一样的行。
      const sendTask = (!force && typeof _taskCreate === 'function')
        ? _taskCreate({
            kind: 'send',
            title: text.replace(/^\[[^\]]*\]\s*/, '') || '发送',
            state: 'running',
            replay: { text: text.slice(0, 500) },
          })
        : null;
      let sendTaskState = 'done';
      let sendTaskNote = '';
      if (sendTask && typeof _taskBindCancel === 'function') {
        // 面板上的「停止」= 掐断这条流，与顶部停止按钮同一条路
        _taskBindCancel(sendTask.id, function() { if (abortController) abortController.abort(); });
      }
      try {

      const now = Date.now();
      const isSocraticBranchSend = text.startsWith('[苏格拉底回答]') || branchMeta.branchType === 'socratic';
      currentBranch = isSocraticBranchSend ? 'socratic' : null;
      currentBranchId = isSocraticBranchSend && branchMeta.branchId ? branchMeta.branchId : null;
      const userMessage = { role: 'user', content: text, timestamp: now, ...branchMeta };
      if (isSocraticBranchSend) {
        userMessage.branch = 'socratic';
        userMessage.branchId = userMessage.branchId || currentBranchId;
      }
      chatHistory.push(userMessage);
      await saveCurrentSession();
      if (sourceSessionId !== currentSessionId) return;

      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
      streamingAssistant = { role: 'assistant', content: '', timestamp: Date.now(), ...branchMeta };

      if (stopBtn) stopBtn.disabled = false;
      _syncProgressMiniButtons(true);

      abortController = new AbortController();
      // 流式生成是重活（增量渲染 + 画布补丁都在吃帧预算），装饰粒子先让路
      if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(true);
      showProgress('thinking');
      let assistantContent = '';
      // 推理通道单独攒：思维链**不是**回答正文。混进正文的后果不只是难看——知识提取的
      // v4 闸门（前后端同判 `_looks_like_reasoning_leak`）会把整轮判成「思维链泄漏」而
      // 拒绝提取，这条概念就永远进不了知识库，大陆上也就永远没有这座岛
      // （真机复现：推理模型答「旋度」→ 知识库无旋度 → 大陆无旋度岛）。
      let assistantReasoning = '';
      let graphRenderPending = false;
      let graphRenderFrame = null;

      function cancelPendingGraphRender() {
        if (graphRenderFrame !== null) {
          clearTimeout(graphRenderFrame);
          graphRenderFrame = null;
        }
        graphRenderPending = false;
      }

      try {
        const agentModel = getActiveModelForRole('agent');
        let resp;
        if (agentModel) {
          showProgress('tool', 26, '正在连接 AI 服务');
          // 寒暄快捷通道已随线性主聊天退役：分支/苏格拉底请求一律走完整回答路径，
          // 不再带 quick/max_tokens（此前这里引用了未定义的 isCasual，请求发出前即抛 ReferenceError）
          resp = await proxyChat(text, currentLevel, SESSION_ID, true, abortController.signal, branchMeta);
          if (!resp) throw new Error('无法连接到 AI 服务');
        } else {
          if (typeof showToast === 'function') showToast('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
          throw new Error('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');
        }

        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`HTTP ${resp.status}: ${errText.substring(0, 200)}`);
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamChunkCount = 0;

        function scheduleGraphStreamRender() {
          if (graphRenderPending) return;
          graphRenderPending = true;
          graphRenderFrame = setTimeout(() => {
            graphRenderFrame = null;
            graphRenderPending = false;
            if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas(true);
          }, 250);
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
                    // 后端错误帧形如 {error: <状态码数字>, detail: '...'}，对齐 chat-features.js collectStreamText 的读法；
                    // 错误文本照旧并入正文，画布节点上直接可见
                    const errMsg = data.detail || data.error?.detail || data.error?.message || JSON.stringify(data.error);
                    assistantContent += '\n\n⚠️ ' + errMsg;
                    streamingAssistant.content = assistantContent;
                    scheduleGraphStreamRender();
                    continue;
                  }
                  if (typeof data.progress === 'number') {
                    const pct = Math.max(progressPercent, data.progress);
                    const label = data.progress >= 30 || currentStage === 'waiting'
                      ? '正在生成回答'
                      : (progressLabel || '正在生成回答');
                    _setProgress(pct, label);
                  }
                  const choice = data.choices?.[0];
                  const delta = choice?.delta;
                  if (!delta) continue;

                  if (delta.role === 'tool') {
                    if (currentStage !== 'tool') showProgress('tool', Math.max(progressPercent, PROGRESS_PHASE.tool.percent), '正在调用工具');
                    continue;
                  }
                  if (delta.tool_calls) {
                    if (currentStage !== 'tool') showProgress('tool', Math.max(progressPercent, PROGRESS_PHASE.tool.percent), '正在调用工具');
                    continue;
                  }
                  if (delta.role === 'tool_done') {
                    // 处理生成的文件（如交互式HTML）
                    const fileMatch = delta.content?.match(/__PHYMATHIA_FILE__:(.+)__/);
                    if (fileMatch) {
                      try {
                        const fileInfo = JSON.parse(fileMatch[1]);
                        if (fileInfo.file_url) {
                          assistantContent += `\n\n[交互式可视化](${fileInfo.file_url})\n`;
                          streamingAssistant.content = assistantContent;
                          scheduleGraphStreamRender();
                        }
                        console.log('[ToolDone] File info:', fileInfo);
                      } catch(e) { console.warn('[ToolDone] Parse error:', e); }
                    }
                    continue;
                  }
                  if (delta.content || delta.reasoning_content) {
                    if (currentStage !== 'generating') showProgress('generating', Math.max(progressPercent, PROGRESS_PHASE.generating.percent), '正在生成回答');
                    // 两个通道分开攒：只有 content 进正文，reasoning_content 留在旁边
                    // （旧写法 `delta.content || delta.reasoning_content` 会把思维链灌进正文）
                    if (delta.content) assistantContent += delta.content;
                    else assistantReasoning += delta.reasoning_content;
                    streamingAssistant.content = assistantContent;
                    const streamProgress = _streamProgressFromContent(assistantContent);
                    if (streamProgress.percent > progressPercent) _setProgress(streamProgress.percent, streamProgress.label);
                    streamChunkCount++;
                    if (streamChunkCount % 4 === 0) {
                      await new Promise(resolve => setTimeout(resolve, 0));
                    }
                    scheduleGraphStreamRender();
                  }
                } catch (e) {}
            }
          }
        }

        _setProgress(90, '正在整理回答');

        // 模型只吐了推理通道、正文一个字都没有时退回思维链：宁可显示思维链，也别给一个
        // 空节点（这种轮次知识提取照旧会被闸门拒收——那是对的，思维链不是知识）
        if (!assistantContent.trim() && assistantReasoning.trim()) {
          assistantContent = assistantReasoning;
        }

        if (assistantContent) {
          streamingAssistant = null;
          _setProgress(92, '正在整理回答');
          _setProgress(94, '正在整理回答');
          _setProgress(97, '正在保存回答');
          const ts = Date.now();
          const duration = progressStartTime ? (ts - progressStartTime) : null;
          const wasSocraticBranch = currentBranch === 'socratic';
          const assistantMeta = { ...branchMeta };
          if (wasSocraticBranch) {
            assistantMeta.branch = 'socratic';
            assistantMeta.branchId = assistantMeta.branchId || currentBranchId;
          }
          chatHistory.push({
            role: 'assistant',
            content: assistantContent,
            timestamp: ts,
            duration,
            ...assistantMeta,
          });

          // 交互可视化缺失时后台补齐：先保存/展示主回答，模型生成完成后原地回填。
          // （stage2 源码审计按字符串定位本回调与 sourceSessionId/originatingAssistant
          // 两行，改结构前先看 scripts/review_stage2_frontend.mjs 的 F 审计段）
          if (typeof scheduleVisualizationInBackground === 'function') {
            const originatingAssistant = chatHistory[chatHistory.length - 1];
            scheduleVisualizationInBackground(assistantContent, (updatedContent) => {
              try {
                // 切会话或原回答已被删除/重生成时丢弃；时间戳相同不代表同一条回答。
                if (currentSessionId !== sourceSessionId || !chatHistory.includes(originatingAssistant)) return;
                originatingAssistant.content = updatedContent;
                try {
                  localStorage.setItem('phymathia_msgs_' + sourceSessionId, JSON.stringify(chatHistory));
                } catch (e) {}
              } catch (err) {
                console.warn('Failed to apply background visualization:', err);
              }
            });
          }

          if (wasSocraticBranch && /<socratic_meta\b[^>]*done\s*=\s*["']true["']/i.test(assistantContent)) {
            currentBranch = null;
            currentBranchId = null;
          }

          if (wasSocraticBranch) {
            const socraticMetaMatch = assistantContent.match(/<socratic_meta\b[^>]*correct\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
            if (socraticMetaMatch && typeof window.recordSocraticAnswer === 'function') {
              const qm = text.match(/追问问题[：:]\s*([^\n]+)/);
              const lm = text.match(/追问等级[：:]\s*(基础|进阶|拓展)/);
              window.recordSocraticAnswer({
                title: (qm && qm[1] ? qm[1].trim() : '') || '苏格拉底追问',
                question: (qm && qm[1] ? qm[1].trim() : '') || '',
                correct: socraticMetaMatch[1].toLowerCase() === 'correct',
                sessionId: (typeof currentSessionId !== 'undefined' ? currentSessionId : SESSION_ID) || '',
                level: lm ? lm[1] : '',
              });
            }
          }

          // 先生成本地知识条目，消息上传继续在后台进行。
          _setProgress(98, '正在提取知识');
          autoExtractKnowledge(currentSessionId, chatHistory);

          await saveCurrentSession();
          if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
          renderSessionList(); // 更新侧边栏时间显示
          // 队列里还有东西时不弹「完成」：这一轮只是**这一轮**完了，活儿没干完，
          // 弹完成卡片是骗人，而且下一条马上自动发出去，卡片会跟新进度撞在一起。
          if (typeof notifyTaskCompleted === 'function' && duration
              && !(typeof _hasPendingSend === 'function' && _hasPendingSend())) {
            notifyTaskCompleted(duration, '回复完成');
          }
        }

      } catch (err) {
        hideProgress();
        sendTaskState = err.name === 'AbortError' ? 'stopped' : 'error';
        sendTaskNote = err.name === 'AbortError' ? '手动停止' : (err.message || '发送失败');
        if (err.name === 'AbortError') {
          if (assistantContent.trim()) {
            streamingAssistant = null;
            const ts = Date.now();
            const wasSocraticBranch = currentBranch === 'socratic';
            const assistantMeta = { ...branchMeta };
            if (wasSocraticBranch) {
              assistantMeta.branch = 'socratic';
              assistantMeta.branchId = assistantMeta.branchId || currentBranchId;
            }
            chatHistory.push({
              role: 'assistant',
              content: assistantContent,
              timestamp: ts,
              duration: progressStartTime ? (Date.now() - progressStartTime) : null,
              aborted: true,
              ...assistantMeta,
            });
            await saveCurrentSession();
          }
        } else {
          console.error('Chat error:', err);
          if (typeof showToast === 'function') showToast('回答失败：' + err.message);
        }
      } finally {
        cancelPendingGraphRender();
        if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(false);
        hideProgress();
        isStreaming = false;
        abortController = null;
        if (stopBtn) stopBtn.disabled = true;
        _syncProgressMiniButtons(false);
        streamingAssistant = null;
        if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
        if (pendingDeleteTimestamp) {
          const ts = pendingDeleteTimestamp;
          pendingDeleteTimestamp = null;
          await _performDeleteMessages(ts);
        }
        // 队列放最后：删除确认是这条 finally 里的收尾动作，抢在它前面发下一条会串台
        if (typeof _flushSendQueue === 'function') await _flushSendQueue();
      }
      } catch (err) {
        console.error('Send preparation failed:', err);
        sendTaskState = 'error';
        sendTaskNote = (err && err.message) || '发送未完成';
        if (typeof showToast === 'function') showToast('发送未完成，请重试');
      } finally {
        isStreaming = false;
        if (sendTask && typeof _taskFinish === 'function') _taskFinish(sendTask.id, sendTaskState, sendTaskNote);
        if (typeof _flushSendQueue === 'function') _flushSendQueue();
      }
    }

