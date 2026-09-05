// ===== PhyMathia 对话扩展：知识提取、可视化与书签 =====

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

      // 截断到该用户消息之前（连同用户消息一并移除）：
      // sendQuick/sendMessage 会无条件重新 push 用户消息，保留原条目会导致历史重复
      chatHistory = chatHistory.slice(0, userMsgIndex);
      saveSessionMessages(currentSessionId, chatHistory);

      // DOM：从被点击的助手消息向前找最近的用户消息节点，从它起整段移除
      let startEl = messageEl;
      let prev = messageEl.previousElementSibling;
      while (prev) {
        if (prev.classList && prev.classList.contains('user')) { startEl = prev; break; }
        prev = prev.previousElementSibling;
      }
      let el = startEl;
      while (el) {
        const next = el.nextElementSibling;
        el.remove();
        el = next;
      }

      // Re-send the user message
      if (typeof sendQuick === 'function') sendQuick(userMsg);
      else sendMessage();
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

    // 本地兜底的展示用摘要模板（P4 方案 C，离线确定性）：
    // 「{title}」：{首个公式含义（describeFormula 本地规则路径）}（{分类}）；
    // 无公式退化为「{title}」：{分类}知识点。标题与公式含义随条目变化，
    // 保证不同公式/概念的本地摘要至少文案不同（不再共用同一句整卡摘要）。
    // 与后端 _local_knowledge_summary（knowledge.py）逐字同口径，
    // 合并保优按 summarySource 等级天然兼容。
    // 超长（>120）时按预算压缩标题保结构（「」/含义/分类括注保持完整），
    // 概念回退含义以标题为原料（≈2×标题长），收紧时先用 24 字标题上限压含义；
    // 末位 120 硬截断仅作兜底——不改变原本就适配的短标题输出（审查修复）。
    function _buildLocalKnowledgeSummary(title, formulas, category) {
      const t = String(title || '').trim();
      const label = category === 'physics' ? '物理' : category === 'math' ? '数学' : '其他';
      const firstFormula = (formulas || []).find(f => String(f || '').trim());
      const meaning = firstFormula ? String(describeFormula(firstFormula, '', t) || '').trim() : '';
      if (meaning) {
        let summary = `「${t}」：${meaning}（${label}）`;
        if (summary.length > 120) {
          const m2 = String(describeFormula(firstFormula, '', t.slice(0, 24)) || '').trim() || meaning;
          const budget = Math.max(120 - m2.length - label.length - 5, 1); // 固定开销：「」：（）共 5 字
          summary = `「${t.slice(0, budget)}」：${m2}（${label}）`;
        }
        return summary.slice(0, 120);
      }
      let summary = `「${t}」：${label}知识点`;
      if (summary.length > 120) {
        const budget = Math.max(120 - label.length - 6, 1); // 固定开销：「」：知识点共 6 字
        summary = `「${t.slice(0, budget)}」：${label}知识点`;
      }
      return summary.slice(0, 120);
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
      const moduleHeading = /(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习(?:方向)?|苏格拉底追问|学习方向)/;
      const usefulTitles = allTitles.filter(title => !moduleHeading.test(title));
      const cardTitle = usefulTitles.find(title => /PhyMathia\s*学习卡片/.test(title));
      let title = (cardTitle || usefulTitles[0] || '')
        .replace(/^.*?PhyMathia\s*学习卡片\s*[:：]\s*/i, '')
        .replace(/的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习(?:方向)?|苏格拉底追问|学习方向|相关公式)$/g, '')
        .replace(/的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习(?:方向)?|苏格拉底追问|学习方向|相关公式)$/g, '')
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
      // 整卡摘要原文（<summary> 优先，回退正文头 120 字）：仅作画布定位锚点（P2 契约）
      const anchorSummary = (summaryMatch ? summaryMatch[1] : content)
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      // 展示用摘要（P4 模板化）：「{title}」+ 首个公式含义（本地规则路径）+ 分类，
      // 不同公式/概念文案不同；无模型/弱网时不再千篇一律
      const summary = _buildLocalKnowledgeSummary(title, formulas, category);
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
        // 整卡摘要原文仅作画布定位锚点（P4 起展示摘要为模板文案，两者分离）
        anchorSummary,
        summarySource: 'local',
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

    function saveExtractedFormulas(sessionId, items, messages, descriptions = {}, opts = {}) {
      const formulas = [];
      const lastAssistant = [...(messages || [])].reverse().find(m => m.role === 'assistant');
      const messageId = lastAssistant ? String(lastAssistant.timestamp || '') : '';
      const nodeIdByModuleKey = (opts && opts.nodeIdByModuleKey) || {};
      for (const item of items || []) {
        for (const latex of item.formulas || []) {
          const normalizedLatex = _normalizeFormulaLatex(latex);
          const modelMeaning = String(
            descriptions[normalizedLatex] ||
            descriptions[_stripFormulaDelimiters(normalizedLatex)] ||
            ''
          ).trim();
          const formulaModuleKey = _formulaModuleKeyFromItem(item, latex);
          formulas.push({
            latex,
            concept: item.title,
            meaning: modelMeaning || describeFormula(latex, item.summary, item.title),
            meaningSource: modelMeaning ? 'model' : 'local',
            topic: '',
            related: (item.formulaTags && item.formulaTags[latex]) || item.tags || [],
            sessionId,
            messageId,
            moduleKey: formulaModuleKey,
            nodeId: (nodeIdByModuleKey[formulaModuleKey] || ''),
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
        body: JSON.stringify(memoryWithDevice(payload))
      });
      if (!resp.ok) return { items: [], descriptions: {}, summaries: {} };
      const data = await resp.json();
      return { items: data.items || [], descriptions: data.descriptions || {}, summaries: data.summaries || {} };
    }

    function _knowledgeDedupKey(title) {
      return String(title || '')
        .replace(/^#+\s*/, '')
        .replace(/^.*?PhyMathia\s*学习卡片\s*[:：]\s*/i, '')
        .replace(/的?(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习(?:方向)?|苏格拉底追问|学习方向)$/g, '')
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

    // 摘要来源保优等级：manual > model > local（旧数据无 summarySource 视为 local）
    function _summarySourceRank(source) {
      return source === 'manual' ? 0 : source === 'model' ? 1 : 2;
    }

    function saveExtractedKnowledgeItems(sessionId, messages, items, updateExisting = false, opts = {}) {
      if (!items || items.length === 0) return;

      const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
      const messageId = lastAssistant ? (lastAssistant.timestamp || '') : '';
      const nodeIdByModuleKey = (opts && opts.nodeIdByModuleKey) || {};
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
          // 摘要保优（P2）：manual > model > local，同源才比长度；
          // 空摘要永不覆盖非空摘要——修复「手动摘要被更长的 AI 摘要覆盖」
          const incomingSummary = String(item.summary || '').trim();
          const existingSummary = String(existing.summary || '').trim();
          const incomingSrc = item.summarySource || 'local';
          const existingSrc = existing.summarySource || 'local';
          let nextSummary = existing.summary;
          let nextSummarySource = existingSrc;
          if (incomingSummary) {
            if (!existingSummary
              || _summarySourceRank(incomingSrc) < _summarySourceRank(existingSrc)
              || (incomingSrc === existingSrc && incomingSummary.length > existingSummary.length)) {
              // 旧数据无 anchorSummary 时，被替换的旧摘要先落为定位锚点
              if (!existing.anchorSummary && existingSummary) existing.anchorSummary = existing.summary;
              nextSummary = item.summary;
              nextSummarySource = incomingSrc;
            }
          }
          Object.assign(existing, {
            category: item.category || existing.category,
            tags: _mergeUniqueValues(existing.tags, item.tags),
            summary: nextSummary,
            summarySource: nextSummarySource,
            anchorSummary: existing.anchorSummary || item.anchorSummary || '',
            formulas: _mergeUniqueValues(existing.formulas, item.formulas),
            messageId: String(messageId || existing.messageId),
            moduleKey: (item.moduleKey && item.moduleKey !== 'answer')
              ? item.moduleKey
              : existing.moduleKey || _knowledgeModuleKeyFallback(item),
            nodeId: (nodeIdByModuleKey[item.moduleKey] || existing.nodeId || ''),
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
          summarySource: item.summarySource || 'local',
          anchorSummary: item.anchorSummary || '',
          formulas: item.formulas || [],
          source: 'ai_extract',
          sessionId: sessionId,
          messageId: String(messageId),
          moduleKey: _knowledgeModuleKeyFallback(item),
          nodeId: (nodeIdByModuleKey[item.moduleKey] || nodeIdByModuleKey[_knowledgeModuleKeyFallback(item)] || ''),
          createdAt: Date.now()
        };
        changed = true;
      }

      if (changed) saveKnowledgeItems(existingItems);
    }

    // 知识点摘要（DESCRIBE_PROMPT summaries 块，随公式描述同一次调用返回）：
    // 只把 local 来源（或摘要为空）的既有条目升级为模型摘要；manual 永不触碰，
    // 已是 model 的条目保留提取模型基于对话原文的逐条摘要，避免两路模型摘要来回翻转。
    function applyModelKnowledgeSummaries(sessionId, summaries) {
      const entries = summaries && typeof summaries === 'object' && !Array.isArray(summaries)
        ? Object.entries(summaries) : [];
      if (!entries.length) return;
      const items = getKnowledgeItems();
      let changed = false;
      for (const [title, text] of entries) {
        const summary = String(text || '').trim();
        if (!summary) continue;
        const key = _knowledgeDedupKey(title);
        if (!key) continue;
        const existing = Object.values(items).find(e =>
          e.sessionId === sessionId && _knowledgeDedupKey(e.title) === key);
        if (!existing) continue;
        const src = existing.summarySource || 'local';
        if (src === 'manual') continue;
        if (src === 'model' && String(existing.summary || '').trim()) continue;
        if (!existing.anchorSummary && existing.summary) existing.anchorSummary = existing.summary;
        existing.summary = summary;
        existing.summarySource = 'model';
        changed = true;
      }
      if (changed) saveKnowledgeItems(items);
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

    let _extractFailToastShown = false;

    async function autoExtractKnowledge(sessionId, messages, opts = {}) {
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
        saveExtractedKnowledgeItems(sessionId, extractionMessages, localItems, false, opts);
        saveExtractedFormulas(sessionId, localItems, extractionMessages, {}, opts);
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
          let aiResult = { items: [], descriptions: {}, summaries: {} };
          try {
            aiResult = await requestKnowledgeExtraction(payload);
          } catch (err) {
            console.warn('AI knowledge extraction failed:', err);
            // 完全静默会让用户误以为知识增强成功：提示一次（不弹每轮）
            if (!_extractFailToastShown && typeof showToast === 'function') {
              _extractFailToastShown = true;
              showToast('AI 知识增强提取失败，本轮仅保留本地提取结果');
            }
          }
          const aiItems = aiResult.items || [];
          // 后端 AI 提取条目缺 summarySource 时按模型增强来源补标
          // （后端本地兜底条目已自带 'local'，不会被误标）
          for (const it of aiItems) {
            if (it && !it.summarySource) it.summarySource = 'model';
          }
          saveExtractedKnowledgeItems(sessionId, extractionMessages, aiItems, true, opts);
          applyModelKnowledgeSummaries(sessionId, aiResult.summaries);
          saveExtractedFormulas(sessionId, aiItems, extractionMessages, aiResult.descriptions || {}, opts);
          refreshKnowledgePanelIfOpen();
        }
      } catch (err) {
        console.warn('Auto extract knowledge failed:', err);
      } finally {
        extractingEl?.classList.remove('active');
      }
    }

    // ===== HTML 生成模型：主回答缺少可视化时自动补齐（补进 <viz> 而不是追加到文末） =====

    function _looksLikeCompleteHtml(html) {
      const text = String(html || '').trim();
      if (text.length < 100) return false;
      if (!/<html[\s>]|<!doctype|<body[\s>]/i.test(text)) return false;
      return /<\/html>|<\/body>/i.test(text);
    }

    function _findCompleteHtmlBlock(text) {
      const source = String(text || '');
      const re = /```html\s*([\s\S]*?)```/gi;
      let match;
      while ((match = re.exec(source)) !== null) {
        if (_looksLikeCompleteHtml(match[1])) {
          return '```html\n' + match[1].trim() + '\n```';
        }
      }
      return '';
    }

    function _hasVisualizationHtml(text) {
      return !!_findCompleteHtmlBlock(text);
    }

    function extractHtmlFromModelReply(text) {
      const source = String(text || '');
      const block = _findCompleteHtmlBlock(source);
      if (block) {
        const inner = block.replace(/^```html\s*/i, '').replace(/\s*```$/i, '');
        return inner.trim();
      }
      if (/<html[\s>]|<!doctype|<body[\s>]/i.test(source)) {
        const start = source.search(/<!doctype|<html[\s>]/i);
        const endMatch = source.match(/<\/html>/i);
        const end = endMatch ? endMatch.index + endMatch[0].length : source.length;
        const html = source.slice(start, end).trim();
        if (_looksLikeCompleteHtml(html)) return html;
      }
      return '';
    }

    function _insertVisualizationHtml(content, html) {
      const text = String(content || '');
      const htmlBlock = '\n\n```html\n' + String(html || '').trim() + '\n```\n';
      const vizTag = /<viz>[\s\S]*?<\/viz>/i;
      const existing = text.match(vizTag);
      if (existing) {
        return text.replace(vizTag, () => {
          const oldText = String(existing[1] || '')
            .trim()
            .replace(/```html\s*[\s\S]*?```/gi, '')
            .replace(/^#{1,6}\s*(交互探索|交互式可视化)[^\n]*\n?/i, '')
            .trim();
          const section = (oldText ? oldText + '\n\n' : '## 交互探索\n') + htmlBlock;
          return '<viz>\n' + section.trim() + '\n</viz>';
        });
      }
      const section = '<viz>\n## 交互探索\n' + htmlBlock.trim() + '\n</viz>\n\n';
      if (/<extend>/i.test(text)) return text.replace(/<extend>/i, () => section + '<extend>');
      if (/<summary>/i.test(text)) return text.replace(/<summary>/i, () => section + '<summary>');
      return text + '\n\n' + section.trim();
    }

    function _buildVisualizationPrompt(sourceContent, extraInstruction) {
      let prompt = '你是 PhyMathia 的交互可视化生成器。请根据下面的物理数学学习内容，生成一个完整、独立、可交互的 HTML 可视化页面。\n'
        + '只输出完整 HTML，不要输出任何解释、Markdown 代码块以外的文字；必须包含至少一个滑块或按钮等交互控件，并适配深色/浅色主题。\n'
        + '页面内顶部必须用可见中文写出四段图说：\n'
        + '**这张图在讲什么**：2~4 句大白话说明图的核心结论；\n'
        + '**怎么看这张图**：用 1. 2. 3. 编号说明观察步骤，每步写“操作 → 会看到什么”；\n'
        + '**和公式的联系**：图中现象与公式如何互相印证；\n'
        + '**自测**：1 个不实际操作就答不出的问题（只提问不给答案）。\n'
        + '每个滑块/按钮旁标注对应物理量/数学量及在公式中的位置，关键结论数值旁给出对应公式。\n\n'
        + getLevelPrompt();
      if (extraInstruction) prompt += '\n\n' + extraInstruction;
      return prompt;
    }

    function _isRateLimitError(err) {
      const msg = String((err && err.message) || err || '').toLowerCase();
      return msg.includes('429') || msg.includes('rate limit') || msg.includes('freeusagelimiterror') || msg.includes('free usage limit');
    }

    function _sameModelService(a, b) {
      if (!a || !b) return false;
      const norm = (s) => String(s || '').replace(/\/+$/, '').toLowerCase();
      return norm(a.provider) === norm(b.provider) && norm(a.baseUrl) === norm(b.baseUrl);
    }

    async function _requestVisualizationHtml(sourceContent, signal, extraInstruction) {
      const htmlModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('html') : null;
      const agentModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('agent') : null;
      const models = [];
      if (htmlModel) models.push(htmlModel);
      if (agentModel && (!htmlModel || agentModel.id !== htmlModel.id)) models.push(agentModel);
      if (!models.length) throw new Error('未配置 AI 模型，请在模型设置中配置（可直接使用免费模型）');

      let lastError = null;
      for (let index = 0; index < models.length; index++) {
        const model = models[index];
        try {
          const retryInstruction = index > 0
            ? '上一次尝试没有返回完整 HTML。请务必从 <!DOCTYPE html> 开始输出，直到 </html> 结束。'
            : '';
          const combinedInstruction = [extraInstruction, retryInstruction].filter(Boolean).join('\n');
          const prompt = _buildVisualizationPrompt(sourceContent, combinedInstruction);
          const resp = await proxyChatWithModel(model, {
            messages: [{ role: 'user', content: prompt + '\n\n' + String(sourceContent || '').slice(0, 12000) }],
            stream: true,
          }, signal);
          const reply = await collectStreamText(resp, (progress, length) => {
            const pct = progress !== null && progress !== undefined
              ? Math.max(88, Math.min(93, progress))
              : Math.min(93, 88 + Math.min(length / 20000, 1) * 5);
            _setProgress(pct, '正在生成交互可视化');
          });
          const html = extractHtmlFromModelReply(reply);
          if (_looksLikeCompleteHtml(html)) return html;
          lastError = new Error('模型未返回完整 HTML 页面');
        } catch (err) {
          lastError = err;
          const next = models[index + 1];
          // 同一个上游服务已经明确限流时，继续用同服务另一个模型只会再撞一次 429。
          if (_isRateLimitError(err) && next && _sameModelService(model, next)) {
            break;
          }
        }
      }
      throw lastError || new Error('交互可视化生成失败');
    }

    async function collectStreamText(resp, onProgress) {
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
              if (data.error) {
                const errMsg = data.detail || data.error?.detail || data.error?.message || JSON.stringify(data.error);
                throw new Error('AI 流式返回错误：' + errMsg);
              }
              if (typeof onProgress === 'function' && typeof data.progress === 'number') {
                onProgress(data.progress, content.length);
              }
              const delta = data.choices?.[0]?.delta;
              if (delta?.content) {
                content += delta.content;
                if (typeof onProgress === 'function') onProgress(null, content.length);
              }
            } catch (e) {
              if (e && e.message && e.message.indexOf('AI 流式返回错误') === 0) throw e;
            }
          }
        }
      }
      return content;
    }

    async function renderAssistantContent(contentDiv, content) {
      contentDiv.innerHTML = renderMarkdown(content, { parentId: contentDiv.closest('.message-body')?.dataset.messageId || '', socraticFallback: true });
      _initVizIframes(contentDiv);
      renderMath(contentDiv);
      await renderMermaidInElement(contentDiv);
      if (contentDiv.dataset.branchLabel) {
        const tag = document.createElement('div');
        tag.className = 'branch-tag ' + (contentDiv.dataset.branchType || 'branch');
        tag.textContent = contentDiv.dataset.branchLabel;
        contentDiv.prepend(tag);
      }
    }

    async function scheduleVisualizationInBackground(content, onReady) {
      if (!content || typeof onReady !== 'function') return;
      try {
        const sections = parseXmlSections(content);
        if (Object.keys(sections).length === 0) return;
        if (_hasVisualizationHtml(sections.viz || '')) return;

        // 旧版回答：HTML 补在 <viz> 之外，直接迁回，不发起模型请求。
        const strayRe = /```html\s*([\s\S]*?)```/gi;
        let strayMatch = null;
        while ((strayMatch = strayRe.exec(String(content))) !== null) {
          if (_looksLikeCompleteHtml(strayMatch[1])) break;
        }
        if (strayMatch) {
          const strayHtml = strayMatch[1].trim();
          if (strayHtml) {
            const withoutStray = String(content).replace(strayMatch[0], '');
            onReady(_insertVisualizationHtml(withoutStray, strayHtml));
          }
          return;
        }

        const htmlModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('html') : null;
        const agentModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('agent') : null;
        if (!htmlModel && !agentModel) return;

        // 后台补齐，不阻塞主回答保存和下一次提问。
        const html = await _requestVisualizationHtml(content, new AbortController().signal);
        onReady(_insertVisualizationHtml(content, html));
      } catch (err) {
        console.warn('Background HTML model generation failed:', err);
      }
    }

    async function ensureVisualization(content, signal) {
      const sections = parseXmlSections(content);
      if (Object.keys(sections).length === 0) return content;
      if (_hasVisualizationHtml(sections.viz || '')) return content;

      // 兼容旧版回答：HTML 曾补在 <viz> 之外。把它迁回 <viz>，让画布节点不再为空。
      const strayRe = /```html\s*([\s\S]*?)```/gi;
      let strayMatch = null;
      while ((strayMatch = strayRe.exec(String(content))) !== null) {
        if (_looksLikeCompleteHtml(strayMatch[1])) break;
      }
      if (strayMatch) {
        const strayHtml = strayMatch[1].trim();
        if (strayHtml) {
          const withoutStray = String(content).replace(strayMatch[0], '');
          return _insertVisualizationHtml(withoutStray, strayHtml);
        }
      }

      const htmlModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('html') : null;
      const agentModel = typeof getActiveModelForRole === 'function' ? getActiveModelForRole('agent') : null;
      if (!htmlModel && !agentModel) return content;

      showProgress('tool', 88, '正在生成交互可视化');
      try {
        const html = await _requestVisualizationHtml(content, signal);
        return _insertVisualizationHtml(content, html);
      } catch (err) {
        console.warn('HTML model generation failed:', err);
        throw err;
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
        summarySource: 'manual',
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
