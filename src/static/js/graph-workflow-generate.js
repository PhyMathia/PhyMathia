// ===== 工作流：节点生成链（2026-10-24 自 graph-workflow.js 拆出，T397 纯搬家）=====
// 节点级中断信号、分析/自定义节点生成（含取材附图与看图降级重发）、苏格拉底反馈派生（T361）。
// 入口调度 runWorkflowNode 一族在 graph-workflow-entry.js；图执行在 graph-workflow-run.js。
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
  // 直接回答（2026-10-24）：没有任何问题/上游材料时不空跑——模型对着空上下文只会
  // 编答案。守卫放在版本账之前：拦截时旧内容与版本一条不动（与「没输入＝没生成」同口径）
  if (node.kind === 'direct') {
    const question = String(_findQuestionContentUpstream(node) || '').trim();
    const hasUpstream = _workflowEdgeTable().some(edge => {
      if (String(edge.to) !== node.id || edge.draft || edge.link) return false;
      const source = _findGraphNode(edge.from);
      return !!String(_nodeOutputContent(source, undefined, edge.fromPort) || '').trim();
    });
    if (!question && !hasUpstream) {
      node.status = 'waiting';
      _saveCustomNodes();
      _refreshWorkflowNodeStatusUi(node);
      if (typeof showToast === 'function') showToast('请先连接问题节点或上游内容');
      return;
    }
  }
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
    branchType: node.kind === 'direct' ? 'direct' : 'blank',
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

