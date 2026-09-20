// 新手引导 v2 + 演示会话 冒烟测试（迭代 2：click 型步骤/布局整理/提问对位）
import vm from 'node:vm';
import fs from 'node:fs';

const R = 'D:/PhyMathia/src/static';
const uiTxt = fs.readFileSync(R + '/js/ui.js', 'utf8');
const cfgTxt = fs.readFileSync(R + '/js/config.js', 'utf8');
const demoJs = fs.readFileSync(R + '/js/demo.js', 'utf8');

const startM = uiTxt.indexOf('// ====== 首次使用引导 (v2) ======');
const endM = uiTxt.indexOf('// Handle resize during onboarding');
const obSection = uiTxt.slice(startM, endM);

function makeBaseCtx(extra) {
  const ctx = {
    console,
    document: { body: { classList: { add() {}, remove() {} } } },
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (f) => f(),
    setTimeout: (f) => { f(); return 1; },
    clearTimeout: () => {},
    mermaid: { initialize: () => {} },
    UI_ICON_SVG: null,
    ...(extra || {}),
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  return ctx;
}

// ====== A. 演示数据 + ensureDemoSession（含布局整理调用） ======
{
  const calls = { create: null, arrange: 0, fit: 0, switchTo: [] };
  const sessions = {};
  const ctx = makeBaseCtx({
    fetch: async () => ({ ok: true }),
    autoArrangeGraph: () => { calls.arrange++; },
    fitGraph: () => { calls.fit++; },
    saveKnowledgeItems: async () => {},
    setFormulaCache: () => {},
  });
  const w = {
    getCurrentSessionId: () => 'sess_current',
    getSessionMessages: (id) => (id === 'sess_current' ? [] : (id === 'sess_demo_moon' ? [{ role: 'user' }] : [])),
    getSessionById: (id) => sessions[id] || null,
    createSessionWithMessages: async (meta, msgs, id) => { calls.create = { meta, msgs, id }; sessions[id] = { id, title: meta.title, sessionId: 'phymathia_demo_test' }; return id; },
    switchToSession: async (id) => { calls.switchTo.push(id); },
    renderSessionList: () => {},
  };
  ctx.window = w;
  vm.runInNewContext(demoJs, ctx);

  const r1 = await vm.runInNewContext('ensureDemoSession()', ctx);
  if (r1 !== true || !calls.create || calls.create.id !== 'sess_demo_moon') throw new Error('create demo failed');
  if (calls.arrange < 1 || calls.fit < 1) throw new Error('layout settle not called: ' + calls.arrange + '/' + calls.fit);
  console.log('SCENARIO A1 (create + settle): OK, arrange=' + calls.arrange + ' fit=' + calls.fit);

  const r2 = await vm.runInNewContext('ensureDemoSession()', ctx);
  if (r2 !== true) throw new Error('reuse failed');
  if (!calls.switchTo.includes('sess_demo_moon')) throw new Error('reuse should switch');
  if (calls.arrange < 2) throw new Error('reuse should settle too');
  console.log('SCENARIO A2 (reuse + settle): OK');

  // 当前画布有内容 → 跳过且不整理
  const ctx2 = makeBaseCtx({ autoArrangeGraph: () => {}, fitGraph: () => {} });
  ctx2.window = { getCurrentSessionId: () => 'sess_x', getSessionMessages: () => [{ role: 'user' }] };
  vm.runInNewContext(demoJs, ctx2);
  const r3 = await vm.runInNewContext('ensureDemoSession()', ctx2);
  if (r3 !== false) throw new Error('should skip when has content');
  console.log('SCENARIO A3 (skip when content): OK');
}

// ====== B. 引导步骤：click 型 / 提问目标 / afterLeave ======
function makeEl() {
  return {
    classList: { add() {}, remove() {}, toggle() { return true; }, contains() { return false; } },
    style: {},
    className: '', innerHTML: '',
    offsetWidth: 360, offsetHeight: 240,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 50, bottom: 50 }),
    querySelector: () => null,
    nextElementSibling: null,
  };
}
function makeUiCtx(domState, store) {
  return makeBaseCtx({
    document: { querySelector: (sel) => (domState[sel] ? {} : null), getElementById: () => makeEl(), body: makeEl() },
    window: { innerWidth: 1440, innerHeight: 900 },
    localStorage: { getItem: (k) => (store[k] ?? null), setItem: (k, v) => { store[k] = v; }, removeItem: (k) => { delete store[k]; } },
  });
}

// 有内容画布（演示会话场景）
{
  const ctx = makeUiCtx({
    '.graph-node-answer': 1, '.graph-node-user': 1, '.graph-harness-btn': 1,
    '.graph-canvas-toolbar': 1, '.phi-pet-root': 1,
  }, {});
  vm.runInNewContext(cfgTxt, ctx);
  vm.runInNewContext(obSection, ctx);
  const steps = vm.runInNewContext('_buildFullObSteps()', ctx);
  const step1Target = steps[1].target();
  const step5Type = steps[5].type;
  const step6Type = steps[6].type;
  const hasAfterLeave = typeof steps[6].afterLeave === 'function';
  const out = { step1Target, step5Type, step6Type, hasAfterLeave };
  console.log('SCENARIO B1 (populated canvas):', JSON.stringify(out));
  if (step1Target !== '.graph-node-user') throw new Error('step1 should target question node: ' + step1Target);
  if (step5Type !== 'click' || step6Type !== 'click') throw new Error('steps 5/6 should be click type');
  if (!hasAfterLeave) throw new Error('step6 needs afterLeave');

  // 空画布（中心节点场景）
  const ctx2 = makeUiCtx({ '.graph-new-session-node': 1 }, {});
  vm.runInNewContext(cfgTxt, ctx2);
  vm.runInNewContext(obSection, ctx2);
  const steps2 = vm.runInNewContext('_buildFullObSteps()', ctx2);
  if (steps2[1].target() !== '.graph-new-session-node') throw new Error('empty canvas step1 target wrong');
  console.log('SCENARIO B2 (empty canvas center node): OK');
}

// ====== C. nextObStep 触发 afterLeave / click 渲染不报错 ======
{
  const ctx = makeUiCtx({}, {});
  vm.runInNewContext(cfgTxt, ctx);
  vm.runInNewContext(obSection, ctx);
  // 手工跑一遍 click 步骤的渲染（无 DOM 目标 → ob-center 路径）
  await vm.runInNewContext('startOnboarding(false)', ctx);
  const r = await vm.runInNewContext('(async () => { try { _obStep = 5; _renderObStep(); return "render5-ok"; } catch (e) { return "ERR:" + e.message; } })()', ctx);
  if (!String(r).includes('ok')) throw new Error('render click step failed: ' + r);
  console.log('SCENARIO C1 (render click step):', r);
}

console.log('SMOKE TEST PASSED');
