// ===== PhyMathia 对话核心：进度指示与分支/苏格拉底流式发送 =====
// 2026-09-25 线性主聊天退役：sendMessage 瘦身为「强制带画布锚点的分支/苏格拉底
// 传输通道」——无锚请求一律拒绝；新话题提问走工作流 startQuestionWorkflow。
// 流式内容经 streamingAssistant 直驱画布节点（graph-data.js 读 getStreamingAssistant），
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
    // 生成速度读数（2026-11-23）：流式过程中按字数估算，结束帧带 usage 时换精确值。
    let _streamMeter = null;
    // 显示读数开关（2026-11-24）：设置→显示读数写入，读侧缓存成对象，
    // 500ms 的渲染循环不再碰 localStorage；开关变化由 applyProgressReadoutPrefs 刷新。
    // 五个键与 config.js 的 STORAGE_KEY_READOUT_* 一字对应（本文件在阶段0夹具里
    // 单独执行、不加载 config.js，故这里不引用常量）。
    let _readoutPrefs = { speed: true, ttft: true, elapsed: true, progress: true, percent: true };

    function applyProgressReadoutPrefs() {
      const enabled = (key) => {
        try {
          if (typeof progressReadoutEnabled === 'function') return progressReadoutEnabled(key);
        } catch (e) {}
        return true;
      };
      _readoutPrefs = {
        speed: enabled('phymathia_readout_speed'),
        ttft: enabled('phymathia_readout_ttft'),
        elapsed: enabled('phymathia_readout_elapsed'),
        progress: enabled('phymathia_readout_progress'),
        percent: enabled('phymathia_readout_percent')
      };
      const statusEl = document.getElementById('progressStatus');
      if (statusEl && statusEl.classList) {
        statusEl.classList.toggle('readout-off-speed', !_readoutPrefs.speed);
        statusEl.classList.toggle('readout-off-ttft', !_readoutPrefs.ttft);
        statusEl.classList.toggle('readout-off-elapsed', !_readoutPrefs.elapsed);
        statusEl.classList.toggle('readout-off-progress', !_readoutPrefs.progress);
      }
      // 百分比拼在状态文字里，CSS 管不到，立即按新开关重画一次；速度读数同理。
      try { _setProgress(progressPercent, progressLabel); } catch (e) {}
      try { _streamMeterRender(); } catch (e) {}
      try {
        if (typeof window._taskPanelDockFollow === 'function') window._taskPanelDockFollow();
      } catch (e) {}
    }
    window.applyProgressReadoutPrefs = applyProgressReadoutPrefs;

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
        const suffix = _readoutPrefs.percent && progressPercent > 0 && progressPercent < 100 ? ' · ' + progressPercent + '%' : '';
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
        _streamMeterClearText();
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
      _streamMeterRender();
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
          _streamMeterClearText();
          progressStatusHideTimer = null;
        }, 1500);
      }
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    }

    // T17①（2026-10-05 拍板）：终态文案复活到胶囊——已停止/请求失败/可视化已生成
    // 停在这里当 idle 文案，直到下一次 showProgress 被新进度覆盖；闲时默认仍是「待命」（D3）
    function setProgressTerminal(label) {
      if (progressStatusHideTimer) { clearTimeout(progressStatusHideTimer); progressStatusHideTimer = null; }
      progressHidden = true;
      const statusEl = document.getElementById('progressStatus');
      if (statusEl) statusEl.classList.remove('active');
      if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
      _setProgress(100, label);
      const timeEl = document.querySelector('#progressStatus .elapsed-time');
      if (timeEl) timeEl.textContent = '';
      _streamMeterClearText();
    }
    window.setProgressTerminal = setProgressTerminal;

    // ===== 生成速度读数（2026-11-23，用户拍板只在胶囊）=====
    // 过程中拿不到真实 token 数：按已收到的字数估（中文 1 字≈1 token，ASCII 4 字符≈1 token），
    // 标 ≈；上游结束帧带 usage.completion_tokens 时，收尾换成精确值（不标 ≈）。
    // 计时窗取「首片→末片」，不含排队与提示词处理；首片到达后先亮 1 秒多「首字 Xs」，
    // 再切速率，避免开头两拍数字乱跳。工作流多路并行时这里是合计吞吐。
    const STREAM_TTFT_GAP_MS = 1200;
    const STREAM_TTFT_MIN_SEC = 0.1;
    const STREAM_RATE_MIN_SEC = 0.4;

    function _streamSpeedEl() {
      return document.querySelector('#progressStatus .stream-speed');
    }

    function _estimateStreamTokens(text) {
      const s = String(text || '');
      let cjk = 0;
      let ascii = 0;
      for (let i = 0; i < s.length; i++) {
        if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(s[i])) cjk++;
        else ascii++;
      }
      return cjk + ascii / 4;
    }

    function _formatStreamSpeed(tps, exact) {
      const n = Number(tps);
      if (!Number.isFinite(n) || n <= 0) return '';
      const shown = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
      return (exact ? '' : '≈') + shown + ' tok/s';
    }

    function _streamMeterState() {
      if (!_streamMeter) {
        _streamMeter = {
          active: 0,
          startedAt: 0,
          firstDeltaAt: 0,
          lastDeltaAt: 0,
          liveTokens: 0,
          usageTokens: 0,
          usageStreams: 0,
          finishedStreams: 0,
          finalText: '',
        };
      }
      return _streamMeter;
    }

    function _streamMeterSetText(text) {
      const el = _streamSpeedEl();
      if (el) el.textContent = text || '';
    }

    function _streamMeterClearText() {
      if (_streamMeter) _streamMeter.finalText = '';
      _streamMeterSetText('');
    }

    // 胶囊不在进行态（例如工坊试跑、后台 viz）就不记：读数属于前台胶囊。
    function _streamMeterBegin() {
      const statusEl = document.getElementById('progressStatus');
      if (!statusEl || !statusEl.classList || !statusEl.classList.contains('active')) return null;
      const m = _streamMeterState();
      if (!m.active) {
        m.startedAt = Date.now();
        m.firstDeltaAt = 0;
        m.lastDeltaAt = 0;
        m.liveTokens = 0;
        m.usageTokens = 0;
        m.usageStreams = 0;
        m.finishedStreams = 0;
        m.finalText = '';
        _streamMeterSetText('');
      }
      m.active += 1;
      return { ended: false, usage: 0, hasUsage: false };
    }

    function _streamMeterAdd(handle, text) {
      if (!handle || handle.ended || !text) return;
      const tokens = _estimateStreamTokens(text);
      if (tokens <= 0) return;
      const m = _streamMeterState();
      const now = Date.now();
      if (!m.firstDeltaAt) m.firstDeltaAt = now;
      m.lastDeltaAt = now;
      m.liveTokens += tokens;
    }

    // 正文与思维链都算生成量（只用于读数，不改变「思维链不进正文」的通道口径）。
    function _streamMeterAddDelta(handle, delta) {
      if (!handle || !delta) return;
      if (delta.content) _streamMeterAdd(handle, delta.content);
      if (delta.reasoning_content) _streamMeterAdd(handle, delta.reasoning_content);
    }

    function _streamMeterUsage(handle, usage) {
      if (!handle || handle.ended || !usage) return;
      const n = Number(usage.completion_tokens);
      if (!Number.isFinite(n) || n <= 0) return;
      handle.usage = n;
      handle.hasUsage = true;
    }

    function _streamMeterEnd(handle) {
      if (!handle || handle.ended) return;
      handle.ended = true;
      const m = _streamMeter;
      if (!m) return;
      m.active = Math.max(0, m.active - 1);
      m.finishedStreams += 1;
      if (handle.hasUsage) {
        m.usageStreams += 1;
        m.usageTokens += handle.usage;
      }
      if (m.active > 0) return;
      const secs = (m.lastDeltaAt - m.firstDeltaAt) / 1000;
      if (!m.liveTokens || !(secs >= STREAM_RATE_MIN_SEC)) {
        m.finalText = '';
        _streamMeterSetText('');
        return;
      }
      // 只有「每条流都报了 usage」才用精确值；缺一条就退回估算，别拿半截分母冒充精确。
      const exact = m.usageStreams === m.finishedStreams && m.usageTokens > 0;
      m.finalText = _formatStreamSpeed((exact ? m.usageTokens : m.liveTokens) / secs, exact);
      _streamMeterSetText(_readoutPrefs.speed ? m.finalText : '');
    }

    function _streamMeterRender(now) {
      const m = _streamMeter;
      if (!m) return '';
      const ts = Number.isFinite(now) ? now : Date.now();
      let text = '';
      if (m.active > 0) {
        if (m.firstDeltaAt) {
          const ttft = Math.max(0, m.firstDeltaAt - m.startedAt) / 1000;
          // 工作流的读流从响应头到达才开始计，首字常是 0.0s——那种「假首字」不亮，
          // 直接等速率；真等过模型的（分支/苏格拉底）才值得看这一眼。
          if (_readoutPrefs.ttft && ttft >= STREAM_TTFT_MIN_SEC && ts - m.firstDeltaAt < STREAM_TTFT_GAP_MS) {
            text = '首字 ' + (ttft < 10 ? ttft.toFixed(1) : String(Math.round(ttft))) + 's';
          } else if (_readoutPrefs.speed) {
            const secs = (m.lastDeltaAt - m.firstDeltaAt) / 1000;
            if (m.liveTokens > 0 && secs >= 0.2) {
              text = _formatStreamSpeed(m.liveTokens / secs, false);
            }
          }
        }
      } else {
        text = _readoutPrefs.speed ? (m.finalText || '') : '';
      }
      _streamMeterSetText(text);
      return text;
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
      // 面板停靠在胶囊下沿，胶囊一动就得重新贴一次，否则一拖就脱钩（tasks.js 提供）。
      let followQueued = false;
      const followDock = () => {
        if (followQueued) return;
        followQueued = true;
        const raf = (window.requestAnimationFrame || (fn => setTimeout(fn, 16)));
        raf(() => {
          followQueued = false;
          if (typeof window._taskPanelDockFollow === 'function') window._taskPanelDockFollow();
        });
      };
      const onMove = (e) => {
        if (!dragging) return;
        const nextX = Math.max(4, Math.min(window.innerWidth - status.offsetWidth - 4, originX + e.clientX - startX));
        const nextY = Math.max(4, Math.min(window.innerHeight - status.offsetHeight - 4, originY + e.clientY - startY));
        status.classList.add('dragged');
        status.style.left = nextX + 'px';
        status.style.top = nextY + 'px';
        status.style.transform = 'none';
        followDock();
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        status.classList.remove('dragging');
        followDock();   // 最后一帧对齐，别停在半格上
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
    applyProgressReadoutPrefs();

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

    // ====== 画布直驱流式：内容写入 streamingAssistant，graph-workflow-stream.js 定时取走渲染 ======

    // force 仅供排队重放使用：flush 时把之前抓下来的正文与锚点还原成全局态再走一遍
    // 正常路径，而不是另开一条发送实现——这样各入口原有的收尾动作一处不漏。
    async function sendMessage(force) {
      // 只读查阅（P3）：普通发送/追问/苏格拉底回答共用这条发送链，入口一处拦全
      if (phyIsReadonly()) { phyReadonlyBlock('发送消息'); return; }
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
      // 忙碌兜底（T42）：正常入口——苏格拉底回答/给点提示/看讲解/追问——
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
      // T315：请求要带的会话号当场抓一份。过去 365 行现场读 SESSION_ID——它离
      // saveCurrentSession 的 await 只差几行，保存空窗里切画布的话请求会带上另一张
      // 画布的 session_id，服务端上下文串画布（落盘不受影响，按 sourceSessionId）。
      const sendSessionId = (typeof SESSION_ID !== 'undefined') ? SESSION_ID : '';
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
      // T205：一轮回答原本发送/成功/finally 三连全量重建（innerHTML 清空＋全节点
      // markdown/KaTeX 重跑），成功后 finally 那发与成功那发之间画布输入零变化，纯浪费。
      let canvasRenderedThisRound = false;
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
      // 2026-10-11：这里过去是 `if (sourceSessionId !== currentSessionId) return;`——
      // 「你切画布了，这轮就算了」。现在生成中允许切画布（switchToSession 不再拦），
      // 所以改成**自带来处**：这条流写回 sourceSessionId 那张画布，用户切到哪儿都不影响它。
      // renderGraphCanvas 也照旧发——画布按会话取消息，别的画布不会看见这条未完的回答
      // （_getChatHistory 按 streamingAssistant.sessionId 过滤）。

      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
      // sessionId 记的是这条流**属于哪张画布**：画布渲染据此决定要不要把它当幽灵节点画出来
      streamingAssistant = { role: 'assistant', content: '', timestamp: Date.now(), sessionId: sourceSessionId, ...branchMeta };

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
      let streamMeter = null;
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
          streamMeter = _streamMeterBegin();
          // 寒暄快捷通道已随线性主聊天退役：分支/苏格拉底请求一律走完整回答路径，
          // 不再带 quick/max_tokens（此前这里引用了未定义的 isCasual，请求发出前即抛 ReferenceError）
          resp = await proxyChat(text, currentLevel, sendSessionId, true, abortController.signal, branchMeta);
          if (!resp) throw new Error('无法连接到 AI 服务');
        } else {
          if (typeof showToast === 'function') showToast('未配置 AI 模型，请在模型设置中配置');
          throw new Error('未配置 AI 模型，请在模型设置中配置');
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
                  if (data.usage) _streamMeterUsage(streamMeter, data.usage);
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
                    _streamMeterAddDelta(streamMeter, delta);
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

        _streamMeterEnd(streamMeter);
        streamMeter = null;
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
          // 2026-10-11：**按会话寻址**地落这条回答。用户可能在生成期间切到别的画布上去了
          // （switchToSession 现在不拦），直接 chatHistory.push 会把回答写进别人家的画布——
          // 那正是过去拿 isStreaming 锁住切画布的原因。appendMessageToSession 在
          // 「还在原来那张」时走内存数组，切走了就按会话读—追—存（session.js）。
          const assistantMessage = {
            role: 'assistant',
            content: assistantContent,
            timestamp: ts,
            duration,
            ...assistantMeta,
          };
          const stillHere = sourceSessionId === currentSessionId;
          if (typeof appendMessageToSession === 'function') {
            await appendMessageToSession(sourceSessionId, assistantMessage);
          } else if (stillHere) {
            // 兜底只兜「还在原来那张」：宁可不写，也不把回答塞进别人家的画布
            chatHistory.push(assistantMessage);
          }

          // 交互可视化缺失时后台补齐：先保存/展示主回答，模型生成完成后回填。
          // （stage2 源码审计按字符串定位本回调与 sourceSessionId 行，改结构前先看
          // scripts/review_stage2_frontend.mjs 的 F 审计段）
          if (typeof scheduleVisualizationInBackground === 'function') {
            // T281：回填按会话寻址。过去人切走（currentSessionId 已不等于
            // sourceSessionId）整段丢弃，这条回答从此没有可视化；现在交给
            // updateMessageInSession——人在原地改内存里这条，切走了读原画布自己的
            // 消息按「时间戳＋原文」写回，目标已删/已重生成时它自己丢弃。
            scheduleVisualizationInBackground(assistantContent, async (updatedContent) => {
              try {
                await updateMessageInSession(sourceSessionId, ts, assistantContent, updatedContent);
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
                // 记录也按会话寻址：这条回答属于 sourceSessionId，不是用户现在看的那张
                sessionId: sourceSessionId || ((typeof currentSessionId !== 'undefined' ? currentSessionId : SESSION_ID) || ''),
                level: lm ? lm[1] : '',
              });
            }
          }

          // 先生成本地知识条目，消息上传继续在后台进行。
          // 知识也必须记在**它自己那张画布**上：切走之后若还按当前会话写，这条概念会
          // 出现在用户后来切到的那张画布的知识库里（而正文根本不在那儿）。
          _setProgress(98, '正在提取知识');
          if (stillHere) {
            autoExtractKnowledge(sourceSessionId, chatHistory);
          } else if (typeof appendMessageToSession === 'function') {
            // 已由 appendMessageToSession 落盘；知识提取按该会话自己的那份消息跑
            autoExtractKnowledge(sourceSessionId, loadSessionMessages(sourceSessionId));
          }

          if (stillHere) await saveCurrentSession();
          // T205：这里已把流式补丁态同步成终态（chatHistory 刚落完整回答、streamingAssistant
          // 已置 null，_getChatHistory 两次输入相同），记标志让 finally 跳过重复的那发。
          // stillHere（2026-10-11）：人已经切到别的画布上时就别拿这条回答去重建人家的画布了，
          // 让 finally 照常兜底那一次即可；这一行连写两句的格式被冒烟脚本按字符串钉着
          // （scripts/frontend_smoke/serial-canvas-answer.mjs 的 T205 契约），别拆行。
          if (stillHere && typeof window.renderGraphCanvas === 'function') { window.renderGraphCanvas(); canvasRenderedThisRound = true; }
          renderSessionList(); // 更新侧边栏时间显示
          // 队列里还有东西时不弹「完成」：这一轮只是**这一轮**完了，活儿没干完，
          // 弹完成卡片是骗人，而且下一条马上自动发出去，卡片会跟新进度撞在一起。
          if (typeof notifyTaskCompleted === 'function' && duration
              && !(typeof _hasPendingSend === 'function' && _hasPendingSend())) {
            notifyTaskCompleted(duration, '回复完成');
          }
        }

      } catch (err) {
        _streamMeterEnd(streamMeter);
        streamMeter = null;
        hideProgress();
        sendTaskState = err.name === 'AbortError' ? 'stopped' : 'error';
        sendTaskNote = err.name === 'AbortError' ? '手动停止' : (err.message || '发送失败');
        setProgressTerminal(err.name === 'AbortError' ? '已停止' : '请求失败');
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
            // 中止时留下的半截回答同样按会话寻址（用户可能已经切到别的画布上按的停止）
            const abortedMessage = {
              role: 'assistant',
              content: assistantContent,
              timestamp: ts,
              duration: progressStartTime ? (Date.now() - progressStartTime) : null,
              aborted: true,
              ...assistantMeta,
            };
            if (sourceSessionId === currentSessionId) {
              chatHistory.push(abortedMessage);
              await saveCurrentSession();
            } else if (typeof appendMessageToSession === 'function') {
              await appendMessageToSession(sourceSessionId, abortedMessage);
            }
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
        // T205：只兜成功路径没走到的分支（失败/中止/空回复/切会话早退）——失败与空回复
        // 还要靠这发把残留的流式卡从画布摘掉；成功路径重复渲染已在上面跳过
        if (!canvasRenderedThisRound && typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
        if (pendingDeleteTimestamp) {
          const ts = pendingDeleteTimestamp;
          pendingDeleteTimestamp = null;
          // T315：补删按会话寻址——生成途中切了画布的话，chatHistory 已是别人家的数组
          await _performDeleteMessages(ts, sourceSessionId);
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

