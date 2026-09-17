#!/usr/bin/env node
// 角标快照回归：回答角标必须以后端下发的本次注入快照为准（与进 prompt 的内容同源），
// 只有拿不到快照时才退回按缓存计算；服务端说「本次没注入」时不得凭缓存显示角标。
// 真实源码 + 隔离 VM/迷你 DOM，无网络。
//   node scripts/review_badge_frontend.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const load = (s, name) => vm.runInContext(fs.readFileSync(new URL('src/static/js/' + name, root), 'utf8'), s, { filename: name });
const evaluate = (s, code) => vm.runInContext(code, s);
// VM 内创建的对象原型与主 realm 不同：比对前先过一遍 JSON
const plain = x => JSON.parse(JSON.stringify(x));
const tests = [];
const test = (name, run) => tests.push({ name, run });

function node(tag) {
  const el = {
    tagName: tag, className: '', type: '', textContent: '', title: '', hidden: false, innerHTML: '',
    children: [], isConnected: true, style: {}, dataset: {},
    addEventListener() {},
    appendChild(child) { el.children.push(child); return child; },
    insertBefore(child) { el.children.unshift(child); return child; },
    get firstChild() { return el.children[0] || null; },
    querySelector() { return null; },
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
  };
  return el;
}

function fixture() {
  const s = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, addEventListener() {},
    document: { getElementById: () => null, createElement: node, body: node('body'), querySelector: () => null,
                querySelectorAll: () => [], addEventListener() {} },
    escapeHtml: v => String(v == null ? '' : v),
    getDeviceId: () => 'badge-device',
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  };
  s.window = s;
  vm.createContext(s);
  load(s, 'config.js');
  load(s, 'memory.js');
  return s;
}

function setCache(s, profile) {
  evaluate(s, `_cachedProfile = ${JSON.stringify(profile)};`);
}

const CACHE_WITH_STALE_FACTS = {
  enabled: true,
  explicit: { stage: '高二', goal: '', interests: '', weakAreas: '', style: {} },
  facts: [
    { id: 'pf_1', fact: '缓存里的薄弱点：电磁感应', category: 'weakness', status: 'active' },
    { id: 'pf_2', fact: '缓存里的兴趣：天体物理', category: 'interest', status: 'active' },
  ],
  pending: [],
};

// ---- 1. 有快照：以快照为准，缓存里多出来的事实不得出现在角标里 ----
test('server snapshot wins over the local cache', () => {
  const s = fixture();
  setCache(s, CACHE_WITH_STALE_FACTS);
  const usage = { sections: [{ label: '学段', text: '大一' }], factCount: 1 };
  const sections = plain(evaluate(s, `memoryBadgeSections(${JSON.stringify(usage)})`));
  assert.deepEqual(sections, [{ label: '学段', text: '大一' }]);
  const joined = JSON.stringify(sections);
  assert.ok(!joined.includes('电磁感应') && !joined.includes('天体物理'),
    'stale cache facts must not leak into the badge');
});

// ---- 2. 服务端明确说本次没注入：即使缓存里有内容也不显示角标 ----
test('empty snapshot suppresses the badge even with a full cache', () => {
  const s = fixture();
  setCache(s, CACHE_WITH_STALE_FACTS);
  const usage = { sections: [], factCount: 0 };
  assert.deepEqual(plain(evaluate(s, `memoryBadgeSections(${JSON.stringify(usage)})`)), []);
  const meta = node('span');
  let inserted = null;
  meta.insertBefore = child => { meta.children.unshift(child); inserted = child; return child; };
  s.memoryAppendProfileBadge(meta, usage);
  assert.equal(inserted, null, 'no badge element may be inserted');
});

// ---- 3. 没有快照（本地寒暄回答/旧服务端）：退回按缓存计算 ----
test('missing snapshot falls back to the cached sections', () => {
  const s = fixture();
  setCache(s, CACHE_WITH_STALE_FACTS);
  const sections = plain(evaluate(s, 'memoryBadgeSections(null)'));
  const labels = sections.map(x => x.label).join(',');
  assert.ok(labels.includes('学段') && labels.includes('薄弱') && labels.includes('兴趣'),
    'fallback must still render cache sections, got ' + labels);
});

// ---- 4. DOM：角标按快照渲染标签与正文 ----
test('badge DOM renders the snapshot labels and text', () => {
  const s = fixture();
  setCache(s, CACHE_WITH_STALE_FACTS);
  const usage = { sections: [{ label: '目标', text: '高考物理90分' }, { label: '偏好', text: '详略=精简' }], factCount: 3 };
  const meta = node('span');
  let inserted = null;
  meta.insertBefore = child => { meta.children.unshift(child); inserted = child; return child; };
  s.memoryAppendProfileBadge(meta, usage);
  assert.ok(inserted, 'badge element must be inserted');
  const [btn, detail] = inserted.children;
  assert.equal(btn.textContent, '🧠 已结合你的画像（目标·偏好）');
  assert.ok(detail.innerHTML.includes('【目标】') && detail.innerHTML.includes('高考物理90分'), detail.innerHTML);
  assert.ok(detail.innerHTML.includes('【偏好】') && detail.innerHTML.includes('详略=精简'), detail.innerHTML);
  assert.ok(!detail.innerHTML.includes('电磁感应'), 'cache-only facts must not appear');
});

// ---- 5. 对照：停用画像 + 快照为空 → 无角标 ----
test('disabled profile without snapshot stays badge-free', () => {
  const s = fixture();
  setCache(s, { enabled: false, explicit: {}, facts: [], pending: [] });
  assert.deepEqual(plain(evaluate(s, 'memoryBadgeSections(null)')), []);
});

let pass = 0, fail = 0;
for (const t of tests) {
  try { await t.run(); pass++; console.log('PASS', t.name); }
  catch (err) { fail++; console.error('FAIL', t.name, err.stack); }
}
console.log(`Badge: ${pass} PASS, ${fail} FAIL (${tests.length} total)`);
process.exitCode = fail ? 1 : 0;
