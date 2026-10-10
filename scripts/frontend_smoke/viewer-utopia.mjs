// utopia 查看器 / .pmu 快照 / 节点皮肤 / 打包注册
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 1599–1886 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
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
  // 双击节点/连线面板：三个创建点都挂 aurora-glass，且弹窗规则不得再写 background 简写（会盖掉极光）。
  // 2026-10-10 起为三处：原第四个创建点（总结类编辑弹窗）升级成全屏笔记本编辑模式
  // （graph-notebook，左上游右书写）——它是独立全屏载体，不属 graph-network-modal 家族，
  // 玻璃口径由 aurora-glass--panel 档承担（本体 CSS 禁写底色），本契约正则不扫它；
  // 契约反斜在 recipes.mjs 的笔记本用例（overlay 类名＋标题输入框在位）。
  const gc = fs.readFileSync('src/static/js/graph-custom.js', 'utf8');
  if ((gc.match(/graph-network-modal aurora-glass/g) || []).length < 3) {
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
}
