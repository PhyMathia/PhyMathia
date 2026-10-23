// ===== PhyMathia 知识网络画布：工作流、分组、事件与启动 =====

// 流式渲染节流：多路并行流式时，把“全图 measure + 节点 transform + 边重绘”合并为
// 最长 ~150ms 一次，避免每个流式块都全图强刷（原实现每帧对全部节点/全部边做同步布局
// 与整层 SVG 重建，图越大越闪烁）。流式内容本身仍即时局部更新。
// 流式卡片渲染节流（T218）：三处流式 scheduleRender 共用。旧实现每 rAF 帧
// （≈16ms）整卡 innerHTML 重建＋KaTeX 全量重跑，长文本整流 O(n²)（对照 chat.js
// 同路径 250ms 节流）。流式中的卡是「生长中」视觉反馈，250ms 一跳足够顺；流结束
// 各自的收尾渲染一次性铺最终全文，终态不受节流影响。
const GRAPH_STREAM_RENDER_MS = 250;

let _graphSyncTimer = null;
function _scheduleGraphSync() {
  if (_graphSyncTimer) return;
  _graphSyncTimer = setTimeout(() => {
    _graphSyncTimer = null;
    if (typeof _measureNodes === 'function') _measureNodes();
    // 谁真的动了：写同一个 transform 字符串的节点不算（绝大多数节点每拍都是白写）
    const moved = (typeof _updateNodeTransforms === 'function') ? _updateNodeTransforms() : null;
    // 2026-10-16：这一拍原先无条件 `_redrawEdges()`——把整层 <path> 拆掉重铺。真流式
    // 期间实测每秒 2~3 次（SVG 子树每秒 30+ 次增删、每秒重建 13 个边元素），正是
    // 「重新生成节点时边框与连线快速闪动」的机器侧来源：整层失效 + 边光晕滤镜重新
    // 光栅化，机器越快越看不出来，Windows/Edge 上就是可见的闪。
    // 现在走拖拽/缩放同款的增量路径：只有真动了的节点所连的边改 d。
    // 两道闸保证不丢结构：①层签名对不上（新边/删边/换画布）→ 整层重建；②快速路径
    // 自己返回 false（边元素缺失/曲线编辑中）→ 整层重建。
    const layerStale = (typeof _edgeLayerSigOk === 'function') && !_edgeLayerSigOk();
    if (layerStale) {
      if (typeof _redrawEdges === 'function') _redrawEdges();
      return;
    }
    if (!moved || !moved.length) return;
    const keys = (typeof _edgesTouchingNodeIds === 'function') ? _edgesTouchingNodeIds(moved) : null;
    if (!keys || !keys.length) return;
    if (typeof _refreshEdgeGeometry !== 'function' || !_refreshEdgeGeometry(keys)) {
      if (typeof _redrawEdges === 'function') _redrawEdges();
    }
  }, 150);
}

// （chat.js / chat-features.js / quiz-ui.js / harness-run.js，后者是变体），
// 本轮只合并了本文件这 3 份。那 4 处的合并见 docs/backlog.md，同样卡在硬规则 6
// 的真发验证上（要动发送链路，没有可用凭证时不能合）。
//
// **只吐正文增量，绝不碰 reasoning_content。** 思维链与正文必须分两条通道攒；
// `delta.content || delta.reasoning_content` 那种写法会把思维链灌进正文，
// 那是 2026-09-15「旋度那座岛全程静默消失」的根因（docs/dev/knowledge-pipeline.md）。
// 将来真要思维链，在这里显式加第二个 yield，不许改回或的那个。
//
// 读帧静默看门狗（T359，2026-10-17）：上游把字出完却不断连（没有 [DONE]、也不再发帧）
// 时，reader.read() 永远挂着、for-await 永不结束——屏幕上是全文，收尾落盘那一行却永远
// 执行不到，换设备/刷新后就是空卡。这里给每次读帧配一个静默上限：超时即取消读流并抛出，
// 落到各调用方的 catch（复位忙账＋版本账兜回上一版＋落盘）——坏连接从「静默丢内容」变成
// 一次可见的生成失败。名字用 TimeoutError 不用 AbortError：中止是用户动作（回等待态），
// 超时是失败（该报错、该可重试）。上限取 2 分钟：思考型模型两次增量之间偶有长静默，
// 别把正常慢流误判成挂死。
const GRAPH_STREAM_IDLE_TIMEOUT_MS = 120000;
function _readStreamChunk(reader) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      // 取消读流＝放弃这条响应体（上游连接随之断开），免得挂死的连接一直占着
      try { reader.cancel(); } catch (e) { /* 已结束/已取消：忽略 */ }
      const err = new Error('AI 流式响应超时：' + Math.round(GRAPH_STREAM_IDLE_TIMEOUT_MS / 1000) + ' 秒没有收到新内容，已断开');
      err.name = 'TimeoutError';
      reject(err);
    }, GRAPH_STREAM_IDLE_TIMEOUT_MS);
    reader.read().then(
      (result) => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); },
      (err) => { if (settled) return; settled = true; clearTimeout(timer); reject(err); },
    );
  });
}

// 每 4 帧让出一次事件循环：流式期间合成 DOM 渲染有帧预算，别让读流饿死它。
// （让出的时机从「渲染前」挪到了「渲染后」——两者都是每 4 帧喘一次，语义等价。）
async function* _sseContentFrames(resp) {
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let frameCount = 0;
  while (true) {
    const { done, value } = await _readStreamChunk(reader);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();   // 最后一段可能不完整，留到下一轮再拼
    for (const part of parts) {
      for (const line of part.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (dataStr === '[DONE]') continue;
        let data = null;
        try { data = JSON.parse(dataStr); } catch (e) {}
        if (data && data.error) {
          const message = data.detail || data.error.detail || data.error.message || JSON.stringify(data.error);
          throw new Error('AI 流式返回错误：' + message);
        }
        const delta = data && data.choices && data.choices[0] && data.choices[0].delta;
        if (delta && delta.content) {
          yield delta.content;
          frameCount++;
          if (frameCount % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }
  }
}

async function _streamCustomNodeResponse(resp, node) {
  let content = '';
  let renderPending = false;
  let saveTimer = null;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      // 可视化卡片一旦挂载就不再每帧重建 iframe（巨型可视化反复重载 = “全屏节点不停闪”的直接来源），
      // 流式中只更新源码文本框；内容完成时由统一渲染一次性重新挂载。
      const vizMounted = renderBox && (renderBox.querySelector('.viz-card') || renderBox.querySelector('.viz-iframe'));
      if (renderBox && live && !vizMounted) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
        if (typeof _initVizIframes === 'function') _initVizIframes(renderBox);
      }
      const textarea = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-content');
      if (textarea) textarea.value = content;
      if (node.kind === 'blank') _renderBlankNodeLive(node, content);
      _scheduleGraphSync();
    }, GRAPH_STREAM_RENDER_MS);
  }

  // 流式周期落盘（T359，对齐 blank 路的 scheduleSave）：这一路原先只在 for-await 收尾
  // 保存一次——中途关页/刷新/断流（含 T359 看门狗掐断前的所有帧）屏幕上明明已有全文，
  // 盘上却还是空的（用户 2026-10-17 报「屏幕已见全文、换设备回空」的正主）。400ms 一拍
  // 与 blank 路同档：够便宜，又保证「看到过的字」最多丢半秒。
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      _saveCustomNodes();
    }, 400);
  }

  try {
    for await (const piece of _sseContentFrames(resp)) {
      content += piece;
      _scheduleWorkflowStreamProgress(content.length);
      scheduleRender();
      scheduleSave();
    }
  } catch (err) {
    // 半成品随错误一起交出去（T359）：连接断在半路时，字只攒在这个局部变量里，抛出去
    // 调用方就再也看不到「屏幕上已经出现过的内容」了——挂在 err 上让它能兜住。
    if (err && typeof err === 'object') err.streamPartial = content;
    throw err;
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  let cleaned = node.kind === 'module' ? _cleanBlankNodeContent(node, content) : content;
  if (!cleaned.trim()) cleaned = content;
  const live = _findGraphNode(node.id);
  if (live) {
    live.content = cleaned;
    live.summary = _graphSummary(cleaned);
    live.status = 'done';
    live.generatedAt = Date.now();
    live.inputHash = _nodeInputHash(live);
    live.busy = false;
  }
  _saveCustomNodes();
  if (node.kind === 'blank') _renderBlankNodeLive(node, cleaned);
  _refreshWorkflowNodeStatusUi(live);
}

async function _streamAnalysisResponse(resp, node, question) {
  let analysis = '';
  let renderPending = false;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (!live) return;
      live.analysis = analysis;
      const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
      if (renderBox) {
        renderBox.innerHTML = _renderCustomNodeContentHtml(live);
        if (typeof renderMath === 'function') renderMath(renderBox);
      }
      _scheduleGraphSync();
    }, GRAPH_STREAM_RENDER_MS);
  }

  for await (const piece of _sseContentFrames(resp)) {
    analysis += piece;
    _scheduleWorkflowStreamProgress(analysis.length);
    scheduleRender();
  }

  let cleaned = analysis.trim();
  if (typeof stripXmlTags === 'function') cleaned = stripXmlTags(cleaned).trim();
  if (!cleaned) throw new Error('问题分析返回空内容');
  if (cleaned.length > 1200) cleaned = cleaned.slice(0, 1200);
  const live = _findGraphNode(node.id);
  if (live) {
    live.analysis = cleaned;
    live.analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
    live.status = 'done';
    live.busy = false;
  }
  const renderBox = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-custom-node-render');
  if (renderBox && live) {
    renderBox.innerHTML = _renderCustomNodeContentHtml(live);
    if (typeof renderMath === 'function') renderMath(renderBox);
  }
  _saveCustomNodes();
  _refreshWorkflowNodeStatusUi(live);
  if (typeof hideProgress === 'function') hideProgress();
}

function _refreshWorkflowNodeStatusUi(node) {
  if (!node) return;
  if (workflowRunActive) {
    if (typeof _refreshWorkflowNodeUi === 'function') _refreshWorkflowNodeUi(node);
  } else {
    renderGraphCanvas();
  }
}

// ===== 节点级中断信号（任务列表「停单个节点」的底座） =====
// 全局停止仍旧是 workflowAbortController 那条总闸；per-node 取消走每个节点自己的
// controller。没传信号的老调用点自动退回总闸，行为一字不变。
function _workflowAbortSignal() {
  return workflowAbortController ? workflowAbortController.signal : null;
}

function _workflowGlobalAborted() {
  const signal = _workflowAbortSignal();
  return !!(signal && signal.aborted);
}

function _workflowNodeSignal(nodeSignal) {
  if (nodeSignal) return nodeSignal;
  return _workflowAbortSignal() || new AbortController().signal;
}

function _workflowNodeAborted(nodeSignal) {
  if (nodeSignal && nodeSignal.aborted) return true;
  return _workflowGlobalAborted();
}

// 面板里节点条目的排列顺序：干活模块按画布位置从左到右，总结/汇聚这类收口的排最后
// （与用户给的面板草图一致：物理视角 → 数学视角 → 交互可视化 → 总结）。
function _taskWorkNodeOrder(a, b) {
  const rank = node => (node.kind === 'summary' || node.kind === 'hub') ? 1 : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  const ax = Number.isFinite(a.x) ? a.x : 0;
  const bx = Number.isFinite(b.x) ? b.x : 0;
  if (ax !== bx) return ax - bx;
  const ay = Number.isFinite(a.y) ? a.y : 0;
  const by = Number.isFinite(b.y) ? b.y : 0;
  return ay - by;
}

async function _generateAnalysis(node, nodeSignal) {
  if (!node || node.busy) return;
  const question = _findQuestionContentUpstream(node);
  if (!question.trim()) {
    node.status = 'waiting';
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(node);
    if (typeof showToast === 'function') showToast('请先连接并填写问题节点');
    return;
  }
  node.busy = true;
  node.status = 'running';
  _saveCustomNodes();
  if (workflowRunActive) _refreshWorkflowNodeUi(node);
  else renderGraphCanvas();
  if (typeof showProgress === 'function') showProgress('thinking', 8, '正在分析问题');

  // T328：带上游（追问来源卡 A 全文）——旧实现只带裸问题，画布问答又不写
  // 会话消息表，模型在零上下文下把机械波的 T·Δs 读成热力学 T·ΔS（见 T328）
  const workflowContext = _buildAnalysisWorkflowContext(node, question, { kind: 'answer', label: '问题分析' });
  // T330：分析卡「带要求重新分析」——requirements 由重生成面板写进来，随 hash 进
  // 短路判定，也直接进提示词；没有要求时维持原提示词一字不变
  const reqText = String(node.requirements || '').trim();
  const prompt = '请分析用户问题，只输出简洁的问题概要。'
    + (reqText ? '\n用户对本次分析的额外要求（优先满足）：' + reqText + '\n' : '')
    + '要求：1) 核心物理概念；2) 核心数学结构；3) 物理与数学的关系；4) 相关知识点。'
    + '不要输出完整答案，不要输出 XML 标签，不要生成任何模块内容，控制在300字以内。';
  const branchMeta = {
    parentId: String(node.timestamp || ''),
    sourceModule: '',
    branchType: '',
    branchId: '',
    branchLabel: '问题分析',
    graphPath: [],
    workflowContext,
    wfStats: _wfStatsForNode(node),
  };
  const signal = _workflowNodeSignal(nodeSignal);
  const blankStartedAt = Date.now();

  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        // 取材附图（T381）：问题分析是首问链的第一跳（追问/方向钮/苏格拉底支线
        // 都先过这里），上游素材篮的图随分析请求一起给模型——图与分析依据同源，
        // 否则模型只能对着「图片未转写」的占位猜
        const images = await _workflowImageDataUrls(node);
        resp = await _sendWithImagesFallback(images, imgs => proxyChat(
          prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          _workflowSessionId(),
          true,
          signal,
          branchMeta,
          imgs ? { images: imgs } : {}
        ));
      }
    }
    if (!resp) {
      throw new Error('未配置 AI 模型，请在模型设置中配置');
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamAnalysisResponse(resp, node, question);
  } catch (err) {
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
    }
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(live);
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('问题分析失败：' + (err.message || err));
    if (typeof hideProgress === 'function') hideProgress();
  }
}

function _slotCallForWorkflowNode(node) {
  // T361：苏格拉底反馈节点沿用闭环的 branch 槽（旧消息链 sendQuick 走 proxyChat 的
  // isSocraticOrLearn 判定），不跟随主模型——本地/便宜模型跑闭环是既有配置能力。
  if (node && node.socraticMeta && typeof getActiveModelForRole === 'function') {
    const socraticModel = getActiveModelForRole('branch');
    if (socraticModel) return { model: socraticModel, role: 'branch' };
  }
  // 配方声明模型槽位（P2，model_role）：优先用指定槽（html/branch/graph/quiz/descriptor），
  // 槽位没配模型时回落主模型——与官方 viz 的 html 槽回落口径一致。
  // 2026-10-11 起同时返回落点槽位 role：思考档位跟提供模型的槽走（getSlotThinkingForRole）
  const recipeRole = node && node.recipeId && node.recipe && node.recipe.generate
    ? String(node.recipe.generate.model_role || '') : '';
  if (recipeRole && recipeRole !== 'agent' && typeof getActiveModelForRole === 'function') {
    const roleModel = getActiveModelForRole(recipeRole);
    if (roleModel) return { model: roleModel, role: recipeRole };
  }
  if (node && node.kind === 'module' && (node.moduleKey === 'socratic' || node.moduleKey === 'learn') && typeof getActiveModelForRole === 'function') {
    // 苏格拉底追问/进阶学习优先使用单独配置的 branch 模型，未配置时再跟随主模型。
    const branchModel = getActiveModelForRole('branch');
    if (branchModel) return { model: branchModel, role: 'branch' };
  }
  if (node && node.kind === 'module' && node.moduleKey === 'viz' && typeof getActiveModelForRole === 'function') {
    // 交互可视化优先使用专门配置的 HTML 生成模型，避免弱主模型反复输出空内容。
    const htmlModel = getActiveModelForRole('html');
    if (htmlModel) return { model: htmlModel, role: 'html' };
  }
  if (typeof getActiveModelForRole === 'function') {
    const agentModel = getActiveModelForRole('agent');
    if (agentModel) return { model: agentModel, role: 'agent' };
  }
  return null;
}

function _normalizeWorkflowVizContent(content) {
  const html = typeof extractHtmlFromModelReply === 'function' ? extractHtmlFromModelReply(content) : '';
  if (html && (typeof _looksLikeCompleteHtml === 'function' ? _looksLikeCompleteHtml(html) : html)) {
    return '```html\n' + html + '\n```';
  }
  return '';
}

// ===== 取材附图（2026-10-23 打通；T381 2026-10-23 接全部发送链）=====
// 上游素材篮的图随消息发给模型（多模态直接看图）：图片条目＝原图，扫描版 PDF＝
// 前几页现渲染（T382，配额与压缩分别在 _collectUpstreamImages / _sourceBlobDataUrl）。
// 收集路与该节点的 workflowContext 同源——首问/模块生成走全祖先，配方 first_inbound
// 与空白节点走单父链，苏格拉底闭环作答刻意不带图（维持 2026-10-23 拍板）。
// 上限与压缩只在上一层定义一次（WORKFLOW_SEND_IMAGE_MAX / _sourceBlobDataUrl）。
const WORKFLOW_IMAGE_4XX_TOAST = '当前模型可能不支持看图，已去掉图片重发；可在输入节点开启「图片自动转文字」';

// 把收集到的图引用取成 dataURL 列表；一份都取不到＝null（调用方按纯文本发）。
// 图是增益：任何一张取不到/压不动都静默跳过，不挡发送（与 OCR 关同口径）
async function _workflowImageDataUrls(node, route) {
  const refs = typeof _collectUpstreamImages === 'function'
    ? _collectUpstreamImages(node, route) : [];
  if (!refs.length) return null;
  const urls = await Promise.all(refs.map(ref => {
    if (ref && ref.page) {
      return typeof _sourcePdfPageDataUrl === 'function'
        ? _sourcePdfPageDataUrl(ref.fileId, ref.page) : null;
    }
    return typeof _sourceImageDataUrl === 'function' ? _sourceImageDataUrl(ref.fileId) : null;
  }));
  const dataUrls = urls.filter(Boolean);
  return dataUrls.length ? dataUrls : null;
}

// 附图发送的回落骨架（全发送链共用一支，T381）：send(images) 由调用方决定拼哪种
// 请求体；有图被上游 4xx 拒（非视觉模型收到 image_url 常整请求 400）就去图重发
// 一次并提示开 OCR；5xx/网络错原样抛，不吞真实故障。无图时 first 即唯一一次。
async function _sendWithImagesFallback(images, send) {
  try {
    return await send(images);
  } catch (err) {
    const m = /^API (\d{3}):/.exec(String((err && err.message) || ''));
    if (!images || !m || m[1][0] !== '4') throw err;
    const retry = await send(null);
    if (typeof showToast === 'function') showToast(WORKFLOW_IMAGE_4XX_TOAST);
    return retry;
  }
}

async function _workflowSendWithImages(node, slotCall, payload, signal) {
  const images = await _workflowImageDataUrls(node);
  return _sendWithImagesFallback(images, imgs => proxyChatWithModel(
    slotCall.model,
    imgs ? Object.assign({}, payload, { images: imgs }) : payload,
    signal
  ));
}

async function _generateCustomNode(node, nodeSignal) {
  if (!node || node.busy) return;
  // T361：苏格拉底反馈节点也是 answer 底座，但它走自己的闭环口径（见下方 soc 分支），
  // 不再被「answer 节点一律走问题分析」的旧闸门挡在门外。
  if (node.kind === 'answer' && !node.manual && !node.socraticMeta) return;
  if (node.kind === 'hub') return;
  // 版本账（T339）：旧内容先收进账本再清空——生成期间节点从空白重写，旧版随时 ‹› 切回
  _beginWorkflowNodeVersionCycle(node);
  node.busy = true;
  node.status = 'running';
  _saveCustomNodes();
  if (workflowRunActive) _refreshWorkflowNodeUi(node);
  else renderGraphCanvas();

  const recipe = node.recipeId && node.recipe ? node.recipe : null;
  // T361：苏格拉底闭环节点（socraticMeta）走闭环自己的口径——prompt 是提交瞬间定稿的
  // [苏格拉底回答]/[提示]/[讲解] 原文；**不带 workflow_context**（服务端据此选
  // BRANCH_SYSTEM_PROMPT 而不是 MODULE_SYSTEM_PROMPT）；branch_type=socratic 与
  // branch_id 原样进 /api/models/chat，闭环状态机（连对次数/已答轮数）与
  // <socratic_meta> 记账一字不改地接着跑。
  const socratic = node.socraticMeta && typeof node.socraticMeta === 'object' ? node.socraticMeta : null;
  // 配方双阶段（P2，analysis_phase＝问题分析式）：正文生成前先产出问题概要，写进
  // 自身 analysis——提示词与 workflow_context 拿到与官方 answer 同款的「隐藏分析」
  if (recipe && recipe.analysis_phase) {
    await _recipeGenerateAnalysis(node, nodeSignal);
  }
  const workflowContext = socratic ? {} : _buildWorkflowContextForNode(node);
  const prompt = socratic ? String(socratic.prompt || '') : _workflowPromptForNode(node, workflowContext);
  const graphPath = _blankNodeGraphPath(node);
  const pathParent = graphPath[graphPath.length - 1];
  const branchMeta = socratic ? {
    parentId: socratic.parentId || (pathParent ? String(pathParent.timestamp || '') : String(node.timestamp || '')),
    sourceModule: socratic.sourceModule || 'socratic',
    branchType: 'socratic',
    branchId: socratic.branchId || '',
    branchLabel: socratic.branchLabel || '苏格拉底闭环',
    graphPath,
    wfStats: _wfStatsForNode(node),
  } : {
    parentId: pathParent ? String(pathParent.timestamp || '') : String(node.timestamp || ''),
    sourceModule: node.moduleKey || '',
    branchType: 'blank',
    branchId: '',
    branchLabel: workflowContext.target.label,
    graphPath,
    workflowContext,
    wfStats: _wfStatsForNode(node),
  };
  const signal = _workflowNodeSignal(nodeSignal);

  try {
    let resp = null;
    const slotCall = _slotCallForWorkflowNode(node);
    if (slotCall && typeof proxyChatWithModel === 'function') {
      const payload = {
        prompt,
        level: typeof currentLevel !== 'undefined' ? currentLevel : 'university',
        session_id: _workflowSessionId(),
        stream: true,
        thinking: getSlotThinkingForRole(slotCall.role),
        parent_id: branchMeta.parentId,
        source_module: branchMeta.sourceModule,
        branch_type: branchMeta.branchType,
        branch_id: branchMeta.branchId,
        branch_label: branchMeta.branchLabel,
        graph_path: branchMeta.graphPath,
        workflow_context: branchMeta.workflowContext,
        wfStats: branchMeta.wfStats,
      };
      // 苏格拉底闭环口径不动（不带图，闭环状态机不掺视觉素材）；其余首问/模块
      // 生成走附图发送——上游素材篮的图片原图随消息给多模态模型
      resp = socratic
        ? await proxyChatWithModel(slotCall.model, payload, signal)
        : await _workflowSendWithImages(node, slotCall, payload, signal);
    }
    if (!resp) {
      throw new Error('未配置 AI 模型，请在模型设置中配置');
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    let streamError = null;
    try {
      await _streamCustomNodeResponse(resp, node);
    } catch (err) {
      streamError = err;
      console.warn('Viz module direct stream failed, will try fallback:', err);
      const failedLive = _findGraphNode(node.id);
      const vizCarrier = (node.kind === 'module' && node.moduleKey === 'viz')
        || !!(recipe && recipe.content_kind === 'html_iframe');
      const partial = String((err && err.streamPartial) || '');
      // 超时断流的半成品兜底（T359）：上游字出完却不断连是「内容多半已经全了」的断法，
      // 按未跑完入账落地——屏幕上的字不消失，用户看得见、可再点重新生成；viz 载体半页
      // HTML 不可用，仍走下面的归一+重试/兜回旧版。
      if (failedLive && !vizCarrier && err && err.name === 'TimeoutError' && partial.trim()) {
        const salvage = node.kind === 'module' ? _cleanBlankNodeContent(failedLive, partial) : partial;
        failedLive.content = salvage.trim() ? salvage : partial;
        failedLive.summary = _graphSummary(failedLive.content);
        failedLive.busy = false;
        failedLive.status = 'error';
        // 版本账（T339）：这一版按「未跑完」入账（旧文仍在前一位，‹› 可回）
        _commitWorkflowNodeVersion(failedLive);
        _saveCustomNodes();
        _refreshWorkflowNodeStatusUi(failedLive);
        if (typeof showToast === 'function') showToast('连接超时、生成没跑完：已保留收到的内容，可重新生成');
        return;
      }
      if (failedLive) {
        failedLive.content = '';
        failedLive.busy = false;
      }
    }

    const live = _findGraphNode(node.id);
    // viz 式收口（官方交互可视化＋P2 配方 html_iframe 载体）：内容必须归一成完整
    // HTML 代码块；不合格时按配方声明的重试预算（on_incomplete.max_retries，官方 1 次）
    // 与重试提示词（retry_prompt）走独立 HTML 生成通道重试
    const vizLike = live && ((node.kind === 'module' && node.moduleKey === 'viz') || (recipe && recipe.content_kind === 'html_iframe'));
    if (vizLike) {
      let normalized = _normalizeWorkflowVizContent(live.content || '');
      let vizRetryMessage = streamError && streamError.message ? streamError.message : '';
      const maxRetries = recipe && recipe.generate && recipe.generate.on_incomplete
        ? Math.max(0, Math.min(2, Number(recipe.generate.on_incomplete.max_retries) || 0))
        : 1;
      const retryHint = recipe && recipe.generate && recipe.generate.retry_prompt
        ? recipe.generate.retry_prompt
        : '上一次尝试没有返回完整 HTML。请务必只输出从 <!DOCTYPE html> 到 </html> 的完整页面。';
      if (!normalized && typeof _requestVisualizationHtml === 'function') {
        // 自动重试：改用更严格的独立 HTML 生成提示词，减少“节点为空/只有文字”的情况。
        const sourceText = [
          workflowContext.question,
          workflowContext.analysis,
          ...(workflowContext.upstream || []).map(item => item.label + '：' + (item.summary || item.content || '')),
        ].filter(Boolean).join('\n\n').slice(0, 12000);
        for (let attempt = 0; attempt < maxRetries && !normalized; attempt++) {
          try {
            const retryHtml = await _requestVisualizationHtml(sourceText || prompt, signal, retryHint);
            normalized = '```html\n' + retryHtml + '\n```';
          } catch (retryErr) {
            vizRetryMessage = retryErr && retryErr.message ? retryErr.message : String(retryErr || '');
            console.warn('Viz module automatic retry failed:', retryErr);
          }
        }
      }
      if (!normalized) {
        const wasAborted = _workflowNodeAborted(nodeSignal);
        live.content = '';
        live.summary = '';
        live.status = wasAborted ? 'waiting' : 'error';
        live.busy = false;
        // 版本账（T339）：这轮没产出可用内容，兜回上一版（账上有版本时旧内容原样回来）
        _restoreWorkflowNodeVersion(live);
        _saveCustomNodes();
        if (workflowRunActive) _refreshWorkflowNodeUi(live);
        else renderGraphCanvas();
        if (!wasAborted && typeof showToast === 'function') {
          showToast('交互可视化生成失败：' + (vizRetryMessage || '模型未返回完整 HTML，请点击该节点重试'));
        }
        return;
      }
      live.content = normalized;
      live.summary = _graphSummary(normalized);
      live.status = 'done';
      live.busy = false;
      // 版本账（T339）：归一后的整页 HTML 收作新版本
      _commitWorkflowNodeVersion(live);
      _saveCustomNodes();
      if (workflowRunActive) _refreshWorkflowNodeUi(live);
      else renderGraphCanvas();
      if (recipe && recipe.on_generated) _recipeAfterGenerated(live);
      return;
    }
    // mermaid 载体归一（P2）：模型没按代码块围栏输出时补一层 ```mermaid，
    // 渲染层就能走官方知识图谱同一条路（renderMarkdown → renderMermaidInElement）
    if (live && recipe && recipe.content_kind === 'mermaid' && !streamError) {
      const raw = String(live.content || '').trim();
      if (raw && raw.indexOf('```mermaid') < 0) {
        const bare = raw.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/```\s*$/, '').trim();
        live.content = '```mermaid\n' + bare + '\n```';
        live.summary = _graphSummary(live.content);
      }
    }
    if (streamError) throw streamError;
    if (live && !(live.content || '').trim()) {
      live.status = 'error';
      live.busy = false;
      // 版本账（T339）：空内容不算新版本，兜回上一版
      _restoreWorkflowNodeVersion(live);
      _saveCustomNodes();
      _refreshWorkflowNodeStatusUi(live);
      if (typeof showToast === 'function') showToast('生成失败：模型返回了空内容，请点击该节点重试');
      return;
    }
    // 版本账（T339）：成功收账（放在 mermaid 归一之后——归一改写过的 content 才是落定的版本）
    _commitWorkflowNodeVersion(live);
    // on_generated 编排钩子（P2）：生成成功后按声明自动建链（进阶学习四步链的数据版）
    if (live && recipe && recipe.on_generated) _recipeAfterGenerated(live);
    // T361：苏格拉底反馈落地后把回复里的建议追问抽成派生「苏格拉底追问」节点
    // （闭环下一题），并结算本轮（profile 记账＋闭环结束复位）
    if (live && live.socraticMeta) _materializeSocraticFollowup(live);
  } catch (err) {
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
      // 版本账（T339）：流式草稿不算数，兜回上一版——中止/失败都不丢旧内容
      _restoreWorkflowNodeVersion(live);
    }
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(live);
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
  }
}


// ===== T361：苏格拉底反馈 → 派生「苏格拉底追问」节点（闭环下一题）=====
// 旧消息链里 sq- 节点由 _buildGraphData 从 assistant 消息切片时顺手派生；工作流链不写
// 消息表，派生改在这里显式落地：解析 <socratic_meta>（结算闭环状态/画像记账）＋建议
// 追问列表（1. [基础] …），写一颗 module/socratic 自定义节点挂在该反馈节点下，下一轮
// 「我来回答」就落在它身上。同一颗反馈节点重生成时更新既有派生节点，不重复长点。
function _parseSocraticMetaAttrs(content) {
  const match = String(content || '').match(/<socratic_meta\b([^>]*?)\/?>/i);
  if (!match) return null;
  const attrs = match[1] || '';
  const pick = (name) => {
    const found = attrs.match(new RegExp('\\b' + name + '\\s*=\\s*["\']([^"\']*)["\']', 'i'));
    return found ? found[1] : '';
  };
  return {
    correct: pick('correct').trim().toLowerCase(),
    done: ['1', 'true', 'yes'].includes(pick('done').trim().toLowerCase()),
  };
}

function _materializeSocraticFollowup(answerNode) {
  const live = (typeof _findGraphNode === 'function' ? _findGraphNode(answerNode.id) : null) || answerNode;
  if (!live || !live.socraticMeta) return;
  const content = String(live.content || '');
  const meta = _parseSocraticMetaAttrs(content);
  const suggested = (typeof _parseSuggestedFollowupQuestions === 'function')
    ? _parseSuggestedFollowupQuestions(content) : [];
  // 闭环结束（done）或连对达标：复位内存里的闭环指针，下一题重开一条分支
  if (meta && meta.done) {
    if (typeof currentBranch !== 'undefined') currentBranch = null;
    if (typeof currentBranchId !== 'undefined') currentBranchId = null;
  }
  // 画像/检测记账：与旧消息链 chat.js 的 recordSocraticAnswer 同一口径。同一颗节点
  // 重生成出同样判定时不重复记账（旧链路每次生成都是新消息、无从去重；节点化之后
  // 有稳定身份，按「判定签名」去重才不虚增答题统计）。
  const sm = live.socraticMeta || {};
  const recordKey = meta && meta.correct ? meta.correct + '/' + (meta.done ? '1' : '0') : '';
  if (recordKey && sm.recordedMeta !== recordKey && typeof window.recordSocraticAnswer === 'function') {
    sm.recordedMeta = recordKey;
    _saveCustomNodes();
    window.recordSocraticAnswer({
      title: sm.question || '苏格拉底追问',
      question: sm.question || '',
      correct: meta.correct === 'correct',
      sessionId: _workflowSessionId(),
      level: sm.level === 'advanced' ? '进阶' : sm.level === 'expand' ? '拓展' : '基础',
    });
  }
  if (!suggested.length) return;
  const worldSid = _workflowWorldSid() || _workflowSessionId();
  const state = _graphStateFor(worldSid);
  state.customNodes = state.customNodes || [];
  state.connections = state.connections || [];
  const text = '### 苏格拉底追问\n\n' + suggested.map(q => '- [' + q.levelName + '] ' + q.question).join('\n');
  const summary = suggested.map(q => q.question).join('；').slice(0, 120);
  const existing = state.customNodes.find(cn => cn && cn.sqAuto && String(cn.parentId || '') === String(live.id));
  if (existing) {
    existing.content = text;
    existing.items = suggested;
    existing.summary = summary;
    existing.status = 'done';
    existing.generated = true;
    existing.busy = false;
    _saveGraphStateFor(worldSid, state);
    renderGraphCanvas();
    if (typeof _taskExtendWorkflowWorld === 'function') _taskExtendWorkflowWorld([existing.id]);
    return;
  }
  const sqId = 'sq-' + live.id;
  const savedPos = (state.positions || {})[sqId];
  const sqNode = {
    id: sqId,
    kind: 'module',
    moduleKey: 'socratic',
    sqAuto: true,
    manual: false,
    content: text,
    status: 'done',
    summary: summary,
    items: suggested,
    parentId: live.id,
    timestamp: Date.now(),
    createdAt: Date.now(),
    x: savedPos ? savedPos.x : (Number.isFinite(live.x) ? live.x + 460 : 120),
    y: savedPos ? savedPos.y : (Number.isFinite(live.y) ? live.y + 250 : 320),
    depth: (Number.isFinite(live.depth) ? live.depth : 2) + 1,
    targetAngle: 0,
    isRoot: false,
    busy: false,
    generated: true,
    analysis: '',
    requirements: '',
  };
  state.customNodes.push(sqNode);
  state.connections.push({
    from: live.id,
    fromPort: 'out-' + ANSWER_OUTPUT_INDEX.socratic,
    to: sqId,
    toPort: 'in-0',
    type: 'custom',
    custom: true,
  });
  _saveGraphStateFor(worldSid, state);
  renderGraphCanvas();
  if (typeof _taskExtendWorkflowWorld === 'function') _taskExtendWorkflowWorld([sqId]);
}

async function _processWorkflowChainItem(current, force, nodeSignal) {
  if (!current) return false;
  if (current.messageIndex >= 0) return true;
  if (_workflowNodeAborted(nodeSignal)) return false;

  if (current.kind === 'hub') {
    const hasInput = _workflowEdgeTable().some(edge => String(edge.to) === current.id && !edge.draft);
    current.status = hasInput ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'source') {
    current.status = current.items && current.items.length ? 'done' : 'waiting';
    return true;
  }
  if ((current.kind === 'knowledge' || current.kind === 'relation') && !current.recipeId) {
    current.status = (current.content || '').trim() ? 'done' : 'waiting';
    return true;
  }

  if (current.kind === 'answer' && !current.manual) {
    // T361：苏格拉底反馈节点重生成走闭环口径（_generateCustomNode 的 socratic 分支），
    // 不是问题分析——否则点「重新生成」会把闭环反馈换成一张问题分析。
    if (current.socraticMeta) {
      await _generateCustomNode(current, nodeSignal);
      return !_workflowNodeAborted(nodeSignal);
    }
    if (current.busy) return false;
    const question = _findQuestionContentUpstream(current);
    if (!question.trim()) {
      current.status = 'waiting';
      _saveCustomNodes();
      _refreshWorkflowNodeStatusUi(current);
      if (typeof showToast === 'function') showToast('请先连接并填写问题节点');
      return false;
    }
    const analysisHash = _simpleHash(question + '|' + (current.requirements || ''));
    // force（T330：分析卡三角「从头生成」/面板留空直发）＝用户点名重跑，不做 hash 短路
    if (force || !current.analysis || current.analysisHash !== analysisHash) {
      await _generateAnalysis(current, nodeSignal);
    } else {
      current.status = 'done';
    }
    return !_workflowNodeAborted(nodeSignal);
  }

  if (current.kind === 'user' || current.manual) {
    if (!(current.content || '').trim()) {
      current.status = 'waiting';
      _saveCustomNodes();
      _refreshWorkflowNodeStatusUi(current);
      if (typeof showToast === 'function') showToast('请先填写 ' + (current.kind === 'note' ? '我的总结' : current.manual ? '我的回答' : '问题') + ' 内容');
      return false;
    }
    current.status = 'done';
    return true;
  }

  const inputHash = _nodeInputHash(current);
  // 人工定稿护栏（T355）：整链跑动会拉上游依赖进子图，人工定稿节点即使 hash 因上游
  // 重生成而失配，也不许在这里被 _generateCustomNode 静默覆盖。force（显式从头生成
  // 这颗）例外——那是用户点名要换掉这颗的内容
  if (!force && current.humanDone && (current.content || '').trim()) {
    current.status = 'done';
    return true;
  }
  if (!force && (current.content || '').trim() && current.inputHash === inputHash && current.status === 'done') return true;
  await _generateCustomNode(current, nodeSignal);
  return !_workflowNodeAborted(nodeSignal);
}

function _workflowDependencyEdges() {
  const seen = new Set();
  return _workflowEdgeTable().filter(edge => {
    if (edge.draft || !edge.from || !edge.to || edge.from === edge.to) return false;
    const key = String(edge.from) + '|' + String(edge.to);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function _buildWorkflowSubgraph(targetIds) {
  const allEdges = _workflowDependencyEdges();
  const ids = new Set();
  const stack = (targetIds || []).filter(id => _findGraphNode(id));
  while (stack.length) {
    const id = stack.pop();
    if (ids.has(id)) continue;
    ids.add(id);
    for (const edge of allEdges) {
      if (edge.to === id && !ids.has(edge.from)) stack.push(edge.from);
    }
  }
  const edges = allEdges.filter(edge => ids.has(edge.from) && ids.has(edge.to));
  return { ids, edges };
}

function _workflowReadyNodes(subgraph, processed, failed, blocked) {
  const ready = [];
  for (const id of subgraph.ids) {
    if (processed.has(id) || failed.has(id) || blocked.has(id)) continue;
    const node = _findGraphNode(id);
    if (!node || node.busy) continue;
    const deps = subgraph.edges.filter(edge => edge.to === id);
    if (deps.every(edge => processed.has(edge.from))) ready.push(node);
  }
  ready.sort((a, b) => {
    const pa = a.moduleKey === 'viz' ? 0 : 1;
    const pb = b.moduleKey === 'viz' ? 0 : 1;
    return pa - pb;
  });
  return ready;
}

function _workflowPendingNodeIds(subgraph, processed, failed, blocked) {
  return [...subgraph.ids].filter(id => !processed.has(id) && !failed.has(id) && !blocked.has(id));
}

// 上游没了（失败，或被用户从面板上停掉）的下游：标成「上游缺失」（用户拍板 #10）。
// 只写 blocked、不写 waiting——waiting 是「等输入」，这两种「等」在画布上必须分得开。
function _markWorkflowDependentsBlocked(failedId, subgraph, processed, blocked, runtime) {
  const stack = [failedId];
  const taskId = runtime && runtime.taskId;
  while (stack.length) {
    const id = stack.pop();
    for (const edge of subgraph.edges) {
      if (edge.from !== id || processed.has(edge.to) || blocked.has(edge.to)) continue;
      blocked.add(edge.to);
      const node = _findGraphNode(edge.to);
      if (node && node.status !== 'done') node.status = 'blocked';
      _refreshWorkflowNodeStatusUi(node);
      if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, edge.to, 'blocked', '上游缺失', true);
      stack.push(edge.to);
    }
  }
  // 立刻落盘：不然「上游缺失」只在屏幕上活着，切走再回来就又变回待生成了
  _saveCustomNodes();
}

async function _runWorkflowNodeConcurrent(node, subgraph, force, processed, failed, blocked, runtime) {
  // 并发重复触发兜底：busy＝已有一份在途请求在生成这颗节点（手动点重生成撞上
  // 自动工作流、两条入口同一 tick 派发等）。本 worker 直接空转不归档——失败/
  // 完成/进度都由在途请求自己的 worker 收尾，两次记账不会互相覆盖。正常路径
  // _workflowReadyNodes/入口 busy 门挡在前面，这里是双保险
  if (node.busy) return;
  const shouldForce = force && (node.kind === 'module' || node.kind === 'summary');
  const shouldCount = _workflowItemNeedsProgress(node) || shouldForce;
  const taskId = runtime ? runtime.taskId : null;
  if (shouldCount) _markWorkflowCurrentNode(node);
  // 每颗节点一个 controller：面板上的「停」只掐这一颗，不惊动同轮的其他节点
  const nodeController = new AbortController();
  // 登记进登记簿：总闸按下时 stopWorkflowRun 要能连这颗在跑的节点一起掐断（T299）
  workflowInFlightControllers.add(nodeController);
  if (runtime) {
    runtime.nodeControllers.set(node.id, nodeController);
    if (_workflowGlobalAborted()) nodeController.abort();
  }
  const label = _workflowProgressLabel(node);
  if (shouldCount && typeof _taskNodeStart === 'function') _taskNodeStart(taskId, node.id, label, nodeController);
  (window.__wfLogs = window.__wfLogs || []).push({ type: 'start', label, t: Date.now() });
  console.log('[Workflow] start', label, Date.now());
  let ok = false;
  try {
    ok = await _processWorkflowChainItem(node, shouldForce, nodeController.signal);
  } catch (err) {
    console.error('Workflow node failed:', err);
    const live = _findGraphNode(node.id);
    if (live) {
      live.busy = false;
      if (live.status !== 'error') live.status = 'error';
    }
    _saveCustomNodes();
    _refreshWorkflowNodeStatusUi(live);
  }
  (window.__wfLogs = window.__wfLogs || []).push({ type: 'done', label, t: Date.now() });
  console.log('[Workflow] done ', label, Date.now());
  const live = _findGraphNode(node.id);
  const errored = !!(live && live.status === 'error');
  const globalAborted = _workflowGlobalAborted();
  const nodeStopped = nodeController.signal.aborted && !globalAborted;
  const aborted = globalAborted || nodeStopped;
  if (runtime) runtime.nodeControllers.delete(node.id);
  // 摘登记（正常完成/失败/被单停都走这儿；被总闸掐断的也走这儿——见上面 catch 后直落）
  workflowInFlightControllers.delete(nodeController);
  if (nodeStopped) {
    // 用户停掉了这一颗：它自己算失败（不再重试），下游按「上游缺失」传播
    if (runtime) runtime.userStopped = (runtime.userStopped || 0) + 1;
    if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, node.id, 'stopped', '已取消', true);
    failed.add(node.id);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked, runtime);
  } else if (errored || (!ok && !aborted)) {
    if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, node.id, 'error', '失败', true);
    failed.add(node.id);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked, runtime);
  } else {
    if (shouldCount && typeof _taskNodeFinish === 'function') {
      _taskNodeFinish(taskId, node.id, globalAborted ? 'stopped' : (ok ? 'done' : 'error'),
        globalAborted ? '已停止' : (ok ? '' : '未生成'));
    }
    processed.add(node.id);
  }
  if (shouldCount && !aborted) _advanceWorkflowProgress(label);
}

async function _runWorkflowGraph(subgraph, force, runtime, forceTargets) {
  const processed = new Set();
  const failed = new Set();
  const blocked = new Set();
  const pendingQueue = [];
  const inFlight = new Set();
  const userCancelled = (runtime && runtime.userCancelled) ? runtime.userCancelled : new Set();
  const taskId = runtime ? runtime.taskId : null;
  let runningWorkers = 0;
  let completed = true;

  // 用户在面板上停掉了还没轮到的节点：跳过它，并把「上游缺失」传下去
  function skipCancelled(node) {
    if (!node || !userCancelled.has(node.id) || processed.has(node.id) || failed.has(node.id)) return false;
    failed.add(node.id);
    if (typeof _taskNodeFinish === 'function') _taskNodeFinish(taskId, node.id, 'stopped', '已取消', true);
    _markWorkflowDependentsBlocked(node.id, subgraph, processed, blocked, runtime);
    return true;
  }

  function enqueueReadyNodes() {
    const ready = _workflowReadyNodes(subgraph, processed, failed, blocked);
    for (const node of ready) {
      if (skipCancelled(node)) continue;
      if (!inFlight.has(node.id) && !pendingQueue.some(item => item.id === node.id)) {
        pendingQueue.push(node);
      }
    }
  }

  async function runWorker() {
    runningWorkers++;
    try {
      while (true) {
        if (_workflowGlobalAborted()) {
          completed = false;
          break;
        }
        // 软暂停（用户拍板 #3）：不再派新节点，已经在跑的跑完。没有剩余活儿时照常
        // 收尾——不然工作流会卡在这道闸门前，永远等不到「继续」的那一天。
        if (typeof _taskCtxPaused === 'function' && _taskCtxPaused()) {
          if (inFlight.size === 0) {
            enqueueReadyNodes();
            if (!pendingQueue.length) break;
          }
          await new Promise(resolve => setTimeout(resolve, 120));
          continue;
        }
        const node = pendingQueue.shift();
        if (!node) {
          if (inFlight.size > 0) {
            await new Promise(resolve => setTimeout(resolve, 50));
            enqueueReadyNodes();
            continue;
          }
          const pending = _workflowPendingNodeIds(subgraph, processed, failed, blocked);
          if (pending.length) {
            completed = false;
            if (typeof showToast === 'function') {
              const hasCycle = pending.some(id =>
                subgraph.edges.some(edge =>
                  edge.to === id
                  && !processed.has(edge.from)
                  && !failed.has(edge.from)
                  && !blocked.has(edge.from)
                )
              );
              showToast(hasCycle ? '检测到循环依赖，已停止' : '存在失败依赖，已跳过相关节点');
            }
          }
          break;
        }
        if (skipCancelled(node)) {
          enqueueReadyNodes();
          continue;
        }
        inFlight.add(node.id);
        try {
          await _runWorkflowNodeConcurrent(node, subgraph,
            force && (!forceTargets || forceTargets.has(node.id)), processed, failed, blocked, runtime);
        } finally {
          inFlight.delete(node.id);
          enqueueReadyNodes();
        }
      }
    } finally {
      runningWorkers--;
    }
  }

  enqueueReadyNodes();
  const workerCount = Math.min(WORKFLOW_MAX_CONCURRENCY, Math.max(1, subgraph.ids.size));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return completed && failed.size === 0 && blocked.size === 0;
}

// 工作流运行级统计（2026-10-14 T326）：每轮开跑生成 runId、按拓扑深度给节点
// 编波次，随记账请求带 wfStats {run, node, wave, hash} 上后端（usage JSONL →
// 用量面板「波」列）。只做观测——不进 prompt、不进 inputHash 判定；wave 标签
// 与调度推进顺序天然一致（_workflowReadyNodes 逐层放行），不改调度本身。
let _wfRunStats = null;

// 请求上带的统计标签。run 外调用（手动单节点模板链等）返回 null，后端据此
// 记普通明细行。hash 复用去重判定同源的 _nodeInputHash——同一份输入口径，
// 面板上「哪次调用其实发的是同一份输入」肉眼可查
function _wfStatsForNode(node) {
  if (!node || !_wfRunStats) return null;
  const wave = _wfRunStats.waves && typeof _wfRunStats.waves.get === 'function'
    ? _wfRunStats.waves.get(node.id) : undefined;
  return {
    run: _wfRunStats.run,
    node: String(node.id || ''),
    wave: Number.isFinite(wave) ? wave : 0,
    hash: String(_nodeInputHash(node) || ''),
  };
}

// wave = 到源节点的最长依赖深度：问题/分析为 0，同层兄弟同号，汇聚/总结 +1。
// 迭代式拓扑求深（节点不动员 DFS 递归，深链也不爆栈）
function _workflowWaveMap(subgraph) {
  const depths = new Map();
  const indeg = new Map();
  const outgoing = new Map();
  for (const id of subgraph.ids) { indeg.set(id, 0); outgoing.set(id, []); }
  for (const edge of subgraph.edges) {
    if (!indeg.has(edge.from) || !indeg.has(edge.to)) continue;
    indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [];
  for (const [id, deg] of indeg) { if (deg === 0) { depths.set(id, 0); queue.push(id); } }
  let settled = 0;
  while (queue.length) {
    const id = queue.shift();
    settled++;
    const depth = depths.get(id) || 0;
    for (const to of (outgoing.get(id) || [])) {
      const next = Math.max(depths.get(to) || 0, depth + 1);
      depths.set(to, next);
      indeg.set(to, (indeg.get(to) || 0) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }
  // 环形依赖的遗留节点（调度层会报「循环依赖」拦住）：发 -1 之前给个 0 兜底
  if (settled < subgraph.ids.size) {
    for (const id of subgraph.ids) { if (!depths.has(id)) depths.set(id, 0); }
  }
  return depths;
}

async function _executeParallelWorkflow(targetIds, force, meta) {
  const subgraph = _buildWorkflowSubgraph(targetIds);
  if (!subgraph.ids.size) {
    if (typeof showToast === 'function') showToast('没有可运行的节点');
    return;
  }
  // force 只许作用在显式指定的目标节点上，不许跟着子图传染：子图会沿连线上溯把来源
  // 节点圈进来（追问/重新生成的目标正好挂在上游），force 若对全子图生效，用户正要
  // 追问的那颗模块/总结节点会被整颗重写、原内容丢失（2026-10-02 用户实测：追问数学
  // 视角节点，数学视角内容被重新生成）。上游节点靠「内容没变就不重跑」的既有口径自然跳过。
  const forceTargets = new Set(targetIds || []);
  const workflowStartedAt = Date.now();
  // 运行级统计上下文（T326）：runId 每轮唯一——手动重跑/排队重放/刷新后重来
  // 天然分成不同轮，面板上各自归组；wave 拓扑深度在本轮图定形后一次算好
  _wfRunStats = {
    run: 'wf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    waves: _workflowWaveMap(subgraph),
  };
  window.__wfLogs = [];
  workflowRunActive = true;
  workflowLastAborted = false;
  workflowAbortController = new AbortController();
  _setWorkflowStopButton(true);
  const countedNodes = [...subgraph.ids]
    .map(id => _findGraphNode(id))
    .filter(node => node && (_workflowItemNeedsProgress(node)
      || (force && forceTargets.has(node.id) && (node.kind === 'module' || node.kind === 'summary'))));
  const totalWork = countedNodes.length;
  // 任务列表：这一轮工作流 = 一条任务，节点明细 = 组里的条目（用户拍板的两级结构）。
  // 开跑前就把「要干哪几颗」记全，面板因此一眼能看到「3/6 已完成」这样的总数。
  const workNodes = countedNodes
    .slice()
    .sort(_taskWorkNodeOrder)
    .map(node => ({ id: node.id, label: _workflowProgressLabel(node) }));
  const taskId = (typeof _tasksBeginWorkflow === 'function')
    ? _tasksBeginWorkflow({
        title: (meta && meta.title) || '生成工作流',
        force: !!force,
        workNodes,
        allIds: [...subgraph.ids],
      })
    : null;
  // T285：开场就把这条任务行的 canceller 绑到总闸 stopWorkflowRun()——绑之前面板上的
  // 「停」/「全部停止」/「全部清空」对工作流行只是账面动作（无 canceller 直接结成
  // 「已停止」），节点在后台继续生成。三入口自此与画布进度条同一闸；收尾 finally
  // 按 wasAborted 落「已停止/手动停止」。
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => stopWorkflowRun());
  }
  const runtime = (taskId && typeof _taskActiveCtx !== 'undefined' && _taskActiveCtx
      && _taskActiveCtx.taskId === taskId)
    ? Object.assign({ taskId }, _taskActiveCtx.runtime)
    : null;
  // 排队中的那条任务（「提问」/节点生成）被这一轮接手了：**开跑前**就地结掉，面板上
  // 从始至终只有一行活账（那条「等待中」直接变成这行的「进行中」）。2026-10-11 从
  // finally 挪到这儿：留在 finally 的话整轮跑动期间面板上会吊着一条永远「等待中」的行，
  // 用户以为它还没轮到。
  if (meta && meta.handoffTaskId && typeof _taskFinish === 'function') {
    _taskFinish(meta.handoffTaskId, 'done', '已交给工作流');
  }
  _showWorkflowProgress(totalWork);
  let completed = false;
  try {
    completed = await _runWorkflowGraph(subgraph, force, runtime, forceTargets);
  } finally {
    const wasAborted = _workflowGlobalAborted();
    workflowLastAborted = wasAborted;
    const userCancelled = runtime ? runtime.userCancelled.size : 0;
    const userStopped = runtime ? (runtime.userStopped || 0) : 0;
    workflowRunActive = false;
    workflowAbortController = null;
    _wfRunStats = null;
    _setWorkflowStopButton(false);
    _hideWorkflowProgress();
    _saveCustomNodes();
    renderGraphCanvas();
    // 任务列表结账。**必须排在 _flushSendQueue 之前**：放行排队请求可能切会话
    // （队列项自带来处），而结账用的还是这一轮任务的账本与上下文。
    if (taskId && typeof _tasksEndWorkflow === 'function') {
      const taskState = wasAborted ? 'stopped' : (completed ? 'done' : 'partial');
      const taskNote = wasAborted ? '手动停止'
        : ((userCancelled || userStopped) ? '有节点被停掉' : (completed ? '' : '有节点没跑完'));
      _tasksEndWorkflow(taskId, taskState, taskNote);
    }
    // 排队那条任务的结账在开跑前已经做过（见上面 handoffTaskId 处）：放行它的队列
    // 收尾那发 _taskFinish 找不到活账，自然空转，不会把这一轮的账搅乱。
    // 队列里还有东西时不报「工作流完成」：这轮完了但活儿没完，而且下一条马上
    // 自动开跑，完成卡片会跟新进度撞在一起（chat.js 的「回复完成」同此口径）。
    if (!wasAborted && completed && typeof notifyTaskCompleted === 'function'
        && !(typeof _hasPendingSend === 'function' && _hasPendingSend())) {
      let parallelInfo = '';
      const wfLogs = window.__wfLogs || [];
      const moduleStarts = wfLogs
        .filter(e => e.type === 'start' && e.label && e.label !== '我的回答' && e.label !== '问题分析')
        .map(e => e.t);
      if (moduleStarts.length > 1) {
        const spread = Math.max.apply(null, moduleStarts) - Math.min.apply(null, moduleStarts);
        parallelInfo = ' · 并行开始 ' + moduleStarts.length + ' 个 · 时间差 ' + spread + 'ms';
      }
      notifyTaskCompleted(Date.now() - workflowStartedAt, '工作流完成' + parallelInfo);
    }
    // 排队请求在这条最长的通道上等得最久（免费模型一次工作流 2-8 分钟），
    // 放行点必须挂在工作流的 finally 上，不能只靠 sendMessage 那侧。
    if (typeof _flushSendQueue === 'function') await _flushSendQueue();
  }
}

// ===== 节点版本历史（2026-10-15 T339）：重新生成/从头生成保留旧版本，可 ‹› 切换、可删 =====
// 账本住在节点对象上（node.versions + node.activeVersion），随 _saveCustomNodes 的整对象
// 快照自动落盘、随撤销 checkpoint（JSON 深克隆）自动入历史。不变量：node.content 恒等于
// node.versions[node.activeVersion].content——凡是绕过账本直接改 content 的路（Φ 改图、
// 人工编辑、旧数据），都会在下一次生成开跑时被 _commitWorkflowNodeVersion 收编，旧内容不丢。
// 流式/修订写到一半的草稿不算版本：失败/中止由 _restoreWorkflowNodeVersion 兜回上一版。
var GRAPH_NODE_VERSION_MAX = 10;

function _nodeVersionsOf(node) {
  if (!node) return [];
  if (!Array.isArray(node.versions)) node.versions = [];
  return node.versions;
}

function _nodeActiveVersionIndex(node, versions) {
  const total = versions.length;
  if (!total) return -1;
  if (typeof node.activeVersion === 'number' && node.activeVersion >= 0 && node.activeVersion < total) {
    return node.activeVersion;
  }
  return total - 1;
}

// 把节点当前 content 收进版本账本；与 activeVersion 指的那版逐字相同则不重收
function _commitWorkflowNodeVersion(node) {
  if (!node || node.messageIndex >= 0) return;
  const content = String(node.content || '');
  if (!content.trim()) return;
  const versions = _nodeVersionsOf(node);
  const av = _nodeActiveVersionIndex(node, versions);
  if (versions[av] && versions[av].content === content) {
    node.activeVersion = av;
    versions[av].humanDone = !!node.humanDone;
    return;
  }
  // humanDone（T355）随版本入账：切版/回滚时标记跟着内容走，不会出现「内容是人工
  // 定稿、标记却丢在工作流重写里」的错位
  versions.push({ content: content, at: Date.now(), humanDone: !!node.humanDone });
  if (versions.length > GRAPH_NODE_VERSION_MAX) versions.splice(0, versions.length - GRAPH_NODE_VERSION_MAX);
  node.activeVersion = versions.length - 1;
}

// 生成开跑前：旧内容先收账、立刻清空 content——新内容从空白流式写出（2026-10-15 用户拍板：
// 不许旧文压着新流）。失败/中止由 _restoreWorkflowNodeVersion 兜回上一版。
function _beginWorkflowNodeVersionCycle(node) {
  if (!node || node.messageIndex >= 0) return;
  _commitWorkflowNodeVersion(node);
  node.content = '';
  // 人工定稿就此交棒给 AI 重写（T355）：旧版已入账且带着标记，失败回滚或 ‹› 切回
  // 时标记随内容恢复；生成成功则节点回到 AI 内容口径
  node.humanDone = false;
}

// 失败/中止结算：content 兜回 activeVersion 那一版（草稿不算数）；账上没版本就清空回未生成态
function _restoreWorkflowNodeVersion(node) {
  if (!node || node.messageIndex >= 0) return;
  const versions = _nodeVersionsOf(node);
  if (!versions.length) {
    node.activeVersion = undefined;
    node.humanDone = false;
    if ((node.content || '') !== '') {
      node.content = '';
      node.summary = '';
    }
    return;
  }
  const av = _nodeActiveVersionIndex(node, versions);
  node.activeVersion = av;
  node.humanDone = !!versions[av].humanDone;
  if (String(node.content || '') !== versions[av].content) {
    node.content = versions[av].content;
    node.summary = typeof _graphSummary === 'function' ? _graphSummary(node.content) : node.content.slice(0, 120);
  }
}

// ‹› 切版本：切到的版本就是节点内容——下游取材、导出、全屏读到的都是它（显示即内容）
function graphNodeVersionStep(nodeId, dir) {
  const node = _findGraphNode(nodeId);
  if (!node || node.busy) return;
  if (typeof _regeneratingNodes !== 'undefined' && _regeneratingNodes.has(nodeId)) return;
  const versions = _nodeVersionsOf(node);
  if (!versions.length) return;
  const av = _nodeActiveVersionIndex(node, versions);
  const next = Math.min(versions.length - 1, Math.max(0, av + (dir < 0 ? -1 : 1)));
  if (next === av) return;
  node.activeVersion = next;
  node.content = versions[next].content;
  node.summary = typeof _graphSummary === 'function' ? _graphSummary(node.content) : node.content.slice(0, 120);
  node.humanDone = !!versions[next].humanDone;
  _saveCustomNodes();
  if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
  renderGraphCanvas();
}

// 删掉当前看到的这个版本：删完看邻位（同位次的新版优先，删末版看前版）；删到最后一版＝
// 节点回到未生成态（内容清空、动作区回「生成」键），再想要就从「从头生成」重跑
function graphNodeVersionDelete(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || node.busy) return;
  if (typeof _regeneratingNodes !== 'undefined' && _regeneratingNodes.has(nodeId)) return;
  const versions = _nodeVersionsOf(node);
  if (!versions.length) return;
  const av = _nodeActiveVersionIndex(node, versions);
  versions.splice(av, 1);
  if (versions.length) {
    node.activeVersion = Math.min(av, versions.length - 1);
    node.content = versions[node.activeVersion].content;
    node.summary = typeof _graphSummary === 'function' ? _graphSummary(node.content) : node.content.slice(0, 120);
    node.humanDone = !!versions[node.activeVersion].humanDone;
  } else {
    node.activeVersion = undefined;
    node.content = '';
    node.summary = '';
    node.humanDone = false;
  }
  _saveCustomNodes();
  if (typeof invalidateKnowledgeCache === 'function') invalidateKnowledgeCache();
  renderGraphCanvas();
  if (typeof showToast === 'function') showToast(versions.length ? '已删除该版本，现显示相邻版本' : '已删除该版本，节点内容已清空');
}

// 单个节点的「生成/重新生成」。忙的时候不再拒绝，改成排队（2026-10-11）：
// 用户把任务列表当"多任务排队台"用，点一下就该有回音——收进队列、面板上看得见、
// 轮到它时自动切回这张画布跑起来。fromQueue 是放行旁路（同 sendMessage 的 force /
// startQuestionWorkflow 的 fromQueue，见 send-queue.js 的 T225 注）。
async function runWorkflowNode(nodeId, force = false, fromQueue = false, handoffTaskId = null, confirmed = false) {
  const node = _findGraphNode(nodeId);
  if (!node || node.messageIndex >= 0) return;
  // busy=这颗节点已有在途生成（自动工作流/另一次手动触发）：静默 return 用户
  // 看不出所以然， toe 一下让人知道点了有反应。进 _isSendBusy 队列的是发送
  // 总线忙的场景，与本分支不同
  if (node.busy) {
    if (typeof showToast === 'function') showToast('「' + _workflowProgressLabel(node) + '」正在生成中，稍候');
    return;
  }
  // 重生成预警（T303）：改写内容前确认下游可能失效。排队轮到/任务重试
  // （fromQueue/handoffTaskId）视为用户已确认过，不再二次弹窗；2026-10-13 起面板路
  // （带要求重生成）提示写在面板里、发送即确认，走 confirmed=true 旁路
  if (force && !fromQueue && !handoffTaskId && !confirmed && !_warnDownstreamBeforeRegenerate(node)) return;
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const capturedForce = !!force;
    const label = '生成' + _workflowProgressLabel(node);
    _enqueueNodeJob(label, function(taskId) {
      // 轮到它时先看那颗节点还在不在（等待期间可能被删/被撤销）：不在就地把账结失败，
      // 别让队列收尾顺手记成「已完成」
      if (typeof _queuedJobNodeGuard === 'function' && !_queuedJobNodeGuard(taskId, nodeId)) return;
      return runWorkflowNode(nodeId, capturedForce, true, taskId);
    }, {
      kind: 'workflow',
      // 重试语义与工作流任务同型：记下要跑哪几颗，失败后能从面板上重跑
      replay: { nodeIds: [nodeId], force: capturedForce },
    });
    return;
  }
  await _executeParallelWorkflow([nodeId], force, {
    title: '生成' + _workflowProgressLabel(node),
    handoffTaskId,
  });
}

// 一组节点的重生成（任务列表「重试」走这里）。忙时同样收进队列，返回 true 表示
// 「已经安排上了」——调用方（_taskRegenerate）靠它区分「排队了」与「节点没了」。
// anchorSid（T313）：排队条目自带来处用——工作流跑动期间配方 on_generated 建出的
// 子节点属于世界画布，放行时要把视图带回世界；用户手点的活儿不传（默认按当前画布
// 记账，_sendQueueReady 本来就会把视图带回它那边）。
async function runWorkflowNodes(nodeIds, force = false, fromQueue = false, handoffTaskId = null, anchorSid = '') {
  const ids = (Array.isArray(nodeIds) ? nodeIds : []).filter(id => {
    const node = _findGraphNode(id);
    return node && node.messageIndex < 0 && !node.busy
      && (node.kind === 'module' || node.kind === 'blank' || node.kind === 'summary' || node.kind === 'answer');
  });
  if (!ids.length) {
    // busy 滤空（或节点已删除）也给个回音，别让按钮看起来没点上
    if (typeof showToast === 'function') showToast('所选节点都在生成中或已不在画布上');
    return false;
  }
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const capturedForce = !!force;
    _enqueueNodeJob('生成 ' + ids.length + ' 个节点', function(taskId) {
      return runWorkflowNodes(ids, capturedForce, true, taskId).then(function(ran) {
        // 等待期间节点可能被删/被改动，轮到它时一颗都不剩：就地结失败，别记成「已完成」
        if (ran === false && typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '节点已不在画布上');
      });
    }, {
      kind: 'workflow',
      replay: { nodeIds: ids.slice(), force: capturedForce },
      sessionId: anchorSid || undefined,
    });
    return true;
  }
  await _executeParallelWorkflow(ids, !!force, { title: '生成 ' + ids.length + ' 个节点', handoffTaskId });
  return true;
}

async function runAllWorkflowNodes() {
  // 防重跑：只运行空节点/依赖发生变化的节点，已生成且未变化的直接跳过
  const targets = graphView.nodes.filter(node => node.messageIndex < 0 && (node.kind === 'module' || node.kind === 'summary') && _workflowItemNeedsProgress(node));
  if (!targets.length) {
    if (typeof showToast === 'function') showToast('没有需要生成的模块/总结节点');
    return;
  }
  const ids = targets.map(node => node.id);
  if (typeof _isSendBusy === 'function' && _isSendBusy()) {
    _enqueueNodeJob('全部生成', function(taskId) {
      // 轮到它时重新筛一遍：刚才忙的那一轮可能已经把其中几颗干完了，别白重跑一遍
      const pending = ids.filter(id => {
        const node = _findGraphNode(id);
        return node && !node.busy && _workflowItemNeedsProgress(node);
      });
      if (!pending.length) {
        if (typeof _taskFinish === 'function') _taskFinish(taskId, 'done', '轮到它时已经没有要生成的节点了');
        return;
      }
      return runWorkflowNodes(pending, false, true, taskId).then(function(ran) {
        if (ran === false && typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '节点已不在画布上');
      });
    }, {
      kind: 'workflow',
      replay: { nodeIds: ids, force: false },
    });
    return;
  }
  await _executeParallelWorkflow(ids, false, { title: '全部生成' });
}

function stopWorkflowRun() {
  if (workflowAbortController) workflowAbortController.abort();
  // T299：在跑的节点一起掐断。总闸只断自己的话，这最多 6 颗并行节点会各自把当前这
  // 一流式跑完（免费模型一颗几十秒到几分钟），用户点了「停止生成」还在出字——
  // 按钮全程有反应、活儿不停，就是按钮失灵的样子。
  workflowInFlightControllers.forEach(function(controller) { controller.abort(); });
}

function _renderBlankNodeLive(node, content) {
  let el = graphInner?.querySelector('[data-node-id="' + node.id + '"] .graph-blank-content');
  if (!el && graphInner && node) {
    const host = graphInner.querySelector('[data-node-id="' + node.id + '"] .graph-node-main');
    const requirement = host?.querySelector('.graph-blank-requirement');
    if (host) {
      el = document.createElement('div');
      el.className = 'graph-blank-content';
      if (requirement) host.insertBefore(el, requirement);
      else host.appendChild(el);
    }
  }
  if (!el || !content) return;
  const cleaned = _cleanBlankNodeContent(node, content);
  el.innerHTML = typeof renderMarkdown === 'function'
    ? renderMarkdown(cleaned, { sourceModule: node.moduleKey })
    : escapeHtml(cleaned);
  if (typeof renderMath === 'function') renderMath(el);
  if (typeof _initVizIframes === 'function') _initVizIframes(el);
}

function _syncBlankNodeControls(node) {
  const root = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
  const btn = root?.querySelector('.graph-blank-generate-btn, .graph-regen-btn.graph-icon-btn');
  const input = root?.querySelector('.graph-blank-input');
  if (btn) {
    btn.disabled = false;
    btn.title = node.content ? '重新生成' : '生成';
  }
  if (input) input.disabled = false;
}

async function _streamBlankNodeResponse(resp, node) {
  let content = '';
  let renderPending = false;
  let saveTimer = null;

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      const live = _findGraphNode(node.id);
      if (live) live.content = content;
      _renderBlankNodeLive(node, content);
      _scheduleGraphSync();
    }, GRAPH_STREAM_RENDER_MS);
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      _saveCustomNodes();
    }, 400);
  }

  try {
    for await (const piece of _sseContentFrames(resp)) {
      content += piece;
      _scheduleWorkflowStreamProgress(content.length);
      scheduleRender();
      scheduleSave();
    }
  } catch (err) {
    // 半成品随错误一起交出去（T359）：见 _streamCustomNodeResponse 同注
    if (err && typeof err === 'object') err.streamPartial = content;
    throw err;
  }

  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const live = _findGraphNode(node.id);
  if (live) {
    live.content = content;
    live.summary = _graphSummary(content);
    live.busy = false;
    live.generated = true;
    // 版本账（T339）：空白节点流式成品收作新版本
    _commitWorkflowNodeVersion(live);
  }
  _saveCustomNodes();
  _renderBlankNodeLive(node, content);
  _syncBlankNodeControls(node);
  _measureNodes();
  _redrawEdges();
  _updateNodeTransforms();
}

async function generateBlankNode(nodeId, fromQueue = false, handoffTaskId = null) {
  const node = _findGraphNode(nodeId);
  if (!node || node.kind !== 'blank') return;
  if (node.busy) {
    if (typeof showToast === 'function') showToast('这个空白节点正在生成中，稍候');
    return;
  }
  // 重生成预警（T303）：首次生成不弹（下游没基于任何旧内容）；重生成且有下游才确认
  if (!fromQueue && !handoffTaskId && (node.content || '').trim() && !_warnDownstreamBeforeRegenerate(node)) return;
  // 忙时排队（2026-10-11，同 runWorkflowNode）：过去这里是「工作流跑着就不许再起一条」的
  // 硬闸，用户点了只得到一句「稍候再单独生成这个节点」。现在收进队列等着，轮到它时
  // 队列把视图带回这张画布再跑——互斥仍然成立，只是把「拒绝」换成了「排队」。
  // 这道闸同时保住下面任务自带的 AbortController 不与工作流总闸共用——
  // 面板上的「停止」必须只掐这一条流，不能顺着共用 signal 把整轮工作流带走。
  if (!fromQueue && typeof _isSendBusy === 'function' && _isSendBusy()) {
    const label = '生成' + ((GRAPH_MODULE_META[node.moduleKey] || {}).label || '空白节点');
    _enqueueNodeJob(label, function(taskId) {
      if (typeof _queuedJobNodeGuard === 'function' && !_queuedJobNodeGuard(taskId, nodeId)) return;
      return generateBlankNode(nodeId, true, taskId);
    }, {
      kind: 'node',
      replay: { nodeJob: { id: nodeId, kind: 'blank' } },
    });
    return;
  }
  const input = graphInner?.querySelector('[data-node-id="' + nodeId + '"] .graph-blank-input');
  const requirements = (input?.value || '').trim();
  const incoming = (graphView.edges || []).find(edge => String(edge.to) === nodeId && !edge.draft);
  if (!incoming) {
    if (typeof showToast === 'function') showToast('请先将这个空白节点连接到问题、回答或模块节点');
    return;
  }
  const parent = _findGraphNode(incoming.from);
  if (!parent) {
    if (typeof showToast === 'function') showToast('连线来源节点不存在');
    return;
  }

  node.requirements = requirements;
  // 版本账（T339）：重跑有内容的空白节点时旧内容先收账，再清空流式重写
  _beginWorkflowNodeVersionCycle(node);
  node.content = '';
  node.busy = true;
  node.generated = true;
  _saveCustomNodes();
  renderGraphCanvas();
  const current = _findGraphNode(nodeId);
  if (!current) return;

  const meta = GRAPH_MODULE_META[current.moduleKey] || { label: current.moduleKey || 'AI 生成空白' };
  // T61：空白节点的独立生成也记一笔任务账——面板看得见、停得掉、失败可重试。
  // signal 用任务自己那颗 controller，不再借 workflowAbortController（上面已有互斥闸）。
  const jobAbort = new AbortController();
  const jobStartedAt = Date.now();
  const taskId = (typeof _taskBeginNodeJob === 'function')
    ? _taskBeginNodeJob({ title: '生成' + meta.label, nodeId: nodeId, nodeKind: 'blank' })
    : null;
  // 排队的那条任务被这笔真账接手：就地结掉，面板上不留两行（同「提问」的 handoffTaskId）
  if (handoffTaskId && typeof _taskFinish === 'function') _taskFinish(handoffTaskId, 'done', '已交给生成');
  if (taskId && typeof _taskBindCancel === 'function') {
    _taskBindCancel(taskId, () => jobAbort.abort());
  }
  if (typeof showProgress === 'function') showProgress('tool', 5, '正在生成' + meta.label);
  const graphPath = _blankNodeGraphPath(current);
  // T340：链上问题取最近一次追问（数组是根→目标序，反向扫）——旧 find 取到根问题，
  // 深链空白节点生成跟着最初的问题跑（与 _collectWorkflowContext 的 question 同修）
  const pathQuestion = _nearestUserInPath(graphPath);
  const question = pathQuestion ? pathQuestion.content || '' : '';
  const strictInstruction = _strictModuleOutputInstruction(current.moduleKey || '');
  const prompt = '用户问题：' + (question || '未填写') + '\n'
    + '请基于当前探索路径生成「' + meta.label + '」空白节点的完整内容。\n'
    + '用户额外要求：' + (requirements || '无') + '\n\n'
    + '只输出' + meta.label + '正文，不要输出 XML 标签，不要重复其他模块内容。'
    + (strictInstruction ? '\n\n' + strictInstruction : '');
  const upstreamNodes = graphPath
    .filter(item => item.kind !== 'blank' && item.kind !== 'draft')
    .map(item => {
      const rawContent = item.content || '';
      return {
        kind: item.kind,
        module: item.module || '',
        // T364：闭环身份标签与上游条目映射同口径（_workflowUpstreamEntry）；
        // socraticAnswer/socraticFeedback 两标记由 _blankNodeGraphPath 随副本带出
        label: item.kind === 'user'
          ? (item.socraticAnswer ? '我的作答' : '问题')
          : item.kind === 'answer'
            ? (item.socraticFeedback ? '苏格拉底反馈' : '问题分析')
            : ((GRAPH_MODULE_META[item.module] || {}).label || item.module || '上游节点'),
        summary: _graphSummary(_stripSocraticAnswerMarker(rawContent)) || '',
        content: _stripSocraticAnswerMarker(rawContent).slice(0, 800),
      };
    });
  const workflowContext = {
    target: { kind: current.kind, module: current.moduleKey, label: meta.label },
    question,
    requirements,
    upstream: upstreamNodes,
  };
  const pathParent = graphPath[graphPath.length - 1];
  const branchMeta = {
    parentId: pathParent ? String(pathParent.timestamp || '') : String(parent.timestamp || ''),
    sourceModule: current.moduleKey,
    branchType: 'blank',
    branchId: '',
    branchLabel: meta.label,
    graphPath,
    workflowContext,
  };
  const signal = jobAbort.signal;

  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        // 取材附图（T381）：空白节点走单父链上下文（graphPath 同一条链），图片
        // 收集也必须按 'inbound' 走——用全祖先会把链外的兄弟素材图塞进来
        const images = await _workflowImageDataUrls(current, 'inbound');
        resp = await _sendWithImagesFallback(images, imgs => proxyChat(
          prompt,
          typeof currentLevel !== 'undefined' ? currentLevel : 'university',
          typeof SESSION_ID !== 'undefined' ? SESSION_ID : '',
          true,
          signal,
          branchMeta,
          imgs ? { images: imgs } : {}
        ));
      }
    }
    if (!resp) {
      throw new Error('未配置 AI 模型，请在模型设置中配置');
    }
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error('HTTP ' + resp.status + ': ' + errText.substring(0, 200));
    }
    await _streamBlankNodeResponse(resp, current);
    if (taskId && typeof _taskFinish === 'function') _taskFinish(taskId, 'done');
    if (typeof notifyTaskCompleted === 'function') {
      notifyTaskCompleted(Date.now() - jobStartedAt, meta.label + '生成完成');
    }
    if (typeof hideProgress === 'function') hideProgress();
  } catch (err) {
    const aborted = jobAbort.signal.aborted || (err && err.name === 'AbortError');
    const live = _findGraphNode(nodeId);
    const partial = String((err && err.streamPartial) || '');
    // 超时断流的半成品兜底（T359）：与 _generateCustomNode 同口径——字已经收到就留住，
    // 按「未跑完」入账（状态失败），viz 之外不留空卡也不吞掉屏幕上出现过的内容。
    if (!aborted && live && err && err.name === 'TimeoutError' && partial.trim()) {
      live.content = partial;
      live.summary = _graphSummary(partial);
      live.busy = false;
      live.status = 'error';
      _commitWorkflowNodeVersion(live);
      if (taskId && typeof _taskFinish === 'function') _taskFinish(taskId, 'error', '连接超时，已保留收到的内容');
      _saveCustomNodes();
      renderGraphCanvas();
      if (typeof showToast === 'function') showToast('连接超时、生成没跑完：已保留收到的内容，可重新生成');
      if (typeof hideProgress === 'function') hideProgress();
      return;
    }
    if (taskId && typeof _taskFinish === 'function') {
      _taskFinish(taskId, aborted ? 'stopped' : 'error',
        aborted ? '已停止' : (((err && err.message) || String(err) || '生成失败')));
    }
    if (live) {
      live.busy = false;
      // 版本账（T339）：流式草稿不算数，兜回上一版
      _restoreWorkflowNodeVersion(live);
    }
    _saveCustomNodes();
    renderGraphCanvas();
    // 面板上的「停止」不算失败，别再弹「生成失败」吓人
    if (!aborted && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
    if (typeof hideProgress === 'function') hideProgress();
  }
}

function _addNodeIdsToGroup(groupId, nodeIds) {
  const group = _graphGroupById(groupId);
  if (!group) return false;
  _syncGroupMembersByContainment();
  const current = _graphGroupById(groupId);
  if (!current) return false;
  const ids = (nodeIds || []).filter(id => _findGraphNode(id) && !current.nodeIds.includes(id));
  if (!ids.length) return false;
  _pushGraphUndo();
  current.nodeIds = Array.from(new Set([...(current.nodeIds || []), ...ids]));
  _fitGroupToMembers(current);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  return true;
}

function graphCreateGroup() {
  const selected = Array.from(graphView.selectedNodeIds || [])
    .map(id => _findGraphNode(id))
    .filter(Boolean);
  const bounds = _graphGroupBounds(selected.map(node => node.id));
  const root = graphView.nodes.find(node => node.isRoot);
  const group = {
    id: 'grp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    name: '分组 ' + (graphView.groups.length + 1),
    color: graphDefaultGroupColor(),
    nodeIds: selected.map(node => node.id),
    x: root && !selected.length ? root.x + 90 : bounds.x,
    y: root && !selected.length ? root.y + 60 : bounds.y,
    width: selected.length ? bounds.width : 320,
    height: selected.length ? bounds.height : 180,
  };
  _pushGraphUndo();
  graphView.groups.push(group);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphRenameGroup(groupId, name) {
  const group = _graphGroupById(groupId);
  if (!group) return;
  const nextName = String(name || '').trim() || '分组';
  if (group.name === nextName) return;
  _pushGraphUndo();
  group.name = nextName;
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  const input = graphInner?.querySelector('[data-group-id="' + groupId + '"] .graph-group-name-input');
  if (input) input.value = group.name;
}

function graphSetGroupColor(groupId, color) {
  const group = _graphGroupById(groupId);
  if (!group || !color) return;
  if (group.color === color) return;
  _pushGraphUndo();
  group.color = color;
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  _updateGroupElement(group);
}

function graphAddSelectedToGroup(groupId) {
  _syncGroupMembersByContainment();
  const group = _graphGroupById(groupId);
  if (!group) return;
  const selected = Array.from(graphView.selectedNodeIds || [])
    .filter(id => !group.nodeIds.includes(id))
    .filter(id => _findGraphNode(id));
  if (!selected.length) {
    if (typeof showToast === 'function') showToast('请先框选要加入分组的节点');
    return;
  }
  _pushGraphUndo();
  group.nodeIds = Array.from(new Set([...(group.nodeIds || []), ...selected]));
  _fitGroupToMembers(group);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function graphDeleteGroup(groupId) {
  const group = _graphGroupById(groupId);
  if (!group) return;
  if (!confirm('确定删除这个分组吗？节点不会被删除。')) return;
  _pushGraphUndo();
  graphView.groups = graphView.groups.filter(item => item.id !== groupId);
  const state = _graphState();
  state.groups = graphView.groups.map(item => ({ ...item }));
  _saveGraphState(state);
  renderGraphCanvas();
}

function _deleteSelectedGraphGroups(groupIds) {
  const ids = (groupIds || []).filter(id => _graphGroupById(id));
  if (!ids.length) return;
  if (!confirm('确定删除选中的 ' + ids.length + ' 个分组吗？节点不会被删除。')) return;
  _pushGraphUndo();
  graphView.groups = graphView.groups.filter(group => !ids.includes(group.id));
  const state = _graphState();
  state.groups = graphView.groups.map(group => ({ ...group }));
  _saveGraphState(state);
  graphView.selectedGroupIds = new Set();
  _syncGraphSelectionClasses();
  renderGraphCanvas();
}

function _handleGraphKeydown(event) {
  const target = event.target;
  const inTextInput = target && typeof target.closest === 'function'
    && target.closest('input, textarea, [contenteditable], iframe');
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    if (typeof window.redoGraphAction === 'function') window.redoGraphAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && (event.key === 'y' || event.key === 'Y')) {
    if (inTextInput) return;
    event.preventDefault();
    if (typeof window.redoGraphAction === 'function') window.redoGraphAction();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'z' || event.key === 'Z')) {
    if (inTextInput) return;
    event.preventDefault();
    _undoGraphAction();
    return;
  }
  if (graphView.selectMode) return;
  // 节点复制/粘贴（ComfyUI 式剪贴板，2026-10-15）：图谱选择集 ↔ 节点剪贴板
  // （localStorage 镜像，跨画布/刷新都在）。有文字选择期放行给浏览器复制文本；
  // 输入框内一律不劫持（inTextInput 已先返回）；只读查看页的粘贴禁断在落地函数内。
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'c' || event.key === 'C')) {
    if (inTextInput) return;
    if (typeof window.getSelection === 'function' && String(window.getSelection() || '').trim()) return;
    if (!graphView.selectedNodeIds || !graphView.selectedNodeIds.size) return;
    event.preventDefault();
    const picked = Array.from(graphView.selectedNodeIds)
      .map(id => graphView.nodeById[id])
      .filter(Boolean);
    if (typeof graphCopySelectedNodes === 'function') graphCopySelectedNodes(picked);
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.shiftKey && (event.key === 'v' || event.key === 'V')) {
    if (inTextInput) return;
    if (typeof _graphClipCount !== 'function' || !_graphClipCount()) return;
    event.preventDefault();
    if (typeof graphPasteNodeClipboard !== 'function') return;
    const rect = (graphCanvas && typeof graphCanvas.getBoundingClientRect === 'function')
      ? graphCanvas.getBoundingClientRect() : null;
    const cx = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
    const cy = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
    graphPasteNodeClipboard(
      typeof _clientToGraphLocal === 'function' ? _clientToGraphLocal(cx, cy) : { x: 0, y: 0 });
    return;
  }
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (!graphCanvas || (!graphView.selectedNodeIds.size && !graphView.selectedGroupIds.size)) return;
  if (inTextInput) return;
  event.preventDefault();
  if (graphView.selectedGroupIds.size) {
    _deleteSelectedGraphGroups(Array.from(graphView.selectedGroupIds));
  } else {
    _deleteSelectedGraphNodes(Array.from(graphView.selectedNodeIds));
  }
}

function _initGraphCanvasEvents() {
  if (!graphCanvas) return;
  // 滚轮缩放按帧合并：触控板/高分辨率滚轮一次手势会连发多个 wheel 事件，逐事件同步缩放
  // 每发都做一次 getBoundingClientRect + transform 写入 + save 记账。改为「最新优先」——
  // 事件里只累乘系数、记最新光标锚点，rAF 每帧最多执行一次 zoomGraph（与拖拽
  // _handlePointerMove 的每帧一次口径一致）。preventDefault 必须同步，不能挪进 rAF。
  let _graphWheelRaf = 0, _graphWheelFactor = 1, _graphWheelX = 0, _graphWheelY = 0;
  graphCanvas.addEventListener('wheel', e => {
    const scroller = e.target.closest('.graph-node-full-content, .graph-node .mermaid-container');
    if (scroller) return;
    e.preventDefault();
    _graphWheelFactor *= e.deltaY < 0 ? 1.08 : 0.92;
    _graphWheelX = e.clientX;
    _graphWheelY = e.clientY;
    if (!_graphWheelRaf) {
      _graphWheelRaf = requestAnimationFrame(() => {
        _graphWheelRaf = 0;
        const factor = _graphWheelFactor;
        _graphWheelFactor = 1;
        zoomGraph(factor, _graphWheelX, _graphWheelY);
      });
    }
  }, { passive: false });
  graphCanvas.addEventListener('pointerdown', e => {
    // 右键/中键不进入拖拽与点选链路（右键菜单由 contextmenu 监听单独处理）：
    // 过滤必须在本处理器入口生效，_startNodeDrag/_startGroupDrag/_startCanvasPan 才不会被
    // 右键按下误触发；graph-custom.js 的 document 捕获 pointerdown（曲线拖拽 + 联系线
    // 450ms 双击检测）同样已在入口按 button 过滤（已随联系线菜单 M1 落地细化）——右键按压
    // 不再计入双击检测，快速右双击不会误开联系线弹窗。
    if (e.button !== 0) return;
    graphView.suppressClick = false;
    if (graphView.selectMode) {
      if (e.target.closest('.graph-canvas-toolbar')) return;
      if (e.target.closest('button, a, input, textarea, iframe, .graph-port, .graph-add-port-btn, .graph-port-remove')) return;
      if (e.target.closest('.graph-node, .graph-group, .graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub, .graph-draft-body, .graph-regenerate-panel')) return;
      _clearGraphTextSelection();
      _startCanvasPan(e);
      return;
    }
    if (!e.target.closest || !e.target.closest('input, textarea')) {
      _clearGraphTextSelection();
    }
    if (e.target.closest('.graph-canvas-toolbar')) return;
    if (e.target.closest('.graph-port-remove')) return;
    if (e.target.closest('.graph-output-port, .graph-input-port')) {
      _startLinkDrag(e, e.target.closest('.graph-port'));
      return;
    }
    if (e.target.closest('.graph-add-port-btn')) return;
    if (e.target.closest('button, a, input, textarea, iframe, .graph-regen-btn')) return;
    if (e.target.closest('.graph-group input, .graph-group button')) return;
    if (e.target.closest('.graph-node-full-content, .graph-blank-content, .graph-node-label, .graph-node-sub')) return;
    if (e.target.closest('.graph-group-resize-handle')) {
      const groupEl = e.target.closest('.graph-group');
      if (groupEl) _startGroupResize(e, groupEl);
      return;
    }
    const groupEl = e.target.closest('.graph-group');
    if (groupEl) {
      _startGroupDrag(e, groupEl);
      return;
    }
    if (e.target.closest('.graph-resize-handle')) {
      const nodeEl = e.target.closest('.graph-node');
      if (nodeEl) _startNodeResize(e, nodeEl);
      return;
    }
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl && !e.target.closest('button, a, input, textarea, iframe')) {
      if (graphView.linkMode) return;
      _startNodeDrag(e, nodeEl);
    } else _startCanvasPan(e);
  });
  graphCanvas.addEventListener('contextmenu', e => {
    // 自绘右键菜单（graph-contextmenu.js）。只在图谱画布内接管，画布外仍是浏览器原生菜单。
    // 1) 输入类元素放行：节点内 textarea/输入框保留粘贴、拼写等原生编辑菜单
    if (e.target && typeof e.target.closest === 'function'
      && e.target.closest('input, textarea, [contenteditable], iframe')) return;
    // 2) 文字选择模式放行：不与「选择文字/复制」抢交互
    if (graphView.selectMode) return;
    // 3) 拖动/框选过的手势不弹菜单（graphView.moved 由现有拖拽链路维护）
    if (graphView.moved) return;
    e.preventDefault();
    openGraphContextMenu(e);
  });
  graphCanvas.addEventListener('pointermove', _handlePointerMove);
  window.addEventListener('pointerup', _endPointerDrag);
  // 拖拽被系统手势/浏览器接管时 pointerup 不来：至少把装饰粒子的暂停标志恢复掉
  window.addEventListener('pointercancel', () => {
    if (graphView.symbolsPausedForDrag) {
      graphView.symbolsPausedForDrag = false;
      if (typeof window.setFloatingSymbolsPaused === 'function') window.setFloatingSymbolsPaused(false);
    }
  });
  graphCanvas.addEventListener('selectstart', e => {
    if (graphView.selectMode) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('input, textarea')) return;
    e.preventDefault();
  });
  if (!graphView.keyHandlerBound) {
    window.addEventListener('keydown', _handleGraphKeydown);
    graphView.keyHandlerBound = true;
  }
  graphCanvas.addEventListener('click', e => {
    if (graphView.suppressClick) {
      graphView.suppressClick = false;
      return;
    }
    if (graphView.selectMode) return;
    if (graphView.moved) return;
    if (e.target.closest('button, a, input, textarea, iframe, .graph-port')) return;
    const linkEdgeEl = e.target.closest('.graph-edge-link, .graph-edge-link-label');
    if (linkEdgeEl && linkEdgeEl.dataset.edgeKey) {
      // 单击联系线：进入手柄精调（钢笔式拖拽）。
      // 双击必须手动检测：进/出精调态都会 _redrawEdges() 替换 SVG 元素，
      // 浏览器原生 dblclick 会落在公共祖先容器上，closest('.graph-edge') 永远失配。
      const linkKey = linkEdgeEl.dataset.edgeKey;
      const now = Date.now();
      const last = graphView._lastLinkEdgeClick || null;
      if (last && last.key === linkKey && (now - last.t) < 450
          && Math.abs(last.cx - e.clientX) < 10 && Math.abs(last.cy - e.clientY) < 10) {
        graphView._lastLinkEdgeClick = null;
        graphView.edgeCurveEditKey = null;
        openLinkEdgeModal(linkKey);
        return;
      }
      graphView._lastLinkEdgeClick = { key: linkKey, t: now, cx: e.clientX, cy: e.clientY };
      if (typeof window.enterLinkCurveEdit === 'function') window.enterLinkCurveEdit(linkKey);
      return;
    }
    if (graphView.linkMode) {
      const linkNodeEl = e.target.closest('.graph-node');
      if (linkNodeEl) _graphLinkPickNode(linkNodeEl.dataset.nodeId);
      return;
    }
    const groupEl = e.target.closest('.graph-group');
    if (groupEl) {
      const id = groupEl.dataset.groupId;
      if (_isGraphModifier(e)) {
        _toggleGraphGroupSelection(id);
      } else if (graphView.selectedGroupIds.has(id)) {
        graphView.selectedGroupIds.delete(id);
        _syncGraphSelectionClasses();
      } else {
        _setGraphGroupSelection([id], false);
      }
      return;
    }
    const nodeEl = e.target.closest('.graph-node');
    if (nodeEl) {
      const id = nodeEl.dataset.nodeId;
      if (_isGraphModifier(e)) {
        _toggleGraphSelection(id);
      } else if (graphView.selectedNodeIds.has(id)) {
        graphView.selectedNodeIds.delete(id);
        _syncGraphSelectionClasses();
      } else {
        _setGraphSelection([id], false);
      }
    } else {
      _clearGraphSelection();
    }
  });
  graphCanvas.addEventListener('dblclick', e => {
    if (graphView.selectMode || graphView.linkMode) {
      // 静默返回会让用户误以为双击编辑坏了；给出原因提示
      if (typeof showToast === 'function') {
        showToast(graphView.linkMode
          ? '联系模式中：完成连线或再次点击工具栏退出后，才能双击编辑'
          : '文字选择模式中：先点击「选择文字」按钮退出，再双击编辑');
      }
      return;
    }
    const edgeEl = e.target.closest('.graph-edge');
    if (edgeEl && edgeEl.dataset.edgeKey) {
      e.preventDefault();
      e.stopPropagation();
      // 联系线（联系模式创建的注释性箭头）：双击打开编辑弹窗；
      // 其余连线（端口拖出的父子关系）：双击=删除（tooltip 有说明）
      const edgeKey = edgeEl.dataset.edgeKey;
      const edge = (graphView.edges || []).find(item => _edgeKey(item) === edgeKey);
      if (edge && edge.link) {
        openLinkEdgeModal(edgeKey);
        return;
      }
      _removeGraphEdge(edgeKey);
      if (typeof showToast === 'function') showToast('已删除连线（Ctrl+Z 可撤销）');
      return;
    }
    const dblNodeEl = e.target.closest('.graph-node');
    if (dblNodeEl) {
      const dblNode = _findGraphNode(dblNodeEl.dataset.nodeId);
      if (dblNode && dblNode.kind === 'human_note') {
        e.preventDefault();
        e.stopPropagation();
        editHumanNoteNode(dblNode.id);
        return;
      }
    }
    if (e.target.closest('.graph-node, .graph-group, .graph-port, .graph-canvas-toolbar')) return;
    const point = _clientToGraphLocal(e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    openAddBlankNodeModal(point.x, point.y);
  });
}

function _applyGraphTextSelectionMode() {
  if (!graphCanvas) return;
  graphCanvas.classList.toggle('graph-select-mode', !!graphView.selectMode);
  const btn = graphCanvas.querySelector('.graph-select-btn');
  if (btn) {
    btn.classList.toggle('active', !!graphView.selectMode);
    btn.title = graphView.selectMode ? '退出文字选择' : '选择文字';
    btn.setAttribute('aria-pressed', String(!!graphView.selectMode));
  }
  if (!graphView.selectMode) _clearGraphTextSelection();
}

function graphToggleTextSelection() {
  graphView.selectMode = !graphView.selectMode;
  _applyGraphTextSelectionMode();
}

function _unhideGraphNodeForFocus(node) {
  if (!node) return;
  const state = _graphState();
  let changed = false;
  const keys = [];
  const timestamp = String(node.timestamp || '');
  if (node.kind === 'module' && node.moduleKey) keys.push(timestamp + ':' + node.moduleKey);
  if (node.kind === 'answer') keys.push(timestamp + ':answer');
  if (node.id) keys.push(String(node.id));
  for (const key of keys) {
    if (state.hidden[key]) {
      delete state.hidden[key];
      node.hidden = false;
      changed = true;
    }
    if (state.collapsed[key]) {
      delete state.collapsed[key];
      node.minimized = false;
      changed = true;
    }
  }
  // 自定义节点的最小化状态存在 customNodes 里，定位时一并清除
  if (node.messageIndex < 0 && Array.isArray(state.customNodes)) {
    const cn = state.customNodes.find(function (x) { return String(x.id) === String(node.id); });
    if (cn && cn.minimized) {
      cn.minimized = false;
      node.minimized = false;
      changed = true;
    }
  }
  if (changed) _saveGraphState(state);
  // T69：折叠壳没有内容子树（占位符）——定位跳转展开它时先整卡重建，
  // 否则跳过去是一张空壳卡
  const phEl = graphInner && graphInner.querySelector
    ? graphInner.querySelector('[data-node-id="' + node.id + '"] [data-body-ph]') : null;
  if (phEl && !node.minimized && typeof _refreshWorkflowNodeUi === 'function') {
    _refreshWorkflowNodeUi(node);
  }
  const el = graphInner?.querySelector('[data-node-id="' + node.id + '"]');
  if (el) {
    el.classList.remove('dimmed', 'minimized');
    const toggle = el.querySelector('.graph-node-minimize-toggle');
    if (toggle) {
      toggle.textContent = node.minimized ? '+' : '−';
      toggle.title = node.minimized ? '展开' : '最小化';
    }
  }
}

function _centerGraphOnNode(nodeId) {
  const node = _findGraphNode(nodeId);
  if (!node || !graphCanvas) return false;
  _unhideGraphNodeForFocus(node);
  const state = _graphState();
  const rect = graphCanvas.getBoundingClientRect();
  const zoom = Math.max(0.7, state.zoom || 0.9);
  state.zoom = zoom;
  state.pan.x = rect.width / 2 - node.x * zoom;
  state.pan.y = rect.height / 2 - node.y * zoom;
  _saveGraphState(state);
  _applyGraphTransform();
  _setGraphSelection([nodeId]);
  const el = graphInner?.querySelector('[data-node-id="' + nodeId + '"]');
  if (el) {
    el.classList.remove('graph-node-located');
    void el.offsetWidth;
    el.classList.add('graph-node-located');
    clearTimeout(el._focusTimer);
    el._focusTimer = setTimeout(() => el.classList.remove('graph-node-located'), 2600);
  }
  return true;
}

function focusGraphNode(sessionId, messageId, moduleKey, nodeKind) {
  if (!messageId) return Promise.resolve(false);
  renderGraphCanvas();
  return new Promise(resolve => {
    const kind = nodeKind || (moduleKey === 'question' ? 'user' : '');
    const hasModule = kind !== 'user' && !!moduleKey && moduleKey !== 'answer';
    const focusId = kind === 'user'
      ? _graphNodeId('q', messageId)
      : hasModule
        ? _graphNodeId('m', messageId, moduleKey)
        : _graphNodeId('a', messageId);
    const fallbackId = kind === 'user' ? '' : (hasModule ? _graphNodeId('a', messageId) : '');
    const run = () => {
      _measureNodes();
      if (_centerGraphOnNode(focusId)) {
        resolve(true);
        return;
      }
      if (fallbackId && _centerGraphOnNode(fallbackId)) {
        resolve(true);
        return;
      }
      resolve(false);
    };
    requestAnimationFrame(() => requestAnimationFrame(run));
  });
}

function focusGraphNodeById(nodeId) {
  if (!nodeId) return Promise.resolve(false);
  renderGraphCanvas();
  return new Promise(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      _measureNodes();
      resolve(_centerGraphOnNode(nodeId));
    }));
  });
}

function initGraphCanvas() {
  graphCanvas = document.getElementById('graphCanvas');
  if (!graphCanvas) return;
  _initGraphCanvasEvents();
  renderGraphCanvas();
}

window.renderGraphCanvas = renderGraphCanvas;

window.sendGraphNewSession = sendGraphNewSession;

window.graphModuleAction = graphModuleAction;

window.quickConnectToHub = quickConnectToHub;

window.buildGraphPathForAnchor = buildGraphPathForAnchor;

window.graphAddOutputPort = graphAddOutputPort;

window.graphRemoveOutputPort = graphRemoveOutputPort;

window.graphAddInputPort = graphAddInputPort;

window.graphRemoveInputPort = graphRemoveInputPort;

window.deleteCustomNode = deleteCustomNode;

window.updateCustomNodeContent = updateCustomNodeContent;


window.handleSourceNodeFile = handleSourceNodeFile;

window.handleSourceNodeDrop = handleSourceNodeDrop;


window.generateKnowledgeNode = generateKnowledgeNode;

window.generateRelationNode = generateRelationNode;

window.resetGraphConnections = resetGraphConnections;

window.graphCreateGroup = graphCreateGroup;

window.graphRenameGroup = graphRenameGroup;

window.graphSetGroupColor = graphSetGroupColor;

window.graphAddSelectedToGroup = graphAddSelectedToGroup;

window.graphDeleteGroup = graphDeleteGroup;

window.openAddBlankNodeModal = openAddBlankNodeModal;

window.closeAddBlankNodeModal = closeAddBlankNodeModal;

window.createManualNode = createManualNode;

window.runWorkflowNode = runWorkflowNode;
window.startQuestionWorkflow = startQuestionWorkflow;
window.startSocraticWorkflow = startSocraticWorkflow;
window.runWorkflowNodes = runWorkflowNodes;

window.runAllWorkflowNodes = runAllWorkflowNodes;

window.stopWorkflowRun = stopWorkflowRun;

window.deleteBlankNode = deleteBlankNode;

window.generateBlankNode = generateBlankNode;

window.submitDraftQuestion = submitDraftQuestion;

window.draftSocraticAnswer = draftSocraticAnswer;

window.draftAskAi = draftAskAi;

window.removeDraftNode = removeDraftNode;

window.graphOpenRegenerate = graphOpenRegenerate;
window.generateVizNode = generateVizNode;

window.closeRegeneratePanel = closeRegeneratePanel;

window.submitRegenerateNode = submitRegenerateNode;

window.graphNodeVersionStep = graphNodeVersionStep;

window.graphNodeVersionDelete = graphNodeVersionDelete;

window.zoomGraph = zoomGraph;

window.fitGraph = fitGraph;

window.focusGraphNode = focusGraphNode;

window.focusGraphNodeById = focusGraphNodeById;

window.toggleGraphSearchPanel = toggleGraphSearchPanel;

window.closeGraphSearchPanel = closeGraphSearchPanel;

window.graphSearchInputChanged = graphSearchInputChanged;

window.graphSearchKeydown = graphSearchKeydown;

window.setGraphSearchScope = setGraphSearchScope;

window.focusGraphSearchResult = focusGraphSearchResult;

window.graphToggleTextSelection = graphToggleTextSelection;

window.autoArrangeGraph = autoArrangeGraph;

window.getGraphViewNodes = () => graphView.nodes.map(node => ({ ...node }));

window.getGraphViewEdges = () => graphView.edges.map(edge => ({ ...edge }));

window.getGraphViewDefaultEdges = () => (graphView.defaultEdges || []).map(edge => ({ ...edge }));

window.getSelectedGraphNodeIds = () => Array.from(graphView.selectedNodeIds || []);

window.freeModuleInputPort = _freeModuleInputPort;

window.pushGraphUndo = _pushGraphUndo;

window.applyGraphDiffHighlights = applyGraphDiffHighlights;

window.clearGraphDiffHighlights = clearGraphDiffHighlights;

window.showGraphHarnessPreview = showGraphHarnessPreview;

window.clearGraphHarnessPreview = clearGraphHarnessPreview;

window.getGraphPreviewNodes = () => graphView.previewNodes.map(node => ({ ...node }));

window.toggleGraphView = () => {
  renderGraphCanvas();
};

window.closeGraphView = () => {};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGraphCanvas);
} else {
  initGraphCanvas();
}
