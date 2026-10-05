/* ====== 知识检测：面板渲染与导出 ====== */

function _renderQuizIntro() {
  const body = document.getElementById('quizBody');
  const stats = _quizStatSummary();
  const hasQuestions = !!(quizState && quizState.questions && quizState.questions.length);
  const hasOpen = !!(quizState && quizState.openQuestions && quizState.openQuestions.length);
  const hasWrong = stats.wrongCount > 0;
  const bankCount = _quizBankQuestions().length;
  if (!hasQuestions && !(quizState && quizState.aiPending)) {
    body.innerHTML = `
      <div class="quiz-empty">
        <div class="quiz-empty-icon">${UI_ICON_SVG.book}</div>
        <div class="quiz-empty-title">还没有足够的知识条目</div>
        ${quizState && quizState.aiNotice ? `<div class="quiz-ai-status">${_quizEscape(quizState.aiNotice)}</div>` : ''}
        <div class="quiz-empty-actions">
          <button class="quiz-btn-primary" onclick="closeQuiz();toggleKnowledgePanel()">打开知识总览</button>
          ${quizSourcePreference === 'ai' ? '<button class="quiz-btn-secondary" onclick="changeQuizSourcePreference(\'local\')">切换到本地题</button>' : ''}
          ${hasOpen ? '<button class="quiz-btn-primary" onclick="openOpenQuiz()">深度问答</button>' : ''}
          ${hasWrong ? `<button class="quiz-btn-primary" onclick="openWrongReview()">错题回顾(${hasWrong})</button>` : ''}
        </div>
      </div>`;
    return;
  }
  if (!hasQuestions && quizState && quizState.aiPending) {
    body.innerHTML = `
      <div class="quiz-ai-status">
        <div class="quiz-ai-progress"><div class="quiz-ai-progress-fill" style="width:${quizState.aiProgress || 5}%"></div></div>
        <span>${_quizEscape(quizAiStatusText || 'AI 正在生成检测题…')}</span>
        <button class="quiz-btn-secondary" onclick="useLocalQuiz()">立即用本地题</button>
      </div>`;
    return;
  }
  const countOptions = [3, 5, 8, 10].map(n =>
    `<option value="${n}" ${n === quizTargetCount ? 'selected' : ''}>${n} 题</option>`
  ).join('');
  const quizModel = _pickQuizModel();
  const quizModelLabel = quizModel ? (quizModel.label || quizModel.model || quizModel.provider) : '本地出题（未配置 AI 模型）';
  const entryLabel = quizMode === 'global' ? '跨画布检测' : '画布检测';
  const sourceModeLabel = quizState && quizState.aiPending
    ? 'AI 生成中'
    : quizState && quizState.sourceMode === 'ai'
      ? 'AI题'
      : quizState && quizState.sourceMode === 'mixed'
        ? 'AI+本地题'
        : '本地题';
  body.innerHTML = `
    <div class="quiz-stats">
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.total}</span><span class="quiz-stat-label">已测</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.rate}%</span><span class="quiz-stat-label">正确率</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.reviewCount}</span><span class="quiz-stat-label">待复习</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.openCount}</span><span class="quiz-stat-label">深度问答</span></div>
    </div>
    <div class="quiz-model-note">当前入口：${_quizEscape(entryLabel)}</div>
    <div class="quiz-model-note">当前出题/评分模型：${_quizEscape(quizModelLabel)}</div>
    <div class="quiz-model-note">当前题目类型：${_quizEscape(sourceModeLabel)}</div>
    ${quizState && quizState.aiPending ? `<div class="quiz-ai-status">
      <div class="quiz-ai-progress"><div class="quiz-ai-progress-fill" style="width:${quizState.aiProgress || 5}%"></div></div>
      <span>${_quizEscape(quizAiStatusText || 'AI 正在生成检测题…')}</span>
      <button class="quiz-btn-secondary" onclick="useLocalQuiz()">立即用本地题</button>
    </div>` : ''}
    ${quizState && quizState.aiNotice ? `<div class="quiz-ai-status">${_quizEscape(quizState.aiNotice)}</div>` : ''}
    <div class="quiz-setting-row">
      <span>题源</span>
      <select id="quizSourceSelect" onchange="changeQuizSourcePreference(this.value)">
        <option value="ai" ${quizSourcePreference === 'ai' ? 'selected' : ''}>仅AI</option>
        <option value="mixed" ${quizSourcePreference === 'mixed' ? 'selected' : ''}>AI+本地</option>
        <option value="local" ${quizSourcePreference === 'local' ? 'selected' : ''}>仅本地</option>
      </select>
      <span>题量</span>
      <select id="quizCountSelect" onchange="changeQuizQuestionCount()" title="改变题量会重新生成一组题（AI 模式下会调用一次模型）">${countOptions}</select>
    </div>
    <div class="quiz-start">
      <button class="quiz-btn-primary quiz-btn-large" onclick="startQuiz()" ${hasQuestions ? '' : 'disabled'}>开始检测</button>
      <button class="quiz-btn-primary" onclick="reshuffleQuiz()" ${hasQuestions ? '' : 'disabled'} title="重新生成一组 AI 题（会调用一次模型）；不会删除AI题库">换一组题</button>
      <button class="quiz-btn-primary" onclick="openOpenQuiz()" ${hasOpen ? '' : 'disabled'}>深度问答${stats.openCount ? `(${stats.openCount})` : ''}</button>
      <button class="quiz-btn-primary" onclick="openWrongReview()" ${hasWrong ? '' : 'disabled'}>错题回顾${hasWrong ? `(${hasWrong})` : ''}</button>
      ${stats.reviewCount ? `<button class="quiz-btn-primary" onclick="startReviewQuiz()">开始复习(${stats.reviewCount})</button>` : ''}
      ${bankCount ? `<button class="quiz-btn-secondary" onclick="openQuizBank()">AI题库(${bankCount})</button>` : ''}
      <button class="quiz-btn-secondary" onclick="clearQuizRecords()">清空记录</button>
    </div>`;
}

function _renderQuizQuestion() {
  const body = document.getElementById('quizBody');
  if (!quizState) return;
  const question = quizState.questions[quizState.index];
  const answered = quizState.answers.find(a => a.questionId === question.id);
  const progress = Math.round((quizState.index + (answered ? 1 : 0)) / quizState.questions.length * 100);
  const difficultyLabels = { easy: '易', medium: '中', hard: '难' };
  const sourceModeLabel = quizState.sourceMode === 'ai' ? 'AI题' : quizState.sourceMode === 'mixed' ? 'AI+本地题' : '本地题';
  const metaHtml = `<div class="quiz-question-meta">
    <span class="quiz-tag">${difficultyLabels[question.difficulty] || '中'}</span>
    <span class="quiz-tag">${question.sourceType === 'formula' ? '公式' : '知识点'}</span>
    <span class="quiz-tag">${sourceModeLabel}</span>
    <span class="quiz-tag">${_quizEscape(question.title || '检测题')}</span>
  </div>`;
  const optionsHtml = question.options.map((option, index) => {
    let className = 'quiz-option';
    let disabled = '';
    if (answered) {
      if (index === question.correctIndex) className += ' correct';
      else if (index === answered.selectedIndex) className += ' wrong';
      disabled = ' disabled';
    }
    const content = option.html || _quizInlineRichText(_quizHumanizeQuestionText(option.text, question));
    return `<button class="${className}" onclick="chooseQuizOption('${option.key}')"${disabled}>
      <span class="quiz-option-key">${option.key}</span>
      <span class="quiz-option-body">${content}</span>
    </button>`;
  }).join('');
  const feedback = answered ? `
    <div class="quiz-feedback ${answered.correct ? 'ok' : 'bad'}">
      <strong>${answered.correct ? '回答正确' : '回答错误'}</strong>
      <div>${_renderQuizRichText(_quizHumanizeQuestionText(question.explanation, question))}</div>
    </div>
    <button class="quiz-btn-primary" onclick="nextQuizQuestion()">${quizState.index === quizState.questions.length - 1 ? '查看结果' : '下一题'}</button>
  ` : '';
  const explainHtml = quizState.explaining
    ? '<div class="quiz-explain quiz-explain-loading"><div class="kp-spinner"></div><span>正在问 Phymathia...</span></div>'
    : quizState.explainText
      ? `<div class="quiz-explain">
          <div class="quiz-explain-head">Phymathia 解析</div>
          <div class="quiz-explain-content">${_renderQuizRichText(quizState.explainText)}</div>
          ${quizState.explainError ? `<div class="quiz-explain-error">${_quizEscape(quizState.explainError)}</div>` : ''}
        </div>`
      : '';
  body.innerHTML = `
    <div class="quiz-progress-top">
      <span>第 ${quizState.index + 1} / ${quizState.questions.length} 题</span>
      <span>${progress}%</span>
    </div>
    <div class="quiz-progress"><div class="quiz-progress-fill" style="width:${progress}%"></div></div>
    <div class="quiz-question">
      <div class="quiz-question-prompt">${_renderQuizRichText(_quizHumanizeQuestionText(question.prompt, question))}</div>
      ${question.promptHtml ? `<div class="quiz-latex">${question.promptHtml}</div>` : ''}
      ${metaHtml}
      <div class="quiz-options">${optionsHtml}</div>
      <div class="quiz-question-help">
        <button class="quiz-help-btn" onclick="askQuizExplain()" ${quizState.explaining ? 'disabled' : ''}>${quizState.explaining ? '正在问 Phymathia...' : '这题没看懂，问 Phymathia'}</button>
        ${question.sourceRef ? `<button class="quiz-help-btn" onclick="jumpQuizToSource('${encodeURIComponent(question.id)}')">${_quizSourceJumpLabel(question)}</button>` : ''}
      </div>
      ${explainHtml}
      ${feedback}
    </div>`;
}

// 正确率环形图（M2 视觉修正）：旧版 .quiz-score-ring 是「35% 透明圆环 + 一段强调色」的
// 装饰性静态圈——不管 0% 还是 100% 都长一样，等于画了个假的统计图。现在按真实比例画：
// 扇形角度 = 正确率，颜色按档位（≥80 绿 / ≥60 黄 / 其余红），中心是百分比，「错」的那段
// 单独一色，等于一张「对/错」两段饼图。抽成纯函数便于 smoke 断言。
function _quizScoreTone(rate) {
  if (rate >= 80) return 'good';
  if (rate >= 60) return 'mid';
  return 'low';
}

function _quizScoreRingHtml(rate, correct, wrong) {
  const safe = Math.max(0, Math.min(100, Math.round(Number(rate) || 0)));
  const right = Math.max(0, Number(correct) || 0);
  const bad = Math.max(0, Number(wrong) || 0);
  const tone = _quizScoreTone(safe);
  const total = right + bad;
  return `
      <div class="quiz-score-ring tone-${tone}" style="--p:${safe}" role="img"
           aria-label="正确率 ${safe}%，答对 ${right} 题，答错 ${bad} 题">
        <span class="quiz-score-value">${safe}<small>%</small></span>
        <span class="quiz-score-label">正确率</span>
      </div>
      <div class="quiz-score-meta">
        <span class="quiz-score-chip ok">答对 ${right}</span>
        <span class="quiz-score-chip bad">答错 ${bad}</span>
        ${total ? `<span class="quiz-score-total">共 ${total} 题</span>` : ''}
      </div>`;
}

// 单会话的正确率小结环（全局概览的会话卡用）：同一套扇形口径，只是尺寸小一号
function _quizSessionRateRingHtml(rate) {
  const safe = Math.max(0, Math.min(100, Math.round(Number(rate) || 0)));
  return `<div class="quiz-score-ring is-mini tone-${_quizScoreTone(safe)}" style="--p:${safe}"
       role="img" aria-label="正确率 ${safe}%">
      <span class="quiz-score-value">${safe}<small>%</small></span>
      <span class="quiz-score-label">正确率</span>
    </div>`;
}

function _renderQuizResult() {
  const body = document.getElementById('quizBody');
  if (!quizState) return;
  const total = quizState.questions.length;
  const correct = quizState.answers.filter(a => a.correct).length;
  const rate = total ? Math.round(correct / total * 100) : 0;
  const stats = _quizStatSummary();
  const hasOpen = !!(quizState && quizState.openQuestions && quizState.openQuestions.length);
  const weakHtml = stats.review.length ? `
    <div class="quiz-weak-section">
      <div class="quiz-weak-title">建议复习</div>
      <div class="quiz-weak-list">
        ${stats.review.map(item => `
          <div class="quiz-weak-item">
            <div class="quiz-weak-item-main">
              <span>${_quizEscape(item.title)}</span>
              <span>掌握度 ${item.mastery || 0}% · ${item.wrong} 次答错 · ${item.dueAt ? '下次复习 ' + _quizDueLabel(item.dueAt) : '等待安排'}</span>
            </div>
            <div class="quiz-weak-item-actions">
              <button class="quiz-help-btn" onclick="quizLocateTopic('${encodeURIComponent(item.key || '')}')" title="跳到画布上这个知识点的位置（看完可返回）">定位到画布</button>
              <button class="quiz-help-btn" onclick="quizRetestTopic('${encodeURIComponent(item.key || '')}')" title="只按这个主题重新组一组题">重测同类题</button>
            </div>
          </div>`).join('')}
      </div>
    </div>
  ` : '<div class="quiz-weak-empty">本组没有待复习条目</div>';
  body.innerHTML = `
    <div class="quiz-result">
      ${_quizScoreRingHtml(rate, correct, total - correct)}
      ${weakHtml}
      <div class="quiz-result-actions">
        <button class="quiz-btn-primary" onclick="reshuffleQuiz()" title="不会删除AI题库，仅重新生成当前这一组题">换一组题</button>
        <button class="quiz-btn-primary" onclick="redoQuiz()">重做本组</button>
        <button class="quiz-btn-secondary" onclick="openWrongReview()">错题回顾${stats.wrongCount ? `(${stats.wrongCount})` : ''}</button>
        ${stats.reviewCount ? `<button class="quiz-btn-primary" onclick="startReviewQuiz()">开始复习(${stats.reviewCount})</button>` : ''}
        <button class="quiz-btn-secondary" onclick="openOpenQuiz()" ${hasOpen ? '' : 'disabled'}>深度问答${stats.openCount ? `(${stats.openCount})` : ''}</button>
      </div>
    </div>`;
}

function _renderQuizBank() {
  const body = document.getElementById('quizBody');
  const questions = _quizBankQuestions();
  if (!questions.length) {
    body.innerHTML = `
      <div class="quiz-empty">
        <div class="quiz-empty-icon">${UI_ICON_SVG.book}</div>
        <div class="quiz-empty-title">题库还没有AI题</div>
        <div class="quiz-empty-actions">
          <button class="quiz-btn-primary" onclick="addQuizBankQuestions()">生成AI题</button>
          <button class="quiz-btn-secondary" onclick="backToQuizIntro()">返回</button>
        </div>
      </div>`;
    return;
  }
  const itemsHtml = questions.map((q, index) => {
    const correct = q.options && q.options[q.correctIndex] ? q.options[q.correctIndex].text : '';
    const optionsHtml = (q.options || []).map(option => `
      <div class="quiz-wrong-line">
        <span>${option.key}</span>
        <span>${option.html || _renderQuizRichText(_quizHumanizeQuestionText(option.text, q))}</span>
      </div>
    `).join('');
    const formulaHtml = q.formulaText ? `<div class="quiz-wrong-formula">${_quizFormulaHtml(q.formulaText)}</div>` : '';
    return `
      <div class="quiz-wrong-card">
        <div class="quiz-wrong-title-row">
          <div class="quiz-wrong-title">${index + 1}. ${_quizEscape(q.title || 'AI题')}</div>
          <span class="quiz-tag">${_quizEscape(q.difficulty || 'medium')}</span>
          <button class="quiz-wrong-delete" onclick="deleteQuizBankQuestion('${encodeURIComponent(q.id || '')}')" title="移除该题">移除</button>
        </div>
        <div class="quiz-wrong-prompt">${_renderQuizRichText(_quizHumanizeQuestionText(q.prompt, q))}</div>
        ${formulaHtml}
        <div class="quiz-wrong-options">${optionsHtml}</div>
        <div class="quiz-wrong-line correct"><span>正确答案</span>${_renderQuizRichText(_quizHumanizeQuestionText(correct, q))}</div>
        <div class="quiz-wrong-explain">${_renderQuizRichText(_quizHumanizeQuestionText(q.explanation, q))}</div>
        ${q.sourceRef ? `<button class="quiz-help-btn" onclick="jumpQuizToSource('${encodeURIComponent(q.id)}')">${_quizSourceJumpLabel(q)}</button>` : ''}
      </div>`;
  }).join('');
  body.innerHTML = `
    <div class="quiz-back-bar">
      <button class="quiz-btn-secondary" onclick="backToQuizIntro()">← 返回</button>
      <button class="quiz-btn-primary" onclick="addQuizBankQuestions()" title="补充 AI 题（会调用一次模型）">补充AI题</button>
    </div>
    <div class="quiz-wrong-head"><span>${quizBankFilterSession ? '画布题库' : (quizMode === 'global' ? '全局题库' : '画布题库')}</span><span>${questions.length} 题</span></div>
    <div class="quiz-wrong-list">${itemsHtml}</div>
    <div class="quiz-result-actions">
      <button class="quiz-btn-primary" onclick="startBankQuiz()">用题库开始</button>
      <button class="quiz-btn-secondary" onclick="backToQuizIntro()">返回</button>
    </div>`;
}

function _quizSessionChartSegments(sessions, rawStats) {
  const colors = ['var(--node-question)', 'var(--node-physics)', 'var(--node-answer)', 'var(--node-learn)',
    'var(--chart-seg-cyan)', 'var(--node-socratic)', 'var(--node-knowledge)', 'var(--chart-seg-warm)'];
  const segments = [];
  sessions.forEach((session, idx) => {
    const id = session.id || session.sessionId || '';
    const variants = new Set(_quizSessionIdVariants(id));
    let correct = 0;
    let wrong = 0;
    for (const [key, item] of Object.entries(rawStats)) {
      if (key === '_meta' || !item || typeof item !== 'object') continue;
      if (!variants.has(item.sessionId || '')) continue;
      correct += item.correct || 0;
      wrong += item.wrong || 0;
    }
    const total = correct + wrong;
    if (!total) return;
    segments.push({
      label: session.title || id,
      value: total,
      correctRate: Math.round(correct / total * 100),
      color: colors[idx % colors.length]
    });
  });
  return segments;
}

function _quizPieHtml(segments) {
  if (!segments.length) return '<div class="quiz-chart-empty">暂无答题数据</div>';
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  let acc = 0;
  const stops = segments.map(segment => {
    const start = Math.round(acc / total * 100);
    acc += segment.value;
    const end = Math.round(acc / total * 100);
    return `${segment.color} ${start}% ${end}%`;
  }).join(', ');
  const legend = segments.map(segment => `
    <div class="quiz-chart-legend-item">
      <span style="background:${segment.color}"></span>
      ${_quizEscape(segment.label)} · 已测 ${segment.value} 题 · 正确率 ${segment.correctRate}%
    </div>
  `).join('');
  return `<div class="quiz-chart-pie" style="background:conic-gradient(${stops})"></div><div class="quiz-chart-legend">${legend}</div>`;
}

function _quizTrendData() {
  const stats = _readQuizStats();
  const history = [];
  for (const [key, item] of Object.entries(stats)) {
    if (key === '_meta' || !item || typeof item !== 'object') continue;
    for (const entry of (item.history || [])) {
      if (entry && entry.at) history.push({ at: entry.at, correct: entry.correct ? 1 : 0 });
    }
  }
  history.sort((a, b) => a.at - b.at);
  return history.slice(-20);
}

function _quizLineHtml(history) {
  if (history.length < 2) return '<div class="quiz-chart-empty">答题数据不足，无法生成趋势</div>';
  const width = 340;
  const height = 120;
  const padLeft = 34;
  const padRight = 10;
  const padTop = 10;
  const padBottom = 22;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  let correctCount = 0;
  const points = history.map((entry, index) => {
    correctCount += entry.correct;
    const rate = correctCount / (index + 1);
    const x = padLeft + index / (history.length - 1) * plotWidth;
    const y = padTop + (1 - rate) * plotHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  return `<svg class="quiz-line-chart" viewBox="0 0 ${width} ${height}">
    <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" style="stroke:var(--chart-axis)" stroke-width="1"/>
    <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" style="stroke:var(--chart-axis)" stroke-width="1"/>
    <text x="${padLeft - 6}" y="${padTop + 4}" fill="currentColor" font-size="9" text-anchor="end">100%</text>
    <text x="${padLeft - 6}" y="${height - padBottom + 4}" fill="currentColor" font-size="9" text-anchor="end">0%</text>
    <polyline points="${points}" fill="none" style="stroke:var(--node-question)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function _renderQuizGlobalDashboard() {
  const body = document.getElementById('quizBody');
  const stats = _quizStatSummary('global');
  const bankQuestions = _quizBankQuestions();
  const sessions = typeof window.getAllSessions === 'function' ? window.getAllSessions() : [];
  const rawStats = _readQuizStats();
  const chartSegments = _quizSessionChartSegments(sessions, rawStats);
  const trendHistory = _quizTrendData();
  const sessionCards = sessions.map(session => {
    const id = session.id || session.sessionId || '';
    const variants = new Set(_quizSessionIdVariants(id));
    let correct = 0;
    let wrong = 0;
    for (const [key, item] of Object.entries(rawStats)) {
      if (key === '_meta' || !item || typeof item !== 'object') continue;
      if (!variants.has(item.sessionId || '')) continue;
      correct += item.correct || 0;
      wrong += item.wrong || 0;
    }
    const total = correct + wrong;
    const rate = total ? Math.round(correct / total * 100) : 0;
    const bankCount = bankQuestions.filter(q => q && variants.has(q.sessionId || '')).length;
    const title = session.title || session.id || '未命名画布';
    return `
      <div class="quiz-global-session-card">
        ${_quizSessionRateRingHtml(rate)}
        <div class="quiz-global-session-body">
          <div class="quiz-global-session-title">${_quizEscape(title)}</div>
          <div class="quiz-global-session-stats">已测 ${total} · 错题 ${wrong} · 题库 ${bankCount}</div>
          <div class="quiz-global-actions">
            <button class="quiz-btn-primary" onclick="openSessionQuizFromGlobal('${encodeURIComponent(id)}')">查看答题</button>
            <button class="quiz-btn-secondary" onclick="openQuizBank('${encodeURIComponent(id)}')">查看题库</button>
          </div>
        </div>
      </div>`;
  }).join('');
  body.innerHTML = `
    <div class="quiz-stats">
      <div class="quiz-stat"><span class="quiz-stat-num">${sessions.length}</span><span class="quiz-stat-label">画布</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.total}</span><span class="quiz-stat-label">已测</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.rate}%</span><span class="quiz-stat-label">正确率</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.reviewCount}</span><span class="quiz-stat-label">待复习</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${bankQuestions.length}</span><span class="quiz-stat-label">AI题库</span></div>
    </div>
    <div class="quiz-charts">
      <div class="quiz-chart-card">
        <div class="quiz-chart-title">各画布答题量占比<span class="quiz-chart-sub">扇形角度=已测题数，正确率见图例</span></div>
        ${_quizPieHtml(chartSegments)}
      </div>
      <div class="quiz-chart-card">
        <div class="quiz-chart-title">最近答题趋势</div>
        ${_quizLineHtml(trendHistory)}
      </div>
    </div>
    <div class="quiz-global-actions">
      <button class="quiz-btn-primary" onclick="openQuiz('global')">全局出题</button>
      <button class="quiz-btn-secondary" onclick="openQuizBank()">全局题库</button>
      <button class="quiz-btn-secondary" onclick="openWrongReview()">全局错题</button>
    </div>
    <div class="quiz-global-title">画布答题概览</div>
    <div class="quiz-global-session-list">${sessionCards || '<div class="quiz-weak-empty">暂无画布</div>'}</div>`;
}

function _renderWrongReview() {
  const body = document.getElementById('quizBody');
  const list = quizState && quizState.wrongList && quizState.wrongList.length
    ? quizState.wrongList
    : _readWrongQuestions();
  if (!list.length) {
    const emptyTitle = quizFilterTopic !== 'all' ? '当前筛选下没有错题' : '暂时没有错题';
    body.innerHTML = `
      <div class="quiz-empty">
        <div class="quiz-empty-icon">${UI_ICON_SVG.check}</div>
        <div class="quiz-empty-title">${emptyTitle}</div>
        <div class="quiz-empty-actions">
          <button class="quiz-btn-primary" onclick="backToQuizIntro()">返回</button>
        </div>
      </div>`;
    return;
  }
  const topics = Array.from(new Set(list.map(item => item.topicKey || 'other')));
  const topicLabels = {};
  for (const item of list) {
    const topic = item.topicKey || 'other';
    if (!topicLabels[topic]) topicLabels[topic] = item.title || '其他';
  }
  const topicOptions = [
    `<option value="all" ${quizFilterTopic === 'all' ? 'selected' : ''}>全部知识点</option>`,
    ...topics.map(topic =>
      `<option value="${encodeURIComponent(topic)}" ${quizFilterTopic === topic ? 'selected' : ''}>${_quizEscape(topicLabels[topic] || topic)}</option>`
    )
  ].join('');
  const itemsHtml = list.map((item, index) => {
    const correct = item.options && item.options[item.correctIndex]
      ? item.options[item.correctIndex].text
      : '';
    const yourAnswer = item.selectedIndex >= 0 && item.options && item.options[item.selectedIndex]
      ? item.options[item.selectedIndex].text
      : '未作答';
    const formulaHtml = item.formulaText ? `<div class="quiz-wrong-formula">${_quizFormulaHtml(item.formulaText)}</div>` : '';
    const wrongTime = item.wrongAt ? new Date(item.wrongAt).toLocaleString('zh-CN', { hour12: false }) : '';
    return `
      <div class="quiz-wrong-card">
        <div class="quiz-wrong-title-row">
          <div class="quiz-wrong-title">${index + 1}. ${_quizEscape(item.title || '错题')}</div>
          <button class="quiz-wrong-delete" onclick="deleteWrongQuestion('${encodeURIComponent(_wrongQuestionKey(item))}')" title="移除该题">移除</button>
        </div>
        <div class="quiz-wrong-prompt">${_renderQuizRichText(_quizHumanizeQuestionText(item.prompt, item))}</div>
        ${formulaHtml}
        <div class="quiz-wrong-line"><span>你的答案</span>${_quizInlineRichText(_quizHumanizeQuestionText(yourAnswer, item))}</div>
        <div class="quiz-wrong-line correct"><span>正确答案</span>${_quizInlineRichText(_quizHumanizeQuestionText(correct, item))}</div>
        <div class="quiz-wrong-explain">${_renderQuizRichText(_quizHumanizeQuestionText(item.explanation, item))}</div>
        ${item.sourceRef ? `<button class="quiz-help-btn" onclick="jumpQuizToSource('${encodeURIComponent(item.id || '')}')">${_quizSourceJumpLabel(item)}</button>` : ''}
        ${wrongTime ? `<div class="quiz-wrong-date">${_quizEscape(wrongTime)}</div>` : ''}
      </div>`;
  }).join('');
  body.innerHTML = `
    <div class="quiz-back-bar"><button class="quiz-btn-secondary" onclick="backToQuizIntro()">← 返回</button></div>
    <div class="quiz-wrong-head">
      <span>错题回顾</span>
      <select onchange="filterWrongByTopic(this.value)">${topicOptions}</select>
    </div>
    <div class="quiz-wrong-list">${itemsHtml}</div>
    <div class="quiz-result-actions">
      <button class="quiz-btn-primary" onclick="startWrongQuiz()">重做错题</button>
      <button class="quiz-btn-secondary" onclick="clearWrongQuestions()">清空错题</button>
      <button class="quiz-btn-secondary" onclick="backToQuizIntro()">返回</button>
    </div>`;
}

function _renderOpenQuestion() {
  const body = document.getElementById('quizBody');
  if (!quizState) return;
  const question = quizState.openQuestions[quizState.openIndex];
  const progress = Math.round((quizState.openIndex + (quizState.openResult ? 1 : 0)) / quizState.openQuestions.length * 100);
  if (quizState.openScoring) {
    body.innerHTML = '<div class="quiz-loading"><div class="kp-spinner"></div><span>正在让 Phymathia 评分...</span></div>';
    return;
  }
  const openResult = quizState.openResult;
  const rubricHtml = openResult && (openResult.evidence || openResult.missing || openResult.advice) ? `
    <div class="quiz-open-rubric">
      ${openResult.evidence ? `<div class="quiz-open-rubric-item"><strong>得分依据</strong><div>${_renderQuizRichText(openResult.evidence)}</div></div>` : ''}
      ${openResult.missing ? `<div class="quiz-open-rubric-item"><strong>遗漏要点</strong><div>${_renderQuizRichText(openResult.missing)}</div></div>` : ''}
      ${openResult.advice ? `<div class="quiz-open-rubric-item"><strong>下一步建议</strong><div>${_renderQuizRichText(openResult.advice)}</div></div>` : ''}
    </div>
  ` : '';
  const scoreHtml = openResult && openResult.scores ? `
    ${openResult.local ? '<div class="quiz-local-score-badge">本地启发式评分（未调用 AI）</div>' : ''}
    <div class="quiz-open-scores">
      <div class="quiz-open-score"><span>物理直觉</span><strong>${openResult.scores.physics}</strong></div>
      <div class="quiz-open-score"><span>数学本质</span><strong>${openResult.scores.math}</strong></div>
      <div class="quiz-open-score"><span>数理联系</span><strong>${openResult.scores.connection}</strong></div>
      <div class="quiz-open-score"><span>表达清晰</span><strong>${openResult.scores.clarity}</strong></div>
    </div>
    ${rubricHtml}
    <div class="quiz-feedback ok"><div>${_renderQuizRichText(openResult.feedback || '')}</div></div>
    <button class="quiz-btn-primary" onclick="nextOpenQuestion()">${quizState.openIndex === quizState.openQuestions.length - 1 ? '查看总结' : '下一题'}</button>
  ` : `
    <textarea id="quizOpenAnswer" rows="6" placeholder="写下你的理解...">${_quizEscape(quizState.openDraftAnswer || '')}</textarea>
    ${quizState.openScoreError ? `<div class="quiz-explain-error">${_quizEscape(quizState.openScoreError)}</div>` : ''}
    <button class="quiz-btn-primary" onclick="submitOpenAnswer()">提交评分</button>
  `;
  body.innerHTML = `
    <div class="quiz-progress-top">
      <span>第 ${quizState.openIndex + 1} / ${quizState.openQuestions.length} 题</span>
      <span>${progress}%</span>
    </div>
    <div class="quiz-progress"><div class="quiz-progress-fill" style="width:${progress}%"></div></div>
    <div class="quiz-open-question">
      <div class="quiz-question-prompt">${_renderQuizRichText(question.prompt)}</div>
      ${scoreHtml}
    </div>`;
}

function _renderOpenResult() {
  const body = document.getElementById('quizBody');
  const stats = _readQuizStats();
  const stored = Array.isArray(stats._meta && stats._meta.openResults)
    ? stats._meta.openResults.filter(item => _quizItemInSession(item)).slice(-8)
    : [];
  const current = quizState.openResults || [];
  const results = current.length
    ? current
    : stored.map(item => ({ questionId: item.questionId, answer: item.answer, result: item }));
  if (!results.length) {
    body.innerHTML = '<div class="quiz-empty"><div class="quiz-empty-title">还没有深度问答记录</div><div class="quiz-empty-actions"><button class="quiz-btn-primary" onclick="backToQuizIntro()">返回</button></div></div>';
    return;
  }
  const avg = key => Math.round(results.reduce((sum, item) => sum + (item.result.scores[key] || 0), 0) / results.length);
  // 汇总视图：仅当本组（或存储记录里）所有评分都带 local 标记时才显示徽标——混合来源的均值不归属任何一方
  const allLocal = results.length > 0 && results.every(item => item.result && item.result.local);
  const historyHtml = stored.slice(-3).reverse().map(item => `
    <div class="quiz-open-history-item">
      <span>${_quizEscape(item.title || '深度问答')}</span>
      <span>${(item.scores && item.scores.physics) || 0} / ${(item.scores && item.scores.math) || 0} / ${(item.scores && item.scores.connection) || 0} / ${(item.scores && item.scores.clarity) || 0}</span>
    </div>
  `).join('');
  body.innerHTML = `
    <div class="quiz-open-result">
      ${allLocal ? '<div class="quiz-local-score-badge">本地启发式评分（未调用 AI）</div>' : ''}
      <div class="quiz-open-scores">
        <div class="quiz-open-score"><span>物理直觉</span><strong>${avg('physics')}</strong></div>
        <div class="quiz-open-score"><span>数学本质</span><strong>${avg('math')}</strong></div>
        <div class="quiz-open-score"><span>数理联系</span><strong>${avg('connection')}</strong></div>
        <div class="quiz-open-score"><span>表达清晰</span><strong>${avg('clarity')}</strong></div>
      </div>
      ${historyHtml ? `<div class="quiz-open-history"><div class="quiz-weak-title">最近记录</div>${historyHtml}</div>` : ''}
      <div class="quiz-result-actions">
        <button class="quiz-btn-primary" onclick="openOpenQuiz()">再答一组</button>
        <button class="quiz-btn-secondary" onclick="backToQuizIntro()">返回</button>
      </div>
    </div>`;
}

function renderQuiz() {
  const body = document.getElementById('quizBody');
  if (!body) return;
  if (!quizState || quizState.phase === 'loading') {
    body.innerHTML = quizState && quizState.aiPending
      ? `<div class="quiz-loading">
          <div class="kp-spinner"></div>
          <span>${_quizEscape(quizAiStatusText || 'AI 正在生成检测题…')}</span>
          <div class="quiz-ai-progress"><div class="quiz-ai-progress-fill" style="width:${quizState.aiProgress || 5}%"></div></div>
        </div>`
      : '<div class="quiz-loading"><div class="kp-spinner"></div><span>加载中</span></div>';
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'question') {
    _renderQuizQuestion();
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'result') {
    _renderQuizResult();
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'wrong') {
    _renderWrongReview();
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'bank') {
    _renderQuizBank();
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'global') {
    _renderQuizGlobalDashboard();
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'open') {
    _renderOpenQuestion();
    _renderQuizMath(body);
    return;
  }
  if (quizState.phase === 'open_result') {
    _renderOpenResult();
    _renderQuizMath(body);
    return;
  }
  _renderQuizIntro();
  _renderQuizMath(body);
}

function clearAllQuizStats() {
  try {
    localStorage.removeItem(QUIZ_STATS_KEY);
  } catch (e) {}
  try {
    fetch('/api/kv/phymathia_quiz_stats', { method: 'DELETE' }).catch(() => {});
  } catch (e) {}
}

function deleteQuizStatsBySession(sessionId) {
  if (!sessionId) return;
  const sessionIds = _quizSessionIdVariants(sessionId);
  const stats = _readQuizStats();
  let changed = false;
  for (const key of Object.keys(stats)) {
    if (key === '_meta') continue;
    if (stats[key] && sessionIds.has(stats[key].sessionId)) {
      delete stats[key];
      changed = true;
    }
  }
  if (stats._meta && Array.isArray(stats._meta.wrongQuestions)) {
    const before = stats._meta.wrongQuestions.length;
    stats._meta.wrongQuestions = stats._meta.wrongQuestions.filter(item => !sessionIds.has(item.sessionId));
    if (stats._meta.wrongQuestions.length !== before) changed = true;
  }
  if (stats._meta && Array.isArray(stats._meta.openResults)) {
    const before = stats._meta.openResults.length;
    stats._meta.openResults = stats._meta.openResults.filter(item => !sessionIds.has(item.sessionId));
    if (stats._meta.openResults.length !== before) changed = true;
  }
  if (changed) _saveQuizStats(stats);
}

window.openQuiz = openQuiz;
window.openQuizGlobalDashboard = openQuizGlobalDashboard;
window.openSessionQuizFromGlobal = openSessionQuizFromGlobal;
window.closeQuiz = closeQuiz;
window.handleQuizBack = handleQuizBack;
window.startQuiz = startQuiz;
window.reshuffleQuiz = reshuffleQuiz;
window.redoQuiz = redoQuiz;
window.changeQuizQuestionCount = changeQuizQuestionCount;
window.useLocalQuiz = useLocalQuiz;
window.openWrongReview = openWrongReview;
window.startWrongQuiz = startWrongQuiz;
window.startReviewQuiz = startReviewQuiz;
window.changeQuizSourcePreference = changeQuizSourcePreference;
window.openQuizBank = openQuizBank;
window.startBankQuiz = startBankQuiz;
window.addQuizBankQuestions = addQuizBankQuestions;
window.deleteQuizBankQuestion = deleteQuizBankQuestion;
window.jumpQuizToSource = jumpQuizToSource;
window.openOpenQuiz = openOpenQuiz;
window.submitOpenAnswer = submitOpenAnswer;
window.nextOpenQuestion = nextOpenQuestion;
window.chooseQuizOption = chooseQuizOption;
window.nextQuizQuestion = nextQuizQuestion;
window.askQuizExplain = askQuizExplain;
window.filterWrongByTopic = filterWrongByTopic;
window.deleteWrongQuestion = deleteWrongQuestion;
window.clearQuizRecords = clearQuizRecords;
window.clearWrongQuestions = clearWrongQuestions;
window.backToQuizIntro = backToQuizIntro;
window.clearAllQuizStats = clearAllQuizStats;
window.deleteQuizStatsBySession = deleteQuizStatsBySession;
