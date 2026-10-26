// Φ 主动体检芯片（2026-10-26，DSH 对照·方向 4 第 1 档）
// 开面板零模型体检（POST /graph/health → harness/selfcheck.check_snapshot_consistency）
// → 发现孤立节点/断链在对话流顶部挂芯片 → 点「拟整理指令」只预填输入框不发送
// → ✕ 收起后同画布同款不再自动出现 → 修好清账、同款再犯重新提示。
// 行为链是单个 async check 串行跑完：期间独占 fetch 与 document.getElementById 两个
// 全局桩，finally 立即还原；域尾 await drain() 收口——入口对本域整体 await，桩窗口
// 不与后续域（workshop 也换 fetch 桩）交叠。
import { check, drain, sandbox, vm, fs, localStorage } from './_runner.mjs';

export async function run() {

check('体检芯片接线契约：开面板触发＋渲染挂顶＋应用后复检＋键走 config.js＋走 /graph/health', () => {
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const openIdx = hSrc.indexOf('async function openGraphHarness()');
  const openBlock = hSrc.slice(openIdx, hSrc.indexOf('function toggleGraphHarnessWindow'));
  if (openIdx < 0 || !openBlock.includes('runHarnessHealthCheck()')) {
    throw new Error('openGraphHarness 未触发体检（fire-and-forget，不阻塞开面板）');
  }
  if (!hSrc.includes("_harnessHealthChipHtml() : ''")) {
    throw new Error('_renderHarnessChat 未把芯片挂到对话流顶部');
  }
  const applySrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  if (!applySrc.includes('runHarnessHealthCheck()')) throw new Error('应用操作后未复检（芯片不会随修复消失）');
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("STORAGE_KEY_HARNESS_HEALTH = 'phymathia_harness_health'")) {
    throw new Error('存储键未走 config.js 常量表');
  }
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('STORAGE_KEY_HARNESS_HEALTH')) throw new Error('芯片段未用键常量');
  if (!runSrc.includes("'/api/harness/graph/health'")) throw new Error('未走 /graph/health 端点');
  return true;
});

check('体检芯片红线：点芯片只预填不发送＋info 级不进芯片＋收起去重＋快照剥 blank/已删', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const chipFn = runSrc.slice(runSrc.indexOf('function applyHarnessHealthChip'), runSrc.indexOf('function dismissHarnessHealthChip'));
  if (chipFn.includes('runGraphHarness')) throw new Error('点芯片自动发送——违反「模型调用只在用户点头后」红线');
  if (!chipFn.includes("getElementById('graphHarnessInstruction')")) throw new Error('点击芯片未预填输入框');
  // 只看结构问题（error/warning）：duplicate_module 是 info 级，进芯片全是噪声
  if (!/severity === 'error' \|\| i\.severity === 'warning'/.test(runSrc)) throw new Error('未过滤 info 级问题');
  // 同画布同问题只提示一次：签名＋dismissed 双字段判定
  if (!/record\.sig === sig && record\.dismissed/.test(runSrc)) throw new Error('缺「收起后同款不再自动出现」判定');
  // 体检快照必须剥掉待生成占位与撤销标记已删节点（它们没连线属预期，不剥全是噪声）
  if (!runSrc.includes("kind === 'blank'")) throw new Error('体检快照未剥 blank 待生成占位');
  if (!runSrc.includes('state.harnessDeleted')) throw new Error('体检快照未剥 harnessDeleted 已删节点');
  return true;
});

check('体检芯片样式契约：accent 派生无硬编码 rgba＋圆角只用 --r-lg/--r-pill', () => {
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const start = css.indexOf('Φ 主动体检芯片');
  if (start < 0) throw new Error('芯片样式段缺失');
  const block = css.slice(start);
  if (!block.includes('.graph-harness-health-chip {')) throw new Error('芯片卡体样式缺失');
  for (const m of block.matchAll(/border-radius\s*:\s*([^;{}]+);/g)) {
    const v = m[1].trim();
    if (v !== 'var(--r-lg)' && v !== 'var(--r-pill)') {
      throw new Error('圆角越权（本组件只许 --r-lg/--r-pill）：' + v);
    }
  }
  if (/rgba?\(\s*\d/.test(block)) throw new Error('硬编码色值违反 Φ 面板主题适配口径（2026-10-16 节）');
  if (!/color-mix\(in srgb, var\(--accent\)/.test(block)) throw new Error('未走 accent 派生配色');
  return true;
});

check('体检芯片行为链：发现问题→挂芯片→点击预填不发送→收起不再骚扰→修好清账→再犯重提示', async () => {
  const savedFetch = sandbox.fetch;
  const savedGEBI = sandbox.document.getElementById;
  const savedCurrentSid = sandbox.window.getCurrentSessionId;
  let healthCalls = 0;
  let capturedSnapshot = null;
  // 2 个孤立节点（芯片该管）＋1 个 duplicate_module（info 级，芯片不该管）
  const ISSUE_PAYLOAD = {
    status: 'ok', ok: false, total: 3, node_count: 2, edge_count: 1,
    issues: [
      { type: 'orphan', severity: 'warning', node_id: 'n1', label: '孤立甲', message: '节点「孤立甲」没有任何连线' },
      { type: 'orphan', severity: 'warning', node_id: 'n2', label: '孤立乙', message: '节点「孤立乙」没有任何连线' },
      { type: 'duplicate_module', severity: 'info', node_id: 'm1', label: 'physics', message: '存在 2 个模块' },
    ],
  };
  const CLEAN_PAYLOAD = { status: 'ok', ok: true, total: 0, node_count: 2, edge_count: 2, issues: [] };
  let payload = ISSUE_PAYLOAD;
  sandbox.fetch = async (url, opts) => {
    if (String(url).includes('/api/harness/graph/health')) {
      healthCalls++;
      capturedSnapshot = JSON.parse(opts.body).snapshot;
      return { ok: true, status: 200, json: async () => payload };
    }
    // 其余请求（历史加载等）走默认语义，杜绝点芯片路径意外触发网络
    return { ok: true, status: 200, json: async () => ({ value: [] }) };
  };
  const inputStub = { value: '', focusCount: 0, focus() { this.focusCount++; } };
  sandbox.document.getElementById = (id) => (id === 'graphHarnessInstruction' ? inputStub : savedGEBI(id));
  try {
    // 场景：sess_health 画布——2 个正常节点＋1 个 blank 占位＋1 个撤销已删节点；
    // 连线：一条真断链（指向不存在的 ghost9，该保留）＋一条指向 blank 的（该剥）＋一条指向已删节点的（该剥）
    sandbox.window.getCurrentSessionId = () => 'sess_health';
    sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
    sandbox.window.getGraphState = () => ({ harnessDeleted: { nd1: true } });
    sandbox.window.getGraphViewNodes = () => [
      { id: 'n1', kind: 'human_note', label: '孤立甲' },
      { id: 'n2', kind: 'human_note', label: '孤立乙' },
      { id: 'b1', kind: 'blank', label: '待生成' },
      { id: 'nd1', kind: 'human_note', label: '已撤销' },
    ];
    sandbox.window.getGraphViewEdges = () => [
      { key: 'e_ghost', from: 'n1', to: 'ghost9' },
      { key: 'e_blank', from: 'n1', to: 'b1' },
      { key: 'e_del', from: 'n2', to: 'nd1' },
    ];
    vm.runInContext('phiSessions = { phi_h: { id: "phi_h", title: "t", boundSid: "sess_health", createdAt: 1, updatedAt: 1 } }; currentPhiId = "phi_h"; harnessHistory = []; harnessHealthHint = null;', sandbox);
    localStorage.removeItem('phymathia_harness_health');

    // ① 首次体检：发一次请求、快照剥掉 blank/已删、芯片就位、提示记录落盘
    await sandbox.runHarnessHealthCheck();
    if (healthCalls !== 1) throw new Error('应恰好发一次体检请求：' + healthCalls);
    if (!capturedSnapshot) throw new Error('未携带体检快照');
    if (capturedSnapshot.nodes.length !== 2 || capturedSnapshot.nodes.some(n => n.id === 'b1' || n.id === 'nd1')) {
      throw new Error('体检快照应剥掉 blank 占位与已删节点：' + JSON.stringify(capturedSnapshot.nodes));
    }
    if (capturedSnapshot.edges.length !== 1 || capturedSnapshot.edges[0].key !== 'e_ghost') {
      throw new Error('真断链该保留、触及 blank/已删的连线该剥：' + JSON.stringify(capturedSnapshot.edges));
    }
    const hint1 = vm.runInContext('harnessHealthHint', sandbox);
    if (!hint1 || !hint1.instruction.includes('孤立甲') || !hint1.instruction.includes('孤立乙')) {
      throw new Error('芯片未生成或指令未点名节点：' + JSON.stringify(hint1));
    }
    if (hint1.issues.length !== 2) throw new Error('info 级 duplicate_module 不该进芯片：' + hint1.issues.length);
    const rec1 = JSON.parse(localStorage.getItem('phymathia_harness_health'));
    if (!rec1.sess_health || !rec1.sess_health.sig || rec1.sess_health.dismissed) throw new Error('提示记录未落盘或形状不对');
    const chipHtml = sandbox._harnessHealthChipHtml();
    if (!chipHtml.includes('孤立节点') || !chipHtml.includes('applyHarnessHealthChip') || !chipHtml.includes('dismissHarnessHealthChip')) {
      throw new Error('芯片 DOM 契约缺失：' + chipHtml);
    }

    // ② 同款问题第二次开面板：重新体检但不算新提示（不刷状态行，芯片照挂）
    await sandbox.runHarnessHealthCheck();
    if (healthCalls !== 2) throw new Error('每次开面板都应真体检（本地零模型，不怕重复）');
    if (!vm.runInContext('harnessHealthHint', sandbox)) throw new Error('未收起时同款问题芯片应持续在场');

    // ③ 点芯片＝预填，不发送：无任何新网络请求
    sandbox.applyHarnessHealthChip();
    if (!inputStub.value.includes('孤立甲')) throw new Error('点击芯片未预填指令');
    if (inputStub.focusCount < 1) throw new Error('未聚焦输入框');
    if (healthCalls !== 2) throw new Error('点芯片触发了网络请求（违反零模型红线）');

    // ④ 未绑当前画布：不体检（芯片指令发不出去的场合不提示）
    sandbox.window.getCurrentSessionId = () => 'sess_other';
    healthCalls = 0;
    await sandbox.runHarnessHealthCheck();
    if (healthCalls !== 0) throw new Error('绑定画布≠当前画布仍发起体检');
    sandbox.window.getCurrentSessionId = () => 'sess_health';

    // ⑤ ✕ 收起：同款问题不再自动出现（仍会体检，但芯片不回）
    sandbox.dismissHarnessHealthChip();
    if (vm.runInContext('harnessHealthHint', sandbox) !== null) throw new Error('收起未清芯片状态');
    const rec5 = JSON.parse(localStorage.getItem('phymathia_harness_health'));
    if (!rec5.sess_health.dismissed) throw new Error('收起未写 dismissed 标记');
    if (sandbox._harnessHealthChipHtml() !== '') throw new Error('收起后芯片仍渲染');
    healthCalls = 0;
    await sandbox.runHarnessHealthCheck();
    if (healthCalls !== 1) throw new Error('收起后不该再发体检');
    if (vm.runInContext('harnessHealthHint', sandbox) !== null) throw new Error('收起后同款问题又自动出现了');

    // ⑥ 修好：复检清账（记录删除、芯片移除）
    payload = CLEAN_PAYLOAD;
    await sandbox.runHarnessHealthCheck();
    const rec6 = JSON.parse(localStorage.getItem('phymathia_harness_health') || '{}');
    if (rec6.sess_health) throw new Error('修好后提示记录未清——同款再犯将不再提示');

    // ⑦ 同款再犯：重新提示（清账生效的直接证明）
    payload = ISSUE_PAYLOAD;
    await sandbox.runHarnessHealthCheck();
    if (!vm.runInContext('harnessHealthHint', sandbox)) throw new Error('清账后同款问题再犯未重新提示');
    return true;
  } finally {
    sandbox.fetch = savedFetch;
    sandbox.document.getElementById = savedGEBI;
    sandbox.window.getCurrentSessionId = savedCurrentSid;
    localStorage.removeItem('phymathia_harness_health');
    vm.runInContext('harnessHealthHint = null;', sandbox);
  }
});

await drain();
}
