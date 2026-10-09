// 节点配方 P0–P3（开头两条：harness 快照基建回归＋配方注册表）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 122–688 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
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

check('使用引导覆盖创造模式与自定义节点入口', () => {
  const harnessSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const m = harnessSrc.match(/const HARNESS_GUIDE_TEXT = \[([\s\S]*?)\]\.join/);
  if (!m) throw new Error('HARNESS_GUIDE_TEXT 未找到');
  for (const needle of ['三种模式', '自定义节点', '放一个到画布上试试', '我的配方', '存为配方', '删配方不影响']) {
    if (!m[1].includes(needle)) throw new Error('引导缺少「' + needle + '」');
  }
  return true;
});

check('使用引导覆盖答疑先查再答与配方放置（2026-10-03 智能化第二期）', () => {
  const harnessSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  const m = harnessSrc.match(/const HARNESS_GUIDE_TEXT = \[([\s\S]*?)\]\.join/);
  if (!m) throw new Error('HARNESS_GUIDE_TEXT 未找到');
  for (const needle of ['先查再答', '知识库和公式速查', '编辑模式也能直接放置']) {
    if (!m[1].includes(needle)) throw new Error('引导缺少「' + needle + '」');
  }
  return true;
});

check('首次使用引导覆盖版本新功能（2026-10-07：大陆/检测/多账号/回收站/导出/Φ）', () => {
  const uiSrc = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const m = uiSrc.match(/const _obSteps = \[([\s\S]*?)\n\];/);
  if (!m) throw new Error('_obSteps 未找到');
  for (const needle of ['知识大陆', '知识检测', '多账号', '回收站', '导出', 'Φ 智能体', '只读查阅', '先查知识库']) {
    if (!m[1].includes(needle)) throw new Error('引导缺少「' + needle + '」');
  }
  return true;
});

check('T117 澄清失配不清待决状态（确认命中才置空）', () => {
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  const m = runSrc.match(/function confirmHarnessClarifyInput\(\) \{([\s\S]*?)\n  \}/);
  if (!m) throw new Error('confirmHarnessClarifyInput 未找到');
  const body = m[1];
  const clearIdx = body.indexOf('harnessPendingClarify = null');
  const branchIdx = body.indexOf('if (node) {');
  if (clearIdx < 0) throw new Error('函数体缺 harnessPendingClarify 置空（语义异常）');
  if (branchIdx < 0 || clearIdx < branchIdx) {
    throw new Error('失配会提前清掉 harnessPendingClarify：置空必须发生在 if (node) 命中分支内（T117）');
  }
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

// ===== 2026-10-09 创造模式修复批次（T242/T243/T244＋微调入口）=====
// 本组全部同步（无 await），不占串行边界段。

check('快照配方清单按最近修改倒序注入（T244：32 条上限下的视野优先）', () => {
  // 静态：注入点必须是 updatedAt 倒序的副本（不改 getUserRecipes 本身）
  const harnessSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
  if (!/getUserRecipes\(\)\.slice\(\)\.sort\(\(a, b\) => \(b\.updatedAt \|\| 0\) - \(a\.updatedAt \|\| 0\)\)/.test(harnessSrc)) {
    throw new Error('清单注入未按 updatedAt 倒序（T244 回归）');
  }
  // 行为：库里 [旧, 新] → 快照里 [新, 旧]（最近动过的优先进 Φ 视野）
  const prevRecipes = sandbox.window.getUserRecipes();
  const prevGet = sandbox.window.getGraphState, prevSid = sandbox.window.getCurrentSessionId;
  const prevById = sandbox.window.getSessionById, prevView = sandbox.window.getGraphViewNodes;
  const prevEdges = sandbox.window.getGraphViewEdges, prevSel = sandbox.window.getSelectedGraphNodeIds;
  try {
    sandbox.window.setUserRecipes([
      { ..._smokeValidRecipe(), id: 'r-old', name: '旧配方', updatedAt: 1000 },
      { ..._smokeValidRecipe(), id: 'r-new', name: '新配方', updatedAt: 9000 },
    ]);
    sandbox.window.getGraphState = () => ({ harnessDeleted: {} });
    sandbox.window.getCurrentSessionId = () => 'sess_test';
    sandbox.window.getSessionById = (id) => ({ id, title: '画布' + id });
    vm.runInContext('phiSessions = { phi_t: { id: "phi_t", title: "t", boundSid: "sess_test", createdAt: 1, updatedAt: 1 } }; currentPhiId = "phi_t";', sandbox);
    sandbox.window.getGraphViewNodes = () => [];
    sandbox.window.getGraphViewEdges = () => [];
    sandbox.window.getSelectedGraphNodeIds = () => [];
    const snap = sandbox.buildHarnessSnapshot(false, [], null);
    const ids = (snap.user_recipes || []).map(r => r.id);
    if (ids[0] !== 'r-new' || ids[1] !== 'r-old') {
      throw new Error('快照清单应按 updatedAt 倒序（新的在前），实际 ' + JSON.stringify(ids));
    }
    return true;
  } finally {
    sandbox.window.setUserRecipes(prevRecipes || []);
    sandbox.window.getGraphState = prevGet;
    sandbox.window.getCurrentSessionId = prevSid;
    sandbox.window.getSessionById = prevById;
    sandbox.window.getGraphViewNodes = prevView;
    sandbox.window.getGraphViewEdges = prevEdges;
    sandbox.window.getSelectedGraphNodeIds = prevSel;
  }
});

check('update_recipe 预览行字段差异（T242）：被抹掉的字段带着 ⚠️ 显示', () => {
  // _recipeFieldDiff 是 harness-run.js 顶层函数声明：vm 全局，不经 window
  const diff = sandbox._recipeFieldDiff;
  if (typeof diff !== 'function') throw new Error('_recipeFieldDiff 未挂 vm 全局（harness-run.js）');
  const old = {
    name: '三级追问', desc: 'd', base: { kind: 'module' },
    appearance: { palette: 'amber', shape: 'is-round' },
    generate: { prompt: '输出三级追问', followup_prompt: '', confused_prompt: '', retry_prompt: '', strict_output: '' },
    ports: {
      static: [{ label: '追问', drag_form: 'draft' }, { label: '再测一道', drag_form: 'user' }],
      dynamic: { parser: { level_tags: ['基础', '进阶', '拓展'], pattern: 'numbered_list', max: 12, label_from: 'index_question' } },
    },
    content_kind: 'markdown',
  };
  // 模型「重填整表」时丢了 dynamic、清空了主提示词、少带一个静态出口
  const bare = {
    name: '三级追问', desc: 'd', base: { kind: 'module' },
    appearance: { palette: 'amber', shape: 'is-round' },
    generate: { prompt: '', followup_prompt: '', confused_prompt: '', retry_prompt: '', strict_output: '' },
    ports: { static: [{ label: '追问', drag_form: 'draft' }] },
    content_kind: 'markdown',
  };
  const text = diff(old, bare);
  if (!text.includes('动态解析出口')) throw new Error('整份丢掉 dynamic 未报出：' + text);
  if (!text.includes('主提示词')) throw new Error('主提示词被清空未报出：' + text);
  if (!text.includes('⚠️')) throw new Error('被抹掉的字段要带 ⚠️ 前缀：' + text);
  if (!text.includes('出口 2 → 1 个') || !text.includes('再测一道')) throw new Error('出口减少未报出：' + text);
  // 改名可见（T80 模型静默改名）
  const renamed = { ...bare, name: '三级追问·升级', generate: { prompt: '输出三级追问' } };
  const renText = diff(old, renamed);
  if (!renText.includes('名字「三级追问」→「三级追问·升级」')) throw new Error('改名未显示前后对照：' + renText);
  // 无差异回空串（不刷噪音）
  if (diff(old, old) !== '') throw new Error('无变化应返回空串');
  return true;
});

check('配方操作预览附着（T242/T243）：差异随操作存盘、delete 回查配方名', () => {
  const attach = sandbox._attachRecipeOpPreviews;
  if (typeof attach !== 'function') throw new Error('_attachRecipeOpPreviews 未挂 vm 全局');
  const prevRecipes = sandbox.window.getUserRecipes();
  try {
    sandbox.window.setUserRecipes([
      { ..._smokeValidRecipe(), id: 'r-1', name: '错题复盘', updatedAt: 5000,
        ports: { static: [{ label: '追问', drag_form: 'draft' }],
          dynamic: { parser: { level_tags: ['基础', '进阶', '拓展'], pattern: 'numbered_list', max: 12, label_from: 'index_question' } } } },
    ]);
    const ops = [
      { op: 'update_recipe', recipe_id: 'r-1', reason: '把三档标签改一下',
        recipe: { name: '错题复盘', base: { kind: 'module' }, appearance: { palette: 'amber', shape: 'is-round' },
          generate: { prompt: 'x' }, ports: { static: [{ label: '追问', drag_form: 'draft' }] }, content_kind: 'markdown' } },
      { op: 'delete_recipe', recipe_id: 'r-1', reason: '删' },
    ];
    const out = attach(ops);
    if (!out[0].preview_diff || !out[0].preview_diff.includes('动态解析出口')) {
      throw new Error('update 未附着字段差异：' + (out[0].preview_diff || ''));
    }
    if (out[1].recipe_name !== '错题复盘') throw new Error('delete 未回查到配方名：' + out[1].recipe_name);
    // 回新数组、不搅动原 ops（应用路径读原 ops）
    if (out === ops || ops[0].preview_diff) throw new Error('attach 应回新数组、不改原 ops');
    return true;
  } finally {
    sandbox.window.setUserRecipes(prevRecipes || []);
  }
});

check('已落库配方行挂「微调/放上画布」入口（T242 配套）：DOM 契约＋落地判据', () => {
  const previewSrc = fs.readFileSync('src/static/js/harness-preview.js', 'utf8');
  if (!previewSrc.includes('_harnessRecipeActionsHtml')) throw new Error('配方行动作渲染函数缺失');
  for (const needle of ['openRecipeFormById(', 'createRecipeNode(', 'graph-harness-op-recipe-actions']) {
    if (!previewSrc.includes(needle)) throw new Error('配方行入口缺 ' + needle);
  }
  // 只挂已落库的行：保留修改（decision=keep）或应用全部后（harnessResultApplied）——
  // 待处理批次不挂（配方还不存在/改的还是旧版，入口会和应用动作打架）
  if (!/entry\.decision === 'keep' \|\| \(isCurrent && harnessResultApplied\)/.test(previewSrc)) {
    throw new Error('配方行入口的落地判据不对');
  }
  // 入口只在配方确在库里时渲染
  if (!/getUserRecipes\(\)\.some\(item => item\.id === rid\)/.test(previewSrc)) throw new Error('入口缺库里存在判据');
  // CSS：令牌复用，零新色值零新字号
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  for (const sel of ['.graph-harness-op-recipe-actions {', '.graph-harness-op-recipe-btn {']) {
    if (!css.includes(sel)) throw new Error('缺样式 ' + sel);
  }
  if (/\.graph-harness-op-recipe-btn \{[^}]*#[0-9a-fA-F]{3}/.test(css)) throw new Error('按钮样式不许出现 hex 字面量（T8 红线）');
  return true;
});
// ===== 2026-10-09 创造模式修复批次用例结束 =====
}
