// Φ 基础修复 / 纯问答分类边界 / 评审路线第二档
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 690–1024 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== Φ 基础修复（2026-09-30）：相位转换放宽 / 面板内会话切换器 / T51 让位正解 =====

// Φ 会话内存读取辅助（同步）：走 vm 词法作用域读 phiSessions，避开异步保存与并行用例的交错
function clonePhi(vm, sandbox, id) {
  const raw = vm.runInContext('JSON.stringify(phiSessions[' + JSON.stringify(id) + '] || null)', sandbox);
  return raw === null ? null : JSON.parse(raw);
}

check('Φ 相位转换放宽：三模式锁定时旧相位不得绕过（apply 例外）', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes("if (lockedMode !== 'edit' && phase !== 'apply') phase = lockedMode;")) {
    throw new Error('锁定模式未泛化到 chat——重试/重发路径仍可携带 expand/evaluate 绕过');
  }
  return true;
});

check('Φ 独立会话：菜单入口齐全＋解耦红线（Φ 菜单无任何删画布语义）', () => {
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes('graphHarnessSessionBtn')) throw new Error('标题旁会话按钮未进面板');
  if (!src.includes('graphHarnessSessionMenu')) throw new Error('会话下拉菜单未进面板');
  if (!src.includes('新建 Φ 会话')) throw new Error('菜单缺「新建 Φ 会话」入口');
  if (!src.includes('清空所有 Φ 对话')) throw new Error('菜单缺「清空所有 Φ 对话」入口');
  if (!src.includes('graph-harness-session-notice')) throw new Error('切换提示未实现');
  // 解耦红线（2026-09-30）：删画布入口只在左侧栏，Φ 菜单不得再有任何删画布委托/文案
  if (src.includes('window.deleteSession(') || src.includes('window.clearAllSessions()')) {
    throw new Error('Φ 菜单残留删画布委托（deleteSession/clearAllSessions）');
  }
  if (src.includes('清空所有画布') || src.includes('删除此画布')) throw new Error('Φ 菜单文案仍是删画布语义');
  // Φ 会话数据独立：phi_ id 空间 + 独立名单/当前指针键 + 绑定语义
  if (!src.includes('STORAGE_KEY_PHI_SESSIONS') || !src.includes('STORAGE_KEY_PHI_CURRENT')) {
    throw new Error('Φ 会话名单/当前指针未走 config.js 键');
  }
  if (!vm.runInContext('typeof _phiId === "function" && typeof _harnessBoundSid === "function"', sandbox)) {
    throw new Error('Φ 会话核心函数缺失');
  }
  return true;
});

check('Φ 会话生命周期：新建默认绑当前画布＋首条消息自动命名＋切换换会话', () => {
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  sandbox.window.getCurrentSessionId = () => 'sess_a';
  const newId = vm.runInContext('createPhiSession(true)', sandbox);
  if (!/^phi_/.test(String(newId))) throw new Error('Φ 会话 id 未用 phi_ 前缀：' + newId);
  const created = clonePhi(vm, sandbox, newId);
  if (!created || created.boundSid !== 'sess_a') throw new Error('新建 Φ 会话未默认绑定当前画布');
  // 首条用户消息自动命名（取前 12 字）——标题保存是同步的，读内存即可
  vm.runInContext('harnessHistory = []; _appendHarnessHistory({ id: "h1", role: "user", content: "什么是简谐运动？它的周期公式是什么", timestamp: 1 });', sandbox);
  const titled = clonePhi(vm, sandbox, newId);
  if (!titled || titled.title !== '什么是简谐运动？它的周期') throw new Error('首条消息未自动命名：' + (titled && titled.title));
  // 切换：currentPhiId 换新（对话重置走 resetHarnessSession）
  vm.runInContext('phiSessions["phi_x"] = { id: "phi_x", title: "Φ乙", boundSid: null, createdAt: 1, updatedAt: 1 };', sandbox);
  vm.runInContext('switchPhiSession("phi_x")', sandbox);
  if (vm.runInContext('currentPhiId', sandbox) !== 'phi_x') throw new Error('切换 Φ 会话未换 currentPhiId');
  return true;
});

check('Φ 会话删除/清空：只删 Φ 对话，画布键与 deleteSession 主路径零接触', () => {
  sandbox.window.confirm = () => true;
  let canvasDeleted = false, canvasCleared = false;
  sandbox.window.deleteSession = async () => { canvasDeleted = true; };
  sandbox.window.clearAllSessions = async () => { canvasCleared = true; };
  sandbox.window.getCurrentSessionId = () => 'sess_a';
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  // 造两个 Φ 会话（当前会话 phi_a 带历史键）
  vm.runInContext(`
    phiSessions = {
      phi_a: { id: 'phi_a', title: 'Φ甲', boundSid: 'sess_a', createdAt: 1, updatedAt: 1 },
      phi_b: { id: 'phi_b', title: 'Φ乙', boundSid: null, createdAt: 1, updatedAt: 2 },
    };
    currentPhiId = 'phi_a';
    localStorage.setItem('phymathia_harness_history_phi_a', '[]');
    localStorage.setItem('phymathia_harness_history_phi_b', '[]');
  `, sandbox);
  vm.runInContext('deleteHarnessSession("phi_b")', sandbox);
  if (canvasDeleted) throw new Error('删除 Φ 会话触发了画布删除主路径');
  // 清空全部 Φ 对话：画布完全保留（deleteSession/clearAllSessions 零调用），只剩新建的空白会话
  vm.runInContext('clearAllHarnessSessions()', sandbox);
  if (canvasDeleted || canvasCleared) throw new Error('清空 Φ 对话触发了画布删除/清空主路径');
  const ids = Object.keys(JSON.parse(vm.runInContext('localStorage.getItem("phymathia_phi_sessions")', sandbox)));
  if (ids.length !== 1) throw new Error('清空后应只剩自动新建的 1 个空白 Φ 会话：' + ids.length);
  if (vm.runInContext('localStorage.getItem("phymathia_harness_history_phi_a")', sandbox) !== null) {
    throw new Error('清空未删旧 Φ 会话的历史键');
  }
  if (vm.runInContext('currentPhiId', sandbox) !== ids[0]) throw new Error('清空后当前会话未切到新建会话');
  return true;
});

check('Φ 解耦接线：切画布不再重置 Φ 对话＋删画布只解绑＋改图绑定门槛', () => {
  const sessionSrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (sessionSrc.includes('window.resetHarnessSession()')) throw new Error('setCurrentSessionId 仍在重置 Φ 对话（解耦被回退）');
  if (!sessionSrc.includes('window.notifyHarnessCanvasChanged()')) throw new Error('切画布缺轻量刷新钩子');
  if (!sessionSrc.includes('window.phiCanvasDeleted(id)')) throw new Error('删画布未解绑 Φ 会话');
  if (!sessionSrc.includes('window.phiCanvasesCleared()')) throw new Error('清空画布未解绑 Φ 会话');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('canvasReady')) throw new Error('改图缺「绑定画布=当前画布」门槛（canvasReady）');
  if (!runSrc.includes('_emptyHarnessSnapshot()')) throw new Error('纯问答路径未改用空快照');
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes('phymathia_phi_migration_done')) throw new Error('缺旧数据一次性迁移标记');
  if (!src.includes('_migrateLegacyPhiHistory')) throw new Error('缺迁移函数');
  return true;
});

check('Φ 下拉菜单（会话/模式）：磨砂材质归 aurora-glass＋hidden 守卫＋specificity 手术', () => {
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes('class="graph-harness-session-menu aurora-glass"')) throw new Error('会话菜单未挂 aurora-glass（透明底压聊天记录）');
  if (!src.includes('class="graph-harness-mode-menu aurora-glass"')) throw new Error('模式菜单未挂 aurora-glass（透明底压输入区提示）');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!/\.graph-harness-window \.graph-harness-session-menu\[hidden\],\s*\n\s*\.graph-harness-window \.graph-harness-mode-menu\[hidden\]\s*\{\s*\n\s*display:\s*none;/.test(css)) {
    throw new Error('下拉菜单缺 [hidden]{display:none} 守卫（须带 .graph-harness-window 前缀抬到 (0,3,0)——模式菜单自身规则也是 (0,2,0)，同优先级源序在后会赢）');
  }
  // 标题栏 28px 图标钮规则 (0,2,1) 的特异性手术：选择器带 .graph-harness-window 前缀并回声 width
  const sessionBtnRule = css.match(/\.graph-harness-window \.graph-harness-head \.graph-harness-session-btn \{[\s\S]{0,600}?\}/);
  if (!sessionBtnRule || !sessionBtnRule[0].includes('width: auto')) throw new Error('会话按钮 specificity 手术缺失（被 28px 图标钮规则压成「i画i」）');
  const sessionItemRule = css.match(/\.graph-harness-window \.graph-harness-head \.graph-harness-session-item \{[\s\S]{0,600}?\}/);
  if (!sessionItemRule || !sessionItemRule[0].includes('width: auto')) throw new Error('会话菜单项 specificity 手术缺失（被压成一字宽竖条）');
  // 材质归 aurora-glass：菜单本体写 background 会盖掉极光层（同面板本体磨砂化分工）
  const sessionMenuCss = css.slice(css.indexOf('.graph-harness-session-menu {'), css.indexOf('.graph-harness-session-menu[hidden]'));
  if (sessionMenuCss.includes('background')) throw new Error('会话菜单本体写了 background——材质必须归 aurora-glass');
  const modeMenuCss = css.slice(css.indexOf('.graph-harness-composer .graph-harness-mode-menu {'), css.indexOf('.graph-harness-composer .graph-harness-mode-menu .graph-harness-mode-item'));
  if (modeMenuCss.includes('background')) throw new Error('模式菜单本体写了 background——材质必须归 aurora-glass');
  return true;
});

check('T51 桌宠让位正解：body.harness-open + 内联定位暂存归还', () => {
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes("classList.add('harness-open')")) throw new Error('开面板未挂 harness-open');
  if (!src.includes("classList.remove('harness-open')")) throw new Error('关面板未摘 harness-open');
  if (!src.includes('harnessPetDragBackup')) throw new Error('被拖拽内联定位未暂存归还');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!css.includes('body.harness-open .phi-pet-root')) throw new Error('CSS 未接 harness-open 选择器');
  if (!css.includes('body:has(> .graph-harness-window:not([hidden])) .phi-pet-root')) {
    throw new Error(':has() 兜网被移除——应保留双保险');
  }
  return true;
});
// ===== Φ 基础修复用例结束 =====


check('_isHarnessPureQuestion 分类边界', () => {
  if (sandbox._isHarnessPureQuestion('评价一下我的理解') !== false) return false; // 改图意图
  // 注：「…怎么样」会被标为纯问答——无害，因 R4 后快照一律发真实画布内容，
  // 分类器只影响状态文案与焦点解析跳过，不再决定快照空实。
  return sandbox._isHarnessPureQuestion('什么是牛顿第二定律') === true;
});
check('纯问答也携带真实快照（回归：拒绝建议后全空事故）', () => {
  // 模拟用户有 35 节点画布：即便分类为纯问答，快照也应包含真实节点而非空数组
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getGraphViewNodes = () => Array.from({ length: 35 }, (_, i) => ({
    id: 'n' + i, kind: 'knowledge', label: '节点' + i, content: '内容' + i,
  }));
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.buildHarnessSnapshot(true, [], null); // excludeEval=true 也不应清空非 eval 节点
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  return snap.nodes.length === 35 && snap.edges.length === 0;
});

check('_detectHarnessPhase 分类', () => {
  const nodes = [{ id: 'D', kind: 'human_note', label: '我的理解' }];
  if (sandbox._detectHarnessPhase('评价一下我对导数的理解', nodes) !== 'evaluate') return false;
  if (sandbox._detectHarnessPhase('应用建议', nodes) !== 'apply') return false;
  return true;
});

check('_stripThinkText 思考块剥离（回归：推理模型刷屏事故）', () => {
  const strip = sandbox._stripThinkText;
  if (typeof strip !== 'function') throw new Error('_stripThinkText 未暴露');
  // 成对块：整段删除，保留正式回答
  if (strip('<think>先想想 {"op": "bad"}</think>\n{"summary": "s"}') !== '{"summary": "s"}') return false;
  // 未闭合块（max_tokens 截断）：从开标签截断
  if (strip('{"summary": "ok"} <think>被截断……') !== '{"summary": "ok"}') return false;
  // 纯文本不受影响
  if (strip('正常回答') !== '正常回答') return false;
  // 空值
  if (strip('') !== '') return false;
  return true;
});

// ===== Φ 评审路线第二档前端半边（T94/T95/T97/T82/T93，2026-09-30）=====

check('T94 大图自动降级：degrade 邻域收到 1 跳、无焦点保持原样', () => {
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getCurrentSessionId = () => 'sess_test';
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  // 绑定画布读「当前 Φ 会话」：造一个绑到 sess_test 的会话（同上方快照用例手法）
  vm.runInContext('phiSessions = { phi_deg: { id: "phi_deg", title: "t", boundSid: "sess_test", createdAt: 1, updatedAt: 1 } }; currentPhiId = "phi_deg";', sandbox);
  // 60 节点链式大图（超过 40 节点阈值）
  const nodes = Array.from({ length: 60 }, (_, i) => ({
    id: 'd' + i, kind: 'knowledge', label: '节点' + i, content: '内容内容内容内容' + i,
  }));
  sandbox.window.getGraphViewNodes = () => nodes;
  sandbox.window.getGraphViewEdges = () => Array.from({ length: 59 }, (_, i) => ({ from: 'd' + i, to: 'd' + (i + 1) }));
  sandbox.window.getSelectedGraphNodeIds = () => [];
  const plain = sandbox.buildHarnessSnapshot(false, [], null);
  const noFocus = sandbox.buildHarnessSnapshot(false, [], null, null, { degrade: true });
  if (noFocus.snapshot_meta.directory_nodes !== 0) throw new Error('无焦点时 degrade 不应收缩（无焦点可缩）');
  if (noFocus.snapshot_meta.est_tokens !== plain.snapshot_meta.est_tokens) throw new Error('无焦点时 degrade 快照应与原样逐字节一致');
  const focused2 = sandbox.buildHarnessSnapshot(false, ['d0'], null);
  const focused1 = sandbox.buildHarnessSnapshot(false, ['d0'], null, null, { degrade: true });
  if (focused1.snapshot_meta.directory_nodes <= 0) throw new Error('有焦点时 degrade 应把外层节点压成目录行');
  if (focused1.snapshot_meta.directory_nodes <= focused2.snapshot_meta.directory_nodes) {
    throw new Error('degrade 邻域应比默认 2 跳更紧：1 跳 ' + focused1.snapshot_meta.directory_nodes + ' 目录行 vs 2 跳 ' + focused2.snapshot_meta.directory_nodes);
  }
  if (focused1.snapshot_meta.est_tokens >= plain.snapshot_meta.est_tokens) throw new Error('degrade 快照 est_tokens 应明显小于原快照');
  return true;
});

check('T94 三级降级接线：先重算 degrade、降不动才报错、无焦点报错文案不变', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('{ degrade: true }')) throw new Error('超预算未接 degrade 重算');
  if (!runSrc.includes('图较大，已自动聚焦到目标附近区域（可在画布选中节点缩小范围）')) throw new Error('缺降级成功提示文案');
  if (!runSrc.includes('（聚焦后仍过大）')) throw new Error('缺「降级后仍超限」兜底说明');
  if (!/est_tokens <= 30000/.test(runSrc)) throw new Error('降级后未回预算判定（≤30000 才采用）');
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!/const degrade = !!\(opts && opts\.degrade\)/.test(hSrc)) throw new Error('buildHarnessSnapshot 缺 opts.degrade 第 5 参');
  if (!hSrc.includes('degrade ? 1 : 2')) throw new Error('降级邻域半径未收到 1 跳');
  return true;
});

check('T95 401 醒目提示：通用文案（含密钥/模型配置）＋结果区错误卡片', () => {
  const human = sandbox._harnessErrorToHuman('上游 401 Unauthorized');
  if (!/密钥/.test(human)) throw new Error('401 文案未提密钥：' + human);
  if (!/模型配置/.test(human)) throw new Error('401 文案未给去「模型配置」的操作路径：' + human);
  if (/hy3 的密钥由服务端 .env 的 OPENCODE_GO_API_KEY 提供，请检查服务端配置/.test(human)) {
    throw new Error('401 文案仍是 hy3 专属旧版（hy3 系说明应只作补语）');
  }
  if (typeof sandbox._showHarnessErrorCard !== 'function') throw new Error('_showHarnessErrorCard 未暴露');
  // 宽松 DOM 下真调一次：确认函数体内 _escapeHtml/DOM 路径无 ReferenceError
  sandbox._showHarnessErrorCard('测试 <文本> & 转义');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('_showHarnessErrorCard(human)')) throw new Error('catch 未接错误卡片');
  if (!runSrc.includes('graph-harness-error">⛔ ')) throw new Error('错误卡片结构缺失（class 复用 .graph-harness-error）');
  return true;
});

check('T97 深度思考档位：四档循环回自动＋菜单行/Payload/存储键接线', () => {
  if (typeof sandbox._cycleHarnessThinking !== 'function' || typeof sandbox._harnessThinkingLevel !== 'function') {
    throw new Error('档位函数未暴露');
  }
  sandbox.localStorage.removeItem('phymathia_harness_thinking');
  if (sandbox._harnessThinkingLevel() !== '') throw new Error('默认档位应为自动（空值）');
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(sandbox._cycleHarnessThinking());
  if (seen.join(',') !== 'low,high,max,') throw new Error('四档循环不对：' + seen.join(','));
  if (sandbox._harnessThinkingLevel() !== '') throw new Error('循环一圈应回自动');
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!hSrc.includes('graphHarnessThinkingBtn')) throw new Error('模式菜单缺深度思考行');
  if (!/function cycleHarnessThinking\(event\) \{\s*\n\s*if \(event\) event\.stopPropagation\(\);/.test(hSrc)) {
    throw new Error('档位按钮未 stopPropagation（点一下会收起菜单）');
  }
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('thinking: _harnessThinkingLevel()')) throw new Error('payload 未带 thinking');
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("STORAGE_KEY_HARNESS_THINKING = 'phymathia_harness_thinking'")) throw new Error('存储键未走 config.js 常量表');
  return true;
});

check('T95 备用模型列表：排除当前＋限 2 条＋字段齐全＋hy3 端点纠正复用', () => {
  if (typeof sandbox._harnessFallbackModels !== 'function') throw new Error('_harnessFallbackModels 未暴露');
  const models = [
    { id: 'm1', provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k1', baseUrl: 'https://api.deepseek.com' },
    { id: 'm2', provider: 'zhipu', model: 'glm-4', apiKey: 'k2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'm3', provider: 'opencode', model: 'hy3', apiKey: '', baseUrl: 'https://opencode.ai/zen/v1' },
    { id: 'm4', provider: 'moonshot', model: 'kimi-k2', apiKey: 'k4', baseUrl: 'https://api.moonshot.cn/v1' },
  ];
  sandbox.localStorage.setItem('phymathia_user_models', JSON.stringify(models));
  const picked = sandbox._harnessFallbackModels(models[0]);
  if (picked.length !== 2) throw new Error('备用模型应限 2 条：' + picked.length);
  if (picked.some(m => m.model === 'deepseek-chat')) throw new Error('未排除当前模型');
  for (const m of picked) {
    for (const field of ['provider', 'api_key', 'model', 'base_url']) {
      if (typeof m[field] !== 'string') throw new Error('字段不全或非字符串：' + field + ' → ' + JSON.stringify(m));
    }
  }
  if (picked[1].provider !== 'opencode-go' || picked[1].base_url !== 'https://opencode.ai/zen/go/v1') {
    throw new Error('hy3 端点纠正未复用 _harnessModelForRequest：' + picked[1].provider + ' / ' + picked[1].base_url);
  }
  if (sandbox._harnessFallbackEnabled() !== false) throw new Error('兜底开关默认必须是关（拍板）');
  // 真走一次 toggle handler：开→关往返，状态落 phymathia_harness_fallback
  if (sandbox.toggleHarnessFallback() !== true) throw new Error('toggle 未打开开关');
  if (sandbox._harnessFallbackEnabled() !== true) throw new Error('打开状态未落 localStorage');
  if (sandbox.toggleHarnessFallback() !== false) throw new Error('toggle 未关闭开关');
  if (sandbox._harnessFallbackEnabled() !== false) throw new Error('关闭状态未落 localStorage');
  if (!fs.readFileSync('src/static/js/harness-run.js', 'utf8').includes('fallback_models: fallbackModels')) {
    throw new Error('payload 未接备用模型');
  }
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!hSrc.includes('graphHarnessFallbackBtn') || !hSrc.includes('toggleHarnessFallback(event)')) throw new Error('模式菜单缺兜底开关行');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!css.includes('.graph-harness-mode-toggle') || !css.includes('.graph-harness-mode-sep')) throw new Error('新增两行缺样式');
  return true;
});

check('T82 相位收敛：payload 只直通模式锁/显式入口，本地识别保留', () => {
  const f = sandbox._harnessPayloadPhase;
  if (typeof f !== 'function') throw new Error('_harnessPayloadPhase 未暴露');
  if (f('evaluate') !== 'normal') throw new Error('evaluate 本地猜测应降为 normal 交后端 _detect_phase 重判');
  if (f('normal') !== 'normal' || f('') !== 'normal' || f(undefined) !== 'normal') throw new Error('normal/空相位应保持 normal');
  if (f('preset') !== 'preset' || f('chat') !== 'chat') throw new Error('模式锁未直通');
  if (f('apply') !== 'apply' || f('expand') !== 'expand') throw new Error('显式入口未直通');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('phase: _harnessPayloadPhase(harnessPhase)')) throw new Error('payload.phase 未接收敛函数');
  // 本地 harnessPhase 的用途（快照 includeEval/UI 标签/历史 meta）全部保留
  if (!runSrc.includes("harnessPhase = requestedPhase === 'normal'")) throw new Error('本地相位识别被误删');
  if (!runSrc.includes("buildHarnessSnapshot(harnessPhase === 'evaluate'")) throw new Error('快照 includeEval 仍应吃本地相位');
  return true;
});

check('T93 多步循环：stage=model 且 step>0 也重置流式残文', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('Number(evt.step) > 0')) throw new Error('流式重置未覆盖多步循环（step>0）');
  if (!/evt\.stage === 'model' && \(Number\(evt\.attempt\) > 0 \|\| Number\(evt\.step\) > 0\)/.test(runSrc)) {
    throw new Error('重置条件形状不对（attempt||step 缺一不可）');
  }
  // 后端 stage:'tool' 的 status 事件走既有通用分支，无需新代码
  if (!runSrc.includes("evt.type === 'status' && evt.message")) throw new Error('status 通用分支被改动');
  return true;
});

check('T94 历史条数放宽：80 条只发最近 60（单条截断不动）', () => {
  vm.runInContext(`
    harnessHistory = Array.from({ length: 80 }, (_, i) => (
      i % 2 === 0
        ? { id: 'h' + i, role: 'user', content: 'c' + i, instruction: 'i' + i }
        : { id: 'h' + i, role: 'assistant', summary: 's' + i, operations: [] }
    ));
  `, sandbox);
  const built = sandbox._buildStructuredHarnessHistory();
  if (built.length !== 60) throw new Error('应只发最近 60 条：' + built.length);
  if (built[0].instruction !== 'i20') throw new Error('截取窗口不对（应丢最早 20 条）：' + built[0].instruction);
  if (built[built.length - 1].summary !== 's79') throw new Error('末条不是最新一条');
  vm.runInContext('harnessHistory = [];', sandbox);
  return true;
});
}
