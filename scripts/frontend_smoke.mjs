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
let __smokeUuid = 0;
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
const check = (name, fn) => {
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

check('buildHarnessSnapshot 可调用且回结构（回归：rawCount 未定义事故）', () => {
  // 注入两个画布节点，其中一个标记软删除
  sandbox.window.getGraphState = () => ({ harnessDeleted: { B: true } });
  sandbox.window.getCurrentSessionId = () => 'sess_test';
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  // 解耦后快照读「绑定画布」状态：注入一个绑到 sess_test 的当前 Φ 会话
  vm.runInContext('phiSessions = { phi_t: { id: "phi_t", title: "t", boundSid: "sess_test", createdAt: 1, updatedAt: 1 } }; currentPhiId = "phi_t";', sandbox);
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

check('节点配方注册表（P0）：18 条官方配方派生 16 入口与 kind 白名单（含 relation）', () => {
  const recipes = sandbox.window.BUILTIN_RECIPES;
  if (!Array.isArray(recipes) || recipes.length !== 18) throw new Error('官方配方应为 18 条（16 入口 + relation/ai_eval），实际 ' + (recipes && recipes.length));
  const options = sandbox.window.deriveManualNodeOptions();
  if (options.length !== 16) throw new Error('添加面板入口应 16 个，实际 ' + options.length);
  if (options.some(o => !o.label || !o.color || !o.group)) throw new Error('入口字段不完整');
  // T75：relation 进 kind 白名单（旧会话 relation 节点保存不再被静默抹掉），但仍无手动入口
  const kinds = sandbox.window.deriveGraphCustomNodeKinds();
  if (!Array.isArray(kinds) || !kinds.includes('relation')) throw new Error('kind 白名单缺 relation（T75 回归）');
  if (options.some(o => o.key === 'relation' || o.key === 'ai_eval')) throw new Error('hidden 类型不得进添加面板');
  // Φ 快照类型清单与官方配方同源（16 项，module 项带 module_key）
  const types = sandbox.window.deriveHarnessAvailableNodeTypes();
  if (types.length !== 16) throw new Error('available_node_types 应 16 项，实际 ' + types.length);
  const physics = types.find(t => t.kind === 'module' && t.module_key === 'physics');
  if (!physics || physics.label !== '物理视角') throw new Error('module 类型项缺 module_key/label');
  return true;
});

// ===== 节点配方 P1：校验器 / 全链（创建→渲染槽→提示词槽→持久化）=====
// 共享 phymathia_node_recipes 键但全程同步（无 await），不与在途异步用例互踩，
// 不需要进文件末尾的串行边界段（该段是给改共享键且会 await 的用例的）。

function _smokeValidRecipe() {
  return {
    id: 'recipe-smoke-1',
    name: '错题复盘',
    desc: '考后复盘：考点 / 易错点 / 口诀',
    base: { kind: 'module' },
    appearance: { palette: 'amber', shape: 'is-round' },
    generate: {
      prompt: '针对当前问题输出考后复盘，分三段：考点回顾 / 易错点 / 记忆口诀。',
      strict_output: '只输出三段，每段以「### 」标题开头。',
      followup_prompt: '',
      confused_prompt: '',
      context_channel: 'workflow_context',
    },
    ports: { static: [
      { label: '追问', drag_form: 'draft' },
      { label: '再测一道', drag_form: 'user' },
    ] },
    content_kind: 'markdown',
  };
}

check('配方校验器（P1）：色板令牌 / 提示词预算 / 出口上限 / 名称查重 / 字段白名单', () => {
  const validate = sandbox.window.validateRecipe;
  const normalize = sandbox.window.normalizeRecipeInput;
  if (typeof validate !== 'function' || typeof normalize !== 'function') throw new Error('校验器未挂 window');
  // 色板全部是 var(--ink-*) 令牌引用，JS 侧零 hex（T8 红线）
  const palette = sandbox.window.RECIPE_PALETTE;
  if (!Array.isArray(palette) || palette.length < 5) throw new Error('色板至少 5 项');
  if (palette.some(entry => !/^var\(--ink-[a-z-]+\)$/.test(entry.color))) throw new Error('色板颜色必须是 var(--ink-*) 令牌引用');
  // 合法样本过
  const ok = validate(_smokeValidRecipe(), []);
  if (!ok.ok) throw new Error('合法样本被拒：' + ok.errors.join('；'));
  // 四类拒绝
  const bad = validate({ ..._smokeValidRecipe(), appearance: { palette: 'hotpink' } }, []);
  if (bad.ok || !bad.errors.some(e => e.includes('色板'))) throw new Error('非法色板未拦截');
  const noPrompt = validate({ ..._smokeValidRecipe(), generate: { prompt: '' } }, []);
  if (noPrompt.ok || !noPrompt.errors.some(e => e.includes('主提示词'))) throw new Error('AI 底座缺主提示词未拦截');
  const tooMany = validate({ ..._smokeValidRecipe(), ports: { static: Array.from({ length: 9 }, (_, i) => ({ label: '口' + i, drag_form: 'draft' })) } }, []);
  if (tooMany.ok || !tooMany.errors.some(e => e.includes('出口最多'))) throw new Error('出口超上限未拦截');
  const dup = validate(_smokeValidRecipe(), [{ ..._smokeValidRecipe(), id: 'recipe-other' }]);
  if (dup.ok || !dup.errors.some(e => e.includes('同名配方'))) throw new Error('重名未拦截');
  // 字段白名单：未知字段剥除 + aggregation 按底座推导
  const normalized = normalize({ ..._smokeValidRecipe(), evil: 'drop me' });
  if (!normalized || normalized.evil !== undefined) throw new Error('未知字段未被剥除');
  if (normalized.aggregation !== 'ancestors') throw new Error('module 底座应推导 ancestors');
  if (normalize({ ..._smokeValidRecipe(), base: { kind: 'knowledge' } }).aggregation !== 'self_fields') throw new Error('knowledge 底座应推导 self_fields');
  if (normalize({ ..._smokeValidRecipe(), base: { kind: 'note' } }).aggregation !== 'none') throw new Error('note 底座应推导 none');
  return true;
});

check('配方自由色（2026-09-30 D-R8 放宽）：归一化 / 优先级 / 色值往返 / 非法色拦截', () => {
  const normalizeColor = sandbox.window.normalizeRecipeColor;
  const appearanceColor = sandbox.window.recipeAppearanceColor;
  const hsvToRgb = sandbox.window._recipeHsvToRgb;
  const rgbToHsv = sandbox.window._recipeRgbToHsv;
  const rgbToHex = sandbox.window._recipeRgbToHex;
  const validate = sandbox.window.validateRecipe;
  const normalize = sandbox.window.normalizeRecipeInput;
  for (const [name, fn] of Object.entries({ normalizeColor, appearanceColor, hsvToRgb, rgbToHsv, rgbToHex })) {
    if (typeof fn !== 'function') throw new Error(name + ' 未挂 window');
  }
  // 1. 归一化：短写补齐、大小写压平；非 hex 一律空串（收窄成 hex 形状是注入防线）
  if (normalizeColor('#3aF') !== '#33aaff') throw new Error('短写 hex 未补齐：' + normalizeColor('#3aF'));
  if (normalizeColor('  #D9B45C ') !== '#d9b45c') throw new Error('hex 未 trim/压小写');
  for (const junk of ['red', '#12345', 'url(x)', 'red; background: url(x)', '', null, undefined, 123]) {
    if (normalizeColor(junk) !== '') throw new Error('非法色未被拒：' + JSON.stringify(junk));
  }
  // 2. 优先级：自由色压过色板令牌，且带主题锚点（切主题即换色，不靠重绘画布）
  const custom = appearanceColor({ palette: 'teal', color: '#123456' });
  if (!custom.includes('#123456') || !custom.includes('var(--recipe-ink-anchor)')) {
    throw new Error('自由色未走主题自适应：' + custom);
  }
  if (appearanceColor({ palette: 'teal' }) !== 'var(--ink-teal)') throw new Error('无自由色时应回色板令牌');
  if (appearanceColor({ palette: 'hotpink' }) !== 'var(--accent)') throw new Error('非法色板应回中性色');
  // 3. 往返自洽：hex → hsv → hex 对预设色与边界值都不漂（取色器最怕悄悄偏色）
  const roundTrip = hex => {
    const parts = normalizeColor(hex).slice(1).match(/../g).map(part => parseInt(part, 16));
    const hsv = rgbToHsv(parts[0], parts[1], parts[2]);
    const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
  };
  for (const hex of ['#d9b45c', '#85a9e8', '#e08a9f', '#74bfa8', '#b599e0',
                     '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#010203']) {
    if (roundTrip(hex) !== hex) throw new Error('色值往返漂移：' + hex + ' → ' + roundTrip(hex));
  }
  // 4. 校验器：合法自由色放行，注入串当场拦下
  const okColor = validate({ ..._smokeValidRecipe(), appearance: { palette: 'teal', color: '#3aa', shape: 'is-round' } }, []);
  if (!okColor.ok) throw new Error('合法自由色被拒：' + okColor.errors.join('；'));
  for (const junk of ['chartreuse', '#12345', 'red; background: url(x)']) {
    const badColor = validate({ ..._smokeValidRecipe(), appearance: { palette: 'teal', color: junk, shape: 'is-round' } }, []);
    if (badColor.ok || !badColor.errors.some(e => e.includes('自定义颜色'))) throw new Error('非法自由色未拦截：' + junk);
  }
  // 5. 落库形态：调过才带 color，没调整段缺省（旧配方字节不变）
  const tuned = normalize({ ..._smokeValidRecipe(), appearance: { palette: 'teal', color: '#3aF', shape: 'is-round' } });
  if (tuned.appearance.color !== '#33aaff' || tuned.appearance.palette !== 'teal') throw new Error('自由色落库形态不对：' + JSON.stringify(tuned.appearance));
  if ('color' in normalize(_smokeValidRecipe()).appearance) throw new Error('未调色时不该写 color 键');
  return true;
});

check('取色器 UI 契约：表单有自定义档、取色器画布与三套数值都在、主题锚点有定义', () => {
  const editSrc = fs.readFileSync('src/static/js/graph-recipe-edit.js', 'utf8');
  // 表单：7 个预设之外多一个「自定义」档，点了开取色器
  if (!/id="recipeColorChipBtn"/.test(editSrc)) throw new Error('色板行缺自定义档按钮');
  if (!/onclick="openRecipeColorPicker\(\)"/.test(editSrc)) throw new Error('自定义档没接开取色器');
  // 取色器本体：饱和度方块 + 色相条 + 新旧对比 + 三套数值
  for (const [what, re] of [
    ['饱和度方块', /id="recipeColorSv"/],
    ['色相条', /id="recipeColorHue"/],
    ['新的预览', /id="recipeColorNew"/],
    ['当前预览', /id="recipeColorOld"/],
    ['色号输入', /id="recipeColorHex"/],
    ['H 档', /id="recipeColorH"/],
    ['RGB 三档', /id="recipeColorR"[\s\S]*id="recipeColorG"[\s\S]*id="recipeColorB2"/],
    ['回预设色入口', /recipeColorResetPreset/],
  ]) {
    if (!re.test(editSrc)) throw new Error('取色器缺' + what);
  }
  // 收尾动作：确定只写编辑器状态（不直接落库，取消不留痕）
  if (!/function recipeColorConfirm\(\)[\s\S]{0,400}recipeColorCustom = _recipeRgbToHex/.test(editSrc)) {
    throw new Error('「用这个颜色」没写编辑器状态');
  }
  // 预设选中态只许在 7 个 data-palette 按钮上切：自定义档也是 .recipe-palette-swatch，
  // 混进去会被 recipeColorConfirm 的「清空预设选中」顺手抹掉自己的高亮
  if (!/\.recipe-palette-swatch\[data-palette\]/.test(editSrc)) throw new Error('预设选中态没限定在 data-palette 按钮上');
  // 主题锚点必须在 CSS 两个主题里都有值，否则 color-mix 整条作废
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!/:root\s*\{[^}]*--recipe-ink-anchor:\s*#ffffff/s.test(css)) throw new Error('缺深色主题锚点');
  if (!/\[data-theme="light"\]\s*\{[^}]*--recipe-ink-anchor:\s*#000000/s.test(css)) throw new Error('缺浅色主题锚点');
  return true;
});

check('配方全链（P1）：保存→创建节点→渲染槽（外观/出口/拖出目标）→提示词槽→快照内嵌', () => {
  // 沙箱口径：函数声明挂在 vm 全局（sandbox.*）而非宽松代理 window 上；图状态
  // 存取在前面用例里可能被桩成固定对象，这里换成自带的状态桩并在 finally 还原。
  const prevGet = sandbox.window.getGraphState, prevSave = sandbox.window.saveGraphState, prevSid = sandbox.window.getCurrentSessionId;
  let mem = null;
  const emptyState = () => ({ collapsed: {}, hidden: {}, positions: {}, pinned: {}, sizes: {}, pan: { x: 80, y: 80 }, zoom: 0.9, focus: null, layoutVersion: 1, connections: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, groups: [], customNodes: [], harnessDeleted: {}, harnessNodeOverrides: {}, harnessCheckpoint: null, updatedAt: 0 });
  sandbox.window.getGraphState = () => mem || emptyState();
  sandbox.window.saveGraphState = (_sid, state) => { mem = state; };
  sandbox.window.getCurrentSessionId = () => 'sess_recipe_smoke';
  try {
    // 1. 保存进库（写共享 localStorage 键，同步完成）
    sandbox.window.setUserRecipes([_smokeValidRecipe()]);
    const stored = sandbox.window.getUserRecipes();
    if (stored.length !== 1 || stored[0].name !== '错题复盘') throw new Error('配方保存后读回失败');
    // 2. 创建配方节点（落在桩状态里）
    sandbox.createRecipeNode('recipe-smoke-1');
    const state = sandbox.window.getGraphState();
    const node = (state.customNodes || []).find(n => n.recipeId === 'recipe-smoke-1');
    if (!node) throw new Error('createRecipeNode 未落 customNodes（customNodes ' + (state.customNodes || []).length + ' 条）');
    if (node.kind !== 'module') throw new Error('module 底座应落 kind=module，实际 ' + node.kind);
    if (!node.recipe || node.recipe.name !== '错题复盘') throw new Error('节点缺内嵌配方快照');
    // 3. 渲染槽：外观（attr 标签=配方名、色板令牌）与静态出口（含拖出目标）
    const attr = sandbox._nodeAttribute(node);
    if (!attr || attr.key !== 'recipe' || attr.label !== '错题复盘') throw new Error('配方节点外观未挂载：' + JSON.stringify(attr));
    if (attr.color !== 'var(--ink-amber)') throw new Error('色板令牌未生效：' + attr.color);
    const ports = sandbox._moduleOutputPorts(node, null);
    if (ports.length !== 2 || ports[0].label !== '追问' || ports[1].label !== '再测一道') throw new Error('静态出口未挂载');
    if (ports[1].dragCreates !== 'user') throw new Error('出口拖出目标未随端口下发');
    const portHtml = String(sandbox._renderOutputPorts(node, [], state));
    if (!portHtml.includes('data-port-drag') || !portHtml.includes(encodeURIComponent('user'))) throw new Error('拖出目标未渲染进端口 data 属性');
    // 4. 提示词槽：工作流提示词按配方四槽组装
    const ctx = sandbox._buildWorkflowContextForNode(node);
    if (ctx.target.label !== '错题复盘') throw new Error('上下文标签未用配方名：' + ctx.target.label);
    const prompt = sandbox._workflowPromptForNode(node, ctx);
    if (!prompt.includes('考点回顾 / 易错点 / 记忆口诀')) throw new Error('主提示词未进工作流提示词');
    if (!prompt.includes('### ') || !prompt.includes('「错题复盘」')) throw new Error('严格输出/配方名未进工作流提示词');
    // 5. 持久化口径：保存后的 state 快照字段完整（_normalizeGraphState 整条透传 customNodes）
    const savedNode = (mem.customNodes || []).find(n => n.id === node.id);
    if (!savedNode || savedNode.recipeId !== 'recipe-smoke-1' || !savedNode.recipe) throw new Error('保存后快照字段丢失');
    // 6. 删配方不毁旧节点（快照内嵌的意义）
    sandbox.window.setUserRecipes([]);
    if (sandbox.window.getUserRecipes().length !== 0) throw new Error('删配方失败');
    const after = sandbox.window.getGraphState().customNodes.find(n => n.id === node.id);
    if (!after || !after.recipe) throw new Error('删配方后旧节点快照丢失');
    return true;
  } finally {
    sandbox.window.getGraphState = prevGet;
    sandbox.window.saveGraphState = prevSave;
    sandbox.window.getCurrentSessionId = prevSid;
  }
});

check('配方拖出路由（P1）：drag_creates 表驱动（user 预填 / connected 连线创建 / draft 默认）', () => {
  // 静态断言 + 行为断言各一半：行为上 user 路由走 _createQuestionNodeFromPort，
  // connected 走 _createConnectedManualNode——沙箱里真调会牵动图状态，这里验路由分支
  // 的判据函数与端口 meta 的下发链（渲染层 data-port-drag → linkDrag.portMeta.dragCreates）。
  const interactSrc = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!interactSrc.includes("dragForm === 'user'")) throw new Error('user 路由分支缺失');
  if (!interactSrc.includes('_createConnectedManualNode(dragForm.slice') || !interactSrc.includes('/^connected:[a-z_]+$/')) throw new Error('connected 路由分支缺失');
  if (!interactSrc.includes('dragCreates: portEl.dataset.portDrag')) throw new Error('linkDrag 未携带 dragCreates');
  // 内置节点零变化：官方出口不带 data-port-drag
  const moduleNode = { id: 'm1', kind: 'module', moduleKey: 'physics', messageIndex: -1, recipeId: '', timestamp: 1 };
  const html = String(sandbox._renderOutputPorts(moduleNode, [], { portCounts: {}, inputPortCounts: {} }));
  if (html.includes('data-port-drag')) throw new Error('内置模块出口不应带拖出目标声明');
  return true;
});

check('配方 P1 边界（P1）：knowledge/relation 配方节点走 AI 生成、内置仍手填；plain 载体渲染', () => {
  // knowledge/relation 底座：有配方时不再提前返回「已填写/待填写」，走 _generateCustomNode
  const wfSrc = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  if (!wfSrc.includes('(current.kind === \'knowledge\' || current.kind === \'relation\') && !current.recipeId')) throw new Error('knowledge/relation 配方贯通分支缺失');
  // plain 载体：纯转义，不走 markdown（沙箱的 document 是宽松代理，escapeHtml 产物
  // 会退化为 0——沿用大陆用例的恒等替换口径，断言 plain 分支原样输出、不经 markdown 管线）
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    const plainNode = { id: 'p1', kind: 'module', moduleKey: '', recipeId: 'r', recipe: { ..._smokeValidRecipe(), content_kind: 'plain' }, content: '<b>加粗不该解析</b>', messageIndex: -1, timestamp: 2 };
    const html = String(sandbox._renderCustomNodeContentHtml(plainNode));
    if (html !== '<div class="graph-custom-node-render"><b>加粗不该解析</b></div>') throw new Error('plain 载体应原样输出，实际：' + html);
  } finally { sandbox.escapeHtml = realEsc; }
  // answer→module 连线口径：配方模块接受任意 answer 出口（fromAttr === toAttr 的旁路）
  const renderSrc = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!renderSrc.includes('toNode.recipeId ? true : fromAttr === toAttr')) throw new Error('配方模块连线旁路缺失');
  return true;
});
// ===== 节点配方 P1 用例结束 =====

// ===== 节点配方 P2：动态出口 / 载体与生成维度 / on_generated 编排 =====
// 与 P1 用例同口径：全程同步（无 await），不占串行边界段。

function _smokeDynRecipe(overrides) {
  const dyn = {
    parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶', '拓展'], max: 12, label_from: 'index_question' },
    fallback: { mode: 'label_questions_from_text', labels: ['问题1', '问题2', '问题3'] },
    each: { type: 'socratic', branch_type: 'socratic', drag_form: 'draft' },
    ...(overrides || {}),
  };
  return sandbox.window.normalizeRecipeInput({
    ..._smokeValidRecipe(),
    id: 'recipe-smoke-dyn',
    name: '我的追问器',
    aggregation: 'first_inbound',
    ports: { static: [{ label: '追问', drag_form: 'draft' }], dynamic: dyn },
  });
}

function _smokeDynNode(recipe, content) {
  return {
    id: 'dyn-node-1', kind: 'module', moduleKey: '', recipeId: recipe.id, recipe,
    content: content || '', messageIndex: -1, timestamp: 42,
  };
}

check('配方动态出口（P2）：numbered_list 解析（级别白名单/上限/两种标签）＋fallback 三模式', () => {
  const parse = sandbox.window._recipeParseNumberedList;
  if (typeof parse !== 'function') throw new Error('_recipeParseNumberedList 未挂 window');
  // 级别白名单：只收带 [基础/进阶/拓展] 标记的行；learn 式空表＝全收
  const tagged = '前言不该出现\n1. [基础] 什么是弹簧振子\n2) 无标记行应被过滤\n3. [进阶] 为何满足微分方程\n- [拓展] 阻尼如何改变结论';
  const withLevel = parse(tagged, { level_tags: ['基础', '进阶', '拓展'], max: 12 });
  if (withLevel.length !== 3 || withLevel[0].question !== '什么是弹簧振子' || withLevel[0].level !== 'basic' || withLevel[2].level !== 'expand') {
    throw new Error('级别解析不符：' + JSON.stringify(withLevel));
  }
  const noLevel = parse(tagged, { level_tags: [], max: 12 });
  if (noLevel.length !== 4) throw new Error('learn 式（不校验级别）应收 4 行，实际 ' + noLevel.length);
  // 上限
  const capped = parse('1. a问题\n2. b问题\n3. c问题', { level_tags: [], max: 2 });
  if (capped.length !== 2) throw new Error('max=2 应截到 2 个，实际 ' + capped.length);
  // 端口 meta：label_from 两种方式 + 静态/动态合并 + socratic 端口形状
  const recipe = _smokeDynRecipe();
  const node = _smokeDynNode(recipe, '### 追问\n1. [基础] 什么是弹簧振子\n2. [进阶] 为何满足微分方程');
  const ports = sandbox._moduleOutputPorts(node, null);
  if (ports.length !== 3 || ports[0].label !== '追问') throw new Error('静态+动态出口应合并 3 个，实际 ' + JSON.stringify(ports.map(p => p.label)));
  if (ports[1].type !== 'socratic' || ports[1].branchType !== 'socratic' || ports[1].attribute !== 'recipe') throw new Error('socratic 端口 meta 形状不对：' + JSON.stringify(ports[1]));
  if (ports[1].label !== '问题1' || ports[1].question !== '什么是弹簧振子') throw new Error('index_question 标签/问题文本未按解析填充');
  const truncRecipe = _smokeDynRecipe({ parser: { pattern: 'numbered_list', level_tags: [], max: 12, label_from: 'question_trunc12' } });
  const truncPorts = sandbox._moduleOutputPorts(_smokeDynNode(truncRecipe, '1. 这是一个很长很长的问题文本要被截断'), null);
  if (truncPorts[1].label !== '这是一个很长很长的问题文…') throw new Error('question_trunc12 标签未截 12 字：' + truncPorts[1].label);
  // fallback：label_questions_from_text 从正文行截问题文本（治 T56：兜底不空白静默）
  const fbText = sandbox._moduleOutputPorts(_smokeDynNode(recipe, '这是一段说明文字。\n第二行补充说明。'), null);
  if (fbText.length !== 3 || fbText[1].question !== '这是一段说明文字。' || fbText[2].question !== '第二行补充说明。') {
    throw new Error('label_questions_from_text 兜底应带正文截取的问题：' + JSON.stringify(fbText));
  }
  const fbStatic = sandbox._moduleOutputPorts(_smokeDynNode(_smokeDynRecipe({ fallback: { mode: 'static', labels: ['问题1'] } }), '无编号行'), null);
  if (fbStatic.length !== 2 || fbStatic[1].question !== '' || fbStatic[1].label !== '问题1') throw new Error('static 兜底应只有固定名、question 留空：' + JSON.stringify(fbStatic));
  const fbNone = sandbox._moduleOutputPorts(_smokeDynNode(_smokeDynRecipe({ fallback: { mode: 'none', labels: [] } }), '无编号行'), null);
  if (fbNone.length !== 1) throw new Error('none 兜底应只剩静态出口 1 个，实际 ' + fbNone.length);
  return true;
});

check('配方生成维度（P2）：模型槽位优先＋回落、载体归一/重试/双阶段/单链接线', () => {
  // getActiveModelForRole 是 models.js 顶层函数声明：挂 vm 全局（sandbox.*），
  // 不是 window 代理（宽松代理只写自己的 store，不影响裸标识符解析）
  const prevRole = sandbox.getActiveModelForRole;
  sandbox.getActiveModelForRole = role => (role === 'html' ? { id: 'html-model' } : role === 'agent' ? { id: 'agent-model' } : null);
  try {
    const pick = sandbox._modelForWorkflowNode;
    const recipeNode = { kind: 'module', recipeId: 'r', recipe: { generate: { model_role: 'html' } } };
    if (pick(recipeNode).id !== 'html-model') throw new Error('配方 model_role=html 应选 html 槽');
    const unconfigured = { kind: 'module', recipeId: 'r', recipe: { generate: { model_role: 'graph' } } };
    if (pick(unconfigured).id !== 'agent-model') throw new Error('槽位未配置应回落主模型');
    const builtinSocratic = { kind: 'module', moduleKey: 'socratic' };
    if (pick(builtinSocratic).id !== 'agent-model') throw new Error('内置 socratic 在 branch 槽未配置时应回落 agent（行为零变化）');
  } finally { sandbox.getActiveModelForRole = prevRole; }
  // 静态断言：viz 收口扩到配方 html_iframe（重试预算/重试提示词）、mermaid 包围栏、
  // 双阶段概要与 on_generated 钩子的接线（这些分支要真模型才走到，行为留真机验收）
  const wfSrc = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  if (!wfSrc.includes("recipe.content_kind === 'html_iframe'")) throw new Error('viz 收口未覆盖配方 html_iframe');
  if (!wfSrc.includes('on_incomplete.max_retries')) throw new Error('重试预算未接 on_incomplete');
  if (!wfSrc.includes('retry_prompt')) throw new Error('重试提示词未接 retry_prompt');
  if (!wfSrc.includes("recipe.content_kind === 'mermaid'")) throw new Error('mermaid 载体归一缺失');
  if (!wfSrc.includes('recipe.analysis_phase')) throw new Error('双阶段概要接线缺失');
  if (!wfSrc.includes("recipeAgg === 'first_inbound' ? _collectInboundChain")) throw new Error('单链取材分派缺失');
  if (!wfSrc.includes('_recipeAfterGenerated(live)')) throw new Error('on_generated 钩子未挂生成完成点');
  // 单链取材行为：两条入边时 _collectInboundChain 只走第一条（空白节点式）。
  // graphView 是 graph.js 的 const 词法绑定，沙箱外不可达——经 vm.runInContext 原地改
  sandbox.__smokeDynRecipeRaw = JSON.stringify(_smokeDynRecipe());
  const questions = JSON.parse(vm.runInContext(`
    globalThis.__gvBackup = { edges: graphView.edges, nodes: graphView.nodes, byId: graphView.nodeById };
    graphView.nodes = []; graphView.edges = []; graphView.nodeById = {};
    [
      { id: 'fq', kind: 'user', content: '问题A', messageIndex: -1, timestamp: 1 },
      { id: 'fq2', kind: 'user', content: '问题B', messageIndex: -1, timestamp: 2 },
    ].forEach(n => { graphView.nodes.push(n); graphView.nodeById[n.id] = n; });
    const fnNode = { id: 'fn', kind: 'module', moduleKey: '', recipeId: 'r', messageIndex: -1, timestamp: 3 };
    fnNode.recipe = normalizeRecipeInput(JSON.parse(globalThis.__smokeDynRecipeRaw));
    graphView.nodes.push(fnNode); graphView.nodeById[fnNode.id] = fnNode;
    graphView.edges.push(
      { from: 'fq', fromPort: 'out-0', to: 'fn', toPort: 'in-0' },
      { from: 'fq2', fromPort: 'out-0', to: 'fn', toPort: 'in-0' },
    );
    const ctx = _buildWorkflowContextForNode(fnNode);
    const qs = (ctx.upstream || []).filter(item => item.kind === 'user').map(item => item.content);
    graphView.edges = globalThis.__gvBackup.edges;
    graphView.nodes = globalThis.__gvBackup.nodes;
    graphView.nodeById = globalThis.__gvBackup.byId;
    JSON.stringify(qs);
  `, sandbox));
  if (questions.includes('问题B')) throw new Error('first_inbound 只应收第一条入边链，实际收到：' + JSON.stringify(questions));
  if (!questions.includes('问题A')) throw new Error('第一条入边链缺失');
  return true;
});

check('配方 on_generated 编排（P2）：建链＋补链＋只跑一次＋链深 1 防递归', () => {
  // graphView（const 词法绑定）与 runWorkflowNodes（顶层函数声明）都在 vm 里：
  // 整个场景在一个 runInContext 里跑，结果经 globalThis 带出
  const recipeRaw = {
    ..._smokeValidRecipe(),
    id: 'recipe-smoke-og',
    name: '我的进阶器',
    ports: { static: [], dynamic: {
      parser: { pattern: 'numbered_list', level_tags: [], max: 12, label_from: 'question_trunc12' },
      fallback: { mode: 'none', labels: [] },
      each: { type: 'learn', branch_type: 'learn', drag_form: 'draft' },
    } },
    on_generated: {
      create: [
        { as: '$0', base: { kind: 'answer' }, label_template: '{self.label}的进阶学习', content_from: 'self_directions' },
        { as: '$1', base: { kind: 'module', recipe: 'learn' }, label: '进阶学习' },
      ],
      connect: [{ from: 'self', to: '$0', relation: '进阶' }],
      chain_check: true,
    },
  };
  sandbox.__smokeOgRecipeRaw = JSON.stringify(recipeRaw);
  sandbox.__smokeDynRecipeRaw = sandbox.__smokeDynRecipeRaw || JSON.stringify(_smokeDynRecipe());
  const result = JSON.parse(vm.runInContext(`
    const recipe = normalizeRecipeInput(JSON.parse(globalThis.__smokeOgRecipeRaw));
    const node = { id: 'og-node', kind: 'module', moduleKey: '', recipeId: recipe.id, recipe, label: '我的进阶器',
      content: '1. [基础] 方向一\\n2. [进阶] 方向二', messageIndex: -1, timestamp: 42 };
    globalThis.__gvBackup2 = { edges: graphView.edges, nodes: graphView.nodes, byId: graphView.nodeById };
    graphView.nodes = [node]; graphView.nodeById = { [node.id]: node }; graphView.edges = [];
    const prevRun = globalThis.runWorkflowNodes;
    const prevRender = globalThis.renderGraphCanvas;
    let generated = null;
    globalThis.runWorkflowNodes = ids => { generated = ids; };
    globalThis.renderGraphCanvas = () => {};
    const out = {};
    try {
      _recipeAfterGenerated(node);
      const created = graphView.nodes.filter(n => n.fromRecipeChain === true);
      const answer = created.find(n => n.kind === 'answer');
      const learn = created.find(n => n.kind === 'module');
      out.createdCount = created.length;
      out.answerLabel = answer && answer.label;
      out.answerContent = answer && answer.content;
      out.learnModuleKey = learn && learn.moduleKey;
      out.e1 = graphView.edges.find(e => e.from === node.id && e.to === answer.id) || null;
      out.e2 = graphView.edges.find(e => e.from === answer.id && e.to === learn.id) || null;
      out.marked = !!node.onGeneratedAt;
      out.generated = generated;
      const countBefore = graphView.nodes.length;
      _recipeAfterGenerated(node);
      out.retriggerCreated = graphView.nodes.length - countBefore;
      learn.recipeId = recipe.id;
      learn.recipe = recipe;
      _recipeAfterGenerated(learn);
      out.chainDepthBlocked = graphView.nodes.length - countBefore;
    } finally {
      globalThis.runWorkflowNodes = prevRun;
      globalThis.renderGraphCanvas = prevRender;
      graphView.edges = globalThis.__gvBackup2.edges;
      graphView.nodes = globalThis.__gvBackup2.nodes;
      graphView.nodeById = globalThis.__gvBackup2.byId;
    }
    JSON.stringify(out);
  `, sandbox));
  if (result.createdCount !== 2) throw new Error('应建 2 个节点，实际 ' + result.createdCount);
  if (result.answerLabel !== '我的进阶器的进阶学习') throw new Error('label_template 未替换 {self.label}：' + result.answerLabel);
  if (!String(result.answerContent).includes('1. 方向一') || !String(result.answerContent).includes('2. 方向二')) throw new Error('self_directions 未按解析行回填：' + result.answerContent);
  if (result.learnModuleKey !== 'learn') throw new Error('base.recipe=learn 应落 moduleKey=learn，实际 ' + result.learnModuleKey);
  if (!result.e1 || result.e1.relation !== '进阶') throw new Error('self→$0 边缺失或关系不对');
  if (!result.e2 || result.e2.relation !== '模块') throw new Error('chain_check 未补 $0→$1 边');
  if (!result.marked) throw new Error('onGeneratedAt 标记未写');
  if (!result.generated || result.generated.length !== 2) throw new Error('AI 节点未送回工作流：' + JSON.stringify(result.generated));
  if (result.retriggerCreated !== 0) throw new Error('重触发不应重复建链');
  if (result.chainDepthBlocked !== 0) throw new Error('fromRecipeChain 节点不应再触发 on_generated');
  return true;
});

check('draftAskAi 空问题提示（T56②）：兜底端口点「直接问AI」不再静默', () => {
  const interactSrc = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!/function draftAskAi[\s\S]{0,400}toastMsg\(/.test(interactSrc)) throw new Error('draftAskAi 空问题分支未接 toastMsg');
  return true;
});
// ===== 节点配方 P2 用例结束 =====
// ===== 节点配方 P3：创造模式（Φ 面板 / 配方 op 应用 / 相位直通）=====

check('三模式切换器：模式下拉进面板＋状态暴露＋切换跟随', () => {
  const harnessSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!harnessSrc.includes('graphHarnessModeBtn')) throw new Error('模式按钮未进面板');
  if (!harnessSrc.includes('window._harnessMode')) throw new Error('模式状态未暴露给发送链');
  if (!harnessSrc.includes('snapshot.user_recipes')) throw new Error('配方清单未随快照注入（结构化通道）');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('phase = lockedMode')) throw new Error('发送链未按锁定模式改写相位');
  if (!runSrc.includes('harnessPhase !== \'preset\' && !harnessSingleEvalId')) throw new Error('preset 未旁路目标解析');
  if (!runSrc.includes("harnessPhase !== 'preset'")) throw new Error('preset 未旁路空画布拦截');
  if (!runSrc.includes('create_recipe')) throw new Error('op 人话描述未覆盖配方三件套');
  // 沙箱行为断言：默认编辑；切答疑/创造后状态跟随；切回编辑恢复
  if (sandbox.window._harnessMode() !== 'edit') throw new Error('默认模式应为编辑');
  sandbox.window.chooseHarnessMode('chat');
  if (sandbox.window._harnessMode() !== 'chat') throw new Error('切答疑后应为 chat');
  sandbox.window.chooseHarnessMode('preset');
  if (sandbox.window._harnessMode() !== 'preset') throw new Error('切创造后应为 preset');
  sandbox.window.chooseHarnessMode('edit');
  if (sandbox.window._harnessMode() !== 'edit') throw new Error('切回后应为 edit');
  return true;
});

check('寒暄拦截退役＋答疑纯问答语义合成', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (runSrc.includes('_isHarnessCasualInstruction') || runSrc.includes('_harnessCasualReply')) {
    throw new Error('寒暄拦截未删净（isCasual 事故根源，2026-09-30 拍板删除）');
  }
  if (!runSrc.includes("harnessPhase === 'chat' || !canvasReady || _isHarnessPureQuestion(instruction)")) {
    throw new Error('答疑模式未合成纯问答语义（跳过焦点解析/空画布放行/pure_chat）');
  }
  return true;
});

check('配方库 op 应用（P3）：create/update/delete 落库＋配方实例建节点', () => {
  const prevRecipes = sandbox.window.setUserRecipes([]);
  try {
    // create_recipe：后端 normalize 过的 payload（带 recipe_id）
    sandbox.setUserRecipes([]);
    const createdRecipe = {
      id: 'recipe-hn-1', name: '考前速记', desc: '', builtin: false,
      base: { kind: 'module' }, appearance: { palette: 'teal', shape: 'is-round' },
      generate: { prompt: 'x', strict_output: '', followup_prompt: '', confused_prompt: '', retry_prompt: '', context_channel: 'workflow_context', model_role: 'agent', on_incomplete: { max_retries: 1 } },
      ports: { static: [{ label: '再测一道', drag_form: 'user' }] },
      content_kind: 'markdown', aggregation: 'ancestors', analysis_phase: false,
      createdAt: 1, updatedAt: 1,
    };
    sandbox.window._applyHarnessOpsForTest
      ? sandbox.window._applyHarnessOpsForTest([{ op: 'create_recipe', recipe: createdRecipe, reason: 'r' }])
      : (() => { throw new Error('测试出口缺失：_applyHarnessOpsForTest'); })();
    let list = sandbox.window.getUserRecipes();
    if (list.length !== 1 || list[0].name !== '考前速记') throw new Error('create_recipe 未落库');
    // update_recipe：同 id 整份替换
    sandbox.window._applyHarnessOpsForTest([{ op: 'update_recipe', recipe_id: 'recipe-hn-1', recipe: { ...createdRecipe, name: '考前速记·改' }, reason: 'r' }]);
    list = sandbox.window.getUserRecipes();
    if (list.length !== 1 || list[0].name !== '考前速记·改') throw new Error('update_recipe 未替换');
    // 配方实例 create_node（预览→应用同款 _newHarnessNode）
    const node = sandbox._newHarnessNode('hn-1', { kind: 'module', label: '考前速记·改', recipe_id: 'recipe-hn-1' }, { x: 0, y: 0 });
    if (!node.recipeId || !node.recipe || node.recipe.name !== '考前速记·改') throw new Error('配方实例节点缺内嵌快照：' + JSON.stringify({ rid: node.recipeId, has: !!node.recipe }));
    // delete_recipe
    sandbox.window._applyHarnessOpsForTest([{ op: 'delete_recipe', recipe_id: 'recipe-hn-1', reason: 'r' }]);
    if (sandbox.window.getUserRecipes().length !== 0) throw new Error('delete_recipe 未删净');
    return true;
  } finally {
    sandbox.window.setUserRecipes(prevRecipes || []);
  }
});
// ===== 节点配方 P3 用例结束 =====

// ===== Φ 基础修复（2026-09-30）：相位转换放宽 / 面板内会话切换器 / T51 让位正解 =====

// Φ 会话内存读取辅助（同步）：走 vm 词法作用域读 phiSessions，避开异步保存与并行用例的交错
function clonePhi(vm, sandbox, id) {
  const raw = vm.runInContext('JSON.stringify(phiSessions[' + JSON.stringify(id) + '] || null)', sandbox);
  return raw === null ? null : JSON.parse(raw);
}

check('Φ 相位转换放宽：三模式锁定时旧相位不得绕过（apply 例外）', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes("if (lockedMode !== 'edit' && phase !== 'apply') phase = lockedMode;")) {
    throw new Error('锁定模式未泛化到 chat——重试/重发路径仍可携带 expand/evaluate 绕过');
  }
  return true;
});

check('Φ 独立会话：菜单入口齐全＋解耦红线（Φ 菜单无任何删画布语义）', () => {
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes('graphHarnessSessionBtn')) throw new Error('标题旁会话按钮未进面板');
  if (!src.includes('graphHarnessSessionMenu')) throw new Error('会话下拉菜单未进面板');
  if (!src.includes('新建 Φ 会话')) throw new Error('菜单缺「新建 Φ 会话」入口');
  if (!src.includes('清空所有 Φ 对话')) throw new Error('菜单缺「清空所有 Φ 对话」入口');
  if (!src.includes('graph-harness-session-notice')) throw new Error('切换提示未实现');
  // 解耦红线（2026-09-30）：删画布入口只在左侧栏，Φ 菜单不得再有任何删画布委托/文案
  if (src.includes('window.deleteSession(') || src.includes('window.clearAllSessions()')) {
    throw new Error('Φ 菜单残留删画布委托（deleteSession/clearAllSessions）');
  }
  if (src.includes('清空所有画布') || src.includes('删除此画布')) throw new Error('Φ 菜单文案仍是删画布语义');
  // Φ 会话数据独立：phi_ id 空间 + 独立名单/当前指针键 + 绑定语义
  if (!src.includes('STORAGE_KEY_PHI_SESSIONS') || !src.includes('STORAGE_KEY_PHI_CURRENT')) {
    throw new Error('Φ 会话名单/当前指针未走 config.js 键');
  }
  if (!vm.runInContext('typeof _phiId === "function" && typeof _harnessBoundSid === "function"', sandbox)) {
    throw new Error('Φ 会话核心函数缺失');
  }
  return true;
});

check('Φ 会话生命周期：新建默认绑当前画布＋首条消息自动命名＋切换换会话', () => {
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  sandbox.window.getCurrentSessionId = () => 'sess_a';
  const newId = vm.runInContext('createPhiSession(true)', sandbox);
  if (!/^phi_/.test(String(newId))) throw new Error('Φ 会话 id 未用 phi_ 前缀：' + newId);
  const created = clonePhi(vm, sandbox, newId);
  if (!created || created.boundSid !== 'sess_a') throw new Error('新建 Φ 会话未默认绑定当前画布');
  // 首条用户消息自动命名（取前 12 字）——标题保存是同步的，读内存即可
  vm.runInContext('harnessHistory = []; _appendHarnessHistory({ id: "h1", role: "user", content: "什么是简谐运动？它的周期公式是什么", timestamp: 1 });', sandbox);
  const titled = clonePhi(vm, sandbox, newId);
  if (!titled || titled.title !== '什么是简谐运动？它的周期') throw new Error('首条消息未自动命名：' + (titled && titled.title));
  // 切换：currentPhiId 换新（对话重置走 resetHarnessSession）
  vm.runInContext('phiSessions["phi_x"] = { id: "phi_x", title: "Φ乙", boundSid: null, createdAt: 1, updatedAt: 1 };', sandbox);
  vm.runInContext('switchPhiSession("phi_x")', sandbox);
  if (vm.runInContext('currentPhiId', sandbox) !== 'phi_x') throw new Error('切换 Φ 会话未换 currentPhiId');
  return true;
});

check('Φ 会话删除/清空：只删 Φ 对话，画布键与 deleteSession 主路径零接触', () => {
  sandbox.window.confirm = () => true;
  let canvasDeleted = false, canvasCleared = false;
  sandbox.window.deleteSession = async () => { canvasDeleted = true; };
  sandbox.window.clearAllSessions = async () => { canvasCleared = true; };
  sandbox.window.getCurrentSessionId = () => 'sess_a';
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  // 造两个 Φ 会话（当前会话 phi_a 带历史键）
  vm.runInContext(`
    phiSessions = {
      phi_a: { id: 'phi_a', title: 'Φ甲', boundSid: 'sess_a', createdAt: 1, updatedAt: 1 },
      phi_b: { id: 'phi_b', title: 'Φ乙', boundSid: null, createdAt: 1, updatedAt: 2 },
    };
    currentPhiId = 'phi_a';
    localStorage.setItem('phymathia_harness_history_phi_a', '[]');
    localStorage.setItem('phymathia_harness_history_phi_b', '[]');
  `, sandbox);
  vm.runInContext('deleteHarnessSession("phi_b")', sandbox);
  if (canvasDeleted) throw new Error('删除 Φ 会话触发了画布删除主路径');
  // 清空全部 Φ 对话：画布完全保留（deleteSession/clearAllSessions 零调用），只剩新建的空白会话
  vm.runInContext('clearAllHarnessSessions()', sandbox);
  if (canvasDeleted || canvasCleared) throw new Error('清空 Φ 对话触发了画布删除/清空主路径');
  const ids = Object.keys(JSON.parse(vm.runInContext('localStorage.getItem("phymathia_phi_sessions")', sandbox)));
  if (ids.length !== 1) throw new Error('清空后应只剩自动新建的 1 个空白 Φ 会话：' + ids.length);
  if (vm.runInContext('localStorage.getItem("phymathia_harness_history_phi_a")', sandbox) !== null) {
    throw new Error('清空未删旧 Φ 会话的历史键');
  }
  if (vm.runInContext('currentPhiId', sandbox) !== ids[0]) throw new Error('清空后当前会话未切到新建会话');
  return true;
});

check('Φ 解耦接线：切画布不再重置 Φ 对话＋删画布只解绑＋改图绑定门槛', () => {
  const sessionSrc = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (sessionSrc.includes('window.resetHarnessSession()')) throw new Error('setCurrentSessionId 仍在重置 Φ 对话（解耦被回退）');
  if (!sessionSrc.includes('window.notifyHarnessCanvasChanged()')) throw new Error('切画布缺轻量刷新钩子');
  if (!sessionSrc.includes('window.phiCanvasDeleted(id)')) throw new Error('删画布未解绑 Φ 会话');
  if (!sessionSrc.includes('window.phiCanvasesCleared()')) throw new Error('清空画布未解绑 Φ 会话');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('canvasReady')) throw new Error('改图缺「绑定画布=当前画布」门槛（canvasReady）');
  if (!runSrc.includes('_emptyHarnessSnapshot()')) throw new Error('纯问答路径未改用空快照');
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes('phymathia_phi_migration_done')) throw new Error('缺旧数据一次性迁移标记');
  if (!src.includes('_migrateLegacyPhiHistory')) throw new Error('缺迁移函数');
  return true;
});

check('Φ 下拉菜单（会话/模式）：磨砂材质归 aurora-glass＋hidden 守卫＋specificity 手术', () => {
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes('class="graph-harness-session-menu aurora-glass"')) throw new Error('会话菜单未挂 aurora-glass（透明底压聊天记录）');
  if (!src.includes('class="graph-harness-mode-menu aurora-glass"')) throw new Error('模式菜单未挂 aurora-glass（透明底压输入区提示）');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!/\.graph-harness-window \.graph-harness-session-menu\[hidden\],\s*\n\s*\.graph-harness-window \.graph-harness-mode-menu\[hidden\]\s*\{\s*\n\s*display:\s*none;/.test(css)) {
    throw new Error('下拉菜单缺 [hidden]{display:none} 守卫（须带 .graph-harness-window 前缀抬到 (0,3,0)——模式菜单自身规则也是 (0,2,0)，同优先级源序在后会赢）');
  }
  // 标题栏 28px 图标钮规则 (0,2,1) 的特异性手术：选择器带 .graph-harness-window 前缀并回声 width
  const sessionBtnRule = css.match(/\.graph-harness-window \.graph-harness-head \.graph-harness-session-btn \{[\s\S]{0,600}?\}/);
  if (!sessionBtnRule || !sessionBtnRule[0].includes('width: auto')) throw new Error('会话按钮 specificity 手术缺失（被 28px 图标钮规则压成「i画i」）');
  const sessionItemRule = css.match(/\.graph-harness-window \.graph-harness-head \.graph-harness-session-item \{[\s\S]{0,600}?\}/);
  if (!sessionItemRule || !sessionItemRule[0].includes('width: auto')) throw new Error('会话菜单项 specificity 手术缺失（被压成一字宽竖条）');
  // 材质归 aurora-glass：菜单本体写 background 会盖掉极光层（同面板本体磨砂化分工）
  const sessionMenuCss = css.slice(css.indexOf('.graph-harness-session-menu {'), css.indexOf('.graph-harness-session-menu[hidden]'));
  if (sessionMenuCss.includes('background')) throw new Error('会话菜单本体写了 background——材质必须归 aurora-glass');
  const modeMenuCss = css.slice(css.indexOf('.graph-harness-composer .graph-harness-mode-menu {'), css.indexOf('.graph-harness-composer .graph-harness-mode-menu .graph-harness-mode-item'));
  if (modeMenuCss.includes('background')) throw new Error('模式菜单本体写了 background——材质必须归 aurora-glass');
  return true;
});

check('T51 桌宠让位正解：body.harness-open + 内联定位暂存归还', () => {
  const src = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!src.includes("classList.add('harness-open')")) throw new Error('开面板未挂 harness-open');
  if (!src.includes("classList.remove('harness-open')")) throw new Error('关面板未摘 harness-open');
  if (!src.includes('harnessPetDragBackup')) throw new Error('被拖拽内联定位未暂存归还');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!css.includes('body.harness-open .phi-pet-root')) throw new Error('CSS 未接 harness-open 选择器');
  if (!css.includes('body:has(> .graph-harness-window:not([hidden])) .phi-pet-root')) {
    throw new Error(':has() 兜网被移除——应保留双保险');
  }
  return true;
});
// ===== Φ 基础修复用例结束 =====


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
  if (strip('<think>先想想 {"op": "bad"}</think>\n{"summary": "s"}') !== '{"summary": "s"}') return false;
  // 未闭合块（max_tokens 截断）：从开标签截断
  if (strip('{"summary": "ok"} <think>被截断……') !== '{"summary": "ok"}') return false;
  // 纯文本不受影响
  if (strip('正常回答') !== '正常回答') return false;
  // 空值
  if (strip('') !== '') return false;
  return true;
});

// ===== Φ 评审路线第二档前端半边（T94/T95/T97/T82/T93，2026-09-30）=====

check('T94 大图自动降级：degrade 邻域收到 1 跳、无焦点保持原样', () => {
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getCurrentSessionId = () => 'sess_test';
  sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
  // 绑定画布读「当前 Φ 会话」：造一个绑到 sess_test 的会话（同上方快照用例手法）
  vm.runInContext('phiSessions = { phi_deg: { id: "phi_deg", title: "t", boundSid: "sess_test", createdAt: 1, updatedAt: 1 } }; currentPhiId = "phi_deg";', sandbox);
  // 60 节点链式大图（超过 40 节点阈值）
  const nodes = Array.from({ length: 60 }, (_, i) => ({
    id: 'd' + i, kind: 'knowledge', label: '节点' + i, content: '内容内容内容内容' + i,
  }));
  sandbox.window.getGraphViewNodes = () => nodes;
  sandbox.window.getGraphViewEdges = () => Array.from({ length: 59 }, (_, i) => ({ from: 'd' + i, to: 'd' + (i + 1) }));
  sandbox.window.getSelectedGraphNodeIds = () => [];
  const plain = sandbox.buildHarnessSnapshot(false, [], null);
  const noFocus = sandbox.buildHarnessSnapshot(false, [], null, null, { degrade: true });
  if (noFocus.snapshot_meta.directory_nodes !== 0) throw new Error('无焦点时 degrade 不应收缩（无焦点可缩）');
  if (noFocus.snapshot_meta.est_tokens !== plain.snapshot_meta.est_tokens) throw new Error('无焦点时 degrade 快照应与原样逐字节一致');
  const focused2 = sandbox.buildHarnessSnapshot(false, ['d0'], null);
  const focused1 = sandbox.buildHarnessSnapshot(false, ['d0'], null, null, { degrade: true });
  if (focused1.snapshot_meta.directory_nodes <= 0) throw new Error('有焦点时 degrade 应把外层节点压成目录行');
  if (focused1.snapshot_meta.directory_nodes <= focused2.snapshot_meta.directory_nodes) {
    throw new Error('degrade 邻域应比默认 2 跳更紧：1 跳 ' + focused1.snapshot_meta.directory_nodes + ' 目录行 vs 2 跳 ' + focused2.snapshot_meta.directory_nodes);
  }
  if (focused1.snapshot_meta.est_tokens >= plain.snapshot_meta.est_tokens) throw new Error('degrade 快照 est_tokens 应明显小于原快照');
  return true;
});

check('T94 三级降级接线：先重算 degrade、降不动才报错、无焦点报错文案不变', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('{ degrade: true }')) throw new Error('超预算未接 degrade 重算');
  if (!runSrc.includes('图较大，已自动聚焦到目标附近区域（可在画布选中节点缩小范围）')) throw new Error('缺降级成功提示文案');
  if (!runSrc.includes('（聚焦后仍过大）')) throw new Error('缺「降级后仍超限」兜底说明');
  if (!/est_tokens <= 30000/.test(runSrc)) throw new Error('降级后未回预算判定（≤30000 才采用）');
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!/const degrade = !!\(opts && opts\.degrade\)/.test(hSrc)) throw new Error('buildHarnessSnapshot 缺 opts.degrade 第 5 参');
  if (!hSrc.includes('degrade ? 1 : 2')) throw new Error('降级邻域半径未收到 1 跳');
  return true;
});

check('T95 401 醒目提示：通用文案（含密钥/模型配置）＋结果区错误卡片', () => {
  const human = sandbox._harnessErrorToHuman('上游 401 Unauthorized');
  if (!/密钥/.test(human)) throw new Error('401 文案未提密钥：' + human);
  if (!/模型配置/.test(human)) throw new Error('401 文案未给去「模型配置」的操作路径：' + human);
  if (/hy3 的密钥由服务端 .env 的 OPENCODE_GO_API_KEY 提供，请检查服务端配置/.test(human)) {
    throw new Error('401 文案仍是 hy3 专属旧版（hy3 系说明应只作补语）');
  }
  if (typeof sandbox._showHarnessErrorCard !== 'function') throw new Error('_showHarnessErrorCard 未暴露');
  // 宽松 DOM 下真调一次：确认函数体内 _escapeHtml/DOM 路径无 ReferenceError
  sandbox._showHarnessErrorCard('测试 <文本> & 转义');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('_showHarnessErrorCard(human)')) throw new Error('catch 未接错误卡片');
  if (!runSrc.includes('graph-harness-error">⛔ ')) throw new Error('错误卡片结构缺失（class 复用 .graph-harness-error）');
  return true;
});

check('T97 深度思考档位：四档循环回自动＋菜单行/Payload/存储键接线', () => {
  if (typeof sandbox._cycleHarnessThinking !== 'function' || typeof sandbox._harnessThinkingLevel !== 'function') {
    throw new Error('档位函数未暴露');
  }
  sandbox.localStorage.removeItem('phymathia_harness_thinking');
  if (sandbox._harnessThinkingLevel() !== '') throw new Error('默认档位应为自动（空值）');
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(sandbox._cycleHarnessThinking());
  if (seen.join(',') !== 'low,high,max,') throw new Error('四档循环不对：' + seen.join(','));
  if (sandbox._harnessThinkingLevel() !== '') throw new Error('循环一圈应回自动');
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!hSrc.includes('graphHarnessThinkingBtn')) throw new Error('模式菜单缺深度思考行');
  if (!/function cycleHarnessThinking\(event\) \{\s*\n\s*if \(event\) event\.stopPropagation\(\);/.test(hSrc)) {
    throw new Error('档位按钮未 stopPropagation（点一下会收起菜单）');
  }
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('thinking: _harnessThinkingLevel()')) throw new Error('payload 未带 thinking');
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("STORAGE_KEY_HARNESS_THINKING = 'phymathia_harness_thinking'")) throw new Error('存储键未走 config.js 常量表');
  return true;
});

check('T95 备用模型列表：排除当前＋限 2 条＋字段齐全＋hy3 端点纠正复用', () => {
  if (typeof sandbox._harnessFallbackModels !== 'function') throw new Error('_harnessFallbackModels 未暴露');
  const models = [
    { id: 'm1', provider: 'deepseek', model: 'deepseek-chat', apiKey: 'k1', baseUrl: 'https://api.deepseek.com' },
    { id: 'm2', provider: 'zhipu', model: 'glm-4', apiKey: 'k2', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
    { id: 'm3', provider: 'opencode', model: 'hy3', apiKey: '', baseUrl: 'https://opencode.ai/zen/v1' },
    { id: 'm4', provider: 'moonshot', model: 'kimi-k2', apiKey: 'k4', baseUrl: 'https://api.moonshot.cn/v1' },
  ];
  sandbox.localStorage.setItem('phymathia_user_models', JSON.stringify(models));
  const picked = sandbox._harnessFallbackModels(models[0]);
  if (picked.length !== 2) throw new Error('备用模型应限 2 条：' + picked.length);
  if (picked.some(m => m.model === 'deepseek-chat')) throw new Error('未排除当前模型');
  for (const m of picked) {
    for (const field of ['provider', 'api_key', 'model', 'base_url']) {
      if (typeof m[field] !== 'string') throw new Error('字段不全或非字符串：' + field + ' → ' + JSON.stringify(m));
    }
  }
  if (picked[1].provider !== 'opencode-go' || picked[1].base_url !== 'https://opencode.ai/zen/go/v1') {
    throw new Error('hy3 端点纠正未复用 _harnessModelForRequest：' + picked[1].provider + ' / ' + picked[1].base_url);
  }
  if (sandbox._harnessFallbackEnabled() !== false) throw new Error('兜底开关默认必须是关（拍板）');
  // 真走一次 toggle handler：开→关往返，状态落 phymathia_harness_fallback
  if (sandbox.toggleHarnessFallback() !== true) throw new Error('toggle 未打开开关');
  if (sandbox._harnessFallbackEnabled() !== true) throw new Error('打开状态未落 localStorage');
  if (sandbox.toggleHarnessFallback() !== false) throw new Error('toggle 未关闭开关');
  if (sandbox._harnessFallbackEnabled() !== false) throw new Error('关闭状态未落 localStorage');
  if (!fs.readFileSync('src/static/js/harness-run.js', 'utf8').includes('fallback_models: fallbackModels')) {
    throw new Error('payload 未接备用模型');
  }
  const hSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!hSrc.includes('graphHarnessFallbackBtn') || !hSrc.includes('toggleHarnessFallback(event)')) throw new Error('模式菜单缺兜底开关行');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!css.includes('.graph-harness-mode-toggle') || !css.includes('.graph-harness-mode-sep')) throw new Error('新增两行缺样式');
  return true;
});

check('T82 相位收敛：payload 只直通模式锁/显式入口，本地识别保留', () => {
  const f = sandbox._harnessPayloadPhase;
  if (typeof f !== 'function') throw new Error('_harnessPayloadPhase 未暴露');
  if (f('evaluate') !== 'normal') throw new Error('evaluate 本地猜测应降为 normal 交后端 _detect_phase 重判');
  if (f('normal') !== 'normal' || f('') !== 'normal' || f(undefined) !== 'normal') throw new Error('normal/空相位应保持 normal');
  if (f('preset') !== 'preset' || f('chat') !== 'chat') throw new Error('模式锁未直通');
  if (f('apply') !== 'apply' || f('expand') !== 'expand') throw new Error('显式入口未直通');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('phase: _harnessPayloadPhase(harnessPhase)')) throw new Error('payload.phase 未接收敛函数');
  // 本地 harnessPhase 的用途（快照 includeEval/UI 标签/历史 meta）全部保留
  if (!runSrc.includes("harnessPhase = requestedPhase === 'normal'")) throw new Error('本地相位识别被误删');
  if (!runSrc.includes("buildHarnessSnapshot(harnessPhase === 'evaluate'")) throw new Error('快照 includeEval 仍应吃本地相位');
  return true;
});

check('T93 多步循环：stage=model 且 step>0 也重置流式残文', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!runSrc.includes('Number(evt.step) > 0')) throw new Error('流式重置未覆盖多步循环（step>0）');
  if (!/evt\.stage === 'model' && \(Number\(evt\.attempt\) > 0 \|\| Number\(evt\.step\) > 0\)/.test(runSrc)) {
    throw new Error('重置条件形状不对（attempt||step 缺一不可）');
  }
  // 后端 stage:'tool' 的 status 事件走既有通用分支，无需新代码
  if (!runSrc.includes("evt.type === 'status' && evt.message")) throw new Error('status 通用分支被改动');
  return true;
});

check('T94 历史条数放宽：80 条只发最近 60（单条截断不动）', () => {
  vm.runInContext(`
    harnessHistory = Array.from({ length: 80 }, (_, i) => (
      i % 2 === 0
        ? { id: 'h' + i, role: 'user', content: 'c' + i, instruction: 'i' + i }
        : { id: 'h' + i, role: 'assistant', summary: 's' + i, operations: [] }
    ));
  `, sandbox);
  const built = sandbox._buildStructuredHarnessHistory();
  if (built.length !== 60) throw new Error('应只发最近 60 条：' + built.length);
  if (built[0].instruction !== 'i20') throw new Error('截取窗口不对（应丢最早 20 条）：' + built[0].instruction);
  if (built[built.length - 1].summary !== 's79') throw new Error('末条不是最新一条');
  vm.runInContext('harnessHistory = [];', sandbox);
  return true;
});


// ===== 右键菜单（graph-contextmenu.js，P1）静态/沙箱回归 =====

check('graph-contextmenu: open/close 沙箱冒烟（单例开关不抛错）', () => {
  if (typeof sandbox.openGraphContextMenu !== 'function') throw new Error('openGraphContextMenu 未暴露');
  if (typeof sandbox.closeGraphContextMenu !== 'function') throw new Error('closeGraphContextMenu 未暴露');
  // 宽松 DOM 下走完整弹层构建/定位/关闭路径（构建期只做描述与 DOM 代理操作）
  sandbox.openGraphContextMenu({ clientX: 12, clientY: 12, target: { closest: () => null } });
  sandbox.openGraphContextMenu({ clientX: 20, clientY: 20, target: { closest: () => null } }); // 开新先关旧
  // 节点目标分支（M2：多选判定 + 标题 + 目标高亮路径，沙箱 graphInner 为 null 须容忍）
  const realFind = sandbox._findGraphNode;
  try {
    sandbox._findGraphNode = () => ({ id: 'n1', kind: 'blank', content: 'x' });
    sandbox.openGraphContextMenu({
      clientX: 30, clientY: 30,
      target: { closest: (sel) => (sel === '.graph-node' ? { dataset: { nodeId: 'n1' } } : null) },
    });
  } finally {
    sandbox._findGraphNode = realFind;
  }
  sandbox.closeGraphContextMenu();
  sandbox.closeGraphContextMenu(); // 重复关闭必须幂等（监听清理路径不抛错）
  return true;
});

check('graph-contextmenu: 目标三分支分类（node/link/canvas）', () => {
  const kindOf = (t) => sandbox._graphContextTargetKind(t);
  if (kindOf(null) !== 'canvas') return false;
  if (kindOf({ closest: () => null }) !== 'canvas') return false;
  if (kindOf({ closest: (sel) => (sel.indexOf('.graph-edge-link') === 0 ? {} : null) }) !== 'link') return false;
  const realFind = sandbox._findGraphNode;
  try {
    sandbox._findGraphNode = () => ({ id: 'n1', kind: 'blank' });
    if (kindOf({ closest: (sel) => (sel === '.graph-node' ? { dataset: { nodeId: 'n1' } } : null) }) !== 'node') return false;
    sandbox._findGraphNode = () => null; // 空态「新问题」卡等查不到数据 → 画布菜单
    if (kindOf({ closest: (sel) => (sel === '.graph-node' ? { dataset: { nodeId: 'ghost' } } : null) }) !== 'canvas') return false;
  } finally {
    sandbox._findGraphNode = realFind;
  }
  return true;
});

check('graph-contextmenu: 节点菜单按 kind 裁剪（端口/折叠/删除白名单 + M2 居中/复制节点）', () => {
  const keysFor = (node) => sandbox._graphContextItemsForNode(node).map(i => i.key);
  // draft：无收藏/折叠/端口/复制节点，有居中与删除
  const draft = keysFor({ id: 'd1', kind: 'draft' });
  if (draft.includes('bookmark') || draft.includes('minimize')) return false;
  if (draft.includes('add-input-port') || draft.includes('add-output-port')) return false;
  if (draft.includes('duplicate')) return false;
  if (!draft.includes('delete') || !draft.includes('focus')) return false;
  // source：有输出端口、无输入端口
  const source = keysFor({ id: 's1', kind: 'source', items: [{}] });
  if (!source.includes('add-output-port') || source.includes('add-input-port')) return false;
  if (!source.includes('focus')) return false;
  // hub：有输入端口、无输出端口
  const hub = keysFor({ id: 'h1', kind: 'hub' });
  if (!hub.includes('add-input-port') || hub.includes('add-output-port')) return false;
  // module（白名单键 physics）：输入/输出端口都有；折叠项按 minimized 切换文案（M2 标签统一）
  const folded = sandbox._graphContextItemsForNode({ id: 'm1', kind: 'module', moduleKey: 'physics', messageIndex: -1, minimized: true, content: '内容' });
  const mini = folded.find(i => i.key === 'minimize');
  if (!mini || mini.label !== '展开节点') return false;
  if (!folded.some(i => i.key === 'add-input-port') || !folded.some(i => i.key === 'add-output-port')) return false;
  // 有内容的 module：居中/复制节点齐备（M2 新增两项）
  if (!folded.some(i => i.key === 'focus') || !folded.some(i => i.key === 'duplicate')) return false;
  const expanded = sandbox._graphContextItemsForNode({ id: 'm2', kind: 'module', moduleKey: 'math', messageIndex: -1, content: '内容' });
  const mini2 = expanded.find(i => i.key === 'minimize');
  if (!mini2 || mini2.label !== '折叠节点') return false;
  return true;
});

check('graph-contextmenu: 收藏为知识点走书签弹窗预填（复用 saveBookmark 持久化路径）', () => {
  const items = sandbox._graphContextItemsForNode({
    id: 'a1', kind: 'module', moduleKey: 'math', messageIndex: -1,
    content: '傅里叶变换 <formula>\\int f(x)e^{i\\omega x}\\,dx</formula>',
  });
  const bm = items.find(i => i.key === 'bookmark');
  if (!bm) throw new Error('module 节点应有收藏项');
  bm.run(); // 沙箱宽松 DOM 下执行预填，不应抛错
  const copy = items.find(i => i.key === 'copy');
  if (!copy) return false;
  copy.run(); // 复制全文走 navigator.clipboard.writeText（沙箱已有桩），不应抛错
  return true;
});

check('graph-contextmenu: 画布菜单项齐备且「粘贴为节点」受剪贴板能力门控（M2 补三项）', () => {
  const keys = sandbox._graphContextItemsForCanvas().map(i => i.key);
  // 既有七 key 不回退 + M2 新增：新建分组 / 缩放复位 / 全选节点
  for (const k of ['add-node', 'paste-node', 'fit', 'zoom-reset', 'arrange', 'create-group', 'select-all', 'export', 'undo', 'redo']) {
    if (!keys.includes(k)) return false;
  }
  const paste0 = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-node');
  if (paste0.disabled !== true) return false; // 沙箱 navigator.clipboard 无 readText → 禁用
  sandbox.navigator.clipboard.readText = async () => 'E = mc^2';
  const paste1 = sandbox._graphContextItemsForCanvas().find(i => i.key === 'paste-node');
  const ok = paste1.disabled === false;
  delete sandbox.navigator.clipboard.readText;
  return ok;
});

check('graph-contextmenu: 撤销/重做禁用态三态（栈空 / 栈顶属当前会话 / 栈顶跨会话）', () => {
  // graphUndoStack/graphRedoStack 是打包产物顶层 let（非全局对象属性），
  // 只能经 vm.runInContext 改同一上下文的词法绑定；当前会话经 window.getCurrentSessionId 桩
  sandbox.window.getCurrentSessionId = () => 'sess_ctx';
  const itemOf = (key) => sandbox._graphContextItemsForCanvas().find(i => i.key === key);
  // 1) 栈空：禁用 + title 提示（M2 交付范围 1）
  vm.runInContext('graphUndoStack = []; graphRedoStack = [];', sandbox);
  let undo = itemOf('undo');
  let redo = itemOf('redo');
  if (undo.disabled !== true || undo.title !== '没有可撤销的操作') return false;
  if (redo.disabled !== true || redo.title !== '没有可重做的操作') return false;
  // 2) 栈顶属当前会话：可用
  vm.runInContext("graphUndoStack = [{ sessionId: 'sess_ctx', state: {} }]; graphRedoStack = [{ sessionId: 'sess_ctx', state: {} }];", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled === true || redo.disabled === true) return false;
  // 3) 栈非空但栈顶属其他会话：同样禁用（会话一致性守卫，对齐 _undoGraphAction 的 no-op 条件）
  vm.runInContext("graphUndoStack = [{ sessionId: 'sess_other', state: {} }]; graphRedoStack = [{ sessionId: 'sess_other', state: {} }];", sandbox);
  undo = itemOf('undo'); redo = itemOf('redo');
  if (undo.disabled !== true || redo.disabled !== true) return false;
  // 4) 刚启动/刚切换会话：内存栈为空（或属旧会话）但 localStorage 已有本会话历史——
  //    判读前须先按当前会话同步撤销栈（_undoGraphAction 首行 _ensureGraphHistory 同步），
  //    否则 Ctrl+Z 实际可撤销而菜单误禁用（审查修复回归）
  storageData['phymathia_graph_history_sess_ctx'] = JSON.stringify([
    { sessionId: 'sess_ctx', state: { customNodes: [] }, meta: null },
  ]);
  vm.runInContext("graphHistorySession = 'sess_stale'; graphUndoStack = []; graphRedoStack = [];", sandbox);
  undo = itemOf('undo');
  if (undo.disabled === true) return false; // 须装载持久化历史后判可用
  delete storageData['phymathia_graph_history_sess_ctx'];
  vm.runInContext('graphUndoStack = []; graphRedoStack = [];', sandbox);
  return true;
});

check('graph-contextmenu: 多选感知（已选 N 语境：删除选择集 / 折叠集语义 / 单目标项隐藏）', () => {
  const realFind = sandbox._findGraphNode;
  const realToggle = sandbox._toggleGraphNodeMinimize;
  try {
    const nodes = [
      { id: 'n_a', kind: 'module', moduleKey: 'physics', messageIndex: -1, content: '甲内容' },
      { id: 'n_b', kind: 'blank', messageIndex: -1, content: '乙内容' },
    ];
    sandbox._findGraphNode = (id) => nodes.find(n => n.id === id) || null;
    // 多选语境：目标 ∈ 选择集且 size > 1
    vm.runInContext('graphView.selectedNodeIds = new Set(["n_a", "n_b"])', sandbox);
    if (typeof sandbox._graphCtxMultiSelection !== 'function') throw new Error('_graphCtxMultiSelection 未暴露');
    if (sandbox._graphCtxMultiSelection(nodes[0]).length !== 2) return false;
    const items = sandbox._graphContextItemsForNode(nodes[0]);
    const keys = items.map(i => i.key);
    if (!keys.includes('minimize') || !keys.includes('delete')) return false;
    // 单目标项在多选语境隐藏（收藏/复制全文/居中/复制节点/端口）
    for (const k of ['bookmark', 'copy', 'focus', 'duplicate', 'add-input-port', 'add-output-port']) {
      if (keys.includes(k)) return false;
    }
    const del = items.find(i => i.key === 'delete');
    if (del.label !== '删除 2 个节点' || del.danger !== true) return false;
    // 折叠/展开作用于整个选择集：混合状态统一方向（任一未折叠 → 全部折叠，已折叠的跳过）
    let toggled = [];
    sandbox._toggleGraphNodeMinimize = (n) => { toggled.push(n.id); };
    const mini = items.find(i => i.key === 'minimize');
    if (mini.label !== '折叠节点') return false;
    mini.run();
    if (toggled.length !== 2 || !toggled.includes('n_a') || !toggled.includes('n_b')) return false;
    nodes[1].minimized = true; // 混合状态：只切换未折叠的 n_a
    toggled = [];
    mini.run();
    if (toggled.length !== 1 || toggled[0] !== 'n_a') return false;
    // 全部已折叠：label 翻转为「展开节点」，动作只作用于已折叠节点
    nodes[0].minimized = true;
    const items2 = sandbox._graphContextItemsForNode(nodes[0]);
    const mini2 = items2.find(i => i.key === 'minimize');
    if (mini2.label !== '展开节点') return false;
    toggled = [];
    mini2.run();
    if (toggled.length !== 2) return false;
    // 删除项作用于菜单打开时捕获的选择集（审查修复回归）：菜单存活期间 renderGraphCanvas
    // 重渲会清空 selectedNodeIds，届时读活选择集 = 点「删除 N 个节点」却一个都删不掉
    const realDelete = sandbox._deleteSelectedGraphNodes;
    let deletedIds = null;
    try {
      sandbox._deleteSelectedGraphNodes = (ids) => { deletedIds = ids; };
      vm.runInContext('graphView.selectedNodeIds = new Set(["n_a", "n_b"])', sandbox);
      const itemsDel = sandbox._graphContextItemsForNode(nodes[0]);
      vm.runInContext('graphView.selectedNodeIds = new Set()', sandbox); // 模拟重渲清空选择
      itemsDel.find(i => i.key === 'delete').run();
      if (!Array.isArray(deletedIds) || deletedIds.join(',') !== 'n_a,n_b') return false;
    } finally {
      sandbox._deleteSelectedGraphNodes = realDelete;
    }
    // 选择集含查不到数据的节点（空态卡）：退回单目标语境
    vm.runInContext('graphView.selectedNodeIds = new Set(["n_a", "ghost"])', sandbox);
    if (sandbox._graphCtxMultiSelection(nodes[0]) !== null) return false;
    // 未选中 / 单选语境：行为与现状完全一致（收藏/复制/居中/复制节点/端口齐备）
    vm.runInContext('graphView.selectedNodeIds = new Set(["n_a"])', sandbox);
    const single = sandbox._graphContextItemsForNode(nodes[0]).map(i => i.key);
    for (const k of ['bookmark', 'copy', 'focus', 'duplicate', 'add-input-port', 'add-output-port', 'delete']) {
      if (!single.includes(k)) return false;
    }
    vm.runInContext('graphView.selectedNodeIds = new Set()', sandbox);
    const none = sandbox._graphContextItemsForNode(nodes[0]).map(i => i.key);
    if (!none.includes('bookmark') || !none.includes('focus')) return false;
    return true;
  } finally {
    sandbox._findGraphNode = realFind;
    sandbox._toggleGraphNodeMinimize = realToggle;
    vm.runInContext('graphView.selectedNodeIds = new Set()', sandbox);
  }
});

check('graph-contextmenu: 联系线菜单三动作齐备（M1：编辑联系/曲线精调/删除联系）', () => {
  if (typeof sandbox._graphContextItemsForLink !== 'function') throw new Error('_graphContextItemsForLink 未暴露');
  if (typeof sandbox._graphCtxLinkFromTarget !== 'function') throw new Error('_graphCtxLinkFromTarget 未暴露');
  if (typeof sandbox._graphCtxLinkTitle !== 'function') throw new Error('_graphCtxLinkTitle 未暴露');
  const edge = { from: 'n1', fromPort: 'out-0', to: 'n2', toPort: 'in-0', link: true, relation: '都描述局部变化率' };
  const items = sandbox._graphContextItemsForLink(edge);
  const keys = items.map(i => i.key);
  for (const k of ['edit-link', 'curve-edit', 'delete-link']) {
    if (!keys.includes(k)) throw new Error('联系线菜单缺 key: ' + k);
  }
  // 三项 label 全部锁定（审查补强：edit-link 带省略号，与「新建节点…」等弹窗类菜单项同风格）
  const edit = items.find(i => i.key === 'edit-link');
  if (edit.label !== '编辑联系…') return false;
  // 删除项 danger；曲线精调默认分支文案（沙箱 graphView.edgeCurveEditKey 为空）
  const del = items.find(i => i.key === 'delete-link');
  if (del.danger !== true || del.label !== '删除联系') return false;
  const curve = items.find(i => i.key === 'curve-edit');
  if (curve.label !== '曲线精调') return false;
  // 编辑联系/曲线精调的动作在空图沙箱下安全 no-op（openLinkEdgeModal/enterLinkCurveEdit
  // 查不到边数据即返回）；删除联系会走真实 _pushGraphUndo/renderGraphCanvas 链路，不做沙箱执行
  items.forEach(i => { if (i.key === 'edit-link' || i.key === 'curve-edit') i.run(); });
  // 空/坏输入守卫
  if (sandbox._graphContextItemsForLink(null).length !== 0) return false;
  // 标题：label 截断 24 字 + 无 label 兜底「联系线」
  if (sandbox._graphCtxLinkTitle(edge) !== '都描述局部变化率') return false;
  if (sandbox._graphCtxLinkTitle({ link: true }) !== '联系线') return false;
  if (sandbox._graphCtxLinkTitle({ link: true, label: '很'.repeat(30) }).length !== 24) return false;
  // 边定位：data-edge-key 解析 + 查不到边数据返回 null（静默回落口径）
  if (sandbox._graphCtxLinkFromTarget({ closest: () => null }) !== null) return false;
  const ghost = sandbox._graphCtxLinkFromTarget({ closest: () => ({ dataset: { edgeKey: 'ghost:out-0->nobody:in-0' } }) });
  if (ghost !== null) return false;
  return true;
});

check('graph-contextmenu: 联系线菜单接线静态断言（data-edge-key 定位 + 编辑态互斥 + 双击检测按按键细化）', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  // openGraphContextMenu 接入 link 分支：查不到边数据静默回落 + 三动作 + 删除 danger
  if (!src.includes("if (kind === 'link' && !_graphCtxLinkFromTarget(target)) return;")) {
    throw new Error('openGraphContextMenu 缺联系线边数据回落守卫');
  }
  if (!src.includes('danger: true,\n    run: () => { if (typeof deleteLinkEdge')) {
    throw new Error('删除联系项缺 danger 标记或动作接线');
  }
  // 曲线精调编辑态互斥：已在编辑态的同一条线改呈「退出精调」（enterLinkCurveEdit 对此是 no-op）
  if (!src.includes('graphView.edgeCurveEditKey === edgeKey') || !src.includes("label: '退出精调'")) {
    throw new Error('曲线精调缺编辑态互斥分支');
  }
  if (!code.includes('_graphContextItemsForLink')) throw new Error('打包产物缺 _graphContextItemsForLink');
  // M1 双击检测按按键细化：graph-custom.js 的 document 捕获 pointerdown 入口必须先按
  // button 过滤，才轮到手柄拖拽与 450ms 双击检测（右键按压不计入，快速右双击不再误开弹窗）
  const gc = fs.readFileSync('src/static/js/graph-custom.js', 'utf8');
  const pd = gc.indexOf("document.addEventListener('pointerdown'");
  if (pd < 0) throw new Error('graph-custom.js document 捕获 pointerdown 未找到');
  const head = gc.slice(pd, pd + 800);
  const filterAt = head.indexOf('if (event.button !== 0) return;');
  if (filterAt < 0) throw new Error('双击检测入口缺 event.button 过滤');
  const detectAt = head.indexOf('_lastLinkEdgePress');
  const handleAt = head.indexOf(".graph-edge-handle, .graph-curve-knob-hit");
  if (detectAt >= 0 && detectAt < filterAt) throw new Error('button 过滤晚于双击检测');
  if (handleAt >= 0 && handleAt < filterAt) throw new Error('button 过滤晚于手柄拖拽');
  return true;
});

check('graph-contextmenu: 画布事件接线（pointerdown 右键过滤 + contextmenu 三分支放行）', () => {
  const wf = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  // 防冲突（P1 核心修复回归）：pointerdown 处理器入口必须先按 button 过滤，
  // 才轮到 _startCanvasPan/_startNodeDrag/_startGroupDrag 等手势入口
  const pd = wf.indexOf("graphCanvas.addEventListener('pointerdown'");
  if (pd < 0) throw new Error('pointerdown 监听未找到');
  const head = wf.slice(pd, pd + 700);
  const filterAt = head.indexOf('if (e.button !== 0) return;');
  if (filterAt < 0) throw new Error('pointerdown 入口缺 e.button 过滤（右键会误入拖拽）');
  const firstGesture = head.search(/_startCanvasPan\(|_startNodeDrag\(|_startGroupDrag\(/);
  if (firstGesture >= 0 && firstGesture < filterAt) throw new Error('button 过滤晚于手势入口');
  // 三分支放行后 preventDefault + openGraphContextMenu
  const cm = wf.indexOf("graphCanvas.addEventListener('contextmenu'");
  if (cm < 0) throw new Error('contextmenu 监听未找到');
  const body = wf.slice(cm, cm + 900);
  for (const frag of [
    "closest('input, textarea, [contenteditable], iframe')",
    'graphView.selectMode', 'graphView.moved', 'e.preventDefault()', 'openGraphContextMenu(e)',
  ]) {
    if (!body.includes(frag)) throw new Error('contextmenu 三分支接线缺: ' + frag);
  }
  return true;
});

check('graph-contextmenu: M2 语义补强接线（新增项 / 高亮 / 导出锚点 / 多选标题 / 复制落点）静态+行为断言', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  // 节点菜单新增两项：居中此节点（focusGraphNodeById）/ 复制节点（复用 _graphCtxCreateBlankNodeWithText）
  if (!src.includes("focusGraphNodeById(node.id)")) throw new Error('居中此节点缺 focusGraphNodeById 接线');
  if (!src.includes('function _graphCtxDuplicateNode') || !src.includes('_graphCtxCreateBlankNodeWithText(')) {
    throw new Error('复制节点未复用 _graphCtxCreateBlankNodeWithText 链路');
  }
  // 复制节点落点：原节点旁 +24/+24，内容为 _nodeStoredContent 同源文本（行为断言）
  const realCreate = sandbox._graphCtxCreateBlankNodeWithText;
  let captured = null;
  try {
    sandbox._graphCtxCreateBlankNodeWithText = (pt, text) => { captured = { pt, text }; };
    sandbox._graphCtxDuplicateNode({ id: 'n1', x: 100, y: 50 }, '节点内容');
    if (!captured || captured.pt.x !== 124 || captured.pt.y !== 74) {
      throw new Error('复制节点落点不是原节点旁 +24/+24: ' + JSON.stringify(captured && captured.pt));
    }
    if (captured.text !== '节点内容') throw new Error('复制节点内容未透传');
  } finally {
    sandbox._graphCtxCreateBlankNodeWithText = realCreate;
  }
  // 多选标题 + 目标高亮 + 关联生命周期
  if (!src.includes("'已选 ' + multi.length + ' 个节点'")) throw new Error('多选标题缺失');
  if (!src.includes("el.classList.add('graph-ctx-target')") || !src.includes("el.classList.remove('graph-ctx-target')")) {
    throw new Error('.graph-ctx-target 高亮加/除不配平');
  }
  if (!src.includes('_graphCtxUnmarkTarget();')) throw new Error('关闭菜单未移除目标高亮');
  // 撤销/重做禁用态走 _graphCtxHistoryUsable（栈顶判空 + 跨会话守卫）
  if (!src.includes('function _graphCtxHistoryUsable')) throw new Error('_graphCtxHistoryUsable 缺失');
  if (src.indexOf("key: 'fit'") > src.indexOf("key: 'zoom-reset'") || src.indexOf("key: 'zoom-reset'") > src.indexOf("key: 'arrange'")) {
    throw new Error('缩放复位未放在「适配画布」旁');
  }
  if (src.indexOf("key: 'arrange'") > src.indexOf("key: 'create-group'") || src.indexOf("key: 'create-group'") > src.indexOf("key: 'select-all'")) {
    throw new Error('新建分组/全选节点插入位置不对（应在自动整理之后）');
  }
  // 导出锚点：右键菜单传当时光标坐标；无坐标时保持无参现状
  if (!src.includes('window.toggleGraphExportMenu(client ? { x: client.x, y: client.y } : undefined);')) {
    throw new Error('导出项未传锚点坐标');
  }
  // 导出菜单锚点实现：可选参数 + 视口钳制 + 画布局部坐标换算 + 清 right/bottom
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!ge.includes('function toggleGraphExportMenu(anchor)')) throw new Error('toggleGraphExportMenu 缺锚点参数');
  if (!ge.includes('if (anchor && isFinite(anchor.x) && isFinite(anchor.y))')) throw new Error('锚点分支缺失');
  if (!ge.includes('graphCanvas.getBoundingClientRect()')) throw new Error('锚点未换算画布局部坐标');
  if (!ge.includes("menu.style.right = 'auto';") || !ge.includes("menu.style.bottom = 'auto';")) {
    throw new Error('锚点模式未清除 CSS 的 right/bottom 定位');
  }
  // 高亮样式落位 + 打包产物符号
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.graph-node.graph-ctx-target')) throw new Error('styles-panels.css 缺 .graph-ctx-target');
  for (const sym of ['_graphCtxMultiSelection', '_graphContextItemsForMultiNodes', '_graphCtxHistoryUsable', '_graphCtxMarkTarget', '_graphCtxUnmarkTarget']) {
    if (!code.includes(sym)) throw new Error('打包产物缺符号: ' + sym);
  }
  if (!code.includes('graph-ctx-target')) throw new Error('打包产物缺 graph-ctx-target');
  return true;
});

check('graph-export: 一页概览图（完整内容模式已按用户要求移除）+ 画框纯函数', () => {
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  // 「完整内容」整条链路必须干净移除（长内容交给 .pmu 快照，PNG 回到"按屏幕所见"）
  for (const gone of ['_fullContent', 'full-content', '_expandCloneFullContent', '_measureExpandedClone',
                      '_previewExpandedBounds', 'graphExportFullContent']) {
    if (ge.includes(gone)) throw new Error('完整内容模式残留：' + gone);
  }
  // 菜单仍要有 Utopia 快照入口（PNG 的替代出口）
  if (!ge.includes('graphExportUtopia')) throw new Error('导出菜单缺 Utopia 快照入口');
  // 纯函数：包围盒并集
  const union = sandbox.window.graphExportDebug && sandbox.window.graphExportDebug.unionRects;
  if (typeof union !== 'function') throw new Error('unionRects 未暴露');
  const r = union([{ x: 0, y: 0, w: 100, h: 50 }, { x: 200, y: 30, w: 100, h: 500 }]);
  if (r.w !== 300 || r.h !== 530) throw new Error('包围盒并集错误：' + JSON.stringify(r));
  if (union([{ x: NaN, y: 0, w: 10, h: 10 }]) !== null) throw new Error('非法矩形应被忽略');
  return true;
});

check('graph-poster: 缩略知识海报纯函数（纯文本/标题摘要/断行/锚点/布局过滤）', () => {
  const dbg = sandbox.window.graphPosterDebug;
  if (!dbg || typeof dbg.layout !== 'function') throw new Error('graphPosterDebug 未暴露');
  // 纯文本：代码块按语言给占位说明、模块标签/井号/星号剥除、$ 定界符剥壳
  const plain = dbg.plainText('<physics>## 动量守恒\n$mv=MV$ 与 **碰撞**</physics>\n```html\n<div/>\n```');
  if (plain.includes('$') || plain.includes('#') || plain.includes('```') || plain.includes('*')) {
    throw new Error('纯文本仍带标记：' + plain);
  }
  if (!plain.includes('动量守恒') || !plain.includes('mv=MV') || !plain.includes('交互可视化')) {
    throw new Error('纯文本丢内容：' + plain);
  }
  // 标题摘要：首行为题、截断余量并入摘要（整段无换行文本不许被标题吃光）、more 记原始长度
  const ts = dbg.titleSummary('第一行标题很长\n第二行内容继续\n第三行', 6, 10);
  if (ts.title !== '第一行标题…') throw new Error('标题截断错误：' + ts.title);
  if (!ts.summary.endsWith('…') || ts.summary.length !== 10) throw new Error('摘要截断错误：' + ts.summary);
  if (!ts.summary.startsWith('很长')) throw new Error('标题截断余量应并入摘要：' + ts.summary);
  if (ts.more !== 14) throw new Error('more 应记原始长度 14：' + ts.more);
  // 单行整段（AI 摘要的真实形态）：标题吃前 26 字，摘要是余下内容而非空
  const ts2 = dbg.titleSummary('单摆在小角度时回复力是线性的因此做简谐运动而且周期与摆幅无关这就是等时性', 26, 40);
  if (!ts2.title.endsWith('…')) throw new Error('长单行应有省略号：' + ts2.title);
  if (!ts2.summary) throw new Error('单行整段文本的摘要不能为空（被标题吃光）');
  // LaTeX 轻转换：常见命令转可读符号，不是源码
  const lt = dbg.plainText('周期 $T = 2\\pi\\sqrt{L/g}$ 与 $\\ddot{\\theta} + \\omega\\theta$');
  if (lt.includes('\\pi') || lt.includes('\\theta') || lt.includes('\\sqrt') || lt.includes('\\ddot')) {
    throw new Error('LaTeX 源码未转换：' + lt);
  }
  if (!lt.includes('π') || !lt.includes('θ') || !lt.includes('√')) throw new Error('希腊字母/根号缺失：' + lt);
  // 嵌套 \frac（\lambda 在参数里还有 {}）也必须转——定点迭代
  const lt2 = dbg.plainText('$P(X=k)=\\frac{\\lambda^k e^{-\\lambda}}{k!}$');
  if (lt2.includes('\\frac') || lt2.includes('\\lambda')) throw new Error('嵌套 frac 未转换：' + lt2);
  if (!lt2.includes('λ') || !lt2.includes('/(k!)')) throw new Error('嵌套 frac 应转 (…)/(k!)：' + lt2);
  // mermaid 代码块：提取节点文本当摘要（知识图谱卡显示概念词，不是占位词）
  const mm = dbg.plainText('```mermaid\ngraph TD\nA[泊松分布] --> B[稀疏事件]\nB --> C[计数分布]\n```');
  if (!mm.includes('泊松分布') || !mm.includes('稀疏事件') || mm.includes('graph TD')) {
    throw new Error('mermaid 节点文本未提取：' + mm);
  }
  // 断行：等宽假 measure（每字符 10px），50px 预算 → 每行 5 字符，两行封顶加省略
  const lines = dbg.wrapLines((t) => t.length * 10, 'aaa bbb ccc', 50, 2);
  if (lines.length !== 2 || !lines[1].endsWith('…')) throw new Error('断行错误：' + JSON.stringify(lines));
  // 矩形锚点：右向射线交右边界、上向射线交上边界
  let p = dbg.rectAnchor(0, 0, 100, 50, 200, 0);
  if (Math.abs(p.x - 50) > 0.01 || Math.abs(p.y) > 0.01) throw new Error('右边界锚点错误：' + JSON.stringify(p));
  p = dbg.rectAnchor(0, 0, 100, 50, 0, -100);
  if (Math.abs(p.x) > 0.01 || Math.abs(p.y + 25) > 0.01) throw new Error('上边界锚点错误：' + JSON.stringify(p));
  // 布局：分层紧凑网格——draft/hidden 节点滤除、其边一并滤除；下游节点落在更深层；
  // 卡高按内容自适应（有摘要的卡更高）；标题剥「物理视角：」重复前缀；
  // 手工 answer 节点内容在 analysis 字段也要取到（_nodeContent 不看它，实测踩过）
  const layout = dbg.layout({
    nodes: [
      { id: 'a', kind: 'user', isRoot: true, x: 0, y: 0, w: 260, h: 140, messageIndex: 0 },
      { id: 'b', kind: 'module', moduleKey: 'physics', x: 500, y: 0, w: 260, h: 140,
        content: '物理视角：单摆的回复力与摆幅正弦近似成正比，小角度下为线性回复力，因此做简谐运动，周期与摆幅无关这就是等时性。' },
      { id: 'd', kind: 'draft', x: 250, y: 0, w: 260, h: 140, label: '草稿' },
      { id: 'h', kind: 'user', hidden: true, x: -500, y: -500, w: 260, h: 140, label: '隐藏' },
      { id: 'an', kind: 'answer', x: 250, y: 300, w: 260, h: 140, messageIndex: -1,
        analysis: 'AI 回答正文在 analysis 字段（非 manual 生成节点的实际存储位置），海报必须取到。' },
    ],
    edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'an' }, { from: 'a', to: 'd' }, { from: 'a', to: 'h' }],
    groups: [
      { x: -50, y: -50, width: 700, height: 300, name: '组', color: '#38bdf8', nodeIds: ['a', 'b'] },
      { x: 0, y: 0, width: 100, height: 100, name: '空组', nodeIds: ['d'] },
    ],
  });
  if (!layout) throw new Error('布局返回空');
  if (layout.cards.length !== 3) throw new Error('draft/hidden 节点应被滤除：' + layout.cards.length);
  if (layout.edges.length !== 2) throw new Error('指向已滤除节点的边应被滤除：' + layout.edges.length);
  if (layout.groups.length !== 1) throw new Error('无成员分组应被丢弃：' + layout.groups.length);
  const cardA = layout.cards.find((c) => c.id === 'a');
  const cardB = layout.cards.find((c) => c.id === 'b');
  const cardAn = layout.cards.find((c) => c.id === 'an');
  if (cardB.attrLabel !== '物理视角') throw new Error('模块节点属性标签错误：' + cardB.attrLabel);
  if (!cardB.title.startsWith('单摆的回复力')) throw new Error('标题应剥「物理视角：」前缀取正文首句：' + cardB.title);
  if (!cardB.summary) throw new Error('模块卡摘要不应为空');
  if (!(cardB.w >= 240 && cardB.w <= 300)) throw new Error('分层网格卡宽应统一：' + cardB.w);
  if (!(cardA.cy < cardB.cy && cardA.cy < cardAn.cy)) throw new Error('下游节点应在更深层（cy 递增）');
  if (!(cardB.h > cardA.h)) throw new Error('有摘要的卡应更高（自适应）：' + cardB.h + ' vs ' + cardA.h);
  if (!cardAn.summary) {
    throw new Error('analysis 字段取文回退失败（摘要为空）：' + cardAn.title);
  }
  // a 行只有一张卡应居中
  if (Math.abs(cardA.cx - layout.width / 2) > 1) throw new Error('单卡行应水平居中：' + cardA.cx);
  // 同层同行：两者共享同一行 y（顶对齐）、按原画布 x 排序、内容多者更高
  const layout2 = dbg.layout({
    nodes: [
      { id: 'a', kind: 'user', isRoot: true, x: 0, y: 0, w: 260, h: 140, messageIndex: 0 },
      { id: 'm1', kind: 'module', moduleKey: 'physics', x: 300, y: 100, w: 260, h: 140,
        content: '物理视角：内容一的内容一的内容一的内容一的内容一的内容一的内容一的内容一的内容一。' },
      { id: 'm2', kind: 'module', moduleKey: 'math', x: 900, y: -60, w: 260, h: 140, content: '数学视角：短内容' },
    ],
    edges: [{ from: 'a', to: 'm1' }, { from: 'a', to: 'm2' }],
    groups: [],
  });
  const M1 = layout2.cards.find((c) => c.id === 'm1');
  const M2 = layout2.cards.find((c) => c.id === 'm2');
  if (M1.y !== M2.y) throw new Error('同层节点应对齐同一行（顶对齐）：' + M1.y + ' vs ' + M2.y);
  if (!(M1.cx < M2.cx)) throw new Error('同层内应按原画布 x 排序');
  if (!(M1.h > M2.h)) throw new Error('同行内内容多的卡应更高：' + M1.h + ' vs ' + M2.h);
  // 边端点必须落在卡片矩形边界上（锚点裁剪生效）
  const e = layout.edges[0];
  if (Math.abs(Math.abs(e.x1 - cardA.cx) - cardA.w / 2) > 0.01 && Math.abs(Math.abs(e.y1 - cardA.cy) - cardA.h / 2) > 0.01) {
    throw new Error('边起点未锚到卡片边界');
  }
  return true;
});

check('graph-poster: 导出接线（菜单海报段 + 主包/查看器双注册）', () => {
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!ge.includes('data-poster-scale')) throw new Error('导出菜单缺海报倍数行');
  if (!ge.includes('exportGraphPoster')) throw new Error('菜单未接海报导出');
  if (!ge.includes('graphExportHtml')) throw new Error('导出菜单缺单文件网页入口');
  if (!ge.includes("typeof window.exportUtopiaStandaloneHtml === 'function'")) {
    throw new Error('单文件网页入口必须按模块可用性守卫（查看器包不显示该行）');
  }
  // 一键预览行：主应用显示、查看器（window.__UTOPIA__ 存在）不渲染；接 previewUtopiaInViewer
  if (!ge.includes('graphExportPreview')) throw new Error('导出菜单缺「在查看器中预览」行');
  if (!ge.includes('previewUtopiaInViewer')) throw new Error('预览行未接 previewUtopiaInViewer');
  const previewGuard = ge.slice(ge.indexOf('graphExportPreview') - 200, ge.indexOf('graphExportPreview'));
  if (!previewGuard.includes('__UTOPIA__')) throw new Error('预览行必须按查看器环境守卫（查看器里不该再显示预览入口）');
  if (typeof sandbox.window.previewUtopiaInViewer !== 'function') throw new Error('主包未暴露 previewUtopiaInViewer');
  const u = fs.readFileSync('src/static/js/utopia.js', 'utf8');
  if (!/previewUtopiaInViewer[\s\S]{0,900}buildUtopiaSnapshot/.test(u) && !u.includes('_utopiaOpenHandoffViewer(snapshot)')) {
    throw new Error('预览应现建快照（不依赖「刚导出过」的缓存）');
  }
  if (typeof sandbox.window.exportGraphPoster !== 'function') throw new Error('主包未暴露 exportGraphPoster');
  const bf = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  const bv = fs.readFileSync('scripts/build_viewer.mjs', 'utf8');
  if (!bf.includes("'graph-poster.js'")) throw new Error('主包缺 graph-poster.js');
  if (!bv.includes("'graph-poster.js'")) throw new Error('查看器包缺 graph-poster.js（查看器再导出同样可选海报）');
  if (bv.includes("'utopia-import.js'") || bv.includes("'utopia-html.js'")) {
    throw new Error('导入/单文件导出是主应用能力，不该进只读查看器包');
  }
  return true;
});

check('utopia: 快照携带完整会话（messages 全量 + messagesComplete + 下标恒等映射）', () => {
  const history = [
    { role: 'user', content: '什么是动量守恒', timestamp: 1 },
    { role: 'assistant', content: '<physics>守恒定律</physics>', timestamp: 2 },
    { role: 'user', content: '再讲讲能量', timestamp: 3 }, // 未被任何节点引用——也必须随文件带走
  ];
  const prevChat = sandbox._getChatHistory;
  const prevState = sandbox._graphState;
  sandbox._getChatHistory = () => history;
  sandbox._graphState = () => ({ pan: { x: 0, y: 0 }, zoom: 1 });
  vm.runInContext("graphView.nodes = [{ id: 'a', kind: 'user', messageIndex: 0, label: 'q', x: 0, y: 0, w: 260, h: 140 },"
    + "{ id: 'm', kind: 'module', moduleKey: 'physics', messageIndex: 1, label: '物理', x: 400, y: 0, w: 260, h: 140 }];"
    + "graphView.edges = []; graphView.groups = []; graphView.pan = { x: 1, y: 2 }; graphView.zoom = 1;", sandbox);
  let snap;
  try {
    snap = sandbox.buildUtopiaSnapshot();
  } finally {
    sandbox._getChatHistory = prevChat;
    sandbox._graphState = prevState;
    vm.runInContext('graphView.nodes = []; graphView.edges = []; graphView.groups = [];', sandbox);
  }
  if (!Array.isArray(snap.messages) || snap.messages.length !== 3) throw new Error('messages 应全量携带：' + (snap.messages || []).length);
  if (snap.messages[2].content !== '再讲讲能量') throw new Error('未被节点引用的消息也必须在场');
  if (snap.meta.messagesComplete !== true) throw new Error('meta.messagesComplete 应为 true');
  if (snap.meta.counts.messages !== 3) throw new Error('counts.messages 口径错误');
  const nodeA = snap.nodes.find((n) => n.id === 'a');
  if (nodeA.messageIndex !== 0) throw new Error('全量携带时 messageIndex 应恒等映射');
  // 导出成功浮卡：主应用弹、查看器（window.__UTOPIA__ 存在）不弹（其 sessionStorage 是内存门面，交接不出去）
  const u = fs.readFileSync('src/static/js/utopia.js', 'utf8');
  if (!u.includes('_utopiaIsViewer')) throw new Error('缺查看器环境判定');
  if (!u.includes('__utopiaTakeUtopiaHandoff')) throw new Error('缺 handoff 交接函数');
  if (!u.includes('showUtopiaExportCard')) throw new Error('缺导出成功浮卡');
  return true;
});

check('utopia: 查看器会话面板 + 三级装载顺序（embedded → handoff → src → 拖拽）', () => {
  const vhtml = fs.readFileSync('src/static/viewer.html', 'utf8');
  for (const need of ['utopiaMsgsBtn', 'utopiaMsgsPanel', 'utopia-msgs-list', 'utopia-msgs-close']) {
    if (!vhtml.includes(need)) throw new Error('viewer.html 缺会话面板结构：' + need);
  }
  const vmSrc = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  for (const need of [
    'window.__UTOPIA_EMBEDDED__',            // 单文件网页内嵌快照优先
    "qs.get('from') === 'handoff'",          // 主应用导出交接次之
    '__utopiaTakeUtopiaHandoff',             // 与主应用约定的交接函数（opener 直传，不经 storage 门面）
    "qs.get('from') === 'inbox'",            // 桌面「双击 .pmu」启动器通道（open_pmu.py 投递收件箱）
    'loadFromInbox',                         // 收件箱取回（GET /api/utopia/inbox/<名>）
    'toggleMessagesPanel', 'renderMessagesPanel',
    'focusGraphNodeById',                    // 气泡「定位到画布」复用既有聚焦
    'messagesComplete',                      // 老快照（子集消息）口径提示
  ]) {
    if (!vmSrc.includes(need)) throw new Error('viewer-main.js 缺：' + need);
  }
  // 只读边界：面板渲染不得引入任何写路径
  for (const banned of ['saveGraphState', 'createNewSession', 'sendQuick']) {
    if (new RegExp('renderMessagesPanel[\\s\\S]{0,2000}' + banned).test(vmSrc)) {
      throw new Error('会话面板渲染混入写路径：' + banned);
    }
  }
  return true;
});

check('utopia: 单文件网页导出（防截断转义 + 大图限流 + 双通道交付）', () => {
  const uh = fs.readFileSync('src/static/js/utopia-html.js', 'utf8');
  if (!uh.includes('exportUtopiaStandaloneHtml')) throw new Error('缺导出主函数');
  if (!uh.includes('window.__UTOPIA_EMBEDDED__')) throw new Error('缺内嵌快照注入');
  if (!uh.replace(/<\/script/gi, '').includes('<\\/script')) throw new Error('缺 </script 防截断转义');
  if (!uh.includes('u2028') || !uh.includes('u2029')) throw new Error('缺 U+2028/2029 转义（JSON 合法但 JS 字符串字面量非法）');
  if (!uh.includes('<!--')) throw new Error('缺 <!-- 脚本数据转义状态防护');
  if (!uh.includes('IMAGE_INLINE_LIMIT')) throw new Error('缺大图内联上限（背景照片不进包）');
  if (!uh.includes("fetch('/viewer.html'")) throw new Error('应以 viewer.html 为模板');
  const bf = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  if (!bf.includes("'utopia-html.js'")) throw new Error('主包缺 utopia-html.js');
  return true;
});

check('节点皮肤与弹窗：blank/我的理解 玻璃分层 + 双击节点面板走 aurora-glass', () => {
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  // 玻璃节点底座深浅两套
  const baseCount = (css.match(/--node-glass-base:/g) || []).length;
  if (baseCount < 2) throw new Error('--node-glass-base 需深浅各一套，实际 ' + baseCount);
  const blankStart = css.indexOf('.graph-node-blank {');
  if (blankStart < 0) throw new Error('缺 blank（AI 生成）规则');
  const blankBlock = css.slice(blankStart, css.indexOf('}', blankStart));
  if (!blankBlock.includes('--node-glass-base')) throw new Error('blank（AI 生成）未用玻璃底座（仍是纯色）');
  if (!/gradient\(/.test(blankBlock)) throw new Error('blank（AI 生成）缺渐变分层');
  // 人工家族（我的回答/我的理解/我的总结）第 7 轮合并成一段共用皮肤：三者同纸，
  // 且必须仍走玻璃底座 + 渐变分层（旧版 human_note 单条规则已并入这一段）
  const famStart = css.indexOf('.graph-node.graph-attr-manual,');
  if (famStart < 0) throw new Error('缺人工家族共用皮肤（我的回答/我的理解/我的总结）');
  const fam = css.slice(famStart, css.indexOf('}', famStart));
  for (const member of ['.graph-node.graph-node-human-note,', '.graph-node.graph-node-note {']) {
    if (!fam.includes(member)) throw new Error('人工家族未覆盖 ' + member);
  }
  if (!fam.includes('--node-glass-base')) throw new Error('人工家族未用玻璃底座（仍是纯色）');
  if (!/gradient\(/.test(fam)) throw new Error('人工家族缺渐变分层');
  // 我的理解：不能再靠 opacity 压暗（旧版发灰的根因）；窄卡比例必须带 !important（否则被通用 min/max-width 吃掉）
  const hnStart = css.indexOf('.graph-node.graph-node-human-note {');
  if (hnStart < 0) throw new Error('缺我的理解窄卡规则');
  const hn = css.slice(hnStart, css.indexOf('}', hnStart));
  if (/opacity:\s*0\.9/.test(hn)) throw new Error('我的理解仍用 opacity 压暗');
  if (!/max-width:\s*340px\s*!important/.test(hn)) throw new Error('我的理解窄卡比例会被通用 min/max-width 吃掉（需 !important）');
  // 双击节点/连线面板：四个创建点都挂 aurora-glass，且弹窗规则不得再写 background 简写（会盖掉极光）
  const gc = fs.readFileSync('src/static/js/graph-custom.js', 'utf8');
  if ((gc.match(/graph-network-modal aurora-glass/g) || []).length < 4) {
    throw new Error('节点弹窗未全部挂 aurora-glass');
  }
  const modalRule = css.slice(css.indexOf('.graph-network-modal {'), css.indexOf('}', css.indexOf('.graph-network-modal {')));
  if (/background:\s*var\(--bg-panel\)/.test(modalRule)) throw new Error('节点弹窗规则仍在写 background 简写（会盖掉极光层）');
  // 磨砂改由 .aurora-glass--dialog 提供（2026-09-30）：规则里自己再写 backdrop-filter
  // 属同特异性覆盖，会把档位的 16px 顶掉；且历史上正是「只有 backdrop-filter、没有底色」
  // 导致了配方弹窗的纯透明玻璃。通用扫描见下一条用例。
  if (/backdrop-filter/.test(modalRule)) throw new Error('节点弹窗规则自己写了 backdrop-filter（会盖掉 aurora-glass--dialog 那一档）');
  return true;
});

check('玻璃载体：本体必须挂 aurora-glass（漏挂＝纯透明玻璃）＋ 磨砂档位不被 CSS 顶掉', () => {
  // 2026-09-30 用户实机指认：「新建配方」「管理配方」「挑一个颜色」三个弹窗是透明玻璃。
  // 根因：backdrop-filter 本身**不产生任何背景色**，这三个弹窗既没挂 aurora-glass（无底色），
  // CSS 里又只有 backdrop-filter —— 于是背后的画布原样透过来。它们是最早做的一批浮层，
  // 漏在「全部浮层与面板走 aurora-glass」那次（第 5 轮磨砂化）之前。
  //
  // 候选集**从 CSS 反推**而不是猜类名：单类选择器、写了 box-shadow（是浮层本体）、
  // 自己没写 background（底色必须来自 aurora-glass）→ 再回 JS 查这些类挂没挂玻璃。
  // 这样新增浮层不用改这条用例，漏挂当场红；反过来写 background 也会被这条抓住。
  const cssFiles = ['src/static/css/styles.css', 'src/static/css/styles-panels.css', 'src/static/css/graph-override.css'];
  // 判定口径：**类名本身就是浮层**（*-modal / *-dialog / *-panel / *-popover），
  // 且它的规则给了描边或阴影、却没给底色 —— 按项目约定这底色只能来自 aurora-glass。
  // 名字不锚到结尾是有意的：`-head`/`-actions`/`-card` 之类是内部件，锚到结尾才不会误伤。
  const surfaceName = /(?:^|-)(modal|dialog|panel|popover)$/;
  const surfaces = new Set();
  for (const p of cssFiles) {
    const css = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    // 选择器可能是逗号列表（`.a, .b { }`），逐个单类拆出来
    for (const m of css.matchAll(/(^|[};])\s*([^{}@]+?)\s*\{([^}]*)\}/g)) {
      const body = m[3];
      if (!/border\s*:/.test(body) && !/box-shadow\s*:/.test(body)) continue;
      if (/(^|[;{\s])background(-color)?\s*:/.test(body)) continue;   // 自带底色，无需玻璃
      for (const sel of m[2].split(',')) {
        const one = sel.trim();
        // 只认「单个类」（可带伪类/属性）——后代/组合选择器的底色由别的规则给，不算本体
        if (!/^\.[a-z][\w-]*(\s*:[^{]+)?$/.test(one)) continue;
        const cls = one.slice(1).split(/[\s:[]/)[0];
        if (surfaceName.test(cls)) surfaces.add(cls);
      }
    }
  }
  if (surfaces.size < 6) throw new Error('反推出的浮层候选只有 ' + surfaces.size + ' 个，解析多半失效');

  const jsDir = 'src/static/js';
  const jsFiles = fs.readdirSync(jsDir).filter((f) => f.endsWith('.js') && f !== 'app.js' && f !== 'viewer.js');
  const srcByFile = new Map(jsFiles.map((f) => [f, fs.readFileSync(jsDir + '/' + f, 'utf8')]));
  const missing = [];
  for (const cls of surfaces) {
    // 抓 class="a b cls c" / className = 'a b cls c' 两种写法，只看含该类的那一段。
    // 类边界用 (?<![\w-])/(?![\w-]) 而不是 \b：连字符是类名的一部分，
    // 否则 `graph-network-modal` 会连 `…-overlay`/`…-head` 一起匹配上。
    const re = new RegExp('class(?:Name)?\\s*=\\s*[\'"][^\'"\\n]*(?<![\\w-])' + cls + '(?![\\w-])[^\'"\\n]*[\'"]', 'g');
    for (const [f, src] of srcByFile) {
      for (const m of src.matchAll(re)) {
        if (!m[0].includes('aurora-glass')) missing.push(cls + '  ← ' + f + ' :: ' + m[0].slice(0, 80));
      }
    }
  }
  if (missing.length) {
    throw new Error('这些浮层本体没挂 aurora-glass（无底色，只有 backdrop-filter 就是透明玻璃）：\n  ' + missing.join('\n  '));
  }
  // 反向：本体规则自己写 backdrop-filter 会同特异性盖掉档位，模糊档位形同虚设
  const cssAll = cssFiles.map((p) => fs.readFileSync(p, 'utf8')).join('\n');
  for (const sel of ['.graph-network-modal', '.graph-add-node-dialog']) {
    const at = cssAll.indexOf(sel + ' {');
    if (at < 0) throw new Error('找不到规则 ' + sel);
    if (/backdrop-filter/.test(cssAll.slice(at, cssAll.indexOf('}', at)))) {
      throw new Error(sel + ' 自己写了 backdrop-filter，应交给 aurora-glass 档位');
    }
  }
  return true;
});

check('节点族别：形状当第二线索（圆/方/菱/环）+ 待生成大卡按内容收缩', () => {
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  // 族标挂在属性标签上、取 currentColor（否则与内联属性色脱钩）
  const markStart = css.indexOf('.graph-node-attribute::before {');
  if (markStart < 0) throw new Error('缺属性标签族标（.graph-node-attribute::before）');
  const mark = css.slice(markStart, css.indexOf('}', markStart));
  if (!/background:\s*currentColor/.test(mark)) throw new Error('族标未取 currentColor（会与属性色脱钩）');
  for (const [name, sel] of [
    ['方＝人工', '.graph-attr-manual .graph-node-attribute::before'],
    ['菱＝结构', '.graph-node-hub .graph-node-attribute::before'],
    ['环＝素材', '.graph-node-source .graph-node-attribute::before'],
  ]) {
    if (css.indexOf(sel) < 0) throw new Error('缺族标形状：' + name);
  }
  // 待生成的大卡不再占 640×512
  const pendStart = css.indexOf('.graph-node-module.graph-node-pending:not(.minimized) {');
  if (pendStart < 0) throw new Error('缺待生成收缩规则（.graph-node-module.graph-node-pending:not(.minimized)）');
  // 底座 640×512 必须让开待生成态，否则收缩规则要跟 !important 对打、白增一条
  if (css.indexOf('.graph-node-module:not(.graph-node-pending) {') < 0) throw new Error('模块底座未让开待生成态（缺 :not(.graph-node-pending)）');
  const pend = css.slice(pendStart, css.indexOf('}', pendStart));
  if (!/min-height:\s*200px\s*!important/.test(pend)) throw new Error('待生成大卡未收缩（仍是 640×512 空盒子）');
  const gr = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!/function _graphNodePending/.test(gr)) throw new Error('渲染层缺 _graphNodePending 判定');
  if (!/pendingClass/.test(gr)) throw new Error('渲染层未把 graph-node-pending 挂到节点根');
  // 面板：色点带形状 + 单条目组不空半行
  const gc = fs.readFileSync('src/static/js/graph-custom.js', 'utf8');
  if (!/graph-add-node-dot ' \+ _nodeFamilyShape\(option\)/.test(gc)) throw new Error('添加节点面板色点未带族别形状');
  const gj = fs.readFileSync('src/static/js/graph.js', 'utf8');
  if (!/function _nodeFamilyShape/.test(gj)) throw new Error('缺 _nodeFamilyShape 映射（面板色点形状）');
  if (!/graph-add-node-item:only-child/.test(css)) throw new Error('单条目分组仍会在右侧留空（缺 :only-child 占满行）');
  return true;
});

check('utopia: .pmu 快照格式（解析校验/摘要/文件名 + 导出接线 + 查看器只读边界）', () => {
  const u = fs.readFileSync('src/static/js/utopia.js', 'utf8');
  if (!u.includes("const UTOPIA_FORMAT = 'phymath-utopia/graph';")) throw new Error('格式 id 不符合约定');
  if (!u.includes("const UTOPIA_EXT = '.pmu';")) throw new Error('扩展名应为 .pmu');
  // 解析：正常 + 四类拒绝（非法 JSON / 非本格式 / 版本过高 / 缺 nodes）
  const parse = sandbox.parseUtopiaSnapshot;
  if (typeof parse !== 'function') throw new Error('parseUtopiaSnapshot 未暴露');
  if (!parse(JSON.stringify({ format: 'phymath-utopia/graph', version: 1, nodes: [] })).ok) throw new Error('合法快照被判失败');
  if (parse('{not json').ok !== false) throw new Error('非法 JSON 应被拒');
  if (parse(JSON.stringify({ format: 'other/graph', version: 1, nodes: [] })).ok !== false) throw new Error('非本格式应被拒');
  if (parse(JSON.stringify({ format: 'phymath-utopia/graph', version: 99, nodes: [] })).ok !== false) throw new Error('版本过高应被拒');
  if (parse(JSON.stringify({ format: 'phymath-utopia/graph', version: 1 })).ok !== false) throw new Error('缺 nodes 应被拒');
  // 摘要素函数
  const sum = sandbox.utopiaSnapshotSummary({
    title: 'T', nodes: [{ content: 'abcd' }, { content: 'ef' }], edges: [1], groups: [1, 2], messages: [1],
  });
  if (sum.nodes !== 2 || sum.edges !== 1 || sum.groups !== 2 || sum.messages !== 1 || sum.chars !== 6) {
    throw new Error('摘要统计错误：' + JSON.stringify(sum));
  }
  // 文件名：带非法字符的标题必须被洗净且以 .pmu 结尾
  const fn = sandbox.utopiaSnapshotFilename('会话 名/带*字符?');
  if (!fn.endsWith('.pmu')) throw new Error('文件名缺扩展名');
  if (/[\\/:*?"<>|]/.test(fn)) throw new Error('文件名残留非法字符：' + fn);
  // 主应用接线：产物含 utopia.js、导出菜单有入口
  if (!code.includes('buildUtopiaSnapshot') || !code.includes('exportUtopiaSnapshot')) throw new Error('主包未注册快照模块');
  const ge = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  if (!ge.includes('graphExportUtopia')) throw new Error('导出菜单缺 Utopia 快照入口');
  if (!ge.includes('window.exportUtopiaSnapshot')) throw new Error('入口未调快照导出');
  // 查看器只读边界：打包子集含渲染子系统与桩，且绝不含会话/AI/检测/Φ 包
  const bv = fs.readFileSync('scripts/build_viewer.mjs', 'utf8');
  for (const need of ['viewer-shims.js', 'graph-render.js', 'graph-workflow.js', 'utopia.js', 'viewer-main.js']) {
    if (!bv.includes(`'${need}'`)) throw new Error('查看器打包缺 ' + need);
  }
  for (const banned of ['session.js', 'chat.js', 'chat-features.js', 'quiz.js', 'harness.js', 'models.js', 'ui.js', 'knowledge.js']) {
    if (bv.includes(`'${banned}'`)) throw new Error('只读查看器不该打包 ' + banned);
  }
  const shims = fs.readFileSync('src/static/js/viewer-shims.js', 'utf8');
  if (!/window\.saveGraphState = function \(\) \{\};/.test(shims)) throw new Error('查看器 saveGraphState 必须是空操作');
  if (!shims.includes("Object.defineProperty(window, 'localStorage'")) throw new Error('查看器缺 localStorage 只读门面');
  // 只读化：右下角工具栏整个隐藏 + 右键菜单白名单剪枝（不提供新建/删除/端口增删/收藏知识点）
  const vmSrc = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  if (!vmSrc.includes('.graph-canvas-toolbar')) throw new Error('查看器未隐藏画布工具栏');
  if (!vmSrc.includes('READONLY_MENU_LABELS')) throw new Error('查看器缺右键菜单白名单');
  for (const banned of ['新建节点', '删除节点', '添加输出端口', '收藏为知识点']) {
    if (new RegExp("READONLY_MENU_LABELS[\\s\\S]{0,400}" + banned).test(vmSrc)) {
      throw new Error('只读白名单里混入了写操作：' + banned);
    }
  }
  // 界面语言：顶栏/拖放卡/提示条都用极光玻璃
  const vhtml = fs.readFileSync('src/static/viewer.html', 'utf8');
  for (const need of ['utopia-bar aurora-glass', 'utopia-drop aurora-glass', 'utopia-toast aurora-glass']) {
    if (!vhtml.includes(need)) throw new Error('查看器界面缺玻璃载体：' + need);
  }
  if (!['viewer.html'].every(f => fs.existsSync('src/static/' + f))) throw new Error('缺 src/static/viewer.html');
  return true;
});

check('graph-contextmenu: 打包注册与产物符号（静态断言）', () => {
  const buildSrc = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  // 注册的相对顺序：graph-export.js → utopia.js → graph-contextmenu.js → knowledge.js
  // （utopia.js 与 graph-export.js 同属导出族；右键菜单须在 graph-export 之后注册）
  let last = -1;
  for (const f of ['graph-export.js', 'utopia.js', 'graph-contextmenu.js', 'knowledge.js']) {
    const i = buildSrc.indexOf("'" + f + "'");
    if (i < 0 || i < last) return false;
    last = i;
  }
  if (!code.includes('function openGraphContextMenu')) return false;
  if (!code.includes('graph-context-menu')) return false;
  // 产物含 pointerdown 右键过滤。参数名不能钉死：esbuild 会按新增局部变量重排单字母命名
  // （2026-09-25 滚轮合帧加 4 个局部量后 e→r），断言意图是「过滤存在」，用 \w 通配
  if (!/if\(\w+\.button!==0\)return;/.test(code)) return false;
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  return css.includes('.graph-context-menu');
});

// ===== 知识点摘要（P2：summarySource/anchorSummary 契约）静态/沙箱回归 =====

check('knowledge: dedupeKnowledgeItems 按 summarySource 保优（manual > model > local，长度仅同源 tie-break）', () => {
  const d = sandbox.dedupeKnowledgeItems;
  if (typeof d !== 'function') throw new Error('dedupeKnowledgeItems 未暴露');
  // model 摘要短于 local 整卡摘要也不被拉回去：来源等级优先
  const r1 = d({
    a: { id: 'a', title: '简谐运动', sessionId: 's1', summary: '很长的本地整卡摘要，比模型摘要长得多', summarySource: 'local', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '简谐运动', sessionId: 's1', summary: '回复力与位移成正比的周期性振动', summarySource: 'model', formulas: [], createdAt: 1 },
  });
  if (!r1.b || r1.a) return false;
  if (r1.b.summary !== '回复力与位移成正比的周期性振动') return false;
  // 同源才比长度：local 更长者胜
  const r2 = d({
    a: { id: 'a', title: '导数', sessionId: 's1', summary: '短', summarySource: 'local', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '导数', sessionId: 's1', summary: '更长的同源摘要', summarySource: 'local', formulas: [], createdAt: 1 },
  });
  if (!r2.b || r2.a) return false;
  // 旧数据（无 summarySource）视为 local：manual 仍胜出
  const r3 = d({
    a: { id: 'a', title: '动量', sessionId: 's1', summary: '旧数据无来源字段的很长摘要', formulas: [], createdAt: 9 },
    b: { id: 'b', title: '动量', sessionId: 's1', summary: '手动摘要', summarySource: 'manual', formulas: [], createdAt: 1 },
  });
  return !!(r3.b && !r3.a && r3.b.summary === '手动摘要');
});

check('knowledge: 定位锚点优先 anchorSummary、旧数据回退 summary（契约两侧字段齐备）', () => {
  if (!code.includes('summarySource') || !code.includes('anchorSummary')) {
    throw new Error('打包产物缺 summarySource/anchorSummary 字段');
  }
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  const at = src.indexOf('_summaryFragmentsForMatch(item.anchorSummary');
  if (at < 0) throw new Error('_focusKnowledgeNodeByContent 未优先使用 anchorSummary');
  return src.slice(at, at + 120).includes('item.summary');
});

// ===== 存量摘要优化入口（P3：方案 B 批量重述 + 可停止注册表）静态/沙箱回归 =====

check('knowledge: P3 isLegacyCardSummaryItem 判定边界（manual 永不触碰、锚点比对、file/harness 不碰）', () => {
  const is = sandbox.isLegacyCardSummaryItem;
  if (typeof is !== 'function') throw new Error('isLegacyCardSummaryItem 未暴露');
  // 目标：旧数据（source=ai_extract，无 summarySource/anchorSummary）——旧提取链路必写整卡摘要
  if (is({ id: 'a', title: '导数', summary: '整卡摘要原文', source: 'ai_extract' }) !== true) return false;
  // 目标：P2 local 条目且 summary 等于 anchorSummary
  if (is({ id: 'b', title: '导数', summary: '整卡摘要', summarySource: 'local', anchorSummary: '整卡摘要', source: 'ai_extract' }) !== true) return false;
  // 非目标：summary 已与锚点不同（已优化/模板化）
  if (is({ id: 'c', title: '导数', summary: '具体摘要', summarySource: 'local', anchorSummary: '整卡摘要', source: 'ai_extract' }) !== false) return false;
  // 非目标：summarySource=model / manual
  if (is({ id: 'd', title: '导数', summary: 'x', summarySource: 'model', source: 'ai_extract' }) !== false) return false;
  if (is({ id: 'e', title: '导数', summary: 'x', summarySource: 'manual' }) !== false) return false;
  // 非目标：旧数据手动收藏（无 summarySource，source=manual）也不得触碰
  if (is({ id: 'f', title: '导数', summary: '手写摘要', source: 'manual' }) !== false) return false;
  // 非目标：file/harness 是文档/节点内容摘要，无锚点回退不适用
  if (is({ id: 'g', title: '导数', summary: '文档段落摘要', source: 'file' }) !== false) return false;
  if (is({ id: 'h', title: '导数', summary: '节点内容', source: 'harness' }) !== false) return false;
  // 非目标：空摘要 / 空值
  if (is({ id: 'i', title: '导数', summary: '   ', source: 'ai_extract' }) !== false) return false;
  if (is(null) !== false) return false;
  return true;
});

check('knowledge: P3 重述提示词按 (title, formulas, meaning) 组装 + 公式含义同会话优先 + 回复清洗', () => {
  const meaningsOf = sandbox._knowledgeFormulaMeanings;
  const build = sandbox._buildSummaryRestatePrompt;
  const clean = sandbox._cleanRestatedSummaryText;
  if (typeof meaningsOf !== 'function' || typeof build !== 'function' || typeof clean !== 'function') {
    throw new Error('P3 提示词/清洗函数未暴露');
  }
  // 公式含义查找：同会话优先，跨会话同名公式兜底（_formulaKey 忽略空格差异）
  storageData['phymathia_formulas'] = JSON.stringify({
    f1: { id: 'f1', latex: '$F = -kx$', meaning: '回复力与位移成正比', sessionId: 'sessA', meaningSource: 'model' },
    f2: { id: 'f2', latex: '$G=mg$', meaning: '重力与质量成正比', sessionId: 'sessB', meaningSource: 'model' },
  });
  const m1 = meaningsOf({ sessionId: 'sessA', formulas: ['F=-kx'] });
  const m2 = meaningsOf({ sessionId: 'sessC', formulas: ['G = mg'] });
  if (m1.length !== 1 || m1[0].meaning !== '回复力与位移成正比') return false;
  if (m2.length !== 1 || m2[0].meaning !== '重力与质量成正比') return false;
  // 提示词含标题/公式/含义/旧摘要/60 字约束
  const prompt = build(
    { title: '简谐运动', category: 'physics', summary: '整卡摘要原文', formulas: ['F=-kx'] },
    m1,
  );
  for (const frag of ['简谐运动', 'F=-kx', '回复力与位移成正比', '整卡摘要原文', '60 字']) {
    if (!prompt.includes(frag)) throw new Error('重述提示词缺: ' + frag);
  }
  // 回复清洗：思考块/前缀/引号/多行解释
  if (clean('<think>推理</think>摘要：**重述摘要正文**') !== '重述摘要正文') return false;
  if (clean('“带引号的模型回复”') !== '带引号的模型回复') return false;
  if (clean('第一行摘要\n第二行解释') !== '第一行摘要') return false;
  if (clean('好的，以下是摘要：\n真正摘要行') !== '真正摘要行') return false;
  delete storageData['phymathia_formulas'];
  return true;
});

check('knowledge: P3 批量任务中止后不再发后续请求 + 目标写回 + 非目标不触碰（沙箱行为断言）', async () => {
  const realProxy = sandbox.proxyChatWithModel;
  const realGetActive = sandbox.getActiveModelForRole;
  const RealAbortController = sandbox.AbortController;
  // 宽松 DOM 代理对任意属性都返回代理（含 Symbol.match），真实字符串 .includes(代理)
  // 会被当成 RegExp 抛 TypeError——批量路径涉及的 getElementById 换成哑元素，
  // knowledgePanel 视为未打开（跳过重渲），结束后还原。
  const realGetElementById = sandbox.document.getElementById;
  const fakeEl = () => ({
    classList: { contains: () => false, add: () => {}, remove: () => {}, toggle: () => {} },
    style: {}, textContent: '', innerHTML: '',
  });
  sandbox.document.getElementById = () => fakeEl();
  try {
    // 三条 local 整卡摘要目标 + 一条手动条目（必须不触碰）
    storageData['phymathia_knowledge'] = JSON.stringify({
      ki_a: { id: 'ki_a', title: '简谐运动', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要A', summarySource: 'local', anchorSummary: '整卡摘要A', formulas: [], createdAt: 1 },
      ki_b: { id: 'ki_b', title: '胡克定律', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要B', summarySource: 'local', anchorSummary: '整卡摘要B', formulas: [], createdAt: 2 },
      ki_c: { id: 'ki_c', title: '导数', sessionId: 's1', source: 'ai_extract', summary: '整卡摘要C', summarySource: 'local', anchorSummary: '整卡摘要C', formulas: [], createdAt: 3 },
      ki_m: { id: 'ki_m', title: '手动条目', sessionId: 's1', source: 'manual', summary: '手动摘要', summarySource: 'manual', formulas: [], createdAt: 4 },
    });
    sandbox.invalidateKnowledgeCache();
    sandbox.getActiveModelForRole = (role) => (role === 'descriptor'
      ? { id: 'desc', provider: 'test', model: 'test-model', baseUrl: 'https://example.test', apiKey: 'k' }
      : null); // descriptor 槽位优先
    let proxyCalls = 0;
    sandbox.proxyChatWithModel = async (model, body, signal) => {
      proxyCalls++;
      if (proxyCalls === 1) {
        const prompt = body.messages.map(m => m.content).join('\n');
        if (!prompt.includes('简谐运动')) throw new Error('第一条请求应针对目标条目');
        if (body.stream !== false) throw new Error('重述调用应走 stream:false');
        return { json: async () => ({ choices: [{ message: { content: '重述后的摘要A' } }] }) };
      }
      // 第二条请求进行中被用户中止：置 aborted（模拟 AbortController.abort 效果）并拒绝在途 fetch
      signal.aborted = true;
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    };
    sandbox.AbortController = class {
      constructor() { this.signal = { aborted: false }; this.abort = () => { this.signal.aborted = true; }; }
    };
    await sandbox.optimizeKnowledgeSummaries();
    if (proxyCalls !== 2) throw new Error('中止后应不再发出后续请求，实际调用 ' + proxyCalls + ' 次（应为 2）');
    const after = JSON.parse(storageData['phymathia_knowledge']);
    if (after.ki_a.summary !== '重述后的摘要A' || after.ki_a.summarySource !== 'model') return false; // 完成条目写回
    if (after.ki_a.anchorSummary !== '整卡摘要A') return false; // 定位锚点保留
    if (after.ki_b.summary !== '整卡摘要B' || after.ki_b.summarySource !== 'local') return false; // 失败条目不写回
    if (after.ki_c.summary !== '整卡摘要C' || after.ki_c.summarySource !== 'local') return false; // 中止后未触碰
    if (after.ki_m.summary !== '手动摘要' || after.ki_m.summarySource !== 'manual') return false; // manual 不触碰
    return true;
  } finally {
    sandbox.proxyChatWithModel = realProxy;
    sandbox.getActiveModelForRole = realGetActive;
    sandbox.AbortController = RealAbortController;
    sandbox.document.getElementById = realGetElementById;
    delete storageData['phymathia_knowledge'];
    sandbox.invalidateKnowledgeCache();
  }
});

check('knowledge: P3 中断注册表接线（关闭面板/再次点击/Esc 三路径 + 循环前查 signal）与入口静态断言', () => {
  const src = fs.readFileSync('src/static/js/knowledge.js', 'utf8');
  for (const frag of [
    'let _kpSummaryOptimizeAbort',                                    // 模块级注册表：中断路径的唯一持有者
    'function abortKnowledgeSummaryOptimize',                         // 统一中断入口
    "if (event.key === 'Escape') abortKnowledgeSummaryOptimize()",    // Esc 路径
    'abortKnowledgeSummaryOptimize();\n  document.getElementById(\'knowledgePanel\').classList.remove', // 关闭面板路径
    'if (_knowledgeSummaryTaskRunning())',                            // 再次点击 = 中断（批量入口首行分流）
    'if (controller.signal.aborted) { aborted = true; break; } // 中止后不再发出后续请求',   // 循环每轮先查
    'if (controller.signal.aborted) { aborted = true; break; } // 用户中断不计为失败',       // 在途 fetch 拒绝后 break
    "restatKnowledgeItemSummary('${item.id}')",                       // 卡片单条入口（渲染层接线）
    "isLegacyCardSummaryItem(item) ? `<button class=\"kp-action-btn kp-btn-primary\" onclick=\"event.stopPropagation(); restatKnowledgeItemSummary", // 非目标条目不渲染入口
  ]) {
    if (!src.includes(frag)) throw new Error('knowledge.js 缺中断/入口接线: ' + frag);
  }
  for (const frag of ['optimizeKnowledgeSummaries', 'isLegacyCardSummaryItem', 'restatKnowledgeItemSummary', '_kpSummaryOptimizeAbort']) {
    if (!code.includes(frag)) throw new Error('打包产物缺符号: ' + frag);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('kpOptimizeBtn') || !html.includes('optimizeKnowledgeSummaries()')) return false;
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  return css.includes('.kp-tool-btn');
});

check('knowledge: P4 extractLocalKnowledge 模板化摘要（多公式回答逐条互异 + anchor 保整卡 + 前后端同文案）', () => {
  // 与 pytest test_local_extract_summaries_differ_for_multi_formula_answers 同一组输入：
  // 期望文案两侧逐字一致（前端 _buildLocalKnowledgeSummary / 后端 _local_knowledge_summary）
  const answers = [
    '# 简谐运动\n回复力让物体振动。\n<formula>F=-kx</formula>\n'
      + '<formula>T=2\\pi\\sqrt{\\frac{m}{k}}</formula>\n<summary>甲卡整卡摘要</summary>',
    '# 傅里叶级数\n周期信号可分解为谐波叠加。\n'
      + '<formula>\\sum_{n=1}^{\\infty}a_n e^{inx}</formula>\n<summary>乙卡整卡摘要</summary>',
    '# 傅里叶变换\n把信号分解为连续频率分量。\n'
      + '<formula>\\int_0^{T}f(t)dt</formula>\n<summary>丙卡整卡摘要</summary>',
    '# 简谐运动能量\n总机械能与振幅平方成正比。\n'
      + '<formula>E=\\frac{1}{2}kA^2</formula>\n<summary>丁卡整卡摘要</summary>',
    '# 导数\n刻画函数的瞬时变化率，本卡没有公式。',
  ];
  const anchorParts = ['甲卡整卡摘要', '乙卡整卡摘要', '丙卡整卡摘要', '丁卡整卡摘要', '瞬时变化率'];
  const expected = [
    '「简谐运动」：胡克定律：回复力与位移大小成正比、方向相反（物理）',
    '「傅里叶级数」：傅里叶级数/变换：用指数基元把信号分解为频率成分（物理）',
    '「傅里叶变换」：傅里叶变换：把信号分解为连续频率分量的积分表示（其他）',
    '「简谐运动能量」：简谐运动总机械能与振幅平方成正比（物理）',
    '「导数」：数学知识点',
  ];
  const items = answers.map(c => sandbox.extractLocalKnowledge([{ role: 'assistant', content: c }])[0]);
  if (items.some(it => !it || it.summarySource !== 'local')) return false;
  for (let i = 0; i < expected.length; i++) {
    if (items[i].summary !== expected[i]) {
      throw new Error('模板文案偏离（须与后端 _local_knowledge_summary 同口径）: ' + items[i].summary);
    }
    if (items[i].anchorSummary === items[i].summary) return false; // 整卡摘要仍是锚点，不再充当展示摘要
    if (!String(items[i].anchorSummary).includes(anchorParts[i])) return false; // 锚点保留整卡摘要原文
  }
  const summaries = items.map(it => it.summary);
  if (new Set(summaries).size !== summaries.length) return false; // 各条互不相同
  // 多公式回答取首个公式的规则含义（胡克定律），不串到第二公式（周期）含义
  if (!summaries[0].includes('胡克定律') || summaries[0].includes('周期')) return false;
  // 超长标题（审查修复回归）：预算压缩标题保结构——「」/含义/分类括注完整、≤120，
  // 期望串与 pytest test_local_knowledge_summary_long_title_keeps_structure 同口径
  const unit = '很长的知识点标题';
  const longAns = [{ role: 'assistant', content: `# ${unit.repeat(15)}\n受力分析如下。\n<formula>F=ma</formula>` }];
  const longItem = sandbox.extractLocalKnowledge(longAns)[0];
  const longExpected = `「${unit.repeat(6)}很长的」：${unit.repeat(3)}相关公式：用于描述${unit.repeat(3)}的定量关系（物理）`;
  if (!longItem || longItem.summary !== longExpected) {
    throw new Error('超长标题模板偏离（须与后端 _local_knowledge_summary 同口径）: ' + (longItem && longItem.summary));
  }
  const longNoFormula = sandbox.extractLocalKnowledge(
    [{ role: 'assistant', content: `# ${unit.repeat(15)}\n本卡没有公式。` }])[0];
  if (!longNoFormula || !longNoFormula.summary.startsWith('「')) return false;
  if (!longNoFormula.summary.endsWith('」：其他知识点') || longNoFormula.summary.length > 120) return false;
  if (!code.includes('_buildLocalKnowledgeSummary')) throw new Error('打包产物缺 _buildLocalKnowledgeSummary');
  return true;
});

check('chat：推理通道不混进正文（混进去 → 整轮知识提取被「思维链泄漏」闸门拒收 → 大陆永远没有这座岛）', () => {
  // 真机事故（2026-09-15）：推理型模型先吐 reasoning_content 再吐 content，前端旧写法
  // `assistantContent += delta.content || delta.reasoning_content` 把思维链灌进正文，
  // 正文以「用户要求：…当前分支类型…必须只输出…」开头 → 前后端同判的 _looksLikeReasoningLeak
  // 命中 → 整轮不提取 → 用户问过「旋度」，知识库与大陆里却永远没有旋度。
  const src = fs.readFileSync('src/static/js/chat.js', 'utf8');
  if (/assistantContent \+= delta\.content \|\| delta\.reasoning_content/.test(src)) {
    throw new Error('思维链又被灌进正文了（知识提取会被闸门整轮拒收）');
  }
  if (!/if \(delta\.content\) assistantContent \+= delta\.content;/.test(src)) {
    throw new Error('正文累加口径缺失（只认 delta.content）');
  }
  if (!src.includes('assistantReasoning')) throw new Error('推理通道未单独攒');
  if (!src.includes('assistantContent = assistantReasoning')) {
    throw new Error('模型只吐推理、正文为空时的兜底缺失（会留一个空气泡）');
  }
  // 被闸门跳过时必须让用户知道原因：静默正是这场事故最坑的地方
  const feat = fs.readFileSync('src/static/js/chat-features.js', 'utf8');
  if (!feat.includes("_knowledgeSkipReason = 'reasoning_leak'")) throw new Error('提取被跳过时未记录原因');
  if (!feat.includes('混进了模型的思考过程')) throw new Error('跳过原因未告知用户（不许静默）');
  if (!code.includes('混进了模型的思考过程')) throw new Error('打包产物缺提示文案（未 build:js？）');
  return true;
});

// ===== M1 可视化数值实验自动校验 =====
check('viz-check：三桥注入与桥体打包存在', () => {
  if (!code.includes('_VIZ_CHECK_BRIDGE')) throw new Error('打包产物缺 _VIZ_CHECK_BRIDGE');
  // 压缩产物会去掉加号两侧空格，用空白容忍匹配三桥拼接
  if (!/_VIZ_MATH_BRIDGE\s*\+\s*_VIZ_THEME_BRIDGE\s*\+\s*_VIZ_CHECK_BRIDGE/.test(code)) throw new Error('buildVizCard 未注入第三桥');
  if (!code.includes('"phymathia-viz-check"')) throw new Error('校验消息类型缺失（桥回传或 parent 监听）');
  if (!code.includes('__PHYMATHIA_VIZ__')) throw new Error('约定对象探测缺失');
  return true;
});

check('viz-check：角标三态文案与重生成意图', () => {
  for (const t of ['校验通过 ✓', '守恒漂移 ⚠ 建议重新生成', '与解析解偏差 ⚠', '校验中…', '重新生成可视化：']) {
    if (!code.includes(t)) throw new Error('缺文案：' + t);
  }
  return true;
});

check('viz-check：_vizCheckEnergyTotals 分量求和与 NaN 计数', () => {
  const r = sandbox._vizCheckEnergyTotals([
    { t: 0, energy: { kinetic: 1, potential: 1 } },
    { t: 0.25, energy: { kinetic: NaN, potential: 1 } },
    { t: 0.5, energy: { kinetic: 2, potential: 2 } },
    { t: 0.75, energy: {} },            // 分量缺失 → 整点跳过
  ]);
  if (r.totals.length !== 2 || r.totals[0] !== 2 || r.totals[1] !== 4) throw new Error('求和错误: ' + JSON.stringify(r));
  if (r.nonFinite !== 1) throw new Error('nonFinite 应为 1');
  return true;
});

check('viz-check：_vizCheckComputeDrift 漂移口径', () => {
  if (sandbox._vizCheckComputeDrift([1, 1, 1, 1]) !== 0) return false;
  if (sandbox._vizCheckComputeDrift([1, 2, 3]) !== null) return false;          // <4 点
  if (sandbox._vizCheckComputeDrift([0, 0, 0, 0]) !== null) return false;       // 均值≈0 → 跳过守恒项
  const d = sandbox._vizCheckComputeDrift([10, 10.5, 10.2, 10.4, 10.3]);        // (10.5−10)/10.28≈4.9%
  if (!(d > 0.045 && d < 0.055)) throw new Error('漂移计算偏离: ' + d);
  return true;
});

check('viz-check：_vizCheckEstimatePeriod 由 KE 序列恢复周期', () => {
  // 解析 KE：C(1−cos2ωt)，ω=2 → 振子周期 T=2π/ω≈3.1416；250ms×40 点（真实采样节奏）
  const T = 2 * Math.PI / 2, dt = 0.25, samples = [];
  for (let i = 0; i < 40; i++) {
    const t = i * dt;
    samples.push({ t: t, energy: { kinetic: 0.5 * (1 - Math.cos(4 * t)), potential: 0.5 * (1 + Math.cos(4 * t)) } });
  }
  const est = sandbox._vizCheckEstimatePeriod(samples);
  if (est == null || Math.abs(est - T) / T > 0.005) throw new Error('周期估计偏离: ' + est);
  return true;
});

check('viz-check：_vizCheckTheoryPeriod v1 两张标准模型表', () => {
  const sm = sandbox._vizCheckTheoryPeriod('spring-mass', { m: 0.5, k: 2 });
  const pd = sandbox._vizCheckTheoryPeriod('pendulum', { L: 1, g: 9.8 });
  if (Math.abs(sm - Math.PI) > 1e-9) return false;
  if (Math.abs(pd - 2 * Math.PI * Math.sqrt(1 / 9.8)) > 1e-9) return false;
  if (sandbox._vizCheckTheoryPeriod('damped-oscillation', {}) !== null) return false;  // 非标准模型不猜
  if (sandbox._vizCheckTheoryPeriod('spring-mass', { m: 0, k: 2 }) !== null) return false;  // 参数非法不猜
  return true;
});

check('viz-check：_vizCheckVerdict 四态判定', () => {
  const synth = (w) => {
    const arr = [];
    for (let i = 0; i < 40; i++) {
      const t = i * 0.25;
      arr.push({ t: t, energy: { kinetic: 0.5 * (1 - Math.cos(2 * w * t)), potential: 0.5 * (1 + Math.cos(2 * w * t)) } });
    }
    return arr;
  };
  const vp = sandbox._vizCheckVerdict(synth(2), 'spring-mass', { m: 0.5, k: 2 });      // 周期与守恒均合
  if (vp.status !== 'pass') throw new Error('恒能应为 pass: ' + JSON.stringify(vp));
  const driftSamples = synth(2).map((s, i) => ({ t: s.t, energy: { kinetic: 1 + i * 0.2, potential: 1 } }));
  const vd = sandbox._vizCheckVerdict(driftSamples, null, null);
  if (vd.status !== 'fail' || vd.kind !== 'drift') throw new Error('漂移应 fail: ' + JSON.stringify(vd));
  const nanSamples = synth(2).map((s, i) => ({ t: s.t, energy: { kinetic: i % 3 === 0 ? NaN : 1, potential: 2 } }));
  const vn = sandbox._vizCheckVerdict(nanSamples, null, null);
  if (vn.status !== 'fail' || vn.kind !== 'diverge') throw new Error('NaN 多发应 diverge: ' + JSON.stringify(vn));
  const vw = sandbox._vizCheckVerdict(synth(2.2), 'spring-mass', { m: 0.5, k: 2 });    // 模拟 ω=2.2 vs 理论 ω=2 → 偏差 ~9%
  if (vw.status !== 'warn') throw new Error('周期偏差应 warn: ' + JSON.stringify(vw));
  const vq = sandbox._vizCheckVerdict(synth(2.2), null, null);                          // 未声明 model → 不比对解析解
  if (vq.status !== 'pass') throw new Error('未声明 model 不应 warn: ' + JSON.stringify(vq));
  if (sandbox._vizCheckVerdict(synth(2).slice(0, 2), 'spring-mass', { m: 0.5, k: 2 }).status !== 'none') return false;
  return true;
});

// ===== 模型分组与分组密钥 =====
check('model-group：分组接线（组头渲染/组密钥输入/折叠/optgroup 下拉）静态断言', () => {
  for (const t of ['phymathia_model_group_keys', 'saveGroupKey', 'toggleModelGroup', 'model-group-key', '<optgroup label=', 'data-provider']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  // 点外关闭监听须跳过已脱离 DOM 的点击目标（分组折叠就地切换的前提）
  if (!code.includes('isConnected')) throw new Error('点外关闭缺少 detached-target 守卫');
  return true;
});

check('model-add：双模式添加接线（预设/手动选项卡 + 勾选清单 + 在线拉取）静态断言', () => {
  // 打包产物经 esbuild 压缩（键名引号/空白会被改写），只能断言裸标识符存在
  for (const t of ['switchAddModelTab', 'am-model-check', 'addModelsForProvider', 'api/models/list', 'fetchProviderModelList', 'fetchManualModelList', 'confirmDeleteModelGroup', '_parseExtraModelInput', '_dialogApiKeyWithFallback', '_freshIdsNotListed']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  // 自动预置必须已移除：列表里只允许出现用户主动加过的模型（用户反馈的根因）
  for (const gone of ['_ensureOpencodeGoModels', '_ensureOpencodeFreeModels', '_ensureDeepseekModels']) {
    if (code.includes(gone)) throw new Error('自动预置函数仍在：' + gone);
  }
  // 预设注册表覆盖主流供应商（新增口径的最低门槛；注册表挂 window 供运行时读取）
  if (!code.includes('window.MODEL_PRESETS')) throw new Error('注册表未挂 window');
  for (const p of ['zhipu', 'moonshot', 'dashscope', 'bigmodel', 'minimaxi', 'siliconflow', 'generativelanguage', 'anthropic', 'openrouter', 'groq', '11434', '1234']) {
    if (!code.includes(p)) throw new Error('预设注册表缺供应商特征串：' + p);
  }
  // 每个预设的 hot（推荐星）id 必须真实存在于该预设的 models 里——hot 指向不存在的
  // id 不会报错，只是那颗星永远点不出来，属于静默失效。2026-09-27 真实踩过：
  // opencode 免费组的 hot 写的是 deepseek-v4-flash-free / mimo-v2.5-free，
  // 而当时的清单里已经没有这两个。
  for (const [key, preset] of Object.entries(sandbox.window.MODEL_PRESETS)) {
    if (!preset || !Array.isArray(preset.models)) continue;
    const ids = new Set(preset.models.map(m => m.id));
    for (const hot of preset.hot || []) {
      if (!ids.has(hot)) throw new Error('预设 ' + key + ' 的 hot 指向不存在的模型：' + hot);
    }
  }
  return true;
});

check('model-add：无自动预置（loadUserModels 后列表为空）+ 预设添加核心（勾选入库 + 组密钥同步 + 重复跳过）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  if (sandbox.getAllModels().length !== 0) throw new Error('loadUserModels 不得自动预置任何模型');
  const preset = sandbox.window.MODEL_PRESETS.deepseek; // const 声明只挂 window，不在沙箱全局
  if (!preset || !Array.isArray(preset.models) || preset.models.length < 2) throw new Error('deepseek 预设应 ≥2 个模型');
  const entries = preset.models.map(m => ({ model: m.id, label: m.label }));
  const n = sandbox.addModelsForProvider('deepseek', 'sk-ds-group', preset.baseUrl, entries);
  if (n !== preset.models.length) throw new Error('应新增 ' + preset.models.length + ' 个，实际 ' + n);
  const ds = sandbox.getAllModels().filter(m => m.provider === 'deepseek');
  if (ds.length !== preset.models.length) throw new Error('入库条数不符: ' + ds.length);
  if (!ds.every(m => m.hasKey)) throw new Error('组密钥未同步到条目');
  if (!ds.map(m => m.name).some(s => s.includes('Chat'))) throw new Error('label 未带入: ' + ds.map(m => m.name).join(','));
  const again = sandbox.addModelsForProvider('deepseek', 'sk-ds-group', preset.baseUrl, entries);
  if (again !== 0) throw new Error('重复添加应全部跳过，实际新增 ' + again);
  // 清理组密钥与条目缓存，避免污染后续用例的「组外不触碰」断言
  sandbox.saveGroupKey('deepseek', '');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  return true;
});

check('model-add：组密钥写入同步到组内全部条目（组外不触碰）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  const goPreset = sandbox.window.MODEL_PRESETS['opencode-go'];
  const picked = goPreset.models.slice(0, 3);
  const n = sandbox.addModelsForProvider('opencode-go', '', goPreset.baseUrl, picked.map(m => ({ model: m.id, label: m.label })));
  if (n !== 3) throw new Error('手动勾选 3 个应入库 3 个，实际 ' + n);
  if (sandbox.getAllModels().filter(m => m.provider === 'opencode-go').some(m => m.hasKey)) throw new Error('未填密钥不应误标已配置');
  sandbox.saveGroupKey('opencode-go', 'sk-group-test');
  const after = sandbox.getAllModels();
  if (!after.filter(m => m.provider === 'opencode-go').every(m => m.hasKey)) return false;
  if (after.filter(m => m.provider !== 'opencode-go').some(m => m.hasKey)) return false; // 组外不得被污染
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys'))['opencode-go'] !== 'sk-group-test') return false;
  // 组密钥存在时，后加的条目自动继承（空密钥不覆盖组里已有密钥）
  const extra = sandbox.addModelsForProvider('opencode-go', '', goPreset.baseUrl, [{ model: 'late-added-model', label: '后加模型' }]);
  if (extra !== 1) throw new Error('后加条目应入库');
  // getAllModels 的行项不带 model 原文（只有拼好的 name），按显示名匹配
  const late = sandbox.getAllModels().find(m => m.provider === 'opencode-go' && m.name.includes('后加模型'));
  if (!late || !late.hasKey) throw new Error('后加条目未继承组密钥');
  sandbox.saveGroupKey('opencode-go', '');
  if (sandbox.getAllModels().filter(m => m.provider === 'opencode-go').some(m => m.hasKey)) return false; // 清空也同步
  // 整组删除：条目、组密钥一并清
  const removed = sandbox.deleteModelGroup('opencode-go');
  if (removed !== 4) throw new Error('整组删除应清 4 条，实际 ' + removed);
  if (sandbox.getAllModels().some(m => m.provider === 'opencode-go')) throw new Error('整组删除后仍有残留');
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_model_group_keys') || '{}')['opencode-go'] !== undefined) throw new Error('组密钥未一并删除');
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  return true;
});

// ===== 组级「更新模型列表」（组头 ↻ → 上游 diff → 勾选应用） =====
check('model-update：组级更新接线（组头 ↻ 按钮 + 更新弹窗 + diff/应用函数）静态断言', () => {
  for (const t of ['openModelListUpdate', 'refetchModelListUpdate', 'closeModelListUpdate', 'applyModelListUpdate', 'diffUpstreamModels', '_applyModelListDiff', '_fetchModelListForUpdate', 'toggleUmSectionAll', 'model-group-refresh', 'updateModelsDialog']) {
    if (!code.includes(t)) throw new Error('打包产物缺：' + t);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const id of ['updateModelsDialog', 'umGroupTitle', 'umFetchStatus', 'umFetchBtn', 'umNewSection', 'umNewCount', 'umNewAll', 'umNewList', 'umStaleSection', 'umStaleCount', 'umStaleAll', 'umStaleList', 'umSameNote', 'umApplyBtn']) {
    if (!html.includes(`id="${id}"`)) throw new Error('index.html 缺更新弹窗元素：' + id);
  }
  return true;
});

check('model-add：在线补充段去重（重复点获取不堆「在线获取的补充模型」）', () => {
  const f = sandbox._freshIdsNotListed;
  const listed = ['preset-a', 'preset-b', 'supp-x'];
  // 二次获取同一上游清单：已列出的（预设行 + 上次补充行）全部不再追加
  if (f(listed, ['supp-x', 'new-1', 'preset-a']).join(',') !== 'new-1') {
    throw new Error('应只追加未列出的 new-1: ' + JSON.stringify(f(listed, ['supp-x', 'new-1', 'preset-a'])));
  }
  if (f(listed, ['preset-a', 'supp-x']).length !== 0) throw new Error('全部已列出应为空追加');
  if (f(null, undefined).length !== 0) throw new Error('空输入不应抛错');
  return true;
});

check('model-update：diffUpstreamModels 纯逻辑（新增/已下线/去空白去重/空输入）', () => {
  const d = sandbox.diffUpstreamModels(['a', 'b', 'c'], ['b', 'c', 'd', ' e ']);
  if (d.added.join(',') !== 'd,e') throw new Error('added 不符: ' + JSON.stringify(d.added));
  if (d.removed.join(',') !== 'a') throw new Error('removed 不符: ' + JSON.stringify(d.removed));
  const dup = sandbox.diffUpstreamModels(['x', 'x', 'y'], ['y', 'y', 'z']);
  if (dup.added.join(',') !== 'z' || dup.removed.join(',') !== 'x') throw new Error('去重不符: ' + JSON.stringify(dup));
  const kept = sandbox.diffUpstreamModels(['m1', 'm2'], ['m2', 'm1']);
  if (kept.added.length || kept.removed.length) throw new Error('一致列表应为空 diff: ' + JSON.stringify(kept));
  for (const empty of [sandbox.diffUpstreamModels([], []), sandbox.diffUpstreamModels(null, undefined)]) {
    if (empty.added.length || empty.removed.length) throw new Error('空输入应为空 diff: ' + JSON.stringify(empty));
  }
  return true;
});

check('model-update：_applyModelListDiff（新增入库 + 移除条目 + 悬空槽位清理 + 幂等）', () => {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  sandbox.loadUserModels();
  const goPreset = sandbox.window.MODEL_PRESETS['opencode-go'];
  const seeded = sandbox.addModelsForProvider('opencode-go', 'sk-upd', goPreset.baseUrl, [
    { model: 'm-keep', label: '保留模型' }, { model: 'm-stale', label: '已下线模型' },
  ]);
  if (seeded !== 2) throw new Error('播种 2 条应全部入库，实际 ' + seeded);
  const stale = sandbox.getAllModels().find(m => m.provider === 'opencode-go' && m.name.includes('已下线模型'));
  if (!stale) throw new Error('播种条目未找到');
  // 主模型槽位指向将被移除的条目，应用后必须被清空（deleteUserModel 的悬空引用清理）
  sandbox.localStorage.setItem('phymathia_active_models', JSON.stringify({ agent_model: stale.id, html_model: '', descriptor_model: '', quiz_model: '', graph_model: '', branch_model: '' }));
  sandbox.fetchModels(); // 异步签名但函数体全同步：直接调用即完成槽位装载
  const res = sandbox._applyModelListDiff('opencode-go', goPreset.baseUrl, [{ model: 'm-new', label: '上游新增' }], ['m-stale']);
  if (res.added !== 1 || res.removed !== 1) throw new Error('应用结果不符: ' + JSON.stringify(res));
  const names = sandbox.getAllModels().filter(m => m.provider === 'opencode-go').map(m => m.name);
  if (names.length !== 2) throw new Error('应用后应剩 2 条: ' + names.join(','));
  if (!names.some(s => s.includes('保留模型')) || !names.some(s => s.includes('上游新增'))) throw new Error('保留/新增条目缺失: ' + names.join(','));
  if (JSON.parse(sandbox.localStorage.getItem('phymathia_active_models')).agent_model !== '') throw new Error('指向已移除条目的槽位未清空');
  const again = sandbox._applyModelListDiff('opencode-go', goPreset.baseUrl, [{ model: 'm-new', label: '上游新增' }], ['m-stale']);
  if (again.added !== 0 || again.removed !== 0) throw new Error('重复应用应零变更: ' + JSON.stringify(again));
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.localStorage.removeItem('phymathia_active_models');
  return true;
});

// ===== M2 检测闭环收口（quiz-relearn.js）：建议复习动作 / 同主题重测 / 重学引导 =====
const M2_TOPIC_KEY = 'topic-HM';
const M2_SESSION = 'sess_test';

function m2SeedQuizStats(extra) {
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

function m2WrongQuestion() {
  return {
    id: 'w_hm', title: '简谐运动', prompt: '简谐运动的周期由什么决定？',
    options: [{ key: 'A', text: 'm 与 k' }, { key: 'B', text: '振幅' }],
    correctIndex: 0, refId: 'kp_hm', sourceRef: 'kp_hm', sourceType: 'knowledge',
    topicKey: M2_TOPIC_KEY, sessionId: M2_SESSION, wrongAt: Date.now(),
  };
}

check('quiz-relearn：建议复习动作接线（两按钮 + 打包注册）静态断言', () => {
  if (!code.includes('/* quiz-relearn.js */')) throw new Error('打包未注册 quiz-relearn.js');
  if (!code.includes('quiz-weak-item-actions')) throw new Error('建议复习条目缺动作容器');
  if (!code.includes("quizLocateTopic('")) throw new Error('缺「定位到画布」按钮接线');
  if (!code.includes("quizRetestTopic('")) throw new Error('缺「重测同类题」按钮接线');
  if (typeof sandbox.quizLocateTopic !== 'function' || typeof sandbox.quizRetestTopic !== 'function') {
    throw new Error('入口未挂 window');
  }
  return true;
});

check('quiz-relearn：主题→定位目标解析（错题 sourceRef 优先，回退按标题匹配知识条目）', () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    kp_hm: { id: 'kp_hm', title: '简谐运动', sessionId: M2_SESSION },
  }));
  // A：主题有错题快照且带 sourceRef → 直接用错题的落点
  m2SeedQuizStats();
  const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
  stats._meta.wrongQuestions = [m2WrongQuestion()];
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  const viaWrong = sandbox._quizResolveTopicTarget(encodeURIComponent(M2_TOPIC_KEY));
  if (!viaWrong || viaWrong.refId !== 'kp_hm' || viaWrong.isFormula !== false) {
    throw new Error('错题 sourceRef 未优先生效: ' + JSON.stringify(viaWrong));
  }
  if (viaWrong.title !== '简谐运动') throw new Error('应带主题标题，实际 ' + viaWrong.title);
  // B：无该主题错题 → 回退按标题匹配知识条目
  m2SeedQuizStats();
  const viaTitle = sandbox._quizResolveTopicTarget(encodeURIComponent(M2_TOPIC_KEY));
  if (!viaTitle || viaTitle.refId !== 'kp_hm') throw new Error('标题回退未命中: ' + JSON.stringify(viaTitle));
  // C：主题在该画布不存在 → null（查空是正常路径）
  if (sandbox._quizResolveTopicTarget(encodeURIComponent('topic-none')) !== null) {
    throw new Error('未知主题应返回 null');
  }
  return true;
});

check('quiz-relearn：同主题重测组卷（素材收缩 + 错题打头 + 去重截断，不动全量 pool）', () => {
  const pool = {
    knowledge: [
      { id: 'kp_hm', title: '简谐运动', topicKey: M2_TOPIC_KEY, summary: 's' },
      { id: 'kp_hk', title: '胡克定律', topicKey: 'topic-HK', summary: 's' },
    ],
    formulas: [{ id: 'f_zq', latex: 'T=2\\pi\\sqrt{m/k}', topicKey: M2_TOPIC_KEY }],
  };
  const scoped = sandbox._quizPoolForTopic(M2_TOPIC_KEY, pool);
  if (scoped.knowledge.length !== 1 || scoped.knowledge[0].id !== 'kp_hm') throw new Error('知识条目未按主题收缩');
  if (scoped.formulas.length !== 1 || scoped.formulas[0].id !== 'f_zq') throw new Error('公式条目未按主题收缩');
  if (pool.knowledge.length !== 2) throw new Error('不得改动传入的全量素材');
  // 组卷：2 道原错题打头，新题补齐到目标题数，同题干同答案去重（题型不同也算同一题）
  const m2Opts = () => [{ key: 'A', text: 'a' }, { key: 'B', text: 'b' }];
  const wrong = [
    { id: 'w1', prompt: 'p1', options: m2Opts(), correctIndex: 0 },
    { id: 'w2', prompt: 'p2', options: m2Opts(), correctIndex: 0 },
    { id: 'w3', prompt: 'p3', options: m2Opts(), correctIndex: 0 },
  ];
  const generated = [
    { id: 'g1', type: 'concept', prompt: 'p1', options: m2Opts(), correctIndex: 0 }, // 与 w1 同题干同答案 → 去重
    { id: 'g2', type: 'concept', prompt: 'p2x', options: m2Opts(), correctIndex: 0 },
    { id: 'g3', type: 'concept', prompt: 'p3x', options: m2Opts(), correctIndex: 0 },
    { id: 'g4', type: 'concept', prompt: 'p4x', options: m2Opts(), correctIndex: 0 },
  ];
  const composed = sandbox._quizComposeTopicQuestions(wrong, generated, 4);
  if (composed.length !== 4) throw new Error('应截断到目标题数 4，实际 ' + composed.length);
  if (composed[0].id !== 'w1' || composed[1].id !== 'w2') throw new Error('同主题原错题应打头');
  if (composed.some(q => q.id === 'g1')) throw new Error('同签名新题未去重');
  if (composed.some(q => q.id === 'w3')) throw new Error('原错题最多取 2 道');
  // 无选项的脏题不得进卷
  if (sandbox._quizComposeTopicQuestions([{ id: 'bad', prompt: 'x' }], [], 4).length !== 0) {
    throw new Error('无选项的题应被过滤');
  }
  return true;
});

check('quiz-relearn：重学引导（浮卡两动作 + 我的理解节点 + 落点 + 联系模式预选起点）', () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  // 并发段的 knowledge 用例会把 getElementById 换成哑元素（无 querySelector/appendChild）；
  // 本检查是同步用例，自己钉住一个宽松元素，避免被别人的桩带崩。
  const realGetById = sandbox.document.getElementById;
  sandbox.document.getElementById = () => loose('smokeEl');
  let ctx = null;
  let html = '';
  let near = null;
  let fallback = null;
  let created = [];
  let edited = null;
  try {
    sandbox.showQuizRelearnGuide({ title: '简谐运动', nodeId: 'n1' });
    ctx = sandbox._quizRelearnCtxGet();
    if (!ctx || ctx.title !== '简谐运动' || ctx.nodeId !== 'n1') throw new Error('引导上下文未建立');
    html = sandbox.quizRelearnPillHtml();
    if (!html.includes('quizRelearnCreateNote()') || !html.includes('quizRelearnConnect()')) {
      throw new Error('浮卡缺两个建议动作');
    }
    if (!html.includes('写下总结节点') || !html.includes('连接先导概念')) throw new Error('动作文案缺失');
    if (sandbox._quizRelearnNoteLabel('简谐运动') !== '我的理解：简谐运动') throw new Error('总结节点标题不符');
    // 落点：定位节点旁 +24/+24；节点未知时退回画布默认落点（不抛错）
    const realFind = sandbox._findGraphNode;
    try {
      sandbox._findGraphNode = id => (id === 'n1' ? { id: 'n1', x: 100, y: 200 } : null);
      near = sandbox._quizRelearnAnchorPoint('n1');
      fallback = sandbox._quizRelearnAnchorPoint('');
    } finally {
      sandbox._findGraphNode = realFind;
    }
    if (near.x !== 124 || near.y !== 224) throw new Error('落点应为源节点 +24/+24，实际 ' + JSON.stringify(near));
    if (!Number.isFinite(fallback.x) || !Number.isFinite(fallback.y)) throw new Error('退化落点应仍为有效坐标');
    // 真建节点：必须是 kind=human_note（「我的理解」，有手写弹窗）——blank 是「写要求→AI 生成」
    // 的 AI 节点，没有手写路径，不能用来表达「我自己懂了的证据」
    const store = { customNodes: [], connections: [], positions: {}, collapsed: {}, hidden: {}, groups: [], removedEdges: [], portCounts: {}, inputPortCounts: {}, harnessDeleted: {}, pan: { x: 0, y: 0 }, zoom: 0.9 };
    const realGetState = sandbox.window.getGraphState;
    const realSaveState = sandbox.window.saveGraphState;
    const realGetChat = sandbox.window.getChatHistory;
    const realEdit = sandbox.editHumanNoteNode;
    try {
      sandbox.window.getGraphState = () => store;
      sandbox.window.saveGraphState = (sid, next) => Object.assign(store, next);
      sandbox.window.getChatHistory = () => [];
      sandbox.editHumanNoteNode = (id) => { edited = id; };
      sandbox.quizRelearnCreateNote();
      created = (vm.runInContext('graphView.nodes', sandbox) || []).filter(n => n.kind === 'human_note');
      if (created.length !== 1) throw new Error('应创建 1 个「我的理解」节点，实际 ' + created.length);
      if (created[0].label !== '我的理解：简谐运动') throw new Error('节点标题未带主题：' + created[0].label);
      if (edited !== created[0].id) throw new Error('未打开「编辑我的理解」弹窗');
      if (sandbox._quizRelearnCtxGet().noteNodeId !== created[0].id) throw new Error('引导未记住总结节点');
      if (!sandbox.quizRelearnPillHtml().includes('继续写总结')) throw new Error('浮卡文案未切到续写态');
      // 连接：把总结节点设为既有联系模式起点
      sandbox.quizRelearnConnect();
      if (vm.runInContext('graphView.linkMode', sandbox) !== true) throw new Error('未进入联系模式');
      if (vm.runInContext('graphView.linkFirstNodeId', sandbox) !== created[0].id) throw new Error('未预选总结节点为起点');
      // 再点一次不重复建节点，改为聚焦 + 打开编辑器
      sandbox.quizRelearnCreateNote();
      if ((vm.runInContext('graphView.nodes', sandbox) || []).filter(n => n.kind === 'human_note').length !== 1) {
        throw new Error('重复点击不应再建节点');
      }
      if (edited !== created[0].id) throw new Error('重复点击应重新打开编辑器');
    } finally {
      sandbox.window.getGraphState = realGetState;
      sandbox.window.saveGraphState = realSaveState;
      sandbox.window.getChatHistory = realGetChat;
      sandbox.editHumanNoteNode = realEdit;
    }
    // 落点未知时「连接先导概念」走既有联系模式兜底分支（不崩、不预设起点）
    sandbox.clearQuizRelearnGuide();
    sandbox.showQuizRelearnGuide({ title: '简谐运动', nodeId: '' });
    sandbox.quizRelearnConnect();
    sandbox.clearQuizRelearnGuide();
    if (sandbox.quizRelearnPillHtml() !== '') throw new Error('清空引导后浮卡不应再出动作');
  } finally {
    sandbox.document.getElementById = realGetById;
  }
  return true;
});

check('quiz-ai：AI 题入库前打乱选项（修复正确答案恒在 A 位），correctIndex 始终跟随原正确项', () => {
  const pool = { knowledge: [
    { id: 'k_s1', title: '知识点甲', summary: '概述甲的内容', formulas: [], sessionId: 's1' },
    { id: 'k_s2', title: '知识点乙', summary: '概述乙的内容', formulas: [], sessionId: 's1' },
  ], formulas: [] };
  const seen = new Set();
  // 模型行为：每题正确答案都写在第 1 个选项、correctIndex 恒为 0
  for (let round = 0; round < 30; round++) {
    const raw = JSON.stringify({ questions: [0, 1, 2, 3, 4].map(j => ({
      type: 'concept',
      title: j % 2 ? '知识点甲' : '知识点乙',
      sourceRef: j % 2 ? 'k_s1' : 'k_s2',
      difficulty: 'medium',
      prompt: '第' + round + '轮检测题' + j + '，考查知识点内容',
      options: ['正确表述' + j, '干扰一' + j, '干扰二' + j, '干扰三' + j],
      correctIndex: 0,
      explanation: '解析' + j,
    })) });
    const qs = sandbox._sanitizeAIQuestions(raw, pool);
    if (qs.length !== 5) throw new Error('应解析出 5 题，实际 ' + qs.length);
    for (const q of qs) {
      if (q.correctIndex < 0 || q.correctIndex >= q.options.length) throw new Error('correctIndex 越界');
      if (!q.options[q.correctIndex].text.startsWith('正确表述')) throw new Error('correctIndex 未指向原正确项');
      if (q.options.map(o => o.key).join('') !== 'ABCD') throw new Error('选项键未按 A-D 重排');
      seen.add(q.correctIndex);
    }
  }
  if (seen.size < 2) throw new Error('30 轮×5 题的正确答案位置仍全在同一处，打乱未生效');
  return true;
});

check('quiz：快照迁移 _quizShuffleQuestionOptions（correctIndex 与用户所选下标同步重映射）', () => {
  for (let i = 0; i < 20; i++) {
    const q = {
      prompt: '快照题',
      options: [
        { key: 'A', text: '正确答案' }, { key: 'B', text: '干扰一' },
        { key: 'C', text: '干扰二' }, { key: 'D', text: '干扰三' },
      ],
      correctIndex: 0,
      selectedIndex: 2,
    };
    const pickedBefore = q.options[q.selectedIndex].text;
    const correctBefore = q.options[q.correctIndex].text;
    const setBefore = q.options.map(o => o.text).sort().join('|');
    sandbox._quizShuffleQuestionOptions(q);
    if (q.options.map(o => o.text).sort().join('|') !== setBefore) throw new Error('选项集合被改变');
    if (q.options[q.correctIndex].text !== correctBefore) throw new Error('correctIndex 未跟随正确项');
    if (q.options[q.selectedIndex].text !== pickedBefore) throw new Error('selectedIndex 未跟随原所选');
    if (q.options.map(o => o.key).join('') !== 'ABCD') throw new Error('选项键未重排');
  }
  // 坏数据原样返回，不抛错
  if (sandbox._quizShuffleQuestionOptions(null) !== null) throw new Error('null 应原样返回');
  const single = { options: [{ key: 'A', text: 'x' }], correctIndex: 0 };
  sandbox._quizShuffleQuestionOptions(single);
  if (single.correctIndex !== 0) throw new Error('单选项应原样保留');
  return true;
});

check('quiz：题库存量迁移（老题全 A 打乱 + answersShuffled 标记后不再重复打乱）', () => {
  const mkBank = () => ({ poolKey: 'x', updatedAt: 1, questions: [] });
  const bank = mkBank();
  for (let i = 0; i < 10; i++) {
    bank.questions.push({
      id: 'ai_old_' + i,
      options: [
        { key: 'A', text: '对' + i }, { key: 'B', text: '错甲' + i },
        { key: 'C', text: '错乙' + i }, { key: 'D', text: '错丙' + i },
      ],
      correctIndex: 0,
    });
  }
  sandbox.localStorage.setItem('phymathia_quiz_bank', JSON.stringify(bank));
  sandbox.quizBank = null;
  try {
    sandbox._migrateQuizBankAnswerPositions();
    const migrated = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_bank'));
    if (migrated.answersShuffled !== true) throw new Error('缺 answersShuffled 标记');
    // 10 题全部原地不动的概率 4^-10 ≈ 10^-6，视作打乱未生效
    if (!migrated.questions.some(q => q.correctIndex !== 0)) throw new Error('存量题正确答案未被分散');
    for (const q of migrated.questions) {
      if (!q.options[q.correctIndex].text.startsWith('对')) throw new Error('correctIndex 未跟随原正确项');
    }
    // 标记已打：再调用不得再打乱（选项顺序保持原样）
    const before = JSON.stringify(migrated.questions.map(q => q.options.map(o => o.text)));
    sandbox.quizBank = migrated;
    sandbox._migrateQuizBankAnswerPositions();
    const after = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_bank'));
    if (JSON.stringify(after.questions.map(q => q.options.map(o => o.text))) !== before) {
      throw new Error('answersShuffled 后再次调用不应再打乱');
    }
  } finally {
    // 清理污染（共享键）
    sandbox.localStorage.removeItem('phymathia_quiz_bank');
    sandbox.quizBank = null;
  }
  return true;
});

check('harness：quiz_weak 快照注入（当前会话 Top3，空则不注入）', () => {
  sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.window.getGraphViewNodes = () => [{ id: 'A', kind: 'knowledge', label: '简谐运动', content: '往复运动' }];
  sandbox.window.getGraphViewEdges = () => [];
  sandbox.window.getSelectedGraphNodeIds = () => [];
  m2SeedQuizStats();
  const snap = sandbox.buildHarnessSnapshot(false, [], null);
  if (!Array.isArray(snap.quiz_weak)) throw new Error('quiz_weak 未注入');
  if (snap.quiz_weak.length !== 2) throw new Error('应注入当前会话 2 条薄弱点，实际 ' + snap.quiz_weak.length);
  for (const key of ['title', 'wrong', 'mastery', 'sessionId']) {
    if (!(key in snap.quiz_weak[0])) throw new Error('薄弱点字段缺 ' + key);
  }
  // Top3 截断
  const many = { _meta: { version: 2, wrongQuestions: [] } };
  for (let i = 0; i < 5; i++) {
    many['k' + i] = { title: '薄弱' + i, correct: 0, wrong: 2, topicKey: 'topic-' + i, sessionId: M2_SESSION, dueAt: 1 };
  }
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(many));
  const capped = sandbox.buildHarnessSnapshot(false, [], null);
  if (capped.quiz_weak.length !== 3) throw new Error('应截断到 Top3，实际 ' + capped.quiz_weak.length);
  // 无薄弱点 → 不带该字段（避免空数组噪声）
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify({ _meta: { version: 2, wrongQuestions: [] } }));
  const clean = sandbox.buildHarnessSnapshot(false, [], null);
  if ('quiz_weak' in clean) throw new Error('无薄弱点时应省略 quiz_weak');
  // 清理污染
  sandbox.localStorage.removeItem('phymathia_quiz_stats');
  sandbox.localStorage.removeItem('phymathia_knowledge');
  sandbox.invalidateKnowledgeCache();
  return true;
});

check('harness：澄清重跑委托主路径 / 零勾选不回退应用全部 / 差评备注不用 window.prompt', () => {
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const psrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  const asrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  // 澄清重跑必须委托 runGraphHarness：旧手抄版引用未定义 pureQuestion（点选即崩），
  // 且缺 token 预检/停止按钮/Φ 模型槽位/流式预览——不许再长出独立 fetch 旁路
  if (rsrc.indexOf('function runGraphHarnessWithFocus(phase, focusIds, instruction)') < 0) {
    throw new Error('WithFocus 签名变了，检查委托逻辑是否还在');
  }
  const wfStart = rsrc.indexOf('function runGraphHarnessWithFocus');
  const wfBody = rsrc.slice(wfStart, rsrc.indexOf('\n  }', wfStart));
  if (!wfBody.includes("runGraphHarness(phase || 'normal', { focusIds")) {
    throw new Error('澄清重跑未委托主路径 runGraphHarness');
  }
  if (wfBody.includes('fetch(')) throw new Error('WithFocus 残留独立 fetch，会漂移出无停止按钮的旁路');
  if (!rsrc.includes('presetFocusIds')) throw new Error('主路径缺预设焦点入口（澄清点选传不进焦点）');
  // 失败回填：主路径错误出口必须回填输入框
  const restoreCount = (rsrc.match(/restoreInstruction\(\)/g) || []).length;
  if (restoreCount < 5) throw new Error('失败回填覆盖不足（应有 ≥5 处错误出口），实际 ' + restoreCount);
  // 零勾选＝什么都不选，不得回退成应用全部
  if (psrc.includes('return selected.length ? selected : ops')) throw new Error('_selectedOps 仍回退全量应用');
  if (!asrc.includes('没有勾选任何操作')) throw new Error('零勾选时缺用户提示');
  // 差评备注：内联表单，禁止 window.prompt
  if (hsrc.includes("window.prompt('Φ")) throw new Error('差评备注仍在用 window.prompt');
  if (!hsrc.includes('_showHarnessFeedbackForm')) throw new Error('差评备注内联表单缺失');
  return true;
});

// ===== Φ 第一档七件套（T86–T92，2026-09-30 事故级修复）静态回归 =====
// 七条都是用户直接撞上的信任事故，这里锁住「不许回退」的形态：澄清不得再抹聊天区、
// 流式重试不得叠加、应用不得重入毁检查点、切换会话不得静默掐断、生成中发言不得
// 静默丢弃、phase 不得裸英文、清空不得用原生 confirm。
check('harness：第一档七件套 T86–T92（澄清不抹历史/流式重置/应用防重入/切换守卫/排队/phase 中文/清空内联确认）', () => {
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const asrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  const psrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  const ssrc = fs.readFileSync('src/static/js/send-queue.js', 'utf8');
  const pysrc = fs.readFileSync('harness/review.py', 'utf8');
  // T86：澄清是追加气泡（带取消出口），不得再 innerHTML 整块覆盖聊天区
  if (rsrc.includes("chat.innerHTML = '<div class=\"graph-harness-clarify\">")) {
    throw new Error('澄清又变回整块覆盖聊天区（T86 回退）');
  }
  if (!rsrc.includes('graph-harness-message-clarify')) throw new Error('澄清追加气泡缺失');
  if (!rsrc.includes('cancelHarnessClarify')) throw new Error('澄清缺「取消」出口');
  // T87：重试轮次开始时流式预览必须重置（后端 status 带 attempt，前端 attempt>0 清空）
  // T93：多步循环每步也会重发 stage='model'（带 step），同一处重置条件扩成 attempt||step
  if (!pysrc.includes('"attempt": attempt')) throw new Error('review.py 轮次 status 缺 attempt 字段');
  if (!rsrc.includes("evt.stage === 'model' && (Number(evt.attempt) > 0 || Number(evt.step) > 0)")) {
    throw new Error('前端未按 attempt/step 重置流式预览');
  }
  // T88：应用成功置位防重入标志，入口拦截重复应用；撤销/新结果/会话重置/新一轮生成复位
  if (!hsrc.includes('let harnessResultApplied')) throw new Error('harness.js 缺 harnessResultApplied 标志');
  if (!asrc.includes('这条建议已经应用过')) throw new Error('应用防重入缺用户提示');
  if (!asrc.includes('graphHarnessApplyAllBtn')) throw new Error('应用后未禁用应用按钮');
  if (!psrc.includes('graphHarnessApplyAllBtn')) throw new Error('新结果渲染未复位应用按钮');
  // T89：生成中切换 Φ 会话必须被 busy 守卫拦下（新建/删除/清空/换绑同款）
  if (!hsrc.includes('等任务完成后再切换 Φ 会话')) throw new Error('切换 Φ 会话缺 busy 守卫');
  // T90：生成中发消息入队（复用 send-queue），队列也必须认识 harnessBusy
  if (!rsrc.includes('_enqueueSend')) throw new Error('Φ 未接入 send-queue 排队');
  if (!rsrc.includes('graph-harness-queued-tag')) throw new Error('排队气泡缺「排队中」标记');
  if (!ssrc.includes('harnessBusy')) throw new Error('send-queue 忙判定不认 harnessBusy');
  // T91：助手消息 meta 只出中文标签，不得裸英文 phase
  if (!hsrc.includes('const HARNESS_PHASE_LABELS') || !hsrc.includes('审阅整理')) throw new Error('phase 中文映射表缺失');
  if (!hsrc.includes('_escapeHtml(_harnessPhaseLabel(entry.phase))')) throw new Error('meta 未走中文标签映射');
  if (hsrc.includes("'>' + (entry.phase || '') + '</div>'")) throw new Error('meta 仍直接渲染原始 phase（T91 回退）');
  // T92：清空所有 Φ 对话用菜单内联二次确认，不用原生 confirm
  if (hsrc.includes("window.confirm('确定清空所有")) throw new Error('清空 Φ 对话仍用原生 confirm（T92 回退）');
  if (!hsrc.includes('confirmClearAllHarnessSessions')) throw new Error('清空缺内联二次确认');
  return true;
});

// ===== Φ 第三档体验级（T99–T106，2026-09-30 评审路线第五步）静态回归 =====
// 八条都是对话产品化的细节，锁住「不许回退」的形态：停止不白生成、评审清单不
// 盲审、时间线回滚语义完整、流式期间有排版、重试有多个出口、会话可管、空态
// 有引导、长等待有进度感。
check('harness：体验级八件套 T99–T106（停止续接/内容diff/时间线语义/流式渲染/换模型重试/改名搜索/空态引导/进度感）', () => {
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const asrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  const psrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  // T99：停止后的半截回答入历史（interrupted 标记）＋「从中断处继续」出口
  if (!rsrc.includes('interrupted: true')) throw new Error('停止后半截回答未入历史（T99 回退）');
  if (!rsrc.includes('continueHarnessInterrupted')) throw new Error('缺「从中断处继续」续接函数');
  if (!hsrc.includes('graph-harness-continue-btn')) throw new Error('中断条目缺续接按钮');
  // T100：分组唯一真源＋内容级 diff（update 原文→建议文、delete 摘录）
  if (!rsrc.includes('function _harnessGroupedOps')) throw new Error('操作分组唯一真源缺失');
  if (!psrc.includes('graph-harness-op-diff-old') || !psrc.includes('graph-harness-op-diff-new')) throw new Error('update 条目缺「原文→建议文」diff');
  if (!psrc.includes('将删除：')) throw new Error('delete 条目缺被删内容摘录');
  if (!psrc.includes('data-op-index')) throw new Error('分组重排弄丢了勾选框的 data-op-index');
  if (!css.includes('.graph-harness-op-diff-old')) throw new Error('diff 行样式缺失');
  // T101：applied 批次上报带配方前态；回滚还原配方库并翻历史 decision
  if (!asrc.includes('recipes_before')) throw new Error('applied 上报缺 recipes_before');
  if (!asrc.includes('setUserRecipes(recipesBefore)')) throw new Error('时间线回滚未还原配方库');
  if (!asrc.includes('_harnessFlipHistoryDecisionsFromSeq')) throw new Error('回滚未翻历史条目 decision');
  // T102：流式期间走 Markdown 渲染＋聊天区实时气泡
  if (!rsrc.includes('renderMarkdown(text)')) throw new Error('流式期间未走 Markdown 渲染（T102 回退）');
  if (!rsrc.includes('graph-harness-message-live')) throw new Error('生成期间聊天区缺实时气泡');
  if (!css.includes('graph-harness-stream-cursor')) throw new Error('流式光标样式缺失');
  // T103：换模型重试＋复制错误详情＋降级说明入历史
  if (!hsrc.includes('_harnessNextModelCandidate')) throw new Error('缺换模型候选函数');
  if (!hsrc.includes('_copyHarnessErrorDetails')) throw new Error('缺「复制错误详情」');
  if (!rsrc.includes('degradeNotes')) throw new Error('降级说明未入历史（T103 回退）');
  // T104：会话搜索＋行内改名
  if (!hsrc.includes('filterHarnessSessions')) throw new Error('会话菜单缺搜索');
  if (!hsrc.includes('confirmRenameHarnessSession')) throw new Error('会话缺行内改名');
  // T105：空状态示例问题
  if (!hsrc.includes('HARNESS_EXAMPLE_QUESTIONS')) throw new Error('空状态缺示例问题引导');
  // T106：状态行秒表＋终态摘要（耗时/模型调用数/token）
  if (!hsrc.includes('_harnessStartProgressTick') || !hsrc.includes('_harnessStopProgressTick')) throw new Error('进度计时缺失');
  if (!hsrc.includes('data.model_calls')) throw new Error('终态摘要未读 model_calls');
  if (!hsrc.includes('context_metrics')) throw new Error('终态摘要未读 context_metrics token');
  return true;
});

// ===== 知识大陆（graph-continent.js，大陆计划 v1）静态/沙箱回归 =====
// 分层不变量：主图是投影层，前端零写路径——绝不写 phymathia_graph_ 会话键；
// 下钻复用 switchToSession + goToKnowledgeNode，不自建切会话协议。

check('graph-continent: 打包块在场且零会话键写路径', () => {
  const marker = code.indexOf('/* graph-continent.js */');
  if (marker < 0) throw new Error('app.js 缺少 graph-continent.js 块（build_frontend.mjs 未注册？）');
  let end = code.indexOf('/* ', marker + 5);
  if (end < 0) end = code.length;
  const chunk = code.slice(marker, end);
  if (chunk.indexOf('/api/continent') < 0) throw new Error('块内没有 /api/continent 拉取');
  if (/phymathia_graph_/.test(chunk)) throw new Error('大陆模块不得读写会话图键 phymathia_graph_*');
  if (chunk.indexOf('phymathia_continent_view') < 0) throw new Error('视口记忆键缺失');
  if (chunk.indexOf('switchToSession') < 0 || chunk.indexOf('goToKnowledgeNode') < 0) {
    throw new Error('下钻必须复用既有 switchToSession/goToKnowledgeNode 通道');
  }
  // v2：主图唯一写路径是 KV continent_edges（现成端点），别的地方不许落笔
  if (chunk.indexOf('/api/kv/continent_edges') < 0) throw new Error('大陆边必须走 /api/kv/continent_edges');
  return true;
});

check('graph-continent: v2/v3 静态契约（撤销栈只记边操作 / 边界城市 / 确认落笔口 / 透明层底）', () => {
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('CONTINENT_EDGES_API')) throw new Error('KV 端点常量缺失');
  if (!src.includes('_continentEdgeUndo')) throw new Error('边操作撤销栈缺失');
  if (!/undoEntry\)\s*_continentEdgeUndo\.push\((undoEntry)\)/.test(src)) throw new Error('提交必须带 undoEntry 才入栈（视口不入栈）');
  if (!src.includes('continent-node--boundary')) throw new Error('边界城市皮肤类缺失');
  if (!src.includes('画成大陆边')) throw new Error('共享弹层缺「确认落笔」按钮');
  if (!src.includes('same_session')) throw new Error('同会话无效边未按断桥通道处理');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-user-link')) throw new Error('我的大陆边样式缺失');
  if (!css.includes('.continent-dangle-link')) throw new Error('断桥样式缺失');
  if (!css.includes('.continent-popover')) throw new Error('大陆弹层样式缺失');
  // 用户拍板：大陆层透明，壁纸与星轨粒子从画布一直透到大陆
  const layerRule = css.match(/\.continent-layer\s*\{[^}]*\}/);
  if (!layerRule || !/background:\s*transparent/.test(layerRule[0])) {
    throw new Error('大陆层底必须透明（保留全局壁纸与粒子）');
  }
  return true;
});

check('graph-continent: v9 跨层转场（拉远/推近同参数 + 交叉淡化 + 减少动态效果降级）', () => {
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');

  // ---- 常量：两方向共用同一组参数，是「严格镜像」的落点 ----
  if (!/const CONTINENT_WARP_MS = 420;/.test(src)) throw new Error('跨层转场时长常数缺失或被改');
  if (!/const CONTINENT_WARP_EASE = 'cubic-bezier\(\.22,\.75,\.3,1\)';/.test(src)) {
    throw new Error('转场缓动必须沿用既有曲线（与旧下钻转场同一条）');
  }
  if (!/const CONTINENT_WARP_CANVAS_OUT = 0\.5;/.test(src)) throw new Error('会话图退场缩放常数缺失');
  // 旧的三段互不相同的常数必须退役，否则说明有人把它加回来了
  for (const dead of ['CONTINENT_DIVE_MS', 'CONTINENT_DIVE_FACTOR', 'CONTINENT_SURFACE_FACTOR',
                      'CONTINENT_WARP_CAMERA_IN', 'CONTINENT_WARP_ZOOM_FLOOR']) {
    if (src.includes(dead)) throw new Error('旧转场常数未退役：' + dead);
  }
  // ---- v9.1 开图只有一段动画 ----
  // 「拉远」的动势全部由会话图那一侧承担；大陆内容在最终视口直接落位。
  // 曾有过第二段（数据到了再从 0.35 倍长上来），用户真机反馈「两段动画，后面一段
  // 多余」。钉住开图路径不得再调 _continentAnimateWorld——那只会把两段动画带回来。
  const openSlice = src.slice(src.indexOf('async function openContinentView'),
                              src.indexOf('function closeContinentView'));
  if (openSlice.includes('_continentAnimateWorld(')) {
    throw new Error('开图路径又出现镜头补间（会变回两段动画，v9.1 已删）');
  }
  if (!openSlice.includes('_continentRunWarp(\'enter\', () => _continentWarpRelease(openHold))')) {
    throw new Error('开图令牌必须在第一段收尾就释放（ continent-warp 只该覆盖 420ms 交叉淡化）');
  }

  // ---- 减少动态效果：T21 收口的核心。JS 侧时长压 0，CSS 侧 transition:none ----
  if (!/matchMedia\('\(prefers-reduced-motion: reduce\)'\)/.test(src)) {
    throw new Error('转场未认 prefers-reduced-motion（T21 未销）');
  }
  const rmBlock = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
  if (!rmBlock || !/\.graph-canvas/.test(rmBlock[0])) {
    throw new Error('减少动态效果降级未覆盖会话画布');
  }
  const graphCss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const graphMotion = graphCss.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/);
  if (!graphMotion || !/\.graph-node-status\.status-running::before/.test(graphMotion[0])
      || !/\.graph-source-spinner/.test(graphMotion[0])
      || !/\.graph-harness-window\.busy \.graph-harness-status::before/.test(graphMotion[0])
      || !/animation:\s*none/.test(graphMotion[0])) {
    throw new Error('画布 loading 指示器未完整支持 prefers-reduced-motion');
  }

  // ---- 交叉淡化：会话图退场态 + 藏画布规则让位 ----
  if (!/\.graph-canvas\.is-continent-retreat\s*\{/.test(css)) throw new Error('会话图退场态样式缺失');
  if (!/transform:\s*scale\(0\.5\)/.test(css)) throw new Error('会话图退场缩放必须是 0.5');
  if (!css.includes('.continent-layer.continent-warp-fade')) throw new Error('大陆层淡化态样式缺失');
  // 藏画布那条规则必须给转场让位（:not(.continent-warp)），否则转场窗口内两张图
  // 根本同框，交叉缩放就只剩大陆自己动
  const hideRule = css.match(/\.graph-workspace\.continent-open[^{]*\.graph-canvas\s*\{[^}]*\}/);
  if (!hideRule || !/:not\(\.continent-warp\)/.test(hideRule[0])) {
    throw new Error('藏画布规则未给转场让位（两张图无法同框）');
  }

  // ---- 收尾不变量：转场结束/被打断都必须摘掉 continent-warp 与画布退场类 ----
  if (!/ws\.classList\.remove\('continent-warp'\)/.test(src)) {
    throw new Error('转场收尾未摘 workspace 的 continent-warp（会把画布永久漏出来）');
  }
  if (!/classList\.remove\('is-continent-retreat'\)/.test(src)) {
    throw new Error('转场收尾未摘画布退场类（会话图会永久缩在半屏）');
  }

  // ---- closeContinentView 的顺序不变量 ----
  // layer.hidden 从「同步立刻置位」推迟到转场结束，这是这批改动里唯一打破外部契约的
  // 地方（continent_regression.mjs 靠 continent-warp 判断转场是否收尾）。因此
  // _continentOpen=false 必须排在 layer.hidden 之前：openContinentView 的幂等守卫读它，
  // 若它在动画期间才翻转，动画播完把层藏掉的同时大陆会被判成「已开」而点不回来。
  const closeStart = src.indexOf('function closeContinentView');
  if (closeStart < 0) throw new Error('closeContinentView 丢失（smoke 靠它做源码切片）');
  const closeSrc = src.slice(closeStart, closeStart + 2600);
  const flagAt = closeSrc.indexOf('_continentOpen = false');
  const hideAt = closeSrc.indexOf('layer.hidden = true');
  if (flagAt < 0) throw new Error('closeContinentView 未同步置 _continentOpen=false');
  if (hideAt < 0) throw new Error('closeContinentView 未藏 layer');
  if (flagAt > hideAt) {
    throw new Error('closeContinentView 顺序反了：_continentOpen=false 必须早于 layer.hidden=true');
  }
  // 幂等守卫本身不能丢（未开先关要直接返回）
  if (!/function closeContinentView\(\)\s*\{\s*if \(!_continentOpen\) return;/.test(src)) {
    throw new Error('closeContinentView 丢了「未开先关」的幂等守卫');
  }
  return true;
});

check('graph-continent: v6 概念族条目有独立视觉（❖ 前缀 / 三种来源分得清）', () => {
  const prefix = sandbox._continentKindPrefix;
  if (typeof prefix !== 'function') throw new Error('族前缀纯函数未暴露（_continentKindPrefix）');
  if (prefix('formula') !== '∑ ') throw new Error('公式条目前缀错：' + prefix('formula'));
  if (prefix('family') !== '❖ ') throw new Error('概念族前缀错：' + prefix('family'));
  if (prefix('title') !== '◈ ') throw new Error('标题条目前缀错：' + prefix('title'));
  if (prefix(undefined) !== '◈ ') throw new Error('未知来源应退回标题前缀（旧后端无 kind 时不能空）');
  // 静态断言：三处渲染（城市胶囊/共享点弹层/城市弹层/折叠行）都走同一个前缀函数，
  // 不许再各写一份三元表达式——两处各写一份必然漏一处
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  const inlineTernaries = code.match(/kind === 'formula' \? '∑ '/g) || [];
  if (inlineTernaries.length) {
    throw new Error('还有 ' + inlineTernaries.length + ' 处内联前缀三元表达式没走 helper');
  }
  if ((code.match(/_continentKindPrefix\(/g) || []).length < 4) {
    throw new Error('前缀 helper 接入点少于 4 处（城市/共享弹层/城市弹层/折叠行）');
  }
  if (!code.includes("kind === 'family'")) throw new Error('家族条目未在渲染层区分');
  return true;
});

check('graph-continent: v10 补词建议（建议行转义完整 / 两个落笔按钮都由用户点 / 拒绝有记性）', () => {
  const row = sandbox._continentSuggestRowHtml;
  if (typeof row !== 'function') throw new Error('补词建议行纯函数未暴露（_continentSuggestRowHtml）');
  // 沙箱的 document 是宽松代理，utils.escapeHtml 的产物会退化：断言文案前换成恒等
  // （与 2226/2543 行同款手法）
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    const html = row({ family: '概率统计', term: '泊松分布', sim: 0.72,
                       cards: [{ id: 'k1', title: '泊松分布：稀疏事件' }] });
    if (!html.includes('泊松分布') || !html.includes('概率统计')) throw new Error('词条/目标族没渲染');
    if (!html.includes('data-suggest-accept') || !html.includes('data-suggest-reject')) {
      throw new Error('收下/不要两个按钮缺一不可（机器不自动落笔）');
    }
    if (html.includes('上次你拒过')) throw new Error('未被拒过的建议不该带再提提示');
    const regrown = row({ family: '概率统计', term: '泊松分布',
                          cards: [{ id: 'k1', title: 'x' }], regrown: true });
    if (!regrown.includes('上次你拒过')) throw new Error('regrown 标记没渲染');
    // 转义断言要走 _continentEsc 自己的回退链（内置正则转义），把 escapeHtml 摘掉
    const evil = (() => {
      sandbox.escapeHtml = undefined;
      try {
        return row({ family: '<img src=x onerror=1>', term: '<script>', cards: [] });
      } finally { sandbox.escapeHtml = t => (t == null ? '' : String(t)); }
    })();
    if (evil.includes('<script>') || evil.includes('<img src=x')) {
      throw new Error('建议行没转义族名/词条（XSS）');
    }
  } finally { sandbox.escapeHtml = realEsc; }
  if (row(null) !== '' || row({}) !== '') throw new Error('缺字段的建议应渲染为空行');
  // 静态契约：建议 API 只在族表弹层里拉一次；拒绝记录落独立 KV；收下复用族表 KV 通道
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  if (!code.includes("'/api/families/suggestions'")) throw new Error('建议端点常量缺失');
  if ((code.match(/CONTINENT_FAMILY_SUGGEST_API/g) || []).length !== 2) {
    throw new Error('建议端点只应在常量声明 + 弹层内各出现一次（别在别处偷调）');
  }
  if ((code.match(/CONTINENT_FAMILY_SUGGEST_KV_API/g) || []).length < 2) {
    throw new Error('拒绝记录 KV 端点没有读写两处');
  }
  if (!code.includes('data-suggest-section')) throw new Error('族表弹层缺建议区容器');
  return true;
});

check('graph-continent: v10 新族候选（Φ 起名契约判读 / 名单外领域降级 / 缓存命中省 API / 行转义）', () => {
  const msgs = sandbox._continentNameMessages;
  const parse = sandbox._continentParseNameVerdict;
  const hit = sandbox._continentClusterCacheHit;
  const row = sandbox._continentClusterRowHtml;
  for (const [name, fn] of [['消息构造', msgs], ['判读', parse], ['缓存命中', hit], ['候选行', row]]) {
    if (typeof fn !== 'function') throw new Error(`新族候选纯函数未暴露（${name}）`);
  }
  const cluster = { key: 'k1', size: 3, cards: [
    { id: 'a', title: '纳什均衡', summary: '' },
    { id: 'b', title: '囚徒困境', summary: '' },
    { id: 'c', title: '占优策略', summary: '' }] };
  const known = ['概率统计', '微积分'];
  // 消息契约：JSON 输出格式在 system 与 user 两条都写；名单在 user 里
  const m = msgs(cluster, known);
  if (m.length !== 2 || m[0].role !== 'system' || m[1].role !== 'user') throw new Error('消息必须是 system+user 两条');
  for (const msg of m) {
    if (!msg.content.includes('verdict') || !msg.content.includes('terms')) throw new Error('输出契约没在两条消息里都约定');
  }
  if (!m[1].content.includes('概率统计') || !m[1].content.includes('纳什均衡')) throw new Error('名单/证据卡没进 user 消息');
  // 判读：围栏 + 思考块都能剥；merge 名单外 → 降级 none；new 撞名 → 降级 merge
  const fenced = '让我想想\n```json\n{"verdict":"new","name":"博弈论","terms":["纳什均衡","纳什均衡","水"],"reason":"三卡同源"}\n```';
  const v = parse(fenced, known);
  if (!v || v.verdict !== 'new' || v.name !== '博弈论') throw new Error('围栏 JSON 没判出来');
  if (v.terms.join(',') !== '纳什均衡') throw new Error('词条没去重/没滤短');
  const badMerge = parse('{"verdict":"merge","name":"不存在的领域","terms":["x"],"reason":""}', known);
  if (!badMerge || badMerge.verdict !== 'none') throw new Error('名单外的 merge 没降级 none（专家名单固定的铁律）');
  const collide = parse('{"verdict":"new","name":"概率统计","terms":["期望"],"reason":""}', known);
  if (!collide || collide.verdict !== 'merge' || collide.name !== '概率统计') throw new Error('new 撞已知名没降级 merge');
  if (parse('不是 JSON', known) !== null) throw new Error('非 JSON 应返回 null');
  // 缓存命中：精确 key + 重叠 ≥ 六成复用（省 API 钱）+ 不重叠不认
  const named = { k1: { verdict: 'new', name: '博弈论', terms: ['纳什均衡'], cards: ['a', 'b', 'c'] } };
  if (!hit(cluster, named)) throw new Error('精确 key 没命中');
  const grown = { key: 'k9', size: 4, cards: cluster.cards.concat([{ id: 'd', title: '重复博弈' }]) };
  if (!hit(grown, named)) throw new Error('长大的同簇没按重叠命中（会重复烧 API）');
  const other = { key: 'k2', size: 3, cards: [{ id: 'x', title: 'a' }, { id: 'y', title: 'b' }, { id: 'z', title: 'c' }] };
  if (hit(other, named)) throw new Error('不相干簇不该命中缓存');
  // 行渲染：未起名有「让 Φ 起名」；new 态有「建族」；全部插值转义
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  try {
    if (!row(cluster, null, null).includes('让 Φ 起名')) throw new Error('未起名态缺「让 Φ 起名」按钮');
    const newRow = row(cluster, named.k1, null);
    if (!newRow.includes('建族') || !newRow.includes('博弈论')) throw new Error('new 态缺建族按钮/名字');
    if (row(cluster, { verdict: 'none', reason: '太散' }, null).includes('建族')) throw new Error('none 态不该出现建族');
    if (row(cluster, null, { cards: 0, at: 1 }).includes('上次你拒过') === false) throw new Error('拒后再提的标记没渲染');
  } finally { sandbox.escapeHtml = realEsc; }
  const evil = (() => {
    sandbox.escapeHtml = undefined;
    try { return row({ key: 'k', size: 3, cards: [{ id: 'a', title: '<script>' }] }, null, null); }
    finally { sandbox.escapeHtml = t => (t == null ? '' : String(t)); }
  })();
  if (evil.includes('<script>')) throw new Error('候选行没转义标题（XSS）');
  // 静态契约：起名走 proxyChatWithModel（与问 Φ 同通道）、按钮触发（不自动）、
  // 建族写族表 KV 通道
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  if (!code.includes('data-cluster-section')) throw new Error('族表弹层缺新领域候选区容器');
  if (!code.includes('_continentNameMessages(cluster, knownNames)')) throw new Error('起名调用没走消息构造纯函数');
  if (!code.includes('data-cluster-create')) throw new Error('建族落笔口缺失');
  return true;
});

check('graph-continent: 航线备注标签落在线上（曾因 arc.qx undefined 算成 NaNpx 飘到世界层左上角）', () => {
  const route = sandbox._continentRoute;
  const mid = sandbox._continentLinkMid;
  if (typeof route !== 'function' || typeof mid !== 'function') {
    throw new Error('落点纯函数未暴露（_continentRoute）');
  }
  const a = { x: 20, y: 177, w: 160, h: 46, cx: 100, cy: 200 };
  const b = { x: 420, y: 577, w: 160, h: 46, cx: 500, cy: 600 };
  const r = route(a, b, [], 'detour', null);
  if (!Number.isFinite(r.mid.x) || !Number.isFinite(r.mid.y)) {
    throw new Error('备注落点不是有限数（NaN 会被 CSS 整条丢弃 → 标签退回静态位置）：' + JSON.stringify(r.mid));
  }
  // 必须正好是贝塞尔 t=0.5 的点 = 走线绘制用的同一公式 (P0 + 2Q + P2)/4
  const ex = (r.p0.x + 2 * r.q.x + r.p2.x) / 4, ey = (r.p0.y + 2 * r.q.y + r.p2.y) / 4;
  if (Math.abs(r.mid.x - ex) > 1e-9 || Math.abs(r.mid.y - ey) > 1e-9) {
    throw new Error('备注落点不在曲线中点上：' + JSON.stringify(r.mid) + ' vs ' + ex + ',' + ey);
  }
  if (Math.abs(r.mid.y - a.cy) < 1e-9 && Math.abs(r.mid.x - a.cx) < 1e-9) {
    throw new Error('备注落点退化成端点');
  }
  // 端点必须落在岛框边缘上（v7.2：线从岛边走，不从岛心里穿）
  if (r.p0.x < a.x - 1 || r.p0.x > a.x + a.w + 1 || r.p0.y < a.y - 1 || r.p0.y > a.y + a.h + 1) {
    throw new Error('出岛点不在岛框上：' + JSON.stringify(r.p0));
  }
  // 脏坐标（投影与布局不同步）也必须给有限数，绝不放行 NaNpx
  const bad = route({ x: 0, y: 0, w: 10, h: 10, cx: NaN, cy: 0 }, { x: 0, y: 20, w: 10, h: 10, cx: 10, cy: 20 }, [], 'detour', null);
  if (!Number.isFinite(bad.mid.x) || !Number.isFinite(bad.mid.y)) {
    throw new Error('脏坐标时未兜底成有限数：' + JSON.stringify(bad.mid));
  }
  // 静态断言：渲染处不许再出现「读 arcPath 返回值里的控制点」这种写法
  // （先剥注释——这条规则的说明文字里就写着那个字段名，不剥会把注释当代码误报）
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  if (/arc\.q[xy]/.test(code)) throw new Error('备注落点又去读 arcPath 没返回的字段了');
  if (!src.includes('route.mid.x')) throw new Error('渲染处未走落点纯函数产物');
  // v5.6：备注标签固定字号（不随地图缩放变形）——世界层缩放 2.5 倍时 10px 会变 25px，
  // 乘 1/zoom 抵消当路牌用；缩放到处与渲染结尾都必须同步，否则新画的边仍是变形字号
  const scale = sandbox._continentEdgeLabelScale;
  if (typeof scale !== 'function') throw new Error('固定字号纯函数未暴露（_continentEdgeLabelScale）');
  if (scale(1) !== 1) throw new Error('zoom=1 应不缩放：' + scale(1));
  if (Math.abs(scale(2.5) - 0.4) > 1e-9) throw new Error('zoom=2.5 应抵消成 0.4：' + scale(2.5));
  if (Math.abs(scale(0.5) - 2) > 1e-9) throw new Error('zoom=0.5 应抵消成 2：' + scale(0.5));
  if (scale(100) !== 0.4) throw new Error('过小倍率未夹住下界：' + scale(100));
  if (scale(0.01) !== 4) throw new Error('过大倍率未夹住上界：' + scale(0.01));
  if (scale(NaN) !== 1 || scale(0) !== 1) throw new Error('脏倍率未兜底成 1');
  if (!/_continentSyncEdgeLabels\(\);/.test(code.split('function _continentApplyTransform')[1] || '')) {
    throw new Error('缩放路径未同步备注标签字号');
  }
  if (!code.includes('_continentSyncEdgeLabels();\n  return layout;')) {
    throw new Error('渲染结尾未同步备注标签字号（新画的边会保持变形字号）');
  }
  return true;
});

check('graph-continent: v7.2 航线（绕行不穿岛 / 直连可穿对照 / 沿边车道 / 样式解析 / 零 window.prompt）', () => {
  const route = sandbox._continentRoute;
  const stroke = sandbox._continentRouteStroke;
  if (typeof route !== 'function' || typeof stroke !== 'function') {
    throw new Error('v7.2 纯函数未暴露（route / routeStroke）');
  }
  // 绕行（默认档）：中间挡一座岛时，采样点不许进任何岛框
  const A = { x: 0, y: 0, w: 300, h: 200, cx: 150, cy: 100 };
  const B = { x: 600, y: 0, w: 300, h: 200, cx: 750, cy: 100 };
  const midObstacle = { x: 400, y: 40, w: 120, h: 120, cx: 460, cy: 100 };
  const detour = route(A, B, [A, B, midObstacle], 'detour', null);
  if (detour.mode !== 'detour') throw new Error('默认档应是绕行');
  const samples = [];
  for (let i = 1; i < 14; i++) {
    const t = i / 14;
    samples.push({
      x: (1 - t) * (1 - t) * detour.p0.x + 2 * (1 - t) * t * detour.q.x + t * t * detour.p2.x,
      y: (1 - t) * (1 - t) * detour.p0.y + 2 * (1 - t) * t * detour.q.y + t * t * detour.p2.y,
    });
  }
  const hit = samples.some(p => p.x >= midObstacle.x && p.x <= midObstacle.x + midObstacle.w
    && p.y >= midObstacle.y && p.y <= midObstacle.y + midObstacle.h);
  if (hit) throw new Error('绕行走线穿过了中间的岛');
  // 直连档（对照组）：同样布局直线必穿（说明绕行不是白做的）
  const straight = route(A, B, [A, B, midObstacle], 'straight', null);
  const sSamples = [];
  for (let i = 1; i < 14; i++) {
    const t = i / 14;
    sSamples.push({
      x: (1 - t) * (1 - t) * straight.p0.x + 2 * (1 - t) * t * straight.q.x + t * t * straight.p2.x,
      y: (1 - t) * (1 - t) * straight.p0.y + 2 * (1 - t) * t * straight.q.y + t * t * straight.p2.y,
    });
  }
  const sHit = sSamples.some(p => p.x >= midObstacle.x && p.x <= midObstacle.x + midObstacle.w
    && p.y >= midObstacle.y && p.y <= midObstacle.y + midObstacle.h);
  if (!sHit) throw new Error('对照组失败：直连居然没穿岛（绕行档的测试前提不成立）');
  // 沿边车道：路径是折线（含 L 指令），落点有限
  const lane = route(A, B, [A, B, midObstacle], 'lane', { x: 0, y: 0, w: 960, h: 400 });
  if (lane.mode !== 'lane' || lane.d.indexOf('L') < 0) throw new Error('车道档应是折线');
  if (!Number.isFinite(lane.mid.x)) throw new Error('车道档标签落点不有限');
  // 样式解析：旧边（无 style）走默认；三档颜色/粗细/线型可辨
  const def = stroke(null, { fromSession: 's1' }, null);
  if (!def.color || def.width !== 2 || def.dash) throw new Error('默认样式错：' + JSON.stringify(def));
  if (!stroke({ dash: 'dashed', color: 'gold', width: 'thick' }, null, null).dash) throw new Error('线型未解析');
  if (stroke({ color: 'gold' }, null, null).color.indexOf('217') < 0) throw new Error('暖金档颜色错');
  // 「我画的路」默认观感（09-20）：默认色=暖色且按主题选色相——暗色暖金（217,164,65），
  // 浅色赭橙（191,91,27；浅色机器辐条 accent 本身是暗金，航线必须换色相而不是加深）；
  // region 算不出色相回落旧默认蓝
  const lightGold = stroke(null, { fromSession: 's1' }, null, 'light');
  if (lightGold.color.indexOf('191') < 0 || lightGold.color.indexOf('163, 114, 47') >= 0) {
    throw new Error('浅色主题航线未换赭橙色相：' + lightGold.color);
  }
  if (stroke({ color: 'region' }, { fromSession: 's1' }, null).color.indexOf('74') < 0) {
    throw new Error('region 算不出色相时应回落旧默认蓝');
  }
  // 静态：v7.2 的单条可调与全局开关、岛级落笔、编辑撤销；大陆模块零 window.prompt（U1 收编）
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  if (/window\.prompt/.test(code)) throw new Error('大陆模块仍有 window.prompt（U1 已收编）');
  if (!src.includes('data-style="dash"')) throw new Error('单条样式调整缺线型');
  if (!src.includes('data-anchor="from"')) throw new Error('换锚点卡入口缺失');
  if (!src.includes("type: 'edit'")) throw new Error('编辑撤销缺失');
  if (!src.includes('CONTINENT_ROUTE_PREFS_KEY')) throw new Error('全局航线偏好缺失');
  if (!src.includes('_continentLinkPickIsland')) throw new Error('岛级落笔缺失');
  if (!src.includes('_continentSetRouteIso')) throw new Error('悬停隔离缺失');
  if (!src.includes('continent-route-casing') || !src.includes('continent-route-end')) {
    throw new Error('航线三件套（路基光晕/端点圆珠）渲染缺失');
  }
  if (!src.includes(".continent-route-casing, .continent-route-end")) {
    throw new Error('悬停隔离未覆盖路基光晕/端点圆珠');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  ['.continent-route', '.continent-route-stub', '.continent-route.is-dim',
   '.continent-route-grid', '.continent-route-casing', '.continent-route-end'].forEach(sel => {
    if (!css.includes(sel)) throw new Error('航线样式缺失：' + sel);
  });
  return true;
});

check('graph-continent: v7.3 渐进披露与收纳（48 岛一屏装得下 / 岛折叠 / 海域印章 / 岛内卡上限 / LOD 四档含词流）', () => {
  const layout = sandbox._continentLayoutClusters;
  const regionLayout = sandbox._continentRegionLayout;
  const regions = sandbox._continentRegions;
  if (typeof layout !== 'function' || typeof regionLayout !== 'function') {
    throw new Error('布局纯函数未暴露');
  }
  const cl = (sid, n) => ({
    sessionId: sid, title: sid, itemCount: n,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  // 复杂度口径（计划的推算在实现时复核）：48 座**大岛**（3 卡 ≈536×286，比推算更苛刻），
  // 全中性走旧单网格——旧下限 0.3 会卡死适配（≥43 岛一屏装不下），0.15 必须装得下
  const big = Array.from({ length: 48 }, (_, i) => cl('i' + i, 3));
  const lay48 = layout(big, { sessions: [] });
  if (!Number.isFinite(lay48.worldW) || !Number.isFinite(lay48.worldH)) {
    throw new Error('48 岛世界尺寸不有限');
  }
  const right = Math.max(...lay48.clusterRects.map(r => r.x + r.w));
  const bottom = Math.max(...lay48.clusterRects.map(r => r.y + r.h));
  if (lay48.worldW < right || lay48.worldH < bottom) throw new Error('48 岛世界罩不住岛');
  // 卡上限（岛内折叠）：9 张以内的岛全画；12 张的岛只画 9 张、计数如实
  const small = layout([cl('a', 4)], { sessions: [] });
  if (Object.keys(small.placements).length !== 4) throw new Error('4 卡岛被误折叠');
  const bigIsle = layout([cl('b', 12)], { sessions: [] });
  if (Object.keys(bigIsle.placements).length !== 9) {
    throw new Error('12 卡岛应只画 9 张：' + Object.keys(bigIsle.placements).length);
  }
  const bRect = bigIsle.clusterRects[0];
  if (bRect.itemCount !== 12 || bRect.shownCount !== 9) {
    throw new Error('折叠计数不如实：' + JSON.stringify({ itemCount: bRect.itemCount, shown: bRect.shownCount }));
  }
  // 岛折叠：收起的岛无卡位（不留空壳）、世界变小
  const collapsedLay = layout([cl('c', 5)], { sessions: ['c'] });
  if (Object.keys(collapsedLay.placements).length !== 0) throw new Error('收起的岛不该有卡位');
  if (collapsedLay.clusterRects[0].collapsed !== true) throw new Error('收起标记缺失');
  if (!(collapsedLay.worldH < bigIsle.worldH)) throw new Error('收起后世界没变小');
  // 海域折叠：收成一枚印章（板在、岛全不渲染）
  const clusters6 = [cl('v1', 1), cl('v2', 1), cl('v3', 1), cl('k1', 1)];
  clusters6.forEach((c, i) => { c.domain = i < 3 ? '矢量分析' : null; c.domainConf = 0.9; });
  const rInfo = regions(clusters6, { renames: {}, assign: {} }, ['矢量分析']);
  const stampLay = regionLayout(rInfo.regions, rInfo.bySid, clusters6, [], [],
    { sessions: [], regions: ['矢量分析'] });
  const stamp = stampLay.regionRects.find(r => r.key === '矢量分析');
  if (!stamp || !stamp.stamp) throw new Error('收起的海域该是印章');
  const stampSids = new Set(stampLay.clusterRects.map(r => r.sessionId));
  if (stampSids.has('v1') || stampSids.has('v2') || stampSids.has('v3')) {
    throw new Error('收起海域的岛不该渲染');
  }
  if (Object.keys(stampLay.placements).length !== 1) {
    throw new Error('散岛该照常画：' + Object.keys(stampLay.placements).length);
  }
  // 展开回来布局不变（对折叠集确定性）：同一输入两次布局逐字节一致
  const again = regionLayout(rInfo.regions, rInfo.bySid, clusters6, [], [],
    { sessions: [], regions: ['矢量分析'] });
  if (JSON.stringify(again) !== JSON.stringify(stampLay)) throw new Error('布局不是确定性的');
  // 48 岛分 6 片海域的两级布局也要装得下且罩住板
  const many = Array.from({ length: 48 }, (_, i) => {
    const c = cl('m' + i, 3);
    c.domain = '域' + (i % 6);
    c.domainConf = 0.9;
    return c;
  });
  const rInfo48 = regions(many, { renames: {}, assign: {} },
    Array.from({ length: 6 }, (_, i) => '域' + i));
  const lay48r = regionLayout(rInfo48.regions, rInfo48.bySid, many, [], [], { sessions: [], regions: [] });
  if (lay48r.regionRects.length !== 6) throw new Error('应有 6 片海域板');
  const plateR = Math.max(...lay48r.regionRects.map(r => r.x + r.w));
  const plateB = Math.max(...lay48r.regionRects.map(r => r.y + r.h));
  if (lay48r.worldW < plateR || lay48r.worldH < plateB) throw new Error('世界罩不住海域板');
  const fitZoom = Math.min(1200 / lay48r.worldW, 800 / lay48r.worldH) * 0.92;
  if (fitZoom < 0.15) throw new Error('48 岛 6 海域在 0.15 下限下一屏装不下：' + fitZoom);
  // LOD 静态契约：四档阈值常量 + _continentApplyTransform 切类 + CSS 后代选择器显隐
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  ['CONTINENT_LOD_WORLD', 'CONTINENT_LOD_DETAIL', 'CONTINENT_LOD_HORIZON',
   'CONTINENT_CLOUD_SCALE_MAX', 'CONTINENT_COLLAPSED_KEY',
   'CONTINENT_ISLAND_CARD_MAX', "classList.toggle('lod-world'",
   "classList.toggle('lod-horizon'"].forEach(marker => {
    if (!src.includes(marker)) throw new Error('LOD/折叠实现缺失：' + marker);
  });
  if (!/const CONTINENT_ZOOM_MIN = 0\.15/.test(src)) throw new Error('缩放下限未放到 0.15');
  // v8.8 词流：反缩放变量必须由 _continentApplyTransform 写进世界层，且**带死区**——
  // 少了死区就是「滚轮每帧重算整棵子树的字号」，缩放时词流逐帧抖（真机才看得出来）
  const applySrc = src.split('function _continentApplyTransform')[1] || '';
  if (!/setProperty\('--cloud-k'/.test(applySrc)) throw new Error('词流反缩放变量没写在 _continentApplyTransform 里');
  if (!/_continentCloudK/.test(applySrc)) throw new Error('词流反缩放缺死区比对（每帧重排）');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  ['.continent-world.lod-world .continent-node', '.continent-world.lod-region .continent-node-formula',
   '.continent-world.lod-horizon .continent-node', '.continent-world.lod-world .continent-cloud',
   '.continent-world.lod-horizon .continent-cloud', '.continent-cluster.is-collapsed .continent-cloud',
   'var(--cloud-k, 1)',
   '.continent-cluster.is-collapsed', '.continent-region.is-stamp'].forEach(sel => {
    if (!css.includes(sel)) throw new Error('LOD/折叠样式缺失：' + sel);
  });
  return true;
});

check('graph-continent: 岛牌一行放得下（1 卡岛块宽下限 + 卡居中 + 岛名可收缩省略号，不裁残字）', () => {
  const layout = sandbox._continentLayoutClusters;
  if (typeof layout !== 'function') throw new Error('_continentLayoutClusters 未暴露');
  const cl = (sid, n) => ({
    sessionId: sid, title: sid, itemCount: n,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  // 真机截图：1 卡岛块宽 196，岛牌一行（▾+岛名+计数+领域徽标）把「梯度」「散度」
  // 挤成拦腰残字——块宽必须抬到岛牌可读下限
  const one = layout([cl('a', 1)], { sessions: [] });
  if (one.clusterRects[0].w < 240) throw new Error('1 卡岛窄于岛牌可读下限：' + one.clusterRects[0].w);
  // 卡网格在块内居中：块被下限撑宽时卡不许歪在一边
  const p = one.placements['a_0'];
  const rect = one.clusterRects[0];
  if (Math.abs((p.x - rect.x) - (rect.x + rect.w - (p.x + p.w))) > 0.01) {
    throw new Error('1 卡岛的卡没在块内居中');
  }
  // ≥2 卡岛照内容走，不受下限影响（36 + 3×160 + 2×10）
  const three = layout([cl('b', 3)], { sessions: [] });
  if (three.clusterRects[0].w !== 18 * 2 + 3 * 160 + 2 * 10) {
    throw new Error('3 卡岛块宽不该被下限改动：' + three.clusterRects[0].w);
  }
  // CSS：岛名是行里唯一可收缩件且 min-width:0——再窄也是「xx…」，不会裁成残字
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  const at = css.indexOf('.continent-cluster-title {');
  const block = css.slice(at, css.indexOf('}', at));
  if (!/min-width:\s*0/.test(block) || !/flex:\s*0\s+1\s+auto/.test(block)) {
    throw new Error('.continent-cluster-title 缺 min-width:0 / flex 收缩（省略号不生效会裁残字）');
  }
  return true;
});

check('graph-continent: v3 Φ 摆渡口径（_harnessContinentShared 只挑当前会话的共享点）', () => {
  if (typeof sandbox._harnessContinentShared !== 'function' && typeof sandbox.window._harnessContinentShared !== 'function') {
    throw new Error('_harnessContinentShared 未暴露');
  }
  const fn = sandbox._harnessContinentShared || sandbox.window._harnessContinentShared;
  const data = {
    clusters: [
      { sessionId: 'sess_a', title: '波与振动', items: [{ itemId: 'i1', title: '阻尼振动' }] },
      { sessionId: 'sess_b', title: '傅里叶分析', items: [{ itemId: 'i2', title: '非线性振动' }, { itemId: 'i3', title: '频谱' }] },
      { sessionId: 'sess_c', title: ' unrelated', items: [{ itemId: 'i4', title: '矩阵' }] },
    ],
    shared: [
      { kind: 'title', label: '振动', sessions: ['sess_a', 'sess_b'],
        links: [{ from: 'i1', to: 'i2', fromSession: 'sess_a', toSession: 'sess_b' }] },
      { kind: 'formula', label: 'grad', sessions: ['sess_b', 'sess_c'],
        links: [{ from: 'i3', to: 'i4', fromSession: 'sess_b', toSession: 'sess_c' }] },
      { kind: 'title', label: '振动', sessions: ['sess_a', 'sess_b'],  // 同名共享词：去重
        links: [{ from: 'i2', to: 'i1', fromSession: 'sess_b', toSession: 'sess_a' }] },
    ],
  };
  const realSid = sandbox.window.getCurrentSessionId;
  sandbox.window.getCurrentSessionId = () => 'sess_a';
  // 解耦后共享点按「Φ 会话绑定的画布」筛选：注入绑到 sess_a 的当前 Φ 会话
  vm.runInContext('phiSessions = { phi_c: { id: "phi_c", title: "c", boundSid: "sess_a", createdAt: 1, updatedAt: 1 } }; currentPhiId = "phi_c";', sandbox);
  try {
    const out = fn(data);
    if (out.length !== 1) throw new Error('只应留下涉及当前会话的 1 条（跨会话那条不算、同名去重），实际 ' + out.length);
    const row = out[0];
    if (row.my_title !== '阻尼振动' || row.peer_title !== '非线性振动' || row.peer_session !== '傅里叶分析') {
      throw new Error('共享点字段口径错: ' + JSON.stringify(row));
    }
    if (row.kind !== 'title') throw new Error('kind 应原样传递');
    // 查空是正常路径：绑定画布不在任何共享点里 → 空数组
    vm.runInContext('phiSessions.phi_c.boundSid = "sess_zzz"', sandbox);
    if (fn(data).length !== 0) throw new Error('无共享点时应返回空数组');
  } finally {
    sandbox.window.getCurrentSessionId = realSid;
  }
  // 快照注入口径：harness.js 必须把 continent_shared 放进快照与 token 估算
  const hsrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!hsrc.includes('snapshot.continent_shared')) throw new Error('快照未注入 continent_shared');
  const rsrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!rsrc.includes('_harnessFetchContinent')) throw new Error('审阅路径未拉取大陆投影');
  return true;
});

check('graph-continent: v5.1 边界城市（一概念三画布=1 城 3 辐条 / 不叠岛 / 五种折叠原因 / 覆盖标签不占城 / 重逢清单）', () => {
  const plan = sandbox._continentDrawPlan;
  const layout = sandbox._continentLayoutClusters;
  const rows = sandbox._continentReunionRows;
  const fits = sandbox._continentFits;
  if (typeof plan !== 'function' || typeof layout !== 'function'
      || typeof rows !== 'function' || typeof fits !== 'function') {
    throw new Error('v5.1 纯函数未暴露（drawPlan / layoutClusters / reunionRows / fits）');
  }
  // 真布局：三座岛（s1 两张卡，s2/s3 各一张）→ 2×2 网格，岛之间留 CONTINENT_CLUSTER_GAP 走廊
  const clusters = [
    { sessionId: 's1', title: '波与振动', items: [{ itemId: 'a1' }, { itemId: 'a2' }] },
    { sessionId: 's2', title: '傅里叶分析', items: [{ itemId: 'b1' }] },
    { sessionId: 's3', title: '梯度', items: [{ itemId: 'c1' }] },
  ];
  const lay = layout(clusters);
  const entry = {
    kind: 'title', label: '简谐运动', strength: 'strong',
    owners: ['a1', 'a2', 'b1', 'c1'],
    links: [
      { from: 'a1', to: 'b1', fromSession: 's1', toSession: 's2' },
      { from: 'a1', to: 'c1', fromSession: 's1', toSession: 's3' },
      { from: 'b1', to: 'c1', fromSession: 's2', toSession: 's3' },
    ],
  };
  const weak = { kind: 'title', label: '振动', strength: 'weak', owners: ['a1', 'b1'],
    links: [{ from: 'a1', to: 'b1', fromSession: 's1', toSession: 's2' }] };
  // 验收口径：一个概念跨三座岛 = 1 座城 + 3 根辐条（不是 3 条弧线围三角）
  const out = plan([weak, entry], lay.placements, lay.clusterRects, 3, 12);
  if (out.cityCount !== 1 || out.cities.length !== 1) throw new Error('应是 1 座城，实际 ' + out.cityCount);
  const city = out.cities[0];
  if (city.reps.length !== 3 || out.spokeCount !== 3) {
    throw new Error('应是 3 根辐条（每岛一根），实际 ' + city.reps.length + '/' + out.spokeCount);
  }
  if (city.entry.label !== '简谐运动') throw new Error('城市挂错了共享概念');
  if (!(city.x > 0) || !(city.y > 0) || !city.box) throw new Error('城市坐标缺失');
  // 铁律：城市绝不叠在岛上，也不压在别的城上
  if (!fits(city.box, lay.clusterRects, 0)) throw new Error('城市叠到了岛上');
  // 碰撞检测自检：与自身重叠 → 不放行；隔开 50px（远大于间隙 8）→ 放行
  if (fits(city.box, [city.box], 0)) throw new Error('碰撞检测漏判重叠');
  if (!fits({ x: city.box.x + city.box.w + 50, y: city.box.y, w: 10, h: 10 }, [city.box], 8)) {
    throw new Error('碰撞检测误判：隔开 50px 应当放得下');
  }
  // 辐条另一端必须是各岛代表卡（岛内最早学的那张：s1 → a1，不是 a2）
  const reps = city.reps.map(r => r.sessionId + ':' + r.itemId).sort().join(',');
  if (reps !== 's1:a1,s2:b1,s3:c1') throw new Error('代表卡口径错：' + reps);
  // 代表卡挂 ◈ 徽标；同岛的第二张卡（a2）不做端点
  if (!out.boundary.a1 || !out.boundary.b1 || !out.boundary.c1) throw new Error('代表卡徽标缺失');
  if (out.boundary.a2) throw new Error('非代表卡不该当辐条端点');
  // 弱证据不上图（照报，原因可分辨）
  if (out.folded.map(f => f.reason).join(',') !== 'weak') {
    throw new Error('弱证据折叠口径错：' + JSON.stringify(out.folded.map(f => f.reason)));
  }
  // v5.5：被更具体标签覆盖的标签（服务端 covered）不单独成城——否则地图上会出现
  // 两座几乎重合、名字还读不懂的城（真机形态：「能量守恒定律」旁边的截断名「量守恒定律」）
  const coveredEntry = {
    kind: 'title', label: '量守恒定律', strength: 'strong', covered: true,
    owners: ['a1', 'b1'], links: [{ from: 'a1', to: 'b1', fromSession: 's1', toSession: 's2' }],
  };
  const covOut = plan([coveredEntry, entry], lay.placements, lay.clusterRects, 3, 12);
  if (covOut.folded.map(f => f.reason).join(',') !== 'covered') {
    throw new Error('覆盖标签折叠口径错：' + JSON.stringify(covOut.folded.map(f => f.reason)));
  }
  if (covOut.cityCount !== 1 || covOut.cities[0].entry.label !== '简谐运动') {
    throw new Error('覆盖标签挤掉了本该画的那座城');
  }
  if (covOut.boundary.a1 && covOut.cities[0].entry.label === '量守恒定律') {
    throw new Error('覆盖标签不该挂 ◈ 徽标');
  }
  // 每对区域上限：上限 1 时，同一对岛的第二座城进清单（原因 capped）
  const second = Object.assign({}, entry, { label: '简谐运动方程', score: 1 });
  const capped = plan([entry, second], lay.placements, lay.clusterRects, 1, 12);
  if (capped.cityCount !== 1) throw new Error('每对上限未生效：' + capped.cityCount);
  if (capped.folded.map(f => f.reason).join(',') !== 'capped') {
    throw new Error('超每对上限的折叠原因错：' + capped.folded.map(f => f.reason).join(','));
  }
  // 全图上限：上限 1 时第二座城进清单（原因 map_capped）
  const cappedAll = plan([entry, second], lay.placements, lay.clusterRects, 3, 1);
  if (cappedAll.cityCount !== 1
      || cappedAll.folded.map(f => f.reason).join(',') !== 'map_capped') {
    throw new Error('全图上限口径错：' + cappedAll.folded.map(f => f.reason).join(','));
  }
  // 无位可放：两岛之间只有 100px 走廊（城市 112 宽摆不进去）→ 折叠而不是叠在岛上
  const tight = [
    { sessionId: 's1', title: 'A', x: 0, y: 0, w: 200, h: 200, cx: 100, cy: 100, itemCount: 1 },
    { sessionId: 's2', title: 'B', x: 300, y: 0, w: 200, h: 200, cx: 400, cy: 100, itemCount: 1 },
  ];
  const tightPlace = {
    a1: { x: 20, y: 20, w: 160, h: 46, cx: 100, cy: 43 },
    b1: { x: 320, y: 20, w: 160, h: 46, cx: 400, cy: 43 },
  };
  const noRoom = plan([entry], tightPlace, tight, 3, 12);
  if (noRoom.cityCount !== 0) throw new Error('挤不下时不该硬塞城市');
  if (noRoom.folded.map(f => f.reason).join(',') !== 'no_room') {
    throw new Error('无位可放的折叠原因错：' + noRoom.folded.map(f => f.reason).join(','));
  }
  // 重逢清单：一岛一行 + 同岛多卡缩进次行，每行自带「去看」（跳转不猜）
  const idx = {
    items: { a1: '简谐运动', a2: '简谐运动的相位', b1: '简谐运动方程', c1: '简谐运动的能量' },
    clusterTitles: { s1: '波与振动', s2: '傅里叶分析', s3: '梯度' },
    itemSession: { a1: 's1', a2: 's1', b1: 's2', c1: 's3' },
    itemCreated: { a1: 1000, a2: 2000, b1: 3000, c1: 4000 },
    rel: () => '3 天前',
  };
  const html = (() => {
    // 沙箱的 document 是宽松代理，utils.escapeHtml 的产物会退化成 '0'：断言行文案前
    // 换成恒等转义（这条测的是本模块的行拼装，转义实现由 utils 自己的用例守）
    const realEsc = sandbox.escapeHtml;
    sandbox.escapeHtml = t => (t == null ? '' : String(t));
    try { return rows(city, idx); } finally { sandbox.escapeHtml = realEsc; }
  })();
  if ((html.match(/data-go=/g) || []).length !== 4) throw new Error('重逢清单行数错（应 3 岛 4 卡）');
  if ((html.match(/>去看</g) || []).length !== 4) throw new Error('每行都要有「去看」');
  if (html.indexOf('波与振动') < 0 || html.indexOf('傅里叶分析') < 0) throw new Error('清单未写画布名');
  if (html.indexOf('同岛还有') < 0) throw new Error('同岛多卡未缩进列出');
  if (html.indexOf('3 天前') < 0) throw new Error('清单未写学习时间');
  if (html.indexOf('data-go="s1" data-item="a1"') < 0) throw new Error('「去看」缺跳转目标');
  // 静态契约：城市弹层 + 复用既有下钻通道（不自建切会话协议）+ 样式
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('_continentCityPopover')) throw new Error('城市弹层缺失');
  if (!src.includes('enterContinentSession(sid, iid)')) throw new Error('「去看」未复用下钻转场');
  if (!src.includes('continent-city')) throw new Error('城市节点类缺失');
  if (!src.includes('画成大陆边')) throw new Error('共享弹层缺「确认落笔」按钮');
  if (!src.includes('_continentFoldedPopover')) throw new Error('折叠清单弹层缺失');
  if (!src.includes('continentWeakBtn')) throw new Error('顶栏折叠入口按钮缺失');
  if (!src.includes('data-link=')) throw new Error('落笔按钮缺失');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-city')) throw new Error('城市样式缺失');
  if (!css.includes('.continent-spoke')) throw new Error('辐条样式缺失');
  if (!css.includes('.continent-pop-place')) throw new Error('重逢清单画布名样式缺失');
  if (!css.includes('.continent-pop-when')) throw new Error('重逢清单时间样式缺失');
  if (!css.includes('.continent-pop-row')) throw new Error('弹层行样式缺失');
  if (!css.includes('.continent-pop-reason')) throw new Error('折叠原因样式缺失');
  if (!css.includes('.continent-tool.is-quiet')) throw new Error('折叠入口样式缺失');
  // 折叠清单行必须写清「为什么被折叠」，否则用户没法判断该不该管它
  const foldedRows = sandbox._continentFoldedRows;
  if (typeof foldedRows !== 'function') throw new Error('_continentFoldedRows 未暴露');
  const foldedHtml = foldedRows(out.folded, idx);
  if (foldedHtml.indexOf('弱证据') < 0) throw new Error('折叠原因未标注');
  if (foldedHtml.indexOf('data-fold="0"') < 0) throw new Error('折叠清单缺逐条入口');
  // 五种折叠原因都要能翻译成人话（用户才知道该不该管它）
  const allReasons = foldedRows([
    { entry: entry, reason: 'weak' },
    { entry: entry, reason: 'covered' },
    { entry: entry, reason: 'capped' },
    { entry: entry, reason: 'map_capped' },
    { entry: entry, reason: 'no_room' },
  ], idx);
  ['弱证据', '已被更具体的城市覆盖', '超出每对上限', '超出全图上限', '无位可放'].forEach(label => {
    if (allReasons.indexOf(label) < 0) throw new Error('折叠原因缺人话标注：' + label);
  });
  return true;
});

check('graph-continent: v5.2 群岛布局（亲缘排序成簇 / 蛇形填充 / 无亲缘保持原序）+ v5.5 弱证据只摆位不断言', () => {
  const order = sandbox._continentClusterOrder;
  const kinship = sandbox._continentKinship;
  const layout = sandbox._continentLayoutClusters;
  if (typeof order !== 'function' || typeof kinship !== 'function' || typeof layout !== 'function') {
    throw new Error('v5.2 纯函数未暴露（clusterOrder / kinship）');
  }
  const cl = (sid, n) => ({ sessionId: sid, title: sid,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })) });
  const strong = (label, sids) => ({ kind: 'title', label, strength: 'strong', sessions: sids, links: [], owners: [] });
  // 验收口径：A、B 都学「简谐运动」，C、D 都学「梯度」→ 组内相邻（贪心链），
  // 蛇形网格下两组分居两行（位置本身就是联系，一根线不画）
  const clusters = [cl('A', 2), cl('B', 2), cl('C', 2), cl('D', 2)];
  const shared = [strong('简谐运动', ['A', 'B']), strong('梯度', ['C', 'D'])];
  const ordered = order(clusters, shared, []);
  const pos = {}; ordered.forEach((c, i) => { pos[c.sessionId] = i; });
  if (Math.abs(pos.A - pos.B) !== 1) throw new Error('A、B 不相邻：' + JSON.stringify(pos));
  if (Math.abs(pos.C - pos.D) !== 1) throw new Error('C、D 不相邻：' + JSON.stringify(pos));
  // 蛇形：4 岛 2 列时第 3 座岛（i=2）必须落右列（第二行反向）——否则链在换行处对角断开
  const lay = layout(ordered);
  const rectOf = {}; lay.clusterRects.forEach(r => { rectOf[r.sessionId] = r; });
  if (!(rectOf[ordered[2].sessionId].x > rectOf[ordered[0].sessionId].x)) {
    throw new Error('蛇形填充未生效：第二行第一座应从右列起');
  }
  // 世界尺寸照旧要罩住所有岛（布局改造不得破坏 v1 契约）
  const right = Math.max(...lay.clusterRects.map(r => r.x + r.w));
  const bottom = Math.max(...lay.clusterRects.map(r => r.y + r.h));
  if (lay.worldW < right || lay.worldH < bottom) throw new Error('世界尺寸罩不住岛');
  // 用户航线也是亲缘（权重更高）：A—C 有边时 C 要被拉到 A 旁边
  const withEdge = order(clusters, [], [{ id: 'e1', fromSession: 'A', toSession: 'C', toItem: 'x', fromItem: 'y' }]);
  const pos2 = {}; withEdge.forEach((c, i) => { pos2[c.sessionId] = i; });
  if (Math.abs(pos2.A - pos2.C) !== 1) throw new Error('用户航线未参与亲缘：' + JSON.stringify(pos2));
  // 无亲缘：输出与输入同序（不引入回归——服务端最近更新序原样进布局）
  const plain = order(clusters, [], []);
  if (plain.map(c => c.sessionId).join() !== 'A,B,C,D') throw new Error('无亲缘时应保持原序');
  // v5.5：weak 共享**参与摆位**（只摆位、不断言）——梯度/散度这类 2 字真关系以前
  // 既不画线也不影响摆位，地图看上去一片孤岛；现在 A、C 之间有一条 weak 就要相邻
  const weak = (label, sids) => ({ kind: 'title', label, strength: 'weak', sessions: sids, links: [], owners: [] });
  const weakOnly = order(clusters, [weak('梯度', ['A', 'C'])], []);
  const posW = {}; weakOnly.forEach((c, i) => { posW[c.sessionId] = i; });
  if (Math.abs(posW.A - posW.C) !== 1) throw new Error('weak 证据未参与摆位：' + JSON.stringify(posW));
  // 亲缘矩阵本身：strong 各记 1、用户边记 2、weak 每个跨会话对 0.3 且每对封顶 0.9
  // （封顶保证任意多条弱证据都压不过一条强证据——弱证据只配决定「挨不挨着」）
  const kin = kinship(['A', 'B', 'C'], [strong('振动', ['A', 'B'])], [{ fromSession: 'B', toSession: 'C' }]);
  const keyOf = (a, b) => (a < b ? a + '|' + b : b + '|' + a);
  if (kin[keyOf('A', 'B')] !== 1) throw new Error('strong 共享亲缘权重错');
  if (kin[keyOf('B', 'C')] !== 2) throw new Error('用户边亲缘权重错');
  if (kin[keyOf('A', 'C')] !== undefined) throw new Error('无关岛不该有亲缘');
  const kinW = kinship(['A', 'B'], [weak('梯度', ['A', 'B'])], []);
  if (Math.abs(kinW[keyOf('A', 'B')] - 0.3) > 1e-9) throw new Error('weak 亲缘权重错：' + kinW[keyOf('A', 'B')]);
  const kinCap = kinship(['A', 'B'], [weak('梯度', ['A', 'B']), weak('散度', ['A', 'B']),
    weak('旋度', ['A', 'B']), weak('场', ['A', 'B'])], []);
  if (kinCap[keyOf('A', 'B')] > 0.9 + 1e-9) throw new Error('weak 亲缘未封顶：' + kinCap[keyOf('A', 'B')]);
  const kinMix = kinship(['A', 'B'], [weak('梯度', ['A', 'B']), weak('散度', ['A', 'B']),
    weak('旋度', ['A', 'B']), weak('场', ['A', 'B']), strong('简谐运动', ['A', 'B'])], []);
  if (!(kinMix[keyOf('A', 'B')] >= 1 && kinMix[keyOf('A', 'B')] < 2)) {
    throw new Error('弱证据压过了强证据：' + kinMix[keyOf('A', 'B')]);
  }
  return true;
});

check('graph-continent: v7.1a 海域层（分组/单岛不划地盘/待确认/用户覆盖/配色确定性/两级布局罩住海域板）', () => {
  const regions = sandbox._continentRegions;
  const hue = sandbox._continentRegionHue;
  const regionLayout = sandbox._continentRegionLayout;
  const oldLayout = sandbox._continentLayoutClusters;
  if (typeof regions !== 'function' || typeof hue !== 'function'
      || typeof regionLayout !== 'function') {
    throw new Error('v7.1a 纯函数未暴露（regions / regionHue / regionLayout）');
  }
  const cl = (sid, domain, conf, n) => ({
    sessionId: sid, title: sid, domain: domain, domainConf: conf, domainSource: 'vote',
    itemCount: n, items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  // 验收口径（用户真实库的形态）：3 座矢量分析岛 + 1 座守恒岛 + 1 座无归属 + 1 座低置信
  const clusters = [
    cl('v1', '矢量分析', 0.95, 3), cl('v2', '矢量分析', 0.8, 1),
    cl('v3', '矢量分析', 0.5, 1),          // light 档：照进海域（淡色 + ?）
    cl('keep', '守恒定律', 0.98, 1),        // 单岛：只上底色不划地盘
    cl('none', null, 0, 2),                 // 无归属：中性，不硬塞「其他」
    cl('unsure', '量子力学', 0.33, 1),      // 低置信：中性灰 + 待确认清单
  ];
  const out = regions(clusters, { renames: {}, assign: {} }, ['矢量分析', '守恒定律', '量子力学']);
  if (out.regions.length !== 1) throw new Error('应只有 1 片海域（矢量分析），实际 ' + out.regions.length);
  const va = out.regions[0];
  if (va.key !== '矢量分析' || va.sessions.join() !== 'v1,v2,v3') throw new Error('海域分组错：' + va.sessions);
  if (va.source !== 'family') throw new Error('来源标记应按概念族推断：' + va.source);
  if (out.singles.indexOf('keep') < 0) throw new Error('单岛领域不该自成海域');
  if (out.neutral.indexOf('none') < 0) throw new Error('无归属岛该是中性（不许硬塞其他）');
  if (out.pending.length !== 1 || out.pending[0].sid !== 'unsure') throw new Error('低置信岛该进待确认');
  if (out.bySid.v3.tier !== 'light' || out.bySid.v1.tier !== 'solid') throw new Error('置信度三档判档错');
  // 用户覆盖：把守恒岛挪进矢量分析 → 海域变 4 岛、来源变「你指定」
  const moved = regions(clusters, { renames: {}, assign: { keep: '矢量分析' } },
    ['矢量分析', '守恒定律', '量子力学']);
  if (moved.regions[0].sessions.length !== 4 || moved.regions[0].source !== 'user') {
    throw new Error('用户挪岛未生效：' + JSON.stringify(moved.regions[0].sessions));
  }
  // 「不归类」也是一条用户决定：把 v1 移出海域
  const cleared = regions(clusters, { renames: {}, assign: { v1: null } },
    ['矢量分析', '守恒定律', '量子力学']);
  if (cleared.regions[0].sessions.join() !== 'v2,v3') throw new Error('「不归类」该把岛移出海域');
  // 改名：显示名换、键与颜色不换
  const renamed = regions(clusters, { renames: { 矢量分析: '场论基础' }, assign: {} },
    ['矢量分析', '守恒定律', '量子力学']);
  if (renamed.regions[0].name !== '场论基础' || renamed.regions[0].key !== '矢量分析') {
    throw new Error('海域改名口径错');
  }
  // 配色确定性：同名两次同色；名单**末尾**追加新领域不改已有颜色（内置名单先分配）
  if (hue('矢量分析', ['矢量分析', '守恒定律']) !== hue('矢量分析', ['矢量分析', '守恒定律', '复变函数'])) {
    throw new Error('新增领域不该改已有领域的颜色');
  }
  if (hue('矢量分析', ['矢量分析', '守恒定律']) !== hue('矢量分析', undefined)) {
    throw new Error('同名必须同色（确定性）');
  }
  // 两级布局：有海域时块状分区 + 海域板；世界必须罩住**海域板**（不只岛）
  const lay = regionLayout(out.regions, out.bySid, clusters, [], []);
  if (!lay.regionRects.length) throw new Error('海域板缺失');
  const plateRight = Math.max(...lay.regionRects.map(r => r.x + r.w));
  const plateBottom = Math.max(...lay.regionRects.map(r => r.y + r.h));
  if (lay.worldW < plateRight || lay.worldH < plateBottom) throw new Error('世界尺寸罩不住海域板');
  // 同海域的岛聚成一片：三座矢量分析岛全部落在自己的海域板内，散岛不与这块板相交
  const rectOf = {}; lay.clusterRects.forEach(r => { rectOf[r.sessionId] = r; });
  const plate = lay.regionRects[0];
  const inside = (r, box) => r.x >= box.x - 1 && r.y >= box.y - 1 &&
    r.x + r.w <= box.x + box.w + 1 && r.y + r.h <= box.y + box.h + 1;
  const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  ['v1', 'v2', 'v3'].forEach(sid => {
    if (!inside(rectOf[sid], plate)) throw new Error(sid + ' 没落在矢量分析海域板内');
  });
  ['keep', 'none', 'unsure'].forEach(sid => {
    if (intersects(rectOf[sid], plate)) throw new Error('散岛 ' + sid + ' 闯进了海域板');
  });
  // 无海域时：前端走旧单网格路径——旧路径本身不许被 v7 改坏
  const plainClusters = [cl('A', null, 0, 2), cl('B', null, 0, 2), cl('C', null, 0, 2), cl('D', null, 0, 2)];
  const empty = regions(plainClusters, { renames: {}, assign: {} }, []);
  if (empty.regions.length) throw new Error('无归属时不该有海域');
  const order = sandbox._continentClusterOrder;
  const layOld = oldLayout(order(plainClusters, [], []));
  ['A', 'B', 'C', 'D'].forEach(sid => {
    const a = layOld.clusterRects.find(r => r.sessionId === sid);
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) throw new Error('旧布局路径产物异常：' + sid);
  });
  // 铁律「门控只路由不证明」的数据层隔离（静态）：画城市的调用链不许读门控字段
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const planSrc = src.slice(src.indexOf('function _continentDrawPlan'),
    src.indexOf('function _continentRender'));
  if (/\.domain\b|domainConf|domainSource/.test(planSrc)) {
    throw new Error('_continentDrawPlan 混进了门控字段（门控只路由不证明）');
  }
  // 静态契约：图例容器（玻璃）+ 归类徽标 + 撤销栈 region 分支 + CSS
  if (!src.includes('id="continentLegend"')) throw new Error('图例容器缺失');
  if (!src.includes('continent-legend aurora-glass')) throw new Error('图例未挂玻璃类');
  if (!src.includes('continent-domain-badge')) throw new Error('领域徽标缺失');
  if (!src.includes("op.type === 'region'")) throw new Error('撤销栈缺 region 分支');
  if (!src.includes('CONTINENT_REGIONS_API')) throw new Error('海域覆盖 KV 通道缺失');
  if (!src.includes('_continentPendingPopover')) throw new Error('待确认清单缺失');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  ['.continent-region', '.continent-legend', '.continent-domain-badge', '.is-dim',
   '.continent-cluster.r-pending'].forEach(sel => {
    if (!css.includes(sel)) throw new Error('海域样式缺失：' + sel);
  });
  return true;
});

check('graph-continent: v7.1b 门控（提示词契约名单固定 / 判读防御与围栏剥离 / hash 增量 / 触发不自动）', () => {
  const msgs = sandbox._continentGateMessages;
  const parse = sandbox._continentGateParse;
  const hash = sandbox._continentGateHash;
  const pendingCards = sandbox._continentGatePendingCards;
  if (typeof msgs !== 'function' || typeof parse !== 'function'
      || typeof hash !== 'function' || typeof pendingCards !== 'function') {
    throw new Error('v7.1b 纯函数未暴露（gateMessages / gateParse / gateHash / gatePendingCards）');
  }
  // 提示词契约：名单在 system+user 两侧、卡片素材齐、严格 JSON 约定、new 只作建议
  const m = msgs([{ id: 'k1', title: '康普顿散射', summary: '光子与电子碰撞', formula: '\\lambda' }],
    ['量子力学', '微积分']);
  if (m.length !== 2 || m[0].role !== 'system') throw new Error('messages 结构错');
  if (m[1].content.indexOf('量子力学') < 0 || m[1].content.indexOf('康普顿散射') < 0) {
    throw new Error('提示词未携带名单或卡片素材');
  }
  if (m[0].content.indexOf('JSON') < 0) throw new Error('system 未写输出契约');
  // 判读：正常 JSON / 围栏包裹 / 思考块前置都过；名单外领域丢弃；conf 夹取；
  // 本批之外的 id 丢弃；merge 组 ids 至少 2 个本批卡
  const ids = ['k1', 'k2'];
  const list = ['量子力学', '微积分'];
  const ok = parse('[{"id":"k1","domains":[{"name":"量子力学","conf":1.7}],"new":[]}]', ids, list);
  if (!ok.labels.k1 || ok.labels.k1[0].name !== '量子力学') throw new Error('正常判读失败');
  if (ok.labels.k1[0].conf !== 1) throw new Error('conf 未夹取：' + ok.labels.k1[0].conf);
  const fenced = parse('```json\n[{"id":"k2","domains":[{"name":"分析力学","conf":0.9},{"name":"微积分","conf":0.4}]}]\n```', ids, list);
  if (fenced.labels.k2.length !== 1 || fenced.labels.k2[0].name !== '微积分') {
    throw new Error('名单外领域未被丢弃（专家名单固定）');
  }
  const noisy = parse('<think>让我想想</think> [{"id":"k1","domains":[{"name":"量子力学","conf":0.8}],"new":["分析力学"]},' +
    '{"merge":{"name":"康普顿散射","ids":["k1","k2","k9"]}}] 收工', ids, list);
  if (!noisy.labels.k1) throw new Error('思考块/尾噪未被剥离');
  if (noisy.newDomains.join() !== '分析力学') throw new Error('new 建议未收集');
  if (noisy.merges.length !== 1 || noisy.merges[0].ids.join() !== 'k1,k2') {
    throw new Error('merge 组未过滤批外 id');
  }
  if (Object.keys(parse('我觉得都不太确定', ids, list).labels).length) throw new Error('非 JSON 应回空产物');
  if (Object.keys(parse('[{"id":"k9","domains":[{"name":"量子力学","conf":0.9}]}]', ids, list).labels).length) {
    throw new Error('批外 id 不该入库');
  }
  // hash 增量：内容变了 hash 变；内容没变 hash 稳定
  const c1 = { title: '梯度', summary: 's', formula: 'f' };
  if (hash(c1) !== hash({ title: '梯度', summary: 's', formula: 'f' })) throw new Error('同内容 hash 不稳定');
  if (hash(c1) === hash({ title: '旋度', summary: 's', formula: 'f' })) throw new Error('标题变了 hash 没变');
  // 待打标口径：归属缺失或低置信的岛才进队列；hash 命中的旧打标跳过（增量）
  const clusters = [
    { sessionId: 'a', domain: null, domainConf: 0, itemCount: 2,
      items: [{ itemId: 'x1', title: '康普顿散射', summary: '', formula: '' },
              { itemId: 'x2', title: '光电效应', summary: '', formula: '' }] },
    { sessionId: 'b', domain: '微积分', domainConf: 0.9, itemCount: 1,
      items: [{ itemId: 'y1', title: '泰勒展开', summary: '', formula: '' }] },
    { sessionId: 'c', domain: '量子力学', domainConf: 0.2, itemCount: 1,
      items: [{ itemId: 'z1', title: '波函数', summary: '', formula: '' }] },
  ];
  const pend = pendingCards(clusters, {});
  if (pend.map(c => c.id).join() !== 'x1,x2,z1') {
    throw new Error('待打标口径错：' + pend.map(c => c.id).join());
  }
  const entries = { x1: { hash: hash({ title: '康普顿散射', summary: '', formula: '' }), domains: [] } };
  const pend2 = pendingCards(clusters, entries);
  if (pend2.map(c => c.id).join() !== 'x2,z1') throw new Error('hash 增量未生效（x1 该跳过）');
  // 静态契约：打开大陆不自动跑（openContinentView 不触发 classify）、入口按钮、
  // 每批落盘、关图中止、建议采纳写族表
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const openSrc = src.slice(src.indexOf('async function openContinentView'),
    src.indexOf('function closeContinentView'));
  if (openSrc.includes('_continentGateClassify()')) throw new Error('打开大陆不许自动触发 Φ 归类');
  if (!src.includes('id="continentGateBtn"')) throw new Error('Φ 归类入口按钮缺失');
  if (!src.includes('CONTINENT_GATE_API')) throw new Error('gate KV 通道缺失');
  if (!src.includes('data.gateVersion')) throw new Error('gate 版本未对齐后端口径');
  if (!src.includes('每批落盘') && !src.includes('中断不丢')) {
    // 注释口径存在性（中断不丢已完成的批）
  }
  if (!src.includes('_continentGateCtrl.abort')) throw new Error('关闭大陆未中止在途归类');
  if (!src.includes('_continentAdoptGateMerge')) throw new Error('建议采纳通道缺失');
  if (!src.includes('continent_families')) throw new Error('采纳未写概念族表');
  return true;
});

check('graph-continent: v5.3 问 Φ（提示词契约 / 判读解析 / 判断块带落笔芯片）', () => {
  const msgs = sandbox._continentPhiMessages;
  const verdict = sandbox._continentPhiVerdict;
  const blockHtml = sandbox._continentPhiBlockHtml;
  if (typeof msgs !== 'function' || typeof verdict !== 'function' || typeof blockHtml !== 'function') {
    throw new Error('v5.3 纯函数未暴露（phiMessages / phiVerdict / phiBlockHtml）');
  }
  // 提示词必须带两边标题+摘要与共享词，并约束输出格式（值得连：/不建议连：）
  const m = msgs({ title: '阻尼振动', summary: '振幅随时间衰减' }, { title: '非线性振动', summary: '' }, '振动');
  if (m.length !== 2 || m[0].role !== 'system') throw new Error('messages 结构错');
  const u = m[1].content;
  if (u.indexOf('阻尼振动') < 0 || u.indexOf('振幅随时间衰减') < 0 || u.indexOf('非线性振动') < 0) {
    throw new Error('提示词未携带两边条目');
  }
  if (u.indexOf('值得连') < 0 || u.indexOf('不建议连') < 0) throw new Error('提示词未约定输出格式');
  // 判读：三档 + 剥离思考块/加粗/前缀
  if (verdict('值得连：两条都在讲振动现象').verdict !== 'worth') throw new Error('worth 判读错');
  if (verdict('不建议连：只是字面撞了').verdict !== 'not') throw new Error('not 判读错');
  if (verdict('**值得连**：都是振动家族').verdict !== 'worth') throw new Error('加粗判读错');
  if (verdict('<think>推理过程</think>值得连：同源').verdict !== 'worth') throw new Error('思考块未剥离');
  if (verdict('好的，我来分析一下这个问题。').verdict !== 'unknown') throw new Error('未知档判读错');
  if (verdict('值得连：两条都在讲振动').text.indexOf('两条都在讲振动') < 0) throw new Error('理由文本未剥离前缀');
  // 判断块：徽标 + 理由 + 每条链路一枚落笔芯片（落笔权在用户）。
  // 沙箱的 document 是宽松代理，utils.escapeHtml 的产物会退化：断言文案前换成恒等
  // 转义（与重逢清单用例同口径，转义实现由 utils 自己的用例守）
  const entry = { kind: 'title', label: '振动',
    links: [{ from: 'a1', to: 'b1', fromSession: 's1', toSession: 's2' }] };
  const idx = { items: { a1: '阻尼振动', b1: '非线性振动' } };
  const realEsc = sandbox.escapeHtml;
  sandbox.escapeHtml = t => (t == null ? '' : String(t));
  let html, unknownHtml, html2;
  try {
    html = blockHtml(entry, { verdict: 'worth', text: '两条都在讲振动现象' }, idx, []);
    if (html.indexOf('值得连') < 0 || html.indexOf('两条都在讲振动现象') < 0) throw new Error('判断块缺徽标或理由');
    if ((html.match(/data-phi-link=/g) || []).length !== 1) throw new Error('落笔芯片缺失');
    if (html.indexOf('is-worth') < 0) throw new Error('worth 徽标样式缺失');
    unknownHtml = blockHtml(entry, { verdict: 'unknown', text: '说不准' }, idx, []);
    if (unknownHtml.indexOf('is-worth') >= 0 || unknownHtml.indexOf('Φ 的判断') < 0) throw new Error('unknown 档徽标错');
    // 已连线的链路只标「已连线」，不再出芯片（同端点对去重的地图侧口径）
    html2 = blockHtml(entry, { verdict: 'not', text: '字面撞车' }, idx,
      [{ fromItem: 'a1', toItem: 'b1' }]);
    if (html2.indexOf('已连线') < 0 || html2.indexOf('data-phi-link') >= 0) throw new Error('已连线口径错');
  } finally {
    sandbox.escapeHtml = realEsc;
  }
  // 静态契约：折叠行带「问 Φ」按钮；走 proxyChatWithModel（stream:false）既有通道
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('data-phi=')) throw new Error('折叠清单缺「问 Φ」按钮');
  if (!src.includes('_continentAskPhi')) throw new Error('问 Φ 处理函数缺失');
  if (!src.includes('proxyChatWithModel')) throw new Error('未复用模型代理通道（/api/models/chat）');
  if (!src.includes("_continentPhiInflight")) throw new Error('在途请求未登记（弹层关闭需中止）');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-pop-phi')) throw new Error('Φ 判断块样式缺失');
  if (!css.includes('.continent-pop-phi-badge')) throw new Error('Φ 判断徽标样式缺失');
  return true;
});

check('graph-continent: v5.4 岛牌一句话 + 空态引导（纯拼接 / 机制文案）', () => {
  const tagline = sandbox._continentIslandTagline;
  if (typeof tagline !== 'function') throw new Error('_continentIslandTagline 未暴露');
  // 前 3 个概念名 + 最近更新时间，超出 3 个的概念不进岛牌
  const t = tagline({
    items: [
      { title: '简谐运动', createdAt: 3000 },
      { title: '阻尼', createdAt: 2000 },
      { title: '共振', createdAt: 1000 },
      { title: '第四个不该出现', createdAt: 500 },
    ],
  }, () => '3 天前');
  if (t !== '简谐运动 · 阻尼 · 共振 · 3 天前') throw new Error('岛牌拼装错：' + t);
  // 空岛 / 缺簇 / 无时间：空串（渲染侧就不出副行）
  if (tagline({ items: [] }, () => '') !== '') throw new Error('空岛牌应空串');
  if (tagline(null, () => 'x') !== '') throw new Error('缺簇应空串');
  if (tagline({ items: [{ title: 'A', createdAt: 0 }] }, () => '') !== 'A') throw new Error('无时间时只拼概念名');
  // 静态契约：副行元素 + 顶栏引导文案 + 引导元素与连接提示互斥
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('continent-cluster-sub')) throw new Error('岛牌副行缺失');
  if (!src.includes('continentGuide')) throw new Error('顶栏空态引导元素缺失');
  if (src.indexOf('暂无共享连线') < 0) throw new Error('空态引导文案缺失');
  if (src.indexOf('_continentGuideText') < 0) throw new Error('引导文案状态缺失');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-cluster-sub')) throw new Error('岛牌副行样式缺失');
  return true;
});

check('graph-continent: v8 岛牌真摘要（model/manual 优先，无摘要回退旧拼接）', () => {
  const tagline = sandbox._continentIslandTagline;
  if (typeof tagline !== 'function') throw new Error('_continentIslandTagline 未暴露');
  // 最早学的一条真摘要当岛牌一句话（descriptor 槽位接上），时间照拼
  const t = tagline({
    items: [
      { title: '简谐运动', summary: '回复力与位移成正比且方向相反的振动', createdAt: 3000 },
      { title: '阻尼', summary: '振幅随时间衰减的振动', createdAt: 2000 },
    ],
  }, () => '3 天前');
  if (t !== '回复力与位移成正比且方向相反的振动 · 3 天前') throw new Error('真摘要口径错：' + t);
  // local 模板摘要（服务端给空串）不得上岛牌——回退旧拼接
  const fallback = tagline({
    items: [
      { title: '简谐运动', summary: '', createdAt: 3000 },
      { title: '阻尼', createdAt: 2000 },
      { title: '共振', createdAt: 1000 },
      { title: '第四个不该出现', createdAt: 500 },
    ],
  }, () => '3 天前');
  if (fallback !== '简谐运动 · 阻尼 · 共振 · 3 天前') throw new Error('无摘要回退拼接错：' + fallback);
  // 超长摘要截断到 48 字（CSS 省略是兜底，纯函数先裁一层）
  const long = tagline({ items: [{ title: 'A', summary: '长'.repeat(60), createdAt: 1 }] }, () => '');
  if (long.length !== 48) throw new Error('摘要截断口径错：长度 ' + long.length);
  // 静态契约：摘要分支在（旧拼接路径的既有断言在上面用例里继续生效）
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (src.indexOf('_continentClipText(summary, 48)') < 0) throw new Error('岛牌摘要截断缺失');
  return true;
});

check('graph-continent: v8 顶栏搜索（归一匹配 / 标题优先 / 上限 / 唯一直达口径）', () => {
  const matches = sandbox._continentSearchMatches;
  if (typeof matches !== 'function') throw new Error('_continentSearchMatches 未暴露');
  const data = {
    clusters: [
      { sessionId: 's1', title: '梯度专题', itemCount: 2, items: [
        { itemId: 'i1', title: '梯度的几何意义', summary: '方向导数的最大值' },
        { itemId: 'i2', title: '旋度', summary: '环量的面密度，与能量有关' },
      ] },
      { sessionId: 's2', title: '能量守恒', itemCount: 2, items: [
        { itemId: 'i3', title: '动能定理', summary: '合外力做功等于动能变化' },
        { itemId: 'i4', title: 'Fourier Transform', summary: '时域到频域的变换' },
      ] },
    ],
  };
  // 空查/缺数据：空数组（查空是正常路径）
  if (matches(data, '').length !== 0 || matches(data, '   ').length !== 0) throw new Error('空查询应空');
  if (matches(null, 'x').length !== 0) throw new Error('缺数据应安全');
  // 岛名命中 → island 行；卡片标题命中 → item 行
  const island = matches(data, '梯度专题');
  if (island.length !== 1 || island[0].type !== 'island' || island[0].sid !== 's1') {
    throw new Error('岛名命中错');
  }
  const item = matches(data, '动能定理');
  if (item.length !== 1 || item[0].type !== 'item' || item[0].itemId !== 'i3') {
    throw new Error('卡片命中错');
  }
  // 归一化：大小写与空格不影响命中（fouriertransform 命中 Fourier Transform）
  const latin = matches(data, 'FOURIER  transform');
  if (latin.length !== 1 || latin[0].itemId !== 'i4') throw new Error('归一化失效');
  // 摘要兜底：标题里没有「能量」的卡靠摘要命中；标题命中（岛名行）排最前
  const bySummary = matches(data, '能量');
  if (bySummary[0].type !== 'island') throw new Error('标题命中应排前');
  const last = bySummary[bySummary.length - 1];
  if (last.itemId !== 'i2' || last.viaSummary !== true) throw new Error('摘要兜底/标记错');
  // 上限
  if (matches({ clusters: [{ sessionId: 's', title: '甲', items: [] }] }, '甲', 3).length > 3) {
    throw new Error('上限失效');
  }
  // 静态契约：搜索框与结果下拉在顶栏、命中高亮类、关闭大陆清搜索态、渲染收尾重放
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('continentSearch')) throw new Error('顶栏搜索输入缺失');
  if (!src.includes('is-search-hit')) throw new Error('搜索命中高亮缺失');
  if (!src.includes('_continentSearchClear()')) throw new Error('关闭/收起时未清搜索态');
  if (src.indexOf('if (_continentSearchResults.length) _continentApplySearchHit') < 0) {
    throw new Error('重渲后搜索高亮未重放');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-search-pop[hidden]')) throw new Error('下拉 hidden 兜底缺失（display 压 hidden 坑）');
  if (!css.includes('.continent-node.is-search-hit')) throw new Error('命中高亮样式缺失');
  return true;
});

check('graph-continent: v8 族表编辑 + 纠正信号（规范化 / 术语解析 / 来源标记 / 落盘口径）', () => {
  const normalize = sandbox._continentFamilyNormalizeList;
  const parseTerms = sandbox._continentFamilyParseTerms;
  const srcLabel = sandbox._continentFamilySourceLabel;
  if (typeof normalize !== 'function' || typeof parseTerms !== 'function' || typeof srcLabel !== 'function') {
    throw new Error('族表纯函数未暴露');
  }
  // 术语解析：顿号/逗号/分号/空白都是分隔；单字丢弃；ASCII 单词照收
  const terms = parseTerms('拉格朗日方程、哈密顿, 最小作用量；variational');
  if (terms.length !== 4 || terms.indexOf('拉格朗日方程') < 0 || terms.indexOf('最小作用量') < 0) {
    throw new Error('术语解析错：' + terms.join('|'));
  }
  if (parseTerms('力 波').length !== 0) throw new Error('单字术语应丢弃');
  // KV 规范化：无效项丢弃、限长、去重、非 user 一律 custom（与服务端同口径）
  const norm = normalize([
    { canonical: '', terms: ['甲'] },
    { canonical: '我的专题', terms: ['涡旋电场', '涡旋电场', '单'] },
    { canonical: '超'.repeat(20), terms: ['超'.repeat(30)] },
    'junk',
    { canonical: '来源', terms: ['规范', '守恒'], source: 'user' },
  ]);
  if (norm.length !== 3) throw new Error('规范化数量错：' + norm.length);
  if (norm[0].terms.length !== 1) throw new Error('去重/单字丢弃错');
  if (norm[1].canonical.length !== 16 || norm[1].terms[0].length !== 24) throw new Error('限长错');
  if (norm[2].source !== 'user' || norm[0].source !== 'custom') throw new Error('来源标记错');
  if (normalize(null).length !== 0) throw new Error('缺入参应安全');
  // 来源标记三档
  if (srcLabel('builtin') !== '内置' || srcLabel('user') !== '你指定' || srcLabel('custom') !== '自定义') {
    throw new Error('来源标记错');
  }
  // 静态契约：顶栏「族表」入口、KV 通道、纠正记录读写与图例可见
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (!src.includes('continentFamilyBtn')) throw new Error('族表按钮缺失');
  if (!src.includes('/api/families')) throw new Error('族表合并视图端点未接');
  if (!src.includes('/api/kv/continent_families')) throw new Error('族表 KV 写通道缺失');
  if (!src.includes('/api/kv/continent_gate_weights')) throw new Error('纠正记录 KV 缺失');
  if (!src.includes('_continentRecordCorrection')) throw new Error('纠正落盘函数缺失');
  if (src.indexOf('归类纠正已记录') < 0) throw new Error('纠正次数图例可见缺失');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-family-row')) throw new Error('族表行样式缺失');
  if (!css.includes('.continent-family-chip')) throw new Error('词条芯片样式缺失');
  return true;
});

check('graph-continent: 顶栏空态引导只留共享连线那一句（空画布说明已删）', () => {
  // 2026-09-27 用户要求删掉「有 N 个画布还没有知识点…」——那是对用户自己数据的
  // 统计，不是可操作的引导。_continentEmptyCanvasCount 随之整体退役。
  // 留共享连线那一句：它教的是机制（同一个概念跨岛会亮起城市），用户能做点什么。
  if (sandbox._continentEmptyCanvasCount !== undefined) {
    throw new Error('_continentEmptyCanvasCount 应已删除');
  }
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  if (src.indexOf('个画布还没有知识点') >= 0) throw new Error('空画布说明文案仍在');
  if (src.indexOf('window.getAllSessions') >= 0) throw new Error('不该再读前端会话清单');
  if (src.indexOf('暂无共享连线') < 0) throw new Error('共享连线引导被误删');
  if (src.indexOf('_continentGuideText') < 0) throw new Error('引导文案状态缺失');
  return true;
});

check('graph-continent: 纯布局（空数据合法 / 坐标契约 / 世界尺寸）', () => {
  const layout = sandbox._continentLayoutClusters;
  if (typeof layout !== 'function') throw new Error('_continentLayoutClusters 未暴露');
  const empty = layout([], { w: 1200, h: 800 });
  if (!empty || !(empty.worldW > 0) || !(empty.worldH > 0)) throw new Error('空数据布局非法');
  const out = layout([
    { sessionId: 's1', title: 'A', items: [{ itemId: 'i1' }, { itemId: 'i2' }] },
    { sessionId: 's2', title: 'B', items: [{ itemId: 'i3' }] },
  ]);
  const ids = Object.keys(out.placements);
  if (ids.length !== 3) throw new Error('placements 数量错');
  for (const id of ids) {
    const p = out.placements[id];
    if (!(p.cx > p.x && p.cy > p.y && p.w > 0 && p.h > 0)) throw new Error('中心点/尺寸非法');
  }
  if (out.clusterRects.length !== 2) throw new Error('clusterRects 数量错');
  if (!(out.worldW > 300 && out.worldH > 100)) throw new Error('世界尺寸可疑');
  // 世界尺寸必须真的罩得住所有岛（回归：worldW 曾错用行的累加值 worldW===worldH，
  // 多列布局下世界宽度算小 → 适配画布按假宽度算，地图一开就被裁掉右半边）
  const right = Math.max(...out.clusterRects.map(r => r.x + r.w));
  const bottom = Math.max(...out.clusterRects.map(r => r.y + r.h));
  if (out.worldW < right || out.worldH < bottom) {
    throw new Error('世界尺寸罩不住岛：' + out.worldW + 'x' + out.worldH + ' < ' + right + 'x' + bottom);
  }
  // 3 岛 2 列布局：宽必须大于高（专守上面那个复制粘贴 bug）
  const wide = layout([
    { sessionId: 's1', title: 'A', items: [{ itemId: 'i1' }, { itemId: 'i2' }] },
    { sessionId: 's2', title: 'B', items: [{ itemId: 'i3' }] },
    { sessionId: 's3', title: 'C', items: [{ itemId: 'i4' }, { itemId: 'i5' }, { itemId: 'i6' }] },
  ]);
  if (!(wide.worldW > wide.worldH)) {
    throw new Error('多列布局的世界宽度错（worldW 用了行的累加值）：' + wide.worldW + 'x' + wide.worldH);
  }
  if (wide.worldW < Math.max(...wide.clusterRects.map(r => r.x + r.w))) {
    throw new Error('世界宽度罩不住最右的岛');
  }
  return true;
});

check('graph-continent: 开合冒烟（幂等 + 全程不写存储键）', async () => {
  if (typeof sandbox.openContinentView !== 'function' || typeof sandbox.closeContinentView !== 'function') {
    throw new Error('开合入口未暴露');
  }
  const graphKeys = () => Object.keys(storageData).filter(k => k.indexOf('phymathia_graph_') === 0).length;
  const before = graphKeys();
  sandbox.closeContinentView(); // 未开先关必须幂等
  sandbox.closeContinentView();
  await sandbox.openContinentView(); // 沙箱 fetch 兜底 {} → 失败分支收场，不抛
  sandbox.closeContinentView();
  if (graphKeys() !== before) throw new Error('出现会话图键写入');
  return true;
});


await Promise.all(pendingChecks).catch(() => {});
// 串行边界用例：proxyChatWithModel 需替换全局 fetch，放到全部并发检查结束后单独跑
try {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  const seeded = sandbox.addModelsForProvider('opencode-go', 'sk-group-e2e', 'https://opencode.ai/zen/go/v1', [{ model: 'hy3', label: '混元 Hy3' }]);
  if (seeded !== 1) throw new Error('种入测试条目失败');
  const entry = sandbox.getAllModels().find(m => m.provider === 'opencode-go');
  const cfg = sandbox.getModelById(entry.id);
  if (!cfg || cfg.provider !== 'opencode-go') throw new Error('getModelById 未命中 opencode-go 条目');
  let captured = null;
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) };
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  try {
    await sandbox.proxyChatWithModel(cfg, { prompt: 'p' });
  } finally {
    sandbox.fetch = origFetch;
  }
  if (!captured) throw new Error('fetch 未被调用');
  if (captured.body.api_key !== 'sk-group-e2e') throw new Error('请求应携带组密钥，实际 ' + captured.body.api_key);
  if (captured.body.model !== cfg.model) throw new Error('请求 model 与条目不符');
  console.log('✓ model-group：请求边界携带同步后的组密钥');
} catch (e) {
  failed++;
  console.error('❌ model-group：请求边界携带同步后的组密钥 ->', e.message);
}
// 串行边界（依赖替换全局 fetch）：思考程度必须随模型条目走到请求边界；
// 未设置的条目必须发空串（后端零参数，保持现状行为）
try {
  sandbox.localStorage.removeItem('phymathia_user_models');
  sandbox.localStorage.removeItem('phymathia_model_group_keys');
  sandbox.loadUserModels();
  if (sandbox.addModelsForProvider('deepseek', 'sk-think', 'https://api.deepseek.com', [{ model: 'deepseek-chat', label: 'DeepSeek Chat' }, { model: 'deepseek-reasoner', label: 'DeepSeek Reasoner' }]) !== 2) {
    throw new Error('种入测试条目失败');
  }
  const withThinking = sandbox.getAllModels().find(m => m.provider === 'deepseek' && m.name.includes('Chat'));
  sandbox.updateUserModel(withThinking.id, { thinking: 'max' }); // 与配置弹窗「保存」同一写入口
  const withoutThinking = sandbox.getAllModels().find(m => m.provider === 'deepseek' && m.name.includes('Reasoner'));
  const bodies = [];
  const origFetch = sandbox.fetch;
  sandbox.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => 'ok' };
  };
  try {
    await sandbox.proxyChatWithModel(sandbox.getModelById(withThinking.id), { prompt: 'p' });
    await sandbox.proxyChatWithModel(sandbox.getModelById(withoutThinking.id), { prompt: 'p' });
  } finally {
    sandbox.fetch = origFetch;
  }
  if (bodies[0].thinking !== 'max') throw new Error('设置的条目应携带 thinking=max，实际 ' + JSON.stringify(bodies[0].thinking));
  if (bodies[1].thinking !== '') throw new Error('未设置的条目应发空串，实际 ' + JSON.stringify(bodies[1].thinking));
  console.log('✓ model-thinking：请求边界携带条目思考程度（未设置为空串）');
} catch (e) {
  failed++;
  console.error('❌ model-thinking：请求边界携带条目思考程度 ->', e.message);
}
check('model-thinking：出题四处自带请求体与配置弹窗下拉就位', () => {
  for (const f of ['src/static/js/quiz-ai.js', 'src/static/js/quiz-ui.js']) {
    const src = fs.readFileSync(f, 'utf8');
    const n = (src.match(/thinking: model\.thinking \|\| ''/g) || []).length;
    if (n !== 2) throw new Error(f + ' 应有 2 处请求体携带 thinking，实际 ' + n);
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="mcThinking"')) throw new Error('配置模型弹窗缺「思考程度」下拉');
  return true;
});
check('quiz-relearn：结果页正确率环形图按真实比例（旧版是与分数无关的静态圈）', () => {
  const good = sandbox._quizScoreRingHtml(80, 4, 1);
  if (!good.includes('--p:80')) throw new Error('扇形角度未绑定正确率');
  if (!good.includes('tone-good')) throw new Error('80% 应用绿档');
  if (!good.includes('答对 4') || !good.includes('答错 1')) throw new Error('对/错分段缺失');
  if (!good.includes('aria-label="正确率 80%')) throw new Error('缺无障碍标签');
  const low = sandbox._quizScoreRingHtml(0, 0, 3);
  if (!low.includes('--p:0') || !low.includes('tone-low')) throw new Error('0% 应落在红档且扇形为 0');
  const mid = sandbox._quizScoreRingHtml(60, 3, 2);
  if (!mid.includes('tone-mid')) throw new Error('60% 应落在黄档');
  const clamped = sandbox._quizScoreRingHtml(140, 7, 0);
  if (!clamped.includes('--p:100')) throw new Error('越界分值应夹到 100');
  if (!sandbox._quizScoreRingHtml(Number.NaN, 0, 0).includes('--p:0')) throw new Error('NaN 应兜底为 0');
  // 全局概览：会话卡小环 + 饼图口径说明（旧版饼图标题写「正确率分布」但角度编码的是答题量）
  const mini = sandbox._quizSessionRateRingHtml(45);
  if (!mini.includes('is-mini') || !mini.includes('--p:45') || !mini.includes('tone-low')) {
    throw new Error('会话卡小环未按正确率画');
  }
  const src = fs.readFileSync('src/static/js/quiz-render.js', 'utf8');
  if (!src.includes('各画布答题量占比')) throw new Error('饼图标题未纠正为答题量口径');
  if (!src.includes('已测 ${segment.value} 题')) throw new Error('饼图图例未标注已测题数');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!/conic-gradient/.test(css)) throw new Error('CSS 未用 conic-gradient 画扇形');
  if (!/quizRingSweep/.test(css)) throw new Error('缺扇形填充动画');
  if (!/\.quiz-score-ring\.is-mini/.test(css)) throw new Error('缺小号环样式');
  return true;
});

check('quiz-relearn：引导浮卡的可见倒计时与生命周期（旧版 60 秒无声消失）', () => {
  const uiSrc = fs.readFileSync('src/static/js/quiz-ui.js', 'utf8');
  for (const frag of [
    'QUIZ_RETURN_PILL_TTL',
    'quiz-return-pill-bar',                    // 倒计时条
    'quiz-return-pill-count',                  // 秒数文案
    '悬停暂停',                                 // 悬停暂停提示
    '秒后收起',                                 // 剩余时间文案
    '引导卡已自动收起（60 秒未操作）',            // 自动收起时说明原因
    "document.querySelector('.graph-network-modal-overlay')", // 编辑弹窗打开时暂停
  ]) {
    if (!uiSrc.includes(frag)) throw new Error('浮卡生命周期缺: ' + frag);
  }
  const cssSrc = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!cssSrc.includes('.quiz-return-pill-bar')) throw new Error('CSS 缺倒计时条');
  if (!cssSrc.includes('quizReturnPillIn')) throw new Error('CSS 缺入场动画');
  if (cssSrc.includes('background: var(--accent, #4f8cff);')) throw new Error('旧版纯蓝胶囊样式未移除');
  // 行为：启动倒计时后剩余 = TTL，隐藏后定时器清空（不泄漏）
  const realGetById = sandbox.document.getElementById;
  sandbox.document.getElementById = () => loose('smokePillEl');
  try {
    sandbox.showQuizReturnPill();
    if (vm.runInContext('_quizReturnPillLeft', sandbox) !== 60000) throw new Error('倒计时未从 60 秒起算');
    sandbox.hideQuizReturnPill();
    // 沙箱的 setInterval 桩返回 0（真浏览器返回正数 id）——按「假值」判停止
    if (vm.runInContext('_quizReturnPillTick', sandbox)) throw new Error('隐藏后倒计时应停止');
  } finally {
    sandbox.document.getElementById = realGetById;
  }
  return true;
});

check('graph-contextmenu：菜单视觉层（图标列 + 快捷键提示 + 静态断言）', () => {
  const src = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  for (const frag of ["iconEl.className = 'graph-context-menu-icon'", 'graph-context-menu-kbd', 'GRAPH_CTX_ICONS', 'GRAPH_CTX_KEYS']) {
    if (!src.includes(frag)) throw new Error('菜单视觉层缺: ' + frag);
  }
  // 图标取自 config.js 的线性图标表；未知键静默留白（不阻断菜单）
  const del = sandbox._graphCtxIconSvg('delete');
  if (!del || !del.includes('<svg')) throw new Error('删除项未取到图标');
  if (sandbox._graphCtxIconSvg('不存在的键') !== '') throw new Error('未知键应留白');
  // GRAPH_CTX_KEYS 是顶层 const（不挂沙箱全局），走词法读取
  if (vm.runInContext('GRAPH_CTX_KEYS.delete', sandbox) !== 'Del') throw new Error('删除项快捷键提示应对齐真实键位');
  if (vm.runInContext('GRAPH_CTX_ICONS.delete', sandbox) !== 'trash') throw new Error('删除项应映射到 trash 图标');
  const cssSrc = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const frag of ['.graph-context-menu-icon', '.graph-context-menu-kbd', 'graphCtxMenuIn', 'backdrop-filter']) {
    if (!cssSrc.includes(frag)) throw new Error('菜单 CSS 缺: ' + frag);
  }
  return true;
});

check('aurora-glass 载体扩编：侧边栏/顶栏/二级栏（载体不得自带实底；画布工具栏已摘胶囊改裸浮层）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const [name, sel] of [
    ['侧边栏', 'class="sidebar aurora-glass aurora-glass--panel"'],
    ['顶栏', 'class="chat-header aurora-glass aurora-glass--panel"'],
    ['二级栏', 'class="header-secondary-bar aurora-glass aurora-glass--panel"'],
  ]) {
    if (!html.includes(sel)) throw new Error(name + '未挂玻璃载体类');
  }
  // 大面积变体：深浅两套 + 更浅的模糊（全高/全宽玻璃每帧重采样整片背景，且可读性优先）
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!/\.aurora-glass--panel \{/.test(css)) throw new Error('缺 --panel 大面积变体');
  if (!/\[data-theme="light"\] \.aurora-glass--panel/.test(css)) throw new Error('--panel 缺浅色一套');
  const panel = css.slice(css.indexOf('.aurora-glass--panel {'), css.indexOf('}', css.indexOf('.aurora-glass--panel {')));
  if (!/blur\(14px\)/.test(panel)) throw new Error('--panel 应比基础档更浅的模糊');
  // 载体自身不得再写 background（简写会重置 background-image 盖掉极光；graph-override 那层特指性最高）
  const strip = (file, sel) => {
    const text = fs.readFileSync(file, 'utf8');
    const i = text.indexOf(sel);
    if (i < 0) return null;
    return text.slice(i, text.indexOf('}', i));
  };
  for (const [file, sel, name] of [
    ['src/static/css/styles.css', '.sidebar {', '侧边栏'],
    ['src/static/css/styles.css', '.chat-header {', '顶栏'],
    ['src/static/css/styles.css', '.header-secondary-bar {', '二级栏'],
    ['src/static/css/styles-panels.css', '    .app-container .chat-header,\n    .app-container .header-secondary-bar {', '顶栏(panels)'],
    ['src/static/css/graph-override.css', '.app-container .chat-header,\n.app-container .header-secondary-bar {', '顶栏(override)'],
  ]) {
    const block = strip(file, sel);
    if (block === null) throw new Error('找不到规则：' + name + ' @ ' + file);
    if (/background(-color)?\s*:/.test(block)) throw new Error(name + ' 仍自带 background，会盖掉极光层');
  }
  // 画布工具栏（2026-09-24 拍板）：裸图标浮层，不再套玻璃胶囊（与右上角胶囊同质化）——
  // 容器只留布局不带底色磨砂；按钮静息透明无框，hover/激活态才描边着色出小片。
  // 同日二拍：拆两簇——右下看图+助手+产出，左下改图与审查（--left 变体）
  const gi = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!gi.includes("toolbar.className = 'graph-canvas-toolbar'")) {
    throw new Error('画布工具栏应改为裸图标浮层（不应再挂 aurora-glass 胶囊）');
  }
  if (!gi.includes("'graph-canvas-toolbar graph-canvas-toolbar--left'")) {
    throw new Error('画布工具栏应拆两簇（左下改图簇挂 --left 变体）');
  }
  if (gi.includes('graph-canvas-toolbar aurora')) {
    throw new Error('画布工具栏不得回挂玻璃胶囊');
  }
  const gcss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const bar = gcss.slice(gcss.indexOf('.graph-canvas-toolbar {'), gcss.indexOf('}', gcss.indexOf('.graph-canvas-toolbar {')));
  if (/background|backdrop-filter/.test(bar)) throw new Error('工具栏容器应只留布局（胶囊已摘，不得带底色/磨砂）');
  const btn = gcss.slice(gcss.indexOf('.graph-tool-btn {'), gcss.indexOf('}', gcss.indexOf('.graph-tool-btn {')));
  if (!/background: transparent !important;/.test(btn)) throw new Error('工具按钮静息应自身透明（浮在壁纸上，hover 才出底板）');
  if (!/border: 1px solid transparent !important;/.test(btn)) throw new Error('工具按钮静息不该有描边（hover/激活才描边着色）');
  // 查看器：双击打开的面板一律封住（含编辑面板），且必须给提示而不是静默无反应
  const vm = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  for (const fn of ['openAddBlankNodeModal', 'editHumanNoteNode', 'editCustomNodeContent', 'editModuleNode']) {
    if (!vm.includes(fn + ':')) throw new Error('查看器未封住双击面板入口：' + fn);
  }
  if (!vm.includes('只读快照：不能添加节点')) throw new Error('查看器封禁面板时缺用户提示');
  return true;
});

check('移动端工具栏：难度入口不随顶栏按钮位置漂移，图标入口可读', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!/class="header-btn" onclick="toggleLevelPanel\(event\)"[^>]*aria-controls="levelPanel"/.test(html)) {
    throw new Error('移动端二级工具栏缺少难度入口');
  }
  if (/header-actions[^\n]*nth-child\(5\)|header-actions[^\n]*nth-child\(6\)/.test(css)) {
    throw new Error('移动端顶栏仍靠 nth-child 隐藏按钮');
  }
  for (const id of ['runAllBtn', 'stopBtn', 'themeBtn', 'modelBtn', 'levelBtn', 'knowledgeBtn']) {
    const button = html.match(new RegExp('<button[^>]*id="' + id + '"[^>]*>'));
    if (!button || !/aria-label=/.test(button[0])) throw new Error(id + ' 缺少 aria-label');
  }
  return true;
});

check('aurora-glass：极光磨砂玻璃语言（三处共用 + 深浅两套 + 降级）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  for (const frag of [
    '.aurora-glass {',
    '--aurora-1', '--aurora-2', '--aurora-3', '--glass-tint', '--glass-veil',
    'backdrop-filter: blur(18px) saturate(150%)',
    '@keyframes auroraDrift',
    '.aurora-glass--compact',
    'prefers-reduced-motion',                       // 减弱动效：停止漂移
    '@supports not ((backdrop-filter',              // 不支持磨砂时加深底色
  ]) {
    if (!css.includes(frag)) throw new Error('极光玻璃 CSS 缺: ' + frag);
  }
  // 浅色主题必须走应用的暖色系（--bg-panel #faf6ee / --accent #8b6914），不能塞冷蓝紫
  const lightBase = css.slice(
    css.indexOf('html[data-theme="light"] .aurora-glass,'),
    css.indexOf('.aurora-glass--compact {')
  );
  const lightCompact = css.slice(
    css.indexOf('html[data-theme="light"] .aurora-glass--compact'),
    css.indexOf('@keyframes auroraDrift')
  );
  for (const [name, block] of [['基础', lightBase], ['紧凑', lightCompact]]) {
    if (!/rgba\(251, 191, 36,/.test(block)) throw new Error(name + '浅色极光未走暖调（琥珀）');
    // 用户明确否掉浅色的蓝调：冷紫/天蓝/青都不许再出现在浅色极光里
    for (const cold of ['168, 85, 247', '96, 165, 250', '34, 211, 238']) {
      if (block.includes(cold)) throw new Error(name + '浅色极光残留冷色 ' + cold + '，与暖米色主题冲突');
    }
  }
  // 载体自带的 background 简写会重置 background-image 并盖住极光层——
  // .progress-status 就栽在这（用户截图里胶囊没极光），基础规则必须让位。
  // **任何** background 简写都不行，不只是 var(--panel-bg)：`background: transparent`
  // 同样把 background-image 重置成 none（2026-09-27 用户问「这俩透明度不一样」——
  // 面板 11 层渐变、胶囊 0 层，根因就是这条 transparent）。要盖底色写 background-color。
  const baseCapsule = css.slice(css.indexOf('.progress-status {'), css.indexOf('.progress-status.active'));
  if (/(^|[;{\s])background\s*:/.test(baseCapsule)) {
    throw new Error('基础 .progress-status 自带 background 简写，会重置 background-image 盖掉极光层（要盖底色请写 background-color）');
  }
  // 三处载体：引导浮卡 / 右键菜单（JS 加类）+ 生成进度胶囊 / 知识面板胶囊（静态 HTML 加类）
  const quizUi = fs.readFileSync('src/static/js/quiz-ui.js', 'utf8');
  if (!quizUi.includes("'quiz-return-pill aurora-glass'")) throw new Error('引导浮卡未挂极光玻璃');
  const menu = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  if (!menu.includes("'graph-context-menu aurora-glass'")) throw new Error('右键菜单未挂极光玻璃');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('class="progress-status aurora-glass aurora-glass--compact"')) throw new Error('进度胶囊未挂极光玻璃');
  if (!html.includes('class="kp-tool-btn aurora-glass aurora-glass--compact"')) throw new Error('知识面板胶囊未挂极光玻璃');
  // 载体自带的底色不能盖住极光层（kp 胶囊踩过这个坑：background-image: inherit 会抹掉渐变）
  const panels = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  const kpRuleRaw = panels.slice(panels.indexOf('.kp-tool-btn.aurora-glass {'), panels.indexOf('.kp-tool-btn.aurora-glass.running'));
  const kpRule = kpRuleRaw.replace(/\/\*[\s\S]*?\*\//g, ''); // 注释里会提到这个坑，断言只看声明
  if (/background-image:\s*inherit/.test(kpRule)) throw new Error('kp 胶囊的 background-image: inherit 会抹掉极光层');
  if (!/background-color:\s*transparent/.test(kpRule)) throw new Error('kp 胶囊需置空自身底色让极光透出');
  // 同一条病在 kp 胶囊上也犯过（2026-09-27）：基础 .kp-tool-btn 用 background 简写设
  // --kp-filter-bg，简写把 background-image 重置成 none → 极光层 0 层。本表在 styles.css
  // 之后加载、同特指性，赢的正是这条简写。凡是要挂 aurora-glass 的载体，基础规则一律
  // 只准写 background-color 长写属性。
  const kpBaseRaw = panels.slice(panels.indexOf('.kp-tool-btn {'), panels.indexOf('.kp-tool-btn:hover'));
  const kpBase = kpBaseRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  if (/(^|[;{\s])background\s*:/.test(kpBase)) {
    throw new Error('基础 .kp-tool-btn 用了 background 简写，会重置 background-image 抹掉极光层（请写 background-color）');
  }
  // animation 是简写：载体的入场动画必须与 auroraDrift 并列为两项，否则漂移被覆盖掉
  for (const [name, file, key] of [
    ['引导浮卡', 'src/static/css/styles-panels.css', 'quizReturnPillIn'],
    ['右键菜单', 'src/static/css/styles-panels.css', 'graphCtxMenuIn'],
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    const i = src.indexOf(key + ' 0.');
    const block = src.slice(i, src.indexOf('}', i));
    if (!/auroraDrift/.test(block)) throw new Error(name + '的入场动画覆盖了极光漂移（需并列）');
  }
  return true;
});

check('aurora-glass：浅色极光纯暖调（第三轮：连青玉也删掉，禁任何蓝绿）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  // 四档变体各一块浅色极光。切块末端必须落在**下一个变体的深色规则**之前：
  // 若用「下一个浅色选择器」当末端，中间夹着的那档深色声明会被一起吃进来——
  // 第 4 轮新增 --dialog 时基础块就这么把深色 rgba(14,116,233) 吃进来，误判成「浅色有蓝」。
  const lightBlocks = [
    ['基础', css.slice(css.indexOf('/* 浅色模式：白玻璃'), css.indexOf('    .aurora-glass--compact {'))],
    ['紧凑', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--compact,'), css.indexOf('    .aurora-glass--dialog {'))],
    ['弹窗', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--dialog,'), css.indexOf('    .aurora-glass--panel {'))],
    ['大面积', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--panel,'), css.indexOf('    .aurora-glass--attached {'))],
    // 挂接档（2026-07-27 任务面板停靠胶囊新增）：带三团色斑，要走同一套暖调排查。
    // 末尾落在下一档的**深色**规则前；--dock-host 只动投影不带色斑，故不进枚举。
    ['挂接', css.slice(css.indexOf('    html[data-theme="light"] .aurora-glass--attached,'), css.indexOf('    .aurora-glass--dock-host {'))],
  ];
  // 用户否掉的青玉/冷色（45,212,191 青玉、34,211,238 天蓝、96,165,250 冷蓝、168,85,247 冷紫、120,150,220 蓝灰描边）
  const cold = ['45, 212, 191', '34, 211, 238', '96, 165, 250', '168, 85, 247', '120, 150, 220', '13, 148, 136', '8, 145, 178'];
  const hexCold = ['#22d3ee', '#60a5fa', '#a78bfa', '#2dd4bf', '#14b8a6', '#0ea5e9'];
  for (const [name, raw] of lightBlocks) {
    if (!raw) throw new Error(name + '：取不到浅色极光块（选择器被改名？）');
    const block = raw.replace(/\/\*[\s\S]*?\*\//g, ''); // 断言只看声明：注释里会提到被否掉的颜色
    for (const c of [...cold, ...hexCold]) {
      if (block.includes(c)) throw new Error(name + '浅色极光残留冷色/青绿 ' + c + '（用户已两轮否掉蓝绿调）');
    }
    // 三团色斑 + 内描边都必须落在暖色相区间（R > G > B），青绿必然 G > R
    const rgbas = block.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/g) || [];
    if (rgbas.length < 3) throw new Error(name + '浅色极光缺色斑声明');
    for (const decl of rgbas) {
      const [r, g, b] = decl.match(/\d+/g).slice(0, 3).map(Number);
      if (g > r && g > b) throw new Error(name + '浅色极光出现绿/青主导色 ' + decl + '（暖调应是 R 最高）');
      if (b > r) throw new Error(name + '浅色极光出现蓝主导色 ' + decl + '（暖调应是 R 最高）');
    }
  }
  // 浅色三团的暖色家族：琥珀（--domain-physics 系）+ 蜜桃 + 暖陶土
  const base = lightBlocks[0][1];
  if (!/rgba\(251, 191, 36,/.test(base)) throw new Error('浅色极光丢了琥珀主色');
  if (!/rgba\(214, 148, 96,/.test(base)) throw new Error('浅色极光第三团未换成暖陶土（青玉已删）');
  return true;
});

check('aurora-glass 载体全覆盖：全部面板/弹窗都挂玻璃（第 4 轮：模型配置等所有面板统一极光磨砂）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const cssAll = {
    'styles.css': fs.readFileSync('src/static/css/styles.css', 'utf8'),
    'styles-panels.css': fs.readFileSync('src/static/css/styles-panels.css', 'utf8'),
    'graph-override.css': fs.readFileSync('src/static/css/graph-override.css', 'utf8'),
  };
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

  // ① 静态载体：index.html 里的面板根元素必须挂 aurora-glass（缺一个就是「还有面板是实底」）
  const carriers = [
    ['模型面板', 'class="model-panel aurora-glass aurora-glass--dialog" id="modelPanel"'],
    ['数据管理面板', 'class="model-panel aurora-glass aurora-glass--dialog" id="dataPanel"'],
    ['难度面板', 'class="level-panel aurora-glass aurora-glass--compact" id="levelPanel"'],
    ['知识面板', 'class="knowledge-panel aurora-glass aurora-glass--panel" id="knowledgePanel"'],
    ['记忆面板', 'class="knowledge-panel memory-panel aurora-glass aurora-glass--panel" id="memoryPanel"'],
    ['添加/配置模型弹窗', 'class="model-dialog model-dialog-add aurora-glass aurora-glass--dialog"'],
    ['模型配置弹窗', 'class="model-dialog aurora-glass aurora-glass--dialog"'],
    ['清除记忆弹窗', 'class="memory-dialog aurora-glass aurora-glass--dialog"'],
    ['收藏弹窗', 'class="bookmark-modal aurora-glass aurora-glass--dialog"'],
    ['苏格拉底弹窗', 'class="socratic-modal aurora-glass aurora-glass--dialog" role="dialog" aria-modal="true" aria-labelledby="socraticModalTitle"'],
    ['追问弹窗', 'class="socratic-modal aurora-glass aurora-glass--dialog" role="dialog" aria-modal="true"'],
    ['知识检测弹窗', 'class="quiz-modal aurora-glass aurora-glass--dialog"'],
    ['节点搜索面板', 'class="graph-search-panel aurora-glass aurora-glass--compact" id="graphSearchPanel"'],
    ['引导浮卡', 'class="onboarding-card aurora-glass aurora-glass--dialog" id="onboardingCard"'],
    ['示例图讲解', 'class="example-guide-dialog aurora-glass aurora-glass--panel"'],
    ['可视化全屏栏', 'class="viz-fullscreen-bar aurora-glass aurora-glass--panel"'],
    ['模型提示条', 'class="model-toast aurora-glass aurora-glass--compact" id="modelToast"'],
  ];
  for (const [name, sel] of carriers) {
    if (!html.includes(sel)) throw new Error(name + ' 未挂玻璃载体类（第 4 轮要求全部面板统一极光磨砂）');
  }

  // ② JS 动态建的面板同样挂类（JS 里 className 是整串赋值，漏了就整块实底）
  for (const [file, key, name] of [
    ['src/static/js/graph.js', 'graphHistoryPanel.className = "graph-history-panel aurora-glass aurora-glass--dialog"', '修改历史面板'],
    ['src/static/js/graph.js', 'graphConsistencyPanel.className = "graph-consistency-panel aurora-glass aurora-glass--dialog"', '图体检面板'],
    ['src/static/js/graph-export.js', "menu.className = 'graph-export-menu aurora-glass aurora-glass--dialog'", '导出菜单'],
    ['src/static/js/graph-continent.js', "el.className = 'continent-popover aurora-glass aurora-glass--dialog'", '大陆弹层'],
    ['src/static/js/session.js', "panel.className = 'icon-picker-panel aurora-glass aurora-glass--dialog'", '图标选择面板'],
    // 引导浮卡内容每次重渲都会整串重写 className——漏一处就会退回实底（本处踩过）
    ['src/static/js/ui.js', "card.className = 'onboarding-card aurora-glass aurora-glass--dialog'", '引导浮卡(步骤)'],
    ['src/static/js/ui.js', "card.className = 'onboarding-card ob-welcome aurora-glass aurora-glass--dialog'", '引导浮卡(欢迎页)'],
    // 第 5 轮磨砂化补漏：Φ 面板 / 全局 toast / 完成通知卡
    ['src/static/js/harness.js', "harnessPanel.className = 'graph-harness-window aurora-glass aurora-glass--dialog'", 'Φ 网络助手面板'],
    ['src/static/js/ui.js', "toast.className = 'aurora-glass aurora-glass--compact'", '全局 toast'],
    ['src/static/js/ui.js', "card.className = 'completion-card aurora-glass'", '完成通知卡'],
  ]) {
    const src = fs.readFileSync(file, 'utf8');
    if (!src.includes(key)) throw new Error(name + ' 未挂玻璃载体类 @ ' + file);
  }

  // ③ 载体自身的规则不得再写实底：background 简写会重置 background-image，
  //    把极光层整块盖掉（同特指性且规则在后时必现）。允许显式 transparent（那是让位）。
  //    这里手写一个极小的 CSS 规则扫描器——正则吃不下「选择器组里夹 {}」这类写法，
  //    而漏判的代价正是这轮修的那批 bug（载体实底把极光整块盖掉）。
  const scanRules = (text, inheritedAt = null) => {
    const out = [];
    // 去注释 + 去字符串（content: "{" 之类），避免把引号里的花括号当块
    const clean = strip(text).replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    let i = 0, buf = '';
    while (i < clean.length) {
      const ch = clean[i];
      if (ch === '{') {
        // 找配对的 '}'
        let depth = 1, j = i + 1;
        for (; j < clean.length && depth > 0; j++) {
          if (clean[j] === '{') depth++;
          else if (clean[j] === '}') depth--;
        }
        const body = clean.slice(i + 1, j - 1);
        const selector = buf.trim();
        if (selector.startsWith('@')) out.push(...scanRules(body, selector));
        else out.push({ selector, body, at: inheritedAt });
        buf = '';
        i = j;
      } else if (ch === '}') {
        i++; buf = '';
      } else {
        buf += ch; i++;
      }
    }
    return out;
  };
  const offenders = [];
  const roots = [
    '.model-panel', '.level-panel', '.model-dialog', '.socratic-modal', '.quiz-modal',
    '.bookmark-modal', '.memory-dialog', '.knowledge-panel', '.onboarding-card',
    '.example-guide-dialog', '.viz-fullscreen-bar', '.graph-search-panel', '.graph-export-menu',
    '.graph-history-panel', '.graph-consistency-panel', '.continent-popover', '.icon-picker-panel',
    // 第 5 轮磨砂化补漏的载体：谁再写实底就是回归（transparent/none 合法）
    '.graph-harness-window', '.model-toast', '.completion-card',
  ];
  for (const [file, css] of Object.entries(cssAll)) {
    for (const { selector, body } of scanRules(css)) {
      if (/^@/.test(selector)) continue; // @media/@supports 外壳，内层规则会被单独扫到
      // 只看「最右一个复合选择器就是载体本身」的规则（如 '.model-panel' / '[data-theme=x] .model-dialog'）：
      // 后代规则（'.socratic-modal textarea'）本来就是内部控件，不属于载体自身的底色
      const lastCompound = selector.split(',').pop().trim().split(/[\s>+~]+/).filter(Boolean).pop() || '';
      // 伪元素盒子（::before/::after 装饰条、光斑）画在载体背景之上，不是载体自己的底色——
      // 不妨碍极光层，跳过（Φ 面板顶部的 2px 装饰条就是这么被误报的）
      if (/::?(before|after)$/i.test(lastCompound)) continue;
      const hit = roots.find((root) => new RegExp('(^|[^\\w-])' + root.replace(/\./g, '\\.') + '(?![-\\w])').test(lastCompound));
      if (!hit) continue;
      const decl = body.match(/(?:^|;)\s*background(?:-color|-image)?\s*:\s*([^;]+)/);
      if (!decl) continue;
      const val = decl[1].trim();
      if (val === 'transparent' || val === 'none') continue; // 显式让位
      offenders.push(`${file} 「${selector.replace(/\s+/g, ' ').slice(0, 60)}」 -> background: ${val.slice(0, 48)}`);
    }
  }
  if (offenders.length) {
    throw new Error('载体自带实底会盖掉极光层（须删掉 background 或显式 transparent）：\n  ' + offenders.join('\n  '));
  }
  return true;
});

check('aurora-glass--dialog：表单类弹窗档（深浅两套 + 可读性优先的底色 + 降级）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!/\.aurora-glass--dialog \{/.test(css)) throw new Error('缺 --dialog 弹窗变体');
  if (!/\[data-theme="light"\] \.aurora-glass--dialog/.test(css)) throw new Error('--dialog 缺浅色一套');
  const dialog = css.slice(css.indexOf('.aurora-glass--dialog {'), css.indexOf('}', css.indexOf('.aurora-glass--dialog {')));
  const panel = css.slice(css.indexOf('.aurora-glass--panel {'), css.indexOf('}', css.indexOf('.aurora-glass--panel {')));
  const tintOf = (block) => {
    const m = block.match(/--glass-tint:\s*rgba\(\s*\d+,\s*\d+,\s*\d+,\s*([\d.]+)\s*\)/);
    return m ? Number(m[1]) : NaN;
  };
  // 弹窗里全是表单与密集列表：底色必须比大面积 chrome 更实（可读性优先），否则透出画布会花
  if (!(tintOf(dialog) > tintOf(panel))) {
    throw new Error(`--dialog 底色应比 --panel 更实（弹窗可读性优先），当前 ${tintOf(dialog)} vs ${tintOf(panel)}`);
  }
  if (!/blur\(16px\)/.test(dialog)) throw new Error('--dialog 应是居中的 16px 模糊（基础档 18 / 大面积 14）');
  // 降级：不支持 backdrop-filter 时弹窗底色要更实（比基础档更深），否则文字压在透底上读不清
  const supports = css.slice(css.indexOf('@supports not ((backdrop-filter'), css.indexOf('/* ====== 进度指示器'));
  if (!/\.aurora-glass--dialog \{ --glass-tint: rgba\(9, 13, 30, 0\.9/.test(supports)) {
    throw new Error('降级段缺 --dialog 加深底色');
  }
  if (!/\[data-theme="light"\] \.aurora-glass--dialog,\s*\n\s*\[data-theme="light"\] \.aurora-glass--dialog \{ --glass-tint: rgba\(252, 249, 243, 0\.9/.test(supports)) {
    throw new Error('降级段缺 --dialog 浅色加深底色');
  }
  return true;
});

check('画布工具栏图标：浅色走暖棕墨（不再是近黑，且不低于 4.5:1 对比度）', () => {
  const gcss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const rootBlock = gcss.slice(gcss.indexOf(':root {', gcss.indexOf('@property --graph-edge-glow')), gcss.indexOf('}', gcss.indexOf(':root {', gcss.indexOf('@property --graph-edge-glow'))));
  const lightBlock = gcss.slice(gcss.indexOf('[data-theme="light"] {', gcss.indexOf('--node-glass-base')), gcss.indexOf('}', gcss.indexOf('[data-theme="light"] {', gcss.indexOf('--node-glass-base'))));
  if (!/--graph-tool-ink:\s*#[0-9a-f]{6}/i.test(rootBlock)) throw new Error('缺 --graph-tool-ink（深色一套），图标墨色无法随主题切换');
  const lightInk = (lightBlock.match(/--graph-tool-ink:\s*(#[0-9a-f]{6})/i) || [])[1];
  if (!lightInk) throw new Error('浅色缺 --graph-tool-ink（浅色一套）');
  const btn = gcss.slice(gcss.indexOf('.graph-tool-btn {'), gcss.indexOf('}', gcss.indexOf('.graph-tool-btn {')));
  if (!/color:\s*var\(--graph-tool-ink\)\s*!important/.test(btn)) throw new Error('工具按钮图标未接 --graph-tool-ink');
  // 浅色覆盖层（[data-theme="light"] .graph-tool-btn，特指性高于基础 :hover）只能收窄描边：
  // 一旦在这里写 background / color，就会把 hover 与 .active 的底板、字色一起压掉
  const lightBtn = gcss.slice(gcss.indexOf('[data-theme="light"] .graph-tool-btn {'), gcss.indexOf('}', gcss.indexOf('[data-theme="light"] .graph-tool-btn {')));
  for (const banned of [/background/, /(^|[^-])color\s*:/m]) {
    if (banned.test(lightBtn.replace(/\/\*[\s\S]*?\*\//g, ''))) {
      throw new Error('浅色工具按钮规则写了 background/color，会压掉 :hover 与 .active 的状态样式');
    }
  }
  // hover 底板走主题变量（原来是写死的深墨蓝，浅色下悬停会突兀发黑）
  const hover = gcss.slice(gcss.indexOf('.graph-tool-btn:hover {'), gcss.indexOf('}', gcss.indexOf('.graph-tool-btn:hover {')));
  if (!/background:\s*var\(--btn-active-bg\)/.test(hover)) throw new Error('工具按钮 hover 底板未接主题变量（浅色会发黑）');
  // 对比度：暖棕墨须压在浅色画布的暖米底上可读（WCAG 相对亮度；#f7f2e6 与浅色壁纸同族，
  // 摘胶囊后图标直接浮在壁纸上，对比口径不变）
  const lum = (hex) => {
    const v = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const ratio = (a, b) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const onGlass = ratio(lightInk, '#f7f2e6'); // 浅色画布的暖米底（与壁纸同族的代表色）
  if (onGlass < 4.5) throw new Error('浅色图标墨色对比度不足：' + onGlass.toFixed(2) + ':1');
  if (onGlass > 12) throw new Error('浅色图标仍是近黑（对比度 ' + onGlass.toFixed(2) + ':1），与暖米色环境违和');
  const [lr, lg, lb] = [1, 3, 5].map(i => parseInt(lightInk.slice(i, i + 2), 16));
  if (!(lr > lg && lg > lb)) throw new Error('浅色图标墨色不是暖色相（应 R > G > B）');
  return true;
});

// ===== 串行边界：以下用例改共享状态（localStorage 知识/统计键）且会 await，
// 必须放在全部并发检查之后——否则会与在途的 knowledge/quiz 异步用例互相踩键 =====

check('quiz-relearn：quizRetestTopic 全链路（真实检测态按主题组卷，不改全量素材池）', async () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  // 顶层 let（quizSourcePreference/quizState）不是沙箱全局属性，用同 context 的词法读/写访问
  const prevPref = vm.runInContext('quizSourcePreference', sandbox);
  vm.runInContext('quizSourcePreference = "local"', sandbox); // 只走本地出题，不触发 AI 链路
  try {
    await sandbox.openQuiz('session'); // 真实建立 quizState（沙箱 fetch 返回空数据）
    m2SeedQuizStats();
    const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
    stats._meta.wrongQuestions = [m2WrongQuestion()];
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
    const ok = await sandbox.quizRetestTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('重测应返回 true');
    const phase = vm.runInContext('quizState && quizState.phase', sandbox);
    const qlen = vm.runInContext('quizState && quizState.questions ? quizState.questions.length : -1', sandbox);
    const filter = vm.runInContext('typeof quizFilterTopic === "string" ? quizFilterTopic : ""', sandbox);
    const poolLen = vm.runInContext('quizState && quizState.pool ? quizState.pool.knowledge.length : -1', sandbox);
    if (phase !== 'question') throw new Error('应进入答题相位，实际 ' + phase);
    if (qlen < 1) throw new Error('同主题原错题应进卷，实际 ' + qlen);
    if (filter !== M2_TOPIC_KEY) throw new Error('主题过滤未生效：' + filter);
    if (poolLen !== 0) throw new Error('不得改动全量素材池，实际 ' + poolLen);
    // 无素材又无错题的主题：优雅返回 false（不抛错、不改相位）
    const miss = await sandbox.quizRetestTopic(encodeURIComponent('topic-none'));
    if (miss !== false) throw new Error('无素材主题应返回 false');
    const phaseAfter = vm.runInContext('quizState && quizState.phase', sandbox);
    if (phaseAfter !== 'question') throw new Error('查空路径不应改相位，实际 ' + phaseAfter);
  } finally {
    vm.runInContext(`quizSourcePreference = ${JSON.stringify(prevPref)}`, sandbox);
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
  }
  return true;
});

check('quiz-relearn：quizLocateTopic 全链路（主题解析 → 定位内核 → 重学引导带落点）', async () => {
  sandbox.window.getCurrentSessionId = () => M2_SESSION;
  sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    kp_hm: { id: 'kp_hm', title: '简谐运动', sessionId: M2_SESSION },
  }));
  m2SeedQuizStats();
  const stats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
  stats._meta.wrongQuestions = [m2WrongQuestion()];
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(stats));
  const realGoTo = sandbox.window.goToKnowledgeNode;
  const realLocate = sandbox.window.locateFormulaNode;
  const realGetLast = sandbox.window.getLastLocatedGraphNodeId;
  const calls = [];
  try {
    sandbox.window.goToKnowledgeNode = async (refId) => {
      calls.push({ kind: 'knowledge', refId });
      sandbox._rememberLocatedGraphNode('node_kp_hm'); // 模拟定位内核回填落点
      return true;
    };
    sandbox.window.locateFormulaNode = async (refId) => {
      calls.push({ kind: 'formula', refId });
      return true;
    };
    const ok = await sandbox.quizLocateTopic(encodeURIComponent(M2_TOPIC_KEY));
    if (ok !== true) throw new Error('定位应成功');
    if (!calls.length || calls[0].kind !== 'knowledge' || calls[0].refId !== 'kp_hm') {
      throw new Error('应按错题 sourceRef 走知识点定位，实际 ' + JSON.stringify(calls));
    }
    const ctx = sandbox._quizRelearnCtxGet();
    if (!ctx || ctx.title !== '简谐运动' || ctx.nodeId !== 'node_kp_hm') {
      throw new Error('引导上下文未带标题/落点: ' + JSON.stringify(ctx));
    }
    if (sandbox.window.getLastLocatedGraphNodeId() !== 'node_kp_hm') throw new Error('落点回填未生效');
    if (!sandbox.quizRelearnPillHtml().includes('quizRelearnCreateNote()')) throw new Error('pill 缺引导动作');
    // 公式类主题走公式定位分支
    const fStats = JSON.parse(sandbox.localStorage.getItem('phymathia_quiz_stats'));
    fStats._meta.wrongQuestions = [Object.assign(m2WrongQuestion(), {
      id: 'w_f', sourceRef: 'f_zq', sourceType: 'formula', formulaText: 'T=2\\pi\\sqrt{m/k}', topicKey: 'topic-F',
    })];
    fStats.k_f = { title: '弹簧振子周期', correct: 0, wrong: 2, topicKey: 'topic-F', sessionId: M2_SESSION, dueAt: 1 };
    sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify(fStats));
    const okF = await sandbox.quizLocateTopic(encodeURIComponent('topic-F'));
    if (okF !== true) throw new Error('公式主题定位应成功');
    if (!calls.some(c => c.kind === 'formula' && c.refId === 'f_zq')) {
      throw new Error('公式主题应走 locateFormulaNode，实际 ' + JSON.stringify(calls));
    }
    // 未知主题：静默失败，不跳转
    const before = calls.length;
    const miss = await sandbox.quizLocateTopic(encodeURIComponent('topic-none'));
    if (miss !== false || calls.length !== before) throw new Error('未知主题不应触发跳转');
  } finally {
    sandbox.window.goToKnowledgeNode = realGoTo;
    sandbox.window.locateFormulaNode = realLocate;
    if (realGetLast) sandbox.window.getLastLocatedGraphNodeId = realGetLast;
    sandbox.clearQuizRelearnGuide();
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
    sandbox.localStorage.removeItem('phymathia_knowledge');
    sandbox.invalidateKnowledgeCache();
  }
  return true;
});


// ===== 记忆功能 v2：可感知性 + 确定性信号采集（2026-09-17） =====
// 同步用例（不 await、即时清理共享键），追加在串行边界之后安全。

check('memory-v2：红点/休眠/归档容器与角标、信号回传的前后端接线都在', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  for (const [name, token] of [
    ['侧边栏记忆红点', 'memory-dot" id="memoryDot"'],
    ['休眠记忆区', 'id="memoryIdleList"'],
    ['归档区', 'id="memoryArchiveList"'],
  ]) {
    if (!html.includes(token)) throw new Error(name + ' 缺失');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const token of ['.memory-dot {', '.memory-badge-btn {', '.memory-badge-detail {']) {
    if (!css.includes(token)) throw new Error('记忆样式缺失：' + token);
  }
  const memoryJs = fs.readFileSync('src/static/js/memory.js', 'utf8');
  for (const token of [
    'memoryPostCandidates', 'memoryNotifyPromoted', 'memoryBadgeSections',
    'memoryAppendProfileBadge', 'memoryRestoreFact', 'memoryRestoreArchive',
  ]) {
    if (!memoryJs.includes(token)) throw new Error('memory.js 缺少 ' + token);
  }
  const quizStatsJs = fs.readFileSync('src/static/js/quiz-stats.js', 'utf8');
  if (!quizStatsJs.includes('_collectProfileSignalCandidates')) throw new Error('quiz-stats 缺少信号采集');
  if (!quizStatsJs.includes('_scheduleProfileSignalSync();')) throw new Error('quiz-stats 答题后未挂信号同步');
  // 2026-09-25 线性主聊天退役：聊天消息 meta 的画像角标接线（chat.js 解析
  // profile_usage 帧 + memoryAppendProfileBadge）随管线删除——角标唯一挂点是
  // 已不存在的气泡 meta；memory.js 的角标函数本体保留（画布/Φ 侧仍可用）。
  const chatFeaturesJs = fs.readFileSync('src/static/js/chat-features.js', 'utf8');
  if (!chatFeaturesJs.includes('data.profile.promoted')) throw new Error('chat-features 未处理提取响应的 promoted');
  return true;
});

check('memory-v2：角标优先用后端注入快照，缓存只在无快照时兜底', () => {
  vm.runInContext(`
    memoryBadgeSectionsFromCache = memoryBadgeSectionsFromCache || function () { return [{ label: '学段', text: '缓存里的学段' }]; };
  `, sandbox);
  try {
    const withSnapshot = sandbox.memoryBadgeSections({ sections: [{ label: '学段', text: '大一' }] });
    if (withSnapshot.length !== 1 || withSnapshot[0].text !== '大一') {
      throw new Error('有快照时应以快照为准：' + JSON.stringify(withSnapshot));
    }
    const emptySnapshot = sandbox.memoryBadgeSections({ sections: [] });
    if (emptySnapshot.length !== 0) throw new Error('服务端说本次没注入时不得显示角标');
  } finally {
    vm.runInContext(`_cachedProfile = null;`, sandbox);
  }
  return true;
});

check('memory-v2：角标分节与后端注入同构（学段/目标/薄弱/兴趣/偏好/其他，停用与空闲返回空）', () => {
  vm.runInContext(`
    _cachedProfile = {
      enabled: true,
      explicit: { stage: '高二', goal: '', interests: '天体物理', weakAreas: '', style: { detail: '标准', jargon: '通俗', visuals: '否' } },
      facts: [
        { id: 'pf_1', fact: '检测多次答错：电磁感应', category: 'weakness', status: 'active' },
        { id: 'pf_2', fact: '休眠事实', category: 'other', status: 'idle' },
      ],
      pending: [],
    };
  `, sandbox);
  try {
    const sections = sandbox.memoryBadgeSections();
    const labels = sections.map(s => s.label).join(',');
    if (!labels.includes('学段') || !labels.includes('薄弱') || !labels.includes('兴趣') || !labels.includes('偏好')) {
      throw new Error('角标分节不全：' + labels);
    }
    if (labels.includes('其他')) throw new Error('idle 事实不应出现在角标');
    vm.runInContext(`_cachedProfile.enabled = false;`, sandbox);
    if (sandbox.memoryBadgeSections().length !== 0) throw new Error('停用时应返回空分节');
  } finally {
    vm.runInContext(`_cachedProfile = null;`, sandbox);
  }
  return true;
});

check('memory-v2：相对时间口径（刚刚/分钟/小时/天/日期；服务端秒级时间戳自动换算）', () => {
  const now = Date.now();
  if (sandbox.memoryRelTime(now - 5000) !== '刚刚') throw new Error('5 秒前应为 刚刚');
  if (sandbox.memoryRelTime(now - 5 * 60000) !== '5 分钟前') throw new Error('分钟口径错');
  if (sandbox.memoryRelTime(now - 3 * 3600000) !== '3 小时前') throw new Error('小时口径错');
  if (sandbox.memoryRelTime(now - 2 * 86400000) !== '2 天前') throw new Error('天口径错');
  if (sandbox.memoryRelTime(0) !== '—') throw new Error('无时间戳应为 —');
  // 服务端 time.time() 是秒：不换算会算出天文数字差值，落到 1970 年的日期
  const secNow = Math.floor(now / 1000);
  if (sandbox.memoryRelTime(secNow - 3 * 3600) !== '3 小时前') {
    throw new Error('秒级时间戳未换算：' + sandbox.memoryRelTime(secNow - 3 * 3600));
  }
  return true;
});

check('memory-v2：确定性信号采集——薄弱(≥2错)与兴趣(≥3会话)成候选，发送成功才记 7 天防重账', () => {
  const now = Date.now();
  sandbox.localStorage.setItem('phymathia_quiz_stats', JSON.stringify({
    t1: { title: '简谐运动', wrong: 2, correct: 0, mastery: 30, last: now },
    t2: { title: '牛顿第二定律', wrong: 1, correct: 5, mastery: 90, last: now },
  }));
  // getKnowledgeItems 是 bundle 里的真函数（词法绑定，stub window 盖不掉），直接播种其数据源
  sandbox.localStorage.setItem('phymathia_knowledge', JSON.stringify({
    k1: { title: '梯度', sessionId: 's1' },
    k2: { title: '梯度', sessionId: 's2' },
    k3: { title: '梯度', sessionId: 's3' },
    k4: { title: '散度', sessionId: 's1' },
  }));
  if (typeof sandbox.invalidateKnowledgeCache === 'function') sandbox.invalidateKnowledgeCache();
  sandbox.localStorage.removeItem('phymathia_memory_signal_sync');
  try {
    const first = sandbox._collectProfileSignalCandidates();
    const facts = first.candidates.map(c => c.fact).join('|');
    if (!facts.includes('检测多次答错：简谐运动')) throw new Error('薄弱候选缺失：' + facts);
    if (!facts.includes('经常提问：梯度')) throw new Error('兴趣候选缺失：' + facts);
    if (facts.includes('牛顿第二定律')) throw new Error('1 错且高掌握不应判薄弱：' + facts);
    if (facts.includes('散度')) throw new Error('单会话主题不应判兴趣：' + facts);
    // 未发送成功不落账：重复采集仍能拿到同样候选（POST 失败不消耗 7 天窗口）
    const again = sandbox._collectProfileSignalCandidates();
    if (again.candidates.length !== first.candidates.length) {
      throw new Error('未发送成功不应记账：' + again.candidates.map(c => c.fact).join('|'));
    }
    // 模拟整批被服务端确认接收后的防重账；部分接收由阶段2隔离回归覆盖。
    const synced = JSON.parse(sandbox.localStorage.getItem('phymathia_memory_signal_sync') || '{}');
    for (const syncKey of Object.values(first.marks)) synced[syncKey] = now;
    sandbox.localStorage.setItem('phymathia_memory_signal_sync', JSON.stringify(synced));
    const third = sandbox._collectProfileSignalCandidates();
    if (third.candidates.length !== 0) throw new Error('7 天防重账未生效：' + third.candidates.map(c => c.fact).join('|'));
  } finally {
    sandbox.localStorage.removeItem('phymathia_quiz_stats');
    sandbox.localStorage.removeItem('phymathia_knowledge');
    sandbox.localStorage.removeItem('phymathia_memory_signal_sync');
    if (typeof sandbox.invalidateKnowledgeCache === 'function') sandbox.invalidateKnowledgeCache();
  }
  return true;
});

// ===== 设计尺子（2026-09-17）：新控件必须走令牌，同类载体必须同圆角 =====
// 这三条是「防漂」闸门：改样式时若把裸值/新色值写回来，或让同类弹窗圆角跑偏，会在这里红。

check('设计尺子：圆角一律走 --r-* 令牌（只允许 50%/0/inherit 这类结构性取值）', () => {
  const files = ['src/static/css/styles.css', 'src/static/css/styles-panels.css', 'src/static/css/graph-override.css'];
  const allowed = new Set(['50%', '0', 'inherit']);
  const bad = [];
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/border-radius\s*:\s*([^;{}]+);/g)) {
      const parts = m[1].replace(/\s*!important\s*/, '').trim().split(/\s+/);
      for (const v of parts) {
        if (v.startsWith('var(--r-') || allowed.has(v)) continue;
        bad.push(f.split('/').pop() + ' → ' + m[1].trim());
      }
    }
  }
  if (bad.length) throw new Error('还有 ' + bad.length + ' 处圆角写了裸值，应改用 --r-*：\n    ' + bad.slice(0, 6).join('\n    '));
  return true;
});

check('设计尺子：字号走 --fs-* 令牌（≥15px 的图标/标题档暂不强制）', () => {
  const files = ['src/static/css/styles.css', 'src/static/css/styles-panels.css'];
  const bad = [];
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/font-size\s*:\s*([^;{}]+);/g)) {
      const v = m[1].replace(/\s*!important\s*/, '').trim();
      if (v.startsWith('var(--fs-')) continue;
      const px = parseFloat(v);
      // 15px 以上是图标/标题/装饰档，允许保留；em/% 是相对尺寸，另有语义
      if (/^(\d+(?:\.\d+)?)px$/.test(v) && px < 15) bad.push(v);
    }
  }
  if (bad.length) throw new Error('还有 ' + bad.length + ' 处小字号写了裸值，应改用 --fs-*：' + [...new Set(bad)].join(', '));
  return true;
});

check('设计尺子：状态色只认 --danger/--success/--warn（域色不受限）', () => {
  const files = ['src/static/css/styles.css', 'src/static/css/styles-panels.css', 'src/static/css/graph-override.css'];
  const gate = /(danger|delete|remove|clear|error|fail|wrong|bad\b|correct|pass\b|saved|success|warn|waiting|done|accept|ignore|good|\bok\b|is-danger)/;
  const deny = /(graph-module|graph-node-module|kp-card-dot|graph-diff-|graph-history-badge|graph-ai-eval|graph-harness-op-|graph-node-attribute|continent-user-link)/;
  const lit = /(#[0-9a-fA-F]{6}|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+[^)]*\))/g;
  const bad = [];
  for (const f of files) {
    const css = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].replace(/\s+/g, ' ').trim();
      if (!sel || sel.startsWith('@') || !gate.test(sel) || deny.test(sel)) continue;
      for (const d of m[2].matchAll(/(color|background|background-color|border-color)\s*:\s*([^;{}]+);/g)) {
        const hits = (d[2].match(lit) || []).filter((v) => {
          const rgb = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          let r, g, b;
          if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
          else { r = parseInt(v.slice(1, 3), 16); g = parseInt(v.slice(3, 5), 16); b = parseInt(v.slice(5, 7), 16); }
          return (r > 185 && 110 < g && g < 220 && b < 100) || (r > 190 && g < 130 && b < 150) || (g > 130 && r < 100 && b < 170);
        });
        if (hits.length) bad.push(sel.slice(0, 44) + ' → ' + d[1] + ': ' + hits.join(' '));
      }
    }
  }
  if (bad.length) throw new Error('状态色还有 ' + bad.length + ' 处硬编码，应改用 --danger/--success/--warn 族：\n    ' + bad.slice(0, 6).join('\n    '));
  return true;
});

check('设计尺子：面板关闭键必须有 aria-label（无障碍 + 统一关闭语义）', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const bad = [];
  for (const m of html.matchAll(/<button[^>]*class="[^"]*\bclose\b[^"]*"[^>]*>/g)) {
    if (!/aria-label=/.test(m[0])) bad.push(m[0].slice(0, 70));
  }
  if (bad.length) throw new Error('关闭按钮缺 aria-label：\n    ' + bad.join('\n    '));
  return true;
});

check('设计尺子：同类载体的圆角同档（弹窗 --r-lg / 大浮层 --r-xl / 胶囊 --r-pill）', () => {
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8') + fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  const want = [
    ['.socratic-modal', '--r-lg', '表单弹窗'],
    ['.memory-dialog', '--r-lg', '确认弹窗'],
    ['.graph-canvas-toolbar', '--r-xl', '画布工具栏'],
    ['.example-guide-dialog', '--r-xl', '示例讲解'],
    ['.kp-search', '--r-pill', '搜索胶囊'],
  ];
  for (const [sel, tok, label] of want) {
    // 同名选择器可能有多条规则（响应式覆写等），只要求「至少有一条」把圆角定到该档
    const re = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}', 'g');
    const rules = [...css.matchAll(re)].map((m) => m[1]);
    if (!rules.length) continue;    // 选择器不在本文件管辖范围时跳过（graph-override 另算）
    if (!rules.some((r) => r.includes('var(' + tok + ')'))) throw new Error(label + '（' + sel + '）圆角应为 ' + tok);
  }
  return true;
});

// ===== 横屏视觉打磨（2026-09-27）：纯 CSS 块的四条硬契约 =====
// 1) 新样式必须包在 `@media (orientation: landscape)` 里——竖屏一像素不许动
//    （4 档横屏实测全绿，但没有任何机制能挡住下一个人把规则挪出媒体块）
// 2) 必须带应用作用域，只读外发页（viewer.html）不命中
// 3) 浮层作用域写错**静默不命中**——`.app-container .task-panel` 这类白写一遍不报错，
//    本轮就白改过一轮（index.html 里 .app-container 在 341 行就闭合了，
//    task/model/level/data 四个浮层都是它的**兄弟**节点）。所以逐条钉死。
// 4) 这轮只许动排版与位置，不许顺手回退材质/形状（那两条都是用户拍板过的）
check('横屏打磨：规则全在 orientation:landscape 内 + 浮层作用域写对 + 不回退材质形状', () => {
const scss = fs.readFileSync('src/static/css/styles.css', 'utf8');
const gcss = fs.readFileSync('src/static/css/graph-override.css', 'utf8');

// 剥掉注释（**保留字符数**，用等长空格替换，这样后面按下标定位仍然对得上原文件）。
// 不剥会踩一个很难发现的坑：注释里写的 `@media (orientation: landscape)` 字面量
// 会被下面的正则当成真块，扫到后面第一个 `{` 就配平出一个**幽灵块**，
// 把块外的选择器也算成「在块内」——把真块改成 portrait 都能照样通过（已实测）。
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));

// 抽出 `@media (orientation: landscape) { ... }` 的块（按大括号配平）
function landscapeBlocks(rawCss) {
  const css = stripComments(rawCss);
  const out = [];
  const re = /@media[^{]*orientation:\s*landscape[^{]*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let i = m.index + m[0].length, depth = 1;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
      i++;
    }
    out.push({ start: m.index, end: i });
  }
  return out;
}

for (const [file, rawCss, probes] of [
  ['styles.css', scss, ['.app-container .chat-header', 'body:has(> .app-container) .task-panel']],
  ['graph-override.css', gcss, ['.app-container .graph-canvas-toolbar', 'body:has(> .graph-harness-window:not([hidden])) .phi-pet-root']],
]) {
  // 探针也在**剥掉注释后**的文本里数：注释里为了讲清「哪种写法是错的」会引用选择器字面量，
  // 按原文数会把那些说明文字算成一处「落在横屏块外的规则」（本轮就先踩了这一个）。
  const css = stripComments(rawCss);
  const blocks = landscapeBlocks(rawCss);
  if (!blocks.length) throw new Error(file + ' 里找不到 @media (orientation: landscape) 块');
  for (const probe of probes) {
    // 必须**每一处**出现都在横屏块内。只要求「至少有一处在块内」是不够的：
    // 把主块改成 portrait 时，文件末尾那条 `(orientation: landscape) and (max-width: 1240px)`
    // 里还有同名选择器，`inside > 0` 照样成立——变异验证就是这么漏过去的（已实测）。
    let idx = -1, total = 0, inside = 0;
    while ((idx = css.indexOf(probe, idx + 1)) !== -1) {
      total++;
      if (blocks.some((b) => idx >= b.start && idx < b.end)) inside++;
    }
    if (total === 0) throw new Error('找不到「' + probe + '」@ ' + file);
    if (inside !== total) {
      throw new Error('「' + probe + '」在 ' + file + ' 里有 ' + (total - inside) + '/' + total
        + ' 处落在 @media (orientation: landscape) 之外——竖屏会被一起改到');
    }
  }
}

// 四个浮层是 .app-container 的兄弟节点，用后代选择器会静默不命中（本轮踩过）
for (const probe of [
  'body:has(> .app-container) .task-panel {',
  'body:has(> .app-container) .task-panel-title',
  'body:has(> .app-container) .model-panel',
  'body:has(> .app-container) .level-panel',
  'body:has(> .app-container) #dataPanel',
]) {
  if (!scss.includes(probe)) {
    throw new Error('缺「' + probe + '」——这些浮层在 index.html 里是 .app-container 的**兄弟**，'
      + '写成 .app-container X 静默不命中（白改不报错）');
  }
}

// 停靠形状不许被这轮碰：接缝拉直（上两角 0）+ 底角 --r-2xl
// 注意锚点：`.task-panel.show.task-panel--docked {` 里**也含** `.task-panel--docked {` 这个子串，
// 直接 indexOf 会先撞上那一条（它只改 display/flex，没有圆角）→ 必须带行首缩进锚定。
const dockAt = scss.indexOf('\n    .task-panel--docked {');
const dock = dockAt < 0 ? '' : scss.slice(dockAt, scss.indexOf('}', dockAt));
if (!/border-radius: 0 0 var\(--r-2xl\) var\(--r-2xl\);/.test(dock)) {
  throw new Error('任务面板停靠形状被改了（应仍是 `0 0 var(--r-2xl) var(--r-2xl)`：接缝拉直、底角 24px）');
}

// 纯色玻璃档不许被「顺手加回渐变」——用户 2026-09-27 明确要「取消渐变但要有颜色」
for (const sel of ['.aurora-glass--plain {', '.aurora-glass--attached {']) {
  const at = scss.indexOf(sel);
  const blk = scss.slice(at, scss.indexOf('}', at));
  if (/radial-gradient/.test(blk)) throw new Error(sel + ' 被加回了色斑渐变（--aurora-* 归零才是用户要的口径）');
}

// 桌宠让位规则必须跟着窗口的 [hidden] 走（与 harness.js 的开关口径一致），
// 且必须落到窗口之下——只挪位置不改层级，桌宠被拖到窗口上仍会吃掉「发送」键（backlog T51）
const petSel = 'body:has(> .graph-harness-window:not([hidden])) .phi-pet-root {';
const petAt = gcss.indexOf(petSel);
if (petAt < 0) throw new Error('缺桌宠让位规则：窗口开着时桌宠仍会盖住 Φ 面板的「发送」键（T51）');
const petRule = gcss.slice(petAt, gcss.indexOf('}', petAt));
if (!/z-index:\s*var\(--z-\w+\);/.test(petRule)) {
  throw new Error('桌宠让位规则缺 z-index：只挪位置不改层级，被拖到窗口上的桌宠仍会吃掉控件点击');
}
return true;
});

// 串行段里的异步用例同样进 pendingChecks——必须再收一次，否则断言结果赶不上退出判定
await Promise.all(pendingChecks).catch(() => {});

// ===== 串行边界追加：utopia 快照导入（写共享 phymathia_sessions 键 + await fetch）=====
// 2026-09-27：只读外发页的右键菜单是**按标签文本**做白名单剪枝的
// （viewer-main.js 的 READONLY_MENU_LABELS）。也就是说主应用那边一改菜单文案，
// 这里不同步的话，查看器里那个菜单项会被**静默剪掉**——整张菜单空了还会顺手 close，
// 症状是「只读页右键少了一项」，全程无任何报错。
// 「导出超高清 PNG…」改成「导出…」时踩过一次，靠肉眼看出来的。这条断言把它变成会红的。
check('viewer: 只读菜单白名单的每一条都还能在主应用菜单里找到', () => {
  const vm = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');
  const cm = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
  const m = vm.match(/var READONLY_MENU_LABELS = \[([\s\S]*?)\];/);
  if (!m) throw new Error('viewer-main.js 里找不到 READONLY_MENU_LABELS');
  const labels = (m[1].match(/'([^']+)'/g) || []).map(x => x.slice(1, -1));
  if (!labels.length) throw new Error('白名单解析出 0 条，断言本身坏了');
  // 判据是「该文案有没有作为引号字面量出现在菜单文件里」，不去解析 `label:` 那一行——
  // 那边不都是字面量：折叠/展开是三元表达式（`node.minimized ? '展开节点' : '折叠节点'`），
  // 「删除 」还带尾随空格。顺带记一笔：别用 `/'[^']+'/g` 一次抽全部字符串——源码里到处是
  // `|| ''` 这种空串，`[^']+` 匹配不上会一路错位把后面的内容吞进来（第一版就这么把
  // 「复制全文」判成了不存在）。这正是要挡的失败模式：文案被改掉或删掉。
  // 白名单是**前缀**匹配（label.indexOf(kw) === 0），所以菜单里写「导出…」而白名单写
  // 「导出」是合法的——判据跟着前缀语义走：文本出现在一个单引号之后即可。
  for (const lb of labels) {
    if (cm.indexOf("'" + lb) < 0) {
      throw new Error('白名单里的「' + lb + '」在 graph-contextmenu.js 里已不存在'
        + '——主应用改了菜单文案，这里必须同步，否则只读页那个菜单项会被静默剪掉');
    }
  }
});

check('viewer: 拓扑兜网的封装与访问器都是幂等的（防 Proxy 逐次套娃）', () => {
  // 2026-09-27 晚：原实现每渲染一次就把上一个 Proxy 当底子再封一层，嵌套层数随渲染
  // 次数线性增长（评审时用最小复现验实）。**这是个性能泄漏不是正确性破坏，所以下面
  // 这些护栏全删掉也不会有任何一条断言变红**——只能靠静态契约钉住。
  // 变异验证：删掉 `_SEALED.has(...)` 两处之一、或把 `TOPOLOGY_INSTALLED` 的守门去掉，
  // 本条立刻变红。
  const vm = fs.readFileSync('src/static/js/viewer-main.js', 'utf8');

  if (!/var _SEALED = new WeakSet\(\)/.test(vm)) {
    throw new Error('viewer-main.js 里找不到 _SEALED = new WeakSet()——封装不再幂等，'
      + '每渲染一次多套一层 Proxy');
  }
  // 两个封装函数各要有一道 has() 短路：_sealArray 与 _sealIndex，缺一个就漏一个属性
  const hasChecks = (vm.match(/_SEALED\.has\(/g) || []).length;
  if (hasChecks !== 2) {
    throw new Error('_SEALED.has() 出现 ' + hasChecks + ' 次（应为 2：_sealArray 与 _sealIndex 各一）');
  }
  const adds = (vm.match(/_SEALED\.add\(/g) || []).length;
  if (adds !== 2) {
    throw new Error('_SEALED.add() 出现 ' + adds + ' 次（应为 2）——新装的代理没登记，下次会被当裸对象再封一层');
  }
  if (!/if \(!TOPOLOGY_INSTALLED\) _installTopologyAccessors\(\)/.test(vm)) {
    throw new Error('armTopologyGuard 里的 TOPOLOGY_INSTALLED 守门不见了——'
      + '每渲染一次重复 defineProperty 四个属性');
  }
  // 顺序不许反：先装访问器（内部经访问器读已封装的代理）再重算基线，反了会拿到裸数组算指纹
  const arm = vm.slice(vm.indexOf('function armTopologyGuard'));
  const armEnd = arm.indexOf('\n  }');
  const body = arm.slice(0, armEnd);
  if (body.indexOf('_installTopologyAccessors') > body.indexOf('TOPOLOGY_BASE =')) {
    throw new Error('armTopologyGuard 里先算基线后装访问器——指纹会从裸数组算，兜网从第一帧就失效');
  }
});

check('graph-workflow: 三个流式通道共用一份 SSE 读取（作用域限本文件）', () => {
  // 2026-09-27：B2 把三个流式函数里逐字重复的 SSE 帧读取抽成唯一一份
  // `_sseContentFrames`。这里钉住那个不变量——**别再往回抄**。抄回去的症状是
  // 「某类节点偶发不更新」，静态断言看不出来，只有真发才知道（而真发需要可用模型，
  // 见 docs/backlog.md T37）。所以退化成重复时必须在这里就红。
  //
  // **注意这条断言的作用域：它只读 graph-workflow.js 一个文件。**
  // 2026-09-27 之前它叫「SSE 帧读取全仓只有一份」，那句是错的：全仓另有 4 处各自一份
  // getReader() 副本（chat.js:308 / chat-features.js:647 / quiz-ui.js:675 /
  // harness-run.js:113，后者是 buf+handleLine 的变体），B2 只合并了 graph-workflow 里的
  // 3 份。名字写成「全仓」会让人以为另外四处已被覆盖、进而不再去合并。
  // 那 4 处的合并已登记 backlog（连同真发验证要求），不在本轮范围：动发送链路按硬规则 6
  // 必须配可用模型真发验证，而现在没有可用凭证。所以这里改成如实描述作用域。
  const gw = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  // 数代码，不数散文：先把注释剥掉再数。上面那段说明里就写了 getReader() 字面量，
  // 原先直接对原文匹配，注释一改就假红——这正是本项目吃过亏的那类「护栏自己变摆设」。
  // 剥法：块注释全去，行注释只去「行首（可含缩进）//」那种。行尾注释与字符串里的 //
  // （如 'http://'）不去，避免误删真代码导致计数偏低。代价是行尾注释里写
  // getReader() 仍会被算进去——写注释时避开这个字面量即可。
  const gwCode = gw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const readers = (gwCode.match(/getReader\(\)/g) || []).length;
  if (readers !== 1) {
    throw new Error('graph-workflow.js 里 getReader() 出现 ' + readers
      + ' 次（应为 1）——有人在这三个通道之外又把 SSE 读取抄了一份');
  }
  if (!/async function\* _sseContentFrames\(resp\)/.test(gwCode)) {
    throw new Error('共享读取口 _sseContentFrames 不见了');
  }
  const users = (gwCode.match(/for await \(const piece of _sseContentFrames\(resp\)\)/g) || []).length;
  if (users !== 4) {
    throw new Error('_sseContentFrames 的调用点 ' + users + ' 处（应为 4：模块节点 / 问题分析 / 空白节点 / 配方双阶段概要 P2）');
  }
  // 只吐正文增量：思维链绝不能混进正文（2026-09-15「旋度岛静默消失」的根因）
  // 在 gwCode 上切片：共享口自己那句「绝不碰 reasoning_content」的说明注释
  // 一旦挪进函数体内部，用原文匹配就会自己把自己判红。
  const gen = gwCode.slice(gwCode.indexOf('async function* _sseContentFrames'));
  const genEnd = gen.indexOf('\nasync function ', 1);
  const body = genEnd > 0 ? gen.slice(0, genEnd) : gen;
  if (/reasoning_content/.test(body)) {
    throw new Error('共享读取口里出现了 reasoning_content——思维链不许混进正文');
  }
  for (const fn of ['_streamCustomNodeResponse', '_streamAnalysisResponse', '_streamBlankNodeResponse']) {
    const i = gwCode.indexOf('async function ' + fn + '(');
    if (i < 0) throw new Error('找不到 ' + fn);
    const seg = gwCode.slice(i, i + 4000);
    if (!seg.includes('_sseContentFrames(resp)')) {
      throw new Error(fn + ' 没走共享读取口');
    }
  }
});

check('utopia-import: .pmu 恢复成新画布（三写落位 + 永不覆盖现有会话）', async () => {
  // 识别纯函数：.pmu 收、其它后缀放行
  const accept = sandbox.window.utopiaImportAccept;
  if (typeof accept !== 'function') throw new Error('utopiaImportAccept 未暴露');
  if (!accept({ name: 'a.PMU' })) throw new Error('.pmu 应被接受（大小写不敏感）');
  if (accept({ name: 'a.json' })) throw new Error('.json 不应走快照导入（避免抢数据导入通道）');
  if (accept(null)) throw new Error('空文件应被拒绝');
  // 行为级：真实 parse + 三写 + 切换
  const before = (() => { try { return JSON.parse(sandbox.localStorage.getItem('phymathia_sessions') || '{}'); } catch (e) { return {}; } })();
  const snapshot = {
    format: 'phymath-utopia/graph', version: 1,
    title: '导入测试网', graph: { pan: { x: 5, y: 6 }, zoom: 1 },
    nodes: [], edges: [], groups: [],
    messages: [{ role: 'user', content: 'q1', timestamp: 1 }, { role: 'assistant', content: 'a1', timestamp: 2 }],
  };
  
  const prevSwitch = sandbox.window.switchToSession;   // import 走 window.switchToSession（session.js 挂载）
  const prevSync = sandbox.window.syncFromServer;
  const prevFetch = sandbox.fetch;
  const calls = [];
  sandbox.window.switchToSession = async () => { calls.push('switch'); };
  sandbox.window.syncFromServer = async () => { calls.push('sync'); };
  sandbox.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' };
  };
  let ok = false;
  try {
    ok = await sandbox.window.importUtopiaSnapshotText(JSON.stringify(snapshot), 'demo.pmu');
  } finally {
    sandbox.window.switchToSession = prevSwitch;
    sandbox.window.syncFromServer = prevSync;
    sandbox.fetch = prevFetch;
  }
  if (ok !== true) throw new Error('导入应返回 true');
  const after = (() => { try { return JSON.parse(sandbox.localStorage.getItem('phymathia_sessions') || '{}'); } catch (e) { return {}; } })();
  const newIds = Object.keys(after).filter((k) => !(k in before));
  if (newIds.length !== 1) throw new Error('应恰好新建一个会话：' + newIds.length);
  const sid = newIds[0];
  if (after[sid].title !== '导入测试网') throw new Error('会话标题应取快照标题');
  const msgs = JSON.parse(sandbox.localStorage.getItem('phymathia_msgs_' + sid) || '[]');
  if (msgs.length !== 2) throw new Error('消息应完整落位');
  const gst = JSON.parse(sandbox.localStorage.getItem('phymathia_graph_' + sid) || 'null');
  if (!gst || gst.pan.x !== 5) throw new Error('图状态应完整落位');
  // 服务端三写 + 切换都发生
  if (!calls.some((c) => c.includes('/api/sessions')) || !calls.some((c) => c.includes('/messages'))
    || !calls.some((c) => c.includes('graph%3A') || c.includes('graph:'))) throw new Error('服务端三写缺失：' + JSON.stringify(calls));
  if (!calls.includes('switch')) throw new Error('导入后应切换到新画布');
  // 收尾：清掉测试会话，不污染后续用例
  delete after[sid];
  sandbox.localStorage.setItem('phymathia_sessions', JSON.stringify(after));
  sandbox.localStorage.removeItem('phymathia_msgs_' + sid);
  sandbox.localStorage.removeItem('phymathia_graph_' + sid);
  return true;
});

// ===== v8.1 有机抖动层：几何断言同步跑，不 await、不碰共享会话键 =====
// 抖动是这一轮唯一会动坐标的东西，所以它的正确性全靠这里钉住。核心不变量四条：
// ① 确定性（同输入逐字节一致，否则刷新页面位置乱跳）；② 岛不重叠（否则点错岛）；
// ③ 岛在板内、卡在岛内（否则岛牌与卡脱节、点岛屿进的是空处）；④ 世界罩住一切。
check('graph-continent: v8.1 有机抖动层（确定性 / 不重叠 / 岛在板内 / 卡在岛内 / 世界罩住 / 网格态归零）', () => {
  const jitter = sandbox._continentJitter;
  const j1 = sandbox._continentJitter1;
  const regionLayout = sandbox._continentRegionLayout;
  const regions = sandbox._continentRegions;
  if (typeof jitter !== 'function' || typeof j1 !== 'function'
      || typeof regionLayout !== 'function' || typeof regions !== 'function') {
    throw new Error('v8.1 纯函数未暴露（jitter / jitter1 / regionLayout / regions）');
  }
  const store = sandbox.localStorage;
  const STYLE_KEY = 'phymathia_continent_style';
  const prevMode = store.getItem(STYLE_KEY);
  const setMode = v => store.setItem(STYLE_KEY, v);

  // 伪随机源：确定性 + 值域 [-1,1]
  for (const k of ['a', 'sess_1', 'ki_9f3', '矢量分析', '']) {
    if (j1(k, 'x-off') !== j1(k, 'x-off')) throw new Error('伪随机源不确定：' + k);
    for (const s of ['x-off', 'y-off', 'rot-2']) {
      const v = j1(k, s);
      if (!Number.isFinite(v) || v < -1 || v > 1) throw new Error('伪随机值越界：' + k + '/' + s + '=' + v);
    }
  }
  // 两轴**相关性**（不是「x !== y」那种精确不等）—— 盐是拼在 key 末尾的，FNV-1a
  // 逐字节左到右推进，两个盐若只差末字符，两轴输出几乎不动，位移全体沿 45° 对角线走。
  // 这条以前写成 `j1(k,'x') === j1(k,'y')`（恒为假的精确比较），实测漏掉了 0.97 的
  // 相关系数 —— 整张图在真机上一直是「整体斜滑」。见 graph-continent.js 同处注释。
  const corrOf = (a, b, keys) => {
    const xs = keys.map(k => j1(k, a)), ys = keys.map(k => j1(k, b));
    const n = xs.length;
    const mx = xs.reduce((p, q) => p + q) / n, my = ys.reduce((p, q) => p + q) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const u = xs[i] - mx, v = ys[i] - my;
      sxy += u * v; sxx += u * u; syy += v * v;
    }
    return Math.abs(sxy / Math.sqrt(sxx * syy));
  };
  // 两类 key 都测：真实 sessionId 风格 + 短编号风格（后者是 FNV-1a 最容易退化的输入）
  const corrKeys = [], corrShort = [];
  for (let i = 0; i < 200; i++) {
    const h = ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
    corrKeys.push('sess_' + h + 'k');
    corrShort.push('v' + i);
  }
  [['x-off', 'y-off'], ['x-off', 'rot-2']].forEach(([sa, sb]) => {
    [corrKeys, corrShort].forEach(keys => {
      const c = corrOf(sa, sb, keys);
      if (c > 0.3) {
        throw new Error('两轴/转角高度相关（位移会沿对角线走）：' + sa + '/' + sb + ' = ' + c.toFixed(3));
      }
    });
  });

  const cl = (sid, domain, conf, n) => ({
    sessionId: sid, title: sid, domain: domain, domainConf: conf, domainSource: 'vote',
    itemCount: n, items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  // 验收口径：3 座矢量分析岛（其中一座 9 张卡 = 满格 3x3）+ 3 座散岛，覆盖两条路径
  const clusters = [
    cl('v1', '矢量分析', 0.95, 9), cl('v2', '矢量分析', 0.8, 4), cl('v3', '矢量分析', 0.5, 2),
    cl('keep', '守恒定律', 0.98, 1), cl('none', null, 0, 3), cl('unsure', '量子力学', 0.33, 1),
  ];
  const info = regions(clusters, { renames: {}, assign: {} }, ['矢量分析', '守恒定律', '量子力学']);
  const raw = regionLayout(info.regions, info.bySid, clusters, [], []);
  const itemSession = {};
  const regionOfSession = {};
  clusters.forEach(c => {
    (c.items || []).forEach(it => { itemSession[it.itemId] = c.sessionId; });
    regionOfSession[c.sessionId] = (info.bySid[c.sessionId] || {}).key || '';
  });

  const EPS = 1e-6;
  const overlaps = (a, b) => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS
    && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
  const insideOf = (r, box) => r.x >= box.x - EPS && r.y >= box.y - EPS
    && r.x + r.w <= box.x + box.w + EPS && r.y + r.h <= box.y + box.h + EPS;

  try {
    setMode('organic');
    // ① 确定性：同输入两次抖动逐字节一致（位置带信息，刷新跳一下就是 bug）
    const a = jitter(raw, itemSession, regionOfSession);
    const b = jitter(raw, itemSession, regionOfSession);
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('抖动不确定（同输入两次输出不同）');
    if (!a.organic) throw new Error('有机态没标 organic');
    // 真的动了：每个矩形都应与未抖动值不同，否则这层等于没接上
    const moved = a.clusterRects.filter((r, i) =>
      r.x !== raw.clusterRects[i].x || r.y !== raw.clusterRects[i].y).length;
    if (moved !== a.clusterRects.length) throw new Error('有岛没被抖动（' + moved + '/' + a.clusterRects.length + '）');

    // ② 世界尺寸一个像素都不许长（v8.1 踩坑点）：世界一大，适配 zoom 就被压小，
    // 跌过 CONTINENT_LOD_WORLD=0.55 会把概念卡整档隐藏，「开图点得到卡」当场断。
    // 抖动必须完全装进布局原有的 60px 白边里。
    if (a.worldW !== raw.worldW || a.worldH !== raw.worldH) {
      throw new Error('抖动把世界撑大了（zoom/LOD 会跟着变）：'
        + raw.worldW + 'x' + raw.worldH + ' → ' + a.worldW + 'x' + a.worldH);
    }
    // ③ 一切仍在世界界内（外伸必须装得下 60px 白边）
    for (const r of a.clusterRects) {
      if (r.x < 0 || r.y < 0 || r.x + r.w > a.worldW || r.y + r.h > a.worldH) {
        throw new Error('岛出世界边界：' + r.sessionId);
      }
    }
    for (const r of a.regionRects) {
      if (r.x < 0 || r.y < 0 || r.x + r.w > a.worldW || r.y + r.h > a.worldH) {
        throw new Error('海域板出世界边界：' + r.key);
      }
    }

    // ③ 岛两两不重叠（重叠 = 点到 A 命中 B）
    for (let i = 0; i < a.clusterRects.length; i++) {
      for (let j = i + 1; j < a.clusterRects.length; j++) {
        if (overlaps(a.clusterRects[i], a.clusterRects[j])) {
          throw new Error('抖动后两岛重叠：' + a.clusterRects[i].sessionId + ' × ' + a.clusterRects[j].sessionId);
        }
      }
    }
    // ④ 岛完整落在自己海域板内（板按 CONTINENT_JITTER_ISLAND 外扩就是为了这条）
    const plateOf = {};
    a.regionRects.forEach(p => { plateOf[p.key] = p; });
    a.clusterRects.forEach(r => {
      const key = regionOfSession[r.sessionId];
      const p = key && plateOf[key];
      if (p && !insideOf(r, p)) throw new Error('岛捅出海域板：' + r.sessionId);
    });
    // ⑤ 卡完整落在自己岛内，且同一岛的卡两两不重叠
    const islandOf = {};
    a.clusterRects.forEach(r => { islandOf[r.sessionId] = r; });
    const cardsByIsland = {};
    Object.keys(a.placements).forEach(iid => {
      const p = a.placements[iid];
      const sid = itemSession[iid];
      const isl = islandOf[sid];
      if (!isl) throw new Error('卡找不到岛：' + iid);
      if (!insideOf(p, isl)) throw new Error('卡越出岛：' + iid);
      (cardsByIsland[sid] = cardsByIsland[sid] || []).push(p);
    });
    Object.keys(cardsByIsland).forEach(sid => {
      const list = cardsByIsland[sid];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          if (overlaps(list[i], list[j])) throw new Error('同岛两卡重叠：' + sid);
        }
      }
    });
    // 卡片尺寸不许被抖动改掉（命中框与 DOM 的 160x46 是一份契约）
    Object.keys(a.placements).forEach(iid => {
      if (a.placements[iid].w !== raw.placements[iid].w || a.placements[iid].h !== raw.placements[iid].h) {
        throw new Error('抖动改了卡片尺寸：' + iid);
      }
    });
    // 旋转角有界（1.4°，别把卡转成斜的排版事故）
    Object.keys(a.cardRot).forEach(iid => {
      if (Math.abs(a.cardRot[iid]) > 1.5) throw new Error('卡转角越界：' + iid + '=' + a.cardRot[iid]);
    });

    // ⑥ 网格态原样归零：逐字节回到未抖动布局（「关掉 = 今天的字节」）
    setMode('grid');
    const g = jitter(raw, itemSession, regionOfSession);
    if (g.organic) throw new Error('网格态仍标 organic');
    if (JSON.stringify(g.placements) !== JSON.stringify(raw.placements)) throw new Error('网格态没原样穿透 placements');
    if (JSON.stringify(g.clusterRects) !== JSON.stringify(raw.clusterRects)) throw new Error('网格态没原样穿透 clusterRects');
    if (JSON.stringify(g.regionRects) !== JSON.stringify(raw.regionRects)) throw new Error('网格态没原样穿透 regionRects');
    if (g.worldW !== raw.worldW || g.worldH !== raw.worldH) throw new Error('网格态世界尺寸被改了');
    if (Object.keys(g.cardRot).length !== 0) throw new Error('网格态不该有转角');
    // 未登记的键按默认有机（不许因为没存过就退化成网格）
    store.removeItem(STYLE_KEY);
    if (jitter(raw, itemSession, regionOfSession).organic !== true) throw new Error('未设过画风时没落到默认有机');
  } finally {
    if (prevMode === null || prevMode === undefined) store.removeItem(STYLE_KEY);
    else store.setItem(STYLE_KEY, prevMode);
  }

  // 静态契约：抖动层**只**从 _continentRender 进，布局纯函数里一根毛都不许有——
  // 挪进去会让「3 卡岛宽===536 / 1 卡岛宽>=240 / 卡块内居中 / 世界罩住 / 两次
  // 逐字节一致」五条冻结断言当场红（docs/dev/concept-continent.md v8.1）
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const jitStart = src.indexOf('// ---------- v8.1 有机抖动层');
  const body = src.slice(src.indexOf('function _continentLayoutGrid'), jitStart);
  if (/JITTER|_continentJitter/.test(body)) throw new Error('抖动混进了布局纯函数（会毁掉冻结布局契约）');
  const callSites = (src.replace(/function _continentJitter\(/, '')
    .match(/(?<![A-Za-z0-9_])_continentJitter\(/g) || []).length;
  if (callSites !== 1) throw new Error('抖动层调用点应恰好 1 处（_continentRender），实际 ' + callSites);
  // 剥掉行注释再查——抖动层自己的注释里就写着「绝不用 Math.random()」，不剥会自我举报
  const jitCode = src.slice(jitStart, src.indexOf('// ---------- 数据 ----------'))
    .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
  if (/Math\.random/.test(jitCode)) {
    throw new Error('抖动层用了 Math.random（位置会每次刷新乱跳）');
  }
  // 渲染层接线：下游吃抖动后的数据（城市/辐条/航线不脱节的唯一保证）
  const renderSrc = src.slice(src.indexOf('function _continentRender'));
  ['layout = _continentJitter(layout, itemSession, regionOfSession)',
   '_continentDrawPlan(data.shared || [], layout.placements'].forEach(frag => {
    if (!renderSrc.includes(frag)) throw new Error('渲染层未接抖动：' + frag);
  });
  // 质感层：噪点 + 渐变 + 投影 + 转角变量，深浅两套都要有
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  ['.continent-grain', 'linear-gradient(180deg', 'rotate(var(--jr',
   '[data-theme="light"] .continent-cluster', '[data-theme="light"] .continent-node',
   '[data-theme="light"] .continent-region', '.continent-tool.is-on'].forEach(sel => {
    if (!css.includes(sel)) throw new Error('质感层缺失：' + sel);
  });
  if (!/pointer-events:\s*none/.test(css.slice(css.indexOf('.continent-grain')))) {
    throw new Error('噪点层没关指针事件（会挡住画布拖拽）');
  }
  return true;
});

// ===== v8.5 低频位移场：把「场」的三条性质钉死，别退回白噪声 =====
// 同步跑，不 await、不碰共享会话键（只读写画风键，且用 try/finally 复原）。
check('graph-continent: v8.5 低频位移场（幅度上界 / 梯度上界 / 坐标纯函数 / 格点散列 / 协同位移）', () => {
  const warp1 = sandbox._continentWarp1;
  const warpOffset = sandbox._continentWarpOffset;
  const jitter = sandbox._continentJitter;
  const regions = sandbox._continentRegions;
  const regionLayout = sandbox._continentRegionLayout;
  if (typeof warp1 !== 'function' || typeof warpOffset !== 'function') {
    throw new Error('v8.5 位移场纯函数未暴露（warp1 / warpOffset）');
  }
  const COARSE = 900, FINE = 190;   // 与 graph-continent.js 的常量一致（下方静态钉防漂移）

  // ① 幅度上界 |offset| ≤ amp —— **这条是生死线**：白边预算与「岛不撞岛」两条硬约束
  //    全是按 2×amp 推的。第一版忘了两个八度逐轴独立、二维模长多一个 √2
  //    （实测 max|offset| = 1.26×amp），等于按错的数算预算。
  let worst = 0;
  for (let x = 0; x < 6000; x += 37) {
    for (let y = 0; y < 2400; y += 131) {
      const o = warpOffset(x, y, 40);
      worst = Math.max(worst, Math.hypot(o.x, o.y) / 40);
    }
  }
  if (worst > 1) throw new Error('位移超出幅度上界（硬约束的推导前提被打破）：' + worst.toFixed(4) + '×amp');
  // 顺带确认不是「归一化过头、位移恒为 0」
  if (worst < 0.3) throw new Error('位移几乎恒零，位移场等于没接上：' + worst.toFixed(4));

  // ② 梯度上界 |∇n| ≤ 3/cell —— 差值可到 2（值域 [-1,1]），不是半幅 1
  [[COARSE, 'coarse'], [FINE, 'fine']].forEach(([cell, tag]) => {
    const h = 0.5;
    let g = 0;
    for (let x = 0; x < 4000; x += 17) {
      for (let y = 0; y < 2000; y += 149) {
        const gx = (warp1(x + h, y, cell, 'x-warp') - warp1(x - h, y, cell, 'x-warp')) / (2 * h);
        const gy = (warp1(x, y + h, cell, 'x-warp') - warp1(x, y - h, cell, 'x-warp')) / (2 * h);
        g = Math.max(g, Math.hypot(gx, gy));
      }
    }
    if (g > 3 / cell + 1e-9) {
      throw new Error(tag + ' 八度梯度越界：' + g.toFixed(5) + ' > ' + (3 / cell).toFixed(5));
    }
    // 场不能是常数（常数场=整块平移，白费）
    if (g < 3 / cell * 0.2) throw new Error(tag + ' 八度几乎恒定：' + g.toFixed(5));
  });

  // ③ 坐标纯函数：同坐标恒等，且与调用顺序无关（不能有隐藏状态）
  const a1 = warpOffset(1234.5, 678.25, 36);
  warpOffset(9999, 8888, 36);          // 插一次别的调用
  const a2 = warpOffset(1234.5, 678.25, 36);
  if (JSON.stringify(a1) !== JSON.stringify(a2)) throw new Error('位移场不是坐标的纯函数');

  // ④ 格点散列不许退化 —— 这是手册 v8.4 记过的坑（FNV-1a 遇「只差末字符」的编号
  //    几乎不散列，400 个真实 id 上相邻角均差只有 0.013，等于没抖）。这里用格点
  //    坐标当 key，必须实测健康：用「相邻格点值的平均绝对差」，理想均匀 [-1,1] ≈ 0.667。
  //    **必须按格点间距采样**（world = 格号 × cell）：warp1 收的是世界坐标、内部才除
  //    以 cell，在 0~120px 里采样全都落在同一格，量到的是「格内场恒定」而非散列。
  const lat = (i, j) => warp1(i * COARSE, j * COARSE, COARSE, 'x-warp');
  let dOff = 0, latN = 0, latMin = 9, latMax = -9;
  for (let i = 0; i < 120; i++) {
    for (let j = 0; j < 120; j++) {
      dOff += Math.abs(lat(i, j) - lat(i, j + 1));
      latMin = Math.min(latMin, lat(i, j));
      latMax = Math.max(latMax, lat(i, j));
      latN++;
    }
  }
  dOff /= latN;
  if (dOff < 0.4) {
    throw new Error('格点散列退化（相邻格点值太像，场会退化成整块平移）：|Δ|=' + dOff.toFixed(3));
  }
  // ④b 场的两轴不许相关 —— 第一版用 'wx'/'wy'（只差末字符）时实测相关系数 0.98，
  //     位移全体沿 45° 对角线推，场等于白费。盐的差异必须在靠前位置。
  const warpCorr = (sa, sb) => {
    const gx = [], gy = [];
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 40; j++) {
        gx.push(warp1(i * COARSE, j * COARSE, COARSE, sa));
        gy.push(warp1(i * COARSE, j * COARSE, COARSE, sb));
      }
    }
    const n = gx.length;
    const mx = gx.reduce((p, q) => p + q) / n, my = gy.reduce((p, q) => p + q) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const u = gx[i] - mx, v = gy[i] - my;
      sxy += u * v; sxx += u * u; syy += v * v;
    }
    return Math.abs(sxy / Math.sqrt(sxx * syy));
  };
  [['x-warp', 'y-warp'], ['x-warp2', 'y-warp2']].forEach(([sa, sb]) => {
    const c = warpCorr(sa, sb);
    if (c > 0.3) throw new Error('位移场两轴高度相关（会沿对角线推）：' + sa + '/' + sb + ' = ' + c.toFixed(3));
  });
  // 值域要铺满 [-1,1]（散列均匀性）；只在很小范围内取值说明又被末字符主导了
  if (latMax - latMin < 1.0) {
    throw new Error('格点值域过窄（' + latMin.toFixed(2) + '~' + latMax.toFixed(2) + '）');
  }

  // ⑤ 协同位移：世界坐标上挨得近的两座岛，位移也该挨得近 —— 这条是 v8.5 与 v8.1
  //    白噪声的**本质区别**，也是唯一能防「有人把这一刀悄悄退回白噪声」的断言。
  //    白噪声给每座岛独立偏移，近邻位移差与位移幅度同量级（比值 ~1.4）；
  //    低频场下近邻协同，比值应当明显更小。
  const cl = (sid, n) => ({
    sessionId: sid, title: sid, itemCount: n,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  // sessionId 必须像真的：短编号会踩 ④ 那个 FNV-1a 坑，测出来的基线是假的
  const rid = (i) => 'sess_' + ((i * 2654435761) >>> 0).toString(16).padStart(8, '0') + 'k';
  const clusters = Array.from({ length: 9 }, (_, i) => cl(rid(i), 3));
  const info = regions(clusters, { renames: {}, assign: {} }, []);
  const raw = regionLayout(info.regions, info.bySid, clusters, [], []);
  const itemSession = {}, regionOfSession = {};
  clusters.forEach(c => {
    (c.items || []).forEach(it => { itemSession[it.itemId] = c.sessionId; });
    regionOfSession[c.sessionId] = (info.bySid[c.sessionId] || {}).key || '';
  });
  const store = sandbox.localStorage;
  const STYLE_KEY = 'phymathia_continent_style';
  const prev = store.getItem(STYLE_KEY);
  let out;
  try {
    store.setItem(STYLE_KEY, 'organic');
    out = jitter(raw, itemSession, regionOfSession);
  } finally {
    if (prev === null || prev === undefined) store.removeItem(STYLE_KEY);
    else store.setItem(STYLE_KEY, prev);
  }
  const disp = raw.clusterRects.map((r, i) => ({
    x: out.clusterRects[i].cx - r.cx, y: out.clusterRects[i].cy - r.cy,
  }));
  const mag = Math.sqrt(disp.reduce((s, o) => s + o.x * o.x + o.y * o.y, 0) / disp.length);
  let nearDiff = 0, nearN = 0;
  for (let i = 0; i < disp.length; i++) {
    for (let j = i + 1; j < disp.length; j++) {
      const d = Math.hypot(out.clusterRects[i].cx - out.clusterRects[j].cx,
                           out.clusterRects[i].cy - out.clusterRects[j].cy);
      if (d < 700) { nearDiff += Math.hypot(disp[i].x - disp[j].x, disp[i].y - disp[j].y); nearN++; }
    }
  }
  if (!nearN) throw new Error('没凑出近邻岛对，⑤ 测不了');
  const ratio = nearDiff / nearN / mag;
  if (ratio > 1.15) {
    throw new Error('近邻没有协同位移（比值 ' + ratio.toFixed(3)
      + '，白噪声约 1.4）——位移层可能已退回逐元素白噪声');
  }
  if (mag < 1) throw new Error('岛几乎没动：' + mag.toFixed(3));

  // 静态钉：本 check 硬编码了波长（沙箱里读不到 bundle 顶层 const 的值），源里改了
  // 常量必须同步改这里，否则会拿着旧波长量新场、静默放过回归。
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  [['CONTINENT_WARP_CELL_COARSE', COARSE], ['CONTINENT_WARP_CELL_FINE', FINE]].forEach(([k, v]) => {
    if (!new RegExp('const ' + k + ' = ' + v + ';').test(src)) {
      throw new Error(k + ' 与 smoke 硬编码的 ' + v + ' 不一致（改常量要同步改本 check）');
    }
  });
  return true;
});

// ===== v8.2 岛内末行居中：几何断言同步跑，不 await、不碰共享会话键 =====
check('graph-continent: v8.2 岛内末行按行居中（残行左右对称 / 满行逐字节不变 / 岛宽世界宽不动）', () => {
  const layout = sandbox._continentLayoutClusters;
  if (typeof layout !== 'function') throw new Error('_continentLayoutClusters 未暴露');
  const cl = (sid, n) => ({
    sessionId: sid, title: sid, itemCount: n,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  const PW = 160, GAP = 10, PAD = 18, MINW = 240, MARGIN = 60;
  const wantW = n => Math.max(PAD * 2 + Math.min(3, Math.max(1, n)) * PW + (Math.min(3, Math.max(1, n)) - 1) * GAP, MINW);
  const run = n => {
    const lay = layout([cl('A', n)]);
    return { lay, rect: lay.clusterRects[0] };
  };

  // 岛宽仍按**满列**算：末行居中只动卡的位置，块宽一个像素都不许变
  // （块宽一变 → 世界尺寸变 → zoom 变 → 跌过 0.55 会把卡整档隐藏，见 v8.1 教训）
  for (const n of [1, 2, 3, 4, 5, 7, 9]) {
    const { rect } = run(n);
    if (rect.w !== wantW(n)) throw new Error(n + ' 卡岛宽被改了：' + rect.w + ' ≠ ' + wantW(n));
  }
  // 满行岛（1/2/3/6/9 张）逐字节不变：首卡仍按满列网格居中
  for (const n of [1, 2, 3, 6, 9]) {
    const { lay, rect } = run(n);
    const cols = Math.min(3, n);
    const expect = rect.x + (rect.w - (cols * PW + (cols - 1) * GAP)) / 2;
    if (Math.abs(lay.placements['A_0'].x - expect) > 1e-9) throw new Error(n + ' 卡满行岛首卡位移了');
  }
  // 3 卡岛另钉一条：块宽=网格宽+2×PAD 时首卡恰在 x+PAD（v5.2 老口径，满行仍成立）
  {
    const { lay, rect } = run(3);
    if (rect.w !== PAD * 2 + 3 * PW + 2 * GAP) throw new Error('3 卡岛宽不再是 536');
    if (Math.abs(lay.placements['A_0'].x - (rect.x + PAD)) > 1e-9) {
      throw new Error('3 卡岛首卡不再落在 x+PAD');
    }
  }
  // 残行左右对称：5 卡岛第 2 行只有 2 张，旧公式左对齐会右侧空 206px
  {
    const { lay, rect } = run(5);
    const a = lay.placements['A_3'], b = lay.placements['A_4'];
    const left = a.x - rect.x;
    const right = rect.x + rect.w - (b.x + b.w);
    if (Math.abs(left - right) > 1e-9) throw new Error('5 卡岛末行没居中：左 ' + left + ' 右 ' + right);
    if (Math.abs(left - 103) > 1e-9) throw new Error('5 卡岛末行位移应为 103，实际 ' + left);
  }
  // 4 卡 / 7 卡岛：末行 1 张，应正居中
  for (const n of [4, 7]) {
    const { lay, rect } = run(n);
    const last = lay.placements['A_' + (n - 1)];
    const left = last.x - rect.x;
    const right = rect.x + rect.w - (last.x + last.w);
    if (Math.abs(left - right) > 1e-9) throw new Error(n + ' 卡岛末行没居中');
    if (Math.abs(left - 188) > 1e-9) throw new Error(n + ' 卡岛末行位移应为 188，实际 ' + left);
  }
  // 每行内部仍是等距的 3 列（居中不许把行内卡距也改了）
  {
    const { lay } = run(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        const d = lay.placements['A_' + (r * 3 + c + 1)].x - lay.placements['A_' + (r * 3 + c)].x;
        if (d !== PW + GAP) throw new Error('行内卡距被改了：' + d);
      }
    }
  }
  // 卡仍完整在岛内、且互不重叠（末行右移后不能顶出岛右沿）
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    const { lay, rect } = run(n);
    for (let j = 0; j < n; j++) {
      const p = lay.placements['A_' + j];
      if (p.x < rect.x - 1e-9 || p.x + p.w > rect.x + rect.w + 1e-9
          || p.y < rect.y - 1e-9 || p.y + p.h > rect.y + rect.h + 1e-9) {
        throw new Error(n + ' 卡岛的第 ' + j + ' 张卡越出岛');
      }
      if (j > 0) {
        const q = lay.placements['A_' + (j - 1)];
        const ov = p.x < q.x + q.w - 1e-9 && p.x + p.w > q.x + 1e-9
          && p.y < q.y + q.h - 1e-9 && p.y + p.h > q.y + 1e-9;
        if (ov) throw new Error(n + ' 卡岛第 ' + (j - 1) + '/' + j + ' 张卡重叠');
      }
    }
  }
  // 世界尺寸不受影响
  {
    const { lay } = run(5);
    if (lay.worldW !== Math.max(400, wantW(5) + MARGIN * 2)) {
      throw new Error('世界宽被末行居中影响了：' + lay.worldW);
    }
  }
  return true;
});

// ===== v8.3 岛间距按亲缘强度分级：几何断言同步跑，不 await、不碰共享会话键 =====
// 这条改的是布局核心，红线有两条：
//   ① **总宽守恒** —— 有亲缘时 worldW/worldH 必须与定值 150 布局**逐字节相等**。
//      世界一大 → 适配 zoom 变小 → 跌过 0.55 → 世界档把卡整档 display:none
//      → 真机旅程当场断（v8.1 踩过，10/10 → 8/10）。
//   ② **无亲缘时逐字节旧行为** —— 现有所有 fixture 都传空 shared/userEdges，
//      它们必须一条都不受影响，否则「0 条现有断言会红」这个前提是假的。
check('graph-continent: v8.3 岛间距按亲缘分级（强亲缘更近 / 总宽守恒 / 无亲缘逐字节旧行为）', () => {
  const layout = sandbox._continentLayoutClusters;
  const order = sandbox._continentClusterOrder;
  const kinOf = sandbox._continentKinship;
  const kinGaps = sandbox._continentKinGaps;
  if (typeof layout !== 'function' || typeof kinGaps !== 'function'
      || typeof kinOf !== 'function' || typeof order !== 'function') {
    throw new Error('v8.3 纯函数未暴露（layout / kinGaps / kinship / order）');
  }
  const cl = (sid, n) => ({
    sessionId: sid, title: sid, itemCount: n,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  // 9 座同宽 2 卡岛 → 3 列 3 行，有**两条**列边界才比得出「哪条更近」
  // （4 座岛只有 1 条列边界，拿 gapAB/gapBD 那种比法是自找麻烦，蛇形下 D 在第 0 列）
  const nine = 'ABCDEFGHI'.split('').map(s => cl(s, 2));
  const noShared = [];
  const noEdges = [];
  // 「A↔B 强亲缘（3 条强共享 = 3 分，超过 KIN_FULL=2 直接贴到最紧），其余两两无关」
  // shared 条目的形状照既有亲缘用例：靠 sessions 记跨会话，links 留空
  const strong = (label, ss) => ({ kind: 'title', label, strength: 'strong', sessions: ss, links: [], owners: [] });
  const strongAB = [strong('梯度', ['A', 'B']), strong('散度', ['A', 'B']), strong('旋度', ['A', 'B'])];
  const sids = 'ABCDEFGHI'.split('');
  const kinNo = kinOf(sids, noShared, noEdges);
  const kinYes = kinOf(sids, strongAB, noEdges);

  // ② 无亲缘 / 不传 kin → 逐字节旧行为（现有 fixture 全走这条路，必须一条都不受影响）
  const base = layout(order(nine, noShared, noEdges), null, 9, kinNo);
  if (JSON.stringify(layout(order(nine, noShared, noEdges), null, 9, kinYes ? kinOf(sids, noShared, noEdges) : kinNo)) !== JSON.stringify(base)) {
    throw new Error('无亲缘时不是逐字节旧行为');
  }
  if (JSON.stringify(layout(order(nine, noShared, noEdges), null, 9)) !== JSON.stringify(base)) {
    throw new Error('不传 kin 时不是逐字节旧行为');
  }

  // ① 有亲缘 → 世界尺寸必须一字不变
  const graded = layout(order(nine, strongAB, noEdges), null, 9, kinYes);
  if (graded.worldW !== base.worldW || graded.worldH !== base.worldH) {
    throw new Error('分级间距把世界撑大了：' + base.worldW + 'x' + base.worldH
      + ' → ' + graded.worldW + 'x' + graded.worldH);
  }

  // 间距分级本身：同宽岛排进等宽列，列间距 = 相邻两列 x 之差减一个岛宽
  const w = graded.clusterRects[0].w;
  if (!graded.clusterRects.every(r => r.w === w)) throw new Error('fixture 应当同宽');
  const colX = [...new Set(graded.clusterRects.map(r => r.x))].sort((a, b) => a - b);
  if (colX.length !== 3) throw new Error('应当是 3 列，实得 ' + colX.length);
  const gap0 = colX[1] - (colX[0] + w);   // A|B 强亲缘那条边界
  const gap1 = colX[2] - (colX[1] + w);   // B|C 无关那条边界
  if (!(gap0 < gap1)) throw new Error('强亲缘的列间距没有更近：' + gap0 + ' vs ' + gap1);
  if (gap0 < 100 - 1e-9 || gap1 > 200 + 1e-9) throw new Error('间距越界：' + gap0 + ' / ' + gap1);
  if (Math.abs((gap0 + gap1) / 2 - 150) > 1e-9) throw new Error('两段列间距均值没守恒');

  // 岛不重叠（间距下限 110 > 2×抖动 56）
  for (let i = 0; i < graded.clusterRects.length; i++) {
    for (let j = i + 1; j < graded.clusterRects.length; j++) {
      const a = graded.clusterRects[i], b = graded.clusterRects[j];
      const ov = a.x < b.x + b.w - 1e-9 && a.x + a.w > b.x + 1e-9
        && a.y < b.y + b.h - 1e-9 && a.y + a.h > b.y + 1e-9;
      if (ov) throw new Error('分级间距后两岛重叠：' + a.sessionId + ' × ' + b.sessionId);
    }
  }
  // 世界罩得住所有岛
  for (const r of graded.clusterRects) {
    if (r.x < 0 || r.y < 0 || r.x + r.w > graded.worldW || r.y + r.h > graded.worldH) {
      throw new Error('分级间距后有岛出界：' + r.sessionId);
    }
  }
  // 确定性：同输入两次逐字节一致
  if (JSON.stringify(layout(order(nine, strongAB, noEdges), null, 9, kinYes)) !== JSON.stringify(graded)) {
    throw new Error('分级间距不确定');
  }

  // 纯函数单测：均值守恒 / 单列返回 null / 钳位
  if (kinGaps([['A']], kinYes, 150) !== null) throw new Error('单列应返回 null');
  if (kinGaps([['A'], ['B']], null, 150) !== null) throw new Error('无 kin 应返回 null');
  {
    // 三组边界，亲缘只有中间那条强 → 间距均值必须恰回 150
    const g = kinGaps([['A'], ['B'], ['C'], ['D']], kinYes, 150);
    if (g.length !== 3) throw new Error('间距数组长度错：' + g.length);
    const mean = g.reduce((s, x) => s + x, 0) / g.length;
    if (Math.abs(mean - 150) > 1e-9) throw new Error('间距均值没守恒：' + mean);
    if (!(g[0] < 150 && g[0] >= 100)) throw new Error('强亲缘那条没更近：' + g[0]);
  }
  // 静态：每处 _continentLayoutGrid 调用都必须喂同一份 kin——探针与落位喂不同 kin，
  // 板就按一套尺寸算、岛按另一套摆，岛会捅出板
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const gridCalls = (src.match(/_continentLayoutGrid\([^)]*?\)/g) || [])
    .filter(c => c !== '_continentLayoutGrid(measured, originX, originY, kin)' || true);
  if (gridCalls.length < 3) throw new Error('没找到 _continentLayoutGrid 的调用点');
  const missing = gridCalls.filter(c => !/,\s*kin\s*\)$/.test(c));
  if (missing.length) throw new Error('_continentLayoutGrid 有调用点没传 kin：' + JSON.stringify(missing));
  if (/\.innerW\s*=\s*Math\.max\(0,\s*accX\s*-\s*CONTINENT_CLUSTER_GAP\)/.test(src)) {
    throw new Error('innerW 还在用「accX 减定值 GAP」的旧算法');
  }
  return true;
});

// ===== v8.4 海岸线：每块地自己的 8 值椭圆圆角。同步跑，不 await、不碰共享会话键 =====
// 这层只动 border-radius，布局是原封的——所以这里断言的核心不是几何，是
// 「① 确定性 ② 网格态归零 ③ 令牌化（不许写死 px）④ 真的接进了两块地」。
check('graph-continent: v8.4 海岸线（确定性 / 网格态归零 / 令牌化 / 岛与海域各接一处）', () => {
  const coast = sandbox._continentCoast;
  if (typeof coast !== 'function') throw new Error('_continentCoast 未暴露');
  const store = sandbox.localStorage;
  const STYLE_KEY = 'phymathia_continent_style';
  const prevMode = store.getItem(STYLE_KEY);
  const setMode = v => store.setItem(STYLE_KEY, v);
  const bad = [];
  try {
    setMode('organic');
    const sids = ['ki_9f3', 'ki_2a71', 'ki_44c0', '矢量分析', 'x', '', 'a|b'];
    // ① 确定性：同一 key 永远同一条海岸线（Math.random 会当场被抓出来）
    for (const sid of sids) {
      for (const kind of ['island', 'region']) {
        const a = coast(sid, kind);
        if (a !== coast(sid, kind)) bad.push('不确定：' + sid + '/' + kind);
      }
    }
    // ③ 令牌化：整串只能由 8 个 calc(var(--r-xl) * n) 加一个 ' / ' 组成，裸 px 一律
    // 不许（否则 --r-xl 变了海岸线会漂）。注意**不能按空格切**——calc() 内部有空格。
    const TOK = /calc\(var\(--r-xl\) \* (\d+\.\d{2})\)/g;
    const coefs = s => {
      const out = [];
      let m;
      TOK.lastIndex = 0;
      while ((m = TOK.exec(s)) !== null) out.push(parseFloat(m[1]));
      return out;
    };
    const capOf = kind => (kind === 'region' ? 1.7 : 1.35);
    for (const sid of sids) {
      for (const kind of ['island', 'region']) {
        const v = coast(sid, kind);
        if ((v.match(/ \/ /g) || []).length !== 1) { bad.push('缺 8 值椭圆的斜杠：' + sid); continue; }
        const c = coefs(v);
        if (c.length !== 8) { bad.push('不是 4+4 个角：' + sid + ' → ' + v); continue; }
        if (v.replace(TOK, '').replace(/[\s/]/g, '') !== '') bad.push('串里有不走令牌的东西：' + v);
        const hs = c.slice(0, 4), vs = c.slice(4);
        // 顶角不许超过封顶值：板头文字在 top:8/9、left:22/10，角太大会啃掉第一个字
        for (const t of hs.slice(0, 2)) {
          if (t > capOf(kind) + 1e-9) bad.push('顶角超封顶（会啃板头文字）：' + sid + '/' + kind + ' → ' + t);
        }
        // 竖半径必须真的更小（斜角），否则退回成四个正圆，还是「同一个模子」
        hs.forEach((t, i) => {
          if (vs[i] > t + 1e-9) bad.push('竖半径不小于横半径：' + sid + '/' + kind);
        });
      }
    }
    // ② 参差：13 座岛不该长成一个形状（唯一的审美诉求，必须真的发生）
    const shapes = new Set(sids.map(s => coast(s, 'island')));
    if (shapes.size < sids.length) bad.push('有岛撞了形状（哈希盐失效）：' + shapes.size + '/' + sids.length);
    // ②b 四角必须**互不相关**。这条是踩过的坑：盐写成 'ch0'/'ch1' 这种只差末字符的
    // 编号时，FNV-1a 逐字节左推、末字节差 1 只再乘一轮素数，四角系数实测均差只有
    // 0.01（形状左右对称，等于没抖）；换词盐后是 0.32。顶角区间宽 0.85，两个独立
    // 均匀变量的理论均差 ≈ 0.85/3 = 0.28，所以 0.15 是分开「退化」与「健康」的线。
    let adjGap = 0;
    for (let n = 0; n < 40; n++) {
      const cs = coefs(coast('ki_' + n.toString(16).padStart(4, '0'), 'island'));
      adjGap += Math.abs(cs[0] - cs[1]);
    }
    if (adjGap / 40 < 0.15) {
      bad.push('相邻两角系数几乎相同（哈希盐退化成编号了）：均差 ' + (adjGap / 40).toFixed(3) + ' < 0.15');
    }
    // ④ 网格态归零：返回空串 → setProperty 移除变量 → CSS 回落到 var(--r-xl)，逐像素等于今天
    setMode('grid');
    for (const sid of sids) {
      for (const kind of ['island', 'region']) {
        if (coast(sid, kind) !== '') bad.push('网格态没有归零：' + sid + '/' + kind);
      }
    }
  } finally {
    if (prevMode === null || prevMode === undefined) store.removeItem(STYLE_KEY);
    else store.setItem(STYLE_KEY, prevMode);
  }
  if (bad.length) throw new Error(bad.slice(0, 6).join('\n    ') + '（共 ' + bad.length + ' 处）');

  // 静态契约：CSS 两条规则必须走 --r-coast 回落；渲染层岛与海域各接一处
  const src = fs.readFileSync('src/static/js/graph-continent.js', 'utf8');
  const coastCalls = (src.match(/(?<![A-Za-z0-9_])_continentCoast\((?!\s*key)/g) || []).length;
  if (coastCalls !== 2) throw new Error('_continentCoast 应恰好被调用 2 处（海域板 + 岛牌），实际 ' + coastCalls);
  if (/_continentCoast\(rect\.key, 'region'\)/.test(src) !== true
      || /_continentCoast\(rect\.sessionId, 'island'\)/.test(src) !== true) {
    throw new Error('海岸线没按 regionKey / sessionId 分别接进海域板与岛牌');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  const need = ['var(--r-coast, var(--r-xl))', 'var(--r-coast, var(--r-lg))'];
  for (const sel of ['.continent-cluster {', '.continent-region {']) {
    const i = css.indexOf(sel);
    if (i < 0) throw new Error('找不到规则：' + sel);
    if (!css.slice(i, css.indexOf('}', i)).includes(need[0])) {
      throw new Error(sel + ' 没走 --r-coast（5a 会白做）');
    }
  }
  if (!css.includes(need[1])) throw new Error('收成印章的海域没走 --r-coast');
  return true;
});

// ===== 串行边界追加：发送排队（T42）=====
// 2026-09-27：AI 忙时点发送，过去一律是裸 `if (正在生成) return;`——不提示、不置灰、
// 不留痕。免费模型一次工作流 2-8 分钟，这个忙窗口长得离谱，用户只会以为按钮坏了。
// 现在改成排队：当场收下、跑完自动发。下面分行为与静态契约两半：
// 行为半守住「不丢、不并发」，静态半守住「反馈层不许被悄悄改回去」。

// 行为半。队列模块只依赖 toastMsg / _renderQueueChip 和两个忙碌标志位，隔离得干净，
// 可以在本沙箱里真跑。忙碌位是 app.js 里的顶层 let 词法绑定，外部摸不到，
// 只能经 vm.runInContext 读写（与本文件既有做法一致）。
//
// 这三条共享 isStreaming / _sendQueue 两个词法绑定，而 check() 的异步用例是靠
// Promise.all 一起等跑的——并发会互相踩状态（一条把 isStreaming 置 false 会让另一条
// 提前放行）。所以走自己的串行链，不能用 check()。
const sqEval = (code) => vm.runInContext(code, sandbox);
const sqReset = () => {
  sqEval('_sendQueue = []; _sendQueueFlushing = false;');
  sqEval('isStreaming = false;');
  sqEval('workflowRunActive = false;');
};
const sqChecks = [];
let sqTail = Promise.resolve();
const checkSq = (name, fn) => {
  // 内层 try/catch 保证链条永不 reject，前一条挂掉不会连累后面几条
  sqTail = sqTail.then(async () => {
    try {
      const r = await fn();
      if (r === false) throw new Error('断言未通过');
      console.log('✓', name);
    } catch (e) {
      failed++;
      console.error('❌', name, '->', e.message);
    }
  });
  sqChecks.push(sqTail);
};

checkSq('发送排队：AI 忙时收下但不发出，空闲后自动发出', async () => {
  sqReset();
  sqEval('isStreaming = true;');
  sqEval("__fired = 0;");
  sqEval("_enqueueSend('苏格拉底回答', function(){ __fired++; return Promise.resolve(); })");
  if (!sqEval('_hasPendingSend()')) throw new Error('忙碌时点发送没有收进队列——请求被丢弃了（T42 的原始症状）');
  if (sqEval('__fired') !== 0) throw new Error('收队时就把请求发了出去，会与在途的回答并发');
  // 还在忙：显式 flush 必须什么都不做
  await sqEval('_flushSendQueue()');
  if (sqEval('__fired') !== 0) throw new Error('AI 还在生成，flush 却把队列放了出去');
  sqEval('isStreaming = false;');
  await sqEval('_flushSendQueue()');
  if (sqEval('__fired') !== 1) throw new Error('空闲后没有自动发出，收到 ' + sqEval('__fired'));
  if (sqEval('_hasPendingSend()')) throw new Error('已发出但队列没清空');
});

checkSq('发送排队：两条请求必须依次发出，不能并发挤进同一个发送锁', async () => {
  sqReset();
  // 本沙箱 setTimeout 是 () => 0 的桩，不会真的延后，所以用一道手动闸门来证明
  // 「B 在 A 结束前没跑」——这正是要挡的失败模式：并发发会挤进同一个发送锁。
  sqEval(`
    __log = [];
    _enqueueSend('追问', function(){
      __log.push('A:start');
      return new Promise(function(res){
        __releaseA = function(){ __log.push('A:end'); res(); };
      });
    });
    _enqueueSend('提问', function(){ __log.push('B'); return Promise.resolve(); });
  `);
  sqEval('isStreaming = false;');
  const flushing = sqEval('_flushSendQueue()');
  await new Promise((r) => setImmediate(r));
  const midLog = sqEval("__log.join(',')");
  if (midLog !== 'A:start') throw new Error('第一条没有先发起来，实际：' + midLog);
  if (sqEval("__log.indexOf('B') >= 0")) {
    throw new Error('B 在 A 还没结束时就发了——两条会撞进同一个发送锁（' + midLog + '）');
  }
  sqEval('__releaseA()');
  await flushing;
  if (sqEval("__log.join(',')") !== 'A:start,A:end,B') {
    throw new Error('A 结束后 B 没有接上去，实际：' + sqEval("__log.join(',')"));
  }
});

checkSq('发送排队：workflowRunActive 也算忙（startQuestionWorkflow 过去查错了标志位）', async () => {
  // 旧守卫只查 isStreaming，而工作流全程不碰 isStreaming（它走 _generateAnalysis →
  // proxyChat，不经过 sendMessage），于是「提问」按钮在工作流跑着时形同虚设，
  // 能并发开出第二个工作流、两棵节点树打架。这条把「工作流也算忙」钉死。
  sqReset();
  sqEval('workflowRunActive = true;');
  sqEval('__wf = 0;');
  sqEval("_enqueueSend('提问', function(){ __wf++; return Promise.resolve(); })");
  if (sqEval('_isSendBusy()') !== true) throw new Error('工作流运行时没有被判为忙');
  await sqEval('_flushSendQueue()');
  if (sqEval('__wf') !== 0) throw new Error('工作流还在跑，flush 却放行了');
  sqEval('workflowRunActive = false;');
  await sqEval('_flushSendQueue()');
  if (sqEval('__wf') !== 1) throw new Error('工作流结束后没有自动发出');
});

// 静态半。这些护栏全删掉也不会让上面任何一条行为断言变红——只能靠读源码钉住。
// 变异验证：把任一发送入口改回裸 `if (isStreaming…) return;`，或把 startQuestionWorkflow
// 的判定改回只查 isStreaming，下面立刻红。
check('发送排队：发送入口不允许再出现裸 isStreaming 守卫（T42 反馈层不许被改回去）', () => {
  // 按函数名抽函数体（花括号配平），**不**整文件扫：chat-branch.js 里
  // deleteGraphMessageByTimestamp 那两处 `if (isStreaming)` 不是发送入口——生成中
  // 删消息的语义是「中止当前生成、事后补删」，本来就有动作也不是静默 return，
  // 整文件扫会误伤。marker 用来自检「确实抽到了完整函数体」，防止配平抽残后漏判。
  const extract = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return null;
    let depth = 0, started = false;
    for (let j = src.indexOf('{', i); j < src.length; j++) {
      if (src[j] === '{') { depth++; started = true; }
      else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j); }
    }
    return null;
  };
  const entries = [
    ['chat.js', 'sendMessage', '_flushSendQueue'],
    ['chat-branch.js', 'submitSocraticAnswer', '_enqueueSend'],
    ['chat-branch.js', 'submitBranchModal', '_enqueueSend'],
    ['chat-branch.js', 'startSocraticHint', '_queueOrRunSocraticExit'],
    ['chat-branch.js', 'startSocraticExplain', '_queueOrRunSocraticExit'],
  ];
  for (const [file, fn, marker] of entries) {
    const src = fs.readFileSync('src/static/js/' + file, 'utf8');
    const body = extract(src, fn);
    if (body === null) throw new Error('找不到函数 ' + fn + '（' + file + '）——断言本身该更新了');
    if (!body.includes(marker)) {
      throw new Error('抽到的 ' + fn + ' 函数体不完整（缺 ' + marker + '），判定会漏——断言本身坏了');
    }
    if (/if \(isStreaming[^)]*\) return;/.test(body)) {
      throw new Error(file + ' 的 ' + fn + ' 又是裸 isStreaming 守卫：忙时会静默吞掉请求，'
        + '用户只会以为按钮坏了（docs/backlog.md T42）');
    }
  }
  // startQuestionWorkflow 必须走统一忙碌判定
  const wf = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  const wfBody = extract(wf, 'startQuestionWorkflow');
  if (wfBody === null) throw new Error('找不到 startQuestionWorkflow');
  if (!wfBody.includes('removeDraftNode')) {
    throw new Error('抽到的 startQuestionWorkflow 函数体不完整，判定会漏——断言本身坏了');
  }
  if (!/_isSendBusy\(\)/.test(wfBody)) {
    throw new Error('startQuestionWorkflow 没用统一的 _isSendBusy()——工作流通道又变回形同虚设');
  }
  if (/if \(typeof isStreaming !== 'undefined' && isStreaming\) return;/.test(wfBody)) {
    throw new Error('startQuestionWorkflow 又只查 isStreaming 了：工作流不碰这个标志位，守卫会失效');
  }
});

check('发送排队：模块已注册进构建顺序，且「待发送 N」标记挂在进度胶囊上', () => {
  const build = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
  if (!/'send-queue\.js'/.test(build)) {
    throw new Error("build_frontend.mjs 的顺序表里没有 'send-queue.js'——页面加载的 app.js 根本不含排队逻辑");
  }
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  const m = html.match(/<button[^>]*id="sendQueueChip"[^>]*>/);
  if (!m) throw new Error('index.html 里没有 id="sendQueueChip" 的元素——用户看不到待发送几条');
  const capsule = html.slice(html.indexOf('id="progressStatus"'), html.indexOf('id="progressStatus"') + 2000);
  if (!capsule.includes('sendQueueChip')) {
    throw new Error('sendQueueChip 没挂在 #progressStatus 胶囊里——用户盯着等的时候看不到它');
  }
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  if (!css.includes('.progress-status .send-queue-chip')) {
    throw new Error('styles.css 里没有 .send-queue-chip 规则——标记会是个没样式的裸按钮');
  }
});

// ===== 串行边界追加：画布多选与批量删除（2026-09-30）=====
// 多选改的是模块级 sessions / currentSessionId 词法绑定，还会 await 一串 fetch、
// 写共享的 phymathia_sessions 与 phymathia_msgs_*/graph_* 键——与在途异步用例互踩，
// 走自己的串行链（同发送排队那套）。
const msEval = (code) => vm.runInContext(code, sandbox);
let msTail = Promise.resolve();
const checkMs = (name, fn) => {
  msTail = msTail.then(async () => {
    try {
      const r = await fn();
      if (r === false) throw new Error('断言未通过');
      console.log('✓', name);
    } catch (e) {
      failed++;
      console.error('❌', name, '->', e.message);
    }
  });
};

// 下游全是函数声明（是 globalThis 的属性，可以整体替换还原），
// 知识/公式面板在宽松 DOM 代理下会走进未覆盖的渲染路径，这里换成记账桩。
const msCalls = [];
function msIsolate() {
  const saved = {};
  const stub = (name, fn) => { saved[name] = sandbox[name]; sandbox[name] = fn; };
  stub('invalidateKnowledgeCache', () => msCalls.push('invalidate'));
  stub('renderKnowledgePanel', () => msCalls.push('renderKp'));
  stub('loadFormulas', () => msCalls.push('loadFormulas'));
  stub('deleteKnowledgeBySession', async (sid) => { msCalls.push('know:' + sid); });
  stub('deleteFormulasBySession', async (sid) => { msCalls.push('formula:' + sid); });
  stub('switchToSession', async (sid) => { msCalls.push('switch:' + sid); });
  stub('createNewSession', () => { msCalls.push('create'); });
  stub('showToast', (msg) => { msCalls.push('toast:' + msg); });
  stub('_deleteOnServer', async () => { msCalls.push('srvDel'); return true; });
  stub('_saveSessionToServer', async (sid) => { msCalls.push('upsert:' + sid); });
  const prevPhi = sandbox.window.phiCanvasDeleted;
  sandbox.window.phiCanvasDeleted = (sid) => { msCalls.push('phi:' + sid); };
  // 元素注册表：宽松代理每次 getElementById 都返回新对象，量不到属性。
  // 只接管多选相关的 5 个 id，其余一律转交原实现——发送排队那条链与本节并发跑，
  // 它要靠真 getElementById 拿到 loose 元素。
  const els = {};
  const prevGet = sandbox.document.getElementById;
  const OWNED = new Set(['sessionList', 'sessionBulkBar', 'sessionBulkCount', 'sessionBulkDeleteBtn', 'sessionMultiSelectBtn']);
  const myGet = (id) => {
    if (!OWNED.has(id)) return prevGet(id);
    if (!els[id]) {
      els[id] = {
        innerHTML: '', hidden: true, textContent: '', disabled: false, className: '',
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
      };
    }
    return els[id];
  };
  sandbox.document.getElementById = myGet;
  return {
    els,
    restore() {
      for (const k of Object.keys(saved)) sandbox[k] = saved[k];
      sandbox.window.phiCanvasDeleted = prevPhi;
      // 只在还是自己的时候还原：并发用例可能已经换上了它们的实现
      if (sandbox.document.getElementById === myGet) sandbox.document.getElementById = prevGet;
      // 交还词法状态：在途的并发用例还在用同一个 sessions 名单
      msEval('sessions = __msPrevSessions; currentSessionId = __msPrevCurrent; _sessionMultiSelect = false; _sessionSelected.clear();');
    },
  };
}

checkMs('画布多选：进入多选 → 勾选 → 批量删除（逐条走单删主路径，名单只写一次）', async () => {
  const iso = msIsolate();
  try {
    // isStreaming 是词法绑定，在途的并发用例会把它置位；会话管理用例与它无关，显式归零
    msEval('__msPrevSessions = sessions; __msPrevCurrent = currentSessionId; isStreaming = false;');
    msEval('sessions = { s1:{id:"s1",title:"甲",updatedAt:9}, s2:{id:"s2",title:"乙",updatedAt:8}, s3:{id:"s3",title:"丙",updatedAt:7}, s4:{id:"s4",title:"丁",updatedAt:6} }; currentSessionId = "s2"; _sessionMultiSelect = false; _sessionSelected.clear();');
    sandbox.toggleSessionMultiSelect();
    if (msEval('_sessionMultiSelect') !== true) throw new Error('没进多选态');
    if (iso.els.sessionBulkBar.hidden !== false) throw new Error('批量操作条没露出来——用户进多选却无处操作');
    if (iso.els.sessionBulkCount.textContent !== '已选 0 / 4') throw new Error('计数不对：' + iso.els.sessionBulkCount.textContent);
    if (!iso.els.sessionList.innerHTML.includes('multi-select-item')) throw new Error('列表没渲染成多选形态（缺复选框行）');

    sandbox.toggleSessionSelect('s1');
    sandbox.toggleSessionSelect('s3');
    if (iso.els.sessionBulkCount.textContent !== '已选 2 / 4') throw new Error('勾选计数没跟上：' + iso.els.sessionBulkCount.textContent);
    if (!iso.els.sessionList.innerHTML.includes('picked')) throw new Error('选中态没画出来');
    // 再次点击同一行＝取消勾选
    sandbox.toggleSessionSelect('s1');
    if (iso.els.sessionBulkCount.textContent !== '已选 1 / 4') throw new Error('取消勾选没生效');
    sandbox.toggleSessionSelect('s1');

    sandbox.selectAllSessions();
    if (iso.els.sessionBulkCount.textContent !== '已选 4 / 4') throw new Error('全选没生效');
    sandbox.clearSessionSelection();
    if (iso.els.sessionBulkCount.textContent !== '已选 0 / 4') throw new Error('清除没生效');
    if (iso.els.sessionBulkDeleteBtn.disabled !== true) throw new Error('没勾选时删除钮应置灰');

    // 逐条清理的证据：被删画布的本地消息/画布键必须真的消失
    for (const id of ['s1', 's3']) {
      sandbox.localStorage.setItem('phymathia_msgs_' + id, '[{"role":"user"}]');
      sandbox.localStorage.setItem('phymathia_graph_' + id, '{"positions":{}}');
    }
    msCalls.length = 0;
    sandbox.toggleSessionSelect('s1');
    sandbox.toggleSessionSelect('s3');
    await sandbox.deleteSelectedSessions();

    if (msEval('Object.keys(sessions).sort().join(",")') !== 's2,s4') {
      throw new Error('批量删完后名单应为 s2,s4，实际 ' + msEval('Object.keys(sessions).join(",")'));
    }
    for (const id of ['s1', 's3']) {
      if (sandbox.localStorage.getItem('phymathia_msgs_' + id) !== null) throw new Error(id + ' 的本地消息没清掉');
      if (sandbox.localStorage.getItem('phymathia_graph_' + id) !== null) throw new Error(id + ' 的本地画布状态没清掉');
    }
    if (!msCalls.includes('know:s1') || !msCalls.includes('formula:s3')) throw new Error('知识/公式清理没逐条走主路径');
    if (msCalls.filter(c => c === 'invalidate').length !== 1) throw new Error('面板刷新应只做一次，实际 ' + msCalls.filter(c => c === 'invalidate').length);
    // saveSessions 收成一次：剩下的两个画布各 upsert 一次（逐条调用会是 3 次）
    if (msCalls.filter(c => c.startsWith('upsert:')).length !== 2) {
      throw new Error('名单应只整体写一次，实际 upsert ' + msCalls.filter(c => c.startsWith('upsert:')).length + ' 次');
    }
    if (!msCalls.some(c => c.startsWith('toast:已删除 2 个画布'))) throw new Error('没有完成提示：' + msCalls.filter(c => c.startsWith('toast:')));
    // 没选当前画布就不该切换
    if (msCalls.some(c => c.startsWith('switch:'))) throw new Error('没删当前画布却切了会话');
    if (msEval('_sessionMultiSelect') !== false) throw new Error('全删成功应自动退出多选态');
  } finally {
    iso.restore();
  }
});

checkMs('画布多选：选中里含当前画布 → 删完自动落到最近的一个', async () => {
  const iso = msIsolate();
  try {
    // isStreaming 是词法绑定，在途的并发用例会把它置位；会话管理用例与它无关，显式归零
    msEval('__msPrevSessions = sessions; __msPrevCurrent = currentSessionId; isStreaming = false;');
    msEval('sessions = { s1:{id:"s1",title:"甲",updatedAt:9}, s2:{id:"s2",title:"乙",updatedAt:8}, s3:{id:"s3",title:"丙",updatedAt:7} }; currentSessionId = "s2"; _sessionMultiSelect = true; _sessionSelected.clear();');
    msCalls.length = 0;
    sandbox.toggleSessionSelect('s2');
    sandbox.toggleSessionSelect('s3');
    await sandbox.deleteSelectedSessions();
    if (msCalls.filter(c => c.startsWith('switch:')).length !== 1) throw new Error('删掉当前画布后应只切一次会话');
    if (msCalls.includes('switch:s2')) throw new Error('切向了已被删掉的画布');
    if (msCalls.filter(c => c.startsWith('srvDel')).length !== 2) throw new Error('服务端删除应逐条发一次，实际 ' + msCalls.filter(c => c.startsWith('srvDel')).length);
  } finally {
    iso.restore();
  }
});

checkMs('画布多选：服务端删失败的画布保留勾选并可重试，不误报全清', async () => {
  const iso = msIsolate();
  try {
    // isStreaming 是词法绑定，在途的并发用例会把它置位；会话管理用例与它无关，显式归零
    msEval('__msPrevSessions = sessions; __msPrevCurrent = currentSessionId; isStreaming = false;');
    msEval('sessions = { s1:{id:"s1",title:"甲",updatedAt:9}, s2:{id:"s2",title:"乙",updatedAt:8} }; currentSessionId = "s1"; _sessionMultiSelect = true; _sessionSelected.clear();');
    // 服务端在线，但只有 s1 的 DELETE 失败（混合结局：一条成一条败）
    sandbox._deleteOnServer = async (url) => !String(url).includes('s1');
    msEval('_serverAvailable = true; _serverAvailableCheckedAt = Date.now();');
    msCalls.length = 0;
    sandbox.toggleSessionSelect('s1');
    sandbox.toggleSessionSelect('s2');
    await sandbox.deleteSelectedSessions();
    if (msEval('Object.keys(sessions).join(",")') !== 's1') throw new Error('只有 s2 该被删，实际剩 ' + msEval('Object.keys(sessions).join(",")'));
    if (msEval('Array.from(_sessionSelected).join(",")') !== 's1') throw new Error('失败的画布应保留勾选供重试');
    if (msEval('_sessionMultiSelect') !== true) throw new Error('有失败项时不该退出多选态');
    if (!msCalls.some(c => c.includes('已删除 1 个，1 个失败'))) throw new Error('没有提示部分失败：' + msCalls.filter(c => c.startsWith('toast:')));
  } finally {
    msEval('_serverAvailable = null; _serverAvailableCheckedAt = 0;');
    iso.restore();
  }
});

// 静态契约：入口、样式、单删/批删同源，防「多选另起一套删除口径」回退
check('画布多选：入口与样式在位，且单删/批删共用同一条删除内核', () => {
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="sessionMultiSelectBtn"') || !html.includes('toggleSessionMultiSelect()')) {
    throw new Error('侧栏没有多选开关——用户找不到入口');
  }
  for (const id of ['sessionBulkBar', 'sessionBulkCount', 'sessionBulkDeleteBtn']) {
    if (!html.includes(`id="${id}"`)) throw new Error(`index.html 缺批量操作条元素 #${id}`);
  }
  const css = fs.readFileSync('src/static/css/styles.css', 'utf8');
  for (const sel of ['.session-bulk-bar', '.session-item.multi-select-item .session-check', '.sidebar-multiselect-btn']) {
    if (!css.includes(sel)) throw new Error(`styles.css 缺 ${sel} 规则——控件会没样式`);
  }
  if (!css.includes('.session-bulk-bar[hidden]')) {
    throw new Error('批量条没写 [hidden] 兜底——display:flex 会盖掉 hidden 属性，退出多选后仍常驻');
  }
  const src = fs.readFileSync('src/static/js/session.js', 'utf8');
  if (!src.includes('async function _purgeSessionData(id)')) throw new Error('删除内核不存在');
  if (!src.includes('const r = await _purgeSessionData(id);')) throw new Error('单删/批删没有共用同一条删除内核（两条路径会分叉）');
  return true;
});

// 静态契约（T128）：皮肤模板机制四件套——注册表/存储键/入口/属性挂钩，防「机制在、入口丢」回退
check('节点皮肤模板（T128）：注册表、存储键、页头入口、CSS 皮肤节与启动预置全接线', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  if (!ui.includes('const GRAPH_NODE_SKINS') || !ui.includes("{ key: 'aurora'")) {
    throw new Error('ui.js 缺皮肤注册表 GRAPH_NODE_SKINS / aurora 默认模板');
  }
  for (const fn of ['function currentNodeSkin()', 'function applyNodeSkin(', 'function toggleSkinPanel(', 'function renderSkinPanel()']) {
    if (!ui.includes(fn)) throw new Error(`ui.js 缺 ${fn}`);
  }
  if (!ui.includes("removeAttribute('data-node-skin')")) {
    throw new Error('默认模板必须摘掉 data-node-skin 属性（基础规则即默认皮肤），否则切回默认不生效');
  }
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("STORAGE_KEY_NODE_SKIN = 'phymathia_node_skin'")) throw new Error('config.js 缺皮肤存储键');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="skinBtn"') || !html.includes('toggleSkinPanel(event)')) throw new Error('页头缺皮肤按钮入口');
  if (!html.includes('id="skinPanel"')) throw new Error('index.html 缺 #skinPanel 面板容器');
  if (!html.includes("localStorage.getItem('phymathia_node_skin')")) throw new Error('启动内联脚本没预置皮肤（首屏会闪默认模板）');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  if (!css.includes('节点皮肤模板')) throw new Error('graph-override.css 缺「节点皮肤模板」节——新模板没有落点');
  return true;
});

// 静态契约（T128 续）：注册表与 CSS 覆盖块必须一一对齐——面板能选出来的皮肤，CSS 里就得真有料
check('节点皮肤模板：注册表每个非默认 key 在 CSS 都有对应 [data-node-skin] 覆盖块', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SKINS');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]);
  if (!keys.includes('aurora')) throw new Error('注册表解析异常：没找到默认模板 aurora');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const missing = keys.filter(k => k !== 'aurora' && !css.includes(`[data-node-skin="${k}"] .graph-node`));
  if (missing.length) throw new Error('皮肤注册表与 CSS 覆盖块不同步，缺：' + missing.join(', '));
  return true;
});

// 静态契约（T128 续）：模块粗边节点必须被每个皮肤整组覆盖——主题 [data-theme] .graph-node-module.graph-module-*
// 是 (0,3,0)，module 覆盖块不重写 background/box-shadow 就整卡锁在默认皮（2026-10-01 用户真机实锤）
check('节点皮肤模板：module 覆盖块重写背景与投影，并带 :hover/.selected 属性色变体', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SKINS');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]).filter(k => k !== 'aurora');
  if (!keys.length) throw new Error('注册表解析异常：非默认模板一个都没取到');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  for (const k of keys) {
    const sel = `[data-node-skin="${k}"] .graph-node.graph-node-module {`;
    const i = css.indexOf(sel);
    if (i < 0) throw new Error(`${k}：缺 module 覆盖块`);
    const body = css.slice(i, css.indexOf('}', i));
    if (!body.includes('background:') || !body.includes('box-shadow:'))
      throw new Error(`${k}：module 块没重写背景/投影，模块卡面会被主题 (0,3,0) 规则锁回默认皮`);
    for (const variant of [':hover', '.selected']) {
      if (!css.includes(`[data-node-skin="${k}"] .graph-node.graph-node-module${variant}`))
        throw new Error(`${k}：缺 module${variant} 变体（模块悬停/选中会丢属性色环）`);
    }
    if (!css.includes(`[data-node-skin="${k}"] .graph-node textarea`))
      throw new Error(`${k}：卡内编辑控件（textarea/input）没跟皮肤（固定深底盲区）`);
  }
  return true;
});

// 静态契约（T129 重做）：节点形态开关接线——注册表/存储键/页头入口/CSS 圆卡覆盖块/弧线排布/等比缩放
check('节点形态开关（orbit）：注册表、入口、CSS 圆卡覆盖块、弧线排布、等比缩放互相对齐', () => {
  const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const start = ui.indexOf('const GRAPH_NODE_SHAPES');
  if (start < 0) throw new Error('ui.js 缺 GRAPH_NODE_SHAPES 注册表');
  const registry = ui.slice(start, ui.indexOf('];', start));
  const keys = [...registry.matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]);
  if (!keys.includes('card')) throw new Error('形态注册表解析异常：没找到默认形态 card');
  if (ui.includes('_applyOrbitLayoutToExisting') || ui.includes('_orbitSavedPositions'))
    throw new Error('ui.js 残留切形态重排逻辑（重做后切形态不重排既有节点）');
  const cfg = fs.readFileSync('src/static/js/config.js', 'utf8');
  if (!cfg.includes("STORAGE_KEY_NODE_SHAPE = 'phymathia_node_shape'")) throw new Error('config.js 缺形态存储键');
  const html = fs.readFileSync('src/static/index.html', 'utf8');
  if (!html.includes('id="shapeBtn"') || !html.includes('toggleShapePanel(event)')) throw new Error('页头缺形态按钮入口');
  if (!html.includes('id="shapePanel"')) throw new Error('index.html 缺 #shapePanel 面板容器');
  if (!html.includes("localStorage.getItem('phymathia_node_shape')")) throw new Error('启动内联脚本没预置节点形态');
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const missing = keys.filter(k => k !== 'card' && !css.includes(`[data-node-shape="${k}"] .graph-node`));
  if (missing.length) throw new Error('形态注册表与 CSS 覆盖块不同步，缺：' + missing.join(', '));
  const orbitBlock = css.slice(css.indexOf('[data-node-shape="orbit"]'));
  if (!orbitBlock.includes('aspect-ratio') || !orbitBlock.includes('border-radius: 50%'))
    throw new Error('orbit 覆盖块没写成圆形卡片（缺 aspect-ratio / border-radius: 50%）');
  const wf = fs.readFileSync('src/static/js/graph-workflow.js', 'utf8');
  if (!wf.includes('function _orbitArcLayout')) throw new Error('graph-workflow.js 缺弧线排布 _orbitArcLayout');
  if (!wf.includes("currentNodeShape() === 'orbit'")) throw new Error('工作流模块落点没接轨道分支');
  const render = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (render.includes('toggleOrbitBadge') || render.includes('graph-orbit-badge') || render.includes('_orbitOpen'))
    throw new Error('graph-render.js 残留徽章机制（重做后 orbit＝圆形卡片，无双击展开徽章）');
  const interact = fs.readFileSync('src/static/js/graph-interact.js', 'utf8');
  if (!interact.includes("currentNodeShape() === 'orbit'")) throw new Error('缩放分支没接 orbit 等比缩放（正圆保持）');
  return true;
});

// 发送排队的行为用例走自己的串行链（共享词法绑定，并发会互踩），先跑完再等其余的
await msTail;
await Promise.all(sqChecks).catch(() => {});

await Promise.all(pendingChecks).catch(() => {});

await Promise.all(pendingChecks).catch(() => {});

console.log(failed ? '\n冒烟失败' : '\n前端冒烟全部通过');
process.exit(failed ? 1 : 0);
