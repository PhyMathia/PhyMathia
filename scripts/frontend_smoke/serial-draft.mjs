// 串行边界：追问草稿卡重渲保字（T152）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 7965–8040 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ===== 串行边界追加：追问草稿卡重渲保字（T152，2026-10-05）=====
// 全程同步、只在 vm 沙箱里用假节点，不碰共享键——追加在串行边界之后安全。
check('追问草稿卡渲染取值（T152）：draftInput 优先、空串不回落预填、无值保留预填', () => {
  // 本用例断言的是取值口径（draftInput vs 端口预填），不是转义；而 _renderDraftNodeHtml
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
    const typed = vm.runInContext(mk({ draftInput: '我自己打的字' }), sandbox);
    if (!typed.includes('我自己打的字')) throw new Error('重渲后没取节点对象上的 draftInput，字会丢');
    if (typed.includes('端口预填问题')) throw new Error('draftInput 存在时不应回落端口预填');
    if (!typed.includes('oninput="draftInputChanged(\'draft-smk\', this.value)"')) throw new Error('textarea 未挂 oninput 回写');
    const cleared = vm.runInContext(mk({ draftInput: '' }), sandbox);
    if (cleared.includes('端口预填问题')) throw new Error('用户主动清空后不应回落端口预填');
    const fresh = vm.runInContext(mk({}), sandbox);
    if (!fresh.includes('端口预填问题')) throw new Error('无 draftInput 时端口预填应保留');
    return true;
  } finally { sandbox.escapeHtml = realEsc; }
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
