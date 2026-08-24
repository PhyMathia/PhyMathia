#!/usr/bin/env node
// 前端冒烟：Node 沙箱真实执行 app.js（宽松 DOM 代理），并对关键函数做行为断言。
// 目标：抓住"语法正确但运行时 ReferenceError/TypeError"这类 node --check 漏网问题。
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync('src/static/js/app.js', 'utf8');

// 宽松对象：任意属性访问返回同款代理；可调用；可赋值。不用 has/trap 避免死循环。
function loose(name) {
  const store = {};
  const fn = function () { return loose(name + '()'); };
  return new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'then' || p === 'catch' || p === 'finally') return undefined;
      if (p === 'length') return 0;
      if (!(p in t)) t[p] = loose(name + '.' + String(p));
      return t[p];
    },
    set(t, p, v) { t[p] = v; return true; },
    apply: () => loose(name + '()'),
    construct: () => loose('new ' + name),
  });
}

const storageData = { phymathia_level: 'university' };
const localStorage = {
  getItem: (k) => (k in storageData ? storageData[k] : null),
  setItem: (k, v) => { storageData[k] = String(v); },
  removeItem: (k) => { delete storageData[k]; },
};

const sandbox = {
  console,
  setTimeout: () => 0, clearTimeout: () => 0,
  setInterval: () => 0, clearInterval: () => 0,
  requestAnimationFrame: () => 0,
  localStorage,
  navigator: { userAgent: 'smoke', clipboard: { writeText: async () => {} } },
  location: { href: 'http://localhost:5050/', search: '', protocol: 'http:', pathname: '/', reload: () => {} },
  history: {},
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' }),
  alert: () => {}, confirm: () => true, prompt: () => '',
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  performance: { now: () => Date.now() },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  IntersectionObserver: class { observe() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  URLSearchParams, URL, TextEncoder, TextDecoder,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  Image: class { set src(v) {} addEventListener() {} },
  Audio: class {},
  FormData: class { append() {} },
  Blob: class {},
  File: class {},
  FileReader: class { readAsDataURL() {} readAsText() {} },
  WebSocket: class { close() {} send() {} addEventListener() {} },
  XMLHttpRequest: class { open() {} send() {} setRequestHeader() {} addEventListener() {} },
  AbortController: class { constructor(){ this.signal = {}; } abort() {} },
  requestIdleCallback: (f) => 0,
  cancelAnimationFrame: () => {},
  scrollTo: () => {}, scrollBy: () => {}, print: () => {},
  crypto: {
    getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; },
    randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }),
  },
};
sandbox.window = loose('window');
sandbox.document = loose('document');
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'app.js' });
} catch (e) {
  console.error('❌ app.js 顶层执行失败:', e.message);
  process.exit(1);
}

let failed = 0;
const check = (name, fn) => {
  try {
    if (fn() === false) throw new Error('断言未通过');
    console.log('✓', name);
  } catch (e) {
    failed++;
    console.error('❌', name, '->', e.message);
  }
};

check('buildHarnessSnapshot 可调用且回结构（回归：rawCount 未定义事故）', () => {
  // 注入两个画布节点，其中一个标记软删除
  sandbox.window.getGraphState = () => ({ harnessDeleted: { B: true } });
  sandbox.window.getCurrentSessionId = () => 'sess_test';
  sandbox.window.getGraphViewNodes = () => [
    { id: 'A', kind: 'knowledge', label: '导数', content: '瞬时变化率' },
    { id: 'B', kind: 'module', label: '物理视角', moduleKey: 'physics' },
  ];
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.window.getSelectedGraphNodeIds = () => [];
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  if (!snap || !Array.isArray(snap.nodes)) throw new Error('快照结构错误');
  if (snap.nodes.length !== 1) throw new Error('应过滤掉软删除的 B，剩 1 个节点，实际 ' + snap.nodes.length);
  if (typeof snap.snapshot_meta.deleted_filtered !== 'number') throw new Error('meta.deleted_filtered 缺失');
  if (snap.snapshot_meta.deleted_filtered !== 1) throw new Error('deleted_filtered 应为 1');
  return true;
});

check('_isHarnessPureQuestion 分类边界', () => {
  if (sandbox._isHarnessPureQuestion('评价一下我的理解') !== false) return false; // 改图意图
  // 注：「…怎么样」会被标为纯问答——无害，因 R4 后快照一律发真实画布内容，
  // 分类器只影响状态文案与焦点解析跳过，不再决定快照空实。
  return sandbox._isHarnessPureQuestion('什么是牛顿第二定律') === true;
});
check('纯问答也携带真实快照（回归：拒绝建议后全空事故）', () => {
  // 模拟用户有 35 节点画布：即便分类为纯问答，快照也应包含真实节点而非空数组
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getGraphViewNodes = () => Array.from({ length: 35 }, (_, i) => ({
    id: 'n' + i, kind: 'knowledge', label: '节点' + i, content: '内容' + i,
  }));
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.buildHarnessSnapshot(true, [], null); // excludeEval=true 也不应清空非 eval 节点
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  return snap.nodes.length === 35 && snap.edges.length === 0;
});

check('_detectHarnessPhase 分类', () => {
  const nodes = [{ id: 'D', kind: 'human_note', label: '我的理解' }];
  if (sandbox._detectHarnessPhase('评价一下我对导数的理解', nodes) !== 'evaluate') return false;
  if (sandbox._detectHarnessPhase('应用建议', nodes) !== 'apply') return false;
  return true;
});

check('_stripThinkText 思考块剥离（回归：推理模型刷屏事故）', () => {
  const strip = sandbox._stripThinkText;
  if (typeof strip !== 'function') throw new Error('_stripThinkText 未暴露');
  // 成对块：整段删除，保留正式回答
  if (strip('<think>先想想 {"op": "bad"</think>\n{"summary": "s"}') !== '{"summary": "s"}') return false;
  // 未闭合块（max_tokens 截断）：从开标签截断
  if (strip('{"summary": "ok"} <think>被截断……') !== '{"summary": "ok"}') return false;
  // 纯文本不受影响
  if (strip('正常回答') !== '正常回答') return false;
  // 空值
  if (strip('') !== '') return false;
  return true;
});

console.log(failed ? '\n冒烟失败' : '\n前端冒烟全部通过');
process.exit(failed ? 1 : 0);
