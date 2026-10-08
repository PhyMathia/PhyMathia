// 知识点摘要契约＋存量摘要优化（方案 B）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 1887–2337 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 知识点摘要（P2：summarySource/anchorSummary 契约）静态/沙箱回归 =====

check('knowledge: dedupeKnowledgeItems 按 summarySource 保优（manual > model > local，长度仅同源 tie-break）', () => {
  const d = sandbox.dedupeKnowledgeItems;
  if (typeof d !== 'function') throw new Error('dedupeKnowledgeItems 未暴露');
  // model 摘要短于 local 整卡摘要也不被拉回去：来源等级优先
  const r1 = d({
    a: { id: 'a', title: '简谐运动', sessionId: 's1', summary: '很长的本地整卡摘要，比模型摘要长得多', summarySource: 'local', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '简谐运动', sessionId: 's1', summary: '回复力与位移成正比的周期性振动', summarySource: 'model', formulas: [], createdAt: 1 },
  });
  if (!r1.b || r1.a) return false;
  if (r1.b.summary !== '回复力与位移成正比的周期性振动') return false;
  // 同源才比长度：local 更长者胜
  const r2 = d({
    a: { id: 'a', title: '导数', sessionId: 's1', summary: '短', summarySource: 'local', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '导数', sessionId: 's1', summary: '更长的同源摘要', summarySource: 'local', formulas: [], createdAt: 1 },
  });
  if (!r2.b || r2.a) return false;
  // 旧数据（无 summarySource）视为 local：manual 仍胜出
  const r3 = d({
    a: { id: 'a', title: '动量', sessionId: 's1', summary: '旧数据无来源字段的很长摘要', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '动量', sessionId: 's1', summary: '手动摘要', summarySource: 'manual', formulas: [], createdAt: 1 },
  });
  return !!(r3.b && !r3.a && r3.b.summary === '手动摘要');
});

check('knowledge: 定位锚点优先 anchorSummary、旧数据回退 summary（契约两侧字段齐备）', () => {
  if (!code.includes('summarySource') || !code.includes('anchorSummary')) {
    throw new Error('打包产物缺 summarySource/anchorSummary 字段');
  }
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  const at = src.indexOf('_summaryFragmentsForMatch(item.anchorSummary');
  if (at < 0) throw new Error('_focusKnowledgeNodeByContent 未优先使用 anchorSummary');
  return src.slice(at, at + 120).includes('item.summary');
});

// ===== 存量摘要优化入口（P3：方案 B 批量重述 + 可停止注册表）静态/沙箱回归 =====

check('knowledge: P3 isLegacyCardSummaryItem 判定边界（manual 永不触碰、锚点比对、file/harness 不碰）', () => {
  const is = sandbox.isLegacyCardSummaryItem;
  if (typeof is !== 'function') throw new Error('isLegacyCardSummaryItem 未暴露');
  // 目标：旧数据（source=ai_extract，无 summarySource/anchorSummary）——旧提取链路必写整卡摘要
  if (is({ id: 'a', title: '导数', summary: '整卡摘要原文', source: 'ai_extract' }) !== true) return false;
  // 目标：P2 local 条目且 summary 等于 anchorSummary
  if (is({ id: 'b', title: '导数', summary: '整卡摘要', summarySource: 'local', anchorSummary: '整卡摘要', source: 'ai_extract' }) !== true) return false;
  // 非目标：summary 已与锚点不同（已优化/模板化）
  if (is({ id: 'c', title: '导数', summary: '具体摘要', summarySource: 'local', anchorSummary: '整卡摘要', source: 'ai_extract' }) !== false) return false;
  // 非目标：summarySource=model / manual
  if (is({ id: 'd', title: '导数', summary: 'x', summarySource: 'model', source: 'ai_extract' }) !== false) return false;
  if (is({ id: 'e', title: '导数', summary: 'x', summarySource: 'manual' }) !== false) return false;
  // 非目标：旧数据手动收藏（无 summarySource，source=manual）也不得触碰
  if (is({ id: 'f', title: '导数', summary: '手写摘要', source: 'manual' }) !== false) return false;
  // 非目标：file/harness 是文档/节点内容摘要，无锚点回退不适用
  if (is({ id: 'g', title: '导数', summary: '文档段落摘要', source: 'file' }) !== false) return false;
  if (is({ id: 'h', title: '导数', summary: '节点内容', source: 'harness' }) !== false) return false;
  // 非目标：空摘要 / 空值
  if (is({ id: 'i', title: '导数', summary: '   ', source: 'ai_extract' }) !== false) return false;
  if (is(null) !== false) return false;
  return true;
});

check('knowledge: P3 重述提示词按 (title, formulas, meaning) 组装 + 公式含义同会话优先 + 回复清洗', () => {
  const meaningsOf = sandbox._knowledgeFormulaMeanings;
  const build = sandbox._buildSummaryRestatePrompt;
  const clean = sandbox._cleanRestatedSummaryText;
  if (typeof meaningsOf !== 'function' || typeof build !== 'function' || typeof clean !== 'function') {
    throw new Error('P3 提示词/清洗函数未暴露');
  }
  // 公式含义查找：同会话优先，跨会话同名公式兜底（_formulaKey 忽略空格差异）
  storageData['phymathia_formulas'] = JSON.stringify({
    f1: { id: 'f1', latex: '$F = -kx$', meaning: '回复力与位移成正比', sessionId: 'sessA', meaningSource: 'model' },
    f2: { id: 'f2', latex: '$G=mg$', meaning: '重力与质量成正比', sessionId: 'sessB', meaningSource: 'model' },
  });
  const m1 = meaningsOf({ sessionId: 'sessA', formulas: ['F=-kx'] });
  const m2 = meaningsOf({ sessionId: 'sessC', formulas: ['G = mg'] });
  if (m1.length !== 1 || m1[0].meaning !== '回复力与位移成正比') return false;
  if (m2.length !== 1 || m2[0].meaning !== '重力与质量成正比') return false;
  // 提示词含标题/公式/含义/旧摘要/60 字约束
  const prompt = build(
    { title: '简谐运动', category: 'physics', summary: '整卡摘要原文', formulas: ['F=-kx'] },
    m1,
  );
  for (const frag of ['简谐运动', 'F=-kx', '回复力与位移成正比', '整卡摘要原文', '60 字']) {
    if (!prompt.includes(frag)) throw new Error('重述提示词缺: ' + frag);
  }
  // 回复清洗：思考块/前缀/引号/多行解释
  if (clean('<think>推理</think>摘要：**重述摘要正文**') !== '重述摘要正文') return false;
  if (clean('“带引号的模型回复”') !== '带引号的模型回复') return false;
  if (clean('第一行摘要\n第二行解释') !== '第一行摘要') return false;
  if (clean('好的，以下是摘要：\n真正摘要行') !== '真正摘要行') return false;
  delete storageData['phymathia_formulas'];
  return true;
});

check('knowledge: P3 批量任务中止后不再发后续请求 + 目标写回 + 非目标不触碰（沙箱行为断言）', async () => {
  const realProxy = sandbox.proxyChatWithModel;
  const realGetActive = sandbox.getActiveModelForRole;
  const RealAbortController = sandbox.AbortController;
  // 宽松 DOM 代理对任意属性都返回代理（含 Symbol.match），真实字符串 .includes(代理)
  // 会被当成 RegExp 抛 TypeError——批量路径涉及的 getElementById 换成哑元素，
  // knowledgePanel 视为未打开（跳过重渲），结束后还原。
  const realGetElementById = sandbox.document.getElementById;
  const fakeEl = () => ({
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    style: {}, textContent: '', innerHTML: '',
  });
  sandbox.document.getElementById = () => fakeEl();
  try {
    // 三条 local 整卡摘要目标 + 一条手动条目（必须不触碰）
    storageData['phymathia_knowledge'] = JSON.stringify({
      ki_a: { id: 'ki_a', title: '简谐运动', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要A', summarySource: 'local', anchorSummary: '整卡摘要A', formulas: [], createdAt: 1 },
      ki_b: { id: 'ki_b', title: '胡克定律', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要B', summarySource: 'local', anchorSummary: '整卡摘要B', formulas: [], createdAt: 2 },
      ki_c: { id: 'ki_c', title: '导数', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要C', summarySource: 'local', anchorSummary: '整卡摘要C', formulas: [], createdAt: 3 },
      ki_m: { id: 'ki_m', title: '手动条目', sessionId: 's1', source: 'manual', summary: '手动摘要', summarySource: 'manual', formulas: [], createdAt: 4 },
    });
    sandbox.invalidateKnowledgeCache();
    sandbox.getActiveModelForRole = (role) => (role === 'descriptor'
      ? { id: 'desc', provider: 'test', model: 'test-model', baseUrl: 'https://example.test', apiKey: 'k' }
      : null); // descriptor 槽位优先
    let proxyCalls = 0;
    sandbox.proxyChatWithModel = async (model, body, signal) => {
      proxyCalls++;
      if (proxyCalls === 1) {
        const prompt = body.messages.map(m => m.content).join('\n');
        if (!prompt.includes('简谐运动')) throw new Error('第一条请求应针对目标条目');
        if (body.stream !== false) throw new Error('重述调用应走 stream:false');
        return { json: async () => ({ choices: [{ message: { content: '重述后的摘要A' } }] }) };
      }
      // 第二条请求进行中被用户中止：置 aborted（模拟 AbortController.abort 效果）并拒绝在途 fetch
      signal.aborted = true;
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };
    sandbox.AbortController = class {
      constructor() { this.signal = { aborted: false }; this.abort = () => { this.signal.aborted = true; }; }
    };
    await sandbox.optimizeKnowledgeSummaries();
    if (proxyCalls !== 2) throw new Error('中止后应不再发出后续请求，实际调用 ' + proxyCalls + ' 次（应为 2）');
    const after = JSON.parse(storageData['phymathia_knowledge']);
    if (after.ki_a.summary !== '重述后的摘要A' || after.ki_a.summarySource !== 'model') return false; // 完成条目写回
    if (after.ki_a.anchorSummary !== '整卡摘要A') return false; // 定位锚点保留
    if (after.ki_b.summary !== '整卡摘要B' || after.ki_b.summarySource !== 'local') return false; // 失败条目不写回
    if (after.ki_c.summary !== '整卡摘要C' || after.ki_c.summarySource !== 'local') return false; // 中止后未触碰
    if (after.ki_m.summary !== '手动摘要' || after.ki_m.summarySource !== 'manual') return false; // manual 不触碰
    return true;
  } finally {
    sandbox.proxyChatWithModel = realProxy;
    sandbox.getActiveModelForRole = realGetActive;
    sandbox.AbortController = RealAbortController;
    sandbox.document.getElementById = realGetElementById;
    delete storageData['phymathia_knowledge'];
    sandbox.invalidateKnowledgeCache();
  }
});

check('knowledge: P3 中断注册表接线（再次点击/Esc 两路径 + 循环前查 signal；关面板不中止）与入口静态断言', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  for (const frag of [
    'let _kpSummaryOptimizeAbort',                                    // 模块级注册表：中断路径的唯一持有者
    'function abortKnowledgeSummaryOptimize',                         // 统一中断入口
    "if (event.key === 'Escape') abortKnowledgeSummaryOptimize()",    // Esc 路径
    'if (_knowledgeSummaryTaskRunning())',                            // 再次点击 = 中断（批量入口首行分流）
    'if (controller.signal.aborted) { aborted = true; break; } // 中止后不再发出后续请求',   // 循环每轮先查
    'if (controller.signal.aborted) { aborted = true; break; } // 用户中断不计为失败',       // 在途 fetch 拒绝后 break
    "restatKnowledgeItemSummary('${item.id}')",                       // 卡片单条入口（渲染层接线）
    "isLegacyCardSummaryItem(item) ? `<button class=\"kp-action-btn kp-btn-primary\" onclick=\"event.stopPropagation(); restatKnowledgeItemSummary", // 非目标条目不渲染入口
  ]) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺中断/入口接线: ' + frag);
  }
  // 设计变更 2026-10-01：关面板不再中止批量优化（任务后台继续、重开面板恢复按钮运行态）
  // ——中止路径只剩 再点按钮/Esc。断言 closeKnowledgePanel 体内不含 abort 调用，
  // 且运行态判断函数存在并挂 window（ui.js 的 Esc 分流依赖它）。
  const closeBody = src.match(/function closeKnowledgePanel\(\) \{[\s\S]*?\n\}/);
  if (!closeBody) throw new Error('knowledge.js 缺 closeKnowledgePanel');
  if (closeBody[0].includes('abortKnowledgeSummaryOptimize')) throw new Error('关面板不应中止批量优化（2026-10-01 设计变更）');
  for (const frag of ['function isKnowledgeSummaryOptimizeRunning', 'window.isKnowledgeSummaryOptimizeRunning']) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺运行态导出: ' + frag);
  }
  for (const frag of ['optimizeKnowledgeSummaries', 'isLegacyCardSummaryItem', 'restatKnowledgeItemSummary', '_kpSummaryOptimizeAbort']) {
    if (!code.includes(frag)) throw new Error('打包产物缺符号: ' + frag);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  // T148：入口改派发器 kpOptimizeBtnClicked（知识点页优化摘要 / 公式页优化含义），
  // 断言认派发器 + 两个批量入口仍在 knowledge.js
  if (!html.includes('kpOptimizeBtn') || !html.includes('kpOptimizeBtnClicked()')) return false;
  for (const frag of ['function optimizeKnowledgeSummaries', 'function optimizeFormulaMeanings', 'function kpOptimizeBtnClicked', 'window.kpOptimizeBtnClicked']) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺批量入口/派发器: ' + frag);
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  return css.includes('.kp-tool-btn');
});

check('knowledge: 导出 Markdown 接线（按钮/整库口径/两个 tab 构建器/Blob 下载/window 导出）', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  for (const frag of [
    'function exportKnowledgeMarkdown',
    'function _kpDownloadTextFile',           // Blob 下载（graph-export 私有 helper 不可见，本地实现）
    'function _kpKnowledgeMarkdown',          // 知识点 tab：按日期分组整库导出
    'function _kpFormulasMarkdown',           // 公式 tab：公式清单导出
    "'PhyMathia-知识总览-'",                   // 文件名口径
    'window.exportKnowledgeMarkdown',
    // 整库语义：数据源走缓存 getKnowledgeItems，不新拉接口
    'Object.values(getKnowledgeItems())',
  ]) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺导出接线: ' + frag);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="kpExportBtn"') || !html.includes('onclick="exportKnowledgeMarkdown()"')) {
    throw new Error('index.html 缺导出按钮');
  }
  // 公式导出与面板显示同一语义过滤口径（废条目不入导出）
  if (!/_kpFormulasMarkdown[\s\S]{0,400}_looksLikeFormula/.test(src)) throw new Error('公式导出未过 _looksLikeFormula 语义过滤');
  return true;
});

check('九项修复回归（T39/T43/T54/T119+T58/T127/T143/T144/T146/T148）静态接线', () => {
  // T39：fitGraph 里画布滚动位置清零（缩放/适配后不残留滚动偏移）
  const srcInteract = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  for (const frag of ['graphCanvas.scrollTop = 0', 'graphCanvas.scrollLeft = 0']) {
    if (!srcInteract.includes(frag)) throw new Error('T39 graph-interact.js 缺滚动清零: ' + frag);
  }
  if (!/function fitGraph\(\) \{[\s\S]{0,400}graphCanvas\.scrollTop = 0/.test(srcInteract)) {
    throw new Error('T39 fitGraph 函数体 400 字符内未清零 scrollTop');
  }

  // T54：导出/海报大画布面积上限 + 空白画布兜底（超限自动降采样，不再出白图）
  const srcExport = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  for (const frag of ['EXPORT_MAX_AREA = 67108864', 'function _canvasLooksBlank', 'blankErr.blank = true', '自动降到']) {
    if (!srcExport.includes(frag)) throw new Error('T54 graph-export.js 缺: ' + frag);
  }
  const srcPoster = fs.readFileSync('src/static/js/graph-poster.js', 'utf8');
  for (const frag of ['POSTER_MAX_AREA = 67108864', 'function _canvasLooksBlank']) {
    if (!srcPoster.includes(frag)) throw new Error('T54 graph-poster.js 缺: ' + frag);
  }

  // T119：破坏性操作前先确认画布存在（提示口径统一「稍候再…」）
  const srcSession = fs.readFileSync('src/static/js/session.js', 'utf8');
  for (const frag of ['稍候再删除画布', '稍候再批量删除画布', '稍候再清空当前画布', '稍候再清空所有画布']) {
    if (!srcSession.includes(frag)) throw new Error('T119 session.js 缺: ' + frag);
  }
  const srcWorkflow = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  if (!srcWorkflow.includes('稍候再单独生成这个节点')) throw new Error('T119 graph-workflow.js 缺「稍候再单独生成这个节点」');
  if (!srcInteract.includes('稍候再生成可视化')) throw new Error('T119 graph-interact.js 缺「稍候再生成可视化」');

  // T58：可视化重生成忙态标志（防并发重入）
  const srcRender = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  for (const frag of ['vizBusy', 'regenBusy']) {
    if (!srcRender.includes(frag)) throw new Error('T58 graph-render.js 缺忙态标志: ' + frag);
  }

  // T127：Harness 事件轮询两态 URL（全库聚合 / 单会话）
  const srcHarness = fs.readFileSync('src/static/js/harness.js', 'utf8');
  for (const frag of ['/api/harness/graph/events?all=1', '/api/harness/graph/events?session_id=']) {
    if (!srcHarness.includes(frag)) throw new Error('T127 harness.js 缺事件轮询 URL: ' + frag);
  }

  // T143：知识大陆键盘操作收敛进 _kact（调用 ≥15 处）+ 焦点可见样式
  const srcContinent = readContinentSrc();
  if (!srcContinent.includes('function _kact')) throw new Error('T143 graph-continent.js 缺 function _kact');
  const kactCount = (srcContinent.match(/\b_kact\(/g) || []).length;
  if (kactCount < 15) throw new Error('T143 graph-continent.js _kact( 调用数不足 15: ' + kactCount);
  const cssPanels = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!cssPanels.includes('.continent-open [tabindex="0"]:focus-visible')) {
    throw new Error('T143 styles-panels.css 缺 .continent-open [tabindex="0"]:focus-visible');
  }

  // T144：大陆边层拆分（切分/画边/重绘三函数），commit 不再内联拉数据
  for (const frag of ['function _continentSplitEdges', 'function _continentDrawEdgeLayer', 'function _continentRedrawEdges']) {
    if (!srcContinent.includes(frag)) throw new Error('T144 graph-continent.js 缺: ' + frag);
  }
  const commitBody = (srcContinent.match(/async function _continentCommit\([\s\S]*?\n\}/) || [''])[0];
  if (!commitBody) throw new Error('T144 graph-continent.js 未匹配到 async function _continentCommit 函数体');
  if (commitBody.includes('_continentFetchData')) throw new Error('T144 _continentCommit 函数体内仍含 _continentFetchData（未拆干净）');

  // T146：知识面板多会话聚合口径（sessionIds 数组聚合，弃用旧 sessionId|key 拼接）
  const srcKnowledge = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  if (srcKnowledge.includes("sessionId + '|' + key")) throw new Error("T146 knowledge.js 仍含旧口径 sessionId + '|' + key");
  const sidsCount = (srcKnowledge.match(/keep\.sessionIds = sids/g) || []).length;
  if (sidsCount < 2) throw new Error('T146 knowledge.js keep.sessionIds = sids 出现次数不足 2: ' + sidsCount);
  if (!srcKnowledge.includes('if (!keep.sessionId && sids.length) keep.sessionId = sids[0]')) {
    throw new Error('T146 knowledge.js 缺 sessionId 回填兜底: if (!keep.sessionId && sids.length) keep.sessionId = sids[0]');
  }
  const srcQuiz = fs.readFileSync('src/static/js/quiz-stats.js', 'utf8');
  if (!srcQuiz.includes('item.sessionId, ...((item && item.sessionIds) || [])')) {
    throw new Error('T146 quiz-stats.js 缺 sessionIds 聚合: item.sessionId, ...((item && item.sessionIds) || [])');
  }

  // T148：公式含义旧数据过滤 + 批量优化含义入口（HTML 按钮走派发器 kpOptimizeBtnClicked）
  for (const frag of ['function isLegacyFormulaMeaningItem', 'function optimizeFormulaMeanings', '请为下面的公式写一句含义说明', 'window.kpOptimizeBtnClicked']) {
    if (!srcKnowledge.includes(frag)) throw new Error('T148 knowledge.js 缺: ' + frag);
  }
  const htmlIndex = fs.readFileSync('src/static/index.html', 'utf8');
  if (!htmlIndex.includes('kpOptimizeBtnClicked()')) throw new Error('T148 index.html 缺 kpOptimizeBtnClicked() 入口');

  return true;
});

check('knowledge: 删除可撤销接线（删前快照/只保最新一条/8 秒超时/写回走保存队列/window 导出）', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  for (const frag of [
    'const KP_UNDO_MS = 8000',
    'function _showKpUndoToast',
    'function _undoKpDelete',
    'window._undoKpDelete',
    // 两个删除入口都要在确认后、删除前取快照
    'const snapshot = getKnowledgeItems()[id] || null;',
    'const snapshot = getFormulaCache()[id] || null;',
    // 撤销写回走既有保存路径：公式 saveFormulasToServer（知识点 saveKnowledgeItems 另见写回函数）
    'saveFormulasToServer([snap.item])',
    // showToast 不动签名：专用提示条独立挂点
    "document.getElementById('phymathia_kp_undo')",
  ]) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺撤销接线: ' + frag);
  }
  // 只保最新一条：_showKpUndoToast 开头必须清掉旧快照/旧计时器（连续删除取舍）
  const showBody = src.match(/function _showKpUndoToast\([^)]*\) \{[\s\S]*?\n\}/);
  if (!showBody) throw new Error('knowledge.js 缺 _showKpUndoToast');
  if (!showBody[0].includes('_hideKpUndoToast()')) throw new Error('新撤销提示必须先作废前一条快照（只保最新一条）');
  // 服务端 DELETE 链路原样：撤销只是删后写回，删除函数本体不得去掉 DELETE
  if (!src.includes("method: 'DELETE'") || !src.includes("'/api/knowledge/' + encodeURIComponent(id)")) {
    throw new Error('删除服务端链路被改动');
  }
  return true;
});

check('knowledge: 批量优化内联进度条（n/N 恢复显示/逐条 toast 已去/结束隐藏）+ 单条重述真控制器接线', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  for (const frag of [
    'let _kpOptimizeProgressState',                      // 进度状态模块级：关面板重开重填
    'function _syncKpOptimizeProgress',
    'function _syncKpOptimizeWidgets',
    '_kpOptimizeProgressState = { done: done + skipped, total };',
    // 单条重述：真控制器注册表（原 new AbortController().signal 死控制器已废）
    'let _kpRestateAbort',
    'function abortKnowledgeRestatement',
    "if (event.key === 'Escape') abortKnowledgeRestatement()",
  ]) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺进度/单条中止接线: ' + frag);
  }
  if (src.includes('new AbortController().signal')) throw new Error('单条重述仍传死控制器（永不生效）');
  // 逐条刷屏 toast 已去：批量循环内不再有「优化摘要 n/total：标题…」
  if (src.includes("'优化摘要 ' + done + '/' + total")) throw new Error('批量循环内逐条 toast 未移除');
  // 互斥防踩：批量在跑时单条拒绝、单条在跑时批量拒绝（各自入口）
  if (!src.includes("if (_knowledgeBatchRunning()) {\n    showToast('批量优化进行中")) throw new Error('单条入口缺批量互斥');
  if (!src.includes("'单条重述摘要进行中，请等它完成'")) throw new Error('批量入口缺单条互斥');
  // index.html 进度挂点 + CSS 样式
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const frag of ['id="kpOptimizeProgress"', 'id="kpOptimizeProgressText"', 'id="kpOptimizeProgressFill"']) {
    if (!html.includes(frag)) throw new Error('index.html 缺进度挂点: ' + frag);
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const frag of ['.kp-optimize-progress', '.kp-optimize-progress-track', '.kp-optimize-progress-fill']) {
    if (!css.includes(frag)) throw new Error('styles-panels.css 缺进度样式: ' + frag);
  }
  // 恢复接线：重开面板/切 tab/批量中止收尾都要走 _syncKpOptimizeWidgets
  const syncCalls = src.match(/_syncKpOptimizeWidgets\(\);/g) || [];
  if (syncCalls.length < 3) throw new Error('进度/按钮恢复接线不足（重开面板+切 tab+收尾至少各一处）');
  return true;
});

check('knowledge: 「去知识大陆」入口接线（先关面板再进大陆 + window 导出 + index.html 按钮）', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  const body = src.match(/function openKnowledgeContinentView\(\) \{[\s\S]*?\n\}/);
  if (!body) throw new Error('knowledge.js 缺 openKnowledgeContinentView');
  // 大陆是全屏画布层：先关知识面板（memory.js openMemoryPanel 先例），再进大陆
  const closeAt = body[0].indexOf('closeKnowledgePanel()');
  const openAt = body[0].indexOf('window.openContinentView()');
  if (closeAt < 0 || openAt < 0 || closeAt > openAt) throw new Error('必须先 closeKnowledgePanel 再 openContinentView');
  if (!src.includes('window.openKnowledgeContinentView')) throw new Error('缺 window 导出');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="kpContinentBtn"') || !html.includes('onclick="openKnowledgeContinentView()"')) {
    throw new Error('index.html 缺大陆入口按钮');
  }
  return true;
});

check('knowledge: P4 extractLocalKnowledge 模板化摘要（多公式回答逐条互异 + anchor 保整卡 + 前后端同文案）', () => {
  // 与 pytest test_local_extract_summaries_differ_for_multi_formula_answers 同一组输入：
  // 期望文案两侧逐字一致（前端 _buildLocalKnowledgeSummary / 后端 _local_knowledge_summary）
  const answers = [
    '# 简谐运动\n回复力让物体振动。\n<formula>F=-kx</formula>\n'
      + '<formula>T=2\\pi\\sqrt{\\frac{m}{k}}</formula>\n<summary>甲卡整卡摘要</summary>',
    '# 傅里叶级数\n周期信号可分解为谐波叠加。\n'
      + '<formula>\\sum_{n=1}^{\\infty}a_n e^{inx}</formula>\n<summary>乙卡整卡摘要</summary>',
    '# 傅里叶变换\n把信号分解为连续频率分量。\n'
      + '<formula>\\int_0^{T}f(t)dt</formula>\n<summary>丙卡整卡摘要</summary>',
    '# 简谐运动能量\n总机械能与振幅平方成正比。\n'
      + '<formula>E=\\frac{1}{2}kA^2</formula>\n<summary>丁卡整卡摘要</summary>',
    '# 导数\n刻画函数的瞬时变化率，本卡没有公式。',
  ];
  const anchorParts = ['甲卡整卡摘要', '乙卡整卡摘要', '丙卡整卡摘要', '丁卡整卡摘要', '瞬时变化率'];
  const expected = [
    '「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）',
    '「傅里叶级数」：傅里叶级数/变换：用指数基元把信号分解为频率成分（物理）',
    '「傅里叶变换」：傅里叶变换：把信号分解为连续频率分量的积分表示（其他）',
    '「简谐运动能量」：简谐运动总机械能与振幅平方成正比（物理）',
    '「导数」：数学知识点',
  ];
  const items = answers.map(c => sandbox.extractLocalKnowledge([{ role: 'assistant', content: c }])[0]);
  if (items.some(it => !it || it.summarySource !== 'local')) return false;
  for (let i = 0; i < expected.length; i++) {
    if (items[i].summary !== expected[i]) {
      throw new Error('模板文案偏离（须与后端 _local_knowledge_summary 同口径）: ' + items[i].summary);
    }
    if (items[i].anchorSummary === items[i].summary) return false; // 整卡摘要仍是锚点，不再充当展示摘要
    if (!String(items[i].anchorSummary).includes(anchorParts[i])) return false; // 锚点保留整卡摘要原文
  }
  const summaries = items.map(it => it.summary);
  if (new Set(summaries).size !== summaries.length) return false; // 各条互不相同
  // 多公式回答取首个公式的规则含义（胡克定律），不串到第二公式（周期）含义
  if (!summaries[0].includes('胡克定律') || summaries[0].includes('周期')) return false;
  // 超长标题（审查修复回归）：预算压缩标题保结构——「」/含义/分类括注完整、≤120，
  // 期望串与 pytest test_local_knowledge_summary_long_title_keeps_structure 同口径
  const unit = '很长的知识点标题';
  const longAns = [{ role: 'assistant', content: `# ${unit.repeat(15)}\n受力分析如下。\n<formula>F=ma</formula>` }];
  const longItem = sandbox.extractLocalKnowledge(longAns)[0];
  const longExpected = `「${unit.repeat(6)}很长的」：${unit.repeat(3)}相关公式：用于描述${unit.repeat(3)}的定量关系（物理）`;
  if (!longItem || longItem.summary !== longExpected) {
    throw new Error('超长标题模板偏离（须与后端 _local_knowledge_summary 同口径）: ' + (longItem && longItem.summary));
  }
  const longNoFormula = sandbox.extractLocalKnowledge(
    [{ role: 'assistant', content: `# ${unit.repeat(15)}\n本卡没有公式。` }])[0];
  if (!longNoFormula || !longNoFormula.summary.startsWith('「')) return false;
  if (!longNoFormula.summary.endsWith('」：其他知识点') || longNoFormula.summary.length > 120) return false;
  if (!code.includes('_buildLocalKnowledgeSummary')) throw new Error('打包产物缺 _buildLocalKnowledgeSummary');
  return true;
});

check('chat：推理通道不混进正文（混进去 → 整轮知识提取被「思维链泄漏」闸门拒收 → 大陆永远没有这座岛）', () => {
  // 真机事故（2026-09-15）：推理型模型先吐 reasoning_content 再吐 content，前端旧写法
  // `assistantContent += delta.content || delta.reasoning_content` 把思维链灌进正文，
  // 正文以「用户要求：…当前分支类型…必须只输出…」开头 → 前后端同判的 _looksLikeReasoningLeak
  // 命中 → 整轮不提取 → 用户问过「旋度」，知识库与大陆里却永远没有旋度。
  const src = fs.readFileSync('src/static/js/chat.js', 'utf8');
  if (/assistantContent \+= delta\.content \|\| delta\.reasoning_content/.test(src)) {
    throw new Error('思维链又被灌进正文了（知识提取会被闸门整轮拒收）');
  }
  if (!/if \(delta\.content\) assistantContent \+= delta\.content;/.test(src)) {
    throw new Error('正文累加口径缺失（只认 delta.content）');
  }
  if (!src.includes('assistantReasoning')) throw new Error('推理通道未单独攒');
  if (!src.includes('assistantContent = assistantReasoning')) {
    throw new Error('模型只吐推理、正文为空时的兜底缺失（会留一个空气泡）');
  }
  // 被闸门跳过时必须让用户知道原因：静默正是这场事故最坑的地方
  const feat = fs.readFileSync('src/static/js/chat-features.js', 'utf8');
  if (!feat.includes("_knowledgeSkipReason = 'reasoning_leak'")) throw new Error('提取被跳过时未记录原因');
  if (!feat.includes('混进了模型的思考过程')) throw new Error('跳过原因未告知用户（不许静默）');
  if (!code.includes('混进了模型的思考过程')) throw new Error('打包产物缺提示文案（未 build:js？）');
  return true;
});
}
