// 壁纸库＋风格家族＋壁纸遮罩分档
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 7707–7964 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
// ====== 壁纸库（成对主题背景＋挑选器，2026-10-02） ======
{
  const qcheck = (name, fn) => {
    try {
      const r = fn();
      if (r === false) { addFailed(); console.error('❌', name, '-> 断言未通过'); }
      else console.log('✓', name);
    } catch (e) {
      addFailed(); console.error('❌', name, '->', (e && e.message) || e);
    }
  };
  const cfgSrc = fs.readFileSync('src/static/js/config.js', 'utf8');
  const uiSrc = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const idxSrc = fs.readFileSync('src/static/index.html', 'utf8');
  const uhSrc = fs.readFileSync('src/static/js/utopia-html.js', 'utf8');
  const geSrc = fs.readFileSync('src/static/js/graph-export.js', 'utf8');

  qcheck('壁纸库：注册表成套、20 个 URL 与磁盘文件一一对应＋按模式存储键', () => {
    if (!cfgSrc.includes('const WALLPAPER_SETS = [')) throw new Error('config 缺 WALLPAPER_SETS');
    const ids = [...cfgSrc.matchAll(/id: '([a-z]+)', name/g)].map(m => m[1]);
    ['night', 'paper', 'mountain', 'neon', 'candy'].forEach(id => { if (!ids.includes(id)) throw new Error('缺套 ' + id); });
    const slots = (cfgSrc.match(/(?:land|port):/g) || []).length;
    if (slots !== 20) throw new Error('注册表槽位应 20（5 套×深浅×横竖），实得 ' + slots);
    // 字面量 URL 来自 paper/mountain/neon/candy 四套（星夜走常量引用），这 16 条逐个验磁盘
    const urls = [...cfgSrc.matchAll(/(?:land|port): '([^']+)'/g)].map(m => m[1]);
    if (urls.length !== 16) throw new Error('字面量 URL 应 16 条，实得 ' + urls.length);
    urls.forEach(u => { if (!fs.existsSync('src/static' + u)) throw new Error('缺资源文件：' + u); });
    ['DARK_LAND_URL', 'DARK_PORT_URL', 'LIGHT_LAND_URL', 'LIGHT_PORT_URL'].forEach(c => {
      if (!new RegExp('(land|port): ' + c).test(cfgSrc)) throw new Error('星夜套缺常量 ' + c);
    });
    if (!cfgSrc.includes("STORAGE_KEY_BG_DARK = 'phymathia_bg_dark'") || !cfgSrc.includes("STORAGE_KEY_BG_LIGHT = 'phymathia_bg_light'")) throw new Error('缺按模式存储键');
    return true;
  });

  qcheck('主题挑选器：按钮/面板/函数接线＋互斥双向＋重定位与预载入列', () => {
    if (!idxSrc.includes('id="themePickBtn"') || !idxSrc.includes('id="themePanel"')) throw new Error('index 缺按钮或面板');
    ['toggleThemePicker', 'renderThemePanel', 'pickTheme', 'pickStyleFamily', 'getWallpaperId', 'setWallpaper', 'currentWallpaperSet', 'themeDefaultFamily', 'themeSplitEnabled', 'setThemeSplit'].forEach(f => {
      if (!uiSrc.includes('function ' + f)) throw new Error('ui 缺 ' + f);
    });
    if (!cfgSrc.includes("STORAGE_KEY_THEME_SPLIT = 'phymathia_theme_split'")) throw new Error('config 缺深浅独立开关存储键');
    if (!cfgSrc.includes("STORAGE_KEY_STYLE_FAMILY_DARK = 'phymathia_style_family_dark'") || !cfgSrc.includes("STORAGE_KEY_STYLE_FAMILY_LIGHT = 'phymathia_style_family_light'")) throw new Error('config 缺分模式家族键');
    if (!uiSrc.includes('theme-split-row') || !uiSrc.includes('setThemeSplit(this.checked)')) throw new Error('挑选器缺深浅独立开关行');
    if (!/setWallpaper\(id, currentTheme === 'light' \? 'dark' : 'light'\)/.test(uiSrc)) throw new Error('联动模式点卡未双写另一侧（默认深浅同主题）');
    if (!/applyStyleFamily\(currentStyleFamily\(\)\);/.test(uiSrc)) throw new Error('缺家族重挂调用（翻转/初始化对齐）');
    if (!/WALLPAPER_SETS\.flatMap\(s => \[s\.dark\.land, s\.dark\.port, s\.light\.land, s\.light\.port\]/.test(uiSrc)) throw new Error('预载未走注册表');
    if (!uiSrc.includes("_repositionShownPanel('themePanel'")) throw new Error('T45 重定位未入列');
    // 互斥双向：主题挑选器关三个老面板，老面板也关它（2026-10-02 第二轮起 bgPanel/skinPanel 已并入 themePanel）
    if (!uiSrc.includes("['levelPanel', 'modelPanel', 'dataPanel'].forEach")) throw new Error('挑选器缺互斥列表');
    if (!/const themePanelEl = document\.getElementById\('themePanel'\);\s*\n\s*if \(themePanelEl\) themePanelEl\.classList\.remove\('show'\);/.test(uiSrc)) throw new Error('难度/模型/数据面板未关挑选器');
    if (idxSrc.includes('id="bgBtn"') || idxSrc.includes('id="skinBtn"') || idxSrc.includes('id="bgPanel"') || idxSrc.includes('id="skinPanel"')) throw new Error('旧壁纸/皮肤入口残留（应并入 themePanel）');
    return true;
  });

  qcheck('壁纸外发：单文件打包与画布导出跟随所选，viewer 包 typeof 常量兜底仍在', () => {
    if (!uhSrc.includes('getWallpaperId')) throw new Error('utopia 单文件外发未跟随所选壁纸');
    if (!geSrc.includes('typeof getWallpaperId') || !geSrc.includes('typeof WALLPAPER_SETS')) throw new Error('画布导出缺注册表尝试');
    if (!geSrc.includes("typeof DARK_LAND_URL === 'string'")) throw new Error('画布导出丢了常量兜底');
    return true;
  });

  qcheck('壁纸行为：默认星夜、按模式写键、非法 id 拒绝', () => {
    const r = vm.runInContext('(function(){'
      + 'if (typeof getWallpaperId !== "function") return "缺 getWallpaperId";'
      + 'if (typeof setWallpaper !== "function") return "缺 setWallpaper";'
      + 'if (getWallpaperId("dark") !== "night") return "缺省应回退星夜";'
      + 'if (setWallpaper("paper", "dark") !== true) return "合法 id 应成功";'
      + 'if (localStorage.getItem("phymathia_bg_dark") !== "paper") return "深色键未写";'
      + 'if (setWallpaper("mountain", "light") !== true) return "浅色设置失败";'
      + 'if (localStorage.getItem("phymathia_bg_light") !== "mountain") return "浅色键未写";'
      + 'if (setWallpaper("bogus", "dark") !== false) return "非法 id 应拒绝";'
      + 'if (getWallpaperId("dark") !== "paper") return "读取未反映所选";'
      + 'return "ok";'
      + '})()', sandbox);
    if (r !== 'ok') throw new Error(r);
    return true;
  });

  qcheck('深浅主题联动：默认点卡双写两侧、独立后各写各的、关闭收拢为当前侧', () => {
    const r = vm.runInContext('(function(){'
      // 先定死当前侧：沙箱的 currentTheme 是跨用例共享的（前面的主题翻转用例可能改过它）
      + 'if (typeof applyTheme === "function") applyTheme("dark");'
      + 'if (typeof themeSplitEnabled !== "function" || typeof setThemeSplit !== "function") return "缺 split 读写函数";'
      + 'if (themeSplitEnabled()) return "默认应为联动态";'
      + 'setWallpaper("night", "dark"); setWallpaper("night", "light");'
      + 'pickTheme("paper");'
      + 'if (localStorage.getItem("phymathia_bg_dark") !== "paper" || localStorage.getItem("phymathia_bg_light") !== "paper") return "联动模式点卡没双写两侧";'
      + 'if (localStorage.getItem("phymathia_style_family") !== "blueprint") return "联动点卡没重置家族默认（素纸→蓝图）";'
      + 'setThemeSplit(true);'
      + 'if (localStorage.getItem("phymathia_theme_split") !== "1") return "独立标志未写";'
      + 'if (localStorage.getItem("phymathia_style_family_dark") !== "blueprint" || localStorage.getItem("phymathia_style_family_light") !== "blueprint") return "开启独立没从共享值落种两侧家族键";'
      + 'setWallpaper("night", "light");'
      + 'pickTheme("mountain");'
      + 'if (localStorage.getItem("phymathia_bg_dark") !== "mountain") return "独立模式当前侧未写";'
      + 'if (localStorage.getItem("phymathia_bg_light") !== "night") return "独立模式误写另一侧（违背各挑各的）";'
      + 'if (localStorage.getItem("phymathia_style_family_dark") !== "inkstone") return "独立模式家族没写当前侧分键（山影→砚石）";'
      + 'if (localStorage.getItem("phymathia_style_family") !== "inkstone") return "独立模式共享键没镜像最近挑选";'
      + 'setThemeSplit(false);'
      + 'if (localStorage.getItem("phymathia_theme_split") !== "0") return "关闭标志未写";'
      + 'if (localStorage.getItem("phymathia_bg_light") !== localStorage.getItem("phymathia_bg_dark")) return "关闭独立没把壁纸收拢为同值";'
      + 'if (localStorage.getItem("phymathia_style_family_dark") !== null || localStorage.getItem("phymathia_style_family_light") !== null) return "关闭独立没摘分模式家族键";'
      + 'if (localStorage.getItem("phymathia_style_family") !== "inkstone") return "关闭独立共享键应取当前侧家族";'
      + 'return "ok";'
      + '})()', sandbox);
    if (r !== 'ok') throw new Error(r);
    return true;
  });
}

// ====== 风格家族（面板质感＋节点皮肤＋强调色一个开关，2026-10-02 第二轮） ======
{
  const qcheck = (name, fn) => {
    try {
      const r = fn();
      if (r === false) { addFailed(); console.error('❌', name, '-> 断言未通过'); }
      else console.log('✓', name);
    } catch (e) {
      addFailed(); console.error('❌', name, '->', (e && e.message) || e);
    }
  };
  const cfgSrc = fs.readFileSync('src/static/js/config.js', 'utf8');
  const uiSrc = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const idxSrc = fs.readFileSync('src/static/index.html', 'utf8');
  const cssSrc = fs.readFileSync('src/static/css/styles.css', 'utf8');
  const viewerSrc = fs.readFileSync('src/static/viewer.html', 'utf8');

  qcheck('风格家族：注册表五族齐全＝皮肤超集，主题默认搭配覆盖全部壁纸套', () => {
    if (!cfgSrc.includes('const STYLE_FAMILIES = [')) throw new Error('config 缺 STYLE_FAMILIES');
    const famKeys = [...cfgSrc.slice(cfgSrc.indexOf('const STYLE_FAMILIES')).slice(0, 2000).matchAll(/key: '([a-z]+)'/g)].map(m => m[1]);
    for (const k of ['aurora', 'blueprint', 'inkstone', 'neon', 'candy']) {
      if (!famKeys.includes(k)) throw new Error('家族缺 ' + k);
    }
    // 家族 ⊇ 皮肤：ui.js 皮肤注册表的每个 key 必须是家族（防两表漂移出「死家族/死皮肤」）
    const ui = fs.readFileSync('src/static/js/ui.js', 'utf8');
    const start = ui.indexOf('const GRAPH_NODE_SKINS');
    const skinKeys = [...ui.slice(start, ui.indexOf('];', start)).matchAll(/key:\s*'([a-z_]+)'/g)].map(m => m[1]);
    const orphan = skinKeys.filter(k => !famKeys.includes(k));
    if (orphan.length) throw new Error('皮肤注册表存在非家族 key：' + orphan.join(','));
    if (!cfgSrc.includes('const THEME_DEFAULT_FAMILY')) throw new Error('缺主题默认搭配表');
    for (const [wp, fam] of [['night', 'aurora'], ['paper', 'blueprint'], ['mountain', 'inkstone'], ['neon', 'neon'], ['candy', 'candy']]) {
      if (!cfgSrc.includes(wp + ": '" + fam + "'")) throw new Error('默认搭配缺 ' + wp + '→' + fam);
    }
    return true;
  });

  qcheck('风格家族：每族面板质感 CSS 齐备（深浅成对＋三档 tier＋降级＋强调色/输入框）', () => {
    const fams = ['blueprint', 'inkstone', 'neon', 'candy'];
    for (const k of fams) {
      if (!cssSrc.includes(`html[data-panel-skin="${k}"] .aurora-glass {`)) throw new Error(k + '：缺深色材质块');
      if (!cssSrc.includes(`html[data-theme="light"][data-panel-skin="${k}"] .aurora-glass {`)) throw new Error(k + '：缺浅色材质块（深浅必须成对）');
      for (const tier of ['--dialog', '--panel', '--plain']) {
        if (!cssSrc.includes(`html[data-panel-skin="${k}"] .aurora-glass${tier} {`)) throw new Error(k + '：缺 ' + tier + ' 档族化底色（弹窗/大面板会回落墨玻璃）');
      }
      if (!cssSrc.includes(`html[data-panel-skin="${k}"] .aurora-glass { --glass-tint:`)) throw new Error(k + '：缺无磨砂降级块');
      if (!cssSrc.includes(`html[data-panel-skin="${k}"] {\n      --accent:`)) throw new Error(k + '：缺强调色覆盖（家族强调色没接线）');
      if (!cssSrc.includes(`html[data-theme="light"][data-panel-skin="${k}"] {\n      --accent:`)) throw new Error(k + '：缺浅色强调色覆盖');
      if (!new RegExp(`html\\[data-panel-skin="${k}"\\] \\{[\\s\\S]*?--field-bg:`).test(cssSrc)) throw new Error(k + '：缺输入框底色覆盖（蓝图纸面贴墨蓝输入框）');
    }
    // 家族节必须待在 @supports 降级块之后：浅色极光切片（终点 @keyframes）不容家族冷色混入
    const famStart = cssSrc.indexOf('====== 风格家族面板质感');
    const keyframes = cssSrc.indexOf('@keyframes auroraDrift');
    if (famStart < 0 || famStart < keyframes) throw new Error('家族节位置错：必须在 auroraDrift/@supports 之后（smoke 浅色切片红线）');
    return true;
  });

  qcheck('风格家族：查看器跟随（Q13 拍板）＋顶栏收纳菜单接线', () => {
    // 查看器只读页双属性预置（无 ui.js，靠内联脚本＋CSS 属性选择器生效）
    if (!viewerSrc.includes("localStorage.getItem('phymathia_style_family')")) throw new Error('viewer 启动预置没读家族键');
    if (!/setAttribute\('data-panel-skin', fam\)/.test(viewerSrc)) throw new Error('viewer 缺 data-panel-skin 预置');
    // 顶栏 13→9：收纳菜单承载原 continent/quiz/data/clear 入口，函数仍可达
    for (const [id, fn] of [['knowledgeMenu', 'toggleKnowledgeMenu(event)'], ['moreMenu', 'toggleMoreMenu(event)'], ['themePickBtn', 'toggleThemePicker(event)']]) {
      if (!idxSrc.includes(`id="${id}"`) || !idxSrc.includes(fn)) throw new Error('顶栏缺 ' + id + ' 接线');
    }
    for (const fn of ['openContinentView()', 'toggleKnowledgePanel()', 'openQuiz()', 'openQuizGlobalDashboard()', 'toggleDataPanel(event)', 'clearChat()']) {
      if (!idxSrc.includes(fn)) throw new Error('收纳菜单缺原入口：' + fn);
    }
    if (idxSrc.includes('id="continent-btn"') && /id="continentBtn"/.test(idxSrc)) throw new Error('大陆独立按钮应已并入知识菜单');
    return true;
  });

  qcheck('知识菜单二级子菜单：知识检测悬停展开画布检测/检测总览（2026-10-03）', () => {
    const km = idxSrc.slice(idxSrc.indexOf('id="knowledgeMenu"'), idxSrc.indexOf('id="moreMenu"'));
    const hostPos = km.indexOf('menu-submenu-host');
    const smPos = km.indexOf('id="knowledgeQuizSubmenu"');
    const quizPos = km.indexOf('closeKnowledgeMenu(); openQuiz()');
    const globalPos = km.indexOf('openQuizGlobalDashboard()');
    if (hostPos < 0 || !km.includes('> 知识检测<')) throw new Error('知识菜单缺「知识检测」子菜单宿主项');
    if (!(hostPos < smPos && smPos < quizPos && quizPos < globalPos)) throw new Error('结构应为 知识检测宿主行 → 子面板（画布检测→检测总览）');
    if (!idxSrc.includes('检测总览') || idxSrc.includes('全局检测')) throw new Error('旧称「全局检测」不得回流（应为检测总览：侧栏磁贴/顶栏按钮/子菜单三处）');
    if (!km.includes('class="menu-submenu aurora-glass aurora-glass--compact"')) throw new Error('子面板未挂 aurora-glass 玻璃载体');
    if (!cssSrc.includes('.menu-submenu-host:hover .menu-submenu')) throw new Error('缺悬停展开 CSS（.menu-submenu-host:hover）');
    if (!uiSrc.includes('function toggleKnowledgeQuizSubmenu') || !uiSrc.includes('_closeKnowledgeQuizSubmenu()')) throw new Error('缺触屏点击兜底/关闭收起接线（ui.js）');
    if (!uiSrc.includes("if (panelId === 'knowledgeMenu') panel.style.overflowY = 'visible'")) throw new Error('知识菜单未放开内部滚动——_positionPanel 的 overflowY:auto 会把面板外子菜单裁掉');
    return true;
  });

  qcheck('飘浮符号随主题：每套 symbols 配置齐备＋换套重建接线', () => {
    const cfg = cfgSrc.slice(cfgSrc.indexOf('const WALLPAPER_SETS'), cfgSrc.indexOf('const STYLE_FAMILIES'));
    const counts = (cfg.match(/count: \d+/g) || []).length;
    if (counts !== 5) throw new Error('五套壁纸应各带 symbols.count，实得 ' + counts);
    if ((cfg.match(/color: 'var\(--sym-/g) || []).length !== 10) throw new Error('深浅×五套应 10 条符号配色（T166 起为令牌引用）');
    if (!uiSrc.includes('window.__syncFloatingSymbols')) throw new Error('缺符号重建入口 __syncFloatingSymbols');
    if (!uiSrc.includes('_desiredSymbolCount')) throw new Error('符号数量没按壁纸套取数');
    if (!/applyStyleFamily\(THEME_DEFAULT_FAMILY\[id\]/.test(uiSrc)) throw new Error('点主题卡没重置风格到默认（Q2 全套重置拍板）');
    if (!/window\.__syncFloatingSymbols\(\)/.test(uiSrc)) throw new Error('换套/切模式没触发符号同步');
    return true;
  });
}

// ===== 壁纸遮罩分档（2026-10-04 用户拍板）：深色全保留；浅色默认裸壁纸、仅星夜 20% 纱 =====
// 全部为静态源断言（同步、不碰共享键），追加在文件末尾安全。
{
  const stylesCss = fs.readFileSync('src/static/css/styles.css', 'utf8');
  const uiSrc = fs.readFileSync('src/static/js/ui.js', 'utf8');
  const expSrc = fs.readFileSync('src/static/js/graph-export.js', 'utf8');
  const utopiaSrc = fs.readFileSync('src/static/js/utopia-html.js', 'utf8');
  const wcheck = (name, fn) => {
    try { if (fn() === false) throw new Error('断言未通过'); console.log('✓', name); }
    catch (e) { addFailed(); console.error('❌', name, '->', (e && e.message) || e); }
  };
  const ruleBlock = (text, sel) => {
    const i = text.indexOf(sel);
    if (i < 0) return null;
    return text.slice(i, text.indexOf('}', i));
  };

  wcheck('壁纸遮罩：深色默认档 var(--overlay-bg)（压暗纱，与节点投影共用变量）', () => {
    const block = ruleBlock(stylesCss, '.bg-overlay {');
    if (!block) throw new Error('找不到 .bg-overlay 规则');
    if (!/background\s*:\s*var\(--overlay-bg\)/.test(block)) throw new Error('深色默认遮罩丢了');
    return true;
  });

  wcheck('壁纸遮罩：浅色默认裸壁纸，星夜×浅色 20% 奶白纱是唯一例外', () => {
    const light = ruleBlock(stylesCss, '[data-theme="light"] .bg-overlay');
    if (!light || !/background\s*:\s*none/.test(light)) throw new Error('浅色默认应 background:none');
    if (!stylesCss.includes('[data-theme="light"][data-wallpaper="night"] .bg-overlay')) throw new Error('缺星夜浅色档规则');
    if (!/rgba\(245,\s*240,\s*232,\s*0?\.2\)/.test(stylesCss)) throw new Error('纱色应为 rgba(245,240,232,0.2)');
    return true;
  });

  wcheck('壁纸套 id 上 DOM：updateBgImage 首载与 apply 两条路径都落 data-wallpaper', () => {
    if (!uiSrc.includes('function _markWallpaperSet')) throw new Error('缺 _markWallpaperSet');
    const seg = uiSrc.slice(uiSrc.indexOf('function updateBgImage'), uiSrc.indexOf('function updateBgImageDebounced'));
    if ((seg.match(/_markWallpaperSet\(\)/g) || []).length < 2) throw new Error('两条落地路径都要同步落属性');
    return true;
  });

  wcheck('导出链路跟随：PNG 压纱读真实 .bg-overlay、导出 HTML 浅色按壁纸套分档', () => {
    if (!expSrc.includes("querySelector('.bg-overlay')")) throw new Error('PNG 导出应读真实遮罩元素的计算色');
    if (expSrc.includes("getPropertyValue('--overlay-bg')")) throw new Error('PNG 导出不该直接读变量（浅色要按套归零）');
    if (!utopiaSrc.includes("wpLight === 'night' ? 'var(--utopia-veil-night)' : 'none'")) throw new Error('导出 HTML 浅色遮罩未按套分档');
    // T166：纱的色值在 styles.css 令牌区（导出包内联全部 CSS，包内 var() 可用）
    if (!/--utopia-veil-night:\s*rgba\(245,\s*240,\s*232,\s*\.2\)/.test(stylesCss)) throw new Error('星夜浅色纱令牌值不对');
    if (!utopiaSrc.includes("(typeof getWallpaperId === 'function') ? getWallpaperId('light') : 'night'")) throw new Error('导出 HTML 应传浅色壁纸套 id');
    return true;
  });
}
}
