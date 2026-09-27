// 新手引导 v2 冒烟测试（click 型步骤 / 提问目标 / afterLeave）
//
// 路径按脚本位置解析，不再写死 D:/PhyMathia——那台机器之外一律 ENOENT，整个脚本
// 连第一行都跑不到，等于早就废了（backlog T9）。
//
// 原先的 A 段（演示会话 ensureDemoSession）已随 src/static/js/demo.js 一起删除：
// 那个函数全仓只有本脚本在调，产品里没人用，是真正的死代码（backlog T1）。
// 这里现在只测 ui.js 里活着的引导代码。
import vm from 'node:vm';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const R = resolve(ROOT, 'src', 'static');
const uiTxt = fs.readFileSync(R + '/js/ui.js', 'utf8');
const cfgTxt = fs.readFileSync(R + '/js/config.js', 'utf8');

const startM = uiTxt.indexOf('// ====== 首次使用引导 (v2) ======');
const endM = uiTxt.indexOf('// Handle resize during onboarding');

// ---- 体检：这份脚本测的引导代码已经不是现在这一代了（2026-09-27 查实）----
// 它切片的标记 `// ====== 首次使用引导 (v2) ======` 在 ui.js 里**根本不存在**，
// indexOf 返回 -1，于是整段都在对着一份错位的切片跑；它调的
// `_buildFullObSteps` / `_renderObStep` 也都不在了（现在是 `_obSteps` 数据驱动
// 数组 + `startOnboarding` + `_obStep`，ui.js:770 起）。叠加此前写死的 D:/ 路径，
// 这脚本从路径修好那一刻起就一次都没绿过。
//
// 恢复它是**重写不是修活**：要照现在这代引导重新写场景。本轮不做，登记在
// docs/backlog.md。这里改成体检不过就立刻退出并说清病因——别再抛一句看不懂的
// ReferenceError，那会让人误以为是产品回归。
if (startM < 0 || endM < 0) {
  console.error(
    'ob_smoke: 测的不是当前这一代引导代码，已停止。\n' +
    '  · ui.js 里找不到切片标记：// ====== 首次使用引导 (v2) ======\n' +
    '  · 本脚本调的 _buildFullObSteps / _renderObStep 在 ui.js 里已不存在\n' +
    '  · 现在的引导是 _obSteps 数组 + startOnboarding + _obStep（ui.js:770 起）\n' +
    '  → 需要重写，见 docs/backlog.md。在重写完成前，请不要把本脚本的退出当成产品回归。');
  process.exit(2);
}
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
    '.graph-canvas-toolbar': 2, '.phi-pet-root': 1,
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
