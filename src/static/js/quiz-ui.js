/* ====== 知识检测：交互动作（开始/作答/解析/设置） ====== */

async function openQuiz(mode = 'session') {
  const overlay = document.getElementById('quizModal');
  if (!overlay) return;
  quizMode = mode === 'global' ? 'global' : 'session';
  quizScope = quizMode === 'global' ? 'all' : 'current';
  quizBankFilterSession = '';
  quizFilterTopic = 'all';
  overlay.hidden = false;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  quizState = { phase: 'loading' };
  renderQuiz();
  await _loadQuizStatsFromServer();
  await _loadQuizBankFromServer();
  _resetQuizPromptFile();
  try {
    const data = await _fetchQuizData();
    const pool = _buildQuizPool(data);
    quizBank = _readQuizBank();
    quizState = { phase: 'loading', pool };
    renderQuiz();
    const bankQuestions = quizSourcePreference !== 'local' ? _bankForPool(pool) : null;
    if (bankQuestions) {
      const local = quizSourcePreference === 'mixed' ? _generateQuizQuestions(pool) : [];
      const merged = _mergeQuizQuestions(bankQuestions, local);
      quizState = {
        phase: 'intro',
        pool,
        questions: merged,
        aiPromise: null,
        aiPending: false,
        aiProgress: 100,
        aiStage: '',
        aiNotice: '已使用AI题库' + bankQuestions.length + '题，无需重新生成'
          + (bankQuestions.length < quizTargetCount ? '；如需' + quizTargetCount + '题请点重新生成' : ''),
        sourceMode: quizSourcePreference === 'ai' ? 'ai' : (local.length ? 'mixed' : 'ai'),
        openQuestions: _generateOpenQuestions(pool),
        wrongList: _readWrongQuestions(),
        explaining: false,
        explainText: '',
        explainError: ''
      };
    } else {
      const generation = _startQuizGeneration(pool);
      quizState = {
        phase: 'intro',
        pool,
        questions: generation.local,
        aiPromise: generation.promise,
        aiPending: true,
        aiProgress: 0,
        aiStage: 'generate',
        aiNotice: '',
        sourceMode: 'local',
        openQuestions: _generateOpenQuestions(pool),
        wrongList: _readWrongQuestions(),
        explaining: false,
        explainText: '',
        explainError: ''
      };
    }
  } catch (e) {
    console.warn('Quiz build failed:', e);
    quizState = {
      phase: 'intro',
      pool: { knowledge: [], formulas: [] },
      questions: [],
      aiNotice: '',
      aiProgress: 0,
      aiStage: '',
      sourceMode: 'local',
      openQuestions: [],
      wrongList: [],
      explaining: false,
      explainText: '',
      explainError: ''
    };
  }
  renderQuiz();
}

async function openQuizGlobalDashboard() {
  const overlay = document.getElementById('quizModal');
  if (!overlay) return;
  quizFilterTopic = 'all';
  quizMode = 'global';
  quizScope = 'all';
  quizBankFilterSession = '';
  overlay.hidden = false;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  quizState = { phase: 'loading' };
  renderQuiz();
  await _loadQuizStatsFromServer();
  await _loadQuizBankFromServer();
  quizState = { phase: 'global' };
  renderQuiz();
}

async function openSessionQuizFromGlobal(sessionId) {
  const current = typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '';
  if (sessionId && sessionId !== current && typeof window.switchToSession === 'function') {
    await window.switchToSession(sessionId);
  }
  openQuiz('session');
}

function closeQuiz() {
  const overlay = document.getElementById('quizModal');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.hidden = true;
  }
  document.body.style.overflow = '';
}

// ====== 题库/错题跳转知识点后的“返回题库”入口 ======
let _quizReturnPillTimer = null;

function showQuizReturnPill() {
  hideQuizReturnPill();
  let pill = document.getElementById('quizReturnPill');
  if (!pill) {
    pill = document.createElement('div');
    pill.id = 'quizReturnPill';
    pill.className = 'quiz-return-pill';
    pill.innerHTML = '<button type="button" class="quiz-return-pill-btn" onclick="resumeQuizFromJump()"></button>'
      + '<button type="button" class="quiz-return-pill-close" onclick="hideQuizReturnPill()" aria-label="关闭" title="关闭">&times;</button>';
    document.body.appendChild(pill);
  }
  const label = quizReturnState && quizReturnState.phase === 'wrong' ? '返回错题' : '返回题库';
  const btn = pill.querySelector('.quiz-return-pill-btn');
  if (btn) btn.textContent = '⬅ ' + label;
  pill.hidden = false;
  pill.classList.add('active');
  if (_quizReturnPillTimer) clearTimeout(_quizReturnPillTimer);
  _quizReturnPillTimer = setTimeout(hideQuizReturnPill, 60000);
}

function hideQuizReturnPill() {
  if (_quizReturnPillTimer) { clearTimeout(_quizReturnPillTimer); _quizReturnPillTimer = null; }
  const pill = document.getElementById('quizReturnPill');
  if (pill) {
    pill.hidden = true;
    pill.classList.remove('active');
  }
}

async function resumeQuizFromJump() {
  hideQuizReturnPill();
  const overlay = document.getElementById('quizModal');
  if (!overlay) return;
  const phase = quizReturnState && quizReturnState.phase === 'wrong' ? 'wrong' : 'bank';
  overlay.hidden = false;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (quizState) {
    quizState.phase = phase;
    if (quizReturnState) {
      quizBankFilterSession = quizReturnState.filterSession || '';
      quizFilterTopic = quizReturnState.topic || 'all';
    }
    if (phase === 'wrong') quizState.wrongList = _readWrongQuestions();
    renderQuiz();
  } else {
    // 页面已刷新：重新打开并进入目标视图
    await openQuiz();
    if (phase === 'wrong') openWrongReview();
    else openQuizBank(quizReturnState ? quizReturnState.filterSession : '');
  }
  quizReturnState = null;
}

window.showQuizReturnPill = showQuizReturnPill;
window.hideQuizReturnPill = hideQuizReturnPill;
window.resumeQuizFromJump = resumeQuizFromJump;

// Esc 关闭/返回：与头部返回箭头同语义（intro/loading/global 关窗，其余回 intro）
if (!window._quizEscBound) {
  window._quizEscBound = true;
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const overlay = document.getElementById('quizModal');
    if (!overlay || overlay.hidden || !overlay.classList.contains('active')) return;
    handleQuizBack();
  });
}

function handleQuizBack() {
  if (!quizState) return;
  if (quizState.phase === 'loading' || quizState.phase === 'intro' || quizState.phase === 'global') {
    closeQuiz();
  } else {
    backToQuizIntro();
  }
}

async function startQuiz() {
  if (!quizState) return;
  if (quizState.aiPending && quizState.aiPromise) {
    quizState.phase = 'loading';
    renderQuiz();
    await quizState.aiPromise;
  }
  if (!quizState.questions || quizState.questions.length === 0) {
    quizState.phase = 'intro';
    renderQuiz();
    return;
  }
  if (quizState.questions.length > quizTargetCount) {
    quizState.questions = quizState.questions.slice(0, quizTargetCount);
  }
  quizState.phase = 'question';
  quizState.index = 0;
  quizState.answers = [];
  _resetQuizExplain();
  renderQuiz();
}

async function reshuffleQuiz(startAfter = true) {
  if (!quizState || !quizState.pool) return;
  quizState.phase = 'loading';
  if (quizSourcePreference !== 'local') {
    quizState.aiPending = true;
    quizState.aiProgress = 0;
    quizState.aiStage = 'generate';
  }
  renderQuiz();
  _resetQuizPromptFile();
  const questions = await _generateQuestions(quizState.pool);
  // null = 等待期间被新请求取代（如用户点了「立即用本地题」），状态已由新流程接管
  if (questions === null) return;
  quizState.questions = questions;
  if (!questions.length) {
    quizState.phase = 'intro';
    renderQuiz();
    return;
  }
  if (startAfter) startQuiz(); else renderQuiz();
}

async function addQuizBankQuestions() {
  if (!quizState || !quizState.pool) return;
  quizState.phase = 'loading';
  if (quizSourcePreference !== 'local') {
    quizState.aiPending = true;
    quizState.aiProgress = 0;
    quizState.aiStage = 'generate';
  }
  renderQuiz();
  _resetQuizPromptFile();
  const generated = await _generateQuestions(quizState.pool);
  // null = 被新请求取代，避免迟到的 phase 覆盖用户新状态
  if (generated === null) return;
  quizState.phase = 'bank';
  renderQuiz();
}

function redoQuiz() {
  startQuiz();
}

function openWrongReview() {
  if (!quizState) return;
  quizFilterTopic = 'all';
  quizState.phase = 'wrong';
  quizState.wrongList = _readWrongQuestions();
  renderQuiz();
}

function startWrongQuiz() {
  if (!quizState || !quizState.wrongList || quizState.wrongList.length === 0) {
    renderQuiz();
    return;
  }
  quizState.questions = quizState.wrongList.map((item, index) => ({
    id: item.id || 'wrong_' + index,
    type: item.type || 'choice',
    title: item.title || '',
    prompt: item.prompt || '',
    formulaText: item.formulaText || '',
    options: item.options || [],
    correctIndex: item.correctIndex || 0,
    explanation: item.explanation || '',
    refId: item.refId || '',
    sourceRef: item.sourceRef || item.refId || '',
    topicKey: item.topicKey || '',
    difficulty: item.difficulty || 'medium',
    sessionId: item.sessionId || ''
  }));
  quizState.phase = 'question';
  quizState.index = 0;
  quizState.answers = [];
  _resetQuizExplain();
  renderQuiz();
}

function startReviewQuiz() {
  if (!quizState || !quizState.pool) return;
  const review = _quizStatSummary().review;
  const dueKeys = new Set(review.map(item => item.key));
  const candidates = [
    ...(quizState.questions || []),
    ..._readWrongQuestions(),
    ..._generateQuizQuestions(quizState.pool)
  ];
  const picked = [];
  const seen = new Set();
  for (const q of candidates) {
    if (!q || !Array.isArray(q.options)) continue;
    const key = q.topicKey || _quizTopicStatsKey(q);
    if (!dueKeys.has(key)) continue;
    const sig = _quizSignature(q);
    if (seen.has(sig)) continue;
    seen.add(sig);
    picked.push(q);
    if (picked.length >= Math.min(5, quizTargetCount)) break;
  }
  if (!picked.length) {
    if (typeof showToast === 'function') showToast('暂时没有到期的复习内容');
    renderQuiz();
    return;
  }
  quizState.questions = picked;
  quizState.phase = 'question';
  quizState.index = 0;
  quizState.answers = [];
  _resetQuizExplain();
  renderQuiz();
}

function openOpenQuiz() {
  if (!quizState || !quizState.openQuestions || quizState.openQuestions.length === 0) {
    if (typeof showToast === 'function') showToast('暂时没有可用的深度问答题');
    return;
  }
  quizState.phase = 'open';
  quizState.openIndex = 0;
  quizState.openAnswers = [];
  quizState.openResults = [];
  quizState.openResult = null;
  quizState.openDraftAnswer = '';
  quizState.openScoring = false;
  quizState.openScoreError = '';
  renderQuiz();
}

function _saveOpenResult(question, answer, result) {
  const stats = _readQuizStats();
  stats._meta = {
    ...(stats._meta || {}),
    version: 2,
    updatedAt: Date.now()
  };
  const list = Array.isArray(stats._meta.openResults) ? stats._meta.openResults : [];
  list.push({
    id: 'open_' + Date.now(),
    questionId: question.id || '',
    title: question.title || '',
    prompt: question.prompt || '',
    answer,
    scores: result.scores || {},
    feedback: result.feedback || '',
    evidence: result.evidence || '',
    missing: result.missing || '',
    advice: result.advice || '',
    sessionId: question.sessionId || '',
    topicKey: question.topicKey || '',
    at: Date.now()
  });
  stats._meta.openResults = list.slice(-QUIZ_MAX_OPEN_RESULTS);
  _saveQuizStats(stats);
}

async function submitOpenAnswer() {
  if (!quizState || quizState.phase !== 'open' || quizState.openScoring) return;
  const textarea = document.getElementById('quizOpenAnswer');
  const answer = textarea ? textarea.value.trim() : '';
  if (!answer) {
    if (typeof showToast === 'function') showToast('先写下你的理解');
    return;
  }
  quizState.openDraftAnswer = answer;
  const question = quizState.openQuestions[quizState.openIndex];
  quizState.openScoring = true;
  quizState.openScoreError = '';
  renderQuiz();
  const result = await _scoreOpenAnswer(question, answer);
  quizState.openScoring = false;
  if (result && result.scores) {
    quizState.openResults.push({ questionId: question.id, answer, result });
    quizState.openResult = result;
    _saveOpenResult(question, answer, result);
  } else {
    quizState.openScoreError = result && result.error ? result.error : '模型评分失败';
  }
  renderQuiz();
}

function nextOpenQuestion() {
  if (!quizState || quizState.phase !== 'open') return;
  quizState.openResult = null;
  quizState.openDraftAnswer = '';
  quizState.openScoreError = '';
  if (quizState.openIndex < quizState.openQuestions.length - 1) {
    quizState.openIndex++;
    renderQuiz();
  } else {
    quizState.phase = 'open_result';
    renderQuiz();
  }
}

function _localScoreOpenAnswer(question, answer) {
  const context = (question && question.context) || {};
  const text = String(answer || '').trim();
  if (!text) return { error: '先写下你的理解' };
  const title = String(context.title || (question && question.title) || '');
  const summary = String(context.summary || '');
  const formulas = Array.isArray(context.formulas) ? context.formulas : [];
  const lower = text.toLowerCase();
  const terms = Array.from(new Set([
    ...title.split(/[\s,，。；;:：]+/),
    ...summary.split(/[\s,，。；;:：]+/)
  ])).filter(term => term.length >= 2);
  const hitTerms = terms.filter(term => lower.includes(term.toLowerCase())).length;
  const totalTerms = Math.max(1, terms.length);
  const coverage = Math.min(1, hitTerms / totalTerms);
  const hasConnectionWords = /物理|数学|联系|对应|映射|类比|边界|适用|原因|因为|所以|结构|直觉/.test(text);
  const hasFormulaMention = formulas.some(formula => {
    const compact = String(formula || '').replace(/\\/g, '').replace(/\s+/g, '');
    return compact && lower.replace(/\s+/g, '').includes(compact.toLowerCase());
  });
  const missing = [];
  if (!hasConnectionWords) missing.push('没有明显说明物理与数学之间的联系');
  if (!hasFormulaMention && formulas.length) missing.push('未引用相关公式');
  if (text.length < 60) missing.push('回答偏短，缺少展开');
  return {
    scores: {
      physics: Math.max(1, Math.min(10, Math.round(4 + coverage * 4 + (hasConnectionWords ? 1 : 0)))),
      math: Math.max(1, Math.min(10, Math.round(4 + coverage * 3 + (hasFormulaMention ? 2 : 0)))),
      connection: Math.max(1, Math.min(10, Math.round(3 + coverage * 3 + (hasConnectionWords ? 3 : 0)))),
      clarity: Math.max(1, Math.min(10, Math.round(3 + Math.min(4, text.length / 60) + (text.includes('\n') ? 1 : 0))))
    },
    feedback: '未配置出题模型，当前使用本地启发式评分。',
    evidence: `覆盖知识要点 ${hitTerms}/${totalTerms}${hasFormulaMention ? '，提及公式' : ''}。`,
    missing: missing.length ? missing.join('；') : '暂未发现明显遗漏',
    advice: missing.length ? '补充公式和适用边界，并说明物理直觉与数学结构如何对应。' : '继续保持，尝试加入适用边界或反例。'
  };
}

// 提取文本中首个平衡的 JSON 对象（考虑字符串内的花括号与转义）；找不到返回 null
function _firstJsonObject(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

async function _scoreOpenAnswer(question, answer) {
  const model = _pickQuizModel();
  if (!model) return _localScoreOpenAnswer(question, answer);
  const context = question.context || {};
  const formulas = Array.isArray(context.formulas) ? context.formulas.join('\n') : '';
  const knowledgeContext = `知识点：${context.title || question.title || ''}\n概述：${context.summary || ''}\n分类：${context.category || ''}\n相关公式：${formulas || '无'}`;
  const systemPrompt = `你是 PhyMathia 的深度问答评分老师。请基于提供的知识点上下文，评估学生的回答。
${getLevelPrompt()}
评分维度：
- physics：物理直觉是否准确、是否有物理意义
- math：数学结构是否准确、是否抓住关键量
- connection：是否讲清物理与数学之间的联系
- clarity：表达是否清晰、有条理
每个维度 1-10 整数。不要只看学生是否背出概念，要看是否解释“为什么”、是否体现数理联系、是否提到适用边界或反例。
只输出 JSON，不要输出其他内容：
{"scores":{"physics":7,"math":8,"connection":9,"clarity":8},"feedback":"一句到三句中文反馈","evidence":"得分的关键依据","missing":"学生没有覆盖的要点","advice":"下一步建议"}`;
  const userContent = `知识点上下文：\n${knowledgeContext}\n\n问题：${question.prompt}\n\n学生回答：\n${answer}\n\n请评分。`;
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 30000) : null;
  try {
    const resp = await fetch('/api/models/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        provider: model.provider,
        api_key: model.apiKey,
        model: model.model,
        base_url: model.baseUrl,
        stream: true
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await _readModelStream(resp);
    // 首个平衡花括号对象：贪婪 \{[\s\S]*\} 在模型输出多段 JSON
    // 或前后缀含 } 时会解析失败
    const data = _firstJsonObject(raw);
    if (!data) throw new Error('No JSON');
    const scores = data.scores || {};
    return {
      scores: {
        physics: Math.max(0, Math.min(10, Number(scores.physics) || 0)),
        math: Math.max(0, Math.min(10, Number(scores.math) || 0)),
        connection: Math.max(0, Math.min(10, Number(scores.connection) || 0)),
        clarity: Math.max(0, Math.min(10, Number(scores.clarity) || 0))
      },
      feedback: String(data.feedback || '').trim(),
      evidence: String(data.evidence || '').trim(),
      missing: String(data.missing || '').trim(),
      advice: String(data.advice || '').trim()
    };
  } catch (e) {
    console.warn('Open answer scoring failed:', e);
    return { ..._localScoreOpenAnswer(question, answer), feedback: 'AI 评分暂时不可用，已用本地启发式评分。' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function clearQuizRecords() {
  if (!confirm('确定清空所有知识检测记录吗？')) return;
  clearAllQuizStats();
  if (quizState) quizState.wrongList = [];
  renderQuiz();
}

function clearWrongQuestions() {
  if (!confirm('确定清空错题记录吗？')) return;
  const stats = _readQuizStats();
  if (stats._meta && Array.isArray(stats._meta.wrongQuestions)) {
    stats._meta.wrongQuestions = stats._meta.wrongQuestions.filter(item => !_quizItemInSession(item));
  }
  _saveQuizStats(stats);
  if (quizState) quizState.wrongList = [];
  renderQuiz();
}

function backToQuizIntro() {
  if (!quizState) return;
  if (quizMode === 'global') {
    quizState.phase = 'global';
    renderQuiz();
    return;
  }
  quizState.phase = 'intro';
  quizState.wrongList = _readWrongQuestions();
  renderQuiz();
}

function chooseQuizOption(key) {
  if (!quizState || quizState.phase !== 'question') return;
  const question = quizState.questions[quizState.index];
  if (!question || quizState.answers.some(a => a.questionId === question.id)) return;
  const selectedIndex = question.options.findIndex(o => o.key === key);
  if (selectedIndex < 0) return;
  const correct = selectedIndex === question.correctIndex;
  quizState.answers.push({ questionId: question.id, selectedIndex, correct });
  _recordQuizAnswer(question, correct);
  renderQuiz();
}

function nextQuizQuestion() {
  if (!quizState || quizState.phase !== 'question') return;
  const question = quizState.questions[quizState.index];
  if (!question || !quizState.answers.some(a => a.questionId === question.id)) return;
  if (quizState.index < quizState.questions.length - 1) {
    quizState.index++;
    _resetQuizExplain();
    renderQuiz();
  } else {
    _resetQuizExplain();
    quizState.phase = 'result';
    renderQuiz();
  }
}

function _resetQuizExplain() {
  if (!quizState) return;
  quizState.explaining = false;
  quizState.explainText = '';
  quizState.explainError = '';
}

async function _readModelStream(resp, onProgress) {
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
          if (data.error) throw new Error(data.error.detail || data.error.message || JSON.stringify(data.error));
          const choice = data.choices?.[0];
          const part = choice?.delta?.content || choice?.message?.content || '';
          if (part) content += part;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
    if (typeof onProgress === 'function') onProgress(content.length);
  }
  // 兜底：代理有时以普通 JSON（非 SSE）返回错误，如 {"detail":"..."}。
  // 此时上面逐行解析收不到任何 content，若静默返回空串，上层只会报“出题失败”
  // 却不知道原因。这里显式抛出，让失败原因透出到界面。
  if (!content) {
    const trimmed = buffer.trim();
    if (trimmed.startsWith('{')) {
      try {
        const j = JSON.parse(trimmed);
        const detail = j.detail || j.error && (j.error.message || JSON.stringify(j.error)) || '';
        if (detail) throw new Error(String(detail));
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
    if (trimmed) throw new Error('上游返回非流式内容：' + trimmed.slice(0, 120));
  }
  return content;
}

function _localQuizExplain(question) {
  const correct = question.options[question.correctIndex] ? question.options[question.correctIndex].text : '';
  return `${question.explanation}\n\n正确答案：${correct}`;
}

async function askQuizExplain() {
  if (!quizState || quizState.phase !== 'question' || quizState.explaining) return;
  const question = quizState.questions[quizState.index];
  const questionId = question && question.id;
  // 完成时校验仍是同一道题：等待期间用户答完点「下一题」后，迟到的解析
  // 直接丢弃，避免上一题的解析显示在下一题下方（串题）
  const stillSameQuestion = () =>
    quizState && quizState.phase === 'question' &&
    quizState.questions[quizState.index] && quizState.questions[quizState.index].id === questionId;
  const optionLines = question.options
    .map(option => `${option.key}. ${_quizCleanText(option.text, 220)}`)
    .join('\n');
  const formulaLine = question.formulaText ? `\n公式：${question.formulaText}` : '';
  const prompt = `题目：${question.prompt}${formulaLine}\n选项：\n${optionLines}\n\n我没看懂这道题，请解析。`;
  quizState.explaining = true;
  quizState.explainText = '';
  quizState.explainError = '';
  renderQuiz();

  const model = typeof _pickQuizModel === 'function' ? _pickQuizModel() : null;
  if (!model) {
    if (!stillSameQuestion()) return;
    quizState.explaining = false;
    quizState.explainText = _localQuizExplain(question);
    renderQuiz();
    return;
  }

  try {
    const resp = await fetch('/api/models/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [
          {
            role: 'system',
            content: '你是 PhyMathia。用户只要求解析知识检测中的一道题。请用简洁中文直接解析，不要生成完整学习卡片，不要输出 XML 标签，不要生成知识图谱、HTML 可视化或延伸思考。\n\n' + getLevelPrompt()
          },
          { role: 'user', content: prompt }
        ],
        provider: model.provider,
        api_key: model.apiKey,
        model: model.model,
        base_url: model.baseUrl,
        stream: true
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await _readModelStream(resp);
    if (!stillSameQuestion()) return;
    const cleaned = String(raw || '')
      .replace(/<[^>]*>/g, '')
      .replace(/```html[\s\S]*?```/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    quizState.explaining = false;
    quizState.explainText = cleaned || _localQuizExplain(question);
    quizState.explainError = '';
  } catch (e) {
    console.warn('Quiz explain failed:', e);
    if (!stillSameQuestion()) return;
    quizState.explaining = false;
    quizState.explainText = _localQuizExplain(question);
    quizState.explainError = 'AI 暂时不可用，已显示本地解析';
  }
  renderQuiz();
}

function changeQuizQuestionCount() {
  const select = document.getElementById('quizCountSelect');
  const count = parseInt(select && select.value, 10);
  if (!count || count < 3 || count > 10 || count === quizTargetCount) return;
  quizTargetCount = count;
  if (quizState && quizState.pool && quizState.phase === 'intro') reshuffleQuiz(false);
}

function changeQuizScope(value) {
  if (value === 'all') {
    quizMode = 'global';
    quizScope = 'all';
    openQuiz('global');
  } else {
    quizMode = 'session';
    quizScope = 'current';
    openQuiz('session');
  }
}

function changeQuizSourcePreference(value) {
  const next = value === 'ai' || value === 'local' ? value : 'mixed';
  if (quizSourcePreference === next) return;
  quizSourcePreference = next;
  try {
    localStorage.setItem('phymathia_quiz_source', next);
  } catch (e) {}
  if (quizState && quizState.pool) openQuiz();
}

function openQuizBank(filterSession = '') {
  if (!quizState) return;
  quizBankFilterSession = filterSession || '';
  quizState.phase = 'bank';
  renderQuiz();
}

function startBankQuiz() {
  if (!quizState) return;
  const questions = _quizBankQuestions();
  if (!questions.length) {
    if (typeof showToast === 'function') showToast('题库还没有AI题');
    return;
  }
  // 洗牌后截取：反复「用题库开始」不再恒定命中同一批题（与本地题行为一致）
  quizState.questions = _quizShuffle(questions).slice(0, quizTargetCount);
  quizState.phase = 'question';
  quizState.index = 0;
  quizState.answers = [];
  _resetQuizExplain();
  renderQuiz();
}

function useLocalQuiz() {
  if (!quizState) return;
  quizAiRequestId++;
  if (quizAiController) quizAiController.abort();
  quizState.aiPending = false;
  quizState.aiPromise = null;
  quizState.questions = _generateQuizQuestions(quizState.pool || { knowledge: [], formulas: [] });
  if (!quizState.questions.length) {
    if (typeof showToast === 'function') showToast('本地题不足，暂无法生成');
    renderQuiz();
    return;
  }
  startQuiz();
}

function filterWrongByTopic(value) {
  const topic = value === 'all' ? 'all' : decodeURIComponent(value || '');
  quizFilterTopic = topic;
  if (!quizState) return;
  quizState.wrongList = _readWrongQuestions().filter(item => topic === 'all' || item.topicKey === topic);
  renderQuiz();
}

function deleteWrongQuestion(encodedKey) {
  const target = decodeURIComponent(encodedKey || '');
  const stats = _readQuizStats();
  if (stats._meta && Array.isArray(stats._meta.wrongQuestions)) {
    stats._meta.wrongQuestions = stats._meta.wrongQuestions.filter(item => _wrongQuestionKey(item) !== target);
  }
  _saveQuizStats(stats);
  if (quizState) {
    quizState.wrongList = _readWrongQuestions().filter(item => quizFilterTopic === 'all' || item.topicKey === quizFilterTopic);
  }
  renderQuiz();
}
