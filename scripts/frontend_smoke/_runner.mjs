#!/usr/bin/env node
// 前端冒烟：Node 沙箱真实执行 app.js（宽松 DOM 代理），并对关键函数做行为断言。
// 目标：抓住"语法正确但运行时 ReferenceError/TypeError"这类 node --check 漏网问题。
import fs from 'node:fs';
import vm from 'node:vm';

export const code = fs.readFileSync('src/static/js/app.js', 'utf8');

// 知识大陆源码 2026-10-04（T36）自单文件拆六：静态契约检查一律读拼接全集，
// 防止「符号搬去了兄弟文件、单文件 contains 断言假红/假绿」。
const CONTINENT_SRC_FILES = [
  'graph-continent.js',
  'graph-continent-layout.js',
  'graph-continent-edges.js',
  'graph-continent-explore.js',
  'graph-continent-regions.js',
  'graph-continent-view.js',
];
const readContinentSrc = () => CONTINENT_SRC_FILES.map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');

// 宽松对象：任意属性访问返回同款代理；可调用；可赋值。不用 has/trap 避免死循环。
export function loose(name) {
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

export const storageData = { phymathia_level: 'university' };
let __smokeUuid = 0;
export const localStorage = {
  getItem: (k) => (k in storageData ? storageData[k] : null),
  setItem: (k, v) => { storageData[k] = String(v); },
  removeItem: (k) => { delete storageData[k]; },
};

export const sandbox = {
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
    randomUUID: () => 'uu-' + (++__smokeUuid).toString(16).padStart(10, '0'),
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
const pendingChecks = [];
export const check = (name, fn) => {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // 异步断言（如批量任务中止行为）：等待完成后才统计与退出。
      // 兑现值 false 同步口径一致视为失败——否则断言函数里 return false 的
      // 行为检查会被静默当作通过（审查修复：此前 6 条写回/不触碰断言因此失效）
      pendingChecks.push(result.then(
        (r) => {
          if (r === false) { failed++; console.error('❌', name, '-> 断言未通过'); }
          else console.log('✓', name);
        },
        (e) => { failed++; console.error('❌', name, '->', (e && e.message) || e); },
      ));
      return;
    }
    if (result === false) throw new Error('断言未通过');
    console.log('✓', name);
  } catch (e) {
    failed++;
    console.error('❌', name, '->', e.message);
  }
};

// ===== M2 检测夹具（T66 自 quiz 段抽出：quiz.mjs 与 serial-quiz-retest.mjs 共用）=====
export const M2_TOPIC_KEY = 'topic-HM';
export const M2_SESSION = 'sess_test';

export function m2SeedQuizStats(extra) {
  const now = Date.now();
  const stats = {
    _meta: { version: 2, updatedAt: now, wrongQuestions: [] },
    know_hm: {
      title: '简谐运动', correct: 0, wrong: 2, topicKey: M2_TOPIC_KEY,
      sessionId: M2_SESSION, dueAt: now - 3600000, history: [{ correct: false }],
    },
    know_hk: {
      title: '胡克定律', correct: 0, wrong: 3, topicKey: 'topic-HK',
      sessionId: M2_SESSION, dueAt: now - 3600000, history: [{ correct: false }],
    },
  };
  if (extra) Object.assign(stats, extra);
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  return stats;
}

export function m2WrongQuestion() {
  return {
    id: 'w_hm', title: '简谐运动', prompt: '简谐运动的周期由什么决定？',
    options: [{ key: 'A', text: 'm 与 k' }, { key: 'B', text: '振幅' }],
    correctIndex: 0, refId: 'kp_hm', sourceRef: 'kp_hm', sourceType: 'knowledge',
    topicKey: M2_TOPIC_KEY, sessionId: M2_SESSION, wrongAt: Date.now(),
  };
}

// 收口线：等全部在途（异步）check 落地。原单文件的 6 处
// await Promise.all(pendingChecks) 一律替换为本函数，语义不变。
export async function drain() {
  await Promise.all(pendingChecks).catch(() => {});
}

// 失败计数器入口：部分分域文件有自己的 qcheck 助手，失败分支原样 failed++——
// 拆分后 failed 是 runner 私有，分文件一律改调本函数（拆分器已机械替换）。
export function addFailed() {
  failed++;
}

// node 内置与大陆六件拼接读取器转发给各分域文件
export { fs, vm, readContinentSrc };

export function finish() {
  console.log(failed ? '\n冒烟失败' : '\n前端冒烟全部通过');
  process.exit(failed ? 1 : 0);
}
