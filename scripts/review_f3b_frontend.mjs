#!/usr/bin/env node
// F3 绑定补丁回归：纯视图变化（平移/缩放/聚焦）不得让 Φ 建议作废；内容变化仍必须拒绝；
// 迁移前落盘的旧历史条目不得变成死按钮；版本指纹必须保持短小。
// 真实源码 + 隔离 VM/存储/模拟后端，无网络、不触碰项目 data/。
//   node scripts/review_f3b_frontend.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const load = (s, name) => vm.runInContext(fs.readFileSync(new URL('src/static/js/' + name, root), 'utf8'), s, { filename: name });
const evaluate = (s, code) => vm.runInContext(code, s);
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tests = [];
const test = (name, run) => tests.push({ name, run });

function element() {
  return { value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {} };
}

const harnessModules = ['config.js', 'session.js', 'harness.js', 'harness-run.js', 'harness-preview.js', 'harness-apply.js'];

// 只替换视图与网络边界；快照/应用/保存/加载仍是真实源码。
function harnessFixture({ kv = {} } = {}) {
  const elements = new Map(), storage = new Map(), statuses = [], calls = [];
  let uuid = 0;
  const s = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    AbortController, TextDecoder, TextEncoder, crypto: { randomUUID: () => 'f3b-' + (++uuid) },
    localStorage: {
      getItem: k => storage.get(k) ?? null,
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: k => storage.delete(k),
    },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      body: element(), querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {},
    },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET' });
      if (url.startsWith('/api/kv/')) return { ok: true, json: async () => ({ value: kv[url] ?? null }) };
      return { ok: true, json: async () => ({}) };
    },
    alert: () => {},
  };
  s.window = s;
  vm.createContext(s);
  for (const name of harnessModules) load(s, name);
  evaluate(s, "currentSessionId='A'; SESSION_ID='remoteA'; sessions={A:{sessionId:'remoteA'},B:{sessionId:'remoteB'}};");
  s.getGraphViewNodes = () => s.getGraphState().customNodes;
  s.getGraphViewEdges = () => [];
  s.getSelectedGraphNodeIds = () => [];
  s._setHarnessStatus = (msg, kind) => statuses.push({ msg, kind });
  s._setPhiMode = () => {};
  s._renderHarnessChat = () => {};
  s.flushGraphStateServerSave = async () => {};
  return { s, storage, statuses, calls };
}

function seedGraph(s, extra = {}) {
  const state = s.getGraphState('A');
  state.customNodes = [{ id: 'custom', kind: 'human_note', content: 'old' }];
  Object.assign(state, extra);
  s.saveGraphState('A', state);
  return state;
}

// 面板里的待应用建议：绑定按真实请求路径取得
function armResult(s, content = 'patched') {
  evaluate(s, `harnessResult={summary:'edit',operations:[{op:'update_node',id:'custom',patch:{content:${JSON.stringify(content)}}}],_binding:null};`);
  evaluate(s, 'harnessResult._binding=_harnessBinding();');
  return clone(evaluate(s, 'harnessResult._binding'));
}

const graphContent = (s, sid = 'A') => (s.getGraphState(sid).customNodes.find(n => n.id === 'custom') || {}).content;

// ---- 1. 纯视图变化不得让建议作废（本补丁修的回归）----
for (const [label, patch] of [
  ['pan', { pan: { x: 400, y: 33 } }],
  ['zoom', { zoom: 1.7 }],
  ['focus+pan', { focus: 'custom', pan: { x: -20, y: 90 } }],
]) {
  test('view-only change (' + label + ') must not block apply', async () => {
    const { s, statuses } = harnessFixture();
    seedGraph(s);
    armResult(s);
    const moved = s.getGraphState('A');
    Object.assign(moved, patch);
    s.saveGraphState('A', moved);          // 用户等待生成时拖动/缩放画布
    s.applyGraphHarness();
    await settle();
    assert.equal(graphContent(s), 'patched', 'pan/zoom must not invalidate a suggestion');
    assert.ok(!statuses.some(x => /画布或会话已变化/.test(x.msg)), 'must not warn about a changed canvas');
  });
}

// ---- 2. 真实内容变化仍必须拒绝 ----
for (const [label, mutate] of [
  ['node content override', s => { const st = s.getGraphState('A'); st.harnessNodeOverrides = { custom: { content: 'user wrote this' } }; s.saveGraphState('A', st); }],
  ['node set', s => { const st = s.getGraphState('A'); st.customNodes.push({ id: 'extra', kind: 'human_note', content: 'mine' }); s.saveGraphState('A', st); }],
  ['deleted marker', s => { const st = s.getGraphState('A'); st.harnessDeleted = { custom: true }; s.saveGraphState('A', st); }],
  ['edge removal', s => { const st = s.getGraphState('A'); st.removedEdges = ['custom:out-0->other:in-0']; s.saveGraphState('A', st); }],
]) {
  test('content change (' + label + ') must still block apply', async () => {
    const { s, statuses } = harnessFixture();
    seedGraph(s);
    armResult(s);
    mutate(s);
    s.applyGraphHarness();
    await settle();
    assert.equal(graphContent(s), 'old', 'a real graph edit must invalidate the suggestion');
    assert.ok(statuses.some(x => /画布或会话已变化/.test(x.msg)), 'user must be told why nothing happened');
  });
}

// ---- 3. 会话切换仍必须拒绝（冻结契约：无绑定的条目注入后不放行）----
test('session switch must still block apply', async () => {
  const { s } = harnessFixture();
  seedGraph(s);
  for (const sid of ['A', 'B']) {
    const state = s.getGraphState(sid);
    state.customNodes = [{ id: 'custom', kind: 'human_note', content: sid }];
    s.saveGraphState(sid, state);
  }
  armResult(s);
  evaluate(s, "currentSessionId='B';");
  s.applyGraphHarness();
  await settle();
  assert.equal(graphContent(s, 'B'), 'B', 'A suggestion must not be applied to B');
});

test('frozen contract: directly injected binding-less entry stays rejected', async () => {
  const { s } = harnessFixture();
  seedGraph(s);
  evaluate(s, "harnessHistory=[{id:'old-A',decision:'pending',operations:[{op:'update_node',id:'custom',patch:{content:'A-only'}}]}];");
  evaluate(s, "currentSessionId='B';");
  s.keepHarnessSuggestion('old-A');
  await settle();
  assert.equal(clone(evaluate(s, 'harnessHistory[0].decision')), 'pending', 'unattributed entry must not apply');
  assert.equal(graphContent(s, 'B'), undefined, 'source graph must stay untouched');
});

// ---- 4. 迁移前落盘的旧条目不得变成死按钮 ----
test('legacy history entry with full-JSON version migrates and applies', async () => {
  const { s, storage } = harnessFixture();
  seedGraph(s);
  const legacyGraph = clone(s.getGraphState('A'));
  legacyGraph.pan = { x: 5, y: 5 };
  const entry = {
    id: 'legacy-1', role: 'assistant', decision: 'pending', summary: '旧建议',
    operations: [{ op: 'update_node', id: 'custom', patch: { content: 'patched' } }],
    _binding: { sessionId: 'A', graphVersion: JSON.stringify(legacyGraph), epoch: 0 },
  };
  storage.set('phymathia_harness_history_A', JSON.stringify([entry]));
  await s._loadHarnessHistory();
  await settle();
  const binding = clone(evaluate(s, 'harnessHistory[0]._binding'));
  assert.match(String(binding.graphVersion), /^v2:/, 'legacy version must be converted to a content fingerprint');
  const moved = s.getGraphState('A');
  moved.pan = { x: 900, y: 12 };
  s.saveGraphState('A', moved);                    // 与生成建议时只差视图位置
  s.keepHarnessSuggestion('legacy-1');
  await settle();
  assert.equal(graphContent(s), 'patched', 'legacy suggestion must remain applicable after view-only changes');
});

test('migrated legacy entry is still strict about content changes', async () => {
  const { s, storage, statuses } = harnessFixture();
  seedGraph(s);
  const entry = {
    id: 'legacy-2', role: 'assistant', decision: 'pending',
    operations: [{ op: 'update_node', id: 'custom', patch: { content: 'patched' } }],
    _binding: { sessionId: 'A', graphVersion: JSON.stringify(clone(s.getGraphState('A'))), epoch: 0 },
  };
  storage.set('phymathia_harness_history_A', JSON.stringify([entry]));
  await s._loadHarnessHistory();
  await settle();
  const edited = s.getGraphState('A');
  edited.customNodes[0].content = 'user edited meanwhile';
  s.saveGraphState('A', edited);
  s.keepHarnessSuggestion('legacy-2');
  await settle();
  assert.equal(graphContent(s), 'user edited meanwhile', 'a real content change must still block a migrated entry');
  assert.ok(statuses.some(x => /画布或会话已变化/.test(x.msg)));
});

test('untagged legacy entry keeps its session and applies', async () => {
  const { s, storage } = harnessFixture();
  seedGraph(s);
  storage.set('phymathia_harness_history_A', JSON.stringify([{
    id: 'legacy-3', role: 'assistant', decision: 'pending',
    operations: [{ op: 'update_node', id: 'custom', patch: { content: 'patched' } }],
  }]));
  await s._loadHarnessHistory();
  await settle();
  const binding = clone(evaluate(s, 'harnessHistory[0]._binding'));
  assert.equal(binding.sessionId, 'A', 'loaded entries must carry their session attribution');
  assert.equal(binding.graphVersion, null, 'no fingerprint is honest for pre-binding entries');
  s.keepHarnessSuggestion('legacy-3');
  await settle();
  assert.equal(graphContent(s), 'patched', 'pre-binding entries must not become dead buttons');
});

// ---- 5. 迁移不得在读到服务端副本之前回推，避免旧列表盖掉更新历史 ----
test('migration must not push local history to the server before it is read', async () => {
  const { s, storage, calls } = harnessFixture();
  seedGraph(s);
  storage.set('phymathia_harness_history_A', JSON.stringify([{
    id: 'legacy-5', role: 'assistant', decision: 'pending',
    operations: [{ op: 'update_node', id: 'custom', patch: { content: 'patched' } }],
  }]));
  await s._loadHarnessHistory();
  await settle();
  assert.equal(calls.filter(c => c.method === 'POST').length, 0, 'local migration must not POST over a not-yet-read server copy');
  assert.match(storage.get('phymathia_harness_history_A'), /"sessionId":"A"/, 'migrated entry must still be cached locally');
});

// ---- 6. 指纹短小 + 迁移后存储不再背画布副本 ----
test('binding stores a short fingerprint instead of a canvas copy', async () => {
  const { s, storage } = harnessFixture();
  const big = seedGraph(s);
  big.customNodes[0].content = 'x'.repeat(60000);
  s.saveGraphState('A', big);
  armResult(s);
  const version = evaluate(s, 'harnessResult._binding.graphVersion');
  assert.ok(version.length < 64, 'fingerprint must stay short, got ' + version.length);
  assert.ok(!version.includes('xxxx'), 'fingerprint must not embed node content');

  const legacy = { id: 'legacy-4', role: 'assistant', decision: 'pending', operations: [],
    _binding: { sessionId: 'A', graphVersion: JSON.stringify(clone(s.getGraphState('A'))), epoch: 0 } };
  storage.set('phymathia_harness_history_A', JSON.stringify([legacy]));
  const before = storage.get('phymathia_harness_history_A').length;
  await s._loadHarnessHistory();
  await settle();
  const after = storage.get('phymathia_harness_history_A').length;
  assert.ok(after < before / 10, `stored history must shrink after migration (${before} -> ${after})`);
});

// ---- 6. 本地配额失败不得连累服务端同步与面板渲染 ----
test('history save survives a localStorage quota error', async () => {
  const { s, storage, calls } = harnessFixture();
  seedGraph(s);
  evaluate(s, "harnessHistory=[{id:'h1',role:'assistant',decision:'keep',operations:[]}];");
  const original = s.localStorage.setItem;
  s.localStorage.setItem = (k, v) => {
    if (k.startsWith('phymathia_harness_history_')) throw new Error('QuotaExceededError');
    return original(k, v);
  };
  await s._saveHarnessHistory();
  await settle();
  assert.ok(calls.some(c => c.url.includes('harness_history%3AA') && c.method === 'POST'),
    'server sync must still happen when the local cache cannot be written');
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.run(); pass++; console.log('PASS', t.name); }
  catch (err) { fail++; console.error('FAIL', t.name, err.stack); }
}
console.log(`F3 binding: ${pass} PASS, ${fail} FAIL (${tests.length} total)`);
process.exitCode = fail ? 1 : 0;
