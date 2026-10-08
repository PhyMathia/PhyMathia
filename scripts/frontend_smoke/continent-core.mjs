// 知识大陆主契约（六文件组拼接源）
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 3068–5057 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export async function run() {
// ===== 知识大陆（graph-continent.js，大陆计划 v1）静态/沙箱回归 =====
// 分层不变量：主图是投影层，前端零写路径——绝不写 phymathia_graph_ 会话键；
// 下钻复用 switchToSession + goToKnowledgeNode，不自建切会话协议。

check('graph-continent: 打包块在场且零会话键写路径', () => {
  const marker = code.indexOf('/* graph-continent.js */');
  if (marker < 0) throw new Error('app.js 缺少 graph-continent.js 块（build_frontend.mjs 未注册？）');
  // 2026-10-04 T36 拆分后大陆是连续六块：切片须罩住整组（graph-continent.js …
  // graph-continent-view.js 之后才算出界），单块切片会漏掉 view 里的下钻通道。
  let end = code.indexOf('/* ', code.indexOf('/* graph-continent-view.js */') + 5);
  if (end < 0) end = code.length;
  const chunk = code.slice(marker, end);
  if (chunk.indexOf('/api/continent') < 0) throw new Error('块内没有 /api/continent 拉取');
  if (/phymathia_graph_/.test(chunk)) throw new Error('大陆模块不得读写会话图键 phymathia_graph_*');
  if (chunk.indexOf('phymathia_continent_view') < 0) throw new Error('视口记忆键缺失');
  if (chunk.indexOf('switchToSession') < 0 || chunk.indexOf('goToKnowledgeNode') < 0) {
    throw new Error('下钻必须复用既有 switchToSession/goToKnowledgeNode 通道');
  }
  // v2：主图唯一写路径是 KV continent_edges（现成端点），别的地方不许落笔
  if (chunk.indexOf('/api/kv/continent_edges') < 0) throw new Error('用户连线必须走 /api/kv/continent_edges');
  return true;
});

check('graph-continent: v2/v3 静态契约（撤销栈只记边操作 / 联运港 / 确认落笔口 / 透明层底）', () => {
  const src = readContinentSrc();
  if (!src.includes('CONTINENT_EDGES_API')) throw new Error('KV 端点常量缺失');
  if (!src.includes('_continentEdgeUndo')) throw new Error('边操作撤销栈缺失');
  if (!/undoEntry\)\s*_continentEdgeUndo\.push\((undoEntry)\)/.test(src)) throw new Error('提交必须带 undoEntry 才入栈（视口不入栈）');
  if (!src.includes('continent-node--boundary')) throw new Error('联运港皮肤类缺失');
  if (!src.includes('画成航线')) throw new Error('共享弹层缺「确认落笔」按钮');
  // 2026-10-03 词汇表统一守卫：旧称不得回流
  if (src.includes("画成大陆边") || src.includes("我的连线") || src.includes("暂无共享连线") || src.includes("座边界城市") || src.includes("清理断线")) throw new Error("大陆词汇表残留旧称（应为聚落/联运港/联运线/航线/断桥）");
  if (!src.includes('same_session')) throw new Error('同会话无效边未按断桥通道处理');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-user-link')) throw new Error('我的航线样式缺失');
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
  const src = readContinentSrc();
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

check('graph-continent: T133 主题重涂（重涂函数 / data-theme 属性监听 / 渲染期收集三件套）', () => {
  const src = readContinentSrc();
  if (!src.includes('function _continentRepaintRouteTheme(')) throw new Error('重涂函数缺失');
  if (!/attributeFilter:\s*\['data-theme'\]/.test(src)) throw new Error('未监听 <html> data-theme 属性变化');
  if (!src.includes('.graph-workspace.continent-open')) throw new Error('重涂缺「大陆开着」短路（关着重涂是白干）');
  if (!/_continentRouteEls\.push\(\{ halo: halo, path: path, dots: dots/.test(src)) throw new Error('渲染期未收集航线三件套');
  // 值断言：金档颜色确实随主题变（重涂走同一份 _continentRouteStroke，产出与重渲一致）
  const darkGold = sandbox._continentRouteStroke({}, { fromSession: 's1' }, null, 'dark').color;
  const lightGold = sandbox._continentRouteStroke({}, { fromSession: 's1' }, null, 'light').color;
  if (!darkGold || darkGold === lightGold) throw new Error('金档颜色未按主题区分');
  // 沙箱跑一遍重涂：stub 元素记账，确认 halo/path 涂 stroke、端珠涂 fill、颜色取 dark 档
  // （沙箱 document 是宽松代理，getAttribute 返回代理 ≠ 'light'，所以重涂必走 dark 档）
  const raw = vm.runInContext(`
    (() => {
      const rec = [];
      _continentRouteEls = [{
        style: {}, edge: { fromSession: 's1' },
        halo: { setAttribute: (k, v) => rec.push(['halo', k, v]) },
        path: { setAttribute: (k, v) => rec.push(['path', k, v]) },
        dots: [{ setAttribute: (k, v) => rec.push(['dot', k, v]) }],
      }];
      _continentRepaintRouteTheme();
      _continentRouteEls = [];
      return JSON.stringify(rec);
    })()
  `, sandbox);
  const paints = JSON.parse(raw);
  if (paints.length !== 3) throw new Error('重涂应触达 3 个元素（halo/核心线/端珠），实际 ' + paints.length);
  if (paints[0][1] !== 'stroke' || paints[2][1] !== 'fill') throw new Error('重涂写错属性：' + paints.map(p => p.join(':')).join(','));
  if (paints.some(p => p[2] !== darkGold)) throw new Error('重涂颜色与 _continentRouteStroke dark 档不一致');
  return true;
});

check('graph-continent: T136 双指捏合（纯函数锚点数学 / 夹取 / 退化输入拒动 / 指针登记清理）', () => {
  const step = sandbox._continentPinchStep(1, 100, 200, 10, 20, 150, 150);
  // 距离翻倍 → 缩放翻倍；初始中点下的世界点 (10,20) 钉在新中点 (150,150)：x=150-2×10, y=150-2×20
  if (!step || step.k !== 2 || step.x !== 130 || step.y !== 110) {
    throw new Error('捏合数学错：' + JSON.stringify(step));
  }
  // 夹取：缩放被压到 [MIN, MAX] 后 pan 仍按同一锚点公式重算（世界点不动）
  const zmin = vm.runInContext('CONTINENT_ZOOM_MIN', sandbox);
  const clampedMin = sandbox._continentPinchStep(1, 100, 1, 0, 0, 50, 50);
  if (!clampedMin || clampedMin.k !== zmin || clampedMin.x !== 50 || clampedMin.y !== 50) {
    throw new Error('下限夹取错：' + JSON.stringify(clampedMin));
  }
  const zmax = vm.runInContext('CONTINENT_ZOOM_MAX', sandbox);
  const clampedMax = sandbox._continentPinchStep(2, 100, 400, 5, 5, 100, 100);
  if (!clampedMax || clampedMax.k !== zmax) throw new Error('上限夹取错：' + JSON.stringify(clampedMax));
  // 退化：两指重叠（d0=0 / d=0）与任何非有限输入都必须拒动返回 null
  if (sandbox._continentPinchStep(1, 0, 100, 0, 0, 50, 50) !== null) throw new Error('d0=0 必须拒动');
  if (sandbox._continentPinchStep(1, 100, 0, 0, 0, 50, 50) !== null) throw new Error('d=0 必须拒动');
  if (sandbox._continentPinchStep(NaN, 100, 100, 0, 0, 50, 50) !== null) throw new Error('非有限输入必须拒动');
  // 挂点在场：锚定接进了指针事件、抬指/取消都清理指针登记
  const src = readContinentSrc();
  if (!src.includes('function _continentPinchAnchor(')) throw new Error('捏合锚定函数缺失');
  if (!/_continentPinchAnchor\(viewport\)/.test(src)) throw new Error('捏合未接进指针事件');
  if (!/_continentPointers\.delete\(e\.pointerId\)/.test(src)) throw new Error('指针登记未在抬指/取消时清理');
  return true;
});

check('graph-continent: T135/T142 开图加载态与顶栏折行（三路并行拉取 / spinner / 窄屏 wrap）', () => {
  const src = readContinentSrc();
  const openAt = src.indexOf('async function openContinentView');
  const openSrc = src.slice(openAt, openAt + 2600);
  if (!/Promise\.all\(\[\s*_continentLoadRegionOverrides\(\),\s*_continentLoadCorrectionCount\(\),\s*_continentFetchData\(\),?\s*\]\)/.test(openSrc)) {
    throw new Error('开图三路请求未并行（串行＝三倍往返白等）');
  }
  if (!/_continentCorrectionCount = loaded\[1\]/.test(openSrc)) throw new Error('纠正计数未从并行结果取回（图例脚注会照报 0）');
  if (!openSrc.includes('continent-loading-spin')) throw new Error('开图加载态缺失（冷启动白屏感）');
  if (openSrc.includes('_continentLoadCollapsed();') &&
      openSrc.indexOf('_continentLoadCollapsed();') > openSrc.indexOf('Promise.all')) {
    throw new Error('折叠态应在并行等待之前同步读（本地 localStorage 不占等待）');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!css.includes('.continent-loading-spin')) throw new Error('加载 spinner 样式缺失');
  if (!/animation:\s*continent-spin/.test(css)) throw new Error('spinner 动画缺失');
  if (!/\.continent-loading-spin\s*\{[^}]*animation:\s*none/.test(css)) {
    throw new Error('spinner 未给减少动态效果让路');
  }
  const topbarRule = css.match(/\.continent-topbar\s*\{[^}]*\}/);
  if (!topbarRule || !/flex-wrap:\s*wrap/.test(topbarRule[0])) throw new Error('顶栏未折行（窄屏溢出）');
  if (!topbarRule[0].includes('max-width')) throw new Error('顶栏未限宽（窄屏撑破视口）');
  return true;
});

check('graph-continent: T137 搜索扩界与截断明示（城市/海域行 / cap+1 探满 / 不带 extras 行为不变）', () => {
  const matches = sandbox._continentSearchMatches;
  const data = { clusters: [
    { sessionId: 's1', title: '梯度专题', itemCount: 1, items: [{ itemId: 'i1', title: '梯度', summary: '' }] },
  ] };
  const extras = {
    cities: [{ label: '梯度', sessions: 2 }, { label: '不相关', sessions: 3 }],
    regions: [{ key: 'math', name: '数学', sessions: 4, itemCount: 12 }],
  };
  // 不带 extras：行为逐字节不变（冻结契约不受扰）
  const base = matches(data, '梯度专题');
  if (base.length !== 1 || base[0].type !== 'island') throw new Error('基线行为变了');
  // 带 extras：岛名/卡/城市都可命中同一词（夹具里岛名「梯度专题」含「梯度」），
  // 排序＝岛、卡、城市（城市垫底）；海域命中带 key
  const both = matches(data, '梯度', 30, extras);
  if (both.length !== 3 || both[0].type !== 'island' || both[1].type !== 'item' || both[2].type !== 'city') {
    throw new Error('城市命中或排序错：' + JSON.stringify(both));
  }
  const region = matches(data, '数学', 30, extras);
  if (region.length !== 1 || region[0].type !== 'region' || region[0].key !== 'math') throw new Error('海域命中错');
  if (matches(data, '梯度', 1, extras).length !== 1) throw new Error('cap 截断失效');
  const src = readContinentSrc();
  if (!/_continentSearchMatches\(_continentData, q, CONTINENT_SEARCH_LIMIT \+ 1, extras\)/.test(src)) {
    throw new Error('搜索未用 cap+1 探满（截断不可见）');
  }
  if (!src.includes('仅显示前')) throw new Error('截断脚注缺失');
  if (!src.includes('function _continentSearchFocusCity') || !src.includes('function _continentSearchFocusRegion')) {
    throw new Error('城市/海域跳转缺失');
  }
  return true;
});

check('graph-continent: T138/T140/T139 岛悬停与卡展开与图例符号（expandAll 旗 / 收放钮 / 符号行）', () => {
  const measure = sandbox._continentMeasure;
  const big = { sessionId: 'x', items: Array.from({ length: 12 }, (_, i) => ({ itemId: 'i' + i, title: 't' + i })) };
  const capped = measure(big, false, 9);
  if (capped.shown !== 9) throw new Error('基线 cardCap 行为变了');
  const expanded = measure(Object.assign({}, big, { expandAll: true }), false, 9);
  if (expanded.shown !== 12) throw new Error('expandAll 未生效');
  const src = readContinentSrc();
  if (!/el\.title = '岛：'/.test(src)) throw new Error('岛悬停 title 缺失');
  if (!src.includes('data-island-expand')) throw new Error('展开钮缺失');
  if (!/_continentExpanded\[rect\.sessionId\]/.test(src)) throw new Error('展开态回显（收起钮）缺失');
  if (!/_continentRender\(_continentData\)/.test(src)) throw new Error('展开未走本地重渲（不该回源拉数据）');
  if (!src.includes('continent-legend-syms')) throw new Error('图例符号说明缺失');
  if (!src.includes('相邻的岛')) throw new Error('布局语义说明缺失');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  if (!/\.continent-cluster-more\s*\{[^}]*pointer-events:\s*auto/.test(css)) {
    throw new Error('展开钮接不到点击（head 整体是 pointer-events:none）');
  }
  if (!css.includes('.continent-legend-syms')) throw new Error('图例符号样式缺失');
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
    const before = sandbox.escapeHtml; // T171：恢复摘除前的值，别装恒等函数（那会泄漏给其后全部用例）
    sandbox.escapeHtml = undefined;
    try { return row({ key: 'k', size: 3, cards: [{ id: 'a', title: '<script>' }] }, null, null); }
    finally { sandbox.escapeHtml = before; }
  })();
  if (evil.includes('<script>')) throw new Error('候选行没转义标题（XSS）');
  // 静态契约：起名走 proxyChatWithModel（与问 Φ 同通道）、按钮触发（不自动）、
  // 建族写族表 KV 通道
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
  // T166：色值在 graph-override.css「知识大陆航线色」令牌区，JS 只产出令牌引用
  // （静态沙箱无 CSS，_continentRouteColor 退回令牌名）；「值对不对」改读 CSS 源断言，强度不变。
  const cssSrc = fs.readFileSync('src/static/css/graph-override.css', 'utf8');
  const cssVarVal = (name) => (cssSrc.match(new RegExp('--' + name + ':\\s*([^;]+);')) || [])[1] || '';
  const def = stroke(null, { fromSession: 's1' }, null);
  if (!def.color || def.width !== 2 || def.dash) throw new Error('默认样式错：' + JSON.stringify(def));
  if (!stroke({ dash: 'dashed', color: 'gold', width: 'thick' }, null, null).dash) throw new Error('线型未解析');
  if (stroke({ color: 'gold' }, null, null).color.indexOf('--route-gold') < 0) throw new Error('暖金档未指向航线令牌');
  // 「我画的路」默认观感（09-20）：默认色=暖色且按主题选色相——暗色暖金（217,164,65），
  // 浅色赭橙（191,91,27；浅色机器辐条 accent 本身是暗金，航线必须换色相而不是加深）；
  // region 算不出色相回落旧默认蓝
  const lightGold = stroke(null, { fromSession: 's1' }, null, 'light');
  if (lightGold.color.indexOf('--route-gold-light') < 0) {
    throw new Error('浅色主题航线未指向赭橙令牌：' + lightGold.color);
  }
  if (cssVarVal('route-gold-dark').indexOf('217') < 0 || cssVarVal('route-gold-light').indexOf('191') < 0
      || cssVarVal('route-gold-light').indexOf('163, 114, 47') >= 0) {
    throw new Error('航线 gold 两档令牌值不对：' + cssVarVal('route-gold-dark') + ' / ' + cssVarVal('route-gold-light'));
  }
  const regionFallback = stroke({ color: 'region' }, { fromSession: 's1' }, null).color;
  if (regionFallback.indexOf('--route-default') < 0 || cssVarVal('route-default').indexOf('74') < 0) {
    throw new Error('region 算不出色相时应回落默认蓝令牌：' + regionFallback);
  }
  // 静态：v7.2 的单条可调与全局开关、岛级落笔、编辑撤销；大陆模块零 window.prompt（U1 收编）
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
  if (!src.includes('_continentCityPopover')) throw new Error('城市弹层缺失');
  if (!src.includes('enterContinentSession(sid, iid)')) throw new Error('「去看」未复用下钻转场');
  if (!src.includes('continent-city')) throw new Error('城市节点类缺失');
  if (!src.includes('画成航线')) throw new Error('共享弹层缺「确认落笔」按钮');
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
  ['弱证据', '已被更具体的联运港覆盖', '超出每对上限', '超出全图上限', '无位可放'].forEach(label => {
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
  const src = readContinentSrc();
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

check('graph-continent: v8.13 海域换色（覆盖优先/改色不改键/脏值兜底/同源产物/图例入口）', () => {
  const regions = sandbox._continentRegions;
  const hueWith = sandbox._continentHueWithOverride;
  const norm = sandbox._continentNormHue;
  if (typeof regions !== 'function' || typeof hueWith !== 'function' || typeof norm !== 'function') {
    throw new Error('v8.13 纯函数未暴露（regions / hueWithOverride / normHue）');
  }
  const cl = (sid, domain, conf, n) => ({
    sessionId: sid, title: sid, domain: domain, domainConf: conf, domainSource: 'vote',
    itemCount: n, items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })),
  });
  const clusters = [
    cl('v1', '矢量分析', 0.95, 3), cl('v2', '矢量分析', 0.8, 1), cl('v3', '矢量分析', 0.5, 1),
    cl('keep', '守恒定律', 0.98, 1),
  ];
  const list = ['矢量分析', '守恒定律', '量子力学'];
  // 旧库形态（没写过 colors）：色相与今天逐字节同色，不许被改色通道扰动
  const base = regions(clusters, { renames: {}, assign: {} }, list);
  const baseHue = base.regions[0].hue;
  if (base.regions[0].hueCustom) throw new Error('没改过色的海域不该标 hueCustom');
  if (Number(baseHue) !== Number(hueWith('矢量分析', list, {}))) throw new Error('无覆盖时该等于确定性色槽');
  // 改了色：色相吃覆盖
  const painted = regions(clusters, { renames: {}, assign: {}, colors: { '矢量分析': 210 } }, list);
  if (painted.regions[0].hue !== 210) throw new Error('换色覆盖没生效：' + painted.regions[0].hue);
  if (!painted.regions[0].hueCustom) throw new Error('改过色的海域该标 hueCustom');
  // 改色不改键：分组/来源/岛集合都不动，只有色相动（颜色跟规范键走，不跟显示名走）
  if (painted.regions[0].key !== base.regions[0].key ||
      painted.regions[0].sessions.join() !== base.regions[0].sessions.join() ||
      painted.singles.join() !== base.singles.join()) throw new Error('改色不该动分组/散岛');
  const both = regions(clusters, { renames: { '矢量分析': '场论基础' }, assign: {}, colors: { '矢量分析': 210 } }, list);
  if (both.regions[0].name !== '场论基础' || both.regions[0].hue !== 210) {
    throw new Error('改名+换色叠加口径错（改名不该换色）');
  }
  // 脏值兜底：非数当没写（退回默认槽）；负数/超界归一化进 0–359
  if (hueWith('矢量分析', list, { '矢量分析': 'abc' }) !== baseHue) throw new Error('脏色相该退回默认槽');
  if (hueWith('矢量分析', list, null) !== baseHue) throw new Error('colors 缺席该退回默认槽');
  if (hueWith('矢量分析', list, { '矢量分析': -30 }) !== 330) throw new Error('负色相该归一化：' + hueWith('矢量分析', list, { '矢量分析': -30 }));
  if (hueWith('矢量分析', list, { '矢量分析': 999 }) !== 279) throw new Error('超界色相该取模：' + hueWith('矢量分析', list, { '矢量分析': 999 }));
  if (norm('abc') !== null || norm(750) !== 30) throw new Error('色相归一化口径错');
  // 「还原默认色」传的就是 null——Number(null)===0 会把复位写成色相 0（数字 0 才是合法色相）
  if (norm(null) !== null || norm(undefined) !== null || norm('') !== null) {
    throw new Error('空值必须归 null（否则复位会变成换成红色系）：' + [norm(null), norm(undefined), norm('')]);
  }
  if (norm(0) !== 0 || norm(359.6) !== 0) throw new Error('数字 0/取模口径错');
  // 同源：colors 随产物带走（航线「跟海域色」与次要领域色点都从它取色，不许各算各的）
  if (painted.colors['矢量分析'] !== 210) throw new Error('colors 没随产物带走');
  const src = readContinentSrc();
  if (!src.includes("op.kind === 'color'")) throw new Error('撤销栈缺 color 分支');
  // 载入/拷贝侧必须走同一个归一化（手改过 KV 的库：null/'' 当没写、负数取模）
  if (!src.includes('const hue = _continentNormHue(src.colors[k]);') ||
      !src.includes('const hue = _continentNormHue(rawColors[k]);')) {
    throw new Error('colors 载入/拷贝没走同一份归一化');
  }
  if (!src.includes('data-color="')) throw new Error('图例换色入口缺失');
  if (!src.includes('function _continentColorRegionMenu')) throw new Error('换色弹层缺失');
  if (!src.includes('_continentHueWithOverride(info.key, regionInfo.domainList, regionInfo.colors)')) {
    throw new Error('航线「跟海域色」没吃换色覆盖（颜色会与海域板分叉）');
  }
  if (!src.includes('_continentSecondaryDot(cluster, data.domainList, regionInfo.colors)')) {
    throw new Error('次要领域色点没吃换色覆盖');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  ['.continent-legend-color', '.continent-color-cell', '.continent-color-range',
   '.continent-color-preview', '.continent-color-cell.is-taken'].forEach(sel => {
    if (!css.includes(sel)) throw new Error('换色样式缺失：' + sel);
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
  if (!src.includes('continent-cluster-sub')) throw new Error('岛牌副行缺失');
  if (!src.includes('continentGuide')) throw new Error('顶栏空态引导元素缺失');
  if (src.indexOf('暂无联运港') < 0) throw new Error('空态引导文案缺失');
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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

check('graph-continent: 顶栏空态引导只留联运港那一句（空画布说明已删）', () => {
  // 2026-09-27 用户要求删掉「有 N 个画布还没有知识点…」——那是对用户自己数据的
  // 统计，不是可操作的引导。_continentEmptyCanvasCount 随之整体退役。
  // 留联运港那一句：它教的是机制（同一个概念跨岛会设起联运港），用户能做点什么。
  if (sandbox._continentEmptyCanvasCount !== undefined) {
    throw new Error('_continentEmptyCanvasCount 应已删除');
  }
  const src = readContinentSrc();
  if (src.indexOf('个画布还没有知识点') >= 0) throw new Error('空画布说明文案仍在');
  if (src.indexOf('window.getAllSessions') >= 0) throw new Error('不该再读前端会话清单');
  if (src.indexOf('暂无联运港') < 0) throw new Error('联运港引导被误删');
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


await drain();
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
  addFailed();
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
  addFailed();
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
}
