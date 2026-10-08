// M2 检测闭环收口（quiz-relearn）；M2 夹具在 _runner.mjs
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 2583–2979 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== M2 检测闭环收口（quiz-relearn.js）：建议复习动作 / 同主题重测 / 重学引导 =====

check('quiz-relearn：建议复习动作接线（两按钮 + 打包注册）静态断言', () => {
  if (!code.includes('/* quiz-relearn.js */')) throw new Error('打包未注册 quiz-relearn.js');
  if (!code.includes('quiz-weak-item-actions')) throw new Error('建议复习条目缺动作容器');
  if (!code.includes("quizLocateTopic('")) throw new Error('缺「定位到画布」按钮接线');
  if (!code.includes("quizRetestTopic('")) throw new Error('缺「重测同类题」按钮接线');
  if (typeof sandbox.quizLocateTopic !== 'function' || typeof sandbox.quizRetestTopic !== 'function') {
    throw new Error('入口未挂 window');
  }
  return true;
});

check('quiz-relearn：主题→定位目标解析（错题 sourceRef 优先，回退按标题匹配知识条目）', () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    kp_hm: { id: 'kp_hm', title: '简谐运动', sessionId: M2_SESSION },
  }));
  // A：主题有错题快照且带 sourceRef → 直接用错题的落点
  m2SeedQuizStats();
  const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
  stats._meta.wrongQuestions = [m2WrongQuestion()];
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  const viaWrong = sandbox._quizResolveTopicTarget(encodeURIComponent(M2_TOPIC_KEY));
  if (!viaWrong || viaWrong.refId !== 'kp_hm' || viaWrong.isFormula !== false) {
    throw new Error('错题 sourceRef 未优先生效: ' + JSON.stringify(viaWrong));
  }
  if (viaWrong.title !== '简谐运动') throw new Error('应带主题标题，实际 ' + viaWrong.title);
  // B：无该主题错题 → 回退按标题匹配知识条目
  m2SeedQuizStats();
  const viaTitle = sandbox._quizResolveTopicTarget(encodeURIComponent(M2_TOPIC_KEY));
  if (!viaTitle || viaTitle.refId !== 'kp_hm') throw new Error('标题回退未命中: ' + JSON.stringify(viaTitle));
  // C：主题在该画布不存在 → null（查空是正常路径）
  if (sandbox._quizResolveTopicTarget(encodeURIComponent('topic-none')) !== null) {
    throw new Error('未知主题应返回 null');
  }
  return true;
});

check('quiz-relearn：同主题重测组卷（素材收缩 + 错题打头 + 去重截断，不动全量 pool）', () => {
  const pool = {
    knowledge: [
      { id: 'kp_hm', title: '简谐运动', topicKey: M2_TOPIC_KEY, summary: 's' },
      { id: 'kp_hk', title: '胡克定律', topicKey: 'topic-HK', summary: 's' },
    ],
    formulas: [{ id: 'f_zq', latex: 'T=2\\pi\\sqrt{m/k}', topicKey: M2_TOPIC_KEY }],
  };
  const scoped = sandbox._quizPoolForTopic(M2_TOPIC_KEY, pool);
  if (scoped.knowledge.length !== 1 || scoped.knowledge[0].id !== 'kp_hm') throw new Error('知识条目未按主题收缩');
  if (scoped.formulas.length !== 1 || scoped.formulas[0].id !== 'f_zq') throw new Error('公式条目未按主题收缩');
  if (pool.knowledge.length !== 2) throw new Error('不得改动传入的全量素材');
  // 组卷：2 道原错题打头，新题补齐到目标题数，同题干同答案去重（题型不同也算同一题）
  const m2Opts = () => [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }];
  const wrong = [
    { id: 'w1', prompt: 'p1', options: m2Opts(), correctIndex: 0 },
    { id: 'w2', prompt: 'p2', options: m2Opts(), correctIndex: 0 },
    { id: 'w3', prompt: 'p3', options: m2Opts(), correctIndex: 0 },
  ];
  const generated = [
    { id: 'g1', type: 'concept', prompt: 'p1', options: m2Opts(), correctIndex: 0 }, // 与 w1 同题干同答案 → 去重
    { id: 'g2', type: 'concept', prompt: 'p2x', options: m2Opts(), correctIndex: 0 },
    { id: 'g3', type: 'concept', prompt: 'p3x', options: m2Opts(), correctIndex: 0 },
    { id: 'g4', type: 'concept', prompt: 'p4x', options: m2Opts(), correctIndex: 0 },
  ];
  const composed = sandbox._quizComposeTopicQuestions(wrong, generated, 4);
  if (composed.length !== 4) throw new Error('应截断到目标题数 4，实际 ' + composed.length);
  if (composed[0].id !== 'w1' || composed[1].id !== 'w2') throw new Error('同主题原错题应打头');
  if (composed.some(q => q.id === 'g1')) throw new Error('同签名新题未去重');
  if (composed.some(q => q.id === 'w3')) throw new Error('原错题最多取 2 道');
  // 无选项的脏题不得进卷
  if (sandbox._quizComposeTopicQuestions([{ id: 'bad', prompt: 'x' }], [], 4).length !== 0) {
    throw new Error('无选项的题应被过滤');
  }
  return true;
});

check('quiz-relearn：重学引导（浮卡两动作 + 我的理解节点 + 落点 + 联系模式预选起点）', () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  // 并发段的 knowledge 用例会把 getElementById 换成哑元素（无 querySelector/appendChild）；
  // 本检查是同步用例，自己钉住一个宽松元素，避免被别人的桩带崩。
  const realGetById = sandbox.document.getElementById;
  sandbox.document.getElementById = () => loose('smokeEl');
  let ctx = null;
  let html = '';
  let near = null;
  let fallback = null;
  let created = [];
  let edited = null;
  try {
    sandbox.showQuizRelearnGuide({ title: '简谐运动', nodeId: 'n1' });
    ctx = sandbox._quizRelearnCtxGet();
    if (!ctx || ctx.title !== '简谐运动' || ctx.nodeId !== 'n1') throw new Error('引导上下文未建立');
    html = sandbox.quizRelearnPillHtml();
    if (!html.includes('quizRelearnCreateNote()') || !html.includes('quizRelearnConnect()')) {
      throw new Error('浮卡缺两个建议动作');
    }
    if (!html.includes('写下总结节点') || !html.includes('连接先导概念')) throw new Error('动作文案缺失');
    if (sandbox._quizRelearnNoteLabel('简谐运动') !== '我的理解：简谐运动') throw new Error('总结节点标题不符');
    // 落点：定位节点旁 +24/+24；节点未知时退回画布默认落点（不抛错）
    const realFind = sandbox._findGraphNode;
    try {
      sandbox._findGraphNode = id => (id === 'n1' ? { id: 'n1', x: 100, y: 200 } : null);
      near = sandbox._quizRelearnAnchorPoint('n1');
      fallback = sandbox._quizRelearnAnchorPoint('');
    } finally {
      sandbox._findGraphNode = realFind;
    }
    if (near.x !== 124 || near.y !== 224) throw new Error('落点应为源节点 +24/+24，实际 ' + JSON.stringify(near));
    if (!Number.isFinite(fallback.x) || !Number.isFinite(fallback.y)) throw new Error('退化落点应仍为有效坐标');
    // 真建节点：必须是 kind=human_note（「我的理解」，有手写弹窗）——blank 是「写要求→AI 生成」
    // 的 AI 节点，没有手写路径，不能用来表达「我自己懂了的证据」
    const store = { customNodes: [], connections: [], positions: {}, collapsed: {}, hidden: {}, groups: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, harnessDeleted: {}, pan: { x: 0, y: 0 }, zoom: 0.9 };
    const realGetState = sandbox.window.getGraphState;
    const realSaveState = sandbox.window.saveGraphState;
    const realGetChat = sandbox.window.getChatHistory;
    const realEdit = sandbox.editHumanNoteNode;
    try {
      sandbox.window.getGraphState = () => store;
      sandbox.window.saveGraphState = (sid, next) => Object.assign(store, next);
      sandbox.window.getChatHistory = () => [];
      sandbox.editHumanNoteNode = (id) => { edited = id; };
      sandbox.quizRelearnCreateNote();
      created = (vm.runInContext('graphView.nodes', sandbox) || []).filter(n => n.kind === 'human_note');
      if (created.length !== 1) throw new Error('应创建 1 个「我的理解」节点，实际 ' + created.length);
      if (created[0].label !== '我的理解：简谐运动') throw new Error('节点标题未带主题：' + created[0].label);
      if (edited !== created[0].id) throw new Error('未打开「编辑我的理解」弹窗');
      if (sandbox._quizRelearnCtxGet().noteNodeId !== created[0].id) throw new Error('引导未记住总结节点');
      if (!sandbox.quizRelearnPillHtml().includes('继续写总结')) throw new Error('浮卡文案未切到续写态');
      // 连接：把总结节点设为既有联系模式起点
      sandbox.quizRelearnConnect();
      if (vm.runInContext('graphView.linkMode', sandbox) !== true) throw new Error('未进入联系模式');
      if (vm.runInContext('graphView.linkFirstNodeId', sandbox) !== created[0].id) throw new Error('未预选总结节点为起点');
      // 再点一次不重复建节点，改为聚焦 + 打开编辑器
      sandbox.quizRelearnCreateNote();
      if ((vm.runInContext('graphView.nodes', sandbox) || []).filter(n => n.kind === 'human_note').length !== 1) {
        throw new Error('重复点击不应再建节点');
      }
      if (edited !== created[0].id) throw new Error('重复点击应重新打开编辑器');
    } finally {
      sandbox.window.getGraphState = realGetState;
      sandbox.window.saveGraphState = realSaveState;
      sandbox.window.getChatHistory = realGetChat;
      sandbox.editHumanNoteNode = realEdit;
    }
    // 落点未知时「连接先导概念」走既有联系模式兜底分支（不崩、不预设起点）
    sandbox.clearQuizRelearnGuide();
    sandbox.showQuizRelearnGuide({ title: '简谐运动', nodeId: '' });
    sandbox.quizRelearnConnect();
    sandbox.clearQuizRelearnGuide();
    if (sandbox.quizRelearnPillHtml() !== '') throw new Error('清空引导后浮卡不应再出动作');
  } finally {
    sandbox.document.getElementById = realGetById;
  }
  return true;
});

check('quiz-ai：AI 题入库前打乱选项（修复正确答案恒在 A 位），correctIndex 始终跟随原正确项', () => {
  const pool = { knowledge: [
    { id: 'k_s1', title: '知识点甲', summary: '概述甲的内容', formulas: [], sessionId: 's1' },
    { id: 'k_s2', title: '知识点乙', summary: '概述乙的内容', formulas: [], sessionId: 's1' },
  ], formulas: [] };
  const seen = new Set();
  // 模型行为：每题正确答案都写在第 1 个选项、correctIndex 恒为 0
  for (let round = 0; round < 30; round++) {
    const raw = JSON.stringify({ questions: [0, 1, 2, 3, 4].map(j => ({
      type: 'concept',
      title: j % 2 ? '知识点甲' : '知识点乙',
      sourceRef: j % 2 ? 'k_s1' : 'k_s2',
      difficulty: 'medium',
      prompt: '第' + round + '轮检测题' + j + '，考查知识点内容',
      options: ['正确表述' + j, '干扰一' + j, '干扰二' + j, '干扰三' + j],
      correctIndex: 0,
      explanation: '解析' + j,
    })) });
    const qs = sandbox._sanitizeAIQuestions(raw, pool);
    if (qs.length !== 5) throw new Error('应解析出 5 题，实际 ' + qs.length);
    for (const q of qs) {
      if (q.correctIndex < 0 || q.correctIndex >= q.options.length) throw new Error('correctIndex 越界');
      if (!q.options[q.correctIndex].text.startsWith('正确表述')) throw new Error('correctIndex 未指向原正确项');
      if (q.options.map(o => o.key).join('') !== 'ABCD') throw new Error('选项键未按 A-D 重排');
      seen.add(q.correctIndex);
    }
  }
  if (seen.size < 2) throw new Error('30 轮×5 题的正确答案位置仍全在同一处，打乱未生效');
  return true;
});

check('quiz：快照迁移 _quizShuffleQuestionOptions（correctIndex 与用户所选下标同步重映射）', () => {
  for (let i = 0; i < 20; i++) {
    const q = {
      prompt: '快照题',
      options: [
        { key: 'A', text: '正确答案' }, { key: 'B', text: '干扰一' },
        { key: 'C', text: '干扰二' }, { key: 'D', text: '干扰三' },
      ],
      correctIndex: 0,
      selectedIndex: 2,
    };
    const pickedBefore = q.options[q.selectedIndex].text;
    const correctBefore = q.options[q.correctIndex].text;
    const setBefore = q.options.map(o => o.text).sort().join('|');
    sandbox._quizShuffleQuestionOptions(q);
    if (q.options.map(o => o.text).sort().join('|') !== setBefore) throw new Error('选项集合被改变');
    if (q.options[q.correctIndex].text !== correctBefore) throw new Error('correctIndex 未跟随正确项');
    if (q.options[q.selectedIndex].text !== pickedBefore) throw new Error('selectedIndex 未跟随原所选');
    if (q.options.map(o => o.key).join('') !== 'ABCD') throw new Error('选项键未重排');
  }
  // 坏数据原样返回，不抛错
  if (sandbox._quizShuffleQuestionOptions(null) !== null) throw new Error('null 应原样返回');
  const single = { options: [{ key: 'A', text: 'x' }], correctIndex: 0 };
  sandbox._quizShuffleQuestionOptions(single);
  if (single.correctIndex !== 0) throw new Error('单选项应原样保留');
  return true;
});

check('quiz：题库存量迁移（老题全 A 打乱 + answersShuffled 标记后不再重复打乱）', () => {
  const mkBank = () => ({ poolKey: 'x', updatedAt: 1, questions: [] });
  const bank = mkBank();
  for (let i = 0; i < 10; i++) {
    bank.questions.push({
      id: 'ai_old_' + i,
      options: [
        { key: 'A', text: '对' + i }, { key: 'B', text: '错甲' + i },
        { key: 'C', text: '错乙' + i }, { key: 'D', text: '错丙' + i },
      ],
      correctIndex: 0,
    });
  }
  sandbox.localStorage.setItem('phymathia_quiz_bank', JSON.stringify(bank));
  sandbox.quizBank = null;
  try {
    sandbox._migrateQuizBankAnswerPositions();
    const migrated = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_bank'));
    if (migrated.answersShuffled !== true) throw new Error('缺 answersShuffled 标记');
    // 10 题全部原地不动的概率 4^-10 ≈ 10^-6，视作打乱未生效
    if (!migrated.questions.some(q => q.correctIndex !== 0)) throw new Error('存量题正确答案未被分散');
    for (const q of migrated.questions) {
      if (!q.options[q.correctIndex].text.startsWith('对')) throw new Error('correctIndex 未跟随原正确项');
    }
    // 标记已打：再调用不得再打乱（选项顺序保持原样）
    const before = JSON.stringify(migrated.questions.map(q => q.options.map(o => o.text)));
    sandbox.quizBank = migrated;
    sandbox._migrateQuizBankAnswerPositions();
    const after = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_bank'));
    if (JSON.stringify(after.questions.map(q => q.options.map(o => o.text))) !== before) {
      throw new Error('answersShuffled 后再次调用不应再打乱');
    }
  } finally {
    // 清理污染（共享键）
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    sandbox.quizBank = null;
  }
  return true;
});

check('quiz：题库按画布分池（T159）——签名集合命中才复用、只取本画布的题、落库累积签名', () => {
  const poolA = { knowledge: [{ title: '单摆周期' }], formulas: [] };
  const poolB = { knowledge: [{ title: '梯度定义' }], formulas: [] };
  const poolC = { knowledge: [{ title: '泊松分布' }], formulas: [] };
  const sigA = sandbox._quizPoolSignature(poolA);
  const sigB = sandbox._quizPoolSignature(poolB);
  const q = (sid, n) => ({
    id: 'ai_test_' + n, type: 'choice', prompt: '题干' + sid + n, promptHtml: '',
    sessionId: sid, title: 't', difficulty: 'medium',
    options: [{ key: 'A', text: '对' + n }, { key: 'B', text: '错' + n }], correctIndex: 0
  });
  const prevMode = vm.runInContext('quizMode', sandbox);
  const prevGetSid = sandbox.window.getCurrentSessionId;
  // quizBank/quizMode 是 quiz.js 的词法绑定，沙箱外不可达——经 vm.runInContext 原地改（同 graphView 先例）
  const setBank = bank => vm.runInContext('quizBank = ' + JSON.stringify(bank) + ';', sandbox);
  try {
    vm.runInContext("quizMode = 'session';", sandbox);
    sandbox.window.getCurrentSessionId = () => 'sess_A';
    // 旧版形态（单一 poolKey）按「单成员签名集合」兼容：本画布命中即复用，且只取本会话的题
    setBank({ poolKey: sigA, questions: [q('sess_A', 1), q('sess_A', 2), q('sess_B', 1), q('sess_B', 2)] });
    let mine = sandbox._bankForPool(poolA);
    if (!Array.isArray(mine) || mine.length !== 2 || mine.some(x => x.sessionId !== 'sess_A')) {
      throw new Error('旧版单签名应复用本画布 2 题，实际 ' + (mine && mine.length));
    }
    // 未盖过章的画布 → 过期重出（素材变化防脱节的旧规则保留）
    if (sandbox._bankForPool(poolC) !== null) throw new Error('未生成过题的画布应判过期');
    // 新版形态：两个画布的章各管各的；本画布在库中不足 2 题也重出（不再拿别画布的题凑数）
    setBank({ poolKeys: { [sigA]: 1, [sigB]: 1 }, questions: [q('sess_A', 1), q('sess_A', 2), q('sess_B', 3)] });
    sandbox.window.getCurrentSessionId = () => 'sess_B';
    if (sandbox._bankForPool(poolB) !== null) throw new Error('本画布题数不足 2 应重出而不是拿别画布的题凑');
    setBank({ poolKeys: { [sigA]: 1, [sigB]: 1 }, questions: [q('sess_B', 3), q('sess_B', 4)] });
    mine = sandbox._bankForPool(poolB);
    if (!Array.isArray(mine) || mine.length !== 2) throw new Error('集合命中应复用本画布 2 题');
    // 落库：签名累积而不是覆盖（换画布出题不再作废他画布刚盖的章）
    sandbox.window.getCurrentSessionId = () => 'sess_A';
    setBank(null);
    sandbox.localStorage.setItem('phymathia_quiz_bank', JSON.stringify({ poolKeys: { [sigA]: 1 }, questions: [q('sess_A', 1), q('sess_A', 2)], updatedAt: 1 }));
    sandbox._saveQuizBank(poolB, [q('sess_B', 3), q('sess_B', 4)]);
    const saved = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_bank'));
    if (!saved.poolKeys || !saved.poolKeys[sigA] || !saved.poolKeys[sigB]) throw new Error('落库应累积两画布签名');
    if (saved.poolKey !== undefined) throw new Error('新版落库不应再写单一 poolKey');
    if (!saved.questions.some(x => x.id === 'ai_test_3') || !saved.questions.some(x => x.id === 'ai_test_1')) throw new Error('落库应合并新旧题');
  } finally {
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    vm.runInContext('quizBank = null;', sandbox);
    vm.runInContext('quizMode = ' + JSON.stringify(prevMode) + ';', sandbox);
    sandbox.window.getCurrentSessionId = prevGetSid;
  }
  return true;
});

check('harness：quiz_weak 快照注入（当前会话 Top3，空则不注入）', () => {
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.window.getGraphViewNodes = () => [{ id: 'A', kind: 'knowledge', label: '简谐运动', content: '往复运动' }];
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.window.getSelectedGraphNodeIds = () => [];
  m2SeedQuizStats();
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  if (!Array.isArray(snap.quiz_weak)) throw new Error('quiz_weak 未注入');
  if (snap.quiz_weak.length !== 2) throw new Error('应注入当前会话 2 条薄弱点，实际 ' + snap.quiz_weak.length);
  for (const key of ['title', 'wrong', 'mastery', 'sessionId']) {
    if (!(key in snap.quiz_weak[0])) throw new Error('薄弱点字段缺 ' + key);
  }
  // Top3 截断
  const many = { _meta: { version: 2, wrongQuestions: [] } };
  for (let i = 0; i < 5; i++) {
    many['k' + i] = { title: '薄弱' + i, correct: 0, wrong: 2, topicKey: 'topic-' + i, sessionId: M2_SESSION, dueAt: 1 };
  }
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(many));
  const capped = sandbox.buildHarnessSnapshot(false, [], null);
  if (capped.quiz_weak.length !== 3) throw new Error('应截断到 Top3，实际 ' + capped.quiz_weak.length);
  // 无薄弱点 → 不带该字段（避免空数组噪声）
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify({ _meta: { version: 2, wrongQuestions: [] } }));
  const clean = sandbox.buildHarnessSnapshot(false, [], null);
  if ('quiz_weak' in clean) throw new Error('无薄弱点时应省略 quiz_weak');
  // 清理污染
  sandbox.localStorage.removeItem('phymathia_quiz_stats');
  sandbox.localStorage.removeItem('phymathia_knowledge');
  sandbox.invalidateKnowledgeCache();
  return true;
});

check('harness：澄清重跑委托主路径 / 零勾选不回退应用全部 / 差评备注不用 window.prompt', () => {
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const psrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  const asrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  // 澄清重跑必须委托 runGraphHarness：旧手抄版引用未定义 pureQuestion（点选即崩），
  // 且缺 token 预检/停止按钮/Φ 模型槽位/流式预览——不许再长出独立 fetch 旁路
  if (rsrc.indexOf('function runGraphHarnessWithFocus(phase, focusIds, instruction)') < 0) {
    throw new Error('WithFocus 签名变了，检查委托逻辑是否还在');
  }
  const wfStart = rsrc.indexOf('function runGraphHarnessWithFocus');
  const wfBody = rsrc.slice(wfStart, rsrc.indexOf('\n  }', wfStart));
  if (!wfBody.includes("runGraphHarness(phase || 'normal', { focusIds")) {
    throw new Error('澄清重跑未委托主路径 runGraphHarness');
  }
  if (wfBody.includes('fetch(')) throw new Error('WithFocus 残留独立 fetch，会漂移出无停止按钮的旁路');
  if (!rsrc.includes('presetFocusIds')) throw new Error('主路径缺预设焦点入口（澄清点选传不进焦点）');
  // 失败回填：主路径错误出口必须回填输入框
  const restoreCount = (rsrc.match(/restoreInstruction\(\)/g) || []).length;
  if (restoreCount < 5) throw new Error('失败回填覆盖不足（应有 ≥5 处错误出口），实际 ' + restoreCount);
  // 零勾选＝什么都不选，不得回退成应用全部
  if (psrc.includes('return selected.length ? selected : ops')) throw new Error('_selectedOps 仍回退全量应用');
  if (!asrc.includes('没有勾选任何操作')) throw new Error('零勾选时缺用户提示');
  // 差评备注：内联表单，禁止 window.prompt
  if (hsrc.includes("window.prompt('Φ")) throw new Error('差评备注仍在用 window.prompt');
  if (!hsrc.includes('_showHarnessFeedbackForm')) throw new Error('差评备注内联表单缺失');
  return true;
});
}
