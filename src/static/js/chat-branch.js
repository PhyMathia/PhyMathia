// ===== PhyMathia 对话分支：苏格拉底追问、分支探索与删除（含 window 导出）=====

    var pendingSocraticNewLoop = false;
    var pendingSocraticConfidence = 'ok';
    var pendingSocraticPosition = null;
    var pendingSocraticFromPort = '';
    function clearBranchAnchor() {
      setActiveBranchAnchor(null);
    }

    function sendBranchQuick(text, anchor) {
      setActiveBranchAnchor(anchor || null);
      sendQuick(text);
    }

    function _consumePendingBranch() {
      const anchor = activeBranchAnchor ? { ...activeBranchAnchor } : null;
      if (anchor && !anchor.graphPath && typeof window.buildGraphPathForAnchor === 'function') {
        anchor.graphPath = window.buildGraphPathForAnchor(anchor);
      }
      setActiveBranchAnchor(null);
      return anchor;
    }

    function _socraticLevelLabel(level) {
      return level === 'advanced' ? '进阶' : level === 'expand' ? '拓展' : '基础';
    }

    function startSocraticAnswer(question, level, parentMsg, sourceModule, posX, posY, fromPort) {
      pendingSocraticQuestion = question || '';
      pendingSocraticLevel = level || 'basic';
      pendingSocraticParentMsg = parentMsg || '';
      pendingSocraticSourceModule = sourceModule || 'extend';
      pendingSocraticConfidence = 'ok';
      pendingSocraticPosition = (Number.isFinite(posX) && Number.isFinite(posY)) ? { x: posX, y: posY } : null;
      // 记录来源端口：画布从苏格拉底问题端口发起时，回答完成后新节点要连回同一端口
      pendingSocraticFromPort = fromPort || '';
      // 若当前已有未结束的苏格拉底闭环，沿用同一分支，保证连对次数与上下文跨轮连续
      pendingSocraticNewLoop = !(currentBranch === 'socratic' && currentBranchId);
      pendingSocraticBranchId = pendingSocraticNewLoop ? _genBranchId() : currentBranchId;
      const modal = document.getElementById('socraticModal');
      const questionEl = document.getElementById('socraticModalQuestion');
      const answerEl = document.getElementById('socraticModalAnswer');
      if (!modal || !questionEl || !answerEl) return;
      questionEl.textContent = pendingSocraticQuestion;
      answerEl.value = '';
      modal.hidden = false;
      modal.classList.add('active');
      document.querySelectorAll('.socratic-confidence button').forEach(function(btn) {
        btn.classList.toggle('active', btn.dataset.socraticConfidence === pendingSocraticConfidence);
      });
      setTimeout(() => answerEl.focus(), 50);
    }

    function closeSocraticModal() {
      const modal = document.getElementById('socraticModal');
      if (modal) {
        modal.hidden = true;
        modal.classList.remove('active');
      }
      pendingSocraticQuestion = '';
      pendingSocraticLevel = 'basic';
      pendingSocraticSourceModule = 'extend';
      pendingSocraticPosition = null;
      pendingSocraticFromPort = '';
    }

    function setSocraticConfidence(value, btn) {
      pendingSocraticConfidence = value || 'ok';
      document.querySelectorAll('.socratic-confidence button').forEach(function(b) {
        b.classList.toggle('active', b === btn);
      });
    }

    async function submitSocraticAnswer() {
      if (isStreaming || socraticSubmitting || !pendingSocraticQuestion) return;
      const answerEl = document.getElementById('socraticModalAnswer');
      const answer = answerEl ? answerEl.value.trim() : '';
      if (!answer) {
        answerEl?.focus();
        return;
      }
      const levelLabel = pendingSocraticLevel === 'advanced' ? '进阶' : pendingSocraticLevel === 'expand' ? '拓展' : '基础';
      const confidenceLabel = pendingSocraticConfidence === 'confident' ? '很有把握' : pendingSocraticConfidence === 'guess' ? '猜的' : '一般';
      const message = '[苏格拉底回答]\n追问等级：' + levelLabel + '\n把握程度：' + confidenceLabel + '\n追问问题：' + pendingSocraticQuestion + '\n我的回答：' + answer;
      const branchId = pendingSocraticBranchId || _genBranchId();
      const socraticPosition = pendingSocraticPosition ? { ...pendingSocraticPosition } : null;
      socraticSubmitting = true;
      try {
        if (branchId && pendingSocraticNewLoop) {
          const state = {
            active: true,
            level: pendingSocraticLevel,
            question: pendingSocraticQuestion,
            correctStreak: 0,
            answeredCount: 0,
            updatedAt: Date.now(),
          };
          try {
            await fetch('/api/kv/' + encodeURIComponent('socratic:' + branchId), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ value: state }),
            });
          } catch (err) {
            console.warn('Failed to start Socratic state:', err);
          }
        }
        closeSocraticModal();
        pendingSocraticNewLoop = false;
        currentBranch = 'socratic';
        currentBranchId = branchId;
        setActiveBranchAnchor({
          parentId: pendingSocraticParentMsg,
          sourceModule: pendingSocraticSourceModule,
          branchType: 'socratic',
          branchId,
          ...(pendingSocraticFromPort ? { fromPort: pendingSocraticFromPort } : {}),
          branchLabel: '苏格拉底：' + (pendingSocraticLevel === 'advanced' ? '进阶' : pendingSocraticLevel === 'expand' ? '拓展' : '基础'),
          ...(socraticPosition ? { position: socraticPosition } : {}),
        });
        sendQuick(message);
      } finally {
        socraticSubmitting = false;
      }
    }

    function _socraticExitMessage(prefix, level, question) {
      const levelLabel = _socraticLevelLabel(level);
      return prefix + '\n追问等级：' + levelLabel + '\n追问问题：' + question;
    }

    function startSocraticHint(question, level, parentMsg, sourceModule) {
      if (isStreaming) return;
      const message = _socraticExitMessage('[苏格拉底提示]', level, question);
      const reuse = currentBranch === 'socratic' && currentBranchId;
      setActiveBranchAnchor({
        parentId: parentMsg || '',
        sourceModule: sourceModule || 'extend',
        branchType: 'socratic',
        branchId: reuse ? currentBranchId : _genBranchId(),
        branchLabel: '苏格拉底提示',
      });
      sendQuick(message);
    }

    function startSocraticExplain(question, level, parentMsg, sourceModule) {
      if (isStreaming) return;
      const message = _socraticExitMessage('[苏格拉底讲解]', level, question);
      const reuse = currentBranch === 'socratic' && currentBranchId;
      setActiveBranchAnchor({
        parentId: parentMsg || '',
        sourceModule: sourceModule || 'extend',
        branchType: 'socratic',
        branchId: reuse ? currentBranchId : _genBranchId(),
        branchLabel: '苏格拉底讲解',
      });
      sendQuick(message);
    }

    function resetSocraticBranch() {
      currentBranch = null;
      currentBranchId = null;
      setActiveBranchAnchor(null);
    }

    let pendingBranchModal = null;

    function openBranchModal(title, question, anchor) {
      pendingBranchModal = anchor || null;
      const modal = document.getElementById('branchModal');
      const titleEl = document.getElementById('branchModalTitle');
      const textEl = document.getElementById('branchModalText');
      if (!modal || !titleEl || !textEl) return;
      titleEl.textContent = title || '追问';
      textEl.value = question || '';
      modal.hidden = false;
      modal.classList.add('active');
      setTimeout(() => textEl.focus(), 50);
    }

    function closeBranchModal() {
      const modal = document.getElementById('branchModal');
      if (modal) {
        modal.hidden = true;
        modal.classList.remove('active');
      }
      pendingBranchModal = null;
    }

    function submitBranchModal() {
      const textEl = document.getElementById('branchModalText');
      const text = textEl ? textEl.value.trim() : '';
      if (!text) {
        textEl?.focus();
        return;
      }
      const anchor = pendingBranchModal;
      closeBranchModal();
      if (anchor && typeof window.sendBranchQuick === 'function') {
        window.sendBranchQuick(text, anchor);
      } else if (typeof showToast === 'function') {
        // 2026-09-25 线性主聊天退役：无锚兜底发送已删——所有分支请求必须带锚
        showToast('追问丢失锚点，请在画布节点上重试');
      }
    }

    document.getElementById('branchModalText')?.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        submitBranchModal();
      }
    });

    let pendingDeleteTimestamp = null;

    async function _performDeleteMessages(timestamps) {
      const targets = Array.isArray(timestamps)
        ? timestamps.map(String).filter(Boolean)
        : [String(timestamps || '')];
      if (!targets.length) return;
      const removed = new Set(targets);
      for (const target of targets) {
        const targetIndex = chatHistory.findIndex(msg => String(msg.timestamp || '') === target);
        if (targetIndex >= 0 && chatHistory[targetIndex].role === 'user') {
          for (let i = targetIndex + 1; i < chatHistory.length; i++) {
            if (chatHistory[i].role === 'assistant') {
              removed.add(String(chatHistory[i].timestamp || ''));
            } else {
              break;
            }
          }
        }
      }
      let changed = true;
      while (changed) {
        changed = false;
        const next = [];
        for (const msg of chatHistory) {
          const ts = String(msg.timestamp || '');
          const parent = String(msg.parentId || '');
          if (removed.has(ts) || removed.has(parent)) {
            if (!removed.has(ts)) removed.add(ts);
            changed = true;
            continue;
          }
          next.push(msg);
        }
        chatHistory = next;
      }
      await saveCurrentSession();
      renderSessionList();
      await renderCurrentChat();
    }

    function deleteGraphMessageByTimestamp(timestamp) {
      if (isStreaming) {
        pendingDeleteTimestamp = String(timestamp || '');
        if (abortController) abortController.abort();
        return;
      }
      return _performDeleteMessages(timestamp);
    }

    function deleteGraphMessagesByTimestamps(timestamps) {
      const list = Array.from(timestamps || []).map(String).filter(Boolean);
      if (!list.length) return Promise.resolve();
      if (isStreaming) {
        pendingDeleteTimestamp = list;
        if (abortController) abortController.abort();
        return Promise.resolve();
      }
      return _performDeleteMessages(list);
    }

    document.getElementById('socraticModalAnswer')?.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submitSocraticAnswer();
      }
    });

    window.getCurrentProgress = () => progressPercent;
    window.setActiveBranchAnchor = setActiveBranchAnchor;
    window.clearBranchAnchor = clearBranchAnchor;
    window.sendBranchQuick = sendBranchQuick;
    window.sendQuick = sendQuick;
    window.openBranchModal = openBranchModal;
    window.closeBranchModal = closeBranchModal;
    window.submitBranchModal = submitBranchModal;
    window.deleteGraphMessageByTimestamp = deleteGraphMessageByTimestamp;
    window.deleteGraphMessagesByTimestamps = deleteGraphMessagesByTimestamps;
    window.getChatHistory = () => chatHistory.slice();
    window.replaceChatHistory = async (messages) => {
      chatHistory = Array.isArray(messages) ? JSON.parse(JSON.stringify(messages)) : [];
      await saveCurrentSession();
      renderSessionList();
      await renderCurrentChat();
    };
    window.getStreamingAssistant = () => streamingAssistant;
    window.stopGeneration = stopGeneration;
    window.startSocraticAnswer = startSocraticAnswer;
    window.setSocraticConfidence = setSocraticConfidence;
    window.startSocraticHint = startSocraticHint;
    window.startSocraticExplain = startSocraticExplain;
    window.closeSocraticModal = closeSocraticModal;
    window.submitSocraticAnswer = submitSocraticAnswer;
    window.resetSocraticBranch = resetSocraticBranch;

    // URL 参数自动提问（2026-09-25 起走工作流：原线性 sendQuick 通道已随
    // 线性主聊天退役，产出从单条聊天回答变为画布工作流分析+模块卡片）
    (function() {
      const params = new URLSearchParams(window.location.search);
      const question = params.get('question');
      if (question) {
        window.history.replaceState({}, '', window.location.pathname);
        setTimeout(() => {
          if (typeof window.startQuestionWorkflow === 'function') {
            window.startQuestionWorkflow(decodeURIComponent(question));
          }
        }, 500);
      }
    })();
