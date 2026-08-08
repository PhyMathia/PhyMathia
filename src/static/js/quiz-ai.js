/* ====== 知识检测：AI 出题/审题与题库 ====== */

function _pickQuizModel() {
  if (typeof getActiveModelForRole !== 'function') return null;
  return getActiveModelForRole('quiz') || getActiveModelForRole('agent');
}

function _buildQuizGenerationContext(pool) {
  const lines = ['# 出题素材'];
  if (pool.knowledge.length) {
    lines.push('## 知识点');
    for (const item of pool.knowledge) {
      lines.push(`- id: ${item.id} | 知识点：${item.title}`);
      lines.push(`  概述：${item.summary || '无'}`);
      if (item.formulas.length) lines.push(`  公式：${item.formulas.join('；')}`);
    }
  }
  if (pool.formulas.length) {
    lines.push('## 公式库');
    for (const item of pool.formulas) {
      lines.push(`- id: ${item.id} | ${item.latex}${item.concept ? `（概念：${item.concept}）` : ''}${item.meaning ? `；含义：${item.meaning}` : ''}`);
    }
  }
  return lines.join('\n');
}

function _quizFindPoolItem(pool, item) {
  const sourceRef = String(item.sourceRef || item.topicId || '');
  const title = _quizCleanTitle(item.title) || '';
  const formulaText = item.formulaText || item.formula || '';
  const titleKey = _quizOptionKey(title.replace(/[^\w\u4e00-\u9fff]+/g, ''));
  const keyOf = value => _quizOptionKey(String(value || '').replace(/[^\w\u4e00-\u9fff]+/g, ''));
  const all = [...(pool.knowledge || []), ...(pool.formulas || [])];
  if (sourceRef) {
    const exact = all.find(x => x.id === sourceRef);
    if (exact) return exact;
  }
  if (titleKey) {
    for (const x of all) {
      const label = x.title || x.concept || '';
      const key = keyOf(label);
      if (!key) continue;
      if (key === titleKey || key.includes(titleKey) || titleKey.includes(key)) return x;
    }
  }
  if (formulaText) {
    const normalized = _quizOptionKey(_quizFormulaText(formulaText).replace(/\s+/g, ' '));
    for (const x of pool.formulas || []) {
      if (_quizOptionKey(_quizFormulaText(x.latex).replace(/\s+/g, ' ')) === normalized) return x;
    }
  }
  return null;
}

function _humanizeQuizText(text, item) {
  let s = String(text || '');
  const label = item && (item.concept || item.title || (item.latex ? _quizFormulaText(item.latex) : ''));
  if (!label) return s;
  s = s.replace(/\b(?:f_|k_)[A-Za-z0-9_-]{4,}\b/gi, label);
  s = s.replace(/id\s*(?:为|是|：|:)\s*["“]?([^"”\s，。；;]+)["”]?/gi, (match, value) => {
    const cleaned = String(value || '').replace(/[“”"']/g, '');
    if (_quizOptionKey(cleaned) === _quizOptionKey(label) || /\b(?:f_|k_)[A-Za-z0-9_-]{4,}\b/i.test(cleaned)) {
      return '“' + label + '”';
    }
    return match;
  });
  return s;
}

function _quizHumanizeQuestionText(text, question) {
  return _humanizeQuizText(text, {
    title: (question && question.title) || '',
    concept: (question && (question.concept || question.title)) || '',
    latex: (question && (question.formulaText || question.latex)) || ''
  });
}

function _sanitizeAIQuestions(raw, pool) {
  let data;
  try {
    const text = String(raw || '').trim();
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : text;
    const match = candidate.match(/\{[\s\S]*\}/) || candidate.match(/\[[\s\S]*\]/);
    if (!match) return [];
    data = JSON.parse(match[0]);
  } catch (e) {
    return [];
  }
  const list = Array.isArray(data) ? data : (data.questions || data.items || []);
  const result = [];
  const now = Date.now();
  for (let i = 0; i < list.length && result.length < quizTargetCount; i++) {
    const item = list[i];
    if (!item || typeof item !== 'object') continue;
    const prompt = _quizCleanText(item.prompt, 300);
    if (!prompt) continue;
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    if (rawOptions.length < 2 || rawOptions.length > 6) continue;
    const title = _quizCleanTitle(item.title) || '';
    const formulaText = item.formulaText || item.formula || '';
    const matched = _quizFindPoolItem(pool, item);
    if (!matched) continue;
    const options = rawOptions.map((option, idx) => {
      const text = typeof option === 'string' ? option : String(option?.text || option?.label || '');
      const cleanText = _humanizeQuizText(_quizCleanText(text, 220), matched);
      return {
        key: String.fromCharCode(65 + idx),
        text: cleanText,
        html: _quizLooksLikeFormula(cleanText) ? _quizFormulaHtml(cleanText) : ''
      };
    });
    if (options.some(option => !option.text)) continue;
    if (new Set(options.map(option => _quizOptionKey(option.text))).size !== options.length) continue;
    const correctIndex = Number(item.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) continue;
    const humanPrompt = _humanizeQuizText(prompt, matched);
    const questionText = [humanPrompt, title, formulaText, ...options.map(option => option.text)].join('\n');
    if (_quizIsMetaPrompt(questionText)) continue;
    result.push({
      id: 'ai_' + now + '_' + i,
      type: ['concept', 'formula_meaning', 'formula_concept', 'knowledge_formula', 'category'].includes(item.type) ? item.type : 'ai',
      title: title || matched.title || matched.concept || '检测题',
      prompt: humanPrompt,
      promptHtml: formulaText ? _quizFormulaHtml(formulaText) : '',
      formulaText: formulaText ? _quizFormulaText(formulaText) : '',
      options,
      correctIndex,
      explanation: _humanizeQuizText(_quizCleanText(item.explanation, 300), matched) || '正确答案：' + options[correctIndex].text,
      refId: matched.id,
      sourceRef: matched.id,
      sourceType: matched.latex ? 'formula' : 'knowledge',
      topicKey: matched.topicKey || _quizTopicKey(matched),
      difficulty: _quizDifficultyKey(item.difficulty),
      sessionId: matched.sessionId
    });
  }
  return result;
}

async function _aiGenerateQuizQuestions(pool, requestId, verify = QUIZ_AI_VERIFY_ENABLED) {
  const model = _pickQuizModel();
  if (!model) return null;
  const prompts = await _loadQuizPromptFile();
  const systemPrompt = (prompts.generate || DEFAULT_QUIZ_GENERATION_PROMPT)
    .replace(/\{\{LEVEL_PROMPT\}\}/g, getLevelPrompt())
    .replace(/\{\{QUESTION_COUNT\}\}/g, quizTargetCount);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), QUIZ_AI_TIMEOUT_MS) : null;
  if (controller) quizAiController = controller;
  if (quizState) {
    quizState.aiProgress = 90;
    quizState.aiStage = 'verify';
    _startQuizProgress(98);
  }
  const context = _buildQuizGenerationContext(pool);
  quizAiStatusText = 'AI 正在生成检测题…';
  if (quizState) {
    quizState.aiProgress = 5;
    quizState.aiStage = 'generate';
    _startQuizProgress(85);
  }
  try {
    const resp = await fetch('/api/models/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `出题素材：\n${context}\n\n请只基于素材中的具体知识点和公式生成检测题，不要讨论“出题素材”或“知识上下文”本身。` }
        ],
        provider: model.provider,
        api_key: model.apiKey,
        model: model.model,
        base_url: model.baseUrl,
        stream: true
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await _readModelStream(resp, received => {
      if (quizState) quizState.aiProgress = Math.min(85, 10 + Math.round(received / 1200 * 70));
    });
    const questions = _sanitizeAIQuestions(raw, pool);
    if (requestId !== undefined && requestId !== quizAiRequestId) return null;
    if (verify && questions.length >= 2) {
      quizAiStatusText = 'AI 正在校验题目…';
      if (quizState) {
        quizState.aiProgress = 90;
        quizState.aiStage = 'verify';
      }
      const verified = await _aiVerifyQuizQuestions(pool, questions);
      if (requestId !== undefined && requestId !== quizAiRequestId) return null;
      if (verified && verified.length >= 2) return verified;
    }
    return questions.length >= 2 ? questions : null;
  } catch (e) {
    if (e && e.name === 'AbortError') console.warn('AI quiz generation timed out or superseded');
    else console.warn('AI quiz generation failed:', e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && quizAiController === controller) quizAiController = null;
    quizAiStatusText = '';
    _clearQuizProgressTimer();
  }
}

function _mergeQuizQuestions(aiQuestions, localQuestions) {
  const preference = quizSourcePreference || 'ai';
  if (preference === 'ai') return (aiQuestions || []).slice(0, quizTargetCount);
  if (preference === 'local') return (localQuestions || []).slice(0, quizTargetCount);
  const seen = new Set((aiQuestions || []).map(q => _quizSignature(q)));
  const result = (aiQuestions || []).slice();
  for (const q of localQuestions || []) {
    const sig = _quizSignature(q);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(q);
    if (result.length >= quizTargetCount) break;
  }
  return result.slice(0, quizTargetCount);
}

function _quizPoolSignature(pool) {
  const knowledge = (pool.knowledge || [])
    .map(item => _quizOptionKey(String(item.title || item.concept || '').replace(/[^\w\u4e00-\u9fff]+/g, '')))
    .sort()
    .join('\n');
  const formulas = (pool.formulas || [])
    .map(item => _quizOptionKey(_quizFormulaText(item.latex).replace(/\s+/g, ' ')))
    .sort()
    .join('\n');
  return _quizOptionKey('k:' + knowledge + ';f:' + formulas);
}

function _readQuizBank() {
  try {
    const raw = localStorage.getItem(QUIZ_BANK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function _persistQuizBank(bank) {
  if (!bank) return;
  quizBank = bank;
  try {
    localStorage.setItem(QUIZ_BANK_KEY, JSON.stringify(bank));
  } catch (e) {}
  try {
    fetch('/api/kv/phymathia_quiz_bank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: bank })
    }).catch(() => {});
  } catch (e) {}
}

function _saveQuizBank(pool, aiQuestions) {
  const ai = (aiQuestions || []).filter(q => q && q.id && String(q.id).startsWith('ai_'));
  if (!ai.length) return;
  const existing = _readQuizBank();
  const existingQuestions = existing && Array.isArray(existing.questions) ? existing.questions : [];
  const seen = new Set(existingQuestions.map(q => _quizSignature(q)));
  const merged = existingQuestions.slice();
  for (const q of ai) {
    const sig = _quizSignature(q);
    if (seen.has(sig)) continue;
    seen.add(sig);
    merged.push(q);
  }
  _persistQuizBank({
    poolKey: _quizPoolSignature(pool),
    questions: merged.slice(0, 30),
    updatedAt: Date.now()
  });
}

function deleteQuizBankQuestion(encodedId) {
  const targetId = decodeURIComponent(encodedId || '');
  const bank = _readQuizBank();
  if (!bank || !Array.isArray(bank.questions)) return;
  bank.questions = bank.questions.filter(q => q && q.id !== targetId);
  _persistQuizBank(bank);
  if (quizState && quizState.phase === 'bank') renderQuiz();
}

function _quizShowToast(message) {
  if (typeof showToast === 'function') showToast(message);
  else alert(message);
}

function _quizSourceJumpLabel(question) {
  const isFormula = question && (question.sourceType === 'formula' || !!(question.formulaText || question.latex));
  return isFormula ? '查看对应公式' : '查看对应知识点';
}

function _findQuizJumpQuestion(encodedId) {
  const id = decodeURIComponent(encodedId || '');
  if (quizState && Array.isArray(quizState.questions)) {
    const q = quizState.questions.find(item => item && item.id === id);
    if (q) return q;
  }
  if (quizState && quizState.phase === 'bank') {
    const bank = quizBank || _readQuizBank();
    const q = (bank && Array.isArray(bank.questions) ? bank.questions : []).find(item => item && item.id === id);
    if (q) return q;
  }
  if (quizState && quizState.phase === 'wrong') {
    const q = (quizState.wrongList || _readWrongQuestions()).find(item => item && item.id === id);
    if (q) return q;
  }
  return null;
}

async function jumpQuizToSource(encodedId) {
  const question = _findQuizJumpQuestion(encodedId);
  if (!question) {
    _quizShowToast('找不到这道题的来源');
    return;
  }
  const refId = question.sourceRef || question.refId || '';
  if (!refId) {
    _quizShowToast('这道题没有关联知识点');
    return;
  }
  const isFormula = question.sourceType === 'formula' || !!(question.formulaText || question.latex);
  try {
    if (isFormula) {
      if (typeof window.locateFormulaNode !== 'function') {
        _quizShowToast('跳转功能暂不可用');
        return;
      }
      const ok = await window.locateFormulaNode(refId);
      if (ok && typeof closeQuiz === 'function') closeQuiz();
    } else {
      if (typeof window.goToKnowledgeNode !== 'function') {
        _quizShowToast('跳转功能暂不可用');
        return;
      }
      const ok = await window.goToKnowledgeNode(refId);
      if (ok && typeof closeQuiz === 'function') closeQuiz();
    }
  } catch (e) {
    console.warn('Quiz source jump failed:', e);
    _quizShowToast('跳转失败，请重试');
  }
}

async function _loadQuizBankFromServer() {
  try {
    const resp = await fetch('/api/kv/phymathia_quiz_bank', { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    const server = data.value;
    if (!server || typeof server !== 'object' || !Array.isArray(server.questions)) return;
    const local = _readQuizBank();
    const useServer = !local || (Number(server.updatedAt || 0) >= Number(local.updatedAt || 0));
    quizBank = useServer ? server : local;
    try {
      localStorage.setItem(QUIZ_BANK_KEY, JSON.stringify(quizBank));
    } catch (e) {}
  } catch (e) {
    console.warn('Load quiz bank failed:', e);
  }
}

function _bankForPool(pool) {
  const questions = _quizBankQuestions();
  return questions.length >= 2 ? questions : null;
}

function _quizBankQuestions() {
  const bank = quizBank || _readQuizBank();
  const questions = bank && Array.isArray(bank.questions) ? bank.questions : [];
  if (quizBankFilterSession) {
    const ids = new Set(_quizSessionIdVariants(quizBankFilterSession));
    return questions.filter(q => q && ids.has(q.sessionId || ''));
  }
  if (quizMode === 'session') {
    const ids = _quizCurrentSessionIds();
    return questions.filter(q => q && (ids.size === 0 || ids.has(q.sessionId || '')));
  }
  return questions;
}

async function _aiVerifyQuizQuestions(pool, questions) {
  const model = _pickQuizModel();
  if (!model || !questions || questions.length < 2) return null;
  const prompts = await _loadQuizPromptFile();
  const systemPrompt = (prompts.verify || DEFAULT_QUIZ_VERIFY_PROMPT)
    .replace(/\{\{LEVEL_PROMPT\}\}/g, getLevelPrompt())
    .replace(/\{\{QUESTION_COUNT\}\}/g, quizTargetCount);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), QUIZ_AI_TIMEOUT_MS) : null;
  if (controller) quizAiController = controller;
  const context = _buildQuizGenerationContext(pool);
  const payload = questions.map(q => ({
    id: q.id || '',
    type: q.type || 'concept',
    title: q.title || '',
    sourceRef: q.sourceRef || q.refId || '',
    difficulty: q.difficulty || 'medium',
    prompt: q.prompt || '',
    formulaText: q.formulaText || '',
    options: (q.options || []).map(option => option.text || ''),
    correctIndex: q.correctIndex,
    explanation: q.explanation || '',
  }));
  try {
    const resp = await fetch('/api/models/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `出题素材：\n${context}\n\n待审核题目：\n${JSON.stringify(payload, null, 2)}\n\n请输出修正后的题目数组。` }
        ],
        provider: model.provider,
        api_key: model.apiKey,
        model: model.model,
        base_url: model.baseUrl,
        stream: true
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await _readModelStream(resp, received => {
      if (quizState) quizState.aiProgress = Math.min(98, 90 + Math.round(received / 800 * 8));
    });
    const verified = _sanitizeAIQuestions(raw, pool);
    return verified.length >= 2 ? verified : null;
  } catch (e) {
    if (e && e.name === 'AbortError') console.warn('AI quiz verification timed out or superseded');
    else console.warn('AI quiz verification failed:', e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && quizAiController === controller) quizAiController = null;
    _clearQuizProgressTimer();
  }
}

async function _generateQuestions(pool) {
  const requestId = ++quizAiRequestId;
  if (quizAiController) quizAiController.abort();
  if (quizState && quizSourcePreference !== 'local') {
    quizState.aiPending = true;
    quizState.aiProgress = 0;
    quizState.aiStage = 'generate';
  }
  const ai = quizSourcePreference === 'local' ? [] : (await _aiGenerateQuizQuestions(pool, requestId) || []);
  const local = quizSourcePreference === 'ai' ? [] : _generateQuizQuestions(pool);
  if (quizState) quizState.aiPending = false;
  if (ai.length) _saveQuizBank(pool, ai);
  if (quizState) {
    quizState.sourceMode = quizSourcePreference === 'ai'
      ? 'ai'
      : ai.length
        ? (local.length ? 'mixed' : 'ai')
        : 'local';
    const model = quizSourcePreference === 'local' ? null : _pickQuizModel();
    quizState.aiNotice = ai.length
      ? ''
      : quizSourcePreference === 'local'
        ? (local.length ? '当前为仅本地模式' : '当前为仅本地模式，但本地题不足')
        : (model ? 'AI 出题失败，已自动使用本地题；请检查出题模型/主模型的 API Key 和地址' : '未配置 AI 模型，已使用本地题');
  }
  return _mergeQuizQuestions(ai, local);
}

function _startQuizGeneration(pool) {
  const requestId = ++quizAiRequestId;
  if (quizAiController) quizAiController.abort();
  const local = quizSourcePreference === 'ai' ? [] : _generateQuizQuestions(pool);
  const model = quizSourcePreference === 'local' ? null : _pickQuizModel();
  const promise = model
    ? _aiGenerateQuizQuestions(pool, requestId).then(ai => {
        if (requestId !== quizAiRequestId || !quizState) return null;
        if (ai) quizState.aiNotice = '';
        if (ai && ai.length) _saveQuizBank(pool, ai);
        const merged = _mergeQuizQuestions(ai || [], local);
        if (merged.length >= 2) {
          quizState.questions = merged;
        }
        quizState.aiPending = false;
        quizState.aiProgress = 100;
        quizState.aiStage = '';
        quizState.sourceMode = quizSourcePreference === 'ai'
          ? 'ai'
          : ai && ai.length
            ? (local.length ? 'mixed' : 'ai')
            : 'local';
        if (!ai) {
          quizState.aiNotice = quizSourcePreference === 'ai'
            ? 'AI 出题失败，当前为仅AI模式，暂无可用题；请检查出题模型/主模型的 API Key 和地址'
            : local.length
              ? 'AI 出题失败，已自动使用本地题；请检查出题模型/主模型的 API Key 和地址'
              : 'AI 出题失败，且本地题不足；请检查出题模型/主模型的 API Key 和地址';
        }
        if (quizState.phase === 'intro') {
          renderQuiz();
        }
        return merged;
      }).catch(() => {
        if (quizState) {
          quizState.aiPending = false;
          quizState.aiProgress = 0;
          quizState.aiStage = '';
          quizState.sourceMode = quizSourcePreference === 'ai' ? 'ai' : 'local';
          quizState.aiNotice = quizSourcePreference === 'ai'
            ? 'AI 出题失败，当前为仅AI模式，暂无可用题；请检查出题模型/主模型的 API Key 和地址'
            : local.length
              ? 'AI 出题失败，已自动使用本地题；请检查出题模型/主模型的 API Key 和地址'
              : 'AI 出题失败，且本地题不足；请检查出题模型/主模型的 API Key 和地址';
        }
        return null;
      })
    : Promise.resolve(null).then(() => {
        if (requestId !== quizAiRequestId || !quizState) return null;
        quizState.aiPending = false;
        quizState.aiProgress = 0;
        quizState.aiStage = '';
        quizState.aiNotice = quizSourcePreference === 'ai'
          ? '未配置 AI 模型，当前为仅AI模式，暂无可用题'
          : quizSourcePreference === 'local'
            ? (local.length ? '当前为仅本地模式' : '当前为仅本地模式，但本地题不足')
            : '未配置 AI 模型，已使用本地题';
        quizState.sourceMode = quizSourcePreference === 'ai' ? 'ai' : 'local';
        if (quizState.phase === 'intro') renderQuiz();
        return null;
      });
  if (quizState) {
    quizState.aiPromise = promise;
    quizState.aiPending = true;
  }
  return { local, promise };
}
