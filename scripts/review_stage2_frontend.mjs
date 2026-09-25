#!/usr/bin/env node
// Stage 2 frontend acceptance: real source functions, isolated VM/storage/storage-failure
// fixtures, simulated backend, no network. Run from any cwd:
//   node /absolute/path/scripts/review_stage2_frontend.mjs
// Every test has an independent VM; failures set exit code 1.
// Boundaries (not browser/E2E): no real service, no bundle, backend acceptedIndices
// integration is verified by backend agent; here only the frontend contract is exercised.
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

// ---- 沙箱：memory.js + quiz-stats.js 真源码 + 内存存储 + 可编程后端 ----
async function sandbox({ topics = 0, respond } = {}) {
  const storage = new Map();
  const profile = { enabled: true, explicit: {}, facts: [], pending: [], archive: [] };
  const s = { console, getDeviceId: () => 'stage2-only', setTimeout: () => 0,
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    document: { getElementById: () => null },
    escapeHtml: String,
    fetch: async () => ({ ok: true, json: async () => clone(profile) }),
  };
  s.window = s;
  vm.createContext(s);
  load(s, 'memory.js');
  s.QUIZ_STATS_KEY = 'phymathia_quiz_stats';
  load(s, 'quiz-stats.js');
  if (topics) {
    storage.set(s.QUIZ_STATS_KEY, JSON.stringify(Object.fromEntries(
      Array.from({ length: topics }, (_, i) => ['topic' + i, { title: '主题' + i, wrong: 2, mastery: 0 }])
    )));
  }
  const calls = [];
  s.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (url === '/api/profile/candidates') return respond(calls[calls.length - 1]);
    if (url.startsWith('/api/kv/')) return { ok: true, json: async () => ({ value: null }) };
    return { ok: true, json: async () => clone(profile) };
  };
  s.fetchCalls = () => calls;
  await s.memoryRefreshCache();
  return { s, storage, profile, calls };
}

// ---- M6：接受/部分接受/拒绝/存储失败/关闭 的防重窗口口径 ----
test('M6 full acceptance marks all six of an eight-topic batch', async () => {
  const { s, storage, calls } = await sandbox({ topics: 8, respond: ({ body }) => ({
    ok: true, json: async () => ({ accepted: true, acceptedIndices: body.candidates.map((_, i) => i), changed: body.candidates.length, promoted: [] }) }) });
  await s._syncProfileSignals(); await settle();
  const synced = JSON.parse(storage.get('phymathia_memory_signal_sync'));
  assert.equal(Object.keys(synced).length, 6, 'only the six actually sent and accepted topics consume the window');
  assert.ok(!('weak:主题6' in synced) && !('weak:主题7' in synced), 'unsent seventh/eighth must stay eligible');
  assert.equal(s._collectProfileSignalCandidates().candidates.length, 2, 'remaining two must still be collected next round');
  await s._syncProfileSignals();
  const batches = calls.filter(c => c.url === '/api/profile/candidates').map(c => c.body.candidates);
  assert.deepEqual(batches.map(b => b.length), [6, 2]);
  assert.deepEqual(batches[1].map(c => c.fact), ['检测多次答错：主题6', '检测多次答错：主题7']);
  assert.equal(Object.keys(JSON.parse(storage.get('phymathia_memory_signal_sync'))).length, 8);
});

test('M6 partial acceptance marks only acceptedIndices', async () => {
  const { s, storage } = await sandbox({ topics: 4, respond: () => ({
    ok: true, json: async () => ({ accepted: true, acceptedIndices: [0, 2], changed: 2, promoted: [] }) }) });
  await s._syncProfileSignals(); await settle();
  const synced = JSON.parse(storage.get('phymathia_memory_signal_sync'));
  assert.deepEqual(Object.keys(synced).sort(), ['weak:主题0', 'weak:主题2'], 'rejected positions must stay unmarked');
  const remaining = s._collectProfileSignalCandidates().candidates;
  assert.ok(remaining.some(c => c.fact.includes('主题1')) && remaining.some(c => c.fact.includes('主题3')), 'unaccepted two remain eligible');
});

test('M6 rejection consumes nothing despite HTTP 200', async () => {
  const { s, storage } = await sandbox({ topics: 2, respond: () => ({
    ok: true, json: async () => ({ accepted: false, acceptedIndices: [], changed: 0, promoted: [], ignored: 'disabled' }) }) });
  await s._syncProfileSignals(); await settle();
  assert.equal(storage.has('phymathia_memory_signal_sync'), false, 'disabled/rejected must not consume the window');
});

test('M6 storage failure keeps window and ok=false', async () => {
  const { s } = await sandbox({ topics: 2, respond: () => ({ ok: false, status: 503, json: async () => ({}) }) });
  const res = await s.memoryPostCandidates([s._collectProfileSignalCandidates().candidates[0]], 'signal');
  assert.equal(res.ok, false);
  assert.equal(res.accepted, false);
});

test('M6 malformed response fails closed without consuming window', async () => {
  const { s, storage } = await sandbox({ topics: 2, respond: () => ({
    ok: true, json: async () => ({ changed: 1, promoted: [] }) }) }); // 旧响应：无 accepted/acceptedIndices
  const res = await s.memoryPostCandidates([{ fact: 'x', category: 'weakness' }], 'signal');
  assert.equal(res.ok, true);
  assert.equal(res.accepted, false);
  await s._syncProfileSignals(); await settle();
  assert.equal(storage.get('phymathia_memory_signal_sync') || '', '', 'legacy/garbage response must not consume the window');
});

test('M6 disabled locally skips POST entirely', async () => {
  const { s, profile } = await sandbox({ topics: 2, respond: () => ({ ok: true, json: async () => ({ accepted: true, acceptedIndices: [0, 1], changed: 2, promoted: [] }) }) });
  profile.enabled = false;
  await s.memoryRefreshCache();
  await s._syncProfileSignals(); await settle();
  assert.equal(s.fetchCalls().some(c => c.url === '/api/profile/candidates'), false, 'disabled profile must not POST');
});

test('M6 local ledger write failure does not claim durable marks', async () => {
  const { s, storage } = await sandbox({ topics: 2, respond: () => ({ ok: true, json: async () => ({ accepted: true, acceptedIndices: [0, 1], changed: 2, promoted: [] }) }) });
  const setItem = s.localStorage.setItem;
  s.localStorage.setItem = (k, v) => { if (k === 'phymathia_memory_signal_sync') throw new Error('quota'); setItem(k, v); };
  await s._syncProfileSignals();
  assert.equal(storage.has('phymathia_memory_signal_sync'), false);
  assert.equal(s._collectProfileSignalCandidates().candidates.length, 2, 'without durable ledger the next run can retry');
});

for (const response of [
  { accepted: true, acceptedIndices: [2] },
  { accepted: true, acceptedIndices: [0, 0] },
  { accepted: true, acceptedIndices: ['0'] },
  { accepted: false, acceptedIndices: [0] },
  { accepted: true, acceptedIndices: [] },
]) test('M6 invalid acceptance contract ' + JSON.stringify(response), async () => {
  const { s, storage } = await sandbox({ topics: 2, respond: () => ({ ok: true, json: async () => response }) });
  const result = await s.memoryPostCandidates([{ fact: 'one' }, { fact: 'two' }]);
  assert.equal(result.status, 'invalid-response');
  assert.equal(result.accepted, false);
  await s._syncProfileSignals();
  assert.equal(storage.has('phymathia_memory_signal_sync'), false);
});

// ---- M5：休眠过滤 + 角标分节与默认选择规则对齐 ----
async function profileSandbox(profile) {
  const s = (await sandbox({})).s;
  s.seedProfile = profile;
  evaluate(s, '_cachedProfile=seedProfile');
  return s;
}

test('M5 idle facts excluded from both module context and badge sections', async () => {
  const s = await profileSandbox({ enabled: true, explicit: {},
    facts: [
      { id: 'a', fact: '薄弱：电磁感应', category: 'weakness', status: 'active' },
      { id: 'b', fact: '薄弱：睡着的知识点', category: 'weakness', status: 'idle' },
    ] });
  const ctx = s.memoryCachedContext();
  assert.ok(ctx.includes('电磁感应') && !ctx.includes('睡着的'), 'module context must exclude idle');
  assert.ok(!JSON.stringify(s.memoryBadgeSections()).includes('睡着的知识点'), 'badge must exclude idle');
});

test('M5 badge caps matching default selection rules (12 facts, 5 per section)', async () => {
  const s = await profileSandbox({ enabled: true, explicit: {}, facts: Array.from({ length: 14 }, (_, i) => (
    { id: 'w' + i, fact: '薄弱点编号' + i, category: 'weakness', status: 'active', occurrences: 14 - i, updatedAt: i })) });
  const weak = s.memoryBadgeSections().find(sec => sec.label === '薄弱');
  assert.equal(weak.text.split('；').length, 5, 'per-section cap of five must hold');
  assert.ok(weak.text.includes('薄弱点编号0') && !weak.text.includes('薄弱点编号5'), 'highest occurrences first');
});

test('M5 badge normalizes duplicate facts like backend sections', async () => {
  const s = await profileSandbox({ enabled: true, explicit: { goal: '我是高考物理90分' },
    facts: [{ id: 'g', fact: '用户是高考物理90分。', category: 'goal', status: 'active' }] });
  const goal = s.memoryBadgeSections().find(sec => sec.label === '目标');
  assert.equal(goal.text.split('；').length, 1, 'explicit and automatic duplicates collapse to one entry');
});

test('M5 disabled profile yields empty sections and context', async () => {
  const s = await profileSandbox({ enabled: false, explicit: {}, facts: [{ id: 'a', fact: 'x', category: 'goal', status: 'active' }] });
  assert.equal(s.memoryBadgeSections().length, 0);
  assert.equal(s.memoryCachedContext(), '');
});

// ---- F4：锚定发送消费待用锚点并盖章分支元数据 ----
// （2026-09-25 线性主聊天退役：regenerateResponse/regenerateLast 及其 resendMeta
// 契约随管线删除，见 docs/dev/linear-chat-retired.md；锚点消费契约保留如下）
function chatSandbox() {
  const elements = new Map(), storage = new Map();
  const element = () => ({ value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {} });
  const s = { console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    AbortController, TextDecoder, TextEncoder, crypto: { randomUUID: () => 'stage2-uuid' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    document: { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      body: element(), querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {} },
    fetch: async url => { throw new Error('Unexpected fetch: ' + url); },
    alert: msg => { throw new Error('Unexpected alert: ' + msg); },
  };
  s.window = s;
  vm.createContext(s);
  for (const name of ['config.js', 'session.js', 'chat.js', 'chat-features.js']) load(s, name);
  evaluate(s, "currentSessionId='A'; SESSION_ID='remoteA'; sessions={A:{sessionId:'remoteA'}};");
  s.anchor = null;
  s._consumePendingBranch = () => { const v = s.anchor; s.anchor = null; return v; };
  s.renderSessionList = () => {};
  s.saveCurrentSession = async () => {};
  s.currentBranch = null; s.currentBranchId = null;
  return { s, storage };
}

test('F4 anchored send consumes pending anchor and stamps branch metadata', async () => {
  const { s } = chatSandbox();
  s.anchor = { branchType: 'learn', branchId: 'b2', parentId: 'p2' };
  evaluate(s, "sendQuick('围绕进阶学习方向继续展开')");
  await s.sendMessage();
  assert.equal(s.anchor, null, 'anchored send must consume the pending anchor');
  const users = evaluate(s, 'chatHistory.filter(m=>m.role==="user")');
  assert.equal(users.length, 1, 'anchored send appends exactly one user message');
  assert.equal(users[0].branchId, 'b2', 'pending anchor applies to the send');
});

test('F4 anchorless send is rejected and leaves history untouched (linear retired)', async () => {
  const { s } = chatSandbox();
  evaluate(s, "sendQuick('没有锚点的裸提问')");
  await s.sendMessage();
  assert.equal(evaluate(s, 'chatHistory.length'), 0, 'anchorless send must not append anything');
  assert.equal(evaluate(s, 'isStreaming'), false, 'lock must be released');
});

// ---- F 有界只读审计：取消/会话/画布/导出/Φ 证据点（只读检查，不扩大范围）----
test('F audit stopGeneration aborts controller without touching lock state', async () => {
  const { s } = chatSandbox();
  let aborted = 0;
  evaluate(s, 'abortController=new AbortController(); isStreaming=true;');
  const signal = evaluate(s, 'abortController.signal');
  s.window.stopWorkflowRun = () => { s.stopped = true; };
  s.stopGeneration();
  assert.ok(signal.aborted, 'abort must reach the in-flight controller');
  assert.equal(s.stopped, true, 'workflow stop hook must fire');
  assert.equal(evaluate(s, 'isStreaming'), true, 'lock release belongs to sendMessage finally, not stop');
});

// Safety regression: A's background visualization after switching to B must not
// overwrite the timestamp-colliding B assistant message nor write B storage.
// This is a real production contract now, asserted via actual chat.js callback source.
const chatSource = fs.readFileSync(new URL('src/static/js/chat.js', root), 'utf8');
const callbackStart = chatSource.indexOf('scheduleVisualizationInBackground(assistantContent, (updatedContent) => {');
const callbackEnd = chatSource.indexOf('\n            });', callbackStart);
assert.ok(callbackStart > 0 && callbackEnd > callbackStart, 'callback boundary must exist');
const prefix = chatSource.slice(0, callbackStart);
assert.ok(/const sourceSessionId = currentSessionId;/.test(prefix), 'sendMessage must capture the source session');
assert.ok(/const originatingAssistant = chatHistory\[chatHistory\.length - 1\];/.test(prefix), 'callback must capture originating assistant identity');
function runCallback(history, sessionId, original = { role: 'assistant', timestamp: 123, content: 'A original' }) {
  const callbackBody = chatSource.slice(callbackStart + 'scheduleVisualizationInBackground(assistantContent, (updatedContent) => {'.length, callbackEnd);
  const audit = vm.createContext({ console, ts: 123, original, currentSessionId: sessionId, chatHistory: history, assistantDiv: null, isStreaming: false,
    saveSessionMessages: (...args) => { audit.saved = args; },
    localStorage: { setItem(k, v) { audit.written = { k, v: JSON.parse(v) }; } } });
  vm.runInContext('const sourceSessionId="A"; const originatingAssistant=original;(updatedContent => {' + callbackBody + '})("A late visualization")', audit);
  return audit;
}
test('F background visualization for A must not touch colliding B message after switch', async () => {
  const bHistory = [{ role: 'assistant', timestamp: 123, content: 'B original' }];
  const audit = runCallback(bHistory, 'B', { role: 'assistant', timestamp: 123, content: 'A original' });
  assert.equal(bHistory[0].content, 'B original', 'timestamp-colliding B content must stay untouched');
  assert.equal(audit.written, undefined, 'B storage must not be written');
  assert.equal(audit.saved, undefined, 'no server save for B');
});
test('F callback discards when originating assistant is gone but still applies same-session', async () => {
  const history = [{ role: 'user', content: 'next question' }];
  const audit = runCallback(history, 'A');
  assert.equal(history.some(m => m.content === 'A late visualization'), false, 'regenerated-away original must not mutate history');
  assert.equal(audit.saved, undefined, 'no server save when original is gone');
  assert.equal(audit.written, undefined, 'no local write when original is gone');
  const original = { role: 'assistant', timestamp: 123, content: 'A original' };
  const normal = runCallback([original], 'A', original);
  assert.equal(original.content, 'A late visualization', 'normal completion must still update the original');
  assert.equal(normal.written.k, 'phymathia_msgs_A');
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.run(); pass++; console.log('PASS', t.name); }
  catch (err) { fail++; console.error('FAIL', t.name, err.stack); }
}
console.log(`Stage2: ${pass} PASS, ${fail} FAIL (${tests.length} total)`);
process.exitCode = fail ? 1 : 0;
