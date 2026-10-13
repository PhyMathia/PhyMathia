/* ====== 知识检测：面板渲染与导出 ====== */

// 全局检测的多选画布面板：勾选态只渲染自 quizSelectedSessions（intro 会被进度 tick 整份重画）。
// 行右侧平时显示该画布素材量（勾选依据），循环生成中换成逐画布进度徽标（排队/正在出题/已完成/无素材）。
function _quizLoopPanelHtml() {
  if (quizMode !== 'global') return '';
  const sessions = typeof window.getAllSessions === 'function' ? window.getAllSessions() : [];
  const known = sessions.map(s => s.id || s.sessionId || '').filter(Boolean);
  const inLoop = !!(quizLoopProgress && quizState && quizState.aiPending && quizScope === 'select');
  if (!quizLoopPanelOpen) {
    // 摘要为纯数字/静态词（无用户输入面），不走 _quizEscape——沙箱 DOM 代理下转义会失真
    const note = inLoop
      ? `多选出题中 ${quizLoopProgress.done}/${quizLoopProgress.total}`
      : (quizScope === 'select' ? `多选出题：已选 ${quizSelectedSessions.size} 张画布` : '');
    return `<div class="quiz-loop-entry">
      <button class="quiz-btn-secondary" onclick="toggleQuizLoopPanel()">多选画布出题</button>
      ${note ? `<span class="quiz-loop-entry-note">${note}</span>` : ''}
    </div>`;
  }
  // 素材量统计按画布变体归集（rawPool 是未过滤的全量池，未选中画布也有数）
  const materialBySession = new Map();
  if (quizState && quizState.rawPool) {
    const bump = (sessionId, key) => {
      if (!sessionId) return;
      const cur = materialBySession.get(sessionId) || { k: 0, f: 0 };
      cur[key]++;
      materialBySession.set(sessionId, cur);
    };
    for (const item of (quizState.rawPool.knowledge || [])) bump(item.sessionId, 'k');
    for (const item of (quizState.rawPool.formulas || [])) bump(item.sessionId, 'f');
  }
  const progressMap = new Map((quizLoopProgress && quizLoopProgress.items || []).map(it => [it.id, it]));
  const badgeLabels = { run: '正在出题…', wait: '排队中', done: '✓', empty: '无素材' };
  // encodeURIComponent 不转义单引号，id 带引号会截断内联 onclick 字符串，补一道 %27
  const attrId = id => encodeURIComponent(id || '').replace(/'/g, '%27');
  const rows = sessions.map(session => {
    const id = session.id || session.sessionId || '';
    if (!id) return '';
    let metaHtml = '';
    if (inLoop) {
      const item = progressMap.get(id);
      if (item) {
        // 徽标文案为静态词＋数字（无用户输入面），不走 _quizEscape——沙箱 DOM 代理下转义会失真
        const text = item.status === 'done' ? '✓ 已出 ' + item.questions + ' 题' : (badgeLabels[item.status] || '');
        if (text) metaHtml = `<span class="quiz-loop-meta is-${item.status}">${text}</span>`;
      }
    }
    if (!metaHtml) {
      let k = 0;
      let f = 0;
      for (const v of _quizSessionIdVariants(id)) {
        const c = materialBySession.get(v);
        if (c) { k += c.k; f += c.f; }
      }
      const parts = [];
      if (k) parts.push(k + ' 知识');
      if (f) parts.push(f + ' 公式');
      metaHtml = parts.length
        ? `<span class="quiz-loop-meta">${parts.join(' · ')}</span>`
        : '<span class="quiz-loop-meta is-empty">无素材</span>';
    }
    return `<label class="quiz-loop-row">
      <input type="checkbox" ${quizSelectedSessions.has(id) ? 'checked' : ''} onchange="toggleQuizLoopSession('${attrId(id)}')">
      <span class="quiz-loop-title" title="${_quizEscape(session.title || id)}">${_quizEscape(session.title || id)}</span>
      ${metaHtml}
    </label>`;
  }).join('');
  const selected = quizSelectedSessions.size;
  const allChecked = known.length > 0 && selected >= known.length;
  return `<div class="quiz-loop-panel">
    <div class="quiz-loop-head">
      <span class="quiz-loop-head-title">多选画布出题</span>
      <button class="quiz-btn-secondary" onclick="toggleQuizLoopSelectAll()">${allChecked ? '全不选' : '全选'}</button>
    </div>
    <div class="quiz-loop-list">${rows || '<div class="quiz-loop-empty">暂无画布</div>'}</div>
    <div class="quiz-loop-foot">
      <span>已选 ${selected} 张 · 每画布 ${quizTargetCount} 题 · 共约 ${selected * quizTargetCount} 题</span>
      <span class="quiz-loop-hint">逐张画布依次出题，保证每张选中画布都被覆盖</span>
    </div>
    <div class="quiz-loop-actions">
      <button class="quiz-btn-primary" ${selected ? '' : 'disabled'} onclick="applyQuizLoopSelection()">开始出题</button>
      ${quizScope === 'select' ? '<button class="quiz-btn-secondary" onclick="resetQuizLoopScope()">改用全部画布</button>' : ''}
      <button class="quiz-btn-secondary" onclick="toggleQuizLoopPanel()">收起</button>
    </div>
  </div>`;
}

function _renderQuizIntro() {
  const body = document.getElementById('quizBody');
  const stats = _quizStatSummary();
  const hasQuestions = !!(quizState && quizState.questions && quizState.questions.length);
  const hasOpen = !!(quizState && quizState.openQuestions && quizState.openQuestions.length);
  const hasWrong = stats.wrongCount > 0;
  const bankCount = _quizBankQuestions().length;
  // 全局检测·待选范围：素材在、还没出题、也不在生成中——不落空态/纯进度分支，主界面出「开始出题」CTA
  const poolHasMaterial = !!(quizState && quizState.pool
    && ((quizState.pool.knowledge || []).length || (quizState.pool.formulas || []).length));
  const awaitingScope = quizMode === 'global' && poolHasMaterial && !hasQuestions && !(quizState && quizState.aiPending);
  if (!hasQuestions && !(quizState && quizState.aiPending) && !awaitingScope) {
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
  // 全局检测生成中不落纯进度分支：主界面带内联进度＋选择面板，可中途改选画布（提交即废弃在跑轮）
  if (!hasQuestions && quizState && quizState.aiPending && quizMode !== 'global') {
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
  const entryLabel = quizMode === 'global'
    ? (quizScope === 'select' ? `跨画布检测·多选（${quizSelectedSessions.size} 画布）` : '跨画布检测')
    : '画布检测';
  const sourceModeLabel = quizState && quizState.aiPending
    ? 'AI 生成中'
    : quizState && quizState.sourceMode === 'ai'
      ? 'AI题'
      : quizState && quizState.sourceMode === 'mixed'
        ? 'AI+本地题'
        : '本地题';
  // 待选范围态：主按钮是「开始出题」而不是「开始检测」（还没有题可开考）；
  // 已在循环口径（scope=select，如上一轮循环失败后回到待选）则按钮回到循环提交
  const ctaIsLoop = quizScope === 'select';
  const startHtml = awaitingScope
    ? `<div class="quiz-start">
        <button class="quiz-btn-primary quiz-btn-large" onclick="${ctaIsLoop ? 'applyQuizLoopSelection()' : 'startGlobalQuizGeneration()'}">${ctaIsLoop ? '重新出题（已选 ' + quizSelectedSessions.size + ' 张）' : '开始出题（全部画布）'}</button>
        ${hasOpen ? '<button class="quiz-btn-primary" onclick="openOpenQuiz()">深度问答</button>' : ''}
        ${hasWrong ? `<button class="quiz-btn-primary" onclick="openWrongReview()">错题回顾(${hasWrong})</button>` : ''}
      </div>
      <div class="quiz-model-note">${ctaIsLoop
        ? '将对已选的 ' + quizSelectedSessions.size + ' 张画布逐张出题，每画布 ' + quizTargetCount + ' 题'
        : '点「开始出题」用全部画布素材混合出一组 ' + quizTargetCount + ' 题；或先在上方勾选画布，逐张出题（每张 ' + quizTargetCount + ' 题）'}</div>`
    : `<div class="quiz-start">
      <button class="quiz-btn-primary quiz-btn-large" onclick="startQuiz()" ${hasQuestions ? '' : 'disabled'}>开始检测</button>
      <button class="quiz-btn-primary" onclick="reshuffleQuiz()" ${hasQuestions ? '' : 'disabled'} title="重新生成一组 AI 题（会调用一次模型）；不会删除AI题库">换一组题</button>
      <button class="quiz-btn-primary" onclick="openOpenQuiz()" ${hasOpen ? '' : 'disabled'}>深度问答${stats.openCount ? `(${stats.openCount})` : ''}</button>
      <button class="quiz-btn-primary" onclick="openWrongReview()" ${hasWrong ? '' : 'disabled'}>错题回顾${hasWrong ? `(${hasWrong})` : ''}</button>
      ${stats.reviewCount ? `<button class="quiz-btn-primary" onclick="startReviewQuiz()">开始复习(${stats.reviewCount})</button>` : ''}
      ${bankCount ? `<button class="quiz-btn-secondary" onclick="openQuizBank()">AI题库(${bankCount})</button>` : ''}
      <button class="quiz-btn-secondary" onclick="clearQuizRecords()">清空记录</button>
    </div>`;
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
      <span>${quizScope === 'select' ? '每画布题量' : '题量'}</span>
      <select id="quizCountSelect" onchange="changeQuizQuestionCount()" title="改变题量会重新生成一组题（AI 模式下会调用一次模型；循环出题时每张选中画布各按此题量出一组）">${countOptions}</select>
    </div>
    ${_quizLoopPanelHtml()}
    ${startHtml}`;
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

// ====== 全局总览占比环（2026-10-13 起 SVG 逐扇区，对齐 token-usage.js 圆环手感）======
// 旧版是单块 conic-gradient＋radial mask 挖孔——单块上没有「块」，做不了逐块动画。
// 现改为 SVG 逐扇区 path（几何常量 QUIZ_DONUT_GEOMETRY），悬停交互与用量圆环同一套：
// 悬停块沿中角弹出＋回弹放大＋投影、其余块向环心收缩＋降透明、整环朝扇区 perspective
// 倾起、中心读数交叉淡化换「画布名＋题数＋占比」、图例行同步点亮（悬停图例同样驱动，
// 细扇区好点）。命中检测不走 DOM hover（扇区弹出后元素挪位，边界会抖），改指针坐标
// 反解角度/半径对照静态边界算命中——几何稳定不闪。角度仍编码已测题数而非正确率；
// 正确率归 _quizRateBarsHtml，图例只带题量避免双口径混在一张图。
// 几何纯函数与 token-usage.js 的 _tokenUsageDonutSegPath 族同一套公式（壳层同为
// 120px），不跨文件复用是刻意复制：token 版内嵌 TOKEN_DONUT_GEOMETRY 常量，抽参
// 要动它的冒烟契约，两份各 20 行比共享签名划算（配色数组同款先例）。

// 占比环几何常量（SVG viewBox 坐标系）：壳层 .quiz-chart-donut 仍是 120px 圆
// （边框＋投影不变），SVG 填满壳层；内半径与旧 mask 挖孔 58% 观感一致。
const QUIZ_DONUT_GEOMETRY = { size: 120, rOuter: 57, rInner: 33 };
const QUIZ_DONUT_POP = 6;   // 悬停扇区沿中角外移量（viewBox 单位，渲染 1:1px）
const QUIZ_DONUT_TILT = 7;  // 悬停时整环朝该扇区倾起的最大角度（deg）

let _quizDonutBound = false; // quizBody 悬停委托只绑一次（静态容器）
let _quizDonutFocus = null;  // 当前悬停聚焦的扇区序号（null=无，回收收缩/倾起）
let _quizDonutLive = null;   // 命中检测用的静态几何（segs＋百分比边界），总览渲染时刷新

// 扇区弧 path 纯函数（冒烟测试直接调用）：[startPct, endPct] → 环形扇区（外弧顺时针
// ＋内弧逆时针闭合），角度编码与旧 conic-gradient 同口径——0% 在 12 点钟、顺时针。
// 满圆（单画布 100%）时弧命令首尾重合会画空，钳到 99.99 留发丝缝；零宽段给空串。
function _quizDonutSegPath(startPct, endPct) {
  const g = QUIZ_DONUT_GEOMETRY;
  const c = g.size / 2;
  const sweep = Math.min(Math.max(0, endPct - startPct), 99.99);
  if (!(sweep > 0)) return '';
  const a0 = startPct / 100 * Math.PI * 2 - Math.PI / 2;
  const a1 = a0 + sweep / 100 * Math.PI * 2;
  const large = sweep > 50 ? 1 : 0;
  const pt = (r, a) => (c + r * Math.cos(a)).toFixed(2) + ' ' + (c + r * Math.sin(a)).toFixed(2);
  return 'M' + pt(g.rOuter, a0)
    + 'A' + g.rOuter + ' ' + g.rOuter + ' 0 ' + large + ' 1 ' + pt(g.rOuter, a1)
    + 'L' + pt(g.rInner, a1)
    + 'A' + g.rInner + ' ' + g.rInner + ' 0 ' + large + ' 0 ' + pt(g.rInner, a0)
    + 'Z';
}

// 累积边界纯函数（冒烟测试直接调用）：segments → [0, …, 100]，长度＝段数+1
function _quizDonutBounds(segments) {
  const list = segments || [];
  const total = list.reduce((sum, s) => sum + s.value, 0);
  const bounds = [0];
  let acc = 0;
  for (const s of list) {
    acc += s.value;
    bounds.push(total ? acc / total * 100 : 100);
  }
  if (bounds.length === 1) bounds.push(100); // 空分段也保持「0→100 整圆」形态
  return bounds;
}

// 全部分扇区 path 纯函数（冒烟测试直接调用）：segments → d 串数组
function _quizDonutSegsD(segments) {
  const bounds = _quizDonutBounds(segments);
  const out = [];
  for (let i = 0; i < bounds.length - 1; i++) out.push(_quizDonutSegPath(bounds[i], bounds[i + 1]));
  return out;
}

// 指针角度归属纯函数（冒烟测试直接调用）：pct（0-100，12 点钟起顺时针）落在哪个
// 扇区的 [start, end) 区间；恰在 100% 收口点或负值都算界外（-1）。
function _quizDonutSegIndexAt(bounds, pct) {
  const b = bounds || [];
  if (!(pct >= 0) || pct >= 100) return -1;
  for (let i = 0; i < b.length - 1; i++) {
    if (pct >= b[i] && pct < b[i + 1]) return i;
  }
  return -1;
}

// 占比百分数文案（内部）：≥10% 取整、不足 10% 保留一位小数（与用量圆环图例同口径）
function _quizDonutPctText(pct) {
  return pct >= 10 ? Math.round(pct) + '%' : (Math.round(pct * 10) / 10) + '%';
}

// 占比环（冒烟测试直接调用）：SVG 逐扇区 path＋中心读数叠层（总量常显，悬停读数
// JS 现填）＋图例（行带 data-idx 与圆环联动，悬停可驱动扇区浮起）。
function _quizDonutHtml(segments) {
  if (!segments.length) return '<div class="quiz-chart-empty">暂无答题数据</div>';
  const total = segments.reduce((sum, item) => sum + item.value, 0);
  if (!total) return '<div class="quiz-chart-empty">暂无答题数据</div>';
  const ds = _quizDonutSegsD(segments);
  const paths = segments.map((segment, i) => `<path class="quiz-donut-seg" data-idx="${i}" data-label="${_quizEscape(segment.label)}" d="${ds[i]}" style="fill:${segment.color}"/>`).join('');
  const legend = segments.map((segment, i) => {
    const pct = segment.value / total * 100;
    return `
    <div class="quiz-chart-legend-item" data-idx="${i}">
      <span class="quiz-donut-dot" style="background:${segment.color}"></span>
      <span class="quiz-donut-name" title="${_quizEscape(segment.label)}">${_quizEscape(segment.label)}</span>
      <span class="quiz-donut-meta">已测 ${segment.value} 题</span>
      <span class="quiz-donut-pct">${_quizDonutPctText(pct)}</span>
    </div>
  `;
  }).join('');
  return `<div class="quiz-chart-donut">
      <svg class="quiz-chart-donut-svg" viewBox="0 0 ${QUIZ_DONUT_GEOMETRY.size} ${QUIZ_DONUT_GEOMETRY.size}" aria-hidden="true">${paths}</svg>
      <div class="quiz-chart-donut-center">
        <div class="quiz-donut-center-total"><b>${total}</b><span>已测题</span></div>
        <div class="quiz-donut-center-focus"><span class="qcf-name"></span><b class="qcf-val"></b><span class="qcf-sub"></span></div>
      </div>
    </div><div class="quiz-chart-legend">${legend}</div>`;
}

// ====== 占比环悬停 3D 聚焦（对齐 token-usage.js 同名机制）======
// 命中检测不走 DOM hover：扇区弹出后元素挪离指针，边界上会「弹起→移出→落回」抖个
// 不停。改为指针坐标反解成 viewBox 极坐标（半径过滤＋角度归段），对照 _quizDonutLive
// 里的静态百分比边界算命中——几何不随动画变，稳定不闪。
function _quizDonutRadialDir(i) {
  const b = (_quizDonutLive && _quizDonutLive.bounds) || [0, 100];
  const lo = b[Math.min(i, b.length - 2)] || 0;
  const hi = b[Math.min(i + 1, b.length - 1)] || 100;
  const mid = ((lo + hi) / 2) / 100 * Math.PI * 2; // 0 = 12 点钟，顺时针
  return [Math.sin(mid), -Math.cos(mid)];
}

// 指针位置 → 扇区序号（内部）：viewBox 坐标过滤半径后按角度归段，环外给 null
function _quizDonutHitAt(ux, uy) {
  const g = QUIZ_DONUT_GEOMETRY;
  const live = _quizDonutLive;
  if (!live || !live.bounds || live.bounds.length < 2) return null;
  const c = g.size / 2;
  const dx = ux - c, dy = uy - c;
  const r = Math.hypot(dx, dy);
  if (r < g.rInner - 2 || r > g.rOuter + 6) return null; // 外留 6u 余量：悬停贴外缘不脱手
  let ang = Math.atan2(dy, dx) + Math.PI / 2;
  if (ang < 0) ang += Math.PI * 2;
  const idx = _quizDonutSegIndexAt(live.bounds, ang / (Math.PI * 2) * 100);
  return idx >= 0 ? idx : null;
}

// 聚焦应用（内部）：idx=null 回 idle。悬停块沿中角弹出＋微放大（CSS 回弹缓动），
// 其余块向环心收缩＋降透明；整环朝悬停块倾起（--quiz-donut-rx/--quiz-donut-ry，
// CSS perspective 消费）；中心读数换「画布名＋题数＋占比」；图例行同步点亮。
// prefers-reduced-motion 时跳过全部几何动画，只换中心读数与高亮。
function _setQuizDonutFocus(idx) {
  _quizDonutFocus = (idx != null && idx >= 0) ? idx : null;
  if (typeof document === 'undefined' || !document.getElementById) return;
  const body = document.getElementById('quizBody');
  if (!body || typeof body.querySelectorAll !== 'function') return;
  const donut = body.querySelector('.quiz-chart-donut');
  const segs = body.querySelectorAll('.quiz-donut-seg');
  const list = (_quizDonutLive && _quizDonutLive.segs) || [];
  if (!donut || !segs.length) return;
  const reduced = (typeof matchMedia === 'function') && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const focus = _quizDonutFocus;
  for (let i = 0; i < segs.length; i++) {
    const p = segs[i];
    if (!p || !p.style) continue;
    const active = focus != null && i === focus;
    const recede = focus != null && !active;
    if (active && !reduced) {
      const dir = _quizDonutRadialDir(i);
      p.style.transform = 'translate(' + (dir[0] * QUIZ_DONUT_POP).toFixed(2) + 'px, '
        + (dir[1] * QUIZ_DONUT_POP).toFixed(2) + 'px) scale(1.05)';
    } else if (recede && !reduced) {
      p.style.transform = 'scale(0.93)';
    } else {
      p.style.transform = '';
    }
    p.style.opacity = recede ? '0.45' : '';
    if (p.classList) p.classList.toggle('active', active);
  }
  if (!reduced) {
    // 倾起方向：悬停块在哪一侧，那一侧朝观察者抬起（右块 rotateY 负、下块
    // rotateX 正），离手回正。角随扇区中角、不随像素走，段内不抖。
    if (focus != null) {
      const dir = _quizDonutRadialDir(focus);
      donut.style.setProperty('--quiz-donut-ry', (-dir[0] * QUIZ_DONUT_TILT).toFixed(2) + 'deg');
      donut.style.setProperty('--quiz-donut-rx', (dir[1] * QUIZ_DONUT_TILT).toFixed(2) + 'deg');
    } else {
      donut.style.setProperty('--quiz-donut-ry', '0deg');
      donut.style.setProperty('--quiz-donut-rx', '0deg');
    }
  }
  if (donut.classList) donut.classList.toggle('focus-mode', focus != null);
  const focusBox = body.querySelector('.quiz-donut-center-focus');
  if (focusBox && focus != null && list[focus]) {
    const seg = list[focus];
    const sum = list.reduce((s, x) => s + x.value, 0) || 1;
    const pctText = _quizDonutPctText(seg.value / sum * 100);
    const nameEl = focusBox.querySelector('.qcf-name');
    const valEl = focusBox.querySelector('.qcf-val');
    const subEl = focusBox.querySelector('.qcf-sub');
    if (nameEl) { nameEl.textContent = seg.label; nameEl.title = seg.label; }
    if (valEl) valEl.textContent = String(seg.value);
    if (subEl) subEl.textContent = '题 · ' + pctText;
  }
  if (body.querySelectorAll('.quiz-chart-legend-item[data-idx]').forEach) {
    body.querySelectorAll('.quiz-chart-legend-item[data-idx]').forEach(it => {
      if (it.classList) it.classList.toggle('hl', focus != null && Number(it.dataset.idx) === focus);
    });
  }
}

function _quizDonutHandleMove(e) {
  if (typeof document === 'undefined' || !document.getElementById) return;
  const body = document.getElementById('quizBody');
  if (!body) return;
  const svg = body.querySelector('.quiz-chart-donut-svg');
  if (!svg) {
    // 当前相位没有占比环（答题/结果/错题等），悬停态复位即可
    if (_quizDonutFocus != null) _setQuizDonutFocus(null);
    return;
  }
  let idx = null;
  // 图例行优先（细扇区从图例聚焦最顺手），其次圆环本体极坐标命中
  const item = (e && e.target && typeof e.target.closest === 'function')
    ? e.target.closest('.quiz-chart-legend-item[data-idx]') : null;
  if (item && item.dataset) {
    idx = Number(item.dataset.idx);
  } else if (svg.getBoundingClientRect) {
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const g = QUIZ_DONUT_GEOMETRY;
      const ux = (e.clientX - rect.left) / rect.width * g.size;
      const uy = (e.clientY - rect.top) / rect.height * g.size;
      idx = _quizDonutHitAt(ux, uy);
    }
  }
  if (idx !== _quizDonutFocus) _setQuizDonutFocus(idx);
}

function _bindQuizDonutHover() {
  if (_quizDonutBound || typeof document === 'undefined' || !document.getElementById) return;
  const body = document.getElementById('quizBody');
  if (!body || typeof body.addEventListener !== 'function') return;
  _quizDonutBound = true;
  // 不走 rAF 节流（同 token-usage）：节流会让聚焦应用押后一帧，后台标签页 rAF
  // 暂停时无限押后；命中检测＝一次 getBoundingClientRect＋≤画布数段小循环，无压力
  body.addEventListener('pointermove', (e) => {
    if (e) _quizDonutHandleMove(e);
  });
  body.addEventListener('pointerleave', () => {
    if (_quizDonutFocus != null) _setQuizDonutFocus(null);
  });
}

// 各画布正确率条形图：颜色与占比环同源对应，按正确率降序（同率题量多的在前）方便排名
function _quizRateBarsHtml(segments) {
  if (!segments.length) return '<div class="quiz-chart-empty">暂无答题数据</div>';
  const sorted = segments.slice().sort((a, b) => b.correctRate - a.correctRate || b.value - a.value);
  const rows = sorted.map(segment => `
    <div class="quiz-rate-row">
      <div class="quiz-rate-name">${_quizEscape(segment.label)}</div>
      <div class="quiz-rate-track"><div class="quiz-rate-fill" style="width:${Math.min(100, Math.max(0, segment.correctRate))}%;background:${segment.color}"></div></div>
      <div class="quiz-rate-num">${segment.correctRate}%</div>
    </div>
  `).join('');
  return `<div class="quiz-rate-bars">${rows}</div>`;
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
        <div class="quiz-chart-title">各画布答题量占比<span class="quiz-chart-sub">环形角度=已测题数</span></div>
        ${_quizDonutHtml(chartSegments)}
      </div>
      <div class="quiz-chart-card">
        <div class="quiz-chart-title">各画布正确率<span class="quiz-chart-sub">颜色与占比环对应</span></div>
        ${_quizRateBarsHtml(chartSegments)}
      </div>
      <div class="quiz-chart-card quiz-chart-card--wide">
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
  // 占比环命中检测的静态几何（弹出的扇区不影响归属判定）＋悬停委托（只绑一次）；
  // 重渲染换的是全新 DOM，悬停态不跨渲染保留
  _quizDonutLive = chartSegments.length
    ? { segs: chartSegments, bounds: _quizDonutBounds(chartSegments) }
    : null;
  _quizDonutFocus = null;
  _bindQuizDonutHover();
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
