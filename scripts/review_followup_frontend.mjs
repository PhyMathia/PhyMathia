#!/usr/bin/env node
// 后续修复回归（前端）：重试失败回答时不得消费用户另选的锚点。
// 真实源码 + 隔离 VM/存储，无网络。
//   node scripts/review_followup_frontend.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const clone = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const load = (s, name) => vm.runInContext(fs.readFileSync(new URL('src/static/js/' + name, root), 'utf8'), s, { filename: name });
const evaluate = (s, code) => vm.runInContext(code, s);
const tests = [];
const test = (name, run) => tests.push({ name, run });

function element() {
  return { value: '', textContent: '', innerHTML: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    addEventListener() {}, setAttribute() {}, removeAttribute() {}, remove() {}, focus() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, appendChild() {} };
}

// chat-features.js 提供真实 setActiveBranchAnchor，chat-branch.js 提供真实
// _consumePendingBranch：锚点语义不走替身。
function chatFixture() {
  const storage = new Map(), elements = new Map();
  const s = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    AbortController, TextDecoder, TextEncoder, URLSearchParams,
    location: { search: '', href: 'http://localhost:5050/', origin: 'http://localhost:5050' },
    crypto: { randomUUID: () => 'fu-1' },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      body: element(), querySelector: () => null, querySelectorAll: () => [], createElement: element, addEventListener() {},
    },
    fetch: async url => { throw new Error('Unexpected mock request: ' + url); },
    alert: () => {},
  };
  s.window = s;
  vm.createContext(s);
  // 与 build_frontend.mjs 相同的先后顺序：chat-branch.js 在加载期就读取 chat.js 的 sendQuick
  for (const name of ['config.js', 'session.js', 'chat.js', 'chat-features.js', 'chat-branch.js']) load(s, name);
  evaluate(s, "currentSessionId='A'; SESSION_ID='remoteA'; sessions={A:{sessionId:'remoteA'}};");
  s.addMessage = () => null;
  s.renderSessionList = () => {};
  s.scrollToBottom = () => {};
  s.saveCurrentSession = async () => {};
  s.currentBranch = null; s.currentBranchId = null; s.userScrolledUp = false;
  s.anchor = null;
  return { s, storage };
}

function sentMessages(s) {
  const captured = [];
  s.saveCurrentSession = async () => { captured.push(clone(evaluate(s, 'chatHistory'))); };
  return captured;
}

// ---- 重试时用户另外选过锚点：重试消息不得挂到那个分支 ----
test('retry does not attach an unrelated pending anchor', async () => {
  const { s } = chatFixture();
  const sent = sentMessages(s);
  evaluate(s, "lastFailedMessage='重试这个问题'; lastFailedBranchMeta={};");
  evaluate(s, "setActiveBranchAnchor({branchType:'socratic', branchId:'other-branch', branchLabel:'别的分支'});");
  s.retryLast();
  await Promise.resolve();
  assert.equal(sent.length, 1, 'retry must send exactly one message');
  const userMessage = sent[0].find(m => m.role === 'user');
  assert.ok(userMessage, 'retried user message must be appended');
  assert.equal(userMessage.branchId, undefined, 'retry must not borrow the pending anchor branch');
  assert.equal(userMessage.branchType, undefined, 'retry must not borrow the pending anchor type');
  const anchor = evaluate(s, 'activeBranchAnchor ? activeBranchAnchor.branchId : null');
  assert.equal(anchor, 'other-branch', 'the user anchor must stay pending for their next message');
});

// ---- 失败的分支回答：重试仍带原来的分支元数据 ----
test('retry keeps the failed branch metadata', async () => {
  const { s } = chatFixture();
  const sent = sentMessages(s);
  evaluate(s, "lastFailedMessage='重试分支问题'; lastFailedBranchMeta={branchType:'socratic', branchId:'b-9', parentId:'p-1', fromPort:'out-2'};");
  s.retryLast();
  await Promise.resolve();
  const userMessage = sent[0].find(m => m.role === 'user');
  assert.equal(userMessage.branchId, 'b-9');
  assert.equal(userMessage.branchType, 'socratic');
  assert.equal(userMessage.parentId, 'p-1');
  assert.equal(userMessage.fromPort, 'out-2');
});

// ---- 对照：普通发送仍消费用户选定的锚点 ----
test('ordinary send still consumes the pending anchor', async () => {
  const { s } = chatFixture();
  const sent = sentMessages(s);
  evaluate(s, "setActiveBranchAnchor({branchType:'socratic', branchId:'chosen', branchLabel:'选中的分支'});");
  s.document.getElementById('userInput').value = '围绕这个分支提问';
  await s.sendMessage();
  const userMessage = sent[0].find(m => m.role === 'user');
  assert.equal(userMessage.branchId, 'chosen', 'ordinary send must use the anchor the user picked');
  assert.equal(evaluate(s, 'activeBranchAnchor'), null, 'consumed anchor must be cleared');
});

// ---- 对照：没有失败信息时重试不发送 ----
test('retry without a failed message does nothing', async () => {
  const { s } = chatFixture();
  const sent = sentMessages(s);
  evaluate(s, "lastFailedMessage='';");
  s.retryLast();
  await Promise.resolve();
  assert.equal(sent.length, 0, 'empty retry must not send');
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.run(); pass++; console.log('PASS', t.name); }
  catch (err) { fail++; console.error('FAIL', t.name, err.stack); }
}
console.log(`Followup: ${pass} PASS, ${fail} FAIL (${tests.length} total)`);
process.exitCode = fail ? 1 : 0;
