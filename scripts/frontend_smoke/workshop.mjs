// 节点工坊（2026-10-20，创造模式重做 P0–P4）
// 用例分两类：纯函数契约（不碰 DOM）与工坊状态机（openRecipeWorkshop 在冒烟沙箱里
// 走宽松 DOM 代理，可真实跑渲染路径而不需要真浏览器）。补丁往返是异步的：三条
// 依赖同一份草稿状态的用例（补丁 / 撤回 / 入册）收进一个串行段，避免并发互踩。
//
// 覆盖：空草稿骨架 / 字段路径人话 / 五步进度 / 改名与空名报错 / 输入口缓冲语义 /
// 提示词预算 / 换色清自由色 / 换底座收模块专属段 / 试跑上下文按输入口分栏 /
// 动态出口预览 / 草稿落盘与恢复 / 补丁往返（只改一处、其余不动）＋撤回 /
// 入册（含重名拦）＋源码契约（构建登记与「创造」入口改道）。
import { check, drain, addFailed, vm, sandbox, localStorage, fs } from './_runner.mjs';

const draftKey = 'phymathia_recipe_draft';
const state = () => sandbox._recipeWorkshopState();

function resetWorkshop(clearRecipes) {
  try { sandbox.localStorage.removeItem(draftKey); } catch (e) {}
  if (clearRecipes) {
    try { sandbox.localStorage.removeItem('phymathia_node_recipes'); } catch (e) {}
  }
  // 顶层 let 的绑定不在 window 上，必须经模块自己的清理钩子复位
  sandbox._rwResetForSmoke();
}

export async function run() {
  check('节点工坊：空草稿具备完整配方骨架（归一化前的起点）', () => {
    const empty = sandbox._rwEmptyRecipe();
    ['id', 'name', 'desc', 'base', 'appearance', 'generate', 'ports', 'content_kind', 'aggregation', 'analysis_phase']
      .forEach(key => { if (!(key in empty)) throw new Error('空草稿缺字段：' + key); });
    if (empty.base.kind !== 'module') throw new Error('默认底座应为 module');
    if (empty.generate.context_channel !== 'workflow_context') throw new Error('默认材料通道应为结构化通道');
    if (!Array.isArray(empty.ports.static) || !Array.isArray(empty.ports.inputs)) throw new Error('端口表应为数组');
    return true;
  });

  check('节点工坊：字段路径翻人话（左栏不出现 JSON 术语）', () => {
    const cases = [
      ['name', '名字'],
      ['ports.static[1].label', '第 2 个出口的名字'],
      ['ports.inputs[0].type', '第 1 个输入口的类型'],
      ['generate.prompt', '生成要求'],
      ['appearance.palette', '长相颜色'],
    ];
    cases.forEach(([path, expect]) => {
      const text = sandbox._rwHumanizePath(path);
      if (text !== expect) throw new Error(path + ' 应翻成「' + expect + '」，实际「' + text + '」');
      if (/ports\.|generate\.|appearance\.|\[\d+\]/.test(text)) throw new Error(path + ' 的人话里还带字段名');
    });
    return true;
  });

  check('节点工坊：体检能数出步骤/公式/复述/太短（纯结构判定，不调模型）', () => {
    resetWorkshop(true);
    sandbox.openRecipeWorkshop({
      recipe: {
        name: '体检样例', base: { kind: 'module' },
        generate: { prompt: '你在做受力分析。' },
        ports: { static: [{ label: '步骤', drag_form: 'draft' }, { label: '检查', drag_form: 'draft' }], inputs: [] },
        appearance: { palette: 'amber' }, content_kind: 'markdown',
      },
    });
    if (typeof sandbox.rwAutoTune !== 'function') throw new Error('「帮我调好」入口没导出到 window');
    const state_ = state();
    state_.materials = { general: '一个质量 m 的物块放在倾角 θ 的斜面上，求加速度并检查结果。' };
    const bad = sandbox._rwJudgeOutput('好的，我来分析一下。', state_.recipe);
    if (bad.pass) throw new Error('过短又没步骤的输出不该判通过');
    const badKeys = bad.flags.map(flag => flag.key);
    if (badKeys.indexOf('short') < 0) throw new Error('应判「太短」，实际：' + badKeys.join(','));
    if (badKeys.indexOf('steps') < 0) throw new Error('两个出口却没步骤，应判「没分步骤」');
    const goodText = '第一步 研究对象\n取物块为研究对象，沿斜面方向建系，斜面方向为 x、垂直斜面为 y。\n'
      + '第二步 列方程\n垂直方向 $N = mg\cos\theta$，沿斜面方向 $mg\sin\theta = ma$，所以 $a = g\sin\theta$。\n'
      + '第三步 检查\n当 θ=90° 时 $a=g$，与自由落体一致；有摩擦时把 $mg\cos\theta$ 乘摩擦因数加进方程，量纲仍是加速度。';
    const good = sandbox._rwJudgeOutput(goodText, state_.recipe);
    if (!good.pass) throw new Error('合格输出被误判：' + good.flags.map(flag => flag.label).join('、'));
    if (good.metrics.steps < 3 || good.metrics.tex < 3) throw new Error('步骤/公式没数对：' + JSON.stringify(good.metrics));
    const tex = sandbox._rwJudgeOutput('用 \\frac{1}{2}mv^2 和 \\sqrt{2gh} 还有 \\theta 就能算出结果，代进去即可得到答案，注意单位。', state_.recipe);
    if (!tex.flags.some(flag => flag.key === 'formula')) throw new Error('三处裸 LaTeX 应判「公式没包」');
    const echo = sandbox._rwJudgeOutput('一个质量 m 的物块放在倾角 θ 的斜面上，求加速度并检查结果。' + goodText, state_.recipe);
    if (!echo.flags.some(flag => flag.key === 'echo')) throw new Error('开头复述材料应判「复述输入」');
    resetWorkshop(true);
    return true;
  });

  check('节点工坊：体检认得加粗/标题/全角括号/列表这些常见步骤写法（T404）', () => {
    resetWorkshop(true);
    sandbox.openRecipeWorkshop({
      recipe: {
        name: '步骤写法样例', base: { kind: 'module' },
        generate: { prompt: '你在做受力分析。' },
        ports: { static: [{ label: '步骤', drag_form: 'draft' }, { label: '检查', drag_form: 'draft' }], inputs: [] },
        appearance: { palette: 'amber' }, content_kind: 'markdown',
      },
    });
    const state_ = state();
    const fill = '取物块为研究对象，沿斜面方向建系，垂直斜面方向合力为零，沿斜面列方程后代入数值，最后做量纲与边界检查。';
    const variants = {
      '加粗': '**第一步** 研究对象\n' + fill + '\n**第二步** 列方程\n' + fill,
      '标题': '### 第一步 研究对象\n' + fill + '\n### 第二步 列方程\n' + fill,
      '全角括号': '（1）研究对象：' + fill + '\n（2）列方程：' + fill,
      '列表接步骤': '- 第一步 研究对象\n' + fill + '\n- 第二步 列方程\n' + fill,
    };
    Object.keys(variants).forEach(name => {
      const judge = sandbox._rwJudgeOutput(variants[name], state_.recipe);
      if (judge.metrics.steps < 2) throw new Error(name + ' 写法没数到步骤（实际 ' + judge.metrics.steps + '），会被误判「没分步骤」');
      if (judge.flags.some(flag => flag.key === 'steps')) throw new Error(name + ' 写法不该亮「没分步骤」');
    });
    // 反向：加粗但不是步骤开头，不该被装饰骗到
    const noStep = sandbox._rwJudgeOutput('**注意**：解题前先统一单位。\n' + fill, state_.recipe);
    if (noStep.metrics.steps !== 0) throw new Error('普通加粗段首被误数成步骤（实际 ' + noStep.metrics.steps + '）');
    resetWorkshop(true);
    return true;
  });

  check('节点工坊：动态出口体检解析失败会亮、成功不亮（T405）', () => {
    resetWorkshop(true);
    sandbox.openRecipeWorkshop({
      recipe: {
        name: '苏格拉底式', base: { kind: 'module' },
        generate: { prompt: '你在出追问。' },
        ports: {
          static: [{ label: '追问', drag_form: 'draft' }],
          dynamic: {
            parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶'], max: 6, label_from: 'index_question' },
            fallback: { mode: 'label_questions_from_text', labels: [] },
            each: { type: 'socratic', branch_type: 'socratic', drag_form: 'draft' },
          },
        },
        appearance: { palette: 'amber' }, content_kind: 'markdown',
      },
    });
    const state_ = state();
    const parsedText = '围绕这道斜面题，先看清对象再问条件，别急着代公式。\n1. [基础] 为什么物块会加速？\n2. [进阶] 如果斜面有摩擦，加速度怎么变？';
    const goodJudge = sandbox._rwJudgeOutput(parsedText, state_.recipe);
    if (goodJudge.flags.some(flag => flag.key === 'ports')) throw new Error('解析出两条编号行，不该亮「出口没解析出来」');
    if (goodJudge.metrics.dynamicPorts !== 2) throw new Error('metrics.dynamicPorts 应记 2，实际 ' + JSON.stringify(goodJudge.metrics));
    const fellBackText = '围绕这道斜面题说了很长的一段话，把对象和条件都描述了一遍，但是全文没有一行编号，动态出口解析不到任何问题，兜底出口顶上来充数，这种输出应该被亮出来提醒模型补编号。';
    const badJudge = sandbox._rwJudgeOutput(fellBackText, state_.recipe);
    if (!badJudge.flags.some(flag => flag.key === 'ports')) throw new Error('没有编号行应亮「出口没解析出来」（修前读不存在的 enabled 键，这项永不触发）');
    if (badJudge.metrics.dynamicPorts !== 0) throw new Error('解析失败应记 0，实际 ' + badJudge.metrics.dynamicPorts);
    // 没开动态出口的配方：不亮 ports、记 -1（口径钉死，C 的判决函数直接读这个数）
    const plainJudge = sandbox._rwJudgeOutput('正文随便写点什么，没有动态出口。', { name: 'x', base: { kind: 'module' }, ports: { static: [] }, content_kind: 'markdown' });
    if (plainJudge.flags.some(flag => flag.key === 'ports')) throw new Error('没开动态出口不该亮 ports');
    if (plainJudge.metrics.dynamicPorts !== -1) throw new Error('没开动态出口应记 -1，实际 ' + plainJudge.metrics.dynamicPorts);
    resetWorkshop(true);
    return true;
  });

  resetWorkshop(true);
  sandbox.openRecipeWorkshop({});

  check('节点工坊：打开后五步进度条成型，未填名字时第一步待定', () => {
    if (!state()) throw new Error('工坊状态没建起来');
    const steps = sandbox._rwSteps();
    if (steps.length !== 5) throw new Error('步骤应为 5 步，实际 ' + steps.length);
    if (steps.map(s => s.id).join(',') !== 'name,inputs,outputs,run,save') throw new Error('步骤顺序不对：' + steps.map(s => s.id).join(','));
    if (steps[0].state !== 'todo') throw new Error('没名字时第一步应为待定');
    return true;
  });

  check('节点工坊：改名即时生效，清空名字挂字段错误而不是吞掉输入', () => {
    sandbox.rwEditName('受力分析');
    if (state().recipe.name !== '受力分析') throw new Error('名字没写进草稿');
    if (sandbox._rwSteps()[0].state !== 'done') throw new Error('有名字后第一步应打勾');
    sandbox.rwEditName('');
    const errors = state().fieldErrors || [];
    if (!errors.some(item => item.field === 'name')) throw new Error('空名字应挂在 name 字段上，实际：' + JSON.stringify(errors));
    sandbox.rwEditName('受力分析');
    return true;
  });

  check('节点工坊：输入口是编辑缓冲——空行留在缓冲里、命名后才进配方', () => {
    sandbox.rwAddPort('inputs');
    if (state().inputRows.length !== 1) throw new Error('缓冲里应有一行空输入口（点＋不该立刻消失）');
    const ports = (state().recipe.ports && state().recipe.ports.inputs) || [];
    if (ports.length !== 0) throw new Error('空标签的行不该进配方');
    sandbox.rwPortLabel('inputs', 0, '题目');
    const filled = state().recipe.ports.inputs || [];
    if (filled.length !== 1 || filled[0].label !== '题目') throw new Error('命名后应进配方，实际：' + JSON.stringify(filled));
    sandbox.rwPortType('inputs', 0, 'text');
    if (state().recipe.ports.inputs[0].type !== 'text') throw new Error('输入口类型没落进配方');
    return true;
  });

  check('节点工坊：提示词超预算立刻挂红（≤800 字硬预算）', () => {
    sandbox.rwEditPrompt('prompt', '很长的要求'.repeat(300));
    const errors = state().fieldErrors || [];
    if (!errors.some(item => item.field === 'generate.prompt')) throw new Error('超 800 字应挂 generate.prompt，实际：' + JSON.stringify(errors.map(e => e.field)));
    sandbox.rwEditPrompt('prompt', '按步骤输出，每步给出依据。');
    const again = state().fieldErrors || [];
    if (again.some(item => item.field === 'generate.prompt')) throw new Error('改回预算内后红框应消失');
    return true;
  });

  check('节点工坊：换色板会清掉自由色（否则点了没反应）', () => {
    sandbox.rwEditColor('#ff8800');
    if (state().recipe.appearance.color !== '#ff8800') throw new Error('自由色没落下');
    sandbox.rwPickPalette('teal');
    if (state().recipe.appearance.palette !== 'teal') throw new Error('色板没切到 teal');
    if (state().recipe.appearance.color) throw new Error('选色板后应清掉自由色');
    return true;
  });

  check('节点工坊：换底座会收掉只有模块能用的段（动态出口/双阶段）', () => {
    sandbox.rwEditBase('module');
    sandbox.rwToggleDynamic();
    if (!state().recipe.ports.dynamic) throw new Error('动态出口没打开');
    sandbox.rwToggleAnalysis(true);
    if (state().recipe.analysis_phase !== true) throw new Error('双阶段没打开');
    sandbox.rwEditBase('note');
    if (state().recipe.ports.dynamic) throw new Error('非模块底座不该留动态出口');
    if (state().recipe.analysis_phase) throw new Error('非模块底座不该留双阶段');
    if (state().recipe.aggregation !== 'none') throw new Error('手填底座的取材应为 none，实际 ' + state().recipe.aggregation);
    sandbox.rwEditBase('module');
    return true;
  });

  check('节点工坊：试跑上下文按输入口分栏（与真接线喂料同形状）', () => {
    sandbox.rwEditName('受力分析');
    sandbox.rwPortLabel('inputs', 0, '题目');
    sandbox.rwMaterialChanged('in-0', '一个木块在斜面上滑下');
    const recipe = { ...state().recipe };
    const wf = sandbox._rwBuildWorkflowContext(recipe);
    if (wf.upstream.length !== 1) throw new Error('应有一条材料，实际 ' + wf.upstream.length);
    if (wf.upstream[0].input_port !== '题目') throw new Error('材料应标着输入口名');
    if (!wf.upstream[0].content.includes('木块')) throw new Error('材料正文没带上');
    if (wf.upstream[0].input_type !== '文本') throw new Error('材料应带上输入口的类型');
    if (wf.target.label !== '受力分析') throw new Error('目标名没带上');
    return true;
  });

  check('节点工坊：没有输入口时退成一栏材料（旧配方口径）', () => {
    const bare = { name: '随手节点', ports: { static: [] }, base: { kind: 'module' } };
    sandbox.rwMaterialChanged('general', '贴一道题');
    const wf = sandbox._rwBuildWorkflowContext(bare);
    if (wf.upstream.length !== 1) throw new Error('应有一条通用材料');
    if (wf.upstream[0].label !== '材料') throw new Error('无具名口时标签应为「材料」');
    return true;
  });

  check('节点工坊：试跑出口预览——动态出口按正文长出来，无动态时回静态出口', () => {
    const recipe = {
      name: '苏格拉底式',
      base: { kind: 'module' },
      ports: {
        static: [{ label: '追问', drag_form: 'draft' }],
        dynamic: {
          parser: { pattern: 'numbered_list', level_tags: ['基础', '进阶'], max: 6, label_from: 'index_question' },
          fallback: { mode: 'label_questions_from_text', labels: [] },
          each: { type: 'socratic', branch_type: 'socratic', drag_form: 'draft' },
        },
      },
      content_kind: 'markdown',
    };
    const content = ['这里是正文。', '1. [基础] 为什么物块会加速？', '2. [进阶] 如果斜面有摩擦呢？'].join('\n');
    const dynamic = sandbox._rwComputeOutputPorts(recipe, content);
    if (dynamic.length !== 2) throw new Error('应长出 2 个动态出口，实际 ' + dynamic.length);
    if (!dynamic[0].dynamic) throw new Error('动态出口应打 dynamic 标记');
    const plain = sandbox._rwComputeOutputPorts({ name: 'x', base: { kind: 'module' }, ports: { static: [{ label: '步骤', drag_form: 'draft' }] }, content_kind: 'markdown' }, '正文');
    if (plain.length !== 1 || plain[0].label !== '步骤') throw new Error('无动态声明应回静态出口');
    return true;
  });

  check('节点工坊：草稿落盘并在重开后接上（刷新页面不丢）', () => {
    sandbox.rwEditName('受力分析');
    sandbox._rwSaveDraftNow();
    const raw = sandbox.localStorage.getItem(draftKey);
    if (!raw) throw new Error('草稿没落盘');
    const data = JSON.parse(raw);
    if (data.recipe.name !== '受力分析') throw new Error('落盘的不是当前草稿');
    sandbox.closeRecipeWorkshop();
    sandbox._rwResetForSmoke();
    sandbox.openRecipeWorkshop({});
    if (state().recipe.name !== '受力分析') throw new Error('重开后没接上草稿');
    const restoredMsg = (state().conversation || []).some(item => String(item.text || '').indexOf('接上了') >= 0);
    if (!restoredMsg) throw new Error('接上草稿时应在左栏说一声');
    return true;
  });

  check('节点工坊：源码契约——构建已登记、创造入口已改道、旧对话留窄口', () => {
    const build = fs.readFileSync('scripts/build_frontend.mjs', 'utf8');
    if (!build.includes("'graph-workshop.js'")) throw new Error('graph-workshop.js 没登记进构建 entries（会静默不进包）');
    const harnessSrc = fs.readFileSync('src/static/js/harness.js', 'utf8');
    if (!/id === 'preset'[\s\S]{0,160}openRecipeWorkshop/.test(harnessSrc)) throw new Error('模式「创造」没有改道工坊');
    if (!/opts && opts\.legacy/.test(harnessSrc)) throw new Error('旧创造对话的窄口丢了（P5 前必须保留）');
    const menuSrc = fs.readFileSync('src/static/js/graph-contextmenu.js', 'utf8');
    if (!menuSrc.includes('用配方工坊改')) throw new Error('右键「用配方工坊改」入口丢了');
    const editSrc = fs.readFileSync('src/static/js/graph-recipe-edit.js', 'utf8');
    if (!editSrc.includes('openRecipeWorkshopForRecipe')) throw new Error('配方管理列表的「工坊里改」入口丢了');
    // 样式契约（2026-10-20 真机踩过）：注释里写了「--text-*/」这种半截注释会把
    // 注释提前闭合，紧跟着的 .rw-overlay 规则被当成垃圾一起吞掉——工作台因此
    // 变成文档流里的普通 div（被画布盖住、点不动），而冒烟全绿。两道闸：
    const cssSrc = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
    const opens = (cssSrc.match(/\/\*/g) || []).length;
    const closes = (cssSrc.match(/\*\//g) || []).length;
    if (opens !== closes) throw new Error('styles-panels.css 注释开闭不配平（' + opens + ' /* vs ' + closes + ' */），会把后面的规则吞掉');
    const overlayRule = /\.rw-overlay\s*\{[^}]*position:\s*fixed/.test(cssSrc);
    if (!overlayRule) throw new Error('工坊遮罩的 position: fixed 丢了（会被画布盖住、点不动）');
    if (!/\.rw-overlay\s*\{[^}]*z-index:\s*var\(--z-panel-top\)/.test(cssSrc)) throw new Error('工坊遮罩层级必须是 --z-panel-top（低了会被 Φ 桌宠窗口挡住）');
    return true;
  });

  check('节点工坊：空白进来默认一句话档，切手动调不丢草稿', () => {
    resetWorkshop(true);
    sandbox.openRecipeWorkshop({});
    if (state().mode !== 'smart') throw new Error('空白进来应默认一句话档，实际 ' + state().mode);
    sandbox.rwSetMode('manual');
    if (state().mode !== 'manual') throw new Error('切手动档失败');
    sandbox.rwEditName('模式切换测试');
    sandbox.rwSetMode('smart');
    if (state().mode !== 'smart') throw new Error('切回一句话档失败');
    if (state().recipe.name !== '模式切换测试') throw new Error('切档把正在改的草稿弄丢了');
    sandbox.rwSetMode('manual');
    if (state().recipe.name !== '模式切换测试') throw new Error('手动档没有接上同一份草稿');
    // 下游串行段沿用「受力分析」这份草稿，这里把名字还回去，别让模式用例把后面的断言带偏
    sandbox.rwEditName('受力分析');
    return true;
  });

  check('节点工坊：外观回归契约——预览卡不进滚动层、中栏不出横向滚动条、一句话档在', () => {
    const src = fs.readFileSync('src/static/js/graph-workshop.js', 'utf8');
    // 卡片必须在 rw-scroll 之外（2026-10-22：sticky 卡片把「名字」一行压在底下、字被渐变洗白）
    const cardAt = src.indexOf("'<div class=\"rw-card\" id=\"rwCard\"></div>'");
    const scrollAt = src.indexOf("'<div class=\"rw-scroll\" id=\"rwScroll\">'");
    if (cardAt < 0 || scrollAt < 0) throw new Error('壳结构被改了：找不到 rwCard / rwScroll 的静态片段');
    if (cardAt > scrollAt) throw new Error('预览卡又回到滚动层里了（会盖住字段）');
    const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
    if (/\.rw-card\s*\{[^}]*position:\s*sticky/.test(css)) throw new Error('.rw-card 又写成 sticky 了（会浮在字段上面）');
    if (!/\.rw-scroll\s*\{[^}]*overflow-x:\s*hidden/.test(css)) throw new Error('.rw-scroll 缺 overflow-x: hidden（中栏会长出横向滚动条）');
    if (!/\.rw-smart\s*\{/.test(css)) throw new Error('一句话档的样式丢了（.rw-smart）');
    if (!/\.rw-shell\[data-mode="smart"\]\s+\.rw-body\s*\{\s*display:\s*none/.test(css)) throw new Error('两档切换规则丢了（data-mode=smart 时不该再显示三栏）');
    if (typeof sandbox.rwSmartGenerate !== 'function' || typeof sandbox.rwSetMode !== 'function') throw new Error('一句话档的入口没导出到 window');
    return true;
  });

  check('节点工坊：一句话档带试跑入口，没试跑过的默认路径不再直通画布', () => {
    const src = fs.readFileSync('src/static/js/graph-workshop.js', 'utf8');
    if (!/onclick="rwSmartTrial\(\)"/.test(src)) throw new Error('一句话档结果卡上没有「试跑一下」按钮');
    if (!/window\.rwSmartTrial = rwSmartTrial/.test(src)) throw new Error('rwSmartTrial 没导出到 window');
    if (!/recipeId: String\(recipe\.id \|\| ''\)/.test(src)) throw new Error('试跑记录没盖配方 id 章（放到画布软闸会认不出试跑过）');
    return true;
  });

  // ---- 串行段：补丁往返 → 撤回 → 入册（同一份草稿状态，必须按序）----
  const originalFetch = sandbox.fetch;
  const originalModel = sandbox.getActiveModelForRole;
  sandbox.getActiveModelForRole = () => ({ provider: 'opencode', apiKey: '', model: 'mock-workshop', baseUrl: 'https://example.invalid' });

  // 先把两个出口摆好，再让「服务端」回一份只改了第二个出口的草稿
  sandbox.rwAddPort('outputs');
  sandbox.rwPortLabel('outputs', 0, '步骤');
  sandbox.rwAddPort('outputs');
  sandbox.rwPortLabel('outputs', 1, '检查');
  const beforePrompt = state().recipe.generate.prompt;
  const serverRecipe = JSON.parse(JSON.stringify(state().recipe));
  serverRecipe.ports.static = [{ label: '步骤', drag_form: 'draft' }, { label: '再测一道', drag_form: 'draft' }];
  sandbox.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      status: 'ok',
      say: '只改了第二个出口的名字',
      mode: 'patch',
      recipe: serverRecipe,
      changed: ['ports.static[1].label'],
      question: null,
      warnings: [],
      field_errors: [],
    }),
  });

  const serialCases = [
    ['只动它改的那一处，其余字段一字不动', async () => {
      const data = await sandbox._rwRequestDraft('第二个出口改成「再测一道」');
      if (!data || data.status !== 'ok') throw new Error('补丁往返失败');
      const recipe = state().recipe;
      if (recipe.ports.static[1].label !== '再测一道') throw new Error('第二个出口没改名');
      if (recipe.generate.prompt !== beforePrompt) throw new Error('没被提到的提示词被冲掉了（补丁式失效）');
      if (recipe.name !== '受力分析') throw new Error('名字被冲掉了');
      if (state().undoStack.length !== 1) throw new Error('应留下一条可撤回快照');
      const said = (state().conversation || []).slice(-3).some(item => String(item.text || '').indexOf('第二个出口的名字') >= 0);
      if (!said) throw new Error('左栏应把那句话显示出来');
      return true;
    }],
    ['撤回这次改动把草稿还原', async () => {
      sandbox.rwUndoAi();
      if (state().recipe.ports.static[1].label !== '检查') throw new Error('撤回后第二个出口应回到旧名');
      if (state().undoStack.length !== 0) throw new Error('撤回后快照栈应清空');
      return true;
    }],
    ['AI 底座空提示词时入册自动起草生成要求', async () => {
      const name = '空提示词节点' + (Date.now() % 100000);
      sandbox.openRecipeWorkshop({
        recipe: {
          name: name, base: { kind: 'module' },
          ports: { static: [{ label: '步骤', drag_form: 'draft' }], inputs: [] },
          appearance: { palette: 'amber' }, content_kind: 'markdown',
        },
      });
      const ok = sandbox.rwSaveRecipe();
      if (!ok) throw new Error('空提示词 + AI 底座应该能入册（自动起草一版）');
      const saved = sandbox.getUserRecipes().filter(item => item.name === name)[0];
      if (!saved || String(saved.generate.prompt || '').length < 20) throw new Error('自动起草的提示词没落库');
      if (String(saved.generate.prompt).length > 800) throw new Error('自动起草超了 800 字预算');
      return true;
    }],
    ['入册后草稿键被清空且不会被写回', async () => {
      if (sandbox.localStorage.getItem(draftKey)) throw new Error('入册后草稿键还在（500ms 防抖把旧草稿写回来了）');
      return true;
    }],
    ['从画布节点拉进工坊是另存草稿（id 不撞原配方）', async () => {
      const original = sandbox.getUserRecipes()[0];
      const fakeNode = {
        id: 'ws-fake-node',
        kind: 'module',
        label: original.name,
        recipeId: original.id,
        recipe: { id: original.id, name: original.name, base: { kind: 'module' }, appearance: { palette: 'amber' }, generate: { prompt: 'x' }, ports: { static: [] }, content_kind: 'markdown' },
      };
      // 注意：冒烟沙箱里 window 是宽松代理，不是 global——模块里的裸调用读的是
      // sandbox 上的同名属性，桩必须打在 sandbox 上（打在 window 上永远读不到）
      const previous = sandbox.getGraphViewNodes;
      sandbox.getGraphViewNodes = () => [fakeNode];
      try {
        sandbox.openRecipeWorkshopForNode('ws-fake-node');
        const st = sandbox._recipeWorkshopState();
        if (!st || !st.recipe) throw new Error('没拉起来');
        if (st.recipe.name !== original.name) throw new Error('名字没带过来');
        if (st.recipe.id === original.id) throw new Error('拉进来应该是另存的草稿（id 必须不同）');
      } finally {
        sandbox.getGraphViewNodes = previous;
      }
      return true;
    }],
    ['入册写进配方库，重名被拦下', async () => {
      sandbox.rwEditName('工坊测试配方');
      const ok = sandbox.rwSaveRecipe();
      if (!ok) throw new Error('入册失败');
      const list = sandbox.getUserRecipes();
      if (!list.some(item => item.name === '工坊测试配方')) throw new Error('配方库里没有新配方');
      if (!state().savedName) throw new Error('入册后应记下已保存状态');
      sandbox.openRecipeWorkshop({
        recipe: {
          name: '工坊测试配方', base: { kind: 'module' }, generate: { prompt: 'x' },
          ports: { static: [{ label: '出口', drag_form: 'draft' }], inputs: [] },
          appearance: { palette: 'amber' }, content_kind: 'markdown',
        },
      });
      const dup = sandbox.rwSaveRecipe();
      if (dup) throw new Error('重名配方不该入册成功');
      const errors = state().fieldErrors || [];
      if (!errors.some(item => item.field === 'name')) throw new Error('重名错误应挂在名字上');
      return true;
    }],
    ['一句话档：第一句整份起草，第二句走补丁（同一份草稿）', async () => {
      const prevFetch = sandbox.fetch;
      try {
        resetWorkshop(false);
        sandbox.openRecipeWorkshop({});
        state().smartInstruction = '做一个受力分析节点，喂一道题和受力图，出口给换个条件';
        const firstRecipe = {
          id: 'recipe-smart-' + Date.now(), name: '智能档测试节点', desc: '喂题和图，拆受力与方程',
          base: { kind: 'module' },
          ports: { inputs: [{ label: '题目', type: 'text' }], static: [{ label: '换个条件', drag_form: 'draft' }] },
          generate: { prompt: '你在做受力分析：先研究对象，再列方程。' },
          appearance: { palette: 'blue' }, content_kind: 'markdown',
        };
        let sent = null;
        sandbox.fetch = async (url, init) => {
          sent = JSON.parse(init.body);
          return {
            ok: true, status: 200,
            json: async () => ({
              status: 'ok', say: '配好了：喂题目，出口「换个条件」', mode: sent.mode, recipe: firstRecipe,
              changed: [], question: null, warnings: [], field_errors: [],
            }),
          };
        };
        await sandbox.rwSmartGenerate();
        if (!state().smartDone) throw new Error('生成成功后应进入「已配好」状态');
        if (sent.mode !== 'draft') throw new Error('第一句应从零起草（draft），实际 ' + sent.mode);
        if (state().recipe.name !== '智能档测试节点') throw new Error('模型给的配方没进草稿');
        if (!state().smartSay) throw new Error('应记下模型那句人话说明');
        const secondRecipe = JSON.parse(JSON.stringify(state().recipe));
        secondRecipe.ports.static.push({ label: '解释假设', drag_form: 'draft' });
        state().smartInstruction = '出口再加一个解释假设';
        sandbox.fetch = async (url, init) => {
          sent = JSON.parse(init.body);
          return {
            ok: true, status: 200,
            json: async () => ({
              status: 'ok', say: '加了一个出口', mode: 'patch', recipe: secondRecipe,
              changed: ['ports.static[1].label'], question: null, warnings: [], field_errors: [],
            }),
          };
        };
        await sandbox.rwSmartGenerate();
        if (sent.mode !== 'patch') throw new Error('第二轮应走补丁（patch），实际 ' + sent.mode);
        if (!sent.draft || sent.draft.name !== '智能档测试节点') throw new Error('补丁请求没带上当前草稿');
        if (!state().recipe.ports.static.some(port => port.label === '解释假设')) throw new Error('补丁没合进草稿');
        return true;
      } finally {
        sandbox.fetch = prevFetch;
        resetWorkshop(true);
      }
    }],
    ['「帮我调好」：跑一次 → 体检 → 只改有问题的一处 → 复跑验证', async () => {
      resetWorkshop(true);
      sandbox.openRecipeWorkshop({
        recipe: {
          name: '调优样例', base: { kind: 'module' },
          generate: { prompt: '你在做受力分析。' },
          ports: { static: [{ label: '步骤', drag_form: 'draft' }, { label: '检查', drag_form: 'draft' }], inputs: [] },
          appearance: { palette: 'amber' }, content_kind: 'markdown',
        },
      });
      state().materials = { general: '一个质量 m 的物块放在倾角 θ 的斜面上，求加速度。' };
      const prev = {
        proxy: sandbox.proxyChatWithModel,
        sse: sandbox._sseContentFrames,
        fetch: sandbox.fetch,
        confirm: sandbox.confirm,
        markdown: sandbox.renderMarkdown,
      };
      let runs = 0;
      let sentBody = null;
      try {
        sandbox.confirm = () => true;
        // 沙箱里没有 marked（宽松 DOM 代理不跑真渲染），正文渲染用一个占位实现
        sandbox.renderMarkdown = () => '<p>（渲染省略）</p>';
        sandbox.proxyChatWithModel = async () => ({ ok: true, status: 200, body: {} });
        sandbox._sseContentFrames = async function* () {
          runs += 1;
          if (runs === 1) {
            yield '好的，这个题我们来看看。';
            return;
          }
          yield '第一步 研究对象\n取物块为研究对象，沿斜面方向建系，斜面方向为 x、垂直斜面为 y。\n';
          yield '第二步 列方程\n垂直方向 $N = mg\\cos\\theta$，沿斜面方向 $mg\\sin\\theta = ma$，所以 $a = g\\sin\\theta$。\n';
          yield '第三步 检查\n当 θ=90° 时 $a=g$；有摩擦时把 $mg\\cos\\theta$ 乘摩擦因数加进方程，量纲仍是加速度。';
        };
        sandbox.fetch = async (url, init) => {
          sentBody = JSON.parse(init.body);
          const recipe = JSON.parse(JSON.stringify(state().recipe));
          recipe.generate.prompt = String(recipe.generate.prompt || '') + '\n分步输出，公式用 $…$ 包起来。';
          return {
            ok: true, status: 200,
            json: async () => ({
              status: 'ok', say: '补了分步与公式要求', mode: 'patch', recipe: recipe,
              changed: ['generate.prompt'], question: null, warnings: [], field_errors: [],
            }),
          };
        };
        await sandbox.rwAutoTune();
        if (runs !== 2) throw new Error('应跑两次（先体检、改完复跑），实际 ' + runs + ' 次');
        if (!sentBody) throw new Error('自动调优没有发起补丁请求');
        if (sentBody.mode !== 'patch') throw new Error('自动调优必须走补丁（走 draft 会冲掉已配好的字段），实际 ' + sentBody.mode);
        if (String(sentBody.instruction).indexOf('体检') < 0) throw new Error('补丁指令没带体检结果');
        if (!state().judge) throw new Error('复跑后应留下体检结果');
        if (!state().judge.pass) throw new Error('复跑的输出应判通过，实际：' + state().judge.flags.map(flag => flag.label).join('、'));
        const chat = (state().conversation || []).map(item => String(item.text || '')).join('\n');
        if (chat.indexOf('体检') < 0) throw new Error('左栏没把体检结果说出来');
        if (String(state().recipe.generate.prompt).indexOf('分步输出') < 0) throw new Error('补丁没落到生成要求上');
        return true;
      } finally {
        sandbox.proxyChatWithModel = prev.proxy;
        sandbox._sseContentFrames = prev.sse;
        sandbox.fetch = prev.fetch;
        sandbox.confirm = prev.confirm;
        sandbox.renderMarkdown = prev.markdown;
        resetWorkshop(true);
      }
    }],
    ['一句话档：试跑入口切手动档——材料空只引导不空跑，材料齐走同一条试跑链', async () => {
      resetWorkshop(false);
      sandbox.openRecipeWorkshop({
        recipe: {
          name: '智能档试跑节点', base: { kind: 'module' },
          generate: { prompt: '你在做受力分析：分步输出。' },
          ports: { static: [{ label: '换个条件', drag_form: 'draft' }], inputs: [] },
          appearance: { palette: 'amber' }, content_kind: 'markdown',
        },
        mode: 'smart',
      });
      const st = state();
      st.smartDone = true;
      await sandbox.rwSmartTrial();
      if (st.mode !== 'manual') throw new Error('试跑入口应切到手动档（材料与输出都住在那侧），实际 ' + st.mode);
      if (st.running || (st.runs || []).length) throw new Error('材料还空着不该发起生成（空跑）');
      const prev = { proxy: sandbox.proxyChatWithModel, sse: sandbox._sseContentFrames, markdown: sandbox.renderMarkdown };
      try {
        sandbox.renderMarkdown = () => '<p>（渲染省略）</p>';
        sandbox.proxyChatWithModel = async () => ({ ok: true, status: 200, body: {} });
        sandbox._sseContentFrames = async function* () {
          yield '第一步 研究对象\n取物块为研究对象，沿斜面方向建系。\n';
          yield '第二步 列方程\n沿斜面 $mg\\sin\\theta = ma$，所以 $a = g\\sin\\theta$。\n';
          yield '第三步 检查\n当 θ=90° 时 $a=g$，与自由落体一致。';
        };
        st.materials = { general: '一个质量 m 的物块放在倾角 θ 的斜面上，求加速度。' };
        await sandbox.rwSmartTrial();
        if ((st.runs || []).length !== 1) throw new Error('材料齐了应真跑一次，实际 ' + (st.runs || []).length + ' 次');
        if (st.runs[0].recipeId !== String(st.recipe.id || '')) throw new Error('试跑记录没盖配方 id 章，放到画布软闸会认不出试跑过');
        if (!st.judge) throw new Error('试跑结束应留下体检结果');
      } finally {
        sandbox.proxyChatWithModel = prev.proxy;
        sandbox._sseContentFrames = prev.sse;
        sandbox.renderMarkdown = prev.markdown;
        resetWorkshop(true);
      }
    }],
    ['一句话档：没试跑过放画布被软闸拦一次，试跑过就放行不再问', async () => {
      resetWorkshop(true);
      sandbox.openRecipeWorkshop({
        recipe: {
          name: '软闸测试节点' + (Date.now() % 100000), base: { kind: 'module' },
          generate: { prompt: '你在做受力分析：分步输出。' },
          ports: { static: [{ label: '换个条件', drag_form: 'draft' }], inputs: [] },
          appearance: { palette: 'amber' }, content_kind: 'markdown',
        },
        mode: 'smart',
      });
      const st = state();
      st.smartDone = true;
      const prev = { confirm: sandbox.confirm, place: sandbox.rwPlaceOnCanvas };
      let confirms = 0;
      let placed = 0;
      try {
        sandbox.confirm = () => { confirms += 1; return false; };
        sandbox.rwPlaceOnCanvas = () => { placed += 1; };
        sandbox.rwSmartPlace();
        if (confirms !== 1) throw new Error('没试跑过应先问一次（可以坚持放），实际问 ' + confirms + ' 次');
        if (placed) throw new Error('取消后不该放到画布');
        // 盖一个「这份配方跑过」的章（试跑链上一条用例已真验过，这里只验软闸认章放行）
        st.runs = [{ at: Date.now(), recipeId: String(st.recipe.id || '') }];
        sandbox.rwSmartPlace();
        if (confirms !== 1) throw new Error('试跑过之后不该再拦（软闸只问一次），实际问 ' + confirms + ' 次');
        if (placed !== 1) throw new Error('试跑过之后应直接放行');
      } finally {
        sandbox.confirm = prev.confirm;
        sandbox.rwPlaceOnCanvas = prev.place;
        resetWorkshop(true);
      }
    }],
  ];

  check('节点工坊：补丁往返 / 撤回 / 入册（串行段）', async () => {
    try {
      for (const [label, fn] of serialCases) {
        try {
          await fn();
          console.log('✓', '节点工坊·串行：' + label);
        } catch (err) {
          addFailed();
          console.error('❌', '节点工坊·串行：' + label, '->', (err && err.message) || err);
        }
      }
      return true;
    } finally {
      sandbox.fetch = originalFetch;
      sandbox.getActiveModelForRole = originalModel;
      resetWorkshop(true);
    }
  });

  await drain();
}
