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
  // 484：开跑先落任务 id（随 _saveCustomNodes 进盘）——刷新后清扫凭它探活续跑，
  // kind 告诉收编器这条流该喂给分析结算还是正文结算
  node.genTaskId = _newGenTaskId();
  node.genTaskKind = 'analysis';
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
    + '不要输出完整答案，不要输出 XML 标签（若本次附有 skill 候选，唯一例外是按候选要求输出那一行 <skill_plan>），不要生成任何模块内容，控制在300字以内。';
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

  if (typeof _nodeGenBegin === 'function') _nodeGenBegin(node.id);
  try {
    let resp = null;
    if (typeof getActiveModelForRole === 'function' && typeof proxyChat === 'function') {
      const agentModel = getActiveModelForRole('agent');
      if (agentModel) {
        // 取材附图（T381）：问题分析是首问链的第一跳（追问/方向钮/苏格拉底支线
        // 都先过这里），上游素材篮的图随分析请求一起给模型——图与分析依据同源，
        // 否则模型只能对着「图片未转写」的占位猜
        const images = await _workflowImageDataUrls(node);
        // 484：gen_task_id 随请求入册（proxyChat 经 ...extra 透传进 body）
        resp = await _sendWithImagesFallback(images, imgs => {
          const extra = { gen_task_id: node.genTaskId };
          if (imgs) extra.images = imgs;
          return proxyChat(
            prompt,
            typeof currentLevel !== 'undefined' ? currentLevel : 'university',
            _workflowSessionId(),
            true,
            signal,
            branchMeta,
            extra
          );
        });
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
    // 484：连接死亡（刷新/断网掐死 fetch）不结算，延时探活收编
    if (_maybeDeferOnConnectionDeath(node, err)) return;
    const live = _findGraphNodeTail(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
    }
    _saveGraphNodeTail(live);
    _refreshWorkflowNodeStatusUi(live);
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('问题分析失败：' + (err.message || err));
    if (typeof hideProgress === 'function') hideProgress();
  } finally {
    // T341：生成链整条收尾（流落帐/异常结清）后才放行等这颗节点的排队修订
    if (typeof _nodeGenEnd === 'function') _nodeGenEnd(node.id);
  }
}

// 484：连接死亡 ≠ 生成失败。页面刷新/导航会掐死在途 fetch（Chrome 抛 TypeError
// 「Failed to fetch」，不是 AbortError），断网同理——但服务端任务还活着（拍板：
// 后台跑完）。此刻若照旧 catch 结算（busy=false＋status='error'＋落盘），刷新后
// 水合看到的就不是 busy 残留而是 error，收编器永远轮不上。改法：带 genTaskId 的
// 连接死亡不结算——busy 原样留盘，登记延时探活；任务在 → 原地重接续流（断网恢复
// 也吃到这个红利），任务不在（没发出去/服务重启）→ 延时后按旧口径结算，行为只是
// 慢 3 秒。返回 true＝已接管，调用方直接 return。
function _maybeDeferOnConnectionDeath(node, err) {
  if (!err || err.name !== 'TypeError' || !node || !node.genTaskId) return false;
  const live = (typeof _findGraphNodeTail === 'function') ? _findGraphNodeTail(node.id) : null;
  if (!live || !live.busy) return false;
  const sid = (typeof _workflowSessionId === 'function' && _workflowSessionId())
    || (typeof window.getCurrentSessionId === 'function' && window.getCurrentSessionId()) || '';
  _recordPendingGenerationReattach(sid, live);
  // 延时 3 秒：真刷新时本页面随死无所谓（busy 已留盘，新页面水合收编）；本页断网
  // 场景给网络一个恢复窗口，探活失败才按旧口径结算。
  setTimeout(function () {
    try {
      if (typeof _maybeReattachPendingGenerations === 'function') _maybeReattachPendingGenerations(sid);
    } catch (e) { /* 兜底不阻断 */ }
  }, 3000);
  return true;
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

// opts.foreground=false（viz 后台通道，2026-11-22）：viz 从前台摘出去，不进胶囊进度、
// 不进节点级排队闸（_nodeGenBegin/End 会触发队列 flush，后台 viz 完成不该是放行点——
// 队列在 run 收尾时就该放行了）。opts.snapshot 是开跑冻结的世界观，整条链只读它。
// 空 opts 时行为与上线前逐字节一致。
async function _generateCustomNode(node, nodeSignal, opts) {
  const _bg = opts && opts.foreground === false ? opts : null;
  // viz 后台发射时已同步占住 busy（防同微任务窗口重复开火）；自己发起的这条要放行。
  if (!node || (node.busy && !(_bg && _bg.vizBgJob))) return;
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
  // 484：开跑先落任务 id（随 _saveCustomNodes 进盘）——刷新后清扫凭它探活续跑
  node.genTaskId = _newGenTaskId();
  node.genTaskKind = 'content';
  // viz 后台：把 viz-bg 任务 id / genTaskId 记在节点上，刷新后 484 收编器据此翻回任务行。
  if (_bg) {
    if (_bg.vizBgJob && _bg.vizBgJob.taskId) node.vizBgTaskId = _bg.vizBgJob.taskId;
    if (_bg.vizBgJob) _bg.vizBgJob.genTaskId = node.genTaskId;
  }
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
  // viz 后台：世界观只读开跑快照，不受后续任务改画布/换模型影响（约束①）。
  const workflowContext = socratic ? {} : (_bg && _bg.snapshot ? _bg.snapshot.workflowContext : _buildWorkflowContextForNode(node));
  const prompt = socratic ? String(socratic.prompt || '')
    : (_bg && _bg.snapshot ? _bg.snapshot.prompt : _workflowPromptForNode(node, workflowContext));
  const graphPath = _bg && _bg.snapshot ? (_bg.snapshot.branchMeta.graphPath || []) : _blankNodeGraphPath(node);
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
    wfStats: _bg && _bg.snapshot ? _bg.snapshot.branchMeta.wfStats : _wfStatsForNode(node),
  };
  const signal = _workflowNodeSignal(nodeSignal);

  // viz 后台不进节点级排队闸：那把闸的 _nodeGenEnd 会 flush 队列，而后台 viz 的
  // 完成不该是放行点（队列在 run 收尾时就该放行，不必等这条最长的 viz）。
  if (!_bg && typeof _nodeGenBegin === 'function') _nodeGenBegin(node.id);
  try {
    let resp = null;
    // 模型槽也用开跑快照：下一条任务换了 html 槽模型不影响在跑的这条。
    const slotCall = _bg && _bg.snapshot && _bg.snapshot.slotRole
      ? { role: _bg.snapshot.slotRole, model: (typeof getActiveModelForRole === 'function' && getActiveModelForRole(_bg.snapshot.slotRole)) || null }
      : _slotCallForWorkflowNode(node);
    if (slotCall && typeof proxyChatWithModel === 'function') {
      const payload = {
        prompt,
        level: _bg && _bg.snapshot ? _bg.snapshot.level : (typeof currentLevel !== 'undefined' ? currentLevel : 'university'),
        session_id: _bg && _bg.snapshot ? _bg.snapshot.sid : _workflowSessionId(),
        stream: true,
        thinking: getSlotThinkingForRole(slotCall.role),
        gen_task_id: node.genTaskId,
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
      await _streamCustomNodeResponse(resp, node, { foreground: !_bg });
    } catch (err) {
      streamError = err;
      // 484：连接死亡（刷新/导航掐死 fetch 抛 TypeError）直通外层统一处理——
      // 这里的 failedLive 处置会剥 busy 清 content，把「服务端还在跑的任务」提前
      // 结算成失败，刷新后的收编器就永远轮不上了。用户主动停（AbortError）与
      // 看门狗超时（TimeoutError）各有自己的口径，不经这条路。
      if (err && err.name === 'TypeError' && node.genTaskId) throw err;
      console.warn('Viz module direct stream failed, will try fallback:', err);
      const failedLive = _findGraphNodeTail(node.id);
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
        // 半成品也是「当前输入下的产出」：补记当前输入哈希（T509，2026-11-21）——
        // 链上 hash 短路已不要求 status==='done'，但首生成半成品的 stored hash 是
        // 空串，不补记的话 hash 必失配，下次被链拉进子图照样重跑、可见内容照样被覆盖
        try { failedLive.inputHash = _nodeInputHash(failedLive); } catch (e) { /* 保持原值 */ }
        // 版本账（T339）：这一版按「未跑完」入账（旧文仍在前一位，‹› 可回）
        _commitWorkflowNodeVersion(failedLive);
        _saveGraphNodeTail(failedLive);
        _refreshWorkflowNodeStatusUi(failedLive);
        if (typeof showToast === 'function') showToast('连接超时，已保留内容，可重试');
        return;
      }
      if (failedLive) {
        failedLive.content = '';
        failedLive.busy = false;
      }
    }

    // T419：成功/归一/重试各收口按生成收尾寻址结算（484：结算块抽成共享函数，
    // 调度路与续跑路共用同一把尺子，防两处口径漂移）
    await _finishCustomNodeGeneration(node, { streamError, workflowContext, recipe, prompt, signal, nodeSignal });
  } catch (err) {
    // 484：连接死亡（刷新/断网掐死 fetch）不结算，延时探活收编
    if (_maybeDeferOnConnectionDeath(node, err)) return;
    const live = _findGraphNodeTail(node.id);
    if (live) {
      live.busy = false;
      live.status = err.name === 'AbortError' ? 'waiting' : 'error';
      // 版本账（T339）：流式草稿不算数，兜回上一版——中止/失败都不丢旧内容
      _restoreWorkflowNodeVersion(live);
    }
    _saveGraphNodeTail(live);
    _refreshWorkflowNodeStatusUi(live);
    if (err.name !== 'AbortError' && typeof showToast === 'function') showToast('生成失败：' + (err.message || err));
  } finally {
    // T341：流末尾 busy 已落 false，但 viz 归一/重试/版本收账还在跑——排队修订
    // 要等整条生成链收尾才放行，否则仍会与收尾写入并发。
    // viz 后台从不进这道闸（见上），自然也不在这里放行别人的队列。
    if (!_bg && typeof _nodeGenEnd === 'function') _nodeGenEnd(node.id);
  }
}

// ===== 生成收尾结算（484：自 _generateCustomNode 抽出，调度路与续跑路共用）=====
// viz 归一/mermaid 补栏/版本收账/on_generated/苏格拉底派生全在这里——正文流的
// 收口只有这一把尺子。ctx: { streamError, workflowContext, recipe, prompt, signal, nodeSignal }
async function _finishCustomNodeGeneration(node, ctx) {
  const streamError = ctx.streamError || null;
  const workflowContext = ctx.workflowContext || {};
  const recipe = ctx.recipe || null;
  const prompt = ctx.prompt || '';
  const signal = ctx.signal || null;
  const nodeSignal = ctx.nodeSignal || null;
  const live = _findGraphNodeTail(node.id);
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
      _saveGraphNodeTail(live);
      if (workflowRunActive) _refreshWorkflowNodeUi(live);
      else renderGraphCanvas();
      if (!wasAborted && typeof showToast === 'function') {
        showToast('可视化生成失败：' + (vizRetryMessage || '点击节点重试'));
      }
      return;
    }
    live.content = normalized;
    live.summary = _graphSummary(normalized);
    live.status = 'done';
    live.busy = false;
    // 版本账（T339）：归一后的整页 HTML 收作新版本
    _commitWorkflowNodeVersion(live);
    _saveGraphNodeTail(live);
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
    _saveGraphNodeTail(live);
    _refreshWorkflowNodeStatusUi(live);
    if (typeof showToast === 'function') showToast('生成失败：模型返回了空内容，请点击该节点重试');
    return;
  }
  // 版本账（T339）：成功收账（放在 mermaid 归一之后——归一改写过的 content 才是落定的版本）
  _commitWorkflowNodeVersion(live);
  // 收账后立刻落盘（T419 顺带）：过去成功路只由流尾那发保存盖住，账本条目在内存里
  // 等下一次任意保存才落盘——人切走画布时（收尾走兜底）下一发不知何时，刷新即丢
  if (live) _saveGraphNodeTail(live);
  // on_generated 编排钩子（P2）：生成成功后按声明自动建链（进阶学习四步链的数据版）
  if (live && recipe && recipe.on_generated) _recipeAfterGenerated(live);
  // T361：苏格拉底反馈落地后把回复里的建议追问抽成派生「苏格拉底追问」节点
  // （闭环下一题），并结算本轮（profile 记账＋闭环结束复位）
  if (live && live.socraticMeta) _materializeSocraticFollowup(live);
}

// ===== 484 生成断点续跑（2026-11-19）：探活＋重接流 =====
// 拍板口径：后台跑完＋限时自动停。刷新回来水合时清扫把带 genTaskId 的中断生成
// 暂缓登记（graph.js 的 _recordPendingGenerationReattach），这里探活服务端任务：
// 任务不在（重启/过期回收）→ 旧中断结算口径就地落地；还在（running/done，含已被
// 宽限掐掉的 interrupted/error）→ GET 重接流，喂给与调度路同一套流式函数与结算块——
// interrupted/error 的缓冲重放把内容补到最新，流尾终帧抛错走旧口径结算（草稿不丢）。
function _newGenTaskId() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function _reattachOneNode(node, entry) {
  // 探活：服务端任务还在吗
  let status = null;
  try {
    const probe = await fetch('/api/generations/' + encodeURIComponent(entry.genTaskId), { cache: 'no-cache' });
    if (probe.ok) status = await probe.json();
  } catch (e) { /* 服务端不在/断网：按 missing 处理 */ }
  const live = (typeof _findGraphNodeTail === 'function' ? _findGraphNodeTail(node.id) : null) || node;
  if (!live || !live.busy || live.genTaskId !== entry.genTaskId) return; // 期间已被别的路结算
  if (!status) {
    // 任务不在（服务重启/过期回收）：盘上草稿按旧中断结算口径落地（T275/T359）
    const settled = _settleInterruptedCustomNode(live);
    Object.assign(live, settled);
    _saveGraphNodeTail(live);
    _refreshWorkflowNodeStatusUi(live);
    return;
  }
  // running/done 照常重接收尾；interrupted/error 也重接——重放缓冲把「屏幕上见过
  // 的字」补到最新（盘上 400ms 拍总落后于服务端缓冲），流尾的 499 终帧让流抛错，
  // 落到下方 catch 的旧口径结算：内容已是最新，草稿一字不丢。
  // 只有还活着/刚跑完的任务才把面板行翻回「进行中」；重放已终态的不翻（假续跑）
  if ((status.state === 'running' || status.state === 'done')
      && typeof _taskResumeGenerationForNode === 'function') _taskResumeGenerationForNode(node.id);
  const controller = new AbortController();
  if (typeof workflowInFlightControllers !== 'undefined') workflowInFlightControllers.add(controller);
  try {
    const resp = await fetch('/api/generations/' + encodeURIComponent(entry.genTaskId) + '/stream', {
      signal: controller.signal,
      cache: 'no-cache',
    });
    if (!resp.ok || !resp.body) throw new Error('重接流失败 HTTP ' + resp.status);
    if (entry.kind === 'analysis') {
      const question = (typeof _findQuestionContentUpstream === 'function') ? _findQuestionContentUpstream(live) : '';
      await _streamAnalysisResponse(resp, live, question || ' ');
    } else {
      await _streamCustomNodeResponse(resp, live);
      // 共享收口：viz 归一/版本收账/on_generated/苏格拉底派生——与调度路同一把尺子
      const socratic = live.socraticMeta && typeof live.socraticMeta === 'object' ? live.socraticMeta : null;
      const recipe = live.recipeId && live.recipe ? live.recipe : null;
      const workflowContext = socratic ? {} : _buildWorkflowContextForNode(live);
      const prompt = socratic ? String(socratic.prompt || '') : _workflowPromptForNode(live, workflowContext);
      await _finishCustomNodeGeneration(live, {
        streamError: null, workflowContext, recipe, prompt,
        signal: controller.signal, nodeSignal: controller.signal,
      });
    }
    if (typeof _taskResumeSettleForNode === 'function') _taskResumeSettleForNode(node.id, true);
  } catch (err) {
    const cur = (typeof _findGraphNodeTail === 'function' ? _findGraphNodeTail(live.id) : null) || live;
    // 重放补的内容先落进节点：interrupted/error 任务的缓冲是毫秒级重放完的，
    // live.content 由 250ms 节流渲染器写——抛错时定时器还没跑，盘上/内存里还是
    // 旧草稿。streamPartial 是本次重放收到的全文，比它长就采用（终态缓冲 ≥ 盘上）。
    const partial = (err && typeof err === 'object') ? String(err.streamPartial || '') : '';
    if (cur && partial.length > String(cur.content || '').length) cur.content = partial;
    if (cur && cur.busy) {
      if (err && err.name === 'AbortError') {
        // 用户主动停（重接中点「停止生成」）：与调度路的 abort 口径一致——
        // 回等待态、兜回上一版，不标失败
        cur.busy = false;
        cur.status = 'waiting';
        if (typeof _restoreWorkflowNodeVersion === 'function') _restoreWorkflowNodeVersion(cur);
        _saveGraphNodeTail(cur);
        _refreshWorkflowNodeStatusUi(cur);
      } else {
        // 断流/终态重放结束（宽限到点被掐/服务重启/网络）：按旧中断结算口径落地
        // （草稿入账＋标失败；首生成无账本时 status 归空串——T275 既有口径）
        const settled = _settleInterruptedCustomNode(cur);
        Object.assign(cur, settled);
        _saveGraphNodeTail(cur);
        _refreshWorkflowNodeStatusUi(cur);
        if (typeof showToast === 'function') showToast('后台生成中断，已保留内容，可重试');
      }
    }
    if (typeof _taskResumeSettleForNode === 'function') _taskResumeSettleForNode(node.id, false);
  } finally {
    if (typeof workflowInFlightControllers !== 'undefined') workflowInFlightControllers.delete(controller);
  }
}

// 收编器：取当前会话名下的暂缓登记，节点就位一颗收编一颗。节点还没水合就位的
// 留待 500ms 后整批再试（最多 40 拍）；已被结算/换任务 id 的就地作废。别的会话
// 的登记压在队列里，等切过去时由水合钩子再唤（_loadGraphStateFromServer finally）。
function _maybeReattachPendingGenerations(sidOverride) {
  const sid = String(sidOverride
    || (typeof window.getCurrentSessionId === 'function' ? window.getCurrentSessionId() : '')
    || '');
  const mine = [];
  for (let i = _pendingGenerationReattach.length - 1; i >= 0; i--) {
    if (sid && _pendingGenerationReattach[i].sid === sid) {
      mine.unshift(_pendingGenerationReattach.splice(i, 1)[0]);
    }
  }
  if (!mine.length) return;
  const waiting = [];
  for (let i = 0; i < mine.length; i++) {
    const entry = mine[i];
    const ready = typeof _reattachOneNode === 'function' && typeof _findGraphNode === 'function';
    const node = ready ? _findGraphNode(entry.nodeId) : null;
    if (!ready || !node) { waiting.push(entry); continue; }
    if (node.busy && node.genTaskId === entry.genTaskId) {
      if (_reattachInFlightNodes.has(entry.nodeId)) continue;
      _reattachInFlightNodes.add(entry.nodeId);
      try {
        Promise.resolve(_reattachOneNode(node, entry))
          .catch(() => {})
          .finally(() => { _reattachInFlightNodes.delete(entry.nodeId); });
      } catch (e) {
        _reattachInFlightNodes.delete(entry.nodeId);
      }
      continue;
    }
    // 节点不再 busy / 已换新任务：这轮生成已被旧结算路径或新一轮生成接管，作废
  }
  if (waiting.length && _reattachPumpRetries < 40) {
    _reattachPumpRetries++;
    for (let i = waiting.length - 1; i >= 0; i--) _pendingGenerationReattach.unshift(waiting[i]);
    setTimeout(_maybeReattachPendingGenerations, 500);
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
  // 用户删过的派生追问不复活：deleteCustomNode 记的 harnessDeleted 墓碑（消息链
  // graph-data.js 的派生认同一枚）在反馈节点重生成时同样要认——不然反馈一重结算、
  // 刚删的追问又原地长回来（2026-11-20 实测：删追问→补空追问节点→生成，旧追问连着
  // 反思一起回来）。
  if ((state.harnessDeleted || {})[sqId]) return;
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

