// Φ 阶段1「先对齐、再动手」（2026-10-19 计划，T253/范围硬闸/复述确认/拆批）：
// 前端半边的渲染与行为契约。后端（scope_node_ids 穿归一化、split_ops_by_scope、
// CONFIRM_MIN_OPS 触发）由 tests/test_harness_stage1_align.py 覆盖，本域只钉前端：
//   ① 复述确认卡：confirmText 未确认 → 只出复述与「就这么改/不对，重说」两钮，
//     不露清单与勾选；confirmed 后恢复常规清单＋三钮
//   ② confirmHarnessPlan/rejectHarnessPlan 行为：确认置位（此刻才画预览）；
//     拒绝置 decision='rejected'（本批从此不可应用）
//   ③ 分段清单：>8 条拆段渲染（段头序号＋应用本段），≤8 条保持类型分组旧路径
//   ④ 已应用段：行标「已应用」无勾选框、段头标已应用、本段按钮消失；
//     _selectedOps/应用全部把 appliedOps 索引剔掉（防二次应用）
// 纯同步域（无 await），不与异步用例混排（2026-10-17 实踩教训）。
import fs from 'node:fs';
import { check, code, sandbox, vm } from './_runner.mjs';

const runCtx = code => vm.runInContext(code, sandbox, { filename: 'graph-scope-confirm.mjs' });

function _opsEntry(ops, extra) {
  return Object.assign({
    id: 'h_stage1', role: 'assistant', decision: 'pending',
    operations: ops.map((label, i) => ({ op: 'create_node', label: label, content: '正文' + i, reason: 'r' + i })),
  }, extra || {});
}

function _confirmEntry() {
  return {
    id: 'h_confirm', role: 'assistant', decision: 'pending',
    operations: [{ op: 'create_node', label: '新节点', content: 'x', reason: 'r' }],
    confirmText: '我打算把「电磁感应」的公式改成 F=BLv，并新增节点「动生电动势」连到它。',
    confirmReason: 'ops',
    confirmed: false,
  };
}

function _withHistory(entry) {
  runCtx('harnessHistory = [];');
  runCtx('harnessHistory = ' + JSON.stringify([entry]) + ';');
}

export function run() {
  // ① 复述确认卡：未确认只出复述卡
  check('阶段1-1 复述确认卡：未确认时不露清单，只出复述＋「就这么改/不对，重说」', () => {
    const html = sandbox._harnessOpsCardHtml(_confirmEntry(), true);
    if (!html.includes('graph-harness-confirm-card')) throw new Error('缺确认卡容器类');
    if (!html.includes('就这么改') || !html.includes('不对，重说')) throw new Error('缺两钮');
    if (html.includes('type="checkbox"')) throw new Error('未确认就露出勾选框');
    if (html.includes('graphHarnessApplyActions')) throw new Error('未确认就露出应用按钮');
    if (!html.includes('我打算把「电磁感应」')) throw new Error('复述正文未渲染');
    const stale = sandbox._harnessOpsCardHtml(_confirmEntry(), false);
    if (stale.includes('confirmHarnessPlan()')) throw new Error('非当前批次不该挂确认按钮');
    if (!stale.includes('本批等待确认')) throw new Error('非当前批次缺等待确认标注');
    return true;
  });

  check('阶段1-1 确认后恢复常规清单（confirmed 置位即出勾选与三钮）', () => {
    const entry = _confirmEntry();
    entry.confirmed = true;
    const html = sandbox._harnessOpsCardHtml(entry, true);
    if (html.includes('graph-harness-confirm-card')) throw new Error('确认后不该再出确认卡');
    if (!html.includes('type="checkbox"')) throw new Error('确认后缺勾选框');
    if (!html.includes('graphHarnessApplyActions')) throw new Error('确认后缺应用按钮');
    return true;
  });

  // ② 确认/拒绝行为（需 harnessHistory 里挂最新待处理条目）
  check('阶段1-1 confirmHarnessPlan：置 confirmed 并在此时才画预览/高亮', () => {
    const entry = _confirmEntry();
    _withHistory(entry);
    let previewCalls = 0, highlightCalls = 0;
    sandbox.window.showGraphHarnessPreview = () => { previewCalls++; };
    sandbox.window.applyGraphDiffHighlights = () => { highlightCalls++; };
    const prevSid = sandbox.window.getCurrentSessionId;
    sandbox.window.getCurrentSessionId = () => 'sess_stage1';
    runCtx('harnessResult = ' + JSON.stringify({ operations: entry.operations, _binding: { sessionId: 'sess_stage1' } }) + ';');
    try {
      runCtx('confirmHarnessPlan();');
      // harnessHistory 经 JSON 往返，条目是沙箱内新对象——从沙箱读回断言
      if (runCtx('harnessHistory[0].confirmed') !== true) throw new Error('confirmed 未置位');
      if (previewCalls !== 1) throw new Error('预览未在确认时刻绘制：' + previewCalls);
      if (highlightCalls !== 1) throw new Error('高亮未在确认时刻绘制：' + highlightCalls);
    } finally {
      delete sandbox.window.showGraphHarnessPreview;
      delete sandbox.window.applyGraphDiffHighlights;
      sandbox.window.getCurrentSessionId = prevSid;
      runCtx('harnessResult = null;');
    }
    return true;
  });

  check('阶段1-1 rejectHarnessPlan：置 decision=rejected，本批从此不可应用', () => {
    const entry = _confirmEntry();
    _withHistory(entry);
    runCtx('harnessLastInstruction = "把这张图整理一下";');
    try {
      runCtx('rejectHarnessPlan();');
      if (runCtx('harnessHistory[0].decision') !== 'rejected') throw new Error('decision 未置 rejected');
      // _harnessCurrentOpsEntry 只认 pending——被拒批次不再被勾选/应用锚定
      const anchored = sandbox._harnessCurrentOpsEntry();
      if (anchored && anchored.id === entry.id) throw new Error('被拒批次仍被应用路径锚定');
    } finally {
      runCtx('harnessLastInstruction = "";');
    }
    return true;
  });

  // ③ 分段渲染
  check('阶段1-3 分段清单：>8 条按 8 条一段拆段渲染，每段带「应用本段」', () => {
    const labels = Array.from({ length: 10 }, (_, i) => '节点' + (i + 1));
    const html = sandbox._harnessOpsCardHtml(_opsEntry(labels), true);
    if (!html.includes('第 1/2 段') || !html.includes('第 2/2 段')) throw new Error('段头序号缺失');
    if (!html.includes('applyHarnessSegment(0)') || !html.includes('applyHarnessSegment(1)')) {
      throw new Error('缺段应用按钮');
    }
    if ((html.match(/type="checkbox"/g) || []).length !== 10) throw new Error('段内勾选框数量不对');
    return true;
  });

  check('阶段1-3 ≤8 条保持类型分组旧路径（不拆段，冻结契约）', () => {
    const labels = Array.from({ length: 8 }, (_, i) => '节点' + (i + 1));
    const html = sandbox._harnessOpsCardHtml(_opsEntry(labels), true);
    if (html.includes('graph-harness-segment')) throw new Error('8 条不该拆段');
    if (!html.includes('graph-harness-op-group')) throw new Error('旧类型分组路径丢失');
    if (html.includes('应用本段')) throw new Error('不该出段按钮');
    return true;
  });

  // ④ 已应用段
  check('阶段1-3 已应用段：行标已应用无勾选、段头标注、本段按钮消失；未应用段照旧', () => {
    const labels = Array.from({ length: 10 }, (_, i) => '节点' + (i + 1));
    const html = sandbox._harnessOpsCardHtml(_opsEntry(labels, { appliedOps: [0, 1, 2, 3, 4, 5, 6, 7] }), true);
    const seg1 = html.slice(html.indexOf('第 1/2 段'), html.indexOf('第 2/2 段'));
    const seg2 = html.slice(html.indexOf('第 2/2 段'));
    if (!seg1.includes('，已应用') || !seg1.includes('已应用</em>') || seg1.includes('type="checkbox"')) {
      throw new Error('第一段未按已应用渲染');
    }
    if (seg1.includes('applyHarnessSegment(0)')) throw new Error('已应用段不该再出应用按钮');
    if (!seg2.includes('type="checkbox"') || !seg2.includes('applyHarnessSegment(1)')) {
      throw new Error('未应用段控件丢失');
    }
    return true;
  });

  check('阶段1-3 _selectedOps 与应用全部剔除 appliedOps 索引（防二次应用）', () => {
    const labels = Array.from({ length: 10 }, (_, i) => '节点' + (i + 1));
    const entry = _opsEntry(labels, { appliedOps: [0, 1, 2, 3, 4, 5, 6, 7] });
    _withHistory(entry);
    const prevSid = sandbox.window.getCurrentSessionId;
    sandbox.window.getCurrentSessionId = () => 'sess_stage1';
    runCtx('harnessResult = ' + JSON.stringify({ operations: entry.operations, _binding: { sessionId: 'sess_stage1' } }) + ';');
    try {
      const selected = sandbox._selectedOps();
      if (!Array.isArray(selected) || selected.length !== 2) throw new Error('已应用 8 条未剔除：' + (selected && selected.length));
      runCtx('_applyOpsCount = 0;');
      // applyGraphHarness 走 _applyOps——桩掉 _applyOps 只验它收到的剩余条数
      runCtx('const __origApplyOps = _applyOps;'
        + '_applyOps = function (ops) { _applyOpsCount = ops.length; };');
      try {
        runCtx('applyGraphHarness();');
        if (sandbox._applyOpsCount !== 2) throw new Error('应用全部未剔除已应用段：' + sandbox._applyOpsCount);
      } finally {
        runCtx('_applyOps = __origApplyOps;');
      }
    } finally {
      sandbox.window.getCurrentSessionId = prevSid;
      runCtx('harnessResult = null;');
    }
    return true;
  });

  // 源码契约：预览门控＋窗口导出（inline onclick 依赖全局名）
  check('阶段1 源码契约：确认前预览门控＋三出口全局导出＋CSS 类落源', () => {
    const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
    if (!runSrc.includes('if (!data.confirm)')) throw new Error('生成路径缺确认前预览门控');
    for (const name of ['confirmHarnessPlan', 'rejectHarnessPlan', 'applyHarnessSegment']) {
      if (!code.includes('window.' + name)) throw new Error('缺全局导出：' + name);
      if (typeof sandbox[name] !== 'function') throw new Error('沙箱内不可调：' + name);
    }
    const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
    for (const cls of ['.graph-harness-confirm-card', '.graph-harness-confirm-text', '.graph-harness-segment', '.graph-harness-op-applied-tag']) {
      if (!css.includes(cls)) throw new Error('CSS 缺类：' + cls);
    }
    return true;
  });
}

