// 新手引导冒烟测试（当代 _obSteps 数据驱动引导；2026-10-07 backlog T33 重写）
//
// 测什么（src/static/js/ui-onboarding.js——2026-10-10 T261 起「首次使用引导」段
// 自 ui.js 纯搬家至此，切片止标记随之从 ui.js 的 resize 注释行改为本文件尾）：
//   · _obSteps 数据驱动步骤数组：welcome / spotlight / click 三种 type；
//     target/title/desc 多为 getter，按画布状态（有无中心节点、桌面/移动端）切换
//   · startOnboarding(force)（force=false 时按 ONBOARDING_KEY 跳过）/
//     _renderObStep() / _obStep 游标 / nextObStep() / endOnboarding()
//   · 结束路径写完成标记：localStorage[ONBOARDING_KEY]（config.js:226 定义为
//     'phymathia_onboarding_done'，写值 '1'）——本脚本按当代实现实际写入的键断言
// 上一代引导（_buildFullObSteps / 旧签名 _renderObStep，切片标记「首次使用引导
// (v2)」）已从 ui.js 删除；本脚本已按当代实现重写（旧版本曾因标记漂移 exit 2）。
//
// 怎么测：路径按本脚本位置解析（不写死盘符，见 backlog T9）；从 ui-onboarding.js 截出
// 引导段（START_MARKER .. 文件尾），在 vm.runInNewContext 里配一份「当代代码实际取用」
// 的假 DOM（classList / innerHTML / getElementById / querySelector / innerWidth /
// 可记录监听器的元素等）执行。真实布局测量（真机 spotlight 像素定位、滚动等）不在
// 冒烟范围：这类行为退一步只断数据不变量，不硬造 DOM。
//
// 约束：切片靠 START_MARKER 定位、止于文件尾。**改 ui-onboarding.js 引导段时若挪动或
// 改写标记行，必须同步改本文件的 START_MARKER**；找不到标记时本脚本 exit 2 并打印病因，
// 绝不静默错位执行（上一代脚本正是这样对着错位切片跑废的）。
//
// 运行：node scripts/ob_smoke.mjs   → 尾部打印 SMOKE TEST PASSED，断言失败非零退出
import vm from 'node:vm';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SELF), '..');
const UI_JS = resolve(ROOT, 'src', 'static', 'js', 'ui-onboarding.js');
const CFG_JS = resolve(ROOT, 'src', 'static', 'js', 'config.js');

const START_MARKER = '// ====== 首次使用引导 ======';

const uiTxt = fs.readFileSync(UI_JS, 'utf8');
const cfgTxt = fs.readFileSync(CFG_JS, 'utf8');

const startM = uiTxt.indexOf(START_MARKER);

// ---- 切片标记漂移体检：找不到就 exit 2，不做错位执行 ----
if (startM < 0) {
  console.error(
    'ob_smoke: ui-onboarding.js 中找不到引导段切片标记，已停止（非产品回归，是体检脚本与源码失去对齐）。\n' +
    '  · 本脚本测当代引导：_obSteps（welcome/spotlight/click）+ startOnboarding/_renderObStep/_obStep\n' +
    '  · 缺失：起标记 ' + JSON.stringify(START_MARKER) + '\n' +
    '  · 若这次改动挪动/改写了 ui-onboarding.js「首次使用引导」段的标记行，请同步更新\n' +
    '    ' + SELF + ' 顶部的 START_MARKER\n' +
    '  · 找不到标记时按设计退出码 2');
  process.exit(2);
}
const obSection = uiTxt.slice(startM);
const startLine = uiTxt.slice(0, startM).split('\n').length;
console.log('slice: ui-onboarding.js ' + startLine + '-' + uiTxt.split('\n').length + ' 行（起标记后到文件尾）');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---- 假 DOM：按当代引导实际取用的字段扩充（缺什么补什么）----
function makeEl() {
  const classes = new Set();
  return {
    classList: {
      add(...names) { names.forEach((n) => classes.add(n)); },
      remove(...names) { names.forEach((n) => classes.delete(n)); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : !!force;
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains(name) { return classes.has(name); },
    },
    style: {},
    className: '',
    innerHTML: '',
    textContent: '',
    disabled: false,
    listeners: {},
    addEventListener(type, fn) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(fn);
    },
    removeEventListener(type, fn) {
      const arr = this.listeners[type] || [];
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    },
    getBoundingClientRect() {
      return { left: 100, top: 200, right: 300, bottom: 250, width: 200, height: 50 };
    },
    offsetWidth: 380,
    offsetHeight: 220,
    querySelector() { return null; },
  };
}

// selectorsPresent 里的选择器 querySelector 才命中；其余返回 null（如无中心节点的空画布）
function makeDom(selectorsPresent) {
  const present = new Set(selectorsPresent || []);
  const pool = new Map();
  const el = (key) => {
    if (!pool.has(key)) pool.set(key, makeEl());
    return pool.get(key);
  };
  return {
    body: el('body'),
    documentElement: el('html'),
    querySelector(sel) { return present.has(sel) ? el('sel:' + sel) : null; },
    getElementById(id) { return el('id:' + id); },
  };
}

// 桌面端假 DOM 存在的选择器：覆盖 _obSteps 里 getter / click 型步骤会查询的目标
const DESKTOP_SELECTORS = [
  '.graph-new-session-node',
  '.graph-canvas',
  '.header-actions',
  '.menu-btn',
  '.session-item',
];

function makeCtx(opts) {
  const options = opts || {};
  const store = options.store || {};
  const ctx = {
    console,
    document: makeDom(options.selectors),
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    },
    // 假定时器：立刻执行，冒烟不排队等待
    setTimeout: (f) => { f(); return 1; },
    clearTimeout: () => {},
    requestAnimationFrame: (f) => { f(); return 1; },
    cancelAnimationFrame: () => {},
    // utils.js 的实现读 getComputedStyle；切片只在拼 EXAMPLE_GUIDE_VIZ_HTML 时取值，
    // 冒烟不断言其内容，给常量即可
    cssVarValue: () => '#808080',
    innerWidth: 1440,
    innerHeight: 900,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.runInNewContext(cfgTxt, ctx); // ONBOARDING_KEY / UI_ICON_SVG 等常量（config.js）
  vm.runInNewContext(obSection, ctx); // 引导段切片
  return ctx;
}

let centerStepIndex = -1;
let centerTitle = '';

// ====== 场景 1：_obSteps 数据形状（有中心节点的桌面假 DOM）======
{
  const ctx = makeCtx({ selectors: DESKTOP_SELECTORS });
  const info = vm.runInNewContext(`_obSteps.map((s, i) => ({
    index: i,
    type: s.type,
    isGetterTarget: !!(Object.getOwnPropertyDescriptor(s, 'target') || {}).get,
    target: s.target,
    title: s.title,
    hasOnClick: typeof s.onClick === 'function'
  }))`, ctx);

  const types = info.map((s) => s.type);
  const clickSteps = info.filter((s) => s.type === 'click');
  const getterTargets = info.filter((s) => s.isGetterTarget).map((s) => s.target);
  const centerStep = info.find((s) => s.target === '.graph-new-session-node');
  console.log(
    'SCENARIO 1 (steps shape): count=' + info.length +
    ' types=' + [...new Set(types)].join('/') +
    ' clickSteps=[' + clickSteps.map((s) => s.index).join(',') + ']' +
    ' getterTargets=[' + getterTargets.join(', ') + ']'
  );

  assert(info.length >= 6, '引导步数应 ≥6，实际 ' + info.length);
  info.forEach((s) => assert(['welcome', 'spotlight', 'click'].includes(s.type), '步骤 #' + s.index + ' 出现未知 type=' + s.type));
  ['welcome', 'spotlight', 'click'].forEach((t) => assert(types.includes(t), '缺少 type=' + t + ' 的步骤'));
  clickSteps.forEach((s) => assert(s.hasOnClick, 'click 型步骤 #' + s.index + ' 没有可调用的 onClick'));
  info.filter((s) => s.type === 'spotlight').forEach((s) => {
    assert(typeof s.target === 'string' && s.target, 'spotlight 型步骤 #' + s.index + ' 的 target 未解析出选择器');
  });
  assert(centerStep, '有中心节点的假 DOM 下，应有 target 解析到 .graph-new-session-node 的 getter 型步骤');
  assert(centerStep.title === '在中心节点提问', '中心节点场景标题应为「在中心节点提问」，实际 ' + JSON.stringify(centerStep.title));
  centerStepIndex = centerStep.index;
  centerTitle = centerStep.title;
}

// ====== 场景 2：空画布回退（无 .graph-new-session-node）======
{
  const ctx = makeCtx({ selectors: ['.graph-canvas'] });
  const fallback = vm.runInNewContext(
    '({ target: _obSteps[' + centerStepIndex + '].target, title: _obSteps[' + centerStepIndex + '].title })',
    ctx
  );
  console.log('SCENARIO 2 (empty canvas fallback): target=' + fallback.target + ' title=' + JSON.stringify(fallback.title));

  assert(fallback.target === '.graph-canvas', '无中心节点时 target 应回退 .graph-canvas，实际 ' + fallback.target);
  assert(fallback.title === '继续探索', '无中心节点时标题应切换为「继续探索」，实际 ' + JSON.stringify(fallback.title));
  assert(fallback.title !== centerTitle, '空画布与中心节点两场景的标题应当不同');
}

// ====== 场景 3：startOnboarding(true) 在假 DOM 下跑通 + 三型渲染不抛错 ======
{
  const ctx = makeCtx({ selectors: DESKTOP_SELECTORS });
  const res = vm.runInNewContext(`(() => {
    startOnboarding(true);
    const overlay = document.getElementById('onboardingOverlay');
    const card = document.getElementById('onboardingCard');
    const started = {
      overlayActive: overlay.classList.contains('active'),
      step: _obStep,
      cardVisible: card.classList.contains('visible')
    };
    const rendered = { welcome: [], spotlight: [], click: [] };
    const errors = [];
    _obSteps.forEach((step, i) => {
      try {
        _obStep = i;
        _renderObStep();
        rendered[step.type].push(i);
      } catch (e) {
        errors.push(step.type + '#' + i + ': ' + (e && e.message ? e.message : String(e)));
      }
    });
    return { started, rendered, errors };
  })()`, ctx);

  console.log(
    'SCENARIO 3 (start + render): step=' + res.started.step +
    ' rendered=' + JSON.stringify(res.rendered) +
    ' errors=' + res.errors.length
  );

  assert(res.started.overlayActive, 'startOnboarding(true) 后 onboardingOverlay 应带 active');
  assert(res.started.step === 0, 'startOnboarding(true) 应把 _obStep 置 0，实际 ' + res.started.step);
  assert(res.started.cardVisible, '首次渲染完成后卡片应带 visible');
  assert(res.errors.length === 0, '渲染步骤抛错：' + res.errors.join(' | '));
  ['welcome', 'spotlight', 'click'].forEach((t) => {
    assert(res.rendered[t].length > 0, '没有成功渲染 type=' + t + ' 的步骤');
  });
}

// ====== 场景 4：走完整个步骤序列到达结束路径 + 完成标记写入假 localStorage ======
{
  const store = {};
  const ctx = makeCtx({ selectors: DESKTOP_SELECTORS, store });
  const walk = vm.runInNewContext(`(() => {
    const trace = [];
    let error = '';
    startOnboarding(true);
    let guard = 0;
    while (_obStep >= 0 && guard++ <= _obSteps.length + 2) {
      const idx = _obStep;
      const step = _obSteps[idx];
      trace.push(idx + ':' + step.type);
      if (step.type === 'click') {
        // click 型：按真机路径触发绑在目标上的处理器（处理器内部会 nextObStep）
        const el = document.querySelector(step.target);
        const handlers = el && el.listeners && el.listeners.click ? el.listeners.click.slice() : [];
        if (!handlers.length) { error = 'click 步 #' + idx + ' 渲染后未绑定点击处理器'; break; }
        handlers.forEach(h => h({ stopPropagation() {} }));
      } else if (idx === _obSteps.length - 1) {
        endOnboarding(); // 末步「开始使用 / 跳过」按钮的结束路径
      } else {
        nextObStep();
      }
    }
    return {
      trace,
      error,
      finalCursor: _obStep,
      overlayActive: document.getElementById('onboardingOverlay').classList.contains('active'),
      doneValue: localStorage.getItem(ONBOARDING_KEY)
    };
  })()`, ctx);

  const onboardingKey = vm.runInNewContext('ONBOARDING_KEY', ctx);
  const expectedTrace = vm.runInNewContext('_obSteps.map((s, i) => i + ":" + s.type).join(",")', ctx);
  // 已有完成标记后 force=false 应跳过
  const skip = vm.runInNewContext(`(() => {
    startOnboarding(false);
    return { cursor: _obStep, overlayActive: document.getElementById('onboardingOverlay').classList.contains('active') };
  })()`, ctx);

  console.log(
    'SCENARIO 4 (full walk): trace=[' + walk.trace.join(' -> ') + ']' +
    ' | key=' + onboardingKey + ' value=' + JSON.stringify(store[onboardingKey]) +
    ' | skip-after-done=' + (skip.cursor === -1 && !skip.overlayActive ? 'skipped' : 'FAILED')
  );

  // 完成标记键取当代实现实际写入的 ONBOARDING_KEY（config.js:226），并钉住当前字面值防漂移
  assert(onboardingKey === 'phymathia_onboarding_done', 'ONBOARDING_KEY 已改名（现为 ' + onboardingKey + '），请同步本脚本断言');
  assert(!walk.error, walk.error);
  assert(walk.trace.join(',') === expectedTrace, '遍历顺序应为 ' + expectedTrace + '，实际 ' + walk.trace.join(','));
  assert(walk.finalCursor === -1, '结束路径应把 _obStep 置 -1，实际 ' + walk.finalCursor);
  assert(walk.overlayActive === false, 'endOnboarding 后 overlay 应移除 active');
  assert(walk.doneValue === '1', '结束路径应写完成标记 ' + onboardingKey + '=1，实际 ' + JSON.stringify(walk.doneValue));
  assert(store[onboardingKey] === '1', '假 localStorage 里应有 ' + onboardingKey + '=1');
  assert(skip.cursor === -1 && !skip.overlayActive, '已有完成标记时 startOnboarding(false) 应直接跳过（不进任何一步）');
}

console.log('SMOKE TEST PASSED');
