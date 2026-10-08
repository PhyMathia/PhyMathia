// 串行边界：重测同类题/定位到画布全链路（用 _runner 的 M2 夹具）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 5058–5157 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 串行边界：以下用例改共享状态（localStorage 知识/统计键）且会 await，
// 必须放在全部并发检查之后——否则会与在途的 knowledge/quiz 异步用例互相踩键 =====

check('quiz-relearn：quizRetestTopic 全链路（真实检测态按主题组卷，不改全量素材池）', async () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  // 顶层 let（quizSourcePreference/quizState）不是沙箱全局属性，用同 context 的词法读/写访问
  const prevPref = vm.runInContext('quizSourcePreference', sandbox);
  vm.runInContext('quizSourcePreference = "local"', sandbox); // 只走本地出题，不触发 AI 链路
  try {
    await sandbox.openQuiz('session'); // 真实建立 quizState（沙箱 fetch 返回空数据）
    m2SeedQuizStats();
    const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
    stats._meta.wrongQuestions = [m2WrongQuestion()];
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
    const ok = await sandbox.quizRetestTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('重测应返回 true');
    const phase = vm.runInContext('quizState && quizState.phase', sandbox);
    const qlen = vm.runInContext('quizState && quizState.questions ? quizState.questions.length : -1', sandbox);
    const filter = vm.runInContext('typeof quizFilterTopic === "string" ? quizFilterTopic : ""', sandbox);
    const poolLen = vm.runInContext('quizState && quizState.pool ? quizState.pool.knowledge.length : -1', sandbox);
    if (phase !== 'question') throw new Error('应进入答题相位，实际 ' + phase);
    if (qlen < 1) throw new Error('同主题原错题应进卷，实际 ' + qlen);
    if (filter !== M2_TOPIC_KEY) throw new Error('主题过滤未生效：' + filter);
    if (poolLen !== 0) throw new Error('不得改动全量素材池，实际 ' + poolLen);
    // 无素材又无错题的主题：优雅返回 false（不抛错、不改相位）
    const miss = await sandbox.quizRetestTopic(encodeURIComponent('topic-none'));
    if (miss !== false) throw new Error('无素材主题应返回 false');
    const phaseAfter = vm.runInContext('quizState && quizState.phase', sandbox);
    if (phaseAfter !== 'question') throw new Error('查空路径不应改相位，实际 ' + phaseAfter);
  } finally {
    vm.runInContext(`quizSourcePreference = ${JSON.stringify(prevPref)}`, sandbox);
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
  }
  return true;
});

check('quiz-relearn：quizLocateTopic 全链路（主题解析 → 定位内核 → 重学引导带落点）', async () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    kp_hm: { id: 'kp_hm', title: '简谐运动', sessionId: M2_SESSION },
  }));
  m2SeedQuizStats();
  const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
  stats._meta.wrongQuestions = [m2WrongQuestion()];
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  const realGoTo = sandbox.window.goToKnowledgeNode;
  const realLocate = sandbox.window.locateFormulaNode;
  const realGetLast = sandbox.window.getLastLocatedGraphNodeId;
  const calls = [];
  try {
    sandbox.window.goToKnowledgeNode = async (refId) => {
      calls.push({ kind: 'knowledge', refId });
      sandbox._rememberLocatedGraphNode('node_kp_hm'); // 模拟定位内核回填落点
      return true;
    };
    sandbox.window.locateFormulaNode = async (refId) => {
      calls.push({ kind: 'formula', refId });
      return true;
    };
    const ok = await sandbox.quizLocateTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('定位应成功');
    if (!calls.length || calls[0].kind !== 'knowledge' || calls[0].refId !== 'kp_hm') {
      throw new Error('应按错题 sourceRef 走知识点定位，实际 ' + JSON.stringify(calls));
    }
    const ctx = sandbox._quizRelearnCtxGet();
    if (!ctx || ctx.title !== '简谐运动' || ctx.nodeId !== 'node_kp_hm') {
      throw new Error('引导上下文未带标题/落点: ' + JSON.stringify(ctx));
    }
    if (sandbox.window.getLastLocatedGraphNodeId() !== 'node_kp_hm') throw new Error('落点回填未生效');
    if (!sandbox.quizRelearnPillHtml().includes('quizRelearnCreateNote()')) throw new Error('pill 缺引导动作');
    // 公式类主题走公式定位分支
    const fStats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
    fStats._meta.wrongQuestions = [Object.assign(m2WrongQuestion(), {
      id: 'w_f', sourceRef: 'f_zq', sourceType: 'formula', formulaText: 'T=2\\pi\\sqrt{m/k}', topicKey: 'topic-F',
    })];
    fStats.k_f = { title: '弹簧振子周期', correct: 0, wrong: 2, topicKey: 'topic-F', sessionId: M2_SESSION, dueAt: 1 };
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(fStats));
    const okF = await sandbox.quizLocateTopic(encodeURIComponent('topic-F'));
    if (okF !== true) throw new Error('公式主题定位应成功');
    if (!calls.some(c => c.kind === 'formula' && c.refId === 'f_zq')) {
      throw new Error('公式主题应走 locateFormulaNode，实际 ' + JSON.stringify(calls));
    }
    // 未知主题：静默失败，不跳转
    const before = calls.length;
    const miss = await sandbox.quizLocateTopic(encodeURIComponent('topic-none'));
    if (miss !== false || calls.length !== before) throw new Error('未知主题不应触发跳转');
  } finally {
    sandbox.window.goToKnowledgeNode = realGoTo;
    sandbox.window.locateFormulaNode = realLocate;
    if (realGetLast) sandbox.window.getLastLocatedGraphNodeId = realGetLast;
    sandbox.clearQuizRelearnGuide();
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
    sandbox.localStorage.removeItem('phymathia_knowledge');
    sandbox.invalidateKnowledgeCache();
  }
  return true;
});
}
