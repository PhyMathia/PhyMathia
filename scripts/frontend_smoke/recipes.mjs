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
  // 形状不是配方参数（2026-10-09 用户拍板）：输入里的 shape 一律忽略，按底座推导——
  // 此前 Φ 能写、却只在「添加节点」面板圆点生效，节点卡不生效（设了不生效）。
  if (normalize({ ..._smokeValidRecipe(), appearance: { palette: 'amber', shape: 'is-diamond' } }).appearance.shape !== 'is-round') {
    throw new Error('模块底座形状应按底座推导 is-round，输入 shape 不得生效');
  }
  if (normalize({ ..._smokeValidRecipe(), base: { kind: 'note' }, appearance: { palette: 'amber', shape: 'is-ring' } }).appearance.shape !== 'is-square') {
    throw new Error('手填底座形状应按底座推导 is-square，输入 shape 不得生效');
  }
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
  // 双阶段概要与 on_generated 钩子的接线（这些分支要真模型才走到，行为留真机验收）。
  // T261 拆分后接线散在工作流族内（主件生成段+recipe 件+prompt 件），按族拼接断言
  const wfSrc = ['graph-workflow.js', 'graph-workflow-prompt.js', 'graph-workflow-recipe.js',
    'graph-workflow-template.js', 'graph-workflow-progress.js']
    .map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');
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
  const harnessSrc = ['harness.js', 'harness-sessions.js', 'harness-snapshot.js']
    .map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');
  if (!harnessSrc.includes('graphHarnessModeBtn')) throw new Error('模式按钮未进面板');
  if (!harnessSrc.includes('window._harnessMode')) throw new Error('模式状态未暴露给发送链');
  if (!harnessSrc.includes('snapshot.user_recipes')) throw new Error('配方清单未随快照注入（结构化通道）');
  const runSrc = fs.readFileSync('src/static/js/harness-run.js', 'utf8');
  if (!/const requestMode = _harnessResolveRequestMode\(opts\);/.test(runSrc)) throw new Error('发送起点未锁定请求模式');
  if (!/if \(requestMode !== 'edit' && phase !== 'apply'\) phase = requestMode;/.test(runSrc)) {
    throw new Error('发送链未按锁定模式改写相位（apply 例外需保留）');
  }
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
  const harnessSrc = ['harness.js', 'harness-sessions.js', 'harness-snapshot.js']
    .map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');
  const m = harnessSrc.match(/const HARNESS_GUIDE_TEXT = \[([\s\S]*?)\]\.join/);
  if (!m) throw new Error('HARNESS_GUIDE_TEXT 未找到');
  for (const needle of ['三种模式', '自定义节点', '放一个到画布上试试', '我的配方', '存为配方', '删配方不影响']) {
    if (!m[1].includes(needle)) throw new Error('引导缺少「' + needle + '」');
  }
  return true;
});

check('使用引导覆盖答疑先查再答与配方放置（2026-10-03 智能化第二期）', () => {
  const harnessSrc = ['harness.js', 'harness-sessions.js', 'harness-snapshot.js']
    .map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');
  const m = harnessSrc.match(/const HARNESS_GUIDE_TEXT = \[([\s\S]*?)\]\.join/);
  if (!m) throw new Error('HARNESS_GUIDE_TEXT 未找到');
  for (const needle of ['先查再答', '知识库和公式速查', '编辑模式也能直接放置']) {
    if (!m[1].includes(needle)) throw new Error('引导缺少「' + needle + '」');
  }
  return true;
});

check('首次使用引导覆盖版本新功能（2026-10-07：大陆/检测/多账号/回收站/导出/Φ）', () => {
  const uiSrc = fs.readFileSync('src/static/js/ui-onboarding.js', 'utf8');
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
  const harnessSrc = ['harness.js', 'harness-sessions.js', 'harness-snapshot.js']
    .map(f => fs.readFileSync('src/static/js/' + f, 'utf8')).join('\n');
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

// ===== 2026-10-09 Φ 创造模式优化批次（目标配方上下文/起草示例/草稿试用 T246+T247）=====
// 与上一批同口径：全部同步（无 await、不返回 promise），不占串行边界段；
// 每个用例在 finally 里还原 DOM 桩、被替换的函数与 phymathia_node_recipes 键。

const RECIPE_LS_KEY = 'phymathia_node_recipes';
function _lsRecipeRaw() { return localStorage.getItem(RECIPE_LS_KEY); }
function _lsRecipeRestore(raw) {
  if (raw == null) localStorage.removeItem(RECIPE_LS_KEY);
  else localStorage.setItem(RECIPE_LS_KEY, raw);
}
function _lsRecipeSeed(recipes) { localStorage.setItem(RECIPE_LS_KEY, JSON.stringify(recipes)); }
// harnessHistory / harnessLastAppliedOps / harnessBusy 是 app.js 顶层 let 词法绑定：
// 经 vm.runInContext 读写才能既改到真状态、又原样还原（JSON 往返只带纯数据）。
function _harnessStateGet(expr) { return JSON.parse(vm.runInContext('JSON.stringify(' + expr + ')', sandbox)); }
function _harnessStateSet(expr, value) {
  sandbox.__smokeHarnessTmp = JSON.stringify(value);
  vm.runInContext(expr + ' = JSON.parse(__smokeHarnessTmp)', sandbox);
  delete sandbox.__smokeHarnessTmp;
}
function _domStub(map) {
  const prev = sandbox.document.getElementById;
  sandbox.document.getElementById = id => (Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null);
  return prev;
}
function _domRestore(prev) { sandbox.document.getElementById = prev; }

check('配方目标注入（创造模式优化）：第 40 条旧配方置顶＋摘要上限 32＋仅一份整份 detail＋不写库不突变', () => {
  const rawBefore = _lsRecipeRaw();
  const targetEl = { value: 'r-40' };
  const prevDom = _domStub({ graphHarnessRecipeTarget: targetEl });
  try {
    // 40 条配方、目标 r-40 是最旧的一条（updatedAt=1）：默认摘要排序会把它压到末尾
    const seeded = [];
    for (let i = 1; i <= 40; i++) {
      const base = _smokeValidRecipe();
      seeded.push({
        ...base,
        id: 'r-' + String(i).padStart(2, '0'),
        name: '配方' + i,
        generate: { ...base.generate, prompt: '提示词' + i },
        updatedAt: i === 40 ? 1 : (41 - i) * 1000,
      });
    }
    _lsRecipeSeed(seeded);
    const rawSeeded = _lsRecipeRaw();
    const snap = {};
    const out = sandbox._attachHarnessRecipeContext(snap);
    if (out !== snap) throw new Error('应原地返回同一个 snapshot');
    // 整份配置只带目标那一份（recipe_detail），且是完整 payload
    if (!snap.recipe_detail || snap.recipe_detail.id !== 'r-40') {
      throw new Error('recipe_detail 不是指定目标：' + JSON.stringify(snap.recipe_detail && snap.recipe_detail.id));
    }
    if (!snap.recipe_detail.generate || snap.recipe_detail.generate.prompt !== '提示词40') {
      throw new Error('recipe_detail 缺整份生成配置');
    }
    if (!snap.recipe_detail.ports || !Array.isArray(snap.recipe_detail.ports.static) || snap.recipe_detail.ports.static.length !== 2) {
      throw new Error('recipe_detail 缺出口配置');
    }
    const serialized = JSON.stringify(snap);
    if ((serialized.match(/"提示词40"/g) || []).length !== 1) throw new Error('整份配置应恰好出现一次');
    if (serialized.includes('"提示词39"')) throw new Error('非目标配方不该带整份配置');
    // 摘要：≤32、目标置顶、无重复、其余按最近修改倒序
    const summaries = snap.user_recipes;
    if (!Array.isArray(summaries) || summaries.length !== 32) {
      throw new Error('摘要应为 32 条，实际 ' + (summaries && summaries.length));
    }
    if (summaries[0].id !== 'r-40') throw new Error('指定的旧配方未置顶：' + JSON.stringify(summaries[0]));
    if (summaries[1].id !== 'r-01' || summaries[31].id !== 'r-31') {
      throw new Error('置顶之外的摘要未按最近修改倒序：' + JSON.stringify([summaries[1] && summaries[1].id, summaries[31] && summaries[31].id]));
    }
    const ids = summaries.map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new Error('摘要出现重复 id');
    if (ids.includes('r-32')) throw new Error('第 32 位之外的配方不该带进快照');
    if (summaries.some(item => item.generate || item.ports || item.base || item.appearance)) {
      throw new Error('摘要条目混入了整份配置（只有 recipe_detail 是整份）');
    }
    // 不写库：原始字节不变；detail 是深拷贝：改它不波及库
    if (_lsRecipeRaw() !== rawSeeded) throw new Error('注入过程改写了配方库');
    snap.recipe_detail.name = '被改';
    snap.recipe_detail.ports.static[0].label = '被改';
    const target = sandbox.window.getUserRecipes().find(item => item.id === 'r-40');
    if (!target || target.name !== '配方40' || target.ports.static[0].label !== '追问') {
      throw new Error('recipe_detail 与库共享引用（改快照波及库）');
    }
    // 显式 targetId（发送起点/排队回放锁定的路径）：id 优先于面板当前值；
    // 空串＝明确不指定目标（不读 DOM）；undefined 保留旧调用行为
    targetEl.value = 'r-01';
    const lockedSnap = {};
    sandbox._attachHarnessRecipeContext(lockedSnap, 'r-40');
    if (!lockedSnap.recipe_detail || lockedSnap.recipe_detail.id !== 'r-40') throw new Error('显式 targetId 未优先于面板当前值');
    const emptyTargetSnap = {};
    sandbox._attachHarnessRecipeContext(emptyTargetSnap, '');
    if (emptyTargetSnap.recipe_detail) throw new Error('空串 targetId＝明确不指定目标，不该注入');
    const implicitSnap = {};
    sandbox._attachHarnessRecipeContext(implicitSnap);
    if (!implicitSnap.recipe_detail || implicitSnap.recipe_detail.id !== 'r-01') throw new Error('旧调用（undefined）应回落读面板当前值');
    return true;
  } finally {
    _domRestore(prevDom);
    _lsRecipeRestore(rawBefore);
  }
});

check('起草示例填充（创造模式优化）：只填输入框不发送、不覆已有输入、成功时清目标选择、只读拦截', () => {
  const input = { value: '', focus() { this.focused = true; } };
  const target = { value: 'r-9' };
  const prevDom = _domStub({ graphHarnessInstruction: input, graphHarnessRecipeTarget: target });
  const prevStatus = sandbox._setHarnessStatus;
  const prevToast = sandbox.toastMsg;
  const prevSend = sandbox.runGraphHarnessWithText;
  const prevRun = sandbox.runGraphHarness;
  const statuses = [];
  let sent = 0;
  sandbox._setHarnessStatus = (text) => { statuses.push(String(text)); };
  sandbox.toastMsg = () => {};
  sandbox.runGraphHarnessWithText = () => { sent++; };
  sandbox.runGraphHarness = () => { sent++; };
  const prevReadonly = sandbox.window.PHYMATHIA_READONLY;
  try {
    sandbox.window.PHYMATHIA_READONLY = false;
    // 1. 空输入：只填示例 + 清目标，绝不发送
    sandbox.fillHarnessRecipeBrief('review');
    if (!String(input.value).includes('错题复盘')) throw new Error('review 示例未填入输入框：' + input.value);
    if (target.value !== '') throw new Error('填示例后未清掉修改目标（应回到「新建/未指定」）');
    if (!input.focused) throw new Error('填充后应聚焦输入框');
    if (sent !== 0) throw new Error('填示例触发了发送/生成');
    // 2. 已有输入：不覆盖、给提示、不动目标
    input.value = '我自己写的需求';
    target.value = 'r-9';
    statuses.length = 0;
    sandbox.fillHarnessRecipeBrief('physics');
    if (input.value !== '我自己写的需求') throw new Error('已有输入被覆盖');
    if (!statuses.some(s => s.includes('已有内容'))) throw new Error('覆盖拦截提示缺失：' + JSON.stringify(statuses));
    if (target.value !== 'r-9') throw new Error('已有输入被拦截时不该动目标选择');
    // 3. 未知 key：不动任何状态
    input.value = '';
    target.value = 'r-9';
    sandbox.fillHarnessRecipeBrief('nope');
    if (input.value !== '' || target.value !== 'r-9' || sent !== 0) throw new Error('未知示例 key 不该有动作');
    // 4. 只读查阅：整段拦截
    sandbox.window.PHYMATHIA_READONLY = true;
    statuses.length = 0;
    sandbox.fillHarnessRecipeBrief('proof');
    if (input.value !== '') throw new Error('只读模式下不该填示例');
    return true;
  } finally {
    sandbox.window.PHYMATHIA_READONLY = prevReadonly;
    sandbox.runGraphHarnessWithText = prevSend;
    sandbox.runGraphHarness = prevRun;
    sandbox._setHarnessStatus = prevStatus;
    sandbox.toastMsg = prevToast;
    _domRestore(prevDom);
  }
});

check('配方字段差异（T242 补齐）：同数换名/换序、max、label_from、each、fallback 各给用户后果', () => {
  const diff = sandbox._recipeFieldDiff;
  if (typeof diff !== 'function') throw new Error('_recipeFieldDiff 未挂 vm 全局（harness-run.js）');
  const base = {
    name: '追问器', desc: '', base: { kind: 'module' },
    appearance: { palette: 'amber', shape: 'is-round' },
    generate: { prompt: '输出追问', followup_prompt: '', confused_prompt: '', retry_prompt: '', strict_output: '' },
    ports: {
      static: [{ label: '追问', drag_form: 'draft' }, { label: '再测一道', drag_form: 'user' }],
      dynamic: {
        parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶', '拓展'], max: 12, label_from: 'index_question' },
        fallback: { mode: 'label_questions_from_text', labels: ['问题1', '问题2'] },
        each: { type: 'socratic', branch_type: 'socratic', drag_form: 'draft' },
      },
    },
    content_kind: 'markdown',
  };
  const withPorts = staticPorts => ({ ...base, ports: { ...base.ports, static: staticPorts } });
  const withDynamic = dynamic => ({ ...base, ports: { ...base.ports, dynamic } });
  // 1. 出口数量没变也可能是翻车：换序 / 换名 / 拖出行为变化都要报，并给前后对照
  const reordered = diff(base, withPorts([base.ports.static[1], base.ports.static[0]]));
  if (!reordered.includes('出口名称、顺序或拖出行为已改变')) throw new Error('同数换序未报出：' + reordered);
  if (!reordered.includes('「追问、再测一道」→「再测一道、追问」')) throw new Error('换序未给前后对照：' + reordered);
  const renamed = diff(base, withPorts([base.ports.static[0], { label: '换个条件', drag_form: 'user' }]));
  if (!renamed.includes('「追问、再测一道」→「追问、换个条件」')) throw new Error('同数换名未给前后对照：' + renamed);
  const dragChanged = diff(base, withPorts([base.ports.static[0], { label: '再测一道', drag_form: 'draft' }]));
  if (!dragChanged.includes('出口名称、顺序或拖出行为已改变')) throw new Error('拖出行为变化未报出：' + dragChanged);
  // 2. 动态出口上限与标题取法（模型重填整表时最常见的静默重置）
  const tuned = diff(base, withDynamic({
    ...base.ports.dynamic,
    parser: { ...base.ports.dynamic.parser, max: 6, label_from: 'question_trunc12' },
  }));
  if (!tuned.includes('最多生成出口 12 → 6 个')) throw new Error('max 变化未报出：' + tuned);
  if (!tuned.includes('动态出口标题的取法已改变')) throw new Error('label_from 变化未报出：' + tuned);
  // 3. each：追问类型/拖出行为
  const eachChanged = diff(base, withDynamic({ ...base.ports.dynamic, each: { type: 'learn', branch_type: 'learn', drag_form: 'user' } }));
  if (!eachChanged.includes('动态出口的追问类型或拖出行为已改变')) throw new Error('each 变化未报出：' + eachChanged);
  // 4. fallback：给用户能懂的行为后果，而不是内部 mode 名
  const fbStatic = diff(base, withDynamic({ ...base.ports.dynamic, fallback: { mode: 'static', labels: ['问题1'] } }));
  if (!fbStatic.includes('识别不到出口时：显示固定备用出口（问题1）')) throw new Error('fallback static 人话后果缺失：' + fbStatic);
  const fbNone = diff(base, withDynamic({ ...base.ports.dynamic, fallback: { mode: 'none', labels: [] } }));
  if (!fbNone.includes('识别不到出口时：不显示备用出口')) throw new Error('fallback none 人话后果缺失：' + fbNone);
  // 5. 同两份不刷噪音
  if (diff(base, JSON.parse(JSON.stringify(base))) !== '') throw new Error('同一份配方不该报差异');
  return true;
});

check('撤销上一条（T247）：配方批只给指引不发模型、previous_ops 原样、普通批仍走原撤销路', () => {
  const prevApplied = _harnessStateGet('harnessLastAppliedOps');
  const prevHistory = _harnessStateGet('harnessHistory');
  const prevStatus = sandbox._setHarnessStatus;
  const prevSend = sandbox.runGraphHarnessWithText;
  const statuses = [];
  let sent = [];
  sandbox._setHarnessStatus = (text) => { statuses.push(String(text)); };
  sandbox.runGraphHarnessWithText = (text) => { sent.push(text); };
  try {
    const batchEntry = {
      id: 'h-batch', role: 'assistant', decision: 'applied',
      previous_ops: [{ op: 'create_node', node_id: 'n1' }], harnessBefore: { nodes: 1 },
    };
    const entryRaw = JSON.stringify(batchEntry);
    // A. update_recipe 批：不调模型，只指去操作卡「撤销本次」
    _harnessStateSet('harnessLastAppliedOps', [{ op: 'update_recipe', recipe_id: 'r-1' }]);
    _harnessStateSet('harnessHistory', [batchEntry]);
    statuses.length = 0; sent = [];
    sandbox.undoLastHarnessEdit();
    if (sent.length) throw new Error('配方批撤销不该发模型：' + JSON.stringify(sent));
    if (!statuses.some(s => s.includes('配方修改或删除') && s.includes('撤销本次'))) {
      throw new Error('未给「撤销本次」指引：' + JSON.stringify(statuses));
    }
    if (JSON.stringify(_harnessStateGet('harnessLastAppliedOps')) !== JSON.stringify([{ op: 'update_recipe', recipe_id: 'r-1' }])) {
      throw new Error('harnessLastAppliedOps 被撤销入口改写');
    }
    if (JSON.stringify(_harnessStateGet('harnessHistory')[0]) !== entryRaw) throw new Error('历史条目的 previous_ops 被改写');
    // B. 混合批（普通 op ＋ delete_recipe）：同一指引，仍不发模型
    _harnessStateSet('harnessLastAppliedOps', [{ op: 'create_node', node_id: 'n2' }, { op: 'delete_recipe', recipe_id: 'r-2' }]);
    statuses.length = 0;
    sandbox.undoLastHarnessEdit();
    if (sent.length) throw new Error('混合批撤销不该发模型');
    if (!statuses.some(s => s.includes('配方修改或删除'))) throw new Error('混合批未给指引');
    // C. 普通批：照旧走智能撤销（发固定撤销指令）
    _harnessStateSet('harnessLastAppliedOps', [{ op: 'create_node', node_id: 'n3' }]);
    statuses.length = 0;
    sandbox.undoLastHarnessEdit();
    if (sent.length !== 1 || sent[0] !== '撤销刚才的修改，恢复原样') throw new Error('普通批未走原撤销路：' + JSON.stringify(sent));
    return true;
  } finally {
    _harnessStateSet('harnessLastAppliedOps', prevApplied || []);
    _harnessStateSet('harnessHistory', prevHistory || []);
    sandbox._setHarnessStatus = prevStatus;
    sandbox.runGraphHarnessWithText = prevSend;
  }
});

check('配方依赖勾选（T246）：只勾节点不勾新建配方＝不放实例且回 null、勾选态与库都不改写', () => {
  const rawBefore = _lsRecipeRaw();
  const prevHistory = _harnessStateGet('harnessHistory');
  const prevStatus = sandbox._setHarnessStatus;
  const statuses = [];
  sandbox._setHarnessStatus = (text) => { statuses.push(String(text)); };
  try {
    const recipeDraft = { ..._smokeValidRecipe(), id: 'r-sel-dep', name: '依赖配方' };
    const nodeOp = { op: 'create_node', kind: 'module', label: '依赖节点', recipe_id: 'r-sel-dep' };
    const recipeOp = { op: 'create_recipe', recipe_id: 'r-sel-dep', recipe: recipeDraft, reason: '先建配方' };
    const entry = { id: 'h-sel', role: 'assistant', decision: 'pending', operations: [recipeOp, nodeOp], selectedOps: [1] };
    _lsRecipeSeed([]); // 库里没有这个配方
    const rawSeeded = _lsRecipeRaw();
    // 1. 依赖未满足：回 null → 调用方不放实例、也不再让「应用」的通用提示覆盖这条错误
    _harnessStateSet('harnessHistory', [entry]);
    statuses.length = 0;
    const blocked = sandbox._selectedOps();
    if (blocked !== null) {
      throw new Error('依赖未满足应回 null（不放实例且不覆盖提示），实际 ' + JSON.stringify(blocked));
    }
    if (!statuses.some(s => s.includes('请同时勾选'))) throw new Error('缺依赖指引：' + JSON.stringify(statuses));
    if (JSON.stringify(_harnessStateGet('harnessHistory')[0].selectedOps) !== '[1]') throw new Error('勾选状态被改写');
    if (_lsRecipeRaw() !== rawSeeded || sandbox.window.getUserRecipes().length !== 0) throw new Error('_selectedOps 写了配方库');
    // 2. 全选（selectedOps=null）：依赖随行齐全 → 放行两条
    _harnessStateSet('harnessHistory', [{ ...entry, selectedOps: null }]);
    statuses.length = 0;
    const all = sandbox._selectedOps();
    if (!Array.isArray(all) || all.length !== 2) throw new Error('全选应放行两条，实际 ' + ((all || []).length));
    if (statuses.length) throw new Error('全选不该出错误态：' + JSON.stringify(statuses));
    // 3. 配方已在库：只勾节点也放行
    _lsRecipeSeed([recipeDraft]);
    _harnessStateSet('harnessHistory', [entry]);
    statuses.length = 0;
    const onlyNode = sandbox._selectedOps();
    if (!Array.isArray(onlyNode) || onlyNode.length !== 1 || onlyNode[0].op !== 'create_node') {
      throw new Error('配方已在库时应放行节点：' + JSON.stringify((onlyNode || []).map(op => op.op)));
    }
    return true;
  } finally {
    _harnessStateSet('harnessHistory', prevHistory || []);
    sandbox._setHarnessStatus = prevStatus;
    _lsRecipeRestore(rawBefore);
  }
});

check('草稿试用守卫（创造模式优化）：不写库不自动生成、忙碌/校验/绑定三道守、成功只放草稿节点', () => {
  const rawBefore = _lsRecipeRaw();
  const prevHistory = _harnessStateGet('harnessHistory');
  const prevBusy = vm.runInContext('harnessBusy', sandbox);
  const prevStatus = sandbox._setHarnessStatus;
  const prevCreate = sandbox.createRecipeNode;
  const prevBound = sandbox._harnessBoundSid;
  const prevSid = sandbox._sessionId;
  const prevSend = sandbox.runGraphHarness;
  const prevRunNodes = sandbox.runWorkflowNodes;
  const prevCanApply = sandbox._harnessCanApply;
  const prevVersionSource = sandbox._harnessVersionSource;
  const prevGraphStateFn = sandbox._harnessGraphState;
  const prevGraphVersion = sandbox._harnessGraphVersion;
  const prevSaveHistory = sandbox._saveHarnessHistory;
  const prevReadonly = sandbox.window.PHYMATHIA_READONLY;
  const statuses = [];
  const created = [];
  let generated = 0;
  let claimed = 0;
  const gstate = { customNodes: [] };
  sandbox._setHarnessStatus = (text) => { statuses.push(String(text)); };
  sandbox.createRecipeNode = (id, draft) => {
    created.push({ id, draft });
    const nodeId = 'node-' + id;
    gstate.customNodes = gstate.customNodes.concat([{ id: nodeId }]);
    return nodeId;
  };
  sandbox.runGraphHarness = () => { generated++; };
  sandbox.runWorkflowNodes = () => { generated++; };
  // 试用现在先过 _harnessCanApply（真实现含 trial 双指纹），并捕获前后版本决定是否认领：
  // 这些链按真实同形打桩（_harnessVersionSource 返回七字段数组的 JSON 字符串），
  // 让本用例只盯「不写库/不自动生成/三道守卫」本身（认领另有专测）。
  sandbox._harnessCanApply = () => true;
  sandbox._harnessGraphState = () => gstate;
  sandbox._harnessVersionSource = state => {
    const s = state || {};
    const pick = key => (Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null);
    return JSON.stringify([pick('customNodes'), pick('harnessNodeOverrides'), pick('harnessDeleted'),
      pick('connections'), pick('removedEdges'), pick('portCounts'), pick('inputPortCounts')]);
  };
  sandbox._harnessGraphVersion = () => 'v-trial-smoke';
  sandbox._saveHarnessHistory = () => { claimed++; };
  try {
    sandbox.window.PHYMATHIA_READONLY = false;
    _harnessStateSet('harnessBusy', false);
    sandbox._harnessBoundSid = () => 'sess_draft';
    sandbox._sessionId = () => 'sess_draft';
    const recipe = { ..._smokeValidRecipe(), id: 'r-trial', name: '草稿源配方' };
    const op = { op: 'create_recipe', recipe_id: 'r-trial', recipe, reason: 'x' };
    const entry = { id: 'h-trial', role: 'assistant', decision: 'pending', operations: [op], selectedOps: null, _binding: { sessionId: 'sess_draft' } };
    _lsRecipeSeed([{ ..._smokeValidRecipe(), id: 'r-existing', name: '库里已有' }]);
    const rawSeeded = _lsRecipeRaw();
    _harnessStateSet('harnessHistory', [entry]);
    // 1. 成功路径：只把草稿节点交给 createRecipeNode（真节点创建由协调补测单测），
    //    库字节不变、不调模型/工作流、状态说明「库未改变＋手动生成才产生费用」
    statuses.length = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length !== 1) throw new Error('应放置 1 个草稿节点，实际 ' + created.length);
    if (!String(created[0].id).startsWith('recipe-trial-')) throw new Error('草稿节点 id 前缀不对：' + created[0].id);
    if (created[0].draft.name !== '草稿源配方·草稿试用') throw new Error('草稿名字应带「草稿试用」后缀：' + created[0].draft.name);
    if (created[0].draft.id !== created[0].id) throw new Error('draft.id 与传入 id 不一致');
    if (!created[0].draft.generate || !created[0].draft.generate.prompt) throw new Error('草稿缺整份生成配置');
    if (op.recipe.name !== '草稿源配方') throw new Error('试用改写了操作里的草稿 payload');
    if (generated !== 0) throw new Error('试用不该自动调模型/跑工作流');
    if (_lsRecipeRaw() !== rawSeeded) throw new Error('试用写了配方库：' + _lsRecipeRaw());
    if (claimed !== 1) throw new Error('成功试用应认领并落盘历史一次，实际 ' + claimed);
    if (!statuses.some(s => s.includes('正式配方库未改变'))) throw new Error('缺「配方库未改变」交代：' + JSON.stringify(statuses));
    if (!statuses.some(s => s.includes('费用'))) throw new Error('状态未说明手动生成会调用模型产生费用');
    // 2. 忙碌守卫
    _harnessStateSet('harnessBusy', true);
    statuses.length = 0; created.length = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length) throw new Error('生成中仍放置了草稿');
    if (!statuses.some(s => s.includes('请等当前生成结束'))) throw new Error('忙碌守卫提示缺失');
    _harnessStateSet('harnessBusy', false);
    // 3. 校验守卫：非法色板
    _harnessStateSet('harnessHistory', [{ ...entry, operations: [{ ...op, recipe: { ...recipe, appearance: { palette: 'hotpink', shape: 'is-round' } } }] }]);
    statuses.length = 0; created.length = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length) throw new Error('非法草稿仍被放置');
    if (!statuses.some(s => s.includes('未通过校验'))) throw new Error('校验守卫提示缺失');
    // 4. 绑定守卫：未绑定 / 绑了别的画布
    _harnessStateSet('harnessHistory', [entry]);
    sandbox._harnessBoundSid = () => '';
    statuses.length = 0; created.length = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length) throw new Error('未绑定画布仍放置草稿');
    if (!statuses.some(s => s.includes('先打开 Φ 绑定的画布'))) throw new Error('绑定守卫提示缺失');
    sandbox._harnessBoundSid = () => 'sess_other';
    statuses.length = 0; created.length = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length) throw new Error('绑定别的画布仍放置草稿');
    // 5. 越界索引：静默无动作
    sandbox._harnessBoundSid = () => 'sess_draft';
    statuses.length = 0; created.length = 0;
    sandbox.trialHarnessRecipe(9);
    if (created.length || statuses.length) throw new Error('越界索引不该有任何动作');
    return true;
  } finally {
    sandbox.window.PHYMATHIA_READONLY = prevReadonly;
    _harnessStateSet('harnessBusy', !!prevBusy);
    sandbox.createRecipeNode = prevCreate;
    sandbox._harnessBoundSid = prevBound;
    sandbox._sessionId = prevSid;
    sandbox._setHarnessStatus = prevStatus;
    sandbox.runGraphHarness = prevSend;
    sandbox.runWorkflowNodes = prevRunNodes;
    sandbox._harnessCanApply = prevCanApply;
    sandbox._harnessVersionSource = prevVersionSource;
    sandbox._harnessGraphState = prevGraphStateFn;
    sandbox._harnessGraphVersion = prevGraphVersion;
    sandbox._saveHarnessHistory = prevSaveHistory;
    _harnessStateSet('harnessHistory', prevHistory || []);
    _lsRecipeRestore(rawBefore);
  }
});

check('试用指纹认领（创造模式优化）：扣除本次试用节点后版本相等才认领；失败/再改图都不认领', () => {
  const rawStart = _lsRecipeRaw();
  const prevHistory = _harnessStateGet('harnessHistory');
  const prevResult = vm.runInContext('harnessResult', sandbox);
  const prevBusy = vm.runInContext('harnessBusy', sandbox);
  const prevStatus = sandbox._setHarnessStatus;
  const prevCreate = sandbox.createRecipeNode;
  const prevBound = sandbox._harnessBoundSid;
  const prevSid = sandbox._sessionId;
  const prevCanApply = sandbox._harnessCanApply;
  const prevVersionSource = sandbox._harnessVersionSource;
  const prevGraphStateFn = sandbox._harnessGraphState;
  const prevGraphVersion = sandbox._harnessGraphVersion;
  const prevSaveHistory = sandbox._saveHarnessHistory;
  const prevReadonly = sandbox.window.PHYMATHIA_READONLY;
  const statuses = [];
  const created = [];
  let gstate = { customNodes: [] };
  let canApplyVerdict = true;
  let otherFieldOnCreate = false;
  let saveCalls = 0;
  sandbox._setHarnessStatus = (text) => { statuses.push(String(text)); };
  sandbox.createRecipeNode = (id, draft) => {
    created.push({ id, draft });
    const nodeId = 'node-' + id;
    // 恰好一条与返回 nodeID 同 id 的新节点（认领前提）；负例再改另一版本字段
    gstate.customNodes = (gstate.customNodes || []).concat([{ id: nodeId }]);
    if (otherFieldOnCreate) gstate.connections = [{ from: 'x', to: 'y' }];
    return nodeId;
  };
  sandbox._harnessCanApply = () => canApplyVerdict;
  sandbox._harnessGraphState = () => gstate;
  // 与真实 _harnessVersionSource 同形：七字段数组的 JSON 字符串，第 0 位是 customNodes
  sandbox._harnessVersionSource = state => {
    const s = state || {};
    const pick = key => (Object.prototype.hasOwnProperty.call(s, key) ? s[key] : null);
    return JSON.stringify([pick('customNodes'), pick('harnessNodeOverrides'), pick('harnessDeleted'),
      pick('connections'), pick('removedEdges'), pick('portCounts'), pick('inputPortCounts')]);
  };
  sandbox._harnessGraphVersion = () => 'v-trial-stub';
  sandbox._saveHarnessHistory = () => { saveCalls++; };
  try {
    sandbox.window.PHYMATHIA_READONLY = false;
    _harnessStateSet('harnessBusy', false);
    sandbox._harnessBoundSid = () => 'sess_draft';
    sandbox._sessionId = () => 'sess_draft';
    const recipe = { ..._smokeValidRecipe(), id: 'r-fp', name: '指纹配方' };
    const op = { op: 'create_recipe', recipe_id: 'r-fp', recipe, reason: 'x' };
    const entry = {
      id: 'h-fp', role: 'assistant', decision: 'pending', operations: [op], selectedOps: null,
      _binding: { sessionId: 'sess_draft', trialNodeIds: ['node-old'] },
    };
    // 1. 成功：只新增本次试用节点 → 扣除后版本相等 → 认领版本并只追加该节点
    _harnessStateSet('harnessHistory', [entry]);
    _harnessStateSet('harnessResult', { _binding: null });
    canApplyVerdict = true; otherFieldOnCreate = false;
    statuses.length = 0; created.length = 0; saveCalls = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length !== 1) throw new Error('成功路径应放置 1 个草稿节点，实际 ' + created.length);
    const nodeId1 = 'node-' + created[0].id;
    const hist1 = _harnessStateGet('harnessHistory')[0];
    if (hist1._binding.trialGraphVersion !== 'v-trial-stub') {
      throw new Error('成功试用未认领 trialGraphVersion：' + JSON.stringify(hist1._binding));
    }
    if (JSON.stringify(hist1._binding.trialNodeIds) !== JSON.stringify(['node-old', nodeId1])) {
      throw new Error('trialNodeIds 应只在原清单后追加本次节点：' + JSON.stringify(hist1._binding.trialNodeIds));
    }
    if (saveCalls !== 1) throw new Error('认领后应落盘历史一次，实际 ' + saveCalls);
    const result1 = _harnessStateGet('harnessResult');
    if (JSON.stringify(result1 && result1._binding) !== JSON.stringify(hist1._binding)) {
      throw new Error('harnessResult._binding 未同步认领');
    }
    if (!statuses.some(s => s.includes('正式配方库未改变'))) throw new Error('缺成功状态：' + JSON.stringify(statuses));
    if (_lsRecipeRaw() !== rawStart) throw new Error('试用认领写了配方库');
    // 1b. 画布此前没有 customNodes 键（原始第 0 位是 null）：扣除后第 0 位保留 null，仍应认领
    gstate = {};
    _harnessStateSet('harnessHistory', [entry]);
    statuses.length = 0; created.length = 0; saveCalls = 0;
    sandbox.trialHarnessRecipe(0);
    const histB = _harnessStateGet('harnessHistory')[0];
    if (histB._binding.trialGraphVersion !== 'v-trial-stub' || saveCalls !== 1) {
      throw new Error('无 customNodes 键的画布应照常认领：' + JSON.stringify(histB._binding));
    }
    // 2. _harnessCanApply 拒绝（严格 _binding/双指纹不符）：不放节点、不认领、不落盘
    canApplyVerdict = false;
    _harnessStateSet('harnessHistory', [entry]);
    statuses.length = 0; created.length = 0; saveCalls = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length) throw new Error('_harnessCanApply 拒绝后仍放置了草稿');
    const hist2 = _harnessStateGet('harnessHistory')[0];
    if (Object.prototype.hasOwnProperty.call(hist2._binding, 'trialGraphVersion')) throw new Error('被拒后不该认领版本');
    if (JSON.stringify(hist2._binding.trialNodeIds) !== JSON.stringify(['node-old'])) throw new Error('被拒后不该追加 trialNodeIds');
    if (saveCalls !== 0) throw new Error('被拒后不该落盘');
    // 3. 试用期间其他版本字段也变了（扣掉本次节点后仍不等）：照常放节点但不认领
    canApplyVerdict = true; otherFieldOnCreate = true;
    _harnessStateSet('harnessHistory', [entry]);
    statuses.length = 0; created.length = 0; saveCalls = 0;
    sandbox.trialHarnessRecipe(0);
    if (created.length !== 1) throw new Error('再改图时应照常放草稿节点，实际 ' + created.length);
    const hist3 = _harnessStateGet('harnessHistory')[0];
    if (Object.prototype.hasOwnProperty.call(hist3._binding, 'trialGraphVersion')) {
      throw new Error('扣除本次节点后版本仍变化，不该认领 trialGraphVersion');
    }
    if (JSON.stringify(hist3._binding.trialNodeIds) !== JSON.stringify(['node-old'])) {
      throw new Error('不该追加 trialNodeIds：' + JSON.stringify(hist3._binding.trialNodeIds));
    }
    if (saveCalls !== 0) throw new Error('未认领不该落盘，实际 ' + saveCalls);
    if (!statuses.some(s => s.includes('正式配方库未改变'))) throw new Error('放置成功状态仍应给出（只是不认领）');
    return true;
  } finally {
    sandbox.window.PHYMATHIA_READONLY = prevReadonly;
    _harnessStateSet('harnessBusy', !!prevBusy);
    sandbox._harnessCanApply = prevCanApply;
    sandbox._harnessVersionSource = prevVersionSource;
    sandbox._harnessGraphState = prevGraphStateFn;
    sandbox._harnessGraphVersion = prevGraphVersion;
    sandbox._saveHarnessHistory = prevSaveHistory;
    sandbox.createRecipeNode = prevCreate;
    sandbox._harnessBoundSid = prevBound;
    sandbox._sessionId = prevSid;
    sandbox._setHarnessStatus = prevStatus;
    _harnessStateSet('harnessHistory', prevHistory || []);
    sandbox.__smokeHarnessTmp = prevResult;
    vm.runInContext('harnessResult = __smokeHarnessTmp', sandbox);
    delete sandbox.__smokeHarnessTmp;
    _lsRecipeRestore(rawStart);
  }
});

check('草稿试用入口渲染（创造模式优化）：可编辑的配方行出现试用按钮、标题写明不保存与费用', () => {
  const row = sandbox._harnessOpRowHtml;
  if (typeof row !== 'function') throw new Error('_harnessOpRowHtml 未挂 vm 全局');
  const op = { op: 'create_recipe', recipe_id: 'r-x', recipe: { ..._smokeValidRecipe(), id: 'r-x' }, reason: 'r' };
  const html = String(row(op, 0, [op], true, null, false));
  if (!html.includes('trialHarnessRecipe(0)')) throw new Error('配方行缺试用入口：' + html);
  if (!html.includes('草稿试用')) throw new Error('试用按钮文案缺失');
  if (!/title="[^"]*费用[^"]*"/.test(html)) throw new Error('试用按钮标题未说明费用：' + html);
  if (!html.includes('不保存配方')) throw new Error('试用按钮标题未说明不落库：' + html);
  const nodeOp = { op: 'create_node', kind: 'ground', label: 'x', reason: 'r' };
  const nodeHtml = String(row(nodeOp, 0, [nodeOp], true, null, false));
  if (nodeHtml.includes('trialHarnessRecipe')) throw new Error('非配方 op 不该出试用入口');
  const lockedHtml = String(row(op, 0, [op], false, null, false));
  if (lockedHtml.includes('trialHarnessRecipe')) throw new Error('不可编辑行不该出试用入口');
  return true;
});

check('草稿节点真实落地（协调补测）：createRecipeNode(draft.id, draft) 内嵌快照、入图不写配方库', () => {
  const rawBefore = _lsRecipeRaw();
  const prevGraphState = sandbox._graphState;
  const prevSaveState = sandbox._saveGraphState;
  const prevPushUndo = sandbox._pushGraphUndo;
  const prevRender = sandbox.renderGraphCanvas;
  const prevClose = sandbox.closeAddBlankNodeModal;
  const prevToast = sandbox.toastMsg;
  let state = { customNodes: [] };
  const calls = { save: 0, undo: 0, render: 0, close: 0 };
  const toasts = [];
  sandbox._graphState = () => state;
  sandbox._saveGraphState = (next) => { calls.save++; state = next; };
  sandbox._pushGraphUndo = () => { calls.undo++; };
  sandbox.renderGraphCanvas = () => { calls.render++; };
  sandbox.closeAddBlankNodeModal = () => { calls.close++; };
  sandbox.toastMsg = (msg) => { toasts.push(String(msg)); };
  try {
    _lsRecipeSeed([]);
    const rawSeeded = _lsRecipeRaw();
    const draft = { ..._smokeValidRecipe(), id: 'recipe-trial-node-1', name: '错题复盘·草稿试用' };
    const returnedId = sandbox.createRecipeNode(draft.id, draft);
    const nodes = state.customNodes || [];
    if (nodes.length !== 1) throw new Error('应落 1 个节点，实际 ' + nodes.length);
    const node = nodes[0];
    if (!returnedId || returnedId !== node.id) throw new Error('createRecipeNode 应回节点 id（trial 认领靠它）：' + returnedId);
    if (node.recipeId !== draft.id) throw new Error('节点 recipeId 未指向草稿：' + node.recipeId);
    if (!node.recipe || node.recipe.name !== '错题复盘·草稿试用') throw new Error('节点缺内嵌配方快照');
    if (!node.recipe.generate || node.recipe.generate.prompt !== draft.generate.prompt) throw new Error('内嵌快照缺生成配置');
    if (!node.recipe.ports || node.recipe.ports.static.length !== 2) throw new Error('内嵌快照缺出口配置');
    if (node.kind !== 'module') throw new Error('module 底座应落 kind=module，实际 ' + node.kind);
    if (calls.save !== 1 || calls.render !== 1 || calls.close !== 1) throw new Error('收尾动作未按预期各一次：' + JSON.stringify(calls));
    if (calls.undo !== 1) throw new Error('未记一次撤销点');
    if (toasts.length) throw new Error('不该有报错提示：' + JSON.stringify(toasts));
    if (_lsRecipeRaw() !== rawSeeded) throw new Error('真实节点函数改写了配方库');
    if (sandbox.window.getUserRecipes().some(item => item.id === draft.id)) throw new Error('草稿 id 进了配方库');
    // 负例：库无此 id 且未带草稿 → 提示不存在、不入图、不回 id
    const missingId = sandbox.createRecipeNode('recipe-missing');
    if (missingId) throw new Error('建节点失败不该回 id：' + missingId);
    if ((state.customNodes || []).length !== 1) throw new Error('不存在的配方不该建节点');
    if (!toasts.some(t => t.includes('配方不存在'))) throw new Error('缺「配方不存在」提示：' + JSON.stringify(toasts));
    return true;
  } finally {
    sandbox._graphState = prevGraphState;
    sandbox._saveGraphState = prevSaveState;
    sandbox._pushGraphUndo = prevPushUndo;
    sandbox.renderGraphCanvas = prevRender;
    sandbox.closeAddBlankNodeModal = prevClose;
    sandbox.toastMsg = prevToast;
    _lsRecipeRestore(rawBefore);
  }
});
check('配方实例落地映射（创造模式优化）：_newHarnessNode 按 base.kind 映射 note/manual/question，普通 kind 不变', () => {
  const rawBefore = _lsRecipeRaw();
  try {
    const mk = (id, name, baseKind) => ({ ..._smokeValidRecipe(), id, name, base: { kind: baseKind } });
    _lsRecipeSeed([
      mk('r-note', '手填总结配方', 'note'),
      mk('r-manual', '手填回答配方', 'manual'),
      mk('r-question', '问题配方', 'question'),
      mk('r-module', 'AI 模块配方', 'module'),
    ]);
    const pos = { x: 0, y: 0 };
    // note：不落 op.kind=module，kind 保持 note（手填类）
    const noteNode = sandbox._newHarnessNode('n-note', { kind: 'module', label: 'x', recipe_id: 'r-note' }, pos);
    if (noteNode.kind !== 'note') throw new Error('note 底座应映射 kind=note，实际 ' + noteNode.kind);
    if (noteNode.manual !== true) throw new Error('note 配方实例应 manual=true');
    if (noteNode.recipeId !== 'r-note' || !noteNode.recipe || noteNode.recipe.name !== '手填总结配方') {
      throw new Error('note 实例缺内嵌快照');
    }
    // manual：与 createRecipeNode 的 kindMap 同款 → answer 且 manual
    const manualNode = sandbox._newHarnessNode('n-manual', { kind: 'module', label: 'x', recipe_id: 'r-manual' }, pos);
    if (manualNode.kind !== 'answer') throw new Error('manual 底座应映射 kind=answer，实际 ' + manualNode.kind);
    if (manualNode.manual !== true) throw new Error('manual 配方实例应 manual=true');
    // question → user，且不是手填
    const questionNode = sandbox._newHarnessNode('n-question', { kind: 'module', label: 'x', recipe_id: 'r-question' }, pos);
    if (questionNode.kind !== 'user') throw new Error('question 底座应映射 kind=user，实际 ' + questionNode.kind);
    if (questionNode.manual !== false) throw new Error('question 配方实例应 manual=false');
    // module 底座保持 module
    const moduleNode = sandbox._newHarnessNode('n-module', { kind: 'module', label: 'x', recipe_id: 'r-module' }, pos);
    if (moduleNode.kind !== 'module') throw new Error('module 底座应保持 module，实际 ' + moduleNode.kind);
    // 无配方：op.kind 原样；库中无此 id：回落 op.kind 且不带快照
    const plain = sandbox._newHarnessNode('n-plain', { kind: 'knowledge', label: 'y' }, pos);
    if (plain.kind !== 'knowledge' || plain.recipeId || plain.recipe) throw new Error('无配方 op 不该改 kind/挂快照');
    const missing = sandbox._newHarnessNode('n-missing', { kind: 'summary', label: 'z', recipe_id: 'r-not-in-lib' }, pos);
    if (missing.kind !== 'summary' || missing.recipeId || missing.recipe) throw new Error('库中无此配方应回落 op.kind 且不带快照');
    return true;
  } finally {
    _lsRecipeRestore(rawBefore);
  }
});

check('应用守卫（创造模式优化）：原版本/trial 版本放行，改图或配方库变化拒绝，视图与时间戳不误挡', () => {
  const rawBefore = _lsRecipeRaw();
  const prevGetState = sandbox.window.getGraphState;
  const prevGetSid = sandbox.window.getCurrentSessionId;
  const prevStatus = sandbox._setHarnessStatus;
  const statuses = [];
  let gstate = { customNodes: [{ id: 'n1' }], connections: [] };
  sandbox.window.getGraphState = () => gstate;
  sandbox.window.getCurrentSessionId = () => 'sess_apply';
  sandbox._setHarnessStatus = (text, kind) => { statuses.push(String(text) + '|' + (kind || '')); };
  try {
    const can = binding => sandbox._harnessCanApply(binding);
    const vNow = sandbox._harnessGraphVersion('sess_apply');
    // 1. 正常原版本放行；平移/缩放/坐标/时间戳等视图字段不进指纹，不误挡
    statuses.length = 0;
    if (can({ sessionId: 'sess_apply', graphVersion: vNow }) !== true) throw new Error('原版本应放行');
    if (statuses.length) throw new Error('放行不该出错误态：' + JSON.stringify(statuses));
    gstate = {
      customNodes: [{ id: 'n1' }], connections: [],
      pan: { x: 999, y: -5 }, zoom: 2.4, positions: { n1: { x: 1, y: 2 } }, focus: 'n1', updatedAt: 99999,
    };
    if (sandbox._harnessGraphVersion('sess_apply') !== vNow) throw new Error('视图字段不该进图指纹');
    if (can({ sessionId: 'sess_apply', graphVersion: vNow }) !== true) throw new Error('仅视图变化不该误挡');
    gstate = { customNodes: [{ id: 'n1' }], connections: [] };
    // 2. trial 版本放行：画布恰多了用户自己放的试用节点（真实指纹）
    gstate = { customNodes: [{ id: 'n1' }, { id: 'trial-1' }], connections: [] };
    const vTrial = sandbox._harnessGraphVersion('sess_apply');
    if (vTrial === vNow) throw new Error('种子自检：加试用节点应改变指纹');
    if (can({ sessionId: 'sess_apply', graphVersion: vNow, trialGraphVersion: vTrial, trialNodeIds: ['trial-1'] }) !== true) {
      throw new Error('trial 版本应放行');
    }
    // 2b. trialNodeIds 为空：不认 trial 指纹
    statuses.length = 0;
    if (can({ sessionId: 'sess_apply', trialGraphVersion: vTrial, trialNodeIds: [] }) !== false) throw new Error('trialNodeIds 空不该放行');
    if (!statuses.some(s => s.includes('画布或会话已变化'))) throw new Error('缺画布变化提示');
    // 3. 试用后又被改图 → 拒绝
    gstate = { customNodes: [{ id: 'n1' }, { id: 'trial-1' }, { id: 'other' }], connections: [] };
    statuses.length = 0;
    if (can({ sessionId: 'sess_apply', graphVersion: vNow, trialGraphVersion: vTrial, trialNodeIds: ['trial-1'] }) !== false) {
      throw new Error('试用后另改图应拒绝');
    }
    if (!statuses.some(s => s.includes('画布或会话已变化'))) throw new Error('缺画布变化提示');
    // 3b. 删掉试用节点、指纹回到 graphVersion → 放行
    gstate = { customNodes: [{ id: 'n1' }], connections: [] };
    if (can({ sessionId: 'sess_apply', graphVersion: vNow, trialGraphVersion: vTrial, trialNodeIds: ['trial-1'] }) !== true) {
      throw new Error('删掉试用节点回到原指纹应放行');
    }
    // 4. recipeVersion：内容没变、仅 updatedAt/库顺序变化不误挡；内容改了才拒绝
    const mk = (id, name, updatedAt) => ({ ..._smokeValidRecipe(), id, name, updatedAt });
    _lsRecipeSeed([mk('r-a', '库A', 1000), mk('r-b', '库B', 2000)]);
    const rvA = sandbox._harnessRecipeVersion();
    _lsRecipeSeed([mk('r-b', '库B', 99000), mk('r-a', '库A', 55000)]); // 顺序颠倒＋updatedAt 变
    const rvB = sandbox._harnessRecipeVersion();
    if (rvA !== rvB) throw new Error('配方时间戳/库顺序不该进版本指纹');
    if (can({ sessionId: 'sess_apply', graphVersion: vNow, recipeVersion: rvA }) !== true) throw new Error('仅时间戳/顺序变化不该误挡');
    _lsRecipeSeed([mk('r-a', '库A2', 1000), mk('r-b', '库B', 2000)]); // 内容真变了
    const rvC = sandbox._harnessRecipeVersion();
    if (rvC === rvA) throw new Error('种子自检：改配方内容应改变版本');
    statuses.length = 0;
    if (can({ sessionId: 'sess_apply', graphVersion: vNow, recipeVersion: rvB }) !== false) throw new Error('配方库变化应拒绝');
    if (!statuses.some(s => s.includes('配方库已变化'))) throw new Error('缺配方库变化提示：' + JSON.stringify(statuses));
    if (can({ sessionId: 'sess_apply', graphVersion: vNow, recipeVersion: rvC }) !== true) throw new Error('配方库版本一致应放行');
    // 5. 会话不符 / 无 binding 拒绝
    statuses.length = 0;
    if (can({ sessionId: 'sess_other', graphVersion: vNow }) !== false) throw new Error('别的画布应拒绝');
    if (can(null) !== false) throw new Error('无 binding 应拒绝');
    if (!statuses.some(s => s.includes('画布或会话已变化'))) throw new Error('缺画布变化提示');
    return true;
  } finally {
    sandbox.window.getGraphState = prevGetState;
    sandbox.window.getCurrentSessionId = prevGetSid;
    sandbox._setHarnessStatus = prevStatus;
    _lsRecipeRestore(rawBefore);
  }
});
check('请求模式/目标锁定（创造模式优化）：opts 优先、空目标显式不指定、不绑图空快照同口径', () => {
  const rawBefore = _lsRecipeRaw();
  const targetEl = { value: 'r-dom' };
  const prevDom = _domStub({ graphHarnessRecipeTarget: targetEl });
  try {
    _lsRecipeSeed([
      { ..._smokeValidRecipe(), id: 'r-lock', name: '锁定配方' },
      { ..._smokeValidRecipe(), id: 'r-dom', name: '面板配方' },
    ]);
    // 解析器：opts 显式优先；未传回落面板当前模式；空串回落（不误当锁定）
    if (sandbox._harnessResolveRequestMode({ mode: 'preset' }) !== 'preset') throw new Error('opts.mode 未优先');
    const modeBefore = sandbox.window._harnessMode();
    sandbox.window.chooseHarnessMode('chat');
    try {
      if (sandbox._harnessResolveRequestMode({}) !== 'chat') throw new Error('未传 mode 应回落面板当前模式');
      if (sandbox._harnessResolveRequestMode({ mode: '' }) !== 'chat') throw new Error('空 mode 应回落当前模式');
    } finally { sandbox.window.chooseHarnessMode(modeBefore); }
    if (sandbox._harnessResolveRecipeTargetId({ recipeTargetId: '' }) !== '') throw new Error('显式空目标应原样返回空串（不读 DOM）');
    if (sandbox._harnessResolveRecipeTargetId({ recipeTargetId: 'r-lock' }) !== 'r-lock') throw new Error('显式目标未优先');
    if (sandbox._harnessResolveRecipeTargetId(null) !== 'r-dom') throw new Error('未传目标应读面板当前选择');
    // 不绑图的空快照同口径：preset 才注入；显式空目标不读 DOM；chat 不注入
    const locked = sandbox._emptyHarnessSnapshot({ mode: 'preset', recipeTargetId: 'r-lock' });
    if (!locked.nodes || locked.nodes.length !== 0) throw new Error('空快照不该带图内容');
    if (!locked.recipe_detail || locked.recipe_detail.id !== 'r-lock') throw new Error('preset＋显式目标应注入目标配方');
    const noTarget = sandbox._emptyHarnessSnapshot({ mode: 'preset', recipeTargetId: '' });
    if (noTarget.recipe_detail) throw new Error('显式空目标＝不指定，不该回读 DOM 注入 r-dom');
    const chat = sandbox._emptyHarnessSnapshot({ mode: 'chat', recipeTargetId: 'r-lock' });
    if (chat.recipe_detail) throw new Error('chat 相位不该注入配方上下文');
    return true;
  } finally {
    _domRestore(prevDom);
    _lsRecipeRestore(rawBefore);
  }
});
// ===== 配方节点卡片配色（2026-10-09 用户验收：与内置节点只差颜色）=====
// 静态是唯一可行口径：冒烟沙箱执行 app.js 但不跑 CSS，与「设计尺子」「玻璃载体」同法读源。
check('配方节点卡片配色：与内置模块同款 4px 彩框＋彩色渐变＋彩色辉光，颜色取 --node-attr', () => {
  const css = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const m = css.match(/\[data-theme="dark"\] (\.graph-node\.graph-attr-recipe[^{]*)\{([^}]*)\}/);
  if (!m) throw new Error('配方节点卡片配色规则缺失（graph-attr-recipe）——配方卡会退回 1px 白描边的近黑卡');
  const [, selector, block] = m;
  if (!/border-color:\s*var\(--node-attr\)/.test(block)) throw new Error('配方卡边框未取配方颜色 var(--node-attr)');
  if (!/border-width:\s*4px/.test(block) || !/border-left-width:\s*7px/.test(block)) {
    throw new Error('配方卡缺与内置模块同款的 4px 彩框（左 7px）');
  }
  if (!/--graph-bubble-start:\s*color-mix\(in srgb, var\(--node-attr\)/.test(block)) throw new Error('配方卡缺彩色渐变起点');
  if (!/--graph-bubble-glow:\s*color-mix\(in srgb, var\(--node-attr\)/.test(block)) throw new Error('配方卡缺彩色辉光');
  if (!css.includes('[data-theme="light"] .graph-node.graph-attr-recipe')) throw new Error('配方卡缺浅色主题档');
  // 从配方端口拖出的草稿小卡要保持轻量样式，规则必须排除它
  if (!selector.includes(':not(.graph-node-draft)')) throw new Error('配方卡规则应排除 .graph-node-draft（草稿小卡另样）');
  return true;
});
// ===== T263 端口分类体系 v2：具名输入端口与内容类型 =====
check('配方端口分类 v2：输入端口 normalize/校验/出口类型推导/画布契约（T263）', () => {
  const w = sandbox.window;
  if (!Array.isArray(w.RECIPE_PORT_TYPES) || w.RECIPE_PORT_TYPES.join(',') !== 'text,formula,diagram,html') {
    throw new Error('RECIPE_PORT_TYPES 枚举应是 text/formula/diagram/html');
  }
  const norm = w.normalizeRecipeInput({
    name: '矢量合成', base: { kind: 'module' },
    generate: { prompt: '合成两个力' },
    ports: {
      static: [{ label: '合力讲解', drag_form: 'draft', type: 'text' }, { label: '示意图', drag_form: 'draft', type: 'diagram' }],
      inputs: [{ label: '力一', type: 'text' }, { label: '力二', type: '' }, { label: '  ', type: 'html' }, '垃圾项'],
    },
  });
  if (JSON.stringify(norm.ports.inputs) !== JSON.stringify([{ label: '力一', type: 'text' }, { label: '力二', type: '' }])) {
    throw new Error('具名输入口归一化错误：' + JSON.stringify(norm.ports.inputs));
  }
  if (norm.ports.static[0].type !== 'text' || norm.ports.static[1].type !== 'diagram') throw new Error('出口 type 未保留');
  const noType = w.normalizeRecipeInput({ name: '无类型', base: { kind: 'module' }, generate: { prompt: 'x' }, ports: { static: [{ label: '追问', drag_form: 'draft' }] } });
  if ('type' in noType.ports.static[0]) throw new Error('未声明 type 的出口不得设 type 键（两侧对拍同形）');
  const legacy = w.normalizeRecipeInput({ name: '旧稿', base: { kind: 'module' }, generate: { prompt: 'x' }, ports: { static: [], inputs: 1 } });
  if (legacy.ports.inputs) throw new Error('旧设计稿数字型 inputs 应剥除');
  const base = { name: '矢量合成', base: { kind: 'module' }, generate: { prompt: 'x' }, appearance: { palette: 'amber' } };
  const dup = w.validateRecipe({ ...base, ports: { static: [{ label: '追问', drag_form: 'draft' }], inputs: [{ label: '力一', type: '' }, { label: '力一', type: 'text' }] } }, []);
  if (dup.ok || !dup.errors.some(e => e.includes('输入端口名字重复'))) throw new Error('输入口重名应拒绝');
  const badType = w.validateRecipe({ ...base, ports: { static: [{ label: '追问', drag_form: 'draft' }], inputs: [{ label: '速度', type: 'number' }] } }, []);
  if (badType.ok || !badType.errors.some(e => e.includes('类型不合法'))) throw new Error('输入口类型枚举外应拒绝');
  const badOut = w.validateRecipe({ ...base, ports: { static: [{ label: '追问', drag_form: 'draft', type: 'quiz' }] } }, []);
  if (badOut.ok || !badOut.errors.some(e => e.includes('类型不合法'))) throw new Error('出口类型枚举外应拒绝');
  if (w._recipePortTypeForContent('mermaid') !== 'diagram' || w._recipePortTypeForContent('html_iframe') !== 'html' || w._recipePortTypeForContent('markdown') !== 'text') {
    throw new Error('出口类型按载体推导口径错误');
  }
  const node = { recipeId: 'r1', recipe: { name: '矢量合成', ports: { inputs: [{ label: '力一', type: 'text' }] } } };
  if (w._recipeInputPorts(node).length !== 1 || w._recipeInputPorts({ recipeId: 'r2', recipe: { name: '旧' } }).length !== 0) {
    throw new Error('_recipeInputPorts 快照读取口径错误（无声明应回落空表）');
  }
  // 画布源码契约：连线放宽（配方节点接受任意来源）与具名输入口渲染/喂料分路的插点在位
  const renderSrc = fs.readFileSync('src/static/js/graph-render.js', 'utf8');
  if (!renderSrc.includes("toNode.kind === 'module' && toNode.recipeId) return true")) throw new Error('_canConnect 缺配方节点任意来源放行');
  if (!renderSrc.includes('graph-port-type')) throw new Error('输入口缺类型徽标 DOM');
  const promptSrc = fs.readFileSync('src/static/js/graph-workflow-prompt.js', 'utf8');
  if (!promptSrc.includes('input_port')) throw new Error('喂料分路缺 input_port 标注');
  const applySrc = fs.readFileSync('src/static/js/harness-apply.js', 'utf8');
  if (!applySrc.includes('_nodeBaseInputPortCount')) throw new Error('harness add_edge 未按配方声明数分配附加口');
  return true;
});
// ===== Φ 配方上下文与草稿试用批次用例结束 =====
}
