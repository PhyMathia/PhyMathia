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
let quizScope = 'current';
let quizMode = 'session';
let quizBankFilterSession = '';

const DEFAULT_QUIZ_GENERATION_PROMPT = `你是 PhyMathia 的出题老师。用户消息中的“出题素材”是从当前会话提取的真实知识点与公式，请只基于其中的知识点标题、概述、公式和分类生成物理数学检测题。
{{LEVEL_PROMPT}}
要求：
- 只根据给定内容出题，不要编造上下文之外的概念。
- 题目尽量联系现实生活、常见现象或工程场景，题干要具体、生动、有画面感。
- 现实场景不能改变正确答案；解析可以给简短类比或实际例子，但不能编造事实。
- 不要对“出题素材”“知识上下文”“标题”“格式”“字符数”“字符串长度”“包含多少个汉字”等元信息出题；不要把“出题素材”或“当前会话知识上下文”当作知识点。
- 每道题的题干、公式或选项中必须体现素材里的具体知识点标题、概述、公式或概念。
- 正确答案必须由素材中的概述、公式或分类直接推出；素材不足或答案不能唯一确定时，宁可不出这一题。
- 解析必须解释为什么，并引用素材中的概述或公式，不能引入素材之外的新结论。
- 解析和选项中不得出现 id、sourceRef、f_xxx、k_xxx 等内部标识；引用公式时写公式名称或公式本身。
- 所有公式必须用 <formula>纯LaTeX</formula> 包裹，禁止输出裸露的 LaTeX 源码。
- 题干、选项和解析中不得出现未包裹的 \frac、\partial、\sqrt、\int 等公式源码。
- 公式必须放在公式标签内，不要用 Markdown 代码块包裹公式。
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
- 保留生动、现实的题干场景，但场景不能引入素材之外的新结论。
- 题目数量可以减少，但不要新增素材之外的知识点。
- 解析和选项中不得出现 id、sourceRef、f_xxx、k_xxx 等内部标识；引用公式时写公式名称或公式本身。
- 所有公式必须用 <formula>纯LaTeX</formula> 包裹，禁止输出裸露的 LaTeX 源码。
- 题干、选项和解析中不得出现未包裹的 \frac、\partial、\sqrt、\int 等公式源码。
- 公式必须放在公式标签内，不要用 Markdown 代码块包裹公式。
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
const QUIZ_AI_TIMEOUT_MS = 60000;
const QUIZ_REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];
const QUIZ_REVIEW_AFTER_WRONG_MS = 15 * 60 * 1000;
const QUIZ_DAY_MS = 24 * 60 * 60 * 1000;
const QUIZ_BANK_KEY = 'phymathia_quiz_bank';
let quizSourcePreference = 'ai';
let quizBank = null;
let quizAiProgressTimer = null;
try {
  const savedPreference = localStorage.getItem('phymathia_quiz_source');
  if (savedPreference === 'ai' || savedPreference === 'mixed' || savedPreference === 'local') {
    quizSourcePreference = savedPreference;
  }
} catch (e) {}

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

function _quizInlineRichText(text) {
  return String(_renderQuizRichText(text) || '').replace(/^<p>|<\/p>$/g, '');
}

function _renderQuizMath(body) {
  if (!body) return;
  if (typeof renderMath === 'function') {
    try { renderMath(body); } catch (e) {}
  }
  if (typeof _initVizIframes === 'function') {
    try { _initVizIframes(body); } catch (e) {}
  }
}

function _startQuizProgress(max) {
  if (!quizState) return;
  if (quizAiProgressTimer) clearInterval(quizAiProgressTimer);
  const startedAt = Date.now();
  quizAiProgressTimer = setInterval(() => {
    if (!quizState || !quizState.aiPending) {
      clearInterval(quizAiProgressTimer);
      quizAiProgressTimer = null;
      return;
    }
    const elapsed = Date.now() - startedAt;
    const base = quizState.aiStage === 'verify' ? 90 : 5;
    const target = Math.min(max, base + Math.round(elapsed / 45000 * (max - base)));
    quizState.aiProgress = Math.max(quizState.aiProgress || 0, target);
    const fill = document.querySelector('#quizBody .quiz-ai-progress-fill');
    if (fill) fill.style.width = (quizState.aiProgress || 0) + '%';
  }, 250);
}

function _clearQuizProgressTimer() {
  if (quizAiProgressTimer) clearInterval(quizAiProgressTimer);
  quizAiProgressTimer = null;
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
    if (quizScope === 'all' || _quizItemInSession(item)) result[id] = item;
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
    quizDataCache = pool;
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
  await _generateQuestions(quizState.pool);
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
  quizState.questions = questions.slice(0, quizTargetCount);
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
  const entryLabel = quizMode === 'global' ? '全局检测' : '会话检测';
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
      <select id="quizCountSelect" onchange="changeQuizQuestionCount()">${countOptions}</select>
    </div>
    <div class="quiz-start">
      <button class="quiz-btn-primary quiz-btn-large" onclick="startQuiz()" ${hasQuestions ? '' : 'disabled'}>开始检测</button>
      <button class="quiz-btn-primary" onclick="reshuffleQuiz()" ${hasQuestions ? '' : 'disabled'} title="不会删除AI题库，仅重新生成当前这一组题">换一组题</button>
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
            <span>掌握度 ${item.mastery || 0}% · ${item.wrong} 次答错 · ${item.dueAt ? '下次复习 ' + _quizDueLabel(item.dueAt) : '等待安排'}</span>
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
          <span class="quiz-tag">${q.difficulty || 'medium'}</span>
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
      <button class="quiz-btn-primary" onclick="addQuizBankQuestions()">补充AI题</button>
    </div>
    <div class="quiz-wrong-head"><span>${quizBankFilterSession ? '会话题库' : (quizMode === 'global' ? '全局题库' : '会话题库')}</span><span>${questions.length} 题</span></div>
    <div class="quiz-wrong-list">${itemsHtml}</div>
    <div class="quiz-result-actions">
      <button class="quiz-btn-primary" onclick="startBankQuiz()">用题库开始</button>
      <button class="quiz-btn-secondary" onclick="backToQuizIntro()">返回</button>
    </div>`;
}

function _quizSessionChartSegments(sessions, rawStats) {
  const colors = ['#4a9eff', '#f59e0b', '#10b981', '#a855f7', '#22d3ee', '#f43f5e', '#84cc16', '#fb923c'];
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
      ${_quizEscape(segment.label)} · 正确率 ${segment.correctRate}%
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
    <line x1="${padLeft}" y1="${padTop}" x2="${padLeft}" y2="${height - padBottom}" stroke="#7a8ba8" stroke-width="1"/>
    <line x1="${padLeft}" y1="${height - padBottom}" x2="${width - padRight}" y2="${height - padBottom}" stroke="#7a8ba8" stroke-width="1"/>
    <text x="${padLeft - 6}" y="${padTop + 4}" fill="currentColor" font-size="9" text-anchor="end">100%</text>
    <text x="${padLeft - 6}" y="${height - padBottom + 4}" fill="currentColor" font-size="9" text-anchor="end">0%</text>
    <polyline points="${points}" fill="none" stroke="#4a9eff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
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
    const title = session.title || session.id || '未命名会话';
    return `
      <div class="quiz-global-session-card">
        <div class="quiz-global-session-title">${_quizEscape(title)}</div>
        <div class="quiz-global-session-stats">已测 ${total} · 正确率 ${rate}% · 错题 ${wrong} · 题库 ${bankCount}</div>
        <div class="quiz-global-actions">
          <button class="quiz-btn-primary" onclick="openSessionQuizFromGlobal('${id}')">查看答题</button>
          <button class="quiz-btn-secondary" onclick="openQuizBank('${id}')">查看题库</button>
        </div>
      </div>`;
  }).join('');
  body.innerHTML = `
    <div class="quiz-stats">
      <div class="quiz-stat"><span class="quiz-stat-num">${sessions.length}</span><span class="quiz-stat-label">会话</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.total}</span><span class="quiz-stat-label">已测</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.rate}%</span><span class="quiz-stat-label">正确率</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${stats.reviewCount}</span><span class="quiz-stat-label">待复习</span></div>
      <div class="quiz-stat"><span class="quiz-stat-num">${bankQuestions.length}</span><span class="quiz-stat-label">AI题库</span></div>
    </div>
    <div class="quiz-charts">
      <div class="quiz-chart-card">
        <div class="quiz-chart-title">会话正确率分布</div>
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
    <div class="quiz-global-title">会话答题概览</div>
    <div class="quiz-global-session-list">${sessionCards || '<div class="quiz-weak-empty">暂无会话</div>'}</div>`;
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
window.changeQuizScope = changeQuizScope;
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
