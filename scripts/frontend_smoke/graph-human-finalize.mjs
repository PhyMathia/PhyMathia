// 人工定稿防重生成（T355，2026-10-17 答辩后修复轮）：人工保存过的内容打 humanDone
// 标记——工作流「全部开始」与整链跑动都不再收编重写，只有该节点自己的显式重生成
// （修订面板/从头生成）才换掉内容。覆盖五条契约：
//   ① 卡内 textarea/粘贴路（updateCustomNodeContent）保存即定稿：done＋humanDone＋
//      inputHash 同步；上游再变（hash 失配）也不再判待生成——答辩现场丢内容的路径
//   ② 笔记本弹窗路（saveCustomNodeContent）同样定稿
//   ③ 整链护栏：链式跑动遇到人工定稿节点，hash 失配也不触发 _generateCustomNode；
//      显式 force（点名从头生成这颗）才放行
//   ④ 版本生命周期：AI 重生成开跑清标记（内容交棒 AI），失败回滚随内容恢复标记
//   ⑤ 静态契约：重生成预警必须点名人工定稿下游（T303 提示增强）
// 独立成域的原因：夹具与 graph-edit-history 同款，但本域两条用例含 await——异步用例
// 在第一个 await 让出微任务期间，同文件后续同步用例的 _seed() 会重置共享图状态
//（2026-10-17 实踩：撤销链用例的 stateContent 读到被重置的「旧总结」假红）。
import fs from 'node:fs';
import { check, drain, sandbox, vm, storageData } from './_runner.mjs';

function _emptyState() {
  return { collapsed: {}, hidden: {}, positions: {}, pinned: {}, sizes: {}, pan: { x: 80, y: 80 }, zoom: 0.9,
    layoutVersion: 1, connections: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, groups: [],
    customNodes: [], harnessDeleted: {}, harnessCheckpoint: null };
}

// 最小夹具：一颗自定义 viz 模块节点＋一颗 AI 总结节点（都是 messageIndex<0 的工作流对象）
function _seed() {
  const mem = _emptyState();
  let chatHistory = [];
  sandbox.window.getGraphState = () => mem;
  sandbox.window.saveGraphState = (_sid, state) => { Object.assign(mem, state); };
  sandbox.window.getCurrentSessionId = () => 'sess_human_done';
  sandbox.window.getChatHistory = () => chatHistory.slice();
  sandbox.window.saveCurrentSession = async () => {};
  vm.runInContext('graphView.nodes = ['
    + JSON.stringify({ id: 'cm1', kind: 'module', moduleKey: 'viz', messageIndex: -1, timestamp: 5, content: '', status: 'waiting' }) + ','
    + JSON.stringify({ id: 'sm1', kind: 'summary', messageIndex: -1, timestamp: 6, content: '', status: 'waiting' })
    + '];', sandbox);
  vm.runInContext('graphView.nodeById = { cm1: graphView.nodes[0], sm1: graphView.nodes[1] };'
    + 'graphView.edges = []; graphView.defaultEdges = []; graphView.selectedNodeIds = new Set();', sandbox);
  // 真实应用里 _saveCustomNodes 会把 live 节点同步进图状态缓存，夹具不能跳过这步
  vm.runInContext('_saveCustomNodes();', sandbox);
  return { mem: mem, node: id => JSON.parse(vm.runInContext('JSON.stringify(graphView.nodeById.' + id + ')', sandbox)) };
}

export async function run() {
  const prevGet = sandbox.window.getGraphState, prevSave = sandbox.window.saveGraphState, prevSid = sandbox.window.getCurrentSessionId;
  const prevDoc = sandbox.document, prevEsc = sandbox.escapeHtml;
  const histKey = 'phymathia_graph_history_sess_human_done';
  const prevHist = storageData[histKey];
  delete storageData[histKey];
  sandbox.document = {
    createElement: () => ({ className: '', innerHTML: '', style: {}, listeners: {},
      addEventListener() {}, remove() {} }),
    getElementById: id => (sandbox.__field && sandbox.__field[id] !== undefined ? { value: sandbox.__field[id] } : null),
    body: { appendChild: () => {} },
  };
  sandbox.escapeHtml = t => String(t == null ? '' : t);
  const runCtx = code => vm.runInContext(code, sandbox, { filename: 'graph-human-finalize.mjs' });
  try {
    check('T355 卡内 textarea/粘贴路：保存即人工定稿（done＋humanDone＋inputHash 同步），hash 失配也不再判待生成', () => {
      const fx = _seed();
      runCtx('updateCustomNodeContent("cm1", "手写内容 v1")');
      const after = fx.node('cm1');
      if (after.content !== '手写内容 v1') throw new Error('内容没写进节点');
      if (after.status !== 'done' || !after.humanDone) {
        throw new Error('人工保存未打定稿标记：status=' + after.status + ' humanDone=' + after.humanDone);
      }
      if (after.inputHash !== runCtx('String(_nodeInputHash(graphView.nodeById.cm1))')) throw new Error('inputHash 没同步到当前上游');
      // 上游之后变了（hash 失配）也不许再收编——这正是答辩现场丢内容的路径
      runCtx('graphView.nodeById.cm1.inputHash = "stale-hash"');
      if (runCtx('_workflowItemNeedsProgress(graphView.nodeById.cm1)') !== false) throw new Error('人工定稿节点仍被判定为待生成');
      return true;
    });

    check('T355 笔记本弹窗路：AI 总结人工改写后同样定稿', () => {
      const fx = _seed();
      sandbox.__field = { customNodeTitleBox: '', customNodeContentBox: '我自己的总结' };
      sandbox.saveCustomNodeContent('sm1');
      const after = fx.node('sm1');
      if (after.status !== 'done' || !after.humanDone) throw new Error('笔记本保存未打定稿标记');
      if (runCtx('_workflowItemNeedsProgress(graphView.nodeById.sm1)') !== false) throw new Error('总结节点仍被判待生成');
      return true;
    });

    check('T355 整链护栏：人工定稿节点 hash 失配不再被 _generateCustomNode 覆盖；显式 force 才放行', async () => {
      _seed();
      runCtx('updateCustomNodeContent("cm1", "手写内容 v1")');
      runCtx('graphView.nodeById.cm1.inputHash = "stale-hash"');
      runCtx('window.__origGen = _generateCustomNode; window.__genCalls = 0;'
        + '_generateCustomNode = async function () { window.__genCalls++; return true; };');
      try {
        const skipped = await runCtx('_processWorkflowChainItem(graphView.nodeById.cm1, false, null)');
        if (skipped !== true) throw new Error('人工定稿节点在链上没被跳过');
        if (runCtx('window.__genCalls') !== 0) throw new Error('链上仍触发了重生成');
        if (runCtx('graphView.nodeById.cm1.content') !== '手写内容 v1') throw new Error('链上跑动把人工内容改了');
        await runCtx('_processWorkflowChainItem(graphView.nodeById.cm1, true, null)');
        if (runCtx('window.__genCalls') !== 1) throw new Error('显式 force 应放行重生成');
      } finally {
        runCtx('_generateCustomNode = window.__origGen;');
      }
      return true;
    });

    check('T355 版本生命周期：AI 重生成开跑清标记；失败回滚随内容恢复人工标记', async () => {
      _seed();
      runCtx('updateCustomNodeContent("cm1", "手写内容 v1")');
      runCtx('_beginWorkflowNodeVersionCycle(graphView.nodeById.cm1)');
      const mid = JSON.parse(runCtx('JSON.stringify(graphView.nodeById.cm1)'));
      if (mid.humanDone) throw new Error('AI 生成开跑后标记应清掉');
      if ((mid.content || '').trim()) throw new Error('开跑应清空内容');
      runCtx('_restoreWorkflowNodeVersion(graphView.nodeById.cm1)');
      const back = JSON.parse(runCtx('JSON.stringify(graphView.nodeById.cm1)'));
      if (back.content !== '手写内容 v1') throw new Error('回滚没兜回人工版本');
      if (!back.humanDone) throw new Error('回滚后人工标记应随内容恢复');
      return true;
    });

    check('T355 静态契约：重生成预警必须点名人工定稿下游', () => {
      const src = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
      if (!src.includes('function _countDownstreamHumanDone')) throw new Error('没有人工定稿下游计数');
      if (!src.includes('人工定稿内容不会被覆盖')) throw new Error('重生成面板预警没带人工定稿说明');
      if (!src.includes('重新生成不会覆盖它们')) throw new Error('confirm 预警没带人工定稿说明');
      return true;
    });

    // 收口必须放在 finally 之前：异步用例（整链护栏/版本生命周期）要在夹具还原前跑完
    await drain();
  } finally {
    sandbox.window.getGraphState = prevGet;
    sandbox.window.saveGraphState = prevSave;
    sandbox.window.getCurrentSessionId = prevSid;
    sandbox.document = prevDoc;
    sandbox.escapeHtml = prevEsc;
    delete sandbox.__field;
    if (prevHist === undefined) delete storageData[histKey]; else storageData[histKey] = prevHist;
    vm.runInContext('graphView.nodes = []; graphView.edges = []; graphView.nodeById = {}; graphView.defaultEdges = [];', sandbox);
  }
}
