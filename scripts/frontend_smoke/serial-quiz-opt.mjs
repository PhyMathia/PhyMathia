// 串行边界：知识检测出题优化
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 7458–7597 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
// ===== 串行边界追加：知识检测出题优化（2026-10-01）=====
// 全部放在 pendingChecks 之后串行跑：盲答校验用例覆写全局 fetch 与
// getActiveModelForRole、自适应用例写共享 phymathia_quiz_stats 键，
// 与在飞的 async 用例并发会互踩。
{
  const qcheck = async (name, fn) => {
    try {
      const r = await fn();
      if (r === false) { addFailed(); console.error('❌', name, '-> 断言未通过'); }
      else console.log('✓', name);
    } catch (e) {
      addFailed(); console.error('❌', name, '->', (e && e.message) || e);
    }
  };

  await qcheck('quiz-ai：出题素材标注掌握情况（自适应回流；未测/无统计不标，mastery 缺失重算）', () => {
    const pool = { knowledge: [
      { id: 'k_1', title: '牛顿第二定律', summary: '概述甲', formulas: [], sessionId: 's_quizopt' },
      { id: 'k_2', title: '未测知识点', summary: '概述乙', formulas: [], sessionId: 's_quizopt' },
    ], formulas: [
      // concept 与知识点标题不同名：topicKey 按标题/概念归一，同名会共享同一主题统计（设计如此），测试需要两条独立记录
      { id: 'f_1', latex: 'F=ma', concept: '加速度定律', meaning: '力使物体产生加速度', sessionId: 's_quizopt' },
    ] };
    // 匹配键与写入侧同源：动态用 _quizTopicKey 计算，不硬编码归一化结果
    const kKey = sandbox._quizTopicKey(pool.knowledge[0]);
    const fKey = sandbox._quizTopicKey(pool.formulas[0]);
    const stats = { _meta: {},
      [kKey]: { correct: 3, wrong: 2, mastery: 40, title: '牛顿第二定律', sessionId: 's_quizopt', topicKey: kKey, history: [] },
      [fKey]: { correct: 1, wrong: 0, mastery: 90, title: '牛顿第二定律', sessionId: 's_quizopt', topicKey: fKey, history: [] } };
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
    try {
      const ctx = sandbox._buildQuizGenerationContext(pool);
      const kLine = ctx.split('\n').find(l => l.includes('知识点：牛顿第二定律'));
      if (!kLine || !kLine.includes('掌握度 40%') || !kLine.includes('答对 3 次') || !kLine.includes('答错 2 次')) {
        throw new Error('知识条目标注缺失：' + kLine);
      }
      const fLine = ctx.split('\n').find(l => l.includes('f_1'));
      if (!fLine || !fLine.includes('掌握度 90%') || fLine.includes('答错')) {
        throw new Error('公式条目标注不符（答错 0 次不应出现）：' + fLine);
      }
      const untested = ctx.split('\n').find(l => l.includes('未测知识点'));
      if (untested.includes('掌握')) throw new Error('未测条目不应标注：' + untested);
      // mastery 缺失 → _quizMastery 重算，仍有标注
      delete stats[kKey].mastery;
      sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
      if (!sandbox._buildQuizGenerationContext(pool).includes('掌握度')) throw new Error('mastery 缺失应重算并标注');
    } finally {
      sandbox.localStorage.removeItem('phymathia_quiz_stats');
    }
    // 无任何统计：全体无标注（自适应零污染）
    if (sandbox._buildQuizGenerationContext(pool).includes('掌握')) throw new Error('无统计时不应出现任何掌握标注');
    return true;
  });

  await qcheck('quiz-ai：审题盲答校验（遮答案；不一致/漏答/drop 弃题，一致保留原题；存活<2 返回 null）', async () => {
    const mkQ = (id, correctIndex) => ({ id, type: 'concept', title: '知识点甲', sourceRef: 'k_1', refId: 'k_1',
      difficulty: 'medium', prompt: '题 ' + id, formulaText: '',
      options: [{ key: 'A', text: '选项A' }, { key: 'B', text: '选项B' }, { key: 'C', text: '选项C' }, { key: 'D', text: '选项D' }],
      correctIndex, explanation: '解析 ' + id, topicKey: 'tk', sessionId: 's_quizopt' });
    const pool = { knowledge: [{ id: 'k_1', title: '知识点甲', summary: '概述', formulas: [], sessionId: 's_quizopt' }], formulas: [] };
    // mock fetch：quiz-prompt.md 走 text()；models/chat 走单帧 SSE，content 即模型输出文本
    const sse = (modelText, captures) => async (url, opts) => {
      if (String(url).includes('quiz-prompt')) {
        return { ok: true, status: 200, text: async () => '## 出题\n出题要求X\n\n## 审题\n审题要求Y {{LEVEL_PROMPT}}' };
      }
      if (captures) captures.body = opts && opts.body;
      const chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: modelText } }] }) + '\n\n';
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
        if (sent) return { done: true };
        sent = true;
        return { done: false, value: new TextEncoder().encode(chunk) };
      } }) } };
    };
    const prevFetch = sandbox.fetch;
    const prevModel = sandbox.getActiveModelForRole;
    try {
      sandbox.getActiveModelForRole = () => ({ provider: 'mock', apiKey: 'k', model: 'm', baseUrl: 'http://mock', thinking: '' });
      // 场景 A：一致×2 保留、不一致×1 弃、drop×1 弃、漏答×1 弃 → 存活 2 且为原题对象
      const qA = [mkQ('q1', 0), mkQ('q2', 1), mkQ('q3', 2), mkQ('q4', 3), mkQ('q5', 0)];
      const reviewsA = JSON.stringify({ reviews: [
        { id: 'q1', answerIndex: 0, verdict: 'pass', reason: 'ok' },
        { id: 'q2', answerIndex: 1, verdict: 'pass', reason: 'ok' },
        { id: 'q3', answerIndex: 0, verdict: 'pass', reason: 'ok' },
        { id: 'q4', answerIndex: 3, verdict: 'drop', reason: 'bad' },
      ] });
      const capA = {};
      sandbox.fetch = sse(reviewsA, capA);
      const kept = await sandbox._aiVerifyQuizQuestions(pool, qA);
      if (!Array.isArray(kept) || kept.length !== 2) throw new Error('应存活 2 题，实际 ' + (kept && kept.length));
      if (kept[0] !== qA[0] || kept[1] !== qA[1]) throw new Error('保留的必须是原题对象（不采信审题改写）');
      const userMsg = JSON.parse(capA.body).messages.find(m => m.role === 'user').content;
      if (userMsg.includes('correctIndex') || userMsg.includes('解析 q1')) throw new Error('审题请求泄露了正确答案/解析');
      if (!userMsg.includes('不含正确答案')) throw new Error('审题指令缺「不含正确答案」约定');
      // 场景 B：全部不一致 → 存活 0 → 返回 null（维持降级语义）
      sandbox.fetch = sse(JSON.stringify({ reviews: [
        { id: 'q1', answerIndex: 1, verdict: 'pass', reason: 'x' },
        { id: 'q2', answerIndex: 0, verdict: 'pass', reason: 'x' },
      ] }));
      const none = await sandbox._aiVerifyQuizQuestions(pool, [mkQ('q1', 0), mkQ('q2', 1)]);
      if (none !== null) throw new Error('全不一致应返回 null');
      // 场景 C：```json 围栏包裹的 reviews 也能解析（模型输出带围栏是常态）
      const fenced = '```json\n' + JSON.stringify({ reviews: [
        { id: 'q1', answerIndex: 0, verdict: 'pass', reason: 'ok' },
        { id: 'q2', answerIndex: 1, verdict: 'pass', reason: 'ok' },
      ] }) + '\n```';
      sandbox.fetch = sse(fenced);
      const kept2 = await sandbox._aiVerifyQuizQuestions(pool, [mkQ('q1', 0), mkQ('q2', 1)]);
      if (!Array.isArray(kept2) || kept2.length !== 2 || kept2[0].id !== 'q1') throw new Error('围栏包裹的 reviews 解析失败');
      return true;
    } finally {
      sandbox.fetch = prevFetch;
      sandbox.getActiveModelForRole = prevModel;
    }
  });

  await qcheck('quiz-ui：本地启发式评分带 local 标记（降级评分可见性）', () => {
    const r = sandbox._localScoreOpenAnswer(
      { title: '简谐运动', context: { title: '简谐运动', summary: '回复力与位移成正比', formulas: ['F=-kx'] } },
      '物理上回复力指向平衡位置，因为数学上是二阶线性微分方程，所以两者联系紧密，结构上体现了线性回复，边界上适用于小角度情形。');
    if (!r || r.local !== true) throw new Error('本地启发式评分缺 local 标记');
    if (!code.includes('quiz-local-score-badge')) throw new Error('渲染缺「本地启发式评分」徽标类接线');
    return true;
  });

  await qcheck('quiz：弹窗 ✕ 直接关闭（T46）＋盲答协议/掌握规则单源同步（静态断言）', () => {
    const html = fs.readFileSync('src/static/index.html', 'utf8');
    if (!/class="quiz-close-icon"[^>]*onclick="closeQuiz\(\)"/.test(html)) throw new Error('quiz 弹窗缺 ✕ 关闭按钮（T46）');
    const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
    if (!css.includes('.quiz-local-score-badge')) throw new Error('缺本地评分徽标样式');
    if (!css.includes('.quiz-close-icon')) throw new Error('缺 ✕ 按钮样式');
    const md = fs.readFileSync('src/static/quiz-prompt.md', 'utf8');
    if (!md.includes('不含正确答案') || !md.includes('"reviews"')) throw new Error('quiz-prompt.md 审题节未切换盲答协议');
    if (!md.includes('用户掌握情况')) throw new Error('quiz-prompt.md 出题节缺掌握情况规则');
    // 兜底审题 prompt（quiz.js）与正式版同为盲答协议，不得各自演化
    if (!/DEFAULT_QUIZ_VERIFY_PROMPT[\s\S]{0,1500}reviews/.test(code)) throw new Error('兜底审题 prompt 未同步盲答 reviews 协议');
    return true;
  });
}
}
