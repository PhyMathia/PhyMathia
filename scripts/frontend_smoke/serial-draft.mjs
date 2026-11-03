// 串行边界：追问草稿卡重渲保字（T152）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 7965–8040 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion, restoreWindowStub, isLoose } from './_runner.mjs';

export function run() {
// ===== 串行边界追加：追问草稿卡重渲保字（T152，2026-10-05）=====
// 全程同步、只在 vm 沙箱里用假节点，不碰共享键——追加在串行边界之后安全。
check('追问草稿卡渲染（T152→占位提示）：draftInput 作值、建议问题只进 placeholder', () => {
  // 本用例断言的是取值口径（draftInput vs 建议问题），不是转义；而 _renderDraftNodeHtml
  // 走全局 escapeHtml，沙箱 loose document 下产物退化，字面中文断言不出来——
  // 按套件惯例（2226/2543/3354 行同款）断言文案前换恒等，测完恢复。
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    const mk = (extra) => '_renderDraftNodeHtml(' + JSON.stringify({
      id: 'draft-smk', kind: 'draft', x: 0, y: 0,
      portMeta: { branchType: 'followup', question: '端口预填问题' },
      ...extra,
    }) + ')';
    const emptyTail = 'oninput="draftInputChanged(\'draft-smk\', this.value)"></textarea>';
    const typed = vm.runInContext(mk({ draftInput: '我自己打的字' }), sandbox);
    if (!typed.includes('>我自己打的字</textarea>')) throw new Error('重渲后没取节点对象上的 draftInput，字会丢');
    if (!typed.includes('placeholder="端口预填问题"')) throw new Error('建议问题应作 placeholder 灰色提示');
    if (!typed.includes('oninput="draftInputChanged(\'draft-smk\', this.value)"')) throw new Error('textarea 未挂 oninput 回写');
    const cleared = vm.runInContext(mk({ draftInput: '' }), sandbox);
    if (!cleared.includes(emptyTail)) throw new Error('用户主动清空后框内容应为空串（建议问题不再当正文塞回）');
    if (!cleared.includes('placeholder="端口预填问题"')) throw new Error('清空后建议问题应继续作灰色提示');
    const fresh = vm.runInContext(mk({}), sandbox);
    if (!fresh.includes(emptyTail)) throw new Error('无 draftInput 时框内容应为空');
    if (!fresh.includes('placeholder="端口预填问题"')) throw new Error('无 draftInput 时建议问题应作灰色提示');
    const blank = vm.runInContext(mk({ portMeta: { branchType: 'followup', question: '' } }), sandbox);
    if (!blank.includes('placeholder="输入你想追问的问题…"')) throw new Error('端口没解析出问题时也应有兜底灰字提示，框不能裸空');
    if (!blank.includes(emptyTail)) throw new Error('兜底提示只进 placeholder，框内容仍应为空');
    return true;
  } finally { sandbox.escapeHtml = realEsc; }
});

check('追问草稿空发回落：框空着点发送＝采用建议问题（占位提示口径）', () => {
  const src = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!src.includes("_draftSuggestionText(node).trim()")) throw new Error('submitDraftQuestion 空值时应回落建议问题（_draftSuggestionText）');
  if (!/const text = \(input\?\.value \|\| ''\)\.trim\(\)\s*\n\s*\|\|/.test(src)) throw new Error('回落应拼在空值判断同一处，先取框内实文再回落');
  return true;
});

// ===== 串行边界追加：追问自动选路——回答方式下拉（2026-11-03）=====
check('追问草稿卡「回答方式」：追问口有下拉、默认选「自动判断」，学习/苏格拉底口不显示', () => {
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    const render = (extra) => vm.runInContext('_renderDraftNodeHtml(' + JSON.stringify({
      id: 'draft-route', kind: 'draft', x: 1, y: 2,
      portMeta: { branchType: 'followup', question: 'q' },
      draftInput: '',
      ...extra,
    }) + ')', sandbox);
    const followup = render({});
    if (!followup.includes('class="graph-draft-route-select"')) throw new Error('追问草稿卡应有「回答方式」下拉');
    if (!followup.includes('<option value="auto" selected>自动判断</option>')) throw new Error('默认应选中「自动判断」');
    if (!followup.includes('<option value="analysis">拆分分析</option>')) throw new Error('应有「拆分分析」选项');
    if (!followup.includes('<option value="direct">直接回答</option>')) throw new Error('应有「直接回答」选项');
    if (!followup.includes('onchange="draftRouteChanged(\'draft-route\', this.value)"')) throw new Error('下拉没挂 draftRouteChanged');

    const manual = render({ routeMode: 'direct' });
    if (!manual.includes('<option value="direct" selected>直接回答</option>')) throw new Error('routeMode=direct 应选中「直接回答」');
    const manualAnalysis = render({ routeMode: 'analysis' });
    if (!manualAnalysis.includes('<option value="analysis" selected>拆分分析</option>')) throw new Error('routeMode=analysis 应选中「拆分分析」');
    const junk = render({ routeMode: 'nonsense' });
    if (!junk.includes('<option value="auto" selected>自动判断</option>')) throw new Error('非法 routeMode 应回落「自动判断」');

    const learn = render({ portMeta: { branchType: 'learn', question: 'q' } });
    if (learn.includes('graph-draft-route-select')) throw new Error('进阶学习口不应显示回答方式下拉');
    const socratic = render({ portMeta: { branchType: 'socratic', type: 'socratic', question: 'q' } });
    if (socratic.includes('graph-draft-route-select')) throw new Error('苏格拉底口不应显示回答方式下拉');
    const continuePort = render({ portMeta: { branchType: 'continue', question: 'q' } });
    if (continuePort.includes('graph-draft-route-select')) throw new Error('直接问AI 口不应显示回答方式下拉（自动选路只挂追问口）');
    return true;
  } finally { sandbox.escapeHtml = realEsc; }
});

check('draftRouteChanged：回答方式回写，非法/空值归一 auto', () => {
  const out = vm.runInContext(`(() => {
    graphView.nodes = [{ id: 'draft-rc', kind: 'draft', x: 0, y: 0, portMeta: { branchType: 'followup' } }];
    graphView.nodeById = {}; graphView.nodeById['draft-rc'] = graphView.nodes[0];
    draftRouteChanged('draft-rc', 'direct');
    const a = graphView.nodes[0].routeMode;
    draftRouteChanged('draft-rc', 'ANALYSIS');
    const b = graphView.nodes[0].routeMode;
    draftRouteChanged('draft-rc', 'auto');
    const c = graphView.nodes[0].routeMode;
    draftRouteChanged('draft-rc', 'junk');
    const d = graphView.nodes[0].routeMode;
    graphView.nodes = []; graphView.nodeById = {};
    return [a, b, c, d].join(',');
  })()`, sandbox);
  if (out !== 'direct,analysis,auto,auto') throw new Error('routeMode 回写口径不对：' + out);
  return true;
});

check('追问草稿发送：追问口携带回答方式（默认 auto），其他口不带', () => {
  const prevQwf = sandbox.window.startQuestionWorkflow;
  // graphInner 前值若是 loose 代理（某域占位），restore 回 loose 会让后续域假绿——
  // 记 null（等同「未渲染过画布」的干净环境语义）
  const prevInner = vm.runInContext('graphInner', sandbox);
  sandbox.__draftSendPrevInner = isLoose(prevInner) ? null : prevInner;
  const prevNodes = vm.runInContext('JSON.stringify(graphView.nodes || [])', sandbox);
  const prevEdges = vm.runInContext('JSON.stringify(graphView.edges || [])', sandbox);
  const prevById = vm.runInContext('JSON.stringify(graphView.nodeById || {})', sandbox);
  const calls = [];
  sandbox.window.startQuestionWorkflow = (text, opts) => { calls.push({ text, opts }); };
  try {
    vm.runInContext('graphView.nodes = ['
      + '{ id: "draft-send-auto", kind: "draft", x: 0, y: 0, portMeta: { branchType: "followup", fromPort: "out-1" } },'
      + '{ id: "draft-send-manual", kind: "draft", x: 0, y: 0, routeMode: "direct", portMeta: { branchType: "followup", fromPort: "out-1" } },'
      + '{ id: "draft-send-learn", kind: "draft", x: 0, y: 0, portMeta: { branchType: "learn", fromPort: "out-0" } }'
      + '];'
      + 'graphView.nodeById = {};'
      + 'graphView.nodes.forEach(function (n) { graphView.nodeById[n.id] = n; });'
      + 'graphView.edges = [{ from: "m-follow", fromPort: "out-1", to: "draft-send-auto", draft: true },'
      + '  { from: "m-follow", fromPort: "out-1", to: "draft-send-manual", draft: true }];'
      + 'graphInner = { querySelector: function () { return { value: "追问一句" }; } };', sandbox);
    sandbox.submitDraftQuestion('draft-send-auto');
    sandbox.submitDraftQuestion('draft-send-manual');
    sandbox.submitDraftQuestion('draft-send-learn');
  } finally {
    vm.runInContext('graphView.nodes = ' + prevNodes + ';'
      + 'graphView.edges = ' + prevEdges + ';'
      + 'graphView.nodeById = ' + prevById + ';'
      + 'graphInner = globalThis.__draftSendPrevInner; delete globalThis.__draftSendPrevInner;', sandbox);
    restoreWindowStub('startQuestionWorkflow', prevQwf);
  }
  if (calls.length !== 3) throw new Error('应发出三次提问，实际 ' + calls.length);
  if (calls[0].opts.followupRoute !== 'auto') throw new Error('未手动选择的草稿应默认 auto：' + JSON.stringify(calls[0].opts));
  if (calls[0].opts.sourceNodeId !== 'm-follow' || calls[0].opts.sourcePort !== 'out-1') throw new Error('来源节点/端口没带上：' + JSON.stringify(calls[0].opts));
  if (calls[1].opts.followupRoute !== 'direct') throw new Error('手动选「直接回答」的草稿应传 direct：' + JSON.stringify(calls[1].opts));
  if (Object.prototype.hasOwnProperty.call(calls[2].opts, 'followupRoute')) throw new Error('进阶学习草稿不应带 followupRoute：' + JSON.stringify(calls[2].opts));
  return true;
});

check('追问草稿卡重渲回带（T152）：本会话草稿与边带回、别会话不跟、字随对象活', () => {
  const report = JSON.parse(vm.runInContext(`
    (() => {
      const sid = String(_currentSessionId() || '');
      graphView.nodes = [
        { id: 'draft-k1', kind: 'draft', sessionId: sid, x: 1, y: 2, draftInput: '草稿文字', portMeta: { question: 'q' } },
        { id: 'draft-k2', kind: 'draft', sessionId: sid + '_other', x: 3, y: 4, portMeta: { question: 'q' } },
        { id: 'draft-k3', kind: 'draft', x: 5, y: 6, portMeta: { question: 'q' } },
      ];
      graphView.nodeById = {};
      graphView.nodes.forEach(n => { graphView.nodeById[n.id] = n; });
      graphView.edges = [
        { from: 'u1', to: 'draft-k1', draft: true },
        { from: 'u1', to: 'draft-k2', draft: true },
      ];
      const carry = _collectDraftCarry();
      graphView.nodes = [{ id: 'u1', kind: 'user', x: 0, y: 0, w: 100, h: 50 }];
      graphView.nodeById = { u1: graphView.nodes[0] };
      graphView.edges = [];
      _reapplyDraftCarry(carry);
      const out = JSON.stringify({
        ids: graphView.nodes.map(n => n.id),
        edgeTos: graphView.edges.map(e => e.to),
        textKept: (graphView.nodeById['draft-k1'] || {}).draftInput || '',
      });
      graphView.nodes = [];
      graphView.edges = [];
      graphView.nodeById = {};
      return out;
    })()
  `, sandbox));
  if (!report.ids.includes('draft-k1')) throw new Error('本会话草稿未被带回');
  if (report.ids.includes('draft-k2') || report.ids.includes('draft-k3')) throw new Error('别会话/无标记草稿不应跟来');
  if (!report.edgeTos.includes('draft-k1')) throw new Error('本会话草稿边未随节点带回');
  if (report.edgeTos.includes('draft-k2')) throw new Error('别会话草稿边不应跟来');
  if (report.textKept !== '草稿文字') throw new Error('带回的草稿节点应保留已打的字');
  return true;
});

check('追问草稿卡重渲保字（T152）：采集在清空前、带回在重建后（顺序错就白做）', () => {
  const src = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!/const draftCarry = _collectDraftCarry\(\);[\s\S]{0,160}graphView\.nodes = \[\];/.test(src)) {
    throw new Error('草稿采集不在全量清空之前，重建会先丢节点');
  }
  if (!/_syncGroupMembers\(\);[\s\S]{0,80}_reapplyDraftCarry\(draftCarry\);/.test(src)) {
    throw new Error('草稿回带不在节点重建之后、html 拼接之前，卡不会重新渲染出来');
  }
  return true;
});
}
