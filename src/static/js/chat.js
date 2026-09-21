// ===== PhyMathia 对话核心：进度指示、输入、发送与流式接收 =====

    // ====== 进度指示器 ======
    let progressTimer = null;
    let progressStartTime = 0;
    let lastChunkTime = 0;
    let currentStage = '';
    let streamingAssistant = null;
    let lastFailedBranchMeta = null;
    let progressPercent = 0;
    let progressLabel = '';
    let progressFinalLabel = '';
    let progressHidden = false;
    let progressBarHideTimer = null;
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
      const bar = document.getElementById('progressBar');
      const fill = bar ? bar.querySelector('.progress-fill') : null;
      if (fill) {
        fill.style.width = progressPercent + '%';
        fill.style.animation = 'none';
        fill.style.transform = 'none';
      }
      if (bar) bar.setAttribute('aria-valuenow', String(progressPercent));
      const statusFill = document.getElementById('statusProgressFill');
      if (statusFill) statusFill.style.width = progressPercent + '%';
      const textEl = document.querySelector('#progressStatus .status-text');
      if (textEl) {
        const suffix = progressPercent < 100 ? ' · ' + progressPercent + '%' : '';
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
      if (progressBarHideTimer) { clearTimeout(progressBarHideTimer); progressBarHideTimer = null; }
      if (progressStatusHideTimer) { clearTimeout(progressStatusHideTimer); progressStatusHideTimer = null; }
      const bar = document.getElementById('progressBar');
      const statusEl = document.getElementById('progressStatus');
      if (bar) bar.classList.add('active');
      if (statusEl) { statusEl.classList.add('active'); updateProgressText(stage, percent, label); }
      if (!progressTimer) {
        progressStartTime = Date.now();
        lastChunkTime = Date.now();
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
    var waitingTipIndex = -1;
    function updateElapsedTime() {
      const timeEl = document.querySelector('#progressStatus .elapsed-time');
      if (!timeEl) return;
      const elapsed = Math.floor((Date.now() - progressStartTime) / 1000);
      const min = Math.floor(elapsed / 60);
      const sec = elapsed % 60;
      timeEl.textContent = min > 0 ? `${min}m${sec.toString().padStart(2,'0')}s` : `${sec}s`;
    }
    function hideProgress(finalLabel) {
      if (progressHidden) return;
      progressHidden = true;
      const finalText = finalLabel || progressFinalLabel || '回复完成';
      progressFinalLabel = '';
      const bar = document.getElementById('progressBar');
      const statusEl = document.getElementById('progressStatus');
      if (bar) {
        _setProgress(100, finalText);
        progressBarHideTimer = setTimeout(() => {
          bar.classList.remove('active');
          progressBarHideTimer = null;
        }, 300);
      }
      if (statusEl && statusEl.classList.contains('active')) {
        progressStatusHideTimer = setTimeout(() => {
          statusEl.classList.remove('active');
          _setProgress(0, '生成进度');
          const timeEl = document.querySelector('#progressStatus .elapsed-time');
          if (timeEl) timeEl.textContent = '0s';
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

    function handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    }
    function autoResize(textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    }
    const userInputEl = document.getElementById('userInput');
    if (userInputEl) userInputEl.addEventListener('input', function() { autoResize(this); });

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
    function sendQuick(text, resendMeta) {
      pendingQuickText = String(text || '');
      const input = document.getElementById('userInput');
      if (input) {
        input.value = pendingQuickText;
        autoResize(input);
      }
      return sendMessage(resendMeta === undefined ? undefined : { resendMeta });
    }

    function _isCasualPrompt(text) {
      const t = String(text || '').trim();
      if (!t || t.length > 60) return false;
      const pure = /^(你好|您好|嗨|哈喽|hello|hi|hey|谢谢|感谢|哈哈|嘿嘿|在吗|在不在|随便聊聊|聊聊|没事|好的|嗯|再见|拜拜|晚安|早安|辛苦了|厉害|不错|666|嗯嗯|ok|好的吧|可以|没问题|了解|明白)[!！。.~～\s]*$/i;
      if (pure.test(t)) return true;
      const learning = /什么是|为什么|怎么|如何|解释|讲|公式|导数|积分|物理|数学|题目|作业|求|帮我|区别|证明|推导|求解|请问|写|做/;
      if (learning.test(t)) return false;
      return /(你好|您好|嗨|谢谢|感谢|哈哈|嘿嘿|在吗|随便聊聊|聊聊|辛苦|不错|再见|拜拜|晚安|早安)/.test(t) && t.length <= 20;
    }

    function _localCasualReply(text) {
      const t = String(text || '').trim();
      const pure = /^(你好|您好|嗨|哈喽|hello|hi|hey|谢谢|感谢|哈哈|嘿嘿|在吗|在不在|再见|拜拜|晚安|早安|辛苦了|嗯嗯|ok|好的吧|666)[!！。.~～\s]*$/i;
      if (!pure.test(t)) return '';
      if (/谢谢|感谢/.test(t)) return '不客气～有什么物理/数学问题，或者想整理知识网络，随时找我！';
      if (/在吗|在不在/.test(t)) return '在的～我一直都在。想聊点什么？物理、数学还是你的知识网络？';
      if (/再见|拜拜|晚安/.test(t)) return '再见～有想探索的概念随时回来找我！';
      if (/早安/.test(t)) return '早上好！今天想探索点什么？';
      if (/你好|您好|嗨|哈喽|hello|hi|hey/.test(t)) return '你好呀！我是 PhyMathia，可以帮你从物理直觉和数学本质两个角度理解问题，也可以聊聊知识网络～有什么想问的？';
      return '哈哈，我在呢～有什么想聊的？';
    }

    function stopGeneration() {
      if (abortController) abortController.abort();
      if (typeof window.stopWorkflowRun === 'function') window.stopWorkflowRun();
    }

    function _messageBranchMeta(message) {
      const meta = {};
      for (const key of ['branch', 'parentId', 'sourceModule', 'branchType', 'branchId', 'branchLabel', 'fromPort', 'position']) {
        if (message && Object.prototype.hasOwnProperty.call(message, key)) {
          meta[key] = key === 'position' && message[key] ? { ...message[key] } : message[key];
        }
      }
      return meta;
    }

    // ====== 流式增量渲染：冻结已闭合块，只重渲染生成中的尾块 ======
    // 旧行为每个流帧对整篇内容重跑 renderMarkdown + 全量 KaTeX，回答越长每帧越贵
    // （O(n²)，长公式回答时风扇起飞）。这里把内容切成「已闭合块（渲染一次冻结不动）+
    // 生成中尾块（每帧重渲染）」。切块边界只在安全位置产生：不在未闭合代码围栏内、
    // 不在未闭合标签内、不在列表中间（否则有序列表被拆成两段重新编号）。
    const STREAM_RENDER_MIN_INTERVAL = 120;  // 渲染节流：流式内容每帧都在变，肉眼不需要 60fps
    let _lastStreamRenderAt = 0;
    const _streamRenderStates = new WeakMap(); // 消息内容容器 -> 渲染状态

    // 空元素/自闭合写法不进未闭合标签栈
    const _STREAM_VOID_TAGS = new Set(['br', 'hr', 'img', 'meta', 'link', 'input', 'source', 'wbr', 'col', 'area', 'base', 'param', 'embed', 'track']);
    const _STREAM_LIST_RE = /^[ \t]*(?:[-*+][ \t]|\d{1,9}[.)][ \t])/;
    const _STREAM_SCAN_RE = /(```|~~~)|\n[ \t]*\n|<(\/?)([a-zA-Z][a-zA-Z0-9_-]*)\b[^>]*?(\/?)>/g;

    function _streamLineLooksListish(line) {
      return _STREAM_LIST_RE.test(line) || /^[ \t]+\S/.test(line);
    }

    // 推进边界扫描。content 只追加，scan.pos 停在上一个匹配的末尾——尾部未匹配区
    // （可能含未长全的 token，如只到了半个 ``` 或半个标签）每轮重扫，长全后自然命中。
    // scan.blockStart = 最后一个安全边界；其后内容属于尾块。
    function _streamAdvanceScan(scan, text) {
      const re = _STREAM_SCAN_RE;
      re.lastIndex = scan.pos;
      let m;
      while ((m = re.exec(text)) !== null) {
        scan.pos = re.lastIndex;
        if (m[1]) {
          if (!scan.inFence) scan.inFence = m[1];
          else if (m[1] === scan.inFence) scan.inFence = false;
        } else if (m[3]) {
          // 围栏内是字面代码，标签不参与结构；围栏本身未闭合时块边界本来就不产生
          if (!scan.inFence) {
            const tag = m[3].toLowerCase();
            if (!_STREAM_VOID_TAGS.has(tag) && m[4] !== '/') {
              if (m[2]) {
                const at = scan.openTags.lastIndexOf(tag);
                if (at >= 0) scan.openTags.length = at;
              } else if (scan.openTags.indexOf(tag) < 0) {
                scan.openTags.push(tag);
              }
            }
          }
        } else if (!scan.inFence && scan.openTags.length === 0) {
          const prevStart = text.lastIndexOf('\n', m.index - 1) + 1;
          const prevLine = text.slice(prevStart, m.index);
          const rest = text.slice(m.index + m[0].length);
          const nl = rest.indexOf('\n');
          const nextLine = nl >= 0 ? rest.slice(0, nl) : rest;
          if (!_streamLineLooksListish(prevLine) || !_streamLineLooksListish(nextLine)) {
            scan.blockStart = m.index + m[0].length;
          }
        }
      }
    }

    function _streamRenderTick(assistantDiv, assistantContent, messageId) {
      if (!assistantDiv || !assistantContent) return;
      const renderCtxBase = { parentId: messageId, socraticFallback: true };
      let st = _streamRenderStates.get(assistantDiv);
      // 错误帧/tool_done 路径会整写 textContent 或 innerHTML，我们的结构被换掉；
      // 检测标记丢失就按当前 scan 重建（scan 从零起，一次性重渲染全部已闭合块）
      if (!st || !st.root || st.root.parentNode !== assistantDiv) {
        assistantDiv.innerHTML = '';
        const root = document.createElement('div');
        root.className = 'stream-incremental';
        const stable = document.createElement('div');
        stable.className = 'stream-stable';
        const tail = document.createElement('div');
        tail.className = 'stream-tail';
        root.appendChild(stable);
        root.appendChild(tail);
        assistantDiv.appendChild(root);
        st = { root, stable, tail, frozenLen: 0, chunkSeq: 0, lastTailText: null, scan: { pos: 0, blockStart: 0, inFence: false, openTags: [] } };
        _streamRenderStates.set(assistantDiv, st);
      }
      const text = assistantContent;
      _streamAdvanceScan(st.scan, text);
      const stableText = text.slice(0, st.scan.blockStart);
      const tailText = text.slice(st.scan.blockStart);
      if (stableText.length > st.frozenLen) {
        // 新冻结的完整块（一次可能冻结多段）：渲染一次追加，之后不再重渲染
        const chunk = stableText.slice(st.frozenLen);
        const block = document.createElement('div');
        block.className = 'stream-block';
        block.innerHTML = renderMarkdown(chunk, { ...renderCtxBase, slotPrefix: 's' + (st.chunkSeq++) + ':' });
        st.stable.appendChild(block);
        if (typeof _initVizIframes === 'function') _initVizIframes(block);
        if (typeof renderMath === 'function') renderMath(block);
        st.frozenLen = stableText.length;
      }
      if (tailText !== st.lastTailText) {
        st.tail.innerHTML = renderMarkdown(tailText, { ...renderCtxBase, slotPrefix: 'tail:' });
        if (typeof _initVizIframes === 'function') _initVizIframes(st.tail);
        if (typeof renderMath === 'function') renderMath(st.tail);
        st.lastTailText = tailText;
      }
    }

    async function sendMessage(options) {
      const input = document.getElementById('userInput');
      const btn = document.getElementById('sendBtn');
      const stopBtn = document.getElementById('stopBtn');
      const text = ((input && input.value.trim()) || pendingQuickText || '').trim();
      pendingQuickText = '';
      const isCasual = _isCasualPrompt(text);
      if (!text || isStreaming) return;
      isStreaming = true;
      const sourceSessionId = currentSessionId;
      try {

      userScrolledUp = false; // 用户发送消息时重置滚动状态

      document.getElementById('welcomeTip')?.remove();

      const now = Date.now();
      // 显式重发（含主线的空元数据）不消费当前待用锚点；点击事件仍走普通发送。
      const branchMeta = options && Object.prototype.hasOwnProperty.call(options, 'resendMeta')
        ? _messageBranchMeta(options.resendMeta)
        : (_consumePendingBranch() || {});
      lastFailedBranchMeta = branchMeta;
      const isSocraticBranchSend = text.startsWith('[苏格拉底回答]') || branchMeta.branchType === 'socratic';
      currentBranch = isSocraticBranchSend ? 'socratic' : null;
      currentBranchId = isSocraticBranchSend && branchMeta.branchId ? branchMeta.branchId : null;
      addMessage('user', text, now, branchMeta);
      const userMessage = { role: 'user', content: text, timestamp: now, ...branchMeta };
      if (isSocraticBranchSend) {
        userMessage.branch = 'socratic';
        userMessage.branchId = userMessage.branchId || currentBranchId;
      }
      chatHistory.push(userMessage);
      await saveCurrentSession();
      if (sourceSessionId !== currentSessionId) return;
      if (input) {
        input.value = '';
        input.style.height = 'auto';
      }
      const localReply = isCasual ? _localCasualReply(text) : '';
      if (localReply) {
        const ts = Date.now();
        const div = addMessage('assistant', localReply, ts);
        streamingAssistant = { role: 'assistant', content: localReply, timestamp: ts, ...branchMeta };
        if (div && typeof renderAssistantContent === 'function') {
          renderAssistantContent(div, localReply).catch(() => {});
        }
        chatHistory.push({ role: 'assistant', content: localReply, timestamp: ts, ...branchMeta });
        await saveCurrentSession();
        renderSessionList();
        if (typeof scrollToBottom === 'function') scrollToBottom();
        return;
      }
      isStreaming = true;
      lastFailedMessage = text;

      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
      streamingAssistant = { role: 'assistant', content: '', timestamp: Date.now(), ...branchMeta };

      // 切换为停止按钮
      if (btn) {
        btn.hidden = false;
        btn.disabled = false;
        btn.classList.add('stop-btn');
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
        btn.onclick = () => { if (abortController) abortController.abort(); };
      }
      if (stopBtn) stopBtn.disabled = false;
      _syncProgressMiniButtons(true);

      abortController = new AbortController();
      // 流式生成是重活（增量渲染 + 画布补丁都在吃帧预算），装饰粒子先让路
      if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(true);
      progressFinalLabel = '';
      showProgress('thinking');
      let assistantContent = '';
      // 推理通道单独攒：思维链**不是**回答正文。混进正文的后果不只是难看——知识提取的
      // v4 闸门（前后端同判 `_looks_like_reasoning_leak`）会把整轮判成「思维链泄漏」而
      // 拒绝提取，这条概念就永远进不了知识库，大陆上也就永远没有这座岛
      // （真机复现：推理模型答「旋度」→ 知识库无旋度 → 大陆无旋度岛）。
      let assistantReasoning = '';
      let assistantDiv = null;
      let streamRenderPending = false;
      let streamRenderFrame = null;
      let streamRenderTimer = null;
      let graphRenderPending = false;
      let graphRenderFrame = null;

      function cancelPendingStreamRender() {
        if (streamRenderFrame !== null) {
          cancelAnimationFrame(streamRenderFrame);
          streamRenderFrame = null;
        }
        if (streamRenderTimer !== null) {
          clearTimeout(streamRenderTimer);
          streamRenderTimer = null;
        }
        if (graphRenderFrame !== null) {
          clearTimeout(graphRenderFrame);
          graphRenderFrame = null;
        }
        streamRenderPending = false;
        graphRenderPending = false;
        if (assistantDiv) _streamRenderStates.delete(assistantDiv);
      }

      try {
        const agentModel = getActiveModelForRole('agent');
        let resp;
        if (agentModel) {
          showProgress('tool', 26, '正在连接 AI 服务');
          resp = await proxyChat(text, currentLevel, SESSION_ID, true, abortController.signal, branchMeta, { quick: isCasual, max_tokens: isCasual ? 300 : undefined });
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
        let profileUsageFromServer = null;   // 后端下发的本次注入快照（角标以此为准）

        function scheduleStreamRender() {
          if (streamRenderPending) return;
          streamRenderPending = true;
          // 节流到 STREAM_RENDER_MIN_INTERVAL：增量渲染后每帧成本已大降，
          // 但长回答时尾块重渲染仍随尾块变大，120ms 对肉眼足够平滑
          const wait = Math.max(0, _lastStreamRenderAt + STREAM_RENDER_MIN_INTERVAL - Date.now());
          const run = () => {
            streamRenderFrame = null;
            streamRenderTimer = null;
            _lastStreamRenderAt = Date.now();
            if (assistantDiv && assistantContent) {
              const messageId = assistantDiv.closest('.message-body')?.dataset.messageId || '';
              _streamRenderTick(assistantDiv, assistantContent, messageId);
              scrollToBottom();
            }
            streamRenderPending = false;
          };
          if (wait === 0) {
            streamRenderFrame = requestAnimationFrame(run);
          } else {
            streamRenderTimer = setTimeout(run, wait);
          }
        }

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
                  // 后端错误帧形如 {error: <状态码数字>, detail: '...'}，对齐 chat-features.js collectStreamText 的读法
                  const errMsg = data.detail || data.error?.detail || data.error?.message || JSON.stringify(data.error);
                  if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
                  assistantContent += '\n\n⚠️ ' + errMsg;
                  assistantDiv.textContent = assistantContent;
                  scrollToBottom();
                  continue;
                }
                if (typeof data.progress === 'number') {
                  const pct = Math.max(progressPercent, data.progress);
                  const label = data.progress >= 30 || currentStage === 'waiting'
                    ? '正在生成回答'
                    : (progressLabel || '正在生成回答');
                  _setProgress(pct, label);
                }
                if (data.profile_usage) {
                  // 本次实际注入了哪些记忆（与后端进 prompt 的内容同源）：
                  // 角标直接用它，不再按前端缓存重算一遍
                  profileUsageFromServer = data.profile_usage;
                  lastChunkTime = Date.now();
                  continue;
                }
                const choice = data.choices?.[0];
                const delta = choice?.delta;
                if (!delta) continue;

                if (delta.role === 'tool') {
                  lastChunkTime = Date.now();
                  if (currentStage !== 'tool') showProgress('tool', Math.max(progressPercent, PROGRESS_PHASE.tool.percent), '正在调用工具');
                  continue;
                }
                if (delta.tool_calls) {
                  lastChunkTime = Date.now();
                  if (currentStage !== 'tool') showProgress('tool', Math.max(progressPercent, PROGRESS_PHASE.tool.percent), '正在调用工具');
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
                        streamingAssistant.content = assistantContent;
                        if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
              assistantDiv.innerHTML = renderMarkdown(stripXmlTags(assistantContent), { parentId: assistantDiv.closest('.message-body')?.dataset.messageId || '', socraticFallback: true });
                        _initVizIframes(assistantDiv);
                        renderMath(assistantDiv);
                        scrollToBottom();
                        scheduleGraphStreamRender();
                      }
                      console.log('[ToolDone] File info:', fileInfo);
                    } catch(e) { console.warn('[ToolDone] Parse error:', e); }
                  }
                  continue;
                }
                if (delta.content || delta.reasoning_content) {
                  lastChunkTime = Date.now();
                  if (currentStage !== 'generating') showProgress('generating', Math.max(progressPercent, PROGRESS_PHASE.generating.percent), '正在生成回答');
                  if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
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
                  // 实时渲染（增量+节流）；滚动跟随并入渲染帧，不再每个 chunk 读一次 scrollHeight
                  scheduleStreamRender();
                  scheduleGraphStreamRender();
                }
              } catch (e) {}
            }
          }
        }

        _setProgress(90, '正在整理回答');

        // 模型只吐了推理通道、正文一个字都没有时退回思维链：宁可显示思维链，也别给一个
        // 空气泡（这种轮次知识提取照旧会被闸门拒收——那是对的，思维链不是知识）
        if (!assistantContent.trim() && assistantReasoning.trim()) {
          assistantContent = assistantReasoning;
        }

        // 最终渲染：优先 XML 标签解析，兜底 heading 正则
        if (assistantDiv && assistantContent) {
          cancelPendingStreamRender();
          streamingAssistant = null;
          _setProgress(92, '正在整理回答');
          if (branchMeta.branchLabel) {
            assistantDiv.dataset.branchLabel = branchMeta.branchLabel;
            assistantDiv.dataset.branchType = branchMeta.branchType || 'branch';
          }
          await renderAssistantContent(assistantDiv, assistantContent);
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

          // 交互可视化缺失时改为后台补齐：先保存/显示主回答，模型生成完成后原地回填。
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
                if (assistantDiv && assistantDiv.isConnected) {
                  renderAssistantContent(assistantDiv, updatedContent).then(() => {
                    if (currentSessionId !== sourceSessionId || !chatHistory.includes(originatingAssistant)) return;
                    // 新消息流式生成期间不主动写服务端，交给下一次保存/定时同步。
                    if (!isStreaming) saveSessionMessages(sourceSessionId, chatHistory);
                    if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
                  }).catch(() => {});
                }
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
          if (!isCasual) autoExtractKnowledge(currentSessionId, chatHistory);

          await saveCurrentSession();
          if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
          renderSessionList(); // 更新侧边栏时间显示
          const metaEl = assistantDiv.closest('.message-body')?.querySelector('.message-meta');
          if (metaEl) {
            const elapsed = progressStartTime ? Date.now() - progressStartTime : 0;
            const durationStr = elapsed > 0 ? `<span class="msg-duration" title="回答耗时">⏱ ${formatDuration(elapsed)}</span>` : '';
            metaEl.innerHTML = `<span>${formatTime(ts)}</span>${durationStr}<button class="regenerate-btn" onclick="regenerateLast()" title="重新生成">🔄</button>`;
            // 画像注入角标：优先按后端下发的本次注入快照展示；没有快照时（本地寒暄
            // 回答、旧服务端）退回按缓存计算。后端 is_quick 要求无 branch_id/graph_path，
            // 所以分支回答（含分支上的寒暄）会照常注入画像，角标不能把分支排除掉
            if (typeof memoryAppendProfileBadge === 'function'
              && (!isCasual || !!(branchMeta && (branchMeta.branchType || branchMeta.branchId)))) {
              memoryAppendProfileBadge(metaEl, profileUsageFromServer);
            }
          }
          if (typeof notifyTaskCompleted === 'function' && duration) {
            notifyTaskCompleted(duration, '回复完成');
          }
          scrollToBottom(); // 最终渲染后滚动
        }

      } catch (err) {
        progressFinalLabel = err.name === 'AbortError' ? '已停止' : '请求失败';
        hideProgress();
        if (err.name === 'AbortError') {
          const abortDuration = progressStartTime ? (Date.now() - progressStartTime) : null;
          if (assistantDiv && assistantContent.trim()) {
            const ts = Date.now();
            streamingAssistant = null;
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
              duration: abortDuration,
              aborted: true,
              ...assistantMeta,
            });
            const metaEl = assistantDiv.closest('.message-body')?.querySelector('.message-meta');
            if (metaEl) {
              if (abortDuration > 0) {
                const durTag = document.createElement('span');
                durTag.className = 'msg-duration';
                durTag.title = '回答耗时';
                durTag.textContent = '⏱ ' + formatDuration(abortDuration);
                metaEl.appendChild(durTag);
              }
              const stopTag = document.createElement('span');
              stopTag.style.cssText = 'color:var(--accent);font-style:italic;';
              stopTag.textContent = '已中止';
              metaEl.appendChild(stopTag);
            }
            await saveCurrentSession();
          } else if (assistantDiv) {
            assistantDiv.closest('.message.assistant')?.remove();
          }
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
        cancelPendingStreamRender();
        if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(false);
        hideProgress();
        isStreaming = false;
        abortController = null;
        // 恢复发送按钮
        if (btn) {
          btn.classList.remove('stop-btn');
          btn.hidden = true;
          btn.disabled = false;
          btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
          btn.onclick = sendMessage;
        }
        if (stopBtn) stopBtn.disabled = true;
        _syncProgressMiniButtons(false);
        streamingAssistant = null;
        if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
        if (pendingDeleteTimestamp) {
          const ts = pendingDeleteTimestamp;
          pendingDeleteTimestamp = null;
          await _performDeleteMessages(ts);
        }
      }
      } catch (err) {
        console.error('Send preparation failed:', err);
        if (typeof showToast === 'function') showToast('发送未完成，请重试');
      } finally {
        isStreaming = false;
      }
    }

    // 移除末尾的用户消息（chatHistory 条目 + DOM 节点）。
    // 重试/重新生成前必须调用：sendMessage 会无条件重新 push 用户消息，
    // 不移除则同一问题在历史中重复出现（并被持久化、进入后续上下文）
    function _popTrailingUserMessage() {
      if (!chatHistory.length || chatHistory[chatHistory.length - 1].role !== 'user') return null;
      const entry = chatHistory.pop();
      const ts = String(entry.timestamp || '');
      if (ts) {
        const body = document.querySelector('#chatMessages .message-body[data-message-id="' + ts + '"]');
        const node = body && body.closest('.message');
        if (node) node.remove();
      }
      return entry;
    }

    function retryLast() {
      if (!lastFailedMessage || isStreaming) return;
      const msgs = document.querySelectorAll('.message.assistant');
      const lastMsg = msgs[msgs.length - 1];
      if (lastMsg && lastMsg.querySelector('.error-actions')) lastMsg.remove();
      // 发送失败时用户消息已入 chatHistory：重发前移除，避免重复
      _popTrailingUserMessage();
      const userInputEl = document.getElementById('userInput');
      if (userInputEl) userInputEl.value = lastFailedMessage;
      // 重发显式携带失败时的分支元数据（主线是空元数据）：不再经由待用锚点传递，
      // 否则用户另外选过锚点时，重试会挂到那个分支上。用户自己的锚点保持不动。
      sendMessage({ resendMeta: lastFailedBranchMeta || {} });
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
      let userMeta = null;
      for (let i = chatHistory.length - 1; i >= 0; i--) {
        if (chatHistory[i].role === 'user') { userMsg = chatHistory[i].content; userMeta = chatHistory[i]; break; }
      }
      if (userMsg) {
        // 重发前移除原用户消息（历史+DOM），sendMessage 会重新 push
        _popTrailingUserMessage();
        lastFailedMessage = userMsg;
        return sendQuick(userMsg, _messageBranchMeta(userMeta));
      }
    }

    function addMessage(role, content, timestamp, branchMeta) {
      const messages = document.getElementById('chatMessages');
      const msg = document.createElement('div');
      msg.className = 'message ' + role;

      const avatar = document.createElement('div');
      avatar.className = 'message-avatar';
      if (role === 'user') { avatar.textContent = '👤'; } else if (role === 'assistant') { avatar.innerHTML = '<img src="/logo.png" alt="PhyMathia">'; }
      const body = document.createElement('div');
      body.className = 'message-body';
      body.dataset.messageId = String(timestamp || Date.now());

      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';
      if (role === 'user') {
        contentDiv.textContent = content;
      } else if (content) {
        contentDiv.innerHTML = renderMarkdown(content, { parentId: String(timestamp || ''), socraticFallback: true });
        _initVizIframes(contentDiv);
      }
      const metaObj = branchMeta || {};
      if (metaObj.branchLabel) {
        contentDiv.dataset.branchLabel = metaObj.branchLabel;
        contentDiv.dataset.branchType = metaObj.branchType || 'branch';
        if (role === 'user') {
          const tag = document.createElement('div');
          tag.className = 'branch-tag ' + (metaObj.branchType || 'branch');
          tag.textContent = metaObj.branchLabel;
          contentDiv.prepend(tag);
        }
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
        bookmarkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';
        bookmarkBtn.onclick = function() {
          openBookmarkModal(this);
        };
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
      if (messages) messages.appendChild(msg);
      scrollToBottom();
      return contentDiv;
    }

