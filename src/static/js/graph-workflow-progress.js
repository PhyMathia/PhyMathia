// ====== 工作流进度胶囊与流式进度（2026-10-10 自 graph-workflow.js 拆出，T261 纯搬家）=====
// 顶部胶囊的显示/推进/隐藏与流式字符计数节流；本文件自带 5 个模块级 let（null/0 初始，加载期零依赖）。
function _workflowProgressLabel(node) {
  if (!node) return '';
  if (node.recipeId && node.recipe && node.recipe.name) return node.recipe.name;
  if (node.kind === 'source') return '输入';
  if (node.kind === 'knowledge') return '知识点';
  if (node.kind === 'relation') return '知识联系';
  if (node.manual) return node.kind === 'note' ? '我的总结' : '我的回答';
  if (node.kind === 'hub') return '汇聚';
  if (node.kind === 'summary') return 'AI 总结';
  if (node.kind === 'answer') return 'AI 回答';
  if (node.kind === 'module') return (GRAPH_MODULE_META[node.moduleKey] || {}).label || node.moduleKey;
  return node.kind;
}

function _workflowItemNeedsProgress(node) {
  if (!node) return false;
  if (node.messageIndex >= 0) return false;
  if (node.manual) return false;
  if (node.kind === 'user') return false;
  if (node.kind === 'hub') return false;
  if (node.kind === 'summary') {
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash && node.status === 'done');
  }
  if (node.kind === 'answer' && !node.manual) {
    const question = _findQuestionContentUpstream(node);
    const analysisHash = _simpleHash(question + '|' + (node.requirements || ''));
    return !node.analysis || node.analysisHash !== analysisHash;
  }
  if (node.kind === 'module') {
    const inputHash = _nodeInputHash(node);
    return !((node.content || '').trim() && node.inputHash === inputHash && node.status === 'done');
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
