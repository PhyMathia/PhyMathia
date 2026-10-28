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
// 2026-10-24 重写：每步＝kicker（你在哪）＋标题（讲什么）＋一段引子＋术语/解释两列，
// 卡片头部走「图标＋kicker＋步数」，底部走「节点链进度」——视觉语法对齐画布上的节点卡。
// 文案口径：短句、动词开头、不写破折号串，功能名用界面上真实存在的词（知识检测/用量统计…）。
const _obSteps = [
  {
    type: 'welcome',
    kicker: '开始之前',
    icon: '<img src="/logo.png" alt="" />',
    title: '欢迎来到 PhyMathia',
    desc: '每个问题都从两头回答：物理给直觉，数学给结构。答案会拆成节点，在画布上长成一张能接着问的网。',
    features: [
      { term: '双域解释', text: '一次回答出两张卡：物理视角讲机制，数学视角讲结构' },
      { term: '探索网', text: '回答拆成节点，想深究哪一块就从哪一块往下问' },
      { term: '交互可视化', text: '参数能拖的 HTML 演示，跟着节点留在画布上' },
      { term: 'Φ助手', text: '画布上的助手，动手改图之前先查你攒下的知识库' },
    ]
  },
  {
    type: 'welcome',
    example: true,
    kicker: '内置示例',
    icon: UI_ICON_SVG.sparkles,
    title: '内置示例图讲解',
    desc: '画布上已经摆好一张简谐运动的示例网。跟着走一遍，把双击加点、端口拉线、工具栏和选中编辑都试到手。',
    exampleQuestion: ONBOARDING_EXAMPLE_QUESTION,
    exampleNote: '示例不调用模型，也不写进你的会话；关掉就回到原来的画布。',
    features: [
      { term: '边点边学', text: '聚光灯照到哪儿，讲解就跟到哪儿' },
      { term: '真实画布', text: '可以直接拖、缩放、双击、拉线' },
      { term: '不留痕迹', text: '演示里的改动不落盘，退出即还原' },
    ]
  },
  {
    type: 'spotlight',
    kicker: '画布',
    get target() { return document.querySelector('.graph-new-session-node') ? '.graph-new-session-node' : '.graph-canvas'; },
    icon: UI_ICON_SVG.pencil,
    get title() { return document.querySelector('.graph-new-session-node') ? '在中心节点提问' : '继续探索'; },
    get desc() {
      return document.querySelector('.graph-new-session-node')
        ? '画布中央的中心节点就是入口。把问题打进去回车，答案从中心往外铺成一整张网。'
        : '点节点上的追问，顺着一条线往下挖；点删除，收掉不要的分支。';
    }
  },
  {
    type: 'spotlight',
    kicker: '顶栏',
    get target() { return _isMobile() ? '.header-secondary-bar' : '.header-actions'; },
    icon: UI_ICON_SVG.sliders,
    title: '个性化设置',
    get desc() {
      return _isMobile()
        ? '这里能换深浅色和难度；模型、知识总览、数据管理也都在这一排。'
        : '这一排决定 AI 怎么答：模型、难度（中学 / 大学 / 科研）、深色或浅色。旁边翻开的本子是知识总览。';
    }
  },
  {
    type: 'click',
    target: '.menu-btn',
    kicker: '画布列表',
    icon: UI_ICON_SVG.book,
    title: '试试点击菜单按钮',
    desc: '点左上角这个按钮打开画布列表。一张画布放一个话题，随时切。',
    onClick() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'spotlight',
    kicker: '画布列表',
    get target() { return _isMobile() ? '.sidebar-sessions' : '.session-item'; },
    icon: UI_ICON_SVG.pencil,
    title: '个性化画布',
    desc: '画布图标能换成力学、电磁、光学这类学科标记，重命名按钮改标题。列表一长，靠它们认路。',
    placement: 'right',
    beforeShow() { document.getElementById('sidebar').classList.add('open'); }
  },
  {
    type: 'welcome',
    kicker: '侧边栏',
    icon: UI_ICON_SVG.layout,
    title: '列表底下这排工具',
    desc: '这一排跨画布干活：换张画布，它们照样管全局。',
    beforeShow() { document.getElementById('sidebar').classList.add('open'); },
    features: [
      { term: '知识大陆', text: '所有画布的知识点投到同一张地图上，能缩放、能钻进去看' },
      { term: '知识检测', text: '给本画布出题摸底；检测总览看每张画布的答对率' },
      { term: '多账号', text: '本机可建多个账号，数据互不相通，也能只读查阅对方' },
      { term: '回收站', text: '删掉的画布先进回收站，保留期内能捞回来' },
      { term: '用量统计', text: '每次调用花了多少 token，按模型和日期记账' },
    ]
  },
  {
    type: 'spotlight',
    kicker: '画布',
    icon: UI_ICON_SVG.sliders,
    title: '两块工具栏',
    desc: '画布右下和左下各有一簇按钮，分工不一样。',
    features: [
      { term: '右下角', text: '看图与产出：搜索、缩放、适配、自动整理、Φ 助手、导出' },
      { term: '左下角', text: '改图与审查：图体检、修改历史、选择文字、联系模式、分组' },
    ],
    target: '.graph-canvas-toolbar'
  },
  {
    type: 'welcome',
    kicker: '记忆',
    icon: UI_ICON_SVG.sparkles,
    title: '记忆（默认开启）',
    desc: '它记着你的学段、目标、兴趣、薄弱点和回答偏好。下次回答和出题照这个来，不用每次重讲。',
    features: [
      { term: '存在本机', text: '画像不出这台机器；对话内容照旧发给模型服务商' },
      { term: '随时改', text: '侧边栏「记忆」里能看、能改、能删' },
      { term: '随时关', text: '一键关闭或清空，之后不再写新内容' },
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
    _demoNode('demo-source', 'source', -260, 560, { manual: true, items: [
      { id: 'src-demo-1', kind: 'text', name: '简谐运动', text: '回复力与位移成正比且反向，系统围绕平衡位置做周期性运动。', chars: 30 },
      { id: 'src-demo-2', kind: 'text', name: '回复力', text: 'F = -kx，方向总指向平衡位置。', chars: 18 },
      { id: 'src-demo-3', kind: 'text', name: '角频率', text: 'ω = √(k/m)，由系统自身性质决定。', chars: 18 },
    ] }),
    _demoNode('demo-knowledge', 'human_note', 320, 820, { manual: true, label: '我的理解', content: '简谐运动：回复力与位移成正比且反向，系统围绕平衡位置做周期性运动。', formula: 'F=-kx' }),
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
    desc: '已经载入一张简谐运动的示例网，并按画布自带的<strong>自动整理</strong>排过一遍：问题在最左，问题分析往下分到各个模块，延伸和结构节点在右侧。',
    points: ['演示期间不会调用模型，也不会写入你的会话。', '想再排一次，点右下角工具栏的「自动整理」。', '关闭示例后，画布会恢复成你原来的图。'],
    target: '[data-node-id="demo-answer"]',
  },
  {
    title: '双击空白处添加节点',
    icon: UI_ICON_SVG.plus,
    desc: '在画布空白处<strong>双击</strong>，会弹出添加节点菜单，分 AI 生成、视角模块、基础素材、人工内容和结构五组。',
    points: ['可以现在就双击右侧空白区域试一试。', '选择节点后，它会出现在你双击的位置。'],
    spot: 'blank',
  },
  {
    title: '问题节点：探索的起点',
    icon: UI_ICON_SVG.pencil,
    desc: '问题节点保存原始问题，右侧三个输出端口各走一条路：问题分析拆成概要加模块，直接回答给一份完整答案，我的回答留给你自己写。',
    points: ['把输出端口拖到空白处可快速创建下一级节点。', '「直接回答」不拆模块，适合想先看一份完整答案的时候。', '问题文本可以直接在节点中编辑。'],
    target: '[data-node-id="demo-question"]',
  },
  {
    title: '问题分析节点：先给概要，再分模块',
    icon: UI_ICON_SVG.sparkles,
    desc: '问题分析节点先给一段问题概要，再把内容拆成物理视角、数学视角、知识图谱、交互可视化、进阶学习和苏格拉底追问等<strong>模块节点</strong>。深入的内容都在模块里，不在概要里。',
    points: ['每个输出端口对应一个模块。', '状态徽标会显示“分析中 / 完成 / 失败”。'],
    target: '[data-node-id="demo-answer"]',
  },
  {
    title: '模块节点：独立可追问',
    icon: UI_ICON_SVG.book,
    desc: '物理、数学、图谱、可视化等模块都是独立节点，可以单独<strong>追问</strong>、<strong>编辑</strong>、<strong>最小化</strong>或删除。',
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
    points: ['在示例图中直接拖动滑块试试。', '对效果不满意可在节点按钮里带要求重新生成。'],
    target: '[data-node-id="demo-viz"]',
  },
  {
    title: '素材篮：一条素材一个出口',
    icon: UI_ICON_SVG.database,
    desc: '输入节点是一个<strong>素材篮</strong>：每一行一条素材，各占一个出口，拖出去就是给下游的材料。图片会跟问题一起发给看得见图的模型；扫描版 PDF 按页转成图再送。',
    points: ['拖出口到空白处，可以自选接给哪个节点。', '「我的理解」写自己的批注，双击就能改标题、正文和公式。'],
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
    points: ['联系模式：依次点两个节点即可添加联系箭头。', '选中多个节点后可创建分组或批量删除。', 'Φ 按钮只管小助手的显示/隐藏，点画布上的小助手本体才能打开对话面板。', '面板顶上的「模式：编辑」里切到「创造」，会打开节点工坊：一句话描述你想要的节点，试跑满意后一键入册。'],
    target: '.graph-canvas-toolbar',
    panelSide: 'left',
  },
  {
    title: '选择、编辑、删除与撤销',
    icon: UI_ICON_SVG.pencil,
    desc: '单击选中节点，按住 Ctrl/Cmd 多选，空白处拖拽可框选；拖动节点、右下角缩放尺寸，Delete 删除，顶部历史按钮可撤销/重做。',
    points: ['节点右上角按钮：最小化、编辑、删除。', 'Ctrl+C 复制选中节点，换张画布也能 Ctrl+V 粘回去，连线和组内布局一起带走。', '拖拽分组框可整体移动组内节点。'],
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
  const countEl = document.getElementById('exampleGuideStepCount');
  if (iconEl) iconEl.innerHTML = step.icon || '';
  if (countEl) countEl.textContent = (_exampleGuideStep + 1) + ' / ' + EXAMPLE_GUIDE_STEPS.length;
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
  ['runWorkflowNode', 'runWorkflowNodes', 'runAllWorkflowNodes', 'startQuestionWorkflow', 'generateBlankNode', 'generateRelationNode', 'submitRegenerateNode', 'generateVizNode', 'draftAskAi', 'toggleGraphPet', 'submitDraftQuestion', 'draftSocraticAnswer', 'sendGraphNewSession'].forEach(name => {
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

// 卡片头部：图标章＋kicker（你在哪一步的地界）＋右端 3 / 9 步数
function _obHeadHtml(step) {
  return '<div class="ob-head">'
    + '<span class="ob-mark">' + (step.icon || '') + '</span>'
    + '<span class="ob-kicker">' + (step.kicker || '使用引导') + '</span>'
    + '<span class="ob-count">' + (_obStep + 1) + ' / ' + _obSteps.length + '</span>'
    + '</div>';
}

// 底部进度＝一条缩小的探索网：走过的节点实心、当前节点带光晕、没到的是空心。
// 用节点链而不是圆点，是因为这东西本身就是「一张网」——进度条重复产品自己的语法。
function _obRailHtml() {
  let html = '';
  for (let i = 0; i < _obSteps.length; i++) {
    if (i) html += '<span class="ob-rail-line"></span>';
    html += '<span class="ob-rail-dot' + (i === _obStep ? ' active' : (i < _obStep ? ' done' : '')) + '"></span>';
  }
  return '<div class="ob-rail" aria-hidden="true">' + html + '</div>';
}

// 术语/解释两列：左边是界面上的真实叫法，右边一句话说清它干什么。
// 不用图标也不用逐条方框——列表本身有分隔线，再套盒子只会变成一排表单。
function _obListHtml(step) {
  const rows = step.features || [];
  if (!rows.length) return '';
  return '<dl class="ob-list">' + rows.map(row =>
    '<div class="ob-row"><dt class="ob-term">' + row.term + '</dt><dd class="ob-text">' + row.text + '</dd></div>'
  ).join('') + '</dl>';
}

function _obExampleHtml(step) {
  if (!step.exampleQuestion) return '';
  return '<figure class="ob-quote">'
    + '<figcaption class="ob-quote-label">示例问题</figcaption>'
    + '<blockquote class="ob-quote-text">' + step.exampleQuestion + '</blockquote>'
    + '<div class="ob-quote-note">' + (step.exampleNote || '') + '</div>'
    + (step.exampleLink ? '<a class="ob-example-link" href="' + step.exampleLink + '" target="_blank" rel="noopener noreferrer">' + UI_ICON_SVG.external + ' 打开内置演示页</a>' : '')
    + '</figure>';
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
      // welcome 步也可以带 beforeShow（「列表底下这排工具」要把侧栏打开才看得见）
      if (step.beforeShow) step.beforeShow();
      card.className = 'onboarding-card ob-welcome aurora-glass aurora-glass--dialog';
      const isLast = _obStep === _obSteps.length - 1;
      const primaryAction = step.example
        ? '<button class="ob-btn ob-btn-ghost" onclick="nextObStep()">稍后再说</button>'
          + '<button class="ob-btn ob-btn-next" onclick="openExampleGuide()">进入示例图 ' + UI_ICON_SVG.arrowRight + '</button>'
        : '<button class="ob-btn ' + (isLast ? 'ob-btn-finish' : 'ob-btn-next') + '" onclick="' + (isLast ? 'endOnboarding()' : 'nextObStep()') + '">' + (isLast ? '开始使用 ' + UI_ICON_SVG.sparkles : '开始了解 ' + UI_ICON_SVG.arrowRight) + '</button>';
      card.innerHTML = `
        ${_obHeadHtml(step)}
        <div class="ob-body">
          <div class="ob-title">${step.title}</div>
          ${step.desc ? `<p class="ob-desc">${step.desc}</p>` : ''}
          ${_obExampleHtml(step)}
          ${_obListHtml(step)}
        </div>
        <div class="onboarding-footer">
          ${_obRailHtml()}
          <div class="onboarding-actions">
            <button class="ob-btn ob-btn-skip" onclick="endOnboarding()">跳过</button>
            ${primaryAction}
          </div>
        </div>
      `;
      // 入场：先落内容再挂 visible，让 opacity/translate 从真位置起跑
      requestAnimationFrame(() => { card.classList.add('visible'); });
      return;
    }
    // 聚光灯型：卡片贴在目标旁边，目标以外压暗
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
      card.innerHTML = `
        ${_obHeadHtml(step)}
        <div class="ob-body">
          <div class="ob-title">${step.title}</div>
          <p class="ob-desc">${step.desc}</p>
          ${_obListHtml(step)}
        </div>
        <div class="onboarding-footer">
          ${_obRailHtml()}
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

      // 卡片高度随文案变：先落内容再量真高重夹一次，固定估高会让长卡片钻出屏幕底
      if (target) {
        const rect = target.getBoundingClientRect();
        const cardW = card.offsetWidth || 400;
        const cardH = card.offsetHeight || 220;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = rect.left + rect.width / 2 - cardW / 2;
        let top = rect.bottom + 16;
        // placement:'right'＝目标占了屏幕一侧的整条（画布列表项），卡片让到它右边，
        // 否则居中落点会被夹到左缘、正好压住要讲解的那一列。窄屏仍是上下排。
        if (step.placement === 'right' && vw > 760) {
          left = rect.right + 18;
          top = rect.top;
          if (top + cardH > vh - 16) top = Math.max(16, vh - cardH - 16);
        }
        left = Math.max(16, Math.min(left, vw - cardW - 16));
        // 目标铺满整屏（空画布那步的 target 就是整块 .graph-canvas）：上下都有位置，
        // 干脆落到屏幕底部当一条说明带——压顶栏会盖住 logo 与顶栏按钮
        if (rect.height > vh * 0.7 && rect.width > vw * 0.7) {
          top = vh - cardH - 24;
        } else if (top + cardH > vh - 16) {
          top = rect.top - cardH - 16;
        }
        if (top + cardH > vh - 16) top = Math.max(16, vh - cardH - 16);
        if (top < 16) top = 16;
        card.style.left = left + 'px';
        card.style.top = top + 'px';
      }
    };

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
