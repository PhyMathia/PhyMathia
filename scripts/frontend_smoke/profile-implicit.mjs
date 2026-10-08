// 隐式行为画像（纯同步段＋尾部「出题吃画像」串行段）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 8141–8335 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
// ====== 隐式行为画像（数学模型 v1，2026-10-06）：纯同步源契约＋纯函数渲染，不占串行边界段 ======

check('隐式画像：前端上报器与仪表盘渲染（行为画像 v1）', () => {
  if (typeof sandbox.reportProfileEvent !== 'function') throw new Error('reportProfileEvent 未定义');
  if (typeof sandbox.memoryRenderModelHtml !== 'function') throw new Error('memoryRenderModelHtml 未定义');
  const html = sandbox.memoryRenderModelHtml({
    enabled: true, maturity: 0.78, events: 30, seeded: true,
    topics: [{ topic: '电磁感应', w: 3.2, share: 0.34, p: 0.6, m: 0.58, h: 9.1, ans: 4, ok: 3,
      ledger: [{ type: 'answer', at: Date.now(), x: 1, p: 0.6 }] }],
    style: { f1: 0.4, f2: -0.2, ledger: [] },
    frozen: { interest: false, mastery: false, style: false },
  });
  // 沙箱的 escapeHtml 走宽松 DOM 代理，行内标签与数值全被转义成垃圾串不可断言——
  // 分节标题是原生拼接、且只在对应行成功渲染时才出现，用它当行渲染的行为证据
  if (!html.includes('成熟度 78%')) throw new Error('成熟度未渲染');
  if (!html.includes('兴趣（占注意力比例）')) throw new Error('兴趣行未渲染');
  if (!html.includes('能力（含遗忘折算）')) throw new Error('能力行未渲染');
  if (!html.includes('风格（只排呈现顺序与配比')) throw new Error('风格行未渲染');
  if (!html.includes('memory-model-row') || !html.includes('memory-bar')) throw new Error('行结构未渲染');
  if (!html.includes('memoryFreezeImplicit')) throw new Error('冻结开关未渲染');
  const empty = sandbox.memoryRenderModelHtml({ enabled: true, maturity: 0, events: 0, topics: [],
    style: { f1: 0, f2: 0 }, frozen: {}, seeded: true });
  if (!empty.includes('行为数据还不够')) throw new Error('空态提示缺失');
  return true;
});

check('隐式画像：前端接线契约（expand/visualize/difficulty/confused/kv device_id/面板区块）', () => {
  const graph = fs.readFileSync('src/static/js/graph.js', 'utf8');
  if (!graph.includes("window.reportProfileEvent('expand')")) throw new Error('graph.js 展开未上报 expand');
  const render = fs.readFileSync('src/static/js/render.js', 'utf8');
  if (!render.includes("window.reportProfileEvent('visualize')")) throw new Error('render.js 可视化未上报');
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  if (!ui.includes("window.reportProfileEvent('difficulty'")) throw new Error('ui.js 难度未上报');
  const quizUi = fs.readFileSync('src/static/js/quiz-ui.js', 'utf8');
  if (!quizUi.includes("window.reportProfileEvent('confused'")) throw new Error('quiz-ui.js 没看懂未上报');
  const qstats = fs.readFileSync('src/static/js/quiz-stats.js', 'utf8');
  if (!/phymathia_quiz_stats[\s\S]{0,220}device_id/.test(qstats)) throw new Error('kv 同步缺 device_id');
  const memory = fs.readFileSync('src/static/js/memory.js', 'utf8');
  if (!memory.includes("'/api/profile/event'")) throw new Error('memory.js 缺事件上报端点');
  if (!memory.includes('/api/profile/dashboard?device_id=')) throw new Error('memory.js 缺仪表盘端点');
  if (!memory.includes('_memoryEvidenceText')) throw new Error('memory.js 缺证据账本渲染');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="memoryModelList"') || !html.includes('id="memoryModelMaturity"')) {
    throw new Error('index.html 缺行为画像区块');
  }
  return true;
});

// ===== 串行边界追加：知识检测出题吃隐式画像（2026-10-06）=====
// 异步用例（覆写 sandbox.memoryFetchModel/fetch）放在全部并发用例之后串行独占跑；
// 不写任何共享 localStorage 键（画像与统计全走 stub/缺省），覆写在 finally 恢复。
// POOL_IMPL：池序故意排「已掌握→薄弱→没答过→画像外」，有画像时应被重排、无画像时保持原序。
const POOL_IMPL = {
  knowledge: [
    { id: 'k_a', title: '主题乙', summary: '已掌握', formulas: [], sessionId: 's_impl' },
    { id: 'k_b', title: '主题甲', summary: '薄弱', formulas: [], sessionId: 's_impl' },
    { id: 'k_c', title: '主题丙', summary: '没答过', formulas: [], sessionId: 's_impl' },
    { id: 'k_d', title: '画像外主题', summary: '画像没见过', formulas: [], sessionId: 's_impl' },
  ],
  formulas: []
};
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

  await qcheck('quiz-ai：隐式画像门控（enabled=false/成熟度<0.3/请求失败→null；0.3 边界放行）', async () => {
    const prev = sandbox.memoryFetchModel;
    try {
      sandbox.memoryFetchModel = async () => ({ enabled: false });
      if (await sandbox._quizImplicitProfile() !== null) throw new Error('enabled=false 应返回 null');
      sandbox.memoryFetchModel = async () => ({ enabled: true, maturity: 0.29, topics: [{ topic: '主题甲', m: 0.3, share: 0.4, ans: 4 }] });
      if (await sandbox._quizImplicitProfile() !== null) throw new Error('maturity<0.3 应返回 null');
      sandbox.memoryFetchModel = async () => { throw new Error('network down'); };
      if (await sandbox._quizImplicitProfile() !== null) throw new Error('请求失败应静默返回 null');
      sandbox.memoryFetchModel = async () => ({ enabled: true, maturity: 0.5, topics: [] });
      if (await sandbox._quizImplicitProfile() !== null) throw new Error('无主题应返回 null');
      sandbox.memoryFetchModel = async () => ({ enabled: true, maturity: 0.3, topics: [{ topic: '主题甲', m: 'x', share: 0.4, ans: 4 }] });
      const ok = await sandbox._quizImplicitProfile();
      if (!ok || ok.maturity !== 0.3 || ok.topics.length !== 1) throw new Error('成熟度 0.3 边界应放行');
      if (ok.topics[0].m !== 0.2) throw new Error('非数值 m 应回落 0.2 先验');
      return true;
    } finally { sandbox.memoryFetchModel = prev; }
  });

  await qcheck('quiz-ai：出题链路吃隐式画像（素材薄弱前置＋难度配比行；门控关/失败与无画像逐字节一致）', async () => {
    const MODEL_OUT = JSON.stringify({ questions: [
      { title: '主题甲', prompt: '关于主题甲的检测题', options: ['甲对', '甲错一', '甲错二', '甲错三'], correctIndex: 0, explanation: '解析甲', difficulty: 'easy' },
      { title: '主题丙', prompt: '关于主题丙的检测题', options: ['丙对', '丙错一', '丙错二', '丙错三'], correctIndex: 1, explanation: '解析丙', difficulty: 'medium' },
    ] });
    const captureFetch = (captures) => async (url, opts) => {
      const u = String(url);
      if (u.includes('quiz-prompt')) return { ok: true, status: 200, text: async () => '## 出题\n出题要求\n\n## 审题\n审题要求' };
      if (u.includes('/api/profile')) return { ok: true, status: 200, json: async () => ({ enabled: false }) };
      captures.body = opts && opts.body;
      const chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: MODEL_OUT } }] }) + '\n\n';
      let sent = false;
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
        if (sent) return { done: true };
        sent = true;
        return { done: false, value: new TextEncoder().encode(chunk) };
      } }) } };
    };
    const prevFetch = sandbox.fetch;
    const prevModel = sandbox.getActiveModelForRole;
    const prevImplicit = sandbox.memoryFetchModel;
    try {
      sandbox.getActiveModelForRole = () => ({ provider: 'mock', apiKey: 'k', model: 'm', baseUrl: 'http://mock', thinking: '' });
      // 有画像：薄弱（有作答且 m̂≤0.7）最前 → 没答过（保出场）→ 已掌握 → 画像外（探索保底）
      const capOn = {};
      sandbox.fetch = captureFetch(capOn);
      sandbox.memoryFetchModel = async () => ({
        enabled: true, maturity: 0.5, events: 40, seeded: true,
        topics: [
          { topic: '主题甲', w: 4, share: 0.4, m: 0.3, ans: 4, ok: 1 },
          { topic: '主题乙', w: 4, share: 0.4, m: 0.95, ans: 6, ok: 6 },
          { topic: '主题丙', w: 2, share: 0.2, m: 0.2, ans: 0, ok: 0 },
        ]
      });
      const qs = await sandbox._aiGenerateQuizQuestions(POOL_IMPL, undefined, false);
      if (!Array.isArray(qs) || qs.length !== 2) throw new Error('AI 题应解析出 2 道');
      const msgOn = JSON.parse(capOn.body).messages.find(m => m.role === 'user').content;
      const i甲 = msgOn.indexOf('知识点：主题甲'), i丙 = msgOn.indexOf('知识点：主题丙'),
            i乙 = msgOn.indexOf('知识点：主题乙'), i外 = msgOn.indexOf('知识点：画像外主题');
      if (i甲 < 0 || i丙 < 0 || i乙 < 0 || i外 < 0) throw new Error('素材行缺失');
      if (!(i甲 < i丙 && i丙 < i乙 && i乙 < i外)) {
        throw new Error('排序应为 薄弱→没答过→已掌握→画像外，实际 ' + [i甲, i丙, i乙, i外].join(','));
      }
      // 相关已答主题平均 m̂=(0.3+0.95)/2=0.625 → 2:4:4、d*=3.5 档（§3.4 连续值）
      if (!msgOn.includes('难度配比建议') || !msgOn.includes('2:4:4') || !msgOn.includes('目标难度约 3.5/5 档')) {
        throw new Error('难度配比行缺失或档位不符');
      }
      if (msgOn.includes('用户薄弱点')) throw new Error('不应混入显式薄弱点（显式画像 enabled=false）');
      // 门控三关逐字节等价：enabled=false / 请求抛错 / 返回 null —— 全部与无画像一致
      const baselines = [];
      for (const stub of [async () => ({ enabled: false }), async () => { throw new Error('down'); }, async () => null]) {
        const cap = {};
        sandbox.fetch = captureFetch(cap);
        sandbox.memoryFetchModel = stub;
        await sandbox._aiGenerateQuizQuestions(POOL_IMPL, undefined, false);
        baselines.push(JSON.parse(cap.body).messages.find(m => m.role === 'user').content);
      }
      if (baselines[0] !== baselines[1] || baselines[1] !== baselines[2]) throw new Error('门控各情形应逐字节一致');
      if (baselines[0].includes('难度配比建议')) throw new Error('无画像不应出现难度配比行');
      const b乙 = baselines[0].indexOf('知识点：主题乙'), b甲 = baselines[0].indexOf('知识点：主题甲');
      if (!(b乙 >= 0 && b乙 < b甲)) throw new Error('无画像应保持 pool 原序（乙在甲前）');
      if (baselines[0] === msgOn) throw new Error('有画像时应与无画像不同');
      return true;
    } finally {
      sandbox.fetch = prevFetch;
      sandbox.getActiveModelForRole = prevModel;
      sandbox.memoryFetchModel = prevImplicit;
    }
  });
}

// 知识检测隐式画像：纯同步纯函数用例（不碰共享键），追加安全
check('quiz-ai：隐式排序纯函数（薄弱前置/没答过保出场/pool 不动/无画像原序）', () => {
  const implicit = { maturity: 0.5, topics: [
    { name: '主题甲', key: '主题甲', m: 0.3, pi: 0.4, ans: 4 },
    { name: '主题乙', key: '主题乙', m: 0.95, pi: 0.4, ans: 6 },
    { name: '主题丙', key: '主题丙', m: 0.2, pi: 0.2, ans: 0 },
  ] };
  const pool = { knowledge: POOL_IMPL.knowledge.slice(), formulas: [] };
  const titles = ctx => ctx.split('\n').filter(l => l.includes('知识点：'))
    .map(l => (l.match(/知识点：(\S+)/) || [])[1]);
  const ordered = titles(sandbox._buildQuizGenerationContext(pool, implicit));
  if (ordered.join(',') !== '主题甲,主题丙,主题乙,画像外主题') throw new Error('排序不符：' + ordered.join(','));
  if (pool.knowledge[0].id !== 'k_a') throw new Error('pool 本体被重排');
  const plain = titles(sandbox._buildQuizGenerationContext(pool));
  if (plain.join(',') !== '主题乙,主题甲,主题丙,画像外主题') throw new Error('无画像应保持原序：' + plain.join(','));
  return true;
});

check('quiz-ai：难度配比四档（§3.4 d*=1+4m̂）与无证据不出手', () => {
  const mk = (m, ans) => ({ name: '主题甲', key: '主题甲', m, pi: 0.4, ans });
  const pool = { knowledge: [{ title: '主题甲' }], formulas: [] };
  const hint = topics => sandbox._quizDifficultyRatioHint(topics && { maturity: 0.5, topics }, pool);
  const low = hint([mk(0.3, 2)]);
  if (!low.includes('6:3:1') || !low.includes('easy 为主')) throw new Error('m̂=0.3 应 easy 为主：' + low);
  if (!low.includes('2.2/5 档')) throw new Error('d*=1+4m̂ 连续档位不符：' + low);
  if (!hint([mk(0.45, 2)]).includes('3:5:2')) throw new Error('m̂=0.45 应 medium 为主');
  if (!hint([mk(0.625, 2)]).includes('2:4:4')) throw new Error('m̂=0.625 应中高均衡');
  if (!hint([mk(0.9, 2)]).includes('1:2:7')) throw new Error('m̂=0.9 应 hard 为主');
  if (hint([mk(0.3, 0)]) !== '') throw new Error('相关主题没答过题不应给配比');
  if (hint(null) !== '' || hint([]) !== '') throw new Error('无画像不应给配比');
  return true;
});
}
