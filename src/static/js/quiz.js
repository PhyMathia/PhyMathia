/* ====== 知识检测 ====== */
const QUIZ_STATS_KEY = 'phymathia_quiz_stats';
const QUIZ_QUESTION_COUNT = 5;
const QUIZ_MAX_WRONG = 100;
const QUIZ_MAX_OPEN_RESULTS = 20;
const QUIZ_AI_VERIFY_ENABLED = true;
const QUIZ_PROMPT_PATH = '/quiz-prompt.md';
let quizPromptCache = null;
let quizPromptCachePromise = null;
let quizTargetCount = QUIZ_QUESTION_COUNT;
let quizFilterTopic = 'all';
let quizAiStatusText = '';

const DEFAULT_QUIZ_GENERATION_PROMPT = `你是 PhyMathia 的出题老师。用户消息中的“出题素材”是从当前会话提取的真实知识点与公式，请只基于其中的知识点标题、概述、公式和分类生成物理数学检测题。
{{LEVEL_PROMPT}}
要求：
- 只根据给定内容出题，不要编造上下文之外的概念。
- 不要对“出题素材”“知识上下文”“标题”“格式”“字符数”“字符串长度”“包含多少个汉字”等元信息出题；不要把“出题素材”或“当前会话知识上下文”当作知识点。
- 每道题的题干、公式或选项中必须体现素材里的具体知识点标题、概述、公式或概念。
- 正确答案必须由素材中的概述、公式或分类直接推出；素材不足或答案不能唯一确定时，宁可不出这一题。
- 解析必须解释为什么，并引用素材中的概述或公式，不能引入素材之外的新结论。
- title 必须是素材中的知识点标题或公式概念；sourceRef 必须填素材中给出的 id。
- 生成 {{QUESTION_COUNT}} 道选择题，题型可包含：概述匹配、公式含义、公式归属、知识点涉及公式、学科分类。
- 每题必须有 4 个选项，且只有一个正确答案。
- 干扰项必须明显错误或来自不同概念，不能出现多个选项都正确的情况。
- 每题标记 difficulty：easy/medium/hard；解释尽量引用素材原文。
- 不要用“苏格拉底追问”“延伸思考”“知识图谱”等模块标题当知识点。
- 输出严格 JSON，不要输出其他内容：
{"questions":[{"type":"concept","title":"知识点标题","sourceRef":"素材中的id","difficulty":"medium","prompt":"题目","options":["选项A","选项B","选项C","选项D"],"correctIndex":0,"explanation":"解析"}]}`;

const DEFAULT_QUIZ_VERIFY_PROMPT = `你是 PhyMathia 的审题老师。请根据出题素材审核下面的检测题，只保留能由素材直接推出且没有物理或数学错误的题目。
{{LEVEL_PROMPT}}
要求：
- 正确答案、正确选项和解析必须严格来自素材，不能引入素材之外的新事实。
- 如果题干、选项或正确索引有误，直接修正。
- 如果某题无法由素材唯一确定答案，删除该题。
- 题目数量可以减少，但不要新增素材之外的知识点。
- 保留 sourceRef、difficulty；如果修正了题目，explanation 要同步修正。
- 只输出严格 JSON，不要输出其他内容：
{"questions":[{"type":"concept","title":"知识点标题","sourceRef":"素材中的id","difficulty":"medium","prompt":"题目","options":["选项A","选项B","选项C","选项D"],"correctIndex":0,"explanation":"解析"}]}`;

function _parseQuizPromptFile(text) {
  const source = String(text || '');
  if (!source.trim()) return {};
  const generation = source.match(/##\s*出题\s*\n([\s\S]*?)(?=\n##\s*审题\s*\n|$)/i);
  const verify = source.match(/##\s*审题\s*\n([\s\S]*)$/i);
  return {
    generate: generation ? generation[1].trim() : '',
    verify: verify ? verify[1].trim() : '',
  };
}

async function _loadQuizPromptFile() {
  if (quizPromptCache) return quizPromptCache;
  if (!quizPromptCachePromise) {
    quizPromptCachePromise = fetch(QUIZ_PROMPT_PATH, { cache: 'no-cache' })
      .then(resp => resp.ok ? resp.text() : '')
      .then(text => {
        quizPromptCache = _parseQuizPromptFile(text);
        return quizPromptCache;
      })
      .catch(() => {
        quizPromptCache = {};
        return quizPromptCache;
      });
  }
  return quizPromptCachePromise;
}

function _resetQuizPromptFile() {
  quizPromptCache = null;
  quizPromptCachePromise = null;
}
const QUIZ_GENERIC_FORMULAS = [
  { latex: 'E=mc^2', label: '质能关系' },
  { latex: 'F=ma', label: '牛顿第二定律' },
  { latex: 'E=\\frac{1}{2}mv^2', label: '动能公式' },
  { latex: 'F=-kx', label: '胡克定律' },
  { latex: 'pV=nRT', label: '理想气体状态方程' },
  { latex: '\\int_a^b f(x)\\,dx', label: '定积分' },
  { latex: '\\frac{d}{dx}x^n=nx^{n-1}', label: '幂函数求导' },
  { latex: '\\sin^2\\theta+\\cos^2\\theta=1', label: '三角恒等式' },
  { latex: 'V=\\frac{4}{3}\\pi r^3', label: '球体体积' },
  { latex: 'T=2\\pi\\sqrt{\\frac{L}{g}}', label: '单摆周期' }
];
let quizState = null;
let quizDataCache = null;
let quizAiRequestId = 0;
let quizAiController = null;
const QUIZ_AI_TIMEOUT_MS = 20000;

function _quizEscape(text) {
  const div = document.createElement('div');
  div.textContent = String(text || '');
  return div.innerHTML;
}

function _renderQuizRichText(text) {
  if (typeof renderMarkdown === 'function') {
    try { return renderMarkdown(String(text || '')); } catch (e) {}
  }
  return _quizEscape(text);
}

function _quizCleanText(text, max = 180) {
  const s = String(text || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  return max > 0 && s.length > max ? s.slice(0, max).trim() + '…' : s;
}

function _quizCleanSummary(text, max = 180) {
  const s = _quizCleanText(text, max > 0 ? max * 3 : 0);
  if (!s || s === '无') return '';
  const cardIdx = s.search(/PhyMathia\s*学习卡片/);
  const summary = cardIdx >= 0 ? s.slice(cardIdx).replace(/PhyMathia\s*学习卡片\s*[:：]?\s*/g, '') : s;
  const cleaned = summary
    .replace(/^[🔬📐🧠💡🗺️\s]+/g, '')
    .replace(/(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考)[：:]\s*/g, '')
    .trim();
  return max > 0 && cleaned.length > max ? cleaned.slice(0, max).trim() + '…' : cleaned;
}

function _quizFormulaText(latex) {
  let s = String(latex || '').trim();
  if (typeof _normalizeFormulaLatex === 'function') {
    s = _stripFormulaDelimiters(_normalizeFormulaLatex(s));
  } else if (typeof _stripFormulaDelimiters === 'function') {
    s = _stripFormulaDelimiters(s);
  }
  return s;
}

function _quizFormulaHtml(latex) {
  const s = _quizFormulaText(latex);
  if (!s) return '';
  if (typeof katex !== 'undefined') {
    try {
      return katex.renderToString(s, { throwOnError: false, displayMode: true });
    } catch (e) {}
  }
  return '<code>' + _quizEscape(s) + '</code>';
}

function _quizLooksLikeFormula(text) {
  const s = String(text || '').trim();
  if (!s || s.length === 1) return false;
  if (/^[A-Za-z]{1,3}$/.test(s)) return false;
  if (/^\\[A-Za-z]+$/.test(s)) return false;
  return true;
}

function _quizUsableFormula(latex) {
  const s = _quizFormulaText(latex);
  if (!s) return '';
  if (typeof _looksLikeFormula === 'function' && !_looksLikeFormula(s)) return '';
  if (/\\dots|\\cdots|\\langle|\\rangle/.test(s) && !/[=<>]/.test(s)) return '';
  if (/^[A-Za-z0-9_(){}.\s]+$/.test(s) && !/[=+\-*/^]/.test(s) && s.length < 6) return '';
  return s;
}

function _quizTopicKey(item) {
  const title = String(item && (item.title || item.concept || item.latex) || '').trim();
  return _quizOptionKey((item && item.sessionId || '') + '|' + title.replace(/[^\w\u4e00-\u9fff]+/g, ''));
}

function _quizDifficultyKey(value) {
  const v = String(value || '').toLowerCase();
  return ['easy', 'medium', 'hard'].includes(v) ? v : 'medium';
}

const QUIZ_MODULE_TITLE_KEYWORDS = [
  '苏格拉底',
  '延伸思考',
  '知识图谱',
  '物理直觉',
  '数学本质',
  '物理视角',
  '数学视角',
  '进阶学习方向',
  '学习方向',
  '学习卡片',
  '相关公式',
  '公式速查',
  '公式查询',
  '知识总览',
  'phymathia'
];

function _quizCleanTitle(title) {
  let s = String(title || '').trim();
  s = s.replace(/^#{1,6}\s*/, '');
  s = s.replace(/^[🔬📐🧠💡🗺️]+\s*/, '');
  s = s.replace(/^\s*\d+[.、)）]\s*/, '');
  return s.trim();
}

function _quizUsableTitle(title) {
  const s = _quizCleanTitle(title).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s || s.length < 2) return false;
  if (QUIZ_MODULE_TITLE_KEYWORDS.some(keyword => s.includes(keyword))) return false;
  if (/^(当前会话知识上下文|知识上下文|出题素材)$/.test(s)) return false;
  if (/^(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向|学习方向)[：:]/.test(s)) return false;
  return true;
}

function _quizIsMetaPrompt(text) {
  const s = _quizOptionKey(text);
  if (!s) return false;
  return /当前会话知识上下文|知识上下文|出题素材|多少个汉字|多少汉字|多少个字|有几个汉字|字符数|字符串长度|知识点数量|知识点个数|知识点总数|题干数量|题干个数|标题长度|格式长度/.test(s);
}

function _quizMentionsPoolContent(text, options, pool) {
  const haystack = _quizOptionKey([text, ...(options || []).map(option => option.text || '')].join('\n'));
  if (!haystack) return false;
  const needles = [];
  for (const item of pool.knowledge || []) {
    if (item.title && item.title.length >= 2) needles.push(_quizOptionKey(item.title));
    if (item.summary && item.summary.length >= 4 && item.summary !== '无') needles.push(_quizOptionKey(item.summary));
  }
  for (const item of pool.formulas || []) {
    if (item.latex && item.latex.length >= 2) needles.push(_quizOptionKey(item.latex));
    if (item.concept && item.concept.length >= 2) needles.push(_quizOptionKey(item.concept));
  }
  return needles.some(needle => needle.length >= 2 && (haystack.includes(needle) || needle.includes(haystack)));
}

function _quizCurrentSessionIds() {
  const ids = new Set();
  const localId = typeof window !== 'undefined' && typeof window.getCurrentSessionId === 'function'
    ? window.getCurrentSessionId()
    : (typeof currentSessionId !== 'undefined' ? currentSessionId : '');
  if (localId) ids.add(localId);
  if (typeof SESSION_ID !== 'undefined' && SESSION_ID) ids.add(SESSION_ID);
  return ids;
}

function _quizSessionIdVariants(sessionId) {
  const ids = new Set([sessionId]);
  if (typeof window.getSessionIdVariants === 'function') {
    for (const id of (window.getSessionIdVariants(sessionId) || [])) ids.add(id);
    return ids;
  }
  if (typeof getSessionById === 'function') {
    const session = getSessionById(sessionId);
    if (session && session.sessionId) ids.add(session.sessionId);
  }
  return ids;
}

function _quizItemInSession(item) {
  if (!item || typeof item !== 'object') return false;
  const ids = _quizCurrentSessionIds();
  if (ids.size === 0) return true;
  return ids.has(item.sessionId || '');
}

function _filterQuizMap(map) {
  const result = {};
  for (const [id, item] of Object.entries(map || {})) {
    if (_quizItemInSession(item)) result[id] = item;
  }
  return result;
}

async function _fetchQuizData() {
  let serverKnowledge = {};
  let serverFormulas = {};
  try {
    const [knowResp, formulaResp] = await Promise.all([
      fetch('/api/knowledge', { cache: 'no-cache' }),
      fetch('/api/formulas', { cache: 'no-cache' })
    ]);
    if (knowResp.ok) {
      const payload = await knowResp.json();
      if (Array.isArray(payload)) {
        for (const item of payload) if (item && item.id) serverKnowledge[item.id] = item;
      } else if (payload && typeof payload === 'object' && payload.items) {
        const inner = payload.items;
        if (Array.isArray(inner)) {
          for (const item of inner) if (item && item.id) serverKnowledge[item.id] = item;
        } else if (inner && typeof inner === 'object') {
          serverKnowledge = inner;
        }
      } else if (payload && typeof payload === 'object') {
        serverKnowledge = payload;
      }
    }
    if (formulaResp.ok) {
      const payload = await formulaResp.json();
      if (Array.isArray(payload)) {
        for (const item of payload) if (item && item.id) serverFormulas[item.id] = item;
      } else if (payload && typeof payload === 'object' && payload.items) {
        for (const item of payload.items) if (item && item.id) serverFormulas[item.id] = item;
      } else if (payload && typeof payload === 'object') {
        serverFormulas = payload;
      }
    }
  } catch (e) {
    console.warn('Quiz data fetch failed:', e);
  }

  const localKnowledge = typeof getKnowledgeItems === 'function' ? getKnowledgeItems() : {};
  const localFormulas = typeof getFormulaCache === 'function' ? getFormulaCache() : {};
  return {
    knowledge: { ..._filterQuizMap(localKnowledge), ..._filterQuizMap(serverKnowledge) },
    formulas: { ..._filterQuizMap(localFormulas), ..._filterQuizMap(serverFormulas) }
  };
}

function _buildQuizPool(data) {
  const knowledge = [];
  const formulas = [];
  for (const [id, item] of Object.entries(data.knowledge || {})) {
    if (!item || typeof item !== 'object') continue;
    if (!_quizUsableTitle(item.title)) continue;
    const rawFormulas = Array.isArray(item.formulas) ? item.formulas : [];
    const formulaSet = new Set();
    for (const raw of rawFormulas) {
      const latex = _quizUsableFormula(raw);
      if (!latex) continue;
      formulaSet.add(latex);
    }
    const knowledgeItem = {
      id: id || 'k_' + knowledge.length,
      title: _quizCleanTitle(item.title) || '未命名知识点',
      summary: _quizCleanSummary(item.summary, 170),
      formulas: Array.from(formulaSet),
      category: item.category || 'other',
      sessionId: item.sessionId || ''
    };
    knowledgeItem.topicKey = _quizTopicKey(knowledgeItem);
    knowledge.push(knowledgeItem);
  }

  for (const [id, item] of Object.entries(data.formulas || {})) {
    if (!item || typeof item !== 'object') continue;
    const latex = _quizUsableFormula(item.latex);
    if (!latex) continue;
    const formulaItem = {
      id: id || 'f_' + formulas.length,
      latex,
      concept: _quizCleanText(item.concept, 80),
      meaning: _quizCleanSummary(item.meaning, 170),
      sessionId: item.sessionId || ''
    };
    formulaItem.topicKey = _quizTopicKey(formulaItem);
    formulas.push(formulaItem);
  }

  const seenFormulas = new Set();
  const uniqueFormulas = [];
  for (const item of formulas) {
    const key = item.latex.replace(/\s+/g, ' ');
    if (!seenFormulas.has(key)) {
      seenFormulas.add(key);
      uniqueFormulas.push(item);
    }
  }
  return { knowledge, formulas: uniqueFormulas };
}

function _quizShuffle(arr) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function _genericFormulaDistractors(excludeKeys, conceptLabel, limit = 4) {
  const conceptKey = _quizOptionKey(conceptLabel || '');
  return QUIZ_GENERIC_FORMULAS
    .filter(item => {
      const key = _quizOptionKey(item.latex);
      return !excludeKeys.has(key) && _quizOptionKey(item.label) !== conceptKey;
    })
    .slice(0, limit)
    .map(item => item.latex);
}

function _quizOptionKey(text) {
  return String(text || '').replace(/\s+/g, ' ').toLowerCase();
}

function _makeQuizOptions(correct, distractors, count = 4) {
  const options = [{ key: '', text: correct }];
  const seen = new Set([_quizOptionKey(correct)]);
  for (const text of _quizShuffle(distractors || [])) {
    const key = _quizOptionKey(text);
    if (!text || seen.has(key)) continue;
    seen.add(key);
    options.push({ key: '', text });
    if (options.length >= count) break;
  }
  while (options.length < count) {
    const filler = '以上都不是';
    if (seen.has(_quizOptionKey(filler))) break;
    seen.add(_quizOptionKey(filler));
    options.push({ key: '', text: filler });
  }
  const shuffled = _quizShuffle(options);
  const correctIndex = shuffled.findIndex(o => _quizOptionKey(o.text) === _quizOptionKey(correct));
  shuffled.forEach((o, i) => { o.key = String.fromCharCode(65 + i); });
  return { options: shuffled, correctIndex };
}

function _quizSignature(q) {
  const correct = q.options && q.options[q.correctIndex] ? q.options[q.correctIndex].text : '';
  return q.type + '|' + q.prompt + '|' + (q.promptHtml || '') + '|' + _quizOptionKey(correct);
}

function _decorateQuizQuestion(q, item) {
  q.topicKey = item.topicKey || _quizTopicKey(item);
  q.sourceRef = item.id || '';
  q.sourceType = item.latex ? 'formula' : 'knowledge';
  q.difficulty = q.difficulty || 'medium';
  return q;
}

function _buildConceptQuestions(pool) {
  const items = pool.knowledge.filter(k => k.title && k.summary);
  const result = [];
  const seen = new Set();
  for (const item of _quizShuffle(items)) {
    const distractors = items
      .filter(o => o.id !== item.id && o.summary)
      .map(o => o.summary)
      .filter(s => _quizOptionKey(s) !== _quizOptionKey(item.summary));
    if (distractors.length < 1) continue;
    const made = _makeQuizOptions(item.summary, distractors, Math.min(4, distractors.length + 1));
    const q = {
      id: 'concept_' + result.length,
      type: 'concept',
      title: item.title,
      prompt: '“' + item.title + '”最匹配哪条概述？',
      promptHtml: '',
      options: made.options,
      correctIndex: made.correctIndex,
      refId: item.id,
      sessionId: item.sessionId,
      explanation: '正确答案：' + item.summary
    };
    _decorateQuizQuestion(q, item);
    const sig = _quizSignature(q);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(q);
    }
  }
  return result;
}

function _buildReverseConceptQuestions(pool) {
  const items = pool.knowledge.filter(k => k.title && k.summary);
  const result = [];
  const seen = new Set();
  for (const item of _quizShuffle(items)) {
    const distractors = items
      .filter(o => o.id !== item.id && o.title)
      .map(o => o.title)
      .filter(s => _quizOptionKey(s) !== _quizOptionKey(item.title));
    if (distractors.length < 1) continue;
    const made = _makeQuizOptions(item.title, distractors, Math.min(4, distractors.length + 1));
    const q = {
      id: 'reverse_concept_' + result.length,
      type: 'reverse_concept',
      title: item.title,
      prompt: '“' + _quizCleanSummary(item.summary, 90) + '”最可能指哪个知识点？',
      promptHtml: '',
      options: made.options,
      correctIndex: made.correctIndex,
      refId: item.id,
      sessionId: item.sessionId,
      explanation: item.summary
    };
    _decorateQuizQuestion(q, item);
    const sig = _quizSignature(q);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(q);
    }
  }
  return result;
}

function _buildFormulaMeaningQuestions(pool) {
  const items = pool.formulas.filter(f => f.latex && f.meaning);
  const result = [];
  const seen = new Set();
  for (const item of _quizShuffle(items)) {
    const distractors = items
      .filter(o => o.id !== item.id && o.meaning)
      .map(o => o.meaning)
      .filter(s => _quizOptionKey(s) !== _quizOptionKey(item.meaning));
    if (distractors.length < 1) continue;
    const made = _makeQuizOptions(item.meaning, distractors, Math.min(4, distractors.length + 1));
    const q = {
      id: 'formula_meaning_' + result.length,
      type: 'formula_meaning',
      title: item.concept || ('公式 ' + item.latex),
      prompt: '下面这条公式描述的是什么？',
      promptHtml: _quizFormulaHtml(item.latex),
      formulaText: item.latex,
      options: made.options,
      correctIndex: made.correctIndex,
      refId: item.id,
      sessionId: item.sessionId,
      explanation: item.meaning
    };
    _decorateQuizQuestion(q, item);
    const sig = _quizSignature(q);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(q);
    }
  }
  return result;
}

function _buildFormulaConceptQuestions(pool) {
  const items = pool.formulas.filter(f => f.latex && f.concept && _quizUsableTitle(f.concept));
  const result = [];
  const seen = new Set();
  const seenConcepts = new Set();
  const poolKeys = new Set(pool.formulas.map(f => _quizOptionKey(f.latex)));
  for (const item of _quizShuffle(items)) {
    const conceptKey = _quizOptionKey(item.concept);
    if (seenConcepts.has(conceptKey)) continue;
    const realDistractors = pool.formulas
      .filter(o => o.id !== item.id && o.concept && o.latex &&
        _quizOptionKey(o.concept) !== conceptKey &&
        _quizOptionKey(o.latex) !== _quizOptionKey(item.latex))
      .map(o => o.latex);
    const excludeKeys = new Set(poolKeys);
    excludeKeys.add(_quizOptionKey(item.latex));
    const genericDistractors = _genericFormulaDistractors(excludeKeys, item.concept, 4);
    const distractors = Array.from(new Set([...realDistractors, ...genericDistractors]));
    if (distractors.length < 1) continue;
    seenConcepts.add(conceptKey);
    const made = _makeQuizOptions(item.latex, distractors, Math.min(4, distractors.length + 1));
    made.options.forEach(o => {
      if (_quizLooksLikeFormula(o.text)) o.html = _quizFormulaHtml(o.text);
    });
    const q = {
      id: 'formula_concept_' + result.length,
      type: 'formula_concept',
      title: item.concept,
      prompt: '下面哪个公式属于“' + item.concept + '”的公式？',
      promptHtml: '',
      options: made.options,
      correctIndex: made.correctIndex,
      refId: item.id,
      sessionId: item.sessionId,
      explanation: item.concept + ' 相关公式示例：' + item.latex
    };
    _decorateQuizQuestion(q, item);
    const sig = _quizSignature(q);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(q);
    }
  }
  return result;
}

function _buildKnowledgeFormulaQuestions(pool) {
  const items = pool.knowledge.filter(k => k.formulas.length > 0);
  const result = [];
  const seen = new Set();
  for (const item of _quizShuffle(items)) {
    const correct = item.formulas[0];
    const otherFormulas = new Set();
    for (const k of pool.knowledge) {
      if (k.id === item.id) continue;
      for (const f of k.formulas) {
        if (_quizOptionKey(f) !== _quizOptionKey(correct)) otherFormulas.add(f);
      }
    }
    for (const f of pool.formulas) {
      if (f.concept && _quizOptionKey(f.concept) !== _quizOptionKey(item.title)) {
        if (_quizOptionKey(f.latex) !== _quizOptionKey(correct)) otherFormulas.add(f.latex);
      }
    }
    const excludeKeys = new Set([_quizOptionKey(correct)]);
    for (const k of pool.knowledge) {
      for (const f of k.formulas) excludeKeys.add(_quizOptionKey(f));
    }
    for (const g of _genericFormulaDistractors(excludeKeys, item.title, 4)) otherFormulas.add(g);
    const distractors = Array.from(otherFormulas);
    if (distractors.length < 1) continue;
    const made = _makeQuizOptions(correct, distractors, Math.min(4, distractors.length + 1));
    made.options.forEach(o => {
      if (_quizLooksLikeFormula(o.text)) o.html = _quizFormulaHtml(o.text);
    });
    const q = {
      id: 'knowledge_formula_' + result.length,
      type: 'knowledge_formula',
      title: item.title,
      prompt: '“' + item.title + '”中涉及哪条公式？',
      promptHtml: '',
      options: made.options,
      correctIndex: made.correctIndex,
      refId: item.id,
      sessionId: item.sessionId,
      explanation: item.title + '：' + correct
    };
    _decorateQuizQuestion(q, item);
    const sig = _quizSignature(q);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(q);
    }
  }
  return result;
}

function _buildCategoryQuestions(pool) {
  const items = pool.knowledge.filter(k => k.title && k.category);
  const categories = ['physics', 'math', 'other'];
  const labels = { physics: '物理', math: '数学', other: '其他' };
  const result = [];
  const seen = new Set();
  for (const item of _quizShuffle(items)) {
    const distractors = categories
      .filter(c => c !== item.category)
      .map(c => labels[c] || c);
    const made = _makeQuizOptions(labels[item.category] || item.category, distractors, Math.min(4, distractors.length + 1));
    const q = {
      id: 'category_' + result.length,
      type: 'category',
      title: item.title,
      prompt: '“' + item.title + '”通常归类为？',
      promptHtml: '',
      options: made.options,
      correctIndex: made.correctIndex,
      refId: item.id,
      sessionId: item.sessionId,
      explanation: labels[item.category] || item.category
    };
    _decorateQuizQuestion(q, item);
    const sig = _quizSignature(q);
    if (!seen.has(sig)) {
      seen.add(sig);
      result.push(q);
    }
  }
  return result;
}

function _generateQuizQuestions(pool) {
  const builders = [
    _buildConceptQuestions,
    _buildReverseConceptQuestions,
    _buildFormulaMeaningQuestions,
    _buildFormulaConceptQuestions,
    _buildKnowledgeFormulaQuestions,
    _buildCategoryQuestions
  ];
  const byType = {};
  const seen = new Set();
  for (const builder of builders) {
    for (const q of builder(pool)) {
      const sig = _quizSignature(q);
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (!byType[q.type]) byType[q.type] = [];
      byType[q.type].push(q);
    }
  }
  const result = [];
  const types = Object.keys(byType);
  let added = true;
  while (result.length < quizTargetCount && added) {
    added = false;
    for (const type of types) {
      const next = byType[type].shift();
      if (!next) continue;
      result.push(next);
      added = true;
      if (result.length >= quizTargetCount) break;
    }
  }
  return result;
}

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

function _sanitizeAIQuestions(raw, pool) {
  let data;
  try {
    const text = String(raw || '').trim();
    const match = text.match(/\{[\s\S]*\}/) || text.match(/\[[\s\S]*\]/);
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
    const options = rawOptions.map((option, idx) => {
      const text = typeof option === 'string' ? option : String(option?.text || option?.label || '');
      return {
        key: String.fromCharCode(65 + idx),
        text: _quizCleanText(text, 220),
        html: _quizLooksLikeFormula(text) ? _quizFormulaHtml(text) : ''
      };
    });
    if (options.some(option => !option.text)) continue;
    if (new Set(options.map(option => _quizOptionKey(option.text))).size !== options.length) continue;
    const correctIndex = Number(item.correctIndex);
    if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= options.length) continue;
    const title = _quizCleanTitle(item.title) || '';
    const formulaText = item.formulaText || item.formula || '';
    const questionText = [prompt, title, formulaText, ...options.map(option => option.text)].join('\n');
    if (_quizIsMetaPrompt(questionText)) continue;
    const sourceRef = String(item.sourceRef || item.topicId || '');
    const titleKey = _quizOptionKey(title.replace(/[^\w\u4e00-\u9fff]+/g, ''));
    const keyOf = value => _quizOptionKey(String(value || '').replace(/[^\w\u4e00-\u9fff]+/g, ''));
    const sourceMatched = !!(sourceRef && (pool.knowledge.find(k => k.id === sourceRef) || pool.formulas.find(f => f.id === sourceRef)));
    const matched = (sourceRef && (pool.knowledge.find(k => k.id === sourceRef) || pool.formulas.find(f => f.id === sourceRef)))
      || (titleKey && pool.knowledge.find(k => keyOf(k.title) === titleKey))
      || (titleKey && pool.formulas.find(f => keyOf(f.concept) === titleKey))
      || (titleKey && pool.knowledge.find(k => keyOf(k.title).includes(titleKey) || titleKey.includes(keyOf(k.title))))
      || null;
    if (!matched) continue;
    if (!sourceMatched && !_quizMentionsPoolContent(questionText, options, pool)) continue;
    result.push({
      id: 'ai_' + now + '_' + i,
      type: ['concept', 'formula_meaning', 'formula_concept', 'knowledge_formula', 'category'].includes(item.type) ? item.type : 'ai',
      title: title || matched.title || matched.concept || '检测题',
      prompt,
      promptHtml: formulaText ? _quizFormulaHtml(formulaText) : '',
      formulaText: formulaText ? _quizFormulaText(formulaText) : '',
      options,
      correctIndex,
      explanation: _quizCleanText(item.explanation, 300) || '正确答案：' + options[correctIndex].text,
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
  const context = _buildQuizGenerationContext(pool);
  quizAiStatusText = 'AI 正在生成检测题…';
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
    const raw = await _readModelStream(resp);
    const questions = _sanitizeAIQuestions(raw, pool);
    if (requestId !== undefined && requestId !== quizAiRequestId) return null;
    if (verify && questions.length >= 2) {
      quizAiStatusText = 'AI 正在校验题目…';
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
  }
}

function _mergeQuizQuestions(aiQuestions, localQuestions) {
  const seen = new Set((aiQuestions || []).map(q => _quizSignature(q)));
  const result = (aiQuestions || []).slice();
  for (const q of localQuestions || []) {
    const sig = _quizSignature(q);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.push(q);
    if (result.length >= quizTargetCount) break;
  }
  return result;
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
    const raw = await _readModelStream(resp);
    const verified = _sanitizeAIQuestions(raw, pool);
    return verified.length >= 2 ? verified : null;
  } catch (e) {
    if (e && e.name === 'AbortError') console.warn('AI quiz verification timed out or superseded');
    else console.warn('AI quiz verification failed:', e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (controller && quizAiController === controller) quizAiController = null;
  }
}

async function _generateQuestions(pool) {
  const requestId = ++quizAiRequestId;
  if (quizAiController) quizAiController.abort();
  const ai = await _aiGenerateQuizQuestions(pool, requestId) || [];
  return _mergeQuizQuestions(ai, _generateQuizQuestions(pool));
}

function _startQuizGeneration(pool) {
  const requestId = ++quizAiRequestId;
  if (quizAiController) quizAiController.abort();
  const local = _generateQuizQuestions(pool);
  const promise = _aiGenerateQuizQuestions(pool, requestId).then(ai => {
    if (requestId !== quizAiRequestId || !quizState) return null;
    const merged = _mergeQuizQuestions(ai || [], local);
    if (merged.length >= 2) {
      quizState.questions = merged;
    }
    quizState.aiPending = false;
    if (quizState.phase === 'intro') {
      renderQuiz();
    }
    return merged;
  }).catch(() => {
    if (quizState) quizState.aiPending = false;
    return null;
  });
  if (quizState) {
    quizState.aiPromise = promise;
    quizState.aiPending = true;
  }
  return { local, promise };
}

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
    const localUpdated = (local._meta && local._meta.updatedAt) || 0;
    const serverUpdated = (server._meta && server._meta.updatedAt) || 0;
    const merged = serverUpdated >= localUpdated
      ? { ...local, ...server, _meta: { ...(local._meta || {}), ...(server._meta || {}) } }
      : local;
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
  return Math.max(0, Math.min(100, Math.round(recentRate * 80 + (total ? c / total * 15 : 0) + streakBonus)));
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
    history: []
  };
  current.correct = (current.correct || 0) + (correct ? 1 : 0);
  current.wrong = (current.wrong || 0) + (correct ? 0 : 1);
  current.correctStreak = correct ? (current.correctStreak || 0) + 1 : 0;
  current.wrongStreak = correct ? 0 : (current.wrongStreak || 0) + 1;
  current.last = Date.now();
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
    version: 2,
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
    stats._meta.wrongQuestions = wrongList.filter(w => _wrongQuestionKey(w) !== wrongKey);
  }
  _saveQuizStats(stats);
}

function _wrongQuestionKey(question) {
  const correct = question.options && question.options[question.correctIndex]
    ? question.options[question.correctIndex].text
    : '';
  return _quizOptionKey((question.prompt || '') + '|' + (question.formulaText || '') + '|' + correct);
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

function _readWrongQuestions() {
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
    if (!_quizItemInSession(item)) return false;
    const text = [item.prompt || '', item.title || '', item.formulaText || '',
      ...(Array.isArray(item.options) ? item.options.map(option => option.text || '') : [])].join('\n');
    return !_quizIsMetaPrompt(text);
  });
}

function _quizStatSummary() {
  const stats = _readQuizStats();
  let correct = 0;
  let wrong = 0;
  const buckets = {};
  for (const [key, item] of Object.entries(stats)) {
    if (key === '_meta' || !item || typeof item !== 'object') continue;
    if (!_quizItemInSession(item)) continue;
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
      sessionId: item.sessionId || ''
    };
    bucket.correct += c;
    bucket.wrong += w;
    bucket.last = Math.max(bucket.last, item.last || 0);
    bucket.history = bucket.history.concat(Array.isArray(item.history) ? item.history : []);
    bucket.sessionId = item.sessionId || bucket.sessionId || '';
    buckets[topicKey] = bucket;
  }
  const topics = Object.values(buckets);
  for (const item of topics) item.mastery = _quizMastery(item);
  const weak = topics
    .filter(item => item.wrong > 0 && (item.wrong >= item.correct || item.mastery < 70))
    .sort((a, b) => (a.mastery - b.mastery) || (b.wrong - a.wrong));
  const review = topics
    .filter(item => item.wrong > 0)
    .sort((a, b) => (a.mastery - b.mastery) || ((a.last || 0) - (b.last || 0)))
    .slice(0, 8);
  const openResults = Array.isArray(stats._meta && stats._meta.openResults) ? stats._meta.openResults : [];
  const openCount = openResults.filter(item => _quizItemInSession(item)).length;
  return {
    correct,
    wrong,
    total: correct + wrong,
    rate: correct + wrong ? Math.round(correct / (correct + wrong) * 100) : 0,
    weak: weak.slice(0, 5),
    review,
    reviewCount: review.length,
    openCount,
    wrongCount: _readWrongQuestions().length
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

async function openQuiz() {
  const overlay = document.getElementById('quizModal');
  if (!overlay) return;
  quizFilterTopic = 'all';
  overlay.hidden = false;
  overlay.classList.add('active');
  document.body.style.overflow = 'hidden';
  quizState = { phase: 'loading' };
  renderQuiz();
  await _loadQuizStatsFromServer();
  _resetQuizPromptFile();
  try {
    const data = await _fetchQuizData();
    const pool = _buildQuizPool(data);
    quizDataCache = pool;
    quizState = { phase: 'loading', pool };
    renderQuiz();
    const generation = _startQuizGeneration(pool);
    quizState = {
      phase: 'intro',
      pool,
      questions: generation.local,
      aiPromise: generation.promise,
      aiPending: true,
      openQuestions: _generateOpenQuestions(pool),
      wrongList: _readWrongQuestions(),
      explaining: false,
      explainText: '',
      explainError: ''
    };
  } catch (e) {
    console.warn('Quiz build failed:', e);
    quizState = {
      phase: 'intro',
      pool: { knowledge: [], formulas: [] },
      questions: [],
      openQuestions: [],
      wrongList: [],
      explaining: false,
      explainText: '',
      explainError: ''
    };
  }
  renderQuiz();
}

function closeQuiz() {
  const overlay = document.getElementById('quizModal');
  if (overlay) {
    overlay.classList.remove('active');
    overlay.hidden = true;
  }
  document.body.style.overflow = '';
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
  quizState.phase = 'question';
  quizState.index = 0;
  quizState.answers = [];
  _resetQuizExplain();
  renderQuiz();
}

async function reshuffleQuiz(startAfter = true) {
  if (!quizState || !quizState.pool) return;
  quizState.phase = 'loading';
  renderQuiz();
  _resetQuizPromptFile();
  const questions = await _generateQuestions(quizState.pool);
  quizState.questions = questions;
  if (!questions.length) {
    quizState.phase = 'intro';
    renderQuiz();
    return;
  }
  if (startAfter) startQuiz(); else renderQuiz();
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

async function _scoreOpenAnswer(question, answer) {
  const model = typeof getActiveModelForRole === 'function'
    ? (getActiveModelForRole('agent') || getActiveModelForRole('quiz'))
    : null;
  if (!model) return { error: '未配置模型，无法评分' };
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
{"scores":{"physics":7,"math":8,"connection":9,"clarity":8},"feedback":"一句到三句中文反馈"}`;
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
    const match = String(raw || '').match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON');
    const data = JSON.parse(match[0]);
    const scores = data.scores || {};
    return {
      scores: {
        physics: Math.max(0, Math.min(10, Number(scores.physics) || 0)),
        math: Math.max(0, Math.min(10, Number(scores.math) || 0)),
        connection: Math.max(0, Math.min(10, Number(scores.connection) || 0)),
        clarity: Math.max(0, Math.min(10, Number(scores.clarity) || 0))
      },
      feedback: String(data.feedback || '').trim()
    };
  } catch (e) {
    console.warn('Open answer scoring failed:', e);
    return { error: '模型评分失败' };
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

async function _readModelStream(resp) {
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
          const delta = data.choices?.[0]?.delta;
          if (delta && delta.content) content += delta.content;
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
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
  const optionLines = question.options
    .map(option => `${option.key}. ${_quizCleanText(option.text, 220)}`)
    .join('\n');
  const formulaLine = question.formulaText ? `\n公式：${question.formulaText}` : '';
  const prompt = `题目：${question.prompt}${formulaLine}\n选项：\n${optionLines}\n\n我没看懂这道题，请解析。`;
  quizState.explaining = true;
  quizState.explainText = '';
  quizState.explainError = '';
  renderQuiz();

  const model = typeof getActiveModelForRole === 'function'
    ? (getActiveModelForRole('agent') || getActiveModelForRole('quiz'))
    : null;
  if (!model) {
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

function _renderQuizIntro() {
  const body = document.getElementById('quizBody');
  const stats = _quizStatSummary();
  const hasQuestions = !!(quizState && quizState.questions && quizState.questions.length);
  const hasOpen = !!(quizState && quizState.openQuestions && quizState.openQuestions.length);
  const hasWrong = stats.wrongCount > 0;
  if (!hasQuestions && !(quizState && quizState.aiPending)) {
    body.innerHTML = `
      <div class="quiz-empty">
        <div class="quiz-empty-icon">${UI_ICON_SVG.book}</div>
        <div class="quiz-empty-title">还没有足够的知识条目</div>
        <div class="quiz-empty-actions">
          <button class="quiz-btn-primary" onclick="closeQuiz();toggleKnowledgePanel()">打开知识总览</button>
          ${hasOpen ? '<button class="quiz-btn-primary" onclick="openOpenQuiz()">深度问答</button>' : ''}
          ${hasWrong ? `<button class="quiz-btn-primary" onclick="openWrongReview()">错题回顾(${hasWrong})</button>` : ''}
          <button class="quiz-btn-secondary" onclick="closeQuiz()">关闭</button>
        </div>
      </div>`;
    return;
  }
  if (!hasQuestions && quizState && quizState.aiPending) {
    body.innerHTML = `
      <div class="quiz-ai-status">
        <span>${_quizEscape(quizAiStatusText || 'AI 正在生成检测题…')}</span>
        <button class="quiz-btn-secondary" onclick="useLocalQuiz()">立即用本地题</button>
        <button class="quiz-btn-secondary" onclick="closeQuiz()">关闭</button>
      </div>`;
    return;
  }
  const countOptions = [3, 5, 8, 10].map(n =>
    `<option value="${n}" ${n === quizTargetCount ? 'selected' : ''}>${n} 题</option>`
  ).join('');
  body.innerHTML = `
    <div class="quiz-stats">
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.total}</span><span class="quiz-stat-label">已测</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.rate}%</span><span class="quiz-stat-label">正确率</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.reviewCount}</span><span class="quiz-stat-label">待复习</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.openCount}</span><span class="quiz-stat-label">深度问答</span></div>
    </div>
    ${quizState && quizState.aiPending ? `<div class="quiz-ai-status"><span>${_quizEscape(quizAiStatusText || 'AI 正在生成检测题…')}</span><button class="quiz-btn-secondary" onclick="useLocalQuiz()">立即用本地题</button></div>` : ''}
    <div class="quiz-setting-row">
      <span>题量</span>
      <select id="quizCountSelect" onchange="changeQuizQuestionCount()">${countOptions}</select>
    </div>
    <div class="quiz-start">
      <button class="quiz-btn-primary quiz-btn-large" onclick="startQuiz()" ${hasQuestions ? '' : 'disabled'}>开始检测</button>
      <button class="quiz-btn-primary" onclick="reshuffleQuiz()" ${hasQuestions ? '' : 'disabled'}>重新出题</button>
      <button class="quiz-btn-primary" onclick="openOpenQuiz()" ${hasOpen ? '' : 'disabled'}>深度问答${stats.openCount ? `(${stats.openCount})` : ''}</button>
      <button class="quiz-btn-primary" onclick="openWrongReview()" ${hasWrong ? '' : 'disabled'}>错题回顾${hasWrong ? `(${hasWrong})` : ''}</button>
      <button class="quiz-btn-secondary" onclick="clearQuizRecords()">清空记录</button>
      <button class="quiz-btn-secondary" onclick="closeQuiz()">关闭</button>
    </div>`;
}

function _renderQuizQuestion() {
  const body = document.getElementById('quizBody');
  if (!quizState) return;
  const question = quizState.questions[quizState.index];
  const answered = quizState.answers.find(a => a.questionId === question.id);
  const progress = Math.round((quizState.index + (answered ? 1 : 0)) / quizState.questions.length * 100);
  const difficultyLabels = { easy: '易', medium: '中', hard: '难' };
  const metaHtml = `<div class="quiz-question-meta">
    <span class="quiz-tag">${difficultyLabels[question.difficulty] || '中'}</span>
    <span class="quiz-tag">${question.sourceType === 'formula' ? '公式' : '知识点'}</span>
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
    const content = option.html || _quizEscape(option.text);
    return `<button class="${className}" onclick="chooseQuizOption('${option.key}')"${disabled}>
      <span class="quiz-option-key">${option.key}</span>
      <span class="quiz-option-body">${content}</span>
    </button>`;
  }).join('');
  const feedback = answered ? `
    <div class="quiz-feedback ${answered.correct ? 'ok' : 'bad'}">
      <strong>${answered.correct ? '回答正确' : '回答错误'}</strong>
      <div>${_renderQuizRichText(question.explanation)}</div>
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
      <div class="quiz-question-prompt">${_quizEscape(question.prompt)}</div>
      ${question.promptHtml ? `<div class="quiz-latex">${question.promptHtml}</div>` : ''}
      ${metaHtml}
      <div class="quiz-options">${optionsHtml}</div>
      <div class="quiz-question-help">
        <button class="quiz-help-btn" onclick="askQuizExplain()" ${quizState.explaining ? 'disabled' : ''}>${quizState.explaining ? '正在问 Phymathia...' : '这题没看懂，问 Phymathia'}</button>
      </div>
      ${explainHtml}
      ${feedback}
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
            <span>${_quizEscape(item.title)}</span>
            <span>掌握度 ${item.mastery || 0}% · ${item.wrong} 次答错</span>
          </div>`).join('')}
      </div>
    </div>
  ` : '<div class="quiz-weak-empty">本组没有待复习条目</div>';
  body.innerHTML = `
    <div class="quiz-result">
      <div class="quiz-score-ring">${rate}%</div>
      <div class="quiz-score-meta">${correct} / ${total} 题正确</div>
      ${weakHtml}
      <div class="quiz-result-actions">
        <button class="quiz-btn-primary" onclick="reshuffleQuiz()">重新出题</button>
        <button class="quiz-btn-primary" onclick="redoQuiz()">重做本组</button>
        <button class="quiz-btn-secondary" onclick="openWrongReview()">错题回顾${stats.wrongCount ? `(${stats.wrongCount})` : ''}</button>
        <button class="quiz-btn-secondary" onclick="openOpenQuiz()" ${hasOpen ? '' : 'disabled'}>深度问答${stats.openCount ? `(${stats.openCount})` : ''}</button>
        <button class="quiz-btn-secondary" onclick="closeQuiz()">关闭</button>
      </div>
    </div>`;
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
        <div class="quiz-wrong-prompt">${_quizEscape(item.prompt)}</div>
        ${formulaHtml}
        <div class="quiz-wrong-line"><span>你的答案</span>${_quizEscape(yourAnswer)}</div>
        <div class="quiz-wrong-line correct"><span>正确答案</span>${_quizEscape(correct)}</div>
        <div class="quiz-wrong-explain">${_renderQuizRichText(item.explanation)}</div>
        ${wrongTime ? `<div class="quiz-wrong-date">${_quizEscape(wrongTime)}</div>` : ''}
      </div>`;
  }).join('');
  body.innerHTML = `
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
  const scoreHtml = quizState.openResult && quizState.openResult.scores ? `
    <div class="quiz-open-scores">
      <div class="quiz-open-score"><span>物理直觉</span><strong>${quizState.openResult.scores.physics}</strong></div>
      <div class="quiz-open-score"><span>数学本质</span><strong>${quizState.openResult.scores.math}</strong></div>
      <div class="quiz-open-score"><span>数理联系</span><strong>${quizState.openResult.scores.connection}</strong></div>
      <div class="quiz-open-score"><span>表达清晰</span><strong>${quizState.openResult.scores.clarity}</strong></div>
    </div>
    <div class="quiz-feedback ok"><div>${_renderQuizRichText(quizState.openResult.feedback || '')}</div></div>
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
      <div class="quiz-question-prompt">${_quizEscape(question.prompt)}</div>
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
  const historyHtml = stored.slice(-3).reverse().map(item => `
    <div class="quiz-open-history-item">
      <span>${_quizEscape(item.title || '深度问答')}</span>
      <span>${(item.scores && item.scores.physics) || 0} / ${(item.scores && item.scores.math) || 0} / ${(item.scores && item.scores.connection) || 0} / ${(item.scores && item.scores.clarity) || 0}</span>
    </div>
  `).join('');
  body.innerHTML = `
    <div class="quiz-open-result">
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
    body.innerHTML = '<div class="quiz-loading"><div class="kp-spinner"></div><span>加载中</span></div>';
    return;
  }
  if (quizState.phase === 'question') {
    _renderQuizQuestion();
    return;
  }
  if (quizState.phase === 'result') {
    _renderQuizResult();
    return;
  }
  if (quizState.phase === 'wrong') {
    _renderWrongReview();
    return;
  }
  if (quizState.phase === 'open') {
    _renderOpenQuestion();
    return;
  }
  if (quizState.phase === 'open_result') {
    _renderOpenResult();
    return;
  }
  _renderQuizIntro();
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
window.closeQuiz = closeQuiz;
window.startQuiz = startQuiz;
window.reshuffleQuiz = reshuffleQuiz;
window.redoQuiz = redoQuiz;
window.changeQuizQuestionCount = changeQuizQuestionCount;
window.useLocalQuiz = useLocalQuiz;
window.openWrongReview = openWrongReview;
window.startWrongQuiz = startWrongQuiz;
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
