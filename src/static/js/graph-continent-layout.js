// ===== 知识大陆 · 布局引擎（亲缘排序/海域划分/网格与蛇形/抖动与位移场/海岸线/风格开关）=====
// 自 graph-continent.js 拆出（2026-10-04，T36）。本文件与其余 graph-continent-*.js 同为顶层经典脚本、共享全局声明，加载顺序以 scripts/build_frontend.mjs 的 entries 为准（本组连续、view 必须最后：window.* 测试导出在彼处集中执行）。
// 记 2 分（人的认定是最强证据）。主题层面的亲近用布局表达，一根线都不用画。
const CONTINENT_KIN_STRONG = 1;
const CONTINENT_KIN_WEAK = 0.3;
const CONTINENT_KIN_WEAK_CAP = 0.9;
const CONTINENT_KIN_EDGE = 2;

function _continentKinshipKey(a, b) {
  return String(a) < String(b) ? a + '|' + b : b + '|' + a;
}

// 亲缘矩阵：只统计画布上真实存在的会话对；返回 { 'a|b': 权重 }。
function _continentKinship(sessionIds, shared, userEdges) {
  const kin = {}, weak = {};
  const known = new Set(sessionIds || []);
  const add = (a, b, w) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = _continentKinshipKey(a, b);
    kin[key] = (kin[key] || 0) + w;
  };
  const addWeak = (a, b) => {
    if (!a || !b || a === b || !known.has(a) || !known.has(b)) return;
    const key = _continentKinshipKey(a, b);
    weak[key] = Math.min(CONTINENT_KIN_WEAK_CAP, (weak[key] || 0) + CONTINENT_KIN_WEAK);
  };
  (shared || []).forEach(s => {
    if (!s) return;
    const sids = (s.sessions || []).filter(sid => known.has(sid));
    const strong = s.strength === 'strong';
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        if (strong) add(sids[i], sids[j], CONTINENT_KIN_STRONG);
        else addWeak(sids[i], sids[j]);
      }
    }
  });
  // 弱证据封顶后合入（封顶按「对」算，与强证据/用户边的量纲分开）
  Object.keys(weak).forEach(key => { kin[key] = (kin[key] || 0) + weak[key]; });
  (userEdges || []).forEach(e => add(e.fromSession, e.toSession, CONTINENT_KIN_EDGE));
  return kin;
}

// 贪心链式排序：从亲缘总数最多的岛出发，每步走向与当前岛亲缘最高的下一座
// （并列看全局亲缘总数，再并列保持原序＝服务端最近更新序）。链 A→B→C→D 折进
// 网格时配合蛇形填充，行末与下一行行首上下相邻——亲缘链不会在对角线上断开。
// 无亲缘时每步并列都走原序：输出与输入同序，行为与 v5.1 完全一致（不引入回归）。
function _continentClusterOrder(clusters, shared, userEdges) {
  const list = (clusters || []).slice();
  if (list.length < 3) return list;  // 0–2 座岛怎么排都相邻，不必排
  const sids = list.map(c => String(c.sessionId || ''));
  // 刻意不接受外部传入的 kin：贪心链的并列裁决看 total[sid]，换一份作用域不同的表
  // 会改掉既有岛序，而 v5.2 的排序是冻结契约。v8.3 的间距分级另有自己的一份。
  const kin = _continentKinship(sids, shared, userEdges);
  const total = {};
  Object.keys(kin).forEach(key => {
    const pair = key.split('|');
    total[pair[0]] = (total[pair[0]] || 0) + kin[key];
    total[pair[1]] = (total[pair[1]] || 0) + kin[key];
  });
  const kinOf = (a, b) => kin[_continentKinshipKey(a, b)] || 0;
  const remaining = list.slice();
  let startIdx = 0;
  for (let i = 1; i < remaining.length; i++) {
    if ((total[sids[i]] || 0) > (total[sids[startIdx]] || 0)) startIdx = i;
  }
  const ordered = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length) {
    const cur = ordered[ordered.length - 1];
    let bestIdx = 0, bestKin = -1, bestTotal = -1;
    remaining.forEach((c, i) => {
      const k = kinOf(cur.sessionId, c.sessionId);
      const t = total[c.sessionId] || 0;
      if (k > bestKin || (k === bestKin && t > bestTotal)) {
        bestIdx = i; bestKin = k; bestTotal = t;
      }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

// ---------- v7.1a 海域层：把已有的领域归属画出来（纯函数，无 DOM） ----------
// 后端早就算得出每座岛属于哪个领域（v6 族表 + v7 softmax 评分核心），v7 之前这份归属
// 只用于「跨 ≥2 岛建一座城」——分类结果画不出来，用户看到的就只是 6 个同色等权方块。
// 这一层只做三件事：按领域分组（≥2 座岛才画板）、配色（同领域永远同色）、可纠正（KV）。

// 领域名 → 稳定色相。铁律②的视觉面：专家名单固定 → 色槽确定——内置名单先分配
// （表序固定，槽位永不动），自定义领域按 domainList 里的稳定顺序排在后面，新增
// 自定义只会影响排在其后的自定义项。>12 个活跃领域由 _continentRegions 并「其他」，
// 所以色槽永远够用。
function _continentStrHash(s) {
  let h = 5381;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function _continentRegionHue(name, universe) {
  const names = (universe && universe.length ? universe.slice() : [name]);
  if (names.indexOf(name) < 0) names.push(name);
  const taken = new Array(CONTINENT_HUE_COUNT).fill(false);
  for (let i = 0; i < names.length; i++) {
    let slot = _continentStrHash(names[i]) % CONTINENT_HUE_COUNT;
    let probe = 0;
    while (probe < CONTINENT_HUE_COUNT && taken[slot]) {
      slot = (slot + 1) % CONTINENT_HUE_COUNT;
      probe++;
    }
    if (names[i] === name) return Math.round(slot * (360 / CONTINENT_HUE_COUNT)) % 360;
    taken[slot] = true;
  }
  return 0;
}

// 用户改色（图例「换色」）的解析口：覆盖表里有键就吃覆盖，没有就退回上面的确定性色槽。
// 纯函数——覆盖表当参数传（不吃模块态），所以 smoke 与各处调用都能独立验。铁律不变：
// 色相仍由**规范领域键**决定，覆盖只改「这片海显示成什么色」，改名/挪岛/重排都不换色。
// 值统一归一化成 0–359 的整数（写入口已夹取，这里再兜一次脏数据）；非有限数当没写。
function _continentHueWithOverride(name, universe, colors) {
  if (colors && typeof colors === 'object' &&
      Object.prototype.hasOwnProperty.call(colors, name)) {
    const hue = Number(colors[name]);
    if (Number.isFinite(hue)) return ((Math.round(hue) % 360) + 360) % 360;
  }
  return _continentRegionHue(name, universe);
}

// T32 远景短名：远景档（lod-horizon）里岛牌升格成「大地名」，字号被 --cloud-k 放大后
// 长名必然省略号截断（真实库 13 岛里 4 个读不全）。给远景一份按字数封顶的短名——
// 全名/短名两份都进 DOM（一次渲染写死、缩放全程不碰 DOM 的约定不变），切档只切 CSS。
// cap 由调用方按岛宽算，本函数保持纯函数：只裁字，不量地。
function _continentShortName(title, cap) {
  const t = String(title == null ? '' : title).trim();
  if (!t) return '未命名画布';
  return t.length <= Math.max(2, cap | 0) ? t : t.slice(0, Math.max(2, cap | 0));
}

// 归属解析：后端概率 + 用户覆盖（KV continent_regions，优先级①）→ 每座岛的
// {key, tier, source}。tier 三档：solid（p≥0.7）/ light（0.4–0.7，「?」徽标）/
// pending（<0.4，中性灰不上地盘，进「待确认」）——「不确定也要可见」。
// 用户指派永远 solid（人说了算，conf=1）。查空是正常路径：没证据 → neutral。
function _continentRegions(clusters, overrides, domainList) {
  const assign = (overrides && overrides.assign) || {};
  const renames = (overrides && overrides.renames) || {};
  // 用户改色表（图例「换色」写的）：键＝规范领域键，值＝0–359 色相
  const colors = (overrides && overrides.colors && typeof overrides.colors === 'object')
    ? overrides.colors : {};
  const bySid = {};
  const groups = {};
  const pending = [];
  const neutral = [];
  (clusters || []).forEach(c => {
    const sid = String(c.sessionId || '');
    if (Object.prototype.hasOwnProperty.call(assign, sid)) {
      const key = assign[sid] || null;
      if (!key) { bySid[sid] = { key: null, tier: 'neutral', source: 'user' }; neutral.push(sid); return; }
      bySid[sid] = { key: key, tier: 'solid', conf: 1, source: 'user' };
      (groups[key] = groups[key] || []).push(sid);
      return;
    }
    const key = c.domain || null;
    const conf = Number(c.domainConf) || 0;
    if (!key) { bySid[sid] = { key: null, tier: 'neutral', source: '' }; neutral.push(sid); return; }
    if (conf < CONTINENT_CONF_LIGHT) {
      bySid[sid] = { key: key, tier: 'pending', conf: conf, source: c.domainSource || '' };
      pending.push({ sid: sid, domain: key, conf: conf, title: c.title || '' });
      return;
    }
    bySid[sid] = { key: key, tier: conf >= CONTINENT_CONF_SOLID ? 'solid' : 'light',
                   conf: conf, source: c.domainSource || '' };
    (groups[key] = groups[key] || []).push(sid);
  });
  // ≥2 座岛同领域才画海域板（单岛自成一国＝没有分组）；>12 片按岛数升序并「其他」
  let regions = [];
  const singles = [];
  Object.keys(groups).forEach(key => {
    if (groups[key].length >= 2) regions.push({ key: key });
    else singles.push.apply(singles, groups[key]);
  });
  regions.forEach(r => { r.sessions = groups[r.key].slice(); });
  if (regions.length > CONTINENT_HUE_COUNT) {
    const sorted = regions.slice().sort((a, b) => a.sessions.length - b.sessions.length);
    const tail = sorted.slice(0, regions.length - CONTINENT_HUE_COUNT + 1);
    const tailKeys = new Set(tail.map(r => r.key));
    const merged = [];
    tail.forEach(r => merged.push.apply(merged, r.sessions));
    regions = regions.filter(r => !tailKeys.has(r.key));
    if (merged.length >= 2) regions.push({ key: '其他', sessions: merged, merged: true });
    else singles.push.apply(singles, merged);
  }
  const itemCountOf = sid => {
    const c = (clusters || []).find(x => String(x.sessionId) === sid);
    return (c && c.itemCount) || 0;
  };
  regions.forEach(r => {
    r.name = r.merged ? '其他' : (renames[r.key] || r.key);
    r.hue = r.merged ? null : _continentHueWithOverride(r.key, domainList, colors);
    r.hueCustom = !r.merged && Object.prototype.hasOwnProperty.call(colors, r.key);
    r.itemCount = r.sessions.reduce((acc, sid) => acc + itemCountOf(sid), 0);
    const srcs = r.sessions.map(sid => bySid[sid].source);
    r.source = srcs.indexOf('user') >= 0 ? 'user'
      : srcs.indexOf('gate') >= 0 ? 'gate' : 'family';
    r.userNamed = !r.merged && Object.prototype.hasOwnProperty.call(renames, r.key);
  });
  // T134：domainList 随产物带走——航线「跟海域色」必须与海域板同一份 universe 取色
  //（_continentRegionHue 的线性探测占槽依赖 universe 全表），各传各的必在撞槽时分叉。
  // colors 同理随产物带走（v8.13 换色）：否则航线/次要色点算出来与海域板不同色
  return { regions: regions, singles: singles, neutral: neutral, pending: pending,
           bySid: bySid, domainList: domainList || null, colors: colors };
}

// ---------- 纯布局：簇网格摆放，簇内概念流式网格；坐标全部解析算出，无需 DOM 实测 ----------
// v7.1a 起拆两层：_continentLayoutGrid 管一块内怎么摆（蛇形网格，块=海域或散岛群），
// _continentRegionLayout 管块与块怎么摆（跨海域亲缘排序）。无海域时走旧单网格路径
// （行为与 v6 完全一致，不引入回归）。
// 测量一座岛的占地：v7.3 起吃两个折叠口径——collapsed（整岛收起只留岛牌）与
// cardCap（岛内只画前 N 张 +「另有 k 张」，显示层折叠、不删数据）
function _continentMeasure(c, collapsed, cardCap) {
  if (collapsed) {
    return {
      cluster: c, cols: 0, rows: 0, collapsed: true, shown: 0,
      w: CONTINENT_PAD * 2 + 300,
      h: 14 + CONTINENT_HEADER_H + 10,
    };
  }
  const all = (c.items || []);
  // T140「另有 k 张」可展开：cluster 带 expandAll 旗（点展开钮落进 _continentExpanded）
  // 就不设上限。旗缺席时逐字节旧行为——冻结契约不受扰
  const cap = (c && c.expandAll) ? 0 : cardCap;
  const shown = cap ? Math.min(all.length, cap) : all.length;
  const n = Math.max(1, shown);
  const cols = Math.min(CONTINENT_COLS, n);
  const rows = Math.ceil(n / cols);
  return {
    cluster: c, cols: cols, rows: rows, collapsed: false, shown: shown,
    w: Math.max(
      CONTINENT_PAD * 2 + cols * CONTINENT_NODE_W + (cols - 1) * CONTINENT_GAP,
      CONTINENT_ISLAND_MIN_W),
    h: CONTINENT_PAD * 2 + CONTINENT_HEADER_H + rows * CONTINENT_NODE_H + (rows - 1) * CONTINENT_GAP,
  };
}

// v8.3：相邻两组（列与列、行与行）之间的间距，按跨组岛对的亲缘强度分级。
// 返回长度 = 组数-1 的间距数组；组数 <2（单列/单行）或没有亲缘数据 → null，
// 调用方回落定值 CONTINENT_CLUSTER_GAP，**逐字节旧行为**。
//
// **取最大值而不是平均值**（试过平均，被数据教育了）：一条 3 列的边界上跨列岛对是
// 3×3 = 9 对，而贪心链式排序只保证**链上相邻**的两座岛亲缘——落到这条边界上的往往
// 只有 1 对。取平均等于把这个信号摊薄 9 倍，raw 只差 2px，肉眼根本看不出来（实测：
// 强亲缘 3 分的边界算出来 150 vs 150，等于没分级）。取最大值读作「这条边界上存在
// 跨组联系 → 两组是一个邻域 → 拉近」，语义也更贴产品主张。代价是列里混进一座无关岛
// 也会被带着靠拢——但列本来就是布局产物，链式排序已经把它们归堆了，可以接受。
//
// **再中心化是这条的生死线**：raw 的均值不一定是 base，直接用会让总宽时大时小——
// 世界一变大，适配 zoom 就被压小，跌过世界档阈值（v8.1 时是 0.55，v8.7 已降到 0.35）
// 会把所有概念卡整档 display:none，真机旅程当场断（v8.1 踩过一次，10/10 → 8/10）。
// 这里把每段间距减去「相对均值的偏移」，均值恰回 base：
// Σ间距 = (组数-1) × base，与定值布局**逐字节相等**，zoom/LOD/适配全部不受影响。
// 钳位只是防御：raw ∈ [100,150]、base=150，|偏移| ≤ 50 → final ∈ [100,200]，
// 实际永不触发（全体同值时偏移恒为 0），所以钳了也不破坏均值守恒。
function _continentKinGaps(groups, kin, base, min, max) {
  const n = (groups || []).length;
  if (n < 2 || !kin) return null;
  const lo = min === undefined ? CONTINENT_GAP_MIN : min;
  const hi = max === undefined ? CONTINENT_GAP_MAX : max;
  const raw = [];
  for (let b = 0; b < n - 1; b++) {
    let peak = 0;
    for (const sa of groups[b] || []) {
      for (const sb of groups[b + 1] || []) {
        const w = kin[_continentKinshipKey(sa, sb)] || 0;
        if (w > peak) peak = w;
      }
    }
    raw.push(base - (base - lo) * Math.min(1, peak / CONTINENT_GAP_KIN_FULL));
  }
  const mean = raw.reduce((s, g) => s + g, 0) / raw.length;
  return raw.map(g => Math.max(lo, Math.min(hi, base + (g - mean))));
}

// 一块内的岛摆进蛇形网格（列宽/行高统计与落位共用同一个 gridPos 映射——两处各写
// 一份会出现「岛摆进没按它撑宽的列」）。origin 是这块在世界里的左上角；items 按
// 测量时的折叠口径裁剪（岛内只画前 cardCap 张——显示层折叠，锚点卡是最早学的、必在前 N 张内）
// kin（v8.3，可选）：亲缘矩阵。给了就按亲缘强度给列间距/行间距分级（见
// _continentKinGaps）；不给、或亲缘表为空 → **定值 CONTINENT_CLUSTER_GAP，逐字节旧行为**。
// v5.2 那条拍板在这里**升级**了：共享的不再只是 gridPos 映射，还有 colGap/rowGap
// 两个数组——统计（colX/rowY/innerW）与落位（x/y）都只准读它们，否则会复现 v5.2 那个
// 「岛摆进没按它撑宽的列」的老 bug 变体。
function _continentLayoutGrid(measured, originX, originY, kin) {
  const placements = {};
  const clusterRects = [];
  const cols = Math.max(1, Math.ceil(Math.sqrt(measured.length)));
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  const colW = [], rowH = [];
  const colSids = [], rowSids = [];
  measured.forEach((m, i) => {
    const g = gridPos(i);
    colW[g.ci] = Math.max(colW[g.ci] || 0, m.w);
    rowH[g.ri] = Math.max(rowH[g.ri] || 0, m.h);
    const sid = String((m.cluster && m.cluster.sessionId) || '');
    (colSids[g.ci] = colSids[g.ci] || []).push(sid);
    (rowSids[g.ri] = rowSids[g.ri] || []).push(sid);
  });
  // 列间距/行间距（v8.3）：长度 = 列数-1 / 行数-1。拿不到分级时**显式填回定值数组**
  // （不能只填空数组——innerW 靠 sum(间距) 算，漏掉定值会让世界算小、罩不住岛）
  const fixedGaps = n => { const a = []; for (let i = 0; i < n - 1; i++) a.push(CONTINENT_CLUSTER_GAP); return a; };
  const colGap = _continentKinGaps(colSids, kin, CONTINENT_CLUSTER_GAP) || fixedGaps(colW.length);
  const rowGap = _continentKinGaps(rowSids, kin, CONTINENT_CLUSTER_GAP) || fixedGaps(rowH.length);
  // 两个累加器必须分开：以前列、行共用同一个 acc，worldW 实际拿到的是**行**的累加值
  // （worldW === worldH），多列布局下世界宽度被算小 → 适配画布按假宽度算，地图一开
  // 就被裁掉右半边（真机截图才发现：岛排到 x=1628，世界却声明 674 宽）
  // 间距改数组后不能再用「accX 减一个定值 GAP」——直接按内容宽求和，最不容易错
  const colX = [], rowY = [];
  let accX = 0;
  for (let i = 0; i < colW.length; i++) { colX.push(accX); accX += colW[i] + colGap[i]; }
  let accY = 0;
  for (let i = 0; i < rowH.length; i++) { rowY.push(accY); accY += rowH[i] + rowGap[i]; }
  const innerW = Math.max(0, colW.reduce((s, w) => s + w, 0) + colGap.reduce((s, g) => s + g, 0));
  const innerH = Math.max(0, rowH.reduce((s, h) => s + h, 0) + rowGap.reduce((s, g) => s + g, 0));
  measured.forEach((m, i) => {
    const g = gridPos(i);
    const x = originX + colX[g.ci] + (colW[g.ci] - m.w) / 2;
    const y = originY + rowY[g.ri] + (rowH[g.ri] - m.h) / 2;
    clusterRects.push({
      sessionId: m.cluster.sessionId, title: m.cluster.title || '',
      x: x, y: y, w: m.w, h: m.h, cx: x + m.w / 2, cy: y + m.h / 2,
      itemCount: (m.cluster.items || []).length,
      shownCount: m.shown !== undefined ? m.shown : (m.cluster.items || []).length,
      collapsed: !!m.collapsed,
    });
    if (!m.collapsed) {
      // 卡网格在块内水平居中：块宽被岛牌下限撑宽时卡不歪在一边。
      // **按行各自居中**（v8.2）：末行不满时按整列宽左对齐会在岛牌右侧空出一大块
      // 缺角（5 卡岛空 206px），岛是矩形、内容却缺角，一眼就是「摆出来的」。
      // 块宽仍按满列算，**岛宽/世界尺寸/海域板/zoom 一律不动**。
      // 满行时 rowCols === cols，rowW === gridW，与旧公式逐字节一致。
      const shown = m.shown !== undefined ? m.shown : (m.cluster.items || []).length;
      const rowW = rowCols => rowCols * CONTINENT_NODE_W + (rowCols - 1) * CONTINENT_GAP;
      (m.cluster.items || []).slice(0, shown).forEach((item, j) => {
        const icol = j % m.cols, irow = Math.floor(j / m.cols);
        const inRow = Math.min(m.cols, shown - irow * m.cols);
        const nx = x + (m.w - rowW(inRow)) / 2 + icol * (CONTINENT_NODE_W + CONTINENT_GAP);
        const ny = y + CONTINENT_PAD + CONTINENT_HEADER_H + irow * (CONTINENT_NODE_H + CONTINENT_GAP);
        placements[item.itemId] = {
          x: nx, y: ny, w: CONTINENT_NODE_W, h: CONTINENT_NODE_H,
          cx: nx + CONTINENT_NODE_W / 2, cy: ny + CONTINENT_NODE_H / 2,
        };
      });
    }
  });
  return { placements: placements, clusterRects: clusterRects, w: innerW, h: innerH };
}

function _continentLayoutClusters(clusters, collapsed, cardCap, kin) {
  const collapsedSet = new Set((collapsed && collapsed.sessions) || []);
  const cap = cardCap === undefined ? CONTINENT_ISLAND_CARD_MAX : cardCap;
  const measured = (clusters || []).map(c => _continentMeasure(c, collapsedSet.has(c.sessionId), cap));
  const grid = _continentLayoutGrid(measured, CONTINENT_WORLD_MARGIN, CONTINENT_WORLD_MARGIN, kin);
  const worldW = Math.max(400, grid.w + CONTINENT_WORLD_MARGIN * 2);
  const worldH = Math.max(300, grid.h + CONTINENT_WORLD_MARGIN * 2);
  return { placements: grid.placements, clusterRects: grid.clusterRects,
           regionRects: [], worldW: worldW, worldH: worldH };
}

// 两级布局（v7.1a）：先按海域分块——块内岛走既有亲缘排序 + 蛇形填充；块间按
// 「跨海域亲缘总和」降序（并列按海域名稳定序，散岛块永居末位）排进块级网格，
// 间距用更大的 REGION_GAP。海域板 = 块内岛矩形并集外扩（顶部多留一行给海域牌）。
// worldW/H 必须罩住**海域板**（板比岛并集大一圈）——否则边缘板上的联运港会被
// 判「出界」折叠。
function _continentRegionLayout(regions, bySid, clusters, shared, userEdges, collapsed) {
  const collapsedSet = new Set((collapsed && collapsed.sessions) || []);
  const collapsedRegions = new Set((collapsed && collapsed.regions) || []);
  const cap = CONTINENT_ISLAND_CARD_MAX;
  const byKey = {};
  (clusters || []).forEach(c => {
    const sid = String(c.sessionId || '');
    const info = bySid[sid] || {};
    const key = info.key || '';
    (byKey[key] = byKey[key] || []).push(c);
  });
  // 块定义：每片海域一块（板），单岛领域 + 中性 + 待确认合成一块「散岛」（无板）；
  // 收起的海域整块收成一枚印章（岛不占位不渲染），展开回来布局不变（确定性）
  const blocks = [];
  regions.forEach(r => blocks.push({ key: r.key, name: r.name, plate: true,
    stamp: collapsedRegions.has(r.key), clusters: byKey[r.key] || [] }));
  const loose = [];
  Object.keys(byKey).forEach(key => {
    if (!key) { loose.push.apply(loose, byKey[key]); return; }
    const inRegion = regions.some(r => r.key === key);
    if (!inRegion) loose.push.apply(loose, byKey[key]); // 单岛领域：不上板，进散岛块
  });
  if (loose.length) blocks.push({ key: '', name: '', plate: false, stamp: false, clusters: loose });

  // 块内亲缘排序（复用 v5.2 的贪心链式）；块间按跨块亲缘总和排序。
  // 收起的海域整块收成**一枚**印章（岛不占位不渲染）——多枚印章叠着看全局
  const laid = blocks.map(b => {
    // 排序**刻意不共用**下面的全局 kin：贪心链的并列裁决看 total[sid]，块内表只含
    // 同块权重、全局表还含跨海域权重，换成全局会改掉既有的岛序（v5.2 冻结契约）。
    // 间距分级用全局表没问题——它对同块内的取值与块内表逐字节相同。
    const ordered = _continentClusterOrder(b.clusters, shared, userEdges);
    const measured = b.stamp
      ? [{ cluster: ordered[0] || { sessionId: '', items: [] }, stamp: true,
          w: 190, h: 48, shown: 0, collapsed: true }]
      : ordered.map(c => _continentMeasure(c, collapsedSet.has(c.sessionId), cap));
    return { block: b, measured: measured, sids: ordered.map(c => String(c.sessionId || '')) };
  });
  const allSids = (clusters || []).map(c => String(c.sessionId || ''));
  const kin = _continentKinship(allSids, shared, userEdges);
  const crossKin = {};
  laid.forEach(a => laid.forEach(b => {
    if (a === b) return;
    a.sids.forEach(sa => b.sids.forEach(sb => {
      const w = kin[_continentKinshipKey(sa, sb)] || 0;
      if (w) crossKin[a.block.key + '\u0000' + b.block.key] =
        (crossKin[a.block.key + '\u0000' + b.block.key] || 0) + w;
    }));
  }));
  const blockWeight = key => {
    let sum = 0;
    Object.keys(crossKin).forEach(pairKey => {
      const parts = pairKey.split('\u0000');
      if (parts[0] === key || parts[1] === key) sum += crossKin[pairKey];
    });
    return sum;
  };
  laid.sort((a, b) => {
    const ka = a.block.plate ? blockWeight(a.block.key) : -1;
    const kb = b.block.plate ? blockWeight(b.block.key) : -1;
    if (ka !== kb) return kb - ka;
    if (a.block.plate && b.block.plate) return String(a.block.name).localeCompare(String(b.block.name), 'zh');
    return a.block.plate ? -1 : 1;  // 散岛块永居末位（无板无名，不参与海域排序）
  });

  // 块级网格：与岛级同一套 colW/rowH 逻辑，间距换 REGION_GAP；先按内容尺寸摆好块，
  // 再在块内部按「板框 = 内容外扩」重排——板的 padding 计入块尺寸，岛内相对坐标不变
  const cols = Math.max(1, Math.ceil(Math.sqrt(laid.length)));
  const blockW = [], blockH = [];
  laid.forEach(l => {
    // 探针与落位（下面 :590 那次）**必须喂同一份 kin**，否则板尺寸按一套间距算、
    // 岛坐标按另一套摆，岛会捅出板。v8.3 的间距分级让这条从「无所谓」变成硬约束。
    const grid = _continentLayoutGrid(l.measured, 0, 0, kin);
    l.grid = grid;
    l.paddedW = grid.w + (l.block.plate ? CONTINENT_REGION_PAD * 2 : 0);
    l.paddedH = grid.h + (l.block.plate ? CONTINENT_REGION_PAD * 2 + CONTINENT_REGION_HEADER_H : 0);
  });
  const gridPos = i => {
    const ri = Math.floor(i / cols), posInRow = i % cols;
    return { ci: ri % 2 === 1 ? cols - 1 - posInRow : posInRow, ri: ri };
  };
  laid.forEach((l, i) => {
    const g = gridPos(i);
    blockW[g.ci] = Math.max(blockW[g.ci] || 0, l.paddedW);
    blockH[g.ri] = Math.max(blockH[g.ri] || 0, l.paddedH);
  });
  const colX = [], rowY = [];
  let accX = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < blockW.length; i++) { colX.push(accX); accX += blockW[i] + CONTINENT_REGION_GAP; }
  let accY = CONTINENT_WORLD_MARGIN;
  for (let i = 0; i < blockH.length; i++) { rowY.push(accY); accY += blockH[i] + CONTINENT_REGION_GAP; }

  const placements = {};
  const clusterRects = [];
  const regionRects = [];
  laid.forEach((l, i) => {
    const g = gridPos(i);
    const bx = colX[g.ci] + (blockW[g.ci] - l.paddedW) / 2;
    const by = rowY[g.ri] + (blockH[g.ri] - l.paddedH) / 2;
    const originX = bx + (l.block.plate ? CONTINENT_REGION_PAD : 0);
    const originY = by + (l.block.plate ? CONTINENT_REGION_PAD + CONTINENT_REGION_HEADER_H : 0);
    const grid = _continentLayoutGrid(l.measured, originX, originY, kin);
    Object.assign(placements, grid.placements);
    // 收起成印章的海域：岛不渲染（clusterRects 不进），板自己就是那枚印章
    if (!l.block.stamp) clusterRects.push.apply(clusterRects, grid.clusterRects);
    if (l.block.plate) {
      regionRects.push({
        key: l.block.key, x: bx, y: by, w: l.paddedW, h: l.paddedH,
        cx: bx + l.paddedW / 2, cy: by + l.paddedH / 2,
        stamp: !!l.block.stamp,
      });
    }
  });
  const worldW = Math.max(400, accX - CONTINENT_REGION_GAP + CONTINENT_WORLD_MARGIN);
  const worldH = Math.max(300, accY - CONTINENT_REGION_GAP + CONTINENT_WORLD_MARGIN);
  return { placements: placements, clusterRects: clusterRects,
           regionRects: regionRects, worldW: worldW, worldH: worldH };
}

// ---------- v8.1 有机抖动层 ----------
// 铁律：**只从 _continentRender 调用，绝不塞进 _continentLayoutClusters /
// _continentRegionLayout**。那两个纯函数是 smoke 直接调、逐字节断言返回值的冻结
// 契约（3 卡岛宽 === 536、1 卡岛宽 >= 240、卡在块内居中、世界罩住岛、两次输出
// 逐字节一致）。抖动一旦混进去，上述断言当场红——这条不许回退。
//
// 偏移按层级**复合**：卡的世界坐标 = 原坐标 + 海域偏移 + 岛偏移 + 卡偏移。
// 所以板跟着岛一起平移、岛带着卡一起平移，板内岛、岛内卡永远不会错位。
// 海域板另外按 CONTINENT_JITTER_ISLAND 四周外扩——板比它的岛大一圈，岛不会
// 捅出海岸线（smoke「岛完整落在板内」这条就是钉这个的）。
//
// **世界尺寸一个像素都不许长**（v8.1 的第二版口径，踩过坑）：布局四周本来就留了
// CONTINENT_WORLD_MARGIN = 60 的白边，抖动的最大外伸必须**装进这 60px 里**，所以
// worldW/worldH 原样透传。注意海域板自己还要按 CONTINENT_JITTER_ISLAND 外扩，
// 所以预算是 **JITTER_REGION + JITTER_ISLAND ≤ 60**（v8.5：12 + 40 = 52），
// 不是三段相加——卡不外扩板，不进这条。
// 为什么这么较真：世界一大，适配画布的 zoom 就被压小，一压小就跌过世界档阈值
// （v8.5 时是 0.55，v8.7 已降到 0.35），世界档会把所有概念卡整档 display:none——
// 「开图点得到卡」的真机旅程当场断（第一版给四周各留 80px，continent_regression
// 从 10/10 掉到 8/10 就是这么掉的）。世界尺寸不变 = zoom、LOD、适配全部逐字节不变。

// 确定性伪随机源：FNV-1a 32 位哈希 → [-1,1]。绝不用 Math.random()——那会让位置
// 每次刷新都跳，也直接违反布局确定性契约。同一 ID 永远得到同一偏移。
function _continentJitter1(key, salt) {
  const s = String(key == null ? '' : key) + '' + salt;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h / 4294967296) * 2 - 1;
}

// 取某个 key 的两轴偏移：盐不同 → 同一个 key 的 x/y 互不相关，不会走出对角线
// **盐必须把差异放在靠前的位置、后面还跟几个字符**（v8.5 踩过的坑，v8.4 已记过一次）：
// 盐是拼在 key **末尾**的，而 FNV-1a 是逐字节左到右推进的 —— 两个盐若只差末字符
// （'x' vs 'y'、'wx' vs 'wy'），差异之后只再乘一轮素数，输出几乎不动。
// 实测现役盐 'x'/'y' 的 x、y 分量**相关系数 0.97**：位移几乎全部沿 45° 对角线走，
// 整张图读成「整体往右下斜滑了一截」，而不是各向散开。smoke 原来那条
// 「两轴同值（会走对角线）」只查了 x !== y 这种精确不等，**根本没测出这件事**。
// 换成差异在第 0 位、后面跟 3 个字符的 'x-off'/'y-off' 后降到 0.07。
function _continentJitterOffset(key, amp) {
  if (!amp) return { x: 0, y: 0 };
  return { x: _continentJitter1(key, 'x-off') * amp, y: _continentJitter1(key, 'y-off') * amp };
}

// ---------- v8.5 低频位移场：世界坐标 → 平滑标量场 ----------
// 确定性 value noise：把世界切成 cell 大小的格，格点值用**同一个** FNV-1a 哈希派生
// （确定性白拿，格点值域 [-1,1]），格内双线性插值并对插值系数过 smoothstep。
//
// **为什么是 smoothstep 而不是线性插值**：线性插值在格边处一阶导数跳变，位移场会
// 在每条格线上留下一道折痕（放大看是规则斜纹，正是要消灭的「整齐」）。smoothstep
// 3t²-2t³ 的导数在两端归零，场处处 C¹，弯出来的曲线才真的没有折角。
//
// **梯度上界（可证的，不是调出来的）**：∂f/∂x 只经由 smoothstep 的导数 6t(1-t)
// （t=0.5 处取 1.5）进入，而格点值域是 [-1,1]、**差值可到 2**，所以
// 单八度 |∇n| ≤ 2×1.5/cell = **3/cell**。
// （第一版这里写成 1.5/cell，是把「值域半幅 1」当成了「差值上界」——实测最坏
// 0.00486 vs 该式的 0.00268，正好差 2 倍。数字是量出来的，别再手推。）
function _continentWarp1(x, y, cell, salt) {
  const gx = x / cell, gy = y / cell;
  const ix = Math.floor(gx), iy = Math.floor(gy);
  const fx = gx - ix, fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const v00 = _continentJitter1(ix + ',' + iy, salt);
  const v10 = _continentJitter1((ix + 1) + ',' + iy, salt);
  const v01 = _continentJitter1(ix + ',' + (iy + 1), salt);
  const v11 = _continentJitter1((ix + 1) + ',' + (iy + 1), salt);
  return (v00 + (v10 - v00) * sx) * (1 - sy) + (v01 + (v11 - v01) * sx) * sy;
}

// 两轴位移。x/y 用互不相干的盐（'x-warp'/'y-warp'、'x-warp2'/'y-warp2'），**盐的差异
// 必须在靠前位置**——见 _continentJitterOffset 上方那段：第一版用 'wx'/'wy'（只差末字符），
// 实测两轴相关系数 0.98，场整体沿对角线推，等于白费。改成 0.036。
//
// **WARP_NORM 这个 1/√2 不是凑的，是补一个真实的漏洞**：两个八度权重和为 1，所以
// **逐轴** |分量| ≤ amp，但 x 与 y 是两个独立场，二维模长的上界是逐轴的 √2 倍。
// 不归一化就会实测到 max|offset| = 1.26×amp——而上面「间距 100 - 2×44 仍隔 12px」
// 与「外伸装进 60px 白边」两条硬约束全是按 2×amp 推的，不归一化等于**按错的数
// 算预算**。除掉 √2 之后 |offset| ≤ amp 严格成立（无 clamp、不引入折角），
// 两条约束的推导才站得住。实测复核：max|offset|/amp ≤ 1。
function _continentWarpOffset(x, y, amp) {
  if (!amp) return { x: 0, y: 0 };
  const n = CONTINENT_WARP_NORM;
  return {
    x: amp * n * (CONTINENT_WARP_W_COARSE * _continentWarp1(x, y, CONTINENT_WARP_CELL_COARSE, 'x-warp')
                + CONTINENT_WARP_W_FINE * _continentWarp1(x, y, CONTINENT_WARP_CELL_FINE, 'x-warp2')),
    y: amp * n * (CONTINENT_WARP_W_COARSE * _continentWarp1(x, y, CONTINENT_WARP_CELL_COARSE, 'y-warp')
                + CONTINENT_WARP_W_FINE * _continentWarp1(x, y, CONTINENT_WARP_CELL_FINE, 'y-warp2')),
  };
}

// ---------- v8.4 海岸线：每块地自己的圆角 ----------
// 动的是 **border-radius 一个属性**，位置/尺寸/worldW/worldH 一个像素都不碰——所以
// 下面所有冻结布局断言（3 卡岛宽===536、世界罩住、两次逐字节一致）全都不受影响。
// 写法：8 值椭圆角（4 个横半径 / 4 个竖半径，序 左上·右上·右下·左下），
// 每个都是 calc(var(--r-xl) * 系数) 而不是裸 px——基准圆角仍走令牌，将来改
// --r-xl 时海岸线跟着一起变，不会漂成一个写死的数字。CSS 变量名带 --r- 前缀是因为
// smoke 的设计尺子只放行 var(--r-*) 开头的圆角值。
// 为什么顶角小于底角：板头文字在 top:8（海域）/top:9（岛）、left:22/10，顶角太大
// 曲线会啃到第一个字；底角没有文字，让它放开才像岸、不像被啃过的方块。
const CONTINENT_COAST_TOP_LO = 0.5;
const CONTINENT_COAST_TOP_HI_ISLAND = 1.35;   // 顶角封顶：护住岛牌那行字
const CONTINENT_COAST_TOP_HI_REGION = 1.7;    // 海域板头 left:22，可以宽松些
const CONTINENT_COAST_BOT_LO = 0.8;
const CONTINENT_COAST_BOT_HI_ISLAND = 2.2;
const CONTINENT_COAST_BOT_HI_REGION = 2.6;
const CONTINENT_COAST_ASPECT = 0.42;          // 竖半径 = 横半径 × [0.58, 1]：斜角才不像同一个模子

// 盐必须是**词**、不能是 'ch0'/'ch1' 这种只差末字符的编号：FNV-1a 是逐字节左到右
// 推进的，末字节差 1 之后只再乘一轮素数，输出几乎不动。实测 400 个真实 sessionId：
// 编号盐下相邻两角系数平均只差 0.013（满量程 2.0，四角等于没抖、还是左右对称），
// 换成 coast-tl/tr/br/bl + h/v 词盐后是 0.66。这条不许回退成编号盐。
const CONTINENT_COAST_CORNER = ['coast-tl', 'coast-tr', 'coast-br', 'coast-bl'];

// 短边装不下的角**不用自己夹**：CSS 规范规定同一盒子上所有圆角在超出边长时按同一
// 系数等比缩小，所以「收成印章的小方块」和 3×3 大岛都自动收敛，不会切出方块。
function _continentCoast(key, kind) {
  if (_continentStyleMode() === CONTINENT_STYLE_GRID) return '';   // 网格态回落到 --r-xl，逐像素等于今天
  const isRegion = kind === 'region';
  const k = String(key == null ? '' : key) + '|' + kind;  // key 也进哈希：两座岛不会长成一个形状
  const hs = [], vs = [];
  for (let i = 0; i < 4; i++) {
    const top = i < 2;
    const lo = top ? CONTINENT_COAST_TOP_LO : CONTINENT_COAST_BOT_LO;
    const hi = top
      ? (isRegion ? CONTINENT_COAST_TOP_HI_REGION : CONTINENT_COAST_TOP_HI_ISLAND)
      : (isRegion ? CONTINENT_COAST_BOT_HI_REGION : CONTINENT_COAST_BOT_HI_ISLAND);
    const m = lo + (hi - lo) * (_continentJitter1(k, CONTINENT_COAST_CORNER[i] + '-h') * 0.5 + 0.5);
    const v = m * (1 - CONTINENT_COAST_ASPECT * (_continentJitter1(k, CONTINENT_COAST_CORNER[i] + '-v') * 0.5 + 0.5));
    hs.push('calc(var(--r-xl) * ' + m.toFixed(2) + ')');
    vs.push('calc(var(--r-xl) * ' + v.toFixed(2) + ')');
  }
  return hs.join(' ') + ' / ' + vs.join(' ');
}

// ===== v8.9 填色地貌 + v8.10 真海岸线（backlog T24 第三/四试）=====
// 5a（差异化圆角）整图缩放下只「不再是同一个模子」；5b（clip-path＋SVG 岸线）败在填色
// 太透——换了形状仍是「描了个边」，已完整回退（v8.4/v8.6 两节有案）。v8.6 把填色抬起
// 来之后，第三试（v8.9，纯填色：岛色微差＋半透明地貌斑）用户实测「没看出区别」——
// **半透明填色叠在壁纸上，明度差落到屏幕只剩几个 RGB 点，这是填色层的物理天花板**。
// 于是按 v8.6 节预告的顺序走到轮廓：第四试（v8.10）把每块地皮的剪影本身雕出来。
// **挪岛与雕岸线用同一条 v8.5 位移场**（_continentWarp1，世界坐标纯函数）：弯曲连贯、
// 像地质、不像噪声，确定性白拿。内凹不越过卡区（PAD 18 / 岛牌 top 9），外凸不挤压
// 城市走廊（各边分设上限，见 CONTINENT_COAST_CAPS）。网格态返回 null → 逐字节今天。
// **盐的规矩（v8.5 踩了两次的坑）**：差异必须放在盐的靠前位置、后面再跟几个字符——
// 'x-high'/'y-high' 可以，'tn-hx'/'tn-hy' 这种差异在末字符的会退化成对角线。
function _continentTerrain(key) {
  if (_continentStyleMode() === CONTINENT_STYLE_GRID) return null;
  const k = String(key == null ? '' : key) + '|terrain';
  const u = salt => _continentJitter1(k, salt) * 0.5 + 0.5;   // [-1,1] → [0,1]
  // 三块地貌斑（v8.9）：高地（亮）/洼地（暗）/极性哈希翻转的中斑——有的岛两高一洼、
  // 有的两洼一高。坐标半径全是**占地比例**（0~1），渲染层换算成 px 画进 SVG。
  // 透明度系数 >1（1.3/1.1/0.9 × --fill-1）：斑要比底填充更实才读得出来；
  // light/pending 档 --fill-1 只有 0.15，乘上去仍然温和，不盖档位语义。
  const P = (salt, frx0, frxW, fry0, fryW, fx0, fxW, fy0, fyW, tone, dL) => ({
    frx: frx0 + u(salt + '-rx') * frxW, fry: fry0 + u(salt + '-ry') * fryW,
    fx: fx0 + u(salt + '-x') * fxW, fy: fy0 + u(salt + '-y') * fyW,
    tone, dL,
  });
  return {
    '--tn-h': String(Math.round(u('hue-tn') * 20 - 10)),  // 色相 ±10
    '--tn-s': (u('sat-tn') * 12 - 6).toFixed(1) + '%',    // 饱和 ±6%
    '--tn-l': (u('lit-tn') * 18 - 9).toFixed(1) + '%',    // 明度 ±9%
    patches: [
      P('high', 0.30, 0.25, 0.26, 0.24, 0.25, 0.50, 0.20, 0.35, 'hi', 13),
      P('basin', 0.26, 0.22, 0.24, 0.22, 0.25, 0.50, 0.45, 0.40, 'lo', -11),
      P('mid', 0.24, 0.22, 0.22, 0.22, 0.22, 0.56, 0.22, 0.56,
        u('pol-mid') > 0.5 ? 'midUp' : 'midDown', u('pol-mid') > 0.5 ? 7 : -7),
    ],
  };
}

// ===== v8.10 岸线参数 =====
// 内凹/外凸分边上限（世界 px）。内凹红线：岛牌在 top:9/left:10，卡区从 PAD 18 + HEADER_H 36
// 开始——顶边内凹 ≤4、左边 ≤8 保证文字永远在岸内，底/右 ≤14 < PAD 18 保证卡不悬进水里；
// 海域没卡，内凹放宽（再被「到最近岛的距离」逐点夹住，见下），但顶 ≤6（板头 top:8）、
// 左边板名区另有 90px 护栏。外凸吃的是岛间走廊：岛的外凸被「到最近邻岛的距离-26」逐点
// 夹住（两岛相向最多各长一段，永不粘连），海域外凸 ≤36（板间距实测充裕）。
const CONTINENT_COAST_CAPS = {
  island: { outTop: 14, outSide: 18, outBottom: 20, inTop: 4, inSide: 8, inBottom: 14 },
  region: { outTop: 26, outSide: 36, outBottom: 36, inTop: 6, inSide: 44, inBottom: 44 },
};
const CONTINENT_COAST_SAMPLES = { island: 56, region: 96 };  // 沿边采样数：段短才平滑
// 三档波长：粗 900 造整岛级的大弯、**中 420 造海湾/半岛（杀「方形」的主力）**、细 170 造
// 岸线的小曲。v8.5 的教训：只有粗+细，中间尺度空缺，直边仍然读成直边。
const CONTINENT_COAST_CELL = { c: 900, m: 420, f: 170 };
// 底形圆角（杀「方形」第二刀）：顶角保持小（护住岛牌/板头文字），**底角开大弧**。
// 上限由「卡角留在岸内」反推：pad p 的角在圆心距 √2(r-p) 内必须 ≤ r ⇒ r ≤ 2+p×√2/(√2-1)…
// 解出岛（pad 18）r ≤ 43、海域（pad 26）r ≤ 62，取整留余量。
const CONTINENT_COAST_RADIUS = {
  island: { topLo: 12, topHi: 18, botLo: 28, botHi: 42 },
  region: { topLo: 16, topHi: 22, botLo: 46, botHi: 60 },
};

// 岸线：沿**圆角矩形**底形走一圈（底角大弧），每点沿外法线按三档位移场推拉，中点二次
// 贝塞尔闭合平滑。others＝同图其余地块（海域传本海域的岛、岛传其余岛），用于逐点夹住
// 幅度：海域内凹不许吃岛（dist-12），岛外凸不许粘邻岛（dist-26）。返回 { d, pts }；
// 网格态 null。rect.x/y 是**抖动后**的世界坐标——岸线场采样与这座岛被挪到的位置天然连续，
// 同一块地每次刷新是同一条海岸。
function _continentCoastPath(rect, kind, others) {
  if (_continentStyleMode() === CONTINENT_STYLE_GRID) return null;
  const caps = CONTINENT_COAST_CAPS[kind] || CONTINENT_COAST_CAPS.island;
  const n = CONTINENT_COAST_SAMPLES[kind] || CONTINENT_COAST_SAMPLES.island;
  const rad = CONTINENT_COAST_RADIUS[kind] || CONTINENT_COAST_RADIUS.island;
  const isRegion = kind === 'region';
  const k = String(rect.key == null ? rect.sessionId : rect.key) + '|coastshape|' + kind;
  const u = salt => _continentJitter1(k, salt) * 0.5 + 0.5;
  // 每角独立半径（v8.4「每块地自己的圆角」精神搬进剪影）：顶角小、底角大
  const rTL = rad.topLo + u('r-tl') * (rad.topHi - rad.topLo);
  const rTR = rad.topLo + u('r-tr') * (rad.topHi - rad.topLo);
  const rBR = rad.botLo + u('r-br') * (rad.botHi - rad.botLo);
  const rBL = rad.botLo + u('r-bl') * (rad.botHi - rad.botLo);
  const w = rect.w, h = rect.h;
  // 八段底形：4 直边 + 4 圆弧，样点按段长分配
  const TAU2 = Math.PI / 2;
  const segs = [
    { len: w - rTL - rTR, cap: 'top',    p: t => [rTL + t * (w - rTL - rTR), 0],
      nn: () => [0, -1] },
    { len: TAU2 * rTR, cap: 'top',       p: t => { const a = -TAU2 + t * TAU2; return [w - rTR + Math.cos(a) * rTR, rTR + Math.sin(a) * rTR]; },
      nn: t => { const a = -TAU2 + t * TAU2; return [Math.cos(a), Math.sin(a)]; } },
    { len: h - rTR - rBR, cap: 'side',   p: t => [w, rTR + t * (h - rTR - rBR)],
      nn: () => [1, 0] },
    { len: TAU2 * rBR, cap: 'bottom',    p: t => { const a = t * TAU2; return [w - rBR + Math.cos(a) * rBR, h - rBR + Math.sin(a) * rBR]; },
      nn: t => { const a = t * TAU2; return [Math.cos(a), Math.sin(a)]; } },
    { len: w - rBR - rBL, cap: 'bottom', p: t => [w - rBR - t * (w - rBR - rBL), h],
      nn: () => [0, 1] },
    { len: TAU2 * rBL, cap: 'bottom',    p: t => { const a = TAU2 + t * TAU2; return [rBL + Math.cos(a) * rBL, h - rBL + Math.sin(a) * rBL]; },
      nn: t => { const a = TAU2 + t * TAU2; return [Math.cos(a), Math.sin(a)]; } },
    { len: h - rBL - rTL, cap: 'side',   p: t => [0, h - rBL - t * (h - rBL - rTL)],
      nn: () => [-1, 0] },
    { len: TAU2 * rTL, cap: 'top',       p: t => { const a = Math.PI + t * TAU2; return [rTL + Math.cos(a) * rTL, rTL + Math.sin(a) * rTL]; },
      nn: t => { const a = Math.PI + t * TAU2; return [Math.cos(a), Math.sin(a)]; } },
  ];
  const total = segs.reduce((a, s) => a + s.len, 0);
  const clampCap = (base, px, py, fieldV) => {
    let cap = fieldV > 0
      ? (base === 'top' ? caps.outTop : base === 'bottom' ? caps.outBottom : caps.outSide)
      : (base === 'top' ? caps.inTop : base === 'bottom' ? caps.inBottom : caps.inSide);
    if (!others || !others.length) return cap;
    if (isRegion && fieldV < 0) {
      // 海域内凹：不许越过任何一座岛（留 12px 水面）；板头区（左上 150×90）再压到 14
      let lim = Math.min(cap, Math.max(rect.w, rect.h) * 0.14);
      const wx = rect.x + px, wy = rect.y + py;
      for (const o of others) {
        const dx = Math.max(o.x - wx, 0, wx - (o.x + o.w));
        const dy = Math.max(o.y - wy, 0, wy - (o.y + o.h));
        lim = Math.min(lim, Math.max(0, Math.hypot(dx, dy) - 12));
      }
      if (px < 150 && py < 90) lim = Math.min(lim, 14);
      cap = lim;
    }
    if (!isRegion && fieldV > 0) {
      // 岛外凸：不许逼近邻岛（留 26px = 双方各长一段的余量）
      let lim = cap;
      const wx = rect.x + px, wy = rect.y + py;
      for (const o of others) {
        const dx = Math.max(o.x - wx, 0, wx - (o.x + o.w));
        const dy = Math.max(o.y - wy, 0, wy - (o.y + o.h));
        lim = Math.min(lim, Math.max(0, Math.hypot(dx, dy) - 26));
      }
      cap = lim;
    }
    return cap;
  };
  const pts = [];
  for (let i = 0; i < n; i++) {
    let d = (i / n) * total, si = 0;
    while (si < segs.length - 1 && d > segs[si].len) { d -= segs[si].len; si++; }
    const seg = segs[si], t = seg.len > 0 ? d / seg.len : 0;
    const bp = seg.p(t), nn = seg.nn(t);
    const fieldV = 0.35 * _continentWarp1(rect.x + bp[0], rect.y + bp[1], CONTINENT_COAST_CELL.c, 'coast-c')
                 + 0.40 * _continentWarp1(rect.x + bp[0], rect.y + bp[1], CONTINENT_COAST_CELL.m, 'coast-m')
                 + 0.25 * _continentWarp1(rect.x + bp[0], rect.y + bp[1], CONTINENT_COAST_CELL.f, 'coast-f');
    const cap = clampCap(seg.cap, bp[0], bp[1], fieldV);
    const disp = fieldV * cap;
    pts.push([bp[0] + nn[0] * disp, bp[1] + nn[1] * disp]);
  }
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const f1 = v => (Math.round(v * 10) / 10).toString();
  const m0 = mid(pts[n - 1], pts[0]);
  let dStr = 'M ' + f1(m0[0]) + ' ' + f1(m0[1]);
  for (let i = 0; i < n; i++) {
    const p = pts[i], q = mid(p, pts[(i + 1) % n]);
    dStr += ' Q ' + f1(p[0]) + ' ' + f1(p[1]) + ' ' + f1(q[0]) + ' ' + f1(q[1]);
  }
  return { d: dStr + ' Z', pts };
}

// 有机/网格开关（渲染层偏好，非会话键：换会话不该换画风）
// 查阅态：切换只在内存生效（_continentStyleMem 影子），跳过落盘——重渲读影子才
// 不会弹回；非查阅恒 null 走 localStorage，路径零改动
let _continentStyleMem = null;
function _continentStyleMode() {
  if (_continentStyleMem !== null) return _continentStyleMem;
  try {
    const v = localStorage.getItem(CONTINENT_STYLE_KEY);
    return v === CONTINENT_STYLE_GRID ? CONTINENT_STYLE_GRID : CONTINENT_STYLE_ORGANIC;
  } catch (e) { return CONTINENT_STYLE_ORGANIC; }
}

function _continentToggleStyleMode() {
  const next = _continentStyleMode() === CONTINENT_STYLE_ORGANIC
    ? CONTINENT_STYLE_GRID : CONTINENT_STYLE_ORGANIC;
  if (phyIsReadonly()) { _continentStyleMem = next; _continentReadonlyNudge(); return next; }
  try { localStorage.setItem(CONTINENT_STYLE_KEY, next); } catch (e) { /* 容忍 */ }
  return next;
}

// 按钮文案显示**切过去会变成什么**，不是当前是什么——和「主题」钮一个口径
function _continentSyncStyleBtn() {
  const btn = document.getElementById('continentStyleBtn');
  if (!btn) return;
  const organic = _continentStyleMode() === CONTINENT_STYLE_ORGANIC;
  btn.textContent = organic ? '网格' : '有机';
  btn.classList.toggle('is-on', !organic);
  btn.title = (organic
    ? '当前：有机——岛与卡在网格里各偏一点、带厚度。点此切回整齐网格'
    : '当前：网格——整齐正交。点此切到有机画风');
}

// 有机化的纯函数：吃一份布局结果，吐一份视觉坐标全部就位的布局结果。
// grid 态原样返回输入（零偏移、零旋转、worldW/H 不变）——「关掉 = 今天的字节」。
//   layout            —— _continentLayoutClusters / _continentRegionLayout 的返回值
//   itemSession       —— {itemId: sessionId}，卡归属哪座岛（placements 里没有这字段）
//   regionOfSession   —— {sessionId: regionKey}，岛归属哪片海域
function _continentJitter(layout, itemSession, regionOfSession) {
  if (_continentStyleMode() === CONTINENT_STYLE_GRID) {
    return {
      placements: layout.placements, clusterRects: layout.clusterRects,
      regionRects: layout.regionRects || [], worldW: layout.worldW, worldH: layout.worldH,
      cardRot: {}, organic: false,
    };
  }
  // 板偏移按 key 缓存：同一片海域的所有岛必须挂在同一个 (jx,jy) 上
  // v8.5：板按**自己的板心**采样位移场。板比场粗（560）小得多，板内场近似恒定，
  // 整块一起漂——读起来像一整块地层，而不是板内每座岛各漂各的。
  const regionOff = {};
  const regionOf = regionOfSession || {};
  const regionByKey = {};
  (layout.regionRects || []).forEach(r => { regionByKey[r.key] = r; });
  const offOfRegion = key => {
    if (!regionOff[key]) {
      const r = regionByKey[key];
      // 无板的散岛块（key ''）没有板心可采，沿用白噪声：整块给一个固定偏移，
      // 反而把它和别片海域拉开距离，是想要的效果
      regionOff[key] = r
        ? _continentWarpOffset(r.cx, r.cy, CONTINENT_JITTER_REGION)
        : _continentJitterOffset('r:' + key, CONTINENT_JITTER_REGION);
    }
    return regionOff[key];
  };
  // 岛偏移按 sessionId 缓存：同一座岛的所有卡必须挂在同一个 (ix,iy) 上
  // **v8.5 的核心改动就在这一行**：偏移来自「按岛心世界坐标采样位移场」，不再是
  // 「按 sessionId 查哈希」。因为场是坐标的连续函数，相邻两座岛采样到几乎相同的
  // 值 → 它们**一起动** → 岛的栅格直线被弯成曲线（白噪声做不到这点，它让每座岛
  // 各偏各的，只把直线变成点状虚线，仍然是线）。
  // 副作用是好的：近邻位移差 ≈ 幅度×梯度×距离 很小，所以「近亲的两岛挨得近」被
  // 破坏得更少，而每座岛离自己的格点可以走得更远（40 > 旧的 28）——幅度更大的
  // 位移反而比旧的更安全。
  const islandOff = {};
  const rectBySid = {};
  (layout.clusterRects || []).forEach(r => { rectBySid[r.sessionId] = r; });
  const offOfIsland = sid => {
    if (!islandOff[sid]) {
      const ro = offOfRegion(regionOf[sid] || '');
      const r = rectBySid[sid];
      const w = r
        ? _continentWarpOffset(r.cx, r.cy, CONTINENT_JITTER_ISLAND)
        : _continentJitterOffset('i:' + sid, CONTINENT_JITTER_ISLAND);
      // 掺 2px 白噪声：保证没有哪座岛恰好停在格点上（smoke 钉「每个岛都被抖动」）
      const io = _continentJitterOffset('i:' + sid, CONTINENT_JITTER_ISLAND_WHITE);
      islandOff[sid] = { x: ro.x + w.x + io.x, y: ro.y + w.y + io.y };
    }
    return islandOff[sid];
  };

  const clusterRects = (layout.clusterRects || []).map(r => {
    const o = offOfIsland(r.sessionId);
    return Object.assign({}, r, {
      x: r.x + o.x, y: r.y + o.y, cx: r.cx + o.x, cy: r.cy + o.y,
    });
  });
  // 板：平移自己的偏移，再按岛幅度四周外扩（印章态是单枚徽标，同样外扩不亏）
  const regionRects = (layout.regionRects || []).map(r => {
    const o = offOfRegion(r.key);
    const pad = CONTINENT_JITTER_ISLAND;
    return Object.assign({}, r, {
      x: r.x + o.x - pad, y: r.y + o.y - pad,
      w: r.w + pad * 2, h: r.h + pad * 2,
      cx: r.cx + o.x, cy: r.cy + o.y,
    });
  });
  // 卡：板 + 岛 + 自己的微偏移；旋转角另外走 CSS（--jr），数值里表达不了
  const placements = {};
  const cardRot = {};
  const owner = itemSession || {};
  Object.keys(layout.placements || {}).forEach(itemId => {
    const p = layout.placements[itemId];
    const io = offOfIsland(owner[itemId] || '');
    const co = _continentJitterOffset('c:' + itemId, CONTINENT_JITTER_CARD);
    placements[itemId] = {
      x: p.x + io.x + co.x, y: p.y + io.y + co.y,
      w: p.w, h: p.h,
      cx: p.cx + io.x + co.x, cy: p.cy + io.y + co.y,
    };
    cardRot[itemId] = _continentJitter1('c:' + itemId, 'rot-2') * CONTINENT_JITTER_ROT;
  });
  return {
    placements: placements, clusterRects: clusterRects, regionRects: regionRects,
    worldW: layout.worldW, worldH: layout.worldH,   // 见上：世界不许长大
    cardRot: cardRot, organic: true,
  };
}

