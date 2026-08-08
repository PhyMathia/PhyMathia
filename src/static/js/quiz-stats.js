/* ====== 知识检测：统计、错题与开放式问答 ====== */

function _readQuizStats() {
  try {
    const raw = localStorage.getItem(QUIZ_STATS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function _saveQuizStats(stats) {
  try {
    localStorage.setItem(QUIZ_STATS_KEY, JSON.stringify(stats));
  } catch (e) {}
  try {
    fetch('/api/kv/phymathia_quiz_stats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: stats })
    }).catch(() => {});
  } catch (e) {}
}

async function _loadQuizStatsFromServer() {
  try {
    const resp = await fetch('/api/kv/phymathia_quiz_stats', { cache: 'no-cache' });
    if (!resp.ok) return;
    const data = await resp.json();
    const server = data.value;
    if (!server || typeof server !== 'object') return;
    const local = _readQuizStats();
    const merged = _mergeQuizStats(local, server);
    localStorage.setItem(QUIZ_STATS_KEY, JSON.stringify(merged));
  } catch (e) {
    console.warn('Load quiz stats failed:', e);
  }
}

function _quizTopicStatsKey(question) {
  return question.topicKey || _quizTopicKey({
    sessionId: question.sessionId || '',
    title: question.title || '',
    concept: question.title || '',
    latex: question.formulaText || ''
  });
}

function _quizMastery(item) {
  const c = item.correct || 0;
  const w = item.wrong || 0;
  const total = c + w;
  const history = Array.isArray(item.history) ? item.history : [];
  const recent = history.slice(-10);
  const recentCorrect = recent.filter(entry => entry && entry.correct).length;
  const recentRate = recent.length ? recentCorrect / recent.length : (total ? c / total : 0);
  const streakBonus = Math.min(10, (item.correctStreak || 0));
  const lapsePenalty = Math.min(15, (item.lapses || 0) * 3);
  return Math.max(0, Math.min(100, Math.round(recentRate * 80 + (total ? c / total * 15 : 0) + streakBonus - lapsePenalty)));
}

function _quizScheduleAfterAnswer(current, correct) {
  const now = Date.now();
  if (correct) {
    current.reps = (current.reps || 0) + 1;
    current.correctStreak = (current.correctStreak || 0) + 1;
    current.wrongStreak = 0;
    const idx = Math.min(current.reps - 1, QUIZ_REVIEW_INTERVALS_DAYS.length - 1);
    current.intervalDays = QUIZ_REVIEW_INTERVALS_DAYS[idx];
    current.dueAt = now + current.intervalDays * QUIZ_DAY_MS;
    current.ease = Math.min(3.0, Math.max(1.3, (current.ease || 2.5) + 0.05 + Math.min(2, current.correctStreak) * 0.03));
  } else {
    current.lapses = (current.lapses || 0) + 1;
    current.reps = Math.max(0, (current.reps || 0) - 1);
    current.correctStreak = 0;
    current.wrongStreak = (current.wrongStreak || 0) + 1;
    current.intervalDays = 1;
    current.dueAt = now + QUIZ_REVIEW_AFTER_WRONG_MS;
    current.ease = Math.max(1.3, (current.ease || 2.5) - 0.2);
  }
  current.last = now;
  return current;
}

function _quizDueLabel(timestamp) {
  const ts = Number(timestamp || 0);
  if (!ts) return '等待安排';
  const delta = ts - Date.now();
  if (delta <= 0) return '已到期';
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return minutes + ' 分钟后';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' 小时后';
  const days = Math.round(hours / 24);
  return days + ' 天后';
}

function _quizRecordTimestamp(item) {
  return Number(item && (item.last || item.updatedAt || 0)) || 0;
}

function _mergeQuizMeta(localMeta, serverMeta) {
  const a = localMeta || {};
  const b = serverMeta || {};
  const merged = {
    ...a,
    ...b,
    updatedAt: Math.max(Number(a.updatedAt || 0), Number(b.updatedAt || 0)),
    attempts: Math.max(Number(a.attempts || 0), Number(b.attempts || 0))
  };
  const wrongMap = new Map();
  for (const item of [...(Array.isArray(a.wrongQuestions) ? a.wrongQuestions : []), ...(Array.isArray(b.wrongQuestions) ? b.wrongQuestions : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = _wrongQuestionKey(item);
    const prev = wrongMap.get(key);
    const currentAt = Number(item.wrongAt || 0) || 0;
    const prevAt = prev ? (Number(prev.wrongAt || 0) || 0) : -1;
    if (!prev || currentAt >= prevAt) wrongMap.set(key, item);
  }
  merged.wrongQuestions = Array.from(wrongMap.values()).slice(-QUIZ_MAX_WRONG);
  const openMap = new Map();
  for (const item of [...(Array.isArray(a.openResults) ? a.openResults : []), ...(Array.isArray(b.openResults) ? b.openResults : [])]) {
    if (!item || typeof item !== 'object') continue;
    const key = item.id || ((item.questionId || '') + '|' + (item.at || 0));
    const prev = openMap.get(key);
    const currentAt = Number(item.at || 0) || 0;
    const prevAt = prev ? (Number(prev.at || 0) || 0) : -1;
    if (!prev || currentAt >= prevAt) openMap.set(key, item);
  }
  merged.openResults = Array.from(openMap.values()).slice(-QUIZ_MAX_OPEN_RESULTS);
  return merged;
}

function _mergeQuizStats(local, server) {
  const result = {};
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(server || {})]);
  for (const key of keys) {
    if (key === '_meta') continue;
    const a = local && local[key];
    const b = server && server[key];
    if (!a && !b) continue;
    result[key] = _quizRecordTimestamp(b) >= _quizRecordTimestamp(a) ? b : a;
  }
  result._meta = _mergeQuizMeta(local && local._meta, server && server._meta);
  return result;
}

function _recordQuizAnswer(question, correct) {
  const stats = _readQuizStats();
  const key = _quizTopicStatsKey(question);
  const current = stats[key] || {
    correct: 0,
    wrong: 0,
    last: 0,
    sessionId: question.sessionId || '',
    title: question.title || '',
    topicKey: key,
    history: [],
    reps: 0,
    lapses: 0,
    intervalDays: 1,
    dueAt: 0,
    ease: 2.5
  };
  current.correct = (current.correct || 0) + (correct ? 1 : 0);
  current.wrong = (current.wrong || 0) + (correct ? 0 : 1);
  _quizScheduleAfterAnswer(current, correct);
  current.sessionId = question.sessionId || current.sessionId || '';
  current.title = question.title || current.title || '';
  current.topicKey = current.topicKey || key;
  current.history = Array.isArray(current.history) ? current.history : [];
  current.history.push({ correct, at: current.last, questionId: question.id || '', difficulty: question.difficulty || 'medium' });
  current.history = current.history.slice(-20);
  current.mastery = _quizMastery(current);
  stats[key] = current;
  stats._meta = {
    ...(stats._meta || {}),
    version: 3,
    attempts: (stats._meta && stats._meta.attempts || 0) + 1,
    updatedAt: Date.now()
  };
  const wrongList = Array.isArray(stats._meta.wrongQuestions) ? stats._meta.wrongQuestions : [];
  if (!correct) {
    const snapshot = _quizQuestionSnapshot(question, quizState.answers.find(a => a.questionId === question.id)?.selectedIndex ?? -1);
    const wrongKey = _wrongQuestionKey(snapshot);
    const nextWrong = wrongList.filter(w => _wrongQuestionKey(w) !== wrongKey);
    nextWrong.push(snapshot);
    stats._meta.wrongQuestions = nextWrong.slice(-QUIZ_MAX_WRONG);
  } else {
    const wrongKey = _wrongQuestionKey(question);
    const mastered = (current.mastery || 0) >= 70 && (current.correctStreak || 0) >= 2;
    if (mastered) {
      stats._meta.wrongQuestions = wrongList.filter(w => _wrongQuestionKey(w) !== wrongKey);
    }
  }
  _saveQuizStats(stats);
}

function _wrongQuestionKey(question) {
  const correct = question && Array.isArray(question.options) && question.options[question.correctIndex]
    ? question.options[question.correctIndex].text
    : '';
  return _quizOptionKey(((question && question.prompt) || '') + '|' + ((question && question.formulaText) || '') + '|' + correct);
}

function _quizQuestionSnapshot(question, selectedIndex) {
  return {
    id: question.id || '',
    type: question.type || 'choice',
    title: question.title || '',
    prompt: question.prompt || '',
    formulaText: question.formulaText || '',
    options: (question.options || []).map(o => ({ key: o.key, text: o.text, html: o.html || '' })),
    correctIndex: question.correctIndex,
    explanation: question.explanation || '',
    refId: question.refId || '',
    sourceRef: question.sourceRef || question.refId || '',
    topicKey: _quizTopicStatsKey(question),
    difficulty: question.difficulty || 'medium',
    sessionId: question.sessionId || '',
    selectedIndex,
    wrongAt: Date.now()
  };
}

function _readWrongQuestions(scope) {
  const global = scope === 'global' || (scope == null && quizMode === 'global');
  const stats = _readQuizStats();
  const list = Array.isArray(stats._meta && stats._meta.wrongQuestions) ? stats._meta.wrongQuestions : [];
  return list.map(item => {
    if (!item.topicKey) item.topicKey = _quizTopicKey({
      sessionId: item.sessionId || '',
      title: item.title || '',
      concept: item.title || '',
      latex: item.formulaText || ''
    });
    return item;
  }).filter(item => {
    if (!global && !_quizItemInSession(item)) return false;
    const text = [item.prompt || '', item.title || '', item.formulaText || '',
      ...(Array.isArray(item.options) ? item.options.map(option => option.text || '') : [])].join('\n');
    return !_quizIsMetaPrompt(text);
  });
}

function _quizStatSummary(scope) {
  const global = scope === 'global' || (scope == null && quizMode === 'global');
  const stats = _readQuizStats();
  const now = Date.now();
  let correct = 0;
  let wrong = 0;
  const buckets = {};
  for (const [key, item] of Object.entries(stats)) {
    if (key === '_meta' || !item || typeof item !== 'object') continue;
    if (!global && !_quizItemInSession(item)) continue;
    const c = item.correct || 0;
    const w = item.wrong || 0;
    const topicKey = item.topicKey || _quizTopicKey({ sessionId: item.sessionId || '', title: item.title || '', concept: item.title || '' });
    correct += c;
    wrong += w;
    const bucket = buckets[topicKey] || {
      key: topicKey,
      title: item.title || '未命名知识点',
      correct: 0,
      wrong: 0,
      last: 0,
      history: [],
      sessionId: item.sessionId || '',
      dueAt: 0,
      intervalDays: 0,
      lapses: 0
    };
    bucket.correct += c;
    bucket.wrong += w;
    bucket.last = Math.max(bucket.last, item.last || 0);
    bucket.dueAt = Math.max(bucket.dueAt, Number(item.dueAt || 0) || 0);
    bucket.intervalDays = Math.max(bucket.intervalDays, Number(item.intervalDays || 0) || 0);
    bucket.lapses = Math.max(bucket.lapses, Number(item.lapses || 0) || 0);
    bucket.history = bucket.history.concat(Array.isArray(item.history) ? item.history : []);
    bucket.sessionId = item.sessionId || bucket.sessionId || '';
    buckets[topicKey] = bucket;
  }
  const topics = Object.values(buckets);
  for (const item of topics) item.mastery = _quizMastery(item);
  const dueTopics = topics.filter(item => (item.dueAt > 0 && item.dueAt <= now) || item.wrong > 0);
  const weak = dueTopics
    .filter(item => item.wrong > 0 && (item.wrong >= item.correct || item.mastery < 70))
    .sort((a, b) => (a.mastery - b.mastery) || (b.wrong - a.wrong));
  const review = dueTopics
    .filter(item => item.wrong > 0 || item.mastery < 100)
    .sort((a, b) => ((a.dueAt || 0) - (b.dueAt || 0)) || (a.mastery - b.mastery) || (b.wrong - a.wrong))
    .slice(0, 8);
  const openResults = Array.isArray(stats._meta && stats._meta.openResults) ? stats._meta.openResults : [];
  const openCount = openResults.filter(item => global || _quizItemInSession(item)).length;
  return {
    correct,
    wrong,
    total: correct + wrong,
    rate: correct + wrong ? Math.round(correct / (correct + wrong) * 100) : 0,
    weak: weak.slice(0, 5),
    review,
    reviewCount: review.length,
    openCount,
    wrongCount: _readWrongQuestions(global ? 'global' : 'session').length
  };
}

const QUIZ_OPEN_TEMPLATES = [
  item => `请用自己的话解释“${item.title}”的物理直觉与数学本质之间的联系，说明数学形式如何对应物理含义。`,
  item => `请为“${item.title}”设计一个生活类比，并说明这个类比哪里贴切、哪里会失效。`,
  item => `请指出“${item.title}”数学表述中最关键的一个量或结构，并解释它在物理上对应的作用。`
];

function _generateOpenQuestions(pool) {
  const knowledgeItems = pool.knowledge.filter(k => k.title).map(item => ({
    id: item.id,
    title: item.title,
    summary: item.summary || '',
    category: item.category || '',
    formulas: item.formulas || [],
    sessionId: item.sessionId || '',
    topicKey: item.topicKey || _quizTopicKey(item)
  }));
  const formulaItems = pool.formulas
    .filter(f => f.latex && (f.concept || f.meaning))
    .map(item => ({
      id: item.id,
      title: item.concept || ('公式 ' + item.latex),
      summary: item.meaning || item.concept || '',
      category: 'formula',
      formulas: [item.latex],
      sessionId: item.sessionId || '',
      topicKey: item.topicKey || _quizTopicKey(item)
    }));
  const items = [...knowledgeItems, ...formulaItems];
  const result = [];
  for (const item of items) {
    for (const makePrompt of QUIZ_OPEN_TEMPLATES) {
      if (result.length >= 3) break;
      result.push({
        id: 'open_' + item.id + '_' + result.length,
        type: 'open',
        title: item.title,
        prompt: makePrompt(item),
        context: {
          title: item.title,
          summary: item.summary || '',
          category: item.category || '',
          formulas: item.formulas || [],
          topicKey: item.topicKey || ''
        },
        topicKey: item.topicKey || '',
        sessionId: item.sessionId || ''
      });
    }
  }
  return result.slice(0, 3);
}
