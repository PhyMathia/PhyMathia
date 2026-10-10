// 串行边界：utopia 快照导入（写共享 phymathia_sessions 键）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 5494–5662 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 串行边界追加：utopia 快照导入（写共享 phymathia_sessions 键 + await fetch）=====
// 2026-09-27：只读外发页的右键菜单是**按标签文本**做白名单剪枝的
// （viewer-main.js 的 READONLY_MENU_LABELS）。也就是说主应用那边一改菜单文案，
// 这里不同步的话，查看器里那个菜单项会被**静默剪掉**——整张菜单空了还会顺手 close，
// 症状是「只读页右键少了一项」，全程无任何报错。
// 「导出超高清 PNG…」改成「导出…」时踩过一次，靠肉眼看出来的。这条断言把它变成会红的。
check('viewer: 只读菜单白名单的每一条都还能在主应用菜单里找到', () => {
  const vm = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  const cm = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  const m = vm.match(/var READONLY_MENU_LABELS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('viewer-main.js 里找不到 READONLY_MENU_LABELS');
  const labels = (m[1].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1));
  if (!labels.length) throw new Error('白名单解析出 0 条，断言本身坏了');
  // 判据是「该文案有没有作为引号字面量出现在菜单文件里」，不去解析 `label:` 那一行——
  // 那边不都是字面量：折叠/展开是三元表达式（`node.minimized ? '展开节点' : '折叠节点'`），
  // 「删除 」还带尾随空格。顺带记一笔：别用 `/'[^']+'/g` 一次抽全部字符串——源码里到处是
  // `|| ''` 这种空串，`[^']+` 匹配不上会一路错位把后面的内容吞进来（第一版就这么把
  // 「复制全文」判成了不存在）。这正是要挡的失败模式：文案被改掉或删掉。
  // 白名单是**前缀**匹配（label.indexOf(kw) === 0），所以菜单里写「导出…」而白名单写
  // 「导出」是合法的——判据跟着前缀语义走：文本出现在一个单引号之后即可。
  for (const lb of labels) {
    if (cm.indexOf("'" + lb) < 0) {
      throw new Error('白名单里的「' + lb + '」在 graph-contextmenu.js 里已不存在'
        + '——主应用改了菜单文案，这里必须同步，否则只读页那个菜单项会被静默剪掉');
    }
  }
});

check('viewer: 拓扑兜网的封装与访问器都是幂等的（防 Proxy 逐次套娃）', () => {
  // 2026-09-27 晚：原实现每渲染一次就把上一个 Proxy 当底子再封一层，嵌套层数随渲染
  // 次数线性增长（评审时用最小复现验实）。**这是个性能泄漏不是正确性破坏，所以下面
  // 这些护栏全删掉也不会有任何一条断言变红**——只能靠静态契约钉住。
  // 变异验证：删掉 `_SEALED.has(...)` 两处之一、或把 `TOPOLOGY_INSTALLED` 的守门去掉，
  // 本条立刻变红。
  const vm = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');

  if (!/var _SEALED = new WeakSet\(\)/.test(vm)) {
    throw new Error('viewer-main.js 里找不到 _SEALED = new WeakSet()——封装不再幂等，'
      + '每渲染一次多套一层 Proxy');
  }
  // 两个封装函数各要有一道 has() 短路：_sealArray 与 _sealIndex，缺一个就漏一个属性
  const hasChecks = (vm.match(/_SEALED\.has\(/g) || []).length;
  if (hasChecks !== 2) {
    throw new Error('_SEALED.has() 出现 ' + hasChecks + ' 次（应为 2：_sealArray 与 _sealIndex 各一）');
  }
  const adds = (vm.match(/_SEALED\.add\(/g) || []).length;
  if (adds !== 2) {
    throw new Error('_SEALED.add() 出现 ' + adds + ' 次（应为 2）——新装的代理没登记，下次会被当裸对象再封一层');
  }
  if (!/if \(!TOPOLOGY_INSTALLED\) _installTopologyAccessors\(\)/.test(vm)) {
    throw new Error('armTopologyGuard 里的 TOPOLOGY_INSTALLED 守门不见了——'
      + '每渲染一次重复 defineProperty 四个属性');
  }
  // 顺序不许反：先装访问器（内部经访问器读已封装的代理）再重算基线，反了会拿到裸数组算指纹
  const arm = vm.slice(vm.indexOf('function armTopologyGuard'));
  const armEnd = arm.indexOf('\n  }');
  const body = arm.slice(0, armEnd);
  if (body.indexOf('_installTopologyAccessors') > body.indexOf('TOPOLOGY_BASE =')) {
    throw new Error('armTopologyGuard 里先算基线后装访问器——指纹会从裸数组算，兜网从第一帧就失效');
  }
});

check('graph-workflow: 三个流式通道共用一份 SSE 读取（作用域限本文件）', () => {
  // 2026-09-27：B2 把三个流式函数里逐字重复的 SSE 帧读取抽成唯一一份
  // `_sseContentFrames`。这里钉住那个不变量——**别再往回抄**。抄回去的症状是
  // 「某类节点偶发不更新」，静态断言看不出来，只有真发才知道（而真发需要可用模型，
  // 见 docs/backlog.md T37）。所以退化成重复时必须在这里就红。
  //
  // **注意这条断言的作用域：T261 拆分后它读工作流族五件（主件+prompt/recipe/template/progress）。**
  // 2026-09-27 之前它叫「SSE 帧读取全仓只有一份」，那句是错的：全仓另有 4 处各自一份
  // getReader() 副本（chat.js:308 / chat-features.js:647 / quiz-ui.js:675 /
  // harness-run.js:113，后者是 buf+handleLine 的变体），B2 只合并了 graph-workflow 里的
  // 3 份。名字写成「全仓」会让人以为另外四处已被覆盖、进而不再去合并。
  // 那 4 处的合并已登记 backlog（连同真发验证要求），不在本轮范围：动发送链路按硬规则 6
  // 必须配可用模型真发验证，而现在没有可用凭证。所以这里改成如实描述作用域。
  // 族内分布：共享口 _sseContentFrames 与 3 个调用点在主件、配方概要调用点在 recipe 件。
  const gw = ['graph-workflow.js', 'graph-workflow-prompt.js', 'graph-workflow-recipe.js',
    'graph-workflow-template.js', 'graph-workflow-progress.js']
    .map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');
  // 数代码，不数散文：先把注释剥掉再数。上面那段说明里就写了 getReader() 字面量，
  // 原先直接对原文匹配，注释一改就假红——这正是本项目吃过亏的那类「护栏自己变摆设」。
  // 剥法：块注释全去，行注释只去「行首（可含缩进）//」那种。行尾注释与字符串里的 //
  // （如 'http://'）不去，避免误删真代码导致计数偏低。代价是行尾注释里写
  // getReader() 仍会被算进去——写注释时避开这个字面量即可。
  const gwCode = gw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readers = (gwCode.match(/getReader\(\)/g) || []).length;
  if (readers !== 1) {
    throw new Error('工作流族五件里 getReader() 出现 ' + readers
      + ' 次（应为 1）——有人在这些通道之外又把 SSE 读取抄了一份');
  }
  if (!/async function\* _sseContentFrames\(resp\)/.test(gwCode)) {
    throw new Error('共享读取口 _sseContentFrames 不见了');
  }
  const users = (gwCode.match(/for await \(const piece of _sseContentFrames\(resp\)\)/g) || []).length;
  if (users !== 4) {
    throw new Error('_sseContentFrames 的调用点 ' + users + ' 处（应为 4：模块节点 / 问题分析 / 空白节点 / 配方双阶段概要 P2）');
  }
  // 只吐正文增量：思维链绝不能混进正文（2026-09-15「旋度岛静默消失」的根因）
  // 在 gwCode 上切片：共享口自己那句「绝不碰 reasoning_content」的说明注释
  // 一旦挪进函数体内部，用原文匹配就会自己把自己判红。
  const gen = gwCode.slice(gwCode.indexOf('async function* _sseContentFrames'));
  const genEnd = gen.indexOf('\nasync function ', 1);
  const body = genEnd > 0 ? gen.slice(0, genEnd) : gen;
  if (/reasoning_content/.test(body)) {
    throw new Error('共享读取口里出现了 reasoning_content——思维链不许混进正文');
  }
  for (const fn of ['_streamCustomNodeResponse', '_streamAnalysisResponse', '_streamBlankNodeResponse']) {
    const i = gwCode.indexOf('async function ' + fn + '(');
    if (i < 0) throw new Error('找不到 ' + fn);
    const seg = gwCode.slice(i, i + 4000);
    if (!seg.includes('_sseContentFrames(resp)')) {
      throw new Error(fn + ' 没走共享读取口');
    }
  }
});

check('utopia-import: .pmu 恢复成新画布（三写落位 + 永不覆盖现有会话）', async () => {
  // 识别纯函数：.pmu 收、其它后缀放行
  const accept = sandbox.window.utopiaImportAccept;
  if (typeof accept !== 'function') throw new Error('utopiaImportAccept 未暴露');
  if (!accept({ name: 'a.PMU' })) throw new Error('.pmu 应被接受（大小写不敏感）');
  if (accept({ name: 'a.json' })) throw new Error('.json 不应走快照导入（避免抢数据导入通道）');
  if (accept(null)) throw new Error('空文件应被拒绝');
  // 行为级：真实 parse + 三写 + 切换
  const before = (() => { try { return JSON.parse(sandbox.localStorage.getItem('phymathia_sessions') || '{}'); } catch (e) { return {}; } })();
  const snapshot = {
    format: 'phymath-utopia/graph', version: 1,
    title: '导入测试网', graph: { pan: { x: 5, y: 6 }, zoom: 1 },
    nodes: [], edges: [], groups: [],
    messages: [{ role: 'user', content: 'q1', timestamp: 1 }, { role: 'assistant', content: 'a1', timestamp: 2 }],
  };
  
  const prevSwitch = sandbox.window.switchToSession;   // import 走 window.switchToSession（session.js 挂载）
  const prevSync = sandbox.window.syncFromServer;
  const prevFetch = sandbox.fetch;
  const calls = [];
  sandbox.window.switchToSession = async () => { calls.push('switch'); };
  sandbox.window.syncFromServer = async () => { calls.push('sync'); };
  sandbox.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
  };
  let ok = false;
  try {
    ok = await sandbox.window.importUtopiaSnapshotText(JSON.stringify(snapshot), 'demo.pmu');
  } finally {
    sandbox.window.switchToSession = prevSwitch;
    sandbox.window.syncFromServer = prevSync;
    sandbox.fetch = prevFetch;
  }
  if (ok !== true) throw new Error('导入应返回 true');
  const after = (() => { try { return JSON.parse(sandbox.localStorage.getItem('phymathia_sessions') || '{}'); } catch (e) { return {}; } })();
  const newIds = Object.keys(after).filter((k) => !(k in before));
  if (newIds.length !== 1) throw new Error('应恰好新建一个会话：' + newIds.length);
  const sid = newIds[0];
  if (after[sid].title !== '导入测试网') throw new Error('会话标题应取快照标题');
  const msgs = JSON.parse(sandbox.localStorage.getItem('phymathia_msgs_' + sid) || '[]');
  if (msgs.length !== 2) throw new Error('消息应完整落位');
  const gst = JSON.parse(sandbox.localStorage.getItem('phymathia_graph_' + sid) || 'null');
  if (!gst || gst.pan.x !== 5) throw new Error('图状态应完整落位');
  // 服务端三写 + 切换都发生
  if (!calls.some((c) => c.includes('/api/sessions')) || !calls.some((c) => c.includes('/messages'))
    || !calls.some((c) => c.includes('graph%3A') || c.includes('graph:'))) throw new Error('服务端三写缺失：' + JSON.stringify(calls));
  if (!calls.includes('switch')) throw new Error('导入后应切换到新画布');
  // 收尾：清掉测试会话，不污染后续用例
  delete after[sid];
  sandbox.localStorage.setItem('phymathia_sessions', JSON.stringify(after));
  sandbox.localStorage.removeItem('phymathia_msgs_' + sid);
  sandbox.localStorage.removeItem('phymathia_graph_' + sid);
  return true;
});
}
