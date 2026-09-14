// ===== 检测闭环收口（M2/P0-A）：薄弱主题 → 画布定位 / 同主题重测 / 重学引导 =====
// 立场（计划全局约束）：探索网保持无状态——闭环靠「导航」闭合，不靠「装饰」闭合。
// 本文件只做三件事，全部复用既有链路，不新增出题协议、不新增消息协议、不写状态类图元素：
//   1. 定位到画布：主题 → 该主题最近一道错题的 sourceRef（无则按标题回退匹配知识/公式条目）
//      → 复用 goToKnowledgeNode/locateFormulaNode 定位内核（含返回现场 pill）；
//   2. 同主题重测：把出题素材收缩到该主题条目，走既有「本地题 + AI 题」链路重新组卷；
//   3. 重学引导：定位成功后在同一枚返回 pill 上挂两个建议动作——写下总结节点 / 连接先导概念。
//      「懂了」的表达 = 网上多出的连线和总结，绝不是给节点消标记。

// ===== 重学引导上下文 =====
// { title, nodeId（定位到的节点，可能为空）, noteNodeId（学生已写下的总结节点） }
let _quizRelearnCtx = null;

function _quizRelearnCtxGet() {
  return _quizRelearnCtx;
}

function clearQuizRelearnGuide() {
  _quizRelearnCtx = null;
}

// ===== 主题解析：topicKey → 画布定位目标 =====

// 主题在检测统计里的汇总项（review 优先，weak 兜底）——默认范围与建议复习列表同口径
function _quizTopicSummaryItem(topicKey) {
  if (!topicKey || typeof _quizStatSummary !== 'function') return null;
  let summary = null;
  try {
    summary = _quizStatSummary();
  } catch (e) {
    return null;
  }
  const pools = [summary.review || [], summary.weak || []];
  for (const pool of pools) {
    const hit = pool.find(item => item && item.key === topicKey);
    if (hit) return hit;
  }
  return null;
}

// 该主题最近一次答错的题：错题快照自带 sourceRef/refId（quiz-stats.js 落库），
// 是最贴近学生当前困惑点的画布落点
function _quizTopicWrongQuestion(topicKey) {
  if (!topicKey || typeof _readWrongQuestions !== 'function') return null;
  const list = _readWrongQuestions().filter(item => item && item.topicKey === topicKey);
  if (!list.length) return null;
  return list.slice().sort((a, b) => (Number(b.wrongAt) || 0) - (Number(a.wrongAt) || 0))[0];
}

function _quizNormalizedTitle(text) {
  const raw = String(text || '');
  return typeof _quizOptionKey === 'function' ? _quizOptionKey(raw) : raw.replace(/\s+/g, '').toLowerCase();
}

// 回退路径：错题没有 sourceRef 时，按主题标题匹配当前知识/公式条目取 id
function _quizTopicKnowledgeRef(topicKey) {
  const summary = _quizTopicSummaryItem(topicKey);
  const title = summary ? String(summary.title || '') : '';
  const norm = _quizNormalizedTitle(title);
  if (!norm) return null;
  let contains = null;
  const knowledge = typeof getKnowledgeItems === 'function' ? getKnowledgeItems() : {};
  for (const [id, entry] of Object.entries(knowledge || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const key = _quizNormalizedTitle(entry.title);
    if (!key) continue;
    if (key === norm) return { refId: entry.id || id, isFormula: false, title: entry.title || title };
    if (!contains && (key.includes(norm) || norm.includes(key))) {
      contains = { refId: entry.id || id, isFormula: false, title: entry.title || title };
    }
  }
  if (contains) return contains;
  const formulas = typeof getFormulaCache === 'function' ? getFormulaCache() : {};
  for (const [id, entry] of Object.entries(formulas || {})) {
    if (!entry || typeof entry !== 'object') continue;
    const key = _quizNormalizedTitle(entry.concept);
    if (!key) continue;
    if (key === norm || key.includes(norm) || norm.includes(key)) {
      return { refId: entry.id || id, isFormula: true, title: entry.concept || title };
    }
  }
  return null;
}

function _quizResolveTopicTarget(encodedKey) {
  const topicKey = decodeURIComponent(String(encodedKey || ''));
  if (!topicKey) return null;
  const summary = _quizTopicSummaryItem(topicKey);
  const title = summary ? String(summary.title || '') : '';
  const wrong = _quizTopicWrongQuestion(topicKey);
  if (wrong) {
    const refId = String(wrong.sourceRef || wrong.refId || '');
    if (refId) {
      return {
        refId,
        isFormula: wrong.sourceType === 'formula' || !!(wrong.formulaText || wrong.latex),
        title: wrong.title || title
      };
    }
  }
  return _quizTopicKnowledgeRef(topicKey);
}

// ===== 动作 1：定位到画布（并挂上重学引导） =====

async function quizLocateTopic(encodedKey) {
  const target = _quizResolveTopicTarget(encodedKey);
  if (!target) {
    if (typeof showToast === 'function') showToast('这个主题在当前画布没有可定位的节点');
    return false;
  }
  const ok = await _quizJumpToRef(target.refId, target.isFormula);
  if (!ok) return false;
  showQuizRelearnGuide({
    title: target.title || '这个知识点',
    nodeId: typeof getLastLocatedGraphNodeId === 'function' ? getLastLocatedGraphNodeId() : ''
  });
  return true;
}

// ===== 动作 2：同主题重测（不新增出题协议） =====

// 把出题素材收缩到该主题条目（不改 quizState.pool 本身——「换一组题」仍用全量素材）
// poolArg 仅用于测试与复用：缺省取当前题库素材
function _quizPoolForTopic(topicKey, poolArg) {
  const pool = poolArg || (typeof quizState !== 'undefined' && quizState && quizState.pool) || { knowledge: [], formulas: [] };
  const match = item => (item && (item.topicKey || (typeof _quizTopicKey === 'function' ? _quizTopicKey(item) : ''))) === topicKey;
  return {
    knowledge: (pool.knowledge || []).filter(match),
    formulas: (pool.formulas || []).filter(match)
  };
}

function _quizWrongToQuestion(item, index) {
  return {
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
  };
}

// 组卷：最多 2 道同主题原错题（真正的「重测」）打头，其余由既有链路生成的同类新题补齐；
// 去重按「题签名 + 忽略题型签名的宽松签名」双口径——错题快照与 AI 新题常带不同 type
// （choice / concept / ai），只比 _quizSignature 会漏掉同一道题干重复进卷；
// 按目标题数截断
function _quizComposeTopicQuestions(wrongList, generated, limit) {
  const cap = Number(limit) > 0 ? Number(limit) : 5;
  const questions = [];
  const seen = new Set();
  const _correctOf = q => ((q && q.options && q.options[q.correctIndex]) ? q.options[q.correctIndex].text : '');
  const sigOf = q => (typeof _quizSignature === 'function'
    ? _quizSignature(q)
    : String(q.prompt || '') + '|' + String(_correctOf(q)));
  const looseOf = q => {
    const norm = text => (typeof _quizOptionKey === 'function' ? _quizOptionKey(text) : String(text || ''));
    return norm(q && q.prompt) + '|' + norm(_correctOf(q));
  };
  const push = q => {
    // 选项不足 2 个的脏题不进卷（选择题至少要有两个选项）
    if (!q || !Array.isArray(q.options) || q.options.length < 2) return;
    const sig = sigOf(q);
    const loose = looseOf(q);
    if (seen.has(sig) || seen.has('loose:' + loose) || questions.length >= cap) return;
    seen.add(sig);
    seen.add('loose:' + loose);
    questions.push(q);
  };
  (wrongList || []).slice(0, 2).forEach((item, index) => push(_quizWrongToQuestion(item, index)));
  (generated || []).forEach(q => push(q));
  return questions;
}

async function quizRetestTopic(encodedKey) {
  if (!quizState) return false;
  const topicKey = decodeURIComponent(String(encodedKey || ''));
  if (!topicKey) return false;
  const topicPool = _quizPoolForTopic(topicKey);
  const wrong = typeof _readWrongQuestions === 'function'
    ? _readWrongQuestions().filter(item => item && item.topicKey === topicKey)
    : [];
  const hasMaterial = (topicPool.knowledge || []).length > 0 || (topicPool.formulas || []).length > 0;
  if (!hasMaterial && !wrong.length) {
    if (typeof showToast === 'function') showToast('这个主题在当前画布没有可重测的素材');
    return false;
  }
  quizFilterTopic = topicKey;
  quizState.phase = 'loading';
  if (quizSourcePreference !== 'local') {
    quizState.aiPending = true;
    quizState.aiProgress = 0;
    quizState.aiStage = 'generate';
  }
  renderQuiz();
  _resetQuizPromptFile();
  let generated = [];
  if (hasMaterial && typeof _generateQuestions === 'function') {
    generated = await _generateQuestions(topicPool);
    // null = 等待期间被新请求取代，状态已由新流程接管
    if (generated === null) return false;
    generated = generated || [];
  }
  const questions = _quizComposeTopicQuestions(wrong, generated, quizTargetCount);
  if (!questions.length) {
    if (typeof showToast === 'function') showToast('这个主题暂时出不了题');
    quizState.phase = 'intro';
    renderQuiz();
    return false;
  }
  quizState.questions = questions;
  quizState.phase = 'question';
  quizState.index = 0;
  quizState.answers = [];
  _resetQuizExplain();
  renderQuiz();
  return true;
}

// ===== 动作 3：重学引导（定位成功后挂在返回 pill 上的两个建议动作，点击才创建） =====

function quizRelearnPillHtml() {
  const ctx = _quizRelearnCtx;
  if (!ctx) return '';
  const noteLabel = ctx.noteNodeId ? '✎ 继续写总结' : '✎ 写下总结节点';
  return '<button type="button" class="quiz-return-pill-btn quiz-return-pill-action"'
    + ' onclick="quizRelearnCreateNote()" title="在该节点旁放一个「我的理解」节点，写下你自己的话">' + noteLabel + '</button>'
    + '<button type="button" class="quiz-return-pill-btn quiz-return-pill-action"'
    + ' onclick="quizRelearnConnect()" title="把总结节点（或定位到的节点）设为起点，点一个先导概念完成连线">⇢ 连接先导概念</button>';
}

function showQuizRelearnGuide(ctx) {
  _quizRelearnCtx = {
    title: (ctx && ctx.title) || '这个知识点',
    nodeId: (ctx && ctx.nodeId) || '',
    noteNodeId: (ctx && ctx.noteNodeId) || ''
  };
  if (typeof showQuizReturnPill === 'function') showQuizReturnPill();
}

// 总结节点 = 既有 kind=human_note（「我的理解」，带手写编辑弹窗）。
// 不用 blank：blank 节点体是「写要求 → 点生成」的 AI 生成节点（带「AI 生成」徽标），
// 没有手写路径——「你自己懂了的证据」必须由学生自己敲字，不能让 AI 代笔。
function _quizRelearnNoteLabel(title) {
  return '我的理解：' + (String(title || '').trim() || '这个知识点');
}

function _quizRelearnFindNode(nodeId) {
  if (!nodeId || typeof _findGraphNode !== 'function') return null;
  return _findGraphNode(nodeId) || null;
}

// 落点：定位到的节点旁 +24/+24（复制节点先例）；落点未知（如定位到消息节点）时退回画布默认落点
function _quizRelearnAnchorPoint(nodeId) {
  const node = _quizRelearnFindNode(nodeId);
  if (node && Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))) {
    return { x: Number(node.x) + 24, y: Number(node.y) + 24 };
  }
  if (typeof addBlankNodePoint !== 'undefined' && addBlankNodePoint) {
    return { x: Number(addBlankNodePoint.x) || 0, y: Number(addBlankNodePoint.y) || 0 };
  }
  return { x: 0, y: 0 };
}

// 建节点：createManualNode(kindKey) → 取新增 id → 落标题（可选落内容）。
// createManualNode 不返回节点，用前后 id 差集取新增项（graph-contextmenu「粘贴为节点」同款做法）
function _quizRelearnCreateNodeAt(point, kindKey, patch) {
  if (typeof createManualNode !== 'function') return '';
  if (typeof addBlankNodePoint !== 'undefined' && addBlankNodePoint) {
    addBlankNodePoint.x = point.x;
    addBlankNodePoint.y = point.y;
  }
  const before = new Set(((typeof graphView !== 'undefined' && graphView.nodes) || []).map(node => node.id));
  createManualNode(kindKey);
  const created = (((typeof graphView !== 'undefined' && graphView.nodes) || []).find(node => !before.has(node.id))) || null;
  if (!created) return '';
  if (patch && patch.label) created.label = patch.label;
  if (patch && patch.content != null && typeof updateCustomNodeContent === 'function') {
    updateCustomNodeContent(created.id, patch.content);
  }
  if (typeof renderGraphCanvas === 'function') renderGraphCanvas();
  return created.id;
}

// 打开「编辑我的理解」弹窗（human_note 节点双击同款入口），让学生立刻开始写
function _quizRelearnOpenNoteEditor(nodeId) {
  if (typeof editHumanNoteNode !== 'function') return false;
  try {
    editHumanNoteNode(nodeId);
    return true;
  } catch (e) {
    console.warn('Open human note editor failed:', e);
    return false;
  }
}

function quizRelearnCreateNote() {
  const ctx = _quizRelearnCtx;
  if (!ctx) return;
  const existing = _quizRelearnFindNode(ctx.noteNodeId);
  if (existing) {
    if (typeof focusGraphNodeById === 'function') focusGraphNodeById(ctx.noteNodeId);
    _quizRelearnOpenNoteEditor(ctx.noteNodeId);
    if (typeof showToast === 'function') showToast('接着写你的理解，写完再连一条线到先导概念');
    return;
  }
  const nodeId = _quizRelearnCreateNodeAt(_quizRelearnAnchorPoint(ctx.nodeId), 'human_note', {
    label: _quizRelearnNoteLabel(ctx.title),
    content: ''
  });
  if (!nodeId) {
    if (typeof showToast === 'function') showToast('画布未就绪，暂时无法创建节点');
    return;
  }
  ctx.noteNodeId = nodeId;
  if (typeof showQuizReturnPill === 'function') showQuizReturnPill();
  const opened = _quizRelearnOpenNoteEditor(nodeId);
  if (typeof showToast === 'function') {
    showToast(opened
      ? '已在你定位的节点旁放好「' + _quizRelearnNoteLabel(ctx.title) + '」——写下你自己的话，保存后再连一条线到先导概念'
      : '已在你定位的节点旁放好「我的理解」节点——双击它写下你自己的话，再连一条线到先导概念');
  }
}

function quizRelearnConnect() {
  const ctx = _quizRelearnCtx;
  if (!ctx) return;
  const fromId = _quizRelearnFindNode(ctx.noteNodeId) ? ctx.noteNodeId
    : (_quizRelearnFindNode(ctx.nodeId) ? ctx.nodeId : '');
  // 落点未知/画布未就绪：退回既有联系模式（用户依次点两个节点）
  if (!fromId || typeof graphView === 'undefined' || typeof _applyGraphLinkMode !== 'function') {
    if (typeof toggleGraphLinkMode === 'function') {
      toggleGraphLinkMode();
      if (typeof showToast === 'function') showToast('联系模式已开启：依次点击两个节点即可添加联系箭头');
    }
    return;
  }
  graphView.linkMode = true;
  graphView.linkFirstNodeId = fromId;
  _applyGraphLinkMode();
  if (typeof showToast === 'function') {
    const what = _quizRelearnFindNode(ctx.noteNodeId) ? '你的总结节点' : '「' + ctx.title + '」';
    showToast('已把' + what + '设为起点——点击要连接的先导概念节点完成连线');
  }
}

if (typeof window !== 'undefined') {
  window.quizLocateTopic = quizLocateTopic;
  window.quizRetestTopic = quizRetestTopic;
  window.quizRelearnCreateNote = quizRelearnCreateNote;
  window.quizRelearnConnect = quizRelearnConnect;
  window.showQuizRelearnGuide = showQuizRelearnGuide;
  window.clearQuizRelearnGuide = clearQuizRelearnGuide;
  window.getQuizRelearnCtx = _quizRelearnCtxGet;
}
