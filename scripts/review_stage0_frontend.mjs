#!/usr/bin/env node
// Stage 0 only: real source functions, isolated VM/storage, simulated backend, no network.
// Baseline ee238eb53e43dc7732d1486b37d532fba895cfa3; existing dirty docs left untouched.
// Run from any cwd: node /absolute/path/scripts/review_stage0_frontend.mjs [--runxfail]
// XFAIL catches only assertion failures; XPASS and setup/runtime errors fail the suite.
// Bounded evidence, NOT browser/E2E certification:
// F1 tests apply/save/load, not full render, drag, or server reload.
// F2 tests delayed save/reentrant local reply, not model streaming, save rejection, or switch races.
// F3 seeds an A result/history then changes active sid; actual apply and persistence execute.
//    In-flight review/history fetch and switchToSession UI lifecycle remain pending.
// F4 real regenerateResponse/sendQuick/sendMessage; DOM and anchor consumption are boundaries.
//    Truncation of the old user turn AND subsequent turns is deliberately preserved.
// F5 actual review snapshot -> _applyOps -> conversational before-state, checkpoint control.
//    Python inverse replay, ai_eval restoration and exact full-graph undo remain pending.
// Backend same-batch two-confirm/stage-goal promotion contracts are untouched, not retested here.
// No Python companion, business changes, bundle rebuild, logs or plan edits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const root = new URL('../', import.meta.url);
const clone = x => JSON.parse(JSON.stringify(x));
const load = (s, name) => vm.runInContext(fs.readFileSync(new URL('src/static/js/' + name, root), 'utf8'), s, { filename: name });
const evaluate = (s, code) => vm.runInContext(code, s);
const requireSetup = (condition, message) => { if (!condition) throw new Error('SETUP/CONTROL: ' + message); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tests = [];
const test = (name, reason, run) => tests.push({ name, reason, run });

async function memorySandbox() {
  const nodes = new Map();
  const storage = new Map();
  const profile = { enabled: true, explicit: { goal: 'old' }, facts: [{ id: 'old', fact: 'old fact' }], pending: [], archive: [] };
  const s = { console, getDeviceId: () => 'stage0-only', setTimeout: () => 0,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k) },
    document: { getElementById(id) { if (!nodes.has(id)) nodes.set(id, { textContent: '', innerHTML: '', classList: { add() {}, remove() {} } }); return nodes.get(id); } },
    fetch: async () => ({ ok: true, json: async () => clone(profile) }), escapeHtml: String,
  };
  s.window = s;
  vm.createContext(s);
  vm.runInContext(fs.readFileSync(new URL('src/static/js/memory.js', root), 'utf8'), s, { filename: 'memory.js' });
  await s.memoryRefreshCache();
  return { s, profile, storage };
}

test('M1 interleaved deletion retains concurrent fact/settings', 'memoryDeleteFact PUTs the stale complete GET snapshot', async () => {
  const { s, profile } = await memorySandbox();
  let interleaved = false;
  let puts = 0;
  s.fetch = async (url, options = {}) => {
    if (options.method === 'PUT') {
      puts++;
      Object.assign(profile, clone(JSON.parse(options.body).updates));
      return { ok: true, json: async () => clone(profile) };
    }
    const snapshot = clone(profile);
    if (!interleaved) {
      interleaved = true;
      profile.facts.push({ id: 'concurrent', fact: 'new fact' });
      profile.enabled = false;
      profile.explicit.goal = 'new goal';
    }
    return { ok: true, json: async () => snapshot };
  };
  await s.memoryDeleteFact('old');
  await Promise.resolve();
  // Preconditions are ordinary assertions too, but never confused with the expected defect.
  if (puts !== 1 || profile.facts.some(f => f.id === 'old')) throw new Error('M1 setup/delete control failed');
  assert.deepEqual({ ids: profile.facts.map(f => f.id), enabled: profile.enabled, goal: profile.explicit.goal },
    { ids: ['concurrent'], enabled: false, goal: 'new goal' }, 'unrelated concurrent data must survive deleting old');
});

for (const category of ['goal', 'interest', 'weakness']) {
  test('M5 idle ' + category, 'module context includes idle facts', async () => {
    const { s, profile } = await memorySandbox();
    profile.facts = [{ category, fact: 'ACTIVE', status: 'active' }, { category, fact: 'IDLE', status: 'idle' }];
    await s.memoryRefreshCache();
    const text = s.memoryCachedContext();
    requireSetup(text.includes('ACTIVE'), 'active context missing');
    assert.equal(text.includes('IDLE'), false, 'idle fact must not enter module context');
  });
}
test('M5 disabled control', null, async () => {
  const { s, profile } = await memorySandbox(); profile.enabled = false;
  await s.memoryRefreshCache(); assert.equal(s.memoryCachedContext(), '');
});

async function signals(count, outcome) {
  const fixture = await memorySandbox(); const { s, storage } = fixture;
  s.QUIZ_STATS_KEY = 'phymathia_quiz_stats'; load(s, 'quiz-stats.js');
  storage.set(s.QUIZ_STATS_KEY, JSON.stringify(Object.fromEntries(Array.from({ length: count }, (_, i) => ['topic' + i, { title: '主题' + i, wrong: 2, mastery: 0 }]))));
  const submitted = [];
  s.fetch = async (url, opts = {}) => {
    if (url === '/api/profile/candidates') {
      submitted.push(JSON.parse(opts.body).candidates);
      // Current API returns the same {changed:0,promoted:[]} for disabled and storage failure.
      if (outcome === 'ignored') fixture.profile.enabled = false; // stale enabled cache at POST time
      return { ok: outcome !== 'http-failure', json: async () => ({ changed: outcome === 'accepted' ? Math.min(count, 6) : 0, promoted: [] }) };
    }
    return { ok: true, json: async () => clone(fixture.profile) };
  };
  return { ...fixture, submitted };
}
test('M6 candidate/mark pairing >6', 'eight marks accompany six submitted candidates', async () => {
  const { s } = await signals(8, 'accepted'); const batch = s._collectProfileSignalCandidates();
  requireSetup(batch.candidates.length === 6, 'six candidate cap changed');
  assert.deepEqual(Object.keys(batch.marks), clone(batch.candidates.map(c => 'weak:' + c.fact.replace('检测多次答错：', ''))), 'only paired submitted marks are eligible');
});
test('M6 accepted first batch leaves two for next batch', 'unsent seventh/eighth candidates consume seven-day window', async () => {
  const { s, submitted } = await signals(8, 'accepted');
  await s._syncProfileSignals(); await settle();
  requireSetup(submitted.length === 1 && submitted[0].length === 6, 'first submission not six');
  assert.equal(s._collectProfileSignalCandidates().candidates.length, 2, 'remaining two must still be eligible');
});
for (const outcome of ['accepted', 'ignored', 'http-failure']) {
  test('M6 sync ' + outcome, outcome === 'ignored' ? 'HTTP 200 ignored still marked successful' : null, async () => {
    const { s, storage, submitted } = await signals(2, outcome);
    await s._syncProfileSignals(); await settle();
    requireSetup(submitted.length === 1, 'POST must execute');
    assert.equal(Object.keys(JSON.parse(storage.get('phymathia_memory_signal_sync') || '{}')).length, outcome === 'accepted' ? 2 : 0, 'only accepted submissions consume marks');
  });
}
test('M6 locally disabled control', null, async () => {
  const { s, profile, submitted } = await signals(2, 'accepted'); profile.enabled = false;
  await s.memoryRefreshCache(); await s._syncProfileSignals(); assert.equal(submitted.length, 0);
});

for (const outcome of ['backup-failure', 'profile-failure', 'learning-failure', 'success']) {
  test('M8 clear ' + outcome, outcome === 'success' ? null : 'clear continues or claims success after failed ' + outcome, async () => {
    const { s, storage } = await memorySandbox(); const calls = [];
    s.document.getElementById('memoryClearIncludeLearning').checked = true;
    storage.set('phymathia_knowledge', 'keep me');
    s.exportData = async () => { calls.push('backup'); if (outcome === 'backup-failure') throw new Error('injected backup failure'); };
    s.fetch = async (url, opts = {}) => {
      if (opts.method === 'DELETE') calls.push(url);
      const failed = opts.method === 'DELETE' && ((url.startsWith('/api/profile') && outcome === 'profile-failure') || (url === '/api/sessions' && outcome === 'learning-failure'));
      return { ok: !failed, status: failed ? 503 : 200, json: async () => ({ enabled: true, facts: [], pending: [], archive: [] }) };
    };
    await s.memoryConfirmClear(); await settle();
    requireSetup(calls[0] === 'backup', 'backup must precede deletion');
    const toast = s.document.getElementById('modelToast').textContent;
    if (outcome === 'success') {
      assert.equal(calls.length, 3); assert.equal(storage.has('phymathia_knowledge'), false); assert.match(toast, /学习数据已一并清除/);
    } else if (outcome === 'backup-failure') {
      assert.deepEqual(calls, ['backup'], 'backup failure must abort destructive operations');
    } else {
      assert.equal(toast.includes('记忆已清除') && toast.includes('学习数据已一并清除'), false, 'must not claim complete success');
    }
  });
}

// Explicit DOM boundary, no loose globals: missing dependencies fail as setup errors.
function frontendSandbox(modules) {
  const elements = new Map(), storage = new Map(), errors = [];
  const element = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {} });
  let uuid = 0;
  const s = { console: { log() {}, warn(...args) { errors.push(args); }, error(...args) { errors.push(args); } },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    AbortController, TextDecoder, TextEncoder, crypto: { randomUUID: () => 'stage0-' + (++uuid) },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k,v) => storage.set(k,String(v)), removeItem: k => storage.delete(k) },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      body: element(), querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {} },
    fetch: async url => { throw new Error('Unexpected mock request: ' + url); },
    alert: msg => { throw new Error('Unexpected alert: ' + msg); },
  };
  s.window = s; vm.createContext(s);
  for (const name of modules) load(s, name);
  return { s, storage, errors };
}
function sessionsFixture(extra = []) {
  const f = frontendSandbox(['config.js', 'session.js', ...extra]);
  evaluate(f.s, "currentSessionId='A'; SESSION_ID='remoteA'; sessions={A:{sessionId:'remoteA'},B:{sessionId:'remoteB'}};");
  f.s.localStorage.setItem('phymathia_current_session', 'A');
  return f;
}
const harnessModules = ['harness.js', 'harness-run.js', 'harness-preview.js', 'harness-apply.js'];
function harnessFixture() {
  const f = sessionsFixture(harnessModules); const { s } = f;
  // View/render boundaries only; snapshot/apply/save/load/history remain actual source.
  s.getGraphViewNodes = () => s.getGraphState().customNodes;
  s.getGraphViewEdges = () => [];
  s.getSelectedGraphNodeIds = () => [];
  s._setHarnessStatus = () => {}; s._setPhiMode = () => {}; s._renderHarnessChat = () => {};
  s.flushGraphStateServerSave = async () => {};
  s.fetch = async () => ({ ok: true, json: async () => ({}) });
  return f;
}

test('F1 override save/load round trip', 'getGraphState omits harnessNodeOverrides', async () => {
  const { s } = harnessFixture();
  const state = s.getGraphState(); state.customNodes = [{ id: 'custom', kind: 'human_note', content: 'old' }];
  s.getGraphViewNodes = () => [{ id: 'derived', kind: 'module', content: 'old derived' }];
  s._applyOneHarnessOp({ op: 'update_node', id: 'derived', patch: { content: 'new derived', formula: 'x^2' } }, state, new Map());
  s._applyOneHarnessOp({ op: 'update_node', id: 'custom', patch: { content: 'new custom' } }, state, new Map());
  requireSetup(state.harnessNodeOverrides.derived.content === 'new derived', 'actual apply must produce override');
  s.saveGraphState('A', state);
  const loaded = s.getGraphState('A');
  requireSetup(loaded.customNodes[0].content === 'new custom', 'custom node roundtrip control');
  assert.deepEqual(clone(loaded.harnessNodeOverrides || {}), clone(state.harnessNodeOverrides), 'derived-node overrides must survive storage loading');
});

function chatFixture() {
  const f = sessionsFixture(['chat.js', 'chat-features.js']); const { s } = f;
  // Render and branch-anchor boundary; actual send/regenerate paths are not replaced.
  s.addMessage = () => null; s.renderSessionList = () => {}; s.scrollToBottom = () => {};
  s._consumePendingBranch = () => { const value = s.anchor; s.anchor = null; return value; };
  s.currentBranch = null; s.currentBranchId = null; s.userScrolledUp = false;
  s.saveCurrentSession = async () => {};
  s.document.getElementById('userInput').value = '你好';
  return f;
}
test('F2 delayed first save duplicate send', 'send lock is not held across first await, including local replies', async () => {
  const { s } = chatFixture(); const gate = deferred(); let saves = 0;
  s.saveCurrentSession = async () => { if (++saves === 1) await gate.promise; };
  const first = s.sendMessage(); const second = s.sendMessage();
  const usersDuringWait = evaluate(s, "chatHistory.filter(m=>m.role==='user').length");
  gate.resolve(); await Promise.all([first, second]);
  requireSetup(saves >= 2, 'send must complete local reply path');
  assert.equal(usersDuringWait, 1, 'reentrant send must not append a second user while save is pending');
});
test('F2 local reply success control', null, async () => {
  const { s } = chatFixture(); await s.sendMessage();
  assert.deepEqual(clone(evaluate(s, 'chatHistory.map(m=>m.role)')), ['user', 'assistant']);
  assert.equal(evaluate(s, 'isStreaming'), false);
});

for (const mode of ['result', 'history']) {
  test('F3 stale ' + mode + ' applied after session switch', 'unbound A suggestion is applied to current B graph', async () => {
    const { s, storage } = harnessFixture();
    for (const sid of ['A', 'B']) { const state = s.getGraphState(sid); state.customNodes = [{ id: 'shared-id', kind: 'human_note', content: sid }]; s.saveGraphState(sid, state); }
    const aBefore = storage.get('phymathia_graph_A');
    evaluate(s, `harnessResult={summary:'A edit',operations:[{op:'update_node',id:'shared-id',patch:{content:'A-only edit'}}]}; harnessSnapshot=buildHarnessSnapshot(false,[],null); harnessHistory=[{id:'old-A',decision:'pending',operations:harnessResult.operations}];`);
    evaluate(s, "currentSessionId='B';");
    if (mode === 'result') s.applyGraphHarness(); else s.keepHarnessSuggestion('old-A');
    await settle();
    requireSetup(storage.get('phymathia_graph_A') === aBefore, 'source graph A unexpectedly modified');
    assert.equal(s.getGraphState('B').customNodes[0].content, 'B', 'B must reject suggestion produced in A');
  });
}

for (const branchType of ['main', 'socratic', 'learn']) {
  for (const anchorMode of ['empty', 'other']) {
    test('F4 regenerate ' + branchType + '/' + anchorMode, branchType === 'main' && anchorMode === 'empty' ? null : 'regenerate resends text with current anchor instead of original metadata', async () => {
      const { s } = chatFixture();
      const originalMeta = branchType === 'main' ? {} : { branchType, branchId: 'branch-A', parentId: 'parent-A', sourceModule: 'extend', fromPort: 'out-2', position: { x: 123, y: 456 } };
      s.anchor = anchorMode === 'other' ? { branchType: 'followup', branchId: 'wrong', parentId: 'wrong-parent' } : null;
      s.seed = [{role:'user',content:'你好',...originalMeta},{role:'assistant',content:'old reply'}, {role:'user',content:'later must truncate'}, {role:'assistant',content:'later reply'}];
      evaluate(s, 'chatHistory=seed;');
      const nodes = s.seed.map(m => ({ classList: { contains: x => x === m.role }, remove() {} }));
      nodes.forEach((n,i) => { n.previousElementSibling = nodes[i-1] || null; n.nextElementSibling = nodes[i+1] || null; });
      s.document.querySelectorAll = () => nodes;
      s.saveSessionMessages = async () => {};
      const gate = deferred(); let sent;
      s.saveCurrentSession = async () => { sent = clone(evaluate(s, 'chatHistory')); await gate.promise; };
      // sendQuick is fire-and-forget in production: track rather than replace its send behavior.
      const actualSend = s.sendMessage; let completion;
      s.sendMessage = () => (completion = actualSend());
      s.regenerateResponse({ closest: () => ({ closest: () => nodes[1] }) });
      requireSetup(completion && sent.length === 1 && sent[0].content === '你好', 'original user and later turns must be truncated before resend');
      gate.resolve(); await completion;
      const resent = clone(evaluate(s, 'chatHistory[0]'));
      const actualMeta = Object.fromEntries(Object.keys(originalMeta).map(k => [k, resent[k]]));
      if (branchType === 'main') assert.equal(resent.parentId, undefined, 'main regeneration must not consume unrelated anchor');
      else assert.deepEqual(actualMeta, originalMeta, 'original branch/parent/port/position must be retained');
    });
  }
}

for (const focused of [false, true]) {
  test('F5 conversational undo capture ' + (focused ? 'focused' : 'unfocused'), 'lossy review snapshot is stored as conversational undo before-state', async () => {
    const { s } = harnessFixture();
    const original = { id: 'long', kind: 'human_note', label: '长正文', content: 'x'.repeat(900) + 'END', formula: 'E=mc^2', x: 123, y: 456 };
    const state = s.getGraphState(); state.customNodes = [original]; s.saveGraphState('A', state);
    s.getSelectedGraphNodeIds = () => focused ? ['long'] : [];
    evaluate(s, 'harnessSnapshot=buildHarnessSnapshot(false,[],null);');
    await s._applyOps([{ op: 'delete_node', id: 'long' }], false);
    const checkpoint = s.getGraphState('A').harnessCheckpoint.before;
    requireSetup(checkpoint.customNodes[0].content === original.content, 'checkpoint undo must remain lossless');
    const undoInput = clone(evaluate(s, 'harnessLastAppliedBeforeSnapshot.nodes[0]'));
    assert.deepEqual({ content: undoInput.content, formula: undoInput.formula }, { content: original.content, formula: original.formula }, 'conversational undo must retain full original content and formula separately from review budget');
  });
}

let pass = 0, xfail = 0, fail = 0;
const runxfail = process.argv.includes('--runxfail');
for (const t of tests) {
  try {
    await t.run();
    if (t.reason) { fail++; console.error('XPASS', t.name, '| update the frozen expectation:', t.reason); }
    else { pass++; console.log('PASS', t.name); }
  } catch (err) {
    if (t.reason && err instanceof assert.AssertionError && !runxfail) {
      xfail++; console.log('XFAIL', t.name, '|', t.reason, '|', err.message);
    } else { fail++; console.error('FAIL', t.name, err.stack); }
  }
}
console.log(`Stage0: ${pass} PASS, ${xfail} XFAIL, ${fail} FAIL (${tests.length} total)`);
process.exitCode = fail ? 1 : 0;
