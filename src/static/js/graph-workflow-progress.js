// ====== 工作流进度胶囊与流式进度（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家）=====
// 顶部胶囊的显示/推进/隐藏与流式字符计数节流；本文件自带 5 个模块级 let（null/0 初始，加载期零依赖）。
function _workflowProgressLabel(node) {
  if (!node) return '';
  if (node.recipeId && node.recipe && node.recipe.name) return node.recipe.name;
  if (node.kind === 'source') return '输入';
  if (node.kind === 'relation') return '知识联系';
  if (node.manual) return node.kind === 'note' ? '我的总结' : '我的回答';
  if (node.kind === 'hub') return '汇聚';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'answer') return '问题分析';
  if (node.kind === 'direct') return '直接回答';
  // 空白节点（2026-10-24 T400）：进度胶囊/任务行用卡面同款品类名，别再显示英文 kind
  if (node.kind === 'blank') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey || 'AI 生成空白';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  return node.kind;
}

function _workflowItemNeedsProgress(node) {
  if (!node) return false;
  if (node.messageIndex >= 0) return false;
  if (node.manual) return false;
  // 人工定稿（T355）：内容是用户亲手写/改/粘贴并保存过的，工作流不再收编——
  // 上游变了也保持人工版本，只有该节点自己的显式重生成才会换掉内容
  if (node.humanDone) return false;
  if (node.kind === 'user') return false;
  if (node.kind === 'hub') return false;
  // direct（2026-10-24）：成品答案卡与 summary 同口径——吃内容＋输入哈希，
  // 上游或要求变了才算「需要重跑」；不进 answer 分支（那条查 analysis）
  if (node.kind === 'summary' || node.kind === 'direct') {
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash);
  }
  if (node.kind === 'answer' && !node.manual) {
    // 闭环反馈（T509，2026-11-21）：prompt 是提交瞬间定稿的，输出不随上游变——
    // 有内容即不需要进度（链上守卫见 _processWorkflowChainItem 的 socraticMeta 分支），
    // 不再像分析卡那样因 analysis 恒空被判「永远待生成」虚占进度总数
    if (node.socraticMeta) return !((node.content || '').trim());
    const question = _findQuestionContentUpstream(node);
    const analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
    return !node.analysis || node.analysisHash !== analysisHash;
  }
  // 空白节点（2026-10-24 T400）：与 module 同口径（内容＋输入哈希），
  // 外加空要求闸门——卡上没写要求＝没有生成目标，「全部开始」不选它、进度总数也不算它
  // （显式跑这颗时 _processWorkflowChainItem 还有同一道闸，两条入口口径一致）。
  // T509（2026-11-21）：三处口径与链上 hash 短路同步去掉 status==='done'——
  // T359 半成品（content＋error）与中止回滚（content＋waiting）输入没变时不该被
  // 「全部开始」选中重跑覆盖，链上守卫与进度口径必须同一把尺子
  if (node.kind === 'blank') {
    if (!String(node.requirements || '').trim()) return false;
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash);
  }
  if (node.kind === 'module') {
    // 派生追问（T510）：内容由闭环结算落地（_materializeSocraticFollowup），不是
    // 生成目标——没有 inputHash，按生成口径判恒真，被「全部开始」反复选中重写。
    // 有内容即不需要进度；显式 force（三角点名）仍可重跑
    if (node.sqAuto) return !((node.content || '').trim());
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash);
  }
  return false;
}

function _markWorkflowCurrentNode(current) {
  const label = _workflowProgressLabel(current);
  if (label) workflowProgressActive.add(label);
  workflowProgressCurrentLabel = label ? '正在生成' + label : '正在运行工作流';
  const statusText = _workflowProgressStatusText();
  const pct = workflowProgressTotal ? Math.round(workflowProgressDone / workflowProgressTotal * 100) : 0;
  if (typeof showProgress === 'function') {
    showProgress('tool', pct, '工作流 ' + statusText);
  }
}

function _workflowProgressStatusText() {
  const active = Array.from(workflowProgressActive).filter(Boolean);
  let text = workflowProgressDone + '/' + workflowProgressTotal;
  if (active.length) text += ' · 运行中 ' + active.length + ' · ' + active.slice(0, 3).join('、');
  return text;
}

let workflowProgressTimer = null;

let workflowProgressLength = 0;

let workflowProgressTotal = 0;

let workflowProgressDone = 0;

let workflowProgressCurrentLabel = '';

function _applyWorkflowStreamProgress() {
  workflowProgressTimer = null;
  const total = workflowProgressTotal;
  const done = workflowProgressDone;
  if (!total) return;
  const streamFraction = Math.min(0.85, workflowProgressLength / 20000);
  const pct = Math.round((done / total) * 100 + streamFraction * (100 / total));
  const target = Math.max((done / total) * 100, Math.min(99, pct));
  const current = typeof window.getCurrentProgress === 'function' ? window.getCurrentProgress() : 0;
  if (target < current) return;
  if (typeof showProgress === 'function') {
    showProgress('tool', target, '工作流 ' + _workflowProgressStatusText());
  }
}

function _scheduleWorkflowStreamProgress(length) {
  workflowProgressLength = Math.max(workflowProgressLength, length || 0);
  if (workflowProgressTimer) return;
  workflowProgressTimer = setTimeout(_applyWorkflowStreamProgress, 120);
}

function _setWorkflowStopButton(active) {
  const btn = document.getElementById('stopBtn');
  if (btn) btn.disabled = !active;
  const runBtn = document.getElementById('runAllBtn');
  if (runBtn) runBtn.disabled = active;
  const miniRunBtn = document.getElementById('statusRunBtn');
  const miniStopBtn = document.getElementById('statusStopBtn');
  if (miniRunBtn) miniRunBtn.disabled = active;
  if (miniStopBtn) miniStopBtn.disabled = !active;
}

function _showWorkflowProgress(total) {
  if (workflowProgressTimer) {
    clearTimeout(workflowProgressTimer);
    workflowProgressTimer = null;
  }
  workflowProgressLength = 0;
  workflowProgressTotal = total || 0;
  workflowProgressDone = 0;
  workflowProgressActive.clear();
  workflowProgressCurrentLabel = '准备运行工作流';
  if (typeof showProgress === 'function') showProgress('tool', 0, '准备运行工作流 · 0/' + workflowProgressTotal);
}

function _advanceWorkflowProgress(label) {
  if (workflowProgressTimer) {
    clearTimeout(workflowProgressTimer);
    workflowProgressTimer = null;
  }
  workflowProgressLength = 0;
  if (workflowProgressActive.has(label)) workflowProgressActive.delete(label);
  workflowProgressDone = Math.min(workflowProgressTotal, workflowProgressDone + 1);
  workflowProgressCurrentLabel = label ? '正在生成' + label : '正在运行工作流';
  const total = workflowProgressTotal;
  const done = workflowProgressDone;
  const statusText = _workflowProgressStatusText();
  if (typeof showProgress === 'function') {
    const pct = total ? Math.round(done / total * 100) : 0;
    showProgress('tool', pct, '工作流 ' + statusText);
  }
}

function _hideWorkflowProgress() {
  workflowProgressTotal = 0;
  workflowProgressDone = 0;
  workflowProgressActive.clear();
  workflowProgressCurrentLabel = '';
  if (workflowProgressTimer) {
    clearTimeout(workflowProgressTimer);
    workflowProgressTimer = null;
  }
  if (typeof hideProgress === 'function') hideProgress();
}
