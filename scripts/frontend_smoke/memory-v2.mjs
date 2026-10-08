// 记忆功能 v2 可感知性＋确定性信号采集
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 5158–5292 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 记忆功能 v2：可感知性 + 确定性信号采集（2026-09-17） =====
// 同步用例（不 await、即时清理共享键），追加在串行边界之后安全。

check('memory-v2：红点/休眠/归档容器与角标、信号回传的前后端接线都在', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const [name, token] of [
    ['侧边栏记忆红点', 'memory-dot" id="memoryDot"'],
    ['休眠记忆区', 'id="memoryIdleList"'],
    ['归档区', 'id="memoryArchiveList"'],
  ]) {
    if (!html.includes(token)) throw new Error(name + ' 缺失');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const token of ['.memory-dot {', '.memory-badge-btn {', '.memory-badge-detail {']) {
    if (!css.includes(token)) throw new Error('记忆样式缺失：' + token);
  }
  const memoryJs = fs.readFileSync('src/static/js/memory.js', 'utf8');
  for (const token of [
    'memoryPostCandidates', 'memoryNotifyPromoted', 'memoryBadgeSections',
    'memoryAppendProfileBadge', 'memoryRestoreFact', 'memoryRestoreArchive',
  ]) {
    if (!memoryJs.includes(token)) throw new Error('memory.js 缺少 ' + token);
  }
  const quizStatsJs = fs.readFileSync('src/static/js/quiz-stats.js', 'utf8');
  if (!quizStatsJs.includes('_collectProfileSignalCandidates')) throw new Error('quiz-stats 缺少信号采集');
  if (!quizStatsJs.includes('_scheduleProfileSignalSync();')) throw new Error('quiz-stats 答题后未挂信号同步');
  // 2026-09-25 线性主聊天退役：聊天消息 meta 的画像角标接线（chat.js 解析
  // profile_usage 帧 + memoryAppendProfileBadge）随管线删除——角标唯一挂点是
  // 已不存在的气泡 meta；memory.js 的角标函数本体保留（画布/Φ 侧仍可用）。
  const chatFeaturesJs = fs.readFileSync('src/static/js/chat-features.js', 'utf8');
  if (!chatFeaturesJs.includes('data.profile.promoted')) throw new Error('chat-features 未处理提取响应的 promoted');
  return true;
});

check('memory-v2：角标优先用后端注入快照，缓存只在无快照时兜底', () => {
  vm.runInContext(`
    memoryBadgeSectionsFromCache = memoryBadgeSectionsFromCache || function () { return [{ label: '学段', text: '缓存里的学段' }]; };
  `, sandbox);
  try {
    const withSnapshot = sandbox.memoryBadgeSections({ sections: [{ label: '学段', text: '大一' }] });
    if (withSnapshot.length !== 1 || withSnapshot[0].text !== '大一') {
      throw new Error('有快照时应以快照为准：' + JSON.stringify(withSnapshot));
    }
    const emptySnapshot = sandbox.memoryBadgeSections({ sections: [] });
    if (emptySnapshot.length !== 0) throw new Error('服务端说本次没注入时不得显示角标');
  } finally {
    vm.runInContext(`_cachedProfile = null;`, sandbox);
  }
  return true;
});

check('memory-v2：角标分节与后端注入同构（学段/目标/薄弱/兴趣/偏好/其他，停用与空闲返回空）', () => {
  vm.runInContext(`
    _cachedProfile = {
      enabled: true,
      explicit: { stage: '高二', goal: '', interests: '天体物理', weakAreas: '', style: { detail: '标准', jargon: '通俗', visuals: '否' } },
      facts: [
        { id: 'pf_1', fact: '检测多次答错：电磁感应', category: 'weakness', status: 'active' },
        { id: 'pf_2', fact: '休眠事实', category: 'other', status: 'idle' },
      ],
      pending: [],
    };
  `, sandbox);
  try {
    const sections = sandbox.memoryBadgeSections();
    const labels = sections.map(s => s.label).join(',');
    if (!labels.includes('学段') || !labels.includes('薄弱') || !labels.includes('兴趣') || !labels.includes('偏好')) {
      throw new Error('角标分节不全：' + labels);
    }
    if (labels.includes('其他')) throw new Error('idle 事实不应出现在角标');
    vm.runInContext(`_cachedProfile.enabled = false;`, sandbox);
    if (sandbox.memoryBadgeSections().length !== 0) throw new Error('停用时应返回空分节');
  } finally {
    vm.runInContext(`_cachedProfile = null;`, sandbox);
  }
  return true;
});

check('memory-v2：相对时间口径（刚刚/分钟/小时/天/日期；服务端秒级时间戳自动换算）', () => {
  const now = Date.now();
  if (sandbox.memoryRelTime(now - 5000) !== '刚刚') throw new Error('5 秒前应为 刚刚');
  if (sandbox.memoryRelTime(now - 5 * 60000) !== '5 分钟前') throw new Error('分钟口径错');
  if (sandbox.memoryRelTime(now - 3 * 3600000) !== '3 小时前') throw new Error('小时口径错');
  if (sandbox.memoryRelTime(now - 2 * 86400000) !== '2 天前') throw new Error('天口径错');
  if (sandbox.memoryRelTime(0) !== '—') throw new Error('无时间戳应为 —');
  // 服务端 time.time() 是秒：不换算会算出天文数字差值，落到 1970 年的日期
  const secNow = Math.floor(now / 1000);
  if (sandbox.memoryRelTime(secNow - 3 * 3600) !== '3 小时前') {
    throw new Error('秒级时间戳未换算：' + sandbox.memoryRelTime(secNow - 3 * 3600));
  }
  return true;
});

check('memory-v2：确定性信号采集——薄弱(≥2错)与兴趣(≥3会话)成候选，发送成功才记 7 天防重账', () => {
  const now = Date.now();
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify({
    t1: { title: '简谐运动', wrong: 2, correct: 0, mastery: 30, last: now },
    t2: { title: '牛顿第二定律', wrong: 1, correct: 5, mastery: 90, last: now },
  }));
  // getKnowledgeItems 是 bundle 里的真函数（词法绑定，stub window 盖不掉），直接播种其数据源
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    k1: { title: '梯度', sessionId: 's1' },
    k2: { title: '梯度', sessionId: 's2' },
    k3: { title: '梯度', sessionId: 's3' },
    k4: { title: '散度', sessionId: 's1' },
  }));
  if (typeof sandbox.invalidateKnowledgeCache === 'function') sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.removeItem('phymathia_memory_signal_sync');
  try {
    const first = sandbox._collectProfileSignalCandidates();
    const facts = first.candidates.map(c => c.fact).join('|');
    if (!facts.includes('检测多次答错：简谐运动')) throw new Error('薄弱候选缺失：' + facts);
    if (!facts.includes('经常提问：梯度')) throw new Error('兴趣候选缺失：' + facts);
    if (facts.includes('牛顿第二定律')) throw new Error('1 错且高掌握不应判薄弱：' + facts);
    if (facts.includes('散度')) throw new Error('单会话主题不应判兴趣：' + facts);
    // 未发送成功不落账：重复采集仍能拿到同样候选（POST 失败不消耗 7 天窗口）
    const again = sandbox._collectProfileSignalCandidates();
    if (again.candidates.length !== first.candidates.length) {
      throw new Error('未发送成功不应记账：' + again.candidates.map(c => c.fact).join('|'));
    }
    // 模拟整批被服务端确认接收后的防重账；部分接收由阶段2隔离回归覆盖。
    const synced = JSON.parse(sandbox.localStorage.getItem('phymathia_memory_signal_sync') || '{}');
    for (const syncKey of Object.values(first.marks)) synced[syncKey] = now;
    sandbox.localStorage.setItem('phymathia_memory_signal_sync', JSON.stringify(synced));
    const third = sandbox._collectProfileSignalCandidates();
    if (third.candidates.length !== 0) throw new Error('7 天防重账未生效：' + third.candidates.map(c => c.fact).join('|'));
  } finally {
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
    sandbox.localStorage.removeItem('phymathia_knowledge');
    sandbox.localStorage.removeItem('phymathia_memory_signal_sync');
    if (typeof sandbox.invalidateKnowledgeCache === 'function') sandbox.invalidateKnowledgeCache();
  }
  return true;
});
}
