/* ====== 知识检测：AI 出题/审题与题库 ====== */

// 题库/错题跳转查看知识点后的返回现场（由 quiz-ui.js 消费）
let quizReturnState = null;

function _pickQuizModel() {
  if (typeof getActiveModelForRole !== 'function') return null;
  return getActiveModelForRole('quiz') || getActiveModelForRole('agent');
}

// 自适应出题：从检测统计里取该素材条目的掌握情况，拼出「｜用户掌握情况：…」标注。
// 匹配键与写入侧同源：题目入库时 topicKey 直接取自素材条目（_sanitizeAIQuestions:
// `matched.topicKey || _quizTopicKey(matched)`，本地题同理），而统计写入 _recordQuizAnswer
// 用的正是这个 topicKey（_quizTopicStatsKey），所以按 `item.topicKey || _quizTopicKey(item)`
// 查表即与写入一致。不按 title 归一兜底：统计键含 sessionId 哈希，标题跨键匹配有跨会话
// 错标风险——宁漏勿错。无统计记录的条目不加任何标注。
function _quizMasteryAnnotation(item, stats) {
  if (!stats || !item) return '';
  try {
    const key = item.topicKey || _quizTopicKey(item);
    const record = key ? stats[key] : null;
    if (!record || typeof record !== 'object') return '';
    const correct = Math.max(0, Number(record.correct) || 0);
    const wrong = Math.max(0, Number(record.wrong) || 0);
    const mastery = typeof record.mastery === 'number' ? record.mastery : _quizMastery(record);
    if (!Number.isFinite(mastery)) return '';
    let detail = '';
    if (correct > 0) detail += `答对 ${correct} 次`;
    if (wrong > 0) detail += (detail ? '，' : '') + `答错 ${wrong} 次`;
    return `｜用户掌握情况：掌握度 ${mastery}%${detail ? '，' + detail : ''}`;
  } catch (e) {
    return ''; // 统计不可用时静默退化为无标注（与画像注入同风格）
  }
}

// ===== 隐式画像出题偏向（docs/用户画像数学模型-2026-10-06.md §3.3/§3.4/§8.2/§8.3）=====
// 数据走现成 GET /api/profile/dashboard（memoryFetchModel，memory.js），纯前端消费：
// 素材按掌握度重排＋提示词追加难度配比一行。门控三关——enabled=false、maturity<0.3、
// 请求/解析失败——一律静默退回无偏向（出题绝不因画像失败而报错或改变行为）。
const QUIZ_IMPLICIT_MIN_MATURITY = 0.3; // 成熟度门控：事件太少时隐式层未成熟，不参与
const QUIZ_IMPLICIT_P_STAR = 0.7;       // §3.3 到期阈值：m̂≤p* 且有作答记录的主题视为薄弱
const QUIZ_IMPLICIT_KAPPA = 0.5;        // §3.3 兴趣指数 κ：π^κ 压平分布，防头部垄断
const QUIZ_IMPLICIT_EPSILON = 0.1;      // §3.3 探索配额 ε：每个主题的保底出场项

function _quizImplicitLabelKey(text) {
  return String(text || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '');
}

// 拉 dashboard 派生视图并按口径门控；任何失败/未达标返回 null（调用方按无画像处理）。
async function _quizImplicitProfile() {
  try {
    if (typeof memoryFetchModel !== 'function') return null;
    const view = await memoryFetchModel();
    if (!view || typeof view !== 'object' || view.enabled === false) return null;
    const maturity = Number(view.maturity);
    if (!Number.isFinite(maturity) || maturity < QUIZ_IMPLICIT_MIN_MATURITY) return null;
    const topics = (Array.isArray(view.topics) ? view.topics : [])
      .filter(t => t && typeof t === 'object')
      .map(t => ({
        name: String(t.topic || '').trim(),
        key: _quizImplicitLabelKey(t.topic),
        m: Number.isFinite(Number(t.m)) ? Number(t.m) : 0.2,
        pi: Number.isFinite(Number(t.share)) ? Number(t.share) : 0,
        ans: Math.max(0, Number(t.ans) || 0)
      }))
      .filter(t => t.name.length >= 2 && t.key.length >= 2);
    return topics.length ? { maturity, topics } : null;
  } catch (e) {
    return null; // 网络失败静默降级：出题照旧
  }
}

// 素材条目 → 画像主题：归一化双向包含（与服务端 assign_topic 的词表包含匹配同风格），
// 多个命中取名字最长者（更具体）。宁漏勿错：任一侧归一后不足 2 字不认。
function _quizImplicitMatchTopic(labelKey, topics) {
  if (!labelKey || labelKey.length < 2 || !Array.isArray(topics)) return null;
  let best = null;
  for (const t of topics) {
    if (labelKey.includes(t.key) || t.key.includes(labelKey)) {
      if (!best || t.key.length > best.key.length) best = t;
    }
  }
  return best;
}

// §3.3 出题优先级 score_i = (1−m̂)·π^κ + ε/‖T‖；画像没见过的条目只吃探索保底项。
// 薄弱前置（boost）：有作答记录且保持率跌破 p*——排最前；从没答过的主题不带 boost，
// 但吃 (1−0.2 先验)·π^κ＋保底，在第二梯队按兴趣保留出场（§8.2 混合分布：不被薄弱
// 主题完全挤掉），且能排到已掌握主题前面。
function _quizImplicitScore(topic, topicCount) {
  const explore = QUIZ_IMPLICIT_EPSILON / Math.max(1, topicCount);
  if (!topic) return { score: explore, boost: false };
  const score = (1 - topic.m) * Math.pow(Math.max(0, topic.pi), QUIZ_IMPLICIT_KAPPA) + explore;
  return { score, boost: topic.ans > 0 && topic.m <= QUIZ_IMPLICIT_P_STAR };
}

// 出题素材排序：薄弱最前（§3.3），其余按 score 降序，同分按原序（稳定）。
// 无画像（implicit 为 null）按原序返回——与无画像行为逐字节一致；不改 pool 本体。
function _quizImplicitOrder(items, implicit, labelOf) {
  const list = Array.isArray(items) ? items.slice() : [];
  if (!implicit || !Array.isArray(implicit.topics) || !implicit.topics.length) return list;
  const topicCount = implicit.topics.length;
  const scored = list.map((item, index) => {
    const topic = _quizImplicitMatchTopic(_quizImplicitLabelKey(labelOf(item)), implicit.topics);
    const s = _quizImplicitScore(topic, topicCount);
    return { item, index, score: s.score, boost: s.boost };
  });
  scored.sort((a, b) => (b.boost - a.boost) || (b.score - a.score) || (a.index - b.index));
  return scored.map(x => x.item);
}

// 难度配比一行（§3.4 目标难度 d*=1+4m̂ 的离散化）：按与素材相关的「已作答」主题平均
// m̂ 分四档给 easy:medium:hard 建议配比；相关主题都没答过题时不给行（无证据不下手）。
function _quizDifficultyRatioHint(implicit, pool) {
  if (!implicit || !Array.isArray(implicit.topics) || !implicit.topics.length) return '';
  const labelKeys = [];
  for (const item of (pool && pool.knowledge) || []) labelKeys.push(_quizImplicitLabelKey(item && item.title));
  for (const item of (pool && pool.formulas) || []) labelKeys.push(_quizImplicitLabelKey(item && item.concept));
  const relevant = implicit.topics.filter(t =>
    t.ans > 0 && labelKeys.some(k => k && k.length >= 2 && (k.includes(t.key) || t.key.includes(k))));
  if (!relevant.length) return '';
  const avgM = relevant.reduce((sum, t) => sum + t.m, 0) / relevant.length;
  const bands = [
    [0.35, '6:3:1', 'easy 为主'],
    [0.55, '3:5:2', 'medium 为主'],
    [0.75, '2:4:4', '中高难度均衡'],
    [Infinity, '1:2:7', 'hard 为主']
  ];
  const band = bands.find(b => avgM < b[0]);
  const level = (1 + 4 * avgM).toFixed(1);
  return `难度配比建议（按画像掌握度）：easy:medium:hard ≈ ${band[1]}`
    + `（相关主题平均掌握度 ${Math.round(avgM * 100)}%，目标难度约 ${level}/5 档，${band[2]}），请按此配比分配各难度的题量`;
}

function _buildQuizGenerationContext(pool, implicit) {
  const lines = ['# 出题素材'];
  // 掌握度统计一次读入；读取失败静默退化为无标注
  let stats = null;
  try {
    stats = _readQuizStats() || null;
  } catch (e) { stats = null; }
  // 隐式画像可用时按 §3.3 重排素材（拷贝排序不动 pool 本体）；无画像保持原序
  const knowledge = _quizImplicitOrder(pool.knowledge, implicit, item => item.title);
  const formulas = _quizImplicitOrder(pool.formulas, implicit, item => item.concept);
  if (knowledge.length) {
    lines.push('## 知识点');
    for (const item of knowledge) {
      lines.push(`- id: ${item.id} | 知识点：${item.title}${_quizMasteryAnnotation(item, stats)}`);
      lines.push(`  概述：${item.summary || '无'}`);
      if (item.formulas.length) lines.push(`  公式：${item.formulas.join('；')}`);
    }
  }
  if (formulas.length) {
    lines.push('## 公式库');
    for (const item of formulas) {
      lines.push(`- id: ${item.id} | ${item.latex}${item.concept ? `（概念：${item.concept}）` : ''}${item.meaning ? `；含义：${item.meaning}` : ''}${_quizMasteryAnnotation(item, stats)}`);
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
    const question = {
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
    };
    // 模型照抄提示词示例的 correctIndex:0，正确答案几乎恒在 A 位——入库/送审前打乱分散
    _quizShuffleQuestionOptions(question);
    result.push(question);
  }
  return result;
}

async function _aiGenerateQuizQuestions(pool, requestId, verify = QUIZ_AI_VERIFY_ENABLED) {
  const model = _pickQuizModel();
  if (!model) return null;
  // 画像注入两路并行：显式（记忆薄弱点）＋隐式（行为画像 dashboard），各自静默降级
  const implicitPromise = _quizImplicitProfile();
  let weakProfileText = '';
  try {
    const profile = await memoryGetProfile();
    if (profile && profile.enabled) {
      const weakParts = [];
      if (String(profile.explicit && profile.explicit.weakAreas || '').trim()) weakParts.push('薄弱章节：' + profile.explicit.weakAreas.trim());
      const weakFacts = (profile.facts || [])
        .filter(f => f.category === 'weakness' && String(f.fact || '').trim())
        .map(f => f.fact);
      if (weakFacts.length) weakParts.push('薄弱点：' + weakFacts.slice(0, 3).join('；'));
      if (weakParts.length) weakProfileText = weakParts.join('；');
    }
  } catch (e) { /* 画像不可用时静默降级 */ }
  const implicit = await implicitPromise;
  const difficultyHint = _quizDifficultyRatioHint(implicit, pool);
  const prompts = await _loadQuizPromptFile();
  const systemPrompt = (prompts.generate || DEFAULT_QUIZ_GENERATION_PROMPT)
    .replace(/\{\{LEVEL_PROMPT\}\}/g, getLevelPrompt())
    .replace(/\{\{QUESTION_COUNT\}\}/g, quizTargetCount);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  // 空闲超时守卫：流式有数据就续期，只有持续无响应才中止（推理模型友好）
  const guard = (typeof _quizAbortGuard === 'function') ? _quizAbortGuard(controller) : null;
  if (controller) quizAiController = controller;
  const context = _buildQuizGenerationContext(pool, implicit);
  quizAiStatusText = 'AI 正在生成检测题…';
  quizAiLastError = '';
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
          { role: 'user', content: `出题素材：\n${context}\n\n${weakProfileText ? '用户薄弱点（请优先出相关题目）：' + weakProfileText + '\n\n' : ''}${difficultyHint ? difficultyHint + '\n\n' : ''}请只基于素材中的具体知识点和公式生成检测题，不要讨论“出题素材”或“知识上下文”本身。\n\n公式格式要求：题干、选项、解析中的公式一律用 <formula>纯LaTeX</formula> 或 $...$ 包裹（如 $\\nabla \\cdot \\vec{F}$），禁止输出不带定界符的裸 LaTeX。` }
        ],
        provider: model.provider,
        api_key: model.apiKey,
        model: model.model,
        base_url: model.baseUrl,
        thinking: model.thinking || '',
        session_bucket: 'phymathia-quiz',
        stream: true
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await _readModelStream(resp, received => {
      if (guard) guard.bump();
      if (quizState) quizState.aiProgress = Math.min(85, 10 + Math.round(received / 1200 * 70));
    });
    const questions = _sanitizeAIQuestions(raw, pool);
    if (questions.length < 2) {
      // 流本身成功但内容不可用：区分「空返回」与「格式解析失败」，避免静默失败无从排查
      quizAiLastError = raw.trim()
        ? '返回内容无法解析为题目（长度 ' + raw.length + '，开头：' + raw.trim().slice(0, 50) + '）'
        : '上游返回了空内容';
    }
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
    // 记录友好原因，供 aiNotice 提示展示（否则用户只能看到泛泛的“请检查 Key”）
    quizAiLastError = quizAiLastError || (e && e.name === 'AbortError' ? '请求超时' : _quizFriendlyError(e && e.message));
    if (e && e.name === 'AbortError') console.warn('AI quiz generation timed out or superseded');
    else console.warn('AI quiz generation failed:', e);
    return null;
  } finally {
    if (guard) guard.dispose();
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
  // T159：签名按画布累积成集合（旧版单一 poolKey 迁移为单成员集合；上限 60，超出淘汰最早的），
  // 换画布出题不再改写掉他画布刚盖的章——否则多画布来回用永远在重出题。
  const stamps = (existing && existing.poolKeys && typeof existing.poolKeys === 'object')
    ? { ...existing.poolKeys }
    : (existing && existing.poolKey ? { [existing.poolKey]: 1 } : {});
  const sig = _quizPoolSignature(pool);
  if (sig) {
    stamps[sig] = 1;
    const stampKeys = Object.keys(stamps);
    for (const k of stampKeys.slice(0, Math.max(0, stampKeys.length - 60))) delete stamps[k];
  }
  _persistQuizBank({
    poolKeys: stamps,
    // merged 是旧题在前、新题在后：保尾 30 保留最新题。
    // 此前 slice(0, 30) 在题库满后会把新生成的题全部静默丢弃（“补充AI题”看似成功实则无效）
    questions: merged.slice(-30),
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

// 会话删除联动：题库与统计/错题不同，此前没有删除钩子——已删会话的题
// 会一直残留在全局题库里。行为对齐 deleteQuizStatsBySession。
function deleteQuizBankBySession(sessionId) {
  if (!sessionId) return;
  const bank = quizBank || _readQuizBank();
  if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) return;
  const sessionIds = _quizSessionIdVariants(sessionId);
  const kept = bank.questions.filter(q => q && !sessionIds.has(q.sessionId || ''));
  if (kept.length === bank.questions.length) return;
  bank.questions = kept;
  bank.updatedAt = Date.now();
  _persistQuizBank(bank);
  if (quizState && quizState.phase === 'bank') renderQuiz();
}
window.deleteQuizBankBySession = deleteQuizBankBySession;

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

// 定位内核：题库/错题/建议复习（M2）三处共用——只认 (refId, isFormula)，
// 由调用方负责从题目/主题解析出引用（见 quiz-relearn.js 的 _quizResolveTopicTarget）。
async function _quizJumpToRef(refId, isFormula) {
  // 上一次定位留下的重学引导先清掉（quizLocateTopic 会在定位成功后重新挂上）
  if (typeof clearQuizRelearnGuide === 'function') clearQuizRelearnGuide();
  if (!refId) {
    _quizShowToast('这道题没有关联知识点');
    return false;
  }
  // 记录返回现场：从题库/错题/结果视图跳转时，保留「返回题库/错题/检测结果」入口
  if (quizState && (quizState.phase === 'bank' || quizState.phase === 'wrong' || quizState.phase === 'result')) {
    quizReturnState = {
      phase: quizState.phase,
      filterSession: quizBankFilterSession || '',
      topic: quizFilterTopic || 'all'
    };
  }
  try {
    if (isFormula) {
      if (typeof window.locateFormulaNode !== 'function') {
        _quizShowToast('跳转功能暂不可用');
        return false;
      }
      const ok = await window.locateFormulaNode(refId);
      if (ok) {
        if (typeof closeQuiz === 'function') closeQuiz();
        if (typeof showQuizReturnPill === 'function') showQuizReturnPill();
      }
      return !!ok;
    }
    if (typeof window.goToKnowledgeNode !== 'function') {
      _quizShowToast('跳转功能暂不可用');
      return false;
    }
    const ok = await window.goToKnowledgeNode(refId);
    if (ok) {
      if (typeof closeQuiz === 'function') closeQuiz();
      if (typeof showQuizReturnPill === 'function') showQuizReturnPill();
    }
    return !!ok;
  } catch (e) {
    console.warn('Quiz source jump failed:', e);
    _quizShowToast('跳转失败，请重试');
    return false;
  }
}

async function jumpQuizToSource(encodedId) {
  const question = _findQuizJumpQuestion(encodedId);
  if (!question) {
    _quizShowToast('找不到这道题的来源');
    return false;
  }
  const refId = question.sourceRef || question.refId || '';
  const isFormula = question.sourceType === 'formula' || !!(question.formulaText || question.latex);
  return _quizJumpToRef(refId, isFormula);
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
    _migrateQuizBankAnswerPositions();
  } catch (e) {
    console.warn('Load quiz bank failed:', e);
  }
}

// 一次性迁移：修复（2026-09）前生成的 AI 题正确答案恒在 A 位，打乱存量题库并打标记；
// 此后新题在 _sanitizeAIQuestions 解析时已就地打乱，不会再进入本函数的有效分支。
function _migrateQuizBankAnswerPositions() {
  const bank = quizBank || _readQuizBank();
  if (!bank || !Array.isArray(bank.questions) || !bank.questions.length) return;
  if (bank.answersShuffled === true) return;
  bank.questions.forEach(_quizShuffleQuestionOptions);
  bank.answersShuffled = true;
  _persistQuizBank(bank);
}

function _bankForPool(pool) {
  const bank = quizBank || _readQuizBank();
  if (!bank || !Array.isArray(bank.questions)) return null;
  // T159 按画布分池：池签名命中「生成过题的画布签名集合」才复用（旧版单一 poolKey 视为单成员集合），
  // 换画布不再互相作废他画布刚出的题；素材池已变化（知识点/公式增删）仍按画布过期强制重出。
  // 命中后只取归属当前会话的题——此前整库混入别画布的题，作答成绩会记到别画布名下。
  const expected = _quizPoolSignature(pool);
  const stamps = (bank.poolKeys && typeof bank.poolKeys === 'object')
    ? bank.poolKeys
    : (bank.poolKey ? { [bank.poolKey]: 1 } : {});
  if (expected && Object.keys(stamps).length && !stamps[expected]) return null;
  let mine = bank.questions;
  if (quizMode === 'session') {
    const ids = _quizCurrentSessionIds();
    if (ids.size) mine = mine.filter(q => q && ids.has(q.sessionId || ''));
  }
  return mine.length >= 2 ? mine : null;
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

// 从审题模型返回文本里容错提取结果 JSON：先试 ```json 围栏，再试首个平衡的
// JSON 对象/数组（字符串内的引号与转义不参与配对，避免被选项里的 LaTeX 花括号截断），
// 也兼容模型直接输出 [{...}] 数组。本地实现而不调用 quiz-ui.js 的 _firstJsonObject，
// 避免对另一文件运行时可用性的隐式依赖。
function _quizExtractReviewsJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);
  for (const candidate of candidates) {
    const objStart = candidate.indexOf('{');
    const arrStart = candidate.indexOf('[');
    let start = -1;
    if (objStart !== -1 && arrStart !== -1) start = Math.min(objStart, arrStart);
    else start = objStart !== -1 ? objStart : arrStart;
    if (start === -1) continue;
    const open = candidate[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch (e) {
            break; // 该候选截取失败，换下一个候选再试
          }
        }
      }
    }
  }
  return null;
}

function _parseQuizReviews(raw) {
  const data = _quizExtractReviewsJson(raw);
  if (!data) return null;
  const list = Array.isArray(data) ? data : (Array.isArray(data.reviews) ? data.reviews : []);
  return list.length ? list : null;
}

async function _aiVerifyQuizQuestions(pool, questions) {
  const model = _pickQuizModel();
  if (!model || !questions || questions.length < 2) return null;
  const prompts = await _loadQuizPromptFile();
  const systemPrompt = (prompts.verify || DEFAULT_QUIZ_VERIFY_PROMPT)
    .replace(/\{\{LEVEL_PROMPT\}\}/g, getLevelPrompt())
    .replace(/\{\{QUESTION_COUNT\}\}/g, quizTargetCount);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const guard = (typeof _quizAbortGuard === 'function') ? _quizAbortGuard(controller) : null;
  if (controller) quizAiController = controller;
  const context = _buildQuizGenerationContext(pool);
  // 盲答校验：payload 不带 correctIndex/explanation（解释会泄露答案），审题模型只能
  // 依据素材独立作答；此时 options 已是打乱后的顺序、correctIndex 已重定位，
  // 前端直接比对 review.answerIndex === q.correctIndex。
  const payload = questions.map(q => ({
    id: q.id || '',
    type: q.type || 'concept',
    title: q.title || '',
    sourceRef: q.sourceRef || q.refId || '',
    difficulty: q.difficulty || 'medium',
    prompt: q.prompt || '',
    formulaText: q.formulaText || '',
    options: (q.options || []).map(option => option.text || ''),
  }));
  try {
    const resp = await fetch('/api/models/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `出题素材：\n${context}\n\n待审核题目（不含正确答案）：\n${JSON.stringify(payload, null, 2)}\n\n题目里没有给出正确答案。请对每道题独立作答并裁定题目质量，按约定输出 reviews JSON。` }
        ],
        provider: model.provider,
        api_key: model.apiKey,
        model: model.model,
        base_url: model.baseUrl,
        thinking: model.thinking || '',
        session_bucket: 'phymathia-quiz',
        stream: true
      })
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const raw = await _readModelStream(resp, received => {
      if (guard) guard.bump();
      if (quizState) quizState.aiProgress = Math.min(98, 90 + Math.round(received / 800 * 8));
    });
    const reviews = _parseQuizReviews(raw);
    if (!reviews) {
      quizAiLastError = raw.trim() ? '校验返回无法解析' : '校验返回了空内容';
      return null;
    }
    const reviewById = new Map();
    for (const review of reviews) {
      if (review && typeof review === 'object' && review.id !== undefined && review.id !== null) {
        reviewById.set(String(review.id), review);
      }
    }
    // 盲答比对：只有审题模型独立作答与 correctIndex 完全一致才保留原题对象
    //（不采信审题模型改写的任何题目内容）；漏答/drop/越界/不一致一律弃题
    const verified = [];
    for (const q of questions) {
      const review = reviewById.get(String(q.id || ''));
      const optionCount = (q.options || []).length;
      const answerIndex = review ? Number(review.answerIndex) : NaN;
      const keep = !!review
        && review.verdict === 'pass'
        && Number.isInteger(answerIndex)
        && answerIndex >= 0
        && answerIndex < optionCount
        && answerIndex === q.correctIndex;
      if (keep) verified.push(q);
    }
    if (verified.length < 2) {
      quizAiLastError = quizAiLastError || '盲答校验通过题目不足（' + verified.length + ' 道通过）';
    }
    return verified.length >= 2 ? verified : null;
  } catch (e) {
    quizAiLastError = quizAiLastError || (e && e.name === 'AbortError' ? '请求超时' : _quizFriendlyError(e && e.message));
    if (e && e.name === 'AbortError') console.warn('AI quiz verification timed out or superseded');
    else console.warn('AI quiz verification failed:', e);
    return null;
  } finally {
    if (guard) guard.dispose();
    if (controller && quizAiController === controller) quizAiController = null;
    _clearQuizProgressTimer();
  }
}

async function _generateQuestions(pool) {
  const requestId = ++quizAiRequestId;
  if (quizAiController) quizAiController.abort();
  // 素材池为空时直接给出可行动的提示，不再把空素材发给模型（否则模型只能返回空题库）
  const emptyPool = !(pool.knowledge || []).length && !(pool.formulas || []).length;
  if (emptyPool && quizSourcePreference !== 'local') {
    quizAiLastError = '当前范围没有可出题的知识点/公式';
    if (quizState) {
      quizState.aiPending = false;
      quizState.aiProgress = 0;
      quizState.sourceMode = 'local';
      quizState.aiNotice = '当前范围（画布检测=仅当前画布）没有可出题的知识点/公式；'
        + '请改用「检测总览」中的「全局出题」，或先在画布对话中生成知识点，再重新出题';
    }
    return [];
  }
  if (quizState && quizSourcePreference !== 'local') {
    quizState.aiPending = true;
    quizState.aiProgress = 0;
    quizState.aiStage = 'generate';
  }
  const ai = emptyPool ? [] : (await _aiGenerateQuizQuestions(pool, requestId) || []);
  // 等待期间被新一代请求取代（useLocalQuiz/重新出题/重开检测）：放弃本次结果。
  // 不再写 quizState——否则迟到的续尾会把用户已开始的答题拽回第 1 题并清空回答记录
  if (requestId !== quizAiRequestId) return null;
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
        : (model ? 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，已自动使用本地题；请检查出题模型/主模型的 API Key 和地址' : '未配置 AI 模型，已使用本地题');
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
            ? 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，当前为仅AI模式，暂无可用题；请检查出题模型/主模型的 API Key 和地址'
            : local.length
              ? 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，已自动使用本地题；请检查出题模型/主模型的 API Key 和地址'
              : 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，且本地题不足；请检查出题模型/主模型的 API Key 和地址';
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
            ? 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，当前为仅AI模式，暂无可用题；请检查出题模型/主模型的 API Key 和地址'
            : local.length
              ? 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，已自动使用本地题；请检查出题模型/主模型的 API Key 和地址'
              : 'AI 出题失败' + (quizAiLastError ? '（' + quizAiLastError + '）' : '') + '，且本地题不足；请检查出题模型/主模型的 API Key 和地址';
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
