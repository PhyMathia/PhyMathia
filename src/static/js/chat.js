    // ====== 进度指示器 ======
    let progressTimer = null;
    let waitingTipTimer = null;
    let progressStartTime = 0;
    let lastChunkTime = 0;
    let currentStage = '';
    let streamingAssistant = null;

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

    function buildFormulaTags(content, formulas) {
      const sections = parseXmlSections(content);
      const result = {};
      for (const formula of formulas) {
        const stripped = _stripFormulaDelimiters(formula);
        const tags = [];
        if ((sections.physics || '').includes(stripped)) tags.push('物理');
        if ((sections.math || '').includes(stripped)) tags.push('数学');
        if (tags.length) result[formula] = tags;
      }
      return result;
    }

    function describeFormula(latex, summary, concept) {
      const clean = _stripFormulaDelimiters(_normalizeFormulaLatex(latex))
        .replace(/\s+/g, ' ')
        .trim();
      const rules = [
        [/(\\sum|\\int).*e\^/i, '傅里叶级数/变换：用指数基元把信号分解为频率成分'],
        [/\\sum/, '傅里叶级数：用离散频率谐波叠加表示周期信号'],
        [/\\int/, '傅里叶变换：把信号分解为连续频率分量的积分表示'],
        [/^F\s*=\s*-?\s*k\s*x/, '胡克定律：回复力与位移大小成正比、方向相反'],
        [/^T\s*=\s*2\\pi\\sqrt\{\\frac\{m\}\{k\}\}/, '简谐运动周期由质量与劲度系数决定'],
        [/^f\s*=\s*1\s*\/\s*T/, '频率是周期的倒数'],
        [/\\omega\s*=\s*\\sqrt\{\\frac\{k\}\{m\}\}/, '角频率由劲度系数与质量共同决定'],
        [/E\s*=\s*\\frac\{1\}\{2\}kA\^2/, '简谐运动总机械能与振幅平方成正比'],
        [/v\(t\).*\\sin/, '速度随时间呈正弦变化，相位落后于位移'],
        [/a\(t\).*\\omega\^2.*x/, '加速度与位移反向且成正比'],
        [/x\(t\).*\\cos/, '位移随时间余弦变化，A 为振幅'],
        [/\\frac\{d\^2x\}\{dt\^2\}.*\\omega\^2.*x/, '二阶线性微分方程：加速度与位移成正比且反向'],
      ];
      for (const [regex, description] of rules) {
        if (regex.test(clean)) return description;
      }
      if (concept && concept !== '相关公式') {
        const cleanConcept = String(concept)
          .replace(/的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$/, '')
          .trim();
        return `${cleanConcept}相关公式：用于描述${cleanConcept}的定量关系`;
      }
      return '该公式用于描述物理量之间的定量关系';
    }

    function _isSocraticFollowup(content) {
      const text = String(content || '');
      if (!/<socratic_meta\b/i.test(text)) return false;
      return !/(<physics>|<math>|<graph>|<extend>|PhyMathia\s*学习卡片)/i.test(text);
    }

    function extractLocalKnowledge(messages) {
      const assistant = [...messages].reverse().find(message =>
        message.role === 'assistant' && (message.content || '').trim()
      );
      if (!assistant) return [];

      const content = String(assistant.content || '');
      if (_isSocraticFollowup(content)) return [];
      if (assistant.branchType && ['followup', 'confused', 'socratic'].includes(assistant.branchType)) return [];
      const formulas = extractLocalFormulas(content);
      const formulaTags = buildFormulaTags(content, formulas);
      const allTitles = [...content.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)]
        .map(match => match[1].trim())
        .filter(Boolean);
      const moduleHeading = /(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向|学习方向)/;
      const usefulTitles = allTitles.filter(title => !moduleHeading.test(title));
      const cardTitle = usefulTitles.find(title => /PhyMathia\s*学习卡片/.test(title));
      let title = (cardTitle || usefulTitles[0] || '')
        .replace(/^.*?PhyMathia\s*学习卡片\s*[:：]\s*/i, '')
        .replace(/的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向)$/, '')
        .replace(/的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$/, '')
        .replace(/^[🔬📐🧠💡🗺️]+\s*/, '')
        .trim();
      if (!title) {
        const fallbackText = content
          .replace(/<[^>]+>/g, ' ')
          .replace(/^\s*#{1,3}\s*(?:[🔬📐🧠💡🗺️]+\s*)?(?:物理视角|数学视角|物理直觉|数学本质|知识图谱|延伸思考)\s*/, '')
          .replace(/\s+/g, ' ')
          .trim();
        const conceptMatch = fallbackText.match(/^([^，。；、]{2,24})是/);
        title = conceptMatch ? conceptMatch[1] : fallbackText.slice(0, 40);
      }
      if (!title) return [];

      const sample = content.slice(0, 2000);
      const hasMath = /(方程|函数|导数|积分|矩阵|几何|代数|微分|定理|证明|数学)/.test(sample);
      const hasPhysics = /(物理|力学|电磁|光学|热|振动|波|场|力|能量|实验)/.test(sample);
      const category = hasPhysics && !hasMath ? 'physics' : hasMath && !hasPhysics ? 'math' : hasMath ? 'math' : 'other';
      const summaryMatch = content.match(/<summary>([\s\S]*?)<\/summary>/i);
      const summary = (summaryMatch ? summaryMatch[1] : content)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      let mathTagCount = 0;
      let physicsTagCount = 0;
      for (const tags of Object.values(formulaTags || {})) {
        if (tags.includes('数学')) mathTagCount += 1;
        if (tags.includes('物理')) physicsTagCount += 1;
      }
      const moduleKey = mathTagCount > physicsTagCount
        ? 'math'
        : physicsTagCount > mathTagCount
          ? 'physics'
          : mathTagCount
            ? 'math'
            : physicsTagCount
              ? 'physics'
              : category === 'math'
                ? 'math'
                : category === 'physics'
                  ? 'physics'
                  : 'answer';

      return [{
        title: title.slice(0, 80),
        category,
        tags: [category === 'physics' ? '物理' : category === 'math' ? '数学' : '其他'],
        summary,
        formulas,
        formulaTags,
        moduleKey,
      }];
    }

    function _formulaModuleKeyFromItem(item, latex) {
      const formulaTags = item.formulaTags && item.formulaTags[latex];
      if (formulaTags) {
        if (formulaTags.includes('数学')) return 'math';
        if (formulaTags.includes('物理')) return 'physics';
      }
      if (item.moduleKey && item.moduleKey !== 'answer') return item.moduleKey;
      const tags = item.tags || [];
      if (tags.includes('数学')) return 'math';
      if (tags.includes('物理')) return 'physics';
      if (item.category === 'math') return 'math';
      if (item.category === 'physics') return 'physics';
      return '';
    }

    function saveExtractedFormulas(sessionId, items, messages, descriptions = {}) {
      const formulas = [];
      const lastAssistant = [...(messages || [])].reverse().find(m => m.role === 'assistant');
      const messageId = lastAssistant ? String(lastAssistant.timestamp || '') : '';
      for (const item of items || []) {
        for (const latex of item.formulas || []) {
          const normalizedLatex = _normalizeFormulaLatex(latex);
          const modelMeaning = String(
            descriptions[normalizedLatex] ||
            descriptions[_stripFormulaDelimiters(normalizedLatex)] ||
            ''
          ).trim();
          formulas.push({
            latex,
            concept: item.title,
            meaning: modelMeaning || describeFormula(latex, item.summary, item.title),
            meaningSource: modelMeaning ? 'model' : 'local',
            topic: '',
            related: (item.formulaTags && item.formulaTags[latex]) || item.tags || [],
            sessionId,
            messageId,
            moduleKey: _formulaModuleKeyFromItem(item, latex),
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
      if (!resp.ok) return { items: [], descriptions: {} };
      const data = await resp.json();
      return { items: data.items || [], descriptions: data.descriptions || {} };
    }

    function _knowledgeDedupKey(title) {
      return String(title || '')
        .replace(/^#+\s*/, '')
        .replace(/^.*?PhyMathia\s*学习卡片\s*[:：]\s*/i, '')
        .replace(/的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向)$/g, '')
        .replace(/的?(本质|原理|物理意义|数学意义|数学本质|含义|解释|相关公式)$/g, '')
        .replace(/^[🔬📐🧠💡🗺️]+\s*/, '')
        .replace(/[，。；、：:()（）\[\]【】\s]+/g, '')
        .toLowerCase()
        .trim();
    }

    function _mergeUniqueValues(base, extra) {
      return Array.from(new Set([...(base || []), ...(extra || [])].filter(Boolean)));
    }

    function _knowledgeModuleKeyFallback(item) {
      if (item.moduleKey && item.moduleKey !== 'answer') return item.moduleKey;
      const tags = item.tags || [];
      if (tags.includes('数学')) return 'math';
      if (tags.includes('物理')) return 'physics';
      if (item.category === 'math') return 'math';
      if (item.category === 'physics') return 'physics';
      return 'answer';
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
        const titleKey = _knowledgeDedupKey(item.title);
        const existing = Object.values(existingItems).find(e =>
          e.sessionId === sessionId && _knowledgeDedupKey(e.title) === titleKey
        ) || (updateExisting && items.length === 1 && messageItems.length === 1 ? messageItems[0] : null);
        if (existing) {
          const keepManualSource = existing.source === 'manual';
          Object.assign(existing, {
            category: item.category || existing.category,
            tags: _mergeUniqueValues(existing.tags, item.tags),
            summary: (item.summary && item.summary.length > (existing.summary || '').length)
              ? item.summary
              : existing.summary,
            formulas: _mergeUniqueValues(existing.formulas, item.formulas),
            messageId: String(messageId || existing.messageId),
            moduleKey: (item.moduleKey && item.moduleKey !== 'answer')
              ? item.moduleKey
              : existing.moduleKey || _knowledgeModuleKeyFallback(item),
          });
          if (keepManualSource) existing.source = 'manual';
          changed = true;
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
          moduleKey: _knowledgeModuleKeyFallback(item),
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

      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      if (lastAssistant && _isSocraticFollowup(lastAssistant.content)) {
        console.log('Skip knowledge extraction for Socratic follow-up');
        return;
      }

      const extractingEl = document.getElementById('kpExtracting');
      // 后台增强可能跨越下一轮对话，固定本轮消息避免结果串入新回答。
      const extractionMessages = messages.map(message => ({ ...message }));
      try {
        extractingEl?.classList.add('active');
        const agentModel = getActiveModelForRole('agent');
        const descriptorModel = getActiveModelForRole('descriptor');
        const basePayload = { messages: extractionMessages, sessionId: sessionId, level: getCurrentLevelValue() };

        // 浏览器本地先提取，不等待消息保存或任何模型响应。
        const localItems = extractLocalKnowledge(extractionMessages);
        saveExtractedKnowledgeItems(sessionId, extractionMessages, localItems);
        saveExtractedFormulas(sessionId, localItems, extractionMessages);
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
          let aiResult = { items: [], descriptions: {} };
          try {
            aiResult = await requestKnowledgeExtraction(payload);
          } catch (err) {
            console.warn('AI knowledge extraction failed:', err);
          }
          const aiItems = aiResult.items || [];
          saveExtractedKnowledgeItems(sessionId, extractionMessages, aiItems, true);
          saveExtractedFormulas(sessionId, aiItems, extractionMessages, aiResult.descriptions || {});
          refreshKnowledgePanelIfOpen();
        }
      } catch (err) {
        console.warn('Auto extract knowledge failed:', err);
      } finally {
        extractingEl?.classList.remove('active');
      }
    }

    // ===== HTML 生成模型（可选）：主回答缺少可视化时补充生成 =====
    function extractHtmlFromModelReply(text) {
      const fenced = text.match(/```html\s*([\s\S]*?)```/i);
      if (fenced && /<html[\s>]|<!doctype|<body[\s>]/i.test(fenced[1])) {
        return fenced[1].trim();
      }
      if (/<html[\s>]|<!doctype|<body[\s>]/i.test(text)) {
        const start = text.search(/<!doctype|<html[\s>]/i);
        const endMatch = text.match(/<\/html>/i);
        const end = endMatch ? endMatch.index + endMatch[0].length : text.length;
        return text.slice(start, end).trim();
      }
      return '';
    }

    async function collectStreamText(resp) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const dataStr = line.slice(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const data = JSON.parse(dataStr);
              if (data.error) continue;
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) content += delta.content;
            } catch (e) {}
          }
        }
      }
      return content;
    }

    async function renderAssistantContent(contentDiv, content) {
      const sections = parseXmlSections(content);
      if (Object.keys(sections).length > 0) {
        renderModuleSections(contentDiv, sections, content);
        await renderMermaidInElement(contentDiv);
        renderMath(contentDiv);
      } else {
        contentDiv.innerHTML = renderMarkdown(content);
        _initVizIframes(contentDiv);
        renderMath(contentDiv);
        await renderMermaidInElement(contentDiv);
        wrapDualDomainSections(contentDiv);
        renderMath(contentDiv);
      }
      if (contentDiv.dataset.branchLabel) {
        const tag = document.createElement('div');
        tag.className = 'branch-tag ' + (contentDiv.dataset.branchType || 'branch');
        tag.textContent = contentDiv.dataset.branchLabel;
        contentDiv.prepend(tag);
      }
    }

    async function ensureVisualization(content, signal) {
      const htmlModel = getActiveModelForRole('html');
      if (!htmlModel) return content;
      const sections = parseXmlSections(content);
      if (Object.keys(sections).length === 0) return content;
      if (/```html[\s\S]*?(?:<\/html>|<\/body>)[\s\S]*?```/i.test(content)) return content;

      showProgress('tool');
      const prompt = '请根据下面的物理数学学习内容，生成一个完整、独立、可交互的 HTML 可视化页面。'
        + '只输出完整 HTML，不要解释；必须包含滑块或按钮等交互控件，并适配深色/浅色主题。\n\n'
        + getLevelPrompt();
      try {
        const resp = await proxyChatWithModel(htmlModel, {
          messages: [{ role: 'user', content: prompt + '\n\n' + content.slice(0, 12000) }],
          stream: true,
        }, signal);
        const reply = await collectStreamText(resp);
        const html = extractHtmlFromModelReply(reply);
        if (!html) return content;
        return content + '\n\n```html\n' + html + '\n```\n';
      } catch (err) {
        console.warn('HTML model generation failed:', err);
        return content;
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
        moduleKey: _knowledgeModuleKeyFallback({
          category: document.getElementById('bmCategory').value,
          tags: document.getElementById('bmTags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
        }),
        createdAt: Date.now()
      };
      addKnowledgeItem(item);

      // 同步公式到公式库
      if (item.formulas && item.formulas.length > 0) {
        saveFormulasToServer(item.formulas.map(f => ({
          latex: f,
          concept: item.title,
          meaning: describeFormula(f, item.summary, item.title),
          meaningSource: 'local',
          topic: '',
          related: item.tags,
          sessionId: item.sessionId,
          messageId: item.messageId,
          moduleKey: item.moduleKey,
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

    let pendingSocraticQuestion = '';
    let pendingSocraticLevel = 'basic';
    let pendingSocraticBranchId = '';
    let pendingSocraticParentMsg = '';
    let pendingSocraticSourceModule = 'extend';
    let socraticSubmitting = false;
    let currentBranch = null;
    let currentBranchId = null;
    let activeBranchAnchor = null;

    function setActiveBranchAnchor(anchor) {
      activeBranchAnchor = anchor ? { ...anchor } : null;
      const bar = document.getElementById('branchAnchorBar');
      const textEl = document.getElementById('branchAnchorText');
      if (bar) bar.hidden = !activeBranchAnchor;
      if (textEl) textEl.textContent = activeBranchAnchor ? '当前锚点：' + (activeBranchAnchor.branchLabel || '当前气泡') : '';
      const input = document.getElementById('userInput');
      if (input) {
        input.placeholder = activeBranchAnchor
          ? '围绕「' + (activeBranchAnchor.branchLabel || '当前气泡') + '」提问...'
          : '问一个物理或数学问题...';
      }
    }

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

    function startSocraticAnswer(question, level, parentMsg, sourceModule) {
      pendingSocraticQuestion = question || '';
      pendingSocraticLevel = level || 'basic';
      pendingSocraticParentMsg = parentMsg || '';
      pendingSocraticSourceModule = sourceModule || 'extend';
      pendingSocraticBranchId = _genBranchId();
      const modal = document.getElementById('socraticModal');
      const questionEl = document.getElementById('socraticModalQuestion');
      const answerEl = document.getElementById('socraticModalAnswer');
      if (!modal || !questionEl || !answerEl) return;
      questionEl.textContent = pendingSocraticQuestion;
      answerEl.value = '';
      modal.hidden = false;
      modal.classList.add('active');
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
    }

    async function submitSocraticAnswer() {
      if (isStreaming || socraticSubmitting || !pendingSocraticQuestion) return;
      const answerEl = document.getElementById('socraticModalAnswer');
      const answer = answerEl ? answerEl.value.trim() : '';
      if (!answer) {
        answerEl?.focus();
        return;
      }
      const message = '[苏格拉底回答]\n追问问题：' + pendingSocraticQuestion + '\n我的回答：' + answer;
      const branchId = pendingSocraticBranchId || _genBranchId();
      socraticSubmitting = true;
      try {
        if (branchId) {
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
        currentBranch = 'socratic';
        currentBranchId = branchId;
        setActiveBranchAnchor({
          parentId: pendingSocraticParentMsg,
          sourceModule: pendingSocraticSourceModule,
          branchType: 'socratic',
          branchId,
          branchLabel: '苏格拉底：' + (pendingSocraticLevel === 'advanced' ? '进阶' : pendingSocraticLevel === 'expand' ? '拓展' : '基础'),
        });
        sendQuick(message);
      } finally {
        socraticSubmitting = false;
      }
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
      } else if (typeof window.sendQuick === 'function') {
        window.sendQuick(text);
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

    function sendQuick(text) {
      document.getElementById('userInput').value = text;
      autoResize(document.getElementById('userInput'));
      sendMessage();
    }

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
    function stopGeneration() {
      if (abortController) abortController.abort();
      if (typeof window.stopWorkflowRun === 'function') window.stopWorkflowRun();
    }
    window.stopGeneration = stopGeneration;
    window.startSocraticAnswer = startSocraticAnswer;
    window.closeSocraticModal = closeSocraticModal;
    window.submitSocraticAnswer = submitSocraticAnswer;
    window.resetSocraticBranch = resetSocraticBranch;

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
      const stopBtn = document.getElementById('stopBtn');
      const text = input.value.trim();
      if (!text || isStreaming) return;

      userScrolledUp = false; // 用户发送消息时重置滚动状态

      document.getElementById('welcomeTip')?.remove();

      const now = Date.now();
      const branchMeta = _consumePendingBranch() || {};
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
      input.value = '';
      input.style.height = 'auto';
      isStreaming = true;
      lastFailedMessage = text;

      if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
      streamingAssistant = { role: 'assistant', content: '', timestamp: Date.now(), ...branchMeta };

      // 切换为停止按钮
      btn.hidden = false;
      btn.disabled = false;
      btn.classList.add('stop-btn');
      if (stopBtn) stopBtn.disabled = false;
      btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
      btn.onclick = () => { if (abortController) abortController.abort(); };

      abortController = new AbortController();
      showProgress('thinking');
      let assistantContent = '';
      let assistantDiv = null;
      let streamRenderPending = false;
      let streamRenderFrame = null;
      let graphRenderPending = false;
      let graphRenderFrame = null;

      function cancelPendingStreamRender() {
        if (streamRenderFrame !== null) {
          cancelAnimationFrame(streamRenderFrame);
          streamRenderFrame = null;
        }
        if (graphRenderFrame !== null) {
          clearTimeout(graphRenderFrame);
          graphRenderFrame = null;
        }
        streamRenderPending = false;
        graphRenderPending = false;
      }

      try {
        const agentModel = getActiveModelForRole('agent');
        let resp;
        if (agentModel) {
          showProgress('tool');
          resp = await proxyChat(text, currentLevel, SESSION_ID, true, abortController.signal, branchMeta);
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
              branch_id: branchMeta.branchId || '',
              branch_type: branchMeta.branchType || '',
              source_module: branchMeta.sourceModule || '',
              parent_id: branchMeta.parentId || '',
              branch_label: branchMeta.branchLabel || '',
              graph_path: branchMeta.graphPath || [],
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
        let buffer = '';

        function scheduleStreamRender() {
          if (streamRenderPending) return;
          streamRenderPending = true;
          streamRenderFrame = requestAnimationFrame(() => {
            streamRenderFrame = null;
            if (assistantDiv && assistantContent) {
              assistantDiv.innerHTML = renderMarkdown(assistantContent);
              _initVizIframes(assistantDiv);
              renderMath(assistantDiv);
            }
            streamRenderPending = false;
          });
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
                        streamingAssistant.content = assistantContent;
                        if (!assistantDiv) assistantDiv = addMessage('assistant', '', Date.now());
              assistantDiv.innerHTML = renderMarkdown(stripXmlTags(assistantContent));
                        _initVizIframes(assistantDiv);
                        renderMathInElement(assistantDiv);
                        scrollToBottom();
                        scheduleGraphStreamRender();
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
                  streamingAssistant.content = assistantContent;
                  // 实时渲染 Markdown 和 LaTeX（节流）
                  scheduleStreamRender();
                  scheduleGraphStreamRender();
                  scrollToBottom();
                }
              } catch (e) {}
            }
          }
        }

        // 最终渲染：优先 XML 标签解析，兜底 heading 正则
        if (assistantDiv && assistantContent) {
          cancelPendingStreamRender();
          streamingAssistant = null;
          if (branchMeta.branchLabel) {
            assistantDiv.dataset.branchLabel = branchMeta.branchLabel;
            assistantDiv.dataset.branchType = branchMeta.branchType || 'branch';
          }
          await renderAssistantContent(assistantDiv, assistantContent);
          const originalContent = assistantContent;
          assistantContent = await ensureVisualization(assistantContent, abortController.signal);
          if (assistantContent !== originalContent) {
            await renderAssistantContent(assistantDiv, assistantContent);
          }
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
          if (wasSocraticBranch && /<socratic_meta\b[^>]*done\s*=\s*["']true["']/i.test(assistantContent)) {
            currentBranch = null;
            currentBranchId = null;
          }

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
        hideProgress();
        isStreaming = false;
        abortController = null;
        // 恢复发送按钮
        btn.classList.remove('stop-btn');
        btn.hidden = true;
        btn.disabled = false;
        if (stopBtn) stopBtn.disabled = true;
        btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>';
        btn.onclick = sendMessage;
        streamingAssistant = null;
        if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
        if (pendingDeleteTimestamp) {
          const ts = pendingDeleteTimestamp;
          pendingDeleteTimestamp = null;
          await _performDeleteMessages(ts);
        }
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
        contentDiv.innerHTML = renderMarkdown(content);
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
