// 串行边界：发送排队（T42）＋画布多选批量删除＋answer 节点预览公式定界（尾部含收口线；answer 段与队列收口共用了 sq/ms 句柄，故同文件）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 6627–7457 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
// ===== 串行边界追加：发送排队（T42）=====
// 2026-09-27：AI 忙时点发送，过去一律是裸 `if (正在生成) return;`——不提示、不置灰、
// 不留痕。免费模型一次工作流 2-8 分钟，这个忙窗口长得离谱，用户只会以为按钮坏了。
// 现在改成排队：当场收下、跑完自动发。下面分行为与静态契约两半：
// 行为半守住「不丢、不并发」，静态半守住「反馈层不许被悄悄改回去」。

// 行为半。队列模块只依赖 toastMsg / _renderQueueChip 和两个忙碌标志位，隔离得干净，
// 可以在本沙箱里真跑。忙碌位是 app.js 里的顶层 let 词法绑定，外部摸不到，
// 只能经 vm.runInContext 读写（与本文件既有做法一致）。
//
// 这三条共享 isStreaming / _sendQueue 两个词法绑定，而 check() 的异步用例是靠
// Promise.all 一起等跑的——并发会互相踩状态（一条把 isStreaming 置 false 会让另一条
// 提前放行）。所以走自己的串行链，不能用 check()。
const sqEval = (code) => vm.runInContext(code, sandbox);
const sqReset = () => {
  sqEval('_sendQueue = []; _sendQueueFlushing = false;');
  sqEval('isStreaming = false;');
  sqEval('workflowRunActive = false;');
};
const sqChecks = [];
let sqTail = Promise.resolve();
const checkSq = (name, fn) => {
  // 内层 try/catch 保证链条永不 reject，前一条挂掉不会连累后面几条
  sqTail = sqTail.then(async () => {
    try {
      const r = await fn();
      if (r === false) throw new Error('断言未通过');
      console.log('✓', name);
    } catch (e) {
      addFailed();
      console.error('❌', name, '->', e.message);
    }
  });
  sqChecks.push(sqTail);
};

checkSq('发送排队：AI 忙时收下但不发出，空闲后自动发出', async () => {
  sqReset();
  sqEval('isStreaming = true;');
  sqEval("__fired = 0;");
  sqEval("_enqueueSend('苏格拉底回答', function(){ __fired++; return Promise.resolve(); })");
  if (!sqEval('_hasPendingSend()')) throw new Error('忙碌时点发送没有收进队列——请求被丢弃了（T42 的原始症状）');
  if (sqEval('__fired') !== 0) throw new Error('收队时就把请求发了出去，会与在途的回答并发');
  // 还在忙：显式 flush 必须什么都不做
  await sqEval('_flushSendQueue()');
  if (sqEval('__fired') !== 0) throw new Error('AI 还在生成，flush 却把队列放了出去');
  sqEval('isStreaming = false;');
  await sqEval('_flushSendQueue()');
  if (sqEval('__fired') !== 1) throw new Error('空闲后没有自动发出，收到 ' + sqEval('__fired'));
  if (sqEval('_hasPendingSend()')) throw new Error('已发出但队列没清空');
});

checkSq('发送排队：两条请求必须依次发出，不能并发挤进同一个发送锁', async () => {
  sqReset();
  // 本沙箱 setTimeout 是 () => 0 的桩，不会真的延后，所以用一道手动闸门来证明
  // 「B 在 A 结束前没跑」——这正是要挡的失败模式：并发发会挤进同一个发送锁。
  sqEval(`
    __log = [];
    _enqueueSend('追问', function(){
      __log.push('A:start');
      return new Promise(function(res){
        __releaseA = function(){ __log.push('A:end'); res(); };
      });
    });
    _enqueueSend('提问', function(){ __log.push('B'); return Promise.resolve(); });
  `);
  sqEval('isStreaming = false;');
  const flushing = sqEval('_flushSendQueue()');
  await new Promise((r) => setImmediate(r));
  const midLog = sqEval("__log.join(',')");
  if (midLog !== 'A:start') throw new Error('第一条没有先发起来，实际：' + midLog);
  if (sqEval("__log.indexOf('B') >= 0")) {
    throw new Error('B 在 A 还没结束时就发了——两条会撞进同一个发送锁（' + midLog + '）');
  }
  sqEval('__releaseA()');
  await flushing;
  if (sqEval("__log.join(',')") !== 'A:start,A:end,B') {
    throw new Error('A 结束后 B 没有接上去，实际：' + sqEval("__log.join(',')"));
  }
});

checkSq('发送排队：workflowRunActive 也算忙（startQuestionWorkflow 过去查错了标志位）', async () => {
  // 旧守卫只查 isStreaming，而工作流全程不碰 isStreaming（它走 _generateAnalysis →
  // proxyChat，不经过 sendMessage），于是「提问」按钮在工作流跑着时形同虚设，
  // 能并发开出第二个工作流、两棵节点树打架。这条把「工作流也算忙」钉死。
  sqReset();
  sqEval('workflowRunActive = true;');
  sqEval('__wf = 0;');
  sqEval("_enqueueSend('提问', function(){ __wf++; return Promise.resolve(); })");
  if (sqEval('_isSendBusy()') !== true) throw new Error('工作流运行时没有被判为忙');
  await sqEval('_flushSendQueue()');
  if (sqEval('__wf') !== 0) throw new Error('工作流还在跑，flush 却放行了');
  sqEval('workflowRunActive = false;');
  await sqEval('_flushSendQueue()');
  if (sqEval('__wf') !== 1) throw new Error('工作流结束后没有自动发出');
});

// 静态半。这些护栏全删掉也不会让上面任何一条行为断言变红——只能靠读源码钉住。
// 变异验证：把任一发送入口改回裸 `if (isStreaming…) return;`，或把 startQuestionWorkflow
// 的判定改回只查 isStreaming，下面立刻红。
check('发送排队：发送入口不允许再出现裸 isStreaming 守卫（T42 反馈层不许被改回去）', () => {
  // 按函数名抽函数体（花括号配平），**不**整文件扫：chat-branch.js 里
  // deleteGraphMessageByTimestamp 那两处 `if (isStreaming)` 不是发送入口——生成中
  // 删消息的语义是「中止当前生成、事后补删」，本来就有动作也不是静默 return，
  // 整文件扫会误伤。marker 用来自检「确实抽到了完整函数体」，防止配平抽残后漏判。
  const extract = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let j = src.indexOf('{', i); j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; }
      else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j); }
    }
    return null;
  };
  const entries = [
    ['chat.js', 'sendMessage', '_flushSendQueue'],
    ['chat-branch.js', 'submitSocraticAnswer', '_enqueueSend'],
    ['chat-branch.js', 'submitBranchModal', '_enqueueSend'],
    ['chat-branch.js', 'startSocraticHint', '_queueOrRunSocraticExit'],
    ['chat-branch.js', 'startSocraticExplain', '_queueOrRunSocraticExit'],
  ];
  for (const [file, fn, marker] of entries) {
    const src = fs.readFileSync('src/static/js/' + file, 'utf8');
    const body = extract(src, fn);
    if (body === null) throw new Error('找不到函数 ' + fn + '（' + file + '）——断言本身该更新了');
    if (!body.includes(marker)) {
      throw new Error('抽到的 ' + fn + ' 函数体不完整（缺 ' + marker + '），判定会漏——断言本身坏了');
    }
    if (/if \(isStreaming[^)]*\) return;/.test(body)) {
      throw new Error(file + ' 的 ' + fn + ' 又是裸 isStreaming 守卫：忙时会静默吞掉请求，'
        + '用户只会以为按钮坏了（docs/backlog.md T42）');
    }
  }
  // startQuestionWorkflow 必须走统一忙碌判定
  const wf = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  const wfBody = extract(wf, 'startQuestionWorkflow');
  if (wfBody === null) throw new Error('找不到 startQuestionWorkflow');
  if (!wfBody.includes('removeDraftNode')) {
    throw new Error('抽到的 startQuestionWorkflow 函数体不完整，判定会漏——断言本身坏了');
  }
  if (!/_isSendBusy\(\)/.test(wfBody)) {
    throw new Error('startQuestionWorkflow 没用统一的 _isSendBusy()——工作流通道又变回形同虚设');
  }
  if (/if \(typeof isStreaming !== 'undefined' && isStreaming\) return;/.test(wfBody)) {
    throw new Error('startQuestionWorkflow 又只查 isStreaming 了：工作流不碰这个标志位，守卫会失效');
  }
});

// 静态契约（T205）：一轮回答只允许两次全量画布重建——发送（用户问题卡落画布）与成功
// （流式补丁态同步成终态）。finally 的第三发在成功路径是零差异重复（两次调用之间
// _getChatHistory 输入相同），已改「成功记标志、finally 未渲染才兜底」；失败/中止/空回复
// 路径仍靠 finally 摘残留流式卡。变异验证：把 finally 的守卫拆掉改回无条件渲染，下面立刻红。
check('发送链画布重建（T205）：成功路径记标志，finally 只兜未渲染路径', () => {
  const src = fs.readFileSync('src/static/js/chat.js', 'utf8');
  if (!/let canvasRenderedThisRound = false;/.test(src)) throw new Error('缺本轮已渲染标志声明（T205 修复被拆）');
  if (!/renderGraphCanvas\(\); canvasRenderedThisRound = true;/.test(src)) {
    throw new Error('成功路径渲染没有记 canvasRenderedThisRound——一轮回答回到三连全量重建');
  }
  if (!/!canvasRenderedThisRound && typeof window\.renderGraphCanvas === 'function'\) window\.renderGraphCanvas\(\);/.test(src)) {
    throw new Error('finally 渲染丢了「未渲染才兜底」守卫——成功路径会多吃一次全量重建（innerHTML 清空＋全节点 KaTeX 重跑）');
  }
  return true;
});

check('发送排队：模块已注册进构建顺序，且「待发送 N」标记挂在进度胶囊上', () => {
  const build = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  if (!/'send-queue\.js'/.test(build)) {
    throw new Error("build_frontend.mjs 的顺序表里没有 'send-queue.js'——页面加载的 app.js 根本不含排队逻辑");
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const m = html.match(/<button[^>]*id="sendQueueChip"[^>]*>/);
  if (!m) throw new Error('index.html 里没有 id="sendQueueChip" 的元素——用户看不到待发送几条');
  const capsule = html.slice(html.indexOf('id="progressStatus"'), html.indexOf('id="progressStatus"') + 2000);
  if (!capsule.includes('sendQueueChip')) {
    throw new Error('sendQueueChip 没挂在 #progressStatus 胶囊里——用户盯着等的时候看不到它');
  }
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!css.includes('.progress-status .send-queue-chip')) {
    throw new Error('styles.css 里没有 .send-queue-chip 规则——标记会是个没样式的裸按钮');
  }
});

// ===== 串行边界追加：画布多选与批量删除（2026-09-30）=====
// 多选改的是模块级 sessions / currentSessionId 词法绑定，还会 await 一串 fetch、
// 写共享的 phymathia_sessions 与 phymathia_msgs_*/graph_* 键——与在途异步用例互踩，
// 走自己的串行链（同发送排队那套）。
const msEval = (code) => vm.runInContext(code, sandbox);
let msTail = Promise.resolve();
const checkMs = (name, fn) => {
  msTail = msTail.then(async () => {
    try {
      const r = await fn();
      if (r === false) throw new Error('断言未通过');
      console.log('✓', name);
    } catch (e) {
      addFailed();
      console.error('❌', name, '->', e.message);
    }
  });
};

// 下游全是函数声明（是 globalThis 的属性，可以整体替换还原），
// 知识/公式面板在宽松 DOM 代理下会走进未覆盖的渲染路径，这里换成记账桩。
const msCalls = [];
function msIsolate() {
  const saved = {};
  const stub = (name, fn) => { saved[name] = sandbox[name]; sandbox[name] = fn; };
  stub('invalidateKnowledgeCache', () => msCalls.push('invalidate'));
  stub('renderKnowledgePanel', () => msCalls.push('renderKp'));
  stub('loadFormulas', () => msCalls.push('loadFormulas'));
  stub('deleteKnowledgeBySession', async (sid) => { msCalls.push('know:' + sid); });
  stub('deleteFormulasBySession', async (sid) => { msCalls.push('formula:' + sid); });
  stub('switchToSession', async (sid) => { msCalls.push('switch:' + sid); });
  stub('createNewSession', () => { msCalls.push('create'); });
  stub('showToast', (msg) => { msCalls.push('toast:' + msg); });
  stub('_deleteOnServer', async () => { msCalls.push('srvDel'); return true; });
  stub('_saveSessionToServer', async (sid) => { msCalls.push('upsert:' + sid); });
  const prevPhi = sandbox.window.phiCanvasDeleted;
  sandbox.window.phiCanvasDeleted = (sid) => { msCalls.push('phi:' + sid); };
  // 元素注册表：宽松代理每次 getElementById 都返回新对象，量不到属性。
  // 只接管多选相关的 5 个 id，其余一律转交原实现——发送排队那条链与本节并发跑，
  // 它要靠真 getElementById 拿到 loose 元素。
  const els = {};
  const prevGet = sandbox.document.getElementById;
  const OWNED = new Set(['sessionList', 'sessionBulkBar', 'sessionBulkCount', 'sessionBulkDeleteBtn', 'sessionMultiSelectBtn']);
  const myGet = (id) => {
    if (!OWNED.has(id)) return prevGet(id);
    if (!els[id]) {
      els[id] = {
        innerHTML: '', hidden: true, textContent: '', disabled: false, className: '',
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      };
    }
    return els[id];
  };
  sandbox.document.getElementById = myGet;
  return {
    els,
    restore() {
      for (const k of Object.keys(saved)) sandbox[k] = saved[k];
      sandbox.window.phiCanvasDeleted = prevPhi;
      // 只在还是自己的时候还原：并发用例可能已经换上了它们的实现
      if (sandbox.document.getElementById === myGet) sandbox.document.getElementById = prevGet;
      // 交还词法状态：在途的并发用例还在用同一个 sessions 名单
      msEval('sessions = __msPrevSessions; currentSessionId = __msPrevCurrent; _sessionMultiSelect = false; _sessionSelected.clear();');
    },
  };
}

checkMs('画布多选：进入多选 → 勾选 → 批量删除（逐条走单删主路径，名单只写一次）', async () => {
  const iso = msIsolate();
  try {
    // isStreaming 是词法绑定，在途的并发用例会把它置位；会话管理用例与它无关，显式归零
    msEval('__msPrevSessions = sessions; __msPrevCurrent = currentSessionId; isStreaming = false;');
    msEval('sessions = { s1:{id:"s1",title:"甲",updatedAt:9}, s2:{id:"s2",title:"乙",updatedAt:8}, s3:{id:"s3",title:"丙",updatedAt:7}, s4:{id:"s4",title:"丁",updatedAt:6} }; currentSessionId = "s2"; _sessionMultiSelect = false; _sessionSelected.clear();');
    sandbox.toggleSessionMultiSelect();
    if (msEval('_sessionMultiSelect') !== true) throw new Error('没进多选态');
    if (iso.els.sessionBulkBar.hidden !== false) throw new Error('批量操作条没露出来——用户进多选却无处操作');
    if (iso.els.sessionBulkCount.textContent !== '已选 0 / 4') throw new Error('计数不对：' + iso.els.sessionBulkCount.textContent);
    if (!iso.els.sessionList.innerHTML.includes('multi-select-item')) throw new Error('列表没渲染成多选形态（缺复选框行）');

    sandbox.toggleSessionSelect('s1');
    sandbox.toggleSessionSelect('s3');
    if (iso.els.sessionBulkCount.textContent !== '已选 2 / 4') throw new Error('勾选计数没跟上：' + iso.els.sessionBulkCount.textContent);
    if (!iso.els.sessionList.innerHTML.includes('picked')) throw new Error('选中态没画出来');
    // 再次点击同一行＝取消勾选
    sandbox.toggleSessionSelect('s1');
    if (iso.els.sessionBulkCount.textContent !== '已选 1 / 4') throw new Error('取消勾选没生效');
    sandbox.toggleSessionSelect('s1');

    sandbox.selectAllSessions();
    if (iso.els.sessionBulkCount.textContent !== '已选 4 / 4') throw new Error('全选没生效');
    sandbox.clearSessionSelection();
    if (iso.els.sessionBulkCount.textContent !== '已选 0 / 4') throw new Error('清除没生效');
    if (iso.els.sessionBulkDeleteBtn.disabled !== true) throw new Error('没勾选时删除钮应置灰');

    // 逐条清理的证据：被删画布的本地消息/画布键必须真的消失
    for (const id of ['s1', 's3']) {
      sandbox.localStorage.setItem('phymathia_msgs_' + id, '[{"role":"user"}]');
      sandbox.localStorage.setItem('phymathia_graph_' + id, '{"positions":{}}');
    }
    msCalls.length = 0;
    sandbox.toggleSessionSelect('s1');
    sandbox.toggleSessionSelect('s3');
    await sandbox.deleteSelectedSessions();

    if (msEval('Object.keys(sessions).sort().join(",")') !== 's2,s4') {
      throw new Error('批量删完后名单应为 s2,s4，实际 ' + msEval('Object.keys(sessions).join(",")'));
    }
    for (const id of ['s1', 's3']) {
      if (sandbox.localStorage.getItem('phymathia_msgs_' + id) !== null) throw new Error(id + ' 的本地消息没清掉');
      if (sandbox.localStorage.getItem('phymathia_graph_' + id) !== null) throw new Error(id + ' 的本地画布状态没清掉');
    }
    if (!msCalls.includes('know:s1') || !msCalls.includes('formula:s3')) throw new Error('知识/公式清理没逐条走主路径');
    if (msCalls.filter(c => c === 'invalidate').length !== 1) throw new Error('面板刷新应只做一次，实际 ' + msCalls.filter(c => c === 'invalidate').length);
    // saveSessions 收成一次：剩下的两个画布各 upsert 一次（逐条调用会是 3 次）
    if (msCalls.filter(c => c.startsWith('upsert:')).length !== 2) {
      throw new Error('名单应只整体写一次，实际 upsert ' + msCalls.filter(c => c.startsWith('upsert:')).length + ' 次');
    }
    if (!msCalls.some(c => c.startsWith('toast:已删除 2 个画布'))) throw new Error('没有完成提示：' + msCalls.filter(c => c.startsWith('toast:')));
    // 没选当前画布就不该切换
    if (msCalls.some(c => c.startsWith('switch:'))) throw new Error('没删当前画布却切了会话');
    if (msEval('_sessionMultiSelect') !== false) throw new Error('全删成功应自动退出多选态');
  } finally {
    iso.restore();
  }
});

checkMs('画布多选：选中里含当前画布 → 删完自动落到最近的一个', async () => {
  const iso = msIsolate();
  try {
    // isStreaming 是词法绑定，在途的并发用例会把它置位；会话管理用例与它无关，显式归零
    msEval('__msPrevSessions = sessions; __msPrevCurrent = currentSessionId; isStreaming = false;');
    msEval('sessions = { s1:{id:"s1",title:"甲",updatedAt:9}, s2:{id:"s2",title:"乙",updatedAt:8}, s3:{id:"s3",title:"丙",updatedAt:7} }; currentSessionId = "s2"; _sessionMultiSelect = true; _sessionSelected.clear();');
    msCalls.length = 0;
    sandbox.toggleSessionSelect('s2');
    sandbox.toggleSessionSelect('s3');
    await sandbox.deleteSelectedSessions();
    if (msCalls.filter(c => c.startsWith('switch:')).length !== 1) throw new Error('删掉当前画布后应只切一次会话');
    if (msCalls.includes('switch:s2')) throw new Error('切向了已被删掉的画布');
    if (msCalls.filter(c => c.startsWith('srvDel')).length !== 2) throw new Error('服务端删除应逐条发一次，实际 ' + msCalls.filter(c => c.startsWith('srvDel')).length);
  } finally {
    iso.restore();
  }
});

checkMs('画布多选：服务端删失败的画布保留勾选并可重试，不误报全清', async () => {
  const iso = msIsolate();
  try {
    // isStreaming 是词法绑定，在途的并发用例会把它置位；会话管理用例与它无关，显式归零
    msEval('__msPrevSessions = sessions; __msPrevCurrent = currentSessionId; isStreaming = false;');
    msEval('sessions = { s1:{id:"s1",title:"甲",updatedAt:9}, s2:{id:"s2",title:"乙",updatedAt:8} }; currentSessionId = "s1"; _sessionMultiSelect = true; _sessionSelected.clear();');
    // 服务端在线，但只有 s1 的 DELETE 失败（混合结局：一条成一条败）
    sandbox._deleteOnServer = async (url) => !String(url).includes('s1');
    msEval('_serverAvailable = true; _serverAvailableCheckedAt = Date.now();');
    msCalls.length = 0;
    sandbox.toggleSessionSelect('s1');
    sandbox.toggleSessionSelect('s2');
    await sandbox.deleteSelectedSessions();
    if (msEval('Object.keys(sessions).join(",")') !== 's1') throw new Error('只有 s2 该被删，实际剩 ' + msEval('Object.keys(sessions).join(",")'));
    if (msEval('Array.from(_sessionSelected).join(",")') !== 's1') throw new Error('失败的画布应保留勾选供重试');
    if (msEval('_sessionMultiSelect') !== true) throw new Error('有失败项时不该退出多选态');
    if (!msCalls.some(c => c.includes('已删除 1 个，1 个失败'))) throw new Error('没有提示部分失败：' + msCalls.filter(c => c.startsWith('toast:')));
  } finally {
    msEval('_serverAvailable = null; _serverAvailableCheckedAt = 0;');
    iso.restore();
  }
});

// 静态契约：入口、样式、单删/批删同源，防「多选另起一套删除口径」回退
check('画布多选：入口与样式在位，且单删/批删共用同一条删除内核', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="sessionMultiSelectBtn"') || !html.includes('toggleSessionMultiSelect()')) {
    throw new Error('侧栏没有多选开关——用户找不到入口');
  }
  for (const id of ['sessionBulkBar', 'sessionBulkCount', 'sessionBulkDeleteBtn']) {
    if (!html.includes(`id="${id}"`)) throw new Error(`index.html 缺批量操作条元素 #${id}`);
  }
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  for (const sel of ['.session-bulk-bar', '.session-item.multi-select-item .session-check', '.sidebar-multiselect-btn']) {
    if (!css.includes(sel)) throw new Error(`styles.css 缺 ${sel} 规则——控件会没样式`);
  }
  if (!css.includes('.session-bulk-bar[hidden]')) {
    throw new Error('批量条没写 [hidden] 兜底——display:flex 会盖掉 hidden 属性，退出多选后仍常驻');
  }
  const src = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (!src.includes('async function _purgeSessionData(id)')) throw new Error('删除内核不存在');
  if (!src.includes('const r = await _purgeSessionData(id);')) throw new Error('单删/批删没有共用同一条删除内核（两条路径会分叉）');
  return true;
});

// ===== answer 节点预览公式定界（2026-10-03）=====
// answer 卡正文/标签走纯文本路径（escapeHtml 直出，不经 renderMarkdown），
// <formula> 标签必须在 _nodeContent/label 渲染处转成 $..$，否则画布上原样露出。
// 纯同步纯函数（不碰共享键、不 await），追加在任意位置安全。
check('answer 节点预览：<formula> 标签转 $..$ 定界（消息路径＋override 路径）', () => {
  const node = { id: 'a1', kind: 'answer', messageIndex: 0, timestamp: 1 };
  const msg = { role: 'assistant', content: '结论正确：<formula>\\omega=\\sqrt{k/m}</formula>，其中 <formula>k/m</formula> 变小，再由 <formula>T=2\\pi\\sqrt{m/k}</formula> 得周期加倍。' };
  sandbox.window.getGraphState = () => ({});
  const out = sandbox._nodeContent(msg, node);
  if (out.includes('<formula')) throw new Error('预览仍含 <formula> 标签：' + out.slice(0, 80));
  if (!out.includes('$\\omega=\\sqrt{k/m}$')) throw new Error('公式未转 $..$ 定界：' + out.slice(0, 80));
  // 区块标签照旧剥掉；<summary> 优先且里面的公式也转好
  const node2 = { id: 'a2', kind: 'answer', messageIndex: 0, timestamp: 2 };
  const msg2 = { role: 'assistant', content: '<physics>视角正文</physics><summary>核心：<formula>F=-kx</formula> 与 <formula>\\omega^2=k/m</formula></summary>' };
  const out2 = sandbox._nodeContent(msg2, node2);
  if (!out2.startsWith('核心：')) throw new Error('summary 应优先：' + out2.slice(0, 40));
  if (out2.includes('<formula') || out2.includes('<physics>')) throw new Error('标签残留：' + out2);
  if (!out2.includes('$F=-kx$')) throw new Error('summary 内公式未转定界：' + out2);
  // override（Φ 改图/追问重写）路径同样转定界＋截断
  sandbox.window.getGraphState = () => ({ harnessNodeOverrides: { a3: { content: '重写内容 <formula>\\frac{k}{2}</formula>' + '长'.repeat(300) } } });
  const node3 = { id: 'a3', kind: 'answer', messageIndex: 0, timestamp: 3 };
  const out3 = sandbox._nodeContent({ role: 'assistant', content: '旧内容' }, node3);
  if (out3.includes('<formula')) throw new Error('override 路径标签残留');
  if (!out3.includes('$\\frac{k}{2}$')) throw new Error('override 路径未转定界：' + out3.slice(0, 60));
  if (!out3.endsWith('...') || out3.length > 246) throw new Error('override 路径应截 240 字：len=' + out3.length);
  sandbox.window.getGraphState = () => ({});
  return true;
});

check('answer 节点预览：截断落在公式半截时回退到上一个 $ 前，不留未配对 $', () => {
  // 开标签 $ 压在 240 字截断线上（235 起，闭 $ 落在 240 外）：回退后公式整体让出，$ 配对
  const long = '前'.repeat(235) + '$E=mc^2$ 之后还有很长的说明文字'.padEnd(300, '补充说明');
  const out = sandbox._graphAnswerPreview(long);
  const body = out.replace(/\.\.\.$/, '');
  if (body.includes('$')) throw new Error('回退后不应残留 $：' + body.slice(-40));
  if (!out.endsWith('...')) throw new Error('超长应带省略号：' + out.slice(-20));
  if (body.length > 240) throw new Error('回退后应 ≤240 字：' + body.length);
  const short = sandbox._graphAnswerPreview('短文本 $a^2+b^2=c^2$ 完');
  if (short !== '短文本 $a^2+b^2=c^2$ 完') throw new Error('短文本应原样：' + short);
  return true;
});

check('answer 卡展开全文：可展开判定＋预览/展开两态渲染接线', () => {
  const longText = '你的结论完全正确。' + '既然你自评把握一般，那就把这个结论钉在物理图像里，别停在代数上。'.repeat(8)
    + '<socratic_meta correct="correct" done="false" />';
  const node = { id: 'a9', kind: 'answer', messageIndex: 0, timestamp: 9 };
  const msg = { role: 'assistant', content: longText, timestamp: 9 };
  sandbox.window.getGraphState = () => ({});
  if (!sandbox._graphAnswerExpandable(node, msg)) throw new Error('长 socratic 文应可展开');
  if (sandbox._graphAnswerExpandable(node, { role: 'assistant', content: '<summary>核心</summary>' + longText, timestamp: 9 })) throw new Error('有 summary 不应给展开（summary 整段直出）');
  if (sandbox._graphAnswerExpandable({ ...node, messageIndex: -1 }, msg)) throw new Error('自定义节点不应给展开');
  if (sandbox._graphAnswerExpandable({ ...node, manual: true }, msg)) throw new Error('manual 节点不应给展开');
  if (sandbox._graphAnswerExpandable(node, { role: 'assistant', content: '短回答', timestamp: 9 })) throw new Error('短文不应给展开');
  // 渲染接线（renderMarkdown 换桩：这里只验两态结构，不验渲染内部）
  const realRM = sandbox.renderMarkdown;
  sandbox.renderMarkdown = (t) => 'RM(' + String(t).length + ')';
  try {
    const collapsed = sandbox._renderNodeHtml(node, [msg], {});
    if (!collapsed.includes('展开全文')) throw new Error('预览态缺展开按钮');
    if (collapsed.includes('>收起')) throw new Error('预览态不应出收起');
    const expanded = sandbox._renderNodeHtml(node, [msg], { expandedAnswers: { a9: true } });
    if (!expanded.includes('>收起')) throw new Error('展开态缺收起按钮');
    if (!expanded.includes('graph-node-full-content')) throw new Error('展开态缺正文区');
    if (!expanded.includes('RM(')) throw new Error('展开态正文没走 renderMarkdown');
    if (expanded.includes('class="graph-node-label"')) throw new Error('展开态不应再出预览 label');
    // 折叠卡不给按钮、不出正文
    const minimized = sandbox._renderNodeHtml({ ...node, minimized: true }, [msg], { expandedAnswers: { a9: true } });
    if (minimized.includes('展开全文') || minimized.includes('>收起')) throw new Error('折叠卡不应出展开按钮');
  } finally {
    sandbox.renderMarkdown = realRM;
    sandbox.window.getGraphState = () => ({});
  }
  return true;
});

check('socratic 反馈卡剥建议追问：预览/展开都不再重复，派生解析仍吃原文', () => {
  // 真机取样的格式：正文 → 空行 → 1. [基础]…2. [进阶]…3. [拓展]… → 空行 → <socratic_meta/>
  const feedback = '你的判断完全正确——我们把它再往下压实一层。\n\n'
    + '1. [基础] 请你把「线性」说得再具体一点：固定一点后满足哪两条性质才叫线性？\n'
    + '2. [进阶] 取极坐标下的温度场沿角方向的导数要乘以 1/r，这说明「那个固定矢量」还依赖什么结构？\n'
    + '3. [拓展] 如果换成斜交基，「同一个物理矢量」的意义在哪一层上保持不变？\n\n'
    + '<socratic_meta correct="correct" done="false" />';
  const msg = { role: 'assistant', content: feedback, timestamp: 11, branchType: 'socratic' };
  const node = { id: 'a11', kind: 'answer', messageIndex: 0, timestamp: 11 };
  sandbox.window.getGraphState = () => ({});
  const preview = sandbox._nodeContent(msg, node);
  if (preview.includes('说得再具体') || preview.includes('斜交基') || preview.includes('socratic_meta')) throw new Error('预览不应含建议追问/meta：' + preview);
  if (!preview.includes('压实一层')) throw new Error('预览应保留反馈正文：' + preview);
  const raw = sandbox._graphAnswerExpandRaw(node, msg);
  if (raw.includes('[基础]') || raw.includes('socratic_meta')) throw new Error('展开原文应剥追问块与 meta：' + raw);
  if (sandbox._graphAnswerExpandable(node, msg)) throw new Error('剥后正文 ≤240 不应再给展开开关');
  if (sandbox._parseSuggestedFollowupQuestions(feedback).length !== 3) throw new Error('派生解析仍应吃原文拿 3 问');
  // 剥除只认 socratic 反馈（branchType/socratic_meta），普通回答里的 [基础] 字样不剥
  const plain = sandbox._nodeContent({ role: 'assistant', content: '行内提法 [基础] 不该被剥', timestamp: 12 }, { id: 'a12', kind: 'answer', messageIndex: 0, timestamp: 12 });
  if (!plain.includes('[基础]')) throw new Error('非 socratic 消息不应剥：' + plain);
  return true;
});

check('_graphStripExtendDisplay：整段剥 <extend>（大小写/未闭合尾块/收尾空白/无 extend 原样）', () => {
  const closed = '正文甲\n\n<extend>\n### 苏格拉底追问\n\n- [基础] 问题？\n\n### 进阶学习方向\n\n- 方向一\n</extend>';
  const closedOut = sandbox._graphStripExtendDisplay(closed);
  if (closedOut !== '正文甲') throw new Error('闭合段未剥净：' + JSON.stringify(closedOut));
  const upper = '正文乙\n<EXTEND mode="m">\n### 进阶学习方向\n- 书目\n</Extend>\n\n';
  const upperOut = sandbox._graphStripExtendDisplay(upper);
  if (upperOut !== '正文乙') throw new Error('大小写/属性/尾空白未容错：' + JSON.stringify(upperOut));
  const unclosed = '正文丙\n<extend>\n### 苏格拉底追问\n- [基础] 问题？';
  const unclosedOut = sandbox._graphStripExtendDisplay(unclosed);
  if (unclosedOut !== '正文丙') throw new Error('未闭合尾块未剥：' + JSON.stringify(unclosedOut));
  const plain2 = '没有 extend 标签的正文';
  if (sandbox._graphStripExtendDisplay(plain2) !== plain2) throw new Error('无 extend 应原样');
  if (sandbox._graphStripExtendDisplay('') !== '') throw new Error('空串应原样');
  // 中缀闭合块被剥、块外正文保留
  const midOut = sandbox._graphStripExtendDisplay('前段\n<extend>\n内部\n</extend>\n\n后段');
  if (midOut.includes('内部')) throw new Error('中缀块未剥净：' + JSON.stringify(midOut));
  if (!midOut.includes('前段') || !midOut.includes('后段')) throw new Error('块外正文不应被波及：' + JSON.stringify(midOut));
  return true;
});

check('根 answer 卡剥 <extend> 整段：预览/展开都不再重复，msg.content 原文与模块派生照吃原文（T172）', () => {
  const rootIntro = '根回答正文：先把结论摆出来，再把推导逐层核对一遍。';
  const rootContent = rootIntro + '\n\n<extend>\n### 苏格拉底追问\n\n'
    + '- [基础] 为什么周期与振幅无关？\n- [进阶] 想让周期缩短一半，质量该怎么变？\n\n'
    + '### 进阶学习方向\n\n- 精读《力学》第三章简谐振动小节\n- 动手写一个单摆数值模拟\n</extend>';
  const msgs = [
    { role: 'user', content: '单摆周期为什么会随质量变化？', timestamp: 100 },
    { role: 'assistant', content: rootContent, timestamp: 200 },
  ];
  const data = sandbox._buildGraphData(msgs, {});
  const rootNode = data.nodes.find(n => n.kind === 'answer' && n.timestamp === 200);
  if (!rootNode) throw new Error('未构建根 answer 节点');
  if (!rootNode.isRootAnswer) throw new Error('首个主回答应标记 isRootAnswer（T172 判定依据）');
  sandbox.window.getGraphState = () => ({});
  const preview = sandbox._nodeContent(msgs[1], rootNode);
  for (const frag of ['苏格拉底追问', '进阶学习方向', '[基础]', '振幅', '精读', '单摆']) {
    if (preview.includes(frag)) throw new Error('根卡预览不应含 extend 段内容：「' + frag + '」→ ' + preview);
  }
  if (preview !== rootIntro) throw new Error('根卡预览应等于 extend 之外的正文，实际：' + preview);
  const raw = sandbox._graphAnswerExpandRaw(rootNode, msgs[1]);
  for (const frag of ['<extend', '苏格拉底追问', '进阶学习方向', '[基础]', '精读']) {
    if (raw.includes(frag)) throw new Error('根卡展开正文不应含 extend 段内容：「' + frag + '」');
  }
  if (raw !== rootIntro) throw new Error('根卡展开正文应等于 extend 之外的正文，实际：' + raw);
  // 只剥展示：msg.content 原文一字不动，socratic/learn 派生模块照常上画布
  if (msgs[1].content !== rootContent) throw new Error('msg.content 不应被改动');
  if (!msgs[1].content.includes('### 进阶学习方向') || !msgs[1].content.includes('单摆数值模拟')) throw new Error('msg.content 应保持完整 extend 段');
  const modKeys = data.nodes.filter(n => n.kind === 'module' && n.timestamp === 200).map(n => n.moduleKey);
  if (!modKeys.includes('socratic') || !modKeys.includes('learn')) throw new Error('socratic/learn 模块节点应照常派生（剥展示不影响派生），实际 ' + JSON.stringify(modKeys));
  // 剥后正文 ≤240 字且无 <summary>：不再给展开开关
  if (sandbox._graphAnswerExpandable(rootNode, msgs[1])) throw new Error('剥后短正文不应再给展开开关');
  return true;
});

check('根 answer 预览：240 字截断落在剥后正文上，extend 段不占预览窗口（T172）', () => {
  const longIntro = '推演核对。'.repeat(60); // 300 字 > 240：截断必须发生在剥后正文上
  const content = longIntro + '\n\n<extend>\n### 苏格拉底追问\n\n- [基础] 长卡的问题？\n\n### 进阶学习方向\n\n- 方向甲\n</extend>';
  const msgs = [
    { role: 'user', content: '核心问题？', timestamp: 1 },
    { role: 'assistant', content, timestamp: 2 },
  ];
  const data = sandbox._buildGraphData(msgs, {});
  const node = data.nodes.find(n => n.kind === 'answer' && n.timestamp === 2);
  if (!node || !node.isRootAnswer) throw new Error('根 answer 节点未标记');
  sandbox.window.getGraphState = () => ({});
  const preview = sandbox._nodeContent(msgs[1], node);
  if (preview !== longIntro.slice(0, 240) + '...') throw new Error('预览应为剥后正文前 240 字＋省略号，实际 ' + preview.length + ' 字：' + preview.slice(0, 20) + '…' + preview.slice(-20));
  if (preview.includes('苏格拉底') || preview.includes('方向甲')) throw new Error('extend 段不应进入预览窗口：' + preview.slice(-40));
  if (!sandbox._graphAnswerExpandable(node, msgs[1])) throw new Error('剥后正文仍 >240 字应保留展开开关');
  const raw = sandbox._graphAnswerExpandRaw(node, msgs[1]);
  if (raw !== longIntro) throw new Error('展开正文应只含 extend 之外正文（本夹具 extend 在尾）');
  return true;
});

check('根 answer 卡叠加剥口：extend 剥除与 socratic 尾部追问剥除互不干扰（T172）', () => {
  // 根卡同时是 socratic 反馈来源（内容带 socratic_meta＋尾部建议追问行）：extend 剥在外层，
  // 残余的尾部追问块仍由 _graphSocraticDisplayContent 剥——两条剥口各管一段、都不误伤正文
  const intro = '根回答正文：先把结论摆出来。';
  const content = intro + '\n\n'
    + '1. [基础] 尾部追问甲？\n2. [进阶] 尾部追问乙？\n\n'
    + '<socratic_meta correct="correct" done="false" />\n\n'
    + '<extend>\n### 进阶学习方向\n\n- 方向乙\n</extend>';
  const msgs = [
    { role: 'user', content: '核心？', timestamp: 300 },
    { role: 'assistant', content, timestamp: 400 },
  ];
  const data = sandbox._buildGraphData(msgs, {});
  const node = data.nodes.find(n => n.kind === 'answer' && n.timestamp === 400);
  if (!node || !node.isRootAnswer) throw new Error('根 answer 节点未标记');
  sandbox.window.getGraphState = () => ({});
  const preview = sandbox._nodeContent(msgs[1], node);
  for (const frag of ['追问甲', '追问乙', 'socratic_meta', '方向乙', '进阶学习方向']) {
    if (preview.includes(frag)) throw new Error('叠加剥口未同时生效：「' + frag + '」→ ' + preview);
  }
  if (preview !== intro) throw new Error('叠加剥后应只剩 extend 之外的正文，实际：' + preview);
  const raw = sandbox._graphAnswerExpandRaw(node, msgs[1]);
  if (raw !== intro) throw new Error('展开正文同样两条剥口叠加，实际：' + raw);
  return true;
});

check('非根 answer 卡同样剥 <extend>：预览/展开不再重复，msg.content 原文与模块派生照旧（T192 扩面）', () => {
  const rootContent = '根回答正文。\n\n<extend>\n### 苏格拉底追问\n\n- [基础] 根卡的追问？\n</extend>';
  const followIntro = '追问回答正文：这里只谈推导。';
  const followContent = followIntro + '\n\n<extend>\n### 进阶学习方向\n\n- 精读《力学》第三章\n</extend>';
  const msgs = [
    { role: 'user', content: '核心问题？', timestamp: 100 },
    { role: 'assistant', content: rootContent, timestamp: 200 },
    { role: 'user', content: '再追问一句', timestamp: 300 },
    { role: 'assistant', content: followContent, timestamp: 400 },
  ];
  const data = sandbox._buildGraphData(msgs, {});
  const rootNode = data.nodes.find(n => n.kind === 'answer' && n.timestamp === 200);
  const followNode = data.nodes.find(n => n.kind === 'answer' && n.timestamp === 400);
  if (!rootNode || !followNode) throw new Error('未构建两个 answer 节点');
  if (!rootNode.isRootAnswer) throw new Error('首个主回答应标记根卡');
  if (followNode.isRootAnswer) throw new Error('第二个主回答不应标记根卡');
  sandbox.window.getGraphState = () => ({});
  // T192 扩面（2026-10-08 用户拍板）：剥除从根卡扩到全部 answer 卡，非根卡同样不再重复渲染 extend 段
  const followPreview = sandbox._nodeContent(msgs[3], followNode);
  if (followPreview !== followIntro) {
    throw new Error('非根卡预览应只含 extend 之外的正文（T192 扩面）：' + followPreview);
  }
  const followRaw = sandbox._graphAnswerExpandRaw(followNode, msgs[3]);
  if (followRaw !== followIntro) throw new Error('非根卡展开正文应剥掉 extend 段（T192 扩面）：' + followRaw);
  // 只剥展示：msg.content 原文一字不动
  if (msgs[3].content !== followContent) throw new Error('msg.content 不应被改动');
  // 剥展示不影响派生：非根卡自己的 learn 模块节点照常上画布（被剥内容在模块节点仍可达）
  const followMods = data.nodes.filter(n => n.kind === 'module' && n.timestamp === 400).map(n => n.moduleKey);
  if (!followMods.includes('learn')) throw new Error('非根卡的 learn 模块应照常派生（剥展示不影响派生）');
  return true;
});

check('非根 answer 卡展开全文观感：展开正文不含苏格拉底追问/进阶学习方向重复段标记（T192 扩面）', () => {
  // 长正文（剥后 >240 字）展开开关保留；展开后读者看到干净正文——<extend> 里
  // 「### 苏格拉底追问」「### 进阶学习方向」两段重复标记一个不剩（模块节点已各自成卡）
  const longFollow = '追问回答正文：这里把推导逐层展开核对。'.repeat(20); // 380 字 > 240
  const content = longFollow + '\n\n<extend>\n### 苏格拉底追问\n\n'
    + '- [基础] 为什么斜面上摩擦力做功取负？\n\n'
    + '### 进阶学习方向\n\n- 精读《力学》第三章摩擦力小节\n- 动手推导斜面自锁条件\n</extend>';
  const msgs = [
    { role: 'user', content: '核心问题？', timestamp: 500 },
    { role: 'assistant', content: '根回答。', timestamp: 600 },
    { role: 'user', content: '再问一层', timestamp: 700 },
    { role: 'assistant', content, timestamp: 800 },
  ];
  const data = sandbox._buildGraphData(msgs, {});
  const followNode = data.nodes.find(n => n.kind === 'answer' && n.timestamp === 800);
  if (!followNode || followNode.isRootAnswer) throw new Error('第二张主回答卡应为非根卡');
  sandbox.window.getGraphState = () => ({});
  if (!sandbox._graphAnswerExpandable(followNode, msgs[3])) throw new Error('剥后正文 >240 字应保留展开全文开关');
  const raw = sandbox._graphAnswerExpandRaw(followNode, msgs[3]);
  for (const frag of ['<extend', '苏格拉底追问', '进阶学习方向', '[基础]', '精读', '自锁']) {
    if (raw.includes(frag)) throw new Error('非根卡展开正文不应含重复段标记：「' + frag + '」');
  }
  if (raw !== longFollow) throw new Error('非根卡展开正文应只剩 extend 之外的正文，实际：' + raw.slice(0, 30) + '…');
  const preview = sandbox._nodeContent(msgs[3], followNode);
  if (preview.includes('进阶学习方向') || preview.includes('苏格拉底追问')) throw new Error('预览同样不应含重复段：' + preview.slice(-40));
  if (msgs[3].content !== content) throw new Error('msg.content 原文不应被改动');
  return true;
});

check('sq 派生追问节点：复用 customNodes 自定义模块链路＋作答链挂到追问节点下＋墓碑防复活', () => {
  const feedback = '判断：理解正确 你抓住了关键。\n\n1. [基础] 先不用公式，复述一遍：为什么质量越大周期越长？\n2. [进阶] 想让周期缩短一半，质量应该变成多少倍？\n\n<socratic_meta correct="correct" done="false" />';
  const qs = sandbox._parseSuggestedFollowupQuestions(feedback);
  if (qs.length !== 2) throw new Error('应解析出 2 问，实际 ' + qs.length);
  if (qs[0].level !== 'basic' || qs[1].level !== 'advanced') throw new Error('等级解析错：' + JSON.stringify(qs));
  if (sandbox._parseSuggestedFollowupQuestions('正文里出现 基础：这种裸前缀不算').length !== 0) throw new Error('裸前缀不应误匹配（须方括号标签）');
  const msgs = [
    { role: 'user', content: '核心问题', timestamp: 100 },
    { role: 'assistant', content: feedback, timestamp: 200, branchType: 'socratic', parentId: '100' },
    { role: 'user', content: '[苏格拉底回答] 追问等级：基础 追问问题：为什么？\n我的回答：因为。', timestamp: 300, branchType: 'socratic', parentId: '200' },
  ];
  const st = {};
  const data = sandbox._buildGraphData(msgs, st);
  const sq = data.nodes.find(n => n.kind === 'module' && n.moduleKey === 'socratic' && n.sqAuto);
  if (!sq) throw new Error('未派生苏格拉底追问节点（应落 customNodes 走 module 链路）');
  if (sq.messageIndex !== -1) throw new Error('sq 应按自定义节点实体化（messageIndex=-1）');
  if (!Array.isArray(sq.items) || sq.items.length !== 2) throw new Error('sq 节点问题数错');
  if (!/- \[基础\] 先不用公式/.test(sq.content)) throw new Error('sq.content 应是同款 markdown 问题列表');
  const cn = (st.customNodes || []).find(item => item.id === sq.id);
  if (!cn) throw new Error('customNodes 里没有 sq 条目（编辑/删除无依托）');
  if (!(st.connections || []).find(e => e.from === 'a-200' && e.to === sq.id)) throw new Error('sq 未连到反馈回答节点（connections 缺边）');
  const userNode = data.nodes.find(n => n.kind === 'user' && n.timestamp === 300);
  const userEdge = data.edges.find(e => e.to === userNode.id);
  if (!userEdge || userEdge.from !== sq.id) throw new Error('用户作答节点应挂在追问节点下，实际 from=' + (userEdge && userEdge.from));
  // 同一 state 再建一次：条目幂等（不重复落地），节点照常实体化
  const data1b = sandbox._buildGraphData(msgs, st);
  if ((st.customNodes || []).filter(item => item.id === sq.id).length !== 1) throw new Error('sq 条目应幂等不重复');
  if (!data1b.nodes.find(n => n.id === sq.id)) throw new Error('已有条目应照常实体化');
  const data2 = sandbox._buildGraphData([
    { role: 'user', content: '问题', timestamp: 110 },
    { role: 'assistant', content: '反馈但没有建议问题列表', timestamp: 210, branchType: 'socratic', parentId: '110' },
  ], {});
  if (data2.nodes.some(n => n.sqAuto)) throw new Error('无建议问题不应派生');
  // 删除墓碑：harnessDeleted 记录后不再重建
  const st3 = { harnessDeleted: { 'sq-200': true } };
  const data3 = sandbox._buildGraphData(msgs, st3);
  if (data3.nodes.some(n => n.sqAuto) || (st3.customNodes || []).some(item => item.id === 'sq-200')) throw new Error('墓碑节点不应复活');
  return true;
});

check('sq 派生追问节点渲染：与手建苏格拉底追问节点同款（module 卡＋四按钮＋完成徽章＋出口）', () => {
  const node = { id: 'sq-999', kind: 'module', moduleKey: 'socratic', sqAuto: true, messageIndex: -1, timestamp: 999, x: 0, y: 0, status: 'done', content: '### 苏格拉底追问\n\n- [基础] 为什么周期与振幅无关？', items: [{ levelName: '基础', level: 'basic', question: '为什么周期与振幅无关？' }] };
  // 完成徽章文案走全局 escapeHtml（graph-render.js _customNodeStatusHtml），沙箱 loose
  // document 下产物退化、字面断言不出来——本用例断言的是结构契约不是转义，按套件
  // 惯例（2226/2543/3354 行同款）断言前换恒等，测完与 renderMarkdown 桩一并恢复。
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  // 沙箱无 marked：用轻量桩走同一条 convertSocraticQuestions 管线（按钮标记由此生成）
  const realRM = sandbox.renderMarkdown;
  sandbox.renderMarkdown = (text, opts) => {
    const lis = String(text).split('\n').filter(l => /^- \[/.test(l.trim()))
      .map(l => '<li>' + l.trim().replace(/^- /, '') + '</li>').join('');
    return sandbox.convertSocraticQuestions('<ol>' + lis + '</ol>', opts || {});
  };
  try {
    const html = sandbox._renderNodeHtml(node, [], {});
    if (!html.includes('graph-node-module') || !html.includes('graph-module-socratic')) throw new Error('应走 module 渲染路径（与手建节点同类）');
    if (!html.includes('graph-attr-socratic')) throw new Error('缺苏格拉底属性色');
    if (!html.includes('socratic-item')) throw new Error('缺问题列表');
    if (!html.includes('data-parent-msg="999"')) throw new Error('按钮 parent 应指向反馈消息');
    for (const t of ['我来回答', '直接问AI', '给点提示', '看讲解']) {
      if (!html.includes(t)) throw new Error('缺按钮 ' + t);
    }
    if (!html.includes('status-done') || !html.includes('完成')) throw new Error('缺完成徽章');
    if (!html.includes('graph-node-edit-toggle') || !html.includes('graph-node-delete-toggle')) throw new Error('缺编辑/删除钮（自定义节点原生能力）');
    if (!html.includes('问题1')) throw new Error('缺问题输出端口');
    const min = sandbox._renderNodeHtml({ ...node, minimized: true }, [], {});
    if (min.includes('socratic-item')) throw new Error('折叠态不应出列表');
  } finally {
    sandbox.renderMarkdown = realRM;
    sandbox.escapeHtml = realEsc;
  }
  return true;
});

check('answer 卡展开切换：toggleGraphNodeExpand 翻转 graphState.expandedAnswers 并保存', () => {
  const saved = [];
  sandbox.window.saveGraphState = (sid, state) => { saved.push(state); };
  sandbox.window.renderGraphCanvas = () => {};
  try {
    sandbox.window.getGraphState = () => ({ portCounts: {} });
    sandbox.toggleGraphNodeExpand('a7');
    if (!saved.length || saved[saved.length - 1].expandedAnswers.a7 !== true) throw new Error('展开未落状态');
    sandbox.window.getGraphState = () => ({ expandedAnswers: { a7: true } });
    sandbox.toggleGraphNodeExpand('a7');
    if (saved[saved.length - 1].expandedAnswers.a7 !== undefined) throw new Error('收起未清状态');
  } finally {
    sandbox.window.getGraphState = () => ({});
    delete sandbox.window.saveGraphState;
    delete sandbox.window.renderGraphCanvas;
  }
  return true;
});

// 静态契约（T128→2026-10-02 家族化）：风格家族机制——注册表/存储键/入口/双属性挂钩，防「机制在、入口丢」回退。
// 家族＝面板质感＋节点皮肤＋强调色一个开关（用户拍板焊接），原皮肤面板/壁纸挑选器并入 #themePanel。
check('风格家族（T128 演进）：注册表、存储键、页头入口、双属性与启动预置全接线', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  if (!ui.includes('const GRAPH_NODE_SKINS') || !ui.includes("{ key: 'aurora'")) {
    throw new Error('ui.js 缺皮肤注册表 GRAPH_NODE_SKINS / aurora 默认模板');
  }
  for (const fn of ['function currentStyleFamily()', 'function applyStyleFamily(', 'function toggleThemePicker(', 'function renderThemePanel()', 'function pickTheme(', 'function pickStyleFamily(', 'function setNodeSkin(']) {
    if (!ui.includes(fn)) throw new Error(`ui.js 缺 ${fn}`);
  }
  if (!ui.includes("removeAttribute('data-node-skin')") || !ui.includes("removeAttribute('data-panel-skin')")) {
    throw new Error('默认族必须摘掉 data-node-skin 与 data-panel-skin 两属性（基础规则即默认），否则切回默认不生效');
  }
  if (!ui.includes("localStorage.setItem(STORAGE_KEY_NODE_SKIN, fam)")) {
    throw new Error('家族应用须同步写旧 phymathia_node_skin（图导出快照等旧读者兼容）');
  }
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("STORAGE_KEY_NODE_SKIN = 'phymathia_node_skin'")) throw new Error('config.js 缺皮肤存储键');
  if (!cfg.includes("STORAGE_KEY_STYLE_FAMILY = 'phymathia_style_family'")) throw new Error('config.js 缺家族存储键');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="themePickBtn"') || !html.includes('toggleThemePicker(event)')) throw new Error('页头缺主题挑选按钮入口');
  if (!html.includes('id="themePanel"')) throw new Error('index.html 缺 #themePanel 面板容器');
  // P2 多账号：内联脚本读键改为前缀感知（p + 'phymathia_style_family'），防闪语义不变
  if (!html.includes("localStorage.getItem(p + 'phymathia_style_family')")) throw new Error('启动内联脚本没预置家族（首屏会闪默认模板）');
  if (!/setAttribute\('data-panel-skin', fam\)/.test(html)) throw new Error('启动预置缺 data-panel-skin（面板质感首屏闪默认）');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!css.includes('节点皮肤模板')) throw new Error('graph-override.css 缺「节点皮肤模板」节——新模板没有落点');
  return true;
});

// 静态契约（T128 续）：注册表与 CSS 覆盖块必须一一对齐——面板能选出来的皮肤，CSS 里就得真有料
check('节点皮肤模板：注册表每个非默认 key 在 CSS 都有对应 [data-node-skin] 覆盖块', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SKINS');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]);
  if (!keys.includes('aurora')) throw new Error('注册表解析异常：没找到默认模板 aurora');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const missing = keys.filter(k => k !== 'aurora' && !css.includes(`[data-node-skin="${k}"] .graph-node`));
  if (missing.length) throw new Error('皮肤注册表与 CSS 覆盖块不同步，缺：' + missing.join(', '));
  return true;
});

// 静态契约（T128 续）：模块粗边节点必须被每个皮肤整组覆盖——主题 [data-theme] .graph-node-module.graph-module-*
// 是 (0,3,0)，module 覆盖块不重写 background/box-shadow 就整卡锁在默认皮（2026-10-01 用户真机实锤）
check('节点皮肤模板：module 覆盖块重写背景与投影，并带 :hover/.selected 属性色变体', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SKINS');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]).filter(k => k !== 'aurora');
  if (!keys.length) throw new Error('注册表解析异常：非默认模板一个都没取到');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  for (const k of keys) {
    const sel = `[data-node-skin="${k}"] .graph-node.graph-node-module {`;
    const i = css.indexOf(sel);
    if (i < 0) throw new Error(`${k}：缺 module 覆盖块`);
    const body = css.slice(i, css.indexOf('}', i));
    if (!body.includes('background:') || !body.includes('box-shadow:'))
      throw new Error(`${k}：module 块没重写背景/投影，模块卡面会被主题 (0,3,0) 规则锁回默认皮`);
    for (const variant of [':hover', '.selected']) {
      if (!css.includes(`[data-node-skin="${k}"] .graph-node.graph-node-module${variant}`))
        throw new Error(`${k}：缺 module${variant} 变体（模块悬停/选中会丢属性色环）`);
    }
    if (!css.includes(`[data-node-skin="${k}"] .graph-node textarea`))
      throw new Error(`${k}：卡内编辑控件（textarea/input）没跟皮肤（固定深底盲区）`);
  }
  return true;
});

// 静态契约（T128 续 8）：人工家族（我的回答/我的理解/批注）在浅色被
// [data-theme] .graph-node.graph-attr-manual… (0,3,0) 锁在玻璃白底——每个皮肤必须有
// 同特异性的家族覆盖块重写 background/box-shadow（2026-10-01 用户真机实锤「手工节点没落实材质」）
check('节点皮肤模板：人工家族覆盖块重写背景与投影（浅色家族锁皮盲区）', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SKINS');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]).filter(k => k !== 'aurora');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  for (const k of keys) {
    const sel = `[data-node-skin="${k}"] .graph-node.graph-attr-manual,`;
    const i = css.indexOf(sel);
    if (i < 0) throw new Error(`${k}：缺人工家族覆盖块（浅色下手工节点不换皮）`);
    const body = css.slice(i, css.indexOf('}', i));
    if (!body.includes('background:') || !body.includes('box-shadow:'))
      throw new Error(`${k}：人工家族块没重写背景/投影`);
    for (const extra of ['graph-node-human-note', 'graph-node-note']) {
      if (!css.includes(`[data-node-skin="${k}"] .graph-node.${extra}`))
        throw new Error(`${k}：人工家族覆盖块缺 .${extra}`);
    }
  }
  return true;
});

// 静态契约（T128 续 8）：根级皮肤变量块禁止引用 --node-attr——自定义属性里的 var() 在定义处求值，
// 根上没有 --node-attr（渲染层只写在节点身上），整条 color-mix 会变 guaranteed-invalid，
// 引用它的 background 直接失效变透明（2026-10-01 真机踩中）。含属性色的变量必须下沉到 .graph-node。
check('节点皮肤模板：根级皮肤变量块不得引用 --node-attr（须下沉到节点级定义）', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SKINS');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]).filter(k => k !== 'aurora');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  for (const k of keys) {
    for (const sel of [`[data-node-skin="${k}"] {`, `[data-theme="light"][data-node-skin="${k}"] {`]) {
      const i = css.indexOf(sel);
      if (i < 0) continue;
      const body = css.slice(i, css.indexOf('}', i));
      if (body.includes('--node-attr'))
        throw new Error(`${k}：根级变量块引用了 --node-attr（根上取不到节点属性色，整条失效变透明）`);
    }
  }
  return true;
});

// 发送排队的行为用例走自己的串行链（共享词法绑定，并发会互踩），先跑完再等其余的
await msTail;
await Promise.all(sqChecks).catch(() => {});

// ===== 串行边界追加：15 秒同步的变化检测（T204，2026-10-09）=====
// _syncFromServer 改按「确有数据变化」返回：两边已收敛的稳态零消息拉取、不写盘、
// 返回 false，15 秒轮询据此跳过侧栏/知识面板的全量重建。按变化拉取的前提是
// 「消息链路的所有写入点都 bump 会话 updatedAt 并 upsert 服务端（saveCurrentSession）」
// ——这条前提若被新代码绕过（加了只写消息不 bump updatedAt 的路径），跨标签页
// 传播会静默失效，只有行为断言能抓住。用例写共享 phymathia_sessions/msgs 键且
// await fetch，接在多选链之后串行跑，共用同一批键不互踩。
if (!sandbox.AbortSignal) sandbox.AbortSignal = AbortSignal; // vm 上下文没有宿主全局，_syncFromServer 的 fetch 选项要用
const syncEval = (code) => vm.runInContext(code, sandbox);
const syncOkJson = (data) => ({ ok: true, status: 200, json: async () => data });
const SYNC_KEYS = ['phymathia_sessions', 'phymathia_msgs_s1', 'phymathia_msgs_s2', 'phymathia_knowledge', 'phymathia_current_session'];
const syncSavedStore = Object.fromEntries(SYNC_KEYS.map(k => [k, storageData[k]]));
let syncTail = Promise.resolve();
const checkSync = (name, fn) => {
  syncTail = syncTail.then(async () => {
    try {
      const r = await fn();
      if (r === false) throw new Error('断言未通过');
      console.log('✓', name);
    } catch (e) {
      addFailed();
      console.error('❌', name, '->', e.message);
    }
  });
};

checkSync('15秒同步：稳态（两边已收敛）零消息拉取且返回 false', async () => {
  const prevFetch = sandbox.fetch;
  const calls = [];
  sandbox.fetch = async (url, init) => {
    const u = String(url);
    calls.push((init && init.method || 'GET') + ' ' + u);
    if (u === '/api/sessions') return syncOkJson({ s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 } });
    if (u === '/api/knowledge') return syncOkJson({});
    if (u === '/api/kv/phymathia_current_session') return syncOkJson({ value: null });
    return syncOkJson({});
  };
  try {
    storageData['phymathia_sessions'] = JSON.stringify({ s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 } });
    storageData['phymathia_msgs_s1'] = JSON.stringify([{ role: 'user', content: 'hi', timestamp: 1 }]);
    const changed = await syncEval('_syncFromServer()');
    if (changed !== false) throw new Error('稳态应返回 false（轮询据此跳过界面重建），实返 ' + changed);
    const batch = calls.filter(c => c.includes('messages-batch'));
    if (batch.length !== 0) throw new Error('稳态不应拉任何会话消息，实际发了：' + batch.join(','));
  } finally { sandbox.fetch = prevFetch; }
});

checkSync('15秒同步：只拉 updatedAt 更新的会话，合并后不回传；第二轮收敛零请求', async () => {
  const prevFetch = sandbox.fetch;
  const m1 = { role: 'user', content: 'hi', timestamp: 1 };
  const m2 = { role: 'assistant', content: 'new', timestamp: 2 };
  const calls = [];
  const batchBodies = [];
  sandbox.fetch = async (url, init) => {
    const u = String(url);
    calls.push((init && init.method || 'GET') + ' ' + u);
    if (u === '/api/sessions') return syncOkJson({
      s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 },
      s2: { id: 's2', title: '乙', sessionId: 'p2', updatedAt: 200 },
    });
    if (u === '/api/knowledge') return syncOkJson({});
    if (u === '/api/kv/phymathia_current_session') return syncOkJson({ value: null });
    if (u === '/api/sessions/messages-batch') {
      batchBodies.push(JSON.parse(init.body));
      return syncOkJson({ messages: { s2: [m1, m2] } });
    }
    return syncOkJson({});
  };
  try {
    storageData['phymathia_sessions'] = JSON.stringify({
      s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 },
      s2: { id: 's2', title: '乙', sessionId: 'p2', updatedAt: 100 },
    });
    storageData['phymathia_msgs_s1'] = JSON.stringify([m1]);
    storageData['phymathia_msgs_s2'] = JSON.stringify([m1]);
    const changed = await syncEval('_syncFromServer()');
    if (changed !== true) throw new Error('服务端有新消息应返回 true，实返 ' + changed);
    if (JSON.stringify(batchBodies[0] && batchBodies[0].session_ids) !== '["s2"]') {
      throw new Error('应只拉 s2，实际：' + JSON.stringify(batchBodies));
    }
    if (calls.some(c => c.startsWith('POST /api/sessions/s1/messages'))) throw new Error('未变化的 s1 不该被上传');
    if (calls.some(c => c.startsWith('POST /api/sessions/s2/messages'))) throw new Error('合并结果与服务端一致时不该回传 s2');
    if (JSON.parse(storageData['phymathia_msgs_s2']).length !== 2) throw new Error('s2 的新消息没落本地');
    if (JSON.parse(storageData['phymathia_sessions']).s2.updatedAt !== 200) throw new Error('s2 元数据没跟上服务端');
    // 第二轮：全部时间戳持平 → 收敛，零拉取零变化
    calls.length = 0; batchBodies.length = 0;
    const changed2 = await syncEval('_syncFromServer()');
    if (changed2 !== false) throw new Error('第二轮稳态应返回 false，实返 ' + changed2);
    if (batchBodies.length !== 0) throw new Error('第二轮不应再拉消息');
  } finally { sandbox.fetch = prevFetch; }
});

checkSync('15秒同步：本地消息键缺失时即使时间戳持平也要从服务端补全', async () => {
  const prevFetch = sandbox.fetch;
  const m1 = { role: 'user', content: 'hi', timestamp: 1 };
  const batchBodies = [];
  sandbox.fetch = async (url, init) => {
    const u = String(url);
    if (u === '/api/sessions') return syncOkJson({ s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 } });
    if (u === '/api/knowledge') return syncOkJson({});
    if (u === '/api/kv/phymathia_current_session') return syncOkJson({ value: null });
    if (u === '/api/sessions/messages-batch') {
      batchBodies.push(JSON.parse(init.body));
      return syncOkJson({ messages: { s1: [m1] } });
    }
    return syncOkJson({});
  };
  try {
    storageData['phymathia_sessions'] = JSON.stringify({ s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 } });
    delete storageData['phymathia_msgs_s1'];
    const changed = await syncEval('_syncFromServer()');
    if (changed !== true) throw new Error('补全本地缺失消息应算变化，实返 ' + changed);
    if (JSON.stringify(batchBodies[0] && batchBodies[0].session_ids) !== '["s1"]') throw new Error('消息键缺失的会话应被拉取');
    if (JSON.parse(storageData['phymathia_msgs_s1']).length !== 1) throw new Error('本地消息没被补全');
  } finally {
    sandbox.fetch = prevFetch;
    // 共享键还原（多选链与后续分域还在用它们）
    for (const k of SYNC_KEYS) {
      if (syncSavedStore[k] === undefined) delete storageData[k];
      else storageData[k] = syncSavedStore[k];
    }
  }
});
// ===== 串行边界追加：15 秒轮询的推送去重（T203，2026-10-09）=====
// 轮询体抽成具名 _periodicSyncTick：当前会话内容与「最近一次成功推送」逐字节
// 一致就跳过 POST——显式保存链（saveCurrentSession）与同步合并推送都经
// _saveMessagesToServer 在 resp.ok 时记签名，失败不记、下一拍照常重试；
// beforeunload beacon 兜底不走这条。此前每拍无条件推整份 chatHistory，服务端
// 虽有合并短路兜底，网络传输与服务端读并每 15 秒白干一遍。
checkSync('15秒推送：稳态零推送，内容变化才推整份历史，失败不记签名会重试', async () => {
  const prevFetch = sandbox.fetch;
  const prevSid = syncEval('currentSessionId');
  const prevHist = syncEval('JSON.stringify(chatHistory)');
  const posts = [];
  let failPost = false;
  sandbox.fetch = async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    if (method === 'POST' && u === '/api/sessions/s1/messages') {
      if (failPost) return { ok: false, status: 500, json: async () => ({}) };
      posts.push(JSON.parse(init.body));
      return syncOkJson({ ok: true });
    }
    if (u === '/api/sessions') return syncOkJson({ s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 } });
    if (u === '/api/knowledge') return syncOkJson({});
    if (u === '/api/kv/phymathia_current_session') return syncOkJson({ value: null });
    return syncOkJson({});
  };
  try {
    storageData['phymathia_sessions'] = JSON.stringify({ s1: { id: 's1', title: '甲', sessionId: 'p1', updatedAt: 100 } });
    storageData['phymathia_msgs_s1'] = JSON.stringify([{ role: 'user', content: 'hi', timestamp: 1 }]);
    syncEval('currentSessionId = "s1"');
    syncEval('chatHistory = [{ role: "user", content: "hi", timestamp: 1 }]');
    await syncEval('_periodicSyncTick()');
    if (posts.length !== 1) throw new Error('签名未知的首拍应推送一次，实际 ' + posts.length);
    await syncEval('_periodicSyncTick()');
    if (posts.length !== 1) throw new Error('内容未变的第二拍不该再推（T203 核心），多推了 ' + (posts.length - 1) + ' 次');
    syncEval('chatHistory.push({ role: "assistant", content: "new", timestamp: 2 })');
    await syncEval('_periodicSyncTick()');
    if (posts.length !== 2) throw new Error('内容变化后应恢复推送，实际 ' + posts.length);
    if (!Array.isArray(posts[1].messages) || posts[1].messages.length !== 2) {
      throw new Error('应推整份 chatHistory：' + JSON.stringify(posts[1]));
    }
    // 推送失败不记签名：内容再变后失败一拍、下一拍必须重试，成功后恢复安静
    syncEval('chatHistory.push({ role: "user", content: "again", timestamp: 3 })');
    failPost = true;
    await syncEval('_periodicSyncTick()');
    if (posts.length !== 2) throw new Error('失败拍不该记成功');
    failPost = false;
    await syncEval('_periodicSyncTick()');
    if (posts.length !== 3) throw new Error('失败后的下一拍应重试，实际 ' + posts.length);
    if (posts[2].messages.length !== 3) throw new Error('重试应带最新整份历史');
    await syncEval('_periodicSyncTick()');
    if (posts.length !== 3) throw new Error('重试成功后应恢复稳态零推送');
  } finally {
    sandbox.fetch = prevFetch;
    syncEval('currentSessionId = ' + JSON.stringify(prevSid));
    syncEval('chatHistory = ' + prevHist);
    // 共享键还原（多选链与后续分域还在用它们）
    for (const k of SYNC_KEYS) {
      if (syncSavedStore[k] === undefined) delete storageData[k];
      else storageData[k] = syncSavedStore[k];
    }
  }
});
await syncTail;

await drain();

await drain();
}
