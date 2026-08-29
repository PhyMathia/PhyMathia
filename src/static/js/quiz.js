/* ====== 知识检测：核心状态、工具与出题构造 ====== */

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

const DEFAULT_QUIZ_GENERATION_PROMPT = `你是 PhyMathia 的出题老师。用户消息中的“出题素材”是从当前画布提取的真实知识点与公式，请只基于其中的知识点标题、概述、公式和分类生成物理数学检测题。
{{LEVEL_PROMPT}}
要求：
- 只根据给定内容出题，不要编造上下文之外的概念。
- 题目尽量联系现实生活、常见现象或工程场景，题干要具体、生动、有画面感。
- 现实场景不能改变正确答案；解析可以给简短类比或实际例子，但不能编造事实。
- 不要对“出题素材”“知识上下文”“标题”“格式”“字符数”“字符串长度”“包含多少个汉字”等元信息出题；不要把“出题素材”或“当前画布知识上下文”当作知识点。
- 每道题的题干、公式或选项中必须体现素材里的具体知识点标题、概述、公式或概念。
- 正确答案必须由素材中的概述、公式或分类直接推出；素材不足或答案不能唯一确定时，宁可不出这一题。
- 解析必须解释为什么，并引用素材中的概述或公式，不能引入素材之外的新结论。
- 解析和选项中不得出现 id、sourceRef、f_xxx、k_xxx 等内部标识；引用公式时写公式名称或公式本身。
- 所有公式必须用 <formula>纯LaTeX</formula> 包裹；题干、选项或解析正文中的内联公式也可以用单个 $ 包裹（如 $\\nabla \\cdot \\vec{F}$），禁止输出裸露的 LaTeX 源码。
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
- 所有公式必须用 <formula>纯LaTeX</formula> 包裹；题干、选项或解析正文中的内联公式也可以用单个 $ 包裹（如 $\\nabla \\cdot \\vec{F}$），禁止输出裸露的 LaTeX 源码。
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

let quizAiRequestId = 0;

let quizAiController = null;

// 出题请求超时：推理类模型生成整份 JSON 题库常超 60s，默认放宽到 3 分钟；
// 可通过 localStorage['phymathia_quiz_timeout_ms'] 自定义（30s~10min）
const QUIZ_AI_TIMEOUT_MS = (() => {
  try {
    const v = parseInt(localStorage.getItem('phymathia_quiz_timeout_ms'), 10);
    if (v >= 30000 && v <= 600000) return v;
  } catch (e) {}
  return 180000;
})();

const QUIZ_REVIEW_INTERVALS_DAYS = [1, 3, 7, 14, 30, 60];

const QUIZ_REVIEW_AFTER_WRONG_MS = 15 * 60 * 1000;

const QUIZ_DAY_MS = 24 * 60 * 60 * 1000;

const QUIZ_BANK_KEY = 'phymathia_quiz_bank';

let quizSourcePreference = 'ai';

let quizBank = null;

// 最近一次 AI 出题失败的友好原因（供提示文案展示），空串=无错误
let quizAiLastError = '';

function _quizFriendlyError(msg) {
  const s = String(msg || '');
  if (/abort/i.test(s)) return '请求超时（' + Math.round(QUIZ_AI_TIMEOUT_MS / 1000) + ' 秒无响应）';
  if (/authentication|api[_ ]?key|401/i.test(s)) return 'API Key 无效或未生效（401）';
  if (/insufficient|balance|402/i.test(s)) return '账户余额不足（402）';
  if (/429|rate[- ]?limit/i.test(s)) return '请求过于频繁（429 限流）';
  if (/HTTP 5\d\d/i.test(s)) return '模型服务端错误';
  return s.slice(0, 120) || '未知错误';
}

// 出题请求的中止守卫：空闲超时（每收到一段数据就续期，流式生成再慢也不会被误杀），
// 另有 10 分钟绝对上限兜底。之前是对整个请求硬掐超时，推理类模型生成整份题库必被误杀。
function _quizAbortGuard(controller) {
  if (!controller) return { bump() {}, dispose() {} };
  const idleMs = QUIZ_AI_TIMEOUT_MS;
  let idle = null, total = null, done = false;
  const fire = (why) => {
    if (done) return;
    done = true;
    quizAiLastError = why;
    try { controller.abort(); } catch (e) {}
  };
  const armIdle = () => { idle = setTimeout(() => fire('请求超时（连续 ' + Math.round(idleMs / 1000) + ' 秒无响应）'), idleMs); };
  armIdle();
  total = setTimeout(() => fire('生成总时长超过 10 分钟，已中止'), 600000);
  return {
    bump() { if (!done) { if (idle) clearTimeout(idle); armIdle(); } },
    dispose() { done = true; if (idle) clearTimeout(idle); if (total) clearTimeout(total); }
  };
}

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
    try { return renderMarkdown(_quizWrapBareLatex(String(text || ''))); } catch (e) {}
  }
  return _quizEscape(text);
}

// 题库文本兜底：把 AI 输出中未包裹的裸 LaTeX 片段包成 $...$，交给 renderMarkdown/KaTeX 渲染
function _quizWrapBareLatex(text) {
  const s = String(text || '');
  if (!s.includes('\\')) return s;
  // 保护已包裹的公式，避免二次包裹
  const blocks = [];
  const protect = function (m) { blocks.push(m); return '\uE000' + (blocks.length - 1) + '\uE001'; };
  let t = s
    .replace(/\$\$[\s\S]+?\$\$/g, protect)
    .replace(/\$[^$\n]+?\$/g, protect)
    .replace(/\\\[[\s\S]+?\\\]/g, protect)
    .replace(/\\\([\s\S]+?\\\)/g, protect)
    .replace(/<formula>[\s\S]*?<\/formula>/gi, protect);
  // 裸片段：以 \ 命令 开头，延续到中文/句读/空白边界。
  // 用捕获组表达「前面不是 \$A-Za-z0-9」而非后行断言：Safari < 16.4 不支持
  // 后行断言，且会在脚本解析期抛 SyntaxError 导致整站不可用
  t = t.replace(/(^|[^\\$A-Za-z0-9])(\\[A-Za-z]+(?:\s*\{[^{}]*\})*(?:\s*(?:\\[A-Za-z]+(?:\s*\{[^{}]*\})*|\{[^{}]*\}|[0-9A-Za-z_=+\-*/^.,;:<>()\[\]]+))*)/g, function (match, pre, frag) {
    if (frag.length > 240) return match;
    // 强公式命令直接判为公式；弱命令（bar/hat/to 等）需要后跟花括号参数，避免误伤路径/英文
    if (!/\\?(?:frac|partial|nabla|cdot|vec|int|sum|sqrt|begin|end|text|mathrm|overline|underline|dfrac|displaystyle|limits|lim|sin|cos|tan|log|ln|exp|infty|pi|theta|lambda|sigma|omega|alpha|beta|gamma|phi|Delta)(?![A-Za-z])/.test(frag)
        && !/\\?(?:bar|hat|dot|ddot|to|rightarrow|leftarrow|in|div|pm|mp|times|leq|geq|neq|approx|left|right|quad|qquad)\s*\{/.test(frag)) return match;
    return pre + (frag.indexOf('\n') >= 0 ? ('$$' + frag + '$$') : ('$' + frag + '$'));
  });
  // 还原保护块
  t = t.replace(/\uE000(\d+)\uE001/g, function (m, idx) { return blocks[parseInt(idx, 10)] || m; });
  return t;
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
  if (/^(当前画布知识上下文|当前会话知识上下文|知识上下文|出题素材)$/.test(s)) return false;
  if (/^(物理直觉|数学本质|物理视角|数学视角|知识图谱|延伸思考|进阶学习方向|学习方向)[：:]/.test(s)) return false;
  return true;
}

function _quizIsMetaPrompt(text) {
  const s = _quizOptionKey(text);
  if (!s) return false;
  return /当前画布知识上下文|当前会话知识上下文|知识上下文|出题素材|多少个汉字|多少汉字|多少个字|有几个汉字|字符数|字符串长度|知识点数量|知识点个数|知识点总数|题干数量|题干个数|标题长度|格式长度/.test(s);
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
  // 归一化到「无空白 + 无定界符 + 无 \text 类包裹」形态：
  // 使 "F = -kx" / "$F=-kx$" / "\text{F}=-kx" 视为同一选项/同一道题，
  // 修复题库去重与错题键无法识别排版变体导致的重复入库
  return String(text || '')
    .toLowerCase()
    .replace(/\\[()\[\]]|\$\$?/g, '')
    .replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|textrm)\{([^{}]*)\}/g, '$1')
    .replace(/\s+/g, '');
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
  // 题干/HTML/正确项全部过 _quizOptionKey：排版等价的题生成相同签名
  return q.type + '|' + _quizOptionKey(q.prompt) + '|' + _quizOptionKey(q.promptHtml || '') + '|' + _quizOptionKey(correct);
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
