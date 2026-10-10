// ====== 首次使用引导 + 内置示例图讲解（2026-10-10 自 ui.js 拆出，T261 纯搬家）=====
// ob_smoke.mjs 按下方「首次使用引导」标记行切片到文件尾；resize/ESC/load 监听留在 ui.js，
// 运行期回调引用本文件的 _obStep/_renderObStep 等（单脚本拼接，加载完毕后即安全）。
// ====== 首次使用引导 ======
let _obStep = -1;
// T228：当前 click 型步骤绑在目标元素上的 (target, handler)。click 处理器原本只在
// 「自己被点到」时自摘，跳过/换步时残留的监听会继续触发旧 step.onClick()+nextObStep()
// 并 stopPropagation 劫持正常交互；重绑与 endOnboarding 都凭这条记录摘除。
let _obClickBinding = null;
const _isMobile = () => window.innerWidth <= 768;
const ONBOARDING_EXAMPLE_QUESTION = '请解释简谐运动的物理和数学本质，并生成交互式可视化';
const _obSteps = [
  {
    type: 'welcome',
    icon: '<img src="/logo.png" style="width:48px;height:48px;border-radius:12px;" />',
    title: '欢迎来到 PhyMathia',
    features: [
      { icon: UI_ICON_SVG.formula, text: '<strong>双域解释</strong> — 每个问题同时从物理直觉和数学本质给出答案' },
      { icon: UI_ICON_SVG.monitor, text: '<strong>交互可视化</strong> — 生成可动手操作的 HTML 可视化页面' },
      { icon: UI_ICON_SVG.formula, text: '<strong>网络图探索</strong> — 新画布从中心节点开始，答案与模块向外铺展' },
      { icon: UI_ICON_SVG.book, text: '<strong>知识积累</strong> — 自动提取知识点，跨会话长成可探索的「知识大陆」' },
      { icon: UI_ICON_SVG.lightbulb, text: '<strong>Φ 智能体</strong> — 画布上的 AI 助手：改图、答疑，回答前先查知识库' },
    ]
  },
  {
    type: 'welcome',
    example: true,
    icon: UI_ICON_SVG.sparkles,
    title: '内置示例图讲解',
    desc: '打开一张内置的「简谐运动」示例探索网，在<strong>真实画布</strong>上逐步讲解：双击添加节点、端口拖线、节点类型、工具栏、选择编辑和状态显示。',
    exampleQuestion: ONBOARDING_EXAMPLE_QUESTION,
    exampleNote: '演示图不会调用模型，关闭后会恢复你原来的画布。',
    features: [
      { icon: UI_ICON_SVG.pencil, text: '<strong>边点边学</strong> — 聚光灯指到哪，右侧就讲解到哪' },
      { icon: UI_ICON_SVG.monitor, text: '<strong>真实画布</strong> — 可直接拖动、缩放、双击和拉线体验' },
      { icon: UI_ICON_SVG.book, text: '<strong>不产生数据</strong> — 演示改动不会写入当前会话或知识库' },
    ]
  },
  {
    type: 'spotlight',
    get target() { return document.querySelector('.graph-new-session-node') ? '.graph-new-session-node' : '.graph-canvas'; },
    icon: UI_ICON_SVG.pencil,
    get title() { return document.querySelector('.graph-new-session-node') ? '在中心节点提问' : '继续探索'; },
    get desc() {
      return document.querySelector('.graph-new-session-node')
        ? '在画布中央的<strong>中心节点</strong>输入物理或数学问题，答案会从中心向外展开成探索网。'
        : '在探索网中点击气泡上的<strong>追问</strong>、<strong>没看懂</strong>或<strong>删除</strong>，管理当前画布分支。';
    }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.header-secondary-bar' : '.header-actions'; },
    icon: UI_ICON_SVG.sliders,
    title: '个性化设置',
    get desc() {
      return _isMobile()
        ? '顶栏可切换<strong>深色/浅色主题</strong>和<strong>难度等级</strong>；这里可设置<strong>AI 模型</strong>、打开<strong>知识总览</strong>、管理数据和清空画布。'
        : '在这里切换<strong>深色/浅色主题</strong>、选择<strong>AI 模型</strong>和<strong>难度等级</strong>（中学 / 大学 / 科研），点击书本图标打开<strong>知识总览</strong>面板，查看 AI 自动提取的知识点和你收藏的内容。';
    }
  },
  {
    type: 'click',
    target: '.menu-btn',
    icon: UI_ICON_SVG.book,
    title: '试试点击菜单按钮',
    desc: '点击左上角的菜单按钮，打开侧边栏管理<strong>多张画布</strong>，随时切换不同话题。',
    onClick() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'spotlight',
    get target() { return _isMobile() ? '.sidebar-sessions' : '.session-item'; },
    icon: UI_ICON_SVG.pencil,
    title: '个性化画布',
    get desc() {
      return '点击画布图标可以<strong>切换力学、电磁、光学等图标</strong>，点击重命名按钮可以<strong>重命名画布</strong>，让你的画布列表更清晰有序。';
    },
    beforeShow() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'welcome',
    icon: UI_ICON_SVG.layout,
    title: '侧边栏里还有一排工具',
    features: [
      { icon: UI_ICON_SVG.globe, text: '<strong>知识大陆</strong> — 所有画布的知识投影成一张可缩放、可探索的地图' },
      { icon: UI_ICON_SVG.check, text: '<strong>知识检测</strong> — 对本画布出题摸底，「检测总览」汇总所有画布' },
      { icon: UI_ICON_SVG.user, text: '<strong>多账号</strong> — 本机可建多个账号，数据互相隔离，还能只读查阅对方账号' },
      { icon: UI_ICON_SVG.trash, text: '<strong>回收站</strong> — 画布与账号的删除先进站暂存，保留期内随时恢复' },
      { icon: UI_ICON_SVG.download, text: '<strong>导出分享</strong> — PNG 知识海报与 .pmu 快照，外发网页默认只读' },
    ]
  },
  {
    type: 'welcome',
    icon: UI_ICON_SVG.sparkles,
    title: '记忆功能（默认开启）',
    desc: 'PhyMathia 会记住你的<strong>学习画像</strong>（学段、目标、兴趣、薄弱点、回答偏好），让回答风格、出题方向更贴合你。画像仅存本机，可随时关闭或清除。',
    features: [
      { icon: UI_ICON_SVG.check, text: '<strong>个性化</strong> — 回答详略、术语密度、检测出题按你的画像调整' },
      { icon: UI_ICON_SVG.book, text: '<strong>本地存储</strong> — 画像保存在本机；对话内容仍会发送给模型服务商' },
      { icon: UI_ICON_SVG.sliders, text: '<strong>完全可控</strong> — 侧边栏「记忆」中可查看、编辑、删除，也可一键关闭或清除' },
    ]
  }
];

function startOnboarding(force) {
  if (!force && localStorage.getItem(ONBOARDING_KEY)) return;
  _obStep = 0;
  const overlay = document.getElementById('onboardingOverlay');
  overlay.classList.add('active');
  _renderObStep();
}

// ====== 内置示例图讲解：载入演示图，在真实画布上边点边讲 ======
let _exampleGuideStep = 0;
let _exampleGuideOriginal = null;
let _exampleGuideDemoState = null;
let _exampleGuideSuspendedOnboarding = false;
let _exampleGuideLastPanelSide = null;
let _exampleGuideSpotlightRaf = 0;

const EXAMPLE_GUIDE_VIZ_HTML = [
  '<!DOCTYPE html>',
  '<html lang="zh-CN">',
  '<head><meta charset="UTF-8"><style>',
  ':root{color-scheme:dark}',
  'html,body{margin:0;padding:0;background:transparent;color:%VIZ_TEXT%;font-family:"Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
  'body{padding:12px}',
  'h3{margin:0 0 6px;font-size:14px}',
  'p{margin:6px 0;font-size:11px;line-height:1.6;color:%VIZ_DIM%}',
  '.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}',
  'label{font-size:11px;color:%VIZ_LABEL%}',
  'input{width:120px;accent-color:%VIZ_LINE%}',
  '.note{margin-top:6px;font-size:11px;color:%VIZ_NOTE%}',
  '</style></head>',
  '<body>',
  '<h3>简谐运动位移曲线</h3>',
  '<p>回复力 F=-kx 把物体拉回平衡位置。</p>',
  '<div class="row"><label>振幅 A <input id="a" type="range" min="0.5" max="2" step="0.1" value="1"></label><label>角频率 ω <input id="w" type="range" min="0.5" max="3" step="0.1" value="1.5"></label></div>',
  '<canvas id="c" width="500" height="170"></canvas>',
  '<div class="note" id="t"></div>',
  '<script>',
  '(function(){var cv=document.getElementById("c"),ctx=cv.getContext("2d");var A=1,w=1.5;',
  'function draw(){ctx.clearRect(0,0,cv.width,cv.height);ctx.strokeStyle="%VIZ_LINE%";ctx.lineWidth=2;ctx.beginPath();',
  'for(var x=0;x<=cv.width;x++){var t=x/cv.width*12;var y=85-A*40*Math.sin(w*t);if(x===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);}',
  'ctx.stroke();ctx.strokeStyle="%VIZ_AXIS%";ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(0,85);ctx.lineTo(cv.width,85);ctx.stroke();',
  'document.getElementById("t").textContent="x(t)="+A.toFixed(1)+"·cos("+w.toFixed(1)+"t)。拖动滑块观察振幅和角频率的影响。";}',
  'document.getElementById("a").oninput=function(){A=parseFloat(this.value);draw();};',
  'document.getElementById("w").oninput=function(){w=parseFloat(this.value);draw();};draw();',
  '})();',
  '<\/script>',
  '</body></html>'
].join('\n')
  // T166：配色事实源在 styles.css「内置示例图讲解 iframe 配色」令牌区。srcdoc 是独立
  // 文档、不加载主 CSS（iframe 里 var() 无值），故在此读出真值拼进模板；固定值不随主题。
  .replace(/%VIZ_TEXT%/g, cssVarValue('--demo-viz-text'))
  .replace(/%VIZ_DIM%/g, cssVarValue('--demo-viz-dim'))
  .replace(/%VIZ_LABEL%/g, cssVarValue('--demo-viz-label'))
  .replace(/%VIZ_LINE%/g, cssVarValue('--demo-viz-line'))
  .replace(/%VIZ_NOTE%/g, cssVarValue('--demo-viz-note'))
  .replace(/%VIZ_AXIS%/g, cssVarValue('--demo-viz-axis'));

function _demoNode(id, kind, x, y, options) {
  const opt = options || {};
  const now = Date.now();
  return {
    id,
    kind,
    moduleKey: opt.moduleKey || '',
    manual: !!opt.manual,
    label: opt.label || '',
    content: opt.content || '',
    status: opt.status || ((opt.content || opt.analysis) ? 'done' : 'waiting'),
    summary: opt.summary || '',
    analysis: opt.analysis || '',
    analysisHash: '',
    inputHash: '',
    generatedAt: now,
    requirements: opt.requirements || '',
    busy: false,
    generated: false,
    maxItems: kind === 'source' ? 3 : 0,
    items: opt.items || [],
    edges: [],
    fileId: '',
    fileName: '',
    generatedNodeIds: [],
    category: opt.category || '',
    formulas: opt.formulas || [],
    knowledgeKey: '',
    x,
    y,
    depth: kind === 'user' ? 1 : kind === 'answer' ? 2 : 3,
    targetAngle: 0,
    isRoot: false,
    timestamp: now,
    pinned: false,
    fixedX: null,
    fixedY: null,
    customWidth: opt.width || null,
    customHeight: opt.height || null,
    w: 0,
    h: 0,
    vx: 0,
    vy: 0,
  };
}

function _buildExampleGraphDemoState() {
  const nodes = [
    _demoNode('demo-question', 'user', -700, -260, { manual: true, content: '请解释简谐运动的物理和数学本质，并生成交互式可视化' }),
    _demoNode('demo-answer', 'answer', -220, -260, { analysis: '核心概念：回复力 F=-kx；数学结构：二阶线性微分方程。' }),
    _demoNode('demo-physics', 'module', 340, -540, { moduleKey: 'physics', content: '物体偏离平衡位置越远，回复力越大。回复力 <formula>F=-kx</formula> 总指向平衡位置，动能和弹性势能不断转换。' }),
    _demoNode('demo-math', 'module', 350, -180, { moduleKey: 'math', content: '由牛顿第二定律得到 <formula>m\\frac{d^2x}{dt^2}=-kx</formula>，通解为 <formula>x(t)=A\\cos(\\omega t+\\phi)</formula>。' }),
    _demoNode('demo-graph', 'module', 350, 180, { moduleKey: 'graph', content: '知识图谱：回复力 → 位移 → 速度 → 加速度 → 能量守恒。' }),
    _demoNode('demo-viz', 'module', 350, 540, { moduleKey: 'viz', content: '```html\n' + EXAMPLE_GUIDE_VIZ_HTML + '\n```' }),
    _demoNode('demo-learn', 'module', 900, 0, { moduleKey: 'learn', content: '### 进阶学习方向\n1. 阻尼振动与受迫振动\n2. 共振现象\n3. 耦合振子与简正模式' }),
    _demoNode('demo-socratic', 'module', 900, 360, { moduleKey: 'socratic', content: '### 苏格拉底追问\n1. [基础] 弹簧变硬后振动会怎样？\n2. [进阶] 能量为什么与振幅平方成正比？\n3. [拓展] 加入阻尼后方程如何变化？' }),
    _demoNode('demo-blank', 'blank', -720, 260, { requirements: '用动画解释共振现象', status: 'waiting' }),
    _demoNode('demo-source', 'source', -260, 560, { manual: true, items: [{ title: '简谐运动' }, { title: '回复力' }, { title: '角频率' }] }),
    _demoNode('demo-knowledge', 'knowledge', 320, 820, { manual: true, content: '简谐运动：回复力与位移成正比且反向，系统围绕平衡位置做周期性运动。', formulas: ['F=-kx'] }),
    _demoNode('demo-human', 'human_note', -720, 640, { manual: true, label: '我的理解', content: '回复力像“拉回平衡位置的橡皮筋”，偏离越多拉得越强。' }),
    _demoNode('demo-summary', 'summary', 900, -420, { content: '总结：简谐运动由线性回复力 <formula>F=-kx</formula> 主导，运动方程与能量转换都源于它。', status: 'done' }),
    _demoNode('demo-note', 'note', 900, 720, { manual: true, content: '我的总结：简谐运动的核心是线性回复力，它同时决定了运动方程与能量关系。' }),
  ];
  const positions = {};
  nodes.forEach(node => { positions[node.id] = { x: node.x, y: node.y }; });
  return {
    collapsed: {},
    hidden: {},
    positions,
    pinned: {},
    sizes: {},
    pan: { x: 140, y: 60 },
    zoom: 0.62,
    focus: null,
    layoutVersion: 4,
    connections: [
      { from: 'demo-question', fromPort: 'out-0', to: 'demo-answer', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-0', to: 'demo-physics', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-1', to: 'demo-math', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-2', to: 'demo-graph', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-3', to: 'demo-viz', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-4', to: 'demo-learn', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-answer', fromPort: 'out-5', to: 'demo-socratic', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-physics', fromPort: 'out-0', to: 'demo-summary', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-math', fromPort: 'out-0', to: 'demo-summary', toPort: 'in-1', type: 'custom', custom: true },
      { from: 'demo-graph', fromPort: 'out-0', to: 'demo-human', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-learn', fromPort: 'out-0', to: 'demo-blank', toPort: 'in-0', type: 'custom', custom: true },
      { from: 'demo-source', fromPort: 'out-0', to: 'demo-knowledge', toPort: 'in-0', type: 'custom', custom: true },
    ],
    removedEdges: [],
    portCounts: {},
    inputPortCounts: { 'demo-summary': 1 },
    groups: [],
    customNodes: nodes,
    harnessDeleted: {},
    harnessCheckpoint: null,
    updatedAt: Date.now(),
  };
}

const EXAMPLE_GUIDE_STEPS = [
  {
    title: '这是内置演示图',
    icon: UI_ICON_SVG.sparkles,
    desc: '已经载入一张以「简谐运动」为主题的示例探索网，并已使用画布自带的<strong>自动整理</strong>重新排布：问题 → 问题分析 → 各模块 → 延伸与结构节点，层级更清晰。',
    points: ['演示期间不会调用模型，也不会写入你的会话。', '你也可以随时点击右下角工具栏的“自动整理”再次重排。', '关闭示例后，画布会恢复成你原来的图。'],
    target: '[data-node-id="demo-answer"]',
  },
  {
    title: '双击空白处添加节点',
    icon: UI_ICON_SVG.plus,
    desc: '在画布空白处<strong>双击</strong>，会弹出“添加节点”菜单，可选择 AI 生成、视角模块、基础素材、人工内容和结构节点。',
    points: ['可以现在就双击右侧空白区域试一试。', '选择节点后，它会出现在你双击的位置。'],
    spot: 'blank',
  },
  {
    title: '问题节点：探索的起点',
    icon: UI_ICON_SVG.pencil,
    desc: '问题节点保存原始问题，右侧有两个输出端口：<strong>问题分析</strong>和<strong>我的回答</strong>，分别连接 AI 自动分析或手写回答。',
    points: ['把输出端口拖到空白处可快速创建下一级节点。', '问题文本可以直接在节点中编辑。'],
    target: '[data-node-id="demo-question"]',
  },
  {
    title: '问题分析节点：概要 ＋ 模块分发器',
    icon: UI_ICON_SVG.sparkles,
    desc: '问题分析节点先给出一段问题概要，再把内容拆成物理视角、数学视角、知识图谱、交互可视化、进阶学习和苏格拉底追问等<strong>模块节点</strong>——深入内容都在模块里。',
    points: ['每个输出端口对应一个模块。', '状态徽标会显示“分析中 / 完成 / 失败”。'],
    target: '[data-node-id="demo-answer"]',
  },
  {
    title: '模块节点：独立可追问',
    icon: UI_ICON_SVG.book,
    desc: '物理、数学、图谱、可视化等模块都是独立节点，可以单独<strong>追问</strong>、<strong>没看懂</strong>、<strong>编辑</strong>、<strong>最小化</strong>或删除。',
    points: ['节点右下角按钮可重新生成或追问。', '双击节点标题/内容区不会误触添加节点。'],
    target: '[data-node-id="demo-physics"]',
  },
  {
    title: '拖动输出端口生成节点',
    icon: UI_ICON_SVG.external,
    desc: '按住任意节点的<strong>右侧输出端口</strong>，拖到空白处松手，会按端口类型创建追问、进阶学习、苏格拉底回答等新节点。',
    points: ['试试拖动“物理视角”右侧的端口到空白处。', '新节点会自动连接到来源节点。'],
    target: '[data-node-id="demo-physics"] .graph-output-port',
  },
  {
    title: '输入端口：重连或断开',
    icon: UI_ICON_SVG.monitor,
    desc: '按住<strong>左侧输入端口</strong>拖动：拖到其他节点的输出端口可以重连来源；拖到空白处松手则断开当前输入。',
    points: ['所有常驻节点都能点击 + 增加输入端口。', '加出来的端口先显示「待命名」，连上输出口后会自动改用它的名字。'],
    target: '[data-node-id="demo-math"] .graph-input-port',
  },
  {
    title: '交互可视化节点',
    icon: UI_ICON_SVG.monitor,
    desc: '可视化模块内嵌可交互 HTML：可以拖动滑块、全屏、复制源码或新窗口打开。真实生成失败时会显示红色“失败”。',
    points: ['在示例图中直接拖动滑块试试。', '“没看懂”会只要求重讲这个可视化。'],
    target: '[data-node-id="demo-viz"]',
  },
  {
    title: '基础素材：输入、知识点、我的理解',
    icon: UI_ICON_SVG.database,
    desc: '画布还支持<strong>输入节点</strong>（文件/文本解析为知识点）、<strong>知识点节点</strong>和<strong>我的理解</strong>批注。',
    points: ['输入节点把内容分发为多个知识点。', '双击“我的理解”节点可直接编辑标题、正文和公式。'],
    target: '[data-node-id="demo-source"]',
  },
  {
    title: '总结节点：收束多路输入',
    icon: UI_ICON_SVG.book,
    desc: '<strong>AI 总结</strong>把多条上游输入收束成一段总结，任意节点都能点 + 增加输入端口来汇入更多内容。<strong>我的总结</strong>用于人工收束一条探索路径；本示例中它被收拢在右侧素材区。',
    points: ['节点默认一个输入端口，点 + 可增加端口接收多路上游。', '总结节点默认没有输出端口（需要收出下一段探索时可点 + 添加）。'],
    target: '[data-node-id="demo-summary"]',
  },
  {
    title: '空白节点：自由生成',
    icon: UI_ICON_SVG.plus,
    desc: '通过双击添加的<strong>AI 生成空白</strong>节点，可以写任意要求（如“用动画解释共振”），点生成后由 AI 生成任意内容。',
    points: ['演示模式不会真的调用模型。', '真实使用时，生成失败会变红并可单独重试。'],
    target: '[data-node-id="demo-blank"]',
  },
  {
    title: '画布工具栏',
    icon: UI_ICON_SVG.sliders,
    desc: '画布工具栏分两簇：右下角是看图与产出（搜索、缩放/适配、自动整理、Φ 助手、导出图片），左下角是改图与审查（图体检、修改历史、文字选择、联系模式、分组）。讲解本步时面板已临时移到左侧，不会再遮挡工具栏。',
    points: ['联系模式：依次点两个节点即可添加联系箭头。', '选中多个节点后可创建分组或批量删除。', 'Φ 按钮只管小助手的显示/隐藏，点画布上的小助手本体才能打开对话面板。'],
    target: '.graph-canvas-toolbar',
    panelSide: 'left',
  },
  {
    title: '选择、编辑、删除与撤销',
    icon: UI_ICON_SVG.pencil,
    desc: '单击选中节点，按住 Ctrl/Cmd 多选，空白处拖拽可框选；拖动节点、右下角缩放尺寸，Delete 删除，顶部历史按钮可撤销/重做。',
    points: ['节点右上角按钮：最小化、编辑、删除。', '拖拽分组框可整体移动组内节点。'],
    target: '[data-node-id="demo-blank"]',
  },
  {
    title: '结束演示',
    icon: UI_ICON_SVG.check,
    desc: '你已经看完探索网的核心操作。关闭本示例后，画布会恢复为你原来的会话图，演示中产生的任何改动都不会保留。',
    points: ['在真实画布中双击空白处即可开始搭建自己的网络。', '随时可从侧边栏“示例讲解”重新打开本演示。'],
    spot: 'none',
  },
];

function _exampleGuideSpotRect(step) {
  const canvas = document.getElementById('graphCanvas');
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (step.spot === 'blank') {
    const left = rect.left + rect.width * 0.36;
    const top = rect.top + rect.height * 0.30;
    const width = Math.min(360, rect.width * 0.30);
    const height = Math.min(240, rect.height * 0.30);
    return { left, top, width, height };
  }
  if (step.spot === 'none') return null;
  if (step.spot === 'canvas') {
    return { left: rect.left + 12, top: rect.top + 12, width: rect.width - 24, height: rect.height - 24 };
  }
  const el = step.target ? document.querySelector(step.target) : null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const pad = step.spot === 'port' ? 10 : 8;
  return { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

function _compactDemoMaterialNodes() {
  const state = typeof window.getGraphState === 'function' ? window.getGraphState() : null;
  if (!state || !state.positions) return;
  const treeIds = ['demo-question', 'demo-answer', 'demo-physics', 'demo-math', 'demo-graph', 'demo-viz', 'demo-learn', 'demo-socratic', 'demo-summary', 'demo-human', 'demo-blank'];
  let maxX = -Infinity;
  treeIds.forEach(id => {
    const pos = state.positions[id];
    if (pos && typeof pos.x === 'number') maxX = Math.max(maxX, pos.x);
  });
  if (!Number.isFinite(maxX)) return;
  const materialX = maxX + 560;
  ['demo-source', 'demo-knowledge', 'demo-note'].forEach((id, index) => {
    state.positions[id] = { x: materialX, y: (index - 1) * 300 };
    if (typeof graphView !== 'undefined' && graphView.nodeById && graphView.nodeById[id]) {
      graphView.nodeById[id].x = materialX;
      graphView.nodeById[id].y = (index - 1) * 300;
    }
  });
  if (typeof window.saveGraphState === 'function') window.saveGraphState('', state);
  if (typeof _updateNodeTransforms === 'function') _updateNodeTransforms();
  if (typeof _redrawEdges === 'function') _redrawEdges();
}

function _fitDemoGraphForPanel(panelLeft) {
  if (typeof window.getGraphState !== 'function') return;
  const dialog = document.querySelector('.example-guide-dialog');
  if (!dialog) return;
  const state = window.getGraphState();
  if (!state || !state.pan) return;
  if (window.innerWidth <= 760) {
    _exampleGuideLastPanelSide = panelLeft;
    return;
  }
  const panelWidth = Math.max(280, dialog.getBoundingClientRect().width || 360);
  const shift = Math.min(170, panelWidth * 0.34);
  if (_exampleGuideLastPanelSide === null) {
    state.pan.x -= shift;
  } else if (panelLeft !== _exampleGuideLastPanelSide) {
    state.pan.x += (panelLeft ? 1 : -1) * shift * 2;
  }
  _exampleGuideLastPanelSide = panelLeft;
  if (typeof window.saveGraphState === 'function') window.saveGraphState('', state);
  if (typeof _applyGraphTransform === 'function') _applyGraphTransform();
}

function _renderExampleGuideStep() {
  const step = EXAMPLE_GUIDE_STEPS[_exampleGuideStep] || EXAMPLE_GUIDE_STEPS[0];
  const iconEl = document.getElementById('exampleGuideStepIcon');
  const titleEl = document.getElementById('exampleGuideStepTitle');
  const descEl = document.getElementById('exampleGuideStepDesc');
  const pointsEl = document.getElementById('exampleGuidePoints');
  const dotsEl = document.getElementById('exampleGuideDots');
  const prevBtn = document.getElementById('exampleGuidePrevBtn');
  const nextBtn = document.getElementById('exampleGuideNextBtn');
  if (iconEl) iconEl.innerHTML = step.icon || '';
  if (titleEl) titleEl.textContent = step.title;
  if (descEl) descEl.innerHTML = step.desc;
  if (pointsEl) pointsEl.innerHTML = (step.points || []).map(point => '<li>' + point + '</li>').join('');
  if (dotsEl) dotsEl.innerHTML = EXAMPLE_GUIDE_STEPS.map((item, index) =>
    '<button class="example-guide-dot' + (index === _exampleGuideStep ? ' active' : '') + '" onclick="jumpExampleGuideStep(' + index + ')" title="' + item.title + '"></button>'
  ).join('');
  if (prevBtn) prevBtn.disabled = _exampleGuideStep === 0;
  if (nextBtn) {
    const isLast = _exampleGuideStep === EXAMPLE_GUIDE_STEPS.length - 1;
    nextBtn.innerHTML = isLast ? '完成' : '下一步 <span class="example-guide-next-icon">→</span>';
  }
  const dialog = document.querySelector('.example-guide-dialog');
  const useLeftPanel = step.panelSide === 'left' || (_exampleGuideStep >= 5 && _exampleGuideStep <= 13);
  if (dialog) dialog.classList.toggle('example-guide-panel-left', useLeftPanel);
  _fitDemoGraphForPanel(useLeftPanel);
  _updateExampleGuideSpotlight(step);
}

function _updateExampleGuideSpotlight(step) {
  const spotlight = document.getElementById('exampleGuideSpotlight');
  if (!spotlight) return;
  const currentStep = step || EXAMPLE_GUIDE_STEPS[_exampleGuideStep] || EXAMPLE_GUIDE_STEPS[0];
  const rect = _exampleGuideSpotRect(currentStep);
  if (rect && rect.left >= -20 && rect.top >= -20 && rect.width > 10 && rect.height > 10) {
    spotlight.style.left = rect.left + 'px';
    spotlight.style.top = rect.top + 'px';
    spotlight.style.width = rect.width + 'px';
    spotlight.style.height = rect.height + 'px';
    spotlight.classList.add('show');
  } else {
    spotlight.classList.remove('show');
  }
}

function _startExampleGuideSpotlightLoop() {
  if (_exampleGuideSpotlightRaf) return;
  const tick = () => {
    const overlay = document.getElementById('exampleGuideOverlay');
    if (!overlay || !overlay.classList.contains('active')) {
      _exampleGuideSpotlightRaf = 0;
      return;
    }
    _updateExampleGuideSpotlight();
    _exampleGuideSpotlightRaf = requestAnimationFrame(tick);
  };
  _exampleGuideSpotlightRaf = requestAnimationFrame(tick);
}

function _stopExampleGuideSpotlightLoop() {
  if (_exampleGuideSpotlightRaf) {
    cancelAnimationFrame(_exampleGuideSpotlightRaf);
    _exampleGuideSpotlightRaf = 0;
  }
}

function _restoreExampleGraphBindings() {
  if (!_exampleGuideOriginal) return;
  const original = _exampleGuideOriginal;
  const restore = (name, value) => {
    try { window[name] = value; } catch (e) {}
  };
  restore('getGraphState', original.getGraphState);
  restore('saveGraphState', original.saveGraphState);
  restore('flushGraphStateServerSave', original.flushGraphStateServerSave);
  restore('getChatHistory', original.getChatHistory);
  restore('getStreamingAssistant', original.getStreamingAssistant);
  restore('getCurrentSessionId', original.getCurrentSessionId);
  restore('getActiveModelForRole', original.getActiveModelForRole);
  restore('proxyChatWithModel', original.proxyChatWithModel);
  restore('proxyChat', original.proxyChat);
  restore('runWorkflowNode', original.runWorkflowNode);
  restore('runWorkflowNodes', original.runWorkflowNodes);
  restore('runAllWorkflowNodes', original.runAllWorkflowNodes);
  restore('startQuestionWorkflow', original.startQuestionWorkflow);
  restore('generateBlankNode', original.generateBlankNode);
  restore('generateKnowledgeNode', original.generateKnowledgeNode);
  restore('generateRelationNode', original.generateRelationNode);
  restore('submitRegenerateNode', original.submitRegenerateNode);
  restore('generateVizNode', original.generateVizNode);
  restore('draftAskAi', original.draftAskAi);
  restore('toggleGraphPet', original.toggleGraphPet);
  restore('submitDraftQuestion', original.submitDraftQuestion);
  restore('draftSocraticAnswer', original.draftSocraticAnswer);
  restore('sendGraphNewSession', original.sendGraphNewSession);
  _exampleGuideOriginal = null;
  _exampleGuideDemoState = null;
  try { localStorage.removeItem('phymathia_graph_history___example_graph_demo__'); } catch (e) {}
}

function _enterExampleGraphDemo() {
  if (_exampleGuideOriginal) return;
  const state = _buildExampleGraphDemoState();
  const original = {
    getGraphState: window.getGraphState,
    saveGraphState: window.saveGraphState,
    flushGraphStateServerSave: window.flushGraphStateServerSave,
    getChatHistory: window.getChatHistory,
    getStreamingAssistant: window.getStreamingAssistant,
    getCurrentSessionId: window.getCurrentSessionId,
    getActiveModelForRole: window.getActiveModelForRole,
    proxyChatWithModel: window.proxyChatWithModel,
    proxyChat: window.proxyChat,
    runWorkflowNode: window.runWorkflowNode,
    runWorkflowNodes: window.runWorkflowNodes,
    runAllWorkflowNodes: window.runAllWorkflowNodes,
    startQuestionWorkflow: window.startQuestionWorkflow,
    generateBlankNode: window.generateBlankNode,
    generateKnowledgeNode: window.generateKnowledgeNode,
    generateRelationNode: window.generateRelationNode,
    submitRegenerateNode: window.submitRegenerateNode,
    generateVizNode: window.generateVizNode,
    draftAskAi: window.draftAskAi,
    toggleGraphPet: window.toggleGraphPet,
    submitDraftQuestion: window.submitDraftQuestion,
    draftSocraticAnswer: window.draftSocraticAnswer,
    sendGraphNewSession: window.sendGraphNewSession,
  };
  _exampleGuideOriginal = original;
  _exampleGuideDemoState = state;
  window.getGraphState = () => _exampleGuideDemoState;
  window.flushGraphStateServerSave = () => Promise.resolve();
  window.saveGraphState = (sid, nextState) => {
    if (nextState && typeof nextState === 'object') _exampleGuideDemoState = nextState;
  };
  window.getChatHistory = () => [];
  window.getStreamingAssistant = () => null;
  window.getCurrentSessionId = () => '__example_graph_demo__';
  window.getActiveModelForRole = () => null;
  window.proxyChatWithModel = () => Promise.reject(new Error('演示模式不调用模型'));
  window.proxyChat = () => Promise.resolve(null);
  const blockAi = () => {
    if (typeof showToast === 'function') showToast('演示模式：这里不会调用模型，退出示例后可在真实画布使用');
  };
  ['runWorkflowNode', 'runWorkflowNodes', 'runAllWorkflowNodes', 'startQuestionWorkflow', 'generateBlankNode', 'generateKnowledgeNode', 'generateRelationNode', 'submitRegenerateNode', 'generateVizNode', 'draftAskAi', 'toggleGraphPet', 'submitDraftQuestion', 'draftSocraticAnswer', 'sendGraphNewSession'].forEach(name => {
    try { window[name] = blockAi; } catch (e) {}
  });
  document.body.classList.add('example-graph-demo-active');
  if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
}

function _exitExampleGraphDemo() {
  document.body.classList.remove('example-graph-demo-active');
  if (typeof closeAddBlankNodeModal === 'function') closeAddBlankNodeModal();
  if (typeof closeModuleNodeModal === 'function') closeModuleNodeModal();
  if (typeof closeHumanNoteNodeModal === 'function') closeHumanNoteNodeModal();
  if (typeof closeGraphSearchPanel === 'function') closeGraphSearchPanel();
  _restoreExampleGraphBindings();
  if (typeof window.renderGraphCanvas === 'function') window.renderGraphCanvas();
}

function openExampleGuide() {
  const overlay = document.getElementById('exampleGuideOverlay');
  if (!overlay) return;
  if (typeof isStreaming !== 'undefined' && isStreaming) {
    if (typeof showToast === 'function') showToast('请先等待当前回答完成，再打开示例讲解');
    return;
  }
  if (typeof workflowRunActive !== 'undefined' && workflowRunActive) {
    if (typeof showToast === 'function') showToast('请先停止或等待当前工作流结束，再打开示例讲解');
    return;
  }
  if (typeof closeSidebar === 'function') closeSidebar();
  const onboarding = document.getElementById('onboardingOverlay');
  if (onboarding && onboarding.classList.contains('active')) {
    _exampleGuideSuspendedOnboarding = true;
    onboarding.classList.remove('active');
  }
  _enterExampleGraphDemo();
  _exampleGuideStep = 0;
  overlay.classList.add('active');
  setTimeout(() => {
    // 直接使用项目自带的“自动整理”：按问题根节点、层级和端口顺序重新排布示例图。
    if (typeof autoArrangeGraph === 'function') autoArrangeGraph();
    // 自动整理后，再把“素材/总结”类节点收拢到主树右侧，避免分散节点把整张图拉得过宽。
    _compactDemoMaterialNodes();
    if (typeof fitGraph === 'function') fitGraph();
    _exampleGuideLastPanelSide = null;
    _renderExampleGuideStep();
    _startExampleGuideSpotlightLoop();
  }, 120);
}

function closeExampleGuide() {
  const overlay = document.getElementById('exampleGuideOverlay');
  overlay?.classList.remove('active');
  const spotlight = document.getElementById('exampleGuideSpotlight');
  spotlight?.classList.remove('show');
  _exampleGuideLastPanelSide = null;
  _stopExampleGuideSpotlightLoop();
  _exitExampleGraphDemo();
  if (_exampleGuideSuspendedOnboarding) {
    _exampleGuideSuspendedOnboarding = false;
    const onboarding = document.getElementById('onboardingOverlay');
    const exampleInviteIndex = _obSteps.findIndex(step => step.example);
    const atExampleInvite = exampleInviteIndex !== -1 && _obStep === exampleInviteIndex;
    if (onboarding && _obStep >= 0 && _obStep < _obSteps.length) {
      onboarding.classList.add('active');
      if (atExampleInvite) nextObStep();
      else _renderObStep();
    }
  }
}

function prevExampleGuideStep() {
  if (_exampleGuideStep <= 0) return;
  _exampleGuideStep--;
  _renderExampleGuideStep();
}

function nextExampleGuideStep() {
  if (_exampleGuideStep >= EXAMPLE_GUIDE_STEPS.length - 1) {
    closeExampleGuide();
    return;
  }
  _exampleGuideStep++;
  _renderExampleGuideStep();
}

function jumpExampleGuideStep(index) {
  _exampleGuideStep = Math.max(0, Math.min(EXAMPLE_GUIDE_STEPS.length - 1, Number(index) || 0));
  _renderExampleGuideStep();
}

function _renderObStep() {
  if (_obStep < 0 || _obStep >= _obSteps.length) { endOnboarding(); return; }
  const step = _obSteps[_obStep];
  const card = document.getElementById('onboardingCard');
  const spotlight = document.getElementById('onboardingSpotlight');
  const overlay = document.getElementById('onboardingOverlay');

  // For click-type steps, allow clicks to pass through overlay to reach target element
  if (step.type === 'click') {
    overlay.style.pointerEvents = 'none';
    // Keep card clickable
    card.style.pointerEvents = 'auto';
  } else {
    overlay.style.pointerEvents = '';
    card.style.pointerEvents = '';
  }

  // Hide card briefly for transition
  card.classList.remove('visible');

  setTimeout(() => {
    if (step.type === 'welcome') {
      spotlight.style.display = 'none';
      card.className = 'onboarding-card ob-welcome aurora-glass aurora-glass--dialog';
      const isLast = _obStep === _obSteps.length - 1;
      const primaryAction = step.example
        ? '<button class="ob-btn ob-btn-ghost" onclick="nextObStep()">稍后再说</button>'
          + '<button class="ob-btn ob-btn-next" onclick="openExampleGuide()">进入示例图 ' + UI_ICON_SVG.arrowRight + '</button>'
        : '<button class="ob-btn ' + (isLast ? 'ob-btn-finish' : 'ob-btn-next') + '" onclick="' + (isLast ? 'endOnboarding()' : 'nextObStep()') + '">' + (isLast ? '开始使用 ' + UI_ICON_SVG.sparkles : '开始了解 ' + UI_ICON_SVG.arrowRight) + '</button>';
      card.innerHTML = `
        <span class="ob-icon">${step.icon}</span>
        <div class="ob-title">${step.title}</div>
        ${step.desc ? `<div class="ob-desc">${step.desc}</div>` : ''}
        ${step.exampleQuestion ? `
          <div class="ob-example-box">
            <div class="ob-example-label">${UI_ICON_SVG.pencil} 示例问题</div>
            <div class="ob-example-question">${step.exampleQuestion}</div>
            <div class="ob-example-note">${step.exampleNote || ''}</div>
            ${step.exampleLink ? `<a class="ob-example-link" href="${step.exampleLink}" target="_blank" rel="noopener noreferrer">${UI_ICON_SVG.external} 打开内置演示页</a>` : ''}
          </div>` : ''}
        <div class="ob-features">
          ${(step.features || []).map(f => `
            <div class="ob-feature">
              <span class="ob-feature-icon">${f.icon}</span>
              <span class="ob-feature-text">${f.text}</span>
            </div>
          `).join('')}
        </div>
        <div class="onboarding-footer">
          <div class="onboarding-dots">
            ${_obSteps.map((_, i) => `<div class="onboarding-dot ${i === _obStep ? 'active' : ''}"></div>`).join('')}
          </div>
          <div class="onboarding-actions">
            <button class="ob-btn ob-btn-skip" onclick="endOnboarding()">跳过</button>
            ${primaryAction}
          </div>
        </div>
      `;
    } else {
      // Spotlight mode
      if (step.beforeShow) step.beforeShow();
      const needsDelay = !!step.beforeShow;
      const renderSpotlight = () => {
      const target = document.querySelector(step.target);
      if (target) {
        const rect = target.getBoundingClientRect();
        const pad = 8;
        spotlight.style.display = 'block';
        spotlight.style.pointerEvents = step.type === 'click' ? 'none' : 'auto';
        spotlight.style.left = (rect.left - pad) + 'px';
        spotlight.style.top = (rect.top - pad) + 'px';
        spotlight.style.width = (rect.width + pad * 2) + 'px';
        spotlight.style.height = (rect.height + pad * 2) + 'px';
      } else {
        spotlight.style.display = 'none';
      }

      card.className = 'onboarding-card aurora-glass aurora-glass--dialog';
      const isLast = _obStep === _obSteps.length - 1;

      // Position card near the target
      if (target) {
        const rect = target.getBoundingClientRect();
        const cardW = 380;
        const cardH = 220;
        // Try below the target first, then above
        let top = rect.bottom + 16;
        let left = rect.left + rect.width / 2 - cardW / 2;
        // Clamp to viewport
        left = Math.max(16, Math.min(left, window.innerWidth - cardW - 16));
        if (top + cardH > window.innerHeight - 16) {
          top = rect.top - cardH - 16;
        }
        if (top < 16) top = 16;
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }

      card.innerHTML = `
        <span class="ob-icon">${step.icon}</span>
        <div class="ob-title">${step.title}</div>
        <div class="ob-desc">${step.desc}</div>
        <div class="onboarding-footer">
          <div class="onboarding-dots">
            ${_obSteps.map((_, i) => `<div class="onboarding-dot ${i === _obStep ? 'active' : ''}"></div>`).join('')}
          </div>
          <div class="onboarding-actions">
            <button class="ob-btn ob-btn-skip" onclick="endOnboarding()">跳过</button>
            ${isLast
              ? '<button class="ob-btn ob-btn-finish" onclick="endOnboarding()">开始使用 ' + UI_ICON_SVG.sparkles + '</button>'
              : step.type === 'click'
                ? '<span class="ob-hint">' + UI_ICON_SVG.pointer + ' 点击高亮区域继续</span>'
                : '<button class="ob-btn ob-btn-next" onclick="nextObStep()">下一步 ' + UI_ICON_SVG.arrowRight + '</button>'
            }
          </div>
        </div>
      `;
      }; // end renderSpotlight

      // Bind click handler for type:'click' steps
      const bindClickHandler = () => {
        if (step.type === 'click' && step.onClick) {
          // Allow clicks to pass through overlay to the target element
          spotlight.style.pointerEvents = 'none';
          const targetEl = document.querySelector(step.target);
          if (targetEl) {
            // T228：绑新前先摘旧绑定——上一步的 click 监听只在被点时自摘，
            // 用户没点中就换步/跳过时旧的会残留
            if (_obClickBinding) {
              _obClickBinding.target.removeEventListener('click', _obClickBinding.handler);
              _obClickBinding = null;
            }
            const handler = (e) => {
              e.stopPropagation();
              targetEl.removeEventListener('click', handler);
              _obClickBinding = null;
              step.onClick();
              nextObStep();
            };
            targetEl.addEventListener('click', handler);
            _obClickBinding = { target: targetEl, handler };
          }
        }
      };
      if (needsDelay) {
        setTimeout(() => { renderSpotlight(); if(step.afterShow) step.afterShow(); bindClickHandler(); requestAnimationFrame(() => { card.classList.add('visible'); }); }, 350);
      } else {
        renderSpotlight();
        if(step.afterShow) step.afterShow();
        bindClickHandler();
        // Animate card in
        requestAnimationFrame(() => {
          card.classList.add('visible');
        });
      }
      return;
    }

    // Animate card in
    requestAnimationFrame(() => {
      card.classList.add('visible');
    });
  }, 150);
}

function nextObStep() {
  _obStep++;
  _renderObStep();
}

function endOnboarding() {
  localStorage.setItem(ONBOARDING_KEY, '1');
  _obStep = -1;
  // T228：摘掉 click 型步骤残留在目标元素上的监听——只隐藏浮层不清监听的话，
  // 用户点「跳过」后再点菜单按钮仍会触发旧 step.onClick()+nextObStep()
  if (_obClickBinding) {
    _obClickBinding.target.removeEventListener('click', _obClickBinding.handler);
    _obClickBinding = null;
  }
  const overlay = document.getElementById('onboardingOverlay');
  const card = document.getElementById('onboardingCard');
  const spotlight = document.getElementById('onboardingSpotlight');
  card.classList.remove('visible');
  overlay.classList.remove('active');
  setTimeout(() => {
    spotlight.style.display = 'none';
    card.style.left = '';
    card.style.top = '';
  }, 400);
}
