// 大陆 v8.1–v8.12 几何/海岸线/海域换色系列
// T66（2026-10-08）拆分自 frontend_smoke.mjs 原 5663–6626 行，用例体逐字保留。
// 执行顺序由 ../frontend_smoke.mjs 的调用序列决定；本文件只追加同域用例，
// 改共享 localStorage 键且会 await 的用例须放 serial-*.mjs（串行边界契约，见 AGENTS.md）。
import { check, drain, addFailed, code, sandbox, vm, fs, loose, localStorage, storageData, readContinentSrc, M2_TOPIC_KEY, M2_SESSION, m2SeedQuizStats, m2WrongQuestion } from './_runner.mjs';

export function run() {
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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
  const src = readContinentSrc();
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

// ===== v8.9 岛色微差 + v8.10 真海岸线：T24 三/四试 =====
// 第三试（纯填色）用户实测「没看出区别」——半透明填色的物理天花板；第四试把剪影本身
// 雕出来（位移场采样岸线 + SVG 地皮）。这两条 check 防三件事：哈希盐退化（v8.4/v8.5
// 各踩过一次）、网格态漏回落、岸线幅度越界（内凹吃卡区 / 外凸挤走廊）。
check('graph-continent: v8.9 岛色微差（确定性 / 网格态不设变量 / 微差铺得开 / 两轴不相关 / 斑参数完备）', () => {
  const terrain = sandbox._continentTerrain;
  if (typeof terrain !== 'function') throw new Error('_continentTerrain 未暴露');
  const store = sandbox.localStorage;
  const STYLE_KEY = 'phymathia_continent_style';
  const prevMode = store.getItem(STYLE_KEY);
  const setMode = v => store.setItem(STYLE_KEY, v);
  const bad = [];
  try {
    setMode('organic');
    const sids = ['ki_9f3', 'ki_2a71', 'ki_44c0', '矢量分析', 'x', '', 'a|b'];
    for (const sid of sids) {
      const a = terrain(sid);
      if (JSON.stringify(a) !== JSON.stringify(terrain(sid))) bad.push('不确定：' + sid);
      if (!a || typeof a['--tn-h'] !== 'string' || a['--tn-s'] === undefined || a['--tn-l'] === undefined) {
        bad.push('岛色微差变量缺失：' + sid);
      }
      if (!Array.isArray(a && a.patches) || a.patches.length !== 3) bad.push('地貌斑不是 3 块：' + sid);
      else {
        const tones = new Set(a.patches.map(p => p.tone));
        if (!tones.has('hi') || !tones.has('lo') ||
            !(tones.has('midUp') || tones.has('midDown'))) bad.push('斑极性不全：' + sid);
        for (const p of a.patches) {
          for (const v of [p.frx, p.fry, p.fx, p.fy]) {
            if (!(v > -0.05 && v < 1.2) || typeof v !== 'number' || !isFinite(v)) {
              bad.push('斑比例越界/非数：' + sid + ' ' + JSON.stringify(p));
              break;
            }
          }
        }
      }
      if (a && /NaN|Infinity/.test(JSON.stringify(a))) bad.push('串里有非确定值：' + sid);
    }
    const lits = [], hues = [];
    for (let n = 0; n < 40; n++) {
      const v = terrain('ki_' + n.toString(16).padStart(4, '0'));
      lits.push(parseFloat(v['--tn-l']));
      hues.push(parseFloat(v['--tn-h']));
    }
    const spread = xs => Math.max(...xs) - Math.min(...xs);
    if (spread(lits) < 10) bad.push('明度微差没铺开（区间 ' + spread(lits).toFixed(1) + '%，满宽 18%）：盐退化');
    if (spread(hues) < 10) bad.push('色相微差没铺开（区间 ' + spread(hues).toFixed(1) + '°，满宽 20°）：盐退化');
    const corr = (xs, ys) => {
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
      return sxy / Math.sqrt(sxx * syy);
    };
    const r = corr(hues, lits);
    if (Math.abs(r) > 0.6) bad.push('色相与明度相关 r=' + r.toFixed(2) + '（两把盐退化了）');
    setMode('grid');
    for (const sid of sids) {
      if (terrain(sid) !== null) bad.push('网格态没有归零：' + sid);
    }
  } finally {
    if (prevMode === null || prevMode === undefined) store.removeItem(STYLE_KEY);
    else store.setItem(STYLE_KEY, prevMode);
  }
  if (bad.length) throw new Error(bad.slice(0, 6).join('\n    ') + '（共 ' + bad.length + ' 处）');

  // 静态契约：微差 calc 深浅两主题都在；岛色经 CSS 变量继承流进 SVG 地皮。
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const frag of ['calc(var(--region-h, 225) + var(--tn-h, 0))', 'calc(var(--region-h, 30) + var(--tn-h, 0))']) {
    if (!css.includes(frag)) throw new Error('岛色微差没进两套主题：' + frag);
  }
  const src = readContinentSrc();
  if (!/_continentTerrain\(rect\.sessionId\)/.test(src)) throw new Error('岛牌没接 --tn-*（岛色微差白做）');
  return true;
});

check('graph-continent: v8.10 真海岸线（确定性 / 网格态 null / 幅度不越界 / 岛与海域各接一处 / SVG 地皮契约）', () => {
  const coastPath = sandbox._continentCoastPath;
  if (typeof coastPath !== 'function') throw new Error('_continentCoastPath 未暴露');
  const store = sandbox.localStorage;
  const STYLE_KEY = 'phymathia_continent_style';
  const prevMode = store.getItem(STYLE_KEY);
  const setMode = v => store.setItem(STYLE_KEY, v);
  const bad = [];
  try {
    setMode('organic');
    // ① 确定性：同一块地、同一坐标永远同一条海岸
    const rects = [
      { x: 1000, y: 2000, w: 536, h: 240, key: 'ki_9f3' },
      { x: 300, y: 400, w: 300, h: 150, key: 'ki_2a71' },
      { x: 5000, y: 100, w: 2200, h: 1400, key: '矢量分析' },
    ];
    for (const rect of rects) {
      const kind = rect.w > 1000 ? 'region' : 'island';
      const a = coastPath(rect, kind);
      if (JSON.stringify(a) !== JSON.stringify(coastPath(rect, kind))) bad.push('不确定：' + rect.key);
      if (!a || typeof a.d !== 'string' || a.d.slice(-1) !== 'Z') bad.push('岸线 path 不完整：' + rect.key);
      // ② 幅度不越界：全部采样点必须落在「矩形 ± 各边上限」的包络盒里——内凹吃卡区
      //    或外凸挤走廊都会在这里现形（caps 见 layout.js，包络留 0.5 容差）
      // 包络盒只由**外凸**上限决定（内凹朝矩形内部走，永远落在 [0,w]×[0,h] 内）
      const caps = kind === 'region' ? { ox: 36, oyT: 26, oyB: 36 } : { ox: 18, oyT: 14, oyB: 20 };
      for (const p of a.pts) {
        if (p[0] < -caps.ox - 0.5 || p[0] > rect.w + caps.ox + 0.5 ||
            p[1] < -caps.oyT - 0.5 || p[1] > rect.h + caps.oyB + 0.5) {
          bad.push('岸线点越出包络盒：' + rect.key + ' → (' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ')');
          break;
        }
      }
      // ②a 内凹红线：岛的海湾不许切进卡区（PAD 18 / HEADER_H 36，卡角在 [18,w-18]×[54,h-18]）
      if (kind === 'island') {
        for (const p of a.pts) {
          if (p[0] > 18 && p[0] < rect.w - 18 && p[1] > 54 && p[1] < rect.h - 18) {
            bad.push('海湾切进卡区：' + rect.key + ' → (' + p[0].toFixed(1) + ',' + p[1].toFixed(1) + ')');
            break;
          }
        }
      }
      // ②b 限位必须真的生效：给一块海域配两座岛，岸线任何点到岛的扩边盒距离 ≥10
      //    （内凹夹住在 dist-12）；给一座岛配近邻，外凸后到邻岛距离 ≥10（夹在 dist-26）
      if (kind === 'region') {
        const isls = [{ x: rect.x + 100, y: rect.y + 120, w: 400, h: 200 },
                      { x: rect.x + rect.w - 520, y: rect.y + rect.h - 320, w: 420, h: 220 }];
        const b = coastPath(rect, 'region', isls);
        for (const p of b.pts) {
          const wx = rect.x + p[0], wy = rect.y + p[1];
          for (const o of isls) {
            const dx = Math.max(o.x - wx, 0, wx - (o.x + o.w));
            const dy = Math.max(o.y - wy, 0, wy - (o.y + o.h));
            if (Math.hypot(dx, dy) < 10) { bad.push('海湾吃进岛了：' + rect.key); break; }
          }
          if (bad.length) break;
        }
      } else {
        const near = { x: rect.x + rect.w + 60, y: rect.y, w: 300, h: 200 };  // 60px 外的邻岛
        const b = coastPath(rect, 'island', [near]);
        for (const p of b.pts) {
          const wx = rect.x + p[0], wy = rect.y + p[1];
          const dx = Math.max(near.x - wx, 0, wx - (near.x + near.w));
          const dy = Math.max(near.y - wy, 0, wy - (near.y + near.h));
          if (Math.hypot(dx, dy) < 10) { bad.push('岛岸线粘到邻岛了：' + rect.key); break; }
        }
      }
    }
    // ③ 参差：两块同尺寸地、不同位置/	key，岸线必须不同
    const d1 = coastPath({ x: 100, y: 100, w: 400, h: 200, key: 'a' }, 'island').d;
    const d2 = coastPath({ x: 130, y: 170, w: 400, h: 200, key: 'b' }, 'island').d;
    if (d1 === d2) bad.push('两块地岸线撞形（场采样失效）');
    setMode('grid');
    for (const rect of rects) {
      if (coastPath(rect, 'island') !== null) bad.push('网格态没有归零：' + rect.key);
    }
  } finally {
    if (prevMode === null || prevMode === undefined) store.removeItem(STYLE_KEY);
    else store.setItem(STYLE_KEY, prevMode);
  }
  if (bad.length) throw new Error(bad.slice(0, 6).join('\n    ') + '（共 ' + bad.length + ' 处）');

  // 静态契约：SVG 地皮 + is-coast 矩形外观关闭 + drop-shadow 跟剪影 + 印章不参与 +
  // 岛/海域各接线一处 + 网格态的老 CSS 规则原样保留。
  const src = readContinentSrc();
  if (!/_continentCoastPath\(rect, 'island', otherIslands\)/.test(src)) throw new Error('岛牌没接岸线（或没传邻岛限位）');
  if (!/!rect\.stamp && _continentCoastPath\(rect, 'region', islandsOfRegion\)/.test(src)) throw new Error('海域岸线没跳过印章态（或没传岛限位）');
  if ((src.match(/_continentGroundSvg\(/g) || []).length < 3) throw new Error('SVG 地皮构建器没接上（定义+两处调用）');
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const frag of ['.continent-cluster.is-coast', '.continent-region.is-coast',
    '.continent-region.is-gray.is-coast', '.continent-ground', 'drop-shadow',
    '--coast-band: hsla(var(--fill-h)', '--coast-line: hsla(var(--fill-h)',
    '--coast-line: var(--accent)']) {
    if (!css.includes(frag)) throw new Error('v8.10 CSS 契约缺失：' + frag);
  }
  // 岸带/岸线颜色的**使用**在 SVG 内联样式里（走 CSS 变量，主题与 hover 自动跟）
  for (const frag of ['stroke: var(--coast-band,', 'stroke: var(--coast-line,']) {
    if (!src.includes(frag)) throw new Error('SVG 地皮没用 CSS 变量上色：' + frag);
  }
  return true;
});

// ===== v8.12 有机态矩形外观收口：海域/岛的矩形框不许再回来 =====
// 病根（2026-10-07 用户报「海域改成了蜿蜒曲线，却仍留一个矩形框」）：`.is-coast` 关矩形
// 外观，靠的是「写在后面」＋同/低特异性。档位（has-region/r-light，0,3,0）与浅色主题
// （[data-theme="light"] .continent-region，同特异性后写）直接写 border-color/box-shadow/
// background，把关闭顶回去 —— 真机实测 21/25 块地算出矩形外观（浅色 4 片海域全中）。
// 现在矩形外观只由两条基类读变量画，档位/主题只喂 --plate-*/--region-*；这条契约扫全表：
// 除基类、is-coast 收口、故意的状态规则（hover/搜索命中/印章/收起/聚焦）外，任何选中
// 底盘的规则都不许再直接写矩形外观属性 —— 加了就当场红，不必等真机目检。
check('graph-continent: v8.12 大陆底盘矩形外观只许「基类 + is-coast 收口」写（档位/主题只喂变量）', () => {
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  // 底盘类：后面不许跟词字符或连字符（否则 .continent-cluster-head 这类子元素会误入）
  const PLATE = /\.continent-(?:region|cluster)(?![\w-])/;
  const RECT = /(?:^|;)\s*(background|background-color|background-image|border|border-color|border-top-color|border-right-color|border-bottom-color|border-left-color|box-shadow|border-radius)\s*:/;
  const STATE = /:hover|\.is-search-hit|\.is-stamp|\.is-collapsed|\.is-dim/;
  const offenders = [];
  for (const m of css.matchAll(/(^|[};])\s*([^{}@]+?)\s*\{([^}]*)\}/g)) {
    const sel = m[2].replace(/\s+/g, ' ').trim();
    if (!PLATE.test(sel) || !RECT.test(m[3])) continue;
    for (const part of sel.split(',')) {
      const p = part.trim();
      // 只看**主体**（最后一个复合选择器）：`.continent-cluster.r-pending .continent-domain-badge`
      // 这类规则的主体是徽标，底盘只是祖先，不算「给底盘写矩形外观」。
      const subject = p.split(/[\s>+~]+/).filter(Boolean).pop() || '';
      if (!PLATE.test(subject)) continue;
      if (p === '.continent-region' || p === '.continent-cluster') continue; // 基类：矩形外观唯一画手
      if (/\.is-coast/.test(p)) continue;                                     // 收口规则（关掉矩形）
      if (STATE.test(p)) continue;                                            // 故意的状态外观
      offenders.push(p);
    }
  }
  if (offenders.length) {
    throw new Error('这些规则直接写矩形外观会盖掉 .is-coast，请改喂 --plate-*/--region-* 变量：\n    ' +
      [...new Set(offenders)].slice(0, 8).join('\n    '));
  }
  // 基类必须只读变量（否则档位改变量也白搭）
  for (const frag of ['border: 1px solid var(--plate-line);', 'box-shadow: var(--plate-glow);',
    'border: 1.5px solid var(--region-line);', 'background: var(--region-fill);',
    'box-shadow: var(--region-glow);']) {
    if (!css.includes(frag)) throw new Error('基类没走矩形外观变量：' + frag);
  }
  if ((css.match(/--plate-glow:/g) || []).length < 2) throw new Error('--plate-glow 只给了深色主题（浅色主题要覆盖它）');
  if ((css.match(/--region-glow:/g) || []).length < 3) throw new Error('--region-glow 缺档（基类/浅色主题/灰档三处）');
  // 收口规则要四件全关（漏一件就是「海岸线画在框里」）
  for (const name of ['.continent-cluster.is-coast', '.continent-region.is-coast']) {
    const at = css.indexOf(name + ' {');
    if (at < 0) throw new Error('缺收口规则：' + name);
    const body = css.slice(at, css.indexOf('}', at));
    for (const decl of ['background: none', 'border-color: transparent', 'box-shadow: none', 'border-radius: 0']) {
      if (!body.includes(decl)) throw new Error(name + ' 没关掉矩形外观：' + decl);
    }
  }
});

check('graph-continent: v8.11 航线「跟海域色」与海域板同槽取色（T134 universe 口径一致）', () => {
  const hue = sandbox._continentRegionHue;
  const regions = sandbox._continentRegions;
  const stroke = sandbox._continentRouteStroke;
  if (typeof hue !== 'function' || typeof regions !== 'function' || typeof stroke !== 'function') {
    throw new Error('纯函数未暴露（regionHue / regions / routeStroke）');
  }
  // 造一个「带 universe 会换槽」的撞槽名：hash 逐字确定，首个命中恒定
  const A = '矢量分析', B = '守恒定律';
  let K = null;
  for (let i = 0; i < 500; i++) {
    const cand = '领域' + i;
    if (hue(cand, [A, B]) !== hue(cand, null)) { K = cand; break; }
  }
  if (K === null) throw new Error('500 个候选造不出撞槽对（hash 或 CONTINENT_HUE_COUNT 变了？）');
  const cl = (sid, n) => ({ sessionId: sid, title: sid, domain: K, domainConf: 0.9,
    domainSource: 'vote', itemCount: n,
    items: Array.from({ length: n }, (_, i) => ({ itemId: sid + '_' + i })) });
  const info = regions([cl('a', 2), cl('b', 1)], {}, [A, B]);
  if (!Array.isArray(info.domainList) || info.domainList.join() !== A + ',' + B) {
    throw new Error('regionInfo 没随产物带回 domainList（T134 契约缺失）');
  }
  const region = info.regions.find(r => r.key === K);
  if (!region) throw new Error('同领域两岛应成一片海域');
  if (region.hue !== hue(K, [A, B])) throw new Error('海域板取色口径漂了');
  // 航线「跟海域色」必须与海域板同槽——旧代码传 null 撞槽时分叉，这条会红
  const s = stroke({ color: 'region' }, { fromSession: 'a' }, info, 'dark');
  if (s.color !== 'hsla(' + region.hue + ', 62%, 64%, 0.85)') {
    throw new Error('航线取色与海域板不同槽：' + s.color + ' ≠ hsla(' + region.hue + ',…)');
  }
  // 兼容旧形态：手工构造、没有 domainList 的 regionInfo 退回单名占槽（不炸、仍有色）
  const legacy = stroke({ color: 'region' }, { fromSession: 'a' }, { bySid: info.bySid }, 'dark');
  if (legacy.color.indexOf('hsla(') !== 0) throw new Error('无 domainList 的 regionInfo 取色路径断了');
  return true;
});

check('graph-continent: v8.11 远景短名（纯函数封顶 / 空名兜底 / 双份 DOM / CSS 切档）', () => {
  const short = sandbox._continentShortName;
  if (typeof short !== 'function') throw new Error('_continentShortName 未暴露');
  if (short('梯度与优化方法基础', 6) !== '梯度与优化方') throw new Error('长名未按预算裁字');
  if (short('短名', 6) !== '短名') throw new Error('短名不该动');
  if (short('线性代数与矩阵论', 2) !== '线性') throw new Error('cap 下限 2');
  if (short('', 6) !== '未命名画布') throw new Error('空名兜底');
  if (short(null, 6) !== '未命名画布') throw new Error('null 兜底');
  if (short('  带空格  ', 6) !== '带空格') throw new Error('未 trim');
  const src = readContinentSrc();
  if ((src.match(/continent-cluster-title-short/g) || []).length !== 2) {
    throw new Error('短名 span 没在两个岛牌分支都接上');
  }
  if (src.indexOf('CONTINENT_HORIZON_NAME_CHAR_W') < 0 || src.indexOf('horizonCap') < 0) {
    throw new Error('远景名宽预算没接进渲染');
  }
  const css = fs.readFileSync('src/static/css/styles-panels.css', 'utf8');
  for (const frag of ['.continent-cluster-title-short { display: none; }',
    '.continent-world.lod-horizon .continent-cluster-title-full { display: none; }',
    '.continent-world.lod-horizon .continent-cluster-title-short { display: block; }',
    '.continent-world.lod-horizon .continent-domain-dot { display: none; }']) {
    if (!css.includes(frag)) throw new Error('v8.11 短名 CSS 契约缺失：' + frag);
  }
  return true;
});

check('graph-continent: v8.11 未投影卡计数上顶栏（T141 stats 接 orphans + tooltip 解释）', () => {
  const src = readContinentSrc();
  if (src.indexOf("(data.orphans ? ' · 未投影 ' + data.orphans + ' 张卡' : '')") < 0) {
    throw new Error('顶栏统计没接 orphans（T141）');
  }
  if (src.indexOf('缺标题或会话归属，投影不进大陆') < 0) throw new Error('orphan tooltip 解释缺失');
  return true;
});
}
