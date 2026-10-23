// 串行边界：重测同类题/定位到画布全链路（用 _runner 的 M2 夹具）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 5058–5157 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 串行边界：以下用例改共享状态（localStorage 知识/统计键）且会 await，
// 必须放在全部并发检查之后——否则会与在飞的 knowledge/quiz 异步用例互相踩键 =====

// 本文件内的 async 用例彼此也共享 quizState/全局 fetch（2026-10-13 循环出题全链路用例
// 实踩：覆写 fetch 时撞上 quizRetestTopic 在途的 openQuiz），三条一律链式严格串行
let prevDone = Promise.resolve();
const seqCheck = (name, fn) => {
  const mine = (async () => { await prevDone; return await fn(); })();
  prevDone = mine.catch(() => {});
  check(name, () => mine);
};

seqCheck('quiz-relearn：quizRetestTopic 全链路（真实检测态按主题组卷，不改全量素材池）', async () => {
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

seqCheck('quiz-relearn：quizLocateTopic 全链路（主题解析 → 定位内核 → 重学引导带落点）', async () => {
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
      calls.push({ kind: 'locate', refId });
      sandbox._rememberLocatedGraphNode('node_kp_hm'); // 模拟定位内核回填落点
      return true;
    };
    sandbox.window.locateFormulaNode = async (refId) => {
      calls.push({ kind: 'formula', refId });
      return true;
    };
    const ok = await sandbox.quizLocateTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('定位应成功');
    if (!calls.length || calls[0].kind !== 'locate' || calls[0].refId !== 'kp_hm') {
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

// ===== 全局检测·多选画布循环出题全链路（2026-10-13）=====
// 覆写全局 fetch 与 getAllSessions、勾选画布、openQuiz('global-loop') 真跑整链，
// 只走本地出题（quizSourcePreference='local'）不触发 AI 请求。
seqCheck('quiz-loop：多选画布循环出题全链路（勾选→global-loop 重建→逐画布组卷不截断→startQuiz 豁免）', async () => {
  const realFetch = sandbox.fetch;
  const realGetAll = sandbox.window.getAllSessions;
  const realGetCurrent = sandbox.window.getCurrentSessionId;
  const prevPref = vm.runInContext('quizSourcePreference', sandbox);
  const prevMode = vm.runInContext('quizMode', sandbox);
  const prevScope = vm.runInContext('quizScope', sandbox);
  vm.runInContext('quizSourcePreference = "local"', sandbox);
  sandbox.window.getCurrentSessionId = () => 'sX';
  sandbox.window.getAllSessions = () => [
    { id: 'sA', title: '力学画布' },
    { id: 'sB', title: '电磁画布' },
    { id: 'sC', title: '空画布' },
  ];
  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/knowledge')) {
      return {
        ok: true, status: 200,
        json: async () => ({ items: {
          kA1: { id: 'kA1', title: '牛顿第一定律', summary: '惯性定律', sessionId: 'sA' },
          kA2: { id: 'kA2', title: '牛顿第二定律', summary: 'F=ma', sessionId: 'sA' },
          kA3: { id: 'kA3', title: '牛顿第三定律', summary: '作用与反作用', sessionId: 'sA' },
          kB1: { id: 'kB1', title: '库仑定律', summary: '点电荷相互作用', sessionId: 'sB' },
          kB2: { id: 'kB2', title: '安培力', summary: '左手定则', sessionId: 'sB' },
          kB3: { id: 'kB3', title: '楞次定律', summary: '阻碍磁通变化', sessionId: 'sB' },
        } }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
  };
  try {
    sandbox.toggleQuizLoopSession('sA');
    sandbox.toggleQuizLoopSession('sB');
    sandbox.toggleQuizLoopSession('sC'); // 空画布也勾上：应被跳过且不出题
    await sandbox.openQuiz('global-loop');
    if (vm.runInContext('quizScope', sandbox) !== 'select') throw new Error('quizScope 应为 select');
    if (vm.runInContext('quizMode', sandbox) !== 'global') throw new Error('quizMode 应为 global');
    const phase = vm.runInContext('quizState && quizState.phase', sandbox);
    if (phase !== 'intro') throw new Error('应停在 intro，实际 ' + phase);
    const target = vm.runInContext('quizTargetCount', sandbox);
    const sessionIds = vm.runInContext('quizState.questions.map(q => q.sessionId)', sandbox);
    const fromA = sessionIds.filter(s => s === 'sA').length;
    const fromB = sessionIds.filter(s => s === 'sB').length;
    const fromC = sessionIds.filter(s => s === 'sC').length;
    if (fromC !== 0) throw new Error('无素材画布不应出题');
    if (fromA === 0 || fromB === 0) throw new Error('两张有素材画布应各贡献题目：' + JSON.stringify({ fromA, fromB }));
    if (fromA > target || fromB > target) throw new Error('单画布题量不得超过每画布题量 ' + target);
    if (sessionIds.length <= target) throw new Error('循环拼卷总量应超过单池题量 ' + target + '，实际 ' + sessionIds.length);
    // startQuiz 豁免单池截断：开始检测后卷面仍是逐画布拼接的全量
    sandbox.startQuiz();
    const after = vm.runInContext('quizState.questions.length', sandbox);
    if (after !== sessionIds.length) throw new Error('startQuiz 不应截断循环卷面：' + after + ' vs ' + sessionIds.length);
    if (vm.runInContext('quizState.phase', sandbox) !== 'question') throw new Error('应进入答题相位');
  } finally {
    sandbox.fetch = realFetch;
    if (realGetAll) sandbox.window.getAllSessions = realGetAll; else delete sandbox.window.getAllSessions;
    if (realGetCurrent) sandbox.window.getCurrentSessionId = realGetCurrent; else delete sandbox.window.getCurrentSessionId;
    vm.runInContext(`quizSourcePreference = ${JSON.stringify(prevPref)}; quizMode = ${JSON.stringify(prevMode)}; quizScope = ${JSON.stringify(prevScope)}; quizSelectedSessions.clear(); quizLoopPanelOpen = false`, sandbox);
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
  }
  return true;
});

// ===== 全局入口「先选范围再出题」（2026-10-13 用户拍板）=====
// 全局出题（未多选）题库未命中时不得自动调模型；CTA 显式触发；画布检测保持打开即出题。
seqCheck('quiz-loop：全局入口先选范围再出题（不自动生成＋CTA 显式触发＋画布检测不受影响）', async () => {
  const realFetch = sandbox.fetch;
  const realPick = sandbox._pickQuizModel;
  const prevPref = vm.runInContext('quizSourcePreference', sandbox);
  vm.runInContext('quizSourcePreference = "ai"', sandbox);
  // 无出题模型：生成链只落「未配置 AI 模型」notice，不发真请求——notice 有无即「是否触发了生成」的判据
  sandbox._pickQuizModel = () => null;
  sandbox.localStorage.removeItem('phymathia_quiz_bank');
  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/knowledge')) {
      return { ok: true, status: 200, json: async () => ({ items: {
        kA1: { id: 'kA1', title: '牛顿第一定律', summary: '惯性定律', sessionId: 'sA' },
        kA2: { id: 'kA2', title: '牛顿第二定律', summary: 'F=ma', sessionId: 'sA' },
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
  };
  try {
    await sandbox.openQuiz('global');
    if (vm.runInContext('quizState.phase', sandbox) !== 'intro') throw new Error('应停在 intro');
    if (vm.runInContext('quizState.aiPending', sandbox)) throw new Error('全局入口不应自动进入生成中');
    if (vm.runInContext('quizState.aiNotice', sandbox)) {
      throw new Error('未自动出题却落了生成侧提示：' + vm.runInContext('quizState.aiNotice', sandbox));
    }
    if (vm.runInContext('quizState.questions.length', sandbox) !== 0) throw new Error('不应预置题目');
    if (!vm.runInContext('quizLoopPanelOpen', sandbox)) throw new Error('选择面板应默认展开');
    if (typeof sandbox.startGlobalQuizGeneration !== 'function') throw new Error('CTA 未暴露');
    // CTA 点击触发出题链：无模型分支的 notice 在微任务里落，冲一遍微任务队列再读
    sandbox.startGlobalQuizGeneration();
    await new Promise(r => setImmediate(r));
    if (!vm.runInContext('quizState.aiNotice', sandbox)) throw new Error('CTA 点击应触发出题链');
    // 画布检测保持打开即出题（同一 else 分支，auto 不得误伤 session）
    await sandbox.openQuiz('session');
    await new Promise(r => setImmediate(r));
    if (!vm.runInContext('quizState.aiNotice', sandbox)) throw new Error('画布检测应保持打开即出题');
  } finally {
    sandbox.fetch = realFetch;
    sandbox._pickQuizModel = realPick;
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    vm.runInContext(`quizSourcePreference = ${JSON.stringify(prevPref)}; quizSelectedSessions.clear(); quizLoopPanelOpen = false`, sandbox);
  }
  return true;
});


// T308（2026-10-13，用户报「实际出的题似乎并没有进入题库」）：旧版题库是全局硬上限 30 题，
// 多选画布循环一轮＝画布数×每画布题量（用户真机 21 张画布＝105 题），一出题就把先出题画布的题静默挤掉
// ——真机实测库里只剩 30 题、只覆盖最后 6 张画布。本用例钉新口径：按画布各留最新 N 题 + 超量时公平淘汰。
seqCheck('quiz-bank：多选循环一轮不再被全局 30 题上限挤掉（按画布保留＋公平淘汰＋落盘瘦身）', () => {
  const prevBank = vm.runInContext('quizBank', sandbox);
  const mkQ = (sid, i) => ({
    id: 'ai_' + sid + '_' + i, type: 'concept', title: 'T', prompt: 'p' + sid + i,
    options: [
      { key: 'A', text: 'a', html: '<span class="katex">A</span>' },
      { key: 'B', text: 'b', html: '' }, { key: 'C', text: 'c', html: '' }, { key: 'D', text: 'd', html: '' },
    ],
    correctIndex: 0, difficulty: 'medium', explanation: 'e', sessionId: sid,
  });
  const save = (sid, qs) => sandbox._saveQuizBank({ knowledge: [{ id: 'k_' + sid, sessionId: sid }], formulas: [] }, qs);
  const readBank = () => JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_bank'));
  const perSession = (bank) => {
    const per = new Map();
    for (const q of bank.questions) per.set(q.sessionId, (per.get(q.sessionId) || 0) + 1);
    return per;
  };
  sandbox.localStorage.removeItem('phymathia_quiz_bank');
  try {
    // ① 21 张画布各出 5 题（＝真机规模）：105 题全留，首张画布不再被挤空
    const live = [];
    for (let c = 0; c < 21; c++) {
      const sid = 'sessB' + c;
      const qs = Array.from({ length: 5 }, (_, i) => mkQ(sid, i));
      if (c === 0) live.push(...qs);
      save(sid, qs);
    }
    let bank = readBank();
    if (bank.questions.length !== 105) throw new Error('21 画布×5 题应全留 105 题，实际 ' + bank.questions.length);
    const per = perSession(bank);
    if (per.size !== 21) throw new Error('应覆盖 21 张画布，实际 ' + per.size);
    if (per.get('sessB0') !== 5) throw new Error('先出题的画布被挤掉了：sessB0=' + per.get('sessB0'));
    // ② 落盘瘦身：option.html 是预渲染 KaTeX（占单题体积约八成），入库必须丢；
    //    本次会话刚生成的题（原对象）不受影响，答题界面渲染逐字节不变
    if (bank.questions[0].options[0].html) throw new Error('落盘未瘦身：option.html 仍在');
    if (!live[0].options[0].html) throw new Error('瘦身误伤了本次会话的原对象');
    // ③ 单画布反复出题：只留最新 10 题（同画布内先出先淘汰）
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    vm.runInContext('quizBank = null', sandbox);
    for (let r = 0; r < 5; r++) save('solo', Array.from({ length: 5 }, (_, i) => mkQ('solo', r * 5 + i)));
    bank = readBank();
    if (bank.questions.length !== 10) throw new Error('单画布应只留最新 10 题，实际 ' + bank.questions.length);
    if (!String(bank.questions[9].id).endsWith('_24')) throw new Error('应保留最新一批，实际末题 ' + bank.questions[9].id);
    // ④ 公平淘汰：40 画布×5＝200 题超全库上限时，每张画布按比例留题、不许有画布被清零
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    vm.runInContext('quizBank = null', sandbox);
    for (let c = 0; c < 40; c++) {
      const sid = 'manyB' + c;
      save(sid, Array.from({ length: 5 }, (_, i) => mkQ(sid, i)));
    }
    bank = readBank();
    const per4 = perSession(bank);
    if (bank.questions.length > 160) throw new Error('超出全库上限：' + bank.questions.length);
    if (per4.size !== 40) throw new Error('公平淘汰不该整张画布清零，覆盖 ' + per4.size + '/40');
    // 面板计数同源：题库按画布归集（面板行「题库 N 题」读的就是它）
    const counts = sandbox._quizBankCountsBySession();
    if (counts.get('manyB0') !== per4.get('manyB0')) throw new Error('面板计数与库内不一致');
  } finally {
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    sandbox.__prevQuizBank = prevBank;
    vm.runInContext('quizBank = __prevQuizBank', sandbox);
    delete sandbox.__prevQuizBank;
  }
  return true;
});

// ===== T317（2026-10-14）提取落库→检测面板素材计数刷新 =====
// 面板素材量吃 openQuiz 快照、提取要等回答流完才落库——刷新入口须在「弹窗开着＋intro＋
// 空闲」真刷两份池；生成中（生成端正按旧池出题）与关窗一律不动。沙箱 getElementById 每次
// 返回新 loose 代理（hidden 属性读不回真值），用真对象假元素顶住守卫读取。
seqCheck('quiz 素材刷新（T317）：intro 空闲刷新两份池，生成中与关窗不动', async () => {
  const realFetch = sandbox.fetch;
  const realGEB = sandbox.document.getElementById;
  const realGetAll = sandbox.window.getAllSessions;
  const prev = vm.runInContext('JSON.stringify({mode:quizMode,scope:quizScope,panel:quizLoopPanelOpen})', sandbox);
  const prevState = vm.runInContext('quizState', sandbox);
  sandbox.__prevQuizState = prevState;
  sandbox.localStorage.removeItem('phymathia_knowledge');
  sandbox.invalidateKnowledgeCache();
  let knowledgeItems = { kNew: { id: 'kNew', title: '新落库的知识点', summary: '刚提取完的条目', sessionId: 'sA' } };
  sandbox.fetch = async (url) => {
    if (String(url).includes('/api/knowledge')) {
      return { ok: true, status: 200, json: async () => ({ items: knowledgeItems }) };
    }
    return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
  };
  sandbox.window.getAllSessions = () => [{ id: 'sA', title: '力学画布' }];
  const els = {
    quizModal: loose('fakeQuizModal'),
    quizBody: loose('fakeQuizBody'),
  };
  els.quizModal.hidden = false;
  els.quizModal.classList = { contains: () => true };
  sandbox.document.getElementById = (id) => els[id] || realGEB(id);
  try {
    vm.runInContext(`quizMode = 'global'; quizScope = 'all'; quizLoopPanelOpen = true;
      quizState = { phase: 'intro', aiPending: false, aiProgress: 0,
        pool: { knowledge: [], formulas: [] }, rawPool: { knowledge: [], formulas: [] }, questions: [] }`, sandbox);
    await sandbox.refreshQuizMaterialCounts();
    let n = vm.runInContext('quizState.rawPool.knowledge.length', sandbox);
    if (n !== 1) throw new Error('空闲刷新应把新落库条目刷进全量池，实际 ' + n);
    n = vm.runInContext('quizState.pool.knowledge.length', sandbox);
    if (n !== 1) throw new Error('范围池应同步刷新，实际 ' + n);
    if (vm.runInContext('quizState.pool.knowledge[0].title', sandbox) !== '新落库的知识点') {
      throw new Error('刷新后条目标题不对：' + vm.runInContext('quizState.pool.knowledge[0] && quizState.pool.knowledge[0].title', sandbox));
    }
    // 生成中：不动池（生成端正按旧池出题，中途换池会鸡飞狗跳）
    knowledgeItems = {
      kNew: { id: 'kNew', title: '新落库的知识点', summary: '刚提取完的条目', sessionId: 'sA' },
      kNew2: { id: 'kNew2', title: '第二条新知识', summary: '稍后落库', sessionId: 'sA' },
    };
    vm.runInContext('quizState.aiPending = true', sandbox);
    await sandbox.refreshQuizMaterialCounts();
    if (vm.runInContext('quizState.rawPool.knowledge.length', sandbox) !== 1) throw new Error('生成中不应刷新池');
    // 关窗：不刷新
    vm.runInContext('quizState.aiPending = false', sandbox);
    els.quizModal.hidden = true;
    await sandbox.refreshQuizMaterialCounts();
    if (vm.runInContext('quizState.rawPool.knowledge.length', sandbox) !== 1) throw new Error('关窗不应刷新池');
  } finally {
    sandbox.fetch = realFetch;
    sandbox.document.getElementById = realGEB;
    if (realGetAll) sandbox.window.getAllSessions = realGetAll; else delete sandbox.window.getAllSessions;
    // 沙箱 context 顶层 const 绑定跨 runInContext 持久（面板用例的 const p 已占坑），别再声明同名
    const p = JSON.parse(prev);
    vm.runInContext(`quizState = __prevQuizState; quizMode = ${JSON.stringify(p.mode)}; quizScope = ${JSON.stringify(p.scope)}; quizLoopPanelOpen = ${p.panel}`, sandbox);
    delete sandbox.__prevQuizState;
    sandbox.localStorage.removeItem('phymathia_knowledge');
    sandbox.invalidateKnowledgeCache();
  }
  return true;
});
}
