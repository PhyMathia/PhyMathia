// 临时调试：重放 T313 窗口A 用例，打印每一步的落点
import { code, sandbox, vm, localStorage } from './frontend_smoke/_runner.mjs';

const wfEval = (c) => vm.runInContext(c, sandbox);
const A = 'a313w', B = 'b313w';

sandbox.localStorage.setItem('phymathia_current_session', A);
wfEval('currentSessionId = ' + JSON.stringify(A) + '; SESSION_ID = ' + JSON.stringify('r' + A) + ';'
  + ' sessions = { ' + A + ': { id: "' + A + '", sessionId: "r' + A + '", title: "", updatedAt: 1 }, '
  + B + ': { id: "' + B + '", sessionId: "r' + B + '", title: "B 画布", updatedAt: 1 } };'
  + ' chatHistory = []; workflowRunActive = false;');
sandbox.localStorage.setItem('phymathia_graph_' + A, JSON.stringify({ customNodes: [], connections: [], updatedAt: 1 }));
wfEval('__wfMiniRender = function() {'
  + '  const st = window.getGraphState(getCurrentSessionId());'
  + '  graphView.nodes = (st.customNodes || []).map(function(n) { return Object.assign({}, n); });'
  + '  graphView.nodeById = {};'
  + '  graphView.nodes.forEach(function(n) { graphView.nodeById[n.id] = n; });'
  + '  graphView.edges = (st.connections || []).slice();'
  + '};');
sandbox.renderGraphCanvas = () => wfEval('__wfMiniRender()');
sandbox._scheduleWorkflowStreamProgress = () => {};
sandbox._setWorkflowStopButton = () => {};
sandbox.showToast = (m) => console.log('[toast]', m);
sandbox.showProgress = () => {};
sandbox.hideProgress = () => {};
sandbox.getActiveModelForRole = () => ({ id: 'mock-agent' });

console.log('phyIsReadonly =', wfEval('typeof phyIsReadonly === "function" ? phyIsReadonly() : "nofn"'));
console.log('getCurrentSessionId() =', wfEval('getCurrentSessionId()'));
console.log('window.getCurrentSessionId() =', wfEval('window.getCurrentSessionId()'));
console.log('_isSendBusy() =', wfEval('typeof _isSendBusy === "function" ? _isSendBusy() : "nofn"'));

let switched = false;
const frames = [
  '核心物理概念：量子隧穿。核心数学结构：势阱穿透系数。\n',
  '建议模块：物理视角、数学视角\n',
];
sandbox.proxyChat = async (...args) => {
  console.log('[proxyChat] sid arg =', args[2]);
  return {
    ok: true, status: 200,
    body: { getReader() {
      let i = 0;
      return { read: async () => {
        if (i === 1 && !switched) {
          switched = true;
          console.log('[switch] -> B');
          sandbox.localStorage.setItem('phymathia_current_session', B);
          wfEval('currentSessionId = ' + JSON.stringify(B) + '; SESSION_ID = ' + JSON.stringify('r' + B) + ';');
          wfEval('__wfMiniRender()');
        }
        if (i < frames.length) {
          const chunk = 'data: ' + JSON.stringify({ choices: [{ delta: { content: frames[i++] } }] }) + '\n\n';
          return { done: false, value: new TextEncoder().encode(chunk) };
        }
        return { done: true, value: undefined };
      } };
    } },
  };
};
sandbox._createWorkflowModuleNodes = function(keys, answerId, sid) {
  console.log('[createMods] keys =', keys, 'answerId =', answerId, 'sid =', sid);
  throw new Error('__stop__');
};

try {
  await sandbox.startQuestionWorkflow('量子隧穿是什么？', {}, '', false);
  console.log('[flow] returned without throwing');
} catch (e) {
  console.log('[flow] threw:', e.message);
}
console.log('switched =', switched);
const aState = JSON.parse(localStorage.getItem('phymathia_graph_' + A) || '{}');
console.log('A customNodes =', JSON.stringify((aState.customNodes || []).map(n => ({ id: n.id, kind: n.kind, analysis: (n.analysis || '').slice(0, 20), busy: n.busy }))));
console.log('_taskActiveCtx =', wfEval('JSON.stringify(_taskActiveCtx && { taskId: _taskActiveCtx.taskId, sessionId: _taskActiveCtx.sessionId, nodes: [..._taskActiveCtx.nodes.keys()] })'));
process.exit(0);
