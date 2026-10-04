// ===== 知识大陆 · 边与城市（路由几何/城市摆位/画布计划/边层渲染与 _kact/航线偏好/边弹层/边操作与撤销/连接模式）=====
// 自 graph-continent.js 拆出（2026-10-04，T36）。顶层经典脚本共享全局，顺序见 scripts/build_frontend.mjs。
function _continentLinkMid(a, b) {
  // 二次贝塞尔（控制点上抬 lift）上 t=0.5 的点：与连线绘制同一公式，标签才落在弧上
  const mx = (a.cx + b.cx) / 2, my = (a.cy + b.cy) / 2;
  const dx = b.cx - a.cx, dy = b.cy - a.cy;
  const len = Math.max(1, Math.hypot(dx, dy));
  const lift = Math.min(60, len * 0.14);
  const qx = mx + (-dy / len) * lift, qy = my + (dx / len) * lift;
  return { x: (a.cx + 2 * qx + b.cx) / 4, y: (a.cy + 2 * qy + b.cy) / 4, qx, qy };
}

// ---------- v7.2 航线走线（纯函数，无 DOM）：端点从岛框出发，永不穿过岛内部 ----------
// 旧版大陆边直接连两张卡的**中心**（二次贝塞尔），线必然穿过岛内部与中间的岛
// （岛底色 7% 透明度，线全透出来）——几何上的必然，不是审美问题。v7.2 起端点升级
// 为岛框边缘，走线三档：straight 直连 / detour 绕行（默认：撞岛就把控制点垂直推开，
// 最多 3 次，取首个不撞）/ lane 沿世界边缘车道（逃生档）。

// 从 rect 边缘朝目标方向出框的点（线从岛「边上」走，不从岛「心里」穿）
function _continentBorderPoint(rect, towardX, towardY) {
  const cx = Number(rect.cx), cy = Number(rect.cy);
  const dx = Number(towardX) - cx, dy = Number(towardY) - cy;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) {
    return { x: cx, y: cy };
  }
  const scaleX = dx !== 0 ? (rect.w / 2) / Math.abs(dx) : Infinity;
  const scaleY = dy !== 0 ? (rect.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(scaleX, scaleY);
  return { x: cx + dx * t, y: cy + dy * t };
}

// 二次贝塞尔采样撞岛检测（端点在岛框上、不算撞自己；采样点在矩形内即撞）
function _continentBezierHits(p0, q, p2, rects, samples) {
  return _continentBezierHitCount(p0, q, p2, rects, samples) > 0;
}

// 撞点计数（绕行两侧都撞时，取撞得最少的那条兜底）
function _continentBezierHitCount(p0, q, p2, rects, samples) {
  const n = samples || 14;
  let hits = 0;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * q.x + t * t * p2.x;
    const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * q.y + t * t * p2.y;
    for (let k = 0; k < (rects || []).length; k++) {
      const r = rects[k];
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hits++; break; }
    }
  }
  return hits;
}

// 车道走线（沿世界边缘）：四个方向的车道 × 两种入线（从端点直插车道 / 先出岛框再
// 上车道），采样数撞点取最优——单条固定车道会被「入线段横穿同排岛」坑（真机验收
// 抓过：恒定 y 的水平段连穿 4 座岛）
function _continentLaneRoute(a, b, pA, pB, rects, world) {
  const segHits = (from, to) => {
    let hits = 0;
    for (let i = 0; i <= 12; i++) {
      const t = i / 12;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      for (let k = 0; k < (rects || []).length; k++) {
        const r = rects[k];
        if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) { hits++; break; }
      }
    }
    return hits;
  };
  const aRect = { x: a.x, y: a.y, w: a.w, h: a.h, cx: a.cx, cy: a.cy };
  const bRect = { x: b.x, y: b.y, w: b.w, h: b.h, cx: b.cx, cy: b.cy };
  const margin = 26;
  const lanes = [
    { vertical: true, coord: world.x + margin },
    { vertical: true, coord: world.x + world.w - margin },
    { vertical: false, coord: world.y + margin },
    { vertical: false, coord: world.y + world.h - margin },
  ];
  let best = null, bestHits = Infinity;
  lanes.forEach(lane => {
    const candidates = [];
    const entryA = lane.vertical ? { x: lane.coord, y: pA.y } : { x: pA.x, y: lane.coord };
    const entryB = lane.vertical ? { x: lane.coord, y: pB.y } : { x: pB.x, y: lane.coord };
    candidates.push([pA, entryA, entryB, pB]);
    // 先出岛框再上车道：入线沿车道法线方向，避开从岛间走廊斜插
    const exitA = lane.vertical
      ? _continentBorderPoint(aRect, lane.coord, aRect.cy)
      : _continentBorderPoint(aRect, aRect.cx, lane.coord);
    const exitB = lane.vertical
      ? _continentBorderPoint(bRect, lane.coord, bRect.cy)
      : _continentBorderPoint(bRect, bRect.cx, lane.coord);
    const entryA2 = lane.vertical ? { x: lane.coord, y: exitA.y } : { x: exitA.x, y: lane.coord };
    const entryB2 = lane.vertical ? { x: lane.coord, y: exitB.y } : { x: exitB.x, y: lane.coord };
    candidates.push([exitA, entryA2, entryB2, exitB]);
    candidates.forEach(pts => {
      const hits = segHits(pts[0], pts[1]) + segHits(pts[1], pts[2]) + segHits(pts[2], pts[3]);
      if (hits < bestHits) { bestHits = hits; best = pts; }
    });
  });
  if (!best) return null;
  return {
    d: 'M ' + best[0].x + ' ' + best[0].y + ' L ' + best[1].x + ' ' + best[1].y +
       ' L ' + best[2].x + ' ' + best[2].y + ' L ' + best[3].x + ' ' + best[3].y,
    mid: { x: (best[1].x + best[2].x) / 2, y: (best[1].y + best[2].y) / 2 },
    mode: 'lane', p0: best[0], p1: best[1], p2: best[2], p3: best[3],
    hits: bestHits,
  };
}

// 主走线函数：返回 {d, mid, mode, p0, p1, p2, q}。mid 是标签落点（贝塞尔 t=0.5 或
// 车道中点），带 finite 兜底——给 DOM 写 'px' 的落点必须是有限数，NaN 是静默失败
// （v2 的老账：arc.qx undefined → NaNpx → 标签飘到世界层左上角）。
function _continentRoute(a, b, obstacles, mode, world) {
  const rects = (obstacles || []).filter(r => r && r !== a && r !== b);
  const ax = Number.isFinite(a.cx) ? a.cx : 0, ay = Number.isFinite(a.cy) ? a.cy : 0;
  const bx = Number.isFinite(b.cx) ? b.cx : 0, by = Number.isFinite(b.cy) ? b.cy : 0;
  const aRect = { x: a.x, y: a.y, w: a.w, h: a.h, cx: ax, cy: ay };
  const bRect = { x: b.x, y: b.y, w: b.w, h: b.h, cx: bx, cy: by };
  const pA = _continentBorderPoint(aRect, bx, by);
  const pB = _continentBorderPoint(bRect, ax, ay);
  const modeN = mode === 'straight' || mode === 'lane' ? mode : 'detour';
  if (modeN === 'lane' && world && Number.isFinite(world.w)) {
    const lane = _continentLaneRoute(aRect, bRect, pA, pB, rects, world);
    if (lane) return lane;
  }
  const mx = (pA.x + pB.x) / 2, my = (pA.y + pB.y) / 2;
  const dx = pB.x - pA.x, dy = pB.y - pA.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const ux = -dy / len, uy = dx / len;
  let q = { x: mx, y: my };
  if (modeN === 'detour') {
    // 绕行：垂直推开控制点——**两侧都试**（只推一侧时，另一侧恰好挡着就永远绕不
    // 出去；真机验收抓过：5 个采样点穿岛），每侧最多 3 档抬升，取首个不撞的；
    // 两侧全撞（走廊真被堵死）→ 升级沿边车道（「直达路堵了走环线」，仍不穿岛）
    const lift0 = Math.min(110, 46 + len * 0.18);
    let best = null, bestHits = Infinity;
    for (let side = 1; side >= -1; side -= 2) {
      for (let k = 1; k <= 3; k++) {
        const lift = lift0 * k * side;
        const cand = { x: mx + ux * lift, y: my + uy * lift };
        if (!_continentBezierHits(pA, cand, pB, rects)) { best = cand; bestHits = 0; break; }
        const hits = _continentBezierHitCount(pA, cand, pB, rects);
        if (hits < bestHits) { bestHits = hits; best = cand; }
      }
      if (bestHits === 0) break;
    }
    if (bestHits === 0) {
      q = best;
    } else if (world && Number.isFinite(world.w)) {
      const lane = _continentLaneRoute(aRect, bRect, pA, pB, rects, world);
      if (lane) return lane;
      q = best || { x: mx, y: my };   // world 都没有就退而求其次：撞得最少的那条弧
    } else {
      q = best || { x: mx, y: my };
    }
  }
  const fin = v => Number.isFinite(v) ? v : 0;
  const qx = (pA.x + 2 * q.x + pB.x) / 4, qy = (pA.y + 2 * q.y + pB.y) / 4;
  const mid = {
    x: Number.isFinite(qx) ? qx : fin(mx),
    y: Number.isFinite(qy) ? qy : fin(my),
  };
  return {
    d: 'M ' + pA.x + ' ' + pA.y + ' Q ' + q.x + ' ' + q.y + ' ' + pB.x + ' ' + pB.y,
    mid: mid, mode: modeN, p0: pA, q: q, p2: pB,
  };
}

function _continentCityBox(cx, cy) {
  return {
    x: cx - CONTINENT_CITY_W / 2, y: cy - CONTINENT_CITY_H / 2,
    w: CONTINENT_CITY_W, h: CONTINENT_CITY_H, cx: cx, cy: cy,
  };
}

// 联运港候选落点：所连岛群的质心 + 每对岛的中点（两岛之间的走廊 = 首选），各带一圈
// 小偏移——走廊被占时挤一挤（同一条走廊竖着摆得下 3 座城），别动不动判「无位可放」。
function _continentCitySpots(targets) {
  const pts = (targets || []).filter(t => t && isFinite(t.cx) && isFinite(t.cy));
  if (pts.length < 2) return [];
  const seeds = [];
  let sx = 0, sy = 0;
  pts.forEach(t => { sx += t.cx; sy += t.cy; });
  seeds.push({ x: sx / pts.length, y: sy / pts.length });
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      seeds.push({ x: (pts[i].cx + pts[j].cx) / 2, y: (pts[i].cy + pts[j].cy) / 2 });
    }
  }
  const stepX = CONTINENT_CITY_W + CONTINENT_CITY_GAP;
  const stepY = CONTINENT_CITY_H + CONTINENT_CITY_GAP;
  const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1],
                [2, 0], [-2, 0], [0, 2], [0, -2],
                [1, 1], [-1, 1], [1, -1], [-1, -1]];
  const out = [];
  seeds.forEach(s => ring.forEach(r => {
    out.push({ x: s.x + r[0] * stepX, y: s.y + r[1] * stepY });
  }));
  return out;
}

// 世界边界（岛群包围盒 + 一个走廊宽）：联运港属于「岛之间」，不许飘到地图外的荒野
function _continentWorldBounds(rects) {
  const list = (rects || []).filter(r => r && isFinite(r.x) && isFinite(r.y) && r.w > 0 && r.h > 0);
  if (!list.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach(r => {
    minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
  });
  const pad = CONTINENT_CLUSTER_GAP;
  return { x: minX - pad, y: minY - pad,
           w: (maxX - minX) + pad * 2, h: (maxY - minY) + pad * 2 };
}

function _continentFits(box, obstacles, margin) {
  const m = margin || 0;
  return !(obstacles || []).some(o => o &&
    box.x - m < o.x + o.w && box.x + box.w + m > o.x &&
    box.y - m < o.y + o.h && box.y + box.h + m > o.y);
}

function _continentInside(box, bounds) {
  return box.x >= bounds.x && box.y >= bounds.y &&
    box.x + box.w <= bounds.x + bounds.w && box.y + box.h <= bounds.y + bounds.h;
}

// 联运港选位：候选里挑「不撞岛、不撞别的港、留在世界内」且**离它所连的岛总距离最短**
// 的那个（联运线最短最好读）。一个都放不下 → null（调用方折叠，原因「无位可放」）。
function _continentPlaceCity(targets, obstacles, bounds) {
  const pts = (targets || []).filter(t => t && isFinite(t.cx) && isFinite(t.cy));
  if (pts.length < 2) return null;
  let best = null, bestCost = Infinity;
  _continentCitySpots(pts).forEach(spot => {
    const box = _continentCityBox(spot.x, spot.y);
    if (bounds && !_continentInside(box, bounds)) return;
    if (!_continentFits(box, obstacles, CONTINENT_CITY_GAP)) return;
    const cost = pts.reduce((acc, t) => acc + Math.hypot(t.cx - spot.x, t.cy - spot.y), 0);
    if (cost < bestCost - 1e-6) { bestCost = cost; best = box; }
  });
  return best;
}

// 折叠原因：四种都要能分辨，用户才知道该不该管它（弱证据要修标题 / 无位可放是地图太挤）
const CONTINENT_FOLD_REASON = {
  weak: '弱证据',
  covered: '已被更具体的联运港覆盖',
  capped: '超出每对上限',
  map_capped: '超出全图上限',
  no_room: '无位可放',
};

function _continentDrawPlan(shared, placements, clusterRects, pairLimit, cityLimit, extraBounds) {
  const rects = clusterRects || [];
  const pairLimitN = pairLimit || CONTINENT_PAIR_CITY_LIMIT;
  const cityLimitN = cityLimit || CONTINENT_CITY_LIMIT;
  const cities = [], boundary = {}, folded = [];
  const obstacles = rects.slice();
  // v7.1a：世界边界罩住海域板（板比岛并集大一圈）——否则边缘板上的联运港会被判
  // 「出界」折叠。板只进边界、不进障碍（联运港可以落在板上，那本来就是它的地盘）
  const bounds = _continentWorldBounds((extraBounds && extraBounds.length ? extraBounds : []).concat(rects));
  const pairs = {};
  let spokes = 0;
  (shared || []).slice(0, CONTINENT_LINE_LIMIT).forEach(s => {
    if (s.strength === 'weak') { folded.push({ entry: s, reason: 'weak' }); return; }
    // v5.5：证据被更具体的标签完全覆盖（服务端 covered 字段）——比如 8 座岛的「能量
    // 守恒定律」+ 2 座岛的「角动量守恒定律」旁边的那个 10 岛「量守恒定律」（截断名）。
    // 它不单独成城（名字读不懂、城与城几乎重合），但照进折叠清单，也要参与摆位亲缘
    if (s.covered) { folded.push({ entry: s, reason: 'covered' }); return; }
    if (cities.length >= cityLimitN) { folded.push({ entry: s, reason: 'map_capped' }); return; }
    // 每会话一张代表卡：服务端 _links_for 已按「岛内最早学的」取端点，这里按会话去重。
    // placements 里找不到的条目跳过——投影与布局不同步时宁可不画，也不画到错地方。
    const reps = [], seen = {};
    (s.links || []).forEach(l => {
      [[l.fromSession, l.from], [l.toSession, l.to]].forEach(pair => {
        const sid = pair[0], iid = pair[1];
        if (!sid || !iid || seen[sid] || !placements[iid]) return;
        seen[sid] = true;
        reps.push({ sessionId: sid, itemId: iid });
      });
    });
    // 一栋楼要有两座以上的岛才叫联运港（单岛共享是同岛词面重叠，服务端已经不算）
    if (reps.length < 2) { folded.push({ entry: s, reason: 'no_room' }); return; }
    const sids = reps.map(r => r.sessionId).slice().sort();
    let blocked = false;
    for (let i = 0; i < sids.length && !blocked; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        if ((pairs[sids[i] + '|' + sids[j]] || 0) >= pairLimitN) { blocked = true; break; }
      }
    }
    if (blocked) { folded.push({ entry: s, reason: 'capped' }); return; }
    const targets = reps.map(r => {
      const rect = rects.find(x => x && x.sessionId === r.sessionId);
      const p = placements[r.itemId];
      return { cx: rect ? rect.cx : p.cx, cy: rect ? rect.cy : p.cy };
    });
    const box = _continentPlaceCity(targets, obstacles, bounds);
    if (!box) { folded.push({ entry: s, reason: 'no_room' }); return; }
    obstacles.push(box);
    for (let i = 0; i < sids.length; i++) {
      for (let j = i + 1; j < sids.length; j++) {
        const key = sids[i] + '|' + sids[j];
        pairs[key] = (pairs[key] || 0) + 1;
      }
    }
    spokes += reps.length;
    // 代表卡挂 ◈ 徽标（联运线一眼看得到头）；同岛的其他命中卡不挂徽标，但进重逢清单
    reps.forEach(r => { boundary[r.itemId] = s.label; });
    cities.push({ entry: s, reps: reps, total: reps.length,
                  x: box.cx, y: box.cy, box: box });
  });
  return { cities: cities, boundary: boundary, cityCount: cities.length,
           spokeCount: spokes, folded: folded };
}

// ===== T144 边层局部重画：改边不再全库重投影＋整图重建 =====
// 边表是独立 KV（/api/kv/continent_edges），聚簇/共享概念/海域投影全不因它变。
// 原先 _continentCommit 提交后重 GET /api/continent（服务端全量重算）→ innerHTML=''
// 重建全部岛卡并重跑每张公式卡的 katex.render——概念上千后每次保存都会明显卡。
// 现在本地镜像服务端校验（_continentSplitEdges 与 continent.py _split_user_edges
// 同口径）重算有效/悬空归类，只清边 <g> 与标签 wrap 重画边层。
let _continentEdgeLayerEl = null;      // 边层 <g>（重画目标，渲染期换新）
let _continentEdgeLabelWrap = null;    // 边标签/断桥标记容器（同上）
let _continentLayoutCache = null;      // 当前布局（边层几何来源）
let _continentStatsBase = '';          // 顶栏统计去掉「我的航线 N」的前缀

function _continentSplitEdges(rawEdges, data) {
  const itemSession = {};
  ((data && data.clusters) || []).forEach(c => (c.items || []).forEach(item => {
    itemSession[item.itemId] = c.sessionId || '';
  }));
  const norm = e => ({
    id: String((e && e.id) || '').trim(),
    fromItem: String((e && e.fromItem) || '').trim(),
    toItem: String((e && e.toItem) || '').trim(),
    fromSession: String((e && e.fromSession) || '').trim(),
    toSession: String((e && e.toSession) || '').trim(),
    label: String((e && e.label) || '').slice(0, 40),
    style: (e && e.style) || {},
    createdAt: (e && e.createdAt) || 0,
  });
  const seenPair = {};
  const sorted = (rawEdges || []).slice().sort((a, b) => ((b.createdAt || 0) - (a.createdAt || 0)));
  const userEdges = [], danglingEdges = [];
  sorted.forEach(raw => {
    const e = norm(raw);
    if (!e.id || !e.fromItem || !e.toItem || e.fromItem === e.toItem) return;  // 自环不是簇间边
    const pair = e.fromItem < e.toItem ? e.fromItem + '|' + e.toItem : e.toItem + '|' + e.fromItem;
    if (pair in seenPair) return;  // 同端点对只留 createdAt 最新的一条
    seenPair[pair] = true;
    const fromOk = e.fromItem in itemSession;
    const toOk = e.toItem in itemSession;
    if (fromOk && toOk && itemSession[e.fromItem] !== itemSession[e.toItem]) {
      // 有效边的会话以 itemSession 现算覆盖（条目搬家后旧值不作数）
      e.fromSession = itemSession[e.fromItem];
      e.toSession = itemSession[e.toItem];
      userEdges.push(e);
    } else {
      e.missing = !fromOk && !toOk ? 'both' : !fromOk ? 'from' : !toOk ? 'to' : 'same_session';
      danglingEdges.push(e);
    }
  });
  return { userEdges: userEdges, danglingEdges: danglingEdges };
}

// 边层绘制（用户航线 + 断桥）：全量渲染与边层局部重画共用这一份——两条路径的
// 产出逐字节一致，重画不重算布局、不重跑 KaTeX
function _continentDrawEdgeLayer(data, layout, edgeLayer, labelWrap) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const routePrefs = _continentRoutePrefs();
  const routeThemeLight = document.documentElement &&
    document.documentElement.getAttribute('data-theme') === 'light';
  _continentRouteEls = [];  // T133：本帧航线元素重新收集（重画后旧引用全部作废）
  (data.userEdges || []).forEach(e => {
    const ra = layout.clusterRects.find(r => r.sessionId === e.fromSession);
    const rb = layout.clusterRects.find(r => r.sessionId === e.toSession);
    const pa = layout.placements[e.fromItem], pb = layout.placements[e.toItem];
    if (!ra || !rb) return;  // 找不到岛框的走断桥通道（下方 danglingEdges）
    if (!routePrefs.on || (e.style && e.style.hidden)) return;
    const style = e.style || {};
    const route = _continentRoute(ra, rb, layout.clusterRects, style.route || 'detour',
      { x: 0, y: 0, w: layout.worldW, h: layout.worldH });
    const stroke = _continentRouteStroke(style, e, _continentRegionInfo,
      routeThemeLight ? 'light' : 'dark');
    const sidsAttr = [e.fromSession, e.toSession].join(',');
    // 路基（光晕层）：同色、约 3 倍宽、低透明度——先画，核心线压在它上面
    const halo = document.createElementNS(svgNS, 'path');
    halo.setAttribute('class', 'continent-route-casing');
    halo.setAttribute('d', route.d);
    halo.setAttribute('stroke', stroke.color);
    halo.setAttribute('stroke-width', String(Math.max(5, stroke.width * 3)));
    halo.setAttribute('opacity', String(routePrefs.opacity));
    halo.setAttribute('data-sids', sidsAttr);
    edgeLayer.appendChild(halo);
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('class', 'continent-route');
    path.setAttribute('d', route.d);
    path.setAttribute('data-edge-id', e.id);
    path.setAttribute('data-sids', sidsAttr);
    path.setAttribute('stroke', stroke.color);
    path.setAttribute('stroke-width', String(stroke.width));
    if (stroke.dash) path.setAttribute('stroke-dasharray', stroke.dash);
    path.setAttribute('opacity', String(routePrefs.opacity));
    path.addEventListener('pointerdown', ev => {
      ev.stopPropagation();
      _continentEdgePopover(e, ev);
    });
    _kact(path);  // T143 键盘可达（SVG path 可挂 tabindex）
    edgeLayer.appendChild(path);
    // 端点圆珠（站点）：摆在岛框**外侧**一点——SVG 连线层在世界层最底下，正好压在
    // 岛框边上的圆会被岛牌盖掉半截，沿「岛心→出岛点」方向外推才完整可见
    const laneMode = route.mode === 'lane' || route.mode === 'detour-lane';
    const beadR = Math.min(4.2, Math.max(2.4, stroke.width * 1.4));
    const dots = [];  // T133：端珠一并记账，主题重涂要动它们的 fill
    [[ra, route.p0], [rb, laneMode ? route.p3 : route.p2]].forEach(pair => {
      const rect = pair[0], pt = pair[1];
      if (!rect || !pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
      const dx = pt.x - rect.cx, dy = pt.y - rect.cy;
      const len = Math.max(1, Math.hypot(dx, dy));
      const dot = document.createElementNS(svgNS, 'circle');
      dot.setAttribute('class', 'continent-route-end');
      dot.setAttribute('cx', String(pt.x + dx / len * 3));
      dot.setAttribute('cy', String(pt.y + dy / len * 3));
      dot.setAttribute('r', String(beadR));
      dot.setAttribute('fill', stroke.color);
      dot.setAttribute('opacity', String(routePrefs.opacity));
      dot.setAttribute('data-sids', sidsAttr);
      dots.push(dot);
      edgeLayer.appendChild(dot);
    });
    if (e.label && !style.noLabel) {
      const label = document.createElement('div');
      label.className = 'continent-user-link-label';
      // 落点走走线产物 route.mid（finite 兜底在纯函数里）——标签必须压在线上
      label.style.left = route.mid.x + 'px';
      label.style.top = route.mid.y + 'px';
      label.textContent = e.label;
      label.title = '我的航线：' + e.label;
      label.addEventListener('pointerdown', ev => {
        ev.stopPropagation();
        _continentEdgePopover(e, ev);
      });
      _kact(label);  // T143 键盘可达
      labelWrap.appendChild(label);
    }
    // 锚点短接（细节档才显，CSS 管显隐）：从锚点卡到出岛点的一小段虚线——
    // 「这条线具体连哪张卡」降级为细节信息，不再穿岛去连卡片中心
    if (pa && pb) {
      [[pa, route.p0], [pb, laneMode ? route.p3 : route.p2]].forEach(pair => {
        const stub = document.createElementNS(svgNS, 'line');
        stub.setAttribute('class', 'continent-route-stub');
        stub.setAttribute('x1', String(pair[0].cx));
        stub.setAttribute('y1', String(pair[0].cy));
        stub.setAttribute('x2', String(pair[1].x));
        stub.setAttribute('y2', String(pair[1].y));
        stub.setAttribute('data-sids', [e.fromSession, e.toSession].join(','));
        edgeLayer.appendChild(stub);
      });
    }
    // T133：记下这条航线三件套，主题切换时 _continentRepaintRouteTheme 只重涂颜色
    _continentRouteEls.push({ halo: halo, path: path, dots: dots, style: style, edge: e });
  });

  // 断桥（v2）：一端已不在大陆上的边——从幸存端朝目标簇方向画残线，中段断开。
  // 两端都在但同会话的无效边无残线可画，只进清理清单。
  (data.danglingEdges || []).forEach(e => {
    if (e.missing === 'same_session') return;
    const anchor = e.missing === 'from' ? layout.placements[e.toItem] : layout.placements[e.fromItem];
    if (!anchor) return;
    const targetSid = e.missing === 'from' ? e.fromSession : e.toSession;
    const cluster = layout.clusterRects.find(r => r.sessionId === targetSid);
    const tx = cluster ? cluster.cx : anchor.cx + 140, ty = cluster ? cluster.cy : anchor.cy + 90;
    const dx = tx - anchor.cx, dy = ty - anchor.cy;
    const len = Math.max(1, Math.hypot(dx, dy));
    const ux = dx / len, uy = dy / len;
    const seg = (t0, t1) => {
      const p = document.createElementNS(svgNS, 'path');
      p.setAttribute('class', 'continent-dangle-link');
      p.setAttribute('d', 'M ' + (anchor.cx + ux * len * t0) + ' ' + (anchor.cy + uy * len * t0) +
        ' L ' + (anchor.cx + ux * len * t1) + ' ' + (anchor.cy + uy * len * t1));
      edgeLayer.appendChild(p);
    };
    seg(0, 0.55); seg(0.68, 0.8);  // 中段留空 = 桥断了
    const mark = document.createElement('div');
    mark.className = 'continent-dangle-mark';
    mark.style.left = (anchor.cx + ux * len * 0.615) + 'px';
    mark.style.top = (anchor.cy + uy * len * 0.615) + 'px';
    mark.textContent = '✕';
    mark.title = '这条航线的一端已不在大陆上（画布被清空或概念被删除），可用工具条「清理断桥」移除';
    labelWrap.appendChild(mark);
  });
}

// 边层局部重画：清空边 <g> 与标签 wrap 后按当前布局重画。缓存缺席（图未开/
// 渲染路径没走到边层）时退回全量渲染兜底，绝不静默丢边
function _continentRedrawEdges() {
  const data = _continentData;
  if (!data) return;
  if (!_continentEdgeLayerEl || !_continentEdgeLabelWrap || !_continentLayoutCache) {
    _continentRender(data);
    return;
  }
  while (_continentEdgeLayerEl.firstChild) _continentEdgeLayerEl.removeChild(_continentEdgeLayerEl.firstChild);
  while (_continentEdgeLabelWrap.firstChild) _continentEdgeLabelWrap.removeChild(_continentEdgeLabelWrap.firstChild);
  _continentDrawEdgeLayer(data, _continentLayoutCache, _continentEdgeLayerEl, _continentEdgeLabelWrap);
  // v5.6 契约：新画的标签出生时不带缩放抵消，画完必须同步一次
  _continentSyncEdgeLabels();
  const mineCount = (data.userEdges || []).length;
  const stats = document.getElementById('continentStats');
  if (stats && _continentStatsBase) {
    stats.textContent = _continentStatsBase + (mineCount ? ' · 我的航线 ' + mineCount : '');
  }
}

// T143 键盘可达性：大陆的交互件原先只绑 pointerdown——Tab 进不去、Enter/Space
// 无处理器，键盘完全够不着。统一补法：原生 <button> 天生可聚焦，键盘会派发
// detail=0 的 click（真实鼠标 click 的 detail≥1 且动作已由 pointerdown 跑过，
// 必须跳过防双触发）；div/span/svg 件补 tabindex+role 后按 Enter/Space 合成
// pointerdown（坐标取元素屏位置——弹层定位吃 clientX/clientY）。合成事件
// bubbles:false，但捕获阶段照常下传，弹层场外关闭对它语义与真实点击一致。
function _kact(el) {
  if (!el || !el.addEventListener) return el;
  const fire = () => {
    const r = (typeof el.getBoundingClientRect === 'function') ? el.getBoundingClientRect() : null;
    const init = {
      bubbles: false, cancelable: true,
      clientX: r ? r.left + Math.min(r.width / 2, 24) : 0,
      clientY: r ? r.bottom + 4 : 0,
    };
    let synthetic = null;
    try {
      synthetic = (typeof PointerEvent === 'function')
        ? new PointerEvent('pointerdown', init)
        : new MouseEvent('pointerdown', init);
    } catch (err) { synthetic = null; }
    if (synthetic) {
      try { el.dispatchEvent(synthetic); } catch (err) { /* 沙箱兜底 */ }
    }
  };
  if (String(el.tagName || '').toLowerCase() === 'button') {
    el.addEventListener('click', e => {
      if (e.detail !== 0) return;  // 鼠标路径动作已在 pointerdown 跑过
      e.stopPropagation();
      fire();
    });
    return el;
  }
  try {
    el.setAttribute('tabindex', '0');
    el.setAttribute('role', 'button');
  } catch (err) { /* 沙箱兜底 */ }
  el.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    e.preventDefault();
    e.stopPropagation();
    fire();
  });
  return el;
}

const CONTINENT_ROUTE_PREFS_KEY = 'phymathia_continent_routes'; // 非会话键（全局显示偏好）
const CONTINENT_ROUTE_DASH = { solid: '', dashed: '7 5', dotted: '2 4' };
const CONTINENT_ROUTE_WIDTH = { thin: 1.2, normal: 2, thick: 3.2 };

function _continentRoutePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(CONTINENT_ROUTE_PREFS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return { on: raw.on !== false,
               opacity: Number.isFinite(Number(raw.opacity)) ? Math.min(1, Math.max(0.15, Number(raw.opacity))) : 1 };
    }
  } catch (e) { /* 容忍 */ }
  return { on: true, opacity: 1 };
}

function _continentSaveRoutePrefs(prefs) {
  try { localStorage.setItem(CONTINENT_ROUTE_PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* 容忍 */ }
}

// 样式解析（纯函数）：颜色三档——gold 暖色（**默认**：「我画的路」专用色，与机器画
// 的辐条/断线、海域板色系拉开；**按主题选色相**：暗色机器线是蓝→航线用暖金，浅色
// 机器线 accent 本身是暗金（#8b6914）→ 航线换**赭橙**（同属暖色语义、色相 45°→24°
// 彻底分开，且不是报错红）。theme 只影响这一档。旧边无 style 字段走默认（实线/
// normal/暖色）；region 算不出色相时仍回落旧默认蓝（查空是正常路径）
function _continentRouteStroke(style, edge, regionInfo, theme) {
  const s = style || {};
  const colorKey = s.color || 'gold';
  let color = null;
  if (colorKey === 'gold') {
    color = theme === 'light' ? 'rgba(191, 91, 27, 0.92)' : 'rgba(217, 164, 65, 0.9)';
  } else if (colorKey === 'neutral') {
    color = 'rgba(150, 156, 170, 0.8)';
  } else if (regionInfo && edge && regionInfo.bySid) {
    const info = regionInfo.bySid[edge.fromSession];
    const hue = info && info.key !== null && info.key !== undefined
      ? _continentRegionHue(info.key, null) : null;
    if (hue !== null && hue !== undefined) color = 'hsla(' + hue + ', 62%, 64%, 0.85)';
  }
  if (!color) color = 'rgba(74, 158, 255, 0.85)';
  return {
    color: color,
    width: CONTINENT_ROUTE_WIDTH[s.width] || CONTINENT_ROUTE_WIDTH.normal,
    dash: CONTINENT_ROUTE_DASH[s.dash] || '',
  };
}

// T133：主题切换重涂航线。只动「颜色」三个属性（halo/核心线的 stroke + 端珠的 fill）
// ——宽度/虚线/透明度/几何都与主题无关，不碰。颜色走同一份 _continentRouteStroke，
// 产出与重渲逐字节一致；清空/没开图时是零开销空转
function _continentRepaintRouteTheme() {
  if (!_continentRouteEls.length) return;
  const light = document.documentElement &&
    document.documentElement.getAttribute('data-theme') === 'light';
  const theme = light ? 'light' : 'dark';
  _continentRouteEls.forEach(r => {
    const stroke = _continentRouteStroke(r.style, r.edge, _continentRegionInfo, theme);
    if (r.halo) r.halo.setAttribute('stroke', stroke.color);
    if (r.path) r.path.setAttribute('stroke', stroke.color);
    (r.dots || []).forEach(d => { if (d) d.setAttribute('fill', stroke.color); });
  });
}

// applyTheme（ui.js）只写 <html> 的 data-theme、不派发任何事件——属性监听是唯一不侵入
// ui.js 的挂点。大陆没开就短路：开图路径 _continentRender 本来就读当下主题；开着才重涂，
// 且只涂航线不重建（整图重建要重跑每张公式卡的 KaTeX，主题切换这种高频操作不值得）
if (typeof MutationObserver !== 'undefined' && document && document.documentElement) {
  new MutationObserver(() => {
    if (document.querySelector('.graph-workspace.continent-open')) _continentRepaintRouteTheme();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

// 通用编辑（样式/锚点/备注/隐藏共用）：改前留全量快照进撤销栈（type:'edit'）
async function _continentEditEdge(edgeId, patch) {
  const edges = _continentEdgeList();
  const target = edges.find(e => e.id === edgeId);
  if (!target) return;
  const before = JSON.parse(JSON.stringify(target));
  const next = edges.map(e => e.id === edgeId ? Object.assign({}, e, patch) : e);
  await _continentCommit(next, { type: 'edit', id: edgeId, before: before });
}

function _continentEdgePopover(e, ev) {
  const idx = _continentItemIndex();
  const s = e.style || {};
  const esc = _continentEsc;
  const option = (list, val) => list.map(o =>
    '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + o[1] + '</option>').join('');
  const dashOpts = option([['solid', '实线'], ['dashed', '虚线'], ['dotted', '点线']], s.dash || 'solid');
  const colorOpts = option([['gold', '暖金（默认）'], ['region', '跟海域色'], ['neutral', '中性']], s.color || 'gold');
  const widthOpts = option([['thin', '细'], ['normal', '中'], ['thick', '粗']], s.width || 'normal');
  const routeOpts = option([['detour', '绕行（默认）'], ['straight', '直连'], ['lane', '沿边缘车道']], s.route || 'detour');
  // 换锚点卡：两端各列自己岛上的卡（学习顺序），代表卡口径不变
  const itemsOf = sid => (( _continentData && _continentData.clusters) || [])
    .filter(c => c.sessionId === sid)
    .flatMap(c => c.items || []);
  const anchorOpts = (sid, cur) => option(
    itemsOf(sid).map(it => [it.itemId, it.title || it.itemId]), cur);
  const html =
    '<div class="continent-pop-title">我的航线' + (e.label ? ' · ' + esc(e.label) : '') + '</div>' +
    '<div class="continent-pop-line">' + esc(idx.items[e.fromItem] || '？') +
    ' ↔ ' + esc(idx.items[e.toItem] || '？') + '</div>' +
    '<div class="continent-route-form">' +
      '<div class="continent-pop-row"><input class="continent-pop-input" data-label-input' +
        ' value="' + esc(e.label || '') + '" maxlength="40" placeholder="备注（如：同为波动现象）"></div>' +
      '<div class="continent-route-grid">' +
        '<label>线型<select data-style="dash">' + dashOpts + '</select></label>' +
        '<label>颜色<select data-style="color">' + colorOpts + '</select></label>' +
        '<label>粗细<select data-style="width">' + widthOpts + '</select></label>' +
        '<label>走线<select data-style="route">' + routeOpts + '</select></label>' +
      '</div>' +
      '<div class="continent-route-grid">' +
        '<label>这端卡<select data-anchor="from">' + anchorOpts(e.fromSession, e.fromItem) + '</select></label>' +
        '<label>那端卡<select data-anchor="to">' + anchorOpts(e.toSession, e.toItem) + '</select></label>' +
      '</div>' +
    '</div>' +
    '<div class="continent-pop-actions is-wrap">' +
      '<button class="continent-pop-btn" data-act="save-label">存备注</button>' +
      '<button class="continent-pop-btn is-quiet" data-act="toggle-label">' + (s.noLabel ? '显示备注标签' : '隐藏备注标签') + '</button>' +
      '<button class="continent-pop-btn is-quiet" data-act="hide">' + (s.hidden ? '取消隐藏' : '隐藏（留数据）') + '</button>' +
      '<button class="continent-pop-btn is-danger" data-act="remove">删除航线</button>' +
    '</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  el.querySelectorAll('[data-style]').forEach(sel => sel.addEventListener('change', async () => {
    const patch = { style: Object.assign({}, s) };
    patch.style[sel.getAttribute('data-style')] = sel.value;
    try { await _continentEditEdge(e.id, patch); } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
  el.querySelectorAll('[data-anchor]').forEach(sel => sel.addEventListener('change', async () => {
    const patch = sel.getAttribute('data-anchor') === 'from'
      ? { fromItem: sel.value } : { toItem: sel.value };
    try { await _continentEditEdge(e.id, patch); } catch (err) {
      _continentToast('保存失败：' + (err && err.message || err));
    }
  }));
  const labelInput = el.querySelector('[data-label-input]');
  const saveLabel = async () => {
    const v = labelInput ? String(labelInput.value || '').slice(0, 40) : '';
    try {
      await _continentEditEdge(e.id, { label: v });
      _continentClosePopover();
    } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
  };
  const saveBtn = el.querySelector('[data-act="save-label"]');
  if (saveBtn) {
    saveBtn.addEventListener('pointerdown', e2 => { e2.stopPropagation(); saveLabel(); });
    _kact(saveBtn);  // T143 键盘可达
  }
  if (labelInput) labelInput.addEventListener('keydown', ev2 => {
    if (ev2.key === 'Enter') saveLabel();
  });
  el.querySelectorAll('[data-act]').forEach(btn => {
    const act = btn.getAttribute('data-act');
    if (act === 'save-label') return;
    btn.addEventListener('pointerdown', async e2 => {
      e2.stopPropagation();
      if (act === 'remove') {
        _continentClosePopover();
        try {
          await _continentRemoveUserEdges([e.id]);
          _continentToast('已删除（Ctrl+Z 可撤销）');
        } catch (err) { _continentToast('删除失败：' + (err && err.message || err)); }
      } else if (act === 'hide') {
        try {
          await _continentEditEdge(e.id, { style: Object.assign({}, s, { hidden: !s.hidden }) });
          _continentClosePopover();
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      } else if (act === 'toggle-label') {
        try {
          await _continentEditEdge(e.id, { style: Object.assign({}, s, { noLabel: !s.noLabel }) });
        } catch (err) { _continentToast('保存失败：' + (err && err.message || err)); }
      }
    });
    _kact(btn);  // T143 键盘可达
  });
}

// 全局航线面板（顶栏「航线」按钮）：总开关 + 透明度——关了数据还在，再开就回来
function _continentRoutePrefsPopover(ev) {
  const prefs = _continentRoutePrefs();
  const html =
    '<div class="continent-pop-title">航线显示</div>' +
    '<div class="continent-pop-row"><label class="continent-route-check">' +
      '<input type="checkbox" data-route-on' + (prefs.on ? ' checked' : '') + '> 显示我的航线</label></div>' +
    '<div class="continent-pop-row"><label class="continent-route-check">透明度' +
      '<input type="range" min="0.15" max="1" step="0.05" value="' + prefs.opacity + '" data-route-opacity></label></div>' +
    '<div class="continent-pop-desc">悬停一座岛可单独看它的航线（其余淡出）。单条的样式点线本身调。</div>';
  const el = _continentOpenPopover(html, ev.clientX, ev.clientY);
  if (!el || !el.querySelectorAll) return;
  const apply = next => {
    _continentSaveRoutePrefs(next);
    if (_continentOpen && _continentData) _continentRender(_continentData);
  };
  const onBox = el.querySelector('[data-route-on]');
  if (onBox) onBox.addEventListener('change', () => {
    apply({ on: onBox.checked, opacity: _continentRoutePrefs().opacity });
  });
  const range = el.querySelector('[data-route-opacity]');
  if (range) range.addEventListener('input', () => {
    apply({ on: _continentRoutePrefs().on, opacity: Number(range.value) });
  });
}

// 悬停隔离（「只看选中岛的航线」，零点击零模式）：悬停岛 → 不相关的航线淡出。
// 岛牌点击仍是下钻，两者不冲突
function _continentSetRouteIso(sid) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  if (!sid) {
    world.classList.remove('route-iso');
    world.querySelectorAll('.continent-route, .continent-route-stub, ' +
      '.continent-route-casing, .continent-route-end').forEach(el =>
      el.classList.remove('is-dim', 'is-lit'));
    return;
  }
  world.classList.add('route-iso');
  world.querySelectorAll('.continent-route, .continent-route-stub, ' +
    '.continent-route-casing, .continent-route-end').forEach(el => {
    const sids = String(el.getAttribute('data-sids') || '').split(',');
    const mine = sids.indexOf(sid) >= 0;
    el.classList.toggle('is-lit', mine);
    el.classList.toggle('is-dim', !mine);
  });
}

// ---------- v8 顶栏搜索：在大陆里找岛与概念卡（纯函数 + 轻量 DOM） ----------
// 口径沿铁律「跳转不猜」：唯一命中回车直达；多命中出清单，点哪行去哪行——搜索框
// 绝不替用户挑目标。归一化抹掉空格与大小写（中英混排标题不至于因为一个空格搜不到）；
// ---------- v2 簇间边：KV 读写 + 撤销栈（只记边操作） ----------
function _continentEdgeList() {
  const d = _continentData || {};
  return ((d.userEdges || []).concat(d.danglingEdges || []));
}

async function _continentCommit(edges, undoEntry) {
  const resp = await fetch(CONTINENT_EDGES_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: edges.slice(0, CONTINENT_USER_EDGE_LIMIT) }),
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  if (undoEntry) _continentEdgeUndo.push(undoEntry);
  // T144：边表是独立 KV，聚簇/共享概念/海域投影全不因它变——原先提交后重 GET
  // /api/continent（服务端全量重算）→ 整图重建重跑全部 KaTeX。现在本地镜像
  // 服务端校验（_continentSplitEdges）重算有效/悬空归类，只重画边层
  const d = _continentData || {};
  const capped = edges.slice(0, CONTINENT_USER_EDGE_LIMIT);
  const split = _continentSplitEdges(capped, d);
  d.userEdges = split.userEdges;
  d.danglingEdges = split.danglingEdges;
  if (_continentOpen) _continentRedrawEdges();  // 布局与边无关，不重投影不重建岛卡
  _continentUpdateTools();
}

async function _continentAddUserEdge(fromItem, toItem, label) {
  const dup = (((_continentData && _continentData.userEdges) || []).some(e =>
    (e.fromItem === fromItem && e.toItem === toItem) ||
    (e.fromItem === toItem && e.toItem === fromItem)));
  if (dup) { _continentToast('这两条概念已经连过线了'); return false; }
  const edge = {
    id: 'ce_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    fromItem: String(fromItem), toItem: String(toItem),
    label: String(label || '').slice(0, 40),
    createdAt: Date.now(),
  };
  await _continentCommit(_continentEdgeList().concat([edge]), { type: 'add', edge });
  return true;
}

async function _continentRemoveUserEdges(removeIds) {
  const ids = new Set(removeIds);
  const removed = _continentEdgeList().filter(e => ids.has(e.id));
  if (!removed.length) return;
  await _continentCommit(
    _continentEdgeList().filter(e => !ids.has(e.id)),
    removeIds.length === 1 ? { type: 'remove', edge: removed[0] } : { type: 'bulk', edges: removed });
}

async function _continentUndoEdgeOp() {
  if (!_continentEdgeUndo.length) { _continentToast('没有可撤销的边操作'); return; }
  const op = _continentEdgeUndo.pop();
  _continentUpdateTools();
  try {
    if (op.type === 'add') {
      await _continentCommit(_continentEdgeList().filter(e => e.id !== op.edge.id));
    } else if (op.type === 'edit') {
      // v7.2 单条编辑（样式/锚点/备注/隐藏）：恢复改前快照
      const edges = _continentEdgeList().map(e => e.id === op.id ? op.before : e);
      await _continentCommit(edges);
    } else if (op.type === 'region') {
      // v7.1a 海域操作（挪岛/改名）与边操作共用同一条 Ctrl+Z 栈（大陆打开时截获的约定不变）
      await _continentUndoRegionOp(op);
    } else {
      const restore = op.type === 'bulk' ? op.edges : [op.edge];
      const have = new Set(_continentEdgeList().map(e => e.id));
      await _continentCommit(_continentEdgeList().concat(restore.filter(e => !have.has(e.id))));
    }
    _continentToast('已撤销上一条边操作');
  } catch (err) {
    _continentToast('撤销失败：' + (err && err.message || err));
  }
}

async function _continentCleanDangling() {
  const dangling = ((_continentData && _continentData.danglingEdges) || []);
  if (!dangling.length) return;
  if (typeof window.confirm === 'function' &&
      !window.confirm('大陆上有 ' + dangling.length + ' 条航线的一端已不在（画布被清空或概念被删除），确定移除这些断桥吗？')) return;
  try {
    await _continentRemoveUserEdges(dangling.map(e => e.id));
    _continentToast('已清理 ' + dangling.length + ' 条断桥（Ctrl+Z 可撤销）');
  } catch (err) {
    _continentToast('清理失败：' + (err && err.message || err));
  }
}

function _continentUpdateTools() {
  const undoBtn = document.getElementById('continentUndoBtn');
  if (undoBtn) undoBtn.hidden = _continentEdgeUndo.length === 0;
  const cleanBtn = document.getElementById('continentCleanBtn');
  if (cleanBtn) {
    const n = ((_continentData && _continentData.danglingEdges) || []).length;
    cleanBtn.hidden = n === 0;
    cleanBtn.textContent = n ? '清理断桥 ' + n : '清理断桥';
  }
  // v4 折叠清单入口：有折叠才有按钮（没有就不占位）
  const weakBtn = document.getElementById('continentWeakBtn');
  if (weakBtn) {
    const n = (_continentFolded || []).length;
    weakBtn.hidden = n === 0;
    weakBtn.textContent = '折叠 ' + n + ' 条';
  }
  // v7.1b Φ 归类入口：有「归属缺失」的卡才出现（有可靠归属的不烧调用）
  const gateBtn = document.getElementById('continentGateBtn');
  if (gateBtn && !gateBtn.disabled) {
    const unclassified = (( _continentData && _continentData.clusters) || [])
      .filter(c => !c.domain)
      .reduce((acc, c) => acc + (c.itemCount || 0), 0);
    gateBtn.hidden = unclassified === 0;
    gateBtn.textContent = 'Φ 归类 ' + unclassified + ' 个聚落';
  }
  // v7.2 航线入口：有航线才有全局显示开关
  const routeBtn = document.getElementById('continentRouteBtn');
  if (routeBtn) {
    const n = (((_continentData && _continentData.userEdges) || []).length)
      + (((_continentData && _continentData.danglingEdges) || []).length);
    routeBtn.hidden = n === 0;
  }
}

// ---------- 连接模式（v2 画边入口） ----------
function _continentSetLinkMode(on) {
  _continentLinkMode = !!on;
  _continentLinkSource = null;
  _continentIslandLinkSource = null;
  _continentMarkIslandLinkSource(null);
  const layer = document.getElementById('continentLayer');
  if (layer && layer.classList) layer.classList.toggle('is-linking', _continentLinkMode);
  const btn = document.getElementById('continentLinkBtn');
  if (btn && btn.classList) btn.classList.toggle('active', _continentLinkMode);
  const hint = document.getElementById('continentHint');
  if (hint) {
    hint.hidden = !_continentLinkMode;
    hint.textContent = '连接模式：点两个聚落，或点两座岛的岛牌连成岛级航线（Esc 退出）';
  }
  // v5.4 空态引导与连接模式提示互斥（同一条顶栏位置）
  const guide = document.getElementById('continentGuide');
  if (guide) guide.hidden = _continentLinkMode || !_continentGuideText;
  _continentMarkLinkSource(null);
  _continentClosePopover();
}

function _continentMarkLinkSource(itemId) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  world.querySelectorAll('.continent-node.is-link-source').forEach(el => el.classList.remove('is-link-source'));
  if (itemId) {
    const el = _continentNodeEl(itemId);
    if (el && el.classList) el.classList.add('is-link-source');
  }
}

async function _continentLinkPick(itemId, sessionId) {
  if (!_continentLinkSource) {
    _continentLinkSource = { itemId: itemId, sessionId: sessionId };
    _continentMarkLinkSource(itemId);
    const hint = document.getElementById('continentHint');
    if (hint) hint.textContent = '再点另一座岛的聚落完成航线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentLinkSource.itemId === itemId) {
    _continentMarkLinkSource(null);          // 再点自己 = 取消首选
    _continentLinkSource = null;
    return;
  }
  if (_continentLinkSource.sessionId === sessionId) {
    _continentToast('航线要连接两座不同岛上的聚落');
    return;
  }
  // v7.2：落笔不再弹 window.prompt 拦路（方向候选 U1）——备注与样式连线后点线可调
  try {
    const ok = await _continentAddUserEdge(_continentLinkSource.itemId, itemId, '');
    if (ok) {
      _continentSetLinkMode(false);
      _continentToast('已连成航线（点线可加备注、调样式，Ctrl+Z 可撤销）');
    }
  } catch (err) {
    _continentToast('航线保存失败：' + (err && err.message || err));
  }
}

// v7.2 岛级落笔：连接模式点两座**岛牌**也能落笔——两端取各岛最早学的卡当锚点
// （与代表卡同口径），渲染仍是岛框到岛框的航线
let _continentIslandLinkSource = null;

function _continentMarkIslandLinkSource(sid) {
  const world = document.getElementById('continentWorld');
  if (!world || !world.querySelectorAll) return;
  world.querySelectorAll('.continent-cluster.is-link-source').forEach(el =>
    el.classList.remove('is-link-source'));
  if (sid) {
    const el = world.querySelector('.continent-cluster[data-session-id="' +
      String(sid).replace(/"/g, '\\"') + '"]');
    if (el && el.classList) el.classList.add('is-link-source');
  }
}

async function _continentLinkPickIsland(sessionId) {
  if (!_continentIslandLinkSource) {
    _continentIslandLinkSource = sessionId;
    _continentMarkIslandLinkSource(sessionId);
    const hint = document.getElementById('continentHint');
    if (hint) hint.textContent = '再点另一座岛的岛牌完成岛级航线（再点自己取消，Esc 退出）';
    return;
  }
  if (_continentIslandLinkSource === sessionId) {
    _continentMarkIslandLinkSource(null);
    _continentIslandLinkSource = null;
    return;
  }
  const clusters = (_continentData && _continentData.clusters) || [];
  const from = clusters.find(c => c.sessionId === _continentIslandLinkSource);
  const to = clusters.find(c => c.sessionId === sessionId);
  const fromItem = from && from.items && from.items[0] && from.items[0].itemId;
  const toItem = to && to.items && to.items[0] && to.items[0].itemId;
  if (!fromItem || !toItem) { _continentToast('两座岛都要有聚落才能连航线'); return; }
  try {
    const ok = await _continentAddUserEdge(fromItem, toItem, '');
    if (ok) {
      _continentIslandLinkSource = null;
      _continentMarkIslandLinkSource(null);
      _continentSetLinkMode(false);
      _continentToast('已连成岛级航线（点线可加备注、调样式，Ctrl+Z 可撤销）');
    }
  } catch (err) {
    _continentToast('航线保存失败：' + (err && err.message || err));
  }
}

// ---------- 视口：平移缩放（缩放锚点保持光标下的世界点不动） ----------
// v5.6 备注标签「固定字号」：标签在世界层里，会随地图缩放一起放大缩小（2.5 倍时 10px
